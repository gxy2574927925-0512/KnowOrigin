"""矛盾证据：当两份资料说法不一致时，**并排留住**，而不是让模型挑一个。

## 为什么这是学习工具的关键功能，而不是锦上添花

"学透"和"背答案"的分界线，就在**发现自己的材料互相打架**的那一刻。

理工科里这极其常见：不同教材的符号约定（`j` vs `i`、时间因子 `e^{iωt}` vs `e^{-iωt}`）、
同一物理量的不同定义、单位制的差异、公式成立条件被一份讲义省略而另一份强调。
文科里则是同一事件的不同叙述、不同学者的对立结论。

现在知源的做法（所有 RAG 类产品的默认做法）是：**检索到最相关的片段，让模型合成一个答案**。
当两个片段冲突时，模型会**默默挑一个**，或者把矛盾揉成一句和稀泥的话。
学习者拿到的是一段读起来通顺、实际上把分歧抹平的文字 —— 这恰恰是最糟糕的结果：
**他不会知道自己手上的两份资料是不一致的**，考试时按哪一份都可能错。

用户自述数据也支持这一点：中青报 2026-07 的调查里，**57.07%** 的受访学生遇到过
"AI 答案错误、知识点滞后，误导学习"，有学生因为直接背 AI 整理的知识点而在考试中答错。

## 口径（借 claude-obsidian 的 claim ledger 立场）

> "Unsupported and contradictory claims remain visible, and a grounded refusal
> is preferred over an invented citation."

本项目对应的三条：

1. **不判定谁对** —— 工具只负责把分歧摆在明面上，附两边原文，判断交给学习者（或老师）。
   强行裁决会让工具变成第二个"权威"，而它并不比教材更懂这个学科。
2. **必须给原文摘录**，不能只写"两处描述不一致"。没有原文的冲突提示等于制造焦虑。
3. **宁缺勿滥** —— 扫描结果少于阈值就返回空，不要把"表述不同但意思一致"报成矛盾。
   误报会毁掉这个功能的全部价值。

## 落点

新表 ``node_conflicts``，独立 store（仿 ``core/english_store.py``），
不碰 ``framework_nodes`` 与 ``learning_events`` 的任何既有语义。
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS node_conflicts (
    conflict_id TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL,
    owner_id    TEXT NOT NULL,
    node_id     TEXT,
    node_name   TEXT NOT NULL DEFAULT '',
    topic       TEXT NOT NULL DEFAULT '',
    side_a      TEXT NOT NULL DEFAULT '{}',
    side_b      TEXT NOT NULL DEFAULT '{}',
    why         TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'open',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_node_conflicts_project
    ON node_conflicts(project_id, status, updated_at DESC);
"""

STATUSES: tuple[str, ...] = ("open", "resolved")

