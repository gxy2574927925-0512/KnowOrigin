"""AI 长期记忆 v2：两层固定槽位（用户声明 + AI 推断）。

## 为什么要重做（v1 的实测失效）

v1 把记忆存成「5 类自由短句」，唯一索引是 ``(owner, kind, content)`` **精确匹配**。
实测某个真实账号的库里 31 条记忆，真正独立的只有 5 条：

    background 同一件事记了 7 遍（「正在学习量子力学、太赫兹技术与定量OCT……」换了 7 种措辞）
    goal 8 遍、weakness 6 遍（趋肤深度相关 3 遍）、style 4 遍、preference 仅 1 遍

模型换个说法就绕过了唯一索引 → 注入时按 ``updated_at DESC`` 取 12 条、又**没有分类配额**，
于是 12 条的额度里 7 条在说同一件事，真实信息量约等于 1 条；唯一有区分度的那条偏好，
下次提取就被新的重复条目挤出前 12。

更致命的是注入措辞：v1 的块尾写着「与当前问题无关时请忽略，**不要主动提起**这些记忆」。
最该起作用的 weakness（「趋肤深度与频率关系容易记反」）被这句一起压死了 ——
模型即使读到了也不敢用。用户的感知就是「这个记忆完全没生效」。

## 本次的核心判断：关于用户本人的信息，不该一概交给 AI 去猜

    全局画像（4 格）  专业年级 / 目标 / 讲解偏好 / 表达习惯
                      → **用户自己最清楚**，一次就能填对 → 用户声明式，AI 无权写
    项目级记忆（4 格）卡点 / 进度 / 项目偏好 / 未解问题
                      → **用户说不清也懒得写** → AI 推断式，用户可改可删

拿 AI 去猜前者，是用最贵最不准的方式获取最便宜最准的信息 —— v1 那 7 条重复的
「在学量子力学」正是这种猜的产物。拆开之后还有两个顺带收益：提取 prompt 砍掉一半
（不再猜全局），正好抵消阈值从 12 轮降到 4 轮的额外调用开销；而且新用户在引导里
填完就能立刻生效，不必等攒批 —— 冷启动问题一并解决。

## 槽位制为什么能根治重复

一类只有一格，**物理上不可能重复**。覆盖语义：值相同只刷时间；值不同则把旧值推进
``memory_slot_history``（留 3 条）再覆盖。旧值链让用户看得见「AI 改了什么」。

## 注入措辞分三档（v1 只有一档，且那一档还自我阉割）

    用户声明的偏好 → 强度高（「请遵守」）—— 这不是 AI 猜的，是用户写下来的，没有理由忽略
    卡点           → 强度高（段内**不含任何可忽略字样**）
    项目上下文     → 强度低（「无关时可忽略」）

## 两条注入路径必须互斥，否则双重注入

    MESSAGES_TASKS → 由 MemoryAwareLlm 注入 messages（聊天类，调用点已有 messages）
    PAYLOAD_TASKS  → 由 core/llm.py::_system_prompt 通过 contextvar 里的**惰性 provider** 注入

v1 把 ``recommend_link_gaps`` / ``recommend_deep_questions`` 排除在外的真实原因不是
「不该注入」，而是**注入不进去**：它们走 ``complete_json(task, payload)``，messages 在
``_system_prompt`` 内部生成，而 ``MemoryAwareLlm`` **没有包装 complete_json**
（走 ``__getattr__`` 透传），代理里根本拦不到。惰性 provider 解决了这件事 ——
它只在 ``task in PAYLOAD_TASKS`` 时才真的去查库，非 AI 请求零成本。

## 兼容性

v1 的 ``memory_notes`` 表与 ``/api/memory/notes*`` 端点**原样保留**（回滚靠它），
但注入与提取链路已全部切到 ``memory_slots``。旧表不再是任何新行为的依据。
"""

from __future__ import annotations

import json
import re
import sqlite3
import threading
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator

from .database import new_id, utc_now
from .usage import current_usage_owner, estimate_tokens

# --------------------------------------------------------------------------- #
# 常量
# --------------------------------------------------------------------------- #
SCOPE_GLOBAL = "global"
SCOPE_PROJECT = "project"

GLOBAL_SLOTS: tuple[str, ...] = ("major_grade", "goal", "pref_explain", "style")
PROJECT_SLOTS: tuple[str, ...] = (
    "stuck_points",
    "progress",
    "proj_pref",
    "open_questions",
)
SLOT_LABELS: dict[str, str] = {
    "major_grade": "专业与年级",
    "goal": "当前目标",
    "pref_explain": "讲解偏好",
    "style": "表达习惯",
    "stuck_points": "当前卡点",
    "progress": "本项目进度",
    "proj_pref": "本项目偏好",
    "open_questions": "未解问题",
}

# 多标签槽：值是一组短标签，可来自推荐词表，也可以是自有标签。
MULTI_TAG_SLOTS: tuple[str, ...] = ("pref_explain", "style", "proj_pref")

# 单条文本/标签的字数上限（按槽区分）。超限一律判为模型跑偏。
SLOT_TEXT_LIMITS: dict[str, int] = {
    "major_grade": 12,  # 「专业」部分的字数；「年级」另受 GRADE_OPTIONS 约束
    "goal": 16,  # 副标题
    "progress": 24,
    "stuck_points": 16,  # 单条卡点
    "open_questions": 20,  # 单条未解问题
}

MAX_TAG_CHARS = 8
MAX_TAGS_PER_SLOT = 5
MAX_LIST_ITEMS = {
    "stuck_points": 5,
    "open_questions": 3,
}
# 卡点合流时客观组（掌握度）最多取几个；剩下的名额给 LLM 自述。
STUCK_OBJECTIVE_MAX = 3

# --------------------------------------------------------------------------- #
# 推荐词表 —— 集中在这一处，不要散进 prompt 字符串
#
# ⚠️ 这是**推荐**词表，不是白名单：模型和用户都可以用词表以外的自有标签，
#    只受 MAX_TAG_CHARS / MAX_TAGS_PER_SLOT 约束。理由：对一个面向未知用户的
#    产品，封闭词表**一定会硬塞** —— 有人说「先给我讲物理图像再上公式」，
#    词表里只有「先例子后定义」，模型会静默 snap 到不准确的那个，而且不报错。
#    上线后按真实用户的自有标签使用频次来扩这张表：
#    词表是被用户数据养出来的，不是拍出来的。
# --------------------------------------------------------------------------- #
PREF_EXPLAIN_DIMENSIONS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("讲解顺序", ("先例子后定义", "先定义后例子")),
    ("推导深度", ("要完整推导", "只要关键步骤", "直接给结论")),
    ("呈现方式", ("分步骤讲", "整体串讲", "多配类比", "多配图")),
    ("互动方式", ("苏格拉底式提问", "先讲我再看", "让我自己先试")),
    ("详细程度", ("简明扼要", "详尽展开")),
)

STYLE_DIMENSIONS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("语言习惯", ("中英夹杂", "全中文", "术语要英文对照")),
    ("学习时段", ("常深夜学习", "常早晨学习", "只能碎片时间")),
    ("笔记习惯", ("喜欢思维导图", "喜欢双链笔记", "喜欢手写整理")),
)

PREF_EXPLAIN_TAGS: tuple[str, ...] = tuple(
    tag for _, tags in PREF_EXPLAIN_DIMENSIONS for tag in tags
)

# 年级用枚举（可精确比对），专业用自由短文本。
GRADE_OPTIONS: tuple[str, ...] = (
    "大一",
    "大二",
    "大三",
    "大四",
    "大五",
    "研一",
    "研二",
    "研三",
    "已毕业",
    "其他",
)

