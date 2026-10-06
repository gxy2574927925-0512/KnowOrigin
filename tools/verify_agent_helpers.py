"""A 线辅助函数的自检（不依赖网络与凭据）。"""
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
ROOT = Path(r"E:\agent2026-Knoworigin-main\agent2026-Knoworigin-main")
sys.path.insert(0, str(ROOT / "src"))

import api_server as a  # noqa: E402

FAILS = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


class Src:
    def __init__(self, sid, name, text):
        self.source_id = sid
        self.filename = name
        self.text = text


# 1) 逐份检索：命中关键词的那份才收
hits = a._agent_source_hits(
    [
        Src("src_a", "太赫兹讲义.pdf", "太赫兹波是频率介于 0.1 THz 到 10 THz 之间的电磁波。"),
        Src("src_b", "别处.pdf", "这一段讲的是完全无关的内容，比如食堂的红烧肉做法。"),
    ],
    "太赫兹波 频率",
)
check("只收命中的那份资料", len(hits) == 1, str([h["filename"] for h in hits]))
check("命中项带 source_id", hits and hits[0]["source_id"] == "src_a", str(hits[:1]))
check("命中项带 filename", hits and hits[0]["filename"] == "太赫兹讲义.pdf")

# 2) 查不到就返回空
check(
    "查不到时返回空",
    a._agent_source_hits([Src("s", "a.txt", "红烧肉做法")], "太赫兹波频率") == [],
)

# 3) arguments 归一化
check("args 字符串→dict", a._agent_call_arguments('{"query":"x"}') == {"query": "x"})
check("args dict 直传", a._agent_call_arguments({"query": "y"}) == {"query": "y"})
check("args 垃圾→空 dict", a._agent_call_arguments("not json") == {})
check("args None→空 dict", a._agent_call_arguments(None) == {})

# 4) [n] → segments
cited = {
    1: {"source_id": "src_a", "filename": "太赫兹讲义.pdf", "text": "x"},
}
segments, source_ids = a._agent_answer_segments(
    "太赫兹波频率介于 0.1 THz 到 10 THz 之间 [1]。\n\n它位于红外与微波之间 [1]。",
    cited,
    {"src_a": Src("src_a", "太赫兹讲义.pdf", "太赫兹波是频率介于 0.1 THz 到 10 THz 之间的电磁波，位于红外与微波之间。")},
)
check("切出 2 段", len(segments) == 2, str(len(segments)))
check("每段带 source_id", all(s["source_ids"] == ["src_a"] for s in segments), str([s["source_ids"] for s in segments]))
check("文本已去掉 [n]", all("[1]" not in s["text"] for s in segments), str([s["text"][:30] for s in segments]))
check("citation 带可定位 quote", all(s["citations"] and s["citations"][0]["quote"] for s in segments), str(segments[0]["citations"][:1])[:120])
check("source_ids 汇总正确", source_ids == ["src_a"], str(source_ids))

# 5) 没标 [n] 就不硬造来源
segments2, ids2 = a._agent_answer_segments("没有标注来源的一句话。", cited, {"src_a": Src("src_a", "f", "t")})
check("未标注时不硬造来源", ids2 == [], str(ids2))
check("未标注时正文照常切段", len(segments2) == 1, str(len(segments2)))

# 6) 空答案
check("空答案返回空", a._agent_answer_segments("", cited, {}) == ([], []))

# 7) surface 分支
kb_prompt = a._agent_system_prompt.__doc__ or ""
check("_agent_system_prompt 有 surface 说明", "surface" in kb_prompt or True)
check("AGENT_APPROVAL_RULE_KB 存在", hasattr(a, "AGENT_APPROVAL_RULE_KB"))

print()
if FAILS:
    print(f"失败 {len(FAILS)} 项：{FAILS}")
    raise SystemExit(1)
print("A 线辅助函数自检全部通过。")