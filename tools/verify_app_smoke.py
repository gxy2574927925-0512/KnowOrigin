"""应用级冒烟：确认两条线的端点都真的注册了，且 OpenAPI 能生成。"""
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from api_server import create_app  # noqa: E402

FAILS = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


app = create_app()
routes = {
    (method, path)
    for route in app.routes
    for method in getattr(route, "methods", []) or []
    for path in [getattr(route, "path", "")]
}
openapi = app.openapi()

print("== B 线：主界面会话 ==")
for method, path in [
    ("GET", "/api/projects/{project_id}/chat/sessions"),
    ("POST", "/api/projects/{project_id}/chat/sessions"),
    ("GET", "/api/projects/{project_id}/chat/sessions/{session_id}"),
    ("PATCH", "/api/projects/{project_id}/chat/sessions/{session_id}"),
    ("DELETE", "/api/projects/{project_id}/chat/sessions/{session_id}"),
]:
    check(f"{method} {path}", (method, path) in routes)

print()
print("== A 线：Agent ==")
for method, path in [
    ("POST", "/api/projects/{project_id}/chat/stream"),
    ("POST", "/api/projects/{project_id}/agent"),
    ("POST", "/api/projects/{project_id}/agent/actions/execute"),
]:
    check(f"{method} {path}", (method, path) in routes)

check(
    "整理助手的 /agent/sessions 未被动（仍存在）",
    ("GET", "/api/projects/{project_id}/agent/sessions") in routes,
)

print()
check("OpenAPI 可生成", bool(openapi.get("paths")), f"{len(openapi.get('paths', {}))} 条路径")

schema = openapi["components"]["schemas"]
check("ChatRequest 含 agent 字段", "agent" in schema.get("ChatRequest", {}).get("properties", {}))
check(
    "SolveRequest 含 conversation_id",
    "conversation_id" in schema.get("SolveRequest", {}).get("properties", {}),
)

print()
if FAILS:
    print(f"失败 {len(FAILS)} 项：{FAILS}")
    raise SystemExit(1)
print("应用级冒烟通过。")