STATUS_LABELS: dict[str, str] = {
    "open": "待判定",
    "resolved": "已判定",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _source_name(item: Any) -> str:
    """Source 模型用的是 ``filename``，其它来源可能叫 name/title —— 都兜住。"""
    for attr in ("name", "title", "filename"):
        value = getattr(item, attr, None)
        if isinstance(value, str) and value.strip():
            return value.strip()[:120]
    return ""


def normalize_status(value: Any) -> str:
    text = str(value or "").strip().lower()
    return text if text in STATUSES else "open"


# --------------------------------------------------------------------------
# Payload（纯函数）
# --------------------------------------------------------------------------

SCAN_RULES = (
    "【判定铁律 —— 违反任何一条，这条冲突就是误报，必须丢弃】\n"
    "1. 只有**实质冲突**才算：同一对象给出**互相排斥**的数值、符号约定、成立条件、"
    "结论或定义。\n"
    "2. 以下情况**不算**冲突，一律不要报：表述不同但意思一致；详略不同；"
    "一个讲一般情形、另一个讲特例（若特例被明确标注）；符号写法不同但已明确定义；"
    "一份资料没提到另一份说的内容。\n"
    "3. **不做裁决** —— 不要写「哪个对」。你只负责把分歧原样摆出来。\n"
    "4. 每一条冲突**必须附两边原文摘录**（各自不超过 120 字，可截断），"
    "不许改写、不许用自己的话概括成「一个说 X 一个说 Y」。\n"
    "5. 摘录必须**逐字来自 payload.sources**；找不到原文的候选直接丢弃。\n"
    "6. 宁缺勿滥：一条都找不到就返回空数组，**不要为了凑数硬报**。"
)

SCAN_SCHEMA_HINT = (
    "必须返回顶层字段 conflicts，格式为 {\"conflicts\": [ {...} ]}，"
    "每个元素含：topic（分歧点，2~40 字）、"
    "node_name（相关的知识节点名，可为空字符串）、"
    "a（对象，含 source_name 与 quote）、b（同结构）、"
    "why（一句话说明两者在哪一点上互斥，不超过 60 字）。"
    "不得返回 markdown、解释文本或 JSON 之外的内容。"
)


def build_scan_payload(
    *,
    project_name: str,
    nodes: Iterable[Any] = (),
    sources: Iterable[Any] = (),
    per_source: int = 1200,
    cap: int = 12,
    node_cap: int = 60,
) -> dict[str, Any]:
    """组装矛盾扫描的 payload。纯函数，不碰数据库。

    来源必须截断：矛盾扫描要"看得足够多"，但一次调用的输入有上限，
    超出之后模型反而会把中段的资料漏掉 —— 那样报出来的"没有矛盾"是假的。
    """
    excerpts: list[dict[str, str]] = []
    for item in sources:
        text = ""
        for attr in ("content", "text", "summary", "raw_text", "description"):
            value = getattr(item, attr, None)
            if isinstance(value, str) and value.strip():
                text = value.strip()
                break
        if not text:
            continue
        excerpts.append(
            {
                "source_id": str(getattr(item, "source_id", "") or getattr(item, "id", "") or ""),
                "name": _source_name(item),
                "excerpt": text[:per_source],
            }
        )
        if len(excerpts) >= cap:
            break

    return {
        "instruction": (
            f"下面是课程「{project_name}」的多份资料。请找出它们之间**互相矛盾**的地方。"
            "你的唯一任务是让分歧变得可见，不是给出正确答案。"
        ),
        "rules": SCAN_RULES,
        "schema": SCAN_SCHEMA_HINT,
        "nodes": [
            {"name": getattr(n, "name", "") or "", "description": (getattr(n, "description", "") or "")[:200]}
            for n in list(nodes)[: max(1, node_cap)]
        ],
        "sources": excerpts,
        "source_count": len(excerpts),
    }


def normalize_conflicts(raw: Any, *, min_quote: int = 8) -> list[dict[str, Any]]:
    """把模型返回的 conflicts 清洗成可入库结构。

    清洗规则（每条都对应一个真实的坏输出模式）：
      * 两边必须都有**足够长的非空**原文摘录 —— 没有原文的"冲突"不成立；
      * topic 为空 → 丢弃（无法在界面上呈现）；
      * 两边摘录**完全相同** → 不是冲突，是重复；
      * topic 重复的只留第一条。
    """
    items = raw if isinstance(raw, list) else []
    out: list[dict[str, Any]] = []
    seen_topics: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        topic = str(item.get("topic") or "").strip()
        if not topic or topic in seen_topics:
            continue
        side_a = _normalize_side(item.get("a"))
        side_b = _normalize_side(item.get("b"))
        if side_a is None or side_b is None:
            continue
        if len(side_a["quote"]) < min_quote or len(side_b["quote"]) < min_quote:
            continue
        if side_a["quote"].strip() == side_b["quote"].strip():
            continue
        seen_topics.add(topic)
        out.append(
            {
                "topic": topic[:80],
                "node_name": str(item.get("node_name") or "").strip()[:120],
                "why": str(item.get("why") or "").strip()[:200],
                "a": side_a,
                "b": side_b,
            }
        )
    return out


def _normalize_side(value: Any) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    quote = str(value.get("quote") or "").strip()
    if not quote:
        return None
    return {
        "source_id": str(value.get("source_id") or "").strip(),
        "source_name": str(value.get("source_name") or "").strip()[:120],
        "quote": quote[:400],
    }


# --------------------------------------------------------------------------
# Store
# --------------------------------------------------------------------------


class ConflictStore:
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

    def replace_all(
        self,
        *,
        project_id: str,
        owner_id: str,
        conflicts: list[dict[str, Any]],
        node_index: dict[str, str] | None = None,
    ) -> list[dict[str, Any]]:
        """整批替换一个项目的扫描结果。

        重扫就是重扫 —— 保留旧行会让用户看到已经修掉的分歧，比看不到更糟。
        但**已判定（resolved）的记录保留**：那是用户做过判断的痕迹，不该被机器覆盖。
        """
        mapping = node_index or {}
        stamp = _now()
        rows: list[dict[str, Any]] = []
        with self.transaction() as conn:
            conn.execute(
                "DELETE FROM node_conflicts WHERE project_id = ? AND status = 'open'",
                (project_id,),
            )
            for item in conflicts:
                node_name = item.get("node_name") or ""
                conflict_id = f"cfl_{uuid.uuid4().hex[:16]}"
                row = {
                    "conflict_id": conflict_id,
                    "project_id": project_id,
                    "owner_id": owner_id,
                    "node_id": mapping.get(node_name),
                    "node_name": node_name,
                    "topic": item.get("topic") or "",
                    "a": item.get("a") or {},
                    "b": item.get("b") or {},
                    "why": item.get("why") or "",
                    "status": "open",
                    "created_at": stamp,
                    "updated_at": stamp,
                }
                conn.execute(
                    "INSERT INTO node_conflicts (conflict_id, project_id, owner_id, node_id,"
                    " node_name, topic, side_a, side_b, why, status, created_at, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        row["conflict_id"],
                        row["project_id"],
                        row["owner_id"],
                        row["node_id"],
                        row["node_name"],
                        row["topic"],
                        json.dumps(row["a"], ensure_ascii=False),
                        json.dumps(row["b"], ensure_ascii=False),
                        row["why"],
                        row["status"],
                        row["created_at"],
                        row["updated_at"],
                    ),
                )
                rows.append(row)
        return rows

    def list_for_project(
        self, project_id: str, *, status: str | None = None
    ) -> list[dict[str, Any]]:
        if status:
            cursor = self._conn.execute(
                "SELECT * FROM node_conflicts WHERE project_id = ? AND status = ?"
                " ORDER BY updated_at DESC",
                (project_id, normalize_status(status)),
            )
        else:
            cursor = self._conn.execute(
                "SELECT * FROM node_conflicts WHERE project_id = ?"
                " ORDER BY status ASC, updated_at DESC",
                (project_id,),
            )
        return [_row_to_dict(row) for row in cursor.fetchall()]

    def set_status(self, project_id: str, conflict_id: str, status: Any) -> dict[str, Any] | None:
        normalized = normalize_status(status)
        with self.transaction() as conn:
            cur = conn.execute(
                "UPDATE node_conflicts SET status = ?, updated_at = ?"
                " WHERE project_id = ? AND conflict_id = ?",
                (normalized, _now(), project_id, conflict_id),
            )
            if not cur.rowcount:
                return None
        row = self._conn.execute(
            "SELECT * FROM node_conflicts WHERE project_id = ? AND conflict_id = ?",
            (project_id, conflict_id),
        ).fetchone()
        return _row_to_dict(row) if row is not None else None

    def summary(self, project_id: str) -> dict[str, int]:
        rows = self._conn.execute(
            "SELECT status, COUNT(*) AS n FROM node_conflicts WHERE project_id = ?"
            " GROUP BY status",
            (project_id,),
        ).fetchall()
        counts = {row["status"]: int(row["n"]) for row in rows}
        return {
            "open": counts.get("open", 0),
            "resolved": counts.get("resolved", 0),
            "total": sum(counts.values()),
        }

    def close(self) -> None:
        self._conn.close()


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    def _load(value: Any) -> dict[str, Any]:
        try:
            parsed = json.loads(value or "{}")
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}

    return {
        "conflict_id": row["conflict_id"],
        "project_id": row["project_id"],
        "node_id": row["node_id"],
        "node_name": row["node_name"] or "",
        "topic": row["topic"] or "",
        "a": _load(row["side_a"]),
        "b": _load(row["side_b"]),
        "why": row["why"] or "",
        "status": row["status"],
        "status_label": STATUS_LABELS.get(row["status"], row["status"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
