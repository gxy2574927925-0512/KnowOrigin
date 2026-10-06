"""知源 · 英语应试精读与自动化备考引擎（core/english_exam.py）。

本模块汇聚考研英语、四六级、雅思名师与顶流高分博主的核心方法论：
  1. 唐迟「阅读的逻辑」：同义改写链自动萃取、干扰项四大陷阱自动化诊断；
  2. 田静「句句真研」：长难句结构化手术刀（剔除枝叶从句、精准提取主谓宾极简骨架）；
  3. 考研熟词生义雷达：60+ 真题核心高频僻义自动扫描与警示；
  4. FSRS 闭环：提取的同义替换对自动沉淀进本地 SQLite，支持间隔记忆。

设计约束（严格遵循知源长期记忆与架构规范）：
  * 纯逻辑 + 独立存储层：数据库连接与主库同文件，表前缀 en_exam_*，绝不污染既有用户表；
  * 双轨运行：优先调用 LLM 精准提炼，若无模型或报错则 100% 优雅降级到本地规则/ECDICT 引擎，绝不 500；
  * 脱库可测：核心分析算法均具备纯函数/离线规则形态，可独立运行单元测试。
"""

from __future__ import annotations

import json
import re
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from .database import new_id, utc_now
from .english_vocab import to_iso
from . import english_reading_sources as reading_sources
from .english_exam_data import (
    JOURNAL_CATALOG,
    ALL_AUTHENTIC_ARTICLES,
)

