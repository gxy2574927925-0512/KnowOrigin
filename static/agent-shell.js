/* ===========================================================================
   Agent 工作台外壳（图标栏 / 项目与会话侧栏 / 浮层交互 / 「试试这样问」）
   ---------------------------------------------------------------------------
   ⚠️ 必须在 app.js **之后**加载：它要读写 app.js 的顶层 `const state` 与顶层函数
   （classic script 共享全局词法环境）。顺序反了拿不到 state，会直接抛
   "state is not defined"。

   对外只暴露 window.KnowOriginAgentShell；其余都是模块内部实现。
   =========================================================================== */
(function () {
  "use strict";

  // app.js 顶层 const state / api / 等函数在这里直接可见（同为 classic script）。
  // ⚠️ 探测必须在**顶层**做：state 是 app.js 的顶层 const，属于全局词法环境，
  // 在别的 classic script 里可见；但如果 app.js 加载失败，这里就是 undefined。
  const hasApp = typeof state !== "undefined" && typeof currentUi === "function";

  // ---- localStorage keys ----
  const SESSION_MAP_KEY = "knoworigin-chat-session-v1";       // { [projectId]: sessionId }
  const SUGGESTED_ON_KEY = "knoworigin-agent-suggested-on-v1"; // "off" = 关闭
  const SUGGESTED_POS_KEY = "knoworigin-agent-suggested-pos-v1";// { left, top }
  const SESSIONS_HIDDEN_KEY = "knoworigin-agent-sessions-hidden-v1"; // "on" = 侧栏收起
  const EXPANDED_KEY = "knoworigin-agent-expanded-projects-v1";      // { [projectId]: true|false }

  const MODULE_LABELS = { english: "英语词汇" };
  const MODULE_OPENERS = {
    english: () => window.enVocabOpenView?.(),
    // 读书：能力由 static/reading.js 提供（window.KnowOriginReading），那一行脚本删掉即回退。
    reading: () => window.KnowOriginReading?.open?.(),
  };

  // 项目行右侧的「文档」图标（打开该项目的知识文档 = 合订稿全文）。
  const DOC_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"></path>' +
    '<path d="M14 3v5h5"></path><path d="M9 13h6"></path><path d="M9 17h4"></path></svg>';

  // 项目行右侧的「学习文档」图标（把一页速查表 / 学习路径 / 清单报告合成一份长文）。
  // 刻意画成「一本书」而不是「一张纸」——与左边的知识文档图标一眼分得开。
  // 能力由 static/study-doc-ui.js 提供（window.KnowOriginStudyDoc），那一行脚本删掉即回退。
  const STUDY_DOC_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19a1 1 0 0 1 1 1v13.5"></path>' +
    '<path d="M4 5.5v12A2.5 2.5 0 0 0 6.5 20H20"></path>' +
    '<path d="M6.5 17H20"></path>' +
    '<path d="M8 8h8"></path><path d="M8 11.5h5"></path></svg>';

  // 每个项目的会话清单缓存：树里可以同时展开多个项目，state.chatSessions 只装得下当前项目。
  const sessionsCache = {};
  const sessionsLoading = {};

  let currentFeature = "framework";
  // state.chatSessions 属于哪个项目（"" = 还没加载过 / 已失效）。
  // 必须单独记一份：state.chatSessions 本身分不清「这个项目真的没有会话」
  // 和「这份清单是上一个项目的」，而项目切换有两条入口都会绕过 resolveMessages。
  let sessionsProjectId = "";

  function isAgentUi() {
    return typeof currentUi === "function" && currentUi() === "agent";
  }

  // ---- 小工具 ----
  function readSessionMap() {
    try {
      const raw = localStorage.getItem(SESSION_MAP_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function rememberSession(projectId, sessionId) {
    if (!projectId) return;
    const map = readSessionMap();
    if (sessionId) map[projectId] = sessionId;
    else delete map[projectId];
    try {
      localStorage.setItem(SESSION_MAP_KEY, JSON.stringify(map));
    } catch (_) {
      /* 隐私模式写不进去：只在本次会话内生效，不影响功能 */
    }
  }

  function relativeTime(iso) {
    if (!iso) return "";
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return "";
    const diff = Date.now() - then.getTime();
    const minute = 60000;
    if (diff < minute) return "刚刚";
    if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
    if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`;
    if (diff < 7 * 24 * 60 * minute) return `${Math.floor(diff / (24 * 60 * minute))} 天前`;
    return then.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
  }

  // ---- 项目 / 会话侧栏（两层树：项目 → 会话） ----

  /** 展开状态存 localStorage：没记过的话只有「当前项目」默认展开。 */
  function isExpanded(projectId) {
    const stored = readExpandedMap()[projectId];
    if (stored === true) return true;
    if (stored === false) return false;
    return projectId === state.currentProjectId;
  }

  function readExpandedMap() {
    try {
      const raw = localStorage.getItem(EXPANDED_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function toggleExpanded(projectId) {
    if (!projectId) return;
    const map = readExpandedMap();
    map[projectId] = !isExpanded(projectId);
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify(map));
    } catch (_) {
      /* 隐私模式：只在本次会话内生效 */
    }
  }

  /** 展开一个项目时按需拉它的会话 —— 非当前项目的清单没别的地方会去取。 */
  function ensureSessions(projectId) {
    if (!projectId || sessionsCache[projectId] || sessionsLoading[projectId]) return;
    sessionsLoading[projectId] = true;
    fetchSessions(projectId).then((sessions) => {
      sessionsLoading[projectId] = false;
      sessionsCache[projectId] = sessions;
      // 是当前项目才回写 state —— 否则会把当前项目正在看的清单顶掉
      if (state.currentProjectId === projectId) {
        state.chatSessions = sessions;
        sessionsProjectId = projectId;
      }
      renderSidebar();
    });
  }

  function renderSidebar() {
    const list = document.querySelector("#agent-session-list");
    if (!list || !hasApp) return;
    const projects = Array.isArray(state.projects) ? state.projects : [];
    if (!projects.length) {
      list.innerHTML = `<p class="agent-sessions-empty">还没有项目。<br>点下面的「新建项目」开始。</p>`;
      return;
    }
    // 当前项目的会话由 app.js 维护，统一灌进缓存，树里各项目共用同一个来源
    if (sessionsProjectId && sessionsProjectId === state.currentProjectId && Array.isArray(state.chatSessions)) {
      sessionsCache[state.currentProjectId] = state.chatSessions;
    }
    const html = projects.map((project) => {
      const projectId = project.project_id;
      const isCurrent = projectId === state.currentProjectId;
      const open = isExpanded(projectId);
      let rows = "";
      if (open) {
        const sessions = sessionsCache[projectId];
        if (!sessions) {
          ensureSessions(projectId);
          rows = `<p class="agent-sessions-empty">正在读取会话…</p>`;
        } else if (!sessions.length) {
          rows = `<p class="agent-sessions-empty">这个项目还没有会话。</p>`;
        } else {
          rows = sessions.map((session) => sessionRow(session, projectId)).join("");
        }
      }
      const label = projectLabel(project);
      return `
        <div class="agent-project">
          <button class="agent-project-row${isCurrent ? " is-current" : ""}"
                  data-agent-project="${escapeAttr(projectId)}"
                  aria-expanded="${open ? "true" : "false"}"
                  title="${escapeAttr(label)}">
            <span class="agent-project-caret" data-agent-project-toggle="${escapeAttr(projectId)}"
                  role="button" aria-label="${open ? "收起" : "展开"}项目" title="${open ? "收起" : "展开"}">${open ? "▾" : "▸"}</span>
            <span class="agent-project-name">${escapeHtml(label)}</span>
            <span class="agent-project-study" data-agent-project-study="${escapeAttr(projectId)}"
                  role="button" aria-label="学习文档" title="打开学习文档（一页速查表 + 学习路径 + 清单报告）">${STUDY_DOC_ICON}</span>
            <span class="agent-project-doc" data-agent-project-doc="${escapeAttr(projectId)}"
                  role="button" aria-label="知识文档" title="打开知识文档">${DOC_ICON}</span>
          </button>
          ${rows}
        </div>`;
    }).join("");
    list.innerHTML = html;
  }

  function sessionRow(session, projectId) {
    const active = (state.chatSessionId || "") === (session.session_id || "");
    const title = session.title || "未命名会话";
    const count = Number(session.message_count) || 0;
    const when = relativeTime(session.updated_at);
    return `
      <button class="agent-session-main${active ? " is-active" : ""}"
              data-agent-session="${escapeAttr(session.session_id || "")}"
              data-agent-session-project="${escapeAttr(projectId || "")}"
              title="${escapeAttr(title)}${when ? ` · ${when}` : ""}">
        <span class="agent-session-title">${escapeHtml(title)}</span>
        ${count ? `<span class="agent-session-count">${count}</span>` : ""}
        <span class="agent-session-more" data-agent-session-menu="${escapeAttr(session.session_id || "")}"
              role="button" aria-label="会话操作" title="重命名 / 删除">⋯</span>
      </button>`;
  }

  function syncSessionMenu() {
    // 当前会话变了就把侧栏重画一次（高亮跟上）
    renderSidebar();
  }

  async function fetchSessions(projectId) {
    if (!projectId) return [];
    try {
      const data = await api(`/api/projects/${encodeURIComponent(projectId)}/chat/sessions`);
      return Array.isArray(data?.sessions) ? data.sessions : [];
    } catch (_) {
      return [];
    }
  }

  // 侧栏要画的是「当前项目」的清单，而清单只会在 resolveMessages 里被拉过。
  // 非 agent 布局启动 / 从别的布局切回 agent 时 resolveMessages 根本没跑过，
  // 侧栏就会一直停在「这个项目还没有会话。」——这里补拉一次。
  function ensureSessionsForCurrentProject() {
    const projectId = state.currentProjectId;
    if (!projectId) return;
    if (sessionsProjectId === projectId) return;
    fetchSessions(projectId).then((sessions) => {
      if (state.currentProjectId !== projectId) return;
      state.chatSessions = sessions;
      sessionsProjectId = projectId;
      renderSidebar();
    });
  }

  // selectProject 在渲染对话前调用：决定这一屏显示哪条会话的消息
  async function resolveMessages(projectId, payload) {
    const remembered = readSessionMap()[projectId] || "";
    const sessions = await fetchSessions(projectId);
    state.chatSessions = sessions;
    sessionsProjectId = projectId;
    // 记住的会话可能已被删了：清单里找不到就退回第一条，再退回项目默认线程
    let target = remembered;
    if (target && !sessions.some((item) => item.session_id === target)) target = "";
    if (!target && sessions.length) target = sessions[0].session_id || "";
    state.chatSessionId = target;
    rememberSession(projectId, target);
    renderSidebar();
    // 空串 = 项目默认单线程：它没有会话壳，GET /chat/sessions/ 会 404，直接用项目自带的消息
    if (!target) return payload?.messages || [];
    try {
      const data = await api(
        `/api/projects/${encodeURIComponent(projectId)}/chat/sessions/${encodeURIComponent(target)}`
      );
      return Array.isArray(data?.messages) ? data.messages : [];
    } catch (_) {
      state.chatSessionId = "";
      rememberSession(projectId, "");
      return payload?.messages || [];
    }
  }

  async function switchSession(sessionId) {
    const projectId = state.currentProjectId;
    if (!projectId) return;
    state.chatSessionId = sessionId || "";
    rememberSession(projectId, state.chatSessionId);
    let messages = [];
    if (state.chatSessionId) {
      try {
        const data = await api(
          `/api/projects/${encodeURIComponent(projectId)}/chat/sessions/${encodeURIComponent(state.chatSessionId)}`
        );
        messages = Array.isArray(data?.messages) ? data.messages : [];
      } catch (_) {
        state.chatSessionId = "";
        rememberSession(projectId, "");
      }
    }
    if (!state.chatSessionId) {
      // 退回项目默认线程：重新拉项目详情拿 messages
      try {
        const data = await api(`/api/projects/${encodeURIComponent(projectId)}`);
        messages = Array.isArray(data?.messages) ? data.messages : [];
      } catch (_) {
        messages = [];
      }
    }
    renderConversationHistory(messages);
    renderSidebar();
  }

  async function createSession(projectId) {
    if (!projectId) return;
    try {
      const data = await api(`/api/projects/${encodeURIComponent(projectId)}/chat/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const created = data?.session?.session_id || "";
      if (Array.isArray(data?.sessions)) {
        state.chatSessions = data.sessions;
        sessionsProjectId = projectId;
      }
      await switchSession(created);
      showToast("已新建会话。");
    } catch (error) {
      showError(error);
    }
  }

  // ---- 会话重命名 / 删除 ----
  let renameTargetId = "";
  let deleteTargetId = "";

  function openRenameDialog(sessionId) {
    renameTargetId = sessionId;
    const input = document.querySelector("#chat-session-rename-input");
    const session = (state.chatSessions || []).find((item) => item.session_id === sessionId);
    if (input) input.value = session?.title || "";
    const dialog = document.querySelector("#chat-session-rename-dialog");
    if (dialog?.showModal) dialog.showModal();
  }

  async function submitRename(event) {
    event.preventDefault();
    const input = document.querySelector("#chat-session-rename-input");
    const title = (input?.value || "").trim();
    const projectId = state.currentProjectId;
    const sessionId = renameTargetId;
    document.querySelector("#chat-session-rename-dialog")?.close();
    if (!projectId || !sessionId || !title) return;
    try {
      const data = await api(
        `/api/projects/${encodeURIComponent(projectId)}/chat/sessions/${encodeURIComponent(sessionId)}`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) }
      );
      if (Array.isArray(data?.sessions)) {
        state.chatSessions = data.sessions;
        sessionsProjectId = projectId;
      }
      renderSidebar();
    } catch (error) {
      showError(error);
    }
  }

  function askDeleteSession(sessionId) {
    deleteTargetId = sessionId;
    const session = (state.chatSessions || []).find((item) => item.session_id === sessionId);
    const nameEl = document.querySelector("#chat-session-delete-name");
    if (nameEl) nameEl.textContent = session?.title || "未命名会话";
    const dialog = document.querySelector("#chat-session-delete-dialog");
    if (dialog?.showModal) dialog.showModal();
  }

  async function submitDeleteSession(event) {
    event.preventDefault();
    const projectId = state.currentProjectId;
    const sessionId = deleteTargetId;
    document.querySelector("#chat-session-delete-dialog")?.close();
    if (!projectId || !sessionId) return;
    try {
      const data = await api(
        `/api/projects/${encodeURIComponent(projectId)}/chat/sessions/${encodeURIComponent(sessionId)}`,
        { method: "DELETE" }
      );
      if (Array.isArray(data?.sessions)) {
        state.chatSessions = data.sessions;
        sessionsProjectId = projectId;
      }
      if ((state.chatSessionId || "") === sessionId) {
        state.chatSessionId = "";
        rememberSession(projectId, "");
        await switchSession("");
      } else {
        renderSidebar();
      }
      showToast("会话已删除。");
    } catch (error) {
      showError(error);
    }
  }

  // ---- 浮层 ----
  function revealStudio() {
    if (!isAgentUi()) return;
    if (state.studioFocus) return;
    if (typeof expandStudio === "function") expandStudio();
  }

  function openSources() {
    if (!isAgentUi()) return;
    document.body.classList.add("agent-sources-open");
    $("#agent-import-button")?.setAttribute("aria-expanded", "true");
  }

  function closeSources() {
    document.body.classList.remove("agent-sources-open");
    $("#agent-import-button")?.setAttribute("aria-expanded", "false");
  }

  function toggleSources() {
    if (document.body.classList.contains("agent-sources-open")) closeSources();
    else openSources();
  }

  // 图标栏高亮和顶栏标题都以 state.feature 为准（见 syncStudioTitle 注释）：
  // 非图标栏路径不会更新 currentFeature。
  function activeFeature() {
    return (hasApp && state.feature) || currentFeature;
  }

  function syncStudioTitle() {
    // 产出浮层顶栏显示当前功能名。图标栏没有文字标签，标题就是唯一提示。
    const title = document.querySelector("#studio-title");
    if (!title) return;
    const label = {
      framework: "知识框架",
      overview: "学习概览",
      cards: "知识卡片",
      quiz: "小测验",
      favorites: "我的笔记",
    }[activeFeature()] || "学习产出";
    if (title.textContent !== label) title.textContent = label;
  }

  function syncRail() {
    const feature = activeFeature();
    document.querySelectorAll("#agent-rail .agent-rail-btn[data-agent-feature]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.agentFeature === feature);
    });
    syncStudioTitle();
  }

  function toggleStudioForFeature(feature) {
    currentFeature = feature;
    // 点内置 5 页中的任意一页都要收起英语词汇视图：它是盖在 .studio-panel 上的兄弟节点。
    // 这里必须自己收一遍 —— 点当前所在功能时下面走的是 collapseStudio 的提前 return，
    // 根本不会进 switchFeature，app.js 里那条会漏掉。
    window.enVocabCloseView?.();
    syncRail();
    if (!isAgentUi()) return;
    // 图标栏的语义就是「点开这个功能」→ 收起浮层时再点同一项应回到对话
    if (state.studioFocus && state.feature === feature && typeof collapseStudio === "function") {
      collapseStudio();
      return;
    }
    switchFeature(feature);
  }

  // ---- 项目/会话侧栏收起（只动 html 上的 class，布局由 agent-layout.css 接管） ----
  function isSessionsHidden() {
    try { return localStorage.getItem(SESSIONS_HIDDEN_KEY) === "on"; }
    catch (_) { return false; }
  }

  function applySessionsHidden() {
    const hidden = isSessionsHidden();
    document.documentElement.classList.toggle("sessions-collapsed", hidden);
    const button = document.querySelector("#agent-sessions-toggle");
    if (!button) return;
    const label = hidden ? "展开项目与会话侧栏" : "收起项目与会话侧栏";
    button.setAttribute("aria-expanded", hidden ? "false" : "true");
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.setAttribute("aria-pressed", hidden ? "true" : "false");
  }

  function toggleSessionsHidden() {
    try { localStorage.setItem(SESSIONS_HIDDEN_KEY, isSessionsHidden() ? "off" : "on"); }
    catch (_) { /* 隐私模式写不进去：本次会话内照样切换 */ }
    applySessionsHidden();
  }

  // ---- 「试试这样问」：拖动 + 右键 + 开关（不改 app.js） ----
  const suggested = {
    enabled() {
      try { return localStorage.getItem(SUGGESTED_ON_KEY) !== "off"; }
      catch (_) { return true; }
    },
    setEnabled(on) {
      try { localStorage.setItem(SUGGESTED_ON_KEY, on ? "on" : "off"); } catch (_) {}
      suggested.apply();
    },
    resetPosition() {
      try { localStorage.removeItem(SUGGESTED_POS_KEY); } catch (_) {}
      suggested.apply();
    },
    apply() {
      const box = document.querySelector("#suggested-questions");
      if (!box) return;
      const shouldShow = isAgentUi() && suggested.enabled();
      box.hidden = !shouldShow;
      if (shouldShow) suggested.applyPosition();
      syncSettingsUI?.();
    },
    applyPosition() {
      const box = document.querySelector("#suggested-questions");
      const panel = document.querySelector(".agent-panel");
      if (!box || !panel) return;
      let saved = null;
      try {
        saved = JSON.parse(localStorage.getItem(SUGGESTED_POS_KEY) || "null");
      } catch (_) {
        saved = null;
      }
      if (!saved || typeof saved.left !== "number" || typeof saved.top !== "number") {
        // 没有已存位置 = 回到 CSS 默认定位（agent 布局是 top:7px; right:12px; left:auto）。
        // ⚠️ 这里必须**清掉拖动留下的 inline left/top/right**（2026-10-05 修的真 bug）：
        // 原来只删了 localStorage 就 return，inline 值一直粘在 style 上把 CSS 默认压住，
        // 于是「恢复默认位置」点了完全没反应，只有刷新页面才复位。
        if (box.style) {
          box.style.left = "";
          box.style.top = "";
          box.style.right = "";
        }
        return;
      }
      const rect = panel.getBoundingClientRect();
      // 夹在主区内，避免拖到窗口外找不回来
      const maxLeft = Math.max(0, rect.width - box.offsetWidth - 8);
      const maxTop = Math.max(0, rect.height - box.offsetHeight - 8);
      box.style.left = `${Math.min(Math.max(0, saved.left), maxLeft)}px`;
      box.style.top = `${Math.min(Math.max(0, saved.top), maxTop)}px`;
      box.style.right = "auto";
    },
    savePosition(left, top) {
      try { localStorage.setItem(SUGGESTED_POS_KEY, JSON.stringify({ left, top })); } catch (_) {}
    },
  };

  function bindSuggestedDrag() {
    const box = document.querySelector("#suggested-questions");
    const head = box?.querySelector(".suggested-questions-head");
    const panel = document.querySelector(".agent-panel");
    if (!box || !head || !panel) return;

    head.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;   // 标题行里的按钮不触发拖动
      if (!isAgentUi()) return;
      event.preventDefault();
      const panelRect = panel.getBoundingClientRect();
      const startLeft = box.offsetLeft;
      const startTop = box.offsetTop;
      let moved = false;
      box.classList.add("is-dragging");
      head.setPointerCapture?.(event.pointerId);

      const onMove = (moveEvent) => {
        // offsetLeft/offsetWidth 是设计像素，指针位移与 panelRect 是视觉像素：先除回设计像素。
        const scale = (window.KnowOriginUiScale && window.KnowOriginUiScale.scale()) || 1;
        const left = startLeft + (moveEvent.clientX - event.clientX) / scale;
        const top = startTop + (moveEvent.clientY - event.clientY) / scale;
        const maxLeft = Math.max(0, panelRect.width / scale - box.offsetWidth - 8);
        const maxTop = Math.max(0, panelRect.height / scale - box.offsetHeight - 8);
        box.style.left = `${Math.min(Math.max(0, left), maxLeft)}px`;
        box.style.top = `${Math.min(Math.max(0, top), maxTop)}px`;
        box.style.right = "auto";
        moved = true;
      };
      const onEnd = () => {
        head.removeEventListener("pointermove", onMove);
        head.removeEventListener("pointerup", onEnd);
        head.removeEventListener("pointercancel", onEnd);
        head.removeEventListener("lostpointercapture", onEnd);
        box.classList.remove("is-dragging");
        if (moved) suggested.savePosition(box.offsetLeft, box.offsetTop);
      };
      head.addEventListener("pointermove", onMove);
      head.addEventListener("pointerup", onEnd);
      head.addEventListener("pointercancel", onEnd);
      head.addEventListener("lostpointercapture", onEnd);
    });

    head.addEventListener("contextmenu", (event) => {
      if (!isAgentUi()) return;
      event.preventDefault();
      openSuggestedMenu(event.clientX, event.clientY);
    });

    window.addEventListener("resize", () => {
      if (isAgentUi()) suggested.applyPosition();
    });
  }

  // 菜单的关闭钩子。用模块级引用存着，closeSuggestedMenu 一并解绑 ——
  // 原来 keydown 监听只在按到 Escape 时才自己摘掉，每开一次菜单泄漏一个。
  let suggestedMenuTeardown = null;

  function openSuggestedMenu(x, y) {
    closeSuggestedMenu();
    const menu = document.createElement("div");
    menu.className = "agent-suggested-menu";
    menu.innerHTML = `
      <button type="button" data-agent-suggested="toggle">${suggested.enabled() ? "不再显示试试这样问" : "显示试试这样问"}</button>
      <div class="agent-suggested-menu-sep"></div>
      <button type="button" data-agent-suggested="reset">恢复默认位置</button>`;
    document.body.append(menu);
    // 贴视口边缘时自动内收。clientX 与 rect 是视觉像素，style.left 是设计像素：先除回界面缩放。
    const scale = (window.KnowOriginUiScale && window.KnowOriginUiScale.scale()) || 1;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x / scale, window.innerWidth / scale - rect.width / scale - 8)}px`;
    menu.style.top = `${Math.min(y / scale, window.innerHeight / scale - rect.height / scale - 8)}px`;
    menu.addEventListener("click", (event) => {
      const action = event.target.closest("[data-agent-suggested]")?.dataset.agentSuggested;
      if (action === "toggle") suggested.setEnabled(!suggested.enabled());
      if (action === "reset") suggested.resetPosition();
      closeSuggestedMenu();
    });
    // ⚠️ 关闭监听必须**跳过菜单内部**（2026-10-05 修的真 bug）：事件顺序是
    // pointerdown → mouseup → click。原来直接 `document.pointerdown → 移除菜单`，
    // 菜单在 click 之前就离开了 DOM，click 派发不到它身上，菜单项的处理器
    // 一次都没跑过 —— 表现为「不再显示试试这样问」点了完全没反应。
    // 顺带用 capture:true：菜单是 body 下的浮层，冒泡阶段可能被别的处理器 stopPropagation 截掉。
    const onPointerDown = (event) => {
      if (event.target && menu.contains(event.target)) return; // 菜单内：留给 click
      closeSuggestedMenu();
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") closeSuggestedMenu();
    };
    // 延到下一轮再装：装早了会把「打开菜单的那一次右键」自己也吃掉，菜单秒关。
    const timer = setTimeout(() => {
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("keydown", onKeyDown, true);
    }, 0);
    suggestedMenuTeardown = () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }

  function closeSuggestedMenu() {
    document.querySelectorAll(".agent-suggested-menu").forEach((node) => node.remove());
    if (suggestedMenuTeardown) {
      suggestedMenuTeardown();
      suggestedMenuTeardown = null;
    }
  }

  // ---- 事件绑定 ----
  function bindRail() {
    document.querySelector("#agent-rail")?.addEventListener("click", (event) => {
      const featureBtn = event.target.closest("[data-agent-feature]");
      if (featureBtn) {
        toggleStudioForFeature(featureBtn.dataset.agentFeature);
        return;
      }
      const moduleBtn = event.target.closest("[data-agent-module]");
      if (moduleBtn) {
        MODULE_OPENERS[moduleBtn.dataset.agentModule]?.();
        return;
      }
      const actionBtn = event.target.closest("[data-agent-action]");
      const action = actionBtn?.dataset.agentAction;
      if (action === "settings") openSettings?.();
      if (action === "literature") enterLiteratureMode?.();
    });
  }

  function bindSessions() {
    $("#agent-sessions-toggle")?.addEventListener("click", toggleSessionsHidden);
    $("#agent-new-session")?.addEventListener("click", () => createSession(state.currentProjectId));
    $("#agent-new-project")?.addEventListener("click", () => {
      closeSources();
      document.querySelector("#new-project-button")?.click();
    });
    $("#agent-open-calendar")?.addEventListener("click", () => {
      window.KnowOriginCalendar?.open?.();
    });

    document.querySelector("#agent-session-list")?.addEventListener("click", async (event) => {
      const toggleBtn = event.target.closest("[data-agent-project-toggle]");
      if (toggleBtn) {
        event.preventDefault();
        event.stopPropagation();
        toggleExpanded(toggleBtn.dataset.agentProjectToggle);
        renderSidebar();
        return;
      }
      const studyDocBtn = event.target.closest("[data-agent-project-study]");
      if (studyDocBtn) {
        event.preventDefault();
        event.stopPropagation();
        // 同上：只读那一份文档，不切换项目
        const bridge = window.KnowOriginStudyDoc;
        if (!bridge || typeof bridge.open !== "function") {
          showToast("学习文档模块没加载（static/study-doc-ui.js），刷新页面后再试。", "error");
          return;
        }
        const row = studyDocBtn.closest(".agent-project-row");
        const name = row?.querySelector(".agent-project-name")?.textContent?.trim() || "";
        bridge.open(studyDocBtn.dataset.agentProjectStudy, name);
        return;
      }
      const docBtn = event.target.closest("[data-agent-project-doc]");
      if (docBtn) {
        event.preventDefault();
        event.stopPropagation();
        // 只读那一份文档，不切换项目 —— 中途切项目会把正在看的会话整屏换掉
        window.KnowOriginKnowledgeDoc?.openCompiled?.(false, docBtn.dataset.agentProjectDoc);
        return;
      }
      const projectSessionPid = event.target.closest("[data-agent-session-project]")?.dataset.agentSessionProject || "";
      if (projectSessionPid && projectSessionPid !== state.currentProjectId) {
        // 展开着别的项目时点它的会话 / ⋯ 菜单：先去那个项目，再照原样处理
        await selectProject?.(projectSessionPid);
        return;
      }
      const menuBtn = event.target.closest("[data-agent-session-menu]");
      if (menuBtn) {
        event.stopPropagation();
        openSessionMenu(menuBtn.dataset.agentSessionMenu, menuBtn);
        return;
      }
      const projectBtn = event.target.closest("[data-agent-project]");
      if (projectBtn) {
        const projectId = projectBtn.dataset.agentProject;
        if (!projectId || projectId === state.currentProjectId) return;
        // 点项目名 = 进这个项目；顺带把它展开，不然进去也看不到会话
        if (!isExpanded(projectId)) {
          toggleExpanded(projectId);
          renderSidebar();
        }
        selectProject?.(projectId);
        return;
      }
      const sessionBtn = event.target.closest("[data-agent-session]");
      if (sessionBtn) switchSession(sessionBtn.dataset.agentSession);
    });

    document.querySelector("#chat-session-rename-form")?.addEventListener("submit", submitRename);
    document.querySelector("#chat-session-delete-form")?.addEventListener("submit", submitDeleteSession);
  }

  // 会话右键/⋯ 菜单：重命名 / 删除。菜单复用 .agent-suggested-menu 的样式（同一份 CSS）。
  function openSessionMenu(sessionId, anchor) {
    closeSessionMenu();
    const rect = anchor.getBoundingClientRect();
    const menu = document.createElement("div");
    menu.className = "agent-suggested-menu";
    menu.innerHTML = `
      <button type="button" data-agent-session-action="rename">重命名会话</button>
      <div class="agent-suggested-menu-sep"></div>
      <button type="button" data-agent-session-action="delete" class="is-danger">删除会话</button>`;
    document.body.append(menu);
    // style.left/top 是设计像素，rect/innerWidth 是视觉像素：先除回界面缩放。
    const sc = (window.KnowOriginUiScale && window.KnowOriginUiScale.scale()) || 1;
    menu.style.left = `${Math.min(rect.left, window.innerWidth / sc - menu.offsetWidth - 8)}px`;
    menu.style.top = `${Math.min(rect.bottom + 4, window.innerHeight / sc - menu.offsetHeight - 8)}px`;
    menu.addEventListener("click", (event) => {
      const action = event.target.closest("[data-agent-session-action]")?.dataset.agentSessionAction;
      closeSessionMenu();
      if (action === "rename") openRenameDialog(sessionId);
      else if (action === "delete") askDeleteSession(sessionId);
    });
    setTimeout(() => document.addEventListener("pointerdown", closeSessionMenu, { once: true }), 0);
  }

  function closeSessionMenu() {
    document.querySelectorAll(".agent-suggested-menu").forEach((node) => {
      if (node.querySelector("[data-agent-session-action]")) node.remove();
    });
  }

  function bindOverlays() {
    $("#agent-import-button")?.addEventListener("click", toggleSources);
    $("#sources-overlay-close")?.addEventListener("click", closeSources);
    $("#settings-suggested-toggle")?.addEventListener("change", (event) => {
      suggested.setEnabled(event.target.checked);
    });
    $("#settings-suggested-reset")?.addEventListener("click", () => {
      suggested.resetPosition();
      showToast("已恢复默认位置。");
    });
  }

  function bindGlobalEvents() {
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (document.querySelector(".agent-suggested-menu")) {
        closeSuggestedMenu();
        return;
      }
      if (document.body.classList.contains("agent-sources-open")) closeSources();
    });

    document.addEventListener("knoworigin:chat-sent", (event) => {
      const projectId = event.detail?.project_id;
      if (!projectId || projectId !== state.currentProjectId) return;
      fetchSessions(projectId).then((sessions) => {
        state.chatSessions = sessions;
        sessionsProjectId = projectId;
        renderSidebar();
      });
    });

    document.addEventListener("knoworigin:project-switched", (event) => {
      const projectId = event.detail?.project_id || "";
      if (projectId !== state.currentProjectId) return;
      // ⚠️ 绝对不能在这里无条件清空 state.chatSessions。
      // selectProject 的顺序是「先 await resolveMessages() 填好清单并重画侧栏，
      // 再派发这个事件」，所以清空会把刚画好的历史会话又抹回
      // 「这个项目还没有会话。」——症状就是「必须点一次新建会话才看得到会话记录」。
      // 只有这份清单确实不属于当前项目（切项目走的是另一次事件，或压根没加载过）才清。
      if (projectId !== sessionsProjectId) state.chatSessions = [];
      renderSidebar();
    });

    document.addEventListener("knoworigin:ui-changed", (event) => {
      // 展开态的浮层是「某一套布局内」的状态，不能跨布局带过去：
      // agent 里 .studio-panel 是栅格内面板（不再整屏 fixed），一旦切过去时还带着
      // body.studio-focus-open，浮层看不见、收起它的入口也点不到，而基础样式
      // body.studio-focus-open{overflow:hidden} 会让整页滚不动 —— 必须刷新才能恢复。
      // 用 finishStudioCollapse 而不是 collapseStudio：后者带动画与守卫，
      // 而这里要的是同步把 DOM / body class / state 一次清干净。
      if (state.studioFocus && typeof finishStudioCollapse === "function") {
        finishStudioCollapse();
      }
      closeSources();
      suggested.apply();
      if (event.detail?.ui === "agent") {
        // 从 academic/classic 切过来时 resolveMessages 一次都没跑过（那是 agent 布局专属路径），
        // 不补拉就会停在空清单上。已有清单则直接返回，不发多余请求。
        ensureSessionsForCurrentProject();
        renderSidebar();
        syncRail();
      }
    });

    // 开关状态由「试试这样问」负责；这里额外把设置里的 checkbox 同步一次
    document.addEventListener("knoworigin:settings-opened", syncSettingsUI);

    // ⚠️ app.js 的 renderSuggestedQuestions() 每次渲染都会把 #suggested-questions 的
    // hidden 摘掉，直接藏不住。用 MutationObserver 按回去 —— 就不必改 app.js。
    const box = document.querySelector("#suggested-questions");
    if (box) {
      new MutationObserver(() => {
        // ⚠️ 必须先判值再写：DOM 规范里 setAttribute 即使值没变也会入队一条 mutation record，
        // 无条件 box.hidden = true 会变成「触发→写回→再触发」的无限微任务循环（真浏览器同样卡死）。
        if ((!isAgentUi() || !suggested.enabled()) && !box.hidden) box.hidden = true;
      }).observe(box, { attributes: true, attributeFilter: ["hidden"] });
    }
  }

  function syncSettingsUI() {
    const toggle = document.querySelector("#settings-suggested-toggle");
    if (toggle) toggle.checked = suggested.enabled();
  }

  function syncCalendarEntry() {
    const streakEl = document.querySelector("#streak-badge");
    const entry = document.querySelector("#agent-calendar-streak");
    if (!streakEl || !entry) return;
    const text = (streakEl.textContent || "").trim();
    entry.textContent = text || "0";
    entry.hidden = !text;
  }

  function bindCalendar() {
    $("#agent-open-calendar")?.addEventListener("click", () => {
      window.KnowOriginCalendar?.open?.();
    });
    const badge = document.querySelector("#streak-badge");
    if (badge) {
      new MutationObserver(syncCalendarEntry).observe(badge, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
  }

  // ---- 启动 ----
  function boot() {
    // ⚠️ 这层壳子整块哑掉时症状是「界面永远加载中」，而服务端日志一切正常，很难查。
    // 所以失败一律往报错条上写明原因，别只 console.warn。
    try {
      bootInner();
    } catch (error) {
      console.error("[KnowOriginAgentShell] 启动失败", error);
      showError?.(new Error(`Agent 工作台外壳启动失败：${error?.message || error}`));
    }
  }

  function bootInner() {
    if (!hasApp) {
      // 最常见的原因：Service Worker 还在发旧的 app.js（它早于本文件加载，state 还不存在）。
      const hint = "Agent 工作台外壳未启动：app.js 可能没加载成功（若是刚改过前端，清一次浏览器缓存试试）。";
      console.warn(`[KnowOriginAgentShell] ${hint}`);
      showError?.(new Error(hint));
      return;
    }
    // ⚠️ 事件必须**无条件**绑定。布局能在设置里随时切过来，而「切到 agent 时立刻可用」
    // 全靠 knoworigin:ui-changed 这一个监听。曾经在这里判一下 !isAgentUi() 就 return，
    // 于是默认布局（academic）启动时下面 6 个 bind 一个都没跑：切到 agent 后图标栏、
    // 会话侧栏、项目资料浮层、「试试这样问」全部无响应 —— 界面看着在、点什么都没反应，
    // 只有刷新（此时 localStorage 已是 agent，走完整分支）才能恢复。
    // 另两套布局下这些节点被 CSS 藏起来了，绑了也不会误触发。
    bindRail();
    bindSessions();
    bindOverlays();
    bindGlobalEvents();
    bindCalendar();
    bindSuggestedDrag();
    // 以下只是「把当前状态画出来」，与布局无关，绑完就画一次。
    renderSidebar();
    syncCalendarEntry();
    syncSettingsUI();
    applySessionsHidden();
    suggested.apply();
    // syncRail 会改写 #studio-title，那是 academic/classic 里真实的产出标题，只在 agent 下动。
    if (isAgentUi()) syncRail();
  }

  window.KnowOriginAgentShell = {
    resolveMessages,
    revealStudio,
    renderSidebar,
    syncRail,
    syncSessionMenu,
    closeSources,
    openSources,
    isAgentUi,
    sessions: { isHidden: isSessionsHidden, apply: applySessionsHidden, toggle: toggleSessionsHidden },
    suggested,
    boot,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();