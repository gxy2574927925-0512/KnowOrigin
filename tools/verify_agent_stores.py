"""防「store 漏传」回归：读取工具在**每一条会跑工具的分支**上都得拿到真实 store。

背景（2026-10-04 真机故障）：`get_study_kit` / `get_learning_calendar` /
`search_knowledge_docs` 依赖 `study_kit` / `exam_scheduler` / `knowledge_doc` 三个
store，它们是 `create_app` 闭包里的缓存对象，只能由调用点传进 `_run_agent_tool`。

我只在**原生 tool_calls 分支**传了，漏了**伪调用分支** —— 而天大网关没有原生函数调用，
实际跑的恰恰是伪调用那条。于是三个工具全部拿到 None，回「当前入口没有接入…存储」，
模型转头告诉用户「你还没有生成学习路径/速查表/文档」，**而库里全都有**
（实测该项目的 study_kits 三种齐全、knowledge_docs 11 篇）。

这类 bug 静态看不出来、也不会抛异常，只会让工具「诚实地说自己没接入」。
所以这里做两件事：
  1. 静态扫源码：每个 `_run_agent_tool` 调用点实参里出现了哪些 store；
  2. 行为验证：用真 store 跑一遍三个读取工具，确认它们真能读出内容。
"""
import ast
import re
import sys
import tempfile
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import api_server as a  # noqa: E402
from core.database import Database  # noqa: E402
from core.exam_scheduler import ExamScheduler  # noqa: E402
from core.knowledge_doc import KnowledgeDocStore, doc_key_for  # noqa: E402
from core.models import FrameworkNode  # noqa: E402
from core.study_kit import StudyKitStore  # noqa: E402

STORES = ("study_kit=", "exam_scheduler=", "knowledge_doc=")
READ_TOOLS = ("get_study_kit", "get_learning_calendar", "search_knowledge_docs")

FAILS = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


def scan_call_sites():
    """静态：用 ast 精确找出每个 `_run_agent_tool` 调用点传了哪些 store，以及它属于哪个函数。

    不要用正则数 `_run_agent_tool` 出现次数 —— 文档字符串里提到它也会被算进去（踩过）。
    这里走 AST：既认 `f(_run_agent_tool, ...)`，也认
    `asyncio.to_thread(_run_agent_tool, ...)` 这种把函数当参数传的写法。
    """
    src = (ROOT / "src" / "api_server.py").read_text(encoding="utf-8")
    tree = ast.parse(src.lstrip("\ufeff"))
    wanted = ("study_kit", "exam_scheduler", "knowledge_doc")

    # 先收集所有函数的行号区间，用来判定调用点归属哪个函数
    functions = [
        (node.name, node.lineno, node.end_lineno or node.lineno)
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    ]

    def enclosing(line: int) -> str:
        # 取「范围包含该行且最内层」的函数
        best = ("<module>", 0, 0)
        for name, start, end in functions:
            if start <= line <= end and (end - start) < (best[2] - best[1] or 10**9):
                best = (name, start, end)
        return best[0]

    results = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        keywords = {kw.arg for kw in node.keywords if kw.arg}
        is_call = (
            isinstance(node.func, ast.Name) and node.func.id == "_run_agent_tool"
        ) or (
            isinstance(node.func, ast.Attribute)
            and node.func.attr == "to_thread"
            and node.args
            and isinstance(node.args[0], ast.Name)
            and node.args[0].id == "_run_agent_tool"
        )
        if is_call:
            got = tuple(name for name in wanted if name in keywords)
            # 工具名如果是字面量常量就记下来：`converge` 快捷路径只跑写工具，允许不传 store
            tool_literal = ""
            for arg in node.args:
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    tool_literal = arg.value
                    break
            results.append((node.lineno, got, enclosing(node.lineno), tool_literal))
    return sorted(set(results))


