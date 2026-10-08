"""读书收获：把一本书（划线 / 想法 / 简介 / 热门划线）变成一份**可复用的结构化文档**。

## 为什么要单独做，而不是复用 knowledge_doc

``core/knowledge_doc.py`` 生成的是「知识点详解」——它假设输入是一份**课程资料**，
输出围绕「定义 / 推导 / 公式 / 相邻知识点」展开，锚点是**框架节点**。

读书场景的输入完全不同：一本书的骨架是**作者的主张**，不是知识点树。
用户读完一本书真正想要的是「**我能拿走什么、能用在哪**」，
而不是「这本书的第 3 章定义是什么」。所以字段必须换一套：
``models``（可复用的模型/框架）、``actions``（可马上用的清单）、``insights``（反常识点）
才是这份文档的主角。

## 三份产物，一条链路

1. **分类**（``guess_category`` + AI ``topics``）——先把书归位，书架才立得住；
2. **简介**（``build_intro_payload`` / ``normalize_intro_result``）——每本书底下那段介绍；
3. **收获文档**（``build_digest_payload`` / ``normalize_digest_result``）——读完之后的那份总结。

## 复用知源已被验证的两条铁律

* **事实铁律**：只依据用户自己的划线 / 想法 / 书籍简介，**绝不拿通识硬凑**。
  书里没写的地方写「书中未涉及」——这是知源所有生成模块的共同底线。
* **逐字段校验 + 本地兜底**：模型某个字段没写好（太短 / 条数不够 / 类型不对），
  **只退回该字段的兜底**，其余字段照用；兜底填的内容会自报家门，
  不冒充模型产出。整份文档因此永不"因为一个字没写好就整篇失败"。
"""

from __future__ import annotations

import re
from typing import Any, Iterable

# --------------------------------------------------------------------------
# 字段成色要求（不满足即视为模型没写好 → 退回本地兜底）
# 数值与 knowledge_doc.py 同源：中文一句话大约 12~18 字，低于这些长度的字段
# 基本是「嗯」「见上」这类占位，收进来只会让文档显得敷衍。
# --------------------------------------------------------------------------

MIN_THESIS = 12
MIN_ARGUMENT = 8
MIN_SPINE = 6
MIN_CHAPTER_SUMMARY = 20
MIN_CHAPTER_TAKEAWAY = 6
MIN_MODEL_WHAT = 8
MIN_MODEL_USE = 6
MIN_INSIGHT = 8
MIN_ACTION = 4
MIN_QUOTE = 4
MIN_CONNECTION = 6
MIN_ANSWER = 2
MIN_CRITIQUE = 6
# 「我的判断」的成色门槛。verdict 太短基本等于没表态（如「不错」），所以门槛最高。
MIN_VERDICT = 10
MIN_JUDGMENT_WHY = 6

MAX_CHAPTERS = 20
MAX_SPINE = 6
MAX_ARGUMENTS = 6
MAX_MODELS = 5
MAX_INSIGHTS = 5
MAX_ACTIONS = 8
MAX_QUOTES = 8
MAX_CONNECTIONS = 6
MAX_SELF_CHECKS = 4
MAX_CRITIQUES = 4

# 连接的**关系类型**。卡片盒笔记法（Zettelkasten）的硬要求是：
# 每建立一条连接，都要说清**为什么连接**。「A 与 B 有关」这种连接等于没连 ——
# 它既不能帮你在半年后想起当时为什么把它们放一起，也不能让图谱区分
# 「这两本书互相印证」和「这两本书互相打脸」（后者往往更值钱）。
# 所以 relation 是必填项，且只能从这里选；认不出就归「相关」。
RELATIONS: tuple[str, ...] = ("支持", "对立", "细化", "例证", "因果", "相关")

# 单次调用输入预算：划线可能上千条，全塞进去模型会在中段丢指令。
MAX_HIGHLIGHTS = 60
MAX_THOUGHTS = 30
MAX_REVIEWS = 8

# 简介与分类
MIN_ONE_LINER = 10
MIN_INTRO = 60
MAX_TOPICS = 6

# 「自测」小节的标题原文。**渲染层与卡片同步层必须用同一个常量** ——
# 「回到文档」是按标题文字在正文里找锚点的，两处各写一份就会漂移，
# 表现为「点了回到文档原地不动」且不报错。`knowledge_doc.py` 踩过这个坑，
# 这里直接抽成常量 + 断言（见 ``sync_origin_section_exists``）。
#
# ⚠️ 刻意**不带序号**。带序号（「七、自测…」）时，一旦正文小节增删
# （例如新增「逐章精读」），序号就会变，锚点跟着失效 —— 而卡片是永久数据，
# 老卡片里的 origin_section 不会跟着改。序号交给渲染层动态算，锚点用无序号标题。
DIGEST_SELF_CHECK_SECTION = "自测：真的读进去了吗"

# 摘录片段长度上限
_CLIP_HIGHLIGHT = 220
_CLIP_THOUGHT = 400
_CLIP_REVIEW = 200
_CLIP_INTRO = 800


# --------------------------------------------------------------------------
# 分类体系（一级领域）
# --------------------------------------------------------------------------

# 一级领域：微信读书原生 ``category``（如「文学-小说」「经济理财-理财」）粒度太细、
# 命名也不统一，直接拿来当导航会碎成一地。这里收成 14 个稳定的一级领域，
# 原生分类只作为「AI 分类失败时的兜底线索」。
CATEGORIES: tuple[str, ...] = (
    "文学小说",
    "人文社科",
    "历史",
    "哲学思想",
    "经济管理",
    "心理",
    "科技互联网",
    "自然科学",
    "职场成长",
    "生活健康",
    "艺术设计",
    "教育学习",
    "童书",
    "其他",
)

# 关键词 → 一级领域。规则层兜底：模型不可用时也能把书归位，
# 且比「全部塞进其他」有用得多。命中多个时取**最长关键词**所属的领域
# （「经济学」比「经济」更具体，不该被后者抢走）。
#
# ⚠️ 必须同时收中英文：古腾堡 / Open Library / Google Books 的标题与主题标签
# 几乎全是英文（"Fiction"、"Science fiction"、"Economics"），只收中文会让
# 这些源的书全部掉进「其他」—— 而它们恰恰是最能拿到全文的那批。
# 英文短语要写全（"science fiction" 而非只写 "fiction"），
# 靠「最长匹配」把它从「自然科学」手里抢回「文学小说」。
_CATEGORY_KEYWORDS: dict[str, tuple[str, ...]] = {
    "文学小说": (
        "文学", "小说", "散文", "诗歌", "名著", "武侠", "科幻", "悬疑", "言情", "童话", "戏剧",
        "fiction", "novel", "novels", "poetry", "poem", "drama", "literature", "romance",
        "fantasy", "mystery", "detective", "short stories", "science fiction", "historical fiction",
        "literary criticism", "classic literature", "best books ever listings",
    ),
    "人文社科": (
        "社科", "社会学", "人类学", "文化", "政治", "法律", "军事", "传记", "纪实", "民族",
        "sociology", "anthropology", "politics", "political", "law", "legal", "military",
        "biography", "autobiography", "essays", "social science", "cultural", "journalism",
    ),
    "历史": (
        "历史", "史学", "考古", "通史", "断代", "民国", "明朝", "唐朝", "清朝", "宋",
        "history", "historical", "archaeology", "medieval", "ancient", "civilization",
    ),
    "哲学思想": (
        "哲学", "思想", "伦理", "逻辑", "宗教", "国学", "禅", "佛",
        "philosophy", "philosophical", "ethics", "logic", "religion", "theology", "metaphysics",
    ),
    "经济管理": (
        "经济", "管理", "投资", "理财", "金融", "商业", "营销", "创业", "会计", "贸易", "货币",
        "economics", "economic", "business", "management", "finance", "financial", "marketing",
        "investing", "investment", "accounting", "entrepreneurship", "commerce", "money",
    ),
    "心理": (
        "心理", "认知", "情绪", "行为", "疗愈", "焦虑", "幸福", "人格",
        "psychology", "psychological", "cognition", "cognitive", "emotion", "behavior",
        "mental health", "psychoanalysis",
    ),
    "科技互联网": (
        "互联网", "计算机", "编程", "算法", "人工智能", "软件", "数据", "产品", "网络",
        "computer", "computers", "computing", "programming", "software", "algorithm",
        "artificial intelligence", "machine learning", "data science", "internet",
        "information technology", "engineering",
    ),
    "自然科学": (
        "科学", "物理", "化学", "生物", "数学", "天文", "地理", "医学", "工程", "生态", "地质",
        "science", "physics", "chemistry", "biology", "mathematics", "math", "astronomy",
        "geography", "medicine", "medical", "ecology", "geology", "natural history",
    ),
    "职场成长": (
        "职场", "效率", "沟通", "时间管理", "成长", "思维", "习惯", "领导力",
        "career", "productivity", "self-help", "self help", "success", "leadership",
        "personal development", "time management", "motivation",
    ),
    "生活健康": (
        "生活", "健康", "养生", "运动", "健身", "饮食", "旅行", "烹饪", "家居", "食谱",
        "cooking", "cookbook", "health", "fitness", "sports", "travel", "gardening",
        "diet", "nutrition", "lifestyle", "home",
    ),
    "艺术设计": (
        "艺术", "设计", "音乐", "绘画", "摄影", "建筑", "美学", "书法",
        "art", "arts", "design", "music", "painting", "photography", "architecture",
        "aesthetics", "drawing", "sculpture",
    ),
    "教育学习": (
        "教育", "学习", "教学", "考试", "育儿", "家庭教育", "学习方法",
        "education", "teaching", "study", "studying", "pedagogy", "learning",
    ),
    "童书": (
        "童书", "绘本", "儿童", "少儿", "青少年", "童话故事",
        "juvenile", "children", "children's", "young adult", "picture book", "fairy tales",
    ),
}

