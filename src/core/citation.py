"""文献引用：BibTeX / CSL JSON 导出，以及按标题+作者补全 DOI。

## 为什么这件事成本很低

调研确认：``literature_meta`` 表**已经有** ``title`` / ``authors`` / ``year`` /
``venue`` / ``doi`` / ``arxiv_id`` / ``abstract`` / ``keywords``。
所以「导出引用」不需要动任何表结构 —— 纯粹是把已有数据换成标准格式输出。

缺的是**来源**：元数据当前只来自 LLM 本地抽取（``extract_paper_metadata``，手动触发），
项目里**没有任何外部抓取**（全库 grep `crossref` / `doi.org` / `arxiv.org` 零命中），
于是 DOI 常常是空的。本模块补上 Crossref 这一环。

## 两条硬约束

1. **绝不编造**：字段缺失就省略。宁可导出一个不完整的条目，也不能让参考文献列表里
   出现一个假 DOI —— 学生拿它去投稿是要出事的。
2. **失败一律降级**：外部请求超时/失败返回 ``None``，不抛异常给上层。
   照 ``core/campus_sources.py`` 的既有约定（超时 + 字节上限 + UA + 只记日志）。
"""

from __future__ import annotations

import difflib
import hashlib
import json
import re
import unicodedata
import urllib.parse
import urllib.request
from typing import Any

# Crossref 单次查询超时。查询是"顺手补全"，不该让用户等。
CROSSREF_TIMEOUT = 6

# 响应字节上限，防止异常响应把内存吃满。
MAX_BYTES = 512 * 1024

# Crossref 建议带上可识别的 User-Agent（polite pool 能拿到更稳的服务）。
# 刻意**不编造邮箱** —— 那是用户的信息，不能用默认值假冒。
USER_AGENT = "KnowOrigin/0.1 (local-first learning workbench)"

# 标题相似度下限。低于它一律拒绝写入 —— Crossref 对模糊查询很宽容，
# 一次错配就会给学生留下一个指向别人论文的 DOI，比没有 DOI 更糟。
TITLE_MATCH_FLOOR = 0.75


# --------------------------------------------------------------------------- #
# 作者字符串 → 结构化
# --------------------------------------------------------------------------- #
def _looks_like_initial(piece: str) -> bool:
    """判断一个片段是不是"名的缩写"（``N.`` / ``M`` / ``明``）。

    ``"Qian, N., Li, M."`` 这种写法里，逗号既分隔作者、又分隔"姓, 名"。
    靠这个函数把切碎的姓名拼回去。
    """
    token = (piece or "").strip().strip(".").strip()
    if not token or len(token) > 3:
        return False
    if token.isupper() and token.isalpha():
        return True
    return len(token) == 1


def split_authors(raw: str) -> list[str]:
    """把 LLM 产出的作者串切成一个个名字。

    抽取任务里 authors 是**一个字符串**（"多人用逗号分隔"），没有结构，
    所以这里必须容忍各种写法：中文用「、」或「，」，英文用「,」或「;」，
    以及 ``"Last, First"`` 里逗号身兼两职的情况。

    **已知边界**：``"Qian, Ning, Li, Ming"`` 这种"姓, 名"交替又全程用逗号的写法
    在语法上就是歧义的（两个作者还是四个？），无法可靠还原。实际不会遇到 ——
    抽取提示词明确要求"多人用逗号分隔"，模型输出的是 ``"Ning Qian, Ming Li"``
    或 ``"Qian N., Li M."``，这两种都能正确切分。
    """
    text = (raw or "").strip()
    if not text:
        return []
    if ";" in text or "、" in text or "；" in text:
        parts = re.split(r"[;；、]", text)
    else:
        parts = re.split(r"[,，]", text)
        # 纯逗号分隔时，"Qian, N., Li, M." 会被切成 ['Qian','N.','Li','M.']，
        # 把缩写碎片并回前一段，恢复成 ['Qian, N.', 'Li, M.']。
        merged: list[str] = []
        for part in parts:
            piece = part.strip()
            if merged and _looks_like_initial(piece):
                merged[-1] = f"{merged[-1]}, {piece}"
            else:
                merged.append(piece)
        parts = merged

    out: list[str] = []
    for part in parts:
        name = part.strip().strip(".").strip()
        if not name:
            continue
        # 过滤掉 "et al" / "等" 这类非人名
        if name.lower() in {"et al", "et al.", "等", "others", "and others"}:
            continue
        out.append(name)
    return out


