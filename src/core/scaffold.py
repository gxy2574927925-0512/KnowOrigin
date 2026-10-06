"""支架强度分级：AI 该帮到哪一步，就帮到哪一步。

## 这个模块存在的理由

本项目自己在 ``core/teaching_mode.py`` 的模块注释里引用了 Bastani et al., PNAS 2025
（无护栏的 GPT-4 让练习时成绩 +48%，撤掉 AI 后考场上 **-17%**；带护栏的 GPT Tutor
练习时 +127%，考场上回到对照组水平）。护栏就是「别直接给答案，给提示」。

但那条护栏**只做在了 guided 一档**上。查一遍代码就很清楚：

* ``teaching_mode.MODES = ("direct", "guided")``，``DEFAULT_MODE = "direct"``；
* ``_MOVE_PLANS`` 只有 ``guided`` 一个键，所以 ``scaffold_block`` 在 direct 档返回 ``""``；
* 全仓唯一一处把掌握度接进提示词的地方是 ``api_server.py:7480`` 的 ``weak_flag``，
  它来自 ``digest.weak_points``（即 ``mastery_score < 0.3``），并且只追加一句
  「用类比 + 单步提示」。

也就是说：**默认档位下没有任何支架分级，而唯一那点分级用的是加权累加分，不是 BKT。**
更关键的是那一个布尔值是**单向**的 —— 只会「多给一点」，永远不会「少给一点」。
学习者在「稳了」的节点上照样逐题被喂完整答案，这就是 Kalyuga et al. (2003) 说的
**专业知识反转效应**：对已有图式的人，冗余支架从「帮助」变成「干扰」，
而且用户不会觉得烦，只会觉得「这题我明明会，它还啰嗦半天」。

本模块把这个布尔值换成一条**五档、会往上也会往下走**的梯子。

## 为什么绑 BKT 而不是绑 mastery_score

``mastery_score`` 是只加不减的累加分（``framework.MASTERY_EVIDENCE_WEIGHTS``），
提问 13 次就能把节点推到 mastered —— 这正是 ``core/mastery_audit.py`` 存在的理由。
拿一个「问出来的会了」去决定「要不要撤掉提示」，等于把漏洞放大成教学策略。

BKT（``core/mastery_bkt.py``）显式区分「猜对」和「真会」，而且它有「没有观测时退回先验」
的诚实机制（``is_prior_only``）—— 正好当「证据不足，别乱降支架」的闸门。

所以这里的输入是 ``(bkt, stage, observations, demand)``，**不是一个分数**。

## 四条不许越过的边界

认知负荷理论里，「合意困难」（Bjork & Bjork, 2011）有个明确的适用条件，原文是：

> 如果学习者没有足够的背景知识或技能去成功应对这些困难，它们就变成**不合意困难**。

这句话直接给出了本模块几条守卫，每条都对应一句代码：

1. **新手不能被撤支架**（``_NOVICE_FLOOR``）：``stage`` 还在 ``none`` / ``seen``
   时，强度下限锁在 ``faded``。不会的东西不配叫「合意困难」，只叫「没讲」。
2. **证据薄不能被撤支架**（``_THIN_FLOOR``）：观测数 ≤ 1 时强度上限锁在 ``outline``。
   做过一次不代表会了，BKT 那时还几乎是先验。
3. **换情境要加支架**（``demand="hard"``）：同一个概念换成新题型考（D3 / 迁移）时，
   **即使 BKT 很高也要把支架加回一档**。专家反转效应说的是「同任务、同熟练度下冗余才有害」；
   任务一变，学习者就是新手了 —— 这一条最容易做错，也最容易做对。

   注意守卫 1 会在 ``demand="hard"`` 时继续生效且优先：守卫 3 刚加回一档，
   守卫 1 又把它拉到 ``faded``。这是有意的 —— 「换了情境的新手」和「概念本身的新手」
   在支架需求上是同一件事，都还没证明自己能应对，把支持给足比给少更安全。
4. **位阶与 BKT 冲突时按 BKT 给，并把它说出来**（``_STAGE_HOLD_BKT_FLOOR``）：
   ``stage == "hold"`` 但 BKT 还在 ``0.55`` 以下，说明「卡片翻熟」被当成了「会做」。
   档位不用改 —— BKT 低时 ``level_from_bkt`` 本来就落在 ``full``；
   但要**补一条说明**，因为「位阶说稳了、证据说没到」正是
   ``core/mastery_bkt.py``「weighted 高、BKT 低最值得看一眼」的同构情形，
   用户不看那个并排视图就永远不会知道。

## 不做什么

* **不算新的掌握度、不写任何表、不调模型。** 纯函数 + 纯计算，输入给够就出结论。
* **不改 ``teaching_mode`` 的既有档位。** 本模块给的是「该帮到哪一步」，
  ``teaching_mode`` 给的是「这一问该怎么答」，两者正交；提示词块由
  ``prompt_block`` 输出，谁要用谁拼，``direct`` 档也可以拼进去。
* **不给百分比、不给分数。** 与项目「用位置代替分数」的既有承诺一致。
"""

