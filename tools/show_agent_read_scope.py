"""查证：Agent 的检索工具能读到项目的哪些数据（读代码，不猜）。"""
import re
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[1]
src = (ROOT / "src" / "api_server.py").read_text(encoding="utf-8")

start = src.index("def _run_agent_tool(")
end = src.index("\ndef ", start + 10)
body = src[start:end]

print("== 工具实际读到的数据 ==")
for tool in ["search_sources", "get_mastery", "get_framework", "search_knowledge_base",
             "get_node", "get_kb_digest", "search_cards", "search_quiz",
             "search_highlights", "get_study_kit", "campus_query"]:
    m = re.search(rf'if name == "{tool}":(.*?)(?=\n    if name ==|\n    return |\Z)', body, re.S)
    if not m:
        continue
    chunk = m.group(1)
    calls = sorted(set(re.findall(r"\bdb\.(\w+)\(", chunk)))
    stores = sorted(set(re.findall(r"\bstudy_kit\.(\w+)\(", chunk)))
    print(f"\n{tool}:")
    print(f"  db 调用 : {calls or '（无，只读传入的 sources/nodes 参数）'}")
    if stores:
        print(f"  store   : study_kit.{stores}")
    for kw in ["note_content", "tags", "wikilinks", "mastery_score", "learning_status",
               "front", "back", "category", "answer", "explanation", "highlight_color",
               "content_md"]:
        if kw in chunk:
            print(f"  字段 {kw}")

db_src = (ROOT / "src" / "core" / "database.py").read_text(encoding="utf-8")
tables = re.findall(r"CREATE TABLE IF NOT EXISTS (\w+)", db_src)
print("\n== 项目里存在的数据表 ==")
print("  " + ", ".join(tables))

print("\n== 工具名里是否涉及 cards / quiz / 文档 ==")
names = re.findall(r'"name": "(\w+)"', src)
hits = sorted({t for t in names if re.search(r"card|quiz|doc", t, re.I)})
print("  " + (", ".join(hits) if hits else "（无）"))