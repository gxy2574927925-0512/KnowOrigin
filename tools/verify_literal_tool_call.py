"""文字伪工具调用的解析器回归（天大网关没有原生 function calling，实际跑的就是这条）。

这层是整个 Agent 的生死线：解析不出来，模型吐的 ``{"name": ...}`` 就原样漏进
用户看到的回答里（2026-10-04 用户实机截图：整条裸 JSON 躺在回答框里，
还带一句「请点击下方确认卡片中的执行按钮」—— 那轮调用其实压根没执行）。

守住四件事：

  1. **平铺参数**要认。实测弱模型最常给的是
     ``{"name":"plan_study_action","node_id":"…","kinds":["quiz"],"reason":"…"}``
     —— 参数与 name 同级、没有 ``parameters`` 外层。早先只认外层，这一整轮白给。
  2. **重复键**要认。实测还会吐 ``{"name"name":"plan_study_action", …}``（第二个
     冒号写成了 ``name``），严格 JSON 解析必然失败。
  3. **不许吞正文**：正文里贴 ``{"name": "张三", "age": 30}``（人名不是工具名）
     必须原样留在正文里，靠 ``known_tools`` 兜底。
  4. **一个字都不能丢**：正文 + 调用 + 正文 的混合流，转发出去的正文拼起来
     必须等于原文。早先 buf 无条件累积全部 chunk，退回正文时会把用户已经看过
     的那段再追加一遍 —— 同一条回答在界面上出现两次。

用真实 chunk 粒度逐字喂入，而不是一次性 ``feed`` 整段：分段喂才会暴露
「chunk 开头被吃掉」这类只在真机上偶发的截断 bug。
"""
import json
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from api_server import _LiteralToolCallAccumulator  # noqa: E402

KNOWN = {"search_sources", "plan_study_action", "add_node"}

FAILS = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


def run(text, *, chunk=7, known=KNOWN):
    """逐字喂入，返回 (转发出去的正文, 摘到的调用列表)。

    转发规则必须与 ``_agent_stream_impl`` 里一致：feed 返回 True 就扣住，
    否则把 ``flush_ready()`` 转发；流结束再 ``flush_all()`` 收尾。
    """
    acc = _LiteralToolCallAccumulator(known)
    forwarded = []
    calls = []
    for i in range(0, len(text), chunk):
        piece = text[i : i + chunk]
        if not acc.feed(piece):
            piece_out = acc.flush_ready()
            if piece_out:
                forwarded.append(piece_out)
    while True:
        one = acc.pop_call()
        if one is None:
            break
        calls.append(one)
    tail = acc.flush_all()
    if tail:
        forwarded.append(tail)
    return "".join(forwarded), calls


# ---------- 1. 外层 parameters（原始形态，必须一直认） ----------
nested = json.dumps(
    {"name": "plan_study_action", "parameters": {"node_id": "node_1", "kinds": ["quiz"]}},
    ensure_ascii=False,
)
body, calls = run(nested)
check("外层 parameters 形态认得", len(calls) == 1 and calls[0]["name"] == "plan_study_action",
      str(calls))
check("外层 parameters 的参数完整",
      json.loads(calls[0]["arguments"]) == {"node_id": "node_1", "kinds": ["quiz"]},
      calls[0]["arguments"] if calls else "")
check("调用被摘走后不转发任何 JSON", "{" not in body and '"name"' not in body, body)

# ---------- 2. 平铺参数（用户实机截图里的形态） ----------
flat = (
    '{"name":"plan_study_action","node_id":"一维无限深势阱",'
    '"node_name":"一维无限深势阱","kinds":["quiz"],'
    '"reason":"该知识点目前无笔记且掌握度低，通过小测验可以快速检验对能级公式、'
    '波函数形式及边界条件的理解。"}'
)
body, calls = run(flat)
check("平铺参数形态认得（截图里那一条）",
      len(calls) == 1 and calls[0]["name"] == "plan_study_action", str(calls)[:200])
args = json.loads(calls[0]["arguments"]) if calls else {}
check("平铺参数全部保留（含中文与数组）",
      args.get("node_id") == "一维无限深势阱"
      and args.get("kinds") == ["quiz"]
      and "掌握度低" in str(args.get("reason")),
      json.dumps(args, ensure_ascii=False)[:200])
