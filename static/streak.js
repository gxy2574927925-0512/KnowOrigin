// 学习连续打卡徽章 + 全屏「学习台历」。
// 徽章每 60 秒拉一次 /api/me/streak；点击徽章打开台历。
// 数据来源 /api/me/streak 与 /api/me/learning-calendar（聚合 learning_events 表，无新表）。
//
// 台历是**三栏工作台**：左栏课程导航（每门课下挂速查表 / 学习路径），
// 中栏月历 + 底部「当日计划 / 当日记录」，右栏只放考期备忘一张卡。
// 本文件只负责外壳与插槽，三方用 CustomEvent 解耦：
//   window.KnowOriginDesk    （study-desk-ui.js）   → 课程导航 + 速查表 / 学习路径页
//   window.KnowOriginSprint  （exam-countdown-ui.js）→ 当日计划面板 + 考期备忘卡
// 事件契约：
//   knoworigin:exam-dates    冲刺模块 → 本文件   在日历格上标出考期
//   knoworigin:sprint-days   冲刺模块 → 本文件   在日历格上标出冲刺计划覆盖日
//   knoworigin:calendar-close 冲刺模块 → 本文件  任务跳转前收起台历
//   本文件 → KnowOriginSprint.setDate(dateKey)  点日历某天 → 侧栏切成那天的清单
//
// ponytail: 月份 key、网格对齐、事件缓存均沿用 UTC 日历；
// CST 用户跨 UTC 0 点的归属偏差与 /api/me/streak 一致，注释保留，不修复。
(function () {
  const badge = document.getElementById("streak-badge");
  const countEl = document.getElementById("streak-count");
  if (!badge || !countEl) return;

  let timerId = null;
  let calendarData = null;
  let calendarLoading = false;
  let selectedDate = null;
  let todayYear = null;        // 用 data.today 锚定的「真实今天」(UTC)
  let todayMonth = null;
  let todayDay = null;
  let viewYear = null;
  let viewMonth = null;        // 0-11
  const dayEventsCache = new Map();
  let examDates = {};          // { "YYYY-MM-DD": ["光电子技术", ...] } 来自冲刺模块
  let sprintDays = {};         // { "YYYY-MM-DD": 4 } 当日冲刺任务数，来自冲刺模块
  // 左右两栏（rail 课程导航 / side 考期备忘）各自的收起状态
  const collapsePref = { rail: false, side: false };

  // 键集必须与后端 /api/mastery/rules 的 kind_labels 对齐（question / solve / card / quiz / discuss）。
  // 台历要多画一层彩色圆点，颜色后端不下发，所以这里留一份完整副本 ——
  // 漏一档就会降级成英文 kind 字面量 + 灰点（discuss 就漏过）。
  const KIND_LABELS = {
    question: "提问",
    solve: "做题",
    card: "卡片",
    quiz: "测验",
    discuss: "讨论",
  };
  const KIND_COLORS = {
    question: "#e8a14a",
    solve: "#5b9bd5",
    card: "#a98cd6",
    quiz: "#5fa66b",
    discuss: "#d4799a",
  };

  async function safeFetch(url, options) {
    try {
      const r = await fetch(url, Object.assign({ credentials: "same-origin" }, options || {}));
      if (r.status === 401) return null;
      if (!r.ok) return null;
      return await r.json();
    } catch (_) {
      return null;
    }
  }

  async function fetchStreak() {
    const data = await safeFetch("/api/me/streak");
    if (!data) {
      badge.hidden = true;
      return;
    }
    const current = Number(data.current_streak) || 0;
    const todayActive = Boolean(data.today_active);
    countEl.textContent = String(current);
    badge.hidden = false;
    badge.classList.toggle("is-today", todayActive && current > 0);
    badge.classList.toggle("is-broken", !todayActive && current > 0);
    const longest = Number(data.longest_streak) || 0;
    const total = Number(data.total_active_days) || 0;
    badge.title =
      (todayActive ? "今天已打卡 · " : "今天还没打卡 · ") +
      "连续 " + current + " 天 · 历史最长 " + longest + " 天 · 累计 " + total + " 天 · 点击打开学习台历";
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function pad2(n) { return String(n).padStart(2, "0"); }

  // 把后端返回的 UTC ISO 时间转成浏览器本地时区的 HH:MM（“真实时间”）
  function localTimeStr(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "--:--";
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function intensityClass(n) {
    if (n <= 0) return "is-empty";
    if (n < 5) return "is-low";
    if (n < 15) return "is-mid";
    if (n < 40) return "is-high";
    return "is-peak";
  }

  function parseUtcDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    if (!m) return new Date();
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  }

  function utcDateToIso(d) {
    return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
  }

  function shiftMonth(year, month, delta) {
    // month: 0-11; 返回新的 [year, month]
    const total = year * 12 + month + delta;
    return [Math.floor(total / 12), ((total % 12) + 12) % 12];
  }

  function monthLabel(year, month) {
    return year + " 年 " + pad2(month + 1) + " 月";
  }

  function todayIso() {
    if (todayYear == null) return "";
    return utcDateToIso(new Date(Date.UTC(todayYear, todayMonth, todayDay)));
  }

  // ---------------------------------------------------------------- 外壳 --

  function ensureCalendarDialog() {
    let dlg = document.getElementById("streak-calendar-dialog");
    if (dlg) return dlg;
    ensureShellStyle();
    dlg = document.createElement("dialog");
    dlg.id = "streak-calendar-dialog";
    dlg.className = "streak-calendar-dialog";
    dlg.innerHTML =
      '<form method="dialog" class="streak-calendar-inner" onsubmit="event.preventDefault()">' +
        '<header class="streak-calendar-header">' +
          '<div class="streak-calendar-titleblock">' +
            '<h3>学习台历</h3>' +
            '<p id="streak-calendar-subtitle" class="streak-calendar-sub">加载中…</p>' +
          '</div>' +
          '<button type="button" class="streak-calendar-close" aria-label="关闭" title="关闭">×</button>' +
        '</header>' +
        '<div class="streak-calendar-main">' +
          // 左：课程导航（速查表 / 学习路径挂在各门课程下），由 study-desk-ui.js 挂载。
          // 收起开关挂在这列最上（见 applyCollapsed）：收起后整列缩成细轨，把宽度还给月历
          '<div class="streak-cal-railwrap">' +
            '<button type="button" id="streak-rail-toggle" class="streak-col-toggle" ' +
              'aria-expanded="true" aria-controls="streak-cal-rail">›</button>' +
            '<nav class="streak-cal-rail" id="streak-cal-rail"></nav>' +
          '</div>' +
          '<section class="streak-calendar-left">' +
            '<div class="streak-cal-wrap" id="streak-cal-wrap">' +
              '<div class="streak-calendar-monthbar">' +
                '<button type="button" id="streak-cal-prev" class="streak-cal-nav" aria-label="上一月">‹</button>' +
                '<span id="streak-cal-month-label" class="streak-cal-month-label">—</span>' +
                '<button type="button" id="streak-cal-next" class="streak-cal-nav" aria-label="下一月">›</button>' +
                '<button type="button" id="streak-cal-today" class="streak-cal-today-btn">回到今天</button>' +
              '</div>' +
              '<div id="streak-calendar-grid" class="streak-calendar-grid"></div>' +
            '</div>' +
            // 中：课程页（速查表 / 学习路径）与月历互斥 —— 看课程页时月历整块让位
            '<div id="streak-desk-view" class="streak-desk-view" hidden></div>' +
            '<section class="streak-cal-bottom" id="streak-cal-bottom">' +
              '<div class="streak-cal-tabs">' +
                '<button type="button" class="streak-cal-tab is-on" data-cal-tab="plan">当日计划</button>' +
                '<button type="button" class="streak-cal-tab" data-cal-tab="log">当日记录</button>' +
              '</div>' +
              '<div class="streak-cal-panes">' +
                '<div id="streak-plan-slot" class="streak-cal-pane" data-pane="plan"></div>' +
                '<div id="streak-calendar-detail" class="streak-calendar-detail streak-cal-pane" data-pane="log" hidden></div>' +
              '</div>' +
            '</section>' +
          '</section>' +
          // 右：只放考期备忘一张卡 —— 冲刺计划已改到中栏「当日计划」页签。
          // 收起开关也挂这一栏（见 applyCollapsed）：收起后整列缩成细轨，把宽度还给月历
          '<aside class="streak-calendar-side" id="streak-calendar-side">' +
            '<button type="button" id="streak-side-toggle" class="streak-col-toggle" ' +
              'aria-expanded="true" aria-controls="streak-side-sprint">›</button>' +
            '<div class="streak-side-slot" id="streak-side-sprint"></div>' +
          '</aside>' +
        '</div>' +
      '</form>';
    document.body.appendChild(dlg);
    dlg.querySelector(".streak-calendar-close").addEventListener("click", () => dlg.close());
    dlg.addEventListener("click", (ev) => {
      const rect = dlg.getBoundingClientRect();
      if (
        ev.clientX < rect.left || ev.clientX > rect.right ||
        ev.clientY < rect.top || ev.clientY > rect.bottom
      ) dlg.close();
    });
    dlg.querySelector("#streak-cal-prev").addEventListener("click", () => navigateMonth(-1));
    dlg.querySelector("#streak-cal-next").addEventListener("click", () => navigateMonth(+1));
    dlg.querySelector("#streak-cal-today").addEventListener("click", () => jumpToToday());
    dlg.querySelector("#streak-side-toggle").addEventListener("click", () => {
      applyCollapsed("side", !collapsePref.side);
    });
    dlg.querySelector("#streak-rail-toggle").addEventListener("click", () => {
      applyCollapsed("rail", !collapsePref.rail);
    });
    // 每次建壳都恢复左右两栏上次的收起/展开状态（首建即读 localStorage）
    applyCollapsed("side", readCollapsedPref("side"));
    applyCollapsed("rail", readCollapsedPref("rail"));
    return dlg;
  }

  // 三个插槽分别交给注入式模块自己渲染。脚本都是 defer 且本文件先执行，
  // 所以只能在「打开台历」这一刻挂载 —— 那时这些全局一定已定义。
  //   #streak-cal-rail     课程导航（课程 → 速查表 / 学习路径）
  //   #streak-desk-view    课程页正文
  //   #streak-plan-slot    当日冲刺计划（跟着日历选中的那天走）
  //   #streak-side-sprint  考期备忘（右侧唯一一张卡）
  function mountPanels() {
    bindBottomTabs();
    const sprint = window.KnowOriginSprint;
    const sprintSlot = document.getElementById("streak-side-sprint");
    if (sprintSlot && sprint && typeof sprint.mount === "function") {
      try { sprint.mount(sprintSlot); } catch (e) { console.warn("挂载考期备忘失败:", e); }
    }
    const planSlot = document.getElementById("streak-plan-slot");
    if (planSlot && sprint && typeof sprint.mountDayPlan === "function") {
      try { sprint.mountDayPlan(planSlot); } catch (e) { console.warn("挂载当日计划失败:", e); }
    }
    const desk = window.KnowOriginDesk;
    const railSlot = document.getElementById("streak-cal-rail");
    const viewSlot = document.getElementById("streak-desk-view");
    if (railSlot && desk && typeof desk.mountRail === "function") {
      try { desk.mountRail(railSlot); } catch (e) { console.warn("挂载课程导航失败:", e); }
    }
    if (viewSlot && desk && typeof desk.mountView === "function") {
      try { desk.mountView(viewSlot); } catch (e) { console.warn("挂载课程页失败:", e); }
    }
  }

  // —— 左右两栏（课程导航 / 考期备忘）收起/展开 ——
  // 收起不是把卡片折起来，而是把整列缩成一条竖排细轨（236px → 44px），
  // 让出的宽度全部给月历。左右状态各记各的 localStorage，下次打开台历保持原样。
  const COLLAPSE_KEY = {
    rail: "knoworigin:calendar-rail-collapsed",
    side: "knoworigin:calendar-side-collapsed",
  };

  function readCollapsedPref(which) {
    try { return localStorage.getItem(COLLAPSE_KEY[which]) === "1"; } catch (_) { return false; }
  }

  function applyCollapsed(which, collapsed) {
    collapsePref[which] = Boolean(collapsed);
    const dlg = ensureCalendarDialog();
    const main = dlg.querySelector(".streak-calendar-main");
    const btn = dlg.querySelector("#streak-" + which + "-toggle");
    if (!main || !btn) return;
    const cls = which === "rail" ? "is-rail-collapsed" : "is-side-collapsed";
    const label = which === "rail" ? "课程导航" : "考期备忘";
    main.classList.toggle(cls, collapsePref[which]);
    btn.textContent = collapsePref[which] ? "‹ " + label : "›";
    btn.setAttribute("aria-expanded", collapsePref[which] ? "false" : "true");
    btn.title = collapsePref[which] ? "展开" + label : "收起" + label + "，把空间让给月历";
    try { localStorage.setItem(COLLAPSE_KEY[which], collapsePref[which] ? "1" : "0"); } catch (_) {}
  }

  /** 底部两个页签：当日计划（冲刺）/ 当日记录（学习活动），互斥显示。 */
  function bindBottomTabs() {
    const dlg = ensureCalendarDialog();
    const bar = dlg.querySelector(".streak-cal-tabs");
    if (!bar || bar.getAttribute("data-ko-bound") === "1") return;
    bar.setAttribute("data-ko-bound", "1");
    bar.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".streak-cal-tab");
      if (!btn) return;
      const name = btn.getAttribute("data-cal-tab");
      dlg.querySelectorAll(".streak-cal-tab").forEach((b) => {
        b.classList.toggle("is-on", b === btn);
      });
      dlg.querySelectorAll(".streak-cal-pane").forEach((p) => {
        p.hidden = p.getAttribute("data-pane") !== name;
      });
    });
  }

  /**
   * 中栏视图切换：calendar（月历 + 底部计划/记录）与 desk（课程页）互斥。
   * 用 hidden 而不是 display 内联样式 —— 下次打开台历要能干净地切回来。
   */
  function setView(mode) {
    const dlg = ensureCalendarDialog();
    const wrap = dlg.querySelector("#streak-cal-wrap");
    const bottom = dlg.querySelector("#streak-cal-bottom");
    const view = dlg.querySelector("#streak-desk-view");
    if (!wrap || !bottom || !view) return;
    const isDesk = mode === "desk";
    wrap.hidden = isDesk;
    bottom.hidden = isDesk;
    view.hidden = !isDesk;
  }

  // 外壳新增的三个容器（课程导航 / 课程页 / 底部页签）样式自带，不进 styles.css。
  const SHELL_STYLE_ID = "ko-calendar-shell-style";
  function ensureShellStyle() {
    if (document.getElementById(SHELL_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = SHELL_STYLE_ID;
    style.textContent = [
      ".streak-calendar-dialog .streak-calendar-main{",
      "grid-template-columns:236px minmax(0,1fr) 336px;gap:14px}",
      "@media (max-width:1180px){.streak-calendar-dialog .streak-calendar-main{",
      "grid-template-columns:200px minmax(0,1fr) 280px}}",
      // ⚠️ 下面三块之间有互斥的 hidden 切换，而 .streak-cal-wrap / .streak-cal-bottom
      // 自己写了 display:grid —— 作者样式会盖掉 UA 的 [hidden]{display:none}，
      // 结果就是「切到课程页时月历赖着不走」。必须显式补一条。
      ".streak-calendar-dialog .streak-cal-wrap[hidden],",
      ".streak-calendar-dialog .streak-cal-bottom[hidden],",
      ".streak-calendar-dialog .streak-desk-view[hidden]{display:none !important}",
      ".streak-cal-rail{min-width:0;min-height:0;overflow-y:auto;overscroll-behavior:contain;",
      "border:1px solid var(--line);border-radius:12px;background:var(--background);padding:10px 8px}",
      // 中栏是「月历 + 当日计划」一整条纵向内容：滚动条只留一个，就挂在这一层。
      // 底部面板不再自己滚 —— 嵌套滚动区既让人找不到内容，也滚不到想滚的地方。
      ".streak-calendar-dialog .streak-calendar-left{grid-template-rows:auto auto;",
      "gap:8px;overflow-y:auto;overscroll-behavior:contain}",
      ".streak-cal-wrap{display:grid;grid-template-rows:auto auto;gap:8px;min-width:0}",
      // 月历格子靠 flex:1 拉伸填满容器 → 这里必须给网格一个确定高度，
      // 否则行高会塌成一条线（整体滚动后已经没有 1fr 轨道替它撑高了）
      ".streak-calendar-dialog .streak-calendar-grid{height:clamp(300px,44vh,420px);overflow:hidden}",
      // 未来但有冲刺计划 / 考期的日子：保持可点，悬停给同款反馈
      ".streak-calendar-dialog .streak-day-cell.is-future-planned{cursor:pointer;opacity:.8}",
      ".streak-calendar-dialog .streak-day-cell.is-future-planned:hover{transform:scale(1.06);",
      "box-shadow:0 2px 8px rgba(0,0,0,.10);z-index:1}",
      ".streak-desk-view{min-width:0}",
      // 底部面板不再自己滚，高度交给内容（整条中栏一起滚）
      ".streak-cal-bottom{display:grid;grid-template-rows:auto auto;gap:6px}",
      ".streak-cal-tabs{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".streak-cal-tab{border:1px solid var(--line);background:transparent;color:var(--muted);",
      "border-radius:8px;padding:4px 12px;font-size:calc(12px * var(--font-scale, 1));font-family:inherit;cursor:pointer}",
      ".streak-cal-tab:hover{color:var(--ink);border-color:var(--green)}",
      ".streak-cal-tab.is-on{background:var(--green);border-color:var(--green);color:#0e1410;font-weight:600}",
      ".streak-cal-panes{display:block;min-width:0}",
      ".streak-cal-pane{min-width:0}",
      ".streak-calendar-dialog .streak-calendar-detail{max-height:none}",
      // —— 左右两栏收起开关：展开时是各栏顶部一颗小箭头；收起后按钮自己变成竖排细轨 ——
      ".streak-col-toggle{justify-self:end;align-self:start;border:1px solid var(--line);",
      "background:var(--background);color:var(--muted);border-radius:8px;min-width:26px;height:22px;",
      "padding:0 6px;font-size:calc(12px * var(--font-scale, 1));line-height:1;font-family:inherit;cursor:pointer;",
      "transition:border-color .15s ease,background .15s ease,color .15s ease}",
      ".streak-col-toggle:hover{color:var(--ink);border-color:var(--green);background:var(--green-soft)}",
      // 左列容器：toggle 一行 + 课程导航一列；收起时 nav 藏掉、只剩竖排轨
      ".streak-cal-railwrap{display:grid;grid-template-rows:auto minmax(0,1fr);gap:8px;",
      "min-width:0;min-height:0}",
      // —— 收起：被收的那一列从 236/336px 缩到 44px，月历拿走全部让出的宽度 ——
      ".streak-calendar-dialog .streak-calendar-main.is-rail-collapsed{",
      "grid-template-columns:44px minmax(0,1fr) 336px}",
      ".streak-calendar-dialog .streak-calendar-main.is-side-collapsed{",
      "grid-template-columns:236px minmax(0,1fr) 44px}",
      ".streak-calendar-dialog .streak-calendar-main.is-rail-collapsed.is-side-collapsed{",
      "grid-template-columns:44px minmax(0,1fr) 44px}",
      // 收起时：藏内容 + 该列容器改单行拉伸，让按钮铺满整条细轨
      ".streak-calendar-dialog .streak-calendar-main.is-rail-collapsed .streak-cal-rail{display:none}",
      ".streak-calendar-dialog .streak-calendar-main.is-rail-collapsed .streak-cal-railwrap{",
      "grid-template-rows:minmax(0,1fr);overflow:hidden}",
      ".streak-calendar-dialog .streak-calendar-main.is-side-collapsed .streak-side-slot{display:none}",
      ".streak-calendar-dialog .streak-calendar-main.is-side-collapsed .streak-calendar-side{",
      "align-content:stretch;padding-right:0;overflow:hidden}",
      ".streak-calendar-dialog .streak-calendar-main.is-rail-collapsed .streak-cal-railwrap .streak-col-toggle,",
      ".streak-calendar-dialog .streak-calendar-main.is-side-collapsed .streak-calendar-side .streak-col-toggle{",
      "writing-mode:vertical-rl;justify-self:stretch;align-self:stretch;min-width:0;height:auto;",
      "border-radius:10px;padding:10px 0;letter-spacing:2px}",
      "@media (max-width:1180px){",
      ".streak-calendar-dialog .streak-calendar-main.is-rail-collapsed{",
      "grid-template-columns:40px minmax(0,1fr) 280px}",
      ".streak-calendar-dialog .streak-calendar-main.is-side-collapsed{",
      "grid-template-columns:200px minmax(0,1fr) 40px}",
      ".streak-calendar-dialog .streak-calendar-main.is-rail-collapsed.is-side-collapsed{",
      "grid-template-columns:40px minmax(0,1fr) 40px}}",
    ].join("");
    document.head.appendChild(style);
  }

  function navigateMonth(delta) {
    if (viewYear == null || viewMonth == null) return;
    const [ny, nm] = shiftMonth(viewYear, viewMonth, delta);
    viewYear = ny;
    viewMonth = nm;
    renderCalendar();
  }

  function jumpToToday() {
    if (todayYear == null) return;
    viewYear = todayYear;
    viewMonth = todayMonth;
    renderCalendar();
  }

  async function loadCalendar() {
    if (calendarLoading) return;
    calendarLoading = true;
    const dlg = ensureCalendarDialog();
    const grid = dlg.querySelector("#streak-calendar-grid");
    const sub = dlg.querySelector("#streak-calendar-subtitle");
    const detail = dlg.querySelector("#streak-calendar-detail");
    const monthLabelEl = dlg.querySelector("#streak-cal-month-label");
    sub.textContent = "加载中…";
    grid.innerHTML = '<p class="streak-calendar-loading">正在拉取最近一年的学习活动…</p>';
    detail.innerHTML = "";
    monthLabelEl.textContent = "—";
    const data = await safeFetch("/api/me/learning-calendar?days=365");
    calendarLoading = false;
    if (!data) {
      sub.textContent = "无法加载";
      grid.innerHTML = '<p class="streak-calendar-empty">网络或登录异常，暂时无法加载学习台历。请稍后再试。</p>';
      return;
    }
    calendarData = data;
    dayEventsCache.clear();
    selectedDate = null;
    const todayUtc = parseUtcDate(data.today);
    todayYear = todayUtc.getUTCFullYear();
    todayMonth = todayUtc.getUTCMonth();
    todayDay = todayUtc.getUTCDate();
    viewYear = todayYear;
    viewMonth = todayMonth;
    renderCalendar();
  }

  function renderCalendar() {
    if (!calendarData) return;
    const dlg = ensureCalendarDialog();
    const sub = dlg.querySelector("#streak-calendar-subtitle");
    const grid = dlg.querySelector("#streak-calendar-grid");
    const monthLabelEl = dlg.querySelector("#streak-cal-month-label");
    const totalActive = (calendarData.active_dates || []).length;
    const totalEvents = calendarData.total_events || 0;
    sub.textContent =
      "近一年 " + totalActive + " 天有动静 · " + totalEvents + " 条记录";
    monthLabelEl.textContent = monthLabel(viewYear, viewMonth);

    const daysDetail = calendarData.days_detail || {};
    const firstOfMonth = new Date(Date.UTC(viewYear, viewMonth, 1));
    // 周一对齐
    const startDow = (firstOfMonth.getUTCDay() + 6) % 7;
    const gridStart = new Date(firstOfMonth);
    gridStart.setUTCDate(gridStart.getUTCDate() - startDow);

    const weekdayLabels = ["一", "二", "三", "四", "五", "六", "日"];
    let html = '<div class="streak-weekday-row">';
    for (const w of weekdayLabels) html += '<div class="streak-weekday">' + w + '</div>';
    html += "</div>";
    html += '<div class="streak-calendar-cells">';

    let firstSelectedKey = null;
    for (let i = 0; i < 42; i++) {
      const cursor = new Date(gridStart);
      cursor.setUTCDate(gridStart.getUTCDate() + i);
      const iso = utcDateToIso(cursor);
      const detail = daysDetail[iso];
      const inView = cursor.getUTCMonth() === viewMonth && cursor.getUTCFullYear() === viewYear;
      const isToday =
        cursor.getUTCFullYear() === todayYear &&
        cursor.getUTCMonth() === todayMonth &&
        cursor.getUTCDate() === todayDay;
      const isFuture = cursor > new Date(Date.UTC(todayYear, todayMonth, todayDay));
      const evCount = detail ? Number(detail.event_count) || 0 : 0;
      const examsOnDay = examDates[iso] || [];
      const sprintCount = Number(sprintDays[iso]) || 0;
      const klass = [
        "streak-day-cell",
        intensityClass(evCount),
        inView ? "" : "is-other-month",
        isToday ? "is-today" : "",
        isFuture ? "is-future" : "",
        // 未来的日子本来禁点（没学习记录可看），但冲刺计划与考期都排在将来 ——
        // 这类格子必须能点进去看「那天要做什么」，否则日历上的计划点不开。
        isFuture && (sprintCount > 0 || examsOnDay.length) ? "is-future-planned" : "",
        examsOnDay.length ? "has-exam" : "",
        sprintCount > 0 ? "is-sprint" : "",
      ].filter(Boolean).join(" ");
      const bits = [iso];
      if (examsOnDay.length) bits.push("考试：" + examsOnDay.join("、"));
      bits.push(evCount ? evCount + " 次活动" : (inView ? "无活动" : ""));
      if (sprintCount) bits.push("冲刺计划 " + sprintCount + " 项任务");
      const tip = bits.filter(Boolean).join(" · ");
      html += '<div class="' + klass + '" data-date="' + iso + '"' +
              ' data-month="' + (inView ? "1" : "0") + '"' +
              ' title="' + escapeHtml(tip) + '">' +
              '<span class="streak-day-num">' + cursor.getUTCDate() + '</span>' +
              (examsOnDay.length
                ? '<span class="streak-day-exam" aria-hidden="true">考</span>'
                : (isToday ? '<span class="streak-day-today-mark" aria-hidden="true">今</span>' : '')) +
              (evCount > 0 ? '<span class="streak-day-count">' + evCount + '</span>' : '') +
              (sprintCount > 0 ? '<span class="streak-day-sprint" aria-hidden="true"></span>' : '') +
              '</div>';
      if (firstSelectedKey == null && inView && !isFuture) firstSelectedKey = iso;
    }
    html += "</div>";
    grid.innerHTML = html;

    grid.querySelectorAll(".streak-day-cell").forEach((cell) => {
      cell.addEventListener("click", () => {
        const dateKey = cell.dataset.date;
        if (!dateKey) return;
        if (cell.classList.contains("is-future") && !cell.classList.contains("is-future-planned")) return;
        const inView = cell.dataset.month === "1";
        if (!inView) {
          const utcD = parseUtcDate(dateKey);
          viewYear = utcD.getUTCFullYear();
          viewMonth = utcD.getUTCMonth();
          selectedDate = dateKey;
          renderCalendar();   // 换月后重绘；renderCalendar 会保留已选中的这一天
          return;
        }
        selectDate(dateKey);
      });
    });

    // ▶ 按钮 / 今天按钮状态
    const isAtCurrentMonth = (viewYear === todayYear && viewMonth === todayMonth);
    const navNext = dlg.querySelector("#streak-cal-next");
    navNext.disabled = isAtCurrentMonth;
    const todayBtn = dlg.querySelector("#streak-cal-today");
    todayBtn.disabled = isAtCurrentMonth;

    // 已选中的那天若还落在本月网格里就保持不动 —— 侧栏/详情重绘不该把用户的选点弹走
    // （冲刺计划打卡、考期增删都会触发重绘，这条保证联动时不跳日期）
    if (selectedDate && grid.querySelector('.streak-day-cell[data-date="' + selectedDate + '"]')) {
      selectDate(selectedDate);
      return;
    }

    // 选中默认日：优先 today；今天没学习记录、也没安排（冲刺/考期）才退到最近的活跃日
    let autoDate = utcDateToIso(new Date(Date.UTC(todayYear, todayMonth, todayDay)));
    const todayArranged = Number(sprintDays[autoDate]) > 0 || (examDates[autoDate] || []).length > 0;
    if (!daysDetail[autoDate] && !todayArranged) {
      const actives = calendarData.active_dates || [];
      if (actives.length) autoDate = actives[0];
      else if (firstSelectedKey) autoDate = firstSelectedKey;
    }
    if (autoDate) selectDate(autoDate);
  }

  async function selectDate(dateKey) {
    if (!dateKey || !calendarData) return;
    const dlg = ensureCalendarDialog();
    // 侧栏（冲刺计划）始终跟随台历选中的这一天 —— 这是「日历 ↔ 计划」的联动口
    const sprint = window.KnowOriginSprint;
    if (sprint && typeof sprint.setDate === "function") {
      try { sprint.setDate(dateKey); } catch (e) { console.warn("同步冲刺侧栏失败:", e); }
    }
    if (selectedDate === dateKey && dayEventsCache.has(dateKey)) {
      highlightSelected(dateKey);
      renderDetail(dateKey, dayEventsCache.get(dateKey) || []);
      return;
    }
    selectedDate = dateKey;
    highlightSelected(dateKey);
    const detail = dlg.querySelector("#streak-calendar-detail");
    const dayInfo = (calendarData.days_detail || {})[dateKey];
    if (!dayInfo && !(examDates[dateKey] || []).length) {
      detail.innerHTML = '<p class="streak-calendar-empty">' + escapeHtml(dateKey) +
        ' · 这一天还没有学习记录。</p>';
      return;
    }
    detail.innerHTML = '<p class="streak-calendar-loading">加载当日记录…</p>';
    let events = dayEventsCache.get(dateKey);
    if (!events) {
      const data = await safeFetch(
        "/api/me/learning-calendar/" + encodeURIComponent(dateKey) + "?limit=80"
      );
      events = (data && Array.isArray(data.events)) ? data.events : [];
      dayEventsCache.set(dateKey, events);
    }
    renderDetail(dateKey, events);
  }

  function highlightSelected(dateKey) {
    const dlg = ensureCalendarDialog();
    dlg.querySelectorAll(".streak-day-cell").forEach((cell) => {
      cell.classList.toggle("is-selected", cell.dataset.date === dateKey);
    });
  }

  function renderDetail(dateKey, events) {
    const dlg = ensureCalendarDialog();
    const detail = dlg.querySelector("#streak-calendar-detail");
    const dayInfo = (calendarData.days_detail || {})[dateKey] || {};
    const examsOnDay = examDates[dateKey] || [];
    let html = '<div class="streak-detail-summary">';
    html += '<h4>' + escapeHtml(dateKey) + ' · ' +
      escapeHtml(String((dayInfo.event_count != null ? dayInfo.event_count : events.length))) + ' 条事件</h4>';
    if (examsOnDay.length) {
      html += '<p class="streak-detail-exam">📌 这天考：<strong>' +
        escapeHtml(examsOnDay.join("、")) + '</strong></p>';
    }
    const projectList = (dayInfo.project_names || []).join("、");
    if (projectList) html += '<p class="streak-detail-projects">项目：' + escapeHtml(projectList) + '</p>';
    if (dayInfo.correct_rate !== null && dayInfo.correct_rate !== undefined) {
      const pct = Math.round(Number(dayInfo.correct_rate) * 100);
      html += '<p class="streak-detail-rate">做题/测验正确率：<strong>' + pct + '%</strong></p>';
    }
    if ((dayInfo.top_nodes || []).length) {
      html += '<p class="streak-detail-nodes">主要知识点：' +
        escapeHtml(dayInfo.top_nodes.join("、")) + '</p>';
    }
    html += '</div>';

    if (!events.length) {
      html += '<p class="streak-calendar-empty">这一天没有可显示的事件。</p>';
      detail.innerHTML = html;
      return;
    }
    html += '<ul class="streak-event-list">';
    for (const e of events) {
      const label = KIND_LABELS[e.kind] || e.kind || "事件";
      const color = KIND_COLORS[e.kind] || "#bbb";
      const nodeText = e.node_name || "未分类";
      const courseText = e.project_name || "未命名项目";
      const isRootNode = nodeText === courseText;
      const nodeLabelHtml = isRootNode
        ? '<span class="streak-event-node is-root">整个项目</span>'
        : '<span class="streak-event-node">' + escapeHtml(nodeText) + '</span>';
      const courseHtml = '<span class="streak-event-course">' + escapeHtml(courseText) + '</span>';
      const isScored = (e.kind === "quiz" || e.kind === "solve") &&
        e.correctness !== null && e.correctness !== undefined;
      const corrHtml = isScored
        ? ' <span class="streak-event-corr">' + Math.round(Number(e.correctness) * 100) + '%</span>'
        : '';
      const content = e.content ? String(e.content).replace(/\s+/g, " ").trim() : "";
      const contentHtml = content
        ? '<div class="streak-event-content">「' + escapeHtml(truncate(content, 80)) + '」</div>'
        : '';
      const refId = e.reference_id || "";
      const nodeId = e.node_id || "";
      const projectId = e.project_id || "";
      const messageId = e.message_id || "";
      // ponytail: 可跳 = 有卡片/测验的 reference_id，或能落到知识节点，或能回到对应对话消息；
      // 目标视图由 app.js 决定，这里只负责把定位信息带过去（与 app.js 解耦）。
      const canJump = Boolean(refId) || Boolean(nodeId) || Boolean(messageId);
      const jumpAttrs = canJump
        ? ' data-jump-kind="' + escapeHtml(e.kind || "") + '"' +
          ' data-jump-ref="' + escapeHtml(refId) + '"' +
          ' data-jump-project="' + escapeHtml(projectId) + '"' +
          ' data-jump-node="' + escapeHtml(nodeId) + '"' +
          ' data-jump-message="' + escapeHtml(messageId) + '"' +
          ' data-jump-project-name="' + escapeHtml(courseText) + '"' +
          ' title="点击跳转到对应内容"'
        : '';
      html += '<li class="streak-event-item' + (canJump ? ' is-clickable' : '') + '"' + jumpAttrs + '>' +
        '<span class="streak-event-dot" style="background:' + color + '"></span>' +
        '<div class="streak-event-main">' +
          '<span class="streak-event-time">' +
            escapeHtml(e.created_at ? localTimeStr(e.created_at) : (e.time || "--:--")) + '</span>' +
          '<span class="streak-event-kind">' + escapeHtml(label) + '</span>' +
          nodeLabelHtml +
          corrHtml +
          courseHtml +
        '</div>' +
        contentHtml +
        '</li>';
    }
    html += '</ul>';
    detail.innerHTML = html;

    detail.querySelectorAll(".streak-event-item.is-clickable").forEach((li) => {
      li.addEventListener("click", () => jumpToEvent(li));
    });
  }

  /** 关闭台历并把定位信息交给 app.js（CustomEvent 契约，保持两文件解耦）。 */
  function jumpToEvent(li) {
    const dlg = ensureCalendarDialog();
    const payload = {
      kind: li.dataset.jumpKind || "",
      referenceId: li.dataset.jumpRef || "",
      projectId: li.dataset.jumpProject || "",
      projectName: li.dataset.jumpProjectName || "",
      nodeId: li.dataset.jumpNode || "",
      messageId: li.dataset.jumpMessage || "",
      date: selectedDate || "",
    };
    if (dlg.open) dlg.close();
    document.dispatchEvent(new CustomEvent("knoworigin:calendar-jump", { detail: payload }));
  }

  function truncate(s, n) {
    s = String(s == null ? "" : s);
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + "…";
  }

  function openCalendar() {
    if (badge.hidden) return;
    const dlg = ensureCalendarDialog();
    if (dlg.open) return;
    dlg.showModal();
    mountPanels();
    setView("calendar");   // 每次打开都回到月历，课程页不留在上一次的选点上
    loadCalendar();
  }

  // ------------------------------------------------------- 外部数据联动 --

  document.addEventListener("knoworigin:exam-dates", (ev) => {
    examDates = (ev.detail && ev.detail.dates) || {};
    const dlg = document.getElementById("streak-calendar-dialog");
    if (dlg && dlg.open && calendarData) renderCalendar();
  });

  document.addEventListener("knoworigin:sprint-days", (ev) => {
    sprintDays = (ev.detail && ev.detail.dates) || {};
    const dlg = document.getElementById("streak-calendar-dialog");
    if (dlg && dlg.open && calendarData) renderCalendar();
  });

  // 排好冲刺计划后，把底部页签停在「当日计划」上（用户不必自己找）
  document.addEventListener("knoworigin:show-day-plan", () => {
    const dlg = document.getElementById("streak-calendar-dialog");
    if (!dlg) return;
    const btn = dlg.querySelector('.streak-cal-tab[data-cal-tab="plan"]');
    if (btn && !btn.classList.contains("is-on")) btn.click();
  });

  document.addEventListener("knoworigin:calendar-close", () => {
    const dlg = document.getElementById("streak-calendar-dialog");
    if (dlg && dlg.open) dlg.close();
  });

  badge.addEventListener("click", openCalendar);
  // 冲刺模块的「制定/查看冲刺计划」入口也开这台历（同一处入口，不做第二个弹窗）
  window.KnowOriginCalendar = {
    open: openCalendar,
    setView: setView,
    getSelectedDate: function () { return selectedDate; },
    selectDate: selectDate,
  };

  fetchStreak();
  timerId = window.setInterval(fetchStreak, 60_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      fetchStreak();
      const dlg = document.getElementById("streak-calendar-dialog");
      if (dlg && dlg.open) loadCalendar();
    }
  });
  window.addEventListener("beforeunload", () => {
    if (timerId !== null) window.clearInterval(timerId);
  });
})();