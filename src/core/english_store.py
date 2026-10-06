"""英语词汇 · 持久化层：自带连接与 ``en_*`` 表，与既有数据表完全解耦。

为什么单独一个模块而不是塞进 ``core/database.py``：
  * 既有 ``Database`` 有 2600 行、服务着整个产品，往里面加 11 张表会让 diff 无法评审；
  * 英语词汇是**用户级**的横向功能（跨项目），与"项目 → 资料 → 节点"那套主链路
    没有外键关系，硬挂在同一个类里只会制造耦合；
  * 表名统一 ``en_`` 前缀，**不碰** cards / learning_events / framework_nodes，
    因此这个功能上线不会改变任何既有用户的掌握度与打卡曲线。

连接策略：与 ``Database`` 一致（同一份 sqlite 文件、``check_same_thread=False``、
外键开启），另外设 ``busy_timeout`` —— 两个连接并发写同一个文件时，默认行为是
直接抛 "database is locked"，加超时后可以自动重试。
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator

from .database import new_id, utc_now
from .english_vocab import (
    DEFAULT_RETENTION,
    SrsState,
    parse_iso,
    to_iso,
)

# 「已掌握」的门槛：稳定性 ≥ 21 天。
# 为什么不用 reps>=3：一个词在 30 秒内连点四次"认识"也会满足 reps>=3，
# 把它算作已掌握会让进度条立刻虚高，用户三天后就发现是假的。
MASTERED_STABILITY = 21.0

# 每日新词默认上限。新词和到期复习分开配额：复习是「必须还的债」，
# 新词是「今天想借多少新的」，混在一起排会让某天复习爆量直接劝退。
DEFAULT_NEW_PER_DAY = 15

SCHEMA = """
CREATE TABLE IF NOT EXISTS en_decks (
    deck_id     TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL,
    name        TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_ref  TEXT,
    meta_json   TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS en_decks_owner ON en_decks(owner_id);

CREATE TABLE IF NOT EXISTS en_words (
    word_id      TEXT PRIMARY KEY,
    deck_id      TEXT NOT NULL REFERENCES en_decks(deck_id) ON DELETE CASCADE,
    lemma        TEXT NOT NULL,
    surface      TEXT,
    phonetic     TEXT,
    pos          TEXT,
    meaning      TEXT NOT NULL,
    meaning_en   TEXT,
    roots_json   TEXT NOT NULL DEFAULT '[]',
    tags         TEXT,
    collins      INTEGER NOT NULL DEFAULT 0,
    oxford       INTEGER NOT NULL DEFAULT 0,
    frq          INTEGER NOT NULL DEFAULT 0,
    source       TEXT NOT NULL DEFAULT 'ecdict',
    created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS en_words_deck_lemma ON en_words(deck_id, lemma);
CREATE INDEX IF NOT EXISTS en_words_deck ON en_words(deck_id, word_id);

CREATE TABLE IF NOT EXISTS en_contexts (
    ctx_id       TEXT PRIMARY KEY,
    word_id      TEXT NOT NULL REFERENCES en_words(word_id) ON DELETE CASCADE,
    text         TEXT NOT NULL,
    cloze        TEXT,
    translation  TEXT,
    source_title TEXT,
    source_url   TEXT,
    ordinal      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS en_contexts_word ON en_contexts(word_id);

CREATE TABLE IF NOT EXISTS en_srs_state (
    word_id       TEXT NOT NULL REFERENCES en_words(word_id) ON DELETE CASCADE,
    owner_id      TEXT NOT NULL,
    stability     REAL NOT NULL DEFAULT 0,
    difficulty    REAL NOT NULL DEFAULT 0,
    due_at        TEXT NOT NULL,
    reps          INTEGER NOT NULL DEFAULT 0,
    lapses        INTEGER NOT NULL DEFAULT 0,
    state         TEXT NOT NULL DEFAULT 'new',
    last_rating   INTEGER,
    last_review   TEXT,
    updated_at    TEXT NOT NULL,
    PRIMARY KEY (word_id, owner_id)
);
CREATE INDEX IF NOT EXISTS en_srs_due ON en_srs_state(owner_id, due_at);

CREATE TABLE IF NOT EXISTS en_reviews (
    rev_id      TEXT PRIMARY KEY,
    word_id     TEXT NOT NULL REFERENCES en_words(word_id) ON DELETE CASCADE,
    owner_id    TEXT NOT NULL,
    rating      INTEGER NOT NULL,
    reviewed_at TEXT NOT NULL,
    elapsed_ms  INTEGER
);
CREATE INDEX IF NOT EXISTS en_reviews_owner ON en_reviews(owner_id, reviewed_at);

CREATE TABLE IF NOT EXISTS en_known_words (
    owner_id   TEXT NOT NULL,
    lemma      TEXT NOT NULL,
    origin     TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, lemma)
);

CREATE TABLE IF NOT EXISTS en_prefs (
    owner_id   TEXT PRIMARY KEY,
    exam_goals TEXT NOT NULL DEFAULT '["cet6"]',
    daily_goal INTEGER NOT NULL DEFAULT 20,
    new_per_day INTEGER NOT NULL DEFAULT 15,
    retention  REAL NOT NULL DEFAULT 0.9,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS en_candidates (
    cand_id    TEXT PRIMARY KEY,
    owner_id   TEXT NOT NULL,
    lemma      TEXT NOT NULL,
    surface    TEXT,
    freq       INTEGER NOT NULL DEFAULT 1,
    source_ids TEXT NOT NULL DEFAULT '[]',
    sample     TEXT,
    gain       REAL,
    exam_tags  TEXT,
    suggested  TEXT,
    status     TEXT NOT NULL DEFAULT 'new',
    created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS en_cand_owner_lemma ON en_candidates(owner_id, lemma);
CREATE INDEX IF NOT EXISTS en_cand_status ON en_candidates(owner_id, status);

CREATE TABLE IF NOT EXISTS en_scan_state (
    source_id    TEXT NOT NULL,
    owner_id     TEXT NOT NULL,
    content_hash TEXT NOT NULL DEFAULT '',
    scanned_at   TEXT NOT NULL,
    word_hits    INTEGER NOT NULL DEFAULT 0,
    coverage     REAL,
    PRIMARY KEY (source_id, owner_id)
);

CREATE TABLE IF NOT EXISTS en_passages (
    passage_id   TEXT PRIMARY KEY,
    owner_id     TEXT,
    title        TEXT NOT NULL,
    body         TEXT NOT NULL,
    level        TEXT,
    topic        TEXT,
    origin       TEXT NOT NULL DEFAULT 'builtin',
    source_url   TEXT,
    license_note TEXT,
    word_count   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS en_passages_owner ON en_passages(owner_id);

CREATE TABLE IF NOT EXISTS en_feed_sources (
    feed_id      TEXT PRIMARY KEY,
    owner_id     TEXT,
    name         TEXT NOT NULL,
    kind         TEXT NOT NULL,
    url          TEXT NOT NULL,
    license_note TEXT,
    enabled      INTEGER NOT NULL DEFAULT 1,
    last_fetched_at TEXT
);

-- 词义拓展（例句/近义/反义/常见搭配）缓存。形近词由本地词典现算，不进这张表。
-- 按 (owner_id, lemma) 缓存：生成要花一次模型调用，同一用户反复背同一个词
-- 不能反复烧 token；不同用户各自缓存，避免任何跨用户的数据可见性。
CREATE TABLE IF NOT EXISTS en_word_extras (
    owner_id     TEXT NOT NULL,
    lemma        TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    origin       TEXT NOT NULL DEFAULT 'ai',
    created_at   TEXT NOT NULL,
    PRIMARY KEY (owner_id, lemma)
);

-- 语料摘录：从用户自己导入的资料里摘出来、统一用英文表述的可学片段。
-- 这是「词从哪来」的主渠道（内置词表只是兜底），所以单独一张表：
-- 一份资料摘出多片、每片带自己的术语表，是一对多，塞进 en_candidates 会把它
-- 撑成两用表。lang 记原文语言（zh/en/mixed）；origin_text 存原文，english_text
-- 存英文表述——英文资料两者相同，中文资料由模型转写。
CREATE TABLE IF NOT EXISTS en_corpus_excerpts (
    excerpt_id   TEXT PRIMARY KEY,
    owner_id     TEXT NOT NULL,
    source_id    TEXT NOT NULL,
    source_title TEXT NOT NULL DEFAULT '',
    lang         TEXT NOT NULL DEFAULT 'en',
    ordinal      INTEGER NOT NULL DEFAULT 0,
    origin_text  TEXT NOT NULL,
    english_text TEXT NOT NULL,
    gist         TEXT NOT NULL DEFAULT '',
    terms_json   TEXT NOT NULL DEFAULT '[]',
    created_at   TEXT NOT NULL,
    -- 整理版中文原文（模型产出）：中文资料的 origin_text 是 PDF 抽取的残稿，
    -- 缺字又带乱码；这一栏是模型照原意补顺、分段清晰的中文，仅供对照阅读。
    -- 空串表示「还没有整理稿」，前端退回显示 origin_text。
    origin_clean TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS en_corpus_owner ON en_corpus_excerpts(owner_id);
-- 重扫同一份资料时按来源整体替换，靠这个索引定位旧片
CREATE INDEX IF NOT EXISTS en_corpus_source ON en_corpus_excerpts(owner_id, source_id);
"""


class EnglishStore:
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
        self._migrate()

    def _migrate(self) -> None:
        """老库补列：`CREATE TABLE IF NOT EXISTS` 不会给已存在的表加字段。

        SQLite 没有 ADD COLUMN IF NOT EXISTS，只能先读 PRAGMA 再决定改不改。
        """
        columns = {row["name"] for row in self._conn.execute("PRAGMA table_info(en_prefs)")}
        if columns and "new_per_day" not in columns:
            with self.transaction() as conn:
                conn.execute(
                    "ALTER TABLE en_prefs ADD COLUMN new_per_day INTEGER NOT NULL DEFAULT 15"
                )

        # 语料摘录的「整理版中文原文」：PDF 抽取的中文原文满地乱码、还缺字，
        # 模型转写时顺手交一版通顺完整的中文整理稿，中文原文对照栏优先显示它。
        # 真原文 origin_text 一条不删——那是出处锚点，也是整理稿失效时的退路。
        corpus_columns = {
            row["name"] for row in self._conn.execute("PRAGMA table_info(en_corpus_excerpts)")
        }
        if corpus_columns and "origin_clean" not in corpus_columns:
            with self.transaction() as conn:
                conn.execute(
                    "ALTER TABLE en_corpus_excerpts ADD COLUMN origin_clean TEXT NOT NULL DEFAULT ''"
                )

    def close(self) -> None:
        try:
            self._conn.close()
        except sqlite3.Error:
            pass

    # ================================================================ 词库

    def create_deck(
        self,
        owner_id: str,
        name: str,
        source_kind: str,
        *,
        source_ref: str | None = None,
        meta: dict | None = None,
    ) -> dict:
        deck_id = new_id("deck")
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO en_decks (deck_id, owner_id, name, source_kind, source_ref,"
                " meta_json, created_at) VALUES (?,?,?,?,?,?,?)",
                (
                    deck_id,
                    owner_id,
                    name.strip() or "未命名词库",
                    source_kind,
                    source_ref,
                    json.dumps(meta or {}, ensure_ascii=False),
                    to_iso(utc_now()),
                ),
            )
        return self.get_deck(owner_id, deck_id) or {}

    def get_deck(self, owner_id: str, deck_id: str) -> dict | None:
        row = self._conn.execute(
            "SELECT * FROM en_decks WHERE deck_id = ? AND owner_id = ?",
            (deck_id, owner_id),
        ).fetchone()
        return self._deck_row(row) if row else None

    def find_deck_by_ref(self, owner_id: str, source_kind: str, source_ref: str) -> dict | None:
        row = self._conn.execute(
            "SELECT * FROM en_decks WHERE owner_id = ? AND source_kind = ? AND source_ref = ?"
            " ORDER BY created_at DESC LIMIT 1",
            (owner_id, source_kind, source_ref),
        ).fetchone()
        return self._deck_row(row) if row else None

    def list_decks(self, owner_id: str) -> list[dict]:
        rows = self._conn.execute(
            "SELECT d.*,"
            " (SELECT COUNT(*) FROM en_words w WHERE w.deck_id = d.deck_id) AS total,"
            " (SELECT COUNT(*) FROM en_srs_state s JOIN en_words w2 ON w2.word_id = s.word_id"
            "    WHERE w2.deck_id = d.deck_id AND s.owner_id = d.owner_id AND s.reps > 0) AS touched,"
            " (SELECT COUNT(*) FROM en_srs_state s JOIN en_words w3 ON w3.word_id = s.word_id"
            "    WHERE w3.deck_id = d.deck_id AND s.owner_id = d.owner_id"
            "      AND s.state = 'review' AND s.reps >= 3 AND s.stability >= ?) AS mastered"
            " FROM en_decks d WHERE d.owner_id = ? ORDER BY d.created_at DESC",
            (MASTERED_STABILITY, owner_id),
        ).fetchall()
        return [self._deck_row(row, extra=True) for row in rows]

    def delete_deck(self, owner_id: str, deck_id: str) -> bool:
        # 先取快照供撤销使用，再删（外键级联会清掉 en_words / en_srs_state）
        deck = self.get_deck(owner_id, deck_id)
        if not deck:
            return False
        words = self.list_words(owner_id, deck_id, limit=100000)
        deck["words"] = words
        with self.transaction() as conn:
            conn.execute(
                "DELETE FROM en_decks WHERE deck_id = ? AND owner_id = ?", (deck_id, owner_id)
            )
            conn.execute(
                "DELETE FROM en_srs_state WHERE owner_id = ? AND word_id NOT IN"
                " (SELECT word_id FROM en_words)",
                (owner_id,),
            )
        self._last_deleted = deck
        return True

    # ================================================================ 词条

    def add_words(
        self,
        owner_id: str,
        deck_id: str,
        entries: Iterable[dict],
        *,
        source: str = "ecdict",
        now: datetime | None = None,
    ) -> int:
        """批量写入词条，并为每一条建一个「立刻到期」的调度状态。

        新词 `due_at = now`，所以用户刚建完词库就能直接开始复习，不需要额外
        "开始学习"动作 —— 少一步操作，少一个用户流失点。

        `now` 可注入：一是让单测能脱离真实时钟做确定断言，二是未来支持
        "把词库排到明天开始"这类需求时不用改结构。
        """
        stamp = to_iso(now or utc_now())
        inserted = 0
        with self.transaction() as conn:
            for entry in entries:
                lemma = (entry.get("lemma") or entry.get("word") or "").strip().lower()
                if not lemma:
                    continue
                word_id = new_id("w")
                cursor = conn.execute(
                    "INSERT OR IGNORE INTO en_words (word_id, deck_id, lemma, surface, phonetic,"
                    " pos, meaning, meaning_en, roots_json, tags, collins, oxford, frq, source,"
                    " created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        word_id,
                        deck_id,
                        lemma,
                        entry.get("surface") or entry.get("word") or lemma,
                        entry.get("phonetic") or "",
                        entry.get("pos") or "",
                        entry.get("meaning") or entry.get("translation") or "",
                        entry.get("meaning_en") or "",
                        json.dumps(entry.get("roots") or [], ensure_ascii=False),
                        entry.get("tags") or entry.get("tag") or "",
                        int(entry.get("collins") or 0),
                        int(entry.get("oxford") or 0),
                        int(entry.get("frq") or 0),
                        source,
                        stamp,
                    ),
                )
                if cursor.rowcount <= 0:
                    continue          # (deck_id, lemma) 已存在，跳过
                inserted += 1
                conn.execute(
                    "INSERT OR REPLACE INTO en_srs_state (word_id, owner_id, stability,"
                    " difficulty, due_at, reps, lapses, state, updated_at)"
                    " VALUES (?,?,0,0,?,0,0,'new',?)",
                    (word_id, owner_id, stamp, stamp),
                )
        return inserted

    def deck_word_count(self, deck_id: str) -> int:
        row = self._conn.execute(
            "SELECT COUNT(*) AS c FROM en_words WHERE deck_id = ?", (deck_id,)
        ).fetchone()
        return int(row["c"] or 0)

    def delete_word(self, owner_id: str, word_id: str) -> bool:
        """把单个词从词库里移出（用于「这个词我已经会了」）。

        属主校验在这里做：别人的 word_id 一律当不存在。外键级联会带走
        en_contexts，en_srs_state 要手动清（它没有指向 deck 的外键）。
        """
        word = self.get_word(owner_id, word_id)
        if not word:
            return False
        with self.transaction() as conn:
            conn.execute(
                "DELETE FROM en_srs_state WHERE owner_id = ? AND word_id = ?",
                (owner_id, word_id),
            )
            conn.execute("DELETE FROM en_words WHERE word_id = ?", (word_id,))
        return True

    def delete_words_bulk(
        self, owner_id: str, word_ids: list[str], *, mark_known: bool = False
    ) -> int:
        """批量把词移出生词本（「筛熟词」用），并可选标成已认识。

        属主校验逐个做：不是自己的 word_id 一律跳过，不报错、不泄露存在性。
        """
        if not word_ids:
            return 0
        now = to_iso(utc_now())
        removed = 0
        with self.transaction() as conn:
            for wid in word_ids:
                row = conn.execute(
                    "SELECT d.owner_id AS owner_id, w.lemma AS lemma FROM en_words w"
                    " JOIN en_decks d ON d.deck_id = w.deck_id WHERE w.word_id = ?",
                    (wid,),
                ).fetchone()
                if not row or row["owner_id"] != owner_id:
                    continue
                conn.execute(
                    "DELETE FROM en_srs_state WHERE owner_id = ? AND word_id = ?",
                    (owner_id, wid),
                )
                conn.execute("DELETE FROM en_words WHERE word_id = ?", (wid,))
                if mark_known:
                    conn.execute(
                        "INSERT OR IGNORE INTO en_known_words (owner_id, lemma, origin,"
                        " created_at) VALUES (?,?,?,?)",
                        (owner_id, row["lemma"], "bulk", now),
                    )
                removed += 1
        return removed

    def auto_deck(self, owner_id: str) -> dict:
        """取（或建）「自动生词本」：手动加词与候选词收录共用这一本。

        为什么不按来源分成很多本：生词本的意义是「我最近遇到的、还不认识的词」，
        拆成几十本只会让用户在词库列表里迷路。
        """
        deck = self.find_deck_by_ref(owner_id, "auto", "auto-pool")
        if deck:
            return deck
        return self.create_deck(owner_id, "自动生词本", "auto", source_ref="auto-pool")

    def deck_lemmas(self, deck_id: str) -> set[str]:
        """这本词库里已经有哪些 lemma（一次性取回，避免逐词查库）。

        语料列表要用它来标「这片里哪些术语已经在生词本里」：已收状态只有这样
        才是真的——前端内存里的记账一刷新就没了，换个入口收的词也认不出来。
        """
        rows = self._conn.execute(
            "SELECT lemma FROM en_words WHERE deck_id = ?", (deck_id,)
        ).fetchall()
        return {str(row["lemma"] or "") for row in rows}

    def find_word_id(self, deck_id: str, lemma: str) -> str | None:
        row = self._conn.execute(
            "SELECT word_id FROM en_words WHERE deck_id = ? AND lemma = ?", (deck_id, lemma)
        ).fetchone()
        return row["word_id"] if row else None

    def get_word(self, owner_id: str, word_id: str) -> dict | None:
        """按 id 取单个词条（带属主校验：别人的词一律当不存在）。"""
        row = self._conn.execute(
            "SELECT w.* FROM en_words w JOIN en_decks d ON d.deck_id = w.deck_id"
            " WHERE w.word_id = ? AND d.owner_id = ?",
            (word_id, owner_id),
        ).fetchone()
        return self._word_row(row) if row else None

    def list_words(
        self,
        owner_id: str,
        deck_id: str,
        *,
        offset: int = 0,
        limit: int = 200,
    ) -> list[dict]:
        rows = self._conn.execute(
            "SELECT w.*, s.stability, s.difficulty, s.due_at, s.reps, s.lapses, s.state AS srs_state"
            " FROM en_words w"
            " JOIN en_srs_state s ON s.word_id = w.word_id AND s.owner_id = ?"
            " WHERE w.deck_id = ? ORDER BY w.frq = 0, w.frq, w.lemma LIMIT ? OFFSET ?",
            (owner_id, deck_id, int(limit), int(offset)),
        ).fetchall()
        return [self._word_row(row) for row in rows]

    def add_context(self, word_id: str, **fields: Any) -> str:
        ctx_id = new_id("ctx")
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO en_contexts (ctx_id, word_id, text, cloze, translation,"
                " source_title, source_url, ordinal) VALUES (?,?,?,?,?,?,?,?)",
                (
                    ctx_id,
                    word_id,
                    fields.get("text") or "",
                    fields.get("cloze") or "",
                    fields.get("translation") or "",
                    fields.get("source_title") or "",
                    fields.get("source_url") or "",
                    int(fields.get("ordinal") or 0),
                ),
            )
        return ctx_id

    def contexts_of(self, word_id: str) -> list[dict]:
        rows = self._conn.execute(
            "SELECT * FROM en_contexts WHERE word_id = ? ORDER BY ordinal, ctx_id",
            (word_id,),
        ).fetchall()
        return [dict(row) for row in rows]

    # ================================================================ 复习

    # 同一个 lemma 在用户的多本词库里会有多条 en_words（唯一索引是 (deck_id, lemma)，
    # 不是用户级）。复习时只认其中一条「代表」，否则同一个词会被排进队列好几次 ——
    # 实测同一账号里 refraction 有 5 条词条，队列里就出现 5 次，而且评分只写一条，
    # 掌握度与进度条永远算不准。选取规则：到期最早优先，再按 word_id 稳定 tie-break。
    _REP_SELECT = (
        "SELECT t.word_id FROM ("
        " SELECT w.word_id AS word_id,"
        "   ROW_NUMBER() OVER (PARTITION BY w.lemma ORDER BY s.due_at ASC, w.word_id ASC) AS rn"
        " FROM en_words w JOIN en_srs_state s ON s.word_id = w.word_id"
        " WHERE s.owner_id = ?) t WHERE t.rn = 1"
    )

    def due_queue(
        self,
        owner_id: str,
        *,
        deck_id: str | None = None,
        limit: int = 20,
        now: datetime | None = None,
    ) -> list[dict]:
        """到期**复习**词（已学过 reps > 0），按 lemma 去重后按到期时间排序。"""
        stamp = to_iso(now or utc_now())
        # 占位符顺序 = SQL 里出现的顺序：外层 owner、到期时间，再是子查询里的 owner
        params: list[Any] = [owner_id, stamp, owner_id]
        clause = ""
        if deck_id:
            clause = " AND w.deck_id = ?"
            params.append(deck_id)
        params.append(int(limit))
        rows = self._conn.execute(
            "SELECT w.*, s.stability, s.difficulty, s.due_at, s.reps, s.lapses,"
            " s.state AS srs_state, s.last_review, d.name AS deck_name"
            " FROM en_srs_state s"
            " JOIN en_words w ON w.word_id = s.word_id"
            " JOIN en_decks d ON d.deck_id = w.deck_id"
            f" WHERE s.owner_id = ? AND s.reps > 0 AND s.due_at <= ?"
            f"   AND s.word_id IN ({self._REP_SELECT}){clause}"
            " ORDER BY s.due_at ASC, s.reps ASC LIMIT ?",
            params,
        ).fetchall()
        return [self._word_row(row) for row in rows]

    def new_queue(
        self,
        owner_id: str,
        *,
        deck_id: str | None = None,
        limit: int = 15,
    ) -> list[dict]:
        """没学过的新词（reps = 0），同样按 lemma 去重；高频词优先（frq 小的先学）。"""
        if limit <= 0:
            return []
        params: list[Any] = [owner_id, owner_id]
        clause = ""
        if deck_id:
            clause = " AND w.deck_id = ?"
            params.append(deck_id)
        params.append(int(limit))
        rows = self._conn.execute(
            "SELECT w.*, s.stability, s.difficulty, s.due_at, s.reps, s.lapses,"
            " s.state AS srs_state, s.last_review, d.name AS deck_name"
            " FROM en_srs_state s"
            " JOIN en_words w ON w.word_id = s.word_id"
            " JOIN en_decks d ON d.deck_id = w.deck_id"
            f" WHERE s.owner_id = ? AND s.reps = 0"
            f"   AND s.word_id IN ({self._REP_SELECT}){clause}"
            " ORDER BY w.frq = 0, w.frq, w.lemma LIMIT ?",
            params,
        ).fetchall()
        return [self._word_row(row) for row in rows]

    def count_new_today(self, owner_id: str, *, now: datetime | None = None) -> int:
        """今天第一次接触的词数（用「首次复习发生在今天」判定）。

        注意不能只看 en_reviews 今天的行数 —— 那会把复习也算成新词。
        """
        day = (now or utc_now()).astimezone(timezone.utc).strftime("%Y-%m-%d")
        row = self._conn.execute(
            "SELECT COUNT(DISTINCT word_id) AS c FROM en_reviews"
            " WHERE owner_id = ? AND substr(reviewed_at,1,10) = ?"
            "   AND word_id NOT IN ("
            "     SELECT word_id FROM en_reviews"
            "     WHERE owner_id = ? AND substr(reviewed_at,1,10) < ?)",
            (owner_id, day, owner_id, day),
        ).fetchone()
        return int(row["c"] or 0)

    def get_srs_state(self, owner_id: str, word_id: str) -> SrsState | None:
        row = self._conn.execute(
            "SELECT * FROM en_srs_state WHERE owner_id = ? AND word_id = ?",
            (owner_id, word_id),
        ).fetchone()
        if not row:
            return None
        return SrsState(
            stability=float(row["stability"] or 0),
            difficulty=float(row["difficulty"] or 0),
            reps=int(row["reps"] or 0),
            lapses=int(row["lapses"] or 0),
            state=row["state"] or "new",
            last_review=parse_iso(row["last_review"]),
        )

    def save_srs_state(
        self,
        owner_id: str,
        word_id: str,
        state: SrsState,
        due_at: datetime,
        *,
        rating: int | None = None,
        elapsed_ms: int | None = None,
    ) -> None:
        now = to_iso(utc_now())
        with self.transaction() as conn:
            conn.execute(
                "UPDATE en_srs_state SET stability = ?, difficulty = ?, due_at = ?, reps = ?,"
                " lapses = ?, state = ?, last_rating = ?, last_review = ?, updated_at = ?"
                " WHERE word_id = ? AND owner_id = ?",
                (
                    state.stability,
                    state.difficulty,
                    to_iso(due_at),
                    state.reps,
                    state.lapses,
                    state.state,
                    rating,
                    to_iso(state.last_review) if state.last_review else None,
                    now,
                    word_id,
                    owner_id,
                ),
            )
            if rating is not None:
                conn.execute(
                    "INSERT INTO en_reviews (rev_id, word_id, owner_id, rating, reviewed_at,"
                    " elapsed_ms) VALUES (?,?,?,?,?,?)",
                    (new_id("rev"), word_id, owner_id, int(rating), now, elapsed_ms),
                )
            # 把同一个词在别本词库里的孪生条目一起同步：不然用户从 A 词库背过的词，
            # 在 B 词库里还是「新词」，两边的掌握度也对不上。
            conn.execute(
                "UPDATE en_srs_state SET stability = ?, difficulty = ?, due_at = ?, reps = ?,"
                " lapses = ?, state = ?, last_rating = ?, last_review = ?, updated_at = ?"
                " WHERE owner_id = ? AND word_id != ? AND word_id IN ("
                "   SELECT w2.word_id FROM en_words w2"
                "   JOIN en_decks d2 ON d2.deck_id = w2.deck_id"
                "   WHERE d2.owner_id = ? AND w2.lemma ="
                "     (SELECT lemma FROM en_words WHERE word_id = ?))",
                (
                    state.stability,
                    state.difficulty,
                    to_iso(due_at),
                    state.reps,
                    state.lapses,
                    state.state,
                    rating,
                    to_iso(state.last_review) if state.last_review else None,
                    now,
                    owner_id,
                    word_id,
                    owner_id,
                    word_id,
                ),
            )

    def word_owner(self, word_id: str) -> str | None:
        """越权检查用：这个词属于谁。返回 None 表示词不存在 → 调用方回 404。"""
        row = self._conn.execute(
            "SELECT d.owner_id FROM en_words w JOIN en_decks d ON d.deck_id = w.deck_id"
            " WHERE w.word_id = ?",
            (word_id,),
        ).fetchone()
        return row["owner_id"] if row else None

    def stats(self, owner_id: str, *, now: datetime | None = None) -> dict:
        """按 **lemma 去重**统计：界面上「词库总量」说的是多少个词，不是多少条记录。

        同一词在多本词库各存一条，不去重的话总量会虚高好几倍（实测 4 个词算出 10）。
        """
        stamp = to_iso(now or utc_now())
        row = self._conn.execute(
            "WITH ranked AS ("
            "  SELECT s.due_at AS due_at, s.reps AS reps, s.state AS state,"
            "         s.stability AS stability,"
            "         ROW_NUMBER() OVER (PARTITION BY w.lemma"
            "           ORDER BY s.due_at ASC, w.word_id ASC) AS rn"
            "  FROM en_words w JOIN en_srs_state s ON s.word_id = w.word_id"
            "  WHERE s.owner_id = ?)"
            " SELECT"
            " COUNT(*) AS total,"
            " SUM(CASE WHEN due_at <= ? THEN 1 ELSE 0 END) AS due,"
            # due 把「还没学过的新词」也算进去了（新词建卡时 due_at 就在过去），
            # 但复习队列只收 reps>0 的词 —— 界面若拿 due 说「还剩 N 个到期词」会虚高
            # （实测：due=31、真正能刷的复习词=0）。due_review 才是「现在能接着刷的」。
            " SUM(CASE WHEN due_at <= ? AND reps > 0 THEN 1 ELSE 0 END) AS due_review,"
            " SUM(CASE WHEN reps > 0 THEN 1 ELSE 0 END) AS studied,"
            " SUM(CASE WHEN state = 'review' AND reps >= 3 AND stability >= ?"
            "          THEN 1 ELSE 0 END) AS mastered"
            " FROM ranked WHERE rn = 1",
            (owner_id, stamp, stamp, MASTERED_STABILITY),
        ).fetchone()
        total = int(row["total"] or 0)
        studied = int(row["studied"] or 0)
        return {
            "total": total,
            "due": int(row["due"] or 0),
            "due_review": int(row["due_review"] or 0),
            "studied": studied,
            "mastered": int(row["mastered"] or 0),
            "fresh": total - studied,
            "new_today": self.count_new_today(owner_id),
            "reviewed_today": self.reviewed_today(owner_id),
            "streak_days": self.streak_days(owner_id),
        }

    def reviewed_today(self, owner_id: str, *, now: datetime | None = None) -> int:
        day = (now or utc_now()).astimezone(timezone.utc).strftime("%Y-%m-%d")
        row = self._conn.execute(
            "SELECT COUNT(*) AS c FROM en_reviews WHERE owner_id = ? AND substr(reviewed_at,1,10) = ?",
            (owner_id, day),
        ).fetchone()
        return int(row["c"] or 0)

    def streak_days(self, owner_id: str, *, now: datetime | None = None) -> int:
        """英语自己的连续打卡天数。**刻意不写 learning_events** —— 英语复习不该
        冲淡知源主视图里"专业资料掌握度"的打卡口径。"""
        rows = self._conn.execute(
            "SELECT DISTINCT substr(reviewed_at,1,10) AS day FROM en_reviews"
            " WHERE owner_id = ? ORDER BY day DESC LIMIT 400",
            (owner_id,),
        ).fetchall()
        days = [r["day"] for r in rows if r["day"]]
        if not days:
            return 0
        from datetime import timedelta

        today = (now or utc_now()).astimezone(timezone.utc).date()
        cursor = today
        if days[0] != today.isoformat():
            cursor = today - timedelta(days=1)
        streak = 0
        pool = set(days)
        while cursor.isoformat() in pool:
            streak += 1
            cursor -= timedelta(days=1)
        return streak

    def review_history(
        self, owner_id: str, *, days: int = 30, tz_offset_minutes: int = 0
    ) -> list[dict]:
        """近 N 天每日复习词数（按用户本地时区归日）。

        界面画「记忆曲线」用。`en_reviews.reviewed_at` 存的是 UTC ISO 时间，
        直接 substr 取前 10 位得到的是 UTC 日期，与用户本地「今天」会差一个时区。
        所以把每条拉出来，按传入的时区偏移折算成本地日期再聚合 —— 量级是每个
        用户每天几十条、30 天几百条，Python 聚合足够快，不折腾 SQL 时区函数。
        """
        from datetime import timedelta

        offset = timedelta(minutes=int(tz_offset_minutes or 0))
        days = int(days)
        local_today = (datetime.now(timezone.utc) + offset).date()
        cutoff = (local_today - timedelta(days=days - 1)).isoformat()
        rows = self._conn.execute(
            "SELECT reviewed_at FROM en_reviews WHERE owner_id = ? AND reviewed_at >= ?",
            (owner_id, cutoff),
        ).fetchall()
        counts: dict[str, int] = {}
        for row in rows:
            dt = parse_iso(row["reviewed_at"])
            if dt is None:
                continue
            day = (dt + offset).date().isoformat()
            counts[day] = counts.get(day, 0) + 1
        out: list[dict] = []
        for i in range(days):
            day = (local_today - timedelta(days=days - 1 - i)).isoformat()
            out.append({"day": day, "count": counts.get(day, 0)})
        return out

    # ============================================================ 已知词 / 偏好

    def mark_known(self, owner_id: str, lemma: str, origin: str = "manual") -> None:
        key = (lemma or "").strip().lower()
        if not key:
            return
        with self.transaction() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO en_known_words (owner_id, lemma, origin, created_at)"
                " VALUES (?,?,?,?)",
                (owner_id, key, origin, to_iso(utc_now())),
            )

    def unmark_known(self, owner_id: str, lemma: str) -> None:
        with self.transaction() as conn:
            conn.execute(
                "DELETE FROM en_known_words WHERE owner_id = ? AND lemma = ?",
                (owner_id, (lemma or "").strip().lower()),
            )

    def known_set(self, owner_id: str) -> set[str]:
        rows = self._conn.execute(
            "SELECT lemma FROM en_known_words WHERE owner_id = ?", (owner_id,)
        ).fetchall()
        return {r["lemma"] for r in rows}

    def get_prefs(self, owner_id: str) -> dict:
        row = self._conn.execute(
            "SELECT * FROM en_prefs WHERE owner_id = ?", (owner_id,)
        ).fetchone()
        if not row:
            return {
                "exam_goals": ["cet6"],
                "daily_goal": 20,
                "new_per_day": DEFAULT_NEW_PER_DAY,
                "retention": DEFAULT_RETENTION,
            }
        try:
            goals = json.loads(row["exam_goals"])
        except json.JSONDecodeError:
            goals = ["cet6"]
        keys = row.keys()
        # 注意不能写 `row[x] or 默认值`：new_per_day 的合法值包含 0
        # （= 今天不学新词），0 会被 or 当成空值悄悄打回默认 15。
        new_per_day = row["new_per_day"] if "new_per_day" in keys else None
        daily_goal = row["daily_goal"]
        return {
            "exam_goals": goals if isinstance(goals, list) else ["cet6"],
            "daily_goal": int(daily_goal) if daily_goal is not None else 20,
            "new_per_day": int(new_per_day) if new_per_day is not None else DEFAULT_NEW_PER_DAY,
            "retention": float(row["retention"] or DEFAULT_RETENTION),
        }

    def set_prefs(
        self,
        owner_id: str,
        *,
        exam_goals: list[str] | None = None,
        daily_goal: int | None = None,
        new_per_day: int | None = None,
        retention: float | None = None,
    ) -> dict:
        current = self.get_prefs(owner_id)
        goals = exam_goals if exam_goals is not None else current["exam_goals"]
        goal = daily_goal if daily_goal is not None else current["daily_goal"]
        new_cap = new_per_day if new_per_day is not None else current["new_per_day"]
        keep = retention if retention is not None else current["retention"]
        goal = max(1, min(int(goal), 200))
        new_cap = max(0, min(int(new_cap), 200))
        keep = max(0.7, min(float(keep), 0.97))
        with self.transaction() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO en_prefs (owner_id, exam_goals, daily_goal,"
                " new_per_day, retention, updated_at) VALUES (?,?,?,?,?,?)",
                (
                    owner_id,
                    json.dumps(goals, ensure_ascii=False),
                    goal,
                    new_cap,
                    keep,
                    to_iso(utc_now()),
                ),
            )
        return self.get_prefs(owner_id)

    # ============================================================ 候选词（P2）

    def upsert_candidates(self, owner_id: str, items: Iterable[dict]) -> int:
        """把扫描出来的候选词并入候选池。同一 lemma 只累加词次与来源，不重复建条目。"""
        now = to_iso(utc_now())
        counts = 0
        with self.transaction() as conn:
            for item in items:
                lemma = (item.get("lemma") or "").strip().lower()
                if not lemma:
                    continue
                existing = conn.execute(
                    "SELECT cand_id, freq, source_ids FROM en_candidates"
                    " WHERE owner_id = ? AND lemma = ?",
                    (owner_id, lemma),
                ).fetchone()
                if existing:
                    merged = set(_json_list(existing["source_ids"]))
                    merged.update(item.get("source_ids") or [])
                    conn.execute(
                        "UPDATE en_candidates SET freq = freq + ?, source_ids = ?,"
                        " gain = MAX(COALESCE(gain,0), ?), sample = COALESCE(sample, ?),"
                        " exam_tags = COALESCE(?, exam_tags) WHERE cand_id = ?",
                        (
                            int(item.get("freq") or 1),
                            json.dumps(sorted(merged), ensure_ascii=False),
                            float(item.get("gain") or 0),
                            item.get("sample") or "",
                            item.get("exam_tags") or None,
                            existing["cand_id"],
                        ),
                    )
                    if existing["cand_id"]:
                        counts += 0
                else:
                    conn.execute(
                        "INSERT INTO en_candidates (cand_id, owner_id, lemma, surface, freq,"
                        " source_ids, sample, gain, exam_tags, suggested, status, created_at)"
                        " VALUES (?,?,?,?,?,?,?,?,?,?, 'new', ?)",
                        (
                            new_id("cand"),
                            owner_id,
                            lemma,
                            item.get("surface") or lemma,
                            int(item.get("freq") or 1),
                            json.dumps(item.get("source_ids") or [], ensure_ascii=False),
                            item.get("sample") or "",
                            float(item.get("gain") or 0),
                            item.get("exam_tags") or "",
                            item.get("suggested") or "",
                            now,
                        ),
                    )
                    counts += 1
        return counts

    def list_candidates(self, owner_id: str, *, limit: int = 100, status: str = "new") -> list[dict]:
        rows = self._conn.execute(
            "SELECT * FROM en_candidates WHERE owner_id = ? AND status = ?"
            " ORDER BY gain DESC, freq DESC, lemma LIMIT ?",
            (owner_id, status, int(limit)),
        ).fetchall()
        return [self._candidate_row(row) for row in rows]

    def count_candidates(self, owner_id: str, status: str = "new") -> int:
        row = self._conn.execute(
            "SELECT COUNT(*) AS c FROM en_candidates WHERE owner_id = ? AND status = ?",
            (owner_id, status),
        ).fetchone()
        return int(row["c"] or 0)

    def set_candidate_status(self, owner_id: str, cand_ids: list[str], status: str) -> int:
        if status not in {"accepted", "dismissed", "new"} or not cand_ids:
            return 0
        marks = ",".join("?" for _ in cand_ids)
        with self.transaction() as conn:
            cursor = conn.execute(
                f"UPDATE en_candidates SET status = ? WHERE owner_id = ? AND cand_id IN ({marks})",
                [status, owner_id, *cand_ids],
            )
        return cursor.rowcount

    def candidates_by_ids(self, owner_id: str, cand_ids: list[str]) -> list[dict]:
        if not cand_ids:
            return []
        marks = ",".join("?" for _ in cand_ids)
        rows = self._conn.execute(
            f"SELECT * FROM en_candidates WHERE owner_id = ? AND cand_id IN ({marks})",
            [owner_id, *cand_ids],
        ).fetchall()
        return [self._candidate_row(row) for row in rows]

    # ============================================================ 扫描 / 素材

    def scan_states(self, owner_id: str) -> dict[str, dict]:
        rows = self._conn.execute(
            "SELECT * FROM en_scan_state WHERE owner_id = ?", (owner_id,)
        ).fetchall()
        return {r["source_id"]: dict(r) for r in rows}

    def save_scan_state(
        self,
        owner_id: str,
        source_id: str,
        *,
        content_hash: str,
        word_hits: int,
        coverage: float | None,
    ) -> None:
        with self.transaction() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO en_scan_state (source_id, owner_id, content_hash,"
                " scanned_at, word_hits, coverage) VALUES (?,?,?,?,?,?)",
                (
                    source_id,
                    owner_id,
                    content_hash,
                    to_iso(utc_now()),
                    int(word_hits),
                    coverage,
                ),
            )


    # ============================================================ 词义拓展缓存

    def get_extras(self, owner_id: str, lemma: str) -> dict | None:
        row = self._conn.execute(
            "SELECT payload_json, origin FROM en_word_extras WHERE owner_id = ? AND lemma = ?",
            (owner_id, (lemma or "").strip().lower()),
        ).fetchone()
        if not row:
            return None
        try:
            payload = json.loads(row["payload_json"] or "{}")
        except json.JSONDecodeError:
            return None
        if not isinstance(payload, dict):
            return None
        payload["origin"] = row["origin"]
        return payload

    def save_extras(self, owner_id: str, lemma: str, payload: dict, *, origin: str = "ai") -> None:
        key = (lemma or "").strip().lower()
        if not key:
            return
        with self.transaction() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO en_word_extras (owner_id, lemma, payload_json,"
                " origin, created_at) VALUES (?,?,?,?,?)",
                (
                    owner_id,
                    key,
                    json.dumps(payload, ensure_ascii=False),
                    origin,
                    to_iso(utc_now()),
                ),
            )

    # ============================================================ 行转换

    def _deck_row(self, row: sqlite3.Row, *, extra: bool = False) -> dict:
        out = {
            "deck_id": row["deck_id"],
            "name": row["name"],
            "source_kind": row["source_kind"],
            "source_ref": row["source_ref"],
            "created_at": row["created_at"],
        }
        try:
            out["meta"] = json.loads(row["meta_json"] or "{}")
        except json.JSONDecodeError:
            out["meta"] = {}
        if extra:
            total = int(row["total"] or 0)
            mastered = int(row["mastered"] or 0)
            out.update(
                {
                    "word_count": total,
                    "total": total,
                    "studied": int(row["touched"] or 0),
                    "mastered": mastered,
                    "mastery": round(mastered / total, 3) if total else 0.0,
                }
            )
        return out

    def term_zh(self, owner_id: str, lemma: str) -> str:
        """从**用户自己的语料摘录**里查这个术语的中文对照。

        中文资料过模型时会产出 `terms_json`（`[{en, zh, pos, gloss}]`），`zh` 就是
        「自由粒子 / 光电效应 / 微扰哈密顿 / 宇称」这类**正确译名**——比任何词典都准，
        因为它是从用户正在读的那份资料里抽的。长久以来它只躺在摘录里没被生词本用上，
        于是卡片上只剩模型写的英文注释。这里就是把它接回来的地方。

        查不到返回空串（不编、不猜）。大小写与首尾空格都归一后再比。
        """
        key = str(lemma or "").strip().lower()
        if not key:
            return ""
        try:
            row = self._conn.execute(
                "SELECT json_extract(value, '$.zh') AS zh"
                " FROM en_corpus_excerpts, json_each(en_corpus_excerpts.terms_json)"
                " WHERE en_corpus_excerpts.owner_id = ?"
                "   AND lower(trim(json_extract(value, '$.en'))) = ?"
                " LIMIT 1",
                (owner_id, key),
            ).fetchone()
        except sqlite3.OperationalError:
            # 老 sqlite 没有 json_each：退回 python 侧扫描，宁可慢也不能没中文
            row = None
            for item in self._conn.execute(
                "SELECT terms_json FROM en_corpus_excerpts WHERE owner_id = ?",
                (owner_id,),
            ):
                try:
                    terms = json.loads(item["terms_json"] or "[]")
                except (TypeError, json.JSONDecodeError):
                    continue
                for term in terms:
                    if str(term.get("en") or "").strip().lower() == key:
                        row = {"zh": term.get("zh") or ""}
                        break
                if row:
                    break
        # row_factory 是 sqlite3.Row，它没有 .get()：走 json_each 拿到的是 Row，
        # 走降级扫描拿到的是 dict，两种都要能取（否则支持 json_each 的环境上
        # 收录术语查中文释义会直接 500）。
        if isinstance(row, sqlite3.Row):
            return str(row["zh"] or "").strip()
        return str((row or {}).get("zh") or "").strip()

    def _word_row(self, row: sqlite3.Row) -> dict:
        keys = row.keys()
        surface = row["surface"] or row["lemma"]
        out = {
            "word_id": row["word_id"],
            "deck_id": row["deck_id"],
            # word 是给界面直接显示的写法（保留原文的大小写/词形），lemma 是归一后的身份
            "word": surface,
            "lemma": row["lemma"],
            "surface": surface,
            "phonetic": row["phonetic"],
            "pos": row["pos"],
            "meaning": row["meaning"],
            "meaning_en": row["meaning_en"],
            "tags": row["tags"],
            "collins": row["collins"],
            "oxford": row["oxford"],
            "frq": row["frq"],
            "source": row["source"],
            # 生词本按加入时间排序要用；不是所有查询都带这一列
            "created_at": row["created_at"] if "created_at" in keys else "",
        }
        try:
            out["roots"] = json.loads(row["roots_json"] or "[]")
        except json.JSONDecodeError:
            out["roots"] = []
        if "deck_name" in keys:
            out["deck_name"] = row["deck_name"]
        if "stability" in keys:
            out.update(
                {
                    "stability": round(float(row["stability"] or 0), 3),
                    "difficulty": round(float(row["difficulty"] or 0), 3),
                    "due_at": row["due_at"],
                    "reps": int(row["reps"] or 0),
                    "lapses": int(row["lapses"] or 0),
                    "state": row["srs_state"],
                }
            )
        return out

    # ============================================================ 语料摘录

    def replace_corpus_for_source(
        self, owner_id: str, source_id: str, rows: Iterable[dict]
    ) -> int:
        """整份替换：先清掉这份资料的旧片，再写入新片。

        用「整份替换」而不是逐条 upsert 的原因：资料被用户替换成新版本后，
        旧片可能整条消失（段落改写了），逐条比对留下来的是一批已经对不上
        原文的僵尸语料。整份替换天然幂等，重扫几次结果都一样。
        """
        now = to_iso(utc_now())
        with self.transaction() as conn:
            conn.execute(
                "DELETE FROM en_corpus_excerpts WHERE owner_id = ? AND source_id = ?",
                (owner_id, source_id),
            )
            count = 0
            for row in rows:
                conn.execute(
                    "INSERT INTO en_corpus_excerpts (excerpt_id, owner_id, source_id,"
                    " source_title, lang, ordinal, origin_text, english_text, gist,"
                    " terms_json, created_at, origin_clean) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        new_id("exc"),
                        owner_id,
                        source_id,
                        str(row.get("source_title") or "")[:200],
                        str(row.get("lang") or "en"),
                        int(row.get("ordinal") or 0),
                        str(row.get("origin_text") or ""),
                        str(row.get("english_text") or ""),
                        str(row.get("gist") or ""),
                        str(row.get("terms_json") or "[]"),
                        now,
                        str(row.get("origin_clean") or "")[:6000],
                    ),
                )
                count += 1
        return count

    def list_corpus(
        self,
        owner_id: str,
        *,
        source_id: str | None = None,
        limit: int = 60,
        offset: int = 0,
    ) -> list[dict]:
        """列语料摘录。按来源聚在一起、片内按序，这样渲染时不用再分组。"""
        if source_id:
            rows = self._conn.execute(
                "SELECT * FROM en_corpus_excerpts WHERE owner_id = ? AND source_id = ?"
                " ORDER BY ordinal, created_at LIMIT ? OFFSET ?",
                (owner_id, source_id, int(limit), int(offset)),
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT * FROM en_corpus_excerpts WHERE owner_id = ?"
                " ORDER BY source_title, ordinal, created_at LIMIT ? OFFSET ?",
                (owner_id, int(limit), int(offset)),
            ).fetchall()
        return [self._corpus_row(row) for row in rows]

    def get_corpus_excerpt(self, owner_id: str, excerpt_id: str) -> dict | None:
        row = self._conn.execute(
            "SELECT * FROM en_corpus_excerpts WHERE owner_id = ? AND excerpt_id = ?",
            (owner_id, excerpt_id),
        ).fetchone()
        return self._corpus_row(row) if row else None

    def delete_corpus_excerpt(self, owner_id: str, excerpt_id: str) -> bool:
        with self.transaction() as conn:
            cursor = conn.execute(
                "DELETE FROM en_corpus_excerpts WHERE owner_id = ? AND excerpt_id = ?",
                (owner_id, excerpt_id),
            )
        return cursor.rowcount > 0

    def count_corpus(self, owner_id: str) -> dict:
        """语料概览：几份资料、几片、多少术语、中英文各多少。"""
        row = self._conn.execute(
            "SELECT COUNT(*) AS excerpts, COUNT(DISTINCT source_id) AS sources,"
            " SUM(CASE WHEN lang = 'zh' THEN 1 ELSE 0 END) AS zh_count FROM"
            " en_corpus_excerpts WHERE owner_id = ?",
            (owner_id,),
        ).fetchone()
        terms = 0
        for item in self._conn.execute(
            "SELECT terms_json FROM en_corpus_excerpts WHERE owner_id = ?", (owner_id,)
        ).fetchall():
            terms += len(_json_list(item["terms_json"]))
        return {
            "excerpts": int(row["excerpts"] or 0),
            "sources": int(row["sources"] or 0),
            "terms": terms,
            "zh_excerpts": int(row["zh_count"] or 0),
        }

    def _corpus_row(self, row: sqlite3.Row) -> dict:
        terms = _json_list(row["terms_json"])
        return {
            "excerpt_id": row["excerpt_id"],
            "source_id": row["source_id"],
            "source_title": row["source_title"],
            "lang": row["lang"],
            "ordinal": int(row["ordinal"] or 0),
            "origin_text": row["origin_text"],
            "origin_clean": (
                row["origin_clean"] if "origin_clean" in row.keys() else ""
            ),  # 老库补列前的行没有这一列，读缺失列会 KeyError
            "english_text": row["english_text"],
            "gist": row["gist"],
            "terms": terms,
            "created_at": row["created_at"],
        }

    def _candidate_row(self, row: sqlite3.Row) -> dict:
        return {
            "cand_id": row["cand_id"],
            "lemma": row["lemma"],
            "surface": row["surface"],
            "freq": int(row["freq"] or 0),
            "sources": _json_list(row["source_ids"]),
            "sample": row["sample"],
            "gain": float(row["gain"] or 0),
            "exam_tags": [t for t in (row["exam_tags"] or "").split() if t],
            "suggested": row["suggested"],
            "status": row["status"],
        }


def _json_list(value: str | None) -> list:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return []
    return parsed if isinstance(parsed, list) else []