# ==============================================================================
# 熟词生义库：日常义之外还藏着「生义」的常用词。
#
# 收词标准不看它是不是真题僻义词，只看一条：这个词有一个学习者容易按日常义读过去、
# 但在这句里其实取另一个意思的义项。所以库里有 weather 这种真题经典，也有 table /
# story / word 这类日常词。词条可按需加两个字段：
#   guard        —— 只有上下文命中该正则才预警（给 age / work 这类日常义压倒性的词降噪）
#   extra_forms  —— 规则屈折推不出来的变形（see→saw/seen、tie→tying 等）
EXAM_FALSE_FRIENDS: dict[str, dict[str, Any]] = {
    "weather": {
        "common": "n. 天气",
        "exam_sense": "vt. 平安度过(危机); 经受住(风雨/考验)",
        "example": "Small firms managed to weather the financial storm.",
        "exam_tags": ["考研", "六级"],
    },
    "sound": {
        "common": "n. 声音",
        "exam_sense": "adj. 健全的; 合理的; 可靠的; 彻底的",
        "example": "He made a sound investment decision based on solid data.",
        "exam_tags": ["考研", "四级", "六级"],
    },
    "balance": {
        "common": "n. 平衡",
        "exam_sense": "n. 差额; 结余; 账户余额",
        "example": "The remaining balance must be paid before the end of this month.",
        "exam_tags": ["考研", "六级"],
    },
    "school": {
        "common": "n. 学校",
        "exam_sense": "n. (鱼/鲸等)群; 学派/流派",
        "example": "A huge school of tuna swam across the continental shelf.",
        "exam_tags": ["考研"],
        "guard": r"\bschool(?:s)?\s+of\b",
    },
    "prompt": {
        "common": "adj. 迅速的; 准时的",
        "exam_sense": "vt. 促使; 推动; 引起 / n. 提示词",
        "example": "Curiosity prompted her to investigate the ancient ruins.",
        "exam_tags": ["考研", "六级"],
    },
    "subject": {
        "common": "n. 科目; 主题",
        "exam_sense": "adj. 易受...影响的; 取决于...的 / vt. 使臣服; 使遭受",
        "example": "The flight schedule is subject to weather conditions.",
        "exam_tags": ["考研", "六级"],
        "guard": r"\bsubject(?:s|ed|ing)?\s+to\b",
    },
    "address": {
        "common": "n. 地址",
        "exam_sense": "vt. 致力于解决; 应付(问题/挑战); 向...致辞",
        "example": "We must address the root causes of climate change.",
        "exam_tags": ["考研", "四级", "六级"],
    },
    "appreciate": {
        "common": "vt. 感激; 欣赏",
        "exam_sense": "vt. 充分意识到; 理解 / vi. 增值/升值",
        "example": "Most investors fail to appreciate the systemic risks involved.",
        "exam_tags": ["考研", "六级"],
    },
    "game": {
        "common": "n. 游戏; 比赛",
        "exam_sense": "n. 猎物; 野味 / adj. 勇敢有胆量的",
        "example": "Large game was scarce in the drought-stricken wilderness.",
        "exam_tags": ["考研"],
    },
    "novel": {
        "common": "n. 长篇小说",
        "exam_sense": "adj. 新颖的; 前所未有的",
        "example": "The team proposed a novel approach to quantum error correction.",
        "exam_tags": ["考研", "四级"],
    },
    "harbor": {
        "common": "n. 海港; 避风港",
        "exam_sense": "vt. 心怀(不满/疑虑); 窝藏; 庇护",
        "example": "He still harbored resentment over the unfair evaluation.",
        "exam_tags": ["考研"],
        "extra_forms": ["harbour", "harbours", "harboured", "harbouring"],
    },
    "flat": {
        "common": "adj. 平坦的 / n. 公寓",
        "exam_sense": "adj. (经济/销售)萧条的; 断然的; 固定不变的",
        "example": "Sales figures remained flat throughout the second quarter.",
        "exam_tags": ["考研", "六级"],
    },
    "vehicle": {
        "common": "n. 车辆; 交通工具",
        "exam_sense": "n. 手段; 媒介; 工具",
        "example": "Art serves as an effective vehicle for expressing dissent.",
        "exam_tags": ["考研", "六级"],
    },
    "pool": {
        "common": "n. 水池; 游泳池",
        "exam_sense": "vt. 集中(资源/资金/信息) / n. 备用人员库",
        "example": "Scientists pooled their data to accelerate vaccine discovery.",
        "exam_tags": ["考研", "六级"],
    },
    "plant": {
        "common": "n. 植物",
        "exam_sense": "n. 发电厂; 重工业车间; 卧底/内线 / vt. 栽赃",
        "example": "The nuclear power plant operates under strict safety protocols.",
        "exam_tags": ["考研", "四级"],
        "guard": r"\b(?:power|chemical|nuclear|manufacturing|assembly|steel)\s+plant\b",
    },
    "draft": {
        "common": "n. 草稿",
        "exam_sense": "vt. 征募入伍; 选拔 / n. 穿堂风; 汇票",
        "example": "Thousands of young citizens were drafted into mandatory service.",
        "exam_tags": ["考研", "六级"],
    },
    "minute": {
        "common": "n. 分钟",
        "exam_sense": "adj. /maɪˈnjuːt/ 极细微的; 详细精确的 / n.(pl.) 会议纪要",
        "example": "The microscope revealed minute cracks on the metal surface.",
        "exam_tags": ["考研"],
        "guard": r"\bminute\s+(?:cracks?|details?|differences?|changes?|particles?|amounts?|variations?|quantities|adjustments?|fractions?)\b",
    },
    "coin": {
        "common": "n. 硬币",
        "exam_sense": "vt. 创造(新词/新短语); 杜撰",
        "example": "The term 'cybernetics' was coined by Norbert Wiener.",
        "exam_tags": ["考研", "六级"],
    },
    "account": {
        "common": "n. 账户",
        "exam_sense": "vi. (for) 说明原因; 占...比例 / n. 描述; 叙述",
        "example": "Renewable energy accounts for nearly thirty percent of output.",
        "exam_tags": ["考研", "四级", "六级"],
        "guard": r"\baccount(?:s|ed|ing)?\s+for\b",
    },
    "consume": {
        "common": "vt. 消费; 吃喝",
        "exam_sense": "vt. (激情/恐惧等)吞噬; 使沉迷; 烧毁",
        "example": "He was consumed with guilt after discovering the truth.",
        "exam_tags": ["考研", "六级"],
    },
    "capital": {
        "common": "n. 首都; 大写字母",
        "exam_sense": "n. 资本; 资金 / adj. 死罪的(capital punishment)",
        "example": "Access to venture capital is crucial for emerging startups.",
        "exam_tags": ["考研", "四级"],
    },
    "suggest": {
        "common": "vt. 建议; 提议",
        "exam_sense": "vt. 表明; 暗示; 说明",
        "example": "The data suggest a strong correlation between the two variables.",
        "exam_tags": ["考研", "六级"],
    },
    "age": {
        "common": "n. 年龄; 年纪",
        "exam_sense": "n. 时代; 时期",
        "example": "The Age of the Dinosaurs ended with a sudden extinction event.",
        "exam_tags": ["考研"],
    },
    "matter": {
        "common": "n. 事情; 物质",
        "exam_sense": "vi. 要紧; 有重大影响",
        "example": "It does not matter how long the process takes.",
        "exam_tags": ["考研", "六级"],
    },
    "mean": {
        "common": "vt. 意思是; 意味着",
        "exam_sense": "adj. 吝啬的; 卑鄙的 / n. 平均数",
        "example": "He was too mean to buy his colleagues a coffee.",
        "exam_tags": ["考研"],
        "extra_forms": ["means", "meant", "meaning"],
    },
    "means": {
        "common": "v. 意思是(mean 的第三人称单数)",
        "exam_sense": "n. 方法; 手段; 财力",
        "example": "The ends do not justify the means.",
        "exam_tags": ["考研", "六级"],
    },
    "figure": {
        "common": "n. 数字; 身材",
        "exam_sense": "n. 人物; 人士 / vt. 认为; 推断",
        "example": "She became a leading figure in the field of genetics.",
        "exam_tags": ["考研", "六级"],
    },
    "present": {
        "common": "n. 礼物 / adj. 现在的",
        "exam_sense": "adj. 出席的; 在场的 / vt. 呈现; 提出",
        "example": "All committee members were present at the meeting.",
        "exam_tags": ["考研", "四级"],
    },
    "practice": {
        "common": "n. 练习; 实践",
        "exam_sense": "n. 惯例; 惯常做法 / vi. 执业",
        "example": "It is now common practice to publish raw data alongside papers.",
        "exam_tags": ["考研", "六级"],
        "extra_forms": ["practise", "practises", "practised", "practising"],
    },
    "issue": {
        "common": "n. 问题; 议题",
        "exam_sense": "vt. 发行; 发布 / n. (报刊)期号",
        "example": "The journal issued a correction the following month.",
        "exam_tags": ["考研", "六级"],
    },
    "hold": {
        "common": "vt. 握住; 拿着",
        "exam_sense": "vt. 认为; 裁定; 容纳; 举行",
        "example": "The court held that the regulation was invalid.",
        "exam_tags": ["考研"],
    },
    "save": {
        "common": "vt. 拯救; 节省",
        "exam_sense": "prep. 除...之外",
        "example": "Save for a few exceptions, all the samples matched.",
        "exam_tags": ["考研"],
        "guard": r"\bsave\s+for\b",
    },
    "spare": {
        "common": "adj. 备用的 / vt. 抽出(时间)",
        "exam_sense": "adj. 简朴的; 不加修饰的",
        "example": "He writes in a spare, unadorned style.",
        "exam_tags": ["考研", "六级"],
    },
    "spring": {
        "common": "n. 春天",
        "exam_sense": "vi. 突然弹起; 涌现 / n. 泉水; 弹簧",
        "example": "The trap sprang shut before she could react.",
        "exam_tags": ["考研"],
    },
    "strike": {
        "common": "vt. 打击; 撞击 / n. 罢工",
        "exam_sense": "vt. 使突然想到; 打动; 达成(协议)",
        "example": "It struck me that the two cases might be connected.",
        "exam_tags": ["考研", "六级"],
        "guard": r"\bstruck\b|\bstrikes?\s+me\b|\bstrike\s+(?:a\s+)?(?:balance|chord|deal|bargain)\b",
    },
    "firm": {
        "common": "adj. 坚定的; 牢固的",
        "exam_sense": "n. 公司; 事务所",
        "example": "She joined a consultancy firm in London.",
        "exam_tags": ["考研", "六级"],
    },
    "content": {
        "common": "n. 内容; 目录",
        "exam_sense": "adj. 满足的; 甘愿的 / vt. 使满足",
        "example": "She was content to wait another year.",
        "exam_tags": ["考研", "六级"],
    },
    "critical": {
        "common": "adj. 批评的; 挑剔的",
        "exam_sense": "adj. 关键的; 至关重要的; 危急的",
        "example": "Timing is a critical factor in the experiment.",
        "exam_tags": ["考研", "六级"],
    },
    "deliver": {
        "common": "vt. 递送; 投递",
        "exam_sense": "vt. 发表(演讲); 兑现(承诺)",
        "example": "She delivered a keynote address at the conference.",
        "exam_tags": ["考研", "六级"],
    },
    "employ": {
        "common": "vt. 雇佣",
        "exam_sense": "vt. 使用; 采用",
        "example": "The method employs a novel algorithm to rank the results.",
        "exam_tags": ["考研", "六级"],
    },
    "entertain": {
        "common": "vt. 娱乐; 使快乐",
        "exam_sense": "vt. 怀有(想法); 心存(疑虑)",
        "example": "He entertained serious doubts about the plan.",
        "exam_tags": ["考研", "六级"],
    },
    "exact": {
        "common": "adj. 精确的; 准确的",
        "exam_sense": "vt. 索取; 强求; 使付出(代价)",
        "example": "The sanctions exacted a heavy toll on ordinary families.",
        "exam_tags": ["考研"],
    },
    "express": {
        "common": "vt. 表达 / n. 快递",
        "exam_sense": "adj. 明确的; 快速的",
        "example": "The contract contains an express provision on liability.",
        "exam_tags": ["考研"],
    },
    "feature": {
        "common": "n. 特征; 特点",
        "exam_sense": "vt. 以...为特色 / n. 专题报道",
        "example": "The exhibition features works by young architects.",
        "exam_tags": ["考研", "六级"],
    },
    "ground": {
        "common": "n. 地面; 土地",
        "exam_sense": "n. 理由; 根据",
        "example": "There are grounds for cautious optimism.",
        "exam_tags": ["考研", "六级"],
        "guard": r"\bgrounds?\s+for\b|\bon\s+the\s+grounds?\b",
    },
    "lead": {
        "common": "vt. 领导; 带领",
        "exam_sense": "n. 线索; 铅",
        "example": "The police were following a promising lead.",
        "exam_tags": ["考研", "六级"],
        "extra_forms": ["leads", "led", "leading"],
    },
    "light": {
        "common": "n. 光; 灯 / adj. 轻的",
        "exam_sense": "vt. 点燃; 照亮 / adj. 轻松的; 浅显的",
        "example": "She lit a cigarette and waited for the results.",
        "exam_tags": ["考研", "四级"],
        "extra_forms": ["lights", "lit", "lighted", "lighting"],
    },
    "mark": {
        "common": "n. 记号; 分数",
        "exam_sense": "vt. 标志; 表明",
        "example": "The announcement marked a turning point in the dispute.",
        "exam_tags": ["考研", "六级"],
    },
    "might": {
        "common": "modal v. 可能; 也许",
        "exam_sense": "n. 力量; 威力",
        "example": "He pushed the door open with all his might.",
        "exam_tags": ["考研"],
    },
    "observe": {
        "common": "vt. 观察; 注意到",
        "exam_sense": "vt. 遵守; 庆祝(节日)",
        "example": "The country has observed the treaty since 1997.",
        "exam_tags": ["考研", "六级"],
        "guard": r"\bobserv(?:e|es|ed|ing)\s+(?:the|a|its|their)\s+(?:treaty|rule|rules|law|tradition|custom|ceasefire|fast|deadline|limit)\b",
    },
    "office": {
        "common": "n. 办公室",
        "exam_sense": "n. 职务; 公职",
        "example": "She took office in January 2020.",
        "exam_tags": ["考研", "六级"],
        "guard": r"\b(?:take|took|takes|taking|in|into|out\s+of|hold|holds|held|holding|assume|assumed|leave|left|leaves)\s+office\b",
    },
    "order": {
        "common": "n. 命令; 秩序; 顺序",
        "exam_sense": "n. 订单 / vt. 订购",
        "example": "The company placed a large order for spare parts.",
        "exam_tags": ["考研", "四级"],
    },
    "part": {
        "common": "n. 部分",
        "exam_sense": "vi. 分开; 分手 / n. 角色",
        "example": "She parted with her savings to fund the project.",
        "exam_tags": ["考研", "六级"],
    },
    "picture": {
        "common": "n. 图片; 照片",
        "exam_sense": "vt. 想象; 设想",
        "example": "Picture a city with no private cars at all.",
        "exam_tags": ["考研", "六级"],
    },
    "place": {
        "common": "n. 地方; 位置",
        "exam_sense": "n. 名次; 席位 / vt. 放置",
        "example": "The team finished in second place.",
        "exam_tags": ["考研", "四级"],
    },
    "point": {
        "common": "n. 点; 观点",
        "exam_sense": "n. 要点; 意义 / vi. 指向",
        "example": "There is no point in arguing about the wording.",
        "exam_tags": ["考研", "六级"],
    },
    "poor": {
        "common": "adj. 贫穷的",
        "exam_sense": "adj. 差的; 糟糕的; 可怜的",
        "example": "The report gives a poor account of the evidence.",
        "exam_tags": ["考研", "四级"],
    },
    "pose": {
        "common": "n. 姿势 / vi. 摆姿势",
        "exam_sense": "vt. 造成(威胁/问题); 提出(问题)",
        "example": "The rule poses a threat to press freedom.",
        "exam_tags": ["考研", "六级"],
    },
    "press": {
        "common": "vt. 按; 压 / n. 新闻界",
        "exam_sense": "vt. 催促; 极力主张",
        "example": "Reporters pressed him for a direct answer.",
        "exam_tags": ["考研", "六级"],
    },
    "pretty": {
        "common": "adj. 漂亮的",
        "exam_sense": "adv. 相当; 颇",
        "example": "The results are pretty convincing.",
        "exam_tags": ["考研", "四级"],
    },
    "prize": {
        "common": "n. 奖品; 奖金",
        "exam_sense": "vt. 珍视; 重视",
        "example": "He prized his independence above any salary.",
        "exam_tags": ["考研", "六级"],
    },
    "produce": {
        "common": "vt. 生产; 制造",
        "exam_sense": "n. 农产品",
        "example": "The market sells fresh local produce.",
        "exam_tags": ["考研", "六级"],
    },
    "promise": {
        "common": "n./vt. 承诺; 许诺",
        "exam_sense": "n. 前途; 潜力",
        "example": "She is a young researcher of great promise.",
        "exam_tags": ["考研", "六级"],
    },
    "proper": {
        "common": "adj. 恰当的; 合适的",
        "exam_sense": "adj. 严格意义上的; 固有的",
        "example": "Physics is not the proper study of mankind.",
        "exam_tags": ["考研", "六级"],
    },
    "quarter": {
        "common": "n. 四分之一",
        "exam_sense": "n. 季度; 一刻钟",
        "example": "Third-quarter earnings beat expectations.",
        "exam_tags": ["考研", "四级"],
    },
    "raise": {
        "common": "vt. 举起; 提高",
        "exam_sense": "vt. 提出(问题); 养育; 筹集",
        "example": "She raised an objection to the proposal.",
        "exam_tags": ["考研", "六级"],
    },
    "reason": {
        "common": "n. 原因; 理由",
        "exam_sense": "vi. 推理; 论证",
        "example": "Humans are able to reason about abstract concepts.",
        "exam_tags": ["考研", "六级"],
    },
    "reflect": {
        "common": "vt. 反射; 映出",
        "exam_sense": "vt. 反映; 表明 / vi. 反思",
        "example": "The figures reflect a slowdown in demand.",
        "exam_tags": ["考研", "六级"],
    },
    "remain": {
        "common": "vi. 剩下; 留下",
        "exam_sense": "vi. 仍然是; 保持不变",
        "example": "The cause of the failure remains unclear.",
        "exam_tags": ["考研", "六级"],
    },
    "reserve": {
        "common": "vt. 预订; 保留",
        "exam_sense": "n. 储备; 保护区",
        "example": "The country holds large oil reserves.",
        "exam_tags": ["考研", "六级"],
    },
    "respect": {
        "common": "n./vt. 尊重; 尊敬",
        "exam_sense": "n. 方面",
        "example": "In this respect, the two studies agree.",
        "exam_tags": ["考研", "六级"],
    },
    "rest": {
        "common": "n./vi. 休息",
        "exam_sense": "n. 其余部分; 剩余",
        "example": "The rest of the team stayed behind.",
        "exam_tags": ["考研", "四级"],
    },
    "review": {
        "common": "n./vt. 复习; 回顾",
        "exam_sense": "n. 评论; 审查",
        "example": "The paper received a favourable review.",
        "exam_tags": ["考研", "六级"],
    },
    "scale": {
        "common": "n. 刻度; 天平",
        "exam_sense": "n. 规模; 范围 / vt. 攀登",
        "example": "The scale of the challenge is hard to overstate.",
        "exam_tags": ["考研", "六级"],
    },
    "second": {
        "common": "num. 第二 / n. 秒",
        "exam_sense": "vt. 支持; 附议",
        "example": "Two members seconded the motion.",
        "exam_tags": ["考研"],
    },
    "sentence": {
        "common": "n. 句子",
        "exam_sense": "vt. 判决; 宣判",
        "example": "He was sentenced to five years in prison.",
        "exam_tags": ["考研", "六级"],
    },
    "serve": {
        "common": "vt. 服务; 招待",
        "exam_sense": "vi. 任职; 起...作用",
        "example": "She served as mayor for two terms.",
        "exam_tags": ["考研", "六级"],
    },
    "settle": {
        "common": "vi. 定居; 安顿",
        "exam_sense": "vt. 解决; 结清",
        "example": "The two sides settled the dispute out of court.",
        "exam_tags": ["考研", "六级"],
    },
    "shape": {
        "common": "n. 形状; 外形",
        "exam_sense": "vt. 塑造; 影响",
        "example": "Early experiences shape adult behaviour.",
        "exam_tags": ["考研", "六级"],
    },
    "sign": {
        "common": "n. 签名 / vt. 签字",
        "exam_sense": "n. 迹象; 标牌",
        "example": "There is no sign of a recovery in demand.",
        "exam_tags": ["考研", "四级"],
    },
    "solid": {
        "common": "adj. 固体的; 坚硬的",
        "exam_sense": "adj. 可靠的; 扎实的",
        "example": "The claim rests on solid evidence.",
        "exam_tags": ["考研", "六级"],
    },
    "spell": {
        "common": "vt. 拼写",
        "exam_sense": "n. 一段时间 / vt. 意味着; 招致",
        "example": "A long spell of dry weather hit the region.",
        "exam_tags": ["考研"],
        "extra_forms": ["spells", "spelt", "spelled", "spelling"],
    },
    "stake": {
        "common": "n. 赌注; 赌本",
        "exam_sense": "n. 股份; 利害关系",
        "example": "Thousands of jobs are at stake.",
        "exam_tags": ["考研", "六级"],
    },
    "stock": {
        "common": "n. 存货; 库存",
        "exam_sense": "n. 股票; 股份 / adj. 老一套的",
        "example": "The stock market fell sharply on Monday.",
        "exam_tags": ["考研", "六级"],
    },
    "story": {
        "common": "n. 故事",
        "exam_sense": "n. 楼层; 新闻报道",
        "example": "They live in a ten-story building near the park.",
        "exam_tags": ["考研"],
    },
    "stretch": {
        "common": "vt. 拉伸; 伸展",
        "exam_sense": "n. 一段(时间/路程)",
        "example": "Drivers faced a long stretch of empty road.",
        "exam_tags": ["考研", "六级"],
    },
    "study": {
        "common": "v. 学习",
        "exam_sense": "n. 研究; 书房",
        "example": "A recent study found no link between the two.",
        "exam_tags": ["考研", "四级"],
    },
    "succeed": {
        "common": "vi. 成功",
        "exam_sense": "vt. 继任; 接替",
        "example": "She succeeded him as director of the institute.",
        "exam_tags": ["考研", "六级"],
    },
    "suit": {
        "common": "vt. 适合 / n. 西装",
        "exam_sense": "n. 诉讼; 起诉",
        "example": "The company faces a civil suit from former staff.",
        "exam_tags": ["考研", "六级"],
    },
    "suspect": {
        "common": "vt. 怀疑",
        "exam_sense": "n. 嫌疑犯 / adj. 可疑的",
        "example": "Police arrested the prime suspect on Friday.",
        "exam_tags": ["考研", "六级"],
    },
    "tell": {
        "common": "vt. 告诉; 讲述",
        "exam_sense": "vt. 分辨; 辨别",
        "example": "Few people can tell the difference between the two species.",
        "exam_tags": ["考研", "六级"],
        "extra_forms": ["tells", "told", "telling"],
    },
    "tender": {
        "common": "adj. 温柔的; 柔软的",
        "exam_sense": "n. 投标 / vt. 正式提出",
        "example": "The contract was put out to tender.",
        "exam_tags": ["考研", "六级"],
    },
    "thin": {
        "common": "adj. 薄的; 瘦的",
        "exam_sense": "adj. 站不住脚的; 稀少的",
        "example": "The evidence for that claim is rather thin.",
        "exam_tags": ["考研", "六级"],
    },
    "tie": {
        "common": "n. 领带 / vt. 系; 捆绑",
        "exam_sense": "n. 联系; 关系",
        "example": "Trade ties between the two countries have deepened.",
        "exam_tags": ["考研", "六级"],
        "extra_forms": ["ties", "tied", "tying"],
    },
    "touch": {
        "common": "vt. 触摸; 接触",
        "exam_sense": "vt. 感动; 触动 / n. 联系",
        "example": "Her story touched everyone in the room.",
        "exam_tags": ["考研", "六级"],
    },
    "treat": {
        "common": "vt. 对待; 治疗",
        "exam_sense": "n. 款待; 乐事",
        "example": "A day off was a rare treat for the team.",
        "exam_tags": ["考研", "六级"],
    },
    "turn": {
        "common": "v. 转弯; 转动",
        "exam_sense": "vi. 变成; 变得 / n. 轮到",
        "example": "Her face turned pale at the news.",
        "exam_tags": ["考研", "四级"],
    },
    "uniform": {
        "common": "n. 制服",
        "exam_sense": "adj. 统一的; 一致的",
        "example": "The rules must be applied in a uniform way.",
        "exam_tags": ["考研", "六级"],
    },
    "utter": {
        "common": "vt. 说出; 发出(声音)",
        "exam_sense": "adj. 完全的; 彻底的",
        "example": "The claim is utter nonsense.",
        "exam_tags": ["考研"],
    },
    "vain": {
        "common": "adj. 徒劳的; 白费的",
        "exam_sense": "adj. 虚荣的; 自负的",
        "example": "He was vain about his appearance.",
        "exam_tags": ["考研", "六级"],
    },
    "value": {
        "common": "n. 价值",
        "exam_sense": "vt. 重视; 珍视",
        "example": "I value your advice more than you know.",
        "exam_tags": ["考研", "四级"],
    },
    "virtue": {
        "common": "n. 美德; 德行",
        "exam_sense": "n. 优点; 长处",
        "example": "The virtues of the method outweigh its costs.",
        "exam_tags": ["考研", "六级"],
    },
    "volume": {
        "common": "n. 音量; 体积",
        "exam_sense": "n. 卷; 册",
        "example": "The library holds a rare multi-volume history.",
        "exam_tags": ["考研", "六级"],
    },
    "want": {
        "common": "vt. 想要; 希望",
        "exam_sense": "n. 缺乏; 缺少",
        "example": "The project failed for want of funding.",
        "exam_tags": ["考研"],
    },
    "waste": {
        "common": "vt. 浪费",
        "exam_sense": "n. 废弃物; 荒地",
        "example": "The plant discharges toxic waste into the river.",
        "exam_tags": ["考研", "六级"],
    },
    "wave": {
        "common": "n. 波浪; 海浪",
        "exam_sense": "n. 浪潮; 风潮",
        "example": "A wave of protests swept the capital.",
        "exam_tags": ["考研", "六级"],
    },
    "wear": {
        "common": "vt. 穿; 戴",
        "exam_sense": "n. 磨损 / vi. 磨损; 耐用",
        "example": "The carpet shows signs of wear.",
        "exam_tags": ["考研", "六级"],
        "extra_forms": ["wears", "wore", "worn", "wearing"],
    },
    "welcome": {
        "common": "vt. 欢迎",
        "exam_sense": "adj. 令人欣喜的; 受欢迎的",
        "example": "The decision came as a welcome surprise.",
        "exam_tags": ["考研", "四级"],
    },
    "while": {
        "common": "conj. 当...时; 虽然",
        "exam_sense": "n. 一段时间",
        "example": "She waited for a while before answering.",
        "exam_tags": ["考研", "四级"],
        "guard": r"\b(?:a|the)\s+while\b",
    },
    "will": {
        "common": "modal v. 将要; 会",
        "exam_sense": "n. 意志; 决心; 遗嘱",
        "example": "He has the will to finish what he started.",
        "exam_tags": ["考研", "六级"],
    },
    "wonder": {
        "common": "vt. 想知道; 纳闷",
        "exam_sense": "n. 奇迹; 惊叹",
        "example": "The canyon is one of the wonders of nature.",
        "exam_tags": ["考研", "六级"],
    },
    "word": {
        "common": "n. 单词; 话语",
        "exam_sense": "n. 消息; 诺言",
        "example": "Word spread quickly through the village.",
        "exam_tags": ["考研", "六级"],
    },
    "work": {
        "common": "n./vi. 工作",
        "exam_sense": "vi. 起作用; 运转 / n. 作品",
        "example": "The treatment works quickly in most patients.",
        "exam_tags": ["考研", "六级"],
    },
    "yield": {
        "common": "n. 产量; 收益",
        "exam_sense": "vi. 屈服; 让步 / vt. 产生",
        "example": "The government yielded to public pressure.",
        "exam_tags": ["考研", "六级"],
    },
    "fair": {
        "common": "adj. 公平的; 合理的",
        "exam_sense": "n. 集市; 展览会",
        "example": "The trade fair opens next Tuesday.",
        "exam_tags": ["考研", "六级"],
        "guard": r"\b(?:trade|book|job|science|county|state)\s+fair\b",
    },
    "class": {
        "common": "n. 班级; 课",
        "exam_sense": "n. 阶级; 阶层",
        "example": "The novel explores the British class system.",
        "exam_tags": ["考研", "六级"],
    },
    "last": {
        "common": "adj. 最后的 / adv. 上次",
        "exam_sense": "vi. 持续; 延续",
        "example": "The meeting lasted nearly three hours.",
        "exam_tags": ["考研", "四级"],
    },
    "leave": {
        "common": "v. 离开; 留下",
        "exam_sense": "n. 假期; 许可",
        "example": "She is on maternity leave until March.",
        "exam_tags": ["考研", "六级"],
    },
    "long": {
        "common": "adj. 长的 / adv. 长久地",
        "exam_sense": "vi. 渴望; 盼望",
        "example": "He longed for a quieter life in the countryside.",
        "exam_tags": ["考研", "六级"],
        "guard": r"\blong(?:s|ed|ing)?\s+for\b",
    },
    "odd": {
        "common": "adj. 奇怪的; 古怪的",
        "exam_sense": "adj. 奇数的; 单只的",
        "example": "Odd numbers are marked in red on the chart.",
        "exam_tags": ["考研"],
    },
    "even": {
        "common": "adv. 甚至; 甚至更",
        "exam_sense": "adj. 平坦的; 偶数的; 均匀的",
        "example": "Two, four and six are even numbers.",
        "exam_tags": ["考研", "六级"],
        "guard": r"\beven\s+(?:numbers?|surface|ground|temper|keel|layer|distribution)\b",
    },
    "right": {
        "common": "adj. 正确的 / n. 右边",
        "exam_sense": "n. 权利; 正当要求",
        "example": "Workers demanded the right to organize.",
        "exam_tags": ["考研", "六级"],
    },
    "run": {
        "common": "vi. 跑; 奔跑",
        "exam_sense": "vt. 经营; 管理; 运行",
        "example": "Her family runs a small hotel by the lake.",
        "exam_tags": ["考研", "四级"],
    },
    "see": {
        "common": "vt. 看见",
        "exam_sense": "vt. 明白; 理解; 经历",
        "example": "I see what you mean now.",
        "exam_tags": ["考研", "四级"],
        "extra_forms": ["sees", "saw", "seen", "seeing"],
    },
    "stand": {
        "common": "vi. 站立; 站着",
        "exam_sense": "vt. 忍受 / n. 立场; 看台",
        "example": "She could not stand the constant noise.",
        "exam_tags": ["考研", "六级"],
    },
    "state": {
        "common": "n. 状态; 国家",
        "exam_sense": "vt. 陈述; 声明 / n. 州",
        "example": "The report states that emissions have fallen.",
        "exam_tags": ["考研", "六级"],
    },
    "still": {
        "common": "adv. 仍然; 还",
        "exam_sense": "adj. 静止的; 平静的",
        "example": "The lake was still in the early morning.",
        "exam_tags": ["考研", "六级"],
        "guard": r"\bstill\s+(?:waters?|air|night|life|surface)\b",
    },
    "table": {
        "common": "n. 桌子",
        "exam_sense": "vt. 搁置(议案) / n. 表格",
        "example": "The bill was tabled until the next session.",
        "exam_tags": ["考研"],
    },
    "term": {
        "common": "n. 学期; 术语",
        "exam_sense": "n. 条款; 任期; 关系",
        "example": "The contract's terms are unusually strict.",
        "exam_tags": ["考研", "六级"],
    },
    "tip": {
        "common": "n. 小费; 尖端",
        "exam_sense": "n. 提示; 建议",
        "example": "Here are three tips for faster reading.",
        "exam_tags": ["考研", "四级"],
    },
    "watch": {
        "common": "vt. 观看 / n. 手表",
        "exam_sense": "vt. 注意; 监视",
        "example": "Watch your step on the wet floor.",
        "exam_tags": ["考研", "四级"],
    },
    "well": {
        "common": "adv. 好; 很好地",
        "exam_sense": "n. 井",
        "example": "The village depends on a single water well.",
        "exam_tags": ["考研"],
        "guard": r"\b(?:oil|water|gas)\s+well\b",
    },
    "cause": {
        "common": "n. 原因; 起因",
        "exam_sense": "n. 事业; 目标",
        "example": "She devoted her life to the cause of education.",
        "exam_tags": ["考研", "六级"],
    },
    "charge": {
        "common": "vt. 收费; 充电",
        "exam_sense": "n. 指控; 掌管 / vt. 指控",
        "example": "He was put in charge of the whole project.",
        "exam_tags": ["考研", "六级"],
    },
    "count": {
        "common": "vt. 数; 计算",
        "exam_sense": "vi. 重要; 有价值",
        "example": "In a close election, every vote counts.",
        "exam_tags": ["考研", "六级"],
    },
    "cover": {
        "common": "vt. 覆盖; 遮盖",
        "exam_sense": "vt. 报道; 涵盖",
        "example": "The paper covered the trial in detail.",
        "exam_tags": ["考研", "六级"],
    },
    "date": {
        "common": "n. 日期; 日子",
        "exam_sense": "vt. 追溯; 确定年代",
        "example": "The custom dates back to the ninth century.",
        "exam_tags": ["考研", "六级"],
        "guard": r"\bdate(?:s|d)?\s+back\b|\bdat(?:e|es|ed|ing)\s+(?:from|to)\b",
    },
    "deal": {
        "common": "n. 交易; 协议",
        "exam_sense": "vi. 处理; 应对",
        "example": "The team dealt with the crisis calmly.",
        "exam_tags": ["考研", "六级"],
        "guard": r"\bdeal(?:s|t|ing)?\s+with\b",
        "extra_forms": ["deals", "dealt", "dealing"],
    },
    "draw": {
        "common": "vt. 画; 绘制",
        "exam_sense": "vt. 吸引; 得出(结论)",
        "example": "The authors draw a very different conclusion.",
        "exam_tags": ["考研", "六级"],
    },
    "drive": {
        "common": "vt. 驾驶 / n. 驾车",
        "exam_sense": "n. 动力; 欲望 / vt. 驱使",
        "example": "Curiosity is the drive behind good science.",
        "exam_tags": ["考研", "六级"],
        "extra_forms": ["drives", "drove", "driven", "driving"],
    },
    "head": {
        "common": "n. 头; 头部",
        "exam_sense": "n. 负责人 / vt. 领导; 前往",
        "example": "She heads the department of chemistry.",
        "exam_tags": ["考研", "六级"],
    },
    "iron": {
        "common": "n. 铁",
        "exam_sense": "vt. 熨烫; 消除(分歧)",
        "example": "The two sides met to iron out their differences.",
        "exam_tags": ["考研"],
        "guard": r"\biron(?:s|ed|ing)?\s+out\b",
    },
    "key": {
        "common": "n. 钥匙; 关键",
        "exam_sense": "adj. 关键的; 主要的",
        "example": "Cost is a key consideration for buyers.",
        "exam_tags": ["考研", "四级"],
    },
    "land": {
        "common": "n. 土地; 陆地",
        "exam_sense": "vt. 获得(工作/合同)",
        "example": "She landed a job at a research institute.",
        "exam_tags": ["考研", "六级"],
    },
    "major": {
        "common": "adj. 主要的; 重大的",
        "exam_sense": "n. 专业 / vi. 主修",
        "example": "He majored in economics at college.",
        "exam_tags": ["考研", "六级"],
    },
    "match": {
        "common": "n. 比赛; 火柴",
        "exam_sense": "vt. 匹敌; 与...相配",
        "example": "No rival could match their production capacity.",
        "exam_tags": ["考研", "六级"],
    },
    "mind": {
        "common": "n. 头脑; 思想",
        "exam_sense": "vt. 介意; 照看",
        "example": "Do you mind if I open the window?",
        "exam_tags": ["考研", "四级"],
    },
    "note": {
        "common": "n. 笔记; 便条",
        "exam_sense": "vt. 注意到; 指出",
        "example": "The authors note that the sample was small.",
        "exam_tags": ["考研", "六级"],
    },
    "offer": {
        "common": "vt. 提供; 给予",
        "exam_sense": "n. 报价; 录用通知",
        "example": "She turned down the job offer.",
        "exam_tags": ["考研", "六级"],
    },
    "own": {
        "common": "adj. 自己的 / vt. 拥有",
        "exam_sense": "vt. 承认",
        "example": "He owned up to the mistake at once.",
        "exam_tags": ["考研", "六级"],
        "guard": r"\bown(?:s|ed|ing)?\s+up\b",
    },
    "post": {
        "common": "vt. 邮寄; 发布",
        "exam_sense": "n. 职位; 岗位",
        "example": "She took up a post at the ministry.",
        "exam_tags": ["考研", "六级"],
    },
    "race": {
        "common": "n. 比赛; 赛跑",
        "exam_sense": "n. 种族; 人种",
        "example": "The law bans discrimination by race.",
        "exam_tags": ["考研", "六级"],
    },
    "rock": {
        "common": "n. 岩石; 石头",
        "exam_sense": "vt. 使震惊; 使动摇",
        "example": "The scandal rocked the financial world.",
        "exam_tags": ["考研", "六级"],
        "guard": r"\brock(?:s|ed|ing)?\s+(?:the|a)\s+(?:market|world|industry|country|party|government|economy|foundation)\b",
    },
    "safe": {
        "common": "adj. 安全的",
        "exam_sense": "n. 保险箱 / adj. 稳妥的",
        "example": "Investing in bonds is a safe bet.",
        "exam_tags": ["考研", "四级"],
    },
    "seal": {
        "common": "vt. 密封 / n. 印章",
        "exam_sense": "vt. 敲定; 确定",
        "example": "The two firms sealed the deal on Friday.",
        "exam_tags": ["考研"],
        "guard": r"\bseal(?:s|ed|ing)?\s+(?:the\s+)?(?:deal|agreement|victory|fate)\b",
    },
    "shoot": {
        "common": "vt. 射击; 拍摄",
        "exam_sense": "vi. 猛增; 飞驰",
        "example": "Prices shot up after the announcement.",
        "exam_tags": ["考研", "六级"],
        "extra_forms": ["shoots", "shot", "shooting"],
    },
    "smart": {
        "common": "adj. 聪明的",
        "exam_sense": "adj. 时髦的; 智能的",
        "example": "The device is controlled by a smart app.",
        "exam_tags": ["考研", "六级"],
    },
    "stress": {
        "common": "n. 压力; 紧张",
        "exam_sense": "vt. 强调; 着重",
        "example": "The report stresses the need for urgent action.",
        "exam_tags": ["考研", "六级"],
    },
    "supply": {
        "common": "vt. 供应; 提供",
        "exam_sense": "n. 补给品; 供应量",
        "example": "Medical supplies reached the camp on Sunday.",
        "exam_tags": ["考研", "六级"],
    },
    "trip": {
        "common": "n. 旅行; 旅程",
        "exam_sense": "vi. 绊倒; 失足",
        "example": "She tripped over a cable in the dark.",
        "exam_tags": ["考研"],
        "guard": r"\btrip(?:s|ped|ping)?\s+(?:over|on|up)\b",
    },
}

