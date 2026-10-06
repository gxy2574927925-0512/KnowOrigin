/**
 * 间隔复习的「进度视图」—— 嵌在「学习概览」里的一张卡片。
 *
 * 这个视图**不做复习**。复习在知识卡片上直接发生（见 static/card-srs.js）：
 * 翻卡、自评，排期自动推进。这里只回答另一个问题：「我的复习节奏怎么样」——
 * 今天做了多少、积压多少、未来一周会不会突然堆成复习债。
 *
 * 为什么当初把它做成独立复习面板、后来改掉了：
 *   复习一旦有自己的一套界面，就变成"另一个要去的地方"。用户本来就在翻卡片，
 *   顺手评一下才是自然的；把人先拽到别处、再让他重新找到同一张卡，
 *   等于给一个本来不存在的步骤收费。两个入口做同一件事，
 *   还会让"今日已复习"这种数字出现两份口径。
 *
 * 2026-09-25 再次收口：原来它是学习产出区的一个独立页签（覆盖层视图）。
 * 改成**嵌进学习概览**，因为「复习节奏」和「掌握度分配/下一步队列」本来就是
 * 同一个问题（我现在学到哪了）的不同侧面，拆成两个页签等于把一份状态报告
 * 掰成两处看。概览本身就是纵向可滚动的版面，多一张卡片比多一个页签自然。
 *
 * 约定：不碰 app.js / styles.css；样式自带，删掉 index.html 那一行脚本即完全回退。
 * 卡片**复用概览既有的 .overview-panel 类** —— 它是纯样式类（app.js 不遍历它，
 * 交互只认 [data-overview-action]，我们不加这个属性），所以边框、圆角、
 * 浅色/深色主题配色都自动和相邻卡片一致，不需要自己维护颜色。
 *
 * ⚠️ 模块内状态变量叫 view，**不能叫 state** —— 那会遮蔽 app.js 的全局 state，
 * 导致读不到 state.currentProjectId。
 */
