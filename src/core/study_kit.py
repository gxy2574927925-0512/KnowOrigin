"""学习套件：一页速查表（Cheat Sheet）与学习路径（Learning Path）。

## 为什么补这两样

知源已有卡片、测验、笔记、框架、文献精读，但缺两样**考前和入门时最需要**的东西：

* **一页速查表** —— 把整章压成一页可打印的对照表。复习到最后阶段，
  用户要的不是"再来十道题"，而是"闭嘴给我一张表"。
* **学习路径** —— 前置知识 + 学完下一步去哪 + 推荐资源。它回答的是
  "我现在在哪儿、接下来学什么"，而知源现有的一切都在回答"这个知识点是什么"。

这两个是同类项目（Skill-Anything 的 12 节学习包）里被验证有用的章节，
但知源完全没有。

## 落点

不往 ``framework_nodes`` 或 ``favorites`` 里塞 —— 前者是节点正文语义、后者的
``item_type`` 是强 Literal（``models.py``）。新建独立表 ``study_kits``，
仿 ``core/english_store.py`` 的解耦模式：独立连接 + ``busy_timeout`` + 懒建表。

## 内容形态

存 Markdown 原文，前端直接渲染。生成走一次模型调用（不拆分、不做增量），
因为一次出完的一页表才有整体感 —— 分块生成的表格会头重脚轻。
"""

from __future__ import annotations

