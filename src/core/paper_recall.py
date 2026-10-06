"""论文全网检索管线 v2：查询理解 → 多路并发召回 → RRF 融合 → 规则精排

为什么要有这个模块（2026-09-26 实测，设计说明见 .workbuddy/design/paper-retrieval-2026-09-26.md）：

  - **Semantic Scholar 无 key → 匿名共享池，实测 HTTP 429**。旧实现重试 2 次后掉进 Crossref，
    而 **Crossref 没有相关性模型**（纯词项重叠，score 无排序含义）：
    `query=光致超声 创面深度检测` 实测返回 **65773** 条，前排全是「建筑声呐检测」「横向裂纹超声波检测」
    「锂电池超声无损检测」。这就是「输入关键词返回五花八门」的根因 —— 不是关键词的问题。
  - **OpenAlex 无 key → 免费额度按 IP 全网络共享**，实测 429
    （"$0 remaining; resets at midnight UTC"）→ 只在配置了 api_key 时才启用。
  - **Europe PMC**：免费、无 key、**有真相关性排序** + 字段语法（`TITLE_ABS:"…"`）+ `sort=CITED desc`
    + 中文可搜（且收录中文文献）+ 免费全文/PDF 链接 → **主源**。
    实测 `TITLE_ABS:"photoacoustic" AND TITLE_ABS:"wound"` → 75 条，前排是「烧伤创面光声评估」
    「皮肤创面无创成像技术」，与 Crossref 的 65773 条垃圾形成对照。
  - **arXiv**：免费（1 req/3s），补 CS / 机器人 / 具身智能的预印本。

四层职责（每层只解决一个问题）：
  L0 查询理解  `plan_query()`   中文 → 英文核心术语 + 同义表达 + 学科（弱模型短提示词；失败降级为原样直发）
  L1 多路召回  `_fetch_*()`     Europe PMC（严格式 + 宽式各一路）· Semantic Scholar · arXiv，线程池并发
  L2 融合      `rrf_fuse()`     RRF `Σ 1/(60+rank)`，只吃排名不吃分数（规避各源分数量纲不可比）
  L3 精排      `rerank()`       术语命中 × 引文分位 × 新近度 × 可得性 × 学科命中（**零模型调用**）

全部函数同步（与 core/paper_search.py 一致），由调用方 `asyncio.to_thread()` 包一层。
不新增任何第三方依赖：只要 httpx（已有）。
"""
from __future__ import annotations

import html
import json
import logging
import math
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Any
from xml.etree import ElementTree as ET

import httpx

from core import paper_search as _ps

log = logging.getLogger(__name__)

_TIMEOUT = httpx.Timeout(20.0, connect=10.0)
_HEADERS = {"User-Agent": "KnowOrigin/1.0 (academic-search; https://github.com/knoworigin)"}

# 每源过取倍数：引文/开放获取/年份都在融合后统一过滤，过取才能过滤后仍有足够候选
_OVERFETCH = 3
_MAX_PER_SOURCE = 60
_RRF_K = 60

_PIPELINE = "recall-v2"

# 源标识 → 展示名
SOURCE_LABELS = {
    "europepmc": "Europe PMC",
    "semantic_scholar": "Semantic Scholar",
    "arxiv": "arXiv",
    "openalex": "OpenAlex",
    "crossref": "Crossref",
}


# ────────────────────── 工具 ──────────────────────

_TAG_RE = re.compile(r"<[^>]+>")


def _clean(text: Any) -> str:
    """Europe PMC / Crossref 的标题摘要里带 HTML 实体与 `<sup>` 之类标签，统一洗干净。"""
    if text is None:
        return ""
    s = html.unescape(str(text))
    s = _TAG_RE.sub("", s)
    return re.sub(r"\s+", " ", s).strip()


def _as_int(v: Any, default: int = 0) -> int:
    try:
        return int(str(v).strip())
    except Exception:
        return default


def _norm_title(title: str) -> str:
    """标题归一化（用于跨源去重）：只留字母数字，小写，截断。"""
    t = re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", (title or "").lower())
    return t[:120]


def _norm_key(p: dict[str, Any]) -> str:
    """跨源去重键：DOI > arXiv > PMID > 归一化标题。"""
    doi = (p.get("doi") or "").strip().lower()
    if doi:
        return f"doi:{doi}"
    ax = (p.get("arxivId") or "").strip().lower()
    if ax:
        return f"axv:{ax}"
    pmid = str(p.get("pmid") or "").strip()
    if pmid:
        return f"pmid:{pmid}"
    t = _norm_title(p.get("title") or "")
    return f"t:{t}" if t else ""


def _richness(p: dict[str, Any]) -> int:
    """同一篇论文被多源命中时，保留信息量最大的那份记录。"""
    score = len(p.get("abstract") or "")
    if p.get("pdfUrl"):
        score += 200
    if p.get("citationCount"):
        score += 100
    if p.get("recentCitations"):
        score += 50
    return score