from __future__ import annotations

from typing import Any

# 五档梯子，从「帮得最多」到「完全不给」。顺序即强度顺序，下标越大支架越弱。
SCAFFOLD_LADDER: tuple[str, ...] = (
    "full",
    "faded",
    "outline",
    "hint",
    "silent",
)

SCAFFOLD_LABELS: dict[str, str] = {
    "full": "给完整例题",
    "faded": "给半程例题",
    "outline": "只给要点骨架",
    "hint": "只点第 1 步",
    "silent": "不给提示",
}

# 界面上给用户看的一句话。刻意不写「因为你的分数是 0.62」—— 界面不出现分数。
SCAFFOLD_WHAT: dict[str, str] = {
    "full": "整条步骤都给你，你只负责跟一遍，看哪一步开始跟不上了",
    "faded": "前两步给你，最后一步你自己补",
    "outline": "只写每一步叫什么，内容留给你",
    "hint": "只点第 1 步往哪走，后面你自己推",
    "silent": "什么都不给，做完我再对照",
}

# BKT 分档 → 梯子下标。阈值刻意不整齐（.40/.62/.78/.90），因为它们要跟
# GATE_GET_BKT=0.55（progress_engine 的位阶闸门）和 MASTERED_THRESHOLD=0.80
# （framework 的 mastered 门槛）错开，否则三套口径会在同一分上打架。
_BKT_CUTS: tuple[tuple[float, str], ...] = (
    (0.40, "full"),
    (0.62, "faded"),
    (0.78, "outline"),
    (0.90, "hint"),
)

# 一条观测都没有时 BKT 只能退回先验 0.20 → 必然落进 full。这个判定本身是对的，
# 但「一次做对」不该等同于「从头讲一遍」，所以下面两条守卫要把它拉回来。
_PRIOR_ONLY_MAX_OBS = 1        # 与 mastery_bkt.THIN_VERIFIED_MAX 同一量级
_NOVICE_FLOOR = "faded"        # 守卫 1：新手阶段的强度下限
_THIN_FLOOR = "outline"        # 守卫 2：证据薄时的强度上限
_HARD_STEP_BACK = 1            # 守卫 3：换情境时往回加一档

# 守卫 4 的判定线。与 progress_engine.GATE_GET_BKT(0.55) 同值 ——
# 达不到这条线的节点根本进不了 get/hold，所以一旦出现冲突就是真冲突，不是四舍五入。
# 它只补一条说明，不改档位：BKT 低时 level_from_bkt 本来就已经落在 full 上了。
_STAGE_HOLD_BKT_FLOOR = 0.55


def _clamp01(value: Any) -> float:
    try:
        return max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError):
        return 0.0


def _index(level: str) -> int:
    try:
        return SCAFFOLD_LADDER.index(level)
    except ValueError:
        return 0


def level_from_bkt(bkt: Any) -> str:
    """BKT 后验 → 裸档位（不施加任何守卫）。

    单独暴露是为了让 ``explain()`` 能报出「守卫把它从哪一档拉到了哪一档」，
    否则用户只会看到一个结论、看不到它为什么长这样。
    """
    value = _clamp01(bkt)
    for cut, level in _BKT_CUTS:
        if value < cut:
            return level
    return "silent"


