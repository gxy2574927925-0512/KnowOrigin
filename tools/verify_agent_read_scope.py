"""Agent 只读产物工具回归：search_cards / search_quiz / search_highlights / get_study_kit

为什么单独一个脚本：这几个工具读的是「已经生成的学习产物」（卡片 / 测验 / 我的笔记 / 台账成文材料），
它们的正确性不取决于模型，而取决于三件事 ——
  1. 工具在两套工具集里都注册了、都有中文标签（否则界面过程条显示英文裸名）；
  2. 真的读到了库里那份数据（不是空结果、不是别的项目的数据）；
  3. 语义边界不能错：search_quiz 默认不剧透答案、我的笔记要分开显示「我的批注」与「原答案」。

用真 Database + 真 StudyKitStore 落临时库跑 _run_agent_tool，不 mock 任何一层。
"""
import re
import sys
import tempfile
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import api_server as a  # noqa: E402
from core.database import Database  # noqa: E402
from core.exam_scheduler import ExamScheduler  # noqa: E402
from core.knowledge_doc import KnowledgeDocStore, doc_key_for  # noqa: E402
from core.models import Card, FrameworkNode, SourceCreate  # noqa: E402
from core.study_kit import StudyKitStore  # noqa: E402

FAILURES = []
NEW_TOOLS = (
    "search_cards", "search_quiz", "search_highlights", "get_study_kit",
    "get_learning_calendar", "search_knowledge_docs", "plan_study_action",
    "list_sources",
)


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail else ''}")
    if not ok:
        FAILURES.append(name)


def run(db, project_id, name, arguments, study_kit, *, owner_id=None, exam_scheduler=None,
        knowledge_doc=None, staged=None, nodes=None):
    return a._run_agent_tool(
        name,
        arguments,
        db=db,
        project_id=project_id,
        sources=[],
        nodes=nodes if nodes is not None else [],
        owner_id=owner_id,
        study_kit=study_kit,
        exam_scheduler=exam_scheduler,
        knowledge_doc=knowledge_doc,
        staged_actions=staged,
    )


