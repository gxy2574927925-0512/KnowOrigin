"""跨书知识网络：把「一本本读过的书」接成一张网，再从网里长出方法论与技能。

## 这个模块解决什么

``core/reading_digest.py`` 让每本书产出 ``models``（可复用的框架）与 ``connections``（关联对象），
但**书与书之间仍是孤岛** —— 用户读完十本书，得到十份收获文档，却看不到
「这三本书其实在说同一件事」。

``core/concept_graph.py`` 已经解决了「同一个概念出现在多个项目里」的**身份问题**
（跨项目概念键 + 概念表）。本模块在它之上补三件事：

1. **连边**：把书与书之间「概念级」的关系显式化并**类型化**；
2. **找枢纽与桥梁**：识别高连接的概念（hub）与**连接两个原本分离的簇的节点**（bridge）——
   后者是整张网里最值钱的东西；
3. **从簇里长出方法论与技能**：对一个概念簇做**子图社区摘要**，产出一份可执行的方法论，
   再沉淀成可练的技能卡。

## 三条研究结论直接决定了实现

* **Matuschak（Evergreen notes）**：笔记应当**原子化、概念导向、密集链接**，
  且**偏好关联式本体而非层级分类**。→ 所以这里只建图、不建树；
  概念是节点，分类只是节点上的一个标签。
* **Luhmann（Zettelkasten）**：**没有唯一的主本体**，每条笔记的位置由局部语境决定；
  跨域的交叉引用才产生新洞见（"connections make new insights possible"）；
  他另外维护 **hub notes** 当高速公路。→ 所以允许多套「视角」并存（每本书是一套局部语义），
  并由 ``find_hubs`` 把枢纽概念捞出来当导航。
* **Munger（思维模型格栅）**：先抽取各学科的**大思想**，再**识别相似性模式**；
  隐喻是「把想法翻译成模型」的机制；**同一个结论被多个学科独立指向时，决策更可能正确**。
  → 所以有 ``analogy`` 边类型、有 ``cross_support`` 统计「这个概念被几本书支持」——
  **孤证要显式标注**（知源的来源视图已有同样的孤证提示，这里保持一致）。

## 一条不能破的规矩：不猜合并

``concept_graph.py`` 写死了「不猜合并」，这里继续遵守，而且更严：
本模块**只产出候选**（``candidate_pairs``）与**建议**，
合并动作必须由用户确认后才落库。

依据是 CLARE（2025）的实测：让领域专家用 15 分钟人工精修图，事实准确率平均
**+22.7%**。全自动合并的代价是把两个不同的东西并成一个 —— 之后所有「跨书洞见」
都建立在假连接上，比没有网更糟。
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from collections import defaultdict
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Sequence

from core.transfer import concept_key, normalize_term, term_variants

# --------------------------------------------------------------------------
# 持久化
# --------------------------------------------------------------------------

SCHEMA = """
-- 概念节点。一本书里的「可复用模型」抽成节点；同名概念跨书合并成同一个键。
CREATE TABLE IF NOT EXISTS net_nodes (
    owner_id    TEXT NOT NULL,
    concept_key TEXT NOT NULL,
    name        TEXT NOT NULL,
    books       TEXT NOT NULL DEFAULT '[]',
    note        TEXT NOT NULL DEFAULT '',
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (owner_id, concept_key)
);

-- 跨书边。kind 见 EDGE_TYPES。
CREATE TABLE IF NOT EXISTS net_edges (
    owner_id   TEXT NOT NULL,
    edge_id    TEXT NOT NULL,
    source_key TEXT NOT NULL,
    target_key TEXT NOT NULL,
    kind       TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    books      TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, edge_id)
);
CREATE INDEX IF NOT EXISTS idx_net_edges_owner ON net_edges(owner_id, kind);

-- **用户确认过的合并**。这是「不猜合并」的落地：候选由算法给，合并由人点。
-- 存成 from → to 的有向映射，建图时统一归到 to，所以合并是可累积、可撤销的。
CREATE TABLE IF NOT EXISTS net_merges (
    owner_id   TEXT NOT NULL,
    from_key   TEXT NOT NULL,
    to_key     TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, from_key)
);

-- 方法论文档。cluster_key 是簇成员键的稳定摘要 —— 簇一变，文档自然失效重建。
CREATE TABLE IF NOT EXISTS net_methodologies (
    owner_id     TEXT NOT NULL,
    cluster_key  TEXT NOT NULL,
    anchor_key   TEXT NOT NULL DEFAULT '',
    anchor_name  TEXT NOT NULL DEFAULT '',
    title        TEXT NOT NULL DEFAULT '',
    content_json TEXT NOT NULL DEFAULT '',
    content_md   TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (owner_id, cluster_key)
);

