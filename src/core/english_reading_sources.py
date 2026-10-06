"""知源 · 考研精读联网语料层（core/english_reading_sources.py）。

设计目标（对应用户诉求）：
  * **纯联网实时检索**：本地只留「源注册表 + 一份很小的元数据索引缓存」，
    全文永不落盘（只进内存 LRU），安装体积与启动成本都不随语料规模增长。
  * **国内可达优先**：源清单全部经实测可达后才登记，被墙的外刊（经济学人/卫报等）
    不写进来骗自己；够不着的题材交给 TJU-LLM 命题兜底（见 english_exam）。
  * **清洗 + 分类**：抓到正文后统一去导航/订阅/版权/播客/招聘等样板行，再过质量闸门，
    最后打上考研主题标签，供用户筛选。

列表页只做「标题级」判断（主题按标题关键词，难度标为待评估）——RSS 摘要只有二三十词，
据此估难度必然是噪声，宁可标"待评估"也不给用户一个假标签。难度与主题在载入全文后重算。

所有函数同步，由调用方 `asyncio.to_thread()` 包一层即可（与 core/paper_search.py 同风格）。
"""

from __future__ import annotations

import concurrent.futures
import hashlib
import json
import logging
import re
import threading
import time
from pathlib import Path
from typing import Any

import httpx

log = logging.getLogger(__name__)

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
_HEADERS = {"User-Agent": _UA, "Accept-Language": "en-US,en;q=0.9"}
# 少数源（如 New Scientist）只对订阅器 UA 放行 RSS，对浏览器 UA 直接回 406。
# 我们本来就只是在读 RSS，用订阅器身份重试一次既诚实又能拿到内容。
_FEED_HEADERS = {
    "User-Agent": "KnowOriginFeedReader/1.0 (+rss reader; contact: local app)",
    "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
}

# 元数据索引缓存：只存标题/来源/链接/摘要等轻量字段，几十 KB 级别，重启后秒开。
_FEED_TTL_SECONDS = 1800
_FEED_CACHE_NAME = "reading_feed_cache.json"
# 时效闸门：RSS 里常混着几年的僵尸旧文（实测 Xinhua 的 feed 全是 2017-2018 年的）。
# 有日期且超过这个年龄的条目直接丢弃，别让用户点开一篇「三年前」的文章。
_MAX_ITEM_AGE_SECONDS = 60 * 86400
# 全文只进内存，最多留 24 篇，避免"装在本地内存太大"。
_FULLTEXT_CACHE_SIZE = 24

UNKNOWN_TOPIC = "综合外刊"
PENDING_DIFFICULTY = "待评估"

_fulltext_cache: dict[str, dict[str, Any]] = {}
_fulltext_order: list[str] = []
_cache_lock = threading.Lock()
# 源索引是「读-改-写」整个 JSON 文件，多线程并发抓取时必须串行化，否则会互相覆盖
_feed_cache_lock = threading.Lock()
# 多源并发抓取的线程数：12 个源并行，冷启动从串行 ~20s 压到 ~2s
_FETCH_WORKERS = 8
_FEED_TIMEOUT = 12.0


# ==============================================================================
# 源注册表（全部经实测可达；fulltext 表示该站正文能否稳定抽取）
# ==============================================================================