# 目标类别：按「任意学习者」设计，粗粒度全覆盖。
# 覆盖关系：准备考试=期末/考研/考证/公考；升学申请=保研/留学；科研与竞赛=大创/学科竞赛。
GOAL_CATEGORIES: tuple[str, ...] = (
    "准备考试",
    "升学申请",
    "求职实习",
    "课程与毕设",
    "科研与竞赛",
    "兴趣自学",
    "其他",
)

# --------------------------------------------------------------------------- #
# 任务白名单 —— 两组必须互斥（见模块头「两条注入路径」）
# --------------------------------------------------------------------------- #
# 走 messages 接口的聊天类任务：由 MemoryAwareLlm 注入 messages。
MESSAGES_TASKS = frozenset(
    {
        "answer_question",
        "solve_problem",
        "discussion_speak",
    }
)

# 走 complete_json(task, payload) 的任务：messages 在 _system_prompt 内部生成，
# 由 contextvar 里的惰性 provider 注入。
#
# 名单里只有**建议型**任务。结构化生成类（generate_quiz / translate_section /
# build_framework / extract_knowledge_points / sprint_plan_content）**刻意不列入**：
# 用户偏好只会让它们分心、破坏 JSON 输出，反而让既有功能变差。
PAYLOAD_TASKS = frozenset(
    {
        "recommend_link_gaps",
        "recommend_deep_questions",
    }
)

# --------------------------------------------------------------------------- #
# 提取节奏
# --------------------------------------------------------------------------- #
# 攒够这么多轮对话才值得跑一次提取。
EXTRACT_THRESHOLD = 4

# 两次提取之间的最小间隔。即使攒够了轮数，太频繁也没有新信息可提。
EXTRACT_COOLDOWN_MINUTES = 5

# 提取时回看的对话窗口。
EXTRACT_LOOKBACK_DAYS = 30
EXTRACT_MAX_MESSAGES = 120

# 一次提取最多覆盖几个项目。窗口里常常横跨好几个库，但逐个项目各跑一次模型调用
# 太贵；按「窗口内消息数」取前 N 个，实际使用里绝大多数情况就是 1。
EXTRACT_MAX_PROJECTS = 2

# 单个项目在窗口里少于这么多条消息就不值得单独提取。
EXTRACT_MIN_MESSAGES_PER_PROJECT = 2

# 单次提取最多接受的槽位数，防止模型一次吐出上百条把库灌满。
EXTRACT_MAX_ITEMS = 8

# 每槽保留几条旧值（旧值链）。用户能看到「AI 改了什么」，但不会无限膨胀。
SLOT_HISTORY_KEEP = 3

# --------------------------------------------------------------------------- #
# v1 遗留：只服务于 legacy 端点 /api/memory/notes*，不再参与注入与提取
# --------------------------------------------------------------------------- #
KINDS = ("preference", "background", "weakness", "style", "goal")

KIND_LABELS = {
    "preference": "偏好",
    "background": "背景",
    "weakness": "薄弱点",
    "style": "表达方式",
    "goal": "目标",
}

_ROLE_LABELS = {"user": "学生", "assistant": "AI", "system": "系统", "tool": "工具"}

SCHEMA_LEGACY = """
CREATE TABLE IF NOT EXISTS memory_notes (
    note_id    TEXT PRIMARY KEY,
    owner_id   TEXT NOT NULL,
    kind       TEXT NOT NULL,
    content    TEXT NOT NULL,
    source     TEXT NOT NULL DEFAULT 'auto',
    project_id TEXT,
    evidence   TEXT NOT NULL DEFAULT '',
    hits       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_notes_unique
    ON memory_notes(owner_id, kind, content);
CREATE INDEX IF NOT EXISTS memory_notes_owner
    ON memory_notes(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS memory_state (
    owner_id    TEXT PRIMARY KEY,
    pending     INTEGER NOT NULL DEFAULT 0,
    last_run_at TEXT,
    last_error  TEXT NOT NULL DEFAULT '',
    last_note   INTEGER NOT NULL DEFAULT 0
);
"""

# 新表。memory_state 用 ALTER 补列（见 _ensure_column），不重建。
SCHEMA_SLOTS = """
CREATE TABLE IF NOT EXISTS memory_slots (
    slot_id          TEXT PRIMARY KEY,
    owner_id         TEXT NOT NULL,
    scope            TEXT NOT NULL,
    project_id       TEXT,
    slot_key         TEXT NOT NULL,
    value            TEXT NOT NULL,
    source           TEXT NOT NULL DEFAULT 'auto',
    evidence         TEXT NOT NULL DEFAULT '',
    updated_at       TEXT NOT NULL,
    last_injected_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_slots_unique
    ON memory_slots(owner_id, scope, IFNULL(project_id, ''), slot_key);
CREATE INDEX IF NOT EXISTS memory_slots_owner
    ON memory_slots(owner_id, scope, updated_at DESC);

CREATE TABLE IF NOT EXISTS memory_slot_history (
    history_id TEXT PRIMARY KEY,
    slot_id    TEXT NOT NULL,
    value      TEXT NOT NULL,
    evidence   TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_slot_history_slot
    ON memory_slot_history(slot_id, created_at DESC);
"""

STATE_EXTRA_COLUMNS: tuple[tuple[str, str], ...] = (
    ("consent_at", "TEXT"),
    ("onboarded_at", "TEXT"),
    # 每用户的总开关。Q21 承诺的「首次告知 + 一键关闭」必须是**真的关**，
    # 而不是弹一句提示 —— 所以开关得落库，且是 per-user 而不是全局 env
    # （全局 env 会让一个用户关掉所有人的记忆）。
    ("memory_off", "INTEGER NOT NULL DEFAULT 0"),
)


# --------------------------------------------------------------------------- #
# 值的规范化与校验
# --------------------------------------------------------------------------- #
class SlotValueError(ValueError):
    """槽位取值不合法。调用方决定是拒收还是回落。"""


def _clean_text(raw: Any, limit: int) -> str:
    text = str(raw or "").strip()
    # 换行会把注入块的一行拆成两行，进而破坏「8 行」的预算
    text = " ".join(text.split())
    if len(text) > limit:
        text = text[:limit]
    return text


def normalize_tags(raw: Any) -> list[str]:
    """标签列表：去空、去重、限长、限量。顺序稳定（排序）以便「值相同」可精确比对。"""
    if isinstance(raw, str):
        items: Iterable[Any] = raw.replace("；", ";").replace("、", ";").split(";")
    elif isinstance(raw, (list, tuple)):
        items = raw
    else:
        items = []
    out: list[str] = []
    for item in items:
        text = _clean_text(item, MAX_TAG_CHARS)
        if not text or text in out:
            continue
        out.append(text)
        if len(out) >= MAX_TAGS_PER_SLOT:
            break
    return sorted(out)


