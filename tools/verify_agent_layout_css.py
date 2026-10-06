"""CSS 体检：括号平衡 + 编码完好 + 作用域隔离。

「作用域体检」的判定：每条规则的选择器里必须出现 data-ui="agent"，
或者类名/id 属于本功能专属前缀（.agent-* / #agent-*）——
后一种只允许 .agent-suggested-menu 这类挂 body 的浮层与本功能自有节点。
"""
import io
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / "static" / "agent-layout.css"
css = io.open(path, encoding="utf-8").read()

FAILS = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


check("花括号平衡", css.count("{") == css.count("}"), f"{css.count('{')} vs {css.count('}')}")
check("无乱码替换字符", "�" not in css)

# 先剥掉注释，否则正则会把注释里的选择器文字当成真规则（第一版就踩了这个）
stripped = re.sub(r"/\*.*?\*/", "", css, flags=re.S)

bad = []
for m in re.finditer(r"(?:^|[{};])\s*([^{}@]+)\{", stripped):
    selector = m.group(1).strip()
    if selector.startswith("@"):
        continue
    for part in selector.split(","):
        one = part.strip()
        if not one:
            continue
        if 'data-ui="agent"' in one:
            continue
        if one.startswith(".agent-") or one.startswith("#agent-"):
            continue
        bad.append(one)

# 允许的唯一无作用域块：文件开头的兜底隐藏规则（另两套布局必须藏起这些节点）。
# 这些选择器以 .agent-* 开头，会被上面的前缀分支直接放行 —— 所以这里按"文件里
# 确实写了这条规则"来查，而不是查 bad 列表。
head = stripped[: stripped.index("html[data-ui=\"agent\"]")]
allowed = [
    ".agent-rail",
    ".agent-sessions",
    ".agent-overlay-head",
    ".agent-import-button",
    ".agent-only-settings",
]
missing_hidden = [one for one in allowed if one not in head]
check("兜底隐藏规则齐全", not missing_hidden, str(missing_hidden))

# 兜底块必须出现在所有带作用域的规则之前（加载顺序上先隐藏，再由 agent 作用域放开）
first_scoped = stripped.index('html[data-ui="agent"]')
check(
    "兜底隐藏写在作用域规则之前",
    all(one in head for one in allowed) and first_scoped > stripped.index(".agent-rail"),
)

# 关键布局规则必须存在（缺一条就意味着某个需求没落地）
required = [
    "html[data-ui=\"agent\"] #agent-rail",
    "html[data-ui=\"agent\"] #agent-sessions",
    "html[data-ui=\"agent\"] .agent-panel",
    "html[data-ui=\"agent\"] .studio-panel.studio-focus",
    "html[data-ui=\"agent\"] body.agent-sources-open .sources-panel",
    "html[data-ui=\"agent\"] .conversation .user-message > div",
    "html[data-ui=\"agent\"] .suggested-questions",
    "html[data-ui=\"agent\"] .composer::before",
]
missing = [rule for rule in required if rule not in css]
check("关键布局规则齐全", not missing, str(missing[:4]))

# ---- 产出浮层标题栏：中央标题必须跟着当前功能变 ----
# 这两条曾经同时坏过：标题 h2 没有 id（syncStudioTitle 写了不存在的选择器，静默 return），
# 以及 agent 作用域缺标题栏规则（只补了颜色、academic 那套还带 grid/字号布局）。
check("标题元素有 id", 'id="studio-title"' in io.open(ROOT / "static" / "index.html", encoding="utf-8").read())

shell = io.open(ROOT / "static" / "agent-shell.js", encoding="utf-8").read()
check("syncStudioTitle 命中 #studio-title", '"#studio-title"' in shell)
check("图标栏高亮与标题同源", "function activeFeature()" in shell)
check(
    "agent 作用域有标题栏规则",
    'html[data-ui="agent"] .studio-panel.studio-focus .studio-heading' in css,
)
check(
    "标题字号被压到正文级",
    re.search(r'studio-focus \.studio-heading h2 \{[^}]*font-size:\s*calc\(1[0-9]px', css) is not None,
)

