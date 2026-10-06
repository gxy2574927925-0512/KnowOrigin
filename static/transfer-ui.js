/**
 * 知源 · 迁移面板（换个情境试试 / 迁移分 / 跨项目概念图 / 迁移题历史）
 *
 * ## 这个面板存在的理由
 *
 * 项目此前的学情只有一个数字（掌握度）和一个位置（四档位阶：未开始/见过/会了/稳了）。
 * 那个位置回答的是「记住了没有」，**不回答「换个情境还用不用得上」**。
 * 而检索练习对技能泛化几乎无效、KLI 框架那套研究明确指出：泛化需要
 * 学习者自己归纳出「哪些特征是相关的」，也就是必须**被出换情境的题**逼一次。
 *
 * 所以这里只做四件事，不做第五件：
 *   1. 把「迁移」做成一个**独立于掌握度的可见维度**（三档：迁移未验证 / 迁移待验证 / 迁移得动）；
 *   2. 给一个「换个情境试试」的入口，出的题强制带 source→target 的逐项对齐表；
 *   3. 把跨项目同一个概念的掌握度/迁移分并排摆出来（跨课程迁移的落点）；
 *   4. 出过的每一道都留痕、可重新打开（历史）。
 *
 * 刻意**不做**的事：
 *   - 不在面板上显示掌握度的百分比。BKT 与衰减都藏在后端，这里只出现档位词与位置。
 *   - 不把迁移分混进掌握度。两个数混成一个，就等于告诉用户刷识记题能学会迁移。
 *   - 不做「一键全部完成」类的批量按钮。迁移的价值来自**一道一道做**，
 *     批量勾选会把迁移分变成可刷分项 —— 那正好是本次改动要修的漏洞。
 *
 * ## 排版与配色约定
 *
 * 1. 字号一律走 styles.css 的 `--text-*` 阶梯，**不写死 px** ——
 *    这样设置里的「字体大小」（--font-scale）才作用得到本面板。
 *    最小用到 `--text-sm`，正文一律 `--text-base` 起：迁移题要读的是
 *    一张对齐表与两条情境，12px 以下读不动，也就没有意义。
 * 2. 自带一套**迁移专属色板**（--tf-s0/s1/s2）而不是只吃全局中性灰：
 *    三档迁移需要三个语义色才分得开。全局色板里只有一个绿，
 *    结果三档只能靠字重区分，看起来就是一片灰绿。
 *    刻意**不给「未验证」上重色** —— 上色在语义上等于「做成了」，
 *    而未验证恰恰是「还没验过」，不该看起来像成果。
 * 3. 小字说明默认收进原生 `<details>`：键盘可达、屏幕阅读器认得、
 *    不必自己维护展开状态，也不需要往 localStorage 里塞 UI 偏好。
 *
 * ## 弹窗布局
 *
 * **铺满全屏 + 左右双栏**：左栏读题（题干 / 源例 / 新情境 / 对齐表），
 * 右栏写答案（采分点 / 输入 / 自评 / 提交），两栏各自滚动。
 * 这么分的理由很实际：写答案时要一直看得见采分点，而很长的对齐表在左栏滚动
 * 不会把右栏顶走 —— 单栏整页滚动时，「提交」按钮和采分点必然有一个滚出视野。
 * 正文列限宽 74ch：全屏了也不能让一行拉到 1400px，那样读起来是灾难。
 *
 * ## 「关掉不重新开始」
 *
 * 真值在库里，不在页面内存里。生成请求发出前先把 pointer 写进 localStorage，
 * 出题成功后 pointer 变成 attempt_id；重开时向服务端把那一道原样取回来，
 * 刷新浏览器也一样。只有「用户明确点了换一道」才会重新发起。
 *
 * ## 落点与回退
 *
 * 状态/统计融进「学习概览」，往 `.studio-output .overview-dashboard` 追加一张
 * `.overview-panel` 卡片；测验页在题目前插一条「本轮跨了 N 个知识点」的说明条。
 * 不改 app.js / styles.css；删掉 index.html 里那一行 script 即整体回退。
 */
