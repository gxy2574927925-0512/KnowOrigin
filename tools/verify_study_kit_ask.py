"""``POST /api/projects/{id}/study-kit/ask``（就着「学习文档」提问）的回归。

为什么另起一个端点而不是复用 ``/knowledge-doc/ask``：那个端点的 ``scope=project``
写死了去读**合订稿**（``knowledge_docs``）。拿它来答「速查表里这条为什么这么写」，
模型手里会是另一份文档的内容 —— 答案看着像模像样，其实答的不是用户眼前这篇。

所以这里要守住四件事：

  1. **材料来源是 study_kits**，而且**只收项目级那一份**（``node_id`` 为空）——
     节点级窄表混进来，这份「整份文档」就变成了某个知识点的表；
  2. ``kind`` 指定的那一份要排在**最前面** —— 三份合起来常超过 ``ASK_MAX_CONTEXT``，
     排后面会被 ``excerpt_around`` 的头部截断丢掉；
  3. 证据边界与生成阶段一致：``allow_extra`` 默认 false 且原样透传到 payload；
  4. 越权一律 404，空问题 400，没有产物 400（不要静默给个空上下文让模型自由发挥）。

用真 Database + 真 StudyKitStore + TestClient（脚本化 LlmClient，无网络）跑。
"""
import sys
import tempfile
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from fastapi.testclient import TestClient  # noqa: E402

from api_server import create_app  # noqa: E402
from config import Settings  # noqa: E402
from core.database import Database  # noqa: E402
from core.llm import LlmClient  # noqa: E402

SOURCE_TEXT = "第1章 增益饱和\n光强增大时反转集居数差下降，增益系数随之下降。\n"

KIT_BODY = {
    "cheatsheet": "## 一页速查表\n\n项目级速查表正文：增益系数 G 随光强增大而下降。\n",
    "learning_path": "## 前置知识\n\n项目级路径正文：先掌握集居数反转，再看增益饱和。\n",
    "checklist": "## 已经会了\n\n- [ ] 增益饱和 —— 项目级清单正文。\n",
}

FAILS = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


class ScriptedLlm(LlmClient):
    """生成走 complete_json（按 kind 给不同正文），提问走流式桩路径。

    用 ``responder`` 而不是自己实现 ``astream_chat_content``：桩路径会把整段答案切块
    yield，形状与真实流一致 —— 于是「边收边渲染」这条前端行为在测试里也真的跑到。
    """

    def __init__(self, settings):
        self.ask_payloads = []
        self.kit_kinds = []
        super().__init__(settings, responder=self._respond)

    def _respond(self, task, payload):
        self.ask_payloads.append(payload)
        return "这条说的是**增益饱和**：光强 I 增大时反转集居数差下降，于是 G 下降。"

    def complete_json(self, task, payload):
        kind = str(payload.get("kind") or "cheatsheet")
        self.kit_kinds.append(kind)
        return {"content": KIT_BODY.get(kind, KIT_BODY["cheatsheet"])}


def sse_events(text):
    out = []
    for chunk in str(text or "").split("\n\n"):
        line = chunk.strip()
        if not line.startswith("data:"):
            continue
        import json

        try:
            out.append(json.loads(line[5:].strip()))
        except ValueError:
            pass
    return out


