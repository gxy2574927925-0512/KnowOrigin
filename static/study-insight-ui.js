/**
 * 学情洞察 —— 「学习台历」右侧侧栏里的一块（在冲刺计划卡下方）。
 *
 * 只做一件事：**一页速查表 / 学习路径** —— 考前与入门时最需要、而知源别处没有的两样东西。
 * （教学模式两档常驻在**聊天输入框旁**切换，卡片内不占用版面；资料矛盾已移除。）
 *
 * 2026-09-26 三次调整：速查表 / 学习路径搬到「学习台历」左栏的课程工作台
 *   （study-desk-ui.js）—— 它们本来就该按课程组织，挂在学情洞察里既不按课分、
 *   也和冲刺计划连不上。台历右栏现在只留考期备忘一张卡，本卡的挂载点
 *   （#streak-side-insight）随之停用；教学模式开关仍在输入框旁，不受影响。
 *
 * 2026-09-26 改造：从「学习概览」整块搬到学习台历侧栏，与冲刺计划同屏。
 * 2026-09-26 二次瘦身：删掉「掌握度对照（加权分 vs BKT）」tab —— 它与知识框架里的
 *   节点掌握度、以及冲刺计划排期时对掌握度的用法高度重叠，边际价值低；而且在 344px
 *   侧栏里内容一长就被挤到折叠线以下，用户得自己往下滚才看得见。留下的速查表/路径
 *   是独有的，卡片也因此变矮，一屏能看全。
 *
 * 约定（与本项目其它叠加层一致）：
 *   - 不碰 app.js / styles.css；样式全部自带，删掉 index.html 那一行脚本即完全回退。
 *   - 挂载点由 streak.js 提供（#streak-side-insight 插槽），本模块只往插槽里塞自己的卡片。
 *   - 卡片内容是整块 innerHTML 重渲染，所以展开状态一律存进 view 状态，
 *     不直接改 DOM —— 否则任何一次 render() 都会把它冲掉。
 */