def parse_year_span(year: str | None) -> tuple[int | None, int | None]:
    """把 UI 传来的年份串解析成 (from, to)。支持 '2020' / '2020-2024' / '2020-' / '-2024'。"""
    if not year or not str(year).strip():
        return (None, None)
    s = str(year).strip()
    m = re.match(r"^(\d{4})?\s*-\s*(\d{4})?$", s)
    if m:
        lo = int(m.group(1)) if m.group(1) else None
        hi = int(m.group(2)) if m.group(2) else None
        return (lo, hi)
    if re.match(r"^\d{4}$", s):
        y = int(s)
        return (y, y)
    return (None, None)


def env_openalex_key() -> str:
    """OpenAlex 需要自带 key（无 key 的免费额度已全网络共享用尽）。

    走环境变量而非 Settings 字段：不进仓库、不动 /api/config 的显式字段列表、
    有 key 就自动启用，没 key 就在结果里如实说明"已跳过"。命名沿用 config.py 的 KNOWORIGIN_* 前缀。
    """
    import os

    return (os.environ.get("KNOWORIGIN_OPENALEX_KEY")
            or os.environ.get("OPENALEX_API_KEY")
            or "").strip()


def _is_doi(q: str) -> bool:
    return bool(re.match(r"^(doi:)?\s*10\.\d{4,9}/\S+$", (q or "").strip(), re.I))


def _norm_doi(q: str) -> str:
    return re.sub(r"^doi:\s*", "", (q or "").strip(), flags=re.I)


# ────────────────────── L0 查询理解 ──────────────────────

_PLAN_TASK = "paper_query_plan"

# ⚠️ 弱模型（tju-llm）提示词铁律：只给当前这一支动作 + 3 条硬约束，不写条件分支。
_PLAN_PROMPT = (
    "把用户想找的论文主题转成英文学术检索词。\n"
    "只输出 JSON，不要任何解释：\n"
    '{"terms":["英文核心术语"],"synonyms":["英文同义术语"],"field":"学科英文名"}\n'
    "terms 填 1~5 个**必须同时满足**的核心英文术语；synonyms 填 0~5 个可选同义表达；field 填一个学科英文词。\n"
    "完全不确定的术语直接省略，绝不编造。\n"
    "用户主题："
)


def _clean_terms(raw: Any, limit: int = 6) -> list[str]:
    out: list[str] = []
    if not isinstance(raw, list):
        return out
    for item in raw:
        t = _clean(item)
        # 术语里的双引号会破坏 Europe PMC 的字段语法，逗号会破坏作者检索，一律去掉
        t = re.sub(r'["\u201c\u201d,]', " ", t)
        t = re.sub(r"\s+", " ", t).strip()
        if not t or len(t) > 60:
            continue
        if t.lower() in {x.lower() for x in out}:
            continue
        out.append(t)
        if len(out) >= limit:
            break
    return out


# 弱模型（tju-llm）实测会把键名换成 keywords、把 JSON 包进 {"answer": "```json … ```"}。
# 直接判失败会让改写**静默失效**（用户看到的还是垃圾结果，却不知道是哪一层坏的），所以做一轮打捞。
_PLAN_TERM_KEYS = ("terms", "keywords", "key_terms", "keyword", "queries", "concepts", "core_terms")
_PLAN_SYN_KEYS = ("synonyms", "synonym", "aliases", "expansions", "alternatives", "related_terms")
_PLAN_FIELD_KEYS = ("field", "domain", "discipline", "subject", "area")


def _coerce_str_list(value: Any) -> list[str]:
    """把模型给的各种形状（str / "a, b" / 嵌套 list）压成字符串列表。"""
    if isinstance(value, str):
        return [_clean(p) for p in re.split(r"[,;、，\n]+", value) if _clean(p)]
    if isinstance(value, list):
        out: list[str] = []
        for item in value:
            out.extend(_coerce_str_list(item))
        return out
    return []


def _parse_json_in_text(text: str) -> Any:
    """从带代码块围栏 / 前后废话的文本里解析出第一个 JSON 对象或数组。

    复用 core/llm.py 已有的 `_json_payload_candidates`（它同时处理围栏、截断修复与平衡括号提取）；
    拿不到时退化成一套本地最小实现，保证本模块单独可测。
    """
    if not isinstance(text, str) or not text.strip():
        return None
    try:
        from core.llm import _json_payload_candidates as _candidates  # 惰性导入，避免拖入整条依赖链

        candidates = _candidates(text)
    except Exception:  # noqa: BLE001
        fence = chr(96) * 3
        stripped = text.strip()
        candidates = [stripped]
        if fence in stripped:
            for part in stripped.split(fence)[1::2]:
                cleaned = part.strip()
                if cleaned.lower().startswith("json"):
                    cleaned = cleaned[4:].strip()
                if cleaned:
                    candidates.append(cleaned)
        start, end = stripped.find("{"), stripped.rfind("}")
        if 0 <= start < end:
            candidates.append(stripped[start : end + 1].strip())
    for cand in candidates:
        try:
            return json.loads(cand)
        except Exception:  # noqa: BLE001
            continue
    return None


def _pull_plan(obj: Any) -> dict[str, Any] | None:
    """从一个 dict 里按多种别名抠出 terms / synonyms / field。"""
    if not isinstance(obj, dict):
        return None
    out: dict[str, Any] = {}
    for key in _PLAN_TERM_KEYS:
        if obj.get(key):
            terms = _coerce_str_list(obj[key])
            if terms:
                out["terms"] = terms
                break
    for key in _PLAN_SYN_KEYS:
        if obj.get(key):
            syns = _coerce_str_list(obj[key])
            if syns:
                out["synonyms"] = syns
                break
    for key in _PLAN_FIELD_KEYS:
        value = obj.get(key)
        if isinstance(value, str) and value.strip():
            out["field"] = _clean(value)
            break
    return out or None


