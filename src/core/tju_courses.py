"""天津大学课程库 —— 课程编号与名称。

数据来源：superpung/TJU-CourseSharing（CC BY-NC-SA 4.0）的目录结构。
**只收录课程元数据（编号 / 名称 / 学科），不含任何课件、试卷等资料内容**：
大赛需提交版权合规承诺书，打包他人资料有合规风险，且会让仓库体积暴涨数百 MB。

用途：
  1. 新建课程时按课名自动补全，减少手输错误；
  2. 按课名预判学科，据此选择题卡/测验的 few-shot 示例（见 _detect_discipline）。

由 tools 脚本从上游仓库目录生成，如需更新请重跑生成脚本而非手改。
"""

from __future__ import annotations

import re

# (课程编号, 课程名称, 学科类别)
TJU_COURSES: tuple[tuple[str, str, str], ...] = (
    ('2020701', '电路信号与系统', 'science_engineering'),
    ('2020727', '精密机械设计课程设计', 'science_engineering'),
    ('2020756', '仪器控制理论', 'science_engineering'),
    ('2020757', '仪器光学设计', 'science_engineering'),
    ('2020758', '数字信号处理', 'science_engineering'),
    ('2020762', '计算机视觉', 'science_engineering'),
    ('2020764', '工程光学', 'science_engineering'),
    ('2020768', '数据分析', 'science_engineering'),
    ('2030418', '模拟电子技术基础1', 'science_engineering'),
    ('2051026', '工程承包与项目管理', 'economics_management'),
    ('2100004', '高等数学2A', 'science_engineering'),
    ('2100005', '高等数学2B', 'science_engineering'),
    ('2100047', '数学模型', 'science_engineering'),
    ('2100063', '数理方程', 'science_engineering'),
    ('2100075', '概率论与数理统计1', 'science_engineering'),
    ('2100097', '大学物理2A', 'science_engineering'),
    ('2100098', '大学物理2B', 'science_engineering'),
    ('2100101', '大学物理概论', 'science_engineering'),
    ('2100195', '物理化学2A', 'science_engineering'),
    ('2100346', '物理实验A', 'science_engineering'),
    ('2100347', '物理实验B', 'science_engineering'),
    ('2100490', '数值计算方法与Matlab', 'science_engineering'),
    ('2100558', '线性代数及其应用', 'science_engineering'),
    ('2111140', '马克思主义基本原理', 'humanities'),
    ('2160044', '离散数学B', 'science_engineering'),
    ('2160083', '面向对象程序设计', 'science_engineering'),
    ('2160213', '计算机软件技术基础2', 'science_engineering'),
    ('2160240', '并行计算', 'science_engineering'),
    ('2180042', '人工智能（双语）', 'science_engineering'),
    ('2180058', '图像处理', 'science_engineering'),
    ('2180250', '自然语言处理导论', 'science_engineering'),
    ('2180265', '软件工程1（双语）', 'science_engineering'),
    ('2180266', '软件工程2（双语）', 'science_engineering'),
    ('2180267', '形式化方法（双语）', 'science_engineering'),
    ('2180277', '离散数学', 'science_engineering'),
    ('2180279', '程序设计原理', 'science_engineering'),
    ('2210015', '中国近现代史纲要', 'humanities'),
    ('2210016', '毛泽东思想和中国特色社会主义理论体系概论', 'humanities'),
    ('2210106', '习近平新时代中国特色社会主义思想概论', 'humanities'),
    ('2210114', '毛泽东思想和中国特色社会主义理论体系概论', 'humanities'),
    ('2210127', '习近平关于科技创新的重要论述', 'humanities'),
    ('2330068', '微积分I', 'science_engineering'),
    ('2440002', '形式语言与自动机', 'science_engineering'),
    ('2440003', '机器学习', 'science_engineering'),
    ('2440031', '算法设计与分析', 'science_engineering'),
    ('2440033', '设计模式', 'science_engineering'),
    ('2440041', '程序设计初级实践', 'science_engineering'),
    ('2440042', '程序设计中级实践', 'science_engineering'),
    ('2440043', '程序设计高级实践', 'science_engineering'),
    ('2440045', '人工智能基础', 'science_engineering'),
    ('2440046', '数据结构', 'science_engineering'),
    ('2440047', '认知科学导论', 'science_engineering'),
    ('2440048', '信息安全数学基础', 'science_engineering'),
    ('2440049', '程序设计综合实践', 'science_engineering'),
    ('2440050', '计算机系统基础', 'science_engineering'),
    ('2440051', '知识工程', 'science_engineering'),
    ('2440053', '软件工程', 'science_engineering'),
    ('2440054', '数据挖掘', 'science_engineering'),
    ('2440063', '软件测试技术', 'science_engineering'),
    ('2440064', '计算机图形技术', 'science_engineering'),
    ('2440069', '架构驱动的软件开发实践', 'science_engineering'),
    ('2440072', '计算机系统综合实践', 'science_engineering'),
    ('2440073', '数据仓库与数据挖掘', 'science_engineering'),
    ('2440074', '计算机图形学', 'science_engineering'),
    ('2440075', '编译原理与技术', 'science_engineering'),
    ('2440078', '操作系统原理', 'science_engineering'),
    ('2440079', '深度强化学习', 'science_engineering'),
    ('2440081', '软件体系结构', 'science_engineering'),
    ('2440085', '密码学原理与实践', 'science_engineering'),
    ('2440086', '软件安全', 'science_engineering'),
    ('2440091', '软件工程综合实践', 'science_engineering'),
    ('2440098', '程序设计写作实践', 'science_engineering'),
    ('2440111', '物联网安全', 'science_engineering'),
    ('2440113', '可视语言与信息可视化', 'science_engineering'),
    ('2440115', '知识图谱', 'science_engineering'),
    ('2440118', '计算机视觉', 'science_engineering'),
    ('2440123', '综合实训（软件工程）', 'science_engineering'),
    ('2440125', '数字逻辑与数字系统', 'science_engineering'),
    ('2440126', '数据库原理', 'science_engineering'),
    ('2440127', '人工智能数学基础', 'science_engineering'),
    ('2440130', '计算机网络', 'science_engineering'),
    ('2440135', '语音信息处理', 'science_engineering'),
    ('2440137', '软件安全综合实践', 'science_engineering'),
    ('2440140', '数值计算方法', 'science_engineering'),
    ('2440166', '计算机系统基础1', 'science_engineering'),
    ('2440167', '程序设计综合实践', 'science_engineering'),
    ('2440168', '计算机系统基础2', 'science_engineering'),
    ('2440180', '知识工程', 'science_engineering'),
    ('2440186', '分布式系统', 'science_engineering'),
    ('2440200', '数据库系统', 'science_engineering'),
    ('2440206', '机器学习与深度学习', 'science_engineering'),
    ('2440212', '操作系统原理', 'science_engineering'),
    ('5100054', '形势与政策', 'humanities'),
    ('5100055', '思想道德修养与法律基础', 'humanities'),
    ('5100057', '军事理论', 'humanities'),
    ('B131G002', '中国马克思主义与当代', 'humanities'),
    ('S131A035', '工程数学基础', 'science_engineering'),
    ('S131G003', '自然辩证法概论', 'humanities'),
    ('S131G006', '新时代中国特色社会主义理论与实践', 'humanities'),
    ('S131GA04', '随机过程基础', 'science_engineering'),
    ('S131GA06', '应用统计学', 'science_engineering'),
    ('S131GA07', '最优化方法', 'science_engineering'),
    ('S2160003', '高可信软件工程', 'science_engineering'),
    ('S2168001', '社会计算导论', 'science_engineering'),
    ('S216E603', '高级人工智能', 'science_engineering'),
    ('S216E616', '自然语言处理', 'science_engineering'),
    ('S216E617', '图像合成技术', 'science_engineering'),
    ('S216G606', '现代计算机体系结构', 'science_engineering'),
    ('S2185004', '高级人工智能', 'science_engineering'),
    ('S2185018', '软件体系结构', 'science_engineering'),
    ('S2188004', '大数据的数据挖掘', 'science_engineering'),
    ('S2213003', '工程伦理', 'humanities'),
    ('S4028001', '信息检索与分析', 'humanities'),
    ('', '体育', 'humanities'),
    ('', '大学英语', 'humanities'),
    ('', '文化素质选修', 'humanities')
)

