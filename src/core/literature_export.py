# -*- coding: utf-8 -*-
"""文献精读成果导出：把库里**已经存在**的东西渲染成能带走的 Markdown。

为什么单独一个模块
------------------
导出只做「加一个入口 + 一个弹窗 + 两个新端点」。渲染逻辑全在这里，
入参是已经取好的 domain 数据（不 import api_server、不碰 db 连接），
出参是 {文件名: 文本} 与 {资源名: 二进制} —— 于是可以脱离服务单测。

这里**不调用模型**：阅读重点、建议问题、AI 解释都是之前已经生成过、存在库里的。
导出是纯渲染，零 token 成本。

三个必须处理的渲染陷阱
----------------------
1. **图表在库里是 base64 data URI 内嵌的**（见 mineru._make_figure / parsers 的图片锚点）。
   直接写进 Markdown 会塞进几 MB 的 base64，编辑器直接卡死。这里一律解码落到
   assets/ 下，正文只留 ``![](assets/xxx.png)``；解码失败就只留图注并如实标注，
   绝不把半截 base64 写进成品。
2. **``[[FIG:id]]`` / ``[[MATH:id]]`` / ``[[H:n]]`` 是阅读器的排版锚点，不是给人看的内容。**
   漏到成品文件里就是一串方括号乱码 —— 导出后必须一个不剩。
3. **AI 生成的部分与用户自己写的必须分节。** 阅读重点、建议问题、AI 解释、文献对比是
   模型产出；划词笔记、阅读笔记、高亮是用户产出。混在一段里，读者分不清哪些该复核。

产品口径沿用 README：产物是标准 Markdown，不锁进任何私有格式；
解压后可以直接拖进 Obsidian / 用任何编辑器打开。
"""

from __future__ import annotations

import base64
import binascii
import io
import re
import zipfile
from datetime import datetime
from typing import Any

try:  # 作为包被导入（api_server 走的是 core.* 命名空间）
    from .vault_export import safe_name
except ImportError:  # 直接以脚本方式运行（单测 / 冒烟）
    from vault_export import safe_name

# 阅读器的排版锚点：[[FIG:id]] / [[MATH:id]] / [[H:n]]
_ANCHOR_RE = re.compile(r"\[\[(FIG|MATH|H):([^\]]*)\]\]")
_DATA_URI_RE = re.compile(r"^data:(?P<mime>[-\w.+/]+);base64,(?P<payload>.*)$", re.S)
# 图片类资源在 assets/ 下的前缀，避免与后续可能新增的其它资源撞名
_IMAGE_EXTS = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/tiff": "tif",
}


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------
def _text(value: Any) -> str:
    """把任意值安全地转成去空白的字符串。"""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    return str(value).strip()


def _first_text(item: dict[str, Any], keys: tuple[str, ...]) -> str:
    """按顺序取第一个非空字符串字段 —— 库里同一含义的字段名不统一，不要挑食。"""
    for key in keys:
        value = _text(item.get(key))
        if value:
            return value
    return ""


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _decode_data_uri(uri: str) -> tuple[bytes, str] | None:
    """解出 (二进制, 扩展名)；不是合法 data URI 或解不开时返回 None。"""
    match = _DATA_URI_RE.match(_text(uri))
    if not match:
        return None
    payload = re.sub(r"\s+", "", match.group("payload"))
    if not payload:
        return None
    try:
        data = base64.b64decode(payload, validate=False)
    except (binascii.Error, ValueError):
        return None
    if not data:
        return None
    mime = match.group("mime").lower()
    return data, _IMAGE_EXTS.get(mime, "png")


def _fence(text: str) -> str:
    """把可能含反引号的文本放进安全围栏，避免围栏被正文自己截断。"""
    longest = 0
    for run in re.findall(r"`+", text):
        longest = max(longest, len(run))
    bar = "`" * max(3, longest + 1)
    return f"{bar}\n{text}\n{bar}"


def _meta_line(meta: dict[str, Any], key: str) -> str:
    value = meta.get(key)
    if isinstance(value, list):
        return "、".join(_text(v) for v in value if _text(v))
    return _text(value)


