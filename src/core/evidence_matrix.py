"""PRISMA 结构化文献综述矩阵抽取器（Evidence Matrix Agent）。

对标：Elicit (Systematic Review Matrix) + Cochrane PRISMA 2020 规范 + Atlas。
面向顶刊/顶会论文写作（Nature/Science子刊、IEEE Trans、Optica等）的文献综述准备工作。
将多篇论文从散乱叙述转化为多维横向对比矩阵，提取：
- 核心问题与动机 (Objective & Motivation)
- 系统硬件光路与算法架构 (System Setup & Methodology)
- 实验数据集与物理测试条件 (Dataset & Experimental Boundary)
- 关键定量指标 (Quantitative SOTA Metrics: 带数值与单位)
- 对比基线与相对提升 (Baseline & Relative Gain)
- 致命局限性与失效边界 (Failure Modes & Limitations —— 突破口与研究空白)
- 核心启示 (Synthesis Takeaway)
"""

from __future__ import annotations

import csv
import io
import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS evidence_matrices (
    matrix_id     TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL,
    owner_id      TEXT NOT NULL,
    title         TEXT NOT NULL DEFAULT '',
    topic         TEXT NOT NULL DEFAULT '',
    columns_json  TEXT NOT NULL DEFAULT '[]',
    rows_json     TEXT NOT NULL DEFAULT '[]',
    summary_md    TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_matrices_proj
    ON evidence_matrices(project_id, updated_at DESC);
"""

DEFAULT_COLUMNS: list[dict[str, str]] = [
    {"key": "title", "label": "论文与作者", "width": "180px"},
    {"key": "objective", "label": "核心科学/工程问题", "width": "200px"},
    {"key": "method_setup", "label": "系统搭建 / 算法架构", "width": "240px"},
    {"key": "dataset_conditions", "label": "数据集 / 实验测试边界", "width": "200px"},
    {"key": "quantitative_results", "label": "关键定量指标 (带单位数值)", "width": "240px"},
    {"key": "baseline_comparison", "label": "对比基线与超越幅度", "width": "180px"},
    {"key": "limitations", "label": "致命局限性与研究空白 (Gap)", "width": "220px"},
    {"key": "key_takeaway", "label": "一句话核心启示", "width": "180px"},
]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def build_matrix_payload(
    papers: list[dict[str, Any]],
    topic: str = "",
    custom_columns: list[str] | list[dict[str, Any]] | None = None,
    research_question: str = "",
) -> dict[str, Any]:
    """构建交给模型的输入 payload（纯函数）。"""
    effective_topic = (topic or research_question or "").strip()
    paper_items = []
    for p in papers:
        # 兼容知源 source 格式与 paper_search 格式
        paper_id = p.get("source_id") or p.get("paper_id") or p.get("id") or str(uuid.uuid4())[:8]
        title = p.get("title") or p.get("filename") or "未命名论文"
        authors = p.get("authors") or ""
        year = str(p.get("year") or "")
        venue = p.get("venue") or ""
        
        # 抽取有代表性的文本正文或摘要
        abstract = p.get("abstract") or ""
        content = p.get("content") or p.get("text") or ""
        if not abstract and content:
            abstract = content[:3000]
        elif content and len(content) > len(abstract):
            # 带一部分方法/结论段落以提升抽取精度
            abstract = f"{abstract}\\n\\n【正文核心片段】\\n{content[:4000]}"
            
        paper_items.append({
            "id": paper_id,
            "title": title,
            "authors": authors,
            "year": year,
            "venue": venue,
            "text": abstract[:5000],  # 保持单篇适中上下文
        })

    return {
        "topic": effective_topic or "多篇学术文献综合横向对比与研究空白识别",
        "research_question": effective_topic or "多篇学术文献综合横向对比与研究空白识别",
        "papers": paper_items,
        "default_columns": DEFAULT_COLUMNS,
        "custom_columns": custom_columns or [],
        "required_fields": [
            "paper_id",
            "objective",
            "method_setup",
            "dataset_conditions",
            "quantitative_results",
            "baseline_comparison",
            "limitations",
            "key_takeaway",
        ],
    }


def export_matrix_csv(matrix: dict[str, Any]) -> str:
    """将综述矩阵导出为带 UTF-8 BOM 的标准 CSV，兼容 Excel/Origin 直接打开。"""
    rows = matrix.get("rows", [])
    columns = matrix.get("columns", DEFAULT_COLUMNS)
    
    output = io.StringIO()
    # 写入 UTF-8 BOM
    output.write("\ufeff")
    
    fieldnames = [col["key"] for col in columns]
    headers = [col["label"] for col in columns]
    
    writer = csv.writer(output)
    writer.writerow(headers)
    
    for row in rows:
        row_vals = []
        for key in fieldnames:
            val = row.get(key, "")
            if isinstance(val, list):
                val = "；".join(str(x) for x in val)
            row_vals.append(str(val))
        writer.writerow(row_vals)
        
    return output.getvalue()


class EvidenceMatrixStore:
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
        title: str,
        topic: str,
        columns: list[dict[str, str]],
        rows: list[dict[str, Any]],
        summary_md: str = "",
        matrix_id: str | None = None,
    ) -> dict[str, Any]:
        mid = matrix_id or f"mat_{uuid.uuid4().hex[:12]}"
        now = _now()
        cols_str = json.dumps(columns, ensure_ascii=False)
        rows_str = json.dumps(rows, ensure_ascii=False)
        
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO evidence_matrices (
                    matrix_id, project_id, owner_id, title, topic,
                    columns_json, rows_json, summary_md, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(matrix_id) DO UPDATE SET
                    title=excluded.title,
                    topic=excluded.topic,
                    columns_json=excluded.columns_json,
                    rows_json=excluded.rows_json,
                    summary_md=excluded.summary_md,
                    updated_at=excluded.updated_at
                """,
                (
                    mid,
                    project_id,
                    owner_id,
                    title.strip() or "系统综述证据矩阵",
                    topic.strip(),
                    cols_str,
                    rows_str,
                    summary_md.strip(),
                    now,
                    now,
                ),
            )

        return self.get(mid) or {}

    def get(self, matrix_id: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            """
            SELECT matrix_id, project_id, owner_id, title, topic,
                   columns_json, rows_json, summary_md, created_at, updated_at
            FROM evidence_matrices
            WHERE matrix_id = ?
            """,
            (matrix_id,),
        ).fetchone()
        if not row:
            return None
        return self._format_row(row)

    def list_for_project(self, project_id: str) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            """
            SELECT matrix_id, project_id, owner_id, title, topic,
                   columns_json, rows_json, summary_md, created_at, updated_at
            FROM evidence_matrices
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
            SELECT matrix_id, project_id, owner_id, title, topic,
                   columns_json, rows_json, summary_md, created_at, updated_at
            FROM evidence_matrices
            WHERE owner_id = ?
            ORDER BY updated_at DESC
            """,
            (owner_id,),
        ).fetchall()
        return [self._format_row(r) for r in rows]

    def delete(self, matrix_id: str, owner_id: str | None = None) -> bool:
        with self.transaction() as conn:
            if owner_id:
                res = conn.execute(
                    "DELETE FROM evidence_matrices WHERE matrix_id = ? AND owner_id = ?",
                    (matrix_id, owner_id),
                )
            else:
                res = conn.execute(
                    "DELETE FROM evidence_matrices WHERE matrix_id = ?",
                    (matrix_id,),
                )
            return res.rowcount > 0

    def _format_row(self, row: sqlite3.Row) -> dict[str, Any]:
        d = dict(row)
        try:
            d["columns"] = json.loads(d.pop("columns_json", "[]"))
        except Exception:
            d["columns"] = DEFAULT_COLUMNS
        try:
            d["rows"] = json.loads(d.pop("rows_json", "[]"))
        except Exception:
            d["rows"] = []
        return d
