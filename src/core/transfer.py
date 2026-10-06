# -*- coding: utf-8 -*-
"""迁移（泛化）能力的纯计算层：难度加权 · 边际递减 · 遗忘衰减 · 渐进式对齐出题。

本模块**不碰数据库、不调模型**。落库在 ``core/concept_graph.py``，出题在 ``api_server.py``。
拆开是为了让这一层的每一个数都能被单独验证 —— 下面每个常数都写清来历，
免得半年后有人看到 ``1.6`` 随手改成 ``1.2``。

────────────────────────────────────────────────────────────────────
为什么需要这个模块：原计分公式有四个洞

1. **难度不进掌握度。**
   原式 ``gain = min(weight * correctness * confidence, cap)`` 里没有 difficulty，
   于是答对一道 D3「综合设计情境题」与答对一道 D1「XX 的定义是什么」得分**完全相同**。
   这不只是不公平 —— 它让「花最多钱生成最难的题」在计分上没有任何回报，
   于是系统与用户都会自然退回刷最便宜的识记题。难度是**题目属性**，
   要在计分侧接住，治本；只在出题侧加约束是治标。

2. **同一道题做第 3 遍等价于第 1 遍。**
   没有边际递减时，「反复刷同一套题」就是最优刷分策略，而且完全合法。
   加一个 ``1 / (1 + DECAY * 已做次数)`` 即可，复用 FSRS 之外的最小干预。

3. **掌握度只加不减。**
   ``new_score = min(1.0, old + gain)`` 没有任何时间项 ⇒ 学完永远停在 mastered。
   FSRS 侧早就有一套验证过的衰减形式（``english_vocab.retrievability``），
   这里直接复用同一套数学，但**只在读取时乘**：
   存量 ``mastery_score`` 一个字节都不动 ⇒ 零数据迁移、零回填风险、老库立刻可用。

4. **跨节点/跨项目的知识迁移完全没有载体。**
   迁移分（``transfer_score``）与记忆分（``mastery_score``）**刻意分开**：
   4 道 D1 识记题能刷满记忆分，但刷不出迁移分。两件事就该有两个数字。

────────────────────────────────────────────────────────────────────
远迁移为什么必须「并排对齐」而不是「类比说明」

Goldwater & Livesey 2023（*Cognition*，关系分类与远迁移）里最关键的一条：
学习者能掌握**关系规则**，但在把关系映射到全新特征集时（far transfer）失败；
而口头提示、调整表层特征显著性这些干预**对近迁移有效、对远迁移几乎无效**，
真正有效的是 **progressive alignment（渐进式对齐）** —— 把两个例子按同一关系结构
并排放、逐项显式对齐。Schmid 2020 的实验进一步给了量化门槛：
部分同构题只有在**结构重叠 ≥ 结构差异**时才能成功迁移。

所以本模块生成的迁移任务**强制要求模型输出 source↔target 的逐项对齐表**，
结构缺失就整批判废（``normalize_transfer_task`` 返回 None），而不是降级成一段散文。
宁可不出题，也不出一段读起来很像迁移、实际什么都没教的文字。
"""

from __future__ import annotations

import hashlib
import math
import re
from typing import Any, Iterable, Sequence

# ==========================================================================
# 一、难度加权
# ==========================================================================

# 难度→增益系数。语义：**一道题的「含金量」相对一道 D1 识记题是几倍。**
#
# 取值理由（不是拍脑袋）：
# - D1 = 0.5：识记题确实该拿分，否则「什么都不做只背定义」不成立；
#   但压到 0.5 是为了**让它不能单独把节点顶到 mastered** ——
#   配合 quiz 权重 0.24 与单次 cap 0.24，4 道 D1 满对 = 0.80·0.5…见下方 examples。
# - D2 = 1.0：机制理解是主干，系数必须精确是 1.0，否则会篡改历史数据的相对关系
#   （大量存量事件没有 difficulty 字段，会按 D2 兜底）。
# - D3 = 1.6：评价/创造层。它同时要更强的作答、更慢的作答、更高的失败风险，
#   给 1.6 是「值得为之多花一次」。刻意不设到 2.0：D3 大量是自评题，
#   自评本身噪声大（见 api_server 的 quiz submit），系数再高就变成鼓励乱勾。
#
# ⚠️ 不要用线上作答数据反拟合这些系数：item difficulty 与 learning 在同一份数据里
# 是混淆的（题目变难的同时学生也在变强，难度会被系统性低估），
# 这是知识追踪领域公开的坑（FAST/IRT 那条线的主要结论之一）。
# 要改就做受控实验，然后改这三个数。
DIFFICULTY_FACTORS: dict[int, float] = {1: 0.5, 2: 1.0, 3: 1.6}