-- 概念详解。按**概念键**存（不是按簇）—— 读者点的是某一个概念。
-- signature = 该概念的「材料指纹」（名字 + 书单 + 关系 + 各书收获里的原句）：
-- 材料没变直接复用、不重跑模型；材料变了自动失效重建。与 knowledge_docs 同一口径。
CREATE TABLE IF NOT EXISTS net_concept_docs (
    owner_id     TEXT NOT NULL,
    concept_key  TEXT NOT NULL,
    name         TEXT NOT NULL DEFAULT '',
    title        TEXT NOT NULL DEFAULT '',
    signature    TEXT NOT NULL DEFAULT '',
    content_json TEXT NOT NULL DEFAULT '',
    content_md   TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (owner_id, concept_key)
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _load_list(raw: Any) -> list[str]:
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        return []
    return [str(v) for v in data] if isinstance(data, list) else []


def cluster_key_for(keys: Iterable[str]) -> str:
    """一个簇的稳定键：成员键排序后取哈希。

    用「成员集合」而不是「某个代表节点」当键 —— 簇因为新增一本书而变大时，
    键会变、旧方法论自然失效，这是对的：材料变了，结论就该重来。
    """
    members = sorted({str(k) for k in keys if str(k or "").strip()})
    if not members:
        return ""
    return "cl_" + hashlib.sha1("|".join(members).encode("utf-8", "replace")).hexdigest()[:20]


def apply_merges(
    nodes: Sequence[dict[str, Any]],
    edges: Sequence[dict[str, Any]],
    merges: dict[str, str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """按用户确认过的合并把图重新归并。纯函数。

    ``merges`` 是 ``{from_key: to_key}``。要做两件事：
      1. 把 from 节点的书单并进 to 节点（**不能丢**，否则「被几本书支持」就假了）；
      2. 把指向 from 的边改指 to，并去掉因此产生的自环。
    """
    if not merges:
        return list(nodes), list(edges)

    def resolve(key: str) -> str:
        # 链式合并（A→B、B→C）要能一路走到 C。加个步数上限防环。
        seen = 0
        current = str(key or "")
        while current in merges and seen < 16:
            current = str(merges[current])
            seen += 1
        return current

    merged: dict[str, dict[str, Any]] = {}
    for node in nodes:
        key = resolve(str(node.get("concept_key") or ""))
        if not key:
            continue
        target = merged.setdefault(
            key, {"concept_key": key, "name": str(node.get("name") or key), "books": [], "note": ""}
        )
        for book in node.get("books") or []:
            if book not in target["books"]:
                target["books"].append(book)
        if not target.get("note") and node.get("note"):
            target["note"] = str(node["note"])

    out_edges: list[dict[str, Any]] = []
    seen_edges: set[tuple[str, str, str]] = set()
    for edge in edges:
        a = resolve(str(edge.get("source") or ""))
        b = resolve(str(edge.get("target") or ""))
        if not a or not b or a == b:
            continue                      # 合并后变成自环 → 丢弃
        signature = (a, b, str(edge.get("kind") or ""))
        if signature in seen_edges:
            continue
        seen_edges.add(signature)
        out_edges.append({**edge, "source": a, "target": b})

    return list(merged.values()), out_edges


def nodes_from_digests(digests: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """把各书收获文档里的 ``models``（可复用模型）与 ``connections``（关联对象）抽成概念节点。

    这是 Munger 的第一步「抽取各学科的大思想」—— 只不过这里的「学科」是「书」。

    ⚠️ **``connections`` 指向的概念也必须建节点，而且要把当前这本书算进它的书单**。
    只收 models 会造成一个很隐蔽的失真：A 书把「激励错配」当**关联对象**提到、
    B 书把它当**模型**写，那么「激励错配」的书单里就只有 B ——
    于是 `cross_support` 判它「孤证」、桥的名字也丢成 `cpt_xxx`。
    一个概念被哪几本书提到，看的是**提到**，不是**在哪一节提到**。
    """
    out: dict[str, dict[str, Any]] = {}

    def touch(name: Any, book: str, note: str = "") -> None:
        key = concept_key(name)
        if not key:
            return
        node = out.setdefault(
            key, {"concept_key": key, "name": str(name or "").strip(), "books": [], "note": ""}
        )
        if book and book not in node["books"]:
            node["books"].append(book)
        if not node.get("note") and note:
            node["note"] = note[:200]

    for digest in digests:
        if not isinstance(digest, dict):
            continue
        book = str(digest.get("book") or "").strip()
        for item in digest.get("models") or []:
            if isinstance(item, dict):
                touch(item.get("name"), book, str(item.get("what") or ""))
        for item in digest.get("connections") or []:
            if isinstance(item, dict):
                touch(item.get("name"), book, str(item.get("note") or ""))
    return list(out.values())


def edges_from_models(digests: Sequence[dict[str, Any]], *, per_book: int = 3) -> list[dict[str, Any]]:
    """把每本书的 ``connections``（关联对象）连成边。

    近似之处如实说明：收获文档只记了「这本书关联到 X」，**没记是哪个模型关联到 X**。
    所以这里把该书的每个模型（最多 ``per_book`` 个）都连到 X —— 是「这本书把这几件事
    放在一起看」，不是精确的概念级因果。用户在界面上可以删掉不对的线。
    """
    out: list[dict[str, Any]] = []
    for digest in digests:
        if not isinstance(digest, dict):
            continue
        book = str(digest.get("book") or "").strip()
        models = [
            concept_key(str(m.get("name") or ""))
            for m in (digest.get("models") or [])[:per_book]
            if isinstance(m, dict)
        ]
        models = [k for k in models if k]
        for conn in digest.get("connections") or []:
            if not isinstance(conn, dict):
                continue
            target = concept_key(conn.get("name"))
            if not target:
                continue
            kind = str(conn.get("relation") or conn.get("kind") or "same").strip().lower()
            for source in models:
                edge = make_edge(
                    source, target,
                    kind=kind if kind in EDGE_TYPES else "same",
                    note=str(conn.get("note") or ""),
                    books=[book] if book else [],
                )
                if edge:
                    out.append(edge)
    return out


def analyze(
    digests: Sequence[dict[str, Any]],
    *,
    merges: dict[str, str] | None = None,
    hub_limit: int = 8,
    bridge_limit: int = 8,
) -> dict[str, Any]:
    """从各书收获文档算出整张网 + 结构分析。**一次算全，前端不用自己拼。**

    返回 ``{nodes, edges, graph, clusters, hubs, bridges, support, summary}``。
    ``bridges`` 是重点 —— 那是「连接两个原本分离的知识簇」的节点。
    """
    nodes = nodes_from_digests(digests)
    edges = edges_from_models(digests)
    if merges:
        nodes, edges = apply_merges(nodes, edges, merges)
    graph = build_graph(nodes, edges)
    groups = clusters(graph)
    hubs = find_hubs(graph, limit=hub_limit)
    bridges = find_bridges(graph, limit=bridge_limit)
    support = cross_support(graph)

    # 每个簇给一个稳定键，前端点「生成方法论」时把它带回来即可复现同一个簇。
    cluster_keys: dict[str, str] = {}
    for group in groups:
        key = cluster_key_for(group)
        for member in group:
            cluster_keys[member] = key

    books = sorted({b for node in graph["nodes"] for b in (node.get("books") or [])})
    return {
        "nodes": graph["nodes"],
        "edges": graph["edges"],
        "clusters": groups,
        "cluster_keys": cluster_keys,
        "hubs": hubs,
        "bridges": bridges,
        "support": support,
        "summary": {
            "concepts": len(graph["nodes"]),
            "edges": len(graph["edges"]),
            "clusters": len(groups),
            "bridges": len(bridges),
            "cross_book": len([s for s in support if s["verified"]]),
            "books": len(books),
            "book_names": books,
            # 成熟度分布（借自 mnemex 的 status lifecycle）
            "mature": len([s for s in support if s["stage"] == "mature"]),
            "draft": len([s for s in support if s["stage"] == "draft"]),
            "stub": len([s for s in support if s["stage"] == "stub"]),
        },
    }


class NetStore:
    """知识网络的持久化。独立连接 + 懒建表，与 StudyKitStore / ReadingStore 同一模式。"""

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

    # ---- 图 ----

    def replace_graph(
        self,
        owner_id: str,
        nodes: Sequence[dict[str, Any]],
        edges: Sequence[dict[str, Any]],
    ) -> dict[str, int]:
        """整图替换。网络是从收获文档派生出来的，每次重建都该是当前事实的全量。"""
        now = _now()
        with self.transaction() as conn:
            conn.execute("DELETE FROM net_nodes WHERE owner_id = ?", (owner_id,))
            conn.execute("DELETE FROM net_edges WHERE owner_id = ?", (owner_id,))
            for node in nodes:
                conn.execute(
                    "INSERT INTO net_nodes (owner_id, concept_key, name, books, note, updated_at)"
                    " VALUES (?,?,?,?,?,?)",
                    (
                        owner_id,
                        str(node.get("concept_key") or ""),
                        str(node.get("name") or ""),
                        _dump(node.get("books") or []),
                        str(node.get("note") or "")[:400],
                        now,
                    ),
                )
            for edge in edges:
                edge_id = hashlib.sha1(
                    "|".join(
                        [owner_id, str(edge.get("source")), str(edge.get("target")), str(edge.get("kind"))]
                    ).encode("utf-8", "replace")
                ).hexdigest()[:24]
                conn.execute(
                    "INSERT OR REPLACE INTO net_edges"
                    " (owner_id, edge_id, source_key, target_key, kind, note, books, created_at)"
                    " VALUES (?,?,?,?,?,?,?,?)",
                    (
                        owner_id, edge_id,
                        str(edge.get("source") or ""), str(edge.get("target") or ""),
                        str(edge.get("kind") or "same"), str(edge.get("note") or "")[:300],
                        _dump(edge.get("books") or []), now,
                    ),
                )
        return {"nodes": len(nodes), "edges": len(edges)}

    def list_nodes(self, owner_id: str) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT * FROM net_nodes WHERE owner_id = ? ORDER BY name", (owner_id,)
        ).fetchall()
        return [
            {
                "concept_key": row["concept_key"],
                "name": row["name"],
                "books": _load_list(row["books"]),
                "note": row["note"],
            }
            for row in rows
        ]

    def list_edges(self, owner_id: str) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT * FROM net_edges WHERE owner_id = ?", (owner_id,)
        ).fetchall()
        return [
            {
                "source": row["source_key"],
                "target": row["target_key"],
                "kind": row["kind"],
                "note": row["note"],
                "books": _load_list(row["books"]),
            }
            for row in rows
        ]

    # ---- 合并确认 ----

    def add_merge(self, owner_id: str, from_key: str, to_key: str) -> None:
        a, b = str(from_key or "").strip(), str(to_key or "").strip()
        if not a or not b or a == b:
            return
        with self.transaction() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO net_merges (owner_id, from_key, to_key, created_at)"
                " VALUES (?,?,?,?)",
                (owner_id, a, b, _now()),
            )

    def remove_merge(self, owner_id: str, from_key: str) -> None:
        with self.transaction() as conn:
            conn.execute(
                "DELETE FROM net_merges WHERE owner_id = ? AND from_key = ?",
                (owner_id, str(from_key or "")),
            )

    def list_merges(self, owner_id: str) -> dict[str, str]:
        rows = self._conn.execute(
            "SELECT from_key, to_key FROM net_merges WHERE owner_id = ?", (owner_id,)
        ).fetchall()
        return {row["from_key"]: row["to_key"] for row in rows}

    # ---- 方法论 ----

    def save_methodology(
        self,
        owner_id: str,
        *,
        cluster_key: str,
        result: dict[str, Any],
        content_md: str,
        anchor_key: str = "",
        anchor_name: str = "",
    ) -> dict[str, Any]:
        key = str(cluster_key or "").strip()
        if not key:
            return {}
        now = _now()
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO net_methodologies (owner_id, cluster_key, anchor_key, anchor_name,"
                " title, content_json, content_md, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(owner_id, cluster_key) DO UPDATE SET"
                "  anchor_key=excluded.anchor_key, anchor_name=excluded.anchor_name,"
                "  title=excluded.title, content_json=excluded.content_json,"
                "  content_md=excluded.content_md, updated_at=excluded.updated_at",
                (
                    owner_id, key, str(anchor_key or ""), str(anchor_name or ""),
                    str(result.get("title") or "")[:120],
                    _dump(result if isinstance(result, dict) else {}),
                    str(content_md or ""), now, now,
                ),
            )
        return self.get_methodology(owner_id, key)

    def get_methodology(self, owner_id: str, cluster_key: str) -> dict[str, Any]:
        row = self._conn.execute(
            "SELECT * FROM net_methodologies WHERE owner_id = ? AND cluster_key = ?",
            (owner_id, str(cluster_key or "")),
        ).fetchone()
        if not row:
            return {}
        item = dict(row)
        try:
            item["content"] = json.loads(item.get("content_json") or "{}")
        except (TypeError, ValueError):
            item["content"] = {}
        return item

    def list_methodologies(self, owner_id: str) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT * FROM net_methodologies WHERE owner_id = ? ORDER BY updated_at DESC",
            (owner_id,),
        ).fetchall()
        out: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            try:
                item["content"] = json.loads(item.get("content_json") or "{}")
            except (TypeError, ValueError):
                item["content"] = {}
            item.pop("content_json", None)
            out.append(item)
        return out

    # ---- 概念详解 ----

    def save_concept_doc(
        self,
        owner_id: str,
        *,
        concept_key: str,
        name: str,
        signature: str,
        result: dict[str, Any],
        content_md: str,
    ) -> dict[str, Any]:
        key = str(concept_key or "").strip()
        if not key:
            return {}
        now = _now()
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO net_concept_docs (owner_id, concept_key, name, title, signature,"
                " content_json, content_md, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(owner_id, concept_key) DO UPDATE SET"
                "  name=excluded.name, title=excluded.title, signature=excluded.signature,"
                "  content_json=excluded.content_json, content_md=excluded.content_md,"
                "  updated_at=excluded.updated_at",
                (
                    owner_id, key, str(name or "")[:120],
                    str(result.get("title") or name or "")[:120],
                    str(signature or ""),
                    _dump(result if isinstance(result, dict) else {}),
                    str(content_md or ""), now, now,
                ),
            )
        return self.get_concept_doc(owner_id, key)

    def get_concept_doc(self, owner_id: str, concept_key: str) -> dict[str, Any]:
        row = self._conn.execute(
            "SELECT * FROM net_concept_docs WHERE owner_id = ? AND concept_key = ?",
            (owner_id, str(concept_key or "")),
        ).fetchone()
        if not row:
            return {}
        item = dict(row)
        try:
            item["content"] = json.loads(item.get("content_json") or "{}")
        except (TypeError, ValueError):
            item["content"] = {}
        return item

    def list_concept_docs(self, owner_id: str) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT concept_key, name, title, updated_at FROM net_concept_docs"
            " WHERE owner_id = ? ORDER BY updated_at DESC",
            (owner_id,),
        ).fetchall()
        return [dict(row) for row in rows]

