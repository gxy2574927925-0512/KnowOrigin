"""进步引擎：把「掌握度」翻译成「位置」。

## 这个模块存在的理由

``core/mastery_bkt.py`` 算得很对，但**结尾停在了「并排展示」**：它给用户多一个数字去看、
去比、去判断。而用户要的不是数字 —— 用户要的是**在这个项目里持续不断地往前走**。

于是模块的任务反过来：**BKT 不进界面，只当闸门**。

## 位阶（stage）—— 用位置代替分数

每个知识点只处于四档之一，用户看到的永远是这四个词，不是百分数：

    none  未开始   一条事件都没有
    seen  见过     有接触（提问 / 讨论 / 笔记都算），但还不足以下结论
    get   会了     至少 2 条**可验证**证据（quiz / solve / card / discuss），且 BKT ≥ 0.55
    hold  稳了     在「会了」之上，还有一张关联卡片被 FSRS 排进了间隔复习

判定的全部依据是**事件 + BKT + FSRS**，完全不读 ``mastery_score``。这一条很关键：
加权累加只增不减，``kind="question"`` 按 0.65 记分 —— 在一个节点上提问 13 次就能到
``mastered``（``tools/_review_test.py`` 已把它钉住）。如果位阶接上加权分，
用户就会在**什么都没学会**的地方看到「会了」，然后路径一跳过去就撞墙。
BKT 恰好能挡住这个：它区分「猜对」和「真会」（``p_g`` 就是干这个的）。
所以 BKT 藏进引擎里当闸门，比端出来给人看有用得多。

## 解锁（unlock）—— 让下一步永远有路

``framework_nodes.prerequisite_ids`` 早就入库了，但排程（``exam_scheduler``）与
概览的「下一步队列」（``app.js::overviewListForFilter``）都没读它。
后果是真实的：傅里叶变换的前置「复变函数」只掌握 0.2，而前者考试权重更高，
于是系统会先让用户去啃傅里叶变换 —— 啃不动、受挫、离开。

本模块只在**前置已达「会了」**的节点里推荐。没达标的节点不会消失，
而是显示成「还差 N 个前置」，让用户看得见路而不是撞墙。

## 今天的下一步：分桶，不是排序

按单一分数排序取前 N 个，结果永远是「最痛的那几个」，用户天天在同一个坑里打转。
这里改成**按桶各取一个**，保证一天里有不同的动作：

    repair  先修这个    答错了、但当时很确信 —— 最该先修，否则误解会固化
    fill    先补资料    这一条没有可用材料，学不下去（动作是去补材料）
    unlock  打开新路    它是别人唯一缺的那块 —— 做完就能解锁下游
    push    临门一脚    已经见过，离「会了」最近
    start   开个头      完全没碰过的、已解锁的节点
    review  该复习了    有 FSRS 到期的卡片

最后一步固定给**探索位**：从已解锁的陌生节点里按日期随机取一个。理由在
``Study Tutor Agent`` 里写得很清楚（epsilon-greedy）—— 纯按优先级选题，
会把用户永久锁死在最弱的那几点上。

## 本周回执：让进步看得见

事件流带时间戳，所以「七天前是什么位阶」可以**回放**出来，不需要新表。
于是回执说的不是「你的掌握度涨了 3%」，而是：

    这一周：3 个知识点往前挪了一格，解锁了 2 个新的。

## 口径上的两个让步（都是刻意的）

* **不改任何既有分数、不建任何新表、不引任何依赖。** 与 ``mastery_audit`` /
  ``mastery_bkt`` 同一立场：改口径会让所有既有用户的历史曲线对不上。
  本模块只读，输出只用于「下一步该干什么」。
* **历史位阶用当前的 FSRS 强度近似。** ``card_srs_state`` 只存当前状态，
  没有逐次快照；好处是不用开 ``card_review_log``（那张表在旧库里可能不存在）。
  影响仅限回执文案里「稳了」的计数，不影响推荐。
"""

from __future__ import annotations

import json
import random
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from .framework import ERROR_TYPE_ACTIONS, ERROR_TYPES
from .mastery_bkt import CORRECT_THRESHOLD, VERIFIED_KINDS, bkt_chain
# 迁移分与其阈值/标签。与 framework 同一模块（那边是写入侧，这边是读取侧）——
# 分开写一份阈值表必然漂移，而漂移的后果是「界面说迁移得动、引擎说没验过」。
from . import transfer as transfer_module

# ── 位阶 ────────────────────────────────────────────────

STAGES: tuple[str, ...] = ("none", "seen", "get", "hold")

STAGE_LABELS: dict[str, str] = {
    "none": "未开始",
    "seen": "见过",
    "get": "会了",
    "hold": "稳了",
}

STAGE_ORDER: dict[str, int] = {stage: index for index, stage in enumerate(STAGES)}

# ── 闸门参数 ────────────────────────────────────────────
#
# 两个条件必须同时满足才算「会了」：
#   1. 至少 2 条可验证证据 —— 1 条可能是蒙对；
#   2. BKT ≥ 0.55 —— 而 BKT 把「猜对」压掉了，所以「问 13 次」永远过不了这道闸。
#
# 0.55 的来历：连续答对两次，BKT 走到 0.857；一对一错，掉到 0.149。
# 取 0.55 落在两者之间，语义就是「至少连着对了两次」。
GATE_GET_VERIFIED = 2
GATE_GET_BKT = 0.55

