/**
 * AI 用量（token 消耗）—— 挂在**聊天输入框旁边**的一个入口 + 浮层。
 *
 * 2026-09-25 从原来那个「通知中心 + AI 用量」的合并入口里拆出来：
 *   **通知中心整块删掉**（未读角标 / 列表 / 全部已读 / 清空 / 逐条删除），
 *   用量留下来，并且换了个位置 —— 从顶部工具栏挪到输入框旁。
 *
 * 为什么用量该在输入框旁：token 消耗是「我这一句话会花掉多少」的即时反馈，
 * 用户在**打字的时候**最该看到它；挂在顶部工具栏等于把它归进「关于账号的事情」，
 * 而它其实是关于**这次对话**的事情。同一条逻辑已经把「教学模式」「AI 记忆」放到了这里。
 *
 * 口径：后端返回的是**估算值**（用于发现异常消耗，不是账单）—— 界面必须如实标注，
 * 这是 `/api/usage/me` 的 docstring 里明确要求前端遵守的，别把估算写成账单。
 *
 * 约定（与其它叠加层一致）：
 *   - 不碰 app.js / styles.css；本文件自带样式注入，删掉 index.html 里那一行脚本即完全回退。
 *   - 只写主题变量（--panel/--ink/--line/--muted/--green/--gold/--red），深浅色与两套品牌自动适配。
 *   - ⚠️ 浮层用 position:fixed 挂在 document.body 上，靠 getBoundingClientRect() 对齐按钮 ——
 *     不做成 .composer 的子元素，因为父链上任何一层 overflow/transform 都会把浮层裁掉或夹住。
 *   - ⚠️ 模块内状态变量叫 view，**绝不能叫 state** —— 那会遮蔽 app.js 的全局 state。
 */
