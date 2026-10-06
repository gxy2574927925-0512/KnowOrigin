"""陪练台回归：scaffold / calibration / 端点 / 前端标记。

跑法：``python tools/verify_coach_regression.py``
约定与 ``tools/verify_*`` 同一套：逐条打印 ``[PASS]`` / ``[FAIL]``，任一 FAIL 退出码非 0。

覆盖四层，从纯函数一路验到端点注册与前端标记：
1. ``core/scaffold.py`` 五档梯子与四条守卫（含守卫之间的优先级）
2. ``core/calibration.py`` 判定阈值、四格分箱、样本量地板、probe 的选择性
3. 两个新端点真的注册进 app，且形状与既有端点一致
4. ``static/coach-ui.js`` 与 ``index.html`` 的挂载标记齐全、字体走 --text-* 阶梯
"""

from __future__ import annotations

import inspect
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

PASSED = 0
FAILED: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    global PASSED
    if ok:
        PASSED += 1
        print(f"[PASS] {label}")
    else:
        FAILED.append(label)
        print(f"[FAIL] {label}{(' — ' + detail) if detail else ''}")


def section(title: str) -> None:
    print(f"\n── {title} " + "─" * max(0, 56 - len(title)))


# ── 1. scaffold：五档梯子 ──────────────────────────────────────────────

def verify_ladder() -> None:
    from core import scaffold

    section("scaffold · 五档梯子")
    check(
        "梯子正好五档且由强到弱",
        scaffold.SCAFFOLD_LADDER == ("full", "faded", "outline", "hint", "silent"),
        str(scaffold.SCAFFOLD_LADDER),
    )
    check(
        "每档都有中文标签与「这一档到底给什么」",
        set(scaffold.SCAFFOLD_LADDER)
        == set(scaffold.SCAFFOLD_LABELS)
        == set(scaffold.SCAFFOLD_WHAT),
    )

    # BKT 单调性：更高的掌握度绝不能给更多支架。
    ascending = [scaffold.level_from_bkt(v) for v in (0.0, 0.3, 0.5, 0.7, 0.85, 0.95)]
    order = [scaffold.SCAFFOLD_LADDER.index(level) for level in ascending]
    check(
        "BKT 越高支架越弱（单调不回退）",
        all(order[i] <= order[i + 1] for i in range(len(order) - 1)),
        str(ascending),
    )
    check("零证据落 full", scaffold.level_from_bkt(0.0) == "full")
    check("满证据落 silent", scaffold.level_from_bkt(0.99) == "silent")
    check("非法输入不抛、退回 full", scaffold.level_from_bkt("垃圾") == "full")


# ── 2. scaffold：四条守卫 ──────────────────────────────────────────────

def verify_guards() -> None:
    from core import scaffold

    section("scaffold · 四条守卫")

    cases = [
        # (bkt, stage, observations, demand, 期望档位, 为什么)
        (0.10, "none", 0, "normal", "full", "零证据的新手从零讲"),
        (0.95, "seen", 6, "normal", "faded", "守卫1：位阶没过会了就不给不给提示"),
        (0.95, "get", 1, "normal", "outline", "守卫2：证据只有1条不据此撤到底"),
        (0.95, "hold", 9, "normal", "silent", "真会了才允许撤到底"),
        (0.95, "hold", 9, "hard", "hint", "守卫3：换情境把支架加回一档"),
        (0.95, "seen", 6, "hard", "faded", "守卫3加回后守卫1仍兜住（换情境的新手也是新手）"),
        (0.30, "hold", 8, "normal", "full", "守卫4：位阶与BKT冲突时按BKT给足支架"),
        (0.95, "hold", None, "normal", "silent", "observations=None 不触发薄证据守卫"),
    ]
    for bkt, stage, obs, demand, want, why in cases:
        got = scaffold.level_for(bkt, stage, observations=obs, demand=demand)
        check(f"{why}（{got['level']}）", got["level"] == want, f"want={want}")

    # 守卫必须真的留痕，否则用户只会看到一个结论、看不到它为什么长这样。
    detail = scaffold.level_for(0.95, "seen", observations=6)
    check("守卫1 留下说明", any("合意困难" in note for note in detail["notes"]))
    thin = scaffold.level_for(0.95, "get", observations=1)
    check("守卫2 留下说明", any("先验" in note for note in thin["notes"]))
    conflict = scaffold.level_for(0.30, "hold", observations=8)
    check("守卫4 留下说明", any("位阶说" in note for note in conflict["notes"]))

    hard = scaffold.level_for(0.95, "hold", observations=9, demand="hard")
    check("守卫3 留下说明", any("换情境" in note for note in hard["notes"]))