# 英文关键词用**词边界**匹配，中文用子串匹配。
# 不用边界的话 "art" 会命中 "heart"（心脏病 → 被归进艺术设计），
# "AI" 会命中 "said"。这类误判在英文标签上非常常见。
_ASCII_WORD_RE_CACHE: dict[str, "re.Pattern[str]"] = {}


def _keyword_hit(keyword: str, blob_lower: str) -> bool:
    if keyword.isascii():
        pattern = _ASCII_WORD_RE_CACHE.get(keyword)
        if pattern is None:
            pattern = re.compile(rf"(?<![a-z0-9]){re.escape(keyword)}(?![a-z0-9])")
            _ASCII_WORD_RE_CACHE[keyword] = pattern
        return pattern.search(blob_lower) is not None
    return keyword in blob_lower


def normalize_category(value: Any) -> str:
    """把任意输入收敛到 CATEGORIES 里的一个值，认不出就归「其他」。"""
    text = str(value or "").strip()
    return text if text in CATEGORIES else "其他"


# 模型几乎不会老老实实填「对立」，它写的是「彼此相反」「互相矛盾」。
# 不做这层同义回收，绝大多数连接都会被兜成「相关」——
# 于是「两本书互相打脸」（最值钱的一种）和「没想好为什么连」在图谱上长得一样。
_RELATION_SYNONYMS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("对立", ("相反", "矛盾", "冲突", "反驳", "对立面", "唱反调", "打脸")),
    ("支持", ("印证", "佐证", "一致", "呼应", "同样", "同意", "互证")),
    ("细化", ("展开", "具体", "细分", "补充", "深入", "细化")),
    ("例证", ("例子", "举例", "案例", "实例", "说明")),
    ("因果", ("导致", "带来", "引起", "因为", "所以", "前提", "结果")),
)


def normalize_relation(value: Any) -> str:
    """把任意输入收敛到 RELATIONS 里的一个值，认不出归「相关」。

    两步：先认本名，再认同义说法。**不因为措辞不合就把整条连接丢掉** ——
    丢掉连接比关系类型标得不精确要糟得多。
    """
    text = str(value or "").strip()
    if text in RELATIONS:
        return text
    for name in RELATIONS:
        if name in text:
            return name
    for name, synonyms in _RELATION_SYNONYMS:
        for word in synonyms:
            if word in text:
                return name
    return "相关"


def guess_category(*, native_category: str = "", title: str = "", topics: Iterable[Any] = ()) -> str:
    """规则层分类兜底：优先原生分类，其次 AI 给的 topics，最后看书名。

    纯函数、无依赖——模型不可用 / 分类字段缺失时，书架依然分得开。
    """
    haystacks: list[str] = []
    for value in (native_category, title):
        if str(value or "").strip():
            haystacks.append(str(value))
    for topic in topics:
        if str(topic or "").strip():
            haystacks.append(str(topic))
    if not haystacks:
        return "其他"

    blob = " ".join(haystacks).lower()
    best_category = "其他"
    best_len = 0
    for category, keywords in _CATEGORY_KEYWORDS.items():
        for keyword in keywords:
            if _keyword_hit(keyword, blob) and len(keyword) > best_len:
                best_category = category
                best_len = len(keyword)
    return best_category


# --------------------------------------------------------------------------
# 提示词素材
# --------------------------------------------------------------------------

RULES = (
    "【事实铁律 —— 违反即判定本次生成失败】\n"
    "1. 只依据 payload.highlights（用户的划线）、payload.thoughts（用户的想法）、"
    "payload.book（书籍简介等元信息）、payload.reviews（公开点评）里出现过的内容。"
    "没有的一律不写。\n"
    "2. ⚠️ 禁止以「这本书很有名 / 这是常识 / 我记得书里大概讲过」为理由自行补充观点、"
    "案例、数据或人名。书里没有就写「书中未涉及」，不要用通识把它填满。\n"
    "3. 不伪造页码、引文、章节号、出版信息。引用原文只能用 highlights / thoughts 里的原话。\n"
    "4. 打比方帮助理解时，必须让读者看得出是比方，不能说成书里的原话。\n"
    "5. 只返回 JSON 对象，不要 Markdown 代码围栏，不要 JSON 之外的解释。\n"
)


