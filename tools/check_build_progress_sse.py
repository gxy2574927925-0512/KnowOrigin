"""知识框架构建 SSE 真实进度自证。

背景：2026-09-30 把「每 650ms 假跳」的构建进度条改成后端真实事件驱动
（framework.build_framework 加 progress 回调，/framework/build 改 SSE 推送）。

断言重点：
  [1] 无来源时返回 SSE result 事件（含提示文案），不是旧 JSON
  [2] 有来源时事件序列 = parse → extract → link → render → done → result，
      percent 单调不减且只在真实阶段完成时前进
  [3] 模型等待期有 heartbeat 事件，elapsed 真实递增（假模型 sleep 3 秒）
  [4] result.data 里的 nodes 与旧 JSON 契约一致（nodes/fallback/message）

跑法：.venv311/Scripts/python.exe tools/check_build_progress_sse.py
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

TMP = Path(tempfile.mkdtemp(prefix="buildprogress_"))
os.environ["DATA_DIR"] = str(TMP)

from fastapi.testclient import TestClient  # noqa: E402

from api_server import create_app, load_settings  # noqa: E402
from core.llm import LlmClient  # noqa: E402
from dataclasses import replace  # noqa: E402

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


# 假模型：sleep 3 秒再吐合法 JSON，制造真实的「模型等待期」让心跳出现
def fake_responder(task: str, payload: dict) -> str:
    import time

    time.sleep(3)
    return json.dumps(
        {
            "nodes": [
                {"node_id": "root", "parent_id": None, "name": "测试课程",
                 "description": "根节点", "coverage_status": "covered",
                 "source_ids": [], "prerequisite_ids": [], "exam_weight": "exam_critical"},
                {"node_id": "ch1", "parent_id": "root", "name": "第一章 概念",
                 "description": "概念定义与机制说明，用于检验校验链路。", "coverage_status": "covered",
                 "source_ids": [], "prerequisite_ids": [], "exam_weight": "exam_normal"},
            ]
        },
        ensure_ascii=False,
    )


settings = replace(load_settings(), tju_api_key="test-key")
# 直接传自带 responder 的客户端：state.llm 外面套着记账/记忆两层代理，
# 事后给代理挂 responder 落不到内层真身上（实测踩过）。
app = create_app(settings=settings, llm_client=LlmClient(settings, responder=fake_responder))
client = TestClient(app)

reg = client.post(
    "/api/auth/register",
    json={"email": "buildsse@example.com", "name": "欣瑶", "password": "pw12345678"},
)
check("注册成功", reg.status_code in (200, 201), f"HTTP {reg.status_code}")
owner = reg.json()["user"]["user_id"]

# ── [1] 无来源项目 ──
db_path = next(p for p in TMP.rglob("*.sqlite3") if "knoworigin" in p.name)
conn = sqlite3.connect(str(db_path))
pid_empty = "proj_sse_empty"
pid_full = "proj_sse_full"
for pid, subject in ((pid_empty, "SSE自证-空"), (pid_full, "SSE自证-有料")):
    conn.execute(
        "INSERT INTO projects (project_id, owner_id, year, subject, created_at,"
        " project_type, tags, reading_status, last_position, last_opened_at,"
        " total_reading_seconds) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (pid, owner, "2026", subject, now_iso(), "course", "[]", "unread", 0.0, now_iso(), 0),
    )
conn.commit()
conn.close()

resp = client.post(f"/api/projects/{pid_empty}/framework/build")
check("无来源时仍是 200", resp.status_code == 200, f"HTTP {resp.status_code}")
check("无来源时 Content-Type 是 event-stream", "text/event-stream" in resp.headers.get("content-type", ""),
      resp.headers.get("content-type", ""))
empty_events = [json.loads(line[len("data: "):]) for line in resp.text.splitlines()
                if line.startswith("data: ")]
check("无来源时只有一个 result 事件", len(empty_events) == 1 and empty_events[0].get("type") == "result",
      str(empty_events)[:200])
check("result 带提示文案", "没有可用于构建框架的文本" in (empty_events[0].get("data", {}).get("message") or ""))

# ── [2][3][4] 有来源项目 ──
up = client.post(
    f"/api/projects/{pid_full}/sources",
    data={"pasted_text": "第一章 概念\n激光的基本原理是指受激辐射相干放大。其机制包括能级跃迁与粒子数反转条件。"},
)
check("来源上传成功", up.status_code == 200, f"HTTP {up.status_code} {up.text[:200]}")

resp = client.post(f"/api/projects/{pid_full}/framework/build")
check("构建返回 200", resp.status_code == 200, f"HTTP {resp.status_code}")
check("Content-Type 是 event-stream", "text/event-stream" in resp.headers.get("content-type", ""),
      resp.headers.get("content-type", ""))

events = [json.loads(line[len("data: "):]) for line in resp.text.splitlines()
          if line.startswith("data: ") and line[len("data: "):].strip()]
stages = [e.get("stage") for e in events if e.get("type") not in ("heartbeat", "result", "error")]
print(f"       事件序列: {[(e.get('type'), e.get('stage'), e.get('percent'), e.get('elapsed')) for e in events]}")
check("阶段序列 parse→extract→link→render→done",
      stages == ["parse", "parse", "extract", "extract", "link", "render", "done"], str(stages))
percents = [e["percent"] for e in events if isinstance(e.get("percent"), (int, float))]
check("percent 单调不减", percents == sorted(percents), str(percents))
check("percent 终点 100", percents and percents[-1] == 100, str(percents))

beats = [e for e in events if e.get("type") == "heartbeat"]
check("模型等待期有心跳（假模型 sleep 3s）", len(beats) >= 2, f"{len(beats)} 条")
if len(beats) >= 2:
    check("心跳 elapsed 真实递增", beats[-1]["elapsed"] > beats[0]["elapsed"],
          f"{beats[0]['elapsed']} → {beats[-1]['elapsed']}")
    check("心跳不带编造的 percent", all("percent" not in b for b in beats), str(beats[:1]))

results = [e for e in events if e.get("type") == "result"]
check("最后一个事件是 result", bool(results) and events[-1]["type"] == "result")
if results:
    data = results[0]["data"]
    check("result 契约：nodes/fallback/message 三键齐全",
          {"nodes", "fallback", "message"} <= set(data), str(set(data)))
    check("result 带回模型生成的节点", len(data["nodes"]) >= 2, str(len(data["nodes"])))
    check("节点名来自假模型", any(n.get("name") == "第一章 概念" for n in data["nodes"]))

print()
print(f"通过 {PASS} / 失败 {FAIL}")
sys.exit(1 if FAIL else 0)
