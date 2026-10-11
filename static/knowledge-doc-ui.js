/* ============================================================================
 * 知源（KnowOrigin）· 知识点文档（Knowledge Doc）
 * ----------------------------------------------------------------------------
 * 一份「复习用详解」：把单个知识点展开成 定义与符号约定 / 推导与机制 /
 * 公式与用法 / 易错点与常见混淆 / 与相邻知识点的关系 / 自测，并可按框架层级
 * 合订成整份知识文档。质量机制：一次只讲一个知识点 + 逐字段兜底合并。
 *
 * 本文件负责三件事：
 *   1. 全屏阅读页（z-index 1500）：左目录 + 右正文，可滚动、可下载 .md；
 *   2. 批量生成：逐个知识点调 POST /nodes/{id}/doc（一次只讲一个点，质量上限靠它），
 *      全部跑完再调 /knowledge-doc/compile 本地合订 —— 可随时停止、失败不中断；
 *   3. 对外桥接：window.KnowOriginKnowledgeDoc，供速查表（cheatsheet-ui.js）调用。
 *
 * 删掉 index.html 里那一行 <script> 即完全回退。
 * ========================================================================== */
(function () {
  "use strict";

  var STYLE_ID = "ko-kd-style";
  var OVERLAY_ID = "ko-kd-overlay";
  var TOC_MIN_WIDTH = 900; // 窄于此宽度就收起目录（工作台折叠态只有 ~278px）
  // 打开本界面时挂到 body 上的类：主界面的「提问导轨」(.question-rail) 挂在 body、
  // z-index 8000、宽 6px，比本层(1500)高 —— 不藏就会像一条带小圆点的竖线叠在正文右侧
  // （2026-09-30 用户报的红框就是它）。card-viewer / usage-doc-viewer 都有同样的先例。
  var BODY_OPEN_CLASS = "ko-kd-open";

  /* ------------------------------------------------------------ 全局安全读取
   * ⚠️ 模块内的状态变量绝不能叫 state —— 会遮蔽 app.js 的全局 state。
   *    （review-ui.js 踩过，见 knoworigin-addon-panel 技能）
   * ⚠️ 模块内的 view 变量同理不能叫 view，取名 VIEW。 */
  var VIEW = {
    open: false,
    mode: "",          // node | compiled | batch
    // 指定的项目。空 = 跟当前项目走（默认）；非空 = 侧栏点了某个项目的「文档」图标，
    // 只读那一份文档，**不切换当前项目**（切了会把正在看的会话整屏换掉）。
    // 经 currentProjectId() 生效，所以本模块所有取数/合订/提问一并跟着走，不需要逐个改。
    pid: "",
    scope: "",
    nodeId: "",
    title: "",
    markdown: "",
    heads: [],         // 正文里的 h2/h3 元素，用来算「读到哪一节」
    tocItems: [],      // 左目录按钮，与 heads 一一对应
    docSections: [],   // 合订稿的递进坐标（content.sections），用来给目录挂层号徽标
    sel: "",           // 当前选中的原文
    selSection: "",    // 选中时所在的小节
    selInMark: false,  // 选区是不是落在已有高亮里（决定浮条上写「高亮」还是「去高亮」）
    selLive: false,    // 此刻是不是真有一段选中（点浮条按钮的那一下选区会先被收起来）
    editable: false,   // 当前正文是不是可编辑（只有真文档才开；进度条/空态不开）
    dirty: false,      // 有改动还没写回库
    lastDoc: null,     // 当前这份文档（改完正文要能原样重画一遍）
    askThread: [],
    askRef: "",
    askSection: "",
    askBusy: false,
    askPaintAt: 0,
    askExtra: true, // 「也讲材料外」：默认 true —— 优先放开材料外补充（2026-10-07）
    order: "tree",  // 合订排序口径：tree = 按框架章节；layer = 按前置层号（由浅入深）
    maxLayer: 0,    // 只收进第 1~N 层；0 = 全要
    layers: [],     // 每层的知识点数（/knowledge-doc/layers）
    picker: false,  // 「按层级合订」面板是否展开
    batchKind: "fill", // fill = 补齐缺的；refresh = 全部重新生成
    pending: [],       // 批量生成的待办节点
    done: 0,
    failed: [],
    total: 0,
    startedAt: 0,
    cancelled: false,
    busy: false,
    error: "",
    pendingSection: "",  // 打开文档后要滚到的小节标题（来自知识卡片「回到文档」）
  };

  /* --------------------------------------------- 自测题回流：用户可见的开关 */

  // 回流是有副作用的（多几张卡、进复习队列、之后写掌握度），所以必须让用户知情并可选。
  // 三态：null = 从没问过（首次生成前问一次）；true/false = 用户已表态，之后不再打扰。
  var SYNC_PREF_KEY = "knoworigin.kd.syncCards";

  function readSyncPref() {
    try {
      var raw = window.localStorage.getItem(SYNC_PREF_KEY);
      if (raw === "on") return true;
      if (raw === "off") return false;
    } catch (e) {}
    return null;
  }

  function writeSyncPref(value) {
    try {
      window.localStorage.setItem(SYNC_PREF_KEY, value ? "on" : "off");
    } catch (e) {}
  }

  /**
   * 首次生成前问一次「自测题要不要一起进复习」。返回 true/false 表示本轮的选择。
   *
   * 用 window.confirm 而不是自造弹窗：与这一层既有的「全部重新生成」确认（startBatch）
   * 保持同一种交互，用户不需要学两套。宿主没有 confirm 时按「加入」继续 —— 与既有取舍一致。
   */
  function askSyncOnce(count, what) {
    var pref = readSyncPref();
    if (pref !== null) return pref;
    if (typeof window.confirm !== "function") return true;
    var ok = true;
    try {
      ok = window.confirm(
        (what || "这份文档") + "里的自测题会一并加入【知识卡片】" +
        (count > 0 ? "（最多 " + count + " 张）" : "") +
        "：它们会进复习队列，之后自测打分会计入掌握度。\n" +
        "要一起加入吗？选「取消」则只生成文档，不动知识卡片。"
      );
    } catch (e) {
      return true;
    }
    writeSyncPref(ok);
    return ok;
  }

  function currentProjectId() {
    if (VIEW.pid) return VIEW.pid;   // 侧栏指定了项目 → 以它为准（关掉文档页时清空）
    try {
      if (typeof state !== "undefined" && state && state.currentProjectId) return state.currentProjectId;
    } catch (e) {}
    return "";
  }

  function currentProject() {
    try {
      if (typeof state !== "undefined" && state && Array.isArray(state.projects)) {
        var pid = currentProjectId();
        for (var i = 0; i < state.projects.length; i++) {
          if (state.projects[i].project_id === pid) return state.projects[i];
        }
      }
    } catch (e) {}
    return null;
  }

  function esc(v) {
    try { if (typeof escapeHtml === "function") return escapeHtml(v); } catch (e) {}
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /** 写进 HTML 属性时用 —— escapeHtml 不管引号，标题里带个引号就会把属性截断。 */
  function attr(v) {
    return esc(v).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /** ⚠️ showToast 只认 variant === "notice"；传别的值会让提示**显示成红色报错样式**。
   *  所以这里固定传 notice，调用处多传的第二个参数一律忽略。 */
  function notify(message) {
    try { if (typeof showToast === "function") { showToast(message, { variant: "notice" }); return; } } catch (e) {}
    try { if (typeof console !== "undefined") console.log("[knowledge-doc] " + message); } catch (e) {}
  }

  function fail(error) {
    var msg = (error && (error.message || error.detail)) || String(error || "操作失败");
    if (typeof error === "object" && error && error.payload && error.payload.message) msg = error.payload.message;
    VIEW.error = String(msg);
    renderError();
    notify(String(msg), "error");
  }

  /** POST/PUT 必须自己序列化 + 补 Content-Type：api() 是 fetch 直通，不会自动补头。 */
  function post(path, body, method) {
    return api(path, {
      method: method || "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  }

  function projectLabel() {
    var p = currentProject();
    if (!p) return "当前课程";
    var subject = p.subject || "";
    var year = p.year || "";
    return year ? subject + "（" + year + "）" : (subject || "当前课程");
  }

  /* ------------------------------------------------------------ 顶栏图标按钮
   * 顶栏这一排动作一律**只出图标、不出文字**：下载 / 复制 / 重新生成 / 合订口径 /
   * 问 AI / 关闭 六个按钮原来各带 3~6 个字，占掉大半条顶栏，把「更新于…·约 N 字」那行
   * 小字挤到换行。改成见方图标后宽度恒为按钮本身，原来的文字信息全部落到 title +
   * aria-label 上（悬停即见，屏幕阅读器也读得到），动作一个没少。
   * 图标沿用仓库既有写法：内联 <svg> + stroke=currentColor，跟着主题自动变色。 */
  var ICONS = {
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
    merge: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
    doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
    chat: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  };

  function ico(name) {
    return (
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      (ICONS[name] || "") + "</svg>"
    );
  }

  /** 顶栏图标按钮。``label`` 只进 title + aria-label，可见区域里只有图标；
   *  ``extra`` 是调用方自己拼的属性串（data-kd-* / id），调用前请用 attr() 过一遍。 */
  function iconBtn(icon, label, extra, cls) {
    return (
      '<button type="button" class="ko-kd-btn ko-kd-btn-icon' + (cls ? " " + cls : "") + '"' +
      (extra || "") +
      ' title="' + attr(label) + '" aria-label="' + attr(label) + '">' +
      ico(icon) + "</button>"
    );
  }

  /* ------------------------------------------------------------ 样式注入 */

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      "#" + OVERLAY_ID + " {",
      "  position: fixed; inset: 0; z-index: 1500; display: flex; flex-direction: column;",
      "  background: var(--panel); color: var(--ink);",
      "}",
      // 主界面的「提问导轨」比本层高（body 上、z-index 8000、宽 6px），整屏打开时必须藏掉，
      // 否则它会叠在正文右侧（看起来像一条带小圆点的细滚动条）。跟随项目既有先例：
      // body.card-viewer-open .question-rail / body.usage-doc-open .question-rail。
      "body." + BODY_OPEN_CLASS + " .question-rail { display: none; }",
      /* ——— 顶栏 ——— */
      ".ko-kd-bar {",
      "  flex: 0 0 auto; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;",
      "  padding: 11px 20px 10px; border-bottom: 1px solid var(--line); background: var(--panel);",
      "}",
      ".ko-kd-bar-title { flex: 1 1 220px; min-width: 0; font-weight: 650; letter-spacing: .01em;",
      "  font-size: calc(15.5px * var(--font-scale, 1)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      ".ko-kd-bar-title::before { content: \"\"; display: inline-block; width: 3px; height: .92em;",
      "  margin-right: 9px; border-radius: 2px; background: var(--green); vertical-align: -.06em; }",
      ".ko-kd-bar-meta { flex: 0 1 auto; font-size: calc(11.5px * var(--font-scale, 1)); color: var(--muted); }",
      "#ko-kd-actions { flex: 0 0 auto; display: flex; gap: 8px; flex-wrap: wrap; }",
      ".ko-kd-btn {",
      "  flex: 0 0 auto; border: 1px solid var(--line); border-radius: 9px;",
      "  padding: 6px 13px; font-size: calc(12.5px * var(--font-scale, 1)); line-height: 1.35;",
      "  background: var(--panel); color: var(--ink); cursor: pointer;",
      "  transition: background .15s ease, border-color .15s ease, color .15s ease;",
      "}",
      ".ko-kd-btn:hover { border-color: var(--green); color: var(--green-dark); }",
      ".ko-kd-btn:disabled { opacity: .5; cursor: default; }",
      ".ko-kd-btn-primary { background: var(--green-soft); border-color: transparent; color: var(--green-dark); }",
      ".ko-kd-btn-primary:hover:not(:disabled) { background: var(--green); color: #0e1410; }",
      /* 纯图标按钮：见方化后顶栏宽度恒定，不再被按钮文字挤到换行。
         尺寸跟 --font-scale 一起缩放，和同排的文字按钮保持同一档视觉重量。 */
      ".ko-kd-btn-icon { display: inline-flex; align-items: center; justify-content: center;",
      "  width: calc(30px * var(--font-scale, 1)); height: calc(30px * var(--font-scale, 1)); padding: 0; }",
      ".ko-kd-btn-icon svg { display: block; width: calc(15px * var(--font-scale, 1));",
      "  height: calc(15px * var(--font-scale, 1)); }",
      /* 阅读进度：顶栏下面一条 2px 细线，比滚动条更直观地说明「读到哪了」。
         名字刻意不叫 ko-kd-progress —— 那个名字已经被「批量生成进度」占了。 */
      ".ko-kd-readbar { flex: 0 0 auto; height: 2px; background: transparent; }",
      ".ko-kd-readbar-fill { height: 100%; width: 0; background: var(--green); transition: width .12s linear; }",
      ".ko-kd-main { flex: 1 1 auto; min-height: 0; display: flex; position: relative; }",
      /* ——— 分栏拖动手柄 ———
         * 命中区刻意比布局宽得多（::before 向两侧各外扩 7px，实际可点区约 24px）。
         * 6px 宽的把手在真机上等于打不中 —— 用户会瞄着**看得见的那条线**去拖。
         * 所以这里还有个硬约束：**分隔线只由把手画**，侧栏自己不画 border，
         * 否则会出现两条挨在一起的竖线，用户拖的是左边那条（不在把手里），永远没反应。 */
      ".ko-kd-grip { flex: 0 0 10px; position: relative; cursor: col-resize;",
      "  background: transparent; z-index: 3; touch-action: none; user-select: none; }",
      ".ko-kd-grip::before { content: \"\"; position: absolute; top: 0; bottom: 0;",
      "  left: -7px; right: -7px; }",
      ".ko-kd-grip::after { content: \"\"; position: absolute; top: 0; bottom: 0;",
      "  left: 50%; width: 1px; margin-left: -0.5px; background: var(--line);",
      "  transition: background .12s ease, width .12s ease; }",
      ".ko-kd-grip:hover { background: rgba(var(--green-rgb), .07); }",
      ".ko-kd-grip:hover::after, .ko-kd-grip.ko-kd-is-drag::after {",
      "  width: 3px; margin-left: -1.5px; background: var(--green); }",
      // 抽屉关着时不该留一条悬空的竖线在正文右缘
      ".ko-kd-grip-r { display: none; }",
      ".ko-kd-grip-r.ko-kd-is-on { display: block; }",
      // 拖动时锁住整页的指针捕获与选中：不然会顺带把正文选起来
      "body.ko-kd-resizing { cursor: col-resize; user-select: none; }",
      "body.ko-kd-resizing * { cursor: col-resize !important; }",
      /* ——— 左目录 ——— */
      // 底色用 --panel 而不是 --background：应用调色板里 --muted 压 --background 只有
      // 4.48，比正文 4.5 的线差 0.02（真机对比度取样量到的）。**没有 border-right** ——
      // 分隔线交给 .ko-kd-grip 画，两边都画就会出现两条挨在一起的线（见上面的说明）。
      // 宽度走 CSS 变量而不是硬编码：拖动时只改这一个变量的 inline 值。
      ".ko-kd-toc {",
      "  flex: 0 0 var(--ko-kd-toc-w, 234px); overflow-y: auto; overscroll-behavior: contain;",
      "  padding: 0 10px 40px 12px; background: var(--panel);",
      "}",
      ".ko-kd-toc-title { position: sticky; top: 0; z-index: 2; background: var(--panel);",
      "  padding: 14px 8px 8px; font-size: calc(11px * var(--font-scale, 1)); color: var(--muted);",
      "  letter-spacing: .1em; }",
      ".ko-kd-toc-list { padding-top: 4px; }",
      ".ko-kd-toc-item {",
      "  display: block; width: 100%; text-align: left; border: 0; background: transparent;",
      "  color: var(--ink); cursor: pointer; border-radius: 0 7px 7px 0;",
      "  padding: 5px 8px 5px 10px; font-size: calc(12.5px * var(--font-scale, 1)); line-height: 1.35;",
      "  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;",
      "  border-left: 2px solid transparent;",
      "}",
      // 悬停/选中都用「半透明绿 + --ink」而不是 --green-soft + --green-dark：
      // 后者在深色下是「深绿底压深绿字」（2026-09-29 踩过 1.43 对比度）。--ink 永远安全。
      ".ko-kd-toc-item:hover { background: rgba(var(--green-rgb), .12); color: var(--ink); }",
      ".ko-kd-toc-item.ko-kd-is-sub { padding-left: 18px; font-size: calc(12px * var(--font-scale, 1)); color: var(--muted); }",
      ".ko-kd-toc-item.ko-kd-is-active {",
      "  background: rgba(var(--green-rgb), .14); border-left-color: var(--green);",
      "  color: var(--ink); font-weight: 600;",
      "}",
      ".ko-kd-toc-chip { display: inline-block; margin-left: 6px; padding: 0 5px; border-radius: 999px;",
      "  font-size: calc(10px * var(--font-scale, 1)); color: var(--muted);",
      "  border: 1px solid var(--line); vertical-align: 1px; }",
      ".ko-kd-toc-empty { padding: 8px; font-size: calc(12px * var(--font-scale, 1)); color: var(--muted); }",
      /* 「按层级合订」面板：落在顶栏动作区里，所以要按行铺开而不是挤成一行 */
      "#ko-kd-actions.ko-kd-is-picker { flex: 1 1 100%; }",
      ".ko-kd-layer-panel { display: flex; flex-direction: column; gap: 8px; padding: 2px; }",
      ".ko-kd-layer-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }",
      ".ko-kd-layer-label { flex: 0 0 auto; font-size: calc(12px * var(--font-scale, 1));",
      "  color: var(--muted); }",
      ".ko-kd-btn.ko-kd-opt.ko-kd-is-on { background: var(--green-soft);",
      "  border-color: var(--green); color: var(--green-dark); }",
      /* ——— 正文 ——— */
      // ⚠️ 别用 `padding: 30px max(22px, calc((100% - 780px) / 2)) 120px` 来做「正文居中留白」：
      //    padding 的百分比是相对**包含块**算的（这里是整个主区，不是 .ko-kd-body 自己），
      //    代入一算内容宽 = 主区宽 - 目录 - 抽屉 - (主区宽 - 780) = 780 - 目录 - 抽屉，
      //    **跟窗口宽度完全无关** —— 不开抽屉恒 546px，开了抽屉恒 174px（2026-09-30 真机翻车，
      //    窗口越宽 padding 越大、正文反而越窄）。
      //    正解：容器给固定水平内边距，内容块自己 max-width + margin auto。
      ".ko-kd-body {",
      "  flex: 1 1 auto; min-width: 0; overflow-y: auto; overscroll-behavior: contain;",
      "  padding: 30px 22px 120px;",
      "}",
      ".ko-kd-body > .ko-kd-md { max-width: 780px; margin: 0 auto; }",
      ".ko-kd-body > .ko-kd-err { max-width: 780px; margin: 0 auto 16px; }",
      // 空态与进度块本来就比正文窄，只补居中，别把它们的 max-width 撑开
      ".ko-kd-body > .ko-kd-empty, .ko-kd-body > .ko-kd-progress {",
      "  margin-left: auto; margin-right: auto;",
      "}",
      ".ko-kd-md { font-size: calc(14.5px * var(--font-scale, 1)); line-height: 1.8; }",
      ".ko-kd-md h1 { font-size: calc(24px * var(--font-scale, 1)); margin: 0 0 4px; font-weight: 700; letter-spacing: -.01em; }",
      ".ko-kd-md h2 { font-size: calc(17px * var(--font-scale, 1)); margin: 34px 0 12px;",
      "  font-weight: 650; scroll-margin-top: 18px; }",
      ".ko-kd-md h2::before { content: \"\"; display: inline-block; width: 3px; height: .95em;",
      "  margin-right: 9px; border-radius: 2px; background: var(--green); vertical-align: -.08em; }",
      ".ko-kd-md h3 { font-size: calc(15.5px * var(--font-scale, 1)); margin: 26px 0 8px; font-weight: 650; scroll-margin-top: 18px; }",
      ".ko-kd-md h4 { font-size: calc(14px * var(--font-scale, 1)); margin: 20px 0 6px; font-weight: 600; color: var(--muted); }",
      ".ko-kd-md p { margin: 9px 0; }",
      ".ko-kd-md ul, .ko-kd-md ol { margin: 9px 0; padding-left: 24px; }",
      ".ko-kd-md li { margin: 5px 0; }",
      ".ko-kd-md blockquote {",
      "  margin: 12px 0; padding: 9px 15px; border-left: 3px solid var(--green);",
      "  background: rgba(var(--green-rgb), .10); color: var(--ink); border-radius: 0 9px 9px 0;",
      "  font-size: calc(13.5px * var(--font-scale, 1));",
      "}",
      ".ko-kd-md blockquote p { margin: 2px 0; }",
      ".ko-kd-md hr { border: 0; border-top: 1px solid var(--line); margin: 30px 0; }",
      ".ko-kd-md code { background: var(--background); border: 1px solid var(--line);",
      "  border-radius: 6px; padding: 1px 5px; font-size: calc(13px * var(--font-scale, 1)); }",
      // 表格改成圆角细线（border-collapse: separate 才吃 border-radius），别再是格子墙
      ".ko-kd-md table { width: 100%; border-collapse: separate; border-spacing: 0; margin: 14px 0;",
      "  border: 1px solid var(--line); border-radius: 10px; overflow: hidden;",
      "  font-size: calc(13.5px * var(--font-scale, 1)); }",
      ".ko-kd-md th, .ko-kd-md td { border: 0; border-bottom: 1px solid var(--line);",
      "  padding: 8px 11px; text-align: left; vertical-align: top; }",
      ".ko-kd-md tr:last-child th, .ko-kd-md tr:last-child td { border-bottom: 0; }",
      ".ko-kd-md th { background: var(--background); font-weight: 600; white-space: nowrap; }",
      ".ko-kd-md tr:nth-child(even) td { background: var(--background); }",
      ".ko-kd-md .katex { font-size: 1.02em; }",
      ".ko-kd-ck { color: var(--muted); }",
      ".ko-kd-ck.ko-kd-is-done { color: var(--green-dark); }",
      /* 高亮：``==一句==`` 渲染出来的 <mark>。
         底色用主题的绿（不是固定黄）—— 黄底在深色下压浅字必翻车，绿底两档主题都验过。
         文字色固定 --ink，绝不继承：mark 的默认 color 在深色里是黑的。 */
      ".ko-kd-md mark { background: rgba(var(--green-rgb), .30); color: var(--ink);",
      "  border-radius: 3px; padding: 1px 2px; }",
      /* ——— 正文直改（contenteditable）———
         不给 focus 描边：整篇都是可编辑区，一圈框看着像「进了某个模式」，
         而用户的心理模型应该是「这就是一份能改的文档」。光标用主题色点一下就够。 */
      ".ko-kd-md[contenteditable='true'] { outline: 0; caret-color: var(--green); }",
      // 公式是 contenteditable=false 的整块，选中时别让它像链接一样变手型
      ".ko-kd-md .ko-kd-tex { cursor: text; }",
      /* ——— 回到顶部 / 选中浮条 ——— */
      ".ko-kd-top, .ko-kd-selbar { position: fixed; z-index: 1560; display: none; }",
      ".ko-kd-top.ko-kd-is-on, .ko-kd-selbar.ko-kd-is-on { display: flex; }",
      ".ko-kd-top { right: 26px; bottom: 26px; width: 38px; height: 38px;",
      "  align-items: center; justify-content: center;",
      "  border: 1px solid var(--line); border-radius: 999px; background: var(--panel);",
      "  color: var(--ink); cursor: pointer; font-size: calc(15px * var(--font-scale, 1));",
      "  box-shadow: 0 6px 18px rgba(0,0,0,.12); }",
      ".ko-kd-top:hover { border-color: var(--green); color: var(--green-dark); }",
      // 问 AI 抽屉开着时，「发送」按钮正好压在 fixed 的回到顶部上 —— 把后者挪到抽屉左侧。
      // 宽度用抽屉自己的 var（拖过把手也准）。窄屏抽屉是浮层（宽 min(420px,94vw)），那条规则不适用，只限宽屏。
      "@media (min-width: 1221px) {",
      "  #ko-kd-overlay:has(.ko-kd-ask.ko-kd-is-on) .ko-kd-top {",
      "    right: calc(var(--ko-kd-ask-w, clamp(340px, 28vw, 420px)) + 14px); }",
      "}",
      ".ko-kd-selbar { align-items: center; gap: 6px; padding: 5px;",
      "  border: 1px solid var(--line); border-radius: 10px; background: var(--panel);",
      "  box-shadow: 0 8px 22px rgba(0,0,0,.16); }",
      ".ko-kd-selbar .ko-kd-btn { padding: 4px 10px; font-size: calc(12px * var(--font-scale, 1)); }",
      /* ——— 提问抽屉 ——— */
      // 抽屉的 border-left 同样去掉 —— 分隔线只由右把手画，否则又是两条线。
      ".ko-kd-ask { flex: 0 0 0; width: 0; display: none; overflow: hidden;",
      "  background: var(--panel); }",
      // 抽屉宽度跟视口走：宽屏给到 420px（正文照样能拿满 780），窄屏收到 340px 别把正文挤死。
      // 用户拖过之后以他拖的为准（--ko-kd-ask-w），没拖过才用这个 clamp。
      ".ko-kd-ask.ko-kd-is-on { display: flex; flex-direction: column;",
      "  flex: 0 0 var(--ko-kd-ask-w, clamp(340px, 28vw, 420px));",
      "  width: var(--ko-kd-ask-w, clamp(340px, 28vw, 420px)); min-height: 0; }",
      ".ko-kd-ask-head { flex: 0 0 auto; display: flex; align-items: center; gap: 8px;",
      "  padding: 12px 14px; border-bottom: 1px solid var(--line); }",
      ".ko-kd-ask-title { flex: 0 0 auto; font-weight: 650; font-size: calc(13.5px * var(--font-scale, 1)); }",
      ".ko-kd-ask-section { flex: 1 1 auto; min-width: 0; overflow: hidden;",
      "  text-overflow: ellipsis; white-space: nowrap;",
      "  font-size: calc(11.5px * var(--font-scale, 1)); color: var(--muted); }",
      ".ko-kd-ask-thread { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 12px 14px; }",
      ".ko-kd-ask-empty { color: var(--muted); font-size: calc(12.5px * var(--font-scale, 1)); line-height: 1.75; }",
      ".ko-kd-ask-q { display: flex; gap: 8px; margin: 14px 0 8px;",
      "  font-size: calc(13px * var(--font-scale, 1)); font-weight: 600; }",
      ".ko-kd-ask-q-mark { flex: 0 0 auto; width: 18px; height: 18px; border-radius: 6px;",
      "  text-align: center; line-height: 18px; font-size: calc(11px * var(--font-scale, 1));",
      "  background: rgba(var(--green-rgb), .16); color: var(--ink); }",
      ".ko-kd-ask-a { font-size: calc(13.5px * var(--font-scale, 1)); }",
      ".ko-kd-ask-ref { display: flex; align-items: flex-start; gap: 6px; margin: 0 0 8px;",
      "  padding: 7px 9px; border-radius: 8px; border-left: 3px solid var(--green);",
      "  background: rgba(var(--green-rgb), .10); color: var(--ink);",
      "  font-size: calc(12px * var(--font-scale, 1)); }",
      ".ko-kd-ask-ref-text { flex: 1 1 auto; min-width: 0; max-height: 68px; overflow: hidden; line-height: 1.6; }",
      ".ko-kd-ask-ref-x { flex: 0 0 auto; border: 0; background: transparent; cursor: pointer;",
      "  color: var(--muted); font-size: calc(14px * var(--font-scale, 1)); line-height: 1; }",
      ".ko-kd-ask-compose { flex: 0 0 auto; border-top: 1px solid var(--line); padding: 10px 14px 12px; }",
      ".ko-kd-ask-input { width: 100%; box-sizing: border-box; resize: vertical; min-height: 62px;",
      "  border: 1px solid var(--line); border-radius: 9px; padding: 8px 10px;",
      "  background: var(--panel); color: var(--ink);",
      "  font: inherit; font-size: calc(13px * var(--font-scale, 1)); line-height: 1.6; }",
      ".ko-kd-ask-input:focus { outline: 0; border-color: var(--green); }",
      ".ko-kd-ask-actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; }",
      ".ko-kd-ask-hint { flex: 1 1 auto; min-width: 0; font-size: calc(11px * var(--font-scale, 1)); color: var(--muted); }",
      /* 两档切换：默认严格（材料外直说没写），勾上才允许发散，且补充会被分段标出来。
       * 用 checkbox 而不是 select —— 要的是「这一问的授权」，不是「一种提问模式」，
       * 少一次点击、也让「默认不授权」这件事一眼可见。 */
      ".ko-kd-ask-mode { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 5px;",
      "  margin-bottom: 6px;",
      "  font-size: calc(11.5px * var(--font-scale, 1)); color: var(--muted);",
      "  cursor: pointer; user-select: none; white-space: nowrap; }",
      ".ko-kd-ask-mode input { margin: 0; width: 13px; height: 13px; accent-color: var(--green); cursor: pointer; }",
      ".ko-kd-ask-mode.ko-kd-is-extra { color: var(--ink); }",
      /* 进度 / 空态 / 错误 */
      ".ko-kd-progress { max-width: 620px; }",
      ".ko-kd-progress-bar { height: 8px; border-radius: 5px; background: rgba(var(--green-rgb), .18); overflow: hidden; margin: 14px 0 10px; }",
      ".ko-kd-progress-fill { height: 100%; background: var(--green); border-radius: 5px; transition: width .3s ease; }",
      ".ko-kd-progress-line { font-size: calc(13.5px * var(--font-scale, 1)); margin: 6px 0; }",
      ".ko-kd-progress-hint { font-size: calc(12.5px * var(--font-scale, 1)); color: var(--muted); margin-top: 10px; line-height: 1.7; }",
      ".ko-kd-log { margin-top: 14px; font-size: calc(12px * var(--font-scale, 1)); color: var(--muted);",
      "  max-height: 180px; overflow-y: auto; border-top: 1px solid var(--line); padding-top: 10px; }",
      ".ko-kd-log-line { padding: 2px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      ".ko-kd-log-line.ko-kd-is-bad { color: var(--red); }",
      ".ko-kd-empty { color: var(--muted); font-size: calc(14px * var(--font-scale, 1));",
      "  line-height: 1.8; max-width: 620px; }",
      ".ko-kd-empty-actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }",
      ".ko-kd-err { margin: 0 0 16px; padding: 10px 14px; border-radius: 9px;",
      "  background: rgba(200, 90, 80, .12); border: 1px solid var(--red); color: var(--red);",
      "  font-size: calc(13px * var(--font-scale, 1)); }",
      "@media (max-width: " + TOC_MIN_WIDTH + "px) {",
      "  .ko-kd-toc { display: none; }",
      "  .ko-kd-grip-l { display: none; }",
      "  .ko-kd-body { padding: 20px 16px 90px; }",
      "}",
      // 窄屏：抽屉改成浮在正文之上，不把正文挤成一条缝。
      // 判据是「占位模式下正文还剩多少」：内容宽 = 视口 - 目录(234) - 抽屉 - 内边距(44)，
      // 低于 ~570px 就没法读了（1220 - 650 = 570），所以断点取 1220。
      "@media (max-width: 1220px) {",
      "  .ko-kd-ask.ko-kd-is-on { position: absolute; top: 0; right: 0; bottom: 0;",
      "    flex: 0 0 auto; width: min(420px, 94vw); z-index: 6;",
      "    box-shadow: -10px 0 28px rgba(0,0,0,.16); }",
      // 抽屉浮起来之后不占布局宽度了，右把手就没有可拖的东西 —— 收掉。
      // ⚠️ 选择器必须带上 .ko-kd-is-on：它和上面那条同权（都是两个 class），
      // 靠「写在后面」取胜。只写 .ko-kd-grip-r 会被上面的 .ko-kd-grip-r.ko-kd-is-on 压过去。
      "  .ko-kd-grip-r, .ko-kd-grip-r.ko-kd-is-on { display: none; }",
      "}",
    ].join("\n");
    var node = document.createElement("style");
    node.id = STYLE_ID;
    node.textContent = css;
    document.head.appendChild(node);
  }

  /* ------------------------------------------------------- Markdown 渲染 --
   * 抄自 static/study-desk-ui.js 的 renderMarkdown：先把公式抽成占位符 →
   * 再转义 → 套标签 → 最后还原成 KaTeX。
   * ⚠️ 公式必须在转义**之前**抽走：模型写 `$a < b$` 时，先 esc 会把它变成
   *    `$a &lt; b$`，KaTeX 拿到的是坏 LaTeX —— 用户看到的就是「公式渲染不出来」。
   * 本文件比它多认两样：`>` 引用（节点元信息行）与 `---` 分隔线。 */

  function renderMarkdown(source) {
    var mathBlocks = [];
    function protect(tex, display) {
      var token = "\u0000MATH" + mathBlocks.length + "\u0000";
      mathBlocks.push({ tex: tex, display: display });
      return token;
    }
    var guarded = String(source == null ? "" : source)
      .replace(/\$\$([\s\S]+?)\$\$/g, function (m, tex) { return protect(tex, true); })
      .replace(/\\\[([\s\S]+?)\\\]/g, function (m, tex) { return protect(tex, true); })
      .replace(/\\\(([\s\S]+?)\\\)/g, function (m, tex) { return protect(tex, false); })
      .replace(/\$(?!\$)([^\n$]+?)\$(?!\$)/g, function (m, tex) { return protect(tex, false); });

    var lines = esc(guarded).split(/\r?\n/);
    var out = [];
    var inTable = false;
    var inList = "";
    var inQuote = false;
    var headerDone = false;

    function closeBlocks() {
      if (inTable) { out.push("</tbody></table>"); inTable = false; headerDone = false; }
      if (inList) { out.push(inList === "ul" ? "</ul>" : "</ol>"); inList = ""; }
      if (inQuote) { out.push("</blockquote>"); inQuote = false; }
    }

    function inline(text) {
      return text
        // 高亮：`==一句==` → <mark>。放在最前，里面还能再吃加粗等行内样式。
        // ⚠️ 只认同一行内的 `==`，且要求中间至少有一个非 `=` 字符 —— 否则 `===`
        //    这类分隔线会被当成空的 <mark>。
        .replace(/==([^=\n]+)==/g, "<mark>$1</mark>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        // 后端把 `<` `>` 写成 `\<` `\>` 防裸 HTML；esc() 之后它变成 `\&lt;`，
        // 这里先还原回实体，用户看到的就是字面量 `<`。
        .replace(/\\&lt;/g, "&lt;")
        .replace(/\\&gt;/g, "&gt;")
        // Markdown 的反斜杠转义：`\X` 表示字面量 X。表格单元格里的 `\|` 就靠这一步
        // 还原成竖线；后端 _md_cell 加的反斜杠在这里被消费掉，用户看不到反斜杠。
        .replace(/\\([\\`*_{}\[\]()#+\-.!|>~])/g, "$1");
    }

    lines.forEach(function (raw) {
      var line = raw.replace(/\s+$/, "");

      if (/^\s*\|.*\|\s*$/.test(line)) {
        if (/^[\s|:-]+$/.test(line)) return; // 分隔行
        if (inQuote) { out.push("</blockquote>"); inQuote = false; }
        if (inList) { out.push(inList === "ul" ? "</ul>" : "</ol>"); inList = ""; }
        // 只按「未被反斜杠转义的竖线」切分：单元格里的 `\|` 是内容，不是分隔符。
        var cells = line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/);
        if (!inTable) { out.push("<table><tbody>"); inTable = true; headerDone = false; }
        if (!headerDone) {
          out.push("<thead><tr>" + cells.map(function (c) { return "<th>" + inline(c.trim()) + "</th>"; }).join("") + "</tr></thead><tbody>");
          headerDone = true;
          return;
        }
        out.push("<tr>" + cells.map(function (c) { return "<td>" + inline(c.trim()) + "</td>"; }).join("") + "</tr>");
        return;
      }
      if (inTable) { out.push("</tbody></table>"); inTable = false; headerDone = false; }

      // `---` 分隔线（合订稿用它分隔知识点）
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        closeBlocks();
        out.push("<hr>");
        return;
      }
      // `>` 引用：单节点文档的元信息行。
      // ⚠️ 判据要认 `&gt;` —— 上面已经 esc 过了，裸的 `>` 此刻不存在。
      if (/^\s*&gt;\s?/.test(line)) {
        if (inList) { out.push(inList === "ul" ? "</ul>" : "</ol>"); inList = ""; }
        if (!inQuote) { out.push("<blockquote>"); inQuote = true; }
        out.push("<p>" + inline(line.replace(/^\s*&gt;\s?/, "")) + "</p>");
        return;
      }
      if (inQuote) { out.push("</blockquote>"); inQuote = false; }

      if (/^#{1,6}\s+/.test(line)) {
        if (inList) { out.push(inList === "ul" ? "</ul>" : "</ol>"); inList = ""; }
        var level = line.match(/^(#{1,6})/)[1].length;
        if (level > 4) level = 4; // 文档最深只用到 h4，再深就并到 h4
        out.push("<h" + level + ">" + inline(line.replace(/^#{1,6}\s+/, "")) + "</h" + level + ">");
      } else if (/^\s*[-*]\s+/.test(line)) {
        if (inList !== "ul") {
          if (inList) out.push("</ol>");
          out.push("<ul>");
          inList = "ul";
        }
        var text = line.replace(/^\s*[-*]\s+/, "");
        var ck = text.match(/^\[([ xX])\]\s*/);
        if (ck) {
          text = text.slice(ck[0].length);
          var mark = ck[1] === " " ? '<span class="ko-kd-ck">☐</span> ' : '<span class="ko-kd-ck ko-kd-is-done">☑</span> ';
          out.push("<li>" + mark + inline(text) + "</li>");
        } else {
          out.push("<li>" + inline(text) + "</li>");
        }
      } else if (/^\s*\d+[.)]\s+/.test(line)) {
        if (inList !== "ol") {
          if (inList) out.push("</ul>");
          out.push("<ol>");
          inList = "ol";
        }
        out.push("<li>" + inline(line.replace(/^\s*\d+[.)]\s+/, "")) + "</li>");
      } else if (!line.trim()) {
        closeBlocks();
      } else {
        closeBlocks();
        out.push("<p>" + inline(line) + "</p>");
      }
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
      // 公式外面套一层 data-tex：正文是可编辑的，反写回 Markdown 时靠这个属性把
      // KaTeX 那一堆 span 还原成一个 $…$，用户就不会因为改了一个字而丢掉整条公式。
      // contenteditable=false 让它整体不可拆 —— 否则退格键会啃掉半个公式。
      var open =
        '<span class="ko-kd-tex" contenteditable="false" data-tex="' + attr(item.tex) + '"' +
        (item.display ? ' data-display="1"' : "") + ">";
      if (!hasKatex) return open + esc(item.display ? "\\[" + item.tex + "\\]" : "\\(" + item.tex + "\\)") + "</span>";
      try {
        return (
          open +
          window.katex.renderToString(item.tex, {
            displayMode: item.display,
            throwOnError: false,
            strict: "ignore",
          }) +
          "</span>"
        );
      } catch (e) {
        return open + esc(item.tex) + "</span>";
      }
    });
  }

  /* ----------------------------------------------- 正文直改 → 反写 Markdown
   * 正文是 contenteditable 的：点进去就能改，不再需要「编辑」按钮。
   * 代价是保存时要把 DOM 反写回 Markdown，所以这里只认渲染器自己会产出的几种块
   * （h1~h4 / p / ul / ol / blockquote / table / hr / 公式 / 高亮），
   * 认不出的元素按内容收编 —— Chrome 敲回车爱塞 <div>，不收编就会整段丢字。 */

  function inlineToMd(node) {
    var out = "";
    var kids = node.childNodes || [];
    for (var i = 0; i < kids.length; i++) {
      var child = kids[i];
      if (!child) continue;
      if (child.nodeType === 3) { out += String(child.nodeValue || ""); continue; }
      if (child.nodeType !== 1) continue;
      var tag = String(child.tagName || "").toUpperCase();
      var inner = inlineToMd(child);
      if (tag === "STRONG" || tag === "B") out += "**" + inner + "**";
      else if (tag === "EM" || tag === "I") out += "*" + inner + "*";
      else if (tag === "CODE") out += "`" + inner + "`";
      else if (tag === "MARK") out += "==" + inner + "==";
      else if (child.getAttribute && child.getAttribute("data-tex") !== null) {
        var tex = child.getAttribute("data-tex") || "";
        out += child.getAttribute("data-display") ? "$$" + tex + "$$" : "$" + tex + "$";
      } else out += inner;
    }
    return out.replace(/\s+/g, " ").trim();
  }

  function serializeBlocks(root) {
    var out = [];
    var kids = root.childNodes || [];
    for (var i = 0; i < kids.length; i++) {
      var node = kids[i];
      if (!node) continue;
      if (node.nodeType === 3) {
        var bare = String(node.nodeValue || "").replace(/\s+/g, " ").trim();
        if (bare) out.push(bare);
        continue;
      }
      if (node.nodeType !== 1) continue;
      var tag = String(node.tagName || "").toUpperCase();
      if (tag === "DIV" || tag === "SECTION") {
        var nested = serializeBlocks(node);
        if (nested) out.push(nested);
        continue;
      }
      if (tag === "HR") { out.push("---"); continue; }
      if (tag === "H1" || tag === "H2" || tag === "H3" || tag === "H4") {
        out.push(new Array(Number(tag.charAt(1)) + 1).join("#") + " " + inlineToMd(node));
        continue;
      }
      if (tag === "BLOCKQUOTE") {
        var ps = node.querySelectorAll ? node.querySelectorAll("p") : [];
        if (ps && ps.length) {
          for (var j = 0; j < ps.length; j++) {
            var quoted = inlineToMd(ps[j]);
            if (quoted) out.push("> " + quoted);
          }
        } else {
          out.push("> " + inlineToMd(node));
        }
        continue;
      }
      if (tag === "UL" || tag === "OL") {
        var items = node.children || [];
        var seq = 0;
        for (var k = 0; k < items.length; k++) {
          var li = items[k];
          if (!li || String(li.tagName || "").toUpperCase() !== "LI") continue;
          seq += 1;
          out.push((tag === "OL" ? seq + ". " : "- ") + inlineToMd(li));
        }
        continue;
      }
      if (tag === "TABLE") {
        var rows = node.querySelectorAll ? node.querySelectorAll("tr") : [];
        var lines = [];
        for (var r = 0; r < rows.length; r++) {
          var cells = rows[r].children || [];
          var parts = [];
          for (var c = 0; c < cells.length; c++) {
            parts.push(inlineToMd(cells[c]).replace(/\|/g, "\\|"));
          }
          if (!parts.length) continue;
          lines.push("| " + parts.join(" | ") + " |");
          // 渲染器把第一行当表头，所以第一行后面必须补一条分隔行
          if (r === 0) lines.push("|" + parts.map(function () { return "---"; }).join("|") + "|");
        }
        if (lines.length) out.push(lines.join("\n"));
        continue;
      }
      var text = inlineToMd(node);
      if (text) out.push(text);
    }
    return out.filter(function (line) { return line !== ""; }).join("\n\n");
  }

  /* ------------------------------------------------------------ 阅读页骨架 */

  function overlay() {
    return document.getElementById(OVERLAY_ID);
  }

  function ensureOverlay() {
    var existing = overlay();
    if (existing) return existing;
    var node = document.createElement("div");
    node.id = OVERLAY_ID;
    node.setAttribute("role", "dialog");
    node.setAttribute("aria-label", "知识点文档");
    node.innerHTML =
      '<div class="ko-kd-bar">' +
        '<span class="ko-kd-bar-title" id="ko-kd-title">知识点文档</span>' +
        '<span class="ko-kd-bar-meta" id="ko-kd-meta"></span>' +
        '<span id="ko-kd-actions"></span>' +
        // 「问 AI」刻意放在 #ko-kd-actions **外面**：那个槽位每次渲染都会被整段替换，
        // 放进去点一次就没了。
        '<button type="button" class="ko-kd-btn ko-kd-btn-icon" id="ko-kd-ask-toggle" data-kd-ask-open' +
          ' title="问 AI：就着这一节提问（也可以先选中一段话）" aria-label="问 AI：就着这一节提问">' +
          ico("chat") + "</button>" +
        '<button type="button" class="ko-kd-btn ko-kd-btn-icon" data-kd-close' +
          ' title="关闭阅读页（Esc）" aria-label="关闭阅读页">' + ico("close") + "</button>" +
      "</div>" +
      '<div class="ko-kd-readbar" id="ko-kd-readbar-track">' +
        '<div class="ko-kd-readbar-fill" id="ko-kd-readbar"></div>' +
      "</div>" +
      '<div class="ko-kd-main">' +
        '<aside class="ko-kd-toc" id="ko-kd-toc"></aside>' +
        // 目录收窄（窄屏）或抽屉浮起（浮层模式）时对应的把手也要跟着消失，
        // 否则会留一根拖了没用的竖线在正文边上。
        '<div class="ko-kd-grip ko-kd-grip-l" id="ko-kd-grip-l" data-kd-grip="left" ' +
          'title="拖动调整目录宽度，双击复位"></div>' +
        '<div class="ko-kd-body" id="ko-kd-body"></div>' +
        '<div class="ko-kd-grip ko-kd-grip-r" id="ko-kd-grip-r" data-kd-grip="right" ' +
          'title="拖动调整提问栏宽度，双击复位"></div>' +
        askPanelHtml() +
      "</div>" +
      '<button type="button" class="ko-kd-top" id="ko-kd-top" data-kd-top title="回到顶部">↑</button>' +
      '<div class="ko-kd-selbar" id="ko-kd-selbar">' +
        '<button type="button" class="ko-kd-btn ko-kd-btn-primary" data-kd-ask-sel>问 AI</button>' +
        '<button type="button" class="ko-kd-btn" data-kd-hl id="ko-kd-hl" data-kd-hl-off="0">高亮</button>' +
        '<button type="button" class="ko-kd-btn" data-kd-copy-sel>复制</button>' +
      "</div>";
    document.body.appendChild(node);
    wireOverlay();
    // 把 VIEW.askExtra 的默认值同步到 DOM —— checkbox 的 checked 属性虽然写在 HTML 里，
    // 但 wrap 上表示「当前在发散档」的 class 还得靠 setAskExtra 一下，否则默认档的灰字、
    // 散档的深字第一次打开会有视觉跳变。
    setAskExtra(VIEW.askExtra);
    return node;
  }

  function askPanelHtml() {
    return (
      '<aside class="ko-kd-ask" id="ko-kd-ask">' +
        '<div class="ko-kd-ask-head">' +
          '<span class="ko-kd-ask-title">问 AI</span>' +
          '<span class="ko-kd-ask-section" id="ko-kd-ask-section"></span>' +
          '<button type="button" class="ko-kd-btn" data-kd-ask-close>收起</button>' +
        "</div>" +
        '<div class="ko-kd-ask-thread" id="ko-kd-ask-thread"></div>' +
        '<div class="ko-kd-ask-compose">' +
          '<div class="ko-kd-ask-ref" id="ko-kd-ask-ref" style="display:none">' +
            '<span class="ko-kd-ask-ref-text" id="ko-kd-ask-ref-text"></span>' +
            '<button type="button" class="ko-kd-ask-ref-x" data-kd-ask-clear title="不用这段引用">×</button>' +
          "</div>" +
          '<textarea class="ko-kd-ask-input" id="ko-kd-ask-input" rows="3" ' +
            'placeholder="就着这一节提问…（Enter 发送，Shift+Enter 换行）"></textarea>' +
          '<div class="ko-kd-ask-mode" id="ko-kd-ask-mode">' +
            '<input type="checkbox" id="ko-kd-ask-extra" data-kd-ask-extra checked>' +
            '<label for="ko-kd-ask-extra" ' +
              'title="勾上后材料外确实需要的知识也会答，但会单独放进「材料外补充」一段">' +
              "也讲材料外</label>" +
          "</div>" +
          '<div class="ko-kd-ask-actions">' +
            '<span class="ko-kd-ask-hint" id="ko-kd-ask-hint">正在读材料，并准备材料外的补充…</span>' +
            '<button type="button" class="ko-kd-btn ko-kd-btn-primary" id="ko-kd-ask-send" data-kd-ask-send>发送</button>' +
          "</div>" +
        "</div>" +
      "</aside>"
    );
  }

  /** 一次性的 DOM 级监听（滚动、Enter 发送、档位开关）。ensureOverlay 只建一次，所以不会重复绑。 */
  function wireOverlay() {
    var body = document.getElementById("ko-kd-body");
    if (body && body.addEventListener) {
      body.addEventListener("scroll", onBodyScroll, false);
      // 正文是直接可编辑的：打字 → 防抖自动保存。绑在容器上而不是 .ko-kd-md 上，
      // 因为 .ko-kd-md 每次重画都是新节点，容器才是那个一直在的。
      body.addEventListener("input", onBodyInput, false);
    }
    var input = document.getElementById("ko-kd-ask-input");
    if (input && input.addEventListener) {
      input.addEventListener(
        "keydown",
        function (event) {
          if (!event || event.key !== "Enter" || event.shiftKey) return;
          if (event.preventDefault) event.preventDefault();
          askSend();
        },
        false
      );
    }
    // 绑 change 而不是 click：checkbox 自己会先切换 checked，click 里读到的是新值但时序
    // 不可靠；change 只在值真的变了之后触发，点 label 也会带过来。
    var extraBox = document.getElementById("ko-kd-ask-extra");
    if (extraBox && extraBox.addEventListener) {
      extraBox.addEventListener(
        "change",
        function (event) {
          setAskExtra(!!(event && event.target && event.target.checked));
        },
        false
      );
    }
    var grips = document.querySelectorAll("[data-kd-grip]");
    for (var i = 0; i < grips.length; i++) {
      grips[i].addEventListener("mousedown", startGrip, false);
      grips[i].addEventListener("dblclick", resetGrip, false);
    }
    window.addEventListener("mousemove", onGripMove, false);
    window.addEventListener("mouseup", endGrip, false);
    restoreGrips();
  }

  /* ------------------------------------------------------------ 分栏拖动 */
  //
  // 宽度存 localStorage，跨次打开还在。三个约束：
  //   1. 正文不能被挤没 —— 两栏加起来要给正文留够 GRIP_MIN_BODY；
  //   2. 每栏各有自己的上下限；
  //   3. 双击复位。
  // 用 mouse 事件而不是 pointer：桌面端足够，也省掉 pointer capture 的兼容分支。

  var GRIP_MIN = { left: 160, right: 300 };
  var GRIP_MAX = { left: 420, right: 760 };
  var GRIP_DEFAULT = { left: 234, right: 0 }; // right=0 = 交给 CSS 的 clamp
  var GRIP_MIN_BODY = 420;
  var GRIP_HANDLE = 20;   // 两根把手各占 10px 布局宽度
  var GRIP_STORE_KEY = "knoworigin.kd.grips";
  var GRIP_DRAG = null;   // { side, startX, startW }
  var GRIP_SAVED = { left: GRIP_DEFAULT.left, right: 0 };

  function gripWidths() {
    try {
      var raw = window.localStorage.getItem(GRIP_STORE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || typeof data !== "object") return null;
      return data;
    } catch (error) {
      return null;
    }
  }

  function saveGripWidths() {
    try {
      window.localStorage.setItem(GRIP_STORE_KEY, JSON.stringify(GRIP_SAVED));
    } catch (error) {
      /* 隐私模式/存盘满：拖动这次仍然生效，只是不留到下次 */
    }
  }

  function overlayWidth() {
    var node = overlay();
    if (node && typeof node.clientWidth === "number" && node.clientWidth) {
      return node.clientWidth;
    }
    return (typeof window !== "undefined" && window.innerWidth) || 1200;
  }

  /** 夹住一个宽度：在自身上下限之内，且另一栏 + 正文都还够用。

  正文留不够时不能死守 GRIP_MIN —— 那会把正文压成一条缝。先算「这一栏最多能占
  多少」（room），再取 max(下限, min(上限, room))：宁可放宽自己的下限，也不能没正文。
  */
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
    node.style.setProperty(
      "--ko-kd-" + (side === "left" ? "toc" : "ask") + "-w", width + "px"
    );
  }

  function restoreGrips() {
    var saved = gripWidths();
    GRIP_SAVED = { left: GRIP_DEFAULT.left, right: 0 };
    if (saved && saved.left) GRIP_SAVED.left = saved.left;
    if (saved && saved.right) GRIP_SAVED.right = saved.right;
    var node = overlay();
    if (!node || !node.style || !node.style.setProperty) return;
    if (GRIP_SAVED.left) node.style.setProperty("--ko-kd-toc-w", GRIP_SAVED.left + "px");
    if (GRIP_SAVED.right) node.style.setProperty("--ko-kd-ask-w", GRIP_SAVED.right + "px");
  }

  function currentGripWidth(side) {
    if (side === "left") {
      var toc = document.getElementById("ko-kd-toc");
      return toc && toc.clientWidth ? toc.clientWidth : GRIP_SAVED.left || GRIP_DEFAULT.left;
    }
    var ask = document.getElementById("ko-kd-ask");
    // 抽屉关着时量不到宽度（display:none → clientWidth 0），退回 CSS clamp 的结果
    if (ask && ask.clientWidth) return ask.clientWidth;
    var total = overlayWidth();
    return Math.max(340, Math.min(420, Math.round(total * 0.28)));
  }

  function startGrip(event) {
    var grip = event.currentTarget;
    if (!grip) return;
    var side = grip.getAttribute("data-kd-grip");
    if (side !== "left" && side !== "right") return;
    if (event.preventDefault) event.preventDefault();
    GRIP_DRAG = { side: side, startX: event.clientX, startW: currentGripWidth(side) };
    if (grip.classList) grip.classList.add("ko-kd-is-drag");
    if (document.body && document.body.classList) document.body.classList.add("ko-kd-resizing");
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
    var grips = document.querySelectorAll(".ko-kd-grip");
    for (var i = 0; i < grips.length; i++) {
      if (grips[i].classList) grips[i].classList.remove("ko-kd-is-drag");
    }
    if (document.body && document.body.classList) document.body.classList.remove("ko-kd-resizing");
    saveGripWidths();
    GRIP_DRAG = null;
  }

  function resetGrip(event) {
    var grip = event.currentTarget;
    var side = grip && grip.getAttribute("data-kd-grip");
    if (side !== "left" && side !== "right") return;
    if (event.preventDefault) event.preventDefault();
    var node = overlay();
    if (side === "left") {
      applyGrip("left", GRIP_DEFAULT.left);
    } else {
      GRIP_SAVED.right = 0;
      // 删掉 inline 值 = 交还给 CSS 的 clamp，这才是右栏真正的「复位」
      if (node && node.style && node.style.removeProperty) {
        node.style.removeProperty("--ko-kd-ask-w");
      }
    }
    saveGripWidths();
    notify(side === "left" ? "目录宽度已复位。" : "提问栏宽度已复位。");
  }

  function barActions(html) {
    var slot = document.getElementById("ko-kd-actions");
    if (!slot) return;
    slot.innerHTML = html || "";
    // 面板态要占满一行（按钮会换行铺开），所以给容器加个类而不是改 flex-basis
    if (slot.classList) slot.classList.toggle("ko-kd-is-picker", !!VIEW.picker && !!html);
  }

  function setMeta(text) {
    var node = document.getElementById("ko-kd-meta");
    if (node) node.textContent = text || "";
  }

  function setTitle(text) {
    var node = document.getElementById("ko-kd-title");
    if (node) node.textContent = text || "知识点文档";
    VIEW.title = text || "";
  }

  function renderBody(html) {
    var body = document.getElementById("ko-kd-body");
    if (body) body.innerHTML = html;
    if (body) body.scrollTop = 0;
    // 只有 paintMarkdown 画出来的真文档可编辑；进度条 / 空态 / 报错都不是文档
    VIEW.editable = false;
    VIEW.heads = [];
    VIEW.tocItems = [];
    VIEW.sel = "";
    VIEW.selSection = "";
    hideSelBar();
    var fill = document.getElementById("ko-kd-readbar");
    if (fill) fill.style.width = "0%";
    var up = document.getElementById("ko-kd-top");
    if (up && up.classList) up.classList.remove("ko-kd-is-on");
  }

  /** 换一份文档就把问答清掉：跨文档留着上一份的问题会让人以为问错了地方。 */
  function resetAsk() {
    VIEW.picker = false;
    VIEW.askThread = [];
    VIEW.askRef = "";
    VIEW.askSection = "";
    VIEW.askBusy = false;
    setAskExtra(true);  // 「也讲材料外」默认勾选 —— 切文档也跟着回到默认
    closeAsk();
    paintAskRef();
    paintAsk();
  }

  function renderError() {
    if (!VIEW.error) return;
    var body = document.getElementById("ko-kd-body");
    if (!body) return;
    // 自动保存会连着失败好几次（打字时每 900ms 一次），同一句话只留一条 ——
    // 否则正文顶上会摞成一串一模一样的红框（用户截图里就是五条）。
    var existing = body.querySelector(".ko-kd-err");
    if (existing) {
      existing.textContent = VIEW.error;
      VIEW.error = "";
      return;
    }
    var box = document.createElement("div");
    box.className = "ko-kd-err";
    box.textContent = VIEW.error;
    body.insertBefore(box, body.firstChild);
    VIEW.error = "";
  }

  /* 目录：正文渲染完之后从 DOM 里提取 h2/h3，顺带给它们挂锚点 id。
   * ⚠️ 手写遍历而不是 querySelectorAll(".ko-kd-md h2, .ko-kd-md h3") ——
   *    逗号多选择器在测试桩里会被拆坏，而手写遍历在浏览器和桩上行为一致。 */
  function collectHeads(root) {
    var out = [];
    (function walk(node) {
      var kids = (node && node.childNodes) || [];
      for (var i = 0; i < kids.length; i++) {
        var child = kids[i];
        if (!child || child.nodeType !== 1) continue;
        var tag = String(child.tagName || "").toUpperCase();
        if (tag === "H2" || tag === "H3") {
          // 合订稿自带一节「## 目录」，它本身就是一份文字版目录。
          // 左边已经有可点的目录了，再把它列进去只是噪音（点进去也只有一堆链接文字）。
          if (String(child.textContent || "").trim() === "目录") continue;
          out.push(child);
          continue;
        }
        walk(child);
      }
    })(root);
    return out;
  }

  function buildToc() {
    var toc = document.getElementById("ko-kd-toc");
    var body = document.getElementById("ko-kd-body");
    if (!toc || !body) return;
    VIEW.heads = [];
    VIEW.tocItems = [];
    var mdRoot = body.querySelector(".ko-kd-md");
    var heads = mdRoot ? collectHeads(mdRoot) : [];
    if (!heads.length) {
      toc.innerHTML = '<div class="ko-kd-toc-empty">这份文档还没有小节。</div>';
      return;
    }
    // 合订稿把每一节的递进坐标（第几层、承接谁）一起返回了，直接挂成目录徽标 ——
    // 不必去正文里解析 `> 递进 · …` 那一行文本。
    var sections = VIEW.docSections || [];
    var subIndex = -1;
    var html = '<div class="ko-kd-toc-title">目录</div><div class="ko-kd-toc-list">';
    for (var i = 0; i < heads.length; i++) {
      var head = heads[i];
      var id = "ko-kd-h-" + i;
      head.id = id;
      var sub = head.tagName === "H3";
      var chip = "";
      if (sub) {
        subIndex += 1;
        var info = sections[subIndex];
        if (info && info.layer) {
          var tip = "第 " + info.layer + " 层";
          if (info.before && info.before.length) tip += " · 承接 " + info.before[0];
          chip = '<span class="ko-kd-toc-chip" title="' + attr(tip) + '">L' + esc(info.layer) + "</span>";
        }
      }
      html +=
        '<button type="button" class="ko-kd-toc-item' + (sub ? " ko-kd-is-sub" : "") +
        '" data-kd-goto="' + attr(id) + '" title="' + attr(head.textContent) + '">' +
        esc(head.textContent) + chip + "</button>";
      VIEW.heads.push(head);
    }
    html += "</div>";
    toc.innerHTML = html;
    VIEW.tocItems = toc.querySelectorAll(".ko-kd-toc-item");
  }

  /** 当前读到第几个小节：正文滚动位置的上方、离得最近的那个标题。 */
  function activeHeadingIndex() {
    var body = document.getElementById("ko-kd-body");
    var heads = VIEW.heads || [];
    if (!body || !heads.length) return -1;
    var top = body.scrollTop || 0;
    var best = -1;
    for (var i = 0; i < heads.length; i++) {
      var offset = heads[i].offsetTop || 0;
      if (offset - 28 <= top) best = i;
      else break;
    }
    return best;
  }

  function paintActiveHead(index) {
    var items = VIEW.tocItems || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i] && items[i].classList) items[i].classList.toggle("ko-kd-is-active", i === index);
    }
  }

  function currentSectionTitle() {
    var index = activeHeadingIndex();
    var heads = VIEW.heads || [];
    if (index < 0 || !heads[index]) return "";
    return String(heads[index].textContent || "").trim();
  }

  /** 正文滚动：刷新阅读进度、返顶按钮、目录高亮，并收起选中浮条（浮条会跟错位置）。 */
  function onBodyScroll() {
    var body = document.getElementById("ko-kd-body");
    if (!body) return;
    var top = body.scrollTop || 0;
    var span = (body.scrollHeight || 0) - (body.clientHeight || 0);
    var fill = document.getElementById("ko-kd-readbar");
    if (fill) fill.style.width = (span > 0 ? Math.min(100, Math.round((top / span) * 100)) : 0) + "%";
    var up = document.getElementById("ko-kd-top");
    if (up && up.classList) up.classList.toggle("ko-kd-is-on", top > 320);
    paintActiveHead(activeHeadingIndex());
    hideSelBar();
  }

  function gotoAnchor(id) {
    var target = document.getElementById(id);
    if (!target) return;
    var body = document.getElementById("ko-kd-body");
    if (!body) return;
    // 只滚自己的容器 —— scrollIntoView 会把工作台面板也一起拽走。
    body.scrollTop = Math.max(0, (target.offsetTop || 0) - 16);
    onBodyScroll();
  }

  /* ------------------------------------------------------- 选中一段话 → 问 AI */

  function within(root, el) {
    var cursor = el;
    for (var i = 0; i < 60 && cursor; i++) {
      if (cursor === root) return true;
      cursor = cursor.parentNode;
    }
    return false;
  }

  function readSelection() {
    var body = document.getElementById("ko-kd-body");
    if (!body || !VIEW.open) return null;
    var sel = null;
    try {
      sel = (typeof window !== "undefined" && window.getSelection) ? window.getSelection() : null;
    } catch (error) {
      sel = null;
    }
    if (!sel || sel.isCollapsed) return null;
    var text = String(sel.toString ? sel.toString() : "").replace(/\s+/g, " ").trim();
    if (text.length < 2) return null;
    var node = sel.anchorNode;
    if (!node) return null;
    var el = node.nodeType === 1 ? node : node.parentNode;
    if (!el || !within(body, el)) return null;
    var rect = null;
    try {
      var range = sel.getRangeAt ? sel.getRangeAt(0) : null;
      rect = range && range.getBoundingClientRect ? range.getBoundingClientRect() : null;
    } catch (error) {
      rect = null;
    }
    // 选区落在已有高亮里 → 浮条上那个按钮要说「去高亮」
    var inMark = !!(el && el.closest && el.closest("mark"));
    return { text: text, rect: rect, inMark: inMark };
  }

  function showSelBar(rect, inMark) {
    var bar = document.getElementById("ko-kd-selbar");
    if (!bar) return;
    var hl = document.getElementById("ko-kd-hl");
    if (hl) {
      hl.textContent = inMark ? "去高亮" : "高亮";
      hl.setAttribute("title", inMark ? "去掉这段的高亮" : "高亮这一段（会存进文档，重新生成会被覆盖）");
    }
    var width = (typeof window !== "undefined" && window.innerWidth) || 1200;
    var height = (typeof window !== "undefined" && window.innerHeight) || 800;
    // style.left/top 是设计像素，innerWidth/innerHeight 是视觉像素：先除回界面缩放。
    var sc = (window.KnowOriginUiScale && window.KnowOriginUiScale.scale()) || 1;
    width = width / sc; height = height / sc;
    var top = rect && rect.top ? rect.top - 46 : height / 2;
    top = Math.max(56, top);
    bar.style.top = Math.round(top) + "px";
    if (bar.classList) bar.classList.add("ko-kd-is-on");
    // 显示出来才量得到宽度（display:none 时 offsetWidth 是 0），所以先上屏再回正水平位置
    var barWidth = bar.offsetWidth || 148;
    var left = rect && rect.width ? rect.left + rect.width / 2 - barWidth / 2 : width / 2 - barWidth / 2;
    left = Math.max(12, Math.min(left, width - barWidth - 12));
    bar.style.left = Math.round(left) + "px";
  }

  function hideSelBar() {
    var bar = document.getElementById("ko-kd-selbar");
    if (bar && bar.classList) bar.classList.remove("ko-kd-is-on");
  }

  function onSelectionChange() {
    if (!VIEW.open) return;
    var found = readSelection();
    if (!found) {
      // ⚠️ 这里**故意不清 VIEW.sel**：点浮条按钮的那一下 mousedown 会先把选区收起来
      // （浏览器给按钮焦点），清掉的话点击事件里读到的就是空 —— 表现是「按钮点了没反应」。
      // 只置 selLive=false，顶栏「问 AI」靠它判断要不要带引用。
      VIEW.selLive = false;
      hideSelBar();
      return;
    }
    VIEW.sel = found.text;
    VIEW.selSection = currentSectionTitle();
    VIEW.selInMark = !!found.inMark;
    VIEW.selLive = true;
    showSelBar(found.rect, VIEW.selInMark);
  }

  /** 点空白处收起浮条。⚠️ 不清 VIEW.sel —— 点「问 AI」按钮本身就是一次 mousedown。 */
  function onDocumentDown(event) {
    var target = event && event.target;
    if (!target || !target.closest) return;
    if (target.closest("#ko-kd-selbar") || target.closest("#ko-kd-ask")) return;
    hideSelBar();
  }

  function copyText(text, done) {
    var value = String(text || "");
    if (!value) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value);
        if (done) done();
        return;
      }
    } catch (error) {}
    try {
      var box = document.createElement("textarea");
      box.value = value;
      box.style.position = "fixed";
      box.style.opacity = "0";
      document.body.appendChild(box);
      box.select();
      document.execCommand("copy");
      document.body.removeChild(box);
      if (done) done();
    } catch (error) {
      notify("复制失败，可以试试「下载 .md」。");
    }
  }

  /* ------------------------------------------------------------ 提问抽屉 */

  var ASK_HINT_STRICT = "只依据这一节的材料作答，没写的它会直说。";
  var ASK_HINT_EXTRA = "材料外确实需要的知识也会答，但会单独放进「材料外补充」一段。";

  function setAskHint(text) {
    var node = document.getElementById("ko-kd-ask-hint");
    if (node) node.textContent = text || "";
  }

  function askHintText() {
    return VIEW.askExtra ? ASK_HINT_EXTRA : ASK_HINT_STRICT;
  }

  /** 两档切换：勾上 = 这一问允许发散。改 VIEW 而不是直接读 DOM，payload 与重绘都从 VIEW 取。 */
  function setAskExtra(on) {
    VIEW.askExtra = !!on;
    var box = document.getElementById("ko-kd-ask-extra");
    if (box && !!box.checked !== VIEW.askExtra) box.checked = VIEW.askExtra;
    var wrap = document.getElementById("ko-kd-ask-mode");
    if (wrap && wrap.classList) wrap.classList.toggle("ko-kd-is-extra", VIEW.askExtra);
    if (!VIEW.askBusy) setAskHint(askHintText());
  }

  function askExtra() {
    return !!VIEW.askExtra;
  }

  function openAsk(selection) {
    if (!VIEW.open) return;
    var panel = document.getElementById("ko-kd-ask");
    if (panel && panel.classList) panel.classList.add("ko-kd-is-on");
    // 右把手跟着抽屉一起出现：抽屉关着时分隔线没有归属，留着就是一条悬空的竖线
    var gripR = document.getElementById("ko-kd-grip-r");
    if (gripR && gripR.classList) gripR.classList.add("ko-kd-is-on");
    if (selection) VIEW.askRef = String(selection).slice(0, 400);
    VIEW.askSection = VIEW.selSection || currentSectionTitle();
    paintAskRef();
    paintAsk();
    hideSelBar();
    var input = document.getElementById("ko-kd-ask-input");
    if (input && input.focus) {
      try { input.focus(); } catch (error) {}
    }
  }

  function closeAsk() {
    var panel = document.getElementById("ko-kd-ask");
    if (panel && panel.classList) panel.classList.remove("ko-kd-is-on");
    var gripR = document.getElementById("ko-kd-grip-r");
    if (gripR && gripR.classList) gripR.classList.remove("ko-kd-is-on");
  }

  function paintAskRef() {
    var box = document.getElementById("ko-kd-ask-ref");
    var text = document.getElementById("ko-kd-ask-ref-text");
    var section = document.getElementById("ko-kd-ask-section");
    if (section) section.textContent = VIEW.askSection ? "· " + VIEW.askSection : "";
    if (!box || !text) return;
    if (!VIEW.askRef) {
      box.style.display = "none";
      text.textContent = "";
      return;
    }
    box.style.display = "flex";
    text.textContent = "「" + VIEW.askRef + "」";
  }

  function paintAsk() {
    var thread = document.getElementById("ko-kd-ask-thread");
    if (!thread) return;
    if (!VIEW.askThread.length) {
      thread.innerHTML =
        '<div class="ko-kd-ask-empty">选中正文里的一段话，点浮出来的「问 AI」；' +
        "也可以直接把问题写在下面。<br>默认**也讲材料外** —— 材料里没有的，会先按通识补，补充会单独放进「材料外补充」一段；" +
        "想严守本节材料就取消勾选，没写的它会直说。</div>";
      return;
    }
    var html = "";
    for (var i = 0; i < VIEW.askThread.length; i++) {
      var msg = VIEW.askThread[i];
      html +=
        '<div class="ko-kd-ask-q"><span class="ko-kd-ask-q-mark">问</span><span>' +
        esc(msg.q) + "</span></div>";
      // 这一问引用的是哪段原文，跟着问题一起留在记录里 —— 输入区上面那块引用发出去
      // 就清空了（它属于「下一问」），不留一份在轮次里，回头看就不知道问的是哪句话。
      if (msg.sel) {
        html +=
          '<div class="ko-kd-ask-ref"><span class="ko-kd-ask-ref-text">「' +
          esc(msg.sel) + "」</span></div>";
      }
      if (msg.error) {
        html += '<div class="ko-kd-err">' + esc(msg.error) + "</div>";
      } else if (msg.a) {
        html += '<div class="ko-kd-md ko-kd-ask-a">' + renderMarkdown(msg.a) + "</div>";
      } else if (msg.pending) {
        html += '<div class="ko-kd-ask-empty">正在读这一节的材料…</div>';
      }
      if (msg.a && !msg.pending) {
        html +=
          '<div class="ko-kd-ask-actions"><span class="ko-kd-ask-hint"></span>' +
          '<button type="button" class="ko-kd-btn" data-kd-ask-copy="' + i + '">复制</button></div>';
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

  /** 裸 fetch 读 SSE：api() 会按 JSON 解析，这里是 text/event-stream。 */
  async function streamAsk(payload, onEvent) {
    var pid = currentProjectId();
    var resp = await fetch(
      "/api/projects/" + encodeURIComponent(pid) + "/knowledge-doc/ask",
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );
    if (resp.status === 401) throw new Error("登录状态已失效，请刷新页面后再试。");
    if (!resp.ok || !resp.body) {
      var detail = "";
      try {
        var data = await resp.json();
        detail = (data && data.detail && (data.detail.message || data.detail)) || "";
      } catch (error) {}
      throw new Error(detail || "提问失败（HTTP " + resp.status + "）。");
    }
    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";
    for (;;) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      var parts = buffer.split("\n\n");
      buffer = parts.pop();
      for (var i = 0; i < parts.length; i++) {
        var line = String(parts[i]).trim();
        if (line.indexOf("data:") !== 0) continue;
        try {
          onEvent(JSON.parse(line.slice(5).trim()));
        } catch (error) {}
      }
    }
  }

  async function askSend() {
    var pid = currentProjectId();
    if (!pid) { notify("请先打开一个课程。"); return; }
    var input = document.getElementById("ko-kd-ask-input");
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
    // 提示随档位走，别让「也讲材料外」开着却还提示「没写的会直说」
    setAskHint(askExtra() ? "正在读材料，并准备材料外的补充…" : "正在读材料…");

    var body = {
      // 单节点详解 → 用这一节点的上下文；合订稿 → 用选区附近的窗口
      scope: VIEW.mode === "compiled" ? "project" : "node",
      node_id: VIEW.nodeId || "",
      question: question,
      selection: msg.sel,
      section: VIEW.askSection || "",
      history: askHistory(),
      allow_extra: askExtra(),
    };
    try {
      await streamAsk(body, function (event) {
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
      });
    } catch (error) {
      msg.pending = false;
      msg.error = (error && error.message) || "提问失败。";
    }
    msg.pending = false;
    VIEW.askBusy = false;
    setAskHint(askHintText());
    paintAsk();
  }

  function openOverlay() {
    ensureStyle();
    ensureOverlay();
    var node = overlay();
    node.style.display = "flex";
    VIEW.open = true;
    // 藏掉主界面的提问导轨（z-index 8000 > 本层 1500，不藏就会叠在正文右侧）
    if (document.body && document.body.classList) document.body.classList.add(BODY_OPEN_CLASS);
    resetAsk();
  }

  function closeOverlay() {
    var node = overlay();
    if (node) node.style.display = "none";
    if (document.body && document.body.classList) {
      document.body.classList.remove(BODY_OPEN_CLASS);
    }
    VIEW.open = false;
    VIEW.pid = "";      // 关掉就回到「跟当前项目走」，别让下次打开还指着上一个项目
    VIEW.busy = false;
    VIEW.editable = false;
    VIEW.cancelled = true;
    // 关之前把没存完的改动落库 —— 用户按 Esc 的时候不该白敲一场
    flushEdit();
  }

  /* ------------------------------------------------------------ 取数 */

  function pad2(v) {
    return ("0" + v).slice(-2);
  }

  /** 库里存的是 UTC，直接切片显示会跟「已保存 00:15」打架（差 8 小时）。按本地时区显示。 */
  function metaLine(kit) {
    if (!kit || !kit.updated_at) return "";
    var raw = String(kit.updated_at);
    var when = new Date(raw);
    if (!isNaN(when.getTime())) {
      return "更新于 " + when.getFullYear() + "-" + pad2(when.getMonth() + 1) + "-" + pad2(when.getDate()) +
        " " + pad2(when.getHours()) + ":" + pad2(when.getMinutes());
    }
    return "更新于 " + raw.slice(0, 16).replace("T", " ");
  }

  /**
   * 打开单个知识点的文档；没有就落到空态（由调用方决定是否立刻生成）。
   *
   * ``opts.section``：打开后滚到那个同名小节。知识卡片的「回到文档」用它定位 ——
   * 卡片知道自己出自哪一节（origin_section），正文里按标题文字找到那一节再滚过去。
   */
  async function openNode(nodeId, nodeName, opts) {
    if (opts && opts.pid) VIEW.pid = opts.pid;
    var pid = currentProjectId();
    if (!pid) { notify("请先打开一个课程。"); return; }
    var want = String((opts && opts.section) || "");
    openOverlay();
    setTitle(nodeName || "知识点文档");
    setMeta("读取中…");
    barActions("");
    renderBody('<p class="ko-kd-empty">正在读取…</p>');
    document.getElementById("ko-kd-toc").innerHTML = "";

    var res;
    try {
      res = await api(
        "/api/projects/" + encodeURIComponent(pid) + "/nodes/" + encodeURIComponent(nodeId) + "/doc"
      );
    } catch (error) {
      setMeta("");
      renderBody('<p class="ko-kd-empty">读取失败。</p>');
      fail(error);
      return;
    }
    var doc = res && res.doc;
    if (!doc) {
      VIEW.mode = "node";
      VIEW.nodeId = nodeId;
      renderEmptyNode(nodeId, nodeName);
      if (want) notify("这份文档还没有生成，先看目录。", "warning");
      return;
    }
    VIEW.mode = "node";
    VIEW.nodeId = nodeId;
    renderDoc(doc, "node");
    if (want) scrollToSection(want);
  }

  /**
   * 滚到正文里标题文字等于（或近似）``title`` 的那一节。
   *
   * 标题 id 是 renderBody 里按顺序编的 ``ko-kd-h-N``，所以只能靠文字匹配再换算下标 ——
   * 卡片存的 origin_section 就是文档小节的标题原文（core/knowledge_doc.SYNC_ORIGIN_SECTION）。
   * 找不到就什么都不做：宁可停在顶部，也不要跳到一个错的地方。
   */
  function scrollToSection(title) {
    var want = String(title || "").trim();
    var heads = VIEW.heads || [];
    if (!want || !heads.length) return false;
    for (var i = 0; i < heads.length; i++) {
      var text = String(heads[i].textContent || "").trim();
      if (!text) continue;
      if (text === want || text.indexOf(want) >= 0 || want.indexOf(text) >= 0) {
        gotoAnchor(heads[i].id || ("ko-kd-h-" + i));
        return true;
      }
    }
    return false;
  }

  function renderEmptyNode(nodeId, nodeName) {
    setMeta("");
    barActions(
      iconBtn("doc",
        "生成文档：按「承接与递进 → 定义与符号约定 → 推导与机制 → 公式与用法 → 易错点 → " +
        "与相邻知识点的关系 → 自测」写一份复习用详解",
        ' data-kd-generate="' + attr(nodeId) + '"',
        "ko-kd-btn-primary")
    );
    renderBody(
      '<div class="ko-kd-empty">' +
      "「" + esc(nodeName || "这个知识点") + "」还没有生成文档。<br>" +
      "生成时会按「承接与递进 → 定义与符号约定 → 推导与机制 → 公式与用法 → 易错点 → " +
      "与相邻知识点的关系 → 自测」写一份复习用详解，" +
      "内容只取自这个知识点关联的资料，资料没覆盖的地方会如实标注，不会用通识补。" +
      "</div>"
    );
    document.getElementById("ko-kd-toc").innerHTML = "";
  }

  function renderDoc(doc, scope) {
    VIEW.markdown = doc.content_md || "";
    VIEW.lastDoc = doc;
    VIEW.scope = normalizeDocScope(scope);
    // 合订稿没有 node_id（槽位键里那一格是 <project>），不清掉会把上一份的 node_id 带进保存
    VIEW.nodeId = String(doc.node_id || "");
    var content = doc.content || {};
    // 合订稿把每节的递进坐标一起落库了，左目录靠它挂「L2」层号徽标
    VIEW.docSections = (content && content.sections) || [];
    // 排序口径也一起落库了：重新打开这份文档时顶栏要能说清「它是按层序合的」
    VIEW.order = String((content && content.order) || "tree");
    VIEW.maxLayer = Number((content && content.max_layer) || 0) || 0;
    setMeta(docMetaLine());
    if (doc.title) setTitle(doc.title);
    barActions(
      iconBtn("download", "下载 .md（Markdown 原文）",
        ' data-kd-download="' + attr(scope) + '"', "ko-kd-btn-primary") +
      iconBtn("copy", "复制全文（Markdown）", " data-kd-copy") +
      (scope === "node"
        ? iconBtn("refresh", "重新生成这一节（重新调用模型重写一遍）",
            ' data-kd-regen="' + attr(doc.node_id || VIEW.nodeId) + '"')
        : iconBtn("refresh",
            "全部重新生成：把每一个已有详解都重新调用模型改写，写完再自动合订（较慢、会计费）",
            " data-kd-regen-all") +
          iconBtn("layers",
            (VIEW.order === "layer"
              ? "调整合订方式（当前：按层序）：可换回按框架章节，或只收进前几层 —— 纯本地拼接，不调用模型"
              : "按层级合订：按前置依赖的层号由浅入深重排，或只收进前几层 —— 纯本地拼接，不调用模型"),
            " data-kd-layer-toggle"))
    );
    paintMarkdown();
  }

  function normalizeDocScope(scope) {
    return String(scope || "").toLowerCase() === "project" ? "project" : "node";
  }

  /** 顶栏那行「更新于…·约 N 字」。改完正文、改完高亮都要能重算。 */
  function docMetaLine() {
    var stamp = metaLine(VIEW.lastDoc);
    return (stamp ? stamp + " · " : "") + "约 " + VIEW.markdown.length + " 字" +
      compiledOrderNote() + " · 点正文可直接改";
  }

  function mdRoot() {
    var body = document.getElementById("ko-kd-body");
    return body ? body.querySelector(".ko-kd-md") : null;
  }

  /**
   * 按 VIEW.markdown 重画正文 + 目录。
   *
   * ``keepScroll``：高亮这类「源文改了要重画」的动作必须保住滚动位置 ——
   * 在阅读到第 12 节时划一句重点，画完被弹回第 1 节是没法用的。
   */
  function paintMarkdown(keepScroll) {
    var body = document.getElementById("ko-kd-body");
    var top = keepScroll && body ? body.scrollTop : 0;
    // 正文直接可编辑：点进去就能改，不用先按一个「编辑」按钮
    renderBody(
      '<div class="ko-kd-md" contenteditable="true" spellcheck="false" role="textbox" ' +
      'aria-multiline="true">' + renderMarkdown(VIEW.markdown) + "</div>"
    );
    buildToc();
    VIEW.editable = true;
    if (keepScroll && body) body.scrollTop = top;
  }

  /** 用同一份文档原样重画一遍（保存之后）。 */
  function paintDoc() {
    if (!VIEW.lastDoc) return;
    renderDoc(VIEW.lastDoc, VIEW.scope);
  }

  /**
   * 把改过的正文写回库里。高亮与直接编辑共用这一条路 —— 高亮存的就是 Markdown 里的
   * ``==…==``，所以不需要第二张表、也不需要额外的存储。
   *
   * ⚠️ 只改 content_md：结构化留档（content_json）不动，重新生成会用模型结果覆盖它。
   * ``repaint=false`` 用于边打字边自动保存：重画会把光标冲掉，所以只更新内存里的
   * 源文与顶栏字数，不动 DOM。
   */
  async function saveMarkdown(text, okMessage, repaint) {
    var pid = currentProjectId();
    if (!pid) { notify("请先打开一个课程。"); return false; }
    try {
      await post(
        "/api/projects/" + encodeURIComponent(pid) + "/knowledge-doc/content",
        {
          scope: VIEW.scope || "node",
          node_id: VIEW.nodeId || "",
          content_md: String(text || ""),
        },
        "PUT"
      );
    } catch (error) {
      // 没有 code 的 404 = 这个路由压根不存在，即后端是改动前启动的旧进程
      // （服务端自己抛的 404 一定带 code: knowledge_doc_not_found）。
      // 这种情况给一句能直接照做的事，别再让用户对着「请求失败（404）」猜。
      if (error && error.status === 404 && !error.code) {
        notify("保存接口不可用（404）：知源还是改动前启动的进程，重启一次就好（改动会自动重试保存）。");
        return false;
      }
      fail(error);
      return false;
    }
    VIEW.markdown = String(text || "");
    if (VIEW.lastDoc) {
      VIEW.lastDoc.content_md = VIEW.markdown;
      VIEW.lastDoc.updated_at = new Date().toISOString();
    }
    if (okMessage) notify(okMessage, "success");
    clearError();
    if (repaint === false) return true;
    paintDoc();
    return true;
  }

  /** 存成功了就把此前那条红框收掉 —— 一直挂着会让人以为还没好。 */
  function clearError() {
    var body = document.getElementById("ko-kd-body");
    var box = body ? body.querySelector(".ko-kd-err") : null;
    if (box && box.parentNode) box.parentNode.removeChild(box);
    VIEW.error = "";
  }

  /* ------------------------------------------------- 边打字边存（防抖） */

  var SAVE_DEBOUNCE_MS = 900;
  var saveTimer = 0;

  function onBodyInput() {
    if (!VIEW.open || !VIEW.editable) return;
    var root = mdRoot();
    if (!root) return;
    var md = serializeBlocks(root);
    if (!md || md === VIEW.markdown) return;
    VIEW.markdown = md;
    VIEW.dirty = true;
    setMeta("正在改…停手约 1 秒自动保存");
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushEdit, SAVE_DEBOUNCE_MS);
  }

  function nowHm() {
    var d = new Date();
    return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }

  /** 把待存的改动写回库。不弹提示 —— 改一个字弹一次太吵，顶栏那行小字够了。 */
  async function flushEdit() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
    if (!VIEW.dirty) return;
    var ok = await saveMarkdown(VIEW.markdown, "", false);
    if (!ok) return;
    VIEW.dirty = false;
    setMeta("已保存 " + nowHm() + " · " + docMetaLine());
  }

  /** 选中一段话 → 加/去高亮。存进 Markdown，所以关掉再打开还在。 */
  async function toggleHighlight(text) {
    var needle = String(text || "").replace(/\s+/g, " ").trim();
    if (needle.length < 2) return;
    var md = VIEW.markdown || "";
    var marked = "==" + needle + "==";
    var at = md.indexOf(marked);
    if (at >= 0) {
      if (await saveMarkdown(md.slice(0, at) + needle + md.slice(at + marked.length), "已取消高亮。", false)) {
        paintMarkdown(true);
      }
      return;
    }
    // ponytail: 同一句在正文里出现多次时只改第一处**没被高亮过**的 —— DOM 选区到
    // Markdown 源文没有稳定的偏移映射，逐处对齐要自己维护一套索引，不值当。
    // 真要精确就进编辑模式手写 ==。命中不到就如实说，别悄悄什么都不做。
    var from = 0;
    var hit = -1;
    while (from <= md.length) {
      var i = md.indexOf(needle, from);
      if (i < 0) break;
      var before = md.slice(Math.max(0, i - 2), i);
      var after = md.slice(i + needle.length, i + needle.length + 2);
      if (before !== "==" && after !== "==") { hit = i; break; }
      from = i + 1;
    }
    if (hit < 0) {
      notify("这段原文里没找到（可能跨了表格或公式）—— 用编辑模式直接加 == 更稳。");
      return;
    }
    if (await saveMarkdown(md.slice(0, hit) + marked + md.slice(hit + needle.length), "已高亮。", false)) {
      paintMarkdown(true);
    }
  }

  /** 顶栏那行小字：让用户一眼看出这份是按什么口径合的。 */
  function compiledOrderNote() {
    if (VIEW.order !== "layer") return "";
    return VIEW.maxLayer > 0
      ? " · 按层序 · 只到第 " + VIEW.maxLayer + " 层"
      : " · 按层序";
  }

  /** ``projectId``：不传 = 沿用当前指定（内部重画都走这一条，不能把指定项目冲掉）；
   *  传了 = 改看那个项目的文档（侧栏「文档」图标用）。清空只发生在 closeOverlay。 */
  async function openCompiled(autoCompile, projectId) {
    if (projectId) VIEW.pid = projectId;
    var pid = currentProjectId();
    if (!pid) { notify("请先打开一个课程。"); return; }
    openOverlay();
    VIEW.picker = false;
    setTitle(projectLabel() + " · 知识文档");
    setMeta("读取中…");
    barActions("");
    renderBody('<p class="ko-kd-empty">正在读取…</p>');
    document.getElementById("ko-kd-toc").innerHTML = "";

    var res;
    try {
      res = await api("/api/projects/" + encodeURIComponent(pid) + "/knowledge-doc/compiled");
    } catch (error) {
      fail(error);
      return;
    }
    if (res && res.doc) {
      VIEW.mode = "compiled";
      renderDoc(res.doc, "project");
      return;
    }
    if (autoCompile) {
      await doCompile();
      return;
    }
    VIEW.mode = "compiled";
    setMeta("");
    barActions(
      iconBtn("merge",
        "现在合订：把已生成详解的知识点拼成整份带目录的长文（本地拼接，不调用模型）",
        " data-kd-compile", "ko-kd-btn-primary") +
      iconBtn("layers", "按层级合订：按前置层号由浅入深排，或只收进前几层", " data-kd-layer-toggle")
    );
    renderBody(
      '<div class="ko-kd-empty">还没有合订稿。<br>' +
      "「合订」是本地拼接、不调用模型：把已经生成过详解的知识点排成一份带目录的长文，" +
      "并给每一节标上它在学习路径上的层号与承接关系。所以可以先只挑几个重点知识点生成，之后再合订。<br><br>" +
      "两个按钮的分工：<b>一键生成整份</b> = 把还没有详解的知识点补齐再合订；" +
      "<b>全部重新生成</b> = 让模型把每一节重写一遍再合订（最慢，但内容会重来）。" +
      "<br><br>已经合订过之后，用 <b>按层级合订</b> 换排序口径 —— " +
      "按前置层号由浅入深排，或只收进前几层。</div>"
    );
    document.getElementById("ko-kd-toc").innerHTML = "";
  }

  /** 合订。``order`` = tree（按框架章节）/ layer（按前置层号）；``maxLayer`` = 只收前 N 层。
   *  两者都只影响顺序与收录范围，纯本地拼接，不调用模型。 */
  async function doCompile(order, maxLayer) {
    var pid = currentProjectId();
    if (!pid) return;
    VIEW.busy = true;
    setMeta("");
    barActions('<span class="ko-kd-bar-meta">合订中…</span>');
    renderBody(
      '<p class="ko-kd-empty">' +
      (order === "layer"
        ? "正在按前置层号由浅入深重排…"
        : "正在把已生成的知识点拼成整份文档…") +
      "</p>"
    );
    document.getElementById("ko-kd-toc").innerHTML = "";
    var payload = {};
    if (order === "layer") payload.order = "layer";
    if (maxLayer > 0) payload.max_layer = maxLayer;
    try {
      await post("/api/projects/" + encodeURIComponent(pid) + "/knowledge-doc/compile", payload);
    } catch (error) {
      VIEW.busy = false;
      fail(error);
      return;
    }
    VIEW.busy = false;
    await openCompiled(false);
    notify(
      order === "layer"
        ? (maxLayer > 0 ? "已按层序合订，只含第 1~" + maxLayer + " 层。" : "已按层序合订。")
        : "已合订。",
      "success"
    );
  }

  /* --------------------------------------------------------- 按层级合订 */

  /** 每层各有几个知识点（层号来自前置边，见 core/knowledge_doc 的 order_by_layer）。 */
  async function loadLayers() {
    var pid = currentProjectId();
    if (!pid) return [];
    try {
      var res = await api("/api/projects/" + encodeURIComponent(pid) + "/knowledge-doc/layers");
      return (res && res.items) || [];
    } catch (error) {
      return [];
    }
  }

  function layerPanelHtml(layers) {
    var orderBtns =
      '<div class="ko-kd-layer-row"><span class="ko-kd-layer-label">排序</span>' +
      optBtn("tree", "按框架章节", VIEW.order !== "layer") +
      optBtn("layer", "按层序（由浅入深）", VIEW.order === "layer") +
      "</div>";
    var maxLayer = VIEW.maxLayer || 0;
    var cuts = ['<div class="ko-kd-layer-row"><span class="ko-kd-layer-label">读到第几层</span>'];
    cuts.push(optBtn("layer", "全部", maxLayer === 0));
    for (var i = 0; i < layers.length; i++) {
      var layer = Number(layers[i].layer) || 0;
      var documented = Number(layers[i].documented) || 0;
      cuts.push(
        optBtn(
          "layer:" + layer,
          "第 " + layer + " 层",
          maxLayer === layer,
          layers[i].total + " 个知识点，已有详解 " + documented + " 个"
        )
      );
    }
    cuts.push("</div>");
    return (
      '<div class="ko-kd-layer-panel">' +
      orderBtns +
      cuts.join("") +
      '<div class="ko-kd-empty-actions">' +
      '<button type="button" class="ko-kd-btn ko-kd-btn-primary" data-kd-layer-apply>按这个口径合订</button>' +
      '<button type="button" class="ko-kd-btn" data-kd-layer-toggle>收起</button>' +
      '<span class="ko-kd-bar-meta">本地重排，不调用模型、不花钱。</span>' +
      "</div></div>"
    );
  }

  function optBtn(value, label, on, title) {
    return (
      '<button type="button" class="ko-kd-btn ko-kd-opt' + (on ? " ko-kd-is-on" : "") + '"' +
      ' data-kd-layer-opt="' + attr(value) + '"' +
      (title ? ' title="' + attr(title) + '"' : "") + ">" + esc(label) + "</button>"
    );
  }

  async function toggleLayerPanel() {
    VIEW.picker = !VIEW.picker;
    if (!VIEW.picker) {
      var doc = VIEW.lastDoc;
      if (doc) renderDoc(doc, VIEW.mode === "compiled" ? "project" : VIEW.mode);
      else barActions("");
      return;
    }
    barActions('<span class="ko-kd-bar-meta">正在读各层的知识点…</span>');
    var layers = await loadLayers();
    if (!VIEW.picker) return; // 读的过程中用户已经收起了
    VIEW.layers = layers;
    barActions(layerPanelHtml(layers));
  }

  /** 点选项只改本地状态并重画面板（不合订），点「按这个口径合订」才真跑。 */
  function paintLayerPanel() {
    if (!VIEW.picker) return;
    barActions(layerPanelHtml(VIEW.layers || []));
  }


  /* ------------------------------------------------------------ 批量生成 */

  function progressHtml() {
    var total = VIEW.pending.length;
    var pct = total ? Math.round((VIEW.done / total) * 100) : 0;
    var elapsed = Math.round((Date.now() - VIEW.startedAt) / 1000);
    var refresh = VIEW.batchKind === "refresh";
    var current = VIEW.pending[VIEW.done];
    var lines = [];
    for (var i = Math.max(0, VIEW.done - 3); i < Math.min(VIEW.done, total); i++) {
      var item = VIEW.pending[i];
      var bad = VIEW.failed.indexOf(item.name) >= 0;
      lines.push(
        '<div class="ko-kd-log-line' + (bad ? " ko-kd-is-bad" : "") + '">' +
        (bad ? "✕ " : "✓ ") + esc(item.name) + "</div>"
      );
    }
    return (
      '<div class="ko-kd-progress">' +
      '<div class="ko-kd-progress-line"><strong>' +
      (refresh ? "正在重写每一个知识点的详解" : "正在逐个生成知识点文档") +
      "</strong></div>" +
      '<div class="ko-kd-progress-bar"><div class="ko-kd-progress-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="ko-kd-progress-line">第 ' + Math.min(VIEW.done + 1, total) + " / " + total + " 个" +
      (current ? "：" + esc(current.name) : "") + "</div>" +
      '<div class="ko-kd-progress-hint">' +
      "已用时 " + elapsed + " 秒。每个知识点单独调一次模型（这样每个点都能写透），所以要点时间；" +
      (refresh
        ? "重写会覆盖原来的详解，中途停下的话，已经写完的那些保留新版本。"
        : "随时可以停止，已经生成的不会丢。") +
      "</div>" +
      '<div class="ko-kd-empty-actions">' +
      '<button type="button" class="ko-kd-btn" data-kd-stop>停止并合订已完成部分</button>' +
      "</div>" +
      (lines.length ? '<div class="ko-kd-log">' + lines.join("") + "</div>" : "") +
      "</div>"
    );
  }

  function paintProgress() {
    setTitle(VIEW.batchKind === "refresh" ? "重新生成全部详解" : "生成整份知识文档");
    setMeta("已生成 " + VIEW.done + " / " + VIEW.pending.length);
    barActions("");
    var body = document.getElementById("ko-kd-body");
    if (body) body.innerHTML = progressHtml();
  }

  /** 一键生成整份：先把缺的节点逐个写完，再本地合订。
   *  kind="refresh" 时反过来 —— 只重写**已有**详解的节点（费模型，所以先确认）。 */
  async function startBatch(kind) {
    var pid = currentProjectId();
    if (!pid) { notify("请先打开一个课程。"); return; }
    var refresh = kind === "refresh";
    var status;
    try {
      status = await api("/api/projects/" + encodeURIComponent(pid) + "/knowledge-doc");
    } catch (error) {
      fail(error);
      return;
    }
    var items = (status && status.items) || [];
    if (!items.length) {
      notify("这个课程还没有知识点，先生成知识框架。", "error");
      return;
    }
    var pending = items.filter(function (item) {
      return refresh ? Boolean(item.has_doc) : !item.has_doc;
    });
    if (!pending.length) {
      if (refresh) {
        notify("还没有已经生成的详解，先点「一键生成整份」补齐。", "error");
        return;
      }
      await openCompiled(true);
      notify("所有知识点都已有文档，直接合订。", "success");
      return;
    }

    if (refresh && typeof window.confirm === "function") {
      var ok = true;
      try {
        ok = window.confirm(
          "将重新生成 " + pending.length + " 个知识点的详解：每个点单独调一次模型，" +
          "可能要几分钟、费用也会相应增加。写完后会自动重新合订。继续吗？"
        );
      } catch (error) {
        ok = true; // 宿主没有 confirm 就别拦着用户
      }
      if (!ok) return;
    }

    // 批量同样要问回流：一次性可能塞进几十张卡，比单节点更需要用户知情。
    var batchSync = askSyncOnce(0, "这批 " + pending.length + " 份文档");
    var batchCards = { synced: 0, removed: 0 };

    openOverlay();
    document.getElementById("ko-kd-toc").innerHTML = "";
    VIEW.mode = "batch";
    VIEW.batchKind = refresh ? "refresh" : "fill";
    VIEW.pending = pending;
    VIEW.done = 0;
    VIEW.failed = [];
    VIEW.cancelled = false;
    VIEW.busy = true;
    VIEW.startedAt = Date.now();
    VIEW.total = items.length;
    paintProgress();

    for (var i = 0; i < pending.length; i++) {
      if (VIEW.cancelled) break;
      VIEW.done = i;
      paintProgress();
      try {
        var q = [];
        if (refresh) q.push("refresh=true");
        if (!batchSync) q.push("sync_cards=false");
        var one = await post(
          "/api/projects/" + encodeURIComponent(pid) + "/nodes/" +
          encodeURIComponent(pending[i].node_id) + "/doc" +
          (q.length ? "?" + q.join("&") : ""),
          {}
        );
        // 累加整批的回流结果，收尾时一次性广播 + 一次性告知，别一个节点弹一次。
        // 只算「这一轮真正新写进去的」：synced 是卡总数，updated 是其中本来就存在的，
        // 两者之差才是新增。不这么算的话，第二次点「一键生成整份文档」全是缓存命中，
        // 会拿一堆早就加过的卡谎报「另把 N 道自测题加入知识卡片」。
        var cc = one && one.check_cards;
        if (cc && !cc.skipped && !cc.error) {
          var fresh = (cc.synced || 0) - (cc.updated || 0);
          batchCards.synced += fresh > 0 ? fresh : 0;
          batchCards.removed += cc.removed || 0;
        }
      } catch (error) {
        // 单个失败不中断整批 —— 剩下的一起跳过才是真的浪费
        VIEW.failed.push(pending[i].name);
      }
    }
    VIEW.done = Math.min(pending.length, VIEW.done + 1);
    VIEW.busy = false;

    // 收尾：把已经写好的部分合订。沿用当前的排序口径（按层序/按章节、截到第几层），
    // 别刚生成完就把用户正在用的口径悄悄换回默认。
    var tailPayload = {};
    if (VIEW.order === "layer") tailPayload.order = "layer";
    if (VIEW.maxLayer > 0) tailPayload.max_layer = VIEW.maxLayer;
    try {
      await post(
        "/api/projects/" + encodeURIComponent(pid) + "/knowledge-doc/compile",
        tailPayload
      );
    } catch (error) {
      fail(error);
      return;
    }
    await openCompiled(false);
    var doneCount = pending.length - VIEW.failed.length;
    var tail = (refresh ? "已重写 " : "已生成 ") + doneCount + " 个知识点的文档并合订。";
    if (batchCards.synced > 0) {
      tail += "另把 " + batchCards.synced + " 道自测题加入知识卡片。";
    }
    if (VIEW.failed.length) tail += "另有 " + VIEW.failed.length + " 个失败，可单独重试。";
    notify(tail, VIEW.failed.length ? "warning" : "success");
    // 卡片变了就广播，让「知识卡片」页当场重新拉 —— 别让用户手动刷新。
    if (batchCards.synced > 0 || batchCards.removed > 0) {
      announceCardsChanged({ synced: batchCards.synced, removed: batchCards.removed });
    }
  }

  /* ------------------------------------------------------------ 导出 / 复制 */

  async function download(scope, nodeId) {
    var pid = currentProjectId();
    if (!pid) return;
    var url = "/api/projects/" + encodeURIComponent(pid) + "/knowledge-doc/export.md?scope=" +
      encodeURIComponent(scope || "project");
    if (scope === "node" && nodeId) url += "&node_id=" + encodeURIComponent(nodeId);
    var resp;
    try {
      // 裸 fetch：api() 会按 JSON 解析，Markdown 是文本
      resp = await fetch(url, { credentials: "same-origin" });
    } catch (error) {
      fail(new Error("下载失败：网络不可用。"));
      return;
    }
    if (resp.status === 401) {
      fail(new Error("登录状态已失效，请重新登录后再试。"));
      return;
    }
    if (!resp.ok) {
      var detail = "";
      try {
        var data = await resp.json();
        detail = (data && data.detail && (data.detail.message || data.detail)) || "";
      } catch (e) {}
      fail(new Error(detail || "下载失败（HTTP " + resp.status + "）。"));
      return;
    }
    var text = await resp.text();
    var name = scope === "node"
      ? (VIEW.title || "知识点文档") + ".md"
      : projectLabel() + "-知识文档.md";
    try {
      var blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      var href = a.href;
      setTimeout(function () { URL.revokeObjectURL(href); if (a.parentNode) a.parentNode.removeChild(a); }, 0);
      notify("已下载 " + name, "success");
    } catch (error) {
      fail(new Error("这份文档暂时下载不了，可以先用「复制」再粘到笔记里。"));
    }
  }

  async function copyMarkdown() {
    var text = VIEW.markdown || "";
    if (!text) { notify("没有可复制的内容。", "error"); return; }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        var box = document.createElement("textarea");
        box.value = text;
        box.style.position = "fixed";
        box.style.opacity = "0";
        document.body.appendChild(box);
        box.select();
        document.execCommand("copy");
        document.body.removeChild(box);
      }
      notify("已复制 Markdown，可粘进笔记。", "success");
    } catch (error) {
      notify("复制失败，可以试试「下载 .md」。", "error");
    }
  }

  /** 生成（或强制重算）一个知识点的文档。一次模型调用几十秒，必须有秒级反馈。 */
  async function generateInto(nodeId, nodeName, refresh, syncCards) {
    var pid = currentProjectId();
    if (!pid || !nodeId) return;
    // syncCards 未显式给就按用户偏好来；偏好还没表态过（null）时先问一次。
    var doSync = (typeof syncCards === "boolean") ? syncCards : askSyncOnce(0, "这份文档");
    var query = [];
    if (refresh) query.push("refresh=true");
    if (!doSync) query.push("sync_cards=false");
    var suffix = query.length ? ("?" + query.join("&")) : "";
    setTitle(nodeName || VIEW.title || "知识点文档");
    barActions('<span class="ko-kd-bar-meta">生成中…</span>');
    document.getElementById("ko-kd-toc").innerHTML = "";
    var seconds = 0;
    function paint() {
      setMeta("生成中… 已 " + seconds + "s");
      var body = document.getElementById("ko-kd-body");
      if (body) {
        body.innerHTML =
          '<div class="ko-kd-empty">正在读这个知识点关联的资料，然后写详解 —— ' +
          "通常十几到几十秒。<br>已等待 " + seconds + " 秒。</div>";
      }
    }
    paint();
    var timer = setInterval(function () { seconds += 1; paint(); }, 1000);
    var doc;
    try {
      doc = await post(
        "/api/projects/" + encodeURIComponent(pid) + "/nodes/" +
        encodeURIComponent(nodeId) + "/doc" + suffix,
        {}
      );
    } catch (error) {
      clearInterval(timer);
      VIEW.mode = "node";
      VIEW.nodeId = nodeId;
      renderBody('<p class="ko-kd-empty">这次没有生成出来。</p>');
      fail(error);
      return;
    }
    clearInterval(timer);
    VIEW.mode = "node";
    VIEW.nodeId = nodeId;
    renderDoc(doc, "node");
    // 如实回报回流结果，不让「多了几张卡」变成用户要去别处发现的意外。
    // 同上：只报这一轮真正新写进去的（synced 是总数，updated 是本来就存在的）。
    // 缓存命中时两者相等 → fresh 为 0 → 不重复告知「已加入 N 道题」，也不重复广播。
    var cc = doc && doc.check_cards;
    if (cc && !cc.skipped && !cc.error) {
      var freshCards = (cc.synced || 0) - (cc.updated || 0);
      if (freshCards > 0) {
        notify(
          "已把 " + freshCards + " 道自测题加入知识卡片，可在复习队列里遇到。",
          "success"
        );
        announceCardsChanged({ synced: freshCards, removed: cc.removed || 0 });
      } else if (doc.cached && cc.removed > 0) {
        // 缓存命中也可能回收了失效卡，照样得通知列表重拉
        announceCardsChanged({ synced: 0, removed: cc.removed });
      }
    }
  }

  /**
   * 告诉 app.js「卡片变了」。
   *
   * 为什么必须广播：卡片列表缓存在 app.js 的 ``state.cards`` 里，进「知识卡片」功能时
   * 才从接口拉一次。文档生成发生在这之后，不通知的话用户得手动刷新页面才看得到新卡 ——
   * 而他刚才明明被告知「已加入 3 道题」，转头去看却没有，这是最伤信任的一种不一致。
   *
   * 沿用这一层既有的跨模块约定（``knoworigin:projects-changed`` 等都是这么发的）。
   */
  function announceCardsChanged(detail) {
    try {
      document.dispatchEvent(new CustomEvent("knoworigin:cards-changed", {
        detail: {
          project_id: currentProjectId(),
          synced: (detail && detail.synced) || 0,
          updated: (detail && detail.updated) || 0,
          removed: (detail && detail.removed) || 0,
        },
      }));
    } catch (e) {
      // 事件发不出去不该影响文档本身：卡片已经入库，用户刷新也能看到。
    }
  }

  /** 速查表「＋文档」的入口：有现成的就直接打开，没有就当场生成 —— 不让用户多点一次。 */
  async function openOrGenerate(nodeId, nodeName) {
    var pid = currentProjectId();
    if (!pid) { notify("请先打开一个课程。"); return; }
    openOverlay();
    VIEW.mode = "node";
    VIEW.nodeId = nodeId;
    setTitle(nodeName || "知识点文档");
    setMeta("读取中…");
    barActions("");
    document.getElementById("ko-kd-toc").innerHTML = "";
    renderBody('<p class="ko-kd-empty">正在读取…</p>');
    try {
      var res = await api(
        "/api/projects/" + encodeURIComponent(pid) + "/nodes/" + encodeURIComponent(nodeId) + "/doc"
      );
      if (res && res.doc) { renderDoc(res.doc, "node"); return; }
    } catch (error) {
      // 读不出来就当作没有，直接进生成 —— 不该让用户在这里卡住
    }
    await generateInto(nodeId, nodeName, false);
  }

  function regenerate(nodeId) {
    return generateInto(nodeId, VIEW.title, true);
  }

  /* ------------------------------------------------------------ 事件 */

  function onClick(event) {
    var target = event.target;
    if (!target || !target.closest) return;

    if (target.closest("[data-kd-close]")) {
      event.preventDefault();
      closeOverlay();
      return;
    }
    var goto_ = target.closest("[data-kd-goto]");
    if (goto_) {
      event.preventDefault();
      gotoAnchor(goto_.getAttribute("data-kd-goto"));
      return;
    }
    var copy = target.closest("[data-kd-copy]");
    if (copy) {
      event.preventDefault();
      copyMarkdown();
      return;
    }
    var dl = target.closest("[data-kd-download]");
    if (dl) {
      event.preventDefault();
      download(dl.getAttribute("data-kd-download") || "project", VIEW.nodeId);
      return;
    }
    var hl = target.closest("[data-kd-hl]");
    if (hl) {
      event.preventDefault();
      // VIEW.sel 是 mouseup 时记下的。有些浏览器点按钮的那一刻会把选区收起来，
      // 那样 mouseup 里读到的是空 —— 这时就当场再读一次，别让按钮点了没反应。
      var picked = VIEW.sel;
      if (!picked) {
        var live = readSelection();
        picked = live ? live.text : "";
      }
      hideSelBar();
      toggleHighlight(picked);
      return;
    }
    var gen = target.closest("[data-kd-generate]");
    if (gen) {
      event.preventDefault();
      generateInto(gen.getAttribute("data-kd-generate"), VIEW.title, false);
      return;
    }
    var regen = target.closest("[data-kd-regen]");
    if (regen) {
      event.preventDefault();
      regenerate(regen.getAttribute("data-kd-regen"));
      return;
    }
    var compileBtn = target.closest("[data-kd-compile]");
    if (compileBtn) {
      event.preventDefault();
      doCompile();
      return;
    }
    var layerToggle = target.closest("[data-kd-layer-toggle]");
    if (layerToggle) {
      event.preventDefault();
      toggleLayerPanel();
      return;
    }
    var layerOpt = target.closest("[data-kd-layer-opt]");
    if (layerOpt) {
      event.preventDefault();
      // 只改本地待选状态，不立刻合订 —— 免得每点一下就重跑一次
      var pick = layerOpt.getAttribute("data-kd-layer-opt") || "tree";
      if (pick.indexOf("layer:") === 0) {
        VIEW.order = "layer";
        VIEW.maxLayer = Number(pick.slice(6)) || 0;
      } else if (pick === "layer") {
        VIEW.order = "layer";
        VIEW.maxLayer = 0;
      } else {
        VIEW.order = pick;
        VIEW.maxLayer = 0;
      }
      paintLayerPanel();
      return;
    }
    var layerApply = target.closest("[data-kd-layer-apply]");
    if (layerApply) {
      event.preventDefault();
      VIEW.picker = false;
      doCompile(VIEW.order, VIEW.maxLayer);
      return;
    }
    var regenAll = target.closest("[data-kd-regen-all]");
    if (regenAll) {
      event.preventDefault();
      startBatch("refresh");
      return;
    }
    var stop = target.closest("[data-kd-stop]");
    if (stop) {
      event.preventDefault();
      VIEW.cancelled = true;
      return;
    }
    var top = target.closest("[data-kd-top]");
    if (top) {
      event.preventDefault();
      var body = document.getElementById("ko-kd-body");
      if (body) body.scrollTop = 0;
      onBodyScroll();
      return;
    }
    // —— 提问 ——
    var askOpen = target.closest("[data-kd-ask-open]");
    if (askOpen) {
      event.preventDefault();
      openAsk(VIEW.selLive ? VIEW.sel : "");
      return;
    }
    var askSel = target.closest("[data-kd-ask-sel]");
    if (askSel) {
      event.preventDefault();
      openAsk(VIEW.sel);
      return;
    }
    var copySel = target.closest("[data-kd-copy-sel]");
    if (copySel) {
      event.preventDefault();
      copyText(VIEW.sel, function () { notify("已复制选中的原文。", "success"); });
      hideSelBar();
      return;
    }
    var askClose = target.closest("[data-kd-ask-close]");
    if (askClose) {
      event.preventDefault();
      closeAsk();
      return;
    }
var askClear = target.closest("[data-kd-ask-clear]");
      if (askClear) {
      event.preventDefault();
      VIEW.askRef = "";
      paintAskRef();
      return;
    }
    var sendBtn = target.closest("[data-kd-ask-send]");
    if (sendBtn) {
      event.preventDefault();
      askSend();
      return;
    }
    var askCopy = target.closest("[data-kd-ask-copy]");
    if (askCopy) {
      event.preventDefault();
      var index = Number(askCopy.getAttribute("data-kd-ask-copy"));
      var msg = VIEW.askThread[index];
      if (msg) copyText(msg.a, function () { notify("已复制这条回答。", "success"); });
      return;
    }
  }

  function onKeydown(event) {
    if (!VIEW.open) return;
    if (event.key !== "Escape") return;
    var panel = document.getElementById("ko-kd-ask");
    if (panel && panel.classList && panel.classList.contains("ko-kd-is-on")) {
      event.preventDefault();
      closeAsk();
      return;
    }
    event.preventDefault();
    closeOverlay();
  }

  function boot() {
    ensureStyle();
    document.addEventListener("click", onClick, false);
    document.addEventListener("keydown", onKeydown, false);
    document.addEventListener("mouseup", onSelectionChange, false);
    document.addEventListener("keyup", onSelectionChange, false);
    // 键盘选字（Shift+方向键）不产生 mouseup，只有 selectionchange 才报得上
    if (document.addEventListener) document.addEventListener("selectionchange", onSelectionChange, false);
    document.addEventListener("mousedown", onDocumentDown, false);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.KnowOriginKnowledgeDoc = {
    openNode: openNode,
    openOrGenerate: openOrGenerate,
    openCompiled: openCompiled,
    compile: doCompile,
    startBatch: startBatch,
    regenerateAll: function () { return startBatch("refresh"); },
    ask: askSend,
    close: closeOverlay,
    // 自测卡片的「回到文档」要用。放在对外接口上而不是让调用方自己去扒 DOM：
    // 锚点怎么编、按文字还是按下标找，都是这一层的事。
    openNodeAtSection: function (nodeId, nodeName, section) {
      return openNode(nodeId, nodeName, { section: section });
    },
    setSyncPref: function (value) { writeSyncPref(!!value); },
    getSyncPref: readSyncPref,
  };
})();