def normalize_value(slot_key: str, raw: Any) -> dict[str, Any]:
    """把任意输入收敛成该槽的标准结构（dict），并做形态校验。

    一律存 dict 而不是拼接好的字符串：值相同才能精确比对（决定"覆盖还是只刷时间"），
    注入时再 render 成一行。多标签槽的标签顺序被排序，保证 ``{a,b}`` 与 ``{b,a}`` 等价。
    """
    if slot_key == "major_grade":
        if not isinstance(raw, dict):
            raise SlotValueError("major_grade 需要对象")
        major = _clean_text(raw.get("major"), SLOT_TEXT_LIMITS["major_grade"])
        grade = _clean_text(raw.get("grade"), 8)
        if not major:
            raise SlotValueError("专业不能为空")
        if grade and grade not in GRADE_OPTIONS:
            raise SlotValueError(f"年级必须是 {GRADE_OPTIONS} 之一")
        return {"major": major, "grade": grade}

    if slot_key == "goal":
        if not isinstance(raw, dict):
            raise SlotValueError("goal 需要对象")
        category = _clean_text(raw.get("category"), 8)
        title = _clean_text(raw.get("title"), SLOT_TEXT_LIMITS["goal"])
        if not category and not title:
            raise SlotValueError("目标不能为空")
        if category and category not in GOAL_CATEGORIES:
            raise SlotValueError(f"目标类别必须是 {GOAL_CATEGORIES} 之一")
        return {"category": category, "title": title}

    if slot_key in MULTI_TAG_SLOTS:
        tags = normalize_tags(raw.get("tags") if isinstance(raw, dict) else raw)
        if not tags:
            raise SlotValueError("至少要有一个标签")
        return {"tags": tags}

    if slot_key == "progress":
        text = _clean_text(
            raw.get("text") if isinstance(raw, dict) else raw,
            SLOT_TEXT_LIMITS["progress"],
        )
        if not text:
            raise SlotValueError("进度不能为空")
        return {"text": text}

    if slot_key in ("stuck_points", "open_questions"):
        if isinstance(raw, dict):
            items_raw = raw.get("items") or []
        elif isinstance(raw, (list, tuple)):
            items_raw = raw
        else:
            items_raw = []
        limit = SLOT_TEXT_LIMITS[slot_key]
        cap = MAX_LIST_ITEMS[slot_key]
        items: list[dict[str, str]] = []
        seen: list[str] = []
        for item in items_raw:
            # 兼容两种形状：纯字符串（LLM 自述）与带来源的对象（合流后的客观卡点）
            if isinstance(item, dict):
                text = _clean_text(item.get("text"), limit)
                origin = _clean_text(item.get("source"), 12) or "self"
            else:
                text = _clean_text(item, limit)
                origin = "self"
            if not text or text in seen:
                continue
            seen.append(text)
            items.append({"text": text, "source": origin})
            if len(items) >= cap:
                break
        if not items:
            raise SlotValueError("列表不能为空")
        return {"items": items}

    raise SlotValueError(f"未知槽位 {slot_key}")


def _value_signature(value: dict[str, Any]) -> str:
    """值的可比对指纹。键序固定，保证等价结构得到同一串。"""
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def render_value(slot_key: str, value: dict[str, Any]) -> str:
    """把槽位值渲染成注入块里的一行短文本。"""
    if slot_key == "major_grade":
        major = str(value.get("major") or "")
        grade = str(value.get("grade") or "")
        return f"{major}·{grade}" if grade else major
    if slot_key == "goal":
        category = str(value.get("category") or "")
        title = str(value.get("title") or "")
        if category and title:
            return f"{category}：{title}"
        return category or title
    if slot_key in MULTI_TAG_SLOTS:
        return "；".join(str(tag) for tag in (value.get("tags") or []))
    if slot_key == "progress":
        return str(value.get("text") or "")
    if slot_key in ("stuck_points", "open_questions"):
        return "；".join(
            str(item.get("text") or "")
            for item in (value.get("items") or [])
            if isinstance(item, dict)
        )
    return ""


def _value_from_storage(raw: str) -> dict[str, Any]:
    try:
        data = json.loads(raw or "{}")
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


# --------------------------------------------------------------------------- #
# 推荐词表 -> 给前端 / 提取 prompt 用
# --------------------------------------------------------------------------- #
def vocab_payload() -> dict[str, Any]:
    """把推荐词表与枚举吐给前端和提取 prompt。词表只有这一处定义。"""
    return {
        "pref_explain": [
            {"dimension": name, "tags": list(tags)}
            for name, tags in PREF_EXPLAIN_DIMENSIONS
        ],
        "style": [
            {"dimension": name, "tags": list(tags)} for name, tags in STYLE_DIMENSIONS
        ],
        "grades": list(GRADE_OPTIONS),
        "goal_categories": list(GOAL_CATEGORIES),
        "max_tag_chars": MAX_TAG_CHARS,
        "max_tags_per_slot": MAX_TAGS_PER_SLOT,
        # 列表型槽位的条数上限（stuck_points / open_questions）——前端和提取 prompt 共用
        "list_limits": dict(MAX_LIST_ITEMS),
    }


# --------------------------------------------------------------------------- #
# 请求级上下文：当前项目
#
# ⚠️ 全项目原本**没有** project 级 contextvar（core/usage.py 只有 owner，
#    core/teaching_mode.py 有档位/问题/历史）。而两层记忆要「按当前项目取」，
#    注入层又只读得到 contextvar，所以必须补这一个。
#    好消息：/chat、/chat/stream、/agent、/solve、/solve-image 全部在
#    /api/projects/{project_id}/ 路径下，中间件一条正则就能捞到，不必读 body。
# --------------------------------------------------------------------------- #
_active_project: ContextVar[str] = ContextVar("knoworigin_memory_project", default="")


def set_active_project(project_id: str) -> Any:
    return _active_project.set(str(project_id or ""))


def reset_active_project(token: Any) -> None:
    _active_project.reset(token)


def active_project() -> str:
    return _active_project.get("")


# 惰性 provider：中间件塞一个「现取现拼」的闭包进来，core/llm.py 只在白名单任务
# 里调用它。惰性是关键 —— 否则每个请求（含大量非 AI 请求）都要查一次库。
_memory_provider: ContextVar[Callable[[], str] | None] = ContextVar(
    "knoworigin_memory_provider", default=None
)


def set_memory_provider(fn: Callable[[], str] | None) -> Any:
    return _memory_provider.set(fn)


def reset_memory_provider(token: Any) -> None:
    _memory_provider.reset(token)


def payload_memory_block(task: str) -> str:
    """给 ``core/llm.py::_system_prompt`` 用：白名单任务才真的去查库。

    返回带前导换行的片段，方便直接拼到 system prompt 末尾；非白名单任务返回空串。
    """
    if task not in PAYLOAD_TASKS:
        return ""
    provider = _memory_provider.get(None)
    if provider is None:
        return ""
    try:
        block = provider()
    except Exception:
        # 记忆读不到绝不能影响正常回答
        return ""
    block = (block or "").strip()
    return f"\n\n{block}" if block else ""


# --------------------------------------------------------------------------- #
# 注入块：三档强度
# --------------------------------------------------------------------------- #
def build_memory_block(
    global_values: dict[str, dict[str, Any]],
    project_values: dict[str, dict[str, Any]],
) -> str:
    """把两层槽位值拼成注入 prompt 的一小段（最多 8 行）。

    三档强度是本版与 v1 最大的差别：v1 只有一档，且那一档末尾写着「请忽略、
    不要主动提起」，把最该起作用的两类（用户自述偏好、已确认的卡点）一起废了。
    """
    sections: list[str] = []

    declared = [
        (key, global_values[key])
        for key in GLOBAL_SLOTS
        if global_values.get(key)
    ]
    if declared:
        lines = [f"- [{SLOT_LABELS[key]}] {render_value(key, value)}" for key, value in declared]
        sections.append(
            "【这位学习者自己设置的偏好 —— 请遵守】\n"
            + "\n".join(lines)
            + "\n这些是他本人写下来的（不是推测），请按这个方式讲解。"
            "确实与当前问题无关时可以不管，但不要违背它。"
        )

    stuck = project_values.get("stuck_points") or {}
    stuck_items = [
        item
        for item in (stuck.get("items") or [])
        if isinstance(item, dict) and str(item.get("text") or "").strip()
    ]
    if stuck_items:
        lines = []
        for item in stuck_items:
            origin = "客观" if str(item.get("source")) == "mastery" else "自述"
            lines.append(f"- {item.get('text')} [{origin}]")
        sections.append(
            "【他在这几处反复栽过 —— 请针对性预判】\n"
            + "\n".join(lines)
            + "\n不要从零开始讲这些点；用他栽过的那个角度切入。"
            + "（标注「客观」的来自掌握度统计，「自述」的来自他自己说过的话。）"
        )

    context_keys = ("progress", "proj_pref", "open_questions")
    context = [
        (key, project_values[key])
        for key in context_keys
        if project_values.get(key)
    ]
    if context:
        lines = [f"- [{SLOT_LABELS[key]}] {render_value(key, value)}" for key, value in context]
        sections.append(
            "【本项目上下文】\n"
            + "\n".join(lines)
            + "\n与本问题无关时请忽略，不要主动提起。"
        )

    return "\n\n".join(sections)


