"""生成 classic 浅色配色回退层。

背景：本次把 styles.css 里大量写死的暖色字面值换成了语义 token
（#5f8f4c → var(--green)、#f3eee4 → var(--sidebar) …）。academic 与 agent
各自有专属 token 块覆盖，色值与原始一致，所以没受影响；但 classic 从来没有
专属 token 块、直接吃 :root，于是它看到的是 :root 的通用值而不是原始那些
更具体的暖色，浅色下就变了样。

这里从 10/01 的原始工程里，把「与当前仅颜色不同」的声明按选择器还原，并统一
加上 html[data-ui="classic"]:not([data-theme="dark"]) 作用域 —— 只影响 classic 浅色，
academic / agent 不动，深色也不动。

作用域里的 :not([data-theme="dark"]) 是必须的，不能省：这一层是「浅色」回退层，且
排在 styles.css 之后加载。只写 html[data-ui="classic"] 时，classic 切到深色后整层
浅色暖调仍会压住 styles.css 里的 html[data-theme="dark"] 规则 —— 页签变成白底、
文字用的是深色 token 的浅色，等于白底浅字（深色下不可读）。
"""
import io
import re
import sys
from pathlib import Path

ORIG = Path(sys.argv[1])
CUR = Path(sys.argv[2])
OUT = Path(sys.argv[3])

o = io.open(ORIG, encoding="utf-8").read()
c = io.open(CUR, encoding="utf-8").read()


def rules(src):
    out = []
    for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", src):
        sel = " ".join(m.group(1).split())
        body = " ".join(m.group(2).split())
        if sel and body:
            out.append((sel, body))
    return out


# 注释块会被前面的粗切当成选择器，先剥掉避免生成垃圾规则
def strip_comments(src):
    return re.sub(r"/\*.*?\*/", "", src, flags=re.S)


ro = rules(strip_comments(o))
rc = rules(strip_comments(c))

# 当前文件的选择器 -> 原始声明（原始里选择器重复的取第一条，多数是伪类变体）
orig_by_sel = {}
for sel, body in ro:
    orig_by_sel.setdefault(sel, body)

# 深色 / 天大 / academic / agent 作用域一律不碰：用户只要 classic 浅色
SKIP_TOKENS = (
    'data-theme="dark"',
    "data-ui=\"academic\"",
    "data-ui=\"agent\"",
    "data-brand=",
)

# 只处理"剥掉所有颜色值后骨架相同"的声明对 —— 证明差异纯颜色，没有布局改动
COLOR = re.compile(
    r"#[0-9a-fA-F]{3,8}\b"
    r"|rgba?\([^()]*\)"
    r"|hsla?\([^()]*\)"
    r"|var\(\s*--[a-z0-9-]+(?:\s*,\s*[^()]*)?\s*\)",
    re.I,
)


def skeleton(body):
    return COLOR.sub("", body)


# 同选择器在当前文件可能有多条（伪类变体），逐条比对
cur_by_sel = {}
for sel, body in rc:
    cur_by_sel.setdefault(sel, []).append(body)

# 只回退颜色相关属性。布局/排版属性即使当前两边一致也一并输出的话，
# 以后上游改了布局就会静默把 classic 的新布局覆盖回旧值 —— 那种回归极难查。
COLOR_PROPS = (
    "color",
    "background",
    "background-color",
    "background-image",
    "border",
    "border-color",
    "border-top-color",
    "border-right-color",
    "border-bottom-color",
    "border-left-color",
    "outline",
    "outline-color",
    "box-shadow",
    "text-shadow",
    "fill",
    "stroke",
    "caret-color",
    "accent-color",
    "border-left",
)


def color_decls(body):
    """挑出 body 里颜色相关的声明，保持原顺序。"""
    out = []
    for decl in body.split(";"):
        decl = decl.strip()
        if not decl:
            continue
        prop = decl.split(":", 1)[0].strip().lower()
        # border-left 这类简写要放在 border-color 前面判断，用前缀匹配
        if prop in COLOR_PROPS or prop.startswith("border-left") or prop.startswith("background"):
            out.append(decl)
    return out


emitted = []
for sel, bodies in cur_by_sel.items():
    if any(t in sel for t in SKIP_TOKENS):
        continue
    if not sel or sel.startswith("@") or "%" in sel or "+" in sel and " " not in sel:
        # 跳过 keyframes 百分比等非选择器
        if not re.match(r"^[.#:a-zA-Z\[]", sel):
            continue
    ob = orig_by_sel.get(sel)
    if not ob:
        continue
    for cb in bodies:
        if cb == ob or skeleton(cb) != skeleton(ob):
            continue
        decls = color_decls(ob)
        if decls:
            emitted.append((sel, decls))
        break

print(f"可还原的选择器: {len(emitted)}")

# 生成 CSS：给每条选择器加 classic 浅色作用域（深色必须排除，见模块 docstring）
lines = [
    "/* ============================================================",
    "  classic 浅色配色回退层（自动生成，勿手改）",
    "  由 tools/build_classic_palette.py 从 10/01 原始工程还原。",
    "  背景：字面暖色被迁到语义 token 后，classic 因没有专属 token 块而变色。",
    "  academic / agent 有自己的 token 块，不受影响，这里也不加它们的规则。",
    "  只写颜色属性，不写布局 —— 避免日后上游改布局时被这里静默覆盖回去。",
    "  作用域带 :where(:not([data-theme=\"dark\"]))：这是浅色层，深色下必须让位给",
    "  styles.css 里的 html[data-theme=\"dark\"] 规则，否则深色会被压成白底浅字。",
    "  用 :where() 包一层是为了不抬特异性 —— 裸 :not() 会把这一层从 (0,2,1) 抬到",
    "  (0,3,1)，浅色下反过来压过 styles.css 里同权重的 html[data-brand=...] 规则。",
    " ============================================================ */",
    "",
]

for sel, decls in emitted:
    scoped = ", ".join(
        f'html[data-ui="classic"]:where(:not([data-theme="dark"])) {part.strip()}'
        for part in sel.split(",")
    )
    lines.append(f"{scoped} {{")
    for decl in decls:
        lines.append(f"  {decl};")
    lines.append("}")
    lines.append("")

# .message > div 会连用户气泡一起命中（用户气泡 DOM 也是 .message > div），
# 于是助手气泡的纯色底被套到用户气泡上、把它压没了渐变。
# 生成器认不出这个语义关系，所以在输出里显式补一条把用户气泡还原。
# 配色用莫兰迪雾绿 #647462 → #50604e：饱和度 0.16、白字对比 4.62:1（WCAG AA）。
lines.append(
    "/* 用户气泡被上面 .message > div 的纯色底压掉了，这里还原莫兰迪雾绿渐变"
    "（两条色标都写死，不跟随品牌）。 */"
)
lines.append(
    'html[data-ui="classic"]:where(:not([data-theme="dark"])) .user-message > div {'
)
lines.append("  color: #ffffff;")
lines.append(
    "  background: linear-gradient(148deg, rgba(100, 116, 98, 0.96) 0%, rgba(80, 96, 78, 0.96) 100%);"
)
lines.append("  -webkit-backdrop-filter: blur(8px) saturate(1.1);")
lines.append("  backdrop-filter: blur(8px) saturate(1.1);")
lines.append("  box-shadow: 0 8px 20px rgba(80, 96, 78, 0.22);")
lines.append("}")
lines.append("")

OUT.write_text("\n".join(lines), encoding="utf-8")
print(f"已写出: {OUT}  ({OUT.stat().st_size} 字节)")
