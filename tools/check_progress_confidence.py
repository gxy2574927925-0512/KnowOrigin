"""闭环自证：学习者自评把握度 → 四象限 → 明日「先修这个」。

跑法（必须用项目自带的解释器）：
    .venv311/Scripts/python.exe tools/check_progress_confidence.py

它证明的是**一条链真的通了**，不是「函数单测过了」：

  [1] 带自评提交一道题 → learning_events.self_confidence 里是**真实值**，而且不是 0.95
  [2] 答错 + 自评「我确定」→ 出现在 GET /api/progress/{id}/plan 的 repair 桶
  [3] 答错 + 自评「我不确定」或**根本没勾** → **不得**进 repair 桶   ← 最重要的一条
  [4] 结果页真的渲染出四象限标签（真 Chromium 量测，不是桩 DOM）

第 3 条不能省：这个功能修的 bug 就是「没有自评也照进 repair」，
没有负向断言的话，改完可能只是把写死的 0.95 换了个名字。

全程走临时 DATA_DIR / 临时目录，不碰用户 data/ 与工作区（沙箱会拦工作区内的 unlink）。
"""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

TMP = Path(tempfile.mkdtemp(prefix="selfconf_check_"))
os.environ["DATA_DIR"] = str(TMP)

from fastapi.testclient import TestClient  # noqa: E402

from api_server import create_app  # noqa: E402

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


def part_http() -> list[dict]:
    app = create_app()
    client = TestClient(app)

    registered = client.post(
        "/api/auth/register",
        json={"email": "selfconf@example.com", "name": "欣瑶", "password": "pw12345678"},
    )
    if registered.status_code != 201:
        raise SystemExit(f"注册失败：{registered.status_code} {registered.text[:300]}")
    owner = registered.json()["user"]["user_id"]

    db_path = next(p for p in TMP.rglob("*.sqlite3") if "knoworigin" in p.name)
    conn = sqlite3.connect(str(db_path))
    pid = "proj_selfconf"
    conn.execute(
        "INSERT INTO projects (project_id, owner_id, year, subject, created_at,"
        " project_type, tags, reading_status, last_position, last_opened_at,"
        " total_reading_seconds) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (pid, owner, "2026", "自评链路自证", now_iso(), "course", "[]", "unread", 0.0, now_iso(), 0),
    )

    # NS：答错 + 自评「我确定」  → 应该进 repair
    # NU：答错 + 自评「我不确定」→ 不该进 repair
    # NN：答错 + 没勾自评        → 不该进 repair
    for node_id in ("NS", "NU", "NN"):
        conn.execute(
            "INSERT INTO framework_nodes (node_id, project_id, parent_id, name,"
            " description, coverage_status, learning_status, mastery_score,"
            " source_ids, prerequisite_ids, exam_weight, updated_at, note_content,"
            " tags, wikilinks) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (node_id, pid, "", f"知识点 {node_id}", "自证用", "covered",
             "unexplored", 0.0, "[]", "[]", "exam_normal", now_iso(), "", "[]", "[]"),
        )

    quiz_id = "quiz_selfconf"
    questions = []
    for idx, node_id in enumerate(("NS", "NU", "NN")):
        questions.append(
            {
                "question": f"{node_id} 的第 {idx + 1} 题",
                "type": "choice",
                "options": ["A. 甲", "B. 乙"],
                "answer": "A",
                "explanation": "自证用解析",
                "difficulty": 2,
                "node_ids": [node_id],
                "source_ids": [],
            }
        )
    conn.execute(
        "INSERT INTO quizzes (quiz_id, project_id, payload, created_at) VALUES (?,?,?,?)",
        (quiz_id, pid, json.dumps({"questions": questions}), now_iso()),
    )
    conn.commit()
    conn.close()

    print("[1] 带自评提交 → 库里是真实值（且不是 0.95）")
    # 三题全答错（正确答案是 A，交 B）；自评分别是 确定 / 不确定 / 不勾
    resp = client.post(
        f"/api/projects/{pid}/quiz/{quiz_id}/submit",
        json={
            "answers": ["B. 乙", "B. 乙", "B. 乙"],
            "self_confidences": [1.0, 0.0, None],
        },
    )
    check("提交返回 200", resp.status_code == 200, resp.text[:300])
    results = (resp.json() or {}).get("results", [])
    check("逐题结果回显 self_confidence", [r.get("self_confidence") for r in results] == [1.0, 0.0, None],
          str([r.get("self_confidence") for r in results]))
    check("三题都判为答错", all(r.get("correct") is False for r in results))

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT node_id, kind, correctness, confidence, self_confidence FROM learning_events"
        " WHERE project_id = ? ORDER BY node_id",
        (pid,),
    ).fetchall()
    by_node = {r["node_id"]: r for r in rows}
    check("三个节点各写了一条事件", len(rows) == 3, str([r["node_id"] for r in rows]))
    check("NS 的自评 = 1.0（我确定）", by_node.get("NS") and by_node["NS"]["self_confidence"] == 1.0,
          str(by_node.get("NS") and by_node["NS"]["self_confidence"]))
    check("NU 的自评 = 0.0（我不确定）", by_node.get("NU") and by_node["NU"]["self_confidence"] == 0.0,
          str(by_node.get("NU") and by_node["NU"]["self_confidence"]))
    check("NN 的自评 = NULL（没勾，不编数据）",
          "NN" in by_node and by_node["NN"]["self_confidence"] is None,
          str(by_node.get("NN") and by_node["NN"]["self_confidence"]))
    check("没有一条 self_confidence 等于 0.95（写死的旧值没有渗进来）",
          all(r["self_confidence"] != 0.95 for r in rows))
    check("confidence 仍是 0.95（映射置信度的语义没被改，掌握度公式不受影响）",
          all(r["confidence"] == 0.95 for r in rows),
          str([r["confidence"] for r in rows]))
    conn.close()

    print("[2][3] 明日计划：答错 + 自评确信 进 repair；不确定 / 没勾 不进")
    plan_resp = client.get(f"/api/progress/{pid}/plan")
    check("plan 200", plan_resp.status_code == 200, plan_resp.text[:300])
    steps = (plan_resp.json() or {}).get("steps", [])
    repair_nodes = [s["node_id"] for s in steps if s.get("bucket") == "repair"]
    check("repair 桶里有且只有 NS", repair_nodes == ["NS"], str([(s.get("bucket"), s.get("node_id")) for s in steps]))
    check("NU（自评不确定）不在 repair 桶", "NU" not in repair_nodes)
    check("NN（没勾自评）不在 repair 桶", "NN" not in repair_nodes)
    check("repair 的理由提到「确信」",
          bool(repair_nodes) and "确信" in next(s["reason"] for s in steps if s.get("bucket") == "repair"))
    return steps