# 「稳了」要求关联卡片被 FSRS 排进过间隔复习，且当前强度 ≥ 2 天。
# 2 天是「不是当天突击」的最低线；阈值放宽是为了让真实用户够得着
# （实测库里 stability 分布 0.21 ~ 8.30）。
HOLD_MIN_REPS = 1
HOLD_MIN_STABILITY = 2.0

# 错题与过度自信：correctness < 0.5 记为答错（与 mastery_bkt 同一口径）
FAIL_THRESHOLD = CORRECT_THRESHOLD
# self_confidence ≥ 0.6 视为「当时挺确信」。答错 + 自评确信 = 典型误解，优先级最高。
# 阈值放在 0.6 是因为自评只有两档（1.0 我确定 / 0.0 我不确定），0.6 落在两档之间：
# 以后若扩成三档，只需调这一个数，不必改判据。
OVERCONFIDENT = 0.60

WEEK_DAYS = 7
DEFAULT_LIMIT = 3

# 考试权重对优先级的加成
WEIGHT_BONUS: dict[str, int] = {
    "exam_critical": 25,
    "exam_important": 12,
    "exam_normal": 4,
    "exam_basic": 0,
    "exam_skip": -20,
}

BUCKET_ORDER: tuple[str, ...] = (
    "repair",
    # transfer 排在 fill 之前、push 之前：会了但不迁移，是**当前最值钱**的缺口 ——
    # 它决定考场上遇到变式题时会不会崩。放在 push 前面是为了让「再刷几道识记题」
    # 不再排在「换个情境验一遍」前面（那正是原来的刷分漏洞在推荐位上的同构版本）。
    "transfer",
    "fill",
    "unlock",
    "push",
    "start",
    "review",
)

BUCKET_LABELS: dict[str, str] = {
    "repair": "先修这个",
    "transfer": "换个情境",
    "fill": "先补资料",
    "unlock": "打开新路",
    "push": "临门一脚",
    "start": "开个头",
    "review": "该复习了",
    # 探索位不是「优先级最高的那个」，单独给一个诚实的名字，
    # 免得用户以为它也是排序结果。
    "explore": "换个方向",
}

BUCKET_ACTIONS: dict[str, str] = {
    "repair": "open-node",
    "fill": "open-node",
    "unlock": "open-node",
    "push": "open-node",
    "start": "open-node",
    "review": "open-cards",
    # 迁移桶：不是去学新东西，是去**换个情境验一遍**已经会的东西。
    # 它有自己的入口（「换个情境试试」），不是打开节点详情。
    "transfer": "open-transfer",
    "explore": "open-node",
}


# ── 拓扑分层（独立实现，供出题侧复用）─────────────────────────────────
#
# 为什么提成独立函数：出题侧要判断「这个考点和它的前置差几层」来决定难度，
# 于是需要同一份层号。此前层号只存在于 _Project._layers 里，而 _Project 要
# 连事件流、卡片、FSRS 状态全读一遍 —— 为了拿一个整数把整库拖进内存不划算，
# 于是两边各写一份Kahn。两份Kahn漂移的后果是「层差判断与推荐排序口径不一致」，
# 所以这里只保留一份，_Project 转调它。


def node_layers(prereqs: Mapping[str, Sequence[str]]) -> dict[str, int]:
    """Kahn 分层：``{node_id: [它依赖的节点 id, ...]}`` → ``{node_id: 层号}``。

    环里的节点保持 0 层 —— 防御性选择：宁可当它没有依赖，也不要因为
    上游抽框架抽出一圈环就把用户永远卡住，也绝不让一处环把整张图的分层变成空。
    """
    ids = set(prereqs)
    indegree = {node_id: 0 for node_id in ids}
    downstream: dict[str, list[str]] = {node_id: [] for node_id in ids}
    for node_id, deps in prereqs.items():
        for prereq in deps or ():
            if prereq in ids and prereq != node_id:
                indegree[node_id] += 1
                downstream[prereq].append(node_id)

    layer = {node_id: 0 for node_id in ids}
    queue = [node_id for node_id in sorted(ids) if indegree[node_id] == 0]
    visited: set[str] = set()
    while queue:
        current = queue.pop(0)
        if current in visited:
            continue
        visited.add(current)
        for child in downstream[current]:
            layer[child] = max(layer[child], layer[current] + 1)
            indegree[child] -= 1
            if indegree[child] <= 0:
                queue.append(child)
    return layer


def _parse_ids(raw: Any) -> list[str]:
    """把 JSON 数组字符串解析成去重后的 id 列表。坏数据一律当空。"""
    if isinstance(raw, list):
        values = raw
    elif isinstance(raw, str) and raw.strip():
        try:
            values = json.loads(raw)
        except (ValueError, TypeError):
            return []
    else:
        return []
    if not isinstance(values, list):
        return []
    out: list[str] = []
    for item in values:
        text = str(item or "").strip()
        if text and text not in out:
            out.append(text)
    return out


