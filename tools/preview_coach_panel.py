"""预演：拿真库算出「你打开陪练台会看到什么」。

这个脚本不改任何数据，只读。目的是在手动验证之前先把预期说清楚 ——
否则你打开面板看到「19 个节点全是给完整例题」会以为功能没生效，
而那其实是数据本来就薄、守卫在正确地拦着。

跑法：``python tools/preview_coach_panel.py``
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from core import progress_engine, scaffold  # noqa: E402

DB = ROOT / "data" / "knoworigin.sqlite3"


def main() -> int:
    if not DB.exists():
        print(f"找不到 {DB}")
        return 1

    conn = sqlite3.connect(str(DB))
    conn.row_factory = sqlite3.Row
    projects = conn.execute(
        "SELECT project_id, owner_id, subject, year FROM projects"
        " ORDER BY created_at ASC"
    ).fetchall()
    conn.close()

    print(f"共 {len(projects)} 个项目。逐个算一遍陪练台会给出什么：\n")

    total_ladder = 0
    for project in projects:
        pid = str(project["project_id"])
        oid = str(project["owner_id"])
        title = f"{project['year'] or ''} {project['subject'] or ''}".strip() or pid

        loaded = progress_engine._load(DB, oid, pid)
        if loaded is None or not loaded.nodes:
            print(f"▸ {title}")
            print("    还没有知识框架节点 → 陪练台会显示「还没有可推的节点」")
            print("    （先导入资料并生成框架，第 1 步）\n")
            continue

        ladder = {key: 0 for key in scaffold.SCAFFOLD_LADDER}
        verdict_hint = []
        for node_id in loaded.nodes:
            stage = loaded.stage_of(node_id)
            bkt = loaded.bkt_of(node_id)
            obs = len(loaded.verified_observations(node_id))
            decided = scaffold.level_for(bkt, stage, observations=obs)
            ladder[decided["level"]] += 1
            if decided["notes"]:
                verdict_hint.append(decided["notes"][0])

        shaped = ", ".join(
            f"{scaffold.SCAFFOLD_LABELS[key]} ×{count}"
            for key, count in ladder.items()
            if count
        )
        total_ladder += 1
        print(f"▸ {title}  （{len(loaded.nodes)} 个节点）")
        print(f"    档位分布：{shaped}")
        if verdict_hint:
            uniq = sorted(set(verdict_hint))
            for note in uniq[:2]:
                print(f"    守卫在说：{note}")
        print()

    print("=" * 66)
    print("怎么让梯子动起来（手动验证的正确路径）：")
    print()
    print("  梯子只看一个量：BKT 后验。它由带对错信息的作答驱动 ——")
    print("  quiz / solve / card / discuss（question 不算，它没有对错）。")
    print()
    print("  所以最快的验证顺序是：")
    print("    1. 对同一个节点连续做对 3~4 道题   → BKT 上行，档位往下走")
    print("    2. 做错 1~2 道                   → BKT 下行，档位回到给完整例题")
    print("    3. 顺手勾「我确定」               → 攒够 8 条后校准结论才会出现")
    print()
    print("  注意两个数字门槛（都在数据够时才跨得过去）：")
    print("    · 位阶要到 get/hold 才可能落到「只点第1步」或「不给提示」")
    print("      （守卫 1：没到「会了」就不撤支架）")
    print("    · 校准结论要 8 条带把握度的作答，低于这个数一律说「还看不出来」")
    print()
    print("  最容易误判的一点：做完题后位阶可能仍是「见过」，")
    print("  于是即使 BKT 已经很高，档位也只会停在「给半程例题」而不是「不给提示」。")
    print("  这是守卫 1 在起作用，不是坏了 —— 面板上会写明「位阶还不到『会了』，先不撤」。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