(function () {
  "use strict";

  var STYLE_ID = "ko-tf-style";
  var PANEL_CLASS = "ko-tf-panel";
  var MODAL_ID = "ko-tf-modal";
  var STREAK_CLASS = "ko-tf-streak";

  var STAGE_KEYS = ["untested", "partial", "solid"];
  var STAGE_TONE = { untested: "", partial: " is-partial", solid: " is-solid" };
  var SELF_RATINGS = [
    { value: 0, label: "完全不会" },
    { value: 1, label: "想错了" },
    { value: 2, label: "模糊" },
    { value: 3, label: "会了" },
    { value: 4, label: "很熟" },
  ];

  // 注意：变量名不能叫 state —— 那是 app.js 顶层的 const，IIFE 里会遮蔽它。
  // lastCard / lastMarkup 是渲染幂等的依据，见 writeCard() 的注释。
  var view = { projectId: null, data: null, loading: false, error: "", lastCard: null, lastMarkup: "" };
  var queue = { data: null, loading: false };
  var task = {
    data: null,
    loading: false,
    error: "",
    result: null,
    answeredInfo: null,
    answer: "",
    rating: null,
    distance: "",
    nodeId: "",
    pointer: null,
    poller: 0,
  };

  // 打开弹窗时的来处：关掉时回到这里，而不是掉回主界面。
  var openedFrom = null;

  // ── 基础设施 ────────────────────────────────────────────

  function escapeText(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function currentProjectId() {
    if (typeof state === "undefined" || !state) return "";
    return state.currentProjectId || "";
  }

  function isAuthenticated() {
    if (typeof state === "undefined" || !state) return false;
    return Boolean(state.authenticated);
  }

  function call(path) {
    if (typeof api !== "function") return Promise.reject(new Error("接口封装未就绪"));
    return api(path);
  }

  // ── pointer 持久化 ──────────────────────────────────────
  function pointerKey(pid) {
    return "ko-tf:pointer:" + (pid || currentProjectId() || "-");
  }

  function readPointer(pid) {
    try {
      var raw = window.localStorage.getItem(pointerKey(pid));
      var parsed = raw ? JSON.parse(raw) : null;
      return parsed && parsed.nodeId ? parsed : null;
    } catch (err) {
      return null;
    }
  }

  function writePointer(patch) {
    var pid = currentProjectId();
    var next = Object.assign({}, task.pointer || {}, patch || {});
    if (!next.nodeId) {
      task.pointer = null;
      try {
        window.localStorage.removeItem(pointerKey(pid));
      } catch (err) {
        /* localStorage 不可用时退化为纯内存，功能不受影响 */
      }
      return;
    }
    task.pointer = next;
    try {
      window.localStorage.setItem(pointerKey(pid), JSON.stringify(next));
    } catch (err) {
      /* 同上 */
    }
  }

  function clearPolling() {
    if (task.poller) {
      window.clearTimeout(task.poller);
      task.poller = 0;
    }
  }

  // 出题在途时轮询服务端。上限 60 次 × 2.5s ≈ 2.5 分钟：
  // 超过两分半基本是模型卡住了，那时如实说「还在后台跑」，而不是无限转圈。
  var POLL_MAX = 60;
  function pollForTask(pid, nodeId, tries) {
    clearPolling();
    var attempt = (tries || 0) + 1;
    task.poller = window.setTimeout(function () {
      call(
        "/api/transfer/" +
          encodeURIComponent(pid) +
          "/attempts?limit=20&node_id=" +
          encodeURIComponent(nodeId)
      )
        .then(function (data) {
          var open = ((data && data.items) || []).filter(function (item) {
            // 只认「这个节点、还没作答」的那一道 —— 已作答的历史不能拿来顶替，
            // 否则会把上一道已交出去的题重新塞回给用户。
            return item.node_id === nodeId && !item.answered;
          });
          if (open.length) {
            resumeAttempt(open[0].attempt_id);
            return;
          }
          if (attempt < POLL_MAX) pollForTask(pid, nodeId, attempt);
          else {
            task.loading = false;
            task.error =
              "这道题在后台还没出好（等了约两分半）。生成是后台进行的，" +
              "你可以先去做别的，过一会儿再点开看。";
            writePointer({ status: "" });
            renderModal();
          }
        })
        .catch(function () {
          if (attempt < POLL_MAX) pollForTask(pid, nodeId, attempt);
        });
    }, 2500);
  }

  function resumeAttempt(attemptId) {
    var pid = currentProjectId();
    call(
      "/api/transfer/" +
        encodeURIComponent(pid) +
        "/attempts/" +
        encodeURIComponent(attemptId)
    )
      .then(function (data) {
        clearPolling();
        task.loading = false;
        task.error = "";
        task.result = null;
        task.answeredInfo = data.answered ? data : null;
        task.rating = null;
        task.answer = "";
        task.nodeId = data.node_id || task.nodeId;
        task.data = {
          attempt_id: data.attempt_id,
          node_id: data.node_id,
          node_name: data.node_name,
          distance: data.distance,
          distance_label: data.distance_label,
          distance_reason: "（从历史里重新打开的这一道）",
          task: data.task,
          resumed: true,
          answered: !!data.answered,
          seq: data.seq,
          total: data.total,
        };
        writePointer({
          nodeId: data.node_id,
          attemptId: data.attempt_id,
          status: "ready",
          distance: data.distance,
        });
        renderModal();
      })
      .catch(function () {
        clearPolling();
        task.loading = false;
        task.error = "这道题取不回来了（可能已被清理）。点「换一道」重新出一道。";
        writePointer({ status: "", attemptId: "" });
        renderModal();
      });
  }

  // ── 样式 ──────────────────────────────────────────────

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = [
      "/* ══ 迁移专属色板（跟随主题） ══ */",
      "#studio-output ." + PANEL_CLASS + " { --tf-s0: #8c8578; --tf-s1: #a97c2c; --tf-s2: #3f7a4f; }",
      "html[data-theme='dark'] #studio-output ." + PANEL_CLASS + " { --tf-s0: #8b93a1; --tf-s1: #d0a24a; --tf-s2: #7fbf8c; }",
      ".ko-tf-modal-card { --tf-s0: #8c8578; --tf-s1: #a97c2c; --tf-s2: #3f7a4f; }",
      "html[data-theme='dark'] .ko-tf-modal-card { --tf-s0: #8b93a1; --tf-s1: #d0a24a; --tf-s2: #7fbf8c; }",
      "",
      "/* ══ 面板骨架 ══ */",
      "#studio-output ." + PANEL_CLASS + " { display: grid; gap: 12px; padding: 4px 2px 2px; }",
      ".ko-tf-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;",
      "  padding-bottom: 8px; border-bottom: 1px solid var(--line); }",
      ".ko-tf-head > strong { font-size: var(--text-lg, 16px); font-weight: 650; letter-spacing: .01em; }",
      ".ko-tf-head > span { font-size: var(--text-sm, 12px); color: var(--muted); line-height: 1.6; }",
      ".ko-tf-head .ko-tf-actions { margin-left: auto; display: flex; gap: 8px; }",
      ".ko-tf-head .mini-button { font-size: var(--text-sm, 12px); padding: 7px 13px; min-height: 34px; }",
      "",
      "/* ══ 小字折叠 ══ */",
      ".ko-tf-more { border: 1px solid var(--line); border-radius: 12px; background: var(--panel); overflow: hidden; }",
      ".ko-tf-more > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 8px;",
      "  padding: 9px 14px; font-size: var(--text-sm, 12px); color: var(--muted); }",
      ".ko-tf-more > summary::-webkit-details-marker { display: none; }",
      ".ko-tf-more > summary::after { content: ''; margin-left: auto; width: 7px; height: 7px;",
      "  border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor;",
      "  transform: rotate(45deg) translateY(-2px); transition: transform .18s ease; }",
      ".ko-tf-more[open] > summary::after { transform: rotate(-135deg) translateY(-2px); }",
      ".ko-tf-more > summary:hover { color: var(--ink); background: rgba(127, 140, 160, .06); }",
      ".ko-tf-more > summary:focus-visible { outline: 2px solid var(--green); outline-offset: -2px; }",
      ".ko-tf-more-body { padding: 1px 14px 13px; display: grid; gap: 8px; }",
      ".ko-tf-more-label { display: inline-flex; align-items: center; gap: 6px; }",
      ".ko-tf-more-label::before { content: ''; width: 5px; height: 5px; border-radius: 999px;",
      "  background: var(--tf-s0); opacity: .8; }",
      "",
      "/* ══ 三档卡片 ══ */",
      // 数字在上、档位词在下：这一栏要一眼看出的是「还剩几个没验」，
      // 原来三段解释句跟在数字下面，读的人先读到的是解释而不是数。
      ".ko-tf-stages { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }",
      ".ko-tf-stage { position: relative; display: grid; gap: 2px; padding: 12px 15px 11px;",
      "  border: 1px solid var(--line); border-radius: 13px; background: var(--panel);",
      "  color: var(--ink); overflow: hidden; }",
      ".ko-tf-stage::before { content: ''; position: absolute; inset: 0 auto 0 0; width: 3px;",
      "  background: var(--tf-c, var(--tf-s0)); opacity: .85; }",
      ".ko-tf-stage b { font-size: var(--text-2xl, 22px); font-weight: 660; line-height: 1.15;",
      "  font-variant-numeric: tabular-nums; letter-spacing: -.01em; color: var(--tf-c, var(--ink)); }",
      ".ko-tf-stage b i { font-style: normal; font-size: var(--text-sm, 12px); font-weight: 500;",
      "  color: var(--muted); margin-left: 5px; }",
      ".ko-tf-stage strong { font-size: var(--text-sm, 12px); font-weight: 620; line-height: 1.5;",
      "  color: var(--muted); }",
      ".ko-tf-stage.is-partial { --tf-c: var(--tf-s1); background: color-mix(in srgb, var(--tf-s1) 7%, var(--panel)); }",
      ".ko-tf-stage.is-solid { --tf-c: var(--tf-s2); background: color-mix(in srgb, var(--tf-s2) 9%, var(--panel));",
      "  border-color: color-mix(in srgb, var(--tf-s2) 38%, var(--line)); }",
      ".ko-tf-stage-hints { grid-column: 1 / -1; }",
      ".ko-tf-stage-hints .ko-tf-more { border-radius: 10px; }",
      "",
      "/* ══ 通用块 ══ */",
      ".ko-tf-block { display: grid; gap: 11px; padding: 15px 17px; border: 1px solid var(--line);",
      "  border-radius: 14px; background: var(--panel); color: var(--ink); }",
      ".ko-tf-why { margin: 0; font-size: var(--text-base, 13px); line-height: 1.8; color: var(--ink); }",
      ".ko-tf-why b { font-weight: 650; }",
      ".ko-tf-meta { margin: 0; font-size: var(--text-sm, 12px); line-height: 1.75; color: var(--muted); }",
      ".ko-tf-note { margin: 0; font-size: var(--text-sm, 12px); line-height: 1.8; color: var(--muted); }",
      ".ko-tf-target { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; padding: 14px 16px;",
      "  border: 1px solid var(--line); border-left: 3px solid var(--tf-s2); border-radius: 14px;",
      "  background: var(--panel); color: var(--ink); }",
      ".ko-tf-target-name { font-size: var(--text-md, 14px); font-weight: 650; flex: 0 1 auto; min-width: 0; }",
      ".ko-tf-badge { font-size: var(--text-sm, 12px); padding: 4px 10px; border-radius: 999px;",
      "  border: 1px solid var(--line); color: var(--muted); white-space: nowrap;",
      "  background: rgba(127, 140, 160, .06); }",
      "",
      "/* ══ 按钮 ══ */",
      ".ko-tf-acts { display: flex; gap: 10px; flex-wrap: wrap; }",
      ".ko-tf-acts .mini-button { font-size: var(--text-base, 13px); padding: 11px 20px;",
      "  min-height: 44px; border-radius: 12px; }",
      ".ko-tf-dists { display: flex; gap: 8px; flex-wrap: wrap; }",
      ".ko-tf-dist { font: inherit; font-size: var(--text-base, 13px); padding: 9px 14px; min-height: 40px;",
      "  display: inline-flex; align-items: center; gap: 2px; border-radius: 11px;",
      "  border: 1px solid var(--line); background: var(--panel); color: var(--ink);",
      "  cursor: pointer; transition: border-color .15s ease, background .15s ease, transform .1s ease; }",
      ".ko-tf-dist:hover { border-color: color-mix(in srgb, var(--tf-s2) 55%, var(--line));",
      "  background: color-mix(in srgb, var(--tf-s2) 7%, var(--panel)); }",
      ".ko-tf-dist:active { transform: translateY(1px); }",
      ".ko-tf-dist:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }",
      ".ko-tf-dist[aria-pressed='true'] { border-color: var(--tf-s2);",
      "  background: color-mix(in srgb, var(--tf-s2) 12%, var(--panel)); font-weight: 620; }",
      ".ko-tf-dist i { font-style: normal; color: var(--muted); margin-left: 7px;",
      "  font-size: var(--text-sm, 12px); font-variant-numeric: tabular-nums; }",
      "",
      "/* ══ 跨课程 ══ */",
      ".ko-tf-concepts { display: grid; gap: 10px; }",
      ".ko-tf-concept { display: grid; gap: 8px; padding: 13px 16px; border: 1px solid var(--line);",
      "  border-radius: 14px; background: var(--panel); color: var(--ink);",
      "  border-left: 3px solid color-mix(in srgb, var(--tf-s1) 70%, var(--line)); }",
      ".ko-tf-concept-name { font-size: var(--text-md, 14px); font-weight: 650; }",
      ".ko-tf-concept .mini-button { font-size: var(--text-sm, 12px); padding: 8px 14px; min-height: 36px; }",
      "",
      "/* ══ 后台生成提示 ══ */",
      ".ko-tf-bg { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 0;",
      "  padding: 14px 16px; border: 1px solid color-mix(in srgb, var(--tf-s1) 45%, var(--line));",
      "  border-radius: 14px; background: color-mix(in srgb, var(--tf-s1) 8%, var(--panel));",
      "  font-size: var(--text-base, 13px); line-height: 1.75; color: var(--ink); }",
      ".ko-tf-bg b { font-weight: 650; }",
      ".ko-tf-bg .mini-button { font-size: var(--text-sm, 12px); padding: 8px 13px; min-height: 34px;",
      "  margin-left: auto; }",
      ".ko-tf-dot { width: 9px; height: 9px; border-radius: 999px; flex: 0 0 auto;",
      "  background: var(--tf-s1); animation: ko-tf-pulse 1.4s ease-in-out infinite; }",
      "@keyframes ko-tf-pulse { 0%, 100% { opacity: .3; } 50% { opacity: 1; } }",
      "@media (prefers-reduced-motion: reduce) { .ko-tf-dot { animation: none; opacity: .9; } }",
      "",
      "/* ══ 历史 ══ */",
      ".ko-tf-hist { display: grid; gap: 7px; }",
      ".ko-tf-hist-row { font: inherit; width: 100%; text-align: left; cursor: pointer;",
      "  display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 11px; align-items: start;",
      "  padding: 11px 14px; border: 1px solid var(--line); border-radius: 12px;",
      "  background: var(--panel); color: var(--ink); transition: border-color .15s ease, background .15s ease; }",
      ".ko-tf-hist-row:hover { border-color: color-mix(in srgb, var(--tf-s2) 45%, var(--line));",
      "  background: color-mix(in srgb, var(--tf-s2) 5%, var(--panel)); }",
      ".ko-tf-hist-row:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }",
      ".ko-tf-hist-seq { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 9px;",
      "  font-size: var(--text-sm, 12px); font-weight: 650; font-variant-numeric: tabular-nums;",
      "  color: var(--muted); background: rgba(127, 140, 160, .12); }",
      ".ko-tf-hist-main { display: grid; gap: 6px; min-width: 0; }",
      ".ko-tf-hist-q { font-size: var(--text-base, 13px); line-height: 1.7; }",
      ".ko-tf-hist-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap;",
      "  font-size: var(--text-sm, 12px); color: var(--muted); }",
      ".ko-tf-hist-when { font-variant-numeric: tabular-nums; margin-left: auto; }",
      ".ko-tf-badge.is-ok { border-color: color-mix(in srgb, var(--tf-s2) 45%, var(--line));",
      "  color: var(--tf-s2); background: color-mix(in srgb, var(--tf-s2) 10%, transparent); }",
      ".ko-tf-badge.is-open { border-style: dashed; }",
      "",
      "/* ══ 测验页交错说明条 ══ */",
      "." + STREAK_CLASS + " { display: flex; align-items: center; gap: 9px; flex-wrap: wrap;",
      "  margin: 0 0 12px; padding: 12px 15px;",
      "  border: 1px dashed color-mix(in srgb, var(--tf-s2) 45%, var(--line));",
      "  border-radius: 12px; background: color-mix(in srgb, var(--tf-s2) 6%, transparent);",
      "  color: var(--ink); font-size: var(--text-base, 13px); line-height: 1.7; }",
      "." + STREAK_CLASS + " b { font-weight: 650; }",
      "",
      "/* ══════════════════════════════════════════════════════",
      "   弹窗：铺满全屏 + 左右双栏",
      "   左栏读题（题干 / 源例 / 新情境 / 对齐表），右栏写答案",
      "   （采分点 / 输入 / 自评 / 提交），两栏各自滚动。",
      "   ══════════════════════════════════════════════════════ */",
      "#" + MODAL_ID + " { position: fixed; inset: 0; z-index: 220; display: grid; padding: 0;",
      "  /* 铺满：原来只有一块 min(1120px, 96vw) 居中卡片，四周露出的底页把注意力带走 ——",
      "     这就是「不够沉浸」的原因。 */",
      "  background: var(--bg, #fff); }",
      "#" + MODAL_ID + "[hidden] { display: none; }",
      ".ko-tf-modal-card { width: 100%; height: 100dvh; display: grid; grid-template-rows: auto minmax(0, 1fr);",
      "  border: 0; border-radius: 0; overflow: hidden; background: var(--bg, #fff); color: var(--ink); }",
      ".ko-tf-modal-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;",
      "  padding: 15px clamp(18px, 3vw, 40px); border-bottom: 1px solid var(--line);",
      "  background: var(--panel); }",
      ".ko-tf-modal-head h3 { margin: 0; font-size: var(--text-xl, 18px); font-weight: 660; letter-spacing: .01em; }",
      ".ko-tf-modal-head .ko-tf-spacer { flex: 1 1 auto; }",
      ".ko-tf-modal-head .mini-button { font-size: var(--text-base, 13px); padding: 9px 18px;",
      "  min-height: 40px; border-radius: 11px; }",
      "",
      // grid-template-rows 那一条是「能不能上下滚」的全部关键：
      // 只写 grid-template-columns 时，两栏落进一条 **auto 隐式行**，那条行会被
      // 左栏的长对齐表撑到视口之外；卡片自己是 overflow:hidden，于是底部被裁掉，
      // 滚轮滚的又是那条已经超出屏幕的行 —— 表现为「怎么滚都看不全」。
      // 显式 minmax(0, 1fr) 把行钉在可用高度上，两栏的 overflow:auto 才是真的滚动容器。
      ".ko-tf-cols { display: grid; min-height: 0;",
      "  grid-template-columns: minmax(0, 1.15fr) minmax(340px, .85fr);",
      "  grid-template-rows: minmax(0, 1fr); gap: 0; }",
      ".ko-tf-col { min-height: 0; overflow: auto; overscroll-behavior: contain;",
      "  padding: clamp(18px, 2.4vw, 30px); display: grid; gap: 18px; align-content: start; }",
      ".ko-tf-col-read { border-right: 1px solid var(--line); }",
      ".ko-tf-col-read > * { max-width: 74ch; }",
      // 对齐表是左栏真正要读的东西，不该被 74ch 的行宽夹住 —— 夹住就变成三列
      // 每列挤成两三行的窄条，比没有行宽限制更难读。
      ".ko-tf-col-read > .ko-tf-align-wrap { max-width: none; }",
      ".ko-tf-col-write { background: var(--panel); align-self: stretch; }",
      "",
      ".ko-tf-section-title { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;",
      "  margin: 0; font-size: var(--text-md, 14px); font-weight: 650; }",
      ".ko-tf-section-title span { font-size: var(--text-sm, 12px); font-weight: 400;",
      "  color: var(--muted); line-height: 1.6; }",
      "",
      ".ko-tf-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }",
      ".ko-tf-side { display: grid; gap: 8px; padding: 15px 16px; border: 1px solid var(--line);",
      "  border-radius: 13px; background: var(--panel); border-top: 2px solid var(--tf-s0); }",
      ".ko-tf-side > b { font-size: var(--text-sm, 12px); font-weight: 640; color: var(--muted);",
      "  letter-spacing: .04em; }",
      ".ko-tf-side p { margin: 0; font-size: var(--text-base, 13px); line-height: 1.85; color: var(--ink); }",
      ".ko-tf-side.is-target { border-top-color: var(--tf-s2);",
      "  background: color-mix(in srgb, var(--tf-s2) 6%, var(--panel)); }",
      "",
      // 表格**不做滚动容器**：滚动交给左栏。
      // ① 原来写 overflow:auto，表格被压成两三百像素高的窄窗，鼠标停在表内滚的是表、
      //    不是栏 —— 看着就是「挤在里面」，红框那一块。
      // ② 改成 overflow-x:auto 也不行：只要一个方向不是 visible，另一个方向就会
      //    从 visible 计算成 auto，于是它又成了双向滚动容器、又被压扁。
      //    要横滚就让左栏滚（左右都在 overflow:auto 里）。
      ".ko-tf-align-wrap { border: 1px solid var(--line); border-radius: 13px;",
      "  background: var(--panel); }",
      ".ko-tf-align { width: 100%; border-collapse: collapse; font-size: var(--text-base, 13px); }",
      // 表头是 sticky 的，所以它的背景**必须不透明**：吸住之后行会从它底下穿过去，
      // 半透明底（原来的 rgba(..., .08)）会让下面的字透上来，与表头自己的列名叠在一
      // 起 —— 滚动到表格中段就是一团重影，连表头说的是哪一列都读不出来。
      // color-mix 拿 var(--panel) 当不透明底，所以深色主题自动跟上。
      ".ko-tf-align th { padding: 11px 14px; font-size: var(--text-sm, 12px); font-weight: 620;",
      "  color: var(--muted); text-align: left; white-space: nowrap;",
      "  background: color-mix(in srgb, #7f8ca0 10%, var(--panel));",
      "  position: sticky; top: 0; z-index: 1; box-shadow: 0 1px 0 var(--line); }",
      ".ko-tf-align td { padding: 13px 14px; border-top: 1px solid var(--line); vertical-align: top;",
      "  line-height: 1.8; }",
      ".ko-tf-align td:first-child, .ko-tf-align td:nth-child(2) { width: 30%; }",
      ".ko-tf-align tbody tr:hover { background: rgba(127, 140, 160, .05); }",
      ".ko-tf-align .ko-tf-idx { color: var(--muted); font-variant-numeric: tabular-nums; margin-right: 4px; }",
      "",
      ".ko-tf-points { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px; }",
      ".ko-tf-points li { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 10px;",
      "  align-items: start; font-size: var(--text-base, 13px); line-height: 1.8;",
      "  padding: 10px 12px; border: 1px solid var(--line); border-radius: 11px; background: var(--bg, #fff); }",
      ".ko-tf-points li i { font-style: normal; display: grid; place-items: center; width: 22px; height: 22px;",
      "  margin-top: 1px; border-radius: 7px; background: color-mix(in srgb, var(--tf-s1) 16%, transparent);",
      "  color: var(--tf-s1); font-size: var(--text-2xs, 10px); font-weight: 650;",
      "  font-variant-numeric: tabular-nums; }",
      "",
      ".ko-tf-answer { width: 100%; min-height: 190px; padding: 14px 16px; font: inherit;",
      "  font-size: var(--text-base, 13px); line-height: 1.85; border: 1px solid var(--line);",
      "  border-radius: 13px; background: var(--bg, #fff); color: var(--ink); resize: vertical; }",
      ".ko-tf-answer:focus-visible { outline: 2px solid var(--tf-s2); outline-offset: 1px; }",
      ".ko-tf-ratings { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6px; }",
      ".ko-tf-rating { font: inherit; font-size: var(--text-sm, 12px); padding: 11px 6px; min-height: 44px;",
      "  border-radius: 11px; border: 1px solid var(--line); background: var(--bg, #fff);",
      "  color: var(--ink); cursor: pointer; }",
      ".ko-tf-rating:hover { border-color: color-mix(in srgb, var(--tf-s2) 55%, var(--line)); }",
      ".ko-tf-rating[aria-pressed='true'] { border-color: var(--tf-s2); color: var(--tf-s2); font-weight: 640;",
      "  background: color-mix(in srgb, var(--tf-s2) 12%, var(--bg, #fff)); }",
      ".ko-tf-rating:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }",
      "",
      ".ko-tf-submit { font-size: var(--text-base, 13px); padding: 13px 22px; min-height: 48px;",
      "  width: 100%; border-radius: 12px; }",
      ".ko-tf-error { margin: 0; padding: 13px 16px; border-radius: 12px;",
      "  border: 1px solid color-mix(in srgb, #d4705f 40%, var(--line));",
      "  background: color-mix(in srgb, #d4705f 9%, transparent);",
      "  font-size: var(--text-base, 13px); line-height: 1.8; color: #a4503f; }",
      "html[data-theme='dark'] .ko-tf-error { color: #e59a8a; }",
      ".ko-tf-done { display: grid; gap: 13px; padding: 20px 22px; border: 1px solid var(--line);",
      "  border-left: 3px solid var(--tf-s2); border-radius: 14px;",
      "  background: color-mix(in srgb, var(--tf-s2) 6%, var(--panel)); }",
      ".ko-tf-done h4 { margin: 0; font-size: var(--text-lg, 16px); font-weight: 660; color: var(--tf-s2); }",
      ".ko-tf-done p { margin: 0; font-size: var(--text-base, 13px); line-height: 1.85; }",
      ".ko-tf-done .ko-tf-scores { display: flex; gap: 8px; flex-wrap: wrap; }",
      ".ko-tf-done .ko-tf-badge { font-size: var(--text-base, 13px); padding: 6px 13px; }",
      "",
      "@media (max-width: 1080px) {",
      "  /* 窄屏改成上下堆叠、由**容器**整栏一起滚：两栏各自滚动在触屏上等于",
      "     只能滚到其中一块，另一块怎么划都不动。 */",
      "  .ko-tf-cols { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto;",
      "    overflow: auto; }",
      "  .ko-tf-col { overflow: visible; }",
      "  .ko-tf-col-read { border-right: 0; border-bottom: 1px solid var(--line); }",
      "}",
      "@media (max-width: 760px) {",
      "  .ko-tf-pair { grid-template-columns: minmax(0, 1fr); }",
      "  .ko-tf-stages { grid-template-columns: minmax(0, 1fr); }",
      "  .ko-tf-ratings { grid-template-columns: repeat(3, minmax(0, 1fr)); }",
      "  .ko-tf-align td:first-child, .ko-tf-align td:nth-child(2) { width: auto; }",
      "  .ko-tf-align thead { display: none; }",
      "  .ko-tf-align tbody tr { display: block; padding: 11px 0; border-top: 1px solid var(--line); }",
      "  .ko-tf-align tbody tr:first-child { border-top: 0; }",
      "  .ko-tf-align td { display: block; padding: 6px 13px; border-top: 0; }",
      "  .ko-tf-hist-when { margin-left: 0; }",
      "}",
    ].join("\n");
    document.head.appendChild(el);
  }

  // ── 小字折叠 ──────────────────────────────────────────

  // 一块可折叠的说明。用原生 details：键盘可达、屏幕阅读器认得、无需自管状态。
  function more(label, inner) {
    if (!inner) return "";
    return (
      '<details class="ko-tf-more"><summary><span class="ko-tf-more-label">' +
      escapeText(label) +
      "</span></summary>" +
      '<div class="ko-tf-more-body">' +
      inner +
      "</div></details>"
    );
  }

  function note(text) {
    return '<p class="ko-tf-note">' + text + "</p>";
  }

  function _shortTime(stamp) {
    var text = String(stamp || "");
    var m = text.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    return m ? m[1].slice(5) + " " + m[2] : text.slice(0, 16);
  }

  // ── 面板渲染 ────────────────────────────────────────────

  function stageCells(data) {
    var counts = (data && data.transfer_summary && data.transfer_summary.counts) || {};
    var labels = {
      untested: "还没验过迁移",
      partial: "验了一半",
      solid: "迁移得动",
    };
    // 定义与「下一步做什么」都收进折叠里，卡片上只留数字与档位词。
    // 原来每张卡下面都挂一句解释，三张卡就三行字，视线先被解释吃掉。
    var defs = {
      untested:
        "从来没做过迁移题。刷识记题、翻卡片都不会让这个数下降 —— " +
        "它只能靠「换个情境」的题推动。",
      partial:
        "做过迁移题，但还不到两到三道、或距离都太近。" +
        "系统刻意不让一道题就点亮这一档：一次侥幸不算迁移。再来一道不同距离的才算数。",
      solid:
        "连续在<b>不同距离</b>（换条件 / 换表征 / 换领域）上做对。" +
        "下一步是换更远的距离再验一遍，而不是继续做同一种。",
    };
    var cards = STAGE_KEYS.map(function (key) {
      var n = Number(counts[key] || 0);
      return (
        '<div class="ko-tf-stage' + STAGE_TONE[key] + '">' +
        // 数字在前：先看到「还剩几个没验」，档位词退成第二行的注解。
        "<b>" + escapeText(n) + "<i>个知识点</i></b>" +
        "<strong>" + escapeText(labels[key]) + "</strong>" +
        "</div>"
      );
    });
    // 三句话合成一个说明块，不占三份版面
    cards.push(
      '<div class="ko-tf-stage-hints">' +
        more(
          "这三档分别在数什么",
          STAGE_KEYS.map(function (key) {
            return note("· <b>" + escapeText(labels[key]) + "</b>：" + defs[key]);
          }).join("")
        ) +
        "</div>"
    );
    return '<div class="ko-tf-stages">' + cards.join("") + "</div>";
  }

  // 距离档位按钮。面板与弹窗共用同一套标记，区别只在点下去之后做什么
  // （见 handleClick）：弹窗里已经有一道题 → 换一道那个距离的；
  // 面板里还没出题 → 只选中这一次要用的距离，由旁边的「换个情境试试」开题。
  // 选中态来自 task.distance（也就是 pointer 里存着的那一次选择），
  // 所以重渲染、刷新、切项目之后都还在。
  function distanceButtons(data) {
    return (
      '<div class="ko-tf-dists" role="group" aria-label="迁移距离">' +
      (data.distances || [])
        .map(function (item) {
          return (
            '<button class="ko-tf-dist" type="button" data-ko-tf-dist="' +
            escapeText(item.key) + '" aria-pressed="' +
            (task.distance === item.key ? "true" : "false") + '">' +
            escapeText(item.label) + "</button>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function candidateButtons(data) {
    var candidates = data.candidates || [];
    if (!candidates.length) return "";
    return (
      '<div class="ko-tf-dists" role="group" aria-label="可选知识点">' +
      candidates
        .slice(0, 6)
        .map(function (item) {
          return (
            '<button class="ko-tf-dist" type="button" data-ko-tf-node="' +
            escapeText(item.node_id) + '">' + escapeText(item.name) +
            "<i>第 " + escapeText(item.layer) + " 层</i></button>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function targetMarkup(data) {
    var target = data && data.target;
    var reason = ((data && data.recommendation && data.recommendation.reason) || "") || "";

    if (!target) {
      var head = '<p class="ko-tf-meta">' + escapeText(reason || "还没有可以验迁移的知识点。") + "</p>";
      var candidates = candidateButtons(data);
      if (!candidates) {
        return (
          head +
          more(
            "为什么现在不能验迁移",
            note("只有带前置的知识点才出得了组合题 —— 「A 的知识 + B 的知识」合成一道题，" +
              "是迁移的主要来源。这个项目里还没有标出任何前置关系，所以暂时没有可试的点。") +
              note("先把框架里的点学起来，或在知识框架里补一批前置边。")
          )
        );
      }
      return (
        head +
        note("下面这些有前置，可以直接挑一个试试 —— 迁移分照样记，只是不会因为它「还没会了」而被推荐。") +
        candidates
      );
    }

    var prereq = (target.prereq_names || []).join("、");
    return (
      '<div class="ko-tf-target">' +
      '<span class="ko-tf-target-name">' + escapeText(target.name) + "</span>" +
      '<span class="ko-tf-badge">第 ' + escapeText(target.layer) + " 层</span>" +
      '<span class="ko-tf-badge">' + escapeText(target.transfer_stage_label) + "</span>" +
      '<span class="ko-tf-badge">前置：' + escapeText(prereq || "无") + "</span>" +
      "</div>" +
      (reason ? '<p class="ko-tf-meta">' + escapeText(reason) + "</p>" : "") +
      '<div class="ko-tf-acts"><button class="mini-button is-primary" type="button"' +
      ' data-ko-tf-begin="' + escapeText(target.node_id) + '">换个情境试试</button></div>' +
      distanceButtons(data) +
      more(
        "距离档位是怎么定的",
        note("档位说的是「<b>变了什么</b>」，不是难易之分：") +
          note("· <b>近迁移 · 换条件</b>：同一领域内改变一个已定义的条件或参数，结论怎么变。" +
            "背景、术语、公式全不变。") +
          note("· <b>中迁移 · 换表征</b>：知识点不变，换一张皮 —— 文字 ↔ 公式 ↔ 图表 ↔ 数据。" +
            "考的是「换个说法还认不认得」。") +
          note("· <b>远迁移 · 换领域</b>：换到资料没直接写过的领域，只保留同构的<b>关系结构</b>，" +
            "表层特征全变。这是最容易失败的一档，所以它要求源例与新情境逐项对齐 —— " +
            "只给一段「它们很像」不算迁移。") +
          note("默认档位是按层差推的：与某个前置之间还隔着别的知识点（层差 ≥1）就给远档，" +
            "紧挨着的给近档。你也可以手动改。")
      )
    );
  }

  function latestQuizMarkup(data) {
    var quiz = (data && data.latest_quiz) || {};
    if (!quiz.quiz_id || !quiz.node_count) return "";
    var n = Number(quiz.node_count || 0);
    // 一行说完。原来那两句话和测验页的交错说明条是同一件事讲两遍。
    return (
      '<p class="ko-tf-meta"><b>最近一轮测验</b>实际跨了 ' + escapeText(n) + " 个知识点 · " +
      (quiz.interleaved
        ? "交错出题，混着练才练得出「该用哪一个」。"
        : "这次没交错，题目都落在一个点上。") +
      "</p>"
    );
  }

  function conceptsMarkup() {
    var items = (queue.data && queue.data.items) || [];
    if (!items.length) {
      return (
        more(
          "跨课程建议是什么",
          note("「在别的课验过、这边还没验过」的同一个概念。") +
            note("多导几个项目、或做出几次迁移题之后，这里会开始有话说。" +
              "目前的对齐只认<b>写法相近</b>的术语（「傅里叶变换」与「傅里叶变换光学」会并，" +
              "「傅里叶变换」与「Fourier Transform」不会）—— 本项目不做联网词表，猜错的代价" +
              "是跨项目掌握度对比变成假数据。")
        )
      );
    }
    return (
      '<div class="ko-tf-concepts">' +
      items
        .slice(0, 4)
        .map(function (item) {
          var untested = (item.untested || [])[0];
          return (
            '<div class="ko-tf-concept">' +
            '<span class="ko-tf-concept-name">' + escapeText(item.name) + "</span>" +
            '<span class="ko-tf-meta">' + escapeText(item.reason) + "</span>" +
            (untested
              ? '<div><button class="mini-button" type="button" data-ko-tf-jump="' +
                escapeText(untested.project_id) + '" data-ko-tf-jump-node="' +
                escapeText(untested.node_id) + '">在那边验一次</button></div>'
              : "") +
            "</div>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function historyRowsMarkup(history, labels) {
    var items = history || [];
    if (!items.length) {
      return note("还没有出过的迁移题。出过的每一道都会留在这里。");
    }
    return (
      '<div class="ko-tf-hist">' +
      items
        .map(function (item) {
          var pct =
            item.correctness == null
              ? ""
              : "自评折算 " + Math.round(item.correctness * 100) + "%";
          var tags = [
            '<span class="ko-tf-badge">' + escapeText((labels || {})[item.distance] || item.distance) + "</span>",
            item.answered
              ? '<span class="ko-tf-badge is-ok">已答</span>'
              : '<span class="ko-tf-badge is-open">未答</span>',
            pct ? '<span class="ko-tf-badge">' + escapeText(pct) + "</span>" : "",
          ].join("");
          return (
            '<button class="ko-tf-hist-row" type="button"' +
            ' data-ko-tf-hist-row data-ko-tf-node="' + escapeText(item.node_id || "") + '"' +
            ' data-ko-tf-attempt="' + escapeText(item.attempt_id) + '">' +
            '<span class="ko-tf-hist-seq" aria-hidden="true">' + escapeText(item.seq) + "</span>" +
            '<span class="ko-tf-hist-main">' +
            '<span class="ko-tf-hist-q">' + escapeText(item.question || "（题干丢失）") + "</span>" +
            '<span class="ko-tf-hist-meta">' + tags +
            '<span class="ko-tf-hist-when">' + escapeText(_shortTime(item.created_at)) + "</span>" +
            "</span></span>" +
            "</button>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function backgroundMarkup() {
    if (!task.loading || !modalShell().hidden) return "";
    var name =
      (view.data && view.data.target && view.data.target.node_id === task.nodeId
        ? view.data.target.name
        : "") || "所选知识点";
    return (
      '<p class="ko-tf-bg"><span class="ko-tf-dot" aria-hidden="true"></span>' +
      "<b>正在后台出题</b>：给「" + escapeText(name) + "」出一道新的迁移题。" +
      "可以关掉继续做别的，出好了点「看一眼」就能看到 —— 不会重新开始。" +
      '<button class="mini-button" type="button" data-ko-tf-open-now>看一眼</button>' +
      "</p>"
    );
  }

  function pendingRowMarkup(data) {
    if (task.loading || !task.data || task.data.answered) return "";
    var pid = currentProjectId();
    if (pid && task.data.project_id && task.data.project_id !== pid) return "";
    void data;
    return (
      '<p class="ko-tf-bg"><b>有一道还没做完</b>：「' +
      escapeText(task.data.node_name || "迁移题") + "」。接着写它，或者换一道新的。" +
      '<button class="mini-button is-primary" type="button" data-ko-tf-resume="' +
      escapeText(task.data.node_id || "") + '">继续那道</button></p>'
    );
  }

  // 「待验队列」的规模。它和「还没验过迁移」不是同一个数（那个还包含没学到会了的点），
  // 但只有这一条能解释「为什么推荐的是这个知识点」—— 所以它必须挨着推荐位，
  // 而不是甩在面板最底下当脚注。
  function readyLine(summary) {
    var n = Number((summary || {}).ready_count || 0);
    if (!n) return "";
    return note(
      "<b>" + escapeText(n) + "</b> 个知识点已经会了、但还没验过迁移 —— 下面挑出来的就是其中一个。"
    );
  }

  function panelMarkup(data) {
    var summary = data.transfer_summary || {};
    var labels = (data.rules && data.rules.distance_labels) || {};
    var total = Number(data.history_total || 0);
    return (
      '<div class="' + PANEL_CLASS + '">' +
      '<div class="ko-tf-head"><strong>迁移</strong>' +
      "<span>会认 ≠ 会用。这一栏只统计「换个情境还用不用得上」。</span>" +
      '<span class="ko-tf-actions"><button class="mini-button" type="button"' +
      ' data-ko-tf-refresh>刷新</button></span></div>' +
      backgroundMarkup() +
      pendingRowMarkup(data) +
      stageCells(data) +
      readyLine(summary) +
      targetMarkup(data) +
      latestQuizMarkup(data) +
      '<div class="ko-tf-head"><strong>跨课程</strong>' +
      "<span>同一个概念在别的项目里学得怎么样。</span></div>" +
      conceptsMarkup() +
      '<div class="ko-tf-head"><strong>迁移题历史</strong>' +
      "<span>已共 " + escapeText(total) + " 道 · 点一条重新打开它。</span></div>" +
      historyRowsMarkup(data.history, labels) +
      "</div>"
    );
  }

  // 面板最后一次写进 DOM 的东西：**元素本体 + HTML**，两者都要比。
  //
  // 无条件 innerHTML= 就是「悬浮频闪」和「点了没反应」的真凶：
  //   bind() 在整个 body 上挂了 MutationObserver（app.js 每次进概览都重写
  //   #studio-output.innerHTML，追加的卡片必被冲掉，只能靠它兜住），而
  //   renderPanel 每次都整块重写 innerHTML —— 写 DOM 本身就是一次 childList 变更，
  //   于是「写 → 触发 observer → 120ms 后 mount → 再写」自己喂自己，
  //   停都停不下来（实测：什么都不动时 600ms 内重建 4 次）。后果有两个：
  //     · 指针停在上面时，:hover 的那个节点每 120~150ms 被换成新节点 → 频闪；
  //     · mousedown 与 mouseup 之间节点被换掉，浏览器不再把 click 派发给它
  //       （target 变了就发到两者的公共祖先），于是「点了没反应」。
  // 渲染必须**幂等**：内容没变就一个字节都不写。
  //
  // 连元素本体一起比是必须的：app.js 冲掉 #studio-output 之后 ensureCard 建的是
  // 一张**新的空卡**，只比字符串会误判「内容没变」而把空卡留在页面上
  // （progress-panel.js 的 render() 是同一个修法，那边的注释记着同一个坑）。
  function writeCard(card, markup) {
    if (view.lastCard === card && view.lastMarkup === markup) return false;
    view.lastCard = card;
    view.lastMarkup = markup;
    card.innerHTML = markup;
    return true;
  }

  function renderPanel() {
    var host = document.querySelector(".studio-output .overview-dashboard");
    if (!host) return false;
    ensureStyle();
    var card = host.querySelector("[data-ko-tf-panel]");
    if (!card) {
      card = document.createElement("div");
      card.className = "overview-panel";
      card.setAttribute("data-ko-tf-panel", "1");
      host.appendChild(card);
    }
    if (view.error && !view.data) {
      writeCard(
        card,
        '<div class="' + PANEL_CLASS + '"><p class="ko-tf-meta">' + escapeText(view.error) + "</p></div>"
      );
      return true;
    }
    if (!view.data) {
      if (view.loading) {
        // 占位也要保留展开记录 —— 它会整块替换 innerHTML。
        // ⚠️ 但**空结果不能覆盖已有记录**：占位里根本没有 details，
        // 采集它会得到 []，而 MutationObserver 在占位期间还会再跑一次 mount()，
        // 于是展开记录被自己抹成空 —— 表现就是「刷新后说明永远折回去」。
        // 空采集说明「这一轮没信息」，不是「用户全折起来了」。
        var collected = collectMoreKeys(card);
        if (collected.length) moreOpenKeys = collected;
        writeCard(
          card,
          '<div class="' + PANEL_CLASS + '"><p class="ko-tf-note">正在读迁移状态…</p></div>'
        );
      }
      return true;
    }
    var markup = panelMarkup(view.data);
    // 重渲染会把用户展开的 <details> 折回去，所以覆盖之前先记住**此刻**开着哪些。
    // 记在模块变量里而不是从 DOM 事后读：load(true) 中途会先渲染一次
    // 「正在读迁移状态…」的占位（那时 DOM 里根本没有 details），
    // 那一步读到的展开记录会是空的，刷新后说明一律折回去，开关看起来就是坏的。
    var collected = collectMoreKeys(card);
    if (collected.length) moreOpenKeys = collected;
    if (writeCard(card, markup)) {
      moreOpenKeys = restoreMoreKeys(card, moreOpenKeys);
    }
    return true;
  }

  var moreOpenKeys = [];

  function collectMoreKeys(root) {
    var keys = [];
    var list = root.querySelectorAll(".ko-tf-more[open]");
    for (var i = 0; i < list.length; i += 1) {
      var s = list[i].querySelector("summary");
      keys.push(s ? s.textContent.trim() : String(i));
    }
    return keys;
  }

  function restoreMoreKeys(root, keys) {
    var open = [];
    if (!keys || !keys.length) return open;
    var list = root.querySelectorAll(".ko-tf-more");
    for (var i = 0; i < list.length; i += 1) {
      var s = list[i].querySelector("summary");
      if (s && keys.indexOf(s.textContent.trim()) >= 0) {
        list[i].open = true;
        open.push(keys.filter(function (k) { return k === s.textContent.trim(); })[0]);
      }
    }
    return open;
  }

  // ── 测验页的交错说明条 ──────────────────────────────────

  function renderStreak() {
    var quiz = (view.data && view.data.latest_quiz) || {};
    var existing = document.querySelector("." + STREAK_CLASS);
    var nodeList = document.querySelectorAll(".studio-output .quiz-question");
    if (!nodeList.length || !view.data) {
      if (existing) existing.remove();
      return;
    }
    if (Number(quiz.node_count || 0) >= 2) {
      if (existing) return;
      var bar = document.createElement("div");
      bar.className = STREAK_CLASS;
      bar.innerHTML =
        "<b>本轮跨了 " + escapeText(quiz.node_count) + " 个知识点。</b>" +
        escapeText(
          quiz.interleaved
            ? "混着考是有意的 —— 交错练习练的是「该用哪一个」的判断，" +
              "按块练练不出来。觉得别扭很正常，那说明它起作用了。"
            : "（这一轮没交错成功，题目都落在一个点上。）"
        );
      nodeList[0].parentNode.insertBefore(bar, nodeList[0]);
      return;
    }
    if (existing) existing.remove();
  }

  // ── 弹窗 ──────────────────────────────────────────────

  function modalShell() {
    if (document.getElementById(MODAL_ID)) return document.getElementById(MODAL_ID);
    var root = document.createElement("div");
    root.id = MODAL_ID;
    root.hidden = true;
    // 结构只有 header + cols；内容全部由 renderModal 填。
    root.innerHTML =
      '<div class="ko-tf-modal-card" role="dialog" aria-modal="true" aria-label="换个情境试试">' +
      '<div class="ko-tf-modal-head">' +
      "<h3>换个情境试试</h3>" +
      '<span class="ko-tf-badge" data-ko-tf-badge hidden></span>' +
      '<span class="ko-tf-badge" data-ko-tf-node-name hidden></span>' +
      '<span class="ko-tf-spacer"></span>' +
      '<button class="mini-button" type="button" data-ko-tf-generate>换一道</button>' +
      '<button class="mini-button" type="button" data-ko-tf-close>关掉</button>' +
      "</div>" +
      '<div class="ko-tf-cols" data-ko-tf-body></div>' +
      "</div>";
    document.body.appendChild(root);
    return root;
  }

  function setBadge(el, text) {
    el.textContent = text || "";
    if (el.hasAttribute("hidden") && text) el.removeAttribute("hidden");
    if (!text) el.setAttribute("hidden", "");
  }

  function twoCols(readHtml, writeHtml) {
    return (
      '<div class="ko-tf-col ko-tf-col-read">' + readHtml + "</div>" +
      '<div class="ko-tf-col ko-tf-col-write">' + writeHtml + "</div>"
    );
  }

  function renderModal() {
    var root = modalShell();
    var body = root.querySelector("[data-ko-tf-body]");
    var badge = root.querySelector("[data-ko-tf-badge]");
    var nodeName = root.querySelector("[data-ko-tf-node-name]");
    var gen = root.querySelector("[data-ko-tf-generate]");
    setBadge(badge, "");
    setBadge(nodeName, "");
    gen.disabled = false;

    var err = task.error ? '<p class="ko-tf-error">' + escapeText(task.error) + "</p>" : "";

    // ---- 出题中 ----
    if (task.loading) {
      body.innerHTML = twoCols(
        '<div class="ko-tf-block">' +
          "<h4 class=\"ko-tf-section-title\">正在后台出题</h4>" +
          '<p class="ko-tf-why">要把源例和新情境<b>逐项对齐</b>才能出，所以通常十几秒。</p>' +
          '<p class="ko-tf-note">现在就可以关掉：生成是后台进行的，回来还是这一道。' +
          "模型偶尔给不出合规的对齐表，那时会明确告诉你「这次没出成」—— " +
          "而不是塞一道看起来像迁移的题进来。</p>" +
          "</div>" +
          err,
        ""
      );
      gen.disabled = true;
      body.scrollTop = 0;
      return;
    }

    // ---- 提交成功 ----
    if (task.result) {
      var r = task.result;
      body.innerHTML = twoCols(
        "",
        err +
          '<div class="ko-tf-done">' +
          "<h4>已计入迁移分：" + escapeText(r.transfer_stage_label || "") + "</h4>" +
          '<div class="ko-tf-scores">' +
          '<span class="ko-tf-badge">累计 ' + Math.round(Number(r.transfer_score || 0) * 100) + "%</span>" +
          '<span class="ko-tf-badge">这次 ' + escapeText(r.distance_label || "") + "</span>" +
          '<span class="ko-tf-badge">按自评折算 ' + Math.round(Number(r.correctness || 0) * 100) + "%</span>" +
          "</div>" +
          "<p>" + escapeText(r.next_hint || "") + "</p>" +
          "</div>"
      );
      body.scrollTop = 0;
      return;
    }

    // ---- 还没出题 ----
    if (!task.data) {
      body.innerHTML = twoCols(
        '<div class="ko-tf-block">' +
          "<h4 class=\"ko-tf-section-title\">还没出题</h4>" +
          (task.nodeId
            ? '<p class="ko-tf-why">点右上角「换一道」开始。</p>' +
              "<p class=\"ko-tf-note\">近迁移换条件、中迁移换表征、远迁移换领域。" +
              "远的最难，但只有它真能验出「换个世界你还会不会」。</p>"
            : '<p class="ko-tf-why">先在学习概览的「迁移」卡片里挑一个知识点。</p>') +
          err +
          "</div>",
        ""
      );
      body.scrollTop = 0;
      return;
    }

    // ---- 有一道题 ----
    var data = task.data;
    var t = data.task || {};
    var steps = t.alignment || [];
    var points = t.answer_points || [];
    setBadge(badge, data.distance_label || "");
    setBadge(nodeName, data.node_name || "");

    var read =
      (data.answered ? '<p class="ko-tf-note"><b>这一道已经答过了</b>，' +
        "自评折算 " + Math.round(Number((task.answeredInfo || {}).correctness || 0) * 100) +
        "%，当时的迁移分是 " + Math.round(Number((task.answeredInfo || {}).transfer_score || 0) * 100) +
        "%（" + escapeText((task.answeredInfo || {}).transfer_stage_label || "") +
        "）。想继续练请点「换一道」。</p>" : "") +
      '<div class="ko-tf-block">' +
      '<h4 class="ko-tf-section-title">题干<span>按右边的采分点对照自己写到了没有</span></h4>' +
      '<p class="ko-tf-why">' + escapeText(t.question || "") + "</p>" +
      "</div>" +
      '<div class="ko-tf-pair">' +
      '<div class="ko-tf-side"><b>源例 · 你学过的那一步</b><p>' +
      escapeText(t.source_example || "") + "</p></div>" +
      '<div class="ko-tf-side is-target"><b>新情境 · 同一个结构换了皮</b><p>' +
      escapeText(t.target_example || "") + "</p></div>" +
      "</div>" +
      (data.distance_reason
        ? note("<b>为什么给你这档距离：</b>" + escapeText(data.distance_reason))
        : "") +
      '<h4 class="ko-tf-section-title">逐项对齐<span>这道题的重点：照着「源例第 N 步 ↔ 新情境第 N 步」把推理写出来</span></h4>' +
      '<div class="ko-tf-align-wrap"><table class="ko-tf-align"><thead><tr>' +
      "<th>源例这一步</th><th>新情境对应那一步</th><th>为什么在结构上等价</th>" +
      "</tr></thead><tbody>" +
      (steps.length
        ? steps
            .map(function (step, index) {
              return (
                '<tr><td><span class="ko-tf-idx">' + (index + 1) + ".</span> " +
                escapeText(step.source_step) + "</td><td>" + escapeText(step.target_step) +
                "</td><td>" + escapeText(step.why) + "</td></tr>"
              );
            })
            .join("")
        : '<tr><td colspan="3">（模型这次没给对齐表，这一题不该出现 —— 见到就是 bug）</td></tr>') +
      "</tbody></table></div>";

    var write =
      '<div class="ko-tf-block">' +
      '<h4 class="ko-tf-section-title">采分点<span>自评时逐条对照</span></h4>' +
      '<ol class="ko-tf-points">' +
      points
        .map(function (point, index) {
          return "<li><i>" + (index + 1) + "</i><span>" + escapeText(point) + "</span></li>";
        })
        .join("") +
      "</ol></div>" +
      (data.answered
        ? note("这一道已作答，不重复计分。下面保留着完整的对齐表，可以回看。")
        : '<div class="ko-tf-block">' +
          '<h4 class="ko-tf-section-title">你的答案<span>写出对应关系才算迁移，只写结论不算</span></h4>' +
          '<textarea class="ko-tf-answer" data-ko-tf-answer placeholder="把每一步的对应关系和推理写出来">' +
          escapeText(task.answer) + "</textarea>" +
          '<p class="ko-tf-note">对照上面几条，写到了几条？</p>' +
          '<div class="ko-tf-ratings" role="group" aria-label="自评">' +
          SELF_RATINGS.map(function (item) {
            return (
              '<button class="ko-tf-rating" type="button" data-ko-tf-rate="' +
              escapeText(item.value) + '" aria-pressed="' +
              (task.rating === item.value ? "true" : "false") + '">' +
              escapeText(item.label) + "</button>"
            );
          }).join("") +
          "</div>" +
          more(
            "自评怎么折算",
            note("自评「很熟」最多按 85% 计入 —— 自评不该拿满分，否则这道题就退化成" +
              "「勾最上面那个」。真正客观判对的选择题走 100%。") +
              note("迁移题**一定**是开放题（要人写出对齐过程），所以判分必然依赖自评。" +
                "没自评就不计分，不替你猜。")
          ) +
          "</div>" +
          '<button class="mini-button is-primary ko-tf-submit" type="button" data-ko-tf-submit>' +
          "提交并计入迁移分</button>") +
      (view.data && view.data.history && view.data.history.length
        ? more(
            "这个项目的迁移题历史（已共 " + (view.data.history_total || 0) + " 道）",
            historyRowsMarkup(view.data.history.slice(0, 6), {
              labels: (view.data.rules && view.data.rules.distance_labels) || {},
            })
          )
        : "") +
      err;

    body.innerHTML = twoCols(read, write);
    body.scrollTop = 0;
    body.querySelectorAll(".ko-tf-col").forEach(function (col) {
      col.scrollTop = 0;
    });
  }

  function openModal(nodeId, options) {
    var opts = options || {};
    // 记录来处。**必须在每一条打开路径上执行**，包括「从历史重开」——
    // 之前历史那条路径直接设 hidden=false 绕过了本函数，于是 openedFrom 一直是
    // null，关闭时自然不会切回学习概览（用户报「点历史关闭后回到主界面」的根因）。
    if (modalShell().hidden && !openedFrom && typeof state !== "undefined" && state) {
      openedFrom = state.feature || "";
    }
    var pid = currentProjectId();
    var pointer = readPointer(pid);
    task.nodeId = nodeId || task.nodeId || (pointer && pointer.nodeId) || "";

    // 从历史里点开某一道：不生成，直接取回
    if (opts.attemptId) {
      task.loading = true;
      task.error = "";
      task.result = null;
      task.rating = null;
      task.answer = "";
      modalShell().hidden = false;
      renderModal();
      resumeAttempt(opts.attemptId);
      return;
    }

    // 手上已经有一道 ⇒ 直接显示，绝不重新生成
    if (task.data && task.nodeId === (task.data.node_id || task.nodeId)) {
      task.error = "";
      modalShell().hidden = false;
      renderModal();
      return;
    }
    if (!nodeId && pointer && pointer.nodeId) {
      task.nodeId = pointer.nodeId;
      task.distance = pointer.distance || task.distance;
    }
    task.rating = null;
    task.answer = "";
    modalShell().hidden = false;

    // 在途 ⇒ 接着等，不重发请求
    if (pointer && pointer.status === "generating" && !task.data) {
      task.loading = true;
      task.error = "";
      renderModal();
      pollForTask(pid, pointer.nodeId, 0);
      return;
    }
    // 已出好 ⇒ 从服务端把那一道取回来（刷新过浏览器也恢复）
    if (pointer && pointer.attemptId && !task.data) {
      task.loading = true;
      task.error = "";
      renderModal();
      resumeAttempt(pointer.attemptId);
      return;
    }
    if (!task.data) {
      task.loading = false;
      task.error = "";
      generateTask();
      return;
    }
    renderModal();
  }

  function closeModal() {
    clearPolling();
    modalShell().hidden = true;
    // 留在来处，不掉回主界面。只在「来处确实是概览」且 switchFeature 还在时才动，
    // 避免把用户在弹窗期间手动切走的界面又拽回来；两处都 try/catch，
    // 关窗无论如何要成功。
    if (
      openedFrom === "overview" &&
      typeof switchFeature === "function" &&
      typeof state !== "undefined" &&
      state &&
      state.feature !== "overview"
    ) {
      try {
        switchFeature("overview");
      } catch (err) {
        /* 切不过去也不能因此报错 */
      }
    }
    if (
      openedFrom === "overview" &&
      typeof currentUi === "function" &&
      currentUi() === "agent" &&
      window.KnowOriginAgentShell &&
      typeof window.KnowOriginAgentShell.revealStudio === "function"
    ) {
      try {
        window.KnowOriginAgentShell.revealStudio();
      } catch (err) {
        /* 同上 */
      }
    }
    openedFrom = null;
  }

  function generateTask(options) {
    var pid = currentProjectId();
    // 「换一道」是**用户明确**要新的 —— 只有这条路径才允许丢掉当前那道重发。
    if (!options || options.explicit) {
      clearPolling();
      task.data = null;
      task.result = null;
      task.answeredInfo = null;
    }
    if (!task.nodeId) {
      task.error = "没有选中知识点 —— 先在学习概览的「迁移」卡片里挑一个。";
      task.loading = false;
      renderModal();
      return;
    }
    task.loading = true;
    task.error = "";
    task.result = null;
    // 先落 pointer 再发请求：即使这一行之后弹窗被关、页面被刷，
    // 回来也知道「有一道在途」，于是接着等而不是重新烧一次模型。
    writePointer({
      nodeId: task.nodeId,
      distance: task.distance || "",
      attemptId: "",
      status: "generating",
    });
    renderModal();
    var body = { node_id: task.nodeId };
    if (task.distance) body.distance = task.distance;
    api("/api/transfer/" + encodeURIComponent(pid) + "/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (data) {
        // ⚠️ loading 必须复位。漏这一句的话提交成功后（或出题失败后）
        // 弹窗会永远停在「正在出题…」—— 这正是之前那个 bug。
        task.loading = false;
        task.data = data;
        task.answeredInfo = null;
        writePointer({
          nodeId: data.node_id || task.nodeId,
          distance: data.distance || task.distance || "",
          attemptId: data.attempt_id,
          status: "ready",
        });
      })
      .catch(function (error) {
        task.loading = false;
        task.data = null;
        // 后端在「模型没给出对齐结构」时会回 502 并带说明；直接显示它，
        // 因为那句话本身就解释了这次为什么没出题，不该被泛化成「出题失败」。
        task.error = String(
          (error && (error.detail || error.message)) || "出题失败，稍后再试。"
        );
        writePointer({ status: "", attemptId: "" });
      })
      .then(function () {
        renderModal();
        // 弹窗关着时也要把面板上的历史刷新出来
        if (modalShell().hidden) load(true);
      });
  }

  function submitTask() {
    var data = task.data;
    if (!data || data.answered) return;
    var root = modalShell();
    var answerBox = root.querySelector("[data-ko-tf-answer]");
    task.answer = answerBox ? answerBox.value : task.answer;
    if (task.rating == null) {
      task.error =
        "先给一个自评（完全不会 / 想错了 / 模糊 / 会了 / 很熟）—— " +
        "迁移题没有标准答案，不自评就不计分。";
      task.result = null;
      renderModal();
      var again = modalShell().querySelector("[data-ko-tf-answer]");
      if (again) again.focus();
      return;
    }
    task.loading = true;
    task.error = "";
    task.result = null;
    renderModal();
    api("/api/transfer/" + encodeURIComponent(currentProjectId()) + "/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        attempt_id: data.attempt_id,
        answer: task.answer,
        self_rating: task.rating,
      }),
    })
      .then(function (result) {
        // ⚠️ 同上：loading 必须复位，否则成功之后永远转圈。
        task.loading = false;
        task.result = result;
        task.data = null;
        task.rating = null;
        task.answer = "";
        // 这一道已经交出去了 ⇒ pointer 要清掉。不清的话下次打开会拿
        // attemptId 去把**已作答**的那道取回来，用户点「换个情境」看到的还是
        // 刚做完的旧题，像是什么都没发生。
        writePointer({ status: "", attemptId: "" });
        clearPolling();
        load(true);
        loadQueue();
      })
      .catch(function (error) {
        task.loading = false;
        // 失败时**保留 task.data**：用户已经写了一屏答案，把题换掉等于让他重写。
        task.error = String(
          (error && (error.detail || error.message)) || "提交失败，稍后再试。"
        );
      })
      .then(function () {
        renderModal();
      });
  }

  // ── 数据 ──────────────────────────────────────────────

  function syncProject() {
    var pid = currentProjectId();
    if (!pid) {
      view.projectId = null;
      view.data = null;
      return;
    }
      if (pid === view.projectId && view.data) return;
      view.projectId = pid;
      view.data = null;
      // 换项目就把上一份的距离选择丢掉：它是跟着 pointer 走的，
      // 不然在新项目里会看到一个不属于它的档位被选中。
      task.distance = "";
      load(false);
  }

  function load(force) {
    if (!isAuthenticated()) return;
    var pid = currentProjectId();
    if (!pid) return;
    if (view.loading) return;
    view.loading = true;
    view.error = "";
    if (force) view.data = null;
    renderPanel();
    Promise.all([
      call("/api/transfer/" + encodeURIComponent(pid) + "/readiness"),
      call("/api/progress/" + encodeURIComponent(pid) + "/plan"),
    ])
      .then(function (results) {
        var readiness = results[0] || {};
        var plan = results[1] || {};
        // 迁移三档的计数直接用进步引擎那份（同一个 event stream + 同一套阈值），
        // 自己再数一遍必然和推荐位显示的不一致。
        readiness.transfer_summary = plan.transfer || null;
        view.data = readiness;
        // 刷新过浏览器之后，上次选的距离还记在 pointer 里 —— 档位按钮得把
        // 「这一次会用哪一档」如实显示出来，否则用户不知道自己正在做哪一档。
        var pointer = readPointer(pid);
        if (pointer && pointer.distance) task.distance = pointer.distance;
      })
      .catch(function (error) {
        view.error = (error && error.message) || "拿不到迁移状态，稍后再试。";
      })
      .then(function () {
        view.loading = false;
        renderPanel();
        renderStreak();
      });
  }

  function loadQueue() {
    if (!isAuthenticated()) return;
    if (queue.loading) return;
    queue.loading = true;
    call("/api/transfer/queue")
      .then(function (data) {
        queue.data = data;
      })
      .catch(function () {
        /* 队列拿不到就只显示空态，不影响面板其余部分 */
      })
      .then(function () {
        queue.loading = false;
        renderPanel();
      });
  }

  // ── 交互 ──────────────────────────────────────────────

  function handleClick(event) {
    var target = event.target;
    if (!target || !target.closest) return;

    if (target.closest("[data-ko-tf-close]")) {
      closeModal();
      return;
    }
    if (target.closest("[data-ko-tf-refresh]")) {
      load(true);
      loadQueue();
      return;
    }
    if (target.closest("[data-ko-tf-generate]")) {
      // 用户明确点「换一道」：这才允许丢掉当前那道、重发。
      generateTask({ explicit: true });
      return;
    }
    if (target.closest("[data-ko-tf-submit]")) {
      submitTask();
      return;
    }
    // 从历史里重新打开某一道。必须走 openModal：它负责记下来处
    // （关掉时要切回学习概览）以及恢复 pointer。
    var reopen = target.closest("[data-ko-tf-attempt]");
    if (reopen) {
      var row = reopen.closest("[data-ko-tf-hist-row]");
      openModal((row && row.getAttribute("data-ko-tf-node")) || "", {
        attemptId: reopen.getAttribute("data-ko-tf-attempt"),
      });
      return;
    }
    if (target.closest("[data-ko-tf-open-now]")) {
      openModal(task.nodeId || "");
      return;
    }
    var resume = target.closest("[data-ko-tf-resume]");
    if (resume) {
      openModal(resume.getAttribute("data-ko-tf-resume"));
      return;
    }
    // 无推荐时从候选里手挑一个知识点
    var pick = target.closest("[data-ko-tf-node]");
    if (pick) {
      task.nodeId = pick.getAttribute("data-ko-tf-node");
      openModal(task.nodeId);
      return;
    }
    // 有推荐节点时的主动作：打开弹窗并在后台出题
    var begin = target.closest("[data-ko-tf-begin]");
    if (begin) {
      task.nodeId = begin.getAttribute("data-ko-tf-begin");
      openModal(task.nodeId);
      return;
    }
    var dist = target.closest("[data-ko-tf-dist]");
    if (dist) {
      var group = dist.parentNode.querySelectorAll("[data-ko-tf-dist]");
      for (var i = 0; i < group.length; i += 1) {
        group[i].setAttribute("aria-pressed", group[i] === dist ? "true" : "false");
      }
      task.distance = dist.getAttribute("data-ko-tf-dist");
      // 只改 aria-pressed、不重渲染：整块重写会把用户刚按下的这个节点换掉 ——
      // 在旧版里这一段是「面板每秒重建」的直接受害者（按下与抬起之间节点被换掉，
      // click 落到公共祖先上，按钮看起来就是死的）。
      // 存回去时必须带上 nodeId：writePointer 在没有 nodeId 时会**删掉**整条 pointer
      // （它是「没有在途任务」的信号），而这里只是想改一个距离。
      var pointer = task.pointer || readPointer(currentProjectId());
      if (pointer) writePointer({ nodeId: pointer.nodeId, distance: task.distance });
      // 弹窗里已经有一道题：换一道那个距离的。面板里还没出题：只选中。
      if (dist.closest(".ko-tf-modal-card")) generateTask({ explicit: true });
      return;
    }
    var rate = target.closest("[data-ko-tf-rate]");
    if (rate) {
      task.rating = Number(rate.getAttribute("data-ko-tf-rate"));
      var answer = modalShell().querySelector("[data-ko-tf-answer]");
      task.answer = answer ? answer.value : "";
      task.error = "";
      renderModal();
      var submit = modalShell().querySelector("[data-ko-tf-submit]");
      if (submit) submit.focus();
      return;
    }
    var jump = target.closest("[data-ko-tf-jump]");
    if (jump && typeof state !== "undefined" && state) {
      state.currentProjectId = jump.getAttribute("data-ko-tf-jump");
      task.nodeId = jump.getAttribute("data-ko-tf-jump-node");
      load(true);
      openModal(task.nodeId);
    }
  }

  function handleKeydown(event) {
    if (event.key !== "Escape") return;
    var root = document.getElementById(MODAL_ID);
    if (root && !root.hidden) closeModal();
  }

  var pending = false;
  function scheduleMount() {
    if (pending) return;
    pending = true;
    setTimeout(function () {
      pending = false;
      mount();
    }, 120);
  }

  function mount() {
    if (!isAuthenticated()) return false;
    syncProject();
    var ok = renderPanel();
    renderStreak();
    return ok;
  }

  function bind() {
    if (document.body) {
      new MutationObserver(scheduleMount).observe(document.body, {
        childList: true,
        subtree: true,
      });
    }
    // 切到「学习概览」时即时补一次，不等 120ms 防抖
    document.addEventListener(
      "click",
      function (event) {
        var grid = event.target.closest && event.target.closest(".feature-grid");
        if (grid) setTimeout(mount, 0);
      },
      true
    );
    document.addEventListener("click", handleClick);
    document.addEventListener("keydown", handleKeydown);
    loadQueue();
    mount();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }

  window.KnowOriginTransfer = {
    refresh: function () { load(true); },
    open: openForNode,
    mount: mount,
    readiness: function () { return view.data; },
    task: function () { return task; },
    moreKeys: function () { return moreOpenKeys.slice(); },
  };

  function openForNode(nodeId) {
    openModal(nodeId);
  }
})();
