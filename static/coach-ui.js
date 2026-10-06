/**
 * 知源 · 陪练台（这一轮该做什么 / 提示该给到哪一步 / 你准不准）
 *
 * ## 这个面板存在的理由
 *
 * 项目自己引用了 Bastani et al., PNAS 2025：无护栏的 GPT-4 让练习时成绩 +48%，
 * 撤掉 AI 后考场上 **-17%**；带护栏的 GPT Tutor 练习时 +127%，考场上回到对照组。
 * 护栏就是「别直接给答案，给提示」。
 *
 * 但那条护栏只做在了 guided 一档上。默认档位是 direct，`_MOVE_PLANS` 里只有
 * `guided` 一个键，所以 direct 下 `scaffold_block` 直接返回空串；全仓唯一把
 * 掌握度接进提示词的地方是 `api_server.py` 里那个单向的 `weak_flag`
 * （`mastery_score < 0.3`），**只会「多给一点」，永远不会「少给一点」**。
 * 于是「稳了」的节点照样被逐题喂完整答案 —— Kalyuga et al. (2003) 的专业知识
 * 反转效应：冗余支架对已有图式的人从帮助变成干扰，而用户只会觉得「它啰嗦半天」。
 *
 * 这里把那条单向的布尔值换成一条**五档、往上往下都会走**的梯子，并且把
 * 「撤掉支架的资格」显式摆出来（`can_withdraw` / `withhold_reason`）——
 * 支架不是设置项，是一条由证据决定松紧的线。
 *
 * 第二块「校准回执」用的是 `learning_events.self_confidence` 那一列。项目一直在存、
 * `progress_engine` 也用它做单点判据（答错 + 自评确定 → repair 桶），但从来没
 * 聚合成用户看得懂的结论。这里聚合成一句，并**按方向给不同建议** ——
 * Double et al. (2025) 的 CHI 那项研究里，校准训练只对初始过度自信者有效，
 * 对过度谨慎者无效，所以两者不能共用一套话术。
 *
 * ## 三条不肯让步的口径
 *
 * 1. **不新增逐题自评。** Double et al. (2025, N=710) 显示逐题问 confidence 会
 *    损害规则学习与迁移。什么时候值得再问一次，由后端 `calibration.probe()` 决定
 *    （只在准确率落在中间带时），本面板只负责把那个决定显示出来。
 * 2. **界面不出现分数。** BKT 只用来给颜色分档，不做数值展示；与
 *    `progress-panel.js` 的「用位阶代替分数」同一立场。
 * 3. **只给时间，不给件数。** 「你还有 47 张卡片待复习」把外部压力和**能力评价**
 *    耦在一起，是自我决定理论里典型的不合意压力。所以时间盒给分钟数，
 *    到期卡片数只用来决定休息插几次，不进界面。
 *
 * ## 排版约定
 *
 * 字号一律走 `styles.css` 的 `--text-*` 阶梯，**不写死 px** —— 否则设置里的
 * 「字体大小」（`--font-scale`）作用不到本面板。颜色只用主题变量，不写死色值。
 *
 * ## 落点与回退
 *
 * 按 progress-panel / transfer-ui 的同一范式：挂进「学习概览」的
 * `.studio-output .overview-dashboard`，追加一张 `.overview-panel` 卡片。
 * 不改 app.js / styles.css；删掉 index.html 里那一行 script 即整体回退。
 */