# 缺 difficulty 时的兜底档。选 2 而不是 1：绝大多数存量事件来自 D2 机制题，
# 兜底成 1 会让老库的分数整体缩水，兜底成 3 会让老库显得比实际强。
DEFAULT_DIFFICULTY = 2

MAX_DIFFICULTY = 3


def difficulty_factor(difficulty: Any) -> float:
    """难度 → 增益系数。非法值一律按 :data:`DEFAULT_DIFFICULTY` 兜底，不猜。"""
    try:
        level = int(difficulty)
    except (TypeError, ValueError):
        return DIFFICULTY_FACTORS[DEFAULT_DIFFICULTY]
    return DIFFICULTY_FACTORS.get(level, DIFFICULTY_FACTORS[DEFAULT_DIFFICULTY])


# ==========================================================================
# 二、同题边际递减
# ==========================================================================

# 系数 0.5 的形状：第 1 遍 1.00、第 2 遍 0.67、第 3 遍 0.50、第 4 遍 0.40。
# 为什么不是指数衰减：指数会让「隔一周重做同一道题」也吃重罚，而间隔之后重做
# 恰恰是间隔效应（spacing effect）想要的行为。这里只惩罚**没有间隔的重复**，
# 所以输入是「近 N 天内做同一题几次」，不是「历史上做过几次」。
REPEAT_DECAY = 0.5

# 「近 N 天」的窗口。取 3 天是折中：一天内重复是刷分，隔三天以上重做是复习。
REPEAT_WINDOW_DAYS = 3.0

# 下限：即便连做 10 遍也保留 25% 增益。完全归零会让「反复订正一道错题」永远不加分，
# 那会惩罚最需要重复练习的人（这正是 progress_engine 反复在修的病症）。
REPEAT_FLOOR = 0.25


def freshness_factor(repeat_count: int) -> float:
    """近窗口内同一题已做次数 → 增益系数。``repeat_count=0`` 返回 1.0。"""
    try:
        count = max(0, int(repeat_count))
    except (TypeError, ValueError):
        return 1.0
    return max(REPEAT_FLOOR, 1.0 / (1.0 + REPEAT_DECAY * count))


# ==========================================================================
# 三、遗忘衰减（只在读取时生效，不改存储）
# ==========================================================================

# 与 english_vocab.FSRS 同构的 FSRS-5 衰减形式：R(t,S) = (1 + FACTOR·t/S)^DECAY。
# 复用同一套数学而不是另发明一条曲线，是因为「掌握度也会忘」与「卡片也会忘」
# 本来就该是同一条曲线；两套参数必然漂移。
DECAY_EXPONENT = 0.5
# 令 R(S)=0.9（即稳定期结束时保留 90%）解出的 FACTOR。
# 它是**负数**（约 -0.19），所以 t 很大时括号内会变负 —— 见 :func:`retention_multiplier`
# 里必须把底数夹到 0，否则长期未复习的节点会算出复数。
DECAY_FACTOR = 0.9 ** (1 / DECAY_EXPONENT) - 1  # ≈ -0.19

# 没有卡片排期可比时的兜底稳定度（天）。相当于「按 7 天半衰记住」的经验值。
# 取 7 天而不是 30：掌握度本来就该比卡片更容易回落 —— 卡片是刻意排期复习的对象，
# 而 mastery 是「你自认为会了多少」，长期不复习就该掉。
DEFAULT_STABILITY_DAYS = 7.0

# 显示下限：衰减最多吃掉 45% 的分数，剩下 55% 永远留住。
# 为什么不衰减到 0：mastery_score 是**累加历史**，把历史抹掉等于说「你从没学过」，
# 那不诚实。掉回 45% 的语义是「学过，但该复检了」—— 位阶（progress_engine 的
# 四档）本来就会独立回落，两处口径不打架。
DECAY_FLOOR = 0.55