# ---------------------------------------------------------------------------
# 正文渲染：把排版锚点换成 Markdown
# ---------------------------------------------------------------------------
class _AssetSink:
    """收集本次导出要用到的二进制资源，同时统计解不出来的那些。"""

    def __init__(self) -> None:
        self.assets: dict[str, bytes] = {}
        self._used: set[str] = set()
        self.missing_figures = 0
        self.image_formulas = 0

    def add(self, name: str, data: bytes) -> str:
        """登记一份资源并返回它在包内的相对路径（同名自动去重）。"""
        path = name
        suffix = 1
        while path in self._used:
            stem, _, ext = name.rpartition(".")
            path = f"{stem}_{suffix}.{ext}" if stem else f"{name}_{suffix}"
            suffix += 1
        self._used.add(path)
        self.assets[path] = data
        return path


def _render_figure(
    ident: str,
    figure: dict[str, Any],
    sink: _AssetSink,
    with_figures: bool,
) -> str:
    """把一张图渲染成「图片 + 图注」。

    三种情形要分开，别一律当成「缺失」：
      · 有图数据且能解开 → 图片落 assets/，正文引用它
      · 有图数据但解不开 → 只留图注 + 明确说明（并计入 missing_figures）
      · 本来就没有图数据 → 只留图注，不加告警（很多表题/图题天然没有位图）
    """
    if not with_figures:
        return ""
    caption = _first_text(figure, ("caption", "title", "text"))
    raw_image = _text(figure.get("image"))
    decoded = _decode_data_uri(raw_image) if raw_image else None

    if decoded is not None:
        data, ext = decoded
        path = sink.add(f"{ident}.{ext}", data)
        block = f"\n\n![](assets/{path})\n"
        if caption:
            block += f"\n*{caption}*\n"
        return block + "\n"

    if raw_image:
        # 有数据却解不开 = 真异常，必须说出来；并且绝不把半截 base64 写进成品。
        sink.missing_figures += 1
        block = "\n\n> 该图未随导出提供（原图数据无法解析），以下为图注。\n\n"
        if caption:
            block += f"**图注：** {caption}\n\n"
        return block

    if caption:
        return f"\n\n**图注：** {caption}\n\n"
    return ""


def _render_article_text(
    text: str,
    figures: dict[str, dict[str, Any]],
    formulas: dict[str, dict[str, Any]],
    sink: _AssetSink,
    source_index: int,
    with_figures: bool,
) -> tuple[str, set[str]]:
    """把一段带锚点的正文渲染成 Markdown。

    锚点处理规则：
      ``[[H:n]]``    → ``#`` * (n+1)，整体降一级（文档自己的标题已经是 H1）
      ``[[FIG:id]]`` → 独立成段：图片 + 图注
      ``[[MATH:id]]``→ 公式 LaTeX 包成 ``$...$``，带印刷编号的补在右侧

    Returns:
        (渲染后的 Markdown, 正文里真正引用到的图 id 集合)
    """
    out: list[str] = []
    referenced: set[str] = set()

    def replace(match: re.Match[str]) -> str:
        kind, ident = match.group(1), _text(match.group(2))

        if kind == "H":
            try:
                # 标记形如 [[H:3@7]]（@ 后是解析器带出的真实页码），也兼容旧的
                # [[H:3]]；层级取 @ 之前那段。直接 int(ident) 遇到 @ 会抛
                # ValueError，整条标题会被静默丢掉。
                level = int(str(ident).split("@", 1)[0])
            except (TypeError, ValueError):
                return ""
            level = min(max(level, 1), 5) + 1  # 降一级，把 H1 留给文档标题
            return "\n\n" + "#" * level + " "

        if kind == "MATH":
            formula = formulas.get(ident) or {}
            latex = _first_text(formula, ("raw", "text", "formula", "latex"))
            if latex:
                latex = latex.replace("\r\n", "\n").replace("\n", " ")
                number = _text(formula.get("number"))
                tail = f" \\qquad ({number})" if number else ""
                return f"${latex}{tail}$"
            # 部分公式是「整块区域渲染成图片」的（见 parsers 的 pymupdf-region-image），
            # 没有 LaTeX 只有图片 —— 那就退化成图片，别丢内容。
            image = _decode_data_uri(_text(formula.get("image")))
            if image and with_figures:
                data, ext = image
                path = sink.add(f"math_{source_index}_{ident}.{ext}", data)
                sink.image_formulas += 1
                return f"\n\n![](assets/{path})\n\n> 该公式在原文中以图形排版，已按图片保留。\n\n"
            return ""

        # kind == "FIG"
        referenced.add(ident)
        return _render_figure(ident, figures.get(ident) or {}, sink, with_figures)

    out.append(_ANCHOR_RE.sub(replace, str(text or "")))

    # 锚点被替换后可能留下多余空行；整段收敛成最多一个空行，读起来才像文档。
    rendered = "".join(out).replace("\r\n", "\n")
    rendered = re.sub(r"\n{3,}", "\n\n", rendered)
    return rendered.strip(), referenced


