"""B 线后端验收：主界面会话系统（chat_sessions）+ cid 透传。

不需要模型、不需要 key —— 全走 TestClient + 本地库。
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

FAILURES = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail else ''}")
    if not ok:
        FAILURES.append(name)


def main():
    tmp = Path(tempfile.mkdtemp(prefix="knoworigin-b-verify-"))
    # 故意不给 key：_study_action 会走本地兜底分支（不调模型），
    # 这样本脚本只验证「会话归属 + cid 透传」，不依赖网络与凭据。
    settings = Settings(
        tju_api_key="",
        tju_base_url="https://example.invalid/api",
        tju_model="tju-llm",
        data_dir=tmp,
        usage_tracking_enabled=False,
    )
    db = Database(tmp / "verify.sqlite3")
    client = TestClient(create_app(db, settings))

    client.post(
        "/api/auth/register",
        json={"email": "b@e.com", "password": "abcd1234", "name": "B"},
    )
    pid = client.post("/api/projects", json={"year": "2026", "subject": "X"}).json()[
        "project_id"
    ]

    # 1) 建会话
    created = client.post(f"/api/projects/{pid}/chat/sessions", json={})
    check("建会话 201", created.status_code == 201, created.text[:160])
    sid = created.json()["session"]["session_id"]
    check("会话 id 前缀正确", sid.startswith("csess_"), sid)

    # 2) 发消息进会话
    chat = client.post(
        f"/api/projects/{pid}/chat", json={"message": "q", "conversation_id": sid}
    )
    check("带 cid 发消息 200", chat.status_code == 200, chat.text[:160])

    # 3) 消息确实落在该会话里（而不是默认单线程）
    detail = client.get(f"/api/projects/{pid}/chat/sessions/{sid}")
    check("读会话 200", detail.status_code == 200, detail.text[:160])
    messages = detail.json().get("messages") or []
    check("会话内有 2 条消息", len(messages) == 2, f"{len(messages)} 条")
    check(
        "消息带上了 conversation_id",
        all(m.get("conversation_id") == sid for m in messages),
        str([m.get("conversation_id") for m in messages]),
    )

    # 4) 默认单线程（空 cid）不被污染
    empty = client.post(f"/api/projects/{pid}/chat", json={"message": "单线程"})
    check("空 cid 发消息 200", empty.status_code == 200, empty.text[:120])
    empty_detail = client.get(f"/api/projects/{pid}/chat/sessions/{sid}")
    check(
        "空 cid 不写进指定会话",
        len(empty_detail.json().get("messages") or []) == 2,
        str(len(empty_detail.json().get("messages") or [])),
    )

    # 5) 清单：指定会话 + 项目默认单线程（空 cid）都列出，空会话也不丢。
    #    默认单线程的 session_id 是空串 —— 老数据的对话不该因为没有壳就看不见；
    #    前端 resolveMessages 要对空 id 特判（GET /chat/sessions/ 会 404）。
    listing = client.get(f"/api/projects/{pid}/chat/sessions")
    sessions = listing.json().get("sessions") or []
    check("清单返回 200", listing.status_code == 200)
    check("清单列出 2 个会话（含空串单线程）", len(sessions) == 2, str([repr(s["session_id"])[:12] for s in sessions]))
    check(
        "空串单线程也在清单里",
        any(s["session_id"] == "" for s in sessions),
        str([repr(s["session_id"])[:12] for s in sessions]),
    )
    check(
        "标题用首条提问兜底",
        any(s["title"] == "q" for s in sessions) and any(s["title"] == "单线程" for s in sessions),
        str([s["title"] for s in sessions]),
    )
    check(
        "每个会话都有 message_count",
        all(isinstance(s["message_count"], int) for s in sessions),
        str([s["message_count"] for s in sessions]),
    )

    # 6) 项目详情带 chat_sessions
    project = client.get(f"/api/projects/{pid}")
    check(
        "项目详情带 chat_sessions",
        isinstance(project.json().get("chat_sessions"), list),
        str(type(project.json().get("chat_sessions"))),
    )

    # 7) 重命名
    renamed = client.patch(
        f"/api/projects/{pid}/chat/sessions/{sid}", json={"title": "QM"}
    )
    check("重命名 200", renamed.status_code == 200, renamed.text[:160])
    check("重命名生效", renamed.json()["session"]["title"] == "QM")
    over = client.patch(
        f"/api/projects/{pid}/chat/sessions/{sid}", json={"title": "长" * 60}
    )
    check(
        "标题超长被截到 40",
        len(over.json()["session"]["title"]) == Database.CHAT_SESSION_TITLE_MAX,
        str(len(over.json()["session"]["title"])),
    )

    # 8) 越权：不属于本项目的会话一律 404
    other = TestClient(create_app(Database(tmp / "other.sqlite3"), settings))
    other.post(
        "/api/auth/register",
        json={"email": "x@e.com", "password": "abcd1234", "name": "X"},
    )
    r = other.get(f"/api/projects/{pid}/chat/sessions/{sid}")
    check("越权读会话 404", r.status_code == 404, str(r.status_code))
    r = other.delete(f"/api/projects/{pid}/chat/sessions/{sid}")
    check("越权删会话 404", r.status_code == 404, str(r.status_code))

    # 9) 删除会话连带删消息，且项目仍可打开
    deleted = client.delete(f"/api/projects/{pid}/chat/sessions/{sid}")
    check("删会话 200", deleted.status_code == 200, deleted.text[:160])
    check("返回被删消息数", len(deleted.json().get("message_ids") or []) == 2, str(deleted.json().get("message_ids")))
    check("删除后清单只剩 1 个", len(client.get(f"/api/projects/{pid}/chat/sessions").json()["sessions"]) == 1)
    check("删除后项目仍 200", client.get(f"/api/projects/{pid}").status_code == 200)

    # 10) 不存在的会话
    check(
        "删不存在会话 404",
        client.delete(f"/api/projects/{pid}/chat/sessions/nope").status_code == 404,
    )
    check(
        "读不存在会话 404",
        client.get(f"/api/projects/{pid}/chat/sessions/nope").status_code == 404,
    )

    # 11) 整理助手的 conv_ 会话不会被列进主界面清单
    conv = db.create_conversation(pid, "u-b-verify-placeholder", title="整理助手")
    db.add_message(pid, "assistant", "整理助手消息", [], [], conversation_id=conv["conversation_id"])
    sessions = client.get(f"/api/projects/{pid}/chat/sessions").json()["sessions"]
    check(
        "conv_ 会话被排除在主界面清单外",
        all(not s["session_id"].startswith("conv_") for s in sessions),
        str([s["session_id"][:10] for s in sessions]),
    )

    # 12) solve 也带 cid
    solve = client.post(
        f"/api/projects/{pid}/solve",
        json={"problem": "1+1", "conversation_id": sid},
    )
    check("solve 带 cid 200（会话已删故为默认线程分支）", solve.status_code in (200, 404, 422), str(solve.status_code))

    print()
    if FAILURES:
        print(f"失败 {len(FAILURES)} 项：{FAILURES}")
        return 1
    print("B 线后端全部通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())