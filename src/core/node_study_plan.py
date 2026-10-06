# -*- coding: utf-8 -*-
"""节点补课规划的结果缓存与指纹。

「看还缺什么」点开后要真调一次模型（几十秒）。同一节点、同一批资料，两次点开
不该重算 —— 存一份，资料没变直接复用；资料变了自动失效；界面另给「重新生成」按钮。

设计（对齐 ai-result-cache-with-refresh 技能，2026-09 在多文献对比上验证过）：

* **槽位建表**：``cache_key = sha1(owner_id|project_id|node_id)``，每个节点只占一行，
  重算是覆盖不是新增（``INSERT OR REPLACE``）。
* **指纹顺序无关**：来源按 source_id 排序后再拼哈希，勾选/入库顺序变了不算另一组。
* 只存「生成成功且非空」的结果；一次失败不会被永久复用。
* 独立连接 + busy_timeout + 懒建表，仿 core/study_kit.py 的解耦模式，不碰主库连接。
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS node_study_plans (
    cache_key   TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL,
    project_id  TEXT NOT NULL,
    node_id     TEXT NOT NULL,
    signature   TEXT NOT NULL DEFAULT '',
    content_json TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_node_study_plans_project
    ON node_study_plans(project_id, node_id);
"""


def _sha1(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()


def cache_key_for(owner_id: str, project_id: str, node_id: str) -> str:
    """槽位键。多用户互不串：把 owner_id 一起打进键。"""
    return _sha1("|".join([str(owner_id), str(project_id), str(node_id)]))


def signature_for(node: Any, sources: list[Any]) -> str:
    """节点的资料指纹：描述 + 笔记 + 来源正文（顺序无关）。变了即缓存失效。"""
    parts: list[str] = [
        f"desc:{getattr(node, 'description', '') or ''}",
        f"note:{getattr(node, 'note_content', '') or ''}",
    ]
    # 来源按 source_id 排序，避免入库顺序变化被误判成「另一组」。
    for source in sorted(sources, key=lambda s: str(getattr(s, "source_id", "") or "")):
        text = getattr(source, "text", "") or ""
        parts.append(f"{getattr(source, 'source_id', '')}:{_sha1(text)}")
    return _sha1("|".join(parts))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class NodeStudyPlanStore:
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

    def get(self, cache_key: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT signature, content_json, created_at FROM node_study_plans"
            " WHERE cache_key = ?",
            (cache_key,),
        ).fetchone()
        if row is None:
            return None
        return {
            "signature": row["signature"],
            "content_json": row["content_json"],
            "created_at": row["created_at"],
        }

    def save(
        self,
        *,
        cache_key: str,
        owner_id: str,
        project_id: str,
        node_id: str,
        signature: str,
        content: dict[str, Any],
    ) -> None:
        stamp = _now()
        with self.transaction() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO node_study_plans"
                " (cache_key, owner_id, project_id, node_id, signature, content_json,"
                " created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    cache_key,
                    owner_id,
                    project_id,
                    node_id,
                    signature,
                    json.dumps(content, ensure_ascii=False),
                    stamp,
                    stamp,
                ),
            )

    def close(self) -> None:
        self._conn.close()
