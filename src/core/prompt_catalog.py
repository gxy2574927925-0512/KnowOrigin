# -*- coding: utf-8 -*-
"""提示词目录。

「提示词实验室」用这张表把 core/llm.py 里的 AI 任务翻译成人能读的清单：
每个任务叫什么、属于哪个功能、在干什么。

设计取向：
- **只是目录，不是第二份真值**。提示词本体仍然只有 core/llm.py 一处（出厂默认）；
  用户改写存到 core/prompt_overrides.py，这里只放名称与说明，避免三处维护导致漂移。
- 端点拿到任务名后调用 llm._system_prompt(task)，与真实调用走同一条路，
  因此「实验室里看到的就是实际用的」—— 但只在 ``source="system"`` 时成立，见下。
- 目录必须与真实调用对齐：新增任务要同步登记，停止调用的任务要标 ``retired``。
  **手工维护必然漂移**，所以对齐不靠自觉，靠 ``tools/check_prompt_catalog.py``：
  它用 AST 扫出代码里所有 complete_json / 流式调用的任务名，与这张表对拍，
  漏登记直接报红。当前登记 55 个任务。

``source`` 字段：这段提示词到底归谁管（决定「实验室里改了生不生效」）
- ``"system"``（默认）：提示词在 core/llm.py，走 _system_prompt。实验室所见即所用，
  改写立即对真实调用生效。
- ``"payload"``：主导指令**随每次请求的具体内容**一起下发（payload.system_prompt /
  instruction / prompt 里）。实验室这里展示与改写的是 system 人设，它会生效，
  但不是主导；真正的命题/改写指令在调用方代码里。
- ``"external"``：调用方自己拼 messages，根本不过 _system_prompt —— 任务名只用于
  日志与 max_tokens 分档。**实验室的改写对这个任务不生效**，界面会明确标出来，
  不让人白改一场。

``merged_into`` 字段：**这个任务当前没有独立调用点** —— 注意是「这个任务」没有，
不是「这个功能」没了。功能多半还在，只是换了实现或并入了别的任务，这里填那个任务的
``task`` 名，界面显示它的 label 并说明「功能由 X 承担」。保留登记是为了不丢信息，
界面单独标注，不冒充在跑的任务。
**措辞别写成「停用 / 下线 / 废弃」** —— 那会让人以为功能被删了（2026-09-28 踩过）。
"""

from __future__ import annotations

# 分组顺序即界面展示顺序
PROMPT_GROUPS = [
    "资料解析",
    "知识框架",
    "学习搭子",
    "卡片与测验",
    "学习问答",
    "英语学习",
    "英语精练",
    "文献精读",
    "文献检索",
    "研究洞察",
    "学情洞察",
    "后台与记忆",
]

