"""闭环自证：错因（学习者自选）→ 明日「先修这个」的建议变得具体。

跑法（必须用项目自带的解释器）：
    .venv311/Scripts/python.exe tools/check_error_type.py

它证明**一条链真的通了**：

  [1] 补写错因 → 库里 error_type 落了，**且不新增事件**（改的是那一行，不能污染 BKT）
  [2] 非法错因 → 422；找不到的题目 → 404
  [3] 未选错因时，repair 理由是通用版；选了之后变成「你说错在 X + 下一步做什么」（改前/改后对拍）
  [4] 真 Chromium：亮/暗两套主题下 chips 渲染正确、对比度 ≥ 4.5、答对的题不问
  [5] 漂移断言：前端 QUIZ_ERROR_TYPES 的键必须与后端 framework.ERROR_TYPES 一致

全程走临时 DATA_DIR / 临时目录，不碰用户 data/ 与工作区。
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

TMP = Path(tempfile.mkdtemp(prefix="errtype_check_"))
os.environ["DATA_DIR"] = str(TMP)

from fastapi.testclient import TestClient  # noqa: E402

from api_server import create_app  # noqa: E402
from core.framework import ERROR_TYPES  # noqa: E402

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


# ────────────────────────── [1]~[3] HTTP + 真库 ──────────────────────────


def part_http() -> None:
    app = create_app()
    client = TestClient(app)

    registered = client.post(
        "/api/auth/register",
        json={"email": "errtype@example.com", "name": "欣瑶", "password": "pw12345678"},
    )
    if registered.status_code != 201:
        raise SystemExit(f"注册失败：{registered.status_code} {registered.text[:300]}")
    owner = registered.json()["user"]["user_id"]

    db_path = next(p for p in TMP.rglob("*.sqlite3") if "knoworigin" in p.name)
    conn = sqlite3.connect(str(db_path))
    pid = "proj_errtype"
    conn.execute(
        "INSERT INTO projects (project_id, owner_id, year, subject, created_at,"
        " project_type, tags, reading_status, last_position, last_opened_at,"
        " total_reading_seconds) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (pid, owner, "2026", "错因链路自证", now_iso(), "course", "[]", "unread", 0.0, now_iso(), 0),
    )
    for node_id in ("NS", "OK"):
        conn.execute(
            "INSERT INTO framework_nodes (node_id, project_id, parent_id, name,"
            " description, coverage_status, learning_status, mastery_score,"
            " source_ids, prerequisite_ids, exam_weight, updated_at, note_content,"
            " tags, wikilinks) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (node_id, pid, "", f"知识点 {node_id}", "自证用", "covered",
             "unexplored", 0.0, "[]", "[]", "exam_normal", now_iso(), "", "[]", "[]"),
        )
    quiz_id = "quiz_errtype"
    questions = [
        {  # 正确答案 A，交 B ⇒ 答错
            "question": "NS 的题", "type": "choice", "options": ["A. 甲", "B. 乙"],
            "answer": "A", "explanation": "自证", "difficulty": 2,
            "node_ids": ["NS"], "source_ids": [],
        },
        {  # 交 A ⇒ 答对（用来验证「答对的题不问错因」）
            "question": "OK 的题", "type": "choice", "options": ["A. 甲", "B. 乙"],
            "answer": "A", "explanation": "自证", "difficulty": 2,
            "node_ids": ["OK"], "source_ids": [],
        },
    ]
    conn.execute(
        "INSERT INTO quizzes (quiz_id, project_id, payload, created_at) VALUES (?,?,?,?)",
        (quiz_id, pid, json.dumps({"questions": questions}), now_iso()),
    )
    conn.commit()
    conn.close()

    print("[1] 补写错因：改的是那一行，不是多记一条事件")
    sub = client.post(
        f"/api/projects/{pid}/quiz/{quiz_id}/submit",
        json={"answers": ["B. 乙", "A. 甲"], "self_confidences": [1.0, None]},
    )
    check("提交 200", sub.status_code == 200, sub.text[:300])
    check("第一题判错、第二题判对",
          sub.json()["results"][0]["correct"] is False and sub.json()["results"][1]["correct"] is True)

    conn = sqlite3.connect(str(db_path))
    before = conn.execute("SELECT COUNT(*) FROM learning_events WHERE project_id = ?", (pid,)).fetchone()[0]
    check("提交后库里 2 条事件", before == 2, str(before))
    conn.close()

    resp = client.post(
        f"/api/projects/{pid}/quiz/{quiz_id}/questions/0/error-type",
        json={"error_type": "confused"},
    )
    check("补写错因 200", resp.status_code == 200, resp.text[:300])
    body = resp.json()
    check("回显错因标签与下一步动作",
          body["error_type"] == "confused" and "记混" in body["error_label"] and "辨析" in body["next_action"],
          json.dumps(body, ensure_ascii=False))

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT node_id, reference_id, error_type FROM learning_events WHERE project_id = ? ORDER BY reference_id",
        (pid,),
    ).fetchall()
    check("事件数仍是 2（没有多记一条 —— 否则会污染 BKT 与掌握度）", len(rows) == 2, str(len(rows)))
    by_ref = {r["reference_id"]: r for r in rows}
    check("错题那行写上了 error_type", by_ref[f"{quiz_id}:0"]["error_type"] == "confused",
          str(by_ref.get(f"{quiz_id}:0") and by_ref[f"{quiz_id}:0"]["error_type"]))
    check("答对那行没被波及", by_ref[f"{quiz_id}:1"]["error_type"] is None)
    conn.close()

    print("[2] 入参校验（负向）")
    bad = client.post(f"/api/projects/{pid}/quiz/{quiz_id}/questions/0/error-type",
                      json={"error_type": "随便编一个"})
    check("非法错因 422 且不落库", bad.status_code == 422, str(bad.status_code))
    gone = client.post(f"/api/projects/{pid}/quiz/{quiz_id}/questions/99/error-type",
                       json={"error_type": "confused"})
    check("题目不存在 404（不静默成功）", gone.status_code == 404, str(gone.status_code))
    cleared = client.post(f"/api/projects/{pid}/quiz/{quiz_id}/questions/0/error-type",
                          json={"error_type": None})
    check("传 None = 清除", cleared.status_code == 200 and cleared.json()["error_type"] is None)
    client.post(f"/api/projects/{pid}/quiz/{quiz_id}/questions/0/error-type",
                json={"error_type": "confused"})  # 复原，给 [3] 用

    print("[3] 明日计划：选了错因，建议就从「再练一遍」变成「做什么」")
    plan = client.get(f"/api/progress/{pid}/plan").json()
    steps = plan.get("steps", [])
    repair = [s for s in steps if s.get("bucket") == "repair"]
    check("NS 进了 repair 桶", repair and repair[0]["node_id"] == "NS",
          str([(s.get("bucket"), s.get("node_id")) for s in steps]))
    reason = repair[0]["reason"] if repair else ""
    check("理由里带上学习者自己说的错因", "记混" in reason, reason)
    check("理由里带上具体的下一步动作", "辨析" in reason, reason)
    check("detail 里也能读到 error_type",
          repair and repair[0]["detail"].get("error_type") == "confused",
          str(repair and repair[0]["detail"]))
    print(f"      实际文案：{reason}")


def part_http_prereq_missing() -> None:
    """「这块我压根没学过」是最有用的一档错因 —— 它必须指向**具体哪几个**前置。

    光说「去补前置」是空话，学生只会回来重做这道题。
    这一节同时覆盖「前置图是空的」时的诚实降级：不能假装知道该补什么。
    """
    print("[3b] 错因 = 前置缺失：理由要点名该补哪几个")
    app = create_app()
    client = TestClient(app)
    registered = client.post(
        "/api/auth/register",
        json={"email": "prereqmiss@example.com", "name": "欣瑶", "password": "pw12345678"},
    )
    owner = registered.json()["user"]["user_id"]
    db_path = next(p for p in TMP.rglob("*.sqlite3") if "knoworigin" in p.name)
    conn = sqlite3.connect(str(db_path))
    pid = "proj_prereq_missing"
    conn.execute(
        "INSERT INTO projects (project_id, owner_id, year, subject, created_at,"
        " project_type, tags, reading_status, last_position, last_opened_at,"
        " total_reading_seconds) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (pid, owner, "2026", "前置缺失自证", now_iso(), "course", "[]", "unread", 0.0, now_iso(), 0),
    )
    # T 依赖 P1 / P2 —— 学生在这道题上答错并说「这块我压根没学过」
    for node_id, name, prereq in (
        ("P1", "几何光学基础", []),
        ("P2", "三角函数复习", []),
        ("T", "折射定律推导", ["P1", "P2"]),
    ):
        conn.execute(
            "INSERT INTO framework_nodes (node_id, project_id, parent_id, name,"
            " description, coverage_status, learning_status, mastery_score,"
            " source_ids, prerequisite_ids, exam_weight, updated_at, note_content,"
            " tags, wikilinks) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (node_id, pid, "", name, "自证用", "covered", "unexplored", 0.0,
             "[]", json.dumps(prereq), "exam_normal", now_iso(), "", "[]", "[]"),
        )
    quiz_id = "quiz_pmiss"
    conn.execute(
        "INSERT INTO quizzes (quiz_id, project_id, payload, created_at) VALUES (?,?,?,?)",
        (quiz_id, pid, json.dumps({"questions": [{
            "question": "T 的题", "type": "choice", "options": ["A. 甲", "B. 乙"],
            "answer": "A", "explanation": "自证", "difficulty": 2,
            "node_ids": ["T"], "source_ids": [],
        }]}), now_iso()),
    )
    conn.commit()
    conn.close()

    client.post(
        f"/api/projects/{pid}/quiz/{quiz_id}/submit",
        json={"answers": ["B. 乙"], "self_confidences": [1.0]},
    )
    client.post(
        f"/api/projects/{pid}/quiz/{quiz_id}/questions/0/error-type",
        json={"error_type": "prereq_missing"},
    )
    plan = client.get(f"/api/progress/{pid}/plan").json()
    repair = [s for s in plan.get("steps", []) if s.get("bucket") == "repair"]
    reason = repair[0]["reason"] if repair else ""
    check("T 进了 repair 桶", bool(repair), str([(s.get("bucket"), s.get("node_id")) for s in plan.get("steps", [])]))
    check("理由点名了第一个前置", "几何光学基础" in reason, reason)
    check("理由点名了第二个前置", "三角函数复习" in reason, reason)
    check("没有把 T 自己当成它的前置", reason.count("折射定律") == 1, reason)
    print(f"      实际文案：{reason}")

    # 前置图是空的 ⇒ 不能假装知道该补什么
    print("[3c] 前置图是空的时候，要诚实说不知道")
    conn = sqlite3.connect(str(db_path))
    conn.execute("UPDATE framework_nodes SET prerequisite_ids = '[]' WHERE project_id = ?", (pid,))
    conn.commit()
    conn.close()
    plan2 = client.get(f"/api/progress/{pid}/plan").json()
    repair2 = [s for s in plan2.get("steps", []) if s.get("bucket") == "repair"]
    reason2 = repair2[0]["reason"] if repair2 else ""
    check("不编造前置（理由里不再出现任何前置名）",
          "几何光学基础" not in reason2 and "三角函数复习" not in reason2, reason2)
    check("如实说明框架还没标出前置", "还没标出" in reason2, reason2)
    print(f"      实际文案：{reason2}")


# ────────────────────────── [4] 真 Chromium 量测 ──────────────────────────


def find_chrome() -> Path:
    home = Path(os.path.expanduser("~"))
    cands = sorted((home / "AppData" / "Local" / "ms-playwright").glob("chromium-*/chrome-win64/chrome.exe"))
    if not cands:
        raise SystemExit("找不到 Playwright 的 chrome.exe")
    return cands[-1]


def build_harness() -> Path:
    src = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
    start = src.index("// ── 错因：答错之后自己选，可跳过")
    end = src.index("function renderQuizFeedback(question, result, index) {")
    helpers = src[start:end]
    if "function quizErrorTypeMarkup" not in helpers:
        raise SystemExit("没能抽到错因渲染函数（锚点已漂移）")

    css_url = (ROOT / "static" / "styles.css").as_uri()
    html = f"""<!doctype html>
