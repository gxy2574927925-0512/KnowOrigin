// 文献精读模块（scholread 阅读器）：与 app.js 解耦（IIFE），通过 window.KnowOriginLiterature 暴露入口。
// 依赖 app.js 的全局 api()（fetch 封装，自动 401）与 logout()。
(function () {
  "use strict";

  const root = document.getElementById("literature-workspace");
  if (!root) return;

  const $s = (sel, scope) => (scope || document).querySelector(sel);
  const $$s = (sel, scope) => [...(scope || document).querySelectorAll(sel)];
  const esc = (v) =>
    String(v == null ? "" : v).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));

  const NOTE_PREFIX = "knoworigin-lit-note:";
  const HL_PREFIX = "knoworigin-lit-hl:";
  const NOTES_KEY = "knoworigin-lit-notes:";
  const FONT_KEY = "knoworigin-lit-fontsize";
  const ASIDE_KEY = "knoworigin-lit-aside-w";
  const TRAN_KEY = "knoworigin-lit-trans-w";
  const AIHL_KEY = "knoworigin-lit-aihl:";   // AI 解释/问答 内容里的划词高亮（按文档粒度）
  const AIHL_COLOR = "rgba(76,175,80,0.32)";
  const KP_KEY = "knoworigin-lit-keypoints:"; // 用户对阅读重点的本地增删改（aiOverrides + added）
  // 标注写远程前的防抖窗口：本地先落盘、界面立刻可见，稍后再同步到服务器
  const MARK_SYNC_DELAY = 600;

  const store = {
    items: [],
    currentId: null,
    detail: null,
    translationMap: new Map(),
    // 「全文翻译」自动产出的段落集合（含切文献时从服务端恢复的历史译文）。
    // 开关只控制这批译文的显隐；手动点「译」的段落会从这里移除、始终常显。
    // 只存段落原文，不存译文 —— 译文仍旧只有 translationMap 一份，不重复占内存。
    autoTranslated: new Set(),
    search: "",
    compareIds: new Set(),
    noteTimer: null,
    autoTrans: false,
    highlightMode: false,
    fontsize: 15,
    qaHistory: [],
    qaBusy: false,
    qaSelection: null, // 兼容旧引用，已改用 qaSelections 数组
    qaSelections: [], // [{id, kind:"text"|"fig"|"formula", label, text}] 原页选中的提问上下文（可多个）
    insights: null, // { suggested_questions, keypoints }
    kpEditing: null, // { mode:"add"|"edit", id, heading, summary, quote } 阅读重点编辑器状态
    activeTab: "qa",
    showingLibrary: true,
    readingTimer: null,
    readingSeconds: 0,
    pendingDeleteId: null,
    tocLevel: 0,
    autoHighlights: [],
    readMode: "original", // "original"(原文页图) | "text"(文理/翻译)
    originalMeta: null,   // { n, is_scanned, pages:[{page,w,h,formula_regions}] }
    originalPage: 0,
    originalZoom: 1,
    originalHl: [],       // [{id, page, line, text}]
    // —— 文献标注：服务器为准、localStorage 兜底（跟着账号走，换设备能看见）——
    markHl: [],                              // 原页/文理高亮
    markAiHl: new Map(),                     // AI 与问答气泡内的划词高亮：回答块 key → 记录列表
    markKp: { aiOverrides: {}, added: [] },  // 阅读重点的用户增删改
    markNotes: [],                           // 划词笔记
    markNote: "",                            // 阅读笔记正文
    marksReady: false,                       // 当前文献的标注是否已从服务器拉到
    markSyncTimers: new Map(),
  };

  function el(id) { return document.getElementById(id); }

  // AI 问答消息唯一 id（供问答气泡内高亮按消息持久化）
  let _qid = 0;
  const qidSeq = () => "q-" + (Date.now() % 100000000) + "-" + (++_qid);

  function formatReadingInfo(project) {
    const parts = [];
    if (project.last_opened_at) {
      const d = new Date(project.last_opened_at);
      const now = new Date();
      const diffMs = now - d;
      const diffMin = Math.floor(diffMs / 60000);
      if (diffMin < 1) parts.push("刚刚");
      else if (diffMin < 60) parts.push(`${diffMin} 分钟前`);
      else if (diffMin < 1440) parts.push(`${Math.floor(diffMin / 60)} 小时前`);
      else parts.push(`${Math.floor(diffMin / 1440)} 天前`);
    }
    if (project.total_reading_seconds > 0) {
      const mins = Math.max(1, Math.round(project.total_reading_seconds / 60));
      parts.push(`阅读 ${mins} 分钟`);
    }
    return parts.join(" · ");
  }

  function startReadingTimer() {
    stopReadingTimer();
    store.readingSeconds = 0;
    store.readingTimer = setInterval(() => {
      if (document.visibilityState === "visible") {
        store.readingSeconds += 30;
      }
    }, 30000);
  }

  function stopReadingTimer() {
    if (store.readingTimer) {
      clearInterval(store.readingTimer);
      store.readingTimer = null;
      if (store.readingSeconds > 0 && store.currentId) {
        const delta = store.readingSeconds;
        store.readingSeconds = 0;
        window.api(`/api/literature/${encodeURIComponent(store.currentId)}/reading-progress`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reading_time_delta: delta }),
        }).catch(() => {});
      }
    }
  }

  let _scrollSaveTimer = null;
  function saveScrollPosition() {
    if (!store.currentId) return;
    const body = el("lit-reader-body");
    if (!body) return;
    const pos = body.scrollHeight > body.clientHeight
      ? body.scrollTop / (body.scrollHeight - body.clientHeight)
      : 0;
    clearTimeout(_scrollSaveTimer);
    _scrollSaveTimer = setTimeout(() => {
      window.api(`/api/literature/${encodeURIComponent(store.currentId)}/reading-progress`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ last_position: Math.round(pos * 1000) / 1000 }),
      }).catch(() => {});
    }, 2000);
  }

  function restoreScrollPosition() {
    const body = el("lit-reader-body");
    if (!body) return;
    const project = store.detail?.project;
    if (!project || !project.last_position) return;
    setTimeout(() => {
      const maxScroll = body.scrollHeight - body.clientHeight;
      if (maxScroll > 0) {
        body.scrollTop = project.last_position * maxScroll;
      }
    }, 300);
  }

  // —— 字号 ——
  function applyFontsize() {
    root.style.setProperty("--sr-font-size", store.fontsize + "px");
  }
  function changeFontsize(delta) {
    store.fontsize = Math.max(12, Math.min(22, store.fontsize + delta));
    try { localStorage.setItem(FONT_KEY, String(store.fontsize)); } catch {}
    applyFontsize();
  }

  // —— 进入 / 退出 ——
  function enter() {
    root.classList.remove("hidden");
    const workspace = document.getElementById("workspace");
    if (workspace) workspace.classList.add("hidden");
    applyFontsize();
    loadLibrary();
    loadLibraryLinks();
    showLibraryPanel(true);
  }
  function exit() {
    stopReadingTimer();
    root.classList.add("hidden");
    const workspace = document.getElementById("workspace");
    if (workspace) workspace.classList.remove("hidden");
  }
  function isVisible() { return !root.classList.contains("hidden"); }

  // —— 切换账号：清空上一个账号留在前端的一切 ——
  // 文献数据在后端本就按 owner 隔离，但 literature.js 的状态都在闭包里、
  // 已渲染的正文还在 DOM 上：不清的话，B 登录后点「文章阅读」，
  // 中栏仍是 A 那篇论文的正文，翻译 / 问答 / 阅读重点 / 原页高亮也一并留着。
  function reset() {
    stopReadingTimer();
    store.items = [];
    store.currentId = null;
    store.detail = null;
    store.translationMap = new Map();
    store.autoTranslated = new Set();
    store.qaHistory = [];
    store.qaSelections = [];
    store.qaSelection = null;
    store.qaBusy = false;
    store.insights = null;
    store.kpEditing = null;
    store.autoHighlights = [];
    store.originalMeta = null;
    store.originalPage = 0;
    store.originalZoom = 1;
    store.originalHl = [];
    store.compareIds = new Set();
    store.pendingDeleteId = null;
    store.search = "";
    store.readingSeconds = 0;
    store.autoTrans = false;
    store.highlightMode = false;
    store.activeTab = "qa";
    store.readMode = "original";
    window.clearTimeout(store.noteTimer);
    store.noteTimer = null;
    for (const timer of store.markSyncTimers.values()) window.clearTimeout(timer);
    store.markSyncTimers = new Map();
    resetMarkState();
    const searchEl = el("lit-search");
    if (searchEl) searchEl.value = "";
    for (const id of ["lit-qa-messages", "lit-toc-body", "lit-figures-body",
                      "lit-keypoints-body", "lit-highlights-body", "lit-notes-body"]) {
      const node = el(id);
      if (node) node.innerHTML = "";
    }
    const noteEl = el("lit-note");
    if (noteEl) noteEl.value = "";
    const askEl = el("lit-qa-input");
    if (askEl) askEl.value = "";
    _hideLitProgress();
    renderLibrary();
    renderReader();
    updateCompareBar();
    notifySelection();
    root.classList.add("hidden");
  }


  // —— 文献库数据 ——
  async function loadLibrary() {
    const listEl = el("lit-list");
    if (!listEl) return;
    try {
      const data = await window.api("/api/literature");
      store.items = data.literature || [];
    } catch (error) {
      store.items = [];
      listEl.innerHTML = `<div class="lit-error">${esc(error.message)}</div>`;
    }
    renderLibrary();
  }

  function filteredItems() {
    const q = store.search.trim().toLowerCase();
    return store.items.filter(({ project, meta }) => {
      if (!q) return true;
      const hay = [
        meta.title, project.subject, meta.authors, meta.year, meta.venue,
        (meta.keywords || []).join(" "), (project.tags || []).join(" "),
      ].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }

  function renderLibrary() {
    const listEl = el("lit-list");
    if (!listEl) return;
    const items = filteredItems();
    const libBtn = el("lit-library-toggle");
    if (libBtn && !store.showingLibrary) syncLibraryToggleLabel();

    if (!store.items.length) {
      listEl.className = "lit-list empty-state";
      listEl.innerHTML = `<p>还没有文献。点击「导入论文」上传 PDF 或粘贴文本。</p>`;
      updateCompareBar();
      return;
    }
    if (!items.length) {
      listEl.className = "lit-list empty-state";
      listEl.innerHTML = `<p>没有匹配的文献，试试调整筛选条件。</p>`;
      updateCompareBar();
      return;
    }

    listEl.className = "lit-list";
    listEl.innerHTML = items.map(({ project, meta }) => {
      const title = meta.title || project.subject || "未命名论文";
      const authors = meta.authors || "";
      const venueYear = [meta.venue, meta.year].filter(Boolean).join(" · ");
      const tags = (project.tags || []).map((t) => `<span class="lit-tag">${esc(t)}</span>`).join("");
      const active = project.project_id === store.currentId ? " active" : "";
      const checked = store.compareIds.has(project.project_id);
      const readingInfo = formatReadingInfo(project);
      return `
        <div class="lit-item${active}">
          <button class="lit-item-check${checked ? " checked" : ""}" type="button" data-lit-action="toggle-compare" data-id="${esc(project.project_id)}" role="checkbox" aria-checked="${checked ? "true" : "false"}" aria-label="选择用于对比">
            <span class="lit-checkmark" aria-hidden="true"></span>
          </button>
          <button class="lit-item-main" type="button" data-lit-action="select" data-id="${esc(project.project_id)}">
            <span class="lit-item-title">${esc(title)}</span>
            <span class="lit-item-sub">${esc([authors, venueYear].filter(Boolean).join(" · ") || "尚未抽取元数据")}</span>
            ${tags ? `<span class="lit-item-tags">${tags}</span>` : ""}
            ${readingInfo ? `<span class="lit-item-reading-info">${readingInfo}</span>` : ""}
          </button>
          <button class="lit-item-delete" type="button" data-lit-action="delete" data-id="${esc(project.project_id)}" aria-label="删除文献" title="删除">×</button>
        </div>`;
    }).join("");
    updateCompareBar();
  }

  function updateCompareBar() {
    const countEl = el("lit-compare-count");
    const btn = el("lit-compare-button");
    const clearBtn = el("lit-compare-clear");
    if (!countEl || !btn) return;
    const n = store.compareIds.size;
    countEl.textContent = `已选 ${n} 篇`;
    countEl.classList.toggle("has-selected", n > 0);
    btn.disabled = n < 2 || n > 4;
    if (n < 2) {
      btn.title = "请先勾选 2~4 篇文献进行文本对比";
    } else if (n > 4) {
      btn.title = "最多支持 4 篇文献同时对比";
    } else {
      btn.title = `对已选的 ${n} 篇文献生成深度 AI 综合对比报告`;
    }
    if (clearBtn) {
      clearBtn.classList.toggle("hidden", n === 0);
    }
  }

  function openLitDeleteDialog(id) {
    store.pendingDeleteId = id;
    const dialog = el("lit-delete-dialog");
    const nameEl = el("lit-delete-name");
    if (!dialog || !nameEl) return;
    const item = store.items.find((it) => it.project.project_id === id);
    const meta = item?.meta || {};
    nameEl.textContent = meta.title || item?.project.subject || "未命名论文";
    dialog.showModal();
  }

  async function confirmLitDelete() {
    const id = store.pendingDeleteId;
    if (!id) return;
    try {
      await window.api(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
      store.items = store.items.filter((it) => it.project.project_id !== id);
      store.compareIds.delete(id);
      notifySelection();
      if (store.currentId === id) {
        store.currentId = null;
        store.detail = null;
        stopReadingTimer();
      }
      el("lit-delete-dialog").close();
      renderLibrary();
      notifyProjectsChanged();
      if (!store.currentId) {
        const titleEl = el("lit-reader-title");
        if (titleEl) titleEl.textContent = "选择一篇文献开始精读";
        const body = el("lit-reader-body");
        if (body) body.innerHTML = `<div class="lit-reader-empty"><span class="compass">文</span><h3>还没有选中的文献</h3><p>点击左上角的书形图标打开文献库，选一篇开始阅读、翻译与问答。</p></div>`;
      }
    } catch (error) {
      showReaderError(error.message);
    }
  }

  async function selectLiterature(id, force = false) {
    if (!force && store.currentId === id && store.detail) {
      store.currentId = id;
      onLiteratureReady();
      return;
    }
    const listEl = el("lit-list");
    if (listEl) listEl.classList.add("is-loading");
    try {
      const detail = await window.api(`/api/literature/${encodeURIComponent(id)}`);
      store.detail = detail;
      store.currentId = id;
      // 切换文献：原页元数据/页码/缩放必须重置，否则 loadOriginalMeta 复用上一篇的
      // 缓存（nOrigPages 会被上一篇的页数限制，导致「只能显示几页」）。
      store.originalMeta = null;
      store.originalPage = 0;
      store.originalZoom = 1;
      store.translationMap = new Map(
        (detail.translations || []).map((s) => [s.source_text, s.translated_text])
      );
      // 服务端历史译文一律按「自动全文翻译」记账：开关关着时整篇不显示，
      // 打开开关立刻恢复全文对照（缓存命中，不重新调模型）。
      // 否则会出现「没开全文翻译，译文块却已经铺满正文，开关只剩划线下划线」的怪相。
      store.autoTranslated = new Set(store.translationMap.keys());
      store.qaHistory = [];
      store.qaSelections = [];
      store.qaSelection = null;
      store.insights = null;
      // 标注（高亮 / 阅读重点增删改 / 划词笔记 / 阅读笔记）跟着账号走：切文献时从服务器拉一次，
      // 必须赶在 restoreOriginalHighlights() 之前，否则会读到上一篇的缓存。
      await loadMarks(id);
      // 切换文献：原页高亮重置后从持久化存储恢复，保证刷新/重开仍有原页高亮
      store.originalHl = [];
      restoreOriginalHighlights();
      onLiteratureReady();
    } catch (error) {
      showReaderError(error.message);
    } finally {
      if (listEl) listEl.classList.remove("is-loading");
    }
  }

  function onLiteratureReady() {
    renderLibrary();
    renderReader();
    renderMeta();
    renderAllTabs();
    renderQA();
    loadNote(store.currentId);
    loadInsights();
    showLibraryPanel(false);
    if (store.autoTrans) autoTranslateEnglish();
    startReadingTimer();
    restoreScrollPosition();
  }

  // 勾选集合一变就广播一次：对比视图的「已选 N 篇 / 生成按钮」就挂在 onSelectionChange 上
  function notifySelection() {
    const bridge = window.KnowOriginLiterature;
    if (bridge && typeof bridge.onSelectionChange === "function") bridge.onSelectionChange();
  }

  function toggleCompare(id) {
    if (store.compareIds.has(id)) store.compareIds.delete(id);
    else store.compareIds.add(id);
    renderLibrary();
    notifySelection();
  }

  // —— 导入 ——
  const IMPORT_TIMEOUT_MS = 300000;  // 5 分钟，涵盖自动 AI 整理排版时间
  function openFilePicker() { el("lit-file-input")?.click(); }
  async function onFileSelected(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;
    await importLiterature({ file });
  }
  function _updateLitProgress(percent, label, detail) {
    const prog = el("lit-import-progress");
    if (!prog) return;
    prog.classList.remove("hidden");
    const strong = prog.querySelector("strong");
    const span = prog.querySelector("span");
    const track = prog.querySelector("i");
    const p = prog.querySelector(".lit-import-progress-detail");
    if (strong) strong.textContent = label;
    if (span) span.textContent = `${Math.round(percent)}%`;
    if (track) track.style.width = `${Math.round(percent)}%`;
    if (p) p.textContent = detail;
  }
  function _hideLitProgress() {
    const prog = el("lit-import-progress");
    if (prog) prog.classList.add("hidden");
  }
  function importLiterature({ file, pastedText, title }) {
    // 流式导入：使用 SSE 端点，支持边提取边渲染
    if (file && !pastedText) {
      return importLiteratureStream({ file, title });
    }
    // 粘贴文本回退：使用原有同步端点
    return importLiteratureSync({ file, pastedText, title });
  }

  async function importLiteratureStream({ file, title }) {
    const btn = el("lit-upload-button");
    const body = el("lit-reader-body");
    if (btn) { btn.disabled = true; btn.innerHTML = "<span class=\"btn-spinner\" aria-hidden=\"true\"></span> 正在导入…"; }

    // 临时显示进度 + 渲染区
    _updateLitProgress(0, "正在提取 PDF", "正在逐页提取文本与图片…");
    let accumulatedText = "";
    // 临时占位 store 用于渐进渲染
    const tempSourceId = "__streaming__";
    const tempProjectId = "__streaming__";
    if (!store.detail) store.detail = {};
    store.detail.sources = [{ source_id: tempSourceId, text: "", figures: [] }];
    store.currentId = tempProjectId;

    const fd = new FormData();
    fd.append("file", file);
    if (title) fd.append("title", title);
    fd.append("auto_rearrange", "true");

    const controller = new AbortController();
    // 活动态超时：只要持续收到 SSE 进展就不中止（OCR/提取可能超过 5 分钟）。
    // 注意「最后一页提取完 → done」之间有一段无法发事件的同步收尾（公式标记、
    // 段落重排、图片回填、落库），长文献下可达数十秒，阈值取 5 分钟与同步导入
    // 路径的 IMPORT_TIMEOUT_MS 保持一致，避免后端其实已成功却被前端判定超时。
    const INACTIVITY_TIMEOUT_MS = 300000;
    let timer = null;
    function resetStreamTimeout() {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => controller.abort(), INACTIVITY_TIMEOUT_MS);
    }
    resetStreamTimeout();

    try {
      const response = await fetch("/api/literature/stream", {
        method: "POST",
        body: fd,
        signal: controller.signal,
        credentials: "same-origin",
      });

      if (!response.ok) {
        const errText = await response.text();
        let errMsg = `请求失败（${response.status}）`;
        try {
          const errJson = JSON.parse(errText);
          errMsg = (errJson.detail && errJson.detail.message) || errMsg;
        } catch (e) { /* ignore */ }
        throw new Error(errMsg);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let lastRenderTime = 0;
      let pageCount = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        resetStreamTimeout();
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const dataStr = line.slice(6);
          let event;
          try { event = JSON.parse(dataStr); } catch (e) { continue; }

          switch (event.type) {
            case "start":
              pageCount = event.total_pages || 0;
              _updateLitProgress(0, "正在提取 PDF", `共 ${pageCount} 页，正在逐页提取…`);
              break;
            case "page_progress":
              _updateLitProgress(
                Math.round((event.page / event.total) * 70),
                `正在提取第 ${event.page}/${event.total} 页`,
                "正在逐页提取文本与图片…"
              );
              break;
            case "page_text":
              accumulatedText += (accumulatedText ? "\n\n" : "") + (event.text || "");
              if (event.figures && event.figures.length) {
                const existingFigs = store.detail.sources[0].figures || [];
                store.detail.sources[0].figures = event.figures;
              }
              // 节流渐进渲染：每 2 页或 500ms 刷新一次
              const now = Date.now();
              if (event.page % 2 === 0 || now - lastRenderTime > 500) {
                store.detail.sources[0].text = accumulatedText;
                lastRenderTime = now;
                try { renderReader(); } catch (e) { /* ignore render errors during streaming */ }
              }
              break;
            case "processing":
              _updateLitProgress(75, event.stage === "ai_rearrange" ? "AI 整理排版中" : "后处理中",
                event.stage === "ai_rearrange" ? "正在用 AI 整理公式与段落，请稍候…" : "正在标记公式与标题…");
              break;
            case "done":
              window.clearTimeout(timer);
              if (btn) { btn.disabled = false; btn.innerHTML = "＋ 导入论文"; }
              // 清理临时状态
              store.currentId = null;
              store.detail = null;
              // 添加到列表
              store.items.unshift({ project: event.project, meta: event.meta || {} });
              renderLibrary();
              notifyProjectsChanged();
              // 选中并加载完整文献
              const doneMeta = event.meta || {};
              selectLiterature(event.project.project_id).then(() => {
                if (store.detail && (!store.detail.meta || store.detail.meta.extract_status !== "done")) {
                  extractMeta();
                } else {
                  _hideLitProgress();
                }
                // 后台 AI 整理排版进行中：显示横幅并轮询，完成后自动刷新（与元数据抽取相互独立）
                if (doneMeta.ai_rearrange === "pending") {
                  _updateLitProgress(100, "AI 整理排版中…",
                    "论文已导入，后台正在整理公式与段落，完成后自动刷新");
                  pollRearrange(event.project.project_id);
                }
              });
              return;
            case "error":
              throw new Error(event.message || "导入失败");
          }
        }
      }
    } catch (error) {
      window.clearTimeout(timer);
      _hideLitProgress();
      if (btn) { btn.disabled = false; btn.innerHTML = "＋ 导入论文"; }
      store.currentId = null;
      store.detail = null;
      if (error.name === "AbortError") {
        showReaderError("导入超时：解析 PDF 与 AI 整理排版耗时较长。请稍后在「我的文献」中查看论文是否已导入，必要时可手动点击「AI 整理排版」。");
      } else {
        showReaderError(error.message || "网络错误，请检查本地服务是否在运行。");
      }
      throw error;
    }
  }

  function importLiteratureSync({ file, pastedText, title }) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      if (file) fd.append("file", file);
      if (pastedText) fd.append("pasted_text", pastedText);
      if (title) fd.append("title", title);
      const btn = el("lit-upload-button");
      if (btn) { btn.disabled = true; btn.innerHTML = "<span class=\"btn-spinner\" aria-hidden=\"true\"></span> 导入并 AI 整理中…"; }

      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/literature");
      xhr.withCredentials = true;
      const timer = window.setTimeout(() => xhr.abort(), IMPORT_TIMEOUT_MS);

      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
          const pct = (e.loaded / e.total) * 100;
          _updateLitProgress(pct, "正在上传文件", `已上传 ${formatBytes(e.loaded)} / ${formatBytes(e.total)}`);
        }
      });

      xhr.addEventListener("readystatechange", () => {
        if (xhr.readyState === XMLHttpRequest.HEADERS_RECEIVED) {
          _updateLitProgress(100, "上传完成，AI 整理排版中", "正在解析论文并自动整理排版，请稍候…");
        }
      });

      xhr.addEventListener("load", async () => {
        window.clearTimeout(timer);
        _hideLitProgress();
        if (btn) { btn.disabled = false; btn.innerHTML = "＋ 导入论文"; }
        try {
          const res = JSON.parse(xhr.responseText);
          if (xhr.status < 200 || xhr.status >= 300) {
            const detail = res.detail && typeof res.detail === "object" ? res.detail : res;
            const err = new Error(detail.message || `请求失败（${xhr.status}）`);
            err.status = xhr.status;
            throw err;
          }
          store.items.unshift({ project: res.project, meta: res.meta || {} });
          renderLibrary();
          notifyProjectsChanged();
          store.currentId = null;
          await selectLiterature(res.project.project_id);
          if (store.detail && (!store.detail.meta || store.detail.meta.extract_status !== "done")) {
            extractMeta();
          }
          resolve(res);
        } catch (error) {
          showReaderError(error.message);
          reject(error);
        }
      });

      xhr.addEventListener("error", () => {
        window.clearTimeout(timer);
        _hideLitProgress();
        if (btn) { btn.disabled = false; btn.innerHTML = "＋ 导入论文"; }
        showReaderError("网络错误，请检查本地服务是否在运行。");
        reject(new Error("网络错误"));
      });

      xhr.addEventListener("abort", () => {
        window.clearTimeout(timer);
        _hideLitProgress();
        if (btn) { btn.disabled = false; btn.innerHTML = "＋ 导入论文"; }
        showReaderError("导入超时：解析 PDF 与 AI 整理排版耗时较长。请稍后在「我的文献」中查看论文是否已导入，必要时可手动点击「AI 整理排版」。");
        reject(new Error("导入超时"));
      });

      xhr.send(fd);
    });
  }

  async function pollRearrange(projectId, attempts) {
    // 后台 AI 整理排版完成后自动刷新正文；attempts 未传时默认 250 次（4s 间隔 ≈ 16 分钟）
    if (attempts == null) attempts = 250;
    if (attempts <= 0) { _hideLitProgress(); return; }
    let state = "running";
    try {
      const res = await window.api(`/api/literature/${encodeURIComponent(projectId)}/rearrange-status`);
      state = res.state || "running";
    } catch (e) { /* 网络抖动时继续轮询 */ }
    if (state === "done") {
      _hideLitProgress();
      if (store.currentId === projectId) await selectLiterature(projectId, true);
      return;
    }
    if (state === "failed" || state === "idle") {
      _hideLitProgress();
      return;
    }
    window.setTimeout(() => pollRearrange(projectId, attempts - 1), 4000);
  }
  function openPasteDialog() {
    const dialog = el("lit-paste-dialog");
    if (!dialog) return;
    $s("#lit-paste-title", dialog).value = "";
    $s("#lit-paste-text", dialog).value = "";
    dialog.showModal();
  }
  function submitPaste(event) {
    event.preventDefault();
    const dialog = el("lit-paste-dialog");
    const text = $s("#lit-paste-text", dialog).value.trim();
    if (!text) return;
    const title = $s("#lit-paste-title", dialog).value.trim();
    dialog.close();
    importLiterature({ pastedText: text, title: title || undefined });
  }

  // —— 库面板 / 标签切换 ——
  /**
   * 「文献库」顶栏按钮的文案同步。
   * ⚠️ 绝不能写 btn.textContent —— 按钮可见区域只剩一支书图标，textContent 会把
   *    里面的 <svg> 一起抹掉（原来就是踩了这个坑：图标不见了，只剩一行文字）。
   *    现在：动作名 → title / aria-label，篇数 → 右上角徽标。
   * @param {boolean} [show] 库面板是否展开；省略时按 store.showingLibrary 现状同步。
   */
  function syncLibraryToggleLabel(show) {
    const btn = el("lit-library-toggle");
    if (!btn) return;
    const showing = show === undefined ? !!store.showingLibrary : !!show;
    const n = store.items.length;
    btn.title = showing
      ? "返回精读界面"
      : `打开文献库管理面板${n ? `（已收录 ${n} 篇）` : "（还没有文献）"}`;
    btn.setAttribute("aria-label", showing ? "返回阅读" : "文献库");
    btn.setAttribute("aria-pressed", showing ? "true" : "false");
    const badge = el("lit-library-count");
    if (badge) {
      badge.textContent = String(n);
      badge.hidden = showing || !n;
    }
  }

  function showLibraryPanel(show) {
    store.showingLibrary = show;
    const panel = el("lit-library-panel");
    if (panel) panel.classList.toggle("hidden", !show);
    $$s(".sr-panel[data-panel]").forEach((p) => p.classList.toggle("hidden", show));
    const tabs = $s(".sr-tabs");
    if (tabs) tabs.classList.toggle("hidden", show);
    syncLibraryToggleLabel(show);
    if (!show) {
      switchTab(store.activeTab);
      // 点「返回阅读」应回到资料原页：若对比视图还开着，一并收起，别停在对比视图上。
      // 对比视图用它自己模块的入口打开库面板（见 lit-compare-view.js showPanel），
      // 收起库面板时它自己并不知道，这里代为关掉。
      const cv = window.KnowOriginLitCompareView;
      if (cv && typeof cv.isOpen === "function" && cv.isOpen() && typeof cv.toggle === "function") {
        cv.toggle();
      }
    }
  }

  function switchTab(tab) {
    store.activeTab = tab;
    $$s(".sr-tab").forEach((t) => {
      const active = t.dataset.tab === tab;
      t.classList.toggle("active", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
    });
    $$s(".sr-panel[data-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== tab));
    // 同步目录下拉
    if (tab === "toc") {
      const sel = el("lit-toc-level");
      if (sel) sel.value = String(store.tocLevel || 0);
    }
    renderAllTabs();
  }

  function renderAllTabs() {
    renderToc();
    renderFigures();
    renderKeypoints();
    renderHighlights();
    renderNotes();
  }

  // —— 阅读正文 ——
  // 正文清洗：去除 PDF 提取残留的出版商锚点、连字乱码、控制字符与页脚碎片
  function sanitizeLitText(text) {
    let t = String(text || "");
    // Elsevier 内部锚点：EQ-TARGET;temp:intralink-;e006;114;116DOP → DOP
    t = t.replace(/EQ-TARGET;temp:[^;\n]*;(?:e\d+;\d+;)*\d+/gi, "");
    // PDF 连字/特殊编码：¼(=)、½、¾、fi/fl 等连字、零宽字符
    t = t.replace(/¼/g, "=").replace(/[½¾]/g, "")
      .replace(/ﬁ/g, "fi").replace(/ﬂ/g, "fl").replace(/ﬀ/g, "ff").replace(/ﬃ/g, "ffi").replace(/ﬄ/g, "ffl")
      .replace(/[\u200b\u200c\u200d\ufeff]/g, "");
    // 控制字符
    t = t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
    // 同一字符连打 20+ 次的乱码串（如 ffffff...）
    t = t.replace(/(.)\1{19,}/g, "");
    // 逐行剔除页脚/图表轴标注碎片
    t = t.split("\n").filter((line) => {
      const s = line.trim();
      if (!s) return true;
      if (/^\d{3,}[-\s]\d{1,3}$/.test(s)) return false;          // "066001-5" 文章编号+页码
      if (/^\d+\s+(?:of|\/)\s+\d+$/.test(s)) return false;       // "3 of 6" 页码
      if (/^\s*(?:[o0-9]+\s*deg\b\s*){1,}$/i.test(s)) return false; // "o deg / 90 deg / 180 deg" 轴标注
      return true;
    }).join("\n");
    return t;
  }

  function readerText() {
    const sources = store.detail?.sources || [];
    return sanitizeLitText(sources.map((s) => s.text || "").filter((t) => t.trim()).join("\n\n"));
  }

  function readerFigures() {
    const sources = store.detail?.sources || [];
    const out = [];
    const seenImg = new Set();
    for (const s of sources) {
      for (const f of (s.figures || [])) {
        if (!f || (!f.image && !f.caption)) continue;
        // 相同图片 URL 只保留首个：解析管线偶发为同一子图生成多条记录，避免重复渲染
        const img = String(f.image || "").trim();
        if (img) {
          if (seenImg.has(img)) continue;
          seenImg.add(img);
        }
        out.push(f);
      }
    }
    return out;
  }

  // 图表排序键：页码 × 10000 + 图号（无图号排最后），保证"图1→图2→…"顺序稳定
  function figSortKey(f) {
    const page = Number(f && f.page) || 0;
    const num = parseInt(figNumberPrefix(f && f.caption), 10)
      || parseInt(f && f.whole_ref && f.whole_ref.figure_number, 10)
      || 9999;
    return page * 10000 + Math.min(num, 9999);
  }

  // 渲染级图片去重：同一 URL（子图截图或整幅裁剪）在一次渲染中只出现一次
  const _renderedImgUrls = new Set();

  function figureBlockHtml(fig) {
    const cap = String(fig.caption || "").trim();
    const img = String(fig.image || "").trim();
    if (img && _renderedImgUrls.has(img)) return "";
    if (img) _renderedImgUrls.add(img);
    const isFallback = !!(fig._fallback);
    const imgHtml = img
      ? `<img class="sr-figure-img" src="${esc(img)}" alt="${esc(cap)}" loading="lazy" onerror="this.onerror=null;this.parentElement.innerHTML='<div class=\\'sr-figure-placeholder\\'><span class=\\'sr-figure-placeholder-icon\\'>&#x1F5BC;</span><span>图片加载失败</span></div>';">`
      : `<div class="sr-figure-placeholder"><span class="sr-figure-placeholder-icon">&#x1F5BC;</span><span>图片未能提取</span></div>`;
    const fallbackBadge = isFallback ? `<span class="sr-figure-fallback-badge" title="原始图片提取失败，已用页面截图替代">截图还原</span>` : "";
    const capHtml = cap ? `<figcaption class="sr-figure-caption">${esc(cap)}</figcaption>` : "";
    const figIdAttr = fig && fig.id !== undefined ? ` data-figure-id="${esc(String(fig.id))}"` : "";
    return `<figure class="sr-figure-block"${figIdAttr}>${fallbackBadge}${imgHtml}${capHtml}</figure>`;
  }

  // —— 复合图（multi-panel）识别与合并 ——
  // 论文中一幅图常被拆成多个子图（同页码、同图号）。这里按“页码+图号”合并，
  // 用整幅区域的 PDF 裁剪显示，并给每个子图打上 A/B/C/D 标记，保留原图层次。
  function figNumberPrefix(cap) {
    const c = String(cap || "");
    const m = /^\s*(?:Fig(?:ure)?\.?\s*(\d+)|Table\.?\s*(\d+)|图\s*(\d+))\b/i.exec(c);
    return m ? (m[1] || m[2] || m[3]) : (m && m[0]) || "";
  }

  function buildFallbackPanels(members) {
    const boxes = (members || []).filter((m) => Array.isArray(m.bbox) && m.bbox.length === 4)
      .slice().sort((a, b) => ((a.bbox[1] - b.bbox[1]) * 10000 + (a.bbox[0] - b.bbox[0])));
    return boxes.map((m, i) => { m._label = String.fromCharCode(65 + i); return m; });
  }

  // 后端整幅区域引用（whole_ref）已把同页同型号的成员（含无图注的子面板碎片）合并成一幅。
  // 所有成员共享同一个 whole_ref.bbox，故以“页码+整幅bbox”为分组键，把无图注碎片也折进同一复合图。
  function buildFigureGroups() {
    const figs = readerFigures();
    const groups = [];
    const wholeMap = new Map();
    const capMap = new Map();
    let singleIdx = 0;
    for (const f of figs) {
      if (!f) continue;
      const page = Number(f.page);
      if (f.whole_ref && Array.isArray(f.whole_ref.bbox) && f.whole_ref.bbox.length === 4) {
        const key = page + "|" + f.whole_ref.bbox.map((n) => Math.round(Number(n) * 10)).join(",");
        let g = wholeMap.get(key);
        if (!g) {
          g = {
            id: "g_" + page + "_w" + wholeMap.size,
            page: page,
            num: String(f.whole_ref.figure_number || ""),
            u: f.whole_ref.bbox.map(Number),
            panels: (f.whole_ref.panels || []).map((p) => ({
              _label: String(p.label || ""),
              bbox: [Number(p.x0), Number(p.y0), Number(p.x1), Number(p.y1)],
            })),
            members: [],
          };
          wholeMap.set(key, g);
        }
        g.members.push(f);
      } else {
        const num = figNumberPrefix(f.caption);
        if (num && Number.isFinite(page)) {
          const key = page + "|" + num;
          if (!capMap.has(key)) capMap.set(key, []);
          capMap.get(key).push(f);
        } else {
          groups.push({ id: f.id !== undefined ? String(f.id) : "g_s_" + (singleIdx++), members: [f] });
        }
      }
    }
    for (const g of wholeMap.values()) {
      const panels = (g.panels && g.panels.length) ? g.panels : buildFallbackPanels(g.members);
      groups.push({
        id: g.id,
        page: g.page,
        num: g.num,
        members: g.members,
        composite: panels,
        union: g.u,
        wholeBbox: g.u,
      });
    }
    for (const [key, list] of capMap) {
      const page = Number(key.split("|")[0]);
      const num = figNumberPrefix((list[0] && list[0].caption) || "");
      const boxes = list.filter((m) => Array.isArray(m.bbox) && m.bbox.length === 4);
      if (boxes.length >= 2) {
        const u = [Infinity, Infinity, -Infinity, -Infinity];
        for (const b of boxes) {
          u[0] = Math.min(u[0], b[0]); u[1] = Math.min(u[1], b[1]);
          u[2] = Math.max(u[2], b[2]); u[3] = Math.max(u[3], b[3]);
        }
        const panels = buildFallbackPanels(list);
        groups.push({ id: "g_c_" + key, page: page, num: num, members: list, composite: panels, union: u });
      } else {
        for (const f of list) groups.push({ id: f.id !== undefined ? String(f.id) : "g_c_" + (singleIdx++), members: [f] });
      }
    }
    const figToGroup = {};
    const groupsById = {};
    for (const g of groups) {
      groupsById[g.id] = g;
      for (const m of g.members) if (m.id !== undefined) figToGroup[String(m.id)] = g;
    }
    // 全局排序：页码优先、图号次之，保证正文/图表栏中图表按论文编号顺序出现
    groups.sort((a, b) => figSortKey((a.members && a.members[0]) || a) - figSortKey((b.members && b.members[0]) || b));
    _figToGroup = figToGroup;
    _figGroupsById = groupsById;
    return groups;
  }

  // 整幅裁剪加载失败时的兜底：退回第一个带截图的子图，再失败才显示占位
  window.__litCropFail = function (imgEl) {
    imgEl.onerror = null;
    const gid = imgEl.getAttribute("data-crop-group");
    const grp = (typeof _figGroupsById !== "undefined") && _figGroupsById && _figGroupsById[gid];
    const member = grp && (grp.members || []).find((m) => m && String(m.image || "").trim());
    if (member && imgEl.dataset.cropFallbackDone !== "1") {
      imgEl.dataset.cropFallbackDone = "1";
      imgEl.src = member.image;
      return;
    }
    const wrap = imgEl.parentElement;
    if (wrap) wrap.innerHTML = '<div class="sr-figure-placeholder"><span class="sr-figure-placeholder-icon">&#x1F5BC;</span><span>整幅图加载失败</span></div>';
  };

  function groupCaption(g) {
    for (const m of (g && g.members) || []) {
      const c = String((m && m.caption) || "").trim();
      if (c) return c;
    }
    return "";
  }

  function groupTitleMember(g) {
    for (const m of (g && g.members) || []) if (String((m && m.caption) || "").trim()) return m;
    return (g && g.members && g.members[0]) || null;
  }

  function isCompositeGroup(g) { return !!(g && g.composite && g.composite.length >= 2); }

  // bbox 是否为「4 个有限数」。缺字段/undefined 经运算会变成 NaN，
  // 而 bbox=NaN,NaN,NaN,NaN 会被后端解析成 NaN 坐标（NaN 比较恒为 False，
  // 面积校验拦不住），最终 int(NaN) 抛 500，前端只看到一张裂图。
  function finiteBbox(bb) {
    return Array.isArray(bb) && bb.length === 4 && bb.every((v) => Number.isFinite(Number(v)));
  }

  function groupCropUrl(g, dpi) {
    const base = originalBase();
    if (!base || !g || !Number.isFinite(Number(g.page)) || !finiteBbox(g.union)) return "";
    return `${base}/page-crop?page=${g.page}&bbox=${g.union.join(",")}&dpi=${(dpi || 300)}`;
  }

  // 复合图块：整幅裁剪 + 每个子图左上角 A/B/C/D 标签（可点击定位到该子图）
  function groupBlockHtml(g) {
    if (!isCompositeGroup(g)) return figureBlockHtml(g.members[0]);
    const cap = groupCaption(g);
    const crop = groupCropUrl(g, 300);
    // 同一整幅裁剪（同页同 bbox）只渲染一次，防止重复大图
    if (crop && _renderedImgUrls.has(crop)) return "";
    if (crop) _renderedImgUrls.add(crop);
    const u = g.union;
    const w = u[2] - u[0]; const h = u[3] - u[1];
    const badges = g.composite.map((m) => {
      const b = m.bbox;
      return `<span class="sr-fig-panel-badge" style="left:${(b[0] - u[0]) / w * 100}%;top:${(b[1] - u[1]) / h * 100}%;" title="${esc(m._label)} 子图" data-lit-action="locate-sub" data-group="${esc(g.id)}" data-page="${g.page}" data-bbox="${b.join(",")}" data-union="${u.join(",")}">${m._label}</span>`;
    }).join("");
    const imgHtml = crop
      ? `<img class="sr-figure-img" src="${esc(crop)}" alt="${esc(cap)}" loading="lazy" data-crop-group="${esc(g.id)}" onerror="window.__litCropFail && window.__litCropFail(this);">`
      : `<div class="sr-figure-placeholder"><span class="sr-figure-placeholder-icon">&#x1F5BC;</span><span>图片未能提取</span></div>`;
    const capHtml = cap ? `<figcaption class="sr-figure-caption">${esc(cap)}</figcaption>` : "";
    return `<figure class="sr-figure-block sr-figure-composite" data-figure-id="${esc(g.id)}">
      <div class="sr-figure-composite-wrap">${imgHtml}${badges}</div>
      ${capHtml}
    </figure>`;
  }

  // 安全还原文本中的字面转义字符（如 \n、\t），严密保护 LaTeX 数学公式与宏名
  const _LATEX_T_N_CMDS = /\\(?:text[a-zA-Z]*|tau|theta|vartheta|times|to|top|tan|tanh|tilde|widetilde|tag|tfrac|tiny|triangle|triangleq|therefore|thicksim|thickapprox|nu|nabla|neq|ne|neg|notin|not|ni|natural|nearrow|nwarrow|nobreakspace|newcommand|normalsize|null)\b/g;

  function safeUnescapeEscapes(str) {
    if (!str) return "";
    // 1. 隔离显式数学块与占位符
    const mathHolders = [];
    let protectedStr = String(str).replace(
      /(\[\[MATH:[^\]]+\]\]|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$|\$(?!\$)[^$\n]+\$|\\begin\{[a-zA-Z*]+\}[\s\S]*?\\end\{[a-zA-Z*]+\})/g,
      (match) => {
        const id = `\u0001LITMATH_${mathHolders.length}\u0001`;
        mathHolders.push(match);
        return id;
      }
    );
    // 2. 隔离以 \t 和 \n 开头的 LaTeX 关键字，严防被撕裂为 ext、au、abla 等
    protectedStr = protectedStr.replace(_LATEX_T_N_CMDS, (match) => {
      const id = `\u0001LITMATH_${mathHolders.length}\u0001`;
      mathHolders.push(match);
      return id;
    });

    // 3. 安全替换普通文本中的转义字符
    let res = protectedStr
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t");

    // 4. 还原所有受保护的数学块与 LaTeX 命令
    if (mathHolders.length) {
      res = res.replace(/\u0001LITMATH_(\d+)\u0001/g, (_, i) => mathHolders[Number(i)] || "");
    }
    return res;
  }

  function splitParagraphs(text) {
    // 安全还原字面转义字符，避免破坏 LaTeX 关键字
    const cleaned = safeUnescapeEscapes(text);
    const raw = cleaned.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    const out = [];
    for (const block of raw) {
      if (block.length <= 2600) { out.push(block); continue; }
      for (let i = 0; i < block.length; i += 2600) out.push(block.slice(i, i + 2600));
    }
    return out;
  }

  function getHighlights(id) {
    if (!id) return [];
    if (id === store.currentId && store.marksReady) return clone(store.markHl) || [];
    try { return JSON.parse(localStorage.getItem(HL_PREFIX + id) || "[]"); } catch { return []; }
  }
  function saveHighlights(id, list) {
    if (id === store.currentId && store.marksReady) store.markHl = clone(list) || [];
    try { localStorage.setItem(HL_PREFIX + id, JSON.stringify(list)); } catch {}
    if (id === store.currentId) queueMarkSync("highlight", "", list);
  }
  // —— 文献标注的远程读写 ——
  // 原页高亮 / AI 划词高亮 / 阅读重点增删改 / 划词笔记 / 阅读笔记原先只存在浏览器
  // localStorage 里：换台设备就没了，也说不上「跟着账号走」。现在服务器为准、本地兜底：
  // 进文献时拉一次，写的时候本地先落、600ms 防抖再 PUT；服务器为空而本地有旧数据时上迁一次。
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

  function resetMarkState() {
    store.markHl = [];
    store.markAiHl = new Map();
    store.markKp = { aiOverrides: {}, added: [] };
    store.markNotes = [];
    store.markNote = "";
    // AI 解释（划词/图表/公式解释、论文问答）的落库缓存：slot -> payload。
    // 在此之前它们只活在内存与 DOM 里，刷新即失 —— 既不能回看，也导不出来。
    store.markQaAnswers = new Map();
    store.marksReady = false;
  }

  function localRead(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      const parsed = JSON.parse(raw);
      return parsed == null ? fallback : parsed;
    } catch (_) {
      return fallback;
    }
  }

  function pushMark(id, kind, slot, payload) {
    window.api(`/api/literature/${encodeURIComponent(id)}/marks`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, slot, payload }),
    }).catch(() => { /* 离线或失败就留在本地，下次写同类标注时再同步 */ });
  }

  // —— AI 解释落库（2026-09-28 新增）——
  // 三种解释入口（原页悬停解释 / 划词工具条解释 / 论文问答）此前都只把回答渲染进
  // DOM 与 store.qaHistory，**刷新即失**：既不能回看，也没法导出成文档。
  // 库里本来就有一张通用标注表 literature_marks（主键 project+kind+slot），
  // 直接借 kind="ai_answer" —— 零新表、零迁移。slot 用稳定键（位置或选中文本），
  // 同一处反复解释只覆盖不堆积。
  function saveAiAnswer(slot, payload) {
    if (!store.currentId || !slot) return;
    if (store.markQaAnswers) store.markQaAnswers.set(slot, payload);
    queueMarkSync("ai_answer", slot, payload);
  }

  function aiAnswerPayload(question, answer, sourceKind, page) {
    const text = String(answer || "").trim();
    if (!text) return null;
    return {
      question: String(question || "").slice(0, 4000),
      answer: String(answer || ""),
      source_kind: sourceKind || "qa",
      page: Number.isFinite(page) ? page : null,
      created_at: new Date().toISOString(),
    };
  }

  // 从落库的 AI 解释里重建问答历史：刷新 / 重开文献后对话还在。
  // 只重建 source_kind === "qa" 的（划词与图表解释属于「原文某一处」，
  // 不该混进问答面板；它们由导出文档按位置呈现）。
  function restoreQAHistory() {
    if (!store.markQaAnswers || !store.markQaAnswers.size) return;
    if (store.qaHistory.length) return;   // 本次会话已有对话，不覆盖
    const items = Array.from(store.markQaAnswers.entries())
      .map(([slot, payload]) => ({ slot, payload: payload || {} }))
      .filter((it) => it.payload.source_kind === "qa" && it.payload.answer)
      .sort((a, b) => String(a.payload.created_at || "").localeCompare(String(b.payload.created_at || "")));
    if (!items.length) return;
    const restored = [];
    for (const item of items) {
      const ts = Date.parse(item.payload.created_at) || Date.now();
      if (item.payload.question) {
        restored.push({ role: "user", text: item.payload.question, ts, uid: item.slot + "-u" });
      }
      restored.push({ role: "ai", text: item.payload.answer, ts, uid: item.slot });
    }
    store.qaHistory = restored;
  }

  function queueMarkSync(kind, slot, payload) {
    const id = store.currentId;
    if (!id) return;
    const timerKey = kind + "\u0000" + slot;
    window.clearTimeout(store.markSyncTimers.get(timerKey));
    store.markSyncTimers.set(timerKey, window.setTimeout(() => {
      store.markSyncTimers.delete(timerKey);
      pushMark(id, kind, slot, payload);
    }, MARK_SYNC_DELAY));
  }

  async function loadMarks(id) {
    resetMarkState();
    if (!id) return;
    let marks = null;
    try {
      const res = await window.api(`/api/literature/${encodeURIComponent(id)}/marks`);
      marks = Array.isArray(res && res.marks) ? res.marks : [];
    } catch (_) {
      return;   // 拉不到就退回本地缓存，阅读不中断
    }
    for (const m of marks) {
      if (!m) continue;
      if (m.kind === "highlight" && Array.isArray(m.payload)) {
        store.markHl = clone(m.payload);
      } else if (m.kind === "ai_highlight" && m.slot) {
        store.markAiHl.set(m.slot, clone(m.payload) || []);
      } else if (m.kind === "keypoints" && m.payload && typeof m.payload === "object") {
        store.markKp = { aiOverrides: m.payload.aiOverrides || {}, added: m.payload.added || [] };
      } else if (m.kind === "notes" && Array.isArray(m.payload)) {
        store.markNotes = clone(m.payload);
      } else if (m.kind === "note" && typeof m.payload === "string") {
        store.markNote = m.payload;
      } else if (m.kind === "ai_answer" && m.slot) {
        // 一条 AI 解释一格（slot = 稳定键）。这里只回填缓存，
        // 重建问答历史放在函数末尾，避免读到没加载完的中间状态。
        store.markQaAnswers.set(m.slot, clone(m.payload) || {});
      }
    }
    store.marksReady = true;
    migrateLocalMarks(id);
    restoreQAHistory();
  }

  // 老版本把标注留在浏览器里：第一次发现服务器上没有时，把本地那份推上去（只推非空的）。
  function migrateLocalMarks(id) {
    const jobs = [];
    if (!store.markHl.length) {
      const local = localRead(HL_PREFIX + id, []);
      if (Array.isArray(local) && local.length) jobs.push(["highlight", "", local]);
    }
    if (!store.markNotes.length) {
      const local = localRead(NOTES_KEY + id, []);
      if (Array.isArray(local) && local.length) jobs.push(["notes", "", local]);
    }
    if (!store.markNote) {
      const local = localRead(NOTE_PREFIX + id, "");
      if (typeof local === "string" && local) jobs.push(["note", "", local]);
    }
    const kpEmpty = !(store.markKp.added || []).length
      && !Object.keys(store.markKp.aiOverrides || {}).length;
    if (kpEmpty) {
      const local = localRead(KP_KEY + id, null);
      if (local && typeof local === "object"
          && (Object.keys(local.aiOverrides || {}).length || (local.added || []).length)) {
        jobs.push(["keypoints", "", {
          aiOverrides: local.aiOverrides || {},
          added: local.added || [],
        }]);
      }
    }
    let lsKeys = [];
    try { lsKeys = Object.keys(localStorage); } catch (_) { lsKeys = []; }
    for (const key of lsKeys) {
      if (!key.startsWith(AIHL_KEY)) continue;
      const slot = key.slice(AIHL_KEY.length);
      if (!slot || store.markAiHl.has(slot)) continue;
      const local = localRead(key, []);
      if (Array.isArray(local) && local.length) jobs.push(["ai_highlight", slot, local]);
    }
    for (const job of jobs) pushMark(id, job[0], job[1], job[2]);
  }

  // 原页高亮（store.originalHl，带 page/segs 精确区间）与文理高亮共用同一份
  // localStorage 列表持久化，保证刷新后原页高亮不丢、左侧「高亮」面板同步可见。
  function persistOriginalHighlights() {
    if (!store.currentId) return;
    const kept = new Map();
    for (const h of getHighlights(store.currentId)) {
      if (h.mode !== "original") kept.set(h.id, h);
    }
    for (const h of store.originalHl || []) kept.set(h.id, { ...h, mode: "original" });
    saveHighlights(store.currentId, [...kept.values()]);
  }
  function restoreOriginalHighlights() {
    store.originalHl = getHighlights(store.currentId)
      .filter((h) => h.mode === "original" && Number.isFinite(h.page) && Array.isArray(h.segs))
      .map((h) => ({ id: h.id, page: h.page, text: h.text || "", segs: h.segs }));
  }

  // 判断公式是否为需屏蔽的碎片（过短 / 断开运算符头尾）。碎片不显示截图，回退 LaTeX。
  function isSpuriousFormula(f) {
    const raww = String((f && (f.raw || f.text)) || "");
    if (!raww.trim()) return true;
    const s = raww.replace(/[\s\u00a0]+/g, "");
    if (/^[\u2212\u2013\-.,=·⋅(]/.test(s) || /[\u2212\u2013.=,·⋅(]$/.test(s)) return true;
    const norm = s.replace(/[^a-zA-Z0-9\u00b0-\u03ff]/g, "").toLowerCase();
    if (norm.length < 5) return true;
    if (s.length >= 8 && /\b(and|are|the|is|of|with|using|from|but|this|that|where)\b/.test(raww.toLowerCase())) {
      return true; // 含英文连词/介词的大段正文短语
    }
    return false;
  }

  function formulaById() {
    const map = {};
    for (const s of store.detail?.sources || []) {
      for (const f of (s.formulas || [])) {
        if (f && f.id !== undefined) map[f.id] = f;
      }
    }
    return map;
  }

  function figureById() {
    const map = {};
    for (const s of store.detail?.sources || []) {
      for (const f of (s.figures || [])) {
        if (f && f.id !== undefined) map[f.id] = f;
      }
    }
    return map;
  }

  // 判断是否为数学公式行（非标题）
  function looksLikeFormulaLine(t) {
    const s = String(t || "").trim();
    if (!s) return false;
    if (/^\[\[MATH:[^\]]+\]\]$/.test(s)) return true;
    if (/^(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\$[\s\S]*?\$|\\\([\s\S]*?\\\))$/.test(s)) return true;
    // 无中文且含等号/不等号/微积分求和符号/常见 LaTeX 宏命令
    if (!/[\u4e00-\u9fff]/.test(s) && /[=≈≤≥<>≠≡±×÷⋅∑∫√∞∂∇ħα-ωΑ-Ω]|\\(?:frac|text|sum|int|sqrt|alpha|beta|gamma|lambda|sigma|mu|tau|theta)\b/.test(s)) {
      return true;
    }
    return false;
  }

  // 整段是否为公式块（display math / MATH 占位符）——renderReader 与 mergeShortParagraphs 共用
  function isFormulaBlock(p) {
    return /^(\$[\s\S]*?\$|\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\[\[MATH:[^\]]+\]\])\s*$/.test(String(p || "").trim());
  }

  // 从 LaTeX 中剥离 \tag{N} 公式编号（KaTeX 不支持 \tag），编号单独右对齐渲染
  function splitMathTag(latex) {
    let tag = "";
    let src = String(latex || "").replace(/\\tag\s*\*?\s*\{([^{}]*)\}/g, (m, g) => {
      if (!tag) tag = String(g || "").replace(/[^\dA-Za-z,，.\-]/g, "");
      return "";
    });
    // 兼容 \qquad (1) 式行尾编号
    if (!tag) {
      const qm = /\\qquad\s*[\(（]\s*(\d{1,3}[a-zA-Z]?)\s*[\)）]\s*$/.exec(src);
      if (qm) {
        tag = qm[1];
        src = src.slice(0, qm.index);
      }
    }
    // 环境清洗：兼容 KaTeX（如将 \begin{equation} 转为 \begin{aligned}）
    src = src.replace(/^\\begin\{equation\*?\}/, "\\begin{aligned}")
             .replace(/\\end\{equation\*?\}$/, "\\end{aligned}");
    return { src: src.trim(), tag };
  }

  function renderMathLatex(latex, display) {
    const src = String(latex || "").trim();
    if (!src) return "";
    if (typeof window === "undefined") return `<code>${esc(src)}</code>`;

    const { src: cleaned } = splitMathTag(src);
    if (!cleaned) return "";

    // 优先使用 app.js 的 renderKatex 管线
    if (typeof window.renderKatex === "function") {
      try {
        const rendered = window.renderKatex(cleaned, !!display);
        if (rendered && !rendered.includes("katex-error-fallback")) return rendered;
      } catch (e) { /* fall through */ }
    }

    // 直接使用 KaTeX（严格检查无错误）
    if (window.katex && typeof window.katex.renderToString === "function") {
      try {
        const html = window.katex.renderToString(cleaned, {
          throwOnError: false,
          displayMode: !!display,
          strict: false,
          trust: false,
        });
        if (html && !html.includes('class="katex-error"')) {
          return `<span class="${display ? "katex-display-wrapper" : "katex-inline-wrapper"}" data-math-renderer="katex">${html}</span>`;
        }
      } catch (e) { /* fall through */ }
    }

    // 纯文本兜底：需要 white-space: normal 防止父级 pre-wrap 导致竖向排列
    return `<code class="sr-formula-raw" style="white-space:normal;word-break:normal">${esc(cleaned)}</code>`;
  }

  function renderHighlightedText(text, index, highlights) {
    let html = esc(text);
    for (const h of highlights) {
      if (h.para !== index || !h.text) continue;
      const needle = esc(h.text);
      const pos = html.indexOf(needle);
      if (pos >= 0) {
        html = html.slice(0, pos) + `<mark class="sr-mark" data-hl-id="${esc(h.id)}">` + needle + "</mark>" + html.slice(pos + needle.length);
      }
    }
    return html;
  }

  // 竖线表格段落：连续 ≥2 行以 | 包裹的行 → 渲染为 HTML 表格；其余部分按普通段落渲染
  function isPipeRow(line) {
    const t = String(line || "").trim();
    if (!t.startsWith("|") || !t.endsWith("|")) return false;
    return (t.match(/\|/g) || []).length >= 3;
  }

  function pipeTableHtml(rows) {
    const cells = rows.map((r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
    const dataRows = cells.filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c)));
    if (dataRows.length < 2) return "";
    const colCount = Math.max(...dataRows.map((r) => r.length));
    const norm = dataRows.map((r) => { while (r.length < colCount) r.push(""); return r; });
    const [head, ...bodyRows] = norm;
    return `<div class="sr-table-wrap"><table class="sr-table"><thead><tr>` +
      head.map((c) => `<th>${renderInlineMarkdown(c)}</th>`).join("") +
      `</tr></thead><tbody>` +
      bodyRows.map((r) => `<tr>${r.map((c) => `<td>${renderInlineMarkdown(c)}</td>`).join("")}</tr>`).join("") +
      `</tbody></table></div>`;
  }

  function renderParaWithTables(p, index) {
    const lines = String(p).split("\n");
    const segments = [];
    let cur = null;
    for (const line of lines) {
      const isRow = isPipeRow(line);
      const type = isRow ? "table" : "text";
      if (!cur || cur.type !== type) {
        if (cur) segments.push(cur);
        cur = { type, lines: [line] };
      } else {
        cur.lines.push(line);
      }
    }
    if (cur) segments.push(cur);
    return segments.map((seg) => {
      if (seg.type === "table" && seg.lines.length >= 2) {
        const html = pipeTableHtml(seg.lines);
        if (html) return html;
      }
      const text = seg.lines.join("\n");
      return text.trim() ? `<p class="sr-para-source">${renderParaSource(text, index)}</p>` : "";
    }).join("");
  }

  // 段落是否完全由竖线表格行组成
  function isPipeTablePara(p) {
    const rows = String(p).split("\n").map((l) => l.trim()).filter(Boolean);
    return rows.length >= 2 && rows.every(isPipeRow);
  }

  // 段落内是否存在 ≥2 行的连续竖线表格片段
  function hasPipeTableRun(p) {
    let run = 0;
    for (const line of String(p).split("\n")) {
      run = isPipeRow(line) ? run + 1 : 0;
      if (run >= 2) return true;
    }
    return false;
  }

  // 渲染前把相邻的纯竖线行段落合并成一个表格段落（PDF/LLM 常把表格行拆成独立段落）
  function mergePipeTableParagraphs(paras) {
    const out = [];
    for (const p of paras || []) {
      const rows = String(p).split("\n").map((l) => l.trim()).filter(Boolean);
      const purePipe = rows.length >= 1 && rows.every(isPipeRow);
      if (purePipe) {
        const prev = out.length ? out[out.length - 1] : null;
        if (prev) {
          const prevRows = prev.split("\n").map((l) => l.trim()).filter(Boolean);
          if (prevRows.length && prevRows.every(isPipeRow)) {
            out[out.length - 1] = prev + "\n" + rows.join("\n");
            continue;
          }
        }
        out.push(rows.join("\n"));
        continue;
      }
      out.push(p);
    }
    return out;
  }

  function renderParaSource(p, index) {
    const highlights = getHighlights(store.currentId);
    const formulas = formulaById();
    const re = /\[\[MATH:([^\]]+)\]\]|\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)|\$\$([\s\S]*?)\$\$|\$(?!\$)([^$]+)\$/g;
    const isDisplayBlock = /^\s*(\[\[MATH:[^\]]+\]\]|\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\])\s*$/.test(p.trim());

    // 预扫描所有公式匹配
    const matches = [];
    let mm;
    re.lastIndex = 0;
    while ((mm = re.exec(p)) !== null) {
      const display = (mm[1] === undefined) && (mm[0].startsWith("\\[") || mm[0].startsWith("$$"));
      const formula = mm[2] || mm[3] || mm[4] || mm[5] || "";
      matches.push({ index: mm.index, end: mm.index + mm[0].length, display, formula, isMathId: mm[1] !== undefined, mathId: mm[1] });
    }

    // 最后一个 display 公式后是否紧跟编号
    let lastDisplayIdx = -1;
    for (let i = matches.length - 1; i >= 0; i--) {
      if (matches[i].display) { lastDisplayIdx = i; break; }
    }

    let eqNum = "";
    if (lastDisplayIdx >= 0) {
      const trailing = p.slice(matches[lastDisplayIdx].end);
      const numMatch = /^[\s]*[\(（]\s*(\d+(?:\s*[,，]\s*\d+)*)\s*[\)）][\s]*/.exec(trailing.trim());
      if (numMatch) {
        eqNum = numMatch[1];
        const numLen = trailing.indexOf(numMatch[0]);
        if (numLen >= 0) matches[lastDisplayIdx].end += numLen + numMatch[0].length;
      }
    }

    let html = "";
    let last = 0;
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      html += renderHighlightedText(p.slice(last, m.index), index, highlights);
      if (m.isMathId) {
        const f = formulas[m.mathId];
        const rawLatex = f && f.formula ? String(f.formula).trim() : "";
        const blocked = isSpuriousFormula(f) && !(f && (f.number || f.num_in_image));
        if (blocked && (!rawLatex || isSpuriousFormula({ raw: rawLatex }))) {
          last = m.end;
          continue;
        }

        const finalNum = (f && f.number) ? String(f.number) : "";
        const { src, tag } = splitMathTag(rawLatex);
        const formulaNum = finalNum || tag;

        // 核心升级：优先走 KaTeX 高保真矢量渲染（ScholarRead 标配），成功则居中展示并右对齐公式编号
        let renderedFormula = "";
        let katexSuccess = false;
        if (src) {
          renderedFormula = renderMathLatex(src, isDisplayBlock);
          if (renderedFormula && !renderedFormula.includes("sr-formula-raw") && !renderedFormula.includes("katex-error")) {
            katexSuccess = true;
          }
        }

        if (katexSuccess) {
          if (isDisplayBlock) {
            const imgTip = f && f.image
              ? ` title="点击查看原图截屏对照" onclick="window.open('${esc(f.image)}','_blank')"`
              : "";
            html += `<span class="sr-formula-display${formulaNum ? " has-num" : ""}"${imgTip}><span class="sr-formula-body">${renderedFormula}</span>${formulaNum ? `<span class="sr-formula-num">(${esc(formulaNum)})</span>` : ""}</span>`;
          } else {
            html += renderedFormula;
          }
          last = m.end;
          continue;
        }

        // 若 KaTeX 渲染失败或无有效 LaTeX，回退到原图高清截图
        if (f && f.image) {
          const num = formulaNum && !f.num_in_image ? formulaNum : "";
          if (isDisplayBlock) {
            const imgHtml = `<img class="sr-formula-img" src="${esc(f.image)}" alt="formula" loading="lazy" onclick="window.open('${esc(f.image)}','_blank')">`;
            html += `<span class="sr-formula-display${num ? " has-num" : ""}">${imgHtml}${num ? `<span class="sr-formula-num">(${esc(num)})</span>` : ""}</span>`;
          } else {
            html += `<img class="sr-formula-img-inline" src="${esc(f.image)}" alt="formula" loading="lazy" onclick="window.open('${esc(f.image)}','_blank')">`;
          }
          last = m.end;
          continue;
        }

        // 纯文本兜底
        if (renderedFormula) {
          if (isDisplayBlock) {
            html += `<span class="sr-formula-display${formulaNum ? " has-num" : ""}"><span class="sr-formula-body">${renderedFormula}</span>${formulaNum ? `<span class="sr-formula-num">(${esc(formulaNum)})</span>` : ""}</span>`;
          } else {
            html += renderedFormula;
          }
        }
      } else {
        const { src, tag } = splitMathTag(m.formula);
        const formulaNum = tag || (i === lastDisplayIdx ? eqNum : "");
        const formulaHtml = renderMathLatex(src, m.display);
        if (m.display) {
          html += `<span class="sr-formula-display${formulaNum ? " has-num" : ""}"><span class="sr-formula-body">${formulaHtml}</span>${formulaNum ? `<span class="sr-formula-num">(${esc(formulaNum)})</span>` : ""}</span>`;
        } else {
          html += formulaHtml;
        }
      }
      last = m.end;
    }
    html += renderHighlightedText(p.slice(last), index, highlights);
    return html;
  }

  // 渲染章节标题：[[H:n]] 前缀 → <h2>/<h3>/<h4>；level 1（论文题名）已在阅读器头部展示，直接跳过。
  function renderHeadingParagraph(p, head, index) {
    const level = Number(head[1]);
    if (level <= 1) return "";
    const tagLevel = Math.min(4, Math.max(2, level));
    const body = p.slice(head[0].length);
    if (looksLikeFormulaLine(body)) {
      return `<p class="sr-para-source">${renderParaSource(body, index)}</p>`;
    }
    return `<h${tagLevel} class="sr-heading sr-heading-${tagLevel}" data-paragraph data-para-index="${index}">${renderParaSource(body, index)}</h${tagLevel}>`;
  }

  // 智能合并相邻短段落，减少 PDF 提取碎片化导致的"译"按钮泛滥
  function mergeShortParagraphs(paras) {
    if (!paras || paras.length <= 1) return paras || [];
    const MIN_CHARS = 60; // 短于此长度的段落考虑合并
    const isHeading = (p) => /^\[\[H:\d+(?:@\d+)?\]\]/.test(p) || /^#{1,6}\s/.test(p);
    const isFigOnly = (p) => /^\[\[FIG:[^\]]+\]\]\s*$/.test(p);
    const isEqNum = (p) => /^[\s]*[\(（]\s*\d+(?:\s*[,，]\s*\d+)*\s*[\)）][\s]*$/.test(p.trim());
    const isShort = (p) => p.replace(/\[\[(?:MATH|FIG|H):[^\]]+\]\]/g, "").replace(/\$\$[\s\S]*?\$\$/g, "").replace(/\\\[[\s\S]*?\\\]/g, "").replace(/\$[\s\S]*?\$/g, "").replace(/\s+/g, "").length < MIN_CHARS;

    const merged = [];
    let pending = null;

    for (let i = 0; i < paras.length; i++) {
      const p = paras[i];
      // 标题、图片占位符、竖线表格不参与合并，直接输出
      if (isHeading(p) || isFigOnly(p) || isPipeTablePara(p)) {
        if (pending !== null) { merged.push(pending); pending = null; }
        merged.push(p);
        continue;
      }
      if (pending !== null && isPipeTablePara(pending)) {
        merged.push(pending);
        pending = p;
        continue;
      }

      if (pending === null) {
        pending = p;
        continue;
      }

      const prevShort = isShort(pending);
      const currShort = isShort(p);
      const prevFormula = isFormulaBlock(pending);
      const currFormula = isFormulaBlock(p);
      const prevEqNum = isEqNum(pending);
      const currEqNum = isEqNum(p);
      const bothFormula = prevFormula && currFormula;
      const bothShort = prevShort && currShort;
      const oneShort = prevShort || currShort;

      // 公式块后跟编号 → 合并为同一行（用空格连接，确保编号同行显示）
      if (prevFormula && currEqNum) {
        pending = pending + " " + p.trim();
        continue;
      }
      // 连续的公式编号 → 合并为同一行
      if (prevEqNum && currEqNum) {
        pending = pending + " " + p.trim();
        continue;
      }
      // 两个公式块 → 合并为一个公式段落
      if (bothFormula) {
        pending = pending + "\n" + p;
        continue;
      }
      // 两个短段落 → 合并
      if (bothShort) {
        pending = pending + "\n" + p;
        continue;
      }
      // 一个短一个不短 → 合并（短段落通常是前文断裂的延续）
      if (oneShort) {
        pending = pending + "\n" + p;
        continue;
      }
      // 两个都不含公式且总长度 < 200 字符 → 合并（PDF 碎片化段落）
      const cleanLen = (t) => t.replace(/\[\[(?:MATH|FIG|H):[^\]]+\]\]/g, "").replace(/\$\$[\s\S]*?\$\$/g, "").replace(/\\\[[\s\S]*?\\\]/g, "").replace(/\$[\s\S]*?\$/g, "").replace(/\s+/g, "").length;
      // 段落以 "= / ： / ，" 等开放结尾收尾（如"…w ="），说明公式/句子被截断，必须与下一段拼接
      const endsOpen = /[=＝:：,，]\s*$/.test(pending.replace(/\[\[(?:MATH|FIG|H):[^\]]+\]\]/g, "").trimEnd());
      if (!prevFormula && !currFormula && (endsOpen || (cleanLen(pending) + cleanLen(p)) < 200)) {
        pending = pending + "\n" + p;
        continue;
      }

      // 都不短，输出 pending，开始新的
      merged.push(pending);
      pending = p;
    }

    if (pending !== null) merged.push(pending);
    return merged;
  }

  function renderReader() {
    const body = el("lit-reader-body");
    const titleEl = el("lit-reader-title");
    const subtitleEl = el("lit-reader-subtitle");
    const translateBtn = el("lit-translate-all-button");
    const rearrangeBtn = el("lit-rearrange-button");
    if (!body) return;
    // 非原页模式：确保原页的贴底布局类被移除
    body.classList.remove("orig-mode");

    if (!store.detail) {
      titleEl.textContent = "选择一篇文献开始精读";
      if (subtitleEl) subtitleEl.textContent = "";
      if (translateBtn) { translateBtn.disabled = true; translateBtn.classList.remove("active"); translateBtn.setAttribute("aria-pressed", "false"); }
      if (rearrangeBtn) rearrangeBtn.disabled = true;
      body.innerHTML = `
        <div class="lit-reader-empty">
          <span class="compass">文</span>
          <h3>还没有选中的文献</h3>
          <p>点击左上角的书形图标打开文献库，选一篇开始阅读、翻译与问答。</p>
        </div>`;
      return;
    }

    // —— 原页（Acrobat 式）阅读模式：有真实源文件时优先展示 PDF 原页 ——
    if (store.readMode === "original" && originalSourceId()) {
      renderOriginalReader();
      return;
    }

    const meta = store.detail.meta || {};
    const project = store.detail.project || {};
    titleEl.textContent = meta.title || project.subject || "未命名论文";
    if (subtitleEl) subtitleEl.textContent = [meta.authors, meta.venue, meta.year].filter(Boolean).join(" · ");

    const text = readerText();
    if (translateBtn) {
      translateBtn.disabled = !text;
      translateBtn.classList.toggle("active", store.autoTrans);
      translateBtn.setAttribute("aria-pressed", store.autoTrans ? "true" : "false");
    }
    if (rearrangeBtn) rearrangeBtn.disabled = !text;

    if (!text) {
      body.innerHTML = `
        <div class="lit-reader-empty">
          <span class="compass">文</span>
          <h3>正文为空</h3>
          <p>未能从来源中提取到文本。可尝试重新导入原 PDF，或删除后重新导入。</p>
        </div>`;
      return;
    }

    const paragraphs = mergeShortParagraphs(mergePipeTableParagraphs(splitParagraphs(text)));
    // 每次重新渲染前清空渲染级图片去重表（译文刷新等会整刷正文）
    _renderedImgUrls.clear();
    // 未被正文 [[FIG:id]] 标记引用的图片：按 caption 定位插入或文末兜底展示
    const referencedFigIds = new Set();
    for (const m of String(text || "").matchAll(/\[\[FIG:([^\]]+)\]\]/g)) referencedFigIds.add(m[1]);
    const figMap = figureById();
    const figGroups = buildFigureGroups();
    const renderedGroups = new Set();
    // 按引用 id 渲染图块：复合图整幅只渲染一次，且把子图 id 汇聚到同一幅
    const blockHtmlForId = (fid) => {
      const grp = _figToGroup && _figToGroup[String(fid)];
      if (grp && isCompositeGroup(grp)) {
        if (renderedGroups.has(grp.id)) return "";
        renderedGroups.add(grp.id);
        return groupBlockHtml(grp);
      }
      const fig = figMap[fid];
      return fig ? figureBlockHtml(fig) : "";
    };
    // 未在正文被 [[FIG:id]] 引用的独立图片：按 caption 定位插入或文末兜底展示
    // （复合图整幅放置 + 单图放置见下方“图块落位”）；按页码+图号排序保证标号顺序
    const figures = readerFigures().filter((f) => !f.id || !referencedFigIds.has(f.id))
      .sort((a, b) => figSortKey(a) - figSortKey(b));

    // 预计算：standalone [[FIG:xxx]] 后紧跟的 caption 段落应跳过
    const skipPara = new Set();
    const figOnlyRe = /^\s*\[\[FIG:([^\]]+)\]\]\s*$/;
    const figInlineRe = /\[\[FIG:([^\]]+)\]\]/g;
    for (let i = 0; i < paragraphs.length; i++) {
      const figOnly = figOnlyRe.exec(paragraphs[i]);
      if (!figOnly) continue;
      const fig = figMap[figOnly[1]];
      if (!fig || !fig.caption) continue;
      const capKey = String(fig.caption).replace(/\s+/g, "").toLowerCase();
      if (capKey.length < 10) continue;
      const needle = capKey.slice(0, 30);
      for (let j = i + 1; j < Math.min(i + 3, paragraphs.length); j++) {
        if (paragraphs[j].replace(/\s+/g, "").toLowerCase().includes(needle)) {
          skipPara.add(j);
        }
      }
    }

    const figHtmlByPara = paragraphs.map(() => []);
    const unplaced = [];
    const placeByCap = (figHtml, caption) => {
      const key = String(caption || "").replace(/\s+/g, "").toLowerCase();
      if (key.length >= 6) {
        const needle = key.slice(0, 20);
        for (let i = 0; i < paragraphs.length; i++) {
          if (paragraphs[i].replace(/\s+/g, "").toLowerCase().includes(needle)) {
            figHtmlByPara[i].push(figHtml);
            return true;
          }
        }
      }
      unplaced.push(figHtml);
      return false;
    };
    // 先放复合图（整幅，含 A/B/C/D 标签），再放未引用的单图
    for (const grp of figGroups) {
      if (!isCompositeGroup(grp)) continue;
      if (grp.members.some((m) => referencedFigIds.has(String(m.id)))) continue; // 走下方 [[FIG]] 渲染
      placeByCap(groupBlockHtml(grp), grp.members[0] && grp.members[0].caption);
      renderedGroups.add(grp.id);
    }
    for (const fig of figures) {
      if (!fig) continue;
      const g0 = _figToGroup && _figToGroup[String(fig.id)];
      if (isCompositeGroup(g0)) continue; // 已合并到复合图
      placeByCap(figureBlockHtml(fig), fig.caption);
    }

    body.innerHTML = paragraphs.map((p, i) => {
      if (skipPara.has(i)) return "";
      if (!p.replace(/\s+/g, "")) return "";  // 跳过空段落
      const figOnly = figOnlyRe.exec(p);
      if (figOnly) {
        const fb = blockHtmlForId(figOnly[1]);
        if (fb) return fb;
        // 复合图成员已被整幅渲染过：跳过占位，避免出现空图
        const grp = _figToGroup && _figToGroup[String(figOnly[1])];
        if (grp && isCompositeGroup(grp)) return "";
        return `<figure class="sr-figure-block"><div class="sr-figure-placeholder"><span class="sr-figure-placeholder-icon">&#x1F5BC;</span><span>图片 ${esc(figOnly[1])} 未能提取</span></div></figure>`;
      }
      // 段落内嵌 [[FIG:xxx]] → 提取到段落后展示
      let inlineFigs = "";
      let inlineFigCaptions = [];
      let cleanP = p;
      let fm;
      figInlineRe.lastIndex = 0;
      while ((fm = figInlineRe.exec(p)) !== null) {
        const fb = blockHtmlForId(fm[1]);
        if (fb) {
          inlineFigs += fb;
          const fig = figMap[fm[1]];
          if (fig && fig.caption) inlineFigCaptions.push(fig.caption.trim());
        }
      }
      if (inlineFigs) {
        cleanP = p.replace(figInlineRe, "").trim();
        // 移除段落中与图片 caption 重复的文字，避免 caption 出现两次
        for (const cap of inlineFigCaptions) {
          if (cap.length >= 6) {
            const capKey = cap.replace(/[^\w\u4e00-\u9fff]/g, "").slice(0, 30);
            // 找到 cleanP 中与 caption 相似度高的片段并移除
            cleanP = cleanP.replace(new RegExp(cap.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "").trim();
          }
        }
      }
      const head = /^\[\[H:(\d)(?:@\d+)?\]\]\s*/.exec(cleanP);
      // 兜底：Markdown 风格标题（### heading）→ 转为对应层级标题渲染
      const mdHead = !head ? /^(#{1,6})\s+(.+)$/m.exec(cleanP) : null;
      if (head) {
        const bodyText = cleanP.slice(head[0].length).trim();
        if (looksLikeFormulaLine(bodyText) || isFormulaBlock(bodyText)) {
          cleanP = bodyText;
        } else {
          return renderHeadingParagraph(cleanP, head, i);
        }
      }
      if (mdHead) {
        const mdLevel = mdHead[1].length;
        const tagLevel = Math.min(4, Math.max(2, mdLevel));
        const headText = mdHead[2].trim();
        if (looksLikeFormulaLine(headText) || isFormulaBlock(headText)) {
          cleanP = headText;
        } else {
          return `<h${tagLevel} class="sr-heading sr-heading-${tagLevel}" data-paragraph data-para-index="${i}">${renderParaSource(mdHead[2], i)}</h${tagLevel}>`;
        }
      }
      const cached = store.translationMap.get(p);
      const t = cached && cached.trim();
      // 「全文翻译」开关真正的作用：控制自动译文的显隐（关掉就看不到译文，
      // 而不是只把译文块的一条虚线下划线去掉）。手动点「译」的段落常显。
      // 隐藏不动缓存 —— 重开开关立刻整篇恢复，不重新烧额度。
      const autoHidden = !!t && !store.autoTrans && store.autoTranslated.has(p);
      const showTrans = !!t && !autoHidden;
      const translateBtnHtml = showTrans
        ? ""
        : `<button class="sr-para-translate-btn" type="button" data-lit-action="translate" data-index="${i}">译</button>`;
      const translationHtml = showTrans
        ? `<div class="sr-para-translation">${renderMarkdown(t)}</div>`
        : `<div class="sr-para-translation" data-trans-target="${i}" hidden></div>`;
      const sourceHtml = hasPipeTableRun(cleanP)
        ? renderParaWithTables(cleanP, i)
        : `<p class="sr-para-source">${renderParaSource(cleanP, i)}</p>`;
      return `
        <div class="sr-para" data-paragraph data-para-index="${i}">
          <div class="sr-para-toolbar">${translateBtnHtml}</div>
          ${sourceHtml}
          ${translationHtml}
        </div>${inlineFigs}${figHtmlByPara[i].join("")}`;
    }).join("") + unplaced.join("");
  }

  async function translateParagraph(index) {
    if (!store.detail) return;
    // 渲染用的是 mergeShortParagraphs 后的段落列表，索引进来的也必须是同一份列表
    const text = mergeShortParagraphs(mergePipeTableParagraphs(splitParagraphs(readerText())))[index];
    if (!text) return;
    // 已有译文（例如刚被全文翻译翻过）：直接转成"常显"即可，不再白烧一次模型额度
    const cached = store.translationMap.get(text);
    if (cached && cached.trim()) {
      store.autoTranslated.delete(text);
      renderReader();
      return;
    }
    const target = document.querySelector(`[data-trans-target="${index}"]`);
    if (target) {
      target.hidden = false;
      target.innerHTML = "<span class=\"btn-spinner\" aria-hidden=\"true\"></span> 正在翻译…";
    }
    try {
      const res = await window.api(`/api/literature/${encodeURIComponent(store.currentId)}/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_text: text }),
      });
      store.translationMap.set(text, res.translated_text || "");
      store.autoTranslated.delete(text); // 手动翻译的段落始终显示，不受「全文翻译」开关影响
      renderReader();
    } catch (error) {
      if (target) target.innerHTML = `<span class="lit-error">${esc(error.message)}</span>`;
    }
  }

  function hasEnglish(text) {
    return /[A-Za-z]/.test(String(text || "").replace(/\[\[MATH:[^\]]+\]\]/g, "").replace(/\[\[FIG:[^\]]+\]\]/g, ""));
  }

  // 代次计数器（同原页 _origTransRun 的思路）：关闭/重开全文翻译会让在途的旧循环让位退出。
  // 否则「关了开关，后台仍在逐段翻译并 rerender」，文理视图的开关看起来毫无作用。
  let _textTransRun = 0;

  async function autoTranslateEnglish() {
    if (!store.detail || !store.autoTrans) return;
    const run = ++_textTransRun;
    // 与渲染保持一致：按合并后的段落翻译，translationMap 才能按同一段落文本命中
    const paras = mergeShortParagraphs(mergePipeTableParagraphs(splitParagraphs(readerText())));
    const pending = paras.filter((p) => hasEnglish(p) && !(store.translationMap.get(p) && store.translationMap.get(p).trim()));
    for (const p of pending) {
      if (run !== _textTransRun || !store.autoTrans) return; // 期间被关闭/重开：让位退出
      try {
        const res = await window.api(`/api/literature/${encodeURIComponent(store.currentId)}/translate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source_text: p }),
        });
        if (run !== _textTransRun || !store.autoTrans) return; // await 期间被关闭/重开
        store.translationMap.set(p, res.translated_text || "");
        store.autoTranslated.add(p); // 记账为自动译文：跟随开关显隐
        rerenderReader();
      } catch (error) { /* 单段失败不阻断其余段落 */ }
    }
  }

  function toggleAutoTrans() {
    store.autoTrans = !store.autoTrans;
    // 关闭：让仍在跑的旧翻译循环失效（原页对照面板 + 文理视图内联翻译两条路）
    if (!store.autoTrans) { _origTransRun++; _textTransRun++; }
    renderReader();
    if (store.autoTrans) {
      // 原页模式：译文走右侧对照面板（不动真页）；文理视图走段落内联翻译
      if (store.readMode === "original") origAutoTranslate();
      else autoTranslateEnglish();
    }
  }

  // —— 原页「全文翻译」：右侧双语对照面板，复用同一份 translationMap ——
  // 代次计数器：每次开启/关闭全文翻译都递增。旧一轮翻译循环据此失效（不再用单一 busy 锁，
  // 否则「关→开」间隔太短时，旧循环还没跑完，busy 仍为 true，新面板永远不显示、按钮却已高亮）。
  let _origTransRun = 0;
  function origTransPanel() {
    return el("lit-reader-body")?.querySelector("[data-orig-trans]") || null;
  }

  // 原页「全文翻译」的正文来源：优先 sources[].text（文理排版好的规整段落，
  // 与文理视图/autoTranslateEnglish 同源，天然分段、含 [[H]]/[[MATH]] 占位）；
  // 只有在其为空时，才回退到 PDF 文本层（跨页空行分隔）。
  function origFullText() {
    const fromSources = readerText();
    if (fromSources.trim()) return fromSources;
    const pages = store.originalMeta?.pages || [];
    if (pages.length) {
      let out = "";
      for (const p of pages) {
        const rows = (p.text_layer || []).map((l) => String(l.text || "").trim()).filter(Boolean);
        if (!rows.length) continue;
        out += (out ? "\n\n" : "") + rows.join(" ");
      }
      return sanitizeLitText(out);
    }
    return "";
  }

  // 无需翻译的段落：占位符（[[...]]）、页码（"3 of 6"）、纯图内坐标/单位标注（数字+符号密集、无正文词句）。
  // 这类内容翻译无意义、还占用翻译额度，直接跳过。
  function shouldSkipOrigSeg(p) {
    const t = String(p || "").trim();
    if (!t) return true;
    // 图注 / 表注段：以"图N/表N/Fig. N/Figure N/Table N"开头的段落本身常已含中英双语或仅是对图表的说明，
    // 翻译成另一语种无意义，直接跳过。覆盖中英混排（"图7...Fig. 7..."）与纯英文图注（"Fig. 11..."）。
    if (/^(图|表)\s*\d/.test(t)) return true;
    if (/^(\*\*)?(Fig\.?|Figure|Table)\s*\d/i.test(t)) return true;
    // 占位符（图片/公式/标题标记，整段无正文）
    if (/^\[\[[A-Z]+:[^\]]+\]\]$/.test(t)) return true;
    // 以页脚式短占位开头的（如 "[[H:3]] 6 of 6"）——占位+页码，无正文
    if (/^\[\[[A-Z]+:[^\]]+\]\]\s*\d+\s+of\s+\d+\s*$/i.test(t)) return true;
    // "3 of 6" / "第 N of M" 页码类
    if (/^\d+\s+of\s+\d+$/i.test(t)) return true;
    // 极短且无正文词（单个字/单个符）
    if (t.length < 15 && !t.includes(" ")) return true;
    // 图内坐标/尺寸标注：几乎无连续单词（2 字母词以下视为词组弱）、数字与符号占比高、无中文。
    // 判定：去掉括号与标签后，若不含 2 字母以上的英文单词且几乎无中文 → 坐标/单位墙
    const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
    const words = (t.match(/[A-Za-z]{2,}/g) || []).length;
    if (cjk === 0 && words === 0) return true;
    // 坐标/尺寸墙：空格切分密集、极短 token 占绝大多数（数字、轴标字母X/Y、单位µm 等），
    // 即便混入少量 2 字母词（如 TFLN/chip）仍判为图内标注，跳过不翻译。
    if (cjk === 0 && t.includes(" ")) {
      const tokens = t.split(/\s+/).filter(Boolean);
      if (tokens.length >= 5) {
        const short = tokens.filter((x) => x.length <= 3).length;
        if (short / tokens.length >= 0.7) return true;
      }
    }
    return false;
  }

  async function origAutoTranslate() {
    if (!store.detail || !store.autoTrans) return;
    // 领取本轮代次：后续每次开启/关闭都会 ++_origTransRun，旧一轮循环据此让位退出。
    const run = ++_origTransRun;
    try {
      // 元数据（文本层）不在时先现拉，确保任何进入时序下都能拿到正文
      let paras = mergeShortParagraphs(mergePipeTableParagraphs(splitParagraphs(origFullText())));
      if (!paras.length) {
        const base = originalBase();
        if (base && !store.originalMeta) {
          try { store.originalMeta = await window.api(`${base}/pages`); } catch (error) { /* 忽略拉取失败 */ }
          paras = mergeShortParagraphs(mergePipeTableParagraphs(splitParagraphs(origFullText())));
        }
      }
      paras = paras.filter((p) => !shouldSkipOrigSeg(p));
      renderOrigTransPanel(paras);
      for (let i = 0; i < paras.length; i++) {
        const p = paras[i];
        if (run !== _origTransRun || !store.autoTrans) return; // 期间被关闭/重开：让位退出
        if (store.translationMap.has(p)) continue;
        try {
          const res = await window.api(`/api/literature/${encodeURIComponent(store.currentId)}/translate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source_text: p }),
          });
          if (run !== _origTransRun || !store.autoTrans) return; // await 期间被关闭/重开
          store.translationMap.set(p, res.translated_text || "");
          store.autoTranslated.add(p); // 原页自动译文同样记账，切到文理视图时跟随同一个开关
          // 面板是 DOM 快照：按索引就地更新，避免重复整刷；译文走 Markdown/公式渲染
          const panel = origTransPanel();
          if (panel) {
            const item = panel.querySelector(`[data-trans-idx="${i}"]`);
            const dst = item && item.querySelector(".orig-trans-dst");
            if (dst) { dst.classList.remove("is-pending"); dst.innerHTML = renderMarkdown(res.translated_text || ""); }
          }
        } catch (error) { /* 单段失败不阻断其余段落 */ }
      }
    } finally {
      /* 不再用全局 busy 复位：run 代次已保证互斥，旧 run 的退出不会误伤新 run */
    }
  }

  // 面板「原句」可读化：标题/图片/公式占位符转成中文标签，其余保留原文
  function origTransSrcHtml(p) {
    const t = String(p || "");
    const clean = t
      .replace(/\[\[H:\d+(?:@\d+)?\]\]\s*/g, "")           // 标题占位：由样式分级，去掉标记
      .replace(/\[\[(FIG):[^\]]*?\]\]/g, "")               // 图片占位
      .replace(/\[\[(MATH):[^\]]*?\]\]/g, "〔公式〕")
      .trim();
    const isHeading = /^\[\[H:\d+(?:@\d+)?\]\]/.test(t) || /^#{1,6}\s/.test(t);
    return { html: isHeading ? `<div class="orig-trans-src is-heading">${esc(clean)}</div>` : `<div class="orig-trans-src">${esc(clean)}</div>`, isHeading };
  }

  function renderOrigTransPanel(paras) {
    const panel = origTransPanel();
    if (!panel) return;
    if (!store.autoTrans) { panel.classList.add("hidden"); panel.hidden = true; syncOrigTransResizer(); return; }
    panel.classList.remove("hidden");
    panel.hidden = false;
    syncOrigTransResizer();
    const list = (paras || []).slice();
    const headDone = list.filter((p) => store.translationMap.get(p) && store.translationMap.get(p).trim()).length;
    const rows = list.map((p, i) => {
      const t = store.translationMap.get(p) || "";
      const status = t && t.trim()
        ? `<div class="orig-trans-dst">${renderMarkdown(t)}</div>`
        : `<div class="orig-trans-dst is-pending"><span class="btn-spinner" aria-hidden="true"></span><span>翻译中…</span></div>`;
      const src = origTransSrcHtml(p);
      return `
        <div class="orig-trans-item${src.isHeading ? " is-heading" : ""}" data-trans-idx="${i}">
          <div class="orig-trans-idx">${i + 1}</div>
          ${src.html}
          ${status}
        </div>`;
    }).join("");
    panel.innerHTML = `
      <div class="orig-trans-head">
        <span class="orig-trans-title">全文翻译</span>
        <span class="orig-trans-count">已完成 ${headDone}/${list.length}</span>
        <button type="button" class="pagenav-mini" data-orig-trans-close aria-label="关闭翻译面板">收起</button>
      </div>
      <div class="orig-trans-scroll">${rows || '<p class="orig-trans-empty">暂无正文段落。</p>'}</div>`;
    panel.querySelector("[data-orig-trans-close]").addEventListener("click", () => {
      store.autoTrans = false;
      _origTransRun++; // 使仍在跑的翻译循环失效
      const btn = el("lit-translate-all-button");
      if (btn) { btn.classList.remove("active"); btn.setAttribute("aria-pressed", "false"); }
      panel.classList.add("hidden");
      panel.hidden = true;
      syncOrigTransResizer();
    });
  }

  function showReaderError(message) {
    const body = el("lit-reader-body");
    if (body) body.innerHTML = `<div class="lit-reader-empty"><span class="compass">!</span><h3>出错了</h3><p>${esc(message)}</p></div>`;
  }

  // —— 原页（Acrobat 式）阅读：PDF 原页图像为真值，公式永不重绘 ——
  function originalSourceId() {
    const srcs = store.detail?.sources || [];
    const s = srcs.find((x) => x.source_id && x.source_id !== "__streaming__" && x.source_id.slice(0, 1) !== "_");
    return s ? s.source_id : null;
  }

  function originalBase() {
    const pid = store.currentId;
    const sid = originalSourceId();
    if (!pid || !sid) return null;
    return `/api/projects/${encodeURIComponent(pid)}/sources/${encodeURIComponent(sid)}`;
  }

  let _origAbort = null;
  let _pendingOrigLocate = null; // { bbox:[x0,y0,x1,y1], needle } 页图加载完成后用于精确定位闪烁
  let _figToGroup = null; // figId -> 复合图分组（正文/图表栏共用）
  let _figGroupsById = null; // groupId -> 复合图分组（裁剪失败兜底用）
  function originalMetaForPage(p) {
    return store.originalMeta?.pages?.find((x) => x.page === p) || null;
  }

  function renderOriginalReader() {
    const body = el("lit-reader-body");
    if (body) body.classList.add("orig-mode");
    const titleEl = el("lit-reader-title");
    const subtitleEl = el("lit-reader-subtitle");
    const meta = store.detail?.meta || {};
    const project = store.detail?.project || {};
    const base = originalBase();
    if (titleEl) titleEl.textContent = meta.title || project.subject || "未命名论文";
    if (subtitleEl) subtitleEl.textContent = [meta.authors, meta.venue, meta.year].filter(Boolean).join(" · ");

    if (!base) {
      store.readMode = "text";
      renderReader();
      return;
    }

    // 原页模式也启用全文翻译：右侧对照面板；同步按钮高亮状态
    const translateBtn = el("lit-translate-all-button");
    const rearrangeBtn = el("lit-rearrange-button");
    if (translateBtn) {
      translateBtn.disabled = false;
      translateBtn.classList.toggle("active", store.autoTrans);
      translateBtn.setAttribute("aria-pressed", store.autoTrans ? "true" : "false");
    }
    if (rearrangeBtn) rearrangeBtn.disabled = false;

    body.innerHTML = `
      <div class="orig-reader">
        <div class="orig-body" data-orig-body>
          <div class="orig-stage" data-orig-stage>
            <div class="orig-page-wrap" data-orig-wrap>
              <img class="orig-page-img" data-orig-img alt="原页" draggable="false">
              <div class="orig-formula-layer" data-orig-fl></div>
              <div class="orig-hl-layer" data-orig-hl></div>
              <div class="orig-text-layer" data-orig-tl></div>
              <div class="orig-fig-layer" data-orig-fig></div>
              <div class="orig-hover-layer" data-orig-hover></div>
            </div>
            <div class="orig-loading" data-orig-loading><span class="compass">翻</span><p>正在载入原页…</p></div>
            <div class="orig-err hidden" data-orig-err></div>
          </div>
          <div class="orig-trans-resizer" role="separator" aria-orientation="vertical" tabindex="0"
               title="拖动调整全文翻译宽度" aria-label="拖动调整全文翻译宽度"></div>
          <div class="orig-trans-panel hidden" data-orig-trans hidden></div>
        </div>
        <div class="orig-pagenav" data-orig-pagenav>
          <span class="orig-page-label" data-orig-pagelabel>— / —</span>
          <button type="button" class="secondary-button" data-orig="prev" aria-label="上一页">‹ 上一页</button>
          <button type="button" class="secondary-button" data-orig="next" aria-label="下一页">下一页 ›</button>
        </div>
      </div>`;

    if (_origAbort) _origAbort.abort();
    _origAbort = new AbortController();
    const ac = _origAbort;
    initOrigTransResizing();
    watchOrigWrapResize(body.querySelector("[data-orig-wrap]"));
    initOrigHover(body.querySelector("[data-orig-wrap]"));
    origHlRefreshUI();
    loadOriginalMeta(base, ac).then(() => {
      if (ac.signal.aborted) return;
      store.originalPage = Math.max(0, Math.min(store.originalPage, nOrigPages() - 1));
      // 原页模式进入时若全文翻译已开启，等元数据/文本层就绪后再恢复右侧对照面板
      if (store.autoTrans) origAutoTranslate();
      renderOrigPage(base, ac);
    }).catch((err) => {
      if (ac.signal.aborted) return;
      showOrigError(err);
    });
  }

  function nOrigPages() {
    return store.originalMeta?.n || 0;
  }

  async function loadOriginalMeta(base, ac) {
    if (store.originalMeta) return;
    const res = await window.api(`${base}/pages`, { signal: ac.signal });
    store.originalMeta = res;
    return res;
  }

  function origImgUrl(base, page, dpi) {
    return `${base}/page-image?page=${page}&dpi=${dpi}`;
  }
  function origCropUrl(base, page, bbox, dpi) {
    // 坐标不合法就返回空串：调用方据此跳过，绝不发出 bbox=NaN 的请求（后端会 500）
    if (!base || !Number.isFinite(Number(page)) || !finiteBbox(bbox)) return "";
    return `${base}/page-crop?page=${page}&bbox=${bbox.join(",")}&dpi=${dpi}`;
  }

  // —— 原页内精确定位：图表/文字 直接跳到所在页并高亮，无需切回文理视图 ——
  function origFigureById(figId) {
    const sid = originalSourceId();
    if (!sid) return null;
    const src = (store.detail?.sources || []).find((s) => s.source_id === sid);
    return (src?.figures || []).find((f) => String(f.id) === String(figId)) || null;
  }

  // 在已载入的原页元数据(text_layer)中查找首个含目标文本的页
  function origFindPageForText(needleText) {
    const pages = store.originalMeta?.pages || [];
    const clean = String(needleText || "").replace(/\s+/g, "");
    if (!clean || clean.length < 3) return null;
    const chunks = [];
    if (clean.length >= 6) for (let i = 0; i <= clean.length - 6; i++) chunks.push(clean.slice(i, i + 6));
    for (const p of pages) {
      const lines = p.text_layer || [];
      const pageClean = lines.map((l) => String(l.text || "").replace(/\s+/g, "")).join("");
      if (!pageClean) continue;
      const prefix = clean.slice(0, 12) || clean;
      const line = lines.find((l) => String(l.text || "").replace(/\s+/g, "").includes(prefix));
      if (line) return { page: p.page, needle: prefix };
    }
    if (chunks.length) {
      for (const p of pages) {
        const lines = p.text_layer || [];
        const pageClean = lines.map((l) => String(l.text || "").replace(/\s+/g, "")).join("");
        if (!pageClean) continue;
        const hits = chunks.filter((c) => pageClean.includes(c)).length;
        if (hits >= Math.min(2, chunks.length)) return { page: p.page, needle: clean.slice(0, 12) };
      }
    }
    return null;
  }

  function goToOrigPage(page, bbox, needle) {
    const base = originalBase();
    if (!base) return false;
    const target = Math.max(0, Math.min(Number(page) || 0, nOrigPages() - 1));
    _pendingOrigLocate = { bbox: (Array.isArray(bbox) && bbox.length === 4) ? bbox : null, needle };
    // 已在同一页：无需重载页图，直接叠加定位框
    if (store.originalPage === target) {
      const wrap = el("lit-reader-body")?.querySelector("[data-orig-wrap]");
      const img = wrap?.querySelector ? wrap.querySelector("[data-orig-img]") : null;
      if (wrap && img && img.src) { consumePendingOrigLocate(wrap); return true; }
    }
    if (_origAbort) _origAbort.abort();
    _origAbort = new AbortController();
    store.originalPage = target;
    renderOrigPage(base, _origAbort);
    return true;
  }

  // 在页图上叠加金色定位框并滚动到可见
  function consumePendingOrigLocate(wrap) {
    if (!_pendingOrigLocate) return;
    const pc = _pendingOrigLocate;
    _pendingOrigLocate = null;
    const pmeta = originalMetaForPage(store.originalPage);
    const img = wrap?.querySelector ? wrap.querySelector("[data-orig-img]") : null;
    const pageW = (pmeta && pmeta.w) || (img && img.naturalWidth) || 612;
    const scale = img && img.clientWidth ? img.clientWidth / pageW : 1;
    let box = pc.bbox;
    if (!box && pc.needle) {
      const t = String(pc.needle).replace(/\s+/g, "");
      const lines = (pmeta && pmeta.text_layer) || [];
      for (const ln of lines) {
        if (String(ln.text || "").replace(/\s+/g, "").includes(t)) { box = ln.bbox; break; }
      }
    }
    if (!box) return;
    wrap.querySelectorAll(".orig-loc-flash").forEach((n) => n.remove());
    const d = document.createElement("div");
    d.className = "orig-loc-flash";
    d.style.left = (box[0] * scale) + "px";
    d.style.top = (box[1] * scale) + "px";
    d.style.width = Math.max(12, (box[2] - box[0]) * scale) + "px";
    d.style.height = Math.max(12, (box[3] - box[1]) * scale) + "px";
    wrap.appendChild(d);
    d.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => d.remove(), 1750);
  }

  function locateFigureOrig(figId) {
    if (store.readMode !== "original") return false;
    // 复合图：跳到整幅并框选整个区域
    if (_figToGroup) {
      const grp = Object.values(_figToGroup).find((g) => isCompositeGroup(g) && g.id === String(figId));
      if (grp) return goToOrigPage(grp.page, grp.union && grp.union.length === 4 ? grp.union : null, null);
    }
    const fig = origFigureById(figId);
    if (!fig || !Number.isFinite(Number(fig.page))) return false;
    return goToOrigPage(fig.page, fig.bbox && fig.bbox.length === 4 ? fig.bbox : null, null);
  }

  function locateTextOrig(text, preferredPage) {
    if (store.readMode !== "original") return false;
    // 解析器标题带有真实的 1-based PDF 页码。优先按该页跳转，避免同名标题
    // （例如每章都有“引言/方法”）被全文首个匹配抢走；文字层只负责画高亮框。
    const pageNumber = Number(preferredPage);
    if (Number.isFinite(pageNumber) && pageNumber > 0 && nOrigPages() > 0) {
      const target = Math.max(0, Math.min(pageNumber - 1, nOrigPages() - 1));
      const pmeta = originalMetaForPage(target);
      const clean = String(text || "").replace(/\s+/g, "");
      const lines = (pmeta && pmeta.text_layer) || [];
      const needle = clean.length >= 3 ? clean.slice(0, Math.min(24, clean.length)) : "";
      const line = needle
        ? lines.find((l) => String(l.text || "").replace(/\s+/g, "").includes(needle))
        : null;
      return goToOrigPage(target, null, line ? needle : null);
    }
    const found = origFindPageForText(text);
    if (!found) return false;
    return goToOrigPage(found.page, null, found.needle);
  }

  function renderOrigPage(base, ac) {
    if (ac.signal.aborted) return;
    const wrap = el("lit-reader-body")?.querySelector("[data-orig-wrap]");
    if (!wrap) return;
    const p = store.originalPage;
    const pmeta = originalMetaForPage(p);
    const loading = el("lit-reader-body")?.querySelector("[data-orig-loading]");
    if (loading) loading.classList.remove("hidden");
    const dpi = Math.max(110, Math.min(260, Math.round(170 * Math.max(store.originalZoom, 1))));
    const img = wrap.querySelector("[data-orig-img]");
    img.style.width = "100%";
    img.src = origImgUrl(base, p, dpi);
    img.onload = () => {
      if (ac.signal.aborted) return;
      if (loading) loading.classList.add("hidden");
      applyOrigZoom();
      renderOrigFormulaLayer(wrap, pmeta, base);
      renderOrigTextLayer(wrap, pmeta, base);
      consumePendingOrigLocate(wrap);
      updateOrigPageLabel();
      prefetchOrigPage(base, p + 1);
      prefetchOrigPage(base, p - 1);
    };
    img.onerror = () => { if (loading) loading.classList.add("hidden"); showOrigError("原页加载失败，可能是原文件缺失。"); };
    updateOrigPageLabel();
  }

  // 预加载相邻页，加快翻页
  const _prefetchCache = {};
  function prefetchOrigPage(base, page) {
    if (page < 0 || page >= nOrigPages()) return;
    const key = page;
    if (_prefetchCache[key]) return;
    _prefetchCache[key] = 1;
    const dpi = 170;
    const im = document.createElement("img");
    im.decoding = "async";
    im.loading = "eager";
    im.src = origImgUrl(base, page, dpi);
  }

  // —— 原页公式裁剪：把高清公式图直接铺到对应公式位置 ——
  function renderOrigFormulaLayer(wrap, pmeta, base) {
    const flEl = wrap.querySelector("[data-orig-fl]");
    if (!flEl) return;
    flEl.innerHTML = "";
    const img = wrap.querySelector("[data-orig-img]");
    const regs = (pmeta && pmeta.formula_regions) || [];
    if (!regs.length) return;
    const pageW = pmeta.w || img.naturalWidth || 612;
    const scale = img.clientWidth / pageW;
    for (let ri = 0; ri < regs.length; ri++) {
      const r = regs[ri];
      const bb = r.bbox;
      const q = document.createElement("img");
      q.className = "orig-formula-img";
      q.alt = "公式" + (r.label || "");
      q.dataset.ridx = String(ri);
      q.decoding = "async";
      q.loading = "lazy";
      q._origBB = bb.slice(); // 留存 bbox，容器宽度变化时按新 scale 重排
      q.style.left = (bb[0] * scale) + "px";
      q.style.top = (bb[1] * scale) + "px";
      q.style.width = (Math.max(6, bb[2] - bb[0]) * scale) + "px";
      q.style.height = (Math.max(8, (bb[3] - bb[1])) * scale) + "px";
      q.src = origCropUrl(base, store.originalPage, bb, 200);
      flEl.appendChild(q);
    }
  }

  // 去掉行尾空白：white-space:pre 会把 PDF 文本层的尾随空格实际渲染出来，
  // 导致跨行选中时的选中长条向右延伸到页边空白（溢出）。
  function origTrimLine(t) {
    return String(t == null ? "" : t).replace(/\s+$/, "");
  }

  // 设置原页某行透明文字的几何，并记录「宽度贴合目标」（该行 bbox 宽）与基础字号。
  // fontSize 取 bbox 高度会因字形全角宽 > PDF 实际字节宽，使文字内容横向溢出 bbox。
  function setOrigLineGeo(span, bb, scale) {
    span._origBB = bb; // 留存 bbox，容器宽度变化时按新 scale 重排（relayoutOrigOverlays）
    span.style.left = (bb[0] * scale) + "px";
    span.style.top = (bb[1] * scale) + "px";
    const h = Math.abs(bb[3] - bb[1]);
    span.style.height = (Math.max(6, h) * scale) + "px";
    const baseFS = Math.max(8, h) * scale;
    span.style.fontSize = baseFS + "px";
    span.style.lineHeight = (Math.max(9, h) * scale) + "px";
    span._origFit = { target: Math.max(4, Math.abs(bb[2] - bb[0])) * scale, baseFS };
  }

  // 两遍法把各行透明文字在水平方向贴合其 bbox 宽：先统一测量（一次布局），再统一改字号。
  // 完成后每行文字（以及选中/高亮条）恰好覆盖该行 bbox 范围，不再向右溢出。
  // fn_hint 用于外部强制随后的布局。
  function applyOrigLineFit(list, refEl) {
    if (!list || !list.length) return;
    void (refEl || document.body).offsetHeight;
    for (const sp of list) {
      const fit = sp && sp._origFit;
      if (!fit || !fit.target) { sp._ow = 0; continue; }
      sp._ow = sp.getBoundingClientRect().width;
    }
    for (const sp of list) {
      const fit = sp && sp._origFit;
      if (!fit || !sp._ow || sp._ow < 1) continue;
      sp.style.fontSize = (fit.baseFS * (fit.target / sp._ow)) + "px";
    }
    void (refEl || document.body).offsetHeight;
  }

  // —— 原页文本层：把 PDF 文本层叠到页图上，透明可选中（每行一个 span，DOM 轻） ——
  function renderOrigTextLayer(wrap, pmeta, base) {
    const tlEl = wrap.querySelector("[data-orig-tl]");
    if (!tlEl) return;
    const hlEl = wrap.querySelector("[data-orig-hl]");
    if (hlEl) hlEl.innerHTML = "";
    tlEl.innerHTML = "";
    tlEl.style.left = "0px";
    tlEl.style.top = "0px";
    tlEl.dataset.paragraph = "orig";
    const img = wrap.querySelector("[data-orig-img]");
    const lines = (pmeta && pmeta.text_layer) || [];
    if (!lines.length) return;
    const pageW = pmeta.w || img.naturalWidth || 612;
    const scale = img.clientWidth / pageW;
    const segs = (store.originalHl || []).filter((h) => h.page === store.originalPage);
    // 「阅读重点」自动高亮：把 keypoint quote 匹配到本页文本层行内，叠加与手动高亮区分
    const autoSegs = collectOrigAutoHlSegs(lines);
    if (!store.highlightMode || !store.autoHighlights.length) autoSegs.length = 0;
    const fitList = [];
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const bb = ln.bbox;
      const span = document.createElement("span");
      span.className = "orig-tl-line";
      span.dataset.page = String(store.originalPage);
      span.dataset.line = String(i);
      // 复用现有选中菜单：把整行当段落容器
      span.dataset.paragraph = "orig";
      span.dataset.paraIndex = String(i);
      span.textContent = origTrimLine(ln.text);
      setOrigLineGeo(span, bb, scale);
      tlEl.appendChild(span);
      fitList.push(span);
      // 高亮层：同一行以内联 <mark> 包裹所选字符，消除矩形估算偏移；
      // 同一区间被多次高亮时半透明底叠加强度随之加深。
      const hs = renderOrigHlLine(hlEl, i, ln, bb, scale, segs);
      if (hs) fitList.push(hs);
      const la = autoSegs.get(i);
      if (la && la.length) {
        const as = renderOrigAutoHlLine(hlEl, i, ln, bb, scale, la);
        if (as) fitList.push(as);
      }
    }
    // 让每行文字在水平方向贴合其 bbox 宽，修正字号造成的选中/高亮条向右溢出
    applyOrigLineFit(fitList, tlEl);
  }

  // 把每条 keypoint quote（去空白）在本页所有行拼接文本（同样去空白）里做子串匹配，
  // 命中后映射回各行的一次性（行内 s..e）区间；返回 Map<lineIdx, [s,e][]>
  function collectOrigAutoHlSegs(lines) {
    const qs = (store.autoHighlights || [])
      .map((q) => String(q || "").replace(/\s+/g, ""))
      .filter((s) => s && s.length >= 4);
    const res = new Map();
    if (!qs.length) return res;
    // 把本页全部行文本去空白后拼接成一条串，并记录每个「干净字符」对应 (行, 原文列)
    // 这样 quote 与页文都按同一规则去空白，跨行引文也能命中。
    const srcOf = [];    // 干净串坐标 -> 原文 { li, col }
    for (let li = 0; li < lines.length; li++) {
      const raw = String((lines[li] && lines[li].text) || "");
      for (let col = 0; col < raw.length; col++) {
        if (/\s/.test(raw[col])) continue;
        srcOf.push({ li, col });
      }
    }
    const joined = srcOf.map((s) => lines[s.li].text[s.col]).join("");
    for (const q of qs) {
      const qr = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      let from = 0;
      while (true) {
        const cut = joined.slice(from);
        const m = qr.exec(cut);
        if (!m || m.index < 0) break;
        const gs = from + m.index;          // 干净串下标
        const ge = gs + q.length;
        pushOrigAutoSegs(res, lines, srcOf, gs, ge);
        from = ge;
      }
    }
    return res;
  }

  // 把干净串上的 [gs, ge) 区间，用 srcOf 映射回各行对应的原文 [s, e]
  function pushOrigAutoSegs(res, lines, srcOf, gs, ge) {
    const sInfo = srcOf[gs];
    const eInfo = srcOf[ge - 1];
    if (!sInfo || !eInfo) return;
    const sLine = sInfo.li;
    const eLine = eInfo.li;
    for (let li = sLine; li <= eLine; li++) {
      const raw = String((lines[li] && lines[li].text) || "");
      let s = 0, e = raw.length;
      if (li === sLine) s = sInfo.col;
      if (li === eLine) e = eInfo.col + 1;
      if (e <= s) continue;
      const arr = res.get(li) || [];
      arr.push([s, e]);
      res.set(li, arr);
    }
  }

  // 渲染「阅读重点」自动高亮：与手动高亮分层，用独立底色
  function renderOrigAutoHlLine(hlEl, lineIdx, ln, bb, scale, segsArr) {
    const tx = origTrimLine(ln.text);
    let html = "";
    let cursor = 0;
    segsArr.sort((a, b) => a[0] - b[0]);
    for (const [s, e] of segsArr) {
      if (e <= s) continue;
      if (s > cursor) html += escHtml(tx.slice(cursor, s));
      html += `<mark class="orig-tl-hl auto">${escHtml(tx.slice(s, e))}</mark>`;
      cursor = Math.max(cursor, e);
    }
    if (cursor < tx.length) html += escHtml(tx.slice(cursor));
    const span = document.createElement("span");
    span.className = "orig-hl-line auto";
    span.innerHTML = html;
    setOrigLineGeo(span, bb, scale);
    hlEl.appendChild(span);
    return span;
  }

  // 把某行所有高亮区间合并成互不重叠的槽位，并记录每个槽位被高亮覆盖的次数
  function collectLineSlots(segs, line, len) {
    const byPos = new Map();
    for (const h of segs) {
      for (const [ln, s, e] of (h && h.segs) || []) {
        if (ln !== line || e <= s) continue;
        byPos.set(s, (byPos.get(s) || 0) + 1);
        byPos.set(e, (byPos.get(e) || 0) - 1);
      }
    }
    if (!byPos.size) return [];
    const pos = [...byPos.keys()].sort((a, b) => a - b);
    const slots = [];
    let depth = 0;
    for (let k = 0; k < pos.length; k++) {
      depth += byPos.get(pos[k]);
      if (depth > 0 && k + 1 < pos.length && pos[k + 1] > pos[k]) {
        slots.push({ s: pos[k], e: pos[k + 1], depth });
      }
    }
    return slots;
  }

  function escHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }

  const HL_COLORS = ["rgba(255,213,79,0.40)", "rgba(255,182,86,0.72)", "rgba(255,152,0,0.95)"];

  function renderOrigHlLine(hlEl, lineIdx, ln, bb, scale, segs) {
    if (!hlEl) return;
    const tx = origTrimLine(ln.text);
    const slots = collectLineSlots(segs, lineIdx, tx.length);
    if (!slots.length) return;
    let html = "";
    let cursor = 0;
    for (const slot of slots) {
      if (slot.s > cursor) html += escHtml(tx.slice(cursor, slot.s));
      const bg = HL_COLORS[Math.min(3, slot.depth) - 1] || HL_COLORS[HL_COLORS.length - 1];
      html += `<mark class="orig-tl-hl" style="background:${bg};">${escHtml(tx.slice(slot.s, slot.e))}</mark>`;
      cursor = slot.e;
    }
    if (cursor < tx.length) html += escHtml(tx.slice(cursor));
    const span = document.createElement("span");
    span.className = "orig-hl-line";
    span.innerHTML = html;
    setOrigLineGeo(span, bb, scale);
    hlEl.appendChild(span);
    return span;
  }

  // —— 原页悬浮：整段/整图/整公式高亮 + 悬浮「AI 解释」按钮 ——
  const origHoverState = { page: -1, groups: [], hots: [] };

  // 仅取当前源在当前页的图/表（bbox 为 PDF 点坐标，0 基页，与原页坐标体系一致）
  function origPageFigures(page) {
    const sid = originalSourceId();
    if (!sid) return [];
    const src = (store.detail?.sources || []).find((s) => s.source_id === sid);
    const figs = (src && src.figures) || [];
    return figs.filter((f) => Number(f.page) === page && Array.isArray(f.bbox) && f.bbox.length === 4);
  }

  // 图表热区文案：优先图注；无图注的拆分子图一律按所属整幅图号/页码标注，
  // 严禁回落到内部编号（fig8）以免误导 AI 把它当成论文图号。
  function origFigHotText(f) {
    const cap = String((f && f.caption) || "").trim();
    if (cap) return cap;
    const n = f && f.whole_ref && String(f.whole_ref.figure_number || "").trim();
    if (n) return `图 ${n}（局部子图，正文未单独命名）`;
    const page = Number(f && f.page);
    return Number.isFinite(page) ? `第 ${page + 1} 页上的图表（无图注）` : "论文中的一张图表（无图注）";
  }

  // 当前页热区 = 图/表 + 公式区域（公式区域用原页同一套 label_formula_regions 的 bbox）
  function buildOrigHotspots(pmeta) {
    const hots = [];
    for (const f of origPageFigures(store.originalPage)) {
      // 与下方公式分支对齐：坐标不可用的图不建热区，否则点它放大时会把
      // NaN 坐标直接拼进裁剪 URL（空/undefined bbox 经算术会变 NaN）
      if (!finiteBbox(f.bbox)) continue;
      hots.push({ kind: "fig", bbox: f.bbox, text: origFigHotText(f) });
    }
    for (const r of (pmeta && pmeta.formula_regions) || []) {
      if (!r || !r.bbox || r.bbox.length !== 4) continue;
      const label = r.label != null && String(r.label).trim() !== "" ? `（${String(r.label).trim()}）` : "";
      // 取公式区域内的文本层内容作为解释上下文（排除纯编号行）
      const ctx = origFormulaContext(pmeta, r.bbox);
      hots.push({ kind: "formula", bbox: r.bbox, text: `公式 ${label}`.trim(), ctx });
    }
    return hots;
  }

  // 提取公式区域 bbox 内的文本行，作为公式解释的上下文
  function origFormulaContext(pmeta, bb) {
    const rows = (pmeta && pmeta.text_layer) || [];
    if (!bb || !rows.length) return "";
    const parts = [];
    for (const ln of rows) {
      const b = ln && ln.bbox;
      if (!b || b.length !== 4) continue;
      if (!(b[2] > bb[0] && b[0] < bb[2] && b[3] > bb[1] && b[1] < bb[3])) continue;
      const t = String(ln.text || "").trim();
      if (!t || /^[（(]?[0-9][0-9.,]*[)）]?$/.test(t)) continue; // 跳过纯编号行
      parts.push(t);
    }
    const ctx = parts.join(" ");
    return ctx.length > 400 ? ctx.slice(0, 400) + "…" : ctx;
  }

  // 不同热区种类的按钮文案
  function origHotLabel(kind) {
    return kind === "fig" ? "AI 解释图表" : kind === "formula" ? "AI 解释公式" : "AI 解释";
  }

  // —— 原页高亮的撤销 / 重做 / 清除（会话级历史） ——
  const origHlHistory = [];
  const origHlRedo = [];
  const origHlClone = (arr) => (arr || []).map((h) => JSON.parse(JSON.stringify(h)));
  const origHlSnapshot = () => origHlClone(store.originalHl);

  function origHlCommit() {
    origHlHistory.push(origHlSnapshot());
    if (origHlHistory.length > 80) origHlHistory.shift();
    origHlRedo.length = 0;
  }
  function origHlRefreshUI() {
    const body = el("lit-reader-body");
    const wrap = body && body.querySelector("[data-orig-wrap]");
    if (wrap && store.originalPage >= 0) renderOrigTextLayer(wrap, originalMetaForPage(store.originalPage));
    const undo = body && body.querySelector('[data-orig="undo-hl"]');
    const redo = body && body.querySelector('[data-orig="redo-hl"]');
    const clear = body && body.querySelector('[data-orig="clear-hl"]');
    if (undo) undo.disabled = !origHlHistory.length;
    if (redo) redo.disabled = !origHlRedo.length;
    if (clear) clear.disabled = !(store.originalHl && store.originalHl.length);
  }
  function origHlUndo() {
    if (!origHlHistory.length) return;
    origHlRedo.push(origHlSnapshot());
    store.originalHl = origHlHistory.pop();
    origHlRefreshUI();
    persistOriginalHighlights();
    renderHighlights();
  }
  function origHlRedoRun() {
    if (!origHlRedo.length) return;
    origHlHistory.push(origHlSnapshot());
    store.originalHl = origHlRedo.pop();
    origHlRefreshUI();
    persistOriginalHighlights();
    renderHighlights();
  }
  function origHlClearAll() {
    if (!(store.originalHl && store.originalHl.length)) return;
    origHlCommit();
    store.originalHl = [];
    origHlRefreshUI();
    persistOriginalHighlights();
    renderHighlights();
  }

  // 把当页文本层行按纵向间距、首行缩进、列切换与行数上限聚合成「段」，返回 [{bbox, text, idxs}]
  function origBuildParagraphs(pmeta) {
    const lines = (pmeta && pmeta.text_layer) || [];
    const groups = [];
    let cur = null;
    const hs = lines.map((l) => Math.max(1, Math.abs((l.bbox || [0, 0, 0, 0])[3] - (l.bbox || [0, 0, 0, 0])[1])));
    const sortedHs = hs.slice().sort((a, b) => a - b);
    const medH = sortedHs[Math.floor(sortedHs.length / 2)] || 11;
    const breakGap = medH * 1.35;   // 明显段距/空行 → 强制分段
    const mergeGap = medH * 0.55;   // 紧密同行 → 视为同一段
    const indentBreak = medH * 1.1; // 首行缩进（约 2 个字宽）→ 新段
    const MAX_LINES = 9;            // 单段行数上限，避免整页糊成一段
    const newGroup = (i, b, t) => {
      cur = { x0: b[0], bbox: [b[0], b[1], b[2], b[3]], idxs: [i], texts: [t] };
      groups.push(cur);
    };
    lines.forEach((ln, i) => {
      const b = ln.bbox;
      const t = String(ln.text || "");
      if (!b || b.length !== 4 || !t.trim()) return;
      if (!cur) { newGroup(i, b, t); return; }
      const gb = cur.bbox;
      const gap = b[1] - gb[3];
      const alignedX = (b[0] < gb[2] + medH * 2) && (b[2] > gb[0] - medH * 2);
      const indent = b[0] - cur.x0;
      // 句号＋换行 → 细分段：把以句末标点收尾的行后接的换行作为段落边界，
      // 让整页糊成一大段的文献也能按句子群被悬浮选中与解释
      const prevText = cur.texts.length ? String(cur.texts[cur.texts.length - 1]).trim() : "";
      const pEndsSentence = /[。.!?！？;；]\s*$/.test(prevText);
      const isNewPara =
        gap > breakGap ||                               // 明显空行/段距
        (gap > mergeGap && indent > medH * 0.6) ||      // 中等间距且带缩进
        (cur.idxs.length >= 2 && indent > indentBreak) || // 明显首行缩进
        cur.idxs.length >= MAX_LINES ||                 // 行数上限
        !alignedX ||                                    // 列/栏切换
        (pEndsSentence && gap > mergeGap);              // 句号结尾 + 换行间距 → 细分段
      if (gap >= -medH * 0.25 && !isNewPara) {
        cur.bbox[0] = Math.min(gb[0], b[0]);
        cur.bbox[1] = Math.min(gb[1], b[1]);
        cur.bbox[2] = Math.max(gb[2], b[2]);
        cur.bbox[3] = Math.max(gb[3], b[3]);
        cur.idxs.push(i);
        cur.texts.push(ln.text);
      } else {
        newGroup(i, b, t);
      }
    });
    return groups
      .map((g) => ({ bbox: g.bbox, idxs: g.idxs, text: g.texts.join("\n").replace(/[ \t]+\n/g, "\n").trim() }))
      .filter((g) => g.text);
  }

  // 按当前缩放重建「热区」层（图/表 + 公式，与文本层同一坐标/缩放体系）
  function renderOrigHotspots(wrap) {
    const figLayer = wrap && wrap.querySelector ? wrap.querySelector("[data-orig-fig]") : null;
    if (!figLayer || !origHoverState.hots) return;
    const img = wrap.querySelector("[data-orig-img]");
    const pmeta = originalMetaForPage(store.originalPage);
    const pageW = (pmeta && pmeta.w) || (img && img.naturalWidth) || 612;
    const scale = img ? img.clientWidth / pageW : 1;
    figLayer.innerHTML = "";
    origHoverState.hots.forEach((hot, i) => {
      const d = document.createElement("div");
      d.className = "orig-fig-hit";
      d.dataset.hot = String(i);
      const bb = hot.bbox;
      d.style.left = (bb[0] * scale) + "px";
      d.style.top = (bb[1] * scale) + "px";
      d.style.width = Math.max(4, (bb[2] - bb[0]) * scale) + "px";
      d.style.height = Math.max(4, (bb[3] - bb[1]) * scale) + "px";
      figLayer.appendChild(d);
    });
  }

  function initOrigHover(wrap) {
    if (!wrap) return;
    const figLayer = wrap.querySelector("[data-orig-fig]");
    let hover = wrap.querySelector("[data-orig-hover]");
    if (!hover) return;
    if (!hover.querySelector("[data-orig-hbox]")) {
      hover.innerHTML = `
        <div class="orig-hover-box" data-orig-hbox></div>
        <button class="orig-hover-dot" data-orig-dot type="button" aria-label="更多操作" aria-haspopup="true" aria-expanded="false">···</button>
        <div class="orig-hover-btnrow" data-orig-hrow>
          <button class="orig-hover-btn secondary" data-orig-atch type="button">${tipIcon("plus")}选中</button>
          <button class="orig-hover-btn" data-orig-hbtn type="button">${tipIcon("spark")}AI 解释</button>
        </div>
        <div class="orig-hover-pop" data-orig-hpop></div>`;
    }
    const box = hover.querySelector("[data-orig-hbox]");
    const row = hover.querySelector("[data-orig-hrow]");
    const btn = hover.querySelector("[data-orig-hbtn]");
    const atchBtn = hover.querySelector("[data-orig-atch]");
    const dot = hover.querySelector("[data-orig-dot]");
    const pop = hover.querySelector("[data-orig-hpop]");
    if (!figLayer || !box || !btn || !atchBtn || !dot || !pop) return;

    let active = null;      // { type, idx, text, pxBox }
    let dotPos = null;      // { x, y, sz } 悬浮区右上角小圆点的位置
    let popShowing = false;
    let mouseDown = false;
    let hideTimer = 0;      // 悬浮 UI 的延迟收起计时器：鼠标走在「选区 → 按钮」之间时不能闪断
    let askSeq = 0;         // AI 解释请求序号：连点多个目标时只认最后一次的结果
    let busyAsking = false; // 正在解析：期间保持反馈可见，不自动收起面板/按钮

    const inUI = (ev) => !!(ev.target && ev.target.closest && ev.target.closest("[data-orig-hover]"));

    const closePop = () => {
      pop.style.display = "none";
      popShowing = false;
    };

    // 悬浮按钮组常挂在选区边沿（选区窄/矮时直接落到选区之外）。旧逻辑只要鼠标离开
    // 「选区矩形」就立刻 hideHigh + active = null，于是从选区走向按钮的途中按钮先消失，
    // 用户永远点不中；就算点中了，runExplain 读到的 active 已是 null，静默 return，
    // 表现成「点了 AI 解释毫无反应」。
    // 这里把「选区 + 可见 UI 元素」并集外扩 16px 做成免隐藏区：box / row / dot 都是
    // pointer-events: none 的容器（鼠标划过按钮之间的 gap 时 ev.target 会漏到下层），
    // 只靠 ev.target 判断是不够的。
    // pop 不参与：它是实心可交互面板，鼠标落在其上时 ev.target 已在 [data-orig-hover] 内。
    const UI_BLEED = 16;
    const overUIRect = (ev) => {
      for (const n of [box, row, dot]) {
        if (!n || n.style.display === "none") continue;
        const r = n.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (ev.clientX >= r.left - UI_BLEED && ev.clientX <= r.right + UI_BLEED &&
            ev.clientY >= r.top - UI_BLEED && ev.clientY <= r.bottom + UI_BLEED) return true;
      }
      return false;
    };
    const cancelHide = () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; } };
    const scheduleHide = (delay) => {
      cancelHide();
      hideTimer = window.setTimeout(() => {
        hideTimer = 0;
        if (mouseDown || busyAsking) return;   // 正在解析：别把「正在解析」的进度收掉
        hideHigh(box, row);
      }, delay || 260);
    };

    const pageScale = () => {
      const img = wrap.querySelector("[data-orig-img]");
      const pmeta = originalMetaForPage(store.originalPage);
      const pageW = (pmeta && pmeta.w) || (img && img.naturalWidth) || 612;
      return img ? img.clientWidth / pageW : 1;
    };

    const ensurePage = () => {
      const pmeta = originalMetaForPage(store.originalPage);
      // 缓存失效判据里必须带「段落表为空」这一条：元数据还没到位时算过一次空表，
      // page 就被记住了，之后 meta 到齐、文本层也渲染出来，这里仍会一直早退 ——
      // 段落表永远停在空表，hitAt 永远返回 null，表现为「原页上悬停再也不出按钮」。
      // pmeta 仍为 null 时照旧早退，免得 mousemove 高频重算。
      if (origHoverState.page === store.originalPage
        && (origHoverState.groups.length || !pmeta)) return;
      origHoverState.page = store.originalPage;
      origHoverState.groups = origBuildParagraphs(pmeta);
      origHoverState.hots = buildOrigHotspots(pmeta);
      popShowing = false;
      hideHigh(box, row);
      pop.style.display = "none";
      pop.innerHTML = "";
      renderOrigHotspots(wrap);
    };

    const pointToWrapPx = (ev) => {
      const wr = wrap.getBoundingClientRect();
      return { x: ev.clientX - wr.left, y: ev.clientY - wr.top };
    };

    // 面板默认放在「AI 解释」按钮/高亮右侧；空间不足才翻到左侧，不再放高亮下侧。
    // 纵向必须夹进 stage 的**可见区**：段落常落在页面下半部分，而面板最高 68vh，
    // 不夹的话下半截会落到 .orig-stage 之外 —— 那里被 .orig-body 的 overflow:hidden
    // 直接裁掉（翻页条还压在上面），用户在面板里滚到底也看不到最后几行。
    const placeOrigPop = (p, a) => {
      const PAD = 8;
      const vp = origVisibleBox(wrap);
      const nh = Math.max(0, vp.bottom - vp.top);
      // 先按可用高度收紧 max-height，再量高度：解析中 / 解析完 / 报错三种内容高度不同，
      // 各自都能拿到「夹完之后」的真实高度去定 top。
      p.style.maxHeight = Math.min(
        Math.max(120, nh - PAD * 2),
        Math.round(window.innerHeight * 0.68)
      ) + "px";
      const pw = p.offsetWidth || 520;
      const ph = p.offsetHeight || 0;
      let lx = a.pxBox.x + a.pxBox.w + 14;
      if (lx + pw > wrap.clientWidth + 12) lx = Math.max(4, a.pxBox.x - pw - 14);
      p.style.left = Math.max(4, lx) + "px";
      // 纵向默认与高亮顶部对齐（-6 是视觉微调）。
      // 高亮还在可见区内 → 面板必须整块也在可见区内，下方装不下就整体上移；
      // 高亮本身已被滚出可见区（用户翻页/滚动后答案才回来）→ 维持贴锚点，
      // 不硬把它拽回视口中间，免得答案突然盖住用户正在看的那一段。
      let ty = a.pxBox.y - 6;
      if (a.pxBox.y < vp.bottom && a.pxBox.y + a.pxBox.h > vp.top) {
        if (ty + ph > vp.bottom - PAD) ty = vp.bottom - PAD - ph;
        if (ty < vp.top + PAD) ty = vp.top + PAD;
      }
      p.style.top = Math.max(4, ty) + "px";
    };

    // 命中检测：优先文本层行 → 图/表热区
    const hitAt = (ev) => {
      const tlEl = wrap.querySelector("[data-orig-tl]");
      const lineEl = ev.target && ev.target.closest ? ev.target.closest("[data-line]") : null;
      if (lineEl && tlEl && tlEl.contains(lineEl)) {
        const idx = Number(lineEl.dataset.line);
        ensurePage();
        for (let i = 0; i < origHoverState.groups.length; i++) {
          if (origHoverState.groups[i].idxs.includes(idx)) return { type: "para", idx: i };
        }
      }
      const hotEl = ev.target && ev.target.closest ? ev.target.closest(".orig-fig-hit") : null;
      if (hotEl) {
        ensurePage();
        const hidx = Number(hotEl.dataset.hot);
        const hot = origHoverState.hots[hidx];
        if (hot) return { type: hot.kind, idx: hidx };
      }
      return null;
    };

    const placeActive = (hit) => {
      const scale = pageScale();
      ensurePage();
      let bbPt, text, ctx;
      let kindLabel = "段落";
      if (hit.type === "para") {
        const g = origHoverState.groups[hit.idx];
        bbPt = g.bbox; text = g.text;
      } else {
        const hot = origHoverState.hots[hit.idx];
        if (!hot) return;
        bbPt = hot.bbox;
        text = hot.text;
        ctx = hot.ctx;
        kindLabel = hit.type === "fig" ? "图表" : "公式";
      }
      const x = bbPt[0] * scale;
      const y = bbPt[1] * scale;
      const w = Math.max(6, (bbPt[2] - bbPt[0]) * scale);
      const h = Math.max(6, (bbPt[3] - bbPt[1]) * scale);
      active = { type: hit.type, idx: hit.idx, text, ctx, pxBox: { x, y, w, h }, page: store.originalPage, bbox: bbPt };
      box.style.left = x + "px";
      box.style.top = y + "px";
      box.style.width = w + "px";
      box.style.height = h + "px";
      box.style.display = "block";
      btn.textContent = origHotLabel(hit.type);
      btn.disabled = false;
      // 小圆点落在选区右上角：与高亮区域交叠（无需在空白边距去够），
      // 点击后展开「选中 / AI解释」菜单，平时仅一个点不遮原文
      const DOTSZ = 16;
      let dTop = y;
      if (dTop + DOTSZ > y + h) dTop = y + h - DOTSZ; // 保证圆点在选区竖直范围内
      // 选区很窄 / 贴到页面边沿时，圆点必须夹回 wrap 内：跑到 wrap 外（被 stage 裁掉）
      // 的那个点同样点不到。
      const fitDot = (v, hi) => Math.min(Math.max(v, 0), Math.max(0, hi));
      dotPos = {
        x: fitDot(x + w - DOTSZ, wrap.clientWidth - DOTSZ),
        y: fitDot(dTop, wrap.clientHeight - DOTSZ),
        sz: DOTSZ,
      };
      dot.style.left = dotPos.x + "px";
      dot.style.top = dotPos.y + "px";
      dot.style.display = "flex";
      dot.setAttribute("aria-expanded", "false");
      row.style.display = "none";
      row.style.transform = "none";
      row.classList.remove("is-busy");
    };

    const runExplain = async (targetBtn) => {
      // 快照当前悬浮目标：请求要等模型返回（本地模型常十几秒），期间鼠标一动
      // active 就可能被重定位覆盖。旧代码全程直读 active，一旦被清掉就静默 return，
      // 表现成「点了 AI 解释毫无反应」。
      const snap = active && active.text
        ? {
            type: active.type, idx: active.idx, text: active.text, ctx: active.ctx,
            page: active.page, bbox: active.bbox, pxBox: { ...active.pxBox },
          }
        : null;
      if (!targetBtn || !snap) return;
      const kind = snap.type; // para | fig | formula
      const kindLabel = kind === "fig" ? "图表" : kind === "formula" ? "公式" : "段落";
      let question;
      if (kind === "fig") {
        // 只注入“有真实图注的图表”（去重、按图注里的图号标成「图 N」），
        // 绝不注入内部编号（fig0/fig8/noic），否则模型会把它们误当成论文图号，
        // 进而断言「fig8 不存在」并长篇推断。选中图本身由 active.text 给出准确图注/图号。
        const figs = (typeof readerFigures === "function" ? readerFigures() : []) || [];
        const seen = new Set();
        const cleanList = [];
        for (const f of figs) {
          const cap = String((f && f.caption) || "").trim();
          if (!cap) continue;
          const num = figNumberPrefix(cap);
          const entry = (num ? `图 ${num}：` : "") + cap;
          if (seen.has(entry)) continue;
          seen.add(entry);
          cleanList.push(`- ${entry}`);
        }
        const figList = cleanList.length
          ? "\n\n（本文正文已提取到的带图注图表清单，供你对照识别用户所指图表：\n" + cleanList.join("\n") + "\n）" : "";
        question = `请用简洁的中文解释论文中的这张图表（${snap.text || "无标题"}）。` +
          `该图可能是用户从整体大图里选中的某个局部子图，请先依据给出的图注/图号确定它属于哪一幅图；` +
          `如果该图缺少独立图注或正文未直接详细描述，请依据论文正文在相应章节对图示结果的描述来解释它；` +
          `确有必要时可结合相关领域知识作有限补充并标注「领域知识补充」，但严禁臆造论文中不存在的图、编号或数据；` +
          `注意：正文或清单里的 fig0/fig1 等只是内部截取编号，不是论文图号，禁止据此断言某号图表不存在，` +
          `也严禁回答「论文未提及」「该图不存在」之类的拒答。${figList}`;
      } else if (kind === "formula") {
        const fCtx = snap.ctx ? `\n（该公式所在区域提取到的上下文文本：${snap.ctx}）` : "";
        question = `请用简洁的中文解释论文中的这个公式（这是用户从论文页面选中的内容，文本可能因 OCR 提取而不完整）：${snap.text}。` +
          `请说明它表达的含义、涉及的符号、推导要点以及在文中的作用；` +
          `即使该公式文本与论文正文不完全匹配或正文未直接提及该编号，也请结合论文上下文与相关领域知识给出实质性解释，严禁回答「论文未提及」。${fCtx}`;
      } else {
        question = `请用简洁的中文解释论文中的这段话。注意：以下是用户从论文里【精确选中的原文片段】，请以这段文字本身为核心展开解释（说出它的含义、在文中的作用与涉及的关键概念），绝对不要把解释对象换成其它章节、其它论文或其它领域的内容，也不得声称该片段属于别的文献；若它对应论文中的图表或公式，请结合该片段文字与相关领域知识解释，必要的补充须标注「领域知识补充」，严禁编造论文中不存在的图、编号或数据，严禁回答「论文未提及/该图不存在」之类的拒答。\n\n【选中片段】\n${snap.text}`;
      }
      const btnLabel = origHotLabel(kind);
      const seq = ++askSeq;          // 连点多个目标时，只认最后一次的结果
      busyAsking = true;
      targetBtn.disabled = true;
      targetBtn.innerHTML = `<span class="orig-hover-spin" aria-hidden="true"></span>解析中…`;
      setRowBusy(true);
      // 立刻把面板立起来给反馈：本地模型可能十几秒，旧代码这段时间界面上零变化
      //（「解析中…」还写在刚被 closeRow() 藏掉的按钮上）。解析中不给关闭按钮，
      // 避免「关掉后答案又自己冒出来」这种更让人困惑的状态。
      pop.className = "orig-hover-pop";
      pop.innerHTML = `
        <div class="orig-hover-pop-head">
          <span class="orig-hover-pop-title">${kindLabel}解释</span>
          <span class="orig-hover-busy"><span class="orig-hover-spin" aria-hidden="true"></span>正在解析</span>
        </div>
        <div class="orig-hover-pop-body"><div class="orig-hover-skeleton"><i></i><i></i><i></i></div></div>`;
      pop.style.display = "block";
      popShowing = true;
      placeOrigPop(pop, snap);
      try {
        const res = await window.api(`/api/literature/${encodeURIComponent(store.currentId)}/ask`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question }),
        });
        if (seq !== askSeq) return;
        pop.className = "orig-hover-pop";
        pop.innerHTML = `
          <div class="orig-hover-pop-head">
            <span class="orig-hover-pop-title">${kindLabel}解释</span>
            <button class="orig-hover-close" type="button" data-ohclose aria-label="关闭">×</button>
          </div>
          <div class="orig-hover-pop-body">${renderMarkdown(res.answer || "（无解释）")}</div>`;
        pop.style.display = "block";
        placeOrigPop(pop, snap);
        // 落库：slot 用「位置」而不是回答内容 —— 同一处重新解释只覆盖，不堆成很多条
        saveAiAnswer(
          aiStableKey("explain|" + snap.type + "|" + snap.page + "|" + snap.idx),
          aiAnswerPayload(snap.text || kindLabel + "解释", res.answer, kind, snap.page)
        );
        // AI 解释正文支持划词高亮：key 由目标 + 回答内容决定，重新打开同一解释时可复用已存高亮
        const hbody = pop.querySelector(".orig-hover-pop-body");
        if (hbody) {
          hbody.dataset.aiHlKind = "ai";
          hbody.dataset.aiHlKey = aiStableKey(snap.type + "|" + snap.page + "|" + snap.idx + "|" + (res.answer || ""));
          applyAiHlToRoot(hbody, "ai", hbody.dataset.aiHlKey);
        }
      } catch (error) {
        if (seq !== askSeq) return;
        pop.className = "orig-hover-pop error";
        pop.innerHTML = `
          <div class="orig-hover-pop-head">
            <span class="orig-hover-pop-title">${kindLabel}解释</span>
            <button class="orig-hover-close" type="button" data-ohclose aria-label="关闭">×</button>
          </div>
          <div class="orig-hover-pop-body">
            <p class="orig-hover-err">${esc((error && error.message) || "解析失败")}</p>
            <button class="orig-hover-retry" type="button" data-ohretry>重试</button>
          </div>`;
        pop.style.display = "block";
        placeOrigPop(pop, snap);
        const retry = pop.querySelector("[data-ohretry]");
        if (retry) retry.addEventListener("click", () => runExplain(btn));
      } finally {
        if (seq === askSeq) {
          busyAsking = false;
          setRowBusy(false);
          targetBtn.disabled = false;
          targetBtn.textContent = btnLabel;
        }
      }
    };

    // 小圆点：点击展开/收起「选中 / AI解释」菜单（平时仅一个点，不遮原文）
    const openRow = () => {
      if (!active || !dotPos) return;
      row.style.display = "flex";            // 先摆出来，量到真实尺寸再定位置
      row.style.transform = "none";
      const rw = row.offsetWidth || 104;
      const rh = row.offsetHeight || 62;
      // 优先落在选区内侧右下角：鼠标几乎不用离开高亮区就能点到按钮。
      // 选区太窄/太矮才外挂到小圆点下方，并整体夹回 wrap 可视范围
      //（超出 wrap 会被 .orig-stage 的 overflow:auto 裁掉，那部分点不到）。
      const fitRow = (v, hi) => Math.min(Math.max(v, 2), Math.max(2, hi));
      const left = Math.max(active.pxBox.x + active.pxBox.w - rw - 4, active.pxBox.x + 2);
      let top = active.pxBox.y + active.pxBox.h - rh - 4;
      if (top < active.pxBox.y + 2) top = dotPos.y + dotPos.sz + 4;
      row.style.left = fitRow(left, wrap.clientWidth - rw) + "px";
      row.style.top = fitRow(top, wrap.clientHeight - rh) + "px";
      dot.setAttribute("aria-expanded", "true");
      cancelHide();
    };
    const closeRow = () => {
      row.style.display = "none";
      dot.setAttribute("aria-expanded", "false");
    };
    const setRowBusy = (busy) => {
      row.classList.toggle("is-busy", !!busy);
      atchBtn.disabled = !!busy;   // 解析中先别让「选中」再插一条上下文
    };
    dot.addEventListener("click", (ev) => {
      if (!active || !dotPos) return;
      ev.stopPropagation();
      if (row.style.display === "flex") closeRow();
      else openRow();
    });

    // 点「AI 解释」不再先 closeRow()：否则「解析中…」进度写在刚被藏起来的按钮上，
    // 用户看不到任何反馈。按钮留在原位转圈，面板同时立起来。
    btn.addEventListener("click", () => { cancelHide(); runExplain(btn); });

    // 面板内的关闭按钮走事件委托：面板 innerHTML 每次重写，绑定不会丢
    pop.addEventListener("click", (ev) => {
      const c = ev.target && ev.target.closest ? ev.target.closest("[data-ohclose]") : null;
      if (!c) return;
      ev.stopPropagation();
      if (busyAsking) return;      // 解析中：让「正在解析」留在屏幕上
      closePop();
    });

    // 「选中」：把当前悬浮的段落/图/公式挂到左侧问答栏为提问上下文（公式、图无法选中文字，故用按钮）
    atchBtn.addEventListener("click", () => {
      if (!active || !active.text) { closeRow(); return; }
      const kind = active.type === "formula" ? "formula" : active.type === "fig" ? "fig" : "text";
      const ctx = active.ctx ? `\n（公式所在区域提取到的上下文文本：${active.ctx}）` : "";
      const label = active.text;
      const text = active.type === "formula" ? active.text + ctx : active.text;
      attachQA(kind, label, text, { page: active.page, bbox: active.bbox });
      closeRow();
    });

    // 点击图/表/公式 → 在查看器里放大查看
    figLayer.addEventListener("click", (ev) => {
      const hotEl = ev.target && ev.target.closest ? ev.target.closest(".orig-fig-hit") : null;
      if (!hotEl) return;
      ensurePage();
      const hidx = Number(hotEl.dataset.hot);
      const hot = origHoverState.hots[hidx];
      if (!hot || (hot.kind !== "fig" && hot.kind !== "formula")) return;
      ev.stopPropagation();
      openOrigHotViewer(hot);
    });

    // 解释面板：头部可自由拖动，且不改动 hover 焦点
    hover.addEventListener("mousedown", (ev) => {
      const head = ev.target && ev.target.closest ? ev.target.closest(".orig-hover-pop-head") : null;
      if (!head || pop.style.display === "none") return;
      ev.preventDefault();
      ev.stopPropagation();
      mouseDown = true; // 拖动期间暂停 hover 重定位
      startOrigDrag(pop, ev);
    });

    wrap.addEventListener("mousemove", (ev) => {
      if (mouseDown) {
        // 兜底复位：在窗口外松手、或 mouseup 事件丢失时 window 上的监听收不到，
        // mouseDown 会永久停在 true，此后每个 mousemove 都被这一行挡掉 ——
        // 现象就是「悬停再也不出按钮、点了毫无反应」（真机验证时踩到过）。
        // 以标准 buttons 位为准：左键确实已经松开就复位，继续正常处理。
        if (ev.buttons & 1) return;
        mouseDown = false;
      }
      // 在悬浮 UI 上、或落在「选区 + UI」外扩的免隐藏区内：保持现状
      if (inUI(ev) || overUIRect(ev)) { cancelHide(); return; }
      const pt = pointToWrapPx(ev);
      const hit = hitAt(ev);
      if (hit) {
        cancelHide();
        // UI 被收起后又回到同一段：得能重新浮出来（只比对 type/idx 会漏掉这种情形）
        const same = active && active.type === hit.type && active.idx === hit.idx;
        if (!same || box.style.display === "none") placeActive(hit);
        return;
      }
      // 兜底：鼠标仍停在高亮目标范围内（按钮组正压在选区边沿时命中判定会被它挡住）。
      // 这里同样要检查 UI 是否已被收起 —— active 现在会跨「收起」保留，
      // 只 return 不重浮的话，用户移开再回来就再也唤不出按钮。
      if (active && active.pxBox) {
        const b = active.pxBox;
        if (pt.x >= b.x - 2 && pt.x <= b.x + b.w + 2 && pt.y >= b.y - 2 && pt.y <= b.y + b.h + 2) {
          cancelHide();
          if (box.style.display === "none") placeActive({ type: active.type, idx: active.idx });
          return;
        }
      }
      // 真的离开了「选区 + 悬浮 UI」：延迟 260ms 再收，给鼠标走完「选区 → 按钮」
      // 之间那段空隙的时间。旧逻辑在这里立刻 hideHigh + active = null，
      // 于是按钮先消失、点不中；就算点中，runExplain 也因 active = null 静默 return。
      if (hideTimer) return;
      scheduleHide(260);
    });
    wrap.addEventListener("mousedown", (ev) => {
      if (busyAsking) return;                 // 解析中：不收起正在显示进度的面板/按钮
      if (inUI(ev) || overUIRect(ev)) return; // 悬浮 UI 上按下不隐藏，交给 click
      mouseDown = true;
      if (popShowing) {
        const overPop = ev.target && ev.target.closest && ev.target.closest(".orig-hover-pop") !== null;
        if (!overPop) closePop();
      }
      if (!popShowing) { cancelHide(); hideHigh(box, row); }
    });
    window.addEventListener("mouseup", () => { mouseDown = false; });
    wrap.addEventListener("mouseleave", () => {
      if (popShowing || busyAsking) return;
      cancelHide();
      // 只收起高亮与按钮，保留 active：面板回填 / 重新定位还要靠它
      hideHigh(box, row);
    });
  }

  function hideHigh(box, btn) {
    if (!box) return;
    box.style.display = "none";
    if (btn) btn.style.display = "none";
    const hover = box.closest ? box.closest("[data-orig-hover]") : null;
    const dot = hover && hover.querySelector ? hover.querySelector("[data-orig-dot]") : null;
    if (dot) { dot.style.display = "none"; dot.setAttribute("aria-expanded", "false"); }
  }

  const origClamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  // 原页悬浮 UI 的「可见区」：.orig-stage 的可视范围，换算成 wrap 内坐标。
  // wrap 是整页图，通常比 stage 视口高得多（还带 scrollTop），所以**不能**拿
  // wrap.clientHeight 当纵向边界 —— 那样夹完照样落在 .orig-body 的裁剪区里，
  // 表现就是「面板下半截、或拖下去的按钮在屏幕上凭空消失」。
  function origVisibleBox(wrap) {
    const fallback = { top: 0, bottom: (wrap && wrap.clientHeight) || 700 };
    if (!wrap || !wrap.closest) return fallback;
    const stageEl = wrap.closest("[data-orig-stage]");
    if (!stageEl) return fallback;
    const wr = wrap.getBoundingClientRect();
    const sr = stageEl.getBoundingClientRect();
    const top = Math.max(0, sr.top - wr.top);
    const bottom = Math.min(wrap.clientHeight || sr.height, sr.bottom - wr.top);
    if (!(bottom > top)) return fallback;
    return { top, bottom };
  }

  // 解释面板自由拖动（wrap 内坐标，无缩放换算）
  function startOrigDrag(pop, startEv) {
    const wrap = pop.closest("[data-orig-wrap]");
    const startX = startEv.clientX, startY = startEv.clientY;
    const cl = parseFloat(pop.style.left) || 0;
    const ct = parseFloat(pop.style.top) || 0;
    const wrapW = wrap ? wrap.clientWidth : 900;
    const pw = pop.offsetWidth || 480;
    // 纵向落点按「整块面板能落在可见区内」算：拖出 stage 可视区就进了裁剪区，
    // 看上去是「一拖就没了」，比放不下更让人困惑。
    const vp = origVisibleBox(wrap);
    const vpH = Math.max(0, vp.bottom - vp.top);
    const topLo = vp.top + 4;
    const topHi = Math.max(topLo, vp.bottom - 4 - Math.min(pop.offsetHeight || 0, vpH - 8));
    const move = (e) => {
      if (e.preventDefault) e.preventDefault();
      pop.style.left = origClamp(cl + (e.clientX - startX), -pw + 60, Math.max(60, wrapW - 60)) + "px";
      pop.style.top = origClamp(ct + (e.clientY - startY), topLo, topHi) + "px";
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  // 点击图/表/公式 → 放大查看
  function openOrigHotViewer(hot) {
    const base = originalBase();
    if (!base) return;
    const dpi = hot.kind === "formula" ? 300 : 200;
    const src = origCropUrl(base, store.originalPage, hot.bbox, dpi);
    if (!src) return;  // 坐标不可用：宁可不弹查看器，也不发一个注定 500 的请求
    const title = hot.kind === "formula" ? "公式放大查看" : "图表放大查看";
    openOrigViewer(src, title);
  }

  // 轻量放大查看器（挂到 document.body 的 fixed 蒙层）
  function openOrigViewer(src, title) {
    let ov = document.getElementById("orig-viewer");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "orig-viewer";
      ov.className = "orig-viewer";
      ov.innerHTML = `
        <div class="orig-viewer-bar">
          <span class="orig-viewer-title" data-ovtitle></span>
          <span class="orig-viewer-hint">滚轮或拖滚动条查看；点图放大</span>
          <button type="button" class="orig-viewer-close" data-ovclose aria-label="关闭">×</button>
        </div>
        <div class="orig-viewer-body" data-ovbody><img data-ovimg alt="查看大图"></div>`;
      document.body.appendChild(ov);
      ov.querySelector("[data-ovclose]").addEventListener("click", (e) => { e.stopPropagation(); closeOrigViewer(); });
      ov.addEventListener("click", (e) => { if (e.target === ov) closeOrigViewer(); });
      ov.querySelector("[data-ovbody]").addEventListener("wheel", (e) => e.stopPropagation(), { passive: false });
      const img = ov.querySelector("[data-ovimg]");
      img.addEventListener("click", () => {
        const isZoomed = img.style.maxWidth === "none";
        img.style.maxWidth = isZoomed ? "" : "none";
        img.style.width = isZoomed ? "" : "auto";
      });
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeOrigViewer(); });
    }
    ov.querySelector("[data-ovimg]").src = src;
    ov.querySelector("[data-ovtitle]").textContent = title || "查看";
    ov.classList.add("orig-viewer-show");
  }
  function closeOrigViewer() {
    const ov = document.getElementById("orig-viewer");
    if (ov) ov.classList.remove("orig-viewer-show");
  }

  // —— 容器宽度变化后的覆盖层重排 ——
  // 公式图 / 透明文字层 / 高亮层的几何都是按页图加载那一刻的 img.clientWidth 换算的 px 值；
  // 拖动左右分栏、缩放、窗口尺寸一变，页图跟着容器伸缩，这些层若不重算就会整体错位。
  // 这里按当前宽度重算位置，不重载任何图片。
  function relayoutOrigOverlays(wrap) {
    if (!wrap) return;
    const img = wrap.querySelector("[data-orig-img]");
    if (!img || !img.clientWidth) return;
    const pmeta = originalMetaForPage(store.originalPage);
    const pageW = (pmeta && pmeta.w) || img.naturalWidth || 612;
    const scale = img.clientWidth / pageW;
    // 公式裁剪层
    for (const q of wrap.querySelectorAll(".orig-formula-img")) {
      const bb = q._origBB;
      if (!bb || bb.length !== 4) continue;
      q.style.left = (bb[0] * scale) + "px";
      q.style.top = (bb[1] * scale) + "px";
      q.style.width = (Math.max(6, bb[2] - bb[0]) * scale) + "px";
      q.style.height = (Math.max(8, bb[3] - bb[1]) * scale) + "px";
    }
    // 文字层 + 高亮层（两类 span 都在 setOrigLineGeo 里留了 _origBB）
    const tlEl = wrap.querySelector("[data-orig-tl]");
    const hlEl = wrap.querySelector("[data-orig-hl]");
    const fitList = [];
    for (const layer of [tlEl, hlEl]) {
      if (!layer) continue;
      for (const sp of layer.children) {
        const bb = sp._origBB;
        if (!bb || bb.length !== 4) continue;
        setOrigLineGeo(sp, bb, scale);
        fitList.push(sp);
      }
    }
    applyOrigLineFit(fitList, tlEl);
    // 热区（图表/公式可点击区域）自带 scale 计算，直接重建
    renderOrigHotspots(wrap);
    // 悬浮解释 UI 的定位基于旧几何，先收起，等下次 hover 重新弹出
    const hover = wrap.querySelector("[data-orig-hover]");
    if (hover) {
      const box = hover.querySelector("[data-orig-hbox]");
      const row = hover.querySelector("[data-orig-hrow]");
      const pop = hover.querySelector("[data-orig-hpop]");
      hideHigh(box, row);
      if (pop) { pop.style.display = "none"; pop.innerHTML = ""; }
    }
  }

  // 监听页容器宽度变化（分栏拖拽 / 窗口缩放 / 换页重建 DOM），rAF 去抖后重排
  let _origRO = null;
  let _origROTarget = null;
  let _origROQueued = false;
  function watchOrigWrapResize(wrap) {
    if (!wrap) return;
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", () => relayoutOrigOverlays(wrap));
      return;
    }
    if (!_origRO) {
      _origRO = new ResizeObserver(() => {
        if (_origROQueued) return;
        _origROQueued = true;
        requestAnimationFrame(() => {
          _origROQueued = false;
          relayoutOrigOverlays(document.querySelector("[data-orig-wrap]"));
        });
      });
    }
    // 换文献/重渲染会换新的 wrap：先解除旧目标（RO 强持有目标，不解会泄漏）
    if (_origROTarget && _origROTarget !== wrap) {
      try { _origRO.unobserve(_origROTarget); } catch {}
    }
    _origROTarget = wrap;
    _origRO.observe(wrap);
  }

  function applyOrigZoom() {
    const wrap = el("lit-reader-body")?.querySelector("[data-orig-wrap]");
    const label = el("lit-reader-body")?.querySelector("[data-orig-label]");
    if (!wrap) return;
    // 占满：默认 100% 宽贴合容器；放大时超出可横向滚动
    wrap.style.width = Math.round(100 * store.originalZoom) + "%";
    if (label) label.textContent = Math.round(store.originalZoom * 100) + "%";
    // 缩放改变 wrap 宽度：重排公式/文字/热区各层（内部含 renderOrigHotspots），
    // 并隐藏可能错位的悬浮高亮
    relayoutOrigOverlays(wrap);
  }

  function updateOrigPageLabel() {
    const lab = el("lit-reader-body")?.querySelector("[data-orig-pagelabel]");
    if (lab) lab.textContent = (store.originalPage + 1) + " / " + nOrigPages();
  }

  function showOrigError(err) {
    const elerr = el("lit-reader-body")?.querySelector("[data-orig-err]");
    if (!elerr) return;
    elerr.classList.remove("hidden");
    elerr.innerHTML = `<span class="compass">!</span><p>${esc((err && err.message) || "原页不可用")}</p><button type="button" class="secondary-button" data-orig="todot">切换到文理视图</button>`;
  }

  // —— 定位段落（目录/图表/高亮跳转） ——
  // 在合并后的段落中查找子串，返回索引，-1 表示未找到
  function findParagraphIndex(substr) {
    const paras = mergeShortParagraphs(mergePipeTableParagraphs(splitParagraphs(readerText())));
    let idx = paras.findIndex((p) => p.includes(substr));
    if (idx < 0) {
      const clean = String(substr || "").replace(/\s+/g, "");
      if (clean.length >= 4) {
        const chunkLen = clean.length >= 12 ? 6 : 4;
        const chunks = [];
        for (let i = 0; i <= clean.length - chunkLen; i++) {
          chunks.push(clean.slice(i, i + chunkLen));
        }
        idx = paras.findIndex((p) => {
          const pc = p.replace(/\s+/g, "");
          const hits = chunks.filter((ch) => pc.includes(ch)).length;
          return hits >= Math.min(2, chunks.length);
        });
      }
    }
    if (idx < 0) {
      const tokens = String(substr || "").split(/\s+/).filter((t) => t.length > 3).slice(0, 3);
      idx = paras.findIndex((p) => tokens.every((t) => p.includes(t)));
    }
    return idx;
  }

  function scrollToParagraph(idx, flashText) {
    const node = document.querySelector(`[data-para-index="${idx}"]`);
    if (!node) return false;
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    if (flashText) {
      setTimeout(() => {
        flashTextInNode(node, flashText);
      }, 400);
    }
    return true;
  }

  function locateParagraph(substr, flashTarget) {
    const idx = findParagraphIndex(substr);
    if (idx < 0) return false;
    return scrollToParagraph(idx, flashTarget || substr);
  }
  // 精确滚动到指定图片图块并短暂高亮，而非靠正文文本粗定位
  function locateFigure(figId) {
    if (figId === null || figId === undefined || String(figId) === "") return false;
    let node = null;
    try { node = document.querySelector(`[data-figure-id="${CSS.escape(String(figId))}"]`); }
    catch (e) {
      const safe = String(figId).replace(/["\\]/g, "");
      node = document.querySelector(`[data-figure-id="${safe}"]`);
    }
    if (!node) return false;
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    node.classList.add("sr-figure-flash");
    clearTimeout(node._figFlashT);
    node._figFlashT = setTimeout(() => node.classList.remove("sr-figure-flash"), 1600);
    return true;
  }
  // 侧边栏/复合图内点击某个子图标签（A/B/C/D）：原页跳到子图区域，文理视图滚到整幅并框选该子图
  function handleLocateSubClick(target) {
    const page = Number(target.dataset.page);
    const bbox = String(target.dataset.bbox || "").split(",").map(Number);
    const union = String(target.dataset.union || "").split(",").map(Number);
    const gid = target.dataset.group;
    if (store.readMode === "original") {
      if (Number.isFinite(page) && bbox.length === 4) goToOrigPage(page, bbox, null);
      return;
    }
    if (gid) locateSubPanelText(gid, bbox, union);
  }
  function locateSubPanelText(gid, bbox, union) {
    let node = null;
    try { node = document.querySelector(`[data-figure-id="${CSS.escape(String(gid))}"]`); }
    catch (e) {
      const safe = String(gid).replace(/["\\]/g, "");
      node = document.querySelector(`[data-figure-id="${safe}"]`);
    }
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    node.classList.add("sr-figure-flash");
    clearTimeout(node._figFlashT);
    node._figFlashT = setTimeout(() => node.classList.remove("sr-figure-flash"), 1600);
    const img = node.querySelector(".sr-figure-img");
    if (img && union && union.length === 4 && bbox.length === 4) {
      const w = union[2] - union[0]; const h = union[3] - union[1];
      if (w > 0 && h > 0) {
        node.querySelectorAll(".sr-fig-panel-flash").forEach((n) => n.remove());
        const d = document.createElement("i");
        d.className = "sr-fig-panel-flash";
        d.style.left = ((bbox[0] - union[0]) / w * 100) + "%";
        d.style.top = ((bbox[1] - union[1]) / h * 100) + "%";
        d.style.width = ((bbox[2] - bbox[0]) / w * 100) + "%";
        d.style.height = ((bbox[3] - bbox[1]) / h * 100) + "%";
        img.parentElement.appendChild(d);
        setTimeout(() => d.remove(), 1700);
      }
    }
  }
  function flashTextInNode(container, searchText) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    for (const tn of textNodes) {
      const idx = tn.textContent.indexOf(searchText);
      if (idx < 0) continue;
      const range = document.createRange();
      range.setStart(tn, idx);
      range.setEnd(tn, idx + searchText.length);
      const span = document.createElement("span");
      span.className = "sr-locate-flash";
      try { range.surroundContents(span); } catch (e) { continue; }
      span.addEventListener("animationend", () => {
        const parent = span.parentNode;
        if (parent) {
          while (span.firstChild) parent.insertBefore(span.firstChild, span);
          parent.removeChild(span);
        }
      });
      break;
    }
  }

  // —— 目录 ——
  function extractHeadingsFromText() {
    const text = readerText();
    if (!text) return [];
    // 标记形如 [[H:2@17]]（@ 后是解析器带出的真实页码），兼容旧的 [[H:2]]。
    // 标题必须与标记**同行**：这里绝不能用 \s* 去跨行——空标记（[[H:2]] 后面
    // 直接换行）会把紧随其后的正文行当成标题，目录里就会出现「所以」「波长」
    // 「4.2」这类条目。
    const re = /^\[\[H:(\d)(?:@(\d+))?\]\](?:[ \t]+(.+))?$/gm;
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const level = parseInt(m[1], 10);
      const heading = (m[3] || "").trim();
      if (heading) out.push({ heading, level, page: m[2] || null });
    }
    return out;
  }

  // AI 抽取的 section_headings → 统一成 {heading, level, page}。
  // page 一律置空：模型看不到页码，它给的页码是编造的（实测整篇都是同一个数）。
  function normalizeModelHeadings(list) {
    if (!Array.isArray(list)) return [];
    const isHeadingNoise = (value) => {
      const heading = String(value || "").trim();
      // 与 PDF 解析器的最终收口保持一致：坐标轴单位/图例标签和页码计数
      // 不应因 AI 目录兜底而重新进入目录；有语义的后续标题文字仍保留。
      return /^\d+\s*(?:of|\/)\s*\d+$/i.test(heading)
        || /^[+\-−]?\d+(?:\.\d+)?\s*(?:(?:[�Ωμµ×±−-]{0,4}\s*)(?:load|input|output|signal|power|current|voltage|frequency|wavelength)|(?:GHz|MHz|kHz|THz|nm|μm|µm|dB|mV|kW|mW|uW|ps|fs|V|W|A))$/i.test(heading);
    };
    const out = [];
    for (const item of list) {
      if (typeof item === "string") {
        const heading = item.trim();
        if (heading && !isHeadingNoise(heading)) out.push({ heading, level: 2, page: null });
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const heading = String(item.heading || item.title || "").trim();
      if (!heading || isHeadingNoise(heading)) continue;
      const level = Number(item.level) || 2;
      out.push({ heading, level: Math.min(6, Math.max(1, level)), page: null });
    }
    return out;
  }

  // 将扁平 headings 构建为树形结构
  function buildTocTree(headings) {
    const roots = [];
    const stack = []; // 记录每个层级最近的父节点
    for (const h of headings) {
      const heading = typeof h === "string" ? h : (h && h.heading) || "";
      const level = (h && h.level) || 0;
      const page = h && h.page ? h.page : null;
      if (!heading || level < 1) continue;
      const node = { heading, level, page, children: [] };
      // 弹出栈中所有层级 >= 当前层级的节点
      while (stack.length && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      if (stack.length === 0) {
        roots.push(node);
      } else {
        stack[stack.length - 1].children.push(node);
      }
      stack.push(node);
    }
    return roots;
  }

  // 递归渲染树节点，返回 HTML 字符串
  const TOC_CHEVRON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>`;
  function renderTocTree(nodes, depth) {
    if (!nodes.length) return "";
    return nodes.map((n) => {
      const hasChildren = n.children && n.children.length > 0;
      const page = n.page ? ` · p.${esc(n.page)}` : "";
      const nodeId = "toc-" + Math.random().toString(36).slice(2, 8);
      let html = `<div class="sr-toc-node" style="padding-left:${(depth) * 14}px">`;
      html += `<div class="sr-toc-row">`;
      if (hasChildren) {
        html += `<button class="sr-toc-toggle" type="button" data-toc-toggle="${nodeId}" aria-expanded="true" aria-label="折叠">${TOC_CHEVRON}</button>`;
      } else {
        html += `<span class="sr-toc-toggle sr-toc-toggle--leaf"></span>`;
      }
      html += `<button class="sr-list-item sr-toc-item" type="button" data-lit-action="locate" data-text="${esc(n.heading)}"${n.page ? ` data-page="${esc(n.page)}"` : ""}>`;
      html += `<span class="sr-list-title">${esc(n.heading)}</span>${page ? `<span class="sr-list-sub">${esc(page)}</span>` : ""}`;
      html += `</button></div>`;
      if (hasChildren) {
        html += `<div class="sr-toc-children" id="${nodeId}">${renderTocTree(n.children, depth + 1)}</div>`;
      }
      html += `</div>`;
      return html;
    }).join("");
  }

  function renderToc() {
    const body = el("lit-toc-body");
    if (!body) return;
    // 目录以正文里的 [[H:n@p]] 标记为准：页码与层级是解析阶段从 PDF 版面算出来的，
    // 真实可用。AI 抽的 section_headings 只在解析器一条都没给出时才兜底
    // —— 它拿不到页码，之前还因为「模型结果优先」把好目录整个盖掉。
    let headings = extractHeadingsFromText();
    let fromModel = false;
    if (!headings.length) {
      headings = normalizeModelHeadings(store.detail?.meta?.section_headings);
      fromModel = headings.length > 0;
    }
    if (!headings.length) {
      body.innerHTML = `<p class="sr-list-empty">暂无目录。可在「文献信息」中重新抽取元数据。</p>`;
      return;
    }
    // 按级别筛选（下拉框）
    const level = store.tocLevel || 0;
    const filtered = level > 0 ? headings.filter((h) => {
      const lv = typeof h === "string" ? 0 : (h.level || 0);
      return lv === level;
    }) : headings;
    if (!filtered.length) {
      body.innerHTML = `<p class="sr-list-empty">该级别下暂无标题。</p>`;
      return;
    }
    const tree = buildTocTree(filtered);
    const note = fromModel
      ? `<p class="sr-list-empty">目录为 AI 抽取（无页码，仅供参考）</p>`
      : "";
    body.innerHTML = note + renderTocTree(tree, 0);
  }

  // —— 图表（基于正文真实提取的图片与其标题，精确锁定图块位置） ——
  function normalizeFigureCaption(raw) {
    let cap = String(raw || "").trim();
    // 部分中文 PDF 的字体编码会把「图」解码成 U+037C「ͼ」。保留正文描述，
    // 只把图号前缀恢复成用户能识别的「图 N」，避免图表栏出现乱码编号。
    cap = cap.replace(/^ͼ\s*(\d+)/, "图 $1");
    return cap;
  }
  function figureListTitle(fig) {
    const cap = normalizeFigureCaption(fig.caption);
    const re = /^(?:Fig(?:ure)?\.?|Table\.?|图|表)\s*\d+[A-Za-z]?/i;
    const m = re.exec(cap);
    if (m) return m[0];
    if (cap) {
      const short = cap.match(/^[^.:\n]{1,46}/);
      return (short ? short[0] : cap.replace(/\s+/g, " ")).slice(0, 46);
    }
    // 无图注的拆分子图：绝不显示内部编号（fig8），避免被当成论文图号。
    // 优先用解析器挂上的「所在章节标题」（fig.context）——原文没有图号时，
    // 「小节名 + 页码」比干巴巴的「第 N 页图表」有用得多，也仍然诚实。
    const context = String((fig && fig.context) || "").trim();
    const pg = Number(fig && fig.page);
    const pageLabel = Number.isFinite(pg) ? `第 ${pg + 1} 页` : "";
    if (context) {
      const short = context.length > 30 ? context.slice(0, 30) + "…" : context;
      return short;
    }
    return pageLabel ? `${pageLabel}图表` : "未命名图表";
  }
  function figureListSub(fig) {
    const cap = normalizeFigureCaption(fig.caption);
    if (!cap) {
      // 无图注：只有当标题用了「章节名」时才在副标题补页码，避免同一句话出现两次
      if (!String(fig.context || "").trim()) return "";
      const pg = Number(fig && fig.page);
      return Number.isFinite(pg) ? `第 ${pg + 1} 页` : "";
    }
    let rest = cap;
    const re = /^(?:Fig(?:ure)?\.?|Table\.?|图|表)\s*\d+[A-Za-z]?/i;
    const m = re.exec(cap);
    if (m) rest = cap.slice(m[0].length).replace(/^[.:：,，\s]+/, "");
    return rest.replace(/\s+/g, " ").slice(0, 64);
  }
  function renderFigures() {
    const body = el("lit-figures-body");
    if (!body) return;
    if (!store.detail) {
      body.innerHTML = `<p class="sr-list-empty">选中文献后显示图表。</p>`;
      return;
    }
    const groups = buildFigureGroups();
    if (!groups.length) {
      body.innerHTML = `<p class="sr-list-empty">正文中未提取到图片。</p>`;
      return;
    }
    body.innerHTML = groups.map((g) => {
      if (isCompositeGroup(g)) {
        const f0 = groupTitleMember(g);
        const title = f0 && f0.caption ? figureListTitle(f0) : `图 ${g.num || ""}`;
        const sub = f0 ? figureListSub(f0) : "";
        const crop = groupCropUrl(g, 200);
        const thumb = crop
          ? `<img class="sr-figure-thumb" src="${esc(crop)}" alt="" loading="lazy">`
          : (f0 && f0.image
            ? `<img class="sr-figure-thumb" src="${esc(f0.image)}" alt="" loading="lazy">`
            : `<span class="sr-figure-thumb sr-figure-thumb--ph">&#x1F5BC;</span>`);
        const u = g.union.join(",");
        const chips = g.composite.map((m) =>
          `<button class="sr-figure-panel-chip" type="button" data-lit-action="locate-sub" data-group="${esc(g.id)}" data-page="${g.page}" data-bbox="${m.bbox.join(",")}" data-union="${u}" title="子图 ${m._label}">${m._label}</button>`).join("");
        return `<div class="sr-figure-group">
          <button class="sr-list-item sr-figure-item" type="button" data-lit-action="locate-figure" data-fig="${esc(g.id)}">
            ${thumb}
            <span class="sr-figure-item-text">
              <span class="sr-list-title">${esc(title)}</span>
              ${sub ? `<span class="sr-list-sub">${esc(sub)}</span>` : ""}
            </span>
          </button>
          <div class="sr-figure-panels">${chips}</div>
        </div>`;
      }
      const f = g.members[0];
      const title = figureListTitle(f);
      const sub = figureListSub(f);
      const thumb = f.image
        ? `<img class="sr-figure-thumb" src="${esc(f.image)}" alt="" loading="lazy">`
        : `<span class="sr-figure-thumb sr-figure-thumb--ph">&#x1F5BC;</span>`;
      const figId = f.id !== undefined ? f.id : "";
      return `<button class="sr-list-item sr-figure-item" type="button" data-lit-action="locate-figure" data-fig="${esc(figId)}">
        ${thumb}
        <span class="sr-figure-item-text">
          <span class="sr-list-title">${esc(title)}</span>
          ${sub ? `<span class="sr-list-sub">${esc(sub)}</span>` : ""}
        </span>
      </button>`;
    }).join("");
  }

  // —— 阅读重点 + 推荐问题（调 /insights） ——
  async function loadInsights() {
    if (!store.currentId) return;
    if (store.insights) { renderKeypoints(); renderQA(); return; }
    const kpBody = el("lit-keypoints-body");
    if (kpBody) kpBody.innerHTML = `<p class="sr-list-empty">正在生成阅读重点…</p>`;
    try {
      const res = await window.api(`/api/literature/${encodeURIComponent(store.currentId)}/insights`, { method: "POST" });
      store.insights = { suggested_questions: res.suggested_questions || [], keypoints: res.keypoints || [] };
    } catch (error) {
      store.insights = { suggested_questions: [], keypoints: [] };
    }
    renderKeypoints();
    renderQA();
  }
  function renderKeypoints() {
    const body = el("lit-keypoints-body");
    if (!body) return;
    if (!store.detail) {
      body.innerHTML = `<p class="sr-list-empty">选中文献后显示阅读重点。</p>`;
      return;
    }
    const items = mergedKeypoints();
    const baseLen = (store.insights?.keypoints || []).length;
    const addedLen = userAddedKeypoints().length;
    let html = `<div class="sr-keypoints-toolbar">
      <button class="secondary-button sr-list-action" type="button" data-lit-action="add-keypoint">＋ 新增要点</button>
    </div>`;
    if (!baseLen && !addedLen && !store.kpEditing) {
      html += `<p class="sr-list-empty">暂无阅读重点。</p>
        <button class="secondary-button sr-list-action" type="button" data-lit-action="insights">生成阅读重点</button>`;
    }
    if (store.kpEditing) html += kpEditorHtml(store.kpEditing);
    html += items.map(kpItemHtml).join("");
    body.innerHTML = html;
  }

  // —— 阅读重点的本地合并与增删改（AI 结果 + 用户覆盖/新增） ——
  function kpKey(id) { return KP_KEY + id; }
  function getKpEdits(id) {
    if (id && id === store.currentId && store.marksReady) {
      const cur = store.markKp || {};
      return { aiOverrides: clone(cur.aiOverrides) || {}, added: clone(cur.added) || [] };
    }
    try {
      const raw = JSON.parse(localStorage.getItem(kpKey(id)) || "null");
      if (raw && typeof raw === "object") {
        return { aiOverrides: raw.aiOverrides || {}, added: Array.isArray(raw.added) ? raw.added : [] };
      }
    } catch {}
    return { aiOverrides: {}, added: [] };
  }
  function saveKpEdits(id, data) {
    const norm = { aiOverrides: (data && data.aiOverrides) || {}, added: (data && data.added) || [] };
    if (id === store.currentId && store.marksReady) store.markKp = clone(norm);
    try { localStorage.setItem(kpKey(id), JSON.stringify(norm)); } catch {}
    if (id === store.currentId) queueMarkSync("keypoints", "", norm);
  }
  // 对 AI keypoint 生成稳定标识（heading+summary+quote 内容哈希）
  function kpHash(s) {
    let h = 5381;
    s = String(s || "");
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return "h" + h;
  }
  function kpOfAI(k) {
    return { heading: typeof k === "string" ? k : (k && k.heading) || "", summary: (k && k.summary) || "", quote: (k && k.quote) || "" };
  }
  function kpAIId(k) {
    const p = kpOfAI(k);
    return "ai:" + kpHash(p.heading + "\u0001" + p.summary + "\u0001" + p.quote);
  }
  function userAddedKeypoints() { return getKpEdits(store.currentId).added || []; }
  function mergedKeypoints() {
    const edits = getKpEdits(store.currentId);
    const out = [];
    for (const k of (store.insights?.keypoints || [])) {
      const p = kpOfAI(k);
      const id = kpAIId(k);
      const ov = edits.aiOverrides[id.slice(3)];
      if (ov && ov.deleted) continue;
      out.push({
        id,
        heading: ov && ov.heading != null ? ov.heading : p.heading,
        summary: ov && ov.summary != null ? ov.summary : p.summary,
        quote: ov && ov.quote != null ? ov.quote : p.quote,
      });
    }
    for (const a of edits.added) {
      if (a && a.id) out.push({ id: a.id, heading: a.heading || "", summary: a.summary || "", quote: a.quote || "" });
    }
    return out;
  }
  function kpItemHtml(it) {
    const searchText = it.quote || it.heading;
    return `<div class="sr-keypoint-card">
      <button class="sr-list-item sr-keypoint-item" type="button" data-lit-action="locate-keypoint" data-text="${esc(searchText)}" data-heading="${esc(it.heading)}">
        <span class="sr-list-title">${esc(it.heading) || "<em class='sr-kp-untitled'>（未命名要点）</em>"}</span>
        ${it.summary ? `<span class="sr-list-sub">${esc(it.summary)}</span>` : ""}
        ${it.quote ? `<span class="sr-list-sub sr-keypoint-quote">"${esc(it.quote)}"</span>` : ""}
      </button>
      <div class="sr-kp-actions">
        <button class="sr-msg-copy" type="button" data-lit-action="edit-keypoint" data-id="${esc(it.id)}">编辑</button>
        <button class="sr-msg-copy" type="button" data-lit-action="del-keypoint" data-id="${esc(it.id)}">删除</button>
      </div>
    </div>`;
  }
  function kpEditorHtml(ed) {
    const isAdd = ed.mode === "add";
    return `<div class="sr-keypoint-editor">
      <div class="sr-keypoint-editor-title">${isAdd ? "新增阅读要点" : "编辑阅读要点"}</div>
      <label class="sr-ke-field">标题
        <input id="kp-ed-heading" type="text" maxlength="60" placeholder="要点标题（必填）" value="${esc(ed.heading || "")}">
      </label>
      <label class="sr-ke-field">摘要
        <textarea id="kp-ed-summary" rows="2" maxlength="300" placeholder="一句话概括…">${esc(ed.summary || "")}</textarea>
      </label>
      <label class="sr-ke-field">引用原文（可选，用于点击跳转定位）
        <textarea id="kp-ed-quote" rows="2" maxlength="200" placeholder="从论文中摘一句原文…">${esc(ed.quote || "")}</textarea>
      </label>
      <input type="hidden" id="kp-ed-id" value="${esc(ed.id || "")}">
      <input type="hidden" id="kp-ed-mode" value="${esc(ed.mode || "add")}">
      <div class="sr-ke-actions">
        <button class="secondary-button" type="button" data-lit-action="cancel-keypoint-edit">取消</button>
        <button class="primary-button" type="button" data-lit-action="save-keypoint">保存</button>
      </div>
    </div>`;
  }
  function openKpEditor(id) {
    if (!id) return;
    const edits = getKpEdits(store.currentId);
    let ed = null;
    if (id.startsWith("ai:")) {
      // 以“是否被删除/覆盖”之外的内容定位 AI 源条目
      const base = (store.insights?.keypoints || []).find((k) => kpAIId(k) === id);
      if (base) {
        const p = kpOfAI(base);
        const ov = edits.aiOverrides[id.slice(3)] || {};
        ed = {
          mode: "edit", id,
          heading: ov.heading != null ? ov.heading : p.heading,
          summary: ov.summary != null ? ov.summary : p.summary,
          quote: ov.quote != null ? ov.quote : p.quote,
        };
      }
    } else {
      const a = edits.added.find((x) => x.id === id);
      if (a) ed = { mode: "edit", id, heading: a.heading || "", summary: a.summary || "", quote: a.quote || "" };
    }
    if (ed) { store.kpEditing = ed; renderKeypoints(); }
  }
  function saveKeypointEdit() {
    const id = (el("kp-ed-id") || {}).value || "";
    const mode = (el("kp-ed-mode") || {}).value || "add";
    const heading = (el("kp-ed-heading") || {}).value.trim();
    const summary = (el("kp-ed-summary") || {}).value.trim();
    const quote = (el("kp-ed-quote") || {}).value.trim();
    if (!heading && !summary) { window.alert("请填写标题或摘要后再保存。"); return; }
    const edits = getKpEdits(store.currentId);
    if (mode === "add") {
      edits.added.push({ id: "kp-" + Date.now(), heading, summary, quote });
    } else if (id.startsWith("ai:")) {
      const ov = Object.assign({}, edits.aiOverrides[id.slice(3)], { heading, summary, quote });
      edits.aiOverrides[id.slice(3)] = ov;
    } else {
      const a = edits.added.find((x) => x.id === id);
      if (a) { a.heading = heading; a.summary = summary; a.quote = quote; }
    }
    saveKpEdits(store.currentId, edits);
    store.kpEditing = null;
    renderKeypoints();
  }
  function deleteKeypoint(id) {
    const edits = getKpEdits(store.currentId);
    if (id.startsWith("ai:")) {
      const ov = Object.assign({}, edits.aiOverrides[id.slice(3)], { deleted: true });
      edits.aiOverrides[id.slice(3)] = ov;
    } else {
      edits.added = edits.added.filter((x) => x.id !== id);
    }
    saveKpEdits(store.currentId, edits);
    store.kpEditing = null;
    renderKeypoints();
  }

  async function refreshSuggested() {
    if (!store.currentId || store.qaBusy) return;
    const btn = document.querySelector('[data-lit-action="refresh-suggested"]');
    if (btn) { btn.disabled = true; btn.textContent = "刷新中…"; }
    try {
      const res = await window.api(
        `/api/literature/${encodeURIComponent(store.currentId)}/insights?refresh=1`,
        { method: "POST" }
      );
      store.insights = { suggested_questions: res.suggested_questions || [], keypoints: res.keypoints || [] };
    } catch (error) {
      store.insights = { suggested_questions: [], keypoints: [] };
    }
    renderKeypoints();
    renderQA();
  }

  function renderHighlights() {
    const body = el("lit-highlights-body");
    if (!body) return;
    const list = getHighlights(store.currentId);
    if (!store.detail) {
      body.innerHTML = `<p class="sr-list-empty">选中文献后显示高亮。</p>`;
      return;
    }
    if (!list.length) {
      body.innerHTML = `<p class="sr-list-empty">还没有高亮。选中正文文字后点击「高亮」即可划词高亮。</p>`;
      return;
    }
    body.innerHTML = list.map((h) => `
      <div class="sr-list-item">
        <button class="sr-msg-copy" type="button" data-lit-action="locate-highlight" data-id="${esc(h.id)}">定位</button>
        <span class="sr-list-sub">${esc(h.text)}</span>
        <button class="sr-msg-copy" type="button" data-lit-action="remove-highlight" data-id="${esc(h.id)}">删除</button>
      </div>`).join("");
  }

  // —— 划词笔记 ——
  function notesKey(id) { return NOTES_KEY + id; }
  function getNotes(id) {
    if (!id) return [];
    if (id === store.currentId && store.marksReady) return clone(store.markNotes) || [];
    try { return JSON.parse(localStorage.getItem(notesKey(id)) || "[]"); } catch { return []; }
  }
  function saveNotes(id, list) {
    if (id === store.currentId && store.marksReady) store.markNotes = clone(list) || [];
    try { localStorage.setItem(notesKey(id), JSON.stringify(list)); } catch {}
    if (id === store.currentId) queueMarkSync("notes", "", list);
  }
  function addSelectionNote(text, comment, para) {
    if (!store.currentId) return;
    const list = getNotes(store.currentId);
    list.push({ id: "n-" + Date.now(), text, comment: (comment || "").trim(), para, ts: Date.now() });
    saveNotes(store.currentId, list);
    renderNotes();
  }
  function removeNote(id) {
    saveNotes(store.currentId, getNotes(store.currentId).filter((n) => n.id !== id));
    renderNotes();
  }
  function renderNotes() {
    const body = el("lit-notes-body");
    if (!body) return;
    const list = getNotes(store.currentId);
    if (!store.detail) {
      body.innerHTML = `<p class="sr-list-empty">选中文献后显示笔记。</p>`;
      return;
    }
    if (!list.length) {
      body.innerHTML = `<p class="sr-list-empty">还没有笔记。选中正文文字后点击「笔记」即可添加。</p>`;
      return;
    }
    body.innerHTML = list.map((n) => `
      <div class="sr-list-item sr-note-item">
        <span class="sr-list-sub">${esc(n.text)}</span>
        ${n.comment ? `<span class="sr-note-comment">${esc(n.comment)}</span>` : ""}
        <button class="sr-msg-copy" type="button" data-lit-action="remove-note" data-id="${esc(n.id)}">删除</button>
      </div>`).join("");
  }

  // —— AI 问答 / 译文 Markdown 渲染 ——
  function renderMarkdown(md) {
    let text = String(md || "").replace(/\r\n/g, "\n");
    // LLM 偶发把 μ 的 Unicode 转义写成 \u000b（垂直制表符），JSON 解析后变成控制字符，
    // 会在 KaTeX/正文里渲染成 ••• 乱码；统一还原为 μ，并清除其余 C0 控制字符。
    text = text.replace(/\\u000b/gi, "μ").replace(/\u000b/g, "μ")
      .replace(/[\u0000-\u0008\u000c\u000e-\u001f\u007f]/g, "");

    // 先提取显式数学环境并替换为占位符，避免 esc() / markdown 正则破坏 LaTeX 命令
    const mathBuf = [];
    const mathPlaceholder = (src, display) => {
      const i = mathBuf.push({ src: String(src || "").trim(), display }) - 1;
      return `\u0001M${i}\u0001`;
    };

    text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_m, src) => mathPlaceholder(src, true));
    text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_m, src) => mathPlaceholder(src, true));
    text = text.replace(/\\begin\{(?:equation\*?|aligned|matrix|cases|gather\*?)\}([\s\S]+?)\\end\{(?:equation\*?|aligned|matrix|cases|gather\*?)\}/g, (m) => mathPlaceholder(m, true));
    text = text.replace(/(^|[^\$\\])\$([^$\n]+?)\$/g, (_m, pre, src) => pre + mathPlaceholder(src, false));
    text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_m, src) => mathPlaceholder(src, false));

    // 占位符标记（[[FIG:]]/[[H:]]/[[MATH:]]）：LLM 译文偶尔回显，图片/标题标记直接去除，公式标记转「公式」
    text = text.replace(/\[\[MATH:[^\]]*\]\]/g, "〔公式〕").replace(/\[\[(?:FIG|H):[^\]]*\]\]/g, "");

    // 在公式块保护完成后，才安全还原普通文本中的字面转义字符（绝不无条件匹配 \t 破坏 \text, \tau 等）
    text = text.replace(/\\n(?![a-zA-Z])/g, "\n").replace(/\\t(?![a-zA-Z])/g, " ");

    const boldBuf = [];
    // 仅当"纯数学片段"才尝试渲染：含中文或成词英文文本不动，
    // 避免 KaTeX 把中文/英文整句变红。
    const looksLikeMathLine = (t) => {
      const s = String(t || "").replace(/\s+/g, "");
      if (!s || /[\u4e00-\u9fff]/.test(s)) return false;
      if (s.includes("\\")) return true; // 含 LaTeX 命令/转义 → 数学意图
      if (/[A-Za-z]{2}/.test(s)) return false; // 普通英文单词 → 文本
      // 先剔除成对 **（粗体标记），避免孤星/未闭合粗体被误判为数学表达式
      const ops = (s.replace(/\*\*/g, "").replace(/[0-9.,;:!?%°'"()]/g, "").match(/[=_+\-*/^÷×∑∏∫√∇≤≥≠≈∞±→←·|()[\]{}]/g) || []).length;
      return ops >= 2;
    };
    // 行内裸数学：把不含中文的数学连续子段捕获为行内公式（覆盖未用 $ 包裹的 raw LaTeX）
    const applyBare = (s) => String(s)
      .split(/([\u4e00-\u9fff]+)/)
      .map((part, i) => {
        if (part && i % 2 === 0 && !part.includes("\u0001") && looksLikeMathLine(part)) {
          return mathPlaceholder(part.trim(), false);
        }
        return part;
      })
      .join("");
    // 独立一整行若为纯数学 → 当作块级展示公式（竖线表格行除外，交给下方表格分支）
    const lines = text.split("\n").map((ln) => {
      if (!ln || ln.includes("\u0001")) return ln;
      if (isPipeRow(ln.trim())) return ln;
      if (looksLikeMathLine(ln)) return mathPlaceholder(ln.trim(), true);
      return ln;
    });
    // 粗体占位：把成对 **...**（含跨行）提取为令牌，避免被 esc()/block 破坏，
    // 最后渲染为真正的 <strong> 粗体，杜绝 `**` 原样露出或靠删除掩盖
    text = text.replace(/\*\*([\s\S]+?)\*\*/g, (_m, t) => {
      const i = boldBuf.push(t) - 1;
      return `\u0001B${i}\u0001`;
    });
    let html = "";
    let inList = null; // "ul" | "ol" | null
    let inCode = false;
    const inline = (s) => s
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*\*/g, "") // 清理 AI 偶发未闭合的 ** 孤星，避免 raw 显示
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const closeList = () => {
      if (inList) { html += inList === "ul" ? "</ul>" : "</ol>"; inList = null; }
    };
    const ulRe = /^[-*+]\s+(.*)$/;
    const olRe = /^(?:(\d+)[.)]\s+|(\d+)、\s*|[（(](\d+)[)）]\s*)(.*)$/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith("```")) {
        closeList();
        if (inCode) { html += "</code></pre>"; inCode = false; }
        else { html += "<pre><code>"; inCode = true; }
        continue;
      }
      if (inCode) { html += esc(line) + "\n"; continue; }

      const trimmed = line.trim();
      if (!trimmed) {
        // 列表项之间隔空行不关闭列表，避免每个条目都被拆成独立 <ol> 导致编号回到 1
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        const next = j < lines.length ? lines[j].trim() : "";
        const nextUl = ulRe.test(next);
        const nextOl = olRe.test(next);
        if (inList === "ul" && nextUl) continue;
        if (inList === "ol" && nextOl) continue;
        closeList();
        continue;
      }
      // 竖线表格：连续 | 行渲染为 <table>（PDF/LLM 常把表格行混在译文里）
      if (isPipeRow(trimmed)) {
        closeList();
        let j = i;
        const rows = [];
        while (j < lines.length && isPipeRow(lines[j].trim())) { rows.push(lines[j]); j++; }
        const tbl = pipeTableHtml(rows);
        html += tbl || `<p>${inline(esc(rows.join(" ")))}</p>`;
        i = j - 1;
        continue;
      }
      const h = trimmed.match(/^(#{1,4})\s+(.*)$/);
      if (h) { closeList(); html += `<h4>${inline(esc(applyBare(h[2])))}</h4>`; continue; }
      const ul = trimmed.match(ulRe);
      if (ul) {
        if (inList !== "ul") { closeList(); html += "<ul>"; inList = "ul"; }
        html += `<li>${inline(esc(applyBare(ul[1])))}</li>`;
        continue;
      }
      const ol = trimmed.match(olRe);
      if (ol) {
        if (inList !== "ol") { closeList(); html += "<ol>"; inList = "ol"; }
        const n = ol[1] || ol[2] || ol[3];
        html += `<li value="${n}">${inline(esc(applyBare(ol[4])))}</li>`;
        continue;
      }
      closeList();
      html += `<p>${inline(esc(applyBare(trimmed)))}</p>`;
    }
    closeList();
    if (inCode) html += "</code></pre>";
    // 将粗体占位符渲染为真正的 <strong> 粗体（内容先转义，内部公式占位符随后还原）
    html = html.replace(/\u0001B(\d+)\u0001/g, (_m, i) => `<strong>${esc(boldBuf[Number(i)] || "")}</strong>`);
    // 将公式占位符还原为 KaTeX/MathJax 渲染结果
    html = html.replace(/\u0001M(\d+)\u0001/g, (_m, i) => {
      const m = mathBuf[Number(i)];
      if (!m) return "";
      try {
        return typeof window.renderKatex === "function"
          ? window.renderKatex(m.src, m.display)
          : `<code>${esc(m.src)}</code>`;
      } catch (err) {
        return `<code>${esc(m.src)}</code>`;
      }
    });
    // 兜底：清除从任何路径（代码块、表格、嵌套、跨行等）残留的字面 **
    html = html.replace(/\*\*/g, "");
    return html;
  }

  function renderQA() {
    const box = el("lit-qa-messages");
    renderQASelection();
    if (!box) return;
    if (!store.detail) {
      box.innerHTML = `<div class="sr-qa-empty"><p>选中一篇文献后即可针对正文提问。</p></div>`;
      return;
    }
    let html = "";
    if (!store.qaHistory.length) {
      html += `<div class="sr-qa-empty">
        <p>针对当前论文提问，快速理解其方法、结论与局限。</p>
      </div>`;
    } else {
      html += `<div class="sr-qa-clear"><button class="sr-msg-copy" type="button" data-lit-action="clear-qa">清空对话</button></div>`;
    }
    const suggested = store.insights?.suggested_questions || [];
    if (suggested.length) {
      html += `<div class="sr-suggested">
        <div class="sr-suggested-head">
          <span class="sr-suggested-title">推荐问题</span>
          <button class="sr-refresh-btn" type="button" data-lit-action="refresh-suggested">换一批</button>
        </div>
        ${suggested.map((q) => `<button type="button" data-lit-action="ask-suggested" data-text="${esc(q)}">${esc(q)}</button>`).join("")}
      </div>`;
    }
    html += store.qaHistory.map((m) => {
      if (!m.id) m.id = m.uid || ("q-" + store.currentId + "-" + m.role + "-" + (m.ts || Date.now()));
      const cls = m.role === "user" ? "sr-msg-user" : "sr-msg-ai";
      const content = m.role === "ai" ? renderMarkdown(m.text) : esc(m.text);
      const bubbleAttr = m.role === "ai" ? ` data-aihl-kind="qa" data-aihl-key="${esc(m.id)}"` : "";
      return `<div class="sr-msg ${cls}">
        <div class="sr-msg-bubble"${bubbleAttr}>${content}</div>
        ${m.role === "ai" ? `<div class="sr-msg-meta"><button class="sr-msg-copy" type="button" data-lit-action="copy" data-text="${esc(m.text)}">复制</button></div>` : ""}
      </div>`;
    }).join("");
    if (store.qaBusy) html += `<div class="sr-msg sr-msg-ai"><div class="sr-msg-bubble">正在思考…</div></div>`;
    box.innerHTML = html;
    // 重新应用问答 AI 回复中已保存的高亮
    for (const b of box.querySelectorAll('[data-aihl-kind="qa"]')) {
      if (b.dataset.aiHlKey) applyAiHlToRoot(b, "qa", b.dataset.aiHlKey);
    }
    box.scrollTop = box.scrollHeight;
  }

  async function askQuestion(question, attachSel) {
    const q = ((question || "").trim());
    if (!q || store.qaBusy) return;
    if (!store.currentId) { showReaderError("请先选择一篇文献。"); return; }
    // 附带原页选中上下文时，把所有选中的段落/公式/图表作为背景注入提问
    let finalQ = q;
    if (attachSel && store.qaSelections && store.qaSelections.length) {
      const parts = store.qaSelections.map((s) => {
        const head = s.kind === "formula"
          ? "用户从论文中选中的公式（文本可能因 OCR 提取而不完整，请据此结合论文上下文回答）："
          : s.kind === "fig"
            ? "用户从论文中选中的图表说明："
            : "用户从论文原文选中的片段（请以此片段为核心回答）：";
        return head + "\n" + (s.text || "");
      });
      finalQ = q + "\n\n" + parts.join("\n\n---\n\n");
    }
    // 一问一答共用同一个 slot，导出时才能配成「问 + 答」一条
    const exchangeId = qidSeq();
    store.qaHistory.push({ role: "user", text: q, ts: Date.now(), uid: qidSeq() });
    store.qaBusy = true;
    renderQA();
    const input = el("lit-qa-input");
    if (input) input.value = "";
    try {
      const res = await window.api(`/api/literature/${encodeURIComponent(store.currentId)}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: finalQ }),
      });
      const answerText = res.answer || "（无回答）";
      store.qaHistory.push({ role: "ai", text: answerText, ts: Date.now(), uid: qidSeq() });
      // 只有拿到真实回答才落库；出错信息不入库，免得导出里全是报错
      saveAiAnswer(exchangeId, aiAnswerPayload(q, answerText, "qa", null));
    } catch (error) {
      store.qaHistory.push({ role: "ai", text: `出错了：${error.message}`, ts: Date.now(), uid: qidSeq() });
    }
    store.qaBusy = false;
    renderQA();
  }

  function clearQASelection(id) {
    if (id) store.qaSelections = (store.qaSelections || []).filter((s) => s.id !== id);
    else store.qaSelections = [];
    store.qaSelection = null;
    renderQA();
  }

  // 在左侧问答输入框上方渲染「已选中」chip 条（可多选，逐条可移除）
  function renderQASelection() {
    const host = el("lit-qa-selbar");
    if (!host) return;
    const list = (store.detail && store.qaSelections) ? store.qaSelections : [];
    if (!list.length) { host.hidden = true; host.innerHTML = ""; return; }
    host.hidden = false;
    host.innerHTML = list.map((s) => {
      const label = s.label || s.text || "";
      const kind = s.kind === "formula" ? "公式" : s.kind === "fig" ? "图表" : "选中";
      return `<span class="sr-qa-selchip" data-sel-id="${esc(String(s.id))}">
        <span class="sr-qa-selchip-badge">${kind}</span>
        <span class="sr-qa-selchip-text" title="${esc(s.text || "")}">${esc(label)}</span>
        <button type="button" class="sr-qa-selchip-clear" data-lit-action="clear-selection" data-id="${esc(String(s.id))}" aria-label="取消选中" title="取消选中">×</button>
      </span>`;
    }).join("");
  }

  // 点击 chip 体：在阅读区查看选中的内容（跳到对应位置并高亮），图表/公式/文本各自定位
  function viewSelection(s) {
    if (!s || !store.currentId) return;
    // 优先按「选中」时记录的原页坐标精准定位到所选区域（无需文本匹配，跨行/公式/图表都精确）
    if (Number.isFinite(Number(s.page)) && Array.isArray(s.bbox) && s.bbox.length === 4 && (s.bbox[2] > s.bbox[0]) && (s.bbox[3] > s.bbox[1])) {
      if (store.readMode !== "original") { store.readMode = "original"; renderReader(); }
      goToOrigPage(Number(s.page), s.bbox, null);
      return;
    }
    if (s.kind === "fig") {
      const figId = selectionFigureId(s);
      if (figId) {
        let handled = false;
        if (store.readMode === "original") handled = locateFigureOrig(figId);
        if (!handled) {
          if (store.readMode === "original") { store.readMode = "text"; renderReader(); }
          handled = locateFigure(figId);
        }
        if (!handled) locateParagraph(String(s.label || s.text || ""));
      } else {
        locateParagraph(String(s.label || s.text || ""));
      }
      return;
    }
    const needle = s.kind === "formula" ? String(s.label || s.text || "") : String(s.text || s.label || "");
    let handled = false;
    if (store.readMode === "original") handled = locateTextOrig(needle);
    if (!handled) {
      if (store.readMode === "original") { store.readMode = "text"; renderReader(); }
      handled = locateParagraph(needle) || locateParagraph(String(s.label || ""));
    }
  }

  // 根据选中图表的图注文本反查对应的图组 id，供阅读区定位使用
  function selectionFigureId(s) {
    const needle = String(s.label || s.text || "").replace(/\s+/g, " ").trim();
    if (!needle) return "";
    const groups = buildFigureGroups();
    for (const g of groups) {
      const cap = String(groupCaption(g) || "").replace(/\s+/g, " ").trim();
      if (cap && (cap === needle || needle.startsWith(cap) || cap.startsWith(needle))) return g.id;
      for (const m of (g.members || [])) {
        const mc = String(m.caption || "").replace(/\s+/g, " ").trim();
        if (mc && (mc === needle || needle.startsWith(mc) || mc.startsWith(needle))) return g.id;
      }
    }
    return "";
  }

  // 把原页选中内容挂到左侧问答栏，作为后续提问的上下文（支持多次「选中」累积为多个）
  // loc: { page, bbox } 原页坐标，用于点击 chip 时精准定位到原页中的选中区域
  function attachQA(kind, label, text, loc) {
    if (!store.currentId) { showReaderError("请先选择一篇文献。"); return; }
    if (!store.qaSelections) store.qaSelections = [];
    // 相同文本去重，避免重复选中同一段
    if (!store.qaSelections.some((s) => s.text === (text || "") && s.kind === kind)) {
      const hasLoc = loc && Number.isFinite(Number(loc.page)) && Array.isArray(loc.bbox) && loc.bbox.length === 4;
      store.qaSelections.push({
        id: "qsel-" + Date.now() + "-" + store.qaSelections.length,
        kind,
        label: (label || text || ""),
        text: (text || label || ""),
        ...(hasLoc ? { page: Number(loc.page), bbox: loc.bbox } : {}),
      });
    }
    store.qaSelection = store.qaSelections[store.qaSelections.length - 1];
    switchTab("qa");
    renderQA();
  }

  function clearQA() {
    // 同时清掉落库的那些问答 —— 否则刷新之后对话会「复活」，导出里也还留着。
    if (store.currentId && store.markQaAnswers) {
      for (const [slot, payload] of Array.from(store.markQaAnswers.entries())) {
        if ((payload || {}).source_kind !== "qa") continue;
        store.markQaAnswers.delete(slot);
        pushMark(store.currentId, "ai_answer", slot, null);   // 空 payload = 删除该格
      }
    }
    store.qaHistory = [];
    renderQA();
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); } catch { /* 忽略剪贴板失败 */ }
  }

  // —— 划词/悬停浮层按钮的内联图标（stroke=currentColor，随主题变色）——
  const TIP_ICONS = {
    pencil: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
    undo: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`,
    plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
    globe: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
    spark: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9Z"/><path d="M18.5 15l.9 2.2 2.1.9-2.1.9-.9 2.2-.9-2.2-2.1-.9 2.1-.9Z"/></svg>`,
    file: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
    pin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`,
    trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
  };
  const tipIcon = (name, cls) =>
    `<span class="tip-ic${cls ? " " + cls : ""}">${TIP_ICONS[name] || ""}</span>`;

  // —— 浮层拖动（划词气泡 / 高亮标记气泡通用）——
  // 触发区：顶部把手 .sr-tip-grip，或按钮行的空白处（按钮本身不拦，保证点击可用）。
  // 移动超过 3px 才算拖动，避免误吞点击；拖过的浮层加 .sr-tip-moved，后续不再自动跳回选区旁。
  function makeTipDraggable(tip) {
    if (!tip || tip.__tipDrag) return tip;
    tip.__tipDrag = 1;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    tip.__clampToView = () => {
      const w = tip.offsetWidth || 0, h = tip.offsetHeight || 0;
      tip.style.left = clamp(parseFloat(tip.style.left) || 0, 8, Math.max(8, window.innerWidth - w - 8)) + "px";
      tip.style.top = clamp(parseFloat(tip.style.top) || 0, 8, Math.max(8, window.innerHeight - h - 8)) + "px";
    };
    tip.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const inGrip = !!(e.target.closest && e.target.closest(".sr-tip-grip"));
      const row = e.target.closest && e.target.closest(".sr-tip-actions");
      const onControl = e.target.closest && e.target.closest("button, a, input, textarea, select, .sr-tip-result, .sr-mark-tip-quote");
      if (!inGrip && !(row && !onControl)) return;
      e.preventDefault();
      const startX = e.clientX, startY = e.clientY;
      const left0 = parseInt(tip.style.left || "0", 10) || 0;
      const top0 = parseInt(tip.style.top || "0", 10) || 0;
      let moved = false;
      const onMove = (ev) => {
        if (!moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 3) return;
        if (!moved) { moved = true; tip.classList.add("dragging"); }
        const w = tip.offsetWidth || 0, h = tip.offsetHeight || 0;
        tip.style.left = clamp(left0 + ev.clientX - startX, 8, Math.max(8, window.innerWidth - w - 8)) + "px";
        tip.style.top = clamp(top0 + ev.clientY - startY, 8, Math.max(8, window.innerHeight - h - 8)) + "px";
      };
      const onUp = () => {
        if (moved) tip.classList.add("sr-tip-moved");
        tip.classList.remove("dragging");
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
    // 双击把手：解除"记住位置"，下次划词重新跟随选区
    tip.addEventListener("dblclick", (e) => {
      if (e.target.closest && e.target.closest(".sr-tip-grip")) tip.classList.remove("sr-tip-moved");
    });
    return tip;
  }

  // —— 划词操作：高亮 / 翻译 / AI 解释 / 笔记 ——
  let selectionTip = null;
  function ensureSelectionTip() {
    if (selectionTip) return selectionTip;
    selectionTip = document.createElement("div");
    selectionTip.className = "sr-selection-tip hidden";
    selectionTip.setAttribute("role", "status");
    document.body.appendChild(selectionTip);
    // 悬浮结果框可拖动：按住顶部把手，或按钮行空白处（按钮本身仍可点）
    makeTipDraggable(selectionTip);
    return selectionTip;
  }
  function hideSelectionTip() {
    if (selectionTip) selectionTip.classList.add("hidden");
  }
  function looksEnglish(text) {
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    return latin > 0 && latin >= cjk;
  }
  function rerenderReader() {
    const body = el("lit-reader-body");
    const top = body ? body.scrollTop : 0;
    renderReader();
    if (body) body.scrollTop = top;
  }
  function addHighlightSelection(text, para) {
    // 原页模式：解析选区字符区间，就地精确高亮，不切回文理视图
    if (store.readMode === "original") {
      const segs = origResolveSelection();
      if (!segs.length) return;
      origHlCommit();
      store.originalHl.push({ id: "ohl-" + Date.now() + "-" + (store.originalHl.length), page: store.originalPage, text, segs });
      origHlRefreshUI();
      persistOriginalHighlights();
      renderHighlights();
      return;
    }
    const list = getHighlights(store.currentId);
    list.push({ id: "hl-" + Date.now(), text, para });
    saveHighlights(store.currentId, list);
    rerenderReader();
    renderHighlights();
  }

  // 把浏览器选区解析为文本层各行内精确字符区间 [[line, s, e], ...]
  // 直接基于 selection 的 anchor/focus 文本节点定位行，不做几何兜底遍历。
  function origResolveSelection() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return [];
    const range = sel.getRangeAt(0);
    const tlEl = document.querySelector("[data-orig-tl]");
    if (!tlEl || !tlEl.contains(range.commonAncestorContainer)) return [];
    // anchor/focus 若为文本节点，取其父行 span；若为元素，取其最近行 span
    const lineOf = (node) => {
      if (node && node.nodeType === 3) return node.parentElement?.closest("[data-line]");
      if (node && node.nodeType === 1) return node.closest("[data-line]");
      return null;
    };
    const aSpan = lineOf(sel.anchorNode);
    const fSpan = lineOf(sel.focusNode);
    if (!aSpan && !fSpan) return [];
    const out = [];
    const seen = {};
    const push = (span, lo, hi) => {
      if (!span) return;
      const line = Number(span.dataset.line);
      const textNode = Array.from(span.childNodes).find((n) => n.nodeType === 3);
      const len = textNode ? textNode.data.length : 0;
      lo = Math.max(0, Math.min(len, lo));
      hi = Math.max(0, Math.min(len, hi));
      if (hi <= lo) return;
      const key = line + "|" + lo + "|" + hi;
      if (!seen[key]) { seen[key] = 1; out.push([line, lo, hi]); }
    };
    // 反向选择（focus 在 anchor 之前）判断
    const backward = aSpan && fSpan && aSpan !== fSpan
      ? segmentBefore(sel.focusNode, sel.anchorNode, tlEl)
      : false;
    const startOff = sel.anchorOffset != null ? sel.anchorOffset : 0;
    const endOff = sel.focusOffset != null ? sel.focusOffset : 0;
    if (aSpan === fSpan) {
      // 单行选中：精确区间
      const lo = Math.min(startOff, endOff);
      const hi = Math.max(startOff, endOff);
      push(aSpan, lo, hi);
      return out;
    }
    // 跨行：起点行 [startOff, len]，终点行 [0, endOff]，中间行整行
    if (aSpan && fSpan) {
      if (!backward) {
        push(aSpan, startOff, 1e9);
        push(fSpan, 0, endOff);
        fillMiddleLines(aSpan, fSpan, tlEl, push);
      } else {
        push(aSpan, 0, startOff);
        push(fSpan, endOff, 1e9);
        fillMiddleLines(fSpan, aSpan, tlEl, push);
      }
    } else if (aSpan) {
      push(aSpan, Math.min(startOff, endOff), 1e9);
    } else if (fSpan) {
      push(fSpan, 0, Math.max(startOff, endOff) || 1e9);
    }
    return out.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  }
  // 判断 a 是否在 b 之前（DOM 顺序）
  function segmentBefore(a, b, root) {
    return treePos(a) <= treePos(b);
  }
  function treePos(node) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let i = 0;
    while (walker.nextNode()) {
      if (walker.currentNode === node) return i;
      i++;
    }
    return i;
  }
  // 填充两行之间所有中间行（整行）
  function fillMiddleLines(a, b, tlEl, push) {
    const all = Array.from(tlEl.querySelectorAll("[data-line]"));
    const ia = all.indexOf(a);
    const ib = all.indexOf(b);
    const [lo, hi] = ia < ib ? [ia, ib] : [ib, ia];
    for (let i = lo + 1; i < hi; i++) push(all[i], 0, 1e9);
  }

  function hlSegsEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1] || a[i][2] !== b[i][2]) return false;
    }
    return true;
  }
  function hlSegsSpan(h) {
    let n = 0;
    for (const s of (h && h.segs) || []) n += Math.max(0, s[2] - s[1]);
    return n;
  }
  // 判断高亮 h 的字符区间是否完全覆盖选区的每个片段
  function hlCoversSegs(h, segs) {
    const cover = new Map();
    for (const [ln, s, e] of (h && h.segs) || []) if (e > s) cover.set(ln, [s, e]);
    for (const [ln, s, e] of segs) {
      const c = cover.get(ln);
      if (!c || s < c[0] || e > c[1]) return false;
    }
    return true;
  }
  // 原页模式：找出当前选中文字命中的高亮（优先精确匹配，其次取覆盖该选区的最小高亮）
  function pickOriginalHighlight(segs) {
    const list = store.originalHl || [];
    if (!segs || !segs.length) return null;
    const page = store.originalPage;
    const exact = list.find((h) => h.page === page && hlSegsEqual(h.segs, segs));
    if (exact) return exact;
    return (list
      .filter((h) => h.page === page && hlCoversSegs(h, segs))
      .sort((a, b) => hlSegsSpan(a) - hlSegsSpan(b))[0]) || null;
  }

  function renderSelectionTip(rect, text, paraIndex) {
    const tip = ensureSelectionTip();
    // 原页模式：识别当前选中是否命中已有高亮，供「撤销该高亮」使用
    const origMode = store.readMode === "original";
    const selSegs = origMode ? origResolveSelection() : [];
    const targetHl = origMode ? pickOriginalHighlight(selSegs) : null;
    const showTranslate = origMode || looksEnglish(text);
    const canUndoHl = !!(targetHl || origHlHistory.length);
    // 原页文本选中：由命中的文本行 bbox 汇总成定位区域，供「选中」chip 精准跳转
    let origLoc = null;
    if (origMode && selSegs.length) {
      const plines = (originalMetaForPage(store.originalPage) || {}).text_layer || [];
      let bb = null;
      for (const seg of selSegs) {
        const L = plines[seg[0]];
        if (L && L.bbox && L.bbox.length === 4) {
          if (!bb) bb = L.bbox.slice();
          else {
            bb[0] = Math.min(bb[0], L.bbox[0]); bb[1] = Math.min(bb[1], L.bbox[1]);
            bb[2] = Math.max(bb[2], L.bbox[2]); bb[3] = Math.max(bb[3], L.bbox[3]);
          }
        }
      }
      if (bb && bb.length === 4 && (bb[2] > bb[0]) && (bb[3] > bb[1])) {
        origLoc = { page: store.originalPage, bbox: bb };
      }
    }
    tip.innerHTML = `
      <div class="sr-tip-grip" title="拖动移动（双击复位：下次划词重新跟随选区）"></div>
      <div class="sr-tip-actions">
        <button type="button" class="primary" data-tip-action="highlight">${tipIcon("pencil")}高亮</button>
        ${origMode
          ? `<button type="button" data-tip-action="undo-hl" ${canUndoHl ? "" : "disabled"}>${tipIcon("undo")}${targetHl ? "撤销该高亮" : "撤销高亮"}</button>`
          : ""}
        <button type="button" data-tip-action="attend">${tipIcon("plus")}选中</button>
        ${showTranslate ? `<button type="button" data-tip-action="translate">${tipIcon("globe")}翻译</button>` : ""}
        <button type="button" data-tip-action="explain">${tipIcon("spark")}AI 解释</button>
        <button type="button" data-tip-action="note">${tipIcon("file")}笔记</button>
      </div>
      <div class="sr-tip-result" hidden></div>
      <button class="sr-tip-close" type="button" aria-label="关闭">×</button>`;
    tip.classList.remove("hidden");
    // 用户拖过之后保持其放下时的位置（仅做视口钳制）；否则按选区定位，按实际宽度居中避免右溢出
    if (tip.classList.contains("sr-tip-moved") && tip.__clampToView) {
      tip.__clampToView();
    } else {
      const tipW = tip.offsetWidth || 420;
      tip.style.left = Math.max(8, Math.min(rect.left + rect.width / 2 - tipW / 2, window.innerWidth - tipW - 8)) + "px";
      tip.style.top = (rect.top - 54 > 8 ? rect.top - 54 : rect.bottom + 10) + "px";
    }

    const result = tip.querySelector(".sr-tip-result");
    const setBusy = (msg) => {
      result.hidden = false;
      result.className = "sr-tip-result";
      result.innerHTML = `<span class="sr-tip-busy">${msg}</span>`;
    };

    tip.querySelector('[data-tip-action="highlight"]').addEventListener("click", () => {
      addHighlightSelection(text, paraIndex);
      tip.classList.add("hidden");
    });

    // 原页气泡条里的「撤销高亮」：选中了已有高亮时撤销该高亮；否则回退为撤销最近一次高亮操作
    const undoHlBtn = tip.querySelector('[data-tip-action="undo-hl"]');
    if (undoHlBtn) undoHlBtn.addEventListener("click", () => {
      if (origMode && targetHl) {
        origHlCommit();
        store.originalHl = store.originalHl.filter((h) => h.id !== targetHl.id);
        origHlRefreshUI();
        persistOriginalHighlights();
        renderHighlights();
      } else {
        origHlUndo();
      }
      tip.classList.add("hidden");
    });

    // 原页气泡条里的「选中」：把选中片段挂到左侧问答栏，作为后续提问的上下文
    const attendBtn = tip.querySelector('[data-tip-action="attend"]');
    if (attendBtn) attendBtn.addEventListener("click", () => {
      attachQA("text", text, text, origLoc);
      tip.classList.add("hidden");
    });

    if (showTranslate) {
      tip.querySelector('[data-tip-action="translate"]').addEventListener("click", async () => {
        setBusy("翻译中…");
        try {
          const res = await window.api(`/api/literature/${encodeURIComponent(store.currentId)}/translate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source_text: text }),
          });
          store.translationMap.set(text, res.translated_text || "");
          result.className = "sr-tip-result ok";
          result.innerHTML = `<div class="sr-tip-result-label">译文</div><div>${esc(res.translated_text || "")}</div>`;
        } catch (error) {
          result.className = "sr-tip-result error";
          result.innerHTML = esc(error.message);
        }
      });
    }

    tip.querySelector('[data-tip-action="explain"]').addEventListener("click", async () => {
      setBusy("解析中…");
      try {
        const question = `请用简洁的中文解释论文中的这段话。注意：以下是用户从论文里【精确选中的原文片段】，请以这段文字本身为核心展开解释（说出它的含义、在文中的作用与涉及的关键概念），绝对不要把解释对象换成其它章节、其它论文或其它领域的内容，也不得声称该片段属于别的文献；若它对应论文中的图表或公式，请结合该片段文字与相关领域知识解释，必要的补充须标注「领域知识补充」，严禁编造论文中不存在的图、编号或数据，严禁回答「论文未提及/该图不存在」之类的拒答。\n\n【选中片段】\n${text}`;
        const res = await window.api(`/api/literature/${encodeURIComponent(store.currentId)}/ask`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question }),
        });
        result.className = "sr-tip-result ok";
        result.innerHTML = `<div class="sr-tip-result-label">解释</div><div>${renderMarkdown(res.answer || "（无解释）")}</div>`;
        // 落库：同一段选中文本反复解释只占一条
        saveAiAnswer(
          aiStableKey("tipexp|" + String(text || "").slice(0, 200)),
          aiAnswerPayload(text, res.answer, "text", null)
        );
        result.dataset.aiHlKind = "ai";
        result.dataset.aiHlKey = aiStableKey("tipexp|" + (res.answer || ""));
        applyAiHlToRoot(result, "ai", result.dataset.aiHlKey);
      } catch (error) {
        result.className = "sr-tip-result error";
        result.innerHTML = esc(error.message);
      }
    });

    tip.querySelector('[data-tip-action="note"]').addEventListener("click", () => {
      tip.innerHTML = `<div class="sr-tip-note-form">
        <div class="sr-tip-note-quote">${esc(text)}</div>
        <textarea rows="3" placeholder="写下你的笔记…" maxlength="2000"></textarea>
        <div class="sr-tip-note-actions">
          <button type="button" data-note-cancel>取消</button>
          <button type="button" data-note-save class="sr-note-save">保存笔记</button>
        </div>
      </div>`;
      const ta = tip.querySelector("textarea");
      ta.focus();
      tip.querySelector("[data-note-cancel]").addEventListener("click", () => tip.classList.add("hidden"));
      tip.querySelector("[data-note-save]").addEventListener("click", () => {
        addSelectionNote(text, ta.value.trim(), paraIndex);
        tip.classList.add("hidden");
      });
    });

    tip.querySelector(".sr-tip-close").addEventListener("click", () => tip.classList.add("hidden"));
  }

  // —— AI 解释 / 问答 内容里的划词高亮 ——
  // 原理：高亮记录存（文档, kind, key, 渲染后 textContent 内的 [s,e) 字符区间）。
  // 由于 renderMarkdown 对相同 markdown 的输出确定，重新渲染后 textContent 不变，
  // 因此可按字符区间在渲染结果里重新包裹 <mark>，实现持久化。
  function aiHlKey(id) { return AIHL_KEY + id; }
  function getAiHl(id) {
    if (!id) return [];
    if (store.marksReady) return clone(store.markAiHl.get(id)) || [];
    try { return JSON.parse(localStorage.getItem(aiHlKey(id)) || "[]"); } catch { return []; }
  }
  function saveAiHl(id, list) {
    if (!id) return;
    if (store.marksReady) store.markAiHl.set(id, clone(list) || []);
    try { localStorage.setItem(aiHlKey(id), JSON.stringify(list)); } catch {}
    queueMarkSync("ai_highlight", id, list);
  }

  // 计算某 DOM 点（node+offset）在 root 的 textContent 中的绝对字符偏移（仅统计文本节点）
  function textOffsetIn(root, node, off) {
    off = (off == null ? 0 : off);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let acc = 0;
    while (walker.nextNode()) {
      const tn = walker.currentNode;
      if (tn === node) return acc + Math.min(tn.data.length, Math.max(0, off));
      acc += tn.data.length;
    }
    return -1;
  }

  // 在单个文本节点上，按节点内（升序、互不重叠）区间 si[i]=[lo,hi] 依次包 <mark>
  function markNodeRanges(tn, locals, color) {
    if (!locals.length) return;
    let cur = tn;
    let shift = 0; // cur 起始字符在原始节点内的绝对偏移
    for (const pr of locals) {
      const lo = Math.max(0, pr[0] - shift);
      const hi = Math.max(lo, pr[1] - shift);
      if (lo > 0) {
        const rest = cur.splitText(lo);
        shift += cur.data.length;
        cur = rest;
      }
      const wlen = hi - lo;
      let endNode = cur;
      if (wlen < cur.data.length) endNode = cur.splitText(wlen);
      const mark = document.createElement("mark");
      mark.className = "sr-aihl";
      mark.style.background = color;
      cur.parentNode.insertBefore(mark, cur);
      mark.appendChild(cur);
      shift += wlen;
      cur = endNode;
    }
  }

  // 把存储里的 (kind,key) 高亮重新应用到已渲染的容器 root
  function applyAiHlToRoot(root, kind, key) {
    if (!root || !store.currentId) return;
    const all = getAiHl(store.currentId);
    const marks = all
      .filter((r) => r.kind === kind && r.key === key)
      .map((r) => ({ s: Math.min(r.s, r.e), e: Math.max(r.s, r.e) }))
      .filter((r) => Number.isFinite(r.s) && Number.isFinite(r.e) && r.e > r.s)
      .sort((a, b) => a.s - b.s);
    // 先撤掉本组件之前包上的 <mark>，避免重复渲染时嵌套
    root.querySelectorAll("mark.sr-aihl").forEach((m) => {
      const p = m.parentNode;
      if (!p) return;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
    });
    if (!marks.length) return;
    const merged = [];
    for (const mk of marks) {
      if (merged.length && mk.s <= merged[merged.length - 1].e) {
        if (mk.e > merged[merged.length - 1].e) merged[merged.length - 1].e = mk.e;
      } else {
        merged.push({ s: mk.s, e: mk.e });
      }
    }
    if (!merged.length) return;
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let acc = 0;
    while (walker.nextNode()) {
      const tn = walker.currentNode;
      const len = tn.data.length;
      nodes.push({ n: tn, start: acc, len });
      acc += len;
    }
    for (const nd of nodes) {
      const ns = nd.start;
      const ne = nd.start + nd.len;
      const locals = [];
      for (const seg of merged) {
        if (ne <= seg.s || ns >= seg.e) continue;
        locals.push([Math.max(seg.s - ns, 0), Math.min(seg.e - ns, nd.len)]);
      }
      if (locals.length) markNodeRanges(nd.n, locals, AIHL_COLOR);
    }
  }

  // 用当前浏览器选区在 root 里产生一条高亮并持久化
  function captureAiHl(ctx) {
    if (!store.currentId || !ctx || !ctx.key || !ctx.root) return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!ctx.root.contains(range.commonAncestorContainer)) return;
    const s = textOffsetIn(ctx.root, range.startContainer, range.startOffset);
    const e = textOffsetIn(ctx.root, range.endContainer, range.endOffset);
    if (s < 0 || e < 0) return;
    const lo = Math.min(s, e);
    const hi = Math.max(s, e);
    if (hi - lo < 1) return;
    const list = getAiHl(store.currentId);
    list.push({ id: "aihl-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6), kind: ctx.kind, key: ctx.key, s: lo, e: hi, text: range.toString(), ts: Date.now() });
    saveAiHl(store.currentId, list);
    applyAiHlToRoot(ctx.root, ctx.kind, ctx.key);
  }

  // 判断选区落在哪个可高亮容器（AI 解释面板 或 问答气泡），返回 {kind, key, root}
  function findInlineTarget(node) {
    const el0 = node && node.nodeType === 1 ? node : node ? node.parentElement : null;
    if (!el0) return null;
    const body = el0.closest ? el0.closest(".orig-hover-pop-body, .sr-tip-result") : null;
    if (body) {
      if (!body.dataset.aiHlKind) body.dataset.aiHlKind = "ai";
      return { kind: body.dataset.aiHlKind === "qa" ? "qa" : "ai", key: body.dataset.aiHlKey || "", root: body };
    }
    const bubble = el0.closest ? el0.closest(".sr-msg-bubble") : null;
    if (bubble) {
      return { kind: "qa", key: bubble.dataset.aiHlKey || "", root: bubble };
    }
    return null;
  }

  // AI 解释/问答 内容上的划词气泡（含「高亮」「笔记」）
  function renderInlineAiTip(rect, text, ctx) {
    const tip = ensureSelectionTip();
    tip.innerHTML = `
      <div class="sr-tip-actions">
        <button type="button" data-tip-action="highlight">高亮</button>
        <button type="button" data-tip-action="note">笔记</button>
      </div>
      <div class="sr-tip-result" hidden></div>
      <button class="sr-tip-close" type="button" aria-label="关闭">×</button>`;
    tip.classList.remove("hidden");
    tip.style.left = Math.max(8, Math.min(rect.left + rect.width / 2 - 70, window.innerWidth - 240)) + "px";
    tip.style.top = (rect.top - 54 > 8 ? rect.top - 54 : rect.bottom + 10) + "px";

    tip.querySelector('[data-tip-action="highlight"]').addEventListener("click", () => {
      captureAiHl(ctx);
      tip.classList.add("hidden");
    });
    tip.querySelector('[data-tip-action="note"]').addEventListener("click", () => {
      tip.innerHTML = `<div class="sr-tip-note-form">
        <div class="sr-tip-note-quote">${esc(text)}</div>
        <textarea rows="3" placeholder="写下你的笔记…" maxlength="2000"></textarea>
        <div class="sr-tip-note-actions">
          <button type="button" data-note-cancel>取消</button>
          <button type="button" data-note-save class="sr-note-save">保存笔记</button>
        </div>
      </div>`;
      const ta = tip.querySelector("textarea");
      if (ta) ta.focus();
      tip.querySelector("[data-note-cancel]").addEventListener("click", () => tip.classList.add("hidden"));
      tip.querySelector("[data-note-save]").addEventListener("click", () => {
        addSelectionNote(text, ta.value.trim(), undefined);
        tip.classList.add("hidden");
      });
    });
    tip.querySelector(".sr-tip-close").addEventListener("click", () => tip.classList.add("hidden"));
  }

  // 由目标 + 回答内容生成稳定 key，回答内容不变时高亮可跨次打开复用
  function aiStableKey(seed) {
    let h = 0;
    const s = String(seed || "");
    for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
    return "ai-" + h.toString(36) + "-" + s.length;
  }

  let markTip = null;
  function ensureMarkTip() {
    if (markTip) return markTip;
    markTip = document.createElement("div");
    markTip.className = "sr-mark-tip hidden";
    markTip.setAttribute("role", "status");
    document.body.appendChild(markTip);
    makeTipDraggable(markTip);
    return markTip;
  }
  function hideMarkTip() {
    if (markTip) markTip.classList.add("hidden");
  }
  function showMarkTip(mark) {
    const hlId = mark.getAttribute("data-hl-id");
    const list = getHighlights(store.currentId);
    const hl = list.find((h) => h.id === hlId);
    if (!hl) return;
    const tip = ensureMarkTip();
    tip.innerHTML = `
      <div class="sr-tip-grip" title="拖动移动（双击复位：下次点击重新跟随高亮位置）"></div>
      <div class="sr-mark-tip-quote">${esc(hl.text)}</div>
      <div class="sr-tip-actions">
        <button type="button" data-mark-action="locate">${tipIcon("pin")}定位</button>
        <button type="button" class="danger" data-mark-action="remove">${tipIcon("trash")}取消高亮</button>
      </div>
      <button class="sr-tip-close" type="button" aria-label="关闭">×</button>`;
    const rect = mark.getBoundingClientRect();
    tip.classList.remove("hidden");
    if (tip.classList.contains("sr-tip-moved") && tip.__clampToView) {
      tip.__clampToView();
    } else {
      const mw = tip.offsetWidth || 320;
      tip.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - mw - 8)) + "px";
      tip.style.top = (rect.top - 76 > 8 ? rect.top - 76 : rect.bottom + 10) + "px";
    }
    tip.querySelector('[data-mark-action="locate"]').addEventListener("click", () => {
      hideMarkTip();
      locateParagraph(hl.text, hl.text);
    });
    tip.querySelector('[data-mark-action="remove"]').addEventListener("click", () => {
      saveHighlights(store.currentId, list.filter((h) => h.id !== hlId));
      renderReader();
      renderHighlights();
      hideMarkTip();
    });
    tip.querySelector(".sr-tip-close").addEventListener("click", hideMarkTip);
  }

  // AI 解释/问答 高亮 mark 点按 → 提供「取消高亮」
  function showAiHlMarkTip(mark) {
    const root = mark && mark.closest ? mark.closest(".orig-hover-pop-body, .sr-tip-result, .sr-msg-bubble") : null;
    if (!root || !store.currentId) return;
    const kind = root.matches(".sr-msg-bubble") ? "qa" : (root.dataset.aiHlKind === "qa" ? "qa" : "ai");
    const key = root.dataset.aiHlKey || "";
    if (!key) return;
    const tn = (Array.from(mark.childNodes).find((n) => n.nodeType === 3)) || mark;
    const st = textOffsetIn(root, tn, 0);
    const en = st + (((mark.textContent) || "").length);
    if (st < 0) return;
    const list = getAiHl(store.currentId);
    const idx = list.findIndex((r) => r.kind === kind && r.key === key && r.s === st && r.e === en);
    const tip = ensureMarkTip();
    tip.innerHTML = `
      <div class="sr-tip-grip" title="拖动移动（双击复位：下次点击重新跟随高亮位置）"></div>
      <div class="sr-mark-tip-quote">${esc(mark.textContent || "")}</div>
      <div class="sr-tip-actions">
        <button type="button" data-mark-action="remove-aihl">取消高亮</button>
      </div>
      <button class="sr-tip-close" type="button" aria-label="关闭">×</button>`;
    const rect = mark.getBoundingClientRect();
    tip.classList.remove("hidden");
    if (tip.classList.contains("sr-tip-moved") && tip.__clampToView) {
      tip.__clampToView();
    } else {
      const mw = tip.offsetWidth || 320;
      tip.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - mw - 8)) + "px";
      tip.style.top = (rect.top - 76 > 8 ? rect.top - 76 : rect.bottom + 10) + "px";
    }
    tip.querySelector('[data-mark-action="remove-aihl"]').addEventListener("click", () => {
      if (idx >= 0) { list.splice(idx, 1); saveAiHl(store.currentId, list); applyAiHlToRoot(root, kind, key); }
      hideMarkTip();
    });
    tip.querySelector(".sr-tip-close").addEventListener("click", hideMarkTip);
  }

  function onReaderMouseup(event) {
    const isLink = event.target.closest("button, a, mark.sr-mark");
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : "";
    if (!text || text.length < 2 || isLink) {
      hideSelectionTip();
      return;
    }
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    // AI 解释 / 问答 内容：单独走内联划词（高亮 + 笔记），不依赖原页文本层定位
    const inlineCtx = findInlineTarget(range.commonAncestorContainer);
    if (inlineCtx) {
      if (inlineCtx.key) renderInlineAiTip(range.getBoundingClientRect(), text, inlineCtx);
      else hideSelectionTip();
      return;
    }
    if (!range || !$s(".sr-reader-body").contains(range.commonAncestorContainer)) {
      hideSelectionTip();
      return;
    }
    const paraNode = range.commonAncestorContainer.nodeType === 1
      ? range.commonAncestorContainer.closest("[data-paragraph]")
      : range.commonAncestorContainer.parentElement?.closest("[data-paragraph]");
    if (!paraNode) { hideSelectionTip(); return; }
    const paraIndex = Number(paraNode.dataset.paraIndex);

    if (store.highlightMode) {
      addHighlightSelection(text, paraIndex);
      hideSelectionTip();
      return;
    }

    renderSelectionTip(range.getBoundingClientRect(), text, paraIndex);
  }

  // —— 元数据对话框 ——
  function openMetaDialog() {
    const dialog = el("lit-meta-dialog");
    if (dialog) dialog.showModal();
  }

  function renderMeta() {
    const body = el("lit-meta-body");
    if (!body) return;
    if (!store.detail) {
      body.innerHTML = `<p class="lit-meta-empty">选中文献后显示元数据。</p>`;
      return;
    }
    const meta = store.detail.meta || {};
    const project = store.detail.project || {};
    const status = meta.extract_status || "pending";

    const field = (label, value, link) => {
      if (!value) return "";
      const inner = link ? `<a href="${esc(link)}" target="_blank" rel="noopener">${esc(value)}</a>` : esc(value);
      return `<div class="lit-meta-row"><dt>${esc(label)}</dt><dd>${inner}</dd></div>`;
    };
    const keywords = (meta.keywords || []).length
      ? `<div class="lit-meta-block"><h4>关键词</h4><div class="lit-keywords">${meta.keywords.map((k) => `<span class="lit-tag">${esc(k)}</span>`).join("")}</div></div>` : "";
    const abstract = meta.abstract
      ? `<div class="lit-meta-block"><h4>摘要</h4><p class="lit-abstract">${esc(meta.abstract)}</p></div>` : "";
    const abstractTr = meta.abstract_translated
      ? `<div class="lit-meta-block"><h4>摘要译文</h4><p class="lit-abstract lit-abstract-translated">${esc(meta.abstract_translated)}</p></div>` : "";
    const refresh = status === "done" ? "" :
      `<button class="secondary-button lit-extract-button" type="button" data-lit-action="extract">${status === "pending" ? "抽取元数据" : "重新抽取元数据"}</button>`;

    body.innerHTML = `
      ${refresh}
      <h3 class="lit-meta-title">${esc(meta.title || project.subject || "未命名论文")}</h3>
      <dl class="lit-meta-list">
        ${field("作者", meta.authors)}
        ${field("年份", meta.year)}
        ${field("期刊 / 会议", meta.venue)}
        ${field("DOI", meta.doi, meta.doi ? `https://doi.org/${meta.doi}` : "")}
        ${field("arXiv", meta.arxiv_id, meta.arxiv_id ? `https://arxiv.org/abs/${meta.arxiv_id}` : "")}
        ${field("参考文献", meta.references_count)}
      </dl>
      ${keywords}
      ${abstract}
      ${abstractTr}
      <div class="lit-meta-block">
        <h4>阅读数据</h4>
        <p class="lit-reading-stats">${formatReadingInfo(project)}</p>
      </div>
      <div class="lit-meta-block">
        <h4>我的标签</h4>
        <div class="lit-tag-editor">
          ${(project.tags || []).map((t) => `<span class="lit-tag lit-tag-editable">${esc(t)}<button type="button" data-lit-action="remove-tag" data-tag="${esc(t)}" aria-label="移除标签">×</button></span>`).join("")}
          <form class="lit-tag-form" data-lit-tag-form>
            <input type="text" placeholder="添加标签后回车" maxlength="40" autocomplete="off">
          </form>
        </div>
      </div>`;
  }

  async function extractMeta() {
    const id = store.currentId;
    if (!id) return;
    const btn = $s("[data-lit-action=\"extract\"]");
    if (btn) { btn.disabled = true; btn.innerHTML = "<span class=\"btn-spinner\" aria-hidden=\"true\"></span> 抽取中…"; }
    try {
      const res = await window.api(`/api/literature/${encodeURIComponent(id)}/extract`, { method: "POST" });
      store.detail.meta = res.meta || {};
      const found = store.items.find((it) => it.project.project_id === id);
      if (found) found.meta = res.meta || {};
      renderMeta();
      renderReader();
      renderAllTabs();
    } catch (error) {
      showReaderError(error.message);
    }
  }

  async function updateTags(tags) {
    const id = store.currentId;
    if (!id) return;
    try {
      const res = await window.api(`/api/literature/${encodeURIComponent(id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags }),
      });
      store.detail.project = res.project;
      const found = store.items.find((it) => it.project.project_id === id);
      if (found) found.project = res.project;
      renderMeta();
      renderLibrary();
    } catch (error) { showReaderError(error.message); }
  }

  function addTag(input) {
    const value = input.value.trim();
    if (!value) return;
    const tags = store.detail?.project?.tags || [];
    if (tags.includes(value)) { input.value = ""; return; }
    updateTags(tags.concat(value));
    input.value = "";
  }
  function removeTag(tag) {
    const tags = (store.detail?.project?.tags || []).filter((t) => t !== tag);
    updateTags(tags);
  }

  // —— 阅读笔记（本地） ——
  function noteKey(id) { return NOTE_PREFIX + id; }
  function loadNote(id) {
    const ta = el("lit-note");
    if (!ta) return;
    let saved = "";
    if (id && id === store.currentId && store.marksReady) {
      saved = store.markNote || "";
    } else {
      try { saved = localStorage.getItem(noteKey(id)) || ""; } catch { saved = ""; }
    }
    ta.value = saved;
  }
  function onNoteInput() {
    const id = store.currentId;
    if (!id) return;
    window.clearTimeout(store.noteTimer);
    store.noteTimer = window.setTimeout(() => {
      const value = el("lit-note") ? el("lit-note").value : "";
      if (store.marksReady) store.markNote = value;
      try { localStorage.setItem(noteKey(id), value); } catch {}
      queueMarkSync("note", "", value);
    }, 400);
  }

  // —— 多篇对比 ——
  function compareTitlesFor(ids) {
    return ids.map((id) => {
      const item = store.items.find((it) => it.project.project_id === id);
      return item ? (item.meta.title || item.project.subject || "未命名论文") : "未知论文";
    });
  }
  function renderCompareLoading(ids, titles) {
    return `<div class="lit-compare-loading">
      <span class="btn-spinner" aria-hidden="true"></span>
      <p>正在对比 ${ids.length} 篇论文…</p>
      <ul class="lit-compare-paper-list">${titles.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
    </div>`;
  }
  function openCompareDialog() {
    const dialog = el("lit-compare-dialog");
    if (!dialog) return;
    const body = el("lit-compare-body");
    const ids = [...store.compareIds];
    const titles = compareTitlesFor(ids);
    body.innerHTML = renderCompareLoading(ids, titles);
    dialog.showModal();
    // 供 lit-course-bridge.js 取「参与对比的文献」用（并入知识网要标题与 id）。
    // 跨文件不共享 store，所以就地挂在 dialog 上，不把 literature 的 store 暴露成全局。
    dialog.__knoworiginCompareIds = ids;
    dialog.__knoworiginCompareTitles = titles;
    // 默认走「复用上次结果」：同一组论文比对过一次就不再等一次 LLM。
    // 结果不满意时由右上角「重新对比」触发强制重算。
    runCompare(false);
  }
  // 右上角「重新对比」：丢掉缓存结果，重新调用 AI 生成。
  function recompare() {
    const ids = [...store.compareIds];
    if (!ids.length) return;
    el("lit-compare-body").innerHTML = renderCompareLoading(ids, compareTitlesFor(ids));
    runCompare(true);
  }
  async function runCompare(force) {
    const ids = [...store.compareIds];
    const body = el("lit-compare-body");
    const refreshBtn = el("lit-compare-refresh");
    if (refreshBtn) refreshBtn.disabled = true;
    try {
      const res = await window.api(
        "/api/literature/compare" + (force ? "?refresh=true" : ""),
        {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ project_ids: ids }),
        },
      );
      body.innerHTML = renderComparisonMarkdown(res.comparison || "", res);
      // 对比报告原文挂在 body 上，供 lit-course-bridge.js 做落点预览与并入。
      // 为什么不从 DOM 里抠文本：那样会丢掉表格结构与加粗，交给模型的口径就变了。
      body.__knoworiginCompareReport = res.comparison || "";
      bindCompareTableScroll();
      if (window.KnowOriginLitBridge && typeof window.KnowOriginLitBridge.afterCompare === "function") {
        window.KnowOriginLitBridge.afterCompare();
      }
    } catch (error) {
      body.innerHTML = `<p class="lit-error">${esc(error.message)}</p>`;
    } finally {
      if (refreshBtn) refreshBtn.disabled = false;
    }
  }
  // 复用旧结果时给一条明确提示：让人知道看到的是上次的结论、以及怎么重算。
  function renderCompareCacheNotice(info) {
    if (!info || !info.cached) return "";
    const when = formatCompareTime(info.created_at);
    return `<div class="lit-compare-cached" role="status">`
      + `<span class="lit-compare-cached-dot" aria-hidden="true"></span>`
      + `<span>这是上次的对比结果${when ? `（${esc(when)}）` : ""}。文献更新过或想看不一样的结论，点右上角「重新对比」。</span>`
      + `</div>`;
  }
  function formatCompareTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function renderComparisonMarkdown(md, info) {
    const notice = renderCompareCacheNotice(info);
    if (!md || !md.trim()) return notice + `<p class="lit-error">对比结果为空，请稍后重试。</p>`;
    const normalized = String(md).replace(/\r\n/g, "\n");
    // 拆分表格区域和非表格区域：以连续表格行（| 开头）为分界
    const lines = normalized.split("\n");
    const segments = []; // { type: "table" | "text", content: string }
    let current = null;
    for (const line of lines) {
      const trimmed = line.trim();
      const isTableRow = trimmed.startsWith("|");
      if (!current || current.type !== (isTableRow ? "table" : "text")) {
        if (current && current.content) segments.push(current);
        current = { type: isTableRow ? "table" : "text", content: line };
      } else {
        current.content += "\n" + line;
      }
    }
    if (current && current.content) segments.push(current);

    let html = "";
    for (const seg of segments) {
      if (seg.type === "table") {
        const rows = seg.content.split("\n").map((r) => r.trim()).filter((r) => r.startsWith("|"));
        const cells = rows.map((r) => r.split("|").slice(1, -1).map((c) => c.trim()));
        const dataRows = cells.filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c)));
        if (dataRows.length < 2) continue;
        const [head, ...bodyRows] = dataRows;
        html += "<div class=\"lit-compare-table-wrap\"><table class=\"lit-compare-table\"><thead><tr>" +
          head.map((c, i) => `<th${i === 0 ? " class=\"lit-compare-dim-col\"" : ""}>${i === 0 ? esc(c) : renderInlineMarkdown(c)}</th>`).join("") +
          "</tr></thead><tbody>" +
          bodyRows.map((r) => `<tr>${r.map((c, i) => `<td${i === 0 ? " class=\"lit-compare-dim-col\"" : ""}>${i === 0 ? `<strong>${esc(c)}</strong>` : renderInlineMarkdown(c)}</td>`).join("")}</tr>`).join("") +
          "</tbody></table></div>";
      } else {
        // 文本区域：使用 renderMarkdown 渲染（支持粗体、列表、标题等）
        html += `<div class="lit-compare-summary">${renderMarkdown(seg.content)}</div>`;
      }
    }
    if (!html) return notice + `<p class="lit-error">对比结果为空，请稍后重试。</p>`;
    // 结论的去处只有一条：「建对比项目并打开来源视图」，由 lit-course-bridge.js 追加在报告末尾
    // （见该文件 projectBox()）。
    // 2026-09-12 按用户要求删掉底部那行「对比结论可以并入当前课程的来源视图 + 并入知识网」：
    // 课程侧的来源视图已经搬进阅读界面的对比视图，那个按钮的落点说不清楚了。
    // 注意：innerHTML 插入的 <script> 不会执行，所以这里不能再靠内联 script 绑定事件；
    // 「表格滚动阴影」在 innerHTML 落盘后由 bindCompareTableScroll() 显式绑定
    // （scroll 事件不冒泡，无法用事件委托）。
    return notice + html;
  }

  // 表格滚动阴影：必须在内容落盘之后绑定
  function bindCompareTableScroll() {
    document.querySelectorAll('.lit-compare-table-wrap').forEach(function (w) {
      var update = function () {
        w.classList.toggle('lit-scroll-start', w.scrollLeft > 4);
        w.classList.toggle('lit-scroll-end', w.scrollLeft + w.clientWidth < w.scrollWidth - 4);
      };
      w.addEventListener('scroll', update);
      update();
    });
  }
  // 表格单元格里的行内 Markdown：**粗体** / `代码` / 行内公式。
  // 2026-09-28 修：此前这里只做 esc + 粗体，AI 在对比表里写的
  //   $\Delta\lambda = \frac{2h}{m_0 c} \sin^2\frac{\theta}{2}$
  // 会连同 $ 号原样露出（对比表、译文/问答里的竖线表格都走这个函数）。
  // 这里沿用本文件 renderMarkdown 已经验证过的「先摘公式 → esc 正文 → 最后还原」流程，
  // 只作用于行内：单元格很窄，块级公式（display:block + width:100%）会把它撑成竖排。
  function renderInlineMarkdown(text) {
    let raw = String(text == null ? "" : text).replace(/[\r\n]+/g, " ");
    if (!raw) return "";

    // —— 1) 先摘出公式，避免 esc() 和粗体正则破坏 \frac、\Delta 这类命令 ——
    const mathBuf = [];
    const protect = (src) => {
      const i = mathBuf.push(String(src || "").trim()) - 1;
      return `\u0001M${i}\u0001`;
    };
    // 单个 $ 最容易误判（中文里的「$100」「$20」），只在内容确实像公式时才算公式，
    // 否则原样保留旧行为，不让货币数字被 KaTeX 变成红色报错块。
    const looksLikeMath = (s) => {
      const t = String(s || "").trim();
      if (!t) return false;
      if (t.includes("\\")) return true;                                  // \frac \lambda \text …
      if (/[_^=]/.test(t)) return true;                                   // x_i、c^2、E=mc^2
      return /^[A-Za-z\u0370-\u03ff][A-Za-z0-9\s.,+\-*/()]*$/.test(t);    // 纯符号串
    };
    raw = raw.replace(/\$\$([\s\S]+?)\$\$/g, (_m, s) => protect(s));   // $$…$$
    raw = raw.replace(/\\\[([\s\S]+?)\\\]/g, (_m, s) => protect(s));   // \[…\]
    raw = raw.replace(/\\\(([\s\S]+?)\\\)/g, (_m, s) => protect(s));   // \(…\)
    raw = raw.replace(/\$(?!\$)([^$\n]+?)\$/g, (m, s) =>               // $…$
      (looksLikeMath(s) ? protect(s) : m));
    // 整格就是一段漏了定界符的裸 LaTeX：没有中文、含 LaTeX 命令、且出现数学符号才算，
    // 这样「E:\Code\tiyuan\src\core」这类 Windows 路径不会被误当公式。
    if (!mathBuf.length && !/[\u4e00-\u9fff]/.test(raw)
      && /\\[a-zA-Z]{2,}/.test(raw) && /[=_^{]/.test(raw)) {
      raw = protect(raw);
    }

    // —— 2) 正文照旧转义 + 行内 Markdown ——
    let html = esc(raw)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");

    // —— 3) 还原公式：renderMathLatex 内部先走 window.renderKatex（app.js 管线），
    //      再退到 window.katex，最后退到 <code> 原文，不会白屏 ——
    html = html.replace(/\u0001M(\d+)\u0001/g, (_m, i) => {
      const src = mathBuf[Number(i)];
      if (src == null) return "";
      try {
        return renderMathLatex(src, false) || `<code>${esc(src)}</code>`;
      } catch (err) {
        return `<code>${esc(src)}</code>`;
      }
    });
    return html;
  }

  // —— 图书馆跳转 ——
  async function loadLibraryLinks() {
    const box = el("lit-library-links");
    if (!box) return;
    box.innerHTML = `<h4>图书馆数据库</h4><p class="lit-links-loading">加载中…</p>`;
    try {
      const res = await window.api("/api/library-links");
      const links = res.links || [];
      if (!links.length) { box.innerHTML = ""; return; }
      box.innerHTML = `<h4>图书馆数据库</h4>` +
        links.map((l) => {
          const label = l.label || l.name || l.title || "图书馆链接";
          const url = l.url || l.href || "";
          if (!url) return "";
          return `<a class="lit-library-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>`;
        }).join("");
    } catch { box.innerHTML = ""; }
  }

  // —— 阅读助手侧栏宽度：左右横向拖拽 ——
  // 宽度的**唯一权威**在这里：内联的 --sr-aside-w + localStorage。
  // 其它模块（如「加宽/还原」按钮）一律走 setAsideWidth() 这个入口，
  // 谁也别再用 !important 的 flex-basis 钉死宽度——那样拖拽会被静默压掉。
  const ASIDE_MIN = 220;
  const ASIDE_MAX = 640;
  const READER_MIN = 320;
  const ASIDE_DEFAULT_W = 320;
  function applyAsideWidth(w) {
    const aside = $s(".sr-aside");
    if (aside) aside.style.setProperty("--sr-aside-w", Math.round(w) + "px");
  }
  // 上限同时受侧栏自身封顶与「原文区至少 READER_MIN」两条约束；容器量不到时只按封顶。
  function asideWidthMax() {
    const aside = $s(".sr-aside");
    const available = aside && aside.parentElement ? aside.parentElement.getBoundingClientRect().width : 0;
    return available > 0
      ? Math.max(ASIDE_MIN, Math.min(ASIDE_MAX, available - READER_MIN))
      : ASIDE_MAX;
  }
  function clampAsideWidth(w) {
    const n = Math.round(Number(w));
    if (!Number.isFinite(n)) return ASIDE_DEFAULT_W;
    return Math.max(ASIDE_MIN, Math.min(asideWidthMax(), n));
  }
  // 「意图宽度」= 写在 --sr-aside-w 上的值。外部想知道当前宽度时用它，
  // 不要用 getBoundingClientRect()：侧栏有 0.22s 的 flex-basis 过渡，
  // 动画期间渲染宽度会落后于变量，用它判断会得出「刚点了加宽却还显示加宽按钮」。
  function asideWidthNow() {
    const aside = $s(".sr-aside");
    if (!aside) return 0;
    const v = parseFloat(getComputedStyle(aside).getPropertyValue("--sr-aside-w"));
    return Number.isFinite(v) ? Math.round(v) : Math.round(aside.getBoundingClientRect().width);
  }
  // 设宽 + 落盘 + 广播（广播给「加宽/还原」按钮之类的外部宽度消费者）。
  function setAsideWidth(w) {
    const next = clampAsideWidth(w);
    applyAsideWidth(next);
    try { localStorage.setItem(ASIDE_KEY, String(next)); } catch {}
    try {
      document.dispatchEvent(new CustomEvent("knoworigin:aside-width", { detail: { width: next } }));
    } catch (_) { /* 广播失败不影响宽度本身 */ }
    return next;
  }
  function initAsideResizing() {
    const aside = $s(".sr-aside");
    const handle = $s(".sr-aside-resizer");
    if (!aside || !handle) return;

    let saved = Number(localStorage.getItem(ASIDE_KEY));
    if (!Number.isFinite(saved) || saved < ASIDE_MIN) saved = ASIDE_DEFAULT_W;
    // 启动恢复只设变量、不广播：此刻外部监听者（如文献库头部按钮）可能还没挂上，
    // 它们各自在初始化时读一次真实宽度即可。
    applyAsideWidth(saved);

    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startW = aside.getBoundingClientRect().width;
      handle.classList.add("is-active");
      document.body.classList.add("is-aside-resizing");
      // 目标宽度（意图值）。落盘必须用它，不能拿 getBoundingClientRect()：
      // 侧栏带 0.22s 的 flex-basis 过渡，拖到一半时渲染宽度还落在指针后面，
      // 照渲染值落盘会把「拖 140px」存成「拖 60px」（2026-10-01 实测）。
      let target = startW;

      const move = (m) => {
        if (m.pointerId !== e.pointerId) return;
        // 拖动过程中只改宽度：不落盘、不广播（每秒几十次，没必要）
        target = clampAsideWidth(startW + (m.clientX - startX));
        applyAsideWidth(target);
      };
      const finish = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        handle.classList.remove("is-active");
        document.body.classList.remove("is-aside-resizing");
        setAsideWidth(target);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    });
    handle.addEventListener("dblclick", () => setAsideWidth(ASIDE_DEFAULT_W));
    handle.addEventListener("keydown", (e) => {
      const dir = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
      if (!dir) return;
      e.preventDefault();
      const step = e.shiftKey ? 60 : 20;
      setAsideWidth(aside.getBoundingClientRect().width + dir * step);
    });
  }

  // —— 右侧「全文翻译」面板宽度：左右横向拖拽 ——
  const TRAN_MIN = 280;
  const TRAN_MAX = 640;
  function clampTransW(w, available) {
    return Math.max(TRAN_MIN, Math.min(Math.min(TRAN_MAX, available * 0.42), w));
  }
  function applyOrigTransWidth(w) {
    const panel = el("lit-reader-body")?.querySelector("[data-orig-trans]");
    if (panel) panel.style.setProperty("--orig-trans-w", Math.round(w) + "px");
  }
  function syncOrigTransResizer() {
    const body = el("lit-reader-body");
    if (!body) return;
    const handle = body.querySelector(".orig-trans-resizer");
    const panel = body.querySelector("[data-orig-trans]");
    if (handle && panel) handle.classList.toggle("hidden", panel.classList.contains("hidden"));
  }
  function initOrigTransResizing() {
    const body = el("lit-reader-body");
    const panel = body && body.querySelector("[data-orig-trans]");
    const handle = body && body.querySelector(".orig-trans-resizer");
    if (!panel || !handle) return;

    let saved = Number(localStorage.getItem(TRAN_KEY));
    if (!Number.isFinite(saved) || saved < TRAN_MIN) saved = 360;
    applyOrigTransWidth(saved);

    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startW = panel.getBoundingClientRect().width;
      handle.classList.add("is-active");
      document.body.classList.add("is-trans-resizing");
      const move = (m) => {
        if (m.pointerId !== e.pointerId) return;
        const available = body.getBoundingClientRect().width;
        applyOrigTransWidth(clampTransW(startW - (m.clientX - startX), available));
      };
      const finish = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        handle.classList.remove("is-active");
        document.body.classList.remove("is-trans-resizing");
        try { localStorage.setItem(TRAN_KEY, String(panel.getBoundingClientRect().width)); } catch {}
        syncOrigTransResizer();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    });
    handle.addEventListener("dblclick", () => applyOrigTransWidth(360));
    handle.addEventListener("keydown", (e) => {
      const dir = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
      if (!dir) return;
      e.preventDefault();
      const step = e.shiftKey ? 60 : 20;
      const available = body.getBoundingClientRect().width;
      const next = clampTransW(panel.getBoundingClientRect().width + dir * step, available);
      applyOrigTransWidth(next);
      try { localStorage.setItem(TRAN_KEY, String(next)); } catch {}
    });
    syncOrigTransResizer();
  }

  // —— 事件绑定 ——
  function bind(sel, type, handler, scope) {
    const node = $s(sel, scope);
    if (node) node.addEventListener(type, handler);
    return node;
  }

  function initEvents() {
    // 阅读助手侧栏：左右横向拖拽调整宽度
    initAsideResizing();

    // 顶栏
    bind("#lit-library-toggle", "click", () => showLibraryPanel(!store.showingLibrary));
    bind("#lit-info-button", "click", openMetaDialog);
    bind("#lit-translate-all-button", "click", toggleAutoTrans);
    bind("#lit-view-toggle", "click", () => {
      store.readMode = store.readMode === "original" ? "text" : "original";
      if (store.readMode === "text") { store.originalMeta = null; store.originalPage = 0; store.originalZoom = 1; }
      renderReader();
    });
    bind("#lit-highlight-toggle", "click", () => switchTab("notes"));
    bind("#lit-font-minus", "click", () => changeFontsize(-1));
    bind("#lit-font-plus", "click", () => changeFontsize(1));
    bind("#lit-toc-level", "change", (e) => {
      store.tocLevel = Number(e.target.value) || 0;
      renderToc();
    });

    // 标签
    $$s(".sr-tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));

    // 文献库列表
    el("lit-list").addEventListener("click", (e) => {
      const target = e.target.closest("[data-lit-action]");
      if (!target) return;
      const action = target.dataset.litAction;
      const id = target.dataset.id;
      if (action === "select") selectLiterature(id);
      else if (action === "toggle-compare") toggleCompare(id);
      else if (action === "delete") openLitDeleteDialog(id);
    });

    // 阅读区：段落翻译按钮 / 高亮标记点击
    el("lit-reader-body").addEventListener("click", (e) => {
      const mark = e.target.closest("mark.sr-mark");
      if (mark) { showMarkTip(mark); return; }
      const target = e.target.closest("[data-lit-action]");
      if (!target) { hideMarkTip(); return; }
      if (target.dataset.litAction === "translate") translateParagraph(Number(target.dataset.index));
      else if (target.dataset.litAction === "locate-sub") handleLocateSubClick(target);
    });
    el("lit-reader-body").addEventListener("click", (e) => {
      const b = e.target.closest("[data-orig]");
      if (!b) return;
      const act = b.dataset.orig;
      const base = originalBase();
      const refireOrig = () => {
        if (!base) return;
        const readerBody = el("lit-reader-body");
        if (readerBody) {
          const stage = readerBody.querySelector("[data-orig-stage]");
          (stage || readerBody).scrollTop = 0;
        }
        if (_origAbort) _origAbort.abort();
        _origAbort = new AbortController();
        renderOrigPage(base, _origAbort);
      };

      if (act === "prev") { if (store.originalPage > 0) { store.originalPage--; refireOrig(); } }
      else if (act === "next") { if (store.originalPage < nOrigPages() - 1) { store.originalPage++; refireOrig(); } }
      else if (act === "todot") { store.readMode = "text"; renderReader(); }
      else if (act === "undo-hl") origHlUndo();
      else if (act === "redo-hl") origHlRedoRun();
      else if (act === "clear-hl") origHlClearAll();
    });
    el("lit-reader-body").addEventListener("mouseup", onReaderMouseup);

    // 问答消息区划词（AI 回复内高亮 + 笔记）
    const qaMsgs = el("lit-qa-messages");
    if (qaMsgs) qaMsgs.addEventListener("mouseup", onReaderMouseup);

    // 划词翻译关闭按钮 / 高亮气泡关闭（事件委托到 body）
    document.addEventListener("mousedown", (e) => {
      if (selectionTip && !selectionTip.contains(e.target)) hideSelectionTip();
      if (markTip && !markTip.contains(e.target) && !e.target.closest("mark.sr-mark, mark.sr-aihl")) hideMarkTip();
    });

    // AI 解释/问答 高亮 mark 点按 → 提供「取消高亮」
    document.addEventListener("click", (e) => {
      const m = e.target && e.target.closest ? e.target.closest("mark.sr-aihl") : null;
      if (m) { e.stopPropagation(); showAiHlMarkTip(m); }
    });

    // 左侧标签面板（目录/图表/阅读重点/高亮）
    $$s(".sr-panel[data-panel]").forEach((panel) => panel.addEventListener("click", (e) => {
      // 目录树折叠/展开
      const toggle = e.target.closest(".sr-toc-toggle");
      if (toggle && toggle.dataset.tocToggle) {
        const children = document.getElementById(toggle.dataset.tocToggle);
        if (children) {
          const collapsed = children.classList.toggle("sr-toc-collapsed");
          toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
          toggle.setAttribute("aria-label", collapsed ? "展开" : "折叠");
        }
        return;
      }
      const target = e.target.closest("[data-lit-action]");
      if (!target) return;
      const action = target.dataset.litAction;
      // 原页模式：优先在原页内精准定位（跳到所在页并框选高亮）。
      // 只有当原页内定位不到（如纯扫描件无文本层、图表无坐标）时才切回文理视图定位。
      const origLocatable = action === "locate" || action === "locate-keypoint" || action === "locate-highlight" || action === "locate-figure";
      if (store.readMode === "original" && origLocatable) {
        let handled = false;
        if (action === "locate-figure") {
          handled = locateFigureOrig(target.dataset.fig);
        } else if (action === "locate-highlight") {
          const h = getHighlights(store.currentId).find((x) => x.id === target.dataset.id);
          if (h && h.mode === "original" && Number.isFinite(h.page)) {
            handled = goToOrigPage(h.page, null, h.text || "");
          } else if (h && h.text) {
            handled = locateTextOrig(h.text);
          }
        } else {
          const text = action === "locate" ? target.dataset.text
            : action === "locate-keypoint" ? (target.dataset.text || target.dataset.heading) : "";
          if (text) handled = locateTextOrig(text, action === "locate" ? target.dataset.page : null);
        }
        if (handled) return;
        store.readMode = "text";
        renderReader();
      }
      if (action === "locate") locateParagraph(target.dataset.text);
      else if (action === "locate-figure") locateFigure(target.dataset.fig);
      else if (action === "locate-sub") handleLocateSubClick(target);
      else if (action === "locate-keypoint") {
        const searchText = target.dataset.text;
        const heading = target.dataset.heading;
        if (!searchText) return;
        // 策略：先用 heading 定位章节，再在章节附近段落中精准搜索 quote
        const paras = mergeShortParagraphs(mergePipeTableParagraphs(splitParagraphs(readerText())));
        const headingIdx = heading ? findParagraphIndex(heading) : -1;
        // 在 heading 所在段落及后 8 段内搜索 quote
        const start = headingIdx >= 0 ? headingIdx : 0;
        const end = headingIdx >= 0 ? Math.min(headingIdx + 8, paras.length) : paras.length;
        let found = false;
        for (let i = start; i < end; i++) {
          if (paras[i].includes(searchText)) {
            scrollToParagraph(i, searchText);
            found = true;
            break;
          }
        }
        if (!found) {
          // 局部搜索失败 → 全局搜索（含滑窗模糊匹配）
          const idx = findParagraphIndex(searchText);
          if (idx >= 0) scrollToParagraph(idx, searchText);
          else if (heading && heading !== searchText) locateParagraph(heading, heading);
        }
      } else if (action === "locate-highlight") {
        const hl = getHighlights(store.currentId).find((h) => h.id === target.dataset.id);
        if (hl) locateParagraph(hl.text, hl.text);
        const mark = document.querySelector(`mark[data-hl-id="${esc(target.dataset.id)}"]`);
        if (mark) { mark.classList.add("flash"); setTimeout(() => mark.classList.remove("flash"), 1300); }
      } else if (action === "remove-highlight") {
        const removedId = target.dataset.id;
        const removed = getHighlights(store.currentId).find((h) => h.id === removedId);
        if (removed && removed.mode === "original") {
          store.originalHl = (store.originalHl || []).filter((h) => h.id !== removedId);
          origHlRefreshUI();
        }
        saveHighlights(store.currentId, getHighlights(store.currentId).filter((h) => h.id !== removedId));
        renderReader();
        renderHighlights();
      } else if (action === "remove-note") {
        removeNote(target.dataset.id);
      } else if (action === "insights") loadInsights();
      else if (action === "add-keypoint") { store.kpEditing = { mode: "add", id: "", heading: "", summary: "", quote: "" }; renderKeypoints(); }
      else if (action === "edit-keypoint") openKpEditor(target.dataset.id);
      else if (action === "del-keypoint") deleteKeypoint(target.dataset.id);
      else if (action === "save-keypoint") saveKeypointEdit();
      else if (action === "cancel-keypoint-edit") { store.kpEditing = null; renderKeypoints(); }
    }));

    // AI 问答
    $$s(".sr-panel[data-panel=\"qa\"]").forEach((panel) => panel.addEventListener("click", (e) => {
      // 点击已选中 chip 的主体（非「×」删除按钮）→ 在阅读区查看选中的内容
      const chip = e.target.closest(".sr-qa-selchip");
      if (chip && !e.target.closest(".sr-qa-selchip-clear")) {
        const sel = (store.qaSelections || []).find((s) => String(s.id) === chip.dataset.selId);
        if (sel) viewSelection(sel);
        return;
      }
      const target = e.target.closest("[data-lit-action]");
      if (!target) return;
      const action = target.dataset.litAction;
      if (action === "ask-suggested") askQuestion(target.dataset.text);
      else if (action === "refresh-suggested") refreshSuggested();
      else if (action === "clear-qa") clearQA();
      else if (action === "clear-selection") clearQASelection(target.dataset.id);
      else if (action === "copy") copyText(target.dataset.text);
    }));
    bind("#lit-qa-form", "submit", (e) => {
      e.preventDefault();
      const input = el("lit-qa-input");
      askQuestion(input.value, true);
    });
    bind("#lit-qa-input", "keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        askQuestion(e.target.value, true);
      }
    });

    // 元数据对话框
    el("lit-meta-body").addEventListener("click", (e) => {
      const target = e.target.closest("[data-lit-action]");
      if (!target) return;
      const action = target.dataset.litAction;
      if (action === "extract") extractMeta();
      else if (action === "remove-tag") removeTag(target.dataset.tag);
    });
    el("lit-meta-body").addEventListener("submit", (e) => {
      const form = e.target.closest("[data-lit-tag-form]");
      if (!form) return;
      e.preventDefault();
      addTag($s("input", form));
    });

    // 导入
    el("lit-upload-button").addEventListener("click", openFilePicker);
    el("lit-file-input").addEventListener("change", onFileSelected);
    const pasteBtn = el("lit-paste-button");
    if (pasteBtn) pasteBtn.addEventListener("click", openPasteDialog);
    el("lit-paste-form").addEventListener("submit", submitPaste);
    el("lit-search").addEventListener("input", (e) => { store.search = e.target.value; renderLibrary(); });
    el("lit-reader-body").addEventListener("scroll", saveScrollPosition);
    el("lit-compare-button").addEventListener("click", openCompareDialog);
    el("lit-compare-clear")?.addEventListener("click", () => {
      store.compareIds.clear();
      renderLibrary();
      notifySelection();
    });
    bind("#lit-compare-refresh", "click", recompare);
    el("lit-note").addEventListener("input", onNoteInput);
    bind("#lit-delete-dialog", "close", () => { store.pendingDeleteId = null; });
    bind("#confirm-lit-delete", "click", confirmLitDelete);
    $$s("[data-lit-dialog-close]").forEach((btn) => btn.addEventListener("click", () => btn.closest("dialog").close()));
  }

  // 读取主题与字号后初始化事件
  if (window.KnowOriginTheme?.apply) window.KnowOriginTheme.apply(window.KnowOriginTheme.current());
  const savedFont = Number(localStorage.getItem(FONT_KEY));
  if (Number.isFinite(savedFont) && savedFont >= 12 && savedFont <= 22) store.fontsize = savedFont;
  initEvents();
  // 顶栏「文献库」按钮的 title / 徽标先按当前状态落一次（首屏 0 篇 → 徽标藏起来）。
  // 之后每次列表变动都由 renderLibrary()、每次开合库面板都由 showLibraryPanel() 同步。
  syncLibraryToggleLabel();

  // 对比视图（static/lit-compare-view.js）要读「勾选了哪几篇」与它们的标题，
  // 而 store 是本闭包内的。不把整个 store 暴露成全局（那会变成隐式契约），
  // 只开这三个小口子；onSelectionChange 由那边挂回调，勾选一变就刷新生成栏。
  // —— 通知主界面「项目集合变了」——
  // 导入论文会在后端新建一个项目、删除论文会移除一个项目，而主界面（app.js）顶部的
  // 项目下拉用的是登录那一刻拉取的 /api/projects 快照，并不会自己更新：用户从「文章阅读」
  // 点「返回」回到项目学习，看到的还是旧列表，必须手动刷新页面才会出现（或消失）。
  // 这里广播一个事件，由 app.js 静默重拉项目列表并重绘下拉。用事件而不是直接调函数，
  // 是为了守住 literature.js 与 app.js 各自独立（IIFE）的既有约定。
  function notifyProjectsChanged() {
    try {
      document.dispatchEvent(new CustomEvent("knoworigin:projects-changed"));
    } catch (_) { /* 广播失败不应影响导入 / 删除本身的结果 */ }
  }

  window.KnowOriginLiterature = {
    enter,
    exit,
    reset,
    // 阅读助手侧栏宽度的唯一入口（夹取 + 落盘 + 广播 knoworigin:aside-width）。
    // 外部模块（static/paper-search-ui.js 的「加宽/还原」按钮）要改侧栏宽度必须走这里：
    // 自己写 !important 的 flex-basis 会把拖拽手柄压成死的。
    setAsideWidth,
    getAsideWidth: () => asideWidthNow(),
    // 导入成功后的刷新必须无条件执行：isVisible() 检查的是整个文献工作区
    // (#literature-workspace) 是否可见，但「全球检索导入」可能在用户已退出文章阅读
    // （点了「返回」）之后才在后台完成，此时工作区已隐藏、isVisible() 为 false，
    // 列表便不会刷新——用户还得手动刷新才能看到新论文。loadLibrary() 只更新数据与
    // 列表 DOM，工作区不可见时调用也没有副作用，所以去掉这个可见性判断。
    refresh: () => {
      loadLibrary();
      // 全球检索导入（static/paper-search-ui.js）走的是这条路径：导入完成时用户
      // 可能已经退出文章阅读，主界面同样需要知道多了一个项目。
      notifyProjectsChanged();
    },
    // 事件名只在这里出现一次：别的模块（static/lit-course-bridge.js 建对比项目）
    // 需要广播时调这个方法，而不是自己再写一遍字符串字面量。
    notifyProjectsChanged,
    selectedIds: () => [...store.compareIds],
    clearSelection: () => {
      store.compareIds.clear();
      renderLibrary();
      notifySelection();
    },
    titleOf: (id) => {
      const hit = store.items.find((it) => it.project.project_id === id);
      if (!hit) return "";
      return (hit.meta && hit.meta.title) || hit.project.subject || "未命名论文";
    },
    // 导出面板（static/literature-export-ui.js）要知道「现在读的是哪一篇」。
    // 只开这一个只读口子，不把整个 store 暴露成全局（那会变成隐式契约）。
    currentId: () => store.currentId,
    onSelectionChange: null,
  };
})();
