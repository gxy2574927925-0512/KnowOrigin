"""微信读书适配层 —— 本项目访问微信读书的**唯一出网口**。

## 能力边界（先看这段，别指望它更多）

官方 Agent API 能给的是：**书架、封面、阅读进度、用户自己的划线与想法、阅读统计、推荐**。
**给不了整本书的正文** —— 正文留在它的 App 里读。这是它的商业边界，不是接口缺陷。

所以本模块只负责「元数据 + 个人笔记」这一半；另一半（能全文检索、能侧边问 AI、
能划词高亮的正文）交给 ``core/book_sources.py`` 的公版书源与本地导入。
两半在 ``core/reading_store.py`` 汇合成同一张书架。

## 凭据（安全红线）

``WEREAD_API_KEY``（``wrk-`` 开头）**绑定用户身份，等同账号凭证**。
只从环境变量或 ``data/local_api_config.json``（DPAPI 密文）读，
**绝不写进代码、注释、日志或仓库任何文件**。``src/tools/ci_gate.py`` 会扫 ``wrk-`` 前缀。

本模块**不自己读凭据** —— 由调用方（``api_server``）解析好再传进来。
这样 core 层保持纯净、可注入假 transport 单测，也不会有人在这里顺手 ``os.environ``。

## 接口约定（官方文档）

```
POST https://i.weread.qq.com/api/agent/gateway
Header: Authorization: Bearer $WEREAD_API_KEY
Body:   {"api_name": "/shelf/sync", <业务参数平铺在顶层>, "skill_version": "1.0.4"}
```

⚠️ 业务参数**不能**包在 ``params`` 里 —— 包了后端收不到，表现为「分页失效、永远第一页」。
⚠️ 回包里出现 ``upgrade_info`` 时必须停下来升级 skill_version，不能忽略。
"""

from __future__ import annotations

from typing import Any, Callable

GATEWAY = "https://i.weread.qq.com/api/agent/gateway"
SKILL_VERSION = "1.0.4"
DEFAULT_TIMEOUT = 20.0

# 本模块用到的接口名。集中列出，便于对照官方文档与做升级检查。
API_SHELF = "/shelf/sync"
API_BOOK_INFO = "/book/info"
API_CHAPTERS = "/book/chapterinfo"
API_PROGRESS = "/book/getprogress"
API_NOTEBOOKS = "/user/notebooks"
API_BOOKMARKS = "/book/bookmarklist"
API_MY_REVIEWS = "/review/list/mine"
API_READDATA = "/readdata/detail"
API_SEARCH = "/store/search"
# 热门划线（全书最被划的段落，按热度排序，最多 20 条）。
# **这是「没有正文」这件事的最佳补偿** —— 它给的是全书读者公认最重要的原文片段。
API_BEST_BOOKMARKS = "/book/bestbookmarks"
API_RECOMMEND = "/book/recommend"
API_SIMILAR = "/book/similar"

# 逐章精读最多展开几章。官方 chapterinfo 常含「封面 / 版权信息 / 内容简介」
# 这类非正文条目，它们会占掉名额，所以上限给宽一点。
MAX_OUTLINE_CHAPTERS = 24

# 搜索 scope（官方文档）。用户说「找书」用 10，泛搜用 0。
SCOPE_ALL = 0
SCOPE_EBOOK = 10
SCOPE_AUDIO = 14
SCOPE_AUTHOR = 6

SOURCE_ID = "weread"


class WereadApiError(RuntimeError):
    """接口返回 errcode != 0，或网络层失败。"""

    def __init__(self, message: str, *, errcode: int = -1, api_name: str = ""):
        super().__init__(message)
        self.errcode = errcode
        self.api_name = api_name


# --------------------------------------------------------------------------
# 客户端
# --------------------------------------------------------------------------

Transport = Callable[..., dict]


def _httpx_transport(api_name: str, params: dict[str, Any], api_key: str, timeout: float) -> dict:
    """默认出网实现。httpx 在函数内 import —— 模块本身不依赖它，便于离线单测。"""
    import httpx  # noqa: PLC0415

    body = {"api_name": api_name, "skill_version": SKILL_VERSION}
    body.update(params)
    with httpx.Client(timeout=timeout) as client:
        resp = client.post(
            GATEWAY,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=body,
        )
    if resp.status_code != 200:
        raise WereadApiError(
            f"微信读书接口返回 HTTP {resp.status_code}", errcode=resp.status_code, api_name=api_name
        )
    try:
        data = resp.json()
    except Exception as exc:
        raise WereadApiError("微信读书接口返回的不是 JSON", api_name=api_name) from exc
    return data if isinstance(data, dict) else {}


