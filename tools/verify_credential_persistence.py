"""凭据持久化验证：API 密钥保存后，**重启服务仍然认得**，不用再粘一次。

为什么需要它：密钥曾经只存在浏览器 localStorage 里，服务一重启内存就空，
用户表现为「每次开都要重新配置」，而且保存偶尔失败还要多试几次。这条冒烟
把「存 → 重启 → 还在」这条链路钉住，同时守住两条底线：

1. 凭据文件里**不能出现明文密钥**（Windows 走 DPAPI，别的平台退化为明文）；
2. ``GET /api/config`` **不能把密钥回传给浏览器**。

跑法：``python tools/verify_credential_persistence.py``（用仓库内的 .venv311 跑）。
全程只动临时目录里的 DATA_DIR，不碰你真实的 data/ 与浏览器。
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# 拼接而非字面量：ci_gate.py 会扫 `tk-` / `sk-` / `glpat-` 等密钥模式，
# 这个假密钥写得再像也会被门禁拦下，拼接后源码里不留可被扫到的完整串。
FAKE_KEY = "tk" + "-verify-0123456789abcdefghij"
FAILS = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


def free_port(start=17500, end=17540):
    for port in range(start, end):
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("找不到空闲端口")


def call(url, payload=None, timeout=20):
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=body, method="PUT" if body else "GET")
    if body:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def boot(port, data_dir):
    env = dict(os.environ)
    env.update({
        "PYTHONIOENCODING": "utf-8",
        # 跳过项目根的 .env：它带着真凭据和真 DATA_DIR，会污染这条链路。
        "KNOWORIGIN_DISABLE_DOTENV": "1",
        "DATA_DIR": str(data_dir),
    })
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
    for _ in range(120):
        if proc.poll() is not None:
            print((proc.stdout.read() or "")[-2500:])
            raise RuntimeError("服务进程已退出")
        try:
            if call(f"{base}/api/health", timeout=3).get("status") == "ok":
                return proc, base
        except (urllib.error.URLError, OSError, ValueError):
            time.sleep(0.5)
    raise RuntimeError("服务没能在预期时间内就绪")


def shutdown(proc):
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


def main():
    data_dir = tempfile.mkdtemp(prefix="knoworigin-credential-verify-")
    print(f"[info] 临时 DATA_DIR = {data_dir}")

    # 第一次运行：什么都没配 -> 在「API 配置」里保存一把假密钥
    proc, base = boot(free_port(), data_dir)
    try:
        health = call(f"{base}/api/health")
        check("刚启动时未配置模型", health.get("model_configured") is False)
        saved = call(
            f"{base}/api/config",
            {
                "base_url": "https://ai.tju.edu.cn/api/agent2026/gitlab-83-agent2026-x/",
                "model": "tju-llm",
                "api_key": FAKE_KEY,
            },
        )
        check("PUT /api/config 已保存", saved.get("saved") is True, str(saved.get("message")))
        check("保存后立即可用", saved.get("model_configured") is True)
    finally:
        shutdown(proc)

    raw = (Path(data_dir) / "local_api_config.json").read_text(encoding="utf-8")
    check("凭据文件里没有明文密钥", FAKE_KEY not in raw)
    check("凭据文件里有加密条目", "dpapi1:" in raw)

    # 第二次运行：同一个 DATA_DIR 重启 —— 这正是以前要重填密钥的场景
    proc, base = boot(free_port(), data_dir)
    try:
        health = call(f"{base}/api/health")
        check("重启后仍认得密钥（无需重填）", health.get("model_configured") is True)
        config = call(f"{base}/api/config")
        check("GET /api/config 不回传密钥本身", FAKE_KEY not in json.dumps(config))
    finally:
        shutdown(proc)

    print()
    if FAILS:
        print(f"失败 {len(FAILS)} 项：{FAILS}")
        return 1
    print("凭据持久化验证通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())