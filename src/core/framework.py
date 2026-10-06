from __future__ import annotations

import datetime as _dt
import hashlib
import json as _json
import re
from typing import Any

from .database import Database
from .llm import LlmClient, ModelOutputError
from .models import Card, FrameworkNode, QuizQuestion, Source
# 难度系数 / 边际递减 / 迁移分公式都在 transfer 模块。刻意**模块导入**而不是
# 逐个函数 from-import：这样下面公式里出现的 transfer_module.xxx 一眼可查，
# 也避免同名（freshness/effective）在别处被误用。
from . import transfer as transfer_module


CARD_FOCUS_SEQUENCE = ["概念", "定义", "公式", "方法", "对比", "优缺点", "种类", "条件应用"]
QUIZ_FOCUS_SEQUENCE = ["概念", "定义", "公式", "方法", "对比", "条件应用"]
VALID_COVERAGE_STATUSES = {"uncovered", "covered", "insufficient_source", "missing_prerequisite"}
VALID_LEARNING_STATUSES = {"unexplored", "encountered", "pending_confirmation", "learning", "mastered"}
VALID_EXAM_WEIGHTS = {"exam_critical", "exam_important", "exam_normal", "exam_basic", "exam_skip"}

# === 掌握度来源配置（透明化核心常量）===
# 权重 + 默认正确度（用于 correctness=None 时）+ 单行为增量上限
# 设计目标：提问 / 知识卡片 / 做题 / 测验 任意一项，用正常次数（≤6 次）都真实能把掌握度
# 从 0% 推到 ≥35% 进入「学习中」，避免"做了一堆行为却仍然已接触"的不透明感。
MASTERY_EVIDENCE_WEIGHTS: dict[str, float] = {
    "question": 0.10,  # 提问：6 次高质量提问即可进入学习中
    "solve": 0.16,     # 做题：练习反馈，中高权重
    "card": 0.12,      # 知识卡片：自测记忆，3~4 张"会了"即可进入学习中
    "quiz": 0.24,      # 测验：最能推动掌握度（1~2 次即进入学习中），最高权重
    "discuss": 0.10,   # AI 同学讨论：参与即小幅；说对加额走更高 correctness（约等于 question 档）
}
# 行为中文标签。**键集必须与 MASTERY_EVIDENCE_WEIGHTS 逐一对应** —— 这里是权威值，
# 由 /api/mastery/rules 下发给前端；前端各处只有兜底副本。
# 提成模块级常量而不是写在 mastery_evidence_rules 里，是为了让它和权重表并排放着：
# 之前它就漏了 discuss（权重表有 5 档、标签表只有 4 档），前端四处映射跟着一起漏，
# 讨论事件在台历里只能降级显示成英文 `discuss` + 灰点。
MASTERY_KIND_LABELS: dict[str, str] = {
    "question": "提问",
    "solve": "做题",
    "card": "知识卡片",
    "quiz": "测验",
    "discuss": "讨论",
}
MASTERY_DEFAULT_CORRECTNESS: dict[str, float] = {
    # 提问默认 65%：用户主动提问并得到答案，一般已经有实际吸收
    # （不是被动遇到），因此高于之前的 35% 占位型默认值。
    "question": 0.65,
    "solve": 0.55,
    "card": 0.55,      # 卡片自测默认视为"模糊"（与 recall=2 对齐）
    "quiz": 0.0,       # 测验必须显式判断对错，不给默认正确度
    "discuss": 0.55,   # 讨论参与默认"模糊"；"说对"时显式传 correction/correctness=1.0
}
# 单次行为增量上限（超过后截断，避免单次行为一下"学满"）
MASTERY_SINGLE_GAIN_CAP: dict[str, float] = {
    "question": 0.09,  # 单次提问最多 +9%（权重 0.10 × correct 0.95 × conf 0.95 ≈ 0.09）
    "solve": 0.13,     # 单次做题最多 +13%
    "card": 0.11,      # 单张卡片最多 +11%
    "quiz": 0.24,      # 全对高置信度最多 +24%（与 UI 历史文案对齐）
    "discuss": 0.10,   # 参与 max≈6%（0.10×0.95×0.6）；说对 max≈10%（0.10×0.95×0.95）
}
MASTERY_THRESHOLD_LEARNING = 0.35
MASTERY_THRESHOLD_MASTERED = 0.80
MASTERY_CONFIDENCE_FLOOR = 0.50  # < 该值 → pending_confirmation，不推动掌握度

# ── 迁移（泛化）证据：写进**另一个分数**，不动 mastery_score ──────────────
#
# 为什么不并进 mastery：memory 与 transfer 是两件事。4 道 D1 识记题能刷满
# mastery_score —— 这是设计意图（用户要看「学过多少」）—— 但它必须**刷不动**
# transfer_score，否则「迁移」就只是 mastery 的新名字。这里不新增 kind，
# 而是用一个显式的 target 参数分流：kind 仍走原表，新增一条 kind 只会
# 让前端那张标签映射表再漏一次（见上面 MASTERY_KIND_LABELS 的注释）。
MASTERY_TRANSFER_KIND = "quiz"  # 迁移题在事件流里记作 quiz（它确实是一次作答）
TRANSFER_CONFIDENCE_FLOOR = MASTERY_CONFIDENCE_FLOOR  # 同一道闸门，不另立标准

# ── 错因（学习者自选）─────────────────────────────────────────────
# 只保留「选出来会改变下一步动作」的档位 —— 不为没有消费者的分类采集数据。
# 四档各自对应一个不同的动作，所以下游（progress_engine）能真的按它换建议；
# 若是再拆成「审题粗心 / 算错 / 表达不规范」，那些档位下游动作完全一样，就是加壳。
ERROR_TYPES: dict[str, str] = {
    "prereq_missing": "这块我压根没学过",
    "confused": "和别的东西记混了",
    "forgotten": "想不起来",
    "other": "其他（看错题 / 算错 / 说不清）",
}

# 错因 → 下一步该做什么。写在建议里，让「先修这个」不再只是一句「重做一遍」。
ERROR_TYPE_ACTIONS: dict[str, str] = {
    "prereq_missing": "先把它的前置补上，再回来做这道",
    "confused": "做一次对比辨析，把这两个东西分开",
    "forgotten": "交给间隔复习，别指望今天记住",
    "other": "换个角度再练一遍",
}
LOW_VALUE_CARD_TOPICS = {
    "全文",
    "材料",
    "材料要点",
    "课程材料",
    "当前材料",
    "source material",
    "outline",
    "目录",
}


def stable_node_id(name: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9\u4e00-\u9fff]+", "_", name).strip("_").lower()
    digest = hashlib.sha1(name.encode("utf-8")).hexdigest()[:8]
    return f"node_{slug[:24] or 'topic'}_{digest}"


def build_framework(
    project_id: str,
    sources: list[Source],
    *,
    database: Database | None = None,
    llm_client: LlmClient | None = None,
    root_name: str | None = None,
    replace_existing: bool = False,
    progress: Any = None,
) -> list[FrameworkNode]:
    """progress: 可选回调，接收 {"stage","percent","detail"} 事件。

    2026-09-30：此前前端的构建进度条是「每 650ms 跳一格」的假进度，与实际构建无关。
    这里把四个**真实节点**报出来：解析来源完成 → 交给模型 → 模型输出完成 → 落库完成。
    模型调用本身是一次不透明的 HTTP 请求（complete_json 无流式），等待期由 api_server
    层用真实计时心跳补齐，本函数不编造等待期的百分比。
    """
    def report(event: dict[str, Any]) -> None:
        if callable(progress):
            try:
                progress(event)
            except Exception:  # 进度上报绝不影响构建本身
                pass

    if not sources:
        nodes: list[FrameworkNode] = []
    elif llm_client is None:
        report({"stage": "parse", "percent": 15, "detail": f"{len(sources)} 份来源 · 本地启发式构建"})
        nodes = heuristic_framework_from_sources(sources, root_name=root_name)
        report({"stage": "link", "percent": 80, "detail": f"{len(nodes)} 个知识点"})
    else:
        report({"stage": "parse", "percent": 15, "detail": f"正在解析 {len(sources)} 份来源"})
        payload = _framework_payload(sources, root_name=root_name)
        total_chars = sum(
            len(section.get("content") or "")
            for source_payload in payload.get("sources", [])
            for section in source_payload.get("sections", [])
        )
        report({"stage": "parse", "percent": 22, "detail": f"{len(sources)} 份来源 · 约 {total_chars} 字正文"})
        report({"stage": "extract", "percent": 26, "detail": "模型正在生成知识框架"})
        response = llm_client.complete_json("build_framework", payload)
        report({"stage": "extract", "percent": 84, "detail": "模型输出完成，正在校验"})
        nodes = validate_framework_response(response, sources, root_name=root_name)
        report({"stage": "link", "percent": 92, "detail": f"{len(nodes)} 个知识点已关联"})
    if database is not None:
        report({"stage": "render", "percent": 96, "detail": "写入知识图谱"})
        result = database.upsert_framework_nodes(project_id, nodes, replace=replace_existing)
        report({"stage": "done", "percent": 100, "detail": f"已更新 {len(result)} 个节点"})
        return result
    report({"stage": "done", "percent": 100, "detail": f"共 {len(nodes)} 个节点"})
    return nodes


