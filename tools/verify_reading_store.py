"""读书数据层回归（真实 SQLite + 真实 Database，不需要 key / 网络）。

跑法：``python tools/verify_reading_store.py``

覆盖两件必须自动化的行为 ——
  1. **按需建项目**（``ensure_project``）：幂等、不覆盖已有绑定、项目类型是 book
  2. **收获文档自动沉淀为知识卡片**：稳定 card_id、upsert 不重复、回收多余、
     绝不误伤用户手工建的卡、重新生成不丢 FSRS 排期（card_id 复用）
另外覆盖 ——
  3. 重复 upsert 书时不覆盖 project_id / progress / reading_status
  4. 正文可编辑，但结构化留档与指纹不动
  5. 「自测」小节标题在渲染层与同步层之间一致（防漂移断言）
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from core.database import Database  # noqa: E402
from core import reading_digest as rd  # noqa: E402
from core import reading_store as rs  # noqa: E402

FAILS = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


tmp = Path(tempfile.mkdtemp(prefix="ko-reading-"))
db = Database(tmp / "verify.sqlite3")
store = rs.ReadingStore(tmp / "verify.sqlite3")

user = db.create_user("u1@e.com", "U1", "fake-hash")
uid = user.user_id


# ------------------------------------------------- 1. book_key

k1 = rs.book_key_for("gutenberg", "1342")
k2 = rs.book_key_for("gutenberg", "1342")
k3 = rs.book_key_for("weread", "1342")
check("book_key 稳定", k1 == k2 and len(k1) == 24, k1)
check("同 id 不同源 → 不同 key", k1 != k3)
check("空输入 → 空 key", rs.book_key_for("", "") == "")


# ------------------------------------------------- 2. 书入库

record = {
    "source": "gutenberg", "source_id": "1342", "title": "Pride and Prejudice",
    "author": "Jane Austen", "cover": "https://c/cover.jpg", "category": "文学小说",
    "language": "en", "year": "1813", "detail_url": "https://g/1342",
    "download_url": "https://g/1342.epub", "has_fulltext": True,
    "fulltext_format": "epub", "rights": "public-domain",
}
book = store.upsert_book(uid, record)
check("书入库成功", bool(book) and book["title"] == "Pride and Prejudice", str(book.get("title")))
check("全文标记落库", book["has_fulltext"] == 1 and book["fulltext_format"] == "epub")
check("初始未绑定项目", book["project_id"] == "")

check("非法记录被拒", store.upsert_book(uid, {"source": "", "source_id": ""}) is None)


# ------------------------------------------------- 3. 按需建项目（ensure_project）

created = []


def make_project(title):
    p = db.create_book_project(uid, title)
    created.append(p.project_id)
    return p.project_id


pid = store.ensure_project(uid, k1, create_project=make_project)
check("ensure_project 建出项目并返回 id", bool(pid) and pid.startswith("book"), pid)
check("只建了一次", len(created) == 1, str(len(created)))
check("书已绑定项目", store.get_book(uid, k1)["project_id"] == pid)

again = store.ensure_project(uid, k1, create_project=make_project)
check("ensure_project 幂等（不重复建）", again == pid and len(created) == 1, str(len(created)))

proj = db.get_project(pid, uid)
check("项目类型是 book", proj.project_type == "book", proj.project_type)
check("项目名是书名", proj.subject == "Pride and Prejudice", proj.subject)
check("list_book_projects 找得到", pid in {p.project_id for p in db.list_book_projects(uid)})
check("课程项目不会被误列", len(db.list_book_projects(uid)) == 1)
check("未登记的书不建项目", store.ensure_project(uid, "deadbeef", create_project=make_project) == "")


# ------------------------------------------------- 4. 重复 upsert 不覆盖用户状态

store.update_progress(uid, k1, progress=45, status="reading")
store.upsert_book(uid, {**record, "title": "Pride and Prejudice (rev)"})
after = store.get_book(uid, k1)
check("重扫不覆盖 project_id", after["project_id"] == pid)
check("重扫不覆盖 progress", after["progress"] == 45, str(after["progress"]))
check("重扫不覆盖 reading_status", after["reading_status"] == "reading")
check("重扫更新标题", after["title"] == "Pride and Prejudice (rev)")


# ------------------------------------------------- 5. 文档读写

result = rd.normalize_digest_result({
    "thesis": "这本书讲的是地方政府的竞争逻辑。",
    "core_arguments": [{"point": "地方竞争是理解一切的起点", "support": "用案例说明", "where": "第三章"}],
    "models": [{"name": "地方竞争", "what": "政府之间为增长竞争", "how_to_use": "看政策先问它在跟谁竞争", "where": "第二章"}],
    "actions": ["看政策先找对标城市"],
    "quotes": [{"text": "这套结构既解释了增长，也解释了债务。", "where": "第三章"}],
    "self_check": [
        {"question": "为什么说债务是竞争机制的自然产物？", "answer": "举债建设＝用未来收入为当下竞争买单。"},
        {"question": "地方竞争这套框架怎么用到别的场景？", "answer": "任何政策先问它在跟谁竞争。"},
    ],
    "grounding": "来自第三章划线。",
})
md = rd.render_digest_markdown(result, title="置身事内", author="兰小欢")

doc = store.save_doc(owner_id=uid, book_key=k1, kind="digest", title="置身事内",
                     result=result, content_md=md, signature="sig-1", project_id=pid)
check("文档落库", bool(doc) and doc["kind"] == "digest")
check("结构化留档可解析", doc["content"].get("thesis") == result["thesis"])
check("正文落库", "读书收获" in doc["content_md"])

store.save_markdown(uid, k1, md + "\n\n手写补一句。")
edited = store.get_doc(uid, k1)
check("正文可编辑", edited["content_md"].endswith("手写补一句。"))
check("结构化留档未被改动", edited["content"].get("thesis") == result["thesis"])
check("指纹未被改动", edited["signature"] == "sig-1")

try:
    store.save_markdown(uid, k1, "   ")
    check("空正文被拒", False)
except ValueError:
    check("空正文被拒", True)

check("未知 kind 归到 digest", store.save_doc(owner_id=uid, book_key=k1, kind="乱写",
                                             title="x", result={}, content_md="y")["kind"] == "digest")


# ------------------------------------------------- 6. 自测小节标题一致性

check("渲染出的正文含「自测」小节", rd.sync_origin_section_exists(md))
check("常量与渲染标题逐字一致", rs.SYNC_ORIGIN_SECTION in md, rs.SYNC_ORIGIN_SECTION)


# ------------------------------------------------- 7. 卡片沉淀

cards = rs.build_sync_cards(result, book_key=k1, source_ids=["src_1"])
check("抽出 2 张卡", len(cards) == 2, str(len(cards)))
check("卡片带前缀", all(c["card_id"].startswith(rs.SYNC_CARD_PREFIX) for c in cards))
check("卡片分类正确", all(c["category"] == rs.SYNC_CATEGORY for c in cards))
check("卡片带出处小节", all(c["origin_section"] == rs.SYNC_ORIGIN_SECTION for c in cards))

same = rs.build_sync_cards(result, book_key=k1)
check("card_id 稳定（重生成不换卡）", [c["card_id"] for c in cards] == [c["card_id"] for c in same])

dup = rs.build_sync_cards({"self_check": [
    {"question": "同一题", "answer": "a"}, {"question": "同一题", "answer": "b"},
    {"question": "第二题", "answer": "c"},
]}, book_key=k1)
check("重复题面只留一张", len(dup) == 2, str(len(dup)))

capped = rs.build_sync_cards({"self_check": [
    {"question": f"题{i}", "answer": "答案"} for i in range(10)]}, book_key=k1)
check("卡片数封顶", len(capped) == rs.SYNC_MAX_CARDS, str(len(capped)))
check("缺答案的不收", rs.build_sync_cards({"self_check": [{"question": "只有题"}]}, book_key=k1) == [])

first = rs.sync_cards(db, pid, wanted=cards)
check("沉淀 2 张卡", first["synced"] == 2 and first["removed"] == 0, str(first))
check("卡片真的进了库", len(db.list_cards(pid)) == 2, str(len(db.list_cards(pid))))

# 用户手工建的卡（无前缀）不能被回收
db.add_cards(pid, [__import__("core.models", fromlist=["Card"]).Card(
    front="我自己加的卡", back="答案", category="概念")])
before = len(db.list_cards(pid))
again_sync = rs.sync_cards(db, pid, wanted=cards)
check("重复沉淀不新增", again_sync["synced"] == 2 and len(db.list_cards(pid)) == before, str(again_sync))
check("手工卡没被回收", any(c.front == "我自己加的卡" for c in db.list_cards(pid)))

# 模型这次少写了一道题 → 回收多余的回流卡，但不动手工卡
fewer = rs.sync_cards(db, pid, wanted=cards[:1])
check("回收多余的回流卡", fewer["removed"] == 1, str(fewer))
remaining = db.list_cards(pid)
check("回流卡剩 1 张", len([c for c in remaining if c.card_id.startswith(rs.SYNC_CARD_PREFIX)]) == 1)
check("手工卡仍在", any(c.front == "我自己加的卡" for c in remaining))

empty = rs.sync_cards(db, pid, wanted=[])
check("全部清空时回流卡被回收干净",
      len([c for c in db.list_cards(pid) if c.card_id.startswith(rs.SYNC_CARD_PREFIX)]) == 0)
check("清空也不动手工卡", any(c.front == "我自己加的卡" for c in db.list_cards(pid)))


print("\n%d 项未通过" % len(FAILS) if FAILS else "\n全部通过")
sys.exit(1 if FAILS else 0)
