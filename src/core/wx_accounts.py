"""天大公众号矩阵清单（海小棠的"信息源目录"）。

这份清单来自用户整理的天大公众号订阅列表（56 个号），落成结构化数据后有三处用途：

1. **指路**：海小棠答不上具体条款时，能准确说出"这件事看哪个号"，而不是泛泛地
   说"关注官方公众号"。以前 `_campus_channels()` 只列了 10 个号的通用指引。
2. **提权**：`campus_sources` 检索时，命中清单里的号名（或它的别名）的结果加权，
   避免野号稿子压过官方通知。
3. **订阅**：`feed` 按清单的号名去匹配抓到的推文，标出「哪个号、多久前发的」。

字段说明：
- ``name``   公众号正式名（截图里被省略号截断的已按头像/中英文名补全）
- ``alias``  简称 / 常见称呼 / 易错写法，用于在标题、正文、问句里识别同一个号
- ``cat``    类别，决定 UI 分组与默认优先级
- ``tier``   1=必看（错过会误事：教务/奖助/推免/后勤）2=建议 3=按需
- ``focus``  这个号主管什么，既是检索提权的关键词，也是"去哪问"的答案
- ``site``   对应的官网（探针实测可达的才写；没有官网的靠公众号本身，属已知最脆弱环节）
- ``wx_id``  微信号（已知的才填；大多数无法公开获取，留空不猜）
"""

from __future__ import annotations

import json
import os
import re
import threading
import time

CAT_SCHOOL = "学院学部"
CAT_OFFICE = "校机关部处"
CAT_STUDENT = "学生组织"
CAT_SERVICE = "校园服务"
CAT_MEDIA = "校园媒体"
CAT_CLUB = "社团与实验室"
CAT_EXTERNAL = "外部平台"

CATEGORY_ORDER = [
    CAT_OFFICE,
    CAT_SCHOOL,
    CAT_SERVICE,
    CAT_STUDENT,
    CAT_MEDIA,
    CAT_CLUB,
    CAT_EXTERNAL,
]