import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS study_kits (
    kit_id     TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    owner_id   TEXT NOT NULL,
    node_id    TEXT,
    kind       TEXT NOT NULL,
    title      TEXT NOT NULL DEFAULT '',
    content_md TEXT NOT NULL DEFAULT '',
    source_ids TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_study_kits_project
    ON study_kits(project_id, kind, updated_at DESC);
"""

KINDS: tuple[str, ...] = ("cheatsheet", "learning_path", "checklist")

KIND_LABELS: dict[str, str] = {
    "cheatsheet": "一页速查表",
    "learning_path": "学习路径",
    "checklist": "清单报告",
}

KIND_HINTS: dict[str, str] = {
    "cheatsheet": "把整章压成一页可打印的对照表，考前用。",
    "learning_path": "前置知识 + 下一步学什么 + 推荐资源，入门和收尾时用。",
    "checklist": "按掌握度分组的可勾选复习清单，逐项打勾、扫尾用。",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_kind(value: Any) -> str:
    text = str(value or "").strip().lower()
    return text if text in KINDS else "cheatsheet"


# --------------------------------------------------------------------------
# Payload：交给模型的输入（纯函数，好测）
# --------------------------------------------------------------------------

_BASE_RULES = (
    "【铁律】\n"
    "1. 所有内容必须来自 payload.sources 与 payload.nodes；来源里没有的事实一律不写，"
    "宁缺勿编。不确定的地方写「资料未覆盖」，不要用常识补。\n"
    "   ⚠️ 特别注意：**禁止以「根据节点名称的通用含义做最小化补全」为理由自行补充定义、"
    "公式或数值**，即使你觉得那是这门学科的常识。资料里没有就写「资料未覆盖」。\n"
    "2. 输出 Markdown 正文，**不要**用 ``` 代码块包住整篇，也不要输出 JSON。\n"
    "3. 不出现作者/学校/日期/页码/文件名等元信息，不出现 src_xxx、node_xxx 等 ID。\n"
    "4. 公式用 LaTeX：行内 \\( ... \\)，独立成行 \\[ ... \\]。"
    "不要在正文里混入无法渲染的符号。\n"
)

_KIND_INSTRUCTIONS: dict[str, str] = {
    "cheatsheet": (
        "请生成一张**一页速查表**（Cheat Sheet）。要求：\n"
        "- 以 Markdown 表格为主体，按主题分组；一页能打印完，不要写成长文。\n"
        "- 每一行都是一条**可直接查用**的对照：术语/公式 → 一句话含义 → 成立条件或易错点。\n"
        "- 公式、常数、符号约定、成立条件必须原样保留来源里的形式。\n"
        "- 结尾给一个「最容易记混的三组」小节，用简洁对照写。\n"
    ),
    "learning_path": (
        "请生成一份**学习路径**。要求：\n"
        "- 三个小节，标题固定：`## 前置知识`、`## 下一步`、`## 推荐资源`。\n"
        "- 「前置知识」列出学这份材料之前应该已经会的概念，每条附一句「为什么需要它」。\n"
        "- 「下一步」列出学完这一章自然的延伸方向，每条附一句「它会解决什么新问题」。\n"
        "- 「推荐资源」只写**能从 payload.sources / nodes 里推断出**的资源类型"
        "（例如「本课程后续章节」「同书的第 N 章」），不要编造书名、链接或课程号；"
        "推不出来就写「资料未覆盖」。\n"
        "- 结尾用一句话总结这份材料在整个知识体系里的位置。\n"
    ),
    "checklist": (
        "请生成一份**复习清单报告**（Checklist Report）。要求：\n"
        "- 开头用 1~2 句说明这份材料的整体掌握情况（依据 payload.nodes 的 mastery 分布概括，"
        "不要列百分比数字）。\n"
        "- 主体是一张可勾选清单，按「还没开始 → 刚接触 → 已经会了」分三组，各配一个小标题；"
        "组内按「最该先复习的」排前面。\n"
        "- 每项写成 Markdown 复选框 `- [ ] 知识点名 —— 一句话复习建议`；"
        "建议必须落在该节点的名称与掌握度之内，来源没写的事实一律不补，宁缺勿编。\n"
        "- 结尾给一个「今天先做这 3 项」小结，点明最该优先的三项及其理由。\n"
        "- 全文用 Markdown，不要 ``` 代码块包住整篇，也不要输出 JSON。\n"
    ),
}


def build_payload(
    kind: str,
    *,
    project_name: str,
    subject: str = "",
    nodes: Iterable[Any] = (),
    sources: Iterable[Any] = (),
    focus_node: str = "",
    node_cap: int = 60,
) -> dict[str, Any]:
    """组装生成请求的 payload。纯函数，不碰数据库。

    节点与来源都**必须截断** —— 一次调用的输入是有上限的，把整本书塞进去
    只会让模型在中段丢失指令，产出比少给几份资料更差。
    """
    normalized = normalize_kind(kind)
    node_list = list(nodes)[: max(1, node_cap)]
    return {
        "instruction": (
            f"你在为知源 KnowOrigin 生成【{KIND_LABELS[normalized]}】。"
            f"材料来自课程「{project_name}」{('（' + subject + '）') if subject else ''}。"
        ),
        "kind": normalized,
        "kind_requirement": _KIND_INSTRUCTIONS[normalized],
        "focus": focus_node or "整份材料",
        "rules": _BASE_RULES,
        "nodes": [
            {
                "name": getattr(n, "name", "") or "",
                "description": (getattr(n, "description", "") or "")[:200],
                "note": (getattr(n, "note_content", "") or "")[:300],
                "mastery": round(float(getattr(n, "mastery_score", 0.0) or 0.0), 3),
            }
            for n in node_list
        ],
        "sources": _source_excerpts(sources),
    }


def _source_excerpts(sources: Iterable[Any], per_source: int = 1000, cap: int = 12) -> list[dict[str, str]]:
    """来源摘录：优先正文，其次摘要。截断是为了不把整本书塞进一次调用。"""
    out: list[dict[str, str]] = []
    for item in sources:
        text_parts: list[str] = []
        for attr in ("content", "text", "summary", "raw_text", "description"):
            value = getattr(item, attr, None)
            if isinstance(value, str) and value.strip():
                text_parts.append(value.strip())
                break
        if not text_parts:
            continue
        out.append(
            {
                "source_id": str(getattr(item, "source_id", "") or getattr(item, "id", "") or ""),
                "name": _source_name(item),
                "excerpt": text_parts[0][:per_source],
            }
        )
        if len(out) >= cap:
            break
    return out


def _source_name(item: Any) -> str:
    """Source 模型用的是 ``filename``，其它来源可能叫 name/title —— 都兜住。"""
    for attr in ("name", "title", "filename"):
        value = getattr(item, attr, None)
        if isinstance(value, str) and value.strip():
            return value.strip()[:120]
    return ""


def focus_scope(nodes: Iterable[Any], focus_node: Any) -> tuple[list[Any], list[str]]:
    """取某个节点及其整棵子树，返回 (节点列表, 这些节点关联的资料 id)。

    「针对某个知识点生成速查表」如果照旧把整本书塞进去，产出和整份材料那一份没有区别，
    用户要的就是这一块。取子树而不是单节点：知识点通常挂着子结论，只讲父节点会漏内容。

    ``focus_node`` 为空（整份材料那一份）时原样返回全部节点，调用方不必分支。
    """
    node_list = list(nodes)
    root_id = str(getattr(focus_node, "node_id", "") or "")
    if not root_id:
        return node_list, []
    picked: set[str] = {root_id}
    grew = True
    while grew:
        # parent_id 可能指向树里任意一层，只往下走一层会漏掉孙子节点。
        grew = False
        for node in node_list:
            nid = str(getattr(node, "node_id", "") or "")
            pid = str(getattr(node, "parent_id", "") or "")
            if nid and nid not in picked and pid and pid in picked:
                picked.add(nid)
                grew = True
    scope = [
        node for node in node_list
        if str(getattr(node, "node_id", "") or "") in picked
    ]
    source_ids: list[str] = []
    for node in scope:
        for sid in (getattr(node, "source_ids", None) or []):
            if sid and sid not in source_ids:
                source_ids.append(sid)
    return scope, source_ids


# --------------------------------------------------------------------------
# Store
# --------------------------------------------------------------------------


class StudyKitStore:
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
        kind: str,
        title: str,
        content_md: str,
        node_id: str | None = None,
        source_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        """同一「项目 + 节点 + kind」只保留最新一份 —— 速查表是"当前版本"，不是流水账。

        ``node_id`` 为空表示**整份材料**那一份。删除条件里的 ``IS ?`` 是 NULL 安全的
        （SQLite 的 ``IS`` 等价于 ``=`` 但 NULL 与 NULL 判等），所以项目级产物仍按
        原来的「同项目同 kind 只留一份」去重 —— 不会因为这次加了节点维度，就在历史
        数据上攒出一堆 node_id=NULL 的重复副本。
        """
        normalized = normalize_kind(kind)
        kit_id = f"kit_{uuid.uuid4().hex[:16]}"
        stamp = _now()
        with self.transaction() as conn:
            conn.execute(
                "DELETE FROM study_kits"
                " WHERE project_id = ? AND kind = ? AND node_id IS ?",
                (project_id, normalized, node_id or None),
            )
            conn.execute(
                "INSERT INTO study_kits (kit_id, project_id, owner_id, node_id, kind,"
                " title, content_md, source_ids, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    kit_id,
                    project_id,
                    owner_id,
                    node_id,
                    normalized,
                    title or KIND_LABELS[normalized],
                    content_md,
                    _json_ids(source_ids),
                    stamp,
                    stamp,
                ),
            )
        return {
            "kit_id": kit_id,
            "project_id": project_id,
            "kind": normalized,
            "title": title or KIND_LABELS[normalized],
            "content_md": content_md,
            "node_id": node_id,
            "source_ids": list(source_ids or []),
            "created_at": stamp,
            "updated_at": stamp,
        }

    def list_for_project(
        self, project_id: str, *, include_content: bool = True
    ) -> list[dict[str, Any]]:
        columns = "*" if include_content else (
            "kit_id, project_id, owner_id, node_id, kind, title, source_ids,"
            " created_at, updated_at"
        )
        rows = self._conn.execute(
            f"SELECT {columns} FROM study_kits WHERE project_id = ?"
            " ORDER BY updated_at DESC",
            (project_id,),
        ).fetchall()
        return [_row_to_dict(row, include_content=include_content) for row in rows]

    def get(
        self, project_id: str, kind: str, node_id: str | None = None
    ) -> dict[str, Any] | None:
        """读一份成文产物。``node_id`` 明确给定时精确匹配那一份。

        不给 ``node_id`` 时**优先返回项目级那一份**（node_id IS NULL），只有项目级
        还没有才退回最新的一份 —— 否则给某个知识点生成的速查表会把整份材料那一份顶掉，
        台历里打开就成了单知识点的窄表。
        """
        normalized = normalize_kind(kind)
        if node_id is not None:
            row = self._conn.execute(
                "SELECT * FROM study_kits"
                " WHERE project_id = ? AND kind = ? AND node_id = ?"
                " ORDER BY updated_at DESC LIMIT 1",
                (project_id, normalized, node_id),
            ).fetchone()
            return _row_to_dict(row) if row is not None else None
        row = self._conn.execute(
            "SELECT * FROM study_kits WHERE project_id = ? AND kind = ?"
            " ORDER BY (node_id IS NULL) DESC, updated_at DESC LIMIT 1",
            (project_id, normalized),
        ).fetchone()
        return _row_to_dict(row) if row is not None else None

    def delete(self, project_id: str, kind: str) -> int:
        with self.transaction() as conn:
            cur = conn.execute(
                "DELETE FROM study_kits WHERE project_id = ? AND kind = ?",
                (project_id, normalize_kind(kind)),
            )
        return cur.rowcount or 0

    def close(self) -> None:
        self._conn.close()


def _json_ids(values: list[str] | None) -> str:
    import json

    return json.dumps([str(v) for v in (values or [])], ensure_ascii=False)


def _row_to_dict(row: sqlite3.Row, *, include_content: bool = True) -> dict[str, Any]:
    import json

    try:
        source_ids = json.loads(row["source_ids"] or "[]")
    except Exception:
        source_ids = []
    data = {
        "kit_id": row["kit_id"],
        "project_id": row["project_id"],
        "node_id": row["node_id"],
        "kind": row["kind"],
        "kind_label": KIND_LABELS.get(row["kind"], row["kind"]),
        "title": row["title"] or "",
        "source_ids": source_ids,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
    if include_content:
        data["content_md"] = row["content_md"] or ""
    return data
