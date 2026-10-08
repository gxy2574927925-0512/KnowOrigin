"""微信读书适配层回归（注入假 transport，不需要真 Key / 网络）。

跑法：``python tools/verify_weread.py``

覆盖 ——
  1. 归一化：微信读书的书 → 书架记录；**has_fulltext 恒为 False**（版权红线）
  2. 书架口径：总数 = books + albums + (mp 非空 ? 1 : 0)；有声书不进书架卡片
  3. 进度：progress 是 0-100 整数（1 表示 1%）；时长单位是秒
  4. 划线/想法抽取：章节名回填、空内容丢弃
  5. 笔记本口径：noteCount 是划线数，总笔记数 = review + note + bookmark
  6. 客户端：请求体参数**平铺**（不包 params）、errcode != 0 抛错、
     upgrade_info 必须中断、未配置 Key 时抛错
  7. API：未配置 Key → 503；Key 格式校验；**响应绝不回显 Key**；
     同步 → 只入书架（**不建项目**，避免几百本空项目塞满侧栏）
"""
import os
import sys
import tempfile
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from core import weread as wr  # noqa: E402

FAILS = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


# ------------------------------------------------------- 1. 归一化

item = {
    "bookId": "3300054214",
    "deepLink": "https://weread.qq.com/book-detail?type=1&v=abc",
    "title": "一本书读懂30部经济学经典",
    "author": "郭泽德 宋义平 关佳佳",
    "cover": "https://cdn.weread.qq.com/cover/1.jpg",
    "category": "经济理财-财经",
    "finishReading": 0,
    "readUpdateTime": 1772183179,
    "secret": 1,
    "updateTime": 1680249757,
}
rec = wr.to_book_record(item)
check("归一化成功", rec is not None and rec["title"] == "一本书读懂30部经济学经典")
check("source=weread", rec["source"] == "weread" and rec["source_id"] == "3300054214")
check("has_fulltext 恒为 False（版权红线）", rec["has_fulltext"] is False, str(rec["has_fulltext"]))
check("rights=licensed", rec["rights"] == "licensed")
check("原生分类只当线索 → 归到一级领域", rec["category"] == "经济管理", rec["category"])
check("deepLink 落成 detail_url", rec["detail_url"].startswith("https://weread.qq.com"))
check("封面落位", rec["cover"].endswith("1.jpg"))
check("私密标记", rec["secret"] == 1)
check("最近阅读时间落位", rec["read_update_time"] == 1772183179)
check("缺 bookId 被丢弃", wr.to_book_record({"title": "无 id"}) is None)
check("缺 title 被丢弃", wr.to_book_record({"bookId": "1"}) is None)


# ------------------------------------------------------- 2. 书架口径

shelf = {
    "books": [item, {"bookId": "2", "title": "乡土中国", "category": "文学-文学"}],
    "albums": [{"albumInfo": {"albumId": "a1"}}],
    "mp": {"show": 1},
}
records = wr.shelf_records(shelf)
check("只收 books，不收有声书", len(records) == 2, str(len(records)))
check("有声书不进书架卡片", all(r["source_id"] != "a1" for r in records))
counts = wr.shelf_counts(shelf)
check("书架总数 = books + albums + (mp?1:0)", counts == {"books": 2, "albums": 1, "articles": 1, "total": 4},
      str(counts))
check("空回包不炸", wr.shelf_counts({}) == {"books": 0, "albums": 0, "articles": 0, "total": 0})
check("非 dict 不炸", wr.shelf_records("x") == [])


# ------------------------------------------------------- 3. 进度

prog = wr.progress_from_payload({"book": {"progress": 1, "recordReadingTime": 3600, "updateTime": 123}})
check("progress=1 表示 1%（不是 100%）", prog["progress"] == 1, str(prog["progress"]))
check("时长单位是秒", prog["seconds"] == 3600)
check("超范围被夹取", wr.progress_from_payload({"book": {"progress": 150}})["progress"] == 100)
check("空回包给 0", wr.progress_from_payload({})["progress"] == 0)