# ────────────────────────── [4] 真 Chromium 量测 ──────────────────────────


def find_chrome() -> Path:
    home = Path(os.path.expanduser("~"))
    cands = sorted((home / "AppData" / "Local" / "ms-playwright").glob("chromium-*/chrome-win64/chrome.exe"))
    if not cands:
        raise SystemExit("找不到 Playwright 的 chrome.exe —— 无法做真机量测")
    return cands[-1]


def build_harness() -> Path:
    """harness 落在 os.tmpdir()：沙箱的 safe-delete shim 会拦工作区内的 unlink。"""
    src = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
    start = src.index("// ── 「先押一个」自评把握度")
    end = src.index("function renderQuizFeedback(question, result, index) {")
    helpers = src[start:end]  # 真实函数源码，不是副本
    if "function quizQuadrantMarkup" not in helpers:
        raise SystemExit("没能从 app.js 里抽到四象限渲染函数（锚点已漂移，请更新本脚本）")

    css_url = (ROOT / "static" / "styles.css").as_uri()
    html = f"""<!doctype html>
<html data-brand="tju" data-theme="light">
<head><meta charset="utf-8"><link rel="stylesheet" href="{css_url}"></head>
<body>
<div id="stage"></div>
<pre id="out">PENDING</pre>
<script>
(function () {{
{helpers}
  function nums(str) {{ var m = String(str).match(/[\\d.]+/g) || []; return m.map(Number); }}
  function rgba(str) {{ var v = nums(str); return [v[0]||0, v[1]||0, v[2]||0, v.length > 3 ? v[3] : 1]; }}
  function over(colors) {{
    var out = [255, 255, 255];
    for (var i = 0; i < colors.length; i++) {{
      var c = colors[i];
      out = [0,1,2].map(function (k) {{ return c[k] * c[3] + out[k] * (1 - c[3]); }});
    }}
    return out;
  }}
  function lum(c) {{
    var s = c.map(function (v) {{ v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }});
    return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
  }}
  function contrast(a, b) {{ var l1 = lum(a), l2 = lum(b); return (Math.max(l1,l2) + 0.05) / (Math.min(l1,l2) + 0.05); }}

  function measure(theme) {{
    // ⚠️ headless 下切 theme 后，**已存在**节点的 getComputedStyle 不刷新，
    // 只有新建节点才是对的 —— 所以每一轮都重建 DOM（上一轮踩过）。
    document.documentElement.setAttribute("data-theme", theme);
    var pageBg = rgba(getComputedStyle(document.documentElement).backgroundColor);
    var stage = document.getElementById("stage");
    stage.innerHTML = "";
    var cases = [
      ["overconfident", {{ correct: false, self_confidence: 1.0, difficulty: 2 }}],
      ["expected",      {{ correct: false, self_confidence: 0.0, difficulty: 2 }}],
      ["solid",         {{ correct: true,  self_confidence: 1.0, difficulty: 2 }}],
      ["shaky",         {{ correct: true,  self_confidence: 0.0, difficulty: 2 }}],
      ["no-ask",        {{ correct: false, self_confidence: null, difficulty: 2 }}],
    ];
    var out = {{ theme: theme, page_bg: pageBg.join(","), badges: {{}}, ask_contrast: null, summary: "" }};
    cases.forEach(function (pair) {{
      var wrap = document.createElement("p");
      wrap.innerHTML = "题干" + quizQuadrantMarkup(pair[1]);
      stage.appendChild(wrap);
      var el = wrap.querySelector(".quiz-quad");
      if (!el) {{ out.badges[pair[0]] = {{ rendered: false }}; return; }}
      var cs = getComputedStyle(el);
      var bg = rgba(cs.backgroundColor);
      var eff = over([pageBg[3] < 1 ? pageBg : [pageBg[0],pageBg[1],pageBg[2],1], bg]);
      out.badges[pair[0]] = {{
        rendered: true,
        text: el.textContent,
        color: cs.color,
        contrast: Math.round(contrast(rgba(cs.color), eff) * 100) / 100,
      }};
    }});
    // 「先押一个」两档控件的可读性 + 默认勾选态
    var ask = document.createElement("div");
    ask.innerHTML = quizSelfConfidenceMarkup(7, 1);
    stage.appendChild(ask);
    var opts = ask.querySelectorAll(".quiz-selfc-opt");
    var opts0 = opts.length ? getComputedStyle(opts[0]) : null;
    out.ask_contrast = opts0
      ? Math.round(contrast(rgba(opts0.color), over([pageBg])) * 100) / 100
      : null;
    var radios = ask.querySelectorAll('input[type="radio"][name="sc7"]');
    out.ask = {{
      count: radios.length,
      values: Array.prototype.map.call(radios, function (r) {{ return r.value; }}),
      checked: Array.prototype.filter.call(radios, function (r) {{ return r.checked; }}).map(function (r) {{ return r.value; }}),
      labels: Array.prototype.map.call(ask.querySelectorAll(".quiz-selfc-opt span"), function (s) {{ return s.textContent; }}),
    }};
    var sum = document.createElement("div");
    sum.innerHTML = quizQuadrantSummaryMarkup([
      {{ correct: false, self_confidence: 1.0 }},
      {{ correct: false, self_confidence: 1.0 }},
      {{ correct: false, self_confidence: 0.0 }},
      {{ correct: true,  self_confidence: 1.0 }},
    ]);
    stage.appendChild(sum);
    var sEl = sum.querySelector(".quiz-quad-summary");
    if (sEl) {{
      var sBg = rgba(getComputedStyle(sEl).backgroundColor);
      out.summary = sEl.textContent.trim();
      out.summary_contrast = Math.round(contrast(rgba(getComputedStyle(sEl).color), over([pageBg, sBg])) * 100) / 100;
    }}
    return out;
  }}
  document.getElementById("out").textContent = JSON.stringify({{
    light: measure("light"),
    dark: measure("dark"),
  }});
}})();
</script>
</body></html>"""
    path = Path(tempfile.gettempdir()) / "ko_selfconf_probe.html"
    path.write_text(html, encoding="utf-8")
    return path