class WereadClient:
    """薄封装。``transport`` 可注入 —— 单测与门禁因此完全不依赖外网。"""

    def __init__(self, api_key: str, *, transport: Transport | None = None, timeout: float = DEFAULT_TIMEOUT):
        self.api_key = str(api_key or "").strip()
        self._transport = transport or _httpx_transport
        self.timeout = timeout

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    def call(self, api_name: str, **params: Any) -> dict:
        if not self.configured:
            raise WereadApiError(
                "还没有配置微信读书 API Key（wrk- 开头）。", errcode=401, api_name=api_name
            )
        data = self._transport(api_name, params, self.api_key, self.timeout)
        if not isinstance(data, dict):
            raise WereadApiError("微信读书接口返回结构异常", api_name=api_name)
        # 版本升级：官方要求看到就停下，不能忽略。
        upgrade = data.get("upgrade_info")
        if isinstance(upgrade, dict) and upgrade.get("message"):
            raise WereadApiError(
                f"微信读书接口要求升级：{upgrade.get('message')}", api_name=api_name
            )
        errcode = data.get("errcode")
        if errcode not in (None, 0, "0"):
            raise WereadApiError(
                str(data.get("errmsg") or data.get("message") or f"errcode={errcode}"),
                errcode=int(errcode) if str(errcode).isdigit() else -1,
                api_name=api_name,
            )
        return data

    # ---- 各接口 ----

    def shelf(self) -> dict:
        return self.call(API_SHELF)

    def book_info(self, book_id: str) -> dict:
        return self.call(API_BOOK_INFO, bookId=str(book_id))

    def chapters(self, book_id: str) -> dict:
        return self.call(API_CHAPTERS, bookId=str(book_id))

    def progress(self, book_id: str) -> dict:
        return self.call(API_PROGRESS, bookId=str(book_id))

    def notebooks(self, *, count: int = 20, last_sort: int | None = None) -> dict:
        params: dict[str, Any] = {"count": max(1, min(int(count), 100))}
        if last_sort:
            params["lastSort"] = int(last_sort)
        return self.call(API_NOTEBOOKS, **params)

    def bookmarks(self, book_id: str) -> dict:
        return self.call(API_BOOKMARKS, bookId=str(book_id))

    def my_reviews(self, book_id: str) -> dict:
        return self.call(API_MY_REVIEWS, bookId=str(book_id))

    def readdata(self, mode: str = "monthly", base_time: int = 0) -> dict:
        normalized = mode if mode in ("weekly", "monthly", "annually", "overall") else "monthly"
        return self.call(API_READDATA, mode=normalized, baseTime=int(base_time or 0))

    def search(self, keyword: str, *, scope: int = SCOPE_EBOOK, count: int = 15) -> dict:
        return self.call(API_SEARCH, keyword=str(keyword), scope=int(scope), count=int(count))

    def best_bookmarks(self, book_id: str) -> dict:
        """全书热门划线。返回结构：``{totalCount, items[], chapters[]}``。"""
        return self.call(API_BEST_BOOKMARKS, bookId=str(book_id))

    def recommend(self, *, count: int = 12, max_idx: int = 0) -> dict:
        """个性化推荐（App 首页「为你推荐」）。

        这是**发现入口**：官方 ``/store/search`` 对部分 key 返回空结果，
        而推荐接口是通的 —— 搜不到书时靠它把书引进来。
        """
        return self.call(API_RECOMMEND, count=max(1, min(int(count), 40)), maxIdx=int(max_idx or 0))

    def similar(self, book_id: str, *, count: int = 12, max_idx: int = 0) -> dict:
        return self.call(
            API_SIMILAR, bookId=str(book_id), count=max(1, int(count)), maxIdx=int(max_idx or 0)
        )


# --------------------------------------------------------------------------
# 归一化：微信读书的书 → 书架记录（与 book_sources 同一种形状）
# --------------------------------------------------------------------------


