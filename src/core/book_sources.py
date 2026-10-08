"""多书源获取：把「书从哪来」和「书怎么读」解耦。

## 为什么不能只接微信读书

微信读书官方接口（`/shelf/sync`、`/book/info`、`/book/bookmarklist`）能给的是
**书架、封面、进度、用户自己的划线与想法**，但**给不了整本书的正文** ——
正文要留在它的 App 里读，这是它的商业边界，不是接口缺陷。

而「读书功能」真正要的东西有两类，必须分开满足：

* **元数据 + 个人笔记**（书名 / 作者 / 封面 / 分类 / 划线）→ 微信读书最强，用它；
* **整本书的正文**（要能全文检索、能侧边问 AI、能划词高亮）→ 微信读书给不了，
  必须另找**合法且可全文获取**的源。

所以这里做的是一个**书源注册表**：每个源显式标注它到底能给什么
（``fulltext`` 全文 / ``metadata`` 元数据 / ``link`` 仅外链），
搜索时并发打多个源、归一化成同一种记录，让上层不必关心书是从哪来的。

## 版权边界（硬约束，写死在类型里）

每条记录都带 ``rights`` 字段，取值只有四种：

* ``public-domain`` —— 公版书，可全文下载（古腾堡 / 维基文库 / ctext / Standard Ebooks）；
* ``licensed`` —— 有版权的商业书，**只允许元数据与外链**，不落正文；
* ``user-provided`` —— 用户自己导入的本地文件，正文只存本机；
* ``unknown`` —— 状态不明（Open Library / Google Books 混装），一律按 ``licensed`` 处理。

``has_fulltext`` 为真时，``rights`` 必须是 ``public-domain`` 或 ``user-provided`` ——
这条由 ``_norm`` 强制，杜绝「不小心把有版权的书当公版书下全文」。
"""

from __future__ import annotations

import html
import os
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Iterable

from core.reading_digest import guess_category

# --------------------------------------------------------------------------
# 能力与版权：这两个枚举是整个模块的地基，不要随意扩
# --------------------------------------------------------------------------

KIND_FULLTEXT = "fulltext"      # 能给整本正文
KIND_METADATA = "metadata"      # 只给书目元数据（书名/作者/封面/年份）
KIND_LINK = "link"              # 只给一个可跳转的入口，连元数据都要去那边看

RIGHTS_PUBLIC_DOMAIN = "public-domain"
RIGHTS_LICENSED = "licensed"
RIGHTS_USER_PROVIDED = "user-provided"
RIGHTS_UNKNOWN = "unknown"

# 允许携带全文的版权状态。has_fulltext=True 而 rights 不在此列 → 强制降级为无全文。
_FULLTEXT_RIGHTS = frozenset({RIGHTS_PUBLIC_DOMAIN, RIGHTS_USER_PROVIDED})

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)

_FETCH_TIMEOUT = 12.0
# 整本下载要单独放宽：Standard Ebooks 的单页全文 850KB，实测 10~22 秒。
# 用搜索那档 12 秒去抓正文，会把**唯一可达的全文源**判成超时。
_FULLTEXT_TIMEOUT = 60.0
# 需要代理却还没配代理的源：给一个更短的预算。它们在国内必然连不上，
# 让它们按 12 秒慢慢等，会把整轮搜索的体感拖成「卡住了」。
_BLOCKED_SOURCE_TIMEOUT = 8.0
# 按源覆盖超时。默认档（12 秒）是给 JSON 接口的；HTML 页面慢得多。
_SOURCE_TIMEOUTS: dict[str, float] = {
    "standardebooks": 45.0,   # 搜索页 18KB HTML，实测 10~22 秒，必须放宽
    "googlebooks": 15.0,      # 实测能卡到 192 秒（连接重试），必须设上限
}
_SEARCH_WORKERS = 6

# 一条记录最多保留几个文件入口。真实的公版书常常同时给 EPUB / AZW3 / 纯文本 /
# 在线阅读，全留着才有用；但也没必要无限留（古腾堡一本书最多能给十几种格式）。
_MAX_FILES = 6


# --------------------------------------------------------------------------
# 代理：海外书源在国内网络直连必挂，配上代理它们才活
# --------------------------------------------------------------------------