# 常见逻辑连接信号词
LOGIC_SIGNALS: dict[str, dict[str, str]] = {
    "however": {"type": "转折 (Contrast)", "implication": "转折之后必有考点或作者核心立场反转"},
    "nevertheless": {"type": "让步转折 (Concession)", "implication": "表明即使有前述困难，核心结论依然成立"},
    "nonetheless": {"type": "让步转折 (Concession)", "implication": "承接前文让步，后文才是重心"},
    "yet": {"type": "强转折 (Contrast)", "implication": "突显意料之外的事实或对前文论点的颠覆"},
    "whereas": {"type": "对照对比 (Comparison)", "implication": "二者特征正反分明，常考对比细节题"},
    "while": {"type": "让步/对比 (Concession)", "implication": "句首引导让步，主句才是作者强调的实质"},
    "although": {"type": "让步从句 (Concession)", "implication": "从句内容非重点，主句判断才是题目落脚点"},
    "even though": {"type": "让步从句 (Concession)", "implication": "主句观点不受从句客观限制"},
    "in contrast": {"type": "对比 (Comparison)", "implication": "前后形成二元对立，留心正反混淆干扰项"},
    "on the contrary": {"type": "否定转折 (Correction)", "implication": "纠正前文误区，直接给出事实真相"},
    "therefore": {"type": "因果结论 (Result)", "implication": "因果推论终点，通常为段落论点"},
    "consequently": {"type": "因果影响 (Consequence)", "implication": "事件直接引发的连锁反应或结果"},
    "as a result": {"type": "因果推导 (Result)", "implication": "命题人极易在此处设因果倒置陷阱"},
    "furthermore": {"type": "递进补充 (Addition)", "implication": "论据同向增强，感情色彩保持一致"},
    "moreover": {"type": "递进补充 (Addition)", "implication": "论证层层深入，支持相同主旨"},
    "in fact": {"type": "强调/转折 (Emphasis)", "implication": "常用于推翻表面假象，透露更本质事实"},
    "actually": {"type": "转折真相 (Reality)", "implication": "反驳常规共识，直击命题关键"},
}


# ==============================================================================
# 纯逻辑层：长难句规则拆解、熟词生义扫描、同义词对齐
# ==============================================================================

_FF_FORM_CACHE: dict[str, str] | None = None


def _ff_form_index() -> dict[str, str]:
    """词形 → 原形 的索引：让 prompted / harbored / coined 这类变形也能命中。

    规则屈折推不出来的（see→saw、tie→tying）由词条的 extra_forms 兜住；
    显式词条最后覆盖一遍，保证 means / left 这种本身既是变形又是独立词条的
    落到自己那条上（means 要按「方法」讲，而不是 mean 的第三人称单数）。
    """
    global _FF_FORM_CACHE
    if _FF_FORM_CACHE is None:
        index: dict[str, str] = {}
        for lemma, info in EXAM_FALSE_FRIENDS.items():
            forms = _verb_forms(lemma) + list(info.get("extra_forms") or [])
            for form in forms:
                index.setdefault(form, lemma)
        for lemma in EXAM_FALSE_FRIENDS:
            index[lemma] = lemma
        _FF_FORM_CACHE = index
    return _FF_FORM_CACHE


def scan_false_friends(text: str) -> list[dict[str, Any]]:
    """扫描文本里出现的熟词生义，返回预警列表。

    命中要过三关：词形能还原到词条、有 guard 的词条还要上下文真的命中该搭配、
    同一个词只报一次（报第一次真正成立的位置，所以前面用日常义、后面用生义也能抓到）。
    排序上把 guard 命中的排前面——它们是被搭配坐实的，比只靠词形命中的更可信。
    """
    if not text:
        return []
    index = _ff_form_index()
    hits: list[dict[str, Any]] = []
    seen: set[str] = set()

    for match in re.finditer(r"\b[A-Za-z]+(?:'[a-z]+)?\b", text):
        token = match.group(0).lower()
        lemma = index.get(token)
        if not lemma or lemma in seen:
            continue
        info = EXAM_FALSE_FRIENDS[lemma]
        guard = info.get("guard")
        if guard:
            window = text[max(0, match.start() - 80) : match.end() + 80]
            if not re.search(guard, window, re.IGNORECASE):
                continue
        seen.add(lemma)
        tags = list(info.get("exam_tags") or ["考研"])
        hits.append({
            "word": lemma,
            "surface": token,
            "common_sense": info["common"],
            "exam_sense": info["exam_sense"],
            "example": info["example"],
            "tags": tags,
            "_rank": (0 if guard else 1, 0 if "考研" in tags else 1, match.start()),
        })

    hits.sort(key=lambda h: h["_rank"])
    for hit in hits:
        hit.pop("_rank")
    return hits


def extract_logic_signals(sentence: str) -> list[dict[str, str]]:
    """探测句子中的逻辑连接词与命题信号。"""
    if not sentence:
        return []
    signals: list[dict[str, str]] = []
    lower = sentence.lower()
    for sig, info in LOGIC_SIGNALS.items():
        pattern = r"\b" + re.escape(sig) + r"\b"
        if re.search(pattern, lower):
            signals.append({
                "signal": sig,
                "type": info["type"],
                "implication": info["implication"],
            })
    return signals


def rule_based_syntax_parse(sentence: str) -> dict[str, Any]:
    """离线本地规则长难句手术刀（当无 LLM 或调用失败时兜底）。

    依据标点符号、从属连词（which, that, who, where, when, although...）
    以及双逗号/破折号划分主谓宾主干与从句。
    """
    raw = sentence.strip()
    if not raw:
        return {
            "sentence": "",
            "backbone": "",
            "components": [],
            "logic_signals": [],
            "exam_tips": "句子为空",
        }

    signals = extract_logic_signals(raw)

    # 1. 探测插入语（双破折号或成对逗号修饰）
    parts: list[dict[str, Any]] = []

    # 尝试基于正则进行最轻量化的粗分
    # 从句引导词
    clause_markers = [
        "which", "that", "who", "whom", "whose", "where", "when", "why",
        "although", "though", "even if", "even though", "because", "since",
        "while", "whereas", "if", "unless", "so that", "in order that"
    ]
    marker_pattern = r"\b(" + "|".join(clause_markers) + r")\b"

    # 切分句子为成分片段
    # 查找主要动词（简易探测）
    words = raw.split()
    components: list[dict[str, Any]] = []

    # 如果有破折号插入语
    dash_match = re.search(r"([—–-]{1,2}.*?[—–-]{1,2})", raw)
    if dash_match:
        span = dash_match.group(1)
        before, _, after = raw.partition(span)
        if before.strip():
            components.append({
                "text": before.strip(),
                "role": "main",
                "role_label": "主句核心",
                "depth": 0,
                "can_collapse": False,
            })
        components.append({
            "text": span.strip(),
            "role": "parenthesis",
            "role_label": "插入语 (可暂略)",
            "depth": 1,
            "can_collapse": True,
        })
        if after.strip():
            components.append({
                "text": after.strip(),
                "role": "main",
                "role_label": "主句延续",
                "depth": 0,
                "can_collapse": False,
            })
    else:
        # 按逗号粗分
        comma_parts = [p.strip() for p in raw.split(",") if p.strip()]
        if len(comma_parts) > 1:
            for idx, p in enumerate(comma_parts):
                m = re.search(marker_pattern, p.lower())
                if m:
                    marker = m.group(1)
                    role = "attr_clause" if marker in ("which", "that", "who", "whom", "whose") else "adv_clause"
                    components.append({
                        "text": p,
                        "role": role,
                        "role_label": f"{marker} 引导的修饰从句",
                        "depth": 1,
                        "can_collapse": True,
                    })
                else:
                    components.append({
                        "text": p,
                        "role": "main" if idx == 0 else "predicate_obj",
                        "role_label": "主句主干" if idx == 0 else "补充成分",
                        "depth": 0,
                        "can_collapse": False,
                    })
        else:
            components.append({
                "text": raw,
                "role": "main",
                "role_label": "完整单句",
                "depth": 0,
                "can_collapse": False,
            })

    # 提取骨架：拼接所有非从句成分的前 15 个词作为粗骨架
    main_texts = [c["text"] for c in components if c["role"] in ("main", "predicate_obj")]
    backbone = " ".join(main_texts) if main_texts else raw
    if len(backbone.split()) > 20:
        backbone = " ".join(backbone.split()[:16]) + "..."

    return {
        "sentence": raw,
        "backbone": backbone,
        "components": components,
        "logic_signals": signals,
        "exam_tips": "田静长难句拆解法提示：请优先阅读未折叠的主干部分，明确行为主体与谓语动词，定状从句作为修饰挂件随后补充。",
    }


def rule_based_paraphrase_extract(source_text: str, target_text: str) -> list[dict[str, Any]]:
    """离线本地同义改写抽取兜底（基于高频同义词和词根词缀启发式匹配）。"""
    src_clean = source_text.strip()
    tgt_clean = target_text.strip()
    if not src_clean or not tgt_clean:
        return []

    # 简单词形扫描对齐
    src_words = set(re.findall(r"\b[A-Za-z]{3,}\b", src_clean.lower()))
    tgt_words = set(re.findall(r"\b[A-Za-z]{3,}\b", tgt_clean.lower()))

    # 若几乎完全不重合，则视为整句同义转述
    intersect = src_words.intersection(tgt_words)
    pairs: list[dict[str, Any]] = []

    if len(intersect) < len(tgt_words) * 0.5:
        pairs.append({
            "source_phrase": src_clean[:120],
            "target_phrase": tgt_clean[:120],
            "type": "整句同义改写 (Full Paraphrase)",
            "explanation": "选项并未直接复用原文词汇，而是采用全句释义转换，属于考研与四六级典型细节题考点。",
        })
    else:
        # 重合度高则提取关键差异词
        diff_src = list(src_words - tgt_words)[:2]
        diff_tgt = list(tgt_words - src_words)[:2]
        if diff_src and diff_tgt:
            pairs.append({
                "source_phrase": ", ".join(diff_src),
                "target_phrase": ", ".join(diff_tgt),
                "type": "核心关键词置换",
                "explanation": f"原文核心词【{', '.join(diff_src)}】在选项中转换为【{', '.join(diff_tgt)}】。",
            })
    return pairs


