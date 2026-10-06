# -*- coding: utf-8 -*-
"""跨项目概念图：把「同一个概念在多个课程里出现」这件事变成可查询的数据。

────────────────────────────────────────────────────────────────────
为什么需要它

``framework_nodes`` 的主键是 ``(project_id, node_id)``，全链路查询都带
``WHERE project_id = ?`` —— 这是刻意的（多用户隔离 + 撤销栈都依赖它）。
但代价是：**系统此前完全不知道「光学项目里的傅里叶变换」和「信号处理项目里的
傅里叶变换」是同一个概念**。跨课程、跨学科的迁移因此没有任何载体。

仓库里其实已经躺着一个对齐键：``framework.stable_node_id(name)`` 对同名知识点
在任何项目里都产出同一个 id。但它把 slug 拼进了 id，所以「傅里叶变换」与
「傅里叶分析」必然不同名，而这两者在校际层面就是同一个概念。粒度不对，不能直接用。
所以这里另建**概念层**的键（``core.transfer.concept_key``，归一化术语后取 hash）。

**概念键的构造完全本地、零外部依赖**：归一化 → sha1。不查词表、不联网、不调模型。
理由是这个项目的定位是 local-first「克隆即用」；引入词表或向量库会破坏它。
代价也如实说：**只对齐字面写法相近的术语**，「傅里叶变换」与「Fourier Transform」
不会自动合并 —— 那需要一次显式的 LLM 对齐（见 ``align_via_llm``），默认不跑。

────────────────────────────────────────────────────────────────────
三条不做什么（写下来是为了防止后来者「顺手优化」）

1. **不猜合并。** 两个术语没有共同变体命中，就保持两个概念。宁可界面上少一条
   跨项目链接，也不要把两个不同的东西并成一个 —— 那会让跨项目掌握度对比变成假数据。
2. **不覆盖历史。** ``project_concepts`` 按 (project_id, node_id) upsert，
   用户删过一个节点，对应行会删；其余项目的数据一律不动。
3. **不为了好看而造数据。** 只有 ≥2 个项目命中同一概念键才叫「跨项目概念」，
   单项目的一律不进跨项目视图。
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Sequence

from .transfer import (
    concept_key,
    normalize_term,
    term_variants,
    transfer_stage,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS concepts (
    concept_key   TEXT PRIMARY KEY,
    owner_id      TEXT NOT NULL,
    canonical_name TEXT NOT NULL,
    aliases       TEXT NOT NULL DEFAULT '[]',
    first_seen_at TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_concepts_owner ON concepts(owner_id, last_seen_at DESC);

-- 一个节点 ↔ 一个概念。node_id 在项目内唯一，故主键取 (project_id, node_id)。
CREATE TABLE IF NOT EXISTS project_concepts (
    project_id    TEXT NOT NULL,
    node_id       TEXT NOT NULL,
    concept_key   TEXT NOT NULL,
    term          TEXT NOT NULL,
    layer         INTEGER NOT NULL DEFAULT 0,
    mastery       REAL NOT NULL DEFAULT 0,
    transfer_score REAL NOT NULL DEFAULT 0,
    prereq_count  INTEGER NOT NULL DEFAULT 0,
    seen_at       TEXT NOT NULL,
    PRIMARY KEY (project_id, node_id)
);
CREATE INDEX IF NOT EXISTS idx_project_concepts_key ON project_concepts(concept_key);

-- 迁移作答留痕。刻意独立于 learning_events：
-- 迁移分有自己的公式（core/transfer.py）与自己的阈值，
-- 混进 learning_events 就得给 kind 表加第六档，而那张表刚因为加 discuss
-- 漏了标签而在前端翻过一次车（见 framework.py MASTERY_KIND_LABELS 注释）。
CREATE TABLE IF NOT EXISTS transfer_attempts (
    attempt_id  TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL,
    project_id  TEXT NOT NULL,
    node_id     TEXT NOT NULL,
    concept_key TEXT NOT NULL DEFAULT '',
    distance    TEXT NOT NULL,
    correctness REAL,
    payload     TEXT NOT NULL,
    answer      TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    submitted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_transfer_attempts_node
    ON transfer_attempts(project_id, node_id, created_at DESC);
"""


def _now() -> str:
    from .database import utc_now

    return utc_now().isoformat()