# ------------------------------------------------------- 4. 划线/想法抽取

bookmarks = {
    "chapters": [{"chapterUid": 7, "title": "第三章 政府投融资"}],
    "updated": [
        {"bookmarkId": "b1", "chapterUid": 7, "markText": "这套结构既解释了增长，也解释了债务。"},
        {"bookmarkId": "b2", "chapterUid": 7, "markText": "   "},
    ],
}
reviews = {"reviews": [
    {"review": {"review": {"reviewId": "r1", "content": "这句话点醒了我",
                           "abstract": "这套结构既解释了增长", "chapterName": "第三章"}}},
    {"review": {"review": {"reviewId": "r2", "content": ""}}},
]}
notes = wr.extract_notes(bookmarks, reviews)
check("抽出 1 条划线（空的丢弃）", len(notes["highlights"]) == 1, str(len(notes["highlights"])))
check("章节名按 chapterUid 回填", notes["highlights"][0]["chapter_name"] == "第三章 政府投融资")
check("抽出 1 条想法（空的丢弃）", len(notes["thoughts"]) == 1, str(len(notes["thoughts"])))
check("想法的依附原文落位", notes["thoughts"][0]["ref_text"] == "这套结构既解释了增长")
check("空入参不炸", wr.extract_notes({}, None) == {"highlights": [], "thoughts": []})


# ------------------------------------------------------- 5. 笔记本口径

summary = wr.notebooks_summary({"totalBookCount": 3, "totalNoteCount": 12, "books": [
    {"reviewCount": 2, "noteCount": 5, "bookmarkCount": 1},
    {"reviewCount": 1, "noteCount": 3, "bookmarkCount": 0},
]})
check("笔记总数取回包 totalNoteCount", summary["notes"] == 12, str(summary))
fallback = wr.notebooks_summary({"books": [{"reviewCount": 2, "noteCount": 5, "bookmarkCount": 1}]})
check("无 totalNoteCount 时自行累加", fallback["notes"] == 8, str(fallback))


# ------------------------------------------------------- 6. 客户端

captured = {}


def fake_transport(api_name, params, api_key, timeout):
    captured["api_name"] = api_name
    captured["params"] = params
    captured["api_key"] = api_key
    return {"books": [], "albums": [], "mp": None}


client = wr.WereadClient("wrk-test", transport=fake_transport)
client.shelf()
check("请求 api_name 正确", captured["api_name"] == wr.API_SHELF)
check("业务参数平铺在顶层（不包 params）", "params" not in captured["params"] and captured["params"] == {})
check("Bearer 用调用方传入的 key", captured["api_key"] == "wrk-test")

client.notebooks(count=5, last_sort=1516907353)
check("分页参数平铺", captured["params"] == {"count": 5, "lastSort": 1516907353}, str(captured["params"]))

client.search("三体", scope=wr.SCOPE_EBOOK, count=10)
check("搜索参数平铺", captured["params"] == {"keyword": "三体", "scope": 10, "count": 10}, str(captured["params"]))


def err_transport(api_name, params, api_key, timeout):
    return {"errcode": 10001, "errmsg": "key 无效"}


try:
    wr.WereadClient("wrk-test", transport=err_transport).shelf()
    check("errcode != 0 抛错", False)
except wr.WereadApiError as exc:
    check("errcode != 0 抛错", "key 无效" in str(exc) and exc.errcode == 10001, str(exc))


def upgrade_transport(api_name, params, api_key, timeout):
    return {"upgrade_info": {"message": "请升级到 1.1.0"}}


try:
    wr.WereadClient("wrk-test", transport=upgrade_transport).shelf()
    check("upgrade_info 必须中断（不能忽略）", False)
except wr.WereadApiError as exc:
    check("upgrade_info 必须中断（不能忽略）", "升级" in str(exc), str(exc))


try:
    wr.WereadClient("", transport=fake_transport).shelf()
    check("未配置 Key 时抛错", False)
except wr.WereadApiError as exc:
    check("未配置 Key 时抛错", "API Key" in str(exc))