def retention_multiplier(
    elapsed_days: float, stability: float | None = None
) -> float:
    """经过 ``elapsed_days`` 天后还剩多少（乘性系数），下限 :data:`DECAY_FLOOR`。

    底数必须夹到 0：``DECAY_FACTOR`` 是负的，``t/S`` 超过约 5.3 之后
    ``1 + FACTOR·t/S`` 变负，再开 1/2 次方就是复数 —— 一个「学了一年半的节点」
    恰好会踩到，所以这不是理论隐患而是必现bug。夹到 0 后走 :data:`DECAY_FLOOR`。
    """
    try:
        days = max(0.0, float(elapsed_days))
    except (TypeError, ValueError):
        return 1.0
    if days <= 0.0:
        return 1.0
    try:
        s = float(stability) if stability is not None else DEFAULT_STABILITY_DAYS
    except (TypeError, ValueError):
        s = DEFAULT_STABILITY_DAYS
    if s <= 0.0:
        s = DEFAULT_STABILITY_DAYS
    base = 1.0 + DECAY_FACTOR * days / s
    if base <= 0.0:
        return DECAY_FLOOR
    return max(DECAY_FLOOR, min(1.0, base ** DECAY_EXPONENT))


def effective_mastery(
    raw: float,
    *,
    elapsed_days: float,
    stability: float | None = None,
) -> dict[str, Any]:
    """把累加的 raw 分数换算成「此刻真实还剩多少」。

    返回结构里**同时带回 raw** —— 界面上必须让用户看见「你累计学过多少」与
    「现在还记得多少」两个数，只给后者会让人以为学过的东西被系统删了。
    """
    try:
        base = max(0.0, min(1.0, float(raw)))
    except (TypeError, ValueError):
        base = 0.0
    multiplier = retention_multiplier(elapsed_days, stability)
    effective = base * multiplier
    return {
        "raw": round(base, 6),
        "effective": round(effective, 6),
        "retention": round(multiplier, 6),
        "elapsed_days": round(max(0.0, float(elapsed_days or 0.0)), 4),
        "stability_days": round(
            float(stability) if stability else DEFAULT_STABILITY_DAYS, 4
        ),
        "decayed": effective < base - 1e-9,
    }


# ==========================================================================
# 四、迁移分（与记忆分分离的第二个数字）
# ==========================================================================

# 迁移分单次增益上限。刻意与记忆分的 quiz cap(0.24) 拉开：
# 迁移题必须答对两道以上才算「迁移得动」，一道蒙对不算。
TRANSFER_SINGLE_GAIN_CAP = 0.34

# 迁移分阈值。低于 learning 门槛就仍在「迁移待验证」，不会因为做了迁移题就宣称会迁移。
TRANSFER_THRESHOLD_PARTIAL = 0.35
TRANSFER_THRESHOLD_SOLID = 0.75

TRANSFER_STAGE_LABELS: dict[str, str] = {
    "untested": "迁移未验证",
    "partial": "迁移待验证",
    "solid": "迁移得动",
}


def transfer_stage(score: Any) -> str:
    """迁移分 → 三档。与记忆分的四档位阶**刻意不共用**：
    迁移只有「验过 / 验了一半 / 验得很实」三态，多一档就是噪声。"""
    try:
        value = max(0.0, min(1.0, float(score)))
    except (TypeError, ValueError):
        value = 0.0
    if value >= TRANSFER_THRESHOLD_SOLID:
        return "solid"
    if value >= TRANSFER_THRESHOLD_PARTIAL:
        return "partial"
    return "untested"


def transfer_gain(
    *,
    correctness: float | None,
    confidence: float,
    distance: str,
    repeat_count: int = 0,
) -> float:
    """一次迁移作答 → 迁移分增量。

    比记忆分多一个 ``distance`` 因子：远迁移答对比近迁移答对更值钱。
    权重 0.34 是这样定的 —— 近迁移 1 道 ≈ 0.34（不到「迁移得动」的 0.75），
    中迁移 1 道 ≈ 0.41，远迁移 1 道 ≈ 0.51。**必须两到三道不同距离的题**
    才能点亮「迁移得动」，这正是我们要的行为：一次侥幸不算迁移。
    """
    if confidence < 0.5:
        # 与记忆分同一道闸门：节点映射不可信 ⇒ 什么都不加。
        return 0.0
    if correctness is None:
        return 0.0
    try:
        corr = max(0.0, min(1.0, float(correctness)))
    except (TypeError, ValueError):
        return 0.0
    weight = 0.34
    factor = DISTANCE_GAIN_FACTORS.get(distance, DISTANCE_GAIN_FACTORS["near"])
    raw = weight * corr * confidence * factor
    return min(raw, TRANSFER_SINGLE_GAIN_CAP) * freshness_factor(repeat_count)


