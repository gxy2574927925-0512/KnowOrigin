"""通知中心与周报：把「已经发生的学习」主动告诉用户一次。

为什么需要它：
  知源已经有 ``learning_events``、打卡日历、掌握度曲线 —— 但它们**全部是被动的**：
  用户得自己点开学概览才看得到。而"学过就忘"的另一半是"根本不知道自己这周学了什么"。
  这个模块补的就是那一半：把已经躺在库里的数据，主动翻译成一句人话。

为什么用**懒触发**而不是定时任务：
  这是本地优先产品，用户关掉浏览器后进程就没了，没有任何东西会替他在凌晨跑 cron。
  所以生成时机统一挂在"用户自己打开面板的那一刻"：做几条 SQL 聚合，几乎零成本，
  而且**绝不会在他不在场时偷偷调用模型花钱**。

为什么去重靠 ``dedupe_key`` 唯一索引：
  懒触发意味着"打开一次就检查一次"，没有去重就会每次打开都塞一条新通知。
  唯一索引让重复写入直接失败，这比"先查再写"更可靠 —— 后者在并发下会漏。
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

from .database import new_id, utc_now

# 通知类型与中文标签。
#
# ⚠️ 2026-09-25：前端的通知中心（未读角标 / 列表 / 已读 / 清空）已按用户要求**整块删除**，
# 原「通知中心 + AI 用量」的合并入口拆成了只留用量的 ``usage-ui.js``（挂在聊天输入框旁）。
# 后端生成逻辑与 ``/api/notices/*`` 端点**保持原样未动**（属于"不改既有端点行为"的硬约束）——
# 也就是说通知目前仍在正常写入 notices 表，只是暂时没有界面消费它们。
# 若将来要恢复展示，``KIND_LABELS`` 可直接当分组标题用；若要彻底停掉，
# 需要单独确认（停掉会同时影响 ``/api/notices/*`` 与生成它们的定时任务）。
KINDS = ("daily", "weekly", "streak", "memory", "system")

KIND_LABELS = {
    "daily": "今日小结",
    "weekly": "周报",
    "streak": "打卡提醒",
    "memory": "AI 记忆",
    "system": "系统",
}

# 保留的通知条数上限（每用户）。通知是"看一眼就过"的东西，
# 攒到几百条只会让列表变成垃圾场；超出的旧通知在写入时顺手清理。
NOTICE_KEEP = 60

# 周报里最多提几个薄弱节点。多了会变成一份清单而不是一句提醒。
WEEKLY_WEAK_LIMIT = 5

SCHEMA = """
CREATE TABLE IF NOT EXISTS notices (
    notice_id  TEXT PRIMARY KEY,
    owner_id   TEXT NOT NULL,
    kind       TEXT NOT NULL,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    meta       TEXT NOT NULL DEFAULT '{}',
    read_at    TEXT,
    created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS notices_dedupe ON notices(owner_id, dedupe_key);
CREATE INDEX IF NOT EXISTS notices_owner ON notices(owner_id, created_at DESC);
"""


# --------------------------------------------------------------------------- #
# 日期口径：与既有 streak / 日历保持一致，统一用 **UTC**
# --------------------------------------------------------------------------- #
# 这里的取舍值得写清楚：
#   AI 用量限额用的是**本地**日期（用户问"今天还剩多少"，答的必须是他的今天）；
#   而学习统计沿用 learning_events 的既有口径 —— ``substr(created_at, 1, 10)`` 是 UTC。
#   两者确实不同，但**同一件事不能有两套口径**：打卡数字若用本地日期重算，就会出现
#   "徽章说连续 5 天、通知说连续 4 天"这种自相矛盾。所以这里跟着既有实现走。
def today_utc() -> date:
    return datetime.now(timezone.utc).date()


def week_key(moment: datetime | None = None) -> str:
    """ISO 周标识，如 ``2026-W39``。"""
    anchor = (moment or datetime.now(timezone.utc)).date()
    year, week, _ = anchor.isocalendar()
    return f"{year}-W{week:02d}"


def compute_streak(active_dates: set[date]) -> dict[str, Any]:
    """连续打卡统计。

    .. warning::
       **必须与 ``api_server.py`` 的 ``/api/me/streak`` 端点保持同一算法。**
       两处算不一致，用户会同时看到两个不同的连续天数。改动其中一处时，
       请一并改另一处，并跑 ``tools/_notice_test.py`` 里的对照用例。
    """
    today = today_utc()
    yesterday = today - timedelta(days=1)
    # 今天还没学但昨天学了，连续记录仍然"活着"（到 UTC 零点为止）
    credential = today if today in active_dates else (
        yesterday if yesterday in active_dates else None
    )
    current = 0
    if credential is not None:
        cursor = credential
        while cursor in active_dates:
            current += 1
            cursor -= timedelta(days=1)

    longest = 0
    run = 0
    previous: date | None = None
    for day in sorted(active_dates):
        run = 1 if previous is None or (day - previous).days != 1 else run + 1
        longest = max(longest, run)
        previous = day

    return {
        "today_active": today in active_dates,
        "current_streak": current,
        "longest_streak": longest,
        "total_active_days": len(active_dates),
    }


# --------------------------------------------------------------------------- #
# 存储
# --------------------------------------------------------------------------- #
class NoticeStore:
    """``notices`` 表的读写。复用主库文件，独立连接。"""

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

    # -- 写 --------------------------------------------------------------- #
    def push(
        self,
        owner_id: str,
        kind: str,
        title: str,
        body: str,
        *,
        dedupe_key: str,
        meta: dict[str, Any] | None = None,
    ) -> bool:
        """写入一条通知。``dedupe_key`` 重复时返回 False（不覆盖、不报错）。

        用 ``INSERT OR IGNORE`` + 唯一索引，而不是"先 SELECT 再 INSERT"：
        懒触发意味着"每打开一次检查一次"，先查再写在并发下会漏。
        """
        with self.transaction() as conn:
            cursor = conn.execute(
                "INSERT OR IGNORE INTO notices(notice_id, owner_id, kind, title, body,"
                " dedupe_key, meta, read_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
                (
                    new_id("ntc"),
                    owner_id or "",
                    kind,
                    title,
                    body,
                    dedupe_key,
                    json.dumps(meta or {}, ensure_ascii=False),
                    utc_now().isoformat(),
                ),
            )
            created = bool(cursor.rowcount)
        if created:
            self._trim(owner_id)
        return created

    def _trim(self, owner_id: str) -> None:
        """只保留最近 ``NOTICE_KEEP`` 条。"""
        try:
            with self.transaction() as conn:
                conn.execute(
                    "DELETE FROM notices WHERE owner_id = ? AND notice_id NOT IN ("
                    " SELECT notice_id FROM notices WHERE owner_id = ?"
                    " ORDER BY created_at DESC LIMIT ?)",
                    (owner_id or "", owner_id or "", NOTICE_KEEP),
                )
        except Exception:
            pass

    def mark_read(self, owner_id: str, notice_id: str = "") -> int:
        """标记已读。``notice_id`` 为空时全部标记已读。"""
        with self.transaction() as conn:
            if notice_id:
                cursor = conn.execute(
                    "UPDATE notices SET read_at = ? WHERE owner_id = ? AND notice_id = ?"
                    " AND read_at IS NULL",
                    (utc_now().isoformat(), owner_id or "", notice_id),
                )
            else:
                cursor = conn.execute(
                    "UPDATE notices SET read_at = ? WHERE owner_id = ? AND read_at IS NULL",
                    (utc_now().isoformat(), owner_id or ""),
                )
            return int(cursor.rowcount or 0)

    def delete(self, owner_id: str, notice_id: str) -> bool:
        with self.transaction() as conn:
            cursor = conn.execute(
                "DELETE FROM notices WHERE owner_id = ? AND notice_id = ?",
                (owner_id or "", notice_id),
            )
            return bool(cursor.rowcount)

    def clear(self, owner_id: str) -> int:
        with self.transaction() as conn:
            cursor = conn.execute(
                "DELETE FROM notices WHERE owner_id = ?", (owner_id or "",)
            )
            return int(cursor.rowcount or 0)

    # -- 读 --------------------------------------------------------------- #
    def list_notices(
        self, owner_id: str, *, limit: int = 40, unread_only: bool = False
    ) -> list[dict[str, Any]]:
        sql = "SELECT * FROM notices WHERE owner_id = ?"
        args: list[Any] = [owner_id or ""]
        if unread_only:
            sql += " AND read_at IS NULL"
        sql += " ORDER BY created_at DESC LIMIT ?"
        args.append(max(1, int(limit)))
        rows = self._conn.execute(sql, tuple(args)).fetchall()
        return [_notice_row(row) for row in rows]

    def unread_count(self, owner_id: str) -> int:
        row = self._conn.execute(
            "SELECT COUNT(*) AS total FROM notices WHERE owner_id = ? AND read_at IS NULL",
            (owner_id or "",),
        ).fetchone()
        return int(row["total"] or 0)

    def has(self, owner_id: str, dedupe_key: str) -> bool:
        row = self._conn.execute(
            "SELECT 1 FROM notices WHERE owner_id = ? AND dedupe_key = ? LIMIT 1",
            (owner_id or "", dedupe_key),
        ).fetchone()
        return row is not None

    # -- 统计（读主库既有表，不新建表） ------------------------------------ #
    def learning_dates(self, owner_id: str) -> set[date]:
        """该用户有过学习行为的 UTC 日期集合。

        与 ``Database.list_user_activity_dates`` 同口径（同一张表、同一种日期截取），
        刻意重复这几行 SQL 而不是跨模块调用：那边是主库实例的方法，这里持有的是独立
        连接，为了复用而把两个 store 串起来，耦合成本大于收益。
        """
        rows = self._conn.execute(
            "SELECT DISTINCT substr(e.created_at, 1, 10) AS day"
            " FROM learning_events e JOIN projects p ON p.project_id = e.project_id"
            " WHERE p.owner_id = ? AND e.created_at IS NOT NULL"
            " AND length(e.created_at) >= 10",
            (owner_id or "",),
        ).fetchall()
        out: set[date] = set()
        for row in rows:
            try:
                out.add(date.fromisoformat(row["day"]))
            except (TypeError, ValueError):
                continue
        return out

    def stats_between(self, owner_id: str, start: date, end: date) -> dict[str, Any]:
        """``[start, end)`` 区间的学习统计。"""
        rows = self._conn.execute(
            "SELECT e.kind AS kind, e.correctness AS correctness,"
            " e.node_id AS node_id, e.project_id AS project_id,"
            " p.subject AS project_name, n.name AS node_name"
            " FROM learning_events e JOIN projects p ON p.project_id = e.project_id"
            " LEFT JOIN framework_nodes n ON n.project_id = e.project_id"
            " AND n.node_id = e.node_id"
            " WHERE p.owner_id = ? AND e.created_at IS NOT NULL"
            " AND substr(e.created_at, 1, 10) >= ? AND substr(e.created_at, 1, 10) < ?",
            (owner_id or "", start.isoformat(), end.isoformat()),
        ).fetchall()

        kinds: dict[str, int] = {}
        projects: set[str] = set()
        nodes: set[str] = set()
        graded = 0
        correct_sum = 0.0
        # 按节点聚合正确率，用来找薄弱点
        per_node: dict[str, dict[str, Any]] = {}
        for row in rows:
            kind = row["kind"] or "other"
            kinds[kind] = kinds.get(kind, 0) + 1
            if row["project_id"]:
                projects.add(row["project_id"])
            if row["node_id"]:
                nodes.add(row["node_id"])
            correctness = row["correctness"]
            if correctness is not None:
                graded += 1
                correct_sum += float(correctness)
                node_id = row["node_id"]
                if node_id:
                    bucket = per_node.setdefault(
                        node_id,
                        {"name": row["node_name"] or "", "n": 0, "sum": 0.0},
                    )
                    bucket["n"] += 1
                    bucket["sum"] += float(correctness)
                    if not bucket["name"] and row["node_name"]:
                        bucket["name"] = row["node_name"]

        weak = [
            {
                "node_id": node_id,
                "name": bucket["name"],
                "samples": bucket["n"],
                "accuracy": round(bucket["sum"] / bucket["n"], 3),
            }
            for node_id, bucket in per_node.items()
            if bucket["n"] >= 2 and bucket["name"]
        ]
        weak.sort(key=lambda item: (item["accuracy"], -item["samples"]))

        return {
            "events": len(rows),
            "kinds": kinds,
            "projects": len(projects),
            "nodes": len(nodes),
            "graded": graded,
            "accuracy": round(correct_sum / graded, 3) if graded else None,
            "weak_nodes": weak[:WEEKLY_WEAK_LIMIT],
        }


def _notice_row(row: sqlite3.Row) -> dict[str, Any]:
    try:
        meta = json.loads(row["meta"] or "{}")
    except Exception:
        meta = {}
    if not isinstance(meta, dict):
        meta = {}
    return {
        "notice_id": row["notice_id"],
        "kind": row["kind"],
        "kind_label": KIND_LABELS.get(row["kind"], "通知"),
        "title": row["title"],
        "body": row["body"],
        "meta": meta,
        "read": row["read_at"] is not None,
        "created_at": row["created_at"],
    }


# --------------------------------------------------------------------------- #
# 生成：纯本地的那几类
# --------------------------------------------------------------------------- #
_KIND_LABELS_CN = {
    "question": "提问",
    "card": "翻卡",
    "quiz": "做题",
    "discussion": "讨论",
    "note": "笔记",
    "favorite": "收藏",
}


def _kinds_text(kinds: dict[str, int]) -> str:
    if not kinds:
        return ""
    ordered = sorted(kinds.items(), key=lambda item: -item[1])
    return "、".join(
        f"{_KIND_LABELS_CN.get(name, name)} {count} 次" for name, count in ordered[:4]
    )


def build_daily_body(stats: dict[str, Any]) -> str:
    """今日小结正文。**只陈述库里真实存在的数字**，不补任何修饰。"""
    if stats["events"] <= 0:
        return ""
    parts = [f"今天有 {stats['events']} 次学习动作"]
    kinds = _kinds_text(stats["kinds"])
    if kinds:
        parts.append(f"（{kinds}）")
    sentence = "".join(parts) + "。"
    extra = []
    if stats["nodes"]:
        extra.append(f"覆盖 {stats['nodes']} 个知识点")
    if stats["accuracy"] is not None and stats["graded"] >= 3:
        extra.append(f"已判分题目正确率 {round(stats['accuracy'] * 100)}%")
    if extra:
        sentence += "".join(extra) + "。"
    return sentence


def build_streak_body(streak: dict[str, Any]) -> str:
    current = int(streak.get("current_streak") or 0)
    if current <= 0:
        return ""
    if streak.get("today_active"):
        return f"今天已经学过了，连续 {current} 天保持中。"
    return (
        f"连续 {current} 天，但今天还没开始 —— "
        "在你那边的零点之前学一点，记录就不会断。"
    )


def build_weekly_fallback(
    stats: dict[str, Any], streak: dict[str, Any]
) -> str:
    """没有模型可用时的周报正文。纯统计，仍然具体。"""
    if stats["events"] <= 0:
        return ""
    lines = [
        f"本周共 {stats['events']} 次学习动作，涉及 {stats['projects']} 个课程项目、"
        f"{stats['nodes']} 个知识点。"
    ]
    kinds = _kinds_text(stats["kinds"])
    if kinds:
        lines.append(f"构成：{kinds}。")
    if stats["accuracy"] is not None and stats["graded"] >= 3:
        lines.append(f"已判分题目正确率 {round(stats['accuracy'] * 100)}%。")
    if streak.get("current_streak"):
        lines.append(f"连续打卡 {streak['current_streak']} 天。")
    if stats["weak_nodes"]:
        names = "、".join(
            f"「{item['name']}」({round(item['accuracy'] * 100)}%)"
            for item in stats["weak_nodes"][:3]
        )
        lines.append(f"正确率偏低、值得回看的节点：{names}。")
    return "".join(lines)


WEEKLY_SYSTEM_PROMPT = """你在为一位学生写一份简短的学习周报。

要求：
- 只使用给定数据里存在的数字与节点名，**不要编造**任何学习内容、时长或成绩
- 3 到 5 句话，不要分点、不要标题、不要开场寒暄
- 语气像一个了解他的助教：先给事实，再给一条具体的下一步建议
- 建议必须落在给定数据里出现过的节点或科目上，不要说"继续保持"这类空话
- 用第二人称"你"

直接输出正文，不要任何额外说明。"""


def build_weekly_prompt(
    stats: dict[str, Any], streak: dict[str, Any], owner_name: str
) -> str:
    """把统计压成模型能读的一小段。**不含任何学生资料正文** —— 周报只需要数字。"""
    payload: dict[str, Any] = {
        "stats": {
            "events": stats["events"],
            "kinds": stats["kinds"],
            "projects": stats["projects"],
            "nodes": stats["nodes"],
            "accuracy": stats["accuracy"],
        },
        "streak": streak,
        "weak_nodes": [
            {"name": item["name"], "accuracy": item["accuracy"]}
            for item in stats["weak_nodes"]
        ],
    }
    name = (owner_name or "").strip()
    if name:
        payload["learner"] = name
    return json.dumps(payload, ensure_ascii=False)


def compose_weekly(
    llm: Any,
    stats: dict[str, Any],
    streak: dict[str, Any],
    owner_name: str = "",
    *,
    charge: Any = None,
) -> str:
    """生成周报正文。模型不可用时退回本地统计文本。

    ``llm`` 必须是**原始客户端**，理由同 ``core/user_memory.py``：
    走代理会把自己记进账、并再次触发提取，形成递归。
    """
    fallback = build_weekly_fallback(stats, streak)
    if llm is None or stats["events"] <= 0:
        return fallback
    payload = build_weekly_prompt(stats, streak, owner_name)
    messages = [
        {"role": "system", "content": WEEKLY_SYSTEM_PROMPT},
        {"role": "user", "content": payload},
    ]
    chunks: list[str] = []
    try:
        for chunk in llm.stream_chat_content(messages, "weekly_report"):
            if chunk:
                chunks.append(chunk)
    except Exception:
        return fallback
    text = "".join(chunks).strip()
    if charge is not None:
        try:
            charge(payload, text)
        except Exception:
            pass
    # 模型偶尔会加上标题或礼帽句；正文太短说明它跑偏了，退回统计版更诚实
    if len(text) < 20:
        return fallback
    return text


# --------------------------------------------------------------------------- #
# 懒触发：用户打开面板时补齐该有的通知
# --------------------------------------------------------------------------- #
def refresh(
    store: NoticeStore,
    owner_id: str,
    *,
    llm: Any = None,
    owner_name: str = "",
    charge: Any = None,
    weekly_enabled: bool = True,
) -> list[dict[str, Any]]:
    """补齐该用户"此刻应该看到"的通知，返回**本次新生成**的那些。

    幂等：所有写入都带 ``dedupe_key``，重复调用不会产生重复通知。
    也因此这个函数可以放心地挂在"每次打开面板"上。
    """
    if not owner_id:
        return []
    created: list[dict[str, Any]] = []

    try:
        active = store.learning_dates(owner_id)
    except Exception:
        active = set()
    streak = compute_streak(active)
    today = today_utc()

    # --- 打卡提醒：只在"本来有连续记录、今天却还没学"时提醒 -----------------
    # 没有连续记录时提醒毫无意义（对从没用过的人说"别断签"只会让人莫名其妙）。
    try:
        if streak["current_streak"] > 0 and not streak["today_active"]:
            body = build_streak_body(streak)
            if body and store.push(
                owner_id,
                "streak",
                f"连续 {streak['current_streak']} 天，今天还没开始",
                body,
                dedupe_key=f"streak:{today.isoformat()}",
                meta={"streak": streak["current_streak"]},
            ):
                created.append({"kind": "streak", "title": "打卡提醒", "body": body})
    except Exception:
        pass

    # --- 今日小结：当天有学习动作才生成 -------------------------------------
    try:
        day_stats = store.stats_between(owner_id, today, today + timedelta(days=1))
        body = build_daily_body(day_stats)
        if body and store.push(
            owner_id,
            "daily",
            "今日小结",
            body,
            dedupe_key=f"daily:{today.isoformat()}",
            meta={"events": day_stats["events"]},
        ):
            created.append({"kind": "daily", "title": "今日小结", "body": body})
    except Exception:
        pass

    # --- 周报：本周有活动、且本周还没生成过 ---------------------------------
    try:
        key = week_key()
        if weekly_enabled and not store.has(owner_id, f"weekly:{key}"):
            # ISO 周从周一开始
            monday = today - timedelta(days=today.weekday())
            week_stats = store.stats_between(
                owner_id, monday, monday + timedelta(days=7)
            )
            if week_stats["events"] > 0:
                body = compose_weekly(
                    llm, week_stats, streak, owner_name, charge=charge
                )
                if body and store.push(
                    owner_id,
                    "weekly",
                    f"本周学习周报（{key}）",
                    body,
                    dedupe_key=f"weekly:{key}",
                    meta={"events": week_stats["events"], "week": key},
                ):
                    created.append({"kind": "weekly", "title": "学习周报", "body": body})
    except Exception:
        pass

    return created
