"""index.html 结构体检：标签平衡 + id 唯一 + 关键节点齐全。"""
import io
import re
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
html = io.open(ROOT / "static" / "index.html", encoding="utf-8").read()

FAILS = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


VOID = {
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
}


class Structure(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.errors = []

    def handle_starttag(self, tag, attrs):
        if tag in VOID:
            return
        self.stack.append((tag, self.getpos()))

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if self.stack and self.stack[-1][0] == tag:
            self.stack.pop()
            return
        # 允许的容错：隐式闭合的 p/li/td 等在 HTML 里合法，只记不报
        if tag in {"p", "li", "td", "th", "tr", "option", "dd", "dt"}:
            for index in range(len(self.stack) - 1, -1, -1):
                if self.stack[index][0] == tag:
                    del self.stack[index:]
                    return
        self.errors.append((self.stack[-1] if self.stack else None, tag, self.getpos()))


parser = Structure()
parser.feed(html)
check("标签闭合无异常", not parser.errors, str(parser.errors[:4]))
check("无未闭合标签", not parser.stack, str([(t, pos) for t, pos in parser.stack][:4]))

ids = re.findall(r'id="([^"]+)"', html)
dup = sorted({name for name in ids if ids.count(name) > 1})
check("id 唯一", not dup, str(dup))

check("无乱码替换字符", "�" not in html)

print()
for name, node in [
    ("Agent 图标栏", "id=\"agent-rail\""),
    ("会话侧栏", "id=\"agent-sessions\""),
    ("会话新建按钮", "id=\"agent-new-session\""),
    ("会话列表容器", "id=\"agent-session-list\""),
    ("项目资料浮层标题", "id=\"sources-overlay-head\""),
    ("浮层关闭按钮", "id=\"sources-overlay-close\""),
    ("输入框导入入口", "id=\"agent-import-button\""),
    ("A 线 Agent 开关", "id=\"chat-agent-toggle\""),
    ("图标栏英语词汇入口", 'data-agent-module="english"'),
    ("图标栏收藏徽标", "id=\"agent-rail-favorite-count\""),
    ("设置第三套布局", 'data-ui-value="agent"'),
    ("Agent 专属设置", "agent-only-settings"),
    ("推荐问题开关", "id=\"settings-suggested-toggle\""),
    ("重命名会话弹窗", "id=\"chat-session-rename-dialog\""),
    ("删除会话弹窗", "id=\"chat-session-delete-dialog\""),
]:
    check(name, node in html)

print()
check(
    "agent-layout.css 挂在 styles.css 之后",
    html.index("/static/agent-layout.css") > html.index("/static/styles.css"),
)
check(
    "agent-shell.js 挂在 app.js 之后",
    html.index("/static/agent-shell.js") > html.index("/static/app.js"),
)
check(
    "图标栏/侧栏在 .workspace 内（第一个子节点区域）",
    html.index('id="agent-rail"') > html.index('id="workspace"')
    and html.index('id="sources-panel"') > html.index('id="agent-sessions"'),
)

print()
if FAILS:
    print(f"失败 {len(FAILS)} 项：{FAILS}")
    raise SystemExit(1)
print("index.html 结构体检通过。")