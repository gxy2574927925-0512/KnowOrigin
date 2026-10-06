from __future__ import annotations

import json
import re
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

from .models import Card, FavoriteItem, FrameworkNode, Message, Project, Source, SourceCreate, User, model_to_dict


class ProjectNotFound(KeyError):
    pass


class SourceNotFound(KeyError):
    pass


class NodeNotFound(KeyError):
    pass


class FavoriteNotFound(KeyError):
    pass


class UserAlreadyExists(ValueError):
    pass


class UserNotFound(KeyError):
    pass


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


# 撤销栈上限：每个用户最多保留的最近操作条数
UNDO_KEEP_LIMIT = 50


def _loads_list(value: str | None) -> list[str]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return []
    return parsed if isinstance(parsed, list) else []


def _loads_dict(value: str | None) -> dict[str, Any]:
    if not value:
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


class Database:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        if str(path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
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
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    user_id TEXT PRIMARY KEY,
                    email TEXT NOT NULL UNIQUE,
                    name TEXT NOT NULL,
                    password_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    last_seen_at TEXT
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    session_id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS projects (
                    project_id TEXT PRIMARY KEY,
                    owner_id TEXT REFERENCES users(user_id) ON DELETE CASCADE,
                    year TEXT NOT NULL,
                    subject TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sources (
                    source_id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
                    filename TEXT NOT NULL,
                    mime_type TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    text TEXT NOT NULL,
                    formulas TEXT NOT NULL DEFAULT '[]',
                    figures TEXT NOT NULL DEFAULT '[]',
                    status TEXT NOT NULL,
                    error_message TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS framework_nodes (
                    node_id TEXT NOT NULL,
                    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
                    parent_id TEXT,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL,
                    coverage_status TEXT NOT NULL,
                    learning_status TEXT NOT NULL,
                    mastery_score REAL NOT NULL,
                    -- 迁移分：与 mastery_score **刻意分开**的两个数字。
                    -- mastery 记「记住了多少」（D1 刷题就能刷满），transfer 记
                    --「换个情境还用不用得上」（只能靠渐进式对齐的迁移题推动）。
                    -- 混进一个分数里，就等于告诉用户刷识记题就能学会迁移。
                    transfer_score REAL NOT NULL DEFAULT 0,
                    source_ids TEXT NOT NULL,
                    prerequisite_ids TEXT NOT NULL,
                    exam_weight TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (project_id, node_id)
                );
                CREATE TABLE IF NOT EXISTS learning_events (
                    event_id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
                    node_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    correctness REAL,
                    confidence REAL NOT NULL,
                    self_confidence REAL,
                    error_type TEXT,
                    reference_id TEXT,
                    -- difficulty：这道题/这次行为的难度档（1/2/3）。可空 = 老数据。
                    -- 有了它才能做「难度加权增益」（core/transfer.py），
                    -- 否则答对 D3 与答对 D1 的得分完全相同。
                    difficulty INTEGER,
                    -- item_fingerprint：同一道题的稳定指纹（题干归一后取 hash）。
                    -- 有了它才能区分「第 3 道新题」与「第 3 遍同一题」，
                    -- 这是做边际递减的必要前提（否则只能靠 reference_id 事后反推）。
                    item_fingerprint TEXT,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(project_id, node_id) REFERENCES framework_nodes(project_id, node_id) ON DELETE CASCADE
                );
                -- ⚠️ 这两条索引刻意**不**放在上面这个 executescript 里：
                -- 建表脚本对已存在的表是 no-op，于是老库上 CREATE INDEX 会先于
                -- 下面的 ALTER TABLE ADD COLUMN 执行，直接报
                -- "no such column: item_fingerprint" 而整个库打不开。
                -- 它们在迁移补丁段（ALTER 之后）建，见 init_schema 末尾。
                CREATE TABLE IF NOT EXISTS cards (
                    card_id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS quizzes (
                    quiz_id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    submitted_at TEXT,
                    score REAL
                );
                CREATE TABLE IF NOT EXISTS messages (
                    message_id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    node_ids TEXT NOT NULL,
                    source_ids TEXT NOT NULL,
                    conversation_id TEXT NOT NULL DEFAULT '',
                    meta TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS favorites (
                    favorite_id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
                    item_type TEXT NOT NULL,
                    origin_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    content TEXT NOT NULL,
                    answer TEXT NOT NULL,
                    chapter_node_id TEXT,
                    chapter_name TEXT NOT NULL,
                    note TEXT NOT NULL,
                    highlight_color TEXT NOT NULL DEFAULT 'none',
                    node_ids TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT,
                    UNIQUE(project_id, item_type, origin_id)
                );
                CREATE TABLE IF NOT EXISTS login_events (
                    event_id TEXT PRIMARY KEY,
                    user_id TEXT REFERENCES users(user_id) ON DELETE SET NULL,
                    email TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    success INTEGER NOT NULL,
                    ip_address TEXT NOT NULL,
                    user_agent TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                -- 撤销栈：不挂外键，保证「删除项目」本身也可被撤销
                CREATE TABLE IF NOT EXISTS undo_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    owner_id TEXT NOT NULL,
                    project_id TEXT,
                    action TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS literature_meta (
                    project_id TEXT PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
                    title TEXT NOT NULL DEFAULT '',
                    authors TEXT NOT NULL DEFAULT '',
                    year TEXT NOT NULL DEFAULT '',
                    venue TEXT NOT NULL DEFAULT '',
                    doi TEXT NOT NULL DEFAULT '',
                    arxiv_id TEXT NOT NULL DEFAULT '',
                    language TEXT NOT NULL DEFAULT '',
                    keywords TEXT NOT NULL DEFAULT '[]',
                    abstract TEXT NOT NULL DEFAULT '',
                    abstract_translated TEXT NOT NULL DEFAULT '',
                    section_headings TEXT NOT NULL DEFAULT '[]',
                    suggested_questions TEXT NOT NULL DEFAULT '[]',
                    keypoints TEXT NOT NULL DEFAULT '[]',
                    references_count TEXT NOT NULL DEFAULT '',
                    extract_status TEXT NOT NULL DEFAULT 'pending'
                );
                -- 多篇文献对比结果缓存：同一组论文再次打开对比弹窗时直接复用，不再重复调用 LLM。
                -- signature 记录参与对比的正文指纹，正文被重新抽取/重排后自动失效。
                CREATE TABLE IF NOT EXISTS literature_comparisons (
                    cache_key TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL,
                    project_ids TEXT NOT NULL DEFAULT '[]',
                    signature TEXT NOT NULL DEFAULT '',
                    comparison TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS translation_segments (
                    segment_id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
                    sort INTEGER NOT NULL,
                    source_text_hash TEXT NOT NULL,
                    source_text TEXT NOT NULL,
                    translated_text TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'pending',
                    created_at TEXT NOT NULL,
                    UNIQUE(project_id, source_text_hash)
                );
                -- 文献标注：原页高亮 / AI 划词高亮 / 阅读重点增删改 / 划词笔记 / 阅读笔记。
                -- 原先只存在浏览器 localStorage 里——换台设备就没了，也谈不上「跟着账号走」。
                -- 落到库里后按 project 归属，而 project 属于某个 owner，于是天然按账号隔离。
                -- slot 供同类多份记录使用（AI 划词高亮按回答块各存一份），单份的留空串。
                CREATE TABLE IF NOT EXISTS literature_marks (
                    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
                    kind TEXT NOT NULL,
                    slot TEXT NOT NULL DEFAULT '',
                    payload TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (project_id, kind, slot)
                );
                -- 整理助手会话
                CREATE TABLE IF NOT EXISTS kb_conversations (
                    conversation_id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
                    user_id TEXT NOT NULL,
                    node_id TEXT NOT NULL DEFAULT '',
                    title TEXT NOT NULL DEFAULT '',
                    summary TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(project_id, user_id, conversation_id)
                );
                -- 库级摘要索引（结构化记忆快照）
                CREATE TABLE IF NOT EXISTS kb_digests (
                    project_id TEXT PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
                    version INTEGER NOT NULL DEFAULT 0,
                    payload TEXT NOT NULL DEFAULT '{}',
                    generated_at TEXT NOT NULL,
                    schema_version INTEGER NOT NULL DEFAULT 1
                );
                -- AI 代写笔记建议稿（审批流）
                CREATE TABLE IF NOT EXISTS note_proposals (
                    proposal_id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
                    node_id TEXT NOT NULL,
                    proposed_action TEXT NOT NULL,
                    proposed_content TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    user_edits TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    applied_at TEXT
                );
                -- 用户级长期画像（跨项目）
                CREATE TABLE IF NOT EXISTS user_profiles (
                    user_id TEXT PRIMARY KEY,
                    profile_json TEXT NOT NULL DEFAULT '{}',
                    updated_at TEXT NOT NULL
                );
                -- 会话内苏格拉底引导错因/掌握状态（L1 单节点闭环）
                CREATE TABLE IF NOT EXISTS node_socratic_state (
                    conversation_id TEXT NOT NULL,
                    node_id TEXT NOT NULL,
                    verdict TEXT NOT NULL DEFAULT 'unknown',
                    miscue TEXT NOT NULL DEFAULT '',
                    hint_level INTEGER NOT NULL DEFAULT 0,
                    mastery_after REAL NOT NULL DEFAULT 0.0,
                    iter_count INTEGER NOT NULL DEFAULT 0,
                    convergence TEXT NOT NULL DEFAULT 'open',
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (conversation_id, node_id)
                );
                -- 主界面问答会话（Agent 布局的「每个项目多个会话」）。
                -- 消息本体仍在 messages 表里，用 conversation_id 关联；
                -- 这里只存会话壳（标题与时间），未登记的 conversation_id 也允许存在
                -- （老数据 conversation_id='' 的单线程会话天然没有壳）。
                CREATE TABLE IF NOT EXISTS chat_sessions (
                    session_id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
                    title TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_chat_sessions_project
                    ON chat_sessions(project_id, updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_favorites_project_chapter
                    ON favorites(project_id, chapter_name, created_at);
                CREATE INDEX IF NOT EXISTS idx_sessions_user
                    ON sessions(user_id, expires_at);
                CREATE INDEX IF NOT EXISTS idx_login_events_created
                    ON login_events(created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_undo_history_owner
                    ON undo_history(owner_id, id DESC);
                """
            )
            user_columns = {
                row["name"] for row in conn.execute("PRAGMA table_info(users)").fetchall()
            }
            if "last_seen_at" not in user_columns:
                conn.execute("ALTER TABLE users ADD COLUMN last_seen_at TEXT")
            project_columns = {
                row["name"] for row in conn.execute("PRAGMA table_info(projects)").fetchall()
            }
            if "owner_id" not in project_columns:
                conn.execute("ALTER TABLE projects ADD COLUMN owner_id TEXT REFERENCES users(user_id) ON DELETE CASCADE")
            if "project_type" not in project_columns:
                conn.execute("ALTER TABLE projects ADD COLUMN project_type TEXT NOT NULL DEFAULT 'course'")
            if "tags" not in project_columns:
                conn.execute("ALTER TABLE projects ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'")
            if "reading_status" not in project_columns:
                conn.execute("ALTER TABLE projects ADD COLUMN reading_status TEXT NOT NULL DEFAULT 'unread'")
            if "last_position" not in project_columns:
                conn.execute("ALTER TABLE projects ADD COLUMN last_position REAL NOT NULL DEFAULT 0.0")
            if "last_opened_at" not in project_columns:
                conn.execute("ALTER TABLE projects ADD COLUMN last_opened_at TEXT")
            if "total_reading_seconds" not in project_columns:
                conn.execute("ALTER TABLE projects ADD COLUMN total_reading_seconds INTEGER NOT NULL DEFAULT 0")
            proposal_columns = {
                row["name"] for row in conn.execute("PRAGMA table_info(note_proposals)").fetchall()
            }
            if "type" not in proposal_columns:
                conn.execute("ALTER TABLE note_proposals ADD COLUMN type TEXT NOT NULL DEFAULT 'add_note'")
            if "reason" not in proposal_columns:
                conn.execute("ALTER TABLE note_proposals ADD COLUMN reason TEXT NOT NULL DEFAULT ''")
            if "rollback" not in proposal_columns:
                conn.execute("ALTER TABLE note_proposals ADD COLUMN rollback TEXT NOT NULL DEFAULT '{}'")
            self._ensure_legacy_user(conn)
            conn.execute("UPDATE projects SET owner_id = ? WHERE owner_id IS NULL", ("user_legacy",))
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_projects_owner_created ON projects(owner_id, created_at DESC)"
            )
            source_columns = {
                row["name"] for row in conn.execute("PRAGMA table_info(sources)").fetchall()
            }
            if "formulas" not in source_columns:
                conn.execute("ALTER TABLE sources ADD COLUMN formulas TEXT NOT NULL DEFAULT '[]'")
            if "figures" not in source_columns:
                conn.execute("ALTER TABLE sources ADD COLUMN figures TEXT NOT NULL DEFAULT '[]'")
            lit_meta_columns = {
                row["name"] for row in conn.execute("PRAGMA table_info(literature_meta)").fetchall()
            }
            if "suggested_questions" not in lit_meta_columns:
                conn.execute("ALTER TABLE literature_meta ADD COLUMN suggested_questions TEXT NOT NULL DEFAULT '[]'")
            if "keypoints" not in lit_meta_columns:
                conn.execute("ALTER TABLE literature_meta ADD COLUMN keypoints TEXT NOT NULL DEFAULT '[]'")
            favorite_columns = {
                row["name"] for row in conn.execute("PRAGMA table_info(favorites)").fetchall()
            }
            if "highlight_color" not in favorite_columns:
                conn.execute("ALTER TABLE favorites ADD COLUMN highlight_color TEXT NOT NULL DEFAULT 'none'")
            if "deleted_at" not in favorite_columns:
                conn.execute("ALTER TABLE favorites ADD COLUMN deleted_at TEXT")
            # 笔记高亮默认色 yellow → none（无填充）：存量未主动选色的 yellow 笔记一次性迁移
            if conn.execute("PRAGMA user_version").fetchone()[0] < 1:
                conn.execute(
                    "UPDATE favorites SET highlight_color = 'none' WHERE highlight_color = 'yellow'"
                )
                conn.execute("PRAGMA user_version = 1")
            # learning_events: reference_id 用于让前端点击 trail 行时能跳转回卡片/测验
            ev_columns = {
                row["name"] for row in conn.execute("PRAGMA table_info(learning_events)").fetchall()
            }
            if "reference_id" not in ev_columns:
                conn.execute("ALTER TABLE learning_events ADD COLUMN reference_id TEXT")
            # self_confidence：**学习者自己说的**把握度（答题时勾「我确定 / 我不确定」），
            # 与 confidence（LLM 把输入映射到节点的把握度）是两个构念，绝不能混。
            # 可空、无默认 —— 老行自动为 NULL，等价于「老数据一律不判」，所以不需要回填。
            if "self_confidence" not in ev_columns:
                conn.execute("ALTER TABLE learning_events ADD COLUMN self_confidence REAL")
            # error_type：**学习者自己选的**错因（见 framework.ERROR_TYPES），
            # 答错之后才补写的，所以建表时一律为空。同样可空、无默认、不回填。
            if "error_type" not in ev_columns:
                conn.execute("ALTER TABLE learning_events ADD COLUMN error_type TEXT")
            # difficulty / item_fingerprint：难度加权与边际递减的输入。
            # 都可空、无默认、不回填 —— 老事件一律按「未标注」处理，
            # 由 core/transfer.py 的 DEFAULT_DIFFICULTY 兜底成 D2 口径，
            # 这样老库升级后的分数整体平移可控，而不是靠批量 UPDATE 猜值。
            if "difficulty" not in ev_columns:
                conn.execute("ALTER TABLE learning_events ADD COLUMN difficulty INTEGER")
            if "item_fingerprint" not in ev_columns:
                conn.execute("ALTER TABLE learning_events ADD COLUMN item_fingerprint TEXT")
            # 这两条索引同时解掉 mastery_bkt / progress_engine 的全表扫。
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_learning_events_node
                    ON learning_events(project_id, node_id, created_at)
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_learning_events_fingerprint
                    ON learning_events(project_id, item_fingerprint, created_at)
                """
            )
            # 个人知识库：笔记正文 / 标签 / 双链（Obsidian 式）
            fn_columns = {
                row["name"] for row in conn.execute("PRAGMA table_info(framework_nodes)").fetchall()
            }
            if "note_content" not in fn_columns:
                conn.execute("ALTER TABLE framework_nodes ADD COLUMN note_content TEXT NOT NULL DEFAULT ''")
            if "tags" not in fn_columns:
                conn.execute("ALTER TABLE framework_nodes ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'")
            if "wikilinks" not in fn_columns:
                conn.execute("ALTER TABLE framework_nodes ADD COLUMN wikilinks TEXT NOT NULL DEFAULT '[]'")
            # transfer_score：迁移分，与 mastery_score 分开。默认 0 = 「迁移未验证」，
            # 老节点升级后全部落进「未验证」档 —— 这是诚实的：我们确实没验过它们能不能迁移。
            if "transfer_score" not in fn_columns:
                conn.execute(
                    "ALTER TABLE framework_nodes ADD COLUMN transfer_score REAL NOT NULL DEFAULT 0"
                )
            # 双链「理解」：一对双链共享一句关系说明，与 wikilinks（有向、按名存储）解耦。
            # 键用 node_id 的无序对（a_node_id <= b_node_id），因此 A↔B 只有一行；
            # 双链被删后这里可能留下孤儿行，无害 —— 重新建链时那句理解会自动回来。
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS node_link_notes (
                    project_id TEXT NOT NULL,
                    a_node_id TEXT NOT NULL,
                    b_node_id TEXT NOT NULL,
                    note TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (project_id, a_node_id, b_node_id)
                )
                """
            )
            msg_columns = {
                row["name"] for row in conn.execute("PRAGMA table_info(messages)").fetchall()
            }
            if "conversation_id" not in msg_columns:
                conn.execute("ALTER TABLE messages ADD COLUMN conversation_id TEXT NOT NULL DEFAULT ''")
            if "meta" not in msg_columns:
                conn.execute("ALTER TABLE messages ADD COLUMN meta TEXT NOT NULL DEFAULT '{}'")
            kb_conv_columns = {
                row["name"] for row in conn.execute("PRAGMA table_info(kb_conversations)").fetchall()
            }
            if "node_id" not in kb_conv_columns:
                conn.execute("ALTER TABLE kb_conversations ADD COLUMN node_id TEXT NOT NULL DEFAULT ''")

    def _ensure_legacy_user(self, conn: sqlite3.Connection) -> None:
        conn.execute(
            """
            INSERT OR IGNORE INTO users(user_id, email, name, password_hash, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            ("user_legacy", "legacy@knoworigin.local", "本地旧数据", "", utc_now().isoformat()),
        )

    def close(self) -> None:
        self._conn.close()

    def assert_writable(self) -> None:
        self._conn.execute("BEGIN IMMEDIATE")
        self._conn.rollback()

    def is_writable(self) -> bool:
        try:
            self.assert_writable()
        except sqlite3.OperationalError:
            return False
        return True

    def create_user(self, email: str, name: str, password_hash: str) -> User:
        normalized_email = email.strip().lower()
        now = utc_now()
        user = User(
            user_id=new_id("user"),
            email=normalized_email,
            name=name.strip() or normalized_email.split("@", 1)[0],
            created_at=now,
            last_seen_at=now,
        )
        try:
            with self.transaction() as conn:
                conn.execute(
                    "INSERT INTO users(user_id, email, name, password_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        user.user_id,
                        user.email,
                        user.name,
                        password_hash,
                        user.created_at.isoformat(),
                        user.last_seen_at.isoformat(),
                    ),
                )
        except sqlite3.IntegrityError as exc:
            raise UserAlreadyExists(normalized_email) from exc
        return user

    def get_user_by_email(self, email: str) -> tuple[User, str]:
        normalized_email = email.strip().lower()
        row = self._conn.execute("SELECT * FROM users WHERE email = ?", (normalized_email,)).fetchone()
        if row is None:
            raise UserNotFound(normalized_email)
        return self._user_from_row(row), row["password_hash"]

    def get_user(self, user_id: str) -> User:
        row = self._conn.execute("SELECT * FROM users WHERE user_id = ?", (user_id,)).fetchone()
        if row is None:
            raise UserNotFound(user_id)
        return self._user_from_row(row)

    def create_session(self, user_id: str, expires_at: datetime) -> str:
        self.get_user(user_id)
        session_id = new_id("sess")
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO sessions(session_id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
                (session_id, user_id, utc_now().isoformat(), expires_at.isoformat()),
            )
        return session_id

    def get_user_by_session(self, session_id: str) -> User | None:
        if not session_id:
            return None
        row = self._conn.execute(
            """
            SELECT users.*
            FROM sessions
            JOIN users ON users.user_id = sessions.user_id
            WHERE sessions.session_id = ? AND sessions.expires_at > ?
            """,
            (session_id, utc_now().isoformat()),
        ).fetchone()
        return self._user_from_row(row) if row is not None else None

    def touch_user(self, user_id: str) -> None:
        with self.transaction() as conn:
            conn.execute("UPDATE users SET last_seen_at = ? WHERE user_id = ?", (utc_now().isoformat(), user_id))

    def record_login_event(
        self,
        event_type: str,
        success: bool,
        email: str,
        user_id: str | None = None,
        ip_address: str = "",
        user_agent: str = "",
    ) -> None:
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO login_events(event_id, user_id, email, event_type, success, ip_address, user_agent, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    new_id("evt"),
                    user_id,
                    email.strip().lower(),
                    event_type,
                    1 if success else 0,
                    ip_address[:128],
                    user_agent[:500],
                    utc_now().isoformat(),
                ),
            )

    def admin_overview(self) -> dict[str, object]:
        now = utc_now()
        active_since = (now - timedelta(minutes=5)).isoformat()
        session_cutoff = now.isoformat()
        user_count = self._conn.execute(
            "SELECT COUNT(*) FROM users WHERE user_id != ?",
            ("user_legacy",),
        ).fetchone()[0]
        active_session_count = self._conn.execute(
            """
            SELECT COUNT(DISTINCT user_id)
            FROM sessions
            WHERE expires_at > ? AND user_id != ?
            """,
            (session_cutoff, "user_legacy"),
        ).fetchone()[0]
        active_user_count = self._conn.execute(
            """
            SELECT COUNT(*)
            FROM users
            WHERE user_id != ? AND last_seen_at IS NOT NULL AND last_seen_at > ?
            """,
            ("user_legacy", active_since),
        ).fetchone()[0]
        project_count = self._conn.execute(
            "SELECT COUNT(*) FROM projects WHERE owner_id != ?",
            ("user_legacy",),
        ).fetchone()[0]
        source_count = self._conn.execute(
            """
            SELECT COUNT(*)
            FROM sources
            JOIN projects ON projects.project_id = sources.project_id
            WHERE projects.owner_id != ?
            """,
            ("user_legacy",),
        ).fetchone()[0]
        users = [
            {
                "user_id": row["user_id"],
                "email": row["email"],
                "name": row["name"],
                "created_at": row["created_at"],
                "last_seen_at": row["last_seen_at"],
                "project_count": int(row["project_count"]),
                "source_count": int(row["source_count"]),
                "active_sessions": int(row["active_sessions"]),
                "last_login_at": row["last_login_at"],
                "failed_login_count": int(row["failed_login_count"]),
            }
            for row in self._conn.execute(
                """
                SELECT
                    users.user_id,
                    users.email,
                    users.name,
                    users.created_at,
                    users.last_seen_at,
                    COUNT(DISTINCT projects.project_id) AS project_count,
                    COUNT(DISTINCT sources.source_id) AS source_count,
                    COUNT(DISTINCT active_sessions.session_id) AS active_sessions,
                    MAX(success_logins.created_at) AS last_login_at,
                    COUNT(DISTINCT failed_logins.event_id) AS failed_login_count
                FROM users
                LEFT JOIN projects ON projects.owner_id = users.user_id
                LEFT JOIN sources ON sources.project_id = projects.project_id
                LEFT JOIN sessions AS active_sessions
                    ON active_sessions.user_id = users.user_id AND active_sessions.expires_at > ?
                LEFT JOIN login_events AS success_logins
                    ON success_logins.user_id = users.user_id
                    AND success_logins.event_type IN ('login', 'register')
                    AND success_logins.success = 1
                LEFT JOIN login_events AS failed_logins
                    ON failed_logins.email = users.email
                    AND failed_logins.event_type = 'login'
                    AND failed_logins.success = 0
                WHERE users.user_id != ?
                GROUP BY users.user_id
                ORDER BY COALESCE(users.last_seen_at, users.created_at) DESC
                LIMIT 200
                """,
                (session_cutoff, "user_legacy"),
            ).fetchall()
        ]
        recent_events = [
            {
                "event_id": row["event_id"],
                "email": row["email"],
                "event_type": row["event_type"],
                "success": bool(row["success"]),
                "ip_address": row["ip_address"],
                "user_agent": row["user_agent"],
                "created_at": row["created_at"],
            }
            for row in self._conn.execute(
                """
                SELECT event_id, email, event_type, success, ip_address, user_agent, created_at
                FROM login_events
                ORDER BY created_at DESC
                LIMIT 80
                """
            ).fetchall()
        ]
        return {
            "generated_at": now.isoformat(),
            "summary": {
                "total_users": int(user_count),
                "active_sessions": int(active_session_count),
                "active_users_5m": int(active_user_count),
                "total_projects": int(project_count),
                "total_sources": int(source_count),
            },
            "users": users,
            "recent_events": recent_events,
        }

    def delete_session(self, session_id: str) -> None:
        if not session_id:
            return
        with self.transaction() as conn:
            conn.execute("DELETE FROM sessions WHERE session_id = ?", (session_id,))

    def prune_expired_sessions(self) -> None:
        with self.transaction() as conn:
            conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (utc_now().isoformat(),))

    def create_project(self, year: str, subject: str, owner_id: str = "user_legacy") -> Project:
        self.get_user(owner_id)
        project = Project(project_id=new_id("proj"), owner_id=owner_id, year=year, subject=subject, created_at=utc_now())
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO projects(project_id, owner_id, year, subject, created_at) VALUES (?, ?, ?, ?, ?)",
                (project.project_id, owner_id, project.year, project.subject, project.created_at.isoformat()),
            )
        return project

    def list_projects(self, owner_id: str | None = None) -> list[Project]:
        if owner_id is None:
            rows = self._conn.execute("SELECT * FROM projects ORDER BY created_at DESC").fetchall()
        else:
            rows = self._conn.execute(
                "SELECT * FROM projects WHERE owner_id = ? ORDER BY created_at DESC",
                (owner_id,),
            ).fetchall()
        return [self._project_from_row(row) for row in rows]

    def get_project(self, project_id: str, owner_id: str | None = None) -> Project:
        if owner_id is None:
            row = self._conn.execute("SELECT * FROM projects WHERE project_id = ?", (project_id,)).fetchone()
        else:
            row = self._conn.execute(
                "SELECT * FROM projects WHERE project_id = ? AND owner_id = ?",
                (project_id, owner_id),
            ).fetchone()
        if row is None:
            raise ProjectNotFound(project_id)
        return self._project_from_row(row)

    def delete_project(self, project_id: str, owner_id: str | None = None) -> None:
        self.get_project(project_id, owner_id)
        with self.transaction() as conn:
            # node_link_notes 建表时没挂 FK 级联（老库补表无法加约束），这里显式清，
            # 否则删项目后理解行会变成永久孤儿（撤销时靠快照 bundle 还原）。
            conn.execute(
                "DELETE FROM node_link_notes WHERE project_id = ?", (project_id,)
            )
            if owner_id is None:
                conn.execute("DELETE FROM projects WHERE project_id = ?", (project_id,))
            else:
                conn.execute("DELETE FROM projects WHERE project_id = ? AND owner_id = ?", (project_id, owner_id))

    # ---- 文献精读（Literature）----

    def create_literature(self, owner_id: str, title: str) -> Project:
        self.get_user(owner_id)
        now = utc_now()
        project = Project(
            project_id=new_id("lit"),
            owner_id=owner_id,
            year="",
            subject=title,
            project_type="literature",
            tags=[],
            last_position=0.0,
            last_opened_at=None,
            total_reading_seconds=0,
            created_at=now,
        )
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO projects(project_id, owner_id, year, subject, project_type, tags, last_position, total_reading_seconds, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (project.project_id, owner_id, "", title, "literature", "[]", 0.0, 0, now.isoformat()),
            )
            conn.execute(
                "INSERT INTO literature_meta(project_id, title, extract_status) VALUES (?, ?, 'pending')",
                (project.project_id, title),
            )
        return project

    def set_project_tags(self, project_id: str, tags: list[str]) -> None:
        """整体覆盖项目标签。

        对比阅读项目用它把「这一组文献」的指纹写进 tags，从而做到同一组文献只建一个项目
        （重复对比时复用，而不是每次对比都在侧栏多出一个项目）。
        """
        self.get_project(project_id)
        with self.transaction() as conn:
            conn.execute(
                "UPDATE projects SET tags = ? WHERE project_id = ?",
                (json.dumps(list(tags), ensure_ascii=False), project_id),
            )

    def list_literature(self, owner_id: str, tag: str | None = None) -> list[Project]:
        query = "SELECT * FROM projects WHERE owner_id = ? AND project_type = 'literature'"
        params: list[Any] = [owner_id]
        query += " ORDER BY last_opened_at DESC NULLS LAST, created_at DESC"
        projects = [self._project_from_row(row) for row in self._conn.execute(query, params).fetchall()]
        if tag:
            projects = [p for p in projects if tag in p.tags]
        return projects

    def update_literature(self, project_id: str, *, title: str | None = None, tags: list[str] | None = None, last_position: float | None = None, reading_time_delta: int | None = None) -> Project:
        self.get_project(project_id)
        updates: list[str] = []
        params: list[Any] = []
        if title is not None:
            updates.append("subject = ?")
            params.append(title)
        if tags is not None:
            updates.append("tags = ?")
            params.append(json.dumps(tags, ensure_ascii=False))
        if last_position is not None:
            updates.append("last_position = ?")
            params.append(last_position)
        if reading_time_delta is not None:
            updates.append("total_reading_seconds = total_reading_seconds + ?")
            params.append(reading_time_delta)
        if updates:
            params.append(project_id)
            with self.transaction() as conn:
                conn.execute(f"UPDATE projects SET {', '.join(updates)} WHERE project_id = ?", params)
            if title is not None:
                self.upsert_literature_meta(project_id, {"title": title})
        return self.get_project(project_id)

    def record_literature_opened(self, project_id: str) -> None:
        self.get_project(project_id)
        now = utc_now()
        with self.transaction() as conn:
            conn.execute(
                "UPDATE projects SET last_opened_at = ? WHERE project_id = ?",
                (now.isoformat(), project_id),
            )

    def get_literature_meta(self, project_id: str) -> dict[str, Any]:
        self.get_project(project_id)
        row = self._conn.execute(
            "SELECT * FROM literature_meta WHERE project_id = ?", (project_id,)
        ).fetchone()
        return self._literature_meta_from_row(row) if row is not None else {}

    def upsert_literature_meta(self, project_id: str, fields: dict[str, Any]) -> dict[str, Any]:
        self.get_project(project_id)
        allowed = {
            "title", "authors", "year", "venue", "doi", "arxiv_id", "language",
            "keywords", "abstract", "abstract_translated", "section_headings",
            "suggested_questions", "keypoints",
            "references_count", "extract_status",
        }
        clean = {k: v for k, v in fields.items() if k in allowed}
        with self.transaction() as conn:
            if not clean:
                conn.execute(
                    "INSERT OR IGNORE INTO literature_meta(project_id, title) VALUES (?, '')",
                    (project_id,),
                )
            else:
                ordered = sorted(clean.keys())
                cols = ["project_id"] + ordered
                mark = ", ".join(["?"] * len(cols))
                assignments = ", ".join(f"{k}=excluded.{k}" for k in ordered)
                values: list[Any] = [project_id]
                for k in ordered:
                    value = clean[k]
                    values.append(
                        json.dumps(value, ensure_ascii=False)
                        if isinstance(value, (list, dict))
                        else ("" if value is None else str(value))
                    )
                conn.execute(
                    f"INSERT INTO literature_meta ({', '.join(cols)}) VALUES ({mark}) "
                    f"ON CONFLICT(project_id) DO UPDATE SET {assignments}",
                    values,
                )
        return self.get_literature_meta(project_id)

    # —— 文献标注（原页高亮 / AI 划词高亮 / 阅读重点增删改 / 划词笔记 / 阅读笔记）——
    def list_literature_marks(self, project_id: str) -> list[dict[str, Any]]:
        """取这篇文献的全部标注。payload 已在写入时序列化，这里解析成 JSON 对象返回。"""
        self.get_project(project_id)
        rows = self._conn.execute(
            "SELECT kind, slot, payload, updated_at FROM literature_marks "
            "WHERE project_id = ? ORDER BY kind, slot",
            (project_id,),
        ).fetchall()
        marks: list[dict[str, Any]] = []
        for row in rows:
            try:
                payload = json.loads(row["payload"])
            except (TypeError, ValueError):
                continue
            marks.append(
                {
                    "kind": row["kind"],
                    "slot": row["slot"],
                    "payload": payload,
                    "updated_at": row["updated_at"],
                }
            )
        return marks

    def set_literature_mark(
        self, project_id: str, kind: str, slot: str, payload: Any
    ) -> dict[str, Any]:
        """写入一格标注。payload 为空（None / 空数组 / 空串 / 空对象）时删除该格，不留垃圾行。"""
        self.get_project(project_id)
        now = utc_now().isoformat()
        empty = payload is None or payload == [] or payload == "" or payload == {}
        deleted = False
        with self.transaction() as conn:
            if empty:
                conn.execute(
                    "DELETE FROM literature_marks WHERE project_id = ? AND kind = ? AND slot = ?",
                    (project_id, kind, slot),
                )
                deleted = True
            else:
                conn.execute(
                    "INSERT INTO literature_marks(project_id, kind, slot, payload, updated_at) "
                    "VALUES (?, ?, ?, ?, ?) "
                    "ON CONFLICT(project_id, kind, slot) DO UPDATE SET "
                    "payload = excluded.payload, updated_at = excluded.updated_at",
                    (project_id, kind, slot, json.dumps(payload, ensure_ascii=False), now),
                )
        return {
            "kind": kind,
            "slot": slot,
            "payload": None if deleted else payload,
            "updated_at": now,
            "deleted": deleted,
        }

    # —— 多篇文献对比缓存 ——
    def get_literature_comparison(self, cache_key: str) -> dict[str, Any]:
        """按缓存槽位取上次的对比结果；没有就返回空 dict。"""
        row = self._conn.execute(
            "SELECT * FROM literature_comparisons WHERE cache_key = ?", (cache_key,)
        ).fetchone()
        return dict(row) if row is not None else {}

    def save_literature_comparison(
        self,
        cache_key: str,
        owner_id: str,
        project_ids: list[str],
        signature: str,
        comparison: str,
    ) -> None:
        """写入/覆盖某个缓存槽位的对比结果（同一组论文只占一行）。"""
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO literature_comparisons
                    (cache_key, owner_id, project_ids, signature, comparison, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    cache_key,
                    owner_id,
                    json.dumps(list(project_ids), ensure_ascii=False),
                    signature,
                    comparison,
                    utc_now().isoformat(),
                ),
            )

    def list_literature_comparisons_for(
        self, project_id: str, owner_id: str
    ) -> list[dict[str, Any]]:
        """取所有「包含这篇文献」的对比结果，最近的排前面。

        project_ids 是 JSON 数组字符串，这里**不用 LIKE 粗筛**：LIKE '%"abc"%'
        会被 id 前缀相同的别的项目误命中（"abc" 会命中 "abc2"）。数据量本来就
        是一条文献最多几组对比，全取回来在 Python 里按精确成员判定更稳。
        """
        rows = self._conn.execute(
            "SELECT * FROM literature_comparisons WHERE owner_id = ? "
            "ORDER BY created_at DESC",
            (owner_id,),
        ).fetchall()
        out: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            try:
                ids = json.loads(item.get("project_ids") or "[]")
            except (TypeError, ValueError):
                continue
            if isinstance(ids, list) and project_id in {str(i) for i in ids}:
                out.append(item)
        return out

    def list_translations(self, project_id: str) -> list[dict[str, Any]]:
        self.get_project(project_id)
        rows = self._conn.execute(
            "SELECT * FROM translation_segments WHERE project_id = ? ORDER BY sort ASC",
            (project_id,),
        ).fetchall()
        return [dict(row) for row in rows]

    def get_translation_by_hash(self, project_id: str, source_text_hash: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT * FROM translation_segments WHERE project_id = ? AND source_text_hash = ?",
            (project_id, source_text_hash),
        ).fetchone()
        return dict(row) if row is not None else None

    def upsert_translation(self, project_id: str, sort: int, source_text_hash: str, source_text: str, translated_text: str, status: str = "done") -> dict[str, Any]:
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO translation_segments(segment_id, project_id, sort, source_text_hash, source_text, translated_text, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(project_id, source_text_hash) DO UPDATE SET
                    translated_text=excluded.translated_text,
                    status=excluded.status
                """,
                (new_id("seg"), project_id, sort, source_text_hash, source_text, translated_text, status, utc_now().isoformat()),
            )
        return self.get_translation_by_hash(project_id, source_text_hash) or {}


    def add_source(self, project_id: str, source: SourceCreate) -> Source:
        self.get_project(project_id)
        created = utc_now()
        source_id = new_id("src")
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO sources(source_id, project_id, filename, mime_type, size_bytes, text, formulas, figures, status, error_message, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    source_id,
                    project_id,
                    source.filename,
                    source.mime_type,
                    source.size_bytes,
                    source.text,
                    json.dumps(source.formulas, ensure_ascii=False),
                    json.dumps(source.figures, ensure_ascii=False),
                    source.status,
                    source.error_message,
                    created.isoformat(),
                ),
            )
        return Source(source_id=source_id, project_id=project_id, created_at=created, **model_to_dict(source))

    def update_source_extraction(self, project_id: str, source_id: str, source: SourceCreate) -> Source:
        self.get_source(project_id, source_id)
        with self.transaction() as conn:
            conn.execute(
                """
                UPDATE sources
                SET filename = ?, mime_type = ?, size_bytes = ?, text = ?, formulas = ?, figures = ?, status = ?, error_message = ?
                WHERE project_id = ? AND source_id = ?
                """,
                (
                    source.filename,
                    source.mime_type,
                    source.size_bytes,
                    source.text,
                    json.dumps(source.formulas, ensure_ascii=False),
                    json.dumps(source.figures, ensure_ascii=False),
                    source.status,
                    source.error_message,
                    project_id,
                    source_id,
                ),
            )
        return self.get_source(project_id, source_id)

    def list_sources(self, project_id: str) -> list[Source]:
        self.get_project(project_id)
        rows = self._conn.execute(
            "SELECT * FROM sources WHERE project_id = ? ORDER BY created_at ASC", (project_id,)
        ).fetchall()
        return [self._source_from_row(row) for row in rows]

    def get_source(self, project_id: str, source_id: str) -> Source:
        self.get_project(project_id)
        row = self._conn.execute(
            "SELECT * FROM sources WHERE project_id = ? AND source_id = ?",
            (project_id, source_id),
        ).fetchone()
        if row is None:
            raise SourceNotFound(source_id)
        return self._source_from_row(row)

    def delete_source(self, project_id: str, source_id: str) -> Source:
        source = self.get_source(project_id, source_id)
        with self.transaction() as conn:
            conn.execute(
                "DELETE FROM sources WHERE project_id = ? AND source_id = ?",
                (project_id, source_id),
            )
        return source

    def upsert_framework_nodes(
        self,
        project_id: str,
        nodes: list[FrameworkNode],
        *,
        replace: bool = False,
    ) -> list[FrameworkNode]:
        self.get_project(project_id)
        saved: list[FrameworkNode] = []
        with self.transaction() as conn:
            incoming_ids = {node.node_id for node in nodes}
            stale_ids = []
            if replace:
                stale_ids = [
                    row["node_id"]
                    for row in conn.execute(
                        "SELECT node_id FROM framework_nodes WHERE project_id = ?",
                        (project_id,),
                    ).fetchall()
                    if row["node_id"] not in incoming_ids
                ]
            for node in nodes:
                existing = conn.execute(
                    "SELECT * FROM framework_nodes WHERE project_id = ? AND node_id = ?",
                    (project_id, node.node_id),
                ).fetchone()
                learning_status = node.learning_status
                mastery_score = node.mastery_score
                if existing is not None:
                    learning_status = existing["learning_status"]
                    mastery_score = float(existing["mastery_score"])
                conn.execute(
                    """
                    INSERT INTO framework_nodes(
                        node_id, project_id, parent_id, name, description, coverage_status,
                        learning_status, mastery_score, source_ids, prerequisite_ids, exam_weight,
                        note_content, tags, wikilinks, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(project_id, node_id) DO UPDATE SET
                        parent_id=excluded.parent_id,
                        name=excluded.name,
                        description=excluded.description,
                        coverage_status=excluded.coverage_status,
                        source_ids=excluded.source_ids,
                        prerequisite_ids=excluded.prerequisite_ids,
                        exam_weight=excluded.exam_weight,
                        note_content=excluded.note_content,
                        tags=excluded.tags,
                        wikilinks=excluded.wikilinks,
                        updated_at=excluded.updated_at
                    """,
                    (
                        node.node_id,
                        project_id,
                        node.parent_id,
                        node.name,
                        node.description,
                        node.coverage_status,
                        learning_status,
                        mastery_score,
                        json.dumps(node.source_ids, ensure_ascii=False),
                        json.dumps(node.prerequisite_ids, ensure_ascii=False),
                        node.exam_weight,
                        node.note_content,
                        json.dumps(node.tags, ensure_ascii=False),
                        json.dumps(node.wikilinks, ensure_ascii=False),
                        utc_now().isoformat(),
                    ),
                )
                saved.append(node.model_copy(update={"learning_status": learning_status, "mastery_score": mastery_score}))
            if stale_ids:
                conn.executemany(
                    "DELETE FROM framework_nodes WHERE project_id = ? AND node_id = ?",
                    [(project_id, node_id) for node_id in stale_ids],
                )
        return saved

    def merge_node_source_ids(
        self, project_id: str, additions: dict[str, list[str]]
    ) -> dict[str, list[str]]:
        """把 source_id「并集追加」到指定节点的 source_ids（只增不删）。

        为什么不能用 upsert_framework_nodes：它在 replace=False 时仍然会用
        excluded.source_ids 覆盖原值，走它会把节点原有的课程来源边整条冲掉。
        这里只碰 source_ids 与 updated_at，learning_status / mastery_score / 笔记 / 双链
        一律不动，因此可以安全地给已有知识网上补一份新来源。

        返回真正被改动的节点：{node_id: 合并后的 source_ids}。
        """
        self.get_project(project_id)
        changed: dict[str, list[str]] = {}
        if not additions:
            return changed
        now = utc_now().isoformat()
        with self.transaction() as conn:
            for node_id, source_ids in additions.items():
                row = conn.execute(
                    "SELECT source_ids FROM framework_nodes WHERE project_id = ? AND node_id = ?",
                    (project_id, node_id),
                ).fetchone()
                if row is None:
                    continue
                try:
                    merged = list(json.loads(row["source_ids"] or "[]"))
                except (TypeError, ValueError):
                    merged = []
                added: list[str] = []
                for sid in source_ids:
                    if not sid:
                        continue
                    sid = str(sid)
                    if sid in merged or sid in added:
                        continue
                    added.append(sid)
                if not added:
                    continue
                merged.extend(added)
                conn.execute(
                    "UPDATE framework_nodes SET source_ids = ?, updated_at = ? "
                    "WHERE project_id = ? AND node_id = ?",
                    (json.dumps(merged, ensure_ascii=False), now, project_id, node_id),
                )
                changed[node_id] = merged
        return changed

    def list_framework_nodes(self, project_id: str) -> list[FrameworkNode]:
        self.get_project(project_id)
        rows = self._conn.execute(
            "SELECT * FROM framework_nodes WHERE project_id = ? ORDER BY parent_id IS NOT NULL, name",
            (project_id,),
        ).fetchall()
        return [self._node_from_row(row) for row in rows]

    def get_framework_node(self, project_id: str, node_id: str) -> FrameworkNode:
        self.get_project(project_id)
        row = self._conn.execute(
            "SELECT * FROM framework_nodes WHERE project_id = ? AND node_id = ?", (project_id, node_id)
        ).fetchone()
        if row is None:
            raise NodeNotFound(node_id)
        return self._node_from_row(row)

    def add_framework_node(
        self,
        project_id: str,
        *,
        name: str,
        description: str = "",
        parent_id: str | None = None,
        source_ids: list[str] | None = None,
    ) -> FrameworkNode:
        node = FrameworkNode(
            node_id=new_id("node"),
            parent_id=parent_id,
            name=name,
            description=description,
            coverage_status="covered" if source_ids else "insufficient_source",
            source_ids=source_ids or [],
        )
        return self.upsert_framework_nodes(project_id, [node])[0]

    def update_framework_node(
        self,
        project_id: str,
        node_id: str,
        *,
        name: str,
        description: str,
        parent_id: str | None,
    ) -> FrameworkNode:
        node = self.get_framework_node(project_id, node_id)
        with self.transaction() as conn:
            conn.execute(
                """
                UPDATE framework_nodes
                SET name = ?, description = ?, parent_id = ?, updated_at = ?
                WHERE project_id = ? AND node_id = ?
                """,
                (name, description, parent_id, utc_now().isoformat(), project_id, node_id),
            )
        return node.model_copy(update={"name": name, "description": description, "parent_id": parent_id})

    def add_framework_prerequisites(
        self,
        project_id: str,
        node_id: str,
        prereq_ids: list[str],
    ) -> list[str]:
        """**追加**前置，返回追加后的完整列表。

        刻意只做并集：补建前置是一次 AI 建议 + 人工确认的动作，
        不能顺手把已有的（可能是用户自己标的）前置删掉 —— 宁可多留，不可误删。
        """
        node = self.get_framework_node(project_id, node_id)
        merged = list(node.prerequisite_ids)
        for pid in prereq_ids:
            pid = str(pid or "").strip()
            if pid and pid != node_id and pid not in merged:
                merged.append(pid)
        with self.transaction() as conn:
            conn.execute(
                "UPDATE framework_nodes SET prerequisite_ids = ?, updated_at = ?"
                " WHERE project_id = ? AND node_id = ?",
                (json.dumps(merged, ensure_ascii=False), utc_now().isoformat(), project_id, node_id),
            )
        return merged

    def update_node_note(
        self,
        project_id: str,
        node_id: str,
        *,
        note_content: str | None = None,
        tags: list[str] | None = None,
        wikilinks: list[str] | None = None,
    ) -> FrameworkNode:
        """个人知识库：更新节点的笔记正文、标签与双链目标。参数为 None 时保持原值。"""
        node = self.get_framework_node(project_id, node_id)
        note_content = node.note_content if note_content is None else note_content
        tags = node.tags if tags is None else tags
        wikilinks = node.wikilinks if wikilinks is None else wikilinks
        with self.transaction() as conn:
            conn.execute(
                """
                UPDATE framework_nodes
                SET note_content = ?, tags = ?, wikilinks = ?, updated_at = ?
                WHERE project_id = ? AND node_id = ?
                """,
                (
                    note_content,
                    json.dumps(tags, ensure_ascii=False),
                    json.dumps(wikilinks, ensure_ascii=False),
                    utc_now().isoformat(),
                    project_id,
                    node_id,
                ),
            )
        return node.model_copy(update={"note_content": note_content, "tags": tags, "wikilinks": wikilinks})

    def search_nodes(
        self,
        project_id: str,
        query: str | None = None,
        tag: str | None = None,
        limit: int = 50,
    ) -> list[FrameworkNode]:
        """按名称/描述/笔记正文/标签检索知识库节点；query 与 tag 可组合过滤。"""
        sql = "SELECT * FROM framework_nodes WHERE project_id = ?"
        params: list[Any] = [project_id]
        if query:
            like = f"%{query}%"
            sql += (
                " AND (name LIKE ? OR description LIKE ? OR note_content LIKE ? "
                "OR tags LIKE ?)"
            )
            params += [like, like, like, like]
        if tag:
            sql += " AND tags LIKE ?"
            params += [f'%"{tag}"%']
        sql += " ORDER BY parent_id IS NOT NULL, name LIMIT ?"
        params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        return [self._node_from_row(row) for row in rows]

    def get_backlinks(self, project_id: str, node_id: str, limit: int = 100) -> list[FrameworkNode]:
        """找到所有双链指向 node_id 的节点（反向链接）。双链按节点名存储，故按名反查。"""
        target = self.get_framework_node(project_id, node_id)
        candidates = self.list_framework_nodes(project_id)
        return [
            node
            for node in candidates
            if node.node_id != node_id and target.name in node.wikilinks
        ][:limit]

    @staticmethod
    def _link_pair(a_node_id: str, b_node_id: str) -> tuple[str, str]:
        """双链无方向：按字典序归一，保证 A↔B 与 B↔A 落到同一行。"""
        return (a_node_id, b_node_id) if a_node_id <= b_node_id else (b_node_id, a_node_id)

    def list_link_notes(self, project_id: str) -> list[dict[str, str]]:
        """列出项目内所有已填写的双链「理解」（只含非空行）。"""
        self.get_project(project_id)
        rows = self._conn.execute(
            """
            SELECT a_node_id, b_node_id, note, updated_at
            FROM node_link_notes
            WHERE project_id = ? AND note <> ''
            """,
            (project_id,),
        ).fetchall()
        return [
            {
                "a_node_id": row["a_node_id"],
                "b_node_id": row["b_node_id"],
                "note": row["note"],
                "updated_at": row["updated_at"],
            }
            for row in rows
        ]

    def set_link_note(
        self, project_id: str, a_node_id: str, b_node_id: str, note: str
    ) -> dict[str, str]:
        """写入一对双链的「理解」；note 清空即删除该行，不留空壳。"""
        self.get_project(project_id)
        if a_node_id == b_node_id:
            raise ValueError("双链两端不能是同一个节点")
        for nid in (a_node_id, b_node_id):
            self.get_framework_node(project_id, nid)
        a_id, b_id = self._link_pair(a_node_id, b_node_id)
        text = (note or "").strip()
        now = utc_now().isoformat()
        with self.transaction() as conn:
            if text:
                conn.execute(
                    """
                    INSERT INTO node_link_notes(project_id, a_node_id, b_node_id, note, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(project_id, a_node_id, b_node_id)
                    DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at
                    """,
                    (project_id, a_id, b_id, text, now),
                )
            else:
                conn.execute(
                    """
                    DELETE FROM node_link_notes
                    WHERE project_id = ? AND a_node_id = ? AND b_node_id = ?
                    """,
                    (project_id, a_id, b_id),
                )
        return {"a_node_id": a_id, "b_node_id": b_id, "note": text, "updated_at": now}

    def get_node_id_by_name(self, project_id: str, name: str) -> str | None:
        """按精确名称反查 node_id；不存在返回 None（用于双链解析）。"""
        rows = self._conn.execute(
            "SELECT node_id FROM framework_nodes WHERE project_id = ? AND name = ? LIMIT 1",
            (project_id, name),
        ).fetchone()
        return rows["node_id"] if rows else None

    def delete_framework_node(self, project_id: str, node_id: str) -> None:
        node = self.get_framework_node(project_id, node_id)
        with self.transaction() as conn:
            conn.execute(
                """
                UPDATE framework_nodes
                SET parent_id = ?, updated_at = ?
                WHERE project_id = ? AND parent_id = ?
                """,
                (node.parent_id, utc_now().isoformat(), project_id, node_id),
            )
            conn.execute(
                "DELETE FROM framework_nodes WHERE project_id = ? AND node_id = ?",
                (project_id, node_id),
            )

    def update_node_state(
        self,
        project_id: str,
        node_id: str,
        *,
        coverage_status: str | None = None,
        learning_status: str | None = None,
        mastery_score: float | None = None,
        transfer_score: float | None = None,
    ) -> FrameworkNode:
        node = self.get_framework_node(project_id, node_id)
        current_transfer = node.transfer_score
        updates = {
            "coverage_status": coverage_status or node.coverage_status,
            "learning_status": learning_status or node.learning_status,
            "mastery_score": node.mastery_score if mastery_score is None else max(0.0, min(1.0, mastery_score)),
            "transfer_score": (
                current_transfer
                if transfer_score is None
                else max(0.0, min(1.0, transfer_score))
            ),
        }
        with self.transaction() as conn:
            conn.execute(
                """
                UPDATE framework_nodes
                SET coverage_status = ?, learning_status = ?, mastery_score = ?,
                    transfer_score = ?, updated_at = ?
                WHERE project_id = ? AND node_id = ?
                """,
                (
                    updates["coverage_status"],
                    updates["learning_status"],
                    updates["mastery_score"],
                    updates["transfer_score"],
                    utc_now().isoformat(),
                    project_id,
                    node_id,
                ),
            )
        return node.model_copy(update=updates)

    def record_learning_event(
        self,
        project_id: str,
        node_id: str,
        kind: str,
        correctness: float | None,
        confidence: float,
        reference_id: str | None = None,
        self_confidence: float | None = None,
        difficulty: int | None = None,
        item_fingerprint: str | None = None,
    ) -> None:
        """写一条学习事件。

        confidence      = 节点映射置信度（LLM 把用户输入映射到框架节点的把握度），既有语义，不要改。
        self_confidence = 学习者自己勾的把握度（1.0 我确定 / 0.0 我不确定 / None 没勾）。
                          两者是两个构念：前者属于系统，后者属于人。下游的「过度自信」判据只读后者。
        difficulty      = 该次行为的难度档 1/2/3；None = 老数据/未标注，由 core/transfer.py 兜底成 D2。
        item_fingerprint= 题目指纹（题干归一后取 hash）。用于「同一道题第 N 遍」的边际递减，
                          不可靠就不传（传空串等价于不传）——**宁可少打折，不可乱打折**。
        """
        self.get_framework_node(project_id, node_id)
        clean_fp = str(item_fingerprint or "").strip()[:64] or None
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO learning_events(event_id, project_id, node_id, kind, correctness,
                    confidence, self_confidence, reference_id, difficulty, item_fingerprint, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    new_id("evt"),
                    project_id,
                    node_id,
                    kind,
                    correctness,
                    confidence,
                    self_confidence,
                    reference_id,
                    int(difficulty) if difficulty is not None else None,
                    clean_fp,
                    utc_now().isoformat(),
                ),
            )

    def set_learning_event_error_type(
        self,
        project_id: str,
        reference_id: str,
        error_type: str | None,
    ) -> int:
        """补写错因：按 (project_id, reference_id) 找到那条事件并写 error_type。

        为什么是「改一行」而不是「再记一条事件」：错因描述的是**那一次答题**为什么错，
        再记一条事件会被下游当成一次新的练习证据（重复计分、污染 BKT）。
        可重复调用 —— 学习者改主意就把旧值覆盖掉，最后写的算数。

        返回受影响的行数；0 表示没有匹配的事件（比如测验已被删），调用方据此如实回话。
        """
        if error_type is not None and not str(error_type).strip():
            error_type = None
        with self.transaction() as conn:
            cur = conn.execute(
                "UPDATE learning_events SET error_type = ?"
                " WHERE project_id = ? AND reference_id = ?",
                (error_type, project_id, reference_id),
            )
            return int(cur.rowcount or 0)

    def list_learning_events(
        self,
        project_id: str,
        *,
        node_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """
        查询项目下所有（或指定 node_id 的）学习事件。
        用于掌握度明细回放 + 前端审计 trail。
        """
        self.get_project(project_id)
        sql = (
            "SELECT event_id, node_id, kind, correctness, confidence, self_confidence,"
            " error_type, reference_id, difficulty, item_fingerprint, created_at "
            "FROM learning_events WHERE project_id = ?"
        )
        params: list[Any] = [project_id]
        if node_id is not None:
            sql += " AND node_id = ?"
            params.append(node_id)
        sql += " ORDER BY created_at ASC, event_id ASC"
        keys = self._conn.execute(sql, params).description or ()
        names = {str(item[0]) for item in keys}
        rows = self._conn.execute(sql, params).fetchall()
        return [
            {
                "event_id": r["event_id"],
                "node_id": r["node_id"],
                "kind": r["kind"],
                "correctness": (None if r["correctness"] is None else float(r["correctness"])),
                "confidence": float(r["confidence"]),
                "self_confidence": (
                    None if r["self_confidence"] is None else float(r["self_confidence"])
                ),
                "error_type": r["error_type"],
                "reference_id": r["reference_id"],
                # 老库升级后这两列可能为 NULL：如实给 None，让 core/transfer.py
                # 走兜底，而不是在这里编一个 2 出来冒充「它确实是 D2」。
                "difficulty": (int(r["difficulty"]) if "difficulty" in names and r["difficulty"] is not None else None),
                "item_fingerprint": (
                    r["item_fingerprint"] if "item_fingerprint" in names else None
                ),
                "created_at": r["created_at"],
            }
            for r in rows
        ]

    def list_user_activity_dates(self, owner_id: str) -> list[str]:
        """Return distinct UTC dates (YYYY-MM-DD) where the user has any learning event,
        sorted descending. Read-only; used by the streak API. Cheap because events have a
        leading ISO timestamp and the DISTINCT operates on a 10-char prefix index scan.
        """
        rows = self._conn.execute(
            """
            SELECT DISTINCT substr(e.created_at, 1, 10) AS activity_date
            FROM learning_events e
            JOIN projects p ON p.project_id = e.project_id
            WHERE p.owner_id = ?
              AND e.created_at IS NOT NULL
              AND length(e.created_at) >= 10
            ORDER BY activity_date DESC
            """,
            (owner_id,),
        ).fetchall()
        return [r["activity_date"] for r in rows if r["activity_date"]]

    def list_user_learning_calendar(self, owner_id: str, days: int) -> dict[str, Any]:
        """Return per-day learning aggregates for the last ``days`` UTC dates.

        ponytail: 数据来自既有的 learning_events，不新增表；只 GROUP BY 日期并补两个
        LEFT JOIN（projects.subject / framework_nodes.name），规模受 days 上限控制，
        典型 30~120 天 ≈ 几千行 O(n) 扫描，对本地 SQLite 毫秒级。
        """
        window = max(1, min(int(days), 365))
        today = date.today()  # 本地零点到 UTC 边界的换算由调用方控制；这里只用来给前端画格子起点
        from_date = today - timedelta(days=window - 1)
        from_iso = from_date.isoformat()
        rows = self._conn.execute(
            """
            SELECT
                substr(e.created_at, 1, 10) AS activity_date,
                e.kind                                  AS kind,
                e.node_id                               AS node_id,
                n.name                                  AS node_name,
                e.project_id                            AS project_id,
                p.subject                               AS project_name,
                e.correctness                           AS correctness
            FROM learning_events e
            JOIN projects p ON p.project_id = e.project_id
            LEFT JOIN framework_nodes n
                ON n.project_id = e.project_id AND n.node_id = e.node_id
            WHERE p.owner_id = ?
              AND e.created_at IS NOT NULL
              AND length(e.created_at) >= 10
              AND substr(e.created_at, 1, 10) >= ?
            """,
            (owner_id, from_iso),
        ).fetchall()
        # ponytail: 一次性 in-memory 分桶；不要为了「优化」再加临时表 —— 单用户场景不值得
        days_map: dict[str, dict[str, Any]] = {}
        for r in rows:
            date_key = r["activity_date"]
            bucket = days_map.get(date_key)
            if bucket is None:
                bucket = {
                    "date": date_key,
                    "event_count": 0,
                    "distinct_projects": set(),
                    "project_names": [],
                    "kinds": {},
                    "node_counts": {},
                    "_correct_sum": 0.0,
                    "_correct_n": 0,
                }
                days_map[date_key] = bucket
            bucket["event_count"] += 1
            kind = r["kind"] or "unknown"
            bucket["kinds"][kind] = bucket["kinds"].get(kind, 0) + 1
            project_name = r["project_name"] or "未命名课程"
            if project_name not in bucket["distinct_projects"]:
                bucket["distinct_projects"].add(project_name)
                bucket["project_names"].append(project_name)
            node_name = r["node_name"] or r["node_id"] or "未分类"
            nc = bucket["node_counts"]
            nc[node_name] = nc.get(node_name, 0) + 1
            # 正确率只用 quiz/solve（question/highlight 不带数值 correctness）
            if r["correctness"] is not None and kind in ("quiz", "solve"):
                bucket["_correct_sum"] += float(r["correctness"])
                bucket["_correct_n"] += 1

        # 排序 + 裁剪 top_nodes，避免响应体无限增长
        out: dict[str, Any] = {}
        total_events = 0
        for date_key, bucket in days_map.items():
            ranked_nodes = sorted(
                bucket["node_counts"].items(), key=lambda x: x[1], reverse=True
            )
            top_nodes = [name for name, _ in ranked_nodes[:5]]
            correct_rate = (
                round(bucket["_correct_sum"] / bucket["_correct_n"], 3)
                if bucket["_correct_n"] > 0
                else None
            )
            total_events += bucket["event_count"]
            out[date_key] = {
                "date": date_key,
                "event_count": bucket["event_count"],
                "distinct_projects": len(bucket["distinct_projects"]),
                "project_names": bucket["project_names"],
                "kinds": bucket["kinds"],
                "correct_rate": correct_rate,
                "top_nodes": top_nodes,
            }
        return {
            "from_date": from_iso,
            "to_date": today.isoformat(),
            "days": window,
            "total_events": total_events,
            "active_dates": sorted(days_map.keys(), reverse=True),
            "days_detail": out,
        }

    def list_user_day_events(
        self,
        owner_id: str,
        activity_date: str,
        limit: int = 80,
    ) -> list[dict[str, Any]]:
        """Return learning events for one UTC date for the given user.

        ponytail: 同一个 JOIN 复用 list_user_learning_calendar 的形状；只查一天，
        LIMIT 上限 200，避免有人手抖把整库拉回来炸前端。
        """
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", activity_date or ""):
            return []
        capped = max(1, min(int(limit), 200))
        rows = self._conn.execute(
            """
            SELECT
                e.event_id,
                e.node_id,
                e.kind,
                e.correctness,
                e.confidence,
                e.reference_id,
                e.created_at,
                n.name       AS node_name,
                e.project_id,
                p.subject    AS project_name
            FROM learning_events e
            JOIN projects p ON p.project_id = e.project_id
            LEFT JOIN framework_nodes n
                ON n.project_id = e.project_id AND n.node_id = e.node_id
            WHERE p.owner_id = ?
              AND substr(e.created_at, 1, 10) = ?
            ORDER BY e.created_at DESC
            LIMIT ?
            """,
            (owner_id, activity_date, capped),
        ).fetchall()
        # ponytail: 同日的 user 消息带回。question / solve 事件优先按 reference_id 硬关联
        # （落库时就把提问消息 id 写进去了）；只有历史事件 reference_id 为空时才退回 ±15 秒
        # 最近邻匹配。范围太小不上 SQL 关联子查询，Python 端 O(E·M) ≈ 微秒级。
        message_rows: list[Any] = []
        if rows:
            project_ids = list({r["project_id"] for r in rows})
            placeholder = ",".join("?" * len(project_ids))
            message_rows = self._conn.execute(
                f"""
                SELECT message_id, project_id, content, created_at
                FROM messages
                WHERE role = 'user'
                  AND substr(created_at, 1, 10) = ?
                  AND project_id IN ({placeholder})
                """,
                [activity_date, *project_ids],
            ).fetchall()

        def _parse(s: str) -> datetime:
            try:
                return datetime.fromisoformat(s.replace(" ", "T") if (s and "T" not in s) else s)
            except Exception:
                return datetime.fromtimestamp(0)

        by_message_id = {m["message_id"]: m for m in message_rows}
        out: list[dict[str, Any]] = []
        for r in rows:
            ts = r["created_at"] or ""
            content = None
            message_id = None
            if r["kind"] in ("question", "solve"):
                # 首选硬关联：新事件在落库时已把提问消息 id 写进 reference_id。
                linked = by_message_id.get(r["reference_id"]) if r["reference_id"] else None
                if linked is not None:
                    content = linked["content"]
                    message_id = linked["message_id"]
                else:
                    # 兜底只服务历史事件（那些还没有 reference_id 的）：±15 秒最近邻匹配，
                    # 命中率低但聊胜于无。新事件不该再走到这里。
                    et = _parse(ts)
                    best_dt = None
                    for m in message_rows:
                        if m["project_id"] != r["project_id"]:
                            continue
                        mt = _parse(m["created_at"] or "")
                        delta = abs((et - mt).total_seconds())
                        if delta <= 15 and (best_dt is None or delta < best_dt):
                            best_dt = delta
                            content = m["content"]
                            message_id = m["message_id"]
            out.append({
                "event_id": r["event_id"],
                "time": ts[11:16] if len(ts) >= 16 else "",
                "created_at": ts,
                "kind": r["kind"] or "unknown",
                "correctness": (None if r["correctness"] is None else float(r["correctness"])),
                "confidence": float(r["confidence"]) if r["confidence"] is not None else None,
                "reference_id": r["reference_id"],
                "node_id": r["node_id"],
                "node_name": r["node_name"] or r["node_id"] or "未分类",
                "project_id": r["project_id"],
                "project_name": r["project_name"] or "未命名课程",
                "content": content,
                "message_id": message_id,
            })
        return out

    def add_message(
        self,
        project_id: str,
        role: str,
        content: str,
        node_ids: list[str] | None = None,
        source_ids: list[str] | None = None,
        conversation_id: str | None = None,
        meta: dict[str, Any] | None = None,
    ) -> Message:
        self.get_project(project_id)
        message_id = new_id("msg")
        created_at = utc_now()
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO messages(message_id, project_id, role, content, node_ids, source_ids, conversation_id, meta, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    message_id,
                    project_id,
                    role,
                    content,
                    json.dumps(node_ids or [], ensure_ascii=False),
                    json.dumps(source_ids or [], ensure_ascii=False),
                    conversation_id or "",
                    json.dumps(meta or {}, ensure_ascii=False),
                    created_at.isoformat(),
                ),
            )
        return Message(
            message_id=message_id,
            project_id=project_id,
            role=role,
            content=content,
            node_ids=node_ids or [],
            source_ids=source_ids or [],
            conversation_id=conversation_id or "",
            meta=meta or {},
            created_at=created_at,
        )

    def get_message(self, project_id: str, message_id: str) -> Message:
        self.get_project(project_id)
        row = self._conn.execute(
            "SELECT * FROM messages WHERE project_id = ? AND message_id = ?",
            (project_id, message_id),
        ).fetchone()
        if row is None:
            raise KeyError(message_id)
        return self._message_from_row(row)

    def list_messages(
        self, project_id: str, conversation_id: str | None = None
    ) -> list[Message]:
        """列出消息；conversation_id=None 返回全部，"" 仅主界面问答，其他仅指定会话。"""
        self.get_project(project_id)
        if conversation_id is None:
            rows = self._conn.execute(
                "SELECT * FROM messages WHERE project_id = ? ORDER BY created_at ASC",
                (project_id,),
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT * FROM messages WHERE project_id = ? AND conversation_id = ? "
                "ORDER BY created_at ASC, rowid ASC",
                (project_id, conversation_id),
            ).fetchall()
        return [self._message_from_row(row) for row in rows]

    def list_conversation_messages(
        self, project_id: str, conversation_id: str
    ) -> list[Message]:
        self.get_project(project_id)
        rows = self._conn.execute(
            "SELECT * FROM messages WHERE project_id = ? AND conversation_id = ? "
            "ORDER BY created_at ASC, rowid ASC",
            (project_id, conversation_id),
        ).fetchall()
        return [self._message_from_row(row) for row in rows]

    def delete_messages(self, project_id: str, message_ids: list[str]) -> list[str]:
        self.get_project(project_id)
        unique_ids = list(dict.fromkeys(message_id for message_id in message_ids if message_id))
        if not unique_ids:
            return []
        placeholders = ", ".join("?" for _ in unique_ids)
        rows = self._conn.execute(
            f"SELECT message_id FROM messages WHERE project_id = ? AND message_id IN ({placeholders})",
            (project_id, *unique_ids),
        ).fetchall()
        deleted_ids = [row["message_id"] for row in rows]
        if not deleted_ids:
            return []
        delete_placeholders = ", ".join("?" for _ in deleted_ids)
        with self.transaction() as conn:
            conn.execute(
                f"DELETE FROM messages WHERE project_id = ? AND message_id IN ({delete_placeholders})",
                (project_id, *deleted_ids),
            )
        return deleted_ids

    def _message_from_row(self, row: sqlite3.Row) -> Message:
        return Message(
            message_id=row["message_id"],
            project_id=row["project_id"],
            role=row["role"],
            content=row["content"],
            node_ids=_loads_list(row["node_ids"]),
            source_ids=_loads_list(row["source_ids"]),
            conversation_id=row["conversation_id"] or "",
            meta=_loads_dict(row["meta"]),
            created_at=datetime.fromisoformat(row["created_at"]),
        )

    # —— 主界面问答会话（Agent 布局：每个项目多条会话）——
    CHAT_SESSION_TITLE_MAX = 40

    @classmethod
    def _chat_session_title_from_message(cls, content: str) -> str:
        """用首条用户提问兜底出会话标题（单行、限长）。"""
        return " ".join((content or "").split())[: cls.CHAT_SESSION_TITLE_MAX]

    def create_chat_session(self, project_id: str, title: str = "") -> dict[str, Any]:
        self.get_project(project_id)
        session_id = new_id("csess")
        now = utc_now().isoformat()
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO chat_sessions(session_id, project_id, title, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (session_id, project_id, title or "", now, now),
            )
        return self._chat_session_row(session_id) or {}

    def _chat_session_row(self, session_id: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT * FROM chat_sessions WHERE session_id = ?", (session_id,)
        ).fetchone()
        if row is None:
            return None
        return {
            "session_id": row["session_id"],
            "project_id": row["project_id"],
            "title": row["title"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def get_chat_session(self, project_id: str, session_id: str) -> dict[str, Any] | None:
        """取会话并校验归属：不属于该项目就当不存在（不泄露存在性）。"""
        self.get_project(project_id)
        row = self._chat_session_row(session_id)
        if row is None or row["project_id"] != project_id:
            return None
        return row

    def rename_chat_session(self, project_id: str, session_id: str, title: str) -> dict[str, Any] | None:
        self.get_project(project_id)
        row = self._chat_session_row(session_id)
        if row is None or row["project_id"] != project_id:
            return None
        now = utc_now().isoformat()
        with self.transaction() as conn:
            conn.execute(
                "UPDATE chat_sessions SET title = ?, updated_at = ? WHERE session_id = ?",
                (title or "", now, session_id),
            )
        return self._chat_session_row(session_id)

    def delete_chat_session(self, project_id: str, session_id: str) -> list[str]:
        """删会话壳 + 该会话内的消息，返回被删的 message_id（供撤销栈回滚）。"""
        self.get_project(project_id)
        row = self._chat_session_row(session_id)
        if row is None or row["project_id"] != project_id:
            return []
        messages = self.list_messages(project_id, conversation_id=session_id)
        with self.transaction() as conn:
            conn.execute(
                "DELETE FROM messages WHERE project_id = ? AND conversation_id = ?",
                (project_id, session_id),
            )
            conn.execute("DELETE FROM chat_sessions WHERE session_id = ?", (session_id,))
        return [message.message_id for message in messages]

    def touch_chat_session(self, project_id: str, session_id: str) -> None:
        """有新消息：刷新 updated_at；标题空着就用首条用户提问补上。"""
        if not session_id:
            return
        row = self._chat_session_row(session_id)
        if row is None or row["project_id"] != project_id:
            return
        now = utc_now().isoformat()
        title = row["title"]
        if not title:
            title = self._chat_session_title_from_message(
                self._first_user_message_content(project_id, session_id)
            )
        with self.transaction() as conn:
            conn.execute(
                "UPDATE chat_sessions SET updated_at = ?, title = ? WHERE session_id = ?",
                (now, title, session_id),
            )

    def _first_user_message_content(self, project_id: str, session_id: str) -> str:
        row = self._conn.execute(
            "SELECT content FROM messages WHERE project_id = ? AND conversation_id = ? "
            "AND role = 'user' ORDER BY created_at ASC, rowid ASC LIMIT 1",
            (project_id, session_id),
        ).fetchone()
        return (row["content"] if row else "") or ""

    def list_chat_sessions(self, project_id: str) -> list[dict[str, Any]]:
        """列出项目下的主界面会话，按最近活跃倒序。

        session_ids 取「有消息的 conversation_id」与「登记过的会话壳」的**并集**：
        刚建好还没说过一句话的会话也要列出来，否则刷新页面后「新建会话」会凭空消失。
        """
        self.get_project(project_id)
        # ⚠️ 这里不要用 NOT LIKE 'conv\_%' ESCAPE '\'：LIKE 转义符在不同 SQLite 构建上语义
        # 有细微差别，而这条查询在「打开项目」的关键路径上，抛错就表现为「项目加载不出来」。
        # substr(col,1,5) <> 'conv_' 行为确定。conv_ 前缀是「整理助手」会话（走 kb_conversations）。
        rows = self._conn.execute(
            "SELECT conversation_id, COUNT(*) AS message_count, "
            "MAX(created_at) AS last_message_at, MIN(created_at) AS first_message_at "
            "FROM messages WHERE project_id = ? AND substr(conversation_id, 1, 5) <> 'conv_' "
            "GROUP BY conversation_id",
            (project_id,),
        ).fetchall()
        stats_by_id: dict[str, dict[str, Any]] = {}
        for row in rows:
            stats_by_id[row["conversation_id"]] = {
                "message_count": int(row["message_count"] or 0),
                "first_message_at": row["first_message_at"],
                "last_message_at": row["last_message_at"],
            }
        shells: dict[str, dict[str, Any]] = {}
        for shell in self._conn.execute(
            "SELECT * FROM chat_sessions WHERE project_id = ?", (project_id,)
        ).fetchall():
            shells[shell["session_id"]] = {
                "session_id": shell["session_id"],
                "project_id": shell["project_id"],
                "title": shell["title"],
                "message_count": 0,
                "created_at": shell["created_at"],
                "updated_at": shell["updated_at"],
            }
        for session_id, stats in stats_by_id.items():
            shell = shells.get(session_id)
            if shell is None:
                # 没登记过壳的（老数据的单线程 conversation_id=''、或手写的 id）：
                # 用消息时间兜底排序字段，标题同样按首条提问兜底
                shells[session_id] = {
                    "session_id": session_id,
                    "project_id": project_id,
                    "title": self._chat_session_title_from_message(
                        self._first_user_message_content(project_id, session_id)
                    ),
                    "message_count": stats["message_count"],
                    "created_at": stats["first_message_at"] or "",
                    "updated_at": stats["last_message_at"] or "",
                }
                continue
            shell["message_count"] = stats["message_count"]
            if not shell["title"]:
                shell["title"] = self._chat_session_title_from_message(
                    self._first_user_message_content(project_id, session_id)
                )
        return sorted(
            shells.values(),
            key=lambda item: (item.get("updated_at") or "", item.get("session_id") or ""),
            reverse=True,
        )

    # —— 整理助手会话 ——
    def create_conversation(self, project_id: str, user_id: str, title: str = "", node_id: str = "") -> dict[str, Any]:
        self.get_project(project_id)
        conversation_id = new_id("conv")
        now = utc_now().isoformat()
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO kb_conversations(conversation_id, project_id, user_id, node_id, title, summary, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (conversation_id, project_id, user_id, node_id, title, "{}", now, now),
            )
        return self.get_conversation(conversation_id)

    def get_conversation(self, conversation_id: str) -> dict[str, Any]:
        row = self._conn.execute(
            "SELECT * FROM kb_conversations WHERE conversation_id = ?", (conversation_id,)
        ).fetchone()
        if row is None:
            raise KeyError(conversation_id)
        return self._conversation_row_dict(row)

    def update_conversation_summary(self, conversation_id: str, summary: dict[str, Any]) -> dict[str, Any]:
        with self.transaction() as conn:
            conn.execute(
                "UPDATE kb_conversations SET summary = ?, updated_at = ? WHERE conversation_id = ?",
                (json.dumps(summary or {}, ensure_ascii=False), utc_now().isoformat(), conversation_id),
            )
        return self.get_conversation(conversation_id)

    def list_conversations(self, project_id: str, node_id: str = "", limit: int = 50) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT * FROM kb_conversations WHERE project_id = ? AND node_id = ? ORDER BY updated_at DESC LIMIT ?",
            (project_id, node_id, limit),
        ).fetchall()
        return [self._conversation_row_dict(r) for r in rows]

    def delete_conversation(self, conversation_id: str) -> None:
        with self.transaction() as conn:
            conn.execute("DELETE FROM kb_conversations WHERE conversation_id = ?", (conversation_id,))

    @staticmethod
    def _conversation_row_dict(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "conversation_id": row["conversation_id"],
            "project_id": row["project_id"],
            "user_id": row["user_id"],
            "node_id": row["node_id"],
            "title": row["title"],
            "summary": _loads_dict(row["summary"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    # —— 库级摘要索引 ——
    def get_digest(self, project_id: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT * FROM kb_digests WHERE project_id = ?", (project_id,)
        ).fetchone()
        if row is None:
            return None
        payload = _loads_dict(row["payload"])
        return {
            **payload,
            "project_id": row["project_id"],
            "version": row["version"],
            "generated_at": row["generated_at"],
        }

    def upsert_digest(self, project_id: str, version: int, payload: dict[str, Any]) -> dict[str, Any]:
        now = utc_now().isoformat()
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO kb_digests(project_id, version, payload, generated_at, schema_version) "
                "VALUES (?, ?, ?, ?, 1) "
                "ON CONFLICT(project_id) DO UPDATE SET "
                "version=excluded.version, payload=excluded.payload, generated_at=excluded.generated_at",
                (project_id, version, json.dumps(payload, ensure_ascii=False), now),
            )
        return self.get_digest(project_id)

    # —— AI 代写笔记建议稿（审批流） ——
    def create_proposal(
        self,
        project_id: str,
        node_id: str,
        proposed_action: str,
        proposed_content: str,
        *,
        type_: str = "add_note",
        reason: str = "",
        rollback: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        proposal_id = new_id("prop")
        now = utc_now().isoformat()
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO note_proposals(proposal_id, project_id, node_id, proposed_action, proposed_content, status, user_edits, created_at, type, reason, rollback) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (proposal_id, project_id, node_id, proposed_action, proposed_content, "pending", "{}", now,
                 type_, reason, json.dumps(rollback if rollback is not None else {}, ensure_ascii=False)),
            )
        return self.get_proposal(project_id, proposal_id)

    def get_proposal(self, project_id: str, proposal_id: str) -> dict[str, Any]:
        row = self._conn.execute(
            "SELECT * FROM note_proposals WHERE project_id = ? AND proposal_id = ?",
            (project_id, proposal_id),
        ).fetchone()
        if row is None:
            raise KeyError(proposal_id)
        return self._proposal_row_dict(row)

    def list_proposals(
        self, project_id: str, status: str | None = None, limit: int = 200, node_id: str | None = None
    ) -> list[dict[str, Any]]:
        sql = "SELECT * FROM note_proposals WHERE project_id = ?"
        params: list[Any] = [project_id]
        if status:
            sql += " AND status = ?"
            params.append(status)
        if node_id:
            sql += " AND node_id = ?"
            params.append(node_id)
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        rows = self._conn.execute(sql, params).fetchall()
        return [self._proposal_row_dict(r) for r in rows]


    # —— 会话内苏格拉底引导状态 ——
    def get_socratic_state(self, conversation_id: str, node_id: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT * FROM node_socratic_state WHERE conversation_id = ? AND node_id = ?",
            (conversation_id, node_id),
        ).fetchone()
        if row is None:
            return None
        return {
            "conversation_id": row["conversation_id"],
            "node_id": row["node_id"],
            "verdict": row["verdict"],
            "miscue": row["miscue"],
            "hint_level": row["hint_level"],
            "mastery_after": row["mastery_after"],
            "iter_count": row["iter_count"],
            "convergence": row["convergence"],
            "updated_at": row["updated_at"],
        }

    def upsert_socratic_state(
        self,
        conversation_id: str,
        node_id: str,
        *,
        verdict: str | None = None,
        miscue: str | None = None,
        hint_level: int | None = None,
        mastery_after: float | None = None,
        iter_count: int | None = None,
        convergence: str | None = None,
    ) -> dict[str, Any]:
        now = utc_now().isoformat()
        current = self.get_socratic_state(conversation_id, node_id)
        new = {
            "verdict": verdict if verdict is not None else (current or {}).get("verdict", "unknown"),
            "miscue": miscue if miscue is not None else (current or {}).get("miscue", ""),
            "hint_level": hint_level if hint_level is not None else (current or {}).get("hint_level", 0),
            "mastery_after": mastery_after if mastery_after is not None else (current or {}).get("mastery_after", 0.0),
            "iter_count": iter_count if iter_count is not None else (current or {}).get("iter_count", 0),
            "convergence": convergence if convergence is not None else (current or {}).get("convergence", "open"),
        }
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO node_socratic_state(conversation_id, node_id, verdict, miscue, hint_level, mastery_after, iter_count, convergence, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(conversation_id, node_id) DO UPDATE SET "
                "verdict=excluded.verdict, miscue=excluded.miscue, hint_level=excluded.hint_level, "
                "mastery_after=excluded.mastery_after, iter_count=excluded.iter_count, "
                "convergence=excluded.convergence, updated_at=excluded.updated_at",
                (
                    conversation_id, node_id, new["verdict"], new["miscue"], new["hint_level"],
                    new["mastery_after"], new["iter_count"], new["convergence"], now,
                ),
            )
        return self.get_socratic_state(conversation_id, node_id)


    def update_proposal(
        self,
        project_id: str,
        proposal_id: str,
        *,
        status: str | None = None,
        user_edits: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        current = self.get_proposal(project_id, proposal_id)
        new_status = status if status else current["status"]
        new_edits = current["user_edits"] if user_edits is None else user_edits
        applied_at = current["applied_at"]
        if new_status in ("accepted", "edited") and not applied_at:
            applied_at = utc_now().isoformat()
        with self.transaction() as conn:
            conn.execute(
                "UPDATE note_proposals SET status = ?, user_edits = ?, applied_at = ? WHERE project_id = ? AND proposal_id = ?",
                (new_status, json.dumps(new_edits, ensure_ascii=False), applied_at, project_id, proposal_id),
            )
        return self.get_proposal(project_id, proposal_id)

    @staticmethod
    def _proposal_row_dict(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "proposal_id": row["proposal_id"],
            "project_id": row["project_id"],
            "node_id": row["node_id"],
            "proposed_action": row["proposed_action"],
            "proposed_content": row["proposed_content"],
            "status": row["status"],
            "user_edits": _loads_dict(row["user_edits"]),
            "created_at": row["created_at"],
            "applied_at": row["applied_at"],
            "type": row["type"] if "type" in row.keys() else "add_note",
            "reason": row["reason"] if "reason" in row.keys() else "",
            "rollback": _loads_dict(row["rollback"]) if "rollback" in row.keys() else {},
        }

    def add_cards(self, project_id: str, cards: list[Card]) -> list[Card]:
        self.get_project(project_id)
        saved: list[Card] = []
        with self.transaction() as conn:
            for card in cards:
                card_id = card.card_id or new_id("card")
                saved_card = card.model_copy(update={"card_id": card_id})
                conn.execute(
                    "INSERT INTO cards(card_id, project_id, payload, created_at) VALUES (?, ?, ?, ?)",
                    (card_id, project_id, json.dumps(model_to_dict(saved_card), ensure_ascii=False), utc_now().isoformat()),
                )
                saved.append(saved_card)
        return saved

    def list_cards(self, project_id: str) -> list[Card]:
        self.get_project(project_id)
        rows = self._conn.execute(
            "SELECT payload FROM cards WHERE project_id = ? ORDER BY created_at ASC",
            (project_id,),
        ).fetchall()
        return [Card(**json.loads(row["payload"])) for row in rows]

    def get_card(self, project_id: str, card_id: str) -> Card:
        self.get_project(project_id)
        row = self._conn.execute(
            "SELECT payload FROM cards WHERE project_id = ? AND card_id = ?",
            (project_id, card_id),
        ).fetchone()
        if row is None:
            raise KeyError(card_id)
        return Card(**json.loads(row["payload"]))

    def update_card_front(self, project_id: str, card_id: str, front: str) -> Card:
        card = self.get_card(project_id, card_id).model_copy(update={"front": front})
        now = utc_now().isoformat()
        with self.transaction() as conn:
            conn.execute(
                "UPDATE cards SET payload = ? WHERE project_id = ? AND card_id = ?",
                (json.dumps(model_to_dict(card), ensure_ascii=False), project_id, card_id),
            )
            conn.execute(
                """
                UPDATE favorites SET title = ?, content = ?, updated_at = ?
                WHERE project_id = ? AND item_type = 'card' AND origin_id = ?
                """,
                (front, front, now, project_id, card_id),
            )
        return card

    def delete_card(self, project_id: str, card_id: str) -> None:
        self.get_card(project_id, card_id)
        with self.transaction() as conn:
            conn.execute("DELETE FROM cards WHERE project_id = ? AND card_id = ?", (project_id, card_id))
            conn.execute(
                "DELETE FROM favorites WHERE project_id = ? AND item_type = 'card' AND origin_id = ?",
                (project_id, card_id),
            )

    def upsert_card(self, project_id: str, card: dict) -> bool:
        """按 card_id 写入一张卡；已存在则覆盖 payload。返回 True 表示这是更新而非新建。

        刻意用 INSERT OR REPLACE 而不是 delete + insert：``card_srs_state`` / ``card_review_log``
        是按 card_id 关联的独立表，替换 cards 行不会动它们，所以已排期的卡重新生成后
        仍在原来的复习节奏上。先删后插会把用户的 FSRS 进度洗掉。
        """
        self.get_project(project_id)
        card_id = str(card.get("card_id") or "")
        if not card_id:
            raise ValueError("card_id 不能为空")
        now = utc_now().isoformat()
        with self.transaction() as conn:
            row = conn.execute(
                "SELECT created_at FROM cards WHERE project_id = ? AND card_id = ?",
                (project_id, card_id),
            ).fetchone()
            conn.execute(
                "INSERT OR REPLACE INTO cards(card_id, project_id, payload, created_at)"
                " VALUES (?, ?, ?, ?)",
                (
                    card_id,
                    project_id,
                    json.dumps(card, ensure_ascii=False),
                    (row["created_at"] if row is not None else now),
                ),
            )
        return row is not None

    def add_quiz(self, project_id: str, payload: dict) -> str:
        self.get_project(project_id)
        quiz_id = payload.get("quiz_id") or new_id("quiz")
        payload["quiz_id"] = quiz_id
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO quizzes(quiz_id, project_id, payload, created_at) VALUES (?, ?, ?, ?)",
                (quiz_id, project_id, json.dumps(payload, ensure_ascii=False), utc_now().isoformat()),
            )
        return quiz_id

    def get_quiz(self, project_id: str, quiz_id: str) -> dict:
        self.get_project(project_id)
        row = self._conn.execute(
            "SELECT payload FROM quizzes WHERE project_id = ? AND quiz_id = ?", (project_id, quiz_id)
        ).fetchone()
        if row is None:
            raise KeyError(quiz_id)
        return json.loads(row["payload"])

    def get_latest_quiz(self, project_id: str) -> dict | None:
        self.get_project(project_id)
        row = self._conn.execute(
            """
            SELECT quiz_id, payload, created_at, submitted_at, score
            FROM quizzes
            WHERE project_id = ?
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (project_id,),
        ).fetchone()
        if row is None:
            return None
        payload = json.loads(row["payload"])
        payload["quiz_id"] = row["quiz_id"]
        payload["created_at"] = row["created_at"]
        payload["submitted_at"] = row["submitted_at"]
        payload["score"] = row["score"]
        return payload

    def list_recent_quizzes(self, project_id: str, limit: int = 20) -> list[dict]:
        self.get_project(project_id)
        rows = self._conn.execute(
            """
            SELECT quiz_id, payload, created_at, submitted_at, score
            FROM quizzes
            WHERE project_id = ?
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (project_id, max(1, int(limit))),
        ).fetchall()
        quizzes: list[dict] = []
        for row in rows:
            payload = json.loads(row["payload"])
            payload.update(
                quiz_id=row["quiz_id"],
                created_at=row["created_at"],
                submitted_at=row["submitted_at"],
                score=row["score"],
            )
            quizzes.append(payload)
        return quizzes

    def list_all_quizzes(self, project_id: str) -> list[dict]:
        """返回该项目全部小测验（不限条数），供知识库导出等一次性全量读取使用。

        与 ``list_recent_quizzes`` 同构，只是去掉 LIMIT —— 导出要的是整库，
        而不是最近 20 条。
        """
        self.get_project(project_id)
        rows = self._conn.execute(
            """
            SELECT quiz_id, payload, created_at, submitted_at, score
            FROM quizzes
            WHERE project_id = ?
            ORDER BY created_at DESC
            """,
            (project_id,),
        ).fetchall()
        quizzes: list[dict] = []
        for row in rows:
            payload = json.loads(row["payload"])
            payload.update(
                quiz_id=row["quiz_id"],
                created_at=row["created_at"],
                submitted_at=row["submitted_at"],
                score=row["score"],
            )
            quizzes.append(payload)
        return quizzes

    def update_quiz_question(self, project_id: str, quiz_id: str, question_index: int, title: str) -> dict:
        quiz = self.get_quiz(project_id, quiz_id)
        questions = list(quiz.get("questions") or [])
        if question_index < 0 or question_index >= len(questions):
            raise IndexError(question_index)
        questions[question_index] = {**questions[question_index], "question": title}
        quiz["questions"] = questions
        origin_id = f"{quiz_id}:{question_index}"
        now = utc_now().isoformat()
        with self.transaction() as conn:
            conn.execute(
                "UPDATE quizzes SET payload = ? WHERE project_id = ? AND quiz_id = ?",
                (json.dumps(quiz, ensure_ascii=False), project_id, quiz_id),
            )
            conn.execute(
                """
                UPDATE favorites SET title = ?, content = ?, updated_at = ?
                WHERE project_id = ? AND item_type = 'quiz' AND origin_id = ?
                """,
                (title, title, now, project_id, origin_id),
            )
        return questions[question_index]

    def delete_quiz_question(self, project_id: str, quiz_id: str, question_index: int) -> dict:
        quiz = self.get_quiz(project_id, quiz_id)
        questions = list(quiz.get("questions") or [])
        if question_index < 0 or question_index >= len(questions):
            raise IndexError(question_index)
        removed = questions.pop(question_index)
        quiz["questions"] = questions
        with self.transaction() as conn:
            conn.execute(
                "UPDATE quizzes SET payload = ? WHERE project_id = ? AND quiz_id = ?",
                (json.dumps(quiz, ensure_ascii=False), project_id, quiz_id),
            )
            rows = conn.execute(
                "SELECT favorite_id, origin_id FROM favorites WHERE project_id = ? AND item_type = 'quiz'",
                (project_id,),
            ).fetchall()
            indexed: list[tuple[str, int]] = []
            for row in rows:
                prefix, separator, raw_index = row["origin_id"].rpartition(":")
                if prefix == quiz_id and separator and raw_index.isdigit():
                    indexed.append((row["favorite_id"], int(raw_index)))
            for favorite_id, index in sorted(indexed, key=lambda item: item[1]):
                if index == question_index:
                    conn.execute("DELETE FROM favorites WHERE favorite_id = ?", (favorite_id,))
                elif index > question_index:
                    conn.execute(
                        "UPDATE favorites SET origin_id = ? WHERE favorite_id = ?",
                        (f"{quiz_id}:{index - 1}", favorite_id),
                    )
        return removed

    def save_quiz_score(self, project_id: str, quiz_id: str, score: float, results: list | None = None) -> None:
        # results 一并写入 payload：刷新 / 重开面板后前端才能恢复逐题反馈（对错、答案、解析）
        with self.transaction() as conn:
            if results is None:
                conn.execute(
                    "UPDATE quizzes SET submitted_at = ?, score = ? WHERE project_id = ? AND quiz_id = ?",
                    (utc_now().isoformat(), score, project_id, quiz_id),
                )
                return
            row = conn.execute(
                "SELECT payload FROM quizzes WHERE project_id = ? AND quiz_id = ?", (project_id, quiz_id)
            ).fetchone()
            if row is None:
                return
            payload = json.loads(row["payload"])
            payload["results"] = results
            conn.execute(
                "UPDATE quizzes SET submitted_at = ?, score = ?, payload = ? WHERE project_id = ? AND quiz_id = ?",
                (utc_now().isoformat(), score, json.dumps(payload, ensure_ascii=False), project_id, quiz_id),
            )

    def add_favorite(
        self,
        project_id: str,
        *,
        item_type: str,
        origin_id: str,
        title: str,
        content: str,
        answer: str,
        chapter_node_id: str | None,
        chapter_name: str,
        node_ids: list[str],
    ) -> FavoriteItem:
        self.get_project(project_id)
        existing = self._conn.execute(
            "SELECT * FROM favorites WHERE project_id = ? AND item_type = ? AND origin_id = ?",
            (project_id, item_type, origin_id),
        ).fetchone()
        if existing is not None:
            if existing["deleted_at"] is not None:
                now = utc_now()
                with self.transaction() as conn:
                    conn.execute(
                        "UPDATE favorites SET deleted_at = NULL, updated_at = ? WHERE favorite_id = ?",
                        (now.isoformat(), existing["favorite_id"]),
                    )
                return self.get_favorite(project_id, existing["favorite_id"])
            return self._favorite_from_row(existing)

        now = utc_now()
        favorite = FavoriteItem(
            favorite_id=new_id("fav"),
            project_id=project_id,
            item_type=item_type,
            origin_id=origin_id,
            title=title,
            content=content,
            answer=answer,
            chapter_node_id=chapter_node_id,
            chapter_name=chapter_name,
            node_ids=node_ids,
            created_at=now,
            updated_at=now,
        )
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO favorites(
                    favorite_id, project_id, item_type, origin_id, title, content, answer,
                    chapter_node_id, chapter_name, note, highlight_color, node_ids, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    favorite.favorite_id,
                    project_id,
                    item_type,
                    origin_id,
                    title,
                    content,
                    answer,
                    chapter_node_id,
                    chapter_name,
                    "",
                    "none",
                    json.dumps(node_ids, ensure_ascii=False),
                    now.isoformat(),
                    now.isoformat(),
                ),
            )
        return favorite

    def list_favorites(self, project_id: str) -> list[FavoriteItem]:
        self.get_project(project_id)
        rows = self._conn.execute(
            """
            SELECT * FROM favorites
            WHERE project_id = ? AND deleted_at IS NULL
            ORDER BY CASE WHEN chapter_name = '未归类' THEN 1 ELSE 0 END, chapter_name, created_at DESC
            """,
            (project_id,),
        ).fetchall()
        return [self._favorite_from_row(row) for row in rows]

    def get_favorite(self, project_id: str, favorite_id: str) -> FavoriteItem:
        self.get_project(project_id)
        row = self._conn.execute(
            "SELECT * FROM favorites WHERE project_id = ? AND favorite_id = ?",
            (project_id, favorite_id),
        ).fetchone()
        if row is None:
            raise FavoriteNotFound(favorite_id)
        return self._favorite_from_row(row)

    def update_favorite(
        self,
        project_id: str,
        favorite_id: str,
        *,
        title: str,
        chapter_node_id: str | None,
        chapter_name: str,
        note: str,
        highlight_color: str,
    ) -> FavoriteItem:
        self.get_favorite(project_id, favorite_id)
        now = utc_now()
        with self.transaction() as conn:
            conn.execute(
                """
                UPDATE favorites
                SET title = ?, chapter_node_id = ?, chapter_name = ?, note = ?, highlight_color = ?, updated_at = ?
                WHERE project_id = ? AND favorite_id = ?
                """,
                (title, chapter_node_id, chapter_name, note, highlight_color, now.isoformat(), project_id, favorite_id),
            )
        return self.get_favorite(project_id, favorite_id)

    def delete_favorite(self, project_id: str, favorite_id: str) -> None:
        self.get_favorite(project_id, favorite_id)
        now = utc_now()
        with self.transaction() as conn:
            conn.execute(
                "UPDATE favorites SET deleted_at = ?, updated_at = ? WHERE project_id = ? AND favorite_id = ?",
                (now.isoformat(), now.isoformat(), project_id, favorite_id),
            )

    def restore_favorite(self, project_id: str, favorite_id: str) -> FavoriteItem:
        self.get_favorite(project_id, favorite_id)
        now = utc_now()
        with self.transaction() as conn:
            conn.execute(
                "UPDATE favorites SET deleted_at = NULL, updated_at = ? WHERE project_id = ? AND favorite_id = ?",
                (now.isoformat(), project_id, favorite_id),
            )
        return self.get_favorite(project_id, favorite_id)

    # ---------- 撤销栈（Ctrl+Z） ----------

    def record_undo(
        self,
        owner_id: str,
        project_id: str | None,
        action: str,
        summary: str,
        payload: dict[str, Any],
    ) -> tuple[int, list[int]]:
        """记录一步可撤销操作，返回 (undo_id, 被裁剪掉的旧 undo_id 列表)。"""
        data = json.dumps(payload, ensure_ascii=False)
        with self.transaction() as conn:
            cursor = conn.execute(
                """
                INSERT INTO undo_history(owner_id, project_id, action, summary, payload, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (owner_id, project_id, action, summary, data, utc_now().isoformat()),
            )
            undo_id = int(cursor.lastrowid)
            rows = conn.execute(
                "SELECT id FROM undo_history WHERE owner_id = ? ORDER BY id DESC",
                (owner_id,),
            ).fetchall()
            trimmed = [int(row["id"]) for row in rows[UNDO_KEEP_LIMIT:]]
            if trimmed:
                placeholders = ", ".join("?" for _ in trimmed)
                conn.execute(
                    f"DELETE FROM undo_history WHERE id IN ({placeholders})",
                    tuple(trimmed),
                )
        return undo_id, trimmed

    def peek_undo(self, owner_id: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT * FROM undo_history WHERE owner_id = ? ORDER BY id DESC LIMIT 1",
            (owner_id,),
        ).fetchone()
        return self._undo_from_row(row) if row is not None else None

    def pop_undo(self, owner_id: str) -> dict[str, Any] | None:
        with self.transaction() as conn:
            row = conn.execute(
                "SELECT * FROM undo_history WHERE owner_id = ? ORDER BY id DESC LIMIT 1",
                (owner_id,),
            ).fetchone()
            if row is None:
                return None
            conn.execute("DELETE FROM undo_history WHERE id = ?", (row["id"],))
        return self._undo_from_row(row)

    def list_undo_ids(self) -> set[int]:
        rows = self._conn.execute("SELECT id FROM undo_history").fetchall()
        return {int(row["id"]) for row in rows}

    @staticmethod
    def _undo_from_row(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": int(row["id"]),
            "owner_id": row["owner_id"],
            "project_id": row["project_id"],
            "action": row["action"],
            "summary": row["summary"],
            "payload": json.loads(row["payload"]),
            "created_at": row["created_at"],
        }

    # ---------- 行级快照 / 恢复（供撤销逆操作使用） ----------

    @staticmethod
    def _row_dict(row: sqlite3.Row) -> dict[str, Any]:
        return {key: row[key] for key in row.keys()}

    @staticmethod
    def _insert_row(conn: sqlite3.Connection, table: str, row: dict[str, Any]) -> None:
        columns = ", ".join(row.keys())
        placeholders = ", ".join("?" for _ in row)
        conn.execute(
            f"INSERT OR REPLACE INTO {table} ({columns}) VALUES ({placeholders})",
            tuple(row.values()),
        )

    def restore_row(self, table: str, row: dict[str, Any]) -> None:
        with self.transaction() as conn:
            self._insert_row(conn, table, row)

    def get_source_row(self, project_id: str, source_id: str) -> dict[str, Any]:
        row = self._conn.execute(
            "SELECT * FROM sources WHERE project_id = ? AND source_id = ?",
            (project_id, source_id),
        ).fetchone()
        if row is None:
            raise SourceNotFound(source_id)
        return self._row_dict(row)

    def get_card_row(self, project_id: str, card_id: str) -> dict[str, Any]:
        row = self._conn.execute(
            "SELECT * FROM cards WHERE project_id = ? AND card_id = ?",
            (project_id, card_id),
        ).fetchone()
        if row is None:
            raise KeyError(card_id)
        return self._row_dict(row)

    def get_quiz_row(self, project_id: str, quiz_id: str) -> dict[str, Any]:
        row = self._conn.execute(
            "SELECT * FROM quizzes WHERE project_id = ? AND quiz_id = ?",
            (project_id, quiz_id),
        ).fetchone()
        if row is None:
            raise KeyError(quiz_id)
        return self._row_dict(row)

    def list_message_rows(
        self, project_id: str, message_ids: list[str]
    ) -> list[dict[str, Any]]:
        unique_ids = list(dict.fromkeys(mid for mid in message_ids if mid))
        if not unique_ids:
            return []
        placeholders = ", ".join("?" for _ in unique_ids)
        rows = self._conn.execute(
            f"SELECT * FROM messages WHERE project_id = ? AND message_id IN ({placeholders}) ORDER BY created_at ASC",
            (project_id, *unique_ids),
        ).fetchall()
        return [self._row_dict(row) for row in rows]

    def get_favorite_row(self, project_id: str, favorite_id: str) -> dict[str, Any]:
        row = self._conn.execute(
            "SELECT * FROM favorites WHERE project_id = ? AND favorite_id = ?",
            (project_id, favorite_id),
        ).fetchone()
        if row is None:
            raise FavoriteNotFound(favorite_id)
        return self._row_dict(row)

    def find_favorite_row_by_origin(
        self, project_id: str, item_type: str, origin_id: str
    ) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT * FROM favorites WHERE project_id = ? AND item_type = ? AND origin_id = ?",
            (project_id, item_type, origin_id),
        ).fetchone()
        return self._row_dict(row) if row is not None else None

    def list_favorite_rows(
        self,
        project_id: str,
        *,
        item_type: str | None = None,
        origin_id: str | None = None,
        origin_prefix: str | None = None,
    ) -> list[dict[str, Any]]:
        sql = "SELECT * FROM favorites WHERE project_id = ?"
        params: list[Any] = [project_id]
        if item_type is not None:
            sql += " AND item_type = ?"
            params.append(item_type)
        if origin_id is not None:
            sql += " AND origin_id = ?"
            params.append(origin_id)
        if origin_prefix is not None:
            sql += " AND origin_id LIKE ?"
            params.append(f"{origin_prefix}%")
        rows = self._conn.execute(sql, params).fetchall()
        return [self._row_dict(row) for row in rows]

    def hard_delete_favorites(self, project_id: str, favorite_ids: list[str]) -> None:
        unique_ids = list(dict.fromkeys(fid for fid in favorite_ids if fid))
        if not unique_ids:
            return
        placeholders = ", ".join("?" for _ in unique_ids)
        with self.transaction() as conn:
            conn.execute(
                f"DELETE FROM favorites WHERE project_id = ? AND favorite_id IN ({placeholders})",
                (project_id, *unique_ids),
            )

    def delete_quiz_row(self, project_id: str, quiz_id: str) -> None:
        with self.transaction() as conn:
            conn.execute(
                "DELETE FROM quizzes WHERE project_id = ? AND quiz_id = ?",
                (project_id, quiz_id),
            )

    def save_quiz_payload(self, project_id: str, quiz_id: str, payload: dict) -> None:
        with self.transaction() as conn:
            conn.execute(
                "UPDATE quizzes SET payload = ? WHERE project_id = ? AND quiz_id = ?",
                (json.dumps(payload, ensure_ascii=False), project_id, quiz_id),
            )

    def snapshot_framework(self, project_id: str) -> dict[str, Any]:
        """快照项目的全部知识节点 + 学习事件（节点删除会级联事件，需一起快照）。"""
        self.get_project(project_id)
        nodes = self._conn.execute(
            "SELECT * FROM framework_nodes WHERE project_id = ?", (project_id,)
        ).fetchall()
        events = self._conn.execute(
            "SELECT * FROM learning_events WHERE project_id = ?", (project_id,)
        ).fetchall()
        return {
            "nodes": [self._row_dict(row) for row in nodes],
            "events": [self._row_dict(row) for row in events],
        }

    def restore_framework(self, project_id: str, snapshot: dict[str, Any]) -> None:
        self.get_project(project_id)
        with self.transaction() as conn:
            conn.execute(
                "DELETE FROM learning_events WHERE project_id = ?", (project_id,)
            )
            conn.execute(
                "DELETE FROM framework_nodes WHERE project_id = ?", (project_id,)
            )
            for node in snapshot.get("nodes", []):
                self._insert_row(conn, "framework_nodes", node)
            for event in snapshot.get("events", []):
                self._insert_row(conn, "learning_events", event)

    def snapshot_project_bundle(self, project_id: str) -> dict[str, Any]:
        """快照整个项目（含全部子表），用于「删除项目」的撤销。"""
        self.get_project(project_id)
        bundle: dict[str, Any] = {"project_id": project_id}
        project_row = self._conn.execute(
            "SELECT * FROM projects WHERE project_id = ?", (project_id,)
        ).fetchone()
        bundle["project"] = self._row_dict(project_row)
        for table in (
            "sources",
            "framework_nodes",
            "learning_events",
            "cards",
            "quizzes",
            "messages",
            "favorites",
            "node_link_notes",
        ):
            rows = self._conn.execute(
                f"SELECT * FROM {table} WHERE project_id = ?", (project_id,)
            ).fetchall()
            bundle[table] = [self._row_dict(row) for row in rows]
        return bundle

    def restore_project_bundle(self, bundle: dict[str, Any]) -> None:
        project = bundle.get("project")
        if not project:
            raise ValueError("撤销快照中缺少项目记录。")
        with self.transaction() as conn:
            self._insert_row(conn, "projects", project)
            for table in (
                "sources",
                "framework_nodes",
                "learning_events",
                "cards",
                "quizzes",
                "messages",
                "favorites",
                "node_link_notes",
            ):
                for row in bundle.get(table, []):
                    self._insert_row(conn, table, row)

    def _project_from_row(self, row: sqlite3.Row) -> Project:
        keys = row.keys()
        return Project(
            project_id=row["project_id"],
            owner_id=row["owner_id"],
            year=row["year"],
            subject=row["subject"],
            project_type=row["project_type"] if "project_type" in keys else "course",
            tags=_loads_list(row["tags"]) if "tags" in keys else [],
            last_position=float(row["last_position"]) if "last_position" in keys and row["last_position"] is not None else 0.0,
            last_opened_at=datetime.fromisoformat(row["last_opened_at"]) if "last_opened_at" in keys and row["last_opened_at"] else None,
            total_reading_seconds=int(row["total_reading_seconds"]) if "total_reading_seconds" in keys and row["total_reading_seconds"] is not None else 0,
            created_at=datetime.fromisoformat(row["created_at"]),
        )

    def _literature_meta_from_row(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "project_id": row["project_id"],
            "title": row["title"],
            "authors": row["authors"],
            "year": row["year"],
            "venue": row["venue"],
            "doi": row["doi"],
            "arxiv_id": row["arxiv_id"],
            "language": row["language"],
            "keywords": _loads_list(row["keywords"]),
            "abstract": row["abstract"],
            "abstract_translated": row["abstract_translated"],
            "section_headings": _loads_list(row["section_headings"]),
            "suggested_questions": _loads_list(row["suggested_questions"]),
            "keypoints": _loads_list(row["keypoints"]),
            "references_count": row["references_count"],
            "extract_status": row["extract_status"],
        }

    def _user_from_row(self, row: sqlite3.Row) -> User:
        last_seen_at = row["last_seen_at"] if "last_seen_at" in row.keys() else None
        return User(
            user_id=row["user_id"],
            email=row["email"],
            name=row["name"],
            created_at=datetime.fromisoformat(row["created_at"]),
            last_seen_at=datetime.fromisoformat(last_seen_at) if last_seen_at else None,
        )

    def _source_from_row(self, row: sqlite3.Row) -> Source:
        return Source(
            source_id=row["source_id"],
            project_id=row["project_id"],
            filename=row["filename"],
            mime_type=row["mime_type"],
            size_bytes=int(row["size_bytes"]),
            text=row["text"],
            formulas=_loads_list(row["formulas"]),
            figures=_loads_list(row["figures"]),
            status=row["status"],
            error_message=row["error_message"],
            created_at=datetime.fromisoformat(row["created_at"]),
        )

    def _node_from_row(self, row: sqlite3.Row) -> FrameworkNode:
        return FrameworkNode(
            node_id=row["node_id"],
            parent_id=row["parent_id"],
            name=row["name"],
            description=row["description"],
            coverage_status=row["coverage_status"],
            learning_status=row["learning_status"],
            mastery_score=float(row["mastery_score"]),
            transfer_score=(
                float(row["transfer_score"])
                if "transfer_score" in row.keys() and row["transfer_score"] is not None
                else 0.0
            ),
            source_ids=_loads_list(row["source_ids"]),
            prerequisite_ids=_loads_list(row["prerequisite_ids"]),
            exam_weight=row["exam_weight"],
            note_content=row["note_content"] if "note_content" in row.keys() else "",
            tags=_loads_list(row["tags"]) if "tags" in row.keys() else [],
            wikilinks=_loads_list(row["wikilinks"]) if "wikilinks" in row.keys() else [],
        )

    def _favorite_from_row(self, row: sqlite3.Row) -> FavoriteItem:
        return FavoriteItem(
            favorite_id=row["favorite_id"],
            project_id=row["project_id"],
            item_type=row["item_type"],
            origin_id=row["origin_id"],
            title=row["title"],
            content=row["content"],
            answer=row["answer"],
            chapter_node_id=row["chapter_node_id"],
            chapter_name=row["chapter_name"],
            note=row["note"],
            highlight_color=row["highlight_color"],
            node_ids=_loads_list(row["node_ids"]),
            created_at=datetime.fromisoformat(row["created_at"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
        )
