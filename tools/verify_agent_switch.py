"""A 线验收：主界面对话区 Agent 开关的基础链路（fake 模型，不需要 key/网络）。

覆盖：开关开/关、会话归属、/agent 面板回归。
"""
import json
import sys
import tempfile
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from fastapi.testclient import TestClient  # noqa: E402

from api_server import create_app  # noqa: E402
import api_server  # noqa: E402
from config import Settings  # noqa: E402
from core.database import Database  # noqa: E402
from core.llm import LlmClient  # noqa: E402

SOURCE_TEXT = (
    "第 3 章 太赫兹波\n"
    "太赫兹波是频率介于 0.1 THz 到 10 THz 之间的电磁波，位于红外与微波之间。\n"
    "太赫兹波的产生方式包括光整流效应与光电导效应两种常见方案。"
)

FAILS = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


class FakeLlm(LlmClient):
    """一轮工具调用 + 一轮正文；记录调用顺序便于断言。"""

    def __init__(self, settings):
        super().__init__(settings, responder=None)
        self.tool_rounds = 0
        self.calls = []
        self.tool_schema_names = []

    async def astream_chat_with_tools(self, messages, task, tools, *, temperature=None, extra_payload=None):
        self.calls.append("astream_chat_with_tools")
        self.tool_schema_names.append(
            sorted(t.get("function", {}).get("name") for t in tools)
        )
        self.tool_rounds += 1
        if self.tool_rounds == 1:
            yield {
                "type": "tool_calls",
                "calls": [
                    {
                        "id": "call_1",
                        "name": "search_sources",
                        "arguments": {"query": "太赫兹波 频率"},
                    }
                ],
                "raw": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "search_sources",
                            "arguments": '{"query": "太赫兹波 频率"}',
                        },
                    }
                ],
                "content": "",
            }
            return
        yield {"type": "delta", "text": "根据资料，太赫兹波频率介于 0.1 THz 到 10 THz [1]。"}

    async def astream_chat_content(self, messages, task, *, temperature=None, extra_payload=None):
        self.calls.append("astream_chat_content")
        yield "太赫兹波是频率介于 0.1 THz 到 10 THz 之间的电磁波 [1]。"

    def complete_json(self, task, payload):
        self.calls.append("complete_json")
        return {"answer": "本地兜底答案。", "node_ids": [], "source_ids": []}


def sse_events(text):
    events = []
    for chunk in text.split("\n\n"):
        for line in chunk.split("\n"):
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))
    return events


def run_stream(client, project_id, body):
    with client.stream("POST", f"/api/projects/{project_id}/chat/stream", json=body) as resp:
        return resp.status_code, sse_events("".join(chunk for chunk in resp.iter_text()))