(function () {
  "use strict";

  var STYLE_ID = "ko-insight-style";
  var VIEW_ID = "ko-insight-view";
  var CARD_ATTR = "data-ko-it-embed";

  var API = { teaching: "/api/teaching-mode" };

  // 后端 /api/teaching-mode 拿不到时的兜底（短名给输入框旁那个紧凑开关用）。
  // hint 必须与 core/teaching_mode.py 的 MODE_HINTS 保持一致 —— 说具体承诺，
  // 而不是"只给方法"这种看不出差别的话。
  var MODES_FALLBACK = [
    { value: "direct", label: "直接回答", short: "直接", hint: "AI 正常作答，保持既有体验。" },
    { value: "guided", label: "引导模式", short: "引导", hint: "先给关键概念和「去哪看」，答案留给你；你卡一次就放开一级，连卡两轮才直接给结论。" },
  ];

  var view = {
    loading: false,
    error: "",        // 读取失败（全局）
    actionError: "",  // 生成失败（就地显示在对应卡片里）
    loaded: false,
    projectId: "",
    // 教学模式（供输入框旁开关使用，卡片内不占用版面）
    mode: "direct",
    modes: [],
    modeHint: "",
    modeLoaded: false,
    modeLoading: false,
    // 速查表 / 学习路径
    kits: [],
    kitKinds: [],
    kitBusy: "",
    openKit: "",
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

  function currentProjectId() {
    try {
      if (typeof state !== "undefined" && state && state.currentProjectId) {
        return state.currentProjectId;
      }
    } catch (error) {
      /* state 还没初始化 */
    }
    return "";
  }

  function call(path, options) {
    var opts = options || {};
    var init = { method: opts.method || "GET" };
    if (opts.body !== undefined && opts.body !== null) {
      init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
      init.headers = { "Content-Type": "application/json" };
    }
    if (typeof api === "function") return api(path, init);
    return fetch(path, Object.assign({ credentials: "same-origin" }, init)).then(function (r) {
      return r.json().catch(function () {
        return {};
      });
    });
  }

  /**
   * 极简 Markdown 渲染 —— **先转义再套标签**，顺序不能反。
   * 模型输出的正文一律当不可信文本处理，只认这几种结构；
   * 表格按行识别，识别失败就退化成普通段落，不猜。
   */
  function renderMarkdown(source) {
    var lines = esc(source || "").split(/\r?\n/);
    var out = [];
    var inTable = false;
    var inList = false;

    function closeBlocks() {
      if (inTable) {
        out.push("</tbody></table>");
        inTable = false;
      }
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
    }

    function inline(text) {
      return text
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/`([^`]+)`/g, "<code>$1</code>");
    }

    lines.forEach(function (raw) {
      var line = raw.replace(/\s+$/, "");
      if (/^\s*\|.*\|\s*$/.test(line)) {
        if (/^[\s|:-]+$/.test(line)) return; // 分隔行
        if (inList) {
          out.push("</ul>");
          inList = false;
        }
        var cells = line.trim().replace(/^\||\|$/g, "").split("|");
        if (!inTable) {
          out.push('<table class="ko-it-table"><tbody>');
          inTable = true;
        }
        out.push(
          "<tr>" +
            cells
              .map(function (cell) {
                return "<td>" + inline(cell.trim()) + "</td>";
              })
              .join("") +
            "</tr>"
        );
        return;
      }
      if (inTable) {
        out.push("</tbody></table>");
        inTable = false;
      }
      if (/^#{1,6}\s+/.test(line)) {
        if (inList) {
          out.push("</ul>");
          inList = false;
        }
        out.push("<h4>" + inline(line.replace(/^#{1,6}\s+/, "")) + "</h4>");
      } else if (/^\s*[-*]\s+/.test(line)) {
        if (!inList) {
          out.push("<ul>");
          inList = true;
        }
        out.push("<li>" + inline(line.replace(/^\s*[-*]\s+/, "")) + "</li>");
      } else if (!line.trim()) {
        if (inList) {
          out.push("</ul>");
          inList = false;
        }
      } else {
        if (inList) {
          out.push("</ul>");
          inList = false;
        }
        out.push("<p>" + inline(line) + "</p>");
      }
    });
    closeBlocks();
    return out.join("\n");
  }

  // ---------------------------------------------------------------- 样式 --

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      // —— 容器：现在住在台历侧栏里，不再是概览页的 .overview-panel，
      //    所以边框/圆角/背景自己给，视觉与同侧栏的「冲刺计划」卡保持一致。 ——
      "#" + VIEW_ID + "{min-width:0;border:1px solid var(--line);border-radius:12px;",
      "background:var(--panel);padding:14px;display:grid;gap:10px}",
      // 标题行：与侧栏其它卡的小标题同一套观感
      "#" + VIEW_ID + " .ko-it-head-title{display:flex;align-items:center;gap:6px;",
      "font-size:calc(14px * var(--font-scale, 1));font-weight:700;color:var(--ink)}",
      "#" + VIEW_ID + " .ko-it-head-sub{margin:4px 0 0;font-size:calc(11.5px * var(--font-scale, 1));color:var(--muted);line-height:1.5}",
      // 正文不自带滚动：整条侧栏（.streak-calendar-side）统一滚
      "#" + VIEW_ID + " .ko-it-body{min-width:0}",
      // —— 卡片 ——
      "#" + VIEW_ID + " .ko-it-card{border:1px solid var(--line);border-radius:12px;",
      "padding:12px 13px;margin-bottom:12px}",
      "#" + VIEW_ID + " .ko-it-card h4{margin:0 0 8px;font-size:calc(13px * var(--font-scale, 1));font-weight:500;color:var(--ink)}",
      // —— 按钮 ——
      "#" + VIEW_ID + " .ko-it-btn{border:1px solid var(--line);background:transparent;",
      "color:var(--ink);padding:5px 10px;border-radius:8px;cursor:pointer;font-size:calc(12px * var(--font-scale, 1));",
      "font-family:inherit}",
      "#" + VIEW_ID + " .ko-it-btn[disabled]{opacity:.55;cursor:default}",
      "#" + VIEW_ID + " .ko-it-btn.primary{background:var(--green);border-color:var(--green);color:#0e1410}",
      "#" + VIEW_ID + " .ko-it-actions{display:flex;gap:6px;flex-wrap:wrap}",
      // —— Markdown 正文 ——
      "#" + VIEW_ID + " .ko-it-md{border:1px solid var(--line);border-radius:10px;",
      "padding:9px 11px;margin-top:9px;max-height:320px;overflow:auto}",
      "#" + VIEW_ID + " .ko-it-md h4{margin:10px 0 5px;font-size:calc(12.5px * var(--font-scale, 1));font-weight:500;color:var(--ink)}",
      "#" + VIEW_ID + " .ko-it-md p{margin:5px 0;color:var(--ink);font-size:calc(12px * var(--font-scale, 1));line-height:1.7}",
      "#" + VIEW_ID + " .ko-it-md ul{margin:5px 0;padding-left:16px}",
      "#" + VIEW_ID + " .ko-it-md li{margin:3px 0;color:var(--ink);font-size:calc(12px * var(--font-scale, 1));line-height:1.7}",
      "#" + VIEW_ID + " .ko-it-md code{font-size:calc(11.5px * var(--font-scale, 1));color:var(--gold)}",
      // —— 表格：窄容器下靠横向滚动，不撑破布局 ——
      "#" + VIEW_ID + " .ko-it-tablewrap{overflow-x:auto}",
      "#" + VIEW_ID + " table.ko-it-table{width:100%;border-collapse:collapse;font-size:calc(11.5px * var(--font-scale, 1))}",
      "#" + VIEW_ID + " table.ko-it-table td{border-bottom:1px solid var(--line);",
      "padding:5px 6px;color:var(--ink);vertical-align:top}",
      // —— 提示行 ——
      "#" + VIEW_ID + " .ko-it-msg{color:var(--muted);font-size:calc(12px * var(--font-scale, 1));padding:10px 0;line-height:1.7}",
      "#" + VIEW_ID + " .ko-it-msg.err{color:var(--red)}",
      // 速查表条目上的类型小标（一页速查表 / 学习路径）
      "#" + VIEW_ID + " .ko-it-tag{display:inline-block;border:1px solid var(--line);",
      "border-radius:999px;padding:1px 7px;font-size:calc(10.5px * var(--font-scale, 1));color:var(--muted);margin:2px 3px 0 0}",
      "#" + VIEW_ID + " .ko-it-row{display:flex;justify-content:space-between;",
      "align-items:center;gap:8px;flex-wrap:wrap}",
      // —— 输入框旁边的紧凑教学模式开关 ——
      ".ko-tm{display:flex;align-items:center;gap:6px;height:28px;box-sizing:border-box}",
      ".ko-tm-label{font-size:calc(11.5px * var(--font-scale, 1));color:var(--muted);white-space:nowrap}",
      ".ko-tm-seg{display:flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}",
      ".ko-tm-btn{border:0;border-right:1px solid var(--line);background:transparent;",
      "color:var(--muted);padding:3px 9px;font-size:calc(11.5px * var(--font-scale, 1));cursor:pointer;",
      "font-family:inherit;white-space:nowrap}",
      ".ko-tm-btn:last-child{border-right:0}",
      ".ko-tm-btn:hover{color:var(--ink)}",
      ".ko-tm-btn.is-on{background:var(--green);color:#0e1410}",
    ].join("");
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------- 挂载 --
  // 台历侧栏的插槽由 streak.js 提供，只在「打开台历」时调用一次；
  // 但 mountSidebar 仍写成可反复调用（重复调用是廉价 no-op），
  // 这样以后换挂载点、或侧栏重建，都不用改这里。

  function mountSidebar(slot) {
    if (!slot) return false;
    var card = document.getElementById(VIEW_ID);
    if (card && slot.contains(card)) {
      syncProject();
      return true;
    }
    card = document.createElement("section");
    card.id = VIEW_ID;
    card.className = "ko-it-embed";
    card.setAttribute(CARD_ATTR, "1");
    slot.appendChild(card);
    render();
    bindView();
    syncProject();
    return true;
  }

  /** 项目变了才重新取数；同一项目内重复打开台历，沿用已有数据直接渲染。 */
  function syncProject() {
    var projectId = currentProjectId();
    if (view.loaded && view.projectId === projectId) return;
    view.projectId = projectId;
    view.loaded = false;
    view.error = "";
    view.actionError = "";
    render();
    loadAll();
  }

  // ---------------------------------------------------------------- 加载 --

  function loadAll() {
    if (view.loading) return Promise.resolve();
    view.loading = true;
    view.error = "";

    var projectId = currentProjectId();
    var jobs = [
      call(API.teaching).catch(function () {
        return null;
      }),
      call("/api/projects/" + encodeURIComponent(projectId) + "/study-kit").catch(function () {
        return null;
      }),
    ];

    return Promise.all(jobs)
      .then(function (results) {
        var teaching = results[0];
        if (teaching && teaching.mode) {
          view.mode = teaching.mode;
          view.modes = teaching.modes || [];
          view.modeHint = teaching.hint || "";
          view.modeLoaded = true;
          renderComposerControl();
        }
        var kit = results[1];
        if (kit) {
          view.kits = kit.kits || [];
          view.kitKinds = kit.kinds || [];
          if (view.kits.length && !view.openKit) view.openKit = view.kits[0].kind;
        }
        view.loaded = true;
        if (!projectId) view.error = "还没有选中课程。先打开一门课，再看学情洞察。";
      })
      .catch(function (error) {
        view.error = (error && error.message) || "没能读到学情数据，请稍后重试。";
      })
      .finally(function () {
        view.loading = false;
        render();
      });
  }

  function setMode(mode) {
    // 只有在"确实取到过真实档位、且点的就是当前档"时才跳过 ——
    // 否则（未加载完就点）会静默什么都不做，用户看到的就是"点了没反应"。
    if (view.modeLoaded && view.mode === mode) return;
    var previous = view.mode;
    view.mode = mode;              // 乐观更新：开关要立刻反映点击，别等网络
    view.modeLoaded = true;
    view.actionError = "";
    renderComposerControl();
    call(API.teaching, { method: "PUT", body: { mode: mode } })
      .then(function (data) {
        view.mode = data.mode || mode;
        view.modes = data.modes || view.modes;
        view.modeHint = data.hint || "";
      })
      .catch(function (error) {
        view.mode = previous;      // 失败就退回原档，并说清原因
        view.actionError = (error && error.message) || "切换教学模式失败，请稍后重试。";
      })
      .finally(function () {
        renderComposerControl();
      });
  }

  /**
   * 生成期间在按钮上显示已等待秒数 —— 一次模型调用可能要几十秒，
   * 只写"生成中…"用户会以为卡死。这里直接改按钮文案（不写进 view：
   * 它是纯瞬时展示，任何一次 render() 都会按 kitBusy 重新算）。
   */
  function startTicker(selector, label) {
    var started = Date.now();
    return setInterval(function () {
      var button = document.querySelector(selector);
      if (!button) return;
      button.textContent = label + " " + Math.round((Date.now() - started) / 1000) + "s";
    }, 1000);
  }

  function generateKit(kind) {
    var projectId = currentProjectId();
    if (!projectId || view.kitBusy) return;
    view.kitBusy = kind;
    view.actionError = "";
    render();
    var ticker = startTicker('[data-ko-it-gen="' + kind + '"]', "生成中");
    call("/api/projects/" + encodeURIComponent(projectId) + "/study-kit/generate", {
      method: "POST",
      body: { kind: kind },
    })
      .then(function (data) {
        var kit = data.kit;
        view.kits = [kit].concat(
          (view.kits || []).filter(function (item) {
            return item.kind !== kit.kind;
          })
        );
        view.kitKinds = data.kinds || view.kitKinds;
        view.openKit = kit.kind;
      })
      .catch(function (error) {
        view.actionError = (error && error.message) || "生成失败，请稍后重试。";
      })
      .finally(function () {
        clearInterval(ticker);
        view.kitBusy = "";
        render();
      });
  }


  // ------------------------------------------------- 输入框旁的教学模式开关 --

  // 直接持有 seg 节点，不去全局 querySelector：宿主被 app.js 整体替换时这里会被重置。
  var composerSeg = null;

  function ensureComposerControl() {
    var host = document.querySelector(".composer-tools");
    if (!host) {
      composerSeg = null;
      return;
    }
    var wrap = host.querySelector("[data-ko-tm-entry]");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "ko-tm";
      wrap.setAttribute("data-ko-tm-entry", "1");
      var label = document.createElement("span");
      label.className = "ko-tm-label";
      label.textContent = "教学模式";
      wrap.appendChild(label);
      host.appendChild(wrap);
    }
    // 每次都重新取一次 seg：宿主可能被整体替换过，旧引用会脱离文档。
    composerSeg = wrap.querySelector("[data-ko-tm-seg]");
    if (!composerSeg) {
      composerSeg = document.createElement("span");
      composerSeg.className = "ko-tm-seg";
      composerSeg.setAttribute("data-ko-tm-seg", "1");
      wrap.appendChild(composerSeg);
    }
    // 输入框是在**登录之后**才出现的，而档位在页面加载时就取过一次（那次必然 401）。
    // 所以这里补一次：什么时候出现输入框，就什么时候把真实档位拿回来。
    if (!view.modeLoaded) loadTeachingMode();
    renderComposerControl();
  }

  // 已渲染内容的签名（档位集合 + 当前档位）。内容没变就不重建 DOM ——
  // 重建本身就是一次 DOM 变化，会再次触发 watchComposer 的 MutationObserver，
  // 而它的回调又会调用 ensureComposerControl()。登录页上 .composer-tools 虽然在
  // DOM 里（只是被 #workspace 的 hidden 藏起来），于是这个环会以 ~300ms 的节奏
  // 永远转下去：每轮都请求一次 /api/teaching-mode，401 又让 app.js 切回登录视图、
  // 把焦点抢回邮箱框，用户根本没法在密码框里连续输入。签名一致就早退，环自然断开。
  var composerSig = "";

  /**
   * 用真实 DOM 节点拼按钮，而不是拼 HTML 字符串 ——
   * 这样"当前档位"这类状态不需要重新解析字符串就能被断言，也不会引入 HTML 注入面。
   */
  function renderComposerControl() {
    if (!composerSeg) return;
    var list = view.modes.length ? view.modes : MODES_FALLBACK;
    var sig = JSON.stringify([
      view.mode,
      list.map(function (item) {
        return [item.value, item.short || "", item.label || "", item.hint || ""];
      }),
    ]);
    if (sig === composerSig && composerSeg.firstChild) return;
    composerSig = sig;
    while (composerSeg.firstChild) composerSeg.removeChild(composerSeg.firstChild);
    list.forEach(function (item) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "ko-tm-btn" + (view.mode === item.value ? " is-on" : "");
      button.setAttribute("data-ko-tm-mode", item.value);
      button.setAttribute("title", item.label + "：" + (item.hint || ""));
      button.textContent = item.short || item.label;
      composerSeg.appendChild(button);
    });
  }

  function bindComposer() {
    var host = document.querySelector(".composer-tools");
    if (!host || host.getAttribute("data-ko-tm-bound") === "1") return;
    host.setAttribute("data-ko-tm-bound", "1");
    host.addEventListener("click", function (event) {
      var target = event.target;
      if (!target || typeof target.closest !== "function") return;
      var button = target.closest("[data-ko-tm-mode]");
      if (button) {
        event.preventDefault();
        setMode(button.getAttribute("data-ko-tm-mode"));
      }
    });
  }

  /** 单独取一次档位，让输入框旁的开关显示**服务端真实生效**的那一档。 */
  function loadTeachingMode() {
    // 未登录时别请求：必然 401，而 app.js 的 401 处理会切回登录视图并把焦点
    // 抢回邮箱框（见 renderComposerControl 上方注释）。登录后输入框宿主出现，
    // watchComposer 会再触发一次，那时 state.authenticated 已为 true，才真正取档位。
    if (typeof state === "undefined" || !state || !state.authenticated) return Promise.resolve();
    if (view.modeLoading) return Promise.resolve();
    view.modeLoading = true;
    return call(API.teaching)
      .then(function (data) {
        if (!data || !data.mode) return;
        view.mode = data.mode;
        view.modes = data.modes || [];
        view.modeHint = data.hint || "";
        view.modeLoaded = true;
      })
      .catch(function () {
        /* 未登录 / 网络失败：保持未加载状态，等下一次 DOM 变化再试 */
      })
      .finally(function () {
        view.modeLoading = false;
        renderComposerControl();
      });
  }

  function renderKits() {
    var kinds = view.kitKinds.length
      ? view.kitKinds
      : [
          { value: "cheatsheet", label: "一页速查表", hint: "考前用。" },
          { value: "learning_path", label: "学习路径", hint: "入门和收尾时用。" },
        ];
    var buttons = kinds
      .map(function (item) {
        var busy = view.kitBusy === item.value;
        return (
          '<button type="button" class="ko-it-btn' + (busy ? "" : " primary") +
          '" data-ko-it-gen="' + esc(item.value) + '"' +
          (view.kitBusy ? " disabled" : "") + ' title="' + esc(item.hint || "") + '">' +
          (busy ? "生成中…" : "生成" + esc(item.label)) +
          "</button>"
        );
      })
      .join("");

    var body;
    if (!view.kits.length) {
      body = '<div class="ko-it-msg">还没有生成过。<br>速查表把整章压成一页可打印的对照表；' +
        "学习路径给出前置知识、下一步方向和可推断的资源。</div>";
    } else {
      body = view.kits
        .map(function (kit) {
          var open = view.openKit === kit.kind;
          return (
            '<div class="ko-it-row" style="margin-top:10px">' +
            "<div><b>" + esc(kit.title || kit.kind_label) + "</b> " +
            '<span class="ko-it-tag">' + esc(kit.kind_label || kit.kind) + "</span></div>" +
            '<button type="button" class="ko-it-btn" data-ko-it-toggle="' + esc(kit.kind) + '">' +
            (open ? "收起" : "展开") +
            "</button>" +
            "</div>" +
            (open
              ? '<div class="ko-it-md">' + renderMarkdown(kit.content_md) + "</div>"
              : "")
          );
        })
        .join("");
    }

    return (
      '<div class="ko-it-card">' +
      "<h4>速查表与学习路径</h4>" +
      '<div class="ko-it-actions">' + buttons + "</div>" +
      (view.actionError ? '<div class="ko-it-msg err">' + esc(view.actionError) + "</div>" : "") +
      body +
      "</div>"
    );
  }

  function render() {
    var node = document.getElementById(VIEW_ID);
    if (!node) return;

    var content = "";
    if (view.error) content += '<div class="ko-it-msg err">' + esc(view.error) + "</div>";
    else if (!view.loaded) content += '<div class="ko-it-msg">正在读取…</div>';
    content += renderKits();

    node.innerHTML =
      '<div class="ko-it-head">' +
      '<div class="ko-it-head-title"><span>🧭</span><span>学情洞察</span></div>' +
      '<p class="ko-it-head-sub">把整章压成一页速查表，并理出前置知识与下一步的学习路径</p>' +
      "</div>" +
      '<div class="ko-it-body">' + content +
      (view.loading ? '<div class="ko-it-msg">加载中…</div>' : "") +
      "</div>";
    // 清单报告渲染后，给每条知识点补「问海小棠」入口（能力由海小棠桌宠模块提供）
    if (window.HXT_PET && typeof window.HXT_PET.enhanceChecklistItems === "function") {
      window.HXT_PET.enhanceChecklistItems(node);
    }
  }

  function bindView() {
    var node = document.getElementById(VIEW_ID);
    if (!node || node.getAttribute("data-ko-it-bound") === "1") return;
    node.setAttribute("data-ko-it-bound", "1");
    // 事件委托挂在容器上，且容器只创建一次 —— innerHTML 重渲染不会丢监听。
    node.addEventListener("click", function (event) {
      var target = event.target;
      if (!target || typeof target.closest !== "function") return;
      var gen = target.closest("[data-ko-it-gen]");
      if (gen) {
        generateKit(gen.getAttribute("data-ko-it-gen"));
        return;
      }
      var toggle = target.closest("[data-ko-it-toggle]");
      if (toggle) {
        // 展开状态存进 view，不能直接改 DOM —— render() 会整块重建。
        var kind = toggle.getAttribute("data-ko-it-toggle");
        view.openKit = view.openKit === kind ? "" : kind;
        render();
        return;
      }
    });
  }

  function boot() {
    ensureStyle();
    // 卡片不再自挂载 —— 挂载点由台历侧栏在打开时通过 mountSidebar() 提供。
    // 输入框旁的模式开关：无项目时 #composer 不存在，所以这里只是"有就挂上"，
    // 真正的重试交给 watchComposer 的 DOM 观察。
    ensureComposerControl();
    bindComposer();
  }

  /**
   * `.composer-tools` 只在**打开项目后**才存在（无项目时整个 composer 都不渲染），
   * 而 `state.currentProjectId` 随时可能变。用 DOM 观察 + 防抖，比轮询干净：
   * `ensureComposerControl` 自带存在性判断，重复调用是廉价的 no-op。
   */
  function watchComposer() {
    if (typeof MutationObserver !== "function" || !document.body) return;
    var pending = false;
    var observer = new MutationObserver(function () {
      if (pending) return;
      pending = true;
      setTimeout(function () {
        pending = false;
        ensureComposerControl();
        bindComposer();
      }, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // 输入框是登录后才渲染的，启动时可能还没有；稍后再补一次挂载。
  document.addEventListener("DOMContentLoaded", function () {
    setTimeout(boot, 600);
  });
  setTimeout(boot, 2000);
  watchComposer();
  loadTeachingMode();

  // 登录成功后立刻取一次真实档位：桌宠模块已在用这个广播，比只等 DOM 观察更确定。
  document.addEventListener("knoworigin:pet-login", function () {
    if (!view.modeLoaded) loadTeachingMode();
  });

  window.KnowOriginInsight = { mountSidebar: mountSidebar, refresh: loadAll, _view: view };
})();