READING_SOURCES: list[dict[str, Any]] = [
    {
        "id": "nature",
        "name": "Nature (自然)",
        "en_name": "Nature",
        "feed": "https://www.nature.com/nature.rss",
        "badge": "殿堂级学术期刊 · 考研科学类题源",
        "home": "https://www.nature.com/",
        "topics": ["生命科学与认知心理", "地球生态与气候科学", "科技创新与人工智能"],
        "weight": 98,
        "fulltext": True,
    },
    {
        "id": "mit_tr",
        "name": "MIT Technology Review (麻省理工科技评论)",
        "en_name": "MIT Technology Review",
        "feed": "https://www.technologyreview.com/feed/",
        "badge": "新锐题源黑马 · 算法伦理与前沿工程",
        "home": "https://www.technologyreview.com/",
        "topics": ["科技创新与人工智能"],
        "weight": 92,
        "fulltext": True,
    },
    {
        "id": "newscientist",
        "name": "New Scientist (新科学家)",
        "en_name": "New Scientist",
        "feed": "https://www.newscientist.com/feed/home/",
        "badge": "科普长文 · 论证结构与态度题训练",
        "home": "https://www.newscientist.com/",
        "topics": ["科技创新与人工智能", "生命科学与认知心理", "地球生态与气候科学"],
        "weight": 88,
        "fulltext": True,
    },
    {
        "id": "sciencenews",
        "name": "Science News (科学新闻)",
        "en_name": "Science News",
        "feed": "https://www.sciencenews.org/feed",
        "badge": "科学说明文 · 事实推断题基石",
        "home": "https://www.sciencenews.org/",
        "topics": ["科技创新与人工智能", "地球生态与气候科学", "生命科学与认知心理"],
        "weight": 84,
        "fulltext": True,
    },
    {
        "id": "sciencedaily_mind",
        "name": "ScienceDaily (每日科学 · 脑与认知)",
        "en_name": "ScienceDaily Mind & Brain",
        "feed": "https://www.sciencedaily.com/rss/mind_brain.xml",
        "badge": "认知心理学专题 · 考研高频主题",
        "home": "https://www.sciencedaily.com/news/mind_brain/",
        "topics": ["生命科学与认知心理"],
        "weight": 86,
        "fulltext": True,
    },
    {
        "id": "sixthtone",
        "name": "Sixth Tone (澎湃英文 · 第六声)",
        "en_name": "Sixth Tone",
        "feed": "https://www.sixthtone.com/rss",
        "badge": "深度社会文化报道 · 人文社科题源",
        "home": "https://www.sixthtone.com/",
        "topics": ["人文社科与现代生活", "商业金融与宏观治理"],
        "weight": 82,
        "fulltext": True,
    },
    {
        "id": "sciencedaily",
        "name": "ScienceDaily (每日科学 · 综合)",
        "en_name": "ScienceDaily",
        "feed": "https://www.sciencedaily.com/rss/all.xml",
        "badge": "全学科通稿 · 篇量大、上手快",
        "home": "https://www.sciencedaily.com/",
        "topics": ["科技创新与人工智能", "地球生态与气候科学", "生命科学与认知心理"],
        "weight": 80,
        "fulltext": True,
    },
    {
        "id": "sciencedaily_health",
        "name": "ScienceDaily (每日科学 · 生命健康)",
        "en_name": "ScienceDaily Health",
        "feed": "https://www.sciencedaily.com/rss/health_medicine.xml",
        "badge": "生命科学专题 · 科普与实验论证",
        "home": "https://www.sciencedaily.com/news/health_medicine/",
        "topics": ["生命科学与认知心理"],
        "weight": 78,
        "fulltext": True,
    },
    {
        "id": "physorg",
        "name": "Phys.org (物理组织)",
        "en_name": "Phys.org",
        "feed": "https://phys.org/rss-feed/",
        "badge": "物理与工程前沿 · 全文可读",
        "home": "https://phys.org/",
        "topics": ["科技创新与人工智能", "地球生态与气候科学"],
        "weight": 70,
        "fulltext": True,
    },
    {
        "id": "globaltimes",
        "name": "Global Times (环球时报英文版)",
        "en_name": "Global Times",
        "feed": "https://www.globaltimes.cn/rss/outbrain.xml",
        "badge": "国内英文时评 · 观点态度题素材",
        "home": "https://www.globaltimes.cn/",
        "topics": ["商业金融与宏观治理", "人文社科与现代生活"],
        "weight": 66,
        "fulltext": True,
    },
    {
        "id": "cgtn",
        "name": "CGTN (中国国际电视台)",
        "en_name": "CGTN",
        "feed": "https://www.cgtn.com/subscribe/rss/section/world.xml",
        "badge": "国内英文报道 · 时政与社会",
        "home": "https://www.cgtn.com/",
        "topics": ["商业金融与宏观治理", "人文社科与现代生活"],
        "weight": 62,
        "fulltext": True,
    },
]

_SOURCE_BY_ID = {s["id"]: s for s in READING_SOURCES}