def _render_leftover_figures(
    figures: dict[str, dict[str, Any]],
    referenced: set[str],
    sink: _AssetSink,
    with_figures: bool,
) -> str:
    """把**正文没有 [[FIG:id]] 引用**的图补在末尾。

    这一步不是多余的：版面解析出的图注与正文锚点并不总能一一对齐（跨页图、
    纯表题、解析漏标），只按锚点渲染会让这些图**静默消失**。前端的阅读器同样
    有这条兜底（见 literature.js「未被正文引用的图片按 caption 定位插入或文末
    兜底展示」）；导出必须一致，否则用户会以为图丢了。
    """
    if not with_figures:
        return ""
    blocks = [
        _render_figure(fid, figures[fid], sink, with_figures)
        for fid in figures
        if fid not in referenced
    ]
    blocks = [block for block in blocks if block.strip()]
    if not blocks:
        return ""
    return (
        "\n\n## 未在正文中标注位置的图\n\n"
        "> 以下图表在正文里没有对应的排版锚点，统一附在末尾，避免遗漏。\n"
        + "".join(blocks)
    )


# ---------------------------------------------------------------------------
# 各章节
# ---------------------------------------------------------------------------
def _render_overview(
    title: str,
    meta: dict[str, Any],
    keypoints: list[dict[str, Any]],
    added_points: list[dict[str, Any]],
    questions: list[str],
    stats: dict[str, Any],
    source_names: list[str],
) -> str:
    """00-精读总览：元数据 + AI 阅读重点 + AI 建议问题。"""
    lines: list[str] = [f"# {title}", ""]

    info: list[tuple[str, str]] = [
        ("作者", _meta_line(meta, "authors")),
        ("期刊 / 会议", _meta_line(meta, "venue")),
        ("年份", _meta_line(meta, "year")),
        ("DOI", _meta_line(meta, "doi")),
        ("arXiv", _meta_line(meta, "arxiv_id")),
        ("关键词", _meta_line(meta, "keywords")),
        ("参考文献数", _meta_line(meta, "references_count")),
    ]
    if info:
        lines.append("| 项 | 内容 |")
        lines.append("| --- | --- |")
        for label, value in info:
            lines.append(f"| {label} | {value or '—'} |")
        lines.append("")

    abstract = _meta_line(meta, "abstract")
    if abstract:
        lines.extend(["## 摘要", "", abstract, ""])
    translated = _meta_line(meta, "abstract_translated")
    if translated:
        lines.extend(["## 摘要（译文）", "", translated, ""])

    if keypoints or added_points:
        lines.extend(
            [
                "## 阅读重点",
                "",
                "> 以下内容由 AI 生成，供快速定位阅读重点，**请对照原文复核**。",
                "",
            ]
        )
        order = 1
        for point in keypoints:
            if not isinstance(point, dict):
                continue
            heading = _first_text(point, ("heading", "title", "name"))
            summary = _first_text(point, ("summary", "text", "desc"))
            quote = _first_text(point, ("quote", "evidence"))
            lines.append(f"### {order}. {heading or '（无标题）'}")
            if summary:
                lines.append("")
                lines.append(summary)
            if quote:
                lines.append("")
                lines.append(f"> 原文位置：{quote}")
            lines.append("")
            order += 1
        for point in added_points:
            if not isinstance(point, dict):
                continue
            heading = _first_text(point, ("heading", "title"))
            summary = _first_text(point, ("summary", "text"))
            quote = _first_text(point, ("quote",))
            lines.append(f"### {order}. {heading or '（手动补充）'}（手动补充）")
            if summary:
                lines.append("")
                lines.append(summary)
            if quote:
                lines.append("")
                lines.append(f"> 原文位置：{quote}")
            lines.append("")
            order += 1

    if questions:
        lines.extend(
            [
                "## 建议问题",
                "",
                "> 以下问题由 AI 生成，可用于自测或与同学讨论。",
                "",
            ]
        )
        for index, question in enumerate(questions, 1):
            text = _text(question)
            if text:
                lines.append(f"{index}. {text}")
        lines.append("")

    lines.extend(
        [
            "## 导出说明",
            "",
            f"- 导出时间：{datetime.now().strftime('%Y-%m-%d %H:%M')}",
            f"- 来源文件：{'、'.join(source_names) if source_names else '—'}",
            f"- 图表 {stats.get('figures', 0)} 张、公式 {stats.get('formulas', 0)} 条、"
            f"对照段落 {stats.get('segments', 0)} 段",
            f"- 我的笔记 {stats.get('notes', 0)} 条、高亮 {stats.get('highlights', 0)} 条、"
            f"AI 解释 {stats.get('ai_answers', 0)} 条",
            "",
            "> 本文件由知源 KnowOrigin 导出。标注为「AI」的部分为模型生成，",
            "> 可能出错，请以原文为准；用户笔记与高亮为本人所写。",
            "",
        ]
    )
    return "\n".join(lines)


