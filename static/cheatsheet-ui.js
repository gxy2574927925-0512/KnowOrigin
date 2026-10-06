/* ============================================================================
 * 知源（KnowOrigin）· 速查表（嵌入「知识卡片」「小测验」界面顶部）
 * ----------------------------------------------------------------------------
 * 只做一件事：把当前项目的全部知识点（framework node）按框架树层级列成一张
 * 可扫读的速查清单，直接嵌在「知识卡片」和「小测验」两个界面的正上方，
 * 每个知识点后面挂三个快捷按钮：「＋卡片」「＋测验」「＋文档」——
 *   复用个人知识库的按节点端点：
 *     POST /api/projects/{pid}/nodes/{node_id}/card
 *     POST /api/projects/{pid}/nodes/{node_id}/quiz
 *     POST /api/projects/{pid}/nodes/{node_id}/doc   （走 static/knowledge-doc-ui.js）
 * 顶部另有「一键生成整份文档」，同样是交给 knowledge-doc-ui.js 的批量控制器。
 * 生成结果与主「知识卡片」「小测验」界面共享同一份数据（存入 state.cards / state.quiz）。
 *
 * 第二件事：**点知识点行＝下面只留这个知识点的卡片**（再点一次取消）。速查表本来就是
 * 导航，点一下就跳到对应卡片才叫顺手。筛选只动 DOM（display + 重新编号），
 * state.cards 一个字节都不改 —— 翻面、自测、沉浸浏览都还按原索引工作。
 *
 * 实现方式（不改 app.js，靠包裹渲染函数注入）：
 *   1. app.js 顶层 function renderCards / renderQuiz 是全局函数（挂 window）；
 *   2. 本脚本在 DOMContentLoaded 时把它们各自包一层：先跑原渲染，再把速查表
 *      prepend 进 #studio-output 顶部；
 *   3. 速查表本体是一个 <details open> 折叠块，收起/展开由浏览器原生处理；
 *   4. 点「＋卡片 / ＋测验」生成成功后 switchFeature 到对应界面，新内容立即可见。
 *
 * 样式自带；删掉 index.html 里那一行 <script> 即完全回退。
 * ========================================================================== */