PROMPT_TASKS: list[dict[str, str]] = [
    # —— 资料解析 ——
    {
        "task": "extract_source_image",
        "label": "图片与手写笔记转写",
        "group": "资料解析",
        "desc": "把资料里的图片、手写笔记转成文字，公式还原为标准 LaTeX。",
    },
    {
        "task": "extract_paper_metadata",
        "label": "论文元数据抽取",
        "group": "资料解析",
        "desc": "从论文正文里抽出标题、作者、年份等元信息（文献模式下用）。",
    },
    # —— 知识框架 ——
    {
        "task": "build_framework",
        "label": "生成知识框架",
        "group": "知识框架",
        "desc": "把导入的资料结构化成知识点节点树，每个节点带来源与描述。",
    },
    {
        "task": "build_prereq",
        "label": "补建前置关系",
        "group": "知识框架",
        "desc": "给已有知识点补上「必须先学哪个才学得会」的前置边。只给建议、不落库，需人工确认。",
    },
    {
        "task": "extract_knowledge_points",
        "label": "抽取考点",
        "group": "知识框架",
        "desc": "按「概念/定义/公式/方法/对比/优缺点/种类/条件应用」等角度抽出考点，用于出题。",
    },
    # —— 学习搭子 ——
    {
        "task": "organize_note",
        "label": "整理助手 · 笔记建议稿",
        "group": "学习搭子",
        "desc": "给当前节点写一版笔记建议，用户挑、用户批准，AI 不直接落库。"
        "功能仍在（整理助手的「补全当前节点笔记」），但那一步现在直接调「补全笔记（细节版）」，"
        "这一档没有独立调用点，提示词保留备用。",
        "merged_into": "organize_note_detail",
    },
    {
        "task": "organize_note_detail",
        "label": "整理助手 · 补全笔记（细节版）",
        "group": "学习搭子",
        "desc": "在建议稿基础上补全核心概念、物理图像、要点与详解。",
    },
    {
        "task": "recommend_link_gaps",
        "label": "整理助手 · 推荐双链与缺失节点",
        "group": "学习搭子",
        "desc": "扫描整库，推荐值得建立连接的知识点对，并找出该补进来的缺失知识点。",
    },
    {
        "task": "link_note",
        "label": "双链图谱 · 起草关系理解",
        "group": "学习搭子",
        "desc": "在图谱上点开一对双链时，起草一句「这两个知识点之间是什么关系」的理解。",
    },
    {
        "task": "recommend_deep_questions",
        "label": "整理助手 · 挖深问题",
        "group": "学习搭子",
        "desc": "围绕当前节点提出更值得深究的问题，引导往深处走。",
    },
    {
        "task": "node_explain",
        "label": "节点 AI 解释",
        "group": "学习搭子",
        "desc": "解释来源视图里的任一节点（知识点 / 资料 / 笔记）：要点、与库内其它内容的关系、易混点与下一步。",
    },
    {
        "task": "socratic_guide",
        "label": "苏格拉底引导 · 反问",
        "group": "学习搭子",
        "desc": "只反问、不直接给答案，按难度阶梯逐级提示。"
        "功能仍在（苏格拉底引导界面照常可用），但引导口径现在由「学习问答」的教学模式阶梯承担"
        "（引导档 / 严格档），这个任务没有独立调用点。",
        "merged_into": "answer_question",
    },
    {
        "task": "socratic_assess",
        "label": "苏格拉底引导 · 判定",
        "group": "学习搭子",
        "desc": "判断学生这一轮的回答是否真正说到了点上。"
        "同上：判定也并进了「学习问答」的教学模式链路，这个任务没有独立调用点。",
        "merged_into": "answer_question",
    },
    {
        "task": "sprint_plan_content",
        "label": "冲刺计划 · 每日任务文案",
        "group": "学习搭子",
        "desc": "算法定好排期骨架后，由 AI 把每天任务的标题、做法与安排理由写具体、写可执行。",
    },
    {
        "task": "discussion_speak",
        "label": "圆桌讨论 · 角色发言",
        "group": "学习搭子",
        "source": "external",
        "desc": "多人圆桌讨论里，让某个角色（含立场与人设）就当前议题发言一段。"
        "提示词由讨论模块按角色现场拼装（人设 + 议题 + 引文 + 本轮指令），不走这里的 system。",
    },
    # —— 卡片与测验 ——
    {
        "task": "generate_cards",
        "label": "批量生成知识卡片",
        "group": "卡片与测验",
        "desc": "一次生成一组可翻面卡片，正面设问、背面来源依据与关键解释。",
    },
    {
        "task": "generate_card_item",
        "label": "生成单张知识卡片",
        "group": "卡片与测验",
        "desc": "针对某个节点单独出一张卡片。",
    },
    {
        "task": "generate_cards_loose",
        "label": "知识卡片（无框架兜底）",
        "group": "卡片与测验",
        "desc": "还没有知识框架时，直接从资料原文生成卡片。",
    },
    {
        "task": "generate_quiz",
        "label": "批量生成小测验",
        "group": "卡片与测验",
        "desc": "生成一整套测验题，含选项置信度与「来源依据 + 关键解释」。",
    },
    {
        "task": "generate_quiz_item",
        "label": "生成单道测验题",
        "group": "卡片与测验",
        "desc": "针对某个节点单独出一道题。",
    },
    {
        "task": "generate_quiz_loose",
        "label": "小测验（无框架兜底）",
        "group": "卡片与测验",
        "desc": "还没有知识框架时，直接从资料原文出题。",
    },
    {
        "task": "node_card",
        "label": "按知识点批量出卡",
        "group": "卡片与测验",
        "source": "payload",
        "desc": "选中一个知识点，让它自己拆出若干不同考点、每个考点出一张卡片，并避开已经出过的。",
    },
    {
        "task": "node_quiz",
        "label": "按知识点批量出题",
        "group": "卡片与测验",
        "source": "payload",
        "desc": "同上，但出的是测验题，题型由调用方限定，同样避开已覆盖考点。",
    },
    {
        "task": "transfer_variant",
        "label": "换个情境试试 · 迁移题",
        "group": "卡片与测验",
        "desc": (
            "出一道「同一个结构换一张皮」的迁移题：源例与目标例并排，"
            "并强制给出逐项对齐表。距离分近/中/远三档（换条件 / 换表征 / 换领域）。"
        ),
    },
    {
        "task": "concept_align",
        "label": "跨课程概念对齐",
        "group": "卡片与测验",
        "desc": (
            "把本项目的知识点术语对齐到你在**别的项目**里已经学过的概念，"
            "用于跨课程/跨学科的迁移推荐。默认不运行，需手动触发。"
        ),
    },
    # —— 学习问答 ——
    {
        "task": "answer_question",
        "label": "学习问答（对话区）",
        "group": "学习问答",
        "desc": "以 RAG 方式优先检索你上传的资料作答并标注出处，走 SSE 流式。",
    },
    {
        "task": "solve_problem",
        "label": "拍照解题",
        "group": "学习问答",
        "desc": "先识别题目截图中的全部信息，再按资料作答。",
    },
    {
        "task": "agent_chat",
        "label": "工具型 Agent 对话",
        "group": "学习问答",
        "source": "external",
        "desc": "会自己调工具（检索、查库）再作答的对话链路，走 SSE 流式。"
        "人设与工具说明由 agent 模块自己拼进 messages，任务名只用于日志与长度分档。",
    },
    # —— 英语学习 ——
    {
        "task": "corpus_excerpt",
        "label": "语料摘录 · 转英文表述",
        "group": "英语学习",
        "desc": "把中文资料片段转写成英文表述，给出核心术语的中英对照，并整理一份通顺完整的中文稿供对照阅读。",
    },
    {
        "task": "english_word_extras",
        "label": "词汇拓展 · 单词",
        "group": "英语学习",
        "desc": "给单个单词补齐词典查不到的实用信息：例句、近/反义词（带辨析）、常见搭配。"
        "功能仍在（单词详情页照常出拓展），但单个词也是走批量接口（词表长度 1），"
        "这一档没有独立调用点。",
        "merged_into": "english_word_extras_batch",
    },
    {
        "task": "english_word_extras_batch",
        "label": "词汇拓展 · 批量",
        "group": "英语学习",
        "desc": "一次为多个单词生成例句、近/反义词与搭配，结果与输入词表逐个对齐。",
    },
    {
        "task": "english_round_story",
        "label": "词汇联想 · 联结短文",
        "group": "英语学习",
        "desc": "把刚刷完的一轮单词串成一篇联结短文与助记故事，词词有画面、句句可回忆。",
    },
    # —— 英语精练 ——
    # 这一组都是「指令随内容下发」型：命题/拆解要求写在 payload.system_prompt 里，
    # 因为里面要带上本次要处理的句子或篇章，没法脱离输入单独存在。
    {
        "task": "english_syntax_parse",
        "label": "长难句手术刀拆解",
        "group": "英语精练",
        "source": "payload",
        "desc": "按田静长难句拆解法把句子拆成主干与各类从句成分，标出逻辑信号与应试点拨。",
    },
    {
        "task": "english_selection_translate",
        "label": "划选片段翻译",
        "group": "英语精练",
        "source": "payload",
        "desc": "翻译阅读里划选的片段；遇到长难句时译文要体现拆分后的逻辑层次，并点出熟词生义与指代。",
    },
    {
        "task": "english_paraphrase_extract",
        "label": "真题同义替换对抽取",
        "group": "英语精练",
        "source": "payload",
        "desc": "比对原文与题目选项，抽出全部同义替换对，并总结这题的命题替换规律。",
    },
    {
        "task": "english_paraphrase_rewrite",
        "label": "句子同义改写",
        "group": "英语精练",
        "source": "payload",
        "desc": "把一个句子改写成多个语义等价、像阅读选项那样的表达，并说明每一步凭什么等价。",
    },
    {
        "task": "english_collocation_extract",
        "label": "外刊固定搭配提取",
        "group": "英语精练",
        "source": "payload",
        "desc": "从一篇英文里挑值得记的固定搭配（动/介/名词短语），补本地规则库没命中的冷门搭配。",
    },
    {
        "task": "english_exam_generate_reading",
        "label": "生成外刊精读篇章",
        "group": "英语精练",
        "source": "payload",
        "desc": "按考研真题 Part A 的难度命题：正文 + 精译 + 长难句 + 同义替换链 + 一道带陷阱剖析的四选一。",
    },
    {
        "task": "english_writing_polish",
        "label": "作文批改与升级",
        "group": "英语精练",
        "source": "payload",
        "desc": "对一整篇作文做批改：升级后的全文、逐处改动说明与结构骨架建议。",
    },
    {
        "task": "english_writing_demo",
        "label": "写作范文生成",
        "group": "英语精练",
        "source": "payload",
        "desc": "按选定模板与题目生成一版范文，作为可对照的示范。",
    },
    {
        "task": "english_translation_demo",
        "label": "翻译示范生成",
        "group": "英语精练",
        "source": "payload",
        "desc": "按选定类别生成一段翻译示范，逐句给出处理理由。",
    },
    # —— 文献精读 ——
    {
        "task": "rearrange_paper",
        "label": "文献版面重排",
        "group": "文献精读",
        "desc": "把 PDF 提取出的碎片正文重排成可读结构，并把公式转成可渲染 LaTeX。",
    },
    {
        "task": "repair_formulas",
        "label": "公式修复",
        "group": "文献精读",
        "desc": "修复提取过程中识别坏掉的公式。",
    },
    {
        "task": "translate_section",
        "label": "全文翻译 / 划词翻译",
        "group": "文献精读",
        "desc": "中英对照逐段翻译，保留公式与图表的原始位置。",
    },
    {
        "task": "compare_papers",
        "label": "多文献对比",
        "group": "文献精读",
        "desc": "按研究问题、方法路线、核心贡献、实验结果、局限性等维度生成对比报告。",
    },
    {
        "task": "attach_literature",
        "label": "并入知识网 · 概念归位",
        "group": "文献精读",
        "desc": "把文献对比结论并入课程知识网时，判断这份结论真正讲到了知识框架里的哪些已有概念。",
    },
    {
        "task": "ask_paper",
        "label": "文献问答",
        "group": "文献精读",
        "desc": "针对单篇论文的提问，答案锚定该文正文。",
    },
    {
        "task": "paper_insights",
        "label": "阅读重点提取",
        "group": "文献精读",
        "desc": "逐节提取核心要点，每条带中文摘要与对应英文原文引文。",
    },
    # —— 文献检索 ——
    {
        "task": "paper_query_plan",
        "label": "检索词理解（查询规划）",
        "group": "文献检索",
        "source": "payload",
        "desc": "把用户想找的中文主题转成英文学术检索词与学科名，供多源检索使用。"
        "弱模型上跑，提示词刻意只留当前这一支动作 + 3 条硬约束。",
    },
    {
        "task": "paper_deep_analysis",
        "label": "论文六维深度解析",
        "group": "文献检索",
        "source": "payload",
        "desc": "用标题+摘要生成 TL;DR、研究动机、方法路线、定量指标、局限性与答辩话术六段解析；"
        "配置科研画像后额外输出方向相关度与阅读建议；模型不可用时有离线兜底。",
    },
    # —— 研究洞察 ——
    {
        "task": "research_insights",
        "label": "AI 研究洞察",
        "group": "研究洞察",
        "desc": "通读整个知识库，给出可写进综述的论断、资料间的张力、知识空白与下一步研究问题。",
    },
    {
        "task": "extract_evidence_matrix",
        "label": "综述矩阵提取（PRISMA）",
        "group": "研究洞察",
        "desc": "按 PRISMA 规范横向抽取多篇论文的动机、方法、数据条件、定量结果与局限，生成综述矩阵。",
    },
    {
        "task": "peer_reviewer_critique",
        "label": "模拟同行评审（红队）",
        "group": "研究洞察",
        "desc": "以顶刊/顶会审稿人视角红队评审：四维打分、致命弱点与给作者的问题。",
    },
    # —— 学情洞察 ——
    {
        "task": "make_knowledge_doc",
        "label": "生成知识点文档",
        "group": "学情洞察",
        "desc": "把单个知识点展开成复习用详解：承接与递进、定义与符号约定、推导与机制、"
        "公式与用法、易错点、与相邻知识点的关系、自测；可按框架层级合订成整份知识文档。",
    },
    {
        "task": "ask_knowledge_doc",
        "label": "知识点文档·选中提问",
        "group": "学情洞察",
        "desc": "在知识点文档里选中一段原文就地提问：只依据该节正文与选区上下文作答，"
        "材料里没写的直说没写，需要推断时标注依据。",
    },
    {
        "task": "make_study_kit",
        "label": "生成速查表 / 学习路径",
        "group": "学情洞察",
        "desc": "把整章压成一页可打印的速查表，或给出前置知识、下一步方向与可推断的资源。",
    },
    {
        "task": "detect_conflicts",
        "label": "资料矛盾扫描",
        "group": "学情洞察",
        "desc": "找出多份资料之间互相矛盾的地方，两边各附原文摘录；只呈现分歧，不做裁决。",
    },
    {
        "task": "kb_digest",
        "label": "知识库周报式摘要",
        "group": "学情洞察",
        "source": "payload",
        "desc": "通读整库节点，产出一份「现在学得怎么样」的结构化摘要。"
        "注：调用时只发结构化数据（节点 + 本地统计），payload 里没有文字指令，"
        "输出格式目前全靠模型按字段名推断 —— 这是已知的提示词缺口，可在这里补一段 system 人设。",
    },
    {
        "task": "suggest_review",
        "label": "优先复习建议 · AI 生成",
        "group": "学情洞察",
        "desc": "把进步引擎选出的下一步候选（按桶各取一个），逐条改写成一句有依据、可执行的个性化复习建议；"
        "算法定骨架（选谁、分哪个桶），模型只写文案，不得增删重排候选，也无 API Key 时回退规则模板文案。",
    },
    {
        "task": "node_study_plan",
        "label": "节点补课规划",
        "group": "学情洞察",
        "source": "payload",
        "desc": "针对一个「还没被资料覆盖 / 没有可用材料」的知识节点，生成该节点的具体讲解、一份 3~5 步学习规划，"
        "并说清还缺什么材料（资料类型与检索关键词）。讲解诚实标注是模型通识还是来源原文。",
    },
    # —— 后台与记忆 ——
    {
        "task": "extract_user_memory",
        "label": "长期记忆提取",
        "group": "后台与记忆",
        "source": "external",
        "desc": "后台定期读近期对话，提炼值得长期记住的用户事实；提示词由记忆模块自己拼，"
        "且提取失败不影响任何主流程。",
    },
    {
        "task": "weekly_report",
        "label": "学习周报生成",
        "group": "后台与记忆",
        "source": "external",
        "desc": "按一周学习统计生成一封鼓励式的周报；提示词在通知模块里，无统计时走本地文案兜底。",
    },
]