# ==========================================================================
# 五、迁移距离（近 / 中 / 远）
# ==========================================================================

# 三档距离的定义刻意绑定到「变了什么」而不是「难不难」——
# 难度是题面属性，距离是**表征与领域**属性，混成一句话就会退化回难度分级。
TRANSFER_DISTANCES: tuple[str, ...] = ("near", "mid", "far")

TRANSFER_DISTANCE_LABELS: dict[str, str] = {
    "near": "近迁移 · 换条件",
    "mid": "中迁移 · 换表征",
    "far": "远迁移 · 换领域",
}

TRANSFER_DISTANCE_HINTS: dict[str, str] = {
    "near": (
        "同一领域内改变一个已定义的条件/参数/取值，预测结论如何变化。"
        "背景、术语、公式全部不变 —— 变的只是条件。"
    ),
    "mid": (
        "知识点不变，但**换一种表征**：文字描述 ↔ 公式 ↔ 图表 ↔ 伪代码 ↔ 真实数据。"
        "考的是「换张皮还认不认得出来」。"
    ),
    "far": (
        "换到资料**没有直接写过**的领域或场景，只保留与来源同构的**关系结构**。"
        "此时表层特征全部不同，识别路径只能靠结构对齐。"
    ),
}

DISTANCE_GAIN_FACTORS: dict[str, float] = {"near": 1.0, "mid": 1.2, "far": 1.5}

# 远迁移的额外硬约束：不得引入 sources 之外的**具体事实**（人名/机构/政策/数值）。
# 远迁移最容易出的事故是模型为了「换个领域」而编一个新领域出来，
# 那道题立刻从「测迁移」变成「测幻觉」。所以 far 档逐条点名禁止。
FAR_BOUNDARY_RULES: tuple[str, ...] = (
    "新情境的领域可以换，但**不得引入 sources 之外的任何具体事实**："
    "人物、机构、政策、年份、数值、单位一律禁止。",
    "新情境只能由 sources 中已定义的概念/关系**结构**改写而成，"
    "不得凭空创造一个 sources 根本没提过的学科或技术。",
    "若确实找不到可同构的领域，宁可把 distance 标成 mid，也不要硬造一个 far。",
)


def normalize_distance(value: Any) -> str:
    """距离档位归一。无法识别时**降级成 near**（不是 mid、更不是 far）：
    猜高档位等于虚报迁移能力，这比少报一次迁移严重得多。"""
    text = str(value or "").strip().lower()
    if text in DISTANCE_GAIN_FACTORS:
        return text
    if "远" in text or "far" in text:
        return "far"
    if "中" in text or "mid" in text or "表征" in text:
        return "mid"
    return "near"


# ==========================================================================
# 六、渐进式对齐出题
# ==========================================================================

TRANSFER_TASK_NAME = "transfer_variant"
CONCEPT_ALIGN_TASK_NAME = "concept_align"

# 最小对齐步数。低于这个数就不是「对齐表」，是「一句话类比」——
# Goldwater 2023 说的正是后者对远迁移无效。
MIN_ALIGNMENT_STEPS = 3
MAX_ALIGNMENT_STEPS = 8

# 对齐步骤里两侧都必须非空。空的一侧等于「这一步没有对应物」，
# 那是两个不同知识点的偶然相似，不是同构。
MAX_ALIGNMENT_SIDE_LEN = 220
MIN_ALIGNMENT_SIDE_LEN = 2


