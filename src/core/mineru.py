from __future__ import annotations

import base64
import json
import logging
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from .models import ExtractedSource

LOGGER = logging.getLogger(__name__)

# MinerU 抽取出的单张图片/表格位图体积上限（base64 前），超过则跳过
MAX_FIGURE_BYTES = 8 * 1024 * 1024
# 单篇文献最多保留的图表数量
MAX_FIGURES = 120

# 行内公式：$...$ 或 \(...\)（不跨行，避免吞掉货币符号或整段）
_INLINE_MATH_RE = re.compile(r"\$(?!\$)(?P<d>[^$\n]+?)\$|\\\((?P<p>[^)\n]+?)\\\)")
# Markdown 图片语法：![caption](path)
_MARKDOWN_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)\)")
# 展示公式：$$...$$ 及 \[...\]
_DISPLAY_MATH_RE = re.compile(r"\$\$(?P<d>.+?)\$\$|\\\[(?P<b>.+?)\\\]", re.DOTALL)

_ALLOWED_IMAGE_EXTS = {"png", "jpg", "jpeg", "gif", "webp", "bmp"}

# 公式编号：MinerU 用 \tag{N}（KaTeX 不支持 \tag，必须剥离），
# 或 array 环境末尾的 \qquad ( N )；空 \tag{} 直接删除。
_TAG_RE = re.compile(r"\\tag\s*\*?\s*\{([^{}]*)\}")
_ARRAY_TRAILING_NUM_RE = re.compile(
    r"\\qquad\s*\(\s*(\d{1,3})\s*\)(?=(?:\s*\})*\s*\\end\{array\})"
)


def _split_formula_number(latex: str) -> tuple[str, str]:
    """把公式编号从 LaTeX 主体拆出来，返回 (清理后的 latex, 编号)。

    编号交给前端按版式右对齐渲染，避免 KaTeX 遇到 \\tag 整条公式报错。
    """
    number = ""

    def _tag_repl(match: re.Match[str]) -> str:
        nonlocal number
        if not number:
            number = re.sub(r"[^\dA-Za-z,，.\-]", "", match.group(1) or "")
        return ""

    latex = _TAG_RE.sub(_tag_repl, latex)
    if not number:
        m = _ARRAY_TRAILING_NUM_RE.search(latex)
        if m:
            number = m.group(1)
            latex = latex[: m.start()] + latex[m.end():]
    return latex.strip(), number


def _register_formula(
    formulas: list[dict[str, Any]], latex: str, source: str = "mineru"
) -> str | None:
    """统一登记一条公式：清理、拆编号、分配 id；latex 为空时返回 None。"""
    latex, number = _split_formula_number(_clean_latex(latex))
    if not latex:
        return None
    fid = f"f{len(formulas)}"
    record: dict[str, Any] = {
        "id": fid,
        "raw": latex,
        "text": latex,
        "formula": latex,
        "source": source,
    }
    if number:
        record["number"] = number
    formulas.append(record)
    return fid


def mineru_available(cli: str) -> bool:
    """检测 MinerU 命令行是否可用（命令名或绝对路径）。"""
    cli = (cli or "").strip()
    if not cli:
        return False
    if Path(cli).is_absolute():
        return Path(cli).is_file()
    return shutil.which(cli) is not None


def extract_pdf_with_mineru(
    filename: str,
    content: bytes,
    *,
    cli: str = "mineru",
    backend: str = "pipeline",
    method: str = "auto",
    lang: str = "ch",
    timeout_seconds: float = 600.0,
) -> ExtractedSource | None:
    """用 MinerU 解析 PDF，返回整理好的 ExtractedSource；失败/未安装时返回 None。

    调用方收到 None 后应回退到本地 PyMuPDF 抽取，保证解析永不中断。
    """

    if not mineru_available(cli):
        LOGGER.warning("MinerU CLI '%s' not found; falling back to local parser.", cli)
        return None

    mime_type = "application/pdf"
    with tempfile.TemporaryDirectory(prefix="mineru-in-") as in_dir, tempfile.TemporaryDirectory(
        prefix="mineru-out-"
    ) as out_dir:
        pdf_path = Path(in_dir) / "document.pdf"
        pdf_path.write_bytes(content)

        command = [cli, "-p", str(pdf_path), "-o", str(out_dir), "-b", backend]
        if method:
            command += ["-m", method]
        if lang:
            command += ["-l", lang]

        try:
            proc = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
            )
        except subprocess.TimeoutExpired:
            LOGGER.warning(
                "MinerU timed out after %.1fs; falling back to local parser.",
                timeout_seconds,
            )
            return None
        except OSError as exc:
            LOGGER.warning("MinerU failed to start (%s); falling back to local parser.", exc)
            return None
        if proc.returncode != 0:
            stderr_tail = "\n".join((proc.stderr or "").splitlines()[-25:])
            LOGGER.warning(
                "MinerU exited with code %s; falling back to local parser.\n%s",
                proc.returncode,
                stderr_tail,
            )
            return None

        result_dir = _locate_result_dir(Path(out_dir))
        if result_dir is None:
            LOGGER.warning("MinerU produced no recognizable output; falling back to local parser.")
            return None
        return _build_from_result_dir(result_dir, filename, mime_type, len(content))


