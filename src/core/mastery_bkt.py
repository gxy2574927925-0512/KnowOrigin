"""贝叶斯知识追踪（BKT）：给「掌握度」一个会区分「猜对」和「真会」的参照。

## 这个模块存在的理由

现有掌握度是**加权累加**（``core/framework.py``）：只加不减、无衰减，且提问
（``kind="question"``）没有对错信息，靠 ``MASTERY_DEFAULT_CORRECTNESS["question"] = 0.65``
记分。于是「提问 13 次」就能把节点推到 ``mastered``（已由
``tools/_review_test.py::test_question_only_accumulates_mastery`` 钉住）。

``core/mastery_audit.py`` 已经把这个问题**量化并报告**出来了，但它回答不了
"那到底是多少" —— 它只能说"证据薄"。

BKT 能回答，而且代价极低。它是教育数据挖掘里 20 年来的标准做法（Corbett & Anderson, 1995），
只需要 4 个参数：

    p_l0  初始掌握概率 —— 还没观察时，猜他会的概率
    p_t   学习转移率   —— 每次练习后"从不会变成会"的概率
    p_s   失误率 slip  —— 真会但答错的概率
    p_g   猜对率 guess —— **不会但答对的概率**

``p_g`` 就是这里的关键：**正确答案在高 ``p_g`` 下不足以证明掌握**。这正是加权累加
模型缺的那块 —— 它把"答对"直接当成"会了"（correctness=1.0 → 拿满权重）。

## 为什么不动既有分数

与 ``mastery_audit`` 同一立场：改口径会让**所有既有用户**的历史曲线对不上，
比误判本身更糟。所以这里只做**并排展示** —— 传统分照旧，BKT 作为第二个参照，
两者的差距本身就是最有价值的信号：

    weighted 高、BKT 低  →  分数可能是"问"出来的，不是"会"出来的

## 实现口径

* **纯 Python 手写**，不引 numpy / sklearn / torch —— 与 ``requirements.txt`` 的轻量口径一致，
  而且几十行代码完全可读，符合产品"掌握度算法透明可解释"的既有承诺。
* 每个节点独立跑一条链（不做跨节点参数共享），因为节点之间没有可用的先验关系。
* 参数用文献常用经验值，**不做 EM 估计** —— 参数拟合需要每节点几十条观测，
  现在绝大多数节点的观测数远达不到，硬拟合只会过拟合噪声。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any, Sequence

# 文献里的常用经验值（Corbett & Anderson 原始设定附近）。
# p_g=0.25 偏高是刻意的：四选一选择题的盲猜基线就是 0.25，
# 宁可比真实掌握略保守，也不要重复"猜对算会"的错。
DEFAULT_PARAMS: dict[str, float] = {
    "p_l0": 0.20,
    "p_t": 0.18,
    "p_s": 0.10,
    "p_g": 0.25,
}

PARAM_LABELS: dict[str, str] = {
    "p_l0": "初始掌握",
    "p_t": "学习转移",
    "p_s": "失误率",
    "p_g": "猜对率",
}

# 学习转移只在**答对**时施加（pyBKT 里的 learn-on-correct 变体）。
#
# 教科书版 BKT 在每次练习机会后都施加 p_t，包括答错的时候。但那样会得到一个
# 反直觉的结果：**连续答错 6 次，掌握概率反而从先验 0.20 涨到 0.21** ——
# 因为转移项 (1-p)×p_t 把后验又拉回去了。上线前实测过这个曲线，界面上会显得像 bug。
#
# 产品语义上"答错 = 更可能没掌握"，所以这里采用 learn-on-correct 变体：
# 答错只更新后验（下降），不附加学习增益。代价是与教科书版数值不同，
# 因此 `mastery_bkt` 的结论只用于**并排参照**，绝不写回既有分数。
LEARN_ON_CORRECT_ONLY = True

# 正确率 < 0.5 记为"答错"。与 framework 里 card 自评的 0.55 中位映射一致。
CORRECT_THRESHOLD = 0.5

# 只有带对错信息的 kind 才能当观测。question 没有对错 → 不计入观测，单独计数。
VERIFIED_KINDS = frozenset({"quiz", "solve", "card", "discuss"})

MASTERED_THRESHOLD = 0.8   # 与 framework.MASTERY_THRESHOLD_MASTERED 对齐
DISAGREE_BKT = 0.6         # 传统分说"掌握"、BKT 却低于此值 → 值得看一眼
QUESTION_HEAVY_RATIO = 0.7
THIN_VERIFIED_MAX = 1

_TRAJECTORY_KEEP = 12      # 只回最近若干点，避免把长历史全塞进响应


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def bkt_chain(
    observations: Sequence[bool],
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """对单条观测序列跑 BKT，返回最终掌握概率与轨迹。

    观测顺序 = 时间顺序，**顺序会影响结果**（这正是 BKT 比加权累加多出来的信息：
    先错后对比先对后错更"学到了"）。
    """
    merged = dict(DEFAULT_PARAMS)
    for key, value in (params or {}).items():
        if key in merged:
            try:
                merged[key] = _clamp(float(value))
            except (TypeError, ValueError):
                continue

    p_l0, p_t = merged["p_l0"], merged["p_t"]
    p_s, p_g = _clamp(merged["p_s"], 0.0, 0.49), _clamp(merged["p_g"], 0.0, 0.99)

    prior = p_l0
    trajectory: list[float] = []
    for obs in observations:
        if obs:
            num = prior * (1.0 - p_s)
            den = num + (1.0 - prior) * p_g
        else:
            num = prior * p_s
            den = num + (1.0 - prior) * (1.0 - p_g)
        posterior = (num / den) if den > 1e-12 else prior
        if LEARN_ON_CORRECT_ONLY and not obs:
            # 答错：只保留后验（下降），不施加学习增益 —— 见 LEARN_ON_CORRECT_ONLY 的说明。
            prior = _clamp(posterior)
        else:
            prior = _clamp(posterior + (1.0 - posterior) * p_t)
        trajectory.append(round(prior, 4))

    total = len(observations)
    correct = sum(1 for obs in observations if obs)
    return {
        "mastery": round(prior, 4),
        "observations": total,
        "correct": correct,
        "trajectory": trajectory[-_TRAJECTORY_KEEP:],
        "params": {key: round(val, 4) for key, val in merged.items()},
        # 一条观测都没有时不该假装有结论
        "is_prior_only": total == 0,
    }


def _flag_codes(
    *,
    weighted: float,
    bkt_value: float,
    total_events: int,
    verified: int,
    question_count: int,
) -> dict[str, bool]:
    ratio = (question_count / total_events) if total_events else 0.0
    return {
        # 最值得看的一条：传统分说"掌握"，BKT 说没到
        "bkt_disagrees": weighted >= MASTERED_THRESHOLD and bkt_value < DISAGREE_BKT,
        "question_heavy": ratio >= QUESTION_HEAVY_RATIO and verified <= 2,
        "thin_evidence": total_events >= 3 and verified <= THIN_VERIFIED_MAX,
    }


_FLAG_LABELS: dict[str, str] = {
    "bkt_disagrees": "分数说掌握、BKT 说没到",
    "question_heavy": "以提问为主",
    "thin_evidence": "可验证证据偏薄",
}


def bkt_project(
    path: str | Path,
    owner_id: str,
    project_id: str,
    *,
    limit: int = 300,
) -> dict[str, Any]:
    """按节点给出「加权分 vs BKT」并排视图。

    只读，不写任何表、不改任何分数。``owner_id`` 校验项目归属，越权返回空结果
    而不是抛错（与 ``mastery_audit.audit_project`` 同一取舍）。
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
            "SELECT node_id, name, mastery_score, learning_status"
            " FROM framework_nodes WHERE project_id = ?"
            " ORDER BY mastery_score DESC, name ASC LIMIT ?",
            (project_id, max(1, int(limit))),
        ).fetchall()

        # 按时间升序取，顺序对 BKT 是有意义的输入
        event_rows = conn.execute(
            "SELECT node_id, kind, correctness, created_at FROM learning_events"
            " WHERE project_id = ? ORDER BY created_at ASC, event_id ASC",
            (project_id,),
        ).fetchall()
    finally:
        conn.close()

    tally: dict[str, dict[str, Any]] = {}
    for row in event_rows:
        bucket = tally.setdefault(
            row["node_id"], {"observations": [], "question": 0, "verified": 0}
        )
        kind = row["kind"] or "other"
        raw = row["correctness"]
        if raw is None or kind not in VERIFIED_KINDS:
            if kind == "question":
                bucket["question"] += 1
            continue
        bucket["verified"] += 1
        bucket["observations"].append(float(raw) >= CORRECT_THRESHOLD)

    nodes: list[dict[str, Any]] = []
    for row in node_rows:
        node_id = row["node_id"]
        bucket = tally.get(node_id) or {"observations": [], "question": 0, "verified": 0}
        weighted = float(row["mastery_score"] or 0.0)
        result = bkt_chain(bucket["observations"])
        total_events = len(bucket["observations"]) + bucket["question"]
        flags = _flag_codes(
            weighted=weighted,
            bkt_value=result["mastery"],
            total_events=total_events,
            verified=bucket["verified"],
            question_count=bucket["question"],
        )
        flag_labels = [_FLAG_LABELS[key] for key, hit in flags.items() if hit]
        nodes.append(
            {
                "node_id": node_id,
                "name": row["name"] or "",
                "status": row["learning_status"] or "",
                "weighted": round(weighted, 4),
                "bkt": result["mastery"],
                "gap": round(weighted - result["mastery"], 4),
                "observations": result["observations"],
                "correct": result["correct"],
                "question_count": bucket["question"],
                "trajectory": result["trajectory"],
                "is_prior_only": result["is_prior_only"],
                "flags": flag_labels,
                "flag_codes": flags,
            }
        )

    nodes.sort(key=lambda item: (-item["gap"], -item["weighted"]))
    summary = {
        "total_nodes": len(node_rows),
        "flagged_nodes": sum(1 for item in nodes if item["flags"]),
        "bkt_disagrees": sum(1 for item in nodes if item["flag_codes"]["bkt_disagrees"]),
        "question_heavy": sum(1 for item in nodes if item["flag_codes"]["question_heavy"]),
        "thin_evidence": sum(1 for item in nodes if item["flag_codes"]["thin_evidence"]),
        "with_evidence": sum(1 for item in nodes if item["observations"] > 0),
    }
    return {
        "nodes": nodes,
        "summary": summary,
        "project_id": project_id,
        "params": DEFAULT_PARAMS,
        "param_labels": PARAM_LABELS,
        "threshold": DISAGREE_BKT,
    }


def _empty_summary() -> dict[str, int]:
    return {
        "total_nodes": 0,
        "flagged_nodes": 0,
        "bkt_disagrees": 0,
        "question_heavy": 0,
        "thin_evidence": 0,
        "with_evidence": 0,
    }



