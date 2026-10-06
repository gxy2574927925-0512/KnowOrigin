"""离线北洋维基全站正文语料。

北洋维基（wiki.tjubot.cn）是 Typecho 自运维的定制 wiki，无站内搜索接口、
无 MediaWiki API、无 sitemap。为了让海小棠能实地查『保研/毕业/交通/图书馆/
办事/空闲教室』等任意词条且命中正文，这里一次性把全站文章爬过来、用
trafilatura 抽成干净正文，落盘成一个 JSON 语料。查询时对『全部正文』跑与
api_server._fetch_wiki 一致的 bigram 打分召回，而不是只对标题前 6 篇现爬。

落盘： data/wiki_corpus/wiki_index.json + wiki_index.meta（含构建时间戳）
刷新： 超过 REFRESH_SECONDS 未重建则视为过期，search 返回 None → 上层回退到
       api_server 原有的动态爬取路径。
"""

import json
import os
import re
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
import urllib.request
from urllib.parse import urljoin

from bs4 import BeautifulSoup
import trafilatura

HOME = "https://wiki.tjubot.cn/"
HEADERS = {"User-Agent": "KnowOrigin-hxt-campus/1.0 (Mozilla/5.0 compatible)"}

# 非文章路径的首段目录：分类、关于、上传/资源、作者、标签等一律不当作词条入库
NON_ARTICLE_FIRST_DIR = {
    "category",
    "categories",
    "about",
    "aboutus",
    "friends",
    "assets",
    "usr",
    "uploads",
    "author",
    "tags",
    "links",
    "near",
}

# 校园里口语 ↔ 官方措辞的常见同义词，用于把用户口语词扩展成正文/标题里的官方词去匹配。
# 完整词表在 core/campus_lexicon（与 campus_sources 同源）；这里是**降级兜底小表**，
# 只在共享词表导入失败时使用。
SYNONYMS = {
    "保研": ["推免", "推荐免试", "免试推荐", "推免生"],
    "考研": ["硕士招生", "研究生招生", "硕士入学"],
    "双学位": ["辅修", "第二学士学位"],
    "空闲教室": ["自习室"],
    "班车": ["615", "校区间", "通勤"],
}


def _synonyms_for(query: str) -> list[str]:
    """按**子串**探测口语词，返回可拿去检索的官方措辞。

    这里曾经写成 `SYNONYMS.get(run)`，run 是整段中文——于是只有用户恰好只问
    「保研」两个字时才命中，「保研要什么条件」永远匹配不上，同义词表形同虚设。
    改成子串探测后，词表才真正开始干活。
    """
    try:
        from core import campus_lexicon  # type: ignore

        return campus_lexicon.expand(query)
    except Exception:  # noqa: BLE001 - 词表不可用不应影响检索
        out: list[str] = []
        for spoken, official in SYNONYMS.items():
            if spoken in (query or ""):
                out.extend(w for w in official if w not in out)
        return out


def _spoken_terms(query: str) -> list[str]:
    """问题里命中的口语主题词本身（挂科 / 保研 / 宿舍…）。

    这是「标题写着用户原话」的信号：《挂科与试读》标题里就有「挂科」二字，
    比一篇正文碰巧撞上「补考 / 重修」的长文更该排在前面。老打分只看整段中文
    （`run in title`），「挂科了怎么办」这一整串永远不可能出现在任何标题里，
    于是这条强信号从未生效——用户搜「挂科」反被《军训》等泛文挤到后面。
    """
    try:
        from core import campus_lexicon  # type: ignore

        return campus_lexicon.probe(query)
    except Exception:  # noqa: BLE001
        return [spoken for spoken in SYNONYMS if spoken in (query or "")]


_BASE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "data", "wiki_corpus"
)
INDEX_PATH = os.path.join(_BASE, "wiki_index.json")
META_PATH = os.path.join(_BASE, "wiki_index.meta")

REFRESH_SECONDS = 6 * 3600  # 6 小时（原 24h：校园信息更新频繁，语料太旧会答出过期安排）
MAX_BODY_CHARS = 3000  # 单篇正文存储上限，控制语料体积

