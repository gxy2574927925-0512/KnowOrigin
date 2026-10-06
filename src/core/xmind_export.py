"""把知识图谱导出成 XMind 可打开的 .xmind 文件（可继续编辑）。

XMind 2020+ 的 .xmind 本质是一个 zip 包 + 一个 content.json（新版用 JSON，老版用 XML）。
这里只生成新版格式：content.json 描述 sheet / topic 树 / relationship，metadata.json 记来源。

映射关系（与前端「XMind 图谱」视图一致）：
- 树状父子 parent_id            -> topic.children.attached 递归嵌套
- 前置边 prerequisite_ids       -> relationship（title="前置"）
- 双链   wikilinks（按节点名存） -> relationship（title=双链「理解」，无则 "相关"）
- 掌握度 / 已学 / 覆盖状态       -> topic.markers（可视化）+ topic.notes（精确文本）

只用标准库（zipfile / json / io / uuid），不引入第三方依赖。
"""

from __future__ import annotations

import io
import json
import zipfile
from typing import Any
import uuid

# —— 与 static/app.js 的 statusLabel() 保持同一套中文文案 ——
COVERAGE_LABELS: dict[str, str] = {
    "uncovered": "未覆盖",
    "covered": "来源覆盖",
    "insufficient_source": "来源不足",
    "missing_prerequisite": "缺前置知识",
}
LEARNING_LABELS: dict[str, str] = {
    "unexplored": "未探索",
    "encountered": "已遇到",
    "pending_confirmation": "待确认",
    "learning": "学习中",
    "mastered": "已掌握",
}

# XMind 内建 marker id：task-done（勾）、task-half（半程）、priority-1（红色优先级，表需关注）
_MARKER_DONE = {"markerId": "task-done"}
_MARKER_HALF = {"markerId": "task-half"}
_MARKER_PRIORITY = {"markerId": "priority-1"}

# 笔记过长会拖慢 XMind 打开，截断并诚实标注
_NOTE_MAX_CHARS = 4000


def _new_id() -> str:
    """XMind 风格 id：26 位十六进制（对齐官方 UUID 派生 id 的长度与字符集）。"""
    return uuid.uuid4().hex[:26]


def _status_label(node: dict[str, Any]) -> str:
    coverage = node.get("coverage_status") or "covered"
    if coverage == "covered":
        return LEARNING_LABELS.get(node.get("learning_status") or "", "未探索")
    return COVERAGE_LABELS.get(coverage, str(coverage))


def _markers_for(node: dict[str, Any]) -> list[dict[str, str]]:
    """节点状态 -> XMind marker，规则与前端 statusLabel/状态标注一致。"""
    coverage = node.get("coverage_status") or "covered"
    learning = node.get("learning_status") or "unexplored"
    mastery = float(node.get("mastery_score") or 0.0)

    # 覆盖有问题优先标红（未覆盖 / 来源不足 / 缺前置），无论学没学过
    if coverage != "covered":
        return [_MARKER_PRIORITY]
    if learning == "mastered" or mastery >= 0.8:
        return [_MARKER_DONE]
    if learning in ("learning", "encountered", "pending_confirmation"):
        return [_MARKER_HALF]
    return []


def _build_notes(node: dict[str, Any]) -> str:
    """把掌握度、状态、描述、标签、笔记拼成一条纯文本备注。"""
    mastery = float(node.get("mastery_score") or 0.0)
    parts: list[str] = [f"掌握度 {round(mastery * 100)}% · {_status_label(node)}"]

    description = (node.get("description") or "").strip()
    if description:
        parts.append("描述：" + description)

    tags = node.get("tags") or []
    if tags:
        parts.append("标签：" + "、".join(str(t) for t in tags))

    note = (node.get("note_content") or "").strip()
    if note:
        if len(note) > _NOTE_MAX_CHARS:
            note = note[:_NOTE_MAX_CHARS] + "\n…（笔记过长，已截断）"
        parts.append("笔记：\n" + note)

    return "\n\n".join(parts)


