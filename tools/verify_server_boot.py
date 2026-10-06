"""启动级冒烟：真起 uvicorn，验证页面与新增静态资源真的能拉到。"""
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(r"E:\agent2026-Knoworigin-main\agent2026-Knoworigin-main")
FAILS = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


def free_port(start=17400, end=17440):
    for port in range(start, end):
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("找不到空闲端口")


def get(url, timeout=15):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return resp.status, resp.read().decode("utf-8", "replace")


def main():
    port = free_port()
    env = {
        "PYTHONIOENCODING": "utf-8",
        "KNOWORIGIN_DISABLE_DOTENV": "1",
        "PATH": r"F:\pppython;F:\pppython\Scripts;C:\Windows\System32",
        "SystemRoot": r"C:\Windows",
    }
    proc = subprocess.Popen(
        [
            sys.executable, "-m", "uvicorn", "api_server:app",
            "--app-dir", str(ROOT / "src"), "--host", "127.0.0.1", "--port", str(port),
        ],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    base = f"http://127.0.0.1:{port}"
    try:
        # 等服务起来
        ready = False
        for _ in range(80):
            if proc.poll() is not None:
                print("服务进程已退出：")
                print((proc.stdout.read() or "")[-3000:])
                break
            try:
                if get(f"{base}/api/health", timeout=3)[0] == 200:
                    ready = True
                    break
            except (urllib.error.URLError, OSError):
                time.sleep(0.5)
        check("服务启动并响应 /api/health", ready)

        if ready:
            status, body = get(base + "/")
            check("首页 200", status == 200, str(status))
            check("首页含 Agent 图标栏", 'id="agent-rail"' in body)
            check("首页含 Agent 开关按钮", 'id="chat-agent-toggle"' in body)
            check("首页引用 agent-layout.css", "agent-layout.css" in body)
            check("首页引用 agent-shell.js", "agent-shell.js" in body)

            for path, needle in [
                ("/static/agent-layout.css", 'html[data-ui="agent"]'),
                ("/static/agent-shell.js", "KnowOriginAgentShell"),
                ("/static/app.js", "chatSessionId"),
                ("/static/styles.css", ".agent-action-card"),
                ("/static/english-vocab-ui.js", "enVocabOpenView"),
            ]:
                try:
                    status, body = get(base + path)
                except Exception as exc:  # noqa: BLE001
                    check(f"{path} 可访问", False, f"{type(exc).__name__}")
                    continue
                check(f"{path} 200", status == 200, str(status))
                check(f"{path} 内容正确（含 {needle}）", needle in body)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()

    print()
    if FAILS:
        print(f"失败 {len(FAILS)} 项：{FAILS}")
        return 1
    print("启动级冒烟通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())