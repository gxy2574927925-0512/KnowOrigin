"""列出 Agent 的全部工具与作用域（回答「agent 有什么用」的事实依据）。"""
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import api_server as a  # noqa: E402

main = {t["function"]["name"] for t in a.AGENT_TOOLS_DEFAULT}
print(f"工具共 {len(a.LEARNING_AGENT_TOOLS)} 个：主界面 {len(main)} 个，仅 kb 面板 {len(a.LEARNING_AGENT_TOOLS) - len(main)} 个\n")
for tool in a.LEARNING_AGENT_TOOLS:
    fn = tool["function"]
    name = fn["name"]
    scope = "主界面" if name in main else "仅面板"
    desc = fn.get("description", "").replace("\n", " ")
    print(f"[{scope}] {name}\n    {desc[:150]}")

print()
print("写操作闸门（需用户点确认才落库）:", sorted(a.AGENT_WRITE_TOOLS))
print("主界面整理类轮数上限:", a.AGENT_MAX_ROUNDS_WRITABLE, "（面板 3 轮）")