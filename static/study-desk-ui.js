/* ==========================================================================
   知源（KnowOrigin）· 课程工作台 —— 「学习台历」左栏导航 + 中栏课程页

   2026-09-26 新增。台历原本是「月历 + 右侧三张卡」，课程维度完全没有落点：
   速查表和学习路径（core/study_kit.py 早就有了）一直挤在学情洞察卡里，
   既不按课程组织，也没有和冲刺计划连起来。这一版按课程把它们摊开：

     左栏   学习台历 / 每门课程（下面挂「速查表」「学习路径」两页）
     中栏   课程页：一页速查表或学习路径的正文 + 「按此路径制定冲刺计划」
     右栏   考期备忘（唯一一张卡，固定参照）

   一条动线：选课程 → 看学习路径 → 选节奏 → 台历上点某天看那天的安排。

   与相邻模块的契约（只走全局命名空间 + CustomEvent，不直接依赖内部实现）：
   - window.KnowOriginCalendar.setView('calendar' | 'desk')   中栏视图切换（streak.js）
   - window.KnowOriginSprint.generate(params)                 按当前路径生成冲刺计划
   - 课程列表直接读全局 state.projects（与顶部项目切换器同一份数据）

   约定（与本项目其它叠加层一致）：
   - 不碰 app.js / styles.css；样式全部自带，删掉 index.html 那一行脚本即完全回退。
   - 容器是整块 innerHTML 重渲染，所以选中/展开状态一律存进 VM，不直接改 DOM。
   ========================================================================== */