# ── 3. scaffold：explain 与 prompt_block ──────────────────────────────

def verify_explain() -> None:
    from core import scaffold

    section("scaffold · explain / prompt_block")

    top = scaffold.explain(0.95, "hold", observations=9)
    check("无守卫介入时 moved_by_guard=False", top["moved_by_guard"] is False)
    check("已是最省一档时 can_withdraw=False", top["can_withdraw"] is False)
    check("已是最省一档也给得出原因", bool(top["withhold_reason"]))

    guarded = scaffold.explain(0.95, "seen", observations=6)
    check("守卫介入时 moved_by_guard=True", guarded["moved_by_guard"] is True)
    check("新手不给撤回资格", guarded["can_withdraw"] is False)
    check("撤回被拒时说明为什么", "合意困难" in guarded["withhold_reason"])
    check("guards 三项如实上报", set(guarded["guards"]) == {"novice_floor", "thin_floor", "hard_step_back"})

    # 「再往前一档」的资格只认证据，不认别的。
    free = scaffold.explain(0.85, "get", observations=6)
    check("get + 6 条证据可以再撤一档", free["can_withdraw"] is True, str(free["withhold_reason"]))

    # 提示词块：五档都出文本，且都禁掉「直接给答案」该有的措辞。
    for level in scaffold.SCAFFOLD_LADDER:
        block = scaffold.prompt_block(level, node_name="傅里叶变换")
        check(f"prompt_block({level}) 出文本且带标签", bool(block) and scaffold.SCAFFOLD_LABELS[level] in block)
    check("非法档位退回 full（给多不给少）", "完整解题步骤" in scaffold.prompt_block("不存在的档"))
    check(
        "silent 档明确禁止给提示",
        "不要给任何提示" in scaffold.prompt_block("silent"),
    )
    check(
        "faded 档明确禁止替用户补完",
        "不要替他补完最后一步" in scaffold.prompt_block("faded"),
    )
    check(
        "hard 情境在 prompt_block 里也生效",
        "新情境题" in scaffold.prompt_block("silent", demand="hard"),
    )
    # full 档允许给答案（那是它该做的事），但必须连中间步骤一起给。
    check(
        "full 档要求连中间步骤一起给",
        "每一步" in scaffold.prompt_block("full"),
    )


# ── 4. scaffold：会话时间盒 ───────────────────────────────────────────

def verify_session_shape() -> None:
    from core import scaffold

    section("scaffold · 会话时间盒")
    one = scaffold.shape_session(1, due_cards=47)
    check("1 个步骤 = 15 分钟", one["work_minutes"] == 15 and one["total_minutes"] == 15)
    three = scaffold.shape_session(3)
    check("3 个步骤 = 45 分钟 + 2 次休息", three["work_minutes"] == 45 and three["break_minutes"] == 6)
    check("步骤数被夹在 1..3", scaffold.shape_session(99)["blocks"] == 3)
    check("步骤数为 0/负/None 兜到 1 块", scaffold.shape_session(0)["blocks"] == 1)
    check("超 60 分钟才提示", three["overrun"] is False and scaffold.shape_session(3)["overrun"] is False)

    # SDT：件数本身是压力源，due_cards 绝不能原样进返回值。
    stressed = scaffold.shape_session(2, due_cards=47)
    check("due_cards 不进返回值", "due_cards" not in stressed)
    check(
        "due_cards 只改措辞不改数字",
        "47" not in str(stressed) and "不用管" in stressed["due_card_hint"],
    )
    check("给的是时间不是件数", "分钟" in stressed["phrasing"])