def salvage_plan(resp: Any) -> dict[str, Any] | None:
    """从任意形状的模型输出里把检索计划捞出来。捞不到返回 None。

    打捞范围刻意收窄：只下钻 **dict 与字符串**（字符串里的代码块 JSON）、以及**顶层裸列表**。
    不把嵌套的裸列表当术语 —— 那会把 `{"steps": ["先…","再…"]}` 这种跑偏输出误当成检索词，
    结果比直接用原词更差。
    """
    return _salvage(resp, depth=3)


def _salvage(node: Any, depth: int) -> dict[str, Any] | None:
    if depth <= 0:
        return None
    direct = _pull_plan(node)
    if direct and direct.get("terms"):
        return direct
    if isinstance(node, list):
        return _terms_from_bare_list(node)
    if isinstance(node, str):
        parsed = _parse_json_in_text(node)
        return _salvage(parsed, depth - 1) if isinstance(parsed, (dict, list)) else None
    if not isinstance(node, dict):
        return None
    for value in node.values():
        if isinstance(value, (dict, str)):
            found = _salvage(value, depth - 1)
            if found and found.get("terms"):
                return found
    return None


def _terms_from_bare_list(items: Any) -> dict[str, Any] | None:
    """无键名的裸列表：只有**全部是短词**时才当术语表。

    模型跑偏时会吐一整段句子列表，那种直接当检索式只会比原词更差 —— 宁可降级不猜。
    """
    terms = _coerce_str_list(items)
    if not terms or len(terms) > 8:
        return None
    for t in terms:
        if len(t) > 40 or len(t.split()) > 5:
            return None
    return {"terms": terms, "synonyms": [], "field": ""}


def plan_query(query: str, llm=None, enabled: bool = True) -> dict[str, Any]:
    """L0：把用户输入转成检索式。

    任何一步失败都**降级为原样直发**，绝不阻塞检索（`rewritten=False`）。
    返回 {raw, terms, synonyms, field, rewritten, note}
    """
    raw = (query or "").strip()
    plan: dict[str, Any] = {
        "raw": raw,
        "terms": [],
        "synonyms": [],
        "field": "",
        "rewritten": False,
        "note": "",
    }
    if not enabled or llm is None or not raw:
        plan["note"] = "未启用改写" if not enabled else "无可用模型，按原词检索"
        return plan

    # 已经是英文且很短（像专业术语串）就没必要多花一次模型调用
    try:
        resp = llm.complete_json(_PLAN_TASK, {"prompt": _PLAN_PROMPT + raw})
    except Exception as exc:  # noqa: BLE001 - 任何异常都降级，检索必须能跑下去
        log.warning("query plan failed: %s", exc)
        plan["note"] = "改写失败，按原词检索"
        return plan

    salvaged = salvage_plan(resp)
    if not salvaged:
        plan["note"] = f"模型输出无法解析（{str(resp)[:60]}），按原词检索"
        return plan

    terms = _clean_terms(salvaged.get("terms"))
    if not terms:
        plan["note"] = "模型未给出可用术语，按原词检索"
        return plan

    plan["terms"] = terms
    plan["synonyms"] = _clean_terms(salvaged.get("synonyms"), limit=6)
    plan["field"] = _clean(salvaged.get("field"))[:60]
    plan["rewritten"] = True
    return plan


def build_epmc_queries(plan: dict[str, Any]) -> tuple[str, str]:
    """由检索计划生成 Europe PMC 的（严格式, 宽式）。

    严格式 = 核心术语逐个 `TITLE_ABS:"…"` 用 AND 串起来 → 高精度；
    宽式   = 核心术语 + 同义表达空格连写，交给 Europe PMC 自己的相关性模型 → 高召回。
    两者都进 RRF，精度与召回两头都保住。
    """
    terms = plan.get("terms") or []
    synonyms = plan.get("synonyms") or []
    raw = plan.get("raw") or ""

    if not terms:
        # 未改写：原词直接走宽式（Europe PMC 对中文也能搜）
        return ("", raw)

    strict = " AND ".join(f'TITLE_ABS:"{t}"' for t in terms)
    broad = " ".join(terms + synonyms).strip()
    return (strict, broad)


def build_plain_query(plan: dict[str, Any]) -> str:
    """给不吃字段语法的源（Semantic Scholar / arXiv）用的宽式检索式。"""
    terms = plan.get("terms") or []
    synonyms = plan.get("synonyms") or []
    if terms:
        return " ".join(terms + synonyms).strip()
    return plan.get("raw") or ""


# ────────────────────── L1 多路召回 ──────────────────────

_EPMC_SEARCH = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"


def _epmc_sort(sort: str | None) -> str:
    if sort == "citationCount:desc":
        return "CITED desc"
    if sort == "publicationDate:desc":
        return "P_PDATE_D desc"
    return ""