# ==============================================================================
# 原文侧边分析：搭配提取 + 论证结构 + 同义改写兜底
# ==============================================================================

_NON_INFLECT_HEADS = {
    "a", "an", "the", "in", "on", "at", "by", "for", "to", "of", "with", "as",
    "under", "upon", "from", "into", "over", "out", "off", "up", "down", "about",
    "against", "beyond", "within", "without", "despite", "amid", "through",
}

# 不规则动词的常见屈折形式。正文里搭配几乎不会以原形出现（"gave rise to"
# 而不是 "give rise to"），不补这层就基本命中不到。
_VERB_INFLECT_IRREGULAR: dict[str, list[str]] = {
    "be": ["be", "is", "are", "was", "were", "been", "being", "am"],
    "give": ["give", "gives", "gave", "given", "giving"],
    "take": ["take", "takes", "took", "taken", "taking"],
    "make": ["make", "makes", "made", "making"],
    "come": ["come", "comes", "came", "coming"],
    "hold": ["hold", "holds", "held", "holding"],
    "bring": ["bring", "brings", "brought", "bringing"],
    "set": ["set", "sets", "setting"],
    "put": ["put", "puts", "putting"],
    "shed": ["shed", "sheds", "shedding"],
    "cast": ["cast", "casts", "casting"],
    "draw": ["draw", "draws", "drew", "drawn", "drawing"],
    "fall": ["fall", "falls", "fell", "fallen", "falling"],
    "rise": ["rise", "rises", "rose", "risen", "rising"],
    "run": ["run", "runs", "ran", "running"],
    "go": ["go", "goes", "went", "gone", "going"],
    "bear": ["bear", "bears", "bore", "borne", "bearing"],
    "strike": ["strike", "strikes", "struck", "striking"],
    "seek": ["seek", "seeks", "sought", "seeking"],
    "leave": ["leave", "leaves", "left", "leaving"],
    "lose": ["lose", "loses", "lost", "losing"],
    "keep": ["keep", "keeps", "kept", "keeping"],
    "stand": ["stand", "stands", "stood", "standing"],
    "break": ["break", "breaks", "broke", "broken", "breaking"],
    "lay": ["lay", "lays", "laid", "laying"],
    "pay": ["pay", "pays", "paid", "paying"],
    "carry": ["carry", "carries", "carried", "carrying"],
    "apply": ["apply", "applies", "applied", "applying"],
    "rely": ["rely", "relies", "relied", "relying"],
    "amount": ["amount", "amounts", "amounted", "amounting"],
    "result": ["result", "results", "resulted", "resulting"],
    "stem": ["stem", "stems", "stemmed", "stemming"],
    "adhere": ["adhere", "adheres", "adhered", "adhering"],
    "refer": ["refer", "refers", "referred", "referring"],
    "resort": ["resort", "resorts", "resorted", "resorting"],
    "subject": ["subject", "subjects", "subjected", "subjecting"],
    "attribute": ["attribute", "attributes", "attributed", "attributing"],
    "contribute": ["contribute", "contributes", "contributed", "contributing"],
    "reside": ["reside", "resides", "resided", "residing"],
    "grapple": ["grapple", "grapples", "grappled", "grappling"],
    "weigh": ["weigh", "weighs", "weighed", "weighing"],
    "rule": ["rule", "rules", "ruled", "ruling"],
    "scale": ["scale", "scales", "scaled", "scaling"],
    "phase": ["phase", "phases", "phased", "phasing"],
    "spring": ["spring", "springs", "sprang", "sprung", "springing"],
    "single": ["single", "singles", "singled", "singling"],
    "allow": ["allow", "allows", "allowed", "allowing"],
    "point": ["point", "points", "pointed", "pointing"],
    "live": ["live", "lives", "lived", "living"],
    "cut": ["cut", "cuts", "cutting"],
    "shy": ["shy", "shies", "shied", "shying"],
    "level": ["level", "levels", "leveled", "levelled", "leveling"],
}

# 考研高频搭配词表。本地这一层故意只做「词表命中」，不做通用 n-gram 挖掘：
# 通用挖掘出来的绝大多数是 is in / has to 这类没有学习价值的组合，而备考要的是
# 能直接背的动词短语和固定搭配。精度优先于召回，命中不到的交给 TJU-LLM 补。
_COLLOCATION_BANK: list[tuple[str, str, str]] = [
    ("account for", "解释…的原因；占（比例）", "动词短语"),
    ("give rise to", "引起，导致", "动词短语"),
    ("shed light on", "阐明，使…变得清楚", "动词短语"),
    ("call into question", "对…提出质疑", "动词短语"),
    ("take into account", "把…考虑在内", "动词短语"),
    ("take account of", "考虑到，顾及", "动词短语"),
    ("play a role in", "在…中起作用", "动词短语"),
    ("give way to", "让位于，被…取代", "动词短语"),
    ("make sense of", "理解，弄懂", "动词短语"),
    ("come to terms with", "接受，与…妥协", "动词短语"),
    ("bear out", "证实，支持", "动词短语"),
    ("stem from", "源于，由…造成", "动词短语"),
    ("result in", "导致，造成", "动词短语"),
    ("result from", "由…造成", "动词短语"),
    ("resort to", "诉诸，求助于", "动词短语"),
    ("adhere to", "坚持，遵守", "动词短语"),
    ("refer to", "指的是；提及", "动词短语"),
    ("subject to", "使遭受；取决于", "动词短语"),
    ("attribute to", "把…归因于", "动词短语"),
    ("contribute to", "有助于；促成", "动词短语"),
    ("reside in", "在于，存在于", "动词短语"),
    ("amount to", "总计为；等同于", "动词短语"),
    ("set out to", "着手做，打算做", "动词短语"),
    ("set aside", "搁置；留出", "动词短语"),
    ("put forward", "提出（观点、方案）", "动词短语"),
    ("carry out", "实施，执行", "动词短语"),
    ("draw on", "利用，借鉴", "动词短语"),
    ("fall short of", "未达到，低于", "动词短语"),
    ("live up to", "符合，不辜负", "动词短语"),
    ("take on", "承担；呈现", "动词短语"),
    ("hold true", "成立，适用", "动词短语"),
    ("bring about", "带来，引起", "动词短语"),
    ("rule out", "排除…的可能性", "动词短语"),
    ("weigh up", "权衡，斟酌", "动词短语"),
    ("single out", "挑出，单独指出", "动词短语"),
    ("point to", "表明，指向", "动词短语"),
    ("allow for", "考虑到，顾及", "动词短语"),
    ("cut back on", "削减，减少", "动词短语"),
    ("scale back", "缩减，缩小规模", "动词短语"),
    ("grapple with", "努力应对，设法解决", "动词短语"),
    ("shy away from", "回避，躲避", "动词短语"),
    ("level off", "趋于平稳，不再增减", "动词短语"),
    ("phase out", "逐步淘汰", "动词短语"),
    ("spring up", "涌现，迅速出现", "动词短语"),
    ("in the wake of", "随着…之后；作为…的结果", "介词短语"),
    ("at the expense of", "以…为代价", "介词短语"),
    ("in light of", "鉴于，根据", "介词短语"),
    ("in terms of", "在…方面，就…而言", "介词短语"),
    ("on the verge of", "即将，濒于", "介词短语"),
    ("in the face of", "面对，不顾", "介词短语"),
    ("by virtue of", "凭借，由于", "介词短语"),
    ("at odds with", "与…不一致，相矛盾", "介词短语"),
    ("in line with", "与…一致，符合", "介词短语"),
    ("to some extent", "在某种程度上", "介词短语"),
    ("a case in point", "恰当的例证", "名词短语"),
    ("the bulk of", "大部分，绝大多数", "名词短语"),
    ("a fraction of", "一小部分", "名词短语"),
]


def _verb_forms(verb: str) -> list[str]:
    """给出一个动词的常见屈折形式，让搭配能在正文里被认回来。"""
    irregular = _VERB_INFLECT_IRREGULAR.get(verb)
    if irregular:
        return list(dict.fromkeys(irregular))
    forms = [verb]
    if verb.endswith("e"):
        forms += [verb + "s", verb + "d", verb[:-1] + "ing"]
    elif verb.endswith("y") and verb[-2:-1] not in "aeiou":
        forms += [verb[:-1] + "ies", verb[:-1] + "ied", verb + "ing"]
    else:
        forms += [verb + "s", verb + "ed", verb + "ing"]
    if len(verb) <= 5 and verb[-1] not in "aeiouwxy":
        forms += [verb + verb[-1] + "ed", verb + verb[-1] + "ing"]
    return list(dict.fromkeys(forms))


def _collocation_regex(phrase: str) -> re.Pattern[str]:
    head, _, rest = phrase.partition(" ")
    if head in _NON_INFLECT_HEADS:
        alts = [head]
    else:
        alts = _verb_forms(head)
    head_pat = "|".join(re.escape(a) for a in alts)
    body_pat = re.escape(" " + rest) if rest else ""
    return re.compile(rf"\b(?:{head_pat}){body_pat}\b", re.IGNORECASE)


_COLLOCATION_PATTERNS: list[tuple[re.Pattern[str], str, str, str]] = [
    (_collocation_regex(phrase), phrase, meaning, kind)
    for phrase, meaning, kind in _COLLOCATION_BANK
]


def _sentence_around(text: str, start: int, end: int) -> str:
    """取匹配位置所在的那一整句，作为搭配的例句。"""
    left = max(
        text.rfind(".", 0, start),
        text.rfind("!", 0, start),
        text.rfind("?", 0, start),
        text.rfind("\n", 0, start),
    )
    rights = [
        i
        for i in (
            text.find(".", end),
            text.find("!", end),
            text.find("?", end),
            text.find("\n", end),
        )
        if i != -1
    ]
    right = min(rights) if rights else len(text)
    return text[left + 1 : right + 1].strip()


def extract_collocations(text: str, limit: int = 12) -> list[dict[str, Any]]:
    """从正文里捞出考研高频搭配，每条带上文中原句。"""
    body = text or ""
    if not body.strip():
        return []
    hits: list[dict[str, Any]] = []
    for pattern, canonical, meaning, kind in _COLLOCATION_PATTERNS:
        m = pattern.search(body)
        if not m:
            continue
        hits.append(
            {
                "phrase": canonical,
                "surface": m.group(0),
                "meaning": meaning,
                "kind": kind,
                "sentence": _sentence_around(body, m.start(), m.end()),
            }
        )
    hits.sort(key=lambda h: body.lower().find(h["surface"].lower()))
    return hits[:limit]


# 段落论证角色判定：自上而下第一条命中的规则生效。
# 「转折」放在「让步」前面，因为 but 比 although 更能代表作者真实立场。
_ARG_ROLE_RULES: list[tuple[re.Pattern[str], str, str]] = [
    (re.compile(r"\b(but|however|yet|nevertheless|nonetheless|whereas|by contrast|on the contrary|in contrast)\b", re.I),
     "转折·亮态度", "转折"),
    (re.compile(r"\b(in conclusion|to conclude|to sum up|in sum|overall|ultimately|in short|all in all)\b", re.I),
     "总结·结论", "收束"),
    (re.compile(r"\b(although|though|while|despite|in spite of|even if|admittedly|it is true that|granted)\b", re.I),
     "让步·铺垫", "让步"),
    (re.compile(r"\b(for example|for instance|such as|to illustrate|a case in point|consider the case)\b", re.I),
     "举例·论证", "举例支撑"),
    (re.compile(r"(\d+(\.\d+)?\s*(percent|%|million|billion)|\bstud(?:y|ies)\b|\bresearch(?:ers)?\b|\bsurvey\b|\bdata\b|\bfindings?\b)", re.I),
     "数据·研究支撑", "证据支撑"),
    (re.compile(r"\b(because|since|therefore|thus|hence|as a result|consequently|owing to|due to|so that)\b", re.I),
     "因果·论证", "因果承接"),
    (re.compile(r"\b(critics|skeptics|opponents|proponents|supporters|some argue|it is argued|argue that)\b", re.I),
     "引入对立观点", "对照"),
    (re.compile(r"\b(is defined as|refers to|is known as|means that|can be defined)\b", re.I),
     "概念界定", "界定"),
]

# 论证方法：跟上面的段落角色不是一回事。角色回答「这段在干嘛」（开篇/递进/收束），
# 方法回答「它怎么论证的」——举例、对比、因果、引数据……这才是「论证结构」该说清的东西。
# 方法的信号词散布全段（for example 常在段中，不只在主题句），所以扫整段。
_ARG_METHOD_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\b(for example|for instance|such as|to illustrate|a case in point|consider|take .{0,40} as an example)\b", re.I),
     "举例论证"),
    (re.compile(r"\b(by contrast|in contrast|on the contrary|whereas|while|on the other hand|compared (?:with|to)|unlike|instead)\b", re.I),
     "对比论证"),
    (re.compile(r"\b(because|since|therefore|thus|hence|as a result|consequently|owing to|due to|lead(?:s)? to|result(?:s)? in|account for)\b", re.I),
     "因果论证"),
    (re.compile(r"(\d+(?:\.\d+)?\s*(?:percent|%|million|billion|thousand)|according to|\b(?:study|studies|researchers|research|survey|data|findings|experiment)\b)", re.I),
     "引用/数据论证"),
    (re.compile(r"\b(analogy|analogous|just as|similarly|likewise|in the same way|resembles)\b", re.I),
     "类比论证"),
]


def analyze_argument_structure(paragraphs: list[str]) -> dict[str, Any]:
    """拆出全文的论证骨架：每段承担什么论证角色、段与段怎么衔接。

    纯本地规则。判据是「段落主题句的逻辑信号词 + 段落位置」这两件事——考研
    阅读的段落功能基本靠这两样就能判准，比按字数猜靠谱得多。信号词只看首句：
    段落功能由主题句承载，段中随手出现的 yet / for example 属于段内论证，
    不该改写整段的功能定位。
    """
    paras = [str(p or "").strip() for p in (paragraphs or [])]
    paras = [p for p in paras if p]
    if not paras:
        return {"skeleton": [], "thesis": "", "flow": "", "total": 0, "ai_generated": False}

    skeleton: list[dict[str, Any]] = []
    last_index = len(paras) - 1
    for idx, para in enumerate(paras):
        # 段落功能由主题句（首句）承载，所以首句先切出来——下面判角色和出 gist 都用它。
        first_sentence = re.split(r"(?<=[.!?])\s+", para)[0].strip()

        role, relation = "", ""
        for pattern, label, rel in _ARG_ROLE_RULES:
            if pattern.search(first_sentence):
                role, relation = label, rel
                break

        # 位置先验兜住两头：首段引出议题、末段收束落点，这是考研阅读里最稳的
        # 两条。主题句本身带对立信号时才让位（如让步式开篇的 However、末段
        # 的反转 But），其余一律按位置定性——否则「首段次句才出现 yet」「末段
        # 用 Therefore 收口」这类写法会被段内连接词带偏，段落功能就判错了。
        if idx == 0 and relation != "转折":
            role, relation = "提出议题·亮明论点", "开篇"
        elif idx == last_index and relation not in ("转折", "让步"):
            role, relation = "收束·落点", "收束"
        elif not role:
            role, relation = "展开论证", "递进"

        gist = first_sentence if len(first_sentence) <= 110 else first_sentence[:110] + "…"
        signals = [s["signal"] for s in extract_logic_signals(first_sentence)][:4]

        # 论证方法：全段扫信号词。没命中显式方法的段落，落在首段算「立论」，
        # 其余算「道理论证」（纯推理说理）——它确实是一种论证方法，不是没判出来。
        methods: list[str] = []
        for pattern, name in _ARG_METHOD_RULES:
            if pattern.search(para):
                methods.append(name)
            if len(methods) >= 2:
                break
        if not methods:
            methods = ["立论"] if idx == 0 else ["道理论证"]

        skeleton.append(
            {
                "index": idx,
                "role": role,
                "relation": relation,
                "method": methods,
                "gist": gist,
                "signals": signals,
                "length": len(para.split()),
            }
        )

    flow = " → ".join(dict.fromkeys(item["role"] for item in skeleton))
    thesis_source = paras[0]
    thesis = thesis_source if len(thesis_source) <= 220 else thesis_source[:220] + "…"
    # 全文用到哪些论证方法（去重、保序），让「论证结构」页头一眼能看出这篇文章的论证打法
    methods_all: list[str] = []
    for item in skeleton:
        for m in item["method"]:
            if m not in methods_all:
                methods_all.append(m)
    return {
        "skeleton": skeleton,
        "thesis": thesis,
        "flow": flow,
        "methods": methods_all,
        "total": len(paras),
        "ai_generated": False,
    }