# ── 5. calibration：判定与分箱 ────────────────────────────────────────

def _make_db(path: Path, samples: int, *, self_value: float | None, actual: float, kind: str = "quiz") -> None:
    """造一个最小可用库。**每次都从空文件开始** —— 复用同一个路径会让第二次
    CREATE TABLE 抛 "table already exists"，而那条异常发生在 commit 之前，
    连接还开着，Windows 上会顺带把临时目录锁住（TemporaryDirectory 清理时报
    WinError 32，掩盖掉真正的失败）。"""
    if path.exists():
        path.unlink()
    conn = sqlite3.connect(str(path))
    try:
        conn.execute("CREATE TABLE projects(project_id TEXT, owner_id TEXT)")
        conn.execute("CREATE TABLE framework_nodes(node_id TEXT, project_id TEXT, name TEXT)")
        conn.execute(
            "CREATE TABLE learning_events(event_id TEXT, project_id TEXT, node_id TEXT, kind TEXT,"
            " correctness REAL, self_confidence REAL, error_type TEXT, reference_id TEXT,"
            " created_at TEXT)"
        )
        conn.execute("INSERT INTO projects VALUES('p1','u1')")
        conn.execute("INSERT INTO framework_nodes VALUES('n1','p1','节点一')")
        for index in range(samples):
            conn.execute(
                "INSERT INTO learning_events VALUES(?, 'p1','n1',?,?,?,NULL,NULL,?)",
                (
                    f"e{index}",
                    kind,
                    actual,
                    self_value,
                    f"2026-09-{10 + (index % 15):02d}T10:00:00",
                ),
            )
        conn.commit()
    finally:
        conn.close()


def verify_calibration() -> None:
    from core import calibration

    section("calibration · 判定口径")
    check("与 mastery_bkt 同源的可验证行为集合", calibration.VERIFIED_KINDS == frozenset({"quiz", "solve", "card", "discuss"}))
    check("question 明确不在可验证集合里", "question" not in calibration.VERIFIED_KINDS)
    check("样本不足一律 thin", calibration.classify(0.9, 0) == "thin")
    check("样本不足时再大的偏差也是 thin", calibration.classify(0.9, calibration.MIN_SAMPLES - 1) == "thin")
    check("刚好够样本才判向", calibration.classify(0.9, calibration.MIN_SAMPLES) == "overconfident")
    check("高估判定", calibration.classify(0.30, 20) == "overconfident")
    check("低估判定", calibration.classify(-0.30, 20) == "underconfident")
    check("小偏差算吻合", calibration.classify(0.05, 20) == "aligned")
    check("偏差恰好压在带上沿算吻合", calibration.classify(calibration.CALIBRATED_BAND, 20) == "aligned")

    # 高估与低估必须给不同的建议 —— CHI 那项研究只对过度自信者有效。
    check(
        "高估与低估的建议文案不同",
        calibration.VERDICT_ADVICE["overconfident"] != calibration.VERDICT_ADVICE["underconfident"],
    )
    check(
        "低估的建议里不再追问把握度",
        "把握" not in calibration.VERDICT_ADVICE["underconfident"],
    )

    section("calibration · 聚合")
    with tempfile.TemporaryDirectory() as tmp:
        db = Path(tmp) / "t.sqlite3"

        _make_db(db, 12, self_value=1.0, actual=0.0)
        over = calibration.report(db, "u1", "p1")
        check("高信心 + 全错 → overconfident", over["verdict"] == "overconfident")
        check("样本数统计正确", over["samples"] == 12)
        check(
            "四格分箱：确定错落 certain_wrong",
            over["bins"]["certain_wrong"] == 12 and over["bins"]["certain_right"] == 0,
        )
        check("高信心错列为证据", over["evidence_total"] == 12)
        check("证据带 node_name", over["evidence"][0]["node_name"] == "节点一")
        check("越过权返回 thin 而不是抛错", calibration.report(db, "别人", "p1")["verdict"] == "thin")

        _make_db(db, 12, self_value=0.0, actual=1.0)
        under = calibration.report(db, "u1", "p1")
        check("没把握 + 全对 → underconfident", under["verdict"] == "underconfident")
        check(
            "四格分箱：不确定对落 unsure_right",
            under["bins"]["unsure_right"] == 12 and under["bins"]["certain_wrong"] == 0,
        )

        _make_db(db, 12, self_value=None, actual=1.0)
        blank = calibration.report(db, "u1", "p1")
        check("没勾把握度不计入样本", blank["samples"] == 0 and blank["verdict"] == "thin")

        _make_db(db, 12, self_value=1.0, actual=1.0, kind="question")
        noverify = calibration.report(db, "u1", "p1")
        check("question 没有对错语义，不计入", noverify["samples"] == 0)
        check("但总事件数照实统计", noverify["total_events"] == 12)

        # 低于地板就是「看不出来」，不能编一个结论出来。
        _make_db(db, 3, self_value=1.0, actual=0.0)
        thin = calibration.report(db, "u1", "p1")
        check("3 条证据不给结论", thin["verdict"] == "thin" and "看不出来" in thin["verdict_label"])


