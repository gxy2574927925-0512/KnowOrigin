"""库级结构化摘要索引：把整个知识库压缩成 LLM 可一次性读入的记忆快照。

- `_heuristic_digest`：确定性兜底算法（无 LLM 或 LLM 失败时使用）。
- `build_kb_digest`：优先 LLM 压缩，异常回落启发式；可选持久化到 `kb_digests`。
- `render_digest_text`：把摘要渲染成可注入 system 的短文。
"""

from __future__ import annotations

from typing import Any

from .database import Database
from .models import FrameworkNode

WEAK_MASTERY_THRESHOLD = 0.3


def _heuristic_digest(project_id: str, nodes: list[FrameworkNode]) -> dict[str, Any]:
    total = len(nodes)
    with_note = [n for n in nodes if (n.note_content or "").strip()]
    coverage = len(with_note) / total if total else 0.0
    avg_mastery = sum(n.mastery_score for n in nodes) / total if total else 0.0

    weak_points = [n.name for n in nodes if n.mastery_score < WEAK_MASTERY_THRESHOLD]
    gaps = [
        {
            "node_id": n.node_id,
            "name": n.name,
            "priority": "high" if n.mastery_score < 0.5 else "medium",
        }
        for n in nodes
        if not (n.note_content or "").strip()
    ]
    gaps.sort(key=lambda g: 0 if g["priority"] == "high" else 1)

    return {
        "project_id": project_id,
        "stats": {
            "node_count": total,
            "note_coverage": round(coverage, 3),
            "avg_mastery": round(avg_mastery, 3),
        },
        "weak_points": weak_points[:20],
        "gaps": gaps[:20],
        "link_candidates": _heuristic_links(nodes)[:15],
        "recently_browsed": [],
        "open_notes": "",
    }


def _heuristic_links(nodes: list[FrameworkNode]) -> list[list[str]]:
    """对尚无双链的节点，按同父节点两两配对，给出候选双链。"""
    by_parent: dict[str | None, list[str]] = {}
    for n in nodes:
        if n.wikilinks:
            continue
        by_parent.setdefault(n.parent_id, []).append(n.name)
    candidates: list[list[str]] = []
    for names in by_parent.values():
        for i in range(len(names)):
            for j in range(i + 1, len(names)):
                candidates.append([names[i], names[j]])
    return candidates


def build_kb_digest(
    db: Database,
    project_id: str,
    llm: Any | None = None,
    persist: bool = True,
) -> dict[str, Any]:
    nodes = db.list_framework_nodes(project_id)
    digest = _heuristic_digest(project_id, nodes)
    if llm is not None:
        try:
            parsed = _llm_summarize(llm, project_id, nodes, digest)
            digest = _normalize_digest(project_id, nodes, parsed)
        except Exception:
            pass
    if persist:
        prev = db.get_digest(project_id)
        version = (prev.get("version") or 0) + 1 if prev else 1
        payload = {k: v for k, v in digest.items() if k != "project_id"}
        db.upsert_digest(project_id, version, payload)
    return digest


def _llm_summarize(llm: Any, project_id: str, nodes: list[FrameworkNode], heuristic: dict[str, Any]) -> Any:
    compact = [
        {
            "node_id": n.node_id,
            "name": n.name,
            "parent_id": n.parent_id,
            "mastery": round(n.mastery_score, 2),
            "has_note": bool((n.note_content or "").strip()),
            "tags": n.tags,
            "wikilinks": n.wikilinks,
        }
        for n in nodes
    ][:400]
    return llm.complete_json(
        "kb_digest",
        {"nodes": compact, "heuristic": heuristic, "project_id": project_id},
    )


def _normalize_digest(
    project_id: str, nodes: list[FrameworkNode], parsed: Any
) -> dict[str, Any]:
    base = _heuristic_digest(project_id, nodes)
    if not isinstance(parsed, dict):
        return base
    for key in (
        "stats",
        "weak_points",
        "gaps",
        "link_candidates",
        "recently_browsed",
        "open_notes",
    ):
        if key in parsed and parsed[key] is not None:
            base[key] = parsed[key]
    return base


def render_digest_text(digest: dict[str, Any]) -> str:
    stats = digest.get("stats") or {}
    weak = digest.get("weak_points") or []
    gaps = digest.get("gaps") or []
    links = digest.get("link_candidates") or []

    lines = [
        "知识库现状："
        f"共 {stats.get('node_count', 0)} 个节点，"
        f"笔记覆盖率 {int(stats.get('note_coverage', 0) * 100)}%，"
        f"平均掌握度 {int(stats.get('avg_mastery', 0) * 100)}%。"
    ]
    if weak:
        lines.append("薄弱点：" + "、".join(map(str, weak)))
    if gaps:
        lines.append(
            "缺笔记节点：" + "、".join(f"{g.get('name')}({g.get('priority')})" for g in gaps)
        )
    if links:
        lines.append("建议双链：" + "、".join(f"{a}↔{b}" for a, b in links))
    return "\n".join(lines) if len(lines) > 1 else lines[0]