# ------------------------------------------------------------------ 清单本体
ACCOUNTS: list[dict] = [
    # ---------------- 校机关部处（办事、政策、评奖评优的权威出口） ----------------
    {
        "name": "天津大学",
        "alias": ["天大", "北洋"],
        "cat": CAT_OFFICE,
        "tier": 1,
        "focus": ["学校要闻", "重要通知", "招生", "大型活动"],
        "site": "https://www.tju.edu.cn/",
    },
    {
        "name": "天津大学教务处",
        "alias": ["教务处"],
        "cat": CAT_OFFICE,
        "tier": 1,
        "focus": [
            "选课",
            "考试安排",
            "学籍",
            "培养方案",
            "校历",
            "学分",
            "转专业",
            "辅修",
        ],
        "site": "https://oaa.tju.edu.cn/",
    },
    {
        "name": "天津大学团委",
        "alias": ["校团委"],
        "cat": CAT_OFFICE,
        "tier": 1,
        "focus": ["第二课堂", "志愿", "社会实践", "团日活动", "青马工程", "社团管理"],
        "site": "",
    },
    {
        "name": "天大学生资助",
        "alias": ["学生资助管理中心", "资助中心", "学工部"],
        "cat": CAT_OFFICE,
        "tier": 1,
        "focus": [
            "奖学金",
            "励学金",
            "助学金",
            "困难认定",
            "评奖评优",
            "三好学生",
            "国家奖学金",
            "国奖",
            "勤工助学",
            "助学贷款",
        ],
        "site": "",
    },
    {
        "name": "天津大学工会",
        "alias": ["校工会"],
        "cat": CAT_OFFICE,
        "tier": 3,
        "focus": ["教职工服务", "工会活动"],
        "site": "",
    },
    {
        "name": "天大科研",
        "alias": ["科研院", "科学技术发展研究院"],
        "cat": CAT_OFFICE,
        "tier": 2,
        "focus": ["科研动态", "项目申报", "科研成果", "重点实验室", "基金申请"],
        "site": "",
    },
    {
        "name": "天津大学国际处暨港澳台办",
        "alias": ["国际处", "港澳台办", "国际合作与交流处"],
        "cat": CAT_OFFICE,
        "tier": 2,
        "focus": ["交换项目", "暑校", "国际交流", "公派出国", "港澳台交流", "外事手续"],
        "site": "https://ico.tju.edu.cn/",
    },
    # ---------------- 学院学部 ----------------
    {
        "name": "天津大学精仪学院",
        "alias": ["精仪", "精密仪器与光电子工程学院", "精仪学院"],
        "cat": CAT_SCHOOL,
        "tier": 1,
        "focus": ["学院通知", "推免实施细则", "评奖评优", "学生活动", "学术报告"],
        "site": "https://jyxy.tju.edu.cn/cn/index.shtml",
    },
    {
        "name": "天津大学精密仪器全国重点实验室",
        "alias": ["精密仪器全国重点实验室", "PMTI", "仪器科学"],
        "cat": CAT_SCHOOL,
        "tier": 1,
        # 对精仪/仪器方向的同学，这里是**研究生招生口径**的第一来源
        "focus": [
            "仪器科学与技术",
            "硕士生招生",
            "博士招生",
            "推免",
            "复试",
            "暑期学校",
            "科研平台",
        ],
        "site": "",
    },
    {
        "name": "天津大学机械工程学院",
        "alias": ["机械学院", "机械工程"],
        "cat": CAT_SCHOOL,
        "tier": 2,
        "focus": ["学院通知", "研究生招生", "学术活动"],
        "site": "https://me.tju.edu.cn/",
    },
    {
        "name": "天津大学电气自动化与信息工程学院",
        "alias": ["自动化学院", "电气自动化", "seea"],
        "cat": CAT_SCHOOL,
        "tier": 2,
        "focus": ["学院通知", "研究生招生", "学术活动"],
        "site": "https://seea.tju.edu.cn/",
    },
    {
        "name": "天津大学智能与计算学部",
        "alias": ["智算学部", "智算", "计算机学院", "cic"],
        "cat": CAT_SCHOOL,
        "tier": 2,
        "focus": ["学院通知", "推免", "研究生招生", "人工智能", "计算机"],
        "site": "https://cic.tju.edu.cn/",
    },
    {
        "name": "天津大学微电子学院",
        "alias": ["微电子"],
        "cat": CAT_SCHOOL,
        "tier": 2,
        "focus": ["学院通知", "研究生招生", "集成电路"],
        "site": "https://sme.tju.edu.cn/",
    },
    {
        "name": "天津大学管理与经济学部",
        "alias": ["天大经管", "经管学部", "come"],
        "cat": CAT_SCHOOL,
        "tier": 2,
        "focus": ["学院通知", "研究生招生", "MBA", "学术活动"],
        "site": "https://come.tju.edu.cn/",
    },
    {
        "name": "天津大学建筑学院",
        "alias": ["建筑学院"],
        "cat": CAT_SCHOOL,
        "tier": 3,
        "focus": ["学院通知", "学术活动", "设计竞赛"],
        "site": "https://arch.tju.edu.cn/",
    },
    {
        "name": "天津大学建筑工程学院",
        "alias": ["建工学院", "建筑工程"],
        "cat": CAT_SCHOOL,
        "tier": 3,
        "focus": ["学院通知", "研究生招生"],
        "site": "https://jgxy.tju.edu.cn/",
    },
    {
        "name": "天津大学化工学院",
        "alias": ["化工学院"],
        "cat": CAT_SCHOOL,
        "tier": 3,
        "focus": ["学院通知", "学术活动"],
        "site": "",
    },
    {
        "name": "天津大学材料科学与工程学院",
        "alias": ["材料学院", "材料科学与工程"],
        "cat": CAT_SCHOOL,
        "tier": 3,
        "focus": ["学院通知", "学术活动"],
        "site": "https://mse.tju.edu.cn/",
    },
    {
        "name": "天津大学理学院",
        "alias": ["理学院"],
        "cat": CAT_SCHOOL,
        "tier": 3,
        "focus": ["学院通知", "基础课程", "学术活动"],
        "site": "https://science.tju.edu.cn/",
    },
    {
        "name": "天津大学数学学院",
        "alias": ["数学学院"],
        "cat": CAT_SCHOOL,
        "tier": 3,
        "focus": ["学院通知", "学术报告", "竞赛"],
        "site": "https://math.tju.edu.cn/",
    },
    {
        "name": "天津大学环境科学与工程学院",
        "alias": ["环境学院", "环境科学与工程"],
        "cat": CAT_SCHOOL,
        "tier": 3,
        "focus": ["学院通知", "学术活动"],
        "site": "",
    },
    {
        "name": "天津大学地球系统科学学院",
        "alias": ["地科院", "地球系统科学"],
        "cat": CAT_SCHOOL,
        "tier": 3,
        "focus": ["学院通知", "学术活动"],
        "site": "https://earth.tju.edu.cn/",
    },
    {
        "name": "天津大学医学部",
        "alias": ["医学部", "医科"],
        "cat": CAT_SCHOOL,
        "tier": 3,
        "focus": ["医学教育", "附属医院", "学院通知"],
        "site": "https://health.tju.edu.cn/",
    },
    {
        "name": "天津大学医学院",
        "alias": ["医学院"],
        "cat": CAT_SCHOOL,
        "tier": 3,
        "focus": ["学院通知", "研究生招生"],
        "site": "https://health.tju.edu.cn/",
    },
    {
        "name": "天津大学药物科学与技术学院",
        "alias": ["药学院", "药物科学与技术"],
        "cat": CAT_SCHOOL,
        "tier": 3,
        "focus": ["学院通知", "研究生招生", "学术活动"],
        "site": "https://spst.tju.edu.cn/",
    },
    {
        "name": "天津大学外国语学院",
        "alias": ["外语学院", "外国语"],
        "cat": CAT_SCHOOL,
        "tier": 3,
        "focus": ["学院通知", "四六级", "语言考试"],
        "site": "https://tjusfl.tju.edu.cn/",
    },
    {
        "name": "天津大学人文艺术学院",
        "alias": ["人文艺术学院", "人文艺术"],
        "cat": CAT_SCHOOL,
        "tier": 3,
        "focus": ["学院通知", "文化活动"],
        "site": "https://rwys.tju.edu.cn/",
    },
    {
        "name": "天津大学未来技术学院",
        "alias": ["未来技术学院", "未来技术"],
        "cat": CAT_SCHOOL,
        "tier": 3,
        "focus": ["学院通知", "新工科", "学术活动"],
        "site": "",
    },
    {
        "name": "天津大学宣怀学院",
        "alias": ["宣怀学院", "创新创业学院"],
        "cat": CAT_SCHOOL,
        "tier": 2,
        "focus": ["创新创业", "硬科技创业", "创业大赛", "项目孵化", "大创"],
        "site": "",
    },
    {
        "name": "天津大学新媒体与传播学院",
        "alias": ["新媒体学院", "新媒体与传播"],
        "cat": CAT_SCHOOL,
        "tier": 3,
        "focus": ["学院通知", "媒体实践"],
        "site": "",
    },
    {
        "name": "天津大学国际教育学院",
        "alias": ["国际教育学院", "留学生"],
        "cat": CAT_SCHOOL,
        "tier": 3,
        "focus": ["留学生", "国际学生", "汉语教学", "交流项目"],
        "site": "https://sie.tju.edu.cn/",
    },
    {
        "name": "天津大学海南国际学院",
        "alias": ["海南国际学院", "雷丁大学亨利国际学院", "亨利国际学院"],
        "cat": CAT_SCHOOL,
        "tier": 2,
        # 实测这个号会发推免递补名单，属"错过就误事"的信息，所以给到 tier 2
        "focus": ["推免", "硕士生招生", "中外合作办学", "海南校区", "递补名单"],
        "site": "",
    },
    {
        "name": "天津大学合成生物与生物制造学院",
        "alias": ["合成生物与生物制造学院", "合成生物学"],
        "cat": CAT_SCHOOL,
        "tier": 3,
        "focus": ["学院通知", "研究生招生", "合成生物学"],
        "site": "",
    },
    # ---------------- 校园服务（日常生活、设施、保障） ----------------
    {
        "name": "天津大学图书馆",
        "alias": ["图书馆", "郑东图书馆"],
        "cat": CAT_SERVICE,
        "tier": 1,
        "focus": [
            "开馆时间",
            "座位预约",
            "借阅",
            "数据库",
            "查重",
            "信息素养",
            "研讨间",
        ],
        "site": "https://lib.tju.edu.cn/",
    },
    {
        "name": "天大后勤",
        "alias": ["后勤保障部", "后勤"],
        "cat": CAT_SERVICE,
        "tier": 1,
        "focus": [
            "食堂",
            "宿舍",
            "供暖",
            "水电",
            "维修",
            "浴室",
            "校车",
            "班车",
            "住宿",
        ],
        "site": "",
    },
    {
        "name": "天津大学场馆中心",
        "alias": ["场馆中心"],
        "cat": CAT_SERVICE,
        "tier": 2,
        "focus": ["体育馆", "游泳馆", "羽毛球", "网球", "场地预约", "开放时间"],
        "site": "",
    },
    {
        "name": "天大体育",
        "alias": ["体育部", "体育课"],
        "cat": CAT_SERVICE,
        "tier": 2,
        "focus": ["体育课", "体测", "免修", "运动会", "场馆", "锻炼"],
        "site": "https://tyb.tju.edu.cn/",
    },
    {
        "name": "天大心理",
        "alias": ["心理健康教育中心", "心理咨询"],
        "cat": CAT_SERVICE,
        "tier": 2,
        "focus": ["心理咨询", "预约", "心理健康", "新生适应", "宿舍关系", "情绪"],
        "site": "",
    },
    {
        "name": "天津大学一站式学生社区",
        "alias": ["一站式学生社区", "学生社区"],
        "cat": CAT_SERVICE,
        "tier": 2,
        "focus": ["社区服务", "平安校园", "消防安全", "宿舍安全", "反诈"],
        "site": "",
    },
    {
        "name": "天津大学档案馆",
        "alias": ["档案馆"],
        "cat": CAT_SERVICE,
        "tier": 3,
        "focus": ["档案", "成绩单", "证明", "校史", "历史档案"],
        "site": "https://dag.tju.edu.cn/",
    },
    # ---------------- 学生组织 ----------------
    {
        "name": "天津大学学生会",
        "alias": ["校学生会"],
        "cat": CAT_STUDENT,
        "tier": 2,
        "focus": ["学生活动", "权益", "研会预选拔", "招新"],
        "site": "",
    },
    {
        "name": "天津大学学生科技创新创业协会",
        "alias": ["学生科技创新创业协会", "科创协", "学生科协"],
        "cat": CAT_STUDENT,
        "tier": 2,
        "focus": ["大创", "挑战杯", "科创竞赛", "未来30年", "创新创业"],
        "site": "",
    },
    {
        "name": "天津大学青年志愿者协会",
        "alias": ["青年志愿者协会", "校青协", "志愿者"],
        "cat": CAT_STUDENT,
        "tier": 3,
        "focus": ["志愿招募", "志愿服务", "支教", "公益活动", "志愿时长"],
        "site": "",
    },
    {
        "name": "TJU党员精英班",
        "alias": ["党员精英班", "精英班"],
        "cat": CAT_STUDENT,
        "tier": 3,
        "focus": ["党员培养", "骨干培训", "理论学习"],
        "site": "",
    },
    {
        "name": "天大青年文化促进会",
        "alias": ["青年文化促进会", "文促会"],
        "cat": CAT_STUDENT,
        "tier": 3,
        "focus": ["文化活动", "讲座", "演出", "人文素养"],
        "site": "",
    },
    {
        "name": "天大机械青协",
        "alias": ["机械青协"],
        "cat": CAT_STUDENT,
        "tier": 3,
        "focus": ["机械学院志愿", "招新", "公益活动"],
        "site": "",
    },
    {
        "name": "机械英才",
        "alias": ["机械学生会", "机械英才"],
        "cat": CAT_STUDENT,
        "tier": 3,
        "focus": ["机械学院学生会", "招新", "学生活动"],
        "site": "",
    },
    {
        "name": "天大机械科协",
        "alias": ["机械科协"],
        "cat": CAT_STUDENT,
        "tier": 3,
        "focus": ["机械学院科创", "竞赛", "招新"],
        "site": "",
    },
    # ---------------- 校园媒体 ----------------
    {
        "name": "天外天",
        "alias": ["天外天新闻中心", "天外天"],
        "cat": CAT_MEDIA,
        "tier": 2,
        "focus": ["校园资讯", "学生视角", "校园热点", "生活服务"],
        "site": "",
    },
    {
        "name": "天津大学校报",
        "alias": ["校报"],
        "cat": CAT_MEDIA,
        "tier": 3,
        "focus": ["校报", "人物报道", "校史文化"],
        "site": "",
    },
    {
        "name": "耀北洋",
        "alias": ["耀北洋"],
        "cat": CAT_MEDIA,
        "tier": 3,
        "focus": ["天麟班", "学生培养", "青年榜样"],
        "site": "",
    },
    {
        "name": "天大机械新媒体中心",
        "alias": ["机械新媒体中心"],
        "cat": CAT_MEDIA,
        "tier": 3,
        "focus": ["机械学院宣传", "学院动态"],
        "site": "",
    },
    {
        "name": "三号教学楼",
        "alias": ["三号教学楼"],
        "cat": CAT_MEDIA,
        "tier": 3,
        "focus": ["校园自媒体", "教务信息速递", "四六级成绩"],
        "site": "",
    },
    # ---------------- 社团与实验室 ----------------
    {
        "name": "北洋数学研究社",
        "alias": ["北洋数学研究社", "数学社"],
        "cat": CAT_CLUB,
        "tier": 3,
        "focus": ["数学社团", "纳新", "数学竞赛", "学习交流"],
        "site": "",
    },
    {
        "name": "北洋诗词社",
        "alias": ["诗词社"],
        "cat": CAT_CLUB,
        "tier": 3,
        "focus": ["诗词", "文化活动", "社团活动"],
        "site": "",
    },
    {
        "name": "234电工实验室",
        "alias": ["234电工实验室", "电工实验室"],
        "cat": CAT_CLUB,
        "tier": 3,
        "focus": ["电工电子实验", "课程经验", "学习方法"],
        "site": "",
    },
    {
        "name": "天津大学学报",
        "alias": ["学报", "天津大学学报"],
        "cat": CAT_CLUB,
        "tier": 3,
        "focus": ["学术出版", "论文投稿", "期刊"],
        "site": "",
    },
    # ---------------- 外部平台（非天大自建，但对学习直接有用） ----------------
    {
        "name": "MOOC慕课",
        "alias": ["中国大学MOOC", "MOOC"],
        "cat": CAT_EXTERNAL,
        "tier": 3,
        "focus": ["慕课", "在线课程", "课程学习"],
        "site": "https://www.icourse163.org/",
    },
    {
        "name": "批改网",
        "alias": ["批改网"],
        "cat": CAT_EXTERNAL,
        "tier": 3,
        "focus": ["英语作文", "写作批改", "四六级写作"],
        "site": "https://www.pigai.org/",
    },
    {
        "name": "天津教育头条",
        "alias": ["天津教育头条"],
        "cat": CAT_EXTERNAL,
        "tier": 3,
        "focus": ["天津教育政策", "考试安排", "教育资讯"],
        "site": "",
    },
]

