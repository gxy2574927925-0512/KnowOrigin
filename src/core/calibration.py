"""元认知校准：你自己觉得有多准，和实际有多准，差多少。

## 这个模块存在的理由

项目里其实**已经存了**这个问题的原料，但没人消费它。

``learning_events`` 表有一列 ``self_confidence REAL``，语义在 ``database.py:1555-1557``
里写得很清楚：``1.0`` 我确定 / ``0.0`` 我不确定 / ``NULL`` 没勾，并且强调

    两者是两个构念：前者（confidence）属于系统，后者（self_confidence）属于人。

现状是：``progress_engine`` 只用它做**单点**判据 —— ``overconfident_misses()``
数「答错 + 自评确定」的次数，用来把节点推进 ``repair`` 桶。那是「这一次我错了还嘴硬」，
不是「我这个人系统性地高估自己」。用户永远看不到自己有没有偏、偏哪边、偏多少。

``card_review_log.predicted`` 那一列（FSRS 算出的可提取性）更彻底 —— 代码注释里
自己写着「攒够样本后可以用它反推参数，也能直接告诉用户『你高估/低估了自己』」，
然后就没人用过。

所以本模块做三件事：**聚合**（把单点升级成趋势）、**判向**（高估 / 低估 / 吻合）、
**给差异化建议**。

## 为什么必须区分「高估」和「低估」

2025 年那批元认知干预的研究给出了一条反直觉但很硬的结论：

* Double, Goldwater & Birney (2025, *Metacognition and Learning*)，预注册 N=710：
  **逐题索取 confidence 会损害规则学习和迁移**。机制是它把人推向「保表现」的
  保守策略，而不是「求掌握」的策略。
* ACM CHI 那项 AI 校准训练（N=133，学习增益 +8.9%）：干预只对**初始过度自信**的
  学习者显著（校准改善 16.3% vs 对照 12.2%），对**过度谨慎**的学习者**没有**效果
  （15.0% vs 12.7%，p=0.771）。

合起来是一个明确的操作指令：**不要新增逐题自评；已经存的当信号用；对高估和低估要分开处理。**

这直接否掉了「加一个每题必答的把握度滑块」这种最容易想到、也最容易做坏的设计。
本模块因此提供 ``probe()`` —— 它只在**准确率落在中间带**时才建议追问一次会话级预测，
因为两端要么已经会了、要么明显不会，追问没有诊断价值。

## 三个不肯让步的口径

1. **不给新的分数。** 输出是「位置」（高估 / 低估 / 吻合 / 还看不出来），
   与 ``progress-panel.js`` 的「用位阶代替分数」同一立场。校准差值只在内部参与判定。
2. **样本不够就说不够。** ``MIN_SAMPLES = 8``。低于它一律返回 ``verdict="thin"``，
   界面显示「还看不出来」，绝不用 3 次作答编一个「你高估自己」出来。
   这与 ``mastery_audit.py`` 「分数高但证据薄」是同一个 ethos：宁可说不知道。
3. **只读。** 不写任何表、不改任何分数、不动 ``learning_events``。
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

# 与 mastery_bkt.VERIFIED_KINDS 同一集合：只有带对错信息的行为才谈得上「准不准」。
# question 没有对错，混进来会把「没答对」和「没把握」搅成同一个数。
VERIFIED_KINDS = frozenset({"quiz", "solve", "card", "discuss"})

# 与 mastery_bkt.CORRECT_THRESHOLD 同值，避免两份「答对」口径漂移。
CORRECT_THRESHOLD = 0.5

# 低于这个样本数不给结论。八条是「够看出方向」的下限，不是「够看出稳定趋势」的上限，
# 所以文案一律写「还看不出来」而不是「你大致…」—— 后者会被当成定论。
MIN_SAMPLES = 8

# 判定阈值。|gap| 小于 CALIBRATED_BAND 就算吻合 —— 人对自己的判断本来就有噪声，
# 一厘米的偏差不该被报成「你高估自己」。
OVERCONFIDENT_GAP = 0.20
CALIBRATED_BAND = 0.15

# probe 的诊断带：准确率落在这一段才值得追问一次预测。两端要么已经会、要么明显不会，
# 那时候的自我判断几乎没有信息量（Double et al. 2025 说的「保守策略」也是从
# 「已经稳了没必要再证明」那侧滑过去的）。
PROBE_BAND = (0.35, 0.75)

VERDICTS = ("overconfident", "underconfident", "aligned", "thin")

VERDICT_LABELS: dict[str, str] = {
    "overconfident": "你整体高估自己",
    "underconfident": "你整体低估自己",
    "aligned": "你的自我判断基本准",
    "thin": "样本还不够，看不出来",
}

# 差异化建议。高估与低估**必须不同措辞**，这是 CHI 那项研究的直接推论：
# 对高估者要「拿证据说话」，对低估者**绝不能再追问**，只能明确告知他其实更强。
VERDICT_ADVICE: dict[str, str] = {
    "overconfident": (
        "别急着看解析。先在心里把答案完整写一遍，再去对 —— "
        "高估的差距几乎都出在「看懂了」和「写得出来」之间。"
    ),
    "underconfident": (
        "先按对再往下走。你已经比你自己以为的更掌握这个领域了，"
        "别把时间花在反复确认上。"
    ),
    "aligned": "自我判断和实际对得上，接下来按现在的节奏走就行。",
    "thin": "再多做几次带把握度的题，这里就能看出方向了。",
}


def _clamp01(value: Any) -> float:
    try:
        return max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError):
        return 0.0


def _parse_dt(raw: Any) -> Any:
    """把 ``created_at`` 解析成**带时区**的 datetime（naive 一律当 UTC）。

    必须这么处理：库里落的是 ``database.utc_now().isoformat()``，在 Python 3.11 上
    是 aware 的（带 ``+00:00``）。而 ``datetime.now()`` 是 naive 的。直接比较会抛
    ``TypeError: can't compare offset-naive and offset-aware datetimes`` —— 而且只在
    真库上才炸，自造的最小库里日期是手写的 naive 字符串，正好躲过去。
    老数据里可能混着不带时区的字符串，这里统一补 UTC 当基准。
    """
    from datetime import timezone

    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(str(raw))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def classify(gap: float, samples: int) -> str:
    """校准差值 + 样本量 → 四档判定之一。

    抽出来是因为 ``report()`` 与 ``tools/verify_*.py`` 都要用同一套判据，
    而判据本身就是最容易被后来者「顺手改一下」的东西。
    """
    if samples < MIN_SAMPLES:
        return "thin"
    if gap >= OVERCONFIDENT_GAP:
        return "overconfident"
    if gap <= -OVERCONFIDENT_GAP:
        return "underconfident"
    return "aligned"


def _empty(project_id: str, verdict: str = "thin", **extra: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "project_id": project_id,
        "verdict": verdict,
        "verdict_label": VERDICT_LABELS[verdict],
        "advice": VERDICT_ADVICE[verdict],
        "samples": 0,
        "bins": {
            "certain_wrong": 0,
            "certain_right": 0,
            "unsure_right": 0,
            "unsure_wrong": 0,
        },
        "evidence": [],
        "nodes": [],
        "probe": {"ask": False, "reason": "还没有带把握度的作答"},
        "min_samples": MIN_SAMPLES,
        "bands": {
            "correct_threshold": CORRECT_THRESHOLD,
            "overconfident_gap": OVERCONFIDENT_GAP,
            "calibrated_band": CALIBRATED_BAND,
            "probe_band": list(PROBE_BAND),
        },
    }
    payload.update(extra)
    return payload


def probe(report: dict[str, Any]) -> dict[str, Any]:
    """这次要不要追问一次会话级预测。

    返回 ``{"ask": bool, "reason": str}``。**刻意不返回要预测的节点** ——
    预测必须由用户在界面上对着具体内容做，后端替他选好再问就变成走形式了。
    """
    samples = int(report.get("samples") or 0)
    if samples < MIN_SAMPLES:
        return {
            "ask": False,
            "reason": f"带把握度的作答还不到 {MIN_SAMPLES} 条，现在问只是多一次形式",
        }

    low, high = PROBE_BAND
    nodes = report.get("nodes") or []
    diagnostic = [
        node
        for node in nodes
        if low <= float(node.get("accuracy") or 0.0) <= high
        and int(node.get("self_reports") or 0) >= 3
    ]

    if report.get("verdict") == "overconfident":
        if not diagnostic:
            return {
                "ask": False,
                "reason": "你已经偏高了，但准确率都落在两端，问了也定位不到具体哪一块",
            }
        return {
            "ask": True,
            "reason": "你整体高估自己，而这几块的准确率正好在中间带 —— 先猜再对，最能看出差在哪",
            "focus_count": len(diagnostic),
        }

    if not diagnostic:
        return {
            "ask": False,
            "reason": "现在准确率不在中间带，猜了也说明不了什么，先做该做的",
        }

    return {
        "ask": True,
        "reason": "这几块正好是「会一点但不熟」的那一段，先猜一次再看差距最有信息量",
        "focus_count": len(diagnostic),
    }


def report(
    path: str | Path,
    owner_id: str,
    project_id: str,
    *,
    limit: int = 400,
) -> dict[str, Any]:
    """按项目聚合「自评把握度 − 实际正确」的分布。

    只读。越权或项目不存在返回 ``thin`` 而不是抛错（与 ``mastery_bkt.bkt_project``、
    ``progress_engine.plan`` 同一取舍：读路径上一律不因为权限问题炸掉）。
    """
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    try:
        owned = conn.execute(
            "SELECT 1 FROM projects WHERE project_id = ? AND owner_id = ?",
            (project_id, owner_id or ""),
        ).fetchone()
        if owned is None:
            return _empty(project_id)

        rows = conn.execute(
            "SELECT e.node_id, e.kind, e.correctness, e.self_confidence, e.created_at,"
            "       e.error_type, n.name AS node_name"
            "  FROM learning_events e"
            "  LEFT JOIN framework_nodes n ON n.node_id = e.node_id"
            "                          AND n.project_id = e.project_id"
            " WHERE e.project_id = ?"
            " ORDER BY e.created_at ASC, e.event_id ASC",
            (project_id,),
        ).fetchall()
    finally:
        conn.close()

    per_node: dict[str, dict[str, Any]] = {}
    gaps: list[float] = []
    bins = {"certain_wrong": 0, "certain_right": 0, "unsure_right": 0, "unsure_wrong": 0}
    evidence: list[dict[str, Any]] = []
    total_events = 0

    for row in rows:
        total_events += 1
        kind = row["kind"] or ""
        if kind not in VERIFIED_KINDS:
            continue
        correctness = row["correctness"]
        if correctness is None:
            continue
        raw_self = row["self_confidence"]
        if raw_self is None:
            continue

        self_value = _clamp01(raw_self)
        actual = _clamp01(correctness)
        correct = actual >= CORRECT_THRESHOLD
        certain = self_value >= CORRECT_THRESHOLD

        if certain:
            bins["certain_right" if correct else "certain_wrong"] += 1
        else:
            bins["unsure_right" if correct else "unsure_wrong"] += 1

        gaps.append(self_value - actual)

        node_id = str(row["node_id"] or "")
        node = per_node.setdefault(
            node_id,
            {
                "node_id": node_id,
                "name": row["node_name"] or node_id,
                "samples": 0,
                "self_reports": 0,
                "sum_self": 0.0,
                "sum_actual": 0.0,
                "correct": 0,
            },
        )
        node["self_reports"] += 1
        node["sum_self"] += self_value
        node["sum_actual"] += actual
        node["correct"] += 1 if correct else 0

        if certain and not correct:
            evidence.append(
                {
                    "node_id": node_id,
                    "node_name": row["node_name"] or node_id,
                    "kind": kind,
                    "at": row["created_at"],
                    "error_type": row["error_type"] or "",
                    "why": "你说很有把握，答案是错的 —— 这种最该先修",
                }
            )

    samples = len(gaps)
    mean_gap = (sum(gaps) / samples) if samples else 0.0
    verdict = classify(mean_gap, samples)

    nodes: list[dict[str, Any]] = []
    for node in per_node.values():
        count = node["self_reports"]
        if count <= 0:
            continue
        nodes.append(
            {
                "node_id": node["node_id"],
                "name": node["name"],
                "self_reports": count,
                "accuracy": round(node["sum_actual"] / count, 4),
                "self_mean": round(node["sum_self"] / count, 4),
                "gap": round((node["sum_self"] - node["sum_actual"]) / count, 4),
                "correct": node["correct"],
            }
        )
    # 偏得最多的排前面 —— 用户最先该看的就是这几块。
    nodes.sort(key=lambda item: -abs(item["gap"]))
    evidence.sort(key=lambda item: str(item["at"]), reverse=True)

    payload = _empty(project_id)
    payload.update(
        {
            "verdict": verdict,
            "verdict_label": VERDICT_LABELS[verdict],
            "advice": VERDICT_ADVICE[verdict],
            "samples": samples,
            "total_events": total_events,
            "mean_gap": round(mean_gap, 4),
            "bins": bins,
            "evidence": evidence[:8],
            "evidence_total": len(evidence),
            "nodes": nodes[:12],
            "node_count": len(nodes),
        }
    )
    payload["probe"] = probe(payload)
    return payload


def recent_predictions(
    path: str | Path,
    owner_id: str,
    project_id: str,
    *,
    days: int = 30,
) -> dict[str, Any]:
    """按时间窗看走向：最近半段 vs 再往前半段。

    与 ``report()`` 的区别只一个：**按时间窗**。全量报告会告诉你「你偏不偏」，
    但人会对「我上个月也这样吗」更买账 —— 两段走向比一个总判定更能支撑行动。
    """
    safe_days = max(1, min(int(days or 30), 180))
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    try:
        owned = conn.execute(
            "SELECT 1 FROM projects WHERE project_id = ? AND owner_id = ?",
            (project_id, owner_id or ""),
        ).fetchone()
        if owned is None:
            return {"project_id": project_id, "windows": [], "days": safe_days}
        rows = conn.execute(
            "SELECT kind, correctness, self_confidence, created_at"
            "  FROM learning_events WHERE project_id = ? ORDER BY created_at ASC",
            (project_id,),
        ).fetchall()
    finally:
        conn.close()

    # aware，与 _parse_dt 的输出同基准；用 naive 的 datetime.now() 会在真库上炸。
    now = datetime.now(timezone.utc)
    half = max(1, safe_days // 2)
    # 两段：近半段 vs 远半段。人对「我上个月也这样吗」比对「我偏不偏」更买账。
    spans = (
        (f"近 {half} 天", now - timedelta(days=half), now),
        (f"再往前的 {half} 天", now - timedelta(days=safe_days), now - timedelta(days=half)),
    )

    windows: list[dict[str, Any]] = []
    for label, start, end in spans:
        bucket: list[float] = []
        for row in rows:
            if row["kind"] not in VERIFIED_KINDS or row["self_confidence"] is None:
                continue
            if row["correctness"] is None:
                continue
            at = _parse_dt(row["created_at"])
            if at is None or not (start <= at < end):
                continue
            bucket.append(_clamp01(row["self_confidence"]) - _clamp01(row["correctness"]))
        if not bucket:
            continue
        mean = sum(bucket) / len(bucket)
        windows.append(
            {
                "label": label,
                "samples": len(bucket),
                "mean_gap": round(mean, 4),
                "verdict": classify(mean, len(bucket)),
                "verdict_label": VERDICT_LABELS[classify(mean, len(bucket))],
            }
        )
    return {"project_id": project_id, "windows": windows, "days": safe_days}