def _int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def to_book_record(item: dict, *, progress: int | None = None) -> dict | None:
    """把书架里的一条书归一化成书架记录。

    ``has_fulltext`` **恒为 False** —— 微信读书不提供正文，这是版权红线，
    不是「暂时没做」。正文由公版书源/本地导入补齐。
    """
    if not isinstance(item, dict):
        return None
    book_id = str(item.get("bookId") or "").strip()
    title = str(item.get("title") or "").strip()
    if not book_id or not title:
        return None

    from core.reading_digest import guess_category  # 局部导入：避免 core 内部循环

    native_category = str(item.get("category") or "").strip()
    return {
        "source": SOURCE_ID,
        "source_id": book_id,
        "title": title,
        "author": str(item.get("author") or "").strip(),
        "cover": str(item.get("cover") or "").strip(),
        # 原生分类只当线索 —— 它粒度碎、命名不统一，直接当导航会碎成一地。
        "category": guess_category(native_category=native_category, title=title),
        "language": "zh",
        "year": "",
        "topics": [native_category] if native_category else [],
        "detail_url": str(item.get("deepLink") or "").strip(),
        "download_url": "",
        "has_fulltext": False,
        "fulltext_format": "",
        "rights": "licensed",
        "progress": _int(progress, 0) if progress is not None else 0,
        "finish_reading": 1 if _int(item.get("finishReading")) else 0,
        "secret": 1 if item.get("secret") else 0,
        "is_top": 1 if item.get("isTop") else 0,
        "read_update_time": _int(item.get("readUpdateTime")),
    }


def shelf_records(payload: dict) -> list[dict]:
    """把 ``/shelf/sync`` 的回包转成书架记录列表。

    **只收 ``books``** —— ``albums`` 是有声书，读不了正文也划不了线，
    混进书架只会让「在架 N 本」这个数字骗人。``mp`` 是文章收藏入口，同样不算书。
    """
    if not isinstance(payload, dict):
        return []
    out: list[dict] = []
    for item in payload.get("books") or []:
        record = to_book_record(item)
        if record:
            out.append(record)
    return out


def shelf_counts(payload: dict) -> dict[str, int]:
    """书架口径。官方文档明确：总数 = books + albums + (mp 非空 ? 1 : 0)。"""
    if not isinstance(payload, dict):
        return {"books": 0, "albums": 0, "articles": 0, "total": 0}
    books = len(payload.get("books") or [])
    albums = len(payload.get("albums") or [])
    articles = 1 if payload.get("mp") else 0
    return {"books": books, "albums": albums, "articles": articles, "total": books + albums + articles}


def progress_from_payload(payload: dict) -> dict[str, Any]:
    """``/book/getprogress`` 的裁剪。⚠️ ``progress`` 是 0-100 的整数，1 表示 1%。"""
    book = payload.get("book") if isinstance(payload, dict) else None
    if not isinstance(book, dict):
        return {"progress": 0, "seconds": 0, "update_time": 0, "finish_time": 0}
    return {
        "progress": max(0, min(_int(book.get("progress")), 100)),
        "seconds": max(0, _int(book.get("recordReadingTime"))),
        "update_time": _int(book.get("updateTime")),
        "finish_time": _int(book.get("finishTime")),
    }


def extract_notes(bookmarks: dict, reviews: dict | None = None) -> dict[str, list[dict[str, Any]]]:
    """把划线（``/book/bookmarklist``）与个人想法（``/review/list/mine``）裁成两份。

    与 ``core/reading_digest.py`` 的 payload 字段对齐（``mark_text`` / ``chapter_name`` /
    ``text`` / ``ref_text``），所以拿到就能直接喂给收获文档生成。
    """
    highlights: list[dict[str, Any]] = []
    chapters = {}
    if isinstance(bookmarks, dict):
        for item in bookmarks.get("chapters") or []:
            if isinstance(item, dict):
                chapters[_int(item.get("chapterUid"))] = str(item.get("title") or "")
        for item in bookmarks.get("updated") or []:
            if not isinstance(item, dict):
                continue
            text = str(item.get("markText") or "").strip()
            if not text:
                continue
            uid = _int(item.get("chapterUid"))
            highlights.append(
                {
                    "bookmark_id": str(item.get("bookmarkId") or ""),
                    "chapter_uid": uid,
                    "chapter_name": chapters.get(uid, ""),
                    "mark_text": text,
                    "create_time": _int(item.get("createTime")),
                }
            )

    thoughts: list[dict[str, Any]] = []
    if isinstance(reviews, dict):
        rows = reviews.get("reviews") or reviews.get("updated") or []
        for item in rows:
            if not isinstance(item, dict):
                continue
            inner = item.get("review") if isinstance(item.get("review"), dict) else item
            review = inner.get("review") if isinstance(inner.get("review"), dict) else inner
            text = str(review.get("content") or review.get("text") or "").strip()
            if not text:
                continue
            thoughts.append(
                {
                    "review_id": str(review.get("reviewId") or ""),
                    "text": text,
                    "ref_text": str(review.get("abstract") or "").strip(),
                    "chapter_name": str(review.get("chapterName") or "").strip(),
                    "create_time": _int(review.get("createTime")),
                }
            )
    return {"highlights": highlights, "thoughts": thoughts}