def build_transfer_payload(
    *,
    node: dict[str, Any],
    prereqs: Sequence[dict[str, Any]],
    sources_text: str,
    distance: str,
    answered_recently: Sequence[str] = (),
) -> dict[str, Any]:
    """组装「换个情境试试」的出题 payload。

    三个设计决定：
    1. **前置必须进上下文**。原单节点出题只投喂 parent/child/wikilinks，
       `prerequisite_ids` 一个都没投 —— 于是「傅里叶变换」出题时看不见它的前置
       「复变函数」。远迁移题没有前置可依必然是空中楼阁，所以这里硬性带上。
    2. **已答过的情境回灌**。近迁移靠「换条件」，不避开旧条件就会反复问同一个反事实。
    3. **远迁移逐条给边界规则**。见 :data:`FAR_BOUNDARY_RULES`。
    """
    level = normalize_distance(distance)
    rules = list(FAR_BOUNDARY_RULES) if level == "far" else []
    return {
        "task_kind": "transfer_variant",
        "knowledge_point": {
            "name": node.get("name", ""),
            "description": (node.get("description") or "")[:400],
            "node_id": node.get("node_id", ""),
        },
        "target_distance": level,
        "target_distance_label": TRANSFER_DISTANCE_LABELS[level],
        "distance_requirement": TRANSFER_DISTANCE_HINTS[level],
        "boundary_rules": rules,
        # 前置：只给名字 + 一句说明 + 层号。给全文会让模型把题出在前置上。
        "prerequisites": [
            {
                "name": item.get("name", ""),
                "description": (item.get("description") or "")[:160],
                "layer": item.get("layer", 0),
            }
            for item in prereqs
            if str(item.get("name") or "").strip()
        ],
        "alignment_requirement": (
            f"必须输出一条 source_example → target_example 的逐项对齐表，"
            f"共 {MIN_ALIGNMENT_STEPS}~{MAX_ALIGNMENT_STEPS} 步。"
            "每一步写清「源例中的哪一步」对应「目标情境里的哪一步」以及它为什么成立。"
            "**禁止**用一段话概括两者的相似 —— 概括式类比对远迁移无效。"
        ),
        "avoid_repeating": list(answered_recently)[:10],
        "sources": sources_text,
        "schema": {
            "distance": "near|mid|far，必须等于 target_distance",
            "source_example": (
                "源例：取自 sources 的一个具体情境/推导，60~160 字，"
                "写清它用到的是哪几个概念与哪一步推理"
            ),
            "target_example": (
                "目标情境：与源例同构但换了条件的场景，60~160 字。"
                "far 档必须换领域；mid 档必须换表征；near 档必须换条件"
            ),
            "alignment": [
                {
                    "source_step": f"源例中的第 N 步（{MIN_ALIGNMENT_SIDE_LEN}~{MAX_ALIGNMENT_SIDE_LEN} 字）",
                    "target_step": f"目标情境里对应的一步（{MIN_ALIGNMENT_SIDE_LEN}~{MAX_ALIGNMENT_SIDE_LEN} 字）",
                    "why": "这一步为什么在两个情境里等价（1 句）",
                }
            ],
            "question": (
                "设问句，必须点名具体术语，以「？」结尾；"
                "禁止填空式题干（不得出现 ____）"
            ),
            "answer_points": "4~6 条采分点（数组），允许没有唯一标准答案",
            "source_ids": ["src_..."],
        },
    }


# 出题后必须逐条过的关。任何一条不过就整批判废（返回 None），
# 理由见模块头：宁可不迁移，也不出一条「读起来像迁移」的题。
_ALIGNMENT_FIELDS = ("source_example", "target_example", "question")


def normalize_transfer_task(raw: Any) -> dict[str, Any] | None:
    """校验并归一模型的迁移题。任一硬约束不过 ⇒ 返回 None（不出这道题）。

    硬约束清单（少一条就会退化回「类比说明」）：
    - 顶层字段齐；
    - 对齐步数 ≥ :data:`MIN_ALIGNMENT_STEPS`；
    - 每一步两侧都非空且长度在界内；
    - ``why`` 非空（否则就是纯并排，没有对齐动作）；
    - 采分点 ≥ 3 条（一条都没有 ⇒ 没有判分依据，学习者不知道自己算不算会）；
    - ``distance`` 合法。
    """
    if not isinstance(raw, dict):
        return None
    distance = normalize_distance(raw.get("distance"))
    cleaned: dict[str, Any] = {"distance": distance}
    for field in _ALIGNMENT_FIELDS:
        value = str(raw.get(field) or "").strip()
        if len(value) < MIN_ALIGNMENT_SIDE_LEN:
            return None
        cleaned[field] = value

    steps: list[dict[str, str]] = []
    for item in raw.get("alignment") or []:
        if not isinstance(item, dict):
            continue
        left = str(item.get("source_step") or "").strip()
        right = str(item.get("target_step") or "").strip()
        why = str(item.get("why") or "").strip()
        if not (left and right and why):
            continue
        if not (MIN_ALIGNMENT_SIDE_LEN <= len(left) <= MAX_ALIGNMENT_SIDE_LEN):
            continue
        if not (MIN_ALIGNMENT_SIDE_LEN <= len(right) <= MAX_ALIGNMENT_SIDE_LEN):
            continue
        steps.append({"source_step": left, "target_step": right, "why": why})
    if len(steps) < MIN_ALIGNMENT_STEPS:
        return None
    cleaned["alignment"] = steps[:MAX_ALIGNMENT_STEPS]

    points: list[str] = []
    for item in raw.get("answer_points") or []:
        text = str(item or "").strip()
        if text:
            points.append(text)
    if len(points) < 3:
        return None
    cleaned["answer_points"] = points[:6]

    cleaned["source_ids"] = [
        str(item).strip()
        for item in (raw.get("source_ids") or [])
        if str(item).strip()
    ][:6]
    return cleaned


