"""顶刊/顶会同行评审红队系统（Expert Peer Review Red-Team）。

对标：Nature Communications、IEEE Transactions、Optica、NeurIPS、ICML 的顶级审稿标准。
模拟挑剔的学术评审专家委员会（3位盲审专家 + 主编裁决）：
- Reviewer #1 (理论机制与物理假设): 专挑机理假设、边界条件、数学推导跳步与量纲不一致。
- Reviewer #2 (实验基准与消融验证): 专挑 Baseline 时效性（是否对标 2024-2026 SOTA）、消融实验充分性、统计显著性与抗噪鲁棒性。
- Reviewer #3 (创新范式与主编裁决 Area Chair): 判定是否属于增量式套皮（Incremental Work），给出综合评分 (1-10) 与终审裁决。

特有高价值交付物：
1. 致命缺陷与攻防质询 (Fatal Weaknesses & Questions)
2. 救命补充实验清单 (Rescue Experiments: 花最少时间挽回局面的 1~2 个关键实验)
3. 答辩防守策略建议 (Rebuttal Defense Strategies)
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS peer_reviews (
    review_id       TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL,
    owner_id        TEXT NOT NULL,
    target_type     TEXT NOT NULL DEFAULT 'literature',
    target_id       TEXT,
    target_title    TEXT NOT NULL DEFAULT '',
    venue_tier      TEXT NOT NULL DEFAULT 'IEEE Trans / 顶刊',
    overall_score   INTEGER NOT NULL DEFAULT 5,
    recommendation  TEXT NOT NULL DEFAULT 'Borderline',
    summary_of_work TEXT NOT NULL DEFAULT '',
    review_json     TEXT NOT NULL DEFAULT '{}',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_peer_reviews_proj
    ON peer_reviews(project_id, updated_at DESC);
"""

VENUE_TIERS: list[str] = [
    "Nature / Science 子刊",
    "IEEE Trans / Optica 顶级期刊",
    "NeurIPS / ICML / CVPR 顶会",
    "卓越行动计划国内顶刊",
    "硕士/博士开题与保研答辩",
]

RECOMMENDATIONS: list[dict[str, str]] = [
    {"val": "Strong Accept", "label": "强烈推荐录用 (Spotlight / Oral)", "badge": "success"},
    {"val": "Weak Accept", "label": "弱录用 (可在小修后接收)", "badge": "info"},
    {"val": "Borderline", "label": "处于临界线 (高度依赖 Rebuttal 表现)", "badge": "warning"},
    {"val": "Weak Reject", "label": "建议拒稿 (实验或创新度明显不足)", "badge": "danger"},
    {"val": "Strong Reject", "label": "强烈拒稿 (存在致命理论或实验硬伤)", "badge": "danger"},
]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def build_peer_review_payload(
    *,
    title: str,
    abstract: str,
    content: str = "",
    venue_tier: str = "IEEE Trans / 顶刊",
    author_notes: str = "",
) -> dict[str, Any]:
    """构建给审稿模型的输入 payload（纯函数）。"""
    full_text = content.strip()
    if not full_text:
        full_text = abstract.strip()
    elif abstract and abstract not in full_text:
        full_text = f"【摘要 Abstract】\\n{abstract}\\n\\n【正文核心片段】\\n{full_text}"

    return {
        "title": title.strip() or "未命名学术工作",
        "venue_tier": venue_tier.strip() or "IEEE Trans / 顶刊",
        "abstract": abstract[:3000],
        "content_sample": full_text[:8000],
        "author_notes": author_notes.strip()[:1000],
        "evaluation_criteria": [
            "Soundness (1-5): 理论正确性、物理建模完备性、无逻辑跳步",
            "Presentation (1-5): 结构清晰度、符号规范、逻辑链严密",
            "Contribution & Novelty (1-5): 相比既有 SOTA 是否有实质突破而非微小增量",
            "Experimental Rigor (1-5): Baseline 对比、消融实验、误差分析与统计显著性",
        ],
    }


class PeerReviewStore:
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

    def save(
        self,
        *,
        project_id: str,
        owner_id: str,
        target_type: str,
        target_id: str | None,
        target_title: str,
        venue_tier: str,
        overall_score: int,
        recommendation: str,
        summary_of_work: str,
        review_data: dict[str, Any],
        review_id: str | None = None,
    ) -> dict[str, Any]:
        rid = review_id or f"rev_{uuid.uuid4().hex[:12]}"
        now = _now()
        r_json = json.dumps(review_data, ensure_ascii=False)

        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO peer_reviews (
                    review_id, project_id, owner_id, target_type, target_id,
                    target_title, venue_tier, overall_score, recommendation,
                    summary_of_work, review_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(review_id) DO UPDATE SET
                    overall_score=excluded.overall_score,
                    recommendation=excluded.recommendation,
                    summary_of_work=excluded.summary_of_work,
                    review_json=excluded.review_json,
                    updated_at=excluded.updated_at
                """,
                (
                    rid,
                    project_id,
                    owner_id,
                    target_type,
                    target_id,
                    target_title.strip() or "学术评审报告",
                    venue_tier.strip(),
                    int(overall_score),
                    recommendation.strip(),
                    summary_of_work.strip(),
                    r_json,
                    now,
                    now,
                ),
            )

        return self.get(rid) or {}

    def get(self, review_id: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            """
            SELECT review_id, project_id, owner_id, target_type, target_id,
                   target_title, venue_tier, overall_score, recommendation,
                   summary_of_work, review_json, created_at, updated_at
            FROM peer_reviews
            WHERE review_id = ?
            """,
            (review_id,),
        ).fetchone()
        if not row:
            return None
        return self._format_row(row)

    def list_for_project(self, project_id: str) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            """
            SELECT review_id, project_id, owner_id, target_type, target_id,
                   target_title, venue_tier, overall_score, recommendation,
                   summary_of_work, review_json, created_at, updated_at
            FROM peer_reviews
            WHERE project_id = ?
            ORDER BY updated_at DESC
            """,
            (project_id,),
        ).fetchall()
        return [self._format_row(r) for r in rows]

    list_by_project = list_for_project

    def list_for_owner(self, owner_id: str) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            """
            SELECT review_id, project_id, owner_id, target_type, target_id,
                   target_title, venue_tier, overall_score, recommendation,
                   summary_of_work, review_json, created_at, updated_at
            FROM peer_reviews
            WHERE owner_id = ?
            ORDER BY updated_at DESC
            """,
            (owner_id,),
        ).fetchall()
        return [self._format_row(r) for r in rows]

    def delete(self, review_id: str, owner_id: str | None = None) -> bool:
        with self.transaction() as conn:
            if owner_id:
                res = conn.execute(
                    "DELETE FROM peer_reviews WHERE review_id = ? AND owner_id = ?",
                    (review_id, owner_id),
                )
            else:
                res = conn.execute(
                    "DELETE FROM peer_reviews WHERE review_id = ?",
                    (review_id,),
                )
            return res.rowcount > 0

    def _format_row(self, row: sqlite3.Row) -> dict[str, Any]:
        d = dict(row)
        try:
            parsed = json.loads(d.pop("review_json", "{}"))
        except Exception:
            parsed = {}
        d["details"] = parsed
        d["review_data"] = parsed
        return d
