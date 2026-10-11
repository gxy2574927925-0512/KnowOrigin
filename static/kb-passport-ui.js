/**
 * 语义护照（Knowledge Passport）—— 知识图谱右侧栏
 *
 * 点图谱上的节点滑出来，回答「这个知识点到底是什么」。
 *
 * 与 kb-dock 的分工：
 *   语义护照 = 只读的内容阅读器，图同时可见，能对照着看
 *   kb-dock  = 学习操作台（笔记 / 卡片 / 测验 / 整理助手），全屏，动手的地方
 *
 * 内容分工：护照里放"边读边对照"的段落（定义、公式、易错、相邻关系）；
 * 推导、自检、依据、笔记这四块由 renderUnderGraph 放到图谱下方 ——
 * 它们是读完之后回头核对的动作，挤在 420px 右栏里要把视线来回搬。
 *
 * 学习状态只作为顶部 2px 色线存在，不落成任何数字或文字徽章。
 *
 * 配色全部走项目既有变量（--ink / --line / --panel / --green …），
 * 不新增色板：换品牌时护照才不会变成「另一个产品」。
 */
(function () {
  "use strict";

  var HOST_CLASS = "kb-passport-host";
  var FOLD_KEY = "kb-passport-fold";
  var SIDE_KEY = "kb-side-widths";

  /* 左右两条边的宽度。目录栏最小 180（图谱需要横向空间），护照最小 320
     —— 低于这个值，公式区会开始横向溢出。 */
  var SIDE_LIMITS = {
    left: { min: 180, max: 460, def: 220 },
    right: { min: 320, max: 720, def: 420 }
  };
  var COLLAPSED_W = 46;

  var sides = { left: SIDE_LIMITS.left.def, right: SIDE_LIMITS.right.def };
  var collapsed = { left: false, right: false };

  var view = {
    nodeId: "",
    doc: null,
    loading: false,
    error: "",
    projectId: ""
  };

  /* 分区折叠状态存 sessionStorage 而不是内存：renderFramework 会整块重建
     innerHTML，用户刚折起来的分区不该在切一次视图后弹回去。 */
  var folds = {};
  try {
    var raw = sessionStorage.getItem(FOLD_KEY);
    if (raw) folds = JSON.parse(raw) || {};
  } catch (error) {
    folds = {};
  }

  var TONE_BY_STATUS = {
    mastered: "lit",
    learning: "partial",
    pending_confirmation: "wait",
    encountered: "partial",
    unexplored: "dim"
  };

  var SECTION_TONE = {
    backend: "partial",
    frontend: "wait",
    database: "lit",
    security: "blocked",
    messagebus: "dim",
    cloud: "wait",
    external: "dim"
  };

  // ----------------------------------------------------------------- 工具

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function nodeById(id) {
    var nodes = (typeof state !== "undefined" && state.nodes) || [];
    for (var i = 0; i < nodes.length; i += 1) {
      if (nodes[i] && nodes[i].node_id === id) return nodes[i];
    }
    return null;
  }

  function breadcrumb(id) {
    var trail = [];
    var cursor = nodeById(id);
    var seen = {};
    while (cursor && !seen[cursor.node_id] && trail.length < 8) {
      seen[cursor.node_id] = true;
      trail.unshift(cursor);
      cursor = cursor.parent_id ? nodeById(cursor.parent_id) : null;
    }
    return trail;
  }

  function toneOf(node) {
    var status = String((node && node.learning_status) || "").toLowerCase();
    if (status === "mastered") return "lit";
    if (status === "unexplored") return "dim";
    if (status === "pending_confirmation") return "wait";
    if (status === "encountered" || status === "learning") return "partial";
    var coverage = String((node && node.coverage_status) || "").toLowerCase();
    if (["insufficient_source", "missing_prerequisite", "uncovered"].indexOf(coverage) >= 0) return "blocked";
    return TONE_BY_STATUS[status] || "dim";
  }

  // ----------------------------------------------------------------- 公式

  /* 行内公式的定界符。模型这一层爱混用三种写法，漏掉一种就整屏露出
     \(\Delta k\) 这样的源码 —— 用户看到的是"公式坏了"，不是"这里没渲染"。
     $$ 与 $ 只在不贴着数字时才当公式，免得把价格里的 $ 吃掉。 */
  var MATH_BLOCK_RE = /\$\$([^$]+)\$\$/g;
  var MATH_PAREN_RE = /\\\((.+?)\\\)/gs;
  var MATH_BRACKET_RE = /\\\[([\s\S]+?)\\\]/g;
  var MATH_DOLLAR_RE = /(^|[^0-9A-Za-z\\$])\$([^$\n]+?)\$/g;

  function extractMath(text) {
    var found = [];
    var out = text;
    function take(source, displayMode) {
      found.push({ source: source, display: displayMode });
      return "\u0000math" + (found.length - 1) + "\u0000";
    }
    out = out.replace(MATH_BLOCK_RE, function (_, source) { return take(source, true); });
    out = out.replace(MATH_BRACKET_RE, function (_, source) { return take(source, true); });
    out = out.replace(MATH_PAREN_RE, function (_, source) { return take(source, false); });
    out = out.replace(MATH_DOLLAR_RE, function (_, lead, source) {
      return lead + take(source, false);
    });
    return { text: out, found: found };
  }

  function renderTex(tex, displayMode) {
    var source = String(tex || "").trim();
    if (!source) return "";
    if (typeof window.katex !== "undefined" && typeof window.katex.renderToString === "function") {
      try {
        return window.katex.renderToString(source, {
          displayMode: !!displayMode,
          throwOnError: false,
          output: "html"
        });
      } catch (error) {
        /* 落到下面的 code 兜底 */
      }
    }
    return "<code>" + esc(source) + "</code>";
  }

  /**
   * 正文行内标记。只做四件事：行内公式、**粗体**、`代码`、[[双链]]。
   * 刻意不引 Markdown 依赖 —— 详解正文本身几乎没有其它语法，
   * 上完整解析器只会带来 XSS 面和体积。
   * 后端 _md_text 会把裸 < > 转义成 \\< \\>，这里还原回字面量。
   */
  function inline(text) {
    var math = extractMath(String(text == null ? "" : text));
    var out = esc(math.text);
    out = out
      .replace(/\\&lt;/g, "&lt;")
      .replace(/\\&gt;/g, "&gt;")
      .replace(/\\\\</g, "<")
      .replace(/\\\\>/g, ">");

    // 先摘出行内代码，避免代码里的 ** 被当粗体
    var codes = [];
    out = out.replace(/`([^`]+)`/g, function (_, code) {
      codes.push(code);
      return "\u0000code" + (codes.length - 1) + "\u0000";
    });

    // 粗体先吃掉，剩下的单星号才是斜体。不用 lookbehind —— 旧 WebKit 会在
    // 解析阶段就报错，不是运行期降级。
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    out = out.replace(/\[\[([^\[\]|]+)(?:\|([^\[\]]+))?\]\]/g, function (_, target, alias) {
      return (
        '<button type="button" class="kp-wikilink" data-kp-jump-name="' +
        esc(target) + '">' + esc(alias || target) + "</button>"
      );
    });
    out = out.replace(/\u0000code(\d+)\u0000/g, function (_, index) {
      return "<code>" + codes[Number(index)] + "</code>";
    });

    // 公式最后还原：占位符是在 esc() 之后塞进去的，里面的 KaTeX HTML 不能再转义
    out = out.replace(/\u0000math(\d+)\u0000/g, function (_, index) {
      var item = math.found[Number(index)];
      if (!item) return "";
      var body = renderTex(item.source, item.display);
      return item.display
        ? '<span class="kp-fx-block">' + body + "</span>"
        : '<span class="kp-fx-inline">' + body + "</span>";
    });
    return out;
  }

  // --------------------------------------------------------------- 侧栏尺寸

  function clampWidth(key, value) {
    var limits = SIDE_LIMITS[key];
    return Math.max(limits.min, Math.min(limits.max, Math.round(value)));
  }

  function readSides() {
    try {
      var raw = localStorage.getItem(SIDE_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      if (!saved || typeof saved !== "object") return;
      ["left", "right"].forEach(function (key) {
        var value = Number(saved[key]);
        if (Number.isFinite(value)) sides[key] = clampWidth(key, value);
        if (saved[key + "Collapsed"] === true) collapsed[key] = true;
      });
    } catch (error) {
      /* 存不下就用默认值 */
    }
  }

  function writeSides() {
    try {
      localStorage.setItem(SIDE_KEY, JSON.stringify({
        left: sides.left,
        right: sides.right,
        leftCollapsed: collapsed.left,
        rightCollapsed: collapsed.right
      }));
    } catch (error) {
      /* 隐私模式下写不进去，本次会话内仍然有效 */
    }
  }

  function leftSidebar() {
    return document.querySelector(".framework-sidebar-left");
  }

  /**
   * 把宽度与收起态落到 DOM。宽度写在两处：
   *   - 左栏写 inline width
   *   - 护照写 --kp-w（CSS 用 var(--kp-w, 420px)）
   * 收起态另加 class，并给 <html> 打标记让 grid 首列跟着收窄。
   * 收起时把拖动把手置 hidden：46px 的竖条里塞不下它，留着既抓不到又挡点击。
   */
  function applySides() {
    var left = leftSidebar();
    if (left) {
      left.style.width = (collapsed.left ? COLLAPSED_W : sides.left) + "px";
      left.classList.toggle("is-collapsed", collapsed.left);
    }
    var host = shell();
    if (host) {
      host.classList.toggle("is-collapsed", collapsed.right);
    }
    /* --kp-w 要写在 <html> 上，不能只写 host：
       grid 那条三列规则 grid-template-columns: … var(--kp-w, 420px) 是在
       .framework-shell 上求值的，shell 看不到 host 的 inline 变量，于是回退成
       420px —— 列宽 420px 而护照只有 46px，收起后的竖条就贴在列的左边，
       右边空出 374px，看起来就是「往左收起」。挂到 <html> 才只有一份真相。 */
    document.documentElement.style.setProperty(
      "--kp-w", (collapsed.right ? COLLAPSED_W : sides.right) + "px");
    setGripHidden(document.querySelector(".framework-view"), "left", collapsed.left);
    setGripHidden(host, "right", collapsed.right);

    if (collapsed.left) document.documentElement.setAttribute("data-kb-left-collapsed", "true");
    else document.documentElement.removeAttribute("data-kb-left-collapsed");
    document.documentElement.style.setProperty("--kb-side-collapsed", COLLAPSED_W + "px");
  }

  /** 目录把手挂在 .framework-view 里，不在 aside 内，所以要从那个 scope 找。
     一条边上可能有两个把手（护照左右各一），要一次全藏掉。 */
  function setGripHidden(scope, key, hidden) {
    if (!scope) return;
    scope.querySelectorAll('.kb-grip[data-kb-grip="' + key + '"]').forEach(function (grip) {
      grip.hidden = hidden;
    });
  }

  function toggleCollapse(key) {
    collapsed[key] = !collapsed[key];
    // 收起前的宽度被保留：拖到 380 宽后收起、再展开，多半还是想要 380。
    applySides();
    writeSides();
  }

  /** 拖动把手：贴在边界上的 12px 命中区，按住拖动改的是对应那一侧的宽度。
      两条边共用同一份宽度，但方向相反 —— 这是每条边的物理语义：
        左缘往左拖 = 变宽（把图挤小）
        右缘往左拖 = 变窄（往里收）
      共用一套方向的话，拖右缘会看到左缘在动而右缘纹丝不动，像坏了。 */
  function bindGrips() {
    document.querySelectorAll(".kb-grip[data-kb-grip]").forEach(function (grip) {
      if (grip.__kbBound) return;
      grip.__kbBound = true;
      var key = grip.getAttribute("data-kb-grip");
      // "invert" = 右缘：指针往左走时宽度反而要变小
      var invert = grip.getAttribute("data-kb-grip-invert") === "true";
      grip.addEventListener("pointerdown", function (event) {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        // 拖一个 46px 的竖条没有意义，先解除折叠
        if (collapsed[key]) {
          collapsed[key] = false;
          applySides();
        }
        var startX = event.clientX;
        var startW = sides[key];
        document.body.classList.add("kb-side-dragging");
        grip.setAttribute("data-dragging", "true");

        var onMove = function (moveEvent) {
          // 指针位移是视觉像素、sides[key] 是设计像素：界面整体缩放时先除回设计像素。
          var scale = (window.KnowOriginUiScale && window.KnowOriginUiScale.scale()) || 1;
          var delta = (moveEvent.clientX - startX) / scale;
          // 左栏在图左边：往右拖变宽；护照在图右边：往左拖变宽
          var grow = key === "left" ? delta : -delta;
          if (invert) grow = -grow;
          sides[key] = clampWidth(key, startW + grow);
          applySides();
        };
        var onUp = function () {
          document.removeEventListener("pointermove", onMove);
          document.removeEventListener("pointerup", onUp);
          document.removeEventListener("pointercancel", onUp);
          document.body.classList.remove("kb-side-dragging");
          grip.removeAttribute("data-dragging");
          writeSides();
        };
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
        document.addEventListener("pointercancel", onUp);
      });
    });

    document.querySelectorAll(".kb-side-rail[data-kb-expand]").forEach(function (rail) {
      if (rail.__kbBound) return;
      rail.__kbBound = true;
      rail.addEventListener("click", function () {
        toggleCollapse(rail.getAttribute("data-kb-expand"));
      });
    });
  }

  // ------------------------------------------------------------- 分区折叠

  function readFolds() {
    try {
      var raw = sessionStorage.getItem(FOLD_KEY);
      if (raw) folds = JSON.parse(raw) || {};
    } catch (error) {
      /* 用内存里的 */
    }
  }

  function writeFolds() {
    try {
      sessionStorage.setItem(FOLD_KEY, JSON.stringify(folds));
    } catch (error) {
      /* 存不下就用内存里的 */
    }
  }

  function folded(sectionKey, defaultOpen) {
    if (Object.prototype.hasOwnProperty.call(folds, sectionKey)) return folds[sectionKey] === true;
    return defaultOpen === true;
  }

  /**
   * 折叠/展开一个分区。
   * 直接改 DOM 而不是重渲染整张卡：重渲染会把滚动位置、正在读的公式、
   * 以及 focus 都弄丢，而用户点的只是这一节的头。
   */
  function toggleFold(sectionKey) {
    folds[sectionKey] = !folded(sectionKey, false);
    writeFolds();
    var host = shell();
    var section = host && host.querySelector('[data-kp-sec="' + sectionKey + '"]');
    if (!section) return folds[sectionKey];
    var open = folds[sectionKey];
    section.setAttribute("data-open", open ? "true" : "false");
    var head = section.querySelector(".kp-sec-head");
    if (head) head.setAttribute("aria-expanded", open ? "true" : "false");
    var body = section.querySelector(".kp-sec-body");
    if (body) body.hidden = !open;
    return open;
  }

  // ---------------------------------------------------- 图谱下方的卡片组

  function mechanismSteps(steps) {
    return (Array.isArray(steps) ? steps : [])
      .map(function (step) { return String(step || "").trim(); })
      .filter(Boolean);
  }

  /**
   * 展开/收起只改三处：data-open（状态）、正文的 hidden、按钮文字。
   * 分成两处写就会漏 —— 之前就是 attr 改了而正文还藏着，点"展开"没反应。
   */
  function setCardOpen(card, open) {
    card.setAttribute("data-open", open ? "true" : "false");
    var body = card.querySelector(".kb-mec-body");
    if (body) body.hidden = !open;
    var btn = card.querySelector("[data-kb-mec-toggle]");
    if (btn) {
      btn.textContent = open ? "收起" : "展开";
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      btn.title = open ? "收起" : "展开";
    }
  }

  /* 卡片默认展开：四块内容上下相邻、就是拿来连着读的，
   默认收起就得连点四次才读得到。收起留给"我只想看图"的时刻。 */
  var UNDER_DEFAULT_OPEN = true;

  function underCard(kicker, nodeName, count, key, bodyHtml) {
    var open = UNDER_DEFAULT_OPEN;
    return (
      '<section class="kb-mec" data-kb-card="' + esc(key) + '" data-open="' + (open ? "true" : "false") + '">' +
      '<div class="kb-mec-head">' +
      '<span class="kb-mec-kicker">' + esc(kicker) + "</span>" +
      '<span class="kb-mec-title">' + esc(nodeName) + "</span>" +
      (count ? '<span class="kb-mec-count">' + esc(count) + "</span>" : "") +
      '<button type="button" class="kb-mec-toggle" data-kb-mec-toggle aria-expanded="'
      + (open ? "true" : "false") + '" title="' + (open ? "收起" : "展开") + '">'
      + (open ? "收起" : "展开") + "</button>" +
      "</div>" +
      '<div class="kb-mec-body"' + (open ? "" : " hidden") + ">" + bodyHtml + "</div>" +
      "</section>"
    );
  }

  function mechanismBody(steps) {
    return '<ol class="kb-mec-steps">' + steps
      .map(function (step, i) {
        return '<li class="kb-mec-step"><span class="kb-mec-num" aria-hidden="true">' + (i + 1) + "</span>"
          + '<div class="kb-mec-line">' + inline(step) + "</div></li>";
      })
      .join("") + "</ol>";
  }

  function checksBody(checks) {
    return '<div class="kb-mec-checks">' + checks
      .map(function (item, index) {
        var answer = String((item || {}).answer || "").trim();
        return '<details class="kb-mec-check"' + (index === 0 ? " open" : "") + ">" +
          '<summary class="kb-mec-check-q">' +
          '<span class="kb-mec-check-n">' + (index + 1) + "</span>" +
          "<span>" + inline(item.question) + "</span></summary>" +
          (answer ? '<div class="kb-mec-check-a">' + inline(answer) + "</div>" : "") +
          "</details>";
      })
      .join("") + "</div>";
  }

  /**
   * 图谱下方的一组卡片。推导、自检、依据、笔记这四块都在这里，
   * 护照里只各留一行指引。一块内容都没有时整组隐藏 ——
   * 图谱下方留一块空白比不显示更糟。
   */
  function renderUnderGraph(content, node) {
    var host = document.querySelector("[data-kb-mechanism]");
    if (!host) return;
    var data = content && typeof content === "object" ? content : {};
    var name = (node && node.name) || "";
    var cards = [];

    var steps = mechanismSteps(data.mechanism);
    if (steps.length) {
      cards.push(underCard("推导与机制", name, steps.length + " 步", "mechanism", mechanismBody(steps)));
    }

    var checks = Array.isArray(data.self_check)
      ? data.self_check.filter(function (item) { return String((item || {}).question || "").trim(); })
      : [];
    if (checks.length) {
      cards.push(underCard("自检", name, checks.length + " 题", "checks", checksBody(checks)));
    }

    var grounding = String(data.grounding || "").trim();
    if (grounding) {
      cards.push(underCard("依据与来源", name, "", "grounding",
        '<blockquote class="kb-mec-ground">' + inline(grounding) + "</blockquote>"));
    }

    var noteText = String((node && node.note_content) || "").trim();
    if (noteText) {
      cards.push(underCard("我的笔记", name, "", "note",
        '<div class="kb-mec-note">' + inline(noteText) + "</div>"));
    }

    if (!cards.length) {
      host.hidden = true;
      host.innerHTML = "";
      return;
    }

    host.hidden = false;
    host.setAttribute("data-node", (node && node.node_id) || "");
    host.innerHTML = cards.join("");
  }

  function clearUnderGraph() {
    var host = document.querySelector("[data-kb-mechanism]");
    if (!host) return;
    host.hidden = true;
    host.innerHTML = "";
    host.removeAttribute("data-node");
  }

  // ----------------------------------------------------------------- 分区

  function emptyNote(text) {
    return '<p class="kp-none">' + esc(text) + "</p>";
  }

  function section(key, tone, title, meta, body, defaultOpen) {
    var open = folded(key, defaultOpen);
    var label = SECTION_TONE[tone] || tone;
    return (
      '<section class="kp-sec" data-kp-sec="' + esc(key) + '" data-open="' + (open ? "true" : "false") + '">' +
      '<button type="button" class="kp-sec-head" data-kp-fold="' + esc(key) + '" aria-expanded="' + (open ? "true" : "false") + '">' +
      '<span class="kp-sec-dot kp-dot-' + esc(label) + '" aria-hidden="true"></span>' +
      '<span class="kp-sec-title">' + esc(title) + "</span>" +
      (meta ? '<span class="kp-sec-count">' + esc(meta) + "</span>" : "") +
      '<i class="kp-sec-chev" aria-hidden="true"></i></button>' +
      '<div class="kp-sec-body"' + (open ? "" : " hidden") + ">" + body + "</div>" +
      "</section>"
    );
  }

  /**
   * 递进芯片里的 before/after 是知识点名，不是 id ——
   * 模型写的是"先有极限概念才谈得上差商的极限"那种句子里的人话。
   * 按 id 找不到就退回按名字找；两条路都落空才当作没写。
   */
  function resolveNode(key) {
    if (!key) return null;
    var byId = nodeById(key);
    if (byId) return byId;
    var nodes = (typeof state !== "undefined" && state.nodes) || [];
    for (var i = 0; i < nodes.length; i += 1) {
      if (nodes[i] && nodes[i].name === key) return nodes[i];
    }
    return null;
  }

  function renderProgression(progression) {
    var data = progression && typeof progression === "object" ? progression : {};
    var stops = [
      { key: "before", label: "前置", node: resolveNode(data.before) },
      { key: "current", label: "当前", node: nodeById(view.nodeId) },
      { key: "after", label: "后继", node: resolveNode(data.after) }
    ];
    var has = stops.some(function (stop) { return Boolean(stop.node); });
    if (!has) return emptyNote("这份详解没有写它在图上的位置。");
    var html = '<div class="kp-stops">' + stops.map(function (stop) {
      if (!stop.node) return "";
      var current = stop.key === "current";
      return '<button type="button" class="kp-stop' + (current ? " is-now" : "") + '"' +
        (current ? " disabled" : ' data-kp-jump="' + esc(stop.node.node_id) + '"') + ">" +
        '<span class="kp-stop-label">' + esc(stop.label) + "</span>" +
        '<span class="kp-stop-name">' + esc(stop.node.name) + "</span></button>";
    }).join("") + "</div>";
    if (data.why_order) {
      html += '<p class="kp-why">' + inline(data.why_order) + "</p>";
    }
    return html;
  }

  function renderDefinition(text) {
    var body = String(text || "").trim();
    if (!body) return emptyNote("定义还没写。");
    return '<div class="kp-prose kp-prose-clamp">' + inline(body) + "</div>"
      + '<button type="button" class="kp-more" data-kp-more>展开全部</button>';
  }

  function renderFormulas(items) {
    var list = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!list.length) return emptyNote("这一节还没写公式。");
    return list.map(function (item) {
      return (
        '<figure class="kp-fx">' +
        '<div class="kp-fx-tex">' + renderTex(item.latex, true) + "</div>" +
        '<figcaption class="kp-fx-meta">' +
        (item.meaning ? '<div class="kp-fx-row"><span class="kp-fx-k">含义</span><span class="kp-fx-v">' + inline(item.meaning) + "</span></div>" : "") +
        (item.when ? '<div class="kp-fx-row"><span class="kp-fx-k">用在</span><span class="kp-fx-v">' + inline(item.when) + "</span></div>" : "") +
        "</figcaption></figure>"
      );
    }).join("");
  }

  function renderPitfalls(items) {
    var list = Array.isArray(items) ? items.filter(Boolean) : [];
    var usable = list.filter(function (item) {
      return String(item.wrong || "").trim() || String(item.right || "").trim();
    });
    if (!usable.length) return emptyNote("这一节还没写。");
    return usable.map(function (item) {
      var wrong = String(item.wrong || "").trim();
      var right = String(item.right || "").trim();
      return (
        '<div class="kp-pit">' +
        (wrong
          ? '<div class="kp-pit-side kp-pit-wrong"><span class="kp-pit-sign" aria-hidden="true">✗</span>' +
            '<div><span class="kp-pit-k">常见错法</span><p>' + inline(wrong) + "</p></div></div>"
          : "") +
        (right
          ? '<div class="kp-pit-side kp-pit-right"><span class="kp-pit-sign" aria-hidden="true">✓</span>' +
            '<div><span class="kp-pit-k">正确做法</span><p>' + inline(right) + "</p></div></div>"
          : "") +
        "</div>"
      );
    }).join("");
  }

  function renderRelations(items) {
    var list = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!list.length) return emptyNote("还没标出与相邻知识点的关系。");
    var kindLabel = {
      parent: "上位",
      child: "下位",
      prereq: "前置",
      next: "后继",
      sibling: "同级",
      related: "相关"
    };
    return '<ul class="kp-rels">' + list.map(function (item) {
      var kind = String(item.relation || "related").toLowerCase();
      return (
        "<li>" +
        '<button type="button" class="kp-rel" data-kp-jump-name="' + esc(item.name) + '">' +
        '<span class="kp-rel-name">' + esc(item.name) + "</span>" +
        '<span class="kp-rel-kind kp-rel-' + esc(kind) + '">' + esc(kindLabel[kind] || kind) + "</span>" +
        "</button>" +
        (item.note ? '<p class="kp-rel-note">' + inline(item.note) + "</p>" : "") +
        "</li>"
      );
    }).join("") + "</ul>";
  }

  function countSection(key, items, unit) {
    var list = Array.isArray(items) ? items.filter(Boolean) : [];
    return list.length ? list.length + " " + unit : "";
  }

  function renderSections(content, node) {
    var data = content && typeof content === "object" ? content : {};
    var progression = data.progression || {};
    var mechanism = Array.isArray(data.mechanism) ? data.mechanism : [];
    var formulas = Array.isArray(data.formulas) ? data.formulas : [];
    var pitfalls = Array.isArray(data.pitfalls) ? data.pitfalls : [];
    var relations = Array.isArray(data.relations) ? data.relations : [];
    var checks = Array.isArray(data.self_check) ? data.self_check : [];

    var html = "";

    html += section("progression", "backend", "承接与递进", "", renderProgression(progression), true);
    html += section("definition", "frontend", "定义与符号约定", "", renderDefinition(data.definition), true);
    html += section(
      "formulas", "database", "公式与用法", countSection("formulas", formulas, "条"),
      renderFormulas(formulas), formulas.length > 0
    );

    // 推导、自检、依据、笔记在图谱下方（renderUnderGraph），护照里不再列它们 ——
    // 一份内容只该有一个位置，右侧留着空行反而让人以为右边也有。
    html += section(
      "pitfalls", "security", "易错点", countSection("pitfalls", pitfalls, "组"),
      renderPitfalls(pitfalls), false
    );
    html += section(
      "relations", "messagebus", "与相邻知识点的关系", countSection("relations", relations, "条"),
      renderRelations(relations), false
    );

    return html;
  }

  // ----------------------------------------------------------------- 渲染

  function shell() {
    return document.querySelector("." + HOST_CLASS);
  }

  function renderBody() {
    var node = nodeById(view.nodeId);
    var content = (view.doc && view.doc.content) || {};
    var summary = String(content.summary || "").trim();
    var degraded = content.degraded === true;
    var updated = String((view.doc && view.doc.updated_at) || "");

    // 面包屑只列祖先：当前节点由下方大标题承担，重复一遍是噪音。
    var trail = breadcrumb(view.nodeId);
    var ancestors = trail.slice(0, -1);
    var crumbs = ancestors.length
      ? '<nav class="kp-crumbs" aria-label="知识点层级">' + ancestors
          .map(function (item) {
            return '<button type="button" class="kp-crumb" data-kp-jump="' + esc(item.node_id) + '" title="'
              + esc(item.name) + '">' + esc(item.name) + "</button>";
          })
          .join('<span class="kp-crumb-sep" aria-hidden="true">›</span>')
        + '<span class="kp-crumb-sep" aria-hidden="true">›</span>'
        + '<span class="kp-crumb kp-crumb-now" aria-current="page"></span></nav>'
      : "";

    var head =
      '<header class="kp-head">' +
      (crumbs || '<span class="kp-crumbs"></span>') +
      '<div class="kp-title-row">' +
      '<h2 class="kp-title">' + esc((node && node.name) || "知识点") + "</h2>" +
      '<button type="button" class="kp-collapse" data-kp-collapse aria-label="收起护照" title="收起（Esc 可展开）">‹</button>' +
      '<button type="button" class="kp-close" data-kp-close aria-label="关闭语义护照" title="关闭（Esc）">×</button>' +
      "</div></header>";

    /* 收起条与拖动把手挂在所有分支上：loading / 出错 / 空态时用户同样想收起面板。
     护照两条边都能拖：左缘是与图谱的分界线（往左拖变宽），右缘往里拖变窄。 */
    var chrome =
      '<button type="button" class="kb-grip kb-grip-inner" data-kb-grip="right" '
      + 'aria-label="拖动调整护照宽度" title="拖动调整宽度"></button>'
      + '<button type="button" class="kb-grip kb-grip-outer" data-kb-grip="right" data-kb-grip-invert="true" '
      + 'aria-label="拖动调整护照宽度" title="拖动调整宽度"></button>'
      + '<button type="button" class="kp-rail kb-side-rail" data-kb-expand="right" '
      + 'aria-label="展开语义护照" title="展开语义护照">'
      + '<span class="kb-side-rail-glyph expand" aria-hidden="true"></span>'
      + '<span class="kb-side-rail-label">' + esc((node && node.name) || "护照") + "</span></button>";

    if (view.loading) {
      return head + '<div class="kp-state"><span class="kp-spin" aria-hidden="true"></span><p>正在读取详解…</p></div>' + chrome;
    }
    if (view.error) {
      return head
        + '<div class="kp-state kp-state-err"><p>' + esc(view.error) + "</p>"
        + '<button type="button" class="kp-btn" data-kp-retry>重试</button></div>'
        + chrome;
    }
    if (!view.doc) {
      // 没有详解就没有推导/自检/依据/笔记 —— 图谱下方必须跟着清空，
      // 否则会留着上一个节点的推导，读起来像是这个节点的。
      clearUnderGraph();
      return head
        + '<div class="kp-state">'
        + '<p class="kp-state-lead">这个知识点还没有详解。</p>'
        + '<p class="kp-state-sub">生成时会按「承接与递进 → 定义 → 机制 → 公式 → 易错点 → 相邻关系 → 自检」'
        + "写一份复习用详解，内容只取自这个知识点关联的资料，资料没覆盖的地方会如实标注。</p>"
        + '<div class="kp-state-actions">'
        + '<button type="button" class="kp-btn kp-btn-primary" data-kp-generate>生成详解</button>'
        + '<button type="button" class="kp-btn" data-kp-open-note>打开笔记</button>'
        + "</div></div>"
        + chrome;
    }

    var degradedBar = degraded
      ? '<p class="kp-degraded">这份详解由本地兜底生成（模型这次没返回可用内容），只包含资料里能直接核对的文字。</p>'
      : "";
    var summaryHtml = summary
      ? '<p class="kp-summary">' + inline(summary) + "</p>"
      : '<p class="kp-none kp-summary-none">还没写一句话概括。</p>';

    var actions =
      '<footer class="kp-actions">'
      + '<button type="button" class="kp-btn kp-btn-primary" data-kp-generate data-refresh="true">重新生成</button>'
      + '<button type="button" class="kp-btn" data-kp-open-note>笔记</button>'
      + '<button type="button" class="kp-btn" data-kp-card>生成卡片</button>'
      + '<button type="button" class="kp-btn" data-kp-quiz>生成测验</button>'
      + (updated ? '<span class="kp-stamp">更新于 ' + esc(updated) + "</span>" : "")
      + "</footer>";

    return head
      + '<div class="kp-scroll" data-kp-scroll tabindex="0">'
      + degradedBar
      + summaryHtml
      + renderSections(content, node)
      + '<p class="kp-tail">详解由模型依据关联资料生成，'
      + '<button type="button" class="kp-inline-btn" data-kp-open-md>查看原文 Markdown</button></p>'
      + "</div>"
      + actions
      + chrome;
  }

  function paint() {
    var host = shell();
    if (!host) return;
    var node = nodeById(view.nodeId);
    host.setAttribute("data-tone", toneOf(node));
    host.innerHTML = renderBody();
    host.hidden = false;
    bind(host);
    bindGrips();
    applyTone(host);
    applySides();
    renderUnderGraph(view.doc ? view.doc.content : null, node);
  }

  /** 状态色线走 CSS 变量，随主题/品牌切换，不需要在 JS 里读颜色。 */
  function applyTone(host) {
    var tone = host.getAttribute("data-tone") || "dim";
    host.style.setProperty("--kp-tone", "var(--kp-tone-" + tone + ", var(--line, #ded7ca))");
  }

  // ----------------------------------------------------------------- 数据

  function projectId() {
    return view.projectId || (typeof state !== "undefined" ? state.currentProjectId : "") || "";
  }

  function load(nodeId) {
    view.nodeId = nodeId;
    view.doc = null;
    view.error = "";
    view.loading = true;
    paint();
    api("/api/projects/" + projectId() + "/nodes/" + nodeId + "/doc")
      .then(function (payload) {
        if (view.nodeId !== nodeId) return;
        view.doc = (payload && payload.doc) || null;
        view.loading = false;
        paint();
      })
      .catch(function () {
        if (view.nodeId !== nodeId) return;
        view.loading = false;
        view.error = "读不到这份详解，稍后再试一次。";
        paint();
      });
  }

  function regenerate(refresh) {
    var node = nodeById(view.nodeId);
    if (!node) return;
    api("/api/projects/" + projectId() + "/nodes/" + view.nodeId + "/doc/generate", {
      method: "POST",
      body: refresh ? { refresh: true } : {}
    })
      .then(function (payload) {
        view.doc = (payload && payload.doc) || view.doc;
        view.loading = false;
        view.error = "";
        paint();
      })
      .catch(function () {
        view.error = "这次没能生成出来，稍后再试一次。";
        view.loading = false;
        paint();
      });
  }

  // ----------------------------------------------------------------- 交互

  function jumpToNode(nodeId) {
    var target = nodeById(nodeId);
    if (!target) return;
    if (typeof kbSelectNode === "function") kbSelectNode(nodeId);
    open(nodeId);
  }

  function jumpToNodeByName(name) {
    var nodes = (typeof state !== "undefined" && state.nodes) || [];
    for (var i = 0; i < nodes.length; i += 1) {
      if (nodes[i] && nodes[i].name === name) { jumpToNode(nodes[i].node_id); return; }
    }
  }

  function scrollToSection(key) {
    var host = shell();
    if (!host) return;
    var target = key === "mechanism" || key === "checks" || key === "grounding" || key === "note"
      ? document.querySelector('[data-kb-card="' + key + '"]')
      : host.querySelector('[data-kp-sec="' + key + '"]');
    if (target && target.scrollIntoView) target.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  /* 委托监听器挂在常驻的 host 元素上，而 paint() 每次都重写它的 innerHTML ——
   同一个 host 会被反复 bind，不加锁就会叠出多个监听器。
   叠出来的后果不是"多点几次"，而是 toggleCollapse 被调偶数次：
   收起又立刻展开，用户看着像按钮坏了。 */
  function bind(host) {
    if (host.__kbBound) return;
    host.__kbBound = true;
    host.addEventListener("click", function (event) {
      var target = event.target;

      var foldBtn = target.closest("[data-kp-fold]");
      if (foldBtn) { toggleFold(foldBtn.getAttribute("data-kp-fold")); return; }

      if (target.closest("[data-kp-more]")) {
        var clamp = host.querySelector(".kp-prose-clamp");
        if (clamp) clamp.classList.add("is-open");
        return;
      }

      var jumpById = target.closest("[data-kp-jump]");
      if (jumpById) { jumpToNode(jumpById.getAttribute("data-kp-jump")); return; }

      var jumpByName = target.closest("[data-kp-jump-name]");
      if (jumpByName) { jumpToNodeByName(jumpByName.getAttribute("data-kp-jump-name")); return; }

      if (target.closest("[data-kp-collapse]")) { toggleCollapse("right"); return; }
      if (target.closest("[data-kp-close]")) { close(); return; }
      if (target.closest("[data-kp-retry]")) { load(view.nodeId); return; }

      if (target.closest("[data-kp-generate]")) {
        regenerate(Boolean(target.closest("[data-kp-generate]").getAttribute("data-refresh")));
        return;
      }
      if (target.closest("[data-kp-open-note]")) {
        if (typeof kbOpenNode === "function") kbOpenNode(view.nodeId);
        return;
      }
      if (target.closest("[data-kp-card]")) {
        var node1 = nodeById(view.nodeId);
        if (node1 && typeof kbGenerateCard === "function") kbGenerateCard(node1);
        return;
      }
      if (target.closest("[data-kp-quiz]")) {
        var node2 = nodeById(view.nodeId);
        if (node2 && typeof kbGenerateQuiz === "function") kbGenerateQuiz(node2);
        return;
      }
      if (target.closest("[data-kp-open-md]")) {
        if (typeof kbOpenMarkdown === "function") kbOpenMarkdown(view.nodeId);
        return;
      }
    });
  }

  /* 推导卡片挂在 .framework-view 里，不在护照内部，护照那个委托监听器
     根本看不到它的点击。展开/收起只能挂在 document 上。 */
  document.addEventListener("click", function (event) {
    var toggleBtn = event.target.closest("[data-kb-mec-toggle]");
    if (!toggleBtn) return;
    var card = toggleBtn.closest("[data-kb-card]");
    if (card) setCardOpen(card, card.getAttribute("data-open") !== "true");
  });

  // --------------------------------------------------------------- 对外接口

  function open(nodeId) {
    readFolds();
    readSides();
    var host = shell();
    if (!host) return false;
    host.hidden = false;
    // 点了图上的节点就是想读内容，所以点节点总是展开，不沿用上次的收起态
    if (collapsed.right) {
      collapsed.right = false;
      applySides();
      writeSides();
    }
    document.documentElement.setAttribute("data-kb-passport", "open");
    load(nodeId);
    return true;
  }

  function close() {
    var host = shell();
    if (host) host.hidden = true;
    document.documentElement.removeAttribute("data-kb-passport");
    view.nodeId = "";
    view.doc = null;
    view.error = "";
    view.loading = false;
    clearUnderGraph();
  }

  function toggle(nodeId) {
    if (isOpen() && view.nodeId === nodeId) close();
    else open(nodeId);
  }

  function isOpen() {
    var host = shell();
    return Boolean(host && !host.hidden && view.nodeId);
  }

  function current() {
    var node = nodeById(view.nodeId);
    return {
      nodeId: view.nodeId,
      name: (node && node.name) || "",
      node: node,
      doc: view.doc
    };
  }

  /**
   * renderFramework 会把整个 output.innerHTML 换掉，目录栏随之被替换 ——
   * 这里把宽度与收起态重新落一遍，不重新请求数据。
   */
  function refreshSides() {
    readSides();
    applySides();
    bindGrips();
  }

  function reopen() {
    if (!view.nodeId) return false;
    var host = shell();
    if (!host) return false;
    readFolds();
    readSides();
    host.hidden = false;
    document.documentElement.setAttribute("data-kb-passport", "open");
    paint();
    return true;
  }

  document.addEventListener("keydown", function (event) {
    if (!isOpen()) return;
    if (event.key !== "Escape") return;
    // 只在焦点真的落在护照内部的可编辑元素上才放弃。
    // 早期版本写成「target 是 INPUT 就 return」，结果页面别处残留的输入框
    // （例如刚关闭的笔记面板把焦点留在 textarea 上）会让 Esc 整个失效。
    var target = event.target;
    var editable = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    var host = shell();
    if (editable && host && host.contains(target)) return;
    event.stopPropagation();
    // 收起态下 Esc 先展开、再按才关闭 —— 一次 Esc 就抹掉用户刚做的
    // "我先收起来"会让人以为面板不见了
    if (collapsed.right) {
      collapsed.right = false;
      applySides();
      writeSides();
      return;
    }
    close();
  }, true);

  window.KBPassport = {
    open: open,
    close: close,
    toggle: toggle,
    reopen: reopen,
    isOpen: isOpen,
    current: current,
    refreshSides: refreshSides,
    setLeftCollapsed: function (next) {
      collapsed.left = !!next;
      applySides();
      writeSides();
      return collapsed.left;
    },
    leftCollapsed: function () { return collapsed.left; },
    scrollToSection: scrollToSection
  };
})();
