/**
 * 文献引用导出 —— 在文献精读的顶栏加一个「引用」按钮，导出 BibTeX / CSL JSON。
 *
 * 为什么需要它：
 *   文献模式此前是"读得进去、出不来"—— 读完二十篇要写综述时，拿不到参考文献列表。
 *   而 literature_meta 表里 title/authors/year/venue/doi 本来就有，只是没人把它
 *   导成别人（Zotero / LaTeX / Pandoc）能吃的格式。
 *
 * 只读 + 只新增：不改 literature.js、不改既有端点。删掉 index.html 那一行脚本即完全回退。
 * 锚点 #lit-topbar-actions 是静态 DOM（index.html:334），注入不会被 innerHTML 冲掉。
 */
(function () {
  "use strict";

  var BTN_ID = "ko-cite-entry";
  var DIALOG_ID = "ko-cite-dialog";
  var STYLE_ID = "ko-cite-style";

  var state = { busy: false, meta: null, projectId: "", lastError: "" };

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

  function notify(text, variant) {
    try {
      if (typeof showToast === "function") {
        showToast(text, { variant: variant || "notice" });
        return;
      }
    } catch (error) {
      /* 忽略 */
    }
  }

  /** 下载文本文件。用 Blob 而不是 data URI —— 长篇 BibTeX 用 data URI 会被长度限制截断。 */
  function download(filename, text) {
    try {
      var blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 2000);
      return true;
    } catch (error) {
      return false;
    }
  }

  function copy(text) {
    // 剪贴板 API 在非 HTTPS 的局域网访问下不可用，所以两级降级
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard
        .writeText(text)
        .then(function () {
          return true;
        })
        .catch(function () {
          return fallbackCopy(text);
        });
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    try {
      var area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch (error) {
      return false;
    }
  }

  // ---------------------------------------------------------------- 样式 --

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      "#" + BTN_ID + "{display:inline-flex;align-items:center;gap:5px}",
      /* 注意：dialog 的类名上绝不写 display —— 会盖掉 UA 的
         dialog:not([open]){display:none}，close() 之后弹窗赖着不走。 */
      "." + DIALOG_ID + "{width:min(520px,92vw);max-height:80vh;padding:0;border:1px solid var(--line);",
      "border-radius:14px;background:var(--panel);color:var(--ink);overflow:hidden}",
      "." + DIALOG_ID + "::backdrop{background:rgba(0,0,0,.42)}",
      ".ko-cite-head{display:flex;align-items:center;justify-content:space-between;gap:10px;",
      "padding:12px 16px;border-bottom:1px solid var(--line)}",
      ".ko-cite-head h3{margin:0;font-size:calc(14px * var(--font-scale, 1));font-weight:500}",
      ".ko-cite-body{padding:14px 16px 16px;overflow-y:auto;max-height:calc(80vh - 50px)}",
      ".ko-cite-title{font-size:calc(13px * var(--font-scale, 1));font-weight:500;margin:0 0 6px;line-height:1.6;",
      "word-break:break-word}",
      ".ko-cite-meta{font-size:calc(11.5px * var(--font-scale, 1));color:var(--muted);line-height:1.7;margin:0 0 12px;",
      "word-break:break-word}",
      ".ko-cite-actions{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}",
      ".ko-cite-btn{border:1px solid var(--line);background:transparent;color:var(--ink);",
      "border-radius:9px;padding:7px 11px;font-size:calc(12px * var(--font-scale, 1));cursor:pointer;font-family:inherit;",
      "white-space:nowrap}",
      ".ko-cite-btn:hover{border-color:var(--muted)}",
      ".ko-cite-btn:disabled{opacity:.5;cursor:not-allowed}",
      ".ko-cite-btn.primary{background:var(--green);border-color:var(--green);color:#fff}",
      "html[data-theme='dark'] .ko-cite-btn.primary{color:#0e1410}",
      ".ko-cite-preview{border:1px solid var(--line);border-radius:10px;background:var(--background);",
      "padding:10px 12px;font-family:ui-monospace,Consolas,monospace;font-size:calc(11.5px * var(--font-scale, 1));",
      "line-height:1.6;white-space:pre-wrap;word-break:break-all;max-height:210px;",
      "overflow-y:auto;margin:0}",
      ".ko-cite-note{font-size:calc(11px * var(--font-scale, 1));color:var(--muted);line-height:1.65;margin:10px 0 0}",
      ".ko-cite-err{border:1px solid var(--red);border-radius:9px;padding:8px 10px;",
      "color:var(--red);font-size:calc(12px * var(--font-scale, 1));margin-bottom:10px}",
    ].join("\n");
    var node = document.createElement("style");
    node.id = STYLE_ID;
    node.textContent = css;
    document.head.appendChild(node);
  }

  // ---------------------------------------------------------------- 弹窗 --

  function ensureDialog() {
    var existing = document.getElementById(DIALOG_ID);
    if (existing) return existing;
    var dialog = document.createElement("dialog");
    dialog.id = DIALOG_ID;
    dialog.className = DIALOG_ID;
    dialog.innerHTML =
      '<div class="ko-cite-head"><h3>导出引用</h3>' +
      '<button type="button" class="ko-cite-btn" data-ko-cite="close">关闭</button></div>' +
      '<div class="ko-cite-body" data-ko-cite-slot></div>';
    dialog.addEventListener("click", function (event) {
      var trigger = event.target.closest("[data-ko-cite]");
      if (!trigger) return;
      handleAction(trigger.getAttribute("data-ko-cite"));
    });
    document.body.appendChild(dialog);
    return dialog;
  }

  function render() {
    var slot = document.querySelector("[data-ko-cite-slot]");
    if (!slot) return;
    var meta = state.meta || {};
    var title = meta.title || "（尚未抽取元数据）";
    var authors = meta.authors || "";
    var venueYear = [meta.venue, meta.year].filter(Boolean).join(" · ");
    var doi = meta.doi || "";

    var detail = [authors, venueYear, doi ? "DOI " + doi : "无 DOI"].filter(Boolean);
    if (!detail.length) detail = ["还没有元数据 —— 先去文献信息里点「抽取元数据」"];

    slot.innerHTML =
      (state.lastError ? '<div class="ko-cite-err">' + esc(state.lastError) + "</div>" : "") +
      '<p class="ko-cite-title">' + esc(title) + "</p>" +
      '<p class="ko-cite-meta">' + esc(detail.join(" · ")) + "</p>" +
      '<div class="ko-cite-actions">' +
      '<button type="button" class="ko-cite-btn primary" data-ko-cite="copy-bibtex">复制 BibTeX</button>' +
      '<button type="button" class="ko-cite-btn" data-ko-cite="copy-csl">复制 CSL JSON</button>' +
      '<button type="button" class="ko-cite-btn" data-ko-cite="download-bibtex">下载 .bib</button>' +
      (doi ? "" : '<button type="button" class="ko-cite-btn" data-ko-cite="enrich">用 Crossref 补全 DOI</button>') +
      "</div>" +
      '<pre class="ko-cite-preview" data-ko-cite-preview>正在生成…</pre>' +
      '<p class="ko-cite-note">' +
      "BibTeX 直接贴进 .bib 文件；CSL JSON 可被 Zotero、Pandoc、Obsidian 的引用插件导入。" +
      "缺失的字段会留空，不会编造。" +
      "</p>" +
      '<div class="ko-cite-actions" style="margin-top:12px">' +
      '<button type="button" class="ko-cite-btn" data-ko-cite="export-all">导出全部文献的引用</button>' +
      "</div>";
    loadPreview();
  }

  function loadPreview() {
    var box = document.querySelector("[data-ko-cite-preview]");
    if (!box || !state.projectId) return;
    call(
      "/api/literature/" + encodeURIComponent(state.projectId) + "/citation?format=bibtex"
    )
      .then(function (data) {
        box.textContent = (data && data.content) || "（空）";
      })
      .catch(function () {
        box.textContent = "（生成失败，可稍后重试）";
      });
  }

  function handleAction(action) {
    var dialog = document.getElementById(DIALOG_ID);
    if (action === "close") {
      if (dialog && dialog.open) dialog.close();
      return;
    }
    if (state.busy) return;

    if (action === "export-all") {
      exportAll();
      return;
    }
    if (!state.projectId) {
      notify("请先在「我的文献」里选中一篇。", "notice");
      return;
    }

    var base = "/api/literature/" + encodeURIComponent(state.projectId) + "/citation";
    if (action === "enrich") {
      state.busy = true;
      state.lastError = "";
      render();
      call("/api/literature/" + encodeURIComponent(state.projectId) + "/enrich-metadata", {
        method: "POST",
        body: {},
      })
        .then(function (data) {
          state.busy = false;
          notify((data && data.message) || "已尝试补全。", "notice");
          return refreshMeta();
        })
        .catch(function (error) {
          state.busy = false;
          state.lastError = (error && error.message) || "补全失败。";
          render();
        });
      return;
    }

    var wantsCsl = action === "copy-csl";
    var url = base + "?format=" + (wantsCsl ? "csl-json" : "bibtex");
    state.busy = true;
    call(url)
      .then(function (data) {
        state.busy = false;
        var text = (data && data.content) || "";
        if (!text.trim()) {
          notify("这篇还没有可导出的元数据。", "notice");
          return;
        }
        if (action === "download-bibtex") {
          if (download((data && data.filename) || "citation.bib", text)) {
            notify("已下载。", "notice");
          } else {
            copy(text);
            notify("浏览器不允许直接下载，已复制到剪贴板。", "notice");
          }
          return;
        }
        copy(text).then(function (ok) {
          notify(ok ? "已复制到剪贴板。" : "复制失败，请手动选择文本。", "notice");
        });
      })
      .catch(function (error) {
        state.busy = false;
        state.lastError = (error && error.message) || "导出失败。";
        render();
      });
  }

  function exportAll() {
    state.busy = true;
    state.lastError = "";
    render();
    call("/api/literature")
      .then(function (data) {
        var items = (data && data.items) || (data && data.literature) || [];
        var ids = items
          .map(function (item) {
            return (item && item.project && item.project.project_id) || "";
          })
          .filter(Boolean);
        if (!ids.length) {
          state.busy = false;
          state.lastError = "还没有文献可以导出。";
          render();
          return null;
        }
        return call(
          "/api/citations/export?format=bibtex&project_ids=" +
            encodeURIComponent(ids.join(","))
        ).then(function (result) {
          state.busy = false;
          var text = (result && result.content) || "";
          notify(
            "已导出 " + (result && result.count ? result.count : ids.length) + " 条引用。",
            "notice"
          );
          if (!download("citations.bib", text)) copy(text);
          render();
        });
      })
      .catch(function (error) {
        state.busy = false;
        state.lastError = (error && error.message) || "批量导出失败。";
        render();
      });
  }

  // ------------------------------------------------------------ 当前文献 --

  function currentProjectId() {
    // literature.js 的列表项在选中时加 .active（见其 renderLibrary）。
    // 这里从 DOM 读而不是改 literature.js 去暴露 currentId —— 保持零侵入。
    var selectors = [
      "#lit-list .lit-item.active [data-lit-action='select']",
      "#lit-list .lit-item.active",
    ];
    for (var index = 0; index < selectors.length; index += 1) {
      var node = document.querySelector(selectors[index]);
      if (!node) continue;
      var id = node.getAttribute("data-id") || node.getAttribute("data-lit-id") || "";
      if (id) return id;
    }
    return "";
  }

  function refreshMeta() {
    if (!state.projectId) {
      state.meta = null;
      render();
      return Promise.resolve();
    }
    return call("/api/literature/" + encodeURIComponent(state.projectId))
      .then(function (data) {
        state.meta = (data && data.meta) || {};
        state.lastError = "";
        render();
      })
      .catch(function () {
        state.meta = null;
        render();
      });
  }

  function openDialog() {
    var projectId = currentProjectId();
    state.projectId = projectId;
    state.meta = null;
    state.lastError = "";
    var dialog = ensureDialog();
    if (!dialog.open) dialog.showModal();
    if (!projectId) {
      var slot = document.querySelector("[data-ko-cite-slot]");
      if (slot) {
        slot.innerHTML =
          '<p class="ko-cite-meta">请先在「我的文献」里点选一篇论文，再点这个按钮。</p>' +
          '<div class="ko-cite-actions">' +
          '<button type="button" class="ko-cite-btn" data-ko-cite="export-all">导出全部文献的引用</button>' +
          "</div>";
      }
      return;
    }
    render();
    refreshMeta();
  }

  // ---------------------------------------------------------------- 注入 --

  function ensureButton() {
    if (document.getElementById(BTN_ID)) return;
    var host = document.querySelector("#lit-topbar-actions") ||
      document.querySelector(".lit-topbar-actions");
    if (!host) return;
    var anchor = document.getElementById("lit-info-button");
    var button = document.createElement("button");
    button.id = BTN_ID;
    button.type = "button";
    button.className = "secondary-button ko-cite-topbar-btn";
    button.title = "导出引用（BibTeX / CSL JSON）";
    button.setAttribute("aria-label", "导出引用（BibTeX / CSL JSON）");
    // 顶栏按钮一律只出图标：动作名放在 title / aria-label 上
    button.innerHTML = '<span class="tb-ic"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 0v6a3 3 0 0 0 3 3h2m7-9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 0v6a3 3 0 0 0 3 3h2"/></svg></span>';
    button.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      openDialog();
    });
    if (anchor && anchor.parentNode === host) host.insertBefore(button, anchor);
    else host.appendChild(button);
  }

  function boot() {
    ensureStyle();
    ensureButton();
    // 文献模块是切到「文章阅读」才渲染的，工具栏按钮可能晚于本脚本出现
    if (!document.getElementById(BTN_ID)) {
      var observer = new MutationObserver(function () {
        ensureButton();
        if (document.getElementById(BTN_ID)) observer.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(function () {
        observer.disconnect();
      }, 20000);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.KnowOriginCitation = { open: openDialog };
})();
