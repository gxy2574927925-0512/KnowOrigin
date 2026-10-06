/**
 * 知源 · 进步面板
 *
 * 把 core/progress_engine.py 的结果渲染成「学习概览」里的一张卡片。
 *
 * ## 设计立场（与后端一致）
 *
 * **这个面板上没有任何分数、百分比、掌握度数字。** 用户要的是「在这个项目里持续往前走」，
 * 不是再多一个要自己去看、去算的指标。所以卡片上只有：
 *
 *   - 四档位阶的词：未开始 / 见过 / 会了 / 稳了
 *   - 「往前挪了几格」（本周升阶数、新解锁数）—— 位置变化，不是数值变化
 *   - 每件事**为什么是它**（一句人话理由）
 *
 * BKT 藏在后端当闸门（区分「猜对」和「真会」），完全不在这条链路上出现。
 *
 * ## 落点
 *
 * 按 knoworigin-addon-panel 技能的定案：状态 / 统计类功能融进「学习概览」，
 * 往 `.studio-output .overview-dashboard` 追加一张 `.overview-panel` 卡片。
 * 不改 app.js / styles.css；`.studio-output` 本身就是 overflow-y:auto，所以不需要覆盖层。
 * 删掉 index.html 里的那一行 script 即整体回退。
 */
