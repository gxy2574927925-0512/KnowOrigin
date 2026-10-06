/* ==================== PRISMA 结构化系统综述矩阵前端组件 ====================
   对标：Elicit (Systematic Review Matrix) + Cochrane PRISMA 2020 规范
   独立 IIFE 注入，不碰 app.js / styles.css。
   ========================================================================== */

(function () {
  "use strict";

  const MODAL_ID = "ko-matrix-modal";
  const STYLE_ID = "ko-matrix-style";

  const S = {
    projectId: null,
    matrices: [],
    currentMatrix: null,
    loading: false,
    selectedSources: new Set(),
    sources: [], // [{ id, title, authors, year, venue, type }]
    isMaximized: false,
  };

  // app.js 的 state 是顶层 const（不挂在 window 上），跨脚本只能裸引用；
  // 旧代码直接调用未定义的 _koGlobalState() 会抛 ReferenceError，弹窗打不开。
  function _koGlobalState() {
    try {
      if (typeof state !== "undefined" && state) return state;
    } catch (_) {}
    return {};
  }

  function esc(val) {
    if (typeof window.escapeHtml === "function") return window.escapeHtml(val);
    return String(val == null ? "" : val).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c] || c));
  }

  function notify(msg, variant = "info") {
    if (typeof window.showToast === "function") {
      try { window.showToast(msg, { variant }); } catch (_) {}
    } else {
      console.log(`[Matrix ${variant}]:`, msg);
    }
    showInternalToast(msg, variant);
  }

  function showInternalToast(msg, variant = "info") {
    let box = document.getElementById("ko-matrix-toast-wrap");
    if (!box) {
      box = document.createElement("div");
      box.id = "ko-matrix-toast-wrap";
      box.style.cssText = "position:fixed; top:24px; left:50%; transform:translateX(-50%); z-index:100005; display:flex; flex-direction:column; gap:8px; pointer-events:none; transition:all 0.2s ease;";
      document.body.appendChild(box);
    }
    const toastEl = document.createElement("div");
    const bgMap = {
      error: "background:#e24b4a; color:#fff; border:1px solid rgba(255,255,255,0.2);",
      success: "background:#1d9e75; color:#0e1410; font-weight:600;",
      warning: "background:#e5a93c; color:#1a1300; font-weight:600;",
      info: "background:#2b2f3a; color:#f0f0f0; border:1px solid rgba(255,255,255,0.15);"
    };
    const iconMap = {
      error: "⚠️ ",
      success: "✅ ",
      warning: "⚡ ",
      info: "💡 "
    };
    toastEl.style.cssText = `padding: 10px 18px; border-radius: 8px; font-size: calc(13px * var(--font-scale, 1)); box-shadow: 0 8px 24px rgba(0,0,0,0.45); pointer-events:auto; display:flex; align-items:center; gap:8px; animation: koToastPop 0.22s cubic-bezier(0.18, 0.89, 0.32, 1.28); ${bgMap[variant] || bgMap.info}`;
    toastEl.innerHTML = `<span>${iconMap[variant] || ""}${esc(msg)}</span>`;
    box.appendChild(toastEl);
    setTimeout(() => {
      toastEl.style.opacity = "0";
      toastEl.style.transform = "translateY(-8px)";
      toastEl.style.transition = "all 0.25s ease";
      setTimeout(() => toastEl.remove(), 260);
    }, 3800);
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .ko-matrix-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 12px;
        font-size: calc(12px * var(--font-scale, 1));
        font-weight: 500;
        border-radius: 6px;
        border: 1px solid var(--line, rgba(255,255,255,0.15));
        background: var(--panel, #1e2025);
        color: var(--ink, #e0e0e0);
        cursor: pointer;
        transition: all 0.15s ease;
        white-space: nowrap;
        user-select: none;
      }
      .ko-matrix-btn:hover {
        background: var(--line, rgba(255,255,255,0.08));
        border-color: var(--green, #1d9e75);
      }
      .ko-matrix-btn.primary {
        background: var(--green, #1d9e75);
        color: #0e1410;
        font-weight: 600;
        border-color: transparent;
      }
      .ko-matrix-btn.primary:hover {
        opacity: 0.92;
        transform: translateY(-1px);
      }
      .ko-matrix-btn svg { width: 14px; height: 14px; stroke: currentColor; fill: none; flex-shrink: 0; }
      
      .ko-matrix-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.72);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        z-index: 9999;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        animation: koFadeIn 0.18s ease;
      }
      @keyframes koFadeIn {
        from { opacity: 0; transform: scale(0.98); }
        to { opacity: 1; transform: scale(1); }
      }
      .ko-matrix-dialog {
        background: var(--panel, #181a1f);
        color: var(--ink, #e0e0e0);
        border: 1px solid var(--line, rgba(255,255,255,0.15));
        border-radius: 12px;
        width: 95vw;
        max-width: 1320px;
        height: 88vh;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        box-shadow: 0 24px 60px rgba(0,0,0,0.55);
        transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .ko-matrix-dialog.maximized {
        width: 99vw;
        max-width: none;
        height: 98vh;
        border-radius: 6px;
      }
      .ko-matrix-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 20px;
        border-bottom: 1px solid var(--line, rgba(255,255,255,0.1));
        background: var(--panel, #181a1f);
        flex-shrink: 0;
      }
      .ko-matrix-header-title {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .ko-matrix-badge {
        font-size: calc(11px * var(--font-scale, 1));
        font-weight: 700;
        padding: 2px 7px;
        border-radius: 4px;
        background: rgba(29, 158, 117, 0.16);
        color: var(--green, #1d9e75);
        border: 1px solid rgba(29, 158, 117, 0.3);
        letter-spacing: 0.5px;
      }
      .ko-matrix-body {
        flex: 1;
        overflow-y: auto;
        padding: 20px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .ko-matrix-table-wrap {
        flex: 1;
        overflow-x: auto;
        overflow-y: auto;
        border: 1px solid var(--line, rgba(255,255,255,0.12));
        border-radius: 8px;
        background: rgba(0,0,0,0.22);
        position: relative;
      }
      .ko-matrix-table {
        width: 100%;
        border-collapse: separate;
        border-spacing: 0;
        font-size: calc(12px * var(--font-scale, 1));
        text-align: left;
      }
      .ko-matrix-table th {
        background: var(--panel, #20232a);
        padding: 11px 14px;
        font-weight: 600;
        border-bottom: 1px solid var(--line, rgba(255,255,255,0.18));
        border-right: 1px solid var(--line, rgba(255,255,255,0.08));
        white-space: nowrap;
        position: sticky;
        top: 0;
        z-index: 3;
        color: var(--ink, #fff);
      }
      .ko-matrix-table td {
        padding: 12px 14px;
        border-bottom: 1px solid var(--line, rgba(255,255,255,0.08));
        border-right: 1px solid var(--line, rgba(255,255,255,0.08));
        vertical-align: top;
        line-height: 1.55;
        color: var(--ink, #d8d8d8);
      }
      .ko-matrix-table tr:hover td {
        background: rgba(255,255,255,0.025);
      }
      .ko-matrix-sticky-col {
        position: sticky;
        left: 0;
        background: var(--panel, #181a1f);
        z-index: 2;
        font-weight: 600;
        border-right: 2px solid var(--line, rgba(255,255,255,0.15)) !important;
        box-shadow: 2px 0 8px rgba(0,0,0,0.2);
      }
      .ko-matrix-table th.ko-matrix-sticky-col {
        z-index: 4;
        background: var(--panel, #20232a);
      }
      .ko-matrix-summary-box {
        padding: 14px 18px;
        background: rgba(29, 158, 117, 0.08);
        border: 1px solid rgba(29, 158, 117, 0.28);
        border-radius: 8px;
        font-size: calc(13px * var(--font-scale, 1));
        line-height: 1.65;
        color: var(--ink, #e0e0e0);
      }
      .ko-matrix-summary-title {
        font-weight: 600;
        margin-bottom: 6px;
        color: var(--green, #1d9e75);
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .ko-matrix-tag-gap {
        display: inline-block;
        padding: 2px 6px;
        border-radius: 4px;
        background: rgba(226, 75, 74, 0.16);
        color: #fca5a5;
        font-size: calc(11px * var(--font-scale, 1));
        font-weight: 600;
        margin-bottom: 4px;
      }
      .ko-matrix-tag-metric {
        font-weight: 600;
        color: var(--green, #4ade80);
      }
      .ko-matrix-chips-row {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        margin-top: 6px;
      }
      .ko-matrix-chip-btn {
        font-size: calc(11px * var(--font-scale, 1));
        padding: 3px 8px;
        border-radius: 12px;
        border: 1px solid var(--line, rgba(255,255,255,0.12));
        background: rgba(255,255,255,0.03);
        color: var(--muted, #aaa);
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .ko-matrix-chip-btn:hover {
        border-color: var(--green, #1d9e75);
        color: var(--ink, #fff);
      }
    `;
    document.head.appendChild(style);
  }

  // 综合读取候选文献来源（从文献库、勾选项、当前阅读文献）
  async function gatherAvailableSources() {
    const list = [];
    const seen = new Set();

    // 1. 如果在文献库模式且暴露了选区
    const litBridge = window.KnowOriginLiterature;
    const selectedIds = litBridge && typeof litBridge.selectedIds === "function" ? litBridge.selectedIds() : [];

    // 2. 调取用户文献库全量
    try {
      const res = await fetch("/api/literature").then((r) => (r.ok ? r.json() : { literature: [] }));
      const lits = res.literature || [];
      for (const item of lits) {
        const p = item.project || {};
        const meta = item.meta || {};
        const pid = p.project_id;
        if (!pid || seen.has(pid)) continue;
        seen.add(pid);
        list.push({
          id: pid,
          title: meta.title || p.subject || "未命名文献",
          authors: meta.authors || "",
          year: meta.year || "",
          venue: meta.venue || "",
          isLit: true,
          isSelected: selectedIds.includes(pid),
        });
      }
    } catch (_) {}

    // 3. 如果当前正处于某门课程项目下，且有 project sources
    const g = _koGlobalState();
    if (g.currentProjectId) {
      try {
        const pRes = await fetch(`/api/projects/${g.currentProjectId}`).then((r) => (r.ok ? r.json() : {}));
        const sList = pRes.sources || [];
        for (const s of sList) {
          if (!s.source_id || seen.has(s.source_id)) continue;
          seen.add(s.source_id);
          list.push({
            id: s.source_id,
            title: s.filename || "项目资料",
            authors: "",
            year: "",
            venue: pRes.project?.subject || "课程资料",
            isLit: false,
            isSelected: false,
          });
        }
      } catch (_) {}
    }

    S.sources = list;
    return list;
  }

  function fetchMatrices() {
    const g = _koGlobalState();
    const pid = g.currentProjectId || "all";
    return fetch(`/api/research/matrix/${pid}`)
      .then((r) => (r.ok ? r.json() : { matrices: [] }))
      .then((data) => {
        S.matrices = data.matrices || [];
        return S.matrices;
      })
      .catch(() => []);
  }

  function openMatrixModal() {
    injectStyles();
    S.loading = true;
    renderModal();

    Promise.all([gatherAvailableSources(), fetchMatrices()]).then(([sources]) => {
      S.loading = false;
      S.selectedSources.clear();

      // 默认优先选中已勾选的；若无勾选，则默认勾选前 2~4 篇
      const preSelected = sources.filter((s) => s.isSelected);
      if (preSelected.length) {
        preSelected.forEach((s) => S.selectedSources.add(s.id));
      } else {
        sources.slice(0, 4).forEach((s) => S.selectedSources.add(s.id));
      }

      renderModal();
    });
  }

  function renderModal() {
    let overlay = document.getElementById(MODAL_ID);
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = MODAL_ID;
      overlay.className = "ko-matrix-overlay";
      document.body.appendChild(overlay);
    }

    const current = S.currentMatrix;

    overlay.innerHTML = `
      <div class="ko-matrix-dialog ${S.isMaximized ? "maximized" : ""}">
        <div class="ko-matrix-header">
          <div class="ko-matrix-header-title">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <line x1="3" y1="9" x2="21" y2="9"/>
              <line x1="3" y1="15" x2="21" y2="15"/>
              <line x1="9" y1="3" x2="9" y2="21"/>
              <line x1="15" y1="3" x2="15" y2="21"/>
            </svg>
            <strong style="font-size: calc(14px * var(--font-scale, 1));">PRISMA 结构化系统综述矩阵</strong>
            <span class="ko-matrix-badge">PRISMA 2020 准则</span>
          </div>

          <div style="display: flex; gap: 8px; align-items: center;">
            ${
              current
                ? `<button class="ko-matrix-btn" id="ko-matrix-export-csv" title="导出 Excel/Origin 标准 CSV (带 UTF-8 BOM，不乱码)">
                     <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                     导出 CSV
                   </button>
                   <button class="ko-matrix-btn" id="ko-matrix-new-btn">＋ 新矩阵</button>`
                : ""
            }
            <button class="ko-matrix-btn" id="ko-matrix-max-btn" title="${S.isMaximized ? "还原" : "全屏"}">
              ${
                S.isMaximized
                  ? `<svg viewBox="0 0 24 24"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/></svg>`
                  : `<svg viewBox="0 0 24 24"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`
              }
            </button>
            <button class="ko-matrix-btn" id="ko-matrix-close" style="padding: 4px 10px; font-size: calc(14px * var(--font-scale, 1));">✕</button>
          </div>
        </div>

        <div class="ko-matrix-body">
          ${
            S.loading
              ? renderLoadingView()
              : current
              ? renderMatrixView(current)
              : renderCreateView()
          }
        </div>
      </div>
    `;

    bindModalEvents(overlay);
  }

  function renderLoadingView() {
    const selectedList = S.sources.filter((s) => S.selectedSources.has(s.id));
    return `
      <div style="text-align:center; padding: 46px 20px; max-width: 640px; margin: 0 auto;">
        <div style="position:relative; width: 54px; height: 54px; margin: 0 auto 18px;">
          <div style="position:absolute; inset:0; border: 3px solid rgba(29, 158, 117, 0.2); border-radius: 50%;"></div>
          <div style="position:absolute; inset:0; border: 3px solid var(--green, #1d9e75); border-top-color: transparent; border-radius: 50%; animation: koSpin 0.9s linear infinite;"></div>
        </div>
        <div style="font-size: calc(16px * var(--font-scale, 1)); font-weight: 600; color: var(--ink, #fff); margin-bottom: 8px;">
          正在横向研读所选文献并抽取 PRISMA 综述矩阵…
        </div>
        <div style="font-size: calc(13px * var(--font-scale, 1)); color: var(--muted, #888); line-height: 1.6; margin-bottom: 22px;">
          对标国际系统综述规范，深度提炼科学问题、搭建搭建/光路架构、带量纲物理指标与 Research Gap
        </div>

        <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--line, rgba(255,255,255,0.1)); border-radius: 10px; padding: 14px 16px; text-align: left; margin-bottom: 20px;">
          <div style="font-size: calc(12px * var(--font-scale, 1)); font-weight: 600; color: var(--green, #1d9e75); margin-bottom: 10px; display: flex; align-items: center; gap: 6px;">
            <span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:currentColor; animation:koPulse 1.2s infinite;"></span>
            纳入本次矩阵分析的文献（共 ${selectedList.length || S.selectedSources.size} 篇）：
          </div>
          <div style="display: flex; flex-direction: column; gap: 6px; max-height: 140px; overflow-y: auto;">
            ${(selectedList.length ? selectedList : Array.from(S.selectedSources).map(id => ({ title: id }))).map(s => `
              <div style="font-size: calc(12px * var(--font-scale, 1)); color: var(--ink, #ccc); display: flex; align-items: center; gap: 6px;">
                <span style="color: var(--green, #1d9e75);">📄</span>
                <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(s.title || s.id)}</span>
              </div>
            `).join('')}
          </div>
        </div>

        <div style="font-size: calc(12px * var(--font-scale, 1)); color: var(--muted, #666);">
          大模型深入长文本分析通常耗时 5~15 秒，请稍候片刻…
        </div>
      </div>
      <style>
        @keyframes koSpin { 100% { transform: rotate(360deg); } }
        @keyframes koPulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.85); } }
      </style>
    `;
  }

  function renderCreateView() {
    const listHtml = S.sources
      .map(
        (s) => `
        <label style="display: flex; align-items: center; gap: 10px; font-size: calc(12px * var(--font-scale, 1)); padding: 8px 10px; border-radius: 6px; background: rgba(255,255,255,0.03); cursor: pointer; border: 1px solid var(--line, rgba(255,255,255,0.06)); transition: all 0.15s ease;">
          <input type="checkbox" value="${esc(s.id)}" ${S.selectedSources.has(s.id) ? "checked" : ""} class="ko-matrix-src-check" style="cursor: pointer;" />
          <div style="flex:1; overflow: hidden;">
            <div style="font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink, #fff);">${esc(s.title)}</div>
            <div style="font-size: calc(11px * var(--font-scale, 1)); color: var(--muted, #888); margin-top: 2px;">
              ${esc([s.authors, s.venue, s.year].filter(Boolean).join(" · ")) || "本地文献"}
            </div>
          </div>
        </label>
      `
      )
      .join("");

    const pastMatricesHtml = S.matrices.length
      ? `
      <div style="margin-top: 20px; border-top: 1px solid var(--line, rgba(255,255,255,0.1)); padding-top: 16px;">
        <div style="font-size: calc(12px * var(--font-scale, 1)); font-weight: 600; margin-bottom: 10px; color: var(--muted, #888);">已生成的历史综述矩阵档案：</div>
        <div style="display: flex; flex-direction: column; gap: 8px;">
          ${S.matrices
            .map(
              (m) => `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 9px 14px; background: rgba(255,255,255,0.02); border: 1px solid var(--line, rgba(255,255,255,0.08)); border-radius: 6px;">
              <div>
                <span style="font-weight: 500; font-size: calc(13px * var(--font-scale, 1)); color: var(--ink, #fff);">${esc(m.title)}</span>
                <span style="font-size: calc(11px * var(--font-scale, 1)); color: var(--muted, #777); margin-left: 8px;">(${m.rows?.length || 0} 篇文献 · ${m.created_at ? m.created_at.slice(0, 10) : ""})</span>
              </div>
              <div style="display: flex; gap: 6px;">
                <button class="ko-matrix-btn ko-matrix-load" data-id="${esc(m.matrix_id)}">查看矩阵</button>
                <button class="ko-matrix-btn ko-matrix-del" data-id="${esc(m.matrix_id)}" style="color: var(--red, #e24b4a);">删除</button>
              </div>
            </div>
          `
            )
            .join("")}
        </div>
      </div>
    `
      : "";

    return `
      <div style="max-width: 760px; margin: 0 auto; width: 100%;">
        <div style="background: rgba(29, 158, 117, 0.06); border: 1px solid rgba(29, 158, 117, 0.2); border-radius: 8px; padding: 12px 16px; margin-bottom: 16px;">
          <p style="font-size: calc(13px * var(--font-scale, 1)); line-height: 1.6; color: var(--ink, #d0d0d0); margin: 0;">
            对标 JHU Agent Laboratory / Cochrane PRISMA 2020 国际顶刊标准，横向比对选中文献的核心科学问题、搭建搭建/光路算法、测试边界条件、定量物理指标，并精准定位 <strong>Research Gap</strong>。
          </p>
        </div>

        <div style="display: flex; flex-direction: column; gap: 14px;">
          <div>
            <label style="display: block; font-size: calc(12px * var(--font-scale, 1)); font-weight: 600; margin-bottom: 6px; color: var(--ink, #fff);">
              研究焦点 / 综述主题 (选填，帮助模型聚焦)
            </label>
            <input id="ko-matrix-topic" type="text" placeholder="例如：穿戴式双dToF测距与语义感知 / 光致超声创面检测系统方案" 
                   style="width: 100%; padding: 9px 12px; font-size: calc(13px * var(--font-scale, 1)); background: rgba(0,0,0,0.25); border: 1px solid var(--line, rgba(255,255,255,0.15)); border-radius: 6px; color: var(--ink, #fff); box-sizing: border-box;" />
            <div class="ko-matrix-chips-row">
              <span style="font-size: calc(11px * var(--font-scale, 1)); color: var(--muted, #777); align-self: center;">快捷主题：</span>
              <button type="button" class="ko-matrix-chip-btn" data-chip="核心定量性能与指标超越幅度对比">定量指标对比</button>
              <button type="button" class="ko-matrix-chip-btn" data-chip="实验搭建光路与测试边界对比">实验搭建与测试边界</button>
              <button type="button" class="ko-matrix-chip-btn" data-chip="系统致命硬伤与潜在 Research Gap">Research Gap 挖掘</button>
            </div>
          </div>

          <div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
              <label style="font-size: calc(12px * var(--font-scale, 1)); font-weight: 600; color: var(--ink, #fff);">
                选择纳入矩阵的文献 (${S.selectedSources.size}/${S.sources.length} 已选，推荐 2~8 篇)
              </label>
              <button class="ko-matrix-btn" id="ko-matrix-select-all" style="padding: 2px 8px; font-size: calc(11px * var(--font-scale, 1));">
                ${S.selectedSources.size === S.sources.length ? "取消全选" : "全选当前文献"}
              </button>
            </div>
            <div style="max-height: 240px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--line, rgba(255,255,255,0.1)); border-radius: 6px; background: rgba(0,0,0,0.2);">
              ${listHtml || '<div style="padding: 20px; text-align: center; color: var(--muted, #666);">文献库暂无文献，请在左侧「＋ 导入论文」上传 PDF</div>'}
            </div>
          </div>

          <button class="ko-matrix-btn primary" id="ko-matrix-run-extract" style="justify-content: center; padding: 11px; font-size: calc(13px * var(--font-scale, 1)); margin-top: 6px;">
            一键自动生成 PRISMA 综述证据矩阵 🚀
          </button>
        </div>

        ${pastMatricesHtml}
      </div>
    `;
  }

  function renderMatrixView(m) {
    const columns = m.columns || [];
    const rows = m.rows || [];

    const ths = columns.map((c, i) => {
      const isSticky = i === 0 ? "ko-matrix-sticky-col" : "";
      return `<th class="${isSticky}" style="min-width: ${c.width || "160px"};">${esc(c.label)}</th>`;
    }).join("");

    const trs = rows
      .map(
        (r) => `
      <tr>
        <td class="ko-matrix-sticky-col" style="color: var(--ink, #fff); font-weight: 600;">${esc(r.title)}</td>
        <td>${esc(r.objective)}</td>
        <td>${esc(r.method_setup)}</td>
        <td>${esc(r.dataset_conditions)}</td>
        <td class="ko-matrix-tag-metric">${esc(r.quantitative_results)}</td>
        <td>${esc(r.baseline_comparison)}</td>
        <td>
          <span class="ko-matrix-tag-gap">Research Gap</span><br/>
          ${esc(r.limitations)}
        </td>
        <td style="color: var(--green, #6ee7b7);">${esc(r.key_takeaway)}</td>
      </tr>
    `
      )
      .join("");

    return `
      ${
        m.summary_md
          ? `<div class="ko-matrix-summary-box">
               <div class="ko-matrix-summary-title">
                 <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                 领域全景演进与共性空白综述：
               </div>
               <div style="white-space: pre-wrap;">${esc(m.summary_md)}</div>
             </div>`
          : ""
      }
      <div class="ko-matrix-table-wrap">
        <table class="ko-matrix-table">
          <thead><tr>${ths}</tr></thead>
          <tbody>${trs || '<tr><td colspan="8" style="text-align:center; padding: 30px;">矩阵中暂无数据</td></tr>'}</tbody>
        </table>
      </div>
    `;
  }

  function bindModalEvents(overlay) {
    const closeBtn = overlay.querySelector("#ko-matrix-close");
    if (closeBtn) closeBtn.onclick = () => overlay.remove();

    overlay.onclick = (e) => {
      if (e.target === overlay) overlay.remove();
    };

    const maxBtn = overlay.querySelector("#ko-matrix-max-btn");
    if (maxBtn) {
      maxBtn.onclick = () => {
        S.isMaximized = !S.isMaximized;
        renderModal();
      };
    }

    const newBtn = overlay.querySelector("#ko-matrix-new-btn");
    if (newBtn) {
      newBtn.onclick = () => {
        S.currentMatrix = null;
        renderModal();
      };
    }

    const exportBtn = overlay.querySelector("#ko-matrix-export-csv");
    if (exportBtn && S.currentMatrix) {
      exportBtn.onclick = () => {
        window.open(`/api/research/matrix/${S.currentMatrix.matrix_id}/export-csv`, "_blank");
        notify("正在导出带有 UTF-8 BOM 的标准学术 CSV 表格", "success");
      };
    }

    // 快捷主题填充
    overlay.querySelectorAll(".ko-matrix-chip-btn").forEach((chip) => {
      chip.onclick = () => {
        const input = overlay.querySelector("#ko-matrix-topic");
        if (input) input.value = chip.dataset.chip || "";
      };
    });

    const selectAllBtn = overlay.querySelector("#ko-matrix-select-all");
    if (selectAllBtn) {
      selectAllBtn.onclick = () => {
        if (S.selectedSources.size === S.sources.length) {
          S.selectedSources.clear();
        } else {
          S.sources.forEach((s) => S.selectedSources.add(s.id));
        }
        renderModal();
      };
    }

    overlay.querySelectorAll(".ko-matrix-src-check").forEach((ck) => {
      ck.onchange = (e) => {
        if (e.target.checked) S.selectedSources.add(e.target.value);
        else S.selectedSources.delete(e.target.value);
      };
    });

    const runBtn = overlay.querySelector("#ko-matrix-run-extract");
    if (runBtn) {
      runBtn.onclick = () => {
        if (!S.selectedSources.size) {
          if (S.sources && S.sources.length > 0) {
            S.sources.slice(0, 4).forEach((s) => S.selectedSources.add(s.id));
            notify("已自动为您选中文献，正在启动 PRISMA 抽取！", "info");
            renderModal();
          } else {
            notify("文献库暂无可用文献，请先在左侧上传或导入文献 PDF！", "warning");
            return;
          }
        }
        const topic = (overlay.querySelector("#ko-matrix-topic")?.value || "").trim();
        S.loading = true;
        renderModal();

        const g = _koGlobalState();
        fetch("/api/research/matrix/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project_id: g.currentProjectId || "global_research",
            paper_ids: Array.from(S.selectedSources),
            topic: topic,
          }),
        })
          .then(async (r) => {
            const data = await r.json().catch(() => ({}));
            if (!r.ok) {
              const msg = (typeof data.detail === "string" ? data.detail : (data.detail?.message || data.message)) || `HTTP ${r.status}`;
              throw new Error(msg);
            }
            return data;
          })
          .then((res) => {
            S.loading = false;
            if (res.matrix) {
              S.currentMatrix = res.matrix;
              fetchMatrices();
              notify("🎉 PRISMA 综述证据矩阵抽取完成！", "success");
            } else {
              const msg = (typeof res.detail === "string" ? res.detail : (res.detail?.message || res.message)) || "抽取失败，请稍后重试";
              notify(msg, "error");
            }
            renderModal();
          })
          .catch((err) => {
            S.loading = false;
            notify("抽取失败: " + (err.message || err), "error");
            renderModal();
          });
      };
    }

    overlay.querySelectorAll(".ko-matrix-load").forEach((btn) => {
      btn.onclick = () => {
        const id = btn.getAttribute("data-id");
        const found = S.matrices.find((m) => m.matrix_id === id);
        if (found) {
          S.currentMatrix = found;
          renderModal();
        }
      };
    });

    overlay.querySelectorAll(".ko-matrix-del").forEach((btn) => {
      btn.onclick = () => {
        const id = btn.getAttribute("data-id");
        if (!confirm("确定删除该综述矩阵吗？")) return;
        fetch(`/api/research/matrix/${id}`, { method: "DELETE" })
          .then((r) => r.json())
          .then(() => {
            fetchMatrices().then(() => {
              if (S.currentMatrix && S.currentMatrix.matrix_id === id) S.currentMatrix = null;
              renderModal();
              notify("已删除综述矩阵", "info");
            });
          });
      };
    });
  }

  // 注入触发按钮（同时支持文献库对比条、阅读器顶栏与全局工具栏）
  function injectTriggerButtons() {
    injectStyles();

    // 1. 文献库多文献研读栏注入「综述矩阵」胶囊按钮
    const targetGroup = document.querySelector(".lit-compare-pill-group") || document.querySelector(".lit-compare-bar");
    if (targetGroup && !document.getElementById("ko-matrix-compare-btn")) {
      const btn = document.createElement("button");
      btn.id = "ko-matrix-compare-btn";
      btn.className = "lit-cmp-pill-btn secondary-button";
      btn.type = "button";
      btn.innerHTML = `
        <span class="tb-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="3" x2="9" y2="21"/></svg></span>
        <span>综述矩阵</span>
      `;
      btn.title = "对标顶刊 PRISMA 规范，横向比对选中文献的核心指标与研究空白";
      btn.onclick = openMatrixModal;
      targetGroup.appendChild(btn);
    }

    // 顶栏快捷入口已按需求移除（2026-09-26）：综述矩阵只保留
    // 「多文献研读」栏的胶囊按钮这一个入口，勾选文献后从这里进。
  }

  function init() {
    injectTriggerButtons();
    // 观察 DOM 变化以自动重挂
    const obs = new MutationObserver(() => injectTriggerButtons());
    obs.observe(document.body, { childList: true, subtree: true });

    // 暴露供全局调用
    window.KnowOriginResearchMatrix = {
      open: openMatrixModal,
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