def _loads_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    text = str(value or "").strip()
    if not text:
        return []
    try:
        parsed = json.loads(text)
    except (ValueError, TypeError):
        return []
    if not isinstance(parsed, list):
        return []
    return [str(item) for item in parsed if str(item).strip()]


# --------------------------------------------------------------------------


class ConceptStore:
    """跨项目概念图的独立存储。

    自带连接、自建表 —— 与 ``core/conflicts.py`` 同一范式。刻意不去改
    ``core/database.py`` 的 executescript：那一张脚本是全库的建表真值，
    往里塞只服务于一个模块的三张表，会让「这张脚本等于库的全部形状」这个
    不变式失效，将来有人照着它做备份/导出就会漏掉这三张。
    """

    def __init__(self, path: str | Path):
        self.path = Path(path)
        if str(path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
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

    def close(self) -> None:
        self._conn.close()

    # ---- 写入 ------------------------------------------------------------

    def align_project(
        self,
        *,
        owner_id: str,
        project_id: str,
        nodes: Sequence[dict[str, Any]],
    ) -> dict[str, int]:
        """把一个项目的知识点映射到概念层。

        ``nodes`` 每项需要 ``node_id`` / ``name``，可选 ``layer`` /
        ``mastery`` / ``transfer_score`` / ``prereq_count``。
        调用方（api_server）负责从 framework_nodes + progress_engine 备好这些。

        返回 ``{"nodes": 总数, "concepts": 概念数, "merged": 变体命中并合并的数}``。
        """
        stamp = _now()
        existing_alias: dict[str, str] = {}
        for row in self._conn.execute(
            "SELECT concept_key, canonical_name, aliases FROM concepts WHERE owner_id = ?",
            (owner_id,),
        ):
            key = str(row["concept_key"])
            existing_alias[key] = str(row["canonical_name"] or "")
            for alias in _loads_list(row["aliases"]):
                existing_alias[normalize_term(alias)] = key

        touched: set[str] = set()
        merged = 0
        rows: list[tuple[Any, ...]] = []

        for node in nodes:
            term = str(node.get("name") or "").strip()
            if not term:
                continue
            key = concept_key(term)
            if not key:
                continue
            # 别名命中：某个已有概念恰好认得这个词的某个变体 ⇒ 并入那个概念。
            alias_hit = ""
            for variant in term_variants(term):
                found = existing_alias.get(normalize_term(variant))
                if found and found != key:
                    alias_hit = found
                    break
            if alias_hit:
                key = alias_hit
                merged += 1
            touched.add(key)
            rows.append(
                (
                    project_id,
                    str(node.get("node_id") or ""),
                    key,
                    term,
                    int(node.get("layer") or 0),
                    float(node.get("mastery") or 0.0),
                    float(node.get("transfer_score") or 0.0),
                    int(node.get("prereq_count") or 0),
                    stamp,
                )
            )

        with self.transaction() as conn:
            for key in sorted(touched):
                row = conn.execute(
                    "SELECT canonical_name FROM concepts WHERE concept_key = ?", (key,)
                ).fetchone()
                if row is None:
                    conn.execute(
                        "INSERT INTO concepts(concept_key, owner_id, canonical_name,"
                        " aliases, first_seen_at, last_seen_at) VALUES (?, ?, ?, '[]', ?, ?)",
                        (key, owner_id, "", stamp, stamp),
                    )
                    existing_alias[key] = ""
            # 本项目里已经消失的节点，对应行必须删掉 —— 否则用户删了节点，
            # 跨项目视图里还挂着一个「他学过」的幽灵概念。
            keep = {r[1] for r in rows}
            for row in conn.execute(
                "SELECT node_id FROM project_concepts WHERE project_id = ?", (project_id,)
            ).fetchall():
                if str(row["node_id"]) not in keep:
                    conn.execute(
                        "DELETE FROM project_concepts WHERE project_id = ? AND node_id = ?",
                        (project_id, str(row["node_id"])),
                    )
            for item in rows:
                conn.execute(
                    "INSERT INTO project_concepts(project_id, node_id, concept_key, term,"
                    " layer, mastery, transfer_score, prereq_count, seen_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
                    " ON CONFLICT(project_id, node_id) DO UPDATE SET"
                    "   concept_key = excluded.concept_key, term = excluded.term,"
                    "   layer = excluded.layer, mastery = excluded.mastery,"
                    "   transfer_score = excluded.transfer_score,"
                    "   prereq_count = excluded.prereq_count, seen_at = excluded.seen_at",
                    item,
                )
            # 首次出现的术语成为该概念的规范名；后续不同写法进 aliases。
            for key in sorted(touched):
                canon = existing_alias.get(key, "")
                if not canon:
                    terms = {
                        str(r["term"])
                        for r in conn.execute(
                            "SELECT DISTINCT term FROM project_concepts WHERE concept_key = ?",
                            (key,),
                        )
                    }
                    canon = sorted(terms, key=lambda t: (len(t), t))[0] if terms else ""
                conn.execute(
                    "UPDATE concepts SET owner_id = ?, canonical_name = ?, last_seen_at = ?"
                    " WHERE concept_key = ?",
                    (owner_id, canon, stamp, key),
                )
                if canon:
                    existing_alias[key] = canon
        return {"nodes": len(rows), "concepts": len(touched), "merged": merged}

    def sync_scores(
        self, *, owner_id: str, project_id: str
    ) -> None:
        """把 project_concepts 的 mastery/transfer_score 对齐到当前真值。

        为什么不放进 align_project：分数会随每次作答变，而概念对齐只在
        框架变更时跑。把「对齐」和「刷分」合成一步，等于每答一题都重算全库。
        """
        stamp = _now()
        with self.transaction() as conn:
            conn.execute(
                """
                UPDATE project_concepts SET
                    mastery = COALESCE((
                        SELECT n.mastery_score FROM framework_nodes n
                        WHERE n.project_id = project_concepts.project_id
                          AND n.node_id = project_concepts.node_id
                    ), mastery),
                    transfer_score = COALESCE((
                        SELECT n.transfer_score FROM framework_nodes n
                        WHERE n.project_id = project_concepts.project_id
                          AND n.node_id = project_concepts.node_id
                    ), transfer_score)
                WHERE EXISTS (
                    SELECT 1 FROM project_concepts p
                    WHERE p.project_id = project_concepts.project_id
                      AND p.node_id = project_concepts.node_id
                )
                """
            )
            conn.execute(
                "UPDATE concepts SET last_seen_at = ? WHERE owner_id = ?",
                (stamp, owner_id),
            )

    def record_attempt(
        self,
        *,
        owner_id: str,
        project_id: str,
        node_id: str,
        distance: str,
        payload: dict[str, Any],
    ) -> str:
        attempt_id = f"tat_{uuid.uuid4().hex[:16]}"
        with self.transaction() as conn:
            row = conn.execute(
                "SELECT concept_key FROM project_concepts"
                " WHERE project_id = ? AND node_id = ?",
                (project_id, node_id),
            ).fetchone()
            conn.execute(
                "INSERT INTO transfer_attempts(attempt_id, owner_id, project_id, node_id,"
                " concept_key, distance, correctness, payload, answer, created_at, submitted_at)"
                " VALUES (?, ?, ?, ?, ?, ?, NULL, ?, '', ?, NULL)",
                (
                    attempt_id,
                    owner_id,
                    project_id,
                    node_id,
                    str(row["concept_key"]) if row else "",
                    distance,
                    json.dumps(payload, ensure_ascii=False),
                    _now(),
                ),
            )
        return attempt_id

    def submit_attempt(
        self, *, attempt_id: str, answer: str, correctness: float | None
    ) -> dict[str, Any] | None:
        with self.transaction() as conn:
            cur = conn.execute(
                "UPDATE transfer_attempts SET answer = ?, correctness = ?, submitted_at = ?"
                " WHERE attempt_id = ? AND submitted_at IS NULL",
                (answer, correctness, _now(), attempt_id),
            )
            if not cur.rowcount:
                return None
        return self.get_attempt(attempt_id)

    def get_attempt(self, attempt_id: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT * FROM transfer_attempts WHERE attempt_id = ?", (attempt_id,)
        ).fetchone()
        if row is None:
            return None
        try:
            payload = json.loads(row["payload"] or "{}")
        except (ValueError, TypeError):
            payload = {}
        return {
            "attempt_id": str(row["attempt_id"]),
            "project_id": str(row["project_id"]),
            "node_id": str(row["node_id"]),
            "concept_key": str(row["concept_key"] or ""),
            "distance": str(row["distance"]),
            "correctness": row["correctness"],
            "payload": payload if isinstance(payload, dict) else {},
            "answer": str(row["answer"] or ""),
            "created_at": str(row["created_at"]),
            "submitted_at": row["submitted_at"],
        }

    def recent_attempts(
        self, *, project_id: str, node_id: str | None = None, limit: int = 5
    ) -> list[dict[str, Any]]:
        sql = (
            "SELECT attempt_id, distance, correctness, payload, created_at, submitted_at"
            " FROM transfer_attempts WHERE project_id = ?"
        )
        params: list[Any] = [project_id]
        if node_id is not None:
            sql += " AND node_id = ?"
            params.append(node_id)
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(max(1, int(limit)))
        out: list[dict[str, Any]] = []
        for row in self._conn.execute(sql, params):
            try:
                payload = json.loads(row["payload"] or "{}")
            except (ValueError, TypeError):
                payload = {}
            out.append(
                {
                    "attempt_id": str(row["attempt_id"]),
                    "distance": str(row["distance"]),
                    "correctness": row["correctness"],
                    "question": str((payload or {}).get("question") or ""),
                    "answered": bool(row["submitted_at"]),
                    "created_at": str(row["created_at"]),
                }
            )
        return out

    def list_attempts(
        self,
        *,
        project_id: str,
        limit: int = 20,
        node_id: str | None = None,
        only_open: bool = False,
    ) -> list[dict[str, Any]]:
        """**历史**：出过的每一道迁移题（含未作答的），按时间倒序。

        为什么单独一个方法而不是把 ``recent_attempts`` 加大：出题去重要的是
        「最近几道」（少、轻、带题干摘要），历史面板要的是「全部 + 序号 + 节点名 +
        自评结果 + 是否已答」。两种诉求混在一个方法里，最后一定变成开关参数的堆积。

        ``seq`` 从**总数**倒着算，所以「第 N 道」在历史翻页/限长时仍然稳定 ——
        否则一旦 limit 变小，界面上「第 3 道」会变成「第 1 道」。
        """
        sql = (
            "SELECT a.attempt_id, a.node_id, a.distance, a.correctness, a.payload,"
            "       a.answer, a.created_at, a.submitted_at,"
            "       COALESCE(pc.term, '') AS term"
            "  FROM transfer_attempts a"
            "  LEFT JOIN project_concepts pc"
            "    ON pc.project_id = a.project_id AND pc.node_id = a.node_id"
            " WHERE a.project_id = ?"
        )
        params: list[Any] = [project_id]
        if node_id is not None:
            sql += " AND a.node_id = ?"
            params.append(node_id)
        if only_open:
            sql += " AND a.submitted_at IS NULL"
        total_row = self._conn.execute(
            "SELECT COUNT(*) AS n FROM transfer_attempts WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        total = int(total_row["n"] or 0) if total_row else 0
        # 倒序取 limit 条，但序号按「总共第几道」给正序编号
        sql += " ORDER BY a.created_at DESC, a.attempt_id DESC LIMIT ?"
        params.append(max(1, int(limit)))
        rows = self._conn.execute(sql, params).fetchall()
        out: list[dict[str, Any]] = []
        for row in rows:
            try:
                payload = json.loads(row["payload"] or "{}")
            except (ValueError, TypeError):
                payload = {}
            payload = payload if isinstance(payload, dict) else {}
            answered = bool(row["submitted_at"])
            out.append(
                {
                    "attempt_id": str(row["attempt_id"]),
                    "node_id": str(row["node_id"]),
                    "node_name": str(row["term"] or row["node_id"]),
                    "distance": str(row["distance"]),
                    "correctness": row["correctness"],
                    "question": str(payload.get("question") or ""),
                    "answer_excerpt": str(row["answer"] or "")[:80],
                    "answered": answered,
                    "created_at": str(row["created_at"]),
                    "submitted_at": row["submitted_at"],
                    "total": total,
                }
            )
        # 生成时 seq = total - index；倒序展示但编号仍是「第几道」
        for index, item in enumerate(out):
            item["seq"] = max(1, total - index)
        return out

    def count_repeats(
        self, *, project_id: str, node_id: str, distance: str, since_days: float
    ) -> int:
        """近 N 天内同节点同距离的迁移作答次数 —— 边际递减的输入。"""
        row = self._conn.execute(
            "SELECT COUNT(*) AS n FROM transfer_attempts"
            " WHERE project_id = ? AND node_id = ? AND distance = ?"
            "   AND created_at >= datetime('now', ?)",
            (project_id, node_id, distance, f"-{max(0.0, float(since_days)):.4f} days"),
        ).fetchone()
        return int(row["n"] or 0) if row else 0

    # ---- 读取 ------------------------------------------------------------

    def add_alias(self, *, concept_key: str, alias: str) -> bool:
        """把一个同义写法记进该概念的 aliases。

        由 LLM 对齐（``/api/transfer/{id}/align``）调用。**不覆盖 canonical_name**：
        规范名一旦定下就保持稳定，否则跨项目视图里的概念名会每次打开都不一样。
        找不到该概念就返回 False —— 调用方据此报「未命中」，而不是凭空建一个空概念。
        """
        key = str(concept_key or "").strip()
        text = str(alias or "").strip()
        if not key or not text:
            return False
        with self.transaction() as conn:
            row = conn.execute(
                "SELECT aliases FROM concepts WHERE concept_key = ?", (key,)
            ).fetchone()
            if row is None:
                return False
            aliases = _loads_list(row["aliases"])
            if text in aliases:
                return True
            aliases.append(text)
            conn.execute(
                "UPDATE concepts SET aliases = ?, last_seen_at = ? WHERE concept_key = ?",
                (json.dumps(aliases, ensure_ascii=False), _now(), key),
            )
        return True

    def project_index(self, *, owner_id: str, project_id: str) -> list[dict[str, Any]]:
        """当前项目的节点 → 概念映射（含分数），供出题侧取概念键。"""
        rows = self._conn.execute(
            "SELECT pc.node_id, pc.concept_key, pc.term, pc.layer, pc.mastery,"
            "       pc.transfer_score, pc.prereq_count, c.canonical_name"
            "  FROM project_concepts pc"
            "  LEFT JOIN concepts c ON c.concept_key = pc.concept_key"
            "  JOIN projects p ON p.project_id = pc.project_id"
            " WHERE pc.project_id = ? AND p.owner_id = ?",
            (project_id, owner_id),
        ).fetchall()
        return [dict(row) for row in rows]

    def cross_project_view(
        self, *, owner_id: str, min_projects: int = 2, limit: int = 50
    ) -> dict[str, Any]:
        """跨项目概念视图：同一个概念在各个项目里的掌握度 / 迁移分对照。

        这是这个模块对用户最直接的价值 —— 「你在 A 课学过并迁移得动，
        B 课里的同一个概念一次都没验过」，这句话本身就有说服力。
        """
        rows = self._conn.execute(
            """
            SELECT pc.concept_key,
                   COALESCE(NULLIF(c.canonical_name, ''), MIN(pc.term)) AS name,
                   COUNT(DISTINCT pc.project_id) AS project_count,
                   SUM(pc.mastery) AS mastery_sum,
                   MAX(pc.mastery) AS mastery_max,
                   SUM(pc.transfer_score) AS transfer_sum
              FROM project_concepts pc
              JOIN projects p ON p.project_id = pc.project_id
              LEFT JOIN concepts c ON c.concept_key = pc.concept_key
             WHERE p.owner_id = ?
             GROUP BY pc.concept_key
            HAVING project_count >= ?
             ORDER BY project_count DESC, mastery_sum DESC
             LIMIT ?
            """,
            (owner_id, int(max(1, min_projects)), int(max(1, limit))),
        ).fetchall()

        concepts: list[dict[str, Any]] = []
        for row in rows:
            key = str(row["concept_key"])
            detail = self._conn.execute(
                "SELECT project_id, node_id, term, mastery, transfer_score"
                "  FROM project_concepts WHERE concept_key = ? ORDER BY project_id",
                (key,),
            ).fetchall()
            per_project = [
                {
                    "project_id": str(item["project_id"]),
                    "node_id": str(item["node_id"]),
                    "term": str(item["term"]),
                    "mastery": round(float(item["mastery"] or 0.0), 4),
                    "transfer": round(float(item["transfer_score"] or 0.0), 4),
                    "transfer_stage": transfer_stage(item["transfer_score"]),
                }
                for item in detail
            ]
            best_transfer = max((p["transfer"] for p in per_project), default=0.0)
            worst_transfer = min((p["transfer"] for p in per_project), default=0.0)
            concepts.append(
                {
                    "concept_key": key,
                    "name": str(row["name"] or key),
                    "project_count": int(row["project_count"]),
                    "mastery_best": round(float(row["mastery_max"] or 0.0), 4),
                    "transfer_best": round(best_transfer, 4),
                    "transfer_worst": round(worst_transfer, 4),
                    # 缺口 = 最好 - 最差。差距越大，越说明「同概念在别处还没验过」。
                    "transfer_gap": round(best_transfer - worst_transfer, 4),
                    "projects": per_project,
                }
            )
        concepts.sort(key=lambda c: (-c["project_count"], -c["transfer_gap"]))
        return {"owner_id": owner_id, "concepts": concepts}

    def transfer_queue(
        self, *, owner_id: str, limit: int = 6
    ) -> dict[str, Any]:
        """跨项目泛化队列：**在别的项目里验过、在这个项目里还没验过**的同一概念。

        与 FSRS 的跨项目到期队列（api_server 的 /api/review/queue 不带 project_id
        时就跨全部项目取）摆在一起 —— 那条队列管「今天该复习什么」，
        这条管「今天该把哪个会的东西用到一个没验过的地方去」。
        """
        rows = self._conn.execute(
            """
            SELECT pc.concept_key,
                   COALESCE(NULLIF(c.canonical_name, ''), MIN(pc.term)) AS name,
                   MAX(pc.transfer_score) AS best_transfer
              FROM project_concepts pc
              JOIN projects p ON p.project_id = pc.project_id
              LEFT JOIN concepts c ON c.concept_key = pc.concept_key
             WHERE p.owner_id = ?
             GROUP BY pc.concept_key
            HAVING best_transfer > 0
             ORDER BY best_transfer DESC
             LIMIT 200
            """,
            (owner_id,),
        ).fetchall()

        items: list[dict[str, Any]] = []
        for row in rows:
            key = str(row["concept_key"])
            entries = self._conn.execute(
                "SELECT project_id, node_id, term, transfer_score, mastery"
                "  FROM project_concepts WHERE concept_key = ? AND project_id IN"
                "   (SELECT project_id FROM projects WHERE owner_id = ?)",
                (key, owner_id),
            ).fetchall()
            proven = [
                str(item["project_id"])
                for item in entries
                if float(item["transfer_score"] or 0.0) >= 0.75
            ]
            if not proven:
                continue
            untested = [
                {
                    "project_id": str(item["project_id"]),
                    "node_id": str(item["node_id"]),
                    "term": str(item["term"]),
                    "mastery": round(float(item["mastery"] or 0.0), 4),
                }
                for item in entries
                if float(item["transfer_score"] or 0.0) < 0.35
            ]
            if not untested:
                continue
            items.append(
                {
                    "concept_key": key,
                    "name": str(row["name"] or key),
                    "proven_in": proven,
                    "untested": untested[:3],
                    "reason": (
                        f"你在{'、'.join(proven[:2])}里已经把这个概念的迁移题做实了，"
                        "同一个概念在别的项目里还没验过 —— 换门课用它一次。"
                    ),
                }
            )
            if len(items) >= max(1, limit):
                break
        return {"owner_id": owner_id, "items": items}


def align_payload(
    nodes: Sequence[dict[str, Any]], existing: Sequence[dict[str, Any]]
) -> dict[str, Any]:
    """给 LLM 用的对齐 payload（``align_via_llm`` 的输入）。只读，不落库。"""
    known = {
        str(item.get("concept_key")): str(item.get("canonical_name") or item.get("name") or "")
        for item in existing
    }
    return {
        "instruction": (
            "把下面这批知识点术语，对齐到**已知概念清单**里的某一项，或判定为新概念。"
            "对齐依据是「它们在上层的学科里是不是同一个东西」，不是字面像不像。"
        ),
        "known_concepts": [{"concept_key": k, "canonical_name": v} for k, v in known.items()],
        "terms": [
            {"term": str(n.get("name") or ""), "node_id": str(n.get("node_id") or "")}
            for n in nodes
            if str(n.get("name") or "").strip()
        ],
        "schema": {
            "items": [
                {
                    "term": "原文术语，逐字回填",
                    "concept_key": "命中已知概念则填其 concept_key；否则填空串",
                    "canonical_name": "该概念的规范名（新概念时填你自己起的名字）",
                    "confidence": "0.0~1.0；拿不准就填 0.0，不要硬凑",
                }
            ]
        },
    }