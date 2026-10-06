/* ==================== 对比视图：来源视图的新家 ====================
   为什么要搬：来源视图原来和 XMind 脑图、双链图谱并排挂在主界面图谱区，
   而它读的是「资料 ⇄ 概念」——这恰好是读完一批文献才关心的事。放在那边意味着
   每看一次文献结论都要退出阅读模式、切到知识图谱、再切回来，来回跳。
   现在它跟着文献走：一组文献一张卡片，点开才展开。

   来源视图怎么产生（2026-09-12 按用户要求收敛为一条路）：
   勾选 2~4 篇文献 → 点「对比」出报告 → 点报告里的「建对比项目并打开来源视图」，
   卡片就落在这里。所以本面板不再自带「生成」按钮 —— 生成那一步由对比报告承担，
   而对比项目与「不带报告的组合项目」共用同一把指纹，同一组文献只会有一个项目。

   「对比报告」这类影子资料默认不画进图里（可用开关打开）：它只是生成来源视图的
   中间产物，画出来会把真正的文献挤到一边。

   边界：只新增本文件；画布、统计条、图例复用 kb-source-view.js 的现成实现，
   「打开资料」复用 app.js 的 openSourcePreview（带 ctx 版，见那边的注释）。
   ========================================================================== */

(function () {
  "use strict";

  const LIST_KEY = "knoworigin-lit-compare-views-v1";
  const REPORT_KEY = "knoworigin-lit-compare-include-report";
  const BTN_ID = "lit-compare-view-toggle";
  const PANEL_ID = "lit-compare-view";
  const LIST_ID = "lit-cv-list";
  const COUNT_ID = "lit-cv-count";
  const REPORT_TOGGLE_ID = "lit-cv-report-toggle";
  const STATUS_ID = "lit-cv-status";
  const READER_ID = "lit-reader-body";
  const STYLE_ID = "lit-compare-view-style";
  const LIBRARY_ID = "lit-library-panel";
  const LIBRARY_TOGGLE_ID = "lit-library-toggle";
  const MIN_PICK = 2;
  const MAX_PICK = 4;
  const HIGHLIGHT_CLASS = "is-bridge-new";
  const HIGHLIGHT_MS = 6000;
  const MAX_CLASS = "is-max";
  const MAX_LOCK_CLASS = "lit-cv-max-lock";
  const MAX_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M9 3H3v6"/><path d="M15 21h6v-6"/><path d="M21 9V3h-6"/><path d="M3 15v6h6"/></svg>';

  let busy = false;

  /* ---------- 小工具 ---------- */

  function esc(value) {
    if (typeof window.escapeHtml === "function") return window.escapeHtml(value);
    return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]
    ));
  }

  function el(id) { return document.getElementById(id); }

  function toast(message) {
    if (typeof window.showToast === "function") { window.showToast(message); return; }
    // showToast 不可用时不要静默失败，至少让人看到结果
    try { console.log("[知源]", message); } catch (_) { /* 忽略 */ }
  }

  function request(path, options) {
    if (typeof window.api !== "function") return Promise.reject(new Error("接口未就绪，请刷新页面"));
    return window.api(path, options);
  }

  function fmtTime(stamp) {
    if (!stamp) return "";
    const date = new Date(stamp);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  /* ---------- 「对比报告」算不算一份资料 ----------
     默认不算：报告是生成来源视图的中间产物，画进图里会把真正的文献挤开，
     而用户想看的是「哪个概念被哪几篇文献共同支撑」。 */
  function includeReports() {
    try { return localStorage.getItem(REPORT_KEY) === "1"; } catch (_) { return false; }
  }

  function setIncludeReports(on) {
    try { localStorage.setItem(REPORT_KEY, on ? "1" : "0"); } catch (_) { /* 忽略 */ }
  }

  function isReportSource(source) {
    return /^多文献对比/.test(String((source && source.filename) || ""));
  }

  function visibleSources(sources) {
    const list = Array.isArray(sources) ? sources : [];
    return includeReports() ? list.slice() : list.filter((s) => !isReportSource(s));
  }

  function hiddenReportCount(sources) {
    const list = Array.isArray(sources) ? sources : [];
    return includeReports() ? 0 : list.filter(isReportSource).length;
  }

  /* ---------- 与 literature.js 的唯一接口 ----------
     store 是 literature.js 闭包内的，不暴露成全局；那边开了三个小口子。 */

  function selectedIds() {
    const api = window.KnowOriginLiterature;
    if (api && typeof api.selectedIds === "function") {
      try { return api.selectedIds() || []; } catch (_) { /* 忽略 */ }
    }
    return [];
  }

  function titleOf(id) {
    const api = window.KnowOriginLiterature;
    if (api && typeof api.titleOf === "function") {
      try { return api.titleOf(id) || ""; } catch (_) { /* 忽略 */ }
    }
    return "";
  }

  /* ---------- 已生成列表（localStorage） ---------- */

  function readList() {
    try {
      const raw = JSON.parse(localStorage.getItem(LIST_KEY) || "[]");
      if (!Array.isArray(raw)) return [];
      return raw.filter((item) => item && item.projectId);
    } catch (_) {
      return [];
    }
  }

  function writeList(items) {
    try { localStorage.setItem(LIST_KEY, JSON.stringify(items)); } catch (_) { /* 忽略 */ }
  }

  function upsert(item) {
    const items = readList();
    const at = items.findIndex((x) => x.projectId === item.projectId);
    if (at >= 0) items[at] = Object.assign({}, items[at], item);
    else items.unshift(item);
    writeList(items);
  }

  function findItem(projectId) {
    return readList().find((x) => x.projectId === projectId) || null;
  }

  /* ---------- 面板开关 ---------- */

  function isOpen() {
    const panel = el(PANEL_ID);
    return !!panel && !panel.classList.contains("hidden");
  }

  function setStatus(kind, text) {
    const box = el(STATUS_ID);
    if (!box) return;
    if (!text) { box.classList.add("hidden"); box.textContent = ""; return; }
    box.classList.remove("hidden", "is-ok", "is-error");
    if (kind === "ok") box.classList.add("is-ok");
    else if (kind === "error") box.classList.add("is-error");
    box.innerHTML = (kind === "spinner" ? '<span class="btn-spinner" aria-hidden="true"></span>' : "")
      + `<span>${esc(text)}</span>`;
  }

  function showPanel(on) {
    const panel = el(PANEL_ID);
    const reader = el(READER_ID);
    const btn = el(BTN_ID);
    if (!panel || !reader) return;
    if (!on) exitMax();   // 切走时别把页面留在放大态里
    panel.classList.toggle("hidden", !on);
    reader.classList.toggle("hidden", on);
    if (btn) {
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
    // 对比视图打开时阅读区已隐藏，「切换视图」（原页/文理）失去意义：置灰禁用，防止点开一片空白
    const viewToggle = el("lit-view-toggle");
    if (viewToggle) {
      viewToggle.disabled = on;
      viewToggle.setAttribute("aria-disabled", on ? "true" : "false");
    }
    if (on) {
      // 面板里要对照「左栏那份文献列表」，进来就把它打开，省得再点一次
      const lib = el(LIBRARY_ID);
      const libBtn = el(LIBRARY_TOGGLE_ID);
      if (lib && lib.classList.contains("hidden") && libBtn) libBtn.click();
      renderHead();
      syncCards();
    }
  }

  function toggle() { showPanel(!isOpen()); }

  // 切换账号：把上一个账号生成的「来源视图」卡片列表也清掉
  // （列表存在 localStorage、画的是别人文献的概念，留着就是泄漏）。
  function reset() {
    writeList([]);
    showPanel(false);
    syncCards();
  }


  /* ---------- 头部读数 ---------- */

  function renderHead() {
    const ids = selectedIds();
    const countEl = el(COUNT_ID);
    if (countEl) {
      const over = ids.length > MAX_PICK ? ` · 最多 ${MAX_PICK} 篇` : "";
      countEl.textContent = `已选 ${ids.length} 篇${over}`;
    }
    const reportToggle = el(REPORT_TOGGLE_ID);
    if (reportToggle) {
      const on = includeReports();
      reportToggle.classList.toggle("is-active", on);
      reportToggle.setAttribute("aria-pressed", on ? "true" : "false");
      reportToggle.textContent = on ? "含对比报告" : "不含对比报告";
    }
  }

  /* ---------- 卡片 ---------- */

  function itemTitle(item) {
    if (item.label) return item.label;
    const titles = (Array.isArray(item.titles) ? item.titles : []).filter(Boolean);
    if (!titles.length) return "来源视图";
    return titles.join(" / ");
  }

  function cardMeta(item) {
    const parts = [];
    const n = (Array.isArray(item.ids) ? item.ids : []).length;
    if (n) parts.push(`${n} 篇文献`);
    if (item.nodesCount) parts.push(`${item.nodesCount} 个概念`);
    if (item.sourceCount) parts.push(`${item.sourceCount} 份资料`);
    const when = fmtTime(item.createdAt);
    if (when) parts.push(when);
    return parts.join(" · ") || "尚未读取";
  }

  const EMPTY_HTML = '<div class="lit-cv-empty">'
    + '<div class="lit-cv-empty-card">'
    + '<span class="lit-cv-empty-mark">⚯</span>'
    + "<h4>暂无概念支撑图谱</h4>"
    + "<p class=\"lit-cv-empty-desc\">概念图谱将提炼多篇文献共同支撑的核心概念与孤证机理，助你一眼看清学术证据网络：</p>"
    + '<div class="lit-cv-empty-steps">'
    + '<div class="lit-cv-step"><span>1</span><p>左侧勾选 2–4 篇文献</p></div>'
    + '<div class="lit-cv-step-arr">→</div>'
    + '<div class="lit-cv-step"><span>2</span><p>点击「文本对比」</p></div>'
    + '<div class="lit-cv-step-arr">→</div>'
    + '<div class="lit-cv-step"><span>3</span><p>一键开启关系图谱</p></div>'
    + '</div>'
    + '<div class="lit-cv-empty-actions">'
    + '<button class="secondary-button" type="button" id="lit-cv-quick-demo-btn">🎲 随机选 2 篇体验对比</button>'
    + '</div>'
    + "</div></div>";

  function cardHtml(item) {
    const pid = esc(item.projectId);
    return '<header class="lit-cv-item-head">'
      + `<button class="lit-cv-item-toggle" type="button" data-lit-cv="toggle-card" data-key="${pid}" aria-expanded="false">`
      + '<span class="lit-cv-chev" aria-hidden="true"></span>'
      + '<span class="lit-cv-item-text">'
      + `<span class="lit-cv-item-title">来源视图 · ${esc(itemTitle(item))}</span>`
      + `<span class="lit-cv-item-meta">${esc(cardMeta(item))}</span>`
      + "</span></button>"
      + '<span class="lit-cv-item-actions">'
      + '<span class="lit-cv-max-tip" aria-hidden="true">按 Esc 退出放大</span>'
      + `<button class="lit-cv-icon-btn" type="button" data-lit-cv="max" data-key="${pid}"`
      + ' title="放大铺满界面查看" aria-label="放大铺满界面查看" aria-pressed="false">'
      + MAX_ICON + "</button>"
      + `<button class="mini-button" type="button" data-lit-cv="regen" data-key="${pid}">重新生成</button>`
      + `<button class="mini-button" type="button" data-lit-cv="remove" data-key="${pid}">移出列表</button>`
      + "</span></header>"
      + '<div class="lit-cv-body hidden">'
      + '<div class="lit-cv-summary"></div>'
      + '<div class="lit-cv-stage">'
      + '<svg class="kb-source-graph lit-cv-graph" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 260" '
      + 'aria-label="来源视图：资料与概念的支撑关系，可滚轮缩放、拖动平移" role="img"></svg>'
      + "</div>"
      + '<p class="lit-cv-note hidden"></p>'
      + '<div class="lit-cv-legend"></div>'
      + "</div>";
  }

  function findCard(projectId) {
    const list = el(LIST_ID);
    if (!list) return null;
    let hit = null;
    Array.prototype.some.call(list.children, (child) => {
      if (child.dataset && child.dataset.projectId === projectId) { hit = child; return true; }
      return false;
    });
    return hit;
  }

  /* 只增删、不整表重绘：已经展开的画布不该因为列表刷新被重置。 */
  function syncCards() {
    const list = el(LIST_ID);
    if (!list) return;
    const items = readList();
    if (!items.length) { list.innerHTML = EMPTY_HTML; exitMax(); return; }
    if (list.querySelector(".lit-cv-empty")) list.innerHTML = "";

    const alive = new Set();
    items.forEach((item) => {
      alive.add(item.projectId);
      let card = findCard(item.projectId);
      if (!card) {
        card = document.createElement("article");
        card.className = "lit-cv-item";
        card.dataset.projectId = item.projectId;
        card.innerHTML = cardHtml(item);
        list.appendChild(card);
      } else {
        // 列表里已有：只刷新标题与副标，别动画布
        const titleEl = card.querySelector(".lit-cv-item-title");
        const metaEl = card.querySelector(".lit-cv-item-meta");
        if (titleEl) titleEl.textContent = `来源视图 · ${itemTitle(item)}`;
        if (metaEl) metaEl.textContent = cardMeta(item);
      }
    });
    Array.prototype.slice.call(list.querySelectorAll(".lit-cv-item")).forEach((card) => {
      if (!alive.has(card.dataset.projectId)) card.remove();
    });
    // 被移出列表的那张可能正处在放大态：确认一下，别把页面锁在滚动禁用里
    if (!maxedCard()) exitMax();
  }

  async function loadCard(card, item, force) {
    const body = card.querySelector(".lit-cv-body");
    const stage = card.querySelector(".lit-cv-stage");
    const svg = card.querySelector(".lit-cv-graph");
    const sumEl = card.querySelector(".lit-cv-summary");
    const legendEl = card.querySelector(".lit-cv-legend");
    const noteEl = card.querySelector(".lit-cv-note");
    if (!body || !stage || !svg) return;

    if (card.dataset.loaded === "1" && !force) { return; }
    card.dataset.loaded = "";

    stage.querySelectorAll(".lit-cv-loading").forEach((n) => n.remove());
    const loading = document.createElement("div");
    loading.className = "lit-cv-loading";
    loading.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span><span>正在读取这组文献的来源视图…</span>';
    stage.appendChild(loading);

    try {
      const res = await request(`/api/projects/${encodeURIComponent(item.projectId)}`);
      const rawSources = Array.isArray(res.sources) ? res.sources : [];
      const dataset = {
        nodes: Array.isArray(res.nodes) ? res.nodes : [],
        // 「对比报告」这类影子资料默认不画（开关可打开）
        sources: visibleSources(rawSources),
        favorites: Array.isArray(res.favorites) ? res.favorites : [],
        // 节点上的「AI 解释」要打到这组文献所属的项目，而不是当前课程项目
        projectId: item.projectId,
        // 点「打开资料」要看的是这份资料本身，但它在另一个项目里 —— 课程侧的
        // 预览通道只会去当前课程里找，必然找不到，所以这里带 ctx 走对项目。
        onOpenSource: (source, quote) => {
          if (typeof window.openSourcePreview === "function") {
            // 出处对照里带知识点命中词：打开时直接定位到该知识点对应的原文位置
            window.openSourcePreview(source.source_id, quote || "", { projectId: item.projectId, sources: rawSources });
          } else {
            toast("预览组件未就绪，请刷新页面后再试");
          }
        },
      };
      if (typeof window.kbSourceInit !== "function") throw new Error("来源视图渲染器未就绪，请刷新页面");
      window.kbSourceInit(svg, dataset);
      const data = svg.__kbSrcData || null;
      if (sumEl && typeof window.kbSourceSummaryMarkup === "function") {
        sumEl.innerHTML = window.kbSourceSummaryMarkup({ data: data, projectId: item.projectId, showNotes: false });
        sumEl.__kbSrcData = data;   // 洞察按钮靠它认出「这次针对哪组文献」
      }
      if (legendEl && typeof window.kbSourceLegendMarkup === "function") {
        legendEl.innerHTML = window.kbSourceLegendMarkup(data);
      }
      if (noteEl) {
        const hidden = hiddenReportCount(rawSources);
        noteEl.textContent = hidden
          ? `已隐藏 ${hidden} 份对比报告（右上角开关可以显示）`
          : "";
        noteEl.classList.toggle("hidden", !hidden);
      }
      card.dataset.loaded = "1";
      const fresh = Object.assign({}, item, {
        nodesCount: dataset.nodes.filter((node) => Array.isArray(node.source_ids) && node.source_ids.length).length,
        sourceCount: dataset.sources.length,
      });
      upsert(fresh);
      const metaEl = card.querySelector(".lit-cv-item-meta");
      if (metaEl) metaEl.textContent = cardMeta(fresh);
    } catch (error) {
      if (typeof window.kbSourceRenderError === "function") {
        window.kbSourceRenderError(svg, error);
      } else {
        svg.innerHTML = "";
      }
      if (sumEl) sumEl.innerHTML = "";
      if (legendEl) legendEl.innerHTML = "";
      if (noteEl) noteEl.classList.add("hidden");
      card.dataset.loaded = "1";   // 别再反复重试；点「重新生成」可以重来
    } finally {
      loading.remove();
    }
  }

  function expandCard(card, item, force) {
    const body = card.querySelector(".lit-cv-body");
    if (!body) return;
    body.classList.remove("hidden");
    card.classList.add("is-open");
    const toggleBtn = card.querySelector('[data-lit-cv="toggle-card"]');
    if (toggleBtn) toggleBtn.setAttribute("aria-expanded", "true");
    loadCard(card, item, force);
  }

  function collapseCard(card) {
    const body = card.querySelector(".lit-cv-body");
    if (body) body.classList.add("hidden");
    card.classList.remove("is-open");
    const toggleBtn = card.querySelector('[data-lit-cv="toggle-card"]');
    if (toggleBtn) toggleBtn.setAttribute("aria-expanded", "false");
  }

  /* ---------- 放大铺满 ----------
     卡片一多，每张图只能分到一小条高度，节点字都糊在一起。
     所以把「看阵容」和「看细节」拆开：列表里照旧紧凑铺开，想看谁就点放大，
     那张卡片提到视口顶层铺满，图区吃满剩下的高度。Esc 或右上角按钮返回。 */

  function maxedCard() {
    const list = el(LIST_ID);
    if (!list || typeof list.querySelector !== "function") return null;
    return list.querySelector("." + MAX_CLASS + ".lit-cv-item") || null;
  }

  function isMaxed(card) {
    return !!card && card.classList.contains(MAX_CLASS);
  }

  function syncMaxButton(card, on) {
    const btn = card.querySelector('[data-lit-cv="max"]');
    if (!btn) return;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.title = on ? "退出放大（Esc）" : "放大铺满界面查看";
    btn.setAttribute("aria-label", on ? "退出放大" : "放大铺满界面查看");
  }

  function lockScroll(on) {
    if (document.body && document.body.classList) {
      document.body.classList.toggle(MAX_LOCK_CLASS, !!on);
    }
  }

  function enterMax(card, item) {
    if (!card) return;
    const other = maxedCard();
    if (other && other !== card) exitMax(other);   // 一次只放大一张
    if (!isOpen()) showPanel(true);
    // 先确保这张卡片是展开、且图已经画出来的：没展开就展开，展开过但没画成就补一次
    if (!card.classList.contains("is-open")) expandCard(card, item, false);
    else if (card.dataset.loaded !== "1") loadCard(card, item, false);
    card.classList.add(MAX_CLASS);
    lockScroll(true);
    syncMaxButton(card, true);
  }

  function exitMax(card) {
    const target = card || maxedCard();
    if (target && target.classList.contains(MAX_CLASS)) {
      target.classList.remove(MAX_CLASS);
      syncMaxButton(target, false);
    }
    // 被移出列表的卡片不在 maxedCard() 的查找范围里，用 body 兜底确认没有漏网的
    const left = document.body ? document.body.querySelector("." + MAX_CLASS + ".lit-cv-item") : null;
    if (!left) lockScroll(false);
  }

  /* 开关一翻，已经展开的卡片要按新口径重画 */
  function reloadOpenCards() {
    const list = el(LIST_ID);
    if (!list || typeof list.querySelectorAll !== "function") return;
    Array.prototype.forEach.call(list.querySelectorAll(".lit-cv-item.is-open"), (card) => {
      const item = findItem(card.dataset.projectId);
      if (item) loadCard(card, item, true);
    });
  }

  /* ---------- 对外接口 ---------- */

  /* 对比报告那边「建对比项目并打开来源视图」：不再退出阅读模式，
     就地把它变成对比视图里的一张卡片并展开。 */
  function openProject(projectId, ids, titles) {
    if (!projectId) return;
    const idList = Array.isArray(ids) ? ids.filter(Boolean) : [];
    const known = findItem(projectId);
    const item = {
      projectId: projectId,
      ids: idList.length ? idList : (known ? known.ids : []),
      titles: (Array.isArray(titles) && titles.length)
        ? titles
        : (known && known.titles && known.titles.length ? known.titles : idList.map(titleOf).filter(Boolean)),
      label: (known && known.label) || "",
      createdAt: (known && known.createdAt) || Date.now(),
      nodesCount: (known && known.nodesCount) || 0,
      sourceCount: (known && known.sourceCount) || 0,
    };
    upsert(item);
    showPanel(true);
    syncCards();
    const card = findCard(projectId);
    if (card) expandCard(card, item, true);
    setStatus("ok", "已把这组文献的来源视图放到这里，不用回主界面了。");
  }

  /* ---------- 事件 ---------- */

  function bindEvents() {
    document.addEventListener("click", (event) => {
      const node = event.target;
      if (!node || typeof node.closest !== "function") return;

      const actionBtn = node.closest("[data-lit-cv]");
      if (actionBtn) {
        const action = actionBtn.dataset.litCv;
        if (action === "toggle") { event.preventDefault(); toggle(); return; }
        if (action === "toggle-report") {
          event.preventDefault();
          setIncludeReports(!includeReports());
          renderHead();
          reloadOpenCards();
          return;
        }
        const card = actionBtn.closest(".lit-cv-item");
        if (!card) return;
        const key = card.dataset.projectId;
        const item = findItem(key);
        if (action === "toggle-card") {
          event.preventDefault();
          // 放大态下点标题 = 退出放大（此时「收起」没有意义，收了只剩一块空屏）
          if (isMaxed(card)) { exitMax(card); return; }
          if (card.classList.contains("is-open")) collapseCard(card);
          else if (item) expandCard(card, item, false);
          return;
        }
        if (action === "max") {
          event.preventDefault();
          if (isMaxed(card)) exitMax(card);
          else enterMax(card, item);
          return;
        }
        if (action === "regen") {
          event.preventDefault();
          const ids = (item && item.ids) || [];
          if (!ids.length) {
            toast("这一条没有记录文献组合，无法重新生成；重新做一次对比即可");
            return;
          }
          if (busy) return;
          busy = true;
          setStatus("spinner", `正在重新读出这 ${ids.length} 篇文献的概念…`);
          request("/api/literature/source-view/project?refresh=true", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ project_ids: ids }),
          }).then(() => {
            setStatus("ok", "已重新生成。");
            loadCard(card, item, true);
            toast("已重新生成来源视图");
          }).catch((error) => {
            setStatus("error", "重新生成失败：" + ((error && error.message) || error));
          }).finally(() => { busy = false; renderHead(); });
          return;
        }
        if (action === "remove") {
          event.preventDefault();
          exitMax(card);   // 先把页面从放大态放出来，再把它从列表里拿掉
          writeList(readList().filter((x) => x.projectId !== key));
          syncCards();
          toast("已从列表移出（项目本身还在，随时可以再打开）");
        }
        return;
      }

      // 空状态体验按钮：一键勾选 2 篇体验
      if (node.id === "lit-cv-quick-demo-btn" || node.closest("#lit-cv-quick-demo-btn")) {
        event.preventDefault();
        const checks = Array.from(document.querySelectorAll("#lit-list .lit-item-check"));
        if (checks.length >= 2) {
          checks.slice(0, 2).forEach((ck) => {
            if (!ck.checked) ck.click();
          });
          toast("已自动勾选 2 篇文献，可直接点击「文本对比」或「综述矩阵」开始！");
        } else if (checks.length === 1) {
          if (!checks[0].checked) checks[0].click();
          toast("文献库仅有 1 篇文献，对比需 2~4 篇，请先在左侧「导入论文」上传更多文献！");
        } else {
          toast("文献库暂无可用文献，请先在左侧上传文献 PDF！");
        }
        return;
      }

      // 左栏点开一篇文献 = 要读它了：从对比视图切回阅读模式
      if (isOpen() && node.closest('[data-lit-action="select"]')) showPanel(false);
    });

    // 勾选变化时刷新「已选 N 篇」
    const lit = window.KnowOriginLiterature;
    if (lit) lit.onSelectionChange = renderHead;

    // Esc 退出放大
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" && event.key !== "Esc") return;
      const card = maxedCard();
      if (!card) return;
      event.preventDefault();
      exitMax(card);
    });

    // 双击图区也能放大 / 还原；点在节点上不算（那是「出处对照」弹窗的入口）
    document.addEventListener("dblclick", (event) => {
      const node = event.target;
      if (!node || typeof node.closest !== "function") return;
      const stage = node.closest(".lit-cv-stage");
      if (!stage || node.closest(".kb-src-node")) return;
      const card = stage.closest(".lit-cv-item");
      if (!card) return;
      if (isMaxed(card)) exitMax(card);
      else enterMax(card, findItem(card.dataset.projectId));
    });
  }

  /* ---------- 挂载 ---------- */

  function ensureStyle() {
    if (el(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE_CSS;
    document.head.appendChild(style);
  }

  // 2026-09-12 挂载多文献研读栏，与「文本对比」「综述矩阵」形成统一的三合一操作胶囊组
  function ensureButton() {
    if (el(BTN_ID)) return;
    const targetGroup = document.querySelector(".lit-compare-pill-group") || document.querySelector(".lit-compare-bar");
    if (!targetGroup) return;
    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.className = "lit-cmp-pill-btn secondary-button lit-cv-entry";
    btn.setAttribute("aria-pressed", "false");
    btn.title = "概念图谱：查看这组文献中资料与概念的支撑关系网络";
    btn.innerHTML = '<span class="tb-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
      + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<rect x="3" y="4" width="7" height="16" rx="1.6"/><rect x="14" y="4" width="7" height="16" rx="1.6"/>'
      + '<path d="M10.4 12h3.2"/></svg></span><span>概念图谱</span>';
    btn.dataset.litCv = "toggle";
    targetGroup.appendChild(btn);
  }

  function ensurePanel() {
    if (el(PANEL_ID)) return;
    const reader = el(READER_ID);
    const stage = reader ? reader.parentNode : null;
    if (!stage) return;
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.className = "lit-cv hidden";
    panel.setAttribute("aria-label", "概念图谱");
    panel.innerHTML = '<div class="lit-cv-head">'
      + '<div class="lit-cv-head-text">'
      + "<h3>概念图谱 · 来源视图</h3>"
      + `<p>展现已选文献组中「资料 ⇄ 概念」的支撑网络：哪些机理被多篇共同验证、哪些只有孤证。每组文献生成一张独立关系卡片。</p>`
      + "</div>"
      + "哪些概念被好几篇共同支撑、哪些只有孤证，一眼看得出来。每换一组文献就是一张新卡片，点开才展开。</p>"
      + "</div>"
      + '<div class="lit-cv-head-actions">'
      + `<span class="lit-cv-count" id="${COUNT_ID}">已选 0 篇</span>`
      + `<button class="mini-button" type="button" id="${REPORT_TOGGLE_ID}" data-lit-cv="toggle-report" aria-pressed="false">不含对比报告</button>`
      + "</div></div>"
      + `<div class="lit-cv-status hidden" id="${STATUS_ID}" role="status" aria-live="polite"></div>`
      + `<div class="lit-cv-list" id="${LIST_ID}"></div>`;
    stage.appendChild(panel);
  }

  function mount() {
    ensureStyle();
    ensureButton();
    ensurePanel();
    bindEvents();
    // literature 侧的口子在它自己脚本末尾才挂上，晚一拍再对齐一次读数
    window.setTimeout(renderHead, 0);
  }

  const STYLE_CSS = `
.lit-cv {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 20px 22px;
  overflow: hidden;
}
.lit-cv-head { display: flex; align-items: flex-start; gap: 14px; flex-wrap: wrap; }
.lit-cv-head-text { flex: 1 1 320px; min-width: 0; }
.lit-cv-head-text h3 { margin: 0 0 4px; font-size: calc(16px * var(--font-scale, 1)); color: var(--ink); }
.lit-cv-head-text p { margin: 0; color: var(--muted); font-size: calc(12px * var(--font-scale, 1)); line-height: 1.65; }
.lit-cv-head-actions { display: inline-flex; align-items: center; gap: 8px; }
.lit-cv-count {
  padding: 5px 11px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--sidebar);
  color: var(--muted);
  font-size: calc(12px * var(--font-scale, 1));
  font-weight: 700;
  white-space: nowrap;
}
.lit-cv-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--sidebar);
  color: var(--muted);
  font-size: calc(12px * var(--font-scale, 1));
  line-height: 1.5;
}
.lit-cv-status.is-ok { border-color: var(--green); color: var(--ink); }
.lit-cv-status.is-error { border-color: var(--red); color: var(--red); }
.lit-cv-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-right: 2px;
}
.lit-cv-empty { margin: auto; padding: 40px 20px; text-align: center; color: var(--muted); }
.lit-cv-empty-mark {
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  margin: 0 auto 12px;
  border-radius: 14px;
  background: var(--green-soft);
  color: var(--green-dark);
  font-size: calc(20px * var(--font-scale, 1));
  font-weight: 700;
}
.lit-cv-empty h4 { margin: 0 0 6px; font-size: calc(14px * var(--font-scale, 1)); color: var(--ink); }
.lit-cv-empty p { margin: 0; font-size: calc(12px * var(--font-scale, 1)); line-height: 1.7; }
.lit-cv-item { border: 1px solid var(--line); border-radius: 14px; background: var(--panel); overflow: hidden; }
.lit-cv-item.is-open { border-color: var(--green); box-shadow: 0 0 0 3px rgba(var(--green-rgb), 0.10); }
.lit-cv-item-head { display: flex; align-items: center; gap: 10px; padding: 10px 12px; }
.lit-cv-item-toggle {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.lit-cv-chev {
  flex: 0 0 auto;
  width: 0;
  height: 0;
  border-left: 5px solid var(--muted);
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  transition: transform 160ms ease;
}
.lit-cv-item.is-open .lit-cv-chev { transform: rotate(90deg); }
.lit-cv-item-text { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.lit-cv-item-title {
  font-size: calc(13px * var(--font-scale, 1));
  font-weight: 700;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lit-cv-item-meta { font-size: calc(11px * var(--font-scale, 1)); color: var(--muted); }
.lit-cv-item-actions { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; }
.lit-cv-icon-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 27px;
  height: 27px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--panel);
  color: var(--muted);
  cursor: pointer;
  transition: border-color 140ms ease, color 140ms ease, background 140ms ease;
}
.lit-cv-icon-btn svg { display: block; width: 13px; height: 13px; }
.lit-cv-icon-btn:hover { border-color: var(--green); background: var(--green-soft); color: var(--green-dark); }
.lit-cv-icon-btn.is-active { border-color: var(--green); background: var(--green-soft); color: var(--green-dark); }
.lit-cv-max-tip { display: none; color: var(--muted); font-size: calc(11px * var(--font-scale, 1)); white-space: nowrap; }
.lit-cv-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border-top: 1px solid var(--line);
}
.lit-cv-body.hidden { display: none !important; }
.lit-cv-stage {
  position: relative;
  height: min(58vh, 540px);
  min-height: 320px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--background);
  overflow: hidden;
}
.lit-cv-graph { display: block; width: 100%; height: 100%; }
.lit-cv-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--panel);
  color: var(--muted);
  font-size: calc(12px * var(--font-scale, 1));
}
.lit-cv-note { margin: 0; padding: 6px 10px; border-radius: 9px; background: var(--sidebar); color: var(--muted); font-size: calc(11px * var(--font-scale, 1)); }
.lit-cv-note.hidden { display: none !important; }

/* —— 放大铺满 ——
   卡片一多，每张图只剩一小条高度。放大态把这张卡片提到视口顶层铺满：
   头部固定一条，图区 flex 吃满剩下的高度，统计条与图例保持原样。
   Esc、右上角按钮或点击标题栏都能回到列表。 */
body.lit-cv-max-lock { overflow: hidden; }
.lit-cv-item.is-max {
  position: fixed;
  inset: 0;
  z-index: 1500;
  display: flex;
  flex-direction: column;
  border: 0;
  border-radius: 0;
  background: var(--panel);
  box-shadow: none;
}
.lit-cv-item.is-max.is-open { box-shadow: none; }
.lit-cv-item.is-max .lit-cv-item-head {
  flex: 0 0 auto;
  gap: 12px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
.lit-cv-item.is-max .lit-cv-max-tip { display: inline-block; }
.lit-cv-item.is-max .lit-cv-item-title { font-size: calc(14px * var(--font-scale, 1)); }
.lit-cv-item.is-max .lit-cv-item-toggle { cursor: default; }
.lit-cv-item.is-max .lit-cv-body {
  flex: 1 1 auto;
  min-height: 0;
  gap: 10px;
  padding: 14px 18px 16px;
  border-top: 0;
  overflow: auto;
}
.lit-cv-item.is-max .lit-cv-summary,
.lit-cv-item.is-max .lit-cv-note,
.lit-cv-item.is-max .lit-cv-legend { flex: 0 0 auto; }
.lit-cv-item.is-max .lit-cv-stage {
  flex: 1 1 0;
  height: auto;
  min-height: 280px;
}
/* 按钮从顶栏搬到左栏对比条后，.lit-topbar-actions 那套 inline-flex / 图标尺寸管不到了，
   这里自己补齐 —— 不补的话 <svg> 会按默认 300x150 撑爆整行。
   flex: 1 1 auto 是为了两种宽度都好看：侧栏宽时三个挤一行，窄时按钮整行掉下来撑满。 */
.lit-compare-bar .lit-cv-entry {
  flex: 1 1 0;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  white-space: nowrap;
}
.lit-compare-bar .lit-cv-entry .tb-ic { display: inline-flex; align-items: center; }
.lit-compare-bar .lit-cv-entry .tb-ic svg { width: 12px; height: 12px; display: block; }
#lit-compare-view-toggle.is-active {
  border-color: var(--green);
  background: var(--green-soft);
  color: var(--green-dark);
}
/* 对比视图打开时，「切换视图」（原页/文理）不适用：置灰提示不可点 */
#lit-view-toggle:disabled,
#lit-view-toggle[aria-disabled="true"] {
  opacity: 0.45;
  border-color: var(--line);
  color: var(--muted);
  background: transparent;
  cursor: not-allowed;
}
`;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

  window.KnowOriginLitCompareView = {
    openProject: openProject,
    toggle: toggle,
    reset: reset,
    isOpen: isOpen,
    includeReports: includeReports,
    setIncludeReports: setIncludeReports,
    refresh: () => { if (isOpen()) { syncCards(); renderHead(); } },
  };
})();