def part_browser() -> None:
    print("[4] 结果页四象限：真 Chromium 量测（亮/暗两套主题）")
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
        payload = dom.split(marker, 1)[1].split("</pre>", 1)[0]
        data = json.loads(payload)
    finally:
        try:
            harness.unlink()
        except OSError:
            pass

    for theme in ("light", "dark"):
        m = data[theme]
        print(f"    · {theme}：页面底 {m['page_bg']}")
        b = m["badges"]
        check(f"[{theme}] 答错+确信 渲染成「⚠ 误以为会」",
              b["overconfident"].get("rendered") and b["overconfident"]["text"] == "⚠ 误以为会",
              str(b["overconfident"]))
        check(f"[{theme}] 答错+不确定 渲染成「正常」",
              b["expected"].get("rendered") and b["expected"]["text"] == "正常")
        check(f"[{theme}] 答对+确信 渲染成「✓ 稳」", b["solid"].get("rendered") and b["solid"]["text"] == "✓ 稳")
        check(f"[{theme}] 答对+不确定 渲染成「待巩固」", b["shaky"].get("rendered") and b["shaky"]["text"] == "待巩固")
        check(f"[{theme}] 没勾自评 → 不给标签（不编数据）", b["no-ask"].get("rendered") is False)
        for key in ("overconfident", "solid"):
            c = b[key].get("contrast")
            check(f"[{theme}] {key} 标签对比度 ≥ 4.5（11px 小字档）", c is not None and c >= 4.5, f"实测 {c}")
        check(f"[{theme}] 自评两档控件文字对比度 ≥ 4.5",
              m.get("ask_contrast") is not None and m["ask_contrast"] >= 4.5, f"实测 {m.get('ask_contrast')}")
        check(f"[{theme}] 汇总句对比度 ≥ 4.5",
              m.get("summary_contrast") is not None and m["summary_contrast"] >= 4.5, f"实测 {m.get('summary_contrast')}")
        check(f"[{theme}] 汇总句只数「确信却答错」的两道",
              m["summary"] == "有 2 道你确信却答错，已加入明天优先修。", m["summary"])
        check(f"[{theme}] 自评两档 = 我确定 / 我不确定，默认勾中传入的那档",
              m["ask"]["count"] == 2 and m["ask"]["values"] == ["1", "0"]
              and m["ask"]["checked"] == ["1"] and m["ask"]["labels"] == ["我确定", "我不确定"],
              json.dumps(m["ask"], ensure_ascii=False))