(function () {
  "use strict";

  var STYLE_ID = "ko-review-style";
  var CARD_ATTR = "data-ko-rv-embed";
  var API = "/api/review";
  var DASH_SELECTOR = "#studio-output .overview-dashboard";

  var view = {
    stats: null,
    forecast: [],
    recent: [],
    loading: false,
    loaded: false,
    error: "",
    projectId: "",
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

  function currentProjectId() {
    try {
      if (typeof state !== "undefined" && state && state.currentProjectId) {
        return String(state.currentProjectId);
      }
    } catch (error) {
      /* 拿不到就当作没有项目 */
    }
    return "";
  }

  function formatDays(days) {
    var value = Number(days) || 0;
    if (value < 1) return "今天再见";
    if (value < 30) return Math.round(value) + " 天";
    if (value < 365) return (value / 30).toFixed(1) + " 个月";
    return (value / 365).toFixed(1) + " 年";
  }

  // created_at 是 UTC ISO；直接截字符串会给用户看到差 8 小时的时间，
  // 所以过一遍 Date 再按本地时区显示。
  function localTime(iso) {
    var raw = String(iso || "");
    var parsed = new Date(raw);
    if (isNaN(parsed.getTime())) return raw.slice(5, 16).replace("T", " ");
    var pad = function (value) {
      return (value < 10 ? "0" : "") + value;
    };
    return (
      pad(parsed.getMonth() + 1) +
      "-" +
      pad(parsed.getDate()) +
      " " +
      pad(parsed.getHours()) +
      ":" +
      pad(parsed.getMinutes())
    );
  }

  // ---------------------------------------------------------------- 样式 --
  // 只写卡片内部元素。背景/边框/圆角继承 .overview-panel，不重复定义。

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      ".ko-rv-head-actions{display:flex;gap:6px;align-items:center;flex:0 0 auto}",
      ".ko-rv-btn{border:1px solid var(--line);background:transparent;color:var(--ink);",
      "border-radius:9px;padding:4px 9px;font-size:calc(11.5px * var(--font-scale, 1));cursor:pointer;white-space:nowrap;",
      "font-family:inherit}",
      ".ko-rv-btn:hover{border-color:var(--muted)}",
      ".ko-rv-btn.primary{background:var(--green);border-color:var(--green);color:#0e1410}",

      ".ko-rv-empty{padding:18px 6px;text-align:center;color:var(--muted);font-size:calc(12.5px * var(--font-scale, 1));",
      "line-height:1.9}",
      ".ko-rv-err{border:1px solid var(--red);border-radius:10px;padding:9px 11px;",
      "color:var(--red);font-size:calc(12px * var(--font-scale, 1))}",

      ".ko-rv-guide{border:1px solid var(--line);border-radius:12px;padding:11px 13px;",
      "background:var(--panel)}",
      ".ko-rv-guide-t{font-size:calc(12.5px * var(--font-scale, 1));line-height:1.7;margin:0 0 9px;color:var(--ink)}",
      ".ko-rv-guide-t b{color:var(--gold);font-weight:600;font-size:calc(14.5px * var(--font-scale, 1));padding:0 2px}",
      ".ko-rv-guide-note{font-size:calc(11.5px * var(--font-scale, 1));color:var(--muted);line-height:1.7;margin:8px 0 0}",

      // 窄面板（折叠态实测可用宽约 246px）下 3 格仍放得下：3×74=222 < 246。
      // 再窄会自动折成 2 列，不用写媒体查询。
      ".ko-rv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(74px,1fr));",
      "gap:8px}",
      ".ko-rv-cell{border:1px solid var(--line);border-radius:11px;padding:9px 11px}",
      ".ko-rv-cell-v{font-size:calc(18px * var(--font-scale, 1));font-weight:600;line-height:1.3;color:var(--ink)}",
      ".ko-rv-cell-l{font-size:calc(11px * var(--font-scale, 1));color:var(--muted);margin-top:2px;line-height:1.4}",

      ".ko-rv-forecast{border:1px solid var(--line);border-radius:11px;padding:10px 12px}",
      ".ko-rv-section-title{font-size:calc(11px * var(--font-scale, 1));color:var(--muted);margin:0 0 8px}",
      ".ko-rv-bars{display:flex;align-items:flex-end;gap:4px;height:34px}",
      ".ko-rv-bars > span{flex:1;min-height:2px;background:var(--green);opacity:.5;",
      "border-radius:2px 2px 0 0}",
      ".ko-rv-bars > span.today{opacity:1}",
      ".ko-rv-bar-labels{display:flex;gap:4px;margin-top:4px}",
      ".ko-rv-bar-labels > span{flex:1;text-align:center;font-size:calc(9.5px * var(--font-scale, 1));color:var(--muted)}",

      ".ko-rv-recent{border:1px solid var(--line);border-radius:11px;padding:10px 12px}",
      ".ko-rv-recent ul{list-style:none;margin:0;padding:0}",
      ".ko-rv-recent li{display:flex;gap:8px;align-items:baseline;font-size:calc(12px * var(--font-scale, 1));",
      "padding:5px 0;border-top:1px solid var(--line)}",
      ".ko-rv-recent li:first-child{border-top:none}",
      ".ko-rv-recent-t{color:var(--muted);font-size:calc(11px * var(--font-scale, 1));flex:0 0 auto;min-width:74px}",
      ".ko-rv-recent-l{flex:1 1 auto;color:var(--ink);min-width:0;overflow-wrap:anywhere}",
      ".ko-rv-recent-d{color:var(--muted);font-size:calc(11px * var(--font-scale, 1));flex:0 0 auto}",
    ].join("\n");
    var node = document.createElement("style");
    node.id = STYLE_ID;
    node.textContent = css;
    document.head.appendChild(node);
  }

  // ---------------------------------------------------------------- 挂载 --
  // 概览页每次进入都会整块重写 #studio-output.innerHTML，我们追加的卡片会被冲掉，
  // 所以 mount() 必须可以被反复调用（自带存在性判断，重复调用是廉价 no-op）。

  function cardNode() {
    return document.querySelector("[" + CARD_ATTR + "]");
  }

  function mount() {
    var dash = document.querySelector(DASH_SELECTOR);
    if (!dash) return false; // 不在学习概览页（或在别的产出视图里）
    var card = cardNode();
    if (card && dash.contains(card)) {
      syncProject();
      return true;
    }
    card = document.createElement("section");
    card.className = "overview-panel ko-rv-embed";
    card.setAttribute(CARD_ATTR, "1");
    dash.appendChild(card);
    render();
    syncProject();
    return true;
  }

  /** 项目变了才重新取数；同一项目内换页签再回来，沿用已有数据直接渲染。 */
  function syncProject() {
    var projectId = currentProjectId();
    if (view.loaded && view.projectId === projectId) return;
    view.projectId = projectId;
    view.loaded = false;
    view.error = "";
    view.stats = null;
    view.forecast = [];
    view.recent = [];
    render();
    load();
  }

  // ---------------------------------------------------------------- 渲染 --

  function renderGuide() {
    var stats = view.stats || {};
    var due = Number(stats.due_cards) || 0;
    var total = Number(stats.total_cards) || 0;
    if (total === 0) {
      return (
        '<div class="ko-rv-guide">' +
        '<p class="ko-rv-guide-t">还没有知识卡片。</p>' +
        '<p class="ko-rv-guide-note">先去「知识卡片」生成一些，复习排期会自动开始。</p>' +
        "</div>"
      );
    }
    var head =
      due > 0
        ? "今天有 <b>" + due + "</b> 张到期。"
        : "今天的复习已经做完了。";
    var note =
      due > 0
        ? "去知识卡片页直接翻卡复习 —— 那里已经把到期的排在前面，每张都能顺手自评、当场看到下次什么时候再见。"
        : "还在记忆曲线上的卡片会在该复习的那天自动亮起来，不用自己记时间。";
    return (
      '<div class="ko-rv-guide">' +
      '<p class="ko-rv-guide-t">' +
      head +
      "</p>" +
      '<button type="button" class="ko-rv-btn primary" data-ko-rv-gocards>' +
      (due > 0 ? "去复习这 " + due + " 张" : "去知识卡片") +
      "</button>" +
      '<p class="ko-rv-guide-note">' +
      esc(note) +
      "</p>" +
      "</div>"
    );
  }

  function renderGrid() {
    var stats = view.stats || {};
    var cells = [
      { v: stats.reviewed_today || 0, l: "今日已复习" },
      { v: stats.due_cards || 0, l: "等待复习" },
      { v: stats.started_cards || 0, l: "已在记忆曲线上" },
    ];
    return (
      '<div class="ko-rv-grid">' +
      cells
        .map(function (cell) {
          return (
            '<div class="ko-rv-cell"><div class="ko-rv-cell-v">' +
            esc(String(cell.v)) +
            '</div><div class="ko-rv-cell-l">' +
            esc(cell.l) +
            "</div></div>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function renderForecast() {
    if (!view.forecast || view.forecast.length < 2) return "";
    var peak = view.forecast.reduce(function (max, item) {
      return Math.max(max, Number(item.count) || 0);
    }, 1);
    var bars = view.forecast
      .map(function (item, index) {
        var height = Math.max(2, Math.round(((Number(item.count) || 0) / peak) * 34));
        return (
          '<span class="' +
          (index === 0 ? "today" : "") +
          '" style="height:' +
          height +
          'px" title="' +
          esc(item.day) +
          "：" +
          esc(String(item.count)) +
          ' 张"></span>'
        );
      })
      .join("");
    var labels = view.forecast
      .map(function (item, index) {
        return "<span>" + (index === 0 ? "今天" : esc(item.day.slice(5))) + "</span>";
      })
      .join("");
    return (
      '<div class="ko-rv-forecast"><p class="ko-rv-section-title">' +
      "未来一周复习量（提前避开某天突然堆成复习债）</p>" +
      '<div class="ko-rv-bars">' +
      bars +
      '</div><div class="ko-rv-bar-labels">' +
      labels +
      "</div></div>"
    );
  }

  function renderRecent() {
    if (!view.recent || !view.recent.length) return "";
    var items = view.recent
      .slice(0, 8)
      .map(function (item) {
        return (
          "<li><span class=\"ko-rv-recent-t\">" +
          esc(localTime(item.created_at)) +
          '</span><span class="ko-rv-recent-l">' +
          esc(item.rating_label || "已复习") +
          '</span><span class="ko-rv-recent-d">' +
          esc(formatDays(item.interval_days)) +
          "</span></li>"
        );
      })
      .join("");
    return (
      '<div class="ko-rv-recent"><p class="ko-rv-section-title">最近复习</p>' +
      "<ul>" +
      items +
      "</ul></div>"
    );
  }

  function render() {
    var card = cardNode();
    if (!card) return;

    var body = "";
    if (view.error) {
      body += '<div class="ko-rv-err">' + esc(view.error) + "</div>";
    }
    if (view.loading && !view.loaded) {
      body += '<div class="ko-rv-empty">正在读取复习进度…</div>';
    } else {
      body += renderGuide() + renderGrid() + renderForecast() + renderRecent();
    }

    var total = Number((view.stats || {}).total_cards) || 0;
    card.innerHTML =
      '<div class="overview-section-heading">' +
      "<div>" +
      "<h3>复习进度</h3>" +
      "<p>隔多久该见一次这些卡片 —— 别让某一天突然堆成复习债。</p>" +
      "</div>" +
      '<div class="ko-rv-head-actions">' +
      (total ? "<span class=\"ko-rv-section-title\">共 " + total + " 张</span>" : "") +
      '<button type="button" class="ko-rv-btn" data-ko-rv-reload>刷新</button>' +
      "</div></div>" +
      body;
    // 事件委托挂在卡片自己身上。注意 card 是同一个节点（只有 innerHTML 被重写），
    // 所以监听不会丢；bindCard 自带幂等判断，反复调用只挂一次。
    bindCard(card);
  }

  // ---------------------------------------------------------------- 交互 --

  function load() {
    if (view.loading) return Promise.resolve();
    view.loading = true;
    view.error = "";
    // 只取统计与负载：卡片内容这一步用不上（复习发生在卡片页）
    return call(API + "/queue?limit=1")
      .then(function (data) {
        view.stats = data.stats || null;
        view.forecast = data.forecast || [];
        view.recent = data.recent || [];
        view.loaded = true;
      })
      .catch(function (error) {
        view.error = (error && error.message) || "没能读到复习进度，请稍后重试。";
      })
      .finally(function () {
        view.loading = false;
        render();
      });
  }

  // 「去知识卡片」= 复用 app.js 既有的切页函数，不自己改 state，
  // 免得漏掉它内部（渲染、选中清理、必要时触发生成）的既有逻辑。
  function goCards() {
    try {
      if (typeof switchFeature === "function") switchFeature("cards");
    } catch (error) {
      /* 切不过去时用户手动点页签也一样 */
    }
  }

  function bindCard(card) {
    if (!card || card.getAttribute("data-ko-rv-events") === "1") return;
    card.setAttribute("data-ko-rv-events", "1");
    card.addEventListener("click", function (event) {
      var target = event.target;
      if (!target || typeof target.closest !== "function") return;
      if (target.closest("[data-ko-rv-gocards]")) {
        goCards();
        return;
      }
      if (target.closest("[data-ko-rv-reload]")) {
        view.loaded = false;
        render();
        load();
      }
    });
  }

  // ---------------------------------------------------------------- 启动 --

  /**
   * 概览页的重建有两种触发：用户点「学习概览」页签（起手就重写）
   * 和 项目切换 / 数据刷新后 app.js 自己重绘。前者用点击监听做到即时，
   * 后者用 DOM 观察兜底。两条路都只是调用幂等的 mount()。
   */
  function bindGrid() {
    var grid = document.querySelector(".feature-grid");
    if (!grid || grid.getAttribute("data-ko-rv-nav") === "1") return;
    grid.setAttribute("data-ko-rv-nav", "1");
    grid.addEventListener("click", function (event) {
      var target = event.target.closest(".feature-button");
      if (!target) return;
      if (target.dataset.feature === "overview") setTimeout(mount, 0);
    });
  }

  function watchOutput() {
    if (typeof MutationObserver !== "function" || !document.body) return;
    var pending = false;
    var observer = new MutationObserver(function () {
      if (pending) return;
      pending = true;
      setTimeout(function () {
        pending = false;
        mount();
      }, 120);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function boot() {
    ensureStyle();
    bindGrid();
    mount();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // 登录后 app.js 才渲染出产出区，启动时可能还没有，稍后再试一次。
  document.addEventListener("DOMContentLoaded", function () {
    setTimeout(boot, 600);
  });
  setTimeout(boot, 2000);
  watchOutput();

  window.KnowOriginReview = { mount: mount, refresh: load, _view: view };
})();