def level_for(
    bkt: Any,
    stage: str = "",
    *,
    observations: int | None = None,
    demand: str = "normal",
) -> dict[str, Any]:
    """算出这一步该给多强的支架。

    参数
    ----
    bkt:
        BKT 后验概率（``progress_engine._Project.bkt_of`` 或
        ``mastery_bkt.bkt_chain`` 的 ``mastery``）。缺失/非法按 0 处理。
    stage:
        位阶 ``none`` / ``seen`` / ``get`` / ``hold``。缺失时按 ``""`` 处理，
        即不施加守卫 1（宁可不给也不硬塞）。
    observations:
        可验证证据条数。**传 None 表示「不知道」** —— 此时不施加守卫 2，
        因为把「没查到」当成「很少」会凭空削掉新手该有的支架。
    demand:
        ``"hard"`` 用于 D3 / 迁移 / 换情境这类新任务，触发守卫 3。
        其余值（含空、含未知值）一律按 ``"normal"`` 处理 —— 未知不该被当成 hard。
    """
    base = level_from_bkt(bkt)
    value = _clamp01(bkt)
    level = base
    notes: list[str] = []

    if demand == "hard":
        level = SCAFFOLD_LADDER[max(0, _index(level) - _HARD_STEP_BACK)]
        notes.append("换情境题对新任务也算新手，支架往回加一档")

    if stage in ("none", "seen"):
        floor = _NOVICE_FLOOR
        if _index(level) > _index(floor):
            level = floor
            notes.append("还没到「会了」，支架不下探到不给提示 —— 不会的东西不配叫合意困难")

    if observations is not None and observations <= _PRIOR_ONLY_MAX_OBS:
        cap = _THIN_FLOOR
        # 下标越大支架越弱，所以「比上限还弱」才要拉回来 —— 与守卫 1 的判据方向一致。
        if _index(level) > _index(cap):
            level = cap
            notes.append("可验证证据只有 1 条，BKT 还几乎是先验，不据此撤支架")

    # 位阶与 BKT 打架时，BKT 赢。位阶是「见过 / 会了 / 稳了」，靠的是 FSRS 的
    # 重复次数与稳定性，它分不清「真会」与「卡片翻熟」；BKT 显式带 p_g，分得清。
    # 方向上不需要额外干预 —— BKT 低就已经落进 full 了 —— 但这件事值得**说出来**：
    # 「位阶说稳了、证据说没到」正是 core/mastery_bkt.py 那句
    # 「weighted 高、BKT 低最值得看一眼」的同构情形，用户不看并排视图就永远不会知道。
    if stage == "hold" and value < _STAGE_HOLD_BKT_FLOOR:
        notes.append(
            "位阶说「稳了」但证据还不支持：卡片翻熟不等于会做，这里按证据给足支架"
        )

    return {
        "level": level,
        "label": SCAFFOLD_LABELS[level],
        "what": SCAFFOLD_WHAT[level],
        "base_level": base,
        "notes": notes,
    }


def explain(
    bkt: Any,
    stage: str = "",
    *,
    observations: int | None = None,
    demand: str = "normal",
) -> dict[str, Any]:
    """``level_for`` + 给人看的那段「为什么是这个强度」。

    多给一样东西：``can_withdraw`` —— 「再往前走一档」是什么，以及**够不够格**。
    这是本模块真正想传达的东西：支架不是固定设置，是一条可以被抬起来也放下去的线，
    而放下去的资格由证据决定。
    """
    decided = level_for(
        bkt, stage, observations=observations, demand=demand
    )
    level = decided["level"]
    index = _index(level)
    next_level = (
        SCAFFOLD_LADDER[index + 1] if index + 1 < len(SCAFFOLD_LADDER) else ""
    )

    reasons: list[str] = []
    if _clamp01(bkt) <= 0.0:
        reasons.append("还没有任何可验证的证据，先按「从零讲」对待")
    else:
        reasons.append(f"证据显示你已经到 {_nearest_cut_text(bkt)} 那一档")
    reasons.extend(decided["notes"])

    # 「够不够格再撤一档」—— 与守卫 1 / 守卫 2 用同一组判据，不另立一套。
    novice = stage in ("none", "seen")
    thin = observations is not None and observations <= _PRIOR_ONLY_MAX_OBS

    if not next_level:
        withhold_reason = "已经是最省的一档，没有更少的支架了"
    elif novice:
        withhold_reason = "位阶还不到「会了」，先不撤 —— 不会的东西不配叫合意困难"
    elif thin:
        withhold_reason = "可验证证据只有 1 条，BKT 还几乎是先验，先不撤"
    elif demand == "hard":
        withhold_reason = "这一轮是新情境，支架已经特意加回来过，不再往上撤"
    else:
        withhold_reason = ""

    return {
        **decided,
        "reasons": reasons,
        "can_withdraw": bool(next_level) and not withhold_reason,
        "next_level": next_level,
        "next_label": SCAFFOLD_LABELS[next_level] if next_level else "",
        "withhold_reason": withhold_reason,
        # 守卫是否真的改动了裸档位：没改动就是 BKT 自己在说话，界面不该显示「被守卫拦下」。
        "moved_by_guard": decided["level"] != decided["base_level"],
        "guards": {
            "novice_floor": novice,
            "thin_floor": thin,
            "hard_step_back": demand == "hard",
        },
        "ladder_index": index,
    }