def book_intro(payload: dict) -> str:
    """``/book/info`` 的简介。

    **这是成段论述，不是碎片** —— 微信读书只给 20 条热门划线时，收获文档全靠它
    和章节目录撑起整体感。缺了它，输出就只剩「几句金句 + 一堆章节名」。
    """
    if not isinstance(payload, dict):
        return ""
    return str(payload.get("intro") or "").strip()


def book_rating(payload: dict) -> int:
    """``newRating`` 是百分制评分（0~100）。"""
    return _int((payload or {}).get("newRating")) if isinstance(payload, dict) else 0


# 目录里的「非正文」条目。``/book/chapterinfo`` 会把**书外之物**也当成章返回
# （封面、版权信息、作者简介、内容简介……）。它们既没有正文也没有划线，
# 留着只会让「逐章精读」冒出一连串「本章材料不足」—— 用户看到的是
# 「这本书有 16 章，其中 4 章是空的」，像是功能坏了，其实是目录噪音。
#
# ⚠️ 只滤这一份**明确**的清单，**不碰**前言 / 序 / 引言 / 后记 / 附录 ——
# 那些是真正的正文内容，滤掉才是损失。
_NON_BODY_CHAPTER_TITLES: frozenset[str] = frozenset(
    {
        "封面", "封底", "书封", "书名", "书名页", "扉页", "插页", "彩插", "广告页",
        "版权", "版权信息", "版权页", "版权声明", "出版信息", "出版说明",
        "内容简介", "作者简介", "作者介绍", "关于作者", "关于本书", "目录",
    }
)


def is_non_body_chapter(title: str) -> bool:
    """这个目录条目是不是「书外之物」（封面 / 版权页 / 目录 …）。

    比较前把所有空白去掉 —— 真实目录里会出现「目 录」「版 权 信 息」这类
    带空格的写法，不归一化就会漏滤。
    """
    return "".join(str(title or "").split()) in _NON_BODY_CHAPTER_TITLES


def chapter_list(payload: dict) -> list[dict[str, Any]]:
    """章节目录。``{chapterUid, chapterIdx, title, level, paid, wordCount}``。

    ``level`` 是目录层级（1=一级标题）—— 保留它，前端才能把子标题缩进显示。

    **封面 / 版权信息 / 作者简介 / 内容简介 / 目录等非正文条目在这里被剔除**，
    否则它们会一路走到「逐章精读」里变成一排「本章材料不足」。
    """
    if not isinstance(payload, dict):
        return []
    out: list[dict[str, Any]] = []
    for item in payload.get("chapters") or []:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        if not title:
            continue
        if is_non_body_chapter(title):
            continue
        out.append(
            {
                "chapter_uid": _int(item.get("chapterUid")),
                "idx": _int(item.get("chapterIdx")),
                "title": title,
                "level": max(1, _int(item.get("level"), 1)),
                "paid": _int(item.get("paid")),
                "word_count": _int(item.get("wordCount")),
            }
        )
    return out


def best_bookmarks(payload: dict) -> dict[str, Any]:
    """全书热门划线。``items[].markText`` 是原文，``totalCount`` 是划线人数。

    ⚠️ 官方文档写明「最多 20 条」，所以 ``total`` 往往远大于 ``len(items)`` ——
    前端要如实显示「展示最热的 20 条 / 全书共 330 条」，别让用户以为这就是全部。
    """
    if not isinstance(payload, dict):
        return {"total": 0, "items": []}
    items: list[dict[str, Any]] = []
    for item in payload.get("items") or []:
        if not isinstance(item, dict):
            continue
        text = str(item.get("markText") or "").strip()
        if not text:
            continue
        items.append(
            {
                "bookmark_id": str(item.get("bookmarkId") or ""),
                "chapter_uid": _int(item.get("chapterUid")),
                "text": text,
                "heat": _int(item.get("totalCount")),
            }
        )
    return {"total": _int(payload.get("totalCount")) or len(items), "items": items}