def _epmc_pdf_url(item: dict[str, Any]) -> str:
    """从 fullTextUrlList 里挑一个最可能直下 PDF 的链接。"""
    urls = ((item.get("fullTextUrlList") or {}).get("fullTextUrl")) or []
    best_pdf = ""
    best_free = ""
    for u in urls:
        link = u.get("url") or ""
        if not link:
            continue
        style = (u.get("documentStyle") or "").lower()
        code = u.get("availabilityCode") or ""
        if style == "pdf" and code == "F" and not best_pdf:
            best_pdf = link
        elif style == "pdf" and not best_pdf:
            best_pdf = link
        if code == "F" and style in ("html", "doi") and not best_free:
            best_free = link
    return best_pdf or best_free


def _epmc_normalize(item: dict[str, Any]) -> dict[str, Any]:
    """Europe PMC core 记录 → 与 core/paper_search._normalize_paper 同形状（只增字段）。"""
    authors_raw = ((item.get("authorList") or {}).get("author")) or []
    authors: list[dict[str, Any]] = []
    for a in authors_raw:
        name = _clean(a.get("fullName") or a.get("collectiveName") or "")
        if name:
            authors.append({"name": name, "authorId": a.get("authorId") or None})
    if not authors:
        # authorList 缺失时退化成 "A, B, C." 串
        for name in _clean(item.get("authorString") or "").rstrip(".").split(","):
            name = name.strip()
            if name:
                authors.append({"name": name, "authorId": None})

    journal = ((item.get("journalInfo") or {}).get("journal")) or {}
    venue = _clean(journal.get("title") or journal.get("medlineAbbreviation") or "")

    mesh = [
        _clean(m.get("descriptorName"))
        for m in (((item.get("meshHeadingList") or {}).get("meshHeading")) or [])
    ]
    mesh = [m for m in mesh if m][:12]
    keywords = [
        _clean(k)
        for k in (((item.get("keywordList") or {}).get("keyword")) or [])
    ]
    keywords = [k for k in keywords if k][:12]
    pub_types = [
        _clean(t)
        for t in (((item.get("pubTypeList") or {}).get("pubType")) or [])
    ]

    year = _as_int(item.get("pubYear"), 0) or None
    is_oa = (item.get("isOpenAccess") or "N").upper() == "Y"
    has_pdf = (item.get("hasPDF") or "N").upper() == "Y"
    pdf_url = _epmc_pdf_url(item)

    return {
        "paperId": item.get("id") or item.get("pmid") or item.get("doi") or "",
        "title": _clean(item.get("title")),
        "abstract": _clean(item.get("abstractText")),
        "year": year,
        "citationCount": _as_int(item.get("citedByCount")),
        "influentialCitationCount": 0,
        "venue": venue,
        "publicationDate": item.get("firstPublicationDate"),
        "authors": authors,
        "doi": (item.get("doi") or "").strip(),
        "arxivId": "",
        "pdfUrl": pdf_url,
        # 有免费 PDF 链接也算可得（isOpenAccess 在 Europe PMC 口径偏窄）
        "isOpenAccess": is_oa or has_pdf or bool(pdf_url),
        "fieldsOfStudy": [],
        "pmid": str(item.get("pmid") or ""),
        "pmcid": str(item.get("pmcid") or ""),
        "meshTerms": mesh,
        "keywords": keywords,
        "pubTypes": pub_types,
        "language": item.get("language") or "",
        "source": "europepmc",
        "sourceDb": item.get("source") or "",
    }


