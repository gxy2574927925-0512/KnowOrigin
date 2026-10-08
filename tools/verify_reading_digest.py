"""读书收获引擎回归（纯函数，不需要 key / 网络 / 数据库）。

跑法：``python tools/verify_reading_digest.py``

覆盖 ——
  1. 分类：规则层能把原生分类 / 标题 / 标签收敛到一级领域；认不出归「其他」
  2. 收获文档：逐字段校验 —— 坏字段只退回该字段的兜底，好字段照用
  3. 简介：字段成色门槛、level 白名单、category 收敛
  4. payload：划线/想法超量时被截断（不把整本书塞进一次调用）
  5. 渲染：Markdown 小节齐全，金句用引用块，清单用复选框
  6. 本地兜底：模型不可用时不编造 thesis/models，只原样呈现用户自己的划线
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from core import reading_digest as rd  # noqa: E402

FAILS = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


# ---------------------------------------------------------------- 1. 分类

check("原生分类「文学-小说」→ 文学小说", rd.guess_category(native_category="文学-小说") == "文学小说")
check("标题含「经济学」→ 经济管理", rd.guess_category(title="薛兆丰经济学讲义") == "经济管理")
check("标签含「人工智能」→ 科技互联网", rd.guess_category(topics=["人工智能", "算法"]) == "科技互联网")
check("最长关键词优先（经济管理 > 其他）",
      rd.guess_category(title="经济学与心理学") == "经济管理",
      rd.guess_category(title="经济学与心理学"))
check("认不出 → 其他", rd.guess_category(title="某某某") == "其他")
check("空输入 → 其他", rd.guess_category() == "其他")

# 英文标签：古腾堡 / Open Library 的标题与主题几乎全是英文，必须也能分类
check("英文 Fiction → 文学小说",
      rd.guess_category(title="Pride and Prejudice", topics=["Courtship -- Fiction"]) == "文学小说")
check("英文 Science fiction 归文学而非自然科学（最长匹配）",
      rd.guess_category(topics=["Science fiction"]) == "文学小说",
      rd.guess_category(topics=["Science fiction"]))
check("英文 Economics → 经济管理", rd.guess_category(topics=["Economics"]) == "经济管理")
check("英文 History → 历史", rd.guess_category(topics=["History"]) == "历史")
check("英文大小写不敏感", rd.guess_category(topics=["FICTION"]) == "文学小说")
# 词边界：art 不能命中 heart / artificial 不能只命中 art
check("art 不误命中 heart",
      rd.guess_category(topics=["Heart disease"]) != "艺术设计",
      rd.guess_category(topics=["Heart disease"]))
check("artificial intelligence → 科技互联网（不被 art 抢走）",
      rd.guess_category(topics=["Artificial intelligence"]) == "科技互联网",
      rd.guess_category(topics=["Artificial intelligence"]))
check("normalize_category 收敛非法值", rd.normalize_category("随便什么") == "其他")
check("normalize_category 保留合法值", rd.normalize_category("历史") == "历史")


# ------------------------------------------------- 2. 收获文档逐字段校验

raw = {
    "thesis": "短",                      # 太短 → 退回兜底
    "core_arguments": [{"point": "作者认为制度比技术更关键", "support": "用地方竞争举例", "where": "第三章"}],
    "models": [{"name": "地方竞争", "what": "政府之间为增长互相竞争", "how_to_use": "看地方政策时先问它在跟谁竞争", "where": "第二章"}],
    "insights": [],                      # 空 → 退回兜底
    "actions": ["下次看到地方招商政策，先找它的对标城市"],
    "quotes": [{"text": "制度的差异比技术的差异更持久", "where": "第三章"}],
    "connections": [],
    "self_check": [{"question": "为什么制度比技术更关键？", "answer": "因为制度决定了技术能不能被用起来。"}],
    "grounding": "来自第三章划线。",
}
fallback = {
    "thesis": "这本书讲地方政府如何推动经济增长。",
    "insights": [{"common_belief": "增长主要靠技术", "book_view": "增长主要靠制度安排", "why": "技术要落地得先有激励"}],
}
out = rd.normalize_digest_result(raw, fallback)

check("坏 thesis 退回兜底", out["thesis"] == fallback["thesis"], out["thesis"])
check("好 core_arguments 保留", len(out["core_arguments"]) == 1 and out["core_arguments"][0]["where"] == "第三章")
check("空 insights 退回兜底", len(out["insights"]) == 1 and out["insights"][0]["book_view"] == "增长主要靠制度安排")
check("models 完整保留", out["models"][0]["how_to_use"].startswith("看地方政策"))
check("actions 保留", out["actions"] == ["下次看到地方招商政策，先找它的对标城市"])
check("grounding 保留", out["grounding"] == "来自第三章划线。")

# 主字段不达标 → 整条丢弃
bad = rd.normalize_digest_result(
    {"core_arguments": [{"point": "短", "support": "x"}, {"point": "这是一条足够长的核心论点表述", "support": "论证"}]},
    {},
)
check("主字段不达标的条目被丢弃", len(bad["core_arguments"]) == 1, str(len(bad["core_arguments"])))

# 非 dict 输入不炸
check("非 dict 输入 → 全兜底不炸", rd.normalize_digest_result("不是字典", {"thesis": "兜底主张"})["thesis"] == "兜底主张")
check("None 输入不炸", rd.normalize_digest_result(None, None)["models"] == [])


# --------------------------------------------------------- 3. 简介校验

intro_out = rd.normalize_intro_result(
    {
        "one_liner": "一本讲地方政府行为的经济学读物。",
        "intro": "这本书从地方政府的角度解释中国经济增长……（足够长的介绍正文，超过六十个字符的下限要求，用于通过成色门槛校验）",
        "topics": ["经济学", "中国经济", "地方政府"],
        "level": "大师级",          # 非法 → 清空
        "use_case": "想理解地方政策逻辑时读",
        "category": "经济管理",
    },
    {},
)
check("简介 one_liner 保留", intro_out["one_liner"].startswith("一本讲地方政府"))
check("非法 level 被清空", intro_out["level"] == "", repr(intro_out["level"]))
check("topics 保留", len(intro_out["topics"]) == 3)
check("category 合法值保留", intro_out["category"] == "经济管理")

short_intro = rd.normalize_intro_result({"intro": "太短"}, {"intro": "这是一段足够长的兜底介绍正文，用于在模型字段不达标时补位，确保长度超过六十个字符的下限。"})
check("短 intro 退回兜底", short_intro["intro"].startswith("这是一段足够长"))
check("非法 category 退回兜底或其他", rd.normalize_intro_result({"category": "瞎写"}, {})["category"] == "其他")


# --------------------------------------------------------- 4. payload 截断

many = [{"mark_text": f"划线{i}" * 3, "chapter_name": "第一章"} for i in range(200)]
payload = rd.build_digest_payload(title="测试书", highlights=many, thoughts=[{"text": "想法"}] * 100)
check("划线被截断到上限", len(payload["highlights"]) == rd.MAX_HIGHLIGHTS, str(len(payload["highlights"])))
check("想法被截断到上限", len(payload["thoughts"]) == rd.MAX_THOUGHTS, str(len(payload["thoughts"])))
check("payload 带 schema 与 rules", "schema" in payload and "rules" in payload)
check("payload 带书名", payload["book"]["title"] == "测试书")

intro_payload = rd.build_intro_payload(title="测试书", categories=rd.CATEGORIES)
check("简介 payload 带候选分类", len(intro_payload["category_options"]) == len(rd.CATEGORIES))
check("简介 payload 划线截断到 20", len(rd.build_intro_payload(title="x", highlights=many)["highlights"]) == 20)


# --------------------------------------------------------- 5. Markdown 渲染

md = rd.render_digest_markdown(out, title="置身事内", author="兰小欢")
for section in ("# 《置身事内》· 读书收获", "## 一、这本书在讲什么", "## 二、可以拿走的模型与框架",
                "## 四、明天就能用上的清单", "## 五、值得留下的原话", "## 自测：真的读进去了吗",
                "依据说明"):
    check(f"渲染含小节「{section}」", section in md, md[:60])
check("金句用引用块", "> 制度的差异比技术的差异更持久" in md)
check("清单用复选框", "- [ ] 下次看到地方招商政策" in md)
check("空小节不渲染", "## 三、反常识的地方" not in md or "多数人" in md)

intro_md = rd.render_intro_markdown(intro_out, title="置身事内")
check("简介渲染含分类", "分类：经济管理" in intro_md)
check("简介渲染含标签", "经济学" in intro_md)


# --------------------------------------------------------- 5.5 逐章精读

# payload：章节目录要真的传进去（不给 chapters，模型只能写整体摘要 —— 这正是
# 「收获太少、没按章节展开」的根因）
ch_payload = rd.build_digest_payload(
    title="测试书",
    chapters=[
        {"title": "第一章 起点", "highlights": ["划线甲", "划线乙"]},
        {"title": "第二章 转折", "excerpt": "正文摘录" * 50},
        {"title": "第三章 收束"},          # 没材料也要传，让文档覆盖全书
    ],
)
check("chapters 进了 payload", len(ch_payload["chapters"]) == 3, str(len(ch_payload["chapters"])))
check("章的划线被带上", ch_payload["chapters"][0]["highlights"] == ["划线甲", "划线乙"])
check("章的正文摘录被带上", ch_payload["chapters"][1]["excerpt"].startswith("正文摘录"))
check("没有材料的章也保留（不静默少章）", ch_payload["chapters"][2]["title"] == "第三章 收束")
check("章数超量被截断",
      len(rd.build_digest_payload(title="x", chapters=[{"title": f"第{i}章"} for i in range(60)])["chapters"])
      == rd.MAX_CHAPTERS)

# 归一化：summary 太短的章要保留但清空 summary（渲染成「材料不足」），
# **不能整条丢掉** —— 丢了用户就以为这本书没那几章。
ch_out = rd.normalize_digest_result({
    "chapters": [
        {"title": "第一章 起点", "summary": "这一章讲了起点相关的三件事，并给出了一个判断框架。",
         "key_points": ["要点甲：先定位问题", "要点乙：再找对标"], "takeaway": "先找对标城市再判断"},
        {"title": "第二章 转折", "summary": "太短", "key_points": [], "takeaway": ""},
        {"title": "", "summary": "没有标题的条目应被丢弃"},
    ]
}, {})
check("章数正确（无标题的被丢弃）", len(ch_out["chapters"]) == 2, str(len(ch_out["chapters"])))
check("正常章保留 summary", ch_out["chapters"][0]["summary"].startswith("这一章讲了起点"))
check("正常章保留 key_points", len(ch_out["chapters"][0]["key_points"]) == 2)
check("summary 太短的章**仍然保留**（清空 summary 而不是丢章）",
      ch_out["chapters"][1]["title"] == "第二章 转折" and ch_out["chapters"][1]["summary"] == "")

md_ch = rd.render_digest_markdown(ch_out, title="测试书")
check("渲染出「逐章精读」小节", "逐章精读" in md_ch, md_ch[:80])
check("每章一个小标题", md_ch.count("### 第") >= 2, str(md_ch.count("### 第")))
check("材料不足的章如实标注", "本章材料不足" in md_ch)
check("章的 takeaway 被渲染", "拿走这一条" in md_ch)
check("有 chapters 时判定为有内容", rd.digest_has_content({"chapters": ch_out["chapters"]}))

# 动态编号：没有 insights 时，后面的小节序号要跟着前移（不能写死「三、」）
md_no_insight = rd.render_digest_markdown({
    "thesis": "主张", "chapters": [], "core_arguments": [],
    "models": [], "insights": [], "actions": ["做一件事"],
    "quotes": [], "connections": [], "self_check": [], "grounding": "",
}, title="x")
check("无前序小节时 actions 是「一、」而不是写死的「四、」", "## 一、明天就能用上的清单" in md_no_insight,
      md_no_insight[:120])
check("自测小节标题不带序号（锚点才稳定）", "、" not in rd.DIGEST_SELF_CHECK_SECTION,
      rd.DIGEST_SELF_CHECK_SECTION)
check("兜底结果含 chapters 键", rd.build_digest_fallback(title="x")["chapters"] == [])


# --------------------------------------------------------- 6. 本地兜底不编造

fb = rd.build_digest_fallback(
    title="置身事内",
    highlights=[{"mark_text": "制度的差异比技术更持久", "chapter_name": "第三章"}],
    thoughts=[{"text": "这句话点醒了我"}],
)
check("兜底不编 thesis", fb["thesis"] == "")
check("兜底不编 models", fb["models"] == [])
check("兜底不编 insights", fb["insights"] == [])
check("兜底保留用户划线", fb["quotes"][0]["text"] == "制度的差异比技术更持久")
check("兜底自报家门", "未能生成" in fb["grounding"])
check("兜底有内容判定为真", rd.digest_has_content(fb))
check("全空判定为假", not rd.digest_has_content({"thesis": "", "models": [], "core_arguments": [], "actions": [], "quotes": []}))

fb_intro = rd.build_intro_fallback(title="置身事内", book_intro="一本讲地方政府的经济学读物，作者是兰小欢。", native_category="经济理财-理财")
check("简介兜底用书籍自带简介", fb_intro["intro"].startswith("一本讲地方政府"))
check("简介兜底规则分类", fb_intro["category"] == "经济管理", fb_intro["category"])


# ------------------------------------- 7. 材料状态：有料 vs 空料，产出定位不同

# 有用户自己的划线 → personal（读书收获）
p_personal = rd.build_digest_payload(
    title="置身事内", highlights=[{"mark_text": "制度比技术更持久"}]
)
check("有划线 → mode=personal", p_personal["mode"] == "personal", p_personal["mode"])
check("material 计入个人划线", p_personal["material"]["personal_highlights"] == 1)
check("personal 不挂 scope 声明", rd.digest_scope_note(p_personal["material"]) == "")

# 一条划线都没有 → book（书籍导读），且**必须在指令里换定位**
p_book = rd.build_digest_payload(
    title="纳瓦尔宝典", book_intro="讲财富与幸福的对话集。", chapters=["第一章 财富"]
)
check("无划线 → mode=book", p_book["mode"] == "book", p_book["mode"])
check("book 模式指令明说「不是他的阅读收获」",
      "不是他的阅读收获" in p_book["instruction"], p_book["instruction"][:60])
check("book 模式指令禁止写「你划的这条线」",
      "你划的这条线" in p_book["instruction"])
check("book 模式仍把简介算作材料", p_book["material"]["intro_chars"] > 0)
note = rd.digest_scope_note(p_book["material"])
check("book 模式挂出如实声明", "书籍导读" in note and "还没有任何划线" in note, note[:40])

# 全空 → 不调模型，直接「材料不足」
empty_material = {
    "personal_highlights": 0, "personal_thoughts": 0, "reviews": 0,
    "hot_highlights": 0, "excerpts": 0, "chapters": 0, "intro_chars": 0,
}
check("全空被判定为空", rd.material_is_empty(empty_material))
check("有一项就不算空", not rd.material_is_empty({**empty_material, "chapters": 3}))
check("有划线也不算空", not rd.material_is_empty({**empty_material, "personal_highlights": 1}))
ins = rd.build_insufficient_digest(title="空材料书", material=empty_material)
check("材料不足不编任何内容",
      not ins["thesis"] and not ins["models"] and not ins["chapters"] and not ins["actions"])
check("材料不足说清怎么办", "可用于归纳的材料" in ins["grounding"] and "导入" in ins["grounding"])
check("材料不足判定为无内容", not rd.digest_has_content(ins))


# ------------------------------------- 8. 逻辑主线（spine）与渲染

p_spine = rd.build_digest_payload(
    title="置身事内",
    highlights=[{"mark_text": "制度比技术更持久"}],
    chapters=[{"title": "第一章 地方政府的权力与事务", "excerpt": "讲清条块关系。"}],
)
check("payload 带 spine 字段说明", "spine" in p_spine["schema"])

raw_spine = {
    "thesis": "地方政府为增长而竞争，是理解中国经济的一把钥匙。",
    "spine": ["作者要回答：为什么中国的地方政府这么像公司",
              "主张：增长靠的是地方政府之间的竞争",
              "论证：用土地、财政与官员晋升三条线串起来",
              "结论：理解政策，先看它在跟谁竞争"],
    "chapters": [{"title": "第一章 地方政府的权力与事务", "summary": "讲清条块关系与财政分成。"}],
    "core_arguments": [], "models": [], "insights": [], "actions": [],
    "quotes": [], "connections": [], "self_check": [],
    "grounding": "来自第一章划线。",
}
norm_spine = rd.normalize_digest_result(raw_spine, {})
check("spine 被归一化保留", len(norm_spine["spine"]) == 4, str(len(norm_spine["spine"])))
check("spine 计入 has_content", rd.digest_has_content(norm_spine))

md_spine = rd.render_digest_markdown(norm_spine, title="置身事内", author="兰小欢")
check("渲染出「全书逻辑主线」", "## 一、全书逻辑主线" in md_spine, md_spine[:120])
check("逻辑主线排在逐章精读之前",
      md_spine.index("全书逻辑主线") < md_spine.index("逐章精读"))
check("逻辑主线用有序列表", "1. 作者要回答" in md_spine)

# 太短的 spine 条目被丢掉（模型偶尔会塞「见上」这种占位）
short_spine = rd.normalize_digest_result({"spine": ["嗯", "这是一条足够长的逻辑主线说明"]}, {})
check("过短的 spine 条目被丢弃", short_spine["spine"] == ["这是一条足够长的逻辑主线说明"], str(short_spine["spine"]))

# scope 声明必须出现在正文最前面（无个人材料时）
md_scope = rd.render_digest_markdown(
    norm_spine, title="纳瓦尔宝典", scope_note=rd.digest_scope_note(p_book["material"])
)
check("scope 声明在正文里且靠前",
      "书籍导读" in md_scope and md_scope.index("书籍导读") < md_scope.index("一句话主张"))


# ------------------------------------- 9. 方法论落地：主动阅读四问 + 检视阅读

# ③「这本书说得有道理吗」—— critique（主张 / 成立条件 / 站不住的地方）
raw_full = {
    "thesis": "地方政府为增长而竞争，是理解中国经济的一把钥匙。",
    "spine": ["提出问题：地方政府在经济奇迹里扮演什么角色", "结论：看政策先看它在跟谁竞争"],
    "core_arguments": [{"point": "地方竞争是理解一切的起点", "support": "", "where": ""}],
    "models": [{"name": "地方竞争", "what": "政府之间为增长互相竞争", "how_to_use": "看政策先找对标城市", "where": ""}],
    "insights": [], "actions": ["看政策先找对标城市"], "quotes": [],
    "connections": [
        {"name": "激励错配", "relation": "支持", "note": "制度设计与个人决策的共同底层"},
        {"name": "另一种观点", "relation": "彼此相反", "note": "认为增长主要来自市场而非政府"},
        {"name": "没写类型的", "note": "模型偶尔会漏字段，要能兜住"},
    ],
    "critique": [
        {"claim": "地方竞争是增长的主要动力",
         "holds": "在要素可流动、官员有晋升激励的阶段成立",
         "breaks": "当土地与债务约束收紧、考核改为多元目标时，竞争会转向形式主义"},
    ],
    "self_check": [{"question": "为什么说债务是竞争机制的自然产物？", "answer": "举债=用未来收入为当下竞争买单。"}],
    "grounding": "来自第三章划线。",
}
full = rd.normalize_digest_result(raw_full, {})
check("critique 被保留", len(full["critique"]) == 1, str(len(full["critique"])))
check("critique 三要素都在",
      full["critique"][0]["claim"] and full["critique"][0]["holds"] and full["critique"][0]["breaks"])
check("relation 原样保留（支持）", full["connections"][0]["relation"] == "支持")
check("relation 同义说法被回收（彼此相反 → 对立）",
      full["connections"][1]["relation"] == "对立", str(full["connections"][1]["relation"]))
check("relation 缺失时兜成「相关」",
      full["connections"][2]["relation"] == "相关", str(full["connections"][2]["relation"]))
check("normalize_relation 认不出也兜住", rd.normalize_relation("完全不像的词") == "相关")

md_full = rd.render_digest_markdown(full, title="置身事内", author="兰小欢")
check("渲染出「说得有道理吗」一节", "这本书说得有道理吗" in md_full)
check("critique 渲染出成立条件", "它在什么条件下成立" in md_full and "它站不住的地方" in md_full)
check("连接渲染出关系类型", "（支持）" in md_full and "（对立）" in md_full)
check("critique 排在连接之前",
      md_full.index("说得有道理吗") < md_full.index("和我的知识库的联系"))
check("过短的 critique 被丢弃",
      rd.normalize_digest_result({"critique": [{"claim": "嗯"}]}, {})["critique"] == [])

# 检视阅读：书籍介绍要给出「值不值得读 / 怎么读 / 先读哪几章」
intro_raw = {
    "one_liner": "一本讲地方政府如何介入经济的书",
    "intro": "本书从地方政府的角度解释中国经济的运行逻辑，涵盖土地财政、融资平台与债务。" * 2,
    "verdict": "想理解中国房价与地方债的来龙去脉，这本最值得读；只想看宏观趋势的可以跳过。",
    "read_mode": "选读",
    "key_chapters": ["第二章 财税与土地", "第五章 债务"],
    "topics": ["经济", "政府"], "level": "进阶",
    "use_case": "看到一条地方政策想弄懂它为什么这么做时",
    "category": "经济管理",
}
norm_intro = rd.normalize_intro_result(intro_raw, {})
check("verdict 被保留", "最值得读" in norm_intro["verdict"])
check("read_mode 合法值保留", norm_intro["read_mode"] == "选读")
check("key_chapters 被保留", len(norm_intro["key_chapters"]) == 2)
check("非法 read_mode 兜成选读", rd.normalize_intro_result({"read_mode": "随便读"}, {})["read_mode"] == "选读")
check("READ_MODES 含四档", set(rd.READ_MODES) == {"精读", "选读", "泛读", "略过"})
md_intro = rd.render_intro_markdown(norm_intro, title="置身事内")
check("介绍渲染出建议读法", "建议读法：选读" in md_intro)
check("介绍渲染出检视结论", "检视结论" in md_intro)
check("介绍渲染出先读哪几章", "先读这几处" in md_intro and "第二章 财税与土地" in md_intro)
check("兜底不编检视结论（那需要判断力）", rd.build_intro_fallback(title="x")["verdict"] == "")
check("RELATIONS 含六种", len(rd.RELATIONS) == 6 and "对立" in rd.RELATIONS)

# ---- 「我的判断」：调研里最重的一条（摘要 vs 收获的分界）----
# 依据：主流读书模板几乎都没有「我的判断」节，只有「作者说了什么」。
# 这一节是**必答项**，且必须带 confidence（1~5），便于按把握程度回看。
_judgment_raw = {
    "thesis": "地方政府为增长而展开竞争，是理解中国经济的一把钥匙。",
    "judgment": {
        "verdict": "只信一半：地方竞争解释增长很有力，但解释房价时把货币因素说轻了。",
        "confidence": 4,
        "why": "书里的土地财政链条对得上我看到的城投数据；但 2015 年以后的涨幅它没解释。",
        "when_not": "分析全国总量问题时不要用它，它只在地方视角下成立。",
        "open_questions": ["竞争格局在什么条件下会转向合作？", "这套框架对服务业还成立吗？"],
    },
}
_norm_j = rd.normalize_digest_result(_judgment_raw, {})
check("judgment 结构被保留",
      _norm_j["judgment"]["verdict"].startswith("只信一半")
      and _norm_j["judgment"]["confidence"] == 4
      and len(_norm_j["judgment"]["open_questions"]) == 2,
      str(_norm_j["judgment"]))
_md_j = rd.render_digest_markdown(_norm_j, title="置身事内")
check("渲染出「我的判断」一节", "我的判断（我自己怎么想）" in _md_j)
check("渲染出把握程度", "（把握 4/5）" in _md_j, _md_j[_md_j.find("我的判断"):][:80])
check("渲染出适用边界与待答问题",
      "什么情况下我不用它" in _md_j and "还没被回答的问题" in _md_j)
check("我的判断排在边界与反例之后",
      _md_j.index("说得有道理吗") < _md_j.index("我的判断"))

check("confidence 越界当没给（0 表示未表态）",
      rd.normalize_digest_result({"judgment": {"verdict": "我信这一套说法", "confidence": 9}}, {})["judgment"]["confidence"] == 0)
check("confidence 非数字也不炸",
      rd.normalize_digest_result({"judgment": {"verdict": "我信这一套说法", "confidence": "高"}}, {})["judgment"]["confidence"] == 0)
check("过短 verdict 且别无内容 → 视为模型没答",
      rd.normalize_digest_result({"judgment": {"verdict": "好"}}, {})["judgment"]["verdict"] == "")
check("缺 judgment 时结构仍在（渲染层不会 KeyError）",
      rd.normalize_digest_result({"thesis": "一句话主张写在这里"}, {})["judgment"]
      == {"verdict": "", "confidence": 0, "why": "", "when_not": "", "open_questions": []})
check("兜底与不足产出都带 judgment 结构",
      "judgment" in rd.build_digest_fallback(title="x")
      and "judgment" in rd.build_insufficient_digest(title="x"))
check("只有判断也算有内容（digest_has_content）",
      rd.digest_has_content({"judgment": {"verdict": "我信这一套说法", "confidence": 3}}) is True)

# 「边界与反例」不可静默消失：有材料却没给 critique 时，要留下一节并请用户自己补一句
_no_critique = rd.normalize_digest_result(
    {
        "thesis": "地方政府为增长而展开竞争，是理解中国经济的一把钥匙。",
        "spine": ["先交代地方政府为什么必须增长", "再讲它靠什么手段竞争", "最后落到债务与风险的代价"],
    },
    {},
)
check("测试数据本身撑得过门槛（thesis + spine 都在）",
      bool(_no_critique["thesis"]) and len(_no_critique["spine"]) == 3, str(_no_critique)[:120])
_md_nc = rd.render_digest_markdown(_no_critique, title="置身事内")
check("有材料却缺边界与反例时不静默消失",
      "这本书说得有道理吗" in _md_nc and "没有给出边界与反例" in _md_nc)
check("全空文档不会硬塞这一节",
      "说得有道理吗" not in rd.render_digest_markdown(
          rd.build_insufficient_digest(title="空书"), title="空书"))

# 标题要跟着定位走：无个人材料时是「书籍导读」，不能还写「读书收获」
check("book 模式标题写「书籍导读」",
      rd.render_digest_markdown(norm_spine, title="纳瓦尔宝典", heading="书籍导读").startswith(
          "# 《纳瓦尔宝典》· 书籍导读"))
check("默认标题是「读书收获」",
      rd.render_digest_markdown(norm_spine, title="置身事内").startswith("# 《置身事内》· 读书收获"))


print("\n%d 项未通过" % len(FAILS) if FAILS else "\n全部通过")
sys.exit(1 if FAILS else 0)