# ── 6. calibration：probe 的选择性 ────────────────────────────────────

def verify_probe() -> None:
    from core import calibration

    section("calibration · probe（不要每题都问）")
    with tempfile.TemporaryDirectory() as tmp:
        db = Path(tmp) / "t.sqlite3"

        _make_db(db, 12, self_value=1.0, actual=0.0)
        over = calibration.report(db, "u1", "p1")
        check(
            "高估但准确率不在中间带 → 不追问",
            over["probe"]["ask"] is False,
            over["probe"]["reason"],
        )

        _make_db(db, 3, self_value=1.0, actual=0.0)
        thin = calibration.report(db, "u1", "p1")
        check("样本不够 → 不追问", thin["probe"]["ask"] is False)
        check("追问理由里带上要攒到多少条", str(calibration.MIN_SAMPLES) in thin["probe"]["reason"])

    # probe 必须自带理由：产品里凡是「不问」的地方都得说清为什么。
    synthetic = {"samples": 40, "verdict": "aligned", "nodes": []}
    quiet = calibration.probe(synthetic)
    check("没有中间带节点 → 不追问", quiet["ask"] is False)
    check("不追问也给理由", bool(quiet["reason"]))
    check(
        "probe 不返回要预测的节点（避免走形式）",
        "node_id" not in quiet and "nodes" not in quiet,
    )


# ── 7. 端点注册 ──────────────────────────────────────────────────────

def verify_endpoints() -> None:
    section("端点注册")
    sys.path.insert(0, str(ROOT / "src"))
    from api_server import create_app

    app = create_app()
    routes = {
        getattr(route, "path", ""): route
        for route in app.routes
        if hasattr(route, "path")
    }

    expected = {
        "/api/coach/{project_id}/round": ["GET"],
        "/api/coach/{project_id}/scaffold": ["GET"],
        "/api/coach/{project_id}/calibration": ["GET"],
    }
    for path, methods in expected.items():
        check(f"{path} 已注册", path in routes, f"现有路由里没有 {path}")
        if path in routes:
            check(
                f"{path} 方法正确",
                sorted(getattr(routes[path], "methods", []) or []) == sorted(methods),
                str(getattr(routes[path], "methods", [])),
            )

    check("OpenAPI 能生成", bool(app.openapi()))

    # 新端点不许挂到 /api/projects/{project_id}/… 前缀下：那个前缀有同段数通配
    # 会互相抢注册（api_server.py 里记过这条坑）。
    for path in routes:
        if path.startswith("/api/coach/"):
            check(f"{path} 未占用 projects 前缀", not path.startswith("/api/projects/"))


# ── 8. 端点实现的口径 ────────────────────────────────────────────────