def main():
    tmp = Path(tempfile.mkdtemp(prefix="knoworigin-a-switch-"))
    settings = Settings(
        tju_api_key="tk-verify-placeholder",
        tju_base_url="https://example.invalid/api",
        tju_model="tju-llm",
        data_dir=tmp,
        usage_tracking_enabled=False,
    )
    db = Database(tmp / "verify.sqlite3")
    llm = FakeLlm(settings)
    client = TestClient(create_app(db, settings, llm))

    client.post(
        "/api/auth/register",
        json={"email": "a@e.com", "password": "abcd1234", "name": "A"},
    )
    pid = client.post("/api/projects", json={"year": "2026", "subject": "太赫兹"}).json()[
        "project_id"
    ]
    uploaded = client.post(
        f"/api/projects/{pid}/sources", data={"pasted_text": SOURCE_TEXT}
    )
    source_id = uploaded.json()["sources"][0]["source_id"]

    # 1) agent=true：走工具循环
    llm.tool_rounds = 0
    status, events = run_stream(client, pid, {"message": "太赫兹波频率？", "agent": True})
    kinds = [e.get("type") for e in events]
    done = next((e for e in events if e.get("type") == "done"), {})
    check("agent=true 返回 200", status == 200, str(status))
    check("收到 tool 事件", "tool" in kinds, str(kinds))
    check(
        "工具名被正确解析",
        any(t.get("name") == "search_sources" for t in done.get("tool_trace") or []),
        str([t.get("name") for t in done.get("tool_trace") or []]),
    )
    check("事件顺序 tool → delta → done", kinds.index("tool") < kinds.index("done"), str(kinds))
    check("调用过带工具的模型方法", "astream_chat_with_tools" in llm.calls, str(llm.calls))
    check("空 cid 不新建会话", done.get("conversation_id") == "", repr(done.get("conversation_id")))
    check("溯源只报命中资料", done.get("source_ids") == [source_id], str(done.get("source_ids")))
    check("产出可点 chip 的 segments", bool(done.get("answer_segments")), str(done.get("answer_segments"))[:120])
    check("无待确认写操作", done.get("staged_actions") == [], str(done.get("staged_actions")))

    stored = db.list_messages(pid, conversation_id="")
    check("user+assistant 两条落库", len(stored) == 2, f"{len(stored)} 条")
    check(
        "assistant 落库带 trace",
        bool(stored and isinstance(stored[-1].meta, dict) and stored[-1].meta.get("trace")),
    )

    # 2) agent=false：退回原 RAG 链路
    llm.calls.clear()
    llm.tool_rounds = 0
    status, events_off = run_stream(client, pid, {"message": "太赫兹波频率？", "agent": False})
    kinds_off = [e.get("type") for e in events_off]
    done_off = next((e for e in events_off if e.get("type") == "done"), None)
    check("agent=false 返回 200", status == 200, str(status))
    check("关闭开关后无 tool 事件", "tool" not in kinds_off, str(kinds_off))
    check("关闭开关后不调用工具型接口", "astream_chat_with_tools" not in llm.calls, str(llm.calls))
    check(
        "关闭开关后正常返回答案",
        done_off is not None and bool(done_off.get("answer")),
        str((done_off or {}).get("answer"))[:120],
    )

    # 3) 缺省不传 agent：等价于关闭
    status, events_def = run_stream(client, pid, {"message": "太赫兹波频率？"})
    check("不传 agent 也不走工具", "tool" not in [e.get("type") for e in events_def])

    # 4) 复用已有会话：cid 透传不被改写
    conv = db.create_chat_session(pid, "手动会话")
    llm.tool_rounds = 0
    status, events_cid = run_stream(
        client, pid, {"message": "再补充一句", "agent": True, "conversation_id": conv["session_id"]}
    )
    done_cid = next((e for e in events_cid if e.get("type") == "done"), {})
    check(
        "复用已有会话",
        done_cid.get("conversation_id") == conv["session_id"],
        repr(done_cid.get("conversation_id")),
    )

    # 5) /agent 面板回归：无 cid 时仍自动新建会话、挂全量工具、写操作直接落库
    llm.tool_rounds = 0
    llm.calls.clear()
    with client.stream("POST", f"/api/projects/{pid}/agent", json={"message": "整理一下"}) as resp:
        events_agent = sse_events("".join(chunk for chunk in resp.iter_text()))
    done_agent = next((e for e in events_agent if e.get("type") == "done"), {})
    check("/agent 返回 200", resp.status_code == 200, str(resp.status_code))
    check(
        "/agent 无 cid 时自动新建会话",
        str(done_agent.get("conversation_id") or "").startswith("conv_"),
        repr(done_agent.get("conversation_id")),
    )
    check("/agent 仍走工具循环", "astream_chat_with_tools" in llm.calls, str(llm.calls))
    check(
        "/agent 不产待确认动作（闸门只对主界面开）",
        not done_agent.get("staged_actions"),
        str(done_agent.get("staged_actions")),
    )
    # 数量用模块常量比，避免每次加工具都要改两处魔法数字；
    # 真正要守的是「新增的产物读取工具两套工具集都挂上了」。
    check(
        "/agent 挂的是全量工具",
        len(llm.tool_schema_names[-1]) == len(api_server.LEARNING_AGENT_TOOLS),
        f"{len(llm.tool_schema_names[-1])} 个",
    )
    check(
        "主界面挂的是收窄后的工具集",
        len(llm.tool_schema_names[0]) == len(api_server.AGENT_TOOLS_DEFAULT),
        f"{len(llm.tool_schema_names[0])} 个",
    )
    for tool_name in ("search_cards", "search_quiz", "search_highlights", "get_study_kit"):
        check(
            f"{tool_name} 在 /agent 的 schema 里",
            tool_name in llm.tool_schema_names[-1],
        )
        check(
            f"{tool_name} 在主界面的 schema 里",
            tool_name in llm.tool_schema_names[0],
        )

    print()
    if FAILS:
        print(f"失败 {len(FAILS)} 项：{FAILS}")
        return 1
    print("A 线开关基础链路全部通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())