def _render_notes(marks: dict[str, list[Any]]) -> str:
    """02-我的笔记与高亮：**全部是用户产出**，不与 AI 内容混排。"""
    notes = [n for n in _as_list(marks.get("notes")) if isinstance(n, dict)]
    highlights = [h for h in _as_list(marks.get("highlight")) if isinstance(h, dict)]
    note_text = _text(marks.get("note"))

    lines: list[str] = ["# 我的笔记与高亮", ""]
    if not (notes or highlights or note_text):
        lines.extend(["（这篇文献还没有笔记或高亮。）", ""])
        return "\n".join(lines)

    lines.extend(["## 阅读笔记", "", note_text or "（空）", ""])

    lines.extend(["## 划词笔记", ""])
    if notes:
        for item in notes:
            text = _first_text(item, ("text", "quote", "para"))
            comment = _first_text(item, ("comment", "note"))
            lines.append(f"**原文**：{text or '—'}")
            lines.append("")
            lines.append(f"**我的批注**：{comment or '（未写批注）'}")
            lines.append("")
    else:
        lines.extend(["（无）", ""])

    lines.extend(["## 高亮", ""])
    if highlights:
        for item in highlights:
            text = _first_text(item, ("text", "quote"))
            page = item.get("page")
            where = f"（第 {page} 页）" if isinstance(page, int) else ""
            lines.append(f"- {text or '—'}{where}")
        lines.append("")
    else:
        lines.extend(["（无）", ""])
    return "\n".join(lines)