check("configured 属性", wr.WereadClient("wrk-test").configured is True
      and wr.WereadClient("").configured is False)


# ------------------------------------------------------- 7. API 层

os.environ["WEREAD_API_KEY"] = "wrk-test"
from fastapi.testclient import TestClient  # noqa: E402

import api_server  # noqa: E402
from api_server import create_app  # noqa: E402
from config import Settings  # noqa: E402
from core.database import Database  # noqa: E402
from core.llm import LlmClient  # noqa: E402


class FakeLlm(LlmClient):
    def __init__(self, settings):
        super().__init__(settings, responder=None)

    async def astream_chat_content(self, messages, task, **kwargs):
        yield ""


class FakeClient:
    """替换 api_server 里的 WereadClient，让整条同步链路离线可测。"""

    def __init__(self, api_key="", **kwargs):
        self.api_key = api_key

    def shelf(self):
        return {
            "books": [
                {"bookId": "1", "title": "置身事内", "author": "兰小欢", "category": "经济理财-财经",
                 "cover": "https://c/1.jpg", "deepLink": "https://weread.qq.com/1",
                 "readUpdateTime": 100, "finishReading": 0, "secret": 0},
                {"bookId": "2", "title": "活着", "author": "余华", "category": "文学-小说",
                 "cover": "https://c/2.jpg", "deepLink": "https://weread.qq.com/2",
                 "readUpdateTime": 200, "finishReading": 1, "secret": 0},
            ],
            "albums": [{"albumInfo": {"albumId": "a1"}}],
            "mp": {"show": 1},
        }

    def progress(self, book_id):
        return {"book": {"progress": 42 if book_id == "1" else 100, "recordReadingTime": 3600}}

    def bookmarks(self, book_id):
        return {
            "chapters": [{"chapterUid": 7, "title": "第三章"}],
            "updated": [{"bookmarkId": "b1", "chapterUid": 7, "markText": "这套结构既解释了增长，也解释了债务。"}],
        }

    def my_reviews(self, book_id):
        return {"reviews": [{"review": {"review": {"reviewId": "r1", "content": "这句话点醒了我"}}}]}


tmp = Path(tempfile.mkdtemp(prefix="ko-weread-"))
settings = Settings(
    tju_api_key="tk-verify-placeholder",
    tju_base_url="https://example.invalid/api",
    tju_model="tju-llm",
    data_dir=tmp,
    usage_tracking_enabled=False,
)
db = Database(tmp / "verify.sqlite3")
api_server.weread_mod.WereadClient = FakeClient
app = create_app(db, settings, FakeLlm(settings))
client_http = TestClient(app)
client_http.post("/api/auth/register", json={"email": "a@e.com", "password": "abcd1234", "name": "A"})

r = client_http.get("/api/reading/weread/status")
check("状态 200", r.status_code == 200, str(r.status_code))
check("识别到 env 来源", r.json()["origin"] == "env")
check("能力表标明不给正文", r.json()["capabilities"]["fulltext"] is False)

r = client_http.put("/api/reading/weread/key", json={"api_key": "not-a-key"})
check("非法 Key 格式 400", r.status_code == 400, str(r.status_code))
check("错误提示提到 wrk-", "wrk-" in r.text)

r = client_http.post("/api/reading/weread/sync", json={})
check("同步 200", r.status_code == 200, str(r.status_code) + " " + r.text[:120])
data = r.json()
check("同步 2 本电子书", data["synced"] == 2, str(data.get("synced")))
check("书架口径含有声书与文章收藏",
      data["counts"] == {"books": 2, "albums": 1, "articles": 1, "total": 4}, str(data["counts"]))
check("顺带拉了进度", data["progressed"] == 2, str(data.get("progressed")))

shelf = client_http.get("/api/reading/books").json()
check("书架入库 2 本", len(shelf["books"]) == 2, str(len(shelf["books"])))
check("同步不自动建项目（避免空项目塞满侧栏）",
      all(not b["project_id"] for b in shelf["books"]),
      str([b["project_id"] for b in shelf["books"]]))
