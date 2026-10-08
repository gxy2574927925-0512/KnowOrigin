"""跨书知识网络回归（纯函数，不需要网络 / 模型 / 数据库）。

跑法：``python tools/verify_knowledge_net.py``

覆盖 ——
  1. 相似度：只有「变体 / 包含」两档给分；**同尾词不给候选**（避免噪音淹没）
  2. 候选对：只产出候选、必带 needs_confirmation（**不自动合并**）
  3. 建边：自环 / 空端点 / 未知类型一律丢弃
  4. 建图：对称边双向可达，有向边只走一个方向
  5. 簇：连通分量，不按预设目录切
  6. hub：连接数排序，单书概念不算跨书枢纽
  7. **bridge：割点识别** —— 去掉它连通分量变多
  8. 跨书支持：孤证显式标注（verified=False）
  9. 方法论 payload：只喂一个簇 + 超量截断
 10. 方法论校验 / 兜底：**模型不可用时不编方法论**
 11. 渲染：Markdown 小节齐全
 12. 技能卡：稳定 id、情境题、封顶
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from core import knowledge_net as kn  # noqa: E402

FAILS = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


# ------------------------------------------------------- 1. 相似度

check("学科后缀变体给 0.75（光学 → 去后缀）",
      kn.similarity("傅里叶变换", "傅里叶变换光学") == 0.75,
      str(kn.similarity("傅里叶变换", "傅里叶变换光学")))
check("纯包含关系给 0.55", kn.similarity("复利", "复利效应") == 0.55,
      str(kn.similarity("复利", "复利效应")))
check("完全不同不给分", kn.similarity("地方竞争", "复利效应") == 0.0)
# 关键：同尾词必须是 0，否则「沉没成本/机会成本」这类会淹没候选列表
check("同尾词不给分（沉没成本 vs 机会成本）", kn.similarity("沉没成本", "机会成本") == 0.0,
      str(kn.similarity("沉没成本", "机会成本")))
check("同尾词不给分（傅里叶变换 vs 拉普拉斯变换）", kn.similarity("傅里叶变换", "拉普拉斯变换") == 0.0)
check("空输入给 0", kn.similarity("", "x") == 0.0 and kn.similarity(None, None) == 0.0)


# ------------------------------------------------------- 2. 候选对

concepts = [
    {"concept_key": "k1", "name": "复利", "books": ["《置身事内》"]},
    {"concept_key": "k2", "name": "复利效应", "books": ["《大国大城》"]},
    {"concept_key": "k3", "name": "地方竞争", "books": ["《置身事内》"]},
    {"concept_key": "k4", "name": "沉没成本", "books": ["《穷查理宝典》"]},
    {"concept_key": "k5", "name": "机会成本", "books": ["《穷查理宝典》"]},
]
pairs = kn.candidate_pairs(concepts)
names = {(p["left_name"], p["right_name"]) for p in pairs}
check("包含对进入候选", ("复利", "复利效应") in names, str(names))
check("同尾词对不进候选", ("沉没成本", "机会成本") not in names)
check("无关概念不进候选", not any("地方竞争" in a or "地方竞争" in b for a, b in names))
check("候选必带 needs_confirmation（不自动合并）",
      all(p["needs_confirmation"] is True for p in pairs))
check("候选按置信度降序", all(pairs[i]["score"] >= pairs[i + 1]["score"] for i in range(len(pairs) - 1)))
check("候选带可读理由", all(p["reason"] for p in pairs))
check("候选合并了两边的书", any(len(p["books"]) >= 2 for p in pairs))


# ------------------------------------------------------- 3. 建边

check("自环被丢弃", kn.make_edge("a", "a") is None)
check("空端点被丢弃", kn.make_edge("", "b") is None and kn.make_edge("a", "  ") is None)
check("未知类型被丢弃", kn.make_edge("a", "b", kind="乱写") is None)
edge = kn.make_edge("a", "b", kind="contrast", note="两书说法冲突", books=["《A》"])
check("合法边带标签", edge["label"] == "对立" and edge["note"] == "两书说法冲突")


# ------------------------------------------------------- 4. 建图

nodes = [
    {"concept_key": "c1", "name": "地方竞争", "books": ["《置身事内》"]},
    {"concept_key": "c2", "name": "周期对齐", "books": ["《置身事内》"]},
    {"concept_key": "c3", "name": "激励错配", "books": ["《置身事内》", "《穷查理宝典》"]},
    {"concept_key": "c4", "name": "复利效应", "books": ["《纳瓦尔宝典》", "《穷查理宝典》"]},
    {"concept_key": "c5", "name": "长期主义", "books": ["《纳瓦尔宝典》"]},
    {"concept_key": "c6", "name": "能力圈", "books": ["《穷查理宝典》"]},
]
edges = [
    kn.make_edge("c1", "c2", kind="extends"),
    kn.make_edge("c2", "c3", kind="same"),
    kn.make_edge("c3", "c4", kind="analogy"),
    kn.make_edge("c4", "c5", kind="extends"),
    kn.make_edge("c4", "c6", kind="same"),
]
graph = kn.build_graph(nodes, edges)
check("节点数正确", len(graph["nodes"]) == 6, str(len(graph["nodes"])))
# adjacency 存的是**边**，不是邻居键；邻居要用 _neighbors 取。
check("对称边（same）双向可达",
      "c3" in kn._neighbors(graph, "c2") and "c2" in kn._neighbors(graph, "c3"))
check("对称边（analogy）双向可达",
      "c4" in kn._neighbors(graph, "c3") and "c3" in kn._neighbors(graph, "c4"))
check("有向边（extends c1→c2）只走一个方向",
      "c2" in kn._neighbors(graph, "c1") and "c1" not in kn._neighbors(graph, "c2"),
      str(sorted(kn._neighbors(graph, "c2"))))
check("边引用的未知节点被补进图", kn.build_graph([], [kn.make_edge("x", "y")])["nodes"] != [])
check("空图不炸", kn.build_graph([], [])["nodes"] == [])


# ------------------------------------------------------- 5. 簇

groups = kn.clusters(graph)
check("连通分量只有 1 个（全连通）", len(groups) == 1, str(len(groups)))
isolated = kn.build_graph([{"concept_key": "z1", "name": "孤岛"}], [])
check("孤立节点自成一簇", len(kn.clusters(isolated)) == 1)


# ------------------------------------------------------- 6. hub

hubs = kn.find_hubs(graph)
check("hub 是连接最多的节点", hubs[0]["concept_key"] == "c4", str(hubs[0]))
check("hub 带跨书标记", any(h["cross_book"] for h in hubs))
check("hub 按连接数降序", all(hubs[i]["degree"] >= hubs[i + 1]["degree"] for i in range(len(hubs) - 1)))


# ------------------------------------------------------- 7. bridge（割点）

bridges = kn.find_bridges(graph)
bridge_keys = {b["concept_key"] for b in bridges}
check("识别出桥接节点", bool(bridges), str(bridge_keys))
check("c3 是桥（去掉它图会断开）", "c3" in bridge_keys, str(bridge_keys))
check("桥带 clusters_joined", all(b["clusters_joined"] >= 1 for b in bridges))

# 直接验：去掉 c3 后确实分成两半
reduced = kn._without_node(graph, "c3")
check("去掉 c3 后连通分量变多", len(kn.clusters(reduced)) > 1, str(len(kn.clusters(reduced))))
tiny = kn.build_graph(
    [{"concept_key": "a", "name": "A"}, {"concept_key": "b", "name": "B"}],
    [kn.make_edge("a", "b")],
)
check("单边图没有桥（去掉任一端点都不会把图切得更碎）", kn.find_bridges(tiny) == [],
      str(kn.find_bridges(tiny)))
check("无边图没有桥", kn.find_bridges(kn.build_graph([{"concept_key": "a", "name": "A"}], [])) == [])


# ------------------------------------------------------- 8. 跨书支持

support = {item["concept_key"]: item for item in kn.cross_support(graph)}
check("多书概念标记为已交叉验证", support["c3"]["verified"] is True)
check("孤证被显式标出", support["c1"]["verified"] is False and support["c1"]["book_count"] == 1)

# 成熟度生命周期（借自 mnemex 的 stub → draft → mature）
check("1 本 = stub", kn.concept_stage(1) == "stub")
check("2 本 = draft", kn.concept_stage(2) == "draft")
check("3 本 = mature", kn.concept_stage(3) == "mature")
check("5 本仍是 mature", kn.concept_stage(5) == "mature")
check("0 本 = stub", kn.concept_stage(0) == "stub")
check("非法输入不炸", kn.concept_stage(None) == "stub" and kn.concept_stage("x") == "stub")
check("支持度里带 stage", support["c3"]["stage"] == "draft", support["c3"]["stage"])
check("孤证 stage 是 stub", support["c1"]["stage"] == "stub")
check("stage 有中文标签", support["c1"]["stage_label"] == "孤证" and support["c3"]["stage_label"] == "待验证")
check("支持度按书数降序",
      kn.cross_support(graph)[0]["book_count"] >= kn.cross_support(graph)[-1]["book_count"])


# ------------------------------------------------------- 9. 方法论 payload

payload = kn.build_methodology_payload(graph["nodes"], edges)
check("payload 只喂一个簇（不是整张网）", len(payload["concepts"]) <= kn.MAX_CLUSTER_CONCEPTS)
check("payload 带 schema 与 rules", "schema" in payload and "rules" in payload)
check("边被翻译成中文关系名",
      all(e["relation"] in kn.EDGE_LABELS.values() for e in payload["edges"]), str(payload["edges"][:2]))

many = [{"concept_key": f"n{i}", "name": f"概念{i}", "books": ["《A》"]} for i in range(60)]
check("概念超量被截断", len(kn.build_methodology_payload(many)["concepts"]) == kn.MAX_CLUSTER_CONCEPTS)
check("摘录超量被截断",
      len(kn.build_methodology_payload([], [], excerpts=[{"text": f"x{i}"} for i in range(80)])["excerpts"]) == 30)


# ------------------------------------------------------- 10. 校验与兜底

result = kn.normalize_methodology_result({
    "title": "周期对齐检查",
    "one_liner": "先对齐评价周期与后果周期，再判断制度会不会鼓励短视。",
    "premise": "适用于任何以考核驱动的组织。",
    "steps": [
        {"name": "找出评价周期", "what": "问清楚这个指标多久被考核一次", "why": "周期决定行为"},
        {"name": "找出后果周期", "what": "问清楚代价多久显现", "why": "错配就藏在这里"},
        {"name": "短", "what": "x"},   # 不达标 → 丢弃
    ],
    "when_to_use": "评估任何考核机制时",
    "when_not_to_use": "后果无法归因到具体人时",
    "counter_example": "把长期指标硬塞进季度考核",
    "source_concepts": ["周期对齐", "激励错配"],
    "confidence_note": "被两本书支持；其中一本持对立看法，已注明边界。",
})
check("方法论标题保留", result["title"] == "周期对齐检查")
check("不达标的步骤被丢弃", len(result["steps"]) == 2, str(len(result["steps"])))
check("边界字段保留", result["when_not_to_use"].startswith("后果无法归因"))
check("成型的判定为真", kn.methodology_has_content(result))
check("只有标题没步骤 → 判定为假", not kn.methodology_has_content({"title": "x", "steps": []}))
check("非 dict 不炸", kn.normalize_methodology_result(None)["steps"] == [])

fb = kn.build_methodology_fallback([
    {"name": "地方竞争", "books": ["《置身事内》"]},
    {"name": "复利效应", "books": ["《纳瓦尔宝典》"]},
])
check("兜底不编标题", fb["title"] == "")
check("兜底不编步骤", fb["steps"] == [])
check("兜底自报家门", "未能归纳" in fb["confidence_note"])
check("兜底按书分组", set(fb["_by_book"]) == {"《置身事内》", "《纳瓦尔宝典》"})
check("兜底不判定为成型", not kn.methodology_has_content(fb))


# ------------------------------------------------------- 11. 渲染

md = kn.render_methodology_markdown(result)
for section in ("# 周期对齐检查", "## 怎么做", "## 什么时候用", "## 什么时候别用",
                "## 一个容易用错的场景", "## 用到的概念", "## 证据强度"):
    check(f"渲染含「{section}」", section in md, md[:50])
check("步骤带编号", "1. **找出评价周期**" in md)

md_fb = kn.render_methodology_markdown(fb)
check("兜底渲染带「这些概念分别出自哪里」", "## 这些概念分别出自哪里" in md_fb)


# ------------------------------------------------------- 12. 技能卡

cards = kn.build_skill_cards(result, cluster_key="cl1", source_ids=["src_1"])
check("抽出技能卡", len(cards) >= 2, str(len(cards)))
check("技能卡带前缀", all(c["card_id"].startswith(kn.SKILL_CARD_PREFIX) for c in cards))
check("技能卡分类是跨书方法论", all(c["category"] == kn.SKILL_CATEGORY for c in cards))
check("技能题难度高一档", all(c["difficulty"] == 3 for c in cards))
check("题面是情境题", any("该不该" in c["front"] or "错在哪" in c["front"] or "不该" in c["front"] for c in cards),
      str([c["front"][:24] for c in cards]))
check("card_id 稳定", [c["card_id"] for c in cards] ==
      [c["card_id"] for c in kn.build_skill_cards(result, cluster_key="cl1")])
check("不同簇的卡不撞 id", cards[0]["card_id"] != kn.build_skill_cards(result, cluster_key="cl2")[0]["card_id"])
check("卡数封顶", len(kn.build_skill_cards(
    {**result, "steps": [{"name": f"步{i}", "what": "做", "why": "因为"} for i in range(20)]},
    cluster_key="cl1")) <= kn.SKILL_MAX_CARDS)
check("未成型的方法论不产卡", kn.build_skill_cards({"title": "", "steps": []}, cluster_key="x") == [])


# ------------------------------------------------------- 13. 从收获文档建网

digests = [
    {"book": "《置身事内》", "models": [
        {"name": "地方竞争", "what": "政府之间为增长互相竞争"},
        {"name": "周期对齐", "what": "评价周期与后果周期要对齐"},
    ], "connections": [{"name": "激励错配", "note": "同一件事的两种说法"}]},
    {"book": "《穷查理宝典》", "models": [
        {"name": "激励错配", "what": "激励设计决定行为"},
        {"name": "能力圈", "what": "只在自己懂的范围内行动"},
    ], "connections": [{"name": "长期主义", "note": "复利的另一种说法"}]},
]

nodes = kn.nodes_from_digests(digests)
names = {n["name"] for n in nodes}
check("模型 + 关联对象都抽成节点",
      names == {"地方竞争", "周期对齐", "激励错配", "能力圈", "长期主义"}, str(names))
inc = next(n for n in nodes if n["name"] == "激励错配")
check("同名模型跨书合并成一个节点", inc["books"] == ["《置身事内》", "《穷查理宝典》"], str(inc["books"]))

edges = kn.edges_from_models(digests)
check("connections 连成边", len(edges) >= 2, str(len(edges)))
check("边带来源书", all(e["books"] for e in edges))
check("每本书最多连 per_book 个模型做起点",
      len([e for e in edges if "《置身事内》" in e["books"]]) <= 3,
      str(len([e for e in edges if "《置身事内》" in e["books"]])))

net = kn.analyze(digests)
check("analyze 返回全量结构",
      all(k in net for k in ("nodes", "edges", "clusters", "hubs", "bridges", "support", "summary")))
check("summary 统计正确",
      net["summary"]["concepts"] == 5 and net["summary"]["books"] == 2, str(net["summary"]))
check("跨书概念被计入", net["summary"]["cross_book"] >= 1, str(net["summary"]["cross_book"]))
check("每个节点都有簇键", set(net["cluster_keys"]) == {n["concept_key"] for n in net["nodes"]})

# 成熟度分布（借自 mnemex 的 status lifecycle）
check("analyze 统计成熟度分布",
      all(k in net["summary"] for k in ("mature", "draft", "stub")), str(net["summary"]))
check("成熟度分布之和 = 概念数",
      net["summary"]["mature"] + net["summary"]["draft"] + net["summary"]["stub"] == net["summary"]["concepts"],
      str(net["summary"]))

# 两个孤岛 + 一个桥
bridged = kn.analyze([
    {"book": "A", "models": [{"name": "甲一"}, {"name": "甲二"}],
     "connections": [{"name": "枢纽概念"}]},
    {"book": "B", "models": [{"name": "乙一"}, {"name": "乙二"}],
     "connections": [{"name": "枢纽概念"}]},
])
check("分析能算出桥", len(bridged["bridges"]) >= 1, str(bridged["bridges"]))
check("桥的名字正确", any(b["name"] == "枢纽概念" for b in bridged["bridges"]),
      str([b["name"] for b in bridged["bridges"]]))

check("空输入不炸", kn.analyze([])["summary"]["concepts"] == 0)


# ------------------------------------------------------- 14. 合并（不猜，用户点）

m_nodes, m_edges = kn.apply_merges(
    [{"concept_key": "a", "name": "复利", "books": ["《A》"]},
     {"concept_key": "b", "name": "复利效应", "books": ["《B》"]}],
    [kn.make_edge("a", "x"), kn.make_edge("b", "y")],
    {"a": "b"},
)
check("合并后节点数变少", len(m_nodes) == 1, str(len(m_nodes)))
check("**书单被并起来**（否则「被几本书支持」就假了）", m_nodes[0]["books"] == ["《A》", "《B》"],
      str(m_nodes[0]["books"]))
check("指向被合并节点的边改指新节点",
      any(e["source"] == "b" for e in m_edges) and not any(e["source"] == "a" for e in m_edges),
      str([e["source"] for e in m_edges]))
check("合并产生的自环被丢弃",
      kn.apply_merges([{"concept_key": "a", "name": "A"}, {"concept_key": "b", "name": "B"}],
                      [kn.make_edge("a", "b")], {"a": "b"})[1] == [])
check("链式合并一路走到头",
      kn.apply_merges([{"concept_key": "a", "name": "A"}], [], {"a": "b", "b": "c"})[0][0]["concept_key"] == "c")
check("无合并时原样返回", len(kn.apply_merges([{"concept_key": "a", "name": "A"}], [], {})[0]) == 1)

check("簇键稳定", kn.cluster_key_for(["a", "b"]) == kn.cluster_key_for(["b", "a"]))
check("簇成员变了键就变", kn.cluster_key_for(["a", "b"]) != kn.cluster_key_for(["a", "b", "c"]))
check("空簇键为空", kn.cluster_key_for([]) == "")


# ------------------------------------------------------- 15. NetStore 持久化

import tempfile as _tf  # noqa: E402
from pathlib import Path as _Path  # noqa: E402

store = kn.NetStore(_Path(_tf.mkdtemp(prefix="ko-net-")) / "net.sqlite3")
counts = store.replace_graph("u1", net["nodes"], net["edges"])
check("整图落库", counts["nodes"] == len(net["nodes"]) and counts["edges"] == len(net["edges"]), str(counts))
check("节点读回", len(store.list_nodes("u1")) == len(net["nodes"]))
check("边读回", len(store.list_edges("u1")) == len(net["edges"]))
check("重写覆盖不叠加", store.replace_graph("u1", net["nodes"], net["edges"])["nodes"] == len(net["nodes"])
      and len(store.list_nodes("u1")) == len(net["nodes"]))
check("按 owner 隔离", store.list_nodes("u2") == [])

store.add_merge("u1", "a", "b")
check("合并落库", store.list_merges("u1") == {"a": "b"}, str(store.list_merges("u1")))
check("合并也按 owner 隔离", store.list_merges("u2") == {})
store.remove_merge("u1", "a")
check("合并可撤销", store.list_merges("u1") == {})
store.add_merge("u1", "a", "a")
check("自合并被忽略", store.list_merges("u1") == {})

saved = store.save_methodology("u1", cluster_key="cl_x", result=result, content_md=md,
                               anchor_key="c3", anchor_name="激励错配")
check("方法论落库", saved["title"] == "周期对齐检查" and saved["anchor_key"] == "c3")
check("方法论结构化留档可解析", saved["content"]["when_to_use"].startswith("评估任何考核"))
check("方法论按簇键去重更新",
      store.save_methodology("u1", cluster_key="cl_x", result={**result, "title": "改过"}, content_md="x")["title"] == "改过")
check("方法论列表", len(store.list_methodologies("u1")) == 1)
check("方法论按 owner 隔离", store.list_methodologies("u2") == [])


print("\n%d 项未通过" % len(FAILS) if FAILS else "\n全部通过")
sys.exit(1 if FAILS else 0)
