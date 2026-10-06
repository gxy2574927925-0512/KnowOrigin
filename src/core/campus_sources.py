"""校园多信源抓取：北洋维基 + 天大官网矩阵 + 微信公众号。

背景（海小棠为什么"爬不到有用信息"）：
1. ``wiki_corpus`` 顶层 import bs4/trafilatura，而 venv 里没装这两个包，
   于是 ``import wiki_corpus`` 抛 ImportError，被 ``_fetch_wiki`` 的
   ``except Exception`` 静默吞掉 → 北洋维基**一条都取不到**；
2. 官网只扫 ``www.tju.edu.cn`` 首页的锚文本、不抓正文，拿回来多是导航词；
3. 微信公众号完全没有接入。

本模块把三类信源收敛成一个 ``search(query)``：
- **官网矩阵**：从官网/新闻网/教务处/研究生院/图书馆的列表页枚举文章链接，
  按 bigram 打分取 top-N 抓正文。教务处公告栏大量直接指向
  ``mp.weixin.qq.com``，等于顺手拿到了"天津大学/教务处公众号"的最新推文。
- **微信公众号**：搜狗微信搜索（type=2）按关键词检索文章，还原跳转链接抓正文，
  覆盖「天津大学团委」这类不在官网公告栏出现的号。
- **北洋维基**：走 ``wiki_corpus`` 的离线全站正文语料。

工程约束：全部请求带超时 / 字节上限 / 编码兜底；索引与正文落盘缓存
（``data/campus_cache.json``），任一信源失败只影响它自己，绝不拖垮整次问答。
"""

from __future__ import annotations

import html
import http.cookiejar
import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import quote, urljoin, urlsplit

try:  # 清单模块只依赖 stdlib，缺了也不该让抓取整体挂掉
    from . import wx_accounts
except Exception:  # pragma: no cover - 直接以脚本方式跑时回退
    try:
        import wx_accounts  # type: ignore
    except Exception:
        wx_accounts = None  # type: ignore

LOGGER = logging.getLogger("knoworigin.campus")

_BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "data")
_BASE = os.path.normpath(_BASE)
CACHE_PATH = os.path.join(_BASE, "campus_cache.json")
# 公众号订阅库：从官网列表页捞到的 mp.weixin.qq.com 直链，抓元信息后落盘。
# 这是「不提问也不会错过」的那一半——搜狗微信索引已停更，拿不到新推文，
# 但官网公告栏会同步自己家的推文，那条路稳定且不怕限流。
WX_FEED_PATH = os.path.join(_BASE, "wx_feed.json")

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
HEADERS = {"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9"}

TIMEOUT = 8  # 单次 GET 超时
# 单页最多读多少字节。公众号页头部有大量内联脚本，实测正文容器 <div id="js_content">
# 出现在 ~510KB 处，读太少会拿到"半截页面"，从残页里拼出来的正文是假的——
# 所以这里给足 1.2MB（约 1s/页），并用 _looks_truncated 兜住"读了一半"的情况。
MAX_BYTES = 1_200_000
# 列表页索引缓存时长。官网公告栏是"最新通知"的主入口，原来 6 小时意味着刚发布的
# 通知最多要等 6 小时才被看见 —— 对"别错过"这个目标来说太慢，缩到 1 小时；
# 配合下面的 stale-while-revalidate（过半生命期就后台续期），用户不会为刷新买单。
INDEX_TTL = 3600
BODY_TTL = 7 * 86400  # 正文缓存时长（文章内容不会变，长缓存没问题）
SOGOU_TTL = 2 * 3600  # 搜狗搜索结果缓存时长（它有限流，同一问题别反复打）
MAX_BODY_CHARS = 2400  # 单篇正文入库上限
STALE_DAYS = 400  # 超过这个天数的文章要标"可能已过期"
SOGOU_MIN_INTERVAL = 0.35  # 两次搜狗请求的最小间隔（秒），避免被判定为爬虫
SOGOU_COOLDOWN = 1800  # 触发反爬后的静默期（秒）：期间不再打搜狗，改用其它信源

# ---------------------------------------------------------------- 信源入口
# (信源名, 列表页)。列表页只用来"枚举链接"，正文一律去详情页抓。
# 「研究生招生网」单列出来是因为**推免/保研的正式公告只发在这里**：
# 教务处与官网首页只放教学通知，保研细则/复试办法在研招网的"最新消息"里。
OFFICIAL_SEEDS: list[tuple[str, str]] = [
    ("天津大学官网", "https://www.tju.edu.cn/"),
    ("天津大学官网·通知公告", "https://www.tju.edu.cn/tzgg.htm"),
    ("天津大学官网·奖助信息", "https://www.tju.edu.cn/zsjy/jzxx.htm"),
    ("天津大学新闻网", "https://news.tju.edu.cn/"),
    ("天津大学教务处", "https://oaa.tju.edu.cn/"),
    ("天津大学教务处·通知公告", "https://oaa.tju.edu.cn/tzgg.htm"),
    ("天津大学研究生院", "https://gs.tju.edu.cn/"),
    ("天津大学研究生院·学位通知", "https://gs.tju.edu.cn/xwydsgz/xwtz.htm"),
    ("天津大学研究生招生网", "https://yzb.tju.edu.cn/"),
    ("天津大学图书馆", "https://lib.tju.edu.cn/"),
    ("天津大学本科招生网", "https://zs.tju.edu.cn/"),
    ("天津大学就业指导中心", "https://job.tju.edu.cn/"),
    ("天津大学国际处", "https://ico.tju.edu.cn/"),
    ("天津大学体育部", "https://tyb.tju.edu.cn/"),
    ("天津大学档案馆", "https://dag.tju.edu.cn/"),
    # 院系官网：**学院级通知（推免实施细则、评奖评优、学生活动）只在学院站发**，
    # 校级站一律没有，不接就只能答"资料里没查到"。先接精仪（用户本院）。
    ("精仪学院", "https://jyxy.tju.edu.cn/cn/index.shtml"),
    ("精仪学院·学院新闻", "https://jyxy.tju.edu.cn/cn/new/index.shtml"),
    ("精仪学院·学生工作", "https://jyxy.tju.edu.cn/cn/xsgz/hdfc/index.shtml"),
    ("精仪学院·学术活动", "https://jyxy.tju.edu.cn/cn/xyfc/xshd/index.shtml"),
    # 其余院系官网：域名经实测逐个核对（学院站命名无规律，官网的院系介绍页不给外链，
    # 只能手工登记）。加这些站的主要目的是**顺带捞到它们同步的公众号推文**——
    # 实测教务处 49 条、药学院 25 条、自动化 11 条、医学部/体育部 10 条 mp 直链。
    ("机械工程学院", "https://me.tju.edu.cn/"),
    ("电气自动化与信息工程学院", "https://seea.tju.edu.cn/"),
    ("智能与计算学部", "https://cic.tju.edu.cn/"),
    ("微电子学院", "https://sme.tju.edu.cn/"),
    ("药物科学与技术学院", "https://spst.tju.edu.cn/"),
    ("医学部", "https://health.tju.edu.cn/"),
    ("管理与经济学部", "https://come.tju.edu.cn/"),
    ("建筑学院", "https://arch.tju.edu.cn/"),
    ("建筑工程学院", "https://jgxy.tju.edu.cn/"),
    ("材料科学与工程学院", "https://mse.tju.edu.cn/"),
    ("理学院", "https://science.tju.edu.cn/"),
    ("数学学院", "https://math.tju.edu.cn/"),
    ("地球系统科学学院", "https://earth.tju.edu.cn/"),
    ("外国语学院", "https://tjusfl.tju.edu.cn/"),
    ("人文艺术学院", "https://rwys.tju.edu.cn/"),
    ("国际教育学院", "https://sie.tju.edu.cn/"),
    ("校友会", "https://alumni.tju.edu.cn/"),
]

# 关注度最高的几个官方公众号：命中这些号的检索结果优先展示。
# 以公众号清单（core/wx_accounts.py）为准，并补上清单外但确实存在的老牌官方号。
KNOWN_ACCOUNTS: tuple[str, ...] = tuple(
    dict.fromkeys(
        (wx_accounts.all_names() if wx_accounts else [])
        + [
            "天津大学",
            "天津大学团委",
            "天津大学学生社团团委",
            "天津大学教务处",
            "天津大学研究生招生",
            "天津大学图书馆",
            "天津大学学生工作",
            "天津大学招生办",
            "天大学生资助",
            "天津大学精仪学院",
            "天津大学研究生院",
        ]
    )
)

# 问这类问题时，额外补一条"带机构名"的检索（搜狗对纯关键词的召回很泛，
# 加上机构名才能把本校公众号的内容顶上来）
_TUANWEI_HINTS = (
    "团委",
    "社团",
    "志愿",
    "实践",
    "团日",
    "青马",
    "支教",
    "学生活动",
    "第二课堂",
)
_AWARD_HINTS = (
    "奖学金",
    "励学金",
    "助学金",
    "资助",
    "评奖",
    "评优",
    "三好学生",
    "优秀学生",
    "国家奖学金",
    "国奖",
)
_COLLEGE_RE = re.compile(r"([\u4e00-\u9fff]{2,6}学院)")

# 天大相关的判定词：搜狗是全网检索，不做这层闸门会把"哈工程保研政策""河南省图书馆"
# 这类别校内容也捞进来，对校内问答全是噪声。
_TJU_MARKS = ("天津大学", "天大", "北洋", "卫津路", "北洋园", "郑东图书馆", "求实")