# ---------- 图片 OCR（维基大量词条把关键信息放在图上） ----------
# 校历、考试安排、专业分流表、办事流程图…正文往往只有一两句话，真正的信息在图片里。
# 不接通 OCR，这些内容就等于不存在——用户问"什么时候放假""怎么分流"只能得到"没查到"。
# OCR 实现由调用方注入（知源复用它的 RapidOCR 引擎池），wiki_corpus 本身不依赖 OCR 库。
# 成本控制：一篇 6 张图 × 120 篇会跑十几分钟（实测），而"首图"几乎总是那唯一重要的
# 表格/校历/流程图。取前 4 张 + 总预算 60 篇，把整轮压到两三分钟量级。
OCR_IMG_MAX = 4  # 单篇最多 OCR 几张图
OCR_TEXT_MAX_CHARS = 1500  # 单篇图片文本入库上限（防止语料被 OCR 噪声灌爆）
OCR_ARTICLE_BUDGET = 60  # 单次重建最多对多少篇含图文章做 OCR
OCR_WORKERS = 3  # OCR 并发；RapidOCR 单实例吃 CPU，别开大

_OCR_FN = None
_OCR_FN_LOCK = threading.Lock()


def set_ocr_fn(fn) -> None:
    """注入 OCR 实现：fn(url, imgs) -> str。未注入时跳过图片识别（语料仍可用，只是没有图中文字）。"""
    global _OCR_FN
    with _OCR_FN_LOCK:
        _OCR_FN = fn


def _current_ocr_fn():
    with _OCR_FN_LOCK:
        return _OCR_FN


def has_ocr() -> bool:
    return _current_ocr_fn() is not None


_lru_lock = threading.Lock()
_lru: dict | None = None  # 进程内缓存已加载的语料 {url: {title, body}}


def _get(url: str, timeout: int = 8) -> str:
    try:
        with urllib.request.urlopen(
            urllib.request.Request(url, headers=HEADERS), timeout=timeout
        ) as resp:
            return resp.read().decode("utf-8", "ignore")
    except Exception:
        return ""


# ---------- 全站链接枚举（与 api_server._wiki_full_index 一致，并放宽嵌套路径） ----------


def _hrefs_of(html_text: str) -> list[tuple[str, str]]:
    """提取 HTML 中内链的文章 (url, title)，允许 1..N 段路径（含中文/数字/连字符）。"""
    out: list[tuple[str, str]] = []
    try:
        soup = BeautifulSoup(html_text or "", "html.parser")
    except Exception:
        return out
    for a in soup.find_all("a", href=True):
        href = urljoin(HOME, a["href"])
        if not href.startswith(HOME):
            continue
        path = href[len(HOME) :].split("?")[0].rstrip("/").strip("/")
        if not path:
            continue
        segs = path.split("/")
        if segs[0] in NON_ARTICLE_FIRST_DIR or "category" in segs:
            continue
        if not all(re.fullmatch(r"[A-Za-z0-9\-\u4e00-\u9fff]+", s) for s in segs):
            continue
        title = " ".join(a.get_text(" ", strip=True).split())
        if title:
            out.append((href, title))
    return out


def _candidates() -> list[tuple[str, str]]:
    """枚举全站文章 (url, title)，先用首页收集分类 slug 再逐分类补链接。"""
    index: dict[str, str] = {}
    html = _get(HOME)
    cats: list[str] = []
    if html:
        for href, title in _hrefs_of(html):
            index.setdefault(href, title)
        try:
            for a in BeautifulSoup(html, "html.parser").find_all("a", href=True):
                m = re.search(r"/category/([^/?#]+)/?$", urljoin(HOME, a["href"]))
                if m and m.group(1) not in cats:
                    cats.append(m.group(1))
        except Exception:
            pass
    if cats:
        with ThreadPoolExecutor(max_workers=12) as pool:
            futs = {pool.submit(_get, f"{HOME}category/{c}/"): c for c in cats}
            for fut in as_completed(futs):
                body = fut.result()
                if body:
                    for href, title in _hrefs_of(body):
                        index.setdefault(href, title)
    return list(index.items())