(function () {
  "use strict";

  var STYLE_ID = "ko-cheatsheet-style";
  var EMBED_CLASS = "ko-cs-embed";
  var BTN_ATTR = "data-ko-cs-action";
  var FOCUS_ATTR = "data-ko-cs-focus";
  var CLEAR_ATTR = "data-ko-cs-clear";

  /* ------------------------------------------------------------ 当前筛选的知识点
   * 只记一个 node_id；换项目时惰性作废（另一个项目里这个 id 根本不存在）。 */
  var cardFocus = { projectId: "", nodeId: "" };

  /* ------------------------------------------------------------ 全局安全读取
   * state 是 app.js 顶层的 const（全局词法作用域，非 window 属性）。
   * 统一用 typeof 兜底，避免在 app.js 之前加载时报 ReferenceError。 */

  function currentProjectId() {
    try {
      if (typeof state !== "undefined" && state && state.currentProjectId) return state.currentProjectId;
    } catch (e) {}
    return "";
  }

  function nodes() {
    try {
      if (typeof state !== "undefined" && state && Array.isArray(state.nodes)) return state.nodes;
    } catch (e) {}
    return [];
  }

  function findNode(nodeId) {
    var list = nodes();
    for (var i = 0; i < list.length; i++) if (list[i].node_id === nodeId) return list[i];
    return null;
  }

  function esc(v) {
    try { if (typeof escapeHtml === "function") return escapeHtml(v); } catch (e) {}
    return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function attr(v) {
    try { if (typeof escapeAttr === "function") return escapeAttr(v); } catch (e) {}
    return esc(v);
  }

  function statusText(node) {
    try { if (typeof statusLabel === "function") return statusLabel(node); } catch (e) {}
    return "";
  }

  function statusClass(node) {
    try { if (typeof frameworkStatusClass === "function") return frameworkStatusClass(node); } catch (e) {}
    return "s-unknown";
  }

  function buildTree() {
    try { if (typeof buildFrameworkTree === "function") return buildFrameworkTree(); } catch (e) {}
    return null;
  }

  /* ------------------------------------------------------------ 样式注入 */

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      "." + EMBED_CLASS + " {",
      "  margin: 0 0 14px; border: 1px solid var(--line); border-radius: 10px;",
      "  background: var(--panel); overflow: hidden;",
      "}",
      "." + EMBED_CLASS + " > summary {",
      "  list-style: none; cursor: pointer; user-select: none;",
      "  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;",
      "  padding: 10px 14px;",
      "}",
      "." + EMBED_CLASS + " > summary::-webkit-details-marker { display: none; }",
      "." + EMBED_CLASS + " > summary::before {",
      "  content: \"▸\"; color: var(--muted); font-size: calc(12px * var(--font-scale, 1));",
      "  transition: transform .15s ease;",
      "}",
      "." + EMBED_CLASS + "[open] > summary::before { transform: rotate(90deg); }",
      ".ko-cs-embed-title { font-weight: 600; font-size: calc(14px * var(--font-scale, 1)); color: var(--ink); }",
      ".ko-cs-count { font-size: calc(11.5px * var(--font-scale, 1)); color: var(--muted); }",
      ".ko-cs-hint { font-size: calc(11.5px * var(--font-scale, 1)); color: var(--muted); margin-left: auto; }",
      ".ko-cs-body { padding: 10px 12px 12px; max-height: 320px; overflow-y: auto; border-top: 1px solid var(--line); }",
      ".ko-cs-search { width: 100%; box-sizing: border-box; padding: 7px 10px; margin-bottom: 8px;",
      "  border: 1px solid var(--line); border-radius: 8px; background: var(--background); color: var(--ink);",
      "  font-size: calc(13px * var(--font-scale, 1)); }",
      ".ko-cs-search:focus { outline: none; border-color: var(--green); }",
      /* 知识点行：整行可点＝「只看这个知识点的卡片」 */
      ".ko-cs-row {",
      "  display: flex; align-items: center; gap: 8px;",
      "  padding-top: 8px; padding-bottom: 8px; padding-right: 10px;",
      "  border: 1px solid var(--line); border-radius: 8px; margin-bottom: 6px;",
      "  flex-wrap: wrap; background: var(--background); cursor: pointer;",
      "}",
      ".ko-cs-row:hover { border-color: var(--green); }",
      ".ko-cs-row.is-focus { border-color: var(--green); background: var(--green-soft); }",
      ".ko-cs-row.is-focus .ko-cs-name { color: var(--green-dark); }",
      ".ko-cs-status { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }",
      ".ko-cs-status.s-mastered { background: var(--green); }",
      ".ko-cs-status.s-learning { background: var(--gold, #d4a843); }",
      ".ko-cs-status.s-missing { background: var(--red); }",
      ".ko-cs-status.s-unknown { background: var(--muted); }",
      ".ko-cs-name { flex: 1 1 auto; min-width: 0; font-size: calc(13.5px * var(--font-scale, 1));",
      "  font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      ".ko-cs-meta { flex: 0 0 auto; font-size: calc(11px * var(--font-scale, 1)); color: var(--muted); }",
      ".ko-cs-score { flex: 0 0 auto; font-size: calc(11.5px * var(--font-scale, 1)); color: var(--green-dark); font-weight: 600; }",
      ".ko-cs-actions { flex: 0 0 auto; display: flex; gap: 6px; }",
      ".ko-cs-btn {",
      "  border: 1px solid var(--line); border-radius: 7px;",
      "  padding: 4px 9px; font-size: calc(12px * var(--font-scale, 1));",
      "  cursor: pointer; line-height: 1.2;",
      "  background: var(--panel); color: var(--ink);",
      "}",
      ".ko-cs-btn:hover { border-color: var(--green); color: var(--green-dark); }",
      ".ko-cs-btn:disabled { opacity: .5; cursor: default; }",
      ".ko-cs-btn-card { background: var(--green-soft); border-color: transparent; color: var(--green-dark); }",
      ".ko-cs-btn-card:hover { background: var(--green); color: #0e1410; }",
      /* 「＋文档」：有文档时按钮变成实心，一眼看出哪些知识点写过了 */
      ".ko-cs-btn-doc { background: var(--panel); border-color: var(--line); color: var(--muted); }",
      ".ko-cs-btn-doc:hover { border-color: var(--green); color: var(--green-dark); }",
      ".ko-cs-row[data-has-doc] .ko-cs-btn-doc {",
      "  background: var(--green-soft); border-color: transparent; color: var(--green-dark); font-weight: 600;",
      "}",
      ".ko-cs-row[data-has-doc] .ko-cs-btn-doc:hover { background: var(--green); color: #0e1410; }",
      /* 顶部「一键生成整份」与进度徽章 */
      ".ko-cs-bulk {",
      "  border: 1px solid var(--line); border-radius: 7px; padding: 4px 10px;",
      "  font-size: calc(12px * var(--font-scale, 1)); cursor: pointer; line-height: 1.2;",
      "  background: var(--panel); color: var(--ink);",
      "}",
      ".ko-cs-bulk:hover { border-color: var(--green); color: var(--green-dark); }",
      /* 筛选条：卡片网格正上方，告诉用户现在只看哪个知识点、怎么回去 */
      ".ko-cs-focus {",
      "  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;",
      "  margin: 0 0 10px; padding: 7px 10px;",
      "  border: 1px solid var(--green); border-radius: 8px; background: var(--green-soft);",
      "  font-size: calc(12.5px * var(--font-scale, 1)); color: var(--ink);",
      "}",
      ".ko-cs-focus b { color: var(--green-dark); }",
      ".ko-cs-focus-count { color: var(--muted); font-size: calc(11.5px * var(--font-scale, 1)); }",
      ".ko-cs-focus-clear {",
      "  margin-left: auto; border: 1px solid var(--line); border-radius: 7px; padding: 3px 9px;",
      "  font-size: calc(12px * var(--font-scale, 1)); cursor: pointer; line-height: 1.2;",
      "  background: var(--panel); color: var(--ink);",
      "}",
      ".ko-cs-focus-clear:hover { border-color: var(--green); color: var(--green-dark); }",
      ".ko-cs-doc-count { font-size: calc(11.5px * var(--font-scale, 1)); color: var(--muted); }",
      ".ko-cs-doc-count.is-on { color: var(--green-dark); }",
      /* 空态 */
      ".ko-cs-empty { padding: 16px 8px; text-align: center; color: var(--muted); font-size: calc(12.5px * var(--font-scale, 1)); }",
    ].join("\n");
    var node = document.createElement("style");
    node.id = STYLE_ID;
    node.textContent = css;
    document.head.appendChild(node);
  }

  /* ------------------------------------------------------------ 渲染 */

  function rowHtml(node, depth) {
    var score = Math.round((Number(node.mastery_score) || 0) * 100);
    var indent = Math.min(depth, 8);
    var name = node.name || "";
    var tip = name + " · " + statusText(node) + " · 掌握度 " + score + "% · 点这行：下面只留它的卡片";
    return (
      '<div class="ko-cs-row" data-node-id="' + attr(node.node_id) + '" data-name="' + attr(name) + '" style="padding-left:' + (10 + indent * 16) + 'px">' +
      '<span class="ko-cs-status ' + statusClass(node) + '" aria-hidden="true"></span>' +
      '<span class="ko-cs-name" title="' + attr(tip) + '">' + esc(name) + "</span>" +
      '<span class="ko-cs-meta">' + esc(statusText(node)) + "</span>" +
      '<span class="ko-cs-score">' + score + "%</span>" +
      '<span class="ko-cs-actions">' +
      '<button class="ko-cs-btn ko-cs-btn-card" type="button" data-ko-cs-action="card" data-node-id="' + attr(node.node_id) + '" title="为「' + attr(name) + '」生成知识卡片">＋卡片</button>' +
      '<button class="ko-cs-btn ko-cs-btn-quiz" type="button" data-ko-cs-action="quiz" data-node-id="' + attr(node.node_id) + '" title="为「' + attr(name) + '」生成小测验">＋测验</button>' +
      '<button class="ko-cs-btn ko-cs-btn-doc" type="button" data-ko-cs-action="doc" data-node-id="' + attr(node.node_id) + '" title="打开或生成「' + attr(name) + '」的复习用详解">＋文档</button>' +
      "</span></div>"
    );
  }

  function renderBranch(tree, nodeId, depth) {
    var node = tree.byId.get(nodeId);
    if (!node) return "";
    var kids = tree.children.get(nodeId) || [];
    var html = rowHtml(node, depth);
    for (var i = 0; i < kids.length; i++) html += renderBranch(tree, kids[i], depth + 1);
    return html;
  }

  function listHtml() {
    var tree = buildTree();
    if (tree && tree.roots && tree.roots.length) {
      var html = "";
      for (var i = 0; i < tree.roots.length; i++) html += renderBranch(tree, tree.roots[i], 0);
      return html;
    }
    // 兜底：拿不到树（如 buildFrameworkTree 不可用）就平铺
    var list = nodes();
    var rows = "";
    for (var j = 0; j < list.length; j++) rows += rowHtml(list[j], 0);
    return rows;
  }

  function embedHtml(total) {
    var body = total > 0
      ? '<input class="ko-cs-search" type="search" placeholder="筛选知识点…" aria-label="筛选知识点">' +
        '<div class="ko-cs-list">' + listHtml() + "</div>"
      : '<div class="ko-cs-empty">暂无知识点，先上传资料生成知识框架。</div>';
    return (
      '<details class="' + EMBED_CLASS + '">' +
      "<summary>" +
      '<span class="ko-cs-embed-title">速查表</span>' +
      '<span class="ko-cs-count">' + total + " 个知识点</span>" +
      '<span class="ko-cs-doc-count"></span>' +
      '<span class="ko-cs-hint">点行只看它的卡片 · ＋卡片 / ＋测验 / ＋文档</span>' +
      '<button type="button" class="ko-cs-bulk" data-ko-cs-action="bulk" ' +
      'title="逐个生成还没写过的知识点文档，再合订成一份带目录的长文。一次只讲一个知识点，所以会花点时间；随时可以停止。">' +
      "一键生成整份文档</button>" +
      "</summary>" +
      '<div class="ko-cs-body">' + body + "</div>" +
      "</details>"
    );
  }

  function inject() {
    var output = document.getElementById("studio-output");
    if (!output) return;
    if (!currentProjectId() || nodes().length === 0) return;
    if (output.querySelector("." + EMBED_CLASS)) { applyCardFocus(); return; }
    var holder = document.createElement("div");
    holder.innerHTML = embedHtml(nodes().length);
    var first = holder.firstChild;
    if (first) output.insertBefore(first, output.firstChild);
    bindSearch();
    // 标出哪些知识点已经有文档（异步、失败不打扰用户）
    syncDocStatus();
    applyCardFocus();
  }

  function bindSearch() {
    var embed = document.querySelector("." + EMBED_CLASS);
    if (!embed) return;
    var input = embed.querySelector(".ko-cs-search");
    if (!input) return;
    input.addEventListener("input", function () {
      var q = String(input.value || "").trim().toLowerCase();
      var rows = embed.querySelectorAll(".ko-cs-row");
      for (var i = 0; i < rows.length; i++) {
        var name = String(rows[i].getAttribute("data-name") || "").toLowerCase();
        rows[i].style.display = (!q || name.indexOf(q) >= 0) ? "" : "none";
      }
    });
  }

  /* -------------------------------------------------- 点知识点＝只看它的卡片
   * 只改 DOM：命中的留下并从 1 重新编号，没命中的 display:none。
   * state.cards 不动，所以翻面 / 自测 / 放大沉浸仍按原来的 data-card-index 找卡。 */

  function currentCards() {
    try {
      if (typeof state !== "undefined" && state && Array.isArray(state.cards)) return state.cards;
    } catch (e) {}
    return [];
  }

  /** 选中节点 + 它下面所有子孙：点父节点，整支都算它的卡片。 */
  function focusScope() {
    var nodeId = cardFocus.nodeId;
    if (!nodeId) return null;
    var scope = new Set([nodeId]);
    var tree = buildTree();
    if (!tree || !tree.children) return scope;
    var stack = [nodeId];
    while (stack.length) {
      var current = stack.pop();
      var kids = tree.children.get(current) || [];
      for (var i = 0; i < kids.length; i++) {
        if (!scope.has(kids[i])) { scope.add(kids[i]); stack.push(kids[i]); }
      }
    }
    return scope;
  }

  function cardInScope(card, scope) {
    var ids = card && Array.isArray(card.node_ids) ? card.node_ids : [];
    for (var i = 0; i < ids.length; i++) if (scope.has(ids[i])) return true;
    return false;
  }

  function cardNumberEl(article) {
    return article.querySelector(".card-number");
  }

  /** 还原成 renderCard 给的原始编号（它按 data-card-index 算，改回去就复原）。 */
  function resetCardNumbers(articles) {
    for (var i = 0; i < articles.length; i++) {
      var num = cardNumberEl(articles[i]);
      var index = Number(articles[i].getAttribute("data-card-index"));
      if (num && isFinite(index)) num.textContent = String(index + 1);
    }
  }

  function focusBarHtml(name, shown, total) {
    var countText = shown > 0
      ? shown + " / " + total + " 张卡片"
      : "这个知识点还没有卡片，点这行的「＋卡片」生成";
    return (
      '<div class="ko-cs-focus" ' + FOCUS_ATTR + '>' +
      "<span>只看 <b>" + esc(name) + "</b></span>" +
      '<span class="ko-cs-focus-count">' + esc(countText) + "</span>" +
      '<button type="button" class="ko-cs-focus-clear" ' + CLEAR_ATTR +
      ' title="取消筛选，重新显示全部卡片">看全部</button>' +
      "</div>"
    );
  }

  /** 速查表里标出当前筛的是哪一行。 */
  function paintRowFocus() {
    var embed = document.querySelector("." + EMBED_CLASS);
    if (!embed) return;
    var rows = embed.querySelectorAll(".ko-cs-row");
    for (var i = 0; i < rows.length; i++) {
      var on = Boolean(cardFocus.nodeId) && rows[i].getAttribute("data-node-id") === cardFocus.nodeId;
      rows[i].classList.toggle("is-focus", on);
    }
  }

  function applyCardFocus() {
    // 换项目就丢掉上次的筛选：那个 node_id 在新项目里不存在
    if (cardFocus.nodeId && cardFocus.projectId !== currentProjectId()) {
      cardFocus.nodeId = "";
      cardFocus.projectId = "";
    }
    paintRowFocus();
    var output = document.getElementById("studio-output");
    if (!output) return;
    var oldBar = output.querySelector("[" + FOCUS_ATTR + "]");
    if (oldBar) oldBar.remove();
    var grid = output.querySelector(".cards-grid");
    if (!grid) return;
    var articles = grid.querySelectorAll("article.card");
    // 先全体复原（上一轮筛掉的、编号乱的），再按当前筛选重排
    for (var i = 0; i < articles.length; i++) articles[i].style.display = "";
    resetCardNumbers(articles);
    var scope = focusScope();
    if (!scope) return;
    var cards = currentCards();
    var byId = {};
    cards.forEach(function (card) { byId[card.card_id] = card; });
    var shown = 0;
    articles.forEach(function (article) {
      if (!cardInScope(byId[article.getAttribute("data-origin-id")], scope)) {
        article.style.display = "none";
        return;
      }
      article.style.display = "";
      var num = cardNumberEl(article);
      if (num) num.textContent = String(++shown);
    });
    var node = findNode(cardFocus.nodeId);
    var bar = document.createElement("div");
    bar.innerHTML = focusBarHtml(node ? node.name : "这个知识点", shown, cards.length);
    if (bar.firstChild) grid.parentNode.insertBefore(bar.firstChild, grid);
  }

  function clearCardFocus() {
    if (!cardFocus.nodeId) return;
    cardFocus.nodeId = "";
    cardFocus.projectId = "";
    applyCardFocus();
  }

  function toggleCardFocus(nodeId) {
    if (!nodeId || !findNode(nodeId)) return;
    // 速查表也挂在「小测验」顶上，但那边没按知识点筛题这回事，别让人以为筛过了
    try {
      if (typeof state !== "undefined" && state && state.feature && state.feature !== "cards") {
        if (typeof showToast === "function") {
          showToast("「小测验」暂不支持按知识点筛选，请到「知识卡片」里点这个知识点。", { variant: "notice" });
        }
        return;
      }
    } catch (e) {}
    var projectId = currentProjectId();
    cardFocus.nodeId = cardFocus.nodeId === nodeId ? "" : nodeId;
    cardFocus.projectId = cardFocus.nodeId ? projectId : "";
    applyCardFocus();
  }

  /* ------------------------------------------------- 知识点文档的接入点
   * 速查表本身**不生成**文档 —— 那是 static/knowledge-doc-ui.js 的事。
   * 这里只做两件小事：标出哪些知识点已经写过文档；把两个入口转过去。 */

  var docStatusCache = { projectId: "", have: null, total: 0, compiled: false };

  function docBridge() {
    return (typeof window !== "undefined" && window.KnowOriginKnowledgeDoc) || null;
  }

  function bridgeMissing() {
    try {
      if (typeof showToast === "function") { showToast("文档功能还没就绪：static/knowledge-doc-ui.js 没有加载。", { variant: "notice" }); return; }
    } catch (e) {}
  }

  function paintDocStatus() {
    var embed = document.querySelector("." + EMBED_CLASS);
    if (!embed || !docStatusCache.have) return;
    var rows = embed.querySelectorAll(".ko-cs-row[data-node-id]");
    var count = 0;
    for (var i = 0; i < rows.length; i++) {
      var nodeId = rows[i].getAttribute("data-node-id");
      if (docStatusCache.have[nodeId]) {
        count += 1;
        rows[i].setAttribute("data-has-doc", "1");
      } else {
        rows[i].removeAttribute("data-has-doc");
      }
    }
    var badge = embed.querySelector(".ko-cs-doc-count");
    if (badge) {
      badge.textContent = "文档 " + count + "/" + docStatusCache.total;
      badge.classList.toggle("is-on", Boolean(docStatusCache.compiled));
    }
  }

  async function syncDocStatus() {
    var projectId = currentProjectId();
    if (!projectId) return;
    if (docStatusCache.projectId !== projectId) {
      docStatusCache = { projectId: projectId, have: null, total: 0, compiled: false };
    }
    if (docStatusCache.have) { paintDocStatus(); return; }
    try {
      var data = await api("/api/projects/" + encodeURIComponent(projectId) + "/knowledge-doc");
      if (currentProjectId() !== projectId) return; // 用户已经切走了，静默丢弃
      var have = {};
      (data.items || []).forEach(function (item) { if (item.has_doc) have[item.node_id] = 1; });
      docStatusCache.have = have;
      docStatusCache.total = data.total || 0;
      docStatusCache.compiled = Boolean(data.compiled);
      paintDocStatus();
    } catch (error) {
      // 状态只是锦上添花，拉不到就不标 —— 按钮照样能用
    }
  }

  function openDocFor(button) {
    var nodeId = button.getAttribute("data-node-id");
    if (!nodeId) return;
    var bridge = docBridge();
    if (!bridge) { bridgeMissing(); return; }
    var node = findNode(nodeId);
    bridge.openOrGenerate(nodeId, node ? node.name : "");
  }

  function startBulk() {
    var bridge = docBridge();
    if (!bridge) { bridgeMissing(); return; }
    bridge.startBatch();
    // 批量跑完后数字会变；让下次展开重新拉一次状态
    setTimeout(function () { docStatusCache.have = null; }, 60000);
  }

  /* ------------------------------------------------------------ 生成卡片 / 测验 */

  async function generateForNode(kind, nodeId, button) {
    var projectId = currentProjectId();
    var node = findNode(nodeId);
    if (!node || !projectId || button.disabled) return;
    var originalText = button.textContent;
    button.disabled = true;
    button.textContent = "生成中…";
    var restore = function () {
      button.disabled = false;
      button.textContent = originalText;
    };
    try {
      if (kind === "card") {
        var cardData = await api(
          "/api/projects/" + encodeURIComponent(projectId) + "/nodes/" + encodeURIComponent(nodeId) + "/card",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ difficulty: 2, count: 3 }),
          }
        );
        if (currentProjectId() !== projectId) return; // 已切项目，静默丢弃
        var cards = cardData.cards || [];
        var known = new Set((state.cards || []).map(function (c) { return c.card_id; }));
        state.cards = state.cards.concat(cards.filter(function (c) { return !known.has(c.card_id); }));
        showToast("已为「" + node.name + "」生成 " + cards.length + " 张知识卡片", { variant: "notice" });
        if (typeof switchFeature === "function") switchFeature("cards");
      } else {
        var quizData = await api(
          "/api/projects/" + encodeURIComponent(projectId) + "/nodes/" + encodeURIComponent(nodeId) + "/quiz",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ difficulty: 2, question_count: 5, question_types: ["single_choice", "multiple_choice", "fill_blank", "short_answer"] }),
          }
        );
        if (currentProjectId() !== projectId) return; // 已切项目，静默丢弃
        state.quiz = quizData;
        state.quizHistory = null;
        var qn = (quizData.questions || []).length;
        showToast("已为「" + node.name + "」生成 " + qn + " 题小测验", { variant: "notice" });
        if (typeof switchFeature === "function") switchFeature("quiz");
      }
    } catch (error) {
      if (currentProjectId() !== projectId) return; // 已切项目，静默忽略
      restore();
      showError(error, function () { generateForNode(kind, nodeId, button); });
      return;
    }
    restore();
  }

  /* ------------------------------------------------------------ 包裹渲染函数 */

  function wrapRender() {
    var origCards = window.renderCards;
    var origQuiz = window.renderQuiz;
    if (typeof origCards === "function") {
      window.renderCards = function () {
        origCards();
        inject();
      };
    }
    if (typeof origQuiz === "function") {
      window.renderQuiz = function () {
        origQuiz();
        inject();
      };
    }
  }

  /* ------------------------------------------------------------ 事件 */

  function onClick(event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var action = target.closest("[" + BTN_ATTR + "]");
    if (action) {
      // summary 里的按钮必须在这里拦下：不拦的话，click 的默认动作会把 <details> 折叠起来
      event.preventDefault();
      event.stopPropagation();
      var kind = action.getAttribute(BTN_ATTR);
      if (kind === "doc") { openDocFor(action); return; }
      if (kind === "bulk") { startBulk(); return; }
      generateForNode(kind, action.getAttribute("data-node-id"), action);
      return;
    }
    if (target.closest("[" + CLEAR_ATTR + "]")) { clearCardFocus(); return; }
    // 点行本身＝只看这个知识点的卡片；行里的按钮、输入框不算（上面已各自处理）
    var row = target.closest(".ko-cs-row");
    if (!row || !row.closest("." + EMBED_CLASS)) return;
    if (target.closest("button, input, select, textarea, a, label")) return;
    toggleCardFocus(row.getAttribute("data-node-id"));
  }

  function boot() {
    ensureStyle();
    wrapRender();
    document.addEventListener("click", onClick, false);
    // 初次加载若已停在卡片/测验页，直接补注入一次（不触发完整重渲染）
    inject();
  }

  // 关键：等 DOMContentLoaded 再包裹。app.js 顶层的 renderCards / renderQuiz 在 app.js
  // 执行时已就绪（defer 脚本按序执行，本脚本排在 app.js 之后），此时包裹即可拦截
  // 后续所有 renderCards / renderQuiz 调用，包括首次渲染。
  document.addEventListener("DOMContentLoaded", boot);
})();
