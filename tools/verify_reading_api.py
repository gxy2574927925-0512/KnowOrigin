"""读书功能 API 回归（TestClient + 脚本化模型 + 注入假搜索，不需要 key / 网络）。

跑法：``python tools/verify_reading_api.py``

覆盖端到端两件自动化 ——
  1. 加入书架 → 只存元数据（**不建项目**）；显式 with_project 或真放资料时才按需建
  2. 生成《读书收获》→ **自测题自动沉淀为知识卡片**（前缀 rd_），且手工卡不受影响
另外覆盖 ——
  3. 书源清单暴露能力与版权状态
  4. 跨书源搜索：单源失败不打断整轮
  5. 正文可编辑，结构化留档不动
  6. 越权 / 非法输入的错误码
"""
import json
import sys
import tempfile
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from fastapi.testclient import TestClient  # noqa: E402

import api_server  # noqa: E402
from api_server import create_app  # noqa: E402
from config import Settings  # noqa: E402
from core.database import Database  # noqa: E402
from core.llm import LlmClient  # noqa: E402
from core.models import Card, SourceCreate  # noqa: E402

FAILS = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


class FakeLlm(LlmClient):
    def __init__(self, settings):
        super().__init__(settings, responder=None)
        # 记下每次流式调用：陪读讨论的**口径**（system prompt）与**采样温度**是产品契约，
        # 得能断言，不能只验「有返回」。
        self.stream_calls = []

    def complete_json(self, task, payload):
        if task == "make_methodology":
            return {
                "title": "激励对齐检查",
                "one_liner": "先看激励把行为推向哪里，再判断制度会不会失效。",
                "premise": "适用于任何靠考核驱动的组织。",
                "steps": [
                    {"name": "找出评价指标", "what": "问清楚这个位置按什么被评价", "why": "指标决定行为"},
                    {"name": "找出实际激励", "what": "问清楚做与不做各有什么后果", "why": "错配就藏在这里"},
                ],
                "when_to_use": "评估任何考核机制时",
                "when_not_to_use": "后果无法归因到具体人时",
                "counter_example": "把长期目标硬塞进季度考核",
                "source_concepts": ["激励错配"],
                "confidence_note": "被两本书支持。",
            }
        if task == "make_book_intro":
            # 检视阅读：必须给出「值不值得读 / 用哪档力气读 / 先读哪几章」。
            return {
                "one_liner": "一本讲地方政府如何介入经济的书",
                "intro": "本书从地方政府的角度解释中国经济的运行逻辑，涵盖土地财政与债务。",
                "verdict": "想理解房价与地方债的来龙去脉就值得读；只看宏观趋势的可以跳过。",
                "read_mode": "选读",
                "key_chapters": ["第二章 财税与土地", "第五章 债务"],
                "topics": ["经济", "政府"],
                "level": "进阶",
                "use_case": "看到一条地方政策想弄懂它为什么这么做时",
                "category": "经济管理",
            }
        if task == "make_reading_digest":
            # 按书名给不同的模型与关联 —— 这样两本书之间才会长出一个「桥」。
            title = str((payload.get("book") or {}).get("title") or "")
            if title == "坏书":
                raise RuntimeError("模拟模型超时")
            if title == "置身事内":
                return {
                    "thesis": "地方政府为增长而展开的竞争，是理解中国经济的一把钥匙。",
                    "chapters": [], "core_arguments": [], "insights": [], "quotes": [],
                    "connections": [{"name": "激励错配", "note": "制度设计与个人决策的共同底层"}],
                    "models": [
                        {"name": "地方竞争", "what": "政府之间为增长互相竞争", "how_to_use": "看政策先找对标城市", "where": "第二章"},
                        {"name": "周期对齐", "what": "评价周期要与后果周期对齐", "how_to_use": "评估考核机制时先对齐周期", "where": "第三章"},
                    ],
                    "actions": ["看政策先找对标城市"],
                    "self_check": [{"question": "为什么制度比技术更关键？", "answer": "制度决定技术能否被用起来。"},
                                   {"question": "周期错配会导致什么后果？", "answer": "系统性鼓励短视行为。"}],
                    "grounding": "来自第三章划线。",
                }
            if title == "穷查理宝典":
                return {
                    "thesis": "用多元思维模型做决策，避免手里只有一把锤子。",
                    "chapters": [], "core_arguments": [], "insights": [], "quotes": [],
                    "connections": [{"name": "激励错配", "note": "激励设计决定行为"}],
                    "models": [
                        {"name": "复利效应", "what": "长期累积带来非线性增长", "how_to_use": "把时间当作变量而不是常量", "where": "第一章"},
                        {"name": "能力圈", "what": "只在自己懂的范围内行动", "how_to_use": "决策前先划出边界", "where": "第二章"},
                    ],
                    "actions": ["划出自己的能力圈边界"],
                    "self_check": [{"question": "能力圈为什么能降低风险？", "answer": "因为你只在可判断的范围内下注。"},
                                   {"question": "复利为什么需要耐心？", "answer": "前期增长缓慢，容易被误判为无效。"}],
                    "grounding": "来自第二章划线。",
                }
            return {
                "thesis": "这本书讲的是地方政府为增长而竞争的逻辑。",
                "core_arguments": [{"point": "地方竞争是理解一切的起点", "support": "用案例说明", "where": "第三章"}],
                "models": [{"name": "地方竞争", "what": "政府之间为增长互相竞争",
                            "how_to_use": "看任何地方政策时先问它在跟谁竞争", "where": "第二章"}],
                "insights": [],
                "actions": ["看一条地方政策时，先找出它的对标城市"],
                "quotes": [{"text": "这套结构既解释了增长，也解释了债务。", "where": "第三章"}],
                "connections": [],
                "self_check": [
                    {"question": "为什么说债务是竞争机制的自然产物？", "answer": "举债建设＝用未来收入为当下竞争买单。"},
                    {"question": "地方竞争这套框架怎么用到别的场景？", "answer": "任何政策先问它在跟谁竞争。"},
                ],
                "grounding": "来自第三章划线。",
            }
        return {}

    async def astream_chat_content(self, messages, task, **kwargs):
        self.stream_calls.append({"task": task, "messages": messages, "kwargs": kwargs})
        yield "（fake）"