def _article_body(url: str) -> tuple[str, str]:
    """返回 (正文, 页面真实标题)。页面标题取文章页自身 <h1>/<title>，比列表页锚文本准确。"""
    html = _get(url)
    if not html:
        return "", "", []
    text = ""
    try:
        soup = BeautifulSoup(html, "html.parser")
        node = (
            soup.select_one("#doc_content")
            or soup.select_one(".doc-content")
            or soup.find("article")
        )
        imgs: list[str] = []
        if node is not None:
            text = node.get_text(" ", strip=True)
            # 采集正文里的图片（绝对 URL，去重）——有些信息以图承载（校历/考试安排/分流表等）
            for img in node.find_all("img", src=True):
                u = urljoin(HOME, img.get("src", "")).split("?")[0]
                if u.startswith(HOME) or u.startswith("https://"):
                    if u not in imgs:
                        imgs.append(u)
                if len(imgs) >= OCR_IMG_MAX:
                    break
        # 页面真实标题：优先 <h1>，其次 <title>
        title = ""
        h1 = soup.find("h1")
        if h1:
            title = " ".join(h1.get_text(" ", strip=True).split())
        if not title and soup.title:
            title = " ".join(soup.title.get_text(" ", strip=True).split())
            title = re.sub(r"[｜|–—-].*$", "", title).strip()
    except Exception:
        title = ""
    if not text or len(text) < 120:
        try:
            text = (
                trafilatura.extract(html, include_comments=False, include_tables=False)
                or ""
            )
        except Exception:
            text = ""
    text = re.sub(r"\s+", " ", text).strip()
    return text[:MAX_BODY_CHARS], title, imgs


# ---------- 构建 / 加载 ----------


def _is_fresh() -> bool:
    try:
        with open(META_PATH, "r", encoding="utf-8") as f:
            meta = json.load(f)
        ts = meta.get("ts", 0)
        if not (time.time() - ts < REFRESH_SECONDS and os.path.exists(INDEX_PATH)):
            return False
        # 上次建库时没有 OCR 能力（imgtext 全空）而现在有了 → 值得重建一次，
        # 把图里的校历/安排/分流表补进语料。否则老用户升级后永远拿不到图中信息。
        if has_ocr() and not meta.get("ocr"):
            return False
        return True
    except Exception:
        return False


def _load() -> dict:
    global _lru
    with _lru_lock:
        try:
            mtime = os.path.getmtime(INDEX_PATH)
        except Exception:
            return {}
        if _lru is not None and getattr(_lru, "_mtime", None) == mtime:
            return _lru["data"]
        _lru = {"data": {}, "_mtime": mtime}
        try:
            with open(INDEX_PATH, "r", encoding="utf-8") as f:
                _lru["data"] = json.load(f)
        except Exception:
            _lru["data"] = {}
        return _lru["data"]


