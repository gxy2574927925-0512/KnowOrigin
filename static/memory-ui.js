/**
 * AI 记忆 v2 —— 挂在**聊天输入框旁边**的入口 + 浮层（两层槽位版）。
 *
 * ## 为什么重排（v1 的面板为什么不够用）
 *
 * v1 的浮层是「共 N 条 + 一堆平铺自由短句 + 三个按钮」。数据形态变了，这个布局
 * 装不下新东西：两层 × 4 格、每格的旧值链、每格「最近一次进入 prompt」、
 * 首次告知、首次引导。硬塞进去只会变成一团。
 *
 * ## 数据形态变了，交互职责也跟着变
 *
 *   全局画像（4 格）= **用户声明式** → 所以每格必须能「改」，不能只能删。
 *     用户看到「专业」记错了，第一反应是改，不是删。删除粒度也据此分层：
 *     改一格 / 清空本项目 / 清空全局 / 全部清空。
 *   项目级记忆（4 格）= **AI 推断式** → 所以每格要标出是谁写的、什么时候写的、
 *     改过什么（旧值链），用户才有依据判断该不该信。
 *
 * ## 首次告知与首次引导（多用户产品的门面）
 *
 * v1 只做了「可看、可删、可清空」——那是**事后控制**。对要给别人的产品还缺
 * **事前告知**：记忆是关于人的数据，用户有权在被记录之前就知道。
 * 另外新用户打开时面板是空的，第一印象就是「这功能没用」；引导 3 步填完
 * 立刻就有 4 格全局画像，第一轮对话就带得上。
 * 刻意**不预填默认值**：空着是「不知道」，预填是「知道错了」，而模型会照着错的演。
 *
 * ## 约定
 *
 * - 不碰 app.js / styles.css；样式自带注入；删掉 index.html 那一行即完全回退。
 * - 模块内状态变量叫 **view**，不能叫 state —— 会遮蔽 app.js 的顶层 const state。
 * - 词表（推荐标签 / 年级 / 目标类别）**一律来自服务端**（core/user_memory.py 是
 *   唯一定义处）。前端抄一份就会漂移成两份，两边对不上。
 * - 浮层用 position:fixed 挂 document.body，靠 getBoundingClientRect 对齐按钮 ——
 *   不做成 .composer 子元素，父链上任何一层 overflow/transform 都会把它裁掉。
 * - 主题只写 var(--panel/--ink/--line/--muted/--green/--red/--gold-soft/--background)，
 *   **永不硬编码颜色**（深色主题下 --green 填充要配 color:#0e1410）。
 * - 展开态 / 编辑态 / 引导步数必须存进 view，不能直接改 DOM：
 *   整块 innerHTML 重渲染会把直接改的 DOM 状态全冲掉。
 */
