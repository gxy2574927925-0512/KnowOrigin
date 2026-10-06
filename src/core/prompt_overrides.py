# -*- coding: utf-8 -*-
"""提示词实验室的本地覆盖：可编辑、可重置。

「提示词实验室」默认展示 core/llm.py 里的出厂提示词；本模块让用户能就地改写某一个
任务的 system prompt，并随时重置回默认。

设计取向：
- 覆盖按任务名存一份 JSON（``data/prompt_overrides.json``），进程内缓存 —— 避免每次
  ``_system_prompt`` 调用都读盘（那是每个 AI 任务的热路径）。
- 只覆盖「真正发给模型的那一份」：命中覆盖时 ``_system_prompt`` 直接返回它，所见即所用。
- 空串/空白视为未覆盖：避免误存空串把某个任务打哑，也让「清空后保存」等于重置。
- 重置即删除该任务条目，回到 core/llm.py 的出厂文本。
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path

_LOCK = threading.Lock()
_CACHE: dict[str, str] | None = None
_PATH: Path | None = None


def _path() -> Path:
    global _PATH
    if _PATH is None:
        try:
            from config import load_settings

            base = Path(load_settings().data_dir)
        except Exception:
            base = Path(
                os.path.normpath(
                    os.path.join(
                        os.path.dirname(os.path.abspath(__file__)), "..", "..", "data"
                    )
                )
            )
        _PATH = base / "prompt_overrides.json"
    return _PATH


def _load() -> dict[str, str]:
    global _CACHE
    if _CACHE is not None:
        return _CACHE
    try:
        payload = json.loads(_path().read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    _CACHE = {
        str(key): value
        for key, value in payload.items()
        if isinstance(value, str) and value.strip()
    }
    return _CACHE


def get_prompt_override(task: str) -> str:
    """命中则返回用户改写过的 system prompt，否则返回空串（用出厂默认）。"""

    return _load().get(task, "")


def set_prompt_override(task: str, prompt: str) -> bool:
    """保存覆盖；传空串等于重置。返回保存后该任务是否处于「已覆盖」状态。"""

    text = (prompt or "").strip()
    with _LOCK:
        data = dict(_load())
        if text:
            data[task] = prompt
        else:
            data.pop(task, None)
        _write(data)
        return bool(text)


def clear_prompt_override(task: str) -> None:
    with _LOCK:
        data = dict(_load())
        if task in data:
            data.pop(task, None)
            _write(data)


def _write(data: dict[str, str]) -> None:
    global _CACHE
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    temporary.replace(path)
    _CACHE = data
