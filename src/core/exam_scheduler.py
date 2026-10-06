"""天大办公网与微北洋考表对接 · 基于 FSRS 掌握度的期末备考排期中心。

针对传统备考软件「只给倒计时、不管掌握度」的脱节问题：
将真实期末考表（考试时间、考场、座位号）与知源（KnowOrigin）的
知识框架（framework_nodes）、掌握度评估（mastery_score）以及 FSRS 闪卡复习（cards）深度融合，
按考前倒计时天数动态反推「每日知识点冲刺量」与「保命卡片到期复习量」。
"""

from __future__ import annotations

import json
import math
import re
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today_date() -> date:
    return datetime.now().date()


def _order_prereq_first(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """排期排序：**前置永远排在它的后继之前**，其余仍按「权重高 → 掌握度低」。

    为什么不直接按「拓扑层」当主键：层号做主键会把一个 ``exam_basic`` 的前置压到
    ``exam_critical`` 的后继前面 —— 前置确实得先学，但没必要把权重整个让位。
    这里用**带优先级的 Kahn**：每轮只从「前置都已排完」的节点里挑当前最优的那个，于是

    - 硬约束：前置先于后继（这是「冲刺计划」能不能照着做的前提）；
    - 软偏好：**可选节点之间**的次序完全不变，原承诺「先啃最关键最弱的」照旧成立。

    环（含自环）里的节点永远等不到入度归零 —— 按原优先级**追加到末尾**。
    宁可把它们排在最后，也不要让它们凭空消失（``progress_engine`` 对环也是这个口径）。

    优先级末位放了 ``node_id`` 作为**确定性 tie-break**：旧口径对并列项（同权重同掌握度）
    是「保持 SQL 行序」，而 ``SELECT ... WHERE project_id = ?`` 没有 ORDER BY，
    行序本就不保证。并列项谁先谁后对用户是任意的，但**计划每次生成应当一致**，
    所以这里钉死一个稳定次序 —— 代价是并列项之间可能换位（实测真实库 9 个项目里 1 个，
    换位的那两个节点权重与掌握度完全相同）。
    """
    by_id: dict[str, dict[str, Any]] = {}
    for n in nodes:
        nid = n.get("node_id")
        if nid is None or nid in by_id:
            continue
        by_id[nid] = n

    def priority(n: dict[str, Any]) -> tuple[int, float, str]:
        try:
            mastery = float(n.get("mastery_score") or 0.0)
        except (TypeError, ValueError):
            mastery = 0.0
        return (int(n.get("_rank", 4)), mastery, str(n.get("node_id") or ""))

    indegree: dict[str, int] = {}
    children: dict[str, list[str]] = {}
    for nid, node in by_id.items():
        prereqs = {
            p for p in (node.get("prerequisite_ids") or []) if p in by_id and p != nid
        }
        indegree[nid] = len(prereqs)
        for p in prereqs:
            children.setdefault(p, []).append(nid)

    ready = [n for nid, n in by_id.items() if indegree[nid] == 0]
    ready.sort(key=priority)
    ordered: list[dict[str, Any]] = []
    placed: set[str] = set()
    while ready:
        node = ready.pop(0)
        nid = str(node.get("node_id"))
        ordered.append(node)
        placed.add(nid)
        for child in children.get(nid, []):
            indegree[child] -= 1
            if indegree[child] == 0:
                ready.append(by_id[child])
        # 节点规模是「一个项目的考点数」量级（几十~几百），重排的代价可以忽略；
        # 用堆反而会把「同优先级时保持稳定顺序」这件事弄复杂。
        ready.sort(key=priority)

    leftover = [n for nid, n in by_id.items() if nid not in placed]
    if leftover:
        ordered.extend(sorted(leftover, key=priority))
    return ordered


def _as_str_list(value: Any) -> list[str]:
    """把「可能是 JSON 字符串 / 列表 / None」的字段统一成去空的字符串列表。

    framework_nodes 的 source_ids / wikilinks 在库里是 JSON 文本，
    但调用方也可能直接传列表（单测与外部集成），两种都要吃得下。
    """
    if value is None:
        return []
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return []
        try:
            value = json.loads(raw)
        except (TypeError, ValueError):
            return [raw]
    if not isinstance(value, (list, tuple, set)):
        return []
    return [str(v).strip() for v in value if str(v).strip()]


def _one_line(value: Any, limit: int = 48) -> str:
    """把节点描述 / 笔记压成一行短抓手，供任务文案引用。"""
    if not isinstance(value, str):
        return ""
    text = re.sub(r"\s+", " ", value).strip().strip("`*#> \t")
    if len(text) <= limit:
        return text
    return text[:limit].rstrip("，。；、,.; ") + "…"


# AI 回填文案的硬上限：超长说明模型在「写作文」而不是写清单，直接退回算法模板。
_SPRINT_TITLE_MAX = 40
_SPRINT_DETAIL_MAX = 90
_SPRINT_REASON_MAX = 60

# 只认成对的中文引号：模型点名考点时必须原样照抄，用引号标出来才便于我们核验。
_SPRINT_QUOTE_RE = re.compile(r"[「《“]([^」》”]{1,40})[」》”]")

# 掌握度低于该比例视为「这次练习做错了」的错因（与前端「模糊/忘了」评级口径一致）。
_SPRINT_WRONG_CORRECTNESS = 0.6
# 掌握度比排期时点掉超过该幅度，判定为「回落」，需要重做该考点任务。
_SPRINT_DROP_TOLERANCE = 0.02


EXAM_SCHEMA = """
CREATE TABLE IF NOT EXISTS exam_entries (
    exam_id      TEXT PRIMARY KEY,
    owner_id     TEXT NOT NULL,
    subject      TEXT NOT NULL,
    exam_date    TEXT NOT NULL,
    time_range   TEXT NOT NULL DEFAULT '',
    location     TEXT NOT NULL DEFAULT '',
    seat         TEXT NOT NULL DEFAULT '',
    credit       REAL NOT NULL DEFAULT 0.0,
    project_id   TEXT,
    target_score REAL NOT NULL DEFAULT 85.0,
    notes        TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS exam_owner_date ON exam_entries(owner_id, exam_date);
CREATE INDEX IF NOT EXISTS exam_project ON exam_entries(project_id);

CREATE TABLE IF NOT EXISTS sprint_plans (
    plan_id          TEXT PRIMARY KEY,
    owner_id         TEXT NOT NULL,
    project_id       TEXT NOT NULL,
    course_name      TEXT NOT NULL,
    target_date      TEXT NOT NULL,
    total_days       INTEGER NOT NULL,
    daily_hours      REAL NOT NULL DEFAULT 2.0,
    target_score     REAL NOT NULL DEFAULT 85.0,
    mode             TEXT NOT NULL DEFAULT 'sprint',
    status           TEXT NOT NULL DEFAULT 'active',
    urgency_level    TEXT NOT NULL DEFAULT 'moderate',
    stages_json      TEXT NOT NULL,
    daily_tasks_json TEXT NOT NULL,
    content_json     TEXT NOT NULL DEFAULT '{}',
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sprint_proj ON sprint_plans(project_id, status);
CREATE INDEX IF NOT EXISTS idx_sprint_owner ON sprint_plans(owner_id, status);
"""


class ExamScheduler:
    def __init__(self, db_path: str | Path):
        self.path = Path(db_path)
        if str(db_path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._conn.execute("PRAGMA busy_timeout = 5000")
        self.init_schema()

    def init_schema(self) -> None:
        with self._conn:
            self._conn.executescript(EXAM_SCHEMA)
        self._migrate_sprint_columns()

    def _migrate_sprint_columns(self) -> None:
        """老库补列：sprint_plans.content_json 是后加的（记录 AI 文案回填状态）。
        CREATE TABLE IF NOT EXISTS 对已存在的表不会补列，必须显式 ALTER，否则老用户
        一读计划就报 no such column —— 属于静默炸掉整块功能。"""
        try:
            cols = {
                row["name"]
                for row in self._conn.execute("PRAGMA table_info(sprint_plans)").fetchall()
            }
        except sqlite3.OperationalError:
            return
        if "content_json" not in cols:
            with self._conn:
                self._conn.execute(
                    "ALTER TABLE sprint_plans ADD COLUMN content_json TEXT NOT NULL DEFAULT '{}'"
                )

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        try:
            yield self._conn
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise

    def add_or_update_exam(
        self,
        owner_id: str,
        subject: str = "",
        exam_date: str = "",
        time_range: str = "",
        location: str = "",
        seat: str = "",
        credit: float = 0.0,
        project_id: str | None = None,
        target_score: float = 85.0,
        notes: str = "",
        exam_id: str | None = None,
        # 兼容别名入参
        course_name: str = "",
        exam_time: str = "",
        seat_number: str = "",
        exam_type: str = "",
        focus_chapters: Any = None,
    ) -> dict[str, Any]:
        """新增或编辑考项。支持主字段与常见别名。"""
        import uuid

        final_subject = (subject or course_name or "").strip()
        final_date = (exam_date or exam_time or "").strip()
        final_seat = (seat or seat_number or "").strip()
        if not final_subject or not final_date:
            raise ValueError("subject/course_name 和 exam_date/exam_time 为必填")

        now = _utc_now_iso()
        clean_date = final_date
        if len(clean_date) >= 10:
            clean_date = clean_date[:10]

        if not exam_id:
            exam_id = f"exam_{uuid.uuid4().hex[:12]}"

        # 若未指定 project_id，尝试自动按学科名匹配既有项目
        if not project_id:
            project_id = self._match_project_id(owner_id, final_subject)

        with self.transaction():
            self._conn.execute(
                """
                INSERT INTO exam_entries (
                    exam_id, owner_id, subject, exam_date, time_range,
                    location, seat, credit, project_id, target_score, notes,
                    created_at, updated_at
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                )
                ON CONFLICT(exam_id) DO UPDATE SET
                    subject = excluded.subject,
                    exam_date = excluded.exam_date,
                    time_range = excluded.time_range,
                    location = excluded.location,
                    seat = excluded.seat,
                    credit = excluded.credit,
                    project_id = COALESCE(excluded.project_id, exam_entries.project_id),
                    target_score = excluded.target_score,
                    notes = excluded.notes,
                    updated_at = excluded.updated_at
                """,
                (
                    exam_id,
                    owner_id,
                    final_subject,
                    clean_date,
                    time_range.strip(),
                    location.strip(),
                    final_seat,
                    float(credit or 0.0),
                    project_id,
                    float(target_score or 85.0),
                    notes.strip(),
                    now,
                    now,
                ),
            )

        return self.get_exam(exam_id) or {}

    def delete_exam(self, arg1: str, arg2: str = "") -> bool:
        """删除考项。兼容 delete_exam(exam_id, owner_id) 或 delete_exam(owner_id, exam_id)。"""
        if arg2:
            if arg1.startswith("exam_") or not arg2.startswith("exam_"):
                exam_id, owner_id = arg1, arg2
            else:
                owner_id, exam_id = arg1, arg2
            with self.transaction():
                cursor = self._conn.execute(
                    "DELETE FROM exam_entries WHERE exam_id = ? AND owner_id = ?",
                    (exam_id, owner_id),
                )
                return cursor.rowcount > 0
        else:
            exam_id = arg1
            with self.transaction():
                cursor = self._conn.execute("DELETE FROM exam_entries WHERE exam_id = ?", (exam_id,))
                return cursor.rowcount > 0

    def get_exam(self, arg1: str, arg2: str = "") -> dict[str, Any] | None:
        """获取单个考项及其计算指标。兼容 get_exam(exam_id) 或 get_exam(owner_id, exam_id)。"""
        if arg2:
            owner_id, exam_id = arg1, arg2
            row = self._conn.execute(
                """
                SELECT exam_id, owner_id, subject, exam_date, time_range, location,
                       seat, credit, project_id, target_score, notes, created_at, updated_at
                FROM exam_entries
                WHERE exam_id = ? AND owner_id = ?
                """,
                (exam_id, owner_id),
            ).fetchone()
        else:
            exam_id = arg1
            row = self._conn.execute(
                """
                SELECT exam_id, owner_id, subject, exam_date, time_range, location,
                       seat, credit, project_id, target_score, notes, created_at, updated_at
                FROM exam_entries
                WHERE exam_id = ?
                """,
                (exam_id,),
            ).fetchone()
            owner_id = row["owner_id"] if row else ""
        if not row:
            return None
        return self._enrich_exam_item(dict(row), owner_id)

    def get_exams(self, owner_id: str) -> list[dict[str, Any]]:
        """获取用户的所有考试，按考试日期及紧急度排序。"""
        rows = self._conn.execute(
            """
            SELECT exam_id, owner_id, subject, exam_date, time_range, location,
                   seat, credit, project_id, target_score, notes, created_at, updated_at
            FROM exam_entries
            WHERE owner_id = ?
            ORDER BY exam_date ASC, time_range ASC
            """,
            (owner_id,),
        ).fetchall()
        items = [self._enrich_exam_item(dict(r), owner_id) for r in rows]
        # 排序：未考的按天数正序（越近越靠前），已考完的放最后
        items.sort(key=lambda x: (1 if x["days_left"] < 0 else 0, x["days_left"]))
        return items

    def list_exams(self, owner_id: str, project_id: str | None = None) -> list[dict[str, Any]]:
        """获取考试列表，支持 project_id 过滤。"""
        items = self.get_exams(owner_id)
        if project_id:
            items = [x for x in items if x.get("project_id") == project_id]
        return items

    def import_weipeiyang_exams(
        self,
        owner_id: str,
        exams: list[dict[str, Any]],
        projects: list[dict[str, Any]] | None = None,
    ) -> list[dict[str, Any]]:
        """批量导入微北洋/办公网格式的考试数据，支持自动与项目库关联。"""
        imported = []
        for e in exams:
            sub = e.get("course_name") or e.get("name") or e.get("subject") or ""
            dt = e.get("exam_time") or e.get("date") or e.get("exam_date") or ""
            if not sub or not dt:
                continue
            proj_id = e.get("project_id")
            if not proj_id and projects:
                sub_low = sub.lower()
                for p in projects:
                    p_name = (p.get("subject") or p.get("name") or "").lower()
                    if sub_low in p_name or p_name in sub_low:
                        proj_id = p.get("project_id")
                        break
            item = self.add_or_update_exam(
                owner_id=owner_id,
                subject=sub,
                exam_date=dt,
                time_range=e.get("arrange") or e.get("time_range") or "",
                location=e.get("location") or "",
                seat=e.get("seat_number") or e.get("seat") or "",
                credit=float(e.get("credit") or 0.0),
                project_id=proj_id,
                target_score=float(e.get("target_score") or 90.0),
                notes=e.get("type") or e.get("notes") or "",
            )
            imported.append(item)
        return imported

    def get_sprint_plan(
        self,
        arg1: str,
        arg2: Any = None,
        nodes: list[dict[str, Any]] | None = None,
        cards: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """为特定科目生成基于掌握度与 FSRS 遗忘曲线的每日备考冲刺计划。支持传入内存节点/卡片计算。"""
        if isinstance(arg2, str) and arg2:
            owner_id, exam_id = arg1, arg2
        else:
            exam_id = arg1
            owner_id = ""

        exam = self.get_exam(exam_id)
        if not exam:
            return {"error": "未找到考试科目"}

        owner_id = owner_id or exam.get("owner_id", "")
        project_id = exam.get("project_id")
        weak_nodes: list[dict[str, Any]] = []
        due_cards: list[dict[str, Any]] = []

        if nodes is not None:
            # 外部显式传入知识节点
            for n in nodes:
                ms = float(n.get("mastery") if n.get("mastery") is not None else (n.get("mastery_score") or 0.0))
                imp = n.get("importance") or n.get("exam_weight") or "normal"
                weight = 1.5 if imp in ("core", "exam_critical") else (1.2 if imp in ("important", "exam_important") else 1.0)
                if ms < 0.7:
                    weak_nodes.append({
                        "node_id": n.get("node_id"),
                        "title": n.get("title") or n.get("name") or "未命名考点",
                        "mastery": ms,
                        "weight": weight,
                    })
        elif project_id:
            node_rows = self._conn.execute(
                """
                SELECT node_id, name, description, mastery_score, exam_weight, learning_status
                FROM framework_nodes
                WHERE project_id = ?
                ORDER BY
                    CASE exam_weight
                        WHEN 'exam_critical' THEN 1
                        WHEN 'exam_important' THEN 2
                        WHEN 'exam_normal' THEN 3
                        ELSE 4
                    END ASC,
                    mastery_score ASC
                """,
                (project_id,),
            ).fetchall()
            for nr in node_rows:
                d = dict(nr)
                ms = float(d.get("mastery_score") or 0.0)
                if ms < 0.7:
                    weak_nodes.append({
                        "node_id": d.get("node_id"),
                        "title": d.get("name") or "未命名考点",
                        "mastery": ms,
                        "weight": 1.5 if d.get("exam_weight") == "exam_critical" else 1.0,
                    })

        if cards is not None:
            due_cards = list(cards)
        elif project_id:
            due_cards = self._fetch_due_cards(project_id, owner_id, limit=30)

        days_left = max(0, exam.get("days_left", 0))
        # 每日推荐攻克考点数
        if days_left > 0 and weak_nodes:
            daily_target = max(1, math.ceil(len(weak_nodes) / days_left))
        elif weak_nodes:
            daily_target = len(weak_nodes)
        else:
            daily_target = 0

        # 今日推荐攻坚考点（精选前 N 个重点概念）
        today_focus_nodes = weak_nodes[: max(3, daily_target)]

        tips = []
        if exam["urgency"] == "critical":
            tips.append("考前极度紧急：暂停探索新分支，集中刷弱项考点及错题卡片。")
        elif exam["urgency"] == "sprint":
            tips.append("冲刺周：每天完成推荐考点打卡，利用测验快速检验薄弱环节。")
        else:
            tips.append("平稳备考：按部就班吸收新概念，并在闪卡到期时及时复习。")

        return {
            "exam": exam,
            "course_name": exam.get("subject", ""),
            "target_score": exam.get("target_score", 90),
            "weak_nodes": weak_nodes,
            "due_cards": due_cards,
            "days_left": days_left,
            "urgency": exam["urgency"],
            "readiness_score": exam.get("readiness_score", 0),
            "total_weak_nodes": len(weak_nodes),
            "daily_target_nodes": daily_target,
            "today_focus_nodes": today_focus_nodes,
            "due_cards_count": len(due_cards),
            "due_cards_sample": due_cards[:5],
            "action_guidance": tips,
        }

    def export_ics(self, owner_id: str) -> str:
        """导出标准 iCalendar (.ics) 日历格式。"""
        exams = self.get_exams(owner_id)
        lines = [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:-//Tianjin University KnowOrigin//Exam Scheduler//CN",
            "CALSCALE:GREGORIAN",
            "METHOD:PUBLISH",
            "X-WR-CALNAME:天大期末考表与冲刺提醒",
            "X-WR-TIMEZONE:Asia/Shanghai",
        ]

        for e in exams:
            dt_clean = e["exam_date"].replace("-", "")
            # 解析时间段，例如 "09:00-11:00"
            tr = e.get("time_range") or ""
            start_time = "090000"
            end_time = "110000"
            if "-" in tr:
                parts = tr.split("-")
                p1 = parts[0].strip().replace(":", "")
                p2 = parts[1].strip().replace(":", "")
                if len(p1) == 4:
                    start_time = p1 + "00"
                if len(p2) == 4:
                    end_time = p2 + "00"

            dtstart = f"{dt_clean}T{start_time}"
            dtend = f"{dt_clean}T{end_time}"
            loc = e.get("location") or "待定"
            seat = f" 座位号：{e['seat']}" if e.get("seat") else ""
            desc = f"科目：{e['subject']}\\n考场：{loc}{seat}\\n学分：{e.get('credit', 0)}\\n知源备考就绪度：{e.get('readiness_score', 0)}%"

            lines.extend([
                "BEGIN:VEVENT",
                f"UID:{e['exam_id']}@knoworigin.tju",
                f"DTSTAMP:{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
                f"DTSTART:{dtstart}",
                f"DTEND:{dtend}",
                f"SUMMARY:【期末考试】{e['subject']}",
                f"LOCATION:{loc}{seat}",
                f"DESCRIPTION:{desc}",
                "BEGIN:VALARM",
                "TRIGGER:-P1D",
                "ACTION:DISPLAY",
                f"DESCRIPTION:明日考试提醒：{e['subject']} ({loc})",
                "END:VALARM",
                "BEGIN:VALARM",
                "TRIGGER:-PT2H",
                "ACTION:DISPLAY",
                f"DESCRIPTION:考前2小时提醒：{e['subject']} 即将开始",
                "END:VALARM",
                "END:VEVENT",
            ])

        lines.append("END:VCALENDAR")
        return "\r\n".join(lines)

    # ── 内部取数助手：cards 的真实 schema 访问 ────────────────────────────
    # ⚠️ 真实表结构（务必按此写 SQL，别凭直觉）：
    #   cards(card_id, project_id, payload TEXT/*JSON*/, created_at)
    #     —— 题干/答案/分类/难度/关联节点全在 payload JSON 里，
    #        没有 front / back / node_id / due 这些列。
    #   card_srs_state(card_id, owner_id, due_at, state, reps, lapses, stability, ...)
    #     —— FSRS 排期在独立表，按 (card_id, owner_id) 主键。
    #   曾经这里按 cards.front / cards.due 查询，被 except 吞成空列表，
    #   导致「到期闪卡」永远为 0 —— 属于静默失效，不是「暂时没卡」。

    def _table_exists(self, name: str) -> bool:
        """探测表是否存在。cards 常驻，但 card_srs_state 是懒创建的
        （各自 store 首次用到才建表）——直接 JOIN 不存在的表会抛错，
        会被容错逻辑吞成「没有卡」，又是一次静默失效。"""
        try:
            row = self._conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
                (name,),
            ).fetchone()
            return row is not None
        except sqlite3.OperationalError:
            return False

    def _fetch_due_cards(
        self, project_id: str, owner_id: str, limit: int = 40
    ) -> list[dict[str, Any]]:
        """读取项目内 FSRS 到期闪卡（含「从未复习过」的新卡，冲刺期更该刷）。"""
        if not self._table_exists("cards"):
            return []

        if self._table_exists("card_srs_state"):
            sql = """
                SELECT c.card_id, c.payload, s.due_at, s.state, s.reps, s.lapses
                FROM cards c
                LEFT JOIN card_srs_state s
                       ON s.card_id = c.card_id AND s.owner_id = ?
                WHERE c.project_id = ?
                ORDER BY
                    CASE WHEN s.due_at IS NULL OR s.due_at <= ? THEN 0 ELSE 1 END ASC,
                    s.due_at ASC
                LIMIT ?
            """
            params: tuple[Any, ...] = (owner_id, project_id, _utc_now_iso(), limit)
        else:
            # 还没人用过复习功能 → 全部卡片都算「未复习的新卡」，按录入顺序取
            sql = """
                SELECT c.card_id, c.payload,
                       NULL AS due_at, NULL AS state, NULL AS reps, NULL AS lapses
                FROM cards c
                WHERE c.project_id = ?
                ORDER BY c.created_at ASC
                LIMIT ?
            """
            params = (project_id, limit)

        try:
            rows = self._conn.execute(sql, params).fetchall()
        except sqlite3.OperationalError:
            return []

        out: list[dict[str, Any]] = []
        for r in rows:
            try:
                payload = json.loads(r["payload"] or "{}")
            except Exception:
                payload = {}
            out.append({
                "card_id": r["card_id"],
                "front": payload.get("front", ""),
                "back": payload.get("back", ""),
                "category": payload.get("category", ""),
                "difficulty": payload.get("difficulty", 1),
                "node_ids": payload.get("node_ids") or [],
                "due_at": r["due_at"],
                "state": r["state"] or "new",
                "reps": r["reps"] or 0,
            })
        return out

    def _fetch_sprint_nodes(self, project_id: str) -> list[dict[str, Any]]:
        """取项目知识框架节点（含描述 / 笔记 / 双链来源）。

        note_content / wikilinks 是主库迁移后才有的列，老库或缺列时退回基础列 ——
        宁可少一点资料，也不能让整个排期因为缺列而空掉。
        """
        extended = """
            SELECT node_id, name, description, mastery_score, exam_weight,
                   learning_status, note_content, source_ids, wikilinks,
                   prerequisite_ids
            FROM framework_nodes
            WHERE project_id = ?
        """
        basic = """
            SELECT node_id, name, description, mastery_score, exam_weight, learning_status
            FROM framework_nodes
            WHERE project_id = ?
        """
        for sql in (extended, basic):
            try:
                rows = self._conn.execute(sql, (project_id,)).fetchall()
            except sqlite3.OperationalError:
                continue
            return self._normalize_sprint_nodes([dict(r) for r in rows])
        return []

    def _fetch_source_names(self, project_id: str) -> dict[str, str]:
        """source_id → 资料文件名。

        任务文案要能点名「依据哪份资料」，否则「精读核心机理」这种空话对用户毫无帮助。
        """
        if not self._table_exists("sources"):
            return {}
        try:
            rows = self._conn.execute(
                "SELECT source_id, filename FROM sources WHERE project_id = ?",
                (project_id,),
            ).fetchall()
        except sqlite3.OperationalError:
            return {}
        return {str(r["source_id"]): str(r["filename"] or "").strip() for r in rows}

    def _normalize_sprint_nodes(self, raw_nodes: list[Any]) -> list[dict[str, Any]]:
        """把考点节点归一化并**按冲刺优先级排序**。

        排序口径（2026-09-29 起）：**前置先行是硬约束**，在其之上仍按原承诺偏好
        「考试权重高的在前、同权重内掌握度低的在前」。见 ``_order_prereq_first``。

        ⚠️ 调用方可能传 dict / pydantic 模型 / ORM dict，字段名也不统一
        （name|title、mastery|mastery_score）。曾漏了这一步，导致外部传入 nodes 时
        排期完全按原始顺序走 —— 「第一天先啃最关键最弱的考点」这个核心承诺失效。
        """
        rank_of = {"exam_critical": 1, "exam_important": 2, "exam_normal": 3}
        out: list[dict[str, Any]] = []
        for n in raw_nodes or []:
            if isinstance(n, dict):
                d = dict(n)
            else:
                try:
                    d = n.model_dump()
                except Exception:
                    d = dict(getattr(n, "__dict__", {}) or {})

            ms_raw = d.get("mastery")
            if ms_raw is None:
                ms_raw = d.get("mastery_score")
            try:
                ms = float(ms_raw or 0.0)
            except (TypeError, ValueError):
                ms = 0.0

            ew = d.get("exam_weight") or "exam_normal"
            out.append({
                "node_id": d.get("node_id"),
                "name": d.get("name") or d.get("title") or "未命名考点",
                "mastery_score": ms,
                "exam_weight": ew,
                # 节点自身的资料：描述 / 笔记是「这个考点到底讲什么」，
                # source_ids 是双链图谱里它挂在哪几份资料上，wikilinks 是它链到的其它考点。
                # 三者一起才够写出「不笼统」的任务文案 —— 只给考点名，模型只能复读名字。
                "description": _one_line(d.get("description"), 48),
                "note_excerpt": _one_line(d.get("note_content"), 48),
                "source_ids": _as_str_list(d.get("source_ids")),
                "wikilinks": _as_str_list(d.get("wikilinks")),
                # 前置考点：早就存在库里，但本文件此前**一次都没读过**它 ——
                # 于是冲刺计划会把「前置还没掌握」的节点排到前面（甚至因为排不下而把它丢掉）。
                "prerequisite_ids": _as_str_list(d.get("prerequisite_ids")),
                "_rank": rank_of.get(ew, 4),
            })

        return _order_prereq_first(out)

    # ── 内部计算与关联增强 ──────────────────────────────────

    def _match_project_id(self, owner_id: str, subject: str) -> str | None:
        """根据学科名称自动匹配知源既有项目。若单测中未挂载主库 projects 表则优雅跳过。"""
        if not subject:
            return None
        sub_norm = subject.strip().lower()
        try:
            # 优先完全匹配
            row = self._conn.execute(
                "SELECT project_id, subject FROM projects WHERE user_id = ? AND LOWER(subject) = ? LIMIT 1",
                (owner_id, sub_norm),
            ).fetchone()
            if row:
                return row["project_id"]

            # 其次模糊子串匹配
            rows = self._conn.execute(
                "SELECT project_id, subject FROM projects WHERE user_id = ?",
                (owner_id,),
            ).fetchall()
            for r in rows:
                p_sub = (r["subject"] or "").lower()
                if sub_norm in p_sub or p_sub in sub_norm:
                    return r["project_id"]
        except sqlite3.OperationalError:
            pass
        return None

    def _enrich_exam_item(self, item: dict[str, Any], owner_id: str) -> dict[str, Any]:
        """计算考试倒计时天数、就绪度与关联项目学情指标。"""
        today = _today_date()
        exam_date_str = item.get("exam_date") or ""
        try:
            ed = datetime.strptime(exam_date_str, "%Y-%m-%d").date()
            days_left = (ed - today).days
        except Exception:
            days_left = 999

        item["days_left"] = days_left

        if days_left < 0:
            urgency = "passed"
        elif days_left <= 3:
            urgency = "critical"  # 红色警戒
        elif days_left <= 7:
            urgency = "sprint"    # 冲刺周
        elif days_left <= 14:
            urgency = "review"    # 强化复习
        else:
            urgency = "normal"    # 稳步备考

        item["urgency"] = urgency

        # 学情指标计算
        project_id = item.get("project_id")
        if not project_id:
            project_id = self._match_project_id(owner_id, item.get("subject", ""))
            if project_id:
                item["project_id"] = project_id

        total_nodes = 0
        mastered_nodes = 0
        weak_nodes = 0
        readiness_score = 0
        due_cards_count = 0

        if project_id:
            try:
                # 统计知识点
                nodes = self._conn.execute(
                    """
                    SELECT mastery_score, exam_weight, learning_status
                    FROM framework_nodes
                    WHERE project_id = ?
                    """,
                    (project_id,),
                ).fetchall()
                total_nodes = len(nodes)
                if total_nodes > 0:
                    crit_scores = []
                    imp_scores = []
                    norm_scores = []
                    for n in nodes:
                        ms = float(n["mastery_score"] or 0.0)
                        ew = n["exam_weight"] or "exam_normal"
                        if ms >= 0.7 or n["learning_status"] == "mastered":
                            mastered_nodes += 1
                        else:
                            weak_nodes += 1

                        if ew == "exam_critical":
                            crit_scores.append(ms)
                        elif ew == "exam_important":
                            imp_scores.append(ms)
                        else:
                            norm_scores.append(ms)

                    # 加权就绪度计算：重点考点权重占 80%
                    c_avg = sum(crit_scores) / len(crit_scores) if crit_scores else 0.8
                    i_avg = sum(imp_scores) / len(imp_scores) if imp_scores else 0.7
                    n_avg = sum(norm_scores) / len(norm_scores) if norm_scores else 0.6
                    readiness_score = round((c_avg * 0.5 + i_avg * 0.35 + n_avg * 0.15) * 100)

                # 统计到期复习闪卡（真实 schema：cards.payload + card_srs_state.due_at）
                due_cards_count = len(self._fetch_due_cards(project_id, owner_id, limit=999))
            except sqlite3.OperationalError:
                pass

        item["total_nodes"] = total_nodes
        item["mastered_nodes"] = mastered_nodes
        item["weak_nodes"] = weak_nodes
        item["readiness_score"] = readiness_score
        item["due_cards_count"] = due_cards_count
        item["daily_target_nodes"] = (
            max(1, math.ceil(weak_nodes / max(1, days_left))) if (days_left > 0 and weak_nodes > 0) else 0
        )
        item["course_name"] = item.get("subject", "")
        item["exam_time"] = item.get("exam_date", "")
        item["seat_number"] = item.get("seat", "")
        return item

    # ── 纯粹期末/考前自适应冲刺计划引擎 (Sprint Planner Engine) ──────────

    @staticmethod
    def _node_material(
        node: dict[str, Any], source_names: dict[str, str]
    ) -> tuple[str, list[str], list[str]]:
        """从节点自身的资料里抽出写任务文案要用的三个抓手。

        返回 (material, source_refs, linked_names)：
        - material：节点描述优先，没有就用笔记开头 —— 「这个考点到底讲什么」
        - source_refs：它挂在哪几份资料上（双链图谱 source_ids → 真实文件名）
        - linked_names：它双向链接到的其它考点名

        只给考点名时，文案只能复读名字（「精读核心机理」这种）；有这三样才写得出
        「对着哪份资料的哪句话、做什么、和哪个考点辨析」。
        """
        material = str(node.get("description") or "").strip() or str(
            node.get("note_excerpt") or ""
        ).strip()
        refs: list[str] = []
        for sid in node.get("source_ids") or []:
            name = source_names.get(str(sid)) or ""
            if name and name not in refs:
                refs.append(name)
        linked = [str(w).strip() for w in (node.get("wikilinks") or []) if str(w).strip()]
        return material, refs[:2], linked[:3]

    @staticmethod
    def _concept_detail(
        node_name: str,
        material: str,
        refs: list[str],
        linked: list[str],
        mastery_percent: int,
        prereq_name: str = "",
    ) -> str:
        """用考点自己的资料拼一句「有据可依」的任务详情，控制在文案上限内。

        按「资料名 + 描述」的完整度从高到低挑第一句放得下的；全放不下才退回通用句。
        宁可少说，也不硬塞到超长被 apply_sprint_content 判为不合规。

        ``prereq_name`` 来自学习路径：这个考点的前置还没掌握时，任务就该先说
        「把它前置自测一遍」，而不是假装它是孤立考点。
        """
        cap = _SPRINT_DETAIL_MAX
        tail = f"（当前掌握度 {mastery_percent}%）"
        name = node_name or "该考点"
        ref = refs[0] if refs else ""
        link = linked[0] if linked else ""

        candidates: list[str] = []
        if prereq_name and ref and material:
            candidates.append(f"先花几分钟自测前置「{prereq_name}」，再对着《{ref}》看「{name}」：{material}，合书复述")
        if prereq_name and material:
            candidates.append(f"先花几分钟自测前置「{prereq_name}」，再围绕「{name}」：{material}，合书复述")
        if prereq_name and ref:
            candidates.append(f"先自测前置「{prereq_name}」，再翻《{ref}》定位「{name}」，划出定义与边界条件")
        if prereq_name:
            candidates.append(f"先自测前置「{prereq_name}」，再精读「{name}」并合书复述")
        if ref and material:
            candidates.append(f"对着《{ref}》看「{name}」：{material}，合书复述")
        if ref and link:
            candidates.append(f"翻《{ref}》定位「{name}」，并辨析它与「{link}」的差别")
        if ref:
            candidates.append(f"翻《{ref}》定位「{name}」，划出定义与边界条件后合书复述")
        if material:
            candidates.append(f"围绕「{name}」：{material}，合书主动复述")
        if link:
            candidates.append(f"精读「{name}」核心机理，并与「{link}」做辨析")
        candidates.append("精读核心机理，完成主动回忆，破除理解盲区")

        for body in candidates:
            if len(body) + len(tail) <= cap:
                return body + tail
        return candidates[-1] + tail

    # ── 学习路径（先排路径，再把路径切段分配到每天）──────────────────────
    #
    # 约定（2026-09-29）：当日计划不许再「每天固定三件套」。生成计划的第一步
    # 是把考点排成一条**有序的学习路径**（_order_prereq_first：前置先行，
    # 可选节点之间按「权重高 → 掌握度低」），第二步才是把这条路径按容量切段，
    # 每天领到自己那一段。任务文案从「这段路上有谁、它前面是谁」派生，
    # 不再是放之四海皆准的模板句。

    @staticmethod
    def _station_action(mastery: float) -> str:
        """路径站点 → 这一站该干什么的短标签（与冲刺排期的掌握度口径一致）。

        这是**任务文案的抓手**，不是决策 —— 决策层（位阶闸门）在 progress_engine，
        这里只负责把「这一站现在什么状态」说成人话。
        """
        if mastery <= 0.0:
            return "开个头：第一次接触，先能合书复述定义"
        if mastery < 0.35:
            return "补基础：把定义与边界条件过扎实"
        if mastery < 0.55:
            return "攻坚：啃推导与易错点"
        if mastery < 0.7:
            return "临门一脚：做题验收，错处当场归因"
        return "保持：快速复述一遍即可过站"

    @staticmethod
    def _assign_path(candidate_nodes: list[dict[str, Any]]) -> int:
        """给排好序的候选考点标注路径站位（1 起）。返回路径总站数。

        ``candidate_nodes`` 已是 ``_order_prereq_first`` 的输出 —— 路径的「顺序」
        就是那个顺序，这里只补上「第几站」这个可显示、可引用的坐标。
        """
        for idx, node in enumerate(candidate_nodes, start=1):
            node["path_index"] = idx
        return len(candidate_nodes)

    @staticmethod
    def _prereq_to_check(
        node: dict[str, Any],
        name_by_id: dict[str, str],
        mastery_by_id: dict[str, float],
    ) -> str:
        """挑一个最该先自测的前置考点名：还没掌握（<0.7）的前置里取最弱的那个。

        前置都掌握了就返回空串 —— 任务不该啰嗦「自测一个你已经会的东西」。
        """
        weakest_name = ""
        weakest_mastery = 0.7
        for pid in node.get("prerequisite_ids") or []:
            pname = name_by_id.get(str(pid))
            if not pname or pname == node.get("name"):
                continue
            pm = float(mastery_by_id.get(str(pid), 0.0))
            if pm < weakest_mastery:
                weakest_mastery = pm
                weakest_name = pname
        return weakest_name

    @staticmethod
    def _day_goal(
        stations: list[dict[str, Any]],
        path_from: int,
        path_to: int,
        total: int,
        lap: int,
    ) -> str:
        """把「今天走路径哪一段」写成一句当天目标。

        点名考点（前两个）+ 站位区间 + 每一站的动作标签；复习轮（lap ≥ 2）
        如实说明这是第二遍过同一段路 —— 目标从「能复述」变成「卡壳处归零」。
        """
        if not stations:
            return ""
        names = [str(s.get("name") or "").strip() for s in stations]
        names = [n for n in names if n]
        shown = "、".join(f"「{n}」" for n in names[:2])
        if len(names) > 2:
            shown += f" 等 {len(names)} 站"
        span = f"第 {path_from}–{path_to} 站"
        if lap >= 2:
            return f"学习路径第 {lap} 遍 · {span}（共 {total} 站）：{shown} —— 卡壳的地方这次要归零"
        action = ExamScheduler._station_action(
            float(stations[0].get("mastery_score") or 0.0)
        )
        return f"学习路径 {span}（共 {total} 站）：{shown} —— {action}"

    @staticmethod
    def _path_review_task(
        day_index: int,
        yesterday_stations: list[dict[str, Any]],
    ) -> dict[str, Any] | None:
        """「路径回看」任务：合书复述**昨天**走过的站点（路径内的间隔重复）。

        取代旧口径「每天都是框架对照 · 整理考点地图」—— 那句与当天路径无关，
        每天一字不差，正是「公式化」的主要来源。昨天没有走过站点（第 1 天）
        返回 None，由调用方落回「全局基线」。
        """
        names: list[str] = []
        for s in yesterday_stations:
            n = str(s.get("name") or "").strip()
            if n:
                names.append(n)
        if not names:
            return None
        shown = "、".join(f"「{n}」" for n in names[:2])
        if len(names) > 2:
            shown += f" 等 {len(names)} 站"
        return {
            "task_id": f"d{day_index}_t0",  # 落库前会按槽位重排，这里只保证可追溯
            "type": "overview",
            "title": f"路径回看 · 复述昨日 {len(names)} 站",
            "detail": f"不看书，把昨天那几站（{shown}）各复述一遍；卡壳的当天翻回去补看",
            "duration_min": 15,
            "review_node_names": names,
            "completed": False,
        }

    def _sprint_node_materials(self, project_id: str) -> dict[str, dict[str, Any]]:
        """node_id → 该考点的资料抓手（描述 / 资料名 / 关联考点）。

        节点资料刻意不写进 sprint_plans：知识库改了资料，计划下次用时就该跟着变，
        而不是留着一份生成当天的旧快照。载荷拼装与防幻觉校验名单共用这一份。
        """
        if not project_id:
            return {}
        source_names = self._fetch_source_names(project_id)
        out: dict[str, dict[str, Any]] = {}
        for node in self._fetch_sprint_nodes(project_id):
            nid = str(node.get("node_id") or "")
            if not nid:
                continue
            material, refs, linked = self._node_material(node, source_names)
            out[nid] = {"material": material, "refs": refs, "linked": linked}
        return out

    def _create_bootstrap_plan(
        self,
        *,
        owner_id: str,
        project_id: str,
        course_name: str,
        daily_hours: float,
        target_score: float,
        mode: str,
    ) -> dict[str, Any]:
        """无知识框架时的**路标计划**（bootstrap）：把「建框架」本身排成 3 天任务。

        为什么不再排合成考点：框架都没有，「考点攻坚 · 核心基本概念与大纲框架」
        是编出来的 —— 用户看到的是每天一字不差的公式化计划，而且照着做也落不到
        任何真实考点上。务实的顺序是：导入资料 → 生成知识框架 → 生成学习路径 →
        回来「重新制定」，那时才有真实考点可分配。

        标记：``content_json.kind = "bootstrap"``（enrich 时回填 ``plan.needs_framework``，
        前端据此显示提示并隐藏「AI 写细」—— 给路标计划写文案没有意义）。
        """
        today = _today_date()
        total_days = 3
        stages = [
            {
                "stage": 1,
                "name": "先建框架",
                "days": total_days,
                "focus": "把知识框架和学习路径建起来，才有点可分",
                "badge": "地基",
            },
        ]
        day_specs: list[list[dict[str, Any]]] = [
            [
                {
                    "type": "overview",
                    "title": "导入教材与讲义",
                    "detail": "把这门课的教材、课件、真题传进知源（有遗漏先补齐），框架要从它们里面长出来",
                    "duration_min": 30,
                },
                {
                    "type": "overview",
                    "title": "生成知识框架",
                    "detail": "点「生成/更新知识框架」——有了框架才有具体考点，学习路径才能排出来",
                    "duration_min": 20,
                },
            ],
            [
                {
                    "type": "overview",
                    "title": "过一遍考点名单",
                    "detail": "在知识框架里把考试会考的考点名字过一遍，明显漏掉的补进框架、标好考试权重",
                    "duration_min": 25,
                },
                {
                    "type": "overview",
                    "title": "标前置关系",
                    "detail": "给考点补上「先学什么再学什么」——学习路径按前置排序，标得越全分得越准",
                    "duration_min": 15,
                },
            ],
            [
                {
                    "type": "overview",
                    "title": "回来「重新制定」计划",
                    "detail": "框架齐了就点「重新制定」——新计划会先排出学习路径，再把考点分配到每一天",
                    "duration_min": 10,
                },
            ],
        ]

        daily_tasks: list[dict[str, Any]] = []
        for d, specs in enumerate(day_specs, start=1):
            task_date = (today + timedelta(days=d - 1)).strftime("%Y-%m-%d")
            tasks: list[dict[str, Any]] = []
            for spec in specs:
                tasks.append({
                    "task_id": f"d{d}_t{len(tasks) + 1}",
                    **spec,
                    "completed": False,
                })
            daily_tasks.append({
                "day_index": d,
                "date": task_date,
                "stage_num": 1,
                "stage_name": "先建框架",
                "is_today": (task_date == today.strftime("%Y-%m-%d")),
                "day_goal": (
                    "这门课还没有知识框架，先把框架和学习路径建起来 ——"
                    "建好后点「重新制定」，计划会按学习路径分配具体考点"
                    if d == 1
                    else "继续把框架搭扎实：考点名单全、前置关系标好，路径才排得准"
                ),
                "tasks": tasks,
                "total_duration_min": sum(t["duration_min"] for t in tasks),
            })

        now_str = _utc_now_iso()
        plan_id = f"plan_{uuid.uuid4().hex[:12]}"
        target_date_clean = (today + timedelta(days=total_days)).strftime("%Y-%m-%d")
        with self.transaction():
            self._conn.execute(
                """
                UPDATE sprint_plans
                SET status = 'archived', updated_at = ?
                WHERE project_id = ? AND owner_id = ? AND status = 'active'
                """,
                (now_str, project_id, owner_id),
            )
            self._conn.execute(
                """
                INSERT INTO sprint_plans (
                    plan_id, owner_id, project_id, course_name, target_date,
                    total_days, daily_hours, target_score, mode, status,
                    urgency_level, stages_json, daily_tasks_json, content_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
                """,
                (
                    plan_id,
                    owner_id,
                    project_id,
                    course_name,
                    target_date_clean,
                    total_days,
                    float(daily_hours or 1.0),
                    float(target_score or 85.0),
                    mode or "sprint",
                    "light",
                    json.dumps(stages, ensure_ascii=False),
                    json.dumps(daily_tasks, ensure_ascii=False),
                    json.dumps({"kind": "bootstrap", "source": "bootstrap"}, ensure_ascii=False),
                    now_str,
                    now_str,
                ),
            )
        return self.get_sprint_plan_by_id(plan_id, owner_id) or {}

    def create_or_generate_sprint_plan(
        self,
        owner_id: str,
        project_id: str,
        course_name: str = "",
        target_date: str = "",
        total_days: int = 0,
        daily_hours: float = 2.0,
        target_score: float = 85.0,
        mode: str = "sprint",  # 'rescue'(3天) / 'sprint'(7天) / 'mastery'(14天) / 'custom'
        nodes: list[dict[str, Any]] | None = None,
        cards: list[dict[str, Any]] | None = None,
        quizzes: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """
        纯粹期末冲刺计划引擎：基于知识库掌握度、FSRS 遗忘曲线与测验题库，
        利用倒推三阶段算法生成自适应期末冲刺计划，完全解耦外部微北洋绑定。
        """
        today = _today_date()

        # 1. 规范冲刺总天数与截止日期
        # ⚠️ 优先级必须是「显式 total_days > 显式 target_date > 模式默认跨度」。
        #    曾先把模式默认值填进 total_days，再用 total_days>0 判断，
        #    导致用户明确给了考试日期（比如 20 天后）仍被排成 7 天、结束日算成今天+7。
        explicit_days = total_days > 0
        if not explicit_days:
            if mode == "rescue":
                total_days = 3
            elif mode == "mastery":
                total_days = 14
            else:
                total_days = 7

        # 模式预设同时约束每日投入时长（仅在没有自定义时生效）
        if mode == "rescue":
            daily_hours = max(2.0, daily_hours)
        elif mode == "mastery":
            daily_hours = daily_hours or 1.5
        else:
            daily_hours = daily_hours or 2.0

        if target_date:
            try:
                t_date = datetime.strptime(target_date[:10], "%Y-%m-%d").date()
                diff_days = (t_date - today).days
                if diff_days > 0 and not explicit_days:
                    total_days = diff_days
            except Exception:
                pass

        # 兜底与上限：避免异常日期造出跨年的荒唐计划
        if total_days <= 0:
            total_days = 7
        total_days = min(total_days, 60)
        target_date_clean = (today + timedelta(days=total_days)).strftime("%Y-%m-%d")

        # 2. 补齐学科名称
        final_course_name = (course_name or "").strip()
        if not final_course_name and project_id:
            try:
                row = self._conn.execute(
                    "SELECT subject FROM projects WHERE project_id = ? LIMIT 1",
                    (project_id,),
                ).fetchone()
                if row and row["subject"]:
                    final_course_name = row["subject"].strip()
            except sqlite3.OperationalError:
                pass
        if not final_course_name:
            final_course_name = "期末核心学科"

        # 3. 收集知识节点（统一归一化 + 按冲刺优先级排序）
        candidate_nodes: list[dict[str, Any]] = []
        if nodes is not None:
            candidate_nodes = self._normalize_sprint_nodes(nodes)
        elif project_id:
            candidate_nodes = self._fetch_sprint_nodes(project_id)

        # 3b. 资料文件名表：把节点的 source_ids（双链图谱）解析成「依据《xxx》」
        source_names = self._fetch_source_names(project_id) if project_id else {}

        # 3c. 学习路径约定：没有真实考点时**不再编造占位考点**。
        #     旧口径会落 5 个 syn_* 合成节点，产出「考点攻坚 · 核心基本概念与大纲框架」
        #     这种每天一字不差的公式化计划 —— 用户看到的就是它。框架都没建，
        #     务实的做法是把「把框架建起来」本身排成计划（bootstrap），建好后
        #     重新制定，才会走真正的「先排路径、再按天分配」。
        if not candidate_nodes:
            return self._create_bootstrap_plan(
                owner_id=owner_id,
                project_id=project_id,
                course_name=final_course_name,
                daily_hours=daily_hours,
                target_score=target_score,
                mode=mode,
            )

        # 3d. 标注学习路径站位 + 前置索引（前置自测文案、回看都要用）
        path_total = self._assign_path(candidate_nodes)
        name_by_id = {
            str(n.get("node_id")): str(n.get("name") or "")
            for n in candidate_nodes
            if n.get("node_id")
        }
        mastery_by_id = {
            str(n.get("node_id")): float(n.get("mastery_score") or 0.0)
            for n in candidate_nodes
            if n.get("node_id")
        }

        # 4. 收集 FSRS 到期卡片（含从未复习过的新卡）
        candidate_cards: list[dict[str, Any]] = []
        if cards is not None:
            candidate_cards = list(cards)
        elif project_id:
            candidate_cards = self._fetch_due_cards(project_id, owner_id, limit=40)

        # 4b. 强度模型：目标分 × 掌握度缺口 × 可用天数 × 每日时长 → 每天覆盖几个考点
        #     用户要的是「天数少又要求分高，就排一个覆盖很多知识点的计划」，
        #     所以强度不该由用户手选档位决定，而是从「差多少分 / 有多少天 / 每天几小时」推出来。
        #     公式刻意保持可解释 —— 取舍结论会原样显示给用户（前端读 intensity）。
        mastery_values = [
            float(n.get("mastery_score") or n.get("mastery") or 0.0) for n in candidate_nodes
        ]
        avg_mastery = sum(mastery_values) / len(mastery_values) if mastery_values else 0.45
        target_ratio = max(0.0, min(1.0, float(target_score or 85.0) / 100.0))
        # 缺口 = 目标分 - 当前平均掌握度（掌握度是 0~1 的把握度，这里做保守折算）
        mastery_gap = max(0.05, target_ratio - avg_mastery)
        # 压力系数：缺口越大越要赶（gap 0.5 → 1.0；gap 0.05 → 0.35）
        pressure = max(0.35, min(1.0, mastery_gap * 2.0))
        node_total = len(candidate_nodes)
        want_nodes_per_day = max(1, math.ceil(node_total * pressure / total_days))
        # 容量：每天能塞几个考点由每日时长决定（每个考点 25 分钟，另有约 45 分钟固定动作）
        daily_minutes = max(60.0, float(daily_hours or 2.0) * 60.0)
        capacity_nodes = max(1, int((daily_minutes - 45.0) // 25))
        nodes_per_day = max(1, min(want_nodes_per_day, capacity_nodes))
        # 排不下全部考点时如实记账 —— 前端会显示成「已覆盖 X / Y 个考点，按考频优先」
        uncovered_nodes = max(0, node_total - nodes_per_day * total_days)
        card_count = max(5, min(12, int(round(float(daily_hours or 2.0) * 3))))

        # 5. 倒推三阶段规划划分 (Backward 3-Phase Strategy)
        if total_days <= 3:
            p1_days = 1
            p2_days = max(1, total_days - 2)
            p3_days = 1 if total_days > 1 else 0
        elif total_days <= 7:
            p1_days = max(1, round(total_days * 0.3))
            p3_days = max(1, round(total_days * 0.28))
            p2_days = max(1, total_days - p1_days - p3_days)
        else:
            p1_days = max(2, round(total_days * 0.28))
            p3_days = max(2, round(total_days * 0.22))
            p2_days = max(2, total_days - p1_days - p3_days)

        # 微调对齐总天数
        diff = total_days - (p1_days + p2_days + p3_days)
        if diff != 0:
            p2_days += diff

        # 名字与说明都取短：前端把 name 当 chip 显示（「全景筑基 · 3天」），focus 只进 title 提示
        stages = [
            {"stage": 1, "name": "全景筑基", "days": p1_days, "focus": "扫一遍大纲，找出盲区", "badge": "筑基"},
            {"stage": 2, "name": "难点攻坚", "days": p2_days, "focus": "死磕弱项考点，清空到期闪卡", "badge": "攻坚"},
            {"stage": 3, "name": "全真模拟", "days": p3_days, "focus": "闭卷模拟，查漏补缺", "badge": "自测"},
        ]

        # 7. 每日任务装配与带宽约束调度
        #    路径已排好（3d 标注站位），每天**连续领一段**：今天走第 X–Y 站，
        #    走完整个 total_days 正好把路径过 lap 遍。当天目标、回看、前置自测
        #    全部从「这段路上有谁」派生，不再每天复读同一套模板。
        daily_tasks: list[dict[str, Any]] = []
        node_cursor = 0
        prev_day_stations: list[dict[str, Any]] = []
        for d in range(1, total_days + 1):
            task_date = (today + timedelta(days=d - 1)).strftime("%Y-%m-%d")
            if d <= p1_days:
                st_num = 1
                st_name = "全景筑基"
            elif d <= p1_days + p2_days:
                st_num = 2
                st_name = "难点攻坚"
            else:
                st_num = 3
                st_name = "全真模拟"

            tasks: list[dict[str, Any]] = []
            first_node: dict[str, Any] | None = None
            day_stations: list[dict[str, Any]] = []
            day_start_cursor = node_cursor  # 当天第一站的游标：lap 从这里算，节点上没有该字段

            # 考点任务：按强度覆盖 nodes_per_day 个（「天数少、要求高 → 多覆盖」的落点）。
            # 游标越过路径末尾 = 进入下一遍（lap），如实标出来 —— 第二遍的目标是查卡壳。
            for _ in range(nodes_per_day):
                lap = node_cursor // len(candidate_nodes) + 1
                cur_node = candidate_nodes[node_cursor % len(candidate_nodes)]
                node_cursor += 1
                if first_node is None:
                    first_node = cur_node
                day_stations.append(cur_node)
                cur_node_name = cur_node.get("name") or cur_node.get("title")
                cur_ms = round(
                    float(cur_node.get("mastery_score") or cur_node.get("mastery") or 0.0) * 100
                )
                cur_material, cur_refs, cur_linked = self._node_material(cur_node, source_names)
                prereq_name = self._prereq_to_check(cur_node, name_by_id, mastery_by_id)
                tasks.append({
                    "task_id": f"d{d}_t{len(tasks) + 1}",
                    "type": "concept",
                    "title": f"考点攻坚 · {cur_node_name}",
                    "detail": self._concept_detail(
                        cur_node_name, cur_material, cur_refs, cur_linked, cur_ms,
                        prereq_name=prereq_name,
                    ),
                    "duration_min": 25,
                    "node_id": cur_node.get("node_id"),
                    # 排期时点的掌握度快照：练习结果回流时用它算出「涨了还是掉了」
                    "node_name": cur_node_name,
                    "baseline_mastery": float(cur_node.get("mastery_score") or 0.0),
                    # 学习路径坐标：第几站 / 第几遍 —— 前端显示「第 N 站」，AI 文案据此写目标
                    "path_index": cur_node.get("path_index"),
                    "path_lap": lap,
                    "completed": False,
                })

            # FSRS 闪卡任务（张数随每日时长缩放）
            tasks.append({
                "task_id": f"d{d}_t{len(tasks) + 1}",
                "type": "cards",
                "title": f"闪卡复习 · {card_count} 张",
                "detail": "先回忆再翻面，按遗忘曲线排下一次",
                "duration_min": 20,
                # 带上当天要刷的卡，前端可直接进入卡片复习
                "card_ids": [c.get("card_id") for c in candidate_cards[:card_count] if c.get("card_id")],
                "completed": False,
            })

            # 阶段专属动作：从「每天固定一套」改成从路径派生 ——
            # 筑基期第 1 天做全局基线；第 2 天起改为回看**昨天**走过的站（路径内间隔重复）；
            # 攻坚期自测打在当天第一站上；模拟期不变。
            if st_num == 1 and d == 1:
                tasks.append({
                    "task_id": f"d{d}_t{len(tasks) + 1}",
                    "type": "overview",
                    "title": "框架对照 · 整理考点地图",
                    "detail": f"看速查表，对照学习路径共 {path_total} 站，标出还说不清的考点",
                    "duration_min": 20,
                    "completed": False,
                })
            elif st_num == 1:
                review = self._path_review_task(d, prev_day_stations)
                if review is None:
                    review = {
                        "type": "overview",
                        "title": "框架对照 · 整理考点地图",
                        "detail": "看速查表，标出还说不清的考点",
                        "duration_min": 20,
                        "completed": False,
                    }
                review["task_id"] = f"d{d}_t{len(tasks) + 1}"
                tasks.append(review)
            elif st_num == 2:
                # 自测打在当天第一个攻坚考点上，不再另占一个新考点名额
                q_node = first_node or candidate_nodes[0]
                q_name = str(q_node.get("name") or q_node.get("title") or "")
                tasks.append({
                    "task_id": f"d{d}_t{len(tasks) + 1}",
                    "type": "quiz",
                    "title": f"靶向自测 · {q_name}",
                    "detail": "做题自测，错题当场过一遍",
                    "duration_min": 20,
                    "node_id": q_node.get("node_id"),
                    "node_name": q_name,
                    "baseline_mastery": float(q_node.get("mastery_score") or 0.0),
                    "completed": False,
                })
            else:
                tasks.append({
                    "task_id": f"d{d}_t{len(tasks) + 1}",
                    "type": "quiz",
                    "title": "全真限时模拟 · 综合卷",
                    "detail": "闭卷限时做完，复盘错因",
                    "duration_min": 30,
                    "completed": False,
                })
                tasks.append({
                    "task_id": f"d{d}_t{len(tasks) + 1}",
                    "type": "summary",
                    "title": "闭卷默写核心公式",
                    "detail": "脱稿默写定理与公式，错题卡清到会为止",
                    "duration_min": 20,
                    "completed": False,
                })

            day_total_min = sum(t["duration_min"] for t in tasks)
            day_lap = day_start_cursor // len(candidate_nodes) + 1
            daily_tasks.append({
                "day_index": d,
                "date": task_date,
                "stage_num": st_num,
                "stage_name": st_name,
                "is_today": (task_date == today.strftime("%Y-%m-%d")),
                # 学习路径切段坐标：今天领到的是哪几站
                "path_from": day_stations[0].get("path_index") if day_stations else 0,
                "path_to": day_stations[-1].get("path_index") if day_stations else 0,
                "path_total": path_total,
                "path_lap": day_lap,
                "day_goal": self._day_goal(
                    day_stations,
                    day_stations[0].get("path_index") if day_stations else 0,
                    day_stations[-1].get("path_index") if day_stations else 0,
                    path_total,
                    day_lap,
                ),
                "tasks": tasks,
                "total_duration_min": day_total_min,
            })
            prev_day_stations = day_stations

        # 8. 负荷与动态紧迫度指标 (Study-Planner Algorithmic Metric)
        total_mins = sum(dt["total_duration_min"] for dt in daily_tasks)
        daily_avg_min = round(total_mins / max(1, total_days))
        if daily_avg_min <= 75:
            urgency_level = "light"      # 轻松在轨
        elif daily_avg_min <= 120:
            urgency_level = "moderate"   # 稳健适中
        else:
            urgency_level = "heavy"      # 高压冲刺

        now_str = _utc_now_iso()
        plan_id = f"plan_{uuid.uuid4().hex[:12]}"

        # 9. 落库持久化（旧激活计划自动归档）
        with self.transaction():
            self._conn.execute(
                """
                UPDATE sprint_plans
                SET status = 'archived', updated_at = ?
                WHERE project_id = ? AND owner_id = ? AND status = 'active'
                """,
                (now_str, project_id, owner_id),
            )
            self._conn.execute(
                """
                INSERT INTO sprint_plans (
                    plan_id, owner_id, project_id, course_name, target_date,
                    total_days, daily_hours, target_score, mode, status,
                    urgency_level, stages_json, daily_tasks_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
                """,
                (
                    plan_id,
                    owner_id,
                    project_id,
                    final_course_name,
                    target_date_clean,
                    total_days,
                    float(daily_hours),
                    float(target_score),
                    mode,
                    urgency_level,
                    json.dumps(stages, ensure_ascii=False),
                    json.dumps(daily_tasks, ensure_ascii=False),
                    now_str,
                    now_str,
                ),
            )

        return self.get_sprint_plan_by_id(plan_id, owner_id) or {}

    # ── AI 文案回填（算法定骨架，tju-llm 只写内容）──────────────────────

    def build_sprint_content_payload(self, plan: dict[str, Any]) -> dict[str, Any]:
        """把已排好期的计划压成 LLM 能吃的紧凑载荷。

        只给模型「已存在的任务槽位」与「允许点名的实体名」，
        让它无法凭空造出新的考点/日期 —— 骨架（日期、时长、绑定）不经过模型。
        """
        days: list[dict[str, Any]] = []
        materials = self._sprint_node_materials(str(plan.get("project_id") or ""))
        for dt in plan.get("daily_tasks") or []:
            task_slots: list[dict[str, Any]] = []
            for t in dt.get("tasks") or []:
                slot: dict[str, Any] = {
                    "task_id": t.get("task_id"),
                    "type": t.get("type"),
                    "template_title": t.get("title"),
                    "duration_min": t.get("duration_min"),
                }
                if t.get("node_name"):
                    slot["node_name"] = t.get("node_name")
                    if t.get("baseline_mastery") is not None:
                        slot["mastery_percent"] = round(float(t["baseline_mastery"]) * 100)
                    # 学习路径坐标：让模型知道这一站是第几站、第几遍，
                    # 写出来的目标才是「这段路上」的目标而不是通用句。
                    if t.get("path_index"):
                        slot["path_index"] = t.get("path_index")
                    if t.get("path_lap"):
                        slot["path_lap"] = t.get("path_lap")
                # 把考点自己的资料一并交给模型：只有给了「这份资料讲了什么、它挂在哪份文件、
                # 和哪个考点互为对照」，模型才写得具体；否则只能复读考点名。
                info = materials.get(str(t.get("node_id") or ""))
                if info:
                    if info.get("material"):
                        slot["material"] = info["material"]
                    if info.get("refs"):
                        slot["source_files"] = info["refs"]
                    if info.get("linked"):
                        slot["linked_nodes"] = info["linked"]
                if t.get("card_ids"):
                    slot["card_count"] = len(t["card_ids"])
                task_slots.append(slot)
            days.append({
                "day_index": dt.get("day_index"),
                "date": dt.get("date"),
                "stage_name": dt.get("stage_name"),
                # 当天领到的路径段：模型写「今天走第几站到第几站」时据此引用，
                # 不得改数字、不得编造段外的站点。
                "path_from": dt.get("path_from"),
                "path_to": dt.get("path_to"),
                "path_total": dt.get("path_total"),
                "path_lap": dt.get("path_lap") or 1,
                "tasks": task_slots,
            })

        return {
            "instruction": (
                "为下面每一天的每个任务槽位改写文案。task_id 必须与载荷一一对应，"
                "不得新增/删除/重排任务，不得改动任务类型、时长与绑定关系。"
                "需要点名考点、资料或关联考点时，必须原样照抄载荷中给出的名称，"
                "考点用「」包裹、资料用《》包裹，不得自行编造。"
                "若槽位带了 material / source_files / linked_nodes，"
                "请据此写出「看哪份资料的哪个点、做什么动作」，不要写成放之四海皆准的空话。"
                "每天有 path_from/path_to/path_total（学习路径第几站到第几站、共几站），"
                "concept 任务的 detail 应体现「这一天在路径上走到了哪里」；"
                "path_lap ≥ 2 表示是复习遍，目标应写成「卡壳处归零」而不是第一次学会。"
            ),
            "course_name": plan.get("course_name"),
            "target_date": plan.get("target_date"),
            "total_days": plan.get("total_days"),
            "target_score": plan.get("target_score"),
            "stages": [
                {"name": s.get("name"), "days": s.get("days"), "focus": s.get("focus")}
                for s in (plan.get("stages") or [])
            ],
            "days": days,
        }

    def apply_sprint_content(
        self,
        plan_id: str,
        owner_id: str,
        content: dict[str, Any],
    ) -> dict[str, Any]:
        """把 LLM 回填的文案合并进计划，逐字段做防幻觉校验，不合规就退回算法模板。

        校验口径（任一不过 → 该字段保留模板值）：
        1. task_id / day_index 必须命中计划里已有的槽位，未知的一律忽略；
        2. 引号内点名的实体必须在载荷允许名单内（防编造章节/考点）；
        3. 文案长度必须在上限内。
        """
        row = self._conn.execute(
            "SELECT * FROM sprint_plans WHERE plan_id = ? AND owner_id = ?",
            (plan_id, owner_id),
        ).fetchone()
        if not row:
            raise ValueError("未找到冲刺计划或无权访问")

        d = dict(row)
        daily_tasks = json.loads(d.get("daily_tasks_json") or "[]")
        stages = json.loads(d.get("stages_json") or "[]")

        allowed_names = {str(d.get("course_name") or "").strip()}
        for st in stages:
            allowed_names.add(str(st.get("name") or "").strip())
        for dt in daily_tasks:
            for t in dt.get("tasks") or []:
                if t.get("node_name"):
                    allowed_names.add(str(t["node_name"]).strip())
        # 资料文件名与关联考点也在载荷里给过模型，模型照抄它们属于「有据可依」，
        # 不放进名单就会被误判成编造而整条丢弃。
        materials = self._sprint_node_materials(str(d.get("project_id") or ""))
        for dt in daily_tasks:
            for t in dt.get("tasks") or []:
                info = materials.get(str(t.get("node_id") or ""))
                if not info:
                    continue
                for name in list(info.get("refs") or []) + list(info.get("linked") or []):
                    allowed_names.add(str(name).strip())
        allowed_names.discard("")

        task_index: dict[str, dict[str, Any]] = {}
        for dt in daily_tasks:
            for t in dt.get("tasks") or []:
                if t.get("task_id"):
                    task_index[str(t["task_id"])] = t

        accepted = 0
        rejected = 0
        days = content.get("days") if isinstance(content, dict) else None
        for day in days if isinstance(days, list) else []:
            if not isinstance(day, dict):
                continue
            for item in day.get("tasks") or []:
                if not isinstance(item, dict):
                    continue
                task = task_index.get(str(item.get("task_id") or ""))
                if task is None:
                    continue
                wrote = False
                for field, cap in (
                    ("title", _SPRINT_TITLE_MAX),
                    ("detail", _SPRINT_DETAIL_MAX),
                    ("reason", _SPRINT_REASON_MAX),
                ):
                    text = self._clean_sprint_text(item.get(field))
                    if not text or len(text) > cap:
                        rejected += 1
                        continue
                    if not self._quoted_terms_grounded(text, allowed_names):
                        rejected += 1
                        continue
                    task[field] = text
                    wrote = True
                if wrote:
                    task["ai_written"] = True
                    accepted += 1

        meta = {
            "source": "llm",
            "enriched_at": _utc_now_iso(),
            "enriched_tasks": accepted,
            "rejected_fields": rejected,
            "total_tasks": len(task_index),
        }
        if accepted == 0:
            # 一条都没采纳时不冒领「AI 写细」的名头：否则计划会被标成 llm_enriched=true
            # 却显示「已写细 0 项任务」，前端还会因此藏掉重试按钮，用户再没机会补救。
            return self.get_sprint_plan_by_id(plan_id, owner_id) or {}

        now_str = _utc_now_iso()
        with self.transaction():
            self._conn.execute(
                "UPDATE sprint_plans SET daily_tasks_json = ?, content_json = ?, updated_at = ? WHERE plan_id = ?",
                (json.dumps(daily_tasks, ensure_ascii=False), json.dumps(meta, ensure_ascii=False), now_str, plan_id),
            )
        return self.get_sprint_plan_by_id(plan_id, owner_id) or {}

    @staticmethod
    def _clean_sprint_text(value: Any) -> str:
        """清洗模型文案：只收字符串，去掉换行与 Markdown 残留，压缩空白。"""
        if not isinstance(value, str):
            return ""
        text = value.replace("\r", " ").replace("\n", " ").strip()
        text = text.strip("`*#> \t")
        return re.sub(r"\s{2,}", " ", text)

    @staticmethod
    def _quoted_terms_grounded(text: str, allowed_names: set[str]) -> bool:
        """引号里点名的实体必须能在允许名单里对上；没点名就直接放行。"""
        for span in _SPRINT_QUOTE_RE.findall(text):
            term = span.strip()
            if not term:
                continue
            if not any(term in name or name in term for name in allowed_names):
                return False
        return True

    def get_sprint_plan_by_id(self, plan_id: str, owner_id: str = "") -> dict[str, Any] | None:
        """获取特定 ID 的冲刺计划详情与最新统计。"""
        if owner_id:
            row = self._conn.execute(
                "SELECT * FROM sprint_plans WHERE plan_id = ? AND owner_id = ?",
                (plan_id, owner_id),
            ).fetchone()
        else:
            row = self._conn.execute(
                "SELECT * FROM sprint_plans WHERE plan_id = ?",
                (plan_id,),
            ).fetchone()
        if not row:
            return None
        return self._enrich_sprint_plan(dict(row))

    def get_active_sprint_plan(self, owner_id: str, project_id: str) -> dict[str, Any] | None:
        """获取用户在指定知识库项目下当前激活的期末冲刺计划。"""
        row = self._conn.execute(
            """
            SELECT * FROM sprint_plans
            WHERE owner_id = ? AND project_id = ? AND status = 'active'
            ORDER BY created_at DESC LIMIT 1
            """,
            (owner_id, project_id),
        ).fetchone()
        if not row:
            return None
        return self._enrich_sprint_plan(dict(row))

    def toggle_sprint_task(
        self,
        owner_id: str,
        plan_id: str,
        task_id: str,
        completed: bool | None = None,
    ) -> dict[str, Any]:
        """打卡完成或取消完成某项每日冲刺任务。"""
        row = self._conn.execute(
            "SELECT * FROM sprint_plans WHERE plan_id = ? AND owner_id = ?",
            (plan_id, owner_id),
        ).fetchone()
        if not row:
            raise ValueError("未找到冲刺计划或无权访问")

        d = dict(row)
        daily_tasks = json.loads(d.get("daily_tasks_json") or "[]")
        found = False
        target_completed = False

        for dt in daily_tasks:
            for t in dt.get("tasks", []):
                if t.get("task_id") == task_id:
                    if completed is None:
                        t["completed"] = not bool(t.get("completed"))
                    else:
                        t["completed"] = bool(completed)
                    target_completed = t["completed"]
                    t["completed_at"] = _utc_now_iso() if target_completed else None
                    found = True
                    break
            if found:
                break

        if not found:
            raise ValueError(f"未找到任务 ID: {task_id}")

        now_str = _utc_now_iso()
        with self.transaction():
            self._conn.execute(
                "UPDATE sprint_plans SET daily_tasks_json = ?, updated_at = ? WHERE plan_id = ?",
                (json.dumps(daily_tasks, ensure_ascii=False), now_str, plan_id),
            )

        return self.get_sprint_plan_by_id(plan_id, owner_id) or {}

    def delete_sprint_plan(self, owner_id: str, plan_id: str) -> bool:
        """删除或重置冲刺计划。"""
        with self.transaction():
            cur = self._conn.execute(
                "DELETE FROM sprint_plans WHERE plan_id = ? AND owner_id = ?",
                (plan_id, owner_id),
            )
            return cur.rowcount > 0

    def export_sprint_ics(self, owner_id: str, plan_id: str) -> str:
        """导出期末冲刺计划的 RFC-5545 iCalendar (.ics) 日历。"""
        plan = self.get_sprint_plan_by_id(plan_id, owner_id)
        if not plan:
            raise ValueError("未找到冲刺计划")

        cname = plan.get("course_name") or "期末学科"
        lines = [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:-//Tianjin University KnowOrigin//Sprint Planner//CN",
            "CALSCALE:GREGORIAN",
            "METHOD:PUBLISH",
            f"X-WR-CALNAME:【期末冲刺】{cname} 备考日程",
            "X-WR-TIMEZONE:Asia/Shanghai",
        ]

        now_stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        for dt in plan.get("daily_tasks", []):
            d_idx = dt.get("day_index")
            dt_date = (dt.get("date") or "").replace("-", "")
            if not dt_date:
                continue
            st_name = dt.get("stage_name") or "冲刺攻坚"
            t_list = dt.get("tasks", [])
            task_desc_lines = [f"{i+1}. {t.get('title')} ({t.get('duration_min')}分钟)" for i, t in enumerate(t_list)]
            desc = f"【{st_name}】今日冲刺目标：\\n" + "\\n".join(task_desc_lines)
            desc += f"\\n预计专注耗时：{dt.get('total_duration_min')}分钟"

            # 默认安排在每晚 19:30 - 21:00 黄金冲刺专注段
            dtstart = f"{dt_date}T193000"
            dtend = f"{dt_date}T210000"

            lines.extend([
                "BEGIN:VEVENT",
                f"UID:sprint_{plan_id}_d{d_idx}@knoworigin.tju",
                f"DTSTAMP:{now_stamp}",
                f"DTSTART:{dtstart}",
                f"DTEND:{dtend}",
                f"SUMMARY:【期末冲刺 D{d_idx}】{cname} · {st_name}",
                f"DESCRIPTION:{desc}",
                "BEGIN:VALARM",
                "TRIGGER:-PT15M",
                "ACTION:DISPLAY",
                f"DESCRIPTION:期末冲刺提醒：今晚 {cname} 冲刺任务即将开始",
                "END:VALARM",
                "END:VEVENT",
            ])

        # 终局考试事件
        t_clean = (plan.get("target_date") or "").replace("-", "")
        if t_clean:
            lines.extend([
                "BEGIN:VEVENT",
                f"UID:sprint_{plan_id}_exam@knoworigin.tju",
                f"DTSTAMP:{now_stamp}",
                f"DTSTART:{t_clean}T090000",
                f"DTEND:{t_clean}T110000",
                f"SUMMARY:🎯【期末大考】{cname} 决战考场",
                f"DESCRIPTION:预祝考神附体，高分必过！\\n目标成绩：{plan.get('target_score')}分",
                "BEGIN:VALARM",
                "TRIGGER:-P1D",
                "ACTION:DISPLAY",
                f"DESCRIPTION:明日考试提醒：{cname} 期末大考",
                "END:VALARM",
                "END:VEVENT",
            ])

        lines.append("END:VCALENDAR")
        return "\r\n".join(lines)

    def _enrich_sprint_plan(self, plan: dict[str, Any]) -> dict[str, Any]:
        """丰富冲刺计划运行时动态指标：计算当前天数、今日任务、完成度与番茄钟。"""
        today = _today_date()
        try:
            target_d = datetime.strptime(plan.get("target_date", "")[:10], "%Y-%m-%d").date()
            days_remaining = max(0, (target_d - today).days)
        except Exception:
            days_remaining = 0

        stages = json.loads(plan.get("stages_json") or "[]")
        daily_tasks = json.loads(plan.get("daily_tasks_json") or "[]")
        content_meta = json.loads(plan.get("content_json") or "{}")
        # bootstrap（先建框架）路标计划：给前端一个显式标记 —— 提示去建框架、
        # 隐藏「AI 写细」、自动 enrich 也跳过（给路标写文案没有意义）。
        plan["needs_framework"] = content_meta.get("kind") == "bootstrap"

        # 练习结果回流：把「做错了 / 掌握度掉了」的考点任务标出来，让计划自己会喊疼。
        node_mastery, wrong_nodes, lapsed_cards = self._collect_reflow_signals(plan)
        reflow_tasks = 0
        reflow_dropped = 0
        mastery_deltas: list[float] = []

        total_tasks_count = 0
        completed_tasks_count = 0
        today_date_str = today.strftime("%Y-%m-%d")
        today_schedule: dict[str, Any] | None = None
        current_day_index = 1

        for dt in daily_tasks:
            dt["is_today"] = (dt.get("date") == today_date_str)
            if dt["is_today"]:
                today_schedule = dt
                current_day_index = dt.get("day_index", 1)
            t_list = dt.get("tasks", [])
            for t in t_list:
                total_tasks_count += 1
                if t.get("completed"):
                    completed_tasks_count += 1
                self._annotate_task_reflow(t, node_mastery, wrong_nodes, lapsed_cards)
                if t.get("needs_review"):
                    reflow_tasks += 1
                    if t.get("mastery_delta") is not None and t["mastery_delta"] < 0:
                        reflow_dropped += 1
                if t.get("mastery_delta") is not None:
                    mastery_deltas.append(float(t["mastery_delta"]))

        # 若今天不在区间内，根据创建日期自动定位当前第几天
        if not today_schedule and daily_tasks:
            try:
                c_date = datetime.strptime(plan.get("created_at", "")[:10], "%Y-%m-%d").date()
                c_idx = (today - c_date).days + 1
                c_idx = max(1, min(c_idx, len(daily_tasks)))
            except Exception:
                c_idx = 1
            current_day_index = c_idx
            today_schedule = daily_tasks[c_idx - 1]
            today_schedule["is_today"] = True

        progress_pct = round((completed_tasks_count / total_tasks_count) * 100) if total_tasks_count > 0 else 0

        total_mins = sum(dt.get("total_duration_min", 0) for dt in daily_tasks)
        daily_avg_min = round(total_mins / max(1, len(daily_tasks))) if daily_tasks else 90
        daily_pomodoros = max(1, math.ceil(daily_avg_min / 25))

        workload_badges = {
            "light": {"text": "轻松在轨 · On-Track", "variant": "success"},
            "moderate": {"text": "稳健适中 · Steady", "variant": "warning"},
            "heavy": {"text": "高压冲刺 · Intensive", "variant": "danger"},
        }

        plan["days_remaining"] = days_remaining
        plan["current_day_index"] = current_day_index
        plan["stages"] = stages
        plan["daily_tasks"] = daily_tasks
        plan["today_schedule"] = today_schedule
        plan["today_tasks"] = today_schedule.get("tasks", []) if today_schedule else []
        plan["total_tasks_count"] = total_tasks_count
        plan["completed_tasks_count"] = completed_tasks_count
        plan["progress_percentage"] = progress_pct
        plan["daily_avg_min"] = daily_avg_min
        plan["daily_pomodoros"] = daily_pomodoros
        plan["workload_info"] = workload_badges.get(plan.get("urgency_level", "moderate"), workload_badges["moderate"])
        plan["content_source"] = content_meta.get("source") or "algorithm"
        plan["llm_enriched"] = plan["content_source"] == "llm"
        plan["enriched_tasks"] = int(content_meta.get("enriched_tasks") or 0)
        plan["enriched_at"] = content_meta.get("enriched_at")
        plan["reflow_summary"] = {
            "needs_review_tasks": reflow_tasks,
            "dropped_tasks": reflow_dropped,
            "avg_mastery_delta": round(sum(mastery_deltas) / len(mastery_deltas), 1) if mastery_deltas else 0.0,
        }
        # 强度回执：直接从计划自身推导（不加表列），前端把它显示成计划头上的一行
        nodes_per_day_seen = 0
        concept_names: list[str] = []
        for dt in daily_tasks:
            day_concepts = [
                t for t in (dt.get("tasks") or [])
                if t.get("type") == "concept" and t.get("node_name")
            ]
            nodes_per_day_seen = max(nodes_per_day_seen, len(day_concepts))
            concept_names.extend(str(t["node_name"]) for t in day_concepts)
        try:
            total_nodes = len(self._fetch_sprint_nodes(str(plan.get("project_id") or "")))
        except Exception:
            total_nodes = 0
        covered_nodes = len(set(concept_names))
        plan["intensity"] = {
            "nodes_per_day": nodes_per_day_seen,
            "covered_nodes": covered_nodes,
            "total_nodes": total_nodes,
            "uncovered_nodes": max(0, total_nodes - covered_nodes),
            "daily_avg_min": daily_avg_min,
            "level": plan.get("urgency_level") or "moderate",
        }

        # 学习路径汇总：路径共几站、已覆盖几站、每天领到哪一段。
        # path_total 存在才给 —— bootstrap / 旧计划没有路径坐标，返回 None 让前端跳过。
        path_total_seen = max(
            (int(dt.get("path_total") or 0) for dt in daily_tasks), default=0
        )
        plan["learning_path"] = (
            {
                "total_stations": path_total_seen,
                "covered_stations": covered_nodes,
                "per_day": [
                    {
                        "day_index": dt.get("day_index"),
                        "path_from": dt.get("path_from"),
                        "path_to": dt.get("path_to"),
                        "path_lap": dt.get("path_lap") or 1,
                        "day_goal": dt.get("day_goal") or "",
                    }
                    for dt in daily_tasks
                ],
            }
            if path_total_seen
            else None
        )

        plan["has_reflow"] = reflow_tasks > 0

        return plan

    def _collect_reflow_signals(
        self, plan: dict[str, Any]
    ) -> tuple[dict[str, float], set[str], set[str]]:
        """一次性取回回流判定所需的三个信号，避免逐任务查库。

        返回 (node_id -> 当前掌握度, 计划生成后做错的 node_id 集合, 出现遗忘的 card_id 集合)。
        """
        node_mastery: dict[str, float] = {}
        wrong_nodes: set[str] = set()
        lapsed_cards: set[str] = set()

        project_id = plan.get("project_id")
        if not project_id:
            return node_mastery, wrong_nodes, lapsed_cards

        try:
            for r in self._conn.execute(
                "SELECT node_id, mastery_score FROM framework_nodes WHERE project_id = ?",
                (project_id,),
            ).fetchall():
                node_mastery[r["node_id"]] = float(r["mastery_score"] or 0.0)
        except sqlite3.OperationalError:
            pass

        created_at = plan.get("created_at") or ""
        try:
            for r in self._conn.execute(
                """
                SELECT DISTINCT node_id FROM learning_events
                WHERE project_id = ? AND created_at >= ?
                      AND correctness IS NOT NULL AND correctness < ?
                """,
                (project_id, created_at, _SPRINT_WRONG_CORRECTNESS),
            ).fetchall():
                wrong_nodes.add(r["node_id"])
        except sqlite3.OperationalError:
            pass

        if self._table_exists("card_srs_state"):
            try:
                for r in self._conn.execute(
                    "SELECT card_id FROM card_srs_state WHERE owner_id = ? AND lapses > 0",
                    (plan.get("owner_id") or "",),
                ).fetchall():
                    lapsed_cards.add(r["card_id"])
            except sqlite3.OperationalError:
                pass

        return node_mastery, wrong_nodes, lapsed_cards

    @staticmethod
    def _annotate_task_reflow(
        task: dict[str, Any],
        node_mastery: dict[str, float],
        wrong_nodes: set[str],
        lapsed_cards: set[str],
    ) -> None:
        """给单个任务挂上回流标记（就地写入，供前端标红）。"""
        node_id = task.get("node_id")
        if node_id:
            now = node_mastery.get(node_id)
            baseline = task.get("baseline_mastery")
            if now is not None:
                task["mastery_now"] = round(now * 100)
            if now is not None and baseline is not None:
                task["mastery_delta"] = round((now - float(baseline)) * 100, 1)
            reasons: list[str] = []
            if node_id in wrong_nodes:
                reasons.append("近期练习做错")
            if (
                now is not None
                and baseline is not None
                and now < float(baseline) - _SPRINT_DROP_TOLERANCE
            ):
                reasons.append("掌握度回落")
            task["needs_review"] = bool(reasons)
            task["review_reason"] = "、".join(reasons)
        elif task.get("card_ids"):
            hit = [cid for cid in task["card_ids"] if cid in lapsed_cards]
            task["needs_review"] = bool(hit)
            task["review_reason"] = f"有 {len(hit)} 张卡片近期遗忘" if hit else ""