def memory_block_for(
    store: MemoryStore, owner_id: str, project_id: str | None = None
) -> str:
    """**唯一**的拼块入口：先看 per-user 总开关，再取槽位，最后拼块并记录「进过 prompt」。

    两条注入路径（messages / payload）都调它，不要各写一份 ——
    否则「关掉记忆」只会在其中一条路上生效，而另一条路静默地继续注入，
    是最难查的那种坏法。
    """
    if not owner_id:
        return ""
    try:
        if int(store.state(owner_id).get("memory_off") or 0):
            return ""
        global_values, project_values, slot_ids = store.slot_values(
            owner_id, project_id
        )
    except Exception:
        return ""
    block = build_memory_block(global_values, project_values)
    if block and slot_ids:
        try:
            store.mark_injected(slot_ids)
        except Exception:
            pass
    return block


# --------------------------------------------------------------------------- #
# 存储
# --------------------------------------------------------------------------- #
class MemoryStore:
    """``memory_slots`` / ``memory_slot_history`` 的读写，外加 v1 遗留表。

    复用主库文件，独立连接 —— 与 ``core/english_store.py`` 同一套路。
    """

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
            conn.executescript(SCHEMA_LEGACY)
            conn.executescript(SCHEMA_SLOTS)
            for column, ddl in STATE_EXTRA_COLUMNS:
                _ensure_column(conn, "memory_state", column, ddl)

    def close(self) -> None:
        try:
            self._conn.close()
        except Exception:
            pass

    # ------------------------------------------------------------ 槽位读 --

    def list_slots(
        self, owner_id: str, project_id: str | None = None
    ) -> dict[str, Any]:
        """返回 ``{"global": {key: row}, "project": {key: row}}``。

        ``project_id`` 为空时 project 组为空 —— 不猜、不复用其他项目的记忆。
        """
        result: dict[str, Any] = {"global": {}, "project": {}}
        rows = self._conn.execute(
            "SELECT * FROM memory_slots WHERE owner_id = ?", (owner_id or "",)
        ).fetchall()
        for row in rows:
            scope = str(row["scope"] or "")
            if scope == SCOPE_GLOBAL:
                result["global"][row["slot_key"]] = _slot_row(row)
            elif scope == SCOPE_PROJECT and project_id and row["project_id"] == project_id:
                result["project"][row["slot_key"]] = _slot_row(row)
        return result

    def slot_values(
        self, owner_id: str, project_id: str | None = None
    ) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]], list[str]]:
        """给注入用：``(全局值, 项目值, 命中的 slot_id 列表)``。"""
        data = self.list_slots(owner_id, project_id)
        global_values: dict[str, dict[str, Any]] = {}
        project_values: dict[str, dict[str, Any]] = {}
        slot_ids: list[str] = []
        for key, row in data["global"].items():
            if row["value_data"]:
                global_values[key] = row["value_data"]
                slot_ids.append(row["slot_id"])
        for key, row in data["project"].items():
            if row["value_data"]:
                project_values[key] = row["value_data"]
                slot_ids.append(row["slot_id"])
        return global_values, project_values, slot_ids

    def history(self, slot_id: str, *, limit: int = SLOT_HISTORY_KEEP) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT * FROM memory_slot_history WHERE slot_id = ?"
            " ORDER BY created_at DESC LIMIT ?",
            (slot_id, max(1, int(limit))),
        ).fetchall()
        return [
            {
                "value": _value_from_storage(row["value"]),
                "evidence": row["evidence"] or "",
                "created_at": row["created_at"],
            }
            for row in rows
        ]


    # ------------------------------------------------------------ 槽位写 --

    def upsert_slot(
        self,
        owner_id: str,
        scope: str,
        slot_key: str,
        value: dict[str, Any],
        *,
        project_id: str | None = None,
        source: str = "auto",
        evidence: str = "",
    ) -> str:
        """写一个槽位。返回 ``"added"`` / ``"updated"`` / ``"same"``。

        覆盖语义：值相同只刷 ``updated_at``；值不同则先把旧值推进历史（留 3 条）
        再覆盖。旧值链让用户看得见「AI 改了什么」。
        """
        if scope not in (SCOPE_GLOBAL, SCOPE_PROJECT):
            raise SlotValueError(f"未知作用域 {scope}")
        if scope == SCOPE_PROJECT and not project_id:
            raise SlotValueError("项目级槽位必须带 project_id")

        payload = _value_signature(value)
        now = utc_now().isoformat()
        pid = project_id if scope == SCOPE_PROJECT else None

        with self.transaction() as conn:
            row = conn.execute(
                "SELECT * FROM memory_slots WHERE owner_id = ? AND scope = ?"
                " AND IFNULL(project_id, '') = ? AND slot_key = ?",
                (owner_id or "", scope, pid or "", slot_key),
            ).fetchone()
            if row is None:
                conn.execute(
                    "INSERT INTO memory_slots(slot_id, owner_id, scope, project_id,"
                    " slot_key, value, source, evidence, updated_at, last_injected_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
                    (
                        new_id("slot"),
                        owner_id or "",
                        scope,
                        pid,
                        slot_key,
                        payload,
                        source,
                        evidence or "",
                        now,
                    ),
                )
                return "added"

            old_signature = str(row["value"] or "")
            if old_signature == payload:
                conn.execute(
                    "UPDATE memory_slots SET updated_at = ?, evidence = ? WHERE slot_id = ?",
                    (now, evidence or row["evidence"] or "", row["slot_id"]),
                )
                return "same"

            conn.execute(
                "INSERT INTO memory_slot_history(history_id, slot_id, value, evidence,"
                " created_at) VALUES (?, ?, ?, ?, ?)",
                (
                    new_id("sloth"),
                    row["slot_id"],
                    old_signature,
                    row["evidence"] or "",
                    now,
                ),
            )
            conn.execute(
                "UPDATE memory_slots SET value = ?, source = ?, evidence = ?,"
                " updated_at = ? WHERE slot_id = ?",
                (payload, source, evidence or "", now, row["slot_id"]),
            )
            _trim_history(conn, row["slot_id"])
            return "updated"

    def delete_slot(
        self,
        owner_id: str,
        slot_key: str,
        *,
        scope: str,
        project_id: str | None = None,
    ) -> bool:
        pid = project_id if scope == SCOPE_PROJECT else None
        with self.transaction() as conn:
            cursor = conn.execute(
                "DELETE FROM memory_slots WHERE owner_id = ? AND scope = ?"
                " AND IFNULL(project_id, '') = ? AND slot_key = ?",
                (owner_id or "", scope, pid or "", slot_key),
            )
            return bool(cursor.rowcount)

    def clear_slots(
        self,
        owner_id: str,
        *,
        scope: str = "all",
        project_id: str | None = None,
    ) -> int:
        """按层清空。``scope`` ∈ {all, global, project}。

        ``project`` 只清当前项目的项目级槽位，全局画像不受影响 ——
        用户在界面上说的「清空本项目」就是这个意思。
        """
        with self.transaction() as conn:
            if scope == "global":
                cursor = conn.execute(
                    "DELETE FROM memory_slots WHERE owner_id = ? AND scope = ?",
                    (owner_id or "", SCOPE_GLOBAL),
                )
            elif scope == "project":
                cursor = conn.execute(
                    "DELETE FROM memory_slots WHERE owner_id = ? AND scope = ?"
                    " AND IFNULL(project_id, '') = ?",
                    (owner_id or "", SCOPE_PROJECT, project_id or ""),
                )
            else:
                cursor = conn.execute(
                    "DELETE FROM memory_slots WHERE owner_id = ?", (owner_id or "",)
                )
            return int(cursor.rowcount or 0)

    def mark_injected(self, slot_ids: list[str]) -> None:
        """记录「这条记忆进入过 prompt」。

        v1 的 ``hits`` 字段从定义到删表**从来没有自增过任何一处**，
        于是「这条到底有没有被用上」完全无从得知。这里把它接上。
        """
        ids = [slot_id for slot_id in (slot_ids or []) if slot_id]
        if not ids:
            return
        now = utc_now().isoformat()
        with self.transaction() as conn:
            conn.executemany(
                "UPDATE memory_slots SET last_injected_at = ? WHERE slot_id = ?",
                [(now, slot_id) for slot_id in ids],
            )

    # --------------------------------------------------- memory_state 写 --

    def set_consent(self, owner_id: str) -> str:
        now = utc_now().isoformat()
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO memory_state(owner_id, consent_at) VALUES (?, ?)"
                " ON CONFLICT(owner_id) DO UPDATE SET consent_at = ?",
                (owner_id or "", now, now),
            )
        return now

    def set_onboarded(self, owner_id: str) -> str:
        now = utc_now().isoformat()
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO memory_state(owner_id, onboarded_at) VALUES (?, ?)"
                " ON CONFLICT(owner_id) DO UPDATE SET onboarded_at = ?",
                (owner_id or "", now, now),
            )
        return now

    def set_memory_off(self, owner_id: str, off: bool) -> bool:
        """per-user 总开关。关掉后完全不注入（槽位数据留着，重新打开即恢复）。"""
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO memory_state(owner_id, memory_off) VALUES (?, ?)"
                " ON CONFLICT(owner_id) DO UPDATE SET memory_off = ?",
                (owner_id or "", 1 if off else 0, 1 if off else 0),
            )
        return bool(off)

    # --------------------------------------------------------- 对话读取 --

    def read_recent_dialogue(
        self,
        owner_id: str,
        *,
        days: int = EXTRACT_LOOKBACK_DAYS,
        max_messages: int = EXTRACT_MAX_MESSAGES,
        project_id: str | None = None,
    ) -> list[dict[str, str]]:
        """读该用户最近的真实对话。

        ``messages`` 表本身没有 owner_id，但每行都挂在项目下，而项目有归属 ——
        直接 join ``projects`` 即可，不需要给主库加列。

        带 ``project_id`` 时只读那一个项目：项目级记忆必须挂对项目，而逐项目切分
        是**最可靠的溯源方式**（比事后拿 evidence 去匹配原文可靠得多 ——
        模型生成的措辞与原文逐字命中率很低）。
        """
        since = (
            datetime.now(timezone.utc) - timedelta(days=max(1, int(days)))
        ).isoformat()
        sql = (
            "SELECT m.role, m.content, m.created_at, m.project_id,"
            " p.subject AS project_name"
            " FROM messages m JOIN projects p ON p.project_id = m.project_id"
            " WHERE p.owner_id = ? AND m.created_at >= ? AND m.content != ''"
        )
        args: list[Any] = [owner_id or "", since]
        if project_id:
            sql += " AND m.project_id = ?"
            args.append(project_id)
        sql += " ORDER BY m.created_at DESC LIMIT ?"
        args.append(max(1, int(max_messages)))
        rows = self._conn.execute(sql, tuple(args)).fetchall()
        # 查询是倒序（取最新的 N 条），输出要正序才像一段对话
        return [
            {
                "role": row["role"] or "",
                "content": row["content"] or "",
                "project_id": row["project_id"] or "",
                "project_name": row["project_name"] or "",
            }
            for row in reversed(rows)
        ]

    def active_projects(self, owner_id: str, *, limit: int = EXTRACT_MAX_PROJECTS) -> list[str]:
        """窗口内最近活跃的项目（按消息数），用于逐项目提取。"""
        since = (
            datetime.now(timezone.utc) - timedelta(days=EXTRACT_LOOKBACK_DAYS)
        ).isoformat()
        rows = self._conn.execute(
            "SELECT m.project_id AS pid, COUNT(*) AS total"
            " FROM messages m JOIN projects p ON p.project_id = m.project_id"
            " WHERE p.owner_id = ? AND m.created_at >= ? AND m.content != ''"
            " GROUP BY m.project_id ORDER BY total DESC, pid DESC LIMIT ?",
            (owner_id or "", since, max(1, int(limit))),
        ).fetchall()
        return [
            str(row["pid"])
            for row in rows
            if str(row["pid"] or "")
            and int(row["total"] or 0) >= EXTRACT_MIN_MESSAGES_PER_PROJECT
        ]

    # -------------------------------------------------------- v1 遗留读 --

    def list_notes(self, owner_id: str, *, limit: int = 200, kind: str = "") -> list[dict[str, Any]]:
        """legacy：只服务 /api/memory/notes，不再参与注入。"""
        sql = "SELECT * FROM memory_notes WHERE owner_id = ?"
        args: list[Any] = [owner_id or ""]
        if kind:
            sql += " AND kind = ?"
            args.append(kind)
        sql += " ORDER BY updated_at DESC LIMIT ?"
        args.append(max(1, int(limit)))
        rows = self._conn.execute(sql, tuple(args)).fetchall()
        return [_note_row(row) for row in rows]

    def count(self, owner_id: str) -> int:
        row = self._conn.execute(
            "SELECT COUNT(*) AS total FROM memory_notes WHERE owner_id = ?",
            (owner_id or "",),
        ).fetchone()
        return int(row["total"] or 0)

    def state(self, owner_id: str) -> dict[str, Any]:
        row = self._conn.execute(
            "SELECT * FROM memory_state WHERE owner_id = ?", (owner_id or "",)
        ).fetchone()
        if row is None:
            return {
                "owner_id": owner_id or "",
                "pending": 0,
                "last_run_at": None,
                "last_error": "",
                "last_note": 0,
                "consent_at": None,
                "onboarded_at": None,
                "memory_off": 0,
            }
        keys = row.keys()
        return {
            "owner_id": row["owner_id"],
            "pending": int(row["pending"] or 0),
            "last_run_at": row["last_run_at"],
            "last_error": row["last_error"] or "",
            "last_note": int(row["last_note"] or 0),
            "consent_at": row["consent_at"] if "consent_at" in keys else None,
            "onboarded_at": row["onboarded_at"] if "onboarded_at" in keys else None,
            "memory_off": int(row["memory_off"] or 0) if "memory_off" in keys else 0,
        }

    # -------------------------------------------------------- v1 遗留写 --

    def add_note(
        self,
        owner_id: str,
        kind: str,
        content: str,
        *,
        source: str = "auto",
        project_id: str | None = None,
        evidence: str = "",
    ) -> bool:
        """legacy：依赖 memory_notes_unique 做去重。"""
        now = utc_now().isoformat()
        with self.transaction() as conn:
            cursor = conn.execute(
                "INSERT OR IGNORE INTO memory_notes(note_id, owner_id, kind, content,"
                " source, project_id, evidence, hits, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
                (
                    new_id("mem"),
                    owner_id or "",
                    kind,
                    content,
                    source,
                    project_id,
                    evidence or "",
                    now,
                    now,
                ),
            )
            return bool(cursor.rowcount)

    def delete_note(self, owner_id: str, note_id: str) -> bool:
        with self.transaction() as conn:
            cursor = conn.execute(
                "DELETE FROM memory_notes WHERE note_id = ? AND owner_id = ?",
                (note_id, owner_id or ""),
            )
            return bool(cursor.rowcount)

    def clear(self, owner_id: str, *, keep_manual: bool = False) -> int:
        sql = "DELETE FROM memory_notes WHERE owner_id = ?"
        args: list[Any] = [owner_id or ""]
        if keep_manual:
            sql += " AND source != 'manual'"
        with self.transaction() as conn:
            cursor = conn.execute(sql, tuple(args))
            return int(cursor.rowcount or 0)

    def bump_pending(self, owner_id: str, *, delta: int = 1) -> dict[str, Any]:
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO memory_state(owner_id, pending) VALUES (?, ?)"
                " ON CONFLICT(owner_id) DO UPDATE SET pending = pending + ?",
                (owner_id or "", max(0, int(delta)), max(0, int(delta))),
            )
        return self.state(owner_id)

    def finish_run(self, owner_id: str, *, added: int, error: str = "") -> None:
        now = utc_now().isoformat()
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO memory_state(owner_id, pending, last_run_at, last_error,"
                " last_note) VALUES (?, 0, ?, ?, ?)"
                " ON CONFLICT(owner_id) DO UPDATE SET"
                " pending = 0, last_run_at = ?, last_error = ?, last_note = ?",
                (
                    owner_id or "",
                    now,
                    error or "",
                    int(added),
                    now,
                    error or "",
                    int(added),
                ),
            )


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, ddl: str) -> None:
    """幂等加列。SQLite 没有 ADD COLUMN IF NOT EXISTS，只能先查 pragma。"""
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    if any(str(row["name"]) == column for row in rows):
        return
    conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


