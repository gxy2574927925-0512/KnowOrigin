"""成文产物（速查表 / 学习路径 / 清单报告）支持「针对某个知识点」的回归。

背景：``POST /api/projects/{id}/study-kit/generate`` 原来只有 ``{"kind": ...}`` 一个参数，
输入固定是**整份材料**的全量节点与资料 —— 于是「针对某个薄弱知识点出一张速查表」
这件事在 Agent 侧根本做不了，只能整章地出。``study_kit.build_payload`` 早就预留了
``focus_node``、表里也早有 ``node_id`` 列，但两者都没接上，``node_id`` 恒为 NULL。

这次把它接通了，顺带改了 ``StudyKitStore.save`` 的去重维度（加节点），所以要守住四件事：

  1. ``focus_scope`` 收窄到子树，且 parent_id 指向任意深层都收得进来；
  2. **向后兼容**：不带 node_id 时，生成与去重行为与改造前逐字节一致
     （尤其 ``save`` 仍是「同项目同 kind 只留一份」，不会在旧数据上攒重复副本）；
  3. ``get()`` 默认仍优先返回**项目级**那一份 —— 否则一份窄表会把整章那一份顶掉，
     台历里打开就成了单知识点的表；
  4. 端点真的把 node_id 透传进 payload 与落库，不存在的节点要 404 而不是静默出整章。

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
from core.study_kit import StudyKitStore, focus_scope  # noqa: E402

SOURCE_TEXT = (
    "第1章 光的量子性\n"
    "光电效应指光照射金属时逸出电子的现象，阈值频率与金属种类有关。\n"
    "第2章 康普顿散射\n"
    "康普顿散射是光子与自由电子碰撞后波长改变的现象，Δλ = h/(m₀c)(1-cosθ)。\n"
    "第3章 原子结构\n"
    "玻尔模型用定态假设解释氢原子能级，能级差决定发射光子的频率。\n"
)

FAILS = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


class ScriptedLlm(LlmClient):
    """只实现 study-kit 用得到的那一个方法，并把 payload 留下来给断言看。"""

    def __init__(self, settings):
        super().__init__(settings, responder=None)
        self.kit_payloads = []

    def complete_json(self, task, payload):
        self.kit_payloads.append(payload)
        return {"content": "## 速查表\n\n| 术语 | 含义 |\n| --- | --- |\n| 光电效应 | 光照金属逸出电子 |"}


class Node:
    """focus_scope 只认 node_id / parent_id / source_ids 三个属性，比构造真模型轻。"""

    def __init__(self, node_id, parent_id=None, source_ids=()):
        self.node_id = node_id
        self.parent_id = parent_id
        self.source_ids = list(source_ids)


def store_cases(tmp):
    print("== StudyKitStore / focus_scope ==")
    path = tmp / "kit.sqlite3"
    store = StudyKitStore(path)

    # 一棵三层树，其中 grandchild 的 parent 指向中层（而不是根）——
    # 只往下走一层的写法会漏掉它。
    nodes = [
        Node("n1"),
        Node("n2", "n1", ["s1", "s2"]),
        Node("n3", "n2", ["s2", "s3"]),
        Node("n4"),
        Node("n5", "n4"),
    ]

    whole, whole_ids = focus_scope(nodes, None)
    check("focus_scope(None) 原样返回全部节点", [n.node_id for n in whole] == ["n1", "n2", "n3", "n4", "n5"],
          str([n.node_id for n in whole]))
    check("focus_scope(None) 不编造 source_ids", whole_ids == [], str(whole_ids))

    scope, ids = focus_scope(nodes, Node("n1"))
    check("focus_scope 收整棵子树（含孙子层）",
          [n.node_id for n in scope] == ["n1", "n2", "n3"], str([n.node_id for n in scope]))
    check("focus_scope 汇总子树 source_ids 且去重",
          ids == ["s1", "s2", "s3"], str(ids))

    other, _ = focus_scope(nodes, Node("n4"))
    check("focus_scope 只取目标那一支", [n.node_id for n in other] == ["n4", "n5"],
          str([n.node_id for n in other]))

    # ---- save 的去重维度 ----
    store.save(project_id="p1", owner_id="u1", kind="cheatsheet", title="整章", content_md="A")
    store.save(project_id="p1", owner_id="u1", kind="cheatsheet", title="整章", content_md="B")
    only_project = [k for k in store.list_for_project("p1") if k["kind"] == "cheatsheet"]
    check("不带 node_id 时仍按「同项目同 kind 只留一份」去重（改造前的行为）",
          len(only_project) == 1 and only_project[0]["content_md"] == "B",
          str([(k["title"], k["content_md"]) for k in only_project]))

    store.save(project_id="p1", owner_id="u1", kind="cheatsheet", title="窄表1", content_md="C",
               node_id="n1")
    store.save(project_id="p1", owner_id="u1", kind="cheatsheet", title="窄表1", content_md="D",
               node_id="n1")
    store.save(project_id="p1", owner_id="u1", kind="cheatsheet", title="窄表2", content_md="E",
               node_id="n4")
    kits = [k for k in store.list_for_project("p1") if k["kind"] == "cheatsheet"]
    check("同一节点重复生成只留最新一份",
          sum(1 for k in kits if k["node_id"] == "n1") == 1
          and next(k for k in kits if k["node_id"] == "n1")["content_md"] == "D",
          str([(k["node_id"], k["content_md"]) for k in kits]))
    check("不同节点各留一份，互不顶掉",
          sorted(str(k["node_id"]) for k in kits) == ["None", "n1", "n4"],
          str(sorted(str(k["node_id"]) for k in kits)))
    check("项目级那一份没被节点级顶掉",
          next(k for k in kits if k["node_id"] is None)["content_md"] == "B")

    # ---- get 的优先级 ----
    got = store.get("p1", "cheatsheet")
    check("get() 默认返回项目级那一份（不被窄表顶掉）",
          got is not None and got["node_id"] is None, str(got and got["node_id"]))
    got_node = store.get("p1", "cheatsheet", "n1")
    check("get(..., node_id) 精确匹配节点级那一份",
          got_node is not None and got_node["content_md"] == "D", str(got_node and got_node["content_md"]))
    check("get(..., node_id) 取不到时返回 None（不静默回落到别的节点）",
          store.get("p1", "cheatsheet", "n_nope") is None)

    # 只有节点级、没有项目级时，get() 要能兜住（不能返回 None 让台历空着）
    store.save(project_id="p2", owner_id="u1", kind="learning_path", title="窄", content_md="F",
               node_id="n9")
    fallback = store.get("p2", "learning_path")
    check("没有项目级时 get() 退回最新的一份节点级产物",
          fallback is not None and fallback["node_id"] == "n9", str(fallback and fallback["node_id"]))

    check("list_for_project 列出全部（含 node_id 维度）",
          len(store.list_for_project("p1")) == 3, str(len(store.list_for_project("p1"))))
    check("list_for_project 不串到别的项目",
          all(k["project_id"] == "p1" for k in store.list_for_project("p1")))
    store.close()


def endpoint_cases(tmp):
    print()
    print("== POST /study-kit/generate ==")
    db = Database(tmp / "e2e.sqlite3")
    settings = Settings(
        tju_api_key="tk-verify-placeholder",
        tju_base_url="https://example.invalid/api",
        tju_model="tju-llm",
        data_dir=tmp,
        usage_tracking_enabled=False,
    )
    llm = ScriptedLlm(settings)
    client = TestClient(create_app(db, settings, llm))
    client.post("/api/auth/register",
                json={"email": "s@e.com", "password": "abcd1234", "name": "S"})
    pid = client.post("/api/projects", json={"year": "2026", "subject": "近代物理"}).json()["project_id"]
    client.post(f"/api/projects/{pid}/sources", data={"pasted_text": SOURCE_TEXT})
    # 给要聚焦的那一支挂上资料，验证「资料随子树一起收窄」
    src_id = db.list_sources(pid)[0].source_id

    db.add_framework_node(pid, name="光电效应", description="光照金属逸出电子")
    root = db.add_framework_node(pid, name="康普顿散射", description="光子与电子碰撞",
                                 source_ids=[src_id])
    db.add_framework_node(pid, name="康普顿波长偏移", parent_id=root.node_id,
                          source_ids=[src_id])
    db.add_framework_node(pid, name="玻尔模型", description="氢原子能级")

    url = f"/api/projects/{pid}/study-kit/generate"

    resp = client.post(url, json={"kind": "cheatsheet"})
    check("不给 node_id 仍能生成（别把可选参数改成必填）", resp.status_code == 200, str(resp.status_code))
    kit = resp.json().get("kit") or {}
    check("不给 node_id 时落库 node_id 为空（整份材料那一份）", kit.get("node_id") is None, str(kit.get("node_id")))
    check("整份材料那一份的 focus 沿用「整份材料」",
          llm.kit_payloads[-1].get("focus") == "整份材料", str(llm.kit_payloads[-1].get("focus")))
    check("整份材料那一份喂进去的是全量节点", len(llm.kit_payloads[-1]["nodes"]) == 4,
          str(len(llm.kit_payloads[-1]["nodes"])))

    resp2 = client.post(url, json={"kind": "cheatsheet", "node_id": root.node_id})
    check("给合法 node_id 能生成", resp2.status_code == 200, str(resp2.status_code))
    node_kit = resp2.json().get("kit") or {}
    check("节点级产物落库带 node_id", node_kit.get("node_id") == root.node_id, str(node_kit.get("node_id")))
    check("节点级产物标题带节点名（台历上分得清整章与窄表）",
          "康普顿散射" in (node_kit.get("title") or ""), str(node_kit.get("title")))
    payload = llm.kit_payloads[-1]
    check("节点级生成的 focus 是节点名", payload.get("focus") == "康普顿散射", str(payload.get("focus")))
    check("节点级生成只喂子树节点", [n["name"] for n in payload["nodes"]] == ["康普顿散射", "康普顿波长偏移"],
          str([n["name"] for n in payload["nodes"]]))
    check("节点级生成仍带着资料（子树关联的那份）", bool(payload["sources"]),
          str(len(payload["sources"])))

    listed = client.get(f"/api/projects/{pid}/study-kit").json().get("kits") or []
    cheats = [k for k in listed if k["kind"] == "cheatsheet"]
    check("两份都在列表里（项目级 + 节点级）", len(cheats) == 2,
          str([(k["node_id"], k["title"]) for k in cheats]))

    bad = client.post(url, json={"kind": "cheatsheet", "node_id": "node_不存在"})
    check("node_id 不存在时 404（别静默退回整份材料）", bad.status_code == 404, str(bad.status_code))
    bad_kind = client.post(url, json={"kind": "不存在的种类"})
    check("非法 kind 仍然 400（回归）", bad_kind.status_code == 400, str(bad_kind.status_code))

    other = TestClient(create_app(db, settings, llm))
    other.post("/api/auth/register", json={"email": "y@e.com", "password": "abcd1234", "name": "Y"})
    check("越权访问别人项目的成文产物 404",
          other.post(url, json={"kind": "cheatsheet"}).status_code == 404,
          str(other.post(url, json={"kind": "cheatsheet"}).status_code))

    db.close()


def main():
    tmp = Path(tempfile.mkdtemp(prefix="knoworigin-kit-scope-"))
    store_cases(tmp)
    endpoint_cases(tmp)
    print()
    if FAILS:
        print(f"FAIL：{len(FAILS)} 项")
        for item in FAILS:
            print(f"  - {item}")
        return 1
    print("成文产物按知识点生成的回归全部通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
