# -*- coding: utf-8 -*-
"""提示词实验室的对齐检查：目录 vs 真实调用。

提示词实验室（设置 → AI 透明度）靠 ``core/prompt_catalog.py`` 这张目录把 ``core/llm.py``
里散落的任务翻译成人能读的清单。目录是**手工维护**的，代码在长 —— 一加新 AI 任务忘了登记，
实验室就悄悄少一块（那一块既看不到、也改不了）。这个脚本把「忘了登记」变成一次可跑的红灯。

检查三件事：
1. **漏登记**：代码里真的调了，但目录里没有 —— 该任务在实验室里彻底消失。
2. **死条目**：目录里还写着，但代码已经不调了 —— 界面上摆一个点开是空的按钮。
   填了 ``merged_into`` 的不算失败（那表示「这个任务没被调用，功能并入了别处」，
   **功能还在**，别写成停用/下线），单列在「已并入」里。
3. **无专用提示词**：登记了，但 ``_default_system_prompt`` 没有分支，落到通用兜底人设 ——
   界面会挂「落到通用兜底人设」徽章，属实但提示用户「这段没有专用提示词」。

任务名怎么抽出来的：AST 遍历，三条调用形态都要认（漏一条就会误报「死条目」）：
1. 直接调用：``llm.complete_json("task", payload)`` —— 取第 1 个位置参数；
2. 函数当实参：``asyncio.to_thread(llm.complete_json, "task", payload)`` ——
   认出 args 里出现的 ``complete_json``，取**紧跟其后的**字符串；
3. 流式通道：``llm.astream_chat_content(messages, "task")`` —— 取第 2 个位置参数。
   流式任务同样走 ``stream_system_prompt``，实验室里一样能改，不能漏。
字面量直接取值；模块级常量（如 ``_PLAN_TASK = "paper_query_plan"``）回溯赋值；
三元赋值（``task = "solve_problem" if kind == "solve" else "answer_question"``）
两个分支都记 —— 不认它就会把 solve_problem 误报成死条目。
变量传参实在抓不到的，打进 unresolved 让人肉确认 —— 宁可报 unresolved，也不假装没看见。

包装器（``core/usage.py`` 的计费代理、``user_memory.py`` 的记忆注入代理、llm.py 自己的
流式递归）转发的是上游同一个 task 名，把这些函数体整段跳过，否则每个任务都会多出一条
假的调用点。判据：调用点落在**同名函数定义**的行范围内。

用法：
    python tools/check_prompt_catalog.py          # 检查，漂移则返回非零
    python tools/check_prompt_catalog.py --list   # 只打印当前真实任务清单
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
CALL_NAMES = {"complete_json", "complete_json_with_image"}
STREAM_NAMES = {"astream_chat_content", "stream_chat_content"}
# 计费包装器：转发同一 task 名，扫它会把每个任务重复计一次，跳过
SKIP_FILES = {"src/core/usage.py"}
FALLBACK_ROLE = "你是知源 KnowOrigin 的本地学习 Agent。"


def _string_consts(tree: ast.Module) -> dict[str, list[str]]:
    """变量名 -> 它可能取到的字符串值，用于回溯间接传参。

    覆盖两种：模块级常量（``_PLAN_TASK = "paper_query_plan"``）与三元赋值
    （``task = "solve_problem" if kind == "solve" else "answer_question"``）。
    三元两边都收 —— 少收一个就会把那个任务误判成没人调用。
    """
    out: dict[str, list[str]] = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        value = node.value
        values: list[str] = []
        if isinstance(value, ast.Constant) and isinstance(value.value, str):
            values = [value.value]
        elif isinstance(value, ast.IfExp):
            for branch in (value.body, value.orelse):
                if isinstance(branch, ast.Constant) and isinstance(branch.value, str):
                    values.append(branch.value)
        if not values:
            continue
        for target in node.targets:
            if isinstance(target, ast.Name):
                out.setdefault(target.id, []).extend(values)
    return out


def _wrapper_ranges(tree: ast.Module) -> list[tuple[int, int]]:
    """包装器函数的行范围 —— 落在里面的调用是转发，不算新的调用点。"""
    names = CALL_NAMES | STREAM_NAMES
    ranges = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.name in names and node.end_lineno:
                ranges.append((node.lineno, node.end_lineno))
    return ranges


def scan_called_tasks() -> tuple[dict[str, list[str]], list[str]]:
    """返回 {任务名: [调用点]} 与 无法静态解析的调用点列表。"""
    found: dict[str, list[str]] = {}
    unresolved: list[str] = []
    for path in sorted(SRC.rglob("*.py")):
        rel_all = path.relative_to(ROOT).as_posix()
        if rel_all in SKIP_FILES:
            continue
        try:
            source = path.read_text(encoding="utf-8")
            tree = ast.parse(source)
        except (OSError, SyntaxError):
            continue
        consts = _string_consts(tree)
        wrappers = _wrapper_ranges(tree)
        rel = path.relative_to(ROOT).as_posix()
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            if any(start <= node.lineno <= end for start, end in wrappers):
                continue
            where = f"{rel}:{node.lineno}"
            fname = getattr(node.func, "attr", None) or getattr(node.func, "id", None)

            def record(arg: ast.expr, tag: str = "") -> None:
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    found.setdefault(arg.value, []).append(where + tag)
                elif isinstance(arg, ast.Name) and arg.id in consts:
                    for value in consts[arg.id]:
                        found.setdefault(value, []).append(
                            f"{where}(变量{arg.id}){tag}"
                        )
                else:
                    unresolved.append(where + tag)

            # 1) 直接调用：complete_json("task", payload)
            if fname in CALL_NAMES and node.args:
                record(node.args[0])
                continue
            # 2) 函数当实参：to_thread(llm.complete_json, "task", payload)
            for index, arg in enumerate(node.args):
                aname = getattr(arg, "attr", None) or getattr(arg, "id", None)
                if aname in CALL_NAMES and index + 1 < len(node.args):
                    record(node.args[index + 1], "(间接)")
                    break
            else:
                # 3) 流式通道：astream_chat_content(messages, "task")
                if fname in STREAM_NAMES and len(node.args) >= 2:
                    record(node.args[1], "(流式)")
    return found, unresolved


def main() -> int:
    sys.path.insert(0, str(SRC))
    from core.prompt_catalog import PROMPT_GROUPS, PROMPT_TASKS  # noqa: E402

    catalog = {item["task"]: item for item in PROMPT_TASKS}
    called, unresolved = scan_called_tasks()

    if "--list" in sys.argv:
        for task in sorted(called):
            meta = catalog.get(task)
            print(f"{task}\t{meta['group'] if meta else '（未登记）'}\t{called[task][0]}")
        return 0

    missing = sorted(set(called) - set(catalog))          # 漏登记
    # 死条目：目录里有、代码里调不到。填了 merged_into 的是「知道它并入了别处」（功能还在，
    # 只是换了实现），分开列，不算失败。
    merged = {t for t, item in catalog.items() if item.get("merged_into")}
    dead = sorted(t for t in set(catalog) - set(called) if t not in merged)
    retired = sorted(t for t in set(catalog) - set(called) if t in merged)
    # 标了 merged_into 却还在被调用 = 标注过期，同样是漂移
    stale_retired = sorted(t for t in set(called) if t in merged)

    try:
        from core import llm as llm_module

        def has_dedicated(task: str) -> bool:
            return FALLBACK_ROLE not in llm_module._default_system_prompt(task)
    except Exception:  # noqa: BLE001 - 导入失败不阻拦前两项检查
        def has_dedicated(task: str) -> bool:
            return True

    no_dedicated = [t for t in sorted(catalog) if not has_dedicated(t)]
    # 目录分组里的组若已无任务，界面上会空着一块
    used_groups = {item["group"] for item in PROMPT_TASKS}
    empty_groups = [g for g in PROMPT_GROUPS if g not in used_groups]

    print(f"目录登记 {len(catalog)} 个任务，代码实际调用 {len(called)} 个。")
    if missing:
        print(f"\n[漏登记] {len(missing)} 个 —— 实验室里看不到、也改不了：")
        for task in missing:
            print(f"  - {task}\t{called[task][0]}")
    if dead:
        print(f"\n[死条目] {len(dead)} 个 —— 界面上有按钮但没有真实调用：")
        for task in dead:
            print(f"  - {task}\t{catalog[task]['group']}")
    if retired:
        print(f"\n[已并入] {len(retired)} 个 —— 无独立调用点，功能由别的任务承担：")
        for task in retired:
            print(f"  - {task}\t{catalog[task]['group']}\t→ {catalog[task]['merged_into']}")
    if stale_retired:
        print(f"\n[标注过期] {len(stale_retired)} 个 —— 标了 merged_into 但代码还在调：")
        for task in stale_retired:
            print(f"  - {task}\t{called[task][0]}")
    if no_dedicated:
        print(f"\n[无专用提示词] {len(no_dedicated)} 个 —— 落到通用兜底人设：")
        for task in no_dedicated:
            print(f"  - {task}\t{catalog[task]['group']}")
    if empty_groups:
        print(f"\n[空分组] {empty_groups}")
    # 分组拼错或 source 写错，界面上会静默少一块 / 徽章乱挂，一并挡住
    bad_source = sorted(
        t for t, item in catalog.items()
        if item.get("source", "system") not in {"system", "payload", "external"}
    )
    if bad_source:
        print(f"\n[source 取值非法] {bad_source}（只能是 system / payload / external）")
    unknown_group = sorted({item["group"] for item in PROMPT_TASKS} - set(PROMPT_GROUPS))
    if unknown_group:
        print(f"\n[分组未登记] {unknown_group} —— 不在 PROMPT_GROUPS 里，界面上不会显示")
    if unresolved:
        print(f"\n[未能静态解析] {len(unresolved)} 处，需人工确认：")
        for where in unresolved:
            print(f"  - {where}")

    bad = bool(missing or dead or stale_retired or empty_groups or bad_source or unknown_group)
    if not bad:
        print("\n对齐：通过。")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
