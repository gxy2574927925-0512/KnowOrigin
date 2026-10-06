# -*- coding: utf-8 -*-
"""D4 编排层场控：AI 同学讨论的「谁在什么时候开口」状态机（纯函数，不碰 DB）。

设计约束（见 plans/AI同学讨论模式-设计.md D1/D4/D5/D6/D9）：
- 单模型分饰多角：模型只"说人话"，节奏由这里的 stage 序列决定。
- 人设为「海小棠学习小组」成员（冒烟测试已验证口头癖能保持区分度）。
- 阶段序列 open → seed → bounce →（有分歧时 arbitrate）→ wait_user → assess → conclude；
  非只听时在 bounce 停住等用户选边（wait_user），用户作答后进 assess。
  listen_only=True 时跳过 wait_user，直接编排同学连续发言。
- 不设轮数封顶（D9）：conclude 后 API 层可决定停止或从 next_point 重新进入深化。

2026-09 迭代（对话感 / 推进感）：
- 每次发言都带【本轮推进动作】：只允许补新依据 / 指新前提 / 落新场景 / 换切面 /
  收分歧 / 归档未覆盖问题，禁止原地打转。
- 引入【已说过要点】账本：明确列出前面已经讲过的话，本轮一律不得复述。
- 引入 ARBITRATE 阶段：两位同学说法卡住时，由第三人点明分歧本质（事实分歧 /
  前提不同 / 适用范围不同 / 超出资料范围），拉回资料对齐，不在资料外拍板。
- 收束按「前提 → 依据 → 结论 → 边界（资料未覆盖的不外推）」四段对齐，并明确表态是否同意。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, asdict

# ---- 阶段 ----
OPEN = "open"            # 开场：铺清主线 + 确立出发点（仅开场出现一次）
SEED = "seed"            # 提出一个可一起推敲的方向/细节（随认知层面推进轮换）
BOUNCE = "bounce"        # 接力帮衬：顺着上文补充依据 / 商量不同看法 + 拉到场景校验
ARBITRATE = "arbitrate"  # 收分歧：第三人点明分歧本质，拉回资料对齐，促成一致
WAIT_USER = "wait_user"  # 邀请学习者说说想法（可跳过）
ASSESS = "assess"        # 承接学习者意见：一起对照资料确认、帮忙补全
CONCLUDE = "conclude"    # 温和收拢当前共同结论，自然引出可继续方向，不强制结束
NEXT_POINT = "next_point"  # 兼容保留（transition 现直接回 SEED）

# 讲人话前的顺序序列（含 wait_user，listen_only 或用户已作答时由 transition 跳过等待）
# 注意：arbitrate 是按需插入的可选阶段，不进默认序列，保证默认链路向后兼容。
STAGE_SEQ: list[str] = [OPEN, SEED, BOUNCE, WAIT_USER, ASSESS, CONCLUDE]

# 「认知层面」角度池（自由对话用）：SEED 提出方向、CONCLUDE 收拢共识时，
# 按推进序号 round_offset 在层与层之间自然轮换，保证讨论覆盖不同层面而不自转、不重铺。
ROUND_FACETS: list[tuple[str, str]] = [
    ("是什么", "这条结论/概念的主干是什么？它依赖哪些关键条件？先把共同基础立起来。"),
    ("为什么 · 前提与边界", "它在什么条件下才成立？资料里没直说、却被『想当然』默认的前提是什么？"),
    ("怎么用 · 应用与易错", "拿具体场景或反例把它压一压：会错在哪、边界情形怎么处理？"),
]
# 层面缺失时的兜底层面名（未知/超界推进序号）
_FACET_FALLBACK = "换个角度"

# 分工轮换配置：每轮换一套"谁在哪个阶段开口"，保证开场/质疑/抛砖由不同同学轮值，顺序不固定
# arbitrate 不写死：自动取本轮既不当 seed 也不当 bounce 的那位同学来当和事佬。
PERSONA_CONFIGS: list[dict[str, str]] = [
    {"open": "棠小补", "seed": "棠小怼", "bounce": "棠小引", "wait": "棠小怼", "assess": "棠小补", "conclude": "棠小补"},
    {"open": "棠小引", "seed": "棠小补", "bounce": "棠小怼", "wait": "棠小补", "assess": "棠小引", "conclude": "棠小引"},
    {"open": "棠小怼", "seed": "棠小引", "bounce": "棠小补", "wait": "棠小引", "assess": "棠小怼", "conclude": "棠小怼"},
]


# ---- 三人设 · 海小棠学习小组 ----
# 口头癖 = 冒烟测试验证过可保持区分度的关键词抓手；立场决定其讨论角度。
PERSONAS: dict[str, dict[str, str]] = {
    "棠小怼": {
        "kind": "细节把关型",
        "tic": (
            "你待人和气，喜欢替大家把容易漏掉的细节补周全，常用『我们一起理一下这里』"
            "『我补一个容易被漏掉的点』『这里我想再确认一下』开头，语气温和、对事不对人。"
            "你从不用反问句质问同伴——不说『这说法对吗』『你说得对吗』『你把依据拿出来』这类话，"
            "也不呛人、不抬杠、不贬低任何人，只是把话说清楚，让每个人都跟得上。"
        ),
        "angle": "和气地帮大家把资料里没说透、容易被忽略的细节理顺，让每个人都能跟上思路。",
    },
    "棠小补": {
        "kind": "补充型",
        "tic": (
            "你说话爱补全、爱盘点，常用『没错，我顺着补充一点』『你们注意，这里的关键是』"
            "『那我们把它归纳一下』开头，语气沉稳有条理，像帮大家把零散说法归拢、垫底的组长。"
        ),
        "angle": "负责补充资料里的定义、公式和适用条件，把大家接力说出来的要点归拢成一条清楚的主线。",
    },
    "棠小引": {
        "kind": "应用抛砖型",
        "tic": (
            "你说话爱举例子、爱套现实场景帮大家理解，常用『其实这就好像…』『那换到生活中，如果…』"
            "开头，语气随和、爱联想，像一聊就忍不住帮大家搭个生活场景的同学。"
        ),
        "angle": "负责把抽象结论拉到具体应用里，抛出『如果改某个条件会怎样』帮大家一起想通。",
    },
}

# 收束时的共识骨架：讨论要能落到这四段上，才算真的达成一致
CONSENSUS_SKELETON = "前提 → 依据 → 结论 → 边界（资料未覆盖的部分不外推）"


@dataclass(frozen=True)
class PersonaTurn:
    """一次「由谁、按什么指示、是否等你回答」的发言。"""
    persona: str                 # 三人设之一
    stage: str                   # 本发言所处的阶段
    instruction: str             # 给模型的一句话指示（人话，不涉及元判断）
    ask_user: bool = False       # 是否本轮末把问题甩给你（WAIT_USER 为 True）
    move: str = ""               # 本轮推进动作名（供前端/日志展示讨论推进方向）
    to_dict = asdict             # 供 API 层直接序列化


# ---- 推进动作池：每轮只允许从里面挑一个动作，杜绝原地打转 ----
ADVANCE_MOVES: list[tuple[str, str]] = [
    ("补依据", "补一条前面没人提过的资料依据，用『』引原文，并点明它到底支撑了哪句话"),
    ("挑前提", "指出这条结论成立所依赖、但还没人明说的前提或适用范围；资料没写清的就直说没写清"),
    ("落场景", "把已经说清的东西落到一个具体场景里压一压：实际操作、写法或易错点，看它站不站得住"),
    ("换切面", "换一个前面没走过的认知切面重新看这件事，顺势推出下一个要一起想的问题"),
    ("收分歧", "先点明分歧的本质（事实分歧 / 前提不同 / 适用范围不同 / 超出资料范围），再拉回资料对齐，不在资料外拍板"),
    ("做归档", "把已经冒出来但资料没覆盖的问题明确归档：标注『资料未覆盖，不外推』，说清真要查证得查什么"),
]
_MOVE_BY_NAME = {name: desc for name, desc in ADVANCE_MOVES}

# 各阶段默认轮转的推进动作序列（按下标取，保证相邻轮次动作不重复）
_STAGE_MOVES: dict[str, list[str]] = {
    SEED: ["挑前提", "换切面", "落场景"],
    BOUNCE: ["补依据", "落场景", "挑前提"],
    ARBITRATE: ["收分歧", "做归档"],
    ASSESS: ["补依据", "落场景"],
    CONCLUDE: ["做归档", "收分歧"],
    WAIT_USER: ["换切面"],
}


def advance_move_for(stage: str, round_offset: int = 0, context: dict | None = None) -> tuple[str, str]:
    """本轮该做哪个推进动作（纯函数，保证相邻轮不重复）。

    有未解决的分歧（context["tension"]）时，任何阶段都优先做「收分歧」，先对齐再往下走。
    """
    ctx = context or {}
    if ctx.get("tension"):
        return ("收分歧", _MOVE_BY_NAME["收分歧"])
    names = _STAGE_MOVES.get(stage) or ["补依据"]
    name = names[round_offset % len(names)]
    return (name, _MOVE_BY_NAME[name])


# 阶段 → 该轮的发言槽位（ARBITRATE 单独处理）
_STAGE_SLOT: dict[str, str] = {
    OPEN: "open", SEED: "seed", BOUNCE: "bounce",
    WAIT_USER: "wait", ASSESS: "assess", CONCLUDE: "conclude",
}


def persona_for_stage(
    stage: str, listen_only: bool = False, round_offset: int = 0, avoid: str | None = None
) -> str:
    """阶段 + 轮次偏移 → 该由哪位同学开口（轮次间分工轮换，顺序不固定）。

    listen_only 兼容保留：只听时 WAIT_USER 槽由 transition 跳过，不会走到该槽发言。
    avoid：上一位发言的同学；若轮到自己连说两句，就换一位，避免同一个人自问自答。
    """
    cfg = PERSONA_CONFIGS[round_offset % len(PERSONA_CONFIGS)]
    if stage == ARBITRATE:
        # 和事佬 = 本轮既没当 seed 也没当 bounce 的第三人
        pool = [name for name in PERSONAS if name not in (cfg["seed"], cfg["bounce"])]
    else:
        slot = _STAGE_SLOT.get(stage, "conclude")  # NEXT_POINT / 未知阶段兜底
        pool = [cfg.get(slot) or cfg["conclude"]]
    if avoid and pool and pool[0] == avoid:
        rest = [name for name in PERSONAS if name != avoid and name not in pool]
        if rest:
            pool = [rest[round_offset % len(rest)]]
    return pool[0]


# ---- 账本：已确认共识 / 已说过的要点（防复述）/ 未决分歧 ----
def _as_list(value) -> list[str]:
    if not value:
        return []
    if isinstance(value, str):
        return [value]
    return [str(v) for v in value if str(v).strip()]


def build_consensus_block(consensus) -> str:
    """已共同确认的共识 → 注入发言指示的引用块（承接，不重铺）。"""
    items = _as_list(consensus)
    if not items:
        return "目前大家已经共同确认的思路：刚开场还没定论，先从大家已同意的出发点往下推"
    return "目前大家已经共同确认的思路：\n" + "\n".join(f"- {s}" for s in items[-4:])


def build_said_block(said, limit: int = 6) -> str:
    """已经说过的要点 → 明确禁止复述，逼出真正的推进。"""
    items = _as_list(said)
    if not items:
        return ""
    shown = items[-limit:]
    return (
        "【已经说过的要点，本轮一律不得复述】\n"
        + "\n".join(f"- {s}" for s in shown)
        + "\n（复述等于没推进。你只能做一件事：补新依据 / 指新前提 / 落新场景 / 换切面 / 点明分歧本质 / 归档未覆盖问题）\n"
    )


def build_learner_block(learner) -> str:
    """把「学习者本人刚说的那句话 + 自评」单独拎出来，逼模型正面回应，而不是自说自话。"""
    if not isinstance(learner, dict):
        return ""
    reply = str(learner.get("reply") or "").strip()
    if not reply:
        return ""
    if learner.get("correct") is True:
        mark = "ta 自评：『我说对了』✓"
    elif learner.get("correct") is False:
        mark = "ta 自评：『我没答对』"
    else:
        mark = "ta 没有自评对错"
    return (
        f"【学习者（用户本人）刚说的，必须先回应】『{reply}』（{mark}）\n"
        "要求：先正面接住这句话——说得对就明确说『这步你说对了』并给出资料依据；"
        "说偏了就用商量口气说『这里还差一点』再帮 ta 补完整；ta 说自己没答对但其实对了，也要告诉 ta。"
        "不许跳过 ta 的话往下自说自话，也不许和稀泥乱夸。\n"
    )


def build_tension_block(tension) -> str:
    items = _as_list(tension)
    if not items:
        return ""
    return (
        "【当前还没对齐的分歧】" + "；".join(items[-2:]) + "\n"
        "先说清它到底是事实分歧、前提不同、适用范围不同，还是超出了资料范围；"
        "资料没覆盖的部分直接标注『资料未覆盖，不外推』，不许拍脑袋补结论。\n"
    )


_QUOTE_RE = re.compile(r"『([^』]{4,})』")


def compress_point(text: str, limit: int = 60) -> str:
    """把一次发言压成一句「已说过要点」，供后续轮次去重。

    优先抓『』里的资料依据（那才是本轮实质），没有引文再取最长的一句；
    这样能避开「棠小X，你刚才说……」这种接话开场白占满配额、导致去重失效。
    """
    s = (text or "").strip().replace("\n", " ")
    quotes = _QUOTE_RE.findall(s)
    if quotes:
        core = quotes[0]
    else:
        segs = [p.strip() for p in re.split(r"[。！？；]", s) if len(p.strip()) >= 4]
        core = max(segs[:4], key=len) if segs else s
    return (core[:limit] + "…") if len(core) > limit else core


def detect_tension(text: str) -> str:
    """从一次发言里粗判是否存在未对齐的分歧（启发式，供编排层决定是否插入 arbitrate）。"""
    s = text or ""
    # 只认"明确的分歧信号"，避免「但是/可是」这类常见转折把每一步都插成收分歧
    markers = [
        "不一样", "不太对", "我不同意", "其实不是", "反过来说", "我不太认同",
        "存疑", "不敢确定", "还是说", "那如果", "我心里还有个没放下的",
        "这一步是不是还能再想想", "会不会", "没说清", "超出",
    ]
    for m in markers:
        if m in s:
            return compress_point(s, 40)
    return ""


def detect_convergence(text: str) -> bool:
    """判断这次发言是否已经把共识收拢住（用于给只听连播一个自然的收束点）。

    只在 CONCLUDE 阶段的发言上使用：模型明确表态「一致/没有异议」才算收束，
    避免讨论被轮数硬切断（这正是用户反馈的「没有收束」）。
    """
    s = text or ""
    markers = [
        "没有异议", "没有别的意见", "没有其他意见", "达成一致", "一致同意", "完全同意",
        "就按这个", "按这个对齐", "收拢到这里", "收在这里", "我赞同", "没有分歧了",
        "四段对齐", "对齐结果", "待查证项",
    ]
    return any(m in s for m in markers)


def next_step(stage: str, listen_only: bool = False, round_offset: int = 0, context: dict | None = None) -> PersonaTurn:
    """给定阶段，产出该阶段的发言指示（纯函数；节奏的推进由 transition 负责）。

    context 可携带跨轮注入：
    - `{"consensus": "上一轮已逐渐统一的认识"}`：承接已有共识，避免重铺；
    - `{"said": [...]}`：已说过要点清单，本轮禁止复述；
    - `{"tension": "未对齐的分歧"}`：本轮优先做「收分歧」。
    """
    persona = persona_for_stage(
        stage, listen_only, round_offset, avoid=(context or {}).get("last_persona")
    )
    fmt = ROUND_FACETS[round_offset % len(ROUND_FACETS)] if ROUND_FACETS else (_FACET_FALLBACK, "")
    facet_name, facet_ask = fmt
    ctx = context or {}
    move_name, move_desc = advance_move_for(stage, round_offset, ctx)
    consensus_block = build_consensus_block(ctx.get("consensus"))
    said_block = build_said_block(ctx.get("said"))
    tension_block = build_tension_block(ctx.get("tension"))
    move_block = f"本轮推进动作【{move_name}】：{move_desc}\n"

    if stage == OPEN:
        # 只在开场出现一次：铺清主线 + 确立出发点，之后自然接力，不再重铺
        ins = (
            f"这是这段讨论的开场。用温和的语气把当前资料围绕的话题主干完整铺一遍"
            "（概念/公式/适用条件要锚定原文，不得编造原文没有的结论），给一个大家都认可的出发点，"
            "邀请同伴们一起：『这条结论/概念的主干是什么？它依赖哪些关键条件？』，"
            "点名下一位同学的名字，把话头自然递过去。"
        )
        return PersonaTurn(persona, stage, ins, ask_user=False, move=move_name)
    if stage == SEED:
        ins = (
            f"先接住上一位同学的话（顺一句或点个名），再接着往下聊。这一小段想围绕『{facet_name}』把它弄明白：{facet_ask}\n"
            f"{consensus_block}\n"
            f"{said_block}{tension_block}{move_block}"
            "用和气、求知的口吻，顺着上文自然提出一个可以一起继续推敲的方向或细节（依据从资料内部找，"
            "不许引资料之外的新事实）。不重讲已经说清的部分，只为把这一步想得更透，不故意对立、不抬杠。"
        )
        return PersonaTurn(persona, stage, ins, ask_user=False, move=move_name)
    if stage == BOUNCE:
        ins = (
            "先接住上一位同学的话（顺一句或点个名），再用接力帮衬的口吻把思路接着往下带："
            "把资料里支撑的依据补充得更扎实；如果心里有不太一样的想法，就用商量的话说出来"
            "（比如『我有个不一样的理解，你看合起来这样对不对』），大家一起对照资料讨论，"
            "不抢话、不抬杠、不故意唱反调。\n"
            f"{said_block}{tension_block}{move_block}"
            "再把当前这个点放到一个具体场景里一起校验（类比可发散，但要是你自己标注的推测，别当成资料事实）。"
        )
        return PersonaTurn(persona, stage, ins, ask_user=False, move=move_name)
    if stage == ARBITRATE:
        ins = (
            "现在两位同学的说法卡住了，你来当一回和事佬：先接住两边的话，"
            "再用一句话点明『你们其实没有根本分歧，分歧在于____』——说清争的是事实本身、"
            "前提不同、适用范围不同，还是已经超出了资料范围；然后把两边各自站得住的部分归到资料依据上，"
            "把资料覆盖不到的部分明确标成『资料未覆盖，不外推』，绝不用前提内的结论去回答前提外的问题。\n"
            f"{said_block}{tension_block}"
            "最后给出一个两边都能接受的共识表述（按 前提 → 依据 → 结论 → 边界 对齐），请另外两位同学确认。"
        )
        return PersonaTurn(persona, stage, ins, ask_user=False, move=move_name)
    if stage == WAIT_USER:
        ins = (
            "先顺一句上面聊到的地方，再把当前大家还没完全想透、最想请你一起推敲的那个点，变成一个友善的邀请题："
            "『你更倾向怎么理解这一步？说说你的想法就行，咱们一块儿看看资料上是怎么写的。』"
            "语气像同桌请你帮忙、真诚想听你的思路，不施压、不用命令式、不用反问句追问。说完就把话头交给你，自己不给答案。"
        )
        return PersonaTurn(persona, stage, ins, ask_user=True, move=move_name)
    if stage == ASSESS:
        learner = ctx.get("learner") or {}
        reply = str(learner.get("reply") or "").strip()
        if reply:
            if learner.get("correct") is True:
                self_check = "ta 自己勾了『我说对了』"
            elif learner.get("correct") is False:
                self_check = "ta 自己勾了『我没答对』"
            else:
                self_check = "ta 没有自评对错"
            lead = (
                f"学习者刚说的原话是：『{reply[:140]}』（{self_check}）。"
                "你必须先正面回应这句话，绝不允许跳过 ta 的话自说自话："
                "ta 自评答对且确实说到点上，就明确说出『这步你说对了』，并把资料依据补上一句替 ta 坐实；"
                "ta 自评答对但实际有偏差，要如实说明『这里还差一点』并温和补正，不许顺水推舟乱夸；"
                "ta 自评没答对却其实说对了，也要告诉 ta『你其实说对了』。\n"
            )
        else:
            lead = "学习者回答了上一问。先接住 ta 的原话（顺一句或点个名）再往下走。\n"
        ins = (
            lead
            + "请先判断 ta 的回答落在哪种情况：\n"
            "1. 如果 ta 表示卡住了、不知道、没理解（如『我不知道』『不会』『没懂』『有点懵』『没想明白』），"
            "就把交谈节奏放慢、难度降到最低：先和气地接住（『没关系，咱们慢慢来』），不再往下堆新概念、"
            "不再连着追问，而是把当前这一步拆成一个最基础的小问题，邀请 ta 先回到资料里找到对应的那一句"
            "（指出该看原文的哪个位置、哪个词），给 ta 一个够得着的台阶；语气像同桌安抚不催，给足时间，"
            "绝不跳过 ta 自顾自长篇大论。\n"
            "2. 如果 ta 说出了自己的看法：说到点子上的地方，真诚地肯定并补上一句关键依据；"
            "还差一点的地方，用商量的口气指出『这里是不是还能一起再推一步？』帮 ta 补完整——"
            "不放水乱夸，也不苛责。\n"
            f"{said_block}{tension_block}{move_block}"
            "无论哪种情况，都要让 ta 有被听见、被接住的感觉；情况 1 就不要强求『小结共识』，"
            "先把基础理顺、肯定 ta 愿意开口，把没想清楚的落成一两个最基础的待理解点，"
            "再为下一步一起收尾做铺垫。"
        )
        return PersonaTurn(persona, stage, ins, ask_user=False, move=move_name)
    if stage == CONCLUDE:
        ins = (
            f"和大家一起把目前围绕『{facet_name}』已经想明白的部分，温和收拢成 1-2 句共同结论："
            "说清大家现在一致确定的是什么、它在资料上的落点；语气暖、肯定每个人的努力。\n"
            f"{said_block}{tension_block}{move_block}"
            f"收拢时按『{CONSENSUS_SKELETON}』这四段对齐，并明确说出自己是否同意；"
            "如果确实没有分歧了，就把话说死一句：『我这边没有异议了，就按这个对齐』，"
            "再把需要继续查证的疑问单独列为待查证项，不许混进结论里。\n"
            "收拢完用一句和善的话自然地引出还能沿着哪个方向继续想一想，给同伴留个接话的口子。"
        )
        return PersonaTurn(persona, stage, ins, ask_user=False, move=move_name)
    # NEXT_POINT / 未知阶段兜底
    ins = "围绕当前知识点换一个新的切入点继续讨论，仍锚定资料；不要复述已经讲过的要点。"
    return PersonaTurn(persona_for_stage(SEED, listen_only, round_offset), stage, ins, ask_user=False, move=move_name)


def transition(stage: str, user_reply: str | None = None, listen_only: bool = False, context: dict | None = None) -> str:
    """根据用户是否已作答，推进到下一个阶段（自由对话：围绕话题接力，无轮次封顶）。

    区分标准（用户定为"删轮次、围绕话题自由讨论"）：没有"第几轮换角度"，
    每段自然推进并累积共识；CONCLUDE 温和小结后回到 SEED（下一认知层面），
    可一直聊下去，是否结束由用户随时决定。

    context 携带 `{"tension": "..."}` 时，BOUNCE 之后插入 ARBITRATE，由第三位同学先把
    分歧对齐再往下走（不传 context 时行为与旧版完全一致）。
    """
    ctx = context or {}
    if stage == ARBITRATE:
        return WAIT_USER
    if stage == WAIT_USER:
        if listen_only or user_reply:
            return ASSESS  # 只听 / 已作答都推进到点评，避免卡在等待用户
        return WAIT_USER  # 还没作答，继续等
    if stage == BOUNCE and ctx.get("tension"):
        return ARBITRATE  # 先和气地收分歧，再往下走
    if stage in (CONCLUDE, NEXT_POINT):
        return SEED  # 温和小结后自然进入下一段，不重开开场、不强制收束
    if stage == ASSESS:
        return CONCLUDE
    # OPEN / SEED / BOUNCE 依序推进
    try:
        idx = STAGE_SEQ.index(stage)
    except ValueError:
        return SEED
    return STAGE_SEQ[idx + 1]




# ---- D6 可信区 / 软区约束（发言 system 底盘，T3）----
DISCUSSION_SYSTEM: str = (
    "你是「海小棠学习小组」的一位 AI 同学，正在一场围绕用户资料的多人讨论里和同伴、和用户本人对话。"
    "请始终以你的同学人设口吻说话（夹着你自己的口头习惯），不要变成老师、不要当旁白、不要替别人回答。\n"
    "回答边界铁律：\n"
    "1. 硬区（概念/公式/结论/适用条件）：必须锚定下方给的资料原文，涉及关键结论时用『』标出原文，"
    "不得编造资料之外的新事实。\n"
    "2. 软区（类比/联想/开放讨论）：允许发散，但任何离开资料的推测或类比，说话前必须显式标注"
    "『（这只是推测/类比，离开资料的推断，请自行查证）』，绝不能把推测当成资料事实来讲。\n"
    "3. 资料里没提到的信息，一律说『这块资料里没提，我不清楚』并停下，绝不脑补。\n"
    "4. 每轮只讲 1-3 句话，像真的讨论，别长篇大论。\n"
    "5. 本小组固定只有『棠小怼』『棠小补』『棠小引』三位同学，你只能以自己的身份发言，"
    "绝不能自造、改名或冒用其他同学的名字（包括不要再凭空起类似『棠小×』的新名）。\n"
    "对话推进铁律（让讨论像同学在聊天，而不是轮流念稿）：\n"
    "6. 开口先接住上一位同学的话（顺一句、点个名或复述半句他的说法），再给出你自己的新东西；"
    "【已经说过的要点】下列出的内容一律不得复述，复述就是没推进。\n"
    "7. 出现分歧时：先点明分歧本质（事实分歧 / 前提不同 / 适用范围不同 / 超出资料范围），"
    "再拉回资料对齐；资料覆盖不到的就说『资料未覆盖，不外推』，不在资料外拍板、也不和稀泥。\n"
    "8. 收束时明确表态自己是否同意，并按『前提 → 依据 → 结论 → 边界』四段对齐；"
    "需要继续查证的单独列为待查证项，不许当成结论。\n"
    "9. 每次发言都要让讨论往前走一步：要么补一条新依据，要么指出一个新前提或边界，"
    "要么把结论落到一个具体场景/写法/易错点上，要么点明分歧本质，要么把超范围问题归档。\n"
    "语气铁律：确认和追问一律用商量的口气（『这里我想再确认一下』『是不是可以这样理解』），"
    "禁止用『这说法对吗』『你说得对吗』『你把依据拿出来』这类反问句质问同伴，也不许用命令式或审问式的口吻；"
    "同伴说对了就大大方方肯定，不贬低、不较真、不为了质疑而质疑。"
)


def build_turn_messages(
    persona: str,
    topic: str,
    source: str,
    transcript: list[str],
    instruction: str,
    quote: str | None = None,
    ledger: dict | None = None,
    learner: dict | None = None,
) -> list[dict[str, str]]:
    """组装一次发言的 messages：system=D6 底盘+该同学人设，user=话题+资料+讨论史+本步指示。

    复用 `LlmClient.stream_chat_content(messages, task=...)` 流式调用（task 只影响 max_tokens）。
    quote 为用户在笔记/预览中划选出的讨论焦点句，注入话题行引导全组围绕它展开。
    ledger 为跨轮账本 `{"consensus": ..., "said": [...], "tension": ...}`，注入"已说过的禁止复述"
    与"未对齐分歧"，让模型在完整上下文里也能保持推进感。
    """
    if persona not in PERSONAS:
        raise ValueError(f"未知人设: {persona!r}")
    profile = PERSONAS[persona]
    system = (
        DISCUSSION_SYSTEM
        + f"\n你的名字是『{persona}』（{profile['kind']}）。你的口头习惯：{profile['tic']}"
        f" 你的立场：{profile['angle']}"
    )
    focus = f"（本场讨论聚焦你选中的这句话：『{quote}』，请围绕它展开，仍以锚定资料为准）" if quote else ""
    seg = [f"本场讨论话题：{topic}{focus}", f"\n锚定资料：\n{source}"]
    if transcript:
        seg.append("\n下面是到目前为止的讨论（带说话人）：\n" + "\n".join(transcript))
    learner_block = build_learner_block(learner)
    if learner_block:
        # 学习者原话放最前，避免被长长的讨论史淹没（"AI 不鸟我"的直接原因之一）
        seg.append("\n" + learner_block.rstrip())
    led = ledger or {}
    said_block = build_said_block(led.get("said"))
    if said_block:
        seg.append("\n" + said_block.rstrip())
    tension_block = build_tension_block(led.get("tension"))
    if tension_block:
        seg.append("\n" + tension_block.rstrip())
    if led.get("consensus"):
        seg.append("\n" + build_consensus_block(led.get("consensus")))
    seg.append(f"\n现在轮到你发言。这一步的指示：{instruction}")
    user = "\n".join(seg)
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