def _render_ai_answers(ai_answers: list[dict[str, Any]]) -> str:
    """03-AI 解释：划词解释 / 图表解释 / 公式解释 / 论文问答。"""
    lines: list[str] = [
        "# AI 解释",
        "",
        "> 以下回答由 AI 生成，**不是原文内容**，请对照原文复核。",
        "> 按原文位置排序，位置未知的排在最后。",
        "",
    ]
    if not ai_answers:
        lines.extend(["（这篇文献还没有 AI 解释记录。）", ""])
        return "\n".join(lines)

    kind_label = {"text": "划词解释", "fig": "图表解释", "formula": "公式解释", "qa": "论文问答"}

    for index, item in enumerate(ai_answers, 1):
        if not isinstance(item, dict):
            continue
        source_kind = _text(item.get("source_kind")) or "qa"
        label = kind_label.get(source_kind, "AI 解释")
        page = item.get("page")
        location = f"（第 {page} 页）" if isinstance(page, int) else ""
        lines.append(f"## {index}. {label}{location}")
        lines.append("")
        question = _first_text(item, ("question", "selected", "prompt"))
        if question:
            lines.append(f"**问**：{question}")
            lines.append("")
        answer = _first_text(item, ("answer", "text", "reply"))
        lines.append(_fence(answer) if "\n" in answer else (answer or "（空）"))
        lines.append("")
    return "\n".join(lines)


def _render_segments(segments: list[dict[str, Any]]) -> str:
    """01-全文对照：逐段中英对照（译文本就对不齐时保持原顺序，不强行配对）。"""
    lines: list[str] = [
        "# 全文对照",
        "",
        "> 译文由 AI 生成，供理解参考；有疑问以原文为准。",
        "",
    ]
    usable = [s for s in segments if isinstance(s, dict)]
    if not usable:
        lines.extend(["（这篇文献还没有生成全文对照。）", ""])
        return "\n".join(lines)

    for item in usable:
        source = _first_text(item, ("source_text", "text", "source"))
        translated = _first_text(item, ("translated_text", "translation", "target"))
        if source:
            lines.append(source)
            lines.append("")
        if translated:
            lines.append(f"> {translated}")
            lines.append("")
        lines.append("---")
        lines.append("")
    return "\n".join(lines)


def _render_comparison(comparison: str, title: str) -> str:
    lines: list[str] = [
        f"# 文献对比",
        "",
        "> 对照表由 AI 生成，请核对各列内容是否与原文一致。",
        "",
    ]
    body = _text(comparison)
    if not body:
        lines.extend(["（还没有生成文献对比结果。）", ""])
    else:
        lines.extend([body, ""])
    return "\n".join(lines)


def _render_deep_analysis(analysis: dict[str, Any]) -> str:
    """渲染 AI 深度解析章节（六维拆解 + 画像导读：相关度 / 与你的方向 / 阅读建议）。

    analysis 为 ``paper_search.generate_paper_deep_analysis`` 的返回，字段缺失时诚实跳过，
    不硬塞「（无）」占位。
    """
    match_labels = {
        "strong": "强相关",
        "medium": "中等相关",
        "weak": "弱相关",
        "none": "不相关",
        "unknown": "无法判断",
    }
    sections = (
        ("核心要点", "tldr"),
        ("研究动机", "motivation"),
        ("方法架构", "methodology"),
        ("定量指标", "metrics"),
        ("局限与挑刺", "limitations"),
        ("抗辩策略", "defense_strategy"),
    )

    lines: list[str] = ["# AI 深度解析", ""]
    level = _text(analysis.get("direction_match_level")) or "unknown"
    relation = _text(analysis.get("relation_to_user_direction"))
    recommendation = _text(analysis.get("reading_recommendation"))
    if relation or recommendation:
        lines.append("## 画像导读")
        lines.append("")
        lines.append(f"- **相关度**：{match_labels.get(level, level)}")
        if relation:
            lines.append(f"- **与你的方向**：{relation}")
        if recommendation:
            lines.append(f"- **阅读建议**：{recommendation}")
        lines.append("")

    for label, key in sections:
        text = _text(analysis.get(key))
        if not text:
            continue
        lines.append(f"## {label}")
        lines.append("")
        lines.append(text)
        lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------
