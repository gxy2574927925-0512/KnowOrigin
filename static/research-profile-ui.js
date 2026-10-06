// 科研画像（Research Profile）+ AI 深度解析 注入式模块
// 三个入口：
//   1. 文献库导航条「🎯 科研画像」——画像表单弹窗（研究领域/方向/关键词/阶段/详略）
//   2. 左下角阅读助手页签栏「深度解析」——对当前精读论文生成 6 维解析 + 相关度 + 阅读建议
//   3. 全球检索论文详情弹窗「AI 深度解析」——同上
// 解析结果在**独立的全屏学术阅读层**展示（顶栏固定 + 正文自滚 + 880px 学术列宽），
// 不再挤在详情小弹窗里。依赖 app.js 的 window.api()/showToast() 与 literature.js
// 的 window.KnowOriginLiterature.currentId()；不依赖 project 上下文。
(function () {
  "use strict";

  var STYLES = [
    // ── 画像表单弹窗 ──
    ".rp-overlay { position: fixed; inset: 0; z-index: 1500; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.45); }",
    ".rp-overlay[hidden] { display: none; }",
    ".rp-dialog { width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 48px); overflow-y: auto; background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 14px; padding: 20px 22px; box-shadow: 0 12px 40px rgba(0,0,0,0.25); }",
    ".rp-dialog h3 { margin: 0 0 4px; font-size: calc(15px * var(--font-scale, 1)); font-weight: 600; }",
    ".rp-dialog .rp-sub { margin: 0 0 16px; font-size: calc(12px * var(--font-scale, 1)); color: var(--muted); line-height: 1.5; }",
    ".rp-field { margin-bottom: 14px; }",
    ".rp-field label { display: block; font-size: calc(12.5px * var(--font-scale, 1)); font-weight: 600; margin-bottom: 5px; color: var(--ink); }",
    ".rp-field input[type=text] { width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: calc(13px * var(--font-scale, 1)); border: 1px solid var(--line); border-radius: 8px; background: var(--background); color: var(--ink); }",
    ".rp-field .rp-hint { font-size: calc(11px * var(--font-scale, 1)); color: var(--muted); margin-top: 3px; }",
    ".rp-seg { display: inline-flex; background: var(--sidebar); border: 1px solid var(--line); border-radius: 9px; padding: 3px; gap: 2px; flex-wrap: wrap; }",
    ".rp-seg button { border: none; background: transparent; color: var(--muted); font-size: calc(12px * var(--font-scale, 1)); font-weight: 600; padding: 5px 12px; border-radius: 6px; cursor: pointer; }",
    ".rp-seg button.on { background: var(--green); color: #0e1410; font-weight: 700; }",
    ".rp-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }",
    ".rp-actions button { padding: 8px 16px; border-radius: 9px; font-size: calc(13px * var(--font-scale, 1)); font-weight: 600; cursor: pointer; border: 1px solid var(--line); background: var(--background); color: var(--ink); }",
    ".rp-actions button.rp-save { background: var(--green); color: #0e1410; border: none; }",
    ".rp-error { color: var(--red); font-size: calc(12px * var(--font-scale, 1)); margin-top: 8px; }",
    ".rp-profile-btn { display: inline-flex; align-items: center; gap: 4px; padding: 5px 9px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--muted); font-size: calc(11.5px * var(--font-scale, 1)); font-weight: 600; cursor: pointer; white-space: nowrap; }",
    ".rp-profile-btn:hover { color: var(--ink); }",
    ".rp-profile-btn.has-profile { color: var(--green); border-color: var(--green); }",
    // ── 阅读助手页签栏里的「深度解析」按钮（视觉对齐 .sr-tab，但不吃 switchTab）──
    ".rp-deep-tab { display: inline-flex; align-items: center; gap: 5px; border: none; background: transparent; color: var(--muted); font-size: calc(12.5px * var(--font-scale, 1)); font-weight: 600; padding: 6px 10px; border-radius: 8px; cursor: pointer; white-space: nowrap; }",
    ".rp-deep-tab:hover { color: var(--ink); background: var(--sidebar); }",
    ".rp-deep-tab svg { width: 14px; height: 14px; }",
    // ── 详情弹窗里的入口按钮 ──
    ".rp-deep-btn { display: inline-flex; align-items: center; gap: 5px; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--background); color: var(--green); font-size: calc(12.5px * var(--font-scale, 1)); font-weight: 600; cursor: pointer; }",
    // ── 全屏学术阅读层 ──
    ".rp-reader { position: fixed; inset: 0; z-index: 1500; display: flex; flex-direction: column; background: var(--panel); color: var(--ink); }",
    ".rp-reader[hidden] { display: none; }",
    ".rp-reader-bar { flex: 0 0 auto; display: flex; align-items: center; gap: 14px; padding: 12px 22px; border-bottom: 1px solid var(--line); }",
    ".rp-reader-kicker { font-size: calc(11px * var(--font-scale, 1)); font-weight: 700; letter-spacing: 2px; color: var(--green); white-space: nowrap; }",
    ".rp-reader-title { flex: 1 1 auto; font-size: calc(13.5px * var(--font-scale, 1)); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--muted); }",
    ".rp-reader-close { flex: 0 0 auto; border: 1px solid var(--line); background: var(--background); color: var(--ink); border-radius: 8px; padding: 6px 16px; font-size: calc(12.5px * var(--font-scale, 1)); font-weight: 600; cursor: pointer; }",
    ".rp-reader-close:hover { border-color: var(--green); color: var(--green); }",
    ".rp-reader-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 42px max(22px, calc((100% - 860px) / 2)) 96px; }",
    // 学术排版：大标题 → 元信息 → 导读卡 → 分节
    ".rp-head-title { font-size: calc(21px * var(--font-scale, 1)); font-weight: 600; line-height: 1.55; margin: 0 0 10px; }",
    ".rp-head-meta { font-size: calc(12.5px * var(--font-scale, 1)); color: var(--muted); margin: 0 0 4px; line-height: 1.6; }",
    ".rp-hr { border: 0; border-top: 1px solid var(--line); margin: 24px 0 30px; }",
    ".rp-guide { border: 1px solid rgba(46,158,91,0.35); background: rgba(46,158,91,0.08); border-radius: 12px; padding: 16px 18px; margin: 0 0 34px; }",
    ".rp-guide-title { font-size: calc(12px * var(--font-scale, 1)); font-weight: 700; letter-spacing: 1px; color: var(--green); margin-bottom: 8px; }",
    ".rp-guide p { font-size: calc(13.5px * var(--font-scale, 1)); line-height: 1.8; margin: 0 0 6px; }",
    ".rp-guide p:last-child { margin-bottom: 0; }",
    ".rp-sec { margin: 0 0 34px; }",
    ".rp-sec-no { font-size: calc(11px * var(--font-scale, 1)); font-weight: 700; letter-spacing: 3px; color: var(--muted); margin-bottom: 6px; }",
    ".rp-sec-title { font-size: calc(16px * var(--font-scale, 1)); font-weight: 600; margin: 0 0 10px; }",
    ".rp-sec p { font-size: calc(14px * var(--font-scale, 1)); line-height: 1.9; margin: 0; }",
    ".rp-match-badge { display: inline-block; font-size: calc(11px * var(--font-scale, 1)); font-weight: 700; padding: 2px 9px; border-radius: 999px; margin-left: 8px; vertical-align: 2px; }",
    ".rp-match-strong { background: rgba(99,153,34,0.16); color: #639922; }",
    ".rp-match-medium { background: rgba(186,117,23,0.16); color: #BA7517; }",
    ".rp-match-weak, .rp-match-none, .rp-match-unknown { background: var(--line); color: var(--muted); }",
    // 生成中骨架
    ".rp-skel { height: 13px; border-radius: 6px; background: var(--line); opacity: 0.55; margin-bottom: 12px; animation: rp-pulse 1.2s ease-in-out infinite; }",
    ".rp-skel.w60 { width: 60%; } .rp-skel.w90 { width: 90%; } .rp-skel.w75 { width: 75%; }",
    "@keyframes rp-pulse { 0%,100% { opacity: 0.35; } 50% { opacity: 0.7; } }",
    ".rp-reader-error { color: var(--red); font-size: calc(13px * var(--font-scale, 1)); }",
  ];

  var STAGE_OPTIONS = [
    ["undergraduate", "本科"],
    ["master", "硕士"],
    ["phd", "博士"],
    ["researcher", "研究员"],
  ];
  var STYLE_OPTIONS = [
    ["brief", "简洁"],
    ["normal", "标准"],
    ["detailed", "详细"],
  ];
  var MATCH_LABELS = {
    strong: "强相关",
    medium: "中等相关",
    weak: "弱相关",
    none: "不相关",
    unknown: "无法判断",
  };
  var SPARK_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
  // 六维分节定义（编号 + 标题 + 字段）
  var SECTIONS = [
    ["01", "核心要点", "tldr"],
    ["02", "研究动机", "motivation"],
    ["03", "方法架构", "methodology"],
    ["04", "定量指标", "metrics"],
    ["05", "局限与挑刺", "limitations"],
    ["06", "抗辩策略", "defense_strategy"],
  ];

  function esc(v) {
    if (typeof escapeHtml === "function") return escapeHtml(v);
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function ensureStyle() {
    if (document.getElementById("rp-style")) return;
    var s = document.createElement("style");
    s.id = "rp-style";
    s.textContent = STYLES.join("\n");
    document.head.appendChild(s);
  }

  function api(path, opts) {
    var o = opts || {};
    if (typeof o.body === "string") {
      o.headers = Object.assign({ "Content-Type": "application/json" }, o.headers || {});
    }
    return window.api(path, o);
  }

  // ── 画像状态 ──
  var profile = null;
  var loaded = false;

  function loadProfile() {
    return api("/api/research-profile").then(function (res) {
      if (res && res.profile) {
        profile = res.profile;
        loaded = true;
        refreshButtonState();
      }
      return res;
    });
  }

  function refreshButtonState() {
    var btn = document.getElementById("rp-profile-btn");
    if (!btn) return;
    var has = loaded && profile && profile.research_area;
    btn.classList.toggle("has-profile", !!has);
  }

  // ── 入口 1：文献库导航条「科研画像」 ──
  function ensureEntryButton() {
    var nav = document.getElementById("lit-lib-header-nav");
    if (!nav || document.getElementById("rp-profile-btn")) return;
    var btn = document.createElement("button");
    btn.id = "rp-profile-btn";
    btn.type = "button";
    btn.className = "rp-profile-btn";
    btn.style.marginLeft = "auto";
    btn.innerHTML = "<span>🎯</span><span>科研画像</span>";
    btn.addEventListener("click", openDialog);
    var expand = nav.querySelector("#lit-aside-expand-btn");
    if (expand) nav.insertBefore(btn, expand);
    else nav.appendChild(btn);
    if (!loaded) loadProfile().catch(function () {});
  }

  // ── 入口 2：阅读助手页签栏「深度解析」（当前精读论文） ──
  function ensureReaderTab() {
    var tabs = document.querySelector(".sr-tabs");
    if (!tabs || document.getElementById("rp-deep-tab")) return;
    var btn = document.createElement("button");
    btn.id = "rp-deep-tab";
    btn.type = "button";
    btn.className = "rp-deep-tab";
    btn.setAttribute("aria-label", "AI 深度解析当前论文");
    btn.title = "AI 深度解析：六维拆解 + 相关度 + 阅读建议";
    btn.innerHTML = SPARK_ICON + "<span>深度解析</span>";
    btn.addEventListener("click", function () {
      openForCurrentPaper();
    });
    // 排在「AI 问答」页签后面；找不到时再退回追加到末尾
    var qaTab = tabs.querySelector('.sr-tab[data-tab="qa"]');
    if (qaTab && qaTab.insertAdjacentElement) {
      qaTab.insertAdjacentElement("afterend", btn);
    } else {
      tabs.appendChild(btn);
    }
  }

  function openForCurrentPaper() {
    var lit = window.KnowOriginLiterature;
    var id = lit && typeof lit.currentId === "function" ? lit.currentId() : null;
    if (!id) {
      if (typeof window.showToast === "function") {
        window.showToast("请先选择一篇文献，再生成深度解析。", "info");
      }
      return;
    }
    api("/api/literature/" + encodeURIComponent(id))
      .then(function (detail) {
        var meta = (detail && detail.meta) || {};
        var project = (detail && detail.project) || {};
        var title = meta.title || project.subject || "未命名论文";
        var abstract = meta.abstract || "";
        if (!abstract) {
          if (typeof window.showToast === "function") {
            window.showToast("这篇文献没有摘要元数据，解析质量会降级为规则版。", "info");
          }
        }
        openReader({ title: title, abstract: abstract, venue: meta.venue || "", authors: meta.authors || "" });
      })
      .catch(function (e) {
        if (typeof window.showToast === "function") {
          window.showToast("读取文献信息失败：" + ((e && e.message) || "请稍后重试"), "error");
        }
      });
  }

  // ── 入口 3：全球检索详情弹窗 ──
  function ensureDeepButton() {
    var overlay = document.getElementById("ps-detail-overlay");
    if (!overlay || overlay.style.display === "none") return;
    var actions = overlay.querySelector(".ps-detail-actions");
    if (!actions || overlay.querySelector("#rp-deep-btn")) return;
    var btn = document.createElement("button");
    btn.id = "rp-deep-btn";
    btn.type = "button";
    btn.className = "rp-deep-btn";
    btn.textContent = "🤖 AI 深度解析";
    btn.addEventListener("click", function () {
      var paper = readPaperFromDetail(overlay);
      openReader(paper);
    });
    actions.insertBefore(btn, actions.firstChild);
  }

  function readPaperFromDetail(overlay) {
    var panel = overlay.querySelector(".ps-detail-panel");
    var title = "";
    var abstract = "";
    var venue = "";
    if (panel) {
      var t = panel.querySelector(".ps-detail-title");
      title = t ? t.textContent : "";
      var sections = panel.querySelectorAll(".ps-detail-section");
      for (var i = 0; i < sections.length; i++) {
        var h = sections[i].querySelector("h4");
        if (!h) continue;
        var p = sections[i].querySelector("p");
        if (h.textContent.indexOf("摘要") >= 0 && p) abstract = p.textContent;
        if (h.textContent.indexOf("发表") >= 0 && p) venue = p.textContent;
      }
    }
    return { title: title, abstract: abstract || title, venue: venue, authors: "" };
  }

  // ── 全屏学术阅读层 ──
  function ensureReader() {
    var r = document.getElementById("rp-reader");
    if (r) return r;
    r = document.createElement("div");
    r.id = "rp-reader";
    r.className = "rp-reader";
    r.setAttribute("hidden", "");
    r.setAttribute("role", "dialog");
    r.setAttribute("aria-label", "AI 深度解析阅读页");
    r.innerHTML =
      '<div class="rp-reader-bar">' +
      '<span class="rp-reader-kicker">AI 深度解析</span>' +
      '<span class="rp-reader-title" id="rp-reader-title"></span>' +
      '<button type="button" class="rp-reader-close" id="rp-reader-close">关闭 Esc</button>' +
      "</div>" +
      '<div class="rp-reader-body" id="rp-reader-body"></div>';
    document.body.appendChild(r);
    r.querySelector("#rp-reader-close").addEventListener("click", closeReader);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !r.hidden) closeReader();
    });
    return r;
  }

  function closeReader() {
    var r = document.getElementById("rp-reader");
    if (r) r.hidden = true;
  }

  function openReader(paper) {
    ensureStyle();
    var r = ensureReader();
    r.hidden = false;
    r.querySelector("#rp-reader-title").textContent = paper.title || "";
    renderSkeleton(r, paper);
    // 换页归零滚动：操作自己的滚动容器，不用 scrollIntoView
    setTimeout(function () {
      var b = r.querySelector("#rp-reader-body");
      if (b) b.scrollTop = 0;
    }, 60);

    var t0 = Date.now();
    var timer = setInterval(function () {
      var el = document.getElementById("rp-skel-note");
      if (el) el.textContent = "正在生成（约 " + Math.round((Date.now() - t0) / 1000) + " 秒）…";
    }, 1000);

    api("/api/search/paper-deep-analysis", {
      method: "POST",
      body: JSON.stringify({ paper: { title: paper.title || "", abstract: paper.abstract || "", venue: paper.venue || "" } }),
    })
      .then(function (res) {
        clearInterval(timer);
        renderAnalysis(r, paper, res && res.analysis ? res.analysis : null);
      })
      .catch(function (e) {
        clearInterval(timer);
        var body = r.querySelector("#rp-reader-body");
        body.innerHTML =
          '<p class="rp-reader-error">生成失败：' + esc((e && e.message) || "请稍后重试") + "</p>";
      });
  }

  function renderSkeleton(r, paper) {
    var body = r.querySelector("#rp-reader-body");
    var meta = [paper.authors, paper.venue].filter(Boolean).join(" · ");
    var html = '<h1 class="rp-head-title">' + esc(paper.title || "") + "</h1>";
    if (meta) html += '<p class="rp-head-meta">' + esc(meta) + "</p>";
    html += '<hr class="rp-hr"/>';
    html +=
      '<p class="rp-head-meta" id="rp-skel-note">正在生成（约 10–30 秒）…</p>' +
      '<div style="margin-top:18px">' +
      '<div class="rp-skel w60"></div><div class="rp-skel w90"></div><div class="rp-skel w90"></div><div class="rp-skel w75"></div>' +
      "</div>";
    body.innerHTML = html;
  }

  function renderAnalysis(r, paper, a) {
    var body = r.querySelector("#rp-reader-body");
    if (!a) {
      body.innerHTML = '<p class="rp-reader-error">未生成内容，请重试。</p>';
      return;
    }
    var meta = [paper.authors, paper.venue].filter(Boolean).join(" · ");
    var level = a.direction_match_level || "unknown";
    var badge =
      '<span class="rp-match-badge rp-match-' + esc(level) + '">' + (MATCH_LABELS[level] || esc(level)) + "</span>";

    var html = '<h1 class="rp-head-title">' + esc(paper.title || "") + "</h1>";
    if (meta) html += '<p class="rp-head-meta">' + esc(meta) + "</p>";
    html += '<hr class="rp-hr"/>';

    // 导读卡（画像存在才有个性化内容；否则诚实展示降级文案）
    if (a.relation_to_user_direction || a.reading_recommendation) {
      html += '<div class="rp-guide">';
      html += '<div class="rp-guide-title">画像导读' + badge + "</div>";
      if (a.relation_to_user_direction) {
        html += "<p><strong>与你的方向</strong>：" + esc(a.relation_to_user_direction) + "</p>";
      }
      if (a.reading_recommendation) {
        html += "<p><strong>阅读建议</strong>：" + esc(a.reading_recommendation) + "</p>";
      }
      html += "</div>";
    }

    SECTIONS.forEach(function (sec) {
      var text = a[sec[2]];
      if (!text) return;
      html +=
        '<section class="rp-sec">' +
        '<div class="rp-sec-no">' + sec[0] + "</div>" +
        '<h2 class="rp-sec-title">' + esc(sec[1]) + "</h2>" +
        "<p>" + esc(text) + "</p>" +
        "</section>";
    });

    if (html.indexOf("rp-sec") < 0) {
      html += '<p class="rp-reader-error">本次解析内容为空，请重试。</p>';
    }
    body.innerHTML = html;
  }

  // ── 画像表单弹窗 ──
  function openDialog() {
    ensureStyle();
    var overlay = document.getElementById("rp-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "rp-overlay";
      overlay.className = "rp-overlay";
      overlay.setAttribute("hidden", "");
      document.body.appendChild(overlay);
      overlay.addEventListener("click", function (e) {
        if (e.target === overlay) closeDialog();
      });
    }
    renderDialog(overlay);
    overlay.hidden = false;
    if (!loaded) {
      loadProfile()
        .then(function () { renderDialog(overlay); })
        .catch(function () {});
    }
  }

  function closeDialog() {
    var overlay = document.getElementById("rp-overlay");
    if (overlay) overlay.hidden = true;
  }

  function splitList(raw) {
    return String(raw || "")
      .split(/[,，、\n]+/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function renderDialog(overlay) {
    var p = profile || {};
    var stage = p.research_stage || "undergraduate";
    var style = p.preferred_output_style || "normal";

    var stageBtns = STAGE_OPTIONS.map(function (o) {
      return '<button type="button" data-rp-stage="' + o[0] + '" class="' + (stage === o[0] ? "on" : "") + '">' + esc(o[1]) + "</button>";
    }).join("");
    var styleBtns = STYLE_OPTIONS.map(function (o) {
      return '<button type="button" data-rp-style="' + o[0] + '" class="' + (style === o[0] ? "on" : "") + '">' + esc(o[1]) + "</button>";
    }).join("");

    overlay.innerHTML =
      '<div class="rp-dialog" role="dialog" aria-label="科研画像">' +
      "<h3>科研画像</h3>" +
      '<p class="rp-sub">填写你的研究兴趣后，论文深度解析会额外给出「相关度 + 阅读建议」。留空即不启用个性化。</p>' +
      '<div class="rp-field"><label>研究领域</label><input type="text" id="rp-area" placeholder="如：太赫兹、光电子、定量 OCT" value="' + esc(p.research_area || "") + '"></div>' +
      '<div class="rp-field"><label>主要方向</label><input type="text" id="rp-sub" placeholder="多个用顿号分隔，如：THz-ISAC、激光雷达" value="' + esc((p.sub_direction || []).join("、")) + '"><div class="rp-hint">用顿号 / 逗号 / 换行分隔</div></div>' +
      '<div class="rp-field"><label>关注关键词</label><input type="text" id="rp-kw" placeholder="如：dToF、导盲、可穿戴" value="' + esc((p.keywords || []).join("、")) + '"></div>' +
      '<div class="rp-field"><label>暂不关注的主题</label><input type="text" id="rp-ex" placeholder="多个用顿号分隔" value="' + esc((p.excluded_topics || []).join("、")) + '"></div>' +
      '<div class="rp-field"><label>科研阶段</label><div class="rp-seg">' + stageBtns + "</div></div>" +
      '<div class="rp-field"><label>输出详略偏好</label><div class="rp-seg">' + styleBtns + "</div></div>" +
      '<div class="rp-actions">' +
      '<button type="button" id="rp-cancel">取消</button>' +
      '<button type="button" class="rp-save" id="rp-save">保存画像</button>' +
      "</div>" +
      '<div class="rp-error" id="rp-error" hidden></div>' +
      "</div>";

    overlay.querySelector("#rp-cancel").addEventListener("click", closeDialog);
    overlay.querySelector("#rp-save").addEventListener("click", saveProfile);

    overlay.querySelectorAll("[data-rp-stage]").forEach(function (b) {
      b.addEventListener("click", function () {
        overlay.querySelectorAll("[data-rp-stage]").forEach(function (x) { x.classList.remove("on"); });
        b.classList.add("on");
      });
    });
    overlay.querySelectorAll("[data-rp-style]").forEach(function (b) {
      b.addEventListener("click", function () {
        overlay.querySelectorAll("[data-rp-style]").forEach(function (x) { x.classList.remove("on"); });
        b.classList.add("on");
      });
    });
  }

  function saveProfile() {
    var overlay = document.getElementById("rp-overlay");
    var stageBtn = overlay.querySelector("[data-rp-stage].on");
    var styleBtn = overlay.querySelector("[data-rp-style].on");
    var err = overlay.querySelector("#rp-error");

    var payload = {
      profile: {
        research_area: (overlay.querySelector("#rp-area").value || "").trim(),
        sub_direction: splitList(overlay.querySelector("#rp-sub").value),
        keywords: splitList(overlay.querySelector("#rp-kw").value),
        excluded_topics: splitList(overlay.querySelector("#rp-ex").value),
        research_stage: stageBtn ? stageBtn.dataset.rpStage : "undergraduate",
        preferred_output_style: styleBtn ? styleBtn.dataset.rpStyle : "normal",
      },
    };

    err.hidden = true;
    api("/api/research-profile", { method: "PUT", body: JSON.stringify(payload) })
      .then(function (res) {
        if (res && res.profile) {
          profile = res.profile;
          loaded = true;
          refreshButtonState();
          closeDialog();
          if (typeof window.showToast === "function") {
            window.showToast("科研画像已保存，深度解析将按此画像给出相关度与阅读建议。", "success");
          }
        }
      })
      .catch(function (e) {
        err.textContent = "保存失败：" + (e && e.message ? e.message : "请稍后重试");
        err.hidden = false;
      });
  }

  // ── 引导 ──
  function boot() {
    ensureStyle();
    var pending = false;
    new MutationObserver(function () {
      if (pending) return;
      pending = true;
      setTimeout(function () {
        pending = false;
        ensureEntryButton();
        ensureReaderTab();
        ensureDeepButton();
      }, 120);
    }).observe(document.body, { childList: true, subtree: true });
    ensureEntryButton();
    ensureReaderTab();
    ensureDeepButton();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