def _tju_related(item: dict) -> bool:
    blob = f"{item.get('account') or ''} {item.get('title') or ''} {item.get('snippet') or ''}"
    return any(mark in blob for mark in _TJU_MARKS)


# 校区名/疑问词/时间词是搜索噪声：送进搜索引擎前先剥掉，否则关键词全被它们占满
_NOISE_WORDS = (
    "卫津路校区",
    "北洋园校区",
    "卫津路",
    "北洋园",
    "老校区",
    "新校区",
    "南区",
    "北区",
    "请问",
    "问一下",
    "我想知道",
    "想知道",
    "怎么样",
    "怎么办",
    "是什么",
    "有哪些",
    "什么时候",
    "多长时间",
    "如何",
    "怎么",
    "多少",
    "哪些",
    "是不是",
    "有没有",
    "这个",
    "那个",
    "一下",
    "请问一下",
    "吗",
    "呢",
    "啊",
    "今年",
    "去年",
    "明年",
    "最近",
    "现在",
    "目前",
    "往年",
    "本学年",
    "上一学年",
    "这学期",
    "本学期",
    "的",
    "了",
)

# 轻量分词词表：搜狗对长中文串是按整串 AND 匹配的，"精仪学院国奖比例"当一整串去搜
# 基本什么都搜不到。这里做贪心最长匹配切词，让它变成「精仪学院 国奖 比例」。
_SPLIT_WORDS = (
    # 机构名排前面（最长匹配优先）
    "天津大学",
    "精仪学院",
    "精密仪器与光电子工程学院",
    "奖学金",
    "励学金",
    "助学金",
    "国家奖学金",
    "国奖",
    "资助",
    "评优",
    "评奖",
    "评选",
    "三好学生",
    "优秀学生",
    "标兵",
    "比例",
    "名额",
    "细则",
    "时间",
    "申请",
    "条件",
    "流程",
    "通知",
    "名单",
    "公示",
    "办法",
    "规定",
    "学院",
    "学部",
    "专业",
    "课程",
    "开放",
    "预约",
    "借阅",
    "放假",
    "校历",
    "考试",
    "成绩",
    "宿舍",
    "食堂",
    "班车",
    "快递",
    "报名",
    "复试",
    "推免",
    "保研",
    "考研",
    "图书馆",
    "教学楼",
    "校园卡",
    "转专业",
    "辅修",
    "微专业",
    "社团",
    "志愿",
    "团委",
    "就业",
    "实习",
    "医院",
)


def _segment_cjk(text: str) -> list[str]:
    """按 _SPLIT_WORDS 贪心最长匹配切词；未命中的字先攒着，最后并入上一段。"""
    words: list[str] = []
    buf = ""
    i = 0
    while i < len(text):
        hit = ""
        for word in _SPLIT_WORDS:
            if len(word) > len(hit) and text.startswith(word, i):
                hit = word
        if hit:
            if buf:
                words.append(buf)
                buf = ""
            words.append(hit)
            i += len(hit)
        else:
            buf += text[i]
            i += 1
    if buf:
        # 尾巴并进上一段，但只并短碎片（≤2 字）；否则单独成词，别把好不容易切开的长串又粘回去
        if words and len(buf) <= 2:
            words[-1] += buf
        else:
            words.append(buf)
    return words


_CAMPUS_MARKS = ("卫津路", "北洋园", "老校区", "新校区", "本部", "校区")

# 口语 → 官方措辞，扩展检索锚点。键只要**出现在问题里**就会触发扩展（见 _query_terms），
# 不必整句等于键。完整词表在 core/campus_lexicon（wiki_corpus 也读同一张，避免两处漂移）；
# 下面是共享词表导入失败时的降级兜底。
_FALLBACK_SYNONYMS = {
    "保研": ["推免", "推荐免试", "免试推荐"],
    "考研": ["硕士招生", "研究生招生"],
    "空闲教室": ["自习室"],
    "班车": ["校区间", "通勤"],
    "食堂": ["餐厅", "饮食"],
    "挂科": ["补考", "重修"],
    "转专业": ["专业分流", "大类分流"],
    "期末": ["考试安排", "考试周"],
    "考试": ["考试安排", "考务"],
    "开学": ["校历", "学期"],
    "放假": ["校历", "假期"],
    "奖学金": ["评奖评优", "奖励"],
    "宿舍": ["住宿", "公寓"],
    "校园卡": ["一卡通"],
    "挂号": ["校医院", "就医"],
}

try:
    from core import campus_lexicon as _campus_lexicon

    SYNONYMS = {
        spoken: list(official) for spoken, official in _campus_lexicon.SYNONYMS.items()
    }
except Exception:  # noqa: BLE001 - 词表不可用不应影响检索
    SYNONYMS = _FALLBACK_SYNONYMS

_HAS_BS4 = True
try:  # bs4 已在 requirements.txt 中声明；缺了也不静默——下面只降级一次并告警
    from bs4 import BeautifulSoup  # type: ignore
except Exception:  # pragma: no cover - 仅在依赖缺失时触发
    _HAS_BS4 = False
    BeautifulSoup = None  # type: ignore
    LOGGER.error(
        "campus_sources: 未安装 beautifulsoup4，正文提取降级为纯文本正则。"
        "请执行 pip install -r requirements.txt 补齐依赖。"
    )


# ---------------------------------------------------------------- HTTP 基础


def _encode_url(url: str) -> str:
    """把 href 里的裸空格等控制字符编码掉，否则 urllib 会因 invalid URL 直接抛错。"""
    return re.sub(r"[\x00-\x20\x7f]", lambda m: quote(m.group(0)), url.strip())


# 搜狗的 /link?url=... 跳转要靠会话 cookie 才给还原脚本，所以必须带 CookieJar。
_COOKIE_JAR = http.cookiejar.CookieJar()
_OPENER = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_COOKIE_JAR))


def http_get(
    url: str,
    *,
    timeout: float = TIMEOUT,
    referer: str | None = None,
    cap: int = MAX_BYTES,
) -> tuple[str, str]:
    """返回 (文本, 最终 URL)；失败返回 ("", url)。编码按 utf-8 → gbk 兜底。"""
    headers = dict(HEADERS)
    if referer:
        headers["Referer"] = referer
    req = urllib.request.Request(_encode_url(url), headers=headers)
    try:
        with _OPENER.open(req, timeout=timeout) as resp:
            raw = resp.read(cap)
            final = resp.geturl() or url
    except Exception as exc:  # noqa: BLE001 - 单页失败是可预期的，交给调用方降级
        LOGGER.debug("campus_sources GET failed: %s (%s)", url, exc)
        return "", url
    for enc in ("utf-8", "gbk", "gb18030"):
        try:
            return raw.decode(enc), final
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "ignore"), final


def _strip_tags(fragment: str) -> str:
    text = re.sub(r"<script[\s\S]*?</script>", " ", fragment, flags=re.I)
    text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


_A_HREF_RE = re.compile(
    r"<a\b[^>]*?href\s*=\s*[\"']([^\"']+)[\"'][^>]*>([\s\S]*?)</a>", re.I
)


def extract_links(page: str, base_url: str) -> list[tuple[str, str]]:
    """纯 stdlib 抽取页面内链 [(绝对URL, 锚文本)]，不依赖 bs4。"""
    out: list[tuple[str, str]] = []
    for href, inner in _A_HREF_RE.findall(page or ""):
        href = href.strip()
        if not href or href.startswith(("#", "javascript:", "mailto:", "tel:")):
            continue
        title = _strip_tags(inner)
        if not title:
            continue
        out.append((urljoin(base_url, html.unescape(href)), title))
    return out


# ---------------------------------------------------------------- 磁盘缓存

_cache_lock = threading.Lock()
_cache: dict | None = None


def _load_cache() -> dict:
    global _cache
    with _cache_lock:
        if _cache is None:
            try:
                with open(CACHE_PATH, "r", encoding="utf-8") as fh:
                    _cache = json.load(fh)
            except Exception:
                _cache = {}
            if not isinstance(_cache, dict):
                _cache = {}
        return _cache


def _save_cache() -> None:
    """落盘缓存，顺手清理过期条目（正文缓存会越攒越大，不清理会无上限增长）。"""
    cutoff = time.time() - BODY_TTL
    with _cache_lock:
        data = {
            key: item
            for key, item in (_cache or {}).items()
            if isinstance(item, dict) and float(item.get("ts") or 0) >= cutoff
        }
        _cache.clear()
        _cache.update(data)
    try:
        os.makedirs(_BASE, exist_ok=True)
        tmp = CACHE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False)
        os.replace(tmp, CACHE_PATH)
    except Exception as exc:  # noqa: BLE001 - 缓存写失败不影响本次问答
        LOGGER.debug("campus_sources: 缓存写入失败 %s", exc)


def _cache_get(key: str, ttl: float) -> dict | None:
    item = _load_cache().get(key)
    if isinstance(item, dict) and (time.time() - float(item.get("ts") or 0)) < ttl:
        return item
    return None


def _cache_put(key: str, payload: dict) -> None:
    cache = _load_cache()
    with _cache_lock:
        cache[key] = {"ts": time.time(), **payload}


# ---------------------------------------------------------------- 正文提取

# 各站正文容器，按"命中即用"的顺序排：
#   #js_content        微信公众号文章
#   v_news_content    天大新闻网 / 学校站群（VSB）
#   #zoom / TRS_Editor  TRS 站群（研招网、部分院系）——保研/推免公告都在这套 CMS 上
_BODY_SELECTORS = (
    "#js_content",
    "div.v_news_content",
    "#vsb_content",
    "#vsb_content_2",
    "#vsb_content_4",
    "#vsb_content_6",
    "td#zoom",
    "#zoom",
    "div.TRS_Editor",
    "div.article-content",
    "div.article_content",
    "div.news_content",
    "div.content",
    "div.article",
    "article",
    "#content",
)


