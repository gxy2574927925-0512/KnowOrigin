"""「整页对照」右栏裂图回归（TestClient，用真实产物，不联网、不调模型）。

跑法：``F:\\pppython\\python.exe tools/verify_pdf_spread_render.py``

背景 ——
  右栏那张译文页原先由前端直接拼 ``/translate-pdf/spread-image`` 的地址。但那个端点
  **只读缓存、从不渲染**；真正「按需栅格化并落盘」的是 ``/translate-pdf/spread``。
  前端从没调过后者，于是缓存目录里没图时就是 404，界面上表现为右边一张裂图。

覆盖 ——
  1. ``/status`` 在 pages 为空时能回退到已存在的产物（dual_ready=True）——
     页面刷新后前端会丢页码，不回退就会误报「未翻译」
  2. ``/spread`` 首次调用会渲染并落盘，返回可用的 right_url
  3. ``/spread-image`` 用 ``/spread`` 给的地址能取到真 PNG
  4. 未渲染过的页直接打 ``/spread-image`` → 404（复现旧前端裂图的成因）
  5. 翻页（index=1）同样能渲染出图

用真实 data/ 里的 CHAP_1 产物，但全部在临时目录副本上跑，不污染工作区。
"""
import shutil
import sys
import tempfile
import warnings
from datetime import datetime, timedelta, timezone
from pathlib import Path

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from fastapi.testclient import TestClient  # noqa: E402

from api_server import SESSION_COOKIE_NAME, create_app  # noqa: E402
from config import Settings  # noqa: E402
from core.database import Database  # noqa: E402

PID = "lit_c3de2e008c0c41c4"
SID = "src_b29f5d2590a040ba"
OWNER = "user_ccf1efd5503a413f"
BASE = f"/api/literature/{PID}/translate-pdf"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

FAILS = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


def main():
    src_data = ROOT / "data"
    tmp = Path(tempfile.mkdtemp(prefix="knoworigin-spread-"))
    shutil.copy2(src_data / "knoworigin.sqlite3", tmp / "knoworigin.sqlite3")
    for sub in ("source_files", "source_previews"):
        origin = src_data / sub / PID
        if origin.is_dir():
            shutil.copytree(origin, tmp / sub / PID)

    settings = Settings(
        tju_api_key="tk-verify-placeholder",
        tju_base_url="https://example.invalid/api",
        tju_model="tju-llm",
        data_dir=tmp,
        usage_tracking_enabled=False,
        pdf2zh_enabled=True,
    )
    db = Database(tmp / "knoworigin.sqlite3")
    app = create_app(db, settings)
    client = TestClient(app)
    session = db.create_session(OWNER, datetime.now(timezone.utc) + timedelta(days=1))
    client.cookies.set(SESSION_COOKIE_NAME, session)

    # 1) 页码为空也要能认出「已经翻过」（页面刷新后的场景）
    st = client.get(f"{BASE}/status", params={"source_id": SID, "pages": ""})
    body = st.json() if st.status_code == 200 else {}
    check(
        "pages 为空时回退到已有产物（dual_ready）",
        st.status_code == 200 and body.get("dual_ready") is True,
        f"http={st.status_code} dual_ready={body.get('dual_ready')} spreads={body.get('spreads')}",
    )

    # 4) 先证明旧写法确实会裂：没渲染过的页直接打 spread-image → 404
    raw = client.get(
        f"{BASE}/spread-image",
        params={"source_id": SID, "pages": "", "side": "right", "index": 3, "dpi": 130},
    )
    check(
        "未渲染的页直接取 spread-image → 404（旧前端的裂图成因）",
        raw.status_code == 404,
        f"http={raw.status_code}",
    )

    # 2) /spread 会渲染并返回可用地址
    sp = client.get(
        f"{BASE}/spread", params={"source_id": SID, "pages": "", "index": 0, "dpi": 130}
    )
    sp_body = sp.json() if sp.status_code == 200 else {}
    check(
        "/spread 首次调用返回 right_url",
        sp.status_code == 200 and bool(sp_body.get("right_url")),
        f"http={sp.status_code} total={sp_body.get('total')}",
    )

    # 3) 用 /spread 给的地址能取到真 PNG
    if sp_body.get("right_url"):
        img = client.get(sp_body["right_url"])
        check(
            "用 /spread 给的地址取到真 PNG",
            img.status_code == 200
            and img.headers.get("content-type", "").startswith("image/png")
            and img.content.startswith(PNG_MAGIC),
            f"http={img.status_code} bytes={len(img.content)}",
        )
        check(
            "左栏原文页同样渲染出来了",
            bool(sp_body.get("left_url"))
            and client.get(sp_body["left_url"]).status_code == 200,
            sp_body.get("left_url", ""),
        )

    # 5) 翻页
    sp2 = client.get(
        f"{BASE}/spread", params={"source_id": SID, "pages": "", "index": 1, "dpi": 130}
    )
    sp2_body = sp2.json() if sp2.status_code == 200 else {}
    ok2 = sp2.status_code == 200 and bool(sp2_body.get("right_url"))
    if ok2:
        ok2 = client.get(sp2_body["right_url"]).status_code == 200
    check("翻到第 2 组同样能出图", ok2, f"http={sp2.status_code}")

    # 产物确实落了盘（下次不用重渲染）
    cache_dir = tmp / "source_previews" / PID / SID / "pdf2zh"
    pngs = sorted(p.name for p in cache_dir.rglob("spreads/*.png"))
    check("栅格化结果已缓存到 spreads/", len(pngs) >= 4, ", ".join(pngs[:6]))

    print()
    if FAILS:
        print(f"{len(FAILS)} 项未通过：{', '.join(FAILS)}")
        return 1
    print("全部通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
