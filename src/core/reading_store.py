"""读书数据层：把「书」和「项目」绑起来，并让收获文档自动沉淀成知识卡片。

## 两件必须自动化的事

1. **按需建项目**。``ensure_project()``：没有项目就建一个 ``project_type='book'``
   的项目并回填 ``project_id``。之后这本书就天然继承了知源已有的整条链路
   （框架 / 卡片 / 测验 / 掌握度 / 撤销 / 导出），一行都不用重写。**关键是调用时机**：
   加入书架**不**建，只有真要往里放资料时（导入 / 取回正文、生成收获沉淀卡片）才建 ——
   刚加入的书往往只有元数据，凭空建的空项目只会把侧栏塞满。
2. **收获文档自动沉淀为知识卡片**。``build_sync_cards()`` + ``sync_cards()``：
   把《读书收获》里的自测题回流进 ``cards`` 表。机制**照搬**
   ``core/knowledge_doc.py`` 那套（稳定 card_id + upsert + 回收），
   所以 FSRS 排期不会因为「重新生成文档」而丢。

## 为什么回收只按前缀、不按节点

知识点文档的回收条件是「前缀 + node_ids 含本节点」，因为一个项目里有多个节点。
**读书不一样：一本书就是一个项目**，项目里所有 ``rd_`` 开头的卡都来自这本书的
那一份收获文档。所以按项目 + 前缀认领就够了，不需要节点这一维。

## 存储形态

独立连接 + ``busy_timeout`` + 懒建表，与 ``core/study_kit.py`` 同一模式 ——
不往 ``projects`` / ``cards`` 里塞读书专有字段，那两张表各有自己的语义。
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator

from core.reading_digest import DIGEST_SELF_CHECK_SECTION

SCHEMA = """
CREATE TABLE IF NOT EXISTS reading_books (
    book_key        TEXT PRIMARY KEY,
    owner_id        TEXT NOT NULL,
    project_id      TEXT NOT NULL DEFAULT '',
    source          TEXT NOT NULL DEFAULT '',
    source_id       TEXT NOT NULL DEFAULT '',
    title           TEXT NOT NULL DEFAULT '',
    author          TEXT NOT NULL DEFAULT '',
    cover           TEXT NOT NULL DEFAULT '',
    category        TEXT NOT NULL DEFAULT '其他',
    language        TEXT NOT NULL DEFAULT '',
    year            TEXT NOT NULL DEFAULT '',
    detail_url      TEXT NOT NULL DEFAULT '',
    download_url    TEXT NOT NULL DEFAULT '',
    has_fulltext    INTEGER NOT NULL DEFAULT 0,
    fulltext_format TEXT NOT NULL DEFAULT '',
    rights          TEXT NOT NULL DEFAULT '',
    -- 「文件链接」：一本公版书常同时有 EPUB / AZW3 / 纯文本 / 在线阅读好几个入口。
    -- 只留 download_url 会把其余入口丢掉，所以整组存成 JSON。
    files_json      TEXT NOT NULL DEFAULT '',
    read_url        TEXT NOT NULL DEFAULT '',
    borrow_url      TEXT NOT NULL DEFAULT '',
    isbn            TEXT NOT NULL DEFAULT '',
    progress        INTEGER NOT NULL DEFAULT 0,
    reading_status  TEXT NOT NULL DEFAULT 'unread',
    total_seconds   INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reading_books_owner
    ON reading_books(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS reading_docs (
    doc_key      TEXT PRIMARY KEY,
    owner_id     TEXT NOT NULL,
    book_key     TEXT NOT NULL,
    project_id   TEXT NOT NULL DEFAULT '',
    kind         TEXT NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    signature    TEXT NOT NULL DEFAULT '',
    content_json TEXT NOT NULL DEFAULT '',
    content_md   TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reading_docs_book
    ON reading_docs(book_key, kind, updated_at DESC);
"""

# 文档种类。digest = 读书收获（可沉淀卡片），intro = 书籍介绍（纯展示）。
DOC_KINDS: tuple[str, ...] = ("digest", "intro")

DOC_KIND_LABELS: dict[str, str] = {
    "digest": "读书收获",
    "intro": "书籍介绍",
}

# ---- 卡片沉淀参数（与 knowledge_doc.py 同源，只是前缀与分类不同）----

SYNC_CATEGORY = "读书自测"
SYNC_CARD_PREFIX = "rd_"
SYNC_MAX_CARDS = 3
SYNC_MAX_FRONT = 400
SYNC_MAX_BACK = 700
SYNC_ORIGIN_SECTION = DIGEST_SELF_CHECK_SECTION


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# 增量迁移：`CREATE TABLE IF NOT EXISTS` 对**已存在的表**不会补新列，
# 所以老库升级后必须显式 ALTER。放在这里而不是散在 init 里，是为了下一个
# 加字段的人一眼看到「加列要同时改 SCHEMA 和这张表」。
_COLUMN_MIGRATIONS: tuple[tuple[str, str], ...] = (
    ("files_json", "TEXT NOT NULL DEFAULT ''"),
    ("read_url", "TEXT NOT NULL DEFAULT ''"),
    ("borrow_url", "TEXT NOT NULL DEFAULT ''"),
    ("isbn", "TEXT NOT NULL DEFAULT ''"),
)


def _dump_files(files: Any) -> str:
    """文件链接列表 → 存库用的 JSON 字符串。非法输入一律存空串（不写坏数据）。"""
    if not isinstance(files, (list, tuple)):
        return ""
    clean = [item for item in files if isinstance(item, dict) and item.get("url")]
    if not clean:
        return ""
    try:
        return json.dumps(clean, ensure_ascii=False)[:4000]
    except Exception:
        return ""


def _row_to_book(row: sqlite3.Row | dict[str, Any] | None) -> dict[str, Any]:
    """把库里的行转成对外的书字典。

    ``files_json`` 是给 SQLite 存的形态，对外一律还原成 ``files`` 列表 ——
    上层（API / 前端）不应该知道「它其实是个 JSON 字符串」。
    """
    if not row:
        return {}
    book = dict(row)
    raw = book.pop("files_json", "")
    files: list[dict[str, Any]] = []
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                files = [item for item in parsed if isinstance(item, dict)]
        except Exception:
            files = []
    book["files"] = files
    return book


def normalize_kind(value: Any) -> str:
    text = str(value or "").strip().lower()
    return text if text in DOC_KINDS else "digest"


def book_key_for(source: Any, source_id: Any) -> str:
    """书的稳定键。用「源 + 源内 id」，跨设备/跨会话都指向同一本书。

    不用书名 —— 同名书（重印版、译本）会撞在一起，把两本书的笔记混成一锅。
    """
    raw = "|".join([str(source or "").strip().lower(), str(source_id or "").strip()])
    if raw == "|":
        return ""
    return hashlib.sha1(raw.encode("utf-8", "replace")).hexdigest()[:24]


def _clip(value: Any, limit: int) -> str:
    text = str(value or "").strip()
    return text if len(text) <= limit else text[:limit]


# --------------------------------------------------------------------------
# 卡片沉淀：纯函数部分（不碰数据库）
# --------------------------------------------------------------------------


def check_card_id(book_key: str, question: str) -> str:
    """由「书 + 题面」派生的稳定卡片 id。

    稳定性是硬要求：同一道题重新生成收获文档时必须复用同一个 card_id，
    否则 FSRS 排期（``card_srs_state`` 按 card_id 关联）与已有复习记录会丢，
    用户的复习进度凭空归零。题面进哈希，所以改了题目就是新卡、是新排期 —— 这是对的。
    """
    digest = hashlib.sha1(
        "|".join([str(book_key), str(question)]).encode("utf-8", "replace")
    ).hexdigest()
    return f"{SYNC_CARD_PREFIX}{digest[:20]}"


def build_sync_cards(
    result: dict[str, Any],
    *,
    book_key: str,
    source_ids: Iterable[str] = (),
) -> list[dict[str, Any]]:
    """从收获文档的 ``self_check`` 抽出要回流的卡片。纯函数，不碰数据库。

    只取有题有答的条目；同一份结果里题面重复的只留第一张（模型偶尔会把同一题
    写两遍，那会在复习队列里变成两张一样的卡）。
    """
    if not isinstance(result, dict):
        return []
    checks = result.get("self_check")
    if not isinstance(checks, list):
        return []
    src = [str(item) for item in source_ids if str(item or "").strip()][:8]
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in checks:
        if len(out) >= SYNC_MAX_CARDS:
            break
        if not isinstance(item, dict):
            continue
        front = _clip(item.get("question"), SYNC_MAX_FRONT)
        back = _clip(item.get("answer"), SYNC_MAX_BACK)
        if not front or not back or front in seen:
            continue
        seen.add(front)
        out.append(
            {
                "card_id": check_card_id(book_key, front),
                "front": front,
                "back": back,
                "category": SYNC_CATEGORY,
                "difficulty": 2,
                "source_ids": src,
                "node_ids": [],
                "origin_section": SYNC_ORIGIN_SECTION,
            }
        )
    return out


def sync_cards(
    database: Any,
    project_id: str,
    *,
    wanted: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    """把收获文档的回流卡与 ``cards`` 表对齐（upsert + 回收）。返回本次的增减。

    只认 ``SYNC_CARD_PREFIX`` 开头的卡，所以用户手工建的卡、别处生成的卡都碰不到。
    upsert 而不是「先删后插」：card_id 稳定，替换后 FSRS 排期仍在
    （``card_srs_state`` 是独立表），用户的复习进度得以保留。
    """
    items = [item for item in wanted if isinstance(item, dict)]
    kept: list[str] = []
    updated = 0
    for item in items:
        card_id = str(item.get("card_id") or "")
        if not card_id:
            continue
        if database.upsert_card(project_id, item):
            updated += 1
        kept.append(card_id)
    keep_ids = set(kept)

    # 回收：本项目里、带前缀、但这次没再出现的卡（例如模型这次少写了一道题）。
    # 一本书就是一个项目，所以按项目 + 前缀认领即可，不需要节点这一维。
    removed = 0
    for card in database.list_cards(project_id):
        card_id = str(getattr(card, "card_id", "") or "")
        if not card_id.startswith(SYNC_CARD_PREFIX) or card_id in keep_ids:
            continue
        database.delete_card(project_id, card_id)
        removed += 1

    return {"synced": len(kept), "updated": updated, "removed": removed, "card_ids": kept}


# --------------------------------------------------------------------------
# Store
# --------------------------------------------------------------------------


class ReadingStore:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        if str(path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._conn.execute("PRAGMA busy_timeout = 5000")
        self.init_schema()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        try:
            yield self._conn
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise

    def init_schema(self) -> None:
        with self.transaction() as conn:
            conn.executescript(SCHEMA)
            # 老库补列（新库在 SCHEMA 里已经有了，这里查一遍就不会重复加）
            present = {row["name"] for row in conn.execute("PRAGMA table_info(reading_books)")}
            for column, ddl in _COLUMN_MIGRATIONS:
                if column not in present:
                    conn.execute(f"ALTER TABLE reading_books ADD COLUMN {column} {ddl}")

    # ---- 书 ----

    def upsert_book(self, owner_id: str, record: dict[str, Any]) -> dict[str, Any] | None:
        """登记/更新一本书。``record`` 是 ``core/book_sources.py`` 归一化出来的记录。

        已有记录的 ``project_id`` / ``progress`` / ``reading_status`` **不被覆盖** ——
        这些是用户状态，重扫书架不该把它们清掉。
        """
        if not isinstance(record, dict):
            return None
        book_key = book_key_for(record.get("source"), record.get("source_id"))
        if not book_key:
            return None
        now = _now()
        existing = self.get_book(owner_id, book_key)
        project_id = existing.get("project_id", "") if existing else ""
        progress = int(existing.get("progress", 0)) if existing else int(record.get("progress") or 0)
        status = existing.get("reading_status", "unread") if existing else "unread"
        created = existing.get("created_at", now) if existing else now

        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO reading_books (book_key, owner_id, project_id, source, source_id, title,"
                " author, cover, category, language, year, detail_url, download_url, has_fulltext,"
                " fulltext_format, rights, files_json, read_url, borrow_url, isbn,"
                " progress, reading_status, total_seconds, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(book_key) DO UPDATE SET"
                "  title=excluded.title, author=excluded.author, cover=excluded.cover,"
                "  category=excluded.category, language=excluded.language, year=excluded.year,"
                "  detail_url=excluded.detail_url, download_url=excluded.download_url,"
                "  has_fulltext=excluded.has_fulltext, fulltext_format=excluded.fulltext_format,"
                "  rights=excluded.rights, files_json=excluded.files_json,"
                "  read_url=excluded.read_url, borrow_url=excluded.borrow_url, isbn=excluded.isbn,"
                "  updated_at=excluded.updated_at",
                (
                    book_key, owner_id, project_id,
                    _clip(record.get("source"), 40), _clip(record.get("source_id"), 120),
                    _clip(record.get("title"), 200), _clip(record.get("author"), 160),
                    _clip(record.get("cover"), 500), _clip(record.get("category"), 40) or "其他",
                    _clip(record.get("language"), 40), _clip(record.get("year"), 20),
                    _clip(record.get("detail_url"), 600), _clip(record.get("download_url"), 600),
                    1 if record.get("has_fulltext") else 0,
                    _clip(record.get("fulltext_format"), 16), _clip(record.get("rights"), 30),
                    _dump_files(record.get("files")),
                    _clip(record.get("read_url"), 600), _clip(record.get("borrow_url"), 600),
                    _clip(record.get("isbn"), 60),
                    max(0, min(progress, 100)), status, int(existing.get("total_seconds", 0)) if existing else 0,
                    created, now,
                ),
            )
        return self.get_book(owner_id, book_key)

    def get_book(self, owner_id: str, book_key: str) -> dict[str, Any]:
        row = self._conn.execute(
            "SELECT * FROM reading_books WHERE owner_id = ? AND book_key = ?",
            (owner_id, book_key),
        ).fetchone()
        return _row_to_book(row)

    def list_books(self, owner_id: str, *, category: str = "") -> list[dict[str, Any]]:
        if category:
            rows = self._conn.execute(
                "SELECT * FROM reading_books WHERE owner_id = ? AND category = ?"
                " ORDER BY updated_at DESC",
                (owner_id, category),
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT * FROM reading_books WHERE owner_id = ? ORDER BY updated_at DESC",
                (owner_id,),
            ).fetchall()
        return [_row_to_book(row) for row in rows]

    def attach_project(self, owner_id: str, book_key: str, project_id: str) -> None:
        with self.transaction() as conn:
            conn.execute(
                "UPDATE reading_books SET project_id = ?, updated_at = ?"
                " WHERE owner_id = ? AND book_key = ?",
                (project_id, _now(), owner_id, book_key),
            )

    def update_progress(
        self, owner_id: str, book_key: str, *, progress: int | None = None, status: str = ""
    ) -> None:
        sets: list[str] = ["updated_at = ?"]
        params: list[Any] = [_now()]
        if progress is not None:
            sets.append("progress = ?")
            params.append(max(0, min(int(progress), 100)))
        if status:
            sets.append("reading_status = ?")
            params.append(_clip(status, 20))
        params.extend([owner_id, book_key])
        with self.transaction() as conn:
            conn.execute(
                f"UPDATE reading_books SET {', '.join(sets)} WHERE owner_id = ? AND book_key = ?",
                params,
            )

    def mark_fulltext(self, owner_id: str, book_key: str, fmt: str = "") -> dict[str, Any]:
        """把一本书标记为「已导入正文」。

        微信读书只给元数据与划线，**给不了正文**；用户想在这本书里读原文，
        唯一的合法路径是把自备的 EPUB / PDF / TXT 传进它自己的项目。
        传完要在这里落一个标记，书架卡片的「全文」徽标与阅读页才知道正文已经有了 ——
        否则用户明明导入了，界面还写着「仅元数据」。
        """
        with self.transaction() as conn:
            conn.execute(
                "UPDATE reading_books SET has_fulltext = 1, fulltext_format = ?, updated_at = ?"
                " WHERE owner_id = ? AND book_key = ?",
                (_clip(fmt, 16), _now(), owner_id, book_key),
            )
        return self.get_book(owner_id, book_key)

    def ensure_project(
        self,
        owner_id: str,
        book_key: str,
        *,
        create_project: Callable[[str], str],
    ) -> str:
        """**按需建项目**：没有就建一个，已绑定就直接返回。

        ⚠️ **别在「加入书架」时调它** —— 刚加入的书往往只有元数据、没有资料，
        建出来的空项目只会把侧栏塞满。只在真的要往项目里放东西时调
        （导入 / 取回正文、生成收获沉淀卡片）。

        ``create_project(title) -> project_id`` 由调用方注入 —— store 不直接依赖
        ``Database``，这样它能被单独测试，也不会和主库的连接纠缠在一起。
        """
        book = self.get_book(owner_id, book_key)
        if not book:
            return ""
        existing = str(book.get("project_id") or "")
        if existing:
            return existing
        project_id = str(create_project(book.get("title") or "未命名") or "")
        if project_id:
            self.attach_project(owner_id, book_key, project_id)
        return project_id

    # ---- 文档 ----

    def save_doc(
        self,
        *,
        owner_id: str,
        book_key: str,
        kind: str,
        title: str,
        result: dict[str, Any],
        content_md: str,
        signature: str = "",
        project_id: str = "",
    ) -> dict[str, Any]:
        """同一「书 + kind」只留最新一份 —— 收获是「当前版本」，不是流水账。"""
        normalized = normalize_kind(kind)
        doc_key = hashlib.sha1(
            "|".join([str(owner_id), str(book_key), normalized]).encode("utf-8", "replace")
        ).hexdigest()
        now = _now()
        payload = json.dumps(result if isinstance(result, dict) else {}, ensure_ascii=False)
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO reading_docs (doc_key, owner_id, book_key, project_id, kind, title,"
                " signature, content_json, content_md, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(doc_key) DO UPDATE SET"
                "  title=excluded.title, signature=excluded.signature,"
                "  content_json=excluded.content_json, content_md=excluded.content_md,"
                "  project_id=excluded.project_id, updated_at=excluded.updated_at",
                (
                    doc_key, owner_id, book_key, project_id, normalized,
                    _clip(title, 200), _clip(signature, 200), payload, str(content_md or ""), now, now,
                ),
            )
        return self.get_doc(owner_id, book_key, normalized)

    def get_doc(self, owner_id: str, book_key: str, kind: str = "digest") -> dict[str, Any]:
        doc_key = hashlib.sha1(
            "|".join([str(owner_id), str(book_key), normalize_kind(kind)]).encode("utf-8", "replace")
        ).hexdigest()
        row = self._conn.execute(
            "SELECT * FROM reading_docs WHERE owner_id = ? AND doc_key = ?",
            (owner_id, doc_key),
        ).fetchone()
        if not row:
            return {}
        item = dict(row)
        try:
            item["content"] = json.loads(item.get("content_json") or "{}")
        except Exception:
            item["content"] = {}
        return item

    def save_markdown(self, owner_id: str, book_key: str, content_md: str, kind: str = "digest") -> dict[str, Any]:
        """只改正文，结构化留档（``content_json``）与指纹不动 —— 与知识点文档同规矩。"""
        text = str(content_md or "")
        if not text.strip():
            raise ValueError("正文不能为空")
        normalized = normalize_kind(kind)
        doc_key = hashlib.sha1(
            "|".join([str(owner_id), str(book_key), normalized]).encode("utf-8", "replace")
        ).hexdigest()
        with self.transaction() as conn:
            conn.execute(
                "UPDATE reading_docs SET content_md = ?, updated_at = ? WHERE owner_id = ? AND doc_key = ?",
                (text, _now(), owner_id, doc_key),
            )
        return self.get_doc(owner_id, book_key, normalized)

    def delete_doc(self, owner_id: str, book_key: str, kind: str = "digest") -> None:
        doc_key = hashlib.sha1(
            "|".join([str(owner_id), str(book_key), normalize_kind(kind)]).encode("utf-8", "replace")
        ).hexdigest()
        with self.transaction() as conn:
            conn.execute(
                "DELETE FROM reading_docs WHERE owner_id = ? AND doc_key = ?", (owner_id, doc_key)
            )