# ==========================================================================
# 七、跨项目概念对齐用的键
# ==========================================================================

# 概念键 = 归一化术语名的 sha1 前 12 位。
#
# 为什么不用 stable_node_id：它已经在给 framework 兜底 node_id 用，
# 语义是「同一个知识点名 → 同一个 id」，但它把 slug 拼进了 id，
# 于是「傅里叶变换」与「傅里叶分析」必然不同名 —— 而这两者在校际层面就是同一个概念。
# 跨项目对齐要的是**概念**的键，粒度比 node 粗、跨写法可比，所以单独做。
_ALIAS_SPLIT = re.compile(r"[\s、,，/／·・\-—_()（）\[\]【】]+")
_ALIAS_DROP = re.compile(r"[（(【\[].*?[)）】\]]")


def normalize_term(raw: Any) -> str:
    """术语归一：去括注、去分隔符、大小写与全半角无关。跨项目对齐的前提。"""
    text = str(raw or "").strip()
    if not text:
        return ""
    text = _ALIAS_DROP.sub("", text)
    text = _ALIAS_SPLIT.sub("", text)
    return text.lower()


def concept_key(raw: Any) -> str:
    """归一化术语 → 跨项目概念键。空术语返回空串（不生成垃圾键）。"""
    normalized = normalize_term(raw)
    if not normalized:
        return ""
    digest = hashlib.sha1(normalized.encode("utf-8")).hexdigest()
    return f"cpt_{digest[:12]}"


def term_variants(raw: Any) -> list[str]:
    """一个术语的常见变体，用来在**用户自己的其它项目**里找同义写法。

    刻意不联网、不查词表 —— 这个项目是 local-first、零外部依赖，
    变体只能从「用户已有的其它项目里出现过的写法」里长出来。
    找不到就是找不到，**不猜**。
    """
    base = str(raw or "").strip()
    if not base:
        return []
    out = [base]
    normalized = normalize_term(base)
    if normalized and normalized != base:
        out.append(normalized)
    # 去掉常见学科前后缀，制造可匹配的短形式（「傅里叶变换光学」→ 「傅里叶变换」）
    for suffix in ("光学", "原理", "基础", "导论", "概论", "理论", "方法"):
        trimmed = base.removesuffix(suffix).strip()
        if len(trimmed) >= 3 and trimmed not in out:
            out.append(trimmed)
    return out


def pick_interleaved(
    candidates: Sequence[Any],
    *,
    limit: int,
    seed: int,
) -> list[Any]:
    """从候选里挑 ``limit`` 个**互相尽量不像**的项，用于交错出题。

    为什么需要这个函数：交错练习（interleaving）是 learning science 里
    效应量最大、成本最低的干预之一（Sana & Yan 2022：每周 10~12 分钟的
    交错小测，一个月后 d=0.71）—— 而「一个节点出一套题」恰好是阻塞练习，
    等于主动站在对照组的对面。实现只要打散顺序，模型调用次数都不用增加。

    做法：按 ``seed`` 做确定性轮转（同一 seed 结果稳定，刷新不换人），
    再取「层号 + 名称」差异最大的贪心集合，避免一轮里全是同一章的邻居。
    """
    pool = [item for item in candidates if item is not None]
    if limit <= 0 or not pool:
        return []
    if len(pool) <= limit:
        return list(pool)

    # 确定性轮转：同一个 seed 永远给出同一批（刷新面板不会来回换人），
    # 换一天换 seed 才换人 —— 与 progress_engine 的探索位同一套做法。
    ordered = sorted(pool, key=lambda item: (_stable_index(item) + int(seed)) % 100000)
    return ordered[:limit]


