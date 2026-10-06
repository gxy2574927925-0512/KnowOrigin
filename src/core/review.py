"""卡片的间隔重复调度（FSRS）。

为什么复用 ``core/english_vocab.py`` 里的 FSRS，而不引入 PyPI 的 fsrs 包：
  项目里**已经有一份** —— 英语词汇模块在用，纯函数、不碰 DB、不碰网络、已跑通。
  再引一个包等于同一套算法有两份实现：参数口径一旦分叉，学生会看到「英语单词」和
  「专业课卡片」用不同的记忆模型，而且白白多一个依赖。

为什么另开一张表而不是给 ``cards`` 加列：
  ``cards`` 只有 (card_id, project_id, payload, created_at)，业务字段全在 payload JSON 里。
  给它加列要动 ``add_cards`` / ``list_cards`` / ``Card`` 模型 —— 那是 ``get_project`` 等
  既有端点的核心路径，碰了就等于改既有行为。而 SRS 状态本来就是**每个用户各自一份**
  （同一张卡，不同人的复习进度不同），独立成表才对，与 ``en_srs_state`` 的做法一致。

为什么 ``due_at`` 存 ISO 字符串而不是时间戳：
  与项目其余部分一致（``created_at`` / ``updated_at`` 都是 ISO 文本），人肉查库时可直接读。

与既有「卡片自评（5 档）」的关系：
  既有界面用 0~4 五档自评并写 ``learning_events``。本模块用 FSRS 的四档评级；
  两者通过 ``rating_from_recall`` / ``correctness_from_rating`` 双向换算，
  所以复习一次会**同时**更新 SRS 状态与掌握度，不会出现两套口径打架。
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

from .database import new_id, utc_now
from .english_vocab import (
    RATING_AGAIN,
    RATING_EASY,
    RATING_GOOD,
    RATING_HARD,
    RATING_LABELS,
    SrsState,
    normalize_rating,
    parse_iso,
    retrievability,
    to_iso,
)
from .english_vocab import review as fsrs_review

# 一次复习最多取多少张。一次给 200 张只会让人直接关掉页面；
# 到期队列的意义是"今天该做什么"，不是"把欠的全倒出来"。
DEFAULT_QUEUE_SIZE = 30

# 新卡（从未复习过）单次最多混入几张。
# 不限制的话，一个刚导入 500 张卡的项目会瞬间把队列淹没，用户当天就放弃了。
DEFAULT_NEW_CARD_LIMIT = 10

# 负载预测的天数。
FORECAST_DAYS = 7

SCHEMA = """
CREATE TABLE IF NOT EXISTS card_srs_state (
    card_id     TEXT NOT NULL,
    owner_id    TEXT NOT NULL,
    stability   REAL NOT NULL DEFAULT 0,
    difficulty  REAL NOT NULL DEFAULT 0,
    due_at      TEXT NOT NULL,
    reps        INTEGER NOT NULL DEFAULT 0,
    lapses      INTEGER NOT NULL DEFAULT 0,
    state       TEXT NOT NULL DEFAULT 'new',
    last_rating INTEGER,
    last_review TEXT,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (card_id, owner_id)
);
CREATE INDEX IF NOT EXISTS card_srs_due ON card_srs_state(owner_id, due_at);