def group_by_chapter(
    chapters: list[dict[str, Any]],
    highlights: list[dict[str, Any]],
    *,
    cap: int = MAX_OUTLINE_CHAPTERS,
    per_chapter: int = 6,
) -> list[dict[str, Any]]:
    """把热门划线按章归组，与章节目录合成「逐章精读」的数据。

    这是解决「收获太少、没有按章节展开」的**关键一步**：不把划线拍平成一坨，
    而是挂回各自的章 —— 模型拿到带章节结构的材料，才会一章一章地写。
    """
    by_uid: dict[int, list[dict[str, Any]]] = {}
    for item in highlights or []:
        if not isinstance(item, dict):
            continue
        by_uid.setdefault(_int(item.get("chapter_uid")), []).append(item)

    out: list[dict[str, Any]] = []
    for chapter in (chapters or [])[:cap]:
        if not isinstance(chapter, dict):
            continue
        uid = _int(chapter.get("chapter_uid"))
        notes = by_uid.get(uid) or []
        notes.sort(key=lambda n: -_int(n.get("heat")))
        out.append(
            {
                "chapter_uid": uid,
                "idx": _int(chapter.get("idx")),
                "level": max(1, _int(chapter.get("level"), 1)),
                "title": str(chapter.get("title") or "").strip(),
                "highlights": [
                    {"text": str(n.get("text") or "").strip(), "heat": _int(n.get("heat"))}
                    for n in notes[:per_chapter]
                    if str(n.get("text") or "").strip()
                ],
            }
        )
    return [item for item in out if item["title"]]


def outline_chapters(grouped: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """把 ``group_by_chapter`` 的结果转成收获引擎要的 ``chapters`` 形状。

    ⚠️ **把目录里的每一章都传过去，包括没有材料的那些**。
    只传有材料的章，文档就只覆盖书的一小部分 —— 而用户要的是「按章节展开」，
    少了章会让人以为这本书就这么几章。没有材料的章传空 highlights，
    模型被要求给空 summary，渲染出来是「本章材料不足」——
    这是**诚实的缺口**，比静默少几章好。
    """
    out: list[dict[str, Any]] = []
    for item in grouped or []:
        title = str(item.get("title") or "").strip()
        if not title:
            continue
        notes = [
            str(n.get("text") or "").strip()
            for n in (item.get("highlights") or [])
            if str(n.get("text") or "").strip()
        ]
        out.append({"title": title, "highlights": notes})
    return out


def recommend_records(payload: dict) -> list[dict[str, Any]]:
    """``/book/recommend`` 的书 → 书架记录（与 shelf 同一种形状）。"""
    if not isinstance(payload, dict):
        return []
    out: list[dict[str, Any]] = []
    for item in payload.get("books") or []:
        if not isinstance(item, dict):
            continue
        record = to_book_record(
            {
                "bookId": item.get("bookId"),
                "title": item.get("title"),
                "author": item.get("author"),
                "cover": item.get("cover"),
                "category": item.get("category"),
                "deepLink": item.get("deepLink"),
            }
        )
        if record:
            record["reason"] = str(item.get("reason") or "").strip()
            record["rating"] = _int(item.get("newRating"))
            out.append(record)
    return out


def notebooks_summary(payload: dict) -> dict[str, int]:
    """``/user/notebooks`` 的口径。

    ⚠️ ``noteCount`` 是**划线数**不是总笔记数；总笔记数 =
    ``reviewCount + noteCount + bookmarkCount``（官方文档强调过，别按字段名直译）。
    """
    if not isinstance(payload, dict):
        return {"books": 0, "notes": 0}
    books = payload.get("books") or []
    total = 0
    for item in books:
        if not isinstance(item, dict):
            continue
        total += _int(item.get("reviewCount")) + _int(item.get("noteCount")) + _int(item.get("bookmarkCount"))
    return {
        "books": _int(payload.get("totalBookCount")) or len(books),
        "notes": _int(payload.get("totalNoteCount")) or total,
    }


def readdata_summary(payload: dict) -> dict[str, Any]:
    """``/readdata/detail`` 的裁剪。⚠️ 所有时长字段单位是**秒**。"""
    if not isinstance(payload, dict):
        return {}
    longest = []
    for item in payload.get("readLongest") or []:
        if not isinstance(item, dict):
            continue
        book = item.get("book") if isinstance(item.get("book"), dict) else {}
        longest.append(
            {
                "title": str(book.get("title") or ""),
                "author": str(book.get("author") or ""),
                "cover": str(book.get("cover") or ""),
                "seconds": _int(item.get("readTime")),
            }
        )
    return {
        "total_seconds": _int(payload.get("totalReadTime")),
        "read_days": _int(payload.get("readDays")),
        "day_average_seconds": _int(payload.get("dayAverageReadTime")),
        "read_longest": longest,
    }