def build(progress_cb=None, ocr_fn=None) -> int:
    """全量重建语料：枚举全站 → 并行走抓正文 → 图片 OCR → 落盘。返回文章数。

    ocr_fn(url, imgs) -> str 由调用方注入（见 set_ocr_fn）；没注入就只建正文语料。

    OCR 刻意分两步做，而不是边抓边做：**得先看到全文分布，才能挑出最该识别的那批**——
    正文越短，图片承担的信息越多（校历页往往正文只有标题 + 一张大图）。原实现只对
    "正文 < 320 字"的文章 OCR，导致长正文页面里的表格/流程图永远进不了语料。
    """
    os.makedirs(_BASE, exist_ok=True)
    cands = _candidates()
    if not cands:
        return 0
    prev = _load()  # 复用旧语料里已有的图片 OCR 文本（rebuild 不重复烧 CPU）
    ocr_fn = ocr_fn or _current_ocr_fn()

    # ---- 阶段 1：并发抓正文 ----
    corpus: dict[str, dict] = {}
    done = 0
    with ThreadPoolExecutor(max_workers=12) as pool:
        futs = {pool.submit(_article_body, url): url for url, _title in cands}
        for fut in as_completed(futs):
            url = futs[fut]
            try:
                body, page_title, imgs = fut.result()
            except Exception:  # noqa: BLE001 - 单篇失败不影响整库
                body, page_title, imgs = "", "", []
            anchor = next((t for u, t in cands if u == url), "")
            title = (page_title or anchor).strip()
            if not body:
                done += 1
                continue
            old = prev.get(url) or {}
            doc = {"title": title, "body": body, "imgs": imgs}
            # 图片集合没变 → 直接复用上次的 OCR 结果，别每次重建都重跑识别
            if isinstance(old, dict) and old.get("imgtext") and old.get("imgs") == imgs:
                doc["imgtext"] = old["imgtext"]
            corpus[url] = doc
            done += 1
            if progress_cb and done % 25 == 0:
                progress_cb(done, len(cands))

    # ---- 阶段 2：挑最该识别的文章做图片 OCR ----
    if ocr_fn:
        pending = [
            (len(doc.get("body") or ""), url)
            for url, doc in corpus.items()
            if doc.get("imgs") and not doc.get("imgtext")
        ]
        pending.sort()  # 正文越短越依赖图，优先识别
        pending = pending[:OCR_ARTICLE_BUDGET]

        def _one(item: tuple[int, str]) -> tuple[str, str]:
            _blen, url = item
            try:
                return url, (ocr_fn(url, corpus[url].get("imgs") or []) or "")
            except Exception:  # noqa: BLE001
                return url, ""

        if pending:
            with ThreadPoolExecutor(max_workers=OCR_WORKERS) as pool:
                for url, text in pool.map(_one, pending):
                    if text:
                        corpus[url]["imgtext"] = text[:OCR_TEXT_MAX_CHARS]

    tmp = INDEX_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(corpus, f, ensure_ascii=False)
    os.replace(tmp, INDEX_PATH)
    img_pages = sum(1 for d in corpus.values() if d.get("imgtext"))
    with open(META_PATH, "w", encoding="utf-8") as f:
        json.dump(
            {
                "ts": time.time(),
                "count": len(corpus),
                "ocr": bool(ocr_fn),  # 本次建库是否做了图片 OCR（见 _is_fresh）
                "ocr_pages": img_pages,  # 有多少篇带图中文字，便于排查
            },
            f,
            ensure_ascii=False,
        )
    with _lru_lock:
        _lru = None
    return len(corpus)


_building_lock = threading.Lock()
_building = False


def ensure(blocking: bool = True, force: bool = False) -> bool:
    """确保语料新鲜。blocking=False 时若过期/缺失则后台起线程重建一次并返回 False。"""
    global _building
    if not force and _is_fresh():
        return True
    if blocking:
        build()
        return True
    with _building_lock:
        if _building:
            return False
        _building = True

    def _run() -> None:
        global _building
        try:
            build()
        finally:
            with _building_lock:
                _building = False

    threading.Thread(target=_run, daemon=True).start()
    return False


# ---------- 检索（与 api_server 同款 bigram 打分，但覆盖全部正文） ----------