# --------------------------------------------------------------------------
# 边的类型
# --------------------------------------------------------------------------

# 关系类型。**必须类型化**：Luhmann 只在卡片上写 "see / cf."，
# 而现代语义图用带谓词的边 —— 类型决定这条边能不能用来推理。
# 前端按类型上色，模型按类型决定怎么用。
EDGE_TYPES: tuple[str, ...] = (
    "same",       # 同一件事：两本书用不同叫法说同一个概念
    "prereq",     # 前置：先懂 A 才可能懂 B
    "extends",    # 延伸：A 是 B 的特例 / 深化
    "contrast",   # 对立：两本书说法冲突（要显式呈现，不要和稀泥）
    "analogy",    # 类比：跨域隐喻 —— Munger 说的「翻译成模型」的机制
    "applies_to", # 应用：概念 → 它适用的场景
)

EDGE_LABELS: dict[str, str] = {
    "same": "同一件事",
    "prereq": "前置",
    "extends": "延伸",
    "contrast": "对立",
    "analogy": "类比",
    "applies_to": "应用",
}

# 无向还是无向+有向混合：prereq / extends / applies_to 有方向，
# same / contrast / analogy 对称。方向搞错会让「前置」反过来显示。
DIRECTED_EDGE_TYPES = frozenset({"prereq", "extends", "applies_to"})

# 跨书支持度的门槛：被 ≥2 本书支持才算「交叉验证」。
CROSS_SUPPORT_MIN = 2

# --------------------------------------------------------------------------
# 概念成熟度生命周期
# --------------------------------------------------------------------------
# 借自 mnemex（github.com/Daniil-Sokolskiy/mnemex）的 status lifecycle：
#   stub → draft → mature（3+ sources, reviewed）
# 它的价值在于**把「我到底懂没懂」变成一个看得见的状态** ——
# 只在一本书里见过的概念，和在三本书里反复被独立指向的概念，
# 可信度天差地别，界面上一视同仁就是骗自己。
#
# 我们的判据只用「被几本书支持」这一条客观事实，**不引入人工 review 标记** ——
# 知源是本地优先、单人使用的工具，再让用户手动标状态就没人标了。
CONCEPT_STAGES: tuple[str, ...] = ("stub", "draft", "mature")

STAGE_LABELS: dict[str, str] = {
    "stub": "孤证",
    "draft": "待验证",
    "mature": "已成熟",
}

STAGE_HINTS: dict[str, str] = {
    "stub": "只在一本书里出现过，别当共识用。",
    "draft": "两本书独立提到，可以试着用，但还缺第三个来源。",
    "mature": "三本以上独立支持，是最可信的那批概念。",
}

DRAFT_MIN_BOOKS = 2
MATURE_MIN_BOOKS = 3


def concept_stage(book_count: int) -> str:
    """按「被几本书支持」定成熟度。纯函数，便于单测。"""
    try:
        count = int(book_count)
    except (TypeError, ValueError):
        count = 0
    if count >= MATURE_MIN_BOOKS:
        return "mature"
    if count >= DRAFT_MIN_BOOKS:
        return "draft"
    return "stub"

# 候选合并的最低相似度。低于它连候选都不给 —— 宁可少给，不要给噪音。
CANDIDATE_MIN_SCORE = 0.45

# 一次喂给模型的概念上限。整张网可能几百个节点，全塞进去模型会在中段丢指令。
MAX_CLUSTER_CONCEPTS = 24
MAX_CLUSTER_EDGES = 40


# --------------------------------------------------------------------------
# 术语相似度：只产出候选，不做合并
# --------------------------------------------------------------------------


def _containment(a: str, b: str) -> bool:
    return bool(a) and bool(b) and (a in b or b in a)


