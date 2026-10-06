// 论文全网搜索 + 学者检索 UI（注入式模块）
// 在文献精读模式的「我的文献」面板集成模式切换（我的文献 vs 全球检索）与侧栏展开，
// 彻底解决双列表纵向挤压、各自只能在一小块空间滚动的体验问题。
// 依赖 app.js 的 api() / showToast() 全局函数。
(function () {
  "use strict";

  const root = document.getElementById("literature-workspace");
  if (!root) return;

  const esc = (v) =>
    String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  // ── 状态 ──
  const S = {
    activeView: "library", // "library"（我的文献，默认） | "search"（全球学术检索）
    isAsideExpanded: false, // 侧栏是否加宽至 520px
    mode: "papers", // "papers" | "authors" | "author-papers"
    query: "",
    papers: [],
    authors: [],
    total: 0,
    offset: 0,
    loading: false,
    authorDetail: null, // { authorId, name }
    // 筛选
    year: "",
    openAccess: false,
    minCitations: 0,
    sort: "",
    // 检索说明（多源管线回传）
    coverage: [],   // [{id,label,hits,used,ok,note}]
    degraded: [],   // [{source,reason}]
    plan: null,     // {raw,terms,synonyms,field,rewritten,note}
    pipeline: "",
    // 论文详情弹窗
    detailPaper: null,
    detailLoading: false,
  };

  // ── 样式 ──
  const style = document.createElement("style");
  style.id = "paper-search-custom-styles";
  style.textContent = `
/* ── 左侧文献库面板整体 Flex 布局治理 ── */
#lit-library-panel {
  display: flex !important;
  flex-direction: column !important;
  height: 100% !important;
  min-height: 0 !important;
  box-sizing: border-box !important;
  padding: 10px 12px !important;
  overflow: hidden !important;
}
/* 隐藏态必须真隐藏：上面的 ID+!important 特异度高于 .hidden 的 !important（类选择器），
   会把 literature.js showLibraryPanel() 加的 hidden 类整个压掉——
   表现为文献库面板永远叠在 AI 问答上方关不掉、列表被挤扁。 */
#lit-library-panel.hidden {
  display: none !important;
}

/* 侧栏平滑宽度加宽过渡 */
.sr-aside {
  transition: flex-basis 0.22s cubic-bezier(0.4, 0, 0.2, 1) !important;
}
/* 拖拽中必须关掉过渡：0.22s 的补间会让侧栏黏在指针后面，
   松手时渲染宽度还没追上目标（拖 140px 只走 ~60px）。is-aside-resizing
   由 literature.js 在 pointerdown/pointerup 加删。 */
body.is-aside-resizing .sr-aside {
  transition: none !important;
}
/* 注意：这里**不能**再写 .sr-aside.is-expanded { flex: 0 0 520px !important; --sr-aside-w: 520px !important; }
   宽度由 literature.js 的 setAsideWidth() 独家掌管（内联变量 + localStorage）。
   用 !important 钉死 flex-basis 会压掉拖拽手柄写的内联变量，面板看着正常、分隔条却拖不动。 */

/* 顶部模式分段控制器导航 */
.lit-lib-header-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
  /* 侧栏较窄时（默认 320px）这一行装不下「分段器 + 科研画像 + 加宽」，
     允许换行兜底，避免末尾按钮被挤出面板外看不见。 */
  flex-wrap: wrap;
}
.lit-lib-segmented {
  display: inline-flex;
  align-items: center;
  background: var(--sidebar);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 3px;
  gap: 2px;
  /* 侧栏收窄时不允许分段器被压到内容宽度以下，否则按钮内文字会逐字换行成竖排 */
  flex-shrink: 0;
}
.lit-lib-seg-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 11px;
  border-radius: 7px;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: calc(12px * var(--font-scale, 1));
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
  line-height: 1.2;
  /* 按钮文案必须单行：inline-flex 默认 white-space:normal，窄容器下会竖排换行 */
  white-space: nowrap;
}
.lit-lib-seg-btn:hover {
  color: var(--ink);
}
.lit-lib-seg-btn.active {
  background: var(--green);
  color: #0e1410;
  font-weight: 700;
  box-shadow: 0 1px 4px rgba(0,0,0,0.12);
}
.lit-seg-count {
  font-size: calc(10.5px * var(--font-scale, 1));
  padding: 1px 5px;
  border-radius: 999px;
  background: rgba(0,0,0,0.15);
  color: inherit;
  font-weight: 700;
}
.lit-lib-seg-btn:not(.active) .lit-seg-count {
  background: var(--line);
  color: var(--muted);
}
.lit-aside-expand-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 9px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--muted);
  font-size: calc(11.5px * var(--font-scale, 1));
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
}
.lit-aside-expand-btn:hover {
  border-color: var(--green);
  color: var(--ink);
  background: var(--sidebar);
}
.lit-aside-expand-btn.active {
  border-color: var(--green);
  background: rgba(46, 158, 91, 0.12);
  color: var(--green);
}

/* ── 模式一：我的文献 (data-active-view="library") ── */
#lit-library-panel[data-active-view="library"] #ps-container {
  display: none !important;
}
#lit-library-panel[data-active-view="library"] .lit-library-actions {
  display: grid !important;
  flex-shrink: 0;
  margin-bottom: 8px !important;
}
#lit-library-panel[data-active-view="library"] #lit-synthesis-bar {
  display: flex !important;
  flex-shrink: 0;
  margin-bottom: 8px !important;
}
#lit-library-panel[data-active-view="library"] .lit-library-filters {
  display: grid !important;
  flex-shrink: 0;
  margin-bottom: 8px !important;
}
#lit-library-panel[data-active-view="library"] #lit-list {
  display: flex !important;
  flex: 1 1 0 !important;
  min-height: 0 !important;
  overflow-y: auto !important;
  scrollbar-width: thin !important;
  scrollbar-color: var(--line) transparent !important;
  padding-right: 2px !important;
}
#lit-library-panel[data-active-view="library"] #lit-list::-webkit-scrollbar {
  width: 6px !important;
  display: block !important;
}
#lit-library-panel[data-active-view="library"] #lit-list::-webkit-scrollbar-thumb {
  background: var(--line) !important;
  border-radius: 6px !important;
}
#lit-library-panel[data-active-view="library"] #lit-list::-webkit-scrollbar-thumb:hover {
  background: var(--muted) !important;
}

/* ── 模式二：全球检索 (data-active-view="search") ── */
#lit-library-panel[data-active-view="search"] .lit-library-actions,
#lit-library-panel[data-active-view="search"] #lit-synthesis-bar,
#lit-library-panel[data-active-view="search"] .lit-library-filters,
#lit-library-panel[data-active-view="search"] #lit-list {
  display: none !important;
}
#lit-library-panel[data-active-view="search"] #ps-container {
  display: flex !important;
  flex-direction: column !important;
  flex: 1 1 0 !important;
  min-height: 0 !important;
  overflow: hidden !important;
}

/* ── 全球检索工作台内部样式 ── */
.ps-search-bar {
  display: flex;
  gap: 6px;
  padding: 0 0 8px;
  align-items: center;
  flex-shrink: 0;
}
.ps-search-bar input[type=search] {
  flex: 1;
  min-width: 140px;
  padding: 7px 11px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--ink);
  font-size: calc(13px * var(--font-scale, 1));
  outline: none;
  box-sizing: border-box;
}
.ps-search-bar input:focus {
  border-color: var(--green);
}
.ps-search-btn-primary {
  padding: 7px 14px;
  border-radius: 8px;
  border: none;
  background: var(--green);
  color: #0e1410;
  font-size: calc(12.5px * var(--font-scale, 1));
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: opacity 0.15s ease;
}
.ps-search-btn-primary:hover {
  opacity: 0.88;
}

.ps-tab-bar {
  display: flex;
  gap: 4px;
  padding: 0 0 8px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--line);
  margin-bottom: 8px;
}
.ps-tab {
  padding: 4px 12px;
  border-radius: 6px;
  font-size: calc(12px * var(--font-scale, 1));
  cursor: pointer;
  border: 1px solid transparent;
  background: transparent;
  color: var(--muted);
  transition: all .15s;
  font-weight: 500;
}
.ps-tab:hover {
  background: var(--sidebar);
  color: var(--ink);
}
.ps-tab.active {
  background: var(--green);
  color: #0e1410;
  font-weight: 600;
}

.ps-filters {
  display: flex;
  gap: 6px;
  padding: 0 0 8px;
  flex-wrap: wrap;
  align-items: center;
  flex-shrink: 0;
}
.ps-filters select, .ps-filters input[type=number] {
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--ink);
  font-size: calc(12px * var(--font-scale, 1));
}
.ps-filters label {
  font-size: calc(12px * var(--font-scale, 1));
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}

.ps-results {
  flex: 1 1 0 !important;
  min-height: 0 !important;
  overflow-y: auto !important;
  max-height: none !important;
  padding: 2px 2px 14px 0 !important;
  scrollbar-width: thin !important;
  scrollbar-color: var(--line) transparent !important;
}
.ps-results::-webkit-scrollbar {
  width: 6px;
  display: block;
}
.ps-results::-webkit-scrollbar-thumb {
  background: var(--line);
  border-radius: 6px;
}
.ps-results::-webkit-scrollbar-thumb:hover {
  background: var(--muted);
}

.ps-card {
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: var(--panel);
  margin-bottom: 8px;
  cursor: pointer;
  transition: border-color .15s, box-shadow .15s, transform .15s;
  box-sizing: border-box;
}
.ps-card:hover {
  border-color: var(--green);
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}
.ps-card-title {
  font-size: calc(13px * var(--font-scale, 1));
  font-weight: 600;
  color: var(--ink);
  line-height: 1.45;
  margin-bottom: 5px;
}
.ps-card-meta {
  font-size: calc(11.5px * var(--font-scale, 1));
  color: var(--muted);
  line-height: 1.5;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  align-items: center;
}
.ps-card-abstract {
  font-size: calc(12px * var(--font-scale, 1));
  color: var(--muted);
  line-height: 1.55;
  margin-top: 6px;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  opacity: 0.9;
}

.ps-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: calc(10.5px * var(--font-scale, 1));
  font-weight: 500;
}
.ps-badge-oa {
  background: rgba(29,158,117,.15);
  color: var(--green);
}
.ps-badge-cite {
  background: rgba(186,117,23,.15);
  color: var(--gold);
}
.ps-badge-year {
  background: var(--line);
  color: var(--ink);
}

.ps-author-card {
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: var(--panel);
  margin-bottom: 8px;
  cursor: pointer;
  transition: border-color .15s, transform .15s;
}
.ps-author-card:hover {
  border-color: var(--green);
  transform: translateY(-1px);
}
.ps-author-name {
  font-size: calc(13.5px * var(--font-scale, 1));
  font-weight: 600;
  color: var(--ink);
}
.ps-author-info {
  font-size: calc(12px * var(--font-scale, 1));
  color: var(--muted);
  margin-top: 3px;
  line-height: 1.4;
}

.ps-load-more {
  display: block;
  width: 100%;
  padding: 8px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--muted);
  font-size: calc(12px * var(--font-scale, 1));
  cursor: pointer;
  margin-top: 4px;
  transition: all .15s;
}
.ps-load-more:hover {
  border-color: var(--green);
  color: var(--ink);
  background: var(--sidebar);
}
.ps-empty {
  text-align: center;
  padding: 40px 12px;
  color: var(--muted);
  font-size: calc(13px * var(--font-scale, 1));
  line-height: 1.6;
}
.ps-loading {
  text-align: center;
  padding: 30px;
  color: var(--muted);
  font-size: calc(13px * var(--font-scale, 1));
}
.ps-breadcrumb {
  padding: 0 0 6px;
  font-size: calc(12px * var(--font-scale, 1));
  color: var(--muted);
  flex-shrink: 0;
}
.ps-breadcrumb a {
  color: var(--green);
  cursor: pointer;
  text-decoration: none;
}
.ps-breadcrumb a:hover {
  text-decoration: underline;
}

/* 详情弹窗 */
.ps-detail-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0,0,0,.5);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  backdrop-filter: blur(2px);
}
.ps-detail-panel {
  background: var(--panel);
  border-radius: 14px;
  max-width: 660px;
  width: 100%;
  max-height: 82vh;
  overflow-y: auto;
  padding: 24px;
  position: relative;
  border: 1px solid var(--line);
  box-shadow: var(--shadow);
}
.ps-detail-close {
  position: absolute;
  top: 14px;
  right: 16px;
  background: none;
  border: none;
  font-size: calc(20px * var(--font-scale, 1));
  color: var(--muted);
  cursor: pointer;
  line-height: 1;
}
.ps-detail-close:hover {
  color: var(--ink);
}
.ps-detail-title {
  font-size: calc(16px * var(--font-scale, 1));
  font-weight: 600;
  color: var(--ink);
  line-height: 1.45;
  margin-bottom: 8px;
  padding-right: 32px;
}
.ps-detail-meta {
  font-size: calc(12px * var(--font-scale, 1));
  color: var(--muted);
  margin-bottom: 14px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
}
.ps-detail-section {
  margin-bottom: 14px;
}
.ps-detail-section h4 {
  font-size: calc(13px * var(--font-scale, 1));
  font-weight: 600;
  color: var(--ink);
  margin: 0 0 6px;
}
.ps-detail-section p {
  font-size: calc(12.5px * var(--font-scale, 1));
  color: var(--muted);
  line-height: 1.6;
  margin: 0;
}
.ps-detail-actions {
  display: flex;
  gap: 8px;
  margin-top: 18px;
  flex-wrap: wrap;
}
.ps-detail-actions button, .ps-detail-actions a {
  padding: 7px 16px;
  border-radius: 8px;
  font-size: calc(12.5px * var(--font-scale, 1));
  font-weight: 500;
  cursor: pointer;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--ink);
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: all .15s;
}
.ps-detail-actions button:hover, .ps-detail-actions a:hover {
  border-color: var(--green);
}
.ps-detail-actions .ps-primary {
  background: var(--green);
  color: #0e1410;
  border-color: var(--green);
  font-weight: 600;
}
.ps-detail-actions .ps-primary:hover {
  opacity: .88;
}
/* 导入进度条（SSE 实时反馈下载→解析→入库） */
.ps-import-progress {
  margin-top: 14px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--sidebar);
}
.ps-import-stage {
  font-size: calc(12.5px * var(--font-scale, 1));
  color: var(--ink);
  margin-bottom: 8px;
  line-height: 1.4;
  word-break: break-word;
}
.ps-import-bar {
  height: 8px;
  border-radius: 999px;
  background: var(--line);
  overflow: hidden;
}
.ps-import-bar-fill {
  height: 100%;
  width: 0%;
  background: var(--green);
  border-radius: 999px;
  transition: width .2s ease;
}
.ps-import-progress.is-indeterminate .ps-import-bar-fill {
  width: 30%;
  animation: ps-import-slide 1.2s ease-in-out infinite;
}
@keyframes ps-import-slide {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(360%); }
}
.ps-import-pct {
  font-size: calc(11px * var(--font-scale, 1));
  color: var(--muted);
  margin-top: 6px;
}
.ps-import-progress.is-error .ps-import-bar-fill {
  background: var(--red);
  animation: none;
  transform: none;
}
.ps-import-progress.is-error .ps-import-stage {
  color: var(--red);
}
.ps-import-progress.is-done .ps-import-bar-fill {
  background: var(--green);
  animation: none;
  transform: none;
}
/* 检索说明条：改写式 + 各源命中 + 降级原因（口径诚实，不让用户以为"命中几万条都相关"） */
.ps-retrieval-note {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px 8px;
  padding: 8px 10px;
  margin-bottom: 10px;
  border-radius: 8px;
  background: var(--panel);
  border: 1px solid var(--line);
  font-size: calc(11.5px * var(--font-scale, 1));
  line-height: 1.6;
  color: var(--muted);
}
.ps-rn-label {
  color: var(--muted);
}
.ps-rn-query {
  color: var(--ink);
  font-weight: 500;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.ps-rn-chip {
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--line);
  color: var(--muted);
  white-space: nowrap;
}
.ps-rn-chip.is-ok {
  color: var(--green);
  border-color: var(--green);
}
.ps-rn-chip.is-off {
  color: var(--red);
  border-color: var(--red);
}
.ps-rn-warn {
  flex-basis: 100%;
  color: var(--red);
  word-break: break-word;
}
/* 降级原因只留一行，完整原因挂 title —— 侧栏折叠时只有 280px 宽 */
.ps-rn-degrade {
  flex-basis: 100%;
  color: var(--red);
  opacity: .85;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: help;
}
.ps-badge-src {
  background: var(--line);
  color: var(--muted);
}
.ps-card-reasons {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 7px;
}
.ps-card-reasons span {
  font-size: calc(10.5px * var(--font-scale, 1));
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--line);
  color: var(--muted);
}
`;
  document.head.appendChild(style);

  // ── 容器与导航注入 ──
  let headerNav = null;
  let container = null;

  function ensureNav() {
    if (headerNav && headerNav.parentNode) return headerNav;
    const libraryPanel = root.querySelector("#lit-library-panel");
    if (!libraryPanel) return null;

    headerNav = document.getElementById("lit-lib-header-nav");
    if (headerNav) return headerNav;

    headerNav = document.createElement("div");
    headerNav.id = "lit-lib-header-nav";
    headerNav.className = "lit-lib-header-nav";
    // 按钮的「加宽/还原」文案按**当前真实宽度**定，别信一个只在点按钮时才翻转的内存标记：
    // 用户手动拖过分隔条之后，侧栏可能早就不是 320/520 了。
    S.isAsideExpanded = isExpandedWidth(readAsideWidth());
    headerNav.innerHTML = `
      <div class="lit-lib-segmented" role="tablist" aria-label="文献工作台模式切换">
        <button class="lit-lib-seg-btn ${S.activeView === "library" ? "active" : ""}" data-view="library" type="button" role="tab" aria-selected="${S.activeView === "library" ? "true" : "false"}">
          <span class="lit-seg-icon">📚</span>
          <span class="lit-seg-text">我的文献</span>
          <span class="lit-seg-count" id="lit-seg-lib-count">0</span>
        </button>
        <button class="lit-lib-seg-btn ${S.activeView === "search" ? "active" : ""}" data-view="search" type="button" role="tab" aria-selected="${S.activeView === "search" ? "true" : "false"}">
          <span class="lit-seg-icon">🌐</span>
          <span class="lit-seg-text">全球检索</span>
        </button>
      </div>
      <button class="lit-aside-expand-btn ${S.isAsideExpanded ? "active" : ""}" id="lit-aside-expand-btn" type="button" title="${S.isAsideExpanded ? "还原侧边栏默认宽度 (320px)" : "加宽侧边栏至 520px，更适合阅读论文摘要与期刊指标"}">
        <span class="lit-expand-icon">${S.isAsideExpanded ? "⤡" : "⤢"}</span>
        <span class="lit-expand-text">${S.isAsideExpanded ? "还原" : "加宽"}</span>
      </button>
    `;

    libraryPanel.insertAdjacentElement("afterbegin", headerNav);
    bindNavEvents(headerNav);
    updateLibraryCountBadge();
    return headerNav;
  }

  function bindNavEvents(nav) {
    nav.querySelectorAll(".lit-lib-seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const view = btn.dataset.view;
        switchView(view);
      });
    });

    const expandBtn = nav.querySelector("#lit-aside-expand-btn");
    if (expandBtn) {
      expandBtn.addEventListener("click", toggleAsideExpand);
    }
  }

  function switchView(view) {
    S.activeView = view;
    const libraryPanel = root.querySelector("#lit-library-panel");
    if (libraryPanel) {
      libraryPanel.setAttribute("data-active-view", view);
    }

    if (headerNav) {
      headerNav.querySelectorAll(".lit-lib-seg-btn").forEach((b) => {
        const isActive = b.dataset.view === view;
        b.classList.toggle("active", isActive);
        b.setAttribute("aria-selected", isActive ? "true" : "false");
      });
    }

    if (view === "search") {
      render();
      // 聚焦检索框
      setTimeout(() => {
        const input = document.getElementById("ps-query");
        if (input && !S.query) input.focus();
      }, 50);
    } else {
      updateLibraryCountBadge();
    }
  }

  // ── 侧栏宽度：宽度本身归 literature.js 管（内联 --sr-aside-w + localStorage），
  //    这里只做「加宽/还原」两档预设，不参与宽度计算 ──
  const ASIDE_DEFAULT_W = 320;
  const ASIDE_EXPANDED_W = 520;
  const ASIDE_EXPANDED_TOL = 20; // 宽到 500+ 就算「已加宽」

  function isExpandedWidth(w) {
    return Number(w) >= ASIDE_EXPANDED_W - ASIDE_EXPANDED_TOL;
  }

  function readAsideWidth() {
    const bridge = window.KnowOriginLiterature;
    if (bridge && typeof bridge.getAsideWidth === "function") return bridge.getAsideWidth();
    const aside = root.querySelector(".sr-aside");
    if (!aside) return 0;
    // 读意图宽度（变量）而不是渲染宽度：0.22s 过渡期间 rect 还没追上目标
    const v = parseFloat(getComputedStyle(aside).getPropertyValue("--sr-aside-w"));
    return Number.isFinite(v) ? Math.round(v) : Math.round(aside.getBoundingClientRect().width);
  }

  // 把宽度写回去：优先调 literature.js 的公开入口（夹取 + 落盘 + 广播都归它管）。
  // 极端加载顺序下桥还没挂上时，至少让本会话的宽度生效，别整条链路哑掉。
  function setAsideWidth(w) {
    const bridge = window.KnowOriginLiterature;
    if (bridge && typeof bridge.setAsideWidth === "function") {
      bridge.setAsideWidth(w);
      return;
    }
    const aside = root.querySelector(".sr-aside");
    if (aside) aside.style.setProperty("--sr-aside-w", Math.round(w) + "px");
  }

  function syncExpandVisual() {
    const expanded = isExpandedWidth(readAsideWidth());
    S.isAsideExpanded = expanded;
    const btn = document.getElementById("lit-aside-expand-btn");
    if (!btn) return;
    btn.classList.toggle("active", expanded);
    const icon = btn.querySelector(".lit-expand-icon");
    const text = btn.querySelector(".lit-expand-text");
    if (icon) icon.textContent = expanded ? "⤡" : "⤢";
    if (text) text.textContent = expanded ? "还原" : "加宽";
    btn.title = expanded
      ? "还原侧边栏默认宽度 (320px)"
      : "加宽侧边栏至 520px，更适合阅读论文摘要与期刊指标";
  }

  // 拖拽分隔条也会改宽度：跟着广播走，按钮文案才不会和画面打架
  document.addEventListener("knoworigin:aside-width", syncExpandVisual);

  function toggleAsideExpand() {
    setAsideWidth(S.isAsideExpanded ? ASIDE_DEFAULT_W : ASIDE_EXPANDED_W);
    // 按钮的视觉状态由 syncExpandVisual 按真实宽度统一刷新，这里不自己翻标记
    syncExpandVisual();
  }

  function updateLibraryCountBadge() {
    const countEl = document.getElementById("lit-seg-lib-count");
    if (!countEl) return;
    const items = root.querySelectorAll("#lit-list .lit-item");
    countEl.textContent = String(items.length || 0);
  }

  function ensureContainer() {
    ensureNav();
    if (container && container.parentNode) return container;
    const libraryPanel = root.querySelector("#lit-library-panel");
    if (!libraryPanel) return null;

    container = document.getElementById("ps-container");
    if (container) return container;

    // 在「导入论文」操作栏之后插入搜索容器
    const actions = libraryPanel.querySelector(".lit-library-actions");
    container = document.createElement("div");
    container.id = "ps-container";
    if (actions) {
      actions.insertAdjacentElement("afterend", container);
    } else {
      libraryPanel.appendChild(container);
    }
    return container;
  }

  function paperKey(p) {
    if (!p) return "";
    const doi = String(p.doi || "").trim().toLowerCase();
    if (doi) return "doi:" + doi;
    const ax = String(p.arxivId || "").trim().toLowerCase();
    if (ax) return "axv:" + ax;
    if (p.pmid) return "pmid:" + p.pmid;
    return "t:" + String(p.title || "").toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/g, "").slice(0, 120);
  }

  // ── 检索说明条：改写式 + 各源命中 + 降级原因 ──
  function retrievalNote() {
    const plan = S.plan;
    const cov = S.coverage || [];
    if (!plan && !cov.length) return "";
    if (S.mode !== "papers") return "";

    let html = `<div class="ps-retrieval-note">`;

    if (plan && plan.rewritten && (plan.terms || []).length) {
      const terms = plan.terms.slice(0, 5).join(" · ");
      html += `<span class="ps-rn-label">检索式</span><span class="ps-rn-query">${esc(terms)}</span>`;
      if ((plan.synonyms || []).length) {
        html += `<span class="ps-rn-chip">+${plan.synonyms.length} 个同义表达</span>`;
      }
    } else if (plan && plan.raw) {
      html += `<span class="ps-rn-label">检索式</span><span class="ps-rn-query">${esc(plan.raw)}</span>`;
      if (plan.note) html += `<span class="ps-rn-chip">${esc(plan.note)}</span>`;
    }

    for (const s of cov) {
      const cls = s.ok ? "is-ok" : "is-off";
      // 不可用的源只留一个 ✕：折叠侧栏只有 280px 宽，「不可用」三个字会把徽标挤成三行
      const cnt = s.ok ? ` ${s.hits || s.used || 0}` : " ✕";
      html += `<span class="ps-rn-chip ${cls}" title="${esc(s.note || s.label)}">${esc(s.label)}${cnt}</span>`;
    }

    if (S.degraded && S.degraded.length) {
      // 完整原因挂 title：侧栏折叠时只有 280px 宽，全铺开会吃掉可见列表区
      const parts = S.degraded.map((d) => `${d.source}：${d.reason}`);
      html += `<span class="ps-rn-degrade" title="${esc(parts.join("；"))}">${S.degraded.length} 个源不可用 · 悬停看原因</span>`;
    }

    html += `</div>`;
    return html;
  }

  // ── 渲染搜索内容 ──
  function render() {
    ensureNav();
    const libraryPanel = root.querySelector("#lit-library-panel");
    if (libraryPanel && !libraryPanel.getAttribute("data-active-view")) {
      libraryPanel.setAttribute("data-active-view", S.activeView);
    }

    const c = ensureContainer();
    if (!c) return;

    let html = "";

    // 搜索栏
    html += `<div class="ps-search-bar">
      <input type="search" id="ps-query" placeholder="搜索全球论文 / 学者 / 期刊…" value="${esc(S.query)}" autocomplete="off">
      <button class="ps-search-btn-primary" id="ps-search-btn" type="button">搜索</button>
    </div>`;

    // Tab 栏
    html += `<div class="ps-tab-bar">
      <button class="ps-tab${S.mode === "papers" ? " active" : ""}" data-ps-tab="papers">论文</button>
      <button class="ps-tab${S.mode === "authors" ? " active" : ""}" data-ps-tab="authors">学者</button>
    </div>`;

    // 筛选（仅论文模式）
    if (S.mode === "papers") {
      html += `<div class="ps-filters">
        <select id="ps-sort" title="排序">
          <option value=""${S.sort === "" ? " selected" : ""}>相关度</option>
          <option value="citationCount:desc"${S.sort === "citationCount:desc" ? " selected" : ""}>引用数 ↓</option>
          <option value="publicationDate:desc"${S.sort === "publicationDate:desc" ? " selected" : ""}>最新发表</option>
        </select>
        <input type="number" id="ps-year" placeholder="年份" min="1900" max="2030" style="width:72px" value="${S.year}">
        <label><input type="checkbox" id="ps-oa"${S.openAccess ? " checked" : ""}> OA</label>
        <input type="number" id="ps-mincite" placeholder="最少引用" min="0" style="width:76px" value="${S.minCitations || ""}">
      </div>`;
    }

    // 面包屑（学者论文模式）
    if (S.mode === "author-papers" && S.authorDetail) {
      html += `<div class="ps-breadcrumb">
        <a id="ps-back-authors">← 学者搜索</a> &gt; ${esc(S.authorDetail.name)} 的论文
      </div>`;
    }

    // 结果列表
    html += `<div class="ps-results" id="ps-results">`;

    if (S.loading) {
      html += `<div class="ps-loading">正在搜索学术资源…</div>`;
    } else if (S.mode === "papers" || S.mode === "author-papers") {
      if (S.mode === "papers" && S.papers.length) html += retrievalNote();
      if (S.papers.length === 0) {
        html += `<div class="ps-empty">${
          S.query ? "没有找到相关论文，请尝试放宽检索词" : "输入关键词、DOI 或论文名，开始检索全球论文"
        }</div>`;
      } else {
        for (const p of S.papers) {
          html += paperCard(p);
        }
        if (S.papers.length < S.total) {
          html += `<button class="ps-load-more" id="ps-more">加载更多（已显示 ${S.papers.length} / ${S.total}）</button>`;
        }
      }
    } else if (S.mode === "authors") {
      if (S.authors.length === 0) {
        html += `<div class="ps-empty">${S.query ? "没有找到相关学者" : "输入学者姓名开始检索全球权威学者"}</div>`;
      } else {
        for (const a of S.authors) {
          html += authorCard(a);
        }
        if (S.authors.length < S.total) {
          html += `<button class="ps-load-more" id="ps-more">加载更多</button>`;
        }
      }
    }

    html += `</div>`;
    c.innerHTML = html;
    bindEvents();
  }

  const SRC_LABELS = {
    europepmc: "Europe PMC",
    semantic_scholar: "S2",
    arxiv: "arXiv",
    openalex: "OpenAlex",
    crossref: "Crossref",
  };

  function paperCard(p) {
    const authorStr = (p.authors || []).slice(0, 3).map((a) => esc(a.name)).join(", ") +
      (p.authors && p.authors.length > 3 ? " et al." : "");
    const badges = [];
    if (p.year) badges.push(`<span class="ps-badge ps-badge-year">${p.year}</span>`);
    if (p.citationCount > 0) badges.push(`<span class="ps-badge ps-badge-cite">${p.citationCount} 引用</span>`);
    if (p.isOpenAccess) badges.push(`<span class="ps-badge ps-badge-oa">OA</span>`);
    const srcs = (p.sources || (p.source ? [p.source] : []))
      .map((s) => SRC_LABELS[s] || s)
      .filter(Boolean);
    if (srcs.length) badges.push(`<span class="ps-badge ps-badge-src">${esc(srcs.join("+"))}</span>`);

    const reasons = (p.reasons || []).length
      ? `<div class="ps-card-reasons">${p.reasons.map((r) => `<span>${esc(r)}</span>`).join("")}</div>`
      : "";

    return `<div class="ps-card" data-paper-id="${esc(p.paperId)}">
      <div class="ps-card-title">${esc(p.title)}</div>
      <div class="ps-card-meta">
        <span>${authorStr}</span>
        ${p.venue ? `<span>· ${esc(p.venue)}</span>` : ""}
        ${badges.join("")}
      </div>
      ${p.abstract ? `<div class="ps-card-abstract">${esc(p.abstract)}</div>` : ""}
      ${reasons}
    </div>`;
  }

  function authorCard(a) {
    const affs = (a.affiliations || []).slice(0, 2).join(", ");
    return `<div class="ps-author-card" data-author-id="${esc(a.authorId)}">
      <div class="ps-author-name">${esc(a.name)}</div>
      <div class="ps-author-info">
        ${affs ? esc(affs) + " · " : ""}${a.paperCount} 篇论文 · ${a.citationCount} 次引用 · h-index=${a.hIndex}
      </div>
    </div>`;
  }

  // ── 事件 ──
  function bindEvents() {
    const c = ensureContainer();
    if (!c) return;

    const searchInput = c.querySelector("#ps-query");
    const searchBtn = c.querySelector("#ps-search-btn");

    if (searchInput) {
      searchInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          doSearch();
        }
      });
    }
    if (searchBtn) searchBtn.addEventListener("click", () => doSearch());

    // Tabs
    c.querySelectorAll("[data-ps-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        S.mode = btn.dataset.psTab;
        S.offset = 0;
        S.papers = [];
        S.authors = [];
        S.total = 0;
        S.coverage = [];
        S.degraded = [];
        S.plan = null;
        if (S.query) doSearch();
        else render();
      });
    });

    // Filters
    const sortSel = c.querySelector("#ps-sort");
    if (sortSel) sortSel.addEventListener("change", () => { S.sort = sortSel.value; doSearch(); });
    const yearInput = c.querySelector("#ps-year");
    if (yearInput) yearInput.addEventListener("change", () => { S.year = yearInput.value; doSearch(); });
    const oaCheck = c.querySelector("#ps-oa");
    if (oaCheck) oaCheck.addEventListener("change", () => { S.openAccess = oaCheck.checked; doSearch(); });
    const mcInput = c.querySelector("#ps-mincite");
    if (mcInput) mcInput.addEventListener("change", () => { S.minCitations = parseInt(mcInput.value) || 0; doSearch(); });

    // Load more
    const moreBtn = c.querySelector("#ps-more");
    if (moreBtn) moreBtn.addEventListener("click", loadMore);

    // Paper cards → detail：直接传搜索结果里已完整的 paper 对象，避免再用
    // Europe PMC 数字 id 调详情接口（该 id 语义无关，会被 get_paper_detail 判成 404）
    c.querySelectorAll("[data-paper-id]").forEach((card) => {
      card.addEventListener("click", () => {
        const p = S.papers.find((x) => x && x.paperId === card.dataset.paperId);
        if (p) showPaperDetail(p);
      });
    });

    // Author cards → author papers
    c.querySelectorAll("[data-author-id]").forEach((card) => {
      card.addEventListener("click", () => {
        const a = S.authors.find((x) => x.authorId === card.dataset.authorId);
        if (a) loadAuthorPapers(a);
      });
    });

    // Back to authors
    const backBtn = c.querySelector("#ps-back-authors");
    if (backBtn) {
      backBtn.addEventListener("click", () => {
        S.mode = "authors";
        S.papers = [];
        S.authorDetail = null;
        doSearch();
      });
    }
  }

  // ── 搜索 ──
  async function doSearch(append = false) {
    const c = ensureContainer();
    if (!c) return;
    const input = c.querySelector("#ps-query");
    if (input) S.query = input.value.trim();
    if (!S.query) return;
    if (!append) {
      S.offset = 0;
      S.papers = [];
      S.authors = [];
    }

    S.loading = true;
    render();

    try {
      if (S.mode === "papers") {
        const params = new URLSearchParams({
          q: S.query,
          offset: String(S.offset),
          limit: "20",
        });
        if (S.year) params.set("year", S.year);
        if (S.openAccess) params.set("open_access", "true");
        if (S.minCitations > 0) params.set("min_citations", String(S.minCitations));
        if (S.sort) params.set("sort", S.sort);

        const data = await window.api(`/api/search/papers?${params}`);
        const raw = data.papers || [];
        if (append) {
          // 跨页去重：多源融合后，同一篇可能在不同页被不同源再次召回
          const seen = new Set(S.papers.map(paperKey));
          for (const p of raw) {
            const k = paperKey(p);
            if (k && seen.has(k)) continue;
            if (k) seen.add(k);
            S.papers.push(p);
          }
        } else {
          S.papers = raw.slice();
          // 检索说明只在首页取，翻页时保留（避免重复渲染与状态抖动）
          S.coverage = data.sources || [];
          S.degraded = data.degraded || [];
          S.plan = data.query_plan || null;
          S.pipeline = data.pipeline || "";
        }
        S.total = data.total || 0;
        // 按服务端真实返回条数推进游标，去重不会导致翻页原地打转
        S.offset = append ? S.offset + raw.length : raw.length;
      } else if (S.mode === "authors") {
        const data = await window.api(`/api/search/authors?q=${encodeURIComponent(S.query)}&offset=${S.offset}&limit=20`);
        if (append) {
          S.authors.push(...(data.authors || []));
        } else {
          S.authors = data.authors || [];
        }
        S.total = data.total || 0;
        S.offset = S.authors.length;
      }
    } catch (err) {
      if (window.showToast) window.showToast("搜索失败：" + (err.message || err), { variant: "error" });
    } finally {
      S.loading = false;
      render();
    }
  }

  function loadMore() {
    doSearch(true);
  }

  async function loadAuthorPapers(author) {
    S.mode = "author-papers";
    S.authorDetail = { authorId: author.authorId, name: author.name };
    S.papers = [];
    S.offset = 0;
    S.total = 0;
    S.loading = true;
    render();

    try {
      const data = await window.api(`/api/search/author-papers?author_id=${encodeURIComponent(author.authorId)}&offset=0&limit=20`);
      S.papers = data.papers || [];
      S.total = data.total || 0;
      S.offset = S.papers.length;
    } catch (err) {
      if (window.showToast) window.showToast("获取学者论文失败", { variant: "error" });
    } finally {
      S.loading = false;
      render();
    }
  }

  // ── 论文详情弹窗 ──
  async function showPaperDetail(paper) {
    if (!paper) return;

    // 搜索结果里的 paper 已经含 title/abstract/authors/doi/venue/pdfUrl 等完整信息，
    // 直接渲染，不依赖详情接口（详情接口只认 S2 id / DOI，Europe PMC 数字 id 会 404）。
    S.detailPaper = paper;
    renderDetailOverlay(paper);

    // 已有 TL;DR（或 arXiv 源没有 TL;DR / 参考文献概念）就不再补拉
    if (paper.tldr || paper.source === "arxiv") return;

    // 缺 TL;DR / 参考文献时，用 DOI（其次 arXiv id）精确补拉一次；失败静默，不阻塞已展示的详情。
    // 注意不能用 paperId：Europe PMC 的数字 id 无法被详情接口识别。
    const probeId = paper.doi || paper.arxivId || "";
    if (!probeId) return;
    try {
      const data = await window.api(`/api/search/paper-detail?id=${encodeURIComponent(probeId)}`);
      if (data && data.paper) {
        // 用搜索结果的字段为主（尤其 pdfUrl 是 Europe PMC 直链，优于 S2 返回的 NCBI HTML 页），
        // 只从补拉结果里吸收 TL;DR / 参考文献 / 近期引用等扩展信息。
        const ext = data.paper;
        const merged = Object.assign({}, ext, paper, {
          tldr: ext.tldr || paper.tldr || "",
          referenceCount: ext.referenceCount || paper.referenceCount || 0,
          recentCitations: ext.recentCitations || paper.recentCitations || [],
        });
        S.detailPaper = merged;
        renderDetailOverlay(merged);
      }
    } catch (err) {
      // 详情已完整展示，补拉失败不打断用户
    }
  }

  function renderDetailOverlay(paper) {
    let overlay = document.getElementById("ps-detail-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "ps-detail-overlay";
      overlay.className = "ps-detail-overlay";
      document.body.appendChild(overlay);
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) closeDetail();
      });
    }
    overlay.style.display = "flex";

    if (!paper) {
      overlay.innerHTML = `<div class="ps-detail-panel"><div class="ps-loading">加载中…</div></div>`;
      return;
    }

    const authorStr = (paper.authors || []).map((a) => esc(a.name)).join(", ");
    const badges = [];
    if (paper.year) badges.push(`<span class="ps-badge ps-badge-year">${paper.year}</span>`);
    if (paper.citationCount > 0) badges.push(`<span class="ps-badge ps-badge-cite">${paper.citationCount} 引用</span>`);
    if (paper.isOpenAccess) badges.push(`<span class="ps-badge ps-badge-oa">OA</span>`);
    if (paper.influentialCitationCount > 0) badges.push(`<span class="ps-badge ps-badge-cite">${paper.influentialCitationCount} 高影响力引用</span>`);

    let html = `<div class="ps-detail-panel">
      <button class="ps-detail-close" id="ps-detail-close">&times;</button>
      <div class="ps-detail-title">${esc(paper.title)}</div>
      <div class="ps-detail-meta">
        <span>${authorStr}</span>
        ${paper.venue ? `<span>· ${esc(paper.venue)}</span>` : ""}
        ${badges.join("")}
      </div>`;

    if (paper.tldr) {
      html += `<div class="ps-detail-section"><h4>TL;DR (核心要点)</h4><p>${esc(paper.tldr)}</p></div>`;
    }
    if (paper.abstract) {
      html += `<div class="ps-detail-section"><h4>摘要</h4><p>${esc(paper.abstract)}</p></div>`;
    }
    if (paper.fieldsOfStudy && paper.fieldsOfStudy.length) {
      html += `<div class="ps-detail-section"><h4>研究领域</h4><p>${paper.fieldsOfStudy.map((f) => esc(f)).join(" · ")}</p></div>`;
    }
    if (paper.doi) {
      html += `<div class="ps-detail-section"><h4>DOI</h4><p><a href="https://doi.org/${esc(paper.doi)}" target="_blank" rel="noopener" style="color:var(--green)">${esc(paper.doi)}</a></p></div>`;
    }
    if (paper.recentCitations && paper.recentCitations.length) {
      html += `<div class="ps-detail-section"><h4>近期引用（共 ${paper.referenceCount || "?"} 篇参考文献）</h4>`;
      for (const c of paper.recentCitations.slice(0, 5)) {
        html += `<p style="margin-bottom:4px">· ${esc(c.title)} ${c.year ? `(${c.year})` : ""}</p>`;
      }
      html += `</div>`;
    }

    // Actions
    html += `<div class="ps-detail-actions">`;
    if (paper.pdfUrl) {
      html += `<a href="${esc(paper.pdfUrl)}" target="_blank" rel="noopener" class="ps-primary">打开 PDF</a>`;
    }
    html += `<button id="ps-import-to-knoworigin" class="ps-primary" data-pdf="${esc(paper.pdfUrl || "")}" data-title="${esc(paper.title)}">＋ 导入到知源文献库</button>`;
    if (paper.doi) {
      html += `<a href="https://doi.org/${esc(paper.doi)}" target="_blank" rel="noopener">DOI 链接</a>`;
    }
    if (paper.arxivId) {
      html += `<a href="https://arxiv.org/abs/${esc(paper.arxivId)}" target="_blank" rel="noopener">arXiv</a>`;
    }
    html += `</div></div>`;

    overlay.innerHTML = html;

    overlay.querySelector("#ps-detail-close").addEventListener("click", closeDetail);
    const importBtn = overlay.querySelector("#ps-import-to-knoworigin");
    if (importBtn) {
      importBtn.addEventListener("click", () => importToKnowOrigin(paper));
    }
  }

  function closeDetail() {
    const overlay = document.getElementById("ps-detail-overlay");
    if (overlay) overlay.style.display = "none";
    S.detailPaper = null;
  }

  // ── 导入到知源 ──
  function ensureImportProgress() {
    const overlay = document.getElementById("ps-detail-overlay");
    if (!overlay) return null;
    let el = overlay.querySelector("#ps-import-progress");
    if (!el) {
      const actions = overlay.querySelector(".ps-detail-actions");
      el = document.createElement("div");
      el.id = "ps-import-progress";
      el.className = "ps-import-progress";
      el.innerHTML = `
        <div class="ps-import-stage">正在准备…</div>
        <div class="ps-import-bar"><div class="ps-import-bar-fill"></div></div>
        <div class="ps-import-pct"></div>`;
      if (actions) {
        actions.insertAdjacentElement("beforebegin", el);
      } else {
        const panel = overlay.querySelector(".ps-detail-panel");
        if (panel) panel.appendChild(el);
      }
    }
    return el;
  }

  function setImportStage(el, text) {
    if (el) el.querySelector(".ps-import-stage").textContent = text;
  }

  function setImportProgress(el, done, total) {
    if (!el) return;
    if (total > 0) {
      el.classList.remove("is-indeterminate");
      const pct = Math.min(100, Math.round((done / total) * 100));
      el.querySelector(".ps-import-bar-fill").style.width = pct + "%";
      el.querySelector(".ps-import-pct").textContent = pct + "%";
    } else {
      el.classList.add("is-indeterminate");
      el.querySelector(".ps-import-pct").textContent = "";
    }
  }

  function markImportError(el, message) {
    if (!el) return;
    el.classList.remove("is-indeterminate");
    el.classList.add("is-error");
    el.querySelector(".ps-import-stage").textContent = message || "导入失败";
    el.querySelector(".ps-import-bar-fill").style.width = "100%";
    el.querySelector(".ps-import-pct").textContent = "导入失败";
  }

  function markImportDone(el) {
    if (!el) return;
    el.classList.remove("is-indeterminate");
    el.classList.add("is-done");
    el.querySelector(".ps-import-stage").textContent = "已导入 ✓";
    el.querySelector(".ps-import-bar-fill").style.width = "100%";
    el.querySelector(".ps-import-pct").textContent = "完成";
  }

  async function importToKnowOrigin(paper) {
    if (!paper) return;

    if (!paper.pdfUrl) {
      if (window.showToast) window.showToast("该论文暂无开放获取 PDF，可点击 DOI 链接访问原文下载后导入。", { variant: "warning" });
      return;
    }

    // 不关闭详情弹窗，就在弹窗里实时显示「下载→解析→入库」进度
    const prog = ensureImportProgress();
    setImportStage(prog, "正在下载 PDF…");
    prog.classList.add("is-indeterminate");

    const finishOk = () => {
      markImportDone(prog);
      if (window.showToast) window.showToast("已成功导入到「我的文献」：" + (paper.title || "论文"), { variant: "success" });
      if (window.KnowOriginLiterature && window.KnowOriginLiterature.refresh) {
        window.KnowOriginLiterature.refresh();
      }
      // 短暂停留让用户看到「已导入」，再平滑切回「我的文献」
      setTimeout(() => { closeDetail(); switchView("library"); }, 800);
    };

    try {
      const resp = await fetch("/api/search/import-paper", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pdf_url: paper.pdfUrl,
          title: paper.title,
          doi: paper.doi || "",
          authors: (paper.authors || []).map((a) => a.name).join(", "),
        }),
      });

      // 非流式错误（401 / 422 缺链接等），此时还没进入 SSE
      if (!resp.ok) {
        let msg = "";
        try {
          const j = await resp.json();
          msg = (j.detail && j.detail.message) || j.message || "";
        } catch (e) { /* ignore */ }
        throw new Error(msg || `请求失败（${resp.status}）`);
      }
      if (!resp.body) throw new Error("浏览器不支持流式读取");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let finished = false;

      const processEvent = (evt) => {
        if (!evt || !evt.type) return;
        if (evt.type === "progress") {
          setImportProgress(prog, evt.done, evt.total);
        } else if (evt.type === "stage") {
          setImportStage(prog, evt.message || "");
        } else if (evt.type === "error") {
          throw new Error(evt.message || "导入失败");
        } else if (evt.type === "done") {
          finished = true;
        }
      };

      const feed = (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          let evt;
          try { evt = JSON.parse(dataLine.slice(6)); } catch (e) { continue; }
          processEvent(evt);
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        feed(decoder.decode(value, { stream: true }));
      }
      feed(decoder.decode()); // flush 末尾残留

      if (finished) finishOk();
      else markImportError(prog, "导入中断：服务未返回完成信号");
    } catch (err) {
      markImportError(prog, (err && err.message) || "导入失败");
    }
  }

  // ── 首次启动与可见性监听 ──
  function init() {
    ensureNav();
    ensureContainer();
    const libraryPanel = root.querySelector("#lit-library-panel");
    if (libraryPanel && !libraryPanel.getAttribute("data-active-view")) {
      libraryPanel.setAttribute("data-active-view", S.activeView);
    }
    updateLibraryCountBadge();
  }

  // 监听文献工作区与库面板的可见性变动
  const rootObserver = new MutationObserver(() => {
    if (!root.classList.contains("hidden")) {
      init();
    }
  });
  rootObserver.observe(root, { attributes: true, attributeFilter: ["class"] });

  // 监听本地文献列表变动，自动同步数字徽标
  const listObserver = new MutationObserver(() => {
    updateLibraryCountBadge();
  });
  const litList = root.querySelector("#lit-list");
  if (litList) {
    listObserver.observe(litList, { childList: true });
  }

  if (!root.classList.contains("hidden")) {
    init();
  }

  // 导出接口供外部或控制台排查
  window.KnowOriginPaperSearch = {
    switchView,
    toggleAsideExpand,
    refreshBadge: updateLibraryCountBadge,
  };
})();