def _ascii_fold(text: str) -> str:
    """去音标，便于比较。"""
    return "".join(
        char for char in unicodedata.normalize("NFKD", text) if not unicodedata.combining(char)
    )


def _normalize_for_match(text: str) -> str:
    """比较标题用的归一化：去标点、压空白、转小写。"""
    folded = _ascii_fold(text or "").lower()
    cleaned = re.sub(r"[^0-9a-z\u4e00-\u9fff]+", " ", folded)
    return re.sub(r"\s+", " ", cleaned).strip()


def title_similarity(left: str, right: str) -> float:
    """两个标题的相似度（0~1）。"""
    a = _normalize_for_match(left)
    b = _normalize_for_match(right)
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a, b).ratio()


# --------------------------------------------------------------------------- #
# citekey
# --------------------------------------------------------------------------- #
def make_key(meta: dict[str, Any], fallback: str = "ref") -> str:
    """生成 BibTeX 的引用键：``姓氏年份首词``。

    只保留 ASCII 字母数字 —— citekey 常出现在 LaTeX 命令里，中文键名会出事。
    """
    authors = split_authors(str(meta.get("authors") or ""))
    surname = ""
    if authors:
        first = authors[0]
        # "Zhang, San" → Zhang；"San Zhang" → Zhang；"张三" → 取不了 → 空
        if "," in first:
            surname = first.split(",")[0].strip()
        else:
            pieces = first.split()
            surname = pieces[-1] if pieces else ""
    surname = re.sub(r"[^A-Za-z]", "", _ascii_fold(surname))

    year = "".join(ch for ch in str(meta.get("year") or "") if ch.isdigit())[:4]

    title = str(meta.get("title") or "")
    stop = {
        "a", "an", "the", "on", "of", "in", "for", "and", "to", "with",
        "基于", "一种", "关于", "研究", "的",
    }
    word = ""
    for token in re.split(r"[\s:：,，。.\-—]+", _ascii_fold(title)):
        cleaned = re.sub(r"[^A-Za-z]", "", token)
        if len(cleaned) >= 3 and cleaned.lower() not in stop:
            word = cleaned
            break

    key = f"{surname}{year}{word}"
    if not surname and not word:
        # 纯中文作者 + 中文标题时拿不到 ASCII 词，只有年份 —— 同年的文献会挤成
        # 同一个 citekey。补一小段标题哈希保证唯一可读。
        digest = hashlib.sha1(
            (str(meta.get("title") or fallback or "ref")).encode("utf-8")
        ).hexdigest()[:4]
        key = f"{year or 'ref'}{digest}"
    key = re.sub(r"[^A-Za-z0-9]", "", key)
    return key[:60] or "reference"


# --------------------------------------------------------------------------- #
# BibTeX
# --------------------------------------------------------------------------- #
def _bib_escape(value: str) -> str:
    """BibTeX 字段值转义。花括号要配平，否则整个 .bib 解析失败。"""
    text = (value or "").replace("\\", "\\\\")
    for char in "{}":
        text = text.replace(char, "\\" + char)
    return " ".join(text.split())


def entry_type_of(meta: dict[str, Any]) -> str:
    """推断条目类型。判据保守：拿不准就用 @misc，不假装知道。"""
    doi = str(meta.get("doi") or "").strip()
    arxiv = str(meta.get("arxiv_id") or "").strip()
    venue = str(meta.get("venue") or "").strip()
    if venue and doi and not arxiv:
        lowered = venue.lower()
        # 会议录/学报类关键词多的当 inproceedings，其余按期刊
        if any(word in lowered for word in ("conference", "proceedings", "workshop", "symposium")):
            return "inproceedings"
        return "article"
    if venue and not doi:
        return "article"
    return "misc"


