"""掌握度可信度审计：找出「分数高、但证据薄」的节点。

## 这个模块存在的唯一理由

现有掌握度是**加权累加**（``core/framework.py``）：

    gain = min(weight × correctness × confidence, single_cap)
    new_score = min(1.0, old_score + gain)      # 只加不减，无衰减

而提问（``kind="question"``）**没有对错信息** —— 它走
``MASTERY_DEFAULT_CORRECTNESS["question"] = 0.65``，意思是"你问了一次"就值 0.065 分。
于是（实测推演，见 ``tools/_review_test.py``）：

> 在一个节点上**提问 13 次**，它的 ``mastery_score`` 就到 0.845 → 状态 ``mastered``。
> 从未做过一道题、从未翻过一次卡。

这不一定是坏事 —— 提问确实说明在接触。但它**不等于"学透"**，而界面把它显示成同一个
"已掌握"。这类误判直接伤到产品最核心的承诺（"你是真的学透了"）。

## 为什么只报告、不改分数

改权重（比如把 question 的默认正确度压到 0）会**改动所有既有用户的掌握度曲线** ——
历史分数会与新算法对不上，用户看到自己的进度突然掉了。那是比误判更糟的事。

所以本模块**不碰任何分数**，只把证据结构如实摆出来，让分数可被质疑、可被补验证。
真正该改的是产品语义（把"掌握"拆成"接触过"和"验证过"），那是独立决策。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

# 判定阈值。刻意保守 —— 报得太勤会变成噪音，用户就不看了。
QUESTION_HEAVY_RATIO = 0.7     # 提问占比超过七成 → 以提问为主
THIN_EVIDENCE_MAX = 1          # 有对错的证据 ≤1 条 → 证据偏薄
MASTERED_THRESHOLD = 0.8       # 与 framework.MASTERY_THRESHOLD_MASTERED 对齐




def audit_project(
    path: str | Path,
    owner_id: str,
    project_id: str,
    *,
    limit: int = 200,
) -> dict[str, Any]:
    """审计一个项目里所有知识节点的证据结构。

    只读。``owner_id`` 用于校验项目归属 —— 不属于该用户的项目返回空结果，
    而不是抛错（调用方是「看一眼」的场景，不值得为越权单独造一个错误分支）。
    """
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    try:
        owned = conn.execute(
            "SELECT 1 FROM projects WHERE project_id = ? AND owner_id = ?",
            (project_id, owner_id or ""),
        ).fetchone()
        if owned is None:
            return {"nodes": [], "summary": _empty_summary(), "project_id": project_id}

        node_rows = conn.execute(
            "SELECT node_id, name, mastery_score, learning_status, exam_weight"
            " FROM framework_nodes WHERE project_id = ?"
            " ORDER BY mastery_score DESC, name ASC LIMIT ?",
            (project_id, max(1, int(limit))),
        ).fetchall()

        event_rows = conn.execute(
            "SELECT node_id, kind, correctness FROM learning_events WHERE project_id = ?",
            (project_id,),
        ).fetchall()
    finally:
        conn.close()

    # 按节点聚合证据
    tally: dict[str, dict[str, Any]] = {}
    for row in event_rows:
        node_id = row["node_id"]
        bucket = tally.setdefault(
            node_id, {"kinds": {}, "verified": 0, "unverified": 0, "correct_sum": 0.0}
        )
        kind = row["kind"] or "other"
        bucket["kinds"][kind] = bucket["kinds"].get(kind, 0) + 1
        if row["correctness"] is None:
            bucket["unverified"] += 1
        else:
            bucket["verified"] += 1
            bucket["correct_sum"] += float(row["correctness"])

    nodes: list[dict[str, Any]] = []
    for row in node_rows:
        node_id = row["node_id"]
        bucket = tally.get(node_id)
        entry = _audit_node(
            node_id=node_id,
            name=row["name"] or "",
            mastery=float(row["mastery_score"] or 0.0),
            status=row["learning_status"] or "",
            exam_weight=row["exam_weight"] or "",
            bucket=bucket,
        )
        if entry["flags"]:
            nodes.append(entry)

    nodes.sort(key=lambda item: (-item["mastery_score"], -len(item["flags"])))
    summary = {
        "total_nodes": len(node_rows),
        "flagged_nodes": len(nodes),
        "unverified_mastered": sum(
            1 for item in nodes if item["flag_codes"].get("unverified_mastered")
        ),
        "question_heavy": sum(
            1 for item in nodes if item["flag_codes"].get("question_heavy")
        ),
    }
    return {"nodes": nodes, "summary": summary, "project_id": project_id}


def _empty_summary() -> dict[str, int]:
    return {
        "total_nodes": 0,
        "flagged_nodes": 0,
        "unverified_mastered": 0,
        "question_heavy": 0,
    }


def _audit_node(
    *,
    node_id: str,
    name: str,
    mastery: float,
    status: str,
    exam_weight: str,
    bucket: dict[str, Any] | None,
) -> dict[str, Any]:
    """给单个节点算证据结构 + 打标。"""
    kinds: dict[str, int] = dict(bucket["kinds"]) if bucket else {}
    verified = int(bucket["verified"]) if bucket else 0
    unverified = int(bucket["unverified"]) if bucket else 0
    total = verified + unverified
    correct_avg = (
        round(float(bucket["correct_sum"]) / verified, 3) if bucket and verified else None
    )
    question_count = int(kinds.get("question", 0))
    question_ratio = (question_count / total) if total else 0.0

    flags: list[dict[str, str]] = []
    flag_codes: dict[str, bool] = {}

    # ① 最刺眼的一种：分数已经"已掌握"，却没有任何带对错的证据
    if mastery >= MASTERED_THRESHOLD and verified == 0:
        flag_codes["unverified_mastered"] = True
        flags.append(
            {
                "code": "unverified_mastered",
                "label": "高分未经验证",
                "detail": (
                    f"掌握度 {round(mastery * 100)}% 全部来自"
                    f"{'提问' if question_count else '接触'}（{total} 次），"
                    "没有做过题、没有翻过卡。建议出一道题确认一下。"
                ),
            }
        )

    # ② 提问占绝对多数 —— 可能是在问答案，而不是在学
    if total >= 4 and question_ratio >= QUESTION_HEAVY_RATIO and verified <= THIN_EVIDENCE_MAX:
        flag_codes["question_heavy"] = True
        flags.append(
            {
                "code": "question_heavy",
                "label": "以提问为主",
                "detail": (
                    f"{total} 次记录里 {question_count} 次是提问"
                    f"（{round(question_ratio * 100)}%），"
                    "带对错的验证只有 "
                    f"{verified} 次。问得多不等于会做。"
                ),
            }
        )

    # ③ 有分但样本太少 —— 提醒结论不可靠，不是错误
    if verified and verified <= THIN_EVIDENCE_MAX and mastery >= 0.35:
        flag_codes["thin_evidence"] = True
        flags.append(
            {
                "code": "thin_evidence",
                "label": "证据偏薄",
                "detail": f"只有 {verified} 条带对错的证据，这个分数还不够稳。",
            }
        )

    return {
        "node_id": node_id,
        "name": name,
        "mastery_score": round(mastery, 3),
        "mastery_percent": round(mastery * 100),
        "learning_status": status,
        "exam_weight": exam_weight,
        "evidence_total": total,
        "verified_count": verified,
        "unverified_count": unverified,
        "question_count": question_count,
        "question_ratio": round(question_ratio, 3),
        "verified_ratio": round((verified / total) if total else 0.0, 3),
        "correctness_avg": correct_avg,
        "kinds": kinds,
        "flags": flags,
        "flag_codes": flag_codes,
    }