def main():
    # ---------- 1. 注册：两套工具集 + 中文标签 ----------
    kb_names = {t["function"]["name"] for t in a.LEARNING_AGENT_TOOLS}
    main_names = {t["function"]["name"] for t in a.AGENT_TOOLS_DEFAULT}
    for name in NEW_TOOLS:
        check(f"{name} 在 kb 工具集", name in kb_names)
        check(f"{name} 在主界面工具集", name in main_names)
        check(f"{name} 有中文标签", bool(a._AGENT_TOOL_LABELS.get(name)), a._AGENT_TOOL_LABELS.get(name, "缺"))
        check(f"{name} 不是写工具", name not in a.AGENT_WRITE_TOOLS)
        # 参数表必须是 object，且不能把必填参数设成必填（模型漏参时要能降级而不是废掉整轮）
        schema = next(t["function"] for t in a.LEARNING_AGENT_TOOLS if t["function"]["name"] == name)
        check(f"{name} 参数表是 object", schema["parameters"]["type"] == "object")

    # ---------- 2. 真库真数据 ----------
    tmp = Path(tempfile.mkdtemp(prefix="knoworigin-read-scope-"))
    db = Database(tmp / "verify.sqlite3")
    owner = "user_legacy"
    db.create_user("reader@e.com", "abcd1234", "读者")
    project = db.create_project("2026", "傅里叶分析", owner_id=owner)
    other = db.create_project("2026", "光学", owner_id=owner)
    pid = project.project_id

    # 框架节点：plan_study_action 与复习文档都以节点为锚点，没有节点这两项没法验
    db.upsert_framework_nodes(
        pid,
        [
            FrameworkNode(node_id="node_1", name="康普顿散射", description="光子与自由电子碰撞",
                          mastery_score=0.2, note_content=""),
            FrameworkNode(node_id="node_2", name="光电效应", description="光能转化为电离能",
                          mastery_score=0.8, note_content="已整理"),
        ],
    )

    db.add_cards(
        pid,
        [
            Card(front="什么是傅里叶变换？", back="把时域信号分解为不同频率的正弦叠加。", category="概念"),
            Card(front="狄拉克δ函数的定义是什么？", back="一个积分为 1 的广义函数。", category="公式", difficulty=2),
            Card(front="采样定理要求采样频率多少？", back="至少为最高频率的两倍。", category="易错", difficulty=3),
        ],
    )
    # 另一个项目也放一张同名卡，用来验证工具不会跨项目串数据
    db.add_cards(other.project_id, [Card(front="什么是拉普拉斯变换？", back="另一个项目的内容。")])
    # 完全空的项目：只读工具必须给提示而不是抛异常
    blank = db.create_project("2026", "空白课", owner_id=owner)
    fav_note = "注意归一化约定，考试爱问。"
    fav_answer = "把时域信号分解为不同频率的正弦叠加。"

    # 资料：list_sources 的验证对象。正文里的小标题写成 [[H:n]] 标记，工具据此提目录。
    db.add_source(pid, SourceCreate(
        filename="chap1.pdf", mime_type="application/pdf", size_bytes=204800,
        text="[[H:3]] Chapter 1 Introduction\n\n"
             "[[H:3]] Chapter 2 Wavefunction\n\n"
             "[[H:4]] 2.1 Optical Duality\n\n"
             "[[H:4]] 2.2 Photoelectric Effect\n\n"
             "正文里还有一堆没有标题的段落，用来确认目录不会被正文噪声淹没。"))

    quiz_id = db.add_quiz(
        pid,
        {
            "questions": [
                {
                    "question": "傅里叶变换的定义域是？",
                    "type": "single_choice",
                    "options": ["时域", "频域", "两者都可以", "都不是"],
                    "answer": "B",
                    "explanation": "傅里叶变换把时域信号映到频域。",
                    "difficulty": 1,
                },
                {
                    "question": "采样定理的奈奎斯特频率是多少？",
                    "type": "fill_blank",
                    "options": [],
                    "answer": "两倍最高频率",
                    "explanation": "低于奈奎斯特频率会混叠。",
                    "difficulty": 2,
                },
            ],
            "source_ids": [],
            "fallback": False,
        },
    )
    db.save_quiz_score(pid, quiz_id, 0.5, results=[])

    fav = db.add_favorite(
        pid,
        item_type="card",
        origin_id="card_xxx",
        title="什么是傅里叶变换？",
        content="什么是傅里叶变换？",
        answer=fav_answer,
        chapter_node_id=None,
        chapter_name="第三章 傅里叶分析",
        node_ids=[],
    )
    db.update_favorite(
        pid,
        fav.favorite_id,
        title=fav.title,
        chapter_node_id=None,
        chapter_name=fav.chapter_name,
        note=fav_note,
        highlight_color="yellow",
    )
    db.add_favorite(
        pid,
        item_type="quiz",
        origin_id=f"{quiz_id}:0",
        title="傅里叶变换的定义域是？",
        content="傅里叶变换的定义域是？ 时域 / 频域 / 两者都可以 / 都不是",
        answer="B｜傅里叶变换把时域信号映到频域。",
        chapter_node_id=None,
        chapter_name="未归类",
        node_ids=[],
    )

    store = StudyKitStore(db.path)
    store.save(
        project_id=pid,
        owner_id=owner,
        kind="cheatsheet",
        title="一页速查表",
        content_md="## 傅里叶变换\n定义：时域 → 频域\n条件：绝对可积",
    )
    store.save(
        project_id=pid,
        owner_id=owner,
        kind="learning_path",
        title="学习路径",
        content_md="## 前置知识\n信号与系统\n## 下一步\n做采样定理的习题",
    )
    # 故意不生成 checklist，验证「尚未生成」能被如实报告

    # ---------- 3. search_cards ----------
    out = run(db, pid, "search_cards", {"query": "采样定理"}, store)
    check("search_cards 命中采样定理卡", "采样定理" in out, out.replace("\n", " ")[:90])
    check("search_cards 不串到别的项目", "拉普拉斯" not in out)
    check("search_cards 带分类", "易错" in out)
    out_all = run(db, pid, "search_cards", {}, store)
    check("search_cards 空 query 返回概览", "傅里叶变换" in out_all and "δ函数" in out_all)
    check("search_cards 空 query 命中 3 张", "命中 3 张" in out_all)
    out_cat = run(db, pid, "search_cards", {"category": "公式"}, store)
    check("search_cards 按分类过滤只回 1 张", "命中 1 张" in out_cat and "δ函数" in out_cat)
    # 清点类问题：观察值必须带编号 + 明确要求，否则模型会拿清单去写散文
    # （真机故障：调了 search_cards 却回答「根据提供的资料片段…」）
    check("search_cards 观察值带编号", "卡片 1｜分类" in out_all, out_all.split("\n")[1][:70])
    check("search_cards 观察值标明题面/答案字段",
          "题面：" in out_all and "答案：" in out_all, out_all.split("\n")[1][:70])
    check("search_cards 观察值带回答要求", "【回答要求】" in out_all and "逐条列出" in out_all)
    check("search_cards 观察值禁止改写成散文", "不要把它们改写成" in out_all)
    check("search_cards 观察值禁止用『资料片段』开头", "根据提供的资料片段" in out_all)
    check("search_highlights 观察值带编号与回答要求", (
        lambda o: "笔记 1｜类型" in o and "【回答要求】" in o
    )(run(db, pid, "search_highlights", {}, store)))
    prompt = a.AGENT_SYSTEM_PROMPT
    check("提示词含清点类问题规则", "清点类问题" in prompt)
    check("提示词要求按编号逐条列出", "按返回的编号逐条列出" in prompt)
    check("提示词禁止改写成散文总结", "严禁把它们改写成" in prompt)
    out_lim = run(db, pid, "search_cards", {"limit": 1}, store)
    check("search_cards limit=1 只列 1 张", "还有 2 张未显示" in out_lim, out_lim.replace("\n", " ")[:90])
    out_lim2 = run(db, pid, "search_cards", {"limit": 2}, store)
    check("search_cards limit=2 只列 2 张", "还有 1 张未显示" in out_lim2, out_lim2.replace("\n", " ")[:90])
    out_miss = run(db, pid, "search_cards", {"query": "量子色动力学"}, store)
    check("search_cards 无命中如实说明", "没有匹配" in out_miss, out_miss[:80])

    # ---------- 4. search_quiz（默认不剧透是语义边界，不能写错）----------
    out = run(db, pid, "search_quiz", {}, store)
    check("search_quiz 报出总题数", "共 2 道题" in out, out.replace("\n", " ")[:90])
    check("search_quiz 默认不带答案", "答案：" not in out)
    check("search_quiz 提示可再取答案", "include_answer" in out)
    check("search_quiz 已作答显示得分", "得分 50%" in out, out.split("\n")[0])
    check("search_quiz 列出选项", "时域 / 频域" in out)
    out_ans = run(db, pid, "search_quiz", {"include_answer": True}, store)
    check("search_quiz 带答案与解析", "答案：B" in out_ans and "解析：" in out_ans)
    out_q = run(db, pid, "search_quiz", {"query": "奈奎斯特"}, store)
    check("search_quiz 按关键词过滤", "共 2 道题" in out_q and "命中 1 道" in out_q, out_q.split("\n")[0])

    # ---------- 5. search_highlights ----------
    out = run(db, pid, "search_highlights", {}, store)
    check("search_highlights 两条收藏", "命中 2 条" in out, out.replace("\n", " ")[:90])
    check("search_highlights 显示我的批注", "我的批注：" in out and "注意归一化约定" in out)
    check("search_highlights 批注与原答案分行", "原答案：" in out)
    # 批注与原答案不能混成一句：note 是用户写的，answer 是原答案，语义不同
    check(
        "search_highlights 批注/原答案不串行",
        f"我的批注：{fav_note}" in out and f"原答案：{fav_answer}" in out,
        out.replace("\n", " ")[:110],
    )
    check("search_highlights 带高亮色", "高亮=yellow" in out)
    check("search_highlights 带章节", "第三章 傅里叶分析" in out)
    out_type = run(db, pid, "search_highlights", {"item_type": "quiz"}, store)
    # 断言具体内容而不是「我的批注」这个标签 —— 观察值末尾的【回答要求】行里也有这四个字
    check("search_highlights 按类型过滤",
          "命中 1 条" in out_type and "注意归一化约定" not in out_type,
          out_type.replace("\n", " ")[:110])
    out_q = run(db, pid, "search_highlights", {"query": "归一化"}, store)
    check("search_highlights 只靠批注也能命中", "命中 1 条" in out_q, out_q.split("\n")[0])

    # ---------- 6. get_study_kit ----------
    out = run(db, pid, "get_study_kit", {"kind": "cheatsheet"}, store)
    check("get_study_kit 读速查表", "一页速查表" in out and "绝对可积" in out, out.replace("\n", " ")[:90])
    out = run(db, pid, "get_study_kit", {"kind": "learning_path"}, store)
    check("get_study_kit 读学习路径", "## 前置知识" in out and "做采样定理的习题" in out)
    out_all = run(db, pid, "get_study_kit", {}, store)
    check("get_study_kit 省略 kind 读齐三种", "一页速查表" in out_all and "学习路径" in out_all)
    check("get_study_kit 未生成的如实说明", "清单报告】尚未生成" in out_all, out_all.replace("\n", " ")[:120])
    out_bad = run(db, pid, "get_study_kit", {"kind": "mindmap"}, store)
    check("get_study_kit 非法 kind 给出可选项", "未知的种类" in out_bad and "cheatsheet" in out_bad)
    out_none = run(db, pid, "get_study_kit", {"kind": "cheatsheet"}, None)
    check("get_study_kit 未接 store 时不崩", "没有接入学习台历存储" in out_none, out_none[:60])

    # ---------- 7. 空项目：只读工具不能抛 ----------
    empty = run(db, blank.project_id, "search_cards", {}, store)
    check("search_cards 空项目有提示", "还没有知识卡片" in empty, empty[:60])
    empty_q = run(db, blank.project_id, "search_quiz", {}, store)
    check("search_quiz 空项目有提示", "还没有生成小测验" in empty_q, empty_q[:60])
    empty_h = run(db, blank.project_id, "search_highlights", {}, store)
    check("search_highlights 空项目有提示", "还没有收藏" in empty_h, empty_h[:60])
    # 空项目 + 没有知识节点时也不能被「请先构建知识框架」短路掉
    check(
        "空项目不被节点守卫拦截",
        "构建知识框架" not in empty and "构建知识框架" not in empty_q and "构建知识框架" not in empty_h,
        empty[:60],
    )

    # ---------- 8. limit 夹取（模型给的数字不可信）----------
    check("_agent_limit 默认 8", a._agent_limit({}) == 8)
    check("_agent_limit 上限 20", a._agent_limit({"limit": 9999}) == 20)
    check("_agent_limit 负数归 1", a._agent_limit({"limit": -5}) == 1)
    check("_agent_limit 垃圾值回落默认", a._agent_limit({"limit": "abc"}) == 8)
    check("_agent_artifact_hit 空词表=命中", a._agent_artifact_hit(("任意",), []) is True)
    check(
        "_agent_artifact_hit 命中子串",
        a._agent_artifact_hit(("采样定理要求两倍",), ["采样"]) is True,
    )
    check(
        "_agent_artifact_hit 不命中",
        a._agent_artifact_hit(("采样定理",), ["狄拉克"]) is False,
    )

    # ---------- 9. 前端过程条标签不能漏 ----------
    # app.js 有自己一份 AGENT_TOOL_LABELS（对话区过程条渲染用）。漏加的表现是界面上
    # 直接显示英文工具名 recommend_links / search_cards 这种，所以必须交叉核对。
    import re

    app_js = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
    block = re.search(r"const AGENT_TOOL_LABELS = \{(.*?)\n\};", app_js, re.S)
    check("app.js 找得到 AGENT_TOOL_LABELS", block is not None)
    if block:
        frontend = set(re.findall(r"(\w+):", block.group(1)))
        missing = sorted(n for n in kb_names if n not in frontend)
        check("每个工具在前端都有中文标签", not missing, str(missing))

    # ---------- 10. 学习台历（打卡 + 冲刺 + 考期）----------
    planner = ExamScheduler(db.path)
    cal = run(db, pid, "get_learning_calendar", {"days": 14}, store,
              owner_id=owner, exam_scheduler=planner)
    check("get_learning_calendar 报打卡窗口", "打卡日历（近 14 天）" in cal, cal.split("\n")[0])
    check("get_learning_calendar 无计划时如实说明", "没有进行中的计划" in cal)
    check("get_learning_calendar 报考期段", "考期" in cal)
    cal_days = run(db, pid, "get_learning_calendar", {"days": 999}, store,
                   owner_id=owner, exam_scheduler=planner)
    check("get_learning_calendar days 被夹到 <=90", "近 90 天" in cal_days, cal_days.split("\n")[0])
    cal_bad = run(db, pid, "get_learning_calendar", {"days": "abc"}, store,
                  owner_id=owner, exam_scheduler=planner)
    check("get_learning_calendar 垃圾 days 回落默认", "近 14 天" in cal_bad)
    check("get_learning_calendar 无 owner 时不崩", "没有这个信息" in run(
        db, pid, "get_learning_calendar", {}, store, owner_id=None, exam_scheduler=planner))

    # ---------- 11. 复习文档（知识卡片旁的「＋文档」）----------
    doc_store = KnowledgeDocStore(db.path)
    nodes = db.list_framework_nodes(pid)
    check("有框架节点可挂文档", bool(nodes), str(len(nodes)))
    if nodes:
        node = nodes[0]
        doc_store.save(
            doc_key=doc_key_for(owner, pid, scope="node", node_id=node.node_id),
            owner_id=owner, project_id=pid, scope="node", node_id=node.node_id,
            title=f"{node.name}·复习文档", signature="sig1",
            content={"summary": "一句话把握：散射角越大波长增量越大。"},
            content_md="# 复习文档\n\n## 一句话把握\n散射角越大波长增量越大。\n\n## 易错\n忘带负号。",
        )
        out = run(db, pid, "search_knowledge_docs", {"node_id": node.node_id}, store,
                  owner_id=owner, knowledge_doc=doc_store)
        check("search_knowledge_docs 按 node_id 读到正文", "散射角越大波长增量越大" in out,
              out.replace("\n", " ")[:90])
        check("search_knowledge_docs 带回 node_id", f"node_id={node.node_id}" in out)
        out_all = run(db, pid, "search_knowledge_docs", {}, store,
                      owner_id=owner, knowledge_doc=doc_store)
        check("search_knowledge_docs 不给 node_id 返回清单", "复习文档" in out_all)
        out_q = run(db, pid, "search_knowledge_docs", {"query": "负号"}, store,
                    owner_id=owner, knowledge_doc=doc_store)
        check("search_knowledge_docs 按正文关键词过滤命中", "复习文档" in out_q,
              out_q.replace("\n", " ")[:80])
        out_q2 = run(db, pid, "search_knowledge_docs", {"query": "量子色动力学"}, store,
                     owner_id=owner, knowledge_doc=doc_store)
        check("search_knowledge_docs 按正文关键词过滤排除", f"{node.name}·复习文档" not in out_q2,
              out_q2.replace("\n", " ")[:80])
        out_miss = run(db, pid, "search_knowledge_docs", {"query": "量子色动力学"}, store,
                       owner_id=owner, knowledge_doc=doc_store)
        check("search_knowledge_docs 无命中如实说明", "还没有生成过复习文档" in out_miss, out_miss[:70])
        check("search_knowledge_docs 无 store 时不崩", "没有接入复习文档存储" in run(
            db, pid, "search_knowledge_docs", {}, store, owner_id=owner, knowledge_doc=None))
        blank_pid = blank.project_id
        check("search_knowledge_docs 空项目有提示", "还没有生成过复习文档" in run(
            db, blank_pid, "search_knowledge_docs", {}, store,
            owner_id=owner, knowledge_doc=doc_store))

        # ---- 以下四条钉住「文档在库里，Agent 却说没有 / 读不到后半份」的四种成因。
        # 每一条都对应一次真实故障，删掉任何一条断言都会让故障悄悄回来 ----

        # ① 模型把**节点名**当 node_id 传（它手里只有 get_framework 的输出）。
        #    以前只按 id 查，查不到就说「还没有生成过」，用户白等一场生成。
        out_name = run(db, pid, "search_knowledge_docs", {"node_id": node.name}, store,
                       owner_id=owner, knowledge_doc=doc_store)
        check("① node_id 传节点名也要读到", "散射角越大波长增量越大" in out_name,
              out_name.replace("\n", " ")[:90])
        check("① 节点名命中后说明真实 node_id", f"node_id={node.node_id}" in out_name)
        out_name2 = run(db, pid, "search_knowledge_docs", {"node_name": node.name}, store,
                        owner_id=owner, knowledge_doc=doc_store)
        check("① node_name 参数同样能定位", "散射角越大波长增量越大" in out_name2)

        # ② 找不到的名字要说清「有这些」，不能判「没生成过」——
        #    否则模型会叫用户重新生成一篇已经存在的文档。
        out_unknown = run(db, pid, "search_knowledge_docs", {"node_id": "并不存在的知识点"}, store,
                          owner_id=owner, knowledge_doc=doc_store)
        check("② 名字找不到时列出可选项", "复习文档" in out_unknown
              and "还没有生成过复习文档" not in out_unknown, out_unknown.replace("\n", " ")[:90])

        # ③ 按小节取：整篇硬截断会让「易错点」「自测」永远读不到。
        out_sec = run(db, pid, "search_knowledge_docs",
                      {"node_id": node.node_id, "section": "易错"}, store,
                      owner_id=owner, knowledge_doc=doc_store)
        check("③ section 能精确取到后半份", "忘带负号" in out_sec, out_sec.replace("\n", " ")[:90])
        check("③ 取小节时不带别的小节", "一句话把握" not in out_sec)
        out_sec_miss = run(db, pid, "search_knowledge_docs",
                           {"node_id": node.node_id, "section": "量子色动力学"}, store,
                           owner_id=owner, knowledge_doc=doc_store)
        check("③ section 对不上时列出真实小节", "一句话把握" in out_sec_miss,
              out_sec_miss.replace("\n", " ")[:90])

        # ④ 合订稿（scope=project）必须有独立入口，且能按知识点取完整一节。
        doc_store.save(
            doc_key=doc_key_for(owner, pid, scope="project"),
            owner_id=owner, project_id=pid, scope="project", node_id="",
            title="整份合订稿", signature="sig2", content={},
            content_md=f"# 整份合订稿\n\n## 目录\n\n## 1. {node.name}\n\n"
                       f"### 一句话把握\n散射角越大波长增量越大。\n\n"
                       f"### 易错\n忘带负号。\n",
        )
        out_proj = run(db, pid, "search_knowledge_docs", {"scope": "project"}, store,
                       owner_id=owner, knowledge_doc=doc_store)
        check("④ scope=project 读到合订稿", "整份合订稿" in out_proj, out_proj[:80])
        out_proj_sec = run(db, pid, "search_knowledge_docs",
                           {"scope": "project", "section": node.name}, store,
                           owner_id=owner, knowledge_doc=doc_store)
        check("④ 合订稿按知识点取节连子节一起给",
              "散射角越大波长增量越大" in out_proj_sec and "忘带负号" in out_proj_sec,
              out_proj_sec.replace("\n", " ")[:90])
        check("④ 列举时合订稿被标成整份",
              "整份合订稿" in run(db, pid, "search_knowledge_docs", {}, store,
                                  owner_id=owner, knowledge_doc=doc_store))

        # ⑤ 分页：原来只回一句「还有 N 篇未显示」，模型没有 offset 就只能干瞪眼。
        out_page = run(db, pid, "search_knowledge_docs", {"offset": 1, "limit": 1}, store,
                       owner_id=owner, knowledge_doc=doc_store)
        check("⑤ offset 能翻页", "第 2~2 篇" in out_page, out_page.replace("\n", " ")[:90])

    # ---------- 11b. 资料清单 ----------
    # 为什么单独一节：用户嘴里的「文献 / 文档 / 存了什么」指的是上传的 PDF，
    # 而 search_knowledge_docs 里的「复习文档」是另一回事 —— 同一个词两个东西。
    # 以前没有工具能列资料，模型问「我的文献存了哪些内容」时手里没有关键词，
    # 就退去刨速查表，把速查表内容复述成「你的文献里写了…」，答得煞有介事却全不对。
    srcs = db.list_sources(pid)
    out = a._agent_source_listing(srcs)
    check("list_sources 报出资料条数", "共 1 份资料" in out, out.replace("\n", " ")[:80])
    check("list_sources 给出文件名", "chap1.pdf" in out)
    check("list_sources 给出 source_id（模型要靠它再检索）",
          "src_" in out and "source_id=" in out)
    check("list_sources 从 [[H:n]] 提出目录",
          "Chapter 2 Wavefunction" in out and "2.2 Photoelectric Effect" in out,
          out.replace("\n", " ")[:120])
    check("list_sources 目录不被正文噪声淹没", "没有标题的段落" not in out)
    check("list_sources 指路到 search_sources", "search_sources" in out)
    check("list_sources 没有资料时如实说",
          "还没有上传任何资料" in a._agent_source_listing([]))
    check("list_sources 没混进别的项目的资料",
          "chap1.pdf" in out and "空白" not in out)
    out_blank_src = a._agent_source_listing(db.list_sources(blank.project_id))
    check("list_sources 空项目不崩", "还没有上传任何资料" in out_blank_src)
    # search_sources 必须保留 query 必填：它是检索，不是清单
    search_schema = next(t["function"] for t in a.LEARNING_AGENT_TOOLS
                         if t["function"]["name"] == "search_sources")
    check("search_sources 仍要求 query（别被改成万能工具）",
          search_schema["parameters"].get("required") == ["query"])

    # ---------- 12. 薄弱点选项（提议型动作）----------
    staged: list[dict] = []
    out = run(db, pid, "plan_study_action",
              {"node_name": nodes[0].name, "kinds": ["card", "quiz"], "reason": "掌握度只有 20%"},
              store, owner_id=owner, staged=staged, nodes=nodes)
    check("plan_study_action 走待确认闸门", out.startswith("[待用户确认]"), out[:60])
    check("plan_study_action 确实登记了一条", len(staged) == 1, str(len(staged)))
    action = staged[0] if staged else {}
    check("plan_study_action tool 名正确", action.get("tool") == "plan_study_action", str(action.get("tool")))
    check("plan_study_action label 是人话", "针对「" in str(action.get("label"))
          and "生成知识卡片" in str(action.get("label")), str(action.get("label")))
    # 关键：前端按 arguments.node_id 调端点、按 arguments.kinds 渲染按钮，
    # 模型只给了 node_name 时，必须在这里换成权威 id —— 而且必须发生在登记之前。
    check("plan_study_action 把 node_name 换成 node_id",
          action.get("arguments", {}).get("node_id") == nodes[0].node_id,
          str(action.get("arguments")))
    check("plan_study_action kinds 归一化",
          action.get("arguments", {}).get("kinds") == ["card", "quiz"],
          str(action.get("arguments", {}).get("kinds")))
    check("plan_study_action 提示语不说写库", "尚未执行任何生成" in out, out[:90])

    staged_bad: list[dict] = []
    out_bad = run(db, pid, "plan_study_action", {"node_name": "不存在的知识点"}, store,
                  owner_id=owner, staged=staged_bad, nodes=nodes)
    check("plan_study_action 节点不存在时不登记", not staged_bad, str(staged_bad))
    check("plan_study_action 节点不存在时给出下一步", "get_framework" in out_bad, out_bad[:80])

    staged_default: list[dict] = []
    run(db, pid, "plan_study_action", {"node_id": nodes[0].node_id, "kinds": ["乱写的", "doc"]},
        store, owner_id=owner, staged=staged_default, nodes=nodes)
    check("plan_study_action 过滤非法 kind 并兜底",
          staged_default[0]["arguments"]["kinds"] == ["doc"],
          str(staged_default[0]["arguments"]["kinds"]))
    staged_empty: list[dict] = []
    run(db, pid, "plan_study_action", {"node_id": nodes[0].node_id}, store,
        owner_id=owner, staged=staged_empty, nodes=nodes)
    check("plan_study_action 不给 kinds 兜底为 focus",
          staged_empty[0]["arguments"]["kinds"] == ["focus"],
          str(staged_empty[0]["arguments"]["kinds"]))

    # 非闸门路径（知识库 Agent 面板）：不能假装执行了生成
    out_panel = run(db, pid, "plan_study_action", {"node_id": nodes[0].node_id, "kinds": ["card"]},
                    store, owner_id=owner, staged=None, nodes=nodes)
    check("plan_study_action 无确认卡片时不假装执行", "没有确认卡片" in out_panel, out_panel[-90:])
    # 提议型工具绝不能混进写工具集合：那个集合决定 /agent/actions/execute 放行哪些动作
    check("plan_study_action 不在写工具集合", "plan_study_action" not in a.AGENT_WRITE_TOOLS)
    check("plan_study_action 在提议工具集合", "plan_study_action" in a.AGENT_OFFER_TOOLS)

    # ---------- 13. 选项全集：生成族 7 项 + 跳转族 7 项 ----------
    all_kinds = set(a.AGENT_STUDY_ACTION_LABELS)
    expected_kinds = {
        "card", "quiz", "doc", "focus", "cheatsheet", "learning_path", "checklist",
        "view_cards", "view_quiz", "view_framework", "view_overview",
        "view_cheatsheet", "view_learning_path", "view_checklist",
    }
    check("提议型选项全集 = 生成族 7 项 + 跳转族 7 项",
          all_kinds == expected_kinds, str(sorted(all_kinds)))
    check("每种选项都有非空中文文案",
          all(str(v).strip() for v in a.AGENT_STUDY_ACTION_LABELS.values()),
          str(a.AGENT_STUDY_ACTION_LABELS))
    check("跳转族 = 全部 view_ 前缀且不需要知识点",
          a.AGENT_STUDY_ACTION_NODE_FREE_KINDS == {k for k in all_kinds if k.startswith("view_")},
          str(sorted(a.AGENT_STUDY_ACTION_NODE_FREE_KINDS)))
    check("生成族 = 全集减去跳转族",
          a.AGENT_STUDY_ACTION_NODE_KINDS == expected_kinds - a.AGENT_STUDY_ACTION_NODE_FREE_KINDS,
          str(sorted(a.AGENT_STUDY_ACTION_NODE_KINDS)))
    check("两个节点集合不重叠且并起来等于全集",
          not (a.AGENT_STUDY_ACTION_NODE_FREE_KINDS & a.AGENT_STUDY_ACTION_NODE_KINDS)
          and (a.AGENT_STUDY_ACTION_NODE_FREE_KINDS | a.AGENT_STUDY_ACTION_NODE_KINDS) == all_kinds)
    # 成文产物三类必须复用 study_kit.KINDS 的取值：前端要原样透传给 generate 端点，
    # 一旦两边各写一套字符串，选项就会变成 400 invalid_study_kit_kind。
    check("成文产物选项 key 与 study_kit.KINDS 同名",
          a.AGENT_STUDY_ACTION_KIT_KINDS == set(a.study_kit_mod.KINDS),
          str(sorted(a.AGENT_STUDY_ACTION_KIT_KINDS)))
    check("成文产物选项的文案与台历里显示的一致（别出现「学习清单」vs「清单报告」）",
          all(a.AGENT_STUDY_ACTION_LABELS[k] == "生成" + a.study_kit_mod.KIND_LABELS[k]
              for k in a.AGENT_STUDY_ACTION_KIT_KINDS),
          str({k: a.AGENT_STUDY_ACTION_LABELS[k] for k in sorted(a.AGENT_STUDY_ACTION_KIT_KINDS)}))
    # schema 的 enum 必须覆盖全集：模型只能从 enum 里挑，漏一个它就永远不会给那个选项
    offer_schema = next(t["function"] for t in a.LEARNING_AGENT_TOOLS
                        if t["function"]["name"] == "plan_study_action")
    schema_enum = set(offer_schema["parameters"]["properties"]["kinds"]["items"]["enum"])
    check("plan_study_action schema 的 kinds enum 覆盖全部选项",
          schema_enum == all_kinds, str(sorted(schema_enum)))

    # ---------- 14. 跳转族不绑知识点也能登记 ----------
    staged_jump: list[dict] = []
    out_jump = run(db, pid, "plan_study_action",
                   {"kinds": ["view_cards", "view_cheatsheet"], "reason": "你上次问过它在哪"},
                   store, owner_id=owner, staged=staged_jump, nodes=nodes)
    check("跳转族不给节点也能登记", len(staged_jump) == 1, str(len(staged_jump)))
    jump_args = staged_jump[0]["arguments"] if staged_jump else {}
    check("跳转族的 node_id 被显式置空而不是留模型编的值",
          jump_args.get("node_id") == "" and jump_args.get("node_name") == "",
          str(jump_args))
    check("跳转族的 label 不编造「针对某个知识点」",
          "针对「" not in str(staged_jump[0].get("label")), str(staged_jump[0].get("label")))
    check("跳转族提示语说清只跳转不生成（别让模型去「推荐」一次打开卡片）",
          "尚未切页面" in out_jump and "执行任何生成" not in out_jump, out_jump[:90])

    # 生成族仍然必须有节点：没有它前端按钮点不动，硬登记等于给一个必然失败的按钮
    staged_need: list[dict] = []
    run(db, pid, "plan_study_action", {"kinds": ["cheatsheet"]},
        store, owner_id=owner, staged=staged_need, nodes=nodes)
    check("生成族没有节点时不登记", not staged_need, str(staged_need))
    # 混合时也要能定位节点：只要有一个生成族选项就必须有节点
    staged_mix: list[dict] = []
    run(db, pid, "plan_study_action",
        {"kinds": ["view_cards", "learning_path"], "node_name": nodes[0].name},
        store, owner_id=owner, staged=staged_mix, nodes=nodes)
    check("生成族与跳转族混合时照样把 node_name 换成 node_id",
          len(staged_mix) == 1 and staged_mix[0]["arguments"]["node_id"] == nodes[0].node_id,
          str(staged_mix))

    # ---------- 15. 前端必须与后端口径一致 ----------
    app_js = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
    js_block = re.search(r"const AGENT_STUDY_ACTION_NEEDS_NODE = \{(.*?)\};", app_js, re.S)
    js_needs = set(re.findall(r"(\w+)\s*:\s*(?:true|false)", js_block.group(1))) if js_block else set()
    check("前端 AGENT_STUDY_ACTION_NEEDS_NODE 与后端选项全集一致",
          js_needs == all_kinds, str(sorted(js_needs)))
    if js_block:
        node_yes = set(re.findall(r"(\w+)\s*:\s*true", js_block.group(1)))
        node_no = set(re.findall(r"(\w+)\s*:\s*false", js_block.group(1)))
        check("前端「需要节点」的项与后端 AGENT_STUDY_ACTION_NODE_KINDS 一致",
              node_yes == set(a.AGENT_STUDY_ACTION_NODE_KINDS), str(sorted(node_yes)))
        check("前端「不需要节点」的项与后端 AGENT_STUDY_ACTION_NODE_FREE_KINDS 一致",
              node_no == set(a.AGENT_STUDY_ACTION_NODE_FREE_KINDS), str(sorted(node_no)))
    js_kits = re.search(r"const AGENT_STUDY_ACTION_KIT_KINDS = \[(.*?)\];", app_js, re.S)
    check("前端的成文产物 key 与后端一致",
          set(re.findall(r'"(\w+)"', js_kits.group(1))) == set(a.study_kit_mod.KINDS) if js_kits else False,
          js_kits.group(1).strip() if js_kits else "没找到常量")
    js_jumps = re.search(r"const AGENT_STUDY_ACTION_JUMPS = \{(.*?)\n\};", app_js, re.S)
    js_jump_keys = set(re.findall(r"(\w+):", js_jumps.group(1))) if js_jumps else set()
    check("每个跳转族选项都有落点（漏一个就是点了没反应）",
          js_jump_keys == set(a.AGENT_STUDY_ACTION_NODE_FREE_KINDS),
          str(sorted(js_jump_keys)))
    check("前端 KnowOriginDesk 导出了 open（跳转速查表/路径/清单要靠它）",
          "mountView, open" in (ROOT / "static" / "study-desk-ui.js").read_text(encoding="utf-8"))

    store.close()
    doc_store.close()
    db.close()

    print()
    if FAILURES:
        print(f"FAIL：{len(FAILURES)} 项")
        for item in FAILURES:
            print(f"  - {item}")
        sys.exit(1)
    print("Agent 只读产物工具回归全部通过。")


if __name__ == "__main__":
    main()