def to_bibtex(meta: dict[str, Any], *, fallback_title: str = "") -> str:
    """生成 BibTeX 条目。**缺的字段直接省略，绝不留占位符或编造值。**"""
    title = str(meta.get("title") or fallback_title or "").strip()
    authors = split_authors(str(meta.get("authors") or ""))
    year = str(meta.get("year") or "").strip()
    venue = str(meta.get("venue") or "").strip()
    doi = str(meta.get("doi") or "").strip()
    arxiv = str(meta.get("arxiv_id") or "").strip()

    key = make_key({**meta, "title": title or fallback_title}, fallback=fallback_title or "reference")
    kind = entry_type_of(meta)

    fields: list[tuple[str, str]] = []
    if title:
        fields.append(("title", "{" + _bib_escape(title) + "}"))
    if authors:
        # 外层花括号必须有：少了它，作者名里的空格会让 BibTeX 解析出问题，
        # 而且 "and" 会被当成普通单词而不是作者分隔符。
        fields.append(("author", "{" + " and ".join(_bib_escape(name) for name in authors) + "}"))
    if year:
        fields.append(("year", "{" + _bib_escape(year) + "}"))
    if venue:
        field_name = "booktitle" if kind == "inproceedings" else "journal"
        fields.append((field_name, "{" + _bib_escape(venue) + "}"))
    if doi:
        fields.append(("doi", "{" + _bib_escape(doi) + "}"))
    if arxiv:
        fields.append(("eprint", "{" + _bib_escape(arxiv) + "}"))
        fields.append(("archivePrefix", "{arXiv}"))
    abstract = str(meta.get("abstract") or "").strip()
    if abstract:
        fields.append(("abstract", "{" + _bib_escape(abstract[:1200]) + "}"))

    body = ",\n".join(f"  {name} = {value}" for name, value in fields)
    return f"@{kind}{{{key},\n{body}\n}}\n" if body else f"@{kind}{{{key},\n}}\n"


def to_bibtex_many(entries: list[dict[str, Any]]) -> str:
    """批量导出。多条之间空一行 —— 手贴进 .bib 时最省事。"""
    blocks = [
        to_bibtex(meta, fallback_title=str(meta.get("subject") or "")) for meta in entries
    ]
    return "\n".join(block.rstrip() + "\n" for block in blocks)


# --------------------------------------------------------------------------- #
# CSL JSON（Zotero / Pandoc / Obsidian 都吃这个格式）
# --------------------------------------------------------------------------- #
_CSL_TYPE = {
    "article": "article-journal",
    "inproceedings": "paper-conference",
    "misc": "article",
}


def to_csl_json(meta: dict[str, Any], *, fallback_title: str = "") -> dict[str, Any]:
    """生成 CSL JSON 条目。

    作者一律用 ``{"literal": 名字}`` —— 因为我们拿到的本来就不是结构化的
    given/family（LLM 抽出来的是一个字符串）。硬猜 First/Last 会把中文名拆错，
    而 literal 是 CSL 明确支持的写法，Zotero 导入时不会出错。
    """
    kind = entry_type_of(meta)
    title = str(meta.get("title") or fallback_title or "").strip()
    authors = split_authors(str(meta.get("authors") or ""))
    year = "".join(ch for ch in str(meta.get("year") or "") if ch.isdigit())[:4]

    item: dict[str, Any] = {"type": _CSL_TYPE.get(kind, "article")}
    if title:
        item["title"] = title
    if authors:
        item["author"] = [{"literal": name} for name in authors]
    if year:
        item["issued"] = {"date-parts": [[int(year)]]}
    venue = str(meta.get("venue") or "").strip()
    if venue:
        item["container-title"] = venue
    doi = str(meta.get("doi") or "").strip()
    if doi:
        item["DOI"] = doi
    abstract = str(meta.get("abstract") or "").strip()
    if abstract:
        item["abstract"] = abstract
    keywords = meta.get("keywords") or []
    if isinstance(keywords, list) and keywords:
        item["keyword"] = ", ".join(str(word) for word in keywords[:20])
    item["id"] = make_key({**meta, "title": title}, fallback=title or "reference")
    return item


