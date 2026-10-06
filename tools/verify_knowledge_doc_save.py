"""知识文档「保存正文」端点回归（TestClient，fake 模型，不需要 key 与网络）。

跑法：``.venv311\\Scripts\\python.exe tools/verify_knowledge_doc_save.py``

覆盖 ——
  1. 文档不存在时 PUT → 404（提示先生成），而不是静默新建一条脏数据
  2. 正文为空 → 400
  3. 正常保存 → 200，且 GET 回来的就是改过的正文（含 == 高亮）
  4. 结构化留档（content）与指纹不受影响
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

FAILS = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


class FakeLlm(LlmClient):
    def __init__(self, settings):
        super().__init__(settings, responder=None)

    def complete_json(self, task, payload):
        return {
            "summary": "光子与电子碰撞后波长变长。",
            "definition": "散射前后波长差只取决于散射角。",
            "progression": {"before": "", "after": "", "why_order": "它是这一节的起点。"},
            "mechanism": ["入射光子撞上电子", "能量转移后波长变长"],
            "formulas": [],
            "pitfalls": [],
            "relations": [],
            "self_check": [],
            "grounding": "取自资料。",
        }

    async def astream_chat_content(self, messages, task, **kwargs):
        yield "（fake）"


def main():
    tmp = Path(tempfile.mkdtemp(prefix="knoworigin-kdsave-"))
    settings = Settings(
        tju_api_key="tk-verify-placeholder",
        tju_base_url="https://example.invalid/api",
        tju_model="tju-llm",
        data_dir=tmp,
        usage_tracking_enabled=False,
    )
    db = Database(tmp / "verify.sqlite3")
    app = create_app(db, settings, FakeLlm(settings))
    client = TestClient(app)

    client.post("/api/auth/register", json={"email": "a@e.com", "password": "abcd1234", "name": "A"})
    pid = client.post("/api/projects", json={"year": "2026", "subject": "物理"}).json()["project_id"]
    node = db.add_framework_node(pid, name="康普顿散射", description="光子与电子的弹性碰撞")
    node_id = node.node_id

    url = f"/api/projects/{pid}/knowledge-doc/content"

    # 1) 没生成过 → 404
    r = client.put(url, json={"scope": "node", "node_id": node_id, "content_md": "随便写"})
    check("没生成过就保存 → 404", r.status_code == 404, str(r.status_code))

    # 先生成一份（sync_cards=false，不动卡片表）
    gen = client.post(f"/api/projects/{pid}/nodes/{node_id}/doc?sync_cards=false")
    check("生成文档成功", gen.status_code == 200, str(gen.status_code))
    original = gen.json()["content_md"]

    # 2) 空正文 → 400
    r = client.put(url, json={"scope": "node", "node_id": node_id, "content_md": "   "})
    check("空正文 → 400", r.status_code == 400, str(r.status_code))

    # 3) 正常保存
    edited = original.replace("波长变长。", "波长变长，==偏移量只跟散射角有关==。")
    r = client.put(url, json={"scope": "node", "node_id": node_id, "content_md": edited})
    check("保存 → 200", r.status_code == 200, str(r.status_code) + " " + r.text[:120])

    got = client.get(f"/api/projects/{pid}/nodes/{node_id}/doc").json()["doc"]
    check("GET 回来的就是改过的正文", got["content_md"] == edited, got["content_md"][:80])
    check("高亮标记落进了库", "==偏移量只跟散射角有关==" in got["content_md"])
    check("结构化留档没被改", got["content"].get("summary") == "光子与电子碰撞后波长变长。",
          str(got["content"].get("summary")))
    check("更新时间被顶掉了", got["updated_at"] > gen.json()["updated_at"],
          f'{gen.json()["updated_at"]} -> {got["updated_at"]}')

    # 4) 合订稿走的是同一条路（scope=project，槽位键里 node_id 那格是 <project>）。
    #    用户在阅读页上改的多半就是这一份，必须验到。
    c = client.post(f"/api/projects/{pid}/knowledge-doc/compile", json={})
    check("合订成功", c.status_code == 200, str(c.status_code) + " " + c.text[:120])
    compiled = client.get(f"/api/projects/{pid}/knowledge-doc/compiled").json()["doc"]
    r = client.put(url, json={"scope": "project", "node_id": "",
                              "content_md": compiled["content_md"] + "\n\n手写补一句。"})
    check("合订稿保存 → 200", r.status_code == 200, str(r.status_code) + " " + r.text[:120])
    again = client.get(f"/api/projects/{pid}/knowledge-doc/compiled").json()["doc"]
    check("合订稿改动落库", again["content_md"].endswith("手写补一句。"), again["content_md"][-30:])

    print("\n%d 项未通过" % len(FAILS) if FAILS else "\n全部通过")
    sys.exit(1 if FAILS else 0)


main()
