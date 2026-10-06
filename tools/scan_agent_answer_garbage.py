"""扫已落库的 assistant 消息，找出 Agent 输出里的「工具调用标签残留」与公式损坏。

用途：定位「agent 回答显示有问题」的真实形态（浏览器把 <parameter=...> 当未知标签吃掉，
显示成 intendedanswerfor"wrongstatement"... 这类碎片）。
"""
import re
import sqlite3
import sys
from pathlib import Path

DB = Path(r"E:\agent2026-Knoworigin-main\agent2026-Knoworigin-main\data\knoworigin.sqlite3")

PATTERNS = [
    ("parameter 开标签", re.compile(r"<parameter[^>]*>", re.I)),
    ("parameter 闭标签", re.compile(r"</parameter\s*>", re.I)),
    ("function 开标签", re.compile(r"<function[^>]*>", re.I)),
    ("function 闭标签", re.compile(r"</function\s*>", re.I)),
    ("JSON 伪调用", re.compile(r'\{\s*"name"\s*:')),
    ("命令后缀 </answer>", re.compile(r"</answer>", re.I)),
    ("反斜杠命令残缺", re.compile(r"\\[A-Za-z]+")),
    ("裸 LaTeX 换行残留", re.compile(r"\\\\[A-Za-z]")),
]


def main():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT message_id, content, created_at, conversation_id FROM messages "
        "WHERE role='assistant' ORDER BY rowid DESC LIMIT 80"
    ).fetchall()
    print(f"扫 {len(rows)} 条 assistant 消息\n")

    summary = {}
    samples = {}
    for row in rows:
        text = row["content"] or ""
        for name, rx in PATTERNS:
            found = rx.findall(text)
            if not found:
                continue
            summary[name] = summary.get(name, 0) + len(found)
            if name not in samples:
                m = re.search(rx, text)
                start = max(0, m.start() - 90)
                samples[name] = (
                    row["message_id"][:10],
                    text[start : m.end() + 90].replace("\n", " | "),
                )

    if not summary:
        print("干净：没有任何工具调用标签残留。")
        return 0

    for name in summary:
        print(f"[{summary[name]:3d} 处] {name}")
        mid, ctx = samples[name]
        print(f"        {mid}: …{ctx}…")
    print()
    print("→ 这些标签在真实浏览器里会被当成未知 HTML 元素：标签本身不显示，")
    print("  但标签名里的空格被当成属性分隔，于是 'intended answer for' 变成")
    print("  'intendedanswerfor'，只剩一句裸英文露在页面上。")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())