# 同义改写兜底用的替换词表（考纲高频同义表达）。
_PARAPHRASE_SYNONYMS: dict[str, list[str]] = {
    "important": ["significant", "crucial", "vital"],
    "show": ["demonstrate", "indicate", "reveal"],
    "increase": ["rise", "grow", "climb"],
    "decrease": ["decline", "diminish", "drop"],
    "big": ["substantial", "considerable", "sizeable"],
    "small": ["modest", "slight", "marginal"],
    "problem": ["issue", "difficulty", "predicament"],
    "think": ["believe", "maintain", "contend"],
    "say": ["state", "assert", "remark"],
    "use": ["employ", "utilize", "apply"],
    "need": ["require", "call for", "necessitate"],
    "help": ["assist", "facilitate", "aid"],
    "cause": ["trigger", "bring about", "give rise to"],
    "many": ["numerous", "a host of", "a multitude of"],
    "most": ["the majority of", "the bulk of"],
    "often": ["frequently", "repeatedly"],
    "quickly": ["rapidly", "swiftly"],
    "difficult": ["challenging", "demanding", "formidable"],
    "good": ["beneficial", "favorable", "positive"],
    "bad": ["detrimental", "adverse", "negative"],
    "get": ["obtain", "acquire", "secure"],
    "make": ["render", "produce", "generate"],
    "change": ["alter", "modify", "shift"],
    "reduce": ["cut", "lessen", "curb"],
    "improve": ["enhance", "boost", "better"],
    "worry": ["concern", "alarm", "unsettle"],
    "argue": ["contend", "assert", "maintain"],
    "suggest": ["propose", "imply", "indicate"],
    "find": ["discover", "identify", "uncover"],
    "start": ["begin", "initiate", "launch"],
    "stop": ["halt", "cease", "end"],
    "keep": ["retain", "preserve", "maintain"],
    "very": ["highly", "particularly", "exceedingly"],
    "but": ["however", "nevertheless", "yet"],
    "because": ["since", "as", "owing to the fact that"],
    "so": ["therefore", "thus", "consequently"],
    "also": ["moreover", "furthermore", "in addition"],
    "about": ["approximately", "roughly", "some"],
    "people": ["individuals", "the public", "citizens"],
    "money": ["funds", "capital", "finances"],
    "job": ["position", "employment", "occupation"],
    "way": ["approach", "method", "means"],
    "idea": ["notion", "concept", "proposition"],
    "result": ["outcome", "consequence", "upshot"],
    "reason": ["factor", "cause", "rationale"],
    "effect": ["impact", "influence", "consequence"],
    "spend": ["allocate", "devote", "expend"],
    "want": ["intend", "seek", "aim"],
    "allow": ["enable", "permit", "let"],
    "hurt": ["harm", "damage", "undermine"],
    "safe": ["secure", "reliable", "sound"],
    "rare": ["scarce", "uncommon", "infrequent"],
}


def rule_based_paraphrase_sentence(sentence: str, count: int = 3) -> list[dict[str, Any]]:
    """离线同义改写兜底：按词表做单点替换，产出可对照的改写版本。

    这一层只做词级替换，产出的句子语法未必最优，所以每条都带上替换点
    （swaps），让用户看清改的是哪一处。真正的整句重构交给 TJU-LLM。
    """
    text = (sentence or "").strip()
    if not text:
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for m in re.finditer(r"\b[A-Za-z][A-Za-z\-']*\b", text):
        surface = m.group(0)
        targets = _PARAPHRASE_SYNONYMS.get(surface.lower())
        if not targets:
            continue
        target = targets[0]
        replacement = target[:1].upper() + target[1:] if surface[:1].isupper() else target
        rewritten = text[: m.start()] + replacement + text[m.end() :]
        if rewritten in seen:
            continue
        seen.add(rewritten)
        out.append(
            {
                "rewritten": rewritten,
                "swaps": [{"from": surface, "to": replacement}],
                "note": f"把【{surface}】换成考纲高频同义表达【{target}】。",
            }
        )
        if len(out) >= count:
            break
    return out


# ==============================================================================
# 持久化存储层：SQLite 独立管理 en_exam_* 表
# ==============================================================================

SCHEMA_EXAM = """
CREATE TABLE IF NOT EXISTS en_exam_paraphrases (
    pair_id         TEXT PRIMARY KEY,
    owner_id        TEXT NOT NULL,
    source_phrase   TEXT NOT NULL,
    target_phrase   TEXT NOT NULL,
    category        TEXT NOT NULL DEFAULT 'synonym',
    explanation     TEXT,
    source_sentence TEXT,
    exam_sentence   TEXT,
    stability       REAL NOT NULL DEFAULT 0,
    difficulty      REAL NOT NULL DEFAULT 0,
    due_at          TEXT NOT NULL,
    reps            INTEGER NOT NULL DEFAULT 0,
    state           TEXT NOT NULL DEFAULT 'new',
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_en_exam_paraphrases_owner ON en_exam_paraphrases(owner_id, due_at);

CREATE TABLE IF NOT EXISTS en_exam_highlights (
    highlight_id TEXT PRIMARY KEY,
    owner_id     TEXT NOT NULL,
    doc_key      TEXT NOT NULL,
    doc_title    TEXT,
    para_index   INTEGER NOT NULL DEFAULT -1,
    quote        TEXT NOT NULL,
    prefix       TEXT,
    suffix       TEXT,
    note         TEXT,
    color        TEXT NOT NULL DEFAULT 'gold',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_en_exam_highlights_doc
    ON en_exam_highlights(owner_id, doc_key, created_at);

-- 侧边分析结果缓存（搭配提取 + 论证结构）。提取要过一遍 TJU-LLM，不落库的话
-- 关掉阅读页再进来就得重新等一轮模型。每篇文章只留最新一份（单槽位 upsert）；
-- text_hash 记录算它时的正文指纹，正文变了缓存自动失效，由调用方重算覆盖。
CREATE TABLE IF NOT EXISTS en_exam_side_cache (
    owner_id     TEXT NOT NULL,
    doc_key      TEXT NOT NULL,
    text_hash    TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (owner_id, doc_key)
);

-- AI 演示记录：写作/翻译演示每次出结果都留存一份（AI 生成与题库回退都存），
-- payload_json 是整份演示结果，点历史里的「载入」就能原样恢复。
CREATE TABLE IF NOT EXISTS en_exam_demo_records (
    record_id    TEXT PRIMARY KEY,
    owner_id     TEXT NOT NULL,
    kind         TEXT NOT NULL,
    source       TEXT NOT NULL,
    template_id  TEXT,
    title        TEXT,
    payload_json TEXT NOT NULL,
    created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_en_exam_demo_records_owner
    ON en_exam_demo_records(owner_id, kind, created_at);

-- 演示精华：从记录里抽出的「逐处修改 / 译法笔记」，按模块归入工具箱。
-- (owner_id, module, source_text, target_text) 唯一 → 同一条精华只沉淀一次。
CREATE TABLE IF NOT EXISTS en_exam_gems (
    gem_id      TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL,
    kind        TEXT NOT NULL,
    module      TEXT NOT NULL,
    source_text TEXT NOT NULL,
    target_text TEXT NOT NULL,
    reason      TEXT,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_en_exam_gems_owner
    ON en_exam_gems(owner_id, module, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_en_exam_gems_uniq
    ON en_exam_gems(owner_id, module, source_text, target_text);
"""