# ⚠️ 2026-10-07 实测（本机直连）：古腾堡 / Open Library / Internet Archive /
# HathiTrust / Google Books / 维基文库**全部超时**（googlebooks 甚至卡满 192 秒），
# 只有 Standard Ebooks、豆瓣、ctext 可达。也就是说「公版全文」这条线在国内网络
# 上不是代码问题，是**线路问题** —— 所以这里必须支持代理，否则再怎么加源都是死路。
#
# 与 `core/llm.py` 共用同一个环境变量（TJU_PROXY_URL），不新增配置项：
# 用户配一次代理，模型与书源一起活。
_PROXY_ENV_NAMES = ("TJU_PROXY_URL", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy")


def proxy_url() -> str:
    """当前生效的代理地址；空字符串表示直连。每次读环境变量，便于运行期改。"""
    for name in _PROXY_ENV_NAMES:
        value = str(os.getenv(name) or "").strip()
        if value:
            return value
    return ""


def using_proxy() -> bool:
    return bool(proxy_url())



# --------------------------------------------------------------------------
# 书源注册表
# --------------------------------------------------------------------------

SOURCES: list[dict[str, Any]] = [
    {
        "id": "weread",
        "name": "微信读书",
        "kind": KIND_METADATA,
        "rights": RIGHTS_LICENSED,
        "language": "中文为主",
        "needs_key": True,
        "needs_proxy": False,
        "searchable": False,   # 走 /shelf/sync 同步书架，不是通用搜索
        "home": "https://weread.qq.com",
        "note": "书架、封面、阅读进度、用户自己的划线与想法。**不含整本正文**。",
    },
    {
        "id": "standardebooks",
        "name": "Standard Ebooks",
        "kind": KIND_FULLTEXT,
        "rights": RIGHTS_PUBLIC_DOMAIN,
        "language": "英文",
        "needs_key": False,
        "needs_proxy": False,   # ⚠️ 国内网络实测**直连可达**，是唯一稳定能拿英文公版全文的源
        "searchable": True,
        "home": "https://standardebooks.org",
        "note": "人工精校公版书：EPUB / AZW3 / KEPUB 下载 + 单页全文。"
                "**国内实测可达**，所以它是英文公版全文的主力，不是备选。",
    },
    {
        "id": "gutenberg",
        "name": "古腾堡计划",
        "kind": KIND_FULLTEXT,
        "rights": RIGHTS_PUBLIC_DOMAIN,
        "language": "英文为主",
        "needs_key": False,
        "needs_proxy": True,    # 国内直连超时，需代理
        "searchable": True,
        "home": "https://www.gutenberg.org",
        "note": "7 万余本英文公版书，Gutendex JSON 接口一次给全格式直链。**国内需代理**。",
    },
    {
        "id": "archive",
        "name": "Internet Archive",
        "kind": KIND_FULLTEXT,
        "rights": RIGHTS_PUBLIC_DOMAIN,
        "language": "多语言",
        "needs_key": False,
        "needs_proxy": True,
        "searchable": True,
        "home": "https://archive.org",
        "note": "公版扫描本可直取 **OCR 全文**（`<id>_djvu.txt`）；"
                "声明了公版许可的条目才给全文，其余只给在线阅读 / 借阅链接。**国内需代理**。",
    },
    {
        "id": "wikisource",
        "name": "维基文库",
        "kind": KIND_FULLTEXT,
        "rights": RIGHTS_PUBLIC_DOMAIN,
        "language": "中文古籍与公版文献",
        "needs_key": False,
        "needs_proxy": True,
        "searchable": True,
        "home": "https://zh.wikisource.org",
        "note": "中文公版典籍与文献全文，MediaWiki 接口取正文。**国内需代理**。",
    },
    {
        "id": "ctext",
        "name": "中国哲学书电子化计划",
        "kind": KIND_FULLTEXT,
        "rights": RIGHTS_PUBLIC_DOMAIN,
        "language": "先秦至清代中文典籍",
        "needs_key": True,
        "needs_proxy": False,
        "searchable": True,
        "home": "https://ctext.org",
        "note": "哲学与文史典籍全文；但**页面有人机校验（Cloudflare）、API 需注册 IP**，"
                "所以实测只能登记条目、拿不到正文。",
    },
    {
        "id": "openlibrary",
        "name": "Open Library",
        "kind": KIND_METADATA,
        "rights": RIGHTS_UNKNOWN,
        "language": "多语言",
        "needs_key": False,
        "needs_proxy": True,
        "searchable": True,
        "home": "https://openlibrary.org",
        "note": "全球书目元数据 + 封面；`ebook_access=public` 的条目可直取 Internet Archive "
                "全文，`borrowable` 给借阅链接，其余只给元数据。**国内需代理**。",
    },
    {
        "id": "googlebooks",
        "name": "Google Books",
        "kind": KIND_METADATA,
        "rights": RIGHTS_UNKNOWN,
        "language": "多语言",
        "needs_key": False,
        "needs_proxy": True,
        "searchable": True,
        "home": "https://books.google.com",
        "note": "元数据与简介，部分书有试读；中文书覆盖较好。**国内需代理**。",
    },
    {
        "id": "hathitrust",
        "name": "HathiTrust",
        "kind": KIND_METADATA,
        "rights": RIGHTS_UNKNOWN,
        "language": "英文为主",
        "needs_key": False,
        "needs_proxy": True,
        "searchable": False,   # 只支持按标识符反查，不做关键词搜索
        "home": "https://catalog.hathitrust.org",
        "note": "按 ISBN 反查馆藏：公版 Full View 可读，版权书只给书目与检索入口。"
                "**它是「找文件链接」的主力**（覆盖面比 Open Library 的电子书判定更广）。**国内需代理**。",
    },
    {
        "id": "douban",
        "name": "豆瓣读书",
        "kind": KIND_METADATA,
        "rights": RIGHTS_UNKNOWN,
        "language": "中文",
        "needs_key": False,
        "needs_proxy": False,
        "searchable": True,
        "home": "https://book.douban.com",
        "note": "中文书目最全：书名/作者/封面/年份 + 条目页的**简介与评分**。"
                "只取书目信息与简介，**不抓正文**。国内直连可达。",
    },
    {
        "id": "local",
        "name": "本地导入",
        "kind": KIND_FULLTEXT,
        "rights": RIGHTS_USER_PROVIDED,
        "language": "任意",
        "needs_key": False,
        "needs_proxy": False,
        "searchable": False,
        "home": "",
        "note": "用户自备 EPUB / PDF / TXT / MOBI，正文只存本机，走现有解析器。"
                "**有版权的书，这是唯一合规的全文路径。**",
    },
]

_SOURCE_BY_ID = {s["id"]: s for s in SOURCES}

KIND_LABELS = {
    KIND_FULLTEXT: "可获取全文",
    KIND_METADATA: "仅书目元数据",
    KIND_LINK: "仅外链入口",
}


def normalize_source_id(value: Any) -> str:
    text = str(value or "").strip().lower()
    return text if text in _SOURCE_BY_ID else ""


def list_sources() -> list[dict[str, Any]]:
    """给前端的能力清单：每个源能干什么、要不要 key、版权状态、要不要代理。"""
    out: list[dict[str, Any]] = []
    proxied = using_proxy()
    for src in SOURCES:
        item = dict(src)
        item["kind_label"] = KIND_LABELS.get(src["kind"], src["kind"])
        item["has_fulltext"] = src["kind"] == KIND_FULLTEXT
        item["needs_proxy"] = bool(src.get("needs_proxy"))
        # 需要代理但没配 → 前端把话说清楚，别让「线路不通」看起来像「功能没做」。
        item["blocked"] = bool(item["needs_proxy"] and not proxied)
        out.append(item)
    return out


# --------------------------------------------------------------------------
# 归一化：所有源 → 同一种记录
# --------------------------------------------------------------------------


def _clip(value: Any, limit: int) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if len(text) <= limit:
        return text
    return f"{text[: max(1, limit - 1)].rstrip()}…"


def _strip_tags(raw: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", str(raw or ""))).strip()


def _as_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if isinstance(value, (list, tuple)):
        return [str(v).strip() for v in value if str(v or "").strip()]
    return [str(value).strip()]


def _norm_files(entries: Iterable[Any]) -> list[dict[str, str]]:
    """归一化「文件链接」。

    一本书常常同时有 EPUB / AZW3 / 纯文本 / 在线阅读好几个入口，只留一个
    ``download_url`` 会把其余入口白扔掉 —— 而用户要的恰恰是「文件链接」。
    所以额外保留全部入口（去重、限量），前端可以展开成一组下载/阅读按钮。
    """
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in entries or []:
        if isinstance(item, dict):
            url = str(item.get("url") or "").strip()
            fmt = _clip(item.get("format"), 16)
            label = _clip(item.get("label"), 40)
        elif isinstance(item, str):
            url, fmt, label = item.strip(), "", ""
        else:
            continue
        if not url or url in seen:
            continue
        seen.add(url)
        out.append({"format": fmt, "url": url, "label": label or (fmt.upper() if fmt else "文件")})
        if len(out) >= _MAX_FILES:
            break
    return out


def _norm(
    *,
    source: str,
    source_id: str,
    title: str,
    author: str = "",
    cover: str = "",
    language: str = "",
    year: Any = "",
    subjects: Iterable[Any] = (),
    detail_url: str = "",
    download_url: str = "",
    fulltext_format: str = "",
    rights: str = RIGHTS_UNKNOWN,
    files: Iterable[Any] = (),
    read_url: str = "",
    borrow_url: str = "",
    isbn: str = "",
) -> dict[str, Any] | None:
    """归一化一条记录。标题为空直接丢弃 —— 没有标题的记录在书单里毫无用处。

    ``files`` 是**可选的多入口**（EPUB / TXT / 在线阅读…）。只给 ``files``
    而不给 ``download_url`` 时，取第一个可下载项当主入口，老调用方不受影响。
    """
    clean_title = _clip(title, 200)
    if not clean_title:
        return None

    src = _SOURCE_BY_ID.get(source, {})
    topics = [_clip(s, 40) for s in _as_list(subjects)][:8]

    file_links = _norm_files(files)
    if not download_url and file_links:
        download_url = file_links[0]["url"]
        fulltext_format = fulltext_format or file_links[0]["format"]

    # 版权红线：只有公版与用户自备文件才允许带全文入口。
    has_fulltext = bool(download_url) and rights in _FULLTEXT_RIGHTS

    return {
        "source": source,
        "source_name": src.get("name", source),
        "source_id": _clip(source_id, 80),
        "title": clean_title,
        "author": _clip(author, 120),
        "cover": str(cover or "").strip(),
        "language": _clip(language, 24),
        "year": str(year or "").strip(),
        "topics": topics,
        "category": guess_category(title=clean_title, topics=topics),
        # ISBN 是「找文件链接」的钥匙：HathiTrust / Open Library 都只认标识符反查，
        # 没有它就只能靠书名模糊匹配。所以能拿到就留着。
        "isbn": _clip(isbn, 60),
        "detail_url": str(detail_url or "").strip(),
        "download_url": str(download_url or "").strip(),
        "has_fulltext": has_fulltext,
        "fulltext_format": _clip(fulltext_format, 16) if has_fulltext else "",
        # —— 下面三个是「文件链接」能力的载体（前端据此渲染下载/阅读/借阅按钮）——
        "files": file_links,
        "read_url": str(read_url or "").strip(),
        "borrow_url": str(borrow_url or "").strip(),
        "rights": rights,
        "kind": src.get("kind", KIND_METADATA),
    }


# --------------------------------------------------------------------------
# HTTP：默认实现用 httpx，但整层可注入 —— 测试与门禁不该依赖外网
# --------------------------------------------------------------------------

Fetcher = Callable[..., Any]


class FetchError(RuntimeError):
    """抓取失败。**必须抛出来，不能悄悄返回 None** ——

    早先这里失败时 return None，结果是：``_safe_fetch`` 什么都没捕获，
    `search_books` 的记录型 fetch 也就记不到错，于是「书源连不上」被记成
    「ok，0 结果」，界面上把网络故障显示成「没有找到这本书」。
    抛出来之后，``_safe_fetch`` 照常兜住（单源挂掉不炸整轮），
    但错误会先被记一笔，状态就准了。
    """


def _httpx_get(
    url: str,
    params: dict[str, Any] | None,
    *,
    want_json: bool | str,
    proxy: str | None = None,
    timeout: float | None = None,
) -> Any:
    try:
        import httpx  # noqa: PLC0415
    except Exception as exc:
        raise FetchError("环境里没有 httpx，无法访问网络") from exc
    # 代理按需带上：海外书源（古腾堡 / IA / HathiTrust…）在国内必须走代理，
    # 而豆瓣这类国内站走代理反而更慢，所以显式传 None 时就是直连。
    resolved_proxy = proxy_url() if proxy is None else proxy
    client_kwargs: dict[str, Any] = {
        "timeout": _FETCH_TIMEOUT if timeout is None else timeout,
        "headers": {"User-Agent": _UA},
        "follow_redirects": True,
    }
    if resolved_proxy:
        client_kwargs["proxy"] = resolved_proxy
    try:
        with httpx.Client(**client_kwargs) as client:
            resp = client.get(url, params=params or {})
    except Exception as exc:
        hint = "（可配置代理后重试）" if not resolved_proxy else ""
        raise FetchError(f"{type(exc).__name__}: {exc}{hint}") from exc
    if resp.status_code != 200:
        raise FetchError(f"HTTP {resp.status_code}")

    if want_json == "auto":
        # ⚠️ 书源里 JSON 接口和 HTML 页面混着：古腾堡/豆瓣/OpenLibrary 是 JSON，
        # Standard Ebooks 的搜索页是 HTML。**只按内容判断**，不靠调用方声明 ——
        # 早先这里用「一定解析 JSON」的抓取器去抓 SE 搜索页，报的是
        # 「返回的不是合法 JSON」，而真相是「这个源根本不是 JSON 接口」。
        ctype = str(resp.headers.get("content-type") or "").lower()
        head = resp.text.lstrip()[:1]
        if "json" in ctype or head in ("{", "["):
            try:
                return resp.json()
            except Exception:
                return resp.text
        return resp.text

    if not want_json:
        return resp.text
    try:
        return resp.json()
    except Exception as exc:
        raise FetchError("返回的不是合法 JSON") from exc


def _http_any(
    url: str,
    *,
    params: dict[str, Any] | None = None,
    proxy: str | None = None,
    timeout: float | None = None,
) -> Any | None:
    """默认抓取器：按响应内容自动决定返回 JSON 还是文本。搜索层用它。"""
    return _httpx_get(url, params, want_json="auto", proxy=proxy, timeout=timeout)


def _http_json(
    url: str,
    *,
    params: dict[str, Any] | None = None,
    proxy: str | None = None,
    timeout: float | None = None,
) -> Any | None:
    """默认 JSON 抓取。httpx 在函数内 import —— 模块本身不依赖它，
    这样纯函数测试和门禁在没装 httpx 的环境里也能跑。"""
    return _httpx_get(url, params, want_json=True, proxy=proxy, timeout=timeout)


def _http_text(
    url: str,
    *,
    params: dict[str, Any] | None = None,
    proxy: str | None = None,
    timeout: float | None = None,
) -> str | None:
    return _httpx_get(url, params, want_json=False, proxy=proxy, timeout=timeout)


def _http_text_long(url: str, *, params: dict[str, Any] | None = None) -> str | None:
    """整本正文专用的抓取器：超时放宽到 60 秒。

    单独做一个而不是给 ``_http_text`` 加参数，是因为 ``fetch_text`` 是**可注入**的
    （测试与门禁一律注入假实现）；注入的假实现只认 ``(url, params)``，
    多传一个 ``timeout`` 会把它们全部打挂。
    """
    return _httpx_get(url, params, want_json=False, timeout=_FULLTEXT_TIMEOUT)


# --------------------------------------------------------------------------
# HTML → 文本：给「取正文」用
# --------------------------------------------------------------------------

# 这些标签里的内容不是正文，抽文本时要整块丢掉（否则目录/导航会混进正文）。
_DROP_BLOCK_RE = re.compile(
    r"<(script|style|nav|header|footer|form|svg)\b[^>]*>.*?</\1>", re.S | re.I
)
_BLOCK_END_RE = re.compile(r"</(p|div|section|article|li|h[1-6]|blockquote|tr)>", re.I)
_BR_RE = re.compile(r"<br\s*/?>", re.I)
_TAG_RE = re.compile(r"<[^>]+>")


def html_to_text(raw: str) -> str:
    """把 HTML 正文抽成纯文本。

    **这不是通用 HTML 解析器**，只服务「公版书正文」这一种输入：丢掉脚本/导航类块，
    把块级标签与 <br> 变成换行，其余标签剥掉，最后收敛空行。

    为什么必须有它：古腾堡的降级格式就是 HTML，若不转文本，整篇 `<p>` 标签会直接
    喂给模型，收获质量会被标签噪音毁掉（而这是静默发生的，很难查）。
    """
    text = str(raw or "")
    if not text:
        return ""
    text = _DROP_BLOCK_RE.sub("\n", text)
    text = _BR_RE.sub("\n", text)
    text = _BLOCK_END_RE.sub("\n", text)
    text = _TAG_RE.sub("", text)
    text = html.unescape(text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t\u00a0]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# 古腾堡每本书都套了一段许可证页眉页脚，**必须去掉**：它长达数百词且与书的内容
# 无关，留着会污染分章（第一「章」变成许可证）与收获。
_GUTENBERG_START_RE = re.compile(r"\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG.*?\*\*\*", re.I)
_GUTENBERG_END_RE = re.compile(r"\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG.*?\*\*\*", re.I)


def strip_gutenberg_boilerplate(text: str) -> str:
    """去掉古腾堡的许可证页眉页脚。纯函数，找不到标记就原样返回。"""
    body = str(text or "")
    start = _GUTENBERG_START_RE.search(body)
    if start:
        body = body[start.end():]
    end = _GUTENBERG_END_RE.search(body)
    if end:
        body = body[: end.start()]
    return body.strip()


# --------------------------------------------------------------------------
# Standard Ebooks：国内实测**直连可达**的英文公版全文源
#
# 它的单页全文（`/text/single-page`）是结构化的：正文按
# `<section epub:type="bodymatter chapter">` 分块，每块自带 `<h2>` 章标题。
# 这比用正则猜章节可靠得多 —— 所以标准电子书的书能做到「真·逐章精读」。
# --------------------------------------------------------------------------

_SE_BOOK_LINK_RE = re.compile(r'href="(/ebooks/([a-z0-9\-]+)/([a-z0-9\-]+))"', re.I)
_SE_COVER_RE = re.compile(r'src="(/images/covers/[^"]+cover@2x\.jpg)"', re.I)
_SE_SECTION_RE = re.compile(r"<section\b([^>]*)>(.*?)</section>", re.S | re.I)
_SE_EPUBTYPE_RE = re.compile(r'epub:type="([^"]*)"', re.I)
_SE_HEAD_RE = re.compile(r"<h[1-3]\b[^>]*>(.*?)</h[1-3]>", re.S | re.I)


def _slug_to_words(slug: str) -> str:
    """`pride-and-prejudice` → `Pride and Prejudice`。SE 的 slug 就是标题的小写连字符形式。"""
    parts = [p for p in str(slug or "").split("-") if p]
    small = {"and", "of", "the", "a", "an", "in", "on", "to", "for", "with"}
    words: list[str] = []
    for index, part in enumerate(parts):
        if index and part.lower() in small:
            words.append(part.lower())
        else:
            words.append(part[:1].upper() + part[1:])
    return " ".join(words)


def se_download_files(author_slug: str, book_slug: str) -> list[dict[str, str]]:
    """Standard Ebooks 的下载入口是**由 slug 确定**的，无需再抓一次书页。

    文件名规律：`<author>_<book>.epub`（实测于 pride-and-prejudice）。
    """
    base = f"https://standardebooks.org/ebooks/{author_slug}/{book_slug}"
    stem = f"{author_slug}_{book_slug}"
    return [
        {"format": "text", "url": f"{base}/text/single-page", "label": "在线阅读（全文）"},
        {"format": "epub", "url": f"{base}/downloads/{stem}.epub", "label": "下载 EPUB"},
        {"format": "azw3", "url": f"{base}/downloads/{stem}.azw3", "label": "下载 AZW3（Kindle）"},
        {"format": "kepub", "url": f"{base}/downloads/{stem}.kepub.epub", "label": "下载 KEPUB"},
    ]


def _search_standardebooks(query: str, limit: int, fetch: Fetcher) -> list[dict[str, Any]]:
    """Standard Ebooks 搜索。

    ⚠️ 它的搜索页会把「最近上架」等无关条目也放进结果列表（实测搜 austen 时
    第一条是 ring-lardner/short-fiction），所以这里**按 slug 复核关键词**，
    只保留真正命中的书 —— 否则界面上会出现「搜 A 却出来 B」的假结果。
    """
    raw = _safe_fetch(fetch, "https://standardebooks.org/ebooks", params={"query": query})
    if not isinstance(raw, str) or not raw:
        return []

    # 先按 <li> 切成「条目块」，这样封面能和它所属的书对上（同一个 <li> 内）。
    blocks = re.split(r"<li\b", raw, flags=re.I)[1:]
    needles = [w for w in re.split(r"[\s,，、]+", str(query or "").lower()) if len(w) >= 2]

    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for block in blocks:
        match = _SE_BOOK_LINK_RE.search(block)
        if not match:
            continue
        path, author_slug, book_slug = match.group(1), match.group(2), match.group(3)
        if path in seen:
            continue
        haystack = f"{author_slug} {book_slug}".lower()
        if needles and not any(needle in haystack for needle in needles):
            continue
        seen.add(path)

        cover_match = _SE_COVER_RE.search(block)
        record = _norm(
            source="standardebooks",
            source_id=f"{author_slug}/{book_slug}",
            title=_slug_to_words(book_slug),
            author=_slug_to_words(author_slug),
            cover=f"https://standardebooks.org{cover_match.group(1)}" if cover_match else "",
            language="en",
            detail_url=f"https://standardebooks.org{path}",
            # download_url 指向**可机器抓取的全文页**；EPUB/AZW3 放进 files 供人下载。
            download_url=f"https://standardebooks.org{path}/text/single-page",
            fulltext_format="text",
            files=se_download_files(author_slug, book_slug),
            read_url=f"https://standardebooks.org{path}/text/single-page",
            rights=RIGHTS_PUBLIC_DOMAIN,
        )
        if record:
            out.append(record)
        if len(out) >= limit:
            break
    return out


def parse_standardebooks_chapters(
    raw: str, *, max_chapters: int = 40, max_chapter_chars: int = 6000
) -> list[dict[str, str]]:
    """把 Standard Ebooks 的单页全文切成章节。

    只认 `epub:type` 里带 `bodymatter`（或 `chapter`）的 section —— 封面、版权页、
    目录都是 frontmatter/backmatter，混进「逐章精读」会冒出一排空章。
    """
    text = str(raw or "")
    if not text:
        return []
    out: list[dict[str, str]] = []
    for attrs, body in _SE_SECTION_RE.findall(text):
        type_match = _SE_EPUBTYPE_RE.search(attrs or "")
        epub_type = (type_match.group(1) if type_match else "").lower()
        if "bodymatter" not in epub_type and "chapter" not in epub_type:
            continue
        head_match = _SE_HEAD_RE.search(body)
        title = html_to_text(head_match.group(1)) if head_match else ""
        # 有 <h2> 就把它从正文里摘掉，避免正文开头重复一遍标题
        inner = _SE_HEAD_RE.sub("\n", body, count=1)
        chapter_body = html_to_text(inner)
        if len(chapter_body) < 40:
            continue
        out.append({"title": title or f"第 {len(out) + 1} 节", "excerpt": chapter_body[:max_chapter_chars]})
        if len(out) >= max_chapters:
            break
    return out


# --------------------------------------------------------------------------
# Internet Archive：公版扫描本的 OCR 全文（`<id>_djvu.txt`）
#
# 版权判定靠条目自己声明的许可：只有 `licenseurl` 写明 public domain 的才给全文，
# 其余（含可借阅的版权书）只给在线阅读 / 借阅链接 —— 版权红线在记录层强制。
# --------------------------------------------------------------------------

_ARCHIVE_PD_HINTS = ("publicdomain", "public-domain", "public_domain", "creativecommons.org/publicdomain")


def _archive_is_public_domain(doc: dict[str, Any]) -> bool:
    license_url = str(doc.get("licenseurl") or "").lower()
    rights = str(doc.get("rights") or "").lower()
    if any(hint in license_url for hint in _ARCHIVE_PD_HINTS):
        return True
    return "public domain" in rights or "公版" in rights


def _search_archive(query: str, limit: int, fetch: Fetcher) -> list[dict[str, Any]]:
    data = _safe_fetch(
        fetch,
        "https://archive.org/advancedsearch.php",
        params={
            "q": f"title:({query}) AND mediatype:texts",
            "fl[]": ["identifier", "title", "creator", "year", "licenseurl", "rights", "collection"],
            "rows": max(1, min(limit, 40)),
            "page": 1,
            "output": "json",
        },
    )
    if not isinstance(data, dict):
        return []
    docs = ((data.get("response") or {}).get("docs")) or []
    out: list[dict[str, Any]] = []
    for doc in docs[:limit]:
        if not isinstance(doc, dict):
            continue
        identifier = str(doc.get("identifier") or "").strip()
        if not identifier:
            continue
        creator = doc.get("creator")
        author = "、".join(_as_list(creator)[:3])
        detail = f"https://archive.org/details/{identifier}"
        public = _archive_is_public_domain(doc)
        text_url = f"https://archive.org/download/{identifier}/{identifier}_djvu.txt"
        files = [{"format": "txt", "url": text_url, "label": "OCR 全文（TXT）"},
                 {"format": "details", "url": detail, "label": "在线阅读"}]
        record = _norm(
            source="archive",
            source_id=identifier,
            title=doc.get("title", ""),
            author=author,
            year=doc.get("year", ""),
            language="",
            subjects=[str(c) for c in _as_list(doc.get("collection"))[:6]],
            detail_url=detail,
            # 只有公版条目才把正文入口交出去；版权条目到此为止（下面 rights 会给 licensed/unknown）。
            download_url=text_url if public else "",
            fulltext_format="txt" if public else "",
            files=files,
            read_url=detail,
            borrow_url="" if public else detail,
            rights=RIGHTS_PUBLIC_DOMAIN if public else RIGHTS_UNKNOWN,
        )
        if record:
            out.append(record)
    return out


# --------------------------------------------------------------------------
# 各源搜索器：签名统一为 (query, limit, fetch) -> list[record]
# --------------------------------------------------------------------------


def _safe_fetch(fetch: Fetcher, url: str, *, params: dict[str, Any] | None = None) -> Any | None:
    """抓取失败一律返回 None。

    防线**下沉到每个源**，而不是只靠 ``search_books`` 外层兜 —— 否则一旦有人
    直接调某个源的搜索器（例如将来做「只搜古腾堡」的入口），一个超时就会把
    调用方整个炸掉。外层那层保留，作为最后一道保险。
    """
    try:
        return fetch(url, params=params)
    except Exception:
        return None


def _gutenberg_files(formats: dict[str, Any]) -> list[dict[str, str]]:
    """古腾堡一本书常给 4~6 种格式，全列出来才算「文件链接」。

    顺序即优先级：EPUB（好读好解析）→ 纯文本 → HTML → MOBI。
    """
    wanted = (
        ("application/epub+zip", "epub", "下载 EPUB"),
        ("text/plain; charset=utf-8", "txt", "下载纯文本"),
        ("text/plain", "txt", "下载纯文本"),
        ("text/html; charset=utf-8", "html", "在线阅读 HTML"),
        ("text/html", "html", "在线阅读 HTML"),
        ("application/x-mobipocket-ebook", "mobi", "下载 MOBI（Kindle）"),
    )
    files: list[dict[str, str]] = []
    seen: set[str] = set()
    for key, fmt, label in wanted:
        url = str(formats.get(key) or "").strip()
        if not url or url in seen:
            continue
        seen.add(url)
        files.append({"format": fmt, "url": url, "label": label})
    return files


def _search_gutenberg(query: str, limit: int, fetch: Fetcher) -> list[dict[str, Any]]:
    data = _safe_fetch(fetch, "https://gutendex.com/books", params={"search": query})
    if not isinstance(data, dict):
        return []
    out: list[dict[str, Any]] = []
    for item in (data.get("results") or [])[:limit]:
        if not isinstance(item, dict):
            continue
        formats = item.get("formats") or {}
        files = _gutenberg_files(formats)
        # 优先级：EPUB 好读好解析 → 纯文本 → HTML。古腾堡同一本书会给多种格式。
        download = ""
        fmt = ""
        for entry in files:
            if entry["format"] in ("epub", "txt", "html"):
                download, fmt = entry["url"], entry["format"]
                break
        authors = item.get("authors") or []
        author = "、".join(str(a.get("name", "")).strip() for a in authors if isinstance(a, dict))
        record = _norm(
            source="gutenberg",
            source_id=str(item.get("id", "")),
            title=item.get("title", ""),
            author=author,
            cover=(formats.get("image/jpeg") or ""),
            language="、".join(_as_list(item.get("languages"))),
            subjects=list(item.get("subjects") or []) + list(item.get("bookshelves") or []),
            detail_url=f"https://www.gutenberg.org/ebooks/{item.get('id', '')}",
            download_url=download,
            fulltext_format=fmt,
            files=files,
            rights=RIGHTS_PUBLIC_DOMAIN,
        )
        if record:
            out.append(record)
    return out


def _first_ia_id(value: Any) -> str:
    """Open Library 的 `ia` 字段有时是字符串、有时是列表，统一取第一个。"""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (list, tuple)):
        for item in value:
            text = str(item or "").strip()
            if text:
                return text
    return ""


def _search_openlibrary(query: str, limit: int, fetch: Fetcher) -> list[dict[str, Any]]:
    """Open Library 搜索。

    ⚠️ 关键在于多要了三个字段：`ebook_access`（public / borrowable / printdisabled /
    no_ebook）、`ia`（Internet Archive 的条目 id）、`public_scan_b`。有了它们，
    这条记录就不再只是「元数据」：
      * public  → 可直接取 Internet Archive 的 OCR 全文（公版，**真正文**）；
      * borrowable → 给借阅链接（版权书，只给入口，不落全文）。
    以前只取书目字段，等于把 Open Library 最强的能力丢掉了。
    """
    data = _safe_fetch(
        fetch,
        "https://openlibrary.org/search.json",
        params={
            "q": query,
            "limit": limit,
            "fields": "key,title,author_name,first_publish_year,cover_i,language,subject,isbn,"
                      "ebook_access,ia,public_scan_b",
        },
    )
    if not isinstance(data, dict):
        return []
    out: list[dict[str, Any]] = []
    for item in (data.get("docs") or [])[:limit]:
        if not isinstance(item, dict):
            continue
        cover_id = item.get("cover_i")
        key = f"https://openlibrary.org{item.get('key', '')}"
        access = str(item.get("ebook_access") or "").strip().lower()
        ia_id = _first_ia_id(item.get("ia"))
        is_public = bool(ia_id) and (
            access == "public" or item.get("public_scan_b") is True
        )

        download = ""
        files: list[dict[str, str]] = []
        read_url = ""
        borrow_url = ""
        rights = RIGHTS_UNKNOWN
        if is_public:
            text_url = f"https://archive.org/download/{ia_id}/{ia_id}_djvu.txt"
            download, rights = text_url, RIGHTS_PUBLIC_DOMAIN
            read_url = f"https://archive.org/details/{ia_id}"
            files = [
                {"format": "txt", "url": text_url, "label": "OCR 全文（TXT）"},
                {"format": "details", "url": read_url, "label": "在线阅读"},
            ]
        elif access == "borrowable":
            borrow_url = key
            files = [{"format": "borrow", "url": key, "label": "借阅（需登录）"}]
            rights = RIGHTS_LICENSED

        record = _norm(
            source="openlibrary",
            source_id=str(item.get("key", "")).rsplit("/", 1)[-1],
            title=item.get("title", ""),
            author="、".join(_as_list(item.get("author_name"))),
            cover=f"https://covers.openlibrary.org/b/id/{cover_id}-M.jpg" if cover_id else "",
            language="、".join(_as_list(item.get("language"))[:3]),
            year=item.get("first_publish_year", ""),
            subjects=item.get("subject") or [],
            detail_url=key,
            download_url=download,
            fulltext_format="txt" if download else "",
            files=files,
            read_url=read_url,
            borrow_url=borrow_url,
            isbn="、".join(_as_list(item.get("isbn"))[:3]),
            rights=rights,
        )
        if record:
            out.append(record)
    return out


def _search_googlebooks(query: str, limit: int, fetch: Fetcher) -> list[dict[str, Any]]:
    data = _safe_fetch(
        fetch,
        "https://www.googleapis.com/books/v1/volumes",
        params={"q": query, "maxResults": max(1, min(limit, 40))},
    )
    if not isinstance(data, dict):
        return []
    out: list[dict[str, Any]] = []
    for item in (data.get("items") or [])[:limit]:
        if not isinstance(item, dict):
            continue
        info = item.get("volumeInfo") or {}
        links = info.get("imageLinks") or {}
        record = _norm(
            source="googlebooks",
            source_id=str(item.get("id", "")),
            title=info.get("title", ""),
            author="、".join(_as_list(info.get("authors"))),
            cover=links.get("thumbnail", ""),
            language=info.get("language", ""),
            year=str(info.get("publishedDate", ""))[:4],
            subjects=info.get("categories") or [],
            detail_url=info.get("infoLink", ""),
            rights=RIGHTS_UNKNOWN,
        )
        if record:
            out.append(record)
    return out


def _search_wikisource(query: str, limit: int, fetch: Fetcher) -> list[dict[str, Any]]:
    data = _safe_fetch(
        fetch,
        "https://zh.wikisource.org/w/api.php",
        params={
            "action": "query",
            "list": "search",
            "srsearch": query,
            "srlimit": limit,
            "format": "json",
            "formatversion": "2",
        },
    )
    if not isinstance(data, dict):
        return []
    hits = ((data.get("query") or {}).get("search")) or []
    out: list[dict[str, Any]] = []
    for item in hits[:limit]:
        if not isinstance(item, dict):
            continue
        title = item.get("title", "")
        record = _norm(
            source="wikisource",
            source_id=str(item.get("pageid", "")),
            title=title,
            cover="",
            language="zh",
            subjects=[_strip_tags(item.get("snippet", ""))],
            detail_url=f"https://zh.wikisource.org/wiki/{title}",
            # 维基文库条目即全文；正文在 fetch_fulltext 里按标题取。
            download_url=f"wikisource://{title}",
            fulltext_format="text",
            rights=RIGHTS_PUBLIC_DOMAIN,
        )
        if record:
            out.append(record)
    return out


def _search_ctext(query: str, limit: int, fetch: Fetcher) -> list[dict[str, Any]]:
    """ctext 的 API 需注册 IP 或 key；未授权时静默返回空，不报错打断整轮搜索。"""
    data = _safe_fetch(fetch, "https://api.ctext.org/searchtext", params={"query": query})
    if not isinstance(data, dict):
        return []
    out: list[dict[str, Any]] = []
    for item in (data.get("results") or [])[:limit]:
        if not isinstance(item, dict):
            continue
        urn = str(item.get("urn", ""))
        record = _norm(
            source="ctext",
            source_id=urn,
            title=item.get("title", "") or urn,
            language="zh",
            detail_url=f"https://ctext.org/{urn}",
            download_url=f"ctext://{urn}" if urn else "",
            fulltext_format="text",
            rights=RIGHTS_PUBLIC_DOMAIN,
        )
        if record:
            out.append(record)
    return out


def _search_douban(query: str, limit: int, fetch: Fetcher) -> list[dict[str, Any]]:
    """豆瓣书目建议接口。返回的是 JSON **数组**（不是对象），所以不能走通用取字段那套。

    ⚠️ 这是**国内网络唯一稳定可达**的中文书目源 —— 海外那几个（古腾堡/OpenLibrary/
    Google Books/维基文库）在国内基本全挂。所以它必须排在默认搜索的第一位。
    """
    data = _safe_fetch(fetch, "https://book.douban.com/j/subject_suggest", params={"q": query})
    if not isinstance(data, list):
        return []
    out: list[dict[str, Any]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        # type="b" 才是书；同一接口还会返回影视、音乐等条目。
        if str(item.get("type") or "").strip() != "b":
            continue
        record = _norm(
            source="douban",
            source_id=str(item.get("id") or ""),
            title=item.get("title", ""),
            author=item.get("author_name", ""),
            cover=str(item.get("pic") or ""),
            year=item.get("year", ""),
            language="zh",
            detail_url=str(item.get("url") or ""),
            rights=RIGHTS_UNKNOWN,
        )
        if record:
            out.append(record)
        if len(out) >= limit:
            break
    return out


_SEARCHERS: dict[str, Callable[[str, int, Fetcher], list[dict[str, Any]]]] = {
    "douban": _search_douban,
    "standardebooks": _search_standardebooks,
    "gutenberg": _search_gutenberg,
    "archive": _search_archive,
    "openlibrary": _search_openlibrary,
    "googlebooks": _search_googlebooks,
    "wikisource": _search_wikisource,
    "ctext": _search_ctext,
}

# 默认参与搜索的源。排序即「可达性优先」：
#   1. 豆瓣（中文书目，国内直连可达）
#   2. Standard Ebooks（**国内直连可达的唯一全文源**，实测 2026-10-07）
#   3. 其余海外源（古腾堡 / IA / Open Library / 维基文库 / Google Books）——
#      国内直连必超时，配了代理才会出结果；连不上只算 0 条，不拖慢整轮。
DEFAULT_SEARCH_SOURCES: tuple[str, ...] = (
    "douban",
    "standardebooks",
    "gutenberg",
    "archive",
    "openlibrary",
    "wikisource",
    "googlebooks",
    "ctext",
)


# 豆瓣条目页的简介区块。只取这一段，**不落整页**。
_DOUBAN_INTRO_RE = re.compile(r'<div class="intro">(.*?)</div>', re.S)
_DOUBAN_RATING_RE = re.compile(r'property="v:average"[^>]*>\s*([0-9.]+)\s*<')


def douban_detail(subject_id: str, *, fetch_text: Fetcher | None = None) -> dict[str, str]:
    """抓豆瓣条目页的**简介与评分**。

    这是「减少碎片化」的关键材料之一：简介是成段论述，不是碎片。
    **只解析简介与评分两个字段**，页面上其它内容一律不取 —— 既是版权边界，
    也避免把一堆无关 HTML 噪音喂给模型。
    """
    sid = str(subject_id or "").strip()
    if not sid.isdigit():
        return {"intro": "", "rating": ""}
    fetch_text = fetch_text or _http_text
    raw = _safe_fetch(fetch_text, f"https://book.douban.com/subject/{sid}/")
    if not raw or not isinstance(raw, str):
        return {"intro": "", "rating": ""}
    match = _DOUBAN_INTRO_RE.search(raw)
    intro = ""
    if match:
        text = re.sub(r"<br\s*/?>", "\n", match.group(1))
        intro = html.unescape(re.sub(r"<[^>]+>", "", text)).strip()
    rating = ""
    rate_match = _DOUBAN_RATING_RE.search(raw)
    if rate_match:
        rating = rate_match.group(1)
    return {"intro": intro[:1200], "rating": rating}


def searchable_source_ids() -> list[str]:
    return [s["id"] for s in SOURCES if s.get("searchable")]


def search_books(
    query: str,
    *,
    source_ids: Iterable[str] | None = None,
    limit_per_source: int = 8,
    fetch: Fetcher | None = None,
) -> dict[str, Any]:
    """并发打多个书源，归一化后返回。

    返回 ``{"query", "results", "sources": {id: 命中数}}``。
    **单个源失败不影响其它源** —— 一个挂了就是 0 条，绝不让整轮搜索抛异常。
    """
    text = str(query or "").strip()
    if not text:
        return {"query": "", "results": [], "sources": {}}

    # 调用方**点名**要某几个源时（例如「只搜古腾堡」），就算需要代理也照试 ——
    # 用户明确要求了，不该被我们的策略替他决定。
    explicit = bool(source_ids)
    wanted = [normalize_source_id(s) for s in (source_ids or DEFAULT_SEARCH_SOURCES)]
    wanted = [s for s in wanted if s in _SEARCHERS]
    if not wanted:
        wanted = list(DEFAULT_SEARCH_SOURCES)

    fetch = fetch or _http_any
    limit = max(1, min(int(limit_per_source or 8), 40))

    results: list[dict[str, Any]] = []
    counts: dict[str, int] = {}
    statuses: dict[str, dict[str, Any]] = {}

    def run(source_id: str) -> tuple[str, list[dict[str, Any]], str]:
        # ⚠️ 必须挂一个**记录型 fetch**：各源的搜索器内部用 ``_safe_fetch`` 兜住了
        # 网络异常（这是刻意的，为了让单个源挂掉不炸整轮），代价是异常不再冒泡到
        # 这里 —— 于是「书源连不上」会被记成「ok，0 结果」，状态追踪就废了。
        # 这里在 fetch 层记一笔，再原样抛出，让 ``_safe_fetch`` 照常兜。
        errors: list[str] = []

        # 按源分档超时：只在我们自己的抓取器上生效，注入的假 fetch 一律原样使用
        # （否则测试里的 lambda 会因为多一个参数而报错）。
        source_fetch: Fetcher = fetch
        if fetch is _http_any:
            budget = _SOURCE_TIMEOUTS.get(source_id)
            if budget is None and _SOURCE_BY_ID.get(source_id, {}).get("needs_proxy") and not using_proxy():
                budget = _BLOCKED_SOURCE_TIMEOUT
            if budget is not None:
                def source_fetch(  # noqa: F811 —— 有意遮蔽，只为带上超时
                    url: str, *, params: dict[str, Any] | None = None, _budget: float = budget
                ) -> Any:
                    return _http_any(url, params=params, timeout=_budget)

        def recording_fetch(url: str, *, params: dict[str, Any] | None = None) -> Any:
            try:
                return source_fetch(url, params=params)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{type(exc).__name__}: {exc}"[:160])
                raise

        try:
            items = _SEARCHERS[source_id](text, limit, recording_fetch)
            return source_id, items, (errors[0] if errors else "")
        except Exception as exc:  # noqa: BLE001 —— 搜索器自身抛错也记下来
            return source_id, [], f"{type(exc).__name__}: {exc}"[:160]

    with ThreadPoolExecutor(max_workers=min(_SEARCH_WORKERS, len(wanted))) as pool:
        # 没配代理时**直接跳过**需要代理的源，而不是让它们挨个超时。
        #
        # 为什么必须跳：实测（2026-10-07 国内直连）这些源不只是「慢」——DNS 与握手
        # 会挂到远超 timeout 的位置，八个源并发跑一轮要 240 秒以上，整轮搜索直接
        # 变成「卡住了」。跳过之后只花可达源的时间，同时状态里如实写明「需要代理」，
        # 用户的感受从「坏了」变成「原来要配代理」。
        to_run: list[str] = []
        for source_id in wanted:
            meta = _SOURCE_BY_ID.get(source_id, {})
            # 只在「用我们自己的抓取器 + 没配代理 + 调用方没点名」时才跳过。
            # 注入的假 fetch（测试与门禁）一律照常执行 —— 否则门禁就没法覆盖默认源集合。
            if ((not explicit) and meta.get("needs_proxy") and not using_proxy()
                    and fetch is _http_any):
                counts[source_id] = 0
                statuses[source_id] = {
                    "count": 0,
                    "ok": False,
                    "skipped": True,
                    "error": "需要代理：未配置 TJU_PROXY_URL，已跳过（避免整轮搜索空等）",
                }
                continue
            to_run.append(source_id)

        if to_run:
            for source_id, items, error in pool.map(run, to_run):
                counts[source_id] = len(items)
                statuses[source_id] = {
                    "count": len(items),
                    "ok": not error,
                    "error": error,
                }
                results.extend(items)

    # ⚠️ ``source_status`` 是给「**零结果**」这件事分因的，不能省：
    # 「书源都连不上」与「确实没这本书」在旧版返回里长得一模一样（都是 0 条），
    # 用户看到「没有找到」会以为功能没做。有了它，前端能明确说出
    # 「书源都没连上（网络/代理问题）」，而不是把网络故障伪装成"没搜到"。
    #
    # ``all_failed`` 的口径：**一条结果都没有，且有源真的试过并报错**。
    # 不要求「所有源都报错」—— 只要一个源可达且确实没这本，就不该说成网络问题。
    # **被跳过的源不算**：它们没被尝试过，拿它们去下「全都连不上」的结论是错的
    # （前端会另外用 blocked_sources 提示「这些源需要配代理」）。
    attempted = [item for item in statuses.values() if not item.get("skipped")]
    produced = any(item["count"] > 0 for item in attempted)
    return {
        "query": text,
        "results": results,
        "sources": counts,
        "source_status": statuses,
        "all_failed": bool(attempted) and not produced and any(
            item["error"] for item in attempted
        ),
    }


# --------------------------------------------------------------------------
# 取全文：只对 has_fulltext 的记录开放
# --------------------------------------------------------------------------

# 能直接变成可读文本的格式。**EPUB / MOBI / PDF 不在其中** —— 它们是二进制容器，
# 必须走本地解析（core/parsers.py）；在这里硬抓只会得到一堆乱码喂给模型。
_FETCHABLE_FORMATS = ("txt", "text", "html")


def pick_fetchable(record: dict[str, Any]) -> tuple[str, str]:
    """挑一个「能直接抓成文本」的入口，返回 ``(url, format)``；挑不出返回 ``("", "")``。

    为什么不能直接用 ``download_url``：书源把「最好的下载格式」放在那里（古腾堡
    优先 EPUB），而 EPUB 抓下来是压缩包 —— 于是「取正文」会静默产出乱码。
    所以按「纯文本 > 网页全文 > HTML」重挑。
    """
    if not isinstance(record, dict):
        return "", ""
    order = {"txt": 0, "text": 1, "html": 2}
    best: tuple[int, str, str] | None = None
    for entry in record.get("files") or []:
        if not isinstance(entry, dict):
            continue
        fmt = str(entry.get("format") or "").strip().lower()
        url = str(entry.get("url") or "").strip()
        if fmt in order and url.startswith("http"):
            rank = order[fmt]
            if best is None or rank < best[0]:
                best = (rank, url, fmt)
    if best:
        return best[1], best[2]

    url = str(record.get("download_url") or "")
    fmt = str(record.get("fulltext_format") or "").strip().lower()
    if url.startswith("http") and fmt in order:
        return url, fmt
    return "", ""


def _looks_like_html(raw: str) -> bool:
    head = str(raw or "")[:400].lower()
    return "<html" in head or "<!doctype" in head or "<body" in head or "<p>" in head


def fetch_fulltext(record: dict[str, Any], *, fetch_text: Fetcher | None = None) -> dict[str, Any]:
    """取整本正文。

    返回 ``{"ok", "text", "reason", "format", "chapters"}``。**只服务公版书与本地
    文件** —— ``has_fulltext`` 为假（商业书）时直接拒绝，这是版权红线，不是能力问题。

    ``chapters`` 是这次新增的：能从源方拿到**真实章节结构**的（目前是 Standard
    Ebooks 的 ``epub:type="bodymatter chapter"``）就一并返回，阅读页的「逐章精读」
    就不用再靠正则猜标题 —— 罗马数字章节名（I / II）是猜不出来的。
    """
    if not isinstance(record, dict) or not record.get("has_fulltext"):
        return {
            "ok": False,
            "text": "",
            "reason": "该书源不提供全文（有版权或仅元数据），请在原平台阅读。",
            "format": "",
            "chapters": [],
        }

    source = str(record.get("source") or "")
    fetch_text = fetch_text or _http_text_long

    if source == "wikisource":
        title = str(record.get("download_url", "")).replace("wikisource://", "")
        if not title:
            return {"ok": False, "text": "", "reason": "缺少条目名。", "format": "", "chapters": []}
        raw = _safe_fetch(
            fetch_text,
            "https://zh.wikisource.org/w/api.php",
            params={
                "action": "query",
                "prop": "extracts",
                "explaintext": "1",
                "titles": title,
                "format": "json",
                "formatversion": "2",
            },
        )
        if not raw:
            return {"ok": False, "text": "", "reason": "维基文库未返回正文。", "format": "text", "chapters": []}
        try:
            import json  # noqa: PLC0415

            data = json.loads(raw)
            pages = ((data.get("query") or {}).get("pages")) or []
            body = pages[0].get("extract", "") if pages else ""
        except Exception:
            body = ""
        return {
            "ok": bool(body),
            "text": body,
            "reason": "" if body else "该条目没有可提取的正文。",
            "format": "text",
            "chapters": [],
        }

    url, fmt = pick_fetchable(record)
    if not url:
        # 明确区分「不能取」与「取不到」：这里有 EPUB/PDF 但没法在服务端变成文本，
        # 该让用户去下载后走「导入正文」，而不是报一句含糊的失败。
        if record.get("files") or record.get("download_url"):
            return {
                "ok": False,
                "text": "",
                "reason": "这个源只提供 EPUB / PDF 等打包格式，无法在服务端直接转成文本；"
                          "请下载后用「导入这本书的正文」上传，走本地解析链路。",
                "format": "",
                "chapters": [],
            }
        return {"ok": False, "text": "", "reason": "该源暂不支持自动取全文。", "format": "", "chapters": []}

    raw = _safe_fetch(fetch_text, url)
    if not raw or not isinstance(raw, str):
        return {"ok": False, "text": "", "reason": "下载正文失败。", "format": fmt, "chapters": []}

    chapters: list[dict[str, str]] = []
    if source == "standardebooks":
        chapters = parse_standardebooks_chapters(raw)
        if chapters:
            # 归一化成 split_chapters 认得的标题行（SE 的章标题是裸罗马数字，
            # 直接存进去会被当成正文，逐章精读就永远切不开）。
            blocks = [f"Chapter {item['title']}\n{item['excerpt']}" for item in chapters]
            return {
                "ok": True,
                "text": "\n\n".join(blocks),
                "reason": "",
                "format": "text",
                "chapters": chapters,
            }

    text = raw
    if fmt in ("html", "text") and _looks_like_html(text):
        text = html_to_text(text)
    if source in ("gutenberg", "archive"):
        text = strip_gutenberg_boilerplate(text)

    text = text.strip()
    return {
        "ok": bool(text),
        "text": text,
        "reason": "" if text else "抓到的正文是空的。",
        "format": fmt,
        "chapters": chapters,
    }


# --------------------------------------------------------------------------
# 找文件链接：给「拿不到正文」的书也留一条能走的路
#
# 用户的原话是「最好能获取书籍正文**或者文件链接**」。有版权的书正文拿不到，
# 但「哪里有得读 / 哪里有得借 / 哪里有得下」是可以查的 —— 而且这经常比正文更有用：
# 用户要的往往只是一个能立刻打开的正确入口。
# --------------------------------------------------------------------------

_HATHITRUST_CATALOG = "https://catalog.hathitrust.org/api/volumes/brief/json/"

# rightsCode → 人话。PD/US 是公版（可全文阅读），IC 是版权内（HathiTrust 只给检索）。
_HT_RIGHTS_LABEL = {
    "PD": "公版，可全文阅读",
    "US": "美国境内公版，可全文阅读",
    "IC": "版权内，仅书目与检索",
    "UND": "权利状态不明，仅书目",
}


def parse_hathitrust_links(payload: Any, isbn: str) -> list[dict[str, str]]:
    """把 HathiTrust 书目 API 的返回转成链接列表。纯函数，便于注入测试。"""
    if not isinstance(payload, dict):
        return []
    key = f"isbn:{str(isbn or '').replace('-', '').strip().lower()}"
    entry = payload.get(key)
    if entry is None:  # 键名大小写/格式可能不同，退化成取第一个值
        for value in payload.values():
            if isinstance(value, dict):
                entry = value
                break
    if not isinstance(entry, dict):
        return []

    out: list[dict[str, str]] = []
    for item in entry.get("items") or []:
        if not isinstance(item, dict):
            continue
        url = str(item.get("itemURL") or "").strip()
        if not url:
            continue
        rights = str(item.get("rightsCode") or "").strip().upper()
        out.append({
            "label": "HathiTrust 阅读",
            "url": url,
            "format": "read",
            "note": _HT_RIGHTS_LABEL.get(rights, "权利状态未知"),
            "rights_code": rights,
        })
    for record in (entry.get("records") or {}).values():
        if not isinstance(record, dict):
            continue
        url = str(record.get("recordURL") or "").strip()
        if not url:
            continue
        out.append({
            "label": "HathiTrust 书目",
            "url": url,
            "format": "catalog",
            "note": "馆藏与版本信息",
            "rights_code": "",
        })
    return out


def _links_from_record(record: dict[str, Any]) -> list[dict[str, str]]:
    """把记录自带的入口先收进来（有全文的、能给链接的，都算）。"""
    out: list[dict[str, str]] = []
    for entry in record.get("files") or []:
        if isinstance(entry, dict) and entry.get("url"):
            out.append({
                "label": str(entry.get("label") or entry.get("format") or "文件"),
                "url": str(entry["url"]),
                "format": str(entry.get("format") or ""),
                "note": "",
                "rights_code": "",
            })
    for label, key in (("在线阅读", "read_url"), ("借阅", "borrow_url"), ("书目页", "detail_url")):
        url = str(record.get(key) or "").strip()
        if url:
            out.append({"label": label, "url": url, "format": "", "note": "", "rights_code": ""})
    return out


def find_file_links(
    record: dict[str, Any],
    *,
    fetch: Fetcher | None = None,
) -> dict[str, Any]:
    """给一本书找「文件 / 阅读链接」。

    先收记录自带的入口，再按 ISBN 反查 HathiTrust（覆盖面最广的馆藏）；
    没有 ISBN 就退回用书名问一次 Open Library（能挖出 Internet Archive 的扫描本）。

    返回 ``{"ok", "links", "reason", "checked"}``；``ok`` 表示**至少有一个链接可用**，
    与「有没有抓成功」无关 —— 全都拿不到才为假，并给出原因。
    """
    if not isinstance(record, dict):
        return {"ok": False, "links": [], "reason": "记录不合法。", "checked": []}

    fetch = fetch or _http_json
    links = _links_from_record(record)
    checked: list[str] = []
    errors: list[str] = []

    # 没配代理时不做海外查询 —— 这两个库都在墙外，实测单次就要 25 秒才超时，
    # 两次串起来近 50 秒，用户会以为按钮坏了。跳过并**说清原因**，
    # 比让他干等 50 秒再看到一句「未返回数据」好得多。
    # 注：只有在我们自己的默认抓取器上才跳过；注入的假实现照常执行（测试要用）。
    overseas_reachable = using_proxy() or fetch is not _http_json
    if not overseas_reachable:
        errors.append("HathiTrust / Open Library 在墙外，需要配置代理（TJU_PROXY_URL）后才能反查")

    isbn = re.sub(r"[^0-9Xx]", "", str(record.get("isbn") or "").split("、")[0])
    if len(isbn) >= 10 and overseas_reachable:
        checked.append("hathitrust")
        payload = _safe_fetch(fetch, f"{_HATHITRUST_CATALOG}isbn:{isbn}")
        found = parse_hathitrust_links(payload, isbn)
        if found:
            links.extend(found)
        elif payload is None:
            errors.append("HathiTrust 未返回数据")

    if not links and overseas_reachable:
        # 没有现成入口也没 ISBN → 用书名问一次 Open Library，尽量挖出扫描本/借阅入口。
        title = str(record.get("title") or "").strip()
        if title:
            checked.append("openlibrary")
            data = _safe_fetch(
                fetch,
                "https://openlibrary.org/search.json",
                params={"q": title, "limit": 1, "fields": "key,title,ia,ebook_access,public_scan_b"},
            )
            docs = ((data or {}).get("docs") or []) if isinstance(data, dict) else []
            doc = docs[0] if docs and isinstance(docs[0], dict) else None
            if doc:
                ia_id = _first_ia_id(doc.get("ia"))
                access = str(doc.get("ebook_access") or "").lower()
                if ia_id and (access == "public" or doc.get("public_scan_b") is True):
                    links.append({
                        "label": "Internet Archive 全文（OCR）",
                        "url": f"https://archive.org/download/{ia_id}/{ia_id}_djvu.txt",
                        "format": "txt",
                        "note": "公版扫描本",
                        "rights_code": "PD",
                    })
                if ia_id:
                    links.append({
                        "label": "Internet Archive 在线阅读",
                        "url": f"https://archive.org/details/{ia_id}",
                        "format": "read",
                        "note": "",
                        "rights_code": "",
                    })
                elif access == "borrowable":
                    links.append({
                        "label": "Open Library 借阅",
                        "url": f"https://openlibrary.org{doc.get('key', '')}",
                        "format": "borrow",
                        "note": "受控数字借阅，需登录",
                        "rights_code": "IC",
                    })
            elif data is None:
                errors.append("Open Library 未返回数据")

    # 去重（同一 URL 只留一条，先出现的优先——那通常是更"主"的入口）
    seen: set[str] = set()
    unique: list[dict[str, str]] = []
    for link in links:
        url = link.get("url") or ""
        if not url or url in seen:
            continue
        seen.add(url)
        unique.append(link)

    return {
        "ok": bool(unique),
        "links": unique[:8],
        "reason": "" if unique else ("；".join(errors) or "没有找到可用的文件或阅读入口。"),
        "checked": checked,
    }


# --------------------------------------------------------------------------
# 本地导入：用户自备的书，正文只存本机
# --------------------------------------------------------------------------

LOCAL_BOOK_SUFFIXES = (".epub", ".pdf", ".txt", ".md", ".mobi", ".azw3", ".djvu")


def import_local_book(path: str | Path) -> dict[str, Any] | None:
    """把一个本地文件登记成书目记录。**只登记，不解析** ——
    正文解析交给 ``core/parsers.py``（它已经支持 PDF / 扫描件 / OCR），
    这里不重复造轮子。"""
    file_path = Path(path)
    if not file_path.exists() or not file_path.is_file():
        return None
    suffix = file_path.suffix.lower()
    if suffix not in LOCAL_BOOK_SUFFIXES:
        return None
    fmt = suffix.lstrip(".")
    return _norm(
        source="local",
        source_id=str(file_path.resolve()),
        title=file_path.stem,
        cover="",
        language="",
        detail_url=f"file://{file_path.resolve().as_posix()}",
        download_url=f"file://{file_path.resolve().as_posix()}",
        fulltext_format=fmt,
        rights=RIGHTS_USER_PROVIDED,
    )


# --------------------------------------------------------------------------
# 书单聚合
# --------------------------------------------------------------------------


# --------------------------------------------------------------------------
# 正文分章：本地导入 / 公版书的「逐章精读」全靠它
# --------------------------------------------------------------------------

# 章节标题的**行首标记**。判定分两步（先标记、再限长），比一个巨型正则好读也好改。
_CHAPTER_MARKERS = (
    re.compile(r"^第\s*[一二三四五六七八九十百零〇0-9]{1,6}\s*[章节回卷篇部]"),
    re.compile(r"^(?:Chapter|CHAPTER|Part|PART)\s+[0-9IVXLC]+"),
    re.compile(r"^[0-9]{1,3}\s*[.、]\s*\S"),
)

# 一行最多多长还可能是标题。中文标题很少超过这个长度；
# 超过就基本是正文里恰好以「第三章」开头的句子 —— 那种误判会把正文切得七零八落。
_MAX_HEAD_CHARS = 48


def is_chapter_head(line: str) -> bool:
    """这一行像不像章节标题。纯函数，便于单测。"""
    text = str(line or "").strip()
    if not text or len(text) > _MAX_HEAD_CHARS:
        return False
    return any(pattern.match(text) for pattern in _CHAPTER_MARKERS)


def split_chapters(
    text: str, *, max_chapters: int = 24, min_chapter_chars: int = 300, max_chapter_chars: int = 6000
) -> list[dict[str, str]]:
    """把整本正文按章节标题切开。切不出来就返回空列表（调用方退化为整块摘录）。

    **不猜结构**：标题认不出就老实返回空，由调用方走「整块摘录」那条路 ——
    硬按固定字数切出来的「章」是假结构，拿去逐章精读只会误导人。

    先按**行**找标题（而不是在整段文本里搜正则）：标题总是独占一行，
    而行首定位天然排除了「正文里提到第三章」这种误判。
    """
    raw = str(text or "")
    if len(raw) < 800:
        return []

    lines = raw.splitlines()
    marks: list[tuple[int, str]] = []          # (行号, 标题)
    for index, line in enumerate(lines):
        if is_chapter_head(line):
            marks.append((index, line.strip()))
            if len(marks) >= max_chapters + 1:
                break
    if len(marks) < 2:
        return []

    out: list[dict[str, str]] = []
    for position, (line_no, title) in enumerate(marks[:max_chapters]):
        end = marks[position + 1][0] if position + 1 < len(marks) else len(lines)
        body = "\n".join(lines[line_no + 1 : end]).strip()
        if len(body) < min_chapter_chars:
            continue
        out.append({"title": title, "excerpt": body[:max_chapter_chars]})
    return out if len(out) >= 2 else []


def group_by_category(records: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """把搜索结果按一级领域分组，供「完整书单」视图直接渲染。

    组内按「有全文的排前面」排 —— 用户建书单时最想要的是**能真读到的书**。
    """
    buckets: dict[str, list[dict[str, Any]]] = {}
    for record in records:
        if not isinstance(record, dict):
            continue
        buckets.setdefault(record.get("category") or "其他", []).append(record)
    out: list[dict[str, Any]] = []
    for category, items in buckets.items():
        items.sort(key=lambda r: (not r.get("has_fulltext"), r.get("title", "")))
        out.append({"category": category, "count": len(items), "books": items})
    out.sort(key=lambda g: (-g["count"], g["category"]))
    return out


def fulltext_summary(records: Iterable[dict[str, Any]]) -> dict[str, int]:
    """一份书单里「能读全文 / 有文件链接 / 只有元数据」各占多少 —— 首页那句提示用。

    三者互斥且不重叠：有全文的必然也有链接，但只按**最高档**记一次，
    这样前端一句话就能说清「这份书单里有几本能真读」。
    """
    total = fulltext = with_links = 0
    for record in records:
        if not isinstance(record, dict):
            continue
        total += 1
        if record.get("has_fulltext"):
            fulltext += 1
        elif record.get("files") or record.get("read_url") or record.get("borrow_url"):
            with_links += 1
    return {
        "total": total,
        "fulltext": fulltext,
        "with_links": with_links,
        "metadata_only": total - fulltext - with_links,
    }
