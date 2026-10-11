/* ==========================================================================
   知源（KnowOrigin）· 学习文档 —— 全屏沉浸式阅读台（左目录 + 正文 + 右侧问 AI）

   把三类成文产物（core/study_kit.py 的 cheatsheet / learning_path / checklist）
   合并成**一份可通读的长文档**，并按「知识点文档」（knowledge-doc-ui.js）那套
   全屏阅读页的形态呈现：左目录 + 右正文 + 右侧提问抽屉 + 分栏拖动 + 阅读进度。

   为什么是这一套形态（调研结论，别随手改回去）：
   - Readwise Reader 把「阅读面必须消失」放在第一位：正文之外的一切都退到边栏，
     只在需要时出现。所以顶栏压到一行、进度条只有 2px、沉浸模式下整条顶栏与
     目录都可以收掉，只剩文字。
   - 长文靠**目录 + 滚动定位**导航，不靠翻页 —— 速查表 / 路径 / 清单本来就该
     来回对照着看，翻页反而丢位置。
   - 提问必须**贴着材料**：选中一段话 → 浮条「问 AI」，问题与那段原文一起进
     记录；答案由 /study-kit/ask 只依据这份文档给出，文档里没写的直说没写。

   入口：侧栏每个项目行右侧的「学习文档」小图标（agent-shell.js 渲染），
   与既有的「知识文档」图标同列并排。**只读那一份文档，不切换当前项目**。

   约定（与本项目其它叠加层一致）：
   - 不碰 app.js / styles.css；样式全部自带，删掉 index.html 那一行脚本即完全回退。
   - 正文自己渲染：这份文档要靠真 h2/h3 做目录、锚点与滚动定位，而 app.js 的
     renderStudyReportMarkdown 把标题拍成了 `<p class="study-text-heading">`，级别丢了。
   - 数据只走既有端点：GET /study-kit、POST /study-kit/generate、POST /study-kit/ask。
   ========================================================================== */