# 考研主题分类：与 english_exam_data 的 category 命名保持一致，便于和内置语料同列展示。
TOPIC_KEYWORDS: dict[str, list[str]] = {
    "科技创新与人工智能": [
        "ai", "artificial intelligence", "algorithm", "machine learning", "robot",
        "chip", "semiconductor", "software", "digital", "quantum", "computer",
        "technology", "tech", "internet", "data", "neural", "automation",
        "cyber", "encryption", "satellite", "spacecraft", "engineer", "device",
        "physics", "particle", "collider", "laser", "chemistry", "material",
        "telescope", "reactor", "battery", "sensor", "drone", "smartphone",
    ],
    "商业金融与宏观治理": [
        "economy", "economic", "market", "trade", "tariff", "inflation", "bank",
        "finance", "financial", "investment", "business", "company", "corporate",
        "tax", "regulation", "antitrust", "supply chain", "recession",
        "employment", "labour", "labor", "wage", "gdp", "currency", "startup",
        "industry", "consumer", "profit", "debt", "subsidy",
    ],
    "生命科学与认知心理": [
        "brain", "memory", "sleep", "cognitive", "psychology", "psycholog",
        "neuron", "mental", "health", "disease", "gene", "genetic", "cell",
        "protein", "immune", "cancer", "virus", "vaccine", "medicine", "medical",
        "patient", "behaviour", "behavior", "emotion", "stress", "attention",
        "dementia", "bacteria", "autism", "disorder", "therapy", "drug",
        "clinical", "trial", "hospital", "diet", "nutrition", "obesity",
        "diabetes", "alzheimer", "depression", "anxiety", "hormone",
    ],
    "地球生态与气候科学": [
        "climate", "carbon", "emission", "warming", "environment", "ecolog",
        "biodiversity", "ocean", "ice", "glacier", "permafrost",
        "solar", "renewable", "pollution", "forest", "wildlife",
        "temperature", "drought", "extinction", "coral", "weather", "earth",
        "atmosphere", "habitat", "marine", "wetland", "flood", "heatwave",
    ],
    "人文社科与现代生活": [
        "culture", "society", "social", "education", "history", "language",
        "gender", "family", "city", "urban", "rural", "media", "art", "music",
        "literature", "philosophy", "religion", "immigration", "inequality",
        "youth", "generation", "tradition", "heritage", "workplace", "court",
        "school", "student", "teacher", "marriage", "community", "museum",
    ],
}

# 来源先验：标题关键词命中很弱时，用该源的办刊领域兜底，比硬猜「综合外刊」准得多。
_SOURCE_TOPIC_PRIOR_WEIGHT = 3

# 正文清洗：命中即整行丢弃的样板行（导航/订阅/版权/播客推广/招聘/图片署名）。
_BOILERPLATE_PATTERNS = [
    re.compile(p, re.IGNORECASE)
    for p in (
        r"^(sign up|subscribe|newsletter|download the .* podcast|listen to|never miss)",
        r"^(this (article|story|piece) (was|is) (originally )?(published|appear))",
        r"^(read more|related|more from|see also|also read|you might also like)",
        r"^(share (this|on)|follow us|advertisement|sponsored|supported by)",
        r"^(cookie|privacy|terms of use|by continuing to browse|our privacy statement)",
        r"^(photo|image|credit|illustration|source|caption)\s*[:/]",
        r"^(get the latest|sign up for|join our|the best of)",
        r"^(the post .* appeared first on|reprinted with permission)",
        r"^(copyright|©|all rights reserved|this document is subject to)",
        r"^\W*(by |published|updated|posted)\s+\w+\s+\d{1,2},?\s+\d{4}",
        r"^\d+\s*(min|minute|hour|day)s?\s*(read|ago)$",
        # 播客/视频转录与节目推广（Nature Briefing 一类页面的主要噪声）
        r"(podcast|episode|listen on|apple podcast|spotify|transcript)",
        # 期刊招聘广告（Nature 页面尾部常见，与精读无关）
        r"(we are seeking|applications are invited|postdoctoral|faculty position)",
        r"(tenure[- ]track|job opening|vacanc|recruit)",
    )
]

# 列表页过滤：明显不是「可精读文章」的栏目链接
_NON_ARTICLE_URL = re.compile(
    r"(/podcast|/video|/audio|/gallery|/live/|/tag/|/author/|/newsletter"
    r"|/subscribe|/about|/contact|/privacy|/terms|/rss|/feed)",
    re.IGNORECASE,
)

# 列表页过滤：播客/简报/聚合通讯一类栏目页。这类页面抓出来是节目单与推广语，
# 不是一篇可精读的论证文章——提前滤掉，免得用户点进去发现是死路。
_NON_ARTICLE_TITLE = re.compile(
    r"(^briefing chat|podcast|^the download\b|newsletter|^weekly |^quiz\b"
    r"|crossword|^live updates|^what to know|^editors.? pick|^best of )",
    re.IGNORECASE,
)

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")
_WORD_RE = re.compile(r"[A-Za-z][A-Za-z'-]*")
_URLISH = re.compile(r"(https?://|www\.|doi:|@[\w.-]+\.\w+)")


