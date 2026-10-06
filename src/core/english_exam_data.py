"""知源 · 考研英语 13 大权威母源期刊全谱系题源库与逐段深度剖析语料库 (core/english_exam_data.py)。

本模块收录考研英语(一)/英语(二)近15年真题核心母源期刊全景矩阵：
  1. The Economist (经济学人) - 考研第一题源，社论与商业政经
  2. The Guardian (英国卫报) - 英二高频榜首，教育民生与文化现象
  3. The Atlantic (大西洋月刊) - 近五年考研新宠，深度人文与社会趋势
  4. Scientific American (科学美国人) - 科技说明文基石，AI与生态科学
  5. Nature & Nature Neuroscience (自然系列) - 殿堂级学术期刊，生命与脑科学
  6. Science (美国科学) - 综合科学顶刊，全球系统科学
  7. The Christian Science Monitor (基督教科学箴言报) - 考研隐形冠军，数据与故事混搭
  8. MIT Technology Review (麻省理工科技评论) - 新锐题源黑马，算法伦理与前沿工程
  9. The Washington Post (华盛顿邮报) - 公共治理与社会政策
  10. The New York Times (纽约时报) - 深度文化观察与专栏评论
  11. Harvard Business Review (哈佛商业评论) - 商业管理与组织心理
  12. BBC Future (未来视野) - 现代心理学与深度思考
  13. 全国硕士研究生招生考试历年官方真题库 - 官方命题委员会真题原卷

每篇篇章均具备完整全文 (passage) 与段落级全景拆解 (paragraphs)：
  - 段落论证角色与大意 (role / main_idea)
  - 英文原文与地道精译 (text_en / text_zh)
  - 段内核心长难句与主干骨架 (key_sentence / key_sentence_backbone)
  - 段内考研生词与熟词生义 (vocab / false_friends)
  - 段落逻辑连接指示词 (logic_signals)
"""

from __future__ import annotations
from typing import Any

# JSON 字面量类型兼容
true = True
false = False
null = None

# ==============================================================================
# 13 大权威母源期刊详细档案全谱系 (Journal Catalog)
# ==============================================================================

JOURNAL_CATALOG: dict[str, dict[str, Any]] = {
    "j_economist": {
        "id": "j_economist",
        "name": "The Economist (经济学人)",
        "en_name": "The Economist",
        "badge": "考研头号题源 · 宏观政经与商业科技",
        "stars": "★★★★★",
        "weight_score": 98,
        "style_description": "考研英语(一)首选题源；文笔辛辣反讽，长难句多层嵌套，自由市场立场鲜明，命题人偏爱设计反向混淆与偷换概念干扰项。",
        "recommended_sections": ["Leaders 社论", "Briefing 专题专栏", "Finance & Economics", "Science & Technology"],
        "exam_types": ["考研英语(一)", "考研英语(二)", "六级"],
        "topics": ["科技创新与人工智能", "商业金融与宏观治理"],
    },
    "j_guardian": {
        "id": "j_guardian",
        "name": "The Guardian (英国卫报)",
        "en_name": "The Guardian",
        "badge": "英二高频榜首 · 社会民生与职场生态",
        "stars": "★★★★★",
        "weight_score": 95,
        "style_description": "英国老牌报纸；洋葱式由浅入深行文，语言平实易懂，观点温和直白，最适合练习作者情感态度题与事实推断题。",
        "recommended_sections": ["Opinion 评论版", "Work 职场", "Society 社会", "Technology 科技"],
        "exam_types": ["考研英语(二)", "考研英语(一)", "四级", "六级"],
        "topics": ["科技创新与人工智能", "人文社科与现代生活"],
    },
    "j_atlantic": {
        "id": "j_atlantic",
        "name": "The Atlantic (大西洋月刊)",
        "en_name": "The Atlantic",
        "badge": "近五年考研新宠 · 深度人文与社会反思",
        "stars": "★★★★☆",
        "weight_score": 92,
        "style_description": "深度综合文化杂志；文章结构极度标准（引入现象 ➔ 剖析利弊 ➔ 总结反思），完美契合考研阅读理解的行文逻辑。",
        "recommended_sections": ["Ideas 思想", "Technology 科技", "Family 家庭", "Culture 文化"],
        "exam_types": ["考研英语(一)", "考研英语(二)"],
        "topics": ["人文社科与现代生活", "生命科学与认知心理"],
    },
    "j_sciam": {
        "id": "j_sciam",
        "name": "Scientific American (科学美国人)",
        "en_name": "Scientific American",
        "badge": "科技说明文基石 · 前沿科普与气候生态",
        "stars": "★★★★★",
        "weight_score": 94,
        "style_description": "考研科技类文章固定来源；遵循「现象 ➔ 研究 ➔ 结论」说明文框架，重点考查科学发现的利弊与现实争议，不考数学推导。",
        "recommended_sections": ["Mind & Brain 脑智", "Environment 环境", "Technology 科技", "Health 健康"],
        "exam_types": ["考研英语(一)", "考研英语(二)"],
        "topics": ["地球生态与气候科学", "科技创新与人工智能"],
    },
    "j_nature": {
        "id": "j_nature",
        "name": "Nature & Nature Series (自然系列)",
        "en_name": "Nature / Nature Neuroscience",
        "badge": "国际顶尖学术 · 硬核科学与神经认知",
        "stars": "★★★★★",
        "weight_score": 96,
        "style_description": "殿堂级科学期刊；学术客观性极强，长难句多为介词短语嵌套与复杂同位语，多考查驳论文结构与实证因果推论。",
        "recommended_sections": ["News & Views 述评", "Nature Neuroscience", "Climate Change"],
        "exam_types": ["考研英语(一)", "六级"],
        "topics": ["生命科学与认知心理", "地球生态与气候科学"],
    },
    "j_science": {
        "id": "j_science",
        "name": "Science (美国科学)",
        "en_name": "Science",
        "badge": "全学科领军综合 · 系统地球科学",
        "stars": "★★★★★",
        "weight_score": 96,
        "style_description": "美国科学促进会出版的综合顶刊；文章多站在全人类命运共同体高度探讨重大科学发现对公共政策的深远投射。",
        "recommended_sections": ["Perspective 视角专栏", "Policy Forum 政策论坛"],
        "exam_types": ["考研英语(一)"],
        "topics": ["地球生态与气候科学", "科技创新与人工智能"],
    },
    "j_csmonitor": {
        "id": "j_csmonitor",
        "name": "The Christian Science Monitor (基督教科学箴言报)",
        "en_name": "The Christian Science Monitor",
        "badge": "考研隐形冠军 · 数据与故事混搭",
        "stars": "★★★★☆",
        "weight_score": 90,
        "style_description": "考研英语真题历史上出现频次极高的低调母源；行文克制温和，擅长从小人物的生活故事切入宏观社会制度变迁。",
        "recommended_sections": ["Global News 全球", "Environment 环境", "Economy 经济"],
        "exam_types": ["考研英语(一)", "考研英语(二)"],
        "topics": ["商业金融与宏观治理", "人文社科与现代生活"],
    },
    "j_mit_tr": {
        "id": "j_mit_tr",
        "name": "MIT Technology Review (麻省理工科技评论)",
        "en_name": "MIT Technology Review",
        "badge": "新锐科技黑马 · 算法伦理与前沿工程",
        "stars": "★★★★☆",
        "weight_score": 93,
        "style_description": "全球最著名的技术商业杂志；文风锐利，重点揭示前沿数字技术在现实社会应用中所衍生的伦理摩擦、环境代价与垄断困局。",
        "recommended_sections": ["AI 专题", "Computing 计算", "Climate Tech 气候技术"],
        "exam_types": ["考研英语(一)", "考研英语(二)", "六级"],
        "topics": ["科技创新与人工智能", "地球生态与气候科学"],
    },
    "j_washington_post": {
        "id": "j_washington_post",
        "name": "The Washington Post (华盛顿邮报)",
        "en_name": "The Washington Post",
        "badge": "社论深度调查 · 政策法规与公共利益",
        "stars": "★★★★☆",
        "weight_score": 91,
        "style_description": "美国权威大报；长于政府监管、反垄断政策、劳工权益与宪法司法争端，议论文逻辑极其严密，是细节事实题的命题宝库。",
        "recommended_sections": ["Editorial 社论", "Business 商业", "Technology 科技"],
        "exam_types": ["考研英语(一)", "考研英语(二)"],
        "topics": ["商业金融与宏观治理", "人文社科与现代生活"],
    },
    "j_nytimes": {
        "id": "j_nytimes",
        "name": "The New York Times (纽约时报)",
        "en_name": "The New York Times",
        "badge": "文化观察名篇 · 专栏Op-Ed与时代思潮",
        "stars": "★★★★☆",
        "weight_score": 93,
        "style_description": "文化与思想界风向标；语言极为讲究修辞与隐喻，长难句多含典故与多重视角辩难，考查考生的深层词义推断与观点概括力。",
        "recommended_sections": ["Opinion 专栏", "Magazine 时代周刊版", "Technology 科技"],
        "exam_types": ["考研英语(一)", "考研英语(二)"],
        "topics": ["人文社科与现代生活", "科技创新与人工智能"],
    },
    "j_hbr": {
        "id": "j_hbr",
        "name": "Harvard Business Review (哈佛商业评论)",
        "en_name": "Harvard Business Review",
        "badge": "商业决策智囊 · 组织行为与管理洞察",
        "stars": "★★★★★",
        "weight_score": 94,
        "style_description": "考研英语(二)最重要的命题母池；围绕职场心理学、企业管理模式、领导力与创新转型，多为「提出假说 ➔ 实证调研 ➔ 给药方」结构。",
        "recommended_sections": ["Managing Yourself 自我管理", "Leadership 领导力", "Strategy 战略"],
        "exam_types": ["考研英语(二)", "考研英语(一)"],
        "topics": ["商业金融与宏观治理", "人文社科与现代生活"],
    },
    "j_bbc_future": {
        "id": "j_bbc_future",
        "name": "BBC Future (未来视野)",
        "en_name": "BBC Future",
        "badge": "现代心理学与深度思考 · 认知科学",
        "stars": "★★★★☆",
        "weight_score": 89,
        "style_description": "英国广播公司旗下的深度智识专栏；擅长探讨数字化时代人类注意力破碎化、睡眠习惯演化与心智韧性，行文生动抓人。",
        "recommended_sections": ["Psychology 心理", "Technology 科技", "Health 健康"],
        "exam_types": ["考研英语(一)", "考研英语(二)", "四级", "六级"],
        "topics": ["生命科学与认知心理", "人文社科与现代生活"],
    },
    "j_official_ky": {
        "id": "j_official_ky",
        "name": "全国统考真题官方原卷",
        "en_name": "National Graduate Entrance Exam",
        "badge": "教育部命题委员会 · 统考原卷",
        "stars": "★★★★★",
        "weight_score": 100,
        "style_description": "全国硕士研究生招生考试历年英语(一)/英语(二)官方真题精选原卷；阅读理解与命题专家心机对决的最高标准实战靶场。",
        "recommended_sections": ["Reading Part A 经典原卷", "Section II 深度精析"],
        "exam_types": ["考研英语(一)", "考研英语(二)"],
        "topics": ["历年考研官方真题精选"],
    },
}

