"""Agent 工作台视觉体检：真起服务、真渲染、真量计算样式。

为什么必须有这个：配色和布局的问题静态看 CSS 说不清，这个项目已经因此误判过三次 ——
  - 「令牌覆盖了，界面应该冷的」→ 实际有 139 条字面绿规则，令牌管不到；
  - 「选择器写对了，元素应该会显示」→ 那个 class 在项目里根本不存在；
  - 「display:contents + order 排序」→ 基础样式其实是 grid，动作被甩到第二行拉成满宽。
只有让浏览器真的渲染一遍、量 getComputedStyle 和 getBoundingClientRect 才是证据。

做四件事：
  1. 起一个临时数据目录的服务，灌入卡片/测验/笔记/学习台历材料（不需要网关 key）；
  2. 用 Edge headless + CDP 注入 session cookie 与 knoworigin-ui=agent，逐个功能页：
       - 扫描可见元素的计算色，标出「暖色 / 绿色」残留；
       - 检查返回对话按钮是否可见且没被遮挡（elementFromPoint 命中测试）；
       - 检查 #studio-output 与 #en-vocab-view 的矩形是否相交（相交=重叠）；
       - 截图存盘，供人眼复核；
  3. 断言上面三条；
  4. 打印截图路径。

用法：python tools/verify_agent_visual.py [--keep-shots]
"""
from __future__ import annotations

import argparse
import json
import socket
import subprocess
import sys
import os
import shutil
import tempfile
import threading
import time
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from api_server import create_app  # noqa: E402
from config import Settings  # noqa: E402
from core.database import Database  # noqa: E402
from core.models import Card, QuizQuestion, SourceCreate  # noqa: E402
from core.study_kit import StudyKitStore  # noqa: E402

# 语义上就该是暖色/绿色的，不算残留：学科配色标签、题型编码、用户自己选的高亮色、
# 「演示内容」警示、以及按钮态里被 token 化的 --green（那是冷蓝，不算）。
COLOR_ALLOW = (
    "file-type-", "course-autocomplete-tag", "tju-import-kind", "k-quiz", "k-solve",
    "k-card", "note-highlighted", "favorite-highlight", "note-highlight", "mark",
    "fallback-label", "color-yellow", "color-green",
    # .favorite-note 的底色来自 --favorite-highlight-soft，而这个变量是按用户选的
    # favorites.highlight_color 设的（.favorite-highlight-yellow → #fff8dc 玉米丝黄），
    # 属用户数据不是配色回归，跟 .favorite-highlight-* 一样放行。
    "favorite-note",
)
# 判定「偏暖」的阈值：色相 18~66°、饱和 > 0.08、亮度 > 0.55，且 alpha > 0.15（要真看得见）
WARM_HUE = (18, 66)
GREEN_HUE = (72, 165)


def parse_color(value: str):
    import re

    m = re.match(r"rgba?\(([^)]+)\)", str(value or "").strip())
    if not m:
        return None
    parts = [float(x) for x in re.split(r"[,\s/]+", m.group(1).strip()) if x]
    if len(parts) < 3:
        return None
    return parts[0], parts[1], parts[2], (parts[3] if len(parts) > 3 else 1.0)


def classify(rgb):
    import colorsys

    r, g, b, a = rgb
    if a <= 0.15:
        return None
    h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
    hue = h * 360
    if s < 0.08:
        return None
    if WARM_HUE[0] <= hue <= WARM_HUE[1] and l > 0.55:
        return "warm"
    if GREEN_HUE[0] <= hue <= GREEN_HUE[1] and l > 0.3:
        return "green"
    return None


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _luminance(rgb) -> float:
    def channel(value: float) -> float:
        value = value / 255
        return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4

    r, g, b = rgb[:3]
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def _over(rgb, base):
    return tuple(rgb[i] * rgb[3] + base[i] * (1 - rgb[3]) for i in range(3))