<html data-brand="tju" data-theme="light">
<head><meta charset="utf-8"><link rel="stylesheet" href="{css_url}"></head>
<body><div id="stage"></div><pre id="out">PENDING</pre>
<script>
(function () {{
  // 抽出来的函数会用到 app.js 里的转义助手 —— 探针里补同样语义的桩，
  // 否则整个 IIFE 在 ReferenceError 处中断，量测输出停在 PENDING。
  function escapeHtml(value) {{
    return String(value == null ? "" : value).replace(/[&<>"]/g, function (c) {{
      return {{ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }}[c];
    }});
  }}
  var escapeAttr = escapeHtml;
{helpers}
  function nums(s) {{ var m = String(s).match(/[\\d.]+/g) || []; return m.map(Number); }}
  function rgba(s) {{ var v = nums(s); return [v[0]||0, v[1]||0, v[2]||0, v.length > 3 ? v[3] : 1]; }}
  function over(list) {{
    var out = [255,255,255];
    for (var i = 0; i < list.length; i++) {{
      var c = list[i];
      out = [0,1,2].map(function (k) {{ return c[k]*c[3] + out[k]*(1-c[3]); }});
    }}
    return out;
  }}
  function lum(c) {{
    var s = c.map(function (v) {{ v = v/255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); }});
    return 0.2126*s[0] + 0.7152*s[1] + 0.0722*s[2];
  }}
  function contrast(a, b) {{ var l1 = lum(a), l2 = lum(b); return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05); }}

  function measure(theme) {{
    // 切主题后已存在节点的 getComputedStyle 不刷新 —— 每轮重建 DOM
    document.documentElement.setAttribute("data-theme", theme);
    var pageBg = rgba(getComputedStyle(document.documentElement).backgroundColor);
    var stage = document.getElementById("stage");
    stage.innerHTML = "";
    var out = {{ theme: theme }};

    var wrong = document.createElement("div");
    wrong.innerHTML = quizErrorTypeMarkup(3, "quiz_x", true, "confused");
    stage.appendChild(wrong);
    var opts = wrong.querySelectorAll(".quiz-errc-opt");
    var cs = opts.length ? getComputedStyle(opts[0]) : null;
    out.wrong = {{
      rendered: opts.length > 0,
      count: opts.length,
      values: Array.prototype.map.call(opts, function (b) {{ return b.dataset.quizErrorType; }}),
      labels: Array.prototype.map.call(opts, function (b) {{ return b.textContent; }}),
      pressed: Array.prototype.filter.call(opts, function (b) {{ return b.getAttribute("aria-pressed") === "true"; }}).map(function (b) {{ return b.dataset.quizErrorType; }}),
      contrast: cs ? Math.round(contrast(rgba(cs.color), over([pageBg]))*100)/100 : null,
    }};

    var right = document.createElement("div");
    right.innerHTML = quizErrorTypeMarkup(4, "quiz_x", false, null);
    stage.appendChild(right);
    out.rightAnswer_asks_nothing = right.querySelectorAll(".quiz-errc-opt").length === 0;

    var picked = wrong.querySelector(".quiz-errc-opt.is-picked");
    if (picked) {{
      var pcs = getComputedStyle(picked);
      out.picked_contrast = Math.round(contrast(rgba(pcs.color), over([pageBg, rgba(pcs.backgroundColor)]))*100)/100;
    }}
    return out;
  }}
  document.getElementById("out").textContent = JSON.stringify({{ light: measure("light"), dark: measure("dark") }});
}})();
</script></body></html>"""
    path = Path(tempfile.gettempdir()) / "ko_errtype_probe.html"
    path.write_text(html, encoding="utf-8")
    return path


def part_browser() -> None:
    print("[4] 结果页错因 chips：真 Chromium 量测（亮/暗）")
    chrome = find_chrome()
    harness = build_harness()
    try:
        proc = subprocess.run(
            [str(chrome), "--headless=new", "--disable-gpu", "--no-sandbox",
             "--virtual-time-budget=6000", "--dump-dom", harness.as_uri()],
            capture_output=True, text=True, encoding="utf-8", timeout=120,
        )
        dom = proc.stdout or ""
        marker = '<pre id="out">'
        if marker not in dom:
            raise SystemExit(f"没取到量测输出：{(proc.stderr or '')[:400]}")
        data = json.loads(dom.split(marker, 1)[1].split("</pre>", 1)[0])
    finally:
        try:
            harness.unlink()
        except OSError:
            pass

    for theme in ("light", "dark"):
        m = data[theme]
        w = m["wrong"]
        check(f"[{theme}] 答错的题渲染出 4 个错因 chip", w["rendered"] and w["count"] == 4, json.dumps(w, ensure_ascii=False))
        check(f"[{theme}] chip 的值是后端的四个键",
              w["values"] == ["prereq_missing", "confused", "forgotten", "other"], str(w["values"]))
        check(f"[{theme}] 传入的错因呈选中态（aria-pressed）", w["pressed"] == ["confused"], str(w["pressed"]))
        check(f"[{theme}] 答对的题不出现错因行", m["rightAnswer_asks_nothing"])
        check(f"[{theme}] chip 文字对比度 ≥ 4.5", w["contrast"] is not None and w["contrast"] >= 4.5,
              f"实测 {w['contrast']}")
        check(f"[{theme}] 选中态对比度 ≥ 4.5",
              m.get("picked_contrast") is not None and m["picked_contrast"] >= 4.5,
              f"实测 {m.get('picked_contrast')}")


def part_drift() -> None:
    print("[5] 漂移断言：前端四档与后端 framework.ERROR_TYPES 必须一致")
    src = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
    block = src[src.index("const QUIZ_ERROR_TYPES = ["):src.index("];", src.index("const QUIZ_ERROR_TYPES = ["))]
    pairs = re.findall(r'\["([a-z_]+)",\s*"([^"]+)"\]', block)
    js_keys = [k for k, _ in pairs]
    check("前端四档顺序与键名 == 后端 ERROR_TYPES", js_keys == list(ERROR_TYPES.keys()),
          f"js={js_keys} py={list(ERROR_TYPES.keys())}")
    js_labels = [v for _, v in pairs]
    py_labels = [ERROR_TYPES[k] for k in js_keys]
    # 「其他」在前端缩写成「其他」，后端是「其他（看错题 / 算错 / 说不清）」—— 允许前端缩短，但必须同源
    check("文案同源（前端可缩短，但必须是后端的开头）",
          all(py.startswith(js) for js, py in zip(js_labels, py_labels)),
          f"{js_labels} vs {py_labels}")


def main() -> int:
    part_http()
    part_http_prereq_missing()
    part_browser()
    part_drift()
    print(f"\nPASS {PASS} / FAIL {FAIL}")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