def _framework_payload(sources: list[Source], root_name: str | None = None) -> dict[str, Any]:
    return {
        "instruction": (
            "严格基于来源正文生成 XMind 式中文知识框架。"
            "输出目标不是目录复刻，而是把来源中的章节、主题和可复习知识点组织成中心主题向外展开的思维导图。"
            "每个叶子节点都应像 Agent 问答区的教材式答案提纲：能直接用于复习、提问、生成卡片和测验。"
        ),
        "map_style": {
            "layout": "center_topic_with_balanced_main_branches",
            "root": "只保留一个中心主题节点；其子节点是 4-8 个一级主分支，适合在前端左右分叉展示。",
            "branch_types": [
                "章节/模块",
                "核心概念",
                "公式与符号",
                "机制/过程",
                "方法/步骤",
                "比较/分类",
                "条件/边界",
                "应用/题型",
            ],
            "leaf_node_goal": "叶子节点必须是来源正文中的具体考点，不是页码、目录项、文件名或空泛的“相关概念”。",
        },
        "quality_policy": {
            "source_grounding": [
                "只使用 payload.sources 中的 section.content；不得使用来源外常识补齐课程未讲授内容。",
                "每个 covered 节点必须填写至少一个有效 source_id，且 description 必须能回到对应来源片段。",
                "来源不足时可生成 insufficient_source 或 missing_prerequisite 节点，但 description 要写清缺口，不能假装已覆盖。",
                "正文中不要出现 src_ 开头的来源 ID；来源 ID 只放在 source_ids 字段。",
            ],
            "study_value": [
                "优先保留来源中反复讲解、包含定义、公式、机制、条件、比较、方法、应用或易错边界的内容。",
                "知识点名称使用 4-20 字明确术语或短语；不要使用完整长句当名称。",
                "description 用 35-140 字概括来源证据：写出关键定义、因果关系、公式含义、适用条件或对比差异。",
                "同级节点之间避免同义重复；跨来源重复出现的同一知识点要合并 source_ids。",
            ],
            "json_reliability": [
                "总节点数控制在 18-45 个；材料很少时可以少于 18 个，但不要超过 45 个。",
                "优先少而清晰，不要为了凑数量输出低价值节点。",
                "node_id 使用稳定英文或拼音短 id，例如 root、ch1_lens、lens_formula；不要使用空格。",
                "parent_id 必须引用本次 nodes 中已存在的 node_id；根节点 parent_id 必须为 null。",
            ],
        },
        "hierarchy_rules": [
            f"顶层根节点使用课程名“{root_name}”。" if root_name else "顶层根节点使用来源能够确认的课程主题。",
            "根节点下面放一级主分支；一级主分支下面可以继续放章节/主题/知识点，建议深度 3-5 层。",
            "来源天然章节清楚时：课程 -> 章/模块 -> 节/主题 -> 正文知识点。",
            "来源像讲义散点时：课程 -> 概念/公式/机制/方法/应用 等一级主分支 -> 具体知识点。",
            "每个有实质正文的节/主题提炼 1-3 个正文知识点；不能只输出章名、节名或目录项。",
            "知识点名称应是 4-20 字的明确术语或短语，description 用 35-140 字概括来源中的具体定义、机制、条件或结论。",
            "合并不同课件中重复出现的同一章、节和知识点，并汇总其 source_ids。",
            "过滤页码、页眉页脚、教师联系方式、学校名称、孤立公式符号、单个英文功能词、残缺句和‘Outline’等版式噪声。",
            "每个 covered 节点必须引用 source_ids；知识点必须能在对应 source 的 section.content 中找到依据。",
            "node_id 必须唯一且尽量稳定；parent_id 必须引用本次 nodes 中真实存在的 node_id。",
            "总节点数控制在 18-45 个，优先保留正文反复讲解、包含定义/推导/条件/比较/应用的内容。",
            # 2026-09-29 补：prerequisite_ids 此前在 schema 里只露了一个空数组 `[]`，
            # 指令里一句没提、自检里也没问 ⇒ 实测 183 个知识点只有 17 个填了前置（20 条边）。
            # 前置图几乎是空的，于是「按前置排期」「前置未达则不给推荐」这些能力全都落不了地。
            "prerequisite_ids：凡是**必须先理解另一个节点才能学会**的节点，都要填它的前置，值为本次 nodes 中真实存在的 node_id。",
            "前置只看**理解依赖**（学会 A 才学得会 B），不要把「同章」「相邻」「相关」当成前置；一个节点通常 1-3 个前置即可。",
            "没有前置就留空数组，不要为了凑数编造 node_id —— 编出来的前置会把无关的课排到前面，比没有前置更糟。",
        ],
        "self_check_before_output": [
            "是否只有一个中心根节点，且根节点 parent_id 为 null？",
            "根节点是否有 4-8 个一级主分支，分支名称适合思维导图浏览？",
            "叶子节点是否都是来源正文中的具体可复习考点？",
            "是否过滤了页码、目录、文件名、学校信息和 Outline 等噪声？",
            "**真正需要先修别的知识点才能学会的节点，prerequisite_ids 填了吗？（填的 node_id 必须真实存在，不是猜测）**",
            "JSON 是否完整闭合、没有尾随逗号、没有代码块、没有省略号？",
        ],
        "schema": {
            "nodes": [
                {
                    "node_id": "stable_id_without_spaces",
                    "parent_id": None,
                    "name": "中文知识点",
                    "description": "来源证据摘要",
                    "coverage_status": "covered|insufficient_source|missing_prerequisite|uncovered",
                    "source_ids": ["src_..."],
                    # 示例给成非空：空数组会被模型当成「这字段不用填」
                    "prerequisite_ids": ["另一个已存在的 node_id"],
                    "exam_weight": "exam_critical|exam_important|exam_normal|exam_basic|exam_skip",
                }
            ]
        },
        "sources": _framework_source_payloads(sources),
    }


def build_prereq_payload(nodes: list[FrameworkNode]) -> dict[str, Any]:
    """补建前置的 LLM 输入。

    为什么要单独一个任务而不是塞进 build_framework：前置图实测覆盖率只有约 9%
    （183 个知识点里 17 个有前置），存量项目不可能靠重新生成来修 —— 重生成会换掉全部
    node_id，等于把用户已有的掌握度、笔记、收藏全废掉。所以必须有一条**只补边**的路。
    """
    return {
        "instruction": (
            "下面是同一个课程的知识框架节点。请判断哪些节点**必须先理解另一个节点才学得会**，"
            "给它们补上前置关系。这一步只补「理解依赖」，不改动任何节点本身。"
        ),
        "rules": [
            "只填「不学会 A，就一定学不会 B」这种硬依赖；"
            "**不要把「同一章」「相邻」「主题相关」「先出现」当成前置** —— 那是假前置。",
            "只输出你有把握的边。拿不准就别填：编造的前置会把无关的课排到学生前面，比没有前置更糟。",
            "node_id 必须是下面 nodes 里真实存在的，不能自创、不能自指。",
            "一个节点通常 1-3 个前置；根节点与纯记忆型节点可以留空。",
            "不要为了凑数给每个节点都填 —— 正常情况是**只有一部分节点**真有前置。",
        ],
        "self_check_before_output": [
            "每条边是不是「不学会它就一定学不会这个」？",
            "有没有把「同章 / 相关 / 先后出现」误当成前置？",
            "node_id 是否都真实存在、没有自指？",
        ],
        "schema": {
            "edges": [{"node_id": "要补前置的节点", "prerequisite_ids": ["它依赖的节点 id"]}]
        },
        "nodes": [
            {
                "node_id": n.node_id,
                "name": n.name,
                "description": (n.description or "")[:120],
                "existing_prerequisite_ids": list(n.prerequisite_ids),
            }
            for n in nodes
        ],
    }


def validate_prereq_response(
    response: dict[str, Any],
    nodes: list[FrameworkNode],
) -> dict[str, Any]:
    """把 LLM 补建建议过滤成「可以安全落库」的边。

    三层过滤，与 validate_framework_response 的前置校验同口径：
    不存在 / 自指 / 重复 / **已存在** / **反向边已存在**（会立刻成环）一律丢掉。
    返回建议列表 + 被丢弃的数量 —— 丢弃数要显示给用户，否则「我让你补 20 条，你只补了 12 条」
    会被当成功能坏了。
    """
    valid = {n.node_id: n.name for n in nodes}
    existing = {n.node_id: set(n.prerequisite_ids) for n in nodes}
    suggestions: list[dict[str, Any]] = []
    invalid = 0
    skipped_existing = 0
    skipped_cycle = 0

    for raw in response.get("edges") or []:
        if not isinstance(raw, dict):
            invalid += 1
            continue
        nid = str(raw.get("node_id") or "").strip()
        if nid not in valid:
            invalid += 1
            continue
        picks: list[str] = []
        seen: set[str] = set()
        for raw_pid in raw.get("prerequisite_ids") or []:
            pid = str(raw_pid or "").strip()
            if not pid or pid == nid or pid in seen:
                continue
            if pid not in valid:
                invalid += 1
                continue
            if pid in existing[nid]:
                skipped_existing += 1
                continue
            if nid in existing[pid]:
                skipped_cycle += 1  # 反向边已存在，加上去立刻成环
                continue
            seen.add(pid)
            picks.append(pid)
        if picks:
            suggestions.append(
                {
                    "node_id": nid,
                    "node_name": valid[nid],
                    "prerequisite_ids": picks,
                    "prerequisite_names": [valid[p] for p in picks],
                }
            )
    suggestions.sort(key=lambda item: item["node_id"])
    return {
        "suggestions": suggestions,
        "edge_count": sum(len(s["prerequisite_ids"]) for s in suggestions),
        "invalid_count": invalid,
        "skipped_existing": skipped_existing,
        "skipped_cycle": skipped_cycle,
    }


def validate_framework_response(
    response: dict[str, Any],
    sources: list[Source],
    root_name: str | None = None,
) -> list[FrameworkNode]:
    raw_nodes = response.get("nodes")
    if not isinstance(raw_nodes, list):
        raise ModelOutputError("框架响应必须包含 nodes 列表。")
    valid_source_ids = {source.source_id for source in sources}
    nodes: list[FrameworkNode] = []
    seen_node_ids: set[str] = set()
    for raw in raw_nodes:
        if not isinstance(raw, dict):
            raise ModelOutputError("nodes 中每一项都必须是对象。")
        name = str(raw.get("name") or "").strip()
        if not name:
            raise ModelOutputError("框架节点缺少 name。")
        node_id = _stable_unique_node_id(str(raw.get("node_id") or ""), name, seen_node_ids)
        seen_node_ids.add(node_id)
        source_ids = [sid for sid in raw.get("source_ids", []) if sid in valid_source_ids]
        coverage = raw.get("coverage_status") if raw.get("coverage_status") in VALID_COVERAGE_STATUSES else None
        coverage = coverage or ("covered" if source_ids else "insufficient_source")
        learning_status = raw.get("learning_status") if raw.get("learning_status") in VALID_LEARNING_STATUSES else "unexplored"
        exam_weight = raw.get("exam_weight") if raw.get("exam_weight") in VALID_EXAM_WEIGHTS else "exam_normal"
        nodes.append(
            FrameworkNode(
                node_id=node_id,
                parent_id=_normalized_parent_id(raw.get("parent_id")),
                name=name,
                description=str(raw.get("description") or ""),
                coverage_status=coverage,
                learning_status=learning_status,
                mastery_score=_bounded_mastery_score(raw.get("mastery_score")),
                source_ids=source_ids,
                prerequisite_ids=list(raw.get("prerequisite_ids") or []),
                exam_weight=exam_weight,
            )
        )
    if not nodes:
        raise ModelOutputError("框架响应没有生成任何节点。")
    valid_node_ids = {node.node_id for node in nodes}
    cleaned: list[FrameworkNode] = []
    for node in nodes:
        parent_id = node.parent_id if node.parent_id in valid_node_ids and node.parent_id != node.node_id else None
        # 前置此前是**唯一一个不校验的引用字段**（parent_id 校验存在性、source_ids 过滤无效值，
        # 它却原样入库）⇒ 模型一旦编造 node_id，整条前置边就变成一条指向空气的边，
        # 排序与解锁推荐都会因为它「不在本项目里」而静默丢弃 —— 看着像填了，其实没用。
        prereqs: list[str] = []
        seen_prereq: set[str] = set()
        for raw_pid in node.prerequisite_ids:
            pid = str(raw_pid or "").strip()
            if not pid or pid == node.node_id or pid in seen_prereq:
                continue
            if pid not in valid_node_ids:
                continue
            seen_prereq.add(pid)
            prereqs.append(pid)
        cleaned.append(node.model_copy(update={"parent_id": parent_id, "prerequisite_ids": prereqs}))
    return _ensure_framework_root(cleaned, root_name, sources)