def _trim_history(conn: sqlite3.Connection, slot_id: str) -> None:
    conn.execute(
        "DELETE FROM memory_slot_history WHERE history_id IN ("
        " SELECT history_id FROM memory_slot_history WHERE slot_id = ?"
        " ORDER BY created_at DESC LIMIT -1 OFFSET ?)",
        (slot_id, SLOT_HISTORY_KEEP),
    )


def _slot_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "slot_id": row["slot_id"],
        "slot_key": row["slot_key"],
        "label": SLOT_LABELS.get(row["slot_key"], row["slot_key"]),
        "scope": row["scope"],
        "project_id": row["project_id"],
        "value_data": _value_from_storage(row["value"]),
        "source": row["source"],
        "evidence": row["evidence"] or "",
        "updated_at": row["updated_at"],
        "last_injected_at": row["last_injected_at"],
    }


def _note_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "note_id": row["note_id"],
        "kind": row["kind"],
        "kind_label": KIND_LABELS.get(row["kind"], "其他"),
        "content": row["content"],
        "source": row["source"],
        "project_id": row["project_id"],
        "evidence": row["evidence"] or "",
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


# --------------------------------------------------------------------------- #
# 提取
# --------------------------------------------------------------------------- #
EXTRACT_SYSTEM_PROMPT = """你在为一位学生维护「这个学习项目里的长期记忆」。

从给定的对话片段里，提取**值得跨对话长期记住**的项目级信息。宁缺毋滥。

只填这四个槽位，一个都不要多写：

1. stuck_points：他反复出错、明确表示不懂、或多次确认过的知识点。
   每项不超过 16 字，最多 5 项。用知识点本身的名字，不要写成句子。
2. progress：他在这个项目里已经学到哪了。一句话，不超过 24 字。
3. proj_pref：**仅限本项目内**反复出现的讲解偏好。最多 5 个标签，每个不超过 8 字。
4. open_questions：他明确说过「这个还没搞懂」「下次再看」的问题。
   每项不超过 20 字，最多 3 项。

【推荐标签】pref 类可以从这些里选，**但都不合适时请用你自己的短标签**，
不要硬套一个不准确的标签：
{pref_tags}

**不要提取**：
- 一次性的事实问题（「第 3 题怎么做」「这个公式是什么」）—— 那不是长期记忆
- 资料里的学科内容本身（那是知识库的事，不是关于人的记忆）
- 稳定的学业背景、目标、讲解偏好 —— 那些**由用户自己在设置里声明**，不归你管
- 任何你不知道是否真实、只是从措辞猜测的推断
- 隐私敏感信息（身份证号、住址、电话、精确到门牌的位置）

返回严格 JSON，不要任何额外说明：
{{"project": {{"stuck_points": ["趋肤深度与频率的关系"],
  "progress": "已过第一章，卡在传导电流模型",
  "proj_pref": ["多配类比"], "open_questions": ["非本征态的概率分布怎么算"]}}}}

没有值得记的槽位就**不要出现在 JSON 里**（不要填空串），实在没有就返回 {{"project": {{}}}}。"""


