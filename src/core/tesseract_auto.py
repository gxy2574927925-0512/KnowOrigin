"""Tesseract OCR 可执行文件自动定位。

`core/parsers.py` 通过 `from .tesseract_auto import setup_pytesseract` 调用本模块，
用于在 Windows 上自动把 `pytesseract.pytesseract.tesseract_cmd` 指向实际安装的
`tesseract.exe`，免去用户手动改 PATH。

说明：Tesseract 是**可选** OCR 后端（主后端是 pip 安装的 rapidocr，无需系统依赖）。
未安装 Tesseract 时本模块静默返回 False，OCR 自动走 rapidocr，不影响任何功能。
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path


def _candidates() -> list[str]:
    """按可能性排序列出 tesseract 可执行文件的候选路径。"""
    found = shutil.which("tesseract")
    out = [found] if found else []

    if os.name == "nt":
        local = os.environ.get("LOCALAPPDATA", "")
        program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
        program_files_x86 = os.environ.get(
            "ProgramFiles(x86)", r"C:\Program Files (x86)"
        )
        out += [
            os.path.join(program_files, "Tesseract-OCR", "tesseract.exe"),
            os.path.join(program_files_x86, "Tesseract-OCR", "tesseract.exe"),
            os.path.join(local, "Tesseract-OCR", "tesseract.exe"),
            os.path.join(local, "Programs", "Tesseract-OCR", "tesseract.exe"),
        ]
    else:
        out += [
            "/usr/bin/tesseract",
            "/usr/local/bin/tesseract",
            "/opt/homebrew/bin/tesseract",
        ]

    seen, result = set(), []
    for path in out:
        if path and path not in seen:
            seen.add(path)
            result.append(path)
    return result


def setup_pytesseract() -> bool:
    """定位 tesseract 并写入 pytesseract 配置。成功返回 True，否则 False。"""
    try:
        import pytesseract
    except ImportError:
        return False

    for path in _candidates():
        if not path or not Path(path).exists():
            continue
        try:
            pytesseract.pytesseract.tesseract_cmd = path
            pytesseract.get_tesseract_version()
            return True
        except Exception:
            continue
    return False