def fetch_europepmc(
    query: str,
    limit: int,
    offset: int = 0,
    years: tuple[int | None, int | None] = (None, None),
    sort: str | None = None,
) -> dict[str, Any]:
    """Europe PMC 单路检索。query 为空则视为该路不可用（返回空）。"""
    label = SOURCE_LABELS["europepmc"]
    if not (query or "").strip():
        return {"source": "europepmc", "label": label, "hits": 0, "papers": [], "ok": True, "note": "该路省略"}

    lo, hi = years
    q = query.strip()
    if lo and hi:
        q = f"({q}) AND (PUB_YEAR:[{lo} TO {hi}])"
    elif lo:
        q = f"({q}) AND (PUB_YEAR:[{lo} TO 3000])"
    elif hi:
        q = f"({q}) AND (PUB_YEAR:[1800 TO {hi}])"

    params: dict[str, Any] = {
        "query": q,
        "format": "json",
        "pageSize": min(max(limit, 1), 100),
        "resultType": "core",
    }
    if offset:
        # 用 cursorMark 才能深翻；首页用 page 更省事
        params["page"] = (offset // max(limit, 1)) + 1
    epmc_sort = _epmc_sort(sort)
    if epmc_sort:
        params["sort"] = epmc_sort

    try:
        r = httpx.get(_EPMC_SEARCH, params=params, headers=_HEADERS, timeout=_TIMEOUT)
        r.raise_for_status()
        data = r.json()
    except Exception as exc:  # noqa: BLE001
        log.warning("Europe PMC search failed: %s", exc)
        return {"source": "europepmc", "label": label, "hits": 0, "papers": [], "ok": False,
                "note": f"请求失败：{type(exc).__name__}"}

    items = ((data.get("resultList") or {}).get("result")) or []
    papers = [_epmc_normalize(it) for it in items]
    papers = [p for p in papers if p.get("title")]
    return {
        "source": "europepmc",
        "label": label,
        "hits": _as_int(data.get("hitCount")),
        "papers": papers,
        "ok": True,
        "note": "",
    }


def fetch_semantic_scholar(
    query: str,
    limit: int,
    offset: int = 0,
    year: str | None = None,
    fields_of_study: str | None = None,
    sort: str | None = None,
) -> dict[str, Any]:
    """Semantic Scholar 单路检索。

    复用 `paper_search.search_papers`（它自带 429 重试），但**明确拒绝它的 Crossref 退路**：
    Crossref 没有相关性模型，拿它的结果当"语义检索结果"是错的（旧实现就是这么坏掉的）。
    """
    label = SOURCE_LABELS["semantic_scholar"]
    if not (query or "").strip():
        return {"source": "semantic_scholar", "label": label, "hits": 0, "papers": [], "ok": True, "note": "该路省略"}
    try:
        res = _ps.search_papers(
            query.strip(), offset=offset, limit=min(max(limit, 1), 100),
            year=year, fields_of_study=fields_of_study, sort=sort,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("Semantic Scholar search failed: %s", exc)
        return {"source": "semantic_scholar", "label": label, "hits": 0, "papers": [], "ok": False,
                "note": f"请求失败：{type(exc).__name__}"}

    if res.get("source") == "crossref":
        return {
            "source": "semantic_scholar", "label": label, "hits": 0, "papers": [], "ok": False,
            "note": "限流（无 key 共享池），已跳过；不用 Crossref 兜底（它没有相关性模型）",
        }

    papers = res.get("papers") or []
    for p in papers:
        p["source"] = "semantic_scholar"
        p.setdefault("meshTerms", [])
        p.setdefault("keywords", [])
    return {
        "source": "semantic_scholar",
        "label": label,
        "hits": _as_int(res.get("total")) or len(papers),
        "papers": papers,
        "ok": True,
        "note": "",
    }


_ARXIV_API = "https://export.arxiv.org/api/query"
_ATOM = "{http://www.w3.org/2005/Atom}"
_ARXIV_NS = "{http://arxiv.org/schemas/atom}"


def fetch_arxiv(query: str, limit: int, offset: int = 0, sort: str | None = None) -> dict[str, Any]:
    """arXiv 单路检索（只有摘要，无引用数）。限速 1 req/3s，故只发一路。"""
    label = SOURCE_LABELS["arxiv"]
    if not (query or "").strip():
        return {"source": "arxiv", "label": label, "hits": 0, "papers": [], "ok": True, "note": "该路省略"}

    # arXiv 的 all:"x" AND all:"y" 写法实测返回 0 条，用空格连写交给它自己做相关性排序
    q = re.sub(r'["\u201c\u201d]', " ", query).strip()
    params: dict[str, Any] = {
        "search_query": f"all:{q}",
        "start": max(offset, 0),
        "max_results": min(max(limit, 1), 100),
    }
    if sort == "publicationDate:desc":
        params["sortBy"] = "submittedDate"
        params["sortOrder"] = "descending"

    try:
        r = httpx.get(_ARXIV_API, params=params, headers=_HEADERS, timeout=_TIMEOUT,
                      follow_redirects=True)
        r.raise_for_status()
        root = ET.fromstring(r.content)
    except Exception as exc:  # noqa: BLE001
        log.warning("arXiv search failed: %s", exc)
        return {"source": "arxiv", "label": label, "hits": 0, "papers": [], "ok": False,
                "note": f"请求失败：{type(exc).__name__}"}

    papers: list[dict[str, Any]] = []
    for entry in root.findall(f"{_ATOM}entry"):
        raw_id = (entry.findtext(f"{_ATOM}id") or "").strip()
        ax_id = ""
        m = re.search(r"arxiv\.org/abs/(.+?)(v\d+)?$", raw_id)
        if m:
            ax_id = m.group(1)
        title = _clean(entry.findtext(f"{_ATOM}title"))
        if not title:
            continue
        authors = [
            {"name": _clean(a.findtext(f"{_ATOM}name")), "authorId": None}
            for a in entry.findall(f"{_ATOM}author")
        ]
        authors = [a for a in authors if a["name"]]
        published = (entry.findtext(f"{_ATOM}published") or "").strip()
        year = _as_int(published[:4], 0) or None
        pdf_url = ""
        for link in entry.findall(f"{_ATOM}link"):
            if (link.get("title") or "") == "pdf" or link.get("type") == "application/pdf":
                pdf_url = link.get("href") or ""
                break
        if not pdf_url and ax_id:
            pdf_url = f"https://arxiv.org/pdf/{ax_id}"
        categories = [_clean(c.get("term")) for c in entry.findall(f"{_ATOM}category")]
        primary = entry.find(f"{_ARXIV_NS}primary_category")
        papers.append({
            "paperId": ax_id or raw_id,
            "title": title,
            "abstract": _clean(entry.findtext(f"{_ATOM}summary")),
            "year": year,
            "citationCount": 0,
            "influentialCitationCount": 0,
            "venue": _clean(primary.get("term")) if primary is not None else "arXiv",
            "publicationDate": published[:10] or None,
            "authors": authors,
            "doi": "",
            "arxivId": ax_id,
            "pdfUrl": pdf_url,
            "isOpenAccess": True,
            "fieldsOfStudy": [c for c in categories if c][:6],
            "meshTerms": [],
            "keywords": [],
            "source": "arxiv",
        })

    total = 0
    for el in root.iter(f"{_ATOM}totalResults"):
        total = _as_int(el.text)
        break
    return {
        "source": "arxiv",
        "label": label,
        "hits": total or len(papers),
        "papers": papers,
        "ok": True,
        "note": "" if papers else "无命中",
    }


def fetch_openalex(
    query: str, limit: int, api_key: str | None, offset: int = 0, sort: str | None = None
) -> dict[str, Any]:
    """OpenAlex 单路检索 —— **只有配置了 api_key 才启用**。

    2026-02-24 起 OpenAlex 转为用量计费：无 key 的免费额度是**按 IP 全网络共享**的，
    实测直接 429（"$0 remaining; resets at midnight UTC"）。没有 key 就没必要浪费一次超时。
    """
    label = SOURCE_LABELS["openalex"]
    if not (api_key or "").strip():
        return {"source": "openalex", "label": label, "hits": 0, "papers": [], "ok": False,
                "note": "未配置 API key（无 key 的额度已全网络用尽），已跳过"}
    if not (query or "").strip():
        return {"source": "openalex", "label": label, "hits": 0, "papers": [], "ok": True, "note": "该路省略"}

    params: dict[str, Any] = {
        "search": query.strip(),
        "per-page": min(max(limit, 1), 100),
        "page": (offset // max(limit, 1)) + 1,
        "select": ("id,doi,title,publication_year,publication_date,cited_by_count,is_oa,"
                   "primary_location,authorships,relevance_score,abstract_inverted_index,type"),
    }
    if sort == "citationCount:desc":
        params["sort"] = "cited_by_count:desc"
    elif sort == "publicationDate:desc":
        params["sort"] = "publication_date:desc"

    try:
        r = httpx.get("https://api.openalex.org/works", params=params,
                      headers={**_HEADERS, "Authorization": f"Bearer {api_key.strip()}"},
                      timeout=_TIMEOUT)
        r.raise_for_status()
        data = r.json()
    except Exception as exc:  # noqa: BLE001
        log.warning("OpenAlex search failed: %s", exc)
        return {"source": "openalex", "label": label, "hits": 0, "papers": [], "ok": False,
                "note": f"请求失败：{type(exc).__name__}"}

    papers = [_openalex_normalize(it) for it in (data.get("results") or [])]
    papers = [p for p in papers if p.get("title")]
    hits = _as_int(((data.get("meta") or {}).get("count")))
    return {"source": "openalex", "label": label, "hits": hits or len(papers),
            "papers": papers, "ok": True, "note": ""}


def _openalex_abstract(inv: Any) -> str:
    """OpenAlex 用倒排索引存摘要：{词: [位置,…]} → 还原成正文。"""
    if not isinstance(inv, dict) or not inv:
        return ""
    slots: dict[int, str] = {}
    for word, positions in inv.items():
        if not isinstance(positions, list):
            continue
        for pos in positions:
            if isinstance(pos, int):
                slots[pos] = word
    if not slots:
        return ""
    return " ".join(slots[k] for k in sorted(slots))


def _openalex_normalize(item: dict[str, Any]) -> dict[str, Any]:
    loc = item.get("primary_location") or {}
    src = (loc.get("source") or {}) if isinstance(loc.get("source"), dict) else {}
    authors = []
    for a in (item.get("authorships") or []):
        name = _clean(((a.get("author") or {}) if isinstance(a.get("author"), dict) else {}).get("display_name"))
        if name:
            authors.append({"name": name, "authorId": None})
    pdf_url = loc.get("pdf_url") or ""
    return {
        "paperId": item.get("id") or item.get("doi") or "",
        "title": _clean(item.get("title")),
        "abstract": _openalex_abstract(item.get("abstract_inverted_index")),
        "year": _as_int(item.get("publication_year"), 0) or None,
        "citationCount": _as_int(item.get("cited_by_count")),
        "influentialCitationCount": 0,
        "venue": _clean(src.get("display_name")),
        "publicationDate": item.get("publication_date"),
        "authors": authors,
        "doi": re.sub(r"^https?://doi\.org/", "", (item.get("doi") or ""), flags=re.I),
        "arxivId": "",
        "pdfUrl": pdf_url,
        "isOpenAccess": bool(item.get("is_oa")),
        "fieldsOfStudy": [],
        "meshTerms": [],
        "keywords": [],
        "source": "openalex",
        "_relevanceRaw": item.get("relevance_score"),
    }


# ────────────────────── L2 融合 ──────────────────────

def rrf_fuse(ranked_lists: list[tuple[str, list[dict[str, Any]]]], k: int = _RRF_K) -> list[dict[str, Any]]:
    """Reciprocal Rank Fusion：`score(d) = Σ 1/(k + rank_i(d))`。

    只吃排名不吃分数 —— 这是关键：Europe PMC 的 hitCount、S2 的相关度、arXiv 的返回顺序
    分数量纲完全不同，直接相加没有意义；按名次融合才可比、才鲁棒（RRF 是生产环境的默认选择）。
    """
    best: dict[str, dict[str, Any]] = {}
    scores: dict[str, float] = {}
    sources: dict[str, list[str]] = {}

    for name, papers in ranked_lists:
        for rank, p in enumerate(papers, start=1):
            key = _norm_key(p)
            if not key:
                continue
            scores[key] = scores.get(key, 0.0) + 1.0 / (k + rank)
            sources.setdefault(key, [])
            if name not in sources[key]:
                sources[key].append(name)
            cur = best.get(key)
            if cur is None or _richness(p) > _richness(cur):
                best[key] = p

    out: list[dict[str, Any]] = []
    for key, s in scores.items():
        p = dict(best[key])
        p["sources"] = sources[key]
        p["multiSource"] = len(sources[key]) > 1
        p["_rrf"] = s
        out.append(p)
    out.sort(key=lambda x: x["_rrf"], reverse=True)
    return out


# ────────────────────── L3 规则精排 ──────────────────────

def rerank(
    papers: list[dict[str, Any]],
    plan: dict[str, Any],
    sort: str | None = None,
    now_year: int | None = None,
) -> list[dict[str, Any]]:
    """零模型调用的规则精排。

    打分 = 融合排名 0.30 + 术语命中 0.32 + 引文（按年衰减）0.16 + 新近度 0.10
         + 可得性（有 PDF / 有摘要）0.06 + 学科命中 0.06

    术语命中权重最高，因为「五花八门」的本质就是"看着像但不对题"；引文要按年衰减，
    否则 1975 年的老文章靠历史引用量一直压着新工作。
    """
    terms = [t.lower() for t in (plan.get("terms") or []) if t]
    synonyms = [t.lower() for t in (plan.get("synonyms") or []) if t]
    probes = terms + synonyms
    field = (plan.get("field") or "").strip().lower()
    now = now_year or datetime.now().year

    max_rrf = max([float(p.get("_rrf") or 0.0) for p in papers] or [1.0]) or 1.0
    cite_scale = math.log1p(2000.0)

    for p in papers:
        title = (p.get("title") or "").lower()
        abstract = (p.get("abstract") or "").lower()
        hay = f"{title} {abstract}"

        s_rank = float(p.get("_rrf") or 0.0) / max_rrf

        if terms:
            hit_t = sum(1 for t in terms if t in title)
            hit_a = sum(1 for t in terms if t in abstract)
            hit_s = sum(1 for t in synonyms if t in hay)
            # 标题命中权重最高，摘要其次，同义命中只算半份 —— 再按术语总数归一并封顶 1
            raw = hit_t * 2.0 + hit_a * 1.0 + hit_s * 0.5
            s_term = min(1.0, raw / max(1.0, len(terms) * 2.5))
        else:
            s_term = 0.5  # 未改写：无从判定，给中性分，不因"没命中术语"而误伤

        year = p.get("year") or now
        age = max(0, now - int(year)) if isinstance(year, (int, float)) else 0
        cites = _as_int(p.get("citationCount"))
        s_cite = (min(1.0, math.log1p(cites) / cite_scale)) * (0.6 ** (age / 10.0))
        s_fresh = max(0.0, 1.0 - age / 12.0)

        s_avail = (0.5 if p.get("pdfUrl") else 0.0) + (0.5 if p.get("abstract") else 0.0)
        s_field = 1.0 if (field and field in hay) else 0.0

        p["relevance"] = round(
            0.30 * s_rank + 0.32 * s_term + 0.16 * s_cite + 0.10 * s_fresh + 0.06 * s_avail + 0.06 * s_field,
            4,
        )

        reasons: list[str] = []
        if terms and hit_t >= max(1, len(terms) // 2):
            reasons.append("标题命中核心术语")
        elif terms and hit_a:
            reasons.append("摘要命中核心术语")
        if s_cite >= 0.5:
            reasons.append(f"{cites} 次引用")
        if age <= 3:
            reasons.append(f"{year} 年新发表")
        if p.get("multiSource"):
            reasons.append("多源同时命中")
        if p.get("pdfUrl"):
            reasons.append("有免费全文")
        p["reasons"] = reasons[:3]

    if sort == "citationCount:desc":
        papers.sort(key=lambda p: (_as_int(p.get("citationCount")), p.get("relevance") or 0), reverse=True)
    elif sort == "publicationDate:desc":
        papers.sort(key=lambda p: (_as_int(p.get("year")), p.get("relevance") or 0), reverse=True)
    else:
        papers.sort(key=lambda p: p.get("relevance") or 0, reverse=True)
    return papers


# ────────────────────── 管线入口 ──────────────────────

def _post_filter(
    papers: list[dict[str, Any]],
    years: tuple[int | None, int | None],
    open_access: bool | None,
    min_citation: int | None,
) -> list[dict[str, Any]]:
    """跨源统一过滤 —— 每个源支持的过滤项不一样，放在融合后做才能保证口径一致。"""
    lo, hi = years
    out = []
    for p in papers:
        y = p.get("year") or 0
        if lo and (not y or y < lo):
            continue
        if hi and y and y > hi:
            continue
        if open_access is True and not p.get("isOpenAccess") and not p.get("pdfUrl"):
            continue
        if min_citation and _as_int(p.get("citationCount")) < min_citation:
            continue
        out.append(p)
    return out


def search_papers_smart(
    query: str,
    offset: int = 0,
    limit: int = 20,
    year: str | None = None,
    fields_of_study: str | None = None,
    open_access: bool | None = None,
    min_citation: int | None = None,
    sort: str | None = None,
    llm=None,
    rewrite: bool = True,
    openalex_api_key: str | None = None,
) -> dict[str, Any]:
    """论文检索主管线。返回结构是旧 `/api/search/papers` 响应的**超集**（只增字段，不改既有键）。

    旧键：total / offset / papers
    新增：sources（各源命中与状态）· degraded（降级原因）· query_plan（改写结果）· pipeline
    """
    q = (query or "").strip()
    empty = {
        "total": 0, "offset": offset, "papers": [], "sources": [], "degraded": [],
        "query_plan": {"raw": q, "terms": [], "synonyms": [], "field": "",
                       "rewritten": False, "note": "空查询"},
        "pipeline": _PIPELINE,
    }
    if not q:
        return empty

    # DOI 直查：用户粘一个 DOI 时，全网模糊检索只会帮倒忙
    if _is_doi(q):
        doi = _norm_doi(q)
        paper = _ps.get_paper_detail(doi)
        if paper:
            paper.setdefault("sources", ["crossref"])
            paper.setdefault("reasons", ["DOI 精确匹配"])
            return {
                "total": 1, "offset": 0, "papers": [paper],
                "sources": [{"id": "crossref", "label": "Crossref",
                             "hits": 1, "used": 1, "ok": True, "note": "DOI 精确匹配"}],
                "degraded": [],
                "query_plan": {"raw": q, "terms": [doi], "synonyms": [], "field": "",
                               "rewritten": False, "note": "DOI 精确匹配"},
                "pipeline": _PIPELINE,
            }
        empty["query_plan"]["note"] = "DOI 未找到"
        return empty

    plan = plan_query(q, llm=llm, enabled=rewrite)
    years = parse_year_span(year)
    per_source = min(max(limit, 1) * _OVERFETCH, _MAX_PER_SOURCE)

    if openalex_api_key is None:
        openalex_api_key = env_openalex_key()

    epmc_strict, epmc_broad = build_epmc_queries(plan)
    plain = build_plain_query(plan)

    jobs = [
        ("europepmc:strict", lambda: fetch_europepmc(epmc_strict, per_source, offset, years, sort)),
        ("europepmc:broad", lambda: fetch_europepmc(epmc_broad, per_source, offset, years, sort)),
        ("semantic_scholar", lambda: fetch_semantic_scholar(
            plain, per_source, offset, year=year, fields_of_study=fields_of_study, sort=sort)),
        ("arxiv", lambda: fetch_arxiv(plain, per_source, offset, sort=sort)),
        ("openalex", lambda: fetch_openalex(plain, per_source, openalex_api_key, offset, sort=sort)),
    ]

    results: list[dict[str, Any]] = []
    if len(jobs) == 1:
        results = [jobs[0][1]()]
    else:
        with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
            futures = [(name, pool.submit(fn)) for name, fn in jobs]
            for name, fut in futures:
                try:
                    results.append(fut.result())
                except Exception as exc:  # noqa: BLE001
                    log.warning("recall job %s failed: %s", name, exc)

    # 合并同名源（Europe PMC 两路算一个源，命中数与使用数相加）
    ranked_lists: list[tuple[str, list[dict[str, Any]]]] = []
    sources_meta: dict[str, dict[str, Any]] = {}
    degraded: list[dict[str, str]] = []
    for res in results:
        sid = res["source"]
        papers = res.get("papers") or []
        if papers:
            ranked_lists.append((sid, papers))
        meta = sources_meta.setdefault(sid, {
            "id": sid, "label": res.get("label") or SOURCE_LABELS.get(sid, sid),
            "hits": 0, "used": 0, "ok": True, "note": "",
        })
        meta["hits"] = max(meta["hits"], _as_int(res.get("hits")))
        meta["used"] += len(papers)
        if not res.get("ok", True):
            meta["ok"] = False
            meta["note"] = res.get("note") or "不可用"
            if {"source": sid, "reason": meta["note"]} not in degraded:
                degraded.append({"source": sid, "reason": meta["note"]})
        elif res.get("note") and not meta["note"]:
            meta["note"] = res["note"]

    fused = rrf_fuse(ranked_lists)
    filtered = _post_filter(fused, years, open_access, min_citation)
    ordered = rerank(filtered, plan, sort=sort)

    for p in ordered:
        p.pop("_rrf", None)
        p.pop("_relevanceRaw", None)

    page = ordered[: max(limit, 1)]

    # total 口径务必诚实：取**主源真实 hitCount 的最大值**，不是各源相加、更不是 Crossref 那种假计数
    primary_hits = max([m["hits"] for m in sources_meta.values()] or [0])
    total = primary_hits or len(page)

    return {
        "total": total,
        "offset": offset,
        "papers": page,
        "sources": list(sources_meta.values()),
        "degraded": degraded,
        "query_plan": plan,
        "pipeline": _PIPELINE,
    }