def main():
    tmp = Path(tempfile.mkdtemp(prefix="knoworigin-kit-ask-"))
    db = Database(tmp / "ask.sqlite3")
    settings = Settings(
        tju_api_key="tk-verify-placeholder",
        tju_base_url="https://example.invalid/api",
        tju_model="tju-llm",
        data_dir=tmp,
        usage_tracking_enabled=False,
    )
    llm = ScriptedLlm(settings)
    app = create_app(db, settings, llm)

    routes = {
        (method, getattr(route, "path", ""))
        for route in app.routes
        for method in getattr(route, "methods", []) or []
    }
    check("路由已注册", ("POST", "/api/projects/{project_id}/study-kit/ask") in routes)

    client = TestClient(app)
    client.post("/api/auth/register",
                json={"email": "s@e.com", "password": "abcd1234", "name": "S"})
    pid = client.post("/api/projects", json={"year": "2026", "subject": "激光原理"}).json()["project_id"]
    client.post(f"/api/projects/{pid}/sources", data={"pasted_text": SOURCE_TEXT})
    db.add_framework_node(pid, name="增益饱和", description="光强增大增益下降")
    root = db.add_framework_node(pid, name="激光原理", description="整章")
    url = f"/api/projects/{pid}/study-kit/ask"

    print()
    print("== 前置校验 ==")
    empty = client.post(url, json={"question": "   "})
    check("空问题 400", empty.status_code == 400, str(empty.status_code))
    check("空问题的错误码是 study_kit_question_required",
          (empty.json().get("detail") or {}).get("error") == "study_kit_question_required"
          or "study_kit_question_required" in str(empty.json()),
          str(empty.json())[:120])

    none_yet = client.post(url, json={"question": "增益饱和是什么？"})
    check("还没有任何产物时 400（不静默给空上下文）", none_yet.status_code == 400,
          str(none_yet.status_code))
    check("错误里说清了要先生成", "还没有学习文档" in str(none_yet.json()), str(none_yet.json())[:160])

    print()
    print("== 只收项目级那一份 ==")
    gen = f"/api/projects/{pid}/study-kit/generate"
    for kind in ("cheatsheet", "learning_path", "checklist"):
        client.post(gen, json={"kind": kind})
    # 再针对某个知识点出一份窄表 —— 它绝不能进提问上下文
    client.post(gen, json={"kind": "cheatsheet", "node_id": root.node_id})
    kits = client.get(f"/api/projects/{pid}/study-kit").json().get("kits") or []
    check("库里确实同时有项目级与节点级产物",
          len([k for k in kits if k["node_id"] is None]) == 3
          and len([k for k in kits if k["node_id"] is not None]) == 1,
          str([(k["kind"], k["node_id"]) for k in kits]))

    llm.ask_payloads.clear()
    resp = client.post(url, json={"question": "增益饱和是什么？"})
    check("有产物时 200", resp.status_code == 200, str(resp.status_code))
    check("响应是 SSE", "text/event-stream" in (resp.headers.get("content-type") or ""),
          str(resp.headers.get("content-type")))

    events = sse_events(resp.text)
    kinds = [e.get("type") for e in events]
    check("事件序列是 start → delta… → done",
          kinds[:1] == ["start"] and kinds[-1:] == ["done"] and "delta" in kinds, str(kinds))
    done = next((e for e in events if e.get("type") == "done"), {})
    check("done 带完整答案", "增益饱和" in str(done.get("text") or ""), str(done.get("text"))[:40])
    check("start 列出用到的产物", sorted(events[0].get("kits") or []) ==
          ["cheatsheet", "checklist", "learning_path"], str(events[0].get("kits")))

    payload = llm.ask_payloads[-1]
    context = str(payload.get("context") or "")
    check("上下文含项目级正文", "项目级速查表正文" in context and "项目级路径正文" in context,
          context[:60].replace("\n", "⏎"))
    check("上下文**不含**节点级窄表（否则整份文档会变成某个知识点的表）",
          "节点级" not in context and str(root.node_id) not in context)
    check("三份都在上下文里", all(tag in context for tag in
          ("## 一页速查表", "## 学习路径", "## 清单报告")), context[:80].replace("\n", "⏎"))

    print()
    print("== kind 优先级 / allow_extra / 越权 ==")
    llm.ask_payloads.clear()
    client.post(url, json={"question": "下一步学什么？", "kind": "learning_path"})
    context = str(llm.ask_payloads[-1].get("context") or "")
    check("kind 指定的那一份排在最前（排后面会被头部截断丢掉）",
          context.index("## 学习路径") < context.index("## 一页速查表"), context[:60].replace("\n", "⏎"))

    check("默认 allow_extra=false", llm.ask_payloads[-1].get("allow_extra") is False,
          str(llm.ask_payloads[-1].get("allow_extra")))
    check("默认档位的规则里写着「材料外直说没写」",
          "没写" in str(llm.ask_payloads[-1].get("rules") or ""),
          str(llm.ask_payloads[-1].get("rules"))[:60])

    llm.ask_payloads.clear()
    client.post(url, json={"question": "顺便讲讲腔模", "allow_extra": True})
    check("allow_extra=true 透传到 payload", llm.ask_payloads[-1].get("allow_extra") is True)
    check("发散档的规则要求单独标注补充",
          "材料外补充" in str(llm.ask_payloads[-1].get("rules") or ""),
          str(llm.ask_payloads[-1].get("rules"))[:80])

    llm.ask_payloads.clear()
    client.post(url, json={"question": "这一段什么意思？", "selection": "光强增大时反转集居数差下降",
                           "section": "清单报告"})
    payload = llm.ask_payloads[-1]
    check("选区与所在小节原样进 payload",
          "光强增大" in str(payload.get("selection") or "")
          and payload.get("section") == "清单报告",
          str({k: payload.get(k) for k in ("selection", "section")}))

    other = TestClient(create_app(db, settings, llm))
    other.post("/api/auth/register",
               json={"email": "y@e.com", "password": "abcd1234", "name": "Y"})
    check("越权访问别人项目的学习文档 404",
          other.post(url, json={"question": "随便问问"}).status_code == 404,
          str(other.post(url, json={"question": "随便问问"}).status_code))

    db.close()
    print()
    if FAILS:
        print(f"失败 {len(FAILS)} 项：{FAILS}")
        raise SystemExit(1)
    print("学习文档提问端点回归通过。")


if __name__ == "__main__":
    main()