def _stable_index(item: Any) -> int:
    """把任意候选项映射成一个小整数，用于确定性轮转。"""
    if isinstance(item, str):
        raw = item
    elif isinstance(item, dict):
        raw = str(item.get("node_id") or item.get("name") or "")
    else:
        raw = str(item)
    return int(hashlib.sha1(raw.encode("utf-8")).hexdigest()[:8], 16)


def migration_distance_from_layers(
    target_layer: int, prereq_layers: Iterable[int]
) -> bool:
    """层差 ≥1 ⇒ 这道题应当是组合题（调用方据此强制 difficulty=3）。

    这是「按依赖图出迁移题」最省的一条规则：不需要新的数据结构，
    ``progress_engine._layers`` / ``exam_scheduler._order_prereq_first``
    已经把 Kahn 层号算好了。
    """
    try:
        base = int(target_layer)
    except (TypeError, ValueError):
        return False
    for raw in prereq_layers:
        try:
            if abs(int(raw) - base) >= 1:
                return True
        except (TypeError, ValueError):
            continue
    return False


def transfer_gap_score(
    *,
    stage: str,
    transfer_score: float,
    has_prereq: bool,
    due_cards: int,
) -> int:
    """「最该补迁移证据」的节点优先级。分值口径与 progress_engine 的桶加成一致。

    判定纪律（与 progress_engine 同源）：**只按已有的结构事实排序，不猜**。
    没有前置图就没有「组合题」这条路，此时该节点直接不参与迁移桶 ——
    宁可少推一个迁移任务，也不要推一个必然退回识记的任务。
    """
    if stage not in ("get", "hold"):
        return 0
    if not has_prereq:
        return 0
    score = 0
    if stage == "hold":
        score += 30
    else:
        score += 18
    try:
        gap = max(0.0, 1.0 - float(transfer_score))
    except (TypeError, ValueError):
        gap = 1.0
    score += int(40 * gap)
    try:
        score += 5 * min(max(0, int(due_cards)), 3)
    except (TypeError, ValueError):
        pass
    return score


def describe_decay(calc: dict[str, Any]) -> str:
    """衰减的一句话解释。给「回答依据」面板那种需要自报家门的场合用。"""
    if not calc.get("decayed"):
        return "按累计证据算，没有可扣的遗忘衰减。"
    return (
        f"累计学过 {round(calc['raw'] * 100)}%，距上次证据 {int(calc['elapsed_days'])} 天，"
        f"按稳定性 {int(calc['stability_days'])} 天估算还记得约 {round(calc['retention'] * 100)}%，"
        f"所以此刻约 {round(calc['effective'] * 100)}%。"
    )


def math_sanity() -> dict[str, float]:
    """常数自检（回归脚本调用）。挡的是「有人把某个系数改成了 0」。"""
    checks = {
        "d1": difficulty_factor(1),
        "d2": difficulty_factor(2),
        "d3": difficulty_factor(3),
        "fresh_first": freshness_factor(0),
        "fresh_third": freshness_factor(2),
        "fresh_tenth": freshness_factor(9),
        "decay_same_day": retention_multiplier(0.0),
        "decay_7d": retention_multiplier(7.0),
        "decay_30d": retention_multiplier(30.0),
        "decay_365d": retention_multiplier(365.0),
        "cap": TRANSFER_SINGLE_GAIN_CAP,
    }
    if not (0.0 < checks["d1"] < checks["d2"] < checks["d3"] <= 2.0):
        raise AssertionError(f"难度系数必须严格递增且不超过 2.0：{checks}")
    if not (checks["fresh_first"] > checks["fresh_third"] > checks["fresh_tenth"]):
        raise AssertionError(f"边际递减必须单调下降：{checks}")
    if not (
        checks["decay_same_day"]
        >= checks["decay_7d"]
        >= checks["decay_30d"]
        >= checks["decay_365d"]
        >= DECAY_FLOOR - 1e-9
    ):
        raise AssertionError(f"衰减必须单调下降且不低于下限：{checks}")
    if not math.isfinite(checks["cap"]) or checks["cap"] <= 0:
        raise AssertionError("迁移分单次上限必须是正有限数")
    return checks