# ==============================================================================
# 基础工具
# ==============================================================================


def _article_id(url: str) -> str:
    """由 URL 生成稳定 id：同一篇反复出现时前端能识别成同一篇。"""
    return "rs_" + hashlib.sha1(url.strip().encode("utf-8")).hexdigest()[:12]


def _http_get(
    url: str, *, timeout: float = 20.0, headers: dict[str, str] | None = None
) -> httpx.Response | None:
    try:
        return httpx.get(
            url,
            headers=headers or _HEADERS,
            timeout=httpx.Timeout(timeout, connect=8.0),
            follow_redirects=True,
        )
    except Exception as exc:  # noqa: BLE001 - 单源失败不该拖垮整次检索
        log.info("reading source fetch failed %s: %s", url[:80], exc)
        return None


def _strip_html(raw: str) -> str:
    text = re.sub(r"<[^>]+>", " ", raw or "")
    for entity, char in (("&nbsp;", " "), ("&amp;", "&"), ("&quot;", '"'),
                         ("&#39;", "'"), ("&lt;", "<"), ("&gt;", ">")):
        text = text.replace(entity, char)
    return re.sub(r"\s+", " ", text).strip()


def _looks_like_prose(sentence: str, *, min_words: int = 8) -> bool:
    """判断一句是不是正常英文散文：够长、以字母为主、不含网址/邮箱/DOI。"""
    words = _WORD_RE.findall(sentence)
    if len(words) < min_words:
        return False
    if _URLISH.search(sentence):
        return False
    letters = sum(len(w) for w in words)
    return letters / max(1, len(sentence)) >= 0.55


# ==============================================================================
# 正文清洗与分类
# ==============================================================================


def clean_passage(text: str) -> str:
    """把抓来的正文洗成适合精读的干净段落：去样板行、剔非散文句、按句重组段落。"""
    if not text:
        return ""
    lines: list[str] = []
    for raw_line in text.split("\n"):
        line = re.sub(r"[ \t\u00a0]+", " ", raw_line).strip()
        if not line:
            continue
        if any(pat.search(line) for pat in _BOILERPLATE_PATTERNS):
            continue
        # 丢弃过短且不含句末标点的碎片（导航残渣）
        if len(line.split()) < 5 and not re.search(r"[.!?]", line):
            continue
        lines.append(line)

    merged = re.sub(r"\s+", " ", " ".join(lines)).strip()
    sentences = [
        s.strip()
        for s in _SENTENCE_SPLIT.split(merged)
        if _looks_like_prose(s.strip())
    ]
    paragraphs, buf = [], []
    for sent in sentences:
        buf.append(sent)
        if len(buf) >= 4:
            paragraphs.append(" ".join(buf))
            buf = []
    if buf:
        paragraphs.append(" ".join(buf))
    return "\n\n".join(paragraphs)


def classify_topic(
    title: str, text: str = "", prior_topics: list[str] | None = None
) -> str:
    """按关键词命中数把文章归入考研五大主题。

    `prior_topics` 是来源的办刊领域（如 ScienceDaily Mind → 生命科学与认知心理）。
    RSS 摘要只有二三十词，纯关键词匹配噪声大；给来源领域一点加权，
    比动辄落到「综合外刊」实用得多，而强关键词信号依然能翻盘。
    """
    haystack = f"{title} {text[:1500]}".lower()
    priors = set(prior_topics or [])
    best_topic, best_score = UNKNOWN_TOPIC, 0
    for topic, keywords in TOPIC_KEYWORDS.items():
        score = sum(haystack.count(kw) for kw in keywords)
        if topic in priors:
            score += _SOURCE_TOPIC_PRIOR_WEIGHT
        if score > best_score:
            best_topic, best_score = topic, score
    return best_topic


def estimate_difficulty(text: str) -> str:
    """按句长与长词占比粗估考试难度级别。文本不足时返回「待评估」而不是瞎猜。"""
    words = _WORD_RE.findall(text or "")
    if len(words) < 120:
        return PENDING_DIFFICULTY
    sentences = [s for s in _SENTENCE_SPLIT.split(text) if len(s.split()) >= 3]
    avg_len = len(words) / max(1, len(sentences))
    long_ratio = sum(1 for w in words if len(w) >= 8) / len(words)
    score = avg_len + long_ratio * 40
    if score >= 30:
        return "考研英语(一)"
    if score >= 26:
        return "考研英语(二)"
    if score >= 22:
        return "六级"
    return "四级"


