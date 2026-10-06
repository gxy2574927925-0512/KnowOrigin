#!/usr/bin/env python3
"""
KnowOrigin Launcher - Start the AI Learning Agent with one command.

Usage:
    python start.py        Start server and open browser
    Double-click start.py  Same (if .py is associated with Python)

No .cmd / .bat / .ps1 needed. Pure Python, cross-platform.
"""

import os
import sys
import json
import shutil
import socket
import subprocess
import time
import urllib.request
import webbrowser
from pathlib import Path

# ============================================================================
# Config
# ============================================================================

BIND_HOST = "0.0.0.0"
LOCAL_HOST = "127.0.0.1"
# 自定义端口段 17321-17341：避开 8000 / 8080 / 3000 / 5000 等常用端口，
# 减少与其他本地服务（另一份知源、其他项目 dev server）抢端口导致的"打开却是别的界面"。
PORT_RANGE = range(17321, 17342)
MIN_PY = (3, 11)

# 密钥一律由使用者自备：仓库与启动脚本都不内置、也不再从远端拉取任何密钥。

# ============================================================================
# Path detection
# ============================================================================


def find_project_root():
    """Find project root (the directory containing src/, data/, requirements.txt).

    Layout after src/ migration:
        <project>/start.py            (legacy, script sits next to api_server.py)
        <project>/src/start.py        (current, script lives under src/)
    """
    p = Path(__file__).resolve().parent
    if (p / "api_server.py").exists():
        # 脚本与 api_server.py 同级：若上一级含 requirements.txt/data 则为 src/ 新布局
        if (p.parent / "requirements.txt").exists():
            return p.parent
        return p
    for parent in p.parents:
        if (parent / "api_server.py").exists():
            # 向上找到 src/api_server.py 时，返回 src 的上一级（项目根）
            if (parent.parent / "requirements.txt").exists():
                return parent.parent
            return parent
    print("[Error] api_server.py not found under src/. Keep this script next to src/.")
    input("Press Enter to close...")
    sys.exit(1)


PROJECT_ROOT = find_project_root()
os.chdir(PROJECT_ROOT)

VENV_DIR = PROJECT_ROOT / ".venv311"
REQUIREMENTS = PROJECT_ROOT / "requirements.txt"
LOG_DIR = PROJECT_ROOT / "logs"
STDOUT_LOG = LOG_DIR / "knoworigin-server.out.log"
STDERR_LOG = LOG_DIR / "knoworigin-server.err.log"
MOBILE_URL_LOG = LOG_DIR / "knoworigin-mobile-url.txt"

LOG_DIR.mkdir(exist_ok=True)


# ============================================================================
# Python 3.11+ detection
# ============================================================================


def _check_py(exe):
    """Return exe if it's Python 3.11+, else None."""
    try:
        r = subprocess.run(
            [exe, "-c", "import sys; exit(0 if sys.version_info >= (3,11) else 1)"],
            capture_output=True,
            timeout=5,
        )
        return exe if r.returncode == 0 else None
    except Exception:
        return None