def search(query: str, limit: int = 5):
    """全文召回。语料缺失/过期返回 None（上层回退动态爬取）；命中返回 [{url,title,body}]。"""
    if not _is_fresh():
        return None
    corpus = _load()
    if not corpus:
        return None

    cjk_runs = re.findall(r"[\u4e00-\u9fff]{2,}", query) or []
    # 校区名是高频限定词：若混入 bigram，"卫津路快递"会因"卫津路公交"等文章高分
    # 而把真正含"快递"信息的文章挤出 top3。故把校区名从主题词中剥离，仅作限定。
    _CAMPUS_MARKS = ("卫津路", "北洋园", "老校区", "新校区", "本部", "校区")
    _topic_runs = []
    for run in cjk_runs:
        stripped = run
        for m in _CAMPUS_MARKS:
            stripped = stripped.replace(m, "")
        if stripped:
            _topic_runs.append(stripped)
    if _topic_runs:  # 查询除校区名外确有主题词 → 用主题词检索
        cjk_runs = _topic_runs
    expanded_runs = list(cjk_runs)
    expanded_runs.extend(_synonyms_for(query))
    # 用户原话里的主题词（挂科/保研/宿舍…）：命中标题就是「这篇就是在讲这事」的最强证据
    spoken_terms = _spoken_terms(query)
    bigrams: set[str] = set()
    for run in expanded_runs:
        for i in range(len(run) - 1):
            bigrams.add(run[i : i + 2])

    def hits(text: str) -> int:
        return min(sum(1 for b in bigrams if b in text), 4)

    scored: list[tuple[float, str]] = []
    import datetime as _dt

    _now = _dt.datetime.now()
    _academic_year = _now.year if _now.month >= 9 else _now.year - 1
    # 问学期假期时，应优先用"最新学年"校历页（含学期起止）而不是往年各节假专题
    _holiday_intent = any(
        k in query for k in ("放假", "假期", "寒假", "暑假", "开学", "校历", "学期")
    )
    # 问奖助学金时，最有用的是"当年项目清单"（含金额/人数/可否兼得），而不是往年的评选通知。
    # 实测「奖学金」相关提问会把《20XX 年奖学金与励学金》挤出前列，被一堆单奖项通知顶掉。
    _award_intent = any(
        k in query
        for k in (
            "奖学金",
            "励学金",
            "奖助",
            "助学金",
            "资助",
            "评奖",
            "评优",
            "三好学生",
        )
    )
    for url, doc in corpus.items():
        title, body = doc.get("title", "") or "", doc.get("body", "") or ""
        imgtext = doc.get("imgtext", "") or ""
        # 图片文字（校历/考试安排/专业分流等以图承载）也纳入召回，否则图篇搜不到
        s = hits(title) * 2.0 + hits(body) * 1.0 + hits(imgtext) * 1.2
        if any(t in title for t in spoken_terms):
            s += 7.0  # 标题写着用户口语主题词（《挂科与试读》）→ 最强信号
        elif any(run in title for run in cjk_runs):
            s += 6.0  # 标题含精确查询词 → 强加分
        elif any(run in title for run in expanded_runs):
            s += 3.0  # 标题含官方同义词 → 次强加分
        elif any(run in imgtext for run in cjk_runs):
            s += 2.0  # 正文标题无、但图片文字含精确词 → 仍加分
        if any(run in body for run in cjk_runs):
            s += 1.0
        if any(run in imgtext for run in cjk_runs):
            s += 0.8
        if any(
            k in title
            for k in (
                "指南",
                "攻略",
                "教程",
                "公告",
                "通知",
                "政策",
                "规则",
                "办法",
                "服务",
                "时间",
            )
        ):
            s += 0.4
        m = re.fullmatch(r"(\d{4})", title.strip())
        if m:  # 纯年份标题（校历等逐年文章）分数相近时优先展示较新学年
            s += (int(m.group(1)) - 2000) * 0.001
        if _holiday_intent and title.strip() == str(_academic_year) and imgtext:
            s += 8.0  # 问学期假期时，最新学年校历页强提权，避免被往年节假专题挤出
        if _award_intent:
            # 当年奖助项目清单：标题是「2026 年奖学金与励学金」这种"年份+奖助"形态，
            # 给它强提权，并按年份越新越高——问奖学金时用户要的是"有哪些、多少钱、多少人"。
            ym = re.search(r"(\d{4})\s*年?\s*(奖学金|励学金|奖助|助学金|资助)", title)
            if ym:
                s += 8.0 + (int(ym.group(1)) - 2000) * 0.1
        if s > 0:
            scored.append((s, url))
    scored.sort(key=lambda x: (-x[0], x[1]))
    out = []
    for _s, url in scored[:limit]:
        doc = corpus[url]
        out.append(
            {
                "url": url,
                "title": doc.get("title", ""),
                "body": doc.get("body", ""),
                "imgs": doc.get("imgs", []),
                "imgtext": doc.get("imgtext", ""),
            }
        )
    return out