def extract_key_sentences(text: str, limit: int = 4) -> list[str]:
    """挑出最像考研长难句的句子（词数多、含从句信号词优先），并剔除非散文句。"""
    signals = ("that", "which", "who", "because", "although", "while", "whereas",
               "if", "unless", "when", "since", "but", "however", "rather than")
    scored: list[tuple[float, str]] = []
    for sent in _SENTENCE_SPLIT.split(text or ""):
        sent = sent.strip()
        if not _looks_like_prose(sent, min_words=14):
            continue
        bonus = sum(1 for s in signals if f" {s} " in f" {sent.lower()} ")
        scored.append((len(sent.split()) + bonus * 3, sent))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [s for _, s in scored[:limit]]


# ==============================================================================
# RSS 拉取（带轻量磁盘缓存，保证重启秒开）
# ==============================================================================


def _cache_path(data_dir: Path | str | None) -> Path | None:
    if not data_dir:
        return None
    try:
        directory = Path(data_dir) / "english"
        directory.mkdir(parents=True, exist_ok=True)
        return directory / _FEED_CACHE_NAME
    except OSError:
        return None


def _read_feed_cache(data_dir: Path | str | None) -> dict[str, Any]:
    path = _cache_path(data_dir)
    if not path or not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _write_feed_cache(data_dir: Path | str | None, payload: dict[str, Any]) -> None:
    path = _cache_path(data_dir)
    if not path:
        return
    try:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)
    except OSError as exc:
        log.info("reading feed cache write failed: %s", exc)


def _local_name(tag: str) -> str:
    """剥掉 XML 命名空间，只留标签本地名（Atom 常带 xmlns）。"""
    return tag.rsplit("}", 1)[-1].lower() if "}" in tag else tag.lower()


def _xml_text(node: Any) -> str:
    return "".join(node.itertext()).strip()