(function () {
  "use strict";

  const STYLE_ID = "ko-desk-style";

  const VM = {
    rail: null,
    view: null,
    mode: "calendar",      // calendar | course（中栏当前显示哪一个）
    openCourse: null,      // 左栏手风琴展开的课程（null = 还没手动选过，默认跟当前项目）
    course: "",            // 当前查看的课程 project_id
    kind: "cheatsheet",    // 当前查看的页：cheatsheet | learning_path | checklist
    kits: {},              // pid -> { kind: kit }
    kitLoading: {},        // pid -> bool
    busyKeys: {},          // "pid:kind" -> true 正在生成；三个 kind 互不阻塞，可并行生成
    error: "",
  };

  const KINDS = [
    {
      value: "cheatsheet",
      icon: "📋",
      label: "一页速查表",
      hint: "把整章压成一页可打印的对照表，考前用它过一遍。",
    },
    {
      value: "learning_path",
      icon: "🗺",
      label: "学习路径",
      hint: "前置知识 + 下一步学什么 + 推荐资源，据此排冲刺节奏。",
    },
    {
      value: "checklist",
      icon: "✅",
      label: "清单报告",
      hint: "按掌握度分组的可勾选复习清单，逐项打勾、扫尾用。",
    },
  ];

  // 三档只是「周期 × 每日投入」的快捷填充；目标分的精细自定义在「当日计划」的创建表单里。
  // 名字刻意短 —— 周期与时长由按钮第二行给出，不再各写一句形容词。
  const SPRINT_PRESETS = [
    { mode: "rescue", days: 3, hours: 2.5, icon: "⚡", name: "抢救", hint: "只抓最高频考点，快速拉过线" },
    { mode: "sprint", days: 7, hours: 2.0, icon: "🎯", name: "冲刺", hint: "三阶段稳步推进" },
    { mode: "mastery", days: 14, hours: 1.5, icon: "🏆", name: "攻坚", hint: "扫清全部盲区" },
  ];

  function kindMeta(value) {
    return KINDS.find((k) => k.value === value) || KINDS[0];
  }

  // ---------------------------------------------------------------- 样式 --

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      // —— 左栏导航 ——
      ".ko-rail{display:grid;align-content:start;gap:12px}",
      ".ko-rail-group{display:grid;gap:4px}",
      ".ko-rail-title{font-size:calc(10.5px * var(--font-scale, 1));letter-spacing:.08em;color:var(--muted);",
      "text-transform:uppercase;padding:0 6px 2px}",
      ".ko-rail-item{display:flex;align-items:center;gap:7px;width:100%;text-align:left;",
      "border:1px solid transparent;background:transparent;color:var(--ink);border-radius:9px;",
      "padding:7px 9px;font-size:calc(12.5px * var(--font-scale, 1));font-family:inherit;cursor:pointer;",
      "transition:background .15s ease,border-color .15s ease}",
      ".ko-rail-item:hover{background:var(--sidebar)}",
      ".ko-rail-item.is-on{background:var(--green-soft);border-color:var(--green);",
      "color:var(--green-dark);font-weight:600}",
      ".ko-rail-item-icon{font-size:calc(13px * var(--font-scale, 1));line-height:1}",
      // 课程行：标题 + 右侧考期角标；展开后下面挂两页
      ".ko-rail-course{display:grid;gap:2px}",
      ".ko-rail-course-head{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:7px;",
      "border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:10px;",
      "padding:7px 9px;cursor:pointer;font-family:inherit;font-size:calc(12.5px * var(--font-scale, 1));text-align:left;",
      "transition:border-color .15s ease,background .15s ease}",
      ".ko-rail-course-head:hover{border-color:var(--green)}",
      ".ko-rail-course.is-open .ko-rail-course-head{border-color:var(--green);",
      "background:var(--green-soft);color:var(--green-dark)}",
      ".ko-rail-course.is-cur .ko-rail-course-head{border-left:3px solid var(--green)}",
      ".ko-rail-course-caret{font-size:calc(9px * var(--font-scale, 1));color:var(--muted);transition:transform .15s ease}",
      ".ko-rail-course.is-open .ko-rail-course-caret{transform:rotate(90deg)}",
      ".ko-rail-course-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".ko-rail-course-days{font-size:calc(10.5px * var(--font-scale, 1));color:var(--muted);white-space:nowrap;",
      "font-variant-numeric:tabular-nums}",
      ".ko-rail-course.is-urgent .ko-rail-course-days{color:var(--red);font-weight:600}",
      ".ko-rail-sub{display:none;grid-template-columns:1fr;gap:2px;padding:2px 0 2px 14px}",
      ".ko-rail-course.is-open .ko-rail-sub{display:grid}",
      ".ko-rail-sub .ko-rail-item{font-size:calc(12px * var(--font-scale, 1));padding:5px 9px}",
      ".ko-rail-sub .ko-rail-item.is-on{background:var(--green);color:#0e1410}",
      ".ko-rail-dot{margin-left:auto;font-size:calc(10px * var(--font-scale, 1));color:var(--muted)}",
      ".ko-rail-empty{margin:0;padding:6px;font-size:calc(11.5px * var(--font-scale, 1));color:var(--muted);line-height:1.6}",
      // —— 中栏课程页 ——
      // 课程页也不再自己内部滚动：整条中栏一个滚动条（外层 .streak-calendar-left 负责）
      ".ko-page{display:grid;grid-template-rows:auto auto auto;gap:10px;min-width:0;",
      "border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:14px 16px}",
      ".ko-page-head{display:flex;flex-wrap:wrap;align-items:flex-start;gap:10px}",
      ".ko-page-crumb{font-size:calc(11.5px * var(--font-scale, 1));color:var(--muted)}",
      ".ko-page-title{margin:3px 0 0;display:flex;align-items:center;gap:8px;font-size:calc(17px * var(--font-scale, 1));color:var(--ink)}",
      ".ko-page-actions{margin-left:auto;display:flex;flex-wrap:wrap;gap:6px}",
      ".ko-btn{border:1px solid var(--line);background:transparent;color:var(--ink);border-radius:8px;",
      "padding:5px 11px;font-size:calc(12px * var(--font-scale, 1));font-family:inherit;cursor:pointer;",
      "transition:border-color .15s ease,background .15s ease}",
      ".ko-btn:hover{border-color:var(--green);background:var(--green-soft)}",
      ".ko-btn[disabled]{opacity:.55;cursor:default}",
      ".ko-btn.primary{background:var(--green);border-color:var(--green);color:#0e1410;font-weight:600}",
      ".ko-page-meta{display:flex;flex-wrap:wrap;gap:8px;font-size:calc(11.5px * var(--font-scale, 1));color:var(--muted)}",
      ".ko-page-meta span{border:1px solid var(--line);border-radius:999px;padding:1px 8px}",
      // 正文不自己滚（交给整条中栏）；横向溢出（速查表的宽表格）在正文层滚
      ".ko-page-body{min-width:0;overflow-x:auto;",
      "border-top:1px solid var(--line);padding-top:10px;font-size:calc(13px * var(--font-scale, 1));line-height:1.75;color:var(--ink)}",
      // 正文 Markdown：速查表以表格为主，给表头和斑马纹，扫读时行不串行
      ".ko-md h4{margin:14px 0 6px;font-size:calc(14px * var(--font-scale, 1));color:var(--ink)}",
      ".ko-md h4:first-child{margin-top:0}",
      ".ko-md p{margin:6px 0}",
      ".ko-md ul{margin:6px 0;padding-left:20px;display:grid;gap:3px}",
      ".ko-md ol{margin:6px 0;padding-left:22px;display:grid;gap:3px}",
      ".ko-md .ko-ck{display:inline-block;min-width:1.2em;color:var(--green-dark);font-weight:700}",
      ".ko-md .ko-ck.is-done{color:var(--muted)}",
      ".ko-md code{background:var(--sidebar);border-radius:4px;padding:1px 5px;font-size:calc(12px * var(--font-scale, 1))}",
      ".ko-md table{width:100%;border-collapse:collapse;margin:8px 0;font-size:calc(12.5px * var(--font-scale, 1))}",
      ".ko-md th,.ko-md td{border:1px solid var(--line);padding:6px 9px;text-align:left;vertical-align:top}",
      ".ko-md thead th{background:var(--sidebar);font-weight:600;color:var(--ink)}",
      ".ko-md tbody tr:nth-child(even){background:var(--background)}",
      ".ko-md-empty{margin:0;padding:18px 12px;text-align:center;color:var(--muted);font-size:calc(12.5px * var(--font-scale, 1))}",
      ".ko-md-note{margin:0;font-size:calc(11.5px * var(--font-scale, 1));color:var(--muted);line-height:1.7}",
      // —— 学习路径页底部的冲刺入口 ——
      ".ko-sprint-box{border:1px dashed var(--line);border-radius:10px;padding:10px 12px;display:grid;gap:8px}",
      ".ko-sprint-box-title{font-size:calc(12.5px * var(--font-scale, 1));font-weight:600;color:var(--ink)}",
      ".ko-sprint-box-hint{font-size:calc(11.5px * var(--font-scale, 1));color:var(--muted);line-height:1.6}",
      ".ko-sprint-modes{display:flex;flex-wrap:wrap;gap:6px}",
      ".ko-sprint-mode{display:grid;gap:2px;text-align:left;border:1px solid var(--line);",
      "background:var(--background);color:var(--ink);border-radius:9px;padding:6px 12px;",
      "cursor:pointer;font-family:inherit;transition:border-color .15s ease,background .15s ease}",
      ".ko-sprint-mode:hover{border-color:var(--green);background:var(--green-soft)}",
      ".ko-sprint-mode[disabled]{opacity:.55;cursor:default}",
      ".ko-sprint-mode-name{font-size:calc(12.5px * var(--font-scale, 1));font-weight:600}",
      ".ko-sprint-mode-hint{font-size:calc(11px * var(--font-scale, 1));color:var(--muted)}",
    ].join("");
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------- 工具 --

  function esc(val) {
    if (typeof window.escapeHtml === "function") return window.escapeHtml(val);
    return String(val == null ? "" : val).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c] || c));
  }

  function notify(msg, variant = "info") {
    if (typeof window.showToast === "function") {
      try { window.showToast(msg, { variant }); return; } catch (_) { /* 忽略 */ }
    }
    console.log(`[StudyDesk ${variant}]:`, msg);
  }

  // ⚠️ app.js 里的 state 是顶层 const（全局词法作用域），不是 window.state —— 读裸 state。
  function currentProjectId() {
    if (typeof state !== "undefined" && state && state.currentProjectId) {
      return String(state.currentProjectId);
    }
    return "";
  }

  /** 课程列表 = 用户建过的项目，与顶部项目切换器同一份数据。 */
  function courses() {
    if (typeof state === "undefined" || !state || !Array.isArray(state.projects)) return [];
    return state.projects
      .filter((p) => p && p.project_id)
      .map((p) => {
        const subject = String(p.subject || p.name || "").trim();
        const year = String(p.year || "").trim();
        return {
          project_id: String(p.project_id),
          subject: subject,
          label: year ? `${year} · ${subject}` : (subject || "未命名课程"),
        };
      });
  }

  function courseById(pid) {
    return courses().find((c) => c.project_id === pid) || null;
  }

  /** 该课程最近的考期天数（来自考期备忘模块；拿不到就返回 null，不猜）。 */
  function examDaysLeft(subject) {
    const sprint = window.KnowOriginSprint;
    const exams = sprint && typeof sprint.getExams === "function" ? sprint.getExams() : [];
    let best = null;
    for (const e of exams || []) {
      const name = String(e.subject || e.course_name || "");
      if (!name || (subject && name !== subject)) continue;
      const d = Number(e.days_left);
      if (!Number.isFinite(d) || d < 0) continue;
      if (best == null || d < best) best = d;
    }
    return best;
  }

  function callApi(url, options = {}) {
    const opts = { ...options };
    if (opts.body != null && opts.body !== "" && typeof opts.body === "string") {
      opts.headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    }
    if (typeof window.api === "function") return window.api(url, opts);
    return fetch(url, { credentials: "same-origin", ...opts }).then((res) => {
      if (!res.ok) {
        return res.json().catch(() => ({})).then((err) => {
          throw new Error(err.detail?.message || err.detail || `HTTP ${res.status}`);
        });
      }
      return res.json();
    });
  }

  function setView(mode) {
    VM.mode = mode;
    const cal = window.KnowOriginCalendar;
    if (cal && typeof cal.setView === "function") {
      cal.setView(mode === "course" ? "desk" : "calendar");
    }
  }

  // ---------------------------------------------------------------- 数据 --

  async function loadKits(pid) {
    if (!pid || VM.kitLoading[pid]) return;
    VM.kitLoading[pid] = true;
    renderView();
    try {
      const data = await callApi(`/api/projects/${encodeURIComponent(pid)}/study-kit`);
      const map = {};
      for (const kit of data.kits || []) map[kit.kind] = kit;
      VM.kits[pid] = map;
      VM.error = "";
    } catch (err) {
      console.warn("读取速查表/学习路径失败:", err);
      VM.kits[pid] = VM.kits[pid] || {};
    } finally {
      VM.kitLoading[pid] = false;
      renderRail();
      renderView();
    }
  }

  async function generateKit(pid, kind) {
    if (!pid) return;
    const key = `${pid}:${kind}`;
    if (VM.busyKeys[key]) return;   // 只防「同一个 pid:kind」重复点击；不同 kind 可并行
    VM.busyKeys[key] = true;
    VM.error = "";
    renderView();
    try {
      const res = await callApi(`/api/projects/${encodeURIComponent(pid)}/study-kit/generate`, {
        method: "POST",
        body: JSON.stringify({ kind }),
      });
      const map = VM.kits[pid] || {};
      map[kind] = res.kit;
      VM.kits[pid] = map;
      notify(`✅ ${kindMeta(kind).label}已生成`, "success");
    } catch (err) {
      VM.error = err.message || "生成失败";
      notify(`生成${kindMeta(kind).label}失败：` + VM.error, "error");
    } finally {
      delete VM.busyKeys[key];
      renderRail();
      renderView();
    }
  }

  /**
   * 按这份学习路径制定冲刺计划。
   * 计划是按项目存的：若要看的那门课不是当前打开的项目，先切过去再排 ——
   * 否则排完的计划落在一个用户看不见的项目上。
   */
  async function startSprint(pid, preset) {
    const course = courseById(pid);
    const sprint = window.KnowOriginSprint;
    if (!sprint || typeof sprint.generate !== "function") {
      notify("冲刺计划模块未就绪，请先刷新页面", "warning");
      return;
    }
    if (pid !== currentProjectId()) {
      if (typeof selectProject !== "function") {
        notify("请先在主界面打开《" + (course ? course.subject : "该课程") + "》再制定计划", "warning");
        return;
      }
      notify("正在切换到《" + (course ? course.subject : "该课程") + "》…", "info");
      try {
        await selectProject(pid);
      } catch (err) {
        notify("切换课程失败：" + (err.message || err), "error");
        return;
      }
    }
    sprint.generate({
      project_id: pid,
      mode: preset.mode,
      total_days: preset.days,
      daily_hours: preset.hours,
    });
  }

  // ------------------------------------------------------- Markdown 渲染 --

  /**
   * 极简 Markdown：先把公式抽成占位符 → 再转义 → 套标签 → 最后还原成 KaTeX。
   *
   * ⚠️ 公式必须在转义**之前**抽走：模型写 `$a < b$` 时，先 esc 会把它变成
   * `$a &lt; b$`，KaTeX 拿到的是坏 LaTeX —— 用户看到的就是「公式渲染不出来」。
   */
  function renderMarkdown(source) {
    const mathBlocks = [];
    const protect = (tex, display) => {
      const token = "\u0000MATH" + mathBlocks.length + "\u0000";
      mathBlocks.push({ tex: tex, display: display });
      return token;
    };
    // 四种写法都要认：`$$…$$` / `\[…\]`（行间）与 `$…$` / `\(…\)`（行内）。
    // 只认后两种时，模型输出 `$…$` 的公式会原样显示成 `$NA=n\sin\theta$`。
    const guarded = String(source == null ? "" : source)
      .replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => protect(tex, true))
      .replace(/\\\[([\s\S]+?)\\\]/g, (m, tex) => protect(tex, true))
      .replace(/\\\(([\s\S]+?)\\\)/g, (m, tex) => protect(tex, false))
      .replace(/\$(?!\$)([^\n$]+?)\$(?!\$)/g, (m, tex) => protect(tex, false));
    const lines = esc(guarded).split(/\r?\n/);
    const out = [];
    let inTable = false;
    let inList = "";
    let headerDone = false;

    function closeBlocks() {
      if (inTable) { out.push("</tbody></table>"); inTable = false; headerDone = false; }
      if (inList) { out.push(inList === "ul" ? "</ul>" : "</ol>"); inList = ""; }
    }

    function inline(text) {
      return text
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/`([^`]+)`/g, "<code>$1</code>");
    }

    lines.forEach((raw) => {
      const line = raw.replace(/\s+$/, "");
      if (/^\s*\|.*\|\s*$/.test(line)) {
        if (/^[\s|:-]+$/.test(line)) return;   // 分隔行
        if (inList) { out.push(inList === "ul" ? "</ul>" : "</ol>"); inList = ""; }
        const cells = line.trim().replace(/^\||\|$/g, "").split("|");
        if (!inTable) {
          out.push("<table><tbody>");
          inTable = true;
          headerDone = false;
        }
        // 第一段表格行当表头：速查表几乎都是「术语 | 含义 | 易错点」这种对照表
        const tag = headerDone ? "td" : "th";
        if (!headerDone) {
          out.push("<thead><tr>" + cells.map((c) => `<th>${inline(c.trim())}</th>`).join("") + "</tr></thead><tbody>");
          headerDone = true;
          return;
        }
        out.push("<tr>" + cells.map((c) => `<${tag}>${inline(c.trim())}</${tag}>`).join("") + "</tr>");
        return;
      }
      if (inTable) { out.push("</tbody></table>"); inTable = false; headerDone = false; }
      if (/^#{1,6}\s+/.test(line)) {
        if (inList) { out.push(inList === "ul" ? "</ul>" : "</ol>"); inList = ""; }
        out.push("<h4>" + inline(line.replace(/^#{1,6}\s+/, "")) + "</h4>");
      } else if (/^\s*[-*]\s+/.test(line)) {
        if (inList !== "ul") {
          if (inList) out.push("</ol>");
          out.push("<ul>");
          inList = "ul";
        }
        let text = line.replace(/^\s*[-*]\s+/, "");
        const ck = text.match(/^\[([ xX])\]\s*/); // 清单复选框 - [ ] / - [x]
        if (ck) {
          text = text.slice(ck[0].length);
          const mark = ck[1] === " " ? '<span class="ko-ck">☐</span> ' : '<span class="ko-ck is-done">☑</span> ';
          out.push("<li>" + mark + inline(text) + "</li>");
        } else {
          out.push("<li>" + inline(text) + "</li>");
        }
      } else if (/^\s*\d+[.)]\s+/.test(line)) {
        if (inList !== "ol") {
          if (inList) out.push("</ul>");
          out.push("<ol>");
          inList = "ol";
        }
        out.push("<li>" + inline(line.replace(/^\s*\d+[.)]\s+/, "")) + "</li>");
      } else if (!line.trim()) {
        closeBlocks();
      } else {
        closeBlocks();
        out.push("<p>" + inline(line) + "</p>");
      }
    });
    closeBlocks();
    return restoreMath(out.join(""), mathBlocks);
  }

  /** 把占位符还原成 KaTeX；katex 不可用或公式写坏了就退回原文，不抛错。 */
  function restoreMath(html, mathBlocks) {
    const blocks = mathBlocks || [];
    if (!blocks.length) return html;
    const hasKatex = typeof window.katex !== "undefined" && !!window.katex.renderToString;
    return html.replace(/\u0000MATH(\d+)\u0000/g, (whole, idx) => {
      const item = blocks[Number(idx)];
      if (!item) return whole;
      if (!hasKatex) {
        return esc(item.display ? "\\[" + item.tex + "\\]" : "\\(" + item.tex + "\\)");
      }
      return katexNode(item.tex, item.display);
    });
  }

  function katexNode(tex, display) {
    try {
      return window.katex.renderToString(tex, {
        displayMode: display,
        throwOnError: false,
        strict: "ignore",
      });
    } catch (_) {
      return esc(tex);
    }
  }

  // ---------------------------------------------------------------- 渲染 --

  function renderRail() {
    if (!VM.rail) return;
    const list = courses();
    const curPid = currentProjectId();
    // 首次渲染（或项目列表刚到）时，默认展开当前打开的那门课 ——
    // 否则用户看到的全是折叠标题，根本发现不了下面挂着两页。
    if (VM.openCourse == null) VM.openCourse = curPid || "";

    const calendarItem =
      '<button type="button" class="ko-rail-item' + (VM.mode === "calendar" ? " is-on" : "") +
      '" data-desk-calendar>' +
      '<span class="ko-rail-item-icon">📅</span><span>学习台历</span></button>';

    let courseHtml;
    if (!list.length) {
      courseHtml = '<p class="ko-rail-empty">还没有课程。先在主界面新建课程并导入资料。</p>';
    } else {
      courseHtml = list.map((c) => {
        const open = VM.openCourse === c.project_id || VM.course === c.project_id;
        const days = examDaysLeft(c.subject);
        const urgent = days != null && days <= 7;
        const daysText = days == null ? "" : `距考期 ${days} 天`;
        const sub = KINDS.map((k) => {
          const on = VM.mode === "course" && VM.course === c.project_id && VM.kind === k.value;
          const has = Boolean((VM.kits[c.project_id] || {})[k.value]);
          return `<button type="button" class="ko-rail-item${on ? " is-on" : ""}" ` +
            `data-desk-page="${esc(c.project_id)}" data-desk-kind="${esc(k.value)}" ` +
            `title="${esc(k.hint)}">` +
            `<span class="ko-rail-item-icon">${k.icon}</span><span>${esc(k.label)}</span>` +
            (has ? '<span class="ko-rail-dot">已生成</span>' : "") +
            "</button>";
        }).join("");
        return `
          <div class="ko-rail-course${open ? " is-open" : ""}${urgent ? " is-urgent" : ""}${
            c.project_id === curPid ? " is-cur" : ""}">
            <button type="button" class="ko-rail-course-head" data-desk-course="${esc(c.project_id)}"
                    title="${esc(c.label)}">
              <span class="ko-rail-course-caret">▶</span>
              <span class="ko-rail-course-name">${esc(c.subject || c.label)}</span>
              <span class="ko-rail-course-days">${esc(daysText)}</span>
            </button>
            <div class="ko-rail-sub">${sub}</div>
          </div>`;
      }).join("");
    }

    VM.rail.innerHTML =
      '<div class="ko-rail">' +
        '<div class="ko-rail-group"><div class="ko-rail-title">视图</div>' + calendarItem + "</div>" +
        '<div class="ko-rail-group"><div class="ko-rail-title">课程 · ' + list.length + "</div>" +
          courseHtml +
        "</div>" +
      "</div>";
  }

  function renderView() {
    if (!VM.view) return;
    if (VM.mode !== "course") {
      VM.view.innerHTML = "";
      return;
    }
    const pid = VM.course;
    const course = courseById(pid);
    const meta = kindMeta(VM.kind);
    const kit = (VM.kits[pid] || {})[VM.kind];
    const busy = Boolean(VM.busyKeys[`${pid}:${VM.kind}`]);
    const loading = Boolean(VM.kitLoading[pid]);

    const actions =
      '<div class="ko-page-actions">' +
        `<button type="button" class="ko-btn${busy ? "" : " primary"}" data-desk-gen${busy ? " disabled" : ""}>` +
        (busy ? "生成中…" : (kit ? "重新生成" : "生成" + meta.label)) + "</button>" +
        (kit ? '<button type="button" class="ko-btn" data-desk-copy>复制 Markdown</button>' : "") +
        '<button type="button" class="ko-btn" data-desk-back>回到台历</button>' +
      "</div>";

    let body;
    if (busy) {
      body = '<p class="ko-md-empty">正在读资料、写' + esc(meta.label) + "…通常需要十几秒。</p>";
    } else if (loading && !kit) {
      body = '<p class="ko-md-empty">正在读取…</p>';
    } else if (kit && kit.content_md) {
      body = '<div class="ko-md">' + renderMarkdown(kit.content_md) + "</div>";
    } else {
      body =
        '<p class="ko-md-empty">这门课还没有' + esc(meta.label) + "。</p>" +
        '<p class="ko-md-note">' + esc(meta.hint) +
        (VM.error ? "上次生成失败：" + esc(VM.error) : "") + "</p>";
    }

    const stamp = kit && kit.updated_at ? String(kit.updated_at).slice(0, 16).replace("T", " ") : "";
    const metaLine =
      '<div class="ko-page-meta">' +
        '<span>' + esc(course ? course.label : "课程") + "</span>" +
        '<span>' + esc(meta.label) + "</span>" +
        (stamp ? "<span>更新于 " + esc(stamp) + "</span>" : "") +
      "</div>";

    // 冲刺入口只挂在学习路径页 —— 路径回答「先学什么、再学什么」，天然是排期依据；
    // 速查表是考前过一遍用的，那儿放排期入口会让人分不清该看哪个。
    let sprintBox = "";
    if (VM.kind === "learning_path") {
      const modes = SPRINT_PRESETS.map((m, i) => `
        <button type="button" class="ko-sprint-mode" data-desk-sprint="${i}"${busy ? " disabled" : ""}
                title="${esc(m.hint)}">
          <span class="ko-sprint-mode-name">${m.icon} ${esc(m.name)}</span>
          <span class="ko-sprint-mode-hint">${m.days} 天 · ${m.hours}h/天</span>
        </button>`).join("");
      // 说明文字只留必要的：按钮上已经写清「几天 × 每天几小时」，
      // 目标分与周期的精细自定义在台历底部的「当日计划」里（那里能即时看到强度回执）。
      sprintBox = `
        <div class="ko-sprint-box">
          <div class="ko-sprint-box-title">🚀 排冲刺计划</div>
          <div class="ko-sprint-modes">${modes}</div>
        </div>`;
    }

    VM.view.innerHTML = `
      <div class="ko-page">
        <div class="ko-page-head">
          <div>
            <div class="ko-page-crumb">课程 · ${esc(course ? course.subject : "未命名课程")}</div>
            <h3 class="ko-page-title"><span>${meta.icon}</span><span>${esc(meta.label)}</span></h3>
          </div>
          ${actions}
        </div>
        ${metaLine}
        <div class="ko-page-body">${body}${sprintBox}</div>
      </div>`;
    // 清单报告渲染后，给每条知识点补「问海小棠」入口（能力由海小棠桌宠模块提供）
    if (VM.kind === "checklist" && window.HXT_PET && typeof window.HXT_PET.enhanceChecklistItems === "function") {
      window.HXT_PET.enhanceChecklistItems(VM.view);
    }
  }

  // ---------------------------------------------------------------- 交互 --

  function bindRail() {
    if (!VM.rail || VM.rail.getAttribute("data-ko-desk-bound") === "1") return;
    VM.rail.setAttribute("data-ko-desk-bound", "1");
    VM.rail.addEventListener("click", (ev) => {
      const t = ev.target;
      if (!t || typeof t.closest !== "function") return;

      if (t.closest("[data-desk-calendar]")) {
        VM.mode = "calendar";
        setView("calendar");
        renderRail();
        renderView();
        return;
      }

      const head = t.closest("[data-desk-course]");
      if (head) {
        const pid = head.getAttribute("data-desk-course");
        // 手风琴：点已展开的课程名 = 收起；点另一门 = 换开（一屏只展开一门）
        VM.openCourse = VM.openCourse === pid ? "" : pid;
        // 点课程 = 切到这门课：台历「当日计划」按项目存，切过去后经
        // knoworigin:project-switched 自动刷新成该课程的冲刺计划（没生成则显示制定入口）。
        // 与 startSprint 里「先切项目再排计划」同一条路径，保证计划落到看得到的那门课上。
        if (pid && pid !== currentProjectId() && typeof selectProject === "function") {
          selectProject(pid).catch((err) => {
            console.warn("切到课程失败:", err);
          });
        }
        renderRail();
        return;
      }

      const page = t.closest("[data-desk-page]");
      if (page) {
        const pid = page.getAttribute("data-desk-page");
        const kind = page.getAttribute("data-desk-kind") || "cheatsheet";
        VM.course = pid;
        VM.openCourse = pid;
        VM.kind = kind;
        VM.mode = "course";
        VM.error = "";
        setView("course");
        renderRail();
        renderView();
        loadKits(pid);
      }
    });
  }

  function bindView() {
    if (!VM.view || VM.view.getAttribute("data-ko-desk-bound") === "1") return;
    VM.view.setAttribute("data-ko-desk-bound", "1");
    VM.view.addEventListener("click", (ev) => {
      const t = ev.target;
      if (!t || typeof t.closest !== "function") return;

      if (t.closest("[data-desk-back]")) {
        VM.mode = "calendar";
        setView("calendar");
        renderRail();
        renderView();
        return;
      }

      if (t.closest("[data-desk-gen]")) {
        generateKit(VM.course, VM.kind);
        return;
      }

      if (t.closest("[data-desk-copy]")) {
        const kit = (VM.kits[VM.course] || {})[VM.kind];
        if (kit && kit.content_md && navigator.clipboard) {
          navigator.clipboard.writeText(kit.content_md)
            .then(() => notify("已复制 Markdown，可粘进笔记或打印", "success"))
            .catch(() => notify("复制失败，请手动选中正文复制", "warning"));
        }
        return;
      }

      const sprintBtn = t.closest("[data-desk-sprint]");
      if (sprintBtn) {
        const idx = parseInt(sprintBtn.getAttribute("data-desk-sprint"), 10);
        const preset = SPRINT_PRESETS[idx];
        if (preset) startSprint(VM.course, preset);
      }
    });
  }

  // ---------------------------------------------------------------- 挂载 --

  function mountRail(el) {
    ensureStyle();
    VM.rail = el;
    bindRail();
    renderRail();
  }

  function mountView(el) {
    ensureStyle();
    VM.view = el;
    bindView();
    renderView();
  }

  /** 项目列表可能比台历打开得晚（登录后异步拉），变化时重画左栏。 */
  function watchProjects() {
    if (typeof MutationObserver !== "function" || !document.body) return;
    let pending = false;
    const observer = new MutationObserver(() => {
      if (pending || VM.mode !== "calendar") return;
      pending = true;
      setTimeout(() => {
        pending = false;
        renderRail();
      }, 400);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /**
   * 跳到某门课/某一份成文产物（对话区的选项卡片与 Agent 跳转族选项用）。
   *
   * 与左栏点击同一条路径 —— 改 VM → 切中栏 → 重画 → 拉数据，不另开一套状态。
   * 不直接调 setView("course") 是因为还要 renderRail，否则左栏高亮会留在月历那一项上。
   */
  function open(pid, kind) {
    const target = String(pid || currentProjectId() || "").trim();
    if (!target) return false;
    VM.course = target;
    VM.openCourse = target;
    VM.kind = kindMeta(kind).value;
    VM.mode = "course";
    VM.error = "";
    renderRail();
    renderView();
    loadKits(target);
    return true;
  }

  window.KnowOriginDesk = { mountRail, mountView, open };

  // 考期是考期备忘模块异步拉的，到得比左栏首次渲染晚 —— 到了就补一次「距考期 N 天」
  document.addEventListener("knoworigin:exam-dates", () => renderRail());

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      ensureStyle();
      watchProjects();
    });
  } else {
    ensureStyle();
    watchProjects();
  }
})();