# --------------------------------------------------------------------------- #
# Crossref：按标题 + 作者补 DOI
# --------------------------------------------------------------------------- #
def _http_json(url: str, *, timeout: int = CROSSREF_TIMEOUT) -> dict[str, Any] | None:
    """GET 一个 JSON。**任何失败都返回 None**，绝不抛给上层。"""
    request = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(MAX_BYTES)
    except Exception:
        # 网络问题、超时、404、限流 —— 对调用方都是同一件事：这次没查到
        return None
    try:
        data = json.loads(raw.decode("utf-8", "replace"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def lookup_doi(
    title: str, authors: str = "", *, timeout: int = CROSSREF_TIMEOUT
) -> dict[str, Any] | None:
    """按标题（可带作者）查 Crossref，返回可回填的字段或 None。

    **返回前会校验标题相似度**：Crossref 对模糊查询很宽容，问"A 论文"它经常回一篇
    标题相近但完全不相干的 B 论文。直接写入等于给学生一个错误的 DOI —— 比空着更糟，
    因为他会拿它去投稿。所以相似度不过线就当作没查到。
    """
    wanted = (title or "").strip()
    if len(wanted) < 6:
        return None

    query = urllib.parse.urlencode(
        {
            "query.bibliographic": wanted,
            "rows": "3",
            "select": "DOI,title,author,container-title,issued,type",
        }
    )
    author_hint = (authors or "").strip()
    if author_hint:
        query += "&query.author=" + urllib.parse.quote(author_hint.split(",")[0].strip())

    data = _http_json(f"https://api.crossref.org/works?{query}", timeout=timeout)
    if not data:
        return None

    items = (data.get("message") or {}).get("items")
    if not isinstance(items, list):
        return None

    for item in items:
        if not isinstance(item, dict):
            continue
        candidates = item.get("title") or []
        candidate_title = ""
        if isinstance(candidates, list) and candidates:
            candidate_title = str(candidates[0])
        elif isinstance(candidates, str):
            candidate_title = candidates
        if not candidate_title:
            continue
        score = title_similarity(wanted, candidate_title)
        if score < TITLE_MATCH_FLOOR:
            continue
        return _crossref_to_meta(item, score)
    return None


def _crossref_to_meta(item: dict[str, Any], score: float) -> dict[str, Any]:
    """Crossref item → 我们 ``literature_meta`` 能收的字段。"""
    titles = item.get("title") or []
    title = str(titles[0]) if isinstance(titles, list) and titles else ""

    authors: list[str] = []
    for person in item.get("author") or []:
        if not isinstance(person, dict):
            continue
        family = str(person.get("family") or "").strip()
        given = str(person.get("given") or "").strip()
        if family and given:
            authors.append(f"{family}, {given}")
        elif family:
            authors.append(family)
        elif person.get("name"):
            authors.append(str(person["name"]))

    venue = ""
    containers = item.get("container-title") or []
    if isinstance(containers, list) and containers:
        venue = str(containers[0])
    elif isinstance(containers, str):
        venue = containers

    year = ""
    issued = item.get("issued") or {}
    parts = issued.get("date-parts") if isinstance(issued, dict) else None
    if isinstance(parts, list) and parts and isinstance(parts[0], list) and parts[0]:
        year = str(parts[0][0])

    return {
        "title": title,
        "authors": ", ".join(authors),
        "year": year,
        "venue": venue,
        "doi": str(item.get("DOI") or "").strip(),
        "match_score": round(score, 3),
    }


def merge_missing(meta: dict[str, Any], extra: dict[str, Any]) -> dict[str, str]:
    """把 ``extra`` 里**当前 meta 为空**的字段挑出来，返回需要回填的补丁。

    刻意只补空、不覆盖：LLM 从正文里抽出来的 title/venue 通常比 Crossref 的
    元数据更贴合这份文件（比如工作论文 vs 正式期刊版），不该被外部数据盖掉。
    """
    patch: dict[str, str] = {}
    for key in ("title", "authors", "year", "venue", "doi"):
        current = str(meta.get(key) or "").strip()
        incoming = str(extra.get(key) or "").strip()
        if not current and incoming:
            patch[key] = incoming
    return patch