def build_export(
    *,
    title: str = "",
    sources: list[Any] | None = None,
    marks: list[dict[str, Any]] | None = None,
    meta: dict[str, Any] | None = None,
    segments: list[dict[str, Any]] | None = None,
    comparison: str = "",
    deep_analysis: dict[str, Any] | None = None,
    options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """渲染一篇文献的精读成果。

    Args:
        title: 文档标题 / 顶层文件夹名（一般为论文标题，兜底用项目名）
        sources: 资料列表，每项需有 filename / text / figures / formulas 属性或键
        marks: db.list_literature_marks 的返回
        meta: db.get_literature_meta 的返回
        segments: 逐段对照（db.list_translation_segments 的返回）
        comparison: 文献对比 Markdown 正文
        options: include_fulltext / include_figures / include_notes /
                 include_ai / include_comparison / folder_name

    Returns:
        {"root", "files", "assets", "stats"}；files 与 assets 的键都是
        顶层文件夹**内部**的相对路径。
    """
    opt = {
        "include_fulltext": True,
        "include_figures": True,
        "include_notes": True,
        "include_ai": True,
        "include_comparison": True,
        "include_translation": True,
        "include_deep": True,
    }
    for key, value in (options or {}).items():
        if key in opt:
            opt[key] = bool(value)
    folder = _text((options or {}).get("folder_name"))

    meta = meta if isinstance(meta, dict) else {}
    doc_title = _text(title) or _text(meta.get("title")) or "文献精读"
    root = safe_name(folder or doc_title)

    sink = _AssetSink()
    files: dict[str, str] = {}
    stats: dict[str, Any] = {
        "sections": 0,
        "figures": 0,
        "formulas": 0,
        "segments": 0,
        "notes": 0,
        "highlights": 0,
        "ai_answers": 0,
        "chars": 0,
    }

    # ---- 标注拆分：AI 产出与用户产出分开 ----
    by_kind: dict[str, Any] = {}
    for mark in marks or []:
        if not isinstance(mark, dict):
            continue
        kind = _text(mark.get("kind"))
        if not kind:
            continue
        if kind == "ai_highlight":
            # AI 划词高亮只是「用户划在 AI 回答上的范围」{s,e,text}，没有独立正文，
            # 归到用户高亮里一起列即可。
            by_kind.setdefault("highlight", []).extend(_as_list(mark.get("payload")))
            continue
        if kind == "ai_answer":
            # ⚠️ 一条解释一格（slot = 消息 id），所以这类标注**天然有多行**。
            # 早先这里写的是 by_kind[kind] = payload，后一条会把前一条整个盖掉 ——
            # 一篇文献问了十个问题，导出只剩最后一个。必须累加。
            bucket = by_kind.setdefault("ai_answer", [])
            payload = mark.get("payload")
            if isinstance(payload, list):
                bucket.extend(payload)
            elif isinstance(payload, dict):
                bucket.append(payload)
            continue
        by_kind[kind] = mark.get("payload")

    keypoint_payload = by_kind.get("keypoints")
    if not isinstance(keypoint_payload, dict):
        keypoint_payload = {}
    added_points = _as_list(keypoint_payload.get("added"))

    ai_answers = [a for a in _as_list(by_kind.get("ai_answer")) if isinstance(a, dict)]

    def _sort_key(item: dict[str, Any]) -> tuple[int, str]:
        page = item.get("page")
        return (page if isinstance(page, int) else 10 ** 6, _text(item.get("created_at")))

    ai_answers.sort(key=_sort_key)

    # ---- 正文：多个来源依次渲染 ----
    source_names: list[str] = []
    body_parts: list[str] = []
    for index, source in enumerate(sources or [], 1):
        name = _text(getattr(source, "filename", None) or (source.get("filename") if isinstance(source, dict) else ""))
        text = getattr(source, "text", None)
        if text is None and isinstance(source, dict):
            text = source.get("text")
        raw_figures = getattr(source, "figures", None)
        if raw_figures is None and isinstance(source, dict):
            raw_figures = source.get("figures")
        raw_formulas = getattr(source, "formulas", None)
        if raw_formulas is None and isinstance(source, dict):
            raw_formulas = source.get("formulas")

        figures = {
            _text(fig.get("id")): fig
            for fig in _as_list(raw_figures)
            if isinstance(fig, dict) and _text(fig.get("id"))
        }
        formulas = {
            _text(fm.get("id")): fm
            for fm in _as_list(raw_formulas)
            if isinstance(fm, dict) and _text(fm.get("id"))
        }
        if not _text(text) and not figures and not formulas:
            continue
        source_names.append(name or f"来源 {index}")
        stats["figures"] += len(figures)
        stats["formulas"] += len(formulas)
        rendered, referenced = _render_article_text(
            _text(text), figures, formulas, sink, index, opt["include_figures"]
        )
        # 正文没有锚点指向的图（跨页图、纯表题、解析漏标）补在末尾，避免静默丢图。
        rendered += _render_leftover_figures(
            figures, referenced, sink, opt["include_figures"]
        )
        if len(sources or []) > 1:
            body_parts.append(f"## {name or f'来源 {index}'}\n\n{rendered}")
        else:
            body_parts.append(rendered)

    stats["segments"] = len([s for s in (segments or []) if isinstance(s, dict)])
    stats["notes"] = len([n for n in _as_list(by_kind.get("notes")) if isinstance(n, dict)])
    stats["highlights"] = len(
        [h for h in _as_list(by_kind.get("highlight")) if isinstance(h, dict)]
    )
    stats["ai_answers"] = len(ai_answers)

    summary = _render_overview(
        doc_title,
        meta,
        [p for p in _as_list(meta.get("keypoints")) if isinstance(p, dict)],
        [p for p in added_points if isinstance(p, dict)],
        [_text(q) for q in _as_list(meta.get("suggested_questions")) if _text(q)],
        stats,
        source_names,
    )
    files["00-精读总览.md"] = summary

    if opt["include_fulltext"] and body_parts:
        files["01-原文正文.md"] = f"# 原文正文\n\n" + "\n\n".join(body_parts).strip() + "\n"

    if opt["include_translation"] and (segments or []):
        files["02-全文对照.md"] = _render_segments(segments or [])

    # 空章节不落文件：一份只有「（无）」的 md 是噪音，而条数在总览里已经如实写了。
    # 这与 01/02/05 的条件生成口径保持一致 —— 有内容才出文件。
    has_user_notes = bool(
        [n for n in _as_list(by_kind.get("notes")) if isinstance(n, dict)]
        or [h for h in _as_list(by_kind.get("highlight")) if isinstance(h, dict)]
        or _text(by_kind.get("note"))
    )

    if opt["include_notes"] and has_user_notes:
        files["03-我的笔记与高亮.md"] = _render_notes(by_kind)

    if opt["include_ai"] and ai_answers:
        files["04-AI-解释.md"] = _render_ai_answers(ai_answers)

    if opt["include_comparison"] and _text(comparison):
        files["05-文献对比.md"] = _render_comparison(_text(comparison), doc_title)

    if opt["include_deep"] and deep_analysis:
        files["06-AI-深度解析.md"] = _render_deep_analysis(deep_analysis)

    stats["sections"] = len(files)
    stats["files"] = len(files)
    stats["chars"] = sum(len(v) for v in files.values())
    stats["missing_figures"] = sink.missing_figures
    stats["image_formulas"] = sink.image_formulas
    stats["has_deep_analysis"] = bool(deep_analysis)

    return {"root": root, "files": files, "assets": sink.assets, "stats": stats}


def build_zip(root: str, files: dict[str, str], assets: dict[str, bytes] | None = None) -> bytes:
    """打包成 zip：整体套一层以 root 命名的文件夹，解压即得一个可直接打开的资料夹。

    与 vault_export.build_zip 的区别只有一个：这里还要装 assets/ 下的二进制。
    既有的那个函数保持原样不动（它服务的是 Obsidian 导出，只有纯文本）。
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for path, content in sorted(files.items()):
            zf.writestr(f"{root}/{path}", content)
        for path, data in sorted((assets or {}).items()):
            zf.writestr(f"{root}/assets/{path}", data)
    return buf.getvalue()