def verify_endpoint_shape() -> None:
    section("端点实现口径")
    source = (ROOT / "src" / "api_server.py").read_text(encoding="utf-8")

    check("引入两个新模块", "from core import calibration as calibration_mod" in source)
    check("引入 scaffold 模块", "from core import scaffold as scaffold_mod" in source)

    for path in (
        "/api/coach/{project_id}/round",
        "/api/coach/{project_id}/scaffold",
        "/api/coach/{project_id}/calibration",
    ):
        check(f"{path} 走了权限校验", "require_project_access" in source)

    # 只读承诺：新端点里不许出现写表调用。
    block_start = source.find("/api/coach/{project_id}/round")
    check("新端点区段可定位", block_start > 0)
    if block_start > 0:
        block = source[block_start : block_start + 6000]
        for forbidden in ("record_learning_event", "update_node_state", "record_evidence", "INSERT INTO", "UPDATE "):
            check(f"陪练端点只读：不出现 {forbidden}", forbidden not in block)

    # 模块本身不许写库、不许调模型：这两个模块的全部价值就是「纯计算、离线可跑」。
    for name in ("scaffold.py", "calibration.py"):
        text = (ROOT / "src" / "core" / name).read_text(encoding="utf-8")
        code = text.split('"""', 2)[-1]  # 跳过模块 docstring，只看真代码
        check(f"{name} 不 import 任何写库依赖", "from .database" not in code and "import database" not in code)
        check(
            f"{name} 不含 INSERT/UPDATE/DELETE",
            not any(kw in code for kw in ("INSERT INTO", "UPDATE ", "DELETE FROM")),
        )
        check(f"{name} 不碰模型层", "llm" not in code.lower())

    # scaffold 必须真的能被复用：teaching_mode 的 ladder_block 之外留了挂载点。
    from core import scaffold
    check("scaffold 暴露了可拼接的提示词块", callable(scaffold.prompt_block))
    sig = inspect.signature(scaffold.level_for)
    check("level_for 接受 demand 参数", "demand" in sig.parameters)
    check("level_for 的 observations 默认 None（未知≠很少）",
          sig.parameters["observations"].default is None)


# ── 9. 前端标记 ──────────────────────────────────────────────────────

def verify_frontend() -> None:
    section("前端挂载")
    ui = ROOT / "static" / "coach-ui.js"
    check("static/coach-ui.js 存在", ui.exists())
    index = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
    check("index.html 引了 coach-ui.js", "coach-ui.js" in index)
    check("引用带 defer", re_search(r'coach-ui\.js\?v=[^"]+"\s+defer', index))
    check("index.html 加了「陪练」设置组", "settings-coach" in index)

    if not ui.exists():
        return
    text = ui.read_text(encoding="utf-8")

    check("导出 window.KnowOriginCoach", "window.KnowOriginCoach" in text)
    check("挂到概览仪表盘上", "overview-dashboard" in text)
    check("挂载点带唯一标记", "data-ko-coach-embed" in text)
    check("样式自带（不污染既有样式表）", "ko-coach-style" in text)
    check("用 try/catch 读 app.js 的 state", "typeof state" in text)
    check("不声明名为 state 的顶层变量", "var state =" not in text and "let state =" not in text)
    check("字号走主题阶梯而非写死 px", "--text-" in text)
    check("不写死颜色", not re_search(r"#[0-9a-fA-F]{6}\b", text))

    # jsdom 陷阱：app.js + addon 必须拼成一次 eval，所以 addon 只能自己 readyState 判断。
    check("自己判断 readyState 并兜底重试", "DOMContentLoaded" in text and "setTimeout" in text)
    check("MutationObserver 兜底重绘", "MutationObserver" in text)
    check("渲染前 diff，避免自触发重绘循环", "lastMarkup" in text)


def re_search(pattern: str, text: str) -> bool:
    import re

    return bool(re.search(pattern, text))


# ── main ─────────────────────────────────────────────────────────────

def main() -> int:
    verify_ladder()
    verify_guards()
    verify_explain()
    verify_session_shape()
    verify_calibration()
    verify_probe()
    verify_endpoints()
    verify_endpoint_shape()
    verify_frontend()

    print("\n" + "═" * 62)
    total = PASSED + len(FAILED)
    if FAILED:
        print(f"结果：{PASSED}/{total} 通过，{len(FAILED)} 条失败")
        for label in FAILED:
            print(f"  ✗ {label}")
        return 1
    print(f"结果：{PASSED}/{total} 全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())