def prerequisite_stats(nodes: list[Any]) -> dict[str, Any]:
    """前置覆盖率 —— 这是个**产品指标**，不是调试信息。

    前置图几乎是空的时候，「按前置排期」「前置未达则不推荐」这些能力全都落不了地，
    但界面上看不出任何异常（排序照旧、推荐照出）。所以覆盖率必须能被量出来、被看见。
    实测（2026-09-29）：183 个知识点里只有 17 个有前置、共 20 条边 ⇒ 覆盖率约 9%。
    """
    ids = {getattr(n, "node_id", None) for n in nodes}
    with_prereq = 0
    edges = 0
    for node in nodes:
        raw = list(getattr(node, "prerequisite_ids", None) or [])
        valid = [p for p in raw if p in ids and p != getattr(node, "node_id", None)]
        if valid:
            with_prereq += 1
        edges += len(set(valid))
    total = len(nodes)
    return {
        "nodes": total,
        "nodes_with_prereq": with_prereq,
        "edges": edges,
        "coverage": round(with_prereq / total, 4) if total else 0.0,
    }


def _stable_unique_node_id(raw_node_id: str, name: str, seen_node_ids: set[str]) -> str:
    clean = re.sub(r"[^a-zA-Z0-9_\-\u4e00-\u9fff]+", "_", raw_node_id.strip()).strip("_")
    node_id = clean or stable_node_id(name)
    if node_id not in seen_node_ids:
        return node_id
    base = node_id[:42] or stable_node_id(name)
    suffix = 2
    while f"{base}_{suffix}" in seen_node_ids:
        suffix += 1
    return f"{base}_{suffix}"


def _normalized_parent_id(value: Any) -> str | None:
    if value is None:
        return None
    parent_id = str(value).strip()
    if not parent_id or parent_id.lower() in {"none", "null", "undefined"}:
        return None
    return parent_id


def _bounded_mastery_score(value: Any) -> float:
    try:
        score = float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, score))


