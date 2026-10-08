/* 读书（Reading）—— 独立前端模块。
 *
 * 能力由本文件提供（window.KnowOriginReading），那一行 <script> 删掉即完整回退。
 * 与 agent-shell.js 的接线只有一处：侧栏 rail 的 data-agent-module="reading"。
 *
 * 三块视图：
 *   书架 —— 封面墙，按一级领域分组（加入书架只存元数据，真要放资料时才按需建项目）
 *   搜索 —— 跨书源搜书（古腾堡 / 维基文库 / Open Library / Google Books …）
 *   收获 —— 生成《读书收获》，自测题会自动沉淀为该书项目的知识卡片
 *
 * 正文渲染优先复用 app.js 的 renderStudyReportMarkdown；拿不到时退到本文件自带的
 * 极简渲染器（读书收获的 Markdown 结构很固定，不需要完整实现）。
 */
(function () {
  "use strict";

  var root = null;
  var VIEW = { tab: "shelf", bookKey: "", book: null, digest: null, searchHits: [] };
  var PREF_KEY = "knoworigin.reading.tab";

  // ---------- 小工具（与 study-doc-ui.js 同一套兜底策略） ----------

  function esc(value) {
    try { if (typeof window.escapeHtml === "function") return window.escapeHtml(value); } catch (e) { /* 继续兜底 */ }
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function toast(msg, variant) {
    try {
      if (typeof window.showToast === "function") { window.showToast(msg, { variant: variant || "info" }); return; }
    } catch (e) { /* 继续兜底 */ }
    if (variant === "error") console.warn("[reading]", msg);
  }

  // ⚠️ window.api 就是 `fetch(path, {credentials, ...options})` 的薄封装 ——
  // 它要的是 **fetch 原生选项**，不是「body 传对象、我帮你序列化」那种便利封装。
  // 所以带请求体的调用**必须**走下面的 postJson：自己加 Content-Type、自己 stringify。
  // 直接写 `api(path, {method:"POST", body:{...}})` 会发出去一个没有 Content-Type、
  // body 是 `[object Object]` 的畸形请求，后端回 422/400 —— 表现就是「按钮点了没反应」。
  function api(path, options) {
    if (typeof window.api === "function") return window.api(path, options);
    var init = Object.assign({ credentials: "same-origin" }, options || {});
    return fetch(path, init).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var detail = (data && (data.detail && (data.detail.message || data.detail) || data.message)) || ("HTTP " + res.status);
          throw new Error(typeof detail === "string" ? detail : ("HTTP " + res.status));
        }
        return data;
      });
    });
  }

  // 带 JSON 请求体的调用统一走这里。
  function postJson(path, payload, method) {
    return api(path, {
      method: method || "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
  }

  // ---------- 极简 Markdown（仅在拿不到 app.js 渲染器时使用） ----------

  function inline(text) {
    return esc(text)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  }

  function fallbackMarkdown(md) {
    var lines = String(md || "").split(/\r?\n/);
    var out = [], list = null, quote = [];
    function flushList() { if (list) { out.push("<" + list.tag + ">" + list.items.join("") + "</" + list.tag + ">"); list = null; } }
    function flushQuote() {
      if (quote.length) { out.push("<blockquote>" + quote.map(inline).join("<br>") + "</blockquote>"); quote = []; }
    }
    lines.forEach(function (line) {
      var t = line.trim();
      if (!t) { flushList(); flushQuote(); return; }
      if (t.indexOf("> ") === 0) { quote.push(t.slice(2)); return; }
      flushQuote();
      var h = /^(#{1,6})\s+(.*)$/.exec(t);
      if (h) { flushList(); var lv = Math.min(h[1].length + 1, 4); out.push("<h" + lv + ">" + inline(h[2]) + "</h" + lv + ">"); return; }
      var cb = /^[-*]\s+\[( |x)\]\s+(.*)$/.exec(t);
      if (cb) {
        if (!list || list.tag !== "ul") { flushList(); list = { tag: "ul", items: [] }; }
        list.items.push('<li style="list-style:none;margin-left:-1em">' + (cb[1] === "x" ? "☑ " : "☐ ") + inline(cb[2]) + "</li>");
        return;
      }
      var ul = /^[-*]\s+(.*)$/.exec(t);
      if (ul) { if (!list || list.tag !== "ul") { flushList(); list = { tag: "ul", items: [] }; } list.items.push("<li>" + inline(ul[1]) + "</li>"); return; }
      var ol = /^\d+\.\s+(.*)$/.exec(t);
      if (ol) { if (!list || list.tag !== "ol") { flushList(); list = { tag: "ol", items: [] }; } list.items.push("<li>" + inline(ol[1]) + "</li>"); return; }
      flushList();
      out.push("<p>" + inline(t) + "</p>");
    });
    flushList(); flushQuote();
    return out.join("");
  }

  function renderMarkdown(md) {
    try {
      if (typeof window.renderStudyReportMarkdown === "function") {
        var html = window.renderStudyReportMarkdown(md);
        if (html) return html;
      }
    } catch (e) { /* 退到自带渲染器 */ }
    return fallbackMarkdown(md);
  }

  // ---------- 视图切换 ----------

  function enter() {
    if (!root) return;
    root.classList.remove("hidden");
    root.classList.add("is-open");
    var workspace = document.getElementById("workspace");
    if (workspace) workspace.classList.add("hidden");
    setTab(VIEW.tab || "shelf");
    if (VIEW.tab === "shelf") loadShelf();
  }

  function exit() {
    if (!root) return;
    closeAsk();
    hideSelBar();
    root.classList.add("hidden");
    root.classList.remove("is-open");
    var workspace = document.getElementById("workspace");
    if (workspace) workspace.classList.remove("hidden");
  }

  function isVisible() { return !!root && !root.classList.contains("hidden"); }

  // ---------- 阅读字号 ----------
  //
  // 一个倍率管全篇：正文、精华阅读的高亮片段、编辑态 textarea 都跟着它走。
  // 分三处各调各的，正是「字号不可调」最烦人的地方。

  var SCALE_KEY = "knoworigin.reading.scale";

  function applyScale(value) {
    var scale = parseFloat(value);
    if (!isFinite(scale) || scale <= 0) scale = 1;
    VIEW.scale = scale;
    if (root) root.style.setProperty("--rd-scale", String(scale));
    var buttons = root ? root.querySelectorAll("[data-rd-scale]") : [];
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].classList.toggle("is-on", Math.abs(parseFloat(buttons[i].dataset.rdScale) - scale) < 0.001);
    }
    try { window.localStorage.setItem(SCALE_KEY, String(scale)); } catch (e) { /* 隐私模式忽略 */ }
  }

  function readScale() {
    try {
      var raw = window.localStorage.getItem(SCALE_KEY);
      if (raw) return parseFloat(raw);
    } catch (e) { /* 忽略 */ }
    return 1;
  }

  function setTab(tab) {
    VIEW.tab = (tab === "digest" || tab === "net") ? tab : "shelf";
    hideSelBar();   // 换页签后选区已经不在了，工具条留着就是个悬空的按钮
    try { window.localStorage.setItem(PREF_KEY, VIEW.tab); } catch (e) { /* 隐私模式写不进去不影响本次会话 */ }
    var panes = root.querySelectorAll("[data-rd-pane]");
    for (var i = 0; i < panes.length; i += 1) {
      panes[i].classList.toggle("is-on", panes[i].dataset.rdPane === VIEW.tab);
    }
    var tabs = root.querySelectorAll("[data-rd-tab]");
    for (var j = 0; j < tabs.length; j += 1) {
      tabs[j].classList.toggle("is-on", tabs[j].dataset.rdTab === VIEW.tab);
    }
    if (VIEW.tab === "shelf") loadShelf();
    if (VIEW.tab === "net") loadNet();
  }

  // ---------- 书架 ----------

  function loading(el, text) { el.innerHTML = '<div class="rd-loading">' + esc(text || "正在读取…") + "</div>"; }

  function empty(el, title, desc) {
    el.innerHTML = '<div class="rd-empty"><b>' + esc(title) + "</b>" + esc(desc || "") + "</div>";
  }

  function loadShelf() {
    var host = root.querySelector("[data-rd-shelf]");
    if (!host) return;
    loading(host, "正在读取书架…");
    api("/api/reading/books").then(function (data) {
      renderShelf(host, data || {});
    }).catch(function (err) {
      empty(host, "书架读取失败", err && err.message ? err.message : "");
    });
  }

  function renderShelf(host, data) {
    var books = data.books || [];
    var summary = data.summary || {};
    var html = "";

    html += '<div class="rd-head"><h2>我的书架</h2>'
      + '<p>每加入一本书，知源会自动为它建一个项目 —— 于是它直接继承知识框架、卡片、测验与掌握度。</p>'
      + '<div class="rd-stats">'
      + stat(summary.total || 0, "在架")
      + stat(summary.reading || 0, "在读")
      + stat(summary.finished || 0, "读完")
      + stat(summary.fulltext || 0, "可读全文")
      + "</div>"
      + '<div class="rd-searchbar" style="margin-top:18px">'
      + '<input type="password" autocomplete="off" placeholder="微信读书 API Key（wrk- 开头，只存本机加密）" data-rd-wkey>'
      + '<button class="rd-ghost" type="button" data-rd-wsave>保存 Key</button>'
      + '<button class="rd-solid" type="button" data-rd-wsync>同步书架</button>'
      + "</div>"
      + '<p class="rd-src-note" data-rd-wstatus></p>'
      // 找书：**搜索放最前**，因为它是用户第一个会试的动作。
      // 豆瓣是国内网络唯一稳定可达的中文书目源，所以它是默认且主力的那条；
      // 古腾堡等海外公版书源国内常常连不上 —— 连不上时如实说出来（见 renderHits），
      // 不把网络故障伪装成「没搜到」。
      + '<div class="rd-searchbar" style="margin-top:14px">'
      + '<input type="search" placeholder="搜书：书名或作者（中文书目走豆瓣）" data-rd-query>'
      + '<button class="rd-solid" type="button" data-rd-search>搜书</button>'
      + '<button class="rd-ghost" type="button" data-rd-import>导入本地书（EPUB / PDF / TXT）</button>'
      + '<button class="rd-ghost" type="button" data-rd-recommend>为你推荐</button>'
      + '<button class="rd-ghost" type="button" data-rd-batchdigest '
      + 'title="给所有还没有收获的书批量生成 —— 知识网络的节点就来自这些收获">一键补全收获</button>'
      + '<input type="file" class="hidden" data-rd-file '
      + 'accept=".epub,.pdf,.txt,.md,.mobi,.azw3,.djvu">'
      + "</div>"
      // 这句说的是**实测事实**（2026-10-07 本机直连）：中文书目走豆瓣，
      // 英文公版全文只有 Standard Ebooks 能直连取到；其余海外源要配代理。
      // 早先这里只写「搜索走豆瓣」，把当时唯一能取全文的源漏掉了。
      + '<p class="rd-src-note">中文书目走豆瓣；英文公版书走 Standard Ebooks'
      + "（可**直接取回整本正文**）。古腾堡 / Internet Archive / 维基文库 / Open Library / "
      + "Google Books 需要代理，没配代理时会如实标出「已跳过」，不会假装「没搜到」。</p>"
      + '<div data-rd-hits></div>'
      + '<div data-rd-discover></div>'
      + "</div>";

    if (!books.length) {
      html += '<div class="rd-empty" style="padding:40px 0"><b>书架还是空的</b>'
        + "上面搜一本公版书试试，或从微信读书同步书架（需要 API Key）。</div>";
    } else {
      (data.groups || []).forEach(function (group) {
        html += '<div class="rd-group"><div class="rd-group-head"><h3>' + esc(group.category)
          + "</h3><span>" + group.count + " 本</span></div><div class=\"rd-grid\">";
        (group.books || []).forEach(function (book) { html += bookCard(book); });
        html += "</div></div>";
      });
    }

    host.innerHTML = html;
    loadWereadStatus();
  }

  // ---------- 微信读书同步 ----------

  function loadWereadStatus() {
    var line = root.querySelector("[data-rd-wstatus]");
    var input = root.querySelector("[data-rd-wkey]");
    if (!line) return;
    line.textContent = "正在检查微信读书连接…";
    api("/api/reading/weread/status").then(function (data) {
      var configured = !!(data && data.configured);
      if (input) input.classList.toggle("hidden", configured);
      line.textContent = configured
        ? "微信读书已连接（来源：" + (data.origin === "env" ? "环境变量" : "本机加密配置") + "）。"
          + "同步只拉书架、封面、进度与你的划线 —— 整本正文微信读书不提供，需用公版书源或本地导入。"
        : "微信读书未连接。填入 wrk- 开头的 API Key 后即可同步书架（Key 经 DPAPI 加密只存本机，不进仓库）。";
    }).catch(function () { line.textContent = ""; });
  }

  function saveWereadKey() {
    var input = root.querySelector("[data-rd-wkey]");
    var value = input ? input.value.trim() : "";
    if (!value) { toast("先填入 API Key。", "error"); return; }
    postJson("/api/reading/weread/key", { api_key: value }, "PUT")
      .then(function () {
        if (input) { input.value = ""; }
        toast("已保存。Key 只存本机（加密），不会进仓库。", "success");
        loadWereadStatus();
      })
      .catch(function (err) { toast("保存失败：" + ((err && err.message) || ""), "error"); });
  }

  function syncWeread() {
    var line = root.querySelector("[data-rd-wstatus]");
    if (line) line.textContent = "正在同步微信读书书架…";
    postJson("/api/reading/weread/sync", {})
      .then(function (data) {
        var counts = (data && data.counts) || {};
        toast("同步完成：" + ((data && data.synced) || 0) + " 本已入库，"
          + ((data && data.progressed) || 0) + " 本更新了进度。", "success");
        if (line) {
          line.textContent = "书架口径：电子书 " + (counts.books || 0) + " · 有声书 " + (counts.albums || 0)
            + " · 文章收藏 " + (counts.articles || 0) + " · 合计 " + (counts.total || 0)
            + "（有声书不计入书架卡片，它读不了也划不了线）。";
        }
        loadShelf();
      })
      .catch(function (err) {
        toast("同步失败：" + ((err && err.message) || ""), "error");
        loadWereadStatus();
      });
  }

  function stat(value, label) {
    return '<div class="rd-stat"><b>' + esc(value) + "</b><span>" + esc(label) + "</span></div>";
  }

  // 书源中文名。与 core/book_sources.py 的 SOURCES 对齐（那边是权威，这边只用于展示）。
  var SRC_NAMES = {
    weread: "微信读书", gutenberg: "古腾堡", wikisource: "维基文库", ctext: "ctext",
    standardebooks: "Standard Ebooks", archive: "Internet Archive",
    hathitrust: "HathiTrust", openlibrary: "Open Library",
    googlebooks: "Google Books", douban: "豆瓣读书", local: "本地导入",
  };

  // 能在服务端直接变成文本的格式。EPUB/PDF 是打包格式，必须下载后走「导入正文」——
  // 这里要和 core/book_sources.py 的 _FETCHABLE_FORMATS 保持一致。
  var FETCHABLE_FORMATS = { txt: 1, text: 1, html: 1 };

  function canAutoFetch(item) {
    if (!item || !item.has_fulltext) return false;
    var files = item.files || [];
    var hit = files.some(function (f) {
      return f && FETCHABLE_FORMATS[String(f.format || "").toLowerCase()] && f.url;
    });
    if (hit) return true;
    return !!FETCHABLE_FORMATS[String(item.fulltext_format || "").toLowerCase()] && !!item.download_url;
  }

  // 「文件链接」：一本书常同时有 EPUB / AZW3 / 纯文本 / 在线阅读好几个入口。
  // 全列出来才有用 —— 正文拿不到时，一个能立刻打开的入口就是全部价值。
  function fileLinksMarkup(item) {
    var links = (item && item.files) || [];
    var known = {};
    links.forEach(function (f) { if (f && f.url) known[f.url] = 1; });
    var out = links.filter(function (f) { return f && f.url; }).slice(0, 5).map(function (f) {
      return '<a class="rd-file" href="' + esc(f.url) + '" target="_blank" rel="noopener noreferrer">'
        + esc(f.label || f.format || "文件") + "</a>";
    });
    // read_url / borrow_url 常常就是 files 里那条，**不能重复出一颗胶囊**
    //（截图里「借阅（需登录）」和「借阅」并排出现过，就是漏了这个去重）。
    if (item && item.read_url && !known[item.read_url]) {
      out.push('<a class="rd-file" href="' + esc(item.read_url) + '" target="_blank" rel="noopener noreferrer">在线阅读</a>');
    }
    if (item && item.borrow_url && !known[item.borrow_url]) {
      out.push('<a class="rd-file" href="' + esc(item.borrow_url) + '" target="_blank" rel="noopener noreferrer">借阅</a>');
    }
    return out.length ? '<div class="rd-files">' + out.join("") + "</div>" : "";
  }

  function linkListMarkup(links) {
    if (!links || !links.length) return "";
    return '<div class="rd-files">' + links.map(function (l) {
      return '<a class="rd-file" href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer">'
        + esc(l.label || "打开") + (l.note ? '<i>' + esc(l.note) + "</i>" : "") + "</a>";
    }).join("") + "</div>";
  }

  var COVER_COLORS = ["#2E2A44", "#1F3A34", "#3A2418", "#2A3550", "#4A2B24", "#233A44", "#3D3320", "#312A3E", "#2C3B2E", "#3A2830"];

  function coverColor(seed) {
    var text = String(seed || "");
    var sum = 0;
    for (var i = 0; i < text.length; i += 1) sum = (sum * 31 + text.charCodeAt(i)) % 100000;
    return COVER_COLORS[sum % COVER_COLORS.length];
  }

  function bookCard(book) {
    var progress = Math.max(0, Math.min(parseInt(book.progress, 10) || 0, 100));
    var badge = book.has_fulltext
      ? '<span class="rd-badge is-full">全文</span>'
      : '<span class="rd-badge">元数据</span>';
    var img = book.cover
      ? '<img src="' + esc(book.cover) + '" alt="" loading="lazy" onerror="this.remove()">'
      : "";
    var meta = progress >= 100 ? "已读完" : (progress > 0 ? progress + "%" : "未读");
    if (book.source_name) meta += " · " + book.source_name;
    return '<div class="rd-book" data-rd-book="' + esc(book.book_key) + '">'
      + '<div class="rd-cover" style="background:' + coverColor(book.book_key) + '">' + badge + img
      + '<div class="rd-cover-body"><div class="rd-cover-rule"></div>'
      + '<div class="rd-cover-title">' + esc(book.title) + "</div>"
      + '<div class="rd-cover-author">' + esc(book.author || "") + "</div></div></div>"
      + '<div class="rd-bar"><i style="width:' + progress + '%"></i></div>'
      + '<div class="rd-book-meta">' + esc(meta) + "</div></div>";
  }

  // ---------- 搜索 ----------

  function runSearch(query) {
    var hits = root.querySelector("[data-rd-hits]");
    if (!hits) return;
    if (!query) { hits.innerHTML = ""; return; }
    loading(hits, "正在跨书源搜索…");
    postJson("/api/reading/search", { query: query, limit: 6 })
      .then(function (data) {
        VIEW.searchHits = (data && data.results) || [];
        renderHits(hits, data || {}, query);
      })
      .catch(function (err) {
        empty(hits, "搜索失败", (err && err.message) || "");
      });
  }

  function renderHits(host, data, query) {
    var results = data.results || [];
    var summary = data.summary || {};
    var statuses = data.source_status || {};
    var counts = data.sources || {};
    var countText = Object.keys(counts).map(function (k) { return (SRC_NAMES[k] || k) + " " + counts[k]; }).join(" · ");

    var html = '<p class="rd-src-note">「' + esc(query) + "」命中 " + (summary.total || 0)
      + " 本（可读全文 " + (summary.fulltext || 0) + " 本"
      + (summary.with_links ? " · 有文件链接 " + summary.with_links + " 本" : "")
      + "）" + (countText ? " —— " + esc(countText) : "") + "</p>";

    // 需要代理的海外源：国内直连必超时。**必须说出来**，否则用户会把
    // 「线路不通」当成「这个功能没做」—— 这是真实反馈里踩过的坑。
    var blocked = data.blocked_sources || [];
    if (blocked.length) {
      html += '<p class="rd-src-note" style="color:var(--rd-ink-3)">'
        + esc(blocked.map(function (k) { return SRC_NAMES[k] || k; }).join(" / "))
        + " 需要代理才能连上（配好 TJU_PROXY_URL 后重搜即可）。</p>";
    }

    if (!results.length) {
      // 「书源连不上」和「确实没这本书」必须分得开 —— 都显示「没有找到」的话，
      // 用户会把网络故障当成功能没做（真实反馈就是这么来的）。
      if (data.all_failed) {
        // 只列**真的试过并失败**的源。被跳过的（需要代理）已经在上面单独说明，
        // 混进这张失败清单里会把「要配代理」和「网络故障」搅成一团。
        var failed = Object.keys(statuses)
          .filter(function (k) { return statuses[k] && !statuses[k].skipped; })
          .map(function (k) {
            return "<div>· " + esc(SRC_NAMES[k] || k) + "：" + esc(statuses[k].error || "不可达") + "</div>";
          }).join("");
        html += '<div class="rd-empty" style="padding:26px 0"><b>所有书源都没连上</b>'
          + "这不是「没搜到」，是网络到不了这些站点（常见于需要代理的网络环境）。"
          + '<div style="margin-top:12px;text-align:left;display:inline-block;font-size:12.5px;line-height:1.9">'
          + failed + "</div></div>";
      } else {
        html += '<div class="rd-empty" style="padding:26px 0"><b>没有找到</b>换个关键词试试。</div>';
      }
      host.innerHTML = html;
      return;
    }

    results.forEach(function (item, index) {
      var cover = item.cover ? '<img src="' + esc(item.cover) + '" alt="" loading="lazy" onerror="this.remove()">' : "";
      var fetchBtn = canAutoFetch(item)
        ? '<button class="rd-solid" type="button" data-rd-hitfetch="' + index + '">取正文</button>'
        : "";
      html += '<div class="rd-hit">'
        + '<div class="rd-hit-cover" style="background:' + coverColor(item.title) + '">' + cover + "</div>"
        + '<div class="rd-hit-main"><h4>' + esc(item.title) + "</h4>"
        + "<p>" + esc(item.author || "未知作者") + (item.year ? " · " + esc(item.year) : "") + "</p>"
        + '<div class="rd-hit-src">' + esc(item.source_name || item.source)
        + (item.has_fulltext ? " · 可读全文（" + esc(item.fulltext_format || "") + "）" : " · 仅元数据")
        + " · " + esc(item.rights || "") + "</div>"
        + fileLinksMarkup(item)
        + '<div data-rd-hitlinks="' + index + '"></div>'
        + "</div>"
        + '<div class="rd-hit-act">' + fetchBtn
        + '<button class="rd-ghost" type="button" data-rd-hitlinksbtn="' + index + '">找链接</button>'
        + '<button class="rd-ghost" type="button" data-rd-add="' + index + '">加入书架</button></div>'
        + "</div>";
    });
    host.innerHTML = html;
  }

  function addBook(index) {
    var record = VIEW.searchHits[index];
    if (record) addBookRecord(record);
  }

  // ---------- 收获 ----------

  function openBook(bookKey) {
    VIEW.bookKey = bookKey;
    resetAsk();     // 换书就换讨论：上一本选的那段不该留在新书的抽屉里
    setTab("digest");
    var host = root.querySelector("[data-rd-digest]");
    if (!host) return;
    loading(host, "正在读取这本书…");
    // 收获与「精华阅读」并行取：精华阅读拿不到不影响收获照常显示。
    Promise.all([
      api("/api/reading/books/" + encodeURIComponent(bookKey)),
      api("/api/reading/books/" + encodeURIComponent(bookKey) + "/outline")
        .catch(function () { return null; }),
    ]).then(function (res) {
      VIEW.book = (res[0] && res[0].book) || {};
      VIEW.digest = (res[0] && res[0].digest) || null;
      VIEW.intro = (res[0] && res[0].intro) || null;
      VIEW.outline = res[1] || null;
      renderDigest(host);
    }).catch(function (err) { empty(host, "读取失败", (err && err.message) || ""); });
  }

  // 检视结论：**先于**收获显示。读者要先知道「这本书值不值得投入」，
  // 再决定要不要往下读一份几千字的收获。
  function introMarkup(intro) {
    if (!intro || !intro.content_md) return "";
    return '<div class="rd-outline"><h3>检视结论</h3>'
      + '<p class="rd-src-note">不读全书，只凭简介与目录判断：值不值得读、'
      + "用哪档力气读、先读哪几章。</p>"
      + '<div class="rd-doc-body">' + renderMarkdown(intro.content_md) + "</div></div>";
  }

  function outlineMarkup(outline) {
    if (!outline) return "";
    var chapters = outline.chapters || [];
    var importCta = outline.can_import_fulltext
      ? '<div style="margin-top:10px"><button class="rd-ghost" type="button" data-rd-importtext>'
        + "导入这本书的正文（EPUB / PDF / TXT）</button>"
        + '<span class="rd-src-note" style="margin-left:10px">导入的是真全文，之后可全文检索、划词提问、逐章生成收获。</span></div>'
      : "";
    if (outline.kind === "fulltext") {
      var sources = outline.sources || [];
      if (!sources.length) return "";
      return '<div class="rd-outline"><h3>正文</h3>'
        + '<p class="rd-src-note">' + esc(outline.note || "") + "</p>"
        + sources.map(function (s) {
            return '<div class="rd-card"><h4>' + esc(s.filename)
              + ' <span style="color:var(--rd-ink-3);font-size:12px">' + (s.chars || 0) + " 字</span></h4>"
              + '<p style="white-space:pre-wrap">' + esc(s.preview || "") + "…</p></div>";
          }).join("")
        + "</div>";
    }
    if (!chapters.length) {
      // 微信读书的书没有正文也没有热门划线时，这里不能什么都不显示 ——
      // 用户会以为「精华阅读」没做，其实只是这本书没料。
      if (!outline.note) return "";
      return '<div class="rd-outline"><h3>原文</h3>'
        + '<p class="rd-src-note">' + esc(outline.note) + "</p>" + importCta + "</div>";
    }
    return '<div class="rd-outline"><h3>精华阅读</h3>'
      + '<p class="rd-src-note">' + esc(outline.note || "") + "</p>"
      + chapters.map(function (c) {
          var hl = c.highlights || [];
          if (!hl.length) return "";
          return '<div class="rd-oc"><h4 data-lvl="' + (c.level || 1) + '">' + esc(c.title) + "</h4>"
            + hl.map(function (h) {
                return '<blockquote class="rd-quote">' + esc(h.text)
                  + (h.heat ? "<cite>" + h.heat + " 人划线</cite>" : "") + "</blockquote>";
              }).join("")
            + "</div>";
        }).join("")
      + importCta
      + "</div>";
  }

  function renderDigest(host) {
    var book = VIEW.book || {};
    var digest = VIEW.digest;
    var intro = VIEW.intro;
    var outline = VIEW.outline;
    // 正文还没进项目、而这个源又能在服务端变成文本 → 给一个「自动获取正文」按钮。
    // 判断依据是 outline.kind（项目里到底有没有正文），不是记录上的 has_fulltext 标记 ——
    // 那个标记表示「这个源能给全文」，书刚加入书架时就已经是 1 了。
    var canFetchNow = canAutoFetch(book) && (!outline || outline.kind !== "fulltext");
    var html = '<div class="rd-doc">'
      + "<h2>" + esc(book.title || "未命名") + "</h2>"
      + '<p class="byline">' + esc(book.author || "")
      + (book.source_name ? " · " + esc(book.source_name) : "")
      + (book.rights ? " · " + esc(book.rights) : "") + "</p>"
      + '<div style="display:flex;gap:8px;margin-top:16px;align-items:center">'
      + '<button class="rd-solid" type="button" data-rd-generate>'
      + (digest ? "重新生成收获" : "生成读书收获") + "</button>"
      // 检视阅读：先判断「值不值得读、怎么读」，再决定要不要投入 —— 它不是附属按钮。
      + '<button class="rd-ghost" type="button" data-rd-intro>'
      + (intro ? "重新检视" : "生成检视结论") + "</button>"
      + (canFetchNow
          ? '<button class="rd-solid" type="button" data-rd-fetchtext>自动获取正文</button>'
          : "")
      + '<button class="rd-ghost" type="button" data-rd-booklinksbtn>找文件链接</button>'
      + '<button class="rd-ghost" type="button" data-rd-back>返回书架</button>'
      + '<span class="rd-src-note" data-rd-savehint style="margin:0 0 0 auto"></span>'
      + "</div>"
      + introMarkup(intro)
      + fileLinksMarkup(book)
      + '<div data-rd-booklinks></div>'
      // 「导入正文」的文件选择器挂在这里：正文入口可能在精华阅读区，但 input 得在
      // 点击时已经存在于 DOM 里，否则第一次点会什么都没发生。
      + '<input type="file" class="hidden" data-rd-textfile '
      + 'accept=".epub,.pdf,.txt,.md,.mobi,.azw3,.djvu">'
      + outlineMarkup(outline);

    if (digest) {
      html += '<div class="rd-outline"><h3>读书收获</h3></div>'
        // 正文**直接可改**，没有「编辑」按钮 —— 点进去打字即改，防抖自动保存。
        + '<div class="rd-doc-body" contenteditable="true" spellcheck="false" '
        + 'role="textbox" aria-multiline="true" data-rd-doc-body>'
        + renderMarkdown(digest.content_md || "") + "</div>"
        + '<div class="rd-cards" data-rd-cards></div>';
    } else {
      html += '<div class="rd-outline"><h3>读书收获</h3></div>'
        + '<div class="rd-empty" style="padding:20px 0">'
        + "还没有生成收获。点上面的按钮 —— 其中的自测题会自动沉淀为知识卡片。</div>";
    }
    html += "</div>";
    host.innerHTML = html;
    VIEW.lastSaved = digest ? String(digest.content_md || "") : "";
    if (digest) loadCards(book.book_key || VIEW.bookKey);
  }

  // ---------- 知识网络：枢纽 / 桥 / 方法论 ----------
  //
  // 「桥」（bridge）是整张网里最值钱的东西：去掉它，图就断成两半 ——
  // 它连接的是两个原本无关的领域。所以界面上把它单独拎出来，并允许
  // 就着它所在的**簇**生成一份《方法论》。

  function loadNet() {
    var host = root.querySelector("[data-rd-net]");
    if (!host) return;
    loading(host, "正在从各书的收获里重建知识网络…");
    api("/api/reading/net").then(function (data) {
      VIEW.net = data || {};
      renderNet(host, VIEW.net);
    }).catch(function (err) {
      empty(host, "知识网络读取失败", (err && err.message) || "");
    });
  }

  function netStats(summary) {
    var items = [
      [summary.concepts || 0, "概念"],
      [summary.edges || 0, "连线"],
      [summary.clusters || 0, "概念簇"],
      [summary.bridges || 0, "桥"],
      [summary.mature || 0, "已成熟"],
      [summary.books || 0, "本书"],
    ];
    return '<div class="rd-stats">' + items.map(function (pair) {
      return '<div class="rd-stat"><b>' + pair[0] + "</b><span>" + pair[1] + "</span></div>";
    }).join("") + "</div>";
  }

  // 图的画法已经搬到**全屏神经图谱**（static/rd-neural-view.js）。
  // 这一页原来那张扁平 SVG（每簇一个圆环、桥用琥珀色大点）已删除：
  // 它和神经图谱重复，而且簇一多圆环就互相叠、标签被面板边缘切掉、也没有任何交互。
  // 保留的是这一页真正只有它有、且神经图谱还没搬走的东西 —— 下面的统计、桥、枢纽、
  // 概念成熟度、已生成方法论、可能该合并的概念。
  // → 要回退到那张 SVG，从 git 历史里取 netSvgMarkup / layoutNet 两个函数即可。

  function renderNet(host, data) {
    var summary = data.summary || {};
    var html = '<div class="rd-head"><h2>知识网络</h2>'
      + "<p>把每本书收获里的「可复用模型」连成一张网。<b>桥</b>是去掉之后网就断成两半的概念 —— "
      + "它连接的是两个原本无关的领域，最值得花时间。</p>"
      + netStats(summary) + "</div>";

    if (!(data.nodes || []).length) {
      host.innerHTML = html + '<div class="rd-empty" style="padding:36px 0"><b>还没有可连的概念</b>'
        + "先生成至少两本书的《读书收获》——收获里的「可复用模型」就是这张网的节点。</div>";
      return;
    }

    // 这里原来画一张扁平 SVG 图（netSvgMarkup）。已删除 —— 见上方注释：
    // 图现在只由全屏神经图谱负责，这一页保留统计与下面的文字区块。

    // 桥：单独拎出来
    var bridges = data.bridges || [];
    html += '<div class="rd-group"><div class="rd-group-head"><h3>桥</h3><span>'
      + bridges.length + " 个</span></div>";
    if (!bridges.length) {
      html += '<p class="rd-src-note">目前没有桥 —— 说明各书的领域还没有连起来。'
        + "多读几本不同领域的书，或在收获里补上「和我的知识库的联系」，桥就会浮现。</p>";
    } else {
      html += bridges.map(function (b) {
        var books = (b.books || []).join("、");
        return '<div class="rd-card is-reuse"><h3>' + esc(b.name) + "</h3>"
          + '<p>去掉它，网络会多出 <b>' + (b.clusters_joined || 1) + "</b> 个断开的簇。</p>"
          + (books ? '<p class="src">来自：' + esc(books) + "</p>" : "")
          + '<div style="margin-top:10px"><button class="rd-solid" type="button" data-rd-method="'
          + esc(b.concept_key) + '">就这一簇生成方法论</button></div></div>';
      }).join("");
    }
    html += "</div>";

    // 枢纽
    var hubs = (data.hubs || []).filter(function (h) { return !(data.bridges || []).some(function (b) { return b.concept_key === h.concept_key; }); });
    if (hubs.length) {
      html += '<div class="rd-group"><div class="rd-group-head"><h3>枢纽</h3><span>'
        + hubs.length + " 个</span></div>"
        + '<div class="rd-tags" style="margin-bottom:6px">'
        + hubs.map(function (h) {
            return '<span class="rd-tag">' + esc(h.name) + " · " + h.degree + " 条连线"
              + (h.cross_book ? "" : "（单书）") + "</span>";
          }).join("")
        + "</div></div>";
    }

    // 跨书支持 + 成熟度。三级状态借自 mnemex 的 status lifecycle：
    // 把「我到底懂没懂」变成一个看得见的状态 —— 只在一本书里见过的概念，
    // 和三本书里反复被独立指向的概念，可信度天差地别。
    var support = (data.support || []).filter(function (s) { return s.book_count > 0; });
    if (support.length) {
      var byStage = { mature: [], draft: [], stub: [] };
      support.forEach(function (s) { (byStage[s.stage] || byStage.stub).push(s); });
      html += '<div class="rd-group"><div class="rd-group-head"><h3>概念成熟度</h3>'
        + "<span>孤证 → 待验证 → 已成熟（按被几本书独立支持）</span></div>";
      [["mature", "已成熟", "三本以上独立支持"],
       ["draft", "待验证", "两本书独立提到"],
       ["stub", "孤证", "只在一本书里出现过"]].forEach(function (row) {
        var list = byStage[row[0]] || [];
        if (!list.length) return;
        html += '<div style="margin-top:12px"><div class="rd-group-head" style="margin-bottom:8px">'
          + '<h4 style="margin:0;font-size:13px;font-weight:600">' + row[1]
          + '</h4><span>' + list.length + " 个 · " + row[2] + "</span></div>"
          + '<div class="rd-tags">' + list.slice(0, 18).map(function (s) {
              return '<span class="rd-tag' + (row[0] === "mature" ? " primary" : "") + '">'
                + esc(s.name) + " · " + s.book_count + " 本</span>";
            }).join("") + "</div></div>";
      });
      html += "</div>";
    }

    // 已生成的方法论
    var methods = data.methodologies || [];
    if (methods.length) {
      html += '<div class="rd-group"><div class="rd-group-head"><h3>已生成的方法论</h3><span>'
        + methods.length + " 份</span></div>"
        + methods.map(function (m) {
            return '<details class="rd-card" style="margin-bottom:10px">'
              + '<summary style="cursor:pointer;font-weight:600;font-size:14px">'
              + esc(m.title || m.anchor_name || "未命名方法论") + "</summary>"
              + '<div class="rd-doc-body" style="margin-top:12px">'
              + renderMarkdown(m.content_md || "") + "</div></details>";
          }).join("") + "</div>";
    }

    // 合并候选（不猜合并：只给候选，用户点才合）
    html += '<div class="rd-group"><div class="rd-group-head"><h3>可能该合并的概念</h3>'
      + "<span>确认后两张卡会并成一个概念</span></div><div data-rd-merge></div></div>";

    host.innerHTML = html;
    loadMergeCandidates();
  }

  function loadMergeCandidates() {
    var host = root.querySelector("[data-rd-merge]");
    if (!host) return;
    host.innerHTML = '<div class="rd-loading">正在找…</div>';
    api("/api/reading/net/candidates").then(function (data) {
      var items = (data && data.candidates) || [];
      if (!items.length) {
        host.innerHTML = '<div class="rd-loading">暂时没有候选。'
          + "（术语层只认「同义变体」与「包含关系」，刻意不做同尾词 —— 那会把列表淹没。）</div>";
        return;
      }
      host.innerHTML = items.map(function (c) {
        return '<div class="rd-hit"><div class="rd-hit-main"><h4>'
          + esc(c.left_name) + " ／ " + esc(c.right_name) + "</h4>"
          + "<p>" + esc(c.reason) + "</p>"
          + '<div class="rd-hit-src">置信度 ' + c.score
          + (c.books && c.books.length ? " · 涉及 " + esc(c.books.join("、")) : "") + "</div></div>"
          + '<div class="rd-hit-act"><button class="rd-ghost" type="button" data-rd-mergeok="'
          + esc(c.left) + "|" + esc(c.right) + '">确认合并</button></div></div>';
      }).join("");
    }).catch(function () { host.innerHTML = ""; });
  }

  function confirmMerge(pair) {
    var parts = String(pair || "").split("|");
    if (parts.length !== 2) return;
    postJson("/api/reading/net/merge", { from_key: parts[0], to_key: parts[1] })
      .then(function (data) {
        toast("已合并。", "success");
        VIEW.net = data;
        renderNet(root.querySelector("[data-rd-net]"), data);
      })
      .catch(function (err) { toast("合并失败：" + ((err && err.message) || ""), "error"); });
  }

  function generateMethodology(anchorKey) {
    var host = root.querySelector("[data-rd-net]");
    if (!host) return;
    loading(host, "正在就这一簇归纳方法论（并沉淀技能卡）…");
    postJson("/api/reading/net/methodology", { anchor_key: anchorKey })
      .then(function (data) {
        if (data && data.fallback) {
          toast("模型不可用，已退化为「只列出这一簇的概念」。", "info");
        } else {
          toast("已生成方法论，并沉淀 " + ((data && data.cards && data.cards.synced) || 0) + " 张技能卡。", "success");
        }
        loadNet();
      })
      .catch(function (err) {
        toast("生成失败：" + ((err && err.message) || ""), "error");
        loadNet();
      });
  }

  // ---------- 正文直改：contenteditable → 反写 Markdown ----------
  //
  // 与 static/knowledge-doc-ui.js 同一套思路（那边已经跑通）：正文点进去就能改，
  // 不要「编辑」按钮。代价是保存时要把 DOM 反写回 Markdown，所以**渲染器只产出
  // 几种朴素的块**（h1~h4 / p / ul / ol / blockquote / strong / code）——
  // 反写认不出的元素会丢字，这也是收获文档里刻意不用 <details> 折叠块的原因。

  function inlineToMd(node) {
    var out = "";
    var kids = node.childNodes || [];
    for (var i = 0; i < kids.length; i += 1) {
      var child = kids[i];
      if (!child) continue;
      if (child.nodeType === 3) { out += String(child.nodeValue || ""); continue; }
      if (child.nodeType !== 1) continue;
      var tag = String(child.tagName || "").toUpperCase();
      if (tag === "INPUT") continue;                 // 复选框没有文字，别把它算进来
      var inner = inlineToMd(child);
      if (tag === "STRONG" || tag === "B") out += "**" + inner + "**";
      else if (tag === "EM" || tag === "I") out += "*" + inner + "*";
      else if (tag === "CODE") out += "`" + inner + "`";
      else if (tag === "BR") out += " ";
      else out += inner;
    }
    return out.replace(/[ \t]+/g, " ");
  }

  function serializeBlocks(node) {
    var out = [];
    var kids = node.childNodes || [];
    for (var i = 0; i < kids.length; i += 1) {
      var child = kids[i];
      if (!child) continue;
      if (child.nodeType === 3) {
        var bare = String(child.nodeValue || "").trim();
        if (bare) out.push(bare);
        continue;
      }
      if (child.nodeType !== 1) continue;
      var tag = String(child.tagName || "").toUpperCase();
      // Chrome 敲回车爱塞 <div>：不收编就会整段丢字。
      if (tag === "DIV" || tag === "SECTION" || tag === "ARTICLE") {
        var nested = serializeBlocks(child);
        if (nested) out.push(nested);
        continue;
      }
      if (tag === "HR") { out.push("---"); continue; }
      if (/^H[1-6]$/.test(tag)) {
        out.push(new Array(Number(tag.charAt(1)) + 1).join("#") + " " + inlineToMd(child).trim());
        continue;
      }
      if (tag === "BLOCKQUOTE") {
        var lines = inlineToMd(child).trim().split("\n");
        out.push(lines.map(function (l) { return "> " + l; }).join("\n"));
        continue;
      }
      if (tag === "UL" || tag === "OL") {
        var items = [];
        var lis = child.children || [];
        for (var j = 0; j < lis.length; j += 1) {
          var li = lis[j];
          if (!li || String(li.tagName).toUpperCase() !== "LI") continue;
          var box = li.querySelector ? li.querySelector('input[type="checkbox"]') : null;
          var prefix = tag === "OL" ? (j + 1) + ". " : "- ";
          if (box) prefix = box.checked ? "- [x] " : "- [ ] ";
          var txt = inlineToMd(li).trim();
          if (txt) items.push(prefix + txt);
        }
        if (items.length) out.push(items.join("\n"));
        continue;
      }
      var text = inlineToMd(child).trim();
      if (text) out.push(text);
    }
    return out.filter(Boolean).join("\n\n");
  }

  var _saveTimer = null;

  function scheduleSave() {
    var hint = root.querySelector("[data-rd-savehint]");
    if (hint) hint.textContent = "未保存…";
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(flushSave, 1200);
  }

  function flushSave() {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    var body = root.querySelector("[data-rd-doc-body]");
    var hint = root.querySelector("[data-rd-savehint]");
    if (!body || !VIEW.bookKey) return;
    var md = serializeBlocks(body);
    if (!md.trim() || md === VIEW.lastSaved) {
      if (hint) hint.textContent = md.trim() ? "已保存" : "";
      return;
    }
    postJson("/api/reading/books/" + encodeURIComponent(VIEW.bookKey) + "/doc",
             { content_md: md, kind: "digest" }, "PUT")
      .then(function () {
        VIEW.lastSaved = md;
        if (hint) hint.textContent = "已保存";
      })
      .catch(function (err) {
        if (hint) hint.textContent = "保存失败";
        toast("保存失败：" + ((err && err.message) || ""), "error");
      });
  }

  function loadCards(bookKey) {
    var host = root.querySelector("[data-rd-cards]");
    if (!host) return;
    host.innerHTML = '<h4>已沉淀的知识卡片</h4><div class="rd-loading">正在读取…</div>';
    api("/api/reading/books/" + encodeURIComponent(bookKey) + "/cards")
      .then(function (data) {
        var cards = (data && data.cards) || [];
        if (!cards.length) {
          host.innerHTML = '<h4>已沉淀的知识卡片</h4><div class="rd-loading">还没有卡片 —— 收获文档里的自测题会自动沉淀到这里。</div>';
          return;
        }
        host.innerHTML = '<h4>已沉淀的知识卡片（' + cards.length + " 张，已进复习队列）</h4>"
          + cards.map(function (c) {
            return '<div class="rd-card-row"><b>' + esc(c.front) + "</b><span>" + esc(c.back) + "</span></div>";
          }).join("");
      })
      .catch(function () { host.innerHTML = ""; });
  }

  function generateDigest() {
    var bookKey = VIEW.bookKey;
    if (!bookKey) return;
    var host = root.querySelector("[data-rd-digest]");
    loading(host, "正在生成读书收获（并沉淀知识卡片）…");
    postJson("/api/reading/books/" + encodeURIComponent(bookKey) + "/digest", {})
      .then(function (data) {
        VIEW.digest = (data && data.doc) || null;
        var cards = (data && data.cards) || {};
        if (data && data.insufficient) {
          // 一点材料都没有 —— 后端刻意**不调模型**，免得拿通识编一篇假收获。
          toast("这本书没有可用的划线/简介，已如实说明「材料不足」，没有编内容。", "info");
        } else if (data && data.fallback) {
          toast("模型不可用，已退化为「只呈现你的划线」的版本。", "info");
        } else if (data && data.mode === "book") {
          toast("这本书你还没划线，已生成「书籍导读」（已如实标注）。", "info");
        } else {
          toast("已生成收获，并沉淀 " + (cards.synced || 0) + " 张知识卡片。", "success");
        }
        renderDigest(host);
      })
      .catch(function (err) {
        toast("生成失败：" + ((err && err.message) || ""), "error");
        renderDigest(host);
      });
  }

  // ---------- 找书：本地导入 / 为你推荐 ----------

  function importLocal(file) {
    if (!file) return;
    var name = file.name || "";
    var stem = name.replace(/\.[^.]+$/, "");
    var ext = (name.match(/\.([^.]+)$/) || [null, ""])[1].toLowerCase();
    var host = root.querySelector("[data-rd-discover]");
    if (host) loading(host, "正在导入《" + stem + "》…");
    // 两步：① 登记这本书（**这里要放文件，所以显式按需建项目**）② 把文件本体传进那个项目当资料。
    // 第 ② 步复用**既有的上传 / 解析 / OCR 全链路**，不另造一套解析。
    postJson("/api/reading/books", {
      book: {
        source: "local", source_id: name, title: stem, rights: "user-provided",
        has_fulltext: true, fulltext_format: ext,
      },
      with_project: true,
    }).then(function (data) {
      var pid = data && data.project_id;
      if (!pid) throw new Error("没有拿到项目 id");
      var form = new FormData();
      form.append("files", file, name);
      // ⚠️ 不要手写 Content-Type：FormData 的 boundary 必须由浏览器自己生成。
      return api("/api/projects/" + encodeURIComponent(pid) + "/sources", { method: "POST", body: form });
    }).then(function () {
      toast("已导入并解析《" + stem + "》，可以读了。", "success");
      if (host) host.innerHTML = "";
      loadShelf();
    }).catch(function (err) {
      toast("导入失败：" + ((err && err.message) || ""), "error");
      if (host) host.innerHTML = "";
    });
  }

  function generateIntro() {
    var bookKey = VIEW.bookKey;
    if (!bookKey) return;
    var host = root.querySelector("[data-rd-digest]");
    loading(host, "正在检视这本书（值不值得读、怎么读）…");
    postJson("/api/reading/books/" + encodeURIComponent(bookKey) + "/intro", {})
      .then(function (data) {
        VIEW.intro = (data && data.doc) || null;
        toast(data && data.fallback
          ? "模型不可用，已退回书籍自带简介（没有检视结论）。"
          : "已生成检视结论。", data && data.fallback ? "info" : "success");
        openBook(bookKey);
      })
      .catch(function (err) { toast("检视失败：" + ((err && err.message) || ""), "error"); });
  }

  // 给**已有的一本书**补正文（微信读书的书没有正文，这是唯一合法来源）。
  // 复用既有的上传 / 解析 / OCR 链路。这本书可能还没有项目（加入书架时不建），
  // 所以先按需把项目建出来 —— 导入正文正是「真要放资料」的场景。
  // 文件传完再 PUT /fulltext 落一个标记：少了那一步，书架卡片会一直写着
  // 「仅元数据」，用户以为没成功。
  function importFulltext(file) {
    if (!file) return;
    var ext = ((file.name || "").match(/\.([^.]+)$/) || [null, ""])[1].toLowerCase();
    toast("正在导入并解析《" + (file.name || "") + "》…", "info");
    ensureProject()
      .then(function (pid) {
        if (!pid) throw new Error("没有拿到项目 id");
        var form = new FormData();
        form.append("files", file, file.name || "book");
        return api("/api/projects/" + encodeURIComponent(pid) + "/sources", { method: "POST", body: form });
      })
      .then(function () {
        return postJson(
          "/api/reading/books/" + encodeURIComponent(VIEW.bookKey) + "/fulltext",
          { format: ext },
          "PUT"
        );
      })
      .then(function () {
        toast("正文已导入，可以读、可以问、可以划词了。", "success");
        openBook(VIEW.bookKey);
      })
      .catch(function (err) {
        toast("导入失败：" + ((err && err.message) || ""), "error");
      });
  }

  // 按需建项目：加入书架时**不建**，只有真要往里放资料（导入正文）时才建。
  // 已有项目就直接返回，没有就带着 with_project 再登记一次（后端幂等）。
  function ensureProject() {
    var book = VIEW.book || {};
    if (book.project_id) return Promise.resolve(book.project_id);
    return postJson("/api/reading/books", { book: book, with_project: true }).then(function (data) {
      if (data && data.book) VIEW.book = data.book;
      return (data && data.project_id) || "";
    });
  }

  function generateMissingDigests() {
    var host = root.querySelector("[data-rd-discover]");
    if (host) loading(host, "正在给还没有收获的书批量生成（一本一本跑，可能要几分钟）…");
    postJson("/api/reading/digests/generate-missing", { limit: 8 })
      .then(function (data) {
        var ok = (data && data.generated) || 0;
        var bad = (data && data.failed) || 0;
        var left = (data && data.remaining) || 0;
        var msg = "已生成 " + ok + " 本";
        if (bad) msg += "，失败 " + bad + " 本";
        if (left) msg += "，还有 " + left + " 本没跑（再点一次继续）";
        toast(msg + "。", bad ? "info" : "success");
        if (host) host.innerHTML = "";
        loadShelf();
      })
      .catch(function (err) {
        toast("批量生成失败：" + ((err && err.message) || ""), "error");
        if (host) host.innerHTML = "";
      });
  }

  function loadRecommend() {
    var host = root.querySelector("[data-rd-discover]");
    if (!host) return;
    loading(host, "正在获取推荐…");
    api("/api/reading/weread/recommend?count=12").then(function (data) {
      var books = (data && data.books) || [];
      VIEW.recHits = books;
      if (!books.length) {
        empty(host, "没有拿到推荐", "可能是微信读书 Key 未配置，或该接口暂不可用。");
        return;
      }
      host.innerHTML = '<p class="rd-src-note">为你推荐（微信读书）—— 点「加入书架」收进来，要读全文时再导入正文</p>'
        + books.map(function (b, i) {
            return '<div class="rd-hit">'
              + '<div class="rd-hit-cover" style="background:' + coverColor(b.title) + '">'
              + (b.cover ? '<img src="' + esc(b.cover) + '" alt="" loading="lazy" onerror="this.remove()">' : "")
              + "</div>"
              + '<div class="rd-hit-main"><h4>' + esc(b.title) + "</h4>"
              + "<p>" + esc(b.author || "") + "</p>"
              + '<div class="rd-hit-src">' + esc(b.reason || b.category || "") + "</div></div>"
              + '<div class="rd-hit-act"><button class="rd-ghost" type="button" data-rd-addrec="'
              + i + '">加入书架</button></div></div>';
          }).join("");
    }).catch(function (err) { empty(host, "获取推荐失败", (err && err.message) || ""); });
  }

  function addRecommend(index) {
    var record = (VIEW.recHits || [])[index];
    if (!record) return;
    addBookRecord(record);
  }

  function addBookRecord(record) {
    postJson("/api/reading/books", { book: record })
      .then(function (data) {
        // 只入书架，**不建项目** —— 项目等真要放资料时（导入正文 / 生成收获）再按需建。
        toast("已加入书架：" + ((data && data.book && data.book.title) || ""), "success");
        loadShelf();
      })
      .catch(function (err) { toast("加入失败：" + ((err && err.message) || ""), "error"); });
  }

  // ---------- 取正文 / 找文件链接 ----------
  //
  // 两条互补的路：
  //   * 「取正文」把公版书的整本正文抓进这本书的项目（之后可全文检索、划词提问、逐章生成收获）；
  //   * 「找链接」不抓内容，只把「哪里能读 / 能借 / 能下」查出来 —— 有版权的书走这条。
  // 都靠网络，所以失败原因是服务端算好的（含「需要代理」），前端只负责如实转述。

  function ensureBookKey(record) {
    // 先入书架（幂等）—— 取正文/找链接都要作用在「书 + 它的项目」上。
    return postJson("/api/reading/books", { book: record }).then(function (data) {
      var key = data && data.book && data.book.book_key;
      if (!key) throw new Error("没有拿到 book_key");
      return key;
    });
  }

  function fetchFulltextFor(key, record) {
    toast("正在抓取正文（公版书才可取，可能要等几秒）…", "info");
    return postJson(
      "/api/reading/books/" + encodeURIComponent(key) + "/fulltext/fetch",
      { book: record || {} }
    ).then(function (res) {
      var msg = "已取回正文 " + ((res && res.chars) || 0) + " 字";
      if (res && res.chapters) msg += "（" + res.chapters + " 章）";
      toast(msg + "，可以直接读了。", "success");
      loadShelf();
      openBook(key);
    });
  }

  function findLinksFor(key, record, hostEl) {
    if (hostEl) loading(hostEl, "正在查馆藏与借阅入口…");
    return postJson("/api/reading/links", { book: record || {}, book_key: key || "" })
      .then(function (res) {
        if (hostEl) {
          hostEl.innerHTML = (res && res.links && res.links.length)
            ? linkListMarkup(res.links)
            : '<div class="rd-src-note">' + esc((res && res.reason) || "没有找到入口。") + "</div>";
        } else {
          toast((res && res.links && res.links.length)
            ? "找到 " + res.links.length + " 个入口。"
            : ((res && res.reason) || "没有找到入口。"), "info");
        }
        return res;
      })
      .catch(function (err) {
        var msg = "查找失败：" + ((err && err.message) || "");
        if (hostEl) hostEl.innerHTML = '<div class="rd-src-note">' + esc(msg) + "</div>";
        else toast(msg, "error");
      });
  }

  function hitAction(index, action) {
    var record = (VIEW.searchHits || [])[index];
    if (!record) return;
    var hostEl = null;
    if (action === "links") {
      var slot = root.querySelector('[data-rd-hitlinks="' + index + '"]');
      hostEl = slot;
    }
    ensureBookKey(record).then(function (key) {
      if (action === "links") return findLinksFor(key, record, hostEl);
      return fetchFulltextFor(key, record);
    }).catch(function (err) {
      toast(((action === "links") ? "查找失败：" : "取正文失败：") + ((err && err.message) || ""), "error");
    });
  }

  // ---------- 选中 → AI 辅助阅读讨论 ----------
  //
  // 划选一段（收获正文 / 检视结论 / 精华阅读的划线 / 正文预览）→ 旁边浮出一条小工具条，
  // 点了就开右侧讨论抽屉。**上下文取「选区所在那一块」的整段文本**，不是整本书 ——
  // 整本送进去既贵，又会让模型在中段丢掉「先贴书、再发散」这条主线。选区只是**锚点**，
  // 不是答案的边界：陪读讨论默认就要往外发散（见后端 reading_digest.READING_ASK_SYSTEM）。
  // 讨论是多轮的：每问一轮把最近 3 轮带上。

  var ASK = { open: false, sel: "", context: "", thread: [], busy: false };
  var ASK_CTX_MAX = 6000;
  var ASK_BAR_ID = "rd-sel-bar";
  var ASK_BOX_ID = "rd-ask-drawer";
  var ASK_BODY_CLASS = "rd-ask-open";
  var ASK_CHIPS = ["这段在说什么", "这让我联想到什么", "能连到哪些别的领域", "反方会怎么反驳"];
  var _askPaintAt = 0;

  function askEl(id) { return document.getElementById(id); }

  function ensureAskUi() {
    if (!root) return;
    if (!askEl(ASK_BAR_ID)) {
      var bar = document.createElement("div");
      bar.className = "rd-selbar";
      bar.id = ASK_BAR_ID;
      bar.hidden = true;
      bar.innerHTML = '<button type="button" data-rd-ask-start>AI 讨论这段</button>';
      root.appendChild(bar);
    }
    if (!askEl(ASK_BOX_ID)) {
      var box = document.createElement("aside");
      box.className = "rd-ask";
      box.id = ASK_BOX_ID;
      box.hidden = true;
      box.innerHTML = '<div class="rd-ask-head"><div><b>AI 陪读讨论</b>'
        + '<span data-rd-ask-book></span></div>'
        + '<button class="rd-ask-x" type="button" data-rd-ask-close aria-label="关闭">✕</button></div>'
        + '<blockquote class="rd-ask-quote" data-rd-ask-quote></blockquote>'
        + '<div class="rd-ask-msgs" data-rd-ask-msgs></div>'
        + '<div class="rd-ask-chips">' + ASK_CHIPS.map(function (text) {
            return '<button class="rd-ask-chip" type="button" data-rd-ask-chip="'
              + esc(text) + '">' + esc(text) + "</button>";
          }).join("") + "</div>"
        + '<div class="rd-ask-foot"><input type="text" placeholder="就这段问一句…" data-rd-ask-input>'
        + '<button class="rd-solid" type="button" data-rd-ask-send>发送</button></div>'
        + '<p class="rd-ask-note">先贴着你选中的这段说清它讲了什么，再往外发散 —— '
        + "联系别的书、别的领域、反方与你的生活；书外的延伸会标明是它自己的联想。</p>";
      root.appendChild(box);
    }
  }

  function askHistory() {
    var out = [];
    for (var i = 0; i < ASK.thread.length; i += 1) {
      var msg = ASK.thread[i];
      if (msg.error || !msg.a) continue;
      out.push({ question: String(msg.q).slice(0, 300), answer: String(msg.a).slice(0, 500) });
    }
    return out.slice(-3);
  }

  function askMsgsMarkup() {
    return ASK.thread.map(function (msg) {
      var html = '<div class="rd-ask-msg"><div class="rd-ask-q">' + esc(msg.q) + "</div>";
      if (msg.error) html += '<div class="rd-ask-err">' + esc(msg.error) + "</div>";
      else if (msg.a) html += '<div class="rd-ask-a">' + renderMarkdown(msg.a) + "</div>";
      else html += '<div class="rd-ask-a is-wait">正在读这段…</div>';
      return html + "</div>";
    }).join("");
  }

  function paintAsk() {
    var box = askEl(ASK_BOX_ID);
    if (!box) return;
    var msgs = box.querySelector("[data-rd-ask-msgs]");
    if (msgs) {
      msgs.innerHTML = askMsgsMarkup();
      msgs.scrollTop = msgs.scrollHeight;   // 流式输出要跟着往下走，否则永远看的是第一屏
    }
    var send = box.querySelector("[data-rd-ask-send]");
    if (send) send.disabled = !!ASK.busy;
  }

  function paintAskSoon() {
    var now = Date.now();
    if (now - _askPaintAt < 90) return;     // 流式每块都重画会卡，90ms 一档足够跟手
    _askPaintAt = now;
    paintAsk();
  }

  // 选区所在的那一块。只有这几处是「读者正在读的原文」，别的地方（按钮、卡片标题）
  // 划到了不该弹工具条。
  function askBlockFor(selection) {
    var node = selection && selection.anchorNode;
    var el = node ? (node.nodeType === 1 ? node : node.parentNode) : null;
    if (!el || !el.closest) return null;
    return el.closest(".rd-doc-body, .rd-quote, .rd-card > p");
  }

  function hideSelBar() {
    var bar = askEl(ASK_BAR_ID);
    if (bar) bar.hidden = true;
  }

  function onSelect() {
    if (!isVisible()) { hideSelBar(); return; }
    var sel = window.getSelection && window.getSelection();
    var text = sel ? String(sel.toString() || "").trim() : "";
    var block = askBlockFor(sel);
    var box = askEl(ASK_BOX_ID);
    if (!text || !block || !root.contains(block) || (box && box.contains(block))) {
      hideSelBar();
      return;
    }
    ASK.sel = text;
    ASK.context = String(block.textContent || "").slice(0, ASK_CTX_MAX);
    var range = null;
    try { range = sel.getRangeAt(0).getBoundingClientRect(); } catch (e) { range = null; }
    if (!range) { hideSelBar(); return; }
    var bar = askEl(ASK_BAR_ID);
    if (!bar) return;
    bar.hidden = false;
    bar.style.left = Math.max(12, Math.min(range.left, window.innerWidth - 170)) + "px";
    bar.style.top = Math.max(58, range.top - 44) + "px";
  }

  function openAsk() {
    ensureAskUi();
    var box = askEl(ASK_BOX_ID);
    if (!box || !VIEW.bookKey) return;
    ASK.open = true;
    box.hidden = false;
    var quote = box.querySelector("[data-rd-ask-quote]");
    if (quote) quote.textContent = ASK.sel;
    var title = box.querySelector("[data-rd-ask-book]");
    if (title) title.textContent = VIEW.book && VIEW.book.title ? "《" + VIEW.book.title + "》" : "";
    // 主界面的提问导轨 z-index 8000，压在本抽屉之上 —— 开着的时候得把它藏掉。
    if (document.body) document.body.classList.add(ASK_BODY_CLASS);
    hideSelBar();
    paintAsk();
    var input = box.querySelector("[data-rd-ask-input]");
    if (input) input.focus();
  }

  function closeAsk() {
    var box = askEl(ASK_BOX_ID);
    if (box) box.hidden = true;
    if (document.body) document.body.classList.remove(ASK_BODY_CLASS);
    ASK.open = false;
  }

  function resetAsk() {
    ASK.thread = [];
    ASK.sel = "";
    ASK.context = "";
    ASK.busy = false;
    closeAsk();
    hideSelBar();
    paintAsk();   // 顺手清掉 DOM 里的旧记录，别留着等下次打开才刷
  }

  function onAskEvent(event, msg) {
    if (!event || !event.type) return;
    if (event.type === "delta") {
      msg.a += String(event.text || "");
      paintAskSoon();
    } else if (event.type === "done") {
      msg.a = String(event.text || msg.a);
      paintAsk();
    } else if (event.type === "error") {
      msg.error = String(event.message || "这次没答上来。");
      paintAsk();
    }
  }

  // SSE：api() 会按 JSON 解析，流式得自己读 body。
  async function askStream(body, msg) {
    var resp = await fetch(
      "/api/reading/books/" + encodeURIComponent(VIEW.bookKey) + "/ask",
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    if (resp.status === 401) throw new Error("登录状态已失效，请刷新页面后再试。");
    if (!resp.ok || !resp.body) {
      var detail = "";
      try {
        var data = await resp.json();
        detail = (data && data.detail && (data.detail.message || data.detail)) || "";
      } catch (e) { /* 非 JSON 就退回状态码 */ }
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
      for (var i = 0; i < parts.length; i += 1) {
        var line = String(parts[i]).trim();
        if (line.indexOf("data:") !== 0) continue;
        try { onAskEvent(JSON.parse(line.slice(5).trim()), msg); } catch (e) { /* 坏帧跳过 */ }
      }
    }
  }

  function askSend(preset) {
    if (!VIEW.bookKey) return;
    var box = askEl(ASK_BOX_ID);
    var input = box && box.querySelector("[data-rd-ask-input]");
    var question = String(preset || (input && input.value) || "").trim();
    if (!question) { toast("先写一句想问的。", "error"); return; }
    if (ASK.busy) { toast("上一条还在回答中。", "info"); return; }
    var msg = { q: question, a: "", error: "" };
    ASK.thread.push(msg);
    ASK.busy = true;
    if (input && !preset) input.value = "";
    paintAsk();
    askStream({
      question: question,
      selection: ASK.sel,
      context: ASK.context,
      history: askHistory(),
    }, msg).catch(function (err) {
      msg.error = (err && err.message) || "提问失败。";
    }).then(function () {
      ASK.busy = false;
      paintAsk();
    });
  }

  // ---------- 事件绑定（全部走委托，渲染链抛错也不影响可点） ----------

  function bind() {
    root.addEventListener("click", function (event) {
      var scaleBtn = event.target.closest("[data-rd-scale]");
      if (scaleBtn) { applyScale(scaleBtn.dataset.rdScale); return; }

      var tab = event.target.closest("[data-rd-tab]");
      if (tab) { setTab(tab.dataset.rdTab); return; }

      var searchBtn = event.target.closest("[data-rd-search]");
      if (searchBtn) {
        var input = root.querySelector("[data-rd-query]");
        runSearch(input ? input.value.trim() : "");
        return;
      }

      var addBtn = event.target.closest("[data-rd-add]");
      if (addBtn) { addBook(parseInt(addBtn.dataset.rdAdd, 10)); return; }

      // 搜索结果上的「取正文」/「找链接」
      var hitFetch = event.target.closest("[data-rd-hitfetch]");
      if (hitFetch) { hitAction(parseInt(hitFetch.dataset.rdHitfetch, 10), "fetch"); return; }
      var hitLinks = event.target.closest("[data-rd-hitlinksbtn]");
      if (hitLinks) { hitAction(parseInt(hitLinks.dataset.rdHitlinksbtn, 10), "links"); return; }

      // 阅读页上的「自动获取正文」/「找文件链接」
      if (event.target.closest("[data-rd-fetchtext]")) {
        if (!VIEW.bookKey) return;
        fetchFulltextFor(VIEW.bookKey, VIEW.book).catch(function (err) {
          toast("取正文失败：" + ((err && err.message) || ""), "error");
        });
        return;
      }
      if (event.target.closest("[data-rd-booklinksbtn]")) {
        var slot = root.querySelector("[data-rd-booklinks]");
        findLinksFor(VIEW.bookKey, VIEW.book, slot);
        return;
      }

      if (event.target.closest("[data-rd-wsave]")) { saveWereadKey(); return; }
      if (event.target.closest("[data-rd-wsync]")) { syncWeread(); return; }

      var bookEl = event.target.closest("[data-rd-book]");
      if (bookEl) { openBook(bookEl.dataset.rdBook); return; }

      if (event.target.closest("[data-rd-generate]")) { generateDigest(); return; }
      if (event.target.closest("[data-rd-intro]")) { generateIntro(); return; }
      if (event.target.closest("[data-rd-back]")) { flushSave(); setTab("shelf"); return; }
      if (event.target.closest("[data-rd-exit]")) { flushSave(); exit(); return; }

      // 划词 → AI 陪读讨论
      if (event.target.closest("[data-rd-ask-start]")) { openAsk(); return; }
      if (event.target.closest("[data-rd-ask-close]")) { closeAsk(); return; }
      if (event.target.closest("[data-rd-ask-send]")) { askSend(); return; }
      var chip = event.target.closest("[data-rd-ask-chip]");
      if (chip) { askSend(chip.dataset.rdAskChip); return; }

      // 给这本书补正文（微信读书的书没有正文）
      if (event.target.closest("[data-rd-importtext]")) {
        var textPicker = root.querySelector("[data-rd-textfile]");
        if (textPicker) textPicker.click();
        return;
      }

      // 找书的三条路
      if (event.target.closest("[data-rd-import]")) {
        var picker = root.querySelector("[data-rd-file]");
        if (picker) picker.click();
        return;
      }
      if (event.target.closest("[data-rd-recommend]")) { loadRecommend(); return; }
      if (event.target.closest("[data-rd-batchdigest]")) { generateMissingDigests(); return; }
      var recBtn = event.target.closest("[data-rd-addrec]");
      if (recBtn) { addRecommend(parseInt(recBtn.dataset.rdAddrec, 10)); return; }

      // 知识网络
      var methodBtn = event.target.closest("[data-rd-method]");
      if (methodBtn) { generateMethodology(methodBtn.dataset.rdMethod); return; }
      var mergeBtn = event.target.closest("[data-rd-mergeok]");
      if (mergeBtn) { confirmMerge(mergeBtn.dataset.rdMergeok); return; }
    });

    root.addEventListener("change", function (event) {
      if (event.target.matches("[data-rd-file]")) {
        var file = event.target.files && event.target.files[0];
        event.target.value = "";   // 允许连续导入同一个文件
        importLocal(file);
        return;
      }
      if (event.target.matches("[data-rd-textfile]")) {
        var text = event.target.files && event.target.files[0];
        event.target.value = "";
        importFulltext(text);
      }
    });

    // 正文直改：打字即改，防抖落库；失焦立刻落一次，别让用户以为没保存。
    root.addEventListener("input", function (event) {
      if (event.target.closest("[data-rd-doc-body]")) scheduleSave();
    });
    root.addEventListener("focusout", function (event) {
      if (event.target.closest("[data-rd-doc-body]")) flushSave();
    });

    root.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && event.target.matches("[data-rd-query]")) {
        runSearch(event.target.value.trim());
        return;
      }
      if (event.key === "Enter" && event.target.matches("[data-rd-ask-input]")) {
        askSend();
      }
    });

    // 划选：mouseup 之后 selection 才更新完，所以下一拍再读。
    root.addEventListener("mouseup", function () { setTimeout(onSelect, 0); });
    root.addEventListener("keyup", function (event) {
      if (event.shiftKey && event.key && event.key.indexOf("Arrow") === 0) setTimeout(onSelect, 0);
    });
    // 点到别处 / 滚动就把工具条收掉（位置会失效），但点工具条与抽屉自己不算。
    document.addEventListener("mousedown", function (event) {
      if (event.target && event.target.closest && event.target.closest(".rd-selbar, .rd-ask")) return;
      hideSelBar();
    });
    window.addEventListener("scroll", function () { hideSelBar(); }, true);

    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape" || !isVisible()) return;
      if (ASK.open) { closeAsk(); return; }   // Esc 先收抽屉，再收整个读书模式
      exit();
    });
  }

  function init() {
    root = document.getElementById("reading-workspace");
    if (!root) return;
    try {
      var saved = window.localStorage.getItem(PREF_KEY);
      if (saved === "digest" || saved === "shelf" || saved === "net") VIEW.tab = saved;
    } catch (e) { /* 忽略 */ }
    applyScale(readScale());
    ensureAskUi();   // 工具条与抽屉是常驻节点（挂在 root 上，不会被 pane 重渲染冲掉）
    bind();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.KnowOriginReading = {
    open: enter,
    close: exit,
    isVisible: isVisible,
    refresh: loadShelf,
    // 供其它模块（如侧栏项目行）直接跳到某本书
    openBook: openBook,
  };
})();
