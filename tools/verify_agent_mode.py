"""A 线验收：溯源 chip / 写操作确认闸门 / 预检索兜底 / kb 面板回归。

fake 脚本化模型，不需要 key 与网络。
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

import api_server  # noqa: E402
from api_server import create_app  # noqa: E402
from config import Settings  # noqa: E402
from core.database import Database  # noqa: E402
from core.llm import LlmClient  # noqa: E402

SOURCE_TEXT = (
    "第 3 章 太赫兹波\n"
    "太赫兹波是频率介于 0.1 THz 到 10 THz 之间的电磁波，位于红外与微波之间。\n"
    "太赫兹波的产生方式包括光整流效应与光电导效应两种常见方案。\n"
    "第 4 章 太赫兹探测\n"
    "太赫兹探测器按探测原理分为光电导采样与电光采样两类。"
)

FAILS = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


class ScriptedLlm(LlmClient):
    def __init__(self, settings, script):
        super().__init__(settings, responder=None)
        self.script = list(script)
        self.tool_schema_names = []
        self.messages_seen = []

    async def astream_chat_with_tools(self, messages, task, tools, *, temperature=None, extra_payload=None):
        self.tool_schema_names.append(
            sorted(t.get("function", {}).get("name") for t in tools)
        )
        self.messages_seen.append(messages)
        step = self.script.pop(0) if self.script else {"content": ["（脚本耗尽）"]}
        for call in step.get("tools", []):
            yield {
                "type": "tool_calls",
                "calls": call,
                "raw": [
                    {
                        "id": call[0]["id"],
                        "type": "function",
                        "function": {
                            "name": call[0]["name"],
                            "arguments": json.dumps(call[0]["arguments"], ensure_ascii=False),
                        },
                    }
                ],
                "content": "",
            }
            return
        for text in step.get("content", []):
            yield {"type": "delta", "text": text}

    async def astream_chat_content(self, messages, task, *, temperature=None, extra_payload=None):
        self.messages_seen.append(messages)
        step = self.script.pop(0) if self.script else {"content": ["（脚本耗尽）"]}
        for text in step.get("content", []):
            yield text

    def complete_json(self, task, payload):
        return {"answer": "（本地兜底）", "node_ids": [], "source_ids": []}


def sse_events(text):
    events = []
    for chunk in text.split("\n\n"):
        for line in chunk.split("\n"):
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))
    return events


def tool_call(name, arguments, call_id="call_1"):
    return [{"id": call_id, "name": name, "arguments": arguments}]


def run_stream(client, project_id, body):
    with client.stream("POST", f"/api/projects/{project_id}/chat/stream", json=body) as resp:
        return resp.status_code, sse_events("".join(chunk for chunk in resp.iter_text()))


def main():
    tmp = Path(tempfile.mkdtemp(prefix="knoworigin-a-verify-"))
    settings = Settings(
        tju_api_key="tk-verify-placeholder",
        tju_base_url="https://example.invalid/api",
        tju_model="tju-llm",
        data_dir=tmp,
        usage_tracking_enabled=False,
    )
    db = Database(tmp / "verify.sqlite3")
    llm = ScriptedLlm(settings, [])
    app = create_app(db, settings, llm)
    client = TestClient(app)

    client.post(
        "/api/auth/register",
        json={"email": "a@e.com", "password": "abcd1234", "name": "A"},
    )
    pid = client.post("/api/projects", json={"year": "2026", "subject": "太赫兹"}).json()[
        "project_id"
    ]
    uploaded = client.post(f"/api/projects/{pid}/sources", data={"pasted_text": SOURCE_TEXT})
    source_id = uploaded.json()["sources"][0]["source_id"]
    # 写工具的前置条件：必须先有知识框架（_run_agent_tool 里所有写工具共用这一条）
    db.add_framework_node(pid, name="太赫兹波", description="频率 0.1~10 THz 的电磁波")
    db.add_framework_node(pid, name="太赫兹探测器", description="光电导采样与电光采样")

    # ---------- 1) 溯源 ----------
    llm.script = [
        {"tools": [tool_call("search_sources", {"query": "太赫兹波 频率"})]},
        {"content": ["太赫兹波是频率介于 0.1 THz 到 10 THz 之间的电磁波 [1]。\n\n它位于红外与微波之间 [1]。"]},
    ]
    status, events = run_stream(client, pid, {"message": "太赫兹波的频率范围？", "agent": True})
    done = next((e for e in events if e.get("type") == "done"), {})
    segments = done.get("answer_segments") or []
    check("溯源：返回 200", status == 200, str(status))
    check("溯源：产出 answer_segments", bool(segments), json.dumps(segments, ensure_ascii=False)[:140])
    check("溯源：每段带 source_id", bool(segments) and all(s.get("source_ids") for s in segments))
    check("溯源：source_ids 只含命中的资料", done.get("source_ids") == [source_id], str(done.get("source_ids")))
    check(
        "溯源：citation 带可定位 quote",
        bool(segments) and all(s.get("citations") and s["citations"][0].get("quote") for s in segments),
        json.dumps(segments[:1], ensure_ascii=False)[:180],
    )
    check(
        "溯源：展示文本已去掉 [n]",
        all("[1]" not in s.get("text", "") for s in segments),
        json.dumps([s.get("text") for s in segments], ensure_ascii=False)[:140],
    )
    check(
        "溯源：source_refs 带 filename",
        bool(done.get("source_refs")) and done["source_refs"][0].get("source_id") == source_id,
    )
    check("溯源：无待确认写操作", done.get("staged_actions") == [], str(done.get("staged_actions")))
    check(
        "溯源：过程条记录了命中段数",
        any("命中" in (t.get("observation") or "") for t in done.get("tool_trace") or []),
    )
    check(
        "工具集：主界面挂的是收窄后的集合",
        set(llm.tool_schema_names[0]) == {t["function"]["name"] for t in api_server.AGENT_TOOLS_DEFAULT},
        str(llm.tool_schema_names[0]),
    )
    check(
        "工具集：不含 kb 专属工具",
        not (set(llm.tool_schema_names[0]) & {"complete_note", "propose_note", "socratic_ask", "converge", "list_proposals"}),
        str(llm.tool_schema_names[0]),
    )
    check(
        "溯源：assistant 落库记了来源",
        db.list_messages(pid, conversation_id="")[-1].source_ids == [source_id],
    )

    # ---------- 2) 写操作闸门 ----------
    node_count_before = len(db.list_framework_nodes(pid))
    llm.script = [
        {"tools": [tool_call("add_node", {"name": "太赫兹探测链路", "description": "探测链路总称"}, "c2")]},
        {"content": ["我打算在「太赫兹波」下面新建一个节点「太赫兹探测链路」，方便你之后单独追踪它的掌握度。"]},
    ]
    status, events = run_stream(client, pid, {"message": "在太赫兹波下面建一个「太赫兹探测链路」节点", "agent": True})
    done = next((e for e in events if e.get("type") == "done"), {})
    staged = done.get("staged_actions") or []
    check("闸门：返回 200", status == 200, str(status))
    check("闸门：产出待确认动作", len(staged) == 1, json.dumps(staged, ensure_ascii=False)[:160])
    check("闸门：动作是 add_node", staged and staged[0].get("tool") == "add_node")
    check("闸门：带可读标签", staged and "太赫兹探测链路" in staged[0].get("label", ""), str(staged[:1]))
    check(
        "闸门：确认前知识库没有新节点",
        len(db.list_framework_nodes(pid)) == node_count_before,
        f"{node_count_before} -> {len(db.list_framework_nodes(pid))}",
    )
    check(
        "闸门：模型被告知不会立即生效",
        any("[待用户确认]" in (t.get("observation") or "") for t in done.get("tool_trace") or []),
    )
    prompt = " ".join(str(m.get("content")) for m in llm.messages_seen[-1] if isinstance(m, dict))
    check("闸门：对话区提示词不提收敛按钮", "收敛按钮" not in prompt)
    check("闸门：对话区提示词要求标来源编号", "[1]" in prompt)
    # 「不要让用户去点任何按钮」曾经是写库类的一条泛化规则，而 plan_study_action 的全部
    # 意义就是给用户可点的选项 —— 两条指令打架，模型于是干脆不调工具、只在正文里编一个
    # 不存在的「执行按钮」让用户去点（真机症状：卡片不出现 + 「请点确认卡片里的执行」）。
    # 所以这里守两件事：禁「执行按钮」幻觉，以及明确要求该给选项时必须给。
    check("对话区提示词禁止幻觉「执行按钮」（真机上模型专挑这句编）",
          "绝对不要编造" in prompt and "执行按钮" in prompt, prompt[-260:])
    check("对话区提示词区分了两类动作的说话方式",
          "add_node" in prompt and "plan_study_action" in prompt, prompt[-260:])
    check("对话区提示词要求给产物选项时必须调 plan_study_action",
          "必须**调它给出选项" in prompt, prompt[-260:])
    # 「不要让用户去点任何按钮」本身不能删 —— 写库类必须继续禁止指路。
    # 要守住的是它被**限定**在写库分支里，而不是当年那种对所有动作一视同仁的泛化规则。
    ban = prompt.find("不要让用户去点任何按钮")
    check("「不要让用户去点任何按钮」仍保留给写库类（安全语义不能丢）",
          ban > 0 and "add_node" in prompt[max(0, ban - 260):ban], prompt[max(0, ban - 160):ban + 40])
    check("「不要让用户去点任何按钮」只对写库类生效，不再泛化到提议型",
          ban < prompt.find("可点选项卡"), prompt[max(0, ban - 160):ban + 40])

    # ---------- 3) 确认执行 ----------
    resp = client.post(f"/api/projects/{pid}/agent/actions/execute", json={"actions": staged})
    results = resp.json().get("results") or []
    check("执行：端点返回 200", resp.status_code == 200, resp.text[:140])
    check("执行：结果一条且成功", len(results) == 1 and results[0].get("ok"), json.dumps(results, ensure_ascii=False)[:160])
    check(
        "执行：节点真的建出来了",
        len(db.list_framework_nodes(pid)) == node_count_before + 1,
        f"{node_count_before} -> {len(db.list_framework_nodes(pid))}",
    )
    resp = client.post(
        f"/api/projects/{pid}/agent/actions/execute",
        json={"actions": [{"tool": "run_shell", "arguments": {}}]},
    )
    check(
        "执行：任意函数名被拒",
        all(not i["ok"] for i in (resp.json().get("results") or [])),
        json.dumps(resp.json(), ensure_ascii=False)[:140],
    )
    resp = client.post(f"/api/projects/{pid}/agent/actions/execute", json={"actions": []})
    check("执行：空动作被拒", resp.status_code == 422, str(resp.status_code))
    other = TestClient(app)
    other.post("/api/auth/register", json={"email": "x@e.com", "password": "abcd1234", "name": "X"})
    check(
        "执行：越权访问返回 404",
        other.post(f"/api/projects/{pid}/agent/actions/execute", json={"actions": staged}).status_code == 404,
    )

    # ---------- 4) 预检索兜底 ----------
    llm.script = [
        {"content": ["太赫兹波大概是 1 THz 左右的东西吧。"]},
        {"content": ["太赫兹波是频率介于 0.1 THz 到 10 THz 之间的电磁波 [1]。"]},
    ]
    status, events = run_stream(client, pid, {"message": "太赫兹波频率范围？", "agent": True})
    kinds = [e.get("type") for e in events]
    done = next((e for e in events if e.get("type") == "done"), {})
    check("兜底：返回 200", status == 200, str(status))
    check("兜底：自动补了检索事件", kinds.count("tool") == 1, str(kinds))
    check(
        "兜底：最终答案带来源",
        bool(done.get("answer_segments")) and done.get("source_ids") == [source_id],
        json.dumps(done.get("answer_segments"), ensure_ascii=False)[:140],
    )
    check("兜底：最终答案里没有裸标记", "[1]" not in str(done.get("answer")), str(done.get("answer"))[:100])

    # ---------- 5) /agent 面板回归 ----------
    node_count_before = len(db.list_framework_nodes(pid))
    llm.script = [
        {"tools": [tool_call("add_node", {"name": "面板节点"}, "c9")]},
        {"content": ["已在知识库里新建节点「面板节点」。"]},
    ]
    with client.stream("POST", f"/api/projects/{pid}/agent", json={"message": "新建一个「面板节点」"}) as resp:
        events_agent = sse_events("".join(chunk for chunk in resp.iter_text()))
    done_agent = next((e for e in events_agent if e.get("type") == "done"), {})
    check("回归：/agent 返回 200", resp.status_code == 200, str(resp.status_code))
    check(
        "回归：/agent 写操作直接落库（仍是原行为）",
        len(db.list_framework_nodes(pid)) == node_count_before + 1,
        f"{node_count_before} -> {len(db.list_framework_nodes(pid))}",
    )
    check("回归：/agent 不产待确认动作", not done_agent.get("staged_actions"), str(done_agent.get("staged_actions")))
    check(
        "回归：/agent 仍挂全量工具",
        set(llm.tool_schema_names[-1]) == {t["function"]["name"] for t in api_server.LEARNING_AGENT_TOOLS},
        f"{len(llm.tool_schema_names[-1])} 个",
    )
    kb_prompt = " ".join(str(m.get("content")) for m in llm.messages_seen[-1] if isinstance(m, dict))
    check("回归：kb 面板提示词仍提到收敛按钮", "收敛按钮" in kb_prompt)

    # ---------- 6) 轮数耗尽后的「收尾合写」不能把伪调用当答案 ----------
    # 真机故障：工具跑满 5 轮后进入收尾合写，那一段走 astream_chat_content、没有工具累加器，
    # 模型再吐一次 {"name":..., "parameters":...} 就被当成最终答案渲染+存库。
    pretty = (
        '{\n  "name": "get_study_kit",\n  "parameters": {\n'
        '    "kind": "learning_path"\n  }\n}'
    )
    llm.script = [
        {"content": [pretty]} for _ in range(api_server.AGENT_MAX_ROUNDS_WRITABLE)
    ] + [{"content": [pretty]}]
    status, events = run_stream(client, pid, {"message": "知识卡片", "agent": True})
    done_final = next((e for e in events if e.get("type") == "done"), {})
    answer_final = str(done_final.get("answer") or "")
    check("收尾：请求 200", status == 200, str(status))
    check("收尾：答案不含工具名", "get_study_kit" not in answer_final, answer_final[:120])
    check("收尾：答案不含 parameters 键", '"parameters"' not in answer_final, answer_final[:120])
    check("收尾：答案不含裸 name 键", '"name"' not in answer_final, answer_final[:120])
    streamed = "".join(
        str(e.get("text") or "") for e in events if e.get("type") == "delta"
    )
    check("收尾：流式正文也不含工具名", "get_study_kit" not in streamed, streamed[:120])
    check(
        "收尾：库里最后一条 assistant 也不含工具名",
        all("get_study_kit" not in str(getattr(m, "content", "") or "")
            for m in db.list_messages(pid, conversation_id="")),
        [str(getattr(m, "content", ""))[:60] for m in db.list_messages(pid, conversation_id="")][-2:]
        and json.dumps(
            [str(getattr(m, "content", ""))[:60] for m in db.list_messages(pid, conversation_id="")][-2:],
            ensure_ascii=False,
        ),
    )

    # 正文里真的在讲这个 JSON 形态时不能被误伤（教学场景）
    teaching = (
        "平台没有原生函数调用，模型要用纯文本表达意图，形如 "
        '{"name": "工具名", "parameters": {"参数名": "值"}}；'
        "所以你在界面里看到的那段 JSON 是约定好的调用格式。"
    )
    llm.script = [{"content": [teaching]}]
    status, events = run_stream(client, pid, {"message": "工具调用格式是什么", "agent": False})
    done_teach = next((e for e in events if e.get("type") == "done"), {})
    answer_teach = str(done_teach.get("answer") or "")
    check("讲解 JSON 形态时不被误删", '"name": "工具名"' in answer_teach, answer_teach[:140])

    # ---------- 7) 普通对话流（agent=false）同样不能漏 ----------
    # 真机故障：模型被会话历史里的调用格式带跑，把 JSON 当正文吐出来。
    # 这条路没有工具累加器，全靠收尾处的清洗；系统提示词自称「学习辅导 Agent」，
    # 所以关掉 Agent 开关也照样会被带跑。
    llm.script = [{"content": ['{"name": "search_sources", "parameters": '
                               '{"query": "课程概况", "scope": "course"}}']}]
    status, events = run_stream(client, pid, {"message": "文档", "agent": False})
    done_plain = next((e for e in events if e.get("type") == "done"), {})
    answer_plain = str(done_plain.get("answer") or "")
    check("普通对话：请求 200", status == 200, str(status))
    check("普通对话：答案不含 search_sources", "search_sources" not in answer_plain, answer_plain[:120])
    check("普通对话：答案不含 parameters", '"parameters"' not in answer_plain, answer_plain[:120])
    check("普通对话：答案不含裸 name 键", '"name"' not in answer_plain, answer_plain[:120])

    # 截断/带尾巴的形态（重复输出守卫会产出这种）也不能漏出 JSON 本体
    llm.script = [{"content": [
        '{"name": "search_sources", "parameters": {"query": "考核方式", "scope": "course"}},......'
    ]}]
    status, events = run_stream(client, pid, {"message": "文档", "agent": False})
    done_trunc = next((e for e in events if e.get("type") == "done"), {})
    answer_trunc = str(done_trunc.get("answer") or "")
    check("普通对话：截断形态也不漏 JSON", "search_sources" not in answer_trunc, answer_trunc[:120])

    print()
    if FAILS:
        print(f"失败 {len(FAILS)} 项：{FAILS}")
        return 1
    print("A 线全部通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())