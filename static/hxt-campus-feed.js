/*
 * 海小棠 · 校园速递（独立 addon）
 * ------------------------------------------------------------
 * 只做一件事：把「校园速递」作为海小棠的功能入口恢复回来。
 *   - 等海小棠对话面板的「首屏快捷区」([data-hxt-chips]) 出现后，
 *     往里注入一个「📮 校园速递」chip（复用 .hxt-dchip 样式）；
 *   - 点击 chip 打开一个 overlay 面板，调后端 /api/hxt/feed 列出
 *     各关注公众号最近推文（标题 / 号名 / 分类 / 发布时间 / 原文链接），
 *     支持分类筛选与手动刷新；
 *   - 头部「👥 关注」切换到关注清单（/api/hxt/wx-accounts + /api/hxt/wx-follows），
 *     可关注 / 取消关注各公众号，取消关注的号从速递列表里消失。
 * 不挂主界面标题栏（那是「删除主界面的校园速递 UI」的范围）；
 * 不修改 hxt-pet.js 一行——本文件自包含，删掉即完全回退。
 * 数据接口见 src/api_server.py 的 /api/hxt/feed、/api/hxt/feed/refresh。
 */
(function () {
  "use strict";

  var CHIP_KEY = "campusfeed";

  // 1) 等待海小棠首屏快捷区出现。
  //    关键坑：[data-hxt-chips] 是海小棠对话面板的一部分，只有用户第一次点开桌宠
  //    时才会被 buildDialog() 懒加载到 DOM。所以不能用「一次性轮询 + 超时放弃」——
  //    那样页面加载后 90s 内没点开海小棠，chip 就再也注入不进去，入口就「没了」。
  //    这里改用 MutationObserver 持久监听，快捷区一出现立即注入（注入自带去重，安全）。
  function whenChipsReady(cb) {
    var chips = document.querySelector("[data-hxt-chips]");
    if (chips) { cb(chips); return; }
    if (typeof MutationObserver === "undefined") {
      // 老浏览器降级：无限轮询，不设放弃上限
      var timer = setInterval(function () {
        var c = document.querySelector("[data-hxt-chips]");
        if (c) { clearInterval(timer); cb(c); }
      }, 500);
      return;
    }
    var mo = new MutationObserver(function () {
      var c = document.querySelector("[data-hxt-chips]");
      if (c) { mo.disconnect(); cb(c); }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // 2) 注入 chip（去重，防止多次挂载）
  function injectChip(chips) {
    if (chips.querySelector('[data-hxt-quick="' + CHIP_KEY + '"]')) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hxt-dchip";
    btn.setAttribute("data-hxt-quick", CHIP_KEY);
    btn.textContent = "📮 校园速递";
    btn.addEventListener("click", function () {
      openPanel();
    });
    chips.appendChild(btn);
  }

  // 3) 面板（overlay）
  var overlay = null;
  var panel = null;
  var currentCat = "";
  var styleInjected = false;

  function ensureStyle() {
    if (styleInjected) return;
    styleInjected = true;
    var s = document.createElement("style");
    s.textContent =
      "#hxtcf-overlay{position:fixed;inset:0;z-index:99990;display:flex;" +
      "align-items:center;justify-content:center;background:rgba(15,17,23,.5);" +
      "backdrop-filter:blur(2px);font-family:-apple-system,BlinkMacSystemFont," +
      "'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;}" +
      "#hxtcf-panel{width:min(680px,92vw);max-height:84vh;display:flex;flex-direction:column;" +
      "background:#fff;color:#1c1e26;border-radius:16px;box-shadow:0 18px 60px rgba(0,0,0,.35);" +
      "overflow:hidden;}" +
      "#hxtcf-head{display:flex;align-items:center;gap:10px;padding:14px 16px;flex:0 0 auto;" +
      "border-bottom:1px solid #ececf1;}" +
      "#hxtcf-title{font-weight:700;font-size:calc(16px * var(--font-scale, 1));}" +
      "#hxtcf-meta{color:#8a8f9c;font-size:calc(12px * var(--font-scale, 1));}" +
      "#hxtcf-head .spacer{flex:1;}" +
      "#hxtcf-follows,#hxtcf-refresh,#hxtcf-close{border:none;background:#f1f2f6;color:#3a3d4a;" +
      "border-radius:9px;padding:6px 12px;font-size:calc(13px * var(--font-scale, 1));cursor:pointer;}" +
      "#hxtcf-follows:hover,#hxtcf-refresh:hover,#hxtcf-close:hover{background:#e6e8ef;}" +
      "#hxtcf-refresh:disabled{opacity:.55;cursor:default;}" +
      "#hxtcf-cats{display:flex;flex-wrap:wrap;gap:6px;padding:10px 16px;flex:0 0 auto;" +
      "border-bottom:1px solid #f0f1f5;max-height:160px;overflow-y:auto;}" +
      "#hxtcf-cats::-webkit-scrollbar{width:6px;}" +
      "#hxtcf-cats::-webkit-scrollbar-thumb{background:#d9dbe4;border-radius:3px;}" +
      ".hxtcf-cat{border:1px solid #e2e4ea;background:#fafbfc;color:#4a4d58;" +
      "border-radius:999px;padding:4px 11px;font-size:calc(12px * var(--font-scale, 1));cursor:pointer;white-space:nowrap;}" +
      ".hxtcf-cat.active{background:#3a6df0;color:#fff;border-color:#3a6df0;}" +
      ".hxtcf-cat .n{opacity:.7;margin-left:4px;}" +
      "#hxtcf-list{overflow:auto;padding:6px 8px 12px;flex:1;}" +
      ".hxtcf-item{padding:11px 10px;border-radius:11px;}" +
      ".hxtcf-item:hover{background:#f6f7fb;}" +
      ".hxtcf-row1{display:flex;align-items:baseline;gap:8px;}" +
      ".hxtcf-account{font-size:calc(12px * var(--font-scale, 1));color:#3a6df0;font-weight:600;white-space:nowrap;}" +
      ".hxtcf-time{font-size:calc(11px * var(--font-scale, 1));color:#9aa0ad;margin-left:auto;white-space:nowrap;}" +
      ".hxtcf-title{display:block;font-size:calc(14px * var(--font-scale, 1));color:#1c1e26;text-decoration:none;" +
      "font-weight:600;margin-top:3px;line-height:1.45;}" +
      ".hxtcf-title:hover{color:#3a6df0;text-decoration:underline;}" +
      ".hxtcf-digest{font-size:calc(12.5px * var(--font-scale, 1));color:#6a6f7b;margin-top:4px;line-height:1.5;" +
      "display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}" +
      ".hxtcf-empty,.hxtcf-error{padding:32px 16px;text-align:center;color:#8a8f9c;font-size:calc(14px * var(--font-scale, 1));}" +
      ".hxtcf-error{color:#d2484a;}" +
      "#hxtcf-loading{padding:28px 16px;text-align:center;color:#9aa0ad;font-size:calc(13px * var(--font-scale, 1));}" +
      "#hxtcf-follows-pane{flex:1;overflow-y:auto;padding:10px 16px 16px;display:none;}" +
      "#hxtcf-follows-pane::-webkit-scrollbar{width:6px;}" +
      "#hxtcf-follows-pane::-webkit-scrollbar-thumb{background:#d9dbe4;border-radius:3px;}" +
      ".hxtcf-fs-top{display:flex;align-items:center;gap:8px;padding:2px 0 10px;}" +
      ".hxtcf-fs-stat{font-size:calc(13px * var(--font-scale, 1));color:#4a4d58;}" +
      ".hxtcf-fs-top .spacer{flex:1;}" +
      ".hxtcf-fs-all{border:1px solid #e2e4ea;background:#fafbfc;color:#4a4d58;border-radius:9px;" +
      "padding:5px 10px;font-size:calc(12px * var(--font-scale, 1));cursor:pointer;white-space:nowrap;}" +
      ".hxtcf-fs-all:hover{background:#e6e8ef;}" +
      ".hxtcf-fs-cat{font-size:calc(12px * var(--font-scale, 1));color:#8a8f9c;font-weight:700;" +
      "margin:12px 0 4px;}" +
      ".hxtcf-fs-row{display:flex;align-items:center;gap:10px;padding:8px 4px;" +
      "border-bottom:1px solid #f2f3f7;}" +
      ".hxtcf-fs-info{min-width:0;}" +
      ".hxtcf-fs-name{font-size:calc(13.5px * var(--font-scale, 1));font-weight:600;color:#1c1e26;}" +
      ".hxtcf-fs-focus{font-size:calc(11.5px * var(--font-scale, 1));color:#9aa0ad;margin-top:2px;" +
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}" +
      ".hxtcf-fs-toggle{margin-left:auto;flex:0 0 auto;border:1px solid #e2e4ea;background:#fafbfc;" +
      "color:#8a8f9c;border-radius:999px;padding:4px 12px;font-size:calc(12px * var(--font-scale, 1));cursor:pointer;}" +
      ".hxtcf-fs-toggle.on{background:#e8effd;border-color:#3a6df0;color:#3a6df0;}" +
      ".hxtcf-fs-toggle:hover{border-color:#3a6df0;}" +
      ".hxtcf-fs-empty{padding:28px 12px;text-align:center;color:#8a8f9c;font-size:calc(13px * var(--font-scale, 1));}";
    document.head.appendChild(s);
  }

  function buildOverlay() {
    ensureStyle();
    overlay = document.createElement("div");
    overlay.id = "hxtcf-overlay";
    overlay.innerHTML =
      '<div id="hxtcf-panel" role="dialog" aria-label="校园速递">' +
      '<div id="hxtcf-head">' +
      '<span id="hxtcf-title">📮 校园速递</span>' +
      '<span id="hxtcf-meta"></span>' +
      '<span class="spacer"></span>' +
      '<button id="hxtcf-follows" type="button">👥 关注</button>' +
      '<button id="hxtcf-refresh" type="button">↻ 刷新</button>' +
      '<button id="hxtcf-close" type="button" aria-label="关闭">×</button>' +
      "</div>" +
      '<div id="hxtcf-cats"></div>' +
      '<div id="hxtcf-list"><div id="hxtcf-loading">加载中…</div></div>' +
      '<div id="hxtcf-follows-pane"></div>' +
      "</div>";
    document.body.appendChild(overlay);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closePanel();
    });
    overlay.querySelector("#hxtcf-close").addEventListener("click", closePanel);
    var refreshBtn = overlay.querySelector("#hxtcf-refresh");
    refreshBtn.addEventListener("click", function () {
      refreshBtn.disabled = true;
      refreshBtn.textContent = "抓取中…";
      fetch("/api/hxt/feed/refresh", { method: "POST", credentials: "same-origin" })
        .then(function () { return reload(); })
        .catch(function () { refreshBtn.disabled = false; refreshBtn.textContent = "↻ 刷新"; })
        .then(function () { refreshBtn.disabled = false; refreshBtn.textContent = "↻ 刷新"; });
    });
    overlay.querySelector("#hxtcf-follows").addEventListener("click", toggleFollows);
  }

  function openPanel() {
    if (!overlay) buildOverlay();
    overlay.style.display = "flex";
    reload();
  }

  function closePanel() {
    if (overlay) overlay.style.display = "none";
  }

  function render(data) {
    if (!overlay) return;
    var meta = overlay.querySelector("#hxtcf-meta");
    var catsEl = overlay.querySelector("#hxtcf-cats");
    var listEl = overlay.querySelector("#hxtcf-list");

    var ok = data && data.ok;
    var items = (data && data.items) || [];
    meta.textContent =
      (ok ? "更新于 " + (data.updated_text || "—") : "暂不可用") +
      (ok ? " · " + (data.accounts || 0) + " 个号 · " + (data.total || 0) + " 条" : "");

    // 分类筛选条
    var cats = (data && data.categories) || [];
    var html = '<button class="hxtcf-cat' + (currentCat === "" ? " active" : "") +
      '" data-cat="">全部<span class="n">' + (data && data.total || 0) + "</span></button>";
    for (var i = 0; i < cats.length; i++) {
      var c = cats[i];
      html += '<button class="hxtcf-cat' + (currentCat === c.cat ? " active" : "") +
        '" data-cat="' + escAttr(c.cat) + '">' + escHtml(c.cat) +
        '<span class="n">' + (c.items || 0) + "</span></button>";
    }
    catsEl.innerHTML = html;
    catsEl.onclick = function (e) {
      var b = e.target.closest ? e.target.closest("[data-cat]") : null;
      if (!b) return;
      currentCat = b.getAttribute("data-cat") || "";
      renderCatsActive(catsEl);
      reload();
    };

    // 列表
    if (!ok) {
      listEl.innerHTML = '<div class="hxtcf-error">' +
        ((data && data.message) || "读取订阅库失败，稍后再试。") + "</div>";
      return;
    }
    if (!items.length) {
      listEl.innerHTML = '<div class="hxtcf-empty">这个分类下还没有推文～<br>' +
        "点「刷新」去官网列表页收一波新内容。</div>";
      return;
    }
    var rows = "";
    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      var url = it.url || "";
      var title = it.title || "(无标题)";
      var titleHtml = url
        ? '<a class="hxtcf-title" href="' + escAttr(url) +
          '" target="_blank" rel="noopener noreferrer">' + escHtml(title) + "</a>"
        : '<span class="hxtcf-title">' + escHtml(title) + "</span>";
      var digest = it.digest
        ? '<div class="hxtcf-digest">' + escHtml(it.digest) + "</div>"
        : "";
      rows +=
        '<div class="hxtcf-item">' +
        '<div class="hxtcf-row1">' +
        '<span class="hxtcf-account">' + escHtml(it.account || "微信公众号") + "</span>" +
        '<span class="hxtcf-time">' + escHtml(it.time_text || "") + "</span>" +
        "</div>" +
        titleHtml +
        digest +
        "</div>";
    }
    listEl.innerHTML = rows;
  }

  function renderCatsActive(catsEl) {
    var bs = catsEl.querySelectorAll("[data-cat]");
    for (var k = 0; k < bs.length; k++) {
      var v = bs[k].getAttribute("data-cat") || "";
      if (v === currentCat) bs[k].classList.add("active");
      else bs[k].classList.remove("active");
    }
  }

  function reload() {
    if (!overlay) return Promise.resolve();
    var listEl = overlay.querySelector("#hxtcf-list");
    listEl.innerHTML = '<div id="hxtcf-loading">加载中…</div>';
    var qs = "limit=120" + (currentCat ? "&category=" + encodeURIComponent(currentCat) : "");
    return fetch("/api/hxt/feed?" + qs, { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function (err) {
        listEl.innerHTML = '<div class="hxtcf-error">网络错误：' + escHtml(String(err)) + "</div>";
      });
  }

  function escHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) {
    return escHtml(s).replace(/"/g, "&quot;");
  }

  // 4) 关注管理：列出全部登记号 + 关注开关。
  //    数据 /api/hxt/wx-accounts，写入 /api/hxt/wx-follows（后端落 data/wx_follows.json）；
  //    取消关注的号会从速递列表里消失（后端 feed_payload 按 is_followed 过滤）。
  var followsOpen = false;

  function toggleFollows() {
    if (!overlay) return;
    followsOpen = !followsOpen;
    var pane = overlay.querySelector("#hxtcf-follows-pane");
    var cats = overlay.querySelector("#hxtcf-cats");
    var list = overlay.querySelector("#hxtcf-list");
    var btn = overlay.querySelector("#hxtcf-follows");
    var refreshBtn = overlay.querySelector("#hxtcf-refresh");
    if (followsOpen) {
      cats.style.display = "none";
      list.style.display = "none";
      refreshBtn.style.display = "none";
      pane.style.display = "block";
      btn.textContent = "← 返回速递";
      loadFollows();
    } else {
      pane.style.display = "none";
      cats.style.display = "";
      list.style.display = "";
      refreshBtn.style.display = "";
      btn.textContent = "👥 关注";
      reload(); // 关注状态可能变了：重拉速递（取消关注的号从列表消失、计数刷新）
    }
  }

  function loadFollows() {
    if (!overlay) return;
    var pane = overlay.querySelector("#hxtcf-follows-pane");
    pane.innerHTML = '<div class="hxtcf-fs-empty">加载中…</div>';
    fetch("/api/hxt/wx-accounts", { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (data) { if (followsOpen) renderFollows(data || {}); })
      .catch(function (err) {
        pane.innerHTML = '<div class="hxtcf-fs-empty">网络错误：' + escHtml(String(err)) + "</div>";
      });
  }

  function renderFollows(data) {
    var pane = overlay.querySelector("#hxtcf-follows-pane");
    if (!pane) return;
    var st = data.follow || {};
    var accounts = data.accounts || [];
    var groups = {};   // cat -> [account]（后端已按 类别→tier→名称 排好序，按出现顺序分组即保持）
    var order = [];
    for (var i = 0; i < accounts.length; i++) {
      var a = accounts[i];
      if (!groups[a.cat]) { groups[a.cat] = []; order.push(a.cat); }
      groups[a.cat].push(a);
    }
    var html =
      '<div class="hxtcf-fs-top">' +
      '<span class="hxtcf-fs-stat">已关注 <b>' + (st.followed || 0) + "</b> / " +
      (st.total || accounts.length) + " 个号 · 取消关注的号不再出现在速递里</span>" +
      '<span class="spacer"></span>' +
      '<button class="hxtcf-fs-all" data-all="1" type="button">全部关注</button>' +
      '<button class="hxtcf-fs-all" data-all="0" type="button">全部取消</button>' +
      "</div>";
    for (var c = 0; c < order.length; c++) {
      var cat = order[c];
      html += '<div class="hxtcf-fs-cat">' + escHtml(cat) + " · " + groups[cat].length + "</div>";
      for (var j = 0; j < groups[cat].length; j++) {
        var it = groups[cat][j];
        var focusTxt = (it.focus || []).slice(0, 4).join(" · ");
        html +=
          '<div class="hxtcf-fs-row">' +
          '<div class="hxtcf-fs-info">' +
          '<div class="hxtcf-fs-name">' + escHtml(it.name || "") + "</div>" +
          (focusTxt ? '<div class="hxtcf-fs-focus">' + escHtml(focusTxt) + "</div>" : "") +
          "</div>" +
          '<button class="hxtcf-fs-toggle' + (it.followed ? " on" : "") +
          '" data-name="' + escAttr(it.name || "") +
          '" data-followed="' + (it.followed ? "1" : "0") +
          '" type="button">' + (it.followed ? "已关注 ✓" : "＋ 关注") + "</button>" +
          "</div>";
      }
    }
    pane.innerHTML = html;

    // 单条切换 + 全部快捷（事件委托，重渲染不重绑）
    pane.onclick = function (e) {
      var all = e.target.closest ? e.target.closest("[data-all]") : null;
      if (all) {
        postFollows({ all: true, follow: all.getAttribute("data-all") === "1" });
        return;
      }
      var t = e.target.closest ? e.target.closest("[data-name]") : null;
      if (!t) return;
      postFollows({
        name: t.getAttribute("data-name") || "",
        follow: t.getAttribute("data-followed") !== "1",
      });
    };
  }

  function postFollows(body) {
    if (!overlay) return;
    var pane = overlay.querySelector("#hxtcf-follows-pane");
    fetch("/api/hxt/wx-follows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res && res.ok === false && res.message) {
          pane.innerHTML = '<div class="hxtcf-fs-empty">' + escHtml(res.message) + "</div>";
          return;
        }
        loadFollows(); // 重拉清单（含最新关注状态与统计）
      })
      .catch(function (err) {
        pane.innerHTML = '<div class="hxtcf-fs-empty">保存失败：' + escHtml(String(err)) + "</div>";
      });
  }

  // 启动
  whenChipsReady(injectChip);
  // 暴露给控制台调试
  window.__hxtCampusFeed = { open: openPanel, close: closePanel };
})();
