/* ==================== 顶刊同行评审红队前端组件 ====================
   对标：Nature Communications、IEEE Transactions、Optica、NeurIPS 审稿指南
   独立 IIFE 注入，不碰 app.js / styles.css。
   ========================================================================== */

(function () {
  "use strict";

  const MODAL_ID = "ko-reviewer-modal";
  const LIB_BTN_ID = "ko-reviewer-lib-btn";
  const STYLE_ID = "ko-reviewer-style";

  const RState = {
    projectId: null,
    reviews: [],
    currentReview: null,
    loading: false,
    sources: [],
    activeTab: "review", // 'review' | 'create'
    isMaximized: false,
    selectedTargetId: "",
    draftTitle: "",
    draftContent: "",
    venueTier: "IEEE Trans / Optica 顶级期刊",
    authorNotes: "",
    venueTiers: [
      "Nature / Science 子刊",
      "IEEE Trans / Optica 顶级期刊",
      "NeurIPS / ICML / CVPR 顶会",
      "卓越行动计划国内顶刊",
      "硕士/博士开题与保研答辩",
    ],
  };

  function esc(val) {
    if (typeof window.escapeHtml === "function") return window.escapeHtml(val);
    return String(val == null ? "" : val).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c] || c));
  }

  function toast(msg, variant = "info") {
    if (typeof window.showToast === "function") {
      try { window.showToast(msg, { variant }); } catch (_) {}
    } else {
      console.log(`[Reviewer ${variant}]:`, msg);
    }
    showInternalToast(msg, variant);
  }

  function showInternalToast(msg, variant = "info") {
    let box = document.getElementById("ko-reviewer-toast-wrap");
    if (!box) {
      box = document.createElement("div");
      box.id = "ko-reviewer-toast-wrap";
      box.style.cssText = "position:fixed; top:24px; left:50%; transform:translateX(-50%); z-index:100010; display:flex; flex-direction:column; gap:8px; pointer-events:none; transition:all 0.2s ease;";
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
      success: "⚔️ ",
      warning: "⚡ ",
      info: "💡 "
    };
    toastEl.style.cssText = `padding: 10px 18px; border-radius: 8px; font-size: calc(13px * var(--font-scale, 1)); box-shadow: 0 8px 24px rgba(0,0,0,0.45); pointer-events:auto; display:flex; align-items:center; gap:8px; animation: koRevPop 0.22s cubic-bezier(0.18, 0.89, 0.32, 1.28); ${bgMap[variant] || bgMap.info}`;
    toastEl.innerHTML = `<span>${iconMap[variant] || ""}${esc(msg)}</span>`;
    box.appendChild(toastEl);
    setTimeout(() => {
      toastEl.style.opacity = "0";
      toastEl.style.transform = "translateY(-8px)";
      toastEl.style.transition = "all 0.25s ease";
      setTimeout(() => toastEl.remove(), 260);
    }, 3800);
  }

  function getGlobalState() {
    // app.js 的 state 是顶层 const（不挂在 window 上），跨脚本只能裸引用；
    // 旧实现调用不存在的 _koGlobalState() 会抛 ReferenceError，
    // 导致「审稿红队 / 顶刊审稿」按钮点了毫无反应。
    try {
      if (typeof state !== "undefined" && state) return state;
    } catch (_) {}
    return {};
  }

  function getCurrentReadingDoc() {
    const titleEl = document.getElementById("lit-reader-title");
    const titleText = titleEl ? titleEl.textContent.trim() : "";
    if (titleText && titleText !== "选择一篇文献开始精读" && !titleText.startsWith("选择一篇文献")) {
      const litBridge = window.KnowOriginLiterature;
      let docId = "";
      if (litBridge && typeof litBridge.selectedIds === "function") {
        const sel = litBridge.selectedIds();
        if (sel && sel.length > 0) docId = sel[0];
      }
      return {
        id: docId || "current_reading_doc",
        title: titleText,
        source_type: "literature"
      };
    }
    return null;
  }

  async function gatherAvailableSources() {
    const list = [];
    const seen = new Set();

    // 1. 尝试从全局文献体系取
    try {
      const res = await fetch("/api/literature");
      if (res.ok) {
        const data = await res.json();
        const items = data.items || data.documents || (Array.isArray(data) ? data : []);
        items.forEach((item) => {
          const id = item.doc_id || item.id || item.project_id;
          if (id && !seen.has(id)) {
            seen.add(id);
            list.push({
              id: id,
              title: item.title || item.name || item.filename || "未命名文献",
              year: item.year || item.meta?.year || "",
              authors: item.authors || item.meta?.authors || "",
              venue: item.venue || item.journal || "",
              source_type: "literature"
            });
          }
        });
      }
    } catch (_) {}

    // 2. 尝试从当前课程项目取
    const g = getGlobalState();
    const pid = g.currentProjectId;
    if (pid && pid !== "global_research") {
      try {
        const res = await fetch(`/api/projects/${pid}`);
        if (res.ok) {
          const data = await res.json();
          (data.sources || []).forEach((s) => {
            const id = s.source_id || s.id;
            if (id && !seen.has(id)) {
              seen.add(id);
              list.push({
                id: id,
                title: s.filename || s.title || "资料文档",
                year: "",
                authors: "",
                venue: "",
                source_type: "source"
              });
            }
          });
        }
      } catch (_) {}
    }

    // 3. 补充当前正在阅读的文献置顶
    const currentDoc = getCurrentReadingDoc();
    if (currentDoc) {
      const existing = list.find((it) => it.title === currentDoc.title || it.id === currentDoc.id);
      if (existing) {
        existing.isCurrent = true;
      } else {
        list.unshift({
          id: currentDoc.id,
          title: currentDoc.title,
          source_type: "literature",
          isCurrent: true
        });
      }
    }

    return list;
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .ko-rev-btn {
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
        text-decoration: none;
        user-select: none;
      }
      .ko-rev-btn:hover {
        background: var(--line, rgba(255,255,255,0.08));
        border-color: #d4537e;
        color: var(--ink, #e0e0e0);
      }
      .ko-rev-btn svg { width: 14px; height: 14px; stroke: currentColor; fill: none; flex-shrink: 0; }
      
      .ko-rev-btn-highlight {
        background: linear-gradient(135deg, rgba(212, 83, 126, 0.25) 0%, rgba(153, 53, 86, 0.35) 100%);
        border-color: #d4537e;
        color: var(--ink, #e0e0e0);
      }
      .ko-rev-btn-highlight:hover {
        background: linear-gradient(135deg, rgba(212, 83, 126, 0.4) 0%, rgba(153, 53, 86, 0.5) 100%);
        border-color: #f4c0d1;
      }

      .ko-rev-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.78);
        backdrop-filter: blur(6px);
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        animation: koRevFadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      }
      @keyframes koRevFadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }

      .ko-rev-dialog {
        background: var(--panel, #16181d);
        color: var(--ink, #e0e0e0);
        border: 1px solid var(--line, rgba(255,255,255,0.18));
        border-radius: 12px;
        width: 92vw;
        max-width: 1080px;
        height: 88vh;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        box-shadow: 0 24px 60px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.05);
        transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .ko-rev-dialog.is-maximized {
        width: 98vw;
        max-width: none;
        height: 96vh;
        border-radius: 8px;
      }

      .ko-rev-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 20px;
        border-bottom: 1px solid var(--line, rgba(255,255,255,0.1));
        background: rgba(255,255,255,0.02);
      }
      .ko-rev-title-group {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .ko-rev-badge-tag {
        font-size: calc(11px * var(--font-scale, 1));
        padding: 2px 7px;
        border-radius: 4px;
        background: rgba(212, 83, 126, 0.2);
        color: #d4537e;
        border: 1px solid rgba(212, 83, 126, 0.4);
        font-weight: 600;
        letter-spacing: 0.5px;
      }
      .ko-rev-header h3 {
        margin: 0;
        font-size: calc(15px * var(--font-scale, 1));
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--ink, #e0e0e0);
      }

      .ko-rev-body {
        flex: 1;
        overflow-y: auto;
        padding: 24px 28px;
        display: flex;
        flex-direction: column;
        gap: 18px;
      }

      /* 评审报告看板视觉 */
      .ko-rev-score-banner {
        display: flex;
        align-items: center;
        gap: 24px;
        padding: 18px 24px;
        background: linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.01) 100%);
        border: 1px solid var(--line, rgba(255,255,255,0.12));
        border-radius: 10px;
      }
      .ko-rev-score-circle {
        width: 72px;
        height: 72px;
        border-radius: 50%;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        font-weight: 800;
        font-size: calc(24px * var(--font-scale, 1));
        border: 3px solid;
        flex-shrink: 0;
        box-shadow: 0 4px 16px rgba(0,0,0,0.3);
      }
      .ko-rev-score-accept { color: var(--green, #5DCAA5); border-color: var(--green, #5DCAA5); background: rgba(93,202,165,0.12); }
      .ko-rev-score-borderline { color: var(--gold, #FAC775); border-color: var(--gold, #FAC775); background: rgba(250,199,117,0.12); }
      .ko-rev-score-reject { color: var(--red, #F09595); border-color: var(--red, #F09595); background: rgba(240,149,149,0.12); }

      .ko-rev-subscores-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 8px 16px;
        min-width: 260px;
        font-size: calc(12px * var(--font-scale, 1));
        background: rgba(127,127,127,0.12);
        padding: 10px 14px;
        border-radius: 8px;
        border: 1px solid var(--line, rgba(255,255,255,0.08));
      }
      .ko-rev-meter-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .ko-rev-meter-bar {
        width: 60px;
        height: 6px;
        background: rgba(127,127,127,0.25);
        border-radius: 3px;
        overflow: hidden;
      }
      .ko-rev-meter-fill {
        height: 100%;
        border-radius: 3px;
        background: #d4537e;
      }

      .ko-rev-card {
        padding: 16px 20px;
        border-radius: 10px;
        background: rgba(255,255,255,0.02);
        border: 1px solid var(--line, rgba(255,255,255,0.09));
        font-size: calc(13px * var(--font-scale, 1));
        line-height: 1.65;
      }
      .ko-rev-card-title {
        font-weight: 600;
        font-size: calc(13.5px * var(--font-scale, 1));
        margin-bottom: 10px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
      }
      .ko-rev-weakness-item {
        border-left: 3px solid #e24b4a;
        background: rgba(226,75,74,0.07);
        padding: 10px 14px;
        margin-bottom: 10px;
        border-radius: 0 6px 6px 0;
        font-size: calc(13px * var(--font-scale, 1));
      }
      .ko-rev-rescue-item {
        border-left: 3px solid #5DCAA5;
        background: rgba(93,202,165,0.07);
        padding: 10px 14px;
        margin-bottom: 10px;
        border-radius: 0 6px 6px 0;
        font-size: calc(13px * var(--font-scale, 1));
      }
      .ko-rev-defense-item {
        border-left: 3px solid #378ADD;
        background: rgba(55,138,221,0.07);
        padding: 10px 14px;
        margin-bottom: 10px;
        border-radius: 0 6px 6px 0;
        font-size: calc(13px * var(--font-scale, 1));
      }
      .ko-rev-q-item {
        background: rgba(255,255,255,0.03);
        border: 1px solid var(--line, rgba(255,255,255,0.07));
        padding: 10px 14px;
        margin-bottom: 8px;
        border-radius: 6px;
      }

      /* 快捷预设胶囊 */
      .ko-rev-preset-wrap {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 6px;
      }
      .ko-rev-preset-pill {
        font-size: calc(11px * var(--font-scale, 1));
        padding: 3px 10px;
        border-radius: 12px;
        background: rgba(255,255,255,0.05);
        border: 1px solid var(--line, rgba(255,255,255,0.12));
        color: var(--muted, #aaa);
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .ko-rev-preset-pill:hover {
        background: rgba(212, 83, 126, 0.15);
        border-color: #d4537e;
        color: #d4537e;
      }

      .ko-rev-current-indicator {
        padding: 8px 12px;
        border-radius: 6px;
        background: rgba(93, 202, 165, 0.08);
        border: 1px dashed rgba(93, 202, 165, 0.35);
        color: var(--green, #1f9e6e);
        font-size: calc(12px * var(--font-scale, 1));
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
      }
    `;
    document.head.appendChild(style);
  }

  async function fetchReviews(projectId) {
    const pid = projectId || RState.projectId || "global_research";
    try {
      const res = await fetch(`/api/research/reviewer/${pid}`);
      if (res.ok) {
        const data = await res.json();
        RState.reviews = data.reviews || [];
        if (data.venue_tiers) RState.venueTiers = data.venue_tiers;
        return RState.reviews;
      }
    } catch (_) {}
    return [];
  }

  function renderModal() {
    let overlay = document.getElementById(MODAL_ID);
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = MODAL_ID;
      overlay.className = "ko-rev-overlay";
      document.body.appendChild(overlay);
    }

    const current = RState.currentReview;
    const isMax = RState.isMaximized;

    overlay.innerHTML = `
      <div class="ko-rev-dialog ${isMax ? "is-maximized" : ""}">
        <div class="ko-rev-header">
          <div class="ko-rev-title-group">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#d4537e" stroke-width="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
            <h3>顶刊审稿红队 (Peer Review Red-Team)</h3>
            <span class="ko-rev-badge-tag">审稿反驳 · 严苛挑刺</span>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            ${
              current
                ? `<button class="ko-rev-btn" id="ko-rev-copy-btn" title="复制 Markdown 评审报告">
                    <svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    复制报告
                  </button>
                  <button class="ko-rev-btn ko-rev-btn-highlight" id="ko-rev-new-btn">评审新工作</button>`
                : ""
            }
            <button class="ko-rev-btn" id="ko-rev-max-btn" title="${isMax ? "还原窗口" : "最大化"}">
              ${
                isMax
                  ? `<svg viewBox="0 0 24 24"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>`
                  : `<svg viewBox="0 0 24 24"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>`
              }
            </button>
            <button class="ko-rev-btn" id="ko-rev-close" style="padding: 4px 8px;" title="关闭">✕</button>
          </div>
        </div>

        <div class="ko-rev-body">
          ${
            RState.loading
              ? `<div style="text-align:center; padding: 70px 20px; color: var(--muted, #999);">
                   <div style="display:inline-block; width: 28px; height: 28px; border: 3px solid #d4537e; border-top-color: transparent; border-radius: 50%; animation: spin 0.9s linear infinite; margin-bottom: 16px;"></div>
                   <div style="font-size: calc(15px * var(--font-scale, 1)); font-weight: 600; color: var(--ink, #e0e0e0); margin-bottom: 8px;">顶尖审稿委员会正在独立盲审...</div>
                   <div style="font-size: calc(12.5px * var(--font-scale, 1)); max-width: 500px; margin: 0 auto; line-height: 1.6; color: var(--muted, #aaa);">
                     正在依据顶刊盲审准则进行严格背对背挑刺：Reviewer 1 正在核验数学机理推导；Reviewer 2 正在攻击对比基线与消融漏洞；Reviewer 3 正在推演致命反例与救命补做实验...
                   </div>
                 </div>
                 <style>@keyframes spin { 100% { transform: rotate(360deg); } }</style>`
              : current
              ? renderReviewView(current)
              : renderCreateView()
          }
        </div>
      </div>
    `;

    bindModalEvents(overlay);
  }

  function renderCreateView() {
    const curDoc = getCurrentReadingDoc();

    const srcOptions = RState.sources
      .map((s) => {
        const isCur = s.isCurrent || (curDoc && s.title === curDoc.title);
        const sel = isCur || s.id === RState.selectedTargetId ? "selected" : "";
        const tag = isCur ? " [当前阅读]" : "";
        return `<option value="${esc(s.id)}" ${sel}>${esc(s.title)}${tag}</option>`;
      })
      .join("");

    const tierOptions = RState.venueTiers
      .map((t) => `<option value="${esc(t)}" ${t === RState.venueTier ? "selected" : ""}>${esc(t)}</option>`)
      .join("");

    const pastReviewsHtml = RState.reviews.length
      ? `
      <div style="margin-top: 24px; border-top: 1px solid var(--line, rgba(255,255,255,0.08)); padding-top: 16px;">
        <div style="font-size: calc(13px * var(--font-scale, 1)); font-weight: 600; margin-bottom: 12px; color: var(--muted, #aaa); display: flex; align-items: center; justify-content: space-between;">
          <span>历史审稿挑刺档案 (${RState.reviews.length})</span>
          <span style="font-size: calc(11px * var(--font-scale, 1)); font-weight: normal; color: var(--muted, #777);">跨项目/全量自动聚合</span>
        </div>
        <div style="display: flex; flex-direction: column; gap: 8px;">
          ${RState.reviews
            .map(
              (r) => `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; background: rgba(255,255,255,0.02); border: 1px solid var(--line, rgba(255,255,255,0.08)); border-radius: 8px; transition: background 0.15s ease;">
              <div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 12px;">
                <span style="font-weight: 700; font-size: calc(13px * var(--font-scale, 1)); color: ${r.overall_score >= 7 ? 'var(--green, #5DCAA5)' : r.overall_score >= 5 ? 'var(--gold, #FAC775)' : 'var(--red, #F09595)'};">
                  [${r.overall_score}/10 · ${esc(r.recommendation)}]
                </span>
                <span style="font-weight: 500; font-size: calc(13px * var(--font-scale, 1)); margin-left: 8px; color: var(--ink, #e0e0e0);">${esc(r.target_title)}</span>
                <span style="font-size: calc(11.5px * var(--font-scale, 1)); color: var(--muted, #777); margin-left: 10px;">${esc(r.venue_tier)} · ${r.created_at ? r.created_at.slice(0, 10) : ""}</span>
              </div>
              <div style="display: flex; gap: 6px; flex-shrink: 0;">
                <button class="ko-rev-btn ko-rev-load" data-id="${esc(r.review_id)}">查看报告</button>
                <button class="ko-rev-btn ko-rev-del" data-id="${esc(r.review_id)}" style="color: #e24b4a;">删除</button>
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
        <div style="background: rgba(212, 83, 126, 0.08); border: 1px solid rgba(212, 83, 126, 0.2); border-radius: 8px; padding: 12px 16px; margin-bottom: 16px;">
          <div style="font-weight: 600; font-size: calc(13px * var(--font-scale, 1)); color: #d4537e; margin-bottom: 4px;">
            💡 为什么要用顶刊审稿红队？
          </div>
          <div style="font-size: calc(12px * var(--font-scale, 1)); line-height: 1.6; color: var(--muted, #bbb);">
            在论文投稿、夏令营保研面试或大创答辩前，让 AI 审稿专家扮演「最挑剔的 Reviewer」，专攻理论机理跳步、Baseline 缺失与消融实验不足等死穴，并输出防守答辩话术与救命补做实验。
          </div>
        </div>

        ${
          curDoc
            ? `<div class="ko-rev-current-indicator">
                 <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                 <span>已自动捕获当前阅读文献：<strong>《${esc(curDoc.title)}》</strong></span>
               </div>`
            : ""
        }

        <div style="display: flex; flex-direction: column; gap: 16px;">
          <div>
            <label style="display: block; font-size: calc(12.5px * var(--font-scale, 1)); font-weight: 600; margin-bottom: 6px;">目标期刊/会议审稿级别</label>
            <select id="ko-rev-tier" style="width: 100%; padding: 9px 12px; font-size: calc(13px * var(--font-scale, 1)); background: rgba(127,127,127,0.12); border: 1px solid var(--line, rgba(255,255,255,0.15)); border-radius: 6px; color: var(--ink, #e0e0e0);">
              ${tierOptions}
            </select>
          </div>

          <div>
            <label style="display: block; font-size: calc(12.5px * var(--font-scale, 1)); font-weight: 600; margin-bottom: 6px;">待评审对象来源</label>
            <div style="display: flex; gap: 16px; margin-bottom: 10px;">
              <label style="font-size: calc(13px * var(--font-scale, 1)); display: flex; align-items: center; gap: 6px; cursor: pointer;">
                <input type="radio" name="ko-rev-mode" value="literature" checked id="ko-rev-mode-lit" /> 评审文献库论文 / 当前文献
              </label>
              <label style="font-size: calc(13px * var(--font-scale, 1)); display: flex; align-items: center; gap: 6px; cursor: pointer;">
                <input type="radio" name="ko-rev-mode" value="draft" id="ko-rev-mode-draft" /> 评审自写草稿 / 保研方案 / 开题
              </label>
            </div>

            <div id="ko-rev-lit-box">
              <select id="ko-rev-source-id" style="width: 100%; padding: 9px 12px; font-size: calc(13px * var(--font-scale, 1)); background: rgba(127,127,127,0.12); border: 1px solid var(--line, rgba(255,255,255,0.15)); border-radius: 6px; color: var(--ink, #e0e0e0);">
                <option value="">-- 请选择要评审的文献 (支持自动解析长文本) --</option>
                ${srcOptions}
              </select>
            </div>

            <div id="ko-rev-draft-box" style="display: none; flex-direction: column; gap: 10px;">
              <input id="ko-rev-draft-title" type="text" placeholder="论文/方案标题 (例如：基于双层异构dToF阵列雷达的室内实时三维导盲感知系统)" 
                     value="${esc(RState.draftTitle)}"
                     style="width: 100%; padding: 9px 12px; font-size: calc(13px * var(--font-scale, 1)); background: rgba(127,127,127,0.12); border: 1px solid var(--line, rgba(255,255,255,0.15)); border-radius: 6px; color: var(--ink, #e0e0e0);" />
              <textarea id="ko-rev-draft-text" placeholder="粘贴摘要 (Abstract)、核心方法论或正文草稿内容 (支持 Markdown，越详尽挑刺越精准)..." rows="6"
                        style="width: 100%; padding: 9px 12px; font-size: calc(13px * var(--font-scale, 1)); background: rgba(127,127,127,0.12); border: 1px solid var(--line, rgba(255,255,255,0.15)); border-radius: 6px; color: var(--ink, #e0e0e0); line-height: 1.55;">${esc(RState.draftContent)}</textarea>
            </div>
          </div>

          <div>
            <label style="display: block; font-size: calc(12.5px * var(--font-scale, 1)); font-weight: 600; margin-bottom: 4px;">审稿重点叮嘱 (可选 · 点击下方快捷胶囊填入)</label>
            <input id="ko-rev-notes" type="text" placeholder="例如：重点审查光学测距精度误差传播、以及与传统激光雷达相比的创新性不足之处" 
                   value="${esc(RState.authorNotes)}"
                   style="width: 100%; padding: 9px 12px; font-size: calc(13px * var(--font-scale, 1)); background: rgba(127,127,127,0.12); border: 1px solid var(--line, rgba(255,255,255,0.15)); border-radius: 6px; color: var(--ink, #e0e0e0);" />
            <div class="ko-rev-preset-wrap">
              <span class="ko-rev-preset-pill" data-preset="专挑理论机理跳步、公式推导假设不严谨之处">⚡ 理论机理跳步审查</span>
              <span class="ko-rev-preset-pill" data-preset="重点审查对比 Baseline 是否落后、消融实验是否充分">🔬 实验与消融漏洞挑刺</span>
              <span class="ko-rev-preset-pill" data-preset="站在保研夏令营面试官/国赛评委视角，专打系统瓶颈与方案漏洞">🎓 保研答辩前置质询</span>
              <span class="ko-rev-preset-pill" data-preset="针对 IEEE Trans / Optica 顶刊标准，严格审查创新性与硬件落地代价">🏆 顶刊门槛与硬件代价</span>
            </div>
          </div>

          <button class="ko-rev-btn ko-rev-btn-highlight" id="ko-rev-run-btn" style="justify-content: center; padding: 12px; font-size: calc(13.5px * var(--font-scale, 1)); margin-top: 6px; font-weight: 600;">
            <svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            启动顶级审稿委员会红队盲审 ⚔️
          </button>
        </div>

        ${pastReviewsHtml}
      </div>
    `;
  }

  function renderReviewView(r) {
    const d = r.details || {};
    const score = r.overall_score || 5;
    const badgeClass = score >= 7 ? "ko-rev-score-accept" : score >= 5 ? "ko-rev-score-borderline" : "ko-rev-score-reject";
    const subScores = d.scores || {};

    const strengths = (d.strengths || []).map((s) => `<li>${esc(s)}</li>`).join("");
    const weaknesses = (d.fatal_weaknesses || []).map((w, idx) => `
      <div class="ko-rev-weakness-item">
        <div style="font-weight: 600; color: var(--red, #e24b4a); margin-bottom: 2px;">⚠️ 致命硬伤 #${idx + 1}：</div>
        <div>${esc(w)}</div>
      </div>
    `).join("");

    const questions = (d.questions_to_authors || []).map((q, i) => `
      <div class="ko-rev-q-item">
        <strong style="color: var(--gold, #FAC775);">Q${i + 1} (审稿人质询)：</strong>
        <span style="color: var(--ink, #e0e0e0);">${esc(q)}</span>
      </div>
    `).join("");

    const rescues = (d.rescue_experiments || []).map((rx, idx) => `
      <div class="ko-rev-rescue-item">
        <div style="font-weight: 600; color: var(--green, #1f9e6e); margin-bottom: 2px;">🧪 救命补做实验方案 #${idx + 1}：</div>
        <div>${esc(rx)}</div>
      </div>
    `).join("");

    const defenses = (d.defense_strategies || []).map((df, idx) => `
      <div class="ko-rev-defense-item">
        <div style="font-weight: 600; color: #378ADD; margin-bottom: 2px;">🛡️ 答辩抗辩策略与话术 #${idx + 1}：</div>
        <div>${esc(df)}</div>
      </div>
    `).join("");

    return `
      <div style="display: flex; flex-direction: column; gap: 16px;">
        <div class="ko-rev-score-banner">
          <div class="ko-rev-score-circle ${badgeClass}">
            <span>${score}</span>
            <span style="font-size: calc(11px * var(--font-scale, 1)); font-weight: 500; opacity: 0.8;">/ 10</span>
          </div>
          <div style="flex: 1;">
            <div style="font-size: calc(16px * var(--font-scale, 1)); font-weight: 700; margin-bottom: 4px; display: flex; align-items: center; gap: 8px;">
              <span>${esc(r.target_title)}</span>
              <span style="font-size: calc(11px * var(--font-scale, 1)); padding: 2px 8px; border-radius: 4px; background: rgba(255,255,255,0.08); font-weight: 500;">${esc(r.venue_tier)}</span>
            </div>
            <div style="font-size: calc(13.5px * var(--font-scale, 1)); color: ${score >= 7 ? 'var(--green, #5DCAA5)' : score >= 5 ? 'var(--gold, #FAC775)' : 'var(--red, #F09595)'}; font-weight: 700; margin-bottom: 6px;">
              终审裁决建议：${esc(r.recommendation)}
            </div>
            <div style="font-size: calc(12.5px * var(--font-scale, 1)); color: var(--muted, #aaa); line-height: 1.5;">
              <strong>主编一句话总评：</strong>${esc(d.one_line_summary || r.summary_of_work)}
            </div>
          </div>
          <div class="ko-rev-subscores-grid">
            <div class="ko-rev-meter-row">
              <span style="color: var(--muted, #aaa);">理论严谨性</span>
              <span style="font-weight: 600; color: var(--ink, #e0e0e0);">${subScores.soundness || '-'}/5</span>
            </div>
            <div class="ko-rev-meter-row">
              <span style="color: var(--muted, #aaa);">表达与规范</span>
              <span style="font-weight: 600; color: var(--ink, #e0e0e0);">${subScores.presentation || '-'}/5</span>
            </div>
            <div class="ko-rev-meter-row">
              <span style="color: var(--muted, #aaa);">创新突破性</span>
              <span style="font-weight: 600; color: var(--ink, #e0e0e0);">${subScores.contribution || '-'}/5</span>
            </div>
            <div class="ko-rev-meter-row">
              <span style="color: var(--muted, #aaa);">实验充分性</span>
              <span style="font-weight: 600; color: var(--ink, #e0e0e0);">${subScores.experimental_rigor || '-'}/5</span>
            </div>
          </div>
        </div>

        <div class="ko-rev-card">
          <div class="ko-rev-card-title" style="color: var(--green, #1f9e6e);">
            <span>💡 工作贡献提炼与亮点 (Summary & Contributions)</span>
          </div>
          <div style="color: var(--ink, #e0e0e0);">${esc(d.summary_of_work || r.summary_of_work)}</div>
          ${strengths ? `<ul style="margin: 10px 0 0 18px; padding: 0; color: var(--ink, #e0e0e0); opacity: 0.85;">${strengths}</ul>` : ""}
        </div>

        <div class="ko-rev-card">
          <div class="ko-rev-card-title" style="color: var(--red, #e24b4a);">
            <span>⚔️ 审稿专家致命死穴挑刺 (Fatal Weaknesses)</span>
            <span style="font-size: calc(11px * var(--font-scale, 1)); font-weight: normal; color: var(--muted, #aaa);">拒稿核心靶点</span>
          </div>
          <div>${weaknesses || "<p style='color: var(--muted); margin: 0;'>未检出致命硬伤。</p>"}</div>
        </div>

        <div class="ko-rev-card">
          <div class="ko-rev-card-title" style="color: var(--gold, #b8860b);">
            <span>❓ 审稿质询关键问题清单 (Questions to Authors)</span>
            <span style="font-size: calc(11px * var(--font-scale, 1)); font-weight: normal; color: var(--muted, #aaa);">答辩与二审必考题</span>
          </div>
          <div>${questions || "<p style='color: var(--muted); margin: 0;'>无额外审稿人质询。</p>"}</div>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
          <div class="ko-rev-card">
            <div class="ko-rev-card-title" style="color: var(--green, #1f9e6e);">
              <span>🧪 救命补充实验方案 (Rescue Experiments)</span>
            </div>
            <div>${rescues || "<p style='color: var(--muted); margin: 0;'>现有实验基本足以支撑核心结论。</p>"}</div>
          </div>

          <div class="ko-rev-card">
            <div class="ko-rev-card-title" style="color: #378ADD;">
              <span>🛡️ 答辩抗辩策略与 Response 话术 (Rebuttal Defense)</span>
            </div>
            <div>${defenses || "<p style='color: var(--muted); margin: 0;'>按常规学术礼貌格式致谢并微调表述即可。</p>"}</div>
          </div>
        </div>
      </div>
    `;
  }

  function generateMarkdownReport(r) {
    const d = r.details || {};
    const sub = d.scores || {};
    let md = `# 【顶刊审稿红队报告】${r.target_title}\n\n`;
    md += `**目标级别**: ${r.venue_tier}  \n`;
    md += `**综合裁定**: ${r.recommendation} (${r.overall_score}/10)  \n`;
    md += `**一句话总评**: ${d.one_line_summary || r.summary_of_work}\n\n`;
    md += `### 四维评分\n`;
    md += `- 理论严谨性 (Soundness): ${sub.soundness || '-'}/5\n`;
    md += `- 表达与规范 (Presentation): ${sub.presentation || '-'}/5\n`;
    md += `- 创新突破性 (Contribution): ${sub.contribution || '-'}/5\n`;
    md += `- 实验充分性 (Rigor): ${sub.experimental_rigor || '-'}/5\n\n`;

    md += `### 一、工作贡献提炼\n${d.summary_of_work || r.summary_of_work}\n\n`;

    md += `### 二、审稿人致命硬伤 (Fatal Weaknesses)\n`;
    (d.fatal_weaknesses || []).forEach((w, i) => {
      md += `${i + 1}. ${w}\n`;
    });
    md += `\n`;

    md += `### 三、审稿人质询清单 (Questions to Authors)\n`;
    (d.questions_to_authors || []).forEach((q, i) => {
      md += `${i + 1}. ${q}\n`;
    });
    md += `\n`;

    md += `### 四、救命补充实验 (Rescue Experiments)\n`;
    (d.rescue_experiments || []).forEach((rx, i) => {
      md += `${i + 1}. ${rx}\n`;
    });
    md += `\n`;

    md += `### 五、抗辩防守策略 (Rebuttal Defense)\n`;
    (d.defense_strategies || []).forEach((df, i) => {
      md += `${i + 1}. ${df}\n`;
    });

    return md;
  }

  function bindModalEvents(overlay) {
    const closeBtn = overlay.querySelector("#ko-rev-close");
    if (closeBtn) closeBtn.onclick = () => overlay.remove();

    overlay.onclick = (e) => {
      if (e.target === overlay) overlay.remove();
    };

    const maxBtn = overlay.querySelector("#ko-rev-max-btn");
    if (maxBtn) {
      maxBtn.onclick = () => {
        RState.isMaximized = !RState.isMaximized;
        renderModal();
      };
    }

    const copyBtn = overlay.querySelector("#ko-rev-copy-btn");
    if (copyBtn && RState.currentReview) {
      copyBtn.onclick = () => {
        const md = generateMarkdownReport(RState.currentReview);
        navigator.clipboard.writeText(md).then(() => {
          toast("评审报告 Markdown 已复制到剪贴板！", "success");
        }).catch(() => {
          toast("复制失败，请手动选取", "error");
        });
      };
    }

    const newBtn = overlay.querySelector("#ko-rev-new-btn");
    if (newBtn) {
      newBtn.onclick = () => {
        RState.currentReview = null;
        renderModal();
      };
    }

    const modeLit = overlay.querySelector("#ko-rev-mode-lit");
    const modeDraft = overlay.querySelector("#ko-rev-mode-draft");
    const litBox = overlay.querySelector("#ko-rev-lit-box");
    const draftBox = overlay.querySelector("#ko-rev-draft-box");

    if (modeLit && modeDraft) {
      modeLit.onchange = () => {
        litBox.style.display = "block";
        draftBox.style.display = "none";
      };
      modeDraft.onchange = () => {
        litBox.style.display = "none";
        draftBox.style.display = "flex";
      };
    }

    overlay.querySelectorAll(".ko-rev-preset-pill").forEach((pill) => {
      pill.onclick = () => {
        const preset = pill.getAttribute("data-preset");
        const notesInput = overlay.querySelector("#ko-rev-notes");
        if (notesInput && preset) {
          notesInput.value = preset;
          RState.authorNotes = preset;
        }
      };
    });

    const runBtn = overlay.querySelector("#ko-rev-run-btn");
    if (runBtn) {
      runBtn.onclick = () => {
        const isDraft = modeDraft?.checked;
        const venueTier = overlay.querySelector("#ko-rev-tier")?.value || RState.venueTier;
        const notes = (overlay.querySelector("#ko-rev-notes")?.value || "").trim();

        const g = getGlobalState();
        const pid = g.currentProjectId || RState.projectId || "global_research";

        let reqBody = {
          project_id: pid,
          venue_tier: venueTier,
          author_notes: notes,
        };

        if (isDraft) {
          const title = (overlay.querySelector("#ko-rev-draft-title")?.value || "").trim();
          const text = (overlay.querySelector("#ko-rev-draft-text")?.value || "").trim();
          if (!title && !text) {
            toast("请填写草稿标题或正文内容！", "error");
            return;
          }
          reqBody.target_type = "draft";
          reqBody.title = title || "自写学术方案草稿";
          reqBody.content = text;
        } else {
          let srcId = overlay.querySelector("#ko-rev-source-id")?.value;
          if (!srcId) {
            if (RState.sources && RState.sources.length > 0) {
              srcId = RState.sources[0].id;
              toast(`已自动选中文献《${RState.sources[0].title}》，正在启动红队盲审！`, "info");
            } else {
              toast("请先选择或导入待评审的文献！", "error");
              return;
            }
          }
          reqBody.target_type = "literature";
          reqBody.target_id = srcId;
        }

        RState.loading = true;
        renderModal();

        fetch("/api/research/reviewer/critique", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(reqBody),
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
            RState.loading = false;
            if (res.review) {
              RState.currentReview = res.review;
              toast("🎉 顶刊审稿红队盲审完成！", "success");
              fetchReviews(pid);
            } else {
              const msg = (typeof res.detail === "string" ? res.detail : (res.detail?.message || res.message)) || "审稿生成失败，请重试";
              toast(msg, "error");
            }
            renderModal();
          })
          .catch((err) => {
            RState.loading = false;
            toast("审稿出错: " + (err.message || err), "error");
            renderModal();
          });
      };
    }

    overlay.querySelectorAll(".ko-rev-load").forEach((btn) => {
      btn.onclick = () => {
        const id = btn.getAttribute("data-id");
        const found = RState.reviews.find((r) => r.review_id === id);
        if (found) {
          RState.currentReview = found;
          renderModal();
        }
      };
    });

    overlay.querySelectorAll(".ko-rev-del").forEach((btn) => {
      btn.onclick = () => {
        const id = btn.getAttribute("data-id");
        fetch(`/api/research/reviewer/${id}`, { method: "DELETE" })
          .then((r) => r.json())
          .then(() => {
            toast("评审报告已移除", "info");
            fetchReviews().then(() => {
              if (RState.currentReview && RState.currentReview.review_id === id) RState.currentReview = null;
              renderModal();
            });
          });
      };
    });
  }

  async function openReviewerModal() {
    const g = getGlobalState();
    RState.projectId = g.currentProjectId || "global_research";

    const [reviews, sources] = await Promise.all([
      fetchReviews(RState.projectId),
      gatherAvailableSources(),
    ]);

    RState.reviews = reviews;
    RState.sources = sources;

    // 如果阅读器里打开了文献，自动锁定该文献
    const curDoc = getCurrentReadingDoc();
    if (curDoc) {
      RState.selectedTargetId = curDoc.id;
    }

    renderModal();
  }

  function injectTriggerButtons() {
    // 1. 在文献库侧栏顶部操作区注入
    const libParent = document.querySelector(".lit-library-actions");
    if (libParent && !document.getElementById(LIB_BTN_ID)) {
      const btn = document.createElement("button");
      btn.id = LIB_BTN_ID;
      btn.className = "ko-rev-btn";
      btn.innerHTML = `
        <svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        审稿红队
      `;
      btn.onclick = openReviewerModal;
      libParent.appendChild(btn);
    }

    // 顶栏「顶刊审稿 ⚔️」按钮已按需求移除（2026-09-26）：
    // 只保留文献库侧栏的「审稿红队」这一个入口，避免顶栏过挤。
  }

  function init() {
    injectStyles();
    injectTriggerButtons();

    const obs = new MutationObserver(() => {
      injectTriggerButtons();
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
