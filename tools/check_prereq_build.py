"""补建前置：AI 建议 → 人确认 → 只追加落库。

为什么要有这条路（而不是重新生成框架）：
前置图实测覆盖率约 9%（183 个知识点里 17 个有前置）。重新生成框架会换掉全部 node_id，
等于把已有的掌握度、笔记、收藏全废掉 —— 所以存量项目必须有一条**只补边**的路。

跑法：.venv311/Scripts/python.exe tools/check_prereq_build.py

断言重点在**过滤**与**只追加不删除**：
  [1] 建议过滤：不存在 / 自指 / 重复 / 已存在 / 反向边（会成环）一律丢掉，且**记账**丢了多少
  [2] 落库是并集 —— 已有的前置（可能是用户自己标的）绝不会被删
  [3] 非法节点跳过、stats 反映真实变化
  [4] 没配模型时给的是「为什么做不了」，不是 500
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

TMP = Path(tempfile.mkdtemp(prefix="prereqbuild_"))
os.environ["DATA_DIR"] = str(TMP)

from fastapi.testclient import TestClient  # noqa: E402

from api_server import create_app  # noqa: E402
from core.framework import (  # noqa: E402
    build_prereq_payload,
    validate_prereq_response,
)
from core.models import FrameworkNode  # noqa: E402

PASS = 0
FAIL = 0


def check(label: str, cond: bool, extra: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok   {label}")
    else:
        FAIL += 1
        print(f"  FAIL {label}  {extra}")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def node(nid, name, prereq=()):
    return FrameworkNode(
        node_id=nid, project_id="p", parent_id=None, name=name,
        description=f"{name} 的描述", coverage_status="covered",
        learning_status="unexplored", mastery_score=0.0, source_ids=[],
        prerequisite_ids=list(prereq), exam_weight="exam_normal",
    )


print("[1] 建议过滤：模型说什么都要先过一遍")
nodes = [
    node("A", "基础"),
    node("B", "进阶"),
    node("C", "应用", ["A"]),   # 已有一条前置 A
    node("D", "综合"),
]
# 反向边：A→B 已存在（在 DB 里），建议 B→A 会立刻成环
nodes[0] = node("A", "基础", ["B"])

response = {
    "edges": [
        {"node_id": "B", "prerequisite_ids": ["A"]},      # 反向边（A 已依赖 B）→ 丢
        {"node_id": "C", "prerequisite_ids": ["A", "B"]}, # A 已存在 → 只留 B
        {"node_id": "C", "prerequisite_ids": ["C"]},      # 自指 → 丢
        {"node_id": "D", "prerequisite_ids": ["ghost"]},  # 不存在 → 丢
        {"node_id": "nope", "prerequisite_ids": ["A"]},   # 节点不存在 → 丢
        {"node_id": "D", "prerequisite_ids": ["A", "A"]},# 合法 + 重复去重
    ]
}
parsed = validate_prereq_response(response, nodes)
sugg = {s["node_id"]: s for s in parsed["suggestions"]}
check("保留下来的建议只有 C 与 D", sorted(sugg) == ["C", "D"], str(sorted(sugg)))
check("C 只追加了 B（A 已存在，不重复）", sugg.get("C") and sugg["C"]["prerequisite_ids"] == ["B"],
      str(sugg.get("C")))
check("D 追加了 A，且重复项去重", sugg.get("D") and sugg["D"]["prerequisite_ids"] == ["A"],
      str(sugg.get("D")))
check("反向边被拦下并记账", parsed["skipped_cycle"] >= 1, str(parsed))
check("已存在的前置被记账", parsed["skipped_existing"] >= 1, str(parsed))
check("编造的 node_id 被记账", parsed["invalid_count"] >= 2, str(parsed))
check("边数统计正确", parsed["edge_count"] == 2, str(parsed["edge_count"]))
check("建议里带上了名字（给人看，不只是 id）",
      sugg.get("D") and sugg["D"]["prerequisite_names"] == ["基础"],
      str(sugg.get("D")))

print("[1b] LLM 输入里带着现有前置（否则模型会重复建议已有的边）")
payload = build_prereq_payload(nodes)
check("payload 里有 nodes", len(payload["nodes"]) == 4)
check("每个节点带 existing_prerequisite_ids",
      all("existing_prerequisite_ids" in n for n in payload["nodes"]))
check("rules 里写清了「不要把同章/相关当前置」",
      any("同一章" in str(r) for r in payload["rules"]))
check("rules 里写清了「拿不准就别填」",
      any("拿不准" in str(r) for r in payload["rules"]))
check("description 被截断（避免炸 token）",
      all(len(n["description"]) <= 120 for n in payload["nodes"]))

# ────────────────────── [2]~[4] 端到端 ──────────────────────

print("[2] 落库：只追加，绝不删已有的")
app = create_app()
client = TestClient(app)
registered = client.post(
    "/api/auth/register",
    json={"email": "prereqbuild@example.com", "name": "欣瑶", "password": "pw12345678"},
)
owner = registered.json()["user"]["user_id"]
db_path = next(p for p in TMP.rglob("*.sqlite3") if "knoworigin" in p.name)
conn = sqlite3.connect(str(db_path))
pid = "proj_prereqbuild"
conn.execute(
    "INSERT INTO projects (project_id, owner_id, year, subject, created_at,"
    " project_type, tags, reading_status, last_position, last_opened_at,"
    " total_reading_seconds) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    (pid, owner, "2026", "补建前置自证", now_iso(), "course", "[]", "unread", 0.0, now_iso(), 0),
)
# C 已经有一条自己标的前置 A —— apply 之后这条必须在
for nid, prereq in (("A", []), ("B", []), ("C", ["A"])):
    conn.execute(
        "INSERT INTO framework_nodes (node_id, project_id, parent_id, name,"
        " description, coverage_status, learning_status, mastery_score,"
        " source_ids, prerequisite_ids, exam_weight, updated_at, note_content,"
        " tags, wikilinks) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (nid, pid, "", f"知识点 {nid}", "自证", "covered", "unexplored", 0.0,
         "[]", json.dumps(prereq), "exam_normal", now_iso(), "", "[]", "[]"),
    )
conn.commit()
conn.close()

apply_resp = client.post(
    f"/api/projects/{pid}/framework/prereq/apply",
    json={
        "edges": [
            {"node_id": "C", "prerequisite_ids": ["B"]},
            {"node_id": "B", "prerequisite_ids": ["A"]},
            {"node_id": "ghost", "prerequisite_ids": ["A"]},
        ]
    },
)
check("apply 200", apply_resp.status_code == 200, apply_resp.text[:300])
body = apply_resp.json()
check("非法节点被跳过且记账", body["skipped"] == 1, str(body["skipped"]))

conn = sqlite3.connect(str(db_path))
prereq = {
    r[0]: json.loads(r[1])
    for r in conn.execute(
        "SELECT node_id, prerequisite_ids FROM framework_nodes WHERE project_id = ?", (pid,)
    )
}
conn.close()
check("C 的前置是并集：原有的 A 还在", prereq["C"] == ["A", "B"], str(prereq["C"]))
check("B 追加了 A", prereq["B"] == ["A"], str(prereq["B"]))
# A=[] B=["A"] C=["A","B"] ⇒ 2 个节点带前置、共 3 条边
check("stats 反映了真实变化（2 个节点带前置 / 3 条边）",
      body["stats"]["nodes_with_prereq"] == 2 and body["stats"]["edges"] == 3,
      str(body["stats"]))

print("[3] 幂等：同一批边连发两次不会重复")
client.post(
    f"/api/projects/{pid}/framework/prereq/apply",
    json={"edges": [{"node_id": "C", "prerequisite_ids": ["B"]}]},
)
conn = sqlite3.connect(str(db_path))
again = json.loads(
    conn.execute(
        "SELECT prerequisite_ids FROM framework_nodes WHERE project_id = ? AND node_id = 'C'",
        (pid,),
    ).fetchone()[0]
)
conn.close()
check("重复 apply 不产生重复边", again == ["A", "B"], str(again))

print("[4] 没配模型时给的是原因，不是 500")
sug = client.get  # 占位，实际用 POST
sug_resp = client.post(f"/api/projects/{pid}/framework/prereq/suggest")
check("suggest 200（不抛异常）", sug_resp.status_code == 200, sug_resp.text[:300])
sug_body = sug_resp.json()
check("返回了建议列表字段", "suggestions" in sug_body and "stats" in sug_body)
check("做不了时给了原因说明",
      "reason" not in sug_body or bool(sug_body["reason"]),
      str(sug_body.get("reason")))
print(f"      实际返回：{json.dumps(sug_body, ensure_ascii=False)[:200]}")

print("[5] 有模型时：端点真的把 payload 接到了过滤层（假模型，不烧额度）")


class _FakeLlm:
    """只返回一份固定响应，用来证明「端点 → validate_prereq_response」这条线是通的。"""

    def __init__(self, payload: dict) -> None:
        self.payload = payload
        self.seen_task = ""

    def complete_json(self, task: str, payload: dict):  # noqa: D102
        self.seen_task = task
        self.seen_payload = payload
        return self.payload


fake = _FakeLlm({"edges": [
    {"node_id": "D", "prerequisite_ids": ["ghost"]},   # 会被过滤掉
    {"node_id": "C", "prerequisite_ids": ["B", "B"]},  # 去重后留下 1 条
]})
# ⚠️ 必须复用同一个 app / client：换一个 app 再注册就是**另一个用户**，
# 而 proj_prereqbuild 归属于第一位用户，会直接 404「课程项目不存在」。
app.state.llm = fake
# 补两个节点，凑到 5 个（>4 才会真的去问模型）
conn = sqlite3.connect(str(db_path))
for nid in ("D", "E"):
    conn.execute(
        "INSERT INTO framework_nodes (node_id, project_id, parent_id, name,"
        " description, coverage_status, learning_status, mastery_score,"
        " source_ids, prerequisite_ids, exam_weight, updated_at, note_content,"
        " tags, wikilinks) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (nid, pid, "", f"知识点 {nid}", "自证", "covered", "unexplored", 0.0,
         "[]", "[]", "exam_normal", now_iso(), "", "[]", "[]"),
    )
conn.commit()
conn.close()

sug2 = client.post(f"/api/projects/{pid}/framework/prereq/suggest")
check("suggest 200", sug2.status_code == 200, sug2.text[:300])
b2 = sug2.json()
check("没有走「节点太少」的短路分支", "reason" not in b2, str(b2.get("reason")))
check("用的任务名是 build_prereq（与 prompt_catalog 一致）", fake.seen_task == "build_prereq",
      fake.seen_task)
check("编造的前置被过滤掉了", b2["invalid_count"] >= 1, str(b2))
check("真正能落的边只有 1 条（C→B）",
      b2["edge_count"] == 1 and b2["suggestions"][0]["node_id"] == "C", str(b2))
check("payload 里带着现有前置（模型不会重复建议已有的）",
      any(n["node_id"] == "C" and n["existing_prerequisite_ids"] == ["A", "B"]
          for n in fake.seen_payload["nodes"]),
      str([n for n in fake.seen_payload["nodes"] if n["node_id"] == "C"]))

print(f"\nPASS {PASS} / FAIL {FAIL}")
sys.exit(0 if FAIL == 0 else 1)