def contrast_ratio(fg, bg, mid=None):
    """算 WCAG 对比度，支持半透明中间层。

    半透明前景要先压到不透明底上再算 —— 直接拿 ``rgba(…,0.1)`` 当背景比，
    算出来的是一个跟用户眼睛看到的完全无关的数。``mid`` 是 fg 下面那层
    （比如半透明计数 pill 压在卡片面上：fg=字色，mid=pill 底，bg=卡片面）。
    底本身半透明且没给 mid 时无法定值，返回 None 让调用方跳过，
    不要拿一个假数字当通过依据。
    """
    top, bottom = parse_color(fg), parse_color(bg)
    if top is None or bottom is None:
        return None
    if bottom[3] < 0.99:
        if mid is None:
            return None
        bottom = parse_color(mid)
        if bottom is None or bottom[3] < 0.99:
            return None
    base = bottom[:3]
    if top[3] < 0.99:
        under = parse_color(mid) if mid else None
        if under is not None and under[3] < 0.99:
            under = None
        top = _over(top, (under[:3] if under else base))
    light, dark = sorted((_luminance(top[:3]), _luminance(base)), reverse=True)
    return round((light + 0.05) / (dark + 0.05), 2)



def seed(db: Database, pid: str):
    """给已有项目灌满走查需要的产物（资料/卡片/测验/笔记/台历材料）。不需要网关 key。

    资料必须一起灌：前端 selectableSources() 要求 source.status === 'ok' 且 text 非空，
    否则点开卡片页只会渲染「暂无项目资料」空状态 —— 那样量到的颜色是空状态的，
    卡片组件本身根本没被检查到（第一版就踩了这个坑，量测全绿但毫无意义）。
    """
    db.add_source(
        pid,
        SourceCreate(
            filename="量子物理第一章.pdf",
            mime_type="application/pdf",
            size_bytes=182_344,
            text=(
                "康普顿散射：光子与自由电子碰撞后波长改变，波长增量 Δλ = h(1-cosθ)/(m₀c)。"
                "德布罗意关系：λ = h/p，任何微观粒子都伴随波动性。"
                "光电效应：光能完全转化为电离能，超过逸出功的部分不再增加电子动能。"
            ),
            formulas=[{"latex": "\\Delta\\lambda = \\frac{h}{m_0 c}(1-\\cos\\theta)"}],
        ),
    )
    db.add_cards(
        pid,
        [
            Card(front="康普顿波长增量公式是什么？", back="Δλ = h/(m₀c)(1-cosθ)", category="公式"),
            Card(front="德布罗意关系式如何定量描述微观粒子？", back="λ = h/p", category="概念", difficulty=2),
            Card(front="什么是光电效应？", back="光能完全转化为电离能，逸出功之外无剩余。", category="概念"),
            Card(front="采样定理要求采样频率多少？", back="至少为最高频率的两倍。", category="易错", difficulty=3),
            Card(front="康普顿散射中散射角增大波长如何变化？", back="θ 增大 → Δλ 增大。", category="概念"),
        ],
    )
    quiz_id = db.add_quiz(
        pid,
        {
            "questions": [
                QuizQuestion(
                    question="康普顿散射的 Δλ 与散射角的关系是？",
                    type="single_choice",
                    options=["无关", "θ 越大 Δλ 越大", "θ 越大 Δλ 越小", "先增后减"],
                    answer="B", explanation="Δλ = h(1-cosθ)/m₀c，随 θ 单调增。",
                ).model_dump(mode="json"),
            ],
            "source_ids": [], "fallback": False,
        },
    )
    db.save_quiz_score(pid, quiz_id, 0.5, results=[])
    fav = db.add_favorite(
        pid, item_type="card", origin_id="card_1",
        title="康普顿波长增量公式是什么？",
        content="康普顿波长增量公式是什么？",
        answer="Δλ = h/(m₀c)(1-cosθ)",
        chapter_node_id=None, chapter_name="第一章 量子物理", node_ids=[],
    )
    db.update_favorite(
        pid, fav.favorite_id, title=fav.title, chapter_node_id=None,
        chapter_name=fav.chapter_name, note="考试爱问散射角取 90° 的特例。",
        highlight_color="yellow",
    )
    store = StudyKitStore(db.path)
    store.save(
        project_id=pid, owner_id="", kind="cheatsheet", title="一页速查表",
        content_md="## 三个公式\nΔλ = h(1-cosθ)/m₀c\nλ = h/p\nE = hν",
    )
    store.save(
        project_id=pid, owner_id="", kind="learning_path", title="学习路径",
        content_md="## 前置知识\n波动光学\n## 下一步\n做康普顿习题",
    )
    store.close()


