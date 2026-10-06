// 期刊检索 UI（注入式模块）
// 在论文搜索的 Tab 栏中注入「期刊」Tab，实现期刊搜索和详情展示。
// 依赖 paper-search-ui.js 先加载（共享搜索栏位置），或独立运行。
(function () {
  "use strict";

  const root = document.getElementById("literature-workspace");
  if (!root) return;

  const esc = (v) =>
    String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  // ── 状态 ──
  const J = {
    journals: [],
    total: 0,
    query: "",
    loading: false,
    sort: "",
    detail: null,
    detailLoading: false,
  };

  // ── 样式 ──
  const style = document.createElement("style");
  style.textContent = `
.js-journal-card{padding:12px;border-radius:10px;border:1px solid var(--line);margin-bottom:8px;cursor:pointer;transition:border-color .15s}
.js-journal-card:hover{border-color:var(--green)}
.js-journal-name{font-size:calc(14px * var(--font-scale, 1));font-weight:500;color:var(--ink);margin-bottom:4px}
.js-journal-pub{font-size:calc(12px * var(--font-scale, 1));color:var(--muted);margin-bottom:6px}
.js-journal-stats{display:flex;flex-wrap:wrap;gap:6px}
.js-stat{display:inline-flex;flex-direction:column;align-items:center;padding:6px 10px;border-radius:8px;background:var(--line);min-width:60px}
.js-stat-value{font-size:calc(14px * var(--font-scale, 1));font-weight:500;color:var(--ink)}
.js-stat-label{font-size:calc(10.5px * var(--font-scale, 1));color:var(--muted);margin-top:1px}
.js-stat-if .js-stat-value{color:var(--gold)}
.js-stat-q1 .js-stat-value{color:var(--green)}
.js-badge-oa{display:inline-block;padding:2px 6px;border-radius:4px;font-size:calc(10.5px * var(--font-scale, 1));font-weight:500;background:rgba(29,158,117,.15);color:var(--green);margin-left:6px}
.js-detail-overlay{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px}
.js-detail-panel{background:var(--panel);border-radius:14px;max-width:640px;width:100%;max-height:80vh;overflow-y:auto;padding:24px;position:relative;border:1px solid var(--line)}
.js-detail-close{position:absolute;top:12px;right:16px;background:none;border:none;font-size:calc(20px * var(--font-scale, 1));color:var(--muted);cursor:pointer;line-height:1}
.js-detail-close:hover{color:var(--ink)}
.js-detail-title{font-size:calc(17px * var(--font-scale, 1));font-weight:500;color:var(--ink);margin-bottom:4px;padding-right:30px}
.js-detail-subtitle{font-size:calc(13px * var(--font-scale, 1));color:var(--muted);margin-bottom:14px}
.js-detail-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:8px;margin-bottom:16px}
.js-detail-stat{text-align:center;padding:10px 8px;border-radius:10px;background:var(--line)}
.js-detail-stat .val{font-size:calc(18px * var(--font-scale, 1));font-weight:500;color:var(--ink);display:block}
.js-detail-stat .lbl{font-size:calc(11px * var(--font-scale, 1));color:var(--muted);display:block;margin-top:2px}
.js-detail-section{margin-bottom:14px}
.js-detail-section h4{font-size:calc(13px * var(--font-scale, 1));font-weight:500;color:var(--ink);margin:0 0 8px}
.js-topic-list{display:flex;flex-wrap:wrap;gap:6px}
.js-topic-chip{padding:3px 10px;border-radius:6px;font-size:calc(12px * var(--font-scale, 1));background:var(--line);color:var(--ink)}
.js-chart-wrap{width:100%;height:160px;display:flex;align-items:flex-end;gap:4px;padding:8px 0}
.js-chart-bar{flex:1;display:flex;flex-direction:column;align-items:center}
.js-chart-bar .bar{width:100%;border-radius:4px 4px 0 0;background:var(--green);min-height:2px;transition:height .3s}
.js-chart-bar .yr{font-size:calc(10px * var(--font-scale, 1));color:var(--muted);margin-top:4px}
.js-chart-bar .ct{font-size:calc(10px * var(--font-scale, 1));color:var(--ink);margin-bottom:2px}
`;
  document.head.appendChild(style);

  // ── 注入 Tab ──
  // 等 paper-search-ui.js 渲染后，在 Tab 栏追加「期刊」按钮
  function injectJournalTab() {
    const c = document.getElementById("ps-container");
    if (!c) return false;

    const tabBar = c.querySelector(".ps-tab-bar");
    if (!tabBar) return false;

    // 避免重复
    if (tabBar.querySelector('[data-ps-tab="journals"]')) return true;

    const btn = document.createElement("button");
    btn.className = "ps-tab";
    btn.dataset.psTab = "journals";
    btn.textContent = "期刊";
    tabBar.appendChild(btn);

    btn.addEventListener("click", () => {
      // 取消其他 Tab 激活态
      tabBar.querySelectorAll(".ps-tab").forEach(t => t.classList.remove("active"));
      btn.classList.add("active");

      // 获取搜索词
      const input = c.querySelector("#ps-query");
      if (input) J.query = input.value.trim();

      renderJournalResults();
      if (J.query && J.journals.length === 0) searchJournals();
    });

    return true;
  }

  // ── 渲染期刊结果 ──
  function renderJournalResults() {
    const c = document.getElementById("ps-container");
    if (!c) return;

    const results = c.querySelector("#ps-results") || c.querySelector(".ps-results");
    if (!results) return;

    // 隐藏 paper/author 筛选栏
    const filters = c.querySelector(".ps-filters");
    if (filters) filters.style.display = "none";

    let html = "";
    if (J.loading) {
      html = `<div class="ps-loading">正在搜索期刊…</div>`;
    } else if (J.journals.length === 0) {
      html = `<div class="ps-empty">${J.query ? "没有找到相关期刊" : "输入期刊名称或关键词搜索"}</div>`;
    } else {
      for (const j of J.journals) {
        html += journalCard(j);
      }
      if (J.journals.length < J.total) {
        html += `<button class="ps-load-more" id="js-more">加载更多（已显示 ${J.journals.length} / ${J.total}）</button>`;
      }
    }
    results.innerHTML = html;

    // 绑定事件
    results.querySelectorAll("[data-journal-id]").forEach(card => {
      card.addEventListener("click", () => showJournalDetail(card.dataset.journalId));
    });
    const moreBtn = results.querySelector("#js-more");
    if (moreBtn) moreBtn.addEventListener("click", () => searchJournals(true));
  }

  function journalCard(j) {
    const quartile = estimateQuartileLabel(j.impactFactor);
    return `<div class="js-journal-card" data-journal-id="${esc(j.id)}">
      <div class="js-journal-name">${esc(j.name)}${j.abbreviation ? ` <span style="color:var(--muted);font-weight:400;font-size:calc(12px * var(--font-scale, 1))">(${esc(j.abbreviation)})</span>` : ""}${j.isOA ? `<span class="js-badge-oa">OA</span>` : ""}</div>
      <div class="js-journal-pub">${esc(j.publisher)}${j.country ? ` · ${esc(j.country)}` : ""}${j.issn ? ` · ISSN ${esc(j.issn)}` : ""}</div>
      <div class="js-journal-stats">
        <div class="js-stat js-stat-if"><span class="js-stat-value">${j.impactFactor || "N/A"}</span><span class="js-stat-label">影响因子</span></div>
        <div class="js-stat js-stat-q1"><span class="js-stat-value">${quartile}</span><span class="js-stat-label">分区</span></div>
        <div class="js-stat"><span class="js-stat-value">${formatCount(j.citedByCount)}</span><span class="js-stat-label">总引用</span></div>
        <div class="js-stat"><span class="js-stat-value">${j.hIndex || "N/A"}</span><span class="js-stat-label">h-index</span></div>
        <div class="js-stat"><span class="js-stat-value">${formatCount(j.worksCount)}</span><span class="js-stat-label">总发文</span></div>
      </div>
    </div>`;
  }

  // ── 搜索 ──
  async function searchJournals(append = false) {
    const c = document.getElementById("ps-container");
    if (c) {
      const input = c.querySelector("#ps-query");
      if (input) J.query = input.value.trim();
    }
    if (!J.query) return;

    if (!append) { J.journals = []; }
    J.loading = true;
    renderJournalResults();

    try {
      const offset = J.journals.length;
      const params = new URLSearchParams({ q: J.query, offset: String(offset), limit: "20" });
      if (J.sort) params.set("sort", J.sort);
      const data = await window.api(`/api/search/journals?${params}`);
      if (append) {
        J.journals.push(...(data.journals || []));
      } else {
        J.journals = data.journals || [];
      }
      J.total = data.total || 0;
    } catch (err) {
      if (window.showToast) window.showToast("期刊搜索失败：" + (err.message || err), { variant: "error" });
    } finally {
      J.loading = false;
      renderJournalResults();
    }
  }

  // ── 期刊详情弹窗 ──
  async function showJournalDetail(journalId) {
    J.detailLoading = true;
    renderJournalDetailOverlay(null);

    try {
      const data = await window.api(`/api/search/journal-detail?id=${encodeURIComponent(journalId)}`);
      J.detail = data.journal;
      renderJournalDetailOverlay(data.journal);
    } catch (err) {
      closeJournalDetail();
      if (window.showToast) window.showToast("获取期刊详情失败", { variant: "error" });
    } finally {
      J.detailLoading = false;
    }
  }

  function renderJournalDetailOverlay(journal) {
    let overlay = document.getElementById("js-detail-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "js-detail-overlay";
      overlay.className = "js-detail-overlay";
      document.body.appendChild(overlay);
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) closeJournalDetail();
      });
    }
    overlay.style.display = "flex";

    if (!journal) {
      overlay.innerHTML = `<div class="js-detail-panel"><div class="ps-loading">加载中…</div></div>`;
      return;
    }

    const quartile = journal.quartile || estimateQuartileLabel(journal.impactFactor);
    let html = `<div class="js-detail-panel">
      <button class="js-detail-close" id="js-detail-close">&times;</button>
      <div class="js-detail-title">${esc(journal.name)}</div>
      <div class="js-detail-subtitle">
        ${journal.abbreviation ? esc(journal.abbreviation) + " · " : ""}${esc(journal.publisher)}${journal.country ? ` · ${esc(journal.country)}` : ""}
        ${journal.isOA ? `<span class="js-badge-oa">OA</span>` : ""}
        ${journal.issn ? ` · ISSN ${esc(journal.issn)}` : ""}
      </div>

      <div class="js-detail-grid">
        <div class="js-detail-stat"><span class="val" style="color:var(--gold)">${journal.impactFactor || "N/A"}</span><span class="lbl">影响因子 (2yr)</span></div>
        <div class="js-detail-stat"><span class="val" style="color:var(--green)">${quartile}</span><span class="lbl">估算分区</span></div>
        <div class="js-detail-stat"><span class="val">${journal.hIndex || "N/A"}</span><span class="lbl">h-index</span></div>
        <div class="js-detail-stat"><span class="val">${formatCount(journal.citedByCount)}</span><span class="lbl">总引用</span></div>
        <div class="js-detail-stat"><span class="val">${formatCount(journal.worksCount)}</span><span class="lbl">总发文量</span></div>
        ${journal.apcUsd != null ? `<div class="js-detail-stat"><span class="val">$${journal.apcUsd}</span><span class="lbl">APC (USD)</span></div>` : ""}
      </div>`;

    // 发文趋势图
    if (journal.countsByYear && journal.countsByYear.length > 1) {
      const years = [...journal.countsByYear].reverse();
      const maxWorks = Math.max(...years.map(y => y.worksCount), 1);
      html += `<div class="js-detail-section"><h4>发文量趋势</h4>
        <div class="js-chart-wrap">`;
      for (const y of years) {
        const h = Math.max(2, (y.worksCount / maxWorks) * 120);
        html += `<div class="js-chart-bar">
          <span class="ct">${y.worksCount}</span>
          <div class="bar" style="height:${h}px"></div>
          <span class="yr">${y.year}</span>
        </div>`;
      }
      html += `</div></div>`;
    }

    // 引用趋势
    if (journal.countsByYear && journal.countsByYear.length > 1) {
      const years = [...journal.countsByYear].reverse();
      const maxCites = Math.max(...years.map(y => y.citedByCount), 1);
      html += `<div class="js-detail-section"><h4>引用量趋势</h4>
        <div class="js-chart-wrap">`;
      for (const y of years) {
        const h = Math.max(2, (y.citedByCount / maxCites) * 120);
        html += `<div class="js-chart-bar">
          <span class="ct">${formatCount(y.citedByCount)}</span>
          <div class="bar" style="height:${h}px;background:var(--gold)"></div>
          <span class="yr">${y.year}</span>
        </div>`;
      }
      html += `</div></div>`;
    }

    // 主题
    if (journal.topics && journal.topics.length) {
      html += `<div class="js-detail-section"><h4>研究主题</h4><div class="js-topic-list">`;
      for (const t of journal.topics) {
        html += `<span class="js-topic-chip">${esc(t.name)}</span>`;
      }
      html += `</div></div>`;
    }

    // 链接
    if (journal.homepage) {
      html += `<div class="js-detail-section"><h4>期刊主页</h4><p><a href="${esc(journal.homepage)}" target="_blank" rel="noopener" style="color:var(--green);font-size:calc(13px * var(--font-scale, 1))">${esc(journal.homepage)}</a></p></div>`;
    }

    html += `</div>`;
    overlay.innerHTML = html;

    overlay.querySelector("#js-detail-close").addEventListener("click", closeJournalDetail);
  }

  function closeJournalDetail() {
    const overlay = document.getElementById("js-detail-overlay");
    if (overlay) overlay.style.display = "none";
    J.detail = null;
  }

  // ── 工具 ──
  function estimateQuartileLabel(impactFactor) {
    if (!impactFactor || impactFactor <= 0) return "N/A";
    if (impactFactor >= 10) return "Q1";
    if (impactFactor >= 4) return "Q1-Q2";
    if (impactFactor >= 2) return "Q2-Q3";
    if (impactFactor >= 0.5) return "Q3-Q4";
    return "Q4";
  }

  function formatCount(n) {
    if (!n) return "0";
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "K";
    return String(n);
  }

  // ── 持续注入 ──
  // 因为 paper-search-ui.js 每次 render() 都重写 innerHTML，我们需要用 MutationObserver 重新注入 Tab
  let _debounce = null;
  const obs = new MutationObserver(() => {
    clearTimeout(_debounce);
    _debounce = setTimeout(() => injectJournalTab(), 50);
  });

  // 监听 ps-container 出现
  const waitForContainer = () => {
    const c = document.getElementById("ps-container");
    if (c) {
      injectJournalTab();
      obs.observe(c, { childList: true, subtree: true });
    } else {
      setTimeout(waitForContainer, 500);
    }
  };

  // 在文献工作区显示时启动
  const rootObs = new MutationObserver(() => {
    if (!root.classList.contains("hidden")) {
      setTimeout(waitForContainer, 200);
    }
  });
  rootObs.observe(root, { attributes: true, attributeFilter: ["class"] });
  if (!root.classList.contains("hidden")) setTimeout(waitForContainer, 200);

  // 监听搜索事件：当用户在期刊 Tab 下按回车搜索
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const tabBar = document.querySelector("#ps-container .ps-tab-bar");
      if (!tabBar) return;
      const activeTab = tabBar.querySelector(".ps-tab.active");
      if (activeTab && activeTab.dataset.psTab === "journals") {
        e.preventDefault();
        e.stopPropagation();
        searchJournals();
      }
    }
  }, true);
})();