def _framework_source_payloads(sources: list[Source]) -> list[dict[str, Any]]:
    usable = [source for source in sources if source.text.strip()]
    if not usable:
        return []
    per_source_budget = max(1600, min(6000, 60000 // len(usable)))
    payloads: list[dict[str, Any]] = []
    for source in usable:
        sections = _parse_source_sections(source.text)
        if sections:
            section_budget = max(320, per_source_budget // min(len(sections), 12))
            section_payloads = [
                {
                    "heading": section["name"],
                    "level": section["level"],
                    "content": _sample_text_across("\n".join(section["body"]), section_budget),
                }
                for section in sections[:12]
            ]
        else:
            section_payloads = [
                {
                    "heading": "全文",
                    "level": 1,
                    "content": _sample_text_across(source.text, per_source_budget),
                }
            ]
        payloads.append(
            {
                "source_id": source.source_id,
                "filename": source.filename,
                "status": source.status,
                "sections": section_payloads,
            }
        )
    return payloads


def _sample_text_across(text: str, limit: int) -> str:
    clean = text.strip()
    if len(clean) <= limit:
        return clean
    chunk_size = max(120, limit // 3)
    middle_start = max(0, len(clean) // 2 - chunk_size // 2)
    parts = [clean[:chunk_size], clean[middle_start : middle_start + chunk_size], clean[-chunk_size:]]
    return "\n[…章节正文节选…]\n".join(part.strip() for part in parts if part.strip())[:limit]


def _ensure_framework_root(
    nodes: list[FrameworkNode],
    root_name: str | None,
    sources: list[Source],
) -> list[FrameworkNode]:
    if not root_name:
        return nodes
    root = next((node for node in nodes if node.name.strip() == root_name.strip()), None)
    root_id = root.node_id if root else stable_node_id(f"course:{root_name}")
    result: list[FrameworkNode] = []
    if root is None:
        result.append(
            FrameworkNode(
                node_id=root_id,
                name=root_name,
                description="依据已上传课程材料整理的知识框架。",
                coverage_status="covered",
                source_ids=[source.source_id for source in sources if source.text.strip()],
                exam_weight="exam_critical",
            )
        )
    for node in nodes:
        if node.node_id == root_id:
            result.append(node.model_copy(update={"parent_id": None}))
        elif node.parent_id is None:
            result.append(node.model_copy(update={"parent_id": root_id}))
        else:
            result.append(node)
    return result


def heuristic_framework_from_sources(
    sources: list[Source],
    root_name: str | None = None,
) -> list[FrameworkNode]:
    nodes: list[FrameworkNode] = []
    node_ids: set[str] = set()  # 与 nodes 同步维护，避免每轮 all() 线性扫全表（O(n²)）
    root_id: str | None = None
    if root_name:
        root_id = stable_node_id(f"course:{root_name}")
        nodes.append(
            FrameworkNode(
                node_id=root_id,
                parent_id=None,
                name=root_name,
                description="依据已上传课程材料整理的知识框架。",
                coverage_status="covered",
                source_ids=[source.source_id for source in sources if source.text.strip()],
                exam_weight="exam_critical",
            )
        )
        node_ids.add(root_id)
    for source in sources:
        text = source.text.strip()
        if not text:
            continue
        outlined = _outline_framework_from_source(source, text, root_id=root_id)
        if outlined:
            nodes.extend(outlined)
            node_ids.update(node.node_id for node in outlined)
            continue
        candidates = _candidate_topics(text)
        if not candidates:
            candidates = [f"{_source_root_name(source)}核心内容"]
        source_root_name = _source_root_name(source)
        source_root_id = stable_node_id(f"{source.source_id}:root:{source_root_name}")
        if root_id is not None or source_root_id not in node_ids:
            nodes.append(
                FrameworkNode(
                    node_id=source_root_id,
                    parent_id=root_id,
                    name=source_root_name,
                    description=_first_sentence_around(text, source_root_name) or text[:180],
                    coverage_status="covered" if len(text) >= 30 else "insufficient_source",
                    source_ids=[source.source_id],
                    exam_weight="exam_important",
                )
            )
            node_ids.add(source_root_id)
        for idx, name in enumerate(candidates[:8]):
            sentence = _first_sentence_around(text, name)
            nodes.append(
                FrameworkNode(
                    node_id=stable_node_id(f"{source.source_id}:{name}"),
                    parent_id=source_root_id,
                    name=name,
                    description=sentence or f"来自 {source.filename} 的知识点。",
                    coverage_status="covered" if len(text) >= 30 else "insufficient_source",
                    source_ids=[source.source_id],
                    exam_weight="exam_important" if idx < 2 else "exam_normal",
                )
            )
    return _dedupe_nodes(nodes)


def _outline_framework_from_source(
    source: Source,
    text: str,
    root_id: str | None = None,
) -> list[FrameworkNode]:
    sections = _parse_source_sections(text)
    substantial = [section for section in sections if _meaningful_body_text(section["body"])]
    if not sections or not substantial:
        return []

    nodes: list[FrameworkNode] = []
    section_ids: dict[int, str] = {}
    included_indexes = {section["index"] for section in sections[:16]}
    for section in sections[:16]:
        path = " > ".join(_section_path(sections, section["index"]))
        node_id = stable_node_id(f"section:{section['name']}")
        section_ids[section["index"]] = node_id
        parent_index = section["parent_index"]
        parent_id = section_ids.get(parent_index) if parent_index in included_indexes else root_id
        body = _meaningful_body_text(section["body"])
        nodes.append(
            FrameworkNode(
                node_id=node_id,
                parent_id=parent_id,
                name=section["name"],
                description=_section_summary(section["body"], source.filename),
                coverage_status="covered" if body else "insufficient_source",
                source_ids=[source.source_id],
                exam_weight="exam_important" if section["level"] <= 2 else "exam_normal",
            )
        )

    concept_count = 0
    for section in sections[:16]:
        parent_id = section_ids.get(section["index"])
        if not parent_id:
            continue
        path = " > ".join(_section_path(sections, section["index"]))
        for name, description in _section_knowledge_points(section["body"], section["name"]):
            if concept_count >= 8:
                break
            nodes.append(
                FrameworkNode(
                    node_id=stable_node_id(f"concept:{section['name']}:{name}"),
                    parent_id=parent_id,
                    name=name,
                    description=description,
                    coverage_status="covered",
                    source_ids=[source.source_id],
                    exam_weight="exam_normal",
                )
            )
            concept_count += 1
    return nodes


def _parse_source_sections(text: str) -> list[dict[str, Any]]:
    sections: list[dict[str, Any]] = []
    stack: list[tuple[int, int]] = []
    by_path: dict[tuple[str, ...], int] = {}
    for line in text.splitlines():
        heading = _heading_from_line(line)
        if heading is None:
            if sections and line.strip():
                sections[stack[-1][1]]["body"].append(line.strip())
            continue
        level, name = heading
        while stack and stack[-1][0] >= level:
            stack.pop()
        parent_index = stack[-1][1] if stack else None
        parent_path = tuple(_section_path(sections, parent_index)) if parent_index is not None else ()
        path = (*parent_path, name)
        existing_index = by_path.get(path)
        if existing_index is None:
            existing_index = len(sections)
            sections.append(
                {
                    "index": existing_index,
                    "level": level,
                    "name": name,
                    "parent_index": parent_index,
                    "body": [],
                }
            )
            by_path[path] = existing_index
        stack.append((level, existing_index))
    return sections


def _section_path(sections: list[dict[str, Any]], index: int) -> list[str]:
    path: list[str] = []
    seen: set[int] = set()
    cursor: int | None = index
    while cursor is not None and cursor not in seen:
        seen.add(cursor)
        path.append(sections[cursor]["name"])
        cursor = sections[cursor]["parent_index"]
    return list(reversed(path))


def _meaningful_body_text(lines: list[str]) -> str:
    return " ".join(line for line in lines if not _is_content_noise(line)).strip()


def _section_summary(lines: list[str], filename: str) -> str:
    for index, line in enumerate(lines):
        if _is_content_noise(line):
            continue
        summary = _description_from_lines(lines, index)
        if summary:
            return summary
    return f"来源《{filename}》列出了该章节，但可提取的正文依据较少。"


def _section_knowledge_points(lines: list[str], section_name: str) -> list[tuple[str, str]]:
    candidates: list[tuple[int, int, str, str]] = []
    for index, raw_line in enumerate(lines):
        clean = _clean_content_line(raw_line)
        if _is_content_noise(clean):
            continue
        name, score = _knowledge_name_from_line(clean)
        if not name or name == section_name or name in section_name:
            continue
        description = _description_from_lines(lines, index)
        if len(description) < 12:
            continue
        candidates.append((score, index, name, description))

    selected: list[tuple[str, str]] = []
    seen: set[str] = set()
    for _, _, name, description in sorted(candidates, key=lambda item: (-item[0], item[1])):
        key = re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]+", "", name).lower()
        if not key or key in seen:
            continue
        selected.append((name, description[:220]))
        seen.add(key)
        if len(selected) >= 2:
            break
    return selected


def _clean_content_line(line: str) -> str:
    clean = re.sub(r"\s+", " ", line.strip())
    clean = re.sub(r"^[•●▪■◆◇]+\s*", "", clean)
    clean = re.sub(r"^\d+[.、)）]\s*", "", clean)
    return clean.strip()


def _knowledge_name_from_line(line: str) -> tuple[str | None, int]:
    clean = _clean_content_line(line)
    if not clean:
        return None, 0

    colon_match = re.match(r"^([^：:]{2,36})[：:]\s*(.*)$", clean)
    if colon_match:
        prefix = _clean_knowledge_name(colon_match.group(1))
        suffix = _clean_knowledge_name(colon_match.group(2))
        feature = re.match(r"^(.+?)的?特点\d*$", prefix)
        if feature and 2 <= len(suffix) <= 12:
            prefix = f"{feature.group(1)}{suffix}"
        if _looks_like_knowledge_name(prefix) and _contains_knowledge_signal(prefix):
            return prefix, 5
        # English colon prefix ("Definition:", "Principle:") — use suffix head
        if prefix.lower() in {"definition", "definitions", "theorem", "law", "principle",
                              "equation", "formula", "mechanism", "effect", "property",
                              "example", "procedure", "method", "rule", "type", "types",
                              "category", "condition", "application", "experiment", "note"}:
            head = _clean_knowledge_name(suffix[:28])
            if _looks_like_knowledge_name(head):
                return head, 4
        return None, 0

    # Chinese definition patterns
    definition_patterns = [
        r"(?:称为|叫作|叫做|所谓)(?:实现)?[“\"]?([\u4e00-\u9fffA-Za-z0-9χΧΔδωΩαβγθλπρσφψωμε()（）·\-— /]{2,28})",
        r"^([\u4e00-\u9fffA-Za-z0-9χΧΔδωΩαβγθλπρσφψωμε()（）·\-— /]{2,28})(?:是指|定义为|的本质|也称为|又称为)",
    ]
    for pattern in definition_patterns:
        match = re.search(pattern, clean)
        if match:
            name = _clean_knowledge_name(match.group(1))
            if _looks_like_knowledge_name(name) and _contains_knowledge_signal(name):
                return name, 5

    # English definition patterns
    english_definition_patterns = [
        r"([A-Za-z][A-Za-z0-9\- ]{2,34})\s+(?:is defined as|refers to|denotes|is known as|is called|can be defined as)\b",
        r"\b(?:We define|Define)\s+([A-Za-z][A-Za-z0-9\- ]{2,34})\s+(?:as|to be)\b",
        # "The X equation / The Maxwell equations / …" — capture name PLUS the
        # type-word (formula / law / equations / …) together inside group(1).
        # Otherwise downstream consumers would only see "Maxwell" / "Rydberg"
        # and miss the conceptual type that makes it a usable knowledge point.
        r"\b(?:The|A|An)\s+((?:[A-Z][A-Za-z0-9\-]+\s+){0,3}(?:theorem|theorems|law|laws|equation|equations|formula|formulas|principle|principles|effect|effects|mechanism|mechanisms|condition|conditions|property|properties|definition|definitions|method|methods|procedure|procedures|rule|rules|experiment|experiments))\b",
        # Hyphenated proper nouns: capture name + type together
        r"\b([A-Z][a-zA-Z]+(?:\s*-\s*[A-Z][a-zA-Z]+)*\s+(?:effect|effects|theorem|theorems|principle|principles|experiment|experiments|equation|equations|law|laws|formula|formulas|relation|relations|coefficient|coefficients))\b",
        # e.g. "Refractive index is a measure of how light propagates..." — noun phrase
        # followed by "is a/an/the <noun>" (previously blocked by the stricter pattern below).
        r"^([A-Z][A-Za-z0-9 ]{2,28})\s+is\s+(?:a|an|the)\b",
        # e.g. "Energy is conserved" / "Acceleration is the rate of change" (no article)
        r"^([A-Z][A-Za-z0-9 ]{2,28})\s+is\b(?!\s+(?:called|known|defined|referred)\b)",
    ]
    for pattern in english_definition_patterns:
        match = re.search(pattern, clean)
        if match:
            name = _clean_knowledge_name(match.group(1))
            if _looks_like_knowledge_name(name):
                # Accept even without explicit signal because the English structure IS a signal.
                if _contains_knowledge_signal(name) or 3 <= len(name) <= 30:
                    return name, 5

    if any(marker in clean for marker in ("称为", "叫作", "叫做", "所谓", "定义为", "的本质", "is defined as", "refers to", "is called", "is known as")):
        return None, 0

    # Short, sentence-ending title-like fragments (works for both CN and EN headings).
    if len(clean) <= 26 and not clean.endswith(("。", "；", ";", "！", "!", "？", "?", "，", ",")):
        name = _clean_knowledge_name(clean)
        if _looks_like_knowledge_name(name):
            if _contains_knowledge_signal(name):
                return name, 3
            # Short English / proper-noun headings (e.g. "Franck-Hertz Experiment")
            if re.match(r"^[A-Z]", name) and 3 <= len(name) <= 26 and not re.search(r"\s(is|are|was|were|has|have|can|may|must|will|should)\b", name):
                return name, 3
    return None, 0


def _clean_knowledge_name(value: str) -> str:
    clean = re.sub(r"\s+", " ", value).strip(" ：:;；,.，。、-—()（）[]【】")
    clean = re.sub(r"^(?:例|举例|问题|Question|Answer|答)\s*\d*\s*", "", clean, flags=re.IGNORECASE)
    return clean[:30]


def _looks_like_knowledge_name(value: str) -> bool:
    if not 2 <= len(value) <= 40:
        return False
    # Pure-number / pure-symbol strings aren't knowledge names (but equations inside a
    # larger phrase *with* alphabetical content are fine).
    if re.fullmatch(r"[\d\s.()（）+\-=/<>χΧΔδωΩαβγθλπρσφψωμε]+", value):
        return False
    if any(mark in value for mark in ("。", "，", ",", "；", ";", "！", "!", "？", "?")):
        return False
    if value.count("(") != value.count(")") or value.count("（") != value.count("）"):
        return False
    lowered = value.lower()
    if lowered in {
        "outline", "introduction", "question", "answer", "output", "input", "and", "for", "using",
        "available", "require", "sig", "frequency", "crystal", "因此", "例如", "如图", "上式", "右图",
        "条件", "注意", "其他", "实现", "课程要求", "公共邮箱", "简介", "结论",
        "the", "of", "and", "in", "to", "a", "is", "that", "for", "it", "as", "was", "with",
        "be", "by", "on", "are", "from", "or", "an", "this", "have", "has", "but", "not",
        "they", "which", "one", "you", "we", "can", "will", "there", "their", "what",
        "so", "if", "also", "than", "then", "its", "may", "such", "because", "been",
        "into", "about", "some", "them", "more", "these", "would", "other", "could",
        "figure", "fig", "table", "chapter", "section", "example", "note", "remark",
        "case", "way", "point", "part", "problem",
    }:
        return False
    if value.startswith((
        "对于", "如果", "由于", "因此", "假定", "这里", "可以看出", "由此可见", "答", "在", "将",
        "当", "若", "用", "通过", "从", "为了", "可见", "显然", "上式", "式中", "各个", "另一个",
        "任意", "产生的", "描述", "根据", "代入", "于是", "考察",
        "采用何种", "哪个", "什么", "试", "求", "画出",
    )):
        return False
    # English clause starters — the name shouldn't begin a whole sentence.
    if re.match(
        r"^(?:The|This|That|These|Those|It|They|We|You|A|An|In|For|On|At|By|With|From|To|When|Where|If|Because|So|Thus|Therefore|Hence|However|Also|And|But|Or)\b",
        value,
    ):
        return False
    if any(word in value for word in ("研究所", "学院", "大学")) or value.endswith("定义为"):
        return False
    if any(word in value for word in ("可以", "应该", "能够", "使得", "从而", "取决于", "这里", "其中")):
        return False
    if "@" in value or re.search(r"\b(?:tel|email|addr)\b", value, flags=re.IGNORECASE):
        return False
    # Relax the final "must contain Chinese or capital letters" rule — allow:
    #   * 2+ Chinese characters
    #   * 2+ capital letters (acronyms like SHG)
    #   * Latin names 3-24 chars with a vowel (actual words, not garbage)
    #   * Greek letter patterns
    has_chinese = bool(re.search(r"[\u4e00-\u9fff]{2}", value))
    has_acronym = bool(re.search(r"[A-Z]{2,}", value))
    stripped_alpha = re.sub(r"[^A-Za-z]", "", value)
    has_english_word = bool(
        3 <= len(stripped_alpha) <= 28
        and re.search(r"[aeiouAEIOU]", stripped_alpha)
    )
    has_greek = bool(re.search(r"[χΧΔδωΩαβγθλπρσφψωμε]+", value))
    has_formula_name = bool(
        re.search(r"[A-Za-z]+\s*(?:-\s*[A-Za-z]+)+", value)  # e.g. "Franck-Hertz", "Raman-Nath"
    )
    return has_chinese or has_acronym or has_english_word or has_greek or has_formula_name


def _contains_knowledge_signal(value: str) -> bool:
    signals = (
        # Chinese signals
        "定义", "定律", "方程", "条件", "原理", "机制", "效应", "过程", "方法", "特点", "性质",
        "类型", "分类", "关系", "定理", "模型", "近似", "匹配", "守恒", "折射", "极化", "吸收",
        "散射", "混频", "调制", "放大", "振荡", "应用", "理论", "系数", "张量", "相干", "阈值",
        "增益", "损耗", "转换效率", "折射率", "偏振", "耦合", "色散", "群速度", "克尔", "方向性",
        "要求", "目的", "作用", "用途", "边界", "适用", "单色性", "亮度", "非线性", "线性光学",
        "公式", "符号", "单位", "量纲", "实验", "现象", "规则", "步骤", "推导",
        # Standard English academic signal words
        "definition", "theorem", "law", "equation", "principle", "mechanism", "effect",
        "method", "process", "procedure", "property", "characteristic", "type", "category",
        "classification", "relation", "relationship", "model", "approximation", "condition",
        "threshold", "coefficient", "tensor", "gain", "loss", "refractive", "index",
        "dispersion", "polarization", "coupling", "nonlinear", "scattering", "absorption",
        "modulation", "amplification", "oscillation", "application", "theory",
        # Common physics/optics/engineering acronyms
        "Kerr", "SHG", "SFG", "DFG", "OPO", "QPM", "FWM", "THG", "TPA", "SRS", "CARS",
        "Franck", "Hertz", "Stern", "Gerlach", "Rydberg", "Planck", "Bohr", "Schrodinger",
        "Heisenberg", "Maxwell", "Newton", "Einstein", "Fermi", "Bose", "Lagrange",
    )
    lowered = (value or "").lower()
    return any(
        (signal in value) if not signal.isascii() or len(signal) <= 4 else (signal.lower() in lowered)
        for signal in signals
    )


def _description_from_lines(lines: list[str], start: int) -> str:
    parts: list[str] = []
    for raw_line in lines[start : start + 5]:
        clean = _clean_content_line(raw_line)
        if _is_content_noise(clean):
            continue
        parts.append(clean)
        combined = " ".join(parts)
        if len(combined) >= 80 or clean.endswith(("。", "；", ";", "！", "!", "？", "?")):
            break
    return " ".join(parts)[:220]


def _is_content_noise(line: str) -> bool:
    clean = re.sub(r"\s+", " ", str(line or "").strip())
    if not clean:
        return True
    if re.fullmatch(r"\[?PDF\s+page\s+\d+\]?", clean, flags=re.IGNORECASE):
        return True
    if re.fullmatch(r"(?:PDF OCR note|Only sampled pages|Only the first).+", clean, flags=re.IGNORECASE):
        return True
    if re.fullmatch(r"(?:第\s*)?\d+\s*(?:/\s*\d+)?\s*(?:页|page|p)", clean, flags=re.IGNORECASE):
        return True
    if re.fullmatch(r"[\d\s.()（）+\-=/<>χΧΔδωΩαβγᇱଶଵଶଷସೞ೛]+", clean):
        return True
    if "@" in clean or re.search(r"\b(?:addr|email|tel)\s*:", clean, flags=re.IGNORECASE):
        return True
    if clean.lower() in {"outline", "question:", "answer:", "input", "output"}:
        return True
    return False


def _heading_from_line(line: str) -> tuple[int, str] | None:
    clean = re.sub(r"\s+", " ", line.strip())
    if not clean:
        return None
    markdown = re.match(r"^(#{1,6})\s+(.+)$", clean)
    if markdown:
        name = _clean_heading_name(markdown.group(2))
        return (len(markdown.group(1)), name) if _looks_like_heading_name(name) else None

    chapter = re.match(r"^(第[0-9一二三四五六七八九十百]+[章节篇讲课单元]\s*[:：、.\-]?\s*.+)$", clean)
    if chapter:
        name = _clean_heading_name(chapter.group(1))
        return (1, name) if len(name) <= 32 and _looks_like_heading_name(name) else None

    numeric = re.match(r"^(\d+(?:\.\d+){0,3})([.、]|\s+)(.+)$", clean)
    if numeric:
        name = _clean_heading_name(numeric.group(3))
        level = numeric.group(1).count(".") + 1
        is_section_number = "." in numeric.group(1)
        return (level, name) if is_section_number and _looks_like_heading_name(name) else None

    chinese_ordered = re.match(r"^[一二三四五六七八九十]+[、.]\s*(.+)$", clean)
    if chinese_ordered:
        name = _clean_heading_name(chinese_ordered.group(1))
        return (1, name) if _looks_like_heading_name(name) else None

    bracketed = re.match(r"^[（(][一二三四五六七八九十0-9]+[)）]\s*(.+)$", clean)
    if bracketed:
        name = _clean_heading_name(bracketed.group(1))
        return (3, name) if _looks_like_heading_name(name) else None

    return None


def _clean_heading_name(value: str) -> str:
    clean = value.strip(" \t:：;；,.，。、-")
    return re.sub(r"^\d+(?:\.\d+){0,3}[.、\s]+", "", clean).strip()


def _looks_like_heading_name(value: str) -> bool:
    if not 2 <= len(value) <= 32:
        return False
    if _is_low_value_card_topic(value):
        return False
    if any(mark in value for mark in ("。", "，", ",", "；", ";", "！", "!", "？", "?")):
        return False
    if value in {"其他", "简介", "注意"} or re.fullmatch(r"\d+", value):
        return False
    if value.startswith((
        "对于", "如果", "由于", "因此", "假定", "这里", "根据", "由此", "在", "将", "当", "若",
        "通过", "从", "为了", "上式", "式中", "代入", "于是",
    )):
        return False
    return True


def _source_root_name(source: Source) -> str:
    stem = source.filename.rsplit(".", 1)[0].strip()
    return stem[:48] or "Source material"


def _candidate_topics(text: str) -> list[str]:
    topics: list[str] = []
    for line in text.splitlines():
        name, _ = _knowledge_name_from_line(line)
        if name:
            topics.append(name)
    seen: set[str] = set()
    unique: list[str] = []
    for topic in topics:
        if topic not in seen:
            unique.append(topic)
            seen.add(topic)
    return unique


def _first_sentence_around(text: str, needle: str) -> str:
    sentences = re.split(r"(?<=[。！？.!?])\s*", text.replace("\n", " "))
    for sentence in sentences:
        if needle in sentence:
            return sentence[:180]
    return sentences[0][:180] if sentences else ""


def _dedupe_nodes(nodes: list[FrameworkNode]) -> list[FrameworkNode]:
    by_id: dict[str, FrameworkNode] = {}
    for node in nodes:
        if node.node_id in by_id:
            existing = by_id[node.node_id]
            source_ids = sorted(set(existing.source_ids + node.source_ids))
            description = existing.description if len(existing.description) >= len(node.description) else node.description
            by_id[node.node_id] = existing.model_copy(
                update={"source_ids": source_ids, "description": description}
            )
        else:
            by_id[node.node_id] = node
    return list(by_id.values())


def count_fingerprint_repeats(
    database: Database,
    project_id: str,
    fingerprint: str | None,
    *,
    now: _dt.datetime | None = None,
) -> int:
    """该题面指纹在近 REPEAT_WINDOW_DAYS 天内已被作答过几次。

    为什么放在 framework 而不是 api_server：这是**增益公式的输入**，
    公式在 framework 里，那它就该在 framework 里取 —— 否则「谁负责数」
    就散落到 N 个调用点上，漏一个就静默失效（表现为刷分变容易，最难发现）。
    只数近窗口：隔几天以上重做同一道题是间隔效应想要的行为，不该吃重罚。
    """
    key = str(fingerprint or "").strip()
    if not key:
        return 0
    cutoff = (now or _dt.datetime.now(_dt.timezone.utc)) - _dt.timedelta(
        days=transfer_module.REPEAT_WINDOW_DAYS
    )
    # 走 idx_learning_events_fingerprint(project_id, item_fingerprint, created_at)，
    # 不拉全项目事件：record_evidence 在测验提交里是**逐节点**调用的，
    # 每节点一次全表扫会在大项目上明显变慢。
    row = database._conn.execute(
        "SELECT COUNT(*) AS n FROM learning_events"
        " WHERE project_id = ? AND item_fingerprint = ? AND created_at >= ?",
        (project_id, key, cutoff.isoformat()),
    ).fetchone()
    return int(row["n"] or 0) if row else 0


def record_evidence(
    database: Database,
    project_id: str,
    node_ids: list[str],
    kind: str,
    correctness: float | None,
    confidence: float,
    reference_id: str | None = None,
    self_confidence: float | None = None,
    difficulty: int | None = None,
    item_fingerprint: str | None = None,
    repeat_count: int | None = None,
    target: str = "mastery",
    transfer_distance: str | None = None,
) -> list[FrameworkNode]:
    """记录学习行为并更新节点掌握度（或迁移分）。

    - kind: question / solve / card / quiz / discuss（见 MASTERY_EVIDENCE_WEIGHTS）
    - correctness: 0.0~1.0，为 None 时用该类行为的默认正确度
    - confidence: 0.0~1.0，节点映射置信度；< MASTERY_CONFIDENCE_FLOOR 进入待确认且无增量
    - reference_id: 可选，关联触发本次行为的卡片 / 测验 / 消息 id，供前端审计 trail 点击跳转。
    - self_confidence: 可选，**学习者自己**勾的把握度（1.0 我确定 / 0.0 我不确定 / None 没勾）。
      它只落库、**不参与掌握度增益**（增益用的仍是 confidence，见下方公式）；
      消费方是 progress_engine 的「过度自信」判据 —— 答错 + 自评确定 = 最该先修的误解。
    - difficulty: 本次行为的难度档 1/2/3。None 走 transfer.DEFAULT_DIFFICULTY(=2) 兜底。
    - item_fingerprint: 题干指纹，落库。**落库是必须的**：下钻面板的「可解释」承诺
      靠事件流回放实现，不落指纹，回放就算不出「第几遍」，分数明细会对不上真值。
    - repeat_count: 近窗口内同一题已做过几次。**留空（None）就自己数** ——
      只有在重复次数另有权威来源时才显式传入（比如迁移题的次数在
      concept_graph.transfer_attempts 里）。让每个调用点自己数一次是错的做法：
      六个调用点里漏掉一个，那个路径的边际递减就静默失效了，而失效表现为
      「刷分变容易了」，很难被发现。
    - target: "mastery" 写 mastery_score；"transfer" 写 transfer_score（不碰前者）。

    增量公式（全部可审计）：
        gain_basis = correctness ?? MASTERY_DEFAULT_CORRECTNESS[kind]
        raw_gain   = MASTERY_EVIDENCE_WEIGHTS[kind] * clamp(gain_basis) * confidence
        gain       = min(raw_gain, MASTERY_SINGLE_GAIN_CAP[kind])
        gain      *= difficulty_factor(difficulty) * freshness_factor(repeat_count)

    最后一步的难度与新鲜度系数来自 core/transfer.py。**cap 先截断再乘系数**：
    截断的语义是「一次行为的绝对上限」，系数是「这次行为值多少」，两者相乘才是
    「这次行为实际值多少」。反过来先乘后截断的话，D3 的 1.6 系数会被 cap 吃掉，
    难度加权等于没加 —— 这正是原先 D1/D3 同分的那个洞的另一种写法。
    """
    if target not in ("mastery", "transfer"):
        # 宁可按记忆分走也不要静默丢掉证据：丢证据比记错地方更难查。
        target = "mastery"
    is_transfer = target == "transfer"
    fingerprint = str(item_fingerprint or "").strip()[:64] or None
    if repeat_count is None:
        repeat_count = count_fingerprint_repeats(
            database, project_id, fingerprint
        ) if fingerprint else 0
    try:
        repeats = max(0, int(repeat_count))
    except (TypeError, ValueError):
        repeats = 0
    weight = MASTERY_EVIDENCE_WEIGHTS.get(kind, 0.05)
    default_correctness = MASTERY_DEFAULT_CORRECTNESS.get(kind, 0.35)
    cap = MASTERY_SINGLE_GAIN_CAP.get(kind, 0.05)
    confidence = max(0.0, min(1.0, confidence))
    if self_confidence is not None:
        self_confidence = max(0.0, min(1.0, float(self_confidence)))
    updated: list[FrameworkNode] = []
    for node_id in node_ids:
        node = database.get_framework_node(project_id, node_id)
        database.record_learning_event(
            project_id,
            node_id,
            kind,
            correctness,
            confidence,
            reference_id,
            self_confidence,
            difficulty,
            fingerprint,
        )
        floor = TRANSFER_CONFIDENCE_FLOOR if is_transfer else MASTERY_CONFIDENCE_FLOOR
        if confidence < floor:
            updated.append(
                database.update_node_state(
                    project_id, node_id, learning_status="pending_confirmation"
                )
            )
            continue
        if is_transfer:
            # 迁移分走自己的公式（core/transfer.py）：含距离系数与更高的单次上限，
            # 因此这里**不**走上面那套 weight/cap。correctness 为 None 时不加 ——
            # 「没判分」不能当「答对了」。
            gain = transfer_module.transfer_gain(
                correctness=correctness,
                confidence=confidence,
                distance=transfer_module.normalize_distance(transfer_distance),
                repeat_count=repeats,
            )
            new_score = max(0.0, min(1.0, node.transfer_score + gain))
            updated.append(
                database.update_node_state(
                    project_id, node_id, transfer_score=new_score
                )
            )
            continue
        gain_basis = correctness if correctness is not None else default_correctness
        gain_basis = max(0.0, min(1.0, gain_basis))
        raw_gain = weight * gain_basis * confidence
        gain = min(raw_gain, cap)
        gain *= transfer_module.difficulty_factor(difficulty)
        gain *= transfer_module.freshness_factor(repeat_count)
        new_score = min(1.0, node.mastery_score + gain)
        if new_score >= MASTERY_THRESHOLD_MASTERED:
            status = "mastered"
        elif new_score >= MASTERY_THRESHOLD_LEARNING:
            # 学习中门槛：任何来源达到阈值均可进入（原只允许 quiz，导致透明感差）
            status = "learning"
        else:
            status = "encountered"
        updated.append(
            database.update_node_state(
                project_id, node_id, learning_status=status, mastery_score=new_score
            )
        )
    return updated


def mastery_evidence_rules() -> dict[str, Any]:
    """给 API/前端返回「掌握度如何变化」的权威配置，让 UI 与算法保持一致。"""
    return {
        "weights": dict(MASTERY_EVIDENCE_WEIGHTS),
        "default_correctness": dict(MASTERY_DEFAULT_CORRECTNESS),
        "single_gain_cap": dict(MASTERY_SINGLE_GAIN_CAP),
        "thresholds": {
            "learning": MASTERY_THRESHOLD_LEARNING,
            "mastered": MASTERY_THRESHOLD_MASTERED,
            "pending_confidence": MASTERY_CONFIDENCE_FLOOR,
        },
        # 公式字符串是给界面看的「权威口径」，必须与 record_evidence 里的实现逐项对得上。
        # 多出两个系数是因为它们真的进了公式 —— 以前这里写的是三因子式，
        # 而实现里也确实只有三因子；现在实现有五个因子，这里就必须写五个。
        # 少写一个，界面就会对用户说谎（说「难度不影响掌握度」而实际影响）。
        "formula": (
            "gain = min(weight * correctness * confidence, single_cap)"
            " * difficulty_factor * freshness_factor"
        ),
        "difficulty_factors": dict(transfer_module.DIFFICULTY_FACTORS),
        "default_difficulty": transfer_module.DEFAULT_DIFFICULTY,
        "freshness": {
            "repeat_decay": transfer_module.REPEAT_DECAY,
            "window_days": transfer_module.REPEAT_WINDOW_DAYS,
            "floor": transfer_module.REPEAT_FLOOR,
        },
        "decay": {
            "exponent": transfer_module.DECAY_EXPONENT,
            "factor": transfer_module.DECAY_FACTOR,
            "default_stability_days": transfer_module.DEFAULT_STABILITY_DAYS,
            "floor": transfer_module.DECAY_FLOOR,
            "note": "衰减只在读取/展示时生效，不改库里的累加值 —— 老数据零迁移。",
        },
        "transfer": {
            "single_gain_cap": transfer_module.TRANSFER_SINGLE_GAIN_CAP,
            "thresholds": {
                "partial": transfer_module.TRANSFER_THRESHOLD_PARTIAL,
                "solid": transfer_module.TRANSFER_THRESHOLD_SOLID,
            },
            "distance_labels": dict(transfer_module.TRANSFER_DISTANCE_LABELS),
            "distance_gain_factors": dict(transfer_module.DISTANCE_GAIN_FACTORS),
        },
        "kind_labels": dict(MASTERY_KIND_LABELS),
    }


def _parse_iso(s: str) -> _dt.datetime:
    """宽松解析 ISO 时间，兼容末尾 Z、无 T、带/不带微秒等格式，失败返回 epoch。"""
    try:
        if not s:
            return _dt.datetime(1970, 1, 1)
        t = s.strip()
        if t.endswith("Z"):
            t = t[:-1] + "+00:00"
        # 兼容空格分隔
        if "T" not in t and len(t) >= 10 and t[4:5] == "-":
            t = t[:10] + "T" + t[11:] if len(t) > 10 else t + "T00:00:00"
        return _dt.datetime.fromisoformat(t)
    except Exception:
        try:
            return _dt.datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S")
        except Exception:
            return _dt.datetime(1970, 1, 1)


def compute_mastery_breakdown(
    database: Database,
    project_id: str,
    node_ids: list[str] | None = None,
    *,
    include_trail_by_kind: bool = True,
    trail_per_kind_limit: int = 200,
) -> dict[str, dict[str, Any]]:
    """
    按学习事件回放（replay）每个节点的掌握度，产出掌握度来源明细。
    返回：{ node_id: { total_score, contributions, correctness, event_count, recent_events, trail_by_kind } }

    - correctness: 只统计"有显式正确度"的来源（UI 上用户只认「测验正确率」，
      所以只留 quiz 一项；其它来源的显式数据仍保留在 trail 里方便弹框展示）。
    - trail_by_kind[kind]: 该节点该类下最近 N 条审计 trail（时间倒序），供前端点击弹框。
    - 为了支持"历史 trail 也能跳转回卡片/测验"，对缺少 reference_id 的老事件做一次
      反向匹配：card → 找同一节点、创建时间最接近、包含该 node_id 的那张卡片；
      quiz → 找 quizzes 表中 submitted_at 最接近的题目序号。
    """
    all_nodes = {n.node_id: n for n in database.list_framework_nodes(project_id)}
    target_ids = list(node_ids) if node_ids else list(all_nodes.keys())
    events_by_node: dict[str, list[dict[str, Any]]] = {nid: [] for nid in target_ids}
    try:
        raw_events = database.list_learning_events(project_id)  # type: ignore[attr-defined]
    except AttributeError:
        raw_events = _fetch_events_manually(database, project_id)
    # ------------------ 历史反向匹配：老 event 没 reference_id 时补上 ------------------
    _ref_cache: dict = {}

    def _cache_cards():
        if "cards" in _ref_cache: return _ref_cache["cards"]
        rows = []
        try:
            raw = database._conn.execute(
                "SELECT card_id, payload, created_at FROM cards WHERE project_id = ?",
                (project_id,),
            ).fetchall()
        except Exception:
            _ref_cache["cards"] = []
            return _ref_cache["cards"]
        for r in raw:
            try:
                payload = _json.loads(r["payload"])
            except Exception:
                continue
            rows.append({
                "card_id": r["card_id"],
                "node_ids": list(payload.get("node_ids") or []),
                "created_at": r["created_at"],
            })
        _ref_cache["cards"] = sorted(rows, key=lambda x: x["created_at"] or "")
        return _ref_cache["cards"]

    def _cache_quizzes():
        if "quizzes" in _ref_cache: return _ref_cache["quizzes"]
        try:
            raw = database.list_recent_quizzes(project_id, limit=500)
        except Exception:
            _ref_cache["quizzes"] = []
            return _ref_cache["quizzes"]
        rows = []
        for q in raw:
            rows.append({
                "quiz_id": q.get("quiz_id"),
                "node_ids": list({nid for qi in (q.get("questions") or []) for nid in (qi.get("node_ids") or [])}),
                "created_at": q.get("created_at"),
                "submitted_at": q.get("submitted_at"),
            })
        _ref_cache["quizzes"] = sorted(rows, key=lambda x: x["submitted_at"] or x["created_at"] or "")
        return _ref_cache["quizzes"]

    def _match_ref(kind, ev):
        if ev.get("reference_id"):
            return ev["reference_id"]
        if kind == "card":
            nid = ev["node_id"]
            t_ev = ev["created_at"] or ""
            best = None
            best_delta = None
            for c in _cache_cards():
                if c["node_ids"] and nid not in c["node_ids"]: continue
                # created_at 与 event 越近越好；若创建前已存在 card，优先选之前最近的
                t_c = c["created_at"] or ""
                if not t_c or not t_ev: continue
                delta = abs((_parse_iso(t_ev) - _parse_iso(t_c)).total_seconds())
                if best_delta is None or delta < best_delta:
                    best_delta = delta
                    best = c
            if best and (best_delta is None or best_delta <= 7 * 86400):  # 7 天内近似
                return best["card_id"]
        elif kind == "quiz":
            nid = ev["node_id"]
            t_ev = ev["created_at"] or ""
            best = None
            best_delta = None
            for q in _cache_quizzes():
                if not q["quiz_id"]: continue
                if q["node_ids"] and nid not in q["node_ids"]: continue
                t_q = q["submitted_at"] or q["created_at"] or ""
                if not t_q or not t_ev: continue
                delta = abs((_parse_iso(t_ev) - _parse_iso(t_q)).total_seconds())
                if best_delta is None or delta < best_delta:
                    best_delta = delta
                    best = q
            if best and (best_delta is None or best_delta <= 7 * 86400):
                # 精取 question index: questions 里包含 nid 的第 1 个（实在无法精确时 0）
                idx = 0
                all_quizzes = _ref_cache.get("quizzes_full")
                if all_quizzes is None:
                    try:
                        all_quizzes = database.list_recent_quizzes(project_id, limit=500)
                    except Exception:
                        all_quizzes = []
                    _ref_cache["quizzes_full"] = all_quizzes
                for q in all_quizzes:
                    if q.get("quiz_id") == best["quiz_id"]:
                        for i, qi in enumerate(q.get("questions") or []):
                            if ev["node_id"] in (qi.get("node_ids") or []):
                                idx = i
                                break
                        break
                return f'{best["quiz_id"]}:{idx}'
        return None

    # 把 reference_id 注入到 event 副本（不改原数据）
    for e in raw_events:
        if not e.get("reference_id") and e["kind"] in ("card", "quiz"):
            e = dict(e)
            e["reference_id"] = _match_ref(e["kind"], e) or None
        nid = e["node_id"]
        if nid in events_by_node:
            events_by_node[nid].append(e)

    result: dict[str, dict[str, Any]] = {}
    for nid in target_ids:
        node = all_nodes.get(nid)
        if node is None:
            continue
        events = sorted(events_by_node[nid], key=lambda x: (x["created_at"], x["event_id"]))
        contributions: dict[str, float] = {k: 0.0 for k in MASTERY_EVIDENCE_WEIGHTS}
        # correctness_stats 仍先按全种类统计（回放里要复用），但输出时只保留 quiz。
        correctness_stats: dict[str, dict[str, float]] = {}
        replay_score = 0.0
        event_trail: list[dict[str, Any]] = []
        trail_by_kind_collect: dict[str, list[dict[str, Any]]] = {k: [] for k in MASTERY_EVIDENCE_WEIGHTS}
        # 回放必须与 record_evidence **逐项同算式**，否则「可下钻查看每个分数的构成」
        # 就是假的：界面上加总出来对不上库里的真值，用户会以为系统有 bug。
        # （真的曾经对不上：后来加系数时忘了同步回放，审计面板一度把分算错。）
        # 边际递减的输入是「近窗口内同指纹已做几次」，所以回放时按指纹计数。
        fingerprint_seen: dict[str, int] = {}
        for ev in events:
            kind = ev["kind"]
            conf = max(0.0, min(1.0, float(ev["confidence"] or 0.0)))
            raw_corr = ev["correctness"]
            corr_value: float | None = float(raw_corr) if raw_corr is not None else None
            if corr_value is not None:
                cs = correctness_stats.setdefault(kind, {"count": 0, "sum": 0.0})
                cs["count"] += 1
                cs["sum"] += corr_value
            if conf < MASTERY_CONFIDENCE_FLOOR:
                trail = _trail_entry(ev, "pending_confirmation", 0.0)
                event_trail.append(trail)
                if include_trail_by_kind and kind in trail_by_kind_collect:
                    trail_by_kind_collect[kind].append(trail)
                continue
            gain_basis = corr_value if corr_value is not None else MASTERY_DEFAULT_CORRECTNESS.get(kind, 0.35)
            gain_basis = max(0.0, min(1.0, gain_basis))
            raw_gain = MASTERY_EVIDENCE_WEIGHTS.get(kind, 0.05) * gain_basis * conf
            gain = min(raw_gain, MASTERY_SINGLE_GAIN_CAP.get(kind, 0.05))
            gain *= transfer_module.difficulty_factor(ev.get("difficulty"))
            fingerprint = str(ev.get("item_fingerprint") or "")
            if fingerprint:
                repeats = fingerprint_seen.get(fingerprint, 0)
                gain *= transfer_module.freshness_factor(repeats)
                fingerprint_seen[fingerprint] = repeats + 1
            before = replay_score
            replay_score = min(1.0, replay_score + gain)
            actual_gain = replay_score - before
            contributions[kind] = contributions.get(kind, 0.0) + actual_gain
            trail = _trail_entry(ev, "applied", actual_gain, gain_basis, conf)
            event_trail.append(trail)
            if include_trail_by_kind and kind in trail_by_kind_collect:
                trail_by_kind_collect[kind].append(trail)
        baseline_delta = max(0.0, node.mastery_score - replay_score)
        if baseline_delta > 1e-9:
            contributions["baseline"] = contributions.get("baseline", 0.0) + baseline_delta
        total = round(node.mastery_score, 6)
        # 只保留 quiz 的正确率（用户需求："只需要测验的正确度就可以了"）。
        _quiz_stat = correctness_stats.get("quiz")
        if _quiz_stat and int(_quiz_stat["count"]) > 0:
            quiz_count = int(_quiz_stat["count"])
            correctness_summary = {
                "quiz": {
                    "count": quiz_count,
                    "avg_correctness": round(_quiz_stat["sum"] / quiz_count, 4),
                }
            }
        else:
            correctness_summary = {}
        contributions_round = {k: round(v, 6) for k, v in contributions.items()}
        # 衰减口径：距**最近一次证据**多久。没有任何事件就没有衰减可言（raw=0 也不需要），
        # 所以只在 events 非空时算。
        decay_view = (
            transfer_module.effective_mastery(
                node.mastery_score,
                elapsed_days=_days_since(events[-1].get("created_at")),
            )
            if events
            else transfer_module.effective_mastery(
                node.mastery_score, elapsed_days=0.0
            )
        )
        decay_view["decay_note"] = transfer_module.describe_decay(decay_view)
        trail_by_kind_out: dict[str, list[dict[str, Any]]] = {}
        if include_trail_by_kind:
            for k, lst in trail_by_kind_collect.items():
                reversed_lst = list(reversed(lst))
                if trail_per_kind_limit and len(reversed_lst) > trail_per_kind_limit:
                    reversed_lst = reversed_lst[:trail_per_kind_limit]
                trail_by_kind_out[k] = reversed_lst
        result[nid] = {
            "node_id": nid,
            "node_name": node.name,
            "total_score": total,
            "total_percent": round(total * 100, 2),
            # 「你累计学过多少」与「你现在还记得多少」是两个数，必须都摆出来。
            # 只给 effective 会让人以为学过的东西被系统删了；只给 raw 又在鼓励
            # 「学完就当会了」—— 两者都不是事实。
            **decay_view,
            "transfer_score": round(node.transfer_score, 6),
            "transfer_stage": transfer_module.transfer_stage(node.transfer_score),
            "transfer_stage_label": transfer_module.TRANSFER_STAGE_LABELS[
                transfer_module.transfer_stage(node.transfer_score)
            ],
            "contributions": contributions_round,
            "correctness": correctness_summary,
            "event_count": len(events),
            "recent_events": event_trail[-20:],
            "trail_by_kind": trail_by_kind_out,
        }
    return result


def _trail_entry(
    ev: dict[str, Any],
    outcome: str,
    gain: float,
    gain_basis: float | None = None,
    confidence: float | None = None,
) -> dict[str, Any]:
    return {
        "event_id": ev["event_id"],
        "kind": ev["kind"],
        "created_at": ev["created_at"],
        "correctness": ev["correctness"],
        "confidence": confidence if confidence is not None else ev["confidence"],
        "gain_basis": gain_basis,
        "gain": round(gain, 6),
        "outcome": outcome,
        "reference_id": ev.get("reference_id"),
        # 难度与指纹回显：让「这道 D1 值多少分、这是第几遍」在审计面板里可核。
        "difficulty": ev.get("difficulty"),
        "difficulty_factor": (
            transfer_module.difficulty_factor(ev.get("difficulty"))
            if ev.get("difficulty") is not None
            else None
        ),
        "item_fingerprint": ev.get("item_fingerprint"),
    }


def _days_since(stamp: Any, *, now: _dt.datetime | None = None) -> float:
    """距某个时间戳过了几天。

    坏数据一律 0.0（= 不衰减）。绝不因为解析失败就得出「已经过了 900 天」——
    那会把用户的掌握度显示成塌掉的样子，而原因只是时间戳格式没认出来。
    两侧统一成 aware UTC 再相减：库里既有带时区也有不带时区的 ISO 串。
    """
    parsed = _parse_iso(str(stamp or ""))
    if parsed.year == 1970:
        return 0.0
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_dt.timezone.utc)
    reference = now or _dt.datetime.now(_dt.timezone.utc)
    if reference.tzinfo is None:
        reference = reference.replace(tzinfo=_dt.timezone.utc)
    return max(0.0, (reference - parsed).total_seconds() / 86400.0)


def _fetch_events_manually(database: Database, project_id: str) -> list[dict[str, Any]]:
    """list_learning_events 缺失时的兜底：直接打 sqlite 查询。"""
    rows = database._conn.execute(  # type: ignore[attr-defined]
        "SELECT event_id, node_id, kind, correctness, confidence, reference_id, created_at "
        "FROM learning_events WHERE project_id = ?",
        (project_id,),
    ).fetchall()
    return [
        {
            "event_id": r["event_id"],
            "node_id": r["node_id"],
            "kind": r["kind"],
            "correctness": (None if r["correctness"] is None else float(r["correctness"])),
            "confidence": float(r["confidence"]),
            "reference_id": r["reference_id"],
            "created_at": r["created_at"],
        }
        for r in rows
    ]


def generate_fallback_cards(
    nodes: list[FrameworkNode],
    sources: list[Source],
    target_difficulty: int = 1,
    existing_cards: list[Card] | None = None,
    batch_size: int = 8,
) -> list[Card]:
    """已按用户策略禁用 fallback 知识卡片模板（「低质 fallback 不如不要」）。

    旧的本地模板会在完全没有框架节点/来源证据语义绑定的情况下，按通用句式硬拼一批
    「公式/定义/对比/方法/条件应用」壳卡，经常出现跨学科错位（半导体物理材料生成工
    程光学的球差/彗差像差题），或背面仅为符号公式、零领域词的低质内容。
    统一直接抛错，由上层 api_server 的 502 处理返回"模型连续失败，暂无内容，请稍后重试"。
    """
    raise NotImplementedError(
        "fallback 知识卡片模板已禁用：请确保 LLM API 可用。若模型连续两次输出仍不合格，"
        "系统将返回显式错误（HTTP 502），**绝不**用跨学科错位 / 公式壳卡的本地模板兜底。"
    )


def generate_fallback_quiz(
    nodes: list[FrameworkNode],
    source_ids: list[str] | None = None,
    sources: list[Source] | None = None,
    target_difficulty: int = 1,
    existing_questions: list[str] | None = None,
    batch_size: int = 6,
    question_types: list[str] | None = None,
) -> list[QuizQuestion]:
    """已按用户策略禁用 fallback 小测验模板（「低质 fallback 不如不要」）。

    旧的本地模板会用通用句式 + 证据池随意拼 choice/open 题，极易出现「题面问半导体物
    理、干扰项/选项却是工程光学或量子力学名词」的跨学科错位，或正确答案与问题零实质
    词重合的壳题。统一直接抛错，由上层以 HTTP 502 显式返回，绝不渲染垃圾内容。
    """
    raise NotImplementedError(
        "fallback 小测验模板已禁用：请确保 LLM API 可用。若模型连续两次输出仍不合格，"
        "系统将返回显式错误（HTTP 502），**绝不**用跨学科错位 / 空壳题的本地模板兜底。"
    )


def _clean_evidence_text(value: str) -> str:
    clean = re.sub(r"\\[nrt]", " ", str(value or ""))
    clean = re.sub(r"\s+", " ", clean.strip())
    clean = re.sub(r"\[PDF page \d+\]", "", clean, flags=re.IGNORECASE)
    clean = re.sub(r"\bPDF pages? \d+(?:[-–]\d+)?\b", "", clean, flags=re.IGNORECASE)
    clean = re.sub(r"(?:第\s*)?\d+\s*/\s*\d+\s*页", "", clean, flags=re.IGNORECASE)
    # Strip Unicode replacement / box-drawing / control glyphs that leak from
    # bad PDF OCR, corrupted formula renderings, or PPT slide exports.
    # These are the "□ ☐ ■ ☑ ⌷ ⍰ ▯ ▮ ▰ ▱ � ☒" garbage seen in screenshots.
    # NOTE: ☐/☑/☒ are U+2610/U+2611/U+2612 (Misc Symbols), NOT in the Geometric
    # Shapes block (U+25A0–U+25FF), so they must be added explicitly.
    clean = re.sub(
        r"[\u25a0-\u25ff\u2300-\u23ff\u2400-\u243f\u2b00-\u2bff\u2610-\u2614\ufffd\u00a0\u00ad\u061c\u2000-\u200f\u2028-\u202f\ufeff\ufff9-\ufffc]+",
        " ",
        clean,
    )
    # Collapse repeated punctuation / stray punctuation that the strip above may leave.
    clean = re.sub(r"[ ]{2,}", " ", clean)
    clean = re.sub(r"(?:[-—–·•●▪■◆◇□□■☐⍰▯▮▰▱]{2,})", " ", clean)
    return clean.strip(" ：:;；,.，。、-")


def _is_low_value_card_topic(value: str) -> bool:
    clean = re.sub(r"\s+", " ", str(value or "").strip(" ：:;；,.，。、-\"'“”《》()（）[]【】"))
    if not clean:
        return True
    lowered = clean.lower()
    if lowered in LOW_VALUE_CARD_TOPICS:
        return True
    if re.fullmatch(r"(?:pdf\s*)?pages?\s*\d+(?:\s*[-/]\s*\d+)?", lowered):
        return True
    if re.fullmatch(r"(?:第\s*)?\d+\s*(?:/\s*\d+)?\s*(?:页|page|p)?", clean, flags=re.IGNORECASE):
        return bool(re.search(r"页|page|/|p", clean, flags=re.IGNORECASE))
    return False


def _clean_card_topic(value: str) -> str:
    clean = _clean_evidence_text(value)
    clean = re.sub(r"^(?:关于|围绕|根据|来源中|材料中)\s*", "", clean)
    clean = re.sub(r"(?:是指|定义为|主要是|主要包括|包括|有|如下|为)$", "", clean)
    clean = re.sub(r"(?:的)?主要$", "", clean)
    clean = clean.strip(" ：:;；,.，。、-\"'“”《》()（）[]【】")
    return clean[:36]


def _evidence_subject(text: str) -> str:
    """The subject the sentence itself names, or "" when it does not name one."""

    clean = _clean_evidence_text(text)
    name, _ = _knowledge_name_from_line(clean)
    if name and not _is_low_value_card_topic(name):
        return _clean_card_topic(name)
    paired_terms = _paired_terms_from_evidence(clean)
    if paired_terms:
        return paired_terms

    subject = r"([\u4e00-\u9fffA-Za-z0-9χΧΔδωΩαβγθλπρσφψωμε()（）·\-— /]{2,40}?)"
    patterns = [
        rf"^{subject}(?:的)?(?:主要)?(?:区别|差异)(?:是|在于|为|：|:)",
        rf"^{subject}(?:的)?(?:一般)?(?:要求|条件|特点|特性|性质|优点|缺点|局限|分类|类型|组成)(?:有|包括|是|为|：|:)",
        rf"^{subject}(?:的)?(?:主要目的|目的|作用|用途)(?:是|在于|为|：|:)",
        rf"^{subject}(?:是指|定义为|是一种|是一类|指的是|是)",
        rf"^{subject}(?:基于|利用|通过|采用)",
        rf"^{subject}(?:用于|用来|适用于|可用于|能够|可以)",
    ]
    for pattern in patterns:
        match = re.search(pattern, clean)
        if match:
            candidate = _clean_card_topic(match.group(1))
            if candidate and not _is_low_value_card_topic(candidate):
                return candidate

    # English subject-predicate patterns for both sentences and phrase fragments.
    en_subject = r"([A-Z][A-Za-z0-9\- ]{2,34})"
    en_patterns = [
        # ---- Capture full named entity INCLUDING its type word (formula/law/…). ----
        # This must run first; otherwise the pattern below captures only the
        # adjective / hyphenated proper-noun head and drops "formula", leaving
        # subjects like "The Rydberg" instead of the correct "Rydberg formula".
        # Examples:  "The Rydberg formula predicts..." → "The Rydberg formula"
        #            "Rydberg formula predicts..."    → "Rydberg formula"
        #            "Maxwell equations govern..."    → "Maxwell equations"
        r"^((?:The|A|An\s+)?(?:[A-Z][A-Za-z0-9\-]+\s+){0,3}(?:equation|formula|equations|formulas|law|laws|theorem|theorems|principle|principles|experiment|experiments|effect|effects|method|methods|procedure|condition|property|coefficient|relation|constant|function|series|spectroscopy))\b",
        rf"^{en_subject}\s+(?:is|are|was|were|can be|may be|should be|must be)\b(?!\s+(?:a|an|the)\b\s*[a-z])",
        rf"^{en_subject}\s+(?:refers to|denotes|describes|represents|defines|includes|contains|consists of|relies on|depends on|measures|determines|governs|characterizes|predicts|relates|shows|demonstrates|expresses|calculates|computes)\b",
        rf"^{en_subject}\s+(?:equation|formula|law|theorem|principle|experiment|effect|method|procedure|condition|property)\b",
        rf"\bFor\s+{en_subject}[,，:：]",
        rf"^{en_subject}[:,：]\s",
        # Hyphenated proper nouns: "Franck-Hertz experiment showed that ..."
        r"^([A-Z][a-zA-Z]+(?:\s*-\s*[A-Z][a-zA-Z]+)*\s+(?:experiment|effect|principle|equation|theorem|law|method|relation|coefficient|function|series|spectroscopy))\b",
    ]
    for pattern in en_patterns:
        match = re.search(pattern, clean)
        if match:
            candidate = _clean_card_topic(match.group(1))
            if candidate and not _is_low_value_card_topic(candidate):
                return candidate

    # Formula-backed fallback: when the sentence clearly revolves around a
    # formula/symbol, use its narrative topic (first proper noun phrase before the
    # equation marker). Avoids returning "" for formula-dense paragraphs.
    if _has_formula_signal(clean):
        # Grab capitalized word / proper-noun run that appears before any = sign
        pre_eq = clean.split("=", 1)[0] if "=" in clean else clean
        pre_eq = re.split(r"[，,。；;]", pre_eq)[0]
        # Try Chinese noun first
        cn_match = re.search(r"([\u4e00-\u9fff]{2,14}(?:公式|方程|定律|条件|原理|系数|函数|关系|参数|量|效应|常数|截面|速率|能级|跃迁))", pre_eq)
        if cn_match:
            candidate = _clean_card_topic(cn_match.group(1))
            if candidate and not _is_low_value_card_topic(candidate):
                return candidate
        # Then English noun head: "the X equation" / "the Y coefficient"
        en_match = re.search(
            r"((?:[A-Z][A-Za-z0-9\-]*\s+){0,3}(?:equation|formula|law|theorem|principle|experiment|effect|method|coefficient|relation|parameter|constant|function|series))",
            pre_eq,
            flags=re.IGNORECASE,
        )
        if en_match:
            candidate = _clean_card_topic(en_match.group(1))
            if candidate and not _is_low_value_card_topic(candidate):
                return candidate

    return ""
