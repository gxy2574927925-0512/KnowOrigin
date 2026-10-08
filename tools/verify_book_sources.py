"""多书源适配层回归（纯函数 + 注入假 fetch，不需要网络 / key / httpx）。

跑法：``python tools/verify_book_sources.py``

覆盖 ——
  1. 书源注册表：能力标注（全文 / 元数据 / 外链）与版权状态自洽
  2. 归一化：标题为空丢弃；**has_fulltext 只对公版/用户自备放行**（版权红线）
  3. 各源解析器：字段落位正确（封面 / 作者 / 年份 / 分类 / 全文格式优先级）
  4. 并发搜索：单个源抛异常不影响其它源
  5. 取全文：商业书直接拒绝；维基文库按条目取正文
  6. 本地导入：只认书籍后缀；登记为 user-provided 且带全文
  7. 书单聚合：按一级领域分组、有全文的排前
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from core import book_sources as bs  # noqa: E402

FAILS = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


# ------------------------------------------------------- 1. 注册表自洽

sources = bs.list_sources()
check("注册表非空", len(sources) >= 8, str(len(sources)))
check("每个源都有能力标签", all(s.get("kind_label") for s in sources))
check("fulltext 源标记正确",
      all(s["has_fulltext"] == (s["kind"] == bs.KIND_FULLTEXT) for s in sources))
check("微信读书标注为无全文",
      next(s for s in sources if s["id"] == "weread")["has_fulltext"] is False)
check("古腾堡标注为有全文",
      next(s for s in sources if s["id"] == "gutenberg")["has_fulltext"] is True)
check("豆瓣已升级为可搜索的元数据源（国内唯一稳定可达的中文书目源）",
      next(s for s in sources if s["id"] == "douban")["kind"] == bs.KIND_METADATA)
check("只有可搜索的源出现在 searchable_source_ids",
      set(bs.searchable_source_ids()) == {"douban", "standardebooks", "gutenberg", "archive",
                                          "wikisource", "ctext", "openlibrary", "googlebooks"},
      str(bs.searchable_source_ids()))
check("normalize_source_id 收敛", bs.normalize_source_id("GUTENBERG") == "gutenberg")
check("normalize_source_id 拒绝非法", bs.normalize_source_id("zlib") == "")

# 可达性标注：海外源必须标明「需代理」，否则国内用户会把超时误读成功能没做
_by_id = {s["id"]: s for s in sources}
check("Standard Ebooks 标为国内直连可达（实测结论）",
      _by_id["standardebooks"]["needs_proxy"] is False)
check("Standard Ebooks 是可搜索的全文源",
      _by_id["standardebooks"]["searchable"] is True
      and _by_id["standardebooks"]["has_fulltext"] is True)
check("海外源都标了 needs_proxy",
      all(_by_id[sid]["needs_proxy"] for sid in
          ("gutenberg", "archive", "wikisource", "openlibrary", "googlebooks", "hathitrust")),
      str([sid for sid in ("gutenberg", "archive", "wikisource", "openlibrary", "googlebooks", "hathitrust")
           if not _by_id[sid]["needs_proxy"]]))
check("国内可达源不标 needs_proxy",
      all(_by_id[sid]["needs_proxy"] is False for sid in ("douban", "ctext", "local", "weread")))
check("HathiTrust 只做反查、不做关键词搜索",
      _by_id["hathitrust"]["searchable"] is False)


# ------------------------------------------------------- 2. 归一化与版权红线

r = bs._norm(source="gutenberg", source_id="1342", title="Pride and Prejudice",
             author="Jane Austen", download_url="https://x/1.txt", fulltext_format="txt",
             rights=bs.RIGHTS_PUBLIC_DOMAIN)
check("公版书 has_fulltext=True", r["has_fulltext"] is True)
check("公版书 fulltext_format 保留", r["fulltext_format"] == "txt")
check("无标题记录被丢弃", bs._norm(source="gutenberg", source_id="1", title="   ") is None)

licensed = bs._norm(source="weread", source_id="b1", title="三体",
                    download_url="https://x/2.txt", fulltext_format="txt",
                    rights=bs.RIGHTS_LICENSED)
check("版权书即使有 download_url 也不给全文（版权红线）", licensed["has_fulltext"] is False)
check("版权书 fulltext_format 被清空", licensed["fulltext_format"] == "")

unknown = bs._norm(source="openlibrary", source_id="OL1W", title="某书",
                   download_url="https://x/3.txt", rights=bs.RIGHTS_UNKNOWN)
check("状态不明一律不给全文", unknown["has_fulltext"] is False)

check("分类由标题/标签推断",
      bs._norm(source="openlibrary", source_id="x", title="人类简史", subjects=["历史", "人类学"])["category"]
      in {"历史", "人文社科"})
check("topics 截断到 8 个",
      len(bs._norm(source="x", source_id="1", title="t", subjects=[f"标签{i}" for i in range(20)])["topics"]) == 8)


# ------------------------------------------------------- 2.5 豆瓣源

def fake_fetch_douban(url, *, params=None):
    return [
        {"title": "三体", "url": "https://book.douban.com/subject/2567698/",
         "pic": "https://img3.doubanio.com/x.jpg", "author_name": "刘慈欣", "year": "2008",
         "type": "b", "id": "2567698"},
        {"title": "三体（电影）", "type": "m", "id": "999"},          # 非书条目要滤掉
        {"title": "三体Ⅱ", "author_name": "刘慈欣", "year": "2008", "type": "b", "id": "3066477"},
    ]


got = bs._search_douban("三体", 5, fake_fetch_douban)
check("豆瓣解析出 2 条（影视条目被滤掉）", len(got) == 2, str(len(got)))
check("豆瓣封面落位", got[0]["cover"].endswith("x.jpg"))
check("豆瓣条目链接落位", got[0]["detail_url"].endswith("/2567698/"))
check("豆瓣无全文（版权边界）", got[0]["has_fulltext"] is False)
# 豆瓣接口**不返回分类标签**，所以只能靠书名推断 —— 这是它的真实限制。
# 书名里有可识别关键词时能归类，没有就落「其他」（比瞎猜强）。
check("豆瓣书名含关键词时能归类",
      bs._search_douban("x", 5, lambda *a, **k: [
          {"title": "经济学原理", "type": "b", "id": "1"},
      ])[0]["category"] == "经济管理",
      bs._search_douban("x", 5, lambda *a, **k: [{"title": "经济学原理", "type": "b", "id": "1"}])[0]["category"])
check("豆瓣不带标签时落「其他」（不瞎猜）", got[0]["category"] == "其他", got[0]["category"])


def fake_text_douban(url, *, params=None):
    return ('<html><span property="v:itemreviewed">三体</span>'
            '<strong property="v:average">8.9</strong>'
            '<div class="intro">文化大革命如火如荼进行的同时。<br>军方探寻外星文明。</div></html>')


detail = bs.douban_detail("2567698", fetch_text=fake_text_douban)
check("豆瓣简介解析成功", detail["intro"].startswith("文化大革命"), detail["intro"][:30])
check("豆瓣简介里的 <br> 换成换行", "\n" in detail["intro"])
check("豆瓣评分解析成功", detail["rating"] == "8.9", detail["rating"])
check("非法 id 不抓取", bs.douban_detail("abc") == {"intro": "", "rating": ""})
check("抓不到页面返回空而不抛", bs.douban_detail("1", fetch_text=lambda *a, **k: None)["intro"] == "")


# ------------------------------------------------------- 3. 各源解析器

def fake_fetch_gutenberg(url, *, params=None):
    if "gutendex" in url:
        return {"results": [{
            "id": 1342,
            "title": "Pride and Prejudice",
            "authors": [{"name": "Austen, Jane"}],
            "languages": ["en"],
            "subjects": ["Courtship -- Fiction"],
            "bookshelves": ["Best Books Ever Listings"],
            "formats": {
                "text/html; charset=utf-8": "https://gutenberg.org/1342.html",
                "application/epub+zip": "https://gutenberg.org/1342.epub",
                "text/plain; charset=utf-8": "https://gutenberg.org/1342.txt",
                "image/jpeg": "https://gutenberg.org/cover.jpg",
            },
        }]}
    return None


got = bs._search_gutenberg("austen", 5, fake_fetch_gutenberg)
check("古腾堡解析出 1 条", len(got) == 1)
check("古腾堡封面落位", got[0]["cover"].endswith("cover.jpg"))
check("古腾堡优先取 EPUB 全文", got[0]["fulltext_format"] == "epub", got[0]["fulltext_format"])
check("古腾堡作者拼接", got[0]["author"] == "Austen, Jane")
check("古腾堡版权=公版", got[0]["rights"] == bs.RIGHTS_PUBLIC_DOMAIN)
check("古腾堡分类=文学小说", got[0]["category"] == "文学小说", got[0]["category"])


def fake_fetch_openlibrary(url, *, params=None):
    return {"docs": [{
        "key": "/works/OL17267881W",
        "title": "三体",
        "author_name": ["刘慈欣"],
        "first_publish_year": 2008,
        "cover_i": 9157544,
        "language": ["chi", "eng"],
        "subject": ["Science fiction"],
    }]}


got = bs._search_openlibrary("三体", 5, fake_fetch_openlibrary)
check("OpenLibrary 封面按 cover_i 拼", got[0]["cover"] == "https://covers.openlibrary.org/b/id/9157544-M.jpg")
check("OpenLibrary 年份落位", got[0]["year"] == "2008")
check("OpenLibrary 无全文", got[0]["has_fulltext"] is False)


def fake_fetch_wikisource(url, *, params=None):
    return {"query": {"search": [{"pageid": 123, "title": "論語", "snippet": "<span>学而时习之</span>"}]}}


got = bs._search_wikisource("論語", 5, fake_fetch_wikisource)
check("维基文库 snippet 去标签", got[0]["topics"][0] == "学而时习之", got[0]["topics"][0])
check("维基文库带全文标记", got[0]["has_fulltext"] is True)


def fake_fetch_broken(url, *, params=None):
    raise RuntimeError("网络炸了")


check("源抛异常 → 该源返回空列表", bs._search_gutenberg("x", 5, fake_fetch_broken) == [])


# ------------------------------------------------------- 4. 并发搜索隔离

def mixed_fetch(url, *, params=None):
    if "gutendex" in url:
        raise RuntimeError("古腾堡挂了")
    if "openlibrary" in url:
        return {"docs": [{"key": "/works/OL1W", "title": "置身事内", "author_name": ["兰小欢"]}]}
    if "googleapis" in url:
        return {"items": [{"id": "gb1", "volumeInfo": {"title": "穷查理宝典", "authors": ["芒格"],
                                                       "categories": ["经济"], "language": "zh",
                                                       "publishedDate": "2010-01-01",
                                                       "imageLinks": {"thumbnail": "https://g/thumb.jpg"}}}]}
    if "wikisource" in url:
        return {"query": {"search": []}}
    return None


res = bs.search_books("经济", source_ids=["gutenberg", "openlibrary", "googlebooks", "wikisource"],
                      fetch=mixed_fetch)
check("单源失败不打断整轮", len(res["results"]) == 2, str(len(res["results"])))
check("失败源计数为 0", res["sources"]["gutenberg"] == 0)
check("成功源计数正确", res["sources"]["openlibrary"] == 1 and res["sources"]["googlebooks"] == 1)
check("空查询返回空", bs.search_books("  ", fetch=mixed_fetch)["results"] == [])
check("非法源名回落到默认集", bs.search_books("x", source_ids=["zlib"], fetch=mixed_fetch)["sources"] != {})

# 零结果必须能分因：书源全挂 ≠ 确实没这本书
res2 = bs.search_books("经济", source_ids=["gutenberg", "openlibrary", "googlebooks", "wikisource"],
                       fetch=mixed_fetch)
check("返回 source_status", "source_status" in res2 and len(res2["source_status"]) == 4,
      str(list(res2.get("source_status", {}))))
check("失败源标记 ok=False 且带原因",
      res2["source_status"]["gutenberg"]["ok"] is False and res2["source_status"]["gutenberg"]["error"],
      str(res2["source_status"].get("gutenberg")))
check("成功源标记 ok=True", res2["source_status"]["openlibrary"]["ok"] is True)
check("部分成功时 all_failed=False", res2["all_failed"] is False)

all_dead = bs.search_books("经济", source_ids=["gutenberg"], fetch=fake_fetch_broken)
check("全部失败时 all_failed=True", all_dead["all_failed"] is True)
check("全部失败时结果为空但状态可查", all_dead["results"] == [] and all_dead["source_status"]["gutenberg"]["error"])


# ------------------------------------------------------- 5. 取全文

def fake_text(url, *, params=None):
    if "zh.wikisource" in url:
        import json
        return json.dumps({"query": {"pages": [{"extract": "学而时习之，不亦说乎。"}]}})
    return "全文正文"


refuse = bs.fetch_fulltext({"source": "weread", "has_fulltext": False, "title": "三体"})
check("商业书取全文被拒", refuse["ok"] is False and "版权" in refuse["reason"], refuse["reason"])

ws = bs.fetch_fulltext({"source": "wikisource", "has_fulltext": True,
                        "download_url": "wikisource://論語"}, fetch_text=fake_text)
check("维基文库取到正文", ws["ok"] is True and "学而时习之" in ws["text"], ws["text"][:40])

gb = bs.fetch_fulltext({"source": "gutenberg", "has_fulltext": True,
                        "download_url": "https://gutenberg.org/1342.txt",
                        "fulltext_format": "txt"}, fetch_text=fake_text)
check("古腾堡取到正文", gb["ok"] is True and gb["text"] == "全文正文")
check("格式透传", gb["format"] == "txt")


# ------------------------------------------------------- 6. 本地导入

tmp = Path(tempfile.mkdtemp(prefix="ko-books-"))
book = tmp / "置身事内.epub"
book.write_text("dummy", encoding="utf-8")
not_book = tmp / "说明.txt.bak"
not_book.write_text("x", encoding="utf-8")

local = bs.import_local_book(book)
check("本地书登记成功", local is not None and local["title"] == "置身事内")
check("本地书版权=用户自备", local["rights"] == bs.RIGHTS_USER_PROVIDED)
check("本地书带全文", local["has_fulltext"] is True and local["fulltext_format"] == "epub")
check("非书籍后缀被拒", bs.import_local_book(not_book) is None)
check("不存在的文件被拒", bs.import_local_book(tmp / "nope.epub") is None)


# ------------------------------------------------------- 6.5 正文分章

check("标题行识别：第三章 收束", bs.is_chapter_head("第三章 收束") is True)
check("标题行识别：3. 结论", bs.is_chapter_head("3. 结论") is True)
check("标题行识别：Chapter 1 Start", bs.is_chapter_head("Chapter 1 Start") is True)
check("正文里提到「第三章」的长句不算标题",
      bs.is_chapter_head("我读到第三章 时忽然明白了这句话其实很长很长很长很长很长很长很长") is False)
check("空行不算标题", bs.is_chapter_head("   ") is False)

sample = ("前言\n" + "x" * 400 + "\n第一章 起点\n" + "甲" * 500
          + "\n第二章 转折\n" + "乙" * 500 + "\n第三章 收束\n" + "丙" * 500)
parts = bs.split_chapters(sample)
check("按章切出 3 段", len(parts) == 3, str(len(parts)))
check("章节标题保留", [p["title"] for p in parts] == ["第一章 起点", "第二章 转折", "第三章 收束"])
check("章节正文非空", all(len(p["excerpt"]) >= 300 for p in parts))
check("无标题正文 → 切不出来（不猜结构）", bs.split_chapters("正文" * 900) == [])
check("太短的文本 → 空", bs.split_chapters("第一章\n短") == [])
check("只有一章 → 空（一章不叫分章）", bs.split_chapters("第一章 A\n" + "甲" * 500) == [])
check("非字符串不炸", bs.split_chapters(None) == [])


# ------------------------------------------------------- 7. 书单聚合

records = [
    {"category": "经济管理", "has_fulltext": False, "title": "置身事内"},
    {"category": "经济管理", "has_fulltext": True, "title": "国富论"},
    {"category": "文学小说", "has_fulltext": True, "title": "Pride and Prejudice"},
]
groups = bs.group_by_category(records)
check("按领域分组", len(groups) == 2, str(len(groups)))
eco = next(g for g in groups if g["category"] == "经济管理")
check("组内计数正确", eco["count"] == 2)
check("有全文的排前面", eco["books"][0]["title"] == "国富论", eco["books"][0]["title"])

summary = bs.fulltext_summary(records)
check("全文统计（含「有文件链接」档）",
      summary == {"total": 3, "fulltext": 2, "with_links": 0, "metadata_only": 1}, str(summary))

linked = [{"title": "某版权书", "files": [{"format": "borrow", "url": "https://x/borrow"}]}]
check("只有借阅链接的书记进 with_links",
      bs.fulltext_summary(linked)["with_links"] == 1 and bs.fulltext_summary(linked)["metadata_only"] == 0)
check("有全文的书不重复计进 with_links",
      bs.fulltext_summary([{"title": "x", "has_fulltext": True, "files": [{"url": "u"}]}])["with_links"] == 0)


# ------------------------------------------------------- 8. 文件链接（files / read / borrow）

files_rec = bs._norm(
    source="gutenberg", source_id="1342", title="Pride and Prejudice",
    rights=bs.RIGHTS_PUBLIC_DOMAIN,
    files=[
        {"format": "epub", "url": "https://x/1.epub", "label": "下载 EPUB"},
        {"format": "txt", "url": "https://x/1.txt", "label": "下载纯文本"},
        {"format": "txt", "url": "https://x/1.txt"},          # 同一 URL 要去重
        {"format": "html", "url": "https://x/1.html"},        # 没 label → 用格式兜底
        {"format": "", "url": ""},                            # 空 URL 要丢
    ],
)
check("files 去重并丢掉空 URL", len(files_rec["files"]) == 3, str(files_rec["files"]))
check("files 里没有 label 时用格式兜底", files_rec["files"][2]["label"] == "HTML",
      files_rec["files"][2]["label"])
check("只给 files 不给 download_url 时自动取主入口",
      files_rec["download_url"] == "https://x/1.epub" and files_rec["fulltext_format"] == "epub")
check("read_url / borrow_url 落位",
      bs._norm(source="openlibrary", source_id="x", title="t", read_url="https://x/r",
               borrow_url="https://x/b")["borrow_url"] == "https://x/b")
check("ISBN 落位（找文件链接的钥匙）",
      bs._norm(source="openlibrary", source_id="x", title="t", isbn="9780141439600")["isbn"] == "9780141439600")


# ------------------------------------------------------- 9. Standard Ebooks（国内可达的全文源）

SE_SEARCH_HTML = """
<ol class="ebooks-list grid">
<li typeof="schema:Book" about="/ebooks/jane-austen/pride-and-prejudice">
  <div class="thumbnail-container"><a href="/ebooks/jane-austen/pride-and-prejudice" tabindex="-1">
    <picture><source srcset="/images/covers/jane-austen_pride-and-prejudice/abc/cover@2x.avif 2x">
    <img src="/images/covers/jane-austen_pride-and-prejudice/abc/cover@2x.jpg" alt=""></picture></a></div>
  <h2><a href="/ebooks/jane-austen/pride-and-prejudice">Pride and Prejudice</a></h2>
