/* =====================================================
   知源（KnowOrigin）· 全屏显示 —— 一键把整个界面铺满电脑屏幕
   ------------------------------------------------------
   给 #agent-rail 注入一个按钮，点它走浏览器 Fullscreen API
   （document.documentElement 进全屏），把地址栏 / 标签栏 / 任务栏之外的所有
   知源界面铺满整块屏幕。退出方式：再点一次这个按钮。

   ⚠️ Esc 的归属（本文件最讲究的一处）
   全屏下按 Esc 退出是**浏览器 chrome 层**的强制行为，网页用 keydown + preventDefault
   拦不住（规范如此：任何站点都不能把用户锁死在全屏里）。
   但它会抢在页面自己的 Esc 之前 —— 神经图谱逐层返回、卡片查看器关闭、划词浮层收起，
   这些浮层都指望这一个键，按下去却先把全屏退掉，很打断。
   解法是 Keyboard Lock：navigator.keyboard.lock(['Escape'])
     · 它挡的是「浏览器对 Escape 的默认处理」→ 全屏不再被 Esc 退出；
     · keydown 照常派发给页面 → 页面自己的 Esc 语义一条不少。
   本机 Chrome 已实测该 API 存在；Firefox / Safari 没有它，那边退回原样
   （Esc 仍会退出全屏，功能不受影响，只是这条「不抢键」的优化失效）。

   唯一要避开的坑：原生 <dialog> 的 Esc 关闭走的也是「浏览器默认处理」，
   锁着 Escape 会让设置 / 新建项目这类弹窗在全屏下按 Esc 关不掉。
   所以有 dialog[open] 时临时解锁，全部关掉后再锁回来（MutationObserver 盯 open 属性）。

   为什么挂 #agent-rail：
   1. 复用 .agent-rail-btn / .agent-rail-glyph 现有类 —— 零新 CSS，
      外观、悬停、音效、深色模式全部跟图标栏其它按钮一致；
   2. #agent-rail 已在 app.js 的「点击背板」白名单里（closeStudioFocusFromBackdrop），
      点它不会被误判成「点空白收起全屏学习产出」；
   3. agent-shell.js 的 rail 统一点击处理只认 data-agent-feature / module / action，
      本按钮不带这三个属性，不会被它抢走。

   与界面整体缩放（--ui-scale）的关系：全屏会改变可视高度，浏览器自派 resize，
   app.js 的 resize 监听会同步 --vw/--vh；这里再广播一次 knoworigin:ui-scale，
   让「贴边浮层按新视口夹回屏内」的那批监听者（桌宠 / 划词气泡 / 右键菜单）也跟上。

   回退：删掉 static/index.html 里引入本文件的那一行即可，无其它残留。
   ===================================================== */
(function () {
  if (window.__koFullscreenReady) return;
  window.__koFullscreenReady = true;

  var doc = document;
  var root = doc.documentElement;
  var request = root.requestFullscreen || root.webkitRequestFullscreen;
  var exit = doc.exitFullscreen || doc.webkitExitFullscreen;
  // iOS Safari 等不支持元素级全屏，注入了也只能点了没反应 —— 干脆不注入
  if (!request || !exit) return;

  // Chrome 系才有 Keyboard Lock；拿不到就跳过「不抢 Esc」这条优化，其余功能照旧
  var kbd = navigator.keyboard;

  // 四角箭头向内 = 进入全屏；向外 = 退出全屏
  var ICON_IN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
  var ICON_OUT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>';

  function isFull() {
    return Boolean(doc.fullscreenElement || doc.webkitFullscreenElement);
  }

  // —— Esc 归属：全屏期间把 Escape 锁给页面自己，别的界面照常收 Esc ——
  function hasNativeDialog() {
    return Boolean(doc.querySelector("dialog[open]"));
  }
  function syncEscLock() {
    if (!kbd || typeof kbd.lock !== "function") return;
    try {
      if (isFull() && !hasNativeDialog()) {
        // 有原生弹窗开着就先不锁：它的 Esc 关闭要靠浏览器默认处理
        var p = kbd.lock(["Escape"]);
        if (p && typeof p.catch === "function") p.catch(function () {});
      } else if (typeof kbd.unlock === "function") {
        kbd.unlock();
      }
    } catch (e) { /* 个别实现会抛，忽略即可，不影响全屏本身 */ }
  }

  var btn = doc.createElement("button");
  btn.type = "button";
  btn.id = "ko-fullscreen-btn";
  btn.className = "agent-rail-btn";
  btn.innerHTML = '<span class="agent-rail-glyph" data-ko-fs-glyph>' + ICON_IN + "</span>";

  function paint() {
    var on = isFull();
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.setAttribute("aria-label", on ? "退出全屏" : "全屏显示");
    btn.title = on ? "退出全屏：再点一次还原" : "全屏显示：让知源占满整块屏幕";
    btn.classList.toggle("is-active", on);
    var glyph = btn.querySelector("[data-ko-fs-glyph]");
    if (glyph) glyph.innerHTML = on ? ICON_OUT : ICON_IN;
  }

  btn.addEventListener("click", function () {
    var p = isFull() ? exit.call(doc) : request.call(root);
    // 被浏览器拒绝（非用户手势 / 权限策略）：静默，不弹错
    if (p && typeof p.catch === "function") p.catch(function () {});
  });

  ["fullscreenchange", "webkitfullscreenchange"].forEach(function (name) {
    doc.addEventListener(name, function () {
      if (!btn.isConnected) return;
      paint();
      syncEscLock();
      var api = window.KnowOriginUiScale;
      doc.dispatchEvent(new CustomEvent("knoworigin:ui-scale", {
        detail: { scale: api && api.scale ? api.scale() : 1 },
      }));
    });
  });

  // 原生弹窗开 / 关时重算锁：开着 → 解锁让 Esc 能关它；关完 → 锁回来
  if (kbd && typeof kbd.lock === "function" && window.MutationObserver) {
    new MutationObserver(function () {
      if (isFull()) syncEscLock();
    }).observe(root, { subtree: true, attributes: true, attributeFilter: ["open"] });
  }

  function mount() {
    var rail = doc.getElementById("agent-rail");
    if (!rail || doc.getElementById("ko-fullscreen-btn")) return Boolean(rail);
    var settings = rail.querySelector('[data-agent-action="settings"]');
    // 插在「设置」上方：它俩同属图标栏底部那一簇（中间隔着 .agent-rail-spring）
    if (settings) rail.insertBefore(btn, settings);
    else rail.appendChild(btn);
    paint();
    return true;
  }

  // rail 是静态 HTML，正常此时已在；万一没有（脚本被提前执行）等一帧再试
  if (!mount()) {
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", mount);
    else setTimeout(mount, 0);
  }
})();