# ------------------------------------------------------------------ 索引
_BY_NAME: dict[str, dict] = {}
_ALIAS_INDEX: list[tuple[str, dict]] = []


def _rebuild() -> None:
    _BY_NAME.clear()
    _ALIAS_INDEX.clear()
    for item in ACCOUNTS:
        _BY_NAME[item["name"]] = item
        keys = {item["name"], *item.get("alias", [])}
        for key in keys:
            if key:
                _ALIAS_INDEX.append((key, item))
    # 长名优先：避免「天津大学」先命中，把「天津大学教务处」吃掉
    _ALIAS_INDEX.sort(key=lambda kv: -len(kv[0]))


_rebuild()


def all_accounts() -> list[dict]:
    """全部号，按 类别 → tier → 名称 排序（供 UI 直接渲染）。"""
    cat_rank = {c: i for i, c in enumerate(CATEGORY_ORDER)}
    return sorted(
        ACCOUNTS,
        key=lambda a: (
            cat_rank.get(a.get("cat", ""), 99),
            a.get("tier", 9),
            a.get("name", ""),
        ),
    )


def all_names() -> list[str]:
    return [a["name"] for a in ACCOUNTS]


def by_category(cat: str) -> list[dict]:
    return [a for a in ACCOUNTS if a.get("cat") == cat]


