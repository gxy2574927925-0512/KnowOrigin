/* 知源 · Obsidian 知识库导出面板
   ============================================================
   为什么单独一个文件：
     导出只做「加一个入口 + 一个弹窗 + 两个新端点」。自带的样式在本文件里
     注入 <style>，不碰 app.js / styles.css / index.html 的核心结构 ——
     删掉这个文件（和 index.html 里那行 <script>）就等于完全回退。

   与旧行为的区别：
     原来 app.js 里绑在 [data-kb-action='export'] 上的 kbExportVault 是
     「<a download> 点一下、没有任何反馈」。这里改成先在 document 捕获阶段
     接管这个点击，弹出面板：先报数（会生成多少篇 / 多少条双链），
     再下载，并给出成功/失败反馈。旧的底层函数保持不动，只是不再被触发。

   与前端的耦合点只有两个，都是既有约定：
     · state.currentProjectId —— 与 kb-source-view.js 同款取值方式；
     · api() —— app.js 的请求封装（401 会自动切登录视图）。
   ============================================================ */
(function () {
  "use strict";

  var OPT_KEY = "knoworigin.vaultExport.v1";
  var STYLE_ID = "vault-export-style";
  var DIALOG_ID = "vault-export-dialog";

  function currentProjectId() {
    try {
      // state 是 app.js 顶层 const，classic script 之间共享全局词法环境
      return (typeof state !== "undefined" && state && state.currentProjectId) || "";
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
    var def = { scope: "all", index: true, links: true, favorites: true, cards: true, quizzes: true, folder: "" };
    try {
      var raw = localStorage.getItem(OPT_KEY);
      if (!raw) return def;
      var saved = JSON.parse(raw) || {};
      return {
        scope: saved.scope === "noted" ? "noted" : "all",
        index: saved.index !== false,
        links: saved.links !== false,
        favorites: saved.favorites !== false,
        cards: saved.cards !== false,
        quizzes: saved.quizzes !== false,
        folder: typeof saved.folder === "string" ? saved.folder : "",
      };
    } catch (e) {
      return def;
    }
  }

  function saveOptions(opt) {
    try { localStorage.setItem(OPT_KEY, JSON.stringify(opt)); } catch (e) { /* 隐私模式下忽略 */ }
  }

  function buildQuery(opt) {
    var q = new URLSearchParams();
    q.set("scope", opt.scope);
    q.set("index", opt.index ? "1" : "0");
    q.set("links", opt.links ? "1" : "0");
    q.set("favorites", opt.favorites ? "1" : "0");
    q.set("cards", opt.cards ? "1" : "0");
    q.set("quizzes", opt.quizzes ? "1" : "0");
    if (opt.folder) q.set("folder", opt.folder);
    return q.toString();
  }

  /* ---------------- 样式（跟随主题变量，深浅色/两套品牌自动适配） ---------------- */
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      /* 注意：不要给弹窗类名写 display —— 会盖掉 UA 的 dialog:not([open])，
         close() 之后弹窗会赖在页面上。 */
      ".vault-export-dialog {",
      "  width: min(580px, calc(100vw - 32px));",
      "  max-height: calc(100vh - 48px);",
      "  overflow: hidden;",                 /* 滚动交给内部的 .ve-scroll，头和脚固定 */
      "  border: 1px solid var(--line);",
      "  background: var(--panel);",
      "  color: var(--ink);",
      "}",
      ".vault-export-dialog::backdrop {",
      "  background: rgba(49, 44, 37, 0.42);",
      "  backdrop-filter: blur(6px);",
      "}",
      ".ve-body { display: flex; flex-direction: column; gap: 14px;",
      "  max-height: calc(100vh - 48px); padding: 20px 22px 18px; }",
      /* 中间滚动区：内容再长也不会把「下载」按钮顶出屏幕 */
      ".ve-scroll { display: grid; gap: 14px; min-height: 0; overflow-y: auto;",
      "  overscroll-behavior: contain; padding-right: 2px; }",
      ".ve-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }",
      ".ve-eyebrow { margin: 0; font-size: calc(11px * var(--font-scale, 1)); letter-spacing: 0.16em; text-transform: uppercase; color: var(--muted); }",
      ".ve-title { margin: 2px 0 0; font-size: calc(18px * var(--font-scale, 1)); }",
      ".ve-close { border: 1px solid var(--line); background: transparent; color: var(--muted);",
      "  width: 28px; height: 28px; border-radius: 50%; cursor: pointer; line-height: 1; }",
      ".ve-close:hover { color: var(--ink); }",
      ".ve-lead { margin: 0; font-size: calc(13px * var(--font-scale, 1)); line-height: 1.7; color: var(--muted); }",
      ".ve-lead code { padding: 1px 5px; border-radius: 5px; background: var(--sidebar); color: var(--ink);",
      "  font-family: ui-monospace, Menlo, Consolas, monospace; font-size: calc(12px * var(--font-scale, 1)); }",
      ".ve-opts { display: grid; gap: 10px; padding: 12px 14px; border: 1px solid var(--line);",
      "  border-radius: 12px; background: var(--sidebar); }",
      ".ve-line { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: calc(13px * var(--font-scale, 1)); }",
      ".ve-line select, .ve-line input[type='text'] {",
      "  min-width: 180px; padding: 6px 9px; border: 1px solid var(--line); border-radius: 8px;",
      "  background: var(--panel); color: var(--ink); font: inherit; font-size: calc(13px * var(--font-scale, 1)); }",
      ".ve-line input[type='text'] { flex: 1; min-width: 0; }",
      ".ve-check { display: flex; align-items: center; gap: 8px; font-size: calc(13px * var(--font-scale, 1)); cursor: pointer; }",
      ".ve-check input { accent-color: var(--green); }",
      ".ve-stats { border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px;",
      "  background: var(--panel); font-size: calc(13px * var(--font-scale, 1)); line-height: 1.8; }",
      ".ve-stats b { color: var(--green-dark); }",
      ".ve-stats .ve-warn { color: var(--red); }",
      ".ve-stats .ve-mute { color: var(--muted); }",
      ".ve-sample { margin: 6px 0 0; padding: 0; list-style: none; font-size: calc(12px * var(--font-scale, 1));",
      "  color: var(--muted); font-family: ui-monospace, Menlo, Consolas, monospace; }",
      ".ve-sample li { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      ".ve-msg { font-size: calc(13px * var(--font-scale, 1)); padding: 9px 12px; border-radius: 10px; background: var(--green-soft); }",
      ".ve-msg.is-err { background: var(--red-soft); }",
      ".ve-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; }",
      ".ve-hint { font-size: calc(12px * var(--font-scale, 1)); color: var(--muted); }",
      ".ve-actions { display: inline-flex; gap: 8px; }",
      ".ve-actions .mini-button[disabled] { opacity: 0.55; cursor: progress; }",
      /* .mini-button.primary 在 styles.css 里只对特定容器生效，这里给本弹窗补一份，
         否则「下载」和「取消」长得一模一样，主操作不突出 */
      ".ve-actions .mini-button.primary { background: var(--green); border-color: var(--green); color: #fff; }",
      ".ve-actions .mini-button.primary:hover { background: var(--green-dark); border-color: var(--green-dark); }",
      /* 深色下 --green 偏亮，白字对比不足 —— 与 styles.css 里其它深色按钮同款处理 */
      'html[data-theme="dark"] .ve-actions .mini-button.primary { color: #0e1410; }',
      /* 头部入口现在和「展开」挤在同一排，所以它自己也要能缩：
         空间不足时标签出省略号，而不是把整块动作区挤到第二行。
         （原先 ≤720px 直接 display:none 隐藏标签；去掉图标后标签是按钮上
           唯一的文字，再隐藏就成了空胶囊，故改为常显 + 省略号兜底。） */
      ".vault-export-entry { white-space: nowrap; padding: 6px 9px; }",
      ".studio-heading-actions .vault-export-entry {",
      "  display: inline-flex; align-items: center; min-width: 0; overflow: hidden; }",
      ".studio-heading-actions .vault-export-entry-label {",
      "  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      "@media (max-width: 520px) {",
      "  .ve-line { flex-direction: column; align-items: stretch; }",
      "  .ve-foot { flex-direction: column; align-items: stretch; }",
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
    dlg.className = "vault-export-dialog";
    dlg.setAttribute("aria-labelledby", "ve-title");
    dlg.innerHTML =
      '<div class="ve-body">' +
        '<div class="ve-head">' +
          "<div>" +
            '<p class="ve-eyebrow">Obsidian 知识库</p>' +
            '<h3 class="ve-title" id="ve-title">导出为 Obsidian 库</h3>' +
          "</div>" +
          '<button class="ve-close" type="button" data-ve-close aria-label="关闭">✕</button>' +
        "</div>" +
        '<p class="ve-lead">导出的是标准 Markdown + <code>[[双链]]</code>，不锁进任何私有格式：' +
          "解压后把整个文件夹拖进 Obsidian 的库目录，双链、别名、标签、Frontmatter 都还在。</p>" +
        '<div class="ve-scroll">' +
        '<div class="ve-opts">' +
          '<label class="ve-line"><span>导出范围</span>' +
            '<select data-ve="scope">' +
              '<option value="all">全部知识点（保留完整双链图谱）</option>' +
              '<option value="noted">只有写过笔记的（更精简）</option>' +
            "</select></label>" +
          '<label class="ve-line"><span>顶层文件夹名</span>' +
            '<input type="text" data-ve="folder" placeholder="默认：项目名-知识库" maxlength="60"></label>' +
          '<label class="ve-check"><input type="checkbox" data-ve="index"> 生成 README 索引（带全库目录树）</label>' +
          '<label class="ve-check"><input type="checkbox" data-ve="links"> 每篇末尾附「关联」双链清单</label>' +
          '<label class="ve-check"><input type="checkbox" data-ve="favorites"> 并入「我的笔记」收藏片段</label>' +
          '<label class="ve-check"><input type="checkbox" data-ve="cards"> 带上生成的知识卡片（并入对应知识点）</label>' +
          '<label class="ve-check"><input type="checkbox" data-ve="quizzes"> 带上生成的小测验（并入对应知识点）</label>' +
        "</div>" +
        '<div class="ve-stats" data-ve-stats>正在统计…</div>' +
        '<div class="ve-msg" data-ve-msg hidden></div>' +
        "</div>" +
        '<div class="ve-foot">' +
          '<span class="ve-hint">导出后可随时重导，不改变知源里的任何数据</span>' +
          '<span class="ve-actions">' +
            '<button class="mini-button" type="button" data-ve-close>取消</button>' +
            '<button class="mini-button primary" type="button" data-ve-download>下载 .zip</button>' +
          "</span>" +
        "</div>" +
      "</div>";

    dlg.addEventListener("click", function (event) {
      if (event.target === dlg) closeDialog();  // 点遮罩关闭
      var closer = event.target.closest && event.target.closest("[data-ve-close]");
      if (closer) {
        event.preventDefault();
        closeDialog();
      }
      var dl = event.target.closest && event.target.closest("[data-ve-download]");
      if (dl) {
        event.preventDefault();
        runDownload(dlg);
      }
    });
    dlg.addEventListener("change", function (event) {
      if (event.target.closest && event.target.closest("[data-ve]")) {
        collectOptions(dlg);
        refreshStats(dlg);
      }
    });
    dlg.addEventListener("input", function (event) {
      var f = event.target.closest && event.target.closest("[data-ve='folder']");
      if (!f) return;
      clearTimeout(dlg._veTimer);
      dlg._veTimer = setTimeout(function () {
        collectOptions(dlg);
        refreshStats(dlg);
      }, 320);
    });

    document.body.appendChild(dlg);
    return dlg;
  }

  function collectOptions(dlg) {
    var opt = loadOptions();
    var scope = dlg.querySelector("[data-ve='scope']");
    var folder = dlg.querySelector("[data-ve='folder']");
    var index = dlg.querySelector("[data-ve='index']");
    var links = dlg.querySelector("[data-ve='links']");
    var favs = dlg.querySelector("[data-ve='favorites']");
    var cards = dlg.querySelector("[data-ve='cards']");
    var quizzes = dlg.querySelector("[data-ve='quizzes']");
    if (scope) opt.scope = scope.value === "noted" ? "noted" : "all";
    if (folder) opt.folder = folder.value.trim();
    if (index) opt.index = index.checked;
    if (links) opt.links = links.checked;
    if (favs) opt.favorites = favs.checked;
    if (cards) opt.cards = cards.checked;
    if (quizzes) opt.quizzes = quizzes.checked;
    saveOptions(opt);
    return opt;
  }

  function applyOptions(dlg, opt) {
    var set = function (sel, val) {
      var el = dlg.querySelector(sel);
      if (el) el.value = val;
    };
    set("[data-ve='scope']", opt.scope);
    set("[data-ve='folder']", opt.folder);
    var check = function (sel, val) {
      var el = dlg.querySelector(sel);
      if (el) el.checked = !!val;
    };
    check("[data-ve='index']", opt.index);
    check("[data-ve='links']", opt.links);
    check("[data-ve='favorites']", opt.favorites);
    check("[data-ve='cards']", opt.cards);
    check("[data-ve='quizzes']", opt.quizzes);
  }

  function setMsg(dlg, text, isError) {
    var msg = dlg.querySelector("[data-ve-msg]");
    if (!msg) return;
    if (!text) {
      msg.hidden = true;
      msg.textContent = "";
      return;
    }
    msg.hidden = false;
    msg.className = "ve-msg" + (isError ? " is-err" : "");
    msg.textContent = text;
  }

  /* ---------------- 报数：先告诉用户会导出什么 ---------------- */
  function refreshStats(dlg) {
    var pid = currentProjectId();
    var box = dlg.querySelector("[data-ve-stats]");
    var btn = dlg.querySelector("[data-ve-download]");
    if (!box) return;
    if (!pid) {
      box.innerHTML = '<span class="ve-warn">还没有打开任何项目。</span>先在左侧选一门课或一个知识库，再回来导出。';
      if (btn) btn.disabled = true;
      return;
    }
    var token = (dlg._veToken = (dlg._veToken || 0) + 1);
    box.innerHTML = "正在统计…";
    if (btn) btn.disabled = true;

    api("/api/projects/" + encodeURIComponent(pid) + "/obsidian/preview?" + buildQuery(collectOptions(dlg)))
      .then(function (data) {
        if (dlg._veToken !== token || !dlg.open) return;
        var s = data.stats || {};
        var parts = [];
        parts.push("将导出 <b>" + s.nodes_exported + "</b> 个知识点（共 " + s.nodes_total + " 个）");
        parts.push("生成 <b>" + s.files + "</b> 篇 Markdown");
        if (s.folders) parts.push(s.folders + " 个文件夹");
        var html = parts.join(" · ");
        html += "<br>双链 <b>" + s.links + "</b> 条";
        if (s.link_notes) {
          html += "，含双链理解 <b>" + s.link_notes + "</b> 条";
        }
        if (s.dangling_links) {
          html += '，其中 <span class="ve-warn">' + s.dangling_links + " 条指向还没建的知识点</span>" +
            '<br><span class="ve-mute">这不是丢链接：Obsidian 里会显示成「未创建」，点一下就能补建。' +
            ((s.dangling_names || []).length ? "例如：" + esc(s.dangling_names.slice(0, 3).join("、")) : "") + "</span>";
        }
        if (s.favorites) {
          html += '<br>含「我的笔记」收藏片段 <b>' + s.favorites + "</b> 条";
        } else if (s.scope === "noted") {
          html += '<br><span class="ve-mute">当前只导有笔记的知识点，双链目标大多不在包里 —— 想看完整图谱请选「全部知识点」。</span>';
        }
        if (s.cards) {
          html += '<br>含知识卡片 <b>' + s.cards + "</b> 张";
        }
        if (s.quizzes) {
          html += '<br>含小测验 <b>' + s.quizzes + "</b> 道";
        }
        if (s.note_chars) html += '<br><span class="ve-mute">笔记正文合计约 ' + s.note_chars + " 字</span>";
        if (data.sample_paths && data.sample_paths.length) {
          html += '<ul class="ve-sample">' + data.sample_paths.slice(0, 3).map(function (p) {
            return "<li>" + esc(p) + "</li>";
          }).join("") + "</ul>";
        }
        box.innerHTML = html;
        if (btn) btn.disabled = false;
        if (dlg._veFolderDefault !== data.root) {
          dlg._veFolderDefault = data.root;
          var input = dlg.querySelector("[data-ve='folder']");
          if (input && !input.value.trim()) input.placeholder = "默认：" + data.root;
        }
      })
      .catch(function (err) {
        if (dlg._veToken !== token) return;
        box.innerHTML = '<span class="ve-warn">统计失败：' + esc(err && err.message ? err.message : "未知错误") + "</span>";
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
    var pid = currentProjectId();
    if (!pid) return;
    var btn = dlg.querySelector("[data-ve-download]");
    var opt = collectOptions(dlg);
    if (btn) {
      btn.disabled = true;
      btn.dataset.veLabel = btn.textContent;
      btn.textContent = "正在打包…";
    }
    setMsg(dlg, "");

    fetch("/api/projects/" + encodeURIComponent(pid) + "/obsidian/export?" + buildQuery(opt), {
      credentials: "same-origin",
    })
      .then(function (res) {
        if (!res.ok) {
          if (res.status === 401) {
            try { showAuthView(); } catch (e) { /* 忽略 */ }
            throw new Error("登录状态已过期，请重新登录后再导出。");
          }
          throw new Error("导出失败（HTTP " + res.status + "）");
        }
        var name = filenameFromHeader(res, (opt.folder || "知识库") + ".zip");
        var count = res.headers.get("X-Vault-Files");
        return res.blob().then(function (blob) {
          return { blob: blob, name: name, count: count, bytes: blob.size };
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
        setMsg(
          dlg,
          "已导出 " + out.name + "（" + (out.count ? out.count + " 篇 Markdown，" : "") + mb + " MB）。" +
            "解压后把里面的文件夹拖进 Obsidian 的库目录即可。",
          false
        );
      })
      .catch(function (err) {
        setMsg(dlg, err && err.message ? err.message : "导出失败，请稍后重试。", true);
      })
      .finally(function () {
        if (btn) {
          btn.disabled = false;
          btn.textContent = btn.dataset.veLabel || "下载 .zip";
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
    var opt = loadOptions();
    applyOptions(dlg, opt);
    setMsg(dlg, "");
    try { dlg.showModal(); } catch (e) { dlg.setAttribute("open", ""); }
    refreshStats(dlg);
  }

  /* ---------------- 入口 ---------------- */
  function injectEntry() {
    var host = document.querySelector(".studio-heading-actions");
    if (!host || host.querySelector("[data-ve-entry]")) return;
    // 入口按钮的紧凑样式（inline-flex / 省略号）也在这个 style 块里，
    // 而 ensureStyle 原先只在 openDialog 里调用 —— 不在这里补一次，
    // 用户没点开过弹窗之前，入口按钮拿不到自己的样式。
    ensureStyle();
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mini-button vault-export-entry";
    btn.setAttribute("data-ve-entry", "");
    btn.title = "把知识库导出成 Obsidian 能直接打开的 Markdown 库（标准 Markdown + [[双链]]）";
    // 头部空间紧张，不再挂图标：文字本身就是唯一的视觉锚点（title 里有完整说明）
    // 文案用「导出知识库」而不是「导出 Obsidian」：对用户说的是产出物（知识库），
    // 具体格式在弹窗里说明，头部按钮不必扛格式名。
    btn.innerHTML = '<span class="vault-export-entry-label">导出知识库</span>';
    btn.addEventListener("click", function (event) {
      event.preventDefault();
      openDialog();
    });
    host.insertBefore(btn, host.firstChild);
  }

  // 旧入口兼容：kb 面板里的「导出」按钮绑的是 app.js 里的静默下载。
  // 捕获阶段先接管，stopPropagation 之后 app.js 那个直连 handler 不会再跑。
  document.addEventListener(
    "click",
    function (event) {
      var legacy = event.target && event.target.closest && event.target.closest("[data-kb-action='export']");
      if (!legacy) return;
      event.preventDefault();
      event.stopPropagation();
      openDialog();
    },
    true
  );

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectEntry);
  } else {
    injectEntry();
  }
  // 学习产出面板的头部按钮是静态 DOM，注入一次即可；这里再兜一次防止脚本加载晚于渲染
  window.addEventListener("load", injectEntry);

  window.KnowOriginVaultExport = { open: openDialog, close: closeDialog, inject: injectEntry };
})();