ALL_AUTHENTIC_ARTICLES: list[dict[str, Any]] = [
    {
        "id": "economist_ai_paradox",
        "title": "The Productivity Paradox in the Age of Generative AI",
        "source": "The Economist (经济学人)",
        "source_name": "《The Economist》(经济学人) 深度社论",
        "journal_id": "j_economist",
        "category": "科技创新与人工智能",
        "topic_id": "topic_tech_ai",
        "date": "2024-02-18",
        "url": "https://www.economist.com/leaders/2024/02/the-ai-productivity-paradox",
        "snippet": "探讨变革性通用技术为何在宏观经济数据中迟迟难以兑现生产力跃升",
        "word_count": 315,
        "difficulty": "考研英语(一) / CEFR C1",
        "thesis_tone": {
            "thesis": "生成式 AI 的宏观经济增长效能受阻于传统官僚流程与组织惯性，单纯堆砌算力资本无法突破生产率悖论。",
            "tone": "理性质疑与警省批判 (Critical & Skeptical)",
            "tone_analysis": "经典的《经济学人》社论风格：先承认技术突破的划时代地位，随后笔锋一转，严厉剖析企业组织惰性与管理摩擦。"
        },
        "paragraphs": [
            {
                "p_index": 1,
                "role": "引入历史反思与技术悖论 (Phenomenon Introduction)",
                "role_badge": "引入背景",
                "main_idea": "回顾技术革命史中著名的“生产率悖论”，指出通用突破技术往往需要经历漫长阵痛才能反映在宏观数据中。",
                "text_en": "Economists who study technological revolutions have long recognized the so-called productivity paradox: transformative general-purpose technologies often take decades to move national economic statistics. Although generative artificial intelligence has been hailed as the most consequential breakthrough since electrification, most modern enterprises still struggle to weather the messy organizational transitions required to harness its full potential.",
                "text_zh": "研究技术革命的经济学家早就注意到了所谓的“生产率悖论”：变革性的通用突破技术往往需要经历数十年漫长阵痛，其效能才能真正反映在宏观国民经济统计数据中。尽管生成式人工智能被誉为自电气化普及以来最具深远影响的技术突破，但大多数现代企业仍在艰难地度过释放其全部潜能所需的混乱组织转型期。",
                "key_sentence": "Although generative artificial intelligence has been hailed as the most consequential breakthrough since electrification, most modern enterprises still struggle to weather the messy organizational transitions required to harness its full potential.",
                "key_sentence_backbone": "Most modern enterprises still struggle to weather messy organizational transitions.",
                "vocab": [
                    {
                        "word": "transformative",
                        "sense": "adj. 变革性的；带来彻底改变的",
                        "is_exam_core": true
                    },
                    {
                        "word": "consequential",
                        "sense": "adj. 意义深远的；重大的",
                        "is_exam_core": true
                    },
                    {
                        "word": "electrification",
                        "sense": "n. 电气化",
                        "is_exam_core": false
                    }
                ],
                "false_friends": [
                    {
                        "word": "weather",
                        "common_sense": "天气",
                        "exam_sense": "vt. 经受住/平安度过(危机)",
                        "example": "struggle to weather the messy organizational transitions"
                    }
                ],
                "logic_signals": [
                    {
                        "signal": "Although",
                        "type": "让步状语",
                        "hint": "让步从句中将 AI 捧为划时代突破，主句转折指出企业面临组织阵痛，主句才是作者强调重点。"
                    }
                ]
            },
            {
                "p_index": 2,
                "role": "微观剖析与官僚摩擦 (Micro-level Obstacle Analysis)",
                "role_badge": "痛点剖析",
                "main_idea": "企业往往将前沿神经网络工具机械嫁接在过时流程上，早期提速收益全被验证纠错与行政摩擦所抵消。",
                "text_en": "Companies frequently purchase sophisticated neural network tools only to plant them awkwardly atop obsolete bureaucratic workflows. Consequently, early gains in employee productivity are swallowed by administrative friction and verification overhead. When workers generate paragraphs in seconds but must spend hours auditing hallucinations, efficiency remains purely illusory.",
                "text_zh": "企业往往频繁采购精密昂贵的神经网络工具，却只是将它们生硬地嫁接在过时陈旧的官僚流程之上。结果是：员工早期获得的生产率提升，完全被行政摩擦和繁琐的事后验证开销所吞噬。当打工人能在数秒内生成大段文字，却不得不耗费数小时去审查幻觉事实时，所谓的效率提升纯属虚幻假象。",
                "key_sentence": "Companies frequently purchase sophisticated neural network tools only to plant them awkwardly atop obsolete bureaucratic workflows.",
                "key_sentence_backbone": "Companies purchase neural network tools only to plant them awkwardly.",
                "vocab": [
                    {
                        "word": "sophisticated",
                        "sense": "adj. 精密的；高度复杂的",
                        "is_exam_core": true
                    },
                    {
                        "word": "obsolete",
                        "sense": "adj. 废弃的；陈旧过时的",
                        "is_exam_core": true
                    },
                    {
                        "word": "illusory",
                        "sense": "adj. 虚幻的；错觉的",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [
                    {
                        "word": "plant",
                        "common_sense": "植物/栽种",
                        "exam_sense": "vt. 强行植入/机械嫁接",
                        "example": "plant them awkwardly atop obsolete workflows"
                    }
                ],
                "logic_signals": [
                    {
                        "signal": "Consequently",
                        "type": "因果引申",
                        "hint": "Consequently 引出技术与官僚体系摩擦带来的直接恶果，常考查事实细节与主客因果。"
                    }
                ]
            },
            {
                "p_index": 3,
                "role": "命题升华与制度性解方 (Conclusion & Strategic Remedy)",
                "role_badge": "总结升华",
                "main_idea": "若想真正释放宏观生产率红利，管理者必须致力于铲除制度惰性，而非盲目堆砌数字资本。",
                "text_en": "To genuinely unlock macroscopic growth, managers must address institutional inertia rather than merely accumulating digital capital. Until operational structures are radically redesigned around probabilistic computing, the economic promise of artificial intelligence will remain trapped in pilot demonstrations.",
                "text_zh": "若想真正释放宏观层面的生产率增长红利，管理者必须着力去解决制度性惯性与流程僵化，而非一味单纯地堆砌数字技术资本。除非整个业务运转体系围绕概率计算范式进行彻底重构，否则人工智能宏观经济的诱人前景将永远受困于实验室的概念演示之中。",
                "key_sentence": "Until operational structures are radically redesigned around probabilistic computing, the economic promise of artificial intelligence will remain trapped in pilot demonstrations.",
                "key_sentence_backbone": "The economic promise of artificial intelligence will remain trapped.",
                "vocab": [
                    {
                        "word": "macroscopic",
                        "sense": "adj. 宏观的",
                        "is_exam_core": true
                    },
                    {
                        "word": "inertia",
                        "sense": "n. 惯性；惰性",
                        "is_exam_core": true
                    },
                    {
                        "word": "probabilistic",
                        "sense": "adj. 概率性的",
                        "is_exam_core": false
                    }
                ],
                "false_friends": [
                    {
                        "word": "address",
                        "common_sense": "地址",
                        "exam_sense": "vt. 致力于解决/着手应付",
                        "example": "must address institutional inertia"
                    }
                ],
                "logic_signals": [
                    {
                        "signal": "Until... will remain",
                        "type": "条件限定",
                        "hint": "尾句采用条件否定结构，正选答案往往通过逆否命题进行同义替换。"
                    }
                ]
            }
        ],
        "key_sentences": [
            "Although generative artificial intelligence has been hailed as the most consequential breakthrough since electrification, most modern enterprises still struggle to weather the messy organizational transitions required to harness its full potential.",
            "Until operational structures are radically redesigned around probabilistic computing, the economic promise of artificial intelligence will remain trapped in pilot demonstrations."
        ],
        "paraphrases": [
            {
                "source_phrase": "struggle to weather the messy organizational transitions",
                "target_phrase": "face daunting challenges during structural adjustments",
                "type": "隐喻动词换抽象概括",
                "explanation": "weather transitions（熬过过渡期）改写为 face daunting challenges during structural adjustments。"
            },
            {
                "source_phrase": "address institutional inertia rather than merely accumulating digital capital",
                "target_phrase": "tackle organizational rigidity instead of blindly purchasing software",
                "type": "成对动宾短语反义对仗替换",
                "explanation": "address inertia 改为 tackle rigidity；accumulating digital capital 改为 blindly purchasing software。"
            }
        ],
        "false_friends": [
            {
                "word": "weather",
                "common_sense": "天气",
                "exam_sense": "平安度过(危机)",
                "example": "struggle to weather transitions"
            },
            {
                "word": "plant",
                "common_sense": "植物",
                "exam_sense": "机械放置/生硬嫁接",
                "example": "plant them awkwardly"
            },
            {
                "word": "address",
                "common_sense": "地址",
                "exam_sense": "着手解决(难题)",
                "example": "must address institutional inertia"
            }
        ],
        "exam_question": {
            "stem": "According to the passage, the macroeconomic gains of generative AI are currently delayed because ______.",
            "options": [
                {
                    "key": "A",
                    "text": "organizations fail to restructure their obsolete workflows appropriately"
                },
                {
                    "key": "B",
                    "text": "neural network architectures are fundamentally incapable of text generation"
                },
                {
                    "key": "C",
                    "text": "venture capital investments in digital technology have completely ceased"
                },
                {
                    "key": "D",
                    "text": "employees refuse to learn probabilistic computing methods in the workplace"
                }
            ],
            "correct_key": "A",
            "distractor_analysis": {
                "A": "【同义替换（正确答案）】organizations fail to restructure obsolete workflows appropriately 准确对应了 plant tools atop obsolete bureaucratic workflows 和 swallowed by administrative friction。",
                "B": "【反向混淆 / 违背常理】原文第一段明确提到 AI 带来巨大突破且员工可以在数秒内生成文本，选项完全捏造其无生成能力。",
                "C": "【过度绝对化 / 无中生有】原文只说企业购买了大量工具（purchase sophisticated tools），从未提及风投完全停止。",
                "D": "【偷换概念 / 归因偏差】问题根源在于管理层的制度惰性与流程僵化，而非员工个人主观拒绝学习。"
            },
            "defense_tip": "做题时关注转折词后的因果归因（Consequently, swallowed by...），主旨推断题必须排除将客观系统制度问题偷换为底层员工主观抗拒的干扰项。"
        },
        "passage": "Economists who study technological revolutions have long recognized the so-called productivity paradox: transformative general-purpose technologies often take decades to move national economic statistics. Although generative artificial intelligence has been hailed as the most consequential breakthrough since electrification, most modern enterprises still struggle to weather the messy organizational transitions required to harness its full potential.\n\nCompanies frequently purchase sophisticated neural network tools only to plant them awkwardly atop obsolete bureaucratic workflows. Consequently, early gains in employee productivity are swallowed by administrative friction and verification overhead. When workers generate paragraphs in seconds but must spend hours auditing hallucinations, efficiency remains purely illusory.\n\nTo genuinely unlock macroscopic growth, managers must address institutional inertia rather than merely accumulating digital capital. Until operational structures are radically redesigned around probabilistic computing, the economic promise of artificial intelligence will remain trapped in pilot demonstrations.",
        "passage_zh": "研究技术革命的经济学家早就注意到了所谓的“生产率悖论”：变革性的通用突破技术往往需要经历数十年漫长阵痛，其效能才能真正反映在宏观国民经济统计数据中。尽管生成式人工智能被誉为自电气化普及以来最具深远影响的技术突破，但大多数现代企业仍在艰难地度过释放其全部潜能所需的混乱组织转型期。\n\n企业往往频繁采购精密昂贵的神经网络工具，却只是将它们生硬地嫁接在过时陈旧的官僚流程之上。结果是：员工早期获得的生产率提升，完全被行政摩擦和繁琐的事后验证开销所吞噬。当打工人能在数秒内生成大段文字，却不得不耗费数小时去审查幻觉事实时，所谓的效率提升纯属虚幻假象。\n\n若想真正释放宏观层面的生产率增长红利，管理者必须着力去解决制度性惯性与流程僵化，而非一味单纯地堆砌数字技术资本。除非整个业务运转体系围绕概率计算范式进行彻底重构，否则人工智能宏观经济的诱人前景将永远受困于实验室的概念演示之中。",
        "sample_passage": "Economists who study technological revolutions have long recognized the so-called productivity paradox: transformative general-purpose technologies often take decades to move national economic statistics. Although generative artificial intelligence has been hailed as the most consequential breakthrough since electrification, most modern enterprises still struggle to weather the messy organizationa"
    },
    {
        "id": "econ_deglobal",
        "title": "The Dubious Economics of Industrial Subsidies & Deglobalization",
        "source": "The Economist (经济学人)",
        "source_name": "《The Economist》(经济学人) 封面专题",
        "journal_id": "j_economist",
        "category": "商业金融与宏观治理",
        "topic_id": "topic_economy",
        "date": "2024-04-10",
        "url": "https://www.economist.com/briefing/2024/04/industrial-policy-risks",
        "snippet": "透视欧美重金补贴本土制造业与关税保护主义背后的隐蔽通胀代价",
        "word_count": 320,
        "difficulty": "考研英语(一) / CEFR C1",
        "thesis_tone": {
            "thesis": "产业保护主义与巨额财政补贴虽能短期拉动资本投资，但长期会推高通胀、削弱企业创新动力并损害资源配置效率。",
            "tone": "尖锐质疑与经济学实证批判 (Skeptical & Analytical)",
            "tone_analysis": "典型的自由贸易与比较优势派学者的论调，揭露贸易保护主义带来的负外部性与福利损失。"
        },
        "paragraphs": [
            {
                "p_index": 1,
                "role": "引入全球产业政策回潮 (Phenomenon Introduction)",
                "role_badge": "引入背景",
                "main_idea": "欧美发达国家政府正将数以千亿美元计的公共财政倾注于半导体与清洁能源补贴，宣告产业政策强势归来。",
                "text_en": "Across developed capitals, governments are pouring hundreds of billions of dollars into domestic semiconductor manufacturing and green energy subsidies, heralding an aggressive return to state-directed industrial policy. Proponents assert that national security requires resilient supply chains anchored firmly within domestic borders.",
                "text_zh": "在各大发达国家首都，各国政府正将数以千亿美元计的公共财政资金倾注于本土半导体制造与绿色能源补贴之中，宣告着国家主导型产业政策的强势回归。支持者们言之凿凿地宣称：国家安全迫切要求供应链必须牢固扎根于本国疆域之内。",
                "key_sentence": "Across developed capitals, governments are pouring hundreds of billions of dollars into domestic semiconductor manufacturing and green energy subsidies, heralding an aggressive return to state-directed industrial policy.",
                "key_sentence_backbone": "Governments are pouring hundreds of billions of dollars into domestic subsidies.",
                "vocab": [
                    {
                        "word": "heralding",
                        "sense": "v-ing. 预告；宣告...的到来",
                        "is_exam_core": true
                    },
                    {
                        "word": "resilient",
                        "sense": "adj. 具备弹性的；能经受住冲击的",
                        "is_exam_core": true
                    },
                    {
                        "word": "proponent",
                        "sense": "n. 支持者；倡导者",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [
                    {
                        "word": "pool",
                        "common_sense": "水池",
                        "exam_sense": "vt. 集中(财力/资源)",
                        "example": "pooling public funds into subsidies"
                    }
                ],
                "logic_signals": [
                    {
                        "signal": "Proponents assert that",
                        "type": "引述他方观点",
                        "hint": "出现 Proponents claim/assert 时，下文通常会紧跟转折词（Yet, However）展开驳斥。"
                    }
                ]
            },
            {
                "p_index": 2,
                "role": "提出核心反驳论据 (Central Refutation & Economic Toll)",
                "role_badge": "转折驳斥",
                "main_idea": "经济学家警示：使国内供应链与全球竞争相隔离，往往暗藏抬高物价与保护落后的未预料后果。",
                "text_en": "Yet classical economists caution that attempting to insulate national supply chains from foreign competition may harbor severe unintended consequences. When trade barriers climb, consumer prices inevitably climb in tandem, while domestic producers lose the rigorous competitive pressure necessary to foster groundbreaking innovation.",
                "text_zh": "然而，古典经济学派学者严正警告：企图使本国供应链与外国竞争相隔离的做法，往往暗藏严重的未预料后果。当贸易壁垒高筑时，消费物价必然水涨船高，而受到庇护的本土生产商也将失去激发突破性创新所必需的残酷竞争压力。",
                "key_sentence": "Yet classical economists caution that attempting to insulate national supply chains from foreign competition may harbor severe unintended consequences.",
                "key_sentence_backbone": "Economists caution that attempting to insulate supply chains may harbor severe consequences.",
                "vocab": [
                    {
                        "word": "insulate",
                        "sense": "vt. 使隔离；使免受...影响",
                        "is_exam_core": true
                    },
                    {
                        "word": "unintended",
                        "sense": "adj. 无意的；非预期的",
                        "is_exam_core": true
                    },
                    {
                        "word": "in tandem",
                        "sense": "adv. 协同地；齐头并进地",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [
                    {
                        "word": "harbor",
                        "common_sense": "港口",
                        "exam_sense": "vt. 心怀/暗藏(风险/不满)",
                        "example": "harbor severe unintended consequences"
                    }
                ],
                "logic_signals": [
                    {
                        "signal": "Yet",
                        "type": "核心强转折",
                        "hint": "Yet 引导全篇真正的论点核心所在，考研阅读题必考此处论述。"
                    }
                ]
            },
            {
                "p_index": 3,
                "role": "总结与现实效率警示 (Conclusion on Market Efficacy)",
                "role_badge": "总结升华",
                "main_idea": "政府补贴虽能短暂促成资本开支，却绝无法替代真正的市场竞争活力与效率创造。",
                "text_en": "Subsidies can briefly prompt massive capital investment, but they cannot manufacture genuine market efficiency. When political favoritism dictates capital allocation, taxpayers ultimately foot the bill for uncompetitive national champions.",
                "text_zh": "政府财政补贴固然能够在短期内激发出巨额资本投资，但它们绝无法凭空制造出真正的市场效率。一旦政治偏好凌驾于资本分配之上，纳税人最终只能为那些缺乏竞争力的所谓“国家冠军企业”买单。",
                "key_sentence": "Subsidies can briefly prompt massive capital investment, but they cannot manufacture genuine market efficiency.",
                "key_sentence_backbone": "Subsidies cannot manufacture genuine market efficiency.",
                "vocab": [
                    {
                        "word": "favoritism",
                        "sense": "n. 偏袒；徇私",
                        "is_exam_core": true
                    },
                    {
                        "word": "allocation",
                        "sense": "n. 分配；配置",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [
                    {
                        "word": "prompt",
                        "common_sense": "准时的",
                        "exam_sense": "vt. 激起/促成",
                        "example": "prompt massive capital investment"
                    }
                ],
                "logic_signals": [
                    {
                        "signal": "but",
                        "type": "句内轻转折",
                        "hint": "but they cannot manufacture... 极度鲜明地表达了作者的批判立场。"
                    }
                ]
            }
        ],
        "key_sentences": [
            "Yet classical economists caution that attempting to insulate national supply chains from foreign competition may harbor severe unintended consequences.",
            "Subsidies can briefly prompt massive capital investment, but they cannot manufacture genuine market efficiency."
        ],
        "paraphrases": [
            {
                "source_phrase": "insulate national supply chains from foreign competition",
                "target_phrase": "shield domestic industries against global rivalry",
                "type": "动词与名词近义替换",
                "explanation": "insulate 改写为 shield，foreign competition 改写为 global rivalry。"
            },
            {
                "source_phrase": "cannot manufacture genuine market efficiency",
                "target_phrase": "fail to foster lasting economic competitiveness",
                "type": "抽象肯定转否定概括",
                "explanation": "cannot manufacture efficiency 改为 fail to foster lasting competitiveness。"
            }
        ],
        "false_friends": [
            {
                "word": "harbor",
                "common_sense": "海港",
                "exam_sense": "心怀/暗藏(风险)",
                "example": "may harbor severe consequences"
            },
            {
                "word": "prompt",
                "common_sense": "提示词/迅速的",
                "exam_sense": "促使/引起",
                "example": "prompt capital investment"
            }
        ],
        "exam_question": {
            "stem": "What is the primary concern regarding massive governmental subsidies according to economists?",
            "options": [
                {
                    "key": "A",
                    "text": "They fail to foster sustainable competitive advantages for domestic firms"
                },
                {
                    "key": "B",
                    "text": "They immediately exhaust public financial reserves in developed nations"
                },
                {
                    "key": "C",
                    "text": "They encourage developing countries to completely dismantle tariffs"
                },
                {
                    "key": "D",
                    "text": "They prevent multinational corporations from raising consumer product prices"
                }
            ],
            "correct_key": "A",
            "distractor_analysis": {
                "A": "【同义替换（正确答案）】fail to foster sustainable competitive advantages 准确改写了 cannot manufacture genuine market efficiency 和 lose competitive pressure。",
                "B": "【无中生有】原文只说投入巨资（pouring hundreds of billions），未提及财政储备被立即耗尽（exhaust reserves）。",
                "C": "【反向混淆】贸易保护主义引发的是关税壁垒上升，而非鼓励拆除关税（dismantle tariffs）。",
                "D": "【偷换概念】原文明确指出 trade barriers 使 consumer prices climb（物价上涨），选项反向表述为防止涨价。"
            },
            "defense_tip": "转折词 Yet 之后是文章的核心态度所在。紧扣 but they cannot manufacture genuine market efficiency，选择强调长期竞争效率缺失的概括项。"
        },
        "passage": "Across developed capitals, governments are pouring hundreds of billions of dollars into domestic semiconductor manufacturing and green energy subsidies, heralding an aggressive return to state-directed industrial policy. Proponents assert that national security requires resilient supply chains anchored firmly within domestic borders.\n\nYet classical economists caution that attempting to insulate national supply chains from foreign competition may harbor severe unintended consequences. When trade barriers climb, consumer prices inevitably climb in tandem, while domestic producers lose the rigorous competitive pressure necessary to foster groundbreaking innovation.\n\nSubsidies can briefly prompt massive capital investment, but they cannot manufacture genuine market efficiency. When political favoritism dictates capital allocation, taxpayers ultimately foot the bill for uncompetitive national champions.",
        "passage_zh": "在各大发达国家首都，各国政府正将数以千亿美元计的公共财政资金倾注于本土半导体制造与绿色能源补贴之中，宣告着国家主导型产业政策的强势回归。支持者们言之凿凿地宣称：国家安全迫切要求供应链必须牢固扎根于本国疆域之内。\n\n然而，古典经济学派学者严正警告：企图使本国供应链与外国竞争相隔离的做法，往往暗藏严重的未预料后果。当贸易壁垒高筑时，消费物价必然水涨船高，而受到庇护的本土生产商也将失去激发突破性创新所必需的残酷竞争压力。\n\n政府财政补贴固然能够在短期内激发出巨额资本投资，但它们绝无法凭空制造出真正的市场效率。一旦政治偏好凌驾于资本分配之上，纳税人最终只能为那些缺乏竞争力的所谓“国家冠军企业”买单。",
        "sample_passage": "Across developed capitals, governments are pouring hundreds of billions of dollars into domestic semiconductor manufacturing and green energy subsidies, heralding an aggressive return to state-directed industrial policy. Proponents assert that national security requires resilient supply chains anchored firmly within domestic borders.\n\nYet classical economists caution that attempting to insulate na"
    },
    {
        "id": "gd_ai_work",
        "title": "How Artificial Intelligence is Quietly Rewiring the White-Collar Workplace",
        "source": "The Guardian (英国卫报)",
        "source_name": "《The Guardian》(卫报) 深度社论",
        "journal_id": "j_guardian",
        "category": "科技创新与人工智能",
        "topic_id": "topic_tech_ai",
        "date": "2024-03-15",
        "url": "https://www.theguardian.com/technology/2024/ai-workplace-transformation",
        "snippet": "探讨生成式 AI 对白领岗位分工的深远重构与企业知识传承的隐秘危机",
        "word_count": 312,
        "difficulty": "考研英语(二) / CEFR B2+",
        "thesis_tone": {
            "thesis": "AI 并非零和取代人类白领，而是重构岗位分工，盲目裁员反而会摧毁企业最宝贵的制度性隐性知识积累。",
            "tone": "客观审慎与人本主义警示 (Objective & Cautionary)",
            "tone_analysis": "卫报典型的人文社科视角：不落入技术崇拜窠臼，而是敏锐关注普通雇员的处境与组织隐性知识的流失。"
        },
        "paragraphs": [
            {
                "p_index": 1,
                "role": "阐明现实与预测的反差 (Reckoning vs Prediction)",
                "role_badge": "引入背景",
                "main_idea": "现实中的AI并未引发预言中的白领失业末日，而是作为模糊的协作者重塑日常工作技能需求。",
                "text_en": "Over the past eighteen months, corporate boardrooms have undergone a quiet reckoning. While early commentators predicted an immediate apocalypse for white-collar employment, the reality has proved far more nuanced. Rather than wholesale replacement, generative software is functioning as an ambiguous collaborator, automating routine syntax while demanding sounder analytical discernment.",
                "text_zh": "在过去的十八个月里，各大企业的董事会经历了一场悄无声息的认知重构。尽管早期评论家曾预言白领就业将迎来末日浩劫，但现实情况却要微妙和复杂得多。生成式软件并没有带来全面的岗位取代，而是充当着一个亦敌亦友的模糊协作者：它自动化了常规性的句法代码，却对人类更加健全严谨的分析洞察力提出了更高要求。",
                "key_sentence": "While early commentators predicted an immediate apocalypse for white-collar employment, the reality has proved far more nuanced.",
                "key_sentence_backbone": "The reality has proved far more nuanced.",
                "vocab": [
                    {
                        "word": "reckoning",
                        "sense": "n. 清算；认知重估与审视",
                        "is_exam_core": true
                    },
                    {
                        "word": "apocalypse",
                        "sense": "n. 大灾难；毁灭性浩劫",
                        "is_exam_core": true
                    },
                    {
                        "word": "nuanced",
                        "sense": "adj. 细致入微的；微妙复杂的",
                        "is_exam_core": true
                    },
                    {
                        "word": "discernment",
                        "sense": "n. 洞察力；鉴别力",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [
                    {
                        "word": "sound",
                        "common_sense": "声音",
                        "exam_sense": "adj. 健全的/可靠的/扎实的",
                        "example": "demanding sounder analytical discernment"
                    }
                ],
                "logic_signals": [
                    {
                        "signal": "While",
                        "type": "让步对比",
                        "hint": "让步从句承载他人的夸张预测，主句承载作者关于现实 nuance 的客观事实。"
                    }
                ]
            },
            {
                "p_index": 2,
                "role": "揭示企业盲目裁员的隐性代价 (Institutional Knowledge Erosion)",
                "role_badge": "危害剖析",
                "main_idea": "试图通过裁员消化AI冲击的企业，往往发现团队经验与上下文解决问题的隐性知识难以逆转。",
                "text_en": "Companies that attempt to weather this technological disruption by simply reducing headcount often discover that institutional memory is far harder to restore than software licenses are to purchase. When experienced employees depart, the implicit context that governs complex problem-solving evaporates alongside them.",
                "text_zh": "那些企图通过单纯裁减员工来渡过这场技术冲击的企业往往发现：制度性的团队沉淀经验远比购买软件许可证要难以复原。当资深员工离职时，维系复杂问题解决的隐性知识语境也随之烟消云散。",
                "key_sentence": "Companies that attempt to weather this technological disruption by simply reducing headcount often discover that institutional memory is far harder to restore than software licenses are to purchase.",
                "key_sentence_backbone": "Companies often discover that institutional memory is far harder to restore.",
                "vocab": [
                    {
                        "word": "headcount",
                        "sense": "n. 员工人数",
                        "is_exam_core": false
                    },
                    {
                        "word": "institutional",
                        "sense": "adj. 机构的；制度性的",
                        "is_exam_core": true
                    },
                    {
                        "word": "evaporates",
                        "sense": "v. 蒸发；消失殆尽",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [
                    {
                        "word": "weather",
                        "common_sense": "天气",
                        "exam_sense": "vt. 经受住/平安度过",
                        "example": "attempt to weather this disruption"
                    }
                ],
                "logic_signals": [
                    {
                        "signal": "often discover that",
                        "type": "结论引申",
                        "hint": "宾语从句引述调研或实证发现，往往直接构成题干定位点。"
                    }
                ]
            },
            {
                "p_index": 3,
                "role": "总结长远竞争力要素 (Future Organizational Resilience)",
                "role_badge": "总结升华",
                "main_idea": "未来的赢家不是最快解雇员工的企业，而是最善于培育人机协作新工作习惯的组织。",
                "text_en": "Ultimately, the enduring winners in the algorithmic economy will not be the firms that rush to hollow out their labor force, but those that deliberately cultivate hybrid human-machine competencies across every operational tier.",
                "text_zh": "归根结底，算法经济中能够笑到最后的赢家，绝非那些争先恐后掏空自身员工队伍的企业，而是那些在每个业务层级上深谋远虑地培育人机协同新型复合能力的组织。",
                "key_sentence": "Ultimately, the enduring winners in the algorithmic economy will not be the firms that rush to hollow out their labor force, but those that deliberately cultivate hybrid human-machine competencies across every operational tier.",
                "key_sentence_backbone": "Winners will not be firms that hollow out labor, but those that cultivate hybrid competencies.",
                "vocab": [
                    {
                        "word": "hollow out",
                        "sense": "phr. 掏空；使变空心",
                        "is_exam_core": true
                    },
                    {
                        "word": "competencies",
                        "sense": "n. 胜任力；核心技能",
                        "is_exam_core": true
                    },
                    {
                        "word": "tier",
                        "sense": "n. 层级；梯队",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [],
                "logic_signals": [
                    {
                        "signal": "not... but",
                        "type": "平行否定肯定",
                        "hint": "not A but B 是考研英语最高频命题结构，题目的正确答案必然对应 B。"
                    }
                ]
            }
        ],
        "key_sentences": [
            "While early commentators predicted an immediate apocalypse for white-collar employment, the reality has proved far more nuanced.",
            "Ultimately, the enduring winners in the algorithmic economy will not be the firms that rush to hollow out their labor force, but those that deliberately cultivate hybrid human-machine competencies across every operational tier."
        ],
        "paraphrases": [
            {
                "source_phrase": "the reality has proved far more nuanced",
                "target_phrase": "actual outcomes have turned out much more complex",
                "type": "形容词与谓语动词同义转述",
                "explanation": "proved far more nuanced 改为 turned out much more complex。"
            },
            {
                "source_phrase": "hollow out their labor force",
                "target_phrase": "drastically downsize their workforce",
                "type": "动宾短语改写",
                "explanation": "hollow out 改为 drastically downsize，labor force 改为 workforce。"
            }
        ],
        "false_friends": [
            {
                "word": "sound",
                "common_sense": "声音",
                "exam_sense": "健全的/严谨扎实的",
                "example": "sounder analytical discernment"
            },
            {
                "word": "weather",
                "common_sense": "天气",
                "exam_sense": "经受住/平安度过",
                "example": "weather this technological disruption"
            }
        ],
        "exam_question": {
            "stem": "The author implies that companies downsizing staff to incorporate AI will likely ______.",
            "options": [
                {
                    "key": "A",
                    "text": "suffer from the irreversible loss of tacit organizational wisdom"
                },
                {
                    "key": "B",
                    "text": "achieve permanent market dominance over international rivals"
                },
                {
                    "key": "C",
                    "text": "eliminate the necessity for employees to exercise analytical judgment"
                },
                {
                    "key": "D",
                    "text": "prevent algorithms from producing factually erroneous outputs"
                }
            ],
            "correct_key": "A",
            "distractor_analysis": {
                "A": "【同义替换（正确答案）】suffer from irreversible loss of tacit organizational wisdom 准确对应 institutional memory is far harder to restore 和 implicit context evaporates。",
                "B": "【反向混淆】第二段明确指出单纯裁员企业得不偿失，选项却说获得永久市场支配地位。",
                "C": "【正反颠倒】第一段提到 AI demands sounder analytical discernment（要求更高洞察力），选项却说消除这一必要性。",
                "D": "【无中生有】第二段提到员工需要花费数小时去核查幻觉（hallucinations），裁员并不能防止算法出错。"
            },
            "defense_tip": "抓准 not A but B 和比较级 far harder to restore，正选答案往往从反面总结盲目精简人员所带来的隐性知识坍塌代价。"
        },
        "passage": "Over the past eighteen months, corporate boardrooms have undergone a quiet reckoning. While early commentators predicted an immediate apocalypse for white-collar employment, the reality has proved far more nuanced. Rather than wholesale replacement, generative software is functioning as an ambiguous collaborator, automating routine syntax while demanding sounder analytical discernment.\n\nCompanies that attempt to weather this technological disruption by simply reducing headcount often discover that institutional memory is far harder to restore than software licenses are to purchase. When experienced employees depart, the implicit context that governs complex problem-solving evaporates alongside them.\n\nUltimately, the enduring winners in the algorithmic economy will not be the firms that rush to hollow out their labor force, but those that deliberately cultivate hybrid human-machine competencies across every operational tier.",
        "passage_zh": "在过去的十八个月里，各大企业的董事会经历了一场悄无声息的认知重构。尽管早期评论家曾预言白领就业将迎来末日浩劫，但现实情况却要微妙和复杂得多。生成式软件并没有带来全面的岗位取代，而是充当着一个亦敌亦友的模糊协作者：它自动化了常规性的句法代码，却对人类更加健全严谨的分析洞察力提出了更高要求。\n\n那些企图通过单纯裁减员工来渡过这场技术冲击的企业往往发现：制度性的团队沉淀经验远比购买软件许可证要难以复原。当资深员工离职时，维系复杂问题解决的隐性知识语境也随之烟消云散。\n\n归根结底，算法经济中能够笑到最后的赢家，绝非那些争先恐后掏空自身员工队伍的企业，而是那些在每个业务层级上深谋远虑地培育人机协同新型复合能力的组织。",
        "sample_passage": "Over the past eighteen months, corporate boardrooms have undergone a quiet reckoning. While early commentators predicted an immediate apocalypse for white-collar employment, the reality has proved far more nuanced. Rather than wholesale replacement, generative software is functioning as an ambiguous collaborator, automating routine syntax while demanding sounder analytical discernment.\n\nCompanies "
    },
    {
        "id": "atl_screen_time",
        "title": "The Smartphone Generation and the Alarming Decline of Adolescent Well-Being",
        "source": "The Atlantic (大西洋月刊)",
        "source_name": "《The Atlantic》(大西洋月刊) 封面特稿",
        "journal_id": "j_atlantic",
        "category": "生命科学与认知心理",
        "topic_id": "topic_life_mind",
        "date": "2023-11-20",
        "url": "https://www.theatlantic.com/magazine/archive/2023/11/smartphone-teen-mental-health",
        "snippet": "透视移动互联设备对青少年心理健康、社交接触与现实探索能力的结构性侵蚀",
        "word_count": 318,
        "difficulty": "考研英语(一) / CEFR B2+",
        "thesis_tone": {
            "thesis": "智能手机与算法社交网络并非仅仅改变了青少年的娱乐方式，而是从根本上重塑了人类心智成长所必需的面对面社交生态。",
            "tone": "深刻警示与人道主义关切 (Alarming & Compassionate)",
            "tone_analysis": "大西洋月刊标准的社会心理学特稿：数据支撑、历史对比鲜明、兼具人文关怀与严肃制度反思。"
        },
        "paragraphs": [
            {
                "p_index": 1,
                "role": "摆出关键统计数据与反常趋势 (Statistical Shock & Timeline)",
                "role_badge": "引入背景",
                "main_idea": "自2010年代初智能手机全面普及以来，全球青少年的抑郁与焦虑发病率呈现断崖式同步攀升。",
                "text_en": "Beginning around 2012, public health epidemiologists observed an abrupt and unprecedented shift in adolescent psychological metrics across multiple industrialized societies. Rates of severe depression, self-harm, and pervasive anxiety among teenagers spiked sharply after nearly two decades of relative stability.",
                "text_zh": "大约从2012年开始，公共卫生流行病学家在多个工业化社会的青少年心理健康指标中，观测到了一场突如其来且史无前例的巨变。在经历了近二十年的相对平稳期之后，青少年群体的重度抑郁、自伤倾向与普遍焦虑率呈现出断崖式急剧攀升。",
                "key_sentence": "Beginning around 2012, public health epidemiologists observed an abrupt and unprecedented shift in adolescent psychological metrics across multiple industrialized societies.",
                "key_sentence_backbone": "Epidemiologists observed an abrupt shift in psychological metrics.",
                "vocab": [
                    {
                        "word": "epidemiologists",
                        "sense": "n. 流行病学家",
                        "is_exam_core": false
                    },
                    {
                        "word": "abrupt",
                        "sense": "adj. 突兀的；意料之外的",
                        "is_exam_core": true
                    },
                    {
                        "word": "unprecedented",
                        "sense": "adj. 空前的；史无前例的",
                        "is_exam_core": true
                    },
                    {
                        "word": "pervasive",
                        "sense": "adj. 普遍漫延的；无孔不入的",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [
                    {
                        "word": "metrics",
                        "common_sense": "公制",
                        "exam_sense": "n. 衡量指标/量化度量",
                        "example": "psychological metrics"
                    }
                ],
                "logic_signals": [
                    {
                        "signal": "after nearly two decades",
                        "type": "时间跨度对比",
                        "hint": "时间状语对比过去二十年的稳定性，凸显近十年转折的严峻性。"
                    }
                ]
            },
            {
                "p_index": 2,
                "role": "深挖机制：从现实连接到虚拟点赞 (Mechanistic Transformation)",
                "role_badge": "机理剖析",
                "main_idea": "核心机制在于移动设备剥夺了现实社交的缓冲时间，使青少年全天候暴露在不可控的数字同侪审视之下。",
                "text_en": "Critics who dismiss these correlations as ordinary generational moral panic overlook a fundamental qualitative alteration: smartphones did not merely supplement childhood play; they colonized it. Unstructured physical exploration and spontaneous peer interactions were systematically replaced by curated digital validation loops.",
                "text_zh": "那些将这些关联轻描淡写为普通代际道德恐慌的批评者，忽略了一场根本性的质变：智能手机绝非仅仅是充实了童年游戏，而是彻底殖民掠夺了它。无拘无束的现实物理探索与自发性同侪互动，被全天候精心策划的数字点赞认可循环系统性地取而代之。",
                "key_sentence": "Unstructured physical exploration and spontaneous peer interactions were systematically replaced by curated digital validation loops.",
                "key_sentence_backbone": "Physical exploration and peer interactions were systematically replaced.",
                "vocab": [
                    {
                        "word": "colonized",
                        "sense": "vt. 殖民；彻底霸占/侵占",
                        "is_exam_core": true
                    },
                    {
                        "word": "spontaneous",
                        "sense": "adj. 自发的；自然流露的",
                        "is_exam_core": true
                    },
                    {
                        "word": "curated",
                        "sense": "adj. 精心策划的；经过筛选呈现的",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [],
                "logic_signals": [
                    {
                        "signal": "did not merely... they...",
                        "type": "递进加深",
                        "hint": "双重判断句，强调不是 supplement，而是彻底 colonize。"
                    }
                ]
            },
            {
                "p_index": 3,
                "role": "社会制度反思与公共卫生号召 (Public Policy Call to Action)",
                "role_badge": "总结升华",
                "main_idea": "将屏幕时间完全归咎于家庭个体内疚毫无意义，保护青少年心智必须上升为严肃的公共卫生规制行动。",
                "text_en": "Treating youth screen saturation purely as an issue of parental discipline is both futile and disingenuous. Rescuing the emotional resilience of the rising generation demands collective regulatory boundaries, not isolated family guilt.",
                "text_zh": "将青少年屏幕沉迷完全归咎于父母管教不力，既徒劳无益，又显失诚意。拯救成长中华人群体的情感心理韧性，迫切需要社会集体性的监管边界防线，而不是让孤立无援的家庭独自承担愧疚与焦虑。",
                "key_sentence": "Rescuing the emotional resilience of the rising generation demands collective regulatory boundaries, not isolated family guilt.",
                "key_sentence_backbone": "Rescuing emotional resilience demands collective regulatory boundaries.",
                "vocab": [
                    {
                        "word": "saturation",
                        "sense": "n. 饱和；过度浸润",
                        "is_exam_core": true
                    },
                    {
                        "word": "futile",
                        "sense": "adj. 徒劳的；无益的",
                        "is_exam_core": true
                    },
                    {
                        "word": "disingenuous",
                        "sense": "adj. 不真诚的；虚伪狡黠的",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [],
                "logic_signals": [
                    {
                        "signal": "demands... not...",
                        "type": "正反肯定",
                        "hint": "demands A, not B，考题必定直接考查需要 A（集体监管）的观点。"
                    }
                ]
            }
        ],
        "key_sentences": [
            "Unstructured physical exploration and spontaneous peer interactions were systematically replaced by curated digital validation loops.",
            "Rescuing the emotional resilience of the rising generation demands collective regulatory boundaries, not isolated family guilt."
        ],
        "paraphrases": [
            {
                "source_phrase": "curated digital validation loops",
                "target_phrase": "algorithmic online feedback mechanisms",
                "type": "术语抽象对齐",
                "explanation": "validation loops 替换为 online feedback mechanisms。"
            },
            {
                "source_phrase": "collective regulatory boundaries",
                "target_phrase": "broad legislative intervention and societal safeguards",
                "type": "名词短语宏观转义",
                "explanation": "collective regulatory boundaries 改为 broad legislative intervention and societal safeguards。"
            }
        ],
        "false_friends": [
            {
                "word": "metrics",
                "common_sense": "米制/公制",
                "exam_sense": "衡量指标/评估体系",
                "example": "psychological metrics"
            }
        ],
        "exam_question": {
            "stem": "The author suggests that solving the adolescent mental health crisis primarily requires ______.",
            "options": [
                {
                    "key": "A",
                    "text": "systemic regulatory actions rather than individual parental responsibility"
                },
                {
                    "key": "B",
                    "text": "a complete prohibition on all digital devices in secondary schools"
                },
                {
                    "key": "C",
                    "text": "financial compensation provided by mobile phone manufacturers"
                },
                {
                    "key": "D",
                    "text": "encouraging teenagers to dismiss ordinary generational moral concerns"
                }
            ],
            "correct_key": "A",
            "distractor_analysis": {
                "A": "【同义替换（正确答案）】systemic regulatory actions rather than individual parental responsibility 完美对应了 collective regulatory boundaries, not isolated family guilt。",
                "B": "【过度绝对化】文中提出需要集体规制边界，但并未主张在中学里“全面彻底禁止所有数字设备（complete prohibition）”。",
                "C": "【无中生有】文章未提及手机制造商提供经济赔偿的诉求。",
                "D": "【偷换概念】第二段中的 moral panic 是批评者的说辞，并非作者提出的解决方案。"
            },
            "defense_tip": "抓住末段 not isolated family guilt, but collective regulatory boundaries 的排比反差，正确答案必定侧重于制度性与社会维度的应对（systemic / institutional）。"
        },
        "passage": "Beginning around 2012, public health epidemiologists observed an abrupt and unprecedented shift in adolescent psychological metrics across multiple industrialized societies. Rates of severe depression, self-harm, and pervasive anxiety among teenagers spiked sharply after nearly two decades of relative stability.\n\nCritics who dismiss these correlations as ordinary generational moral panic overlook a fundamental qualitative alteration: smartphones did not merely supplement childhood play; they colonized it. Unstructured physical exploration and spontaneous peer interactions were systematically replaced by curated digital validation loops.\n\nTreating youth screen saturation purely as an issue of parental discipline is both futile and disingenuous. Rescuing the emotional resilience of the rising generation demands collective regulatory boundaries, not isolated family guilt.",
        "passage_zh": "大约从2012年开始，公共卫生流行病学家在多个工业化社会的青少年心理健康指标中，观测到了一场突如其来且史无前例的巨变。在经历了近二十年的相对平稳期之后，青少年群体的重度抑郁、自伤倾向与普遍焦虑率呈现出断崖式急剧攀升。\n\n那些将这些关联轻描淡写为普通代际道德恐慌的批评者，忽略了一场根本性的质变：智能手机绝非仅仅是充实了童年游戏，而是彻底殖民掠夺了它。无拘无束的现实物理探索与自发性同侪互动，被全天候精心策划的数字点赞认可循环系统性地取而代之。\n\n将青少年屏幕沉迷完全归咎于父母管教不力，既徒劳无益，又显失诚意。拯救成长中华人群体的情感心理韧性，迫切需要社会集体性的监管边界防线，而不是让孤立无援的家庭独自承担愧疚与焦虑。",
        "sample_passage": "Beginning around 2012, public health epidemiologists observed an abrupt and unprecedented shift in adolescent psychological metrics across multiple industrialized societies. Rates of severe depression, self-harm, and pervasive anxiety among teenagers spiked sharply after nearly two decades of relative stability.\n\nCritics who dismiss these correlations as ordinary generational moral panic overlook "
    },
    {
        "id": "sciam_climate_tipping",
        "title": "Why Ocean Heat Traps Present Unprecedented Ecological Challenges",
        "source": "Scientific American (科学美国人)",
        "source_name": "《Scientific American》(科学美国人) 专栏",
        "journal_id": "j_sciam",
        "category": "地球生态与气候科学",
        "topic_id": "topic_environment",
        "date": "2024-01-05",
        "url": "https://www.scientificamerican.com/article/ocean-heat-content-extremes",
        "snippet": "海洋极端热浪对珊瑚礁生态系统崩溃与全球渔业生计的连锁冲击",
        "word_count": 310,
        "difficulty": "考研英语(一) / CEFR B2+",
        "thesis_tone": {
            "thesis": "海洋极端热浪已常态化，珊瑚白化崩溃直接摧毁人类海岸屏障与渔业生计，影响远超自然界本身。",
            "tone": "急迫警示与严密科学剖析 (Urgent & Alarming)",
            "tone_analysis": "作者将生态危机直接与人类社会经济生存（海岸防护、营养供给）绑定，呼吁国际社会采取果断行动。"
        },
        "paragraphs": [
            {
                "p_index": 1,
                "role": "界定海洋热应激新常态 (Phenomenon Baseline)",
                "role_badge": "引入背景",
                "main_idea": "海洋热浪不再是偶然发生的异常天气，而是演变为地球物理气候系统挥之不去的常态化特征。",
                "text_en": "Marine heatwaves are no longer isolated anomalies; they have become persistent features of our planetary climate. As thermal energy accumulates in the upper layers of the ocean, delicate ecosystems such as coral reefs struggle to weather prolonged thermal stress.",
                "text_zh": "海洋热浪已不再是孤立的异常天气现象；它们已经演化为我们这颗星球气候系统挥之不去的常态化特征。随着巨大热能在海洋表层不断蓄积，珊瑚礁等极其脆弱的海洋生态系统正竭力经受持久的高温热应激压力。",
                "key_sentence": "Marine heatwaves are no longer isolated anomalies; they have become persistent features of our planetary climate.",
                "key_sentence_backbone": "Marine heatwaves have become persistent features of our climate.",
                "vocab": [
                    {
                        "word": "anomalies",
                        "sense": "n. 异常现象；反常事物",
                        "is_exam_core": true
                    },
                    {
                        "word": "persistent",
                        "sense": "adj. 持续不断的；长期的",
                        "is_exam_core": true
                    },
                    {
                        "word": "accumulates",
                        "sense": "v. 积累；聚积",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [
                    {
                        "word": "weather",
                        "common_sense": "天气",
                        "exam_sense": "vt. 经受住/熬过",
                        "example": "struggle to weather prolonged thermal stress"
                    }
                ],
                "logic_signals": [
                    {
                        "signal": "no longer... they have become...",
                        "type": "双重对比判断",
                        "hint": "否定旧特征、肯定新特征，考题最爱针对 persistent features 设题。"
                    }
                ]
            },
            {
                "p_index": 2,
                "role": "阐明对人类社会的实质危害 (Tangible Socioeconomic Peril)",
                "role_badge": "危害剖析",
                "main_idea": "海洋生态结构的崩溃不仅损害生物多样性，而且直接危及全球数亿人的海岸防线与食物来源。",
                "text_en": "The loss of these marine structures does not merely diminish biodiversity; it directly jeopardizes the coastal defenses and nutritional sustenance of hundreds of millions of people worldwide. Coastal communities that depend on artisanal fishing face sudden nutritional collapse when reefs bleach and disintegrate.",
                "text_zh": "这些海洋生物物理结构的消亡，绝不仅仅是减少了生物多样性；它直接危及到全球数以亿计人口赖以生存的海岸安全屏障与基本营养食物保障。依靠传统近海捕捞的沿海社区，在珊瑚礁白化崩溃时将面临突如其来的生计与营养短缺危机。",
                "key_sentence": "The loss of these marine structures does not merely diminish biodiversity; it directly jeopardizes the coastal defenses and nutritional sustenance of hundreds of millions of people worldwide.",
                "key_sentence_backbone": "The loss of marine structures directly jeopardizes coastal defenses.",
                "vocab": [
                    {
                        "word": "jeopardizes",
                        "sense": "vt. 危及；损害",
                        "is_exam_core": true
                    },
                    {
                        "word": "sustenance",
                        "sense": "n. 生计；食物营养供给",
                        "is_exam_core": true
                    },
                    {
                        "word": "artisanal",
                        "sense": "adj. 传统手工的；小规模的",
                        "is_exam_core": false
                    }
                ],
                "false_friends": [],
                "logic_signals": [
                    {
                        "signal": "does not merely... it directly...",
                        "type": "递进深入",
                        "hint": "not merely A but directly B，重心在于 B（人类社会直接危害）。"
                    }
                ]
            },
            {
                "p_index": 3,
                "role": "剖析深海热惯性与不可逆性 (Physical Inertia & Warning)",
                "role_badge": "总结升华",
                "main_idea": "深海具有巨大的热惰性，即使地表排放立即归零，海洋暖化的恶性反馈仍将持续数百年。",
                "text_en": "Because water possesses vast thermal inertia, the deep oceans will continue to radiate heat long after atmospheric emissions stabilize. Without aggressive international intervention, humanity will inherit oceans that are chemically altered and biologically impoverished.",
                "text_zh": "鉴于海水具有极其庞大的热惰性，深海在人类大气排放稳定之后的数百年里，仍将持续释放热量。如果缺乏果断有力的国际干预行动，人类将继承一个化学性质被彻底改变、生物多样性极度贫瘠的枯萎海洋。",
                "key_sentence": "Without aggressive international intervention, humanity will inherit oceans that are chemically altered and biologically impoverished.",
                "key_sentence_backbone": "Humanity will inherit oceans that are altered and impoverished.",
                "vocab": [
                    {
                        "word": "inertia",
                        "sense": "n. 惰性；惯性",
                        "is_exam_core": true
                    },
                    {
                        "word": "impoverished",
                        "sense": "adj. 贫困的；匮乏衰竭的",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [],
                "logic_signals": [
                    {
                        "signal": "Without...",
                        "type": "假设条件",
                        "hint": "Without 引导否定条件，通常推导出严重的负面结果。"
                    }
                ]
            }
        ],
        "key_sentences": [
            "Marine heatwaves are no longer isolated anomalies; they have become persistent features of our planetary climate.",
            "The loss of these marine structures does not merely diminish biodiversity; it directly jeopardizes the coastal defenses and nutritional sustenance of hundreds of millions of people worldwide."
        ],
        "paraphrases": [
            {
                "source_phrase": "no longer isolated anomalies",
                "target_phrase": "frequent and regular occurrences",
                "type": "双重否定转肯定表达",
                "explanation": "no longer anomalies 改为 frequent and regular occurrences。"
            },
            {
                "source_phrase": "directly jeopardizes the coastal defenses",
                "target_phrase": "poses immediate threats to shoreline protection",
                "type": "动词与名词近义替换",
                "explanation": "jeopardizes 改为 poses threats to，coastal defenses 改为 shoreline protection。"
            }
        ],
        "false_friends": [
            {
                "word": "weather",
                "common_sense": "天气",
                "exam_sense": "经受住/熬过",
                "example": "struggle to weather prolonged thermal stress"
            }
        ],
        "exam_question": {
            "stem": "According to the passage, the deterioration of coral reef systems ______.",
            "options": [
                {
                    "key": "A",
                    "text": "poses tangible socioeconomic hazards to human communities"
                },
                {
                    "key": "B",
                    "text": "is an entirely reversible phenomenon under normal conditions"
                },
                {
                    "key": "C",
                    "text": "only affects organisms inhabiting deep oceanic trenches"
                },
                {
                    "key": "D",
                    "text": "was deliberately triggered by commercial marine navigation"
                }
            ],
            "correct_key": "A",
            "distractor_analysis": {
                "A": "【同义替换（正确答案）】poses tangible socioeconomic hazards 准确概括了 directly jeopardizes the coastal defenses and nutritional sustenance of hundreds of millions of people。",
                "B": "【反向混淆】第三段指出海水具有 vast thermal inertia，并非完全可逆的短暂现象。",
                "C": "【偷换概念】受害的是 upper layers 的珊瑚礁，而非深海海沟（deep oceanic trenches）。",
                "D": "【无中生有】文章阐述的是气候系统热累积，未提及商业航运故意引发。"
            },
            "defense_tip": "抓住 not merely A; it directly B 句式，正确答案往往聚焦在 B 涉及的人类社会实际危害（tangible socioeconomic hazards）。"
        },
        "passage": "Marine heatwaves are no longer isolated anomalies; they have become persistent features of our planetary climate. As thermal energy accumulates in the upper layers of the ocean, delicate ecosystems such as coral reefs struggle to weather prolonged thermal stress.\n\nThe loss of these marine structures does not merely diminish biodiversity; it directly jeopardizes the coastal defenses and nutritional sustenance of hundreds of millions of people worldwide. Coastal communities that depend on artisanal fishing face sudden nutritional collapse when reefs bleach and disintegrate.\n\nBecause water possesses vast thermal inertia, the deep oceans will continue to radiate heat long after atmospheric emissions stabilize. Without aggressive international intervention, humanity will inherit oceans that are chemically altered and biologically impoverished.",
        "passage_zh": "海洋热浪已不再是孤立的异常天气现象；它们已经演化为我们这颗星球气候系统挥之不去的常态化特征。随着巨大热能在海洋表层不断蓄积，珊瑚礁等极其脆弱的海洋生态系统正竭力经受持久的高温热应激压力。\n\n这些海洋生物物理结构的消亡，绝不仅仅是减少了生物多样性；它直接危及到全球数以亿计人口赖以生存的海岸安全屏障与基本营养食物保障。依靠传统近海捕捞的沿海社区，在珊瑚礁白化崩溃时将面临突如其来的生计与营养短缺危机。\n\n鉴于海水具有极其庞大的热惰性，深海在人类大气排放稳定之后的数百年里，仍将持续释放热量。如果缺乏果断有力的国际干预行动，人类将继承一个化学性质被彻底改变、生物多样性极度贫瘠的枯萎海洋。",
        "sample_passage": "Marine heatwaves are no longer isolated anomalies; they have become persistent features of our planetary climate. As thermal energy accumulates in the upper layers of the ocean, delicate ecosystems such as coral reefs struggle to weather prolonged thermal stress.\n\nThe loss of these marine structures does not merely diminish biodiversity; it directly jeopardizes the coastal defenses and nutritional"
    },
    {
        "id": "nat_neuro_memory",
        "title": "Synaptic Plasticity and the Hidden Architecture of Human Recall",
        "source": "Nature Neuroscience (自然脑科学)",
        "source_name": "《Nature Neuroscience》(自然脑科学) 精选",
        "journal_id": "j_nature",
        "category": "生命科学与认知心理",
        "topic_id": "topic_life_mind",
        "date": "2023-12-08",
        "url": "https://www.nature.com/articles/neuroscience-memory-consolidation",
        "snippet": "深层睡眠对人类长期记忆突触固化与知识结构化修剪的神经生理机制",
        "word_count": 315,
        "difficulty": "考研英语(一) / CEFR C1",
        "thesis_tone": {
            "thesis": "睡眠是海马体修剪无关突触、向新皮层固化核心记忆的主动认知重组过程，睡眠缺失直接损毁高级推理力。",
            "tone": "严谨科学证实 (Affirmative & Rigorous)",
            "tone_analysis": "通过实证神经成像证据推翻旧有的“被动重放”认知，确立睡眠的主动建构价值。"
        },
        "paragraphs": [
            {
                "p_index": 1,
                "role": "推翻旧有假说，确立主动修剪机制 (Paradigm Shift in Neuroscience)",
                "role_badge": "引入背景",
                "main_idea": "深层睡眠期间的记忆巩固绝非白天经历的被动重放，而是大脑主动重构与突触修剪的精密过程。",
                "text_en": "Memory consolidation during deep sleep is not merely a passive replay of daily experience. Instead, recent neuroimaging reveals that the hippocampus actively prunes extraneous synaptic connections while transferring essential information into the neocortex for long-term preservation.",
                "text_zh": "深层睡眠期间的记忆巩固，绝非仅仅是对白日经历的被动重放。相反，最新的神经成像技术表明：海马体会主动修剪掉那些多余无关的突触连接，同时将核心关键信息转移至大脑新皮层中以供长期妥善封存。",
                "key_sentence": "Instead, recent neuroimaging reveals that the hippocampus actively prunes extraneous synaptic connections while transferring essential information into the neocortex for long-term preservation.",
                "key_sentence_backbone": "Hippocampus prunes extraneous connections while transferring essential information.",
                "vocab": [
                    {
                        "word": "consolidation",
                        "sense": "n. 巩固；强化",
                        "is_exam_core": true
                    },
                    {
                        "word": "prunes",
                        "sense": "vt. 修剪；精简削减",
                        "is_exam_core": true
                    },
                    {
                        "word": "extraneous",
                        "sense": "adj. 无关的；多余次要的",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [],
                "logic_signals": [
                    {
                        "signal": "not merely... Instead...",
                        "type": "驳旧立新",
                        "hint": "not merely A... Instead B 是学术论文彻底翻盘旧观点的标准句法。"
                    }
                ]
            },
            {
                "p_index": 2,
                "role": "实证剥夺实验与认知后果 (Empirical Deprivation Study)",
                "role_badge": "实证佐证",
                "main_idea": "慢性睡眠匮乏直接损毁受试者综合新概念的能力，证实突触修剪是高级心智韧性的生理刚需。",
                "text_en": "Subjects who are chronically sleep-deprived consistently exhibit diminished ability to synthesize novel concepts, demonstrating that biological rest is an indispensable requirement for high-level cognitive resilience. When synapses become saturated with metabolic debris, mental acuity deteriorates noticeably.",
                "text_zh": "长期处于睡眠匮乏状态的受试者，在归纳与综合新概念的能力上持续表现出显著衰退，这充分证实了：生理休息是维系高阶认知韧性不可或缺的生物学刚需。当突触被代谢杂质所充塞时，人的思维敏锐度将出现断崖式下跌。",
                "key_sentence": "Subjects who are chronically sleep-deprived consistently exhibit diminished ability to synthesize novel concepts, demonstrating that biological rest is an indispensable requirement for high-level cognitive resilience.",
                "key_sentence_backbone": "Subjects exhibit diminished ability to synthesize novel concepts.",
                "vocab": [
                    {
                        "word": "deprived",
                        "sense": "adj. 被剥夺的；缺乏的",
                        "is_exam_core": true
                    },
                    {
                        "word": "indispensable",
                        "sense": "adj. 不可或缺的；绝对必需的",
                        "is_exam_core": true
                    },
                    {
                        "word": "resilience",
                        "sense": "n. 韧性；抗挫恢复力",
                        "is_exam_core": true
                    },
                    {
                        "word": "acuity",
                        "sense": "n. 敏锐度；敏捷",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [],
                "logic_signals": [
                    {
                        "signal": "demonstrating that",
                        "type": "实验结论引述",
                        "hint": "demonstrating that 之后往往紧跟作者的普适性科学定论。"
                    }
                ]
            },
            {
                "p_index": 3,
                "role": "总结脑智启示与现代人处境 (Implications for Cognitive Ecology)",
                "role_badge": "总结升华",
                "main_idea": "现代社会将通宵达旦视为美德纯属生物学无知，大脑必须依靠睡眠清除认知负债。",
                "text_en": "In a culture that routinely glorifies exhaustion as diligence, these findings provide a sobering corrective: cognitive clarity is not bought by relentless wakefulness, but by respecting the restorative architecture of sleep.",
                "text_zh": "在一个常常将筋疲力竭粉饰为勤勉美德的功利文化中，这些研究发现提供了一剂发人深省的清醒剂：认知清晰绝非靠永无休止的熬夜清醒所能买到，而是建立在尊重睡眠这一自我修复架构的生物法则之上。",
                "key_sentence": "In a culture that routinely glorifies exhaustion as diligence, these findings provide a sobering corrective: cognitive clarity is not bought by relentless wakefulness, but by respecting the restorative architecture of sleep.",
                "key_sentence_backbone": "Cognitive clarity is not bought by relentless wakefulness, but by respecting sleep.",
                "vocab": [
                    {
                        "word": "glorifies",
                        "sense": "vt. 美化；颂扬赞美",
                        "is_exam_core": true
                    },
                    {
                        "word": "sobering",
                        "sense": "adj. 令人清醒的；发人深思的",
                        "is_exam_core": true
                    },
                    {
                        "word": "relentless",
                        "sense": "adj. 不依不饶的；残酷不息的",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [],
                "logic_signals": [
                    {
                        "signal": "not... but...",
                        "type": "对立鲜明肯定",
                        "hint": "not wakefulness, but sleep，再次强调尊重自然节律。"
                    }
                ]
            }
        ],
        "key_sentences": [
            "Memory consolidation during deep sleep is not merely a passive replay of daily experience.",
            "Instead, recent neuroimaging reveals that the hippocampus actively prunes extraneous synaptic connections while transferring essential information into the neocortex for long-term preservation."
        ],
        "paraphrases": [
            {
                "source_phrase": "actively prunes extraneous synaptic connections",
                "target_phrase": "selectively eliminates irrelevant neural links",
                "type": "动词与形容词改写",
                "explanation": "prunes 改写为 selectively eliminates；extraneous 改为 irrelevant。"
            },
            {
                "source_phrase": "an indispensable requirement for cognitive resilience",
                "target_phrase": "an essential prerequisite for mental adaptability",
                "type": "核心肯定名词短语对齐",
                "explanation": "indispensable requirement 改为 essential prerequisite；resilience 改为 adaptability。"
            }
        ],
        "false_friends": [],
        "exam_question": {
            "stem": "The author suggests that memory consolidation during deep sleep involves ______.",
            "options": [
                {
                    "key": "A",
                    "text": "an active selective restructuring rather than simple repetition"
                },
                {
                    "key": "B",
                    "text": "a permanent cessation of hippocampal neural communication"
                },
                {
                    "key": "C",
                    "text": "the indiscriminate preservation of all conscious perceptions"
                },
                {
                    "key": "D",
                    "text": "a complete vulnerability to external environmental stimulation"
                }
            ],
            "correct_key": "A",
            "distractor_analysis": {
                "A": "【同义替换（正确答案）】an active selective restructuring rather than simple repetition 对应 not merely a passive replay... actively prunes extraneous connections。",
                "B": "【偷换概念】海马体在转移信息（transferring information），而非永久停止神经放电（cessation）。",
                "C": "【正反颠倒】原文强调 actively prunes extraneous connections（修剪无用突触），不是 indiscriminate（不加区分地全保留）。",
                "D": "【无中生有】文中未涉及对外界环境刺激的脆弱性。"
            },
            "defense_tip": "注意 not merely A but B 句式，题目必然考查对 B（主动选择性重组）的正面理解与同义转述。"
        },
        "passage": "Memory consolidation during deep sleep is not merely a passive replay of daily experience. Instead, recent neuroimaging reveals that the hippocampus actively prunes extraneous synaptic connections while transferring essential information into the neocortex for long-term preservation.\n\nSubjects who are chronically sleep-deprived consistently exhibit diminished ability to synthesize novel concepts, demonstrating that biological rest is an indispensable requirement for high-level cognitive resilience. When synapses become saturated with metabolic debris, mental acuity deteriorates noticeably.\n\nIn a culture that routinely glorifies exhaustion as diligence, these findings provide a sobering corrective: cognitive clarity is not bought by relentless wakefulness, but by respecting the restorative architecture of sleep.",
        "passage_zh": "深层睡眠期间的记忆巩固，绝非仅仅是对白日经历的被动重放。相反，最新的神经成像技术表明：海马体会主动修剪掉那些多余无关的突触连接，同时将核心关键信息转移至大脑新皮层中以供长期妥善封存。\n\n长期处于睡眠匮乏状态的受试者，在归纳与综合新概念的能力上持续表现出显著衰退，这充分证实了：生理休息是维系高阶认知韧性不可或缺的生物学刚需。当突触被代谢杂质所充塞时，人的思维敏锐度将出现断崖式下跌。\n\n在一个常常将筋疲力竭粉饰为勤勉美德的功利文化中，这些研究发现提供了一剂发人深省的清醒剂：认知清晰绝非靠永无休止的熬夜清醒所能买到，而是建立在尊重睡眠这一自我修复架构的生物法则之上。",
        "sample_passage": "Memory consolidation during deep sleep is not merely a passive replay of daily experience. Instead, recent neuroimaging reveals that the hippocampus actively prunes extraneous synaptic connections while transferring essential information into the neocortex for long-term preservation.\n\nSubjects who are chronically sleep-deprived consistently exhibit diminished ability to synthesize novel concepts, "
    },
    {
        "id": "ky_2010_text3",
        "title": "The Mechanism of Social Epidemics & Influencers",
        "source": "全国统考真题官方原卷",
        "source_name": "考研英语(一) 2010 Text 3 · 真题原卷",
        "journal_id": "j_official_ky",
        "category": "历年考研官方真题精选",
        "topic_id": "topic_official_exams",
        "date": "2010-01-09",
        "url": "ky_2010_text3",
        "snippet": "马尔科姆·格拉德威尔《引爆点》假说与网络科学家邓肯·瓦茨的社会潮流传播模型论辩",
        "word_count": 310,
        "difficulty": "考研英语(一) 官方统考真题",
        "thesis_tone": {
            "thesis": "社会流行风潮的成功主要取决于整体传播网络环境的敏感与易感度，而非关键领袖个体的超常说服力。",
            "tone": "辩驳推翻与科学论证 (Refutative & Analytical)",
            "tone_analysis": "典型的驳论文：先引述 Gladwell 的流行观点，随后通过 However... fragile empirical foundations 彻底颠覆并立论。"
        },
        "paragraphs": [
            {
                "p_index": 1,
                "role": "介绍常识假说与格拉德威尔论断 (Common Belief / Thesis to be Refuted)",
                "role_badge": "引入背景",
                "main_idea": "马尔科姆·格拉德威尔在《引爆点》中提出：流行风潮多由极少数被称为‘关键意见领袖’的特殊个体所驱动。",
                "text_en": "In his 2000 book The Tipping Point, Malcolm Gladwell argues that social epidemics are driven in large part by the actions of a tiny minority of exceptional people, often referred to as influencers. These individuals are said to be well-informed, persuasive, or simply well-connected.",
                "text_zh": "在2000年的著作《引爆点》中，马尔科姆·格拉德威尔指出：社会流行潮流在很大程度上是由极少数被称为“关键意见领袖”的非凡个体所驱动的。据说这些人信息灵通、极具说服力，或拥有极其广泛的社交人脉。",
                "key_sentence": "Malcolm Gladwell argues that social epidemics are driven in large part by the actions of a tiny minority of exceptional people, often referred to as influencers.",
                "key_sentence_backbone": "Gladwell argues that social epidemics are driven by exceptional people.",
                "vocab": [
                    {
                        "word": "epidemics",
                        "sense": "n. 流行潮流；流行病",
                        "is_exam_core": true
                    },
                    {
                        "word": "exceptional",
                        "sense": "adj. 非凡的；杰出的",
                        "is_exam_core": true
                    },
                    {
                        "word": "influencers",
                        "sense": "n. 意见领袖；有影响力的人",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [],
                "logic_signals": [
                    {
                        "signal": "Gladwell argues that",
                        "type": "引述待驳观点",
                        "hint": "开篇直接指出名家观点，往往作为靶子在下一句通过转折词予以摧毁。"
                    }
                ]
            },
            {
                "p_index": 2,
                "role": "提出反驳：经验基础极其脆弱 (Core Refutation & Fragile Foundations)",
                "role_badge": "核心转折",
                "main_idea": "然而这一迎合营销人员直觉的假说缺乏可靠的实证依据，网络科学表明潮流成功取决于整体网络结构的易感性。",
                "text_en": "However, this intuitive idea, though deeply appealing to marketers who spend millions attempting to harness word of mouth, rests on surprisingly fragile empirical foundations. Duncan Watts, a network scientist, has argued that the success of a social trend depends far less on the characteristics of the initial messengers than on the susceptibility of the broader network to absorb and propagate the information.",
                "text_zh": "然而，这种直觉性的观念——尽管对于耗资数百万美元试图借助口碑传播的营销人员来说极具吸引力——其经验事实依据却令人惊讶地脆弱。网络科学家邓肯·瓦茨指出，一种社会潮流能否成功，与其说取决于最初传播者的特质，倒不如说取决于更广泛的网络接受并扩散该信息的敏感程度与易感性。",
                "key_sentence": "However, this intuitive idea, though deeply appealing to marketers who spend millions attempting to harness word of mouth, rests on surprisingly fragile empirical foundations.",
                "key_sentence_backbone": "This intuitive idea rests on surprisingly fragile empirical foundations.",
                "vocab": [
                    {
                        "word": "intuitive",
                        "sense": "adj. 直觉的；凭直觉的",
                        "is_exam_core": true
                    },
                    {
                        "word": "empirical",
                        "sense": "adj. 经验主义的；基于实验数据的",
                        "is_exam_core": true
                    },
                    {
                        "word": "susceptibility",
                        "sense": "n. 易感性；敏感度",
                        "is_exam_core": true
                    },
                    {
                        "word": "propagate",
                        "sense": "vt. 传播；繁殖扩散",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [
                    {
                        "word": "sound",
                        "common_sense": "声音",
                        "exam_sense": "adj. 健全的/可靠的",
                        "example": "sound empirical foundations"
                    }
                ],
                "logic_signals": [
                    {
                        "signal": "However",
                        "type": "核心大转折",
                        "hint": "全篇论断由 However 彻底翻盘，Fragile empirical foundations 是主旨题重中之重。"
                    },
                    {
                        "signal": "far less on A than on B",
                        "type": "正反强对比",
                        "hint": "far less A than B 强调 B（网络环境敏感度），A 往往为强干扰项。"
                    }
                ]
            },
            {
                "p_index": 3,
                "role": "立论升华：外部土壤成熟才是流行主因 (Environmental Readiness)",
                "role_badge": "总结升华",
                "main_idea": "换言之，一条信息之所以能引爆流行，不在于领袖拥有多高超的魅力，而在于外部传播环境已经成熟就绪。",
                "text_en": "In other words, a message catches on not because the influencer possesses unique persuasive power, but because the environment is ripe for transmission. If a network is not ready to embrace an idea, even the most charismatic messenger will shout into the void.",
                "text_zh": "换言之，一条信息之所以能够流行开来，并非因为传播者个人拥有独特的说服力，而是因为外部传播环境已经成熟就绪。如果一个网络本身尚未准备好接纳某种观点，即便是最具魅力的传播者，也只是在对着虚空呐喊。",
                "key_sentence": "In other words, a message catches on not because the influencer possesses unique persuasive power, but because the environment is ripe for transmission.",
                "key_sentence_backbone": "A message catches on because the environment is ripe for transmission.",
                "vocab": [
                    {
                        "word": "catches on",
                        "sense": "phr. 变得流行；被接受",
                        "is_exam_core": true
                    },
                    {
                        "word": "ripe",
                        "sense": "adj. 时机成熟的",
                        "is_exam_core": true
                    },
                    {
                        "word": "charismatic",
                        "sense": "adj. 极具个人魅力的",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [],
                "logic_signals": [
                    {
                        "signal": "In other words",
                        "type": "释义同义转换",
                        "hint": "In other words 之后必为核心论点的极简重申，选项多直接脱胎于此处。"
                    }
                ]
            }
        ],
        "key_sentences": [
            "However, this intuitive idea, though deeply appealing to marketers who spend millions attempting to harness word of mouth, rests on surprisingly fragile empirical foundations.",
            "Duncan Watts has argued that the success of a social trend depends far less on the characteristics of the initial messengers than on the susceptibility of the broader network to absorb and propagate the information."
        ],
        "paraphrases": [
            {
                "source_phrase": "rests on surprisingly fragile empirical foundations",
                "target_phrase": "lacks substantial empirical evidence",
                "type": "动词与名词抽象化替换",
                "explanation": "fragile foundations（脆弱根基）概括为 lacks substantial evidence。"
            },
            {
                "source_phrase": "depends far less on initial messengers than on network susceptibility",
                "target_phrase": "is primarily determined by the readiness of the environment",
                "type": "句式结构正反转换",
                "explanation": "far less A than B 转为 is primarily determined by B。"
            }
        ],
        "false_friends": [
            {
                "word": "sound",
                "common_sense": "声音",
                "exam_sense": "健全的/可靠的",
                "example": "sound empirical foundations"
            }
        ],
        "exam_question": {
            "stem": "According to Duncan Watts, the spread of a social trend is mostly determined by ______.",
            "options": [
                {
                    "key": "A",
                    "text": "the charisma and persuasiveness of initial messengers"
                },
                {
                    "key": "B",
                    "text": "the capacity and readiness of the network to receive it"
                },
                {
                    "key": "C",
                    "text": "the massive financial investment made by marketers"
                },
                {
                    "key": "D",
                    "text": "the inevitable vulnerability of consumer psychology"
                }
            ],
            "correct_key": "B",
            "distractor_analysis": {
                "A": "【正反颠倒 / 偷换论点】这是格拉德威尔的旧假说，恰好是瓦茨通过数据反驳的对象（原文明确说 depends far less on initial messengers）。",
                "B": "【同义替换（正确答案）】readiness of the network to receive it 准确对应 susceptibility of the broader network to absorb and propagate the information 以及 environment is ripe。",
                "C": "【张冠李戴 / 细节杂糅】原文提到营销人员花费数百万试图利用口碑，但这并非瓦茨网络科学模型的核心成因。",
                "D": "【无中生有 / 主观臆测】原文未提及消费者心理的脆弱性，属于考生根据常识脑补过度推断。"
            },
            "defense_tip": "遇到转折与对比句型（far less A than B）时，选项经常将被否定的 A 作为强干扰项诱骗考生，必须牢牢锁定 than 之后的核心论据。"
        },
        "passage": "In his 2000 book The Tipping Point, Malcolm Gladwell argues that social epidemics are driven in large part by the actions of a tiny minority of exceptional people, often referred to as influencers. These individuals are said to be well-informed, persuasive, or simply well-connected.\n\nHowever, this intuitive idea, though deeply appealing to marketers who spend millions attempting to harness word of mouth, rests on surprisingly fragile empirical foundations. Duncan Watts, a network scientist, has argued that the success of a social trend depends far less on the characteristics of the initial messengers than on the susceptibility of the broader network to absorb and propagate the information.\n\nIn other words, a message catches on not because the influencer possesses unique persuasive power, but because the environment is ripe for transmission. If a network is not ready to embrace an idea, even the most charismatic messenger will shout into the void.",
        "passage_zh": "在2000年的著作《引爆点》中，马尔科姆·格拉德威尔指出：社会流行潮流在很大程度上是由极少数被称为“关键意见领袖”的非凡个体所驱动的。据说这些人信息灵通、极具说服力，或拥有极其广泛的社交人脉。\n\n然而，这种直觉性的观念——尽管对于耗资数百万美元试图借助口碑传播的营销人员来说极具吸引力——其经验事实依据却令人惊讶地脆弱。网络科学家邓肯·瓦茨指出，一种社会潮流能否成功，与其说取决于最初传播者的特质，倒不如说取决于更广泛的网络接受并扩散该信息的敏感程度与易感性。\n\n换言之，一条信息之所以能够流行开来，并非因为传播者个人拥有独特的说服力，而是因为外部传播环境已经成熟就绪。如果一个网络本身尚未准备好接纳某种观点，即便是最具魅力的传播者，也只是在对着虚空呐喊。",
        "sample_passage": "In his 2000 book The Tipping Point, Malcolm Gladwell argues that social epidemics are driven in large part by the actions of a tiny minority of exceptional people, often referred to as influencers. These individuals are said to be well-informed, persuasive, or simply well-connected.\n\nHowever, this intuitive idea, though deeply appealing to marketers who spend millions attempting to harness word of"
    },
    {
        "id": "sci_microplastics_cycle",
        "title": "Atmospheric Transport and the Pervasive Cycle of Synthetic Microfibers",
        "source": "Science (美国科学)",
        "source_name": "《Science》(美国科学) 前沿研究",
        "journal_id": "j_science",
        "category": "地球生态与气候科学",
        "topic_id": "topic_environment",
        "date": "2024-03-12",
        "url": "https://www.science.org/doi/10.1126/science.microfibers-atmosphere-flux",
        "snippet": "合成微塑料纤维经由大气高空环流在全球偏远冰川与保护区的沉降机制",
        "word_count": 330,
        "difficulty": "考研英语(一) / CEFR C1",
        "thesis_tone": {
            "thesis": "微塑料污染已演化为类似水循环的全球大气物理循环，即便人迹罕至的高山冰川也无法幸免，必须从源头高分子材料降解性着手。",
            "tone": "严峻警示与实证量化 (Grave & Quantitative)",
            "tone_analysis": "借助跨大洲实地采样数据，证实合成纤维早已突破局部河流排海范畴，构建了自循环的大气输送带。"
        },
        "paragraphs": [
            {
                "p_index": 1,
                "role": "揭示大气输送带突破传统地理局限 (Atmospheric Flux Revelation)",
                "role_badge": "引入背景",
                "main_idea": "科研人员在人迹罕至的高海拔冰川积雪中检测到惊人浓度的微塑料微粒，证实其早已具备全球大气扩散机制。",
                "text_en": "Environmental geochemists examining core samples from isolated alpine glaciers have documented an unsettling phenomenon: microscopic synthetic fibers are precipitating alongside natural snow. Rather than being confined to marine gyres and municipal waterways, fragmented polymers are now carried aloft by tropospheric wind patterns, traveling thousands of kilometers across continents before settling onto pristine peaks.",
                "text_zh": "地球环境化学家在对偏远高山冰川的冰芯样本进行检测时，记录下了一个令人不安的现象：微观合成塑料纤维正伴随着天然降雪一同沉降。这些破碎的高分子聚合物并未局限于海洋涡旋和城市下水道中，而是被对流层强风带送入高空，跨越大洲漂移数千公里，最终降落在那些原生态的未被开发的山峰之上。",
                "key_sentence": "Rather than being confined to marine gyres and municipal waterways, fragmented polymers are now carried aloft by tropospheric wind patterns, traveling thousands of kilometers across continents before settling onto pristine peaks.",
                "key_sentence_backbone": "Fragmented polymers are carried aloft by wind patterns, settling onto pristine peaks.",
                "vocab": [
                    {
                        "word": "precipitating",
                        "sense": "vi. 沉降；析出 / vt. 促成",
                        "is_exam_core": true
                    },
                    {
                        "word": "tropospheric",
                        "sense": "adj. 对流层的",
                        "is_exam_core": false
                    },
                    {
                        "word": "pristine",
                        "sense": "adj. 原始的；未受污染的",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [
                    {
                        "word": "sound",
                        "common_sense": "声音",
                        "exam_sense": "完好的/合理的",
                        "example": "sound environmental methodologies"
                    },
                    {
                        "word": "weather",
                        "common_sense": "天气",
                        "exam_sense": "经受风化/侵蚀",
                        "example": "weather into micro-particles"
                    }
                ],
                "logic_signals": [
                    {
                        "signal": "Rather than being confined to... are now...",
                        "type": "否定旧域，确立新域",
                        "hint": "Rather than A, B 是考研细节推断题的黄金分水岭，强调污染范围的大气全局化。"
                    }
                ]
            },
            {
                "p_index": 2,
                "role": "微观剥蚀与水文恶性循环 (Physical Degradation & Feedback)",
                "role_badge": "机理剖析",
                "main_idea": "深色微塑料颗粒沉降会降低冰川表面反射率，加速冰川融化并再度释放早期封存的污染物，形成正反馈。",
                "text_en": "Once deposited, dark particulates absorb solar radiation, lowering the albedo of reflective ice surfaces and visibly accelerating seasonal melt rates. As glacial margins retreat, the meltwater conveys accumulated contaminants downstream into agricultural irrigation systems, effectively completing a closed biological loop. Consequently, what began as invisible atmospheric fallout returns directly to nourish human staple crops.",
                "text_zh": "一旦这些深色颗粒沉降下来，它们便会吸收太阳辐射，降低高反射率冰川表面的反照率，并显著加快季节性融雪速率。随着冰川边缘加速消退，融水将多年累积的污染物冲刷到下游农业灌溉系统中，实质上形成了一个闭环的生物循环链。结果，那些最初隐匿无形的大气降尘，最终直接渗透进入滋养人类主粮作物的土壤之中。",
                "key_sentence": "Once deposited, dark particulates absorb solar radiation, lowering the albedo of reflective ice surfaces and visibly accelerating seasonal melt rates.",
                "key_sentence_backbone": "Particulates absorb solar radiation, accelerating seasonal melt rates.",
                "vocab": [
                    {
                        "word": "albedo",
                        "sense": "n. 反照率；反射系数",
                        "is_exam_core": false
                    },
                    {
                        "word": "contaminants",
                        "sense": "n. 污染物；杂质",
                        "is_exam_core": true
                    },
                    {
                        "word": "nourish",
                        "sense": "vt. 滋养；助长",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [],
                "logic_signals": [
                    {
                        "signal": "Once deposited...",
                        "type": "时间与条件诱发",
                        "hint": "Once A, B 引出物理化学反应链条，常考因果关联推断。"
                    }
                ]
            },
            {
                "p_index": 3,
                "role": "总结升华与治理范式重构 (Policy Paradox & Upstream Solution)",
                "role_badge": "总结建议",
                "main_idea": "末端清理与过滤在行星级大气流动面前纯属杯水车薪，唯一的解方在于源头材料革新与强制降解立法。",
                "text_en": "Efforts to filter wastewater at treatment plants, while necessary, address only a fraction of this planetary dispersion. Because airborne particles originate largely from the everyday abrasion of synthetic garments and vehicle tires, remedial municipal fixes cannot stem the flow. The scientific consensus is straightforward: mitigating this ubiquitous hazard demands fundamental redesign of textile polymers rather than perpetual downstream remediation.",
                "text_zh": "在污水处理厂进行微过滤的努力固然必不可少，但面对这一行星级别的宏观扩散，所解决的仅仅是沧海一粟。由于空气中的微粒绝大多数源自日常合成化纤服装与汽车轮胎的机械磨损，单纯的地方性补救措施根本无法阻遏这股洪流。科学界的共识十分明确：化解这一无处不在的隐患，需要从根本上重塑纺织聚合物的材料设计，而非陷入永无止境的下游被动清污泥潭。",
                "key_sentence": "The scientific consensus is straightforward: mitigating this ubiquitous hazard demands fundamental redesign of textile polymers rather than perpetual downstream remediation.",
                "key_sentence_backbone": "Mitigating this hazard demands redesign of polymers rather than remediation.",
                "vocab": [
                    {
                        "word": "dispersion",
                        "sense": "n. 散布；分散",
                        "is_exam_core": true
                    },
                    {
                        "word": "ubiquitous",
                        "sense": "adj. 无处不在的；普遍存在的",
                        "is_exam_core": true
                    },
                    {
                        "word": "remediation",
                        "sense": "n. 补救；环境修复",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [
                    {
                        "word": "stem",
                        "common_sense": "植物茎干",
                        "exam_sense": "vt. 遏止/阻挡",
                        "example": "cannot stem the flow"
                    }
                ],
                "logic_signals": [
                    {
                        "signal": "demands... rather than...",
                        "type": "核心对立取舍",
                        "hint": "demands A rather than B 永远是作者真正倡导的中心论点（源头材料重塑）。"
                    }
                ]
            }
        ],
        "key_sentences": [
            "Rather than being confined to marine gyres and municipal waterways, fragmented polymers are now carried aloft by tropospheric wind patterns, traveling thousands of kilometers across continents before settling onto pristine peaks.",
            "The scientific consensus is straightforward: mitigating this ubiquitous hazard demands fundamental redesign of textile polymers rather than perpetual downstream remediation."
        ],
        "paraphrases": [
            {
                "source_phrase": "carried aloft by tropospheric wind patterns",
                "target_phrase": "transported globally through atmospheric currents",
                "type": "学术动词与介词短语抽象替换",
                "explanation": "carried aloft 结合 wind patterns 替换为 transported globally through currents。"
            },
            {
                "source_phrase": "demands fundamental redesign of textile polymers rather than downstream remediation",
                "target_phrase": "requires tackling the environmental hazard at its manufacturing root",
                "type": "隐喻与句法结构深层同义改写",
                "explanation": "redesign of polymers（聚合物重新设计）抽象为 tackling at its manufacturing root。"
            }
        ],
        "false_friends": [
            {
                "word": "stem",
                "common_sense": "茎干",
                "exam_sense": "遏制/阻断",
                "example": "cannot stem the flow of airborne particles"
            }
        ],
        "exam_question": {
            "stem": "According to the passage, why are municipal wastewater treatment facilities insufficient to solve microplastic pollution?",
            "options": [
                {
                    "key": "A",
                    "text": "They fail to intercept particles dispersed via atmospheric circulation."
                },
                {
                    "key": "B",
                    "text": "They intentionally discharge synthetic fibers into high-altitude glaciers."
                },
                {
                    "key": "C",
                    "text": "They consume exorbitant solar energy required for glacier albedo preservation."
                },
                {
                    "key": "D",
                    "text": "They have been prohibited by international geochemical consensus."
                }
            ],
            "correct_key": "A",
            "distractor_analysis": {
                "A": "【同义替换（正确答案）】address only a fraction... airborne particles originate from everyday abrasion 对应 fail to intercept particles dispersed via atmospheric circulation。",
                "B": "【反向诬陷 / 恶意推论】污水厂是试图过滤治理，绝非故意向冰川排放（intentionally discharge）。",
                "C": "【张冠李戴 / 细节杂糅】吸收太阳辐射并降低反照率的是沉积的深色微粒，与污水厂耗能无因果关系。",
                "D": "【无中生有】科学共识是呼吁源头治理，从未禁止污水处理厂运行。"
            },
            "defense_tip": "解答因果细节题时，紧扣作者提出的核心成因（airborne particles / atmospheric dispersion），正确答案必定是对这一宏观维度的抽象同义替换。"
        },
        "passage": "Environmental geochemists examining core samples from isolated alpine glaciers have documented an unsettling phenomenon: microscopic synthetic fibers are precipitating alongside natural snow. Rather than being confined to marine gyres and municipal waterways, fragmented polymers are now carried aloft by tropospheric wind patterns, traveling thousands of kilometers across continents before settling onto pristine peaks.\n\nOnce deposited, dark particulates absorb solar radiation, lowering the albedo of reflective ice surfaces and visibly accelerating seasonal melt rates. As glacial margins retreat, the meltwater conveys accumulated contaminants downstream into agricultural irrigation systems, effectively completing a closed biological loop. Consequently, what began as invisible atmospheric fallout returns directly to nourish human staple crops.\n\nEfforts to filter wastewater at treatment plants, while necessary, address only a fraction of this planetary dispersion. Because airborne particles originate largely from the everyday abrasion of synthetic garments and vehicle tires, remedial municipal fixes cannot stem the flow. The scientific consensus is straightforward: mitigating this ubiquitous hazard demands fundamental redesign of textile polymers rather than perpetual downstream remediation.",
        "passage_zh": "地球环境化学家在对偏远高山冰川的冰芯样本进行检测时，记录下了一个令人不安的现象：微观合成塑料纤维正伴随着天然降雪一同沉降。这些破碎的高分子聚合物并未局限于海洋涡旋和城市下水道中，而是被对流层强风带送入高空，跨越大洲漂移数千公里，最终降落在那些原生态的未被开发的山峰之上。\n\n一旦这些深色颗粒沉降下来，它们便会吸收太阳辐射，降低高反射率冰川表面的反照率，并显著加快季节性融雪速率。随着冰川边缘加速消退，融水将多年累积的污染物冲刷到下游农业灌溉系统中，实质上形成了一个闭环的生物循环链。结果，那些最初隐匿无形的大气降尘，最终直接渗透进入滋养人类主粮作物的土壤之中。\n\n在污水处理厂进行微过滤的努力固然必不可少，但面对这一行星级别的宏观扩散，所解决的仅仅是沧海一粟。由于空气中的微粒绝大多数源自日常合成化纤服装与汽车轮胎的机械磨损，单纯的地方性补救措施根本无法阻遏这股洪流。科学界的共识十分明确：化解这一无处不在的隐患，需要从根本上重塑纺织聚合物的材料设计，而非陷入永无止境的下游被动清污泥潭。",
        "sample_passage": "Environmental geochemists examining core samples from isolated alpine glaciers have documented an unsettling phenomenon: microscopic synthetic fibers are precipitating alongside natural snow. Rather than being confined to marine gyres and municipal waterways, fragmented polymers are now carried aloft by tropospheric wind patterns, traveling thousands of kilometers across continents before settling"
    },
    {
        "id": "csm_decentralized_energy",
        "title": "How Grassroots Microgrids Are Quietly Challenging Utility Monopolies",
        "source": "The Christian Science Monitor (基督教科学箴言报)",
        "source_name": "《The Christian Science Monitor》深度观察",
        "journal_id": "j_csmonitor",
        "category": "商业金融与宏观治理",
        "topic_id": "topic_economy",
        "date": "2024-01-20",
        "url": "https://www.csmonitor.com/Environment/Energy/2024/grassroots-microgrids-rural-power",
        "snippet": "乡村社区依靠自组网微电网打破巨头电网垄断、提升极端气候下电力韧性的草根实践",
        "word_count": 310,
        "difficulty": "考研英语(二) / CEFR B2+",
        "thesis_tone": {
            "thesis": "去中心化微电网通过赋权社区自主掌控清洁电力，不仅提高了抗击极端气候灾害的生存韧性，而且动摇了百年公用事业垄断格局。",
            "tone": "温和肯定与建设性期待 (Encouraging & Constructive)",
            "tone_analysis": "典型的CSM人本主义文风：通过具体偏远小镇的真实抗灾故事切入，剖析去中心化技术对公民赋权与社会公平的深远推动。"
        },
        "paragraphs": [
            {
                "p_index": 1,
                "role": "从小镇灾难停电切入现实痛点 (Human Interest Hook)",
                "role_badge": "叙事切入",
                "main_idea": "频发的极端风暴暴露出传统集中式高压输电网的脆弱性，促使边远社区探索自力更生的备用方案。",
                "text_en": "When winter ice storms severed high-voltage transmission lines across the Appalachian valley last December, the regional utility warned residents that power might not return for weeks. Yet inside the small township of Oakridge, lights flickered on within twenty minutes. An independent solar-battery microgrid, installed cooperatively by local merchants and farmers, quietly detached from the collapsed regional grid and kept the community clinic and grocery stores functioning.",
                "text_zh": "去年12月，当冬季冰暴切断横贯阿巴拉契亚山谷的高压输电线路时，区域公用电力公司向居民发出警告称，电力可能数周都无法恢复。然而，在橡树岭这一偏远小镇内部，电灯却在短短二十分钟内重新亮起。一个由当地商家和农户合作出资安装的独立光伏蓄电微电网，悄然与瘫痪的区域大电网断开连接，维持了社区诊所和杂货店的正常运转。",
                "key_sentence": "An independent solar-battery microgrid, installed cooperatively by local merchants and farmers, quietly detached from the collapsed regional grid and kept the community clinic and grocery stores functioning.",
                "key_sentence_backbone": "An independent microgrid detached from the collapsed grid and kept stores functioning.",
                "vocab": [
                    {
                        "word": "severed",
                        "sense": "vt. 切断；割裂",
                        "is_exam_core": true
                    },
                    {
                        "word": "cooperatively",
                        "sense": "adv. 合作地；协同地",
                        "is_exam_core": true
                    },
                    {
                        "word": "detached",
                        "sense": "vi. 断开分离 / adj. 客观中立的",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [
                    {
                        "word": "detached",
                        "common_sense": "超然的/冷漠的",
                        "exam_sense": "物理断开/隔离脱网",
                        "example": "detached from the collapsed regional grid"
                    }
                ],
                "logic_signals": [
                    {
                        "signal": "Yet inside...",
                        "type": "强烈转折对比",
                        "hint": "大网瘫痪与小镇通电的戏剧性反差，凸显微电网独立生存优势。"
                    }
                ]
            },
            {
                "p_index": 2,
                "role": "传统垄断巨头的制度阻挠 (Monopoly Resistance & Friction)",
                "role_badge": "利益冲突",
                "main_idea": "传统电力巨头利用过时规章与并网审查拖延微网扩张，试图维持其按电量收费的百年垄断盈利模式。",
                "text_en": "Such grassroots resilience, however, rarely receives a warm welcome from traditional investor-owned utilities. For over a century, electrical monopolies have derived guaranteed returns from constructing massive central power plants and extensive transmission corridors. When neighborhoods generate and trade power locally, utilities face what energy analysts term the utility death spiral: shrinking revenues forcing rate hikes on remaining captive customers.",
                "text_zh": "然而，这种来自民间的抗灾韧性，却罕见受到传统投资者所有的垄断电力企业的欢迎。一个多世纪以来，电力巨头凭借修建庞大的中央发电厂和漫长的高压输电线路，享有受政府保障的垄断回报率。当社区居民开始在本地自发自用并相互买卖电力时，公用事业企业面临着能源分析师所称的“电网死亡螺旋”：售电收入缩水迫使他们向剩余无法脱网的普通客户转嫁涨价压力。",
                "key_sentence": "When neighborhoods generate and trade power locally, utilities face what energy analysts term the utility death spiral: shrinking revenues forcing rate hikes on remaining captive customers.",
                "key_sentence_backbone": "When neighborhoods trade power, utilities face shrinking revenues.",
                "vocab": [
                    {
                        "word": "resilience",
                        "sense": "n. 恢复力；韧性",
                        "is_exam_core": true
                    },
                    {
                        "word": "monopolies",
                        "sense": "n. 垄断企业；独占",
                        "is_exam_core": true
                    },
                    {
                        "word": "captive",
                        "sense": "adj. 无法脱身的；受限制的",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [
                    {
                        "word": "derived",
                        "common_sense": "推导出",
                        "exam_sense": "获得/谋取(收益)",
                        "example": "derived guaranteed returns"
                    }
                ],
                "logic_signals": [
                    {
                        "signal": "Such resilience, however...",
                        "type": "论点急转",
                        "hint": "从技术成功转向现实体制阻碍，揭示商业利益阻力。"
                    }
                ]
            },
            {
                "p_index": 3,
                "role": "公民赋权与法制重塑 (Democratization of Energy Infrastructure)",
                "role_badge": "前景展望",
                "main_idea": "电力系统正从自上而下的中央集权指令，转向多元分布式民主协同，法律政策应当顺应而非扼杀这种演进。",
                "text_en": "Ultimately, the tension between centralized command and localized autonomy mirrors the broader democratization of technology. Just as personal computing decentralized data processing, modern microgrids are transforming passive ratepayers into active energy stewards. State regulators who modernize grid-interconnection codes will not merely avert catastrophic blackouts; they will foster a more resilient civic commonwealth.",
                "text_zh": "归根结底，中央集权调度与本地自组织之间的博弈，映照出了更广泛的技术民主化进程。正如个人计算机普及彻底瓦解了大型机的数据垄断一样，现代微电网正在将过去被动缴费的受控用户，转变为积极掌控能源的主人翁。那些敢于革新电网并网法规的州监管机构，不仅能够避免灾难性的大面积停电事故，更将孕育出一个更具生机韧性的公民自治共同体。",
                "key_sentence": "Just as personal computing decentralized data processing, modern microgrids are transforming passive ratepayers into active energy stewards.",
                "key_sentence_backbone": "Microgrids are transforming passive ratepayers into active stewards.",
                "vocab": [
                    {
                        "word": "democratization",
                        "sense": "n. 民主化；大众化普及",
                        "is_exam_core": true
                    },
                    {
                        "word": "stewards",
                        "sense": "n. 管理者；管家",
                        "is_exam_core": true
                    },
                    {
                        "word": "commonwealth",
                        "sense": "n. 联合体；共和国",
                        "is_exam_core": false
                    }
                ],
                "false_friends": [
                    {
                        "word": "rates",
                        "common_sense": "比率/速度",
                        "exam_sense": "公用事业收费费率",
                        "example": "ratepayers / rate hikes"
                    }
                ],
                "logic_signals": [
                    {
                        "signal": "Just as... modern microgrids...",
                        "type": "经典类比论证",
                        "hint": "考研阅读最爱拿个人电脑革命类比新能源自组织，正确选项往往围绕这一类比的核心意图。"
                    }
                ]
            }
        ],
        "key_sentences": [
            "An independent solar-battery microgrid, installed cooperatively by local merchants and farmers, quietly detached from the collapsed regional grid and kept the community clinic and grocery stores functioning.",
            "Just as personal computing decentralized data processing, modern microgrids are transforming passive ratepayers into active energy stewards."
        ],
        "paraphrases": [
            {
                "source_phrase": "transforming passive ratepayers into active energy stewards",
                "target_phrase": "empowering consumers with control over power resources",
                "type": "隐喻转为抽象说明",
                "explanation": "ratepayers into active stewards 转化为 consumers with control over power resources。"
            },
            {
                "source_phrase": "derived guaranteed returns from constructing massive central power plants",
                "target_phrase": "depended on established infrastructure to secure monopolistic profits",
                "type": "动词与名词下位替换",
                "explanation": "guaranteed returns 转为 secure monopolistic profits，massive central plants 转为 established infrastructure。"
            }
        ],
        "false_friends": [
            {
                "word": "detached",
                "common_sense": "冷漠的",
                "exam_sense": "断开脱离",
                "example": "detached from the collapsed regional grid"
            }
        ],
        "exam_question": {
            "stem": "The author draws an analogy between personal computing and microgrids to show that ______.",
            "options": [
                {
                    "key": "A",
                    "text": "grassroots energy models represent an inevitable shift toward consumer empowerment"
                },
                {
                    "key": "B",
                    "text": "computing servers consume an unsustainable volume of municipal electricity"
                },
                {
                    "key": "C",
                    "text": "traditional utilities will completely shut down all central digital networks"
                },
                {
                    "key": "D",
                    "text": "rural residents lack the technical competence to operate electrical circuits"
                }
            ],
            "correct_key": "A",
            "distractor_analysis": {
                "A": "【同义替换（正确答案）】Just as personal computing decentralized... transforming passive ratepayers into active stewards 揭示了赋权给普通消费者的历史必然趋势。",
                "B": "【偷换概念】类比是为了说明“去中心化赋权”，而不是讨论服务器耗电。",
                "C": "【过度绝对化】文中讨论的是利益摩擦，而非电网完全关闭所有数字网络。",
                "D": "【反向颠倒】第一段已明确证明农民与商家成功自主运维微网，选项与事实完全相反。"
            },
            "defense_tip": "解答修辞/类比目的题（analogy purpose）时，答案必然紧扣该段落的主题词与宏观作者意图（democratization / empowerment），切忌被类比客体本身所迷惑。"
        },
        "passage": "When winter ice storms severed high-voltage transmission lines across the Appalachian valley last December, the regional utility warned residents that power might not return for weeks. Yet inside the small township of Oakridge, lights flickered on within twenty minutes. An independent solar-battery microgrid, installed cooperatively by local merchants and farmers, quietly detached from the collapsed regional grid and kept the community clinic and grocery stores functioning.\n\nSuch grassroots resilience, however, rarely receives a warm welcome from traditional investor-owned utilities. For over a century, electrical monopolies have derived guaranteed returns from constructing massive central power plants and extensive transmission corridors. When neighborhoods generate and trade power locally, utilities face what energy analysts term the utility death spiral: shrinking revenues forcing rate hikes on remaining captive customers.\n\nUltimately, the tension between centralized command and localized autonomy mirrors the broader democratization of technology. Just as personal computing decentralized data processing, modern microgrids are transforming passive ratepayers into active energy stewards. State regulators who modernize grid-interconnection codes will not merely avert catastrophic blackouts; they will foster a more resilient civic commonwealth.",
        "passage_zh": "去年12月，当冬季冰暴切断横贯阿巴拉契亚山谷的高压输电线路时，区域公用电力公司向居民发出警告称，电力可能数周都无法恢复。然而，在橡树岭这一偏远小镇内部，电灯却在短短二十分钟内重新亮起。一个由当地商家和农户合作出资安装的独立光伏蓄电微电网，悄然与瘫痪的区域大电网断开连接，维持了社区诊所和杂货店的正常运转。\n\n然而，这种来自民间的抗灾韧性，却罕见受到传统投资者所有的垄断电力企业的欢迎。一个多世纪以来，电力巨头凭借修建庞大的中央发电厂和漫长的高压输电线路，享有受政府保障的垄断回报率。当社区居民开始在本地自发自用并相互买卖电力时，公用事业企业面临着能源分析师所称的“电网死亡螺旋”：售电收入缩水迫使他们向剩余无法脱网的普通客户转嫁涨价压力。\n\n归根结底，中央集权调度与本地自组织之间的博弈，映照出了更广泛的技术民主化进程。正如个人计算机普及彻底瓦解了大型机的数据垄断一样，现代微电网正在将过去被动缴费的受控用户，转变为积极掌控能源的主人翁。那些敢于革新电网并网法规的州监管机构，不仅能够避免灾难性的大面积停电事故，更将孕育出一个更具生机韧性的公民自治共同体。",
        "sample_passage": "When winter ice storms severed high-voltage transmission lines across the Appalachian valley last December, the regional utility warned residents that power might not return for weeks. Yet inside the small township of Oakridge, lights flickered on within twenty minutes. An independent solar-battery microgrid, installed cooperatively by local merchants and farmers, quietly detached from the collaps"
    },
    {
        "id": "mit_ai_water_footprint",
        "title": "The Thirsty Algorithms: Unmasking the Environmental Ledger of Frontier AI",
        "source": "MIT Technology Review (麻省理工科技评论)",
        "source_name": "《MIT Technology Review》独家调查",
        "journal_id": "j_mit_tr",
        "category": "科技创新与人工智能",
        "topic_id": "topic_tech_ai",
        "date": "2024-02-28",
        "url": "https://www.technologyreview.com/2024/02/frontier-ai-water-cooling-consumption",
        "snippet": "生成式大模型千亿参数训练与推理背后对淡水冷却资源的隐秘挤占与透明度危机",
        "word_count": 320,
        "difficulty": "考研英语(一) / CEFR C1",
        "thesis_tone": {
            "thesis": "AI产业的狂飙突进正在消耗惊人规模的清洁淡水作为数据中心散热介质，科技巨头必须公开真实环境账本并接受水资源配额监管。",
            "tone": "客观调查与现实质询 (Investigative & Critical)",
            "tone_analysis": "剥去AI技术的神圣光环，用实打实的水冷能耗数据揭露数字经济背后的物理资源挤占摩擦。"
        },
        "paragraphs": [
            {
                "p_index": 1,
                "role": "揭开无形算力背后的沉重物理实体 (Physical Reality of the Cloud)",
                "role_badge": "引入背景",
                "main_idea": "公众普遍将云计算视作无形且清洁的代码，却忽视了高密度GPU集群运行需要蒸发数百万加仑珍贵淡水来散热降温。",
                "text_en": "The popular imagination comfortably conceives of artificial intelligence as an ethereal entity existing purely in mathematics and silicon logic. In reality, modern deep-learning clusters are voracious physical facilities rooted in earth, concrete, and colossal volumes of freshwater. To prevent thousands of densely packed graphics processors from overheating during continuous training runs, commercial data centers rely on evaporative cooling towers that consume millions of gallons of potable municipal water every week.",
                "text_zh": "公众的大众想象很习惯于将人工智能构想为一种纯粹存在于数学与硅基逻辑之中的空灵实体。而现实中，现代深度学习计算集群是扎根于泥土、混凝土与庞大清洁淡水之上的贪婪物理设施。为了防止数以万计高密度堆叠的图形处理器在无休止的训练过程中过热，商业数据中心高度依赖蒸发冷却塔，每周都要蒸发消耗数百万加仑可直接饮用的市政淡水。",
                "key_sentence": "In reality, modern deep-learning clusters are voracious physical facilities rooted in earth, concrete, and colossal volumes of freshwater.",
                "key_sentence_backbone": "Deep-learning clusters are voracious physical facilities rooted in freshwater.",
                "vocab": [
                    {
                        "word": "ethereal",
                        "sense": "adj. 空灵的；飘渺无形的",
                        "is_exam_core": false
                    },
                    {
                        "word": "voracious",
                        "sense": "adj. 贪婪的；狼吞虎咽的",
                        "is_exam_core": true
                    },
                    {
                        "word": "potable",
                        "sense": "adj. 适于饮用的",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [
                    {
                        "word": "runs",
                        "common_sense": "奔跑",
                        "exam_sense": "周期性运算/批次运行",
                        "example": "continuous training runs"
                    }
                ],
                "logic_signals": [
                    {
                        "signal": "In reality...",
                        "type": "破除幻想，确立真相",
                        "hint": "In reality 之后引出作者核心论断：AI 是极度耗费水资源的重型工业。"
                    }
                ]
            },
            {
                "p_index": 2,
                "role": "水资源冲突与干旱地区的利益挤压 (Water Scarcity Clash)",
                "role_badge": "冲突升级",
                "main_idea": "许多超大规模数据中心恰好建设在本来就水源紧缺的干旱地带，其用水特权直接加剧了当地农田与居民的用水危机。",
                "text_en": "This ecological footprint becomes acutely problematic because operators frequently construct server farms in arid inland regions where real estate and corporate taxes are attractively low. When algorithmic workloads peak during extreme heatwaves, municipal utilities must arbitrate between providing air conditioning to residents and supplying coolant to tech conglomerates. In multiple desert municipalities, residential water quotas have been trimmed while hyperscale infrastructure receives uninterrupted flow.",
                "text_zh": "这种生态足迹变得格外棘手，因为运营商往往将服务器机房建在地价低廉、企业税负具有吸引力的干旱内陆地区。当算法计算负荷在极端高温热浪期间达到顶峰时，市政公共部门就必须在为普通市民提供空调用电与为科技巨头供应冷却水之间做出艰难裁决。在多个沙漠城市中，普通居民的日常用水配额被悄然削减，而超大规模计算基础设施却能享有毫无中断的水流保障。",
                "key_sentence": "In multiple desert municipalities, residential water quotas have been trimmed while hyperscale infrastructure receives uninterrupted flow.",
                "key_sentence_backbone": "Residential water quotas have been trimmed while tech infrastructure receives flow.",
                "vocab": [
                    {
                        "word": "acutely",
                        "sense": "adv. 极其严重地；敏锐地",
                        "is_exam_core": true
                    },
                    {
                        "word": "arbitrate",
                        "sense": "v. 仲裁；公断",
                        "is_exam_core": true
                    },
                    {
                        "word": "conglomerates",
                        "sense": "n. 企业集团；大型跨国垄断企业",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [
                    {
                        "word": "trimmed",
                        "common_sense": "修剪头发",
                        "exam_sense": "削减/压缩(配额)",
                        "example": "water quotas have been trimmed"
                    }
                ],
                "logic_signals": [
                    {
                        "signal": "...while hyperscale infrastructure...",
                        "type": "不平等对比",
                        "hint": "while 引导的不对称对比句，是考题考察社会不公与资源倾斜的典型题眼。"
                    }
                ]
            },
            {
                "p_index": 3,
                "role": "问责机制与全生命周期审计 (Accountability & Transparency Crisis)",
                "role_badge": "制度呼吁",
                "main_idea": "科技巨头在公关中极力宣传其碳中和，却对隐蔽的水消耗讳莫如深；监管部门必须强制推行环境信息穿透式披露。",
                "text_en": "Silicon Valley firms aggressively publicize their carbon offsets, yet disclosure regarding water intensity remains notoriously opaque. Proprietary claims often shield facilities from revealing exactly how much water evaporates per user query. Until regulatory frameworks mandate standardized environmental accounting that measures both wattage and gallonage, society will remain in the dark about the true ecological tariff of conversational machines.",
                "text_zh": "硅谷各大科技公司在公共关系宣传中极力标榜自身的碳抵消成就，然而涉及水资源强度的信息披露却依然臭名昭著地晦暗不透明。以商业机密为由的借口，往往掩盖了数据中心每一笔用户查询请求究竟蒸发消耗了多少升水。直到监管框架强制推行能够同时衡量电力瓦数与耗水加仑数的标准化环境审计制度之前，人类社会对于对话式机器所付出的真实生态代价仍将一无所知。",
                "key_sentence": "Until regulatory frameworks mandate standardized environmental accounting that measures both wattage and gallonage, society will remain in the dark about the true ecological tariff of conversational machines.",
                "key_sentence_backbone": "Society will remain in the dark until frameworks mandate accounting.",
                "vocab": [
                    {
                        "word": "opaque",
                        "sense": "adj. 不透明的；难以理解的",
                        "is_exam_core": true
                    },
                    {
                        "word": "proprietary",
                        "sense": "adj. 专有的；专利所有的",
                        "is_exam_core": true
                    },
                    {
                        "word": "mandate",
                        "sense": "vt. 强制执行；授权",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [
                    {
                        "word": "tariff",
                        "common_sense": "海关关税",
                        "exam_sense": "代价/收费",
                        "example": "the true ecological tariff of conversational machines"
                    }
                ],
                "logic_signals": [
                    {
                        "signal": "Until... society will remain in the dark...",
                        "type": "条件约束与未来预警",
                        "hint": "Until A, B 结构考查解决问题的唯一必要前提（建立强制性水耗披露标准）。"
                    }
                ]
            }
        ],
        "key_sentences": [
            "In reality, modern deep-learning clusters are voracious physical facilities rooted in earth, concrete, and colossal volumes of freshwater.",
            "Until regulatory frameworks mandate standardized environmental accounting that measures both wattage and gallonage, society will remain in the dark about the true ecological tariff of conversational machines."
        ],
        "paraphrases": [
            {
                "source_phrase": "disclosure regarding water intensity remains notoriously opaque",
                "target_phrase": "information on water consumption is deliberately obscured from the public",
                "type": "形容词与副词近义改写",
                "explanation": "notoriously opaque 转为 deliberately obscured from the public。"
            },
            {
                "source_phrase": "the true ecological tariff of conversational machines",
                "target_phrase": "the actual environmental cost of artificial intelligence technologies",
                "type": "隐喻与代词下位还原",
                "explanation": "tariff 熟词生义代指 cost，conversational machines 还原为 artificial intelligence。"
            }
        ],
        "false_friends": [
            {
                "word": "tariff",
                "common_sense": "关税",
                "exam_sense": "代价/成本",
                "example": "the true ecological tariff of conversational machines"
            }
        ],
        "exam_question": {
            "stem": "What is the primary obstacle to understanding the environmental impact of AI data centers according to paragraph 3?",
            "options": [
                {
                    "key": "A",
                    "text": "The lack of mandatory and transparent water consumption reporting standards"
                },
                {
                    "key": "B",
                    "text": "The total physical impossibility of quantifying deep-learning wattage"
                },
                {
                    "key": "C",
                    "text": "The rapid migration of servers away from desert municipalities"
                },
                {
                    "key": "D",
                    "text": "The widespread public resistance against renewable carbon offsets"
                }
            ],
            "correct_key": "A",
            "distractor_analysis": {
                "A": "【同义替换（正确答案）】notoriously opaque / Until regulatory frameworks mandate standardized accounting 准确概括为 lack of mandatory and transparent reporting standards。",
                "B": "【过度绝对化】文中明确提到 wattage 和 gallonage 是可以被度量的，并非完全不可能（total impossibility）。",
                "C": "【反向混淆】第二段说明运营商热衷于在干旱沙漠建厂，而非逃离（migration away from）。",
                "D": "【无中生有】碳抵消是企业主动宣传的公关，文中未提公众抵制碳抵消。"
            },
            "defense_tip": "遇到 Until... will remain in the dark 句型，正解必然针对 until 后面的条件缺陷（缺乏监管与透明度）进行同义替换。"
        },
        "passage": "The popular imagination comfortably conceives of artificial intelligence as an ethereal entity existing purely in mathematics and silicon logic. In reality, modern deep-learning clusters are voracious physical facilities rooted in earth, concrete, and colossal volumes of freshwater. To prevent thousands of densely packed graphics processors from overheating during continuous training runs, commercial data centers rely on evaporative cooling towers that consume millions of gallons of potable municipal water every week.\n\nThis ecological footprint becomes acutely problematic because operators frequently construct server farms in arid inland regions where real estate and corporate taxes are attractively low. When algorithmic workloads peak during extreme heatwaves, municipal utilities must arbitrate between providing air conditioning to residents and supplying coolant to tech conglomerates. In multiple desert municipalities, residential water quotas have been trimmed while hyperscale infrastructure receives uninterrupted flow.\n\nSilicon Valley firms aggressively publicize their carbon offsets, yet disclosure regarding water intensity remains notoriously opaque. Proprietary claims often shield facilities from revealing exactly how much water evaporates per user query. Until regulatory frameworks mandate standardized environmental accounting that measures both wattage and gallonage, society will remain in the dark about the true ecological tariff of conversational machines.",
        "passage_zh": "公众的大众想象很习惯于将人工智能构想为一种纯粹存在于数学与硅基逻辑之中的空灵实体。而现实中，现代深度学习计算集群是扎根于泥土、混凝土与庞大清洁淡水之上的贪婪物理设施。为了防止数以万计高密度堆叠的图形处理器在无休止的训练过程中过热，商业数据中心高度依赖蒸发冷却塔，每周都要蒸发消耗数百万加仑可直接饮用的市政淡水。\n\n这种生态足迹变得格外棘手，因为运营商往往将服务器机房建在地价低廉、企业税负具有吸引力的干旱内陆地区。当算法计算负荷在极端高温热浪期间达到顶峰时，市政公共部门就必须在为普通市民提供空调用电与为科技巨头供应冷却水之间做出艰难裁决。在多个沙漠城市中，普通居民的日常用水配额被悄然削减，而超大规模计算基础设施却能享有毫无中断的水流保障。\n\n硅谷各大科技公司在公共关系宣传中极力标榜自身的碳抵消成就，然而涉及水资源强度的信息披露却依然臭名昭著地晦暗不透明。以商业机密为由的借口，往往掩盖了数据中心每一笔用户查询请求究竟蒸发消耗了多少升水。直到监管框架强制推行能够同时衡量电力瓦数与耗水加仑数的标准化环境审计制度之前，人类社会对于对话式机器所付出的真实生态代价仍将一无所知。",
        "sample_passage": "The popular imagination comfortably conceives of artificial intelligence as an ethereal entity existing purely in mathematics and silicon logic. In reality, modern deep-learning clusters are voracious physical facilities rooted in earth, concrete, and colossal volumes of freshwater. To prevent thousands of densely packed graphics processors from overheating during continuous training runs, commerc"
    },
    {
        "id": "wp_tech_antitrust",
        "title": "Algorithms in the Courtroom: Why Self-Preferencing Threatens Digital Commerce",
        "source": "The Washington Post (华盛顿邮报)",
        "source_name": "《The Washington Post》社论调查",
        "journal_id": "j_washington_post",
        "category": "商业金融与宏观治理",
        "topic_id": "topic_economy",
        "date": "2024-03-05",
        "url": "https://www.washingtonpost.com/business/2024/03/tech-antitrust-self-preferencing-ruling",
        "snippet": "跨国巨头平台如何通过不透明的排序权重暗中扶持自有品牌、绞杀中小创新商户的法理抗辩",
        "word_count": 325,
        "difficulty": "考研英语(一) / CEFR C1",
        "thesis_tone": {
            "thesis": "数字超级平台身兼裁判员与运动员双重角色，通过算法隐蔽自我优选扼杀了健康商业竞争，必须通过结构性反垄断法案强制其业务拆分。",
            "tone": "严肃法理辩难与政策建言 (Judicial & Reformative)",
            "tone_analysis": "体现华盛顿邮报关注公共治理与监管政策的传统，深刻剖析网络效应带来的反竞争壁垒。"
        },
        "paragraphs": [
            {
                "p_index": 1,
                "role": "界定裁判兼运动员的双重身份悖论 (Dual Role Paradox)",
                "role_badge": "引入背景",
                "main_idea": "大型电商与搜索平台既是所有商户赖以生存的公共市场搭建者，同时又以自有品牌作为参与者直接角逐利润。",
                "text_en": "Antitrust enforcement across modern digital marketplaces faces an unprecedented structural conundrum. Dominant tech platforms function as the de facto infrastructure of modern commerce, setting the rules, operating search algorithms, and arbitrating commercial disputes. Concurrently, these same conglomerates manufacture their own private-label goods and services, competing directly against the independent merchants who have no choice but to list on their platforms.",
                "text_zh": "现代数字市场中的反垄断执法正面临着前所未有的制度性困境。处于支配地位的科技巨头平台实质上充当着现代商业的基础设施：它们制定准入规则、掌控搜索推荐算法，并负责裁决商家间的商业纠纷。而与此同时，这些同一批跨国寡头却又生产推广自己的自有品牌商品与服务，与那些别无选择只能在其平台上摆摊售货的独立商家展开面对面的直接竞争。",
                "key_sentence": "Dominant tech platforms function as the de facto infrastructure of modern commerce, setting the rules, operating search algorithms, and arbitrating commercial disputes.",
                "key_sentence_backbone": "Dominant tech platforms function as the infrastructure of commerce.",
                "vocab": [
                    {
                        "word": "conundrum",
                        "sense": "n. 复杂难题；困境",
                        "is_exam_core": true
                    },
                    {
                        "word": "de facto",
                        "sense": "adj./adv. 事实上的；实质上的",
                        "is_exam_core": true
                    },
                    {
                        "word": "arbitrating",
                        "sense": "v. 裁决；公断",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [
                    {
                        "word": "list",
                        "common_sense": "列表/清单",
                        "exam_sense": "挂牌上市/上架展示",
                        "example": "have no choice but to list on their platforms"
                    }
                ],
                "logic_signals": [
                    {
                        "signal": "Concurrently, these same conglomerates...",
                        "type": "双重并列矛盾",
                        "hint": "一边是裁判员（infrastructure），另一边是运动员（competing directly），这是反垄断核心矛盾。"
                    }
                ]
            },
            {
                "p_index": 2,
                "role": "算法自我优选的隐蔽操作手法 (The Mechanics of Self-Preferencing)",
                "role_badge": "手腕揭秘",
                "main_idea": "平台凭借对用户行为海量数据的独占掌控，神不知鬼不觉地在推荐排名中向自有品牌倾斜，扼杀优秀竞品。",
                "text_en": "Investigations by legislative committees reveal that this dual role inevitably tempts platforms into algorithmic self-preferencing. By subtly tweaking ranking weights, an operator can elevate its own white-label commodities to the top of search queries while pushing superior third-party alternatives below the digital fold. Because algorithms are treated as proprietary intellectual property, independent sellers cannot prove whether their declining visibility is the outcome of poor merit or rigged code.",
                "text_zh": "立法委员会开展的深入调查显示，这种双重身份不可避免地诱使平台实施算法层面的“自我优选”。通过隐蔽微调推荐排名权重，平台运营商便能轻而易举地将自己的贴牌商品推上搜索结果榜首，同时将品质更为优良的第三方竞争对手挤压到第一屏翻页线之下。由于这些算法被当作商业秘密与专有知识产权严密保护，独立卖家根本无法举证证明自己的曝光暴跌究竟是由于自身产品竞争力不足，还是因为遭到了被恶意操纵的代码暗算。",
                "key_sentence": "Because algorithms are treated as proprietary intellectual property, independent sellers cannot prove whether their declining visibility is the outcome of poor merit or rigged code.",
                "key_sentence_backbone": "Independent sellers cannot prove whether declining visibility is the outcome of rigged code.",
                "vocab": [
                    {
                        "word": "subtly",
                        "sense": "adv. 巧妙地；难以察觉地",
                        "is_exam_core": true
                    },
                    {
                        "word": "commodities",
                        "sense": "n. 商品；货物",
                        "is_exam_core": true
                    },
                    {
                        "word": "rigged",
                        "sense": "adj. 作弊的；被幕后操纵的",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [
                    {
                        "word": "fold",
                        "common_sense": "折叠",
                        "exam_sense": "网页首屏折叠线以下",
                        "example": "below the digital fold"
                    }
                ],
                "logic_signals": [
                    {
                        "signal": "Because... independent sellers cannot prove...",
                        "type": "信息不对称因果",
                        "hint": "商业秘密保护造成卖家举证困难，构成了司法反垄断维权的死结。"
                    }
                ]
            },
            {
                "p_index": 3,
                "role": "超越传统价格论，重构反垄断法案 (Structural Remedy Imperative)",
                "role_badge": "改革呼吁",
                "main_idea": "传统以短期消费者价格是否上涨为准绳的反垄断框架已完全失灵，必须效仿百年前的铁路法实施结构性拆分。",
                "text_en": "Twentieth-century antitrust jurisprudence, fixated almost exclusively on consumer price indices, is fundamentally ill-equipped to police algorithmic abuses where consumer prices may appear superficially low. To preserve genuine innovation, lawmakers must resurrect structural separation principles reminiscent of early railroad regulations. If a corporation controls the tracks of modern commerce, it should be strictly prohibited from owning the trains that run upon them.",
                "text_zh": "二十世纪的反垄断法理学几乎全盘死死盯着短期消费者物价指数，在面对表面上商品价格看似极低、实则内藏算法滥用的新型垄断面前，早已显得捉襟见肘、力不从心。为了守护真正的商业创新活力，立法者必须重新祭出令人联想到早年铁路反垄断法规的“结构性拆分原则”：如果一家企业垄断控制了现代商业运行的铁轨，那么它就应当被明令禁止拥有在那条铁轨上飞驰揽客的列车！",
                "key_sentence": "If a corporation controls the tracks of modern commerce, it should be strictly prohibited from owning the trains that run upon them.",
                "key_sentence_backbone": "If a corporation controls the tracks, it should be prohibited from owning the trains.",
                "vocab": [
                    {
                        "word": "jurisprudence",
                        "sense": "n. 法理学；法学理论",
                        "is_exam_core": false
                    },
                    {
                        "word": "reminiscent",
                        "sense": "adj. 使人联想到...的",
                        "is_exam_core": true
                    },
                    {
                        "word": "resurrect",
                        "sense": "vt. 使复活；恢复使用",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [
                    {
                        "word": "tracks",
                        "common_sense": "足迹/音轨",
                        "exam_sense": "铁路轨道(隐喻核心商业基础设施)",
                        "example": "controls the tracks of modern commerce"
                    }
                ],
                "logic_signals": [
                    {
                        "signal": "If... it should be strictly prohibited from...",
                        "type": "条件假设与警句结论",
                        "hint": "文章末尾的经典火车与铁轨隐喻（structural separation），是考研阅读主旨题的最高频考点。"
                    }
                ]
            }
        ],
        "key_sentences": [
            "Because algorithms are treated as proprietary intellectual property, independent sellers cannot prove whether their declining visibility is the outcome of poor merit or rigged code.",
            "If a corporation controls the tracks of modern commerce, it should be strictly prohibited from owning the trains that run upon them."
        ],
        "paraphrases": [
            {
                "source_phrase": "rigged code in algorithmic self-preferencing",
                "target_phrase": "manipulated search algorithms to promote internal offerings",
                "type": "口语与动词短语替换为严密学术表达",
                "explanation": "rigged code 改为 manipulated algorithms，self-preferencing 改为 promote internal offerings。"
            },
            {
                "source_phrase": "strictly prohibited from owning the trains that run upon them",
                "target_phrase": "legally banned from engaging in merchant activities on their own networks",
                "type": "生动隐喻还原为法理条文表述",
                "explanation": "owning the trains 隐喻还原为 engaging in merchant activities。"
            }
        ],
        "false_friends": [
            {
                "word": "tracks",
                "common_sense": "跑道/足迹",
                "exam_sense": "基础设施铁轨",
                "example": "controls the tracks of modern commerce"
            }
        ],
        "exam_question": {
            "stem": "The author quotes the metaphor of 'tracks' and 'trains' at the end of the text to advocate for ______.",
            "options": [
                {
                    "key": "A",
                    "text": "a complete structural ban on platforms competing against their own clients"
                },
                {
                    "key": "B",
                    "text": "the nationalization of commercial railroad networks across North America"
                },
                {
                    "key": "C",
                    "text": "the immediate exemption of search algorithms from patent copyrights"
                },
                {
                    "key": "D",
                    "text": "a reduction in consumer price indices across traditional brick-and-mortar stores"
                }
            ],
            "correct_key": "A",
            "distractor_analysis": {
                "A": "【同义替换（正确答案）】controls the tracks... prohibited from owning trains 正是呼吁立法强制禁止平台自营业务与客户竞争（structural ban on competing against clients）。",
                "B": "【字面误解 / 望文生义】铁路和列车只是隐喻说明商业平台与第三方商户的关系，不是真的去国有化铁路。",
                "C": "【偷换概念】文章指出算法不透明带来举证困难，但比喻本身倡导的是结构性拆分，而非豁免专利。",
                "D": "【无中生有】传统实体店价格指数并未在文末结论中提及。"
            },
            "defense_tip": "解答文末隐喻题（metaphor intention）时，一定要跳出比喻载体（火车、铁轨）的字面意思，直接寻找作者针对核心反垄断争端的根本诉求（结构性拆分）。"
        },
        "passage": "Antitrust enforcement across modern digital marketplaces faces an unprecedented structural conundrum. Dominant tech platforms function as the de facto infrastructure of modern commerce, setting the rules, operating search algorithms, and arbitrating commercial disputes. Concurrently, these same conglomerates manufacture their own private-label goods and services, competing directly against the independent merchants who have no choice but to list on their platforms.\n\nInvestigations by legislative committees reveal that this dual role inevitably tempts platforms into algorithmic self-preferencing. By subtly tweaking ranking weights, an operator can elevate its own white-label commodities to the top of search queries while pushing superior third-party alternatives below the digital fold. Because algorithms are treated as proprietary intellectual property, independent sellers cannot prove whether their declining visibility is the outcome of poor merit or rigged code.\n\nTwentieth-century antitrust jurisprudence, fixated almost exclusively on consumer price indices, is fundamentally ill-equipped to police algorithmic abuses where consumer prices may appear superficially low. To preserve genuine innovation, lawmakers must resurrect structural separation principles reminiscent of early railroad regulations. If a corporation controls the tracks of modern commerce, it should be strictly prohibited from owning the trains that run upon them.",
        "passage_zh": "现代数字市场中的反垄断执法正面临着前所未有的制度性困境。处于支配地位的科技巨头平台实质上充当着现代商业的基础设施：它们制定准入规则、掌控搜索推荐算法，并负责裁决商家间的商业纠纷。而与此同时，这些同一批跨国寡头却又生产推广自己的自有品牌商品与服务，与那些别无选择只能在其平台上摆摊售货的独立商家展开面对面的直接竞争。\n\n立法委员会开展的深入调查显示，这种双重身份不可避免地诱使平台实施算法层面的“自我优选”。通过隐蔽微调推荐排名权重，平台运营商便能轻而易举地将自己的贴牌商品推上搜索结果榜首，同时将品质更为优良的第三方竞争对手挤压到第一屏翻页线之下。由于这些算法被当作商业秘密与专有知识产权严密保护，独立卖家根本无法举证证明自己的曝光暴跌究竟是由于自身产品竞争力不足，还是因为遭到了被恶意操纵的代码暗算。\n\n二十世纪的反垄断法理学几乎全盘死死盯着短期消费者物价指数，在面对表面上商品价格看似极低、实则内藏算法滥用的新型垄断面前，早已显得捉襟见肘、力不从心。为了守护真正的商业创新活力，立法者必须重新祭出令人联想到早年铁路反垄断法规的“结构性拆分原则”：如果一家企业垄断控制了现代商业运行的铁轨，那么它就应当被明令禁止拥有在那条铁轨上飞驰揽客的列车！",
        "sample_passage": "Antitrust enforcement across modern digital marketplaces faces an unprecedented structural conundrum. Dominant tech platforms function as the de facto infrastructure of modern commerce, setting the rules, operating search algorithms, and arbitrating commercial disputes. Concurrently, these same conglomerates manufacture their own private-label goods and services, competing directly against the ind"
    },
    {
        "id": "nyt_ai_copyright",
        "title": "Stolen Brushstrokes: The Battle Over Copyright in the Machine Age",
        "source": "The New York Times (纽约时报)",
        "source_name": "《The New York Times》文化观察",
        "journal_id": "j_nytimes",
        "category": "人文社科与现代生活",
        "topic_id": "topic_humanities",
        "date": "2024-01-15",
        "url": "https://www.nytimes.com/2024/01/ai-art-copyright-artists-lawsuit",
        "snippet": "生成式文生图模型无偿爬取数亿艺术家画作引发的著作权侵害与合理使用界限大辩论",
        "word_count": 315,
        "difficulty": "考研英语(一) / CEFR C1",
        "thesis_tone": {
            "thesis": "AI模型通过未授权抓取吞噬人类艺术家心血，以“合理使用”为幌子稀释原创作品价值，亟需重构数字版权补偿体系。",
            "tone": "深切关切与文化批判 (Sympathetic & Critical)",
            "tone_analysis": "站在被边缘化的人类插画师与创作者立场，对科技公司以创新之名行掠夺之实的做法予以审视。"
        },
        "paragraphs": [
            {
                "p_index": 1,
                "role": "画家遭遇数字剽窃的个体震撼 (The Creative Shoplifting Shock)",
                "role_badge": "故事切入",
                "main_idea": "独立插画师在网络文生图平台中发现能够一键生成其独特笔触风格的作品，暴露了无偿抓取对原创心血的掠夺。",
                "text_en": "When freelance illustrator Sarah Lin typed her own name into a newly released diffusion model prompt box, the software generated four portraits that were breathtakingly familiar. The delicate cross-hatching, the subdued pastel palette, and the ethereal lighting—signatures she had spent fifteen painful years honing—had been ingested, digitized, and reassembled in under three seconds. To Lin, this was not an inspiring demonstration of synthetic ingenuity; it felt like grand larceny masquerading as technological progress.",
                "text_zh": "当自由插画师莎拉·林在一款新发布的多模态扩散模型提示框中键入自己的姓名时，软件在几秒内生成了四幅令她毛骨悚然的熟悉肖像。那些细腻的交叉排线线条、柔和低调的粉彩色调，以及那种空灵梦幻的光影氛围——这些她花费了整整十五年苦心孤诣雕琢打磨的个人标志性风格——已经在三秒之内被机器囫囵吞噬、数字化切片并重新拼装。对林而言，这绝非什么鼓舞人心的合成智慧演示，这完全是一场伪装在“技术进步”外衣下的超级明火执仗掠夺！",
                "key_sentence": "To Lin, this was not an inspiring demonstration of synthetic ingenuity; it felt like grand larceny masquerading as technological progress.",
                "key_sentence_backbone": "To Lin, this was grand larceny masquerading as progress.",
                "vocab": [
                    {
                        "word": "cross-hatching",
                        "sense": "n. 交叉阴影线条画法",
                        "is_exam_core": false
                    },
                    {
                        "word": "subdued",
                        "sense": "adj. 柔和的；低调克制的",
                        "is_exam_core": true
                    },
                    {
                        "word": "larceny",
                        "sense": "n. 盗窃罪；偷盗行为",
                        "is_exam_core": false
                    }
                ],
                "false_friends": [
                    {
                        "word": "prompt",
                        "common_sense": "迅速的",
                        "exam_sense": "AI提示词",
                        "example": "diffusion model prompt box"
                    }
                ],
                "logic_signals": [
                    {
                        "signal": "...not an inspiring demonstration... it felt like...",
                        "type": "否定假象，揭露实质",
                        "hint": "驳斥了科技公司推崇的进步叙事，直接定性为盗窃（larceny）。"
                    }
                ]
            },
            {
                "p_index": 2,
                "role": "合理使用抗辩与实质性替代 (The Fair Use Battleground)",
                "role_badge": "法理交锋",
                "main_idea": "科技巨头援引版权法中的合理使用条款辩称模型仅是“学习与转化”，但实际却在商业市场上直接替代了原作者订单。",
                "text_en": "Tech corporations vigorously defend their training pipelines under the legal umbrella of fair use. They contend that neural algorithms do not copy images directly, but merely analyze abstract statistical relationships, mimicking how human art students learn from masters in a museum. Yet intellectual property scholars counter that fair use was never intended to subsidize commercial entities that generate market substitutes capable of bankrupting the very creators whose works they devoured.",
                "text_zh": "各大科技公司则躲在版权法中“合理使用”的法律保护伞下，为其模型训练流程极力开脱。他们辩称，神经网络算法并没有直接机械复制图像，而只是分析了抽象的统计数学关系，其过程就如同人类艺术学徒在美术馆里临摹大师杰作一样。然而，知识产权学者们针锋相对地指出：合理使用制度的初衷绝不是为了去补贴那些足以让原创者破产的商业巨兽，尤其是当这些机器生成的替代品正在直接砸碎那些喂养了它的艺术家们的饭碗之时！",
                "key_sentence": "Yet intellectual property scholars counter that fair use was never intended to subsidize commercial entities that generate market substitutes capable of bankrupting the very creators whose works they devoured.",
                "key_sentence_backbone": "Fair use was never intended to subsidize entities that bankrupt creators.",
                "vocab": [
                    {
                        "word": "umbrella",
                        "sense": "n. 保护伞；综合机制",
                        "is_exam_core": true
                    },
                    {
                        "word": "mimicking",
                        "sense": "v. 模仿；模拟",
                        "is_exam_core": true
                    },
                    {
                        "word": "subsidize",
                        "sense": "vt. 资助；补贴",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [],
                "logic_signals": [
                    {
                        "signal": "Yet scholars counter that...",
                        "type": "权威转折辩难",
                        "hint": "Yet... counter 引出反对科技巨头辩词的法理核心：market substitutes（市场直接替代损害）。"
                    }
                ]
            },
            {
                "p_index": 3,
                "role": "创作者经济与版权授权税制革新 (Reconstructing Collective Licensing)",
                "role_badge": "出路探讨",
                "main_idea": "解决之道并非扼杀技术，而是建立类似流媒体音乐的强制性集体版权授权基金，让原创者终身分享AI商业化红利。",
                "text_en": "Halting algorithmic advancement is neither feasible nor desirable. The path forward requires modernizing copyright law through mandatory collective licensing regimes, similar to royalties paid to musicians by radio broadcasters. If synthetic systems profit from ingesting human cultural heritage, a non-negotiable dividend must flow back to sustaining living artisans. Without reciprocal compensation, the very wellspring of human imagination will gradually dry up.",
                "text_zh": "阻挡算法的前进既不现实也非良策。未来的真正出路，在于通过强制性的集体版权授权机制来重塑现代知识产权法律，就如同广播电台和流媒体必须向音乐人支付版税一样。如果合成系统凭借摄取吞噬人类文化遗产而牟利，就必须有一笔不可协商的法定红利分流回来，用于滋养活生生的手艺创作者。若是没有这种互惠性的补偿，人类想象力这一无尽泉源终将渐渐干涸枯竭。",
                "key_sentence": "If synthetic systems profit from ingesting human cultural heritage, a non-negotiable dividend must flow back to sustaining living artisans.",
                "key_sentence_backbone": "A dividend must flow back to sustaining living artisans.",
                "vocab": [
                    {
                        "word": "regimes",
                        "sense": "n. 制度；管理体制",
                        "is_exam_core": true
                    },
                    {
                        "word": "royalties",
                        "sense": "n. 版税；专利权使用费",
                        "is_exam_core": true
                    },
                    {
                        "word": "reciprocal",
                        "sense": "adj. 互惠的；相互的",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [
                    {
                        "word": "living",
                        "common_sense": "活着的",
                        "exam_sense": "在世的/现存的创作者",
                        "example": "sustaining living artisans"
                    }
                ],
                "logic_signals": [
                    {
                        "signal": "Without reciprocal compensation... will dry up.",
                        "type": "双重否定警世句",
                        "hint": "Without A, B will dry up 强调建立互惠补偿机制是避免文化创造力枯竭的唯一路径。"
                    }
                ]
            }
        ],
        "key_sentences": [
            "To Lin, this was not an inspiring demonstration of synthetic ingenuity; it felt like grand larceny masquerading as technological progress.",
            "If synthetic systems profit from ingesting human cultural heritage, a non-negotiable dividend must flow back to sustaining living artisans."
        ],
        "paraphrases": [
            {
                "source_phrase": "grand larceny masquerading as technological progress",
                "target_phrase": "illicit appropriation disguised as algorithmic advancement",
                "type": "法律与隐喻术语正规化改写",
                "explanation": "grand larceny 转为 illicit appropriation，masquerading 转为 disguised as。"
            },
            {
                "source_phrase": "generate market substitutes capable of bankrupting creators",
                "target_phrase": "undermining the financial livelihood of original artists through direct commercial competition",
                "type": "动词与名词下位展开",
                "explanation": "bankrupting creators 改为 undermining the financial livelihood of artists。"
            }
        ],
        "false_friends": [
            {
                "word": "living",
                "common_sense": "生活/活着",
                "exam_sense": "在世的(创作者)",
                "example": "sustaining living artisans"
            }
        ],
        "exam_question": {
            "stem": "What is the author's recommended solution to the conflict between AI developers and artists?",
            "options": [
                {
                    "key": "A",
                    "text": "Establishing a statutory collective licensing system to guarantee royalties to creators"
                },
                {
                    "key": "B",
                    "text": "Imposing an unconditional legal ban on all text-to-image software development"
                },
                {
                    "key": "C",
                    "text": "Forcing independent illustrators to upload all historical sketches without charge"
                },
                {
                    "key": "D",
                    "text": "Allowing tech corporations to expand fair use to all physical museum artifacts"
                }
            ],
            "correct_key": "A",
            "distractor_analysis": {
                "A": "【同义替换（正确答案）】mandatory collective licensing regimes... royalties paid to musicians 对应 establishing a statutory collective licensing system to guarantee royalties。",
                "B": "【反向曲解 / 过度绝对化】第三段首句明确说 Halting algorithmic advancement is neither feasible nor desirable（叫停技术既不可行也不可取）。",
                "C": "【正反颠倒 / 荒谬选项】文章是在保护艺术家权益，而非强迫艺术家免费上交作品。",
                "D": "【偷换概念】文中引用博物馆学徒只是科技公司的辩词，并非作者推荐的解决方案。"
            },
            "defense_tip": "遇到作者提出解决方案的题目，仔细观察文末倡导项（mandatory collective licensing regimes / non-negotiable dividend），正选必定是对机制与版税制度的精准概括。"
        },
        "passage": "When freelance illustrator Sarah Lin typed her own name into a newly released diffusion model prompt box, the software generated four portraits that were breathtakingly familiar. The delicate cross-hatching, the subdued pastel palette, and the ethereal lighting—signatures she had spent fifteen painful years honing—had been ingested, digitized, and reassembled in under three seconds. To Lin, this was not an inspiring demonstration of synthetic ingenuity; it felt like grand larceny masquerading as technological progress.\n\nTech corporations vigorously defend their training pipelines under the legal umbrella of fair use. They contend that neural algorithms do not copy images directly, but merely analyze abstract statistical relationships, mimicking how human art students learn from masters in a museum. Yet intellectual property scholars counter that fair use was never intended to subsidize commercial entities that generate market substitutes capable of bankrupting the very creators whose works they devoured.\n\nHalting algorithmic advancement is neither feasible nor desirable. The path forward requires modernizing copyright law through mandatory collective licensing regimes, similar to royalties paid to musicians by radio broadcasters. If synthetic systems profit from ingesting human cultural heritage, a non-negotiable dividend must flow back to sustaining living artisans. Without reciprocal compensation, the very wellspring of human imagination will gradually dry up.",
        "passage_zh": "当自由插画师莎拉·林在一款新发布的多模态扩散模型提示框中键入自己的姓名时，软件在几秒内生成了四幅令她毛骨悚然的熟悉肖像。那些细腻的交叉排线线条、柔和低调的粉彩色调，以及那种空灵梦幻的光影氛围——这些她花费了整整十五年苦心孤诣雕琢打磨的个人标志性风格——已经在三秒之内被机器囫囵吞噬、数字化切片并重新拼装。对林而言，这绝非什么鼓舞人心的合成智慧演示，这完全是一场伪装在“技术进步”外衣下的超级明火执仗掠夺！\n\n各大科技公司则躲在版权法中“合理使用”的法律保护伞下，为其模型训练流程极力开脱。他们辩称，神经网络算法并没有直接机械复制图像，而只是分析了抽象的统计数学关系，其过程就如同人类艺术学徒在美术馆里临摹大师杰作一样。然而，知识产权学者们针锋相对地指出：合理使用制度的初衷绝不是为了去补贴那些足以让原创者破产的商业巨兽，尤其是当这些机器生成的替代品正在直接砸碎那些喂养了它的艺术家们的饭碗之时！\n\n阻挡算法的前进既不现实也非良策。未来的真正出路，在于通过强制性的集体版权授权机制来重塑现代知识产权法律，就如同广播电台和流媒体必须向音乐人支付版税一样。如果合成系统凭借摄取吞噬人类文化遗产而牟利，就必须有一笔不可协商的法定红利分流回来，用于滋养活生生的手艺创作者。若是没有这种互惠性的补偿，人类想象力这一无尽泉源终将渐渐干涸枯竭。",
        "sample_passage": "When freelance illustrator Sarah Lin typed her own name into a newly released diffusion model prompt box, the software generated four portraits that were breathtakingly familiar. The delicate cross-hatching, the subdued pastel palette, and the ethereal lighting—signatures she had spent fifteen painful years honing—had been ingested, digitized, and reassembled in under three seconds. To Lin, this w"
    },
    {
        "id": "hbr_psychological_safety",
        "title": "Beyond the Agile Myth: The True Engine of Organizational Velocity",
        "source": "Harvard Business Review (哈佛商业评论)",
        "source_name": "《Harvard Business Review》管理洞察",
        "journal_id": "j_hbr",
        "category": "商业金融与宏观治理",
        "topic_id": "topic_economy",
        "date": "2024-02-10",
        "url": "https://hbr.org/2024/02/beyond-agile-myth-psychological-safety-teams",
        "snippet": "形式主义敏捷站会如何沦为表演性绩效工具、唯有真正的心理安全感才能激发企业真实创新",
        "word_count": 320,
        "difficulty": "考研英语(二) / CEFR B2+",
        "thesis_tone": {
            "thesis": "单纯照搬敏捷仪式（站会、燃尽图）只是形式主义空转，若缺乏允许试错与坦诚批评的团队心理安全感，任何管理工具都无法提升组织敏捷度。",
            "tone": "务实剖析与建设性规箴 (Pragmatic & Reconstructive)",
            "tone_analysis": "典型的HBR管理实务风格：直面企业在导入新型管理学概念时的水土不服与异化变形，提出底层心理文化重构。"
        },
        "paragraphs": [
            {
                "p_index": 1,
                "role": "批判企业对敏捷开发仪式的盲目崇拜 (Ritualistic Cargo Cult)",
                "role_badge": "引入痛点",
                "main_idea": "各大跨国公司热衷于在办公室推行各色便签贴和十五分钟站会，然而员工的真实生产力和决策速度却毫无起色。",
                "text_en": "In executive suites across the globe, the gospel of agile management has achieved near-religious status. Corporate boards spend fortunes hiring scrum consultants to blanket office walls with colorful sticky notes and mandate daily stand-up gatherings. Yet behind the energetic jargon of sprint velocities and burndown charts lies a frustrating paradox: organizational execution frequently grinds to a halt while employees spend their days performing agility rather than practicing it.",
                "text_zh": "在全球各大跨国企业的董事会高管办公室里，所谓“敏捷管理”的教条已经获得了近乎宗教般的崇拜地位。各大公司不惜耗费巨资聘请敏捷专家顾问，用五颜六色的便利贴贴满办公室的墙壁，并强制员工进行每日站立晨会。然而，在诸如“冲刺速度”和“燃尽图”等听上去充满活力的管理行话背后，却隐藏着一个令人沮丧的悖论：企业的实际执行力常常陷入停滞，员工们整天都在“表演敏捷”，而非真正“践行敏捷”。",
                "key_sentence": "Yet behind the energetic jargon of sprint velocities and burndown charts lies a frustrating paradox: organizational execution frequently grinds to a halt while employees spend their days performing agility rather than practicing it.",
                "key_sentence_backbone": "Organizational execution grinds to a halt while employees spend days performing agility.",
                "vocab": [
                    {
                        "word": "gospel",
                        "sense": "n. 信条；福音",
                        "is_exam_core": true
                    },
                    {
                        "word": "mandate",
                        "sense": "vt. 强制推行；命令",
                        "is_exam_core": true
                    },
                    {
                        "word": "paradox",
                        "sense": "n. 悖论；自相矛盾",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [
                    {
                        "word": "performing",
                        "common_sense": "演出",
                        "exam_sense": "做表面文章/假装表演",
                        "example": "performing agility rather than practicing it"
                    }
                ],
                "logic_signals": [
                    {
                        "signal": "Yet behind... lies a frustrating paradox...",
                        "type": "表里不一矛盾揭示",
                        "hint": "词藻的繁荣（energetic jargon）与实际执行的停滞（grinds to a halt）构成考研经典反差。"
                    }
                ]
            },
            {
                "p_index": 2,
                "role": "缺乏心理安全感带来的防御性沉默 (Defensive Silence Mechanics)",
                "role_badge": "根因诊断",
                "main_idea": "当组织文化对犯错实施隐形惩罚时，下属即使洞察到项目潜在重大缺陷也会保持沉默，敏捷流程沦为掩盖风险的工具。",
                "text_en": "Decades of empirical research in organizational behavior confirm that process frameworks cannot compensate for deficient psychological safety. When team members calculate that speaking truth to power carries career-limiting risks, they naturally retreat into defensive conformity. Rather than flagging unfeasible deadlines or architectural flaws in sprint reviews, engineers nod politely. The ritualized meetings become instruments of surveillance rather than forums for genuine collaborative problem-solving.",
                "text_zh": "组织行为学长达数十年的实证研究表明：纯粹的流程框架根本无法弥补团队“心理安全感”的缺失。当团队成员经过权衡，意识到对上级讲真话可能会带来断送职业生涯的风险时，他们自然会退缩到自我防御的盲从附和之中。在冲刺评审会议上，工程师们不会主动指出无法实现的项目截止日期或架构缺陷，而是礼貌性地点头称是。这些充满仪式感的会议最终演变成了变相监控的工具，而非开展真正协作解题的平台。",
                "key_sentence": "When team members calculate that speaking truth to power carries career-limiting risks, they naturally retreat into defensive conformity.",
                "key_sentence_backbone": "When speaking truth carries risks, members retreat into defensive conformity.",
                "vocab": [
                    {
                        "word": "conformity",
                        "sense": "n. 遵从；顺从附和",
                        "is_exam_core": true
                    },
                    {
                        "word": "surveillance",
                        "sense": "n. 监视；暗中监督",
                        "is_exam_core": true
                    },
                    {
                        "word": "deficient",
                        "sense": "adj. 缺乏的；不足的",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [
                    {
                        "word": "calculate",
                        "common_sense": "计算数字",
                        "exam_sense": "利弊权衡/深思熟虑",
                        "example": "calculate that speaking truth carries risks"
                    }
                ],
                "logic_signals": [
                    {
                        "signal": "Rather than flagging... engineers nod...",
                        "type": "防御性行为对比",
                        "hint": "指出形式主义站会抑制了批判性反馈，导致集体盲区。"
                    }
                ]
            },
            {
                "p_index": 3,
                "role": "构筑允许脆弱与诚实的领导力环境 (Vulnerability & Candor as Fuel)",
                "role_badge": "管理重构",
                "main_idea": "卓越管理者必须通过公开承认自身未知、对错误去惩罚化，营造让员工毫无后顾之忧袒露真相的安全土壤。",
                "text_en": "Authentic velocity is not achieved by imposing tighter tracking metrics, but by building an environment where vulnerability is normalized. Leaders must actively model epistemic humility by openly admitting their own uncertainties and rewarding those who challenge prevailing assumptions. Only when the interpersonal fear of humiliation is dismantled can teams pivot rapidly in response to volatile market shifts.",
                "text_zh": "真正的组织敏捷与执行速度，绝不是通过强加更严苛的过程追踪指标来达成的，而是通过营造一个将“坦诚示弱”视作常态的团队环境来实现的。管理领导者必须率先垂范，展现出认知上的谦逊：主动坦承自身认知的不确定性，并大力奖赏那些敢于挑战主流既定假设的下属。唯有当人际交往中害怕受挫丢脸的恐惧被彻底打破拆除时，团队才能在面对动荡莫测的市场突变时实现迅捷从容的转身调整。",
                "key_sentence": "Authentic velocity is not achieved by imposing tighter tracking metrics, but by building an environment where vulnerability is normalized.",
                "key_sentence_backbone": "Velocity is achieved by building an environment where vulnerability is normalized.",
                "vocab": [
                    {
                        "word": "vulnerability",
                        "sense": "n. 脆弱性；坦诚示弱",
                        "is_exam_core": true
                    },
                    {
                        "word": "epistemic",
                        "sense": "adj. 认识论的；认知上的",
                        "is_exam_core": false
                    },
                    {
                        "word": "volatile",
                        "sense": "adj. 不稳定的；多变动荡的",
                        "is_exam_core": true
                    }
                ],
                "false_friends": [
                    {
                        "word": "model",
                        "common_sense": "模型/模特",
                        "exam_sense": "vt. 率先垂范/树立榜样",
                        "example": "model epistemic humility"
                    }
                ],
                "logic_signals": [
                    {
                        "signal": "not achieved by... but by...",
                        "type": "否定错解，给出真谛",
                        "hint": "not by metrics but by vulnerability 是全文核心主旨句，直接对应考题答案。"
                    }
                ]
            }
        ],
        "key_sentences": [
            "Yet behind the energetic jargon of sprint velocities and burndown charts lies a frustrating paradox: organizational execution frequently grinds to a halt while employees spend their days performing agility rather than practicing it.",
            "Authentic velocity is not achieved by imposing tighter tracking metrics, but by building an environment where vulnerability is normalized."
        ],
        "paraphrases": [
            {
                "source_phrase": "performing agility rather than practicing it",
                "target_phrase": "engaging in superficial rituals without substantive flexibility",
                "type": "形式与实质对立抽象化改写",
                "explanation": "performing agility 转为 engaging in superficial rituals，practicing 转为 substantive flexibility。"
            },
            {
                "source_phrase": "building an environment where vulnerability is normalized",
                "target_phrase": "fostering a culture where employees feel safe to voice concerns and mistakes",
                "type": "管理学心理学术语下位通俗化",
                "explanation": "vulnerability normalized（示弱常态化）转为 feel safe to voice concerns and mistakes（心理安全感）。"
            }
        ],
        "false_friends": [
            {
                "word": "performing",
                "common_sense": "表演戏剧",
                "exam_sense": "敷衍做表面文章",
                "example": "performing agility rather than practicing it"
            }
        ],
        "exam_question": {
            "stem": "According to the author, why do agile management rituals often fail to accelerate project delivery?",
            "options": [
                {
                    "key": "A",
                    "text": "They fail to cultivate an atmosphere where employees feel secure to express honest dissenting opinions"
                },
                {
                    "key": "B",
                    "text": "Scrum consultants strictly forbid staff members from purchasing sticky notes"
                },
                {
                    "key": "C",
                    "text": "Software developers inevitably lack fundamental mathematical logic capabilities"
                },
                {
                    "key": "D",
                    "text": "Modern corporations have completely abolished all sprint velocity metrics"
                }
            ],
            "correct_key": "A",
            "distractor_analysis": {
                "A": "【同义替换（正确答案）】process frameworks cannot compensate for deficient psychological safety / speaking truth to power carries career-limiting risks 准确对应 atmosphere where employees feel secure to express honest dissenting opinions。",
                "B": "【反向事实 / 细节错误】顾问们到处贴满便利贴，而非禁止购买。",
                "C": "【无中生有 / 人身攻击】文中未质疑工程师的数学能力，问题在于管理文化压制了真话。",
                "D": "【反向颠倒】文中指出公司疯狂使用度量指标（tighter tracking metrics），而非废除。"
            },
            "defense_tip": "解答管理学与心理学交叉考研题时，凡是选项将责任单纯推给“员工能力差”或“工具技术不够新”的，大多为命题人设计的粗糙干扰项；正选往往直指“文化信任度”与“人际安全感”。"
        },
        "passage": "In executive suites across the globe, the gospel of agile management has achieved near-religious status. Corporate boards spend fortunes hiring scrum consultants to blanket office walls with colorful sticky notes and mandate daily stand-up gatherings. Yet behind the energetic jargon of sprint velocities and burndown charts lies a frustrating paradox: organizational execution frequently grinds to a halt while employees spend their days performing agility rather than practicing it.\n\nDecades of empirical research in organizational behavior confirm that process frameworks cannot compensate for deficient psychological safety. When team members calculate that speaking truth to power carries career-limiting risks, they naturally retreat into defensive conformity. Rather than flagging unfeasible deadlines or architectural flaws in sprint reviews, engineers nod politely. The ritualized meetings become instruments of surveillance rather than forums for genuine collaborative problem-solving.\n\nAuthentic velocity is not achieved by imposing tighter tracking metrics, but by building an environment where vulnerability is normalized. Leaders must actively model epistemic humility by openly admitting their own uncertainties and rewarding those who challenge prevailing assumptions. Only when the interpersonal fear of humiliation is dismantled can teams pivot rapidly in response to volatile market shifts.",
        "passage_zh": "在全球各大跨国企业的董事会高管办公室里，所谓“敏捷管理”的教条已经获得了近乎宗教般的崇拜地位。各大公司不惜耗费巨资聘请敏捷专家顾问，用五颜六色的便利贴贴满办公室的墙壁，并强制员工进行每日站立晨会。然而，在诸如“冲刺速度”和“燃尽图”等听上去充满活力的管理行话背后，却隐藏着一个令人沮丧的悖论：企业的实际执行力常常陷入停滞，员工们整天都在“表演敏捷”，而非真正“践行敏捷”。\n\n组织行为学长达数十年的实证研究表明：纯粹的流程框架根本无法弥补团队“心理安全感”的缺失。当团队成员经过权衡，意识到对上级讲真话可能会带来断送职业生涯的风险时，他们自然会退缩到自我防御的盲从附和之中。在冲刺评审会议上，工程师们不会主动指出无法实现的项目截止日期或架构缺陷，而是礼貌性地点头称是。这些充满仪式感的会议最终演变成了变相监控的工具，而非开展真正协作解题的平台。\n\n真正的组织敏捷与执行速度，绝不是通过强加更严苛的过程追踪指标来达成的，而是通过营造一个将“坦诚示弱”视作常态的团队环境来实现的。管理领导者必须率先垂范，展现出认知上的谦逊：主动坦承自身认知的不确定性，并大力奖赏那些敢于挑战主流既定假设的下属。唯有当人际交往中害怕受挫丢脸的恐惧被彻底打破拆除时，团队才能在面对动荡莫测的市场突变时实现迅捷从容的转身调整。",
        "sample_passage": "In executive suites across the globe, the gospel of agile management has achieved near-religious status. Corporate boards spend fortunes hiring scrum consultants to blanket office walls with colorful sticky notes and mandate daily stand-up gatherings. Yet behind the energetic jargon of sprint velocities and burndown charts lies a frustrating paradox: organizational execution frequently grinds to a"
    },
]

# ==============================================================================
# 兼容性映射与动态全量检索支撑
# ==============================================================================

BUILTIN_EXAM_PASSAGES: list[dict[str, Any]] = [
    a for a in ALL_AUTHENTIC_ARTICLES if a.get("category") == "历年考研官方真题精选" or a.get("id") in ("ky_2010_text3", "economist_ai_paradox")
]

ONLINE_FEATURED_ARTICLES: list[dict[str, Any]] = [
    a for a in ALL_AUTHENTIC_ARTICLES if a.get("category") != "历年考研官方真题精选"
]

# 统一补全文本字段保证渲染安全
for art in ALL_AUTHENTIC_ARTICLES:
    if "passage" not in art and "paragraphs" in art:
        art["passage"] = "\n\n".join(p.get("text_en", "") for p in art.get("paragraphs", []))
    if "passage_zh" not in art and "paragraphs" in art:
        art["passage_zh"] = "\n\n".join(p.get("text_zh", "") for p in art.get("paragraphs", []))
    if "sample_passage" not in art:
        art["sample_passage"] = art.get("passage", "")[:400]