def meta(name: str) -> dict | None:
    """按号名取登记信息（叫不准的用别名兜底）。"""
    if not name:
        return None
    name = name.strip()
    hit = _BY_NAME.get(name)
    if hit:
        return hit
    for key, item in _ALIAS_INDEX:
        if key and (key in name or name in key):
            return item
    return None


def categories() -> list[dict]:
    """[{"cat": 名称, "count": n}]，顺序按 CATEGORY_ORDER。"""
    counts: dict[str, int] = {}
    for a in ACCOUNTS:
        counts[a.get("cat", CAT_EXTERNAL)] = (
            counts.get(a.get("cat", CAT_EXTERNAL), 0) + 1
        )
    return [{"cat": c, "count": counts[c]} for c in CATEGORY_ORDER if counts.get(c)]


# 号名里高频出现、单看没有区分度的词：识别号名时要连着看，不能只命中这些
_GENERIC_PARTS = {
    "天津大学",
    "天大",
    "学院",
    "学部",
    "学生",
    "天津",
    "北洋",
    "中心",
    "协会",
}


def match(text: str, limit: int = 6) -> list[dict]:
    """在一段文本（问句 / 标题 / 正文）里识别提到了哪些公众号。

    返回按"名字先出现、名字更长"排序的号字典列表。用于两件事：
    - 检索提权：命中的号给对应结果加权；
    - 指路：答不出来时告诉同学"这件事该看哪个号"。
    """
    if not text:
        return []
    hits: list[tuple[int, int, dict]] = []
    seen: set[str] = set()
    for key, item in _ALIAS_INDEX:
        if item["name"] in seen:
            continue
        pos = text.find(key)
        if pos < 0:
            continue
        # 泛称（"天津大学"）只在没有更具体的号命中时才认，避免一问校内事就全命中
        if key in _GENERIC_PARTS and len(key) <= 4:
            continue
        seen.add(item["name"])
        hits.append((pos, -len(key), item))
    hits.sort(key=lambda x: (x[0], x[1]))
    return [h[2] for h in hits[:limit]]