def _parse_pub_ts(raw: str) -> float:
    """把 feed 里的日期字符串解析成 Unix 时间戳；认不出来返回 0（排序沉底）。

    三种主流写法都要兜住：RFC 822（RSS 的 `Fri, 25 Sep 2026 09:16:00 GMT`）、
    ISO 8601（Atom 的 `2026-09-25T09:16:00Z`）、以及 Sixth Tone 这类
    `Sep 25, 2026` 的人写格式。解析失败不能炸——宁可没有日期也不丢文章。
    """
    from datetime import datetime, timezone
    from email.utils import parsedate_to_datetime

    text = (raw or "").strip()
    if not text:
        return 0.0
    try:
        dt = parsedate_to_datetime(text)
        if dt is not None:
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.timestamp()
    except Exception:  # noqa: BLE001
        pass
    iso = text.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except Exception:  # noqa: BLE001
        pass
    for fmt in ("%b %d, %Y", "%B %d, %Y", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(text[:20].strip(), fmt)
            return dt.replace(tzinfo=timezone.utc).timestamp()
        except Exception:  # noqa: BLE001
            continue
    return 0.0


def _parse_feed(raw: bytes, source: dict[str, Any]) -> list[dict[str, Any]]:
    """用标准库解析 RSS 2.0 / Atom，同时兼容两种格式。

    刻意不依赖 feedparser：它没写进 requirements.txt，装在另一个解释器上会让整个
    联网检索层在用户机器上静默失效——表现就是界面上「半天搜不出来」。标准库足够
    覆盖 RSS 2.0 与 Atom 两种主流格式，少一个依赖就少一类部署事故。
    """
    import xml.etree.ElementTree as ET

    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        # 少数源声明的编码与实际不符：去掉 XML 声明后按 UTF-8 重试一次
        try:
            text = re.sub(r"^\s*<\?xml[^>]*\?>", "", raw.decode("utf-8", "replace"))
            root = ET.fromstring(text)
        except Exception as exc:  # noqa: BLE001
            log.warning("feed parse failed for %s: %s", source.get("id"), exc)
            return []
    except Exception as exc:  # noqa: BLE001
        log.warning("feed parse failed for %s: %s", source.get("id"), exc)
        return []

    # RSS 2.0: rss/channel/item ；Atom: feed/entry
    nodes = [n for n in root.iter() if _local_name(n.tag) in ("item", "entry")]

    items: list[dict[str, Any]] = []
    for node in nodes:
        title = link = summary = date = ""
        for child in node:
            name = _local_name(child.tag)
            if name == "title":
                title = _strip_html(_xml_text(child)).strip()
            elif name == "link":
                # Atom 用 href 属性且会有 rel="self"，只取 alternate 那条；RSS 用文本
                rel = (child.get("rel") or "alternate").lower()
                href = (child.get("href") or "").strip() or _xml_text(child).strip()
                if rel in ("alternate", "") and href and not link:
                    link = href
            elif name in ("description", "summary", "content") and not summary:
                summary = _strip_html(_xml_text(child))
            elif name in ("pubdate", "published", "updated", "date") and not date:
                date = _xml_text(child).strip()

        url = link.strip()
        if not url or not title or _NON_ARTICLE_URL.search(url):
            continue
        if _NON_ARTICLE_TITLE.search(title):
            continue
        if len(summary) > 600:
            summary = summary[:600].rsplit(" ", 1)[0] + "…"
        items.append(
            {
                "id": _article_id(url),
                "title": title,
                "url": url,
                "source_id": source["id"],
                "source": source["en_name"],
                "source_name": source["name"],
                "badge": source["badge"],
                "snippet": summary,
                "date": date,
                "pub_ts": _parse_pub_ts(date),
                "fulltext": bool(source.get("fulltext")),
                "weight": source.get("weight", 0),
                "topic": classify_topic(title, summary, source.get("topics")),
            }
        )
    return items


def fetch_source_items(
    source_id: str,
    *,
    data_dir: Path | str | None = None,
    limit: int = 40,
    force: bool = False,
) -> list[dict[str, Any]]:
    """取单个源的条目列表；30 分钟内命中磁盘缓存，避免每次点开都打网络。"""
    source = _SOURCE_BY_ID.get(source_id)
    if not source:
        return []

    cache = _read_feed_cache(data_dir)
    bucket = cache.get(source_id) or {}
    fresh = (
        not force
        and bucket.get("items")
        and (time.time() - float(bucket.get("fetched_at") or 0)) < _FEED_TTL_SECONDS
    )
    if fresh:
        return list(bucket["items"])[:limit]

    resp = _http_get(source["feed"], timeout=_FEED_TIMEOUT)
    if resp is None or resp.status_code != 200:
        # 换订阅器 UA 再试一次：New Scientist 这类源对浏览器 UA 回 406，只放行订阅器
        retry = _http_get(source["feed"], timeout=_FEED_TIMEOUT, headers=_FEED_HEADERS)
        if retry is not None and retry.status_code == 200:
            resp = retry
    if resp is None or resp.status_code != 200:
        # 网络抖动时退回过期缓存，宁可给旧列表也不要空白
        return list(bucket.get("items") or [])[:limit]

    items = _parse_feed(resp.content, source)
    if items:
        # 时效闸门：新→旧排序，超龄僵尸文直接丢弃（没解析出日期的保留，沉底）
        items.sort(key=lambda it: it.get("pub_ts") or 0, reverse=True)
        now = time.time()
        items = [
            it
            for it in items
            if not it.get("pub_ts")
            or (now - it["pub_ts"]) <= _MAX_ITEM_AGE_SECONDS
        ]
        # 重新读一次再合并写入：并发抓取时其他线程可能刚写入了别的源
        with _feed_cache_lock:
            latest = _read_feed_cache(data_dir)
            latest[source_id] = {"fetched_at": time.time(), "items": items}
            _write_feed_cache(data_dir, latest)
        return items[:limit]
    return list(bucket.get("items") or [])[:limit]


def _fetch_many(
    target_ids: list[str], *, data_dir: Path | str | None, force: bool
) -> list[list[dict[str, Any]]]:
    """并发抓取多个源，返回与 target_ids 同序的结果。

    串行抓 12 个源要 ~20s，用户观感就是「半天搜不出来」；并发后取决于最慢的那个源。
    单个源失败只影响自己那一组，不拖垮整次检索。
    """
    if len(target_ids) <= 1:
        return [
            fetch_source_items(sid, data_dir=data_dir, limit=60, force=force)
            for sid in target_ids
        ]

    groups: list[list[dict[str, Any]]] = [[] for _ in target_ids]
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=min(_FETCH_WORKERS, len(target_ids))
    ) as pool:
        futures = {
            pool.submit(
                fetch_source_items, sid, data_dir=data_dir, limit=60, force=force
            ): idx
            for idx, sid in enumerate(target_ids)
        }
        for fut in concurrent.futures.as_completed(futures):
            idx = futures[fut]
            try:
                groups[idx] = fut.result()
            except Exception as exc:  # noqa: BLE001
                log.info("source fetch failed: %s", exc)
    return groups