def _build_extract_prompt() -> str:
    tags = "、".join(PREF_EXPLAIN_TAGS)
    return EXTRACT_SYSTEM_PROMPT.format(pref_tags=tags)


def parse_project_slots(raw: str) -> dict[str, dict[str, Any]]:
    """从模型输出里解析项目级槽位。宽松到「只要有一对花括号就不放弃」。"""
    text = (raw or "").strip()
    if not text:
        return {}
    if text.startswith("```"):
        text = text.strip("`")
        if text[:4].lower() == "json":
            text = text[4:]
        text = text.strip()
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return {}
    try:
        data = json.loads(text[start : end + 1])
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    scope = data.get("project")
    if not isinstance(scope, dict):
        # 容忍模型少包一层 {"project": ...}
        scope = data
    out: dict[str, dict[str, Any]] = {}
    for key in PROJECT_SLOTS:
        if key not in scope:
            continue
        try:
            out[key] = normalize_value(key, scope[key])
        except SlotValueError:
            continue
    return out


# 明显不是知识点的节点名：纯数字 / 纯符号 / 单个字。
# 真机数据逼出来的：有项目的主题就叫「1」，节点名也叫「1」，于是「1（0%）」
# 差点作为「你反复栽过的一处」被**硬注入**进 prompt。客观卡点这一半宁可少。
_RE_JUNK_NODE = re.compile(r"^[\W\d_]+$")


def merge_stuck_points(
    llm_value: dict[str, Any] | None,
    weak_nodes: list[dict[str, Any]] | None,
) -> dict[str, Any] | None:
    """卡点槽合流：掌握度统计（客观）+ 模型自述（主观），各自标来源。

    为什么两路都要：掌握度给的「卡」是**客观的**（他答错了），模型给的「卡」是
    **他自己说的**（他说他不会）。两者都硬，但硬的方式不同，模型需要知道区别 ——
    对客观卡点要预判，对自述卡点要正面补。

    合流放在提取时做（此时天然有数据源），而不是注入时实时查 ——
    注入发生在模型代理层，那一层只有记忆 store，不该再挂一个知识库依赖。
    """
    items: list[dict[str, str]] = []
    for node in (weak_nodes or [])[:STUCK_OBJECTIVE_MAX]:
        if isinstance(node, dict):
            name = _clean_text(node.get("name"), SLOT_TEXT_LIMITS["stuck_points"])
            score = node.get("score")
        else:
            name = _clean_text(node, SLOT_TEXT_LIMITS["stuck_points"])
            score = None
        if not name or len(name) < 2 or _RE_JUNK_NODE.match(name):
            continue
        text = name
        if isinstance(score, (int, float)):
            text = f"{name}（{round(float(score) * 100)}%）"
        items.append({"text": text, "source": "mastery"})

    subjective = list((llm_value or {}).get("items") or [])
    cap = MAX_LIST_ITEMS["stuck_points"]
    for item in subjective:
        if len(items) >= cap:
            break
        text = str((item or {}).get("text") or "").strip()
        if not text:
            continue
        # 去掉掌握度那一侧带的百分比后缀再比，避免「同一个卡点两路都记一遍」
        head = text.split("（")[0]
        if any(head and head in str(existing["text"]) for existing in items):
            continue
        items.append({"text": text, "source": "self"})

    if not items:
        return None
    return {"items": items[:cap]}