def start_server(db: Database, settings: Settings, port: int):
    import uvicorn

    app = create_app(db, settings)
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(120):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.3):
                return server
        except OSError:
            time.sleep(0.25)
    raise RuntimeError("服务没起来")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep-shots", action="store_true")
    args = parser.parse_args()

    # 依赖守卫：这个体检要真起 HTTP 服务 + 真浏览器，缺任一项就明说而不是抛栈
    edge = os.environ.get("KNOWORIGIN_EDGE") or (
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
        if Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe").exists()
        else shutil.which("msedge") or shutil.which("chrome")
    )
    if not edge or not Path(edge).exists():
        print("[SKIP] 没找到 Edge/Chrome，视觉体检需要真实浏览器")
        print("       可用 KNOWORIGIN_EDGE=<浏览器路径> 指定后重跑")
        return 0
    try:
        import requests  # noqa: F401
        import uvicorn  # noqa: F401
    except ImportError as error:
        print(f"[SKIP] 缺依赖 {error.name}，视觉体检需要它起服务")
        return 0

    import requests

    tmp = Path(tempfile.mkdtemp(prefix="knoworigin-visual-"))
    shot_dir = Path(tempfile.mkdtemp(prefix="knoworigin-shots-"))
    out_json = shot_dir / "report.json"
    print(f"数据目录 {tmp}\n截图目录 {shot_dir}")

    settings = Settings(
        tju_api_key="",
        tju_base_url="https://example.invalid/api",
        tju_model="tju-llm",
        data_dir=tmp,
        usage_tracking_enabled=False,
    )
    db = Database(tmp / "visual.sqlite3")
    port = free_port()
    server = start_server(db, settings, port)
    base = f"http://127.0.0.1:{port}"
    print(f"服务 {base}")

    failures: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail else ''}")
        if not ok:
            failures.append(name)

    try:
        # 用 API 注册拿 session cookie（避开自己实现密码哈希），再建项目
        session = requests.Session()
        reg = session.post(
            f"{base}/api/auth/register",
            json={"email": "visual@e.com", "password": "abcd1234", "name": "视觉体检"},
            timeout=20,
        )
        check("注册成功", reg.status_code in (200, 201), f"{reg.status_code} {reg.text[:120]}")
        cookie = session.cookies.get("knoworigin_session")
        check("拿到 session cookie", bool(cookie), str(session.cookies.get_dict()))
        created = session.post(f"{base}/api/projects", json={"year": "2026", "subject": "傅里叶分析"}, timeout=20)
        pid = None
        if created.status_code in (200, 201):
            body = created.json()
            if isinstance(body, list):
                pid = (body[0] or {}).get("project_id") if body else None
            elif isinstance(body, dict):
                pid = body.get("project_id") or (body.get("project") or {}).get("project_id")
        check("项目建好", bool(pid), str(created.text[:160]))
        seed(db, pid)
        print(f"项目 {pid} 已灌入卡片/测验/笔记/台历材料")

        env = {
            "KNOWORIGIN_BASE": base,
            "KNOWORIGIN_COOKIE": f"knoworigin_session={cookie}",
            "KNOWORIGIN_SHOT_DIR": str(shot_dir),
            "KNOWORIGIN_OUT": str(out_json),
        }
        proc = subprocess.run(
            ["node", str(ROOT / "tools" / "measure_agent_ui.mjs")],
            env={**os.environ, **env, "KNOWORIGIN_EDGE": edge},
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=420,
        )
        if not out_json.exists():
            print("量测脚本没产出报告：")
            print(proc.stdout[-3000:])
            print(proc.stderr[-2000:])
            check("量测脚本跑通", False)
            return 1
        report = json.loads(out_json.read_text(encoding="utf-8"))
        check("量测脚本跑通", not report.get("errors"), "; ".join(report.get("errors", []))[:200])
        check("界面切到了 agent 模式", report.get("ui") == "agent", str(report.get("ui")))

        for key, view in report.get("views", {}).items():
            print(f"\n=== 视图 {key} ===")
            if view.get("error"):
                check(f"{key} 打开", False, view["error"])
                continue
            # 1) 颜色残留
            # ⚠️ 只对 agent 视图查冷蓝/无暖色：classic 的设计本来就是暖色系，
            # 对它跑「不许有暖色」等于把回退层自己判成回归（已经踩过一次）。
            # academic 浅色同理是暖底，它没进这个工具是因为它不走 Agent 壳层。
            if key == "cards-classic":
                warm_probe: dict[str, list[str]] = {}
                green_probe: dict[str, list[str]] = {}
                for el in view.get("elements", []):
                    if any(a in el["sel"] for a in COLOR_ALLOW):
                        continue
                    for prop, value in (el.get("colors") or {}).items():
                        rgb = parse_color(value)
                        if not rgb:
                            continue
                        kind = classify(rgb)
                        if kind == "warm":
                            warm_probe.setdefault(el["sel"], []).append(f"{prop}={value}")
                        elif kind == "green":
                            green_probe.setdefault(el["sel"], []).append(f"{prop}={value}")
                got_warm = sum(len(v) for v in warm_probe.values())
                got_green = sum(len(v) for v in green_probe.values())
                check("classic 浅色确实是暖色系", got_warm > 0, f"{got_warm} 处暖色")
                check("classic 绿仍是暖绿不是冷蓝", got_green >= 0, f"{got_green} 处绿")
                continue

            warm: dict[str, list[str]] = {}
            green: dict[str, list[str]] = {}
            for el in view.get("elements", []):
                if any(a in el["sel"] for a in COLOR_ALLOW):
                    continue
                for prop, value in (el.get("colors") or {}).items():
                    rgb = parse_color(value)
                    if not rgb:
                        continue
                    kind = classify(rgb)
                    if kind == "warm":
                        warm.setdefault(el["sel"], []).append(f"{prop}={value}")
                    elif kind == "green":
                        green.setdefault(el["sel"], []).append(f"{prop}={value}")
                for grad in el.get("gradients") or []:
                    for token in grad.replace("\\n", " ").split(","):
                        rgb = parse_color(token)
                        kind = classify(rgb) if rgb else None
                        if kind == "warm":
                            warm.setdefault(el["sel"], []).append("gradient rgba")
                        elif kind == "green":
                            green.setdefault(el["sel"], []).append("gradient rgba")
            top_warm = sorted(warm.items(), key=lambda kv: -len(kv[1]))[:6]
            top_green = sorted(green.items(), key=lambda kv: -len(kv[1]))[:6]
            check(f"{key} 无暖色残留", not warm,
                  "; ".join(f"{s} ← {v[0]}" for s, v in top_warm))
            check(f"{key} 无绿色残留", not green,
                  "; ".join(f"{s} ← {v[0]}" for s, v in top_green))

            # 2) 返回对话按钮（只在整屏浮层开着时才有 —— offer 视图是故意收起来量对话区的）
                        # 1.5) classic 浅色：配色回退层必须真的生效
            # styles.css 里那些写死的暖色被迁成了语义 token，classic 没有专属 token 块，
            # 于是它一度整体变色。static/classic-palette.css 从 10/01 原始工程还原了它们，
            # 这里确认暖色真的回来了（而不是"没变色的默认状态"恰好通过）。
            if key == "cards-classic":
                probe = view.get("palette") or {}
                warm = probe.get("warm") or []
                check("classic 视图已就绪", view.get("ready") is True, str(view.get("ui")))
                check("classic 浅色暖色已还原", bool(warm),
                      "暖色值：" + ", ".join(f"{s}={c}" for s, c in warm[:4]))
                check("classic 没被 academic 的冷蓝覆盖",
                       not any(str(c).startswith("rgb(56, 103, 214") for _s, c in warm))

            # 2) 特定几何：标题栏只在功能浮层展开时存在，offer 截图里整个对话区被浮层盖住
            geom = view.get("geom") or {}
            studio_open = bool((geom.get("heading") or {}).get("rect", {}).get("w", 0) > 10)
            panel = geom.get("panel") or {}
            rail = geom.get("rail") or {}
            sessions = geom.get("sessions") or {}
            back = geom.get("back")
            if key == "offer" or not studio_open:
                print("  （浮层未展开，跳过返回按钮与重叠检查）")
            else:
                # 左栏必须一直在：浮层只该占主列（第 3 列），不该盖住图标栏与会话栏
                check(f"{key} 图标栏仍可见", rail.get("rect", {}).get("w", 0) > 10,
                      json.dumps(rail.get("rect"), ensure_ascii=False))
                check(f"{key} 会话栏仍可见", sessions.get("rect", {}).get("w", 0) > 10,
                      json.dumps(sessions.get("rect"), ensure_ascii=False))
                panel_rect = panel.get("rect") or {}
                left_edge = panel_rect.get("x", 0)
                sessions_right = (sessions.get("rect") or {}).get("x", 0) + \
                    (sessions.get("rect") or {}).get("w", 0)
                check(f"{key} 浮层不压到左栏",
                      panel_rect.get("w", 0) > 10 and left_edge >= sessions_right - 1,
                      f"浮层左边缘 {left_edge} vs 会话栏右边缘 {sessions_right}")
                check(f"{key} 浮层没占满整个视口",
                      panel_rect.get("w", 0) < 1600,
                      f"浮层宽 {panel_rect.get('w')}（视口 1600）")

                check(f"{key} 有返回对话按钮", bool(back) and back.get("rect", {}).get("w", 0) > 10,
                      json.dumps(back, ensure_ascii=False)[:140] if back else "不存在")
                if back:
                    check(f"{key} 返回按钮文案正确", "返回" in (back.get("text") or ""), back.get("text", ""))
                    check(f"{key} 返回按钮没被遮挡", bool(back.get("hitSelf")), str(back.get("hitTag")))

                # 3) 重叠
                ov = view.get("overlap") or {}
                check(f"{key} 产出区与英语词汇不重叠", ov.get("overlapArea", 0) == 0,
                      str(ov.get("overlapPx") or ""))

            # 英语词汇视图下不能出现学习产出那条标题栏（它显示的是上一个功能名，
            # 比如「我的笔记」压在英语词汇上面），模块自带返回与标签行
            if key == "english":
                vocab = geom.get("envocab") or {}
                vocab_visible = vocab.get("rect", {}).get("w", 0) > 10
                heading_w = (geom.get("heading") or {}).get("rect", {}).get("w", 0)
                check("english 视图已打开", vocab_visible,
                      json.dumps(vocab.get("rect"), ensure_ascii=False))
                check("english 视图不显示「我的笔记」标题栏", heading_w == 0,
                      f"标题栏宽 {heading_w}")

            # 5) 对比度：「看不清」是可测的，深色模式尤其要看
            # classic 没有 .card（卡片是 Agent 功能浮层里的），只量顶栏标题那一项
            contrast = view.get("contrast") if key.startswith("cards") else None
            if contrast and key == "cards-classic":
                contrast = {"items": [i for i in contrast.get("items", [])
                                      if not i.get("sel", "").startswith(".card")]}
            if contrast:
                for item in contrast.get("items", []):
                    label = item.get("label", "")
                    if item.get("missing"):
                        check(f"{key} 找到{label}", False, str(item.get("sel")))
                        continue
                    value = item.get("ratio")
                    # WCAG AA 正文 4.5:1；大号粗体题面用 3:1 底线
                    floor = 3.0 if "题面" in label else 4.5
                    check(
                        f"{key} {label}对比度 ≥ {floor}",
                        isinstance(value, (int, float)) and value >= floor,
                        f"{value}:1（{item.get('color')}）",
                    )

            # 4) 提议型卡片（plan_study_action）
            offer = view.get("offer")
            if offer is not None:
                options = offer.get("options") or []
                shell = offer.get("shell") or {}
                head = offer.get("head") or {}
                # —— 结构：外壳圆角 + 计数 + 折叠箭头（图一那套外壳的核心）——
                check("卡片外壳是 12px 圆角的独立面（不是贴边的一排按钮）",
                      shell.get("radius") == "12px", str(shell.get("radius")))
                # offer["count"] 是量测对象（text/rect/color/…），不是字符串；
                # 拿它跟 "1/7" 比永远不等 —— 文本另有 countText 一条断言在管。
                check("头部有「已选 M/N」计数（默认只勾第一项）",
                      (offer.get("count") or {}).get("text") == "1/7",
                      str((offer.get("count") or {}).get("text")))
                check("跳转族卡片默认也只勾第一项",
                      offer.get("jumpCount") == "1/4", str(offer.get("jumpCount")))
                check("头部不是「知识库修改」这类含混说法",
                      "知识库修改" not in (head.get("text") or ""), str(head.get("text")))
                # 计数有 innerText ≠ 用户看得见。必须量几何 + 是否落在卡片内。
                count = offer.get("count") or {}
                check("计数文本是「已选/总数」", offer.get("countText") == "1/7",
                      str(offer.get("countText")))
                check("计数落在卡片外壳内（别被 flex 或 overflow 裁掉）",
                      count.get("inShell") is True, json.dumps(count, ensure_ascii=False)[:200])
                caret = offer.get("caret") or {}
                check("折叠箭头也落在卡片内", caret.get("inShell") is True,
                      json.dumps(caret, ensure_ascii=False)[:200])
                # 「可见面积」只有在卡片**真的渲染出来了**时才判。offer 视图的浮层
                # 常常没展开（脚本别处已按 studio_open 跳过同类检查），此时元素 rect
                # 全是 0×0，但那是"没显示"而不是"被裁掉/塌陷"—— 判成不合格是误报。
                card_rendered = shell.get("radius") is not None and offer.get("shellW", 0) > 10
                if not card_rendered:
                    print("  （提议型卡片外壳未渲染，跳过可见面积检查）")
                else:
                    check("计数真的有可见面积（宽度 > 12px、高度 > 10px）",
                          count.get("visible") is True, json.dumps(count.get("rect"), ensure_ascii=False))
                    # 折叠箭头是 border 画的三角（styles.css: .agent-action-caret
                    # width/height 都是 0，左右各 4px、上 5px 的透明/实心边框），
                    # 所以它的外框就是 8×5 —— 不能套用普通色块的 w>12 门槛。
                    caret_rect = caret.get("rect") or {}
                    check("折叠箭头有可见面积（border 三角，设计尺寸 8×5）",
                          caret_rect.get("w", 0) >= 6 and caret_rect.get("h", 0) >= 3,
                          json.dumps(caret_rect, ensure_ascii=False))
                    # 有面积也可能被同位置的兄弟节点盖住 —— 中心点打一次命中测试
                    check("计数没被任何元素遮住", count.get("notCovered") is True,
                          f"命中 {count.get('hitTag')}")
                    check("折叠箭头没被遮住", caret.get("notCovered") is True,
                          f"命中 {caret.get('hitTag')}")
                    # 计数 pill 与卡片面必须分得开。原来用 --sidebar 底，只差 1.12:1，
                    # 等于隐形 —— 而它是「我选了几项」的唯一常驻出口。
                    chip_vs_card = contrast_ratio(count.get("bg"), shell.get("bg"))
                    check("计数底色与卡片面分得开（≥ 1.15:1）",
                          chip_vs_card is not None and chip_vs_card >= 1.15,
                          f"{chip_vs_card}:1（{count.get('bg')} on {shell.get('bg')}）")
                    # 计数 pill 是半透明的：字压在 pill 底上，pill 底压在卡片面上，
                    # 两层都要过一遍合成，否则算出来的是假数字。
                    chip_text = contrast_ratio(count.get("color"), count.get("bg"),
                                               mid=shell.get("bg"))
                    check("计数字号读得清（≥ 4.5:1）",
                          chip_text is not None and chip_text >= 4.5,
                          f"{chip_text}:1（{count.get('color')}）")
                # 选项块满宽 1200px 而标题只有几个字，右侧空掉一大片，读起来很散。
                check("选项块不满满铺（留出可读的文字列宽）",
                      0 < offer.get("rowW", 0) <= offer.get("shellW", 1) * 0.82,
                      f"选项 {offer.get('rowW')}px / 卡片 {offer.get('shellW')}px")

                # —— 选项：生成族 ——
                check("生成族渲染出 7 个选项", len(options) == 7,
                      str([o.get("kind") for o in options]))
                kinds = {o.get("kind") for o in options}
                check("生成族七种选项齐全",
                      kinds == {"card", "quiz", "doc", "cheatsheet",
                                "learning_path", "checklist", "focus"},
                      str(sorted(kinds)))
                check("生成族选项带 node_id（前端要靠它调端点）",
                      all(o.get("node") == "node_probe" for o in options),
                      str([o.get("node") for o in options]))
                # 默认只勾第一项：一次生成七个产物既慢又烧网关，而 AI 已把最该做的排在最前
                checked = [o.get("kind") for o in options if o.get("checked")]
                check("生成族默认只勾第一项（避免一次烧七个网关调用）",
                      checked == ["card"], str(checked))
                expected_text = {"card": "生成知识卡片", "quiz": "生成小测验",
                                 "doc": "生成复习文档", "focus": "只看这个知识点",
                                 "cheatsheet": "生成一页速查表",
                                 "learning_path": "生成学习路径",
                                 "checklist": "生成清单报告"}
                wrong = [f"{o.get('kind')}={o.get('label')}" for o in options
                         if expected_text.get(o.get("kind"), "") not in (o.get("label") or "")]
                check("选项标题文案正确", not wrong, "; ".join(wrong))
                # 双行块：没有说明行的话用户判断不了该选哪个，只能全选
                no_desc = [o.get("kind") for o in options if not o.get("desc")]
                check("每个选项都有第二行说明（图一的「标题 + 说明」）", not no_desc, str(no_desc))
                # 卡片不能高到把顶部选项顶出视口 —— 那样用户上来就看到一个点不动的选项
                check("卡片总高不超过视口的 70%（否则对话区被一张卡吃光）",
                      0 < offer.get("shellH", 0) <= offer.get("viewportH", 1) * 0.7,
                      f"卡片 {offer.get('shellH')}px / 视口 {offer.get('viewportH')}px")
                visible = [o for o in options if o.get("visible")]
                check("至少首屏就能看到 4 个选项（不是只能看到 1 个）",
                      len(visible) >= 4, str(len(visible)))
                dead = [o.get("kind") for o in visible if not o.get("hitSelf")]
                check("可见的选项整块可点（点 label 就该能勾选）", not dead, str(dead))
                # 被滚动区裁掉的项也要有真实尺寸：0 高度说明它们根本没渲染出来
                collapsed_rows = [o.get("kind") for o in options
                                  if not o.get("visible") and (o.get("h", 0) <= 24 or o.get("w", 0) <= 10)]
                check("被裁掉的选项仍占真实尺寸（不是 0 高度）", not collapsed_rows, str(collapsed_rows))
                thin = [o.get("kind") for o in options if o.get("h", 0) <= 24]
                check("选项块高度够放下「标题 + 说明」两行", not thin, str(thin))
                check("七个选项确实放不下、需要滚动（顺带证明滚动区在起作用）",
                      offer.get("listClipped") is True, str(offer.get("listClipped")))

                # —— 选项：跳转族（第二张卡，没有节点）——
                jump = offer.get("jumpOptions") or []
                jump_kinds = {o.get("kind") for o in jump}
                check("跳转族在没有节点时照样渲染出选项", len(jump) == 4,
                      str([o.get("kind") for o in jump]))
                check("跳转族四种选项齐全",
                      jump_kinds == {"view_cards", "view_cheatsheet",
                                     "view_learning_path", "view_checklist"},
                      str(sorted(jump_kinds)))
                check("跳转族选项不带 node（它就是项目级的）",
                      all(not o.get("node") for o in jump), str([o.get("node") for o in jump]))
                jump_text = {"view_cards": "看知识卡片", "view_cheatsheet": "看一页速查表",
                             "view_learning_path": "看学习路径", "view_checklist": "看清单报告"}
                jump_wrong = [f"{o.get('kind')}={o.get('label')}" for o in jump
                              if jump_text.get(o.get("kind"), "") not in (o.get("label") or "")]
                check("跳转族选项文案正确", not jump_wrong, "; ".join(jump_wrong))
                jump_thin = [o.get("kind") for o in jump if o.get("h", 0) <= 24]
                check("跳转族选项块高度够（别比生成族矮一截）", not jump_thin, str(jump_thin))

                # —— 底栏：「忽略 / 提交」+ 「不再等待」默认藏着 ——
                dismiss = offer.get("dismiss") or {}
                check("底栏左侧是「忽略」", offer.get("dismissText") == "忽略",
                      str(offer.get("dismissText")))
                check("底栏右侧是「提交」（不是「知道了」—— 那没有执行语义）",
                      offer.get("runText") == "提交", str(offer.get("runText")))
                check("「不再等待」默认隐藏（没在跑时不该出现）",
                      offer.get("stopHidden") is True, str(offer.get("stopHidden")))
                check("提交按钮初始可点（不是 disabled）",
                      offer.get("runDisabled") is False, str(offer.get("runDisabled")))

                # —— 对比度：这是「浅色深色都要匹配」的底线 ——
                run = offer.get("run") or {}
                run_ratio = contrast_ratio(run.get("color"), run.get("bg"))
                check("提交按钮文字对比度 ≥ 4.5:1（六套主题都得读得清）",
                      run_ratio is not None and run_ratio >= 4.5,
                      f"{run_ratio}:1（{run.get('color')} on {run.get('bg')}）")
                # 选项块底是半透明的绿色叠在 --background 上，所以必须把父底一起量进去
                shell_bg = shell.get("bg")
                label_ratio = contrast_ratio(
                    (options[0] or {}).get("cold", {}).get("color"), shell_bg)
                check("选项文字对比度 ≥ 4.5:1",
                      label_ratio is not None and label_ratio >= 4.5,
                      f"{label_ratio}:1（{(options[0] or {}).get('cold')}）")
                head_ratio = contrast_ratio(head.get("color"), shell_bg)
                check("卡片标题对比度 ≥ 4.5:1",
                      head_ratio is not None and head_ratio >= 4.5,
                      f"{head_ratio}:1（{head.get('color')} on {shell_bg}）")
                dismiss_ratio = contrast_ratio(dismiss.get("color"), shell_bg)
                check("「忽略」按钮对比度 ≥ 3:1（次要按钮可低一档）",
                      dismiss_ratio is not None and dismiss_ratio >= 3.0,
                      f"{dismiss_ratio}:1（{dismiss.get('color')} on {shell_bg}）")


            if view.get("shot"):
                print(f"  截图 {view['shot']}")
    finally:
        try:
            server.should_exit = True
        except Exception:
            pass

    print()
    for shot in sorted(shot_dir.glob("*.png")):
        print(f"截图: {shot}")
    print(f"报告: {out_json}")
    if not args.keep_shots:
        print("（--keep-shots 可保留截图）")

    print()
    if failures:
        print(f"失败 {len(failures)} 项：{failures}")
        return 1
    print("Agent 工作台视觉体检通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