def list_sources() -> list[dict[str, Any]]:
    """源目录（给前端渲染选择器用），按考研权重降序。"""
    return [
        {
            "id": s["id"],
            "name": s["name"],
            "en_name": s["en_name"],
            "badge": s["badge"],
            "home": s["home"],
            "topics": s["topics"],
            "weight": s["weight"],
            "fulltext": bool(s.get("fulltext")),
        }
        for s in sorted(READING_SOURCES, key=lambda s: s.get("weight", 0), reverse=True)
    ]


# ==============================================================================
# 统一检索
# ==============================================================================


def _interleave(groups: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
    """按源轮转交错，避免权重最高的源把整页名额吃光（否则"多源"是假的）。"""
    out: list[dict[str, Any]] = []
    depth = max((len(g) for g in groups), default=0)
    for i in range(depth):
        for group in groups:
            if i < len(group):
                out.append(group[i])
    return out


def _enrich_item(item: dict[str, Any]) -> dict[str, Any]:
    """列表页条目补齐展示字段：难度占位 + 词数 + 文章年龄（天，未知为 None）。"""
    enriched = dict(item)
    enriched["difficulty"] = PENDING_DIFFICULTY
    enriched["word_count"] = len(_WORD_RE.findall(item["snippet"]))
    ts = item.get("pub_ts") or 0
    enriched["age_days"] = max(0, int((time.time() - ts) / 86400)) if ts else None
    return enriched


def search_articles(
    *,
    query: str = "",
    source_id: str = "",
    topic: str = "",
    limit: int = 40,
    data_dir: Path | str | None = None,
    force: bool = False,
    stats: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """跨源实时检索：关键词 / 来源 / 主题 三维过滤 + 按源轮转保多样性。

    `stats` 传入一个 dict 时，会回填本次抓取的诊断信息（几个源连上了、命中多少条）。
    界面上「搜不出来」时靠它区分是「网络全挂了」还是「确实没有匹配」。
    """
    if source_id and source_id in _SOURCE_BY_ID:
        target_ids = [source_id]
    else:
        target_ids = [s["id"] for s in READING_SOURCES]

    groups = _fetch_many(target_ids, data_dir=data_dir, force=force)
    merged = _interleave(groups)

    # 同一篇文章可能被多个源转载，按 URL 去重（保留先出现的）
    deduped: dict[str, dict[str, Any]] = {}
    for item in merged:
        deduped.setdefault(item["url"], item)

    if stats is not None:
        stats["sources_total"] = len(target_ids)
        stats["sources_ok"] = sum(1 for g in groups if g)
        stats["items_raw"] = len(deduped)

    terms = [t.lower() for t in (query or "").split() if t.strip()]
    picked: list[dict[str, Any]] = []
    for item in deduped.values():
        blob = f"{item['title']} {item['snippet']}".lower()
        if terms and not all(t in blob for t in terms):
            continue
        if topic and topic != "all" and item.get("topic") != topic:
            continue
        picked.append(_enrich_item(item))
        if len(picked) >= limit:
            break
    return picked


# ==============================================================================
# 全文抓取（trafilatura 优先，bs4 兜底；只进内存 LRU）
# ==============================================================================


def _extract_with_trafilatura(html: str) -> tuple[str, str]:
    try:
        import trafilatura
    except ImportError:
        return "", ""
    text, title = "", ""
    try:
        text = trafilatura.extract(
            html, include_comments=False, include_tables=False, favor_precision=True
        ) or ""
        metadata = trafilatura.extract_metadata(html)
        if metadata is not None and getattr(metadata, "title", None):
            title = str(metadata.title).strip()
    except Exception as exc:  # noqa: BLE001
        log.info("trafilatura extract failed: %s", exc)
    return text, title


def _extract_with_bs4(html: str) -> tuple[str, str]:
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        return "", ""
    soup = BeautifulSoup(html, "lxml")
    for bad in soup(["script", "style", "nav", "footer", "header", "aside", "form", "iframe"]):
        bad.decompose()
    title = soup.title.get_text(strip=True) if soup.title else ""
    best = ""
    for selector in (
        "article", "main", '[itemprop="articleBody"]', '[class*="article-body"]',
        '[class*="articleBody"]', '[class*="story-body"]', '[class*="post-content"]',
        '[class*="entry-content"]', '[class*="content"]',
    ):
        for node in soup.select(selector):
            candidate = "\n".join(p.get_text(" ", strip=True) for p in node.find_all("p"))
            if len(candidate.split()) > len(best.split()):
                best = candidate
    if len(best.split()) < 120:
        fallback = "\n".join(p.get_text(" ", strip=True) for p in soup.find_all("p"))
        if len(fallback.split()) > len(best.split()):
            best = fallback
    return best, title


def fetch_article_text(url: str, *, timeout: float = 25.0) -> dict[str, Any]:
    """抓取并清洗单篇正文，返回 {ok, title, passage, paragraphs, word_count}。"""
    resp = _http_get(url, timeout=timeout)
    if resp is None:
        return {"ok": False, "error": "网络不可达或超时，请稍后重试"}
    if resp.status_code != 200:
        return {"ok": False, "error": f"抓取失败（HTTP {resp.status_code}）"}

    html = resp.text
    text, title = _extract_with_trafilatura(html)
    if len(text.split()) < 120:
        alt_text, alt_title = _extract_with_bs4(html)
        if len(alt_text.split()) > len(text.split()):
            text, title = alt_text, (alt_title or title)

    passage = clean_passage(text)
    if len(passage.split()) < 80:
        return {"ok": False, "error": "正文太短，可能被反爬或需登录；建议换一篇"}

    return {
        "ok": True,
        "title": title or "",
        "passage": passage,
        "paragraphs": [p for p in passage.split("\n\n") if p.strip()],
        "word_count": len(_WORD_RE.findall(passage)),
    }


def _cache_put(article_id: str, payload: dict[str, Any]) -> None:
    with _cache_lock:
        _fulltext_cache[article_id] = payload
        if article_id in _fulltext_order:
            _fulltext_order.remove(article_id)
        _fulltext_order.append(article_id)
        while len(_fulltext_order) > _FULLTEXT_CACHE_SIZE:
            _fulltext_cache.pop(_fulltext_order.pop(0), None)


def _cache_get(article_id: str) -> dict[str, Any] | None:
    with _cache_lock:
        return _fulltext_cache.get(article_id)


def _find_meta(article_id: str, data_dir: Path | str | None) -> dict[str, Any]:
    for bucket in _read_feed_cache(data_dir).values():
        for item in bucket.get("items") or []:
            if item.get("id") == article_id:
                return item
    return {}


def load_article(
    article_id: str,
    *,
    url: str = "",
    data_dir: Path | str | None = None,
) -> dict[str, Any]:
    """按 id 或 url 取全文精读卡片（内存 LRU 命中则零网络）。"""
    cached = _cache_get(article_id)
    if cached:
        return dict(cached)

    meta = _find_meta(article_id, data_dir)
    target_url = (url or meta.get("url") or "").strip()
    if not target_url:
        return {"ok": False, "error": "找不到这篇文章，请重新检索后再试。"}

    fetched = fetch_article_text(target_url)
    if not fetched.get("ok"):
        return {"ok": False, "error": fetched.get("error", "抓取失败"), "url": target_url}

    passage = fetched["passage"]
    title = fetched["title"] or meta.get("title") or "Online Reading"
    source = _SOURCE_BY_ID.get(meta.get("source_id", ""), {})
    payload = {
        "ok": True,
        "id": article_id,
        "title": title,
        "source_name": meta.get("source_name") or source.get("name") or "联网外刊",
        "source": meta.get("source") or source.get("en_name") or "",
        "url": target_url,
        "style": "权威外刊原文",
        "category": classify_topic(title, passage, source.get("topics")),
        "difficulty": estimate_difficulty(passage),
        "passage": passage,
        "paragraphs": fetched["paragraphs"],
        "word_count": fetched["word_count"],
        "key_sentences": extract_key_sentences(passage),
        "date": meta.get("date", ""),
        "source_mode": "online_feed",
        "ai_generated": False,
    }
    _cache_put(article_id, payload)
    return dict(payload)


def build_quickstart(
    *, data_dir: Path | str | None = None, limit: int = 12
) -> list[dict[str, Any]]:
    """快速上手：直接给一批「现在就能读」的文章，用户不必先想搜什么。

    这是降低启动成本的关键——打开就能点一篇开始精读，而不是面对空白搜索框。
    只取支持全文抽取的源，保证点进去真能读，而不是点开发现抓不到正文。
    """
    groups = [
        fetch_source_items(s["id"], data_dir=data_dir, limit=6)
        for s in READING_SOURCES
        if s.get("fulltext")
    ]
    picked: list[dict[str, Any]] = []
    for item in _interleave(groups):
        picked.append(_enrich_item(item))
        if len(picked) >= limit:
            break
    return picked