def _locate_result_dir(root: Path) -> Path | None:
    """在 MinerU 输出目录里定位包含主结果（md / content_list.json）的目录。

    不同版本把结果放在 <out>/<pdf_name>/ 或 <out>/<pdf_name>/<method>/ 下，
    这里递归查找，对版本差异不敏感。
    """

    for meta in root.rglob("*_content_list.json"):
        if meta.is_file():
            return meta.parent
    for meta in root.rglob("*_content_list_v2.json"):
        if meta.is_file():
            return meta.parent
    for meta in root.rglob("content_list.json"):
        if meta.is_file():
            return meta.parent
    for md in root.rglob("*.md"):
        if md.is_file():
            return md.parent
    return None


def _build_from_result_dir(
    result_dir: Path, filename: str, mime_type: str, size_bytes: int
) -> ExtractedSource | None:
    content_list = next(
        (
            p
            for pattern in ("*_content_list.json", "content_list.json")
            for p in result_dir.glob(pattern)
            if p.is_file()
        ),
        None,
    )
    if content_list is not None:
        try:
            blocks = json.loads(content_list.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            blocks = None
        if isinstance(blocks, list):
            return _from_content_list(blocks, result_dir, filename, mime_type, size_bytes)

    content_list_v2 = next(
        (
            p
            for pattern in ("*_content_list_v2.json", "content_list_v2.json")
            for p in result_dir.glob(pattern)
            if p.is_file()
        ),
        None,
    )
    if content_list_v2 is not None:
        try:
            pages = json.loads(content_list_v2.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pages = None
        if isinstance(pages, list):
            return _from_v2_content_list(pages, result_dir, filename, mime_type, size_bytes)

    markdown = next((p for p in result_dir.glob("*.md") if p.is_file()), None)
    if markdown is None:
        return None
    try:
        return _from_markdown(
            markdown.read_text(encoding="utf-8"), result_dir, filename, mime_type, size_bytes
        )
    except OSError:
        return None


def _image_path(block: dict[str, Any]) -> Any:
    """v1 用 img_path，v2 用 content.image_source.path。"""
    path = block.get("img_path")
    if path:
        return path
    source = block.get("image_source")
    if isinstance(source, dict):
        return source.get("path")
    return None


def _join_text_tokens(tokens: Any) -> str:
    """把 v2 的混合 token 序列拼回文本，行内公式用 $...$ 包裹供后续替换。"""
    parts: list[str] = []
    for tok in tokens or []:
        if not isinstance(tok, dict):
            continue
        kind = tok.get("type")
        content = tok.get("content")
        if kind == "equation_inline" and isinstance(content, str):
            parts.append("$" + content + "$")
        elif isinstance(content, str):
            parts.append(content)
    return "".join(parts)


def _list_items_text(value: Any) -> str:
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                parts.append(_join_text_tokens(item.get("item_content")))
        return "\n".join(p.strip() for p in parts if p.strip())
    return str(value or "").strip()


_CAPTION_KEYS = ("image_caption", "table_caption", "chart_caption")


def _figure_caption(block: dict[str, Any]) -> str:
    for key in _CAPTION_KEYS:
        caption = _join_captions(block.get(key))
        if caption:
            return caption
    return ""


def _from_content_list(
    blocks: list[Any], base_dir: Path, filename: str, mime_type: str, size_bytes: int
) -> ExtractedSource:
    """把 content_list.json（扁平阅读顺序块）转成 ExtractedSource。"""
    return _from_blocks(blocks, base_dir, filename, mime_type, size_bytes)


def _from_blocks(
    blocks: list[Any], base_dir: Path, filename: str, mime_type: str, size_bytes: int
) -> ExtractedSource:
    """把"归一化后的块序列"转成 ExtractedSource。

    text/title           → 正文/标题（text_level → [[H:n]] 标题标记）
    equation             → 展示公式 [[MATH:id]]
    image / table / chart→ 图表 [[FIG:id]]（图片转 data URI，标题随 figcaption 渲染）
    list                 → 参考文献等列表，逐条成段
    """

    formulas: list[dict[str, Any]] = []
    figures: list[dict[str, Any]] = []
    parts: list[str] = []

    for block in blocks:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if block_type == "equation":
            fid = _register_formula(
                formulas, str(block.get("text") or block.get("math_content") or "")
            )
            if fid:
                parts.append(f"[[MATH:{fid}]]")
        elif block_type in ("image", "table", "chart"):
            caption = _figure_caption(block)
            figure = _make_figure(base_dir, _image_path(block), caption, len(figures))
            if figure is not None:
                figures.append(figure)
                parts.append(f"[[FIG:{figure['id']}]]")
        elif block_type == "list":
            text = _list_items_text(block.get("list_items"))
            for line in text.splitlines():
                line = line.strip()
                if line:
                    parts.append(_inline_math_to_markers(line, formulas))
        elif block_type in ("text", "title", "ref_text", "aside_text"):
            text = str(block.get("text") or "").strip()
            if text:
                part = _inline_math_to_markers(text, formulas)
                level = block.get("text_level")
                if isinstance(level, int) and 1 <= level <= 6:
                    part = f"[[H:{level}]] {part}"
                parts.append(part)

    text = _join_parts(parts)
    return _pack(filename, mime_type, size_bytes, text, formulas, figures)


def _normalize_v2_block(block: dict[str, Any]) -> dict[str, Any] | None:
    """把 v2（分页 + 嵌套 content）块归一化成 v1 的扁平块形态；页眉页脚等返回 None。"""
    block_type = block.get("type")
    content = block.get("content")
    content = content if isinstance(content, dict) else {}

    if block_type == "title":
        return {
            "type": "text",
            "text": _join_text_tokens(content.get("title_content")),
            "text_level": content.get("level") or 1,
        }
    if block_type == "paragraph":
        return {"type": "text", "text": _join_text_tokens(content.get("paragraph_content"))}
    if block_type == "equation_interline":
        math = content.get("math_content")
        return {"type": "equation", "text": math} if math else None
    if block_type in ("image", "chart", "table"):
        return {
            "type": block_type,
            "img_path": _image_path({"image_source": content.get("image_source")}),
            f"{block_type}_caption": content.get(f"{block_type}_caption"),
        }
    if block_type == "list":
        return {"type": "list", "list_items": content.get("list_items")}
    return None


def _from_v2_content_list(
    pages: list[Any], base_dir: Path, filename: str, mime_type: str, size_bytes: int
) -> ExtractedSource:
    """解析 MinerU 的 content_list_v2.json（分页块列表）。"""
    blocks: list[dict[str, Any]] = []
    for page in pages or []:
        if not isinstance(page, list):
            continue
        for block in page:
            if not isinstance(block, dict):
                continue
            normalized = _normalize_v2_block(block)
            if normalized is not None:
                blocks.append(normalized)
    return _from_blocks(blocks, base_dir, filename, mime_type, size_bytes)


def _from_markdown(
    markdown: str, base_dir: Path, filename: str, mime_type: str, size_bytes: int
) -> ExtractedSource:
    """MinerU markdown 兜底解析（仅在没有 content_list.json 时使用）。"""

    formulas: list[dict[str, Any]] = []
    figures: list[dict[str, Any]] = []
    text = markdown

    def _figure_repl(match: re.Match[str]) -> str:
        caption = match.group(1).strip()
        rel_path = match.group(2)
        figure = _make_figure(base_dir, rel_path, caption, len(figures))
        if figure is None:
            return match.group(0)
        figures.append(figure)
        return f"\n\n[[FIG:{figure['id']}]]\n\n"

    text = _MARKDOWN_IMAGE_RE.sub(_figure_repl, text)

    def _display_repl(match: re.Match[str]) -> str:
        fid = _register_formula(formulas, match.group("d") or match.group("b") or "")
        if not fid:
            return ""
        return f"\n\n[[MATH:{fid}]]\n\n"

    text = _DISPLAY_MATH_RE.sub(_display_repl, text)

    def _inline_repl(match: re.Match[str]) -> str:
        fid = _register_formula(formulas, match.group("d") or match.group("p") or "")
        return f"[[MATH:{fid}]]" if fid else match.group(0)

    text = _INLINE_MATH_RE.sub(_inline_repl, text)
    text = _tidy_markdown(text)

    return _pack(filename, mime_type, size_bytes, text, formulas, figures)


def _tidy_markdown(text: str) -> str:
    """轻量清理，去掉 markdown 标题/列表语法，让阅读器按自然段落显示。
    标题标记（###）转换为 [[H:n]] 格式以保留层级信息。"""
    lines: list[str] = []
    for raw in text.split("\n"):
        line = raw.rstrip()
        # 将 Markdown 标题转为 [[H:n]] 标记，保留层级信息
        m = re.match(r"^\s{0,3}(#{1,6})\s+(.+)", line)
        if m:
            level = len(m.group(1))
            lines.append(f"[[H:{level}]] {m.group(2)}")
            continue
        line = re.sub(r"^\s{0,3}>+\s*", "", line)
        line = re.sub(r"^\s{0,3}([-*+])\s+", "", line)
        lines.append(line)
    text = "\n".join(lines)
    # 移除残留的分隔线与多余空行
    text = re.sub(r"\n\s*[-*_]{3,}\s*\n", "\n\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _inline_math_to_markers(text: str, formulas: list[dict[str, Any]]) -> str:
    out: list[str] = []
    last = 0
    for match in _INLINE_MATH_RE.finditer(text):
        latex = (match.group("d") or match.group("p") or "").strip()
        if not latex:
            continue
        fid = _register_formula(formulas, latex)
        if not fid:
            continue
        out.append(text[last : match.start()])
        out.append(f"[[MATH:{fid}]]")
        last = match.end()
    out.append(text[last:])
    return "".join(out)


def _make_figure(
    base_dir: Path, img_path: Any, caption: str, index: int
) -> dict[str, Any] | None:
    data_uri = _image_data_uri(base_dir, img_path)
    if data_uri is None and not caption:
        return None
    return {
        "id": f"fig{index}",
        "caption": caption,
        "image": data_uri or "",
        "source": "mineru",
    }


def _image_data_uri(base_dir: Path, img_path: Any) -> str | None:
    if not img_path:
        return None
    path = Path(str(img_path))
    if not path.is_absolute():
        path = base_dir / path
    if not path.is_file():
        alt = base_dir / "images" / path.name
        if alt.is_file():
            path = alt
        else:
            return None
    try:
        data = path.read_bytes()
    except OSError:
        return None
    if not data or len(data) > MAX_FIGURE_BYTES:
        return None
    ext = path.suffix.lower().lstrip(".") or "png"
    if ext == "jpeg":
        ext = "jpg"
    if ext not in _ALLOWED_IMAGE_EXTS:
        ext = "png"
    return "data:image/" + ext + ";base64," + base64.b64encode(data).decode("ascii")


def _clean_latex(value: str) -> str:
    latex = value.strip()
    latex = re.sub(r"^\$\$\s*", "", latex)
    latex = re.sub(r"\s*\$\$$", "", latex)
    latex = re.sub(r"^\\\[\s*", "", latex)
    latex = re.sub(r"\s*\\\]$", "", latex)
    latex = re.sub(r"^\\\(\s*", "", latex)
    latex = re.sub(r"\s*\\\)$", "", latex)
    # 展示公式里的硬换行/多余空白压成单空格，避免 KaTeX 渲染出乱换行
    latex = re.sub(r"\s+", " ", latex)
    return latex.strip()


def _join_captions(value: Any) -> str:
    texts: list[str] = []
    items = value if isinstance(value, list) else [value]
    for item in items:
        if isinstance(item, dict):
            content = item.get("content")
            if isinstance(content, str):
                texts.append(content)
        elif item:
            texts.append(str(item))
    return " ".join(t.strip() for t in texts if t.strip()).strip()


def _join_parts(parts: list[str]) -> str:
    return "\n\n".join(str(part).strip() for part in parts if str(part).strip()).strip()


def _pack(
    filename: str,
    mime_type: str,
    size_bytes: int,
    text: str,
    formulas: list[dict[str, Any]],
    figures: list[dict[str, Any]],
) -> ExtractedSource:
    figures = figures[:MAX_FIGURES]
    has_content = bool(text.strip() or formulas or figures)
    return ExtractedSource(
        filename=filename,
        mime_type=mime_type,
        size_bytes=size_bytes,
        text=text,
        formulas=formulas,
        figures=figures,
        status="ok" if has_content else "empty",
        error_message=None if has_content else "MinerU 未提取到文本、公式或图片。",
    )