def similarity(left: Any, right: Any) -> float:
    """两个术语「可能是同一个概念」的置信度（0~1）。纯本地，不调模型、不查词表。

    打分规则（只有两档，都够强）：
      * 一方是另一方的**变体**（``term_variants`` 命中）—— 0.75；
      * 一方是另一方的**子串** —— 0.55（「傅里叶变换」⊂「傅里叶变换光学」）。

    ⚠️ **刻意不做「同尾词」这一档**。看着很自然（「傅里叶**变换**」与「拉普拉斯**变换**」），
    但中文术语的核心名词高度复用：「沉没成本 / 机会成本」「固定成本 / 边际成本」
    两两同尾却完全是不同概念。加这一档的结果是——书一多，候选列表就被同尾词淹没，
    用户直接不看，等于把功能做废。宁可在术语层少给候选，也不要给噪音。
    """
    a = str(left or "").strip()
    b = str(right or "").strip()
    if not a or not b:
        return 0.0
    na, nb = normalize_term(a), normalize_term(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    if nb in set(term_variants(a)) or na in set(term_variants(b)):
        return 0.75
    if _containment(na, nb):
        return 0.55
    return 0.0


def candidate_pairs(concepts: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """找出「可能该合并」的概念对。**只给候选，不合并**。

    入参每条至少要有 ``concept_key`` 与 ``name``。返回按置信度降序，
    每条带 ``reason``（给用户看的一句话理由）与 ``books``（各自被哪些书提到）。
    """
    items: list[dict[str, Any]] = []
    for item in concepts:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or item.get("canonical_name") or "").strip()
        key = str(item.get("concept_key") or "").strip() or concept_key(name)
        if not name or not key:
            continue
        items.append({"concept_key": key, "name": name, "books": _as_str_list(item.get("books"))})

    out: list[dict[str, Any]] = []
    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            left, right = items[i], items[j]
            if left["concept_key"] == right["concept_key"]:
                continue
            score = similarity(left["name"], right["name"])
            if score < CANDIDATE_MIN_SCORE:
                continue
            out.append(
                {
                    "left": left["concept_key"],
                    "right": right["concept_key"],
                    "left_name": left["name"],
                    "right_name": right["name"],
                    "score": round(score, 2),
                    "reason": _reason(left["name"], right["name"], score),
                    "books": sorted(set(left["books"]) | set(right["books"])),
                    # 必须用户确认才合并 —— 全自动合并的代价是假连接，比没网更糟。
                    "needs_confirmation": True,
                }
            )
    out.sort(key=lambda item: (-item["score"], item["left_name"]))
    return out


def _reason(left: str, right: str, score: float) -> str:
    if score >= 0.75:
        return f"「{left}」与「{right}」是同一种写法的不同变体"
    return f"「{left}」与「{right}」互为包含关系，可能是同一概念的粗细粒度"


def _as_str_list(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if isinstance(value, (list, tuple)):
        return [str(v).strip() for v in value if str(v or "").strip()]
    return []


# --------------------------------------------------------------------------
# 图
# --------------------------------------------------------------------------


def make_edge(
    source: Any,
    target: Any,
    *,
    kind: str = "same",
    note: str = "",
    books: Iterable[Any] = (),
) -> dict[str, Any] | None:
    """建一条边。自环、空端点、未知类型一律丢弃 —— 脏边比没有边更糟。"""
    a = str(source or "").strip()
    b = str(target or "").strip()
    if not a or not b or a == b:
        return None
    if kind not in EDGE_TYPES:
        return None
    return {
        "source": a,
        "target": b,
        "kind": kind,
        "label": EDGE_LABELS[kind],
        "note": str(note or "").strip(),
        "books": _as_str_list(list(books)),
    }


def edges_from_digests(digests: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """从各书的收获文档里抽出边。

    入参每条形如 ``{"book": "《置身事内》", "concept_key": "cpt_x", "name": "地方竞争",
    "models": [...], "connections": [...]}``。抽两类边：

    * ``connections`` 里带 ``relation`` 的条目 → 直接成边（模型自己判断的关系）；
    * 同一本书里并列出现的 ``models`` → 弱 ``same`` 边**不建**（那只是同书共现，
      不是跨书关联，建了会把图灌满噪音）。

    跨书关系由 ``candidate_pairs``（术语层）与用户在界面上手动连的线来补。
    """
    out: list[dict[str, Any]] = []
    for digest in digests:
        if not isinstance(digest, dict):
            continue
        book = str(digest.get("book") or "").strip()
        origin = str(digest.get("concept_key") or "").strip() or concept_key(digest.get("name"))
        if not origin:
            continue
        for item in digest.get("connections") or []:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "").strip()
            if not name:
                continue
            kind = str(item.get("relation") or item.get("kind") or "same").strip().lower()
            edge = make_edge(
                origin, concept_key(name),
                kind=kind if kind in EDGE_TYPES else "same",
                note=str(item.get("note") or ""),
                books=[book] if book else [],
            )
            if edge:
                out.append(edge)
    return out


def build_graph(
    nodes: Iterable[dict[str, Any]], edges: Iterable[dict[str, Any]]
) -> dict[str, Any]:
    """建邻接表。节点可以是 dict 或纯 key 字符串。"""
    node_map: dict[str, dict[str, Any]] = {}
    for node in nodes:
        if isinstance(node, str):
            key, name = node, node
        elif isinstance(node, dict):
            name = str(node.get("name") or node.get("canonical_name") or "").strip()
            key = str(node.get("concept_key") or "").strip() or concept_key(name)
        else:
            continue
        if not key:
            continue
        node_map.setdefault(key, {"concept_key": key, "name": name, "books": []})
        if name and not node_map[key].get("name"):
            node_map[key]["name"] = name
        for book in _as_str_list((node or {}).get("books") if isinstance(node, dict) else None):
            if book not in node_map[key]["books"]:
                node_map[key]["books"].append(book)

    adjacency: dict[str, list[dict[str, Any]]] = defaultdict(list)
    clean_edges: list[dict[str, Any]] = []
    for edge in edges:
        if not isinstance(edge, dict):
            continue
        a, b = str(edge.get("source") or ""), str(edge.get("target") or "")
        if not a or not b or a == b:
            continue
        # 边引用的节点必须存在，否则补一个占位节点 —— 丢掉边会让图静默缺一块。
        for key in (a, b):
            node_map.setdefault(key, {"concept_key": key, "name": key, "books": []})
        adjacency[a].append(edge)
        if edge.get("kind") not in DIRECTED_EDGE_TYPES:
            adjacency[b].append(edge)
        clean_edges.append(edge)
        for book in _as_str_list(edge.get("books")):
            for key in (a, b):
                if book not in node_map[key]["books"]:
                    node_map[key]["books"].append(book)

    return {
        "nodes": list(node_map.values()),
        "edges": clean_edges,
        "adjacency": {k: v for k, v in adjacency.items()},
    }


def _neighbors(graph: dict[str, Any], key: str) -> set[str]:
    out: set[str] = set()
    for edge in graph.get("adjacency", {}).get(key, []):
        other = edge["target"] if edge["source"] == key else edge["source"]
        if other != key:
            out.add(other)
    return out


def clusters(graph: dict[str, Any]) -> list[list[str]]:
    """连通分量。**不按学科切分** —— Matuschak 明确说偏好关联式本体而非层级分类，
    所以「哪些概念该在一起」由图自己长出来，不靠预设目录。"""
    seen: set[str] = set()
    out: list[list[str]] = []
    for node in graph.get("nodes", []):
        start = node["concept_key"]
        if start in seen:
            continue
        stack, group = [start], []
        seen.add(start)
        while stack:
            current = stack.pop()
            group.append(current)
            for neighbor in _neighbors(graph, current):
                if neighbor not in seen:
                    seen.add(neighbor)
                    stack.append(neighbor)
        out.append(sorted(group))
    out.sort(key=len, reverse=True)
    return out


def find_hubs(graph: dict[str, Any], *, limit: int = 8) -> list[dict[str, Any]]:
    """枢纽概念：连接数最高的几个。

    对应 Luhmann 的 **hub notes**（他专门维护总览卡当高速公路）。
    但这里多一条过滤：**只被一本书提到的 hub 不算 hub** ——
    那只是那本书内部的中心概念，不是跨书的枢纽。
    """
    out: list[dict[str, Any]] = []
    for node in graph.get("nodes", []):
        key = node["concept_key"]
        degree = len(_neighbors(graph, key))
        if degree <= 0:
            continue
        out.append(
            {
                "concept_key": key,
                "name": node.get("name") or key,
                "degree": degree,
                "books": list(node.get("books") or []),
                "cross_book": len(node.get("books") or []) >= CROSS_SUPPORT_MIN,
            }
        )
    out.sort(key=lambda item: (-item["degree"], -len(item["books"]), item["name"]))
    return out[: max(1, limit)]


def find_bridges(graph: dict[str, Any], *, limit: int = 8) -> list[dict[str, Any]]:
    """**桥接节点**：去掉它之后，图的连通分量会变多的那些节点。

    这是整张网里最值钱的东西 —— 对应前沿研究里的 bridging nodes
    （「连接原本分离的知识簇」），也对应 Munger 说的「跨学科的同一个结论」。

    判据用**割点**（articulation point）的朴素实现：对每个节点试删一次，
    比较连通分量数。图规模是「一个人读过的书」量级（几十到几百节点），
    朴素算法完全够用，不值得上 Tarjan。
    """
    # ⚠️ 这里**不能**用「连通分量 > 1 才算」当前置条件 —— 那正好把唯一存在桥的情形
    # （图是连通的）排除掉，函数会永远返回空。判空只需「有没有边」。
    if not graph.get("edges"):
        return []
    base = len(clusters(graph))
    nodes = [n["concept_key"] for n in graph.get("nodes", [])]
    out: list[dict[str, Any]] = []
    for key in nodes:
        reduced = _without_node(graph, key)
        if not reduced["nodes"]:
            continue
        delta = len(clusters(reduced)) - base
        if delta <= 0:
            continue
        node = next((n for n in graph["nodes"] if n["concept_key"] == key), {})
        out.append(
            {
                "concept_key": key,
                "name": node.get("name") or key,
                "clusters_joined": delta,
                "books": list(node.get("books") or []),
            }
        )
    out.sort(key=lambda item: (-item["clusters_joined"], item["name"]))
    return out[: max(1, limit)]


def _without_node(graph: dict[str, Any], key: str) -> dict[str, Any]:
    nodes = [n for n in graph.get("nodes", []) if n["concept_key"] != key]
    edges = [
        e for e in graph.get("edges", [])
        if e.get("source") != key and e.get("target") != key
    ]
    return build_graph(nodes, edges)


def cross_support(graph: dict[str, Any]) -> list[dict[str, Any]]:
    """跨书支持度：一个概念被几本书提到。

    **孤证要显式标出来** —— 知源的来源视图早就有同样的设计（孤证概念提示需补来源）。
    被 ≥2 本书支持 = 交叉验证（Munger：多学科独立指向同一结论，可信度更高）；
    只有 1 本 = 孤证，别当共识用。
    """
    out: list[dict[str, Any]] = []
    for node in graph.get("nodes", []):
        books = list(node.get("books") or [])
        stage = concept_stage(len(books))
        out.append(
            {
                "concept_key": node["concept_key"],
                "name": node.get("name") or node["concept_key"],
                "book_count": len(books),
                "books": books,
                "verified": len(books) >= CROSS_SUPPORT_MIN,
                "stage": stage,
                "stage_label": STAGE_LABELS[stage],
            }
        )
    out.sort(key=lambda item: (-item["book_count"], item["name"]))
    return out


# --------------------------------------------------------------------------
# 方法论：对一个**簇**做子图社区摘要
# --------------------------------------------------------------------------

METHODOLOGY_SCHEMA = (
    "【输出 JSON 字段】\n"
    "{\n"
    '  "title": "方法论名称。要具体、可指认，不要「关于 XX 的思考」这种空标题。",\n'
    '  "one_liner": "这套方法论一句话是什么。40~100 字。",\n'
    '  "premise": "它成立的前提 —— 什么条件下这套做法才有效。",\n'
    '  "steps": [{"name": "步骤名（动词开头）", "what": "具体做什么",'
    ' "why": "为什么这一步不能省"}],\n'
    '  "when_to_use": "什么场景该用它（要具体到能判断「现在是不是这个场景」）",\n'
    '  "when_not_to_use": "什么场景别用它 —— 边界比适用范围更重要",\n'
    '  "counter_example": "一个会让人用错的典型情形",\n'
    '  "source_concepts": ["这套方法论用到了簇里的哪些概念（必须是给定清单里的名字，逐字回填）"],\n'
    '  "confidence_note": "这套方法论的证据强度：被几本书支持、有没有互相冲突的说法"\n'
    "}\n"
    "条数要求：steps 3~6 条。\n"
    "⚠️ 最重要的一条：**这是一套做法，不是一段总结**。"
    "steps 必须能照着执行；when_not_to_use 必须能挡住误用。\n"
    "⚠️ source_concepts 只能填给定概念清单里的名字；清单里没有的，绝不编。\n"
)

METHODOLOGY_RULES = (
    "【事实铁律 —— 违反即判定本次生成失败】\n"
    "1. 只依据 payload.concepts（概念及其出处）与 payload.edges（它们之间的关系）"
    "以及 payload.excerpts（用户自己的划线/笔记）。没有的一律不写。\n"
    "2. ⚠️ 禁止用通识补全。这套方法论必须能追溯到给定的概念与关系上；"
    "推不出来就写「材料不足以归纳」，不要硬凑一套听起来对的方法论。\n"
    "3. 如果 edges 里有 contrast（对立）关系，**必须在 confidence_note 里点名**"
    "—— 两本书说法冲突时，方法论要么说明适用边界，要么承认这里没有共识。\n"
    "4. 孤证（只被一本书支持）的概念，在 confidence_note 里要标出「仅单一来源」。\n"
    "5. 只返回 JSON 对象，不要 Markdown 代码围栏，不要 JSON 之外的解释。\n"
)

METHODOLOGY_INSTRUCTION = (
    "你在为知源 KnowOrigin 生成【方法论】。"
    "用户读过的几本书里，有一批概念被反复提到、彼此相连。"
    "你的任务不是复述这些概念，而是把它们**归纳成一套能照着做的做法** ——"
    "读者看完应当知道「什么场景下、按什么顺序、做什么」。"
)


def build_methodology_payload(
    cluster: Sequence[dict[str, Any]],
    edges: Iterable[dict[str, Any]] = (),
    *,
    excerpts: Iterable[Any] = (),
) -> dict[str, Any]:
    """组装「方法论」生成请求的 payload。纯函数，不碰数据库。

    ⚠️ **只喂这一个簇**，不喂整张网 —— 这是 NLP-AKG 的 sub-graph community summary：
    让模型聚焦在相关的概念社区里，比把整张图丢给它准确得多。
    """
    concepts: list[dict[str, Any]] = []
    for item in list(cluster)[:MAX_CLUSTER_CONCEPTS]:
        if not isinstance(item, dict):
            continue
        concepts.append(
            {
                "name": str(item.get("name") or "").strip(),
                "books": _as_str_list(item.get("books")),
                "note": str(item.get("note") or item.get("description") or "")[:200],
            }
        )

    picked_edges: list[dict[str, str]] = []
    for edge in list(edges)[:MAX_CLUSTER_EDGES]:
        if not isinstance(edge, dict):
            continue
        picked_edges.append(
            {
                "from": str(edge.get("source") or ""),
                "to": str(edge.get("target") or ""),
                "relation": EDGE_LABELS.get(str(edge.get("kind") or ""), "相关"),
                "note": str(edge.get("note") or "")[:160],
            }
        )

    return {
        "instruction": METHODOLOGY_INSTRUCTION,
        "rules": METHODOLOGY_RULES,
        "schema": METHODOLOGY_SCHEMA,
        "concepts": concepts,
        "edges": picked_edges,
        "excerpts": [
            {
                "book": str(_pick(item, "book", "title") or ""),
                "text": str(_pick(item, "mark_text", "text", "content") or "")[:220],
            }
            for item in list(excerpts)[:30]
        ],
    }


def _pick(item: Any, *names: str) -> str:
    for name in names:
        if isinstance(item, dict):
            value = item.get(name)
        else:
            value = getattr(item, name, None)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _text(value: Any, limit: int) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[: max(1, limit - 1)].rstrip() + "…"


def normalize_methodology_result(raw: Any) -> dict[str, Any]:
    """逐字段校验模型返回的方法论。不达标**只**丢那一个字段，其余照用。"""
    data = raw if isinstance(raw, dict) else {}

    steps: list[dict[str, str]] = []
    for item in data.get("steps") or []:
        if not isinstance(item, dict):
            continue
        name = _text(item.get("name"), 60)
        what = _text(item.get("what"), 240)
        if len(name) < 2 or len(what) < 6:
            continue
        steps.append({"name": name, "what": what, "why": _text(item.get("why"), 240)})
        if len(steps) >= 6:
            break

    return {
        "title": _text(data.get("title"), 60),
        "one_liner": _text(data.get("one_liner"), 160),
        "premise": _text(data.get("premise"), 240),
        "steps": steps,
        "when_to_use": _text(data.get("when_to_use"), 240),
        "when_not_to_use": _text(data.get("when_not_to_use"), 240),
        "counter_example": _text(data.get("counter_example"), 240),
        "source_concepts": [
            _text(item, 60) for item in (data.get("source_concepts") or []) if _text(item, 60)
        ][:MAX_CLUSTER_CONCEPTS],
        "confidence_note": _text(data.get("confidence_note"), 300),
    }


def methodology_has_content(result: dict[str, Any]) -> bool:
    """一份方法论是不是真的成型了（标题 + 至少两步）。"""
    return bool(result.get("title") and len(result.get("steps") or []) >= 2)


def build_methodology_fallback(cluster: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """模型不可用时的兜底：**不编方法论**，只把簇里的概念按书分组摆出来。

    方法论是「归纳」，本地拼不出来；硬拼就是编造。这里只做诚实的呈现。
    """
    by_book: dict[str, list[str]] = defaultdict(list)
    for item in cluster:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        for book in _as_str_list(item.get("books")) or ["（未标注来源）"]:
            if name not in by_book[book]:
                by_book[book].append(name)
    return {
        "title": "",
        "one_liner": "",
        "premise": "",
        "steps": [],
        "when_to_use": "",
        "when_not_to_use": "",
        "counter_example": "",
        "source_concepts": [str(i.get("name") or "") for i in cluster if isinstance(i, dict)][:MAX_CLUSTER_CONCEPTS],
        "confidence_note": "本次未能归纳成方法论（模型不可用）。下面按书列出这一簇里的概念，未作任何归纳。",
        "_by_book": {k: v for k, v in by_book.items()},
    }


def render_methodology_markdown(result: dict[str, Any], *, concepts: Sequence[str] = ()) -> str:
    """把方法论渲染成一份可导出、可打印的 Markdown。"""
    title = result.get("title") or "未命名方法论"
    parts: list[str] = [f"# {title}\n"]
    if result.get("one_liner"):
        parts.append(f"**一句话**：{result['one_liner']}\n")
    if result.get("premise"):
        parts.append(f"**成立前提**：{result['premise']}\n")

    steps = result.get("steps") or []
    if steps:
        body = "\n".join(
            f"{i}. **{s['name']}** —— {s['what']}"
            + (f"\n   - 为什么不能省：{s['why']}" if s.get("why") else "")
            for i, s in enumerate(steps, start=1)
        )
        parts.append(f"## 怎么做\n\n{body}\n")

    if result.get("when_to_use"):
        parts.append(f"## 什么时候用\n\n{result['when_to_use']}\n")
    if result.get("when_not_to_use"):
        parts.append(f"## 什么时候别用\n\n{result['when_not_to_use']}\n")
    if result.get("counter_example"):
        parts.append(f"## 一个容易用错的场景\n\n{result['counter_example']}\n")

    names = result.get("source_concepts") or list(concepts)
    if names:
        parts.append("## 用到的概念\n\n" + "\n".join(f"- {n}" for n in names) + "\n")
    if result.get("confidence_note"):
        parts.append(f"## 证据强度\n\n{result['confidence_note']}\n")

    by_book = result.get("_by_book")
    if isinstance(by_book, dict) and by_book:
        blocks = [f"### {book}\n\n" + "\n".join(f"- {n}" for n in items) for book, items in by_book.items()]
        parts.append("## 这些概念分别出自哪里\n\n" + "\n\n".join(blocks) + "\n")

    return "\n".join(parts)


# --------------------------------------------------------------------------
# 概念详解：把**一个概念**展开成可读的详解
# --------------------------------------------------------------------------
# 与「方法论」的分工（别合并）：
#   方法论 = 对一个**簇**做归纳，产出的是一套能照着做的做法（怎么用）；
#   概念详解 = 对一个**概念**做展开，产出的是「它是什么、每本书里怎么说、
#              怎么认出来、容易错在哪」（是什么）。
# 读者在神经图谱里点开一个概念，要的是后者 —— 光有「被几本书支持 / 关联了谁」
# 这些元数据不算干货。

CONCEPT_DOC_SCHEMA = (
    "【输出 JSON 字段】\n"
    "{\n"
    '  "title": "概念名（逐字用 payload.concept.name）",\n'
    '  "one_liner": "一句话说清它是什么。40~100 字，要能独立读懂。",\n'
    '  "in_each_book": [{"book": "书名（必须逐字来自 payload.concept.books）",'
    ' "reading": "这本书里它指什么、用来解释什么（20~120 字）",'
    ' "quote": "书里的原话或最贴近的一句（逐字来自 payload.excerpts；没有就留空字符串）"}],\n'
    '  "why_it_matters": "为什么这个概念值得单独记住 —— 它能解释什么别的东西。",\n'
    '  "how_to_spot": "在现实或材料里怎么认出它：给可判断的判据，不要形容词。",\n'
    '  "how_to_use": ["怎么用它。2~5 条，动词开头。"],\n'
    '  "pitfalls": ["最容易搞错的地方。1~4 条，每条要指出错在哪。"],\n'
    '  "conflicts": "如果 payload.relations 里有「对立」，把分歧本身写清楚'
    '（谁跟谁冲突、冲突点是什么）；没有就留空字符串。",\n'
    '  "beyond": "网外延伸：把这个概念接到别的学科 / 别的书 / 现实案例上，至少 2 个方向。'
    '必须自报家门（明说这是网外的联想）。",\n'
    '  "confidence_note": "证据强度：被几本书支持、是不是孤证、是不是桥。"\n'
    "}\n"
    "⚠️ 最重要的一条：**in_each_book 是这份详解的骨头**。"
    "每本书里它指什么必须分开写 —— 几本书用同一个词说不同的事，正是最该被看见的地方。\n"
    "⚠️ 只返回 JSON 对象，不要 Markdown 代码围栏，不要 JSON 之外的解释。\n"
)

CONCEPT_DOC_RULES = (
    "【事实铁律 —— 违反即判定本次生成失败】\n"
    "1. 「书里说了什么」只依据 payload.excerpts（各本书《读书收获》里提到这个概念的原句）"
    "与 payload.relations（它与其他概念的关系）。没有的一律不写。\n"
    "2. ⚠️ 禁止用通识补全概念的书内含义。某本书的材料里看不出它指什么，"
    "就在那一条的 reading 里写「这本书的材料里没有展开」，不要替它编。\n"
    "3. quote 必须逐字来自 payload.excerpts。找不到逐字对应的句子就留空字符串，"
    "**绝不改写、绝不拼接**。\n"
    "4. payload.relations 里有「对立」时，conflicts 必须点名是谁跟谁冲突、冲突点是什么"
    "—— 两本书说法冲突时不要和稀泥。\n"
    "5. 孤证（payload.concept.support.book_count == 1）必须在 confidence_note 里写明"
    "「仅单一来源」，别当共识用。\n"
    "6. beyond 是唯一允许超出材料的部分，但必须自报家门（明说这是网外的联想或推断），"
    "绝不与书里的结论混成一段。不许编造书名、页码、作者原话、文献、链接、数值。\n"
)

CONCEPT_DOC_INSTRUCTION = (
    "你在为知源 KnowOrigin 生成【概念详解】。读者读过多本书，知源把各本书《读书收获》里的"
    "「可复用模型」连成了一张跨书知识网络。现在他点开了其中一个概念，想知道："
    "**它到底是什么、每本书里分别怎么说、怎么在现实里认出它、容易错在哪。**"
    "这不是一份词典条目，是一份「读完之后能拿去用」的详解。"
)

CONCEPT_DOC_MAX_EXCERPT = 500
CONCEPT_DOC_MAX_RELATIONS = 16


def concept_doc_signature(
    concept: Any,
    relations: Iterable[Any] = (),
    excerpts: Iterable[Any] = (),
) -> str:
    """概念详解的「材料指纹」。材料没变就不重跑模型（与 knowledge_docs 同一口径）。"""
    item = concept if isinstance(concept, dict) else {}
    chunks = [
        str(item.get("name") or ""),
        "|".join(_as_str_list(item.get("books"))),
    ]
    for edge in relations:
        if not isinstance(edge, dict):
            continue
        chunks.append(">".join([
            str(edge.get("other") or ""), str(edge.get("kind") or ""), str(edge.get("note") or ""),
        ]))
    for ex in excerpts:
        if not isinstance(ex, dict):
            continue
        chunks.append("<".join([str(ex.get("book") or ""), str(ex.get("text") or "")]))
    return hashlib.sha1("\n".join(chunks).encode("utf-8", "replace")).hexdigest()[:32]


def build_concept_doc_payload(
    concept: dict[str, Any],
    relations: Iterable[dict[str, Any]] = (),
    excerpts: Iterable[Any] = (),
    *,
    domain: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """组装「概念详解」生成请求的 payload。纯函数，不碰数据库。"""
    item = concept if isinstance(concept, dict) else {}
    support = item.get("support") if isinstance(item.get("support"), dict) else {}
    picked_relations: list[dict[str, str]] = []
    for edge in list(relations)[:CONCEPT_DOC_MAX_RELATIONS]:
        if not isinstance(edge, dict):
            continue
        picked_relations.append(
            {
                "other": str(edge.get("other") or ""),
                "relation": EDGE_LABELS.get(str(edge.get("kind") or ""), "相关"),
                "note": str(edge.get("note") or "")[:200],
            }
        )
    return {
        "instruction": CONCEPT_DOC_INSTRUCTION,
        "rules": CONCEPT_DOC_RULES,
        "schema": CONCEPT_DOC_SCHEMA,
        "concept": {
            "name": str(item.get("name") or "").strip(),
            "books": _as_str_list(item.get("books")),
            "support": {
                "book_count": int(support.get("book_count") or 0),
                "stage": str(support.get("stage") or ""),
                "stage_label": str(support.get("stage_label") or ""),
            },
            "is_bridge": bool(item.get("is_bridge")),
            "bridge_splits": int(item.get("bridge_splits") or 0),
        },
        "domain": {
            "name": str((domain or {}).get("name") or ""),
            "size": int((domain or {}).get("size") or 0),
            "members": _as_str_list((domain or {}).get("members"))[:40],
        },
        "relations": picked_relations,
        "excerpts": [
            {
                "book": str(_pick(ex, "book", "title") or ""),
                "text": str(_pick(ex, "text", "mark_text", "content") or "")[:CONCEPT_DOC_MAX_EXCERPT],
            }
            for ex in list(excerpts)[:30]
        ],
    }


def _as_text_list(value: Any, limit: int, count: int) -> list[str]:
    out: list[str] = []
    for item in value if isinstance(value, (list, tuple)) else []:
        text = _text(item, limit)
        if text:
            out.append(text)
        if len(out) >= count:
            break
    return out


def normalize_concept_doc_result(raw: Any) -> dict[str, Any]:
    """逐字段校验模型返回的详解。不达标**只**丢那一个字段，其余照用。"""
    data = raw if isinstance(raw, dict) else {}

    in_each_book: list[dict[str, str]] = []
    for item in data.get("in_each_book") or []:
        if not isinstance(item, dict):
            continue
        book = _text(item.get("book"), 120)
        reading = _text(item.get("reading"), 400)
        if not book or len(reading) < 6:
            continue
        in_each_book.append({
            "book": book,
            "reading": reading,
            "quote": _text(item.get("quote"), 400),
        })
        if len(in_each_book) >= 12:
            break

    return {
        "title": _text(data.get("title"), 80),
        "one_liner": _text(data.get("one_liner"), 240),
        "in_each_book": in_each_book,
        "why_it_matters": _text(data.get("why_it_matters"), 400),
        "how_to_spot": _text(data.get("how_to_spot"), 400),
        "how_to_use": _as_text_list(data.get("how_to_use"), 240, 5),
        "pitfalls": _as_text_list(data.get("pitfalls"), 240, 4),
        "conflicts": _text(data.get("conflicts"), 500),
        "beyond": _text(data.get("beyond"), 900),
        "confidence_note": _text(data.get("confidence_note"), 300),
    }


def concept_doc_has_content(result: dict[str, Any]) -> bool:
    """一份详解是不是真的成型了：有「一句话」+ 至少一条「某本书里怎么说」。"""
    return bool(result.get("one_liner") and result.get("in_each_book"))


def build_concept_doc_fallback(
    concept: dict[str, Any],
    relations: Iterable[dict[str, Any]] = (),
    excerpts: Iterable[Any] = (),
) -> dict[str, Any]:
    """模型不可用时的兜底：**不编详解**，只把材料原样摆出来。

    详解是「展开」，本地拼不出来；硬拼就是编造。这里只做诚实的呈现 ——
    读者至少能看到各本书里提到这个概念的原句。
    """
    item = concept if isinstance(concept, dict) else {}
    by_book: dict[str, list[str]] = defaultdict(list)
    for ex in excerpts:
        if not isinstance(ex, dict):
            continue
        text = str(_pick(ex, "text", "mark_text", "content") or "").strip()
        if not text:
            continue
        by_book[str(_pick(ex, "book", "title") or "（未标注来源）")].append(text[:CONCEPT_DOC_MAX_EXCERPT])
    support = item.get("support") if isinstance(item.get("support"), dict) else {}
    return {
        "title": str(item.get("name") or ""),
        "one_liner": "",
        "in_each_book": [
            {"book": book, "reading": texts[0][:400], "quote": texts[0][:400]}
            for book, texts in by_book.items()
        ],
        "why_it_matters": "",
        "how_to_spot": "",
        "how_to_use": [],
        "pitfalls": [],
        "conflicts": "",
        "beyond": "",
        "confidence_note": (
            "本次未能生成详解（模型不可用）。下面只把各本书《读书收获》里提到这个概念的原句"
            "原样列出，未作任何归纳。"
            + (
                f"这个概念被 {support.get('book_count')} 本书支持（{support.get('stage_label') or ''}）。"
                if support else ""
            )
        ),
        "_by_book": {k: v for k, v in by_book.items()},
        "_relations": [
            {"other": str(e.get("other") or ""), "relation": EDGE_LABELS.get(str(e.get("kind") or ""), "相关")}
            for e in relations if isinstance(e, dict)
        ][:CONCEPT_DOC_MAX_RELATIONS],
    }


def render_concept_doc_markdown(
    result: dict[str, Any],
    *,
    name: str = "",
    books: Iterable[str] = (),
    domain: str = "",
    is_bridge: bool = False,
    bridge_splits: int = 0,
    generated_at: str = "",
) -> str:
    """把校验过的详解渲染成 Markdown。空字段直接不渲染那一节（不留空标题）。"""
    title = result.get("title") or name or "概念详解"
    parts = [f"# {title}\n"]
    meta: list[str] = []
    if domain:
        meta.append(f"所属领域：{domain}")
    book_list = _as_str_list(list(books))
    if book_list:
        meta.append("来源：" + "、".join(book_list))
    if is_bridge:
        meta.append(f"★ 桥（去掉它这个领域会裂成 {max(1, int(bridge_splits or 1))} 块）")
    if meta:
        parts.append("> " + " · ".join(meta) + "\n")

    if result.get("one_liner"):
        parts.append(f"## 一句话\n\n{result['one_liner']}\n")

    rows = result.get("in_each_book") or []
    if rows:
        blocks: list[str] = []
        for row in rows:
            block = f"### {row.get('book') or '（未标注来源）'}\n\n{row.get('reading') or ''}"
            if row.get("quote"):
                block += "\n\n> " + str(row["quote"]).replace("\n", " ")
            blocks.append(block)
        parts.append("## 每本书里怎么说\n\n" + "\n\n".join(blocks) + "\n")

    by_book = result.get("_by_book")
    if isinstance(by_book, dict) and by_book:
        blocks = [
            f"### {book}\n\n" + "\n".join(f"> {t}" for t in texts)
            for book, texts in by_book.items()
        ]
        parts.append("## 各本书里的原句\n\n" + "\n\n".join(blocks) + "\n")

    rel = result.get("_relations")
    if isinstance(rel, list) and rel:
        lines = [f"- **{r.get('relation') or '相关'}**：{r.get('other') or ''}" for r in rel if r.get("other")]
        if lines:
            parts.append("## 它连着什么\n\n" + "\n".join(lines) + "\n")

    if result.get("why_it_matters"):
        parts.append(f"## 为什么值得记住\n\n{result['why_it_matters']}\n")
    if result.get("how_to_spot"):
        parts.append(f"## 怎么认出它\n\n{result['how_to_spot']}\n")
    if result.get("how_to_use"):
        parts.append("## 怎么用它\n\n" + "\n".join(f"- {x}" for x in result["how_to_use"]) + "\n")
    if result.get("pitfalls"):
        parts.append("## 容易搞错的地方\n\n" + "\n".join(f"- {x}" for x in result["pitfalls"]) + "\n")
    if result.get("conflicts"):
        parts.append(f"## 两本书在这里说法冲突\n\n{result['conflicts']}\n")
    if result.get("beyond"):
        parts.append(f"## 往外发散（网外的联想，不是书里写的）\n\n{result['beyond']}\n")
    if result.get("confidence_note"):
        parts.append(f"## 证据强度\n\n{result['confidence_note']}\n")
    if generated_at:
        parts.append(f"---\n\n*生成于 {generated_at}。详解只依据你在各本书《读书收获》里留下的内容。*\n")

    return "\n".join(parts)


# --------------------------------------------------------------------------
# 技能沉淀：方法论 → 可练的技能卡
# --------------------------------------------------------------------------

SKILL_CARD_PREFIX = "kn_"
SKILL_CATEGORY = "跨书方法论"
SKILL_MAX_CARDS = 4
SKILL_MAX_FRONT = 400
SKILL_MAX_BACK = 700


def skill_card_id(cluster_key: str, front: str) -> str:
    """稳定技能卡 id。与 reading_store 的 rd_ 卡同理：重生成不换卡，FSRS 排期不丢。"""
    digest = hashlib.sha1(
        "|".join([str(cluster_key), str(front)]).encode("utf-8", "replace")
    ).hexdigest()
    return f"{SKILL_CARD_PREFIX}{digest[:20]}"


def build_skill_cards(
    result: dict[str, Any],
    *,
    cluster_key: str,
    source_ids: Iterable[str] = (),
) -> list[dict[str, Any]]:
    """把方法论沉淀成**技能卡**（练的是「该用哪套、什么时候用」）。

    与收获文档的自测卡不同：那边考的是「书里说了什么」（知识），
    这边考的是「这个场景该用哪套做法」（**技能**）—— 所以题面是情境题。
    题源：``when_not_to_use`` / ``counter_example`` / 每步的 ``why``。
    """
    if not methodology_has_content(result):
        return []
    src = [str(s) for s in source_ids if str(s or "").strip()][:8]
    title = str(result.get("title") or "").strip()
    candidates: list[tuple[str, str]] = []

    if result.get("counter_example"):
        candidates.append(
            (f"有人说「{title}」在任何情况下都适用。这个说法错在哪？", str(result["counter_example"]))
        )
    if result.get("when_not_to_use"):
        candidates.append(
            (f"什么情况下**不该**用「{title}」？", str(result["when_not_to_use"]))
        )
    if result.get("when_to_use"):
        candidates.append(
            (f"什么场景下该用「{title}」？", str(result["when_to_use"]))
        )
    for step in result.get("steps") or []:
        if len(candidates) >= SKILL_MAX_CARDS:
            break
        if isinstance(step, dict) and step.get("why") and step.get("name"):
            candidates.append((f"「{title}」里为什么要「{step['name']}」这一步？", str(step["why"])))

    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for front, back in candidates:
        if len(out) >= SKILL_MAX_CARDS:
            break
        front = _text(front, SKILL_MAX_FRONT)
        back = _text(back, SKILL_MAX_BACK)
        if not front or not back or front in seen:
            continue
        seen.add(front)
        out.append(
            {
                "card_id": skill_card_id(cluster_key, front),
                "front": front,
                "back": back,
                "category": SKILL_CATEGORY,
                "difficulty": 3,   # 技能题比识记题难一档
                "source_ids": src,
                "node_ids": [],
                "origin_section": "方法论",
            }
        )
    return out


# --------------------------------------------------------------------------
# 问整张网：把「跨书知识网络」当成一份材料交给模型
# --------------------------------------------------------------------------
# 与 core/reading_digest.py 的陪读讨论**分工不同**，别合并：
#   reading_ask  —— 读者正读着一本书，就选中那一段往书外发散；
#   net_ask      —— 读者手上是一张**跨书**的网，问的是书与书之间的结构
#                   （哪个概念是桥、哪些是孤证、两本书哪里冲突、怎么分组）。
# 后者没有「原文选段」这回事，材料就是**整张网的结构化描述**（由前端渲染后送来）。
# 所以系统提示词单独写一份：用陪读那套「你正读着一本书、选中了一段」会误导模型。

# 讨论要的是联想宽度，不是唯一解 —— 与 READING_ASK_TEMPERATURE 同一理由。
NET_ASK_TEMPERATURE = 0.8

NET_ASK_SYSTEM = (
    "你是知源 KnowOrigin 的【跨书知识网络分析伙伴】。读者读过多本书，知源把各本书收获里的"
    "「可复用模型」与「和知识库的联系」连成了一张**跨书知识网络**，现在把这张网交给你。\n"
    "⚠️ 读者给的明确要求：**不要只复述这张网，要发散思维，帮他把网往外连。**\n"
    "按两层来答：\n"
    "① 先贴着网（短）：用两三句直接回应问题，指出依据是 payload.context 里的哪个概念、"
    "哪条关系或哪个领域。**引用必须逐字来自 payload.context**，不要自己发明概念名或关系。\n"
    "② 再往外发散（长，这是重点）：把这张网接到更大的世界里 —— 别的学科、别的书、"
    "历史与现实中的案例、类比与隐喻、反方立场、极端情形、读者自己没说出来的前提。"
    "**至少铺 3 个互不相同的方向**，能连多远就连多远。\n"
    "三条红线：\n"
    "· 别把发散冒充成网里的内容 —— 凡属网外延伸，就明说「网里没写，我联想到…」；\n"
    "· 不编造书名、页码、作者原话、文献、链接、数值，没把握就说不确定；\n"
    "· **网的规模是客观事实**（几个概念、几条关系、几个领域、几个桥、来自几本书），"
    "问到数量就照 payload.context 里的数字说，不要估算。\n"
    "结尾留 2~3 个能把思考继续往下拽的问题。默认 300~700 字，读者要求展开时放开写。\n"
    "直接输出 Markdown 正文：不要 JSON、不要代码围栏、不要「好问题」这类客套。"
)

NET_ASK_RULES = (
    "【讨论铁律 —— 违反任何一条这次回答都算不合格】\n"
    "1. 先回应问题，再发散；不复述问题，不写「好问题」这类客套。\n"
    "2. 「网里有什么」只依据 payload.context：概念名、关系类型、领域划分、桥、来源书单"
    "都必须逐字对得上，不许发明。\n"
    "3. 网的规模（概念/关系/领域/桥/书的数量）以 payload.context 里的数字为准，不许估算。\n"
    "4. 「你的发散」放开想、放开连：网外延伸必须自报家门（明说这是网外的联想或推断），"
    "绝不与网里的结论混成一段、更不许借这张网的名义说。\n"
    "5. 发散是主线：至少 3 个互不相同的方向，越开阔越好，不要收敛。\n"
    "6. 不许编造书名、页码、作者原话、文献、链接、数值；没把握就直说不确定。\n"
)


def build_net_ask_payload(
    *,
    question: str,
    context: str = "",
    scope: str = "network",
    anchor: str = "",
    history: Iterable[Any] = (),
) -> dict[str, Any]:
    """组装「就这张网提问」的输入。纯函数，不碰数据库。

    ``context`` 由前端渲染（它手上有整张网，也才知道用户当前停在哪个领域 / 概念）。
    """
    rows: list[dict[str, str]] = []
    for item in list(history)[-3:]:
        if not isinstance(item, dict):
            continue
        q = str(item.get("question") or item.get("q") or "").strip()[:300]
        a = str(item.get("answer") or item.get("a") or "").strip()[:1200]
        if q:
            rows.append({"question": q, "answer": a})
    return {
        "scope": "concept" if str(scope) == "concept" else "network",
        "anchor": str(anchor or "").strip()[:120],
        "question": str(question or "").strip()[:300],
        "context": str(context or "").strip(),
        "history": rows,
        "rules": NET_ASK_RULES,
    }


def net_ask_needs_material(payload: dict[str, Any]) -> bool:
    """没有网文本就没有可依据的材料 —— 早退，别让模型凭印象编一张网。"""
    return bool(str(payload.get("context") or "").strip())