</li>
<li typeof="schema:Book" about="/ebooks/ring-lardner/short-fiction">
  <div class="thumbnail-container"><a href="/ebooks/ring-lardner/short-fiction">
    <img src="/images/covers/ring-lardner_short-fiction/def/cover@2x.jpg" alt=""></a></div>
</li>
</ol>
"""


def fake_fetch_se(url, *, params=None):
    return SE_SEARCH_HTML


se_hits = bs._search_standardebooks("austen", 5, fake_fetch_se)
check("SE 搜索：把无关条目滤掉，只留真命中", len(se_hits) == 1, str([h["title"] for h in se_hits]))
check("SE 书名由 slug 还原", se_hits[0]["title"] == "Pride and Prejudice", se_hits[0]["title"])
check("SE 作者由 slug 还原", se_hits[0]["author"] == "Jane Austen", se_hits[0]["author"])
check("SE 封面补成绝对地址",
      se_hits[0]["cover"].startswith("https://standardebooks.org/images/covers/"),
      se_hits[0]["cover"])
check("SE 标为公版且有全文", se_hits[0]["has_fulltext"] is True
      and se_hits[0]["rights"] == bs.RIGHTS_PUBLIC_DOMAIN)
check("SE 给出一组文件链接（含 EPUB）",
      {f["format"] for f in se_hits[0]["files"]} >= {"text", "epub", "azw3"},
      str([f["format"] for f in se_hits[0]["files"]]))
check("SE 的正文入口是单页全文",
      se_hits[0]["download_url"].endswith("/text/single-page"), se_hits[0]["download_url"])

_para = "It is a truth universally acknowledged, that a single man in possession of a good fortune. " * 5
SE_PAGE_HTML = f"""
<main>
<section class="core-css se-css" id="titlepage" epub:type="frontmatter titlepage">
  <h1>Pride and Prejudice</h1><p>By Jane Austen.</p></section>
