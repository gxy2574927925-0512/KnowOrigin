/* ==================== 文献结论 → 独立「对比阅读项目」 ====================
   背景（为什么需要这个文件）：
   文献项目与课程项目在库里是两套东西（projects.project_type 分流），而
   node.source_ids 只可能指向同一个 project 内的 source。所以「多文献对比」
   在课程来源视图里本来就没有落点 —— 旧按钮「在来源视图中查看」只能跳回一个
   与对比无关的视图，看着像"回去了"，其实什么都没关联上。

   现在只剩一条出路，写在按钮上、由本文件接管：
   「建对比项目并打开来源视图」——把这次对比独立成一个项目（对比报告 + 各文献全文），
   生成知识框架，然后在阅读界面**就地**展开它的来源视图。按「文献指纹」幂等，
   同一组文献只会有一个项目（与「不带报告的组合项目」共用同一把指纹）。

   不再退出文献模式：来源视图已从主界面图谱区搬进阅读界面的「对比视图」，
   跳回去反而要走回头路（旧版正是如此，刚读完对比就被弹到另一个界面）。

   2026-09-12 按用户要求删掉底部那行「并入知识网」，attach-to-course 这条支路连同
   它的端点调用一并清理；本文件不再涉及「把结论并进课程」。
   服务端 /api/projects/{id}/sources/attach-literature 保留不动
   （tools/_e2e_attach_literature.py 直接测它，不依赖界面）。

   为什么建项要点一下才做，而不是打开对比就自动做：
   建项要跑一次模型，金额与耗时都不小；而且刚读完对比报告就被弹走到另一个项目，
   体验上是"抢焦点"。所以默认只给出按钮与说明，点了才动手。

   边界：document 级事件委托 + 只调一个端点；不改既有端点签名、不碰 P0 禁改清单。
   ============================================================= */