def part_wiring() -> None:
    """[5] 接线自证（源码级）。

    [4] 只证明了「渲染函数 + 样式」是对的，没证明它们真的被接进了作答/提交路径。
    锚点替换最容易在这里静默失手，所以这里对源码做断言 —— 明确标注：这是源码级证据，
    不是运行时证据。
    """
    print("[5] 接线自证（源码级）")
    app = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
    panel = (ROOT / "static" / "progress-panel.js").read_text(encoding="utf-8")
    index = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
    sw = (ROOT / "static" / "service-worker.js").read_text(encoding="utf-8")

    check("renderQuestion 两个拼装分支都插了自评行",
          app.count("${selfcRow}") == 2, str(app.count("${selfcRow}")))
    check("renderQuiz 头部注入「确信却答错」汇总句",
          "quizQuadrantSummaryMarkup(state.quiz.results)" in app)
    check("知识卡片测验也注入汇总句", "quizQuadrantSummaryMarkup(results)" in app)
    check("两处提交都带 self_confidences",
          app.count("self_confidences: selfConfidences") == 2,
          str(app.count("self_confidences: selfConfidences")))
    check("读取端与控件端用同一个字段前缀 sc",
          app.count('form.get(`sc${index}`)') + app.count('new FormData(form).get(`sc${index}`)') == 2
          and app.count('name="sc${index}"') == 1,
          f"read={app.count('get(`sc${index}`)')} write={app.count('name=\"sc${index}\"')}")
    check("两个草稿捕获函数都识别 sc 前缀", app.count("/^sc\\d+$/") == 2,
          str(app.count("/^sc\\d+$/")))
    # 负向断言：sc 分支必须写完就 return（否则会掉进下面按 q 的答案草稿逻辑，
    # 把「我确定」这个 1/0 塞进 quizDraftAnswers —— 那等于伪造学生填的答案）。
    check("sc 分支写完即 return，不落进答案草稿（负向）",
          app.count('? 1 : 0;\n    return;\n  }') == 2,
          str(app.count('? 1 : 0;\n    return;\n  }')))
    check("自评落在独立的状态表里（quizSelfConfidence / kbNodeQuizSelfConfidence）",
          "state.quizSelfConfidence[" in app and "state.kbNodeQuizSelfConfidence[" in app)
    check("结果页标签接在 quizFeedbackContent 的标题行上",
          "quizQuadrantMarkup(result)}</strong>" in app)
    check("进度面板有「今天没有需要优先修的误解」空态", "ko-pg-repair-hint" in panel)
    # 缓存戳断言用「日期戳 + 最低版本」的宽松口径，不写死具体戳 ——
    # 否则每次 bump 都要把这条断言拖出来改（v118→v119 的 favtoast 轮就漏过一次）。
    import re as _re
    check("progress-panel.js 缓存戳带今天的日期（改动必须 bump 才拿得到）",
          bool(_re.search(r"progress-panel\.js\?v=20260930\d*", index)),
          "progress-panel.js?v= 未找到 20260930 日期戳")
    _m = _re.search(r"knoworigin-shell-v(\d+)", sw)
    check("service-worker 的 CACHE_NAME 版本 ≥ v120（index.html 在预缓存清单里）",
          bool(_m) and int(_m.group(1)) >= 120,
          _m.group(0) if _m else "CACHE_NAME 未找到")


def main() -> int:
    part_http()
    part_browser()
    part_wiring()
    print(f"\nPASS {PASS} / FAIL {FAIL}")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