(function () {
  "use strict";

  var STYLE_ID = "ko-usage-style";
  var POP_ATTR = "data-ko-usage-pop";
  var OPEN_ATTR = "data-ko-usage-open";
  var API = "/api/usage/me?days=14";

  var view = {
    usage: null,
    loaded: false,
    loading: false,
    open: false,
  };

  // ---------------------------------------------------------------- 工具 --

  function esc(value) {
    try {
      return escapeHtml(String(value == null ? "" : value));
    } catch (error) {
      var node = document.createElement("div");
      node.textContent = String(value == null ? "" : value);
      return node.innerHTML;
    }
  }

  function call(path, options) {
    var opts = options || {};
    var init = { method: opts.method || "GET" };
    if (opts.body !== undefined && opts.body !== null) {
      init.body =
        typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
      init.headers = { "Content-Type": "application/json" };
    }
    if (typeof api === "function") return api(path, init);
    return fetch(path, Object.assign({ credentials: "same-origin" }, init)).then(
      function (response) {
        return response.json().catch(function () {
          return {};
        });
      }
    );
  }

  function formatTokens(value) {
    var number = Number(value) || 0;
    if (number >= 1000000) return (number / 1000000).toFixed(1) + "M";
    if (number >= 1000) return (number / 1000).toFixed(1) + "k";
    return String(number);
  }

  /** 今日用量占每日上限的比例；没设上限或没数据时返回 0。 */
  function quotaRatio() {
    var usage = view.usage;
    if (!usage) return 0;
    var quota = Number(usage.quota) || 0;
    if (quota <= 0) return 0;
    return Math.min(1, (Number(usage.today_tokens) || 0) / quota);
  }

  function popNode() {
    return document.querySelector("[" + POP_ATTR + "]");
  }

  // ---------------------------------------------------------------- 样式 --

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      // —— 输入框旁的入口（.composer-tools 里，与教学模式/记忆并排）——
      ".ko-usage-trigger{display:inline-flex;align-items:center;gap:4px;height:28px;",
      "box-sizing:border-box;border:1px solid var(--line);border-radius:8px;",
      "background:transparent;color:var(--muted);padding:0 9px;font-size:calc(11.5px * var(--font-scale, 1));",
      "cursor:pointer;font-family:inherit;white-space:nowrap;flex:0 0 auto}",
      ".ko-usage-trigger:hover{color:var(--ink);border-color:var(--muted)}",
      ".ko-usage-trigger.is-on{border-color:var(--green);color:var(--green)}",
      ".ko-usage-trigger.is-warn{border-color:var(--gold);color:var(--gold)}",
      ".ko-usage-trigger.is-danger{border-color:var(--red);color:var(--red)}",
      ".ko-usage-trigger .ko-usage-ic{font-size:calc(11px * var(--font-scale, 1));line-height:1}",

      // —— 浮层：fixed 挂 body，从按钮上方弹出 ——
      ".ko-usage-pop{position:fixed;z-index:200;background:var(--panel);color:var(--ink);",
      "border:1px solid var(--line);border-radius:14px;font-family:inherit;",
      "box-shadow:0 18px 48px rgba(29,28,24,.22);padding:12px 13px;overflow-y:auto}",
      ".ko-usage-pop[hidden]{display:none}",
      ".ko-usage-pop-head{display:flex;align-items:baseline;justify-content:space-between;",
      "gap:8px;font-size:calc(12.5px * var(--font-scale, 1));font-weight:500;margin-bottom:9px}",
      ".ko-usage-pop-head span:last-child{font-size:calc(11px * var(--font-scale, 1));color:var(--muted);font-weight:400}",

      ".ko-usage-bar{height:6px;border-radius:999px;background:var(--line);overflow:hidden}",
      ".ko-usage-bar > i{display:block;height:100%;background:var(--green);border-radius:999px}",
      ".ko-usage-bar > i.ko-warn{background:var(--gold)}",
      ".ko-usage-bar > i.ko-danger{background:var(--red)}",
      ".ko-usage-sub{font-size:calc(11px * var(--font-scale, 1));color:var(--muted);margin-top:7px;line-height:1.65}",

      ".ko-usage-spark{display:flex;align-items:flex-end;gap:3px;height:30px;margin:11px 0 5px}",
      ".ko-usage-spark > span{flex:1;min-height:2px;background:var(--green);opacity:.5;",
      "border-radius:2px 2px 0 0}",
      ".ko-usage-spark > span.ko-today{opacity:1}",
      ".ko-usage-spark-labels{display:flex;justify-content:space-between;",
      "font-size:calc(9.5px * var(--font-scale, 1));color:var(--muted)}",

      ".ko-usage-foot{border-top:1px solid var(--line);margin-top:10px;padding-top:9px;",
      "font-size:calc(11px * var(--font-scale, 1));color:var(--muted);line-height:1.7}",
    ].join("\n");
    document.head.appendChild(style);
  }

  // ------------------------------------------------------------ 输入框入口 --

  function ensureTrigger() {
    var host = document.querySelector(".composer-tools");
    if (!host) return;
    var existing = host.querySelector("[" + OPEN_ATTR + "]");
    if (existing) {
      renderTrigger(existing);
      return;
    }
    var button = document.createElement("button");
    button.type = "button";
    button.className = "ko-usage-trigger";
    button.setAttribute(OPEN_ATTR, "1");
    // 用真实 DOM 节点拼，不拼 HTML 字符串：按钮上的数字每次都要重写，
    // 节点方式不需要重新解析，也不引入注入面。
    var icon = document.createElement("span");
    icon.className = "ko-usage-ic";
    icon.textContent = "⚡";
    var label = document.createElement("span");
    label.setAttribute("data-ko-usage-label", "1");
    label.textContent = "用量";
    button.appendChild(icon);
    button.appendChild(label);
    button.addEventListener("click", function (event) {
      event.stopPropagation();
      toggle();
    });
    host.appendChild(button);
    renderTrigger(button);
    // 按钮上要显示今日数字，所以"输入框一出现"就静默取一次；之后只在打开浮层时重取。
    if (!view.loaded && !view.loading) load();
  }

  function renderTrigger(button) {
    var node = button || document.querySelector("[" + OPEN_ATTR + "]");
    if (!node) return;
    var label = node.querySelector("[data-ko-usage-label]");
    if (!label) return;
    var usage = view.usage;
    if (!usage || usage.tracking_enabled === false) {
      label.textContent = "用量";
    } else {
      label.textContent = formatTokens(usage.today_tokens);
    }
    // 接近上限时给按钮染色 —— 跑长任务前扫一眼就知道还够不够，不用点开
    var ratio = quotaRatio();
    node.classList.toggle("is-warn", ratio >= 0.7 && ratio < 0.9);
    node.classList.toggle("is-danger", ratio >= 0.9);
    node.classList.toggle("is-on", view.open);
    var quota = Number((usage || {}).quota) || 0;
    node.title =
      !usage
        ? "AI 用量"
        : usage.tracking_enabled === false
          ? "用量记账已关闭"
          : quota > 0
            ? "今日 " + formatTokens(usage.today_tokens) + " / " + formatTokens(quota) + " tokens"
            : "今日 " + formatTokens(usage.today_tokens) + " tokens（未设上限）";
  }

  // ---------------------------------------------------------------- 浮层 --

  function ensurePop() {
    var existing = popNode();
    if (existing) return existing;
    if (!document.body) return null;
    var pop = document.createElement("div");
    pop.className = "ko-usage-pop";
    pop.setAttribute(POP_ATTR, "1");
    pop.hidden = true;
    document.body.appendChild(pop);
    // 拦住冒泡，让「点外部关闭」只认真正的外部点击
    pop.addEventListener("click", function (event) {
      event.stopPropagation();
    });
    return pop;
  }

  function place() {
    var pop = popNode();
    var trigger = document.querySelector("[" + OPEN_ATTR + "]");
    if (!pop || !trigger || pop.hidden) return;
    var rect = trigger.getBoundingClientRect();
    var width = Math.min(300, Math.max(220, window.innerWidth - 24));
    pop.style.width = width + "px";
    pop.style.maxHeight = Math.min(420, Math.round(window.innerHeight * 0.6)) + "px";
    var maxLeft = window.innerWidth - width - 12;
    pop.style.left = Math.min(Math.max(12, rect.left), Math.max(12, maxLeft)) + "px";
    // 从按钮上方弹出：bottom 视口距离 = 视口高 - 按钮顶边 + 8px
    pop.style.bottom = Math.max(12, window.innerHeight - rect.top + 8) + "px";
  }

  function render() {
    var pop = popNode();
    if (!pop) return;
    var usage = view.usage;

    if (!usage) {
      pop.innerHTML =
        '<div class="ko-usage-pop-head"><span>AI 用量</span></div>' +
        '<div class="ko-usage-sub">' +
        (view.loading ? "正在读取用量…" : "暂时读不到用量数据。") +
        "</div>";
      place();
      return;
    }

    if (usage.tracking_enabled === false) {
      pop.innerHTML =
        '<div class="ko-usage-pop-head"><span>AI 用量</span></div>' +
        '<div class="ko-usage-sub">用量记账已在 <b>.env</b> 里关闭' +
        "（<b>KNOWORIGIN_USAGE_TRACKING=false</b>）。开启后这里会显示每天消耗了多少 token。</div>";
      place();
      return;
    }

    var today = Number(usage.today_tokens) || 0;
    var quota = Number(usage.quota) || 0;
    var ratio = quotaRatio();
    var level = ratio >= 0.9 ? "ko-danger" : ratio >= 0.7 ? "ko-warn" : "";

    var html =
      '<div class="ko-usage-pop-head"><span>今日 AI 用量</span><span>' +
      esc(formatTokens(today)) +
      (quota > 0 ? " / " + esc(formatTokens(quota)) : "") +
      "</span></div>";

    if (quota > 0) {
      html +=
        '<div class="ko-usage-bar"><i class="' +
        level +
        '" style="width:' +
        Math.max(2, Math.round(ratio * 100)) +
        '%"></i></div>' +
        '<div class="ko-usage-sub">还剩 ' +
        esc(formatTokens(Math.max(0, quota - today))) +
        " tokens，明天零点重置。</div>";
    } else {
      html +=
        '<div class="ko-usage-sub">未设每日上限。想限制额度就在 .env 里填 ' +
        "<b>KNOWORIGIN_USAGE_DAILY_QUOTA</b>（单位 tokens）。</div>";
    }

    var daily = usage.daily || [];
    if (daily.length > 1) {
      var peak = daily.reduce(function (max, item) {
        return Math.max(max, Number(item.tokens) || 0);
      }, 1);
      var series = daily.slice(0, 14).reverse();
      var bars = series
        .map(function (item, index) {
          var height = Math.max(2, Math.round(((Number(item.tokens) || 0) / peak) * 30));
          return (
            '<span class="' +
            (index === series.length - 1 ? "ko-today" : "") +
            '" style="height:' +
            height +
            'px" title="' +
            esc(item.day) +
            "：" +
            esc(formatTokens(item.tokens)) +
            ' tokens"></span>'
          );
        })
        .join("");
      html +=
        '<div class="ko-usage-spark">' +
        bars +
        "</div>" +
        '<div class="ko-usage-spark-labels"><span>' +
        esc(String(series[0] && series[0].day || "").slice(5)) +
        "</span><span>今天</span></div>";
    }

    html +=
      '<div class="ko-usage-foot">近 ' +
      esc(String(usage.window_days || 7)) +
      " 天 " +
      esc(formatTokens(usage.window_tokens)) +
      " tokens · " +
      esc(String(usage.window_calls || 0)) +
      " 次调用。<br>数字是<b>估算值</b>，用来发现异常消耗，不是账单。</div>";

    pop.innerHTML = html;
    place();
  }

  function open() {
    var pop = ensurePop();
    if (!pop) return;
    view.open = true;
    pop.hidden = false;
    render();          // 先用已有数据渲染，避免点开是空的
    place();
    renderTrigger();
    load();            // 再重取一次，保证是刚才那一刻的真实数字
  }

  function close() {
    var pop = popNode();
    if (pop) pop.hidden = true;
    view.open = false;
    renderTrigger();
  }

  function toggle() {
    if (view.open) close();
    else open();
  }

  // ---------------------------------------------------------------- 数据 --

  function load() {
    if (view.loading) return Promise.resolve();
    view.loading = true;
    return call(API)
      .then(function (data) {
        if (data && typeof data === "object") view.usage = data;
        view.loaded = true;
      })
      .catch(function () {
        /* 静默：用量读不到不该打断任何事 */
      })
      .finally(function () {
        view.loading = false;
        render();
        renderTrigger();
      });
  }

  /**
   * 点浮层外面 / 按 Esc 关掉。
   * ⚠️ 入口按钮自己的 click 已经 stopPropagation，浮层内部也在浮层上被拦住；
   *    能走到这里的就都是"外部点击"。
   */
  function bindGlobal() {
    document.addEventListener("click", function (event) {
      if (!view.open) return;
      var trigger =
        event.target.closest && event.target.closest("[" + OPEN_ATTR + "]");
      if (trigger) return;
      close();
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && view.open) close();
    });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
  }

  /**
   * `.composer-tools` 只在**打开项目后**才存在（无项目时整个 composer 都不渲染），
   * 而 state.currentProjectId 随时可能变。用 DOM 观察 + 防抖，比轮询干净：
   * ensureTrigger 自带存在性判断，重复调用是廉价 no-op。
   */
  function watchComposer() {
    if (typeof MutationObserver !== "function" || !document.body) return;
    var pending = false;
    var observer = new MutationObserver(function () {
      if (pending) return;
      pending = true;
      setTimeout(function () {
        pending = false;
        ensureTrigger();
        // 浮层被外部原因移除时（例如整块 body 被重建）重新挂上，别让状态悬空
        if (view.open && !popNode()) {
          view.open = false;
          open();
        }
      }, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------- 启动 --

  function boot() {
    ensureStyle();
    ensureTrigger();
    ensurePop();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  document.addEventListener("DOMContentLoaded", function () {
    setTimeout(boot, 600);
  });
  setTimeout(boot, 2000);
  bindGlobal();
  watchComposer();

  window.KnowOriginUsage = { open: open, close: close, refresh: load, _view: view };
})();