def _parse_dt(raw: Any) -> datetime | None:
    text = str(raw or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text)
    except (ValueError, TypeError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _bkt_of(observations: Sequence[bool]) -> float:
    return float(bkt_chain(observations)["mastery"])


def _stage(
    *,
    any_event: bool,
    verified: int,
    observations: Sequence[bool],
    hold_ready: bool,
) -> tuple[str, float]:
    """返回 (位阶, BKT)。BKT 也一并返回，供内部打分用 —— 不给界面。"""
    if not any_event:
        return "none", 0.0
    bkt_value = _bkt_of(observations)
    if verified < GATE_GET_VERIFIED or bkt_value < GATE_GET_BKT:
        return "seen", bkt_value
    return ("hold" if hold_ready else "get"), bkt_value


class _Project:
    """一次读取，供 plan / digest 共用。全是内存里的纯数据。"""

    def __init__(
        self,
        *,
        nodes: dict[str, dict[str, Any]],
        events: dict[str, list[dict[str, Any]]],
        card_nodes: dict[str, list[str]],
        srs: dict[str, dict[str, Any]],
    ) -> None:
        self.nodes = nodes
        self.events = events
        self.card_nodes = card_nodes
        self.srs = srs
        self.hold_nodes = self._hold_nodes()
        self.layers = self._layers()

    # ── FSRS ────────────────────────────────────────────

    def _hold_nodes(self) -> set[str]:
        held: set[str] = set()
        for card_id, node_ids in self.card_nodes.items():
            row = self.srs.get(card_id)
            if not row:
                continue
            try:
                reps = int(row.get("reps") or 0)
                stability = float(row.get("stability") or 0.0)
            except (TypeError, ValueError):
                continue
            if reps >= HOLD_MIN_REPS and stability >= HOLD_MIN_STABILITY:
                held.update(node_ids)
        return held

    # ── 拓扑分层 ────────────────────────────────────────

    def _layers(self) -> dict[str, int]:
        return node_layers({k: v["prereq"] for k, v in self.nodes.items()})

    # ── 单节点状态 ──────────────────────────────────────

    def verified_observations(
        self, node_id: str, *, before: datetime | None = None
    ) -> list[bool]:
        out: list[bool] = []
        for event in self.events.get(node_id, []):
            if event["kind"] not in VERIFIED_KINDS:
                continue
            if before is not None and event["at"] is not None and event["at"] >= before:
                continue
            correctness = event["correctness"]
            if correctness is None:
                continue
            out.append(float(correctness) >= FAIL_THRESHOLD)
        return out

    def has_event(self, node_id: str, *, before: datetime | None = None) -> bool:
        for event in self.events.get(node_id, []):
            if before is not None and event["at"] is not None and event["at"] >= before:
                continue
            return True
        return False

    def stage_of(self, node_id: str, *, before: datetime | None = None) -> str:
        observations = self.verified_observations(node_id, before=before)
        any_event = self.has_event(node_id, before=before)
        hold_ready = node_id in self.hold_nodes
        if before is not None:
            hold_ready = hold_ready and self._held_before(node_id, before)
        stage, _ = _stage(
            any_event=any_event,
            verified=len(observations),
            observations=observations,
            hold_ready=hold_ready,
        )
        return stage

    def _held_before(self, node_id: str, before: datetime) -> bool:
        for card_id, node_ids in self.card_nodes.items():
            if node_id not in node_ids:
                continue
            row = self.srs.get(card_id)
            if not row:
                continue
            last_review = _parse_dt(row.get("last_review"))
            if last_review is not None and last_review < before:
                continue
            try:
                if int(row.get("reps") or 0) >= HOLD_MIN_REPS and float(
                    row.get("stability") or 0.0
                ) >= HOLD_MIN_STABILITY:
                    return True
            except (TypeError, ValueError):
                continue
        return False

    def bkt_of(self, node_id: str) -> float:
        return _bkt_of(self.verified_observations(node_id))

    def due_cards(self, node_id: str, now: datetime) -> int:
        total = 0
        for card_id, node_ids in self.card_nodes.items():
            if node_id not in node_ids:
                continue
            row = self.srs.get(card_id)
            if not row:
                continue
            due = _parse_dt(row.get("due_at"))
            if due is not None and due <= now:
                total += 1
        return total

    def overconfident_misses(self, node_id: str) -> int:
        """答错 + **学习者自评「我确定」** 的次数 —— 最该先修的误解。

        ⚠️ 读的是 `self_confidence`（人自己勾的），**不是** `confidence`（节点映射置信度）。
        后者在 quiz 提交处写死 `0.95`，读它会让每一道错题都命中本判据，
        于是 repair 桶退化成「答错过」、判别力为零 —— 这正是 2026-09-29 修掉的 bug。
        没勾自评（NULL）一律不判，老数据因此天然被排除。
        """
        total = 0
        for event in self.events.get(node_id, []):
            if event["kind"] not in VERIFIED_KINDS:
                continue
            correctness = event["correctness"]
            if correctness is None:
                continue
            self_conf = event.get("self_confidence")
            if self_conf is None:
                continue
            try:
                self_conf = float(self_conf)
            except (TypeError, ValueError):
                continue
            if float(correctness) < FAIL_THRESHOLD and self_conf >= OVERCONFIDENT:
                total += 1
        return total

    def last_overconfident_miss_reference(self, node_id: str) -> str | None:
        """最近一次「答错 + 自评确定」的练习引用（`quiz_id:题号`），给前端当跳转目标。

        判据与 :meth:`overconfident_misses` 完全一致（同款常量、同款排除规则）——
        计数与引用必须来自同一条判据，否则会出现「理由说有 1 道，点进去却是另一道」。
        events 已按时间升序，取最后命中的一条。没有就 None（前端不给次按钮）。
        """
        found: str | None = None
        for event in self.events.get(node_id, []):
            if event["kind"] not in VERIFIED_KINDS:
                continue
            correctness = event["correctness"]
            if correctness is None:
                continue
            self_conf = event.get("self_confidence")
            if self_conf is None:
                continue
            try:
                self_conf = float(self_conf)
            except (TypeError, ValueError):
                continue
            if float(correctness) < FAIL_THRESHOLD and self_conf >= OVERCONFIDENT:
                reference = event.get("reference")
                if reference:
                    found = reference
        return found

    def latest_error_type(self, node_id: str) -> str | None:
        """该节点上**最近一次由学习者标注**的错因；没标过就 None。

        只看带 error_type 的事件：老数据一律 NULL ⇒ 天然「没有错因」，
        建议文案退回通用版 —— 不猜、不补默认值（这正是本模块第一条纪律）。
        """
        found: str | None = None
        for event in self.events.get(node_id, []):  # events 已按时间升序，最后一次写的算数
            value = event.get("error_type")
            if isinstance(value, str) and value.strip():
                found = value.strip()
        return found

    # ── 解锁 ────────────────────────────────────────────

    def blockers(self, node_id: str, stage_map: dict[str, str]) -> list[str]:
        out: list[str] = []
        for prereq in self.nodes[node_id]["prereq"]:
            if prereq not in stage_map:
                # 前置指向了别的项目 / 已被删除 —— 不因此卡住用户
                continue
            if STAGE_ORDER.get(stage_map[prereq], 0) < STAGE_ORDER["get"]:
                out.append(prereq)
        return out

    def unlock_gain(self, node_id: str, stage_map: dict[str, str]) -> int:
        """把这个节点推到「会了」之后，能解锁几个下游。只看它是不是最后一块拼图。"""
        gain = 0
        for other_id, meta in self.nodes.items():
            if node_id not in meta["prereq"]:
                continue
            remaining = [
                prereq
                for prereq in self.blockers(other_id, stage_map)
                if prereq != node_id
            ]
            if not remaining:
                gain += 1
        return gain


def _load(path: str | Path, owner_id: str, project_id: str) -> _Project | None:
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    try:
        owned = conn.execute(
            "SELECT 1 FROM projects WHERE project_id = ? AND owner_id = ?",
            (project_id, owner_id or ""),
        ).fetchone()
        if owned is None:
            return None

        node_rows = conn.execute(
            "SELECT node_id, name, parent_id, prerequisite_ids, exam_weight,"
            " coverage_status, learning_status, transfer_score FROM framework_nodes"
            " WHERE project_id = ?",
            (project_id,),
        ).fetchall()

        event_rows = conn.execute(
            "SELECT node_id, kind, correctness, confidence, self_confidence, error_type,"
            " reference_id, created_at FROM learning_events"
            " WHERE project_id = ? ORDER BY created_at ASC, event_id ASC",
            (project_id,),
        ).fetchall()

        card_rows = conn.execute(
            "SELECT card_id, payload FROM cards WHERE project_id = ?", (project_id,)
        ).fetchall()

        # 附加表是懒创建的 —— 表不在就退化成「没有 FSRS 状态」，别让 JOIN 抛异常
        tables = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
        srs: dict[str, dict[str, Any]] = {}
        if "card_srs_state" in tables:
            for row in conn.execute(
                "SELECT card_id, stability, reps, lapses, due_at, last_review, state"
                " FROM card_srs_state WHERE owner_id = ?",
                (owner_id or "",),
            ):
                srs[str(row["card_id"])] = dict(row)
    finally:
        conn.close()

    nodes: dict[str, dict[str, Any]] = {}
    for row in node_rows:
        node_id = str(row["node_id"])
        keys = row.keys()
        nodes[node_id] = {
            "node_id": node_id,
            "name": str(row["name"] or "").strip() or "未命名知识点",
            "parent_id": str(row["parent_id"] or ""),
            "prereq": [p for p in _parse_ids(row["prerequisite_ids"]) if p != node_id],
            "exam_weight": str(row["exam_weight"] or "exam_normal"),
            "coverage_status": str(row["coverage_status"] or "covered"),
            "learning_status": str(row["learning_status"] or "unexplored"),
            # 老库升级前没有这一列 ⇒ 读出来是 None ⇒ 迁移分按 0 处理（= 迁移未验证）。
            # 如实当 0，而不是拿 mastery 顶替：那会让「会了」看起来像「迁移得动」。
            "transfer_score": float(
                row["transfer_score"]
                if "transfer_score" in keys and row["transfer_score"] is not None
                else 0.0
            ),
        }

    events: dict[str, list[dict[str, Any]]] = {}
    for row in event_rows:
        node_id = str(row["node_id"])
        events.setdefault(node_id, []).append(
            {
                "kind": str(row["kind"] or ""),
                "correctness": row["correctness"],
                "confidence": row["confidence"],
                "self_confidence": row["self_confidence"],
                "error_type": row["error_type"],
                # 练习引用（quiz 提交处写 "quiz_id:题号"）。repair 桶靠它把
                # 「先修这个」变成可点的动作：直接打开那道错题所在的历史测验。
                "reference": str(row["reference_id"] or "") or None,
                "at": _parse_dt(row["created_at"]),
            }
        )

    card_nodes: dict[str, list[str]] = {}
    for row in card_rows:
        try:
            payload = json.loads(row["payload"] or "{}")
        except (ValueError, TypeError):
            continue
        if not isinstance(payload, dict):
            continue
        linked = _parse_ids(payload.get("node_ids"))
        if linked:
            card_nodes[str(row["card_id"])] = linked

    return _Project(nodes=nodes, events=events, card_nodes=card_nodes, srs=srs)


def _stage_counts(project: _Project, *, before: datetime | None = None) -> dict[str, int]:
    counts = {stage: 0 for stage in STAGES}
    for node_id in project.nodes:
        counts[project.stage_of(node_id, before=before)] += 1
    return counts


def _score_node(
    project: _Project,
    node_id: str,
    stage_map: dict[str, str],
    now: datetime,
) -> tuple[int, dict[str, Any]]:
    meta = project.nodes[node_id]
    stage = stage_map[node_id]
    verified = len(project.verified_observations(node_id))
    bkt_value = project.bkt_of(node_id)
    gain = project.unlock_gain(node_id, stage_map)
    due = project.due_cards(node_id, now)
    misses = project.overconfident_misses(node_id)
    err = project.latest_error_type(node_id)

    score = 0
    if misses:
        score += 100 + 10 * min(misses, 3)
    if meta["coverage_status"] == "insufficient_source":
        score += 60
    elif meta["coverage_status"] == "uncovered":
        score += 35
    score += min(40, 12 * gain)
    score += int(30 * max(0.0, min(1.0, bkt_value / GATE_GET_BKT))) if stage == "seen" else 0
    score += WEIGHT_BONUS.get(meta["exam_weight"], 0)
    if due:
        score += 20 + 5 * min(due, 3)
    if stage == "none":
        score += 8
    # 迁移缺口：只在「已经会了」之后才算。不会的东西谈迁移没有意义 ——
    # 那时该做的是 repair 或 push，不是换情境。
    transfer_gap = transfer_module.transfer_gap_score(
        stage=stage,
        transfer_score=meta.get("transfer_score", 0.0),
        has_prereq=bool(meta["prereq"]),
        due_cards=due,
    )
    if transfer_gap:
        score += transfer_gap

    detail = {
        "verified": verified,
        "bkt": round(bkt_value, 4),
        "unlock_gain": gain,
        "due_cards": due,
        "overconfident_misses": misses,
        # 迁移分与位阶分开显示。0 表示「迁移未验证」—— 没有迁移题证据时如实说没有，
        # 不用 mastery 反推（本模块开头那条纪律：只按结构事实排序，不猜）。
        "transfer_score": round(float(meta.get("transfer_score", 0.0)), 4),
        "transfer_stage": transfer_module.transfer_stage(meta.get("transfer_score", 0.0)),
        "transfer_stage_label": transfer_module.TRANSFER_STAGE_LABELS[
            transfer_module.transfer_stage(meta.get("transfer_score", 0.0))
        ],
        "transfer_gap": transfer_gap,
        "transfer_ready": transfer_gap > 0,
        "layer": project.layers.get(node_id, 0),
        # 学习者自己标的错因（可能为空）。它只是「为什么错」的注解，
        # **不参与打分** —— 打分会让人学会挑一个划算的错因，那就毁了。
        "error_type": err,
        "error_type_label": ERROR_TYPES.get(err or "", ""),
        # 最近一次高信心答错的引用（quiz_id:题号）。只修 repair 桶，
        # 它是唯一一个「点进去能看到具体那道题」的桶。
        "last_miss_reference": project.last_overconfident_miss_reference(node_id),
    }
    return score, detail


def _bucket_of(
    project: _Project,
    node_id: str,
    stage: str,
    detail: dict[str, Any],
) -> str:
    meta = project.nodes[node_id]
    # repair 只在「还没被纠正」时才排第一 —— 一个已经升到「会了」的节点，
    # 早先那次高信心答错显然已经被后续练习覆盖了，再去修它是浪费一天。
    if detail["overconfident_misses"] and stage in ("none", "seen"):
        return "repair"
    if meta["coverage_status"] in ("insufficient_source", "uncovered"):
        return "fill"
    # 迁移桶插在 review 之前：到期卡片是「别忘了」，迁移是「换个地方用」，
    # 两者都要做，但**先验迁移再复习**的理由是复习不产生迁移证据，
    # 而迁移证据只能在「还记得」时拿到 —— 顺序反过来会一直缺证据。
    if detail.get("transfer_ready"):
        return "transfer"
    if stage == "hold" and detail["due_cards"]:
        return "review"
    if detail["unlock_gain"] and stage in ("none", "seen"):
        return "unlock"
    if stage == "seen":
        return "push"
    if stage == "none":
        return "start"
    return "review"


def _reason_text(
    bucket: str,
    project: _Project,
    node_id: str,
    detail: dict[str, Any],
) -> str:
    name = project.nodes[node_id]["name"]
    if bucket == "repair":
        # 「这块我压根没学过」是最有用的一档错因 —— 它直接指向前置图。
        # 光说「去补前置」是空话，必须**点名**该补哪几个，否则学生只会回来重做这道题。
        if detail.get("error_type") == "prereq_missing":
            names = [
                project.nodes[p]["name"]
                for p in project.nodes[node_id]["prereq"]
                if p in project.nodes
            ]
            if names:
                listed = "、".join(names[:3])
                more = "" if len(names) <= 3 else f" 等 {len(names)} 个"
                return (
                    f"「{name}」你说这块压根没学过 —— 那先回去补它的前置：{listed}{more}。"
                    "补完再来看这道，否则怎么练都是猜。"
                )
            # 前置图是空的（本项目里没有标过任何前置）⇒ 不能假装知道该补什么
            return (
                f"「{name}」你说这块压根没学过，但这个项目的知识框架还没标出它的前置。"
                "先去补一批基础材料，再回来看这道题。"
            )
        label = ERROR_TYPES.get(detail.get("error_type") or "", "")
        action = ERROR_TYPE_ACTIONS.get(detail.get("error_type") or "", "")
        if label and action:
            # 学习者自己说了错在哪 ⇒ 建议可以具体到「下一步做什么」，不再是泛泛的「再练一遍」
            return (
                f"「{name}」你答错了一道题、当时还很确信，而且你说错在「{label}」——"
                f"这类错最容易变成长期误解，{action}。"
            )
        return (
            f"「{name}」有一道题你答错了，但当时是确信的 —— 这类错最容易变成长期误解，"
            "先修它。"
        )
    if bucket == "fill":
        return f"「{name}」还没有可用的材料，先补上再学，否则怎么练都是猜。"
    if bucket == "transfer":
        stage_label = detail.get("transfer_stage_label") or "迁移未验证"
        layer = detail.get("layer", 0)
        # 迁移理由必须说清三件事：你会了（位阶）、没验过迁移（迁移分）、
        # 以及去哪验（它有前置 ⇒ 可以出「换条件/换表征/换领域」的题）。
        # 少说一句，用户就会以为这是又一道普通的题。
        return (
            f"「{name}」已经到「{STAGE_LABELS.get(detail.get('stage') or '', '会了')}」了，"
            f"但迁移还是「{stage_label}」—— 会认和会用是两件事。"
            + (f"它有前置（第 {layer} 层），能出换条件/换表征的题来验。" if layer else "")
            + "做一道对齐题，看你在新情境里还能不能把它调出来。"
        )
    if bucket == "unlock":
        gain = detail["unlock_gain"]
        return f"「{name}」是你手上唯一缺的那块 —— 学会它就能解锁后面 {gain} 个知识点。"
    if bucket == "push":
        return f"「{name}」你已经接触过了，再练几下就能从「见过」升到「会了」。"
    if bucket == "start":
        return f"「{name}」的前置都到位了，可以直接开始。"
    if bucket == "explore":
        return (
            f"换个方向试试「{name}」—— 一直盯着最弱的那几个点，容易看不出自己已经走了多远。"
        )
    return f"「{name}」有 {detail['due_cards']} 张卡片到期了，趁记忆还在，翻一下最省力。"


def _blocked_summary(project: _Project, stage_map: dict[str, str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for node_id, meta in project.nodes.items():
        if stage_map[node_id] not in ("none", "seen"):
            continue
        blockers = project.blockers(node_id, stage_map)
        if not blockers:
            continue
        out.append(
            {
                "node_id": node_id,
                "name": meta["name"],
                "blocked_by": [
                    {"node_id": blocker, "name": project.nodes[blocker]["name"]}
                    for blocker in blockers
                ],
            }
        )
    out.sort(key=lambda item: (-len(item["blocked_by"]), item["name"]))
    return out


def plan(
    path: str | Path,
    owner_id: str,
    project_id: str,
    *,
    limit: int = DEFAULT_LIMIT,
    now: datetime | None = None,
) -> dict[str, Any]:
    """今天的下一步。按桶各取一个，最后一个固定是探索位。

    只读。越权或项目不存在时返回空计划，不抛错（与 ``mastery_bkt.bkt_project``
    同一取舍）。
    """
    now = now or datetime.now(timezone.utc)
    project = _load(path, owner_id, project_id)
    if project is None:
        return {
            "project_id": project_id,
            "steps": [],
            "stage_counts": {stage: 0 for stage in STAGES},
            "blocked": [],
            "blocked_count": 0,
        }

    stage_map = {node_id: project.stage_of(node_id) for node_id in project.nodes}
    limit = max(1, int(limit))

    scored: list[tuple[int, str, str, dict[str, Any]]] = []
    for node_id in project.nodes:
        stage = stage_map[node_id]
        score, detail = _score_node(project, node_id, stage_map, now)
        bucket = _bucket_of(project, node_id, stage, detail)
        scored.append((score, node_id, bucket, detail))

    # 探索位：从「已解锁、还没碰过」的节点里挑一个，按日期定种子 ——
    # 同一天刷新面板不会换来换去，换一天才换人。
    unlocked_fresh = [
        node_id
        for node_id in project.nodes
        if stage_map[node_id] == "none" and not project.blockers(node_id, stage_map)
    ]
    unlocked_fresh.sort()
    explorer: str | None = None
    if unlocked_fresh:
        rng = random.Random(f"{project_id}:{now.date().isoformat()}")
        explorer = rng.choice(unlocked_fresh)

    picked: list[str] = []
    # 常规位：按桶顺序各取一个分数最高的
    for bucket in BUCKET_ORDER:
        if len(picked) >= limit:
            break
        candidates = [
            item for item in scored if item[2] == bucket and item[1] not in picked
        ]
        if not candidates:
            continue
        candidates.sort(key=lambda item: (-item[0], item[1]))
        # fill 桶只在真缺资料时才占常规位，避免天天提示补资料
        if bucket == "fill" and len(picked) >= 1 and candidates[0][0] < 60:
            continue
        picked.append(candidates[0][1])

    # 探索位：如果常规位没占满，用它补最后一个
    if explorer and explorer not in picked:
        picked.append(explorer)

    # 还是不够就用分数最高的补齐
    if len(picked) < limit:
        for _, node_id, _, _ in sorted(scored, key=lambda item: (-item[0], item[1])):
            if node_id not in picked:
                picked.append(node_id)
            if len(picked) >= limit:
                break

    picked = picked[:limit]

    steps: list[dict[str, Any]] = []
    for index, node_id in enumerate(picked):
        meta = project.nodes[node_id]
        stage = stage_map[node_id]
        _, detail = _score_node(project, node_id, stage_map, now)
        # stage 回填必须在 _reason_text **之前**：迁移桶的推荐语要引用
        # 「已经到会了」这个位阶，缺了它那半句话就接不上「但迁移还是未验证」。
        detail["stage"] = stage
        bucket = _bucket_of(project, node_id, stage, detail)
        is_explore = explorer == node_id and index == len(picked) - 1
        if is_explore and bucket == "start":
            bucket = "explore"
        steps.append(
            {
                "node_id": node_id,
                "name": meta["name"],
                "stage": stage,
                "stage_label": STAGE_LABELS[stage],
                "bucket": bucket,
                "bucket_label": BUCKET_LABELS.get(bucket, "继续"),
                "reason": _reason_text(bucket, project, node_id, detail),
                "action": BUCKET_ACTIONS.get(bucket, "open-node"),
                "exam_weight": meta["exam_weight"],
                "layer": project.layers.get(node_id, 0),
                "detail": detail,
            }
        )

    blocked = _blocked_summary(project, stage_map)
    return {
        "project_id": project_id,
        "generated_at": now.isoformat(),
        "stage_counts": _stage_counts(project),
        "stage_labels": STAGE_LABELS,
        "step_labels": BUCKET_LABELS,
        "transfer": _transfer_summary(project, stage_map),
        "steps": steps,
        "blocked": blocked[:8],
        "blocked_count": len(blocked),
    }


def _transfer_summary(project: _Project, stage_map: dict[str, str]) -> dict[str, Any]:
    """迁移分总览：多少知识点已会、多少验过迁移、其中多少「迁移得动」。

    单独一段而不是塞进 stage_counts：它是**另一个维度**的进度，
    混进位阶计数里会让人以为「会了」就等于「会用了」。
    """
    counts = {"untested": 0, "partial": 0, "solid": 0}
    ready: list[dict[str, Any]] = []
    for node_id in project.nodes:
        stage = transfer_module.transfer_stage(project.nodes[node_id].get("transfer_score", 0.0))
        counts[stage] += 1
        if stage != "solid" and transfer_module.transfer_gap_score(
            stage=stage_map[node_id],
            transfer_score=project.nodes[node_id].get("transfer_score", 0.0),
            has_prereq=bool(project.nodes[node_id]["prereq"]),
            due_cards=0,
        ):
            ready.append({"node_id": node_id, "name": project.nodes[node_id]["name"]})
    return {
        "labels": dict(transfer_module.TRANSFER_STAGE_LABELS),
        "counts": counts,
        "ready_count": len(ready),
        "ready": ready[:6],
    }


def digest(
    path: str | Path,
    owner_id: str,
    project_id: str,
    *,
    days: int = WEEK_DAYS,
    now: datetime | None = None,
) -> dict[str, Any]:
    """这一周往前挪了多少格。全部由事件流回放得出，不建新表。"""
    now = now or datetime.now(timezone.utc)
    days = max(1, int(days))
    cutoff = now - timedelta(days=days)
    project = _load(path, owner_id, project_id)
    if project is None:
        return {
            "project_id": project_id,
            "window_days": days,
            "stage_counts": {stage: 0 for stage in STAGES},
            "promoted": [],
            "newly_unlocked": [],
            "headline": "还没有数据。",
        }

    stage_now = {node_id: project.stage_of(node_id) for node_id in project.nodes}
    stage_then = {
        node_id: project.stage_of(node_id, before=cutoff) for node_id in project.nodes
    }

    promoted: list[dict[str, Any]] = []
    for node_id, meta in project.nodes.items():
        was = STAGE_ORDER.get(stage_then[node_id], 0)
        is_now = STAGE_ORDER.get(stage_now[node_id], 0)
        if is_now <= was:
            continue
        promoted.append(
            {
                "node_id": node_id,
                "name": meta["name"],
                "from": stage_then[node_id],
                "to": stage_now[node_id],
                "from_label": STAGE_LABELS[stage_then[node_id]],
                "to_label": STAGE_LABELS[stage_now[node_id]],
                "exam_weight": meta["exam_weight"],
            }
        )
    promoted.sort(
        key=lambda item: (-WEIGHT_BONUS.get(item["exam_weight"], 0), item["name"])
    )

    def _unlocked_at(stage_map: dict[str, str]) -> set[str]:
        return {
            node_id
            for node_id in project.nodes
            if not project.blockers(node_id, stage_map)
        }

    unlocked_now = _unlocked_at(stage_now)
    unlocked_then = _unlocked_at(stage_then)
    newly_unlocked = [
        {
            "node_id": node_id,
            "name": project.nodes[node_id]["name"],
            "exam_weight": project.nodes[node_id]["exam_weight"],
        }
        for node_id in sorted(unlocked_now - unlocked_then)
    ]
    newly_unlocked.sort(
        key=lambda item: (-WEIGHT_BONUS.get(item["exam_weight"], 0), item["name"])
    )

    repair = [
        node_id
        for node_id in project.nodes
        if project.overconfident_misses(node_id)
        and stage_now[node_id] in ("none", "seen")
    ]

    active_dates = set()
    for node_id in project.events:
        for event in project.events[node_id]:
            at = event["at"]
            if at is not None and at >= cutoff:
                active_dates.add(at.date().isoformat())

    held = sum(1 for stage in stage_now.values() if stage == "hold")
    advanced = len(promoted)
    if advanced and newly_unlocked:
        headline = (
            f"这一周有 {advanced} 个知识点往前挪了一格，"
            f"还解锁了 {len(newly_unlocked)} 个新的。"
        )
    elif advanced:
        headline = f"这一周有 {advanced} 个知识点往前挪了一格。"
    elif newly_unlocked:
        headline = f"这一周解锁了 {len(newly_unlocked)} 个新知识点，可以往里走了。"
    elif active_dates:
        headline = "这一周在接触新的东西，还没有知识点挪格 —— 接触也是进步。"
    else:
        headline = "这一周还没有记录。挑一件上面的事做，就有第一格了。"

    return {
        "project_id": project_id,
        "generated_at": now.isoformat(),
        "window_days": days,
        "stage_counts": _stage_counts(project),
        "stage_counts_before": _stage_counts(project, before=cutoff),
        "stage_labels": STAGE_LABELS,
        "promoted": promoted[:6],
        "promoted_count": advanced,
        "newly_unlocked": newly_unlocked[:6],
        "newly_unlocked_count": len(newly_unlocked),
        "held_count": held,
        "repair_count": len(repair),
        "active_days": len(active_dates),
        "headline": headline,
    }


# --------------------------------------------------------------------------
# AI 优先复习建议的持久化（2026-09-30）：
# suggest 端点的产出（选谁 + AI 写的理由）落一张小表，按 (owner, project) 单槽位。
# 重启后前端 GET 就能直接恢复上次建议，不必再花一次 LLM。
# --------------------------------------------------------------------------

_SUGGEST_SCHEMA = """
CREATE TABLE IF NOT EXISTS progress_suggestions (
    owner_id   TEXT NOT NULL,
    project_id TEXT NOT NULL,
    payload    TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, project_id)
);
"""


def save_suggestions(
    path: str | Path,
    owner_id: str,
    project_id: str,
    payload: dict[str, Any],
) -> None:
    """保存（覆盖）一次 AI 建议快照。单槽位，不建流水账。"""
    conn = sqlite3.connect(str(path))
    try:
        conn.execute(_SUGGEST_SCHEMA)
        conn.execute(
            "INSERT INTO progress_suggestions (owner_id, project_id, payload, updated_at)"
            " VALUES (?, ?, ?, ?)"
            " ON CONFLICT(owner_id, project_id) DO UPDATE SET"
            " payload = excluded.payload, updated_at = excluded.updated_at",
            (
                owner_id or "",
                project_id,
                json.dumps(payload, ensure_ascii=False),
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        conn.commit()
    finally:
        conn.close()


def load_suggestions(
    path: str | Path,
    owner_id: str,
    project_id: str,
) -> dict[str, Any] | None:
    """读回上次保存的 AI 建议；没有或坏数据返回 None。"""
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    try:
        conn.execute(_SUGGEST_SCHEMA)
        row = conn.execute(
            "SELECT payload FROM progress_suggestions WHERE owner_id = ? AND project_id = ?",
            (owner_id or "", project_id),
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    try:
        parsed = json.loads(row["payload"])
    except (ValueError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else None