def _dialogue_text(messages: list[dict[str, str]]) -> str:
    lines = []
    for message in messages:
        role = _ROLE_LABELS.get(message.get("role") or "", message.get("role") or "?")
        content = (message.get("content") or "").strip()
        if len(content) > 600:
            content = content[:600] + "…"
        if not content:
            continue
        lines.append(f"{role}：{content}")
    return "\n".join(lines)


def _evidence_text(messages: list[dict[str, str]], limit: int = 600) -> str:
    """提取时的「依据」——AI 到底是读了哪段对话才写出这条记忆。

    项目级记忆是**推断式**的（用户没主动声明），所以每条都要留一份它读到的原文，
    用户点「依据」能看到 AI 凭什么这么说 —— 这是「记忆可审计」的最后一环。
    逐项目切分给出「哪个项目」，这里给出「哪段话」；两者互补。

    只截断、不重写：这是原文快照，不是模型自己写的证据（模型措辞与原文逐字
    命中率极低，让模型写依据等于编一个不可核对的来源）。
    """
    text = _dialogue_text(messages)
    if len(text) > limit:
        text = text[:limit] + "…"
    return text


def should_extract(
    store: MemoryStore, owner_id: str, *, threshold: int = EXTRACT_THRESHOLD
) -> bool:
    """判断现在是否值得跑一次提取。

    ⚠️ 注意 ``MemoryAwareLlm._note_activity`` 是「先 bump_pending 再调本函数」，
    所以阈值 N 在**第 N 轮对话结束时**就会满足，不存在差一轮的问题。
    """
    state = store.state(owner_id)
    if state["pending"] < max(1, int(threshold)):
        return False
    last = state.get("last_run_at")
    if last:
        try:
            moment = datetime.fromisoformat(str(last))
            if moment.tzinfo is None:
                moment = moment.replace(tzinfo=timezone.utc)
            elapsed = datetime.now(timezone.utc) - moment
            if elapsed < timedelta(minutes=EXTRACT_COOLDOWN_MINUTES):
                return False
        except Exception:
            pass
    return True