def main():
    print("== 1. 静态：每个调用点传了哪些 store ==")
    sites = scan_call_sites()
    check("扫到多个调用点", len(sites) >= 4, f"{len(sites)} 个")
    # 只有两处可以不传 store：`converge` 快捷路径、待确认动作执行端点（都只跑写工具）
    without = [(line, got, func, tool) for line, got, func, tool in sites if len(got) < 3]
    for line, got, func, tool in without:
        if func == "agent_execute_actions" or tool == "converge":
            continue
        check(f"L{line}（{func}）也传了三个 store", False, f"只有 {list(got)}")
    check(
        "缺 store 的调用点只有写操作路径",
        all(func == "agent_execute_actions" or tool == "converge"
            for _, _, func, tool in without),
        str([(line, func, tool) for line, _, func, tool in without]),
    )
    with_stores = [line for line, got, _, _ in sites if len(got) == 3]
    check("至少三条分支传全了 store", len(with_stores) >= 3, str(with_stores))

    print()
    print("== 2. 行为：三个读取工具真能读出内容 ==")
    tmp = Path(tempfile.mkdtemp(prefix="knoworigin-store-"))
    db = Database(tmp / "verify.sqlite3")
    owner = db.create_user("s@e.com", "abcd1234", "S").user_id
    project = db.create_project("2026", "可视化", owner_id=owner)
    pid = project.project_id
    db.upsert_framework_nodes(pid, [FrameworkNode(node_id="root", name="课程")])

    kit = StudyKitStore(db.path)
    for kind in ("cheatsheet", "learning_path", "checklist"):
        kit.save(project_id=pid, owner_id=owner, kind=kind, title=kind,
                 content_md=f"## {kind} 的正文标记")
    docs = KnowledgeDocStore(db.path)
    docs.save(
        doc_key=doc_key_for(owner, pid, scope="node", node_id="root"),
        owner_id=owner, project_id=pid, scope="node", node_id="root",
        title="课程复习文档", signature="s", content={"summary": "x"},
        content_md="## 文档正文标记",
    )
    planner = ExamScheduler(db.path)

    def run(name, arguments):
        return a._run_agent_tool(
            name, arguments, db=db, project_id=pid, sources=[], nodes=[],
            owner_id=owner, study_kit=kit, exam_scheduler=planner, knowledge_doc=docs,
        )

    out = run("get_study_kit", {})
    check("get_study_kit 读到三种正文", all(f"{kind} 的正文标记" in out
                                     for kind in ("cheatsheet", "learning_path", "checklist")),
          out.replace("\n", " ")[:110])
    check("get_study_kit 不说「没有接入」", "没有接入" not in out)

    out = run("get_learning_calendar", {"days": 7})
    check("get_learning_calendar 真的跑起来了", "没有接入" not in out and "没有这个信息" not in out,
          out.split("\n")[0][:110])
    check("get_learning_calendar 报打卡窗口", "打卡日历" in out, out.split("\n")[0][:80])

    # 列举模式刻意只给清单不给正文（正文要显式点名那篇），所以验"读得出内容"
    # 必须定向读；列举另有一条断言。
    out = run("search_knowledge_docs", {"node_id": "root"})
    check("search_knowledge_docs 读到文档正文", "文档正文标记" in out, out.replace("\n", " ")[:110])
    check("search_knowledge_docs 不说「没有接入」", "没有接入" not in out)
    out_list = run("search_knowledge_docs", {})
    check("search_knowledge_docs 列举模式列出这篇",
          "课程复习文档" in out_list and "root" in out_list, out_list.replace("\n", " ")[:110])

    # store 为 None 时的提示必须与「真的没数据」可区分，否则模型会替工具撒谎
    blind = a._run_agent_tool("get_study_kit", {}, db=db, project_id=pid, sources=[],
                              nodes=[], owner_id=owner, study_kit=None)
    check("store 缺失时明说未接入（不是「尚未生成」）",
          "没有接入" in blind and "尚未生成" not in blind, blind[:80])

    docs.close()
    kit.close()
    db.close()

    print()
    if FAILS:
        print(f"失败 {len(FAILS)} 项：{FAILS}")
        return 1
    print("store 传递回归全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