_DIGEST_SCHEMA = (
    "【输出 JSON 字段】\n"
    "{\n"
    '  "thesis": "一句话主张：这本书到底在说什么。40~120 字，不堆术语，不写读后感。",\n'
    '  "spine": ["全书的逻辑主线，3~6 步，一步一句话，按顺序读完就是作者完整的论证链：'
    '第一步交代作者要回答的问题/处境，中间几步是主张与支撑主张的关键环节，'
    '最后一步落到结论或他给出的答案。**这是读者理解整本书的骨架，必须先于细节**"],\n'
    # ⚠️ **字段顺序不能随便调**：模型按顺序往下写，一旦 max_tokens 用尽，
    # 排在后面的字段就是第一批牺牲品（截断后由 `_close_truncated_json` 补括号，
    # 只救得回已经写完整的部分）。chapters 一本书动辄 20+ 章、最吃预算，
    # 所以**必须把「必答」的 critique 与 judgment 摆在 chapters 之前** ——
    # 它们是「收获」与「复述」的分界线，宁可少两章细节，也不能整节消失。
    # 渲染成文档时的小节顺序与此无关（由 `render_digest_markdown` 决定）。
    '  "critique": [{"claim": "书里的一个主张（逐字或贴近原话）",'
    ' "holds": "它在什么条件下成立",'
    ' "breaks": "什么情况下它站不住、或我没被说服的地方"}],\n'
    # 「我的判断」是这份文档的**心脏**，也是绝大多数读书模板都缺的一节：
    # 摘要是「作者说了什么」，判断才是「我因此怎么想」。缺了它，收获就只是一份
    # 更漂亮的复述。confidence 用 1~5，便于事后按把握程度回看（低置信度的先复看）。
    '  "judgment": {"verdict": "**我自己的判断**：这本书的说法我信几分 —— '
    '必须明确表态（信 / 只信其中一部分 / 不信），并点出信的是哪一部分",'
    ' "confidence": 1,'
    ' "why": "为什么这么判断：依据是什么（书里的哪条证据 / 我的经历 / 与其它书的对照）",'
    ' "when_not": "什么场景下我不会用它（适用边界，越具体越好）",'
    ' "open_questions": ["读完仍然没被回答的问题，0~3 条"]},\n'
    '  "chapters": [{"title": "章节标题（**必须逐字取自 payload.chapters 的 title**）",'
    ' "summary": "这一章讲了什么，60~150 字",'
    ' "key_points": ["这一章的要点，2~4 条"],'
    ' "takeaway": "这一章读完能拿走什么，一句话"}],\n'
    '  "core_arguments": [{"point": "核心论点（作者要你接受的那句话）",'
    ' "support": "书里怎么论证的（用了什么例子/推理）",'
    ' "where": "出自哪一章或哪条划线（认不出就空字符串）"}],\n'
    '  "models": [{"name": "可复用的模型/框架/概念名",'
    ' "what": "它是什么，一句话讲清",'
    ' "how_to_use": "什么场景下怎么用（要具体到能照着做）",'
    ' "where": "书里的出处"}],\n'
    '  "insights": [{"common_belief": "常见认知（大多数人会怎么想）",'
    ' "book_view": "书里给出的不同说法",'
    ' "why": "差在哪一步——为什么原来看法站不住"}],\n'
    '  "actions": ["可以马上用的行动或检查项（动词开头，一句话一条）"],\n'
    '  "quotes": [{"text": "原文金句（必须是 highlights 里的原话，一字不改）",'
    ' "where": "章节或位置"}],\n'
    '  "connections": [{"name": "关联的对象名（另一本书 / 一个知识点 / 用户的项目）",'
    ' "relation": "关系类型，只能填：支持 | 对立 | 细化 | 例证 | 因果 | 相关",'
    ' "note": "一句话说清**为什么**把它俩连起来"}],\n'
    '  "self_check": [{"question": "自测题（不给提示、不带答案线索）",'
    ' "answer": "答案要点（只写核对用的关键结论）"}],\n'
    '  "grounding": "依据说明：本份文档的哪些内容来自哪条划线或哪一章；'
    '书里没覆盖的地方要在这里点名。"\n'
    "}\n"
    "条数要求：spine 3~6 条；chapters **逐章展开，一章一条，顺序与 payload.chapters 完全一致**；"
    "core_arguments 2~6 条；models 1~5 条；insights 0~5 条；"
    "actions 2~8 条；quotes 0~8 条；connections 0~6 条；critique **至少 1 条**；self_check 2~4 条。\n"
    "⚠️ **critique 与 judgment 是必答项，不是选答**：\n"
    "① critique **至少一条**：一个主张的价值有一半在它的适用边界，只复述不设边界等于没读。"
    "材料确实不足以判断时，就写一条 claim = 书里最核心的主张，"
    "holds/breaks 写「现有材料不足以判断」—— **如实说不知道，但这一节必须有**。\n"
    "② judgment **必须表态**，而且要是**你自己的判断**，不是把作者的话换个说法："
    "confidence 是 1~5 的整数（1=基本不信，3=半信半疑，5=完全信服）；"
    "verdict 要能一句话讲清「信哪部分、不信哪部分」；"
    "when_not 要具体到场景（拿着它就能判断「现在该不该用」）。\n"
    "⚠️ **主动阅读的四个基本问题必须都答到**（这是「读懂一本书」的最低标准）：\n"
    "① 这本书整体在谈什么 → spine + thesis；\n"
    "② 细节说了什么、怎么说的 → chapters + core_arguments；\n"
    "③ **说得有道理吗？是全部有道理还是部分有道理？** → critique；\n"
    "④ **跟我有什么关系？** → models.how_to_use + actions。\n"
    "其中 ③ 最容易被漏掉，而它恰恰是「真读懂」与「只是复述」的分界 —— "
    "一个主张的价值有一半在它的**适用边界**。\n"
    "⚠️ connections 的 relation **必填**，且只能填给定的六种之一。"
    "「A 与 B 有关」这种不带理由的连接等于没连：半年后你想起不为什么把它们放一起，"
    "图谱也分不出「两本书互相印证」和「两本书互相打脸」—— 后者往往更值钱。\n"
    "⚠️ **深入浅出的硬要求（写成术语堆砌即判不合格）**：\n"
    "① 每一节先用**一句大白话**把话说明白，再展开细节；先用日常场景打底，再上专业名词；\n"
    "② 一个抽象说法出现后，**必须紧跟一个具体例子**（书里给的例子优先；书里没有例子，"
    "就用「比如……」造一个**标明是比方**的例子，绝不能把它说成书里的原话）；\n"
    "③ 禁止用「深刻」「赋能」「底层逻辑」这类**不承载信息的大词**充当解释 —— "
    "换成一个能验证的具体说法。\n"
    "⚠️ chapters 是这份文档的**主体**，不是附录。用户要的就是「每一章到底讲了什么」，"
    "所以只要 payload.chapters 里给了章，就必须**一章不落地写满**，"
    "summary 要有实质内容（不要写「本章介绍了…」这种空话），"
    "key_points 要落到具体观点上。\n"
    "⚠️ 某一章的材料确实太少（payload 里那一章既没有划线也没有摘录）时，"
    "该章的 summary 留空字符串，**不要用通识替它编内容** —— "
    "留空会被渲染成「本章材料不足」，比编一段像模像样的假摘要诚实得多。\n"
    "⚠️ 最重要的一条：**models 与 actions 是这份文档的主角**。"
    "用户读完一本书要的是「我能拿走什么、能用在哪」，"
    "所以 models 必须是**换个场景还能用**的框架，而不是书里的名词解释；"
    "actions 必须是**明天就能做**的动作，而不是「多读书」这类废话。\n"
    "insights 的写法：common_belief 先说大多数人（包括我）会怎么想，"
    "book_view 给书里的不同说法，why 必须指出**差在哪一步** —— "
    "只并列「别人说 A、书里说 B」是不够的，读者要知道自己刚才为什么想错。\n"
    "quotes 里的 text 必须是 highlights 里出现过的原话，一字不改；"
    "找不到能当金句的原话就给空数组，绝不自己编一句像金句的话。\n"
    "⚠️ 书里不足以支撑某一节时，**该节给空（空字符串或空数组）**，"
    "由系统决定如何呈现 —— 千万不要为了凑格式编内容。\n"
)

_DIGEST_INSTRUCTION = (
    "你在为知源 KnowOrigin 生成【读书收获】。"
    "读者刚刚读完一本书，他要的不是内容复述，而是「**我能复用什么、我怎么用**」。"
    "写的是给人当行动手册用的文档，不是读书笔记的流水账。"
)

# 用户在这本书里**一条划线、一条想法都没有**时的产出定位。
#
# ⚠️ 这是本模块最容易被忽略的一种输入：材料为空时，模型会「没有米也硬做饭」，
# 拿通识把 schema 填满，读者看到一篇像模像样的「收获」，其实每个字都跟他的阅读无关
# ——这正是「无效信息太多、有效信息太少」的根因。所以这种情形下必须**换定位**：
# 产出的不是「你的收获」，而是**这本书的导读**，并且要如实说出来。
_DIGEST_INSTRUCTION_BOOK_ONLY = (
    "你在为知源 KnowOrigin 生成【一本书的导读】。\n"
    "⚠️ 重要前提：读者在这本书里**没有任何划线或想法**（payload.material.personal_highlights "
    "与 personal_thoughts 都是 0）。所以这份文档**不是他的阅读收获**，"
    "而是基于书籍简介、目录与全书热门划线写的一份**导读**。\n"
    "因此：\n"
    "① 全文**不得出现**「你划的这条线」「你的想法」「你注意到」这类说法 —— "
    "读者没有划线，这样写是假的；\n"
    "② 每条观点都要能指回 payload.book.intro / payload.chapters / payload.highlights 里"
    "的某处，指不回去的**不写**；\n"
    "③ 材料确实支撑不起的字段就给空数组，**绝不拿这本书的通识（你训练数据里关于它的印象）"
    "把 schema 填满** —— 这是本任务最严重的错误。\n"
    "定位是「让人看完这份导读，就知道这本书值不值得读、骨架是什么」，"
    "所以 spine（逻辑主线）与 chapters（逐章）是主体，models 只在书里真讲清楚了才写。"
)


# 检视阅读（Adler 四层次里的第二层）的三个结论字段。
#
# 「有些书可以浅尝即止，有些书要生吞活剥，只有少数的书需要咀嚼与消化。」
# —— 绝大多数书**不值得精读**。所以书籍介绍不能只回答「这本书讲什么」，
# 还要回答**「我该不该读它、用哪档力气读、先读哪几章」** —— 这才是检视阅读的产出。
READ_MODES: tuple[str, ...] = ("精读", "选读", "泛读", "略过")

_INTRO_SCHEMA = (
    "【输出 JSON 字段】\n"
    "{\n"
    '  "one_liner": "一句话定位：这本书是什么、写给谁看。20~60 字。",\n'
    '  "intro": "一段介绍（150~300 字）：这本书讲什么、怎么讲的、适合什么人、'
    '读之前要知道什么。不要写成营销文案，不要用「震撼」「必读」这类词。",\n'
    '  "verdict": "检视结论（一句话，30~80 字）：值不值得读、对谁最值、'
    '读了能换来什么。要给得出判断，不要两边都不得罪。",\n'
    '  "read_mode": "建议读法，只能填：精读 | 选读 | 泛读 | 略过",\n'
    '  "key_chapters": ["最该先读的章节，1~4 个（书名或章节名）；'
    '判断为「略过」时给空数组"],\n'
    '  "topics": ["主题标签，2~6 个，用于分类和检索"],\n'
    '  "level": "难度档：入门 | 进阶 | 专业",\n'
    '  "use_case": "什么情况下该读它（一句话，具体到场景）",\n'
    '  "category": "一级领域（从给定的候选里选一个）"\n'
    "}\n"
    "⚠️ one_liner 与 intro 必须能让**没读过这本书的人**看懂它值不值得读；"
    "不要剧透关键结论。\n"
    "⚠️ read_mode 必须真的分档。**不是所有书都该精读** —— "
    "一本书只有少部分章节与你有关时，就该判「选读」并把那几章点出来；"
    "名气大但与你无关，就判「略过」。一律判「精读」等于没给判断。\n"
)

_INTRO_INSTRUCTION = (
    "你在为知源 KnowOrigin 生成【书籍介绍】。"
    "这段介绍会挂在书架每本书的封面下方，是用户决定「读不读它」的第一眼依据。"
    "基于书籍简介与用户自己的划线来写，不要复述营销语，不要编造书里没有的内容。"
)


# --------------------------------------------------------------------------
# Payload：交给模型的输入（纯函数，好测）
# --------------------------------------------------------------------------


def _clip(value: Any, limit: int) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if len(text) <= limit:
        return text
    return f"{text[: max(1, limit - 1)].rstrip()}…"


def _pick(item: Any, *names: str) -> str:
    """从一个 dict 或对象里取第一个非空的字符串字段。"""
    for name in names:
        if isinstance(item, dict):
            value = item.get(name)
        else:
            value = getattr(item, name, None)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _highlights(items: Iterable[Any], *, cap: int = MAX_HIGHLIGHTS) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for item in items:
        text = _pick(item, "mark_text", "text", "content", "highlight")
        if not text:
            continue
        out.append(
            {
                "text": _clip(text, _CLIP_HIGHLIGHT),
                "chapter": _clip(_pick(item, "chapter_name", "chapter", "chapter_title"), 40),
            }
        )
        if len(out) >= cap:
            break
    return out


def _thoughts(items: Iterable[Any], *, cap: int = MAX_THOUGHTS) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for item in items:
        text = _pick(item, "text", "content", "thought", "review")
        if not text:
            continue
        out.append(
            {
                "text": _clip(text, _CLIP_THOUGHT),
                "ref": _clip(_pick(item, "ref_text", "reference", "quote"), _CLIP_HIGHLIGHT),
            }
        )
        if len(out) >= cap:
            break
    return out


def _reviews(items: Iterable[Any], *, cap: int = MAX_REVIEWS) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for item in items:
        text = _pick(item, "content", "text", "review")
        if not text:
            continue
        out.append({"text": _clip(text, _CLIP_REVIEW)})
        if len(out) >= cap:
            break
    return out


def _chapter_payload(chapters: Iterable[Any], *, cap: int = MAX_CHAPTERS) -> list[dict[str, Any]]:
    """章节目录 + 每章已有的材料（划线 / 正文摘录）。

    调用方（``weread.py`` 或本地书解析）负责把材料**按章归好组**再传进来 ——
    这里只做形状归一与截断，不做分组判断（分组依赖具体书源的章节结构）。
    """
    out: list[dict[str, Any]] = []
    for item in list(chapters)[:cap]:
        if isinstance(item, str):
            item = {"title": item}
        if not isinstance(item, dict):
            continue
        title = _clip(item.get("title"), 120)
        if not title:
            continue
        notes = [_clip(n, _CLIP_HIGHLIGHT) for n in _as_list(item.get("highlights"))][:6]
        excerpt = _clip(item.get("excerpt"), 900)
        out.append({"title": title, "highlights": notes, "excerpt": excerpt})
    return out


def _as_list(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if isinstance(value, (list, tuple)):
        return [str(v).strip() for v in value if str(v or "").strip()]
    return []


def build_digest_payload(
    *,
    title: str,
    author: str = "",
    book_intro: str = "",
    highlights: Iterable[Any] = (),
    thoughts: Iterable[Any] = (),
    reviews: Iterable[Any] = (),
    progress: int = 0,
    chapters: Iterable[Any] = (),
    excerpts: Iterable[Any] = (),
) -> dict[str, Any]:
    """组装「读书收获」生成请求的 payload。纯函数，不碰数据库。

    划线 / 想法 / 点评 / 正文摘录都**必须截断** —— 一本书动辄上千条划线、
    几十万字正文，全塞进去只会让模型在中段丢指令，产出比少给几条更差。

    ``chapters`` 是**逐章展开的关键**：给了它，模型才会一章一章地写；
    不给的话它只能写一篇整体摘要（这正是「收获太少」的根因）。
    """
    chapters_payload = _chapter_payload(chapters)
    highlights_payload = _highlights(highlights)
    thoughts_payload = _thoughts(thoughts)
    reviews_payload = _reviews(reviews)
    excerpts_payload = [
        _clip(_pick(item, "text", "content", "mark_text"), _CLIP_HIGHLIGHT)
        for item in list(excerpts)[:40]
        if _pick(item, "text", "content", "mark_text")
    ]

    # 材料状态：模型必须知道「有没有用户自己的东西」，否则它会拿通识硬凑
    # （这正是「无效信息太多」的根因）。章节目录里带的热门划线也算材料，
    # 但它是**读者公认的**、不是**用户自己的**，所以两者分开计数。
    hot = sum(len(ch.get("highlights") or []) for ch in chapters_payload)
    material = {
        "personal_highlights": len(highlights_payload),
        "personal_thoughts": len(thoughts_payload),
        "reviews": len(reviews_payload),
        "hot_highlights": hot,
        "excerpts": len(excerpts_payload),
        "chapters": len(chapters_payload),
        "intro_chars": len(str(book_intro or "").strip()),
    }
    mode = digest_mode(material)

    return {
        "instruction": _DIGEST_INSTRUCTION if mode == "personal" else _DIGEST_INSTRUCTION_BOOK_ONLY,
        "mode": mode,
        "material": material,
        "book": {
            "title": str(title or "").strip(),
            "author": str(author or "").strip(),
            "intro": _clip(book_intro, _CLIP_INTRO),
            "progress": int(progress or 0),
        },
        "rules": RULES,
        "schema": _DIGEST_SCHEMA,
        "chapters": chapters_payload,
        "highlights": highlights_payload,
        "thoughts": thoughts_payload,
        "reviews": reviews_payload,
        "excerpts": excerpts_payload,
    }


def digest_mode(material: dict[str, Any]) -> str:
    """有用户自己的划线/想法 → ``personal``（读书收获）；一条都没有 → ``book``（书籍导读）。

    这两种情形的产出**定位不同**，不能共用一套指令 —— 详见 ``_DIGEST_INSTRUCTION_BOOK_ONLY``。
    """
    personal = int(material.get("personal_highlights") or 0) + int(
        material.get("personal_thoughts") or 0
    )
    return "personal" if personal > 0 else "book"


def digest_scope_note(material: dict[str, Any]) -> str:
    """无个人材料时，挂在文档最前面的如实声明。有个人材料则返回空串。

    这段话**由系统生成、不经模型**，所以不会被模型润色掉 ——
    它是「这份文档到底是什么」的最后一道诚实防线。
    """
    if digest_mode(material) != "book":
        return ""
    hot = int(material.get("hot_highlights") or 0)
    chapters = int(material.get("chapters") or 0)
    intro = int(material.get("intro_chars") or 0)
    basis: list[str] = []
    if intro:
        basis.append("书籍简介")
    if chapters:
        basis.append(f"{chapters} 章目录")
    if hot:
        basis.append(f"{hot} 条全书热门划线")
    basis_text = "、".join(basis) if basis else "书籍元信息"
    return (
        "你在本书里还没有任何划线或想法，所以这不是你的阅读收获，"
        f"而是依据{basis_text}整理的一份**书籍导读**。"
        "想让它变成「你的」收获：阅读时划几笔再回来重新生成，"
        "或把这本书的正文（EPUB / PDF / TXT）导入到它的项目里再生成。"
    )


def material_is_empty(material: dict[str, Any]) -> bool:
    """一点材料都没有 —— 简介、目录、划线、摘录**全空**。

    这种时候**不要调模型**：它没有可依据的东西，只会拿训练数据里对这本书的
    印象把 schema 填满 —— 产出一篇读起来像模像样、实则与这本书无关的文档。
    这正是「无效信息太多」最严重的一种。宁可如实说「材料不足」。
    """
    return not any(
        int(material.get(key) or 0) > 0
        for key in (
            "personal_highlights",
            "personal_thoughts",
            "reviews",
            "hot_highlights",
            "excerpts",
            "chapters",
            "intro_chars",
        )
    )


def build_insufficient_digest(*, title: str, material: dict[str, Any] | None = None) -> dict[str, Any]:
    """材料全空时的产出：**不编内容**，只说清楚为什么现在是空的、怎么才能有。"""
    return {
        "thesis": "",
        "spine": [],
        "chapters": [],
        "core_arguments": [],
        "models": [],
        "insights": [],
        "actions": [],
        "quotes": [],
        "connections": [],
        "critique": [],
        "judgment": {"verdict": "", "confidence": 0, "why": "", "when_not": "", "open_questions": []},
        "self_check": [],
        "grounding": (
            f"《{title}》目前没有任何可用于归纳的材料：这本书在微信读书里没有你的划线或想法，"
            "书籍简介与热门划线也没有取到（接口未返回）。"
            "为了不拿通识硬凑，本次没有生成内容。\n\n"
            "要让收获有东西可写，二选一：\n"
            "1. 去微信读书给这本书划几笔、写点想法，然后回到这里点「重新生成收获」；\n"
            "2. 把这本书的正文（EPUB / PDF / TXT）导入到它的项目里，再重新生成 —— "
            "导入的是**真全文**，收获会逐章展开。"
        ),
    }


def build_intro_payload(
    *,
    title: str,
    author: str = "",
    native_category: str = "",
    book_intro: str = "",
    highlights: Iterable[Any] = (),
    thoughts: Iterable[Any] = (),
    categories: Iterable[str] = CATEGORIES,
) -> dict[str, Any]:
    """组装「书籍介绍」生成请求的 payload。纯函数，不碰数据库。"""
    return {
        "instruction": _INTRO_INSTRUCTION,
        "book": {
            "title": str(title or "").strip(),
            "author": str(author or "").strip(),
            "native_category": str(native_category or "").strip(),
            "intro": _clip(book_intro, _CLIP_INTRO),
        },
        "rules": RULES,
        "schema": _INTRO_SCHEMA,
        "category_options": list(categories),
        "highlights": _highlights(highlights, cap=20),
        "thoughts": _thoughts(thoughts, cap=10),
    }


# --------------------------------------------------------------------------
# 归一化：逐字段校验（模型没写好的字段单独退回兜底）
# --------------------------------------------------------------------------


def _text(value: Any, limit: int) -> str:
    return _clip(value, limit) if isinstance(value, (str, int, float)) else ""


def _text_list(
    value: Any, *, limit: int, item_limit: int, min_len: int, strict: bool = True
) -> list[str]:
    """校验「字符串数组」型字段。``strict=False`` 用于兜底 —— 见 ``_dict_list``。"""
    if not isinstance(value, (list, tuple)):
        return []
    floor = min_len if strict else 1
    out: list[str] = []
    for item in value:
        text = _text(item, item_limit)
        if len(text) >= floor:
            out.append(text)
        if len(out) >= limit:
            break
    return out


def _dict_list(
    value: Any,
    *,
    limit: int,
    keys: tuple[tuple[str, int, int], ...],
    required: str,
    strict: bool = True,
) -> list[dict[str, str]]:
    """校验「对象数组」型字段。

    ``keys`` 里每项是 ``(键名, 截断长度, 最低字数)``。``required`` 指定的键
    不达标就整条丢弃 —— 一条连主字段都写不好的记录，留着只会占位。
    其余键不达标则降级成空字符串（例如 where 认不出章节本来就允许空）。

    ⚠️ ``strict=False`` 是给**本地兜底**用的，必须走这条宽松分支。
    兜底内容是我们自己拼的、可信的，若也用「模型成色门槛」去卡，
    一条 7 个字的兜底论点就会被 MIN_INSIGHT=8 静默吃掉 ——
    表现为「兜底明明写了，文档里却是空的」，且不报错，极难排查。
    宽松分支只做类型与截断，不做最低字数判定。
    """
    if not isinstance(value, (list, tuple)):
        return []
    out: list[dict[str, str]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        row: dict[str, str] = {}
        ok = True
        for key, limit, min_len in keys:
            text = _text(item.get(key), limit)
            floor = min_len if strict else 1
            if key == required and len(text) < floor:
                ok = False
                break
            row[key] = text if len(text) >= floor else ""
        if ok:
            out.append(row)
        if len(out) >= limit:
            break
    return out


# 各「对象数组」字段的形状定义。抽成常量是为了让「模型分支」与「兜底分支」
# 共用同一份定义 —— 两边写重了就会漂移，一处改了另一处忘改。
_ARG_KEYS = (("point", 160, MIN_ARGUMENT), ("support", 220, 0), ("where", 60, 0))
_MODEL_KEYS = (
    ("name", 60, 2),
    ("what", 160, MIN_MODEL_WHAT),
    ("how_to_use", 200, MIN_MODEL_USE),
    ("where", 60, 0),
)
_INSIGHT_KEYS = (
    ("common_belief", 160, MIN_INSIGHT),
    ("book_view", 200, MIN_INSIGHT),
    ("why", 200, 0),
)
_QUOTE_KEYS = (("text", 300, MIN_QUOTE), ("where", 60, 0))
# relation 是必填 —— 见 RELATIONS 的说明：不带理由的连接等于没连。
_CONNECTION_KEYS = (("name", 80, 2), ("relation", 12, 2), ("note", 160, MIN_CONNECTION))
# 「这本书说得有道理吗」—— 主动阅读的第三个基本问题。
# 一个模型的价值有一半在它的**适用边界**：知道它什么时候不成立，才叫真懂了。
_CRITIQUE_KEYS = (
    ("claim", 200, MIN_CRITIQUE),   # 书里的哪个主张
    ("holds", 200, 0),              # 它在什么条件下成立
    ("breaks", 220, 0),             # 什么情况下它站不住 / 我没被说服的地方
)
_CHECK_KEYS = (("question", 300, MIN_ARGUMENT), ("answer", 400, MIN_ANSWER))

# 字段名 → (形状定义, 主字段, 条数上限)。「模型分支」与「兜底分支」共用，
# 避免两边各写一份而漂移。
_FIELD_SPEC: dict[str, tuple[tuple[tuple[str, int, int], ...], str, int]] = {
    "core_arguments": (_ARG_KEYS, "point", MAX_ARGUMENTS),
    "models": (_MODEL_KEYS, "what", MAX_MODELS),
    "insights": (_INSIGHT_KEYS, "common_belief", MAX_INSIGHTS),
    "quotes": (_QUOTE_KEYS, "text", MAX_QUOTES),
    "connections": (_CONNECTION_KEYS, "name", MAX_CONNECTIONS),
    "critique": (_CRITIQUE_KEYS, "claim", MAX_CRITIQUES),
    "self_check": (_CHECK_KEYS, "question", MAX_SELF_CHECKS),
}


def _normalize_chapters(value: Any) -> list[dict[str, Any]]:
    """逐章校验。

    ⚠️ 与别的字段不同：**summary 为空的章节要保留，不能丢**。
    模型被要求「材料不足的章就留空」，如果我们把空章丢掉，
    用户看到的就是「这本书只有 5 章」而实际有 16 章 —— 缺的章静默消失，
    比显示「本章材料不足」糟得多。
    """
    if not isinstance(value, (list, tuple)):
        return []
    out: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        title = _text(item.get("title"), 120)
        if len(title) < 2:
            continue
        summary = _text(item.get("summary"), 500)
        takeaway = _text(item.get("takeaway"), 200)
        out.append(
            {
                "title": title,
                # 低于成色门槛视为「模型没写」→ 空串，渲染成「本章材料不足」
                "summary": summary if len(summary) >= MIN_CHAPTER_SUMMARY else "",
                "key_points": _text_list(
                    item.get("key_points"), limit=4, item_limit=200, min_len=4
                ),
                "takeaway": takeaway if len(takeaway) >= MIN_CHAPTER_TAKEAWAY else "",
            }
        )
        if len(out) >= MAX_CHAPTERS:
            break
    return out


def _pick_field(data: dict[str, Any], fb: dict[str, Any], key: str) -> list[dict[str, str]]:
    """先取模型结果（严格门槛），不达标再退回兜底（宽松门槛）。"""
    keys, required, limit = _FIELD_SPEC[key]
    return _dict_list(data.get(key), limit=limit, keys=keys, required=required) or _dict_list(
        fb.get(key), limit=limit, keys=keys, required=required, strict=False
    )


def _normalize_judgment(value: Any, fallback: Any = None) -> dict[str, Any]:
    """校验「我的判断」。

    形状固定为 ``{verdict, confidence, why, when_not, open_questions}``，
    **四个字段都可以为空**（材料不足时如实留空，绝不替用户编判断），
    但结构必须在 —— 渲染层与前端都按这个形状取值，缺键会让它们静默少渲染一节。
    ``confidence`` 夹到 1~5；模型给了 0 或 9 这种越界值就当没给（0 表示未表态）。
    """
    for source in (value, fallback):
        if not isinstance(source, dict):
            continue
        verdict = _text(source.get("verdict"), 300)
        why = _text(source.get("why"), 400)
        when_not = _text(source.get("when_not"), 300)
        questions = _text_list(
            source.get("open_questions"), limit=3, item_limit=200, min_len=4
        )
        try:
            confidence = int(source.get("confidence"))
        except Exception:
            confidence = 0
        if not 1 <= confidence <= 5:
            confidence = 0
        # 一句话都没表态、也没有任何其它内容 → 视为「模型没答」，交给更宽的兜底
        if len(verdict) < MIN_VERDICT and not (why or when_not or questions):
            continue
        return {
            "verdict": verdict if len(verdict) >= MIN_VERDICT else "",
            "confidence": confidence,
            "why": why if len(why) >= MIN_JUDGMENT_WHY else "",
            "when_not": when_not,
            "open_questions": questions,
        }
    return {"verdict": "", "confidence": 0, "why": "", "when_not": "", "open_questions": []}


def _pick_texts(
    data: dict[str, Any], fb: dict[str, Any], key: str, *, limit: int, item_limit: int, min_len: int
) -> list[str]:
    """字符串数组字段：先取模型结果（严格），不达标退回兜底（宽松）。"""
    return _text_list(
        data.get(key), limit=limit, item_limit=item_limit, min_len=min_len
    ) or _text_list(fb.get(key), limit=limit, item_limit=item_limit, min_len=min_len, strict=False)


def normalize_digest_result(raw: Any, fallback: dict[str, Any] | None = None) -> dict[str, Any]:
    """逐字段校验模型返回的读书收获。某个字段不达标就**只**退回该字段的兜底。

    兜底走宽松门槛（``strict=False``）—— 它是我们自己拼的可信内容，
    不该被「模型成色门槛」误伤。详见 ``_dict_list`` 的说明。
    """
    data = raw if isinstance(raw, dict) else {}
    fb = fallback or {}

    thesis = _text(data.get("thesis"), 200)
    if len(thesis) < MIN_THESIS:
        thesis = _text(fb.get("thesis"), 200)

    core_arguments = _pick_field(data, fb, "core_arguments")
    models = _pick_field(data, fb, "models")
    insights = _pick_field(data, fb, "insights")
    quotes = _pick_field(data, fb, "quotes")
    self_check = _pick_field(data, fb, "self_check")
    # 连接必须带上关系类型（Zettelkasten 的硬要求：说清为什么连）。
    connections = [
        {**row, "relation": normalize_relation(row.get("relation"))}
        for row in _pick_field(data, fb, "connections")
    ]
    critique = _pick_field(data, fb, "critique")

    actions = _pick_texts(
        data, fb, "actions", limit=MAX_ACTIONS, item_limit=160, min_len=MIN_ACTION
    )

    spine = _pick_texts(
        data, fb, "spine", limit=MAX_SPINE, item_limit=200, min_len=MIN_SPINE
    )

    chapters = _normalize_chapters(data.get("chapters")) or _normalize_chapters(fb.get("chapters"))
    judgment = _normalize_judgment(data.get("judgment"), fb.get("judgment"))

    grounding = _text(data.get("grounding"), 400) or _text(fb.get("grounding"), 400)

    return {
        "thesis": thesis,
        "spine": spine,
        "chapters": chapters,
        "core_arguments": core_arguments,
        "models": models,
        "insights": insights,
        "actions": actions,
        "quotes": quotes,
        "connections": connections,
        "critique": critique,
        "judgment": judgment,
        "self_check": self_check,
        "grounding": grounding,
    }


def normalize_intro_result(raw: Any, fallback: dict[str, Any] | None = None) -> dict[str, Any]:
    """逐字段校验模型返回的书籍介绍。"""
    data = raw if isinstance(raw, dict) else {}
    fb = fallback or {}

    one_liner = _text(data.get("one_liner"), 120)
    if len(one_liner) < MIN_ONE_LINER:
        one_liner = _text(fb.get("one_liner"), 120)

    intro = _text(data.get("intro"), 600)
    if len(intro) < MIN_INTRO:
        intro = _text(fb.get("intro"), 600)

    topics = _text_list(
        data.get("topics"), limit=MAX_TOPICS, item_limit=24, min_len=2
    ) or _text_list(fb.get("topics"), limit=MAX_TOPICS, item_limit=24, min_len=2)

    level = _text(data.get("level"), 8)
    if level not in ("入门", "进阶", "专业"):
        level = _text(fb.get("level"), 8)
    if level not in ("入门", "进阶", "专业"):
        level = ""

    use_case = _text(data.get("use_case"), 160) or _text(fb.get("use_case"), 160)

    # 检视阅读的三件套。read_mode 认不出就归「选读」——
    # 它比「精读」保守，不会把用户推去啃一本其实只需翻翻的书。
    verdict = _text(data.get("verdict"), 200) or _text(fb.get("verdict"), 200)
    read_mode = _text(data.get("read_mode"), 8)
    if read_mode not in READ_MODES:
        read_mode = _text(fb.get("read_mode"), 8)
    if read_mode not in READ_MODES:
        read_mode = "选读"
    key_chapters = _text_list(
        data.get("key_chapters"), limit=4, item_limit=80, min_len=2
    ) or _text_list(fb.get("key_chapters"), limit=4, item_limit=80, min_len=2)

    category = normalize_category(data.get("category"))
    if category == "其他" and fb.get("category"):
        category = normalize_category(fb.get("category"))

    return {
        "one_liner": one_liner,
        "intro": intro,
        "verdict": verdict,
        "read_mode": read_mode,
        "key_chapters": key_chapters,
        "topics": topics,
        "level": level,
        "use_case": use_case,
        "category": category,
    }


# --------------------------------------------------------------------------
# 本地兜底：模型不可用时，用**用户自己的划线/想法**拼一份诚实的最小文档。
# 兜底内容全部来自用户数据，不含任何模型生成的判断，因此不会"编"。
# --------------------------------------------------------------------------


def build_digest_fallback(
    *,
    title: str,
    highlights: Iterable[Any] = (),
    thoughts: Iterable[Any] = (),
) -> dict[str, Any]:
    """模型不可用时的本地兜底：只做「原样呈现」，不做任何归纳。

    刻意**不**生成 thesis / models / insights —— 那些需要理解，本地拼不出来，
    硬拼就是编造。这里只把用户自己的划线与想法摆好，并说明「本次未能生成总结」。
    """
    hl = _highlights(highlights, cap=MAX_QUOTES)
    th = _thoughts(thoughts, cap=MAX_QUOTES)
    quotes = [{"text": item["text"], "where": item.get("chapter", "")} for item in hl if item["text"]]
    actions = [f"重读这条划线：{item['text']}" for item in th if item["text"]]
    return {
        "thesis": "",
        "spine": [],
        "chapters": [],
        "core_arguments": [],
        "models": [],
        "insights": [],
        "actions": actions[:MAX_ACTIONS],
        "quotes": quotes[:MAX_QUOTES],
        "connections": [],
        "critique": [],
        "judgment": {"verdict": "", "confidence": 0, "why": "", "when_not": "", "open_questions": []},
        "self_check": [],
        "grounding": (
            f"《{title}》的总结本次未能生成（模型不可用）。"
            "下面呈现的是你自己在书里划的线与写的想法，未做任何归纳。"
        ),
    }


def build_intro_fallback(
    *,
    title: str,
    author: str = "",
    native_category: str = "",
    book_intro: str = "",
) -> dict[str, Any]:
    """模型不可用时的书籍介绍兜底：用书籍自带的简介，不编造评价。"""
    clean_intro = _clip(book_intro, 400)
    return {
        "one_liner": _clip(clean_intro, 120) or f"《{title}》",
        "intro": clean_intro,
        # 检视结论需要判断力，本地兜底**不编** —— 留给模型，或留给用户自己看目录。
        "verdict": "",
        "read_mode": "选读",
        "key_chapters": [],
        "topics": [],
        "level": "",
        "use_case": "",
        "category": guess_category(native_category=native_category, title=title),
    }


# --------------------------------------------------------------------------
# 渲染：结构化 JSON → 给人读的 Markdown
# --------------------------------------------------------------------------


_CN_NUM = "一二三四五六七八九十"


def _cn_number(index: int) -> str:
    """1 → 一，10 → 十，11 → 十一。只用到十几，不值得引库。"""
    if index <= 0:
        return ""
    if index <= 10:
        return _CN_NUM[index - 1]
    if index < 20:
        return "十" + _CN_NUM[index - 11]
    return str(index)


def _section(title: str, body: str, *, number: int = 0) -> str:
    if not body.strip():
        return ""
    head = f"{_cn_number(number)}、" if number > 0 else ""
    return f"## {head}{title}\n\n{body.strip()}\n"


def render_digest_markdown(
    result: dict[str, Any],
    *,
    title: str = "",
    author: str = "",
    scope_note: str = "",
    heading: str = "读书收获",
) -> str:
    """把校验过的结构化结果渲染成一份可读、可导出、可复用的 Markdown 文档。

    ⚠️ 正文小节的序号是**渲染时动态算的**，不写死在小节名里 ——
    小节会随材料有无而增删（例如没有 insights 就没有那一节），
    写死序号会让「自测」那节的锚点随材料变化而失效（卡片是永久数据，
    老卡片里的 ``origin_section`` 不会跟着改）。所以「自测」「依据说明」
    一律**不带序号**。

    ``scope_note`` 是**系统生成**的如实声明（见 ``digest_scope_note``）——
    无个人材料时它会挂在标题下，防止读者把「书籍导读」误当成自己的阅读收获。
    """
    head = f"# 《{title}》· {heading}\n" if title else f"# {heading}\n"
    if author:
        head += f"\n> {author}\n"
    if scope_note:
        # 用引用块而不是纯文本：它是一句**提醒**，不该被当成正文段落读过去。
        head += f"\n> ⚠️ {scope_note}\n"
    if result.get("thesis"):
        head += f"\n**一句话主张**：{result['thesis']}\n"

    parts: list[str] = [head]
    number = 0

    # 逻辑主线放**最前面**：读者要先拿到整本书的骨架，细节才有地方挂。
    # 这正是「没有逻辑框架」的对症药 —— 没有它，逐章精读就只是章节的堆叠。
    spine = result.get("spine") or []
    if spine:
        body = "\n".join(f"{i}. {step}" for i, step in enumerate(spine, start=1))
        number += 1
        parts.append(_section("全书逻辑主线", body, number=number))

    chapters = result.get("chapters") or []
    if chapters:
        number += 1
        blocks: list[str] = []
        for chapter in chapters:
            block = f"### {chapter.get('title') or '（未命名章节）'}"
            if chapter.get("summary"):
                block += f"\n\n{chapter['summary']}"
            else:
                # 模型被要求「材料不足就留空」—— 这里如实呈现，不替它编。
                block += "\n\n*本章材料不足（书里没有对应划线或摘录），未作归纳。*"
            points = chapter.get("key_points") or []
            if points:
                block += "\n\n" + "\n".join(f"- {p}" for p in points)
            if chapter.get("takeaway"):
                block += f"\n\n**拿走这一条**：{chapter['takeaway']}"
            blocks.append(block)
        parts.append(_section("逐章精读", "\n\n".join(blocks), number=number))

    args = result.get("core_arguments") or []
    if args:
        body = "\n".join(
            f"{i}. **{row['point']}**"
            + (f"\n   - 怎么论证的：{row['support']}" if row.get("support") else "")
            + (f"\n   - 出处：{row['where']}" if row.get("where") else "")
            for i, row in enumerate(args, start=1)
        )
        number += 1
        parts.append(_section("这本书在讲什么", body, number=number))

    models = result.get("models") or []
    if models:
        blocks = []
        for row in models:
            block = f"### {row.get('name') or '（未命名）'}\n\n{row.get('what', '')}"
            if row.get("how_to_use"):
                block += f"\n\n**怎么用**：{row['how_to_use']}"
            if row.get("where"):
                block += f"\n\n*出处：{row['where']}*"
            blocks.append(block)
        number += 1
        parts.append(_section("可以拿走的模型与框架", "\n\n".join(blocks), number=number))

    insights = result.get("insights") or []
    if insights:
        body = "\n\n".join(
            f"- **大多数人以为**：{row['common_belief']}\n"
            f"  **书里说**：{row['book_view']}"
            + (f"\n  **差在哪**：{row['why']}" if row.get("why") else "")
            for row in insights
        )
        number += 1
        parts.append(_section("反常识的地方", body, number=number))

    actions = result.get("actions") or []
    if actions:
        body = "\n".join(f"- [ ] {item}" for item in actions)
        number += 1
        parts.append(_section("明天就能用上的清单", body, number=number))

    quotes = result.get("quotes") or []
    if quotes:
        body = "\n\n".join(
            f"> {row['text']}" + (f"\n> —— {row['where']}" if row.get("where") else "")
            for row in quotes
        )
        number += 1
        parts.append(_section("值得留下的原话", body, number=number))

    # 「这本书说得有道理吗」—— 主动阅读的第三个基本问题。
    # 一个主张的价值有一半在它的**边界**：说清它什么时候不成立，才算真读懂了。
    critique = result.get("critique") or []
    if critique:
        body = "\n\n".join(
            f"- **书中的主张**：{row['claim']}"
            + (f"\n  **它在什么条件下成立**：{row['holds']}" if row.get("holds") else "")
            + (f"\n  **它站不住的地方**：{row['breaks']}" if row.get("breaks") else "")
            for row in critique
        )
        number += 1
        parts.append(_section("这本书说得有道理吗（边界与反例）", body, number=number))
    elif any(result.get(key) for key in ("thesis", "spine", "chapters", "core_arguments")):
        # 有材料却缺了边界与反例 —— **不能让它静默消失**：这一节是「真读懂」与
        # 「只是复述」的分界线，读者有权知道它缺了，也有个地方自己补一句。
        number += 1
        parts.append(_section(
            "这本书说得有道理吗（边界与反例）",
            "*本次生成没有给出边界与反例（可能是材料不足）。这一节是「读懂」与「复述」的分界，"
            "建议自己在下面「我的判断」里补一句：哪一条你没被说服，为什么。*",
            number=number,
        ))

    # 「我的判断」紧随「边界与反例」：先看作者的主张在哪站不住，再给出**自己的**表态。
    # 这两节合起来回答主动阅读的后两问（说得有道理吗 / 跟我有什么关系），
    # 而它们恰恰是绝大多数读书模板里没有的 —— 摘要是作者说了什么，判断才是我想了什么。
    judgment = result.get("judgment") or {}
    if isinstance(judgment, dict) and (
        judgment.get("verdict") or judgment.get("why")
        or judgment.get("when_not") or judgment.get("open_questions")
    ):
        confidence = int(judgment.get("confidence") or 0)
        lines: list[str] = []
        if judgment.get("verdict"):
            star = f"（把握 {confidence}/5）" if confidence else ""
            lines.append(f"**我的判断**{star}：{judgment['verdict']}")
        if judgment.get("why"):
            lines.append(f"**依据**：{judgment['why']}")
        if judgment.get("when_not"):
            lines.append(f"**什么情况下我不用它**：{judgment['when_not']}")
        if judgment.get("open_questions"):
            lines.append("**还没被回答的问题**：")
            lines.extend(f"- {q}" for q in judgment["open_questions"])
        number += 1
        parts.append(_section("我的判断（我自己怎么想）", "\n\n".join(lines), number=number))
    elif any(result.get(key) for key in ("thesis", "spine", "chapters", "core_arguments")):
        # 有材料却没给出自己的判断 → 同样不能静默消失。这一节是**留给人写的**，
        # 与其让读者以为「收获就这些」，不如把空位和该填什么直接摆在他面前。
        number += 1
        parts.append(_section(
            "我的判断（我自己怎么想）",
            "*本次生成没有给出你的判断（或材料不足以判断）。这一节本该由你自己填，"
            "三个问题就够：① 这本书的说法你信几分？② 凭什么信（或不信）？"
            "③ 什么场景下你不会用它？*",
            number=number,
        ))

    connections = result.get("connections") or []
    if connections:
        body = "\n".join(
            f"- **{row['name']}**（{row.get('relation') or '相关'}） —— {row.get('note', '')}"
            for row in connections
        )
        number += 1
        parts.append(_section("和我的知识库的联系", body, number=number))

    checks = result.get("self_check") or []
    if checks:
        # ⚠️ 刻意**不用** <details>：正文是 contenteditable 的，保存时要把 DOM 反写回
        # Markdown。折叠块反写不回去（会把答案挤成一行或整段丢失），
        # 用户改一次文档，自测题就烂掉了。用「小标题 + 段落」这种最朴素的块，
        # 反写才无损。
        body = "\n\n".join(
            f"### 自测 {i}\n\n{row['question']}"
            + (f"\n\n**核对**：{row['answer']}" if row.get("answer") else "")
            for i, row in enumerate(checks, start=1)
        )
        parts.append(_section(DIGEST_SELF_CHECK_SECTION, body))

    if result.get("grounding"):
        parts.append(_section("依据说明", result["grounding"]))

    return "\n".join(part for part in parts if part.strip())


def render_intro_markdown(result: dict[str, Any], *, title: str = "") -> str:
    """把书籍介绍渲染成 Markdown（用于导出 / 纯文本场景）。"""
    lines: list[str] = []
    if title:
        lines.append(f"# 《{title}》")
    if result.get("one_liner"):
        lines.append(f"\n{result['one_liner']}")
    if result.get("intro"):
        lines.append(f"\n{result['intro']}")
    meta: list[str] = []
    if result.get("category"):
        meta.append(f"分类：{result['category']}")
    if result.get("read_mode"):
        meta.append(f"建议读法：{result['read_mode']}")
    if result.get("level"):
        meta.append(f"难度：{result['level']}")
    if result.get("topics"):
        meta.append("标签：" + "、".join(result["topics"]))
    if meta:
        lines.append("\n" + " · ".join(meta))
    if result.get("use_case"):
        lines.append(f"\n**什么时候读**：{result['use_case']}")
    # 检视结论放在最后 —— 它是「读不读、怎么读」的判断，读者看完介绍正好要它。
    if result.get("verdict"):
        lines.append(f"\n**检视结论**：{result['verdict']}")
    if result.get("key_chapters"):
        lines.append("\n**先读这几处**：" + "、".join(result["key_chapters"]))
    return "\n".join(lines)


def digest_has_content(result: dict[str, Any]) -> bool:
    """这份收获文档是不是真的产出了东西（而不是一堆空数组）。"""
    judgment = result.get("judgment")
    return bool(
        result.get("thesis")
        or result.get("spine")
        or result.get("chapters")
        or result.get("models")
        or result.get("core_arguments")
        or result.get("actions")
        or result.get("quotes")
        # 「我的判断」也算产出：一份只有判断没有框架的文档，仍然是用户在思考的证据
        or (isinstance(judgment, dict) and (judgment.get("verdict") or judgment.get("why")))
    )


def sync_origin_section_exists(markdown: str) -> bool:
    """渲染出的正文里是否真的有「自测」那一节（卡片回流卡片的出处锚点）。

    把「标题存在」变成一条可跑的断言：渲染层改了标题而忘了改
    ``DIGEST_SELF_CHECK_SECTION`` 时，测试立刻红，而不是等用户点「回到文档」发现原地不动。
    """
    wanted = DIGEST_SELF_CHECK_SECTION.replace(" ", "")
    if not wanted:
        return False
    for line in str(markdown or "").splitlines():
        stripped = line.strip()
        if stripped.startswith("#") and stripped.lstrip("#").strip().replace(" ", "") == wanted:
            return True
    return False


# --------------------------------------------------------------------------
# 选中 → AI 辅助阅读讨论（读书页划词提问）
# --------------------------------------------------------------------------
#
# 与「文档内提问」（core/knowledge_doc.build_ask_payload）同形不同神：
# 那边锚点是**框架节点**，材料是课程资料；这边锚点是**读者选中的那一句**，
# 材料是这一段所在的上下文（收获正文 / 检视结论 / 精华阅读的划线 / 正文预览）。
#
# 口径与「文档内提问」**刻意相反**（2026-10-08 改）：那边默认守材料边界，
# 这边要的是**陪读讨论** —— 读者选中一段，是来聊开、来被带着往外走的，
# 不是来查这一段的标准释义。所以本任务的默认档就是**发散档**：
# 先贴着书用两三句说清「这段在说什么」，再放开往别的书 / 别的学科 / 现实案例 /
# 反方 / 极端情形 / 思想实验 / 读者经验上铺开，方向越多越好。
# 唯一的红线没变，只是**收窄到「书里说了什么」这一层**：不许把书外联想
# 伪装成书里的内容 —— 发散必须自报家门（「书里没写，我联想到…」），
# 不许编造书名、页码、作者原话、文献与数值。

ASK_MAX_SELECTION = 1200      # 选区：放得下一整段原文
ASK_MAX_CONTEXT = 6000        # 上下文：选区所在那一块
ASK_MAX_HISTORY = 3           # 多轮只带最近 3 轮，够承接又不把上下文挤掉
ASK_MAX_HISTORY_ANSWER = 500

# 陪读讨论要的是**联想宽度**，不是唯一解 —— 默认 0.2 的采样温度会让模型把发散
# 收敛成一段四平八稳的复述。给到 0.8：既明显更敢连，又不至于语无伦次。
READING_ASK_TEMPERATURE = 0.8

READING_ASK_SYSTEM = (
    "你是知源 KnowOrigin 的【读书陪读讨论伙伴】。读者正读着一本书，选中了其中一段，"
    "想就这一段跟你聊开 —— 他要的不是词典释义，是**思想被带着往外走**。\n"
    "⚠️ 读者给的明确要求：**不要只围着这段材料打转，发散思维，越发散越好。**\n"
    "按两层来答：\n"
    "① 先贴着书（短）：用两三句直接回应读者的问题，点明这段在说什么、依据是原文哪一句；"
    "引用必须逐字来自 payload.selection / payload.context。\n"
    "② 再往外发散（长，这是重点）：把这一段接到更大的世界里 —— 往别的书、别的学科、"
    "历史与现实中的例子、类比与隐喻、反方立场、极端情形与思想实验、作者没说却值得想的"
    "前提、以及读者自己的生活经验上铺开。**至少铺 3 个互不相同的方向**，"
    "能连多远就连多远，不必收敛到某个「标准答案」。\n"
    "唯一的红线：别让发散冒充书里的内容 —— 凡属书外延伸，就明说「书里没写，我联想到…」；"
    "不编造书名、页码、作者原话、文献、链接、数值，没把握就说不确定。\n"
    "结尾留 2~3 个能把讨论继续往下拽的问题，最好是读者自己想不到的角度。\n"
    "默认 300~700 字；读者要求展开时放开写。宁可多给几个方向，也不要只把原文换个说法。\n"
    "直接输出 Markdown 正文：不要 JSON、不要代码围栏、不要「好问题」这类客套。"
)

ASK_RULES = (
    "【讨论铁律 —— 违反任何一条这次回答都算不合格】\n"
    "1. 先回应读者的问题，再发散；不复述问题，不写「好问题」这类客套。\n"
    "2. 「书里说了什么」只依据 payload.selection 与 payload.context；引用原文必须是材料里"
    "逐字出现的句子；材料里没写的，不要假装书里写了。\n"
    "3. 「你的发散」放开想、放开连：书外延伸必须自报家门（明说这是书外的联想或推断），"
    "绝不与书里的结论混成一段、更不许借书的名义说。\n"
    "4. 发散是本任务的主线：至少 3 个互不相同的方向（别的书 / 别的学科 / 现实案例 / "
    "反方立场 / 极端情形 / 思想实验 / 读者经验 …），越开阔越好，不要收敛。\n"
    "5. 不许编造书名、页码、作者原话、文献、链接、数值；没把握就直说不确定。\n"
)


def _clip_ask(value: Any, limit: int) -> str:
    """多行文本截断，**保留换行**（正文片段糊成一行，模型就引不准原句）。"""
    text = str(value or "").strip()
    if len(text) <= limit:
        return text
    return text[: max(1, limit - 1)].rstrip() + "…"


def build_reading_ask_payload(
    *,
    question: str,
    selection: str = "",
    context: str = "",
    book: Any = None,
    history: Iterable[Any] = (),
) -> dict[str, Any]:
    """组装「就这一段讨论」的输入。纯函数，不碰数据库。"""
    rows: list[dict[str, str]] = []
    for item in list(history)[-ASK_MAX_HISTORY:]:
        if not isinstance(item, dict):
            continue
        pair = {
            "question": _clip_ask(item.get("question") or item.get("q"), 300),
            "answer": _clip_ask(item.get("answer") or item.get("a"), ASK_MAX_HISTORY_ANSWER),
        }
        if pair["question"]:
            rows.append(pair)
    title = ""
    author = ""
    if isinstance(book, dict):
        title = str(book.get("title") or "")
        author = str(book.get("author") or "")
    return {
        "book": {"title": title[:120], "author": author[:80]},
        "selection": _clip_ask(selection, ASK_MAX_SELECTION),
        "context": _clip_ask(context, ASK_MAX_CONTEXT),
        "question": _clip_ask(question, 300),
        "history": rows,
        "rules": ASK_RULES,
    }


def ask_needs_material(payload: dict[str, Any]) -> bool:
    """这次提问有没有可依据的材料。没有就得早退，别让模型凭印象编一段。"""
    return bool(str(payload.get("selection") or "").strip() or str(payload.get("context") or "").strip())