def build_xmind(
    project_id: str,
    project_name: str,
    nodes: list[dict[str, Any]],
    link_notes: list[dict[str, str]] | None = None,
) -> bytes:
    """生成 .xmind 文件字节流。

    nodes: model_to_dict(FrameworkNode) 列表，字段含 node_id / parent_id / name /
           description / coverage_status / learning_status / mastery_score /
           prerequisite_ids / note_content / tags / wikilinks。
    link_notes: 双链「理解」列表，字段 a_node_id / b_node_id / note。
    """
    nodes = list(nodes or [])
    by_id: dict[str, dict[str, Any]] = {}
    for n in nodes:
        by_id[n.get("node_id")] = n
    name_to_id: dict[str, str] = {n.get("name"): n.get("node_id") for n in nodes}

    # node_id 可能含中文 / 特殊字符，映射成 XMind 风格的十六进制 topic id
    id_map: dict[str, str] = {n["node_id"]: _new_id() for i, n in enumerate(nodes)}

    # parent_id -> 直接子节点（跳过自指 / 悬空父）
    children_map: dict[str, list[dict[str, Any]]] = {}
    for n in nodes:
        pid = n.get("parent_id")
        if pid and pid in by_id and pid != n.get("node_id"):
            children_map.setdefault(pid, []).append(n)

    placed: set[str] = set()

    def make_topic(node: dict[str, Any]) -> dict[str, Any]:
        tid = id_map[node["node_id"]]
        topic: dict[str, Any] = {
            "id": tid,
            "class": "topic",
            "title": node.get("name") or "(未命名)",
        }
        placed.add(node["node_id"])
        note_text = _build_notes(node)
        if note_text:
            topic["notes"] = {"plain": {"content": note_text}}
        markers = _markers_for(node)
        if markers:
            topic["markers"] = markers
        kids = [c for c in children_map.get(node["node_id"], []) if c["node_id"] not in placed]
        if kids:
            topic["children"] = {"attached": [make_topic(c) for c in kids]}
        return topic

    # 根 = 没有有效父节点的节点（正常框架只有一个中心根）
    roots = [
        n for n in nodes
        if not n.get("parent_id") or n.get("parent_id") not in by_id or n.get("parent_id") == n.get("node_id")
    ]

    if len(roots) == 1:
        root_topic = make_topic(roots[0])
    else:
        root_topic = None

    # 兜底：单根树没覆盖全部节点（多根 / parent 成环）时，造一个虚拟根兜住所有节点
    if root_topic is None or len(placed) < len(nodes):
        virtual: dict[str, Any] = {
            "id": _new_id(),
            "class": "topic",
            "title": project_name or "知识图谱",
        }
        attached: list[dict[str, Any]] = []
        for r in roots:
            if r["node_id"] not in placed:
                attached.append(make_topic(r))
        for n in nodes:
            if n["node_id"] not in placed:
                attached.append(make_topic(n))
        if attached:
            virtual["children"] = {"attached": attached}
        root_topic = virtual

    # —— 关系线：前置边 + 双链 ——
    relationships: list[dict[str, Any]] = []

    def add_relationship(end1: str, end2: str, title: str) -> None:
        rel: dict[str, Any] = {"id": _new_id(), "end1Id": id_map[end1], "end2Id": id_map[end2]}
        if title:
            rel["title"] = title
        relationships.append(rel)

    # 前置边：有向，pid -> node
    for n in nodes:
        for pid in n.get("prerequisite_ids") or []:
            if pid in by_id and pid != n.get("node_id"):
                add_relationship(pid, n["node_id"], "前置")

    # 双链：按节点名存储、无向，按字典序去重（与 graph/export JSON 同一口径）
    seen_links: set[tuple[str, str]] = set()
    note_by_pair: dict[tuple[str, str], str] = {}
    for row in link_notes or []:
        a, b = sorted((row.get("a_node_id") or "", row.get("b_node_id") or ""))
        if a and b:
            note_by_pair[(a, b)] = row.get("note") or ""

    for n in nodes:
        for target_name in n.get("wikilinks") or []:
            target = name_to_id.get(target_name)
            if target is None:
                continue  # 悬空双链（名字解析不到节点），跳过
            a, b = sorted((n["node_id"], target))
            if (a, b) in seen_links:
                continue
            seen_links.add((a, b))
            add_relationship(a, b, note_by_pair.get((a, b), "") or "相关")

    sheet: dict[str, Any] = {
        "id": _new_id(),
        "class": "sheet",
        "title": project_name or "知识图谱",
        "rootTopic": root_topic,
        "topicOverlapping": "overlap",
        "theme": {},
    }
    if relationships:
        sheet["relationships"] = relationships

    content = [sheet]
    metadata = {
        "dataStructureVersion": "3",
        "creator": {"name": "知源 KnowOrigin", "version": "1.0.0"},
        "layoutEngineVersion": "5",
    }
    # manifest.json 是 XMind 识别包内容的清单，缺了它 XMind 直接报「文件可能已损坏」
    manifest = {"file-entries": {"content.json": {}, "metadata.json": {}}}

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("content.json", json.dumps(content, ensure_ascii=False))
        zf.writestr("metadata.json", json.dumps(metadata, ensure_ascii=False))
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
    return buf.getvalue()