(function () {
  "use strict";

  var STYLE_ID = "ko-sd-style";
  var OVERLAY_ID = "ko-sd-overlay";
  var TOC_MIN_WIDTH = 940;          // 窄于此就收起目录
  var BODY_OPEN_CLASS = "ko-sd-open";
  var PREF_KEY = "knoworigin.sd.prefs";
  var GRIP_STORE_KEY = "knoworigin.sd.grips";

  /* 与 core/study_kit.py 的 KINDS / KIND_LABELS / KIND_HINTS 一致。
     顺序就是正文与目录里的排列顺序：先考前扫一眼的表，再路径，最后逐项打勾的清单。 */
  var KINDS = [
    { value: "cheatsheet", icon: "📋", label: "一页速查表", hint: "把整章压成一页可打印的对照表，考前用它过一遍。" },
    { value: "learning_path", icon: "🗺", label: "学习路径", hint: "前置知识 + 下一步学什么 + 推荐资源，据此排冲刺节奏。" },
    { value: "checklist", icon: "✅", label: "清单报告", hint: "按掌握度分组的可勾选复习清单，逐项打勾、扫尾用。" },
  ];
  var SCALES = [
    { label: "小", value: "0.94" },
    { label: "中", value: "1" },
    { label: "大", value: "1.09" },
  ];

  /* ⚠️ 状态变量绝不能叫 state / view —— 会遮蔽 app.js 的全局 state 与同名函数。 */
  var VIEW = {
    open: false,
    pid: "",
    name: "",
    kits: {},          // kind -> kit（**只收项目级那一份**，node_id 为空）
    loading: false,
    loadedFor: "",
    busy: {},          // kind -> true 正在生成
    error: "",
    seq: 0,            // 竞态守卫：切项目 / 重复刷新只认最后一次请求
    heads: [],         // 正文里的标题元素（含级别），目录与滚动定位靠它
    tocItems: [],      // 左目录按钮，与 heads 一一对应
    focus: false,      // 沉浸模式：收掉顶栏与目录，只留文字
    scale: 1,          // SCALES 的下标
    sel: "",           // 当前选中的原文（**只增不清**，见 onSelectionChange）
    selSection: "",    // 选中时所在的小节标题
    selLive: false,    // 此刻是不是真有一段选中（点浮条按钮的那一下会变 false）
    askThread: [],
    askRef: "",
    askSection: "",
    askBusy: false,
    askPaintAt: 0,
    askExtra: true,   // 「也讲材料外」：默认 true —— 优先放开材料外补充（2026-10-07）
  };

  function kindMeta(value) {
    for (var i = 0; i < KINDS.length; i++) if (KINDS[i].value === value) return KINDS[i];
    return KINDS[0];
  }

  /* ------------------------------------------------------------ 全局安全读取 */

  function esc(value) {
    try { if (typeof window.escapeHtml === "function") return window.escapeHtml(value); } catch (e) {}
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function notify(msg, variant) {
    try {
      if (typeof window.showToast === "function") { window.showToast(msg, { variant: variant || "info" }); return; }
    } catch (e) { /* 提示只是锦上添花 */ }
    console.log("[StudyDoc]", msg);
  }

  function request(path, options) {
    if (typeof window.api === "function") return window.api(path, options);
    var opts = Object.assign({ credentials: "same-origin" }, options || {});
    return fetch(path, opts).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          var detail = body && body.detail;
          throw new Error((detail && detail.message) || detail || ("HTTP " + res.status));
        });
      }
      return res.json();
    });
  }

  function projectLabel(pid, fallback) {
    var given = String(fallback || "").trim();
    if (given) return given;
    try {
      var list = (typeof state !== "undefined" && state && Array.isArray(state.projects)) ? state.projects : [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && String(list[i].project_id) === String(pid)) {
          var subject = String(list[i].subject || list[i].name || "").trim();
          var year = String(list[i].year || "").trim();
          return year ? (year + " · " + subject) : (subject || "未命名课程");
        }
      }
    } catch (e) { /* state 还没就绪就当没有 */ }
    return "当前课程";
  }

  function readPrefs() {
    try {
      var raw = window.localStorage.getItem(PREF_KEY);
      var data = raw ? JSON.parse(raw) : null;
      if (!data || typeof data !== "object") return;
      if (typeof data.focus === "boolean") VIEW.focus = data.focus;
      if (typeof data.scale === "number" && data.scale >= 0 && data.scale < SCALES.length) {
        VIEW.scale = data.scale;
      }
    } catch (e) { /* 隐私模式读不到就用默认 */ }
  }

  function savePrefs() {
    try {
      window.localStorage.setItem(PREF_KEY, JSON.stringify({ focus: VIEW.focus, scale: VIEW.scale }));
    } catch (e) { /* 存不进去不影响本次会话 */ }
  }

  function ico(name) {
    var paths = {
      chat: '<path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H8l-4 2.6V11.5A7.5 7.5 0 0 1 11.5 4h1A7.5 7.5 0 0 1 20 11.5z"></path>',
      close: '<path d="M6 6l12 12"></path><path d="M18 6L6 18"></path>',
      focus: '<path d="M4 9V4h5"></path><path d="M20 15v5h-5"></path><path d="M20 9V4h-5"></path><path d="M4 15v5h5"></path>',
      type: '<path d="M5 6h14"></path><path d="M12 6v13"></path><path d="M9 19h6"></path>',
    };
    return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"' +
      ' stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
      (paths[name] || "") + "</svg>";
  }

  /* ------------------------------------------------------------ 样式注入 */

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      "#" + OVERLAY_ID + " {",
      "  position: fixed; inset: 0; z-index: 1500; display: none; flex-direction: column;",
      "  background: var(--panel); color: var(--ink); --ko-sd-scale: 1;",
      "}",
      "#" + OVERLAY_ID + ".ko-sd-is-open { display: flex; }",
      // 主界面的「提问导轨」挂在 body、z-index 8000、宽 6px，比本层高 —— 不藏就会像一条
      // 带小圆点的细线叠在正文右侧。跟随 card-viewer / usage-doc-viewer / ko-kd 的既有先例。
      "body." + BODY_OPEN_CLASS + " .question-rail { display: none; }",
      // 桌宠的 z-index 是 2147483000（「高于其他UI，但不高于模态框」），比本层(1500)高得多，
      // 会浮在正文和「问 AI」抽屉上面 —— 沉浸阅读时收掉它。
      "body." + BODY_OPEN_CLASS + " #hxt-pet { display: none; }",
      // 锁住背景滚动。除了沉浸本身，还顺手修掉一个实测到的边缝：根滚动条会占掉右侧 10px，
      // 而 position:fixed; inset:0 的包含块就是「视口 - 滚动条」—— 于是「铺满视口」的阅读台
      // 在右边留一条缝（实测 body 只有 1430 宽，而 innerWidth 是 1440）。
      // body 的 overflow 会传播到视口，所以写在这里就能收掉根滚动条。
      "body." + BODY_OPEN_CLASS + " { overflow: hidden; }",
      /* ——— 顶栏 ——— */
      ".ko-sd-bar { flex: 0 0 auto; display: flex; align-items: center; gap: 9px; flex-wrap: wrap;",
      "  padding: 10px 20px 9px; border-bottom: 1px solid var(--line); background: var(--panel); }",
      ".ko-sd-bar-title { flex: 0 1 auto; min-width: 0; font-weight: 650; letter-spacing: .01em;",
      "  font-size: calc(15px * var(--font-scale, 1)); overflow: hidden; text-overflow: ellipsis;",
      "  white-space: nowrap; }",
      ".ko-sd-bar-title::before { content: \"\"; display: inline-block; width: 3px; height: .92em;",
      "  margin-right: 9px; border-radius: 2px; background: var(--green); vertical-align: -.06em; }",
      ".ko-sd-bar-meta { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;",
      "  white-space: nowrap; font-size: calc(11.5px * var(--font-scale, 1)); color: var(--muted); }",
      "#ko-sd-actions { flex: 1 1 auto; display: flex; gap: 7px; flex-wrap: wrap; justify-content: flex-end; }",
      ".ko-sd-btn { flex: 0 0 auto; border: 1px solid var(--line); border-radius: 9px;",
      "  padding: 5px 12px; font-size: calc(12.5px * var(--font-scale, 1)); line-height: 1.35;",
      "  background: var(--panel); color: var(--ink); cursor: pointer; font-family: inherit;",
      "  transition: background .15s ease, border-color .15s ease, color .15s ease; }",
      ".ko-sd-btn:hover { border-color: var(--green); color: var(--green-dark); }",
      ".ko-sd-btn:disabled { opacity: .5; cursor: default; }",
      ".ko-sd-btn-primary { background: var(--green-soft); border-color: transparent; color: var(--green-dark); }",
      ".ko-sd-btn-primary:hover:not(:disabled) { background: var(--green); color: #0e1410; }",
      ".ko-sd-btn-icon { display: inline-flex; align-items: center; justify-content: center;",
      "  width: calc(30px * var(--font-scale, 1)); height: calc(30px * var(--font-scale, 1)); padding: 0; }",
      ".ko-sd-btn-icon svg { display: block; width: calc(15px * var(--font-scale, 1));",
      "  height: calc(15px * var(--font-scale, 1)); }",
      ".ko-sd-btn-icon.ko-sd-is-on { background: var(--green-soft); border-color: var(--green);",
      "  color: var(--green-dark); }",
      /* 阅读进度：2px 细线，比滚动条更直观地说明「读到哪了」 */
      ".ko-sd-readbar { flex: 0 0 auto; height: 2px; background: transparent; }",
      ".ko-sd-readbar-fill { height: 100%; width: 0; background: var(--green); transition: width .12s linear; }",
      ".ko-sd-main { flex: 1 1 auto; min-height: 0; display: flex; position: relative; }",
      /* ——— 分栏拖动手柄 ———
         命中区刻意比布局宽（::before 向两侧各外扩 7px，实际可点约 24px）—— 6px 的把手
         在真机上等于打不中。硬约束：**分隔线只由把手画**，两侧面板都不画 border，
         否则会出现两条挨在一起的竖线，用户拖的是不在把手里的那一条，永远没反应。 */
      ".ko-sd-grip { flex: 0 0 10px; position: relative; cursor: col-resize;",
      "  background: transparent; z-index: 3; touch-action: none; user-select: none; }",
      ".ko-sd-grip::before { content: \"\"; position: absolute; top: 0; bottom: 0; left: -7px; right: -7px; }",
      ".ko-sd-grip::after { content: \"\"; position: absolute; top: 0; bottom: 0; left: 50%;",
      "  width: 1px; margin-left: -0.5px; background: var(--line);",
      "  transition: background .12s ease, width .12s ease; }",
      ".ko-sd-grip:hover { background: rgba(var(--green-rgb), .07); }",
      ".ko-sd-grip:hover::after, .ko-sd-grip.ko-sd-is-drag::after {",
      "  width: 3px; margin-left: -1.5px; background: var(--green); }",
      ".ko-sd-grip-r { display: none; }",
      ".ko-sd-grip-r.ko-sd-is-on { display: block; }",
      "body.ko-sd-resizing { cursor: col-resize; user-select: none; }",
      "body.ko-sd-resizing * { cursor: col-resize !important; }",
      /* ——— 左目录 ———
         底色用 --panel（--muted 压 --background 只有 4.48，差 0.02 才到正文的 4.5 线）。
         悬停/选中用「半透明绿 + --ink」，不用 --green-soft + --green-dark ——
         后者在深色下是「深绿底压深绿字」（1.43 对比度，踩过）。 */
      ".ko-sd-toc { flex: 0 0 var(--ko-sd-toc-w, 248px); overflow-y: auto; overscroll-behavior: contain;",
      "  padding: 0 10px 40px 12px; background: var(--panel); }",
      ".ko-sd-toc-title { position: sticky; top: 0; z-index: 2; background: var(--panel);",
      "  padding: 13px 8px 7px; font-size: calc(11px * var(--font-scale, 1)); color: var(--muted);",
      "  letter-spacing: .1em; }",
      ".ko-sd-toc-item { display: flex; align-items: center; gap: 6px; width: 100%; text-align: left;",
      "  border: 0; background: transparent; color: var(--ink); cursor: pointer;",
      "  border-radius: 0 7px 7px 0; border-left: 2px solid transparent;",
      "  padding: 6px 8px 6px 10px; font-size: calc(12.5px * var(--font-scale, 1));",
      "  line-height: 1.35; font-family: inherit; }",
      ".ko-sd-toc-item:hover { background: rgba(var(--green-rgb), .12); color: var(--ink); }",
      ".ko-sd-toc-text { flex: 1 1 auto; min-width: 0; overflow: hidden;",
      "  text-overflow: ellipsis; white-space: nowrap; }",
      ".ko-sd-toc-item.ko-sd-is-sub { padding-left: 24px; font-size: calc(12px * var(--font-scale, 1));",
      "  color: var(--muted); }",
      ".ko-sd-toc-item.ko-sd-is-sub.ko-sd-is-h3 { padding-left: 36px; }",
      ".ko-sd-toc-item.ko-sd-is-active { background: rgba(var(--green-rgb), .14);",
      "  border-left-color: var(--green); color: var(--ink); font-weight: 600; }",
      ".ko-sd-toc-chip { flex: 0 0 auto; padding: 0 5px; border-radius: 999px;",
      "  font-size: calc(10px * var(--font-scale, 1)); color: var(--muted);",
      "  border: 1px solid var(--line); }",
      ".ko-sd-toc-chip.ko-sd-is-off { opacity: .7; }",
      /* ——— 正文 ———
         ⚠️ 别用 `padding: 28px max(22px, calc((100% - 880px)/2))` 做居中：padding 的百分比
         相对**包含块**（整个主区）算，代入后内容宽 = 880 - 目录 - 抽屉，跟窗口宽度无关。
         正解：容器给固定水平内边距，内容块自己 max-width + margin auto。 */
      ".ko-sd-body { flex: 1 1 auto; min-width: 0; overflow-y: auto; overscroll-behavior: contain;",
      "  padding: 28px 22px 120px; }",
      ".ko-sd-doc { max-width: 880px; margin: 0 auto;",
      "  font-size: calc(14.5px * var(--font-scale, 1) * var(--ko-sd-scale, 1)); line-height: 1.8; }",
      ".ko-sd-doc-head { margin: 0 0 26px; padding-bottom: 14px; border-bottom: 1px solid var(--line); }",
      ".ko-sd-doc-title { margin: 0; font-size: calc(23px * var(--font-scale, 1) * var(--ko-sd-scale, 1));",
      "  font-weight: 700; letter-spacing: -.01em; }",
      ".ko-sd-doc-sub { margin: 6px 0 0; font-size: calc(12px * var(--font-scale, 1)); color: var(--muted); }",
      ".ko-sd-sec { margin: 0 0 46px; scroll-margin-top: 14px; }",
      ".ko-sd-sec-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;",
      "  padding-bottom: 9px; border-bottom: 1px solid var(--line); margin-bottom: 4px; }",
      ".ko-sd-sec-title { margin: 0; display: flex; align-items: center; gap: 8px;",
      "  font-size: calc(19px * var(--font-scale, 1) * var(--ko-sd-scale, 1)); font-weight: 680; }",
      ".ko-sd-sec-title::before { content: \"\"; display: inline-block; width: 3px; height: .95em;",
      "  border-radius: 2px; background: var(--green); }",
      ".ko-sd-sec-time { font-size: calc(11px * var(--font-scale, 1)); color: var(--muted); }",
      ".ko-sd-sec-actions { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; }",
      ".ko-sd-sec-actions .ko-sd-btn { padding: 4px 10px; font-size: calc(11.5px * var(--font-scale, 1)); }",
      ".ko-sd-sec-hint { margin: 8px 0 12px; font-size: calc(11.5px * var(--font-scale, 1));",
      "  color: var(--muted); }",
      ".ko-sd-empty { margin: 0; padding: 26px 12px; text-align: center; color: var(--muted);",
      "  font-size: calc(12.5px * var(--font-scale, 1)); border: 1px dashed var(--line);",
      "  border-radius: 10px; }",
      /* ——— Markdown ——— */
      ".ko-sd-md h2 { font-size: calc(17px * var(--font-scale, 1) * var(--ko-sd-scale, 1));",
      "  margin: 32px 0 12px; font-weight: 650; scroll-margin-top: 16px; }",
      ".ko-sd-md h2::before { content: \"\"; display: inline-block; width: 3px; height: .95em;",
      "  margin-right: 9px; border-radius: 2px; background: var(--green); vertical-align: -.08em; }",
      ".ko-sd-md h3 { font-size: calc(15.5px * var(--font-scale, 1) * var(--ko-sd-scale, 1));",
      "  margin: 24px 0 8px; font-weight: 650; scroll-margin-top: 16px; }",
      ".ko-sd-md h4 { font-size: calc(14px * var(--font-scale, 1)); margin: 18px 0 6px;",
      "  font-weight: 600; color: var(--muted); scroll-margin-top: 16px; }",
      ".ko-sd-md p { margin: 9px 0; }",
      ".ko-sd-md ul, .ko-sd-md ol { margin: 9px 0; padding-left: 24px; }",
      ".ko-sd-md li { margin: 5px 0; }",
      ".ko-sd-md .ko-sd-li-note { display: block; margin-top: 2px; color: var(--muted);",
      "  font-size: calc(13px * var(--font-scale, 1)); }",
      ".ko-sd-md blockquote { margin: 12px 0; padding: 9px 15px; border-left: 3px solid var(--green);",
      "  background: rgba(var(--green-rgb), .10); color: var(--ink); border-radius: 0 9px 9px 0;",
      "  font-size: calc(13.5px * var(--font-scale, 1)); }",
      ".ko-sd-md blockquote p { margin: 2px 0; }",
      ".ko-sd-md hr { border: 0; border-top: 1px solid var(--line); margin: 28px 0; }",
      ".ko-sd-md code { background: var(--background); border: 1px solid var(--line);",
      "  border-radius: 6px; padding: 1px 5px; font-size: calc(13px * var(--font-scale, 1)); }",
      ".ko-sd-md strong { font-weight: 680; }",
      // 表格：圆角细线（border-collapse: separate 才吃 border-radius），别再是格子墙
      ".ko-sd-tbl { overflow-x: auto; margin: 14px 0; }",
      ".ko-sd-md table { width: 100%; border-collapse: separate; border-spacing: 0;",
      "  border: 1px solid var(--line); border-radius: 10px; overflow: hidden;",
      "  font-size: calc(13.5px * var(--font-scale, 1)); }",
      ".ko-sd-md th, .ko-sd-md td { border: 0; border-bottom: 1px solid var(--line);",
      "  padding: 8px 11px; text-align: left; vertical-align: top; }",
      ".ko-sd-md tr:last-child th, .ko-sd-md tr:last-child td { border-bottom: 0; }",
      ".ko-sd-md th { background: var(--background); font-weight: 600; white-space: nowrap; }",
      ".ko-sd-md tr:nth-child(even) td { background: var(--background); }",
      ".ko-sd-md .katex { font-size: 1.02em; }",
      // 清单复选框：类名保持 .ko-ck —— 海小棠的 enhanceChecklistItems 认它（也认裸 `- [ ]`）
      ".ko-sd-md .ko-ck { display: inline-block; min-width: 1.2em; color: var(--green-dark);",
      "  font-weight: 700; }",
      ".ko-sd-md .ko-ck.is-done { color: var(--muted); }",
      /* ——— 沉浸模式：顶栏、目录、把手全收掉，只剩文字 ——— */
      "#" + OVERLAY_ID + ".ko-sd-is-focus .ko-sd-bar,",
      "#" + OVERLAY_ID + ".ko-sd-is-focus .ko-sd-toc,",
      "#" + OVERLAY_ID + ".ko-sd-is-focus .ko-sd-grip-l,",
      "#" + OVERLAY_ID + ".ko-sd-is-focus .ko-sd-readbar { display: none; }",
      "#" + OVERLAY_ID + ".ko-sd-is-focus .ko-sd-body { padding: 52px 22px 140px; }",
      "#" + OVERLAY_ID + ".ko-sd-is-focus .ko-sd-doc { max-width: 760px; }",
      // 沉浸模式下没有顶栏了，给一个只在悬停时出现的小退出条，否则用户不知道怎么出去
      ".ko-sd-escape { position: fixed; top: 10px; right: 14px; z-index: 1560; display: none;",
      "  align-items: center; gap: 8px; padding: 6px 10px; border-radius: 999px;",
      "  border: 1px solid var(--line); background: var(--panel); color: var(--muted);",
      "  font-size: calc(11.5px * var(--font-scale, 1)); opacity: .18;",
      "  transition: opacity .18s ease; }",
      "#" + OVERLAY_ID + ".ko-sd-is-focus .ko-sd-escape { display: flex; }",
      ".ko-sd-escape:hover { opacity: 1; }",
      /* ——— 回到顶部 / 选中浮条 ——— */
      ".ko-sd-top, .ko-sd-selbar { position: fixed; z-index: 1560; display: none; }",
      ".ko-sd-top.ko-sd-is-on, .ko-sd-selbar.ko-sd-is-on { display: flex; }",
      ".ko-sd-top { right: 26px; bottom: 26px; width: 38px; height: 38px; align-items: center;",
      "  justify-content: center; border: 1px solid var(--line); border-radius: 999px;",
      "  background: var(--panel); color: var(--ink); cursor: pointer;",
      "  font-size: calc(15px * var(--font-scale, 1)); box-shadow: 0 6px 18px rgba(0,0,0,.12); }",
      ".ko-sd-top:hover { border-color: var(--green); color: var(--green-dark); }",
      // 抽屉开着时「发送」正好压在 fixed 的回到顶部上 —— 把它挪到抽屉左侧。
      // 窄屏抽屉是浮层（宽 min(420px,94vw)），那条规则不适用，所以只限宽屏。
      "@media (min-width: 1221px) {",
      "  #" + OVERLAY_ID + ":has(.ko-sd-ask.ko-sd-is-on) .ko-sd-top {",
      "    right: calc(var(--ko-sd-ask-w, clamp(340px, 28vw, 420px)) + 14px); }",
      "}",
      ".ko-sd-selbar { align-items: center; gap: 6px; padding: 5px;",
      "  border: 1px solid var(--line); border-radius: 10px; background: var(--panel);",
      "  box-shadow: 0 8px 22px rgba(0,0,0,.16); }",
      ".ko-sd-selbar .ko-sd-btn { padding: 4px 10px; font-size: calc(12px * var(--font-scale, 1)); }",
      /* ——— 提问抽屉 ——— */
      ".ko-sd-ask { flex: 0 0 0; width: 0; display: none; overflow: hidden; background: var(--panel); }",
      ".ko-sd-ask.ko-sd-is-on { display: flex; flex-direction: column;",
      "  flex: 0 0 var(--ko-sd-ask-w, clamp(340px, 28vw, 420px));",
      "  width: var(--ko-sd-ask-w, clamp(340px, 28vw, 420px)); min-height: 0; }",
      ".ko-sd-ask-head { flex: 0 0 auto; display: flex; align-items: center; gap: 8px;",
      "  padding: 12px 14px; border-bottom: 1px solid var(--line); }",
      ".ko-sd-ask-title { flex: 0 0 auto; font-weight: 650; font-size: calc(13.5px * var(--font-scale, 1)); }",
      ".ko-sd-ask-section { flex: 1 1 auto; min-width: 0; overflow: hidden;",
      "  text-overflow: ellipsis; white-space: nowrap;",
      "  font-size: calc(11.5px * var(--font-scale, 1)); color: var(--muted); }",
      ".ko-sd-ask-thread { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 12px 14px; }",
      ".ko-sd-ask-empty { color: var(--muted); font-size: calc(12.5px * var(--font-scale, 1));",
      "  line-height: 1.75; }",
      ".ko-sd-ask-q { display: flex; gap: 8px; margin: 14px 0 8px;",
      "  font-size: calc(13px * var(--font-scale, 1)); font-weight: 600; }",
      ".ko-sd-ask-q-mark { flex: 0 0 auto; width: 18px; height: 18px; border-radius: 6px;",
      "  text-align: center; line-height: 18px; font-size: calc(11px * var(--font-scale, 1));",
      "  background: rgba(var(--green-rgb), .16); color: var(--ink); }",
      ".ko-sd-ask-a { font-size: calc(13.5px * var(--font-scale, 1)); line-height: 1.75; }",
      ".ko-sd-ask-ref { display: flex; align-items: flex-start; gap: 6px; margin: 0 0 8px;",
      "  padding: 7px 9px; border-radius: 8px; border-left: 3px solid var(--green);",
      "  background: rgba(var(--green-rgb), .10); color: var(--ink);",
      "  font-size: calc(12px * var(--font-scale, 1)); }",
      ".ko-sd-ask-ref-text { flex: 1 1 auto; min-width: 0; max-height: 68px; overflow: hidden;",
      "  line-height: 1.6; }",
      ".ko-sd-ask-ref-x { flex: 0 0 auto; border: 0; background: transparent; cursor: pointer;",
      "  color: var(--muted); font-size: calc(14px * var(--font-scale, 1)); line-height: 1; }",
      ".ko-sd-ask-compose { flex: 0 0 auto; border-top: 1px solid var(--line); padding: 10px 14px 12px; }",
      ".ko-sd-ask-input { width: 100%; box-sizing: border-box; resize: vertical; min-height: 62px;",
      "  border: 1px solid var(--line); border-radius: 9px; padding: 8px 10px;",
      "  background: var(--panel); color: var(--ink); font: inherit;",
      "  font-size: calc(13px * var(--font-scale, 1)); line-height: 1.6; }",
      ".ko-sd-ask-input:focus { outline: 0; border-color: var(--green); }",
      ".ko-sd-ask-actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; }",
      ".ko-sd-ask-hint { flex: 1 1 auto; min-width: 0; font-size: calc(11px * var(--font-scale, 1));",
      "  color: var(--muted); }",
      /* 两档切换：默认严格（材料外直说没写），勾上才允许发散，且补充会被分段标出来。
         用 checkbox 而不是 select —— 要的是「这一问的授权」，少一次点击，
         也让「默认不授权」这件事一眼可见。 */
      ".ko-sd-ask-mode { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 5px;",
      "  margin-bottom: 6px; font-size: calc(11.5px * var(--font-scale, 1)); color: var(--muted);",
      "  cursor: pointer; user-select: none; white-space: nowrap; }",
      ".ko-sd-ask-mode input { margin: 0; width: 13px; height: 13px; accent-color: var(--green);",
      "  cursor: pointer; }",
      ".ko-sd-ask-mode.ko-sd-is-extra { color: var(--ink); }",
      ".ko-sd-err { margin: 0 0 14px; padding: 9px 13px; border-radius: 9px;",
      "  background: rgba(200, 90, 80, .12); border: 1px solid var(--red); color: var(--red);",
      "  font-size: calc(12.5px * var(--font-scale, 1)); }",
      "@media (max-width: " + TOC_MIN_WIDTH + "px) {",
      "  .ko-sd-toc { display: none; }",
      "  .ko-sd-grip-l { display: none; }",
      "  .ko-sd-body { padding: 20px 16px 90px; }",
      "}",
      // 窄屏：抽屉改成浮在正文之上，不把正文挤成一条缝。判据是「占位模式下正文还剩多少」：
      // 内容宽 = 视口 - 目录(248) - 抽屉 - 内边距(44)，低于 ~570px 就没法读了，所以断点取 1220。
      "@media (max-width: 1220px) {",
      "  .ko-sd-ask.ko-sd-is-on { position: absolute; top: 0; right: 0; bottom: 0;",
      "    flex: 0 0 auto; width: min(420px, 94vw); z-index: 6;",
      "    box-shadow: -10px 0 28px rgba(0,0,0,.16); }",
      // 抽屉浮起来后不占布局宽度，右把手就没东西可拖了。选择器必须带 .ko-sd-is-on：
      // 它和上面那条同权，靠「写在后面」取胜。
      "  .ko-sd-grip-r, .ko-sd-grip-r.ko-sd-is-on { display: none; }",
      "}",
    ].join("\n");
    var node = document.createElement("style");
    node.id = STYLE_ID;
    node.textContent = css;
    document.head.appendChild(node);
  }

  /* ------------------------------------------------------- Markdown 渲染 --
   * ⚠️ 公式必须在转义**之前**抽走：模型写 `$a < b$` 时，先 esc 会把它变成
   *    `$a &lt; b$`，KaTeX 拿到的是坏 LaTeX —— 用户看到的就是「公式渲染不出来」。
   */

  function renderMarkdown(source) {
    var mathBlocks = [];
    function protect(tex, display) {
      var token = "\u0000MATH" + mathBlocks.length + "\u0000";
      mathBlocks.push({ tex: tex, display: display });
      return token;
    }
    // 四种写法都要认：`$$…$$` / `\[…\]`（行间）与 `$…$` / `\(…\)`（行内）。
    var guarded = String(source == null ? "" : source)
      .replace(/\$\$([\s\S]+?)\$\$/g, function (m, tex) { return protect(tex, true); })
      .replace(/\\\[([\s\S]+?)\\\]/g, function (m, tex) { return protect(tex, true); })
      .replace(/\\\(([\s\S]+?)\\\)/g, function (m, tex) { return protect(tex, false); })
      .replace(/\$(?!\$)([^\n$]+?)\$(?!\$)/g, function (m, tex) { return protect(tex, false); });

    var lines = esc(guarded).split(/\r?\n/);
    var out = [];
    var inTable = false;
    var listType = "";        // "" | "ul" | "ol"
    var listItems = [];       // [{ html, notes: [] }]
    var headSeq = 0;

    function inline(text) {
      return text
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/`([^`]+)`/g, "<code>$1</code>");
    }

    function flushList() {
      if (!listType) return;
      var tag = listType;
      out.push("<" + tag + ">" + listItems.map(function (item) {
        var notes = item.notes.map(function (n) {
          return '<span class="ko-sd-li-note">' + n + "</span>";
        }).join("");
        return "<li>" + item.html + notes + "</li>";
      }).join("") + "</" + tag + ">");
      listType = "";
      listItems = [];
    }

    function closeTable() {
      if (!inTable) return;
      out.push("</tbody></table></div>");
      inTable = false;
    }

    function closeBlocks() {
      closeTable();
      flushList();
    }

    lines.forEach(function (raw) {
      var line = raw.replace(/\s+$/, "");
      var trimmed = line.trim();

      // 表格行
      if (/^\|.*\|$/.test(trimmed)) {
        if (/^[\s|:-]+$/.test(trimmed)) return;              // 分隔行
        flushList();
        var cells = trimmed.replace(/^\||\|$/g, "").split("|");
        if (!inTable) {
          out.push('<div class="ko-sd-tbl"><table><thead><tr>' +
            cells.map(function (c) { return "<th>" + inline(c.trim()) + "</th>"; }).join("") +
            "</tr></thead><tbody>");
          inTable = true;
          return;
        }
        out.push("<tr>" + cells.map(function (c) { return "<td>" + inline(c.trim()) + "</td>"; }).join("") + "</tr>");
        return;
      }
      closeTable();

      // 标题：真 h2/h3/h4 + 锚点 id，目录与滚动定位靠它
      var head = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (head) {
        flushList();
        var level = Math.min(6, Math.max(2, head[1].length));  // # / ## 都当 h2
        out.push("<h" + level + ' id="ko-sd-h' + (headSeq++) + '">' + inline(head[2].trim()) + "</h" + level + ">");
        return;
      }

      // 分隔线
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { closeBlocks(); out.push("<hr>"); return; }

      // 引用
      if (/^>\s?/.test(trimmed)) {
        closeBlocks();
        out.push("<blockquote><p>" + inline(trimmed.replace(/^>\s?/, "")) + "</p></blockquote>");
        return;
      }

      // 无序列表（含 `- [ ]` 复选框）
      var bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
      if (bullet) {
        var indent = bullet[1].length;
        var text = bullet[2];
        // 缩进的续行属于上一条（学习路径里「为什么需要它：…」就是这种）
        if (listType === "ul" && indent >= 2 && listItems.length) {
          listItems[listItems.length - 1].notes.push(inline(text));
          return;
        }
        if (listType !== "ul") { flushList(); listType = "ul"; }
        var ck = text.match(/^\[([ xX])\]\s*/);
        var html;
        if (ck) {
          html = (ck[1] === " "
            ? '<span class="ko-ck">☐</span> '
            : '<span class="ko-ck is-done">☑</span> ') + inline(text.slice(ck[0].length));
        } else {
          html = inline(text);
        }
        listItems.push({ html: html, notes: [] });
        return;
      }

      // 有序列表
      var ordered = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
      if (ordered) {
        if (listType === "ol" && ordered[1].length >= 2 && listItems.length) {
          listItems[listItems.length - 1].notes.push(inline(ordered[2]));
          return;
        }
        if (listType !== "ol") { flushList(); listType = "ol"; }
        listItems.push({ html: inline(ordered[2]), notes: [] });
        return;
      }

      // 空行
      if (!trimmed) { closeBlocks(); return; }

      // 缩进的普通续行：也并进上一条列表项
      if (/^\s{2,}/.test(line) && listItems.length) {
        listItems[listItems.length - 1].notes.push(inline(trimmed));
        return;
      }

      closeBlocks();
      out.push("<p>" + inline(trimmed) + "</p>");
    });
    closeBlocks();

    return restoreMath(out.join(""), mathBlocks);
  }

  function restoreMath(html, mathBlocks) {
    var blocks = mathBlocks || [];
    if (!blocks.length) return html;
    var hasKatex = typeof window.katex !== "undefined" && !!window.katex.renderToString;
    return html.replace(/\u0000MATH(\d+)\u0000/g, function (whole, idx) {
      var item = blocks[Number(idx)];
      if (!item) return whole;
      if (!hasKatex) {
        return esc(item.display ? "\\[" + item.tex + "\\]" : "\\(" + item.tex + "\\)");
      }
      try {
        return window.katex.renderToString(item.tex, {
          displayMode: item.display, throwOnError: false, strict: "ignore",
        });
      } catch (e) {
        return esc(item.tex);
      }
    });
  }

  /* ------------------------------------------------------------ 阅读页骨架 */

  function overlay() {
    return document.getElementById(OVERLAY_ID);
  }

  function askPanelHtml() {
    return (
      '<aside class="ko-sd-ask" id="ko-sd-ask">' +
        '<div class="ko-sd-ask-head">' +
          '<span class="ko-sd-ask-title">问 AI</span>' +
          '<span class="ko-sd-ask-section" id="ko-sd-ask-section"></span>' +
          '<button type="button" class="ko-sd-btn" data-sd-ask-close>收起</button>' +
        "</div>" +
        '<div class="ko-sd-ask-thread" id="ko-sd-ask-thread"></div>' +
        '<div class="ko-sd-ask-compose">' +
          '<div class="ko-sd-ask-ref" id="ko-sd-ask-ref" style="display:none">' +
            '<span class="ko-sd-ask-ref-text" id="ko-sd-ask-ref-text"></span>' +
            '<button type="button" class="ko-sd-ask-ref-x" data-sd-ask-clear title="不用这段引用">×</button>' +
          "</div>" +
          '<textarea class="ko-sd-ask-input" id="ko-sd-ask-input" rows="3" ' +
            'placeholder="就着这份学习文档提问…（Enter 发送，Shift+Enter 换行）"></textarea>' +
          '<div class="ko-sd-ask-mode" id="ko-sd-ask-mode">' +
            '<input type="checkbox" id="ko-sd-ask-extra" data-sd-ask-extra checked>' +
            '<label for="ko-sd-ask-extra" ' +
              'title="勾上后材料外确实需要的知识也会答，但会单独放进「材料外补充」一段">' +
              "也讲材料外</label>" +
          "</div>" +
          '<div class="ko-sd-ask-actions">' +
            '<span class="ko-sd-ask-hint" id="ko-sd-ask-hint">材料外也会答，补充会单独标出来。</span>' +
            '<button type="button" class="ko-sd-btn ko-sd-btn-primary" id="ko-sd-ask-send" data-sd-ask-send>发送</button>' +
          "</div>" +
        "</div>" +
      "</aside>"
    );
  }

  function ensureOverlay() {
    var existing = overlay();
    if (existing) return existing;
    var node = document.createElement("div");
    node.id = OVERLAY_ID;
    node.setAttribute("role", "dialog");
    node.setAttribute("aria-label", "学习文档");
    node.innerHTML =
      '<div class="ko-sd-bar">' +
        '<span class="ko-sd-bar-title" id="ko-sd-title">学习文档</span>' +
        '<span class="ko-sd-bar-meta" id="ko-sd-meta"></span>' +
        '<span id="ko-sd-actions"></span>' +
        // 下面这几个按钮刻意放在 #ko-sd-actions **外面**：那个槽位每次渲染整段替换，
        // 放进去点一次就没了（knowledge-doc-ui.js 踩过）。
        '<button type="button" class="ko-sd-btn ko-sd-btn-icon" id="ko-sd-type"' +
          ' title="正文字号（点一下换一档）" aria-label="正文字号">' + ico("type") + "</button>" +
        '<button type="button" class="ko-sd-btn ko-sd-btn-icon" id="ko-sd-focus"' +
          ' title="沉浸模式：收掉顶栏与目录，只留文字（F）" aria-label="沉浸模式">' + ico("focus") + "</button>" +
        '<button type="button" class="ko-sd-btn ko-sd-btn-icon" id="ko-sd-ask-toggle" data-sd-ask-open' +
          ' title="问 AI：就着这份文档提问，也可以先选中一段话（Ctrl/⌘ + K）" aria-label="问 AI">' +
          ico("chat") + "</button>" +
        '<button type="button" class="ko-sd-btn ko-sd-btn-icon" data-sd-close' +
          ' title="关闭阅读台（Esc）" aria-label="关闭阅读台">' + ico("close") + "</button>" +
      "</div>" +
      '<div class="ko-sd-readbar"><div class="ko-sd-readbar-fill" id="ko-sd-readbar"></div></div>' +
      '<div class="ko-sd-main">' +
        '<aside class="ko-sd-toc" id="ko-sd-toc"></aside>' +
        '<div class="ko-sd-grip ko-sd-grip-l" id="ko-sd-grip-l" data-sd-grip="left"' +
          ' title="拖动调整目录宽度，双击复位"></div>' +
        '<div class="ko-sd-body" id="ko-sd-body"></div>' +
        '<div class="ko-sd-grip ko-sd-grip-r" id="ko-sd-grip-r" data-sd-grip="right"' +
          ' title="拖动调整提问栏宽度，双击复位"></div>' +
        askPanelHtml() +
      "</div>" +
      '<div class="ko-sd-escape" id="ko-sd-escape">' +
        '<span>沉浸模式 · F 退出</span>' +
        '<button type="button" class="ko-sd-btn" data-sd-focus-off>退出</button>' +
      "</div>" +
      '<button type="button" class="ko-sd-top" id="ko-sd-top" data-sd-top title="回到顶部">↑</button>' +
      '<div class="ko-sd-selbar" id="ko-sd-selbar">' +
        '<button type="button" class="ko-sd-btn ko-sd-btn-primary" data-sd-ask-sel>问 AI</button>' +
        '<button type="button" class="ko-sd-btn" data-sd-copy-sel>复制</button>' +
      "</div>";
    document.body.appendChild(node);
    node.addEventListener("click", onClick, false);
    wireOverlay();
    // 把 VIEW.askExtra 的默认值同步到 DOM（wrap 类名 + hint），避免视觉/从样式都跳一下
    setAskExtra(VIEW.askExtra);
    return node;
  }

  /** 一次性的 DOM 级监听。ensureOverlay 只建一次，所以不会重复绑。 */
  function wireOverlay() {
    var body = document.getElementById("ko-sd-body");
    if (body && body.addEventListener) body.addEventListener("scroll", onBodyScroll, false);

    var input = document.getElementById("ko-sd-ask-input");
    if (input && input.addEventListener) {
      input.addEventListener("keydown", function (event) {
        if (!event || event.key !== "Enter" || event.shiftKey) return;
        if (event.preventDefault) event.preventDefault();
        askSend();
      }, false);
    }
    // 绑 change 而不是 click：checkbox 自己会先切换 checked，change 只在值真的变了之后
    // 触发，点 label 也会带过来。
    var extraBox = document.getElementById("ko-sd-ask-extra");
    if (extraBox && extraBox.addEventListener) {
      extraBox.addEventListener("change", function (event) {
        setAskExtra(!!(event && event.target && event.target.checked));
      }, false);
    }

    var grips = document.querySelectorAll("[data-sd-grip]");
    for (var i = 0; i < grips.length; i++) {
      grips[i].addEventListener("mousedown", startGrip, false);
      grips[i].addEventListener("dblclick", resetGrip, false);
    }
    window.addEventListener("mousemove", onGripMove, false);
    window.addEventListener("mouseup", endGrip, false);
    restoreGrips();

    // 选区浮条：只在正文里选中才出现
    document.addEventListener("mouseup", onSelectionChange, false);
    document.addEventListener("keyup", onSelectionChange, false);
    document.addEventListener("mousedown", onDocumentDown, false);
    document.addEventListener("keydown", onKeydown, false);

    // 清单里的「🌷 问海小棠」是海小棠桌宠的入口，它要回到主界面回答 —— 本层是全屏浮层，
    // 不收起的话答案被盖在下面（knowledge-doc 那份没有清单，不用管这件事）。
    document.addEventListener("click", function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      if (target.closest(".hxt-ck-ask") && VIEW.open) close();
    }, false);
  }

  /* ------------------------------------------------------------ 分栏拖动 */

  var GRIP_MIN = { left: 180, right: 300 };
  var GRIP_MAX = { left: 420, right: 760 };
  var GRIP_DEFAULT = { left: 248, right: 0 };   // right=0 = 交给 CSS 的 clamp
  var GRIP_MIN_BODY = 460;
  var GRIP_HANDLE = 20;
  var GRIP_DRAG = null;
  var GRIP_SAVED = { left: GRIP_DEFAULT.left, right: 0 };

  function saveGripWidths() {
    try {
      window.localStorage.setItem(GRIP_STORE_KEY, JSON.stringify(GRIP_SAVED));
    } catch (e) { /* 隐私模式：拖动这次仍然生效，只是不留到下次 */ }
  }

  function overlayWidth() {
    var node = overlay();
    if (node && node.clientWidth) return node.clientWidth;
    return (typeof window !== "undefined" && window.innerWidth) || 1200;
  }

  /** 夹住宽度：在自身上下限之内，且另一栏 + 正文都还够用。
   *  正文留不够时不能死守 GRIP_MIN —— 那会把正文压成一条缝。 */
  function clampGrip(side, want) {
    var other = side === "left" ? (GRIP_SAVED.right || 0) : (GRIP_SAVED.left || GRIP_DEFAULT.left);
    var room = overlayWidth() - other - GRIP_HANDLE - GRIP_MIN_BODY;
    var low = Math.min(GRIP_MIN[side], room);
    var high = Math.max(low, Math.min(GRIP_MAX[side], room));
    return Math.max(low, Math.min(high, Math.round(want)));
  }

  function applyGrip(side, width) {
    GRIP_SAVED[side] = width;
    var node = overlay();
    if (!node || !node.style || !node.style.setProperty) return;
    node.style.setProperty("--ko-sd-" + (side === "left" ? "toc" : "ask") + "-w", width + "px");
  }

  function restoreGrips() {
    GRIP_SAVED = { left: GRIP_DEFAULT.left, right: 0 };
    try {
      var raw = window.localStorage.getItem(GRIP_STORE_KEY);
      var saved = raw ? JSON.parse(raw) : null;
      if (saved && typeof saved === "object") {
        if (saved.left) GRIP_SAVED.left = saved.left;
        if (saved.right) GRIP_SAVED.right = saved.right;
      }
    } catch (e) { /* 读不到就用默认 */ }
    var node = overlay();
    if (!node || !node.style || !node.style.setProperty) return;
    node.style.setProperty("--ko-sd-toc-w", GRIP_SAVED.left + "px");
    if (GRIP_SAVED.right) node.style.setProperty("--ko-sd-ask-w", GRIP_SAVED.right + "px");
  }

  function currentGripWidth(side) {
    if (side === "left") {
      var toc = document.getElementById("ko-sd-toc");
      return (toc && toc.clientWidth) ? toc.clientWidth : (GRIP_SAVED.left || GRIP_DEFAULT.left);
    }
    var ask = document.getElementById("ko-sd-ask");
    // 抽屉关着时量不到宽度（display:none → clientWidth 0），退回 CSS clamp 的结果
    if (ask && ask.clientWidth) return ask.clientWidth;
    return Math.max(340, Math.min(420, Math.round(overlayWidth() * 0.28)));
  }

  function startGrip(event) {
    var grip = event.currentTarget;
    if (!grip) return;
    var side = grip.getAttribute("data-sd-grip");
    if (side !== "left" && side !== "right") return;
    if (event.preventDefault) event.preventDefault();
    GRIP_DRAG = { side: side, startX: event.clientX, startW: currentGripWidth(side) };
    if (grip.classList) grip.classList.add("ko-sd-is-drag");
    if (document.body && document.body.classList) document.body.classList.add("ko-sd-resizing");
  }

  function onGripMove(event) {
    if (!GRIP_DRAG) return;
    // 指针位移是视觉像素、宽度是设计像素：界面整体缩放时先除回设计像素。
    var scale = (window.KnowOriginUiScale && window.KnowOriginUiScale.scale()) || 1;
    var dx = (event.clientX - GRIP_DRAG.startX) / scale;
    // 左边往右拖 = 变宽；右边往右拖 = 变窄，方向相反
    var want = GRIP_DRAG.side === "left" ? GRIP_DRAG.startW + dx : GRIP_DRAG.startW - dx;
    applyGrip(GRIP_DRAG.side, clampGrip(GRIP_DRAG.side, want));
  }

  function endGrip() {
    if (!GRIP_DRAG) return;
    var grips = document.querySelectorAll(".ko-sd-grip");
    for (var i = 0; i < grips.length; i++) {
      if (grips[i].classList) grips[i].classList.remove("ko-sd-is-drag");
    }
    if (document.body && document.body.classList) document.body.classList.remove("ko-sd-resizing");
    saveGripWidths();
    GRIP_DRAG = null;
  }

  function resetGrip(event) {
    var grip = event.currentTarget;
    var side = grip && grip.getAttribute("data-sd-grip");
    if (side !== "left" && side !== "right") return;
    if (event.preventDefault) event.preventDefault();
    var node = overlay();
    if (side === "left") {
      applyGrip("left", GRIP_DEFAULT.left);
    } else {
      GRIP_SAVED.right = 0;
      // 删掉 inline 值 = 交还给 CSS 的 clamp，这才是右栏真正的「复位」
      if (node && node.style && node.style.removeProperty) node.style.removeProperty("--ko-sd-ask-w");
    }
    saveGripWidths();
    notify(side === "left" ? "目录宽度已复位。" : "提问栏宽度已复位。");
  }

  /* ------------------------------------------------------------ 渲染 */

  function kitOf(kind) {
    var kit = VIEW.kits[kind];
    return (kit && kit.content_md) ? kit : null;
  }

  function stampOf(kit) {
    if (!kit || !kit.updated_at) return "";
    return String(kit.updated_at).slice(0, 16).replace("T", " ");
  }

  function sectionHtml(kind) {
    var kit = kitOf(kind.value);
    var busy = Boolean(VIEW.busy[kind.value]);
    var stamp = stampOf(kit);
    var actions =
      '<button type="button" class="ko-sd-btn' + (kit ? "" : " ko-sd-btn-primary") + '" ' +
      'data-sd-gen="' + esc(kind.value) + '"' + (busy ? " disabled" : "") + ">" +
      (busy ? "生成中…" : (kit ? "重新生成" : "生成" + kind.label)) + "</button>" +
      (kit ? '<button type="button" class="ko-sd-btn" data-sd-copy="' + esc(kind.value) +
        '">复制本节</button>' : "");

    var body;
    if (busy) {
      body = '<p class="ko-sd-empty">正在读资料、写' + esc(kind.label) + "…通常需要十几秒。</p>";
    } else if (kit) {
      body = '<div class="ko-sd-md">' + renderMarkdown(kit.content_md) + "</div>";
    } else {
      // 空态只写一句人话 —— 「生成」按钮已经在小节标题栏右侧，这里再放一个就是两个
      // 一模一样的按钮，反而让人犹豫点哪个。
      body = '<p class="ko-sd-empty">这门课还没有' + esc(kind.label) +
        "。点右上角「生成" + esc(kind.label) + "」就地补上。</p>";
    }

    return '<section class="ko-sd-sec" id="ko-sd-sec-' + esc(kind.value) + '" data-sd-sec="' +
      esc(kind.value) + '">' +
      '<div class="ko-sd-sec-head">' +
        '<h2 class="ko-sd-sec-title"><span>' + kind.icon + "</span><span>" + esc(kind.label) + "</span></h2>" +
        (stamp ? '<span class="ko-sd-sec-time">更新于 ' + esc(stamp) + "</span>" : "") +
        '<div class="ko-sd-sec-actions">' + actions + "</div>" +
      "</div>" +
      '<p class="ko-sd-sec-hint">' + esc(kind.hint) + "</p>" +
      body +
      "</section>";
  }

  function docHtml() {
    var ready = KINDS.filter(function (kind) { return Boolean(kitOf(kind.value)); }).length;
    var meta = KINDS.map(function (kind) { return kind.label; }).join(" · ") +
      " · 已生成 " + ready + "/" + KINDS.length;
    return '<article class="ko-sd-doc">' +
      '<header class="ko-sd-doc-head">' +
        '<h1 class="ko-sd-doc-title">' + esc(VIEW.name) + " · 学习文档</h1>" +
        '<p class="ko-sd-doc-sub">' + esc(meta) + "</p>" +
      "</header>" +
      (VIEW.error ? '<div class="ko-sd-err">' + esc(VIEW.error) + "</div>" : "") +
      KINDS.map(sectionHtml).join("") +
      "</article>";
  }

  function metaText() {
    var ready = KINDS.filter(function (kind) { return Boolean(kitOf(kind.value)); }).length;
    var latest = "";
    KINDS.forEach(function (kind) {
      var stamp = stampOf(kitOf(kind.value));
      if (stamp && stamp > latest) latest = stamp;
    });
    return "已生成 " + ready + "/" + KINDS.length + (latest ? " · 最近更新 " + latest : "");
  }

  function render() {
    var node = overlay();
    if (!node) return;
    var body = document.getElementById("ko-sd-body");
    var keep = body ? body.scrollTop : 0;

    setTitle(VIEW.name ? (VIEW.name + " · 学习文档") : "学习文档");
    setMeta(metaText());
    barActions(
      '<button type="button" class="ko-sd-btn" data-sd-refresh>刷新</button>' +
      '<button type="button" class="ko-sd-btn" data-sd-copy-all>复制合并 Markdown</button>'
    );
    if (body) {
      body.innerHTML = (VIEW.loading && VIEW.loadedFor !== VIEW.pid)
        ? '<p class="ko-sd-empty">正在读这份学习文档…</p>'
        : docHtml();
    }
    buildToc();
    if (body) body.scrollTop = keep;
    paintReadbar();
    // 清单报告里的每条知识点补「🌷 问海小棠」（与学习台历、报告弹窗同一套增强）。
    // 复选框类名保持 .ko-ck，增强函数认它。
    if (typeof window.HXT_PET !== "undefined" && window.HXT_PET &&
        typeof window.HXT_PET.enhanceChecklistItems === "function") {
      try { window.HXT_PET.enhanceChecklistItems(body); } catch (e) { /* 增强失败不影响正文 */ }
    }
  }

  function barActions(html) {
    var slot = document.getElementById("ko-sd-actions");
    if (slot) slot.innerHTML = html || "";
  }

  function setMeta(text) {
    var node = document.getElementById("ko-sd-meta");
    if (node) node.textContent = text || "";
  }

  function setTitle(text) {
    var node = document.getElementById("ko-sd-title");
    if (node) node.textContent = text || "学习文档";
  }

  /* ------------------------------------------------------------ 目录 */

  /** 收集正文里的标题：小节头（h2.ko-sd-sec-title）+ 正文里的 h2/h3/h4。 */
  function buildToc() {
    var toc = document.getElementById("ko-sd-toc");
    var body = document.getElementById("ko-sd-body");
    VIEW.heads = [];
    VIEW.tocItems = [];
    if (!toc || !body) return;

    var html = '<div class="ko-sd-toc-title">目录</div>';
    var secs = body.querySelectorAll("[data-sd-sec]");
    for (var i = 0; i < secs.length; i++) {
      var sec = secs[i];
      var kind = kindMeta(sec.getAttribute("data-sd-sec"));
      var kit = kitOf(kind.value);
      if (sec.querySelector(".ko-sd-sec-title")) {
        // label 必须单独存：level 0 的 el 是整个 <section>，它的 textContent 是**整节正文**，
        // 拿它当「当前小节」会把这门课的全部内容塞进提问请求里。
        VIEW.heads.push({ el: sec, level: 0, label: kind.label });
        html += '<button type="button" class="ko-sd-toc-item" data-sd-jump="' + esc(kind.value) + '">' +
          "<span>" + kind.icon + "</span>" +
          '<span class="ko-sd-toc-text">' + esc(kind.label) + "</span>" +
          '<span class="ko-sd-toc-chip' + (kit ? "" : " ko-sd-is-off") + '">' +
          (kit ? "已生成" : "未生成") + "</span></button>";
      }
      // 小节内部的 h2/h3/h4 当子项。文档大标题是 h1，不进目录。
      var subs = sec.querySelectorAll(".ko-sd-md h2, .ko-sd-md h3, .ko-sd-md h4");
      for (var j = 0; j < subs.length; j++) {
        var el = subs[j];
        if (!el.id) el.id = "ko-sd-h" + i + "-" + j;
        var tag = String(el.tagName || "").toLowerCase();
        var level = tag === "h2" ? 1 : (tag === "h3" ? 2 : 3);
        var label = String(el.textContent || "").trim();
        VIEW.heads.push({ el: el, level: level, label: label });
        html += '<button type="button" class="ko-sd-toc-item ko-sd-is-sub' +
          (level >= 3 ? " ko-sd-is-h3" : "") + '" data-sd-anchor="' + esc(el.id) + '">' +
          '<span class="ko-sd-toc-text">' + esc(label) + "</span></button>";
      }
    }
    toc.innerHTML = html;

    var items = toc.querySelectorAll(".ko-sd-toc-item");
    for (var k = 0; k < items.length; k++) VIEW.tocItems.push(items[k]);
    paintActiveHead(activeHeadingIndex());
  }

  function activeHeadingIndex() {
    var body = document.getElementById("ko-sd-body");
    if (!body || !VIEW.heads.length) return -1;
    var top = body.scrollTop + 24;
    var index = 0;
    for (var i = 0; i < VIEW.heads.length; i++) {
      var el = VIEW.heads[i].el;
      if (el && el.offsetTop !== undefined && el.offsetTop <= top) index = i;
      else break;
    }
    return index;
  }

  function paintActiveHead(index) {
    for (var i = 0; i < VIEW.tocItems.length; i++) {
      if (!VIEW.tocItems[i].classList) continue;
      VIEW.tocItems[i].classList.toggle("ko-sd-is-active", i === index);
    }
  }

  function onBodyScroll() {
    var body = document.getElementById("ko-sd-body");
    if (!body) return;
    paintActiveHead(activeHeadingIndex());
    paintReadbar();
    var up = document.getElementById("ko-sd-top");
    if (up && up.classList) up.classList.toggle("ko-sd-is-on", body.scrollTop > 400);
  }

  function paintReadbar() {
    var body = document.getElementById("ko-sd-body");
    var fill = document.getElementById("ko-sd-readbar");
    if (!body || !fill) return;
    var total = body.scrollHeight - body.clientHeight;
    var pct = total > 0 ? Math.max(0, Math.min(100, (body.scrollTop / total) * 100)) : 0;
    fill.style.width = pct + "%";
  }

  function gotoAnchor(id) {
    var body = document.getElementById("ko-sd-body");
    var el = id ? document.getElementById(id) : null;
    if (!body || !el) return;
    body.scrollTop = Math.max(0, el.offsetTop - 12);
    onBodyScroll();
  }

  /** 当前读到哪一节，用于「问 AI」时告诉模型上下文在哪。用 label 而不是 textContent。 */
  function currentSectionTitle() {
    var index = activeHeadingIndex();
    if (index < 0 || !VIEW.heads[index]) return "";
    return String(VIEW.heads[index].label || "").trim();
  }

  /* ------------------------------------------------------------ 选区浮条 */

  function within(root, el) {
    return !!(root && el && root.contains && root.contains(el));
  }

  function readSelection() {
    var body = document.getElementById("ko-sd-body");
    var sel = window.getSelection ? window.getSelection() : null;
    if (!body || !sel || !sel.rangeCount) return "";
    var range = sel.getRangeAt(0);
    if (!range || range.collapsed) return "";
    if (!within(body, range.commonAncestorContainer)) return "";
    return String(sel.toString() || "").trim().slice(0, 400);
  }

  function showSelBar(rect) {
    var bar = document.getElementById("ko-sd-selbar");
    if (!bar || !rect) return;
    if (bar.classList) bar.classList.add("ko-sd-is-on");
    var width = bar.offsetWidth || 200;
    // style.left 是设计像素，rect/innerWidth 是视觉像素：先除回界面缩放。
    var sc = (window.KnowOriginUiScale && window.KnowOriginUiScale.scale()) || 1;
    var left = Math.max(12, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth / sc - width - 12));
    var top = rect.top - (bar.offsetHeight || 40) - 8;
    if (top < 12) top = rect.bottom + 8;
    bar.style.left = left + "px";
    bar.style.top = top + "px";
  }

  function hideSelBar() {
    var bar = document.getElementById("ko-sd-selbar");
    if (bar && bar.classList) bar.classList.remove("ko-sd-is-on");
  }

  function onSelectionChange() {
    if (!VIEW.open) return;
    var found = readSelection();
    if (!found) {
      // ⚠️ 这里**故意不清 VIEW.sel**：点浮条按钮的那一下 mousedown 会先把选区收起来
      // （浏览器给按钮焦点），清掉的话点击事件里读到的就是空 —— 表现是「按钮点了没反应」。
      VIEW.selLive = false;
      hideSelBar();
      return;
    }
    VIEW.sel = found;
    VIEW.selSection = currentSectionTitle();
    VIEW.selLive = true;
    var sel = window.getSelection();
    var rect = null;
    try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch (e) { rect = null; }
    showSelBar(rect);
  }

  /** 点空白处收起浮条。⚠️ 不清 VIEW.sel —— 点「问 AI」按钮本身就是一次 mousedown。 */
  function onDocumentDown(event) {
    if (!VIEW.open) return;
    var target = event && event.target;
    if (!target || !target.closest) return;
    if (target.closest("#ko-sd-selbar") || target.closest("#ko-sd-ask")) return;
    hideSelBar();
  }

  /* ------------------------------------------------------------ 问 AI */

  function setAskHint(text) {
    var node = document.getElementById("ko-sd-ask-hint");
    if (node) node.textContent = text || "";
  }

  function askExtra() {
    var box = document.getElementById("ko-sd-ask-extra");
    return !!(box && box.checked);
  }

  function setAskExtra(on) {
    VIEW.askExtra = !!on;
    var box = document.getElementById("ko-sd-ask-extra");
    if (box) box.checked = !!on;
    var wrap = document.getElementById("ko-sd-ask-mode");
    if (wrap && wrap.classList) wrap.classList.toggle("ko-sd-is-extra", !!on);
    // 提示随档位走，别让「也讲材料外」开着却还提示「没写的会直说」
    setAskHint(on ? "材料外也会答，补充会单独标出来。" : "只依据这份文档作答，没写的它会直说。");
  }

  function askOpen() {
    var panel = document.getElementById("ko-sd-ask");
    return !!(panel && panel.classList && panel.classList.contains("ko-sd-is-on"));
  }

  function openAsk(selection) {
    if (!VIEW.open) return;
    var panel = document.getElementById("ko-sd-ask");
    if (panel && panel.classList) panel.classList.add("ko-sd-is-on");
    // 右把手跟着抽屉一起出现：抽屉关着时分隔线没有归属，留着就是一条悬空的竖线
    var gripR = document.getElementById("ko-sd-grip-r");
    if (gripR && gripR.classList) gripR.classList.add("ko-sd-is-on");
    if (selection) VIEW.askRef = String(selection).slice(0, 400);
    VIEW.askSection = VIEW.selSection || currentSectionTitle();
    paintAskRef();
    paintAsk();
    hideSelBar();
    var input = document.getElementById("ko-sd-ask-input");
    if (input && input.focus) { try { input.focus(); } catch (e) {} }
  }

  function closeAsk() {
    var panel = document.getElementById("ko-sd-ask");
    if (panel && panel.classList) panel.classList.remove("ko-sd-is-on");
    var gripR = document.getElementById("ko-sd-grip-r");
    if (gripR && gripR.classList) gripR.classList.remove("ko-sd-is-on");
  }

  function paintAskRef() {
    var box = document.getElementById("ko-sd-ask-ref");
    var text = document.getElementById("ko-sd-ask-ref-text");
    var section = document.getElementById("ko-sd-ask-section");
    if (section) section.textContent = VIEW.askSection ? "· " + VIEW.askSection : "";
    if (!box || !text) return;
    if (!VIEW.askRef) { box.style.display = "none"; text.textContent = ""; return; }
    box.style.display = "flex";
    text.textContent = "「" + VIEW.askRef + "」";
  }

  function paintAsk() {
    var thread = document.getElementById("ko-sd-ask-thread");
    if (!thread) return;
    if (!VIEW.askThread.length) {
      thread.innerHTML =
        '<div class="ko-sd-ask-empty">选中正文里的一段话，点浮出来的「问 AI」；' +
        "也可以直接把问题写在下面。<br>默认**也讲材料外** —— 文档里没有的，会先按通识补，补充会单独放进「材料外补充」一段；" +
        "想严守本份文档就取消勾选，没写的它会直说。</div>";
      return;
    }
    var html = "";
    for (var i = 0; i < VIEW.askThread.length; i++) {
      var msg = VIEW.askThread[i];
      html += '<div class="ko-sd-ask-q"><span class="ko-sd-ask-q-mark">问</span><span>' +
        esc(msg.q) + "</span></div>";
      // 这一问引用的是哪段原文，跟着问题一起留在记录里 —— 输入区上面那块引用发出去
      // 就清空了（它属于「下一问」），不留一份在轮次里，回头看就不知道问的是哪句话。
      if (msg.sel) {
        html += '<div class="ko-sd-ask-ref"><span class="ko-sd-ask-ref-text">「' + esc(msg.sel) + "」</span></div>";
      }
      if (msg.error) {
        html += '<div class="ko-sd-err">' + esc(msg.error) + "</div>";
      } else if (msg.a) {
        html += '<div class="ko-sd-md ko-sd-ask-a">' + renderMarkdown(msg.a) + "</div>";
      } else if (msg.pending) {
        html += '<div class="ko-sd-ask-empty">正在读这份文档…</div>';
      }
      if (msg.a && !msg.pending) {
        html += '<div class="ko-sd-ask-actions"><span class="ko-sd-ask-hint"></span>' +
          '<button type="button" class="ko-sd-btn" data-sd-ask-copy="' + i + '">复制</button></div>';
      }
    }
    thread.innerHTML = html;
    if (typeof thread.scrollHeight === "number") thread.scrollTop = thread.scrollHeight;
  }

  /** 流式增量重绘节流：每 90ms 最多渲染一次，不然每来一块就重排整段 Markdown 会很卡。 */
  function paintAskSoon() {
    var now = Date.now();
    if (now - VIEW.askPaintAt < 90) return;
    VIEW.askPaintAt = now;
    paintAsk();
  }

  function askHistory() {
    var out = [];
    for (var i = 0; i < VIEW.askThread.length; i++) {
      var msg = VIEW.askThread[i];
      if (msg.pending || msg.error || !msg.a) continue;
      out.push({ question: msg.q, answer: String(msg.a).slice(0, 500) });
    }
    return out.slice(-3);
  }

  /** 裸 fetch 读 SSE：request() 会按 JSON 解析，这里是 text/event-stream。 */
  function streamAsk(payload, onEvent) {
    var pid = VIEW.pid;
    return fetch("/api/projects/" + encodeURIComponent(pid) + "/study-kit/ask", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (resp) {
      if (resp.status === 401) throw new Error("登录状态已失效，请刷新页面后再试。");
      if (!resp.ok || !resp.body) {
        return resp.json().catch(function () { return {}; }).then(function (data) {
          var detail = (data && data.detail && (data.detail.message || data.detail)) || "";
          throw new Error(detail || ("提问失败（HTTP " + resp.status + "）。"));
        });
      }
      var reader = resp.body.getReader();
      var decoder = new TextDecoder();
      var buffer = "";
      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) return;
          buffer += decoder.decode(chunk.value, { stream: true });
          var parts = buffer.split("\n\n");
          buffer = parts.pop();
          for (var i = 0; i < parts.length; i++) {
            var line = String(parts[i]).trim();
            if (line.indexOf("data:") !== 0) continue;
            try { onEvent(JSON.parse(line.slice(5).trim())); } catch (e) { /* 半截 JSON 丢掉 */ }
          }
          return pump();
        });
      }
      return pump();
    });
  }

  /** 小节标题 → 它属于哪一份产物。找不到就交回默认（速查表优先）。 */
  function sectionKindOf(section) {
    var body = document.getElementById("ko-sd-body");
    var title = String(section || "").trim();
    if (!body || !title) return "cheatsheet";
    var secs = body.querySelectorAll("[data-sd-sec]");
    for (var i = 0; i < secs.length; i++) {
      var sec = secs[i];
      var own = sec.querySelector(".ko-sd-sec-title");
      if (own && String(own.textContent || "").indexOf(title) >= 0) {
        return sec.getAttribute("data-sd-sec") || "cheatsheet";
      }
      var subs = sec.querySelectorAll(".ko-sd-md h2, .ko-sd-md h3, .ko-sd-md h4");
      for (var j = 0; j < subs.length; j++) {
        if (String(subs[j].textContent || "").trim() === title) {
          return sec.getAttribute("data-sd-sec") || "cheatsheet";
        }
      }
    }
    return "cheatsheet";
  }

  function askSend() {
    if (!VIEW.pid) { notify("请先打开一份学习文档。"); return; }
    var input = document.getElementById("ko-sd-ask-input");
    var question = String((input && input.value) || "").trim();
    if (!question) { notify("先写一句想问的。"); return; }
    if (VIEW.askBusy) { notify("上一个问题还在回答中。"); return; }

    var msg = { q: question, a: "", pending: true, error: "", sel: VIEW.askRef || "" };
    VIEW.askThread.push(msg);
    VIEW.askBusy = true;
    if (input) input.value = "";
    VIEW.askRef = "";
    paintAskRef();
    paintAsk();
    setAskHint(askExtra() ? "正在读文档，并准备材料外的补充…" : "正在读文档…");

    streamAsk({
      question: question,
      // 让后端把「当前正在读的那一节」所属的产物排在最前面 —— 三份合起来常超过
      // 上下文上限，不指定就退成头部截断，用户明明在读清单报告却拿到速查表。
      kind: sectionKindOf(VIEW.askSection),
      selection: msg.sel,
      section: VIEW.askSection || "",
      history: askHistory(),
      allow_extra: askExtra(),
    }, function (event) {
      if (!event || !event.type) return;
      if (event.type === "delta") {
        msg.a += String(event.text || "");
        msg.pending = false;
        paintAskSoon();
      } else if (event.type === "done") {
        msg.a = String(event.text || msg.a);
        msg.pending = false;
        paintAsk();
      } else if (event.type === "error") {
        msg.pending = false;
        msg.error = String(event.message || "这次没答上来。");
        paintAsk();
      }
    }).catch(function (error) {
      msg.pending = false;
      msg.error = (error && error.message) || "这次没答上来。";
      paintAsk();
    }).then(function () {
      VIEW.askBusy = false;
      setAskHint(askExtra() ? "材料外也会答，补充会单独标出来。" : "只依据这份文档作答，没写的它会直说。");
    });
  }

  /* ------------------------------------------------------------ 数据 */

  function fetchKits(pid) {
    var seq = ++VIEW.seq;
    VIEW.loading = true;
    render();
    return request("/api/projects/" + encodeURIComponent(pid) + "/study-kit")
      .then(function (data) {
        if (seq !== VIEW.seq || VIEW.pid !== pid) return;   // 用户已经切走了，静默丢弃
        var map = {};
        // 只收**项目级**那一份（node_id 为空）—— 节点级窄表混进来，这份「整份文档」
        // 就变成了某个知识点的表，用户会以为资料丢了。
        (data && data.kits ? data.kits : []).forEach(function (kit) {
          if (!kit || kit.node_id) return;
          if (!map[kit.kind]) map[kit.kind] = kit;          // 后端按 updated_at DESC 排，第一条最新
        });
        VIEW.kits = map;
        VIEW.error = "";
      })
      .catch(function (err) {
        if (seq !== VIEW.seq || VIEW.pid !== pid) return;
        VIEW.kits = {};
        VIEW.error = (err && err.message) || "读取失败";
      })
      .then(function () {
        if (seq !== VIEW.seq || VIEW.pid !== pid) return;
        VIEW.loading = false;
        VIEW.loadedFor = pid;
        render();
      });
  }

  function generate(kind) {
    var pid = VIEW.pid;
    var meta = kindMeta(kind);
    if (!pid || VIEW.busy[kind]) return;
    VIEW.busy[kind] = true;
    VIEW.error = "";
    render();
    request("/api/projects/" + encodeURIComponent(pid) + "/study-kit/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: kind }),
    })
      .then(function (data) {
        if (VIEW.pid !== pid) return;                     // 切走了就别往新文档里塞旧结果
        if (data && data.kit) VIEW.kits[kind] = data.kit;
        notify("✅ " + meta.label + "已生成", "success");
      })
      .catch(function (err) {
        if (VIEW.pid !== pid) return;
        VIEW.error = (err && err.message) || "生成失败";
        notify("生成" + meta.label + "失败：" + VIEW.error, "error");
      })
      .then(function () {
        if (VIEW.pid !== pid) return;
        delete VIEW.busy[kind];
        render();
      });
  }

  /** 合并后的 Markdown：三块按目录顺序拼成一份，标题带项目名，可直接贴进笔记。 */
  function mergedMarkdown() {
    var parts = ["# " + VIEW.name + " · 学习文档", ""];
    var any = false;
    KINDS.forEach(function (kind) {
      var kit = kitOf(kind.value);
      if (!kit) return;
      any = true;
      parts.push("## " + kind.label, "");
      if (kit.updated_at) parts.push("> 更新于 " + stampOf(kit), "");
      parts.push(String(kit.content_md || "").trim(), "");
    });
    return any ? parts.join("\n") : "";
  }

  function copyText(text, okMsg) {
    var value = String(text || "");
    if (!value) { notify("还没有可复制的内容，先生成其中一块。", "warning"); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value)
        .then(function () { notify(okMsg, "success"); })
        .catch(function () { notify("复制失败，请手动选中正文复制。", "warning"); });
      return;
    }
    // 老浏览器 / 非安全上下文：退回 execCommand
    try {
      var box = document.createElement("textarea");
      box.value = value;
      box.style.position = "fixed";
      box.style.opacity = "0";
      document.body.appendChild(box);
      box.select();
      document.execCommand("copy");
      document.body.removeChild(box);
      notify(okMsg, "success");
    } catch (e) {
      notify("复制失败，请手动选中正文复制。", "warning");
    }
  }

  /* ------------------------------------------------------------ 沉浸 / 字号 */

  function applyFocus() {
    var node = overlay();
    if (!node || !node.classList) return;
    node.classList.toggle("ko-sd-is-focus", VIEW.focus);
    var btn = document.getElementById("ko-sd-focus");
    if (btn && btn.classList) btn.classList.toggle("ko-sd-is-on", VIEW.focus);
    if (btn) btn.setAttribute("aria-pressed", VIEW.focus ? "true" : "false");
  }

  function toggleFocus() {
    VIEW.focus = !VIEW.focus;
    applyFocus();
    savePrefs();
  }

  function applyScale() {
    var node = overlay();
    if (node && node.style && node.style.setProperty) {
      node.style.setProperty("--ko-sd-scale", SCALES[VIEW.scale].value);
    }
    var btn = document.getElementById("ko-sd-type");
    if (btn) btn.setAttribute("title", "正文字号：" + SCALES[VIEW.scale].label + "（点一下换一档）");
  }

  function cycleScale() {
    VIEW.scale = (VIEW.scale + 1) % SCALES.length;
    applyScale();
    savePrefs();
    notify("正文字号：" + SCALES[VIEW.scale].label);
  }

  /* ------------------------------------------------------------ 键盘 */

  function typingIn(event) {
    var el = event.target;
    if (!el) return false;
    var tag = String(el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    return Boolean(el.isContentEditable);
  }

  function jumpSection(delta) {
    var index = activeHeadingIndex();
    var target = index + delta;
    if (target < 0 || target >= VIEW.heads.length) return;
    var body = document.getElementById("ko-sd-body");
    var el = VIEW.heads[target].el;
    if (!body || !el) return;
    body.scrollTop = Math.max(0, el.offsetTop - 12);
    onBodyScroll();
  }

  function onKeydown(event) {
    if (!VIEW.open) return;
    if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === "k") {
      if (event.preventDefault) event.preventDefault();
      if (askOpen()) {
        var input = document.getElementById("ko-sd-ask-input");
        if (input) input.focus();
      } else {
        openAsk("");
      }
      return;
    }
    if (event.key === "Escape") {
      // 一层一层退：沉浸 → 抽屉 → 整层。直接关掉最外层会让人丢上下文。
      if (VIEW.focus) { toggleFocus(); return; }
      if (askOpen()) { closeAsk(); return; }
      close();
      return;
    }
    if (typingIn(event) || event.ctrlKey || event.metaKey || event.altKey) return;
    var key = String(event.key || "");
    if (key === "f" || key === "F") { if (event.preventDefault) event.preventDefault(); toggleFocus(); return; }
    if (key === "t" || key === "T") {
      if (event.preventDefault) event.preventDefault();
      var body = document.getElementById("ko-sd-body");
      if (body) { body.scrollTop = 0; onBodyScroll(); }
      return;
    }
    if (key === "[") { if (event.preventDefault) event.preventDefault(); jumpSection(-1); return; }
    if (key === "]") { if (event.preventDefault) event.preventDefault(); jumpSection(1); }
  }

  /* ------------------------------------------------------------ 交互 */

  function onClick(event) {
    if (!VIEW.open) return;
    var target = event.target;
    if (!target || !target.closest) return;

    if (target.closest("[data-sd-close]")) { close(); return; }
    if (target.closest("[data-sd-focus-off]")) { toggleFocus(); return; }
    if (target.closest("#ko-sd-focus")) { toggleFocus(); return; }
    if (target.closest("#ko-sd-type")) { cycleScale(); return; }

    if (target.closest("[data-sd-refresh]")) {
      VIEW.loadedFor = "";
      fetchKits(VIEW.pid);
      return;
    }

    var genBtn = target.closest("[data-sd-gen]");
    if (genBtn) { generate(genBtn.getAttribute("data-sd-gen")); return; }

    var copyBtn = target.closest("[data-sd-copy]");
    if (copyBtn) {
      var kit = kitOf(copyBtn.getAttribute("data-sd-copy"));
      copyText(kit ? String(kit.content_md || "").trim() : "", "已复制这一节的 Markdown。");
      return;
    }

    if (target.closest("[data-sd-copy-all]")) {
      copyText(mergedMarkdown(), "已复制合并后的 Markdown，可粘进笔记或打印。");
      return;
    }

    var jump = target.closest("[data-sd-jump]");
    if (jump) {
      var sec = document.getElementById("ko-sd-sec-" + jump.getAttribute("data-sd-jump"));
      var body = document.getElementById("ko-sd-body");
      if (sec && body) { body.scrollTop = Math.max(0, sec.offsetTop - 12); onBodyScroll(); }
      return;
    }

    var anchor = target.closest("[data-sd-anchor]");
    if (anchor) { gotoAnchor(anchor.getAttribute("data-sd-anchor")); return; }

    if (target.closest("[data-sd-top]")) {
      var b = document.getElementById("ko-sd-body");
      if (b) { b.scrollTop = 0; onBodyScroll(); }
      return;
    }

    if (target.closest("[data-sd-ask-open]")) { openAsk(VIEW.selLive ? VIEW.sel : ""); return; }
    if (target.closest("[data-sd-ask-close]")) { closeAsk(); return; }

    if (target.closest("[data-sd-ask-clear]")) { VIEW.askRef = ""; paintAskRef(); return; }

    if (target.closest("[data-sd-ask-send]")) { askSend(); return; }

    var copyAsk = target.closest("[data-sd-ask-copy]");
    if (copyAsk) {
      var msg = VIEW.askThread[Number(copyAsk.getAttribute("data-sd-ask-copy"))];
      copyText(msg ? String(msg.a || "") : "", "已复制这段回答。");
      return;
    }

    // 浮条上的两个按钮读 VIEW.sel 而不是重新取选区：mousedown 已经把选区收起来了
    if (target.closest("[data-sd-ask-sel]")) { openAsk(VIEW.sel); return; }
    if (target.closest("[data-sd-copy-sel]")) {
      copyText(VIEW.sel, "已复制选中的原文。");
      hideSelBar();
    }
  }

  /* ------------------------------------------------------------ 对外 */

  /**
   * 打开某个项目的学习文档。只读，不切换当前项目。
   * @param {string} projectId
   * @param {string} [projectName] 省略时从 state.projects 里找
   */
  function open(projectId, projectName) {
    var pid = String(projectId || "").trim();
    if (!pid) return false;
    ensureStyle();
    var node = ensureOverlay();
    readPrefs();

    VIEW.open = true;
    VIEW.pid = pid;
    VIEW.name = projectLabel(pid, projectName);
    VIEW.kits = {};
    VIEW.loadedFor = "";
    VIEW.busy = {};
    VIEW.error = "";
    VIEW.loading = true;
    VIEW.askThread = [];
    VIEW.askRef = "";
    VIEW.askSection = "";
    VIEW.askBusy = false;
    VIEW.sel = "";
    VIEW.selSection = "";
    VIEW.selLive = false;
    closeAsk();
    hideSelBar();
    setAskExtra(true);  // 「也讲材料外」默认勾选 —— 切文档也跟着回到默认
    paintAskRef();
    paintAsk();

    if (node.classList) node.classList.add("ko-sd-is-open");
    if (document.body && document.body.classList) document.body.classList.add(BODY_OPEN_CLASS);
    applyFocus();
    applyScale();
    render();
    fetchKits(pid);
    return true;
  }

  function close() {
    var node = overlay();
    if (!node) return;
    VIEW.open = false;
    VIEW.seq += 1;                     // 让在途请求的结果作废
    if (node.classList) node.classList.remove("ko-sd-is-open");
    if (document.body && document.body.classList) document.body.classList.remove(BODY_OPEN_CLASS);
    hideSelBar();
    var body = document.getElementById("ko-sd-body");
    if (body) body.innerHTML = "";
    VIEW.kits = {};
    VIEW.loadedFor = "";
    VIEW.askThread = [];
    closeAsk();
  }

  window.KnowOriginStudyDoc = { open: open, close: close };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureStyle);
  } else {
    ensureStyle();
  }
})();