(function () {
  "use strict";

  var STYLE_ID = "ko-memory-style";
  var POP_ATTR = "data-ko-mem-pop";
  var OPEN_ATTR = "data-ko-mem-open";
  var API = "/api/memory";

  var view = {
    enabled: true,
    loaded: false,
    loading: false,
    busy: false,
    open: false,
    error: "",
    // 服务端数据
    slots: { global: [], project: [] },
    state: null,
    vocab: null,
    projectId: "",
    consent: false,
    onboarded: false,
    memoryOff: false,
    // 本地交互态（重渲染前必须先落在这里）
    consentDismissed: false,
    onboardingStep: -1, // -1 = 不在引导里；0/1/2 = 第几步
    editKey: "", // 正在行内编辑的槽位；空 = 没在编辑
    editScope: "",
    draft: null, // 编辑/引导中的草稿对象
    openHistory: {}, // slot_key -> true（旧值链展开）
    openEvidence: {}, // slot_key -> true（依据原文展开）
    customTag: "",
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
      // ⚠️ app.js 的 api() 是 fetch 直通、**不自动带 Content-Type**。
      // 漏了它 FastAPI 会报 Input should be a valid dictionary。
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

  function relativeTime(iso) {
    if (!iso) return "—";
    var then = new Date(iso);
    if (isNaN(then.getTime())) return "—";
    var seconds = Math.floor((Date.now() - then.getTime()) / 1000);
    if (seconds < 60) return "刚刚";
    if (seconds < 3600) return Math.floor(seconds / 60) + " 分钟前";
    if (seconds < 86400) return Math.floor(seconds / 3600) + " 小时前";
    var days = Math.floor(seconds / 86400);
    return days < 30 ? days + " 天前" : then.toLocaleDateString();
  }

  function notify(text, variant) {
    try {
      if (typeof showToast === "function") {
        showToast(text, { variant: variant || "notice" });
        return;
      }
    } catch (error) {
      /* 忽略：toast 只是锦上添花 */
    }
  }

  function popNode() {
    return document.querySelector("[" + POP_ATTR + "]");
  }

  /**
   * 当前打开的项目 id —— 从 app.js 的顶层 state 读（同页经典脚本共享全局词法
   * 作用域；`typeof` 判断兜底 app.js 未加载的情形）。
   * ⚠️ /api/memory/* 不在 /api/projects/{pid}/ 路径下，服务端的路径正则捞不到
   * 当前项目 —— 每个记忆端点都必须**显式**带上 project_id。漏带的端点会静默
   * 退化成「无项目」：面板显示「未打开项目」、提取只写全局格（2026-09-28 实测）。
   */
  function currentProjectId() {
    try {
      if (
        typeof state === "object" &&
        state &&
        typeof state.currentProjectId === "string"
      ) {
        return state.currentProjectId || view.projectId || "";
      }
    } catch (error) {
      /* app.js 未加载 / 变量被遮蔽时，退回服务端上次返回的值 */
    }
    return view.projectId || "";
  }

  function confirmAsk(message) {
    if (typeof window.confirm !== "function") return true;
    return window.confirm(message);
  }

  // --------------------------------------------------------- 值的渲染/编辑 --

  /** 把槽位的 value 对象渲染成一行短文本（与服务端 render_value 保持一致）。 */
  function valueText(slot) {
    var value = slot.value || {};
    if (slot.slot_key === "major_grade") {
      return value.grade ? value.major + "·" + value.grade : value.major || "";
    }
    if (slot.slot_key === "goal") {
      if (value.category && value.title) return value.category + "：" + value.title;
      return value.category || value.title || "";
    }
    if (value.tags) return value.tags.join("；");
    if (value.text) return value.text;
    if (value.items) {
      return value.items
        .map(function (item) {
          return (
            item.text + (item.source === "mastery" ? "（客观）" : "（自述）")
          );
        })
        .join("；");
    }
    return "";
  }

  function isTagSlot(key) {
    return key === "pref_explain" || key === "style" || key === "proj_pref";
  }

  function isListSlot(key) {
    return key === "stuck_points" || key === "open_questions";
  }

  function listLimitFor(key) {
    var limits = (view.vocab && view.vocab.list_limits) || {};
    return limits[key] || 5;
  }

  function vocabFor(key) {
    var vocab = view.vocab || {};
    if (key === "pref_explain") return vocab.pref_explain || [];
    if (key === "style") return vocab.style || [];
    // 项目级偏好复用讲解偏好词表 —— 同一套「怎么讲」，不必再造一份
    if (key === "proj_pref") return vocab.pref_explain || [];
    return [];
  }

  function draftFor(slot) {
    var value = (slot && slot.value) || {};
    if (slot && slot.slot_key === "major_grade") {
      return { major: value.major || "", grade: value.grade || "" };
    }
    if (slot && slot.slot_key === "goal") {
      return { category: value.category || "", title: value.title || "" };
    }
    if (slot && isTagSlot(slot.slot_key)) {
      return { tags: (value.tags || []).slice() };
    }
    if (slot && slot.slot_key === "progress") {
      return { text: value.text || "" };
    }
    if (slot && isListSlot(slot.slot_key)) {
      return {
        items: (value.items || []).map(function (item) {
          return { text: item.text || "", source: item.source || "self" };
        }),
      };
    }
    return {};
  }

  function draftToValue(key, draft) {
    var data = draft || {};
    if (key === "major_grade") return { major: data.major, grade: data.grade };
    if (key === "goal") return { category: data.category, title: data.title };
    if (isTagSlot(key)) return { tags: (data.tags || []).slice() };
    if (key === "progress") return { text: data.text };
    if (isListSlot(key)) {
      return {
        items: (data.items || []).filter(function (item) {
          return String(item.text || "").trim();
        }),
      };
    }
    return {};
  }

  // ---------------------------------------------------------------- 样式 --

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      // —— 输入框旁的入口 ——
      ".ko-mem-trigger{display:inline-flex;align-items:center;gap:5px;height:28px;",
      "box-sizing:border-box;border:1px solid var(--line);border-radius:8px;",
      "background:transparent;color:var(--muted);padding:0 9px;font-size:calc(11.5px * var(--font-scale, 1));",
      "cursor:pointer;font-family:inherit;white-space:nowrap}",
      ".ko-mem-trigger:hover{color:var(--ink);border-color:var(--muted)}",
      ".ko-mem-trigger.is-on{border-color:var(--green);color:var(--green)}",
      ".ko-mem-trigger i{width:5px;height:5px;border-radius:50%;background:var(--green);",
      "display:none;flex:0 0 auto}",
      ".ko-mem-trigger.has-data i{display:block}",

      // —— 浮层 ——
      ".ko-mem-pop{position:fixed;z-index:200;display:flex;flex-direction:column;",
      "background:var(--panel);color:var(--ink);border:1px solid var(--line);",
      "border-radius:14px;box-shadow:0 18px 48px rgba(29,28,24,.22);",
      "font-family:inherit;overflow:hidden}",
      // ⚠️ 本类是 display:flex，必须显式压掉 [hidden]，否则 pop.hidden 形同虚设
      ".ko-mem-pop[hidden]{display:none}",
      ".ko-mem-pop-head{display:flex;align-items:center;justify-content:space-between;",
      "gap:8px;padding:10px 12px 8px;border-bottom:1px solid var(--line);flex:0 0 auto}",
      ".ko-mem-pop-title{font-size:calc(12.5px * var(--font-scale, 1));font-weight:500}",
      ".ko-mem-pop-actions{display:flex;gap:5px;flex-wrap:wrap;padding:9px 12px 0;flex:0 0 auto}",
      ".ko-mem-pop-body{flex:1 1 auto;overflow-y:auto;overscroll-behavior:contain;",
      "padding:10px 12px 12px;min-height:0}",

      ".km-btn{border:1px solid var(--line);background:transparent;color:var(--ink);",
      "border-radius:8px;padding:4px 9px;font-size:calc(11.5px * var(--font-scale, 1));cursor:pointer;white-space:nowrap;",
      "font-family:inherit}",
      ".km-btn:hover{border-color:var(--muted)}",
      ".km-btn:disabled{opacity:.5;cursor:not-allowed}",
      ".km-btn.primary{background:var(--green);border-color:var(--green);color:#0e1410}",
      ".km-btn.danger:hover{border-color:var(--red);color:var(--red)}",
      ".km-btn.tiny{padding:2px 7px;font-size:calc(11px * var(--font-scale, 1))}",

      ".km-banner{border:1px solid var(--green);border-radius:10px;padding:9px 11px;",
      "margin-bottom:10px;font-size:calc(11.5px * var(--font-scale, 1));line-height:1.7;color:var(--ink)}",
      ".km-banner .km-row{display:flex;gap:6px;margin-top:7px}",
      ".km-intro{border:1px solid var(--line);border-radius:10px;padding:9px 11px;",
      "background:var(--background);font-size:calc(11.5px * var(--font-scale, 1));color:var(--muted);line-height:1.7;",
      "margin-bottom:10px}",
      ".km-intro b{color:var(--ink);font-weight:500}",

      // —— 引导 ——
      ".km-steps{display:flex;gap:5px;margin-bottom:9px}",
      ".km-step{flex:1;height:3px;border-radius:2px;background:var(--line)}",
      ".km-step.on{background:var(--green)}",
      ".km-field{margin-bottom:9px}",
      ".km-flabel{display:block;font-size:calc(11px * var(--font-scale, 1));color:var(--muted);margin-bottom:4px}",
      ".km-select,.km-input{border:1px solid var(--line);border-radius:8px;padding:5px 8px;",
      "background:var(--panel);color:var(--ink);font-size:calc(11.5px * var(--font-scale, 1));font-family:inherit}",
      ".km-select{width:100%;box-sizing:border-box}",
      ".km-input{width:100%;box-sizing:border-box}",
      ".km-input:focus,.km-select:focus{outline:none;border-color:var(--green)}",
      ".km-dim{font-size:calc(10.5px * var(--font-scale, 1));color:var(--muted);margin:8px 0 4px}",
      ".km-chips{display:flex;flex-wrap:wrap;gap:5px}",
      ".km-chip{border:1px solid var(--line);background:transparent;color:var(--muted);",
      "border-radius:20px;padding:3px 9px;font-size:calc(11px * var(--font-scale, 1));cursor:pointer;font-family:inherit}",
      ".km-chip:hover{border-color:var(--muted);color:var(--ink)}",
      ".km-chip.on{border-color:var(--green);color:var(--green);background:transparent}",

      // —— 槽位卡片 ——
      ".km-group{margin-bottom:12px}",
      ".km-group-title{font-size:calc(11px * var(--font-scale, 1));color:var(--muted);margin:0 0 6px;display:flex;",
      "align-items:center;gap:6px}",
      ".km-group-title::after{content:'';flex:1;height:1px;background:var(--line)}",
      ".km-card{border:1px solid var(--line);border-radius:9px;margin-bottom:6px;",
      "padding:7px 9px}",
      ".km-card.is-empty{border-style:dashed}",
      ".km-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px}",
      ".km-card-label{font-size:calc(10.5px * var(--font-scale, 1));color:var(--muted)}",
      ".km-card-value{font-size:calc(12px * var(--font-scale, 1));line-height:1.6;margin:4px 0 0;word-break:break-word}",
      ".km-card-value.is-empty{color:var(--muted);font-size:calc(11.5px * var(--font-scale, 1))}",
      ".km-card-meta{font-size:calc(10.5px * var(--font-scale, 1));color:var(--muted);margin-top:4px;display:flex;",
      "gap:8px;flex-wrap:wrap;align-items:center}",
      ".km-card-tools{display:flex;gap:5px;flex:0 0 auto}",
      ".km-tag{padding:0 6px;border-radius:5px;background:var(--gold-soft);color:var(--ink);",
      "font-size:calc(10px * var(--font-scale, 1))}",
      ".km-link{border:none;background:transparent;color:var(--muted);cursor:pointer;",
      "font-size:calc(10.5px * var(--font-scale, 1));padding:0;font-family:inherit;text-decoration:underline}",
      ".km-link:hover{color:var(--ink)}",
      ".km-hist{margin-top:6px;padding-top:6px;border-top:1px dashed var(--line);",
      "font-size:calc(10.5px * var(--font-scale, 1));color:var(--muted);line-height:1.7}",
      ".km-hist b{color:var(--ink);font-weight:500}",
      ".km-evidence{margin-top:6px;padding:7px 9px;border-radius:8px;background:var(--panel);",
      "border:1px solid var(--line);font-size:calc(11px * var(--font-scale, 1));color:var(--muted);line-height:1.6}",
      ".km-evidence b{display:block;margin-bottom:3px;color:var(--ink);font-weight:500}",
      ".km-evidence p{margin:0;white-space:pre-wrap;word-break:break-word}",
      ".km-editor{margin-top:7px;padding-top:7px;border-top:1px solid var(--green)}",
      ".km-edit-row{display:flex;gap:6px;margin-top:7px;flex-wrap:wrap}",
      ".km-empty{padding:20px 4px;text-align:center;color:var(--muted);font-size:calc(11.5px * var(--font-scale, 1));",
      "line-height:1.8}",
      ".km-err{border:1px solid var(--red);border-radius:9px;padding:8px 10px;",
      "color:var(--red);font-size:calc(11.5px * var(--font-scale, 1));margin-bottom:9px}",
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
    button.className = "ko-mem-trigger";
    button.setAttribute(OPEN_ATTR, "1");
    // 用真实节点而不是 innerHTML：innerHTML 在最小 DOM 桩里不解析子节点，
    // 而按钮文案/角标每次都要重写，用节点更稳。
    var dot = document.createElement("i");
    var label = document.createElement("span");
    label.setAttribute("data-ko-mem-label", "1");
    var count = document.createElement("span");
    count.setAttribute("data-ko-mem-count", "1");
    button.appendChild(dot);
    button.appendChild(label);
    button.appendChild(count);
    button.addEventListener("click", function (event) {
      event.stopPropagation();
      toggle();
    });
    host.appendChild(button);
    renderTrigger(button);
  }

  function filledCount() {
    return view.slots.global
      .concat(view.slots.project)
      .filter(function (slot) {
        return slot.filled;
      }).length;
  }

  function renderTrigger(button) {
    var node = button || document.querySelector("[" + OPEN_ATTR + "]");
    if (!node) return;
    var label = node.querySelector("[data-ko-mem-label]");
    var count = node.querySelector("[data-ko-mem-count]");
    if (label) label.textContent = "记忆";
    if (count) count.textContent = view.loaded ? " " + filledCount() : "";
    node.classList.toggle("has-data", view.loaded && filledCount() > 0);
    node.classList.toggle("is-on", view.open);
    node.title = view.loaded
      ? "AI 记住了 " + filledCount() + " 格关于你的信息"
      : "看看 AI 记住了什么";
  }

  // ---------------------------------------------------------------- 浮层 --

  function ensurePop() {
    var existing = popNode();
    if (existing) return existing;
    if (!document.body) return null;
    var pop = document.createElement("div");
    pop.className = "ko-mem-pop";
    pop.setAttribute(POP_ATTR, "1");
    pop.hidden = true;
    document.body.appendChild(pop);
    // 点浮层内部不冒泡到「点外部关闭」的判断上
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
    var width = Math.min(380, Math.max(260, window.innerWidth - 24));
    pop.style.width = width + "px";
    pop.style.maxHeight = Math.min(520, Math.round(window.innerHeight * 0.68)) + "px";
    var maxLeft = window.innerWidth - width - 12;
    pop.style.left =
      Math.min(Math.max(12, rect.left), Math.max(12, maxLeft)) + "px";
    // 从按钮上方弹出：bottom 视口距离 = 视口高 - 按钮顶边 + 8px
    pop.style.bottom = Math.max(12, window.innerHeight - rect.top + 8) + "px";
  }

  function open() {
    var pop = ensurePop();
    if (!pop) return;
    view.open = true;
    view.error = "";
    pop.hidden = false;
    render();
    place();
    renderTrigger();
    // 每次打开都重取一次：记忆可能在刚结束的对话里被更新过
    load();
  }

  function close() {
    var pop = popNode();
    if (pop) pop.hidden = true;
    view.open = false;
    view.editKey = "";
    view.draft = null;
    view.onboardingStep = -1;
    renderTrigger();
  }

  function toggle() {
    if (view.open) close();
    else open();
  }

  // ---------------------------------------------------------------- 渲染 --

  function renderConsent() {
    if (view.consent || view.consentDismissed) return "";
    return (
      '<div class="km-banner">AI 会在你聊天时记住<b>你的背景与讲解偏好</b>，' +
      "并在之后的回答里自动带上。<br>你随时能在这里查看、修改、清空 —— " +
      "只存在你自己的数据库里。" +
      '<div class="km-row">' +
      '<button type="button" class="km-btn primary" data-ko-mem-consent>知道了</button>' +
      '<button type="button" class="km-btn danger" data-ko-mem-disable>不要记住我</button>' +
      "</div></div>"
    );
  }

  function renderSteps() {
    var html = '<div class="km-steps">';
    for (var index = 0; index < 3; index += 1) {
      html += '<span class="km-step' + (index <= view.onboardingStep ? " on" : "") + '"></span>';
    }
    return html + "</div>";
  }

  function renderChip(text, on) {
    return (
      '<button type="button" class="km-chip' +
      (on ? " on" : "") +
      '" data-ko-mem-chip="' +
      esc(text) +
      '">' +
      esc(text) +
      "</button>"
    );
  }

  function renderTagPicker(key, selected) {
    var groups = vocabFor(key);
    var html = "";
    groups.forEach(function (group) {
      html += '<div class="km-dim">' + esc(group.dimension || "") + "</div>";
      html += '<div class="km-chips">';
      (group.tags || []).forEach(function (tag) {
        html += renderChip(tag, selected.indexOf(tag) >= 0);
      });
      html += "</div>";
    });
    // 半开放：词表都不合适时允许自己加一个短标签（服务端限 ≤8 字）
    html +=
      '<div class="km-dim">都没有？自己加一个（不超过 ' +
      esc((view.vocab && view.vocab.max_tag_chars) || 8) +
      " 字）</div>" +
      '<input class="km-input" data-ko-mem-custom maxlength="' +
      esc((view.vocab && view.vocab.max_tag_chars) || 8) +
      '" placeholder="例如：先讲物理图像" value="' +
      esc(view.customTag || "") +
      '">';
    return html;
  }

  function renderOnboarding() {
    var step = view.onboardingStep;
    var draft = view.draft || {};
    if (step === 0) {
      var grades = (view.vocab && view.vocab.grades) || [];
      return (
        renderSteps() +
        '<div class="km-intro">先花 10 秒告诉 AI 你是谁 —— ' +
        "这些信息由<b>你自己</b>填，AI 不会去猜。（可以随时跳过或改）</div>" +
        '<div class="km-field"><label class="km-flabel">你的专业</label>' +
        '<input class="km-input" data-ko-mem-major maxlength="12" value="' +
        esc(draft.major || "") +
        '" placeholder="例如：电子科学与技术"></div>' +
        '<div class="km-field"><label class="km-flabel">年级</label>' +
        '<select class="km-select" data-ko-mem-grade><option value="">不填</option>' +
        grades
          .map(function (grade) {
            return (
              '<option value="' +
              esc(grade) +
              '"' +
              (draft.grade === grade ? " selected" : "") +
              ">" +
              esc(grade) +
              "</option>"
            );
          })
          .join("") +
        "</select></div>" +
        renderOnboardButtons("下一步")
      );
    }
    if (step === 1) {
      var categories = (view.vocab && view.vocab.goal_categories) || [];
      return (
        renderSteps() +
        '<div class="km-field"><label class="km-flabel">你现在主要在做什么</label>' +
        '<select class="km-select" data-ko-mem-goal-cat><option value="">不填</option>' +
        categories
          .map(function (category) {
            return (
              '<option value="' +
              esc(category) +
              '"' +
              (draft.category === category ? " selected" : "") +
              ">" +
              esc(category) +
              "</option>"
            );
          })
          .join("") +
        "</select></div>" +
        '<div class="km-field"><label class="km-flabel">具体一点（可不填）</label>' +
        '<input class="km-input" data-ko-mem-goal-title maxlength="16" value="' +
        esc(draft.title || "") +
        '" placeholder="例如：12 月的考研初试"></div>' +
        renderOnboardButtons("下一步")
      );
    }
    return (
      renderSteps() +
      '<div class="km-field"><label class="km-flabel">你喜欢怎么被讲解（可多选）</label>' +
      renderTagPicker("pref_explain", draft.tags || []) +
      "</div>" +
      renderOnboardButtons("完成")
    );
  }

  function renderOnboardButtons(nextLabel) {
    return (
      '<div class="km-edit-row">' +
      '<button type="button" class="km-btn primary" data-ko-mem-onboard-next>' +
      esc(nextLabel) +
      "</button>" +
      '<button type="button" class="km-btn" data-ko-mem-onboard-prev>' +
      (view.onboardingStep > 0 ? "上一步" : "以后再说") +
      "</button>" +
      "</div>"
    );
  }

  function renderEditor(slot) {
    var key = slot.slot_key;
    var draft = view.draft || {};
    var body = "";
    if (key === "major_grade") {
      var grades = (view.vocab && view.vocab.grades) || [];
      body =
        '<div class="km-field"><label class="km-flabel">专业</label>' +
        '<input class="km-input" data-ko-mem-major maxlength="12" value="' +
        esc(draft.major || "") +
        '"></div>' +
        '<div class="km-field"><label class="km-flabel">年级</label>' +
        '<select class="km-select" data-ko-mem-grade><option value="">不填</option>' +
        grades
          .map(function (grade) {
            return (
              '<option value="' +
              esc(grade) +
              '"' +
              (draft.grade === grade ? " selected" : "") +
              ">" +
              esc(grade) +
              "</option>"
            );
          })
          .join("") +
        "</select></div>";
    } else if (key === "goal") {
      var categories = (view.vocab && view.vocab.goal_categories) || [];
      body =
        '<div class="km-field"><label class="km-flabel">类别</label>' +
        '<select class="km-select" data-ko-mem-goal-cat><option value="">不填</option>' +
        categories
          .map(function (category) {
            return (
              '<option value="' +
              esc(category) +
              '"' +
              (draft.category === category ? " selected" : "") +
              ">" +
              esc(category) +
              "</option>"
            );
          })
          .join("") +
        "</select></div>" +
        '<div class="km-field"><label class="km-flabel">具体（可不填，≤16 字）</label>' +
        '<input class="km-input" data-ko-mem-goal-title maxlength="16" value="' +
        esc(draft.title || "") +
        '"></div>';
    } else if (isTagSlot(key)) {
      body = renderTagPicker(key, draft.tags || []);
    } else if (key === "progress") {
      body =
        '<div class="km-field"><label class="km-flabel">一句话（≤24 字）</label>' +
        '<input class="km-input" data-ko-mem-text maxlength="24" value="' +
        esc(draft.text || "") +
        '"></div>';
    } else if (isListSlot(key)) {
      // 客观卡点（来自掌握度）不在这里编辑 —— 它是算出来的，不是写的
      var lines = (draft.items || [])
        .filter(function (item) {
          return item.source !== "mastery";
        })
        .map(function (item) {
          return item.text;
        })
        .join("\n");
      body =
        '<div class="km-field"><label class="km-flabel">一行一条（最多 ' +
        esc(listLimitFor(key)) +
        " 条，客观卡点那几条是算出来的，这里改不了）</label>" +
        '<textarea class="km-input" data-ko-mem-lines rows="3">' +
        esc(lines) +
        "</textarea></div>";
    }
    return (
      '<div class="km-editor">' +
      body +
      '<div class="km-edit-row">' +
      '<button type="button" class="km-btn primary" data-ko-mem-save>保存</button>' +
      '<button type="button" class="km-btn" data-ko-mem-cancel>取消</button>' +
      '<button type="button" class="km-btn danger" data-ko-mem-clear-one>清掉这格</button>' +
      "</div></div>"
    );
  }

  function renderCard(slot) {
    var editing = view.editKey === slot.slot_key;
    var tools =
      '<div class="km-card-tools">' +
      (editing
        ? ""
        : '<button type="button" class="km-link" data-ko-mem-edit="' +
          esc(slot.slot_key) +
          '">' +
          (slot.filled ? "改" : "设置") +
          "</button>") +
      "</div>";
    var meta = "";
    if (slot.filled) {
      meta =
        '<div class="km-card-meta">' +
        '<span class="km-tag">' +
        (slot.source === "auto" ? "AI 推断" : "我设置的") +
        "</span>" +
        "<span>更新 " +
        esc(relativeTime(slot.updated_at)) +
        "</span>" +
        "<span>最近进入 prompt " +
        esc(relativeTime(slot.last_injected_at)) +
        "</span>" +
        ((slot.history || []).length
          ? '<button type="button" class="km-link" data-ko-mem-hist="' +
            esc(slot.slot_key) +
            '">改过 ' +
            (slot.history || []).length +
            " 次</button>"
          : "") +
        (slot.evidence
          ? '<button type="button" class="km-link" data-ko-mem-evidence="' +
            esc(slot.slot_key) +
            '">依据</button>'
          : "") +
        "</div>";
    }
    var history = "";
    if (slot.filled && view.openHistory[slot.slot_key] && (slot.history || []).length) {
      history =
        '<div class="km-hist">' +
        (slot.history || [])
          .map(function (entry) {
            return (
              "<div>" +
              esc(relativeTime(entry.created_at)) +
              " 之前是：<b>" +
              esc(valueText({ slot_key: slot.slot_key, value: entry.value })) +
              "</b></div>"
            );
          })
          .join("") +
        "</div>";
    }
    var evidence = "";
    if (slot.filled && view.openEvidence[slot.slot_key] && slot.evidence) {
      evidence =
        '<div class="km-evidence"><b>依据 · AI 读了这段对话才这么推断</b><p>' +
        esc(slot.evidence) +
        "</p></div>";
    }
    return (
      '<div class="km-card' +
      (slot.filled ? "" : " is-empty") +
      '"><div class="km-card-head">' +
      '<span class="km-card-label">' +
      esc(slot.label) +
      "</span>" +
      tools +
      "</div>" +
      '<p class="km-card-value' +
      (slot.filled ? "" : " is-empty") +
      '">' +
      esc(slot.filled ? valueText(slot) : "还没设置") +
      "</p>" +
      meta +
      history +
      evidence +
      (editing ? renderEditor(slot) : "") +
      "</div>"
    );
  }

  function renderSection(title, slots) {
    return (
      '<section class="km-group"><h4 class="km-group-title">' +
      esc(title) +
      "</h4>" +
      slots.map(renderCard).join("") +
      "</section>"
    );
  }

  function render() {
    var pop = popNode();
    if (!pop) return;

    if (view.enabled === false) {
      pop.innerHTML =
        '<div class="ko-mem-pop-head"><span class="ko-mem-pop-title">AI 记忆</span>' +
        '<button type="button" class="km-btn" data-ko-mem-close>关闭</button></div>' +
        '<div class="ko-mem-pop-body"><div class="km-intro">' +
        "长期记忆已在 <b>.env</b> 里关闭（<b>KNOWORIGIN_MEMORY_ENABLED=false</b>）。" +
        "</div></div>";
      return;
    }

    if (view.memoryOff) {
      pop.innerHTML =
        '<div class="ko-mem-pop-head"><span class="ko-mem-pop-title">AI 记忆</span>' +
        '<button type="button" class="km-btn" data-ko-mem-close>关闭</button></div>' +
        '<div class="ko-mem-pop-body"><div class="km-intro">' +
        "AI 记忆已关闭 —— 不会再把任何记忆带进对话。" +
        "已记的内容保留着，重新打开即恢复。" +
        '<div class="km-edit-row">' +
        '<button type="button" class="km-btn primary" data-ko-mem-enable>重新开启</button>' +
        "</div></div></div>";
      place();
      return;
    }

    if (view.onboardingStep >= 0) {
      pop.innerHTML =
        '<div class="ko-mem-pop-head">' +
        '<span class="ko-mem-pop-title">设置你的画像</span>' +
        '<button type="button" class="km-btn" data-ko-mem-close>关闭</button></div>' +
        '<div class="ko-mem-pop-body">' +
        (view.error ? '<div class="km-err">' + esc(view.error) + "</div>" : "") +
        renderOnboarding() +
        "</div>";
      var first = pop.querySelector("input,select");
      if (first && typeof first.focus === "function") first.focus();
      place();
      return;
    }

    var stateInfo = view.state || {};
    var pending = Number(stateInfo.pending) || 0;
    var hasProject = !!view.projectId;
    pop.innerHTML =
      '<div class="ko-mem-pop-head">' +
      '<span class="ko-mem-pop-title">AI 记忆 · ' +
      filledCount() +
      " 格</span>" +
      '<button type="button" class="km-btn" data-ko-mem-close>关闭</button>' +
      "</div>" +
      '<div class="ko-mem-pop-actions">' +
      '<button type="button" class="km-btn primary" data-ko-mem-extract>从最近对话学习</button>' +
      '<button type="button" class="km-btn" data-ko-mem-onboard>重新设置画像</button>' +
      '<button type="button" class="km-btn danger" data-ko-mem-clear-project>' +
      (hasProject ? "清空本项目" : "清空本项目（未打开项目）") +
      "</button>" +
      '<button type="button" class="km-btn danger" data-ko-mem-clear-global>清空全局画像</button>' +
      "</div>" +
      '<div class="ko-mem-pop-body">' +
      (view.error ? '<div class="km-err">' + esc(view.error) + "</div>" : "") +
      renderConsent() +
      '<div class="km-intro">' +
      "上四格由<b>你自己设置</b>，AI 只是照着用；下四格是 AI 从你的对话与掌握度里" +
      "<b>推断</b>出来的，可以随时改或删。每格的「最近进入 prompt」表示它上一次真的" +
      "被带进对话是什么时候。<br>上次学习：" +
      esc(relativeTime(stateInfo.last_run_at)) +
      " · 待积累 " +
      pending +
      " 轮对话。" +
      "</div>" +
      renderSection("全局画像 · 你自己设置的", view.slots.global) +
      (hasProject
        ? renderSection("本项目 · AI 推断的", view.slots.project)
        : '<section class="km-group"><h4 class="km-group-title">本项目 · AI 推断的</h4>' +
          '<div class="km-empty">打开一个项目后，这里会显示本项目里的卡点、' +
          "进度与未解问题。</div></section>") +
      "</div>";
    place();
  }

  // ---------------------------------------------------------------- 交互 --

  function load() {
    if (view.loading) return Promise.resolve();
    view.loading = true;
    // 项目 id 必须显式带上：服务端从 /api/memory/slots 这个路径里推不出当前项目
    var pid = currentProjectId();
    var url = API + "/slots";
    if (pid) url += "?project_id=" + encodeURIComponent(pid);
    return call(url)
      .then(function (data) {
        view.slots = {
          global: data.global || [],
          project: data.project || [],
        };
        view.state = data.state || null;
        view.vocab = data.vocab || null;
        view.projectId = data.project_id || "";
        view.consent = !!data.consent;
        view.onboarded = !!data.onboarded;
        view.memoryOff = !!data.memory_off;
        view.enabled = data.enabled !== false;
        view.error = "";
        view.loaded = true;
        // 首次进入：没被记录过就先告知，再引导
        if (!view.consent && !view.consentDismissed) {
          view.onboardingStep = -1;
        } else if (!view.onboarded && !view.memoryOff && view.onboardingStep < 0) {
          startOnboarding();
        }
      })
      .catch(function (error) {
        view.error = (error && error.message) || "没能读到记忆，请稍后重试。";
      })
      .finally(function () {
        view.loading = false;
        render();
        renderTrigger();
      });
  }

  function startOnboarding() {
    view.onboardingStep = 0;
    view.editKey = "";
    view.customTag = "";
    view.draft = { major: "", grade: "", category: "", title: "", tags: [] };
  }

  /** 把当前 DOM 里的输入同步回 draft —— 重渲染会整块替换 innerHTML，必须先捞回来。 */
  function syncDraftFromDom() {
    var pop = popNode();
    if (!pop || !view.draft) return;
    var read = function (selector) {
      var node = pop.querySelector(selector);
      return node ? String(node.value || "") : null;
    };
    var major = read("[data-ko-mem-major]");
    if (major !== null) view.draft.major = major;
    var grade = read("[data-ko-mem-grade]");
    if (grade !== null) view.draft.grade = grade;
    var category = read("[data-ko-mem-goal-cat]");
    if (category !== null) view.draft.category = category;
    var title = read("[data-ko-mem-goal-title]");
    if (title !== null) view.draft.title = title;
    var text = read("[data-ko-mem-text]");
    if (text !== null) view.draft.text = text;
    var custom = read("[data-ko-mem-custom]");
    if (custom !== null) view.customTag = custom;
    var lines = read("[data-ko-mem-lines]");
    if (lines !== null) {
      var kept = (view.draft.items || []).filter(function (item) {
        return item.source === "mastery";
      });
      lines
        .split("\n")
        .map(function (line) {
          return line.trim();
        })
        .filter(function (line) {
          return !!line;
        })
        .forEach(function (line) {
          kept.push({ text: line, source: "self" });
        });
      view.draft.items = kept;
    }
  }

  function nextOnboardingStep() {
    syncDraftFromDom();
    if (view.onboardingStep >= 2) {
      finishOnboarding();
      return;
    }
    view.onboardingStep += 1;
    render();
  }

  function finishOnboarding() {
    var draft = view.draft || {};
    var slots = {};
    if (draft.major) slots.major_grade = { major: draft.major, grade: draft.grade };
    if (draft.category || draft.title) {
      slots.goal = { category: draft.category, title: draft.title };
    }
    if ((draft.tags || []).length) slots.pref_explain = { tags: draft.tags };
    var jobs = [
      call(API + "/profile", { method: "PUT", body: { slots: slots } }),
      call(API + "/onboarded", { method: "POST", body: {} }),
    ];
    return Promise.all(jobs)
      .then(function () {
        view.onboardingStep = -1;
        view.draft = null;
        notify("画像已保存，AI 之后会照着它回答。", "success");
        return load();
      })
      .catch(function (error) {
        view.error = (error && error.message) || "保存失败，请稍后重试。";
        render();
      });
  }

  function beginEdit(slotKey) {
    var all = view.slots.global.concat(view.slots.project);
    var slot = null;
    for (var index = 0; index < all.length; index += 1) {
      if (all[index].slot_key === slotKey) {
        slot = all[index];
        break;
      }
    }
    if (!slot) return;
    view.editKey = slotKey;
    view.editScope = slot.filled ? slot.source : "";
    view.customTag = "";
    view.draft = draftFor(slot);
    render();
  }

  function saveEdit() {
    var pop = popNode();
    if (!pop || !view.editKey) return;
    syncDraftFromDom();
    var key = view.editKey;
    var isGlobal = view.slots.global.some(function (slot) {
      return slot.slot_key === key;
    });
    var value = draftToValue(key, view.draft || {});
    call(API + "/slots/" + encodeURIComponent(key), {
      method: "PUT",
      body: {
        value: value,
        scope: isGlobal ? "global" : "project",
        // 项目级槽位必须显式带 project_id，否则服务端 400「请先打开一个项目」
        project_id: isGlobal ? "" : currentProjectId(),
      },
    })
      .then(function () {
        view.editKey = "";
        view.draft = null;
        view.customTag = "";
        return load();
      })
      .catch(function (error) {
        notify((error && error.message) || "保存失败。", "error");
      });
  }

  function clearOne() {
    if (!view.editKey) return;
    clearSlot(view.editKey);
  }

  function clearSlot(slotKey) {
    var isGlobal = view.slots.global.some(function (slot) {
      return slot.slot_key === slotKey;
    });
    var label = slotKey;
    view.slots.global.concat(view.slots.project).forEach(function (slot) {
      if (slot.slot_key === slotKey) label = slot.label;
    });
    if (!confirmAsk("清掉「" + label + "」这一格？")) return;
    var url =
      API +
      "/slots/" +
      encodeURIComponent(slotKey) +
      "?scope=" +
      (isGlobal ? "global" : "project");
    // 项目级删除同样要显式带项目 —— 服务端路径里推不出来
    if (!isGlobal) url += "&project_id=" + encodeURIComponent(currentProjectId());
    call(url, { method: "DELETE" })
      .then(function () {
        view.editKey = "";
        view.draft = null;
        return load();
      })
      .catch(function (error) {
        notify((error && error.message) || "清空失败。", "error");
      });
  }

  function extract() {
    if (view.busy) return;
    view.busy = true;
    view.error = "";
    render();
    var button = popNode() && popNode().querySelector("[data-ko-mem-extract]");
    if (button) {
      button.disabled = true;
      button.textContent = "正在学习…";
    }
    // 带上当前项目：不带的话服务端只提取全局格，项目级记忆永远学不到
    call(API + "/extract", {
      method: "POST",
      body: { project_id: currentProjectId() },
    })
      .then(function (data) {
        view.busy = false;
        var added = Number(data.added) || 0;
        if (data.error && !added) {
          view.error = "提取没成功（" + data.error + "），稍后再试一次。";
          render();
        } else if (added > 0) {
          notify("更新了 " + added + " 格记忆。", "success");
        } else {
          notify("这次没有发现新的、值得长期记住的信息。", "notice");
        }
        return load();
      })
      .catch(function (error) {
        view.busy = false;
        view.error = (error && error.message) || "提取失败，请稍后重试。";
        render();
      });
  }

  function setMemoryOff(off) {
    if (
      off &&
      !confirmAsk(
        "关掉后 AI 不再把任何记忆带进对话（已记的内容保留，重新打开即恢复）。确认关掉？"
      )
    ) {
      return;
    }
    call(API + "/opt-out", { method: "POST", body: { off: off } })
      .then(function () {
        notify(off ? "已关闭 AI 记忆。" : "已重新开启 AI 记忆。", "success");
        return load();
      })
      .catch(function (error) {
        notify((error && error.message) || "操作失败。", "error");
      });
  }

  function clearScope(scope) {
    var text =
      scope === "project"
        ? "清空本项目的记忆？（全局画像 —— 也就是你自己设置的那四格 —— 不受影响）"
        : "清空全局画像？你自己设置的专业、目标与偏好都会被删掉。";
    if (!confirmAsk(text)) return;
    // 服务端对 scope=project 拿不到项目会 400，这里先拦一层，提示更友好
    var pid = scope === "project" ? currentProjectId() : "";
    if (scope === "project" && !pid) {
      notify("先打开一个项目，再清空它的记忆。", "notice");
      return;
    }
    call(API + "/clear", {
      method: "POST",
      body: { scope: scope, keep_manual: true, project_id: pid },
    })
      .then(function (data) {
        notify(
          Number(data.removed) > 0 ? "已清空。" : "本来就没有可清空的。",
          "notice"
        );
        return load();
      })
      .catch(function (error) {
        notify((error && error.message) || "清空失败。", "error");
      });
  }

  function markConsent() {
    view.consentDismissed = true;
    view.consent = true;
    call(API + "/consent", { method: "POST", body: {} }).catch(function () {
      /* 记不上也不该挡住用户 */
    });
    // 告知过了就顺势进引导 —— 这是新用户唯一一次「愿意填」的时刻
    if (!view.onboarded && !view.memoryOff) startOnboarding();
    render();
  }

  function toggleChip(tag) {
    if (!view.draft) return;
    syncDraftFromDom();
    var tags = view.draft.tags || (view.draft.tags = []);
    var at = tags.indexOf(tag);
    if (at >= 0) tags.splice(at, 1);
    else if (tags.length < ((view.vocab && view.vocab.max_tags_per_slot) || 5)) {
      tags.push(tag);
    } else {
      notify("这个槽位最多选 " + ((view.vocab && view.vocab.max_tags_per_slot) || 5) + " 个标签。", "notice");
      return;
    }
    render();
  }

  function commitCustomTag() {
    if (!view.draft) return;
    syncDraftFromDom();
    var text = String(view.customTag || "").trim();
    if (!text) return;
    var tags = view.draft.tags || (view.draft.tags = []);
    if (tags.indexOf(text) < 0) tags.push(text);
    view.customTag = "";
    render();
  }

  function bindPop() {
    var pop = popNode();
    if (!pop || pop.getAttribute("data-ko-mem-bound") === "1") return;
    pop.setAttribute("data-ko-mem-bound", "1");
    // 委托挂在浮层节点上；浮层只创建一次，innerHTML 重渲染不会丢监听。
    pop.addEventListener("click", function (event) {
      var target = event.target;
      var edit = target.closest("[data-ko-mem-edit]");
      if (edit) {
        beginEdit(edit.getAttribute("data-ko-mem-edit"));
        return;
      }
      var chip = target.closest("[data-ko-mem-chip]");
      if (chip) {
        toggleChip(chip.getAttribute("data-ko-mem-chip"));
        return;
      }
      var hist = target.closest("[data-ko-mem-hist]");
      if (hist) {
        var key = hist.getAttribute("data-ko-mem-hist");
        view.openHistory[key] = !view.openHistory[key];
        render();
        return;
      }
      var evid = target.closest("[data-ko-mem-evidence]");
      if (evid) {
        var evKey = evid.getAttribute("data-ko-mem-evidence");
        view.openEvidence[evKey] = !view.openEvidence[evKey];
        render();
        return;
      }
      var action = target.closest(
        "[data-ko-mem-extract],[data-ko-mem-close],[data-ko-mem-save],"
          + "[data-ko-mem-cancel],[data-ko-mem-clear-one],[data-ko-mem-clear-project],"
          + "[data-ko-mem-clear-global],[data-ko-mem-consent],[data-ko-mem-disable],"
          + "[data-ko-mem-onboard],[data-ko-mem-onboard-next],[data-ko-mem-onboard-prev]"
      );
      if (!action) return;
      if (action.hasAttribute("data-ko-mem-extract")) extract();
      else if (action.hasAttribute("data-ko-mem-close")) close();
      else if (action.hasAttribute("data-ko-mem-save")) saveEdit();
      else if (action.hasAttribute("data-ko-mem-cancel")) {
        view.editKey = "";
        view.draft = null;
        render();
      } else if (action.hasAttribute("data-ko-mem-clear-one")) clearOne();
      else if (action.hasAttribute("data-ko-mem-clear-project")) clearScope("project");
      else if (action.hasAttribute("data-ko-mem-clear-global")) clearScope("global");
      else if (action.hasAttribute("data-ko-mem-consent")) markConsent();
      else if (action.hasAttribute("data-ko-mem-disable")) setMemoryOff(true);
      else if (action.hasAttribute("data-ko-mem-enable")) setMemoryOff(false);
      else if (action.hasAttribute("data-ko-mem-onboard")) {
        startOnboarding();
        render();
      }
      else if (action.hasAttribute("data-ko-mem-onboard-next")) nextOnboardingStep();
      else if (action.hasAttribute("data-ko-mem-onboard-prev")) {
        syncDraftFromDom();
        if (view.onboardingStep > 0) {
          view.onboardingStep -= 1;
          render();
        } else {
          view.onboardingStep = -1;
          view.draft = null;
          view.onboarded = true;
          call(API + "/onboarded", { method: "POST", body: {} }).catch(function () {});
          render();
        }
      }
    });
    pop.addEventListener("keydown", function (event) {
      if (event.key !== "Enter") return;
      if (event.target.hasAttribute("data-ko-mem-custom")) {
        event.preventDefault();
        commitCustomTag();
      } else if (
        event.target.hasAttribute("data-ko-mem-major") ||
        event.target.hasAttribute("data-ko-mem-text") ||
        event.target.hasAttribute("data-ko-mem-goal-title")
      ) {
        event.preventDefault();
        if (view.onboardingStep >= 0) nextOnboardingStep();
        else saveEdit();
      }
    });
  }

  /**
   * 点浮层外面 / 按 Esc 关掉。
   * ⚠️ 入口按钮自己的 click 已经 stopPropagation，所以不会走到这里；
   *    内部点击也在浮层上被拦住。剩下能到这里的就都是「外部点击」。
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
    // 捕获阶段接滚动：滚动可能发生在任意祖先滚动容器上
    window.addEventListener("scroll", place, true);
  }

  /**
   * `.composer-tools` 只在**打开项目后**才存在（无项目时整个 composer 都不渲染），
   * 而 state.currentProjectId 随时可能变。用 DOM 观察 + 防抖，比轮询干净：
   * ensureTrigger 自带存在性判断，重复调用是廉价的 no-op。
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
    bindPop();
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

  window.KnowOriginMemory = {
    open: open,
    close: close,
    refresh: load,
    _view: view,
  };
})();
