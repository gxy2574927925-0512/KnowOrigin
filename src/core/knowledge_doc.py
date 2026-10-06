# -*- coding: utf-8 -*-
"""知识点文档（Knowledge Doc）：把单个知识点展开成一份「复习用详解」，并可合订成整份。

## 为什么补这个

知源已有卡片（一问一答，碎片）、测验（检验）、一页速查表（整章压成一张对照表）。
缺的是「一个知识点讲透」这一层 —— 复习到最后，用户要的是**能从头读到尾的一段完整讲解**：
它是什么、公式每个符号什么意思、为什么成立、哪里最容易错、跟旁边那个概念差在哪。

## 质量口径（2026-09-30）

一份「讲透」的详解，质量不来自模型本身，而来自三层机制：

1. **一次只讲一个点** —— 单节点一次调用，不把整章塞进一次生成（整份文档 = 逐节点生成后合订）。
2. **结构化输出 + 逐字段兜底合并** —— 模型返回 JSON，每个字段单独校验；某字段不合法
   （太短、条数不够、类型不对）就**只退回该字段的本地兜底**，其余字段照用。于是永远
   不会出现「半份文档」或空小节。
3. **证据约束** —— 只投喂有限的来源摘录 + 邻居节点，提示词里写死「来源没有的事实一律不写」。

## 落点

新表 ``knowledge_docs``，仿 ``core/study_kit.py`` / ``core/node_study_plan.py`` 的解耦模式：
独立连接 + ``busy_timeout`` + 懒建表，不碰主库连接、不往 ``framework_nodes`` 塞正文。

槽位口径：单节点文档占 ``sha1(owner|project|node|node)`` 一格，整份文档占
``sha1(owner|project|<project>|project)`` 一格 —— 重算是覆盖不是新增。
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, NamedTuple


class Neighbor(NamedTuple):
    """一个相邻知识点。给「与相邻知识点的关系」一节当事实来源 —— 内容只来自框架本身。"""

    name: str
    relation: str = "related"
    note: str = ""


def local_stamp() -> str:
    """给读者看的时间戳（本地时区）。库里存 UTC，正文里写本地时间更直观。"""
    return datetime.now().strftime("%Y-%m-%d %H:%M")


SCHEMA = """
CREATE TABLE IF NOT EXISTS knowledge_docs (
    doc_key      TEXT PRIMARY KEY,
    owner_id     TEXT NOT NULL,
    project_id   TEXT NOT NULL,
    node_id      TEXT NOT NULL DEFAULT '',
    scope        TEXT NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    signature    TEXT NOT NULL DEFAULT '',
    content_json TEXT NOT NULL DEFAULT '',
    content_md   TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_docs_project
    ON knowledge_docs(project_id, scope, updated_at DESC);
"""

SCOPES: tuple[str, ...] = ("node", "project")

# self_check 回流成知识卡片时用的分类。与 ``core/database.Card.category`` 同一层概念，
# 但值必须自己定：卡片生成端点写的是「记忆卡片」之类的档位名，前端按 category 分组展示。
SYNC_CATEGORY = "知识点自测"

# 同步卡片时用的稳定 card_id 前缀。只有带这个前缀的卡才归本文档管 ——
# 这样「删除文档 / 重新生成」能精确回收自己造的那几张，不误伤用户手工建的卡。
SYNC_CARD_PREFIX = "kd_"

# 一份文档最多回流几张卡。MAX_CHECKS 已经封顶，这里只是防止 prompt 被改坏时
# 一次性往复习队列里灌进几十张卡（那会让「今天该复习」这个数字变得没法看）。
SYNC_MAX_CARDS = 3

# 回流卡在文档里的「出处小节」标题原文。必须与 ``render_node_markdown`` 写出的
# 标题逐字一致 —— 前端是拿它去正文里找同名标题再滚动过去的，对不上就跳不过去。
# ⚠️ 改渲染层的小节标题时，这里要跟着改，否则「回到文档」会静默失效。
SYNC_ORIGIN_SECTION = "自测"

# 每张卡的正面（问题）允许多长。与 normalize_node_result 里 self_check 的
# question 上限（400）一致，短于此的题目在生成阶段就已经被丢弃了。
SYNC_MAX_FRONT = 400

# 每张卡的背面（答案）允许多长。答案要塞进卡片、还要能塞进复习面板的预览，
# 过长的答案在这里截断而不是原样灌进去。
SYNC_MAX_BACK = 700

RELATION_LABELS = {
    "prereq": "前置",
    "next": "后继",
    "contrast": "对比",
    "related": "相关",
    "child": "属于",
    "parent": "上级",
}

# 各字段的最低成色要求（不满足即视为模型没写好 → 退回本地兜底）
MIN_SUMMARY = 10
MIN_DEFINITION = 16
MIN_STEP = 8
MIN_PITFALL = 6
MIN_RELATION_NOTE = 6
MIN_ANSWER = 4
MIN_WHY_ORDER = 8
MAX_STEPS = 8
MAX_PITFALLS = 6
MAX_RELATIONS = 8
MAX_CHECKS = 5
MAX_FORMULAS = 8

# 文档内提问（选中一段话问 AI）的预算
ASK_MAX_QUESTION = 600
ASK_MAX_SELECTION = 1200
ASK_WINDOW = 1600        # 选区前后各取多少字当上下文
ASK_MAX_CONTEXT = 9000   # 单节点整篇通常不到这个数；合订稿只送选区附近
ASK_MAX_HISTORY = 3      # 往上带几轮问答
ASK_MAX_HISTORY_ANSWER = 500

# --------------------------------------------------------------------------
# 提示词素材：事实铁律
# --------------------------------------------------------------------------

RULES = (
    "【事实铁律 —— 违反即判定本次生成失败】\n"
    "1. 只依据 payload.sources（来源摘录）、payload.node（节点说明与笔记）、"
    "payload.neighbors（相邻节点）里出现过的内容。没有的一律不写。\n"
    "2. ⚠️ 禁止以「这是本学科常识」为理由自行补充定义、公式、常数或数值。"
    "资料里没有就写「资料未覆盖」，不要用通识把它填满。\n"
    "3. 不伪造页码、引文、教材版本、教师观点。\n"
    "4. 可以打比方帮助理解，但这个比方只能放在 self_check 之外的行文里，"
    "且必须让读者看得出是比方，不能说成资料原文。\n"
    "5. 资料没交代因果时，用「可以这样理解」这类审慎措辞，不要写成断言。\n"
    "6. 不出现作者、学校、日期、文件名、src_xxx / node_xxx 等任何 ID。\n"
    "7. 公式用 LaTeX：行内 \\( ... \\)，独立成行 \\[ ... \\]。"
    "符号、下标、单位一律保留资料里的原始写法。\n"
    "8. progression 里的 before / after 只能写 payload.neighbors 或 payload.path 里"
    "出现过的知识点名称；框架里没有就留空，绝不编造相邻知识点。\n"
    "9. 只返回 JSON 对象，不要 Markdown 代码围栏，不要 JSON 之外的解释。\n"
)

_NODE_SCHEMA = (
    "【输出 JSON 字段】\n"
    "{\n"
    '  "summary": "一句话把握：它是什么、拿来干什么。40~120 字，不截断，不堆术语。",\n'
    '  "definition": "定义与符号约定：给出完整定义表述；若涉及符号，逐个写明含义与单位'
    '。可用行内 LaTeX。",\n'
    '  "progression": {"before": "上一站：必须先掌握的那个知识点的名称'
    '（只能取自 neighbors/path，没有就空字符串）",'
    ' "after": "下一站：学完本节自然走向的知识点的名称（同上）",'
    ' "why_order": "为什么这个先后顺序不能颠倒 —— 不先掌握上一站就学本节，会卡在哪里。'
    '本节是这条线的起点时说清它是起点。"},\n'
    '  "mechanism": ["推导或工作机制的第 1 步", "第 2 步"],\n'
    '  "formulas": [{"latex": "公式（LaTeX，不含 $）", "meaning": "这个式子在说什么",'
    ' "when": "什么时候用它、适用条件"}],\n'
    '  "pitfalls": [{"wrong": "常见误解：这个错法为什么看着像是对的（讲清直觉从哪来）",'
    ' "right": "正确理解 + 冲突出在哪一步（错在哪、哪一步开始对不上）"}],\n'
    '  "relations": [{"name": "相邻知识点名称", "relation": "prereq|next|contrast|related",'
    ' "note": "一句话说清联系或区别"}],\n'
    '  "self_check": [{"question": "自测题（不给提示、不带答案线索）",'
    ' "answer": "答案要点（只写核对用的关键结论，不重复题干）"}],\n'
    '  "grounding": "依据说明：本节的哪些内容来自哪份资料的哪一部分。'
    '资料没覆盖的地方要在这里点名。"\n'
    "}\n"
    "条数要求：mechanism 2~6 条；formulas 0~4 条（资料里没有公式就给空数组）；"
    "pitfalls 1~4 条；relations 0~6 条；self_check 2~4 条。\n"
    "pitfalls 的写法：wrong 里先说这个误解，再补一句「为什么这个想法看上去站得住」"
    "（直觉从哪来）；right 里给正确理解，并指出冲突出在哪一步。只并列「错/对」两句话"
    "是不够的 —— 读者不知道自己为什么刚才会想错。\n"
    "self_check 按「先回忆、再解释、后应用」三步排：第 1 题问「是什么/为什么」（不给提示，"
    "能只靠回忆答出），第 2 题问「为什么会这样、能举个例子吗」（要能答出理由），"
    "第 3 题若存在则问「什么情境下用/怎么落地」。题干里不要塞进答案本身的关键词，"
    "也不要出现「填空」或「下列哪个」。\n"
    "若 relations 里有 relation=contrast 的条目，self_check 里必须有一题专门考「这两个"
    "概念怎么区分」：给一个具体情境，问该用哪一个、为什么另一个不行。\n"
    "progression 是**一个对象**（不是数组）：三个键都要给，没有的写空字符串，不要省略键。\n"
    "⚠️ 资料不足以支撑某一节时，**该节给空（空字符串或空数组）**，"
    "由系统决定如何呈现 —— 千万不要为了凑格式编内容。\n"
)

_NODE_INSTRUCTION = (
    "你在为知源 KnowOrigin 生成【知识点详解】。"
    "你的任务不是罗列术语，而是把一个知识点讲到学生**能复述、能举例、能区分**。"
    "写的是给人从头读到尾的复习材料，不是词典条目。"
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_scope(value: Any) -> str:
    text = str(value or "").strip().lower()
    return text if text in SCOPES else "node"


def doc_key_for(owner_id: str, project_id: str, *, scope: str, node_id: str = "") -> str:
    """槽位键。多用户互不串：把 owner_id 一起打进键。"""
    scope = normalize_scope(scope)
    slot = node_id if scope == "node" else "<project>"
    raw = "|".join([str(owner_id), str(project_id), str(slot), scope])
    return hashlib.sha1(raw.encode("utf-8", "replace")).hexdigest()


# --------------------------------------------------------------------------
# Payload：交给模型的输入（纯函数，好测）
# --------------------------------------------------------------------------


def _clip(value: Any, limit: int) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if len(text) <= limit:
        return text
    return f"{text[: max(1, limit - 1)].rstrip()}…"


def _source_excerpts(
    sources: Iterable[Any], *, per_source: int = 1400, cap: int = 6
) -> list[dict[str, str]]:
    """来源摘录。截断是必要的：一次调用的输入有上限，塞整本书只会让模型在中段丢指令。"""
    out: list[dict[str, str]] = []
    for item in sources:
        text = ""
        for attr in ("text", "content", "summary", "description"):
            value = getattr(item, attr, None)
            if isinstance(value, str) and value.strip():
                text = value.strip()
                break
        if not text:
            continue
        out.append(
            {
                "source_id": str(getattr(item, "source_id", "") or ""),
                "name": _source_name(item),
                "excerpt": _clip(text, per_source),
            }
        )
        if len(out) >= cap:
            break
    return out


def _source_name(item: Any) -> str:
    for attr in ("filename", "name", "title"):
        value = getattr(item, attr, None)
        if isinstance(value, str) and value.strip():
            return _clip(value, 120)
    return ""


def build_node_payload(
    *,
    node: Any,
    path: Iterable[str] = (),
    neighbors: Iterable[Any] = (),
    sources: Iterable[Any] = (),
    exam_weight_label: str = "",
) -> dict[str, Any]:
    """组装单节点生成请求。纯函数，不碰数据库。"""
    neighbor_items: list[dict[str, str]] = []
    for item in list(neighbors)[:8]:
        name = _clip(getattr(item, "name", "") or "", 90)
        if not name:
            continue
        relation = str(getattr(item, "relation", "") or "related").strip().lower()
        label = RELATION_LABELS.get(relation, RELATION_LABELS["related"])
        neighbor_items.append(
            {
                "name": name,
                "relation": label,
                "note": _clip(getattr(item, "note", "") or getattr(item, "description", ""), 200),
            }
        )
    return {
        "instruction": _NODE_INSTRUCTION,
        "node": {
            "name": _clip(getattr(node, "name", ""), 120),
            "description": _clip(getattr(node, "description", ""), 900),
            "note": _clip(getattr(node, "note_content", ""), 700),
            "mastery": round(float(getattr(node, "mastery_score", 0.0) or 0.0), 3),
            "exam_weight": _clip(exam_weight_label, 40),
        },
        "path": [_clip(item, 80) for item in list(path)[:6] if _clip(item, 80)],
        "neighbors": neighbor_items,
        "sources": _source_excerpts(sources),
        "rules": RULES,
        "schema": _NODE_SCHEMA,
    }


# --------------------------------------------------------------------------
# 校验 + 逐字段兜底合并
# --------------------------------------------------------------------------


def _text(value: Any, limit: int) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit] if len(text) <= limit else f"{text[: max(1, limit - 1)].rstrip()}…"


def _text_list(value: Any, *, limit: int, item_limit: int, min_len: int) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        text = _text(item, item_limit)
        if len(text) >= min_len:
            out.append(text)
        if len(out) >= limit:
            break
    return out


def _dict_list(
    value: Any,
    *,
    limit: int,
    fields: tuple[tuple[str, int, int], ...],
    extra: tuple[str, ...] = (),
) -> list[dict[str, str]]:
    """校验「对象数组」字段：每个对象里每个必填字段都要够长，否则整条丢掉。

    ``extra`` 里列的是**不参与长度校验、但必须原样带过来**的键（例如 relations 的
    ``relation`` 枚举）—— 不显式声明就会被这里悄悄丢掉，模型给的关系类型全变成「相关」。
    """
    if not isinstance(value, list):
        return []
    out: list[dict[str, str]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        row: dict[str, str] = {}
        ok = True
        for field, item_limit, min_len in fields:
            text = _text(item.get(field), item_limit)
            if len(text) < min_len:
                ok = False
                break
            row[field] = text
        if ok:
            for key in extra:
                row[key] = _text(item.get(key), 60)
            out.append(row)
        if len(out) >= limit:
            break
    return out


def _progression(value: Any, fallback: dict[str, Any]) -> dict[str, str]:
    """校验「承接与递进」这一个对象字段。

    与其它字段一样是**逐项**兜底：模型给了 why_order 就留模型那句，只把没给的
    before / after 用框架里推出来的邻居补上 —— 递进链的坐标来自框架（事实），
    递进理由才需要模型（理解）。
    """
    out = {
        "before": str((fallback or {}).get("before") or "").strip(),
        "after": str((fallback or {}).get("after") or "").strip(),
        "why_order": "",
    }
    if not isinstance(value, dict):
        return out
    for field, limit in (("before", 120), ("after", 120)):
        text = _text(value.get(field), limit)
        # 弱模型爱写「无」「无前置」这类词，留着只会出现在正文里添乱
        if text and text not in {"无", "无前置", "无上一站", "none", "null", "-"}:
            out[field] = text
    why = _text(value.get("why_order"), 500)
    if len(why) >= MIN_WHY_ORDER:
        out["why_order"] = why
    return out


def normalize_node_result(raw: Any, fallback: dict[str, Any]) -> dict[str, Any]:
    """逐字段校验 + 兜底合并。

    ⚠️ 这里是整套质量机制的落点：模型某个字段没写好，**只**退那个字段的兜底，
    其余字段照用。全字段一起退会让模型白跑一次，全字段一起收会放出半成品。
    """
    if not isinstance(raw, dict):
        raw = {}
    result = dict(fallback)
    filled: list[str] = []

    for field, limit, floor in (
        ("summary", 400, MIN_SUMMARY),
        ("definition", 1400, MIN_DEFINITION),
        ("grounding", 600, 0),
    ):
        text = _text(raw.get(field), limit)
        if len(text) >= max(floor, 1):
            result[field] = text
            filled.append(field)

    progression = _progression(raw.get("progression"), fallback.get("progression") or {})
    result["progression"] = progression
    # 只有模型真的给了「为什么这个顺序」才算它写了这一节 —— 光有框架推出来的
    # before/after 不算，否则用户会以为递进理由也是模型依据资料写的。
    if str(progression.get("why_order") or "").strip():
        filled.append("progression")

    steps = _text_list(raw.get("mechanism"), limit=MAX_STEPS, item_limit=420, min_len=MIN_STEP)
    if len(steps) >= 2:
        result["mechanism"] = steps
        filled.append("mechanism")

    formulas = _dict_list(
        raw.get("formulas"),
        limit=MAX_FORMULAS,
        fields=(("latex", 300, 2), ("meaning", 400, 6), ("when", 400, 4)),
    )
    if formulas:
        result["formulas"] = formulas
        filled.append("formulas")

    pitfalls = _dict_list(
        raw.get("pitfalls"),
        limit=MAX_PITFALLS,
        fields=(("wrong", 400, MIN_PITFALL), ("right", 500, MIN_PITFALL)),
    )
    if pitfalls:
        result["pitfalls"] = pitfalls
        filled.append("pitfalls")

    relations = _dict_list(
        raw.get("relations"),
        limit=MAX_RELATIONS,
        fields=(("name", 120, 2), ("note", 420, MIN_RELATION_NOTE)),
        extra=("relation",),
    )
    if relations:
        for row in relations:
            key = str(row.get("relation") or "").strip().lower()
            # 模型可能给中文关系词，一律归一化到枚举，渲染时再翻译回来
            row["relation"] = key if key in RELATION_LABELS else _relation_from_text(row.get("relation"))
        result["relations"] = relations
        filled.append("relations")

    checks = _dict_list(
        raw.get("self_check"),
        limit=MAX_CHECKS,
        fields=(("question", 400, 6), ("answer", 700, MIN_ANSWER)),
    )
    if checks:
        result["self_check"] = checks
        filled.append("self_check")

    result["_filled"] = filled
    return result


def _relation_from_text(value: Any) -> str:
    text = str(value or "")
    for key, label in RELATION_LABELS.items():
        if label and label in text:
            return key
    return "related"


def build_node_fallback(
    *, node: Any, path: Iterable[str] = (), neighbors: Iterable[Any] = (), sources: Iterable[Any] = ()
) -> dict[str, Any]:
    """本地兜底：不调模型也能拼出一份「有话说」但绝不编造的最小文档。

    素材只有三样 —— 节点的说明/笔记、相邻节点、来源文件名。够不够好看不重要，
    重要的是**每一个字都有出处**，并且用户能立刻看出哪几节是资料没覆盖的。
    """
    name = _clip(getattr(node, "name", ""), 120) or "该知识点"
    description = re.sub(r"\s+", " ", str(getattr(node, "description", "") or "")).strip()
    note = re.sub(r"\s+", " ", str(getattr(node, "note_content", "") or "")).strip()
    first_sentence = ""
    if description:
        parts = re.split(r"(?<=[。！？!?；;])\s*", description)
        first_sentence = next((p.strip() for p in parts if p.strip()), description)
    # ⚠️ 没有素材就**留空**，不要编一句占位解释 —— 端点靠这个判断「这一份根本不该落库」，
    #    并告诉用户去补说明/挂资料，比静默给一份空壳文档有用得多。
    #    渲染层对空小节会写「资料未覆盖」。
    summary = first_sentence or _clip(note, 200)
    definition = description

    relation_rows: list[dict[str, str]] = []
    neighbor_items = list(neighbors)
    for item in neighbor_items[:MAX_RELATIONS]:
        neighbor_name = _clip(getattr(item, "name", ""), 120)
        if not neighbor_name:
            continue
        relation = str(getattr(item, "relation", "") or "related").strip().lower()
        relation_rows.append(
            {
                "name": neighbor_name,
                "relation": relation if relation in RELATION_LABELS else "related",
                "note": _clip(
                    getattr(item, "note", "") or getattr(item, "description", ""), 420
                )
                or "与本知识点同处一个学习分支，请对照原文确认两者的区别。",
            }
        )

    source_names = [name for name in (_source_name(s) for s in sources) if name]
    grounding = (
        "本节内容取自资料：" + "、".join(source_names[:6]) + "。"
        if source_names
        else "这个知识点还没有关联到任何资料，以下内容仅来自节点说明与相邻知识点 —— 建议先给它挂上资料再重新生成。"
    )

    return {
        "summary": _clip(summary, 400),
        "definition": _clip(definition, 1400),
        "progression": _fallback_progression(neighbor_items),
        "mechanism": [],
        "formulas": [],
        "pitfalls": [],
        "relations": relation_rows,
        "self_check": [],
        "grounding": _clip(grounding, 600),
        "source_names": source_names[:6],
        "note": _clip(note, 700),
    }


def _fallback_progression(neighbors: Iterable[Any]) -> dict[str, str]:
    """只用框架里的边拼出递进链的坐标 —— 一条都不联想。

    why_order 一律留空：本地没有资格写「为什么必须先学前置」，那句必须由模型
    依据资料说；渲染层看到空值会走 _empty_note，用户一眼能看出这节是兜底填的。
    """
    before = ""
    after = ""
    for item in neighbors:
        relation = str(getattr(item, "relation", "") or "").strip().lower()
        label = _clip(getattr(item, "name", ""), 120)
        if not label:
            continue
        if not before and relation == "prereq":
            before = label
        elif not after and relation == "next":
            after = label
    return {"before": before, "after": after, "why_order": ""}


def result_has_content(result: dict[str, Any]) -> bool:
    """判断这份结果有没有值得落库的东西（模型失败 + 节点没说明 = 真空）。"""
    return bool(str(result.get("summary") or "").strip() or str(result.get("definition") or "").strip())


# --------------------------------------------------------------------------
# self_check → 知识卡片（回流）
# --------------------------------------------------------------------------
#
# 为什么回流到 ``cards`` 表而不是新建一张练习表：
#
# 复习闭环已经在那张表上跑通了 —— ``/api/review/submit`` 与 ``/api/cards/{id}/self-rate``
# 都会调 ``framework.record_evidence(kind="card")``，顺着 learning_events 一路喂到
# ``core/mastery_bkt.py`` 的 BKT 观测序列里（"card" 在 VERIFIED_KINDS 内）。
# FSRS 排期也在 ``card_srs_state``，按 card_id 关联。
#
# 所以这里要做的只有一件事：把「问题」放正面、「答案」放背面、node_ids 绑到本节点。
# 答案落在卡背而不是正文里 —— 正文本就明写着答案（渲染层的既有行为，本次不动），
# 而卡片是翻面才见答案，测试效应才有意义。
#
# ⚠️ 阅读体验零变化：这一段不碰 render_node_markdown 的任何输出，
#    文档长什么样与加它之前逐字节一致。


def check_card_id(node_id: str, question: str) -> str:
    """由「节点 + 题面」派生的稳定卡片 id。

    稳定性是硬要求：同一个问题重新生成文档时必须复用同一个 card_id，否则 FSRS 排期
    （card_srs_state 按 card_id 关联）与已有复习记录会丢，用户的复习进度凭空归零。
    题面进哈希，所以改了题目就是新卡、是新排期 —— 这是对的，题目变了就该重新学。
    """
    digest = hashlib.sha1(
        "|".join([str(node_id), str(question)]).encode("utf-8", "replace")
    ).hexdigest()
    return f"{SYNC_CARD_PREFIX}{digest[:20]}"


def build_sync_cards(
    result: dict[str, Any],
    *,
    node_id: str,
    source_ids: Iterable[str] = (),
) -> list[dict[str, Any]]:
    """从 self_check 抽出要回流的卡片。纯函数，不碰数据库。返回的是「要写什么」。

    只取有题有答的条目；同一份结果里题面重复的只留第一张（模型偶尔会把同一题写两遍，
    那会在复习队列里变成两张一样的卡）。
    """
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
        # 用与 normalize_node_result 同一套 _text 归一，否则「看起来一样」的题面
        # （空白差异）会算出两个 card_id，卡片队列里就多出一张重复卡。
        front = _text(item.get("question"), SYNC_MAX_FRONT)
        back = _text(item.get("answer"), SYNC_MAX_BACK)
        if not front or not back:
            continue
        if front in seen:
            continue
        seen.add(front)
        out.append(
            {
                "card_id": check_card_id(node_id, front),
                "front": front,
                "back": back,
                "category": SYNC_CATEGORY,
                "difficulty": 2,
                "source_ids": src,
                "node_ids": [str(node_id)],
                # 前端拿它 + node_ids[0] 定位回文档里的那一节
                "origin_section": SYNC_ORIGIN_SECTION,
            }
        )
    return out


def sync_origin_section_exists(markdown: str) -> bool:
    """渲染层写出的正文里是否真的有 SYNC_ORIGIN_SECTION 那一节。

    存在的理由：「回到文档」是**按标题文字**在正文里找锚点的，而渲染层的小节标题
    是可以被改的（历史上就改过）。这里把「标题存在」变成一条可跑的断言，
    渲染层改了标题而忘了改 SYNC_ORIGIN_SECTION 时，测试会立刻红，而不是等到
    用户点了「回到文档」发现原地不动。
    """
    wanted = _squash(SYNC_ORIGIN_SECTION)
    if not wanted:
        return False
    return any(_squash(title) == wanted for title, _, _ in split_markdown_sections(markdown))


def sync_cards(
    database: Any,
    project_id: str,
    *,
    node_id: str,
    wanted: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    """把该节点的回流卡与 ``cards`` 表对齐（upsert + 回收多余的）。返回本次的增减。

    只按 ``SYNC_CARD_PREFIX`` 且 node_ids 含本节点来认领卡片，所以用户手工建的卡、
    别处生成的卡都不会被碰到。

    upsert 而不是「先删后插」：card_id 稳定，INSERT OR REPLACE 之后 FSRS 排期仍在
    （card_srs_state 是独立表，不随 cards 行替换而丢），用户的复习进度得以保留。
    """
    items = list(wanted)
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

    # 回收：本节点名下、但这次没再出现的回流卡（例如模型这次少写了一道题）。
    # 认领条件是「前缀 + node_ids 含本节点」两个都满足，用户自己建的卡碰不到。
    removed = 0
    for card in database.list_cards(project_id):
        card_id = str(getattr(card, "card_id", "") or "")
        if not card_id.startswith(SYNC_CARD_PREFIX) or card_id in keep_ids:
            continue
        if str(node_id) not in {str(n) for n in (getattr(card, "node_ids", []) or [])}:
            continue
        database.delete_card(project_id, card_id)
        removed += 1

    return {"synced": len(kept), "updated": updated, "removed": removed, "card_ids": kept}


# --------------------------------------------------------------------------
# Markdown 渲染
# --------------------------------------------------------------------------


def _md_text(value: Any) -> str:
    """正文里的纯文本：只把 HTML 危险字符写成 Markdown 反斜杠转义，其余一个字符都不动。

    ⚠️ 别在这里转义 ``*`` ``[`` ``]`` ``|``。前端 renderMarkdown 会先做 HTML 转义，
    但它**没有**「反斜杠转义」这一步 —— 转义出来的 ``\\*`` 会被原样显示成 ``\\*``，
    于是用户看到 ``\\*\\*超前\\*\\*`` 这种垃圾，模型写的加粗还彻底失效。（真机验证抓到的）

    ``\\<`` ``\\>`` 则是两头都对的写法：前端 inline() 会把 ``\\&lt;`` 还原成字面量 ``<``，
    别的 Markdown 渲染器（Obsidian 等）也按标准把 ``\\<`` 显示成 ``<``，
    同时裸 HTML 标签不会在下载出来的 .md 里成形。表格里的竖线走 _md_cell。
    """
    return str(value or "").replace("<", "\\<").replace(">", "\\>")


def _md_cell(value: Any) -> str:
    """表格单元格里的纯文本：竖线会截断表格，必须再转义成 ``\\|``。

    前端按「未被反斜杠转义的竖线」切分单元格，所以这里的反斜杠是有意义的。
    """
    return _md_text(value).replace("|", "\\|")


def render_node_markdown(
    result: dict[str, Any],
    *,
    title: str,
    path: Iterable[str] = (),
    mastery: float = 0.0,
    stale_sections: Iterable[str] = (),
    degraded: bool = False,
    generated_at: str = "",
) -> str:
    """把结构化字段拼成复习用详解。小节顺序固定，缺哪节就明说缺，不留空标题。"""
    stale = {str(item) for item in stale_sections}
    lines: list[str] = [f"# {_md_text(title)}", ""]

    meta_bits: list[str] = []
    path_list = [str(item) for item in path if str(item).strip()]
    if path_list:
        meta_bits.append(" › ".join(_md_text(item) for item in path_list))
    # 掌握度 0% 也照显示 —— 「还没学过」本身就是有价值的信息，藏起来反而像漏了字段
    if mastery is not None:
        meta_bits.append(f"掌握度 {round(float(mastery) * 100)}%")
    if generated_at:
        meta_bits.append(f"生成于 {generated_at}")
    if meta_bits:
        lines.extend(["> " + " · ".join(meta_bits), ""])
    if degraded:
        lines.extend(
            [
                "> ⚠️ 这份文档由本地兜底生成（模型这次没有返回可用内容），"
                "只包含资料中能直接核对的文字。",
                "",
            ]
        )

    summary = str(result.get("summary") or "").strip()
    definition = str(result.get("definition") or "").strip()
    progression = (
        result.get("progression") if isinstance(result.get("progression"), dict) else {}
    )
    mechanism = [str(x).strip() for x in (result.get("mechanism") or []) if str(x).strip()]
    formulas = [x for x in (result.get("formulas") or []) if isinstance(x, dict)]
    pitfalls = [x for x in (result.get("pitfalls") or []) if isinstance(x, dict)]
    relations = [x for x in (result.get("relations") or []) if isinstance(x, dict)]
    checks = [x for x in (result.get("self_check") or []) if isinstance(x, dict)]
    grounding = str(result.get("grounding") or "").strip()

    if summary:
        lines.extend(["## 一句话把握", "", _md_text(summary), ""])

    # 递进放在最前：读者先知道「这一节站哪儿」，后面几节才读得出前后依存关系。
    lines.extend(["## 承接与递进", ""])
    block = _progression_block(progression, title, stale)
    while block and not block[-1].strip():  # 块自己带尾部空行，这里统一收口
        block.pop()
    lines.extend(block)
    lines.append("")

    lines.extend(["## 定义与符号约定", ""])
    if definition:
        lines.extend([_md_text(definition), ""])
    else:
        lines.extend([_empty_note("definition", stale), ""])

    lines.extend(["## 推导与机制", ""])
    if mechanism:
        for index, step in enumerate(mechanism, 1):
            lines.append(f"{index}. {_md_text(step)}")
        lines.append("")
    else:
        lines.extend([_empty_note("mechanism", stale), ""])

    lines.extend(["## 公式与用法", ""])
    if formulas:
        lines.extend(["| 公式 | 含义 | 什么时候用 |", "| --- | --- | --- |"])
        for item in formulas:
            latex = str(item.get("latex") or "").strip()
            if not latex:
                continue
            lines.append(
                "| \\( "
                + latex.replace("|", "\\|")
                + " \\) | "
                + _md_cell(item.get("meaning"))
                + " | "
                + _md_cell(item.get("when"))
                + " |"
            )
        lines.append("")
    else:
        lines.extend([_empty_note("formulas", stale), ""])

    lines.extend(["## 易错点与常见混淆", ""])
    if pitfalls:
        lines.extend(["| 容易错的地方 | 正确理解 |", "| --- | --- |"])
        for item in pitfalls:
            lines.append(
                f"| {_md_cell(item.get('wrong'))} | {_md_cell(item.get('right'))} |"
            )
        lines.append("")
    else:
        lines.extend([_empty_note("pitfalls", stale), ""])

    lines.extend(["## 与相邻知识点的关系", ""])
    if relations:
        lines.extend(["| 相邻知识点 | 关系 | 说明 |", "| --- | --- | --- |"])
        for item in relations:
            key = str(item.get("relation") or "related").strip().lower()
            lines.append(
                f"| {_md_cell(item.get('name'))} | {RELATION_LABELS.get(key, '相关')} | "
                f"{_md_cell(item.get('note'))} |"
            )
        lines.append("")
    else:
        lines.extend([_empty_note("relations", stale), ""])

    lines.extend(["## 自测", ""])
    if checks:
        for index, item in enumerate(checks, 1):
            lines.append(f"**{index}. {_md_text(item.get('question'))}**")
            lines.extend(["", f"答案：{_md_text(item.get('answer'))}", ""])
    else:
        lines.extend([_empty_note("self_check", stale), ""])

    lines.extend(["## 依据", "", _md_text(grounding) if grounding else "资料未覆盖。", ""])
    return "\n".join(lines).rstrip() + "\n"


_EMPTY_TEXT = {
    "definition": "资料未覆盖：来源里没有给出这个知识点的定义。",
    "progression": "资料未覆盖：没有说明这个知识点与前后知识点为什么是这个先后顺序。",
    "mechanism": "资料未覆盖：来源里没有交代它的推导过程或工作机制。",
    "formulas": "这个知识点不涉及公式，或资料未给出公式。",
    "pitfalls": "资料未覆盖：来源里没有提到易错点。",
    "relations": "这个知识点暂时没有关联到相邻节点。",
    "self_check": "这一节没有生成自测题（模型本次未返回合格题目）。",
}


def _progression_block(
    progression: dict[str, Any], title: str, stale: set[str]
) -> list[str]:
    """「承接与递进」一节的正文。

    上一站 / 本节 / 下一站 这一行是路径坐标（来自框架的前置边，是事实）；
    下面那句为什么是这个顺序才是模型的理解，缺了要如实标注。
    """
    before = str(progression.get("before") or "").strip()
    after = str(progression.get("after") or "").strip()
    why = str(progression.get("why_order") or "").strip()
    if not (before or after or why):
        return [_empty_note("progression", stale)]
    chain: list[str] = []
    if before:
        chain.append(f"**上一站** {_md_text(before)}")
    chain.append(f"**本节** {_md_text(title)}")
    if after:
        chain.append(f"**下一站** {_md_text(after)}")
    out: list[str] = ["　→　".join(chain), ""]
    if not before:
        out.extend(["框架里这一节没有前置，它是这条线上的起点。", ""])
    if not after:
        out.extend(["框架里这一节后面还没有接续的知识点。", ""])
    if why:
        out.extend([_md_text(why), ""])
    else:
        out.extend([_empty_note("progression", stale), ""])
    return out


def _empty_note(section: str, stale: set[str]) -> str:
    base = _EMPTY_TEXT.get(section, "资料未覆盖。")
    if section in stale:
        return base + " 本次由本地兜底填充，不是模型输出。"
    return base


def _node_id(node: Any) -> str:
    return str(getattr(node, "node_id", "") or "")


def _node_name(node: Any) -> str:
    return str(getattr(node, "name", "") or "") or "未命名知识点"


def tree_order(nodes: Iterable[Any]) -> list[tuple[Any, list[str]]]:
    """深度优先展开框架树，父在子前 —— 与速查表的排列一致，合订稿的可读性靠它。"""
    items = list(nodes)
    by_id = {_node_id(n): n for n in items}
    children: dict[str, list[Any]] = {}
    roots: list[Any] = []
    for node in items:
        parent = str(getattr(node, "parent_id", "") or "")
        if parent and parent in by_id:
            children.setdefault(parent, []).append(node)
        else:
            roots.append(node)
    out: list[tuple[Any, list[str]]] = []
    stack: list[tuple[Any, list[str]]] = [(_root, [_node_name(_root)]) for _root in reversed(roots)]
    while stack:
        node, path = stack.pop()
        out.append((node, path))
        for kid in reversed(children.get(_node_id(node)) or []):
            stack.append((kid, path + [_node_name(kid)]))
    return out


def order_by_layer(
    nodes: Iterable[Any],
    chain: dict[str, dict[str, Any]],
    *,
    max_layer: int = 0,
) -> tuple[list[Any], dict[str, dict[str, Any]]]:
    """按**前置层号**重排知识点，返回 ``(排序后的节点, 修正后的递进坐标)``。

    这是「初学者循序渐进」的那条路：层号来自 ``compute_progression_chain``
    （前置链最长长度 + 1），第 N 层的知识要先把 1..N-1 层拿下。按它排，读下来
    是一条路；按框架树排则会在 L1 之后直接跳到 L8，因为两者是**不同的树** ——
    框架树按章节组织，层号按依赖算，它们本来就不对齐。

    ``max_layer > 0`` 时只保留前 N 层（给「刚入门、只想先看基础」的人）。
    截断后必须重算站号，否则正文里会出现「第 87 站」而全文只有 20 节。

    ⚠️ 层号一律取自**全量** chain，不能对截断后的子集重算 —— 否则 1.10「波粒
    二象性」的前置若落在被截掉的那层，它会被误判成第 1 层，顺序又乱了。
    截断只影响「收进来哪些」和「怎么编号」，不影响「它第几层」。
    """
    items = list(nodes)
    limit = max(0, int(max_layer or 0))
    kept = [
        node
        for node in items
        if limit <= 0 or int((chain.get(_node_id(node)) or {}).get("layer", 1)) <= limit
    ]
    # 层号相同则保持框架树顺序（同层内没有依赖先后，树的顺序就是稳定序）
    position = {_node_id(node): i for i, node in enumerate(tree_order(items))}
    kept.sort(
        key=lambda node: (
            int((chain.get(_node_id(node)) or {}).get("layer", 1)),
            position.get(_node_id(node), 0),
        )
    )
    kept_names = {_node_id(node): _node_name(node) for node in kept}
    out: dict[str, dict[str, Any]] = {}
    for station, node in enumerate(kept, 1):
        nid = _node_id(node)
        info = chain.get(nid) or {}
        # 承接/引出只留这份文档里真有的：指向被截掉那层的名字，
        # 读者在这个文档里找不到它，提示就等于白给。
        before = [b for b in (info.get("before") or []) if b in set(kept_names.values())]
        after = [a for a in (info.get("after") or []) if a in set(kept_names.values())]
        out[nid] = {
            "station": station,
            "layer": int(info.get("layer") or 1),
            "before": before,
            "after": after,
        }
    return kept, out


def compute_progression_chain(nodes: Iterable[Any]) -> dict[str, dict[str, Any]]:
    """本地算每个知识点的「递进坐标」：层号、站号、直接前置与直接后继。

    纯函数、零模型调用 —— 递进关系的事实来源是框架本身（前置边 + 树的顺序），
    不需要（也不该）让模型来编。层号 = 前置链的最长长度 + 1：

    - 第 1 层：没有前置，可以直接开始；
    - 第 N 层：得先把前面 N-1 层拿下。

    ⚠️ 前置边成环时不死循环：环上的节点一律按第 1 层处理（宁可说错一层，
    也不能让一次合订把服务卡住）。不在本项目里的前置 id 直接忽略。
    """
    items = list(nodes)
    known = {_node_id(n) for n in items}
    prereqs: dict[str, list[str]] = {}
    for node in items:
        nid = _node_id(node)
        prereqs[nid] = [
            str(pid) for pid in (getattr(node, "prerequisite_ids", None) or []) if str(pid) in known
        ]
    depth: dict[str, int] = {}

    def resolve(nid: str, seen: set[str]) -> int:
        if nid in depth:
            return depth[nid]
        if nid in seen:
            return 1
        seen.add(nid)
        parents = prereqs.get(nid) or []
        value = 1 if not parents else 1 + max(resolve(parent, seen) for parent in parents)
        depth[nid] = value
        return value

    for nid in prereqs:
        resolve(nid, set())

    names = {_node_id(n): _node_name(n) for n in items}
    successors: dict[str, list[str]] = {}
    for nid, parents in prereqs.items():
        for parent in parents:
            successors.setdefault(parent, []).append(nid)

    out: dict[str, dict[str, Any]] = {}
    for station, (node, _path) in enumerate(tree_order(items), 1):
        nid = _node_id(node)
        out[nid] = {
            "station": station,
            "layer": int(depth.get(nid, 1)),
            "before": [names[p] for p in prereqs.get(nid, []) if names.get(p)],
            "after": [names[s] for s in successors.get(nid, []) if names.get(s)],
        }
    return out


def _progression_suffix(info: dict[str, Any] | None) -> str:
    """目录项尾部的递进标记：` · 第 2 层 · 承 仪器光学设计`。"""
    if not info:
        return ""
    bits = [f"第 {int(info.get('layer') or 1)} 层"]
    before = [str(x) for x in (info.get("before") or []) if str(x).strip()]
    if before:
        bits.append("承 " + _md_text(before[0]))
    return " · " + " · ".join(bits)


def _stage_line(info: dict[str, Any] | None) -> str:
    """每节标题下的递进行 —— 让合订稿读起来是一条路，而不是一摞并列的小节。"""
    if not info:
        return ""
    bits = [f"第 {int(info.get('station') or 0)} 站", f"第 {int(info.get('layer') or 1)} 层"]
    before = [str(x) for x in (info.get("before") or []) if str(x).strip()]
    after = [str(x) for x in (info.get("after") or []) if str(x).strip()]
    bits.append(
        "承接「" + "、".join(_md_text(x) for x in before[:2]) + "」" if before else "这条线的起点"
    )
    if after:
        bits.append("引出「" + "、".join(_md_text(x) for x in after[:2]) + "」")
    return "> 递进 · " + " · ".join(bits)


def render_compiled_markdown(
    *,
    project_label: str,
    sections: Iterable[tuple[dict[str, Any], str, list[str]]],
    node_total: int,
    source_count: int = 0,
    generated_at: str = "",
    progression: dict[str, dict[str, Any]] | None = None,
    group_by_layer: bool = False,
    layer_limit: int = 0,
) -> str:
    """合订：把各节点的正文按框架树层级拼成一份带目录的长文。

    ``sections`` 的每一项是 ``(node, body_md, path_labels)``。纯本地拼装，零模型调用。
    ``progression`` 是 ``compute_progression_chain``（层号/站号/承接关系）的结果：
    有它才会在目录与每节标题下写出层号与承接关系 —— 让「章节递进」在合订稿里看得见。

    ``group_by_layer=True`` 时**改按层号分章**（配合 ``order_by_layer`` 的排序）：
    第 1 层一章、第 2 层一章……读下来就是一条由浅入深的路，适合初学者从头顺着读。
    默认 False —— 按框架树的顶层目录项分章，跟速查表的章节顺序一致。
    ``layer_limit > 0`` 会在抬头写明「这份只含前 N 层」。
    """
    items = list(sections)
    chain = progression or {}
    # 先分组再编号：目录与正文共用同一份 groups，编号天然一致，不会各算各的。
    groups: list[tuple[str, list[tuple[Any, str, list[str]]]]] = []
    for node, body, path_labels in items:
        labels = list(path_labels)
        if group_by_layer:
            layer = int((chain.get(_node_id(node)) or {}).get("layer", 1))
            group = f"第 {layer} 层"
        else:
            group = (labels or ["未分组"])[0]
        if not groups or groups[-1][0] != group:
            groups.append((group, []))
        groups[-1][1].append((node, body, labels))

    lines: list[str] = [f"# {_md_text(project_label)} · 知识文档", ""]
    meta_bits: list[str] = []
    if generated_at:
        meta_bits.append(f"更新于 {generated_at}")
    meta_bits.append(f"覆盖 {len(items)}/{node_total} 个知识点")
    if source_count:
        meta_bits.append(f"依据 {source_count} 份资料")
    if layer_limit > 0:
        meta_bits.append(f"只含第 1~{layer_limit} 层")
    lines.extend(["> " + " · ".join(meta_bits), ""])
    if len(items) < node_total:
        lines.extend(
            [
                f"> ⚠️ 还有 {node_total - len(items)} 个知识点没有生成详解 —— "
                "在速查表里点它们右侧的「＋文档」补上，然后重新合订即可。",
                "",
            ]
        )

    lines.extend(["## 目录", ""])
    if chain:
        lines.extend(
            [
                "层号按前置依赖算：第 1 层没有前置、可以直接开始；越往后的层，"
                "越要先拿下前面的层。站号就是本文里的阅读顺序。",
                "",
            ]
        )
    for group_index, (group, entries) in enumerate(groups, 1):
        lines.append(f"- **{group_index}. {_md_text(group)}**")
        for node_index, (node, _body, _path) in enumerate(entries, 1):
            info = chain.get(_node_id(node))
            lines.append(
                f"  - {group_index}.{node_index} {_md_text(_node_name(node))}"
                f"{_progression_suffix(info)}"
            )
    lines.extend(["", "---", ""])

    for group_index, (group, entries) in enumerate(groups, 1):
        hint = _layer_group_hint(group) if group_by_layer else ""
        lines.extend([f"## {group_index}. {_md_text(group)}", ""])
        if hint:
            lines.extend([hint, ""])
        for node_index, (node, body, _path) in enumerate(entries, 1):
            lines.extend([f"### {group_index}.{node_index} {_md_text(_node_name(node))}", ""])
            stage = _stage_line(chain.get(_node_id(node)))
            if stage:
                lines.extend([stage, ""])
            # 正文自带的一级标题由外层承担，剩下的小节整体降一级（## → ###）。
            lines.extend([_demote_headings(strip_leading_title(body)), "", "---", ""])

    lines.extend(["由知源 KnowOrigin 合订生成。AI 归纳内容请对照每个知识点《依据》一节所列资料核对。", ""])
    return "\n".join(lines).rstrip() + "\n"


def _layer_group_hint(group: str) -> str:
    """层号章下面那句「这一层该怎么用」。空串 = 不是层号章。"""
    digits = "".join(ch for ch in str(group) if ch.isdigit())
    if not digits:
        return ""
    layer = int(digits)
    if layer <= 1:
        return "> 这一层没有前置，**可以从这里开始**。先把它们读稳，后面几层才接得上。"
    return (
        f"> 这一层要先把前面 {layer - 1} 层拿下再读。按需要挑着读，不用按顺序背。"
    )


def _demote_headings(body: str) -> str:
    """把正文标题降两级。

    合订层已经占了 `##`（分组）与 `###`（节点），所以节点正文（最高 `##`）必须落到
    `####` 以下，否则小节标题和节点标题同级，目录和正文都会看起来串位。
    """
    out: list[str] = []
    for line in str(body or "").splitlines():
        if re.match(r"^#{1,5}\s+", line):
            out.append("##" + line)
        else:
            out.append(line)
    return "\n".join(out)


def strip_leading_title(body: str) -> str:
    """去掉节点正文开头的一级标题 —— 合订时标题由外层负责。"""
    lines = str(body or "").splitlines()
    index = 0
    while index < len(lines) and not lines[index].strip():
        index += 1
    if index < len(lines) and re.match(r"^#\s+\S", lines[index]):
        lines = lines[index + 1 :]
    while lines and not lines[0].strip():
        lines = lines[1:]
    return "\n".join(lines)


# --------------------------------------------------------------------------
# 按小节读文档（Agent 检索入口用）
# --------------------------------------------------------------------------
#
# 为什么需要它：一份详解两三千字，合订稿动辄两三万字。整篇硬截断会把表格和公式
# 切在半截中间，模型既读不到后半份（易错点、自测、关联），也读不完整前半份 ——
# 这是「文档明明在库里，Agent 却答不出里面写了什么」的第二种成因。
# 正确做法是让文档能被按小节精确取走，而不是按字数砍。

# 模型不会照抄小节标题，它会说「易错」「自测问答」「公式那块」。这里把常见说法
# 映射到实际标题，别让它因为标题对不上就以为整篇读不到。
SECTION_ALIASES: dict[str, tuple[str, ...]] = {
    "一句话把握": ("概述", "简介", "一句话", "把握", "总述", "summary"),
    "承接与递进": ("递进", "承接", "前后", "上下文", "顺序", "progression"),
    "定义与符号约定": ("定义", "符号", "概念", "约定", "definition"),
    "推导与机制": ("推导", "机制", "原理", "为什么", "mechanism"),
    "公式与用法": ("公式", "用法", "怎么用", "formula"),
    "易错点与常见混淆": ("易错", "混淆", "常见错误", "错误", "坑", "pitfall"),
    "与相邻知识点的关系": ("关系", "关联", "相邻", "对比", "relation"),
    "自测": ("自测", "自检", "测验", "问答", "检查", "复习", "self"),
    "依据": ("依据", "出处", "来源", "证据", "grounding"),
}

_HEADING_RE = re.compile(r"^(#{1,6})\s+(\S.*?)\s*$")


def _squash(text: Any) -> str:
    """压掉空白与 markdown 修饰符，只留可比较的字面。"""
    return re.sub(r"[\s*`_\-—·>]+", "", str(text or "")).strip().lower()


def split_markdown_sections(markdown: str) -> list[tuple[str, str, int]]:
    """按标题把 Markdown 切成 ``[(标题, 该标题下的正文, 标题层级)]``。

    标题行本身不进正文 —— 要引用原句时，"## 易错点与常见混淆" 不该被当成一句正文。
    首个标题之前的开场文字（详解开头那句 ``> CHAP_1 › ... · 掌握度 6%``）归到一个
    标题为空、层级 0 的条目里，不能丢。全篇没有任何标题时返回单条，标题为空。
    """
    sections: list[tuple[str, str, int]] = []
    title = ""
    level = 0
    body: list[str] = []

    def flush() -> None:
        if title or any(line.strip() for line in body):
            sections.append((title, "\n".join(body).strip(), level))

    for line in str(markdown or "").splitlines():
        hit = _HEADING_RE.match(line)
        if hit is None:
            body.append(line)
            continue
        flush()
        title = hit.group(2).strip()
        level = len(hit.group(1))
        body = []
    flush()
    return sections


def section_outline(markdown: str) -> list[dict[str, Any]]:
    """给小节目录用的一行摘要：``[{title, level, chars}]``，跳过标题前的开场白。

    只报标题与体量，不带正文预览 —— 合订稿有几十节，每节再带一两句预览就是几千字，
    真正要内容时让调用方按 section 取整节。
    """
    return [
        {"title": title, "level": level, "chars": len(body)}
        for title, body, level in split_markdown_sections(markdown)
        if title
    ]


def section_titles(markdown: str) -> list[str]:
    return [item["title"] for item in section_outline(markdown)]


def _match_section_title(titles: list[str], keyword: str) -> str | None:
    """标题匹配，三层容错：原样 → 互相包含 → 别名表。命中返回实际标题。"""
    wanted = _squash(keyword)
    if not wanted:
        return None
    for title in titles:
        if _squash(title) == wanted:
            return title
    for title in titles:
        low = _squash(title)
        if low and (wanted in low or low in wanted):
            return title
    for canonical, words in SECTION_ALIASES.items():
        pool = {_squash(canonical), *(_squash(w) for w in words)} - {""}
        if not any(wanted in word or word in wanted for word in pool if len(word) >= 2):
            continue
        for title in titles:
            low = _squash(title)
            if low in pool or any(word in low for word in pool if len(word) >= 2):
                return title
    return None


def find_markdown_sections(
    markdown: str, keyword: str, *, include_children: bool = True
) -> list[tuple[str, str]]:
    """按关键词取正文里所有命中的小节，返回 ``[(标题, 正文)]``。

    两个坑在这儿处理掉：

    1. **合订稿里同名小节会重复**（每个知识点都有一节「易错点与常见混淆」）。只返回
       第一节的话，模型问「易错点」拿到的是 6 个知识点里的 1 个，还以为那就是全部 ——
       所以同名的一并返回。
    2. **合订稿的知识点节本身没有内容**：``### 1.4 康普顿散射效应`` 底下只有一句递进
       摘要，真正的详解在它的 ``#### 一句话把握`` 等子节里。``include_children``
       把子节并进来，否则精确命中了标题却只拿到一百来字，等于还是没读到。
    """
    sections = split_markdown_sections(markdown)
    titles = [title for title, _, _ in sections if title]
    hit = _match_section_title(titles, keyword)
    if hit is None:
        return []
    level = next(lv for title, _, lv in sections if title == hit)
    picked: list[tuple[str, str]] = []
    inside = False
    for title, body, lv in sections:
        if title == hit:
            inside = True
        elif inside and lv <= level:
            inside = False
        if inside and (title or body):
            picked.append((title, body))
    return picked


# --------------------------------------------------------------------------
# 文档内提问（读到一半选中一句话，就地提问）
# --------------------------------------------------------------------------

_ASK_INSTRUCTION = (
    "学生正读着一份知识点详解，选中了其中一段想问明白。"
    "回答要像一个坐在旁边的助教：先给结论，再给依据，最后说清它跟前后知识点怎么连。"
)

# 两档只换「证据边界」那一段（铁律 1、2），后面关于语气、长度、引用、公式、格式的几条
# 两档逐字一致 —— 分段标注只对补充档有意义，别把它散进通用规则里。
_ASK_BOUNDARY_STRICT = (
    "1. 只依据 payload.context（这一节的正文）、payload.selection（学生选中的原文）、"
    "payload.node（节点说明）与 payload.neighbors（相邻知识点）里出现过的内容作答。"
    "材料里没有的，一律直说「材料里没写」—— 不要用学科通识补一个看起来像样的答案。\n"
    "2. 确实需要推理时，先讲明「材料没有直接说，可以这样推断」，"
    "并点出依据的是材料里哪一句。\n"
)

_ASK_BOUNDARY_EXTRA = (
    "1. 材料里有的，照旧先给材料里的结论，并用 > 引用块引出材料原话。\n"
    "2. 材料里没写、但问题确实需要更广的知识，可以答 —— 但必须整段放进 Markdown "
    "二级标题 `## 材料外补充` 下面，并在段首点明这是课程材料之外的通识或推断、"
    "不是本节材料的内容。绝不把补充和材料内的结论混在同一段里。\n"
    "3. 材料外仍然不许编：具体书名、文献、页码、链接、课程号一律不写；"
    "自己没把握的就直说「这点我不确定」，宁可少答也不要给一个看起来像样的说法。\n"
    "4. 材料压根没覆盖、又答不上来的，直说材料里没写、你也补充不了。\n"
)

_ASK_RULES_COMMON = (
    "不复述问题，不写「好问题」这类客套，直接从结论开始。\n"
    "默认 150~400 字。学生明确要求展开时可以更长，但每一段都要有材料支撑。\n"
    "引用材料原话用 Markdown 的 > 引用块，且必须是材料里逐字出现的句子。\n"
    "公式用 LaTeX：行内 \\( ... \\)，独立成行 \\[ ... \\]。\n"
    "直接输出 Markdown 正文：不要 JSON、不要代码围栏、不要元话术。"
)

_ASK_RULES = (
    "【回答铁律 —— 违反任何一条这次回答都算不合格】\n"
    + _ASK_BOUNDARY_STRICT
    + _ASK_RULES_COMMON
)

_ASK_RULES_EXTRA = (
    "【回答铁律 —— 违反任何一条这次回答都算不合格】\n"
    + _ASK_BOUNDARY_EXTRA
    + _ASK_RULES_COMMON
)


def _clip_block(value: Any, limit: int) -> str:
    """多行文本的截断：**保留换行与缩进**。

    ⚠️ 别拿 ``_clip`` 处理正文 —— 它会把所有空白压成一个空格，表格、列表、小标题
    全糊成一行，模型既引不准原句、也再也分不清层次。``_clip`` 只适合单行说明。
    """
    text = str(value or "").strip()
    if len(text) <= limit:
        return text
    return text[: max(1, limit - 1)].rstrip() + "…"


def excerpt_around(
    text: str, needle: str = "", *, window: int = ASK_WINDOW, cap: int = ASK_MAX_CONTEXT
) -> str:
    """从整篇文档里取「选区附近」的一段当上下文。

    合订稿可能几万字，每次提问都送整篇既贵、又会让模型在中段丢掉指令；而学生问的
    多半就是眼前这一段 —— 只送它前后的窗口，既准又便宜。定位不到就退回头部截断。
    """
    body = str(text or "")
    if len(body) <= cap:
        return body
    probe = re.sub(r"\s+", " ", str(needle or "")).strip()
    index = -1
    if probe:
        # 选区在正文里可能被换行/缩进打断，用逐级缩短的前缀去找
        for size in (32, 20, 12, 8):
            piece = probe[:size]
            if len(piece) < 4:
                break
            index = body.find(piece)
            if index >= 0:
                break
    if index >= 0:
        start = max(0, index - window)
        end = min(len(body), index + len(probe) + window)
        return (
            ("…" if start > 0 else "")
            + body[start:end]
            + ("…" if end < len(body) else "")
        )
    return body[:cap] + "…"


def build_ask_payload(
    *,
    question: str,
    selection: str = "",
    scope: str = "node",
    node: Any = None,
    path: Iterable[str] = (),
    neighbors: Iterable[Any] = (),
    context: str = "",
    section: str = "",
    history: Iterable[Any] = (),
    allow_extra: bool = False,
) -> dict[str, Any]:
    """组装「文档内提问」的输入。纯函数，不碰数据库。"""
    history_rows: list[dict[str, str]] = []
    for item in list(history)[-ASK_MAX_HISTORY:]:
        if not isinstance(item, dict):
            continue
        pair = {
            "question": _clip(item.get("question") or item.get("q"), 300),
            "answer": _clip(item.get("answer") or item.get("a"), ASK_MAX_HISTORY_ANSWER),
        }
        if pair["question"]:
            history_rows.append(pair)

    neighbor_rows: list[dict[str, str]] = []
    for item in list(neighbors)[:8]:
        label = _clip(getattr(item, "name", "") or "", 90)
        if not label:
            continue
        relation = str(getattr(item, "relation", "") or "related").strip().lower()
        neighbor_rows.append(
            {
                "name": label,
                "relation": RELATION_LABELS.get(relation, RELATION_LABELS["related"]),
                "note": _clip(getattr(item, "note", "") or getattr(item, "description", ""), 200),
            }
        )

    payload: dict[str, Any] = {
        "instruction": _ASK_INSTRUCTION,
        "scope": normalize_scope(scope),
        "section": _clip(section, 120),
        "selection": _clip_block(selection, ASK_MAX_SELECTION),
        "question": _clip(question, ASK_MAX_QUESTION),
        "context": _clip_block(context, ASK_MAX_CONTEXT + 200),
        "neighbors": neighbor_rows,
        "history": history_rows,
        # 规则随档位换，但 allow_extra 也显式带上：模型看的是 prompt 里那份角色设定，
        # 两条得指向同一个档，不然出现「人设说不许发散、规则却允许」的裂缝。
        "allow_extra": bool(allow_extra),
        "rules": _ASK_RULES_EXTRA if allow_extra else _ASK_RULES,
    }
    if node is not None:
        payload["node"] = {
            "name": _clip(getattr(node, "name", ""), 120),
            "description": _clip(getattr(node, "description", ""), 900),
            "note": _clip(getattr(node, "note_content", ""), 700),
            "path": [_clip(item, 80) for item in list(path)[:6] if _clip(item, 80)],
        }
    return payload


def clean_answer(text: str) -> str:
    """收拾模型输出：剥掉整段代码围栏、去掉开头的客套。"""
    body = str(text or "").strip()
    if body.startswith("```"):
        body = re.sub(r"^```[a-zA-Z0-9_-]*[ \t]*\r?\n?", "", body)
        body = re.sub(r"\r?\n?```[ \t]*$", "", body)
    stripped = body
    for _ in range(3):  # 「好的，这是个好问题：」会连着来，剥一层不够
        nxt = re.sub(r"^(?:好的|好问题|这是(?:个|一个)?好问题)[，,。！!：:]\s*", "", stripped)
        if nxt == stripped:
            break
        stripped = nxt
    # 只有在剥掉之后还剩足够内容时才认这一步，避免把「好的」开头的正经答案削掉半句
    if len(stripped) >= 20:
        body = stripped
    return body.strip()


# --------------------------------------------------------------------------
# Store
# --------------------------------------------------------------------------


class KnowledgeDocStore:
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

    def save(
        self,
        *,
        doc_key: str,
        owner_id: str,
        project_id: str,
        scope: str,
        node_id: str = "",
        title: str = "",
        signature: str = "",
        content: dict[str, Any],
        content_md: str,
    ) -> dict[str, Any]:
        """同一槽位只留最新一份 —— 文档是「当前版本」，不是流水账。"""
        stamp = _now()
        payload_json = json.dumps(content, ensure_ascii=False, default=str)
        with self.transaction() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO knowledge_docs (doc_key, owner_id, project_id,"
                " node_id, scope, title, signature, content_json, content_md,"
                " created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,"
                " COALESCE((SELECT created_at FROM knowledge_docs WHERE doc_key = ?), ?), ?)",
                (
                    doc_key,
                    owner_id,
                    project_id,
                    node_id,
                    normalize_scope(scope),
                    title,
                    signature,
                    payload_json,
                    content_md,
                    doc_key,
                    stamp,
                    stamp,
                ),
            )
        return {
            "doc_key": doc_key,
            "project_id": project_id,
            "node_id": node_id,
            "scope": normalize_scope(scope),
            "title": title,
            "content_md": content_md,
            "content": content,
            "updated_at": stamp,
        }

    def save_markdown(self, doc_key: str, content_md: str) -> bool:
        """只改正文（手工编辑 / 高亮落进 Markdown），不动结构化留档与指纹。

        返回有没有真的改到行 —— 没有就说明这份文档还不存在（端点据此提示「先生成」）。
        ⚠️ content_json 与 signature 一律不动：那是「模型当初写了什么」的留档，
        重新生成仍以它为准；手工编辑是盖在上面的一层，重新生成会覆盖它 —— 有意的。
        """
        with self.transaction() as conn:
            cur = conn.execute(
                "UPDATE knowledge_docs SET content_md = ?, updated_at = ? WHERE doc_key = ?",
                (str(content_md), _now(), doc_key),
            )
        return bool(cur.rowcount)

    def get(self, doc_key: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT * FROM knowledge_docs WHERE doc_key = ?", (doc_key,)
        ).fetchone()
        return self._row_to_dict(row) if row is not None else None

    def get_node(self, owner_id: str, project_id: str, node_id: str) -> dict[str, Any] | None:
        return self.get(doc_key_for(owner_id, project_id, scope="node", node_id=node_id))

    def list_for_project(
        self, owner_id: str, project_id: str, *, scope: str | None = None
    ) -> list[dict[str, Any]]:
        sql = "SELECT * FROM knowledge_docs WHERE owner_id = ? AND project_id = ?"
        params: list[Any] = [owner_id, project_id]
        if scope:
            sql += " AND scope = ?"
            params.append(normalize_scope(scope))
        sql += " ORDER BY updated_at DESC"
        rows = self._conn.execute(sql, tuple(params)).fetchall()
        return [self._row_to_dict(row) for row in rows]

    def delete(self, owner_id: str, project_id: str, *, scope: str, node_id: str = "") -> int:
        key = doc_key_for(owner_id, project_id, scope=scope, node_id=node_id)
        with self.transaction() as conn:
            cur = conn.execute("DELETE FROM knowledge_docs WHERE doc_key = ?", (key,))
        return cur.rowcount or 0

    def close(self) -> None:
        self._conn.close()

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
        try:
            content = json.loads(row["content_json"] or "{}")
        except (ValueError, TypeError):
            content = {}
        return {
            "doc_key": row["doc_key"],
            "project_id": row["project_id"],
            "node_id": row["node_id"],
            "scope": row["scope"],
            "title": row["title"] or "",
            "signature": row["signature"] or "",
            "content": content if isinstance(content, dict) else {},
            "content_md": row["content_md"] or "",
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }
