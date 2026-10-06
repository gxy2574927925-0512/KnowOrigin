"""知源 · 六级写作与翻译提分引擎（core/english_writing.py）

把主流公开课与学习博主反复讲的六级写作、翻译提分技巧，落成一套**不依赖模型**的
规则引擎：评分标准速查、三段式模板骨架、高分功能句型、基础词升级词库、过渡词库、
中式英语纠错、翻译三步法引导、文化负载词标准译法。

设计原则：
  - 纯规则、可解释、可离线。每条建议都指得出「命中哪条规则、对应原文哪一句」，
    不给用户一句无法追溯的玄学点评。
  - 只搭脚手架，不代写。给骨架、句型、纠错，具体内容仍由用户自己填。
  - 与 core/english_exam.py 平级：那边管「读」（精读/长难句/同义替换/熟词生义），
    这边管「写与译」（输出端）。

术语沿用四六级公开评分口径：写作 15 分制（报道分 212），翻译 15 分制（报道分 212）。
"""

from __future__ import annotations

import random
import re
from typing import Any

# ============================================================================
# 一、评分标准速查
# ============================================================================

WRITING_RUBRIC: dict[str, Any] = {
    "kind": "writing",
    "full_score": 15,
    "reported_score": 212,
    "weight": "占全卷 30%",
    "time_minutes": 30,
    "word_min": 150,
    "word_max": 200,
    "word_rule": "要求 150–200 词；140–149 词扣 1 分，130–139 词扣 2 分，130 词以下酌情重扣。",
    "bands": [
        {"band": "13–15 分", "label": "优秀", "desc": "切题，表达思想清楚，文字通顺、连贯，基本无语言错误，仅个别小错。"},
        {"band": "10–12 分", "label": "良好", "desc": "切题，表达思想清楚，文字较连贯，但有少量语言错误。"},
        {"band": "7–9 分", "label": "及格", "desc": "基本切题，有些地方表达不够清楚，文字勉强连贯，语言错误相当多，含少量严重错误。"},
        {"band": "4–6 分", "label": "较差", "desc": "基本切题，表达不清楚，连贯性差，有较多严重语言错误。"},
        {"band": "1–3 分", "label": "差", "desc": "条理不清，思路紊乱，语言支离破碎或多数句子有错，且多为严重错误。"},
    ],
    "deductions": [
        "跑题 / 偏题：未回应题目核心关键词，直接落档处理，是最致命的一条。",
        "字数不足：140–149 词扣 1 分；130–139 词扣 2 分。",
        "语法错误：时态混乱、主谓不一致、冠词遗漏等严重错误，每 3–5 处扣 1 分。",
        "拼写错误：按累计数量扣分，同一词重复错不重复计。",
        "结构缺失：只有一段、或没有明确的观点句与结论，判为条理不清。",
    ],
    "time_plan": [
        {"stage": "0–5 分钟", "task": "审题列提纲", "detail": "圈出题目关键词，定中心论点，写 2 个分论点 + 每个分论点 1 个例子关键词。只写关键词，不写完整句。"},
        {"stage": "5–25 分钟", "task": "正式写作", "detail": "开篇 40–50 词 → 两个主体段各 60–70 词 → 结尾 20–30 词。"},
        {"stage": "25–30 分钟", "task": "检查", "detail": "查拼写、主谓一致、时态、冠词、过渡词。不要在这 5 分钟里大幅改内容，容易越改越乱。"},
    ],
}

TRANSLATION_RUBRIC: dict[str, Any] = {
    "kind": "translation",
    "full_score": 15,
    "reported_score": 212,
    "weight": "占全卷 15%",
    "time_minutes": 30,
    "text_length": "180–200 个汉字的一段话",
    "topics": "中国历史、文化、经济、社会发展、科技、教育、地理。",
    "bands": [
        {"band": "13–15 分", "label": "优秀", "desc": "译文准确、通顺，基本无语言错误，句式与用词地道。"},
        {"band": "10–12 分", "label": "良好", "desc": "译文基本准确、通顺，有少量语言错误。"},
        {"band": "7–9 分", "label": "及格", "desc": "译文勉强准确、勉强通顺，语言错误较多。"},
        {"band": "4–6 分", "label": "较差", "desc": "译文不够准确，连贯性差，有较多严重语言错误。"},
        {"band": "1–3 分", "label": "差", "desc": "译文支离破碎，严重错误多，未能表达原意。"},
    ],
    "key_points": [
        "修饰后置：中文的定语、状语习惯前置，英语要按习惯后置。",
        "多动句：中文一句话连用多个动词，英语只能留一个谓语，其余降为分词、不定式或从句。",
        "无主句：主语不是人时，英语常转被动语态。",
        "扣分重点：定冠词、单复数、介词、时态。",
    ],
    "deductions": [
        "先定档再扣分：整体表达先落一个分数档，再按语法/用词/拼写错误逐项扣。",
        "定冠词、单复数、介词、时态是四个最密集的扣分点，写完先查这四项。",
        "专有名词不大写（silk road → the Silk Road）属于低级失分，必查。",
        "文化负载词漏译或译错，直接判为未表达原意。",
    ],
}

# ============================================================================
# 二、三段式模板骨架（三类题型）
# ============================================================================

WRITING_TEMPLATES: list[dict[str, Any]] = [
    {
        "id": "tpl_phenomenon",
        "name": "现象解释型",
        "alias": "议论 · 现象 + 成因 + 影响",
        "when": "题目给一个社会现象，问你如何看待 / 为什么 / 会怎样。",
        "segments": [
            {
                "para": "开篇段",
                "words": "40–50 词",
                "role": "描述现象 + 亮明立场",
                "points": [
                    "第一句直接切题，不要用「随着社会的发展」开头。",
                    "第二句给出你的态度：积极 / 消极 / 需理性看待。",
                ],
                "sentences": [
                    "The issue of ______ has sparked considerable debate in recent years.",
                    "From my perspective, ______, and this essay will explain why.",
                ],
            },
            {
                "para": "主体段一",
                "words": "60–70 词",
                "role": "成因分析（个人 / 社会 / 技术三维度）",
                "points": [
                    "观点句 → 解释句 → 例子句 → 分析句 → 扣回句，五句成段。",
                    "三个维度里挑两个写透，比三个都点到更划算。",
                ],
                "sentences": [
                    "The fundamental cause of ______ lies in ______.",
                    "A case in point is that ______.",
                    "Therefore, ______.",
                ],
            },
            {
                "para": "主体段二",
                "words": "60–70 词",
                "role": "影响总结（正面 / 负面 / 长远）",
                "points": [
                    "与主体段一的分论点必须并列，不能重复。",
                    "用 In contrast / Moreover 明确两段之间的逻辑关系。",
                ],
                "sentences": [
                    "Moreover, ______ exerts a profound influence on ______.",
                    "This is because ______.",
                    "In other words, ______.",
                ],
            },
            {
                "para": "结尾段",
                "words": "20–30 词",
                "role": "重申观点 + 建议 / 展望",
                "points": [
                    "重申观点，不引入新论点。",
                    "用 Only by doing so can we... 这类倒装收尾，句式上拿一点分。",
                ],
                "sentences": [
                    "In conclusion, ______.",
                    "Only by doing so can we ______.",
                ],
            },
        ],
    },
    {
        "id": "tpl_contrast",
        "name": "观点对比型",
        "alias": "议论 · 观点 A + 观点 B + 辩证升华",
        "when": "题目给出两种对立看法，问你更赞同哪一种 / 如何看待分歧。",
        "segments": [
            {
                "para": "开篇段",
                "words": "40–50 词",
                "role": "呈现分歧 + 表明立场",
                "points": [
                    "先客观复述双方争议点，避免一上来就站队显得单薄。",
                    "立场可以是「辩证折中」，但必须明确，不能和稀泥。",
                ],
                "sentences": [
                    "While some argue that ______, I believe that ______.",
                    "This essay will discuss the reasons behind this view.",
                ],
            },
            {
                "para": "主体段一",
                "words": "60–70 词",
                "role": "观点 A 的合理之处",
                "points": ["先承认对方观点的合理性，是拿「连贯」分的关键一步。"],
                "sentences": [
                    "Admittedly, ______.",
                    "Those who hold this view point out that ______.",
                ],
            },
            {
                "para": "主体段二",
                "words": "60–70 词",
                "role": "观点 B 的合理性 + 我的理由",
                "points": ["用 Conversely / On the other hand 明确转折，避免读者以为你两边都同意。"],
                "sentences": [
                    "Conversely, ______.",
                    "A balanced approach, however, would be to ______.",
                ],
            },
            {
                "para": "结尾段",
                "words": "20–30 词",
                "role": "辩证升华",
                "points": ["给出可操作的态度或建议，收束全文。"],
                "sentences": [
                    "In conclusion, a balanced approach should be adopted to ______.",
                    "Only in this way can we ______.",
                ],
            },
        ],
    },
    {
        "id": "tpl_quote",
        "name": "名言评论型",
        "alias": "议论 · 阐释名言 + 分层论证 + 联系实际",
        "when": "题目给出一句名言或谚语，让你评论。",
        "segments": [
            {
                "para": "开篇段",
                "words": "40–50 词",
                "role": "阐释名言 + 提炼观点",
                "points": ["先把名言翻译或转述一遍，再点出它讲的道理，避免直接论证显得突兀。"],
                "sentences": [
                    "The saying offers a timeless piece of wisdom about ______.",
                    "In other words, it reminds us that ______.",
                ],
            },
            {
                "para": "主体段一",
                "words": "60–70 词",
                "role": "第一层论证（个人层面）",
                "points": ["用具体例子支撑，不要只讲抽象道理。"],
                "sentences": [
                    "The validity of this view can be confirmed by ______.",
                    "For instance, ______.",
                ],
            },
            {
                "para": "主体段二",
                "words": "60–70 词",
                "role": "第二层论证（社会 / 时代层面）",
                "points": ["把道理从个人放大到社会，层次就出来了。"],
                "sentences": [
                    "At a broader level, ______.",
                    "This example shows that ______.",
                ],
            },
            {
                "para": "结尾段",
                "words": "20–30 词",
                "role": "联系实际践行",
                "points": ["落到「我们该怎么做」，让文章有现实落点。"],
                "sentences": [
                    "Embracing this philosophy will enable us to ______.",
                    "It is high time that we ______.",
                ],
            },
        ],
    },
]

# ============================================================================
# 三、高分功能句型库（按功能分类，可直接插入作文）
# ============================================================================

SENTENCE_BANK: list[dict[str, Any]] = [
    {
        "group": "开篇引入",
        "items": [
            {"en": "The issue of ______ has sparked considerable debate in recent years.", "zh": "近年来，______ 这一话题引发了广泛讨论。", "note": "直接切入，替代 with the development of society"},
            {"en": "While some argue that ______, I believe that ______.", "zh": "尽管有人认为 ______，我认为 ______。", "note": "观点对比型的万能开篇"},
            {"en": "The saying offers a timeless piece of wisdom about ______.", "zh": "这句名言道出了关于 ______ 的永恒智慧。", "note": "名言评论型开篇"},
            {"en": "Recent years have witnessed a dramatic shift in ______.", "zh": "近年来 ______ 发生了剧变。", "note": "无灵主语，比 people have changed 高级"},
        ],
    },
    {
        "group": "原因分析",
        "items": [
            {"en": "The fundamental cause of ______ lies in ______.", "zh": "______ 的根本原因在于 ______。", "note": "主体段首句，引出成因"},
            {"en": "Several factors contribute to this phenomenon, among which ______ is the most critical.", "zh": "多个因素造成了这一现象，其中 ______ 最为关键。", "note": "多因并列时用"},
            {"en": "This can be attributed to the fact that ______.", "zh": "这可以归因于 ______ 这一事实。", "note": "比 because 更书面"},
        ],
    },
    {
        "group": "举例论证",
        "items": [
            {"en": "A case in point is that ______.", "zh": "一个恰当的例子是 ______。", "note": "替代 for example"},
            {"en": "Take ______ as an example.", "zh": "以 ______ 为例。", "note": "简洁引出例子"},
            {"en": "This is well illustrated by ______.", "zh": "______ 很好地说明了这一点。", "note": "被动式，句式变化"},
        ],
    },
    {
        "group": "对比转折",
        "items": [
            {"en": "Conversely, ______.", "zh": "相反，______。", "note": "观点对比型主体段二"},
            {"en": "Admittedly, ______; however, ______.", "zh": "诚然，______；然而，______。", "note": "先让步再转折，连贯分拉满"},
            {"en": "On the contrary, ______.", "zh": "恰恰相反，______。", "note": "强转折"},
        ],
    },
    {
        "group": "递进补充",
        "items": [
            {"en": "Moreover, ______ exerts a profound influence on ______.", "zh": "此外，______ 对 ______ 产生了深远影响。", "note": "主体段二首句"},
            {"en": "What is more, ______.", "zh": "更重要的是，______。", "note": "口语感弱、书面感强的递进"},
            {"en": "In addition to ______, ______ also plays a crucial role.", "zh": "除了 ______，______ 也起着关键作用。", "note": "补充第二个分论点"},
        ],
    },
    {
        "group": "结论收尾",
        "items": [
            {"en": "In conclusion, ______.", "zh": "总之，______。", "note": "最稳的结论开头"},
            {"en": "Only by doing so can we ______.", "zh": "只有这样我们才能 ______。", "note": "倒装收尾，句式加分"},
            {"en": "It is high time that we ______.", "zh": "是时候我们 ______ 了。", "note": "虚拟语气，注意从句用过去式"},
            {"en": "A balanced approach should be adopted to ______.", "zh": "应采取平衡的方式去 ______。", "note": "辩证升华收尾"},
        ],
    },
]

# ============================================================================
# 四、基础词 → 高级词升级词库
# ============================================================================

UPGRADE_WORDS: list[dict[str, Any]] = [
    {"basic": "important", "upgrades": ["crucial", "vital", "significant", "essential", "indispensable"],
     "example": "Education plays a crucial role in personal development."},
    {"basic": "good", "upgrades": ["beneficial", "favorable", "rewarding", "commendable"],
     "example": "Regular exercise is beneficial to both physical and mental health."},
    {"basic": "bad", "upgrades": ["detrimental", "adverse", "undesirable", "harmful"],
     "example": "Excessive screen time is detrimental to children's eyesight."},
    {"basic": "very", "upgrades": ["extremely", "exceedingly", "remarkably"],
     "example": "The results are extremely significant."},
    {"basic": "many", "upgrades": ["numerous", "a multitude of", "a considerable number of"],
     "example": "Numerous studies have confirmed this trend."},
    {"basic": "help", "upgrades": ["facilitate", "contribute to", "give impetus to"],
     "example": "Education contributes to social mobility."},
    {"basic": "solve", "upgrades": ["address", "tackle", "remedy"],
     "example": "We should address the problem rationally."},
    {"basic": "get", "upgrades": ["obtain", "acquire", "attain"],
     "example": "Students can acquire practical skills through internships."},
    {"basic": "show", "upgrades": ["demonstrate", "illustrate", "reveal"],
     "example": "The data demonstrate a clear upward trend."},
    {"basic": "think", "upgrades": ["maintain", "hold the view that", "be convinced that"],
     "example": "I maintain that hard work outweighs talent."},
    {"basic": "because of", "upgrades": ["owing to", "on account of", "by virtue of"],
     "example": "Owing to the policy, enrollment rose sharply."},
    {"basic": "pay attention to", "upgrades": ["attach great importance to", "lay emphasis on"],
     "example": "We should attach great importance to environmental protection."},
    {"basic": "more and more", "upgrades": ["increasingly", "a growing number of"],
     "example": "Online education is gaining growing popularity among young people."},
    {"basic": "in my opinion", "upgrades": ["from my perspective", "as far as I am concerned"],
     "example": "From my perspective, the benefits outweigh the drawbacks."},
    {"basic": "a lot of", "upgrades": ["a considerable amount of", "an abundance of"],
     "example": "The project consumed an abundance of resources."},
    {"basic": "difficult", "upgrades": ["challenging", "formidable", "demanding"],
     "example": "The task proved rather challenging for freshmen."},
    {"basic": "change", "upgrades": ["transform", "alter", "reshape"],
     "example": "Digital technology has reshaped the way we work."},
    {"basic": "make efforts to", "upgrades": ["strive to", "spare no effort to"],
     "example": "We should strive to bridge the digital divide."},
    {"basic": "face challenges", "upgrades": ["be confronted with challenges", "grapple with difficulties"],
     "example": "Graduates are confronted with fierce competition."},
    {"basic": "widely acknowledged", "upgrades": ["it is widely acknowledged that", "there is a broad consensus that"],
     "example": "It is widely acknowledged that reading broadens the mind."},
    {"basic": "popular", "upgrades": ["increasingly popular", "gain growing popularity"],
     "example": "Short videos have gained growing popularity among teenagers."},
    {"basic": "improve", "upgrades": ["enhance", "optimize", "boost"],
     "example": "Reading extensively can enhance one's language proficiency."},
]

# ============================================================================
# 五、过渡词库（按逻辑关系分类）
# ============================================================================

TRANSITIONS: list[dict[str, Any]] = [
    {"type": "引出话题", "words": ["Recently", "In recent years", "Nowadays", "With the advent of"]},
    {"type": "并列递进", "words": ["Moreover", "Furthermore", "In addition", "What is more", "Besides"]},
    {"type": "转折对比", "words": ["However", "Nevertheless", "Conversely", "On the contrary", "In contrast"]},
    {"type": "让步", "words": ["Admittedly", "Although", "Even though", "While it is true that"]},
    {"type": "因果", "words": ["Therefore", "Consequently", "As a result", "Thus", "Hence"]},
    {"type": "举例", "words": ["For instance", "For example", "A case in point is", "Take ... as an example"]},
    {"type": "总结", "words": ["In conclusion", "To sum up", "In brief", "All things considered"]},
    {"type": "强调", "words": ["Indeed", "In particular", "Above all", "It is worth noting that"]},
]

# ============================================================================
# 六、中式英语 / 高频语法错误纠错规则
# ============================================================================

CHINGLISH_RULES: list[dict[str, Any]] = [
    {
        "id": "because_so",
        "pattern": r"\bbecause\b[^.!?]{0,120}?\bso\b",
        "bad": "Because ... , so ...",
        "fix": "Because ..., ...（去掉 so）",
        "why": "because 与 so 不能连用，英语里一个因果只能有一个连接词。",
    },
    {
        "id": "although_but",
        "pattern": r"\b(although|though)\b[^.!?]{0,120}?\bbut\b",
        "bad": "Although ... , but ...",
        "fix": "Although ..., ...（去掉 but）",
        "why": "although 与 but 不能连用，二选一。",
    },
    {
        "id": "according_to_my_opinion",
        "pattern": r"\baccording to my (opinion|view|idea)\b",
        "bad": "According to my opinion",
        "fix": "In my view / From my perspective / As far as I am concerned",
        "why": "according to 后面只能接他人或资料，不能接自己的观点。",
    },
    {
        "id": "english_level",
        "pattern": r"\benglish level\b",
        "bad": "improve my English level",
        "fix": "improve my English / enhance my English proficiency",
        "why": "英语里不说 English level，说 proficiency 或直接用 improve English。",
    },
    {
        "id": "very_very",
        "pattern": r"\bvery\s+very\b",
        "bad": "very very important",
        "fix": "extremely important / crucial / of great importance",
        "why": "very 叠用是典型中式表达，用程度副词或换词。",
    },
    {
        "id": "price_cheap",
        "pattern": r"\b(price|prices)\b[^.!?]{0,40}?\b(cheap|expensive)\b",
        "bad": "The price is very cheap",
        "fix": "The price is very low / The product is affordable",
        "why": "价格只有高低，物品才谈贵贱。",
    },
    {
        "id": "open_the_light",
        "pattern": r"\bopen\b[^.!?]{0,20}?\b(light|lights|computer|tv|air conditioner)\b",
        "bad": "open the light",
        "fix": "turn on the light",
        "why": "电器的开关用 turn on / turn off，不用 open / close。",
    },
    {
        "id": "use_it_right_way",
        "pattern": r"\buse\b[^.!?]{0,30}?\bin a right way\b",
        "bad": "use it in a right way",
        "fix": "use it properly / use it rationally",
        "why": "in a right way 是直译，英语惯用 properly / rationally。",
    },
    {
        "id": "with_the_development",
        "pattern": r"\bwith the (rapid )?development of (society|the society|our society|economy|science and technology)\b",
        "bad": "With the development of society",
        "fix": "改写成具体现象，如 As cities expand rapidly, ...",
        "why": "阅卷老师最反感的万能套话，一出现就拉低印象分。",
    },
    {
        "id": "every_coin",
        "pattern": r"\bevery coin has two sides\b",
        "bad": "Every coin has two sides",
        "fix": "While the benefits are evident, the drawbacks deserve equal attention.",
        "why": "被用滥的俗语，换成直接展开利弊对比更得分。",
    },
    {
        "id": "as_we_all_know",
        "pattern": r"\bas we all know\b",
        "bad": "As we all know",
        "fix": "It is widely acknowledged that / 直接陈述事实",
        "why": "信息量为零的填充句，删掉不影响意思，还占字数。",
    },
    {
        "id": "can_not_but",
        "pattern": r"\b(can|could)\s+not\s+help\s+but\s+to\b",
        "bad": "can not help but to do",
        "fix": "cannot help but do / cannot help doing",
        "why": "cannot help but 后面接动词原形，不加 to。",
    },
    {
        "id": "more_better",
        "pattern": r"\bmore\s+(better|worse|easier|harder|higher|lower|bigger|smaller)\b",
        "bad": "more better",
        "fix": "better（比较级不能叠加 more）",
        "why": "双比较级错误，形容词比较级已含 more 的意思。",
    },
    {
        "id": "one_of_singular",
        "pattern": r"\bone of the\s+\w*\s*(?<!s)\b(way|reason|problem|student|thing|factor)\b",
        "bad": "one of the way",
        "fix": "one of the ways（one of 后接复数名词）",
        "why": "one of the 后面必须接复数名词。",
    },
    {
        "id": "the_most_of",
        "pattern": r"\bmost of (people|students|us|them)\b",
        "bad": "most of people",
        "fix": "most people / most of the people",
        "why": "most of 后面要有定冠词或代词，泛指直接用 most people。",
    },
]

# ============================================================================
# 七、翻译三步法
# ============================================================================

TRANSLATION_STEPS: list[dict[str, Any]] = [
    {
        "step": 1,
        "name": "拆主干",
        "goal": "找「谁做了什么」",
        "detail": "中文一句话常有 3–4 层修饰，核心主干往往只有一句。先去掉所有定语、状语、插入成分，"
                  "只留主谓宾（或主系表），得到骨架。骨架错了，后面填再多也是错句。",
        "check": "写完骨架后自问：这句话的主语是谁？谓语动词是哪一个？",
    },
    {
        "step": 2,
        "name": "换说法",
        "goal": "词汇卡壳时绕开",
        "detail": "遇到不会译的词，不要硬拼。用你会译的词表达接近的意思，"
                  "比如「促进了」不会译 promote，可以换成 help improve；「源远流长」不会译，"
                  "可以换成 has a long history。保住语法正确比用词高级更重要。",
        "check": "换完说法后确认：意思有没有跑偏？有没有引入原文没有的信息？",
    },
    {
        "step": 3,
        "name": "加被动 / 调语序",
        "goal": "贴合英语习惯",
        "detail": "中文爱用主动和无主句，英语偏好被动与形式主语。主语不是人时优先转被动；"
                  "定语、状语按英语习惯后置；多个动词时只留一个谓语，其余降为分词、不定式或从句。",
        "check": "检查：主语是人吗？多个动词是否只有一个做了谓语？修饰成分放对位置了吗？",
    },
]

# 翻译常见结构考点（用于逐句引导）
TRANSLATION_CUES: list[dict[str, Any]] = [
    {
        "id": "passive",
        "pattern": r"(被|受到|得到了|得到了|为[^，。；]{0,8}所|由[^，。；]{0,8}(建造|设计|发明|创作|编写))",
        "label": "被动语态信号",
        "hint": "中文用「被 / 受到 / 由…」时，英语直接上 be + 过去分词，别硬译成主动。",
    },
    {
        "id": "no_subject",
        "pattern": r"^(通过|经过|随着|根据|据|为了|由于|鉴于)",
        "label": "无主句 / 状语前置",
        "hint": "句首是介词或连词短语时，英语常补形式主语 It 或转被动，避免出现无主语残句。",
    },
    {
        "id": "causative",
        "pattern": r"(使|使得|促使|导致|令|让)",
        "label": "使役结构",
        "hint": "使役义用 make / cause / lead to / enable，注意 make sb. do，cause sb. to do。",
    },
    {
        "id": "multi_verb",
        "pattern": r"[^，。；]{4,}，[^，。；]{4,}，[^，。；]{4,}",
        "label": "多动句 / 长句",
        "hint": "中文连用多个动词时，英语只留一个谓语，其余降为分词（doing/done）、不定式或从句。",
    },
    {
        "id": "long_attribute",
        "pattern": r"[^，。；]{6,}的[^，。；]{2,}",
        "label": "长定语",
        "hint": "中文「……的」定语在英语里通常后置：用 of 短语、介词短语或定语从句放到名词后面。",
    },
    {
        "id": "not_only",
        "pattern": r"(不仅|不但)[^。；]{0,30}(而且|还|也)",
        "label": "并列递进",
        "hint": "用 not only ... but also ...，注意 not only 置于句首时后面要部分倒装。",
    },
    {
        "id": "with_phrase",
        "pattern": r"随着",
        "label": "「随着」",
        "hint": "用 With the ... / As ... 引导，注意 as 后面要跟完整从句，with 后面接名词短语。",
    },
    {
        "id": "increasingly",
        "pattern": r"越来越",
        "label": "「越来越」",
        "hint": "用 increasingly + 形容词，或 a growing number of + 复数名词，不要译成 more and more 堆叠。",
    },
    {
        "id": "number_expr",
        "pattern": r"(公元前|公元|距今|世纪|多年|超过|达到|占|约为|大约)",
        "label": "数字 / 年代",
        "hint": "年代用 in the ... century / over ... years；数字表达注意 date back to、account for、amount to。",
    },
    {
        "id": "emphasis_shi",
        "pattern": r"是[^，。；]{2,}(的)。$",
        "label": "「是……的」强调句",
        "hint": "用 It is ... that ... 强调结构，或直接用主系表，别逐字译成 is ... of。",
    },
    {
        "id": "aspect",
        "pattern": r"在[^，。；]{0,10}方面",
        "label": "「在……方面」",
        "hint": "用 in terms of / in the aspect of，或直接改写成主语，避免中式介词堆叠。",
    },
]

# ============================================================================
# 八、高频文化负载词标准译法（直译 + 注释）
# ============================================================================

CULTURE_TERMS: list[dict[str, Any]] = [
    # —— 历史与制度 ——
    {"zh": "科举制度", "en": "the imperial examination system", "note": "ancient Chinese official selection system", "cat": "历史制度"},
    {"zh": "四大发明", "en": "the Four Great Inventions", "note": "papermaking, printing, gunpowder and the compass", "cat": "历史制度"},
    {"zh": "活字印刷术", "en": "movable-type printing", "note": "an ancient Chinese invention by Bi Sheng in the Song Dynasty", "cat": "历史制度"},
    {"zh": "造纸术", "en": "papermaking", "note": "one of the Four Great Inventions of ancient China", "cat": "历史制度"},
    {"zh": "丝绸之路", "en": "the Silk Road", "note": "an ancient trade route connecting China with Western countries", "cat": "历史制度"},
    {"zh": "封建社会", "en": "feudal society", "note": "a social system in ancient China", "cat": "历史制度"},
    {"zh": "朝代", "en": "dynasty", "note": "a series of rulers from the same family", "cat": "历史制度"},
    {"zh": "故宫", "en": "the Palace Museum", "note": "also known as the Forbidden City", "cat": "历史制度"},
    {"zh": "兵马俑", "en": "the Terracotta Army", "note": "buried with Emperor Qinshihuang", "cat": "历史制度"},
    {"zh": "长城", "en": "the Great Wall", "note": "a symbol of ancient Chinese civilization", "cat": "历史制度"},
    {"zh": "大运河", "en": "the Grand Canal", "note": "the world's longest ancient canal", "cat": "历史制度"},
    # —— 传统文化与艺术 ——
    {"zh": "儒家思想", "en": "Confucianism", "note": "founded by Confucius", "cat": "传统文化"},
    {"zh": "道家思想", "en": "Taoism", "note": "founded by Laozi", "cat": "传统文化"},
    {"zh": "孝道", "en": "filial piety", "note": "respect for parents and ancestors", "cat": "传统文化"},
    {"zh": "仁义礼智信", "en": "benevolence, righteousness, propriety, wisdom and trustworthiness", "note": "the five core Confucian virtues", "cat": "传统文化"},
    {"zh": "京剧", "en": "Peking Opera", "note": "a traditional Chinese opera with a history of over 200 years", "cat": "传统文化"},
    {"zh": "昆曲", "en": "Kunqu Opera", "note": "one of the oldest forms of Chinese opera", "cat": "传统文化"},
    {"zh": "书法", "en": "Chinese calligraphy", "note": "the art of writing Chinese characters", "cat": "传统文化"},
    {"zh": "国画", "en": "traditional Chinese painting", "note": "often featuring landscapes and ink wash", "cat": "传统文化"},
    {"zh": "水墨画", "en": "ink wash painting", "note": "a traditional Chinese painting style", "cat": "传统文化"},
    {"zh": "剪纸", "en": "paper-cutting", "note": "a traditional Chinese folk art", "cat": "传统文化"},
    {"zh": "刺绣", "en": "embroidery", "note": "a traditional Chinese handicraft", "cat": "传统文化"},
    {"zh": "汉服", "en": "Hanfu", "note": "traditional Chinese clothing of the Han people", "cat": "传统文化"},
    {"zh": "中医", "en": "traditional Chinese medicine", "note": "abbreviated as TCM", "cat": "传统文化"},
    {"zh": "针灸", "en": "acupuncture", "note": "a therapy of traditional Chinese medicine", "cat": "传统文化"},
    {"zh": "太极拳", "en": "Tai Chi", "note": "a traditional Chinese martial art", "cat": "传统文化"},
    {"zh": "武术", "en": "martial arts", "note": "traditional Chinese fighting skills", "cat": "传统文化"},
    {"zh": "茶道", "en": "the tea ceremony", "note": "an important part of Chinese culture", "cat": "传统文化"},
    {"zh": "非物质文化遗产", "en": "intangible cultural heritage", "note": "cultural practices passed down through generations", "cat": "传统文化"},
    {"zh": "世界文化遗产", "en": "world cultural heritage", "note": "recognized by UNESCO", "cat": "传统文化"},
    # —— 民俗与节日 ——
    {"zh": "春节", "en": "the Spring Festival", "note": "the most important traditional Chinese festival", "cat": "民俗节日"},
    {"zh": "元宵节", "en": "the Lantern Festival", "note": "the 15th day of the first lunar month", "cat": "民俗节日"},
    {"zh": "端午节", "en": "the Dragon Boat Festival", "note": "when people eat zongzi and hold dragon boat races", "cat": "民俗节日"},
    {"zh": "中秋节", "en": "the Mid-Autumn Festival", "note": "a time for family reunion", "cat": "民俗节日"},
    {"zh": "清明节", "en": "the Qingming Festival", "note": "also known as Tomb-Sweeping Day", "cat": "民俗节日"},
    {"zh": "二十四节气", "en": "the 24 solar terms", "note": "a traditional Chinese calendar system", "cat": "民俗节日"},
    {"zh": "春联", "en": "Spring Festival couplets", "note": "posted on doors during the Spring Festival", "cat": "民俗节日"},
    {"zh": "庙会", "en": "temple fair", "note": "a traditional folk gathering", "cat": "民俗节日"},
    {"zh": "粽子", "en": "zongzi", "note": "a traditional food eaten during the Dragon Boat Festival", "cat": "民俗节日"},
    {"zh": "月饼", "en": "mooncakes", "note": "a traditional food eaten during the Mid-Autumn Festival", "cat": "民俗节日"},
    {"zh": "饺子", "en": "dumplings", "note": "a traditional food eaten during the Spring Festival", "cat": "民俗节日"},
    # —— 地理与自然 ——
    {"zh": "长江", "en": "the Yangtze River", "note": "the longest river in China", "cat": "地理景观"},
    {"zh": "黄河", "en": "the Yellow River", "note": "the cradle of Chinese civilization", "cat": "地理景观"},
    {"zh": "青藏高原", "en": "the Qinghai-Tibet Plateau", "note": "known as the roof of the world", "cat": "地理景观"},
    {"zh": "苏州园林", "en": "Suzhou Classical Gardens", "note": "a masterpiece of Chinese garden design", "cat": "地理景观"},
    {"zh": "西湖", "en": "the West Lake", "note": "a famous scenic spot in Hangzhou", "cat": "地理景观"},
    # —— 经济科技与社会 ——
    {"zh": "改革开放", "en": "the reform and opening-up policy", "note": "launched in 1978", "cat": "经济社会"},
    {"zh": "高铁", "en": "high-speed railway", "note": "abbreviated as HSR", "cat": "经济社会"},
    {"zh": "一带一路", "en": "the Belt and Road Initiative", "note": "proposed in 2013", "cat": "经济社会"},
    {"zh": "人工智能", "en": "artificial intelligence", "note": "abbreviated as AI", "cat": "经济社会"},
    {"zh": "脱贫攻坚", "en": "poverty alleviation", "note": "a national campaign in China", "cat": "经济社会"},
    {"zh": "城镇化", "en": "urbanization", "note": "the process of population moving to cities", "cat": "经济社会"},
    {"zh": "义务教育", "en": "compulsory education", "note": "free education required by law", "cat": "经济社会"},
    {"zh": "可持续发展", "en": "sustainable development", "note": "development that meets present needs without harming the future", "cat": "经济社会"},
]

CULTURE_CATEGORIES = ["历史制度", "传统文化", "民俗节日", "地理景观", "经济社会"]

# 中文里可直接对译、但常被译错的高频表达（给出推荐译法）
PHRASE_HINTS: list[dict[str, str]] = [
    {"zh": "促进了", "en": "promote / help improve / contribute to"},
    {"zh": "起到了重要作用", "en": "play an important role in"},
    {"zh": "为…奠定了基础", "en": "lay the foundation for"},
    {"zh": "源远流长", "en": "have a long history / date back to ancient times"},
    {"zh": "博大精深", "en": "rich and profound"},
    {"zh": "日益", "en": "increasingly"},
    {"zh": "享誉世界", "en": "enjoy a worldwide reputation"},
    {"zh": "被誉为", "en": "be regarded as / be known as"},
    {"zh": "象征着", "en": "symbolize / be a symbol of"},
    {"zh": "据记载", "en": "according to historical records"},
    {"zh": "起源于", "en": "originate in / date back to"},
    {"zh": "发扬光大", "en": "carry forward"},
    {"zh": "吸引了大量游客", "en": "attract a large number of tourists"},
    {"zh": "得到了广泛应用", "en": "be widely used / find wide application"},
    {"zh": "为…提供了便利", "en": "provide convenience for"},
]

# ============================================================================
# 八·B、冲刺满分 · 高级技巧（面向稳定 13–15 档）
# ============================================================================
# 下面这套不替代上面的基础库，而是「再往上够一层」：基础库解决「不犯错、有骨架」，
# 这一节解决「句式有文采、用词有学术感、翻译有地道味」——也就是阅卷老师眼里
# 13–15 档（优秀）和 10–12 档（良好）的真正分水岭。内容经新东方 / 新航道 / 鲁学网等
# 公开高分讲法核对，并补了可机检的 detect 正则供规则引擎奖励使用。

# —— 高级句型：每条都给「普通写法 → 满分写法」对照，detect 非空表示该句型可被引擎识别奖励 ——
ADVANCED_SENTENCE_PATTERNS: list[dict[str, Any]] = [
    {
        "id": "inv_only",
        "name": "Only + 状语 倒装",
        "formula": "Only + 介词短语 / 副词 / 状语从句 + 助动词 + 主语 + 谓语",
        "plain": "We can achieve success only through hard work.",
        "advanced": "Only through hard work can we achieve success.",
        "note": "限制/否定意味前置引发部分倒装，阅卷时极显眼；结尾段收束最常用。",
        "detect": r"\bonly\s+(?:by|when|in this way|thus|after|in this manner)\b[^.!?]{0,50}?\b(?:can|will|could|would|do|does|did|have|has|are|is|were|was|should|must)\b",
    },
    {
        "id": "inv_neg",
        "name": "否定词前置倒装",
        "formula": "Never / Nor / Seldom / Hardly / Not only + 助动词 + 主语 + 谓语",
        "plain": "We should not only master knowledge, but also cultivate character.",
        "advanced": "Not only should we master knowledge, but we should also cultivate character.",
        "note": "Not only 置于句首时后面半句要部分倒装；与 but also 连用句式分拉满。",
        "detect": r"\b(?:never|nor|seldom|rarely|hardly|scarcely|little|not only)\b[^.!?]{0,40}?\b(?:have|has|do|does|did|can|could|will|would|is|are|was|were|should|must)\b",
    },
    {
        "id": "cleft",
        "name": "强调句 It is … that",
        "formula": "It is / was + 被强调成分 + that / who + 其余",
        "plain": "Effort decides destiny.",
        "advanced": "It is effort that decides destiny.",
        "note": "把核心论点/原因「锤」到聚光灯下，开头或论点处用一次效果极好。",
        "detect": r"\bit\s+is\s+(?:not\s+)?[^.!?]{0,40}?\bthat\b",
    },
    {
        "id": "high_time",
        "name": "虚拟建议句 It is high time",
        "formula": "It is high time (that) + 主语 + 动词过去式",
        "plain": "We should take measures to protect the environment.",
        "advanced": "It is high time that we took measures to protect the environment.",
        "note": "表达「早该如此」，自带思辨质感；从句要用过去式。",
        "detect": r"\bit\s+is\s+high\s+time\b",
    },
    {
        "id": "participle",
        "name": "非谓语动词 / 分词开头",
        "formula": "分词 / 形容词短语, + 主句（或收尾）",
        "plain": "China has a long history and it is a country of ancient civilization.",
        "advanced": "Boasting a long history, China is a country of ancient civilization.",
        "note": "把并列短句揉成一个层次分明的长句，瞬间去「翻译腔」。",
        "detect": r"(?:^|[.!?]\s+)[A-Z][^,]{0,60}?\b(?:making|given|faced with|compared with|considering|based on|taking|using|following|seeing|built on|rooted in|characterized by|boasting|witnessing)\b[^,]{0,15},\s",
    },
    {
        "id": "parenthetical",
        "name": "插入语 / 同位语",
        "formula": "主句, with / 介词短语 / 连接副词, 谓语…… 或 名词, a …,",
        "plain": "Chinese calligraphy has a history of thousands of years and it is a unique art form.",
        "advanced": "Chinese calligraphy, with a history of thousands of years, is a unique artistic form in China.",
        "note": "把背景信息塞进逗号之间，句式立马显高级；也可在句首用。",
        "detect": r",\s*(?:however|nevertheless|moreover|therefore|in fact|in other words|for example|that is|to be specific|strictly speaking|in essence)\s*," ,
    },
    {
        "id": "rhetorical",
        "name": "修辞问句",
        "formula": "反问句收尾，引导读者思考",
        "plain": "We must think about how to balance development and protection.",
        "advanced": "How can we strike a balance between development and protection?",
        "note": "结尾用一个 why / how 反问，比平铺陈述更有力，但全文最多用一次。",
        "detect": r"\b(?:why|how)\b[^.?]{0,40}?\?\s*$",
    },
    {
        "id": "absolute",
        "name": "独立主格结构",
        "formula": "名词 + 分词 / 形容词 / 介词短语，+ 主句",
        "plain": "The task was finished and we went home happily.",
        "advanced": "The task finished, we went home happily.",
        "note": "比 and 连接两个分句更紧凑、更有书面感；属高阶结构，引擎不机检，靠自觉使用。",
        "detect": None,
    },
    {
        "id": "parallel",
        "name": "平行 / 排比结构",
        "formula": "Not only A but also B；Whether … or …；X, Y, and Z 同构",
        "plain": "It improves our ability, broadens our horizon and strengthens our confidence.",
        "advanced": "It sharpens our ability, broadens our horizon, and strengthens our confidence.",
        "note": "三个及以上同构短语并列，节奏感强、记忆点突出；引擎不机检。",
        "detect": None,
    },
    {
        "id": "appositive",
        "name": "同位语揉合短句",
        "formula": "名词, a/an/the + 修饰名词, + 从句 / 谓语",
        "plain": "Respecting the elderly is a traditional virtue. It is deeply rooted in our culture.",
        "advanced": "Respecting the elderly, a traditional virtue deeply rooted in our culture, has become a code of conduct.",
        "note": "把三个短句合为一个长句，正是 13–15 档译文/作文的「长句揉合」能力。",
        "detect": None,
    },
]

# —— 高阶词汇与搭配：比 UPGRADE_WORDS（important→crucial 那层）再上一个学术语域 ——
ADVANCED_VOCAB: list[dict[str, Any]] = [
    {"basic": "play an important role", "advanced": ["play a pivotal role", "play an indispensable role", "be central to"],
     "example": "Education is central to a nation's long-term development."},
    {"basic": "be good for", "advanced": ["be conducive to", "be beneficial to", "be instrumental in"],
     "example": "Regular reading is conducive to clear thinking."},
    {"basic": "cause", "advanced": ["give rise to", "trigger", "engender", "precipitate"],
     "example": "Rapid urbanization has given rise to a host of social challenges."},
    {"basic": "show", "advanced": ["manifest", "epitomize", "embody", "reflect"],
     "example": "The festival epitomizes the Chinese pursuit of family reunion."},
    {"basic": "use", "advanced": ["harness", "leverage", "utilize", "tap into"],
     "example": "We should harness technology to bridge the digital divide."},
    {"basic": "increase", "advanced": ["soar", "surge", "escalate", "witness a sharp increase"],
     "example": "The past decade witnessed a sharp increase in mobile payments."},
    {"basic": "a lot of people", "advanced": ["a significant proportion of the population", "the general public", "the masses"],
     "example": "A significant proportion of the population now shops online."},
    {"basic": "deal with", "advanced": ["grapple with", "tackle", "address", "cope with"],
     "example": "Graduates must grapple with fierce competition in the job market."},
    {"basic": "think about", "advanced": ["reflect on", "contemplate", "ponder", "deliberate on"],
     "example": "We should reflect on what truly constitutes a good life."},
    {"basic": "result in", "advanced": ["culminate in", "lead to", "give rise to"],
     "example": "Years of effort culminated in a breakthrough discovery."},
    {"basic": "influence", "advanced": ["exert a far-reaching impact on", "shape", "mold", "bear on"],
     "example": "AI is exerting a far-reaching impact on the future of work."},
    {"basic": "nowadays", "advanced": ["against this backdrop", "in contemporary society", "in the current era"],
     "example": "Against this backdrop, lifelong learning has become a necessity."},
    {"basic": "should", "advanced": ["it is imperative that … (should)", "there is a pressing need to", "we are obliged to"],
     "example": "It is imperative that the government allocate more funds to education."},
    {"basic": "try to", "advanced": ["endeavor to", "strive to", "make every effort to"],
     "example": "We should endeavor to preserve our intangible cultural heritage."},
    {"basic": "stop", "advanced": ["curb", "halt", "put an end to", "combat"],
     "example": "Stringent laws are needed to curb environmental degradation."},
    {"basic": "protect", "advanced": ["safeguard", "preserve", "shield", "conserve"],
     "example": "We must conserve biodiversity for future generations."},
    {"basic": "make … better", "advanced": ["refine", "enhance", "optimize", "upgrade"],
     "example": "Smart grids help optimize the distribution of electricity."},
    {"basic": "different kinds of", "advanced": ["a wide array of", "a diverse range of", "a spectrum of"],
     "example": "The museum displays a diverse range of folk artifacts."},
]

# 比基础过渡词更「隐形」的语篇衔接词（避免满篇 Moreover / However 的重复感）
ADVANCED_DISCOURSE_MARKERS: list[dict[str, str]] = [
    {"type": "强调递进", "words": ["notably", "crucially", "above all", "what is more", "more to the point"]},
    {"type": "转折对比", "words": ["by contrast", "conversely", "that said", "granted", "admittedly"]},
    {"type": "因果承接", "words": ["against this backdrop", "in this regard", "as a result", "thereby", "hence"]},
    {"type": "举例/阐释", "words": ["to put it another way", "that is to say", "a case in point", "by way of illustration"]},
    {"type": "总结升华", "words": ["on the whole", "all in all", "to sum up", "viewed from this angle"]},
]

# —— 高级翻译技巧：每条给「普通译法 → 满分译法」，对应六级 180–200 字段落 13–15 档 ——
ADVANCED_TRANSLATION_TECHNIQUES: list[dict[str, Any]] = [
    {
        "id": "four_char",
        "name": "四字格 / 成语浓缩",
        "when": "中文成语、四字短语不要逐字译，找对应英文固定表达或意译。",
        "plain": "China has a long history and its culture is deep and broad.",
        "advanced": "China boasts a long history and a rich, profound culture.",
        "hint": "博大精深→rich and profound；源远流长→boast/date back to；享誉世界→enjoy a worldwide reputation；蓬勃发展→flourish / witness robust growth。",
    },
    {
        "id": "conversion",
        "name": "词性转换",
        "when": "中文多动词、英文重名词；卡壳时把名词转动词或动词转名词。",
        "plain": "Her book left a deep impression on us.",
        "advanced": "Her book impressed us deeply.",
        "hint": "「印象深刻」→ impress；「发展」→ development；「使用」→ make use of。转换后句子更地道。",
    },
    {
        "id": "amplification",
        "name": "增译（补主语 / 逻辑连接）",
        "when": "中文省略的主语、隐性逻辑关系，英文要补出来。",
        "plain": "With the development of economy, living standard improved.",
        "advanced": "With economic development, people's living standards have improved markedly.",
        "hint": "补出 people's 这类所有格与明显主语；必要时加 and / thereby 让逻辑显形。",
    },
    {
        "id": "omission",
        "name": "省译（删范畴词 / 重复）",
        "when": "「进行……的研究」「加以……」这类范畴词、重复词直接省掉。",
        "plain": "We should carry out a reform of the system.",
        "advanced": "We should reform the system.",
        "hint": "进行/加以/关于 等范畴词在英文里往往不需要；重复的词合并，译文立刻干净。",
    },
    {
        "id": "relative_combine",
        "name": "定语从句合并短句",
        "when": "中文两三个短句讲同一事物，用 which / that / who 揉成一个长句。",
        "plain": "The Spring Festival is the most important festival. Families reunite on it.",
        "advanced": "The Spring Festival, the most important traditional festival, is when families reunite.",
        "hint": "用 which / when / where 把第二句并进去，是 13–15 档「长句揉合」的核心动作。",
    },
    {
        "id": "participle_appositive",
        "name": "分词 / 同位语开头收尾",
        "when": "用 Magnificent in …, / Rooted in …, 等把背景塞进逗号之间。",
        "plain": "The Great Wall is grand and has a long history. It is famous worldwide.",
        "advanced": "Magnificent in appearance and profound in history, the Great Wall enjoys a worldwide reputation.",
        "hint": "分词/形容词短语作状语开头，瞬间去「翻译腔」，句式分直接上来。",
    },
    {
        "id": "negation_shift",
        "name": "正反表达转换",
        "when": "中文否定意思、英文用肯定式反而地道。",
        "plain": "His speech was not substantial.",
        "advanced": "His speech was pretty thin.",
        "hint": "「不充实」→ thin；「不大」→ small；「不可避免地」→ inevitably。避免 not + 形容词的生硬。",
    },
    {
        "id": "division",
        "name": "分译（长句拆分）",
        "when": "中文一句话三四个动词、信息过载，拆成两三个英文句。",
        "plain": "The girl who was injured in the accident was sent to the hospital immediately by the police.",
        "advanced": "The girl was injured in the accident. The police sent her to the hospital immediately.",
        "hint": "太长容易出错；拆短句反而清晰、层次分明，也更符合英语习惯。",
    },
    {
        "id": "person_angle",
        "name": "从「人」的角度出发",
        "when": "中文无主句、抽象名词堆砌时，转成 «人 + 动词» 更自然。",
        "plain": "Society should create an atmosphere of respecting the elderly.",
        "advanced": "Society should foster an atmosphere in which the elderly are respected.",
        "hint": "「营造氛围」不必硬译 create an atmosphere，可用 foster / promote；从人出发让动作有主语。",
    },
    {
        "id": "register",
        "name": "语域：正式书面",
        "when": "六级译文要正式：避免口语词、缩略、感叹。",
        "plain": "So we gotta protect our culture.",
        "advanced": "Therefore, we are obliged to safeguard our cultural heritage.",
        "hint": "gonna / gotta / a lot of / kids 这类口语词一出现就掉档；换成 obliged to / a significant number of / children。",
    },
]

# 高级范文/译文样例（14–15 档）：让「懒得输入」的演示也能看到满分样板
ADVANCED_WRITING_SEEDS: list[dict[str, Any]] = [
    {
        "template_id": "tpl_phenomenon",
        "topic_zh": "人工智能对大学生学习方式的影响",
        "topic_en": "The Impact of Artificial Intelligence on How College Students Learn",
        "seed_essay": (
            "The pervasive adoption of artificial intelligence has fundamentally reshaped how college "
            "students acquire knowledge, sparking intense debate on campus. It is technology, rather than "
            "mere diligence, that now determines the efficiency of self-directed learning.\n\n"
            "The fundamental cause of this shift lies in AI's unparalleled capacity to tailor instruction "
            "to individual needs. A case in point is that an adaptive tutor pinpoints a student's blind "
            "spots within minutes, a feat no human lecturer could achieve at scale. Consequently, learners "
            "who embrace these tools often outpace their peers by a considerable margin. What is more, AI "
            "frees students from rote memorization, enabling them to focus on critical thinking instead.\n\n"
            "Nevertheless, this convenience exacts a hidden cost on intellectual independence. Students who "
            "over-rely on generated answers gradually lose the stamina for original inquiry. This is because "
            "effortless access to solutions erodes the very struggle through which understanding is built. "
            "Against this backdrop, the real challenge is not whether to use AI, but how to use it without "
            "surrendering one's own judgment.\n\n"
            "In conclusion, artificial intelligence is a double-edged sword that demands discernment. Only "
            "by treating it as an aid rather than a substitute can we harvest its benefits without "
            "compromising the rigor of our minds."
        ),
    },
    {
        "template_id": "tpl_quote",
        "topic_zh": "名言评论：求知若饥，虚心若愚",
        "topic_en": "Comment on \"Stay Hungry, Stay Foolish\"",
        "seed_essay": (
            "Steve Jobs once urged a graduating class to \"stay hungry, stay foolish.\" Beneath its "
            "deceptively simple wording lies a profound philosophy of lifelong growth: one must remain "
            "restlessly curious and humbly open to the unknown.\n\n"
            "The validity of this view is most visible in the trajectory of genuine innovators. A case in "
            "point is that those who change their fields rarely rest on past triumphs; instead, they "
            "approach each problem as a beginner would. This is because expertise, left unchallenged, "
            "hardens into dogma. Therefore, the willingness to feel foolish is precisely what keeps the "
            "mind fertile.\n\n"
            "At a broader level, a society that prizes certainty over inquiry eventually stagnates. "
            "Conversely, cultures that celebrate questioning tend to lead in science and art alike. "
            "Crucially, hunger and humility are not contradictions but companions: the former pulls us "
            "forward, the latter keeps us teachable. How, then, can we cultivate both in an age of "
            "comfortable answers?\n\n"
            "To sum up, the slogan is a lifelong command, not a graduation-day slogan. Only by remaining "
            "perpetually hungry and willingly foolish can we keep growing long after the diplomas fade."
        ),
    },
]

ADVANCED_TRANSLATION_SEEDS: list[dict[str, Any]] = [
    {
        "category": "传统文化",
        "title": "二十四节气",
        "source": (
            "二十四节气是中国古代订立的一种补充历法，用于指导农业生产。它反映了中华民族对自然规律的"
            "深刻认识，被誉为中国的第五大发明。如今，这一遗产仍然影响着中国人的日常生活。"
        ),
        "reference": (
            "The 24 solar terms, a supplementary calendar devised in ancient China, were used to guide "
            "agricultural production. They reflect the Chinese nation's profound understanding of natural "
            "rhythms and are honored as China's fifth great invention. To this day, this heritage continues "
            "to shape the daily lives of the Chinese people."
        ),
    },
    {
        "category": "经济社会",
        "title": "乡村振兴",
        "source": (
            "近年来，中国大力推进乡村振兴战略，致力于缩小城乡差距。大量年轻人回到家乡创业，"
            "为农村带来了新的活力。随着基础设施的不断完善，农村居民的生活水平显著提高。"
        ),
        "reference": (
            "In recent years, China has vigorously advanced the rural revitalization strategy, endeavoring "
            "to narrow the urban-rural gap. A growing number of young people have returned to their "
            "hometowns to start businesses, injecting fresh vitality into the countryside. With the "
            "continuous improvement of infrastructure, the living standards of rural residents have risen "
            "markedly."
        ),
    },
]


# ============================================================================
# 九、写作体检引擎（纯规则）
# ============================================================================

_WORD_RE = re.compile(r"[A-Za-z][A-Za-z'\-]*")
_SENT_SPLIT_RE = re.compile(r"[.!?]+")
_ZH_SENT_SPLIT_RE = re.compile(r"[。！？；\n]+")
# 状语型意群开头：这些片段是修饰成分，不可能是主干，选主干候选时要跳过
_ADVERBIAL_HEAD_RE = re.compile(r"^(随着|通过|经过|根据|据|为了|由于|鉴于|在[^，]{0,8}方面|自|从)")
# 意群开头的关联词：剥掉后才好判断谁是真主干
_LEAD_CONJ_RE = re.compile(r"^(而且|但是|但|并且|同时|而|因此|所以|不仅|不但|然而|此外|另外|它|他们|它们)")


def _count_words(text: str) -> int:
    return len(_WORD_RE.findall(text))


def _split_paragraphs(text: str) -> list[str]:
    return [p.strip() for p in re.split(r"\n\s*\n", text.strip()) if p.strip()]


def _split_sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENT_SPLIT_RE.split(text) if s.strip()]


def _word_hits(text: str, word: str) -> list[str]:
    """返回命中的原句（去重，最多 3 条），用于让建议可追溯。"""
    pattern = re.compile(r"\b" + re.escape(word) + r"\b", re.IGNORECASE)
    hits: list[str] = []
    for sent in _split_sentences(text):
        if pattern.search(sent):
            hits.append(sent)
        if len(hits) >= 3:
            break
    return hits


def check_writing(text: str) -> dict[str, Any]:
    """写作体检：字数、结构、中式英语、可升级词汇、过渡词、句型缺失、分档估算。"""
    text = (text or "").strip()
    if not text:
        return {"ok": False, "message": "请先粘贴你的作文正文。"}

    words = _count_words(text)
    paragraphs = _split_paragraphs(text)
    sentences = _split_sentences(text)

    # —— 字数 ——
    if words >= WRITING_RUBRIC["word_min"]:
        word_state, word_penalty = "ok", 0.0
        word_tip = f"共 {words} 词，达到 {WRITING_RUBRIC['word_min']}–{WRITING_RUBRIC['word_max']} 词要求。"
    elif words >= 140:
        word_state, word_penalty = "warn", 1.0
        word_tip = f"共 {words} 词，差 {150 - words} 词到 150。按评分口径 140–149 词扣 1 分，补两句就够。"
    elif words >= 130:
        word_state, word_penalty = "warn", 2.0
        word_tip = f"共 {words} 词，130–139 词区间按口径扣 2 分。建议每个主体段再补一句例子。"
    else:
        word_state, word_penalty = "bad", 3.0
        word_tip = f"共 {words} 词，明显偏短（不足 130 词），会被重扣。先保证把三段写满。"

    # —— 结构 ——
    structure: list[dict[str, str]] = []
    if len(paragraphs) >= 3:
        structure.append({"level": "ok", "text": f"分了 {len(paragraphs)} 段，三段式结构完整。"})
    elif len(paragraphs) == 2:
        structure.append({"level": "warn", "text": "只分了 2 段，建议把主体拆成两个分论点段（观点对比型尤其需要）。"})
    else:
        structure.append({"level": "bad", "text": "只有 1 段。一段到底在评分里直接判「条理不清」，必须分段。"})

    body_paras = paragraphs[1:-1] if len(paragraphs) >= 3 else []
    if body_paras and any(len(_split_sentences(p)) < 3 for p in body_paras):
        structure.append({"level": "warn", "text": "有主体段不足 3 句。主体段建议写满「观点→解释→例子→分析→扣回」5 句。"})
    if paragraphs and len(_split_sentences(paragraphs[-1])) > 4:
        structure.append({"level": "warn", "text": "结尾段超过 4 句，偏长。结尾 2–3 句重申观点即可，别引入新论点。"})

    # —— 中式英语 / 语法 ——
    chinglish: list[dict[str, Any]] = []
    for rule in CHINGLISH_RULES:
        for sent in sentences:
            m = re.search(rule["pattern"], sent, re.IGNORECASE)
            if not m:
                continue
            chinglish.append(
                {
                    "id": rule["id"],
                    "sentence": sent,
                    "hit": m.group(0).strip(),
                    "bad": rule["bad"],
                    "fix": rule["fix"],
                    "why": rule["why"],
                }
            )
            break

    # —— 可升级词汇 ——
    upgrades: list[dict[str, Any]] = []
    for item in UPGRADE_WORDS:
        hits = _word_hits(text, item["basic"])
        if hits:
            upgrades.append(
                {
                    "basic": item["basic"],
                    "upgrades": item["upgrades"],
                    "example": item["example"],
                    "sentences": hits,
                }
            )

    # —— 过渡词 ——
    used_transitions: list[str] = []
    for group in TRANSITIONS:
        for w in group["words"]:
            if re.search(r"\b" + re.escape(w) + r"\b", text, re.IGNORECASE):
                used_transitions.append(w)
    transition_tip = ""
    if not used_transitions:
        transition_tip = "全篇没有出现逻辑连接词。评分里的「连贯」分就靠这些词撑着，至少补 3 个。"
    elif len(used_transitions) < 3:
        transition_tip = f"只用到 {len(used_transitions)} 个连接词，偏少。主体段之间、段落内部都该有过渡。"

    # —— 句型多样性 ——
    sentence_lengths = [_count_words(s) for s in sentences]
    long_sentences = [n for n in sentence_lengths if n >= 20]
    has_inversion = bool(re.search(r"\b(only by|not only|never|hardly)\b", text, re.IGNORECASE))
    has_clause = bool(re.search(r"\b(which|that|who|whose|where|when)\b", text, re.IGNORECASE))
    style_tips: list[str] = []
    if len(long_sentences) == 0:
        style_tips.append("全篇都是短句。至少写 1–2 个带从句的长句，句式分才拿得到。")
    if not has_clause:
        style_tips.append("没有出现定语从句或名词性从句，句式偏单调。")
    if not has_inversion:
        style_tips.append("可以加一句 Only by doing so can we... 倒装收尾，阅卷时很显眼。")

    # —— 高级句式识别（冲刺 13–15 档的关键信号）——
    advanced_features: list[dict[str, str]] = []
    for pat in ADVANCED_SENTENCE_PATTERNS:
        rx = pat.get("detect")
        if not rx:
            continue
        if re.search(rx, text, re.IGNORECASE | re.MULTILINE):
            advanced_features.append({"id": pat["id"], "name": pat["name"]})
    advanced_ids = {f["id"] for f in advanced_features}
    advanced_tips: list[str] = []
    if "cleft" not in advanced_ids:
        advanced_tips.append("加一句 It is … that 强调句，把核心论点锤到聚光灯下。")
    if "inv_only" not in advanced_ids and "inv_neg" not in advanced_ids:
        advanced_tips.append("用 Only by … / Not only … but also 倒装，结尾或论点处最显眼。")
    if "participle" not in advanced_ids and "parenthetical" not in advanced_ids:
        advanced_tips.append("试试用分词短语或插入语把短句揉成长句，去「翻译腔」。")
    if "rhetorical" not in advanced_ids:
        advanced_tips.append("结尾可加一个 why / how 反问，比平铺陈述更有力（全文最多一次）。")

    # —— 套话检测（基础 / 口语化表达，13–15 档要绕着走）——
    CLICHE_PATTERNS = [
        (r"\bwith the (rapid )?development of (society|the society|our society|economy|science and technology)\b", "With the development of society（万能套话，换成具体现象）"),
        (r"\bas we all know\b", "As we all know（信息量为零的填充句）"),
        (r"\bevery coin has two sides\b", "Every coin has two sides（被用滥的俗语）"),
        (r"\bmore\s+and\s+more\b", "more and more（换成 increasingly / a growing number of）"),
        (r"\bin a word\b", "in a word（结尾套话，用 In conclusion 更稳）"),
    ]
    cliches: list[dict[str, str]] = []
    for rx, label in CLICHE_PATTERNS:
        m = re.search(rx, text, re.IGNORECASE)
        if m:
            cliches.append({"hit": m.group(0).strip(), "why": label})

    # —— 分档估算（规则粗估，不是官方评分）——
    penalty = word_penalty + 0.4 * len(chinglish) + 0.15 * len(upgrades)
    if len(paragraphs) < 3:
        penalty += 2.0
    if not has_clause:
        penalty += 0.5
    if not advanced_features:
        penalty += 0.5
    penalty += 0.3 * min(3, len(cliches))
    # 高级句式是「加分项」：每命中一种 +0.3，封顶 +1.5，正好把优秀档从 14 推到 15。
    advanced_bonus = min(1.5, 0.3 * len(advanced_features))
    score = max(1.0, min(15.0, 15.0 - penalty + advanced_bonus))
    if score >= 13:
        band = WRITING_RUBRIC["bands"][0]
    elif score >= 10:
        band = WRITING_RUBRIC["bands"][1]
    elif score >= 7:
        band = WRITING_RUBRIC["bands"][2]
    elif score >= 4:
        band = WRITING_RUBRIC["bands"][3]
    else:
        band = WRITING_RUBRIC["bands"][4]

    checklist: list[str] = []
    if word_state != "ok":
        checklist.append("补足字数到 150 词以上")
    if len(paragraphs) < 3:
        checklist.append("拆成三段：开篇 / 主体 / 结尾")
    if chinglish:
        checklist.append(f"改掉 {len(chinglish)} 处中式英语或语法错误")
    if upgrades:
        checklist.append(f"挑 {min(3, len(upgrades))} 个基础词换成高级词")
    if len(used_transitions) < 3:
        checklist.append("补 3 个以上逻辑连接词")
    if style_tips:
        checklist.append("加 1–2 个从句或倒装句")
    if cliches:
        checklist.append(f"去掉 {len(cliches)} 处套话 / 口语化表达")
    if advanced_tips:
        checklist.append("加 1–2 个高级句式（强调 / 倒装 / 分词 / 插入语）冲 14–15")

    return {
        "ok": True,
        "words": words,
        "paragraph_count": len(paragraphs),
        "sentence_count": len(sentences),
        "word_state": word_state,
        "word_tip": word_tip,
        "structure": structure,
        "chinglish": chinglish,
        "upgrades": upgrades,
        "transitions_used": used_transitions,
        "transition_tip": transition_tip,
        "style_tips": style_tips,
        "advanced_features": advanced_features,
        "advanced_tips": advanced_tips,
        "cliches": cliches,
        "estimate": {
            "score": round(score, 1),
            "band": band["band"],
            "label": band["label"],
            "note": "这是按字数、段数、错误、句式多样性做的规则粗估，仅用于自查，不等于阅卷评分。命中高级句式可冲 14–15 档。",
        },
        "checklist": checklist,
    }


# ============================================================================
# 十、翻译引导与体检引擎（纯规则）
# ============================================================================


def _culture_hits(text: str) -> list[dict[str, Any]]:
    hits: list[dict[str, Any]] = []
    for term in CULTURE_TERMS:
        if term["zh"] in text:
            hits.append(
                {
                    "zh": term["zh"],
                    "en": term["en"],
                    "note": term["note"],
                    "cat": term["cat"],
                }
            )
    return hits


def _phrase_hits(text: str) -> list[dict[str, str]]:
    hits: list[dict[str, str]] = []
    for item in PHRASE_HINTS:
        if item["zh"] in text:
            hits.append(item)
    return hits


def guide_translation(zh_text: str) -> dict[str, Any]:
    """翻译三步法引导：逐句给出结构考点、意群切分、文化词标准译法。"""
    zh_text = (zh_text or "").strip()
    if not zh_text:
        return {"ok": False, "message": "请先粘贴要翻译的中文段落。"}

    sentences = [s.strip() for s in _ZH_SENT_SPLIT_RE.split(zh_text) if s.strip()]
    guided: list[dict[str, Any]] = []

    for idx, sent in enumerate(sentences, start=1):
        cues: list[dict[str, str]] = []
        for cue in TRANSLATION_CUES:
            if re.search(cue["pattern"], sent):
                cues.append({"label": cue["label"], "hint": cue["hint"]})

        # 意群切分：按逗号/顿号断开，帮助用户找主干
        chunks = [c.strip() for c in re.split(r"[，、]", sent) if c.strip()]
        # 主干候选：排除纯状语意群、剥掉句首关联词，再取最短的一个。
        # 规则法做不到真句法分析，这里只给「最可能是主干」的候选，措辞上不打包票。
        candidates = [
            _LEAD_CONJ_RE.sub("", c) or c
            for c in chunks
            if not _ADVERBIAL_HEAD_RE.match(c)
        ]
        backbone_guess = min(candidates, key=len) if candidates else sent

        guided.append(
            {
                "index": idx,
                "zh": sent,
                "chunks": chunks,
                "backbone_guess": backbone_guess,
                "cues": cues,
                "culture": _culture_hits(sent),
                "phrases": _phrase_hits(sent),
                "steps": [
                    f"第 1 步 拆主干：本句切出 {len(chunks)} 个意群，先找出「谁 + 做了什么」，"
                    f"主干候选「{backbone_guess}」（规则给的是候选，以你自己判断为准）。",
                    "第 2 步 换说法：不会译的词换成你会译的近义表达，保住语法正确。",
                    "第 3 步 加被动 / 调语序：主语不是人就用被动，长定语后置，多个动词只留一个谓语。",
                ],
            }
        )

    all_culture: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in guided:
        for c in item["culture"]:
            if c["zh"] not in seen:
                seen.add(c["zh"])
                all_culture.append(c)

    return {
        "ok": True,
        "sentence_count": len(sentences),
        "sentences": guided,
        "culture": all_culture,
        "steps": TRANSLATION_STEPS,
    }


def check_translation(zh_text: str, en_text: str) -> dict[str, Any]:
    """译文体检：中式英语、长度比、文化词覆盖、被动语态、大写规范。"""
    zh_text = (zh_text or "").strip()
    en_text = (en_text or "").strip()
    if not en_text:
        return {"ok": False, "message": "请先粘贴你的英文译文。"}

    zh_chars = len(re.sub(r"\s", "", zh_text))
    en_words = _count_words(en_text)
    en_sentences = _split_sentences(en_text)

    # —— 中式英语 / 语法 ——
    chinglish: list[dict[str, Any]] = []
    for rule in CHINGLISH_RULES:
        for sent in en_sentences:
            m = re.search(rule["pattern"], sent, re.IGNORECASE)
            if not m:
                continue
            chinglish.append(
                {
                    "id": rule["id"],
                    "sentence": sent,
                    "hit": m.group(0).strip(),
                    "bad": rule["bad"],
                    "fix": rule["fix"],
                    "why": rule["why"],
                }
            )
            break

    # —— 长度比 ——
    issues: list[dict[str, str]] = []
    if zh_chars >= 20:
        ratio = en_words / zh_chars
        if ratio < 0.45:
            issues.append({"level": "warn", "text": f"译文 {en_words} 词对应 {zh_chars} 字，偏短。可能有整句漏译或成分被吞掉。"})
        elif ratio > 1.1:
            issues.append({"level": "warn", "text": f"译文 {en_words} 词对应 {zh_chars} 字，偏长。检查是否逐字硬译或重复表达。"})
        else:
            issues.append({"level": "ok", "text": f"译文 {en_words} 词 / 原文 {zh_chars} 字，长度比正常。"})

    # —— 文化词覆盖 ——
    culture_missing: list[dict[str, Any]] = []
    culture_ok: list[dict[str, Any]] = []
    lower_en = en_text.lower()
    for term in _culture_hits(zh_text):
        key = term["en"].lower().split("(")[0].strip()
        if key and key in lower_en:
            culture_ok.append(term)
        else:
            culture_missing.append(term)

    # —— 被动语态 ——
    zh_has_passive = bool(re.search(TRANSLATION_CUES[0]["pattern"], zh_text))
    # 助动词与过去分词之间常插副词（is also regarded / was widely used），
    # 只认紧挨着的形式会把这些正常被动误判成「漏转」，所以放一个副词进去。
    # 注意 also / often 这类不带 -ly，不能只用 \w+ly 兜。
    en_has_passive = bool(
        re.search(
            r"\b(is|are|was|were|be|been|being)\s+"
            r"(?:(?:\w+ly|also|often|usually|generally|widely|commonly|still|already|greatly|largely|partly|now|then)\s+)?"
            r"\w+(ed|en)\b",
            en_text,
            re.IGNORECASE,
        )
    )
    if zh_has_passive and not en_has_passive:
        issues.append({"level": "warn", "text": "中文出现了「被 / 受到 / 由…」类被动信号，但译文里没检出被动结构，检查是否漏转。"})

    # —— 大写规范 ——
    case_issues: list[dict[str, str]] = []
    for term in culture_ok:
        proper = term["en"]
        if proper[:1].isupper() and proper.lower() in lower_en and proper not in en_text:
            case_issues.append({"level": "warn", "text": f"「{term['zh']}」的标准译法 {proper} 首字母要大写。"})

    # —— 高级译法建议（冲 13–15 档）——
    advanced_tips: list[str] = []
    zh_sent_count = len([s for s in re.split(r"[。！？；\n]+", zh_text) if s.strip()])
    if zh_sent_count >= 2 and len(en_sentences) > zh_sent_count * 1.5:
        advanced_tips.append(
            "英文句数明显多于中文，说明在逐句硬译。试试用 which / when / 分词把相邻的短句揉成一个长句，"
            "这是 13–15 档译文与 10–12 档译文最直观的分水岭。"
        )
    en_has_subordination = bool(
        re.search(r"\b(which|who|where|when|that|although|while|because|despite|with)\b", en_text, re.IGNORECASE)
    )
    if not en_has_subordination:
        advanced_tips.append("译文几乎没有从句或 with 结构，层次偏平。13–15 档译文普遍用定语从句 / 分词把信息分层。")

    checklist: list[str] = []
    if chinglish:
        checklist.append(f"改掉 {len(chinglish)} 处中式英语")
    if culture_missing:
        checklist.append(f"补齐 {len(culture_missing)} 个文化词的标准译法")
    if any(i["level"] == "warn" for i in issues):
        checklist.append("复核长度比与被动语态")
    if case_issues:
        checklist.append("专有名词首字母大写")
    if advanced_tips:
        checklist.append("尝试长句揉合 / 加从句，向 13–15 档译文靠拢")
    checklist.append("通查定冠词、单复数、介词、时态四项")

    return {
        "ok": True,
        "zh_chars": zh_chars,
        "en_words": en_words,
        "sentence_count": len(en_sentences),
        "chinglish": chinglish,
        "issues": issues,
        "culture_ok": culture_ok,
        "culture_missing": culture_missing,
        "case_issues": case_issues,
        "advanced_tips": advanced_tips,
        "checklist": checklist,
        "deductions": TRANSLATION_RUBRIC["deductions"],
    }


# ============================================================================
# 十一、对外聚合接口
# ============================================================================


def writing_kit(gems: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    gems = list(gems or [])
    upgrade_words = [dict(u) for u in UPGRADE_WORDS]
    chinglish_rules = [
        {"id": r["id"], "bad": r["bad"], "fix": r["fix"], "why": r["why"]} for r in CHINGLISH_RULES
    ]
    advanced_sentence_patterns = [dict(p) for p in ADVANCED_SENTENCE_PATTERNS]
    for g in gems:
        mod = g.get("module")
        if mod == "chinglish":
            chinglish_rules.append(
                {"id": g.get("gem_id", ""), "bad": g.get("source_text", ""), "fix": g.get("target_text", ""), "why": g.get("reason", "")}
            )
        elif mod == "upgrade":
            upgrade_words.append(
                {"basic": g.get("source_text", ""), "upgrades": [g.get("target_text", "")], "example": g.get("reason", "")}
            )
        elif mod == "sentence":
            advanced_sentence_patterns.append(
                {"id": g.get("gem_id", ""), "name": "演示改写", "formula": "", "plain": g.get("source_text", ""), "advanced": g.get("target_text", ""), "note": g.get("reason", "")}
            )
    return {
        "ok": True,
        "rubric": WRITING_RUBRIC,
        "templates": WRITING_TEMPLATES,
        "sentence_bank": SENTENCE_BANK,
        "upgrade_words": upgrade_words,
        "transitions": TRANSITIONS,
        "chinglish_rules": chinglish_rules,
        "advanced_sentence_patterns": advanced_sentence_patterns,
        "advanced_vocab": ADVANCED_VOCAB,
        "advanced_discourse_markers": ADVANCED_DISCOURSE_MARKERS,
        "demo_types": demo_writing_types(),
    }


def translation_kit(gems: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    gems = list(gems or [])
    culture_gems = [g for g in gems if g.get("module") == "culture"]
    phrase_gems = [g for g in gems if g.get("module") == "phrase"]
    culture_terms = [dict(t) for t in CULTURE_TERMS]
    for g in culture_gems:
        culture_terms.append(
            {"zh": g.get("source_text", ""), "en": g.get("target_text", ""), "cat": "我的积累", "note": g.get("reason", "")}
        )
    phrase_hints = [dict(p) for p in PHRASE_HINTS]
    for g in phrase_gems:
        phrase_hints.append(
            {"zh": g.get("source_text", ""), "en": g.get("target_text", ""), "note": g.get("reason", "")}
        )
    culture_categories = list(CULTURE_CATEGORIES)
    if culture_gems:
        culture_categories.append("我的积累")
    return {
        "ok": True,
        "rubric": TRANSLATION_RUBRIC,
        "steps": TRANSLATION_STEPS,
        "cues": [{"id": c["id"], "label": c["label"], "hint": c["hint"]} for c in TRANSLATION_CUES],
        "culture_categories": culture_categories,
        "culture_terms": culture_terms,
        "phrase_hints": phrase_hints,
        "chinglish_rules": [
            {"id": r["id"], "bad": r["bad"], "fix": r["fix"], "why": r["why"]} for r in CHINGLISH_RULES
        ],
        "advanced_translation_techniques": ADVANCED_TRANSLATION_TECHNIQUES,
        "demo_categories": demo_translation_categories(),
    }


# ============================================================================
# 十二·B、演示精华提取（把 AI 演示的逐处修改 / 译法笔记归入工具箱对应模块）
# ============================================================================
# 演示返回体里已经有结构化的「精华」：写作是 fixes（原句 → 改后 + 理由），
# 翻译是 notes（中文 → 译法 + 理由）。这里按模块把每条归到最贴切的那一栏，
# 由存储层去重后合并进 writing_kit / translation_kit，让工具箱随用户的演示慢慢长。

_GRAMMAR_HINTS = (
    "中式", "chinglish", "语法", "时态", "冠词", "主谓", "单复数", "复数", "语序",
    "搭配", "被动", "从句", "标点", "拼写", "连词", "非谓语", "成分", "状语", "定语",
    "介词", "代词", "残缺", "漏", "缺",
)
_UPGRADE_HINTS = ("用词", "升级", "口语", "替换", "地道", "高级", "词汇", "表达", "书面", "正式")
_CULTURE_HINTS = (
    "文化", "专有名词", "术语", "负载", "名称", "机构", "节日", "朝代", "遗址", "遗产",
    "称谓", "地名", "品牌", "固有", "专名", "习俗", "典故",
)


def _classify_writing_fix(reason: str, original: str, improved: str) -> str:
    r = (reason or "").lower()
    if any(k in r for k in _GRAMMAR_HINTS):
        return "chinglish"
    if any(k in r for k in _UPGRADE_HINTS):
        return "upgrade"
    # 短替换 → 升级词；整句改写 → 句型
    if len(original) <= 28 and len(improved) <= 28:
        return "upgrade"
    return "sentence"


def extract_writing_gems(fixes: list[Any]) -> list[dict[str, str]]:
    """从写作演示的 fixes 里抽出精华，归到 chinglish / upgrade / sentence 三栏。"""
    gems: list[dict[str, str]] = []
    for f in fixes or []:
        if not isinstance(f, dict):
            continue
        original = str(f.get("original") or "").strip()
        improved = str(f.get("improved") or "").strip()
        reason = str(f.get("reason") or "").strip()
        if not original or not improved:
            continue
        gems.append(
            {
                "module": _classify_writing_fix(reason, original, improved),
                "source_text": original,
                "target_text": improved,
                "reason": reason,
            }
        )
    return gems


def extract_translation_gems(notes: list[Any]) -> list[dict[str, str]]:
    """从翻译演示的 notes 里抽出精华，归到 culture / phrase 两栏。"""
    gems: list[dict[str, str]] = []
    for n in notes or []:
        if not isinstance(n, dict):
            continue
        zh = str(n.get("zh") or "").strip()
        en = str(n.get("en") or "").strip()
        reason = str(n.get("reason") or "").strip()
        if not zh or not en:
            continue
        module = "culture" if any(k in (reason or "").lower() for k in _CULTURE_HINTS) else "phrase"
        gems.append({"module": module, "source_text": zh, "target_text": en, "reason": reason})
    return gems




# ============================================================================
# 十二、演示题库（给「懒得输入」的用户一条龙：出题 → 写 → 自评）
# ============================================================================
#
# 设计：题型与题目由算法定，模型只负责把范文写出来；模型不可用时直接用这里的
# 种子范文 / 参考译文，功能不塌。种子内容按本模块自己的评分规则写过一遍，
# 保证「演示」出来的东西是能拿分的样板，而不是凑数的占位文本。

WRITING_DEMO_BANK: list[dict[str, Any]] = [
    {
        "template_id": "tpl_phenomenon",
        "topic_zh": "短视频平台在大学生中的流行",
        "topic_en": "The Growing Popularity of Short Video Platforms Among College Students",
        "seed_essay": (
            "The growing popularity of short video platforms among college students has sparked "
            "considerable debate in recent years. From my perspective, this trend is a double-edged "
            "sword that calls for rational use rather than simple rejection.\n\n"
            "The fundamental cause of this phenomenon lies in the intense pressure students face in "
            "daily study. A case in point is that a ten-minute video offers instant relief after a long "
            "lecture. Moreover, algorithms on these platforms learn individual preferences with "
            "remarkable accuracy. Consequently, users are kept scrolling far longer than they originally "
            "intended. In other words, convenience and precision together make these apps hard to resist.\n\n"
            "Moreover, this habit exerts a profound influence on academic performance. Students who watch "
            "videos late at night often struggle to concentrate in morning classes. This is because "
            "fragmented attention weakens the ability to follow complex arguments. Nevertheless, the "
            "platforms are not purely harmful. Carefully chosen documentaries and lectures can broaden "
            "horizons at almost no cost.\n\n"
            "In conclusion, short videos deserve neither blind worship nor wholesale condemnation. Only by "
            "setting a firm time limit can we enjoy their benefits without paying for them academically."
        ),
    },
    {
        "template_id": "tpl_contrast",
        "topic_zh": "大学生该不该做兼职",
        "topic_en": "Should College Students Take Part-time Jobs?",
        "seed_essay": (
            "Whether college students should take part-time jobs has long been a controversial issue on "
            "campus. Some regard such jobs as valuable preparation for the workplace, while others insist "
            "that they distract students from study.\n\n"
            "Those who support part-time work argue that it builds practical competence. A case in point is "
            "that a student working in a cafe learns to handle complaints calmly. Furthermore, early contact "
            "with employers helps graduates adapt to professional culture. In addition, the income earned "
            "reduces the financial burden on families. Admittedly, such benefits depend on how many hours "
            "are devoted to the job.\n\n"
            "Opponents, however, emphasize the hidden cost of such experience. Many students who work more "
            "than twenty hours a week report falling grades. Consequently, a job taken for short-term gain "
            "may damage long-term prospects. In contrast, scholarships and research projects reward academic "
            "effort far more generously. Therefore, the priority of a student should remain clear.\n\n"
            "All things considered, a part-time job is beneficial only when it is kept within reasonable "
            "limits. Students should weigh the trade-off carefully instead of following the crowd."
        ),
    },
    {
        "template_id": "tpl_quote",
        "topic_zh": "名言评论：天才是一分灵感加九十九分汗水",
        "topic_en": "Comment on \"Genius Is One Percent Inspiration and Ninety-nine Percent Perspiration\"",
        "seed_essay": (
            "Thomas Edison once remarked that genius is one percent inspiration and ninety-nine percent "
            "perspiration. This remark reminds us that sustained effort, rather than natural talent, decides "
            "how far a person can go.\n\n"
            "The value of persistence is evident in almost every field of achievement. A case in point is "
            "that athletes repeat a single movement thousands of times before winning a medal. Similarly, "
            "researchers often endure years of failed experiments before a discovery emerges. This is because "
            "difficult problems rarely yield to a single attempt. Therefore, the willingness to continue "
            "matters more than a brilliant start.\n\n"
            "Nevertheless, effort alone is not enough without direction. Hard work devoted to a wrong method "
            "may simply waste energy. What is more, reflection allows a learner to adjust the approach in "
            "time. In other words, persistence and strategy should support each other. Only then does effort "
            "translate into genuine progress.\n\n"
            "To sum up, talent provides a starting point while persistence determines the destination. Only "
            "by combining steady effort with constant reflection can we turn potential into achievement."
        ),
    },
    *ADVANCED_WRITING_SEEDS,
]

TRANSLATION_DEMO_BANK: list[dict[str, Any]] = [
    {
        "category": "历史制度",
        "title": "科举制度",
        "source": (
            "科举制度创立于隋朝，在中国延续了1300多年。它被认为是世界上最早的考试制度之一，"
            "为中国古代社会提供了选拔人才的途径。随着时代的变迁，这一制度逐渐退出历史舞台，"
            "但它对中国文化的影响延续至今。"
        ),
        "reference": (
            "The imperial examination system was founded in the Sui Dynasty and lasted for more than 1,300 "
            "years in China. It is regarded as one of the earliest examination systems in the world, "
            "providing a channel for selecting talented people in ancient Chinese society. With the passage "
            "of time, this system gradually withdrew from the stage of history, yet its influence on Chinese "
            "culture continues to this day."
        ),
    },
    {
        "category": "传统文化",
        "title": "京剧",
        "source": (
            "京剧是中国影响最大的戏曲剧种，至今已有200多年的历史。它融合了唱、念、做、打四种表演形式，"
            "被誉为中国国粹。2010年，京剧被列入联合国教科文组织人类非物质文化遗产代表作名录。"
        ),
        "reference": (
            "Peking Opera is the most influential form of traditional Chinese opera, with a history of more "
            "than 200 years. It combines four performing skills, namely singing, recitation, acting and "
            "acrobatic fighting, and is honored as the quintessence of Chinese culture. In 2010, it was "
            "inscribed on the UNESCO Representative List of the Intangible Cultural Heritage of Humanity."
        ),
    },
    {
        "category": "民俗节日",
        "title": "中秋节",
        "source": (
            "中秋节在每年农历八月十五，是中国最重要的传统节日之一。这一天，家人团聚在一起赏月、吃月饼，"
            "表达对团圆的期盼。中秋节于2006年被列入第一批国家级非物质文化遗产名录。"
        ),
        "reference": (
            "The Mid-Autumn Festival falls on the fifteenth day of the eighth lunar month and is one of the "
            "most important traditional festivals in China. On this day, families gather to admire the full "
            "moon and eat mooncakes, expressing their longing for reunion. In 2006, it was included in the "
            "first batch of national intangible cultural heritage."
        ),
    },
    {
        "category": "地理景观",
        "title": "苏州园林",
        "source": (
            "苏州园林是中国古典园林的代表，始建于春秋时期。这些园林以精巧的设计著称，"
            "把建筑、山水和花木巧妙地融为一体。1997年，部分苏州园林被列入世界文化遗产名录。"
        ),
        "reference": (
            "Suzhou Classical Gardens are representatives of classical Chinese gardens and date back to the "
            "Spring and Autumn Period. These gardens are known for their exquisite design, which skillfully "
            "integrates architecture, landscape and plants into a whole. In 1997, some of them were inscribed "
            "on the World Cultural Heritage List."
        ),
    },
    {
        "category": "经济社会",
        "title": "中国高铁",
        "source": (
            "中国高铁运营里程已超过4万公里，居世界第一位。它不仅极大地缩短了城市之间的旅行时间，"
            "也被视为中国科技创新的一张名片。随着高铁网络的不断完善，越来越多的人选择这种绿色出行方式。"
        ),
        "reference": (
            "China's high-speed railway has more than 40,000 kilometers in operation, ranking first in the "
            "world. It not only greatly shortens travel time between cities but is also regarded as a calling "
            "card of China's technological innovation. With the continuous improvement of the network, more "
            "and more people are choosing this green way of travel."
        ),
    },
    *ADVANCED_TRANSLATION_SEEDS,
]


def demo_writing_types() -> list[dict[str, str]]:
    """可出题的作文题型清单，给前端做「按题型演示」的选项。同题型只出一个，避免 chip 重复。"""
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in WRITING_DEMO_BANK:
        if item["template_id"] in seen:
            continue
        seen.add(item["template_id"])
        tpl = next((t for t in WRITING_TEMPLATES if t["id"] == item["template_id"]), None)
        out.append(
            {
                "id": item["template_id"],
                "name": tpl["name"] if tpl else item["template_id"],
                "topic_zh": item["topic_zh"],
                "topic_en": item["topic_en"],
            }
        )
    return out


def demo_translation_categories() -> list[dict[str, str]]:
    """可出题的翻译标签清单。同标签只出一个，避免 chip 重复。"""
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for d in TRANSLATION_DEMO_BANK:
        if d["category"] in seen:
            continue
        seen.add(d["category"])
        out.append({"category": d["category"], "title": d["title"]})
    return out


def writing_demo_seed(template_id: str = "") -> dict[str, Any]:
    """挑一道题 + 一篇种子范文，并把范文过一遍规则体检。

    模型可用时 api 层会拿这份种子去「重写」；模型不可用时这就是最终结果，
    所以这里返回的范文本身是能拿分的样板，不是占位文本。
    """
    picked = next((d for d in WRITING_DEMO_BANK if d["template_id"] == template_id), None)
    if picked is None:
        picked = random.choice(WRITING_DEMO_BANK)
    tpl = next((t for t in WRITING_TEMPLATES if t["id"] == picked["template_id"]), None)
    return {
        "ok": True,
        "ai_generated": False,
        "template_id": picked["template_id"],
        "template_name": tpl["name"] if tpl else "",
        "topic_zh": picked["topic_zh"],
        "topic_en": picked["topic_en"],
        "essay": picked["seed_essay"],
        "rule_report": check_writing(picked["seed_essay"]),
        "notice": "这是题库自带的范文。想看它怎么按评分标准自我升级，点「AI 升格」。",
    }


def translation_demo_seed(category: str = "") -> dict[str, Any]:
    """挑一段文化类中文段落 + 参考译文，并给出三步法引导与参考译文体检。

    段落固定取自题库（这样三步法引导才有确定的考点可讲），模型只负责另译一版
    供对照；模型不可用时参考译文就是最终结果。
    """
    picked = next((d for d in TRANSLATION_DEMO_BANK if d["category"] == category), None)
    if picked is None:
        picked = random.choice(TRANSLATION_DEMO_BANK)
    return {
        "ok": True,
        "ai_generated": False,
        "category": picked["category"],
        "title": picked["title"],
        "source": picked["source"],
        "target": picked["reference"],
        "reference": picked["reference"],
        "guide": guide_translation(picked["source"]),
        "check": check_translation(picked["source"], picked["reference"]),
        "notice": "这是题库自带的参考译文，可对照三步法引导看它怎么落笔。",
    }