(function () {
  "use strict";

  var EMBED_ATTR = "data-ko-pg-embed";
  var STYLE_ID = "ko-pg-style";
  var CARD_CLASS = "ko-pg-panel";

  var STAGES = ["none", "seen", "get", "hold"];
  var STAGE_LABELS = { none: "未开始", seen: "见过", get: "会了", hold: "稳了" };
  var STAGE_CLIMB = { none: 0, seen: 1, get: 2, hold: 3 };

  // 每个桶的**主动作**。推荐不该只是「能看」——点按钮就得真做点什么：
  // 练习类直接对该节点出题并跳进测验页，学习类跳进知识框架，复习类进卡片页。
  // 交互属性用 data-ko-pg-act（不叫 data-overview-action）：那名字会被 app.js 的
  // 全局委托接管成只读弹窗，而这里要的是「做」。
  var STEP_ACTIONS = {
    repair: { act: "quiz", label: "出题重练" },
    push: { act: "quiz", label: "出题重练" },
    start: { act: "learn", label: "开始学" },
    unlock: { act: "learn", label: "开始学" },
    explore: { act: "learn", label: "去看看" },
    fill: { act: "study-plan", label: "看还缺什么" },
    review: { act: "cards", label: "去复习卡片" },
    // 迁移桶（core/progress_engine 的 BUCKET_ORDER 新增）：会了但不迁移。
    // 它的主动作**不是**再出几道题，而是开「换个情境试试」。
    // transfer-ui.js 尚未加载时回落到 detail（不点没反应比报错好）。
    transfer: { act: "transfer", label: "换个情境" },
  };

  // 注意：变量名不能叫 state —— 那是 app.js 顶层的 const，IIFE 里会遮蔽它。
  var view = { projectId: null, plan: null, digest: null, loading: false, error: "" };

  // 「看还缺什么」的进行中请求（跨弹窗实例共享）。关闭弹窗**不中断**这个请求——
  // 生成在后台继续、完成即落缓存；同一节点正在生成时再打开，直接复用同一个 promise，
  // 不重复发第二次 LLM 调用。结构：{ nodeId: string, promise: Promise }。
  var planInFlight = null;

  // ── 基础设施 ────────────────────────────────────────

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = [
      "#studio-output .ko-pg-panel { display: grid; gap: 13px; }",
      // 概览卡片的标题行是 display:flex + 不换行，右侧状态胶囊 flex:0 0 auto。
      // 窄到 278px（工作台折叠态）时胶囊会把左侧文字列挤成「一字一行」——
      // 真机实测过一次。所以自己的标题行必须允许换行，胶囊也跟着让位。
      ".ko-pg-head { flex-wrap: wrap; align-items: center; }",
      ".ko-pg-head > span { flex: 0 1 auto; max-width: 100%; }",
      ".ko-pg-steps { display: grid; gap: 10px; }",
      // 卡片左缘 3px 色条 = 桶的语义色（repair 琥珀 = 要修的错，其余绿 = 往前走）。
      ".ko-pg-step { position: relative; display: grid; gap: 7px; padding: 12px 14px;",
      "  border: 1px solid var(--line); border-left: 3px solid rgba(var(--green-rgb), 0.55);",
      "  border-radius: 12px; background: var(--panel); color: var(--ink); cursor: pointer;",
      "  transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease; }",
      ".ko-pg-step:hover { border-color: rgba(var(--green-rgb), 0.55);",
      "  box-shadow: 0 4px 14px rgba(var(--green-dark-rgb), 0.12); transform: translateY(-1px); }",
      ".ko-pg-step:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }",
      ".ko-pg-step.is-repair { border-left-color: rgba(214, 164, 61, 0.75); }",
      ".ko-pg-step-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }",
      ".ko-pg-rank { flex: 0 0 auto; width: 20px; height: 20px; border-radius: 50%;",
      "  border: 1px solid var(--line); display: grid; place-items: center;",
      "  color: var(--muted); font-size: calc(11px * var(--font-scale, 1)); font-weight: 700; }",
      ".ko-pg-bucket { flex: 0 0 auto; padding: 2px 10px; border-radius: 999px;",
      "  font-size: calc(11px * var(--font-scale, 1)); font-weight: 700;",
      // 与既有 .overview-section-heading > span 同款：--green-dark 在深色下自动变亮绿
      // （#a6d793），配深色 --green-soft（#22351e）就是亮字压深底。
      // ⚠️ 别在这里补深色文字 —— 那套是给「--green 作实心填充」用的，
      // --green-soft 在深色下是深绿，补深字会变成深字压深底（真机实测对比度 1.43）。
      "  color: var(--green-dark); background: var(--green-soft); }",
      // repair 桶换琥珀装束；浅色底用深琥珀字（≈4.7:1），深色主题翻亮金字。
      ".ko-pg-step.is-repair .ko-pg-bucket { color: #8a6516; background: rgba(214, 164, 61, 0.14); }",
      "html[data-theme='dark'] .ko-pg-panel .ko-pg-step.is-repair .ko-pg-bucket { color: #e3b95c; }",
      ".ko-pg-name { font-weight: 800; font-size: calc(13.5px * var(--font-scale, 1)); }",
      ".ko-pg-reason { margin: 0; color: var(--muted); font-size: calc(12px * var(--font-scale, 1)); line-height: 1.55; }",
      ".ko-pg-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;",
      "  color: var(--muted); font-size: calc(12px * var(--font-scale, 1)); }",
      ".ko-pg-track { display: inline-flex; gap: 3px; }",
      // 未达的格子不能直接用 --line：深色下 --line(#2b332a) 与 --panel(#161b17) 几乎同色，
      // 步进器会整条消失、看起来像一条分隔线。用品牌色的低透明底，两端都看得见。
      ".ko-pg-track i { display: block; width: 18px; height: 8px; border-radius: 999px;",
      "  background: rgba(var(--green-rgb), 0.18); }",
      ".ko-pg-track i.is-on { background: var(--green); }",
      // 动作按钮：主按钮（出题重练/开始学）绿胶囊，次按钮（看那道错题）透明胶囊。
      ".ko-pg-acts { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 2px; }",
      ".ko-pg-acts .mini-button { border-radius: 999px; padding: 4px 14px; font-weight: 600;",
      "  background: transparent; white-space: nowrap;",
      "  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease; }",
      ".ko-pg-acts .mini-button:hover { background: var(--green-soft);",
      "  border-color: rgba(var(--green-rgb), 0.5); color: var(--green-dark); }",
      ".ko-pg-acts .mini-button.is-primary { background: var(--green-soft);",
      "  border-color: rgba(var(--green-rgb), 0.45); color: var(--green-dark); }",
      // 悬浮加深用 --green-dark（浅色主题是深绿，白字 ≈4.9:1）；深色主题里它翻成
      // 亮绿，白字会看不清，翻回深字（本文件不出现 #fff 字面量，主题安全测试盯着）。
      ".ko-pg-acts .mini-button.is-primary:hover { background: var(--green-dark);",
      "  border-color: var(--green-dark); color: white; }",
      "html[data-theme='dark'] .ko-pg-panel .ko-pg-acts .mini-button.is-primary:hover { color: #10141b; }",
      ".ko-pg-week { display: grid; gap: 10px; padding: 12px 14px; border: 1px solid var(--line);",
      "  border-radius: 12px; background: var(--panel); }",
      ".ko-pg-week-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }",
      ".ko-pg-week-head strong { font-size: calc(13.5px * var(--font-scale, 1)); }",
      ".ko-pg-week-head span { color: var(--muted); font-size: calc(12px * var(--font-scale, 1)); }",
      ".ko-pg-week-grid { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(86px, 1fr)); }",
      // 数字小卡：和概览 metric-card 同一族（衬线大数 + 灰标签）。
      ".ko-pg-week-cell { display: grid; gap: 2px; padding: 9px 11px; border: 1px solid var(--line);",
      "  border-radius: 10px; }",
      ".ko-pg-week-cell strong { font: 700 calc(20px * var(--font-scale, 1))/1.2 Georgia, serif;",
      "  color: var(--green-dark); }",
      ".ko-pg-week-cell span { color: var(--muted); font-size: calc(11px * var(--font-scale, 1)); line-height: 1.35; }",
      ".ko-pg-promoted { display: flex; gap: 6px; flex-wrap: wrap; }",
      ".ko-pg-repair-hint { margin: 0; padding: 9px 11px; border-radius: 10px;",
      "  border: 1px dashed var(--line); background: var(--panel); color: var(--muted);",
      "  font-size: calc(12px * var(--font-scale, 1)); line-height: 1.55; }",
      ".ko-pg-chip { padding: 3px 10px; border-radius: 999px; border: 1px solid rgba(var(--green-rgb), 0.35);",
      "  background: var(--green-soft); color: var(--green-dark);",
      "  font-size: calc(11px * var(--font-scale, 1)); font-weight: 600; }",
      ".ko-pg-note { margin: 0; color: var(--muted); font-size: calc(12px * var(--font-scale, 1)); line-height: 1.5; }",
      ".ko-pg-error { margin: 0; color: var(--red); font-size: calc(12px * var(--font-scale, 1)); line-height: 1.5; }",
      ".ko-pg-actions { display: flex; gap: 8px; flex-wrap: wrap; }",
    ].join("\n");
    document.head.appendChild(el);
  }

  // 「看还缺什么」弹窗样式。跟着主题变量走，不写死颜色；正文是 renderStudyTextContent
  // 出的 HTML，给它一套可读的排版，不依赖 styles.css 的 dialog 样式。
  function ensurePlanDialogStyle() {
    var id = "ko-pg-plan-style";
    if (document.getElementById(id)) return;
    var el = document.createElement("style");
    el.id = id;
    el.textContent = [
      ".ko-pg-plan-dialog { border: 1px solid var(--line); border-radius: 14px;",
      "  background: var(--panel); color: var(--ink); width: min(920px, 94vw);",
      "  max-height: 92vh; padding: 0; overflow: hidden; }",
      ".ko-pg-plan-dialog::backdrop { background: rgba(0,0,0,0.5); }",
      ".ko-pg-plan-inner { display: grid; grid-template-rows: auto 1fr; max-height: 92vh; }",
      ".ko-pg-plan-head { display: flex; align-items: flex-start; gap: 10px;",
      "  padding: 14px 16px 12px; border-bottom: 1px solid var(--line); }",
      ".ko-pg-plan-head > div:first-child { flex: 1 1 auto; min-width: 0; }",
      ".ko-pg-plan-head h3 { margin: 0 0 4px; font-size: calc(15px * var(--font-scale, 1)); line-height: 1.4; }",
      ".ko-pg-plan-head .ko-pg-plan-sub { margin: 0; color: var(--muted); font-size: calc(12px * var(--font-scale, 1)); }",
      ".ko-pg-plan-badge { flex: 0 0 auto; padding: 3px 8px; border-radius: 999px; font-size: calc(12px * var(--font-scale, 1));",
      "  color: var(--green-dark); background: var(--green-soft); white-space: nowrap; }",
      ".ko-pg-plan-badge.is-gap { color: var(--red); background: var(--red-soft); }",
      ".ko-pg-plan-body { overflow-y: auto; padding: 14px 16px; }",
      ".ko-pg-plan-body h4 { margin: 16px 0 6px; font-size: calc(13px * var(--font-scale, 1)); }",
      ".ko-pg-plan-body h4:first-child { margin-top: 0; }",
      ".ko-pg-plan-content { font-size: calc(13.5px * var(--font-scale, 1)); line-height: 1.65; }",
      ".ko-pg-plan-content p { margin: 0 0 8px; }",
      ".ko-pg-plan-content ul, .ko-pg-plan-content ol { margin: 0 0 8px; padding-left: 20px; }",
      ".ko-pg-plan-steps { display: grid; gap: 8px; }",
      ".ko-pg-plan-step { display: grid; gap: 3px; padding: 9px 11px; border: 1px solid var(--line);",
      "  border-radius: 10px; background: var(--panel); }",
      ".ko-pg-plan-step-top { display: flex; align-items: baseline; gap: 8px; }",
      ".ko-pg-plan-step-top strong { font-size: calc(13px * var(--font-scale, 1)); }",
      ".ko-pg-plan-step-top span { margin-left: auto; color: var(--muted); font-size: calc(12px * var(--font-scale, 1)); white-space: nowrap; }",
      ".ko-pg-plan-step p { margin: 0; color: var(--muted); font-size: calc(12px * var(--font-scale, 1)); line-height: 1.55; }",
      ".ko-pg-plan-gaps { display: flex; gap: 6px; flex-wrap: wrap; }",
      ".ko-pg-plan-gap { padding: 4px 9px; border-radius: 999px; border: 1px dashed var(--line);",
      "  color: var(--muted); font-size: calc(12px * var(--font-scale, 1)); }",
      ".ko-pg-plan-loading { display: grid; gap: 8px; justify-items: center; padding: 28px 16px;",
      "  color: var(--muted); font-size: calc(13px * var(--font-scale, 1)); }",
      ".ko-pg-plan-foot { display: flex; gap: 8px; padding: 10px 16px 14px; border-top: 1px solid var(--line);",
      "  justify-content: flex-end; }",
      ".ko-pg-plan-warn { margin: 0 0 10px; padding: 8px 11px; border-radius: 10px;",
      "  border: 1px dashed var(--line); color: var(--muted); font-size: calc(12px * var(--font-scale, 1)); line-height: 1.5; }",
      ".ko-pg-plan-head-actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }",
      ".ko-pg-plan-cached { margin: 0 0 12px; padding: 9px 12px; border-radius: 10px;",
      "  border: 1px solid var(--line); background: var(--sidebar); color: var(--muted);",
      "  font-size: calc(12.5px * var(--font-scale, 1)); line-height: 1.55; }",
    ].join("\n");
    document.head.appendChild(el);
  }

  function escapeText(value) {
    if (typeof escapeHtml === "function") {
      try { return escapeHtml(value == null ? "" : String(value)); } catch (e) { /* 落到本地实现 */ }
    }
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function currentProjectId() {
    // state 是 app.js 顶层的 const（全局词法作用域，不是 window 的属性）。
    if (typeof state === "undefined" || !state) return "";
    return state.currentProjectId || "";
  }

  function isAuthenticated() {
    if (typeof state === "undefined" || !state) return false;
    return Boolean(state.authenticated);
  }

  function call(path) {
    if (typeof api !== "function") return Promise.reject(new Error("接口封装未就绪"));
    return api(path);
  }

  // ── 渲染 ────────────────────────────────────────────

  function stageMeta(stage) {
    var climb = STAGE_CLIMB[stage] || 0;
    var cells = "";
    for (var i = 0; i < 3; i += 1) {
      cells += '<i class="' + (i < climb ? "is-on" : "") + '"></i>';
    }
    return (
      '<span class="ko-pg-track" aria-hidden="true">' + cells + "</span>" +
      "<span>" + escapeText(STAGE_LABELS[stage] || stage) + "</span>"
    );
  }

  function stepActionMarkup(step) {
    var preset = STEP_ACTIONS[step.bucket] || { act: "detail", label: "看详情" };
    var buttons =
      '<button class="mini-button is-primary" type="button" data-ko-pg-act="' +
      escapeText(preset.act) + '"' +
      ' data-ko-pg-node="' + escapeText(step.node_id) + '"' +
      ' data-ko-pg-bucket="' + escapeText(step.bucket) + '">' +
      escapeText(preset.label) + "</button>";
    // 「先修这个」且能定位到那道错题 ⇒ 多给一个次按钮：先看一眼当时错在哪。
    if (step.bucket === "repair" && step.detail && step.detail.last_miss_reference) {
      buttons +=
        '<button class="mini-button" type="button" data-ko-pg-act="miss"' +
        ' data-ko-pg-node="' + escapeText(step.node_id) + '">' +
        "看那道错题</button>";
    }
    return '<span class="ko-pg-acts">' + buttons + "</span>";
  }

  function stepMarkup(step, index) {
    // repair（先修这个）走琥珀装束：语义是「要修的错」，和其余桶的绿色区分开。
    var accent = step && step.bucket === "repair" ? " is-repair" : "";
    return (
      '<div class="ko-pg-step' + accent + '" role="button" tabindex="0"' +
      ' data-ko-pg-step="1"' +
      ' data-node-id="' + escapeText(step.node_id) + '">' +
      '<span class="ko-pg-step-top">' +
      '<span class="ko-pg-rank" aria-hidden="true">' + (Number(index) + 1) + "</span>" +
      '<span class="ko-pg-bucket">' + escapeText(step.bucket_label || "继续") + "</span>" +
      '<span class="ko-pg-name">' + escapeText(step.name) + "</span>" +
      "</span>" +
      '<p class="ko-pg-reason">' + escapeText(step.reason) + "</p>" +
      '<span class="ko-pg-meta">' + stageMeta(step.stage) + "</span>" +
      stepActionMarkup(step) +
      "</div>"
    );
  }

  function weekMarkup(digest) {
    if (!digest) return "";
    var cells = [
      { value: digest.promoted_count || 0, label: "往前挪一格" },
      { value: digest.newly_unlocked_count || 0, label: "解锁新知识点" },
      { value: digest.held_count || 0, label: "稳住了" },
      { value: digest.active_days || 0, label: "有记录的天数" },
    ];
    var promoted = (digest.promoted || []).slice(0, 3).map(function (item) {
      return (
        '<span class="ko-pg-chip">' + escapeText(item.name) + " · " +
        escapeText(item.from_label) + "→" + escapeText(item.to_label) + "</span>"
      );
    });
    return (
      '<div class="ko-pg-week">' +
      '<div class="ko-pg-week-head"><strong>这一周</strong>' +
      "<span>" + escapeText(digest.headline || "") + "</span></div>" +
      '<div class="ko-pg-week-grid">' +
      cells
        .map(function (cell) {
          return (
            '<div class="ko-pg-week-cell"><strong>' + cell.value + "</strong>" +
            "<span>" + escapeText(cell.label) + "</span></div>"
          );
        })
        .join("") +
      "</div>" +
      (promoted.length ? '<div class="ko-pg-promoted">' + promoted.join("") + "</div>" : "") +
      "</div>"
    );
  }

  // 「先修这个」桶空了不硬凑一条，但也别让它静默消失 ——
  // 用户前一天还天天看见「先修这个」，今天突然没有，得知道为什么、以及怎么让它回来。
  // 这里不猜「他是真没错，还是还没勾过自评」，只把做法讲清楚。
  function repairHintMarkup(plan) {
    if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) return "";
    var hasRepair = plan.steps.some(function (step) {
      return step && step.bucket === "repair";
    });
    if (hasRepair) return "";
    return (
      '<p class="ko-pg-note ko-pg-repair-hint">今天没有需要优先修的误解。' +
      "答题时勾一下「我确定」——答错而当时确信的那种题，会排到最前面。</p>"
    );
  }

  function bodyMarkup() {
    if (view.loading && !view.plan) {
      return '<p class="ko-pg-note">正在算今天该做什么…</p>';
    }
    if (view.error) {
      return '<p class="ko-pg-error">' + escapeText(view.error) + "</p>";
    }
    var plan = view.plan;
    if (!plan) return '<p class="ko-pg-note">还没有结果。</p>';
    // 响应可能不完整（代理截断、后端改版）—— 不能在渲染里抛异常，
    // 否则整张卡片会静默变空白，看起来像「功能没做」。
    if (!Array.isArray(plan.steps) || !plan.steps.length) {
      return '<p class="ko-pg-note">这个项目还没有知识点，先导入资料并生成知识框架。</p>';
    }
    return (
      '<div class="ko-pg-steps">' + plan.steps.map(stepMarkup).join("") + "</div>" +
      repairHintMarkup(plan) +
      weekMarkup(view.digest)
    );
  }

  function cardMarkup() {
    var plan = view.plan || {};
    var blocked = plan.blocked_count || 0;
    // 胶囊文字要短：工作台折叠态只有 278px，长句子即使能换行也会独占一整行。
    var chip = blocked ? "还有 " + blocked + " 个在等前置" : "各带一个理由";
    return (
      '<div class="overview-section-heading ko-pg-head"><div>' +
      "<h3>今天做这三件事</h3>" +
      "<p>每件事都带一句理由，点按钮直接开始。最后一件是换个方向，免得一直在最弱的那几个点上打转。</p>" +
      "</div><span>" + escapeText(chip) + "</span></div>" +
      bodyMarkup() +
      '<div class="ko-pg-actions">' +
      '<button class="mini-button" type="button" data-ko-pg-refresh="1">重新算一遍</button>' +
      "</div>"
    );
  }

  // ── 动作：让推荐能被「做」，而不只是「看」 ────────────

  function showToastNotice(message, variant) {
    if (typeof showToast === "function") {
      try { showToast(message, { variant: variant || "notice" }); return; } catch (e) { /* 落到静默 */ }
    }
  }

  // 出题要十几秒（真调模型），按钮就地进忙碌态，不做整卡重绘 ——
  // 重绘会把用户滚到的位置冲掉（exam-countdown-ui 同款经验）。
  async function runNodeQuiz(step, btn) {
    var pid = currentProjectId();
    if (!pid || typeof api !== "function") return;
    var card = btn.closest(".ko-pg-panel") || document;
    var allButtons = card.querySelectorAll("[data-ko-pg-act]");
    allButtons.forEach(function (b) { b.disabled = true; });
    var idleText = btn.textContent;
    btn.textContent = "出题中…";
    // 出题要真调模型、通常几十秒，只改按钮文字容易被当成「没反应」——
    // 补一条即时 toast，让用户明确知道已经在出了。
    showToastNotice("正在为「" + (step.name || "该考点") + "」出题，通常要 1 分钟左右，稍候…");
    try {
      var data = await api(
        "/api/projects/" + encodeURIComponent(pid) + "/nodes/" + encodeURIComponent(step.node_id) + "/quiz",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            difficulty: 2,
            question_count: 5,
            question_types: ["single_choice", "multiple_choice", "fill_blank", "short_answer"],
          }),
        }
      );
      var questions = Array.isArray(data && data.questions) ? data.questions : [];
      if (!questions.length) throw new Error("模型这次没有出成题目，稍后再试一次");
      // 与 app.js::kbGenerateQuiz / exam-countdown-ui 同一口径：
      // 新测验就是「小测验」页要显示的那份，历史缓存作废。
      if (typeof state !== "undefined" && state) {
        state.quiz = data;
        state.quizHistory = null;
      }
      if (typeof switchFeature === "function") switchFeature("quiz");
      showToastNotice("「" + (step.name || "该考点") + "」出了 " + questions.length + " 道题，已锁在测验界面");
    } catch (error) {
      if (typeof showError === "function") showError(error);
      else showToastNotice((error && error.message) || "出题失败，稍后再试。", "error");
    } finally {
      allButtons.forEach(function (b) { b.disabled = false; });
      btn.textContent = idleText;
    }
  }

  // reference 是 quiz 提交处写的 "quiz_id:题号"。取最后一段冒号前的东西当 quiz_id ——
  // 即便将来格式变化（例如出现嵌套冒号），从前缀取也比按固定下标切更稳。
  function openMissQuiz(reference) {
    var quizId = String(reference || "");
    var cut = quizId.lastIndexOf(":");
    if (cut > 0) quizId = quizId.slice(0, cut);
    if (!quizId) {
      showToastNotice("找不到那道错题的出处，先出题重练也一样。", "error");
      return;
    }
    if (typeof enterHistoricQuizView === "function") {
      enterHistoricQuizView(quizId);
    }
  }

  // ── 「看还缺什么」：AI 补课规划弹窗 ──────────────────

  function renderStudyPlanMarkdown(text) {
    var value = String(text == null ? "" : text);
    if (typeof renderStudyTextContent === "function") {
      try { return renderStudyTextContent(value); } catch (e) { /* 落到本地兜底 */ }
    }
    // 兜底：不认 Markdown 时退化成「转义 + 换行」，绝不把模型输出当 HTML 直接塞。
    return escapeText(value).replace(/\n/g, "<br>");
  }

  function planStepMarkup(step, index) {
    var minutes = Number(step.minutes);
    var time = Number.isFinite(minutes) && minutes > 0 ? "约 " + Math.round(minutes) + " 分钟" : "";
    return (
      '<div class="ko-pg-plan-step">' +
      '<div class="ko-pg-plan-step-top">' +
      "<strong>" + (index + 1) + ". " + escapeText(step.title || "未命名步骤") + "</strong>" +
      (time ? "<span>" + escapeText(time) + "</span>" : "") +
      "</div>" +
      (step.detail ? '<p class="ko-pg-reason">' + escapeText(step.detail) + "</p>" : "") +
      "</div>"
    );
  }

  function formatPlanTime(ts) {
    if (!ts) return "";
    try {
      var d = new Date(String(ts).replace(" ", "T"));
      if (Number.isNaN(d.getTime())) return String(ts);
      return d.toLocaleString();
    } catch (e) {
      return String(ts);
    }
  }

  function planDialogMarkup(step, data) {
    if (data && data.error) {
      return (
        '<div class="ko-pg-plan-loading"><p class="ko-pg-error">' + escapeText(data.error) + "</p>" +
        '<button class="mini-button" type="button" data-ko-pg-plan-retry="1">再试一次</button></div>'
      );
    }
    if (!data) {
      return '<div class="ko-pg-plan-loading">正在让 AI 补课、排学习规划，通常要 1 分钟左右…</div>';
    }
    var isGap = data.material_status !== "有资料可用";
    var gaps = Array.isArray(data.gaps) ? data.gaps : [];
    var steps = Array.isArray(data.plan) ? data.plan : [];
    var cachedNote = data.cached
      ? '<p class="ko-pg-plan-cached">这是上次生成的补课规划（' + escapeText(formatPlanTime(data.created_at)) +
        "）。资料没变就直接复用；想重算点右上角「重新生成」。</p>"
      : "";
    return (
      '<div class="ko-pg-plan-body">' +
      cachedNote +
      (isGap
        ? '<p class="ko-pg-plan-warn">⚠️ 这个节点还没有可用的资料，下面的讲解是模型通识，不是你的资料原文；'
        + "学完后记得按「还缺什么」补材料核对。</p>"
        : "") +
      '<h4>这个知识点讲什么</h4>' +
      '<div class="ko-pg-plan-content">' + renderStudyPlanMarkdown(data.content) + "</div>" +
      (steps.length
        ? '<h4>学习规划</h4><div class="ko-pg-plan-steps">' +
          steps.map(planStepMarkup).join("") +
          "</div>"
        : "") +
      (gaps.length
        ? '<h4>还缺什么</h4><div class="ko-pg-plan-gaps">' +
          gaps.map(function (g) { return '<span class="ko-pg-plan-gap">' + escapeText(g) + "</span>"; }).join("") +
          "</div>"
        : "") +
      "</div>"
    );
  }

  function openNodeStudyPlanDialog(step) {
    ensurePlanDialogStyle();
    var dlg = document.getElementById("ko-pg-plan-dialog");
    var title, sub, badge, body;
    if (!dlg) {
      dlg = document.createElement("dialog");
      dlg.id = "ko-pg-plan-dialog";
      dlg.className = "ko-pg-plan-dialog";
      dlg.innerHTML =
        '<div class="ko-pg-plan-inner">' +
        '<header class="ko-pg-plan-head"><div>' +
        '<h3 class="ko-pg-plan-title"></h3><p class="ko-pg-plan-sub"></p>' +
        '</div><div class="ko-pg-plan-head-actions">' +
        '<span class="ko-pg-plan-badge"></span>' +
        '<button class="mini-button" type="button" data-ko-pg-plan-refresh="1">重新生成</button>' +
        "</div></header>" +
        '<div class="ko-pg-plan-body"></div>' +
        '<footer class="ko-pg-plan-foot">' +
        '<button class="mini-button" type="button" data-ko-pg-plan-learn="1">开始学</button>' +
        '<button class="mini-button" type="button" data-ko-pg-plan-close="1">关闭</button>' +
        "</footer></div>";
      document.body.appendChild(dlg);
    }
    title = dlg.querySelector(".ko-pg-plan-title");
    sub = dlg.querySelector(".ko-pg-plan-sub");
    badge = dlg.querySelector(".ko-pg-plan-badge");
    body = dlg.querySelector(".ko-pg-plan-body");
    var refreshBtn = dlg.querySelector("[data-ko-pg-plan-refresh]");

    title.textContent = "「" + (step.name || "该考点") + "」· 补课规划";
    sub.textContent = "AI 生成这个知识点的讲解 + 学习规划 + 还缺什么，会按节点缓存、资料变了自动重算。";
    badge.textContent = "生成中…";
    badge.classList.remove("is-gap");

    var pid = currentProjectId();
    var planUrl = "/api/projects/" + encodeURIComponent(pid) + "/nodes/" +
      encodeURIComponent(step.node_id) + "/study-plan";

    var render = function (data, loading) {
      body.innerHTML = planDialogMarkup(step, data);
      if (data && !data.error) {
        badge.textContent = data.material_status === "有资料可用" ? "有资料" : "缺资料";
        badge.classList.toggle("is-gap", data.material_status !== "有资料可用");
      } else if (loading) {
        badge.textContent = "生成中…";
        badge.classList.remove("is-gap");
      } else {
        badge.textContent = "未生成";
        badge.classList.add("is-gap");
      }
      if (refreshBtn) refreshBtn.disabled = !!loading;
      var retry = body.querySelector("[data-ko-pg-plan-retry]");
      if (retry) retry.addEventListener("click", function () { load(false); });
    };

    var load = function (refresh) {
      render(null, true);
      var finish = function (data) { render(data, false); return data; };
      if (typeof api !== "function") {
        return Promise.resolve({ error: "接口封装未就绪。" }).then(finish);
      }
      var url = refresh ? planUrl + "?refresh=true" : planUrl;
      // 同一节点正在后台生成时，重复打开不重复发请求，直接接上那个 in-flight 结果。
      // 关闭弹窗不会 abort 这个 fetch（api() 没有 AbortController），所以生成照常跑完并落缓存。
      if (!refresh && planInFlight && planInFlight.nodeId === step.node_id) {
        return planInFlight.promise.then(finish);
      }
      var p = api(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
        .then(function (data) { return data; })
        .catch(function (error) {
          return { error: (error && error.message) || "生成失败，稍后再试。" };
        });
      planInFlight = { nodeId: step.node_id, promise: p };
      p.then(function () {
        if (planInFlight && planInFlight.promise === p) planInFlight = null;
      });
      return p.then(finish);
    };

    // 每次打开重绑动作（dialog 复用时旧的 listener 还在，绑前先清）
    var learnBtn = dlg.querySelector("[data-ko-pg-plan-learn]");
    var closeBtn = dlg.querySelector("[data-ko-pg-plan-close]");
    learnBtn.onclick = function () {
      dlg.close();
      if (typeof jumpToKbNode === "function") jumpToKbNode(step.node_id);
    };
    closeBtn.onclick = function () { dlg.close(); };
    if (refreshBtn) refreshBtn.onclick = function () { load(true); };

    load(false);
    if (!dlg.open) dlg.showModal();
  }

  function runStudyPlan(step) {
    openNodeStudyPlanDialog(step);
  }

  function runStepAction(act, step, btn) {
    if (!step) return;
    if (act === "quiz") {
      runNodeQuiz(step, btn);
    } else if (act === "miss") {
      var reference = step.detail && step.detail.last_miss_reference;
      openMissQuiz(reference);
    } else if (act === "learn") {
      // 跳进知识框架并聚焦到这个节点 —— 「开始学」的入口。
      if (typeof jumpToKbNode === "function") jumpToKbNode(step.node_id);
    } else if (act === "study-plan") {
      runStudyPlan(step);
    } else if (act === "detail") {
      if (typeof openNodeMasteryAnalysisDialog === "function") {
        openNodeMasteryAnalysisDialog(step.node_id);
      }
    } else if (act === "cards") {
      if (typeof switchFeature === "function") switchFeature("cards");
    } else if (act === "transfer") {
      // 「换个情境试试」：由 transfer-ui.js 提供弹窗。这里只做转发 + 回退 ——
      // transfer-ui.js 是独立模块，没加载时（index.html 摘掉那一行 script）
      // 回落到节点详情，界面上仍是可点的，只是少了一层迁移验算。
      if (window.KnowOriginTransfer && typeof window.KnowOriginTransfer.open === "function") {
        window.KnowOriginTransfer.open(step.node_id);
      } else if (typeof openNodeMasteryAnalysisDialog === "function") {
        openNodeMasteryAnalysisDialog(step.node_id);
      }
    }
  }

  function stepFromEvent(event) {
    var target = event.target;
    if (!target || !target.closest) return null;
    var btn = target.closest("[data-ko-pg-act]");
    if (btn) {
      var cardEl = btn.closest(".ko-pg-step");
      return { kind: "action", act: btn.getAttribute("data-ko-pg-act"), button: btn, cardEl: cardEl };
    }
    // 点卡片其余区域 = 看节点详情（承接改造前 data-overview-action="open-node" 的行为）
    var stepEl = target.closest(".ko-pg-step");
    if (stepEl) return { kind: "detail", cardEl: stepEl };
    return null;
  }

  function findPlanStep(nodeId) {
    var plan = view.plan;
    if (!plan || !Array.isArray(plan.steps) || !nodeId) return null;
    for (var i = 0; i < plan.steps.length; i += 1) {
      if (plan.steps[i] && plan.steps[i].node_id === nodeId) return plan.steps[i];
    }
    return null;
  }

  function handlePanelClick(event) {
    var hit = stepFromEvent(event);
    if (!hit || !hit.cardEl) return;
    var step = findPlanStep(hit.cardEl.getAttribute("data-node-id"));
    if (!step) return;
    if (hit.kind === "action") {
      event.preventDefault();
      event.stopPropagation();
      runStepAction(hit.act, step, hit.button);
    } else if (typeof openNodeMasteryAnalysisDialog === "function") {
      openNodeMasteryAnalysisDialog(step.node_id);
    }
  }

  function handlePanelKeydown(event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    var target = event.target;
    if (!target || !target.closest) return;
    // 动作按钮是原生 <button>，Enter/Space 自带 click，交给 handlePanelClick。
    if (target.closest("[data-ko-pg-act]")) return;
    var stepEl = target.closest(".ko-pg-step");
    if (!stepEl) return;
    event.preventDefault();
    var step = findPlanStep(stepEl.getAttribute("data-node-id"));
    if (step && typeof openNodeMasteryAnalysisDialog === "function") {
      openNodeMasteryAnalysisDialog(step.node_id);
    }
  }

  // ── 挂载 ────────────────────────────────────────────

  function ensureCard() {
    var dash = document.querySelector("#studio-output .overview-dashboard");
    if (!dash) return null;
    var card = dash.querySelector("[" + EMBED_ATTR + "]");
    if (card) return card;
    card = document.createElement("article");
    card.className = "overview-panel " + CARD_CLASS;
    card.setAttribute(EMBED_ATTR, "1");
    dash.appendChild(card);
    return card;
  }

  function render() {
    var card = ensureCard();
    if (!card) return false;
    // 渲染前先 diff：无条件 innerHTML= 会自触发下面的 MutationObserver（它盯着整个 body），
    // 形成「写一次 → 120ms 后 mount → 再写」的重绘循环，按钮在 mousedown 和 click
    // 之间被整个换掉，click 永远落空 —— 「点了没反应」的真凶（exam-countdown 同款坑）。
    // 另外必须连元素本体一起比对：app.js 冲掉 #studio-output 后 ensureCard 建的是新空卡，
    // 只比字符串会误判「内容没变」而把空卡留在页面上。
    var markup = cardMarkup();
    if (view.lastCard === card && view.lastMarkup === markup) return true;
    view.lastCard = card;
    view.lastMarkup = markup;
    card.innerHTML = markup;
    var refresh = card.querySelector("[data-ko-pg-refresh]");
    if (refresh) {
      refresh.addEventListener("click", function () {
        load(true);
      });
    }
    return true;
  }

  function syncProject() {
    var pid = currentProjectId();
    if (!pid) {
      view.projectId = null;
      view.plan = null;
      view.digest = null;
      return;
    }
    if (pid === view.projectId && view.plan) return; // 同项目内换页签回来不重复请求
    view.projectId = pid;
    view.plan = null;
    view.digest = null;
    load(false);
  }

  function load(force) {
    if (!isAuthenticated()) return;
    var pid = currentProjectId();
    if (!pid) return;
    if (view.loading) return;
    view.loading = true;
    view.error = "";
    if (force) view.plan = null;
    render();
    Promise.all([
      call("/api/progress/" + encodeURIComponent(pid) + "/plan"),
      call("/api/progress/" + encodeURIComponent(pid) + "/digest"),
    ])
      .then(function (results) {
        view.plan = results[0];
        view.digest = results[1];
      })
      .catch(function (error) {
        view.error = (error && error.message) || "拿不到建议，稍后再试。";
      })
      .then(function () {
        view.loading = false;
        render();
      });
  }

  function mount() {
    if (!isAuthenticated()) return false;
    ensureStyle();
    if (!render()) return false;
    syncProject();
    return true;
  }

  // app.js 每次进概览都会重写 #studio-output.innerHTML，追加的卡片必被冲掉 →
  // 用 MutationObserver 兜住（防抖 120ms），再在 feature 点击时即时补一次。
  var pending = false;
  function scheduleMount() {
    if (pending) return;
    pending = true;
    setTimeout(function () {
      pending = false;
      mount();
    }, 120);
  }

  function bind() {
    if (document.body) {
      new MutationObserver(scheduleMount).observe(document.body, {
        childList: true,
        subtree: true,
      });
    }
    document.addEventListener(
      "click",
      function (event) {
        var grid = event.target.closest && event.target.closest(".feature-grid");
        if (grid) setTimeout(mount, 0);
      },
      true
    );
    document.addEventListener("click", handlePanelClick);
    document.addEventListener("keydown", handlePanelKeydown);
    mount();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }

  // 供别的模块 / 探针调用
  window.KnowOriginProgress = {
    refresh: function () { return load(true); },
    mount: mount,
    plan: function () { return view.plan; },
    digest: function () { return view.digest; },
  };
})();