def find_python():
    """Find a Python 3.11+ interpreter. Returns path string or None."""
    # 1. Existing venv
    for candidate in [VENV_DIR / "Scripts" / "python.exe", VENV_DIR / "bin" / "python"]:
        if candidate.exists():
            found = _check_py(str(candidate))
            if found:
                return found

    # 2. Current interpreter
    if sys.version_info >= MIN_PY:
        return sys.executable

    # 3. Windows: py launcher
    if sys.platform == "win32":
        for ver in ["-3.13", "-3.12", "-3.11"]:
            try:
                r = subprocess.run(
                    ["py", ver, "-c", "import sys; print(sys.executable)"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                if r.returncode == 0 and r.stdout.strip():
                    found = _check_py(r.stdout.strip())
                    if found:
                        return found
            except Exception:
                pass

    # 4. PATH lookup
    for cmd in ["python3.13", "python3.12", "python3.11", "python3", "python"]:
        found_exe = shutil.which(cmd)
        if found_exe:
            found = _check_py(found_exe)
            if found:
                return found

    # 5. Windows standard install locations
    if sys.platform == "win32":
        local_app = os.environ.get("LocalAppData", "")
        prog_files = os.environ.get("ProgramFiles", "")
        for pattern in [
            f"{local_app}\\Programs\\Python\\Python313\\python.exe",
            f"{local_app}\\Programs\\Python\\Python312\\python.exe",
            f"{local_app}\\Programs\\Python\\Python311\\python.exe",
            f"{prog_files}\\Python313\\python.exe",
            f"{prog_files}\\Python312\\python.exe",
            f"{prog_files}\\Python311\\python.exe",
        ]:
            if os.path.exists(pattern):
                found = _check_py(pattern)
                if found:
                    return found

    return None


# ============================================================================
# Venv + Dependencies
# ============================================================================


def ensure_venv(bootstrap_py):
    """Create venv if needed. Return venv python path."""
    for candidate in [VENV_DIR / "Scripts" / "python.exe", VENV_DIR / "bin" / "python"]:
        if candidate.exists():
            return str(candidate)

    print(f"[Venv] Creating .venv311 with {bootstrap_py} ...")
    r = subprocess.run(
        [bootstrap_py, "-m", "venv", str(VENV_DIR)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if r.returncode != 0:
        print(f"[Error] venv creation failed:\n{r.stderr}")
        input("Press Enter to close...")
        sys.exit(1)

    for candidate in [VENV_DIR / "Scripts" / "python.exe", VENV_DIR / "bin" / "python"]:
        if candidate.exists():
            return str(candidate)

    print("[Error] venv created but python not found inside.")
    input("Press Enter to close...")
    sys.exit(1)


# 运行必需模块（这里是 import 名，不是 pip 包名）——与 requirements.txt 对齐。
# 只检查 fastapi/uvicorn 是不够的：老用户 venv 里 fastapi 在、后来新增的依赖不在，
# 于是校园抓取等新功能会“静默失效”（异常被吞掉，看起来像查不到资料）。
# 所以这里逐个 importlib.find_spec 校验，缺谁装谁。
REQUIRED_MODULES = [
    "fastapi",
    "uvicorn",
    "pydantic",
    "dotenv",
    "multipart",
    "httpx",
    "fitz",
    "pdfplumber",
    "docx",
    "pptx",
    "PIL",
    "numpy",
    "onnxruntime",
    "bs4",
    "trafilatura",
    "lxml",
]
# 「任选其一」的模块：任一个存在即视为满足（OCR 引擎有多个可选实现）
REQUIRED_MODULES_ANY = [("rapidocr", "rapidocr_onnxruntime")]

PIP_MIRROR = ["-i", "https://pypi.tuna.tsinghua.edu.cn/simple"]


def _missing_modules(python_exe):
    """返回 venv 中缺失的必需模块名；空列表表示依赖齐全。"""
    check = (
        "import importlib.util as u; "
        f"mods={REQUIRED_MODULES!r}; "
        f"any_mods={REQUIRED_MODULES_ANY!r}; "
        "missing=[m for m in mods if not u.find_spec(m)]; "
        "missing+=[a[0] for a in any_mods if not any(u.find_spec(x) for x in a)]; "
        "print(' '.join(missing))"
    )
    try:
        r = subprocess.run(
            [python_exe, "-c", check],
            capture_output=True,
            text=True,
            timeout=60,
        )
    except Exception as exc:  # noqa: BLE001 - 自检本身失败按“未知”处理，仍走安装以自愈
        print(f"[Deps] 依赖自检异常：{exc}")
        return ["<check-failed>"]
    if r.returncode != 0:
        return ["<check-failed>"]
    return [m for m in (r.stdout or "").split() if m]


def ensure_deps(python_exe):
    """依赖缺失时安装 requirements.txt；失败则自动换国内镜像重试一次。"""
    missing = _missing_modules(python_exe)
    if not missing:
        return

    print(f"[Deps] 缺少依赖：{', '.join(missing)}，开始安装 requirements.txt ...")
    print("[Deps] 首次安装可能需要 3-5 分钟，请耐心等待 ...")
    for extra in ([], PIP_MIRROR):
        r = subprocess.run(
            [python_exe, "-m", "pip", "install", "-r", str(REQUIREMENTS), *extra],
            timeout=900,
        )
        if r.returncode == 0 and not _missing_modules(python_exe):
            print("[Deps] 依赖安装完成。")
            return
    print("[Error] 依赖安装失败，请手动执行：")
    print(
        f"        {python_exe} -m pip install -r requirements.txt -i "
        "https://pypi.tuna.tsinghua.edu.cn/simple"
    )
    input("Press Enter to close...")
    sys.exit(1)


# ============================================================================
# Local .env bootstrap
# ============================================================================


def ensure_env_file():
    """No .env yet? Create it from .env.example (keys are placeholders on purpose)."""
    env_path = PROJECT_ROOT / ".env"
    example = PROJECT_ROOT / ".env.example"
    if env_path.exists() or not example.exists():
        return
    shutil.copyfile(example, env_path)
    print("[Env] Created .env from .env.example (no key bundled - fill in your own).")


# ============================================================================
# Port scanning
# ============================================================================


def is_server_running(port):
    """Check if a KnowOrigin server is already running on this port."""
    try:
        data = json.loads(
            urllib.request.urlopen(
                f"http://127.0.0.1:{port}/api/health", timeout=2
            ).read()
        )
        return data.get("status") == "ok"
    except Exception:
        return False


def is_port_free(port):
    """Check if a TCP port is available on all interfaces.

    先连接探测（能连上说明已有服务在应答），再补一次 bind 校验 ——
    只 connect 探不到"绑在别的网卡 / 只 bind 没 listen"的占用，
    分发到别人的电脑上时这类误判会让 uvicorn 启动直接失败。
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(0.3)
    result = sock.connect_ex(("127.0.0.1", port))
    sock.close()
    if result == 0:
        return False
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind((BIND_HOST, port))
    except OSError:
        return False
    finally:
        probe.close()
    return True


def find_port():
    """Return (port, already_running) - reuse existing or find free port."""
    for port in PORT_RANGE:
        if is_server_running(port):
            print(f"[Port] Found existing server on port {port}.")
            return port, True
        if is_port_free(port):
            print(f"[Port] Using port {port}.")
            return port, False
    # 兜底：首选窗口被别的软件整段占满时，交给系统分配一个空闲端口。
    # 别人电脑上装了什么软件无法预测，宁可换号也不能让启动直接失败。
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind((BIND_HOST, 0))
        port = probe.getsockname()[1]
    except OSError:
        port = 0
    finally:
        probe.close()
    if port:
        print(
            f"[Port] {PORT_RANGE.start}-{PORT_RANGE.stop - 1} all busy; "
            f"using OS-assigned port {port}."
        )
        return port, False

    print(f"[Error] Ports {PORT_RANGE.start}-{PORT_RANGE.stop - 1} are all busy.")
    input("Press Enter to close...")
    sys.exit(1)


# ============================================================================
# Server start
# ============================================================================


def _open_logs(port):
    """打开日志文件；若被残留进程占着句柄，退回带端口号的日志名，避免启动直接崩。"""
    try:
        return (
            open(STDOUT_LOG, "w", encoding="utf-8"),
            open(STDERR_LOG, "w", encoding="utf-8"),
            STDERR_LOG,
        )
    except PermissionError:
        pass

    alt_out = LOG_DIR / f"knoworigin-server-{port}.out.log"
    alt_err = LOG_DIR / f"knoworigin-server-{port}.err.log"
    print(f"[Log] 原日志被其他程序占用，本次写入 {alt_err.name}")
    return (
        open(alt_out, "w", encoding="utf-8"),
        open(alt_err, "w", encoding="utf-8"),
        alt_err,
    )


def start_server(python_exe, port):
    """Start uvicorn in a new process group, wait for health check."""
    stdout_f, stderr_f, stderr_path = _open_logs(port)

    kwargs = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP

    proc = subprocess.Popen(
        [
            python_exe,
            "-m",
            "uvicorn",
            "api_server:app",
            "--app-dir",
            str(PROJECT_ROOT / "src"),
            "--host",
            BIND_HOST,
            "--port",
            str(port),
            # 开发期热重载：改 api_server.py / core/*.py 后自动重启子进程，
            # 不必手动停服务再启动，也不用靠刷新浏览器（刷新拿不到后端新代码）。
            "--reload",
        ],
        stdout=stdout_f,
        stderr=stderr_f,
        cwd=str(PROJECT_ROOT),
        **kwargs,
    )

    for _ in range(60):
        if is_server_running(port):
            print(f"[Server] Ready on port {port}.")
            return proc, stderr_path
        time.sleep(1)

    print(f"[Error] Server did not become ready in 60 seconds.")
    print(f"        Check {stderr_path} for details.")
    proc.terminate()
    input("Press Enter to close...")
    sys.exit(1)


# ============================================================================
# Mobile URL log
# ============================================================================


def write_mobile_urls(port):
    """Write desktop + LAN URLs to a log file for mobile access."""
    lines = [
        "KnowOrigin desktop URL:",
        f"http://{LOCAL_HOST}:{port}/",
        "",
        "Mobile URLs for devices on the same Wi-Fi:",
    ]
    found_lan = False

    if sys.platform == "win32":
        try:
            r = subprocess.run(
                [
                    "powershell",
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    "Get-NetIPAddress -AddressFamily IPv4 | "
                    "Where-Object { $_.IPAddress -notlike '127.*' -and "
                    "$_.IPAddress -notlike '169.254.*' } | "
                    "Sort-Object InterfaceMetric | "
                    "ForEach-Object { $_.IPAddress }",
                ],
                capture_output=True,
                text=True,
                timeout=5,
            )
            for line in r.stdout.strip().split("\n"):
                line = line.strip()
                if line:
                    found_lan = True
                    lines.append(f"http://{line}:{port}/")
        except Exception:
            pass
    else:
        try:
            r = subprocess.run(
                ["ip", "addr"], capture_output=True, text=True, timeout=5
            )
            for line in r.stdout.split("\n"):
                if "inet " in line and "127.0.0.1" not in line:
                    for part in line.strip().split():
                        if part.startswith(("192.168.", "10.", "172.")):
                            ip = part.split("/")[0]
                            found_lan = True
                            lines.append(f"http://{ip}:{port}/")
        except Exception:
            pass

    if not found_lan:
        lines.append("No LAN IPv4 address was found.")

    lines.append("")
    lines.append(
        "If the phone cannot open the URL, "
        "keep the phone and computer on the same Wi-Fi."
    )

    MOBILE_URL_LOG.write_text("\n".join(lines), encoding="utf-8")


# ============================================================================
# Main
# ============================================================================


def main():
    print("=" * 56)
    print("  KnowOrigin - AI Learning Agent")
    print("=" * 56)

    # 1. Find Python 3.11+
    py = find_python()
    if not py:
        print()
        print("[Error] Python 3.11+ not found.")
        print("        Install from https://python.org then re-run.")
        input("Press Enter to close...")
        sys.exit(1)
    print(f"[Python] {py}")

    # 2. Create venv if needed
    python_exe = ensure_venv(py)
    print(f"[Venv]   {python_exe}")

    # 3. Install dependencies
    ensure_deps(python_exe)

    # 4. Ensure a local .env exists (no bundled key - the user fills in their own)
    ensure_env_file()

    # 5. Find available port (or reuse existing server)
    port, already_running = find_port()

    # 6. Start server (or reuse existing)
    proc = None
    stderr_log = STDERR_LOG
    if not already_running:
        proc, stderr_log = start_server(python_exe, port)

    # 7. Write mobile URLs
    write_mobile_urls(port)

    # 8. Open browser
    url = f"http://{LOCAL_HOST}:{port}/"
    print(f"[Browser] Opening {url}")
    webbrowser.open(url)

    print()
    print("=" * 56)
    print(f"  KnowOrigin is running at {url}")
    print(f"  Server log:  {stderr_log}")
    print(f"  Mobile URL:  {MOBILE_URL_LOG}")
    print("=" * 56)

    if proc:
        print("\nPress Ctrl+C to stop the server.\n")
        try:
            proc.wait()
        except KeyboardInterrupt:
            proc.terminate()
            print("\n[Server] Stopped.")
    else:
        input("\nPress Enter to close this window.\n")


if __name__ == "__main__":
    main()