def fake_search(query, *, source_ids=None, limit_per_source=8, fetch=None):
    """注入的假搜索：古腾堡「挂了」，OpenLibrary 正常 —— 验证单源失败隔离。"""
    return {
        "query": query,
        "results": [
            {"source": "openlibrary", "source_name": "Open Library", "source_id": "OL1W",
             "title": "置身事内", "author": "兰小欢", "cover": "https://c/1.jpg",
             "category": "经济管理", "has_fulltext": False, "rights": "unknown",
             "detail_url": "https://openlibrary.org/works/OL1W"},
            {"source": "gutenberg", "source_name": "古腾堡计划", "source_id": "1342",
             "title": "Pride and Prejudice", "author": "Jane Austen", "cover": "",
             "category": "文学小说", "has_fulltext": True, "fulltext_format": "epub",
             "rights": "public-domain", "detail_url": "https://g/1342",
             "download_url": "https://g/1342.epub"},
        ],
        "sources": {"gutenberg": 0, "openlibrary": 1},
        "source_status": {
            "gutenberg": {"count": 0, "ok": False, "error": "RuntimeError: 网络炸了"},
            "openlibrary": {"count": 1, "ok": True, "error": ""},
        },
        "all_failed": False,
    }


def main():
    tmp = Path(tempfile.mkdtemp(prefix="ko-reading-api-"))
    settings = Settings(
        tju_api_key="tk-verify-placeholder",
        tju_base_url="https://example.invalid/api",
        tju_model="tju-llm",
        data_dir=tmp,
        usage_tracking_enabled=False,
    )
    db = Database(tmp / "verify.sqlite3")
    fake = FakeLlm(settings)
    app = create_app(db, settings, fake)
    client = TestClient(app)

    api_server.book_sources_mod.search_books = fake_search

    client.post("/api/auth/register", json={"email": "a@e.com", "password": "abcd1234", "name": "A"})

    # 1) 书源清单
    r = client.get("/api/reading/sources")
    check("书源清单 200", r.status_code == 200, str(r.status_code))
    sources = {s["id"]: s for s in r.json()["sources"]}
    check("微信读书标注为无全文", sources["weread"]["has_fulltext"] is False)
    check("古腾堡标注为有全文", sources["gutenberg"]["has_fulltext"] is True)
    check("豆瓣已升级为可搜索的元数据源", sources["douban"]["kind"] == "metadata")

    # 2) 跨书源搜索
    r = client.post("/api/reading/search", json={"query": "经济"})
    check("搜索 200", r.status_code == 200, str(r.status_code))
    body = r.json()
    check("搜索返回 2 条", len(body["results"]) == 2, str(len(body["results"])))
    check("单源失败被隔离", body["sources"]["gutenberg"] == 0)
    check("按领域分组", any(g["category"] == "经济管理" for g in body["groups"]))
    check("全文统计正确（含「有文件链接」档）",
          body["summary"] == {"total": 2, "fulltext": 1, "with_links": 0, "metadata_only": 1},
          str(body["summary"]))
    check("书源可达状态被透传", body["source_status"]["gutenberg"]["ok"] is False
          and body["source_status"]["openlibrary"]["ok"] is True, str(body.get("source_status")))
    # 代理状态因机器而异（有人本机就开着 HTTPS_PROXY），所以断言跟着状态分支走，
    # 而不是假定「一定没配代理」——否则这条门禁在配了代理的机器上会误报。
    if body["proxy_in_use"]:
        check("配了代理时 blocked_sources 为空", body["blocked_sources"] == [],
              str(body.get("blocked_sources")))
    else:
        check("未配代理时海外源被列进 blocked_sources（前端据此提示）",
              "gutenberg" in body["blocked_sources"] and "douban" not in body["blocked_sources"],
              str(body.get("blocked_sources")))
    check("搜索响应带代理状态", "proxy_in_use" in body, str(list(body)))
    check("all_failed 被透传", body["all_failed"] is False)
    r = client.post("/api/reading/search", json={"query": "  "})
    check("空查询 400", r.status_code == 400, str(r.status_code))

    # 3) 加入书架 → 默认不建项目（有资料才按需建）
    book = body["results"][0]
    r = client.post("/api/reading/books", json={"book": book})
    check("加入书架 201", r.status_code == 201, str(r.status_code) + " " + r.text[:120])
    added = r.json()
    key = added["book"]["book_key"]
    check("加入书架不建项目", not added["project_id"], str(added["project_id"]))

    # 显式 with_project 时才建（本地导入 / 导入正文走这条）
    r = client.post("/api/reading/books", json={"book": book, "with_project": True})
    pid = r.json()["project_id"]
    check("显式要求才建项目", bool(pid) and pid.startswith("book"), pid)
    check("项目类型是 book", db.get_project(pid).project_type == "book")
    check("项目名是书名", db.get_project(pid).subject == "置身事内")

    r = client.post("/api/reading/books", json={"book": book, "with_project": True})
    check("重复加入复用同一项目", r.json()["project_id"] == pid)
    check("非法书 400", client.post("/api/reading/books", json={"book": {"title": ""}}).status_code == 400)

    # 4) 书架
    r = client.get("/api/reading/books")
    check("书架 200", r.status_code == 200)
    shelf = r.json()
    check("书架有 1 本", len(shelf["books"]) == 1, str(len(shelf["books"])))
    check("书架统计正确", shelf["summary"]["total"] == 1 and shelf["summary"]["fulltext"] == 0,
          str(shelf["summary"]))
    check("按领域分组", shelf["groups"][0]["category"] == "经济管理")

    # 5) 生成收获 → 自动沉淀卡片
    r = client.post(f"/api/reading/books/{key}/digest", json={
        "highlights": [{"mark_text": "这套结构既解释了增长，也解释了债务。", "chapter_name": "第三章"}],
        "thoughts": [{"text": "这句话点醒了我"}],
    })
    check("生成收获 200", r.status_code == 200, str(r.status_code) + " " + r.text[:160])
    digest = r.json()
    check("不是兜底", digest["fallback"] is False, str(digest.get("fallback")))
    check("正文含收获标题", "读书收获" in digest["doc"]["content_md"])
    check("结构化留档可解析", digest["doc"]["content"]["thesis"].startswith("地方政府为增长而展开的竞争"))
    check("沉淀了 2 张卡", digest["cards"]["synced"] == 2, str(digest["cards"]))

    r = client.get(f"/api/reading/books/{key}/cards")
    cards = r.json()["cards"]
    check("卡片接口返回 2 张", len(cards) == 2, str(len(cards)))
    check("卡片带前缀", all(c["card_id"].startswith("rd_") for c in cards))
    check("卡片进了项目", len(db.list_cards(pid)) == 2)

    # 用户手工建卡不受影响
    from core.models import Card
    db.add_cards(pid, [Card(front="我自己加的卡", back="答案")])
    r = client.post(f"/api/reading/books/{key}/digest", json={
        "highlights": [{"mark_text": "这套结构既解释了增长，也解释了债务。", "chapter_name": "第三章"}],
    })
    check("重复生成不新增卡", r.json()["cards"]["synced"] == 2)
    check("手工卡没被回收", any(c.front == "我自己加的卡" for c in db.list_cards(pid)))

    # 6) 正文编辑
    md = digest["doc"]["content_md"]
    r = client.put(f"/api/reading/books/{key}/doc", json={"content_md": md + "\n\n手写补一句。", "kind": "digest"})
    check("保存正文 200", r.status_code == 200, str(r.status_code) + " " + r.text[:120])
    got = client.get(f"/api/reading/books/{key}").json()["digest"]
    check("正文改动落库", got["content_md"].endswith("手写补一句。"))
    check("结构化留档未被改", got["content"]["thesis"].startswith("地方政府为增长而展开的竞争"))
    check("空正文 400", client.put(f"/api/reading/books/{key}/doc", json={"content_md": "  "}).status_code == 400)

    # 7) 知识网络：两本书 → 一个「桥」
    second = client.post("/api/reading/books", json={"book": {
        "source": "weread", "source_id": "b2", "title": "穷查理宝典", "author": "芒格",
        "category": "经济理财-理财", "rights": "licensed", "has_fulltext": False,
    }}).json()
    key2 = second["book"]["book_key"]
    # ⚠️ 必须给材料：材料全空时后端**刻意不调模型**（免得拿通识编一篇假收获），
    # 那样这本书就进不了网络，桥也就长不出来。
    client.post(f"/api/reading/books/{key2}/digest", json={
        "highlights": [{"mark_text": "手里只有一把锤子，看什么都像钉子。", "chapter_name": "第一章"}],
    })

    net = client.get("/api/reading/net").json()
    check("网络接口 200", "nodes" in net and "bridges" in net, str(list(net.keys()))[:80])
    check("两本书的模型都进了网", net["summary"]["concepts"] >= 5, str(net["summary"]))
    check("识别出跨书概念", net["summary"]["cross_book"] >= 1, str(net["summary"]))
    bridge_names = [b["name"] for b in net["bridges"]]
    check("识别出「桥」", "激励错配" in bridge_names, str(bridge_names))
    check("桥带 clusters_joined", all(b["clusters_joined"] >= 1 for b in net["bridges"]))
    check("桥有稳定簇键", all(b["concept_key"] in net["cluster_keys"] for b in net["bridges"]))
    check("跨书概念被标为已交叉验证",
          any(s["verified"] and s["name"] == "激励错配" for s in net["support"]),
          str([(s["name"], s["book_count"]) for s in net["support"]][:6]))

    # 合并候选：只给候选，不自动合并
    cands = client.get("/api/reading/net/candidates").json()["candidates"]
    check("候选接口可用", isinstance(cands, list))
    check("候选一律 needs_confirmation",
          all(c["needs_confirmation"] for c in cands))

    # 8) 就着桥生成方法论
    anchor = next(b["concept_key"] for b in net["bridges"] if b["name"] == "激励错配")
    r = client.post("/api/reading/net/methodology", json={"anchor_key": anchor})
    check("生成方法论 200", r.status_code == 200, str(r.status_code) + " " + r.text[:140])
    meth = r.json()
    check("方法论不是兜底", meth["fallback"] is False)
    check("方法论标题落库", meth["methodology"]["title"] == "激励对齐检查")
    check("方法论正文含步骤", "## 怎么做" in meth["methodology"]["content_md"])
    check("簇里含桥本身", any(c["name"] == "激励错配" for c in meth["cluster"]))
    check("沉淀了技能卡", meth["cards"]["synced"] >= 1, str(meth["cards"]))

    r = client.post("/api/reading/net/methodology", json={"anchor_key": "不存在"})
    check("不存在的锚点 404", r.status_code == 404, str(r.status_code))
    check("缺锚点 400", client.post("/api/reading/net/methodology", json={}).status_code == 400)

    # 合并：确认后两键归一
    if len(net["nodes"]) >= 2:
        a, b = net["nodes"][0]["concept_key"], net["nodes"][1]["concept_key"]
        merged = client.post("/api/reading/net/merge", json={"from_key": a, "to_key": b}).json()
        check("合并后节点数减少", merged["summary"]["concepts"] == net["summary"]["concepts"] - 1,
              str(merged["summary"]["concepts"]))
        check("合并自键被拒 400",
              client.post("/api/reading/net/merge", json={"from_key": a, "to_key": a}).status_code == 400)
        undone = client.delete(f"/api/reading/net/merge/{a}").json()
        check("合并可撤销", undone["summary"]["concepts"] == net["summary"]["concepts"])

    check("方法论列表可读", len(client.get("/api/reading/net").json()["methodologies"]) >= 1)

    # 9) 一键补全收获（批量）
    #    ⚠️ 这两本要**先有材料**：材料全空时后端刻意不调模型，直接给「材料不足」。
    #    这里给它们各挂一份正文，模拟「本地导入的书」—— 也正是用户能拿到真全文的那条路。
    for title, sid in (("待补全书", "b9"), ("坏书", "b10")):
        # 模拟「本地导入」：要放正文，所以显式 with_project 把项目建出来。
        added = client.post("/api/reading/books", json={"book": {
            "source": "local", "source_id": sid, "title": title,
            "rights": "user-provided", "has_fulltext": True, "fulltext_format": "txt",
        }, "with_project": True}).json()
        db.add_source(added["project_id"], SourceCreate(
            filename=f"{title}.txt",
            text="第一章 起点\n" + "这是一段用于生成收获的正文内容，讲清了作者的主张与论证。" * 12,
        ))
    before = len(client.get("/api/reading/books").json()["books"])
    check("书架共 4 本", before == 4, str(before))

    r = client.post("/api/reading/digests/generate-missing", json={})
    check("批量生成 200", r.status_code == 200, str(r.status_code) + " " + r.text[:140])
    batch = r.json()
    check("只给没收获的书生成（两本）", batch["generated"] == 2, str(batch))
    check("errors 为空 —— 模型失败会退化成兜底，而不是变成失败",
          batch["failed"] == 0 and batch["errors"] == [], str(batch.get("errors")))
    by_title = {b["title"]: b for b in batch["books"]}
    check("模型正常的书不是兜底且沉淀了卡片",
          by_title["待补全书"]["fallback"] is False and by_title["待补全书"]["cards"] >= 1,
          str(by_title.get("待补全书")))
    check("模型挂掉的书退化成兜底（**仍然有产出**）",
          by_title["坏书"]["fallback"] is True, str(by_title.get("坏书")))

    again = client.post("/api/reading/digests/generate-missing", json={}).json()
    check("已生成的不重复跑", again["generated"] == 0, str(again))

    check("limit 生效",
          client.post("/api/reading/digests/generate-missing", json={"limit": 1}).status_code == 200)
    check("limit 越界被夹取不报错",
          client.post("/api/reading/digests/generate-missing", json={"limit": 999}).status_code == 200)

    # 补全后网络里应该多出节点
    net2 = client.get("/api/reading/net").json()
    check("补全后网络概念数不减少", net2["summary"]["concepts"] >= net["summary"]["concepts"])

    # 9.5) 材料全空 → **不调模型**，如实说「材料不足」，绝不拿通识编一篇假收获。
    #      这是「AI 收获无效信息太多」的根因修复，必须锁住。
    empty = client.post("/api/reading/books", json={"book": {
        "source": "douban", "source_id": "b11", "title": "空材料书", "rights": "unknown",
    }}).json()
    r = client.post(f"/api/reading/books/{empty['book']['book_key']}/digest", json={}).json()
    check("材料全空 → insufficient 标记", r["insufficient"] is True, str(r.get("insufficient")))
    check("材料全空 → 不判为兜底（不是模型挂了）", r["fallback"] is False, str(r.get("fallback")))
    check("材料全空 → 如实说明，不编内容",
          "可用于归纳的材料" in r["doc"]["content_md"], r["doc"]["content_md"][:120])
    check("材料全空 → 不沉淀任何卡片", (r["cards"] or {}).get("synced") == 0, str(r.get("cards")))

    # 9.6) 检视阅读：《如何阅读一本书》的第二层 —— 值不值得读 / 怎么读 / 先读哪几章
    r = client.post(f"/api/reading/books/{key}/intro", json={})
    check("生成检视 200", r.status_code == 200, str(r.status_code) + " " + r.text[:160])
    intro = r.json()
    check("检视不是兜底", intro["fallback"] is False, str(intro.get("fallback")))
    intro_md = intro["doc"]["content_md"]
    check("检视给出 read_mode", "建议读法" in intro_md, intro_md[:120])
    check("检视给出 verdict", "检视结论" in intro_md, intro_md[:120])
    check("检视结构化留档含 read_mode",
          intro["doc"]["content"]["read_mode"] in ("精读", "选读", "泛读", "略过"),
          str(intro["doc"]["content"].get("read_mode")))
    check("检视不动收获文档",
          client.get(f"/api/reading/books/{key}").json()["digest"]["content_md"].endswith("手写补一句。"))

    # 10) 划词陪读讨论：默认就是**发散档**（2026-10-08 口径变更）
    #     读者的要求是「不要只围着材料打转，越发散越好」，所以这条契约有两半：
    #     ① system prompt 写死「先贴书、再发散 + 书外延伸自报家门」；② 采样温度高一档。
    before_ask = len(fake.stream_calls)
    r = client.post(f"/api/reading/books/{key}/ask", json={
        "question": "这段让我想到什么？",
        "selection": "这套结构既解释了增长，也解释了债务。",
        "context": "第三章：这套结构既解释了增长，也解释了债务。地方竞争把未来的收入提前用掉。",
    })
    check("陪读讨论 200", r.status_code == 200, str(r.status_code))
    check("陪读讨论走 SSE 流", r.text.startswith("data:"), r.text[:60])
    check("流里带 done 事件", '"done"' in r.text, r.text[:120])
    ask_call = fake.stream_calls[before_ask] if len(fake.stream_calls) > before_ask else {}
    sys_prompt = ((ask_call.get("messages") or [{}])[0] or {}).get("content", "")
    check("讨论走 reading_ask 任务", ask_call.get("task") == "reading_ask", str(ask_call.get("task")))
    check("人设是「陪读讨论伙伴」而非只读材料", "陪读讨论伙伴" in sys_prompt, sys_prompt[:40])
    check("默认发散：写死「越发散越好」", "越发散越好" in sys_prompt)
    check("要求铺多个互不相同的方向", "3 个互不相同" in sys_prompt)
    check("书外延伸必须自报家门（不许冒充书里内容）", "书外延伸" in sys_prompt)
    check("采样温度高一档（0.8）",
          (ask_call.get("kwargs") or {}).get("temperature") == 0.8, str(ask_call.get("kwargs")))
    check("选区与上下文进了发给模型的 payload",
          "这套结构既解释了增长" in json.dumps(ask_call.get("messages") or [], ensure_ascii=False))

    # 材料全空（既没选区、也无收获/正文可退）→ 422 早退，绝不凭印象编一段。
    bare = client.post("/api/reading/books", json={"book": {
        "source": "douban", "source_id": "b12", "title": "无材料讨论书", "rights": "unknown",
    }}).json()
    r = client.post(f"/api/reading/books/{bare['book']['book_key']}/ask",
                    json={"question": "这段在说什么"})
    check("无材料 → 422 早退（不凭空编）", r.status_code == 422, str(r.status_code))
    check("缺问题 400",
          client.post(f"/api/reading/books/{key}/ask", json={"selection": "x"}).status_code == 400)

    # 11) 自动取正文 + 找文件链接（本轮新增：把「公版书全文」真正接进阅读链路）
    #
    #     fetch_fulltext / find_file_links 都靠网络，测试里一律注入假实现 ——
    #     门禁不该因为「今天某个海外站连不上」而变红。
    se_book = client.post("/api/reading/books", json={"book": {
        "source": "standardebooks", "source_id": "jane-austen/pride-and-prejudice",
        "title": "Pride and Prejudice", "author": "Jane Austen",
        "rights": "public-domain", "has_fulltext": True, "fulltext_format": "text",
        "download_url": "https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice/text/single-page",
        "files": [{"format": "epub", "url": "https://se/x.epub", "label": "下载 EPUB"}],
        "read_url": "https://se/read",
    }}).json()
    se_key = se_book["book"]["book_key"]
    check("书架存下了 files 文件链接（老库升级后也能读回来）",
          se_book["book"]["files"][0]["url"] == "https://se/x.epub", str(se_book["book"].get("files")))
    check("书架存下了 read_url", se_book["book"]["read_url"] == "https://se/read")

    _orig_fetch = api_server.book_sources_mod.fetch_fulltext
    _orig_links = api_server.book_sources_mod.find_file_links
    _long_text = "Chapter I\n" + "这是一段用于验证自动取正文的正文内容，需要足够长才能通过入库门槛。" * 12

    api_server.book_sources_mod.fetch_fulltext = lambda record, **kw: {
        "ok": True, "text": _long_text, "reason": "", "format": "text",
        "chapters": [{"title": "I", "excerpt": _long_text}],
    }
    r = client.post(f"/api/reading/books/{se_key}/fulltext/fetch", json={})
    check("自动取正文 200", r.status_code == 200, str(r.status_code) + " " + r.text[:160])
    body = r.json()
    check("取回字数被报出", body["chars"] == len(_long_text), str(body.get("chars")))
    check("结构化章节数被报出", body["chapters"] == 1, str(body.get("chapters")))
    check("书被标成有全文", body["book"]["has_fulltext"] == 1, str(body["book"].get("has_fulltext")))
    # 取正文后，阅读页应当从「只有元数据」切成真全文（正文真的进了项目）
    outline = client.get(f"/api/reading/books/{se_key}/outline").json()
    check("阅读页切成 fulltext（正文已入库）", outline["kind"] == "fulltext", str(outline.get("kind")))
    check("项目里确实躺着刚抓回来的正文",
          any("Pride and Prejudice" in (s.get("filename") or "") for s in outline.get("sources") or []),
          str([s.get("filename") for s in outline.get("sources") or []]))

    # 版权书必须被拒，且原因是给用户看的
    api_server.book_sources_mod.fetch_fulltext = lambda record, **kw: {
        "ok": False, "text": "", "reason": "该书源不提供全文（有版权或仅元数据），请在原平台阅读。",
        "format": "", "chapters": [],
    }
    denied = client.post(f"/api/reading/books/{se_key}/fulltext/fetch", json={})
    check("版权书取正文被拒 400", denied.status_code == 400, str(denied.status_code))
    check("拒绝原因透传给用户（不是含糊的失败）",
          "版权" in denied.json()["detail"]["message"], str(denied.json())[:160])

    api_server.book_sources_mod.fetch_fulltext = lambda record, **kw: {
        "ok": True, "text": "太短", "reason": "", "format": "txt", "chapters": [],
    }
    short = client.post(f"/api/reading/books/{se_key}/fulltext/fetch", json={})
    check("抓到过短的正文不入库（防脏数据）", short.status_code == 400, str(short.status_code))
    api_server.book_sources_mod.fetch_fulltext = _orig_fetch

    api_server.book_sources_mod.find_file_links = lambda record, **kw: {
        "ok": True,
        "links": [{"label": "HathiTrust 阅读", "url": "https://babel/1", "format": "read",
                   "note": "公版，可全文阅读", "rights_code": "PD"}],
        "reason": "", "checked": ["hathitrust"],
    }
    links = client.post("/api/reading/links", json={"book_key": se_key}).json()
    check("找文件链接 200 且回链接", links["ok"] is True and links["links"][0]["url"] == "https://babel/1",
          str(links))
    check("找文件链接带回代理状态", "proxy_in_use" in links, str(list(links)))
    check("找文件链接缺书 400", client.post("/api/reading/links", json={}).status_code == 400)

    api_server.book_sources_mod.find_file_links = lambda record, **kw: {
        "ok": False, "links": [], "reason": "Open Library 未返回数据（若在国内网络，需要配置代理）",
        "checked": ["openlibrary"],
    }
    none_links = client.post("/api/reading/links", json={"title": "某本查不到入口的书"}).json()
    check("找不到入口时如实说明并提代理", none_links["ok"] is False and "代理" in none_links["reason"],
          none_links["reason"])
    api_server.book_sources_mod.find_file_links = _orig_links

    # 12) 错误路径
    check("不存在的书 404", client.get("/api/reading/books/deadbeef").status_code == 404)
    check("不存在的书生成检视 404",
          client.post("/api/reading/books/deadbeef/intro", json={}).status_code == 404)
    check("不存在的书生成 404",
          client.post("/api/reading/books/deadbeef/digest", json={}).status_code == 404)

    print("\n%d 项未通过" % len(FAILS) if FAILS else "\n全部通过")
    sys.exit(1 if FAILS else 0)


main()