# ---- 学术极简冷蓝：agent 作用域不许出现字面绿 ----
# 之前 styles.css 里有 139 条字面绿规则（不是 var(--green)，所以覆盖 --green 令牌没用）。
# 已按属性语义迁到 --green / --green-dark / --green-soft，这里守住不再长回来。
def _is_green(hex6: str) -> bool:
    h = hex6.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return g > r + 18 and g > b + 18 and g > 60


def literal_greens(source: str) -> list[str]:
    out = []
    for sel, body in re.findall(r"([^{}]+)\{([^{}]*)\}", re.sub(r"/\*.*?\*/", "", source, flags=re.S)):
        if not sel.strip() or sel.strip().startswith("@"):
            continue
        if any(h for h in re.findall(r"#[0-9a-fA-F]{6}\b", body) if _is_green(h)):
            out.append(" ".join(sel.split())[:70])
    return out


check("agent-layout.css 无字面绿", not literal_greens(css), str(literal_greens(css)[:3]))
styles = io.open(ROOT / "static" / "styles.css", encoding="utf-8").read()# 剩下的字面绿必须是「有意保留」的三类：--green 令牌本身、台历强度色阶、学科配色标签、
# 天大海棠花藤装饰渐变。多一条就是回归。
# .assistant-message .avatar 是例外：原始版就写死鼠尾草绿 #7da96f 当「题」印章的底色，
# 迁到 var(--green) 后会被通用品牌（52,87,232 蓝紫）染成蓝章，已按原值还原。
allowed_green = (
    ":root",
    ".streak-day-cell.is-",
    "course-autocomplete-tag",
    "tju-import-kind",
    "question-rail::before",
    ".assistant-message .avatar",
)
left = [s for s in literal_greens(styles) if not any(a in s for a in allowed_green)]
check("styles.css 字面绿只剩有意保留项", not left, str(left[:5]))

# CSS 注释必须闭合：漏一个 */ 会把它后面所有规则静默吃掉。
# 真发生过：补「试试这样问让开标题栏」的规则时，注释第一行被截断，
# 两条 top:60px 规则进了注释，返回按钮又被压住 —— 而花括号计数与 ?v= 检查全都看不出来。
check("注释成对闭合", css.count("/*") == css.count("*/"), f"{css.count('/*')} vs {css.count('*/')}")
check(
    "功能浮层里建议条整条藏掉",
    "body.studio-focus-open .suggested-questions { display: none; }" in stripped,
)
# 展开态画布那两层暖色渐变（米色 linear + 绿色 radial）必须被压掉
check("展开态画布压成透明", ".studio-output" in stripped and "background: transparent" in stripped)
# 副标题小标签的琥珀暖底要压掉（令牌 --gold-soft 本身是暖的，只能针对控件覆盖）
check("台历副标题小标签已冷蓝", "study-artifact-toolbar .sat-sub" in stripped)

# 观察 #suggested-questions 的 hidden、又写回 hidden = true，会自触发成无限微任务循环，
# 真浏览器同样卡死（症状：Agent 标签页 CPU 打满、界面无响应，且只在关掉建议问题时出现）。
# setAttribute 即使值没变也会入队 mutation record，所以 `!box.hidden` 这个守卫不能省。
shell_js = (ROOT / "static" / "agent-shell.js").read_text(encoding="utf-8")
guard_ok = "!box.hidden" in shell_js and "attributeFilter: [\"hidden\"]" in shell_js
check("建议条隐藏回调带 !box.hidden 守卫（防自触发死循环）", guard_ok)