check("平铺形态里 name 不被当成参数", "name" not in args, str(list(args)))
check("平铺形态一个字都没漏给用户", body == "", repr(body))

# ---------- 3. 重复键 `"name"name":`（截图里第二条那一条） ----------
dup = flat.replace('"name":', '"name"name":', 1)
body, calls = run(dup)
check("重复键 `\"name\"name\":` 也认得", len(calls) == 1
      and calls[0]["name"] == "plan_study_action", str(calls)[:200])
check("重复键形态的参数仍完整",
      json.loads(calls[0]["arguments"]).get("node_id") == "一维无限深势阱"
      if calls else False, calls[0]["arguments"] if calls else "")
check("重复键形态不漏给用户", body == "", repr(body))

# ---------- 4. 正文里的 JSON 不能被吞 ----------
prose = (
    "你可以这样理解：用户配置写成 "
    '{"name": "张三", "age": 30} 这样的对象就行，不需要特殊处理。'
)
body, calls = run(prose, chunk=5)
check("正文里的非工具 JSON 不被当调用", calls == [], str(calls))
check("正文里的 JSON 原样保留（一个字符都不少）", body == prose, repr(body))

# ---------- 5. 正文 + 调用 + 正文，一个字都不能丢 ----------
mixed = "我先查一下资料。\n" + flat + "\n查完了，按上面那张卡选就行。"
body, calls = run(mixed, chunk=5)
check("混合流里调用被摘走", len(calls) == 1, str(calls)[:120])
check("混合流里前后的正文都转发且不重复",
      body == "我先查一下资料。\n\n查完了，按上面那张卡选就行。",
      repr(body))
check("混合流不会把调用重复显示", body.count("plan_study_action") == 0, repr(body))

# ---------- 6. 先说半句再调用，且半句很长（超过探针窗口） ----------
long_prose = (
    "这个知识点你目前的掌握情况我看了下，下面这几点值得注意："
    "第一是边界条件的物理含义没吃透，第二是波函数的归一化写不对。"
    "我先给你出一套题检验一下。"
)
mixed2 = long_prose + flat
body, calls = run(mixed2, chunk=6)
check("长正文 + 调用：调用被摘走", len(calls) == 1, str(calls)[:120])
check("长正文 + 调用：正文一字不丢",
      body == long_prose, f"期望 {len(long_prose)} 字，实得 {len(body)} 字：{body[:60]!r}")

# ---------- 7. XML 形态不能被这次改动弄坏 ----------
xml = "<function=search_sources><parameter=query>光电效应 阈值频率</parameter></function>"
body, calls = run(xml, chunk=9)
check("XML 形态仍认得", len(calls) == 1 and calls[0]["name"] == "search_sources", str(calls))
check("XML 参数仍正确",
      json.loads(calls[0]["arguments"]) == {"query": "光电效应 阈值频率"}
      if calls else False, calls[0]["arguments"] if calls else "")

# ---------- 8. 已知工具名校验是最后一道闸 ----------
body, calls = run('{"name": "张三", "age": 30}', chunk=4)
check("工具名不在清单里就拒（正文原样保留）", calls == [], str(calls))
check("被拒的 JSON 原样留给用户看", body == '{"name": "张三", "age": 30}', repr(body))

# ---------- 9. 缓冲不会无限长 ----------
long_answer = "答" * 5000
body, calls = run(long_answer, chunk=200)
check("长正文全部转发（buf 不吞字）", body == long_answer, f"{len(body)}/{len(long_answer)}")
check("长正文不被当成调用", calls == [], str(calls))

# ---------- 10. 不闭合的 JSON 退回正文，而不是凭空吞掉 ----------
broken = '{"name": "plan_study_action", "parameters": {"query": "未闭合'
body, calls = run(broken, chunk=6)
check("未闭合的 JSON 不产生调用", calls == [], str(calls))
check("未闭合的 JSON 原样退回正文", broken in body, repr(body))

print()
if FAILS:
    print(f"FAIL：{len(FAILS)} 项")
    for item in FAILS:
        print(f"  - {item}")
    raise SystemExit(1)
print("伪工具调用解析回归全部通过。")