<section class="core-css local-css" id="chapter-1" epub:type="bodymatter chapter z3998:fiction">
  <h2>I</h2><p>{_para}</p></section>
<section class="core-css local-css" id="chapter-2" epub:type="bodymatter chapter">
  <h2>II</h2><p>{_para}</p></section>
<section id="colophon" epub:type="backmatter colophon"><p>Standard Ebooks 出品。</p></section>
</main>
"""

se_chapters = bs.parse_standardebooks_chapters(SE_PAGE_HTML)
check("SE 分章：只认 bodymatter，封面/版权页被排除", len(se_chapters) == 2,
      str([c["title"] for c in se_chapters]))
check("SE 分章：章标题取自 h2", [c["title"] for c in se_chapters] == ["I", "II"])
check("SE 分章：正文不含标题重复", "It is a truth" in se_chapters[0]["excerpt"]
      and "<h2>" not in se_chapters[0]["excerpt"])

se_full = bs.fetch_fulltext(se_hits[0], fetch_text=lambda *a, **k: SE_PAGE_HTML)
check("SE 取正文成功", se_full["ok"] is True and se_full["chapters"], se_full["reason"])
check("SE 正文归一化出 Chapter 锚点（否则罗马数字章名切不开）",
      "Chapter I" in se_full["text"] and "Chapter II" in se_full["text"])
check("SE 正文能被既有分章器切开（端到端）",
      len(bs.split_chapters(se_full["text"])) == 2,
      str([c["title"] for c in bs.split_chapters(se_full["text"])]))


# ------------------------------------------------------- 10. Internet Archive

ARCHIVE_JSON = {"response": {"numFound": 2, "docs": [
    {"identifier": "mobydick_201312", "title": "Moby Dick", "creator": "Melville, Herman",
     "year": "1851", "licenseurl": "http://creativecommons.org/publicdomain/mark/1.0/",
     "collection": ["americana"]},
    {"identifier": "modern_book", "title": "A Modern Book", "creator": "Someone",
     "year": "1999", "collection": ["inlibrary"]},
]}}

ar = bs._search_archive("moby dick", 5, lambda *a, **k: ARCHIVE_JSON)
check("IA 解析出 2 条", len(ar) == 2, str(len(ar)))
check("IA 公版条目给 OCR 全文入口", ar[0]["has_fulltext"] is True
      and ar[0]["download_url"].endswith("mobydick_201312_djvu.txt"), ar[0]["download_url"])
check("IA 公版条目版权=公版", ar[0]["rights"] == bs.RIGHTS_PUBLIC_DOMAIN)
check("IA 未声明公版的条目**不给全文**（版权红线）",
      ar[1]["has_fulltext"] is False and ar[1]["fulltext_format"] == "")
check("IA 未声明公版的条目仍给阅读/借阅链接",
      ar[1]["read_url"].endswith("/details/modern_book") and ar[1]["borrow_url"], str(ar[1]["files"]))


# ------------------------------------------------------- 11. Open Library 的 ebook_access 分流

OL_JSON = {"docs": [
    {"key": "/works/OL1W", "title": "Moby Dick", "author_name": ["Melville"],
     "cover_i": 1, "ebook_access": "public", "ia": ["mobydick_201312"]},
    {"key": "/works/OL2W", "title": "A Borrowable Book", "author_name": ["X"],
     "ebook_access": "borrowable", "ia": ""},
    {"key": "/works/OL3W", "title": "No Ebook Book", "author_name": ["Y"],
     "ebook_access": "no_ebook"},
]}

ol = bs._search_openlibrary("moby", 5, lambda *a, **k: OL_JSON)
check("OL public → 直取 IA 全文", ol[0]["has_fulltext"] is True
      and ol[0]["rights"] == bs.RIGHTS_PUBLIC_DOMAIN, str(ol[0]["download_url"]))
check("OL borrowable → 只给借阅链接、不给全文",
      ol[1]["has_fulltext"] is False and ol[1]["borrow_url"].endswith("/works/OL2W"))
check("OL no_ebook → 纯元数据", ol[2]["has_fulltext"] is False
      and not ol[2]["files"] and not ol[2]["borrow_url"])
check("OL 返回 ISBN 供反查", bs._search_openlibrary("x", 1, lambda *a, **k: {
    "docs": [{"key": "/works/OL9W", "title": "t", "isbn": ["9780141439600", "0141439602"]}]}
)[0]["isbn"] == "9780141439600、0141439602")


# ------------------------------------------------------- 12. 正文后处理（HTML / 古腾堡页眉）

check("HTML 转文本：丢掉 script/style/nav",
      "alert" not in bs.html_to_text("<nav>x</nav><script>alert(1)</script><p>正文</p>"))
check("HTML 转文本：块级标签变换行",
      bs.html_to_text("<p>第一段</p><p>第二段</p>") == "第一段\n第二段")
check("HTML 转文本：实体解码", bs.html_to_text("<p>a &amp; b &lt;c&gt;</p>") == "a & b <c>")
_raw_g = ("版权页眉废话\n"
          "*** START OF THE PROJECT GUTENBERG EBOOK PRIDE ***\n"
          "第一章 起点\n" + "甲" * 400 + "\n*** END OF THE PROJECT GUTENBERG EBOOK PRIDE ***\n"
          "尾部许可证废话")
_stripped = bs.strip_gutenberg_boilerplate(_raw_g)
check("古腾堡页眉页脚被剥掉",
      "废话" not in _stripped and "第一章 起点" in _stripped, _stripped[:60])

check("pick_fetchable：TXT 优先于 EPUB（EPUB 抓下来是乱码）",
      bs.pick_fetchable({"files": [{"format": "epub", "url": "https://x/a.epub"},
                                   {"format": "txt", "url": "https://x/a.txt"}]})
      == ("https://x/a.txt", "txt"))
check("pick_fetchable：只有 EPUB 时明确说取不到",
      bs.pick_fetchable({"files": [{"format": "epub", "url": "https://x/a.epub"}],
                         "download_url": "https://x/a.epub", "fulltext_format": "epub"}) == ("", ""))
_only_epub = bs.fetch_fulltext({"source": "gutenberg", "has_fulltext": True,
                                "files": [{"format": "epub", "url": "https://x/a.epub"}],
                                "download_url": "https://x/a.epub", "fulltext_format": "epub"})
check("只有 EPUB 时给出「下载后导入」的可行指引",
      _only_epub["ok"] is False and "导入" in _only_epub["reason"], _only_epub["reason"])

check("HTML 格式正文会被转成纯文本",
      bs.fetch_fulltext({"source": "gutenberg", "has_fulltext": True,
                         "download_url": "https://x/a.html", "fulltext_format": "html",
                         "files": [{"format": "html", "url": "https://x/a.html"}]},
                        fetch_text=lambda *a, **k: "<html><body><p>正文段落</p></body></html>")["text"]
      == "正文段落")
check("古腾堡正文自动剥页眉",
      "START OF" not in bs.fetch_fulltext(
          {"source": "gutenberg", "has_fulltext": True, "download_url": "https://x/a.txt",
           "fulltext_format": "txt", "files": [{"format": "txt", "url": "https://x/a.txt"}]},
          fetch_text=lambda *a, **k: _raw_g)["text"])


# ------------------------------------------------------- 13. 找文件链接

HT_JSON = {"isbn:9780141439600": {
    "records": {"001234567": {"recordURL": "https://catalog.hathitrust.org/Record/001234567"}},
    "items": [{"htid": "mdp.39015000000000",
               "itemURL": "https://babel.hathitrust.org/cgi/pt?id=mdp.39015000000000",
               "rightsCode": "PD"}],
}}

ht_links = bs.parse_hathitrust_links(HT_JSON, "978-0141439600")
check("HathiTrust 链接解析：阅读 + 书目各一条", len(ht_links) == 2, str(ht_links))
check("HathiTrust 公版标注成人话", "公版" in ht_links[0]["note"], ht_links[0]["note"])

found = bs.find_file_links({"title": "Pride and Prejudice", "isbn": "9780141439600"},
                           fetch=lambda *a, **k: HT_JSON)
check("找文件链接：命中 HathiTrust", found["ok"] is True and len(found["links"]) == 2, str(found["links"]))
check("找文件链接：声明查了哪些源", "hathitrust" in found["checked"])

own = bs.find_file_links({"title": "t", "files": [{"format": "txt", "url": "https://x/t.txt"}]},
                         fetch=lambda *a, **k: None)
check("找文件链接：自带入口即使联网失败也算成功",
      own["ok"] is True and own["links"][0]["url"] == "https://x/t.txt")

offline = bs.find_file_links({"title": "没有任何入口的书"}, fetch=lambda *a, **k: None)
check("找文件链接：全都拿不到时 ok=False 且说明原因",
      offline["ok"] is False and "未返回数据" in offline["reason"], offline["reason"])

ol_links = bs.find_file_links({"title": "Moby Dick"}, fetch=lambda *a, **k: {
    "docs": [{"key": "/works/OL1W", "ia": ["mobydick_201312"], "ebook_access": "public"}]})
check("找文件链接：无 ISBN 时退回 Open Library 挖出扫描本",
      any(l["url"].endswith("mobydick_201312_djvu.txt") for l in ol_links["links"]),
      str([l["url"] for l in ol_links["links"]]))


# ------------------------------------------------------- 14. 代理开关

import os  # noqa: E402

_old_proxy = os.environ.get("TJU_PROXY_URL")
os.environ["TJU_PROXY_URL"] = "http://127.0.0.1:7897"
check("配了代理：using_proxy 为真", bs.using_proxy() is True)
check("配了代理：海外源不再标 blocked",
      not next(s for s in bs.list_sources() if s["id"] == "gutenberg")["blocked"])
os.environ.pop("TJU_PROXY_URL", None)
check("没配代理：using_proxy 为假", bs.using_proxy() is False)
check("没配代理：海外源标 blocked（前端据此提示配代理）",
      next(s for s in bs.list_sources() if s["id"] == "gutenberg")["blocked"] is True)
check("没配代理：国内源不受影响",
      next(s for s in bs.list_sources() if s["id"] == "standardebooks")["blocked"] is False)

# 没配代理时**不空等**：需要代理的源直接跳过，并在状态里说清原因。
# 这是实测驱动的策略 —— 八个源里五个在墙外，DNS/握手会挂到远超 timeout 的位置，
# 一轮默认搜索要 240 秒以上，用户的感受就是「卡死了」。
_orig_any = bs._http_any
_orig_json = bs._http_json
_called: list[str] = []


def _boom(url, **kwargs):
    """假的默认抓取器：国内源给正常响应，墙外的**一旦被调用就说明策略失效**。"""
    _called.append(url)
    if "douban" in url:
        return [{"title": "Moby Dick", "type": "b", "id": "1"}]
    if "standardebooks" in url:
        return "<ol class='ebooks-list'></ol>"
    if "ctext" in url:
        return {"error": "needs auth"}
    raise RuntimeError("墙外的源不该被访问")


# 这一段必须处于「确定没配代理」的状态：有人本机就开着 HTTPS_PROXY，
# 不显式清掉的话这里会走联网分支，断言就不成立了。
_saved_env = {name: os.environ.pop(name, None) for name in bs._PROXY_ENV_NAMES}
bs._http_any = _boom
bs._http_json = _boom
try:
    skipped = bs.search_books("moby dick", limit_per_source=2)
    skip_calls = list(_called)
    _called.clear()
    named = bs.search_books("moby dick", source_ids=["gutenberg"], limit_per_source=2)
    named_calls = list(_called)
    _called.clear()
    no_wait = bs.find_file_links({"title": "Pride and Prejudice", "isbn": "9780141439600"})
    link_calls = list(_called)
finally:
    bs._http_any = _orig_any
    bs._http_json = _orig_json
    for _name, _value in _saved_env.items():
        if _value is not None:
            os.environ[_name] = _value

check("没配代理：海外源被标记为 skipped",
      skipped["source_status"]["gutenberg"].get("skipped") is True,
      str(skipped["source_status"].get("gutenberg")))
check("跳过原因写明「需要代理」",
      "代理" in skipped["source_status"]["archive"]["error"],
      skipped["source_status"]["archive"]["error"])
check("被跳过的源**一个请求都没发出去**",
      not any("archive.org" in u or "gutendex" in u or "openlibrary" in u for u in skip_calls),
      str(skip_calls[:5]))
check("国内源照常尝试（不是一起跳过）",
      any("douban" in u for u in skip_calls), str(skip_calls[:5]))
check("被跳过不算 all_failed（它们没被尝试过，不该下「全都连不上」的结论）",
      skipped["all_failed"] is False and skipped["sources"]["douban"] == 1,
      f"all_failed={skipped['all_failed']} douban={skipped['sources'].get('douban')}")
check("点名要的海外源不会被跳过（用户明确要求就照试）",
      named["source_status"]["gutenberg"].get("skipped") is not True
      and any("gutendex" in u for u in named_calls), str(named["source_status"]))
check("找文件链接：没配代理时不空等，直接说明需要代理（实测串行要 ~50 秒）",
      no_wait["ok"] is False and "代理" in no_wait["reason"] and link_calls == [],
      f"{no_wait['reason']} | calls={link_calls}")
if _old_proxy is not None:
    os.environ["TJU_PROXY_URL"] = _old_proxy


print("\n%d 项未通过" % len(FAILS) if FAILS else "\n全部通过")
sys.exit(1 if FAILS else 0)
