/**
 * 管理后台 · AI 用量排行。
 *
 * 用途：回答"额度被谁、花在哪了"。这是多用户共用一份 TJU_API_KEY 时唯一能止损的视角 ——
 * 没有它，一个人把额度刷爆，其他人只会看到"AI 突然不好用了"，而管理员查不出原因。
 *
 * 约定：append 到 admin.js 之后加载（同用 defer，故 api() / escapeHtml() 已全局可用）。
 * 不改 admin.js / admin.html / admin.css，只在 admin.html 的 head 里加一行 script。
 * 表格沿用 admin.css 既有的 .table-section / .section-heading / .table-wrap 类名，
 * 保持后台观感一致。
 */
(function () {
  "use strict";

  var SECTION_ID = "ko-admin-usage";
  var STYLE_ID = "ko-admin-usage-style";
  var state = { loaded: false, loading: false, data: null, users: {} };

  function esc(value) {
    try {
      return escapeHtml(String(value == null ? "" : value));
    } catch (error) {
      var node = document.createElement("div");
      node.textContent = String(value == null ? "" : value);
      return node.innerHTML;
    }
  }

  function call(path) {
    if (typeof api === "function") return api(path);
    return fetch(path, { credentials: "same-origin" }).then(function (response) {
      return response.json().catch(function () {
        return {};
      });
    });
  }

  function formatTokens(value) {
    var number = Number(value) || 0;
    if (number >= 1000000) return (number / 1000000).toFixed(2) + "M";
    if (number >= 1000) return (number / 1000).toFixed(1) + "k";
    return String(number);
  }

  function relativeTime(iso) {
    if (!iso) return "—";
    var then = new Date(iso);
    if (isNaN(then.getTime())) return "—";
    var seconds = Math.floor((Date.now() - then.getTime()) / 1000);
    if (seconds < 60) return "刚刚";
    if (seconds < 3600) return Math.floor(seconds / 60) + " 分钟前";
    if (seconds < 86400) return Math.floor(seconds / 3600) + " 小时前";
    return Math.floor(seconds / 86400) + " 天前";
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      "#" + SECTION_ID + " .ko-usage-bar{height:6px;border-radius:999px;",
      "background:var(--line);overflow:hidden;min-width:70px}",
      "#" + SECTION_ID + " .ko-usage-bar > i{display:block;height:100%;background:var(--green)}",
      "#" + SECTION_ID + " .ko-usage-note{font-size:calc(11px * var(--font-scale, 1));color:var(--muted);",
      "margin:0 0 10px;line-height:1.65}",
      "#" + SECTION_ID + " .ko-usage-metrics{display:flex;gap:18px;flex-wrap:wrap;",
      "margin:0 0 12px;font-size:calc(12px * var(--font-scale, 1));color:var(--muted)}",
      "#" + SECTION_ID + " .ko-usage-metrics b{display:block;font-size:calc(17px * var(--font-scale, 1));",
      "color:var(--ink);font-weight:500}",
    ].join("\n");
    var node = document.createElement("style");
    node.id = STYLE_ID;
    node.textContent = css;
    document.head.appendChild(node);
  }

  function ensureSection() {
    var existing = document.getElementById(SECTION_ID);
    if (existing) return existing;
    var dashboard = document.getElementById("dashboard-view");
    if (!dashboard) return null;
    var section = document.createElement("section");
    section.className = "table-section";
    section.id = SECTION_ID;
    section.innerHTML =
      '<div class="section-heading"><h2>AI 用量排行</h2>' +
      '<span class="muted" data-ko-usage-window>近 7 天</span></div>' +
      '<p class="ko-usage-note">' +
      "数字是<b>估算值</b>（CJK 1 字 ≈ 1 token）—— 用于发现异常消耗，不是账单。" +
      "「未识别用户」指没有登录态时的调用，它异常增长往往意味着有绕过鉴权的调用路径。" +
      "</p>" +
      '<div class="ko-usage-metrics" data-ko-usage-metrics></div>' +
      '<div class="table-wrap"><table><thead><tr>' +
      "<th>用户</th><th>调用次数</th><th>估算 tokens</th><th>占比</th><th>最后活动</th>" +
      "</tr></thead><tbody data-ko-usage-rows></tbody></table></div>";
    dashboard.appendChild(section);
    return section;
  }

  function render() {
    var rows = document.querySelector("[data-ko-usage-rows]");
    if (!rows) return;
    var data = state.data;
    if (!data) {
      rows.innerHTML = '<tr><td colspan="5" class="empty-row">加载中…</td></tr>';
      return;
    }
    var ranking = data.ranking || [];
    var totals = data.totals || {};
    var windowLabel = document.querySelector("[data-ko-usage-window]");
    if (windowLabel) {
      windowLabel.textContent = "近 " + (data.window_days || 7) + " 天";
    }
    var metrics = document.querySelector("[data-ko-usage-metrics]");
    if (metrics) {
      metrics.innerHTML =
        "<div><b>" +
        esc(formatTokens(totals.tokens)) +
        "</b>今日估算 tokens</div>" +
        "<div><b>" +
        esc(String(totals.calls || 0)) +
        "</b>今日调用次数</div>" +
        "<div><b>" +
        (Number(data.quota) > 0 ? esc(formatTokens(data.quota)) : "未设") +
        "</b>每人每日上限</div>" +
        "<div><b>" +
        esc(String(totals.anonymous_calls || 0)) +
        "</b>今日未识别用户调用</div>";
    }

    if (!ranking.length) {
      rows.innerHTML =
        '<tr><td colspan="5" class="empty-row">这个区间还没有用量记录。</td></tr>';
      return;
    }
    var peak = ranking.reduce(function (max, item) {
      return Math.max(max, Number(item.tokens) || 0);
    }, 1);
    rows.innerHTML = ranking
      .map(function (item) {
        var owner = item.owner_id || "";
        var email = state.users[owner] || "";
        var name = email ? email : (owner ? owner.slice(0, 12) : "未识别用户");
        var tokens = Number(item.tokens) || 0;
        var ratio = Math.max(1, Math.round((tokens / peak) * 100));
        return (
          "<tr" +
          (owner ? "" : ' class="ko-usage-anon"') +
          '><td class="user-cell">' +
          "<strong>" +
          esc(name) +
          "</strong>" +
          (email && owner
            ? "<span>" + esc(owner.slice(0, 12)) + "…</span>"
            : owner
              ? ""
              : "<span>无登录态调用</span>") +
          "</td>" +
          "<td>" +
          esc(String(item.calls || 0)) +
          "</td>" +
          "<td>" +
          esc(formatTokens(tokens)) +
          "</td>" +
          '<td><div class="ko-usage-bar"><i style="width:' +
          ratio +
          '%"></i></div></td>' +
          "<td>" +
          esc(relativeTime(item.last_at)) +
          "</td></tr>"
        );
      })
      .join("");
  }

  function load() {
    if (state.loading) return Promise.resolve();
    state.loading = true;
    // 顺带取一次 overview：用量排行只回了 owner_id，用户看得懂的是邮箱
    return Promise.all([
      call("/api/admin/usage?days=7").catch(function () {
        return null;
      }),
      call("/api/admin/overview").catch(function () {
        return null;
      }),
    ])
      .then(function (results) {
        if (!results[0]) {
          // 401 / 未登录：保持占位，等真正登录后再加载
          var rows = document.querySelector("[data-ko-usage-rows]");
          if (rows && !state.loaded) {
            rows.innerHTML =
              '<tr><td colspan="5" class="empty-row">登录后显示。</td></tr>';
          }
          return;
        }
        state.data = results[0];
        var users = (results[1] && results[1].users) || [];
        state.users = {};
        users.forEach(function (user) {
          if (user && user.user_id) state.users[user.user_id] = user.email || "";
        });
        state.loaded = true;
      })
      .finally(function () {
        state.loading = false;
        render();
      });
  }

  function watchDashboard() {
    var dashboard = document.getElementById("dashboard-view");
    if (!dashboard) return;
    // admin.js 通过切换 hidden 在登录视图与仪表盘之间跳；登录成功后要补一次加载
    var observer = new MutationObserver(function () {
      if (!dashboard.classList.contains("hidden") && !state.loaded) load();
    });
    observer.observe(dashboard, { attributes: true, attributeFilter: ["class"] });
    if (!dashboard.classList.contains("hidden")) load();
  }

  function boot() {
    ensureStyle();
    if (!ensureSection()) return;
    render();
    watchDashboard();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