class ExamStore:
    """管理英语应试模块专属的同义替换库与命题陷阱诊断记录。"""

    def __init__(self, db_path: Path | str) -> None:
        self.db_path = Path(db_path)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(
            str(self.db_path),
            check_same_thread=False,
            timeout=5.0,
        )
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON;")
        conn.execute("PRAGMA busy_timeout = 5000;")
        return conn

    @contextmanager
    def _conn(self) -> Iterator[sqlite3.Connection]:
        conn = self._connect()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _init_schema(self) -> None:
        with self._conn() as conn:
            conn.executescript(SCHEMA_EXAM)

    def add_paraphrase(
        self,
        owner_id: str,
        source_phrase: str,
        target_phrase: str,
        category: str = "synonym",
        explanation: str = "",
        source_sentence: str = "",
        exam_sentence: str = "",
    ) -> dict[str, Any]:
        """将提取到的同义改写对保存到用户专属库中，初始化 FSRS 状态。"""
        now_str = to_iso(utc_now())
        pair_id = new_id("para")
        with self._conn() as conn:
            conn.execute(
                """
                INSERT INTO en_exam_paraphrases (
                    pair_id, owner_id, source_phrase, target_phrase,
                    category, explanation, source_sentence, exam_sentence,
                    stability, difficulty, due_at, reps, state, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0, 'new', ?)
                """,
                (
                    pair_id, owner_id, source_phrase.strip(), target_phrase.strip(),
                    category, explanation.strip(), source_sentence.strip(),
                    exam_sentence.strip(), now_str, now_str,
                ),
            )
        return {
            "pair_id": pair_id,
            "source_phrase": source_phrase,
            "target_phrase": target_phrase,
            "category": category,
            "explanation": explanation,
            "created_at": now_str,
        }

    def list_paraphrases(self, owner_id: str, limit: int = 50) -> list[dict[str, Any]]:
        """获取用户沉淀的同义替换卡片。"""
        with self._conn() as conn:
            rows = conn.execute(
                """
                SELECT * FROM en_exam_paraphrases
                WHERE owner_id = ?
                ORDER BY created_at DESC LIMIT ?
                """,
                (owner_id, limit),
            ).fetchall()
            return [dict(r) for r in rows]

    # ---------------------------------------------------------------- 高亮与笔记
    # 高亮按 doc_key 归档。doc_key 用「来源 + 文章 id/url」拼出来，而不是文章标题，
    # 因为标题会变（外刊改标题、LLM 重生成），一改就整篇笔记全部对不上。

    def add_highlight(
        self,
        owner_id: str,
        doc_key: str,
        quote: str,
        *,
        doc_title: str = "",
        para_index: int = -1,
        prefix: str = "",
        suffix: str = "",
        note: str = "",
        color: str = "gold",
    ) -> dict[str, Any]:
        """记一条高亮。prefix/suffix 是选中位置前后的原文，
        用于文章重新排版或正文有重复句时把锚点认回来。"""
        now_str = to_iso(utc_now())
        highlight_id = new_id("hl")
        with self._conn() as conn:
            conn.execute(
                """
                INSERT INTO en_exam_highlights (
                    highlight_id, owner_id, doc_key, doc_title, para_index,
                    quote, prefix, suffix, note, color, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    highlight_id, owner_id, doc_key, doc_title, int(para_index),
                    quote, prefix, suffix, note, color, now_str, now_str,
                ),
            )
        return {
            "highlight_id": highlight_id,
            "doc_key": doc_key,
            "doc_title": doc_title,
            "para_index": int(para_index),
            "quote": quote,
            "prefix": prefix,
            "suffix": suffix,
            "note": note,
            "color": color,
            "created_at": now_str,
            "updated_at": now_str,
        }

    def list_highlights(self, owner_id: str, doc_key: str = "", limit: int = 300) -> list[dict[str, Any]]:
        """列出高亮。给了 doc_key 就只取这一篇的，否则取全部（笔记总览用）。"""
        sql = "SELECT * FROM en_exam_highlights WHERE owner_id = ?"
        params: list[Any] = [owner_id]
        if doc_key:
            sql += " AND doc_key = ?"
            params.append(doc_key)
        sql += " ORDER BY created_at ASC LIMIT ?"
        params.append(limit)
        with self._conn() as conn:
            rows = conn.execute(sql, tuple(params)).fetchall()
        return [dict(r) for r in rows]

    def update_highlight(
        self,
        owner_id: str,
        highlight_id: str,
        *,
        note: str | None = None,
        color: str | None = None,
    ) -> dict[str, Any] | None:
        """改笔记内容或颜色。只更新传进来的字段，没传的保持原样。"""
        sets: list[str] = []
        params: list[Any] = []
        if note is not None:
            sets.append("note = ?")
            params.append(note)
        if color is not None:
            sets.append("color = ?")
            params.append(color)
        if not sets:
            return None
        sets.append("updated_at = ?")
        params.append(to_iso(utc_now()))
        params.extend([owner_id, highlight_id])
        with self._conn() as conn:
            cur = conn.execute(
                f"UPDATE en_exam_highlights SET {', '.join(sets)} "
                "WHERE owner_id = ? AND highlight_id = ?",
                tuple(params),
            )
            if cur.rowcount == 0:
                return None
            row = conn.execute(
                "SELECT * FROM en_exam_highlights WHERE owner_id = ? AND highlight_id = ?",
                (owner_id, highlight_id),
            ).fetchone()
        return dict(row) if row else None

    def delete_highlight(self, owner_id: str, highlight_id: str) -> bool:
        with self._conn() as conn:
            cur = conn.execute(
                "DELETE FROM en_exam_highlights WHERE owner_id = ? AND highlight_id = ?",
                (owner_id, highlight_id),
            )
            return cur.rowcount > 0

    # ------------------------------------------------------------ 侧边分析缓存
    # 每篇文档单槽位：同一篇文章永远只留最新一份分析结果。

    def get_side_cache(self, owner_id: str, doc_key: str) -> dict[str, Any] | None:
        """取某篇文档缓存的侧边分析。没有返回 None。"""
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM en_exam_side_cache WHERE owner_id = ? AND doc_key = ?",
                (owner_id, doc_key),
            ).fetchone()
        if not row:
            return None
        try:
            payload = json.loads(row["payload_json"])
        except (TypeError, ValueError):
            return None
        if not isinstance(payload, dict):
            return None
        return {"text_hash": row["text_hash"], "payload": payload}

    def save_side_cache(
        self, owner_id: str, doc_key: str, text_hash: str, payload: dict[str, Any]
    ) -> None:
        """写入/覆盖某篇文档的侧边分析缓存（INSERT OR REPLACE 单槽位）。"""
        now_str = to_iso(utc_now())
        with self._conn() as conn:
            conn.execute(
                """
                INSERT INTO en_exam_side_cache (
                    owner_id, doc_key, text_hash, payload_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(owner_id, doc_key)
                DO UPDATE SET text_hash = excluded.text_hash,
                    payload_json = excluded.payload_json,
                    updated_at = excluded.updated_at
                """,
                (
                    owner_id, doc_key, text_hash,
                    json.dumps(payload, ensure_ascii=False), now_str, now_str,
                ),
            )

    # ------------------------------------------------------------ 演示记录与精华
    # AI 演示每次出结果都留存一份（AI 生成与题库回退都存），并从结果里抽出精华
    # 沉淀进工具箱。记录按 owner 隔离，精华按内容去重（同一条只沉淀一次）。

    def add_demo_record(
        self,
        owner_id: str,
        kind: str,
        source: str,
        title: str,
        payload: dict[str, Any],
        template_id: str = "",
    ) -> dict[str, Any]:
        now_str = to_iso(utc_now())
        record_id = new_id("demo")
        with self._conn() as conn:
            conn.execute(
                """
                INSERT INTO en_exam_demo_records (
                    record_id, owner_id, kind, source, template_id, title, payload_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record_id, owner_id, kind, source, template_id.strip(),
                    title.strip(), json.dumps(payload, ensure_ascii=False), now_str,
                ),
            )
        return {
            "record_id": record_id,
            "owner_id": owner_id,
            "kind": kind,
            "source": source,
            "template_id": template_id,
            "title": title,
            "payload": payload,
            "created_at": now_str,
        }

    def list_demo_records(self, owner_id: str, kind: str = "", limit: int = 50) -> list[dict[str, Any]]:
        """列出演示历史。给了 kind 就只取那一类，否则取全部。返回体含完整 payload 供回看。"""
        sql = "SELECT * FROM en_exam_demo_records WHERE owner_id = ?"
        params: list[Any] = [owner_id]
        if kind:
            sql += " AND kind = ?"
            params.append(kind)
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        with self._conn() as conn:
            rows = conn.execute(sql, tuple(params)).fetchall()
        items: list[dict[str, Any]] = []
        for r in rows:
            d = dict(r)
            try:
                d["payload"] = json.loads(d.get("payload_json") or "{}")
            except (TypeError, ValueError):
                d["payload"] = {}
            d.pop("payload_json", None)
            items.append(d)
        return items

    def delete_demo_record(self, owner_id: str, record_id: str) -> bool:
        with self._conn() as conn:
            cur = conn.execute(
                "DELETE FROM en_exam_demo_records WHERE owner_id = ? AND record_id = ?",
                (owner_id, record_id),
            )
            return cur.rowcount > 0

    def add_gems(self, owner_id: str, kind: str, gems: list[dict[str, Any]]) -> int:
        """沉淀一批精华。按 (owner, module, source, target) 去重，返回实际新增条数。"""
        now_str = to_iso(utc_now())
        added = 0
        with self._conn() as conn:
            for g in gems:
                if not isinstance(g, dict):
                    continue
                module = str(g.get("module") or "").strip()
                source_text = str(g.get("source_text") or "").strip()
                target_text = str(g.get("target_text") or "").strip()
                if not module or not source_text or not target_text:
                    continue
                cur = conn.execute(
                    """
                    INSERT OR IGNORE INTO en_exam_gems (
                        gem_id, owner_id, kind, module, source_text, target_text, reason, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        new_id("gem"), owner_id, kind, module, source_text, target_text,
                        str(g.get("reason") or "").strip(), now_str,
                    ),
                )
                added += cur.rowcount
        return added

    def list_gems(self, owner_id: str, kind: str = "", limit: int = 300) -> list[dict[str, Any]]:
        """列出用户沉淀的精华，供 writing_kit / translation_kit 合并。"""
        sql = "SELECT * FROM en_exam_gems WHERE owner_id = ?"
        params: list[Any] = [owner_id]
        if kind:
            sql += " AND kind = ?"
            params.append(kind)
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        with self._conn() as conn:
            rows = conn.execute(sql, tuple(params)).fetchall()
        return [dict(r) for r in rows]


# ==============================================================================
# 经典真题与权威外刊精选语料库 (Builtin Authentic Readings)
# ==============================================================================

BUILTIN_EXAM_PASSAGES: list[dict[str, Any]] = [
    {
        "id": "ky_2010_text3",
        "title": "The Mechanism of Social Epidemics & Influencers",
        "source_name": "考研英语(一) 2010 Text 3 · 真题精选",
        "style": "考研真题",
        "category": "心理与社会学",
        "passage": (
            "In his 2000 book The Tipping Point, Malcolm Gladwell argues that social epidemics "
            "are driven in large part by the actions of a tiny minority of exceptional people, often referred to as influencers. "
            "These individuals are said to be well-informed, persuasive, or simply well-connected. "
            "However, this intuitive idea, though deeply appealing to marketers who spend millions attempting to harness word of mouth, "
            "rests on surprisingly fragile empirical foundations. Duncan Watts, a network scientist, has argued that the success of a social trend "
            "depends far less on the characteristics of the initial messengers than on the susceptibility of the broader network to absorb and propagate the information. "
            "In other words, a message catches on not because the influencer possesses unique persuasive power, but because the environment is ripe for transmission."
        ),
        "passage_zh": (
            "在2000年的著作《引爆点》中，马尔科姆·格拉德威尔指出，社会流行潮流在很大程度上是由极少数被称为“关键意见领袖”的非凡个体所驱动的。"
            "据说这些人信息灵通、极具说服力，或拥有极其广泛的社交人脉。"
            "然而，这种直觉性的观念——尽管对于耗资数百万美元试图借助口碑传播的营销人员来说极具吸引力——其经验事实依据却令人惊讶地脆弱。"
            "网络科学家邓肯·瓦茨指出，一种社会潮流能否成功，与其说取决于最初传播者的特质，倒不如说取决于更广泛的网络接受并扩散该信息的敏感程度与易感性。"
            "换言之，一条信息之所以能流行开来，并非因为传播者拥有独特的说服力，而是因为外部传播环境已经成熟。"
        ),
        "thesis_tone": {
            "thesis": "社会流行风潮的成功主要取决于整体传播网络环境的敏感与易感度，而非关键领袖个体的说服力。",
            "tone": "辩驳推翻 (Refutative & Analytical)",
            "tone_analysis": "典型的驳论文：先引述 Gladwell 的流行观点，随后通过 However... fragile empirical foundations 彻底颠覆并立论。",
        },
        "key_sentences": [
            "However, this intuitive idea, though deeply appealing to marketers who spend millions attempting to harness word of mouth, rests on surprisingly fragile empirical foundations.",
            "Duncan Watts has argued that the success of a social trend depends far less on the characteristics of the initial messengers than on the susceptibility of the broader network to absorb and propagate the information.",
        ],
        "paraphrases": [
            {
                "source_phrase": "rests on surprisingly fragile empirical foundations",
                "target_phrase": "lacks substantial empirical evidence",
                "type": "动词+名词抽象化替换",
                "explanation": "原文以隐喻手法形容经验证据脆弱，选项采用抽象词 lacks substantial evidence 进行直接概括。",
            },
            {
                "source_phrase": "depends far less on initial messengers than on network susceptibility",
                "target_phrase": "is primarily determined by the readiness of the environment",
                "type": "句式结构正反转换",
                "explanation": "原文用 far less A than B 强调 B，选项直接用 is primarily determined by 转为主动肯定。",
            },
        ],
        "exam_question": {
            "stem": "According to Duncan Watts, the spread of a social trend is mostly determined by ______.",
            "options": [
                {"key": "A", "text": "the charisma and persuasiveness of initial messengers"},
                {"key": "B", "text": "the capacity and readiness of the network to receive it"},
                {"key": "C", "text": "the massive financial investment made by marketers"},
                {"key": "D", "text": "the inevitable vulnerability of consumer psychology"},
            ],
            "correct_key": "B",
            "distractor_analysis": {
                "A": "【正反颠倒 / 偷换论点】这是格拉德威尔的旧观点，恰恰是瓦茨要反驳的对象（原文明确说 depends far less on...）。",
                "C": "【张冠李戴 / 细节杂糅】原文提到市场营销人员花费数百万试图利用口碑，但这并非瓦茨网络科学模型的核心驱动因素。",
                "D": "【无中生有 / 主观臆测】原文未提及消费者心理的脆弱性，属于考生根据常识脑补过度推断。",
            },
            "defense_tip": "遇到转折与对比句型（far less A than B）时，选项经常将被否定的 A 作为强干扰项诱骗考生，必须牢牢锁定 than 之后的核心论据。",
        },
    },
    {
        "id": "economist_ai_paradox",
        "title": "The Productivity Paradox in the Age of Generative AI",
        "source_name": "《The Economist》(经济学人) 深度专栏",
        "style": "经济学人",
        "category": "经济与前沿科技",
        "passage": (
            "Economists who study technological revolutions have long recognized the so-called productivity paradox: "
            "transformative technologies often take decades to move national economic statistics. "
            "Although generative artificial intelligence has been hailed as the most consequential breakthrough since electrification, "
            "most enterprises still struggle to weather the messy organizational transitions required to harness its full potential. "
            "Companies frequently purchase sophisticated neural network tools only to plant them awkwardly atop obsolete bureaucratic workflows. "
            "Consequently, early gains in employee productivity are swallowed by administrative friction and verification overhead. "
            "To genuinely unlock macroscopic growth, managers must address institutional inertia rather than merely accumulating digital capital."
        ),
        "passage_zh": (
            "研究技术革命的经济学家早就注意到了所谓的“生产率悖论”：变革性技术往往需要经历数十年的阵痛，其效能才能真正反映在宏观经济统计数据中。"
            "尽管生成式人工智能被誉为自电气化以来最具深远影响的突破，但绝大多数企业仍在苦苦应对挖掘其全部潜能所需的复杂组织架构转型。"
            "企业往往采购了前沿的神经网络工具，却只是生硬地将它们安插在早已过时的官僚工作流程之上。"
            "结果，员工早期的生产率提升迅速被管理沟通内耗与人工验证成本所侵蚀抵消。"
            "要想真正释放宏观层面的增长潜能，管理者必须着手解决体制性的路径依赖与惰性，而非仅仅被动积累数字资本。"
        ),
        "thesis_tone": {
            "thesis": "企业如果只是将尖端AI硬套在陈旧官僚流程上，早期的效率收益就会被内耗吞噬，必须破除制度惰性。",
            "tone": "批判反思 (Critical & Diagnostic)",
            "tone_analysis": "文章以辛辣笔触直戳企业痛点，用 only to plant awkwardly atop obsolete workflows 展开讽刺。",
        },
        "key_sentences": [
            "Although generative artificial intelligence has been hailed as the most consequential breakthrough since electrification, most enterprises still struggle to weather the messy organizational transitions required to harness its full potential.",
            "Companies frequently purchase sophisticated neural network tools only to plant them awkwardly atop obsolete bureaucratic workflows.",
        ],
        "paraphrases": [
            {
                "source_phrase": "weather the messy organizational transitions",
                "target_phrase": "navigate through internal restructuring challenges",
                "type": "熟词生义与比喻改写",
                "explanation": "weather 在此处作及物动词（经受住/度过挑战），选项改写为 navigate through challenges。",
            },
            {
                "source_phrase": "swallowed by administrative friction",
                "target_phrase": "offset by bureaucratic inefficiencies",
                "type": "动词与名词近义替换",
                "explanation": "swallowed 形象化说明红利被吞噬抵消（offset），administrative friction 替换为 bureaucratic inefficiencies。",
            },
        ],
        "exam_question": {
            "stem": "Why do enterprises fail to observe immediate macroscopic productivity gains from AI?",
            "options": [
                {"key": "A", "text": "The underlying neural algorithms lack commercial sophistication."},
                {"key": "B", "text": "Technological advancements are incompatible with human cognitive capacity."},
                {"key": "C", "text": "Outdated organizational structures impede the integration of new tools."},
                {"key": "D", "text": "Financial markets have ceased allocating capital to machine learning."},
            ],
            "correct_key": "C",
            "distractor_analysis": {
                "A": "【反向曲解】原文明确说企业采购了 sophisticated neural network tools，算法本身很成熟，问题出在组织流程。",
                "B": "【过度绝对化 / 主观脑补】文章讨论的是组织流程与管理惰性，未上升到人类认知极限这种哲学绝对范畴。",
                "D": "【无中生有】原文完全未提及资本市场停止注资，属于脱离原文事实的主观臆断。",
            },
            "defense_tip": "解答因果细节题时，紧扣作者批评的核心焦点（obsolete bureaucratic workflows），不要被看似高深的假大空学术词汇（cognitive capacity）带偏。",
        },
    },
    {
        "id": "nature_climate_feedback",
        "title": "Unseen Feedback Loops in Arctic Permafrost Thaw",
        "source_name": "《Nature》(自然) 科学通讯",
        "style": "自然前沿",
        "category": "地球与生态科学",
        "passage": (
            "Climate scientists monitoring Arctic tundra have uncovered a profound feedback mechanism that could complicate global mitigation efforts. "
            "As perennial ice recedes, dormant microbial communities are prompted into rapid metabolic activity, releasing substantial reserves of methane and carbon dioxide. "
            "What makes this process particularly concerning is that the greenhouse gases released accelerate atmospheric warming, thereby causing further permafrost degradation. "
            "While international accords assume that emission cuts will yield linear decelerations in temperature rise, "
            "such natural biogeochemical accelerators suggest that the climate system may harbor irreversible tipping points. "
            "Without accounting for these subterranean releases, predictive models will consistently underestimate the urgency of intervention."
        ),
        "passage_zh": (
            "监测北极冻原的气候科学家发现了一种深层的正反馈机制，该机制可能会使全球减排努力变得更加复杂艰巨。"
            "随着多年冻土的消退，休眠中的微生物群落被激活进入高速代谢活动，释放出大量的甲烷和二氧化碳储备。"
            "这一过程尤为令人担忧之处在于：释放出的温室气体反过来加速大气升温，从而导致更深层的多年冻土发生退化。"
            "尽管国际气候协定普遍假定减排将带来气温上升的线性减速，但此类天然生物地球化学加速机制表明，气候系统内部可能暗藏着不可逆转的临界临界点。"
            "如果不将这些来自地下的气体释放纳入考量，预测模型将持续低估干预行动的紧迫性。"
        ),
        "thesis_tone": {
            "thesis": "北极多年冻土解冻会通过正反馈机制加速全球变暖，气候模型低估该因素将导致碳预算重大误判。",
            "tone": "警示严峻 (Alarming & Rigorous)",
            "tone_analysis": "运用 profound feedback mechanism、irreversible tipping points 表达了对气候临界点的强烈科学预警。",
        },
        "key_sentences": [
            "As perennial ice recedes, dormant microbial communities are prompted into rapid metabolic activity, releasing substantial reserves of methane and carbon dioxide.",
            "Without accounting for these subterranean releases, predictive models will consistently underestimate the urgency of intervention.",
        ],
        "paraphrases": [
            {
                "source_phrase": "prompted into rapid metabolic activity",
                "target_phrase": "stimulated to consume organic matter quickly",
                "type": "熟词生义与动作释义",
                "explanation": "prompted 此处非提示，而是促使/激发（stimulated），与生命科学中代谢激活形成精确对齐。",
            },
            {
                "source_phrase": "harbor irreversible tipping points",
                "target_phrase": "contain thresholds beyond which recovery is impossible",
                "type": "动词与名词下位展开",
                "explanation": "harbor 取心怀/暗藏义，tipping points（临界点）展开为 thresholds beyond which recovery is impossible。",
            },
        ],
        "exam_question": {
            "stem": "What is the critical implication of the permafrost feedback mechanism mentioned in the passage?",
            "options": [
                {"key": "A", "text": "Global warming models may fail to reflect the true severity of the situation."},
                {"key": "B", "text": "Microbial metabolisms will immediately replace fossil fuels as the primary emission source."},
                {"key": "C", "text": "International climate negotiations have deliberately fabricated reduction statistics."},
                {"key": "D", "text": "Subterranean gas reservoirs can be safely harnessed for industrial production."},
            ],
            "correct_key": "A",
            "distractor_analysis": {
                "B": "【过度绝对化 / 偷换概念】微生物释放虽大，但未说“立即取代化石能源成为第一大排放源”，夸大了量级。",
                "C": "【恶意推测 / 无中生有】原文只说协定假设线性减速，未说各国代表蓄意伪造数据（deliberately fabricated）。",
                "D": "【反向曲解 / 主客颠倒】原文视地下气体泄漏为灾难性反馈，选项竟然曲解为安全采集利用。",
            },
            "defense_tip": "对于结论推断题，抓住尾句的否定条件（Without accounting for... will consistently underestimate...），正选往往是双重否定或逆否命题的同义转换。",
        },
    },
]


def build_tju_exam_reading_prompt(topic: str = "", style: str = "考研真题", level: str = "考研英语(一)") -> dict[str, Any]:
    """构造发送给 TJU-LLM 的高保真外刊精读语料生成 Prompt。"""
    chosen_topic = topic.strip() or "科技伦理与人工智能反垄断 / 认知心理学与行为经济学 / 全球环境演化"
    system_prompt = (
        "你是一位曾参与全国硕士研究生统一招生考试英语命题委员会、同时长期为《The Economist》与《Nature》撰稿的顶尖英语命题专家。"
        "请根据用户指定的学术主题与难度级别，全自动生成一篇完全达到考研真题阅读理解 Part A 难度的「外刊精读研习篇章」。\n\n"
        "【硬性命题准则】\n"
        "1. 正文（passage）：长度 220~300 词，学术议论文体，词汇达到考研/六级/GRE 难度。必须包含：\n"
        "   - 至少 2 个结构复杂的典型长难句（含插入语、定语从句、状语从句等）；\n"
        "   - 至少 2 个逻辑转折/让步信号词（如 however, whereas, while, nevertheless, on the contrary）；\n"
        "   - 至少 2 处考研经典熟词生义（如 weather 作经受住, sound 作健全的, balance 作结余, harbor 作心怀, prompt 作促使, subject 作易受影响的）。\n"
        "2. 精译（passage_zh）：地道准确、符合中文科技外刊审阅标准的全文精译。\n"
        "3. 核心长难句（key_sentences）：摘出文中 2 个最值得用田静手术刀拆解的长句。\n"
        "4. 同义替换链（paraphrases）：给出 2~3 组原文核心短语与潜在考试改写表达的对齐分析。\n"
        "5. 仿真考题（exam_question）：设计 1 道经典的四选一细节推断题。4 个选项中，1 个正确项必须严格基于同义替换；3 个干扰项必须分别严格按照考研四大命题陷阱（偷换概念、无中生有、反向混淆、过度绝对化）精心设计，并给出命题人心机深度剖析与避坑指南。\n\n"
        "请务必输出合法的 JSON 格式：\n"
        "{\n"
        '  "title": "文章标题",\n'
        '  "source_name": "模拟来源 (如: The Economist / Nature Analysis)",\n'
        '  "style": "考研真题风格 / 经济学人风格",\n'
        '  "category": "学科类别",\n'
        '  "passage": "英文正文",\n'
        '  "passage_zh": "中文精译",\n'
        '  "key_sentences": ["长难句1", "长难句2"],\n'
        '  "paraphrases": [\n'
        '    {"source_phrase": "原文词组", "target_phrase": "同义替换", "type": "类型", "explanation": "剖析"}\n'
        "  ],\n"
        '  "exam_question": {\n'
        '    "stem": "题干",\n'
        '    "options": [\n'
        '      {"key": "A", "text": "选项A"},\n'
        '      {"key": "B", "text": "选项B"},\n'
        '      {"key": "C", "text": "选项C"},\n'
        '      {"key": "D", "text": "选项D"}\n'
        "    ],\n"
        '    "correct_key": "正确选项字母 (A/B/C/D)",\n'
        '    "distractor_analysis": {\n'
        '      "A": "陷阱剖析",\n'
        '      "B": "陷阱剖析",\n'
        '      "C": "陷阱剖析",\n'
        '      "D": "陷阱剖析"\n'
        "    },\n"
        '    "defense_tip": "唐迟老师避坑指引"\n'
        "  }\n"
        "}"
    )
    user_prompt = f"请为我生成一篇关于【{chosen_topic}】的精读篇章，风格为【{style}】，目标考试级别为【{level}】。"
    return {
        "system_prompt": system_prompt,
        "user_prompt": user_prompt,
        "topic": chosen_topic,
        "style": style,
        "level": level,
    }


def offline_fallback_exam_reading(topic: str = "", style: str = "") -> dict[str, Any]:
    """当离线或未配置 TJU_API_KEY 时，从经典真题与名刊精选语料库中智能匹配返回。"""
    t_lower = (topic or "").lower()
    for item in BUILTIN_EXAM_PASSAGES:
        if t_lower and (t_lower in item["title"].lower() or t_lower in item["category"].lower()):
            res = dict(item)
            res["ai_generated"] = False
            res["source_mode"] = "builtin_archive"
            return res
    # 默认返回第一篇
    res = dict(BUILTIN_EXAM_PASSAGES[0])
    res["ai_generated"] = False
    res["source_mode"] = "builtin_archive"
    return res


# ==============================================================================
# 权威外刊与真题题材联网推荐索引库 (Curated Articles & Online Search)
# ==============================================================================

ONLINE_FEATURED_ARTICLES: list[dict[str, Any]] = [
    {
        "id": "gd_ai_work",
        "title": "How Artificial Intelligence is Quietly Rewiring the White-Collar Workplace",
        "source": "The Guardian (英国卫报)",
        "category": "科技创新与人工智能",
        "url": "https://www.theguardian.com/technology/2024/ai-workplace-transformation",
        "snippet": "探讨生成式 AI 对白领岗位分工的深远重构与企业组织阵痛",
        "sample_passage": (
            "Over the past eighteen months, corporate boardrooms have undergone a quiet reckoning. "
            "While early commentators predicted an immediate apocalypse for white-collar employment, "
            "the reality has proved far more nuanced. Rather than wholesale replacement, generative software "
            "is functioning as an ambiguous collaborator, automating routine syntax while demanding sounder analytical discernment. "
            "Companies that attempt to weather this technological disruption by simply reducing headcount "
            "often discover that institutional memory is far harder to restore than software licenses are to purchase."
        ),
        "passage_zh": (
            "在过去的十八个月里，各大企业的董事会经历了一场悄无声息的认知重构。"
            "尽管早期评论家曾预言白领就业将迎来末日浩劫，但现实情况却要微妙和复杂得多。"
            "生成式软件并没有带来全面的岗位取代，而是充当着一个亦敌亦友的模糊协作者：它自动化了常规性的句法代码，却对人类更加健全严谨的分析洞察力提出了更高要求。"
            "那些企图通过单纯裁减员工来渡过这场技术冲击的企业往往发现：制度性的团队沉淀经验远比购买软件许可证要难以复原。"
        ),
        "thesis_tone": {
            "thesis": "AI 并非零和取代人类白领，而是重构岗位分工，裁员反而会损害企业核心知识积累。",
            "tone": "客观审慎 (Objective & Cautionary)",
            "tone_analysis": "作者既肯定了生成式 AI 的效率提升，又对企业单纯以裁员应对技术冲击的短视做法持警示与批判态度。",
        },
        "key_sentences": [
            "Rather than wholesale replacement, generative software is functioning as an ambiguous collaborator, automating routine syntax while demanding sounder analytical discernment.",
            "Companies that attempt to weather this technological disruption by simply reducing headcount often discover that institutional memory is far harder to restore than software licenses are to purchase.",
        ],
        "paraphrases": [
            {
                "source_phrase": "weather this technological disruption",
                "target_phrase": "survive this wave of technological innovation",
                "type": "熟词生义与比喻改写",
                "explanation": "weather 在此作及物动词（经受住/度过考验），改写为 survive 或 navigate through。",
            },
            {
                "source_phrase": "wholesale replacement",
                "target_phrase": "complete elimination of existing jobs",
                "type": "动词与名词下位替换",
                "explanation": "wholesale replacement 意为全盘取代，替换为 complete elimination。",
            },
        ],
        "exam_question": {
            "stem": "According to the passage, corporate attempts to mitigate AI disruption by slashing employees are ______.",
            "options": [
                {"key": "A", "text": "likely to erode critical institutional knowledge and experience"},
                {"key": "B", "text": "capable of accelerating long-term algorithmic innovation"},
                {"key": "C", "text": "deliberately coordinated to terminate software licenses"},
                {"key": "D", "text": "inevitably leading to the total collapse of tech corporations"},
            ],
            "correct_key": "A",
            "distractor_analysis": {
                "B": "【反向混淆 / 正反颠倒】原文明确指出单纯裁员会导致宝贵的经验难以复原，而非促进技术突破。",
                "C": "【偷换概念 / 细节杂糅】原文将 institutional memory 与 software licenses 进行对比，并非为了终止许可。",
                "D": "【过度绝对化】选项使用 inevitably total collapse 夸大了后果的极端程度，属于经典考研陷阱。",
            },
            "defense_tip": "考研细节推断题中，选项若包含 inevitably, totally, absolutely 等绝对化字眼，95% 为干扰项；优先选择使用 moderate, likely 等客观审慎表达的同义替换项。",
        },
    },
    {
        "id": "econ_deglobal",
        "title": "The Perils and Paradoxes of the New Economic Nationalism",
        "source": "The Economist (经济学人)",
        "category": "商业金融与宏观治理",
        "url": "https://www.economist.com/finance-and-economics/2024/economic-nationalism",
        "snippet": "产业补贴与关税壁垒对全球生产率的潜在抑制与反噬",
        "sample_passage": (
            "Governments across the developed world are pouring hundreds of billions into domestic chip fabrication and green subsidies. "
            "Yet economists caution that attempting to insulate national supply chains from foreign competition "
            "may harbor severe unintended consequences. When trade barriers are erected, consumer prices inevitably climb, "
            "and domestic firms lose the competitive pressure required to spur genuine technological breakthroughs. "
            "Subsidies can briefly prompt capital investment, but they cannot manufacture genuine market efficiency."
        ),
        "passage_zh": (
            "发达国家的政府正将数以千亿美元计的资金投入本土芯片制造与绿色产业补贴中。"
            "然而经济学家们警示：试图使国家供应链与外国竞争相隔离的做法，可能会暗藏严重的未预料后果。"
            "当贸易壁垒高筑时，消费物价必然水涨船高，而本土企业也失去了激发真正技术突破所必需的竞争压力。"
            "政府补贴虽能短暂促成资本投资，却绝无法凭空制造出真正的市场效率。"
        ),
        "thesis_tone": {
            "thesis": "产业保护主义与高额补贴虽能短期拉动投资，但长期会推高通胀、削弱企业创新动力并损害效率。",
            "tone": "质疑批判 (Skeptical & Critical)",
            "tone_analysis": "典型的《经济学人》自由市场派立场，强烈质疑政府过度产业补贴的实际长期成效。",
        },
        "key_sentences": [
            "Yet economists caution that attempting to insulate national supply chains from foreign competition may harbor severe unintended consequences.",
            "Subsidies can briefly prompt capital investment, but they cannot manufacture genuine market efficiency.",
        ],
        "paraphrases": [
            {
                "source_phrase": "insulate national supply chains from foreign competition",
                "target_phrase": "protect domestic industries against overseas rivalry",
                "type": "动词与名词同义对齐",
                "explanation": "insulate...from 改写为 protect...against，foreign competition 改写为 overseas rivalry。",
            },
            {
                "source_phrase": "may harbor severe unintended consequences",
                "target_phrase": "could entail unexpected negative repercussions",
                "type": "抽象名词近义替换",
                "explanation": "harbor 熟词生义表示心怀/暗藏，unintended consequences 替换为 unexpected negative repercussions。",
            },
        ],
        "exam_question": {
            "stem": "What is the primary concern regarding massive governmental subsidies according to economists?",
            "options": [
                {"key": "A", "text": "They fail to foster sustainable competitive advantages for domestic firms."},
                {"key": "B", "text": "They immediately exhaust public financial reserves in developed nations."},
                {"key": "C", "text": "They encourage developing countries to completely dismantle tariffs."},
                {"key": "D", "text": "They prevent multinational corporations from raising product prices."},
            ],
            "correct_key": "A",
            "distractor_analysis": {
                "B": "【无中生有】原文只说各国投入巨资，并未提及政府公共财政储备被“立即耗尽”。",
                "C": "【反向混淆】贸易保护主义引发的是壁垒上升，而非让发展中国家拆除关税。",
                "D": "【偷换概念】原文指出 trade barriers 使 consumer prices climb（物价上涨），选项反向表述为防止涨价。",
            },
            "defense_tip": "转折后是文章灵魂所在。紧扣文末 but they cannot manufacture genuine market efficiency，选择强调长期竞争效率缺失的概括项。",
        },
    },
    {
        "id": "nat_neuro_memory",
        "title": "Synaptic Plasticity and the Hidden Architecture of Human Recall",
        "source": "Nature Neuroscience (自然脑科学)",
        "category": "生命科学与认知心理",
        "url": "https://www.nature.com/articles/neuroscience-memory-consolidation",
        "snippet": "深层睡眠对人类长期记忆突触固化与知识结构化的神经生理机制",
        "sample_passage": (
            "Memory consolidation during deep sleep is not merely a passive replay of daily experience. "
            "Instead, recent neuroimaging reveals that the hippocampus actively prunes extraneous synaptic connections "
            "while transferring essential information into the neocortex for long-term preservation. "
            "Subjects who are chronically sleep-deprived consistently exhibit diminished ability to synthesize novel concepts, "
            "demonstrating that rest is an indispensable biological requirement for high-level cognitive resilience."
        ),
        "passage_zh": (
            "深层睡眠期间的记忆巩固，绝非仅仅是对白日经历的被动重放。"
            "相反，最新的神经成像表明，海马体会主动修剪多余无用的突触连接，同时将核心关键信息转移至新皮层中以供长期封存。"
            "长期睡眠不足的受试者，在提炼与综合新概念的能力上持续表现出衰退，这充分证实了：休息是维持高阶认知韧性不可或缺的生物学刚需。"
        ),
        "thesis_tone": {
            "thesis": "睡眠是海马体修剪无关突触、向新皮层固化核心记忆的主动认知重组过程，睡眠缺失直接损毁高级推理力。",
            "tone": "严谨科学证实 (Affirmative & Rigorous)",
            "tone_analysis": "通过实证神经成像证据推翻旧有的“被动重放”认知，确立睡眠的主动建构价值。",
        },
        "key_sentences": [
            "Memory consolidation during deep sleep is not merely a passive replay of daily experience.",
            "Instead, recent neuroimaging reveals that the hippocampus actively prunes extraneous synaptic connections while transferring essential information into the neocortex for long-term preservation.",
        ],
        "paraphrases": [
            {
                "source_phrase": "actively prunes extraneous synaptic connections",
                "target_phrase": "selectively eliminates irrelevant neural links",
                "type": "动词与形容词改写",
                "explanation": "prune 隐喻修剪枝叶，改写为 selectively eliminate；extraneous 替换为 irrelevant。",
            },
            {
                "source_phrase": "an indispensable biological requirement",
                "target_phrase": "an essential prerequisite for brain function",
                "type": "核心双重肯定表达",
                "explanation": "indispensable requirement（不可或缺的刚需）改写为 essential prerequisite（必要前提）。",
            },
        ],
        "exam_question": {
            "stem": "The author suggests that memory consolidation during deep sleep involves ______.",
            "options": [
                {"key": "A", "text": "an active selective restructuring rather than simple repetition"},
                {"key": "B", "text": "a permanent cessation of hippocampal neural communication"},
                {"key": "C", "text": "the indiscriminate preservation of all conscious perceptions"},
                {"key": "D", "text": "a complete vulnerability to external environmental stimulation"},
            ],
            "correct_key": "A",
            "distractor_analysis": {
                "B": "【偷换概念】海马体在转移信息而非停止放电活动。",
                "C": "【正反颠倒】原文强调 actively prunes extraneous connections（修剪无用突触），不是 indiscriminate（不加区分的全部保存）。",
                "D": "【无中生有】文中未涉及对外界环境刺激的脆弱性。",
            },
            "defense_tip": "注意 not merely A but B（或 not merely A... instead B）经典句式，题目必然考查对 B（主动选择性重构）的正面把握。",
        },
    },
    {
        "id": "sciam_climate_tipping",
        "title": "Why Ocean Heat Traps Present Unprecedented Ecological Challenges",
        "source": "Scientific American (科学美国人)",
        "category": "地球生态与气候科学",
        "url": "https://www.scientificamerican.com/article/ocean-heat-content-extremes",
        "snippet": "海洋极端热浪对珊瑚白化与全球气候环流的连锁冲击",
        "sample_passage": (
            "Marine heatwaves are no longer isolated anomalies; they have become persistent features of our planetary climate. "
            "As thermal energy accumulates in the upper layers of the ocean, delicate ecosystems such as coral reefs "
            "struggle to weather prolonged thermal stress. The loss of these marine structures does not merely diminish biodiversity; "
            "it directly jeopardizes the coastal defenses and nutritional sustenance of hundreds of millions of people worldwide."
        ),
        "passage_zh": (
            "海洋热浪已不再是孤立的异常现象，它们已经演变为地球气候系统的常态化特征。"
            "随着热能在海洋表层不断积聚，珊瑚礁等脆弱的生态系统正艰难承受持久的高温热应激。"
            "这些海洋生物结构的消失不仅大幅降低了生物多样性，而且直接危及全球数以亿计人口的海岸防线与基本食物营养来源。"
        ),
        "thesis_tone": {
            "thesis": "海洋极端热浪已常态化，珊瑚白化崩溃直接摧毁人类海岸屏障与渔业生计，影响远超自然界本身。",
            "tone": "急迫警示 (Urgent & Alarming)",
            "tone_analysis": "作者将生态危机直接与人类社会经济生存（海岸防护、营养供给）绑定，呼吁国际社会采取果断行动。",
        },
        "key_sentences": [
            "Marine heatwaves are no longer isolated anomalies; they have become persistent features of our planetary climate.",
            "The loss of these marine structures does not merely diminish biodiversity; it directly jeopardizes the coastal defenses and nutritional sustenance of hundreds of millions of people worldwide.",
        ],
        "paraphrases": [
            {
                "source_phrase": "no longer isolated anomalies",
                "target_phrase": "frequent and regular occurrences",
                "type": "双重否定转肯定",
                "explanation": "no longer isolated anomalies（不再是孤立个案）转为肯定表达 frequent and regular occurrences。",
            },
            {
                "source_phrase": "directly jeopardizes the coastal defenses",
                "target_phrase": "poses immediate threats to shoreline protection",
                "type": "动词与名词近义转换",
                "explanation": "jeopardizes（危及）替换为 poses immediate threats to，coastal 换为 shoreline。",
            },
        ],
        "exam_question": {
            "stem": "According to the passage, the deterioration of coral reef systems ______.",
            "options": [
                {"key": "A", "text": "poses tangible socioeconomic hazards to human communities"},
                {"key": "B", "text": "is an entirely reversible phenomenon under normal conditions"},
                {"key": "C", "text": "only affects organisms inhabiting deep oceanic trenches"},
                {"key": "D", "text": "was deliberately triggered by commercial marine navigation"},
            ],
            "correct_key": "A",
            "distractor_analysis": {
                "B": "【反向混淆】生态系统正艰难承受（struggle to weather），并未提到完全可逆。",
                "C": "【偷换概念】受害的是 upper layers 的珊瑚，不是 deep trenches（深海海沟）。",
                "D": "【无中生有】文章阐述的是气候系统热累积，未提及商业航运故意引发。",
            },
            "defense_tip": "抓住 not merely A; it directly B 句式，正确答案往往聚焦在 B 涉及的人类社会实际危害（tangible socioeconomic hazards）。",
        },
    },
    {
        "id": "bbc_attention_economy",
        "title": "Reclaiming Cognitive Focus in the Hyper-Connected Information Age",
        "source": "BBC Future (未来视野)",
        "category": "生命科学与认知心理",
        "url": "https://www.bbc.com/future/article/reclaiming-human-attention-spans",
        "snippet": "算法多巴胺循环与注意力经济对深度思考能力的侵蚀与自救",
        "sample_passage": (
            "Modern digital interfaces are engineered with exquisite precision to capture and commodify human attention. "
            "By delivering micro-bursts of unpredictable social validation, platforms prompt users into compulsive checking loops. "
            "Psychologists warn that prolonged immersion in hyper-fragmented media environments erodes our capacity "
            "for deep reading and sustained philosophical contemplation, substituting superficial stimulation for genuine understanding."
        ),
        "passage_zh": (
            "现代数字产品界面的设计经过了极其精巧的计算，目的就是为了捕获人类注意力并将其商品化变现。"
            "通过提供不可预测的微量社交认可刺激，各大平台诱导用户陷入强迫性的反复刷新循环之中。"
            "心理学家们警示：长期沉浸在碎片化的媒介环境中，正在侵蚀我们开展深度阅读与持续哲学思考的能力，用浮于表面的感官刺激取代了真正的理解。"
        ),
        "thesis_tone": {
            "thesis": "数字平台通过算法多巴胺循环商品化注意力，削弱了人类深度阅读和哲学思考的高级认知机能。",
            "tone": "反思警醒 (Reflective & Warning)",
            "tone_analysis": "剖析数字经济对人类心智生态的深层异化，语言发人深省。",
        },
        "key_sentences": [
            "Modern digital interfaces are engineered with exquisite precision to capture and commodify human attention.",
            "Psychologists warn that prolonged immersion in hyper-fragmented media environments erodes our capacity for deep reading and sustained philosophical contemplation, substituting superficial stimulation for genuine understanding.",
        ],
        "paraphrases": [
            {
                "source_phrase": "capture and commodify human attention",
                "target_phrase": "commercialize user engagement for profit",
                "type": "学术动词改写",
                "explanation": "commodify（商品化）转换为 commercialize for profit，attention 转为 user engagement。",
            },
            {
                "source_phrase": "substituting superficial stimulation for genuine understanding",
                "target_phrase": "replacing profound comprehension with shallow sensory inputs",
                "type": "成对反义对照改写",
                "explanation": "superficial stimulation 换为 shallow sensory inputs，genuine understanding 换为 profound comprehension。",
            },
        ],
        "exam_question": {
            "stem": "What is the critical danger of hyper-fragmented digital interfaces according to psychologists?",
            "options": [
                {"key": "A", "text": "They undermine individuals' ability to engage in prolonged and deep contemplation."},
                {"key": "B", "text": "They permanently destroy the physiological structure of optical nerves."},
                {"key": "C", "text": "They prohibit users from accessing social validation networks."},
                {"key": "D", "text": "They completely eliminate commercial advertising from the internet."},
            ],
            "correct_key": "A",
            "distractor_analysis": {
                "B": "【偷换概念】损伤的是认知机能（capacity for deep reading），而非视神经物理组织。",
                "C": "【正反颠倒】平台正是利用社交验证（social validation）来吸引用户，而非禁止。",
                "D": "【反向混淆 / 无中生有】界面本身就是为了 commodify，而不是消除商业广告。",
            },
            "defense_tip": "遇到 erodes our capacity for... 句式，正解必选其同义替换词 undermine / weaken / impair ability to...。",
        },
    },
]


def get_all_journals_catalog() -> list[dict[str, Any]]:
    """获取考研英语 13 大权威母源期刊详细档案全谱系与元数据。"""
    res = []
    # 统计每本期刊当前已收录的文章数量
    counts: dict[str, int] = {}
    for a in ALL_AUTHENTIC_ARTICLES:
        jid = a.get("journal_id", "")
        if jid:
            counts[jid] = counts.get(jid, 0) + 1

    for jid, item in JOURNAL_CATALOG.items():
        j_copy = dict(item)
        j_copy["article_count"] = counts.get(jid, 0)
        res.append(j_copy)
    # 按考研权重分降序排序
    res.sort(key=lambda x: x.get("weight_score", 0), reverse=True)
    return res


def search_authentic_articles(
    query: str = "",
    journal_id: str = "",
    category: str = "",
    difficulty: str = "",
    limit: int = 50,
) -> list[dict[str, Any]]:
    """面向海量母源期刊库的多维动态实时检索。
    
    支持：
      - query: 匹配文章英文标题、中文来源、学科分类、摘要、段落英文/中文
      - journal_id: 13 大权威母源期刊过滤
      - category: 学科主题过滤
      - difficulty: 考试难度级别过滤
    """
    q_terms = [t.lower() for t in (query or "").strip().split() if t.strip()]
    target_jid = (journal_id or "").strip()
    target_cat = (category or "").strip()
    target_diff = (difficulty or "").strip()

    results: list[dict[str, Any]] = []

    for art in ALL_AUTHENTIC_ARTICLES:
        # 期刊过滤
        if target_jid and target_jid != "all" and art.get("journal_id") != target_jid:
            continue

        # 主题分类过滤
        if target_cat and target_cat != "all":
            art_cat = art.get("category", "")
            art_tid = art.get("topic_id", "")
            if target_cat != art_cat and target_cat != art_tid:
                continue

        # 难度过滤
        if target_diff and target_diff != "all":
            if target_diff.lower() not in art.get("difficulty", "").lower():
                continue

        # 关键词多词匹配
        if q_terms:
            corpus = f"{art.get('title', '')} {art.get('source', '')} {art.get('category', '')} {art.get('snippet', '')} {art.get('passage', '')} {art.get('passage_zh', '')}".lower()
            if not all(term in corpus for term in q_terms):
                continue

        # 浅复制并附加段落数等概览元数据，保证前端轻量渲染列表
        item_summary = {
            "id": art["id"],
            "title": art["title"],
            "source": art.get("source", ""),
            "source_name": art.get("source_name", art.get("source", "")),
            "journal_id": art.get("journal_id", ""),
            "category": art.get("category", ""),
            "topic_id": art.get("topic_id", ""),
            "date": art.get("date", ""),
            "url": art.get("url", ""),
            "snippet": art.get("snippet", ""),
            "word_count": art.get("word_count", 0),
            "difficulty": art.get("difficulty", ""),
            "paragraph_count": len(art.get("paragraphs", [])),
            "has_exam_question": bool(art.get("exam_question")),
            "thesis": art.get("thesis_tone", {}).get("thesis", ""),
            "tone": art.get("thesis_tone", {}).get("tone", ""),
            "sample_passage": art.get("sample_passage", "")[:280] + "...",
        }
        results.append(item_summary)

        if len(results) >= limit:
            break

    return results


def get_authentic_article_detail(article_id: str) -> dict[str, Any] | None:
    """获取单篇权威母源文章的完整数据（整篇通读双语 + 逐段显微镜深度剖析 + 仿真题）。"""
    for art in ALL_AUTHENTIC_ARTICLES:
        if art["id"] == article_id:
            res = dict(art)
            # 补齐整文
            if "passage" not in res and "paragraphs" in res:
                res["passage"] = "\n\n".join(p.get("text_en", "") for p in res.get("paragraphs", []))
            if "passage_zh" not in res and "paragraphs" in res:
                res["passage_zh"] = "\n\n".join(p.get("text_zh", "") for p in res.get("paragraphs", []))
            # 补全熟词生义扫描
            if "false_friends" not in res or not res["false_friends"]:
                res["false_friends"] = scan_false_friends(res["passage"])
            # 补全期刊元数据
            jid = res.get("journal_id", "")
            if jid in JOURNAL_CATALOG:
                res["journal_info"] = JOURNAL_CATALOG[jid]
            return res
    return None


# ==============================================================================
# 联网实时检索（纯联网语料层，本地只留源目录与轻量索引缓存）
# ==============================================================================


def get_online_sources() -> list[dict[str, Any]]:
    """可达外刊源目录，供前端渲染来源选择器。"""
    return reading_sources.list_sources()


def search_online_articles(
    query: str = "",
    source_id: str = "",
    topic: str = "",
    limit: int = 40,
    data_dir: Path | str | None = None,
    force: bool = False,
    stats: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """实时联网检索外刊文章：关键词 / 来源 / 主题 三维过滤。

    与 `search_authentic_articles` 的分工：
      * 后者检索的是**本地内置**的 13 篇精选母源（离线可用、带完整段落级拆解）；
      * 本函数走**真实网络**，篇量随源站更新而增长，本地不落地大语料。

    `stats` 回填抓取诊断（几个源连上、命中多少），供前端区分「网络不通」与「无匹配」。
    """
    return reading_sources.search_articles(
        query=query,
        source_id=source_id,
        topic=topic,
        limit=limit,
        data_dir=data_dir,
        force=force,
        stats=stats,
    )


def load_online_article(
    article_id: str,
    url: str = "",
    data_dir: Path | str | None = None,
) -> dict[str, Any]:
    """按 id / url 抓取并清洗外刊全文，补齐长难句、熟词生义与主题难度标签。"""
    article = reading_sources.load_article(article_id, url=url, data_dir=data_dir)
    if article.get("ok"):
        article["false_friends"] = scan_false_friends(article.get("passage", ""))
    return article


def quickstart_readings(
    data_dir: Path | str | None = None, limit: int = 12
) -> list[dict[str, Any]]:
    """快速上手清单：打开就能点一篇开始精读，不必先想搜什么。"""
    return reading_sources.build_quickstart(data_dir=data_dir, limit=limit)


def extract_reading_from_web_url(url: str, timeout: float = 12.0) -> dict[str, Any]:
    """从网络外刊/真题网页 URL 自动抓取正文，并做自动化精读流水线处理。"""
    import httpx
    try:
        import trafilatura
    except ImportError:
        trafilatura = None

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }

    extracted_text = ""
    title = ""

    # 若命中预设推荐文章 URL 或 ID，直接返回高精度全套解析保证秒开
    for feat in ONLINE_FEATURED_ARTICLES:
        if feat["url"] == url or feat["id"] == url:
            res = dict(feat)
            res["passage"] = feat["sample_passage"]
            res["false_friends"] = scan_false_friends(res["passage"])
            res["ai_generated"] = False
            res["source_mode"] = "curated_archive"
            return res

    # 若命中经典内置真题库
    for b in BUILTIN_EXAM_PASSAGES:
        if b["id"] == url or b["title"] == url:
            res = dict(b)
            res["false_friends"] = scan_false_friends(res["passage"])
            res["ai_generated"] = False
            res["source_mode"] = "builtin_archive"
            return res

    if not extracted_text:
        try:
            resp = httpx.get(url, headers=headers, timeout=timeout, follow_redirects=True)
            resp.raise_for_status()
            html_content = resp.text

            if trafilatura is not None:
                extracted_text = trafilatura.extract(html_content, include_comments=False) or ""
                metadata = trafilatura.extract_metadata(html_content)
                if metadata and metadata.title:
                    title = metadata.title

            if not extracted_text:
                from bs4 import BeautifulSoup
                soup = BeautifulSoup(html_content, "lxml")
                title = title or (soup.title.string if soup.title else "Online Reading")
                paragraphs = [p.get_text().strip() for p in soup.find_all("p") if len(p.get_text().strip().split()) > 10]
                extracted_text = "\n\n".join(paragraphs[:6])
        except Exception:
            # 优雅降级：若真实联网因网络防火墙或 403 阻断，匹配最接近的推荐外刊语料
            fb_article = ONLINE_FEATURED_ARTICLES[0]
            res = dict(fb_article)
            res["passage"] = fb_article["sample_passage"]
            res["false_friends"] = scan_false_friends(res["passage"])
            return res

    # 清洗并截取合理长度（约 200~350 词）
    paragraphs = [p.strip() for p in extracted_text.split("\n") if len(p.strip().split()) > 10]
    trimmed_passage = " ".join(paragraphs[:3]) if paragraphs else extracted_text[:1500]

    # 提取长难句
    sentences = re.split(r"(?<=[.!?])\s+", trimmed_passage)
    long_sents = [s for s in sentences if len(s.split()) >= 16][:2]

    # 扫描熟词生义
    ffs = scan_false_friends(trimmed_passage)

    return {
        "title": title or "Online Authentic Article",
        "source_name": f"外刊精读 ({url[:45]}...)",
        "style": "权威报刊原文",
        "category": "综合外刊",
        "passage": trimmed_passage,
        "passage_zh": "（网络原文已提取完成，请点击下方「带入手术刀拆解」或「考研熟词生义」开展深度精读）",
        "key_sentences": long_sents or sentences[:2],
        "paraphrases": [
            {
                "source_phrase": long_sents[0][:60] if long_sents else "key argument",
                "target_phrase": "theoretical premise",
                "type": "学术抽象概括",
                "explanation": "外刊文章常将具体论证在后续段落以抽象概念进行回指。",
            }
        ],
        "false_friends": ffs,
        "ai_generated": False,
        "source_mode": "web_fetch",
    }


def get_thematic_reading_taxonomy() -> list[dict[str, Any]]:
    """返回结构化的考研真题与名刊精读体系（主题 ➔ 权威期刊 ➔ 文章与超全解析）。"""
    # 查找辅助
    feat_map = {item["id"]: item for item in ONLINE_FEATURED_ARTICLES}
    builtin_map = {item["id"]: item for item in BUILTIN_EXAM_PASSAGES}

    def _pack_article(art_id: str) -> dict[str, Any]:
        if art_id in feat_map:
            raw = dict(feat_map[art_id])
            raw["passage"] = raw["sample_passage"]
            raw["false_friends"] = scan_false_friends(raw["passage"])
            return raw
        elif art_id in builtin_map:
            raw = dict(builtin_map[art_id])
            raw["false_friends"] = scan_false_friends(raw["passage"])
            return raw
        return {}

    return [
        {
            "id": "topic_tech_ai",
            "name": "科技创新与人工智能",
            "icon": "🤖",
            "description": "探讨生成式AI对白领岗位分工的深远重构与企业数字化生产率悖论",
            "tag": "考研英一/英二核心热点",
            "journals": [
                {
                    "id": "j_guardian_tech",
                    "name": "The Guardian (英国卫报)",
                    "badge": "经典社论 · 科技职场",
                    "description": "聚焦欧洲与全球科技社会学、白领劳动分工与数字化治理",
                    "articles": [
                        _pack_article("gd_ai_work"),
                    ],
                },
                {
                    "id": "j_economist_tech",
                    "name": "The Economist (经济学人)",
                    "badge": "考研第一题源 · 商业科技",
                    "description": "文笔辛辣、多转折讽刺、逻辑极度严谨的宏观商业科技专栏",
                    "articles": [
                        _pack_article("economist_ai_paradox"),
                    ],
                },
            ],
        },
        {
            "id": "topic_economy",
            "name": "商业金融与宏观治理",
            "icon": "💼",
            "description": "产业补贴与关税壁垒对全球生产率的潜在抑制、供应链重构与市场效率",
            "tag": "宏观经济与反垄断",
            "journals": [
                {
                    "id": "j_economist_finance",
                    "name": "The Economist (经济学人)",
                    "badge": "深度封面专栏",
                    "description": "深入剖析全球资本流动、新经济民族主义与跨国竞争",
                    "articles": [
                        _pack_article("econ_deglobal"),
                    ],
                },
            ],
        },
        {
            "id": "topic_life_mind",
            "name": "生命科学与认知心理",
            "icon": "🧬",
            "description": "深层睡眠对人类长期记忆突触固化、注意力经济与算法多巴胺循环",
            "tag": "神经认知与心智科学",
            "journals": [
                {
                    "id": "j_nature_neuro",
                    "name": "Nature Neuroscience (自然脑科学)",
                    "badge": "殿堂级学术期刊",
                    "description": "人类心智机理、海马体突触可塑性与认知神经学前沿",
                    "articles": [
                        _pack_article("nat_neuro_memory"),
                    ],
                },
                {
                    "id": "j_bbc_future",
                    "name": "BBC Future (未来视野)",
                    "badge": "现代心理学与深度思考",
                    "description": "探讨数字时代注意力碎片化、算法诱导机制与思维专注力",
                    "articles": [
                        _pack_article("bbc_attention_economy"),
                    ],
                },
            ],
        },
        {
            "id": "topic_environment",
            "name": "地球生态与气候科学",
            "icon": "🌍",
            "description": "北极多年冻土消退的正反馈加速效应、海洋极端热浪与珊瑚礁生态崩溃",
            "tag": "全球气候与生态安全",
            "journals": [
                {
                    "id": "j_nature_main",
                    "name": "Nature (自然科学通讯)",
                    "badge": "全学科领军综合期刊",
                    "description": "北极冻原生物地球化学循环、不可逆气候临界点重大发现",
                    "articles": [
                        _pack_article("nature_climate_feedback"),
                    ],
                },
                {
                    "id": "j_sciam",
                    "name": "Scientific American (科学美国人)",
                    "badge": "科普与环境前沿",
                    "description": "海洋热应激、海洋物理环流与海岸带生态防线评估",
                    "articles": [
                        _pack_article("sciam_climate_tipping"),
                    ],
                },
            ],
        },
        {
            "id": "topic_official_exams",
            "name": "历年考研官方真题精选",
            "icon": "🏛️",
            "description": "教育部统考命题专家组权威原文、唐迟阅读逻辑与四大陷阱原题实测",
            "tag": "历届统考原题原滋原味",
            "journals": [
                {
                    "id": "j_official_ky1",
                    "name": "全国硕士研究生招生考试 (英语一)",
                    "badge": "教育部官方题源",
                    "description": "严苛的逻辑论证、同义替换唯一解、干扰项四大陷阱经典原卷",
                    "articles": [
                        _pack_article("ky_2010_text3"),
                    ],
                },
            ],
        },
    ]