def extract_memories(
    llm: Any,
    store: MemoryStore,
    owner_id: str,
    *,
    project_id: str | None = None,
    charge: Callable[[str, int, int], None] | None = None,
    weak_points_fn: Callable[[str], list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    """跑一次提取。返回 ``{"added": n, "items": [...], "error": ""}``。

    ``llm`` 必须是**原始客户端**（不是记账代理），否则提取自己会触发一次
    「调用后检查要不要提取」，形成递归。用量改由 ``charge`` 回调手动上报。

    项目级记忆逐项目提取：窗口常常横跨好几个库，而「卡点」这种东西必须挂对项目。
    逐项目切分是最可靠的溯源 —— 比事后拿模型写的 evidence 去匹配原文可靠得多
    （模型措辞与原文逐字命中率很低）。项目数上限见 ``EXTRACT_MAX_PROJECTS``。
    """
    if project_id:
        targets = [project_id]
    else:
        try:
            targets = store.active_projects(owner_id)
        except Exception:
            targets = []

    if not targets:
        store.finish_run(owner_id, added=0, error="")
        return {"added": 0, "items": [], "error": ""}

    added = 0
    stored: list[dict[str, Any]] = []
    errors: list[str] = []

    for target in targets:
        dialogue = store.read_recent_dialogue(owner_id, project_id=target)
        # 只有一轮对话看不出「长期」的东西
        if len(dialogue) < EXTRACT_MIN_MESSAGES_PER_PROJECT:
            continue

        body = _dialogue_text(dialogue)
        messages = [
            {"role": "system", "content": _build_extract_prompt()},
            {"role": "user", "content": f"以下是这个项目里最近的对话片段：\n\n{body}"},
        ]

        chunks: list[str] = []
        try:
            for chunk in llm.stream_chat_content(messages, "extract_user_memory"):
                if chunk:
                    chunks.append(chunk)
        except Exception as exc:  # noqa: BLE001 - 提取失败不该影响任何主流程
            errors.append(f"{type(exc).__name__}")
            continue

        raw = "".join(chunks)
        if charge is not None:
            try:
                charge(body, raw)
            except Exception:
                pass

        values = parse_project_slots(raw)
        if not values:
            continue

        # 卡点槽合流：客观（掌握度）在前，主观（自述）在后
        weak_nodes: list[dict[str, Any]] = []
        if weak_points_fn is not None:
            try:
                weak_nodes = list(weak_points_fn(target) or [])
            except Exception:
                weak_nodes = []
        merged = merge_stuck_points(values.get("stuck_points"), weak_nodes)
        if merged is not None:
            values["stuck_points"] = merged
        else:
            values.pop("stuck_points", None)

        for key in PROJECT_SLOTS:
            if key not in values:
                continue
            if len(stored) >= EXTRACT_MAX_ITEMS:
                break
            try:
                outcome = store.upsert_slot(
                    owner_id,
                    SCOPE_PROJECT,
                    key,
                    values[key],
                    project_id=target,
                    source="auto",
                    evidence=_evidence_text(dialogue),
                )
            except Exception:
                continue
            if outcome in ("added", "updated"):
                added += 1
                stored.append({"slot_key": key, "project_id": target, "outcome": outcome})

    store.finish_run(owner_id, added=added, error=";".join(errors))
    return {"added": added, "items": stored, "error": ";".join(errors)}


# 同时只允许一个提取任务在跑。多用户场景下这是全局锁 —— 提取是低频动作，
# 串行化省心且不会有并发写库的问题。
_extract_lock = threading.Lock()


# --------------------------------------------------------------------------- #
# 透明代理：注入记忆 + 攒轮数
# --------------------------------------------------------------------------- #
class MemoryAwareLlm:
    """转发 ``LlmClient`` 的全部方法，只对 ``MESSAGES_TASKS`` 注入长期记忆。

    与 ``core/usage.py`` 的记账代理是同一套思路：把横切关注点收在一处，既有端点
    一行不改。两层代理可以叠加，建议顺序 ``记账(记忆(原始客户端))`` ——
    记账在外层，才能把注入后的完整 prompt 一并计进用量。

    ⚠️ 本类**没有**包装 ``complete_json``（走 ``__getattr__`` 透传）。那类 payload
    型任务的注入由 ``core/llm.py::_system_prompt`` 读 contextvar 里的惰性 provider
    完成 —— 两组白名单互斥，因此不会双重注入。

    所有 ``astream_*`` 包装都用 ``def`` 而不是 ``async def``：需要在**调用发生的
    同步时刻**读取当前用户。``async def`` 的函数体要等第一次迭代才执行，那时请求
    可能已经结束、contextvar 已被清理，注入与计数都会落到「未识别用户」上。
    """

    def __init__(
        self,
        inner: Any,
        store_provider: Callable[[], MemoryStore | None],
        usage_store_provider: Callable[[], Any] | None = None,
        *,
        auto_extract: bool = True,
        weak_points_fn: Callable[[str], list[dict[str, Any]]] | None = None,
    ) -> None:
        object.__setattr__(self, "_inner", inner)
        object.__setattr__(self, "_store_provider", store_provider)
        object.__setattr__(self, "_usage_store_provider", usage_store_provider)
        object.__setattr__(self, "_auto_extract", auto_extract)
        object.__setattr__(self, "_weak_points_fn", weak_points_fn)

    def __getattr__(self, name: str) -> Any:
        return getattr(object.__getattribute__(self, "_inner"), name)

    # -- 内部 ------------------------------------------------------------- #
    def _store(self) -> MemoryStore | None:
        try:
            return object.__getattribute__(self, "_store_provider")()
        except Exception:
            return None

    def _block_for(self, owner: str) -> str:
        """拼注入块（走唯一入口，per-user 总开关在这里生效）。"""
        store = self._store()
        if store is None:
            return ""
        return memory_block_for(store, owner, active_project() or None)

    def _note_activity(self, owner: str) -> None:
        """记一次「这位用户又聊了一轮」，必要时交给后台线程提取。

        **不在请求线程里提取**：提取是一次完整的模型调用，要好几秒，用户不该为了
        「让 AI 记住我」而在发完消息后干等。
        """
        if not owner or not object.__getattribute__(self, "_auto_extract"):
            return
        store = self._store()
        if store is None:
            return
        try:
            store.bump_pending(owner)
        except Exception:
            return
        try:
            if not should_extract(store, owner):
                return
        except Exception:
            return
        if not _extract_lock.acquire(blocking=False):
            # 已有提取在跑，跳过。pending 未被清零，下一轮会再试。
            return
        try:
            threading.Thread(
                target=self._extract_worker, args=(owner,), daemon=True
            ).start()
        except Exception:
            _extract_lock.release()

    def _extract_worker(self, owner: str) -> None:
        try:
            store = self._store()
            if store is None:
                return
            inner = object.__getattribute__(self, "_inner")

            def _charge(prompt_text: str, output_text: str) -> None:
                # 提取的用量也得记进账，否则「AI 自己偷偷花钱」在账面上看不见。
                # 这里直接写用量 store，不走记账代理 —— 代理会再次触发提取，递归。
                provider = object.__getattribute__(self, "_usage_store_provider")
                if provider is None:
                    return
                try:
                    usage_store = provider()
                except Exception:
                    return
                if usage_store is None:
                    return
                try:
                    usage_store.record(
                        owner_id=owner,
                        task="extract_user_memory",
                        mode="stream",
                        prompt_chars=len(prompt_text or ""),
                        output_chars=len(output_text or ""),
                        est_tokens=estimate_tokens(prompt_text)
                        + estimate_tokens(output_text),
                    )
                except Exception:
                    pass

            # 传 inner（原始客户端）而不是 self，避免提取自己再次触发提取
            extract_memories(
                inner,
                store,
                owner,
                charge=_charge,
                weak_points_fn=object.__getattribute__(self, "_weak_points_fn"),
            )
        except Exception:
            pass
        finally:
            _extract_lock.release()

    @staticmethod
    def _aware(task: str) -> bool:
        return task in MESSAGES_TASKS

    # -- 注入点 ----------------------------------------------------------- #
    def astream_chat_content(
        self,
        messages: list[dict[str, Any]],
        task: str,
        *,
        temperature: float | None = None,
        extra_payload: dict[str, Any] | None = None,
    ) -> Any:
        owner = current_usage_owner()
        aware = self._aware(task)
        if aware:
            block = self._block_for(owner)
            if block:
                messages = inject_memory(messages, block)
        stream = object.__getattribute__(self, "_inner").astream_chat_content(
            messages, task, temperature=temperature, extra_payload=extra_payload
        )
        if not aware:
            return stream

        async def _wrapped() -> Any:
            try:
                async for chunk in stream:
                    yield chunk
            finally:
                self._note_activity(owner)

        return _wrapped()

    def astream_chat_with_tools(
        self,
        messages: list[dict[str, Any]],
        task: str,
        tools: list[dict[str, Any]],
        *,
        temperature: float | None = None,
    ) -> Any:
        owner = current_usage_owner()
        aware = self._aware(task)
        if aware:
            block = self._block_for(owner)
            if block:
                messages = inject_memory(messages, block)
        stream = object.__getattribute__(self, "_inner").astream_chat_with_tools(
            messages, task, tools, temperature=temperature
        )
        if not aware:
            return stream

        async def _wrapped() -> Any:
            try:
                async for event in stream:
                    yield event
            finally:
                self._note_activity(owner)

        return _wrapped()

    def stream_chat_content(
        self,
        messages: list[dict[str, Any]],
        task: str,
        *,
        temperature: float | None = None,
    ) -> Any:
        owner = current_usage_owner()
        aware = self._aware(task)
        if aware:
            block = self._block_for(owner)
            if block:
                messages = inject_memory(messages, block)
        stream = object.__getattribute__(self, "_inner").stream_chat_content(
            messages, task, temperature=temperature
        )
        if not aware:
            return stream

        def _wrapped() -> Iterator[str]:
            try:
                for chunk in stream:
                    yield chunk
            finally:
                self._note_activity(owner)

        return _wrapped()

    def complete_with_tools(
        self,
        messages: list[dict[str, Any]],
        task: str,
        tools: list[dict[str, Any]],
        *,
        temperature: float | None = None,
    ) -> dict[str, Any]:
        owner = current_usage_owner()
        aware = self._aware(task)
        if aware:
            block = self._block_for(owner)
            if block:
                messages = inject_memory(messages, block)
        result = object.__getattribute__(self, "_inner").complete_with_tools(
            messages, task, tools, temperature=temperature
        )
        if aware:
            self._note_activity(owner)
        return result

    def astream_complete_content(
        self,
        task: str,
        payload: dict[str, Any],
        temperature: float | None = None,
    ) -> Any:
        # 非对话类任务（结构化生成）原样透传：不注入偏好，也不计「聊了一轮」。
        # payload 型记忆注入走 core/llm.py::_system_prompt 的 contextvar，不在这里。
        return object.__getattribute__(self, "_inner").astream_complete_content(
            task, payload, temperature
        )


def inject_memory(messages: list[dict[str, Any]], block: str) -> list[dict[str, Any]]:
    """把记忆块并进 messages。

    优先追加到已有 system 消息的末尾 —— 不改动消息条数，避免某些网关对
    多条 system 的处理不一致（有的只认第一条，有的直接报错）。
    """
    if not block or not messages:
        return messages
    head = messages[0]
    if (
        isinstance(head, dict)
        and head.get("role") == "system"
        and isinstance(head.get("content"), str)
    ):
        merged = dict(head)
        merged["content"] = head["content"].rstrip() + "\n\n" + block
        return [merged] + list(messages[1:])
    return [{"role": "system", "content": block}] + list(messages)


def attach_memory_injection(
    llm: Any,
    store_provider: Callable[[], MemoryStore | None],
    usage_store_provider: Callable[[], Any] | None = None,
    *,
    enabled: bool = True,
    auto_extract: bool = True,
    weak_points_fn: Callable[[str], list[dict[str, Any]]] | None = None,
) -> Any:
    """给模型客户端套上记忆注入代理。

    幂等；``enabled=False`` 时原样返回 —— 这就是这个功能的总开关。
    """
    if not enabled or llm is None:
        return llm
    if isinstance(llm, MemoryAwareLlm):
        return llm
    return MemoryAwareLlm(
        llm,
        store_provider,
        usage_store_provider,
        auto_extract=auto_extract,
        weak_points_fn=weak_points_fn,
    )
