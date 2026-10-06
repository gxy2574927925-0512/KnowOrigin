/* ==========================================================================
   知源（KnowOrigin）· 考期备忘 + 当日冲刺计划

   2026-09-26 版：台历改成三栏工作台后，本模块的两块内容被拆到两个位置 ——

     1. 📅 考期备忘（右栏，唯一一张卡）各科考期 / 考场 / 就绪度，并回标到台历格上
     2. 🎯 当日计划（中栏底部页签）台历上点哪一天，这里就是那天的冲刺清单

   为什么拆开：右栏是「一眼扫到还有几天考」的固定参照，内容必须少而稳；
   而冲刺清单是跟着日期变的长列表，放在日历正下方，点哪天看哪天，视线不用来回横跳。
   「按某门课制定冲刺计划」的入口则在左栏课程页里（study-desk-ui.js 调用 generate）。

   核心机制：
   - 多因子动态紧迫度评分：目标分 × 掌握度缺口 × 剩余天数 × 每日带宽，推每日冲刺量
   - 倒推三阶段冲刺模型：全景筑基 -> 难点攻坚 -> 全真自测
   - 每日可执行打卡清单 + RFC-5545 日历同步，任务落到台历上逐日勾销

   与其他文件的契约（全部走 CustomEvent / 全局命名空间，不直接依赖对方内部实现）：
   - 本文件依赖 streak.js 提供的 window.KnowOriginCalendar.open() 打开台历
   - 本文件 dispatch：
       knoworigin:exam-dates     { dates: { "YYYY-MM-DD": ["科目", ...] } }  台历画考期角标
       knoworigin:sprint-days    { dates: { "YYYY-MM-DD": 任务数 } }          台历画计划覆盖日
       knoworigin:calendar-close {}                                          跳转前收起台历
   - 台历通过 window.KnowOriginSprint.setDate(dateKey) 把选中的日期推给本模块
   ========================================================================== */