# ---- classic 浅色配色回退层：作用域必须闭合，且只能有颜色属性 ----
# 这层是从 10/01 原始工程还原 classic 暖色的。两条不能破的约束：
#   1) 每条规则都带 html[data-ui="classic"]，否则会连 academic / agent 一起改；
#   2) 只写颜色属性 —— 写进 padding/position 的话，日后上游改了布局会被这里静默盖回去。
pal_path = ROOT / "static" / "classic-palette.css"
check("classic-palette.css 存在", pal_path.exists())
if pal_path.exists():
    pal = pal_path.read_text(encoding="utf-8")
    pal_stripped = re.sub(r"/\*.*?\*/", "", pal, flags=re.S)
    check("回退层花括号平衡", pal.count("{") == pal.count("}"), f"{pal.count('{')} vs {pal.count('}')}")
    unscoped = [
        m.group(1).strip()[:60]
        for m in re.finditer(r"(?:^|[{}])\s*([^{}@]+)\{", pal_stripped)
        if 'data-ui="classic"' not in m.group(1)
    ]
    check("回退层每条规则都带 classic 作用域", not unscoped, str(unscoped[:3]))
    # 深色下必须让位：这是「浅色」回退层，且排在 styles.css 之后加载。不排除深色的话，
    # classic 切深色后整层浅色暖调仍会压住 html[data-theme="dark"] 规则 —— 白底页签配
    # 深色 token 的浅色文字，白底浅字完全不可读（2026-10-05 修的就是这个）。
    dark_leaking = [
        m.group(1).strip()[:60]
        for m in re.finditer(r"(?:^|[{}])\s*([^{}@]+)\{", pal_stripped)
        if ':not([data-theme="dark"])' not in m.group(1)
    ]
    check("回退层每条规则都排除深色主题", not dark_leaking, str(dark_leaking[:3]))
    check("回退层不含 academic / agent 作用域", 'data-ui="academic"' not in pal and 'data-ui="agent"' not in pal)
    layout_props = re.findall(r"^\s*(padding|margin|position|top|left|right|bottom|font-size|display|grid-template|width|height)\s*:", pal_stripped, re.M)
    check("回退层只写颜色属性", not layout_props, str(sorted(set(layout_props))[:5]))
    # .message > div 会连用户气泡一起命中，把助手气泡的纯色底套到了用户气泡上、
    # 吃掉它的鼠尾草绿渐变（症状：淡米底 + 白字看不见）。回退层必须有一条
    # 同等特异性的用户气泡规则把渐变还回来，否则 styles.css 里那条 (0,1,1) 永远赢不了。
    check(
        "回退层把用户气泡渐变单独还原（否则被 .message > div 的纯色底吃掉）",
        re.search(
            r'html\[data-ui="classic"\]:where\(:not\(\[data-theme="dark"\]\)\)\s*\.user-message\s*>\s*div\s*\{[^}]*'
            r"linear-gradient\(\s*148deg",
            pal_stripped,
        )
        is not None,
    )
    check(
        "回退层用户气泡渐变不跟随品牌（--green-dark-rgb 会被通用品牌覆盖成蓝）",
        "var(--green-dark-rgb)" not in
        re.search(r'\.user-message\s*>\s*div\s*\{[^}]*\}', pal_stripped).group(0)
        if re.search(r'\.user-message\s*>\s*div\s*\{[^}]*\}', pal_stripped) else False,
    )

    # 气泡配色必须让白字读得清：WCAG AA 正文 4.5:1。
    # 原来的鼠尾草绿 #7ca96d 只有 2.71:1 —— 既刺眼又看不清，是"没有高级感"的真正来源。
    bubble = re.search(r'\.user-message\s*>\s*div\s*\{([^}]*)\}', pal_stripped)
    if bubble:
        body = bubble.group(1)
        stops = re.findall(r"rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*[\d.]+\s*\)", body)

        def _lin(c):
            c /= 255
            return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

        def _lum(rgb):
            r, g, b = (_lin(x) for x in rgb)
            return 0.2126 * r + 0.7152 * g + 0.0722 * b

        def _ratio(fg, bg):
            a, b = _lum(fg), _lum((255, 255, 255))
            if a < b:
                a, b = b, a
            return (a + 0.05) / (b + 0.05)

        # 用实际渲染色（先与暖底 #faf8f3 按 alpha 合成）再算白字对比
        ratios = []
        for r_, g_, b_ in stops:
            a = float(re.search(r"rgba\(\s*" + r_ + r"\s*,\s*" + g_ + r"\s*,\s*" + b_ + r"\s*,\s*([\d.]+)", body).group(1))
            comp = tuple(round(int(x) * a + bgv * (1 - a)) for x, bgv in zip((r_, g_, b_), (250, 248, 243)))
            ratios.append(_ratio(comp, (255, 255, 255)))
        check(
            f"气泡白字对比 ≥ 4.5:1（实测 {min(ratios):.2f}:1）",
            min(ratios) >= 4.5 if ratios else False,
            str([round(x, 2) for x in ratios]),
        )
        # 莫兰迪的关键是低饱和：饱和度高于 0.25 就又刺眼了
        import colorsys
        sats = []
        for r_, g_, b_ in stops:
            sats.append(colorsys.rgb_to_hsv(int(r_) / 255, int(g_) / 255, int(b_) / 255)[1])
        check(
            f"气泡饱和度 ≤ 0.25（莫兰迪雾感，实测 {max(sats):.2f}）",
            max(sats) <= 0.25 if sats else False,
        )

    # 加载顺序：必须在 styles.css 之后、否则压不住被迁到 token 的暖色
    idx_html = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
    at_styles = idx_html.find("styles.css")
    at_pal = idx_html.find("classic-palette.css")
    check("回退层在 index.html 里被引入", at_pal != -1)
    check("回退层排在 styles.css 之后", at_pal > at_styles > 0)