(function () {
  var BUILD_ACTION = "build-compare-project";
  var OPEN_ACTION = "open-compare-project";

  var esc = (typeof window.escapeHtml === "function")
    ? window.escapeHtml
    : function (s) {
        return String(s == null ? "" : s)
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
      };

  var building = false;
  var lastProjectId = "";

  function dialogEls() {
    var dialog = document.getElementById("lit-compare-dialog");
    if (!dialog) return null;
    var body = document.getElementById("lit-compare-body");
    if (!body) return null;
    return { dialog: dialog, body: body };
  }

  function comparePayload() {
    var els = dialogEls();
    if (!els) return null;
    var report = String(els.body.__knoworiginCompareReport || "");
    if (!report.trim()) return null;
    var dialog = els.dialog;
    return {
      report: report,
      ids: Array.isArray(dialog.__knoworiginCompareIds) ? dialog.__knoworiginCompareIds : [],
      titles: Array.isArray(dialog.__knoworiginCompareTitles)
        ? dialog.__knoworiginCompareTitles
        : [],
    };
  }

  function toast(message) {
    if (typeof showToast === "function") { showToast(message); return; }
    // showToast 不可用时不要静默失败，至少让用户看到结果
    if (window.console) console.log("[知源]", message);
  }

  /* ---------- 对比项目块的插入与更新 ---------- */

  function projectBox() {
    var els = dialogEls();
    if (!els) return null;
    var box = els.body.querySelector(".lit-bridge-project");
    if (box) return box;
    box = document.createElement("div");
    box.className = "lit-bridge-project";
    // 追加在报告末尾：底部那行「并入知识网」删掉后，这里就是报告的收尾动作
    els.body.appendChild(box);
    return box;
  }

  function setProjectBox(html) {
    var box = projectBox();
    if (box) box.innerHTML = html;
  }

  function inviteMarkup(payload) {
    return '<p class="lit-bridge-head">把这次对比做成一个独立项目</p>'
      + '<p class="lit-bridge-line">会新建项目并导入 ' + payload.ids.length
      + " 篇文献 + 这份对比报告，然后生成知识框架、打开来源视图。</p>"
      + '<p class="lit-bridge-note">同一组文献只会建一个项目：再来对比是复用，不会越建越多。'
      + "</p>"
      + '<p class="lit-bridge-actions">'
      + '<button type="button" class="mini-button" data-lit-action="' + BUILD_ACTION + '">'
      + "建对比项目并打开来源视图</button>"
      + "</p>";
  }

  function readyMarkup(res) {
    var project = res.project || {};
    var papers = Array.isArray(res.imported_papers) ? res.imported_papers.length : 0;
    var nodes = Number(res.nodes_count || 0);
    var sources = Number(res.source_count || 0);
    var head = res.reused ? "已复用同一组文献的对比项目" : "已建立独立的对比项目";
    return '<p class="lit-bridge-head">' + head + "「" + esc(project.subject || "对比项目") + "」</p>"
      + '<p class="lit-bridge-line">共 ' + sources + " 份资料（" + papers + " 篇文献 + 对比报告）"
      + (nodes ? "，生成 " + nodes + " 个知识概念" : "，暂未生成知识概念") + "</p>"
      + '<p class="lit-bridge-actions">'
      + '<button type="button" class="mini-button" data-lit-action="' + OPEN_ACTION + '">'
      + "打开来源视图</button>"
      + "</p>"
      + (res.note ? '<p class="lit-bridge-note">' + esc(res.note) + "</p>" : "");
  }

  function errorMarkup(message) {
    return '<p class="lit-bridge-head">对比项目没能建好</p>'
      + '<p class="lit-bridge-line is-warn">' + esc(String(message)) + "</p>"
      + '<p class="lit-bridge-note">对比报告不受影响，仍可正常阅读，稍后可直接重试。</p>'
      + '<p class="lit-bridge-actions">'
      + '<button type="button" class="mini-button" data-lit-action="' + BUILD_ACTION + '">重试</button>'
      + "</p>";
  }

  /* 报告渲染完只摆按钮，不自动动手 —— 建项要跑模型，花的是用户的钱和时间。 */
  function renderInvite() {
    var payload = comparePayload();
    if (!payload || !payload.ids.length) return;
    setProjectBox(inviteMarkup(payload));
  }

  /* ---------- 建项并落位 ---------- */

  async function buildCompareProject() {
    if (building) return;
    var payload = comparePayload();
    if (!payload || !payload.ids.length) {
      toast("没有取到参与对比的文献，请先选文献做一次对比");
      return;
    }
    building = true;
    setProjectBox(
      '<p class="lit-bridge-line"><span class="btn-spinner lit-bridge-spin" aria-hidden="true"></span>'
      + "正在建立对比项目：导入 " + payload.ids.length
      + " 篇文献 + 对比报告，并生成知识框架…（可能要几十秒）</p>"
    );
    try {
      var res = await window.api("/api/literature/compare/project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          literature_project_ids: payload.ids,
          report: payload.report,
        }),
      });
      lastProjectId = (res.project && res.project.project_id) || "";
      // 这一步会在后端新建一个项目：通知主界面刷新顶部项目下拉（见 app.js
      // syncProjectListSilently）。复用已有对比项目时也会通知一次，那边会自己比对差异。
      var litMod = window.KnowOriginLiterature;
      if (litMod && typeof litMod.notifyProjectsChanged === "function") {
        litMod.notifyProjectsChanged();
      }
      var els = dialogEls();
      if (!els || !els.dialog.open) return; // 用户自己关了弹窗：静默完成
      setProjectBox(readyMarkup(res));
      var parts = ["已建好对比项目"];
      if (res.nodes_count) parts.push("生成 " + res.nodes_count + " 个知识概念");
      parts.push("点「打开来源视图」查看");
      toast(parts.join(" · "));
    } catch (error) {
      setProjectBox(errorMarkup((error && error.message) || error));
    } finally {
      building = false;
    }
  }

  async function openCompareProject(projectId) {
    var pid = projectId || lastProjectId;
    if (!pid) return;
    var els = dialogEls();
    if (els) { try { els.dialog.close(); } catch (_) { /* 忽略 */ } }
    // 就地展开：留在文章阅读界面，把这组文献的来源视图放进「对比视图」并打开它。
    // 不退出文献模式、也不切回主界面 —— 以前那一下跳转，等于刚读完对比就被弹走。
    var payload = comparePayload();
    var view = window.KnowOriginLitCompareView;
    if (view && typeof view.openProject === "function") {
      view.openProject(pid, payload ? payload.ids : [], payload ? payload.titles : []);
      toast("已在这组文献的对比视图里打开来源视图");
      return;
    }
    toast("对比视图还没就绪，点左栏「我的文献」里的「对比视图」即可查看");
  }

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (target.closest('[data-lit-action="' + BUILD_ACTION + '"]')) {
      event.preventDefault();
      buildCompareProject();
      return;
    }
    if (target.closest('[data-lit-action="' + OPEN_ACTION + '"]')) {
      event.preventDefault();
      openCompareProject();
    }
  });

  window.KnowOriginLitBridge = {
    /* literature.js 在对比报告渲染完正文后调用：只摆出「建对比项目」入口，不自动动手 */
    afterCompare: function () {
      try { renderInvite(); } catch (_) { /* 入口渲染失败不影响阅读报告 */ }
    },
    buildProject: buildCompareProject,
    openProject: openCompareProject,
  };
})();
