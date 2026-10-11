"""版式保真的 PDF 全文翻译（外部工具 pdf2zh / BabelDOC）。

和 MinerU 完全同一套处理方式：**可选外部 CLI**。装了才用，没装就明确告知，
绝不把它的依赖（gradio / httpx>=0.28 等）拽进知源主环境——那会顶掉知源在用的 httpx。

为什么走外部进程而不是自己用 PyMuPDF 重写：pdf2zh 处理了字体匹配、公式剥离、
断行补偿、图表原位保留这一整串脏活，自己写等于重新踩别人踩过两年的坑。

实测（pdf2zh-next 2.9.0 + BabelDOC 0.6.2，2026-10-09）：
  * 30 页论文翻 2 页耗时 ~145s（天大大模型），必须后台任务 + 缓存，不能卡请求。
  * `--use-alternating-pages-dual` 产出「原文页 / 译文页」交替的双语 PDF，
    偶数页=原文、奇数页=译文，前端并排就是 Zotero 那种对照效果。
  * 默认会给译文页打 BabelDOC 水印，必须显式 `--watermark-output-mode no_watermark`。
"""

from __future__ import annotations

import hashlib
import logging
import shutil
import subprocess
from pathlib import Path

LOGGER = logging.getLogger(__name__)

# pdf2zh-next 的命令行名（pdf2zh 1.x 叫 pdf2zh，2.x 基于 BabelDOC 改名 pdf2zh_next）。
DEFAULT_CLI = "pdf2zh_next"


def pdf2zh_available(cli: str = DEFAULT_CLI) -> bool:
    """检测 pdf2zh CLI 是否可用（命令名或绝对路径）。"""
    if not cli or not cli.strip():
        return False
    return shutil.which(cli.strip()) is not None


def translation_key(data: bytes, lang_to: str, pages: str = "") -> str:
    """翻译产物缓存键：原文字节 + 目标语言 + 页码范围。

    原文换了就自动失效；同一篇论文反复打开对照视图不会重跑（那要重新烧一次 LLM）。
    """
    seed = f"{lang_to}|{pages}|".encode("utf-8") + data
    return hashlib.sha256(seed).hexdigest()[:24]


def translate_pdf(
    data: bytes,
    output_dir: Path,
    *,
    api_key: str,
    base_url: str,
    model: str,
    cli: str = DEFAULT_CLI,
    lang_from: str = "en",
    lang_to: str = "zh",
    pages: str = "",
    timeout: float = 3600.0,
) -> tuple[Path | None, Path | None]:
    """调用 pdf2zh 翻译整份 PDF，返回 (mono 纯译文版, dual 交替对照版)。

    任一产物缺失就返回 None；失败/超时一律返回 (None, None)，绝不抛，
    交给上层给出可读提示——翻译跑一半崩了不该让整个文献页挂掉。
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    src = output_dir / "input.pdf"
    src.write_bytes(data)

    command = [
        cli.strip(),
        str(src),
        "--output",
        str(output_dir),
        "--lang-in",
        lang_from,
        "--lang-out",
        lang_to,
        "--openai",
        "--openai-model",
        model or "",
        "--openai-base-url",
        (base_url or "").rstrip("/"),
        "--openai-api-key",
        api_key or "",
        "--use-alternating-pages-dual",
        "--watermark-output-mode",
        "no_watermark",
        # 否则它会把带密钥的配置写到用户目录，下次没传参数也会沿用旧密钥
        "--disable-config-auto-save",
    ]
    if pages and pages.strip():
        command += ["--pages", pages.strip()]

    try:
        completed = subprocess.run(
            command, capture_output=True, timeout=timeout, check=False
        )
    except subprocess.TimeoutExpired:
        LOGGER.warning("pdf2zh timed out after %.1fs", timeout)
        return None, None
    except OSError as exc:  # 命令不存在 / 起不来
        LOGGER.warning("pdf2zh failed to start (%s)", exc)
        return None, None

    # 整份输出落盘：pdf2zh 一崩就只剩两行日志，没有它根本没法定位
    log_path = output_dir / "translate.log"
    log_path.write_bytes(
        (completed.stdout or b"") + b"\n--- stderr ---\n" + (completed.stderr or b"")
    )

    if completed.returncode != 0:
        # pdf2zh 收尾时会把自己内部子进程 SIGTERM 掉并打印一段 -15 堆栈，
        # 只要产物在就算成功，所以这里只记日志不判死。
        LOGGER.warning(
            "pdf2zh exited with code %s，日志见 %s\n%s",
            completed.returncode,
            log_path,
            (completed.stdout or b"").decode("utf-8", "ignore")[-600:],
        )

    products = [p for p in output_dir.glob("*.pdf") if p.name != "input.pdf"]
    dual = next((p for p in products if ".dual." in p.name), None)
    mono = next((p for p in products if ".mono." in p.name), None) or next(
        (p for p in products if p is not dual), None
    )
    return mono, dual
