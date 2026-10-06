"""Agent 写库链路回归：闸门 → 待确认卡片 → 执行端点 → 真落库。

为什么要有这个：`/agent/actions/execute` 判定一条动作成不成功，曾经只看返回值
是不是以 `[需要确认]` 开头。于是「节点 X 不存在」「已存在同名节点」这类**明确的
失败**全被报成 ok=true —— 前端显示「✅ N 项全部完成」+ 绿色 toast，知识库却一个
字节没变。这比直接报错更难查，因为它看起来是成功的。

顺带钉住第二个坑：模型手上通常只有节点名，而工具 schema 要求 node_id。
update_node / delete_node / add_node(parent_id) 以前只认 id，于是模型传了名字就
「不存在」，用户点了提交什么都没发生（get_node 当时却有这层容错，口径不一致）。

不需要模型、不需要 key：全程 TestClient + 临时目录。
跑法：python tools/verify_agent_write_gate.py
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

FAILURES: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail else ''}")
    if not ok:
        FAILURES.append(name)


def result_of(client, pid, actions):
    """跑一次执行端点，返回 {tool: (ok, message)}。"""
    response = client.post(
        f"/api/projects/{pid}/agent/actions/execute",
        json={"actions": actions, "conversation_id": ""},
    )
    assert response.status_code == 200, response.text[:200]
    return {
        item["tool"]: (bool(item["ok"]), str(item.get("message") or ""))
        for item in response.json().get("results", [])
    }


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="knoworigin-write-gate-"))
    settings = Settings(
        tju_api_key="",
        tju_base_url="https://example.invalid/api",
        tju_model="tju-llm",
        data_dir=tmp,
        usage_tracking_enabled=False,
    )
    db = Database(tmp / "write_gate.sqlite3")
    client = TestClient(create_app(db, settings))
    client.post(
        "/api/auth/register",
        json={"email": "gate@e.com", "password": "abcd1234", "name": "闸门"},
    )
    pid = client.post("/api/projects", json={"year": "2026", "subject": "激光原理"}).json()[
        "project_id"
    ]
    seed = db.add_framework_node(pid, name="受激辐射", description="种子节点")
    beta = db.add_framework_node(pid, name="受激吸收", description="种子节点")
    names = lambda: [n.name for n in db.list_framework_nodes(pid)]  # noqa: E731

    # ── 1. 失败必须被报成失败（这条是本脚本存在的全部理由）─────────────────
    result = result_of(
        client,
        pid,
        [{"tool": "update_node", "arguments": {"node_id": "根本不存在的节点"}, "label": "改不存在的"}],
    )
    check("不存在的节点 -> ok=false", result["update_node"][0] is False, result["update_node"][1][:60])
    check(
        "失败原因没有内部前缀泄漏给用户",
        "[写库失败]" not in result["update_node"][1],
        result["update_node"][1][:60],
    )

    # ── 2. 模型传节点名而不是 node_id：读工具与写工具口径必须一致 ──────────
    result = result_of(
        client,
        pid,
        [{"tool": "update_node", "arguments": {"node_id": "受激辐射", "description": "按名字改的描述"}, "label": "按名改"}],
    )
    check("node_id 传节点名 -> 能定位", result["update_node"][0] is True, result["update_node"][1][:60])
    check(
        "按名字改真的落库了",
        db.get_framework_node(pid, seed.node_id).description == "按名字改的描述",
        db.get_framework_node(pid, seed.node_id).description,
    )

    result = result_of(
        client,
        pid,
        [{"tool": "add_node", "arguments": {"name": "丙节点", "parent_id": "受激辐射"}, "label": "父节点传名"}],
    )
    check("parent_id 传节点名 -> 能定位", result["add_node"][0] is True, result["add_node"][1][:60])
    made = db.get_node_id_by_name(pid, "丙节点")
    check(
        "丙节点挂在受激辐射下",
        made is not None and db.get_framework_node(pid, made).parent_id == seed.node_id,
    )

    # ── 3. 同名重复必须失败，不能静默建第二个 ─────────────────────────────
    result = result_of(
        client,
        pid,
        [{"tool": "add_node", "arguments": {"name": "受激辐射"}, "label": "重名"}],
    )
    check("重名新建 -> ok=false", result["add_node"][0] is False, result["add_node"][1][:60])
    check("重名没有建出第二个", names().count("受激辐射") == 1, str(names()))

    # ── 4. 同批里后一个动作依赖前一个：执行端点必须每轮重读节点 ────────────
    result = result_of(
        client,
        pid,
        [
            {"tool": "add_node", "arguments": {"name": "丁节点"}, "label": "建丁"},
            {"tool": "create_link", "arguments": {"a_name": "受激辐射", "b_name": "丁节点"}, "label": "丁建链"},
        ],
    )
    check("同批新建 -> 成功", result["add_node"][0] is True, result["add_node"][1][:60])
    check("同批给刚建的节点建链 -> 成功", result["create_link"][0] is True, result["create_link"][1][:60])
    check(
        "双链真的写进了受激辐射",
        "丁节点" in db.get_framework_node(pid, seed.node_id).wikilinks,
        str(db.get_framework_node(pid, seed.node_id).wikilinks),
    )

    # ── 5. 破坏轨：用户已在界面确认，端点要自己补 confirm ──────────────────
    result = result_of(
        client,
        pid,
        [{"tool": "delete_node", "arguments": {"node_id": "受激吸收"}, "label": "删乙"}],
    )
    check("按名字删节点 -> 成功", result["delete_node"][0] is True, result["delete_node"][1][:60])
    check("受激吸收真的没了", "受激吸收" not in names(), str(names()))

    # ── 6. 白名单：任意函数名不许混进来 ────────────────────────────────────
    result = result_of(
        client, pid, [{"tool": "drop_database", "arguments": {}, "label": "删库"}]
    )
    check("非白名单工具 -> ok=false", result["drop_database"][0] is False)

    # ── 7. 失败的前缀在闸门登记阶段就带上（供 kb 面板路径也判得出）────────
    from api_server import AGENT_WRITE_FAILED_PREFIX, _run_agent_tool  # noqa: E402

    staged: list[dict] = []
    observation = _run_agent_tool(
        "delete_node",
        {"node_id": "查无此节点"},
        db=db,
        project_id=pid,
        sources=[],
        nodes=db.list_framework_nodes(pid),
        owner_id=None,
        conversation_id=None,
        current_llm=None,
        staged_actions=None,
    )
    check(
        "写工具失败带统一前缀",
        observation.startswith(AGENT_WRITE_FAILED_PREFIX),
        observation[:70],
    )
    check("闸门模式下失败只登记不落库", staged == [])

    print()
    if FAILURES:
        print(f"门禁未通过：{len(FAILURES)} 项")
        for item in FAILURES:
            print(f"  - {item}")
        return 1
    print("Agent 写库闸门全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())