def _nearest_cut_text(value: float) -> str:
    """把 BKT 值映射成一句不含分数的说法。

    刻意的：返回「够不够格的定性词」，不返回百分比。项目在界面上一律不出现分数
    （``progress-panel.js`` 的约定），后端也别把百分比递到前端等着被显示。
    """
    if value < 0.40:
        return "刚起步"
    if value < 0.62:
        return "有印象但还会卡"
    if value < 0.78:
        return "基本能推"
    if value < 0.90:
        return "推得比较顺"
    return "不用看也能做"


def prompt_block(
    level: str,
    *,
    node_name: str = "",
    demand: str = "normal",
) -> str:
    """这一档对应的提示词约束，可直接拼进任意提示词块。

    与 ``teaching_mode.scaffold_block`` 正交：那边回答「这一问该怎么答」，
    这边回答「最多能帮到哪一步」。``direct`` 档照样可以拼 —— 那正是本模块的用途。

    未知档位按 ``full`` 处理（给多不给少），与 ``level_for`` 的保守取向一致。
    """
    safe = level if level in SCAFFOLD_LADDER else SCAFFOLD_LADDER[0]
    subject = f"「{node_name}」" if node_name else "这一块"
    lines = [f"—— 支架强度：{SCAFFOLD_LABELS[safe]}（{subject}）——"]
    if safe == "full":
        lines.append("给完整解题步骤，每一步都写出来，让他跟一遍并标出跟不上的那一步。")
        lines.append("可以写出最终结果，但必须同时写出中间每一步的理由。")
    elif safe == "faded":
        lines.append("给出前 2/3 的步骤并写明每步理由，**最后 1/3 留给他自己补**。")
        lines.append("不要替他补完最后一步，也不要在括注里泄露答案。")
    elif safe == "outline":
        lines.append("只列出每一步的名称与顺序，不写每一步怎么算、不写中间结果。")
        lines.append("让他先自己排一遍，卡住了再往下问。")
    elif safe == "hint":
        lines.append("只点第 1 步往哪个方向走，一句话，其余全部留给他。")
        lines.append("除非他明确说「继续给」，否则不要逐级放行。")
    else:
        lines.append("**不要给任何提示、步骤名或方向。** 让他自己做。")
        lines.append("他卡住时先反问他在想什么，再决定要不要给第 1 步。")
    if demand == "hard":
        lines.append("这是新情境题：按「新任务」对待，不要因为他在原概念上会就省掉推导。")
    return "\n".join(lines)


def shape_session(step_count: int, *, due_cards: int = 0) -> dict[str, Any]:
    """一轮该做多少，给出时间盒而不是件数。

    为什么只给时间不给件数：Pomodoro 的 scoping review（32 项研究、N=5270）里，
    结构化间隔比自定节奏能降低约 20% 疲劳、提升动机；而自我决定理论那边，
    「你还有 47 张卡片待复习」把外部压力和**能力评价**耦在了一起，是典型的
    不合意压力。所以这里**故意不把 due_cards 原样递出去**。

    数字取自同一批证据：新内容以 15~20 分钟为一个块，每块之间插 2~3 分钟微休息，
    人类注意力在持续任务里大约 25 分钟就见顶。休息段不空着 —— 放刚才学到的视觉摘要，
    这本身就是「微休息优于传统休息」那条课堂研究（N=253）的做法。
    """
    blocks = max(1, min(int(step_count or 1), 3))
    work_minutes = 15 * blocks
    break_minutes = 3 * max(0, blocks - 1)
    total_minutes = work_minutes + break_minutes

    phrasing: str
    if work_minutes <= 15:
        phrasing = f"这一轮大概 {work_minutes} 分钟就够"
    elif work_minutes <= 30:
        phrasing = f"这一轮大概 {work_minutes} 分钟，坐得下来"
    else:
        phrasing = f"这一轮大概 {work_minutes} 分钟，可以分两段做"

    return {
        "blocks": blocks,
        "work_minutes": work_minutes,
        "break_minutes": break_minutes,
        "total_minutes": total_minutes,
        "phrasing": phrasing,
        # due_cards 只用来决定休息要插几次，不进入返回值：件数本身是压力源。
        "due_card_hint": (
            "到期卡片已经摊在里面了，不用管有多少张"
            if due_cards > 0
            else "这一轮不用管卡片"
        ),
        "overrun": total_minutes > 60,
        "overrun_note": (
            "超过一小时通常记不进去了，想继续就先歇 5 分钟"
            if total_minutes > 60
            else ""
        ),
    }