"""对真实 data/knoworigin.sqlite3 跑一遍陪练台的全部只读查询。

为什么要有这个：``verify_coach_regression.py`` 用的是自造的最小库，它能证明
判据对不对，但证明不了**真库的列名对得上**。这里拿真库跑一遍，把
schema 漂移（比如 framework_nodes 叫 name 还是 node_name、learning_events
有没有 self_confidence）当场抓住。

跑法：``python tools/verify_coach_real_db.py``（不传参时自动挑第一个项目）
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from core import calibration, progress_engine, scaffold  # noqa: E402

DB = ROOT / "data" / "knoworigin.sqlite3"

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


def columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


# ── 10. 端到端 HTTP ─────────────────────────────────────────────────

def verify_http() -> None:
    """真正跑一遍 HTTP：注册 → 建项目 → 灌事件 → 三个端点 → 越权。

    上面几节验的是判据，这一节验的是**整条链路**：require_project_access、
    asyncio.to_thread、响应形状、以及「只读」这条承诺在真跑之后仍然成立
    （跑之前后各数一遍事件条数）。
    """
    import tempfile

    from fastapi.testclient import TestClient

    from api_server import create_app
    from config import Settings
    from core.database import Database

    print("\n── 端到端 HTTP ──")
    # 故意不给 key：陪练台三个端点都不调模型，这样本节不依赖网络与凭据。
    tmp = Path(tempfile.mkdtemp(prefix="knoworigin-coach-http-"))
    settings = Settings(
        tju_api_key="",
        tju_base_url="https://example.invalid/api",
        tju_model="tju-llm",
        data_dir=tmp,
        usage_tracking_enabled=False,
    )
    db = Database(tmp / "verify.sqlite3")
    client = TestClient(create_app(db, settings))

    client.post(
        "/api/auth/register",
        json={"email": "coach@e.com", "password": "abcd1234", "name": "C"},
    )
    pid = client.post("/api/projects", json={"year": "2026", "subject": "陪练"}).json()[
        "project_id"
    ]

    # 空项目也要能用：不该因为没有节点就 500。
    empty = client.get(f"/api/coach/{pid}/round")
    check("空项目的 round 是 200", empty.status_code == 200, empty.text[:200])
    body = empty.json()
    check("空项目返回形状完整", {"steps", "scaffold", "calibration", "shape", "ladder"} <= set(body))
    check("空项目没有步骤", not body["steps"])
    check("空项目的支架如实说不可用", body["scaffold"].get("available") is False)
    check("空项目也有时间盒", body["shape"]["work_minutes"] > 0)

    calib = client.get(f"/api/coach/{pid}/calibration")
    check("空项目的 calibration 是 200", calib.status_code == 200, calib.text[:200])
    check("空项目判定为样本不足", calib.json()["verdict"] == "thin")

    no_node = client.get(f"/api/coach/{pid}/scaffold")
    check("scaffold 缺 node_id 报 400", no_node.status_code == 400, no_node.text[:160])
    check("400 用的是既有 error_payload 形状", (no_node.json().get("detail") or {}).get("code") == "node_id_required")

    ghost = client.get(f"/api/coach/{pid}/scaffold?node_id=不存在的节点")
    check("不存在的节点不报错", ghost.status_code == 200, ghost.text[:160])
    check("如实说 available=False", ghost.json().get("available") is False)

    # 灌节点与事件：确认端点在**有数据**时给出真结论，且全程只读。
    # 走 Database 自己的方法而不是裸 SQL —— 裸 INSERT 要手填六个 NOT NULL 列，
    # 而 schema 一改就会在测试里炸出一个跟陪练台无关的 IntegrityError。
    node = db.add_framework_node(pid, name="傅里叶变换", description="把信号拆成频率分量")
    nid = node.node_id
    # 9 条：7 对 2 错，全都自评「我确定」。9 > MIN_SAMPLES(8) 才够出结论；
    # 缺口 = 1.0 - 7/9 = 0.222 ≥ OVERCONFIDENT_GAP(0.20) → 高估。
    # 刻意用这个非整除的组合：如果哪天有人把 MIN_SAMPLES 改成 9，
    # 分箱与缺口这两条断言会立刻替我们抓住。
    for index in range(9):
        db.record_learning_event(
            pid,
            nid,
            "quiz",
            0.0 if index >= 7 else 1.0,
            0.95,
            self_confidence=1.0,
        )
    # 事件表要有个 created_at 差异才有「最近走向」，上面 record 用的是当前时间，
    # 天然就聚在同一段窗口里 —— 这里补一条早的，验证两段窗口都出得来。
    conn2 = db._conn
    conn2.execute(
        "UPDATE learning_events SET created_at = '2020-01-0%d T10:00:00'"
        " WHERE event_id IN (SELECT event_id FROM learning_events"
        " ORDER BY created_at ASC LIMIT 1)" % 1
    )
    conn2.commit()

    def event_count() -> int:
        return int(db._conn.execute("SELECT COUNT(*) FROM learning_events").fetchone()[0])

    def node_snapshot() -> tuple:
        row = db._conn.execute(
            "SELECT mastery_score, learning_status FROM framework_nodes WHERE node_id = ?",
            (nid,),
        ).fetchone()
        return (round(float(row[0]), 6), str(row[1]))

    before_events = event_count()
    before_node = node_snapshot()

    scaf = client.get(f"/api/coach/{pid}/scaffold?node_id={nid}")
    check("有数据的 scaffold 是 200", scaf.status_code == 200, scaf.text[:200])
    info = scaf.json()
    check("available=True", info.get("available") is True)
    check("给出档位", info.get("level") in ("full", "faded", "outline", "hint", "silent"), str(info.get("level")))
    check("给出中文标签", bool(info.get("label")))
    check("给出理由", bool(info.get("reasons")))
    check("拼好了提示词块", "支架强度" in str(info.get("prompt_block")))
    check("带位阶标签", bool(info.get("stage_label")))
    check("带梯子下标", isinstance(info.get("ladder_index"), int))
    check("节点名被带进提示词块", "傅里叶变换" in str(info.get("prompt_block")))

    hard = client.get(f"/api/coach/{pid}/scaffold?node_id={nid}&demand=hard").json()
    check("demand=hard 生效", hard.get("demand") == "hard")
    check("换情境时提示词块带新情境说明", "新情境题" in str(hard.get("prompt_block")))

    real = client.get(f"/api/coach/{pid}/calibration")
    check("有数据的 calibration 是 200", real.status_code == 200, real.text[:200])
    rep = real.json()
    check("9 条里 7 对 2 错且全有信心 → 高估", rep["verdict"] == "overconfident", str(rep["verdict"]))
    check("四格分箱落 certain_right / certain_wrong",
          rep["bins"]["certain_right"] == 7 and rep["bins"]["certain_wrong"] == 2, str(rep["bins"]))
    check("2 条「有把握但错」进证据列表", rep["evidence_total"] == 2, str(rep["evidence_total"]))
    check("带最近走向", "trend" in rep and isinstance(rep["trend"].get("windows"), list))

    round_full = client.get(f"/api/coach/{pid}/round")
    check("有数据的 round 是 200", round_full.status_code == 200, round_full.text[:200])
    rb = round_full.json()
    check("round 带 ladder 全五档供前端画刻度", len(rb.get("ladder") or []) == 5)
    check("round 带 ladder_labels", len(rb.get("ladder_labels") or {}) == 5)
    check("时间盒只给分钟数", "work_minutes" in rb["shape"] and "due_cards" not in rb["shape"])
    check("时间盒文案含分钟", "分钟" in str(rb["shape"]["phrasing"]))

    check("三个端点跑完没有新增事件", event_count() == before_events, f"{before_events} -> {event_count()}")
    check("节点分数与状态没被动过", node_snapshot() == before_node, str(node_snapshot()))

    # 越权：另一个账号拿别人的项目必须 401/404，而不是把数据端出去。
    other = TestClient(create_app(Database(tmp / "other.sqlite3"), settings))
    other.post(
        "/api/auth/register",
        json={"email": "other@e.com", "password": "abcd1234", "name": "O"},
    )
    check(
        "越权访问 round 被挡",
        other.get(f"/api/coach/{pid}/round").status_code in (401, 404),
        str(other.get(f"/api/coach/{pid}/round").status_code),
    )

    # 未登录
    anon = TestClient(create_app(Database(tmp / "anon.sqlite3"), settings))
    check("未登录访问被挡", anon.get(f"/api/coach/{pid}/round").status_code in (401, 404))

    print(f"     事件数 {before_events} -> {event_count()}（应相等）")


def main() -> int:
    if not DB.exists():
        print(f"[SKIP] 真库不存在：{DB}")
        return 0

    conn = sqlite3.connect(str(DB))
    conn.row_factory = sqlite3.Row
    try:
        print("── schema 前置 ──")
        project_cols = columns(conn, "projects")
        event_cols = columns(conn, "learning_events")
        node_cols = columns(conn, "framework_nodes")

        check("projects 有 owner_id", "owner_id" in project_cols)
        check("learning_events 有 self_confidence", "self_confidence" in event_cols)
        check("learning_events 有 correctness", "correctness" in event_cols)
        check("learning_events 有 error_type", "error_type" in event_cols)
        check("framework_nodes 有 node_id / project_id", {"node_id", "project_id"} <= node_cols)

        project = conn.execute(
            "SELECT project_id, owner_id, subject FROM projects LIMIT 1"
        ).fetchone()
        if project is None:
            print("[SKIP] 真库里还没有项目")
            return 0
        pid = str(project["project_id"])
        oid = str(project["owner_id"])
        print(f"     项目 {project['subject']!r} / {pid} / 属主 {oid}")

        print("\n── calibration.report（真库） ──")
        report = calibration.report(DB, oid, pid)
        check("返回带 verdict", str(report.get("verdict")) in calibration.VERDICTS, str(report.get("verdict")))
        check("samples 是不负整数", int(report.get("samples") or 0) >= 0)
        check(
            "四格分箱加起来等于样本数",
            sum(report["bins"].values()) == report["samples"],
            f"{report['bins']} vs {report['samples']}",
        )
        check("nodes 不超过 12 条", len(report["nodes"]) <= 12)
        check("probe 一定给得出理由", bool((report.get("probe") or {}).get("reason")))
        check(
            "evidence 里 node_id 都在 nodes 里或至少非空",
            all(str(item.get("node_id") or "") for item in report["evidence"]),
        )
        # 判定与样本量必须自洽：thin 只能出现在样本不足时。
        if report["verdict"] == "thin":
            check("thin 时样本确实不够", report["samples"] < calibration.MIN_SAMPLES)
        else:
            check("非 thin 时样本确实够", report["samples"] >= calibration.MIN_SAMPLES)

        print(f"     verdict={report['verdict']} samples={report['samples']} "
              f"total_events={report['total_events']} bins={report['bins']}")

        print("\n── calibration.recent_predictions（真库） ──")
        trend = calibration.recent_predictions(DB, oid, pid, days=30)
        check("返回 windows 列表", isinstance(trend.get("windows"), list))
        check("每段都带 label / samples / verdict",
              all({"label", "samples", "verdict"} <= set(w) for w in trend["windows"]))
        check("days 被夹在 1..180", 1 <= int(trend.get("days") or 0) <= 180)

        print("\n── 越权 ──")
        check("别人的 owner_id 拿不到结论", calibration.report(DB, "__nobody__", pid)["verdict"] == "thin")
        check("不存在的项目也不抛错", calibration.report(DB, oid, "__nope__")["verdict"] == "thin")

        print("\n── progress_engine._load + scaffold（真库） ──")
        loaded = progress_engine._load(DB, oid, pid)
        check("_load 能读出节点", loaded is not None and bool(loaded.nodes))
        if loaded is None or not loaded.nodes:
            print("[SKIP] 该项目没有框架节点")
            return 0

        # 全节点跑一遍：任何节点都不能让 scaffold 抛异常或落到梯子之外。
        levels: dict[str, int] = {}
        for node_id in loaded.nodes:
            stage = loaded.stage_of(node_id)
            bkt = loaded.bkt_of(node_id)
            obs = len(loaded.verified_observations(node_id))
            for demand in ("normal", "hard"):
                decided = scaffold.explain(bkt, stage, observations=obs, demand=demand)
                if decided["level"] not in scaffold.SCAFFOLD_LADDER:
                    check(f"节点 {node_id} 的 demand={demand} 落在梯子内", False, decided["level"])
                    break
                if demand == "normal":
                    levels[decided["level"]] = levels.get(decided["level"], 0) + 1
                if demand == "normal" and not (decided["reasons"] or [None]):
                    check(f"节点 {node_id} 给得出理由", False)
                    break
        else:
            check(f"全部 {len(loaded.nodes)} 个节点都算得动且落在梯子内", True)

        # 守卫 1 必须真的拦得住：这个项目里只要有 none/seen 节点，就不该出现 silent。
        novice_ids = [n for n in loaded.nodes if loaded.stage_of(n) in ("none", "seen")]
        novice_silent = [
            n for n in novice_ids
            if scaffold.level_for(loaded.bkt_of(n), loaded.stage_of(n), demand="normal")["level"] == "silent"
        ]
        check(
            f"新手（{len(novice_ids)} 个）没有拿到「不给提示」",
            not novice_silent,
            f"{len(novice_silent)} 个漏网",
        )

        # 证据薄的节点不该拿到 silent。
        thin_ids = [n for n in loaded.nodes if len(loaded.verified_observations(n)) <= 1]
        thin_silent = [
            n for n in thin_ids
            if scaffold.level_for(
                loaded.bkt_of(n), loaded.stage_of(n),
                observations=len(loaded.verified_observations(n)),
            )["level"] == "silent"
        ]
        check(
            f"证据薄（{len(thin_ids)} 个）没有拿到「不给提示」",
            not thin_silent,
            f"{len(thin_silent)} 个漏网",
        )

        # hard 只能在 normal 基础上加支架，不能减。
        weakened = []
        for node_id in loaded.nodes:
            stage = loaded.stage_of(node_id)
            bkt = loaded.bkt_of(node_id)
            obs = len(loaded.verified_observations(node_id))
            normal = scaffold.level_for(bkt, stage, observations=obs, demand="normal")
            hard = scaffold.level_for(bkt, stage, observations=obs, demand="hard")
            if scaffold.SCAFFOLD_LADDER.index(hard["level"]) < scaffold.SCAFFOLD_LADDER.index(normal["level"]):
                weakened.append(node_id)
        check("换情境只会加支架、从不减", not weakened, f"{len(weakened)} 个反了")

        print(f"     档位分布：{levels}")
    finally:
        conn.close()

    verify_http()

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