check("书架全是 licensed（无全文）", all(b["rights"] == "licensed" and not b["has_fulltext"] for b in shelf["books"]))
by_title = {b["title"]: b for b in shelf["books"]}
check("进度 42% 落库", by_title["置身事内"]["progress"] == 42, str(by_title["置身事内"]["progress"]))
check("读完状态落库", by_title["活着"]["reading_status"] == "finished", by_title["活着"]["reading_status"])
check("原生分类归到一级领域",
      by_title["置身事内"]["category"] == "经济管理" and by_title["活着"]["category"] == "文学小说",
      str([by_title["置身事内"]["category"], by_title["活着"]["category"]]))

r = client_http.get("/api/reading/weread/books/1/notes")
check("划线接口 200", r.status_code == 200, str(r.status_code) + " " + r.text[:120])
notes_body = r.json()
check("划线返回结构完整", "highlights" in notes_body and "thoughts" in notes_body)
check("划线与想法都抽出来了",
      len(notes_body["highlights"]) == 1 and len(notes_body["thoughts"]) == 1,
      str([len(notes_body["highlights"]), len(notes_body["thoughts"])]))

# 响应与落盘都不得回显 Key。
# 占位值刻意取短：`src/tools/ci_gate.py` 的凭据门禁按 `wrk-` + 16 位以上识别真实 Key，
# 这里要的是一个**明显不像真 Key、也不触发门禁**的值（只需要满足 `wrk-` 前缀校验）。
_FAKE_WEREAD_KEY = "wrk-verify"
r = client_http.put("/api/reading/weread/key", json={"api_key": _FAKE_WEREAD_KEY})
check("保存 Key 200", r.status_code == 200, str(r.status_code))
check("响应不回显 Key", _FAKE_WEREAD_KEY not in r.text, r.text[:120])
cfg_text = (tmp / "local_api_config.json").read_text(encoding="utf-8")
check("落盘文件不含明文 Key", _FAKE_WEREAD_KEY not in cfg_text)
check("落盘文件确实写了该槽位", "weread_api_key" in cfg_text)

os.environ.pop("WEREAD_API_KEY", None)
r = client_http.get("/api/reading/weread/status")
check("环境变量移除后仍从配置文件读到", r.json()["configured"] is True and r.json()["origin"] == "config")

# 章节目录：**非正文条目必须被剔除**
# 真实 /book/chapterinfo 会把封面、版权信息、作者简介、内容简介也当章返回。
# 不滤掉它们，「逐章精读」里就会冒出一排「本章材料不足」，看着像功能坏了。
raw_chapters = {
    "chapters": [
        {"chapterUid": 1, "title": "封面"},
        {"chapterUid": 2, "title": "版权信息"},
        {"chapterUid": 3, "title": "作者简介"},
        {"chapterUid": 4, "title": "内容简介"},
        {"chapterUid": 5, "title": "目 录"},          # 带空格，也要滤掉
        {"chapterUid": 6, "title": "前言"},
        {"chapterUid": 7, "title": "第一章 地方政府的权力与事务"},
        {"chapterUid": 8, "title": "后记"},
    ]
}
kept = [c["title"] for c in wr.chapter_list(raw_chapters)]
check("封面被剔除", "封面" not in kept, str(kept))
check("版权信息被剔除", "版权信息" not in kept, str(kept))
check("作者简介被剔除", "作者简介" not in kept, str(kept))
check("内容简介被剔除", "内容简介" not in kept, str(kept))
check("带空格的「目 录」也被剔除", "目 录" not in kept, str(kept))
check("前言保留（它是正文）", "前言" in kept, str(kept))
check("后记保留（它是正文）", "后记" in kept, str(kept))
check("正文章节保留", "第一章 地方政府的权力与事务" in kept, str(kept))
check("过滤后只剩 3 章", len(kept) == 3, str(kept))
check("is_non_body_chapter 判对", wr.is_non_body_chapter(" 版权 信息 ") is True)

print("\n%d 项未通过" % len(FAILS) if FAILS else "\n全部通过")
sys.exit(1 if FAILS else 0)