CREATE TABLE IF NOT EXISTS card_review_log (
    log_id      TEXT PRIMARY KEY,
    card_id     TEXT NOT NULL,
    owner_id    TEXT NOT NULL,
    project_id  TEXT NOT NULL DEFAULT '',
    rating      INTEGER NOT NULL,
    elapsed_ms  INTEGER NOT NULL DEFAULT 0,
    predicted   REAL,
    stability_before REAL NOT NULL DEFAULT 0,
    interval_days    REAL NOT NULL DEFAULT 0,
    self_answer TEXT NOT NULL DEFAULT '',
    before_state TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS card_review_log_owner
    ON card_review_log(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS card_review_log_card
    ON card_review_log(owner_id, card_id, created_at DESC);
"""

# 建表语句只对新库生效；已经建过的库要走 ALTER 补列。
# 仿 ``core/database.py`` 的做法：拿 PRAGMA 问一次，缺了才补，不报错。
_COLUMN_MIGRATIONS = (
    ("card_review_log", "before_state", "TEXT NOT NULL DEFAULT ''"),
)


# --------------------------------------------------------------------------- #
# 双向换算：既有 5 档自评 <-> FSRS 4 档评级
# --------------------------------------------------------------------------- #
# 既有自评档位（static/app.js:11844-11847）：
#   0 ❌ 不会 / 1 ⚠️ 错误 / 2 ❓ 模糊 / 3 ✔️ 会了 / 4 🔥 很熟
# 与之配套的正确度映射（api_server.py:13916）：
#   0→0.00  1→0.25  2→0.55  3→0.85  4→1.00
_RECALL_TO_RATING = {
    0: RATING_AGAIN,
    1: RATING_AGAIN,
    2: RATING_HARD,
    3: RATING_GOOD,
    4: RATING_EASY,
}

# FSRS 评级 → 掌握度用的正确度。刻意与上面那组数字对齐，
# 否则"同一次复习"在两个模块里会得出不同的正确度。
_RATING_TO_CORRECTNESS = {
    RATING_AGAIN: 0.00,
    RATING_HARD: 0.55,
    RATING_GOOD: 0.85,
    RATING_EASY: 1.00,
}


def rating_from_recall(recall: object) -> int:
    """既有 5 档自评 → FSRS 4 档评级。非法值按"模糊"处理而不是抛错。

    这里刻意宽容：自评是用户手点的，为了一个越界的数字让整个复习流程报错不值得。
    """
    try:
        value = int(recall)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return RATING_HARD
    return _RECALL_TO_RATING.get(max(0, min(4, value)), RATING_HARD)


def correctness_from_rating(rating: int) -> float:
    """FSRS 评级 → 掌握度口径的正确度。"""
    return _RATING_TO_CORRECTNESS.get(int(rating), 0.55)


def rating_label(rating: int) -> str:
    return RATING_LABELS.get(int(rating), "模糊")


# --------------------------------------------------------------------------- #
# 状态行 <-> SrsState
# --------------------------------------------------------------------------- #
def _state_from_row(row: sqlite3.Row | None) -> SrsState:
    if row is None:
        return SrsState()
    return SrsState(
        stability=float(row["stability"] or 0.0),
        difficulty=float(row["difficulty"] or 0.0),
        reps=int(row["reps"] or 0),
        lapses=int(row["lapses"] or 0),
        state=str(row["state"] or "new"),
        last_review=parse_iso(row["last_review"]),
    )


def _due_boundary(moment: datetime) -> str:
    """「今天该复习」的时间边界 = 本地当天 23:59:59（转成存储用的 UTC ISO）。

    为什么不用精确时刻比较：FSRS 对「忘了」给出的学习步长只有几分钟到几十分钟，
    那是"今天再来一次"的意思。若按精确时刻判定，用户刚评完「忘了」，
    卡片会立刻从"今天该复习"里消失、要等十来分钟才回来 ——
    界面上就是"点了没反应"，用户只会以为排期坏了。

    口径统一在这里：stats / due_cards / project_status 三处都用同一个边界，
    否则概况页和卡片页会显示两个不同的"待复习"数字。
    """
    local_end = moment.astimezone().replace(hour=23, minute=59, second=59, microsecond=0)
    return to_iso(local_end.astimezone(timezone.utc))


def _state_snapshot(state: SrsState) -> str:
    """把复习**前**的状态存成 JSON，用于「同一天改档位」时回放。

    为什么需要它：卡片上的自评是手点的，4 个按钮挨在一起，点错很常见。
    如果每次都直接推进 FSRS，用户把 1 档改成 4 档就会被推两次间隔 ——
    卡片会"假性地显得很熟"，而这恰好是间隔重复最不能容忍的污染。
    有了快照，同日第二次自评就从原状态重算，等于"改判"，不是"又复习了一次"。
    """
    return json.dumps(
        {
            "stability": float(state.stability),
            "difficulty": float(state.difficulty),
            "reps": int(state.reps),
            "lapses": int(state.lapses),
            "state": str(state.state),
            "last_review": to_iso(state.last_review) if state.last_review else None,
        },
        ensure_ascii=False,
    )


def _state_from_snapshot(raw: str) -> SrsState | None:
    """反序列化快照。任何异常都返回 None（宁可当"没有历史"，也不要炸掉复习）。"""
    if not (raw or "").strip():
        return None
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    try:
        return SrsState(
            stability=float(data.get("stability") or 0.0),
            difficulty=float(data.get("difficulty") or 0.0),
            reps=int(data.get("reps") or 0),
            lapses=int(data.get("lapses") or 0),
            state=str(data.get("state") or "new"),
            last_review=parse_iso(data.get("last_review")),
        )
    except (TypeError, ValueError):
        return None


class ReviewStore:
    """``card_srs_state`` / ``card_review_log`` 的读写。复用主库文件，独立连接。"""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        if str(path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._conn.execute("PRAGMA busy_timeout = 5000")
        self.init_schema()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        try:
            yield self._conn
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise

    def init_schema(self) -> None:
        with self.transaction() as conn:
            conn.executescript(SCHEMA)
            for table, column, ddl in _COLUMN_MIGRATIONS:
                try:
                    existing = {
                        row["name"]
                        for row in conn.execute(f"PRAGMA table_info({table})").fetchall()
                    }
                except sqlite3.Error:
                    continue
                if column in existing:
                    continue
                try:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
                except sqlite3.Error:
                    # 旧库只读/被占用时不该让整个服务起不来：没有这列也只是
                    # 少了「同日改档重算」这一项优化，复习主流程照常。
                    pass

    # -- 读 --------------------------------------------------------------- #
    def state_row(self, owner_id: str, card_id: str) -> sqlite3.Row | None:
        return self._conn.execute(
            "SELECT * FROM card_srs_state WHERE owner_id = ? AND card_id = ?",
            (owner_id or "", card_id),
        ).fetchone()

    def state_of(self, owner_id: str, card_id: str) -> SrsState:
        return _state_from_row(self.state_row(owner_id, card_id))

    def same_day_snapshot(
        self, owner_id: str, card_id: str, *, now: datetime | None = None
    ) -> SrsState | None:
        """今天已经复习过这张卡吗？有的话返回**那次复习之前**的状态。

        日期口径与 ``stats()`` 的 reviewed_today 保持一致（都按本地日期截
        ``created_at[:10]``）。已知这里对 UTC 与本地时区跨日的边界不严谨，
        但两处口径一致才不会出现"一个地方说复习了、另一个说没有"。
        """
        moment = now or utc_now()
        today = moment.astimezone().strftime("%Y-%m-%d")
        row = self._conn.execute(
            "SELECT before_state FROM card_review_log"
            " WHERE owner_id = ? AND card_id = ? AND substr(created_at, 1, 10) = ?"
            " ORDER BY created_at DESC LIMIT 1",
            (owner_id or "", card_id, today),
        ).fetchone()
        if row is None:
            return None
        return _state_from_snapshot(row["before_state"])

    def drop_same_day_logs(
        self, owner_id: str, card_id: str, *, now: datetime | None = None
    ) -> int:
        """删掉今天这张卡已有的复习日志，返回删除条数。

        改判时用。不删的话，「今日已复习」会数成 2（一张卡算两次），
        "最近复习"列表里也会同一张卡连着出现两行 —— 用户看到的就是数字不对。
        日志是**最终判定**的记录，不是每次点击的记录。
        """
        moment = now or utc_now()
        today = moment.astimezone().strftime("%Y-%m-%d")
        with self.transaction() as conn:
            cursor = conn.execute(
                "DELETE FROM card_review_log"
                " WHERE owner_id = ? AND card_id = ? AND substr(created_at, 1, 10) = ?",
                (owner_id or "", card_id, today),
            )
            return int(cursor.rowcount or 0)

    def due_cards(
        self,
        owner_id: str,
        *,
        project_id: str = "",
        limit: int = DEFAULT_QUEUE_SIZE,
        new_limit: int = DEFAULT_NEW_CARD_LIMIT,
        now: datetime | None = None,
    ) -> list[dict[str, Any]]:
        """到期队列：**已到期的旧卡** + 有限张**从未复习过的新卡**。

        `cards` 表没有 owner_id，所以经 ``projects`` 关联取归属 —— 顺带做了一层
        越权防护：别人的卡片不会因为 card_id 泄漏而出现在我的队列里。
        """
        moment = now or utc_now()
        # 边界用「今天结束」而不是此刻：见 _due_boundary 的说明
        stamp = _due_boundary(moment)
        clause = " AND c.project_id = ?" if project_id else ""
        base_args: list[Any] = [owner_id or ""]
        if project_id:
            base_args.append(project_id)

        rows = self._conn.execute(
            "SELECT c.card_id, c.payload, c.project_id AS project_id,"
            " s.stability, s.difficulty, s.due_at, s.reps, s.lapses, s.state,"
            " s.last_review"
            " FROM cards c"
            " JOIN projects p ON p.project_id = c.project_id"
            " LEFT JOIN card_srs_state s"
            "   ON s.card_id = c.card_id AND s.owner_id = p.owner_id"
            " WHERE p.owner_id = ?" + clause +
            "   AND (s.due_at IS NULL OR s.due_at <= ?)"
            # 新卡（s.due_at IS NULL）排在前面：先建立记忆，再谈复习
            " ORDER BY (s.due_at IS NULL) DESC, s.due_at ASC, c.created_at ASC"
            " LIMIT ?",
            tuple(base_args + [stamp, max(1, int(limit) + max(0, int(new_limit)))]),
        ).fetchall()

        due: list[dict[str, Any]] = []
        fresh_used = 0
        for row in rows:
            is_new = row["due_at"] is None
            if is_new:
                if fresh_used >= max(0, int(new_limit)):
                    continue
                fresh_used += 1
            due.append(self._card_payload(row, is_new=is_new, now=moment))
            if len(due) >= max(1, int(limit)):
                break
        return due

    def _card_payload(
        self, row: sqlite3.Row, *, is_new: bool, now: datetime
    ) -> dict[str, Any]:
        try:
            card = json.loads(row["payload"] or "{}")
        except Exception:
            card = {}
        due_at = parse_iso(row["due_at"]) if row["due_at"] else None
        state = SrsState(
            stability=float(row["stability"] or 0.0),
            difficulty=float(row["difficulty"] or 0.0),
            reps=int(row["reps"] or 0),
            lapses=int(row["lapses"] or 0),
            state=str(row["state"] or "new"),
            last_review=parse_iso(row["last_review"]),
        )
        predicted = None
        if state.stability > 0 and state.last_review is not None:
            elapsed = max(0.0, (now - state.last_review).total_seconds() / 86400.0)
            predicted = round(retrievability(elapsed, state.stability), 3)
        return {
            "card_id": row["card_id"],
            "project_id": row["project_id"],
            "front": str(card.get("front") or ""),
            "back": str(card.get("back") or ""),
            "category": str(card.get("category") or ""),
            "difficulty": int(card.get("difficulty") or 1),
            "node_ids": card.get("node_ids") or [],
            # 来自知识点文档时给出处小节；空串 = 与文档无关，前端据此隐藏「回到文档」
            "origin_section": str(card.get("origin_section") or ""),
            "is_new": is_new,
            "due_at": row["due_at"],
            "reps": state.reps,
            "lapses": state.lapses,
            "stability": round(state.stability, 2),
            # 复习前模型预测的"还记得的概率"。这是 FSRS 校准的关键输入：
            # 攒够样本后可以用它反推参数，也能直接告诉用户"你高估/低估了自己"。
            "predicted": predicted,
        }

    def stats(self, owner_id: str, *, project_id: str = "", now: datetime | None = None) -> dict[str, Any]:
        """复习面板顶部要的数字。"""
        moment = now or utc_now()
        # 边界用「今天结束」而不是此刻：见 _due_boundary 的说明
        stamp = _due_boundary(moment)
        clause = " AND c.project_id = ?" if project_id else ""
        args: list[Any] = [owner_id or ""]
        if project_id:
            args.append(project_id)

        row = self._conn.execute(
            "SELECT"
            " COUNT(*) AS total,"
            " SUM(CASE WHEN s.due_at IS NULL THEN 1 ELSE 0 END) AS fresh,"
            " SUM(CASE WHEN s.due_at IS NOT NULL AND s.due_at <= ? THEN 1 ELSE 0 END) AS due,"
            " SUM(CASE WHEN s.due_at IS NOT NULL THEN 1 ELSE 0 END) AS started,"
            " SUM(CASE WHEN s.state = 'review' THEN 1 ELSE 0 END) AS in_review"
            " FROM cards c JOIN projects p ON p.project_id = c.project_id"
            " LEFT JOIN card_srs_state s ON s.card_id = c.card_id AND s.owner_id = p.owner_id"
            " WHERE p.owner_id = ?" + clause,
            tuple([stamp] + args),
        ).fetchone()

        today = moment.astimezone().strftime("%Y-%m-%d")
        reviewed_today = self._conn.execute(
            # DISTINCT card_id：用户量的是"今天复习了几张卡"，不是"写了几条日志"。
            # 改判路径已经会清掉旧日志，这里再兜一层防止历史数据把数字抬高。
            "SELECT COUNT(DISTINCT card_id) AS n FROM card_review_log"
            " WHERE owner_id = ? AND substr(created_at, 1, 10) = ?",
            (owner_id or "", today),
        ).fetchone()

        return {
            "total_cards": int(row["total"] or 0),
            "due_cards": int(row["due"] or 0),
            "new_cards": int(row["fresh"] or 0),
            "started_cards": int(row["started"] or 0),
            "in_review_cards": int(row["in_review"] or 0),
            "reviewed_today": int(reviewed_today["n"] or 0),
            "project_id": project_id,
        }

    def project_status(
        self, owner_id: str, project_id: str, *, now: datetime | None = None
    ) -> dict[str, Any]:
        """一个项目里所有卡片的排期状态，一次取回。

        这是「复习长在卡片上」的关键：卡片列表要能给每张卡直接标出
        「今天该复习」还是「5 天后」，而不是让用户去另一个页面才知道。
        卡片可能有几百张，所以按项目一次取全，别让前端逐张问 ——
        那会变成几百个请求。

        返回 ``due_ids``（今天到期）与 ``scheduled``（还没到期，含剩余天数）。
        两者都没记录的卡片 = 新卡，由前端按"无排期"处理，不在这里展开。
        """
        moment = now or utc_now()
        boundary = _due_boundary(moment)
        today_day = moment.astimezone().date()
        rows = self._conn.execute(
            "SELECT c.card_id AS card_id, s.due_at AS due_at, s.state AS state,"
            " s.reps AS reps, s.lapses AS lapses, s.difficulty AS difficulty"
            " FROM cards c JOIN projects p ON p.project_id = c.project_id"
            " LEFT JOIN card_srs_state s"
            "   ON s.card_id = c.card_id AND s.owner_id = p.owner_id"
            " WHERE p.owner_id = ? AND c.project_id = ?",
            (owner_id or "", project_id),
        ).fetchall()

        due_ids: list[str] = []
        scheduled: dict[str, Any] = {}
        for row in rows:
            if row["due_at"] is None:
                continue  # 新卡：还没建立排期
            parsed = parse_iso(row["due_at"])
            if parsed is None:
                continue
            if str(row["due_at"]) <= boundary:
                due_ids.append(row["card_id"])
                continue
            # days_left 用**日历天差**而不是精确小时数：界面上要显示「明天」
            # 而不是「0.9 天后」，那个数字对用户没有意义。
            scheduled[row["card_id"]] = {
                "due_at": row["due_at"],
                "days_left": (parsed.astimezone().date() - today_day).days,
                "state": str(row["state"] or "new"),
                "reps": int(row["reps"] or 0),
            }

        today = moment.astimezone().strftime("%Y-%m-%d")
        reviewed_today = self._conn.execute(
            # DISTINCT card_id：用户量的是"今天复习了几张卡"，不是"写了几条日志"。
            # 改判路径已经会清掉旧日志，这里再兜一层防止历史数据把数字抬高。
            "SELECT COUNT(DISTINCT card_id) AS n FROM card_review_log"
            " WHERE owner_id = ? AND substr(created_at, 1, 10) = ?",
            (owner_id or "", today),
        ).fetchone()

        total = len(rows)
        return {
            "project_id": project_id,
            "total_cards": total,
            "due_ids": due_ids,
            "due_count": len(due_ids),
            "scheduled": scheduled,
            "scheduled_count": len(scheduled),
            "new_count": max(0, total - len(due_ids) - len(scheduled)),
            "reviewed_today": int(reviewed_today["n"] or 0),
        }

    def forecast(self, owner_id: str, *, days: int = FORECAST_DAYS, now: datetime | None = None) -> list[dict[str, Any]]:
        """未来若干天每天到期的卡片数（负载预测）。

        来自 fsrs4anki 的"复习债"思路：不预测的话，用户会在某天突然面对 200 张到期卡，
        然后放弃。有了这张表，"今天要不要多学 10 张新卡"才有依据。
        """
        moment = now or utc_now()
        buckets: dict[str, int] = {}
        rows = self._conn.execute(
            "SELECT due_at FROM card_srs_state WHERE owner_id = ? AND due_at > ?",
            (owner_id or "", to_iso(moment)),
        ).fetchall()
        for row in rows:
            parsed = parse_iso(row["due_at"])
            if parsed is None:
                continue
            key = parsed.astimezone().strftime("%Y-%m-%d")
            buckets[key] = buckets.get(key, 0) + 1
        today = moment.astimezone()
        return [
            {
                "day": (today + timedelta(days=offset)).strftime("%Y-%m-%d"),
                "count": buckets.get(
                    (today + timedelta(days=offset)).strftime("%Y-%m-%d"), 0
                ),
            }
            for offset in range(0, max(1, int(days)))
        ]

    def card_context(self, card_id: str) -> dict[str, Any] | None:
        """取一张卡的归属与关联知识点。卡片不存在时返回 None。

        提交复习时要**同步写一条掌握度证据**（否则"复习了但掌握度不动"，两个模块各说各话），
        所以这里直接把 owner_id / project_id / node_ids 一次取回。
        直接读 ``cards.payload`` 而不是走 ``Database.list_cards`` —— 后者是全量查询，
        为了找一张卡把整个项目的卡都反序列化一遍不划算。
        """
        row = self._conn.execute(
            "SELECT c.payload AS payload, c.project_id AS project_id,"
            " p.owner_id AS owner_id"
            " FROM cards c JOIN projects p ON p.project_id = c.project_id"
            " WHERE c.card_id = ?",
            (card_id,),
        ).fetchone()
        if row is None:
            return None
        try:
            payload = json.loads(row["payload"] or "{}")
        except Exception:
            payload = {}
        raw_nodes = payload.get("node_ids") or []
        return {
            "owner_id": row["owner_id"],
            "project_id": row["project_id"],
            "node_ids": [str(item) for item in raw_nodes if item],
            # 掌握度增益现在读难度与题面指纹（core/framework.record_evidence），
            # 所以这里要把它们一并带出来 —— 卡片复习是掌握度证据的大头，
            # 少这两个字段就等于难度加权和边际递减对「卡片」这一路整体失效。
            "card_difficulty": int(payload.get("difficulty") or 1),
            "card_front": str(payload.get("front") or ""),
        }

    def recent_logs(self, owner_id: str, *, limit: int = 30) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT * FROM card_review_log WHERE owner_id = ?"
            " ORDER BY created_at DESC LIMIT ?",
            (owner_id or "", max(1, int(limit))),
        ).fetchall()
        return [
            {
                "card_id": row["card_id"],
                "rating": int(row["rating"] or 0),
                "rating_label": rating_label(row["rating"]),
                "elapsed_ms": int(row["elapsed_ms"] or 0),
                "predicted": row["predicted"],
                "interval_days": float(row["interval_days"] or 0),
                "has_self_answer": bool((row["self_answer"] or "").strip()),
                "created_at": row["created_at"],
            }
            for row in rows
        ]

    # -- 写 --------------------------------------------------------------- #
    def save_state(
        self,
        owner_id: str,
        card_id: str,
        state: SrsState,
        due_at: datetime,
        *,
        rating: int,
        now: datetime | None = None,
    ) -> None:
        # updated_at 用业务时间而不是墙钟：同日判定全部基于这些时间戳，
        # 两边一旦各走各的时钟，"今天复习过吗"就会答错（测试注入固定时间
        # 正是为了钉住这条一致性）。
        stamp = to_iso(now or utc_now())
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO card_srs_state(card_id, owner_id, stability, difficulty,"
                " due_at, reps, lapses, state, last_rating, last_review, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
                " ON CONFLICT(card_id, owner_id) DO UPDATE SET"
                " stability = excluded.stability, difficulty = excluded.difficulty,"
                " due_at = excluded.due_at, reps = excluded.reps, lapses = excluded.lapses,"
                " state = excluded.state, last_rating = excluded.last_rating,"
                " last_review = excluded.last_review, updated_at = excluded.updated_at",
                (
                    card_id,
                    owner_id or "",
                    float(state.stability),
                    float(state.difficulty),
                    to_iso(due_at),
                    int(state.reps),
                    int(state.lapses),
                    state.state,
                    int(rating),
                    to_iso(state.last_review) if state.last_review else None,
                    stamp,
                ),
            )

    def log_review(
        self,
        *,
        owner_id: str,
        card_id: str,
        project_id: str,
        rating: int,
        elapsed_ms: int = 0,
        predicted: float | None = None,
        stability_before: float = 0.0,
        interval_days: float = 0.0,
        self_answer: str = "",
        before_state: str = "",
        now: datetime | None = None,
    ) -> None:
        # created_at 必须与提交复习时的业务时间一致 —— same_day_snapshot /
        # drop_same_day_logs / 「今日已复习」全都按这个日期做同日判定。
        stamp = to_iso(now or utc_now())
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO card_review_log(log_id, card_id, owner_id, project_id,"
                " rating, elapsed_ms, predicted, stability_before, interval_days,"
                " self_answer, before_state, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    new_id("rvw"),
                    card_id,
                    owner_id or "",
                    project_id or "",
                    int(rating),
                    max(0, int(elapsed_ms)),
                    predicted,
                    float(stability_before),
                    float(interval_days),
                    (self_answer or "")[:2000],
                    before_state or "",
                    stamp,
                ),
            )


# --------------------------------------------------------------------------- #
# 提交一次复习
# --------------------------------------------------------------------------- #
def submit_review(
    store: ReviewStore,
    *,
    owner_id: str,
    card_id: str,
    project_id: str = "",
    rating: object,
    elapsed_ms: int = 0,
    self_answer: str = "",
    now: datetime | None = None,
    replace_same_day: bool = True,
) -> dict[str, Any]:
    """提交一次复习：推进 FSRS 状态、写复习日志，返回下一步信息。

    返回里的 ``interval_days`` 与 ``due_at`` 是给界面直接显示"下次什么时候见"的 ——
    间隔重复最需要正反馈的就是这一句，别让用户去猜。

    ``replace_same_day``：同一天对同一张卡的第二次自评按"改判"处理（从复习前的
    状态重算），而不是再推一次。卡片上的四档按钮挨在一起，点错要能改；
    否则手抖一次就把间隔推远了。
    """
    moment = now or utc_now()
    rating_value = normalize_rating(rating)

    before = store.state_of(owner_id, card_id)
    replaced_same_day = False
    if replace_same_day:
        restored = store.same_day_snapshot(owner_id, card_id, now=moment)
        if restored is not None:
            before = restored
            replaced_same_day = True

    predicted = None
    if before.stability > 0 and before.last_review is not None:
        elapsed = max(0.0, (moment - before.last_review).total_seconds() / 86400.0)
        predicted = round(retrievability(elapsed, before.stability), 3)

    after, due_at = fsrs_review(before, rating_value, now=moment)
    store.save_state(owner_id, card_id, after, due_at, rating=rating_value, now=moment)

    interval = max(0.0, (due_at - moment).total_seconds() / 86400.0)
    if replaced_same_day:
        # 先清掉今天这条卡的旧日志：改判只应留下**最终判定**一条，
        # 否则「今日已复习」会数成 2（一张卡算两次）。
        store.drop_same_day_logs(owner_id, card_id, now=moment)
    store.log_review(
        owner_id=owner_id,
        card_id=card_id,
        project_id=project_id,
        rating=rating_value,
        elapsed_ms=elapsed_ms,
        predicted=predicted,
        stability_before=before.stability,
        interval_days=interval,
        self_answer=self_answer,
        before_state=_state_snapshot(before),
        now=moment,
    )

    return {
        "rating": rating_value,
        "rating_label": rating_label(rating_value),
        "correctness": correctness_from_rating(rating_value),
        "state": after.state,
        "reps": after.reps,
        "lapses": after.lapses,
        "stability": round(after.stability, 2),
        "interval_days": round(interval, 1),
        "due_at": to_iso(due_at),
        "predicted_before": predicted,
        "is_lapse": rating_value == RATING_AGAIN and before.stability > 0,
        "self_answer_saved": bool((self_answer or "").strip()),
        "replaced_same_day": replaced_same_day,
    }


def interval_preview(
    store: ReviewStore, *, owner_id: str, card_id: str, now: datetime | None = None
) -> dict[str, Any]:
    """预览四个评级各自会把下次复习推到多久 —— 给四个按钮标注"4 天 / 12 天"。

    用户在 Again 和 Easy 之间犹豫时，唯一能帮他决策的信息就是"选这个下次什么时候见"。
    """
    moment = now or utc_now()
    state = store.state_of(owner_id, card_id)
    out: dict[str, Any] = {}
    for rating in (RATING_AGAIN, RATING_HARD, RATING_GOOD, RATING_EASY):
        _, due_at = fsrs_review(state, rating, now=moment, fuzz=False)
        days = max(0.0, (due_at - moment).total_seconds() / 86400.0)
        out[str(rating)] = {
            "label": rating_label(rating),
            "days": round(days, 1),
            "due_at": to_iso(due_at),
        }
    return out


def retention_of(
    store: ReviewStore, *, owner_id: str, card_id: str, now: datetime | None = None
) -> float | None:
    """当前这张卡"还记得的概率"。没有历史时返回 None。"""
    moment = now or utc_now()
    state = store.state_of(owner_id, card_id)
    if state.stability <= 0 or state.last_review is None:
        return None
    elapsed = max(0.0, (moment - state.last_review).total_seconds() / 86400.0)
    return round(retrievability(elapsed, state.stability), 3)