(function () {
  "use strict";

  var STYLE_ID = "ko-coach-style";
  var EMBED_ATTR = "data-ko-coach-embed";
  var API_ROOT = "/api/coach";
  var DASH_SELECTOR = "#studio-output .overview-dashboard";

  var PREF_KEY = "knoworigin-coach-prefs-v1";
  var ATTEMPT_KEY = "knoworigin-coach-attempts-v1";

  // 五档梯子，与 core/scaffold.py 的 SCAFFOLD_LADDER 同序。这里必须抄一份：
  // 本面板要在**还没拿到响应**时就先把五个刻度画出来，而那时没有后端可问。
  var LADDER = ["full", "faded", "outline", "hint", "silent"];

  var VERDICT_TONE = {
    overconfident: "warn",
    underconfident: "info",
    aligned: "ok",
    thin: "muted",
  };

  // 变量名不能叫 state —— 那是 app.js 顶层的 const，IIFE 里会遮蔽它。
  var view = {
    projectId: "",
    round: null,
    loading: false,
    loaded: false,
    error: "",
    // MutationObserver 的防抖闸。必须在这里声明而不是临时挂在 view 上：
    // scheduleMount 被同一个 view 的所有挂载路径共用，字段没声明就只有
    // 第一次是 undefined，第二次才变成 true —— 防抖会漏掉中间那几次。
    pending: false,
    // 渲染 diff 用的两份快照，见 render()。
    lastCard: null,
    lastMarkup: "",
  };

  // ── 设置 ────────────────────────────────────────────

  function readPrefs() {
    try {
      var raw = window.localStorage.getItem(PREF_KEY);
      if (!raw) return { enabled: true };
      var parsed = JSON.parse(raw);
      return { enabled: parsed.enabled !== false };
    } catch (error) {
      return { enabled: true };
    }
  }

  function writePrefs(prefs) {
    try {
      window.localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
    } catch (error) {
      /* 隐私模式下写不进去就算了，面板按默认值继续用 */
    }
  }

  function prefs() {
    return readPrefs();
  }

  // ── 基础设施 ────────────────────────────────────────────

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function currentProjectId() {
    // 必须 try/catch：app.js 是 classic script，与本文件共享全局词法环境；
    // 拿不到就当作没有项目，不能让整个面板崩掉。
    try {
      if (typeof state !== "undefined" && state && state.currentProjectId) {
        return String(state.currentProjectId);
      }
    } catch (error) {
      /* 拿不到就当没有项目 */
    }
    return "";
  }

  function isAuthenticated() {
    try {
      if (typeof state !== "undefined" && state && state.authenticated) return true;
    } catch (error) {
      /* 取不到就当未登录 */
    }
    return false;
  }

  function call(path, options) {
    var opts = options || {};
    var init = { method: opts.method || "GET" };
    if (opts.body !== undefined && opts.body !== null) {
      init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
      init.headers = { "Content-Type": "application/json" };
    }
    if (typeof api === "function") return api(path, init);
    return fetch(path, Object.assign({ credentials: "same-origin" }, init)).then(function (response) {
      return response.json().catch(function () {
        return {};
      });
    });
  }

  function syncSettingsUI() {
    var toggle = document.querySelector("#settings-coach-toggle");
    if (toggle) toggle.checked = prefs().enabled;
  }

  // ── 样式 ────────────────────────────────────────────

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = [
      "#studio-output .ko-coach-panel { display: grid; gap: 14px; }",
      ".ko-coach-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }",
      ".ko-coach-head > span { flex: 0 1 auto; max-width: 100%; }",
      ".ko-coach-title { font-weight: 800; color: var(--ink); }",
      // 警示 / 中性两档的 RGB 元组集中在这里定义，别散落成十六进制或散字面量。
      // styles.css 只导出了 --green-rgb，没有对应的 --gold-rgb（progress-panel.js
      // 里也是直接写字面量），所以这里自己声明一份并允许主题覆盖。
      "#studio-output .ko-coach-panel { --ko-warn-rgb: 214, 164, 61; --ko-note-rgb: 120, 170, 220; }",
      ".ko-coach-block { display: grid; gap: 8px; padding: 12px 14px;",
      "  border: 1px solid var(--line); border-radius: 12px; background: var(--panel); color: var(--ink); }",
      // 校准结论按方向上色：只有「高估自己」是警示色。
      // 低估刻意**不**上警示色 —— 它不是缺陷，用户不需要被提醒去「修」它，
      // 而是真的比他自己以为的强，文案里说清就够（见 calibration.VERDICT_ADVICE）。
      ".ko-coach-block.is-warn { border-color: rgba(var(--ko-warn-rgb), 0.55);",
      "  background: rgba(var(--ko-warn-rgb), 0.06); }",
      ".ko-coach-block.is-ok { border-color: rgba(var(--green-rgb), 0.4); }",
      ".ko-coach-block.is-info { border-color: rgba(var(--ko-note-rgb), 0.45); }",
      ".ko-coach-block.is-muted { opacity: 0.92; }",
      ".ko-coach-block-h { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }",
      ".ko-coach-block-h b { font-weight: 800; }",
      ".ko-coach-hint { color: var(--muted); font-size: var(--text-sm); line-height: 1.6; }",
      ".ko-coach-time { font-size: var(--text-base); color: var(--ink); }",
      ".ko-coach-ladder { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }",
      ".ko-coach-pip { padding: 3px 8px; border-radius: 999px; border: 1px solid var(--line);",
      "  color: var(--muted); font-size: var(--text-sm); background: transparent; }",
      ".ko-coach-pip.is-on { border-color: rgba(var(--green-rgb), 0.6); color: var(--green);",
      "  font-weight: 800; background: rgba(var(--green-rgb), 0.08); }",
      ".ko-coach-what { font-size: var(--text-base); line-height: 1.65; }",
      ".ko-coach-why { margin: 0; padding-left: 18px; color: var(--muted);",
      "  font-size: var(--text-sm); line-height: 1.7; }",
      ".ko-coach-why li { margin: 2px 0; }",
      ".ko-coach-next { font-size: var(--text-sm); color: var(--muted); line-height: 1.6; }",
      ".ko-coach-ev { display: grid; gap: 6px; }",
      ".ko-coach-ev-row { padding: 8px 10px; border-left: 3px solid rgba(var(--ko-warn-rgb), 0.7);",
      "  border-radius: 8px; background: rgba(var(--ko-warn-rgb), 0.07);",
      "  font-size: var(--text-sm); color: var(--ink); line-height: 1.6; }",
      ".ko-coach-probe { padding: 10px 12px; border-radius: 10px;",
      "  border: 1px solid rgba(var(--green-rgb), 0.45); background: rgba(var(--green-rgb), 0.07);",
      "  font-size: var(--text-sm); color: var(--ink); line-height: 1.65; }",
      ".ko-coach-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }",
      ".ko-coach-btn { padding: 7px 13px; border-radius: 9px; cursor: pointer;",
      "  border: 1px solid rgba(var(--green-rgb), 0.55); background: rgba(var(--green-rgb), 0.1);",
      "  color: var(--green); font-size: var(--text-sm); font-weight: 700; }",
      ".ko-coach-btn:hover { background: rgba(var(--green-rgb), 0.18); }",
      ".ko-coach-btn:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }",
      ".ko-coach-btn.is-quiet { border-color: var(--line); background: transparent; color: var(--muted);",
      "  font-weight: 600; }",
      ".ko-coach-btn.is-quiet:hover { color: var(--ink); }",
      // 「先说给自己听」的门：写完才放开材料。
      ".ko-coach-gate { display: grid; gap: 8px; padding: 11px 12px; border-radius: 10px;",
      "  border: 1px dashed rgba(var(--green-rgb), 0.5); background: rgba(var(--green-rgb), 0.05); }",
      ".ko-coach-gate textarea { width: 100%; min-height: 74px; resize: vertical;",
      "  padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line);",
      "  background: var(--panel); color: var(--ink); font-size: var(--text-base);",
      "  font-family: inherit; line-height: 1.6; }",
      ".ko-coach-gate textarea:focus-visible { outline: 2px solid var(--green); outline-offset: 1px; }",
      ".ko-coach-reveal { white-space: pre-wrap; font-size: var(--text-sm); line-height: 1.7;",
      "  color: var(--ink); padding: 10px 12px; border-radius: 8px;",
      "  border: 1px solid var(--line); background: var(--panel); }",
      ".ko-coach-steps { display: grid; gap: 7px; }",
      ".ko-coach-step { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;",
      "  padding: 9px 11px; border: 1px solid var(--line); border-radius: 10px;",
      "  background: var(--panel); color: var(--ink); cursor: pointer; font-size: var(--text-sm); }",
      ".ko-coach-step:hover { border-color: rgba(var(--green-rgb), 0.55); }",
      ".ko-coach-step:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }",
      ".ko-coach-step-name { font-weight: 700; flex: 1 1 auto; min-width: 0; }",
      ".ko-coach-pill { padding: 2px 8px; border-radius: 999px; font-size: var(--text-sm);",
      "  border: 1px solid var(--line); color: var(--muted); }",
      ".ko-coach-empty { padding: 16px 14px; font-size: var(--text-base);",
      "  color: var(--muted); line-height: 1.7; text-align: center; }",
    ].join("\n");
    document.head.appendChild(el);
  }

  // ── 标记 ────────────────────────────────────────────

  // 先说给自己听的记录按「项目 + 节点」存，这样换项目不会串。
  function readAttempts() {
    try {
      var raw = window.localStorage.getItem(ATTEMPT_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      return {};
    }
  }

  function recordAttempt(nodeId, text) {
    var all = readAttempts();
    all[nodeId] = { at: Date.now(), text: String(text || "") };
    try {
      window.localStorage.setItem(ATTEMPT_KEY, JSON.stringify(all));
    } catch (error) {
      /* 写不进去不影响这一轮练习本身 */
    }
  }

  function attemptFor(nodeId) {
    var hit = readAttempts()[nodeId];
    return hit && hit.text ? hit : null;
  }

  function clearAttempt(nodeId) {
    var all = readAttempts();
    delete all[nodeId];
    try {
      window.localStorage.setItem(ATTEMPT_KEY, JSON.stringify(all));
    } catch (error) {
      /* 同上 */
    }
  }

  // ── 渲染 ────────────────────────────────────────────

  function ladderMarkup(scaffoldInfo, ladderLabels) {
    var labels = ladderLabels || {};
    var current = String((scaffoldInfo && scaffoldInfo.level) || "");
    var index = LADDER.indexOf(current);
    return (
      '<div class="ko-coach-ladder">' +
      LADDER.map(function (key, i) {
        var cls = "ko-coach-pip" + (i === index ? " is-on" : "");
        // 每一档都要有名字可读：用户要能看懂自己落在哪一格，而不只是「第 4 格」。
        return '<span class="' + cls + '">' + esc(labels[key] || key) + "</span>";
      }).join("") +
      "</div>"
    );
  }

  function scaffoldMarkup(scaffoldInfo) {
    if (!scaffoldInfo || scaffoldInfo.available === false) {
      var why = (scaffoldInfo && scaffoldInfo.reason) || "还没有这个知识点的学习记录";
      return (
        '<div class="ko-coach-block">' +
        '<div class="ko-coach-block-h"><b>提示该给到哪一步</b></div>' +
        '<div class="ko-coach-hint">' + esc(why) + "</div>" +
        "</div>"
      );
    }

    var reasons = (scaffoldInfo.reasons || []).map(function (line) {
      return "<li>" + esc(line) + "</li>";
    });
    var withhold = "";
    if (scaffoldInfo.can_withdraw && scaffoldInfo.next_label) {
      withhold =
        "再往前一档是「" + esc(scaffoldInfo.next_label) + "」—— 你现在的证据够格撤。";
    } else if (scaffoldInfo.withhold_reason) {
      withhold = esc(scaffoldInfo.withhold_reason);
    }

    return (
      '<div class="ko-coach-block">' +
      '<div class="ko-coach-block-h">' +
      "<b>提示该给到哪一步</b>" +
      '<span class="ko-coach-pill">' + esc(scaffoldInfo.stage_label || "") + "</span>" +
      "</div>" +
      ladderMarkup(scaffoldInfo) +
      '<div class="ko-coach-what">' + esc(scaffoldInfo.what || "") + "</div>" +
      (reasons.length ? '<ul class="ko-coach-why">' + reasons.join("") + "</ul>" : "") +
      (withhold ? '<div class="ko-coach-next">' + withhold + "</div>" : "") +
      (scaffoldInfo.prompt_block
        ? '<details class="ko-coach-next"><summary>看这一档具体怎么要求 AI</summary>' +
          '<div class="ko-coach-reveal">' + esc(scaffoldInfo.prompt_block) + "</div></details>"
        : "") +
      "</div>"
    );
  }

  function gateMarkup(scaffoldInfo, nodeId) {
    // 「先说给自己听」只在**支架还比较足**的时候要求。
    // 理由：生成效应/自我解释在弱支撑条件下才有东西可解释；等到 full 这种
    // 「整条步骤都给你」的一档，要求用户先说等于凭空造摩擦，而那时他们确实需要
    // 先跟一遍 —— 所以这扇门只开在 faded / outline / hint 三档。
    var level = String((scaffoldInfo && scaffoldInfo.level) || "");
    var needsGate = level === "faded" || level === "outline" || level === "hint";
    if (!needsGate) return "";

    var saved = attemptFor(nodeId);
    if (saved) {
      return (
        '<div class="ko-coach-gate">' +
        '<div class="ko-coach-hint">你上一轮先说给自己听的内容（可以改，改完再对）：</div>' +
        '<textarea data-ko-coach-attempt="' + esc(nodeId) + '">' + esc(saved.text) + "</textarea>" +
        '<div class="ko-coach-actions">' +
        '<button type="button" class="ko-coach-btn" data-ko-coach-reveal>看看材料</button>' +
        '<button type="button" class="ko-coach-btn is-quiet" data-ko-coach-forget>清空</button>' +
        "</div>" +
        '<div class="ko-coach-reveal" data-ko-coach-reveal-box hidden></div>' +
        "</div>"
      );
    }

    return (
      '<div class="ko-coach-gate">' +
      '<div class="ko-coach-hint">先说给自己听：不用查材料，凭印象把「' +
      esc((scaffoldInfo && scaffoldInfo.node_name) || "") +
      '」讲一遍。写完再看材料 —— 差距才是你真正缺的那一块。</div>' +
      '<textarea data-ko-coach-attempt="' + esc(nodeId) + '" placeholder="说不出来也是有效信息，那说明它现在真的不会。"></textarea>' +
      '<div class="ko-coach-actions">' +
      '<button type="button" class="ko-coach-btn" data-ko-coach-reveal>写完了，看材料</button>' +
      '<button type="button" class="ko-coach-btn is-quiet" data-ko-coach-skip>先不看，直接去练</button>' +
      "</div>" +
      '<div class="ko-coach-reveal" data-ko-coach-reveal-box hidden></div>' +
      "</div>"
    );
  }

  function calibrationMarkup(cal) {
    var info = cal || {};
    var verdict = String(info.verdict || "thin");
    var tone = VERDICT_TONE[verdict] || "muted";

    var head =
      '<div class="ko-coach-block-h"><b>你准不准</b>' +
      '<span class="ko-coach-pill">' + esc(info.verdict_label || "") + "</span>" +
      "</div>";

    var sampleNote = "";
    if (verdict === "thin") {
      var need = Math.max(0, Number(info.min_samples || 8) - Number(info.samples || 0));
      sampleNote =
        '<div class="ko-coach-hint">还差 ' + esc(need) + " 条带把握度的作答。" +
        "够之前这里不会给结论 —— 三次作答编一个「你高估自己」出来是误导。</div>";
    }

    var probe = info.probe || {};
    var probeMarkup = probe.ask
      ? '<div class="ko-coach-probe"><b>这一轮先猜一次</b><br>' + esc(probe.reason || "") + "</div>"
      : "";

    var evidence = (info.evidence || []).slice(0, 4).map(function (item) {
      return (
        '<div class="ko-coach-ev-row">' +
        esc(item.node_name || item.node_id || "") +
        " · " + esc(item.why || "") +
        "</div>"
      );
    });

    return (
      '<div class="ko-coach-block is-' + esc(tone) + '">' + head +
      (info.advice ? '<div class="ko-coach-what">' + esc(info.advice) + "</div>" : "") +
      sampleNote +
      probeMarkup +
      (evidence.length ? '<div class="ko-coach-ev">' + evidence.join("") + "</div>" : "") +
      "</div>"
    );
  }

  function stepsMarkup(round) {
    var steps = (round && round.steps) || [];
    if (!steps.length) {
      return (
        '<div class="ko-coach-block"><div class="ko-coach-empty">' +
        "这一轮没有可推的节点 —— 可能前置还没到「会了」，也可能资料还没覆盖到。<br>" +
        "先导入资料或补一条学习记录，这里就会有下一步。" +
        "</div></div>"
      );
    }
    var rows = steps.map(function (item) {
      var action = String(item.action || "open-node");
      var label = String((item.bucket_label || "继续"));
      return (
        '<div class="ko-coach-step" role="button" tabindex="0"' +
        ' data-ko-coach-step="' + esc(item.node_id || "") + '"' +
        ' data-ko-coach-action="' + esc(action) + '">' +
        '<span class="ko-coach-step-name">' + esc(item.name || "") + "</span>" +
        '<span class="ko-coach-pill">' + esc(label) + "</span>" +
        '<span class="ko-coach-pill">' + esc(item.stage_label || "") + "</span>" +
        "</div>"
      );
    });
    return (
      '<div class="ko-coach-block">' +
      '<div class="ko-coach-block-h"><b>这一轮</b></div>' +
      '<div class="ko-coach-steps">' + rows.join("") + "</div>" +
      "</div>"
    );
  }

  function cardMarkup() {
    var round = view.round;
    var shape = (round && round.shape) || {};
    var scaffoldInfo = (round && round.scaffold) || null;
    var focusId = (round && round.focus && round.focus.node_id) || "";

    var timeLine = shape.phrasing
      ? '<div class="ko-coach-time">' + esc(shape.phrasing) +
        (shape.due_card_hint ? ' · <span class="ko-coach-hint">' + esc(shape.due_card_hint) + "</span>" : "") +
        (shape.overrun_note ? '<div class="ko-coach-hint">' + esc(shape.overrun_note) + "</div>" : "") +
        "</div>"
      : "";

    return (
      '<div class="ko-coach-panel">' +
      '<div class="ko-coach-head">' +
      '<span class="ko-coach-title">陪练台</span>' +
      '<span class="ko-coach-pill">' + esc(view.loading ? "正在看这一轮" : "按证据给提示") + "</span>" +
      "</div>" +
      (view.error ? '<div class="ko-coach-hint">' + esc(view.error) + "</div>" : "") +
      stepsMarkup(round) +
      timeLine +
      scaffoldMarkup(scaffoldInfo) +
      (focusId ? gateMarkup(scaffoldInfo, focusId) : "") +
      calibrationMarkup((round && round.calibration) || {}) +
      '<div class="ko-coach-actions">' +
      '<button type="button" class="ko-coach-btn" data-ko-coach-go>去做这一步</button>' +
      '<button type="button" class="ko-coach-btn is-quiet" data-ko-coach-refresh>重新看一轮</button>' +
      "</div>" +
      "</div>"
    );
  }

  function ensureCard() {
    var dash = document.querySelector(DASH_SELECTOR);
    if (!dash) return null;
    var card = document.querySelector("[" + EMBED_ATTR + "]");
    if (card && dash.contains(card)) return card;
    card = document.createElement("section");
    card.className = "overview-panel ko-coach-panel-host";
    card.setAttribute(EMBED_ATTR, "1");
    dash.appendChild(card);
    return card;
  }

  function render() {
    var card = ensureCard();
    if (!card) return false;
    // 渲染前先 diff：无条件 innerHTML= 会自触发下面的 MutationObserver，
    // 形成「写一次 → 120ms 后 mount → 再写」的重绘循环，按钮在 mousedown 和
    // click 之间被整个换掉，click 永远落空（progress-panel.js 同款坑）。
    // 元素本体也要一起比：app.js 冲掉 #studio-output 后 ensureCard 建的是新空卡，
    // 只比字符串会误判「内容没变」而把空卡留在页面上。
    var markup = cardMarkup();
    if (view.lastCard === card && view.lastMarkup === markup) return true;
    view.lastCard = card;
    view.lastMarkup = markup;
    card.innerHTML = markup;
    return true;
  }

  // ── 数据 ────────────────────────────────────────────

  function syncProject() {
    var projectId = currentProjectId();
    if (view.loaded && view.projectId === projectId) return;
    view.projectId = projectId;
    view.loaded = false;
    view.error = "";
    view.round = null;
    render();
    load();
  }

  function load(force) {
    if (view.loading) return Promise.resolve();
    var projectId = view.projectId || currentProjectId();
    if (!projectId || !prefs().enabled) {
      view.loaded = true;
      view.round = null;
      render();
      return Promise.resolve();
    }
    view.loading = true;
    if (force) {
      view.error = "";
      render();
    }
    return call(API_ROOT + "/" + encodeURIComponent(projectId) + "/round")
      .then(function (data) {
        view.round = data && typeof data === "object" ? data : null;
        view.loaded = true;
      })
      .catch(function (error) {
        // 拿不到就明说，不要假装这一轮是空的 —— 空计划和读失败长得一样，
        // 而用户会以为「今天没事干」，那比报错更糟。
        view.error = (error && error.message) || "没能看到这一轮，请稍后重试。";
        view.round = null;
        view.loaded = true;
      })
      .finally(function () {
        view.loading = false;
        render();
      });
  }

  // ── 交互 ────────────────────────────────────────────

  function goFocus() {
    var round = view.round;
    var focusId = round && round.focus && round.focus.node_id;
    var steps = (round && round.steps) || [];
    var target = "";
    var action = "open-node";
    for (var i = 0; i < steps.length; i += 1) {
      if (steps[i].node_id === focusId) {
        target = steps[i].node_id;
        action = String(steps[i].action || "open-node");
        break;
      }
    }
    if (!target) {
      view.error = "这一轮还没有可做的节点。";
      render();
      return;
    }
    navigate(target, action);
  }

  function navigate(nodeId, action) {
    // 迁移桶由 transfer-ui.js 自己接管（window.KnowOriginTransfer），
    // 没加载时回落到框架页 —— 不点没反应比报错好，与 progress-panel 一致。
    if (action === "open-transfer" && window.KnowOriginTransfer) {
      try {
        window.KnowOriginTransfer.open(nodeId);
        return;
      } catch (error) {
        /* 回落到框架页 */
      }
    }
    try {
      if (typeof switchFeature === "function") {
        if (action === "open-cards") switchFeature("cards");
        else switchFeature("framework");
      }
    } catch (error) {
      /* 切不过去时用户手动点页签也一样 */
    }
  }

  function onKey(event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    var target = event.target;
    if (!target || typeof target.closest !== "function") return;
    var step = target.closest("[data-ko-coach-step]");
    if (!step) return;
    event.preventDefault();
    step.click();
  }

  function handleClick(event) {
    var target = event.target;
    if (!target || typeof target.closest !== "function") return;

    if (target.closest("[data-ko-coach-refresh]")) {
      view.loaded = false;
      render();
      load(true);
      return;
    }

    if (target.closest("[data-ko-coach-go]")) {
      goFocus();
      return;
    }

    var step = target.closest("[data-ko-coach-step]");
    if (step) {
      navigate(step.dataset.koCoachStep, step.dataset.koCoachAction);
      return;
    }

    var gate = target.closest(".ko-coach-gate");

    if (target.closest("[data-ko-coach-reveal]")) {
      if (!gate) return;
      var textarea = gate.querySelector("[data-ko-coach-attempt]");
      var nodeId = textarea ? textarea.dataset.koCoachAttempt : "";
      if (textarea) recordAttempt(nodeId, textarea.value);
      var promptBlock =
        (view.round && view.round.scaffold && view.round.scaffold.prompt_block) || "";
      var box = gate.querySelector("[data-ko-coach-reveal-box]");
      if (box) {
        box.textContent = promptBlock || "（这一档没有额外的材料限制，直接去做这一步。）";
        box.hidden = false;
      }
      return;
    }

    if (target.closest("[data-ko-coach-forget]")) {
      if (!gate) return;
      var field = gate.querySelector("[data-ko-coach-attempt]");
      var id = field ? field.dataset.koCoachAttempt : "";
      clearAttempt(id);
      view.lastMarkup = "";
      render();
      return;
    }

    if (target.closest("[data-ko-coach-skip]")) {
      if (!gate) return;
      var area = gate.querySelector("[data-ko-coach-attempt]");
      var nodeId2 = area ? area.dataset.koCoachAttempt : "";
      goFocus();
      if (nodeId2) clearAttempt(nodeId2);
      return;
    }
  }

  // ── 挂载 ────────────────────────────────────────────

  function mount() {
    if (!isAuthenticated()) return false;
    if (!prefs().enabled) {
      // 用户关掉了就把已挂的卡片收掉，而不是留一张空壳。
      var stale = document.querySelector("[" + EMBED_ATTR + "]");
      if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
      view.lastCard = null;
      view.lastMarkup = "";
      return false;
    }
    ensureStyle();
    if (!render()) return false;
    // 必须无条件调：syncProject() 内部先比对 projectId，同一项目会立刻返回，
    // 而一旦用「已挂载就跳过」的写法，**切换项目就不会再取数**了 ——
    // 面板会一直显示上一个项目的一轮。progress-panel.js 是同一个写法。
    syncProject();
    return true;
  }

  function scheduleMount() {
    if (view.pending) return;
    view.pending = true;
    setTimeout(function () {
      view.pending = false;
      mount();
    }, 140);
  }

  function bind() {
    document.addEventListener("click", handleClick);
    document.addEventListener("keydown", onKey);
    // 设置里的开关：本文件自己绑，不进 app.js 的 setupSettings（既有范式，
    // 与 agent-shell.js 绑「试试这样问」同款）。
    var toggle = document.querySelector("#settings-coach-toggle");
    if (toggle && toggle.getAttribute("data-ko-coach-bound") !== "1") {
      toggle.setAttribute("data-ko-coach-bound", "1");
      toggle.addEventListener("change", function (event) {
        var next = { enabled: Boolean(event.target.checked) };
        writePrefs(next);
        view.loaded = false;
        view.round = null;
        view.lastCard = null;
        view.lastMarkup = "";
        mount();
        if (next.enabled) load(true);
        syncSettingsUI();
      });
    }
    // 概览页重建有两条触发：用户点「学习概览」页签，以及项目切换 / 数据刷新后
    // app.js 自己重绘。用点击监听做到即时，用 DOM 观察兜底。两条都调幂等的 mount。
    var grid = document.querySelector(".feature-grid");
    if (grid && grid.getAttribute("data-ko-coach-nav") !== "1") {
      grid.setAttribute("data-ko-coach-nav", "1");
      grid.addEventListener("click", function (event) {
        var button = event.target.closest && event.target.closest(".feature-button");
        if (!button) return;
        if (button.dataset.feature === "overview") setTimeout(mount, 0);
      });
    }
    if (typeof MutationObserver === "function" && document.body) {
      new MutationObserver(scheduleMount).observe(document.body, {
        childList: true,
        subtree: true,
      });
    }
    syncSettingsUI();
    mount();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }

  // 登录后 app.js 才渲染出概览区，启动时可能还没有，稍后再试几次。
  document.addEventListener("DOMContentLoaded", function () {
    setTimeout(mount, 600);
  });
  setTimeout(mount, 2000);

  window.KnowOriginCoach = {
    mount: mount,
    refresh: function () {
      return load(true);
    },
    prefs: prefs,
    setEnabled: function (enabled) {
      writePrefs({ enabled: Boolean(enabled) });
      view.loaded = false;
      view.round = null;
      view.lastCard = null;
      view.lastMarkup = "";
      mount();
      syncSettingsUI();
    },
    round: function () {
      return view.round;
    },
  };
})();