# 课名 -> 学科 的直查表（同名课取首次出现者）
_COURSE_DISCIPLINE: dict[str, str] = {
    name: discipline for _, name, discipline in TJU_COURSES
}


def lookup_course_discipline(subject: str) -> str | None:
    """按课程名查学科类别；先精确匹配，再退化为子串包含匹配。

    返回 None 表示课程库里没有这门课，调用方应回退到基于资料文本的学科识别。
    """
    key = (subject or "").strip()
    if not key:
        return None
    if key in _COURSE_DISCIPLINE:
        return _COURSE_DISCIPLINE[key]
    # 去掉分班后缀再试一次，例如「高等数学2A」->「高等数学」
    stripped = re.sub(r"[0-9A-Za-z]+$", "", key).strip()
    if stripped and stripped in _COURSE_DISCIPLINE:
        return _COURSE_DISCIPLINE[stripped]
    for name, discipline in _COURSE_DISCIPLINE.items():
        if key in name or name in key:
            return discipline
    return None


def search_courses(query: str, limit: int = 8) -> list[dict[str, str]]:
    """按关键字搜索课程，用于新建课程时的自动补全。"""
    key = (query or "").strip().lower()
    if not key:
        return []
    hits = [
        {"code": code, "name": name, "discipline": disc}
        for code, name, disc in TJU_COURSES
        if key in name.lower() or key in code.lower()
    ]
    return hits[: max(1, limit)]


def discipline_from_text(text: str) -> str | None:
    """资料文本里若出现了课程库中的课名，返回其学科；否则 None。

    课件首页、试卷页眉常带课程名，命中它比统计学科关键词更准。
    ponytail: 只比对长度≥4 的课名，避免「体育」之类过短词在正文里误命中。
    """
    low = (text or "").lower()
    if not low:
        return None
    for name, discipline in _COURSE_DISCIPLINE.items():
        if len(name) >= 4 and name.lower() in low:
            return discipline
    return None