def boost(text: str) -> float:
    """命中号的加权分（0~1.2）：给检索结果排序用。

    tier 越高（越权威）加得越多；命中多个号时取最大，不叠乘——否则一篇稿子恰好
    提到五个号名就会压过一切。
    """
    hits = match(text, limit=6)
    if not hits:
        return 0.0
    weights = {1: 0.7, 2: 0.45, 3: 0.25}
    return max(weights.get(h.get("tier", 3), 0.25) for h in hits)


# ------------------------------------------------------------------ 关注状态（用户可改）
# 用户能在「关注清单」里自己勾选。这里存**取消关注的差集**，而不是"已关注"的全集：
# 清单升级、以后加新号进来时默认就是关注的，不会因为文件里没有这条记录而被静默漏掉。
FOLLOWS_PATH = os.path.normpath(
    os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "..",
        "..",
        "data",
        "wx_follows.json",
    )
)

_follow_lock = threading.Lock()
_unfollowed: set | None = None


def _load_unfollowed() -> set:
    global _unfollowed
    with _follow_lock:
        if _unfollowed is None:
            try:
                with open(FOLLOWS_PATH, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
                raw = data.get("unfollowed") if isinstance(data, dict) else None
                _unfollowed = {str(n).strip() for n in (raw or []) if str(n).strip()}
            except Exception:
                _unfollowed = set()
        return set(_unfollowed)


def _save_unfollowed(names: set) -> None:
    global _unfollowed
    with _follow_lock:
        _unfollowed = set(names)
    try:
        os.makedirs(os.path.dirname(FOLLOWS_PATH), exist_ok=True)
        tmp = FOLLOWS_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(
                {"unfollowed": sorted(names), "updated_at": int(time.time())},
                fh,
                ensure_ascii=False,
            )
        os.replace(tmp, FOLLOWS_PATH)
    except Exception:
        pass  # 写盘失败不影响本次会话（内存里已生效）


def is_followed(name: str) -> bool:
    """这个号是否在关注中。

    清单里**没有登记**的号一律算关注：抓取时可能捞到清单外的号（新学院、校际号），
    不能因为它们没登记就从列表里消失。
    """
    if not name:
        return True
    return name.strip() not in _load_unfollowed()


def follow_stats() -> dict:
    unf = _load_unfollowed()
    total = len(ACCOUNTS)
    followed = sum(1 for a in ACCOUNTS if a["name"] not in unf)
    return {"total": total, "followed": followed, "unfollowed": total - followed}


def set_follow(name: str, follow: bool) -> dict:
    """关注 / 取消关注一个号，返回最新状态（前端拿它更新角标与统计）。"""
    name = (name or "").strip()
    if not name:
        return {"ok": False, "message": "号名不能为空", **follow_stats()}
    names = _load_unfollowed()
    if follow:
        names.discard(name)
    else:
        names.add(name)
    _save_unfollowed(names)
    return {"ok": True, "name": name, "followed": follow, **follow_stats()}


def set_all(follow: bool) -> dict:
    """一键全关注 / 全取消关注。"""
    names = set() if follow else {a["name"] for a in ACCOUNTS}
    _save_unfollowed(names)
    return {"ok": True, "followed": follow, **follow_stats()}


def set_follow_many(names: list, follow: bool) -> dict:
    """批量关注 / 取消关注（清单里按类别整组处理时用）。

    学院号是"按需"的：不同学院的人关心的号完全不同，与其让每个人手动勾二十几下，
    不如按组一次处理。
    """
    target = {str(n).strip() for n in (names or []) if str(n).strip()}
    if not target:
        return {"ok": False, "message": "没有指定号名", **follow_stats()}
    cur = _load_unfollowed()
    if follow:
        cur -= target
    else:
        cur |= target
    _save_unfollowed(cur)
    return {"ok": True, "changed": len(target), **follow_stats()}


def set_only(names: list) -> dict:
    """只关注这些号，其余全部取消。

    对应"学院号按需"：一键收敛成「必看 + 本院相关」，别人问不到的号不再占着推文列表。
    """
    keep = {str(n).strip() for n in (names or []) if str(n).strip()}
    _save_unfollowed({a["name"] for a in ACCOUNTS if a["name"] not in keep})
    return {"ok": True, "kept": len(keep), **follow_stats()}


def payload() -> dict:
    """给前端的整份清单（按类别分组渲染「关注清单」页，带关注状态）。"""
    rows = []
    for a in all_accounts():
        rows.append(
            {
                "name": a.get("name", ""),
                "cat": a.get("cat", ""),
                "tier": a.get("tier", 3),
                "focus": a.get("focus", []),
                "site": a.get("site", ""),
                "alias": a.get("alias", []),
                "followed": is_followed(a.get("name", "")),
            }
        )
    return {
        "categories": categories(),
        "accounts": rows,
        "total": len(rows),
        "follow": follow_stats(),
    }


_CLEAN_RE = re.compile(r"[\s\u3000]+")


def normalize(name: str) -> str:
    """号名归一化，用于跨源比对（"天津大学 教务处" → "天津大学教务处"）。"""
    return _CLEAN_RE.sub("", name or "")
