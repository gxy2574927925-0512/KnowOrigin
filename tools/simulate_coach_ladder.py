"""沙盘：在真库的**副本**上模拟「做了题之后梯子会怎么动」。

不改你的真数据（整份库复制到临时目录再操作）。目的是回答一个问题：
**「我照着做，会不会真的看到档位变化？」**

跑法：``python tools/simulate_coach_ladder.py``
"""

from __future__ import annotations

import shutil
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from core import progress_engine, scaffold  # noqa: E402

SRC_DB = ROOT / "data" / "knoworigin.sqlite3"


def pick_project() -> tuple[str, str, str] | None:
    """挑节点最多的那个项目 —— 它最有可能已经有可动梯子的样本。"""
    conn = sqlite3.connect(str(SRC_DB))
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT p.project_id, p.owner_id, p.subject FROM projects p"
        "  JOIN framework_nodes n ON n.project_id = p.project_id"
        " GROUP BY p.project_id ORDER BY COUNT(n.node_id) DESC LIMIT 1"
    ).fetchone()
    conn.close()
    if row is None:
        return None
    return str(row["project_id"]), str(row["owner_id"]), str(row["subject"] or "")


def ladder_of(loaded, node_id: str) -> tuple[str, str, int, float]:
    stage = loaded.stage_of(node_id)
    obs = len(loaded.verified_observations(node_id))
    bkt = loaded.bkt_of(node_id)
    return scaffold.level_for(bkt, stage, observations=obs)["level"], stage, obs, bkt


def main() -> int:
    if not SRC_DB.exists():
        print(f"找不到 {SRC_DB}")
        return 1

    picked = pick_project()
    if picked is None:
        print("真库里还没有带框架节点的项目")
        return 1
    pid, oid, subject = picked

    tmp = Path(tempfile.mkdtemp(prefix="knoworigin-coach-sim-"))
    sim = tmp / "sim.sqlite3"
    shutil.copy2(SRC_DB, sim)
    print(f"沙盘库：{sim}")
    print(f"项目：「{subject}」\n")

    def reload():
        return progress_engine._load(sim, oid, pid)

    loaded = reload()
    if loaded is None or not loaded.nodes:
        print("该项目读不出节点")
        return 1

    # 挑一个节点：优先挑已有最多观测的（最能看出变化），否则挑第一个。
    ranked = sorted(
        loaded.nodes,
        key=lambda n: -len(loaded.verified_observations(n)),
    )
    target = ranked[0]
    node_id = target if isinstance(target, str) else target
    name = loaded.nodes[node_id].get("name") or node_id

    before_level, before_stage, before_obs, before_bkt = ladder_of(loaded, node_id)
    print(f"挑这个节点来看：{name}")
    print(f"  现在：档位={scaffold.SCAFFOLD_LABELS[before_level]}  位阶={before_stage}  "
          f"可验证证据={before_obs} 条  BKT={before_bkt:.3f}\n")

    conn = sqlite3.connect(str(sim))
    now = datetime.now(timezone.utc)

    def add(correctness: float, *, self_conf: float | None, days_ago: int) -> None:
        when = now - timedelta(days=days_ago)
        conn.execute(
            "INSERT INTO learning_events(event_id, project_id, node_id, kind, correctness,"
            " confidence, self_confidence, created_at)"
            " VALUES(?, ?, ?, 'quiz', ?, 0.95, ?, ?)",
            (
                f"sim_{conn.execute('SELECT COUNT(*) FROM learning_events').fetchone()[0]}",
                pid,
                node_id,
                correctness,
                self_conf,
                when.isoformat(),
            ),
        )

    print("照着做 → 档位变化（每一步都是「再对一道题」）：\n")
    print(f"  {'步':<4}{'动作':<28}{'档位':<14}{'位阶':<8}{'证据':<6}BKT")
    print("  " + "─" * 78)

    for step in range(1, 9):
        add(1.0, self_conf=1.0, days_ago=10 - step)
        conn.commit()
        loaded = reload()
        level, stage, obs, bkt = ladder_of(loaded, node_id)
        mark = "  ← 动了" if level != before_level and step == 1 else ""
        if level != scaffold.SCAFFOLD_LADDER[-1] and scaffold.SCAFFOLD_LADDER.index(
            level
        ) > scaffold.SCAFFOLD_LADDER.index(
            {"full": "full", "faded": "faded", "outline": "outline", "hint": "hint", "silent": "silent"}[level if level == level else before_level]
        ):
            mark = ""
        print(
            f"  {step:<4}{'对一道 quiz（勾我确定）':<26}"
            f"{scaffold.SCAFFOLD_LABELS[level]:<12}{stage:<8}{obs:<6}{bkt:.3f}{mark}"
        )

    loaded = reload()
    final_level, final_stage, final_obs, final_bkt = ladder_of(loaded, node_id)
    decided = scaffold.explain(final_bkt, final_stage, observations=final_obs)

    print("\n最终面板上会写：")
    print(f"  档位：{scaffold.SCAFFOLD_LABELS[final_level]}")
    for reason in decided["reasons"]:
        print(f"    · {reason}")
    if decided["withhold_reason"]:
        print(f"  撤回资格：{decided['withhold_reason']}")
    elif decided["next_label"]:
        print(f"  撤回资格：够格再往前一档 →「{decided['next_label']}」")

    print("\n然后做错 1 道（注意观察）：")
    add(0.0, self_conf=1.0, days_ago=0)
    conn.commit()
    loaded = reload()
    down_level, down_stage, down_obs, down_bkt = ladder_of(loaded, node_id)
    print(f"  档位：{scaffold.SCAFFOLD_LABELS[before_level]} → {scaffold.SCAFFOLD_LABELS[down_level]}"
          f"   位阶={down_stage}  BKT {final_bkt:.3f} → {down_bkt:.3f}")

    print("\n校准面板（顺手勾「我确定」攒满 8 条后）：")
    from core import calibration

    report = calibration.report(sim, oid, pid)
    print(f"  判定：{report['verdict_label']}（样本 {report['samples']} 条）")
    print(f"  建议：{report['advice']}")
    print(f"  追问：{'要' if report['probe']['ask'] else '不要'} —— {report['probe']['reason']}")
    if report["bins"]["certain_wrong"]:
        print(f"  「说有把握但答错」：{report['bins']['certain_wrong']} 条")

    print("\n时间盒（照第 4 块看）：")
    print(f"  {scaffold.shape_session(3)['phrasing']}")

    conn.close()
    shutil.rmtree(tmp, ignore_errors=True)
    print("\n（沙盘库已删除，你的 data/knoworigin.sqlite3 全程只读）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())