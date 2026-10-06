"""_LiteralToolCallAccumulator 的形态覆盖自检。

背景（真实问题）：用户截图里 agent 回答出现裸英文
`intendedanswerfor"wrongstatement"ifitsaid"nowature"` 与孤立 `*`。
根因是模型吐了**没有外层 <function=> 的裸 <parameter=...>**，
而捕获器只认 `<function=` 开头 → 整段漏进正文；
浏览器再把 `<parameter=question>intended answer for ...` 当成未知 HTML 标签，
标签名里的空格被当属性分隔吃掉，就只剩一句裸英文。

这里把各种形态列成断言，改捕获器后跑一遍就知道有没有漏网。
"""
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from api_server import _LiteralToolCallAccumulator, _strip_literal_tool_calls  # noqa: E402

FAILS = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


def feed(text, chunk=17):
    """按流式切片喂进去，返回 (是否被捕获, pop 出来的调用, 退回的正文)。"""
    acc = _LiteralToolCallAccumulator()
    forwarded = []
    for index in range(0, len(text), chunk):
        piece = text[index : index + chunk]
        if acc.feed(piece):
            continue
        forwarded.append(piece)
    calls = []
    while True:
        one = acc.pop_call()
        if one is None:
            break
        calls.append(one)
    leftover = ""
    if acc.capturing:
        leftover = acc.flush_all()
    return "".join(forwarded), calls, leftover


def case(name, text, expect_call, expect_leaked=(), chunk=17):
    forwarded, calls, leftover = feed(text, chunk)
    blob = forwarded + leftover
    ok_call = bool(calls) == expect_call
    leaked = [frag for frag in expect_leaked if frag in blob]
    check(name, ok_call and not leaked, f"calls={[c['name'] for c in calls]} 泄漏={leaked}" if not (ok_call and not leaked) else "")
    if ok_call and not leaked and calls:
        print(f"        解析: {calls[0]['name']}({calls[0]['arguments'][:60]})")
    return calls


print("== 已有形态（必须继续可用） ==")
case(
    "完整 <function> 形态",
    '<function=search_sources><parameter=query>太赫兹波 频率</parameter></function>',
    True,
)
case(
    "纯 JSON 形态（实测网关的形态）",
    '{"name": "search_sources", "parameters": {"query": "太赫兹波 频率"}}',
    True,
)
case(
    "JSON + arguments 键",
    '{"name": "get_mastery", "arguments": {"node_id": "node_1"}}',
    True,
)
case("多个 JSON 并行", '{"name":"a","parameters":{}} {"name":"b","parameters":{}}', True)
case("分片极小（逐字符流）", '{"name":"search_sources","parameters":{"query":"x"}}', True, chunk=1)

print()
print("== 漏网形态（截图里真实出现的） ==")
case(
    "裸 <parameter=...>（无外层 function）",
    '<parameter=question>intended answer for "wrong statement" if it said "no nature"</parameter>',
    True,
)
case(
    "裸 <parameter=...> 前缀有自然语言",
    '好的，我来出题：\n<parameter=question>为什么康普顿散射能证明光子有动量</parameter>',
    True,
    expect_leaked=("intended", "康普顿散射"),
)
case(
    "多个裸 parameter（并行调用）",
    '<parameter=node_id>node_1</parameter><parameter=question>这道题</parameter>',
    True,
    expect_leaked=("node_1", "这道题"),
)
case(
    # <function=...> 缺 </function> 闭合，但 <parameter> 已完整闭合：
    # 参数内容本身是完整的，摘出来比退回正文更合理（否则照样漏出裸标签）。
    "<function=...> 缺 </function> 闭合（但 parameter 已闭合）",
    '<function=search_sources><parameter=query>太赫兹</parameter>',
    True,
)

print()
print("== 不该被捕获的正常正文 ==")
case("普通中文正文", "太赫兹波是频率介于 0.1 THz 到 10 THz 之间的电磁波。", False)
case("含 LaTeX 的正文", "能量关系为 $E = pc$，动量为 $p = h/\\lambda$。", False)
case("含 JSON 代码块的正文", '步骤：{"name": "x"} 这是解释，不该被当调用', False)
case("极长的含 name 键 JSON 但不是调用", "看看这个配置：{'name': '张三', 'age': 30}，是个用户对象", False, chunk=200)

print()
print("== 收尾清洗 _strip_literal_tool_calls（按工具名过滤，不按结构）==")
# 判据必须是「工具名真实存在」：正文里真的在讲这个调用格式时，结构与真调用一模一样，
# 只看结构会把人家的讲解删掉 —— 真机故障就是这么来的。
STRIP_CASES = [
    ("真调用被摘掉", '{"name": "search_sources", "parameters": {"query": "x"}}', ""),
    ("带尾巴也摘掉", '{"name": "get_study_kit", "parameters": {"kind": "learning_path"}},......',
     ",......"),
    ("XML 真调用被摘掉", "<function=search_sources><parameter=query>x</parameter></function>好的", "好的"),
    ("教学示例必须保留",
     '平台没有原生函数调用，形如 {"name": "工具名", "parameters": {"参数名": "值"}}；这是约定格式。',
     '平台没有原生函数调用，形如 {"name": "工具名", "parameters": {"参数名": "值"}}；这是约定格式。'),
    ("XML 假名必须保留", "<function=工具名><parameter=x>1</parameter></function>讲解",
     "<function=工具名><parameter=x>1</parameter></function>讲解"),
    ("普通括号不受影响", "看这个函数 f(x) = {x: 1} 的用法", "看这个函数 f(x) = {x: 1} 的用法"),
    ("正文提到工具名不受影响", "我刚调用了 search_sources 这个工具。", "我刚调用了 search_sources 这个工具。"),
    ("截断残片保守保留", '{"name": "search_sources", "parameters": {"query": "x"',
     '{"name": "search_sources", "parameters": {"query": "x"'),
    ("前后夹着正文", '好的：{"name": "get_node", "arguments": {"node_id": "n1"}} 稍等我查一下',
     "好的： 稍等我查一下"),
]
for _name, _raw, _expected in STRIP_CASES:
    _got = _strip_literal_tool_calls(_raw)
    check(_name, _got == _expected, f"期望 {_expected!r} 实际 {_got!r}")
print()
if FAILS:
    print(f"失败 {len(FAILS)} 项：{FAILS}")
    raise SystemExit(1)
print("伪调用捕获器形态覆盖全部通过。")