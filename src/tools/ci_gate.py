#!/usr/bin/env python3
"""提交门禁：语法 + 「仓库里不得出现凭据」。

只用标准库、不读 requirements.txt，因此可以在任何干净环境里跑：

    python src/tools/ci_gate.py   # 本地
    (CI 里由 .gitlab-ci.yml 调用)

判定范围以「受版本控制的文件」为准：本机有 git 就用 `git ls-files`，
CI 镜像没装 git 就退化为遍历检出目录 —— 两者结果一致，因为检出目录里
本来就只有该提交的文件，不会出现 data/、.env、docs/ 这些本地才有的东西。

设计取向是「宁可漏报，不可误报」：误报会让流水线变红，反而失去意义。
所以模式串都带边界或长度要求，并明确跳过「规则里写着自己」的两个文件。
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

SKIP_DIRS = {
    ".git",
    "__pycache__",
    ".venv",
    ".venv311",
    "venv",
    "node_modules",
    "data",
    "logs",
    "dist",
    "build",
    ".workbuddy",
    ".pytest_cache",
}

TEXT_EXT = {
    ".py",
    ".js",
    ".css",
    ".html",
    ".json",
    ".md",
    ".yml",
    ".yaml",
    ".txt",
    ".cfg",
    ".ini",
    ".toml",
    ".sh",
    ".cmd",
    ".example",
}
TEXT_NAMES = {".gitignore", ".gitattributes"}

MAX_BYTES = 2_000_000

# 这两个文件本身就是「规则」，里面必然写着下面的模式串，扫它们只会自己撞自己
SELF_SKIP = {"src/tools/ci_gate.py", "tools/ci_gate.py", ".gitlab-ci.yml"}

# 仓库不含任何密钥：`.env.example` 里两把 *_B64 都是占位符，凭据门禁对它照常生效。
# 这里刻意留成空集合而不是删掉变量——下次谁想再开例外，得先看见这段说明。
ALLOWLIST: set[str] = set()

CHECKS = [
    ("GitLab 访问令牌", re.compile(r"glpat-[A-Za-z0-9._-]{15,}")),
    # 左边界避免 "ask-suggested" 这类词被误判（有过先例）
    ("OpenAI 风格密钥", re.compile(r"(?<![A-Za-z0-9])sk-[A-Za-z0-9]{20,}")),
    ("天大平台密钥", re.compile(r"(?<![A-Za-z0-9])tk-[A-Za-z0-9_-]{20,}")),
    # 微信读书 Agent API 的 Key（wrk- 开头，绑定用户身份，等同账号凭证）。
    # 读书功能只用环境变量或 data/local_api_config.json（DPAPI 密文）承载，
    # 仓库里出现这一串就是事故。
    ("微信读书密钥", re.compile(r"(?<![A-Za-z0-9])wrk-[A-Za-z0-9_-]{16,}")),
    ("内嵌凭据常量", re.compile(r"_(?:TJU|VISION)_API_KEY_ENCODED")),
    ("私钥文件头", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
]


def _walk_files() -> list[Path]:
    found: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for name in filenames:
            found.append(Path(dirpath, name).relative_to(ROOT))
    return sorted(found)


def _tracked_files() -> list[Path] | None:
    """有可用的 git 就只取受版本控制的文件；不可用则返回 None。"""
    try:
        done = subprocess.run(
            ["git", "ls-files", "-z"],
            cwd=ROOT,
            capture_output=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if done.returncode != 0:
        return None
    names = done.stdout.decode("utf-8", "replace").split("\0")
    return sorted(Path(n) for n in names if n)


def main() -> int:
    files = _tracked_files()
    if files is None:
        files = _walk_files()
        print("（未检测到可用的 git，改按检出目录遍历）")
    else:
        print(f"（按 git ls-files 判定，共 {len(files)} 个受版本控制的文件）")

    problems: list[str] = []

    print("== 1/3 语法门禁 ==")
    py_files = [f for f in files if f.suffix == ".py"]
    for rel in py_files:
        try:
            compile((ROOT / rel).read_bytes(), rel.as_posix(), "exec")
        except SyntaxError as exc:
            problems.append(f"{rel}:{exc.lineno}: 语法错误 {exc.msg}")
    print(f"  已解析 {len(py_files)} 个 .py 文件")

    print("== 2/3 提交物门禁 ==")
    if any(f.as_posix() == ".env" for f in files):
        problems.append(".env: 凭据只应放本地 .env 或 CI 变量，不要提交进仓库")
    print("  已确认 .env 未入库")

    print("== 3/3 凭据门禁 ==")
    scanned = 0
    for rel in files:
        key = rel.as_posix()
        if key in SELF_SKIP or key in ALLOWLIST:
            continue
        if rel.suffix.lower() not in TEXT_EXT and rel.name not in TEXT_NAMES:
            continue
        path = ROOT / rel
        try:
            if path.stat().st_size > MAX_BYTES:
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        scanned += 1
        for label, rx in CHECKS:
            for m in rx.finditer(text):
                line = text.count("\n", 0, m.start()) + 1
                problems.append(f"{key}:{line}: 疑似{label}")
    print(f"  已扫描 {scanned} 个文本文件")

    if problems:
        print("\n门禁未通过：")
        for p in problems:
            print("  -", p)
        return 1

    print("\n全部门禁通过。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