def _meta(page: str, name: str) -> str:
    m = re.search(
        r"<meta[^>]+(?:property|name)\s*=\s*[\"']"
        + re.escape(name)
        + r"[\"'][^>]*content\s*=\s*[\"']([^\"']*)[\"']",
        page or "",
        re.I,
    )
    if not m:
        m = re.search(
            r"<meta[^>]+content\s*=\s*[\"']([^\"']*)[\"'][^>]*(?:property|name)\s*=\s*[\"']"
            + re.escape(name)
            + r"[\"']",
            page or "",
            re.I,
        )
    return re.sub(r"\s+", " ", html.unescape(m.group(1))).strip() if m else ""


def _title_of(page: str, soup) -> str:
    if soup is not None:
        for sel in ("#activity-name", "h1"):
            node = soup.select_one(sel)
            if node:
                text = re.sub(r"\s+", " ", node.get_text(" ", strip=True)).strip()
                if text:
                    return text
        if soup.title:
            text = re.sub(r"\s+", " ", soup.title.get_text(" ", strip=True)).strip()
            if text:
                return re.sub(r"[｜|_\-–—].*$", "", text).strip()
    og = _meta(page, "og:title")
    if og:
        return og
    m = re.search(r"<title[^>]*>([\s\S]*?)</title>", page or "", re.I)
    if m:
        return re.sub(r"[｜|_\-–—].*$", "", _strip_tags(m.group(1))).strip()
    return ""


def _account_of(page: str, soup) -> str:
    """公众号名 / 站点名。og:site_name 在公众号页恒为"微信公众平台"，没有信息量，丢弃。"""
    if soup is not None:
        for sel in ("#js_name", ".rich_media_meta_nickname", "a#js_name"):
            node = soup.select_one(sel)
            if node:
                text = re.sub(r"\s+", " ", node.get_text(" ", strip=True)).strip()
                if text:
                    return text
    site = _meta(page, "og:site_name")
    return "" if site in ("微信公众平台", "微信", "WeChat") else site


def _looks_truncated(page: str) -> bool:
    """页面是否被字节上限截断（没有收尾 </html>）。截断页不能当正文用。"""
    tail = (page or "")[-4000:].lower()
    return "</html>" not in tail


_SITE_NAME_RE = re.compile(r"(网|官网|首页|门户|研究生院|教务处|图书馆|新闻网|大学)$")


def _is_site_name(title: str, site: str = "") -> bool:
    """判断抽到的"标题"是不是站点名（TRS/VSB 站群的详情页 <title> 常写成站名）。

    站群还会写出「欢迎访问天大精仪办公网！」这类带标点的欢迎语，先剥掉尾部标点再判。
    """
    text = (title or "").strip()
    if not text:
        return True
    if site and text == site.strip():
        return True
    if text.startswith(("欢迎访问", "欢迎来到")):
        return True
    return len(text) <= 12 and bool(_SITE_NAME_RE.search(text.rstrip("！!。.？?　 ")))


def extract_article(page: str, url: str, fallback_title: str = "") -> dict:
    """从详情页提取 {title, body, account}。fallback_title 一般是列表页锚文本。"""
    soup = None
    if _HAS_BS4:
        try:
            soup = BeautifulSoup(page or "", "html.parser")
        except Exception:
            soup = None

    body = ""
    matched_container = False
    if soup is not None:
        for sel in _BODY_SELECTORS:
            try:
                node = soup.select_one(sel)
            except Exception:
                continue
            if node is None:
                continue
            text = node.get_text(" ", strip=True)
            # 避开把整页正文都算进来的兜底容器（导航+页脚会稀释正文）
            if len(text) >= 80:
                body = text
                matched_container = True
                break

    if not matched_container and _looks_truncated(page):
        # 页面读了一半 → 宁可为空，也不要从残页里拼出一段看着像正文的假内容
        LOGGER.debug("campus_sources: 页面被截断且未命中正文容器，丢弃 %s", url)
        return {"url": url, "title": _title_of(page, soup), "body": "", "account": ""}

    if len(body) < 200:
        # 兜底一：trafilatura（正文里图片/表格较多的公众号页效果最好）
        try:
            import trafilatura  # type: ignore

            alt = (
                trafilatura.extract(
                    page or "", include_comments=False, include_tables=True
                )
                or ""
            )
            if len(alt) > len(body):
                body = alt
        except Exception:
            pass
    if len(body) < 80:
        # 兜底二：纯文本剥标签（bs4/trafilatura 都不可用时仍能出内容）
        body = _strip_tags(page or "")

    body = re.sub(r"\s+", " ", body).strip()
    # 公众号页正文常被"点击蓝字 关注我们"之类的引流语污染，清掉
    body = re.sub(
        r"^(点击(蓝字|上方)[^。]{0,20}(关注我们|关注|星标)[！!。\s]*)", "", body
    ).strip()

    title = _title_of(page, soup)
    if _is_site_name(title, _meta(page, "og:site_name")) and fallback_title:
        # <title> 只是站名时，列表页锚文本反而是真标题
        title = fallback_title.strip()

    return {
        "url": url,
        "title": title,
        "body": body[:MAX_BODY_CHARS],
        "account": _account_of(page, soup),
    }


# ---------------------------------------------------------------- 打分

# 这些词做"锚点"太泛，会把什么都放进来（但送搜索引擎当限定词是有用的，别从 _SPLIT_WORDS 删）：
# 「图书馆开放时间」切出「开放」「时间」，水利基金指南沾个"开放"就能混进来。
_GENERIC_ANCHORS = {
    "天津大学",
    "天大",
    "北洋",
    "学校",
    "校区",
    "学院",
    "学部",
    "老师",
    "同学",
    "学生",
    "通知",
    "公告",
    "活动",
    "工作",
    "时间",
    "开放",
    "比例",
    "条件",
    "要求",
    "安排",
    "申请",
    "报名",
    "流程",
    "办法",
    "规定",
    "名单",
    "公示",
    "情况",
    "相关",
    "问题",
    "有哪些",
    "是什么",
    "怎么样",
    "多少",
    "哪些",
    "怎么",
    "什么",
    "进行",
    "关于",
    "以及",
    "专业",
    "课程",
    "考试",
    "成绩",
    "宿舍",
    "食堂",
    "校园卡",
    "服务",
}


def _query_terms(query: str) -> tuple[list[str], set[str]]:
    """返回 (检索锚点, 二元词集合)。

    锚点 = 整串主题词（命中有强加分）+ 分词后的小词（提高召回）+ 官方同义词。
    - 分词是必须的：「精仪学院国奖比例」整串永远匹配不上任何标题，切成
      「精仪学院 / 国奖 / 比例」才能命中《精仪学院…国家奖学金评选通知》。
    - 同义词**按子串在整句里探测**：「保研政策细则」整串查不到 SYNONYMS 的键，
      但含「保研」→ 加上 推免 / 推荐免试，才能命中《推荐免试研究生…》。
    中文不分词，宽召回靠重叠 bigram 打分。
    """
    runs = re.findall(r"[\u4e00-\u9fff]{2,}", query or "") or []
    topic = []
    for run in runs:
        stripped = run
        for mark in _CAMPUS_MARKS:
            stripped = stripped.replace(mark, "")
        if stripped:
            topic.append(stripped)

    anchors: list[str] = []

    def add(term: str, *, keep_generic: bool = False) -> None:
        term = (term or "").strip()
        if len(term) < 2 or term in anchors:
            return
        if not keep_generic and term in _GENERIC_ANCHORS:
            return
        anchors.append(term)

    for run in topic or runs:
        add(run, keep_generic=True)  # 整串：再泛也要留，它是原问句
        for word in _segment_cjk(run):
            add(word)  # 分词小词：泛词丢掉，否则闸门形同虚设
    for spoken, official in SYNONYMS.items():
        if spoken in (query or ""):
            for word in official:
                add(word)
    if not anchors:
        add(query or "天津大学", keep_generic=True)

    bigrams = {a[i : i + 2] for a in anchors for i in range(len(a) - 1)}
    return anchors, bigrams


def _bigram_hits(text: str, bigrams: set[str]) -> int:
    return sum(1 for b in bigrams if b in text) if bigrams and text else 0