# ---- 窄栏里左侧目录栏是 display:none，折叠轨必须跟着消失 ----
# 「收起目录」把 data-kb-left-collapsed 落到 <html>（kb-passport-ui.js:applySides），
# 但窄栏（非 .studio-focus）里 .framework-sidebar 整块是 display:none（styles.css:5206）。
# 折叠规则照样留一条 46px 的轨 → 列 1 一个 item 都没有，而 .framework-view 是流内
# 第一个 grid item，会被自动放进这条空列：图谱压成 46px 竖线，右边 183px 全白。
# 这条 reset 必须排在那两条折叠轨规则之后 —— 同特异性（0,4,1）靠顺序取胜，
# 而 agent 那条是 (0,5,1)，所以 agent 作用域要单独重写一遍。
passport = (ROOT / "static" / "styles-passport.css").read_text(encoding="utf-8")
passport_stripped = re.sub(r"/\*.*?\*/", "", passport, flags=re.S)
reset_sel = 'html[data-kb-left-collapsed="true"] .studio-panel:not(.studio-focus) .framework-shell'
reset_at = passport_stripped.rfind(reset_sel)
rail_at = passport_stripped.rfind("grid-template-columns: var(--kb-side-collapsed")
reset_body = passport_stripped[reset_at:] if reset_at != -1 else ""
check("窄栏折叠态退回单列（图谱不被挤成 46px 竖线）", reset_at != -1)
check("窄栏单列 reset 排在折叠轨规则之后", reset_at > rail_at != -1, f"reset={reset_at} rail={rail_at}")
check("窄栏 reset 单列声明的是 minmax(0, 1fr)", "minmax(0, 1fr)" in reset_body[:400])
check(
    "agent 作用域也覆写了（否则输给 agent-layout 的 (0,5,1)）",
    'html[data-ui="agent"][data-kb-left-collapsed="true"] .studio-panel:not(.studio-focus) .framework-shell'
    in passport_stripped,
)

print()
if FAILS:
    print(f"失败 {len(FAILS)} 项：{FAILS}")
    raise SystemExit(1)
print("agent-layout.css 体检通过。")
