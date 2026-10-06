/* 知源 · 文献精读成果导出面板
   ============================================================
   为什么单独一个文件：
     导出只做「加一个入口 + 一个弹窗 + 两个新端点」。自带样式在本文件里注入
     <style>，不碰 app.js / styles.css / literature.js 的核心结构 ——
     删掉这个文件（和 index.html 里那行 <script>）就等于完全回退。

   导出的东西**全部已经在库里**：元数据、逐段中英对照、笔记与高亮、AI 解释、
   文献对比。所以这里是纯渲染 + 打包，**不调用模型、不花 token**。
     · 渲染与打包：core/literature_export.py
     · 取数与鉴权：GET /api/literature/{id}/export/preview 与 /export

   与前端的耦合点只有两个，都是既有约定：
     · window.KnowOriginLiterature.currentId() —— 当前正在读的文献项目 id；
     · api() —— app.js 的请求封装（401 会自动切登录视图）。
   ============================================================ */
(function () {
  "use strict";

  var OPT_KEY = "knoworigin.literatureExport.v1";
  var STYLE_ID = "lit-export-style";
  var DIALOG_ID = "lit-export-dialog";
  var BTN_ATTR = "data-lit-export-entry";

  function currentLiteratureId() {
    try {
      var api = window.KnowOriginLiterature;
      if (!api || typeof api.currentId !== "function") return "";
      return api.currentId() || "";
    } catch (e) {
      return "";
    }
  }

  function esc(value) {
    try { return escapeHtml(String(value == null ? "" : value)); }
    catch (e) {
      var d = document.createElement("div");
      d.textContent = String(value == null ? "" : value);
      return d.innerHTML;
    }
  }

  function loadOptions() {
    var def = { fulltext: true, figures: true, translation: true, notes: true, ai: true, comparison: true, deep: true };
    try {
      var raw = localStorage.getItem(OPT_KEY);
      if (!raw) return def;
      var saved = JSON.parse(raw) || {};
      return {
        fulltext: saved.fulltext !== false,
        figures: saved.figures !== false,
        translation: saved.translation !== false,
        notes: saved.notes !== false,
        ai: saved.ai !== false,
        comparison: saved.comparison !== false,
        deep: saved.deep !== false,
      };
    } catch (e) {
      return def;
    }
  }

  function saveOptions(opt) {
    try { localStorage.setItem(OPT_KEY, JSON.stringify(opt)); } catch (e) { /* 隐私模式忽略 */ }
  }

  function buildQuery(opt) {
    var q = new URLSearchParams();
    ["fulltext", "figures", "translation", "notes", "ai", "comparison", "deep"].forEach(function (key) {
      q.set(key, opt[key] ? "1" : "0");
    });
    return q.toString();
  }

  /* ---------------- 样式（跟随主题变量，深浅色自动适配） ---------------- */
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      /* 注意：不要给弹窗类名写 display —— 会盖掉 UA 的 dialog:not([open])，
         close() 之后弹窗会赖在页面上。 */
      ".lit-export-dialog {",
      "  width: min(560px, calc(100vw - 32px));",
      "  max-height: calc(100vh - 48px);",
      "  overflow: hidden;",                 /* 滚动交给内部 .lx-scroll，头脚固定 */
      "  border: 1px solid var(--line);",
      "  background: var(--panel);",
      "  color: var(--ink);",
      "}",
      ".lit-export-dialog::backdrop {",
      "  background: rgba(49, 44, 37, 0.42);",
      "  backdrop-filter: blur(6px);",
      "}",
      ".lx-body { display: flex; flex-direction: column; gap: 14px;",
      "  max-height: calc(100vh - 48px); padding: 20px 22px 18px; }",
      ".lx-scroll { display: grid; gap: 14px; min-height: 0; overflow-y: auto;",
      "  overscroll-behavior: contain; padding-right: 2px; }",
      ".lx-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }",
      ".lx-eyebrow { margin: 0; font-size: calc(11px * var(--font-scale, 1)); letter-spacing: 0.16em; text-transform: uppercase; color: var(--muted); }",
      ".lx-title { margin: 2px 0 0; font-size: calc(18px * var(--font-scale, 1)); }",
      ".lx-close { border: 1px solid var(--line); background: transparent; color: var(--muted);",
      "  width: 28px; height: 28px; border-radius: 50%; cursor: pointer; line-height: 1; }",
      ".lx-close:hover { color: var(--ink); }",
      ".lx-lead { margin: 0; font-size: calc(13px * var(--font-scale, 1)); line-height: 1.7; color: var(--muted); }",
      ".lx-lead code { padding: 1px 5px; border-radius: 5px; background: var(--sidebar); color: var(--ink);",
      "  font-family: ui-monospace, Menlo, Consolas, monospace; font-size: calc(12px * var(--font-scale, 1)); }",
      ".lx-opts { display: grid; gap: 9px; padding: 12px 14px; border: 1px solid var(--line);",
      "  border-radius: 12px; background: var(--sidebar); }",
      ".lx-check { display: flex; align-items: center; gap: 8px; font-size: calc(13px * var(--font-scale, 1)); cursor: pointer; }",
      ".lx-check input { accent-color: var(--green); }",
      ".lx-check .lx-tag { font-size: calc(11px * var(--font-scale, 1)); padding: 1px 6px; border-radius: 999px;",
      "  background: var(--green-soft); color: var(--green-dark); }",
      ".lx-stats { border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px;",
      "  background: var(--panel); font-size: calc(13px * var(--font-scale, 1)); line-height: 1.8; }",
      ".lx-stats b { color: var(--green-dark); }",
      ".lx-stats .lx-warn { color: var(--red); }",
      ".lx-stats .lx-mute { color: var(--muted); }",
      ".lx-sections { margin: 6px 0 0; padding: 0; list-style: none; font-size: calc(12px * var(--font-scale, 1));",
      "  color: var(--muted); font-family: ui-monospace, Menlo, Consolas, monospace; }",
      ".lx-sections li { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      ".lx-msg { font-size: calc(13px * var(--font-scale, 1)); padding: 9px 12px; border-radius: 10px; background: var(--green-soft); }",
      ".lx-msg.is-err { background: var(--red-soft); }",
      ".lx-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; }",
      ".lx-hint { font-size: calc(12px * var(--font-scale, 1)); color: var(--muted); }",
      ".lx-actions { display: inline-flex; gap: 8px; }",
      ".lx-actions .mini-button[disabled] { opacity: 0.55; cursor: progress; }",
      /* .mini-button.primary 在 styles.css 里只对特定容器生效，这里补一份，
         否则「下载」和「取消」长得一样、主操作不突出 */
      ".lx-actions .mini-button.primary { background: var(--green); border-color: var(--green); color: #fff; }",
      ".lx-actions .mini-button.primary:hover { background: var(--green-dark); border-color: var(--green-dark); }",
      /* 深色下 --green 偏亮，白字对比不足 —— 与 styles.css 里其它深色按钮同款处理 */
      'html[data-theme="dark"] .lx-actions .mini-button.primary { color: #0e1410; }',
      /* 顶栏入口：跟着既有 pill 按钮的观感，空间不足时标签出省略号而不是撑破 */
      ".lit-export-entry { white-space: nowrap; }",
      "@media (max-width: 520px) {",
      "  .lx-foot { flex-direction: column; align-items: stretch; }",
      "}",
    ].join("\n");
    var tag = document.createElement("style");
    tag.id = STYLE_ID;
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  /* ---------------- 弹窗骨架 ---------------- */
  function ensureDialog() {
    var dlg = document.getElementById(DIALOG_ID);
    if (dlg) return dlg;
    dlg = document.createElement("dialog");
    dlg.id = DIALOG_ID;
    dlg.className = "lit-export-dialog";
    dlg.setAttribute("aria-labelledby", "lx-title");
    dlg.innerHTML =
      '<div class="lx-body">' +
        '<div class="lx-head">' +
          "<div>" +
            '<p class="lx-eyebrow">文献精读</p>' +
            '<h3 class="lx-title" id="lx-title">导出精读成果</h3>' +
          "</div>" +
          '<button class="lx-close" type="button" data-lx-close aria-label="关闭">✕</button>' +
        "</div>" +
        '<p class="lx-lead">导出的是<strong>标准 Markdown</strong>，配套图片放在 <code>assets/</code>：' +
          "解压后可以直接拖进 Obsidian，或用任何编辑器打开、直接贴进报告。</p>" +
        '<div class="lx-scroll">' +
          '<div class="lx-opts">' +
            '<label class="lx-check"><input type="checkbox" data-lx="fulltext"> 原文正文（含图表与公式还原）</label>' +
            '<label class="lx-check"><input type="checkbox" data-lx="figures"> 图表导出为图片文件</label>' +
            '<label class="lx-check"><input type="checkbox" data-lx="translation"> 全文中英对照</label>' +
            '<label class="lx-check"><input type="checkbox" data-lx="notes"> 我的笔记与高亮 <span class="lx-tag">你写的</span></label>' +
            '<label class="lx-check"><input type="checkbox" data-lx="ai"> AI 解释 <span class="lx-tag">AI 生成</span></label>' +
            '<label class="lx-check"><input type="checkbox" data-lx="deep"> AI 深度解析 <span class="lx-tag">AI 生成</span></label>' +
            '<label class="lx-check"><input type="checkbox" data-lx="comparison"> 文献对比结果</label>' +
          "</div>" +
          '<div class="lx-stats" data-lx-stats>正在统计…</div>' +
          '<div class="lx-msg" data-lx-msg hidden></div>' +
        "</div>" +
        '<div class="lx-foot">' +
          '<span class="lx-hint">导出不会改动知源里的任何数据，可随时重导</span>' +
          '<span class="lx-actions">' +
            '<button class="mini-button" type="button" data-lx-close>取消</button>' +
            '<button class="mini-button primary" type="button" data-lx-download>下载 .zip</button>' +
          "</span>" +
        "</div>" +
      "</div>";

    dlg.addEventListener("click", function (event) {
      if (event.target === dlg) closeDialog();  // 点遮罩关闭
      if (event.target.closest && event.target.closest("[data-lx-close]")) {
        event.preventDefault();
        closeDialog();
      }
      if (event.target.closest && event.target.closest("[data-lx-download]")) {
        event.preventDefault();
        runDownload(dlg);
      }
    });
    dlg.addEventListener("change", function (event) {
      if (event.target.closest && event.target.closest("[data-lx]")) {
        collectOptions(dlg);
        refreshStats(dlg);
      }
    });

    document.body.appendChild(dlg);
    return dlg;
  }

  function collectOptions(dlg) {
    var opt = loadOptions();
    ["fulltext", "figures", "translation", "notes", "ai", "comparison", "deep"].forEach(function (key) {
      var el = dlg.querySelector("[data-lx='" + key + "']");
      if (el) opt[key] = !!el.checked;
    });
    saveOptions(opt);
    return opt;
  }

  function applyOptions(dlg, opt) {
    ["fulltext", "figures", "translation", "notes", "ai", "comparison", "deep"].forEach(function (key) {
      var el = dlg.querySelector("[data-lx='" + key + "']");
      if (el) el.checked = !!opt[key];
    });
  }

  function setMsg(dlg, text, isError) {
    var msg = dlg.querySelector("[data-lx-msg]");
    if (!msg) return;
    if (!text) {
      msg.hidden = true;
      msg.textContent = "";
      return;
    }
    msg.hidden = false;
    msg.className = "lx-msg" + (isError ? " is-err" : "");
    msg.textContent = text;
  }

  /* ---------------- 报数：先告诉用户会导出什么 ---------------- */
  function refreshStats(dlg) {
    var pid = currentLiteratureId();
    var box = dlg.querySelector("[data-lx-stats]");
    var btn = dlg.querySelector("[data-lx-download]");
    if (!box) return;
    if (!pid) {
      box.innerHTML = '<span class="lx-warn">还没有打开任何文献。</span>请先在左侧文献库里选一篇，再回来导出。';
      if (btn) btn.disabled = true;
      return;
    }
    var token = (dlg._lxToken = (dlg._lxToken || 0) + 1);
    box.innerHTML = "正在统计…";
    if (btn) btn.disabled = true;

    api("/api/literature/" + encodeURIComponent(pid) + "/export/preview?" + buildQuery(collectOptions(dlg)))
      .then(function (data) {
        if (dlg._lxToken !== token || !dlg.open) return;
        var s = data.stats || {};
        var html = "将生成 <b>" + (s.files || 0) + "</b> 个文件";
        html += " · 图表 <b>" + (s.figures || 0) + "</b> 张 · 公式 <b>" + (s.formulas || 0) + "</b> 条";
        html += "<br>我的笔记 <b>" + (s.notes || 0) + "</b> 条 · 高亮 <b>" + (s.highlights || 0) + "</b> 条";
        if (s.ai_answers) {
          html += " · AI 解释 <b>" + s.ai_answers + "</b> 条";
        } else {
          html += '<br><span class="lx-mute">AI 解释 0 条 —— 这篇文献的划词解释与问答还没有落库，' +
            "刷新后不会保留，因此导不出。先正常使用一次 AI 解释，之后即可导出。</span>";
        }
        if (s.missing_figures) {
          html += '<br><span class="lx-warn">有 ' + s.missing_figures +
            " 张图的原图数据无法解析</span><span class=\"lx-mute\">，导出时会保留图注并注明缺失。</span>";
        }
        if (s.image_formulas) {
          html += '<br><span class="lx-mute">有 ' + s.image_formulas + " 条公式在原文里就是图形排版，将按图片导出。</span>";
        }
        if (s.chars) {
          html += '<br><span class="lx-mute">正文合计约 ' + Math.round(s.chars / 1000) + " 千字</span>";
        }
        if (data.sections && data.sections.length) {
          html += '<ul class="lx-sections">' + data.sections.map(function (p) {
            return "<li>" + esc(p) + "</li>";
          }).join("") + "</ul>";
        }
        box.innerHTML = html;
        if (btn) btn.disabled = false;
      })
      .catch(function (err) {
        if (dlg._lxToken !== token) return;
        box.innerHTML = '<span class="lx-warn">统计失败：' + esc(err && err.message ? err.message : "未知错误") + "</span>";
        if (btn) btn.disabled = true;
      });
  }

  /* ---------------- 下载 ---------------- */
  function filenameFromHeader(res, fallback) {
    var cd = res.headers.get("Content-Disposition") || "";
    var m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    if (m) {
      try { return decodeURIComponent(m[1]); } catch (e) { /* 落到兜底 */ }
    }
    return fallback;
  }

  function runDownload(dlg) {
    var pid = currentLiteratureId();
    if (!pid) return;
    var btn = dlg.querySelector("[data-lx-download]");
    var opt = collectOptions(dlg);
    if (btn) {
      btn.disabled = true;
      btn.dataset.lxLabel = btn.textContent;
      btn.textContent = "正在打包…";
    }
    setMsg(dlg, "");

    // 要二进制，所以用裸 fetch（api() 会把响应当 JSON 处理）
    fetch("/api/literature/" + encodeURIComponent(pid) + "/export?" + buildQuery(opt), {
      credentials: "same-origin",
    })
      .then(function (res) {
        if (!res.ok) {
          if (res.status === 401) {
            try { showAuthView(); } catch (e) { /* 忽略 */ }
            throw new Error("登录状态已过期，请重新登录后再导出。");
          }
          if (res.status === 422) {
            throw new Error("这篇文献还没有可导出的精读内容。");
          }
          throw new Error("导出失败（HTTP " + res.status + "）");
        }
        var name = filenameFromHeader(res, "文献精读.zip");
        var files = res.headers.get("X-Export-Files");
        var figures = res.headers.get("X-Export-Figures");
        var ai = res.headers.get("X-Export-Ai-Answers");
        return res.blob().then(function (blob) {
          return { blob: blob, name: name, files: files, figures: figures, ai: ai, bytes: blob.size };
        });
      })
      .then(function (out) {
        var url = URL.createObjectURL(out.blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = out.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
        var mb = (out.bytes / 1024 / 1024).toFixed(2);
        var extra = [];
        if (out.files) extra.push(out.files + " 个文件");
        if (out.figures) extra.push(out.figures + " 张图");
        if (out.ai) extra.push(out.ai + " 条 AI 解释");
        setMsg(
          dlg,
          "已导出 " + out.name + "（" + (extra.length ? extra.join("，") + "，" : "") + mb + " MB）。" +
            "解压后即可用 Obsidian 或任意编辑器打开。",
          false
        );
      })
      .catch(function (err) {
        setMsg(dlg, err && err.message ? err.message : "导出失败，请稍后重试。", true);
      })
      .finally(function () {
        if (btn) {
          btn.disabled = false;
          btn.textContent = btn.dataset.lxLabel || "下载 .zip";
        }
      });
  }

  function closeDialog() {
    var dlg = document.getElementById(DIALOG_ID);
    if (!dlg) return;
    try { dlg.close(); } catch (e) { dlg.removeAttribute("open"); }
  }

  function openDialog() {
    ensureStyle();
    var dlg = ensureDialog();
    applyOptions(dlg, loadOptions());
    setMsg(dlg, "");
    try { dlg.showModal(); } catch (e) { dlg.setAttribute("open", ""); }
    refreshStats(dlg);
  }

  /* ---------------- 入口 ---------------- */
  function injectEntry() {
    var host = document.getElementById("lit-topbar-actions");
    if (!host || host.querySelector("[" + BTN_ATTR + "]")) return;
    ensureStyle();   // 入口按钮的样式也在这个 style 块里，不能等到开弹窗才注入
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "secondary-button lit-export-entry";
    btn.setAttribute(BTN_ATTR, "");
    btn.title = "导出精读成果：把这篇文献的原文与图表、中英对照、笔记、AI 解释打包成 Markdown";
    btn.setAttribute("aria-label", "导出精读成果");
    // 顶栏按钮只出图标（动作名在 title / aria-label）。图标用「箱 + 封条」，
    // 表达「打包导出一个 zip」，跟下载单文件的箭头区分开。
    btn.innerHTML =
      '<span class="tb-ic"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      '<path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg></span>';
    btn.addEventListener("click", function (event) {
      event.preventDefault();
      openDialog();
    });
    // 放在「文献信息」旁边：两者都是「关于这篇文献」的动作
    var infoBtn = host.querySelector("#lit-info-button");
    host.insertBefore(btn, infoBtn || host.firstChild);
  }

  function boot() {
    ensureStyle();
    injectEntry();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
  window.addEventListener("load", boot);
  // 文献工作区是整页切换的（#literature-workspace 用 hidden 控制），
  // 进入阅读页时顶栏才可见。顶栏本身是静态 DOM，这里再兜一次防止
  // 脚本加载早于布局；兜底是幂等的。
  var pending = false;
  new MutationObserver(function () {
    if (pending) return;
    pending = true;
    setTimeout(function () { pending = false; injectEntry(); }, 200);
  }).observe(document.documentElement, { childList: true, subtree: true });

  window.KnowOriginLiteratureExport = { open: openDialog, close: closeDialog, inject: injectEntry };
})();