def _anchor_hit(blob: str, anchors: list[str]) -> bool:
    """锚点是否在标题/正文里"真命中"。

    整词出现当然算命中；否则退一步看 bigram 覆盖率，但**要求锚点末二字也出现**——
    否则「天津大学团委」会被「习近平给天津大学全体师生回信」这种只share了
    "天津大学"的稿子判成命中（中文复合词的中心语在尾部，"团委"才是关键）。
    """
    for anchor in anchors:
        if anchor in blob:
            return True
        bigrams = {anchor[i : i + 2] for i in range(len(anchor) - 1)}
        if not bigrams:
            continue
        need = max(2, -(-len(bigrams) * 3 // 5))  # ceil(60%)
        if anchor[-2:] in blob and sum(1 for b in bigrams if b in blob) >= need:
            return True
    return False


def _score(title: str, body: str, runs: list[str], bigrams: set[str]) -> float:
    def hits(text: str, cap: int = 4) -> int:
        return min(sum(1 for b in bigrams if b in text), cap) if bigrams else 0

    score = hits(title) * 2.0 + hits(body) * 1.0
    # 锚点命中标题按"锚点有多具体"加权：切词后锚点有长有短，
    # 一律 +6 会让「比例」这种泛词把「精仪学院」这种特征词的差距抹平。
    best_anchor = max((len(run) for run in runs if run in title), default=0)
    if best_anchor:
        score += min(6.0, 2.0 + best_anchor)
    elif any(run in body for run in runs):
        score += 1.5
    if any(
        k in title
        for k in (
            "通知",
            "公告",
            "公示",
            "办法",
            "规定",
            "指南",
            "安排",
            "启动",
            "名单",
            "细则",
        )
    ):
        score += 0.6
    return score


def _keywords_for_engine(
    query: str, max_terms: int = 4, drop: tuple[str, ...] = (), segment: bool = True
) -> str:
    """把自然语言问题压成搜索引擎友好的关键词串。

    segment=True 走轻量分词；=False 保留整串。搜狗对这两种形态给的结果不一样
    （整串更精准、分词召回更宽），所以调用方通常**两种都发一遍**。
    """
    text = query or ""
    for word in _NOISE_WORDS:
        text = text.replace(word, " ")

    terms: list[str] = []
    for chunk in re.findall(r"[\u4e00-\u9fff]{2,}|[A-Za-z0-9]{2,}", text):
        chunk = chunk.strip()
        if not chunk or chunk in _NOISE_WORDS:
            continue
        pieces = (
            [chunk]
            if (not segment or re.fullmatch(r"[A-Za-z0-9]+", chunk))
            else _segment_cjk(chunk)
        )
        for term in pieces:
            term = term.strip()
            if len(term) < 2 or term in _NOISE_WORDS:
                continue
            if any(term == d or term in d for d in drop):
                continue
            if term not in terms:
                terms.append(term)
    if not terms:
        terms = [query.strip()] if (query or "").strip() else ["天津大学"]
    return " ".join(terms[:max_terms])


# ---------------------------------------------------------------- 信源 1：官网矩阵


def _is_official_article(url: str) -> bool:
    """只认"详情页"形态的链接，栏目页/导航页一律不要。

    天大各站群的详情页命名有好几套：
      /info/1002/610939.htm                    （学校站群 VSB）
      /xwzx/zxxx/202609/t20260908_324696.htm  （研招网）
      /info/1181/20442.htm
    共同点是**文件名里带 3 位以上数字**；而栏目页都是 /tzgg.htm、/xwtz.htm 这类纯字母。
    """
    if "mp.weixin.qq.com/s" in url:
        return True
    path = urlsplit(url).path
    if not re.search(r"\.(?:htm|html|shtml)$", path, re.I):
        return False
    tail = path.rsplit("/", 1)[-1]
    return bool(re.search(r"\d{3,}", tail))


def _looks_like_article(body: str) -> bool:
    """粗判是不是正文页：导航页几乎没有句末标点，正文页一定有。"""
    if len(body) < 120:
        return False
    punct = len(re.findall(r"[。！？；]", body))
    return punct >= 3


# _index_lock 只管"同一时刻只有一个人在建索引"；worker 往 items/seen 里写必须用
# **另一把锁**。曾经直接复用 _index_lock，结果是死锁：主线程拿着它等 as_completed，
# worker 又拿着待收的结果等这把锁——谁也不放，索引永远建不完，「校园速递」永远是 0 条。
_index_lock = threading.Lock()
_harvest_lock = threading.Lock()
_index_async_lock = threading.Lock()
_index_async_running = False


def _refresh_index_async() -> None:
    """后台重建官网索引（同时只跑一个）。

    stale-while-revalidate：缓存过半生命期就先返回旧索引、后台悄悄换新。
    否则一到过期点，第一个提问的用户要同步等一次全量抓取（30+ 个列表页）。
    """
    global _index_async_running
    with _index_async_lock:
        if _index_async_running:
            return
        _index_async_running = True

    def _run() -> None:
        global _index_async_running
        try:
            _official_index(force=True)
        except Exception as exc:  # noqa: BLE001
            LOGGER.debug("campus_sources: 官网索引后台续期失败 %s", exc)
        finally:
            with _index_async_lock:
                _index_async_running = False

    threading.Thread(target=_run, name="official-index-refresh", daemon=True).start()


def _official_index(force: bool = False) -> list[dict]:
    """枚举官网矩阵的文章链接，缓存 INDEX_TTL。返回 [{title,url,source}]。

    新鲜度策略（这条曾经把问答堵死几分钟，别改回去）：
    - 缓存新鲜 → 直接用；过半生命期 → 后台悄悄换新；
    - **缓存过期但手里还有旧数据 → 照样先返回旧数据，后台换新**。
      36 个列表页全量抓一遍要几分钟，让提问的人同步等这么久，表现就是
      海小棠永远停在"正在琢磨"。旧索引最多旧 1 小时，比把人挂住强得多。
    - 只有**第一次**（手里完全没有数据）才同步建——而它在启动预热里就已经做了。
    """
    if not force:
        cached = _cache_get("index:official", INDEX_TTL)
        if cached and cached.get("items"):
            # 过半生命期 → 后台换新，本次仍用旧索引返回（用户感觉不到）
            if (time.time() - float(cached.get("ts") or 0)) > INDEX_TTL * 0.5:
                _refresh_index_async()
            return cached["items"]
        # 过期但手里有旧数据 → 照样秒回旧数据 + 后台换新。
        # 这一步必须在拿 _index_lock **之前**：后台刷新线程拿着这把锁一建就是几分钟，
        # 请求哪怕只想读旧缓存，也会堵在锁外面挂到超时（实测把海小棠挂满 300s 的就是它）。
        stale = _cache_get("index:official", 10**9)
        if stale and stale.get("items"):
            _refresh_index_async()
            return stale["items"]

    # 加锁：冷启动时可能有多个请求同时想建索引，别让它们各爬一遍
    with _index_lock:
        # 双检：排到锁时后台可能已经建好了
        ready = _cache_get("index:official", 10**9)
        if not force and ready and ready.get("items"):
            return ready["items"]

        items: list[dict] = []
        seen: set[str] = set()

        def harvest(source: str, page_url: str) -> None:
            page, _final = http_get(page_url)
            if not page:
                return
            found: list[tuple[str, str]] = []
            for url, title in extract_links(page, page_url):
                if not _is_official_article(url):
                    continue
                if len(title) < 6 or len(title) > 90:
                    continue
                found.append((url, title))
            # 入队时加锁统一编号：seq 取"全局累进序号"，列表页基本按发布时间倒序，
            # 所以它是一份「拿不到真实发布时间时的相对时序」（订阅库用它兜底排序）。
            # 编号若放到并发外面算，len(items) 会在多线程下取到重复值。
            # 注意用的是 _harvest_lock：主线程此刻正拿着 _index_lock 等 as_completed，
            # worker 再去抢它就是自锁。
            with _harvest_lock:
                for url, title in found:
                    if url in seen:
                        continue
                    seen.add(url)
                    items.append(
                        {
                            "title": title,
                            "url": url,
                            "source": source,
                            "seed": source,
                            "seq": len(items),
                        }
                    )

        # 并发别开太大：seed 已有 30+ 个，一次性放 30 个连接会被校方网关拒掉
        # （实测 24 并发时全部 ConnectionError，降到 4~8 才稳定）。
        with ThreadPoolExecutor(
            max_workers=min(8, max(1, len(OFFICIAL_SEEDS)))
        ) as pool:
            futs = [pool.submit(harvest, src, url) for src, url in OFFICIAL_SEEDS]
            for fut in as_completed(futs):
                try:
                    fut.result()
                except Exception as exc:  # noqa: BLE001
                    LOGGER.debug("campus_sources: 官网索引分片失败 %s", exc)

        if items:
            _cache_put("index:official", {"items": items})
            _save_cache()
    return items


_DATE_IN_URL_RE = re.compile(r"/(20\d{2})(\d{2})(\d{2})/")


def _date_from_url(url: str) -> int:
    """从详情页 URL 里抠发布日期（天大站群习惯把日期编进路径，如 /20260910/2491.shtml）。

    有日期才能判新旧：官网列表页混着好几年前的稿子，不判新旧就会拿 2022 年的通知
    回答 2026 年的问题。返回 Unix 时间戳，取不到返回 0。
    """
    m = _DATE_IN_URL_RE.search(url or "")
    if not m:
        return 0
    try:
        return int(time.mktime(time.strptime("".join(m.groups()), "%Y%m%d")))
    except Exception:
        return 0


def _fetch_bodies(candidates: list[dict]) -> list[dict]:
    """并行抓正文，命中缓存则直接复用。candidates 由调用方自行限量。"""
    out: list[dict] = []
    todo: list[dict] = []
    for cand in candidates:
        cached = _cache_get("body:" + cand["url"], BODY_TTL)
        if cached and cached.get("body"):
            out.append(
                {
                    **cand,
                    "ts": _date_from_url(cand["url"]),
                    **{
                        k: cached.get(k)
                        for k in ("title", "body", "account")
                        if cached.get(k)
                    },
                }
            )
        else:
            todo.append(cand)

    if todo:
        with ThreadPoolExecutor(max_workers=min(6, len(todo))) as pool:
            futs = {pool.submit(http_get, item["url"]): item for item in todo}
            for fut in as_completed(futs):
                item = futs[fut]
                try:
                    page, final = fut.result()
                except Exception:  # noqa: BLE001
                    continue
                if not page:
                    continue
                art = extract_article(
                    page, final or item["url"], fallback_title=item["title"]
                )
                if not _looks_like_article(art["body"]):
                    continue
                _cache_put(
                    "body:" + item["url"],
                    {
                        "title": art["title"],
                        "body": art["body"],
                        "account": art["account"],
                    },
                )
                out.append(
                    {
                        "url": item["url"],
                        "source": _source_label(item["source"], art.get("account")),
                        "title": art["title"] or item["title"],
                        "body": art["body"],
                        "account": art.get("account") or "",
                        "ts": _date_from_url(item["url"]),
                    }
                )
    _save_cache()
    return out


def _source_label(seed_source: str, account: str) -> str:
    """公众号文章标成"微信公众号·xxx"，官网文章标成站点名。"""
    account = (account or "").strip()
    if account and (
        account in KNOWN_ACCOUNTS
        or account.startswith("天津大学")
        or account.endswith("团委")
    ):
        return f"微信公众号·{account}"
    return seed_source


def search_official(query: str, limit: int = 3) -> list[dict]:
    """官网矩阵（含官网转载的公众号推文）检索。

    两段式：先按标题 bigram 筛候选；标题全不命中时退回最近的若干条去抓正文，
    再按正文打分。**最终只保留真正命中的**——宁可不返回，也不要拿无关的校园新闻
    去稀释上下文（这正是以前"看起来答了、其实全是导航词"的老毛病）。
    """
    index = _official_index()
    if not index:
        return []
    runs, bigrams = _query_terms(query)
    scored = [(_score(item["title"], "", runs, bigrams), item) for item in index]
    scored = [(s, item) for s, item in scored if s > 0]
    scored.sort(key=lambda x: -x[0])
    # 标题没命中 → 仍抓一批正文找"正文级命中"，但只当候选，不直接算结果
    top = [item for _s, item in scored[: limit * 3]] if scored else index[:12]

    # 来源分散：同一站点最多 3 篇，避免被新闻网的时政稿刷屏（研招网是推免唯一
    # 权威口径，放宽到 3 才够装下"工作办法 + 预报名 + 直博"这类同源公告）
    picked: list[dict] = []
    per_source: dict[str, int] = {}
    for item in top:
        if per_source.get(item["source"], 0) >= 3:
            continue
        per_source[item["source"]] = per_source.get(item["source"], 0) + 1
        picked.append(item)
        if len(picked) >= max(limit * 3, 10):
            break

    bodies = _fetch_bodies(picked)
    hits = []
    for item in bodies:
        title = item.get("title", "") or ""
        blob = f"{title} {item.get('body', '')}"
        # 闸门分两档：
        #   1) 锚点命中标题 → 直接收（最可靠）；
        #   2) 只在正文命中 → 还要求标题至少沾 2 个 bigram。否则「北洋大讲堂预告」
        #      这种只是恰好提到"图书馆/开放/时间"的稿子会挤掉真正的时间通知。
        if not (
            _anchor_hit(title, runs)
            or (_anchor_hit(blob, runs) and _bigram_hits(title, bigrams) >= 2)
        ):
            continue
        item["score"] = _score(title, item.get("body", ""), runs, bigrams)
        # 列表页里混着好几年前的稿子：能从 URL 判出日期时，给近一年的内容小幅提权，
        # 免得 2022 年的通知压过 2026 年的同题通知
        ts = item.get("ts") or 0
        if ts and (time.time() - ts) < 365 * 86400:
            item["score"] += 1.5
        hits.append(item)
    hits.sort(key=lambda x: -x.get("score", 0))
    return hits[:limit]


# ---------------------------------------------------------------- 信源 2：微信公众号

_SOGOU_LINK_RE = re.compile(r"url\s*\+=\s*'([^']*)'")
_sogou_lock = threading.Lock()
_last_sogou_at = 0.0
_sogou_block_until = 0.0


def _sogou_sleep() -> None:
    """两次搜狗请求之间留最小间隔——短时间内连打会被判定为爬虫，
    表现为"这一问有结果、下一问只剩摘要"的间歇性退化。"""
    global _last_sogou_at
    with _sogou_lock:
        wait = SOGOU_MIN_INTERVAL - (time.time() - _last_sogou_at)
        if wait > 0:
            time.sleep(wait)
        _last_sogou_at = time.time()


def _sogou_blocked() -> bool:
    return time.time() < _sogou_block_until


def _sogou_mark_blocked() -> None:
    """被搜狗拦了就歇一段时间。搜狗是"补充"而不是"主力"：
    公众号正文的主路径是**官网公告栏里的 mp.weixin.qq.com 直链**（教务处首页就有 50 条），
    那条路不依赖第三方，所以搜狗被限流时整体仍然可用。"""
    global _sogou_block_until
    _sogou_block_until = time.time() + SOGOU_COOLDOWN
    LOGGER.warning(
        "campus_sources: 搜狗微信触发反爬，静默 %d 分钟后重试；本次改用官网直链的公众号内容",
        SOGOU_COOLDOWN // 60,
    )


def _resolve_sogou_link(sogou_url: str, referer: str) -> str:
    """把搜狗 /link?url=... 还原成真正的 mp.weixin.qq.com 地址。

    还原结果单独缓存：搜狗结果缓存 2 小时、正文缓存 7 天，若每次都重新还原，
    一旦 token 过期就会退化成"只剩摘要"。
    """
    cached = _cache_get("resolve:" + sogou_url, BODY_TTL)
    if cached and cached.get("real"):
        return cached["real"]

    page, final = http_get(sogou_url, referer=referer)
    if not page:
        return ""
    real = ""
    if "mp.weixin.qq.com" in final:
        real = final
    else:
        parts = _SOGOU_LINK_RE.findall(page)
        if parts:
            joined = "".join(parts)
            if "mp.weixin.qq.com" in joined:
                real = joined.replace("&amp;", "&")
        if not real:
            m = re.search(r"(https?://mp\.weixin\.qq\.com/s\?[^\"'\s<>]+)", page)
            if m:
                real = m.group(1).replace("&amp;", "&")
    if real:
        _cache_put("resolve:" + sogou_url, {"real": real})
    return real


def _sogou_search(query: str) -> list[dict]:
    """搜狗微信文章检索（带 2 小时结果缓存 + 请求限速 + 被拦后静默）。"""
    cache_key = "sogou:" + query
    cached = _cache_get(cache_key, SOGOU_TTL)
    if cached is not None:
        return cached.get("items") or []
    if _sogou_blocked():
        return []

    page_url = f"https://weixin.sogou.com/weixin?type=2&query={quote(query, safe='')}"
    _sogou_sleep()
    page, _final = http_get(page_url)
    if not page:
        return []
    if "antispider" in page or "请输入验证码" in page or "环境异常" in page:
        _sogou_mark_blocked()
        return []
    if "news-list" not in page:
        # 只是"这个词没结果"（页面里没有结果列表容器），不算被拦，别进静默期
        return []

    results: list[dict] = []
    if _HAS_BS4:
        try:
            soup = BeautifulSoup(page, "html.parser")
        except Exception:
            soup = None
        if soup is not None:
            for li in soup.select("div.news-box ul.news-list li"):
                a = li.select_one("h3 a")
                if a is None or not a.get("href"):
                    continue
                snippet_node = li.select_one(".txt-info")
                account_node = li.select_one("span.all-time-y2") or li.select_one(
                    "a.account"
                )
                date_node = li.select_one("span.s2")
                ts = 0
                if date_node is not None:
                    m = re.search(r"timeConvert\('(\d+)'\)", str(date_node))
                    if m:
                        ts = int(m.group(1))
                results.append(
                    {
                        "title": a.get_text(" ", strip=True),
                        "sogou_url": urljoin("https://weixin.sogou.com/", a["href"]),
                        "snippet": snippet_node.get_text(" ", strip=True)
                        if snippet_node
                        else "",
                        "account": account_node.get_text(" ", strip=True)
                        if account_node
                        else "",
                        "ts": ts,
                        "referer": page_url,
                    }
                )
    if results or not _HAS_BS4:
        if results:
            _cache_put(cache_key, {"items": results})
            _save_cache()
        return results

    # 无 bs4 时的正则兜底
    for block in re.findall(r'<li id="sogou_vr_11002601_box_\d+"[\s\S]*?</li>', page):
        m = re.search(
            r"<h3>\s*<a[^>]*href=[\"']([^\"']+)[\"'][^>]*>([\s\S]*?)</a>", block
        )
        if not m:
            continue
        sn = re.search(r'class="txt-info"[^>]*>([\s\S]*?)</p>', block)
        ac = re.search(r'class="all-time-y2"[^>]*>([\s\S]*?)</span>', block)
        results.append(
            {
                "title": _strip_tags(m.group(2)),
                "sogou_url": urljoin(
                    "https://weixin.sogou.com/", html.unescape(m.group(1))
                ),
                "snippet": _strip_tags(sn.group(1)) if sn else "",
                "account": _strip_tags(ac.group(1)) if ac else "",
                "ts": 0,
                "referer": page_url,
            }
        )
    if results:
        _cache_put(cache_key, {"items": results})
        _save_cache()
    return results


def search_wechat(query: str, limit: int = 3) -> list[dict]:
    """微信公众号文章检索：搜狗微信搜索 → 还原真链 → 抓正文。"""
    college = _COLLEGE_RE.search(query or "")
    college_name = college.group(1) if college else ""
    seg_kw = _keywords_for_engine(query)
    no_college_kw = _keywords_for_engine(query, drop=(college_name,))

    base_queries: list[str] = []
    extra_queries: list[str] = []

    def _add(bucket: list[str], q: str) -> None:
        q = (q or "").strip()
        if q and q not in bucket:
            bucket.append(q)

    # 整串与分词串各发一遍：整串更精准（能召回标题完全对应的老通知），
    # 分词召回更宽（"精仪学院 国奖 比例"能拆开匹配）
    _add(base_queries, _keywords_for_engine(query, segment=False))
    _add(base_queries, seg_kw)
    # 机构限定查询是"加料"，只在基础查询不够用时才发——搜狗有限流，
    # 每个问题都发 3-4 条查询很快就会把我们拦掉。
    if any(hint in (query or "") for hint in _TUANWEI_HINTS):
        _add(extra_queries, f"天津大学团委 {seg_kw}")
    if any(hint in (query or "") for hint in _AWARD_HINTS):
        # 奖助类内容主要发在「天大学生资助」这个号上，不加机构名搜不到
        _add(extra_queries, f"天大学生资助 {no_college_kw}")
    if college_name:
        _add(extra_queries, f"天津大学{college_name} {no_college_kw}")

    found: list[dict] = []
    seen_title: set[str] = set()

    def _collect(queries: list[str]) -> None:
        for q in queries:
            for item in _sogou_search(q):
                key = re.sub(r"\W+", "", item["title"])[:24]
                if not key or key in seen_title:
                    continue
                seen_title.add(key)
                found.append(item)

    _collect(base_queries)
    if len(found) < max(limit, 2):
        _collect(extra_queries)

    # 闸门：只留天大相关内容（搜狗是全网检索，不筛就全是别校噪声）
    found = [it for it in found if _tju_related(it)]
    if not found:
        return []

    # 官方号优先，其次看时间新鲜度
    def rank(item: dict) -> tuple:
        account = item.get("account") or ""
        known = any(k in account for k in KNOWN_ACCOUNTS) or account.startswith(
            "天津大学"
        )
        return (0 if known else 1, -(item.get("ts") or 0))

    found.sort(key=rank)
    # 只要 top 几篇去还原真链 + 抓正文：每篇要多花 2 次请求，抓太多会把首答拖到 10s+
    picked = found[: max(limit + 1, 3)]

    results: list[dict] = []
    with ThreadPoolExecutor(max_workers=min(4, len(picked))) as pool:
        futs = {
            pool.submit(_resolve_sogou_link, it["sogou_url"], it["referer"]): it
            for it in picked
        }
        for fut in as_completed(futs):
            item = futs[fut]
            real_url = ""
            try:
                real_url = fut.result()
            except Exception:  # noqa: BLE001
                real_url = ""
            entry = {
                "url": real_url or item["sogou_url"],
                "title": item["title"],
                "account": item.get("account") or "",
                "ts": item.get("ts") or 0,
                "source": f"微信公众号·{item['account']}"
                if item.get("account")
                else "微信公众号",
                "body": "",
            }
            if real_url:
                cached = _cache_get("body:" + real_url, BODY_TTL)
                if cached and cached.get("body"):
                    entry["body"] = cached["body"]
                else:
                    page, final = http_get(real_url)
                    if page:
                        art = extract_article(page, final or real_url)
                        if len(art["body"]) >= 80:
                            entry["body"] = art["body"]
                            if art.get("account"):
                                entry["account"] = art["account"]
                                entry["source"] = f"微信公众号·{art['account']}"
                            _cache_put(
                                "body:" + real_url,
                                {
                                    "title": art["title"],
                                    "body": art["body"],
                                    "account": art["account"],
                                },
                            )
            if not entry["body"]:
                entry["body"] = item.get("snippet") or ""  # 至少给出摘要
            results.append(entry)

    _save_cache()
    runs, bigrams = _query_terms(query)

    def _decorate(item: dict) -> dict:
        body = item.get("body") or ""
        # 正文很短的几乎都是"跳转失败只剩摘要"的兜底结果，证据强度差很多，重罚
        item["score"] = _score(item.get("title", ""), body, runs, bigrams) + (
            0.5 if len(body) >= 300 else -3.0
        )
        return item

    results = [_decorate(r) for r in results]
    # 与官网同款闸门：锚点必须在标题或正文里真命中。
    # 少了这一步，「今年精仪学院国奖比例」会把《@2023高考学子，精仪学院欢迎你》捞上来
    # ——它只是恰好含"精仪学院"。筛空了就退回未筛版本，宁可给得宽也不给空。
    gated = [
        r
        for r in results
        if _anchor_hit(f"{r.get('title', '')} {r.get('body', '')}", runs)
    ]
    if gated:
        results = gated
    results.sort(key=lambda x: (-x.get("score", 0), -(x.get("ts") or 0)))
    return [r for r in results if r.get("body")][:limit]


# ---------------------------------------------------------------- 信源 3：公众号订阅库
# 为什么要有这一层：搜狗微信的索引早就停更了（实测按号名检索，返回的全是 2019—2023
# 的旧文），公众号搜索接口也已下线。**靠检索永远问不到"最近发生了什么"**——用户不
# 知道该问什么，也就永远看不到。
#
# 可靠的新推文来源是：**各院系/部门官网的列表页会同步自己家公众号的推文**，且给的是
# mp.weixin.qq.com 直链。这条路不依赖第三方、不怕限流。本模块把这些直链收成一个
# 本地订阅库（data/wx_feed.json），供两处使用：
#   1. `search_all()` 里的第四个信源——零网络开销，问什么都能先命中已订阅推文；
#   2. 海小棠的「校园速递」面板——不提问也能看到各号最近发了什么。

_MP_TITLE_RE = re.compile(
    r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']*)', re.I
)
_MP_DESC_RE = re.compile(
    r'<meta[^>]+(?:property|name)=["\'](?:og:description|description)["\'][^>]+content=["\']([^"\']*)',
    re.I,
)
_MP_NAME_TAG_RE = re.compile(r'id=["\']js_name["\'][^>]*>([\s\S]{0,80}?)<', re.I)
_MP_NAME_VAR_RE = re.compile(
    r'var\s+nickname\s*=\s*(?:htmlDecode\()?["\']([^"\']{0,60})["\']', re.I
)
_MP_CT_RE = re.compile(r'var\s+ct\s*=\s*["\'](\d{9,11})["\']', re.I)
_MP_MID_RE = re.compile(r"mid=(\d+)")
_MP_IDX_RE = re.compile(r"idx=(\d+)")

# 实测：og:title 在 ~18KB、#js_name 在 ~510KB、var ct（发布时间）在 ~2.7MB。
# 只读 600KB 能拿到标题和号名，但拿不到时间——而"多久前发的"正是这个功能的命脉，
# 所以这里按全页给足。省流量的做法是增量：已有条目不再重抓。
MP_META_BYTES = 3_400_000
FEED_TTL = 3600  # 订阅库多久允许刷新一次（原 6h；"最近有什么"不能越问越旧）
FEED_MAX_NEW = 60  # 单轮最多抓多少篇新文章（防止一次跑太久）
FEED_MAX_ITEMS = 400  # 订阅库条数上限
FEED_KEEP_DAYS = 240  # 超过这个天数的推文不再保留

_feed_lock = threading.Lock()


def _mp_clean(url: str) -> str:
    """清理列表页里的裸链接：还原 &amp;、剥掉尾随标点与引号。"""
    url = (url or "").replace("&amp;", "&").strip().strip("\"'")
    return url.rstrip(").,;、。")


def _mp_key(url: str) -> str:
    """去重键。短链形态用 path；带 mid 的老形态用 mid+idx（同一篇文章会在
    多个列表页出现，还可能是 ?__biz=...&mid=...&idx=1&sn=xx 这种长尾）。"""
    parts = urlsplit(url)
    mid = _MP_MID_RE.search(parts.query or "")
    if mid:
        idx = _MP_IDX_RE.search(parts.query or "")
        return f"{parts.path}|{mid.group(1)}|{idx.group(1) if idx else '1'}"
    return parts.path


def _account_hint(seed: str) -> str:
    """列表页站点名 → 兜底号名（详情页取不到 js_name 时用）。

    "天津大学教务处·通知公告" → "天津大学教务处"；能和清单里的号对上就用清单名，
    对不上就退回站点名——宁可给个粗略的归属，也好过在 UI 里显示"未知公众号"。
    """
    base = re.split(r"[·・|]", seed or "")[0].strip()
    if not base:
        return ""
    if wx_accounts:
        for item in wx_accounts.all_accounts():
            name = item["name"]
            if name == base or name.startswith(base) or base.startswith(name):
                return name
        for key, item in [
            (k, i)
            for i in wx_accounts.all_accounts()
            for k in [i["name"], *i.get("alias", [])]
        ]:
            if key and key in base:
                return item["name"]
    return base


def _fetch_mp_meta(url: str) -> dict | None:
    """抓一篇公众号文章的元信息。取不到标题就算失败（标题是这个条目的全部价值）。"""
    page, final = http_get(url, cap=MP_META_BYTES)
    if not page:
        return None
    m = _MP_TITLE_RE.search(page)
    title = html.unescape(m.group(1)).strip() if m else ""
    if not title:
        title = _title_of(page, None)
    title = re.sub(r"\s+", " ", title).strip()
    if not title or _is_site_name(title):
        return None

    account = ""
    m = _MP_NAME_TAG_RE.search(page)
    if m:
        account = _strip_tags(m.group(1))
    if not account:
        m = _MP_NAME_VAR_RE.search(page)
        if m:
            account = html.unescape(m.group(1)).strip()

    ts = 0
    m = _MP_CT_RE.search(page)
    if m:
        ts = int(m.group(1))

    desc = ""
    m = _MP_DESC_RE.search(page)
    if m:
        desc = re.sub(r"\s+", " ", html.unescape(m.group(1))).strip()

    return {
        "title": title,
        "account": re.sub(r"\s+", " ", account).strip(),
        "ts": ts,
        "digest": desc[:240],
        "final_url": final or url,
    }


def _load_feed() -> dict:
    try:
        with open(WX_FEED_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and isinstance(data.get("items"), list):
            return data
    except Exception:
        pass
    return {"updated_at": 0, "items": []}


def _save_feed(items: list[dict], updated_at: float) -> None:
    try:
        os.makedirs(_BASE, exist_ok=True)
        tmp = WX_FEED_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(
                {"updated_at": int(updated_at), "items": items}, fh, ensure_ascii=False
            )
        os.replace(tmp, WX_FEED_PATH)
    except Exception as exc:  # noqa: BLE001 - 写盘失败不影响本次问答
        LOGGER.warning("campus_sources: 订阅库写入失败 %s", exc)


def _feed_sort_key(item: dict) -> tuple:
    """有发布时间的按时间倒序；没时间的按列表页序号（列表页基本按时间倒序）。"""
    ts = int(item.get("ts") or 0)
    if ts:
        return (0, -ts, int(item.get("seq") or 9999))
    return (1, 0, int(item.get("seq") or 9999))


def _collect_mp_links() -> list[dict]:
    """从官网矩阵索引里挑出全部公众号直链（按列表页出现次序）。"""
    out: list[dict] = []
    seen: set[str] = set()
    for item in _official_index():
        url = _mp_clean(item.get("url") or "")
        if "mp.weixin.qq.com/s" not in url:
            continue
        key = _mp_key(url)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(
            {
                "key": key,
                "url": url,
                "seed": item.get("seed") or item.get("source") or "",
                "seq": int(item.get("seq") or 9999),
            }
        )
    out.sort(key=lambda x: x["seq"])
    return out


def wechat_feed(force: bool = False, max_new: int = FEED_MAX_NEW) -> dict:
    """刷新并返回公众号订阅库。

    增量：已经在库里的条目不再重抓（一篇文章 3MB+，全量重抓代价太高），
    只补新链接。`force=True` 时忽略 FEED_TTL 直接刷新（供手动"刷新"按钮）。
    返回 {"items": [...], "new": n, "updated_at": ts, "total": n, "accounts": n}。
    """
    data = _load_feed()
    now = time.time()
    if not force and (now - float(data.get("updated_at") or 0)) < FEED_TTL:
        items = data["items"]
        return {
            "items": items,
            "new": 0,
            "updated_at": int(data.get("updated_at") or 0),
            "total": len(items),
            "accounts": len({i.get("account") for i in items if i.get("account")}),
            "cached": True,
        }

    with _feed_lock:  # 冷启动可能有多个请求同时想刷新，别让它们各抓一遍
        data = _load_feed()
        by_key = {it["key"]: it for it in data.get("items", []) if it.get("key")}
        links = _collect_mp_links()
        todo: list[dict] = []
        for link in links:
            existing = by_key.get(link["key"])
            if existing:
                existing["seq"] = link["seq"]  # 位置刷新
                continue
            todo.append(link)
        todo = todo[:max_new]

        fetched = 0
        if todo:
            with ThreadPoolExecutor(max_workers=min(6, len(todo))) as pool:
                futs = {pool.submit(_fetch_mp_meta, t["url"]): t for t in todo}
                for fut in as_completed(futs):
                    task = futs[fut]
                    try:
                        meta = fut.result()
                    except Exception as exc:  # noqa: BLE001 - 单篇失败不影响整轮
                        LOGGER.debug(
                            "campus_sources: 公众号元信息抓取失败 %s (%s)",
                            task["url"],
                            exc,
                        )
                        continue
                    if not meta:
                        continue
                    by_key[task["key"]] = {
                        "key": task["key"],
                        "url": meta.get("final_url") or task["url"],
                        "title": meta["title"],
                        "account": meta.get("account") or _account_hint(task["seed"]),
                        "digest": meta.get("digest") or "",
                        "ts": int(meta.get("ts") or 0),
                        "seed": task["seed"],
                        "seq": task["seq"],
                        "first_seen": int(now),
                    }
                    fetched += 1

        cutoff = now - FEED_KEEP_DAYS * 86400
        items = [
            it for it in by_key.values() if not it.get("ts") or int(it["ts"]) >= cutoff
        ]
        items.sort(key=_feed_sort_key)
        items = items[:FEED_MAX_ITEMS]
        _save_feed(items, now)
        return {
            "items": items,
            "new": fetched,
            "updated_at": int(now),
            "total": len(items),
            "accounts": len({i.get("account") for i in items if i.get("account")}),
            "cached": False,
        }


def feed_items(limit: int = 80, account: str = "", category: str = "") -> list[dict]:
    """读订阅库（不触发抓取），供 UI 列表用；可按号名/类别过滤。

    用户取消关注的号在这里就被剔掉——列表、检索、海小棠的"最近有什么"共用这一个入口，
    所以关注状态一处生效、处处生效。
    """
    items = _load_feed().get("items") or []
    if wx_accounts:
        items = [i for i in items if wx_accounts.is_followed(i.get("account") or "")]
    if category and wx_accounts:
        names = {a["name"] for a in wx_accounts.by_category(category)}
        items = [i for i in items if (i.get("account") or "") in names]
    if account:
        items = [i for i in items if account in (i.get("account") or "")]
    return sorted(items, key=_feed_sort_key)[:limit]


def feed_stale() -> bool:
    """订阅库是否已超过 TTL（供问答侧决定要不要顺手在后台补一轮）。"""
    return (time.time() - float(_load_feed().get("updated_at") or 0)) >= FEED_TTL


def _time_text(ts: int) -> str:
    """给 UI 的相对时间：今天 / 昨天 / N天前 / 月-日 / 年-月-日。"""
    if not ts:
        return "时间未知"
    now = time.time()
    days = (now - ts) / 86400
    if days < 1:
        return "今天"
    if days < 2:
        return "昨天"
    if days < 7:
        return f"{int(days)}天前"
    fmt = (
        "%m-%d"
        if time.localtime(ts).tm_year == time.localtime(now).tm_year
        else "%Y-%m-%d"
    )
    return time.strftime(fmt, time.localtime(ts))


def feed_payload(limit: int = 80, account: str = "", category: str = "") -> dict:
    """给「校园速递」面板的完整数据（含分类统计与相对时间）。"""
    state = _load_feed()
    all_items = state.get("items") or []
    if wx_accounts:
        # 统计口径必须和列表一致：取消关注的号既不出现在列表里，也不计入条数
        all_items = [
            i for i in all_items if wx_accounts.is_followed(i.get("account") or "")
        ]
    view = feed_items(limit=limit, account=account, category=category)

    def _row(it: dict) -> dict:
        acc = it.get("account") or ""
        info = wx_accounts.meta(acc) if wx_accounts else None
        return {
            "title": it.get("title") or "",
            "url": it.get("url") or "",
            "account": acc,
            "cat": (info or {}).get("cat", ""),
            "tier": (info or {}).get("tier", 3),
            "focus": (info or {}).get("focus", [])[:4],
            "ts": int(it.get("ts") or 0),
            "time_text": _time_text(int(it.get("ts") or 0)),
            "digest": it.get("digest") or "",
        }

    # 分类统计：以**清单**为准（没抓到的号也列出来，让同学知道它存在且值得关注）
    counts: dict[str, int] = {}
    for it in all_items:
        info = wx_accounts.meta(it.get("account") or "") if wx_accounts else None
        key = (info or {}).get("cat") or "未登记"
        counts[key] = counts.get(key, 0) + 1
    cats = []
    if wx_accounts:
        for c in wx_accounts.categories():
            cats.append(
                {
                    "cat": c["cat"],
                    "accounts": c["count"],
                    "items": counts.get(c["cat"], 0),
                }
            )
    return {
        "updated_at": int(state.get("updated_at") or 0),
        "updated_text": _time_text(int(state.get("updated_at") or 0))
        if state.get("updated_at")
        else "尚未抓取",
        "total": len(all_items),
        "accounts": len({i.get("account") for i in all_items if i.get("account")}),
        "categories": cats,
        "items": [_row(it) for it in view],
        "follow": wx_accounts.follow_stats() if wx_accounts else {},
        "refresh": refresh_state(),
    }


_refresh_guard = threading.Lock()
_refresh_state: dict = {
    "running": False,
    "finished_at": 0,
    "new": 0,
    "total": 0,
    "error": "",
}


def refresh_state() -> dict:
    with _refresh_guard:
        return dict(_refresh_state)


def refresh_async() -> bool:
    """后台刷新订阅库（已在刷新则返回 False）。

    不阻塞接口：一次刷新要抓几十篇文章（每篇 3MB+ 的公众号页），
    同步跑会把请求拖到分钟级。前端用 refresh.running 决定是否显示"抓取中"。
    """
    with _refresh_guard:
        if _refresh_state.get("running"):
            return False
        _refresh_state["running"] = True
        _refresh_state["error"] = ""

    def _run() -> None:
        try:
            result = wechat_feed(force=True)
            payload = {
                "running": False,
                "finished_at": int(time.time()),
                "new": int(result.get("new") or 0),
                "total": int(result.get("total") or 0),
                "error": "",
            }
        except Exception as exc:  # noqa: BLE001 - 刷新失败只记状态，不影响下次
            LOGGER.warning("campus_sources: 订阅库后台刷新失败 %s", exc)
            payload = {
                "running": False,
                "finished_at": int(time.time()),
                "error": str(exc),
            }
        with _refresh_guard:
            _refresh_state.update(payload)

    threading.Thread(target=_run, name="wx-feed-refresh", daemon=True).start()
    return True


def search_wechat_feed(query: str, limit: int = 3) -> list[dict]:
    """在本地订阅库里检索已收录的推文（零网络开销）。

    这是"问一句就能捞到近几个月的通知"的关键：正文源要现爬（秒级），
    而库里已经有标题+摘要，常见问题首轮就能给出结果。
    """
    items = _load_feed().get("items") or []
    if not items:
        return []
    if wx_accounts:
        # 取消关注的号不再参与问答：同学明说了不想看，就别再拿它当"依据"塞给模型
        items = [i for i in items if wx_accounts.is_followed(i.get("account") or "")]
    runs, bigrams = _query_terms(query)
    now = time.time()
    out: list[dict] = []
    for it in items:
        title = it.get("title") or ""
        account = it.get("account") or ""
        digest = it.get("digest") or ""
        blob = f"{title} {digest} {account}"
        if not (_anchor_hit(title, runs) or _anchor_hit(blob, runs)):
            continue
        score = _score(title, digest, runs, bigrams)
        ts = int(it.get("ts") or 0)
        if ts:
            age = now - ts
            if age < 30 * 86400:
                score += 2.0  # 一个月内的推文最可能是"当前有效"的安排
            elif age < 180 * 86400:
                score += 1.0
        else:
            score -= 0.5  # 时间未知，证据强度打折
        if wx_accounts:
            score += wx_accounts.boost(account)  # 官方号压过野号
        out.append(
            {
                "url": it.get("url") or "",
                "title": title,
                "account": account,
                "ts": ts,
                "body": digest,
                "digest_only": True,  # 提示渲染层：这是摘要而不是正文
                "source": f"微信公众号·{account}" if account else "微信公众号",
                "score": score,
            }
        )
    out.sort(key=lambda x: (-x.get("score", 0), -(x.get("ts") or 0)))
    return out[:limit]


def feed_render(results: list[dict], budget: int = 1400) -> str:
    """把订阅库里的推文渲染成给模型看的文本（标题 + 号名 + 相对时间 + 摘要）。"""
    if not results:
        return ""
    now = time.time()
    lines = ["【公众号最新推文（本地订阅库，含发布时间）】"]
    used = 0
    for item in results:
        ts = int(item.get("ts") or 0)
        when = ""
        if ts:
            day = (now - ts) / 86400
            stamp = time.strftime("%Y-%m-%d", time.localtime(ts))
            rel = "今天" if day < 1 else ("昨天" if day < 2 else f"{int(day)}天前")
            when = f"（{stamp}，{rel}）"
        else:
            when = "（发布时间未取到）"
        # 兼容两种来源：检索结果用 body，订阅库条目用 digest
        digest = re.sub(
            r"\s+", " ", item.get("body") or item.get("digest") or ""
        ).strip()
        chunk = (
            f"- [{item.get('account') or '微信公众号'}] {item.get('title') or ''}{when}"
            f"：{digest[:200]}\n  原文：{item.get('url') or ''}"
        )
        if used + len(chunk) > budget:
            break
        lines.append(chunk)
        used += len(chunk)
    return "\n".join(lines) if len(lines) > 1 else ""


# ---------------------------------------------------------------- 信源 4：北洋维基


def search_wiki(query: str, limit: int = 3) -> list[dict]:
    """北洋维基离线全站正文语料检索；语料缺失/过期时返回 []。"""
    try:
        import wiki_corpus  # type: ignore

        wiki_corpus.ensure(blocking=False)
        hits = wiki_corpus.search(query, limit=limit)
    except Exception as exc:  # noqa: BLE001 - 维基不可用不应影响其它信源
        LOGGER.warning("campus_sources: 北洋维基语料不可用 %s", exc)
        return []
    anchors, bigrams = _query_terms(query)
    out: list[dict] = []
    for hit in hits or []:
        body = re.sub(r"\s+", " ", hit.get("body") or "").strip()
        imgtext = re.sub(r"\s+", " ", hit.get("imgtext") or "").strip()
        if imgtext:
            # 同 _fetch_wiki：图片识别出来的多是表格，结构会被拉平，必须标注来源性质
            note = "【图片识别文字·表格结构可能失真，具体日期/金额请以原文为准】"
            body = f"{body}\n{note}{imgtext}" if body else f"{note}{imgtext}"
        if not body:
            continue
        title = hit.get("title", "")
        out.append(
            {
                "url": hit.get("url", ""),
                "title": title,
                # 用与官网/公众号同一个 _score 口径，跨源排序才有可比性
                # （以前这里恒为 0，只能靠"按源归一化"兜着，结果弱源里的最强项会被抬到第一）
                "score": _score(title, body, anchors, bigrams),
                "body": body,
                "source": "北洋维基",
            }
        )
    return out


# ---------------------------------------------------------------- 汇总入口


def search(query: str, *, limit: int = 6) -> list[dict]:
    """三源并发检索，返回按相关度排序的结果列表。

    dict 字段：source / title / body / url / account(可空) / ts(可空) / score
    """
    query = (query or "").strip() or "天津大学校园资讯"
    tasks = {
        "wiki": (search_wiki, 2),
        "official": (search_official, 3),
        "wechat": (search_wechat, 2),
        # 本地订阅库：零网络开销，所以额度给得比其它源大——它是唯一"能答最近发生了什么"
        # 的信源（搜狗拿不到新文，官网正文要现爬）。
        "feed": (search_wechat_feed, 4),
    }
    results: list[dict] = []
    with ThreadPoolExecutor(max_workers=len(tasks)) as pool:
        futs = {
            pool.submit(fn, query, limit=n): name for name, (fn, n) in tasks.items()
        }
        for fut in as_completed(futs):
            name = futs[fut]
            try:
                got = fut.result()
            except Exception as exc:  # noqa: BLE001 - 单源失败不影响其它源
                LOGGER.warning("campus_sources: %s 信源失败 %s", name, exc)
                continue
            results.extend(got or [])

    if not results:
        return []

    # 三个信源都走同一个 _score，分数天然可比 → 直接按绝对分排，只给"时效更好"的
    # 公众号一点点权重。**不要再做"按源归一化"**：那会把弱源里的最强项也抬成 1.0，
    # 于是「问国奖比例」时，精仪学院推免实施细则会输给一篇高考招生稿。
    def _norm(item: dict) -> float:
        weight = 1.05 if str(item.get("source", "")).startswith("微信公众号") else 1.0
        return float(item.get("score") or 0.0) * weight

    for item in results:
        item["norm"] = _norm(item)

    results.sort(key=lambda x: -x.get("norm", 0.0))

    # 去重（同 URL 或同标题）后按 limit 截断，同时保证来源多样性
    out: list[dict] = []
    seen_url: set[str] = set()
    seen_title: set[str] = set()
    per_source: dict[str, int] = {}
    for item in results:
        url_key = item.get("url") or ""
        title_key = re.sub(r"\W+", "", item.get("title") or "")[:24]
        if url_key in seen_url or (title_key and title_key in seen_title):
            continue
        src = str(item.get("source", ""))
        if per_source.get(src, 0) >= 3:
            continue
        seen_url.add(url_key)
        if title_key:
            seen_title.add(title_key)
        per_source[src] = per_source.get(src, 0) + 1
        out.append(item)
        if len(out) >= limit:
            break
    return out


def render(results: list[dict], budget: int = 2000, body_chars: int = 700) -> str:
    """把检索结果拼成给模型看的、带来源标注的 Markdown 文本。

    对发布日期超过 STALE_DAYS 的公众号文章会明确标"可能已过期"——开馆时间、放假
    安排这类信息一旦过期就是错的，宁可让模型说"需核实"，也不要它照抄三年前的时间。
    """
    if not results:
        return ""
    lines: list[str] = ["【校园资讯检索结果】"]
    used = 0
    now = time.time()
    for item in results:
        while budget - used < 160:
            return "\n".join(lines)
        date = ""
        stale = ""
        ts = item.get("ts")
        if ts and int(ts) > 0:
            age = now - int(ts)
            day = int(age // 86400)
            rel = (
                "今天发布" if day < 1 else ("昨天发布" if day < 2 else f"{day}天前发布")
            )
            date = time.strftime(f"（%Y-%m-%d，{rel}）", time.localtime(int(ts)))
            if age > STALE_DAYS * 86400:
                stale = "⚠️该文发布时间较久，具体安排可能已变动，需与官方最新通知核对；"
        if item.get("digest_only"):
            # 订阅库里只存了标题+摘要（正文要现爬）。明确标注，免得模型把摘要当全文引用。
            stale += "（此处为公众号推文摘要，正文请以原文链接为准）"
        title = (item.get("title") or "").strip() or "（无标题）"
        head = title if len(title) <= 42 else title[:42] + "…"
        body = re.sub(r"\s+", " ", item.get("body") or "").strip()
        body = body[:body_chars]
        chunk = f"- [{item.get('source', '校内信源')}] {head}{date}：{stale}{body}\n  出处：{item.get('url', '')}"
        lines.append(chunk)
        used += len(chunk)
    return "\n".join(lines)


def lookup(query: str, *, budget: int = 2000, limit: int = 6) -> str:
    """一步到位：检索 + 渲染。无结果返回空串（调用方自行兜底）。"""
    try:
        return render(search(query, limit=limit), budget=budget)
    except Exception as exc:  # noqa: BLE001
        LOGGER.warning("campus_sources: lookup 失败 %s", exc)
        return ""


def warmup() -> None:
    """预热官网索引（供后台线程调用，避免首个问题卡在冷启动）。"""
    try:
        _official_index()
    except Exception as exc:  # noqa: BLE001
        LOGGER.debug("campus_sources: warmup 失败 %s", exc)