(function () {
  "use strict";

  const VM = {
    root: null,            // 右侧考期备忘插槽
    dayRoot: null,         // 中栏底部「当日计划」插槽
    sprintPlan: null,
    loading: false,
    // AI 文案回填：同一会话内只自动尝试一次，避免模型不可用时反复空转
    enriching: false,
    enrichTried: false,
    enrichDisabled: false,
    exams: [],
    examsLoading: false,
    selectedDate: "",      // 台历当前选中的日期（YYYY-MM-DD）
    busy: false,
    genBusy: "",
    // "card" | "quiz"：任务上的生成动作正在跑，避免并发点两次。
    // 生成完不是就地摊个列表，而是跳进卡片 / 测验界面并把视图**锁**在刚生成的内容上。
    focusCardIds: [],
    focusBusy: false,
    focusObserver: null,  };

  // 三档只是「周期 × 每日投入」的快捷填充，名字取短；周期与时长由按钮第二行给出。
  const MODE_PRESETS = [
    { mode: "rescue", days: 3, hours: 2.5, icon: "⚡", name: "抢救", hint: "只抓最高频考点，快速拉过线" },
    { mode: "sprint", days: 7, hours: 2.0, icon: "🎯", name: "冲刺", hint: "三阶段稳步推进" },
    { mode: "mastery", days: 14, hours: 1.5, icon: "🏆", name: "攻坚", hint: "扫清全部盲区" },
  ];

  // 样式自带，不碰 styles.css —— 删掉 index.html 那一行脚本即完全回退（与 study-insight-ui.js 同约定）。
  const STYLE_ID = "ko-sprint-side-style";

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      // —— 卡片容器：与同侧栏的「学情洞察」卡同一套观感 ——
      ".ko-side-card{min-width:0;border:1px solid var(--line);border-radius:12px;",
      "background:var(--panel);padding:14px;display:grid;gap:10px}",
      ".ko-side-card-body{min-width:0;display:grid;gap:9px}",
      ".ko-side-title{display:flex;align-items:center;gap:6px;font-size:calc(14px * var(--font-scale, 1));font-weight:700;color:var(--ink)}",
      ".ko-side-count{margin-left:auto;font-size:calc(11px * var(--font-scale, 1));color:var(--muted);border:1px solid var(--line);",
      "border-radius:999px;padding:0 7px;line-height:18px;font-variant-numeric:tabular-nums}",
      ".ko-side-empty{margin:0;font-size:calc(12px * var(--font-scale, 1));color:var(--muted);line-height:1.7}",
      ".ko-side-lead{margin:0;font-size:calc(12.5px * var(--font-scale, 1));color:var(--ink);line-height:1.7}",
      ".ko-side-hint{font-size:calc(11.5px * var(--font-scale, 1));color:var(--muted);line-height:1.6}",
      // —— 节奏预设（窄栏里竖排，一列三行）——
      ".ko-side-modes{display:grid;gap:6px}",
      ".ko-side-mode{display:grid;grid-template-columns:auto 1fr;grid-template-rows:auto auto;",
      "column-gap:9px;align-items:center;text-align:left;border:1px solid var(--line);background:transparent;",
      "color:var(--ink);border-radius:10px;padding:8px 10px;cursor:pointer;font-family:inherit;",
      "transition:border-color .15s ease,background .15s ease}",
      ".ko-side-mode:hover{border-color:var(--green);background:var(--green-soft)}",
      ".ko-side-mode[disabled]{opacity:.55;cursor:default}",
      ".ko-side-mode-icon{grid-row:1 / 3;font-size:calc(18px * var(--font-scale, 1));line-height:1}",
      ".ko-side-mode-name{font-size:calc(12.5px * var(--font-scale, 1));font-weight:600}",
      ".ko-side-mode-hint{font-size:calc(11px * var(--font-scale, 1));color:var(--muted)}",
      // —— 折叠表单 ——
      ".ko-side-adv{border-top:1px dashed var(--line);padding-top:8px}",
      ".ko-side-adv>summary{cursor:pointer;font-size:calc(12px * var(--font-scale, 1));color:var(--muted);list-style:none}",
      ".ko-side-adv>summary::-webkit-details-marker{display:none}",
      ".ko-side-adv>summary::before{content:'▸ '}",
      ".ko-side-adv[open]>summary::before{content:'▾ '}",
      ".ko-side-form{display:grid;gap:8px;margin-top:9px}",
      ".ko-side-form label{display:grid;gap:4px;font-size:calc(11.5px * var(--font-scale, 1));color:var(--muted)}",
      // 手写 input 的 display:grid 会盖掉 [hidden] 的 UA 样式，手动输入那行要能真正藏起来
      ".ko-side-form label[hidden]{display:none}",
      ".ko-side-form input,.ko-side-form select{border:1px solid var(--line);background:var(--background);color:var(--ink);",
      "border-radius:8px;padding:6px 8px;font-size:calc(12px * var(--font-scale, 1));font-family:inherit;width:100%}",
      ".ko-side-form select{cursor:pointer}",
      // —— 按钮 ——
      ".ko-side-btn{border:1px solid var(--line);background:transparent;color:var(--ink);border-radius:8px;",
      "padding:6px 10px;cursor:pointer;font-size:calc(12px * var(--font-scale, 1));font-family:inherit;",
      "transition:border-color .15s ease,background .15s ease}",
      ".ko-side-btn:hover{border-color:var(--green);background:var(--green-soft)}",
      ".ko-side-btn[disabled]{opacity:.55;cursor:default}",
      ".ko-side-btn.primary{background:var(--green);border-color:var(--green);color:#0e1410;font-weight:600}",
      ".ko-side-btn.is-danger{color:var(--red);border-color:var(--red)}",
      ".ko-side-btn.is-danger:hover{background:var(--red-soft)}",
      ".ko-side-link{border:0;background:transparent;color:var(--green-dark);font-size:calc(11.5px * var(--font-scale, 1));",
      "cursor:pointer;padding:0 0 0 8px;font-family:inherit;text-decoration:underline}",
      // —— 计划头部 / 进度 ——
      ".ko-side-plan-head{display:grid;gap:8px}",
      ".ko-side-plan-title{display:flex;flex-wrap:wrap;align-items:center;gap:6px}",
      ".ko-side-plan-title strong{font-size:calc(13.5px * var(--font-scale, 1));color:var(--ink)}",
      ".ko-side-pill{font-size:calc(10.5px * var(--font-scale, 1));border:1px solid var(--line);border-radius:999px;padding:1px 7px;",
      "color:var(--muted);white-space:nowrap}",
      ".ko-side-pill.is-ok{border-color:var(--green);color:var(--green-dark)}",
      ".ko-side-pill.is-warn{border-color:var(--gold);color:var(--gold)}",
      ".ko-side-progress{display:grid;gap:4px}",
      ".ko-side-progress-bar{height:7px;border-radius:999px;background:var(--sidebar);overflow:hidden}",
      ".ko-side-progress-bar i{display:block;height:100%;border-radius:999px;",
      "background:linear-gradient(90deg,var(--green),var(--green-dark))}",
      ".ko-side-progress span{font-size:calc(11px * var(--font-scale, 1));color:var(--muted);font-variant-numeric:tabular-nums}",
      ".ko-side-stages{display:flex;flex-wrap:wrap;gap:5px}",
      ".ko-side-stage{font-size:calc(10.5px * var(--font-scale, 1));border:1px solid var(--line);border-radius:999px;padding:2px 8px;color:var(--muted)}",
      ".ko-side-stage.is-on{background:var(--green);border-color:var(--green);color:#0e1410;font-weight:600}",
      // —— 提示条 ——
      ".ko-side-note{font-size:calc(11.5px * var(--font-scale, 1));line-height:1.6;border-radius:8px;padding:7px 9px;",
      "background:var(--background);border-left:3px solid var(--line);color:var(--muted)}",
      ".ko-side-note.is-exam{border-left-color:var(--gold);background:var(--gold-soft);color:var(--ink)}",
      ".ko-side-note.is-warn{border-left-color:var(--red);background:var(--red-soft);color:var(--ink)}",
      ".ko-side-note strong{color:inherit}",
      // —— 当日清单 ——
      ".ko-side-day-head{display:flex;justify-content:space-between;align-items:center;gap:8px;",
      "font-size:calc(12.5px * var(--font-scale, 1));font-weight:600;color:var(--ink)}",
      ".ko-side-day-min{display:flex;align-items:center;font-size:calc(11px * var(--font-scale, 1));font-weight:400;color:var(--muted)}",
      ".ko-side-tasks{display:grid;gap:7px}",
      ".ko-side-task{display:grid;grid-template-columns:auto 1fr;gap:9px;border:1px solid var(--line);",
      "border-radius:10px;padding:9px 10px;background:var(--panel);",
      "transition:border-color .15s ease,box-shadow .15s ease}",
      ".ko-side-task:hover{border-color:var(--green)}",
      ".ko-side-task.is-done{opacity:.62}",
      ".ko-side-task.is-done .ko-side-task-text{text-decoration:line-through}",
      ".ko-side-task.is-review{border-color:var(--red)}",
      ".ko-side-task-cb{margin-top:2px;width:15px;height:15px;accent-color:var(--green);cursor:pointer;flex:0 0 auto}",
      ".ko-side-task-main{min-width:0;display:grid;gap:4px}",
      ".ko-side-task-title{display:flex;flex-wrap:wrap;align-items:center;gap:6px;",
      "font-size:calc(12.5px * var(--font-scale, 1));font-weight:600;color:var(--ink)}",
      ".ko-side-task-icon{font-size:calc(13px * var(--font-scale, 1));line-height:1}",
      ".ko-side-task-text{overflow-wrap:anywhere}",
      ".ko-side-task-detail{font-size:calc(11.5px * var(--font-scale, 1));color:var(--muted);line-height:1.6;overflow-wrap:anywhere}",
      ".ko-side-task-reason{font-size:calc(11px * var(--font-scale, 1));color:var(--green-dark);line-height:1.5;overflow-wrap:anywhere}",
      ".ko-side-task-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:2px}",
      ".ko-side-task-node{font-size:calc(10.5px * var(--font-scale, 1));border:1px solid var(--line);border-radius:999px;padding:1px 7px;",
      "color:var(--muted);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".ko-side-task-min{font-size:calc(10.5px * var(--font-scale, 1));color:var(--muted);font-variant-numeric:tabular-nums}",
      // —— 任务直达动作条：一项任务可以同时给出「看考点 / 生成卡片 / 出小测验 / 复习 / 问一问」——
      // 动作全部落在项目里已有的产出上，不在这里另造练习流程。
      ".ko-task-acts{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-top:3px}",
      ".ko-task-act{border:1px solid var(--line);background:var(--background);color:var(--ink);",
      "border-radius:7px;padding:2px 8px;font-size:calc(10.5px * var(--font-scale, 1));font-family:inherit;cursor:pointer;",
      "white-space:nowrap;transition:border-color .15s ease,background .15s ease}",
      ".ko-task-act:hover:not([disabled]):not([aria-disabled]){border-color:var(--green);background:var(--green-soft);color:var(--green-dark)}",
      ".ko-task-act[disabled]{opacity:.55;cursor:default}",
      // 「生成类」动作会真花十几秒调模型，用绿底描边与「打开某处看看」的次要动作区分开
      ".ko-task-act.is-strong{border-color:var(--green);background:var(--green-soft);",
      "color:var(--green-dark);font-weight:600}",
      ".ko-task-act.is-strong:hover:not([disabled]):not([aria-disabled]){background:var(--green);color:#0e1410}",
      // 前置条件没满足（考点不在知识框架里）：灰掉，但仍可点 —— 点一下说明原因并带去框架页
      ".ko-task-act.is-locked,.ko-task-act.is-locked.is-strong{border-color:var(--line);",
      "background:var(--sidebar);color:var(--muted);font-weight:400;cursor:not-allowed}",
      ".ko-side-task-delta{font-size:calc(10.5px * var(--font-scale, 1));font-variant-numeric:tabular-nums}",
      ".ko-side-task-delta.is-up{color:var(--green-dark)}",
      ".ko-side-task-delta.is-down{color:var(--red)}",
      ".ko-side-tools{display:flex;flex-wrap:wrap;gap:6px;border-top:1px dashed var(--line);padding-top:9px}",
      // —— 考期备忘 ——
      ".ko-side-exams{display:grid;gap:7px}",
      ".ko-side-exam{border:1px solid var(--line);border-left-width:3px;border-radius:9px;padding:8px 10px;display:grid;gap:5px}",
      ".ko-side-exam.is-normal{border-left-color:var(--green)}",
      ".ko-side-exam.is-sprint{border-left-color:var(--gold)}",
      ".ko-side-exam.is-critical{border-left-color:var(--red);background:var(--red-soft)}",
      ".ko-side-exam.is-past{opacity:.55}",
      ".ko-side-exam-top{display:flex;justify-content:space-between;align-items:baseline;gap:8px}",
      ".ko-side-exam-top strong{font-size:calc(12.5px * var(--font-scale, 1));color:var(--ink);overflow-wrap:anywhere}",
      ".ko-side-exam-days{font-size:calc(11px * var(--font-scale, 1));color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}",
      ".ko-side-exam.is-critical .ko-side-exam-days{color:var(--red);font-weight:600}",
      ".ko-side-exam-meta{font-size:calc(11px * var(--font-scale, 1));color:var(--muted);line-height:1.5;overflow-wrap:anywhere}",
      ".ko-side-exam-actions{display:flex;gap:6px;flex-wrap:wrap}",
      // —— 中栏底部「当日计划」：容器比侧栏宽得多，任务铺成两列，一眼看全一天 ——
      ".ko-day{min-width:0;display:grid;gap:9px;align-content:start}",
      ".ko-day .ko-side-tasks{grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:8px}",
      ".ko-day .ko-side-modes{grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px}",
      ".ko-day .ko-side-day-head{font-size:calc(13.5px * var(--font-scale, 1))}",
      ".ko-day .ko-side-plan-title strong{font-size:calc(15px * var(--font-scale, 1))}",
      ".ko-day .ko-side-task{background:var(--background)}",
      ".ko-day .ko-side-lead{font-size:calc(13px * var(--font-scale, 1))}",
      // —— 创建表单：目标分 / 周期 / 每日投入 / 日期 直接铺开，窄了自动换行 ——
      ".ko-form-grid{grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}",
      ".ko-day-intensity{margin:0;font-size:calc(11.5px * var(--font-scale, 1));color:var(--green-dark);line-height:1.6}",
      ".ko-side-tools.is-plain{border-top:0;padding-top:0}",
      // —— 生成后跳进卡片界面并「锁定」刚生成的那几张 ——
      // 卡片页会把所有卡铺开，不聚焦等于没锁定；其余卡片直接不显示最明确。
      "body.ko-card-focus .cards-grid > article.card:not(.ko-card-focus){display:none !important}",
      "article.card.ko-card-focus{box-shadow:0 0 0 2px var(--green) !important;",
      "background:var(--green-soft) !important}",
      // 锁定提示条：`.studio-panel` 是 overflow:hidden，所以必须挂 body + position:fixed
      ".ko-focus-bar{position:fixed;left:50%;transform:translateX(-50%);bottom:22px;z-index:80;",
      "display:flex;align-items:center;gap:10px;border:1px solid var(--green);border-radius:999px;",
      "background:var(--panel);color:var(--ink);box-shadow:var(--shadow);padding:6px 7px 6px 14px;",
      "font-size:calc(12.5px * var(--font-scale, 1));max-width:calc(100vw - 40px)}",
      ".ko-focus-bar span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".ko-focus-bar button{border:1px solid var(--green);background:var(--green-soft);",
      "color:var(--green-dark);border-radius:999px;padding:3px 12px;font-size:calc(12px * var(--font-scale, 1));",
      "font-family:inherit;cursor:pointer;white-space:nowrap}",
      ".ko-focus-bar button:hover{background:var(--green);color:#0e1410}",
    ].join("");
    document.head.appendChild(style);
  }

  function esc(val) {
    if (typeof window.escapeHtml === "function") return window.escapeHtml(val);
    return String(val == null ? "" : val).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c] || c));
  }

  function notify(msg, variant = "info") {
    if (typeof window.showToast === "function") {
      try { window.showToast(msg, { variant }); return; } catch (_) {}
    }
    console.log(`[SprintSide ${variant}]:`, msg);
  }

  // ⚠️ app.js 里的 state 是**顶层 const（全局词法作用域）**，不是 window 的属性：
  //    写成 window.state 永远是 undefined，面板会一直显示「请先打开一个项目」。
  //    这是本项目所有注入式模块的统一读法（见 study-insight-ui.js / review-ui.js / card-srs.js）。
  function currentProjectId() {
    if (typeof state !== "undefined" && state && state.currentProjectId) {
      return String(state.currentProjectId);
    }
    return "";
  }

  function currentProjectMeta() {
    // ⚠️ state 里没有 currentProject 这一项 —— 要在 state.projects 里按 id 反查
    if (typeof state === "undefined" || !state) return {};
    const pid = currentProjectId();
    if (pid && Array.isArray(state.projects)) {
      const hit = state.projects.find((p) => p && p.project_id === pid);
      if (hit) return hit;
    }
    return {};
  }

  // 考期科目不再让用户凭记忆手敲：直接列出他自己建过的项目（与顶部项目切换器同一份 state.projects）。
  // 手敲的名字常与项目名对不上，导致「按这天排冲刺」匹配不到对应知识库。
  // 仍留「其他（手动输入）」兜底 —— 全校公选之类没建过项目的科目也要能记一笔。
  const MANUAL_SUBJECT = "__manual__";

  function examProjects() {
    if (typeof state === "undefined" || !state || !Array.isArray(state.projects)) return [];
    return state.projects.filter((p) => p && p.project_id);
  }

  // 与 app.js 的 projectLabel 同口径（年份 · 科目），让用户看到的就是项目切换器里的那个名字
  function examProjectLabel(project) {
    const subject = String(project.subject || project.name || "").trim();
    const year = String(project.year || "").trim();
    return year ? `${year} · ${subject}` : subject;
  }

  function examProjectSubject(project) {
    return String((project && (project.subject || project.name)) || "").trim();
  }

  function callApi(url, options = {}) {
    const opts = { ...options };
    if (opts.body != null && opts.body !== "" && typeof opts.body === "string") {
      opts.headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    }
    if (typeof window.api === "function") return window.api(url, opts);
    return fetch(url, { credentials: "same-origin", ...opts }).then((res) => {
      if (!res.ok) {
        return res.json().catch(() => ({})).then((err) => {
          throw new Error(err.detail?.message || err.detail || `HTTP ${res.status}`);
        });
      }
      return res.json();
    });
  }

  function openCalendar() {
    const c = window.KnowOriginCalendar;
    if (c && typeof c.open === "function") c.open();
  }

  function closeCalendar() {
    document.dispatchEvent(new CustomEvent("knoworigin:calendar-close"));
  }

  // ---------------------------------------------------------------- 冲刺计划 --

  async function loadActiveSprintPlan() {
    const curProjId = currentProjectId();
    if (!curProjId) {
      VM.sprintPlan = null;
      publishSprintDays();
      renderSidebar();
      return;
    }
    VM.loading = true;
    renderSidebar();
    let autoEnrichId = "";
    try {
      const data = await callApi(`/api/sprint/current?project_id=${encodeURIComponent(curProjId)}`);
      VM.sprintPlan = data.plan;
      // 老计划（或刚由算法生成）还没有 AI 文案时，自动补一次，让用户不用手动点
      if (
        VM.sprintPlan &&
        !VM.sprintPlan.needs_framework &&
        !VM.sprintPlan.llm_enriched &&
        !VM.enrichTried &&
        !VM.enrichDisabled &&
        VM.sprintPlan.plan_id
      ) {
        VM.enrichTried = true;
        autoEnrichId = VM.sprintPlan.plan_id;
      }
    } catch (err) {
      console.warn("加载冲刺计划失败:", err);
      VM.sprintPlan = null;
    } finally {
      VM.loading = false;
      publishSprintDays();
      renderSidebar();
    }
    if (autoEnrichId) enrichSprintPlan(autoEnrichId);
  }

  // AI 文案回填：算法骨架已就位，这里只让模型把每天的 title/detail/reason 写具体。
  // 模型不可用 / 超额度 / 输出不合规一律不报错，计划保持算法模板照常可用。
  async function enrichSprintPlan(planId) {
    if (!planId || VM.enriching || VM.enrichDisabled) return;
    VM.enriching = true;
    renderSidebar();
    try {
      const res = await callApi("/api/sprint/enrich", {
        method: "POST",
        body: JSON.stringify({ plan_id: planId }),
      });
      if (res.plan) VM.sprintPlan = res.plan;
      if (res.enriched) {
        notify(`✨ AI 已为 ${res.enriched_tasks || 0} 项任务写好执行文案`, "success");
      } else {
        const reasons = {
          no_api_key: "尚未配置大模型 API Key",
          quota_exceeded: "今日 AI 额度已用尽",
          model_error: "大模型暂时不可用",
        };
        notify(`${reasons[res.reason] || "AI 文案暂不可用"}，已保留算法排期骨架，计划照常可用。`, "info");
        if (res.reason === "no_api_key") VM.enrichDisabled = true;
      }
    } catch (err) {
      notify("AI 文案生成失败，已保留算法排期：" + err.message, "warning");
    } finally {
      VM.enriching = false;
      publishSprintDays();
      renderSidebar();
    }
  }

  async function generateSprintPlan(params) {
    // 左栏课程页可能替别的课程发起（此时 params.project_id 已带上），
    // 否则一律用当前打开的项目。
    const projId = (params && params.project_id) || currentProjectId();
    if (!projId) {
      notify("请先在左侧打开一门课程，再制定冲刺计划", "warning");
      return;
    }
    VM.busy = true;
    renderDayPanel();
    let newPlanId = "";
    try {
      const res = await callApi("/api/sprint/generate", {
        method: "POST",
        body: JSON.stringify({ ...params, project_id: projId })
      });
      if (res.plan && res.plan.needs_framework) {
        notify("🧭 这门课还没有知识框架：先照计划把框架建起来，再点「重新制定」，新计划会按学习路径分配考点", "info");
      } else {
        notify("🎉 冲刺排期已生成！点日历上的任意一天，看那天的具体安排", "success");
      }
      VM.sprintPlan = res.plan;
      VM.enrichTried = true;
      newPlanId = res.plan?.plan_id || "";
      // 计划排好后把台历切回月历视图，并让底部停在「当日计划」页签
      const cal = window.KnowOriginCalendar;
      if (cal && typeof cal.setView === "function") cal.setView("calendar");
      document.dispatchEvent(new CustomEvent("knoworigin:show-day-plan"));
    } catch (err) {
      notify("生成冲刺计划失败: " + err.message, "error");
    } finally {
      VM.busy = false;
      publishSprintDays();
      renderSidebar();
    }
    // 骨架先秒出可看，AI 文案随后异步补齐（失败也只剩算法模板，不影响可用性）
    if (newPlanId) enrichSprintPlan(newPlanId);
  }

  async function toggleTask(taskId, completedFlag) {
    if (!VM.sprintPlan?.plan_id) return;
    try {
      const res = await callApi("/api/sprint/task-toggle", {
        method: "POST",
        body: JSON.stringify({
          plan_id: VM.sprintPlan.plan_id,
          task_id: taskId,
          completed: completedFlag
        })
      });
      VM.sprintPlan = res.plan;
      publishSprintDays();
      renderSidebar();
    } catch (err) {
      notify("打卡失败: " + err.message, "error");
      renderSidebar();   // 失败要把勾选框状态弹回去，不能留在乐观状态
    }
  }

  function todayEntry() {
    const p = VM.sprintPlan;
    if (!p) return null;
    if (p.today_schedule) return p.today_schedule;
    const list = p.daily_tasks || [];
    return list.find((d) => d.is_today) || null;
  }

  function planDayForDate(dateKey) {
    const p = VM.sprintPlan;
    if (!p || !dateKey || !Array.isArray(p.daily_tasks)) return null;
    return p.daily_tasks.find((d) => d.date === dateKey) || null;
  }

  /** 台历选中哪天，冲刺卡就显示哪天的清单；没选（或那天不在计划区间）才回落到今天。 */
  function activeDayEntry() {
    const picked = planDayForDate(VM.selectedDate);
    if (picked) return { entry: picked, fromSelection: true };
    if (!VM.selectedDate) {
      const t = todayEntry();
      return t ? { entry: t, fromSelection: false } : null;
    }
    const t = todayEntry();
    return t ? { entry: t, fromSelection: false } : null;
  }

  function publishSprintDays() {
    const dates = {};
    const p = VM.sprintPlan;
    if (p && Array.isArray(p.daily_tasks)) {
      for (const dt of p.daily_tasks) {
        if (dt && dt.date) dates[dt.date] = (dt.tasks || []).length;
      }
    }
    document.dispatchEvent(new CustomEvent("knoworigin:sprint-days", { detail: { dates } }));
  }

  // ---------------------------------------------------------------- 考期 --

  async function loadExams() {
    VM.examsLoading = true;
    renderSidebar();
    try {
      // 考期是跨课程的（一台历看全部考试），所以不按项目过滤
      const data = await callApi("/api/exams/list");
      VM.exams = data.exams || [];
    } catch (err) {
      console.warn("加载考表日程失败:", err);
      VM.exams = [];
    } finally {
      VM.examsLoading = false;
      publishExamDates();
      renderSidebar();
    }
  }

  function examDateKey(e) {
    return String((e && (e.exam_date || e.exam_time)) || "").slice(0, 10);
  }

  function publishExamDates() {
    const dates = {};
    for (const e of VM.exams || []) {
      const key = examDateKey(e);
      if (!key) continue;
      const name = e.subject || e.course_name || "考试";
      if (!dates[key]) dates[key] = [];
      if (dates[key].indexOf(name) < 0) dates[key].push(name);
    }
    document.dispatchEvent(new CustomEvent("knoworigin:exam-dates", { detail: { dates } }));
  }

  function examsOnDate(dateKey) {
    if (!dateKey) return [];
    return (VM.exams || []).filter((e) => examDateKey(e) === dateKey);
  }

  async function addExam(payload) {
    try {
      await callApi("/api/exams/add", { method: "POST", body: JSON.stringify(payload) });
      notify("考期已记下，台历上已标出来", "success");
      await loadExams();
    } catch (err) {
      notify("保存考期失败: " + err.message, "error");
    }
  }

  async function deleteExam(examId) {
    try {
      await callApi(`/api/exams/${encodeURIComponent(examId)}`, { method: "DELETE" });
      notify("已删除该考期", "info");
      await loadExams();
    } catch (err) {
      notify("删除失败: " + err.message, "error");
    }
  }

  // ---------------------------------------------------------------- 渲染 --

  function card(titleHtml, bodyHtml, extraClass) {
    return '<section class="ko-side-card' + (extraClass ? " " + extraClass : "") + '">' +
      '<div class="ko-side-card-head">' + titleHtml + '</div>' +
      '<div class="ko-side-card-body">' + bodyHtml + '</div>' +
      '</section>';
  }

  function renderSidebar() {
    if (VM.root) VM.root.innerHTML = renderExamCard();
    renderDayPanel();
  }

  // —— 中栏底部「当日计划」——

  function renderDayPanel() {
    if (!VM.dayRoot) return;
    if (!currentProjectId()) {
      VM.dayRoot.innerHTML =
        '<div class="ko-day"><p class="ko-side-empty">先在主界面打开一门课程。</p></div>';
      return;
    }
    if (VM.loading && !VM.sprintPlan) {
      VM.dayRoot.innerHTML = '<div class="ko-day"><p class="ko-side-empty">正在读取计划…</p></div>';
      return;
    }
    if (!VM.sprintPlan) {
      VM.dayRoot.innerHTML = '<div class="ko-day">' + renderCreateGuide(currentSubject()) + "</div>";
      refreshIntensityPreview(VM.dayRoot);
      return;
    }
    VM.dayRoot.innerHTML = '<div class="ko-day">' + renderPlanBody() + "</div>";
  }

  // —— 中栏「当日计划」——

  /** 当前项目（课程）名 —— 与左栏课程导航、项目切换器同一口径。 */
  function currentSubject() {
    const meta = currentProjectMeta();
    return meta.subject || meta.title || meta.name || "";
  }

  /**
   * 无计划时的创建引导。表单**直接展开** —— 目标分与学习周期是用户最想调的两个量，
   * 折进 <details> 等于让人多点一次才找得到；周期与考期互相联动，改一个另一个自动跟上。
   */
  function renderCreateGuide(subject) {
    const nearest = (VM.exams || [])
      .filter((e) => Number(e.days_left) >= 0)
      .sort((a, b) => Number(a.days_left) - Number(b.days_left))[0];
    const defaultDate = nearest ? examDateKey(nearest) : "";
    const defaultDays = nearest && Number(nearest.days_left) > 0 ? Number(nearest.days_left) : 7;
    const presets = MODE_PRESETS.map((m) => `
      <button type="button" class="ko-side-mode" data-mode="${m.mode}" data-days="${m.days}" data-hours="${m.hours}"
              ${VM.busy ? "disabled" : ""} title="${esc(m.hint)}">
        <span class="ko-side-mode-icon">${m.icon}</span>
        <span class="ko-side-mode-name">${esc(m.name)}</span>
        <span class="ko-side-mode-hint">${m.days} 天 · ${m.hours}h/天</span>
      </button>`).join("");
    return `
      <p class="ko-side-lead">为《${esc(subject || "当前课程")}》排冲刺计划</p>
      <p class="ko-day-intensity">约定：先排出学习路径（前置先行的考点顺序），再把考点分配到每一天；还没有知识框架时，计划会先带你把框架建起来。</p>
      <div class="ko-side-modes">${presets}</div>
      <div class="ko-side-form ko-form-grid">
        <label>目标分<input type="number" min="60" max="100" data-custom="target_score" value="90" /></label>
        <label>学习周期（天）<input type="number" min="1" max="60" data-custom="total_days" value="${defaultDays}" /></label>
        <label>每天投入（小时）<input type="number" min="0.5" max="8" step="0.5" data-custom="daily_hours" value="2" /></label>
        <label>考试日期<input type="date" data-custom="target_date" value="${esc(defaultDate)}" /></label>
      </div>
      <p class="ko-day-intensity" id="ko-intensity-preview"></p>
      <div class="ko-side-tools is-plain">
        <button type="button" class="ko-side-btn primary" data-custom-submit ${VM.busy ? "disabled" : ""}>
          ${VM.busy ? "生成中…" : "生成计划"}
        </button>
      </div>
    `;
  }

  /** 只回显「几天 × 每天几小时 × 目标多少分」，并按组合给一句定性提醒（不猜后端数字）。 */
  function intensityPreviewText(score, days, hours) {
    if (!score || !days || !hours) return "";
    const bits = [days + " 天 × " + hours + "h/天 · 目标 " + score + " 分"];
    if (days <= 3 && score >= 90) {
      bits.push("强度很高：只会覆盖最高频考点，优先保分而不是全面复习");
    } else if (days <= 7 && score >= 90) {
      bits.push("偏紧：每天会排 3 个以上考点，别把每日投入调低");
    } else if (days >= 14) {
      bits.push("节奏宽松：可以铺开覆盖全部考点");
    }
    return bits.join(" · ");
  }

  function refreshIntensityPreview(root) {
    if (!root || typeof root.querySelector !== "function") return;
    const el = root.querySelector("#ko-intensity-preview");
    if (!el) return;
    const pick = (name) => {
      const input = root.querySelector('[data-custom="' + name + '"]');
      return input ? String(input.value || "").trim() : "";
    };
    el.textContent = intensityPreviewText(
      parseFloat(pick("target_score")) || 0,
      parseInt(pick("total_days"), 10) || 0,
      parseFloat(pick("daily_hours")) || 0
    );
  }

  /** 填了考试日期就把「学习周期」同步过来 —— 两个输入永远指向同一个天数，不用用户自己算。 */
  function syncDaysFromDate(root) {
    if (!root || typeof root.querySelector !== "function") return;
    const dateInput = root.querySelector('[data-custom="target_date"]');
    const daysInput = root.querySelector('[data-custom="total_days"]');
    if (!dateInput || !daysInput || !dateInput.value) return;
    const target = new Date(String(dateInput.value) + "T00:00:00");
    if (Number.isNaN(target.getTime())) return;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.round((target - today) / 86400000);
    if (diff > 0) daysInput.value = String(Math.min(60, diff));
  }

  function renderPlanBody() {
    const p = VM.sprintPlan;
    const picked = activeDayEntry();
    const entry = picked ? picked.entry : null;
    const dayTasks = entry ? (entry.tasks || []) : [];
    const progress = p.progress_percentage || 0;
    const remainingDays = p.days_remaining;
    const stages = p.stages || [];

    const dayLabel = entry ? entry.date : (VM.selectedDate || "");
    const dayTitle = entry
      ? `${dayLabel} · Day ${entry.day_index}${entry.stage_name ? " · " + esc(entry.stage_name) : ""}`
      : (VM.selectedDate || "今天");
    const minutes = entry ? (entry.total_duration_min || 0) : 0;

    // 选中日不在计划区间时，如实说明并把今天的清单端上来，不做静默替换
    const outOfRange = Boolean(VM.selectedDate) && !planDayForDate(VM.selectedDate) && entry;
    const outOfRangeNote = outOfRange
      ? `<div class="ko-side-note">${esc(VM.selectedDate)} 不在 Day 1–${p.total_days} 内，
           下面显示今天（${esc(entry.date)}）的清单。</div>`
      : "";

    const onDate = examsOnDate(entry ? entry.date : VM.selectedDate);
    const examNote = onDate.length
      ? `<div class="ko-side-note is-exam">📌 这天考：<strong>${esc(onDate.map((e) => e.subject || e.course_name).join("、"))}</strong></div>`
      : "";

    const stageChips = stages.length
      ? '<div class="ko-side-stages">' + stages.map((st) => {
          const on = entry && st.name === entry.stage_name;
          return `<span class="ko-side-stage${on ? " is-on" : ""}" title="${esc(st.focus || "")}">${esc(st.name)} · ${st.days}天</span>`;
        }).join("") + "</div>"
      : "";

    const aiBadge = p.needs_framework
      ? '<span class="ko-side-pill">🧭 先建框架</span>'
      : (VM.enriching
        ? '<span class="ko-side-pill">✨ AI 写文案中…</span>'
        : (p.llm_enriched
          ? `<span class="ko-side-pill is-ok">✨ AI 已写细 ${p.enriched_tasks || 0} 项</span>`
          : '<span class="ko-side-pill">✨ 算法排期模板</span>'));

    const reflow = p.reflow_summary || {};
    const reflowNote = reflow.needs_review_tasks > 0
      ? `<div class="ko-side-note is-warn">⚠ <strong>${reflow.needs_review_tasks}</strong> 项要重做${
          reflow.dropped_tasks > 0 ? `（${reflow.dropped_tasks} 项掌握度回落）` : ""
        }</div>`
      : "";

    // 强度回执：一句话说清「每天多少考点 / 有没有排不完」，比一堆说明文字有用
    const it = p.intensity || {};
    const intensityLine = it.nodes_per_day
      ? '<div class="ko-day-intensity">' + [
          it.daily_avg_min ? "每天约 " + it.daily_avg_min + " 分钟" : "",
          "每天 " + it.nodes_per_day + " 个考点",
          it.total_nodes
            ? "覆盖 " + it.covered_nodes + "/" + it.total_nodes + " 个" +
              (it.uncovered_nodes ? "（" + it.uncovered_nodes + " 个按考频留后）" : "")
            : "覆盖 " + it.covered_nodes + " 个考点",
        ].filter(Boolean).join(" · ") + "</div>"
      : "";

    // 学习路径：今天领到的是路径上的哪一段（先排路径、再按天分配的落点）
    const lp = p.learning_path;
    const pathLine = (lp && lp.total_stations && entry && entry.path_from)
      ? '<div class="ko-day-intensity">🧭 学习路径：今天第 ' + entry.path_from + '–' + entry.path_to +
        ' 站 / 共 ' + lp.total_stations + ' 站' +
        (Number(entry.path_lap) >= 2 ? '（第 ' + entry.path_lap + ' 遍，查卡壳）' : '') + '</div>'
      : "";

    const taskHtml = dayTasks.length
      ? dayTasks.map(renderTaskItem).join("")
      : '<p class="ko-side-empty">这天没有任务。</p>';

    // 还没生成知识框架时，任务上的生成类动作全是灰的 —— 先在这里统一说清，别让用户挨个试
    const frameworkNote = hasFramework()
      ? ""
      : '<div class="ko-side-note">🔒 这门课还没生成知识框架：「看考点 / 生成卡片 / 出小测验」暂时用不了。' +
        "先导入资料并点「生成/更新知识框架」，回来它们就亮了。</div>";

    // bootstrap（先建框架）路标计划：把约定说透 —— 建完框架重新制定，才会按学习路径分配考点
    const bootstrapNote = p.needs_framework
      ? '<div class="ko-side-note is-warn">🧭 这门课还没有知识框架：这份计划是把框架建起来的路标。' +
        "完成后点「重新制定」—— 新计划会先生成学习路径，再把考点分配到每一天。</div>"
      : "";

    // 当天目标：今天走路径哪一段、这一段要达到什么（后端按站点掌握度生成）
    const dayGoalNote = entry && entry.day_goal
      ? '<div class="ko-side-note">🎯 ' + esc(entry.day_goal) + '</div>'
      : "";

    const canBackToday = Boolean(VM.selectedDate) && VM.selectedDate !== todayIso();
    const backToday = canBackToday
      ? '<button type="button" class="ko-side-link" data-back-today>回到今天</button>'
      : "";

    return `
      <div class="ko-side-plan-head">
        <div class="ko-side-plan-title">
          <strong>${esc(p.course_name || "当前课程")}</strong>
          <span class="ko-side-pill is-ok">Day ${p.current_day_index} / ${p.total_days}</span>
          <span class="ko-side-pill${remainingDays <= 3 ? " is-warn" : ""}">距考期 ${remainingDays} 天</span>
          ${aiBadge}
        </div>
        <div class="ko-side-progress">
          <div class="ko-side-progress-bar"><i style="width:${progress}%"></i></div>
          <span>${p.completed_tasks_count} / ${p.total_tasks_count} 项已攻克（${progress}%）</span>
        </div>
      </div>
      ${stageChips}
      ${intensityLine}
      ${pathLine}
      ${reflowNote}
      <div class="ko-side-day-head">
        <span>🔥 ${dayTitle}</span>
        <span class="ko-side-day-min">${minutes ? "~" + minutes + " 分钟" : ""}${backToday}</span>
      </div>
      ${outOfRangeNote}
      ${examNote}
      ${bootstrapNote}
      ${dayGoalNote}
      ${frameworkNote}
      <div class="ko-side-tasks">${taskHtml}</div>
      <div class="ko-side-tools">
        ${(!p.llm_enriched && !p.needs_framework && !VM.enriching) ? '<button type="button" class="ko-side-btn" data-enrich title="让校内大模型把任务写具体（排期不变）">✨ AI 写细</button>' : ""}
        <button type="button" class="ko-side-btn" data-export-ics title="导出标准 .ics 日历到手机">📥 导出日历</button>
        <button type="button" class="ko-side-btn" data-reset title="重设节奏或更新考期">🔄 重新制定</button>
      </div>
    `;
  }

  function todayIso() {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
  }

  function renderTaskItem(t) {
    const iconMap = {
      concept: "📖",
      cards: "✍️",
      quiz: "🎯",
      overview: "🗺️",
      summary: "📝",
    };
    const icon = iconMap[t.type] || "📌";
    const nodeChip = t.node_name
      ? `<span class="ko-side-task-node" title="该任务绑定的考点">${esc(t.node_name)}</span>`
      : "";
    // 学习路径站点号：这一站是整条路径的第几位（先排路径、再按天分配的可见坐标）
    const stationChip = (t.type === "concept" && t.path_index)
      ? `<span class="ko-side-task-node" title="学习路径第 ${t.path_index} 站${Number(t.path_lap) >= 2 ? "（第 " + t.path_lap + " 遍）" : ""}">🧭 第 ${t.path_index} 站</span>`
      : "";
    const deltaBadge = (typeof t.mastery_delta === "number" && t.mastery_delta !== 0)
      ? `<span class="ko-side-task-delta ${t.mastery_delta < 0 ? "is-down" : "is-up"}">${t.mastery_delta > 0 ? "+" : ""}${t.mastery_delta}%</span>`
      : "";
    const reviewPill = t.needs_review
      ? `<span class="ko-side-pill is-warn" title="${esc(t.review_reason || "")}">⚠ 需重做</span>`
      : "";
    const reasonLine = t.reason ? `<div class="ko-side-task-reason">💡 ${esc(t.reason)}</div>` : "";
    const acts = taskActions(t);
    const actsHtml = acts.length
      ? '<div class="ko-task-acts">' + acts.map((a) =>
          `<button type="button" class="ko-task-act${a.strong ? " is-strong" : ""}${a.locked ? " is-locked" : ""}" ` +
          // 用 aria-disabled 而不是 disabled：灰掉但还点得动，点一下才能把「为什么点不了」说出口
          `data-act="${esc(a.key)}"${a.locked ? ' aria-disabled="true"' : ""} title="${esc(a.title)}">${esc(a.label)}</button>`
        ).join("") + "</div>"
      : "";
    // 生成出来的东西不在任务卡里摊列表 —— 直接跳进卡片 / 测验界面并锁定在那批内容上
    // （见 focusGeneratedCards）。任务卡上只留「生成」这个动作本身。
    return `
      <div class="ko-side-task ${t.completed ? "is-done" : ""} ${t.needs_review ? "is-review" : ""}"
           data-task-id="${esc(t.task_id)}"
           data-node-id="${esc(t.node_id || "")}"
           data-node-name="${esc(t.node_name || "")}"
           data-card-ids="${esc((t.card_ids || []).join(","))}"
           data-task-type="${esc(t.type || "")}">
        <input type="checkbox" class="ko-side-task-cb" ${t.completed ? "checked" : ""}
               title="${t.completed ? "取消打卡" : "标记完成"}" />
        <div class="ko-side-task-main">
          <div class="ko-side-task-title">
            <span class="ko-side-task-icon">${icon}</span>
            <span class="ko-side-task-text">${esc(t.title)}</span>
            ${reviewPill}
            ${deltaBadge}
          </div>
          <div class="ko-side-task-detail">${esc(t.detail || "")}</div>
          ${reasonLine}
          <div class="ko-side-task-meta">
            ${stationChip}
            ${nodeChip}
            <span class="ko-side-task-min">${t.duration_min || 0} min</span>
          </div>
          ${actsHtml}
        </div>
      </div>
    `;
  }

  // —— 考期备忘卡 ——

  function renderExamCard() {
    const head =
      '<div class="ko-side-title"><span>📅</span><span>考期备忘</span>' +
      '<span class="ko-side-count">' + (VM.exams || []).length + '</span></div>';

    let list;
    if (VM.examsLoading && !VM.exams.length) {
      list = '<p class="ko-side-empty">正在读取考期…</p>';
    } else if (!VM.exams.length) {
      list = '<p class="ko-side-empty">还没有考期。记一笔，计划会自动对齐考试日。</p>';
    } else {
      list = VM.exams.map(renderExamItem).join("");
    }

    const projects = examProjects();
    const curPid = currentProjectId();
    // 有项目就下拉选（默认落在当前项目上），没项目才退回纯手输
    const subjectField = projects.length
      ? `<label>科目 *<select data-exam-field="project">` +
        projects
          .map(
            (p) =>
              `<option value="${esc(p.project_id)}"${p.project_id === curPid ? " selected" : ""}>` +
              `${esc(examProjectLabel(p))}</option>`
          )
          .join("") +
        `<option value="${MANUAL_SUBJECT}">其他（手动输入科目）</option>` +
        `</select></label>` +
        `<label class="ko-side-manual" hidden>手动输入科目 *<input type="text" data-exam-field="subject" placeholder="如：光电子技术" /></label>`
      : `<label>科目 *<input type="text" data-exam-field="subject" placeholder="如：光电子技术" /></label>`;

    const form = `
      <details class="ko-side-adv">
        <summary>+ 记一笔考期</summary>
        <div class="ko-side-form">
          ${subjectField}
          <label>考试日期 *<input type="date" data-exam-field="date" /></label>
          <label>考场与座位<input type="text" data-exam-field="location" placeholder="如：23楼208（32号）" /></label>
          <button type="button" class="ko-side-btn primary" data-exam-submit>保存考期</button>
        </div>
      </details>`;

    return card(head, '<div class="ko-side-exams">' + list + "</div>" + form);
  }

  function renderExamItem(e) {
    const days = Number(e.days_left);
    const daysText = !Number.isFinite(days) ? "日期待确认"
      : (days < 0 ? "已结束" : `距考期 ${days} 天`);
    const urgency = !Number.isFinite(days) ? ""
      : (days < 0 ? "is-past" : (days <= 3 ? "is-critical" : (days <= 7 ? "is-sprint" : "is-normal")));
    const loc = e.location || "考场待定";
    const seat = e.seat ? `（${esc(e.seat)}号）` : "";
    const readiness = e.readiness_score != null ? ` · 就绪度 ${e.readiness_score}%` : "";
    const subject = e.subject || e.course_name || "未命名科目";
    return `
      <div class="ko-side-exam ${urgency}" data-exam-id="${esc(e.exam_id || "")}">
        <div class="ko-side-exam-top">
          <strong>${esc(subject)}</strong>
          <span class="ko-side-exam-days">${daysText}</span>
        </div>
        <div class="ko-side-exam-meta">
          ${esc(examDateKey(e))} · ${esc(loc)}${seat}${readiness}
        </div>
        <div class="ko-side-exam-actions">
          <button type="button" class="ko-side-btn" data-exam-sprint
                  data-subject="${esc(subject)}" data-date="${esc(examDateKey(e))}">🚀 按这天排冲刺</button>
          <button type="button" class="ko-side-btn is-danger" data-exam-del>删除</button>
        </div>
      </div>
    `;
  }

  // ------------------------------------------------------- 任务直达产出 --

  /**
   * 一项冲刺任务能落到哪些**已有产出**上。原则：只给「点进去真的有事可做」的入口。
   *   看考点   知识框架里定位该节点（掌握度、来源原文都在那儿）
   *   生成卡片 与知识框架里那颗「生成知识卡片」同一条链路（POST nodes/{id}/card）
   *   出小测验 与节点面板里那颗「生成小测验」同一条链路（POST nodes/{id}/quiz）
   *   复习卡片 知识卡片页 —— FSRS 复习长在卡片上，不另开复习流程
   *   问一问   把该考点写进输入框，回对话追问（教学模式会按「这一问」给计划）
   * 考点没进知识框架（算法用 syn_* 占位排期）时，生成类动作一律灰掉 —— 点了必然失败，
   * 与其报错不如当场说清（灰但仍可点，点一下会带去知识框架页）。
   */
  function taskActions(t) {
    if (!t) return [];
    const type = t.type || "";
    const hasNode = Boolean(t.node_id);
    const cardCount = (t.card_ids || []).length;
    const name = t.node_name || "该考点";
    const out = [];
    // 生成类动作的前提：这个考点真的在知识框架里。不满足就渲染成灰的（locked），
    // 点一下会说明原因并把人带到知识框架页 —— 见 runTaskAction。
    const lock = nodeLockReason(t.node_id);

    if (hasNode && (type === "concept" || type === "quiz")) {
      out.push({
        key: "detail", label: "🔍 看考点", locked: lock,
        title: lock ? `${lock}，先生成知识框架` : "在知识框架里定位这个考点：掌握度与来源原文都在那儿",
      });
      out.push({
        key: "card", label: "📇 生成卡片", strong: true, locked: lock,
        title: lock ? `${lock}，先生成知识框架` : `针对「${name}」生成知识卡片，生成后存入卡片库`,
      });
      out.push({
        key: "quiz", label: "🎯 出小测验", strong: true, locked: lock,
        title: lock ? `${lock}，先生成知识框架` : `针对「${name}」出 5 道题，生成后直接打开这份测验`,
      });
      out.push({
        key: "ask", label: "🌷 问海小棠",
        title: "让海小棠用苏格拉底式提问带你把考点过一遍",
      });
      return out;
    }
    if (type === "cards") {
      out.push({
        key: "review",
        label: cardCount ? `▶ 复习这 ${cardCount} 张` : "▶ 去卡片库复习",
        title: "打开知识卡片，按 FSRS 到期顺序复习",
      });
      return out;
    }
    if (type === "summary") {
      out.push({ key: "review", label: "📝 复核闪卡", title: "打开知识卡片，把错题闪卡再过一遍" });
      return out;
    }
    if (type === "overview") {
      out.push({ key: "framework", label: "🗺 打开知识框架", title: "看这门课的整体框架与薄弱节点" });
      return out;
    }
    if (type === "quiz") {
      out.push({ key: "quizpage", label: "▶ 打开小测验", title: "打开「小测验」页" });
      return out;
    }
    return out;
  }

  /**
   * 计划里的考点是否真的存在于当前知识框架。
   * 返回 "ok" | "missing" | "unknown" —— "unknown" 是「读不到框架」（state.nodes 为空，
   * 即这门课还没生成框架），此时不区分「还没生成」与「没加载」，一律按「还没有」处理。
   */
  function kbNodeStatus(nodeId) {
    if (!nodeId) return "missing";
    if (typeof state === "undefined" || !state) return "unknown";
    const nodes = Array.isArray(state.nodes) ? state.nodes : [];
    if (!nodes.length) return "unknown";
    return nodes.some((n) => n && n.node_id === nodeId) ? "ok" : "missing";
  }

  /** 当前课程是否已有知识框架（state.nodes 为空即还没生成）。读不到 state 就不下判断。 */
  function hasFramework() {
    if (typeof state === "undefined" || !state) return true;
    return Array.isArray(state.nodes) && state.nodes.length > 0;
  }

  /**
   * 生成类动作（看考点 / 生成卡片 / 出小测验）为什么点不了：空串 = 可以点。
   * 两种情况都锁：① 这门课还没生成知识框架；② 框架在，但计划里的考点不在里面
   * （排期用的是 syn_* 占位考点）。两者点下去都必然失败，与其报错不如当场说清。
   */
  function nodeLockReason(nodeId) {
    const status = kbNodeStatus(nodeId);
    if (status === "ok") return "";
    if (status === "missing") return "这个考点不在当前知识框架里";
    return "这门课还没生成知识框架";
  }

  /** 任务上的考点名：优先取界面上的 chip，其次取任务自带的名字。 */
  function nodeLabelOf(item) {
    const chip = item.querySelector(".ko-side-task-node");
    const text = chip && chip.textContent ? String(chip.textContent).trim() : "";
    return text || item.getAttribute("data-node-name") || "该考点";
  }

  /** 把新生成的卡片并进「知识卡片」页的状态 —— 与 app.js 里 kbGenerateCard 的同步口径一致。 */
  function syncCardsIntoState(cards) {
    if (typeof state === "undefined" || !state || !Array.isArray(cards)) return;
    try {
      const known = new Set((state.cards || []).map((c) => c.card_id));
      // 新卡放最前：跳过去第一屏就能看见刚生成的内容（app.js 按数组顺序渲染）
      state.cards = [...cards.filter((c) => !known.has(c.card_id)), ...(state.cards || [])];
    } catch (err) {
      console.warn("同步新卡片到卡片库失败:", err);
    }
  }

  /** 新出的这份测验就是「小测验」页要显示的那份；历史缓存作废，下次进入重新拉。 */
  function syncQuizIntoState(data) {
    if (typeof state === "undefined" || !state || !data) return;
    try {
      state.quiz = data;
      state.quizHistory = null;
    } catch (err) {
      console.warn("同步新测验到测验页失败:", err);
    }
  }

  // ------------------------------------------------------ 跳进界面并锁定 --

  /**
   * 生成完直接进卡片界面，并把视图**锁定**在刚生成的那几张上。
   *
   * 卡片页会把项目里所有卡铺开，不聚焦等于没锁定 —— 所以其余卡片先隐掉，
   * 底部给一条「只看刚生成的 N 张 · 显示全部」，点一下恢复全量。
   *
   * 刻意不做成「任务卡里就地摊一个列表」：那是读摘要，而用户要的是进界面继续操作
   * （翻面自评、做题），跳过去而不是留在这里。
   */
  function focusGeneratedCards(cardIds) {
    if (!Array.isArray(cardIds) || !cardIds.length) return;
    VM.focusCardIds = cardIds.slice();
    paintFocus(0);
  }

  /** 高亮并滚动到刚生成的卡片；界面还没渲染好就重试几次（渲染是同步的，通常一次就成）。 */
  function paintFocus(tries) {
    const ids = VM.focusCardIds;
    if (!ids.length) return;
    const out = document.getElementById("studio-output");
    const grid = out ? out.querySelector(".cards-grid") : null;
    if (!grid) {
      if ((tries || 0) < 8) setTimeout(() => paintFocus((tries || 0) + 1), 120);
      return;
    }
    let hit = 0;
    ids.forEach((id) => {
      const el = out.querySelector('article.card[data-origin-id="' + cssEscape(id) + '"]');
      if (el) { el.classList.add("ko-card-focus"); hit += 1; }
    });
    if (!hit) return;
    document.body.classList.add("ko-card-focus");
    showFocusBar(hit);
    const first = out.querySelector("article.card.ko-card-focus");
    if (first && typeof first.scrollIntoView === "function") {
      first.scrollIntoView({ block: "center" });
    }
    watchFocus();
  }

  function showFocusBar(count) {
    let bar = document.getElementById("ko-focus-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "ko-focus-bar";
      bar.className = "ko-focus-bar";
      // 监听挂在条本身（每次只换 innerHTML），避免重绘之后按钮点不动
      bar.addEventListener("click", (ev) => {
        if (ev.target && ev.target.closest && ev.target.closest("[data-focus-exit]")) exitFocus();
      });
      document.body.appendChild(bar);
    }
    bar.innerHTML = "<span>🔒 只看刚生成的 " + count + " 张卡片</span>" +
      '<button type="button" data-focus-exit>显示全部</button>';
  }

  function exitFocus() {
    VM.focusCardIds = [];
    document.body.classList.remove("ko-card-focus");
    const bar = document.getElementById("ko-focus-bar");
    if (bar) bar.remove();
    document.querySelectorAll("article.card.ko-card-focus").forEach((el) => {
      el.classList.remove("ko-card-focus");
    });
    if (VM.focusObserver) { VM.focusObserver.disconnect(); VM.focusObserver = null; }
  }

  /**
   * 卡片页被整块重渲染时高亮类会被冲掉 → 补回来；
   * 人切到别的界面就退出聚焦，别把「只显示 N 张」赖在别的页面上。
   * ⚠️ 防抖是必须的：paintFocus 自己也会改 DOM，不防抖会自己触发自己。
   */
  function watchFocus() {
    if (VM.focusObserver || typeof MutationObserver !== "function") return;
    VM.focusObserver = new MutationObserver(() => {
      if (VM.focusBusy || !VM.focusCardIds.length) return;
      VM.focusBusy = true;
      setTimeout(() => {
        VM.focusBusy = false;
        if (!VM.focusCardIds.length) return;
        const out = document.getElementById("studio-output");
        if (!out || !out.querySelector(".cards-grid")) { exitFocus(); return; }
        if (!out.querySelector("article.card.ko-card-focus")) paintFocus(0);
      }, 200);
    });
    VM.focusObserver.observe(document.body, { childList: true, subtree: true });
  }

  /** CSS.escape 缺失时退回只转义属性选择器必需的字符。 */
  function cssEscape(v) {
    if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(v);
    return String(v).replace(/["\\]/g, "\\$&");
  }

  /**
   * 真调模型生成（十几秒），所以给按钮就地忙碌态，不做整块重绘 ——
   * 重绘会把用户滚到的位置和勾选态一起冲掉。
   */
  async function generateNodeMaterial(kind, item) {
    if (VM.genBusy) {
      notify("上一项还在生成中，稍等一下…", "info");
      return;
    }
    const pid = currentProjectId();
    const nodeId = item.getAttribute("data-node-id") || "";
    const nodeName = nodeLabelOf(item);
    if (!pid || !nodeId) {
      notify("这项任务没有绑定具体知识点，先在知识框架里把考点定下来。", "warning");
      return;
    }

    const idleText = kind === "card" ? "📇 生成卡片" : "🎯 出小测验";
    const busyText = kind === "card" ? "生成卡片中…" : "出题中…";
    const btn = item.querySelector(`[data-act="${kind}"]`);
    const acts = item.querySelectorAll(".ko-task-act");
    VM.genBusy = kind;
    acts.forEach((b) => { b.disabled = true; });
    if (btn) { btn.textContent = busyText; btn.classList.add("is-busy"); }

    try {
      if (kind === "card") {
        const data = await callApi(
          `/api/projects/${encodeURIComponent(pid)}/nodes/${encodeURIComponent(nodeId)}/card`,
          { method: "POST", body: JSON.stringify({ difficulty: 2, count: 3 }) }
        );
        const cards = Array.isArray(data.cards) ? data.cards : [];
        if (!cards.length) throw new Error("模型这次没有写出可用卡片，稍后再试一次");
        syncCardsIntoState(cards);
        // 直接进卡片界面，并把视图锁在刚生成的这几张上（其余卡片先隐掉）
        closeCalendar();
        if (typeof switchFeature === "function") switchFeature("cards");
        focusGeneratedCards(cards.map((c) => c.card_id).filter(Boolean));
        notify(`📇 「${nodeName}」新增 ${cards.length} 张卡片，已锁定在卡片界面`, "success");
      } else {
        const data = await callApi(
          `/api/projects/${encodeURIComponent(pid)}/nodes/${encodeURIComponent(nodeId)}/quiz`,
          {
            method: "POST",
            body: JSON.stringify({
              difficulty: 2,
              question_count: 5,
              question_types: ["single_choice", "multiple_choice", "fill_blank", "short_answer"],
            }),
          }
        );
        const questions = Array.isArray(data.questions) ? data.questions : [];
        if (!questions.length) throw new Error("模型这次没有出成题目，稍后再试一次");
        syncQuizIntoState(data);
        // 测验界面显示的就是 state.quiz —— 设好它就是「锁在这份新题上」
        closeCalendar();
        if (typeof switchFeature === "function") switchFeature("quiz");
        notify(`🎯 「${nodeName}」出了 ${questions.length} 道题，已锁在测验界面`, "success");
      }
    } catch (err) {
      notify(`生成失败：${(err && err.message) || err}`, "error");
    } finally {
      VM.genBusy = "";
      acts.forEach((b) => { b.disabled = false; });
      if (btn) { btn.textContent = idleText; btn.classList.remove("is-busy"); }
    }
  }

  /** 把考点写进输入框，回对话追问 —— 教学模式会按「这一问」出动作。 */
  function askAboutNode(nodeName) {
    // 优先让海小棠直接提问（自动提交、苏格拉底式温习）；桌宠未就绪时退回预填。
    const pet = window.HXT_PET;
    if (pet && typeof pet.ask === "function") {
      pet.ask(nodeName);
      notify(`已让海小棠就「${nodeName}」带你温习，去对话区看她怎么问。`, "info");
      return;
    }
    const input = document.getElementById("message-input");
    if (!input) {
      notify("找不到输入框，刷新页面后再试。", "warning");
      return;
    }
    const question =
      `请帮我讲清「${nodeName}」这个考点：核心结论是什么、推导的关键一步、` +
      "以及最容易错的边界条件。";
    try {
      const existing = String(input.value || "").trim();
      input.value = existing ? existing + "\n" + question : question;
      // app.js 靠 input 事件更新自动高度与发送按钮可用态，手动赋值要补一拍
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
      notify("已把这个问题写进输入框，回车就会带着你的学习进度来答。", "info");
    } catch (err) {
      console.warn("预填输入框失败:", err);
    }
  }

  /** requestAnimationFrame 在桩环境里可能没有，退回 setTimeout。 */
  function nextFrame(fn) {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(fn);
    else setTimeout(fn, 30);
  }

  /**
   * 任务动作分发。生成类留在台历内等结果（用户能看到进度），
   * 其余动作都要回主界面，所以先收起台历 —— 否则用户以为「点了没反应」。
   */
  function runTaskAction(act, item) {
    if (!item || !act) return;
    const nodeId = item.getAttribute("data-node-id") || "";
    const nodeName = nodeLabelOf(item);
    const cardCount = (item.getAttribute("data-card-ids") || "").split(",").filter(Boolean).length;

    // 「看考点 / 生成卡片 / 出小测验」都要求考点真在知识框架里。不在就别去点必然失败的
    // 接口（也不该装作能用）：说清原因，把人带到知识框架页。按钮是灰的，但点得动。
    if (act === "card" || act === "quiz" || act === "detail") {
      const lock = nodeLockReason(nodeId);
      if (lock) {
        closeCalendar();
        if (typeof switchFeature === "function") switchFeature("framework");
        notify(`${lock}。已为你打开知识框架：先导入资料生成框架，再回来完成这项任务。`, "info");
        return;
      }
    }

    if (act === "card" || act === "quiz") {
      generateNodeMaterial(act, item);
      return;
    }

    closeCalendar();

    if (act === "detail") {
      // 节点一定在框架里（不在的情况上面已拦下）：jumpToKbNode 只把节点在图谱上选中并
      // 平移过去，用户要的是「进入那个考点的界面」，所以再打开节点详情面板
      // （整理助手、笔记、来源原文都在那儿）。等框架页渲染完再开。
      jumpToKbNode(nodeId);
      nextFrame(() => {
        if (typeof kbOpenNode !== "function") return;
        try { kbOpenNode(nodeId); } catch (err) { console.warn("打开节点面板失败:", err); }
      });
      notify(`已进入考点「${nodeName}」`, "info");
      return;
    }

    if (act === "review") {
      if (typeof switchFeature === "function") switchFeature("cards");
      if (cardCount > 0) notify(`已切到卡片复习：这一项安排了 ${cardCount} 张到期卡片。`, "info");
      return;
    }

    if (act === "framework") {
      if (typeof switchFeature === "function") switchFeature("framework");
      return;
    }

    if (act === "quizpage") {
      if (typeof switchFeature === "function") switchFeature("quiz");
      return;
    }

    if (act === "ask") askAboutNode(nodeName);
  }

  // ---------------------------------------------------------------- 交互 --

  // 两块内容都是整块 innerHTML 重渲染，所以监听挂容器上一次就够（事件委托）。
  // 考期卡（右栏）与当日计划（中栏底部）共用同一套 handler，只是查询范围换成各自的 root。
  function bindSidebar() {
    bindContainer(VM.root);
    bindContainer(VM.dayRoot);
  }

  function bindContainer(root) {
    if (!root || root.getAttribute("data-ko-sprint-bound") === "1") return;
    root.setAttribute("data-ko-sprint-bound", "1");

    root.addEventListener("change", (ev) => {
      const cb = ev.target.closest(".ko-side-task-cb");
      if (cb) {
        const item = cb.closest(".ko-side-task");
        const taskId = item && item.getAttribute("data-task-id");
        if (taskId) toggleTask(taskId, cb.checked);
        return;
      }
      // 填了考试日期就把「学习周期」的天数同步过来，用户不用自己算
      if (ev.target.closest && ev.target.closest('[data-custom="target_date"]')) {
        syncDaysFromDate(root);
        refreshIntensityPreview(root);
        return;
      }
      // 科目下拉切到「其他」时才亮出手动输入框，避免两个输入同时存在让人犹豫填哪个
      const picker = ev.target.closest('[data-exam-field="project"]');
      if (picker) {
        const manual = root.querySelector(".ko-side-manual");
        if (manual) manual.hidden = picker.value !== MANUAL_SUBJECT;
      }
    });

    // 边改数字边给强度回执：目标分 / 周期 / 每日投入 任一改动都立刻反映
    root.addEventListener("input", (ev) => {
      const t = ev.target;
      if (!t || typeof t.closest !== "function") return;
      if (t.closest('[data-custom="target_score"]') ||
          t.closest('[data-custom="total_days"]') ||
          t.closest('[data-custom="daily_hours"]')) {
        refreshIntensityPreview(root);
      }
    });

    root.addEventListener("click", (ev) => {
      const t = ev.target;
      if (!t || typeof t.closest !== "function") return;

      const modeBtn = t.closest(".ko-side-mode");
      if (modeBtn) {
        generateSprintPlan({
          mode: modeBtn.getAttribute("data-mode"),
          total_days: parseInt(modeBtn.getAttribute("data-days"), 10),
          daily_hours: parseFloat(modeBtn.getAttribute("data-hours")),
        });
        return;
      }

      if (t.closest("[data-custom-submit]")) {
        const val = (name) => {
          const el = root.querySelector(`[data-custom="${name}"]`);
          return el ? el.value.trim() : "";
        };
        const days = parseInt(val("total_days"), 10) || 0;
        generateSprintPlan({
          mode: "custom",
          // 周期是主输入（表格里也由考期日期自动同步），目标日期只作兜底
          total_days: days > 0 ? days : 0,
          target_date: val("target_date"),
          daily_hours: parseFloat(val("daily_hours")) || 2.0,
          target_score: parseFloat(val("target_score")) || 90.0,
        });
        return;
      }

      // 生成结果就地跳进卡片 / 测验界面并锁定（focusGeneratedCards），
      // 这里不再需要「打开某处」的二次链接

      if (t.closest("[data-back-today]")) {
        setDate(todayIso());
        return;
      }

      if (t.closest("[data-enrich]")) {
        VM.enrichTried = true;
        if (VM.sprintPlan?.plan_id) enrichSprintPlan(VM.sprintPlan.plan_id);
        return;
      }

      if (t.closest("[data-export-ics]")) {
        if (VM.sprintPlan?.plan_id) {
          window.open(`/api/sprint/${encodeURIComponent(VM.sprintPlan.plan_id)}/export-ics`, "_blank");
        }
        return;
      }

      if (t.closest("[data-reset]")) {
        if (!confirm("确定重新制定冲刺计划吗？当前计划将被归档。")) return;
        VM.sprintPlan = null;
        publishSprintDays();
        renderSidebar();
        return;
      }

      const actBtn = t.closest("[data-act]");
      if (actBtn) {
        runTaskAction(actBtn.getAttribute("data-act"), actBtn.closest(".ko-side-task"));
        return;
      }

      const toSprint = t.closest("[data-exam-sprint]");
      if (toSprint) {
        generateSprintPlan({
          mode: "sprint",
          course_name: toSprint.getAttribute("data-subject") || "",
          target_date: toSprint.getAttribute("data-date") || "",
        });
        return;
      }

      const del = t.closest("[data-exam-del]");
      if (del) {
        const wrap = del.closest(".ko-side-exam");
        const id = wrap && wrap.getAttribute("data-exam-id");
        if (!id) return;
        if (!confirm("确定删除该考期记录吗？")) return;
        deleteExam(id);
        return;
      }

      if (t.closest("[data-exam-submit]")) {
        const field = (name) => {
          const el = root.querySelector(`[data-exam-field="${name}"]`);
          return el ? el.value.trim() : "";
        };
        const date = field("date");
        // 选了项目：科目取项目名，并把考期挂到那个项目上（冲刺计划才能对上知识库）；
        // 选「其他」或没有项目：用手动输入，挂当前项目。
        const pick = field("project");
        let subject = "";
        let projectId = currentProjectId();
        if (pick && pick !== MANUAL_SUBJECT) {
          const hit = examProjects().find((p) => p.project_id === pick);
          subject = examProjectSubject(hit);
          projectId = pick;
        } else {
          subject = field("subject");
        }
        if (!subject || !date) {
          notify("科目名称与考试日期为必填项", "warning");
          return;
        }
        addExam({
          course_name: subject,
          exam_time: date,
          location: field("location"),
          project_id: projectId,
        });
        return;
      }
    });
  }

  // ---------------------------------------------------------------- 入口 --

  // 2026-09-26：按用户要求，输入框旁的「🎯 冲刺计划」按钮已删除。
  // 台历（含冲刺计划）的入口只剩两个：顶栏打卡徽标（streak.js）与左栏课程页的
  // 「按此课程排冲刺」。openCalendar 与 window.KnowOriginSprint.openCalendar 保留，
  // 供台历内跳转与外部调用。

  // ---------------------------------------------------------------- 对外 --

  function mount(el) {
    ensureStyle();
    VM.root = el;
    bindSidebar();
    loadExams();
    loadActiveSprintPlan();
  }

  /** 中栏底部「当日计划」插槽 —— 跟着台历选中的那一天走。 */
  function mountDayPlan(el) {
    ensureStyle();
    VM.dayRoot = el;
    bindSidebar();
    renderDayPanel();
  }

  function setDate(dateKey) {
    const next = dateKey || "";
    if (VM.selectedDate === next) return;
    VM.selectedDate = next;
    renderDayPanel();
  }

  function refresh() {
    loadExams();
    loadActiveSprintPlan();
  }

  window.KnowOriginSprint = {
    mount: mount,
    mountDayPlan: mountDayPlan,
    setDate: setDate,
    refresh: refresh,
    openCalendar: openCalendar,
    // 左栏课程导航要用考期算「距考期 N 天」—— 只读快照，不另拉一次接口
    getExams: function () { return VM.exams || []; },
    // 左栏课程页「按此路径制定冲刺计划」走这里 —— 参数可带 project_id 覆盖当前项目
    generate: generateSprintPlan,
  };

  // 切换项目后，按项目过滤的冲刺计划要跟着换：重拉当前项目的计划（考期跨项目，一并刷新）。
  // 台历没打开时 VM.root/dayRoot 为空，refresh 内部有 guard，不会报错；下次打开 mount 也会重拉。
  document.addEventListener("knoworigin:project-switched", () => {
    refresh();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      ensureStyle();
    });
  } else {
    ensureStyle();
  }
})();