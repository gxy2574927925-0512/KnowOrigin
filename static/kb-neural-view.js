/* 神经图谱（Neural View）· 沉浸式知识图谱
 * ------------------------------------------------------------------
 * 把「知识框架」画成一张会呼吸的神经网络：中心一颗光球（= 本项目），
 * 顶层知识节点化作围绕光球游动的模块；点模块 → 神经丝伞状展开到它的下级节点；
 * 点节点 → 右侧滑出分析栏。Esc / 面包屑逐层退回。
 *
 * 设计语言借鉴两个上游（均为 PolyForm Noncommercial，**只借设计、不引其代码与素材**）：
 *   · neural-creator-dashboard（luoluo-121）—— 三层递进交互 / 银灰 + 香槟金 / 背景神经网络
 *   · neural-vault（useroneoneone）—— 「目录」索引：把顶层分组列成一份可浏览的清单，
 *     点一行聚焦到那个目录（其余淡出）。知源的「顶层节点」即上游的「一级目录」。
 * 以知源自己的技术栈重写：**不引入 React、不使用它的视频素材**，
 * 光球 / 模块 / 光点全部 CSS 渐变 + Canvas 自绘。
 *
 * 接入方式（刻意不改 app.js）：
 *   本文件是经典脚本，排在 app.js 之后，直接读 app.js 的顶层 state，
 *   并复用它的 nodePalette / statusLabel / escapeHtml / kbOpenNode。
 *   入口按钮由本文件注入到 .graph-toolbar（MutationObserver 跟随重渲染）。
 *   → 删掉 index.html 里的一行 <link> 与一行 <script> 即完全回退。
 *
 * 刻意的取舍（别推翻）：
 * 1. 动的那几条必须等于「我现在关心的那几条」：平时场景是静的，
 *    悬浮 / 选中才点亮对应的神经丝与脉冲。
 * 2. 不做力导向：位置由树结构决定，刷新后位置不变，用户才有空间记忆。
 * 3. 一切动效可被 prefers-reduced-motion 关掉。
 * 4. 每帧先排好下一帧再计算，某帧出错也不会让场景卡死。
 * 5. 目录索引只做「浏览 + 聚焦」，**不改树的形状**：上游靠读文件系统自动分组，
 *    而知源的框架本来就是一棵树、顶层节点即目录 —— 再凭空造一层分组就成了猜结构
 *    （与本项目「不猜结构 / 宁可少，不要假」同一原则）。
 */
(function () {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const OVERLAY_ID = "ko-nv-overlay";
  const BTN_ATTR = "data-kb-neural-open";
  const MAX_CANVAS_DEPTH = 4;   // 背景网络最多画到第几层（更深交给伞状展开看）
  const DIRS_MIN = 3;           // 少于这么多目录就不摆索引（两三个球没什么可浏览的）
  // 上游 neural-creator-dashboard 的素材（PolyForm NC，只读引用；见 NOTICE.md §2.1）。
  // 深色层用它，浅色层回落 CSS 自绘 —— 理由见 syncMedia() 上方注释。
  const MEDIA_BASE = "/static/vendor/neural-creator-dashboard/media/";
  const JELLY_CV = 128;         // 每个模块贴图用的 canvas 边长（显示出来才 ~50px，够了）
  const GOLD = "#e6cf98";
  const SILVER = "#c9d6e0";

  const reducedMotion = () =>
    !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (cur, target, k) => cur + (target - cur) * k;

  function escapeText(value) {
    if (typeof escapeHtml === "function") return escapeHtml(value);
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function paletteOf(node) {
    if (typeof nodePalette === "function") {
      try { return nodePalette(node); } catch (_) { /* 落到兜底 */ }
    }
    const score = Number(node && node.mastery_score) || 0;
    if (score >= 0.8) return { fill: "#fdf0c8", stroke: "#d4a843", lit: "lit" };
    if (score >= 0.35) return { fill: "#dbeafe", stroke: "#4f8cff", lit: "partial" };
    return { fill: "#f4f1ea", stroke: "#c7bfb2", lit: "dim" };
  }

  function labelOf(node) {
    if (typeof statusLabel === "function") {
      try { return statusLabel(node); } catch (_) { /* 落到兜底 */ }
    }
    return node && node.learning_status === "mastered" ? "已掌握" : "未探索";
  }

  function projectId() {
    if (typeof state === "undefined" || !state) return "";
    return state.currentProjectId || "";
  }

  /** 本层跟随知源主题：深色是默认（主场），浅色换成暖纸底（见 styles-neural.css 末尾）。 */
  function isLight() {
    return document.documentElement.getAttribute("data-theme") !== "dark";
  }

  /** 复用 app.js 的 Markdown 渲染器（与知识点文档 / 学习文档同一套），失败才退成纯文本。 */
  function renderMarkdown(md) {
    if (typeof renderStudyTextContent === "function") {
      try { return renderStudyTextContent(md); } catch (_) { /* 落到纯文本 */ }
    }
    return `<pre class="ko-nv-pre">${escapeText(md)}</pre>`;
  }

  // —— 数据模型 ——
  function readNodes() {
    if (typeof state === "undefined" || !state || !Array.isArray(state.nodes)) return [];
    return state.nodes;
  }

  function buildModel(nodes) {
    const byId = new Map(nodes.map((n) => [n.node_id, n]));
    const parentOf = new Map();
    nodes.forEach((n) => {
      if (n.parent_id && n.parent_id !== n.node_id && byId.has(n.parent_id)) parentOf.set(n.node_id, n.parent_id);
    });
    // 环保护：父链出现环就断开该节点，避免递归爆栈（与 buildFrameworkTree 同一策略）
    nodes.forEach((n) => {
      const seen = new Set([n.node_id]);
      let cur = n.node_id;
      while (parentOf.has(cur)) {
        cur = parentOf.get(cur);
        if (seen.has(cur)) { parentOf.delete(n.node_id); break; }
        seen.add(cur);
      }
    });
    const children = new Map(nodes.map((n) => [n.node_id, []]));
    parentOf.forEach((pid, nid) => { const arr = children.get(pid); if (arr) arr.push(nid); });
    children.forEach((ids) => ids.sort((a, b) => {
      const an = byId.get(a), bn = byId.get(b);
      return (an && an.order != null ? an.order : 0) - (bn && bn.order != null ? bn.order : 0)
        || String((an && an.name) || "").localeCompare(String((bn && bn.name) || ""));
    }));
    const roots = nodes.filter((n) => !parentOf.has(n.node_id)).map((n) => n.node_id);

    // 模块 = 顶层节点；只有一个顶层且它有多个子节点时，用它的子节点当模块（否则场景退化成一个球）
    let modules = roots.slice();
    if (modules.length <= 1) {
      const r = modules[0];
      const kids = r ? (children.get(r) || []) : [];
      if (kids.length >= 2) modules = kids.slice();
    }

    const descCount = new Map();
    nodes.forEach((n) => {
      if (!descCount.has(n.node_id)) {
        let total = 0;
        const stack = (children.get(n.node_id) || []).slice();
        const guard = new Set();
        while (stack.length) {
          const id = stack.pop();
          if (guard.has(id)) continue;
          guard.add(id);
          total += 1;
          (children.get(id) || []).forEach((k) => stack.push(k));
        }
        descCount.set(n.node_id, total);
      }
    });

    const avg = nodes.length
      ? nodes.reduce((s, n) => s + (Number(n.mastery_score) || 0), 0) / nodes.length
      : 0;

    return { nodes, byId, parentOf, children, roots, modules, descCount, avg };
  }

  // —— 背景网络的确定性径向布局（刷新后位置不变）——
  function networkLayout(model) {
    const out = new Map();
    const n = Math.max(model.roots.length, 1);
    model.roots.forEach((rid, i) => {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      place(rid, a0, a1, 0);
    });
    function place(id, a0, a1, depth) {
      if (out.has(id) || depth > MAX_CANVAS_DEPTH) return;
      const a = (a0 + a1) / 2;
      const r = 70 + depth * 118;
      out.set(id, { x: Math.cos(a) * r, y: Math.sin(a) * r * 0.8, d: depth });
      const kids = model.children.get(id) || [];
      const span = a1 - a0;
      kids.forEach((k, i) => {
        place(k, a0 + (span * i) / kids.length, a0 + (span * (i + 1)) / kids.length, depth + 1);
      });
    }
    let maxR = 1;
    out.forEach((p) => { maxR = Math.max(maxR, Math.hypot(p.x, p.y)); });
    return { pos: out, maxR };
  }

  // —— 视图状态 ——
  const V = {
    model: null,
    net: null,
    stage: "hub",     // hub | module | note
    mod: null,
    sel: null,
    hover: null,
    focus: null,      // 目录索引里被聚焦的模块（= 顶层节点）；null = 看全部
    dirsCollapsed: null,  // null = 按舞台宽度自动（窄屏默认收起），true/false = 用户手动定的
    railW: 0,         // 目录索引占掉的左侧宽度：图谱往右让这么多，标签才压不到它
    media: { orb: false, jelly: false },   // 上游两个视频是否解码就绪
    mediaOn: false,   // 当前是否启用视频层（深色 + 就绪 + 没开减少动效）
    mediaPlaying: false,
    dom: null,
    raf: 0,
    last: 0,
    time: 0,
    paused: false,
    size: { w: 0, h: 0 },
    cur: { orb: null, mods: new Map(), items: [] },
    // 知识点文档：按 node_id 缓存（生成一次不再重复拉）
    docCache: new Map(),
    docSeq: 0,
    // 问 AI：发散档默认开（与知识点文档页「也讲材料外」默认勾选一致）
    ask: { busy: false, thread: [], extra: true, domA: null, overview: "" }
  };

  function resetCur() {
    V.cur = { orb: { x: 0, y: 0, s: 0, o: 0 }, mods: new Map(), items: [] };
  }

  // —— 目标位置 ——
  function targets() {
    const W = V.size.w, H = V.size.h;
    const narrow = W < 900;
    // 左侧轨道（目录索引）占位：它一展开，图谱整体右移并收窄 —— 否则最左那一圈
    // 模块标签正好落在索引上面（上游的「窗口收窄时自动避让」是同一件事）。
    const railW = V.railW || 0;
    const cx = (W + railW) / 2;
    const availW = Math.max(W - railW, 320);
    const res = { orb: { x: cx, y: H / 2, s: clamp(Math.min(W, H) * 0.34, 140, 250), o: 1 }, mods: new Map(), fan: null, labelX: 0, hub: true };
    const mods = V.model ? V.model.modules : [];
    const m = Math.max(mods.length, 1);

    if (V.stage === "hub") {
      // 标签按「从中心向外」摆放（见 step），模块贴近中心会互相压标签
      const rx = narrow ? availW * 0.32 : Math.min(availW * 0.30, 430);
      const ry = narrow ? H * 0.24 : Math.min(H * 0.26, 205);
      mods.forEach((id, i) => {
        const a = (i / m) * Math.PI * 2 - Math.PI / 2;
        const base = narrow ? 52 : clamp(W * 0.042, 46, 62);
        res.mods.set(id, {
          x: cx + Math.cos(a) * rx,
          y: H / 2 + Math.sin(a) * ry,
          // 聚焦时把那个目录的球放大一档（其余同时淡出，见 step）—— 只动大小不动位置，
          // 位置一变用户刚建立的空间记忆就废了（与「不做力导向」同一条理由）。
          s: base * (V.focus === id ? 1.26 : 1),
          o: 1,
          ax: Math.cos(a), ay: Math.sin(a)
        });
      });
      return res;
    }

    // module / note：光球缩到左侧，模块收成一列小光点（选中的那个放大），条目向右侧伞状展开
    res.hub = false;
    const ox = narrow ? 74 : Math.max(112, W * 0.085);
    res.orb = { x: ox, y: H / 2, s: narrow ? 88 : 112, o: 1 };
    const colX = ox + (narrow ? 62 : 92);
    const gap = clamp((H - 150) / m, 24, 42);
    const selIdx = Math.max(mods.indexOf(V.mod), 0);
    const labelX = colX + 48;
    res.labelX = labelX;
    mods.forEach((id, i) => {
      const isSel = id === V.mod;
      res.mods.set(id, {
        x: colX + (isSel ? 10 : 0),
        y: H / 2 + (i - selIdx) * gap,
        s: isSel ? 60 : 20,
        o: isSel ? 1 : 0.42,
        ax: 1, ay: 0
      });
    });

    const panelW = clamp(W * 0.33, 380, 500);
    const panelLeft = W - panelW - 18;
    const items = V.model ? (V.model.children.get(V.mod) || []) : [];
    const count = items.length;
    const span = Math.min(H - 150, Math.max(0, count - 1) * 46);
    const originX = labelX + 190;
    res.fan = {
      x: Math.max(panelLeft - 262, originX + 24),
      y0: H / 2 - span / 2,
      gap: count > 1 ? span / (count - 1) : 0,
      originX,
      originY: H / 2
    };
    return res;
  }

  // —— 构建外壳（只建一次）——
  function buildShell() {
    const el = document.createElement("div");
    el.id = OVERLAY_ID;
    // 样式挂在这个**类**上而不是 id 上：样式表里所有规则用 `.ko-nv-layer` 作根选择器，
    // 于是第二层沉浸视图（读书的神经图谱 rd-neural-view.js）能直接复用整套材质，
    // 不必把 54 条规则抄一遍。id 保留给探针与外部引用。
    el.className = "ko-nv-layer";
    el.hidden = true;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "神经图谱");
    el.innerHTML = `
      <div class="ko-nv-top">
        <div class="ko-nv-brand">
          <span class="ko-nv-brand-mark" aria-hidden="true"></span>
          <span class="ko-nv-brand-text"><b>神经图谱</b><small>Neural Knowledge Graph</small></span>
        </div>
        <nav class="ko-nv-crumbs" aria-label="图谱路径" hidden>
          <button class="ko-nv-crumb-back" type="button" data-nv-back aria-label="返回上一层">‹</button>
          <button type="button" data-nv-crumb="root">知识图谱</button>
          <span data-nv-crumb-sep hidden>/</span>
          <button type="button" data-nv-crumb="mod" hidden></button>
          <span data-nv-crumb-sep2 hidden>/</span>
          <b data-nv-crumb-node hidden></b>
        </nav>
        <div class="ko-nv-kpis"></div>
        <div class="ko-nv-top-actions">
          <button class="ko-nv-pill" type="button" data-nv-replay>↻ 重播</button>
          <button class="ko-nv-icon-btn" type="button" data-nv-close aria-label="关闭神经图谱">✕</button>
        </div>
      </div>
      <div class="ko-nv-stage" data-stage="hub">
        <canvas class="ko-nv-canvas" aria-hidden="true"></canvas>
        <div class="ko-nv-scene">
          <div class="ko-nv-orb" aria-hidden="true">
            <div class="ko-nv-orb-halo"></div>
            <div class="ko-nv-orb-core"></div>
            <!-- 上游素材（PolyForm NC，见 NOTICE.md §2.1）：只在深色层启用，
                 浅色下 display:none 并把 .ko-nv-orb-core 放回来当兜底。 -->
            <video class="ko-nv-orb-vid" data-nv-media="orb" muted loop playsinline autoplay
              preload="auto" aria-hidden="true"
              poster="${MEDIA_BASE}orb.jpg" src="${MEDIA_BASE}orb.mp4"></video>
          </div>
          <svg class="ko-nv-threads" aria-hidden="true"></svg>
        </div>
        <!-- 水母视频源：只负责解码，画面逐帧 blit 到各模块的小 canvas 上
             （上游做法：一台解码器 + N 次贴图，比 N 个 <video> 轻得多） -->
        <video class="ko-nv-media-src" data-nv-media="jelly" muted loop playsinline autoplay
          preload="auto" aria-hidden="true"
          poster="${MEDIA_BASE}jellyfish.jpg" src="${MEDIA_BASE}jellyfish.mp4"></video>
        <div class="ko-nv-copy">
          <h2>让每一条连线，<br>双向生长。</h2>
          <p>中心是这门知识的核心，四周是它的顶层模块。</p>
          <p class="ko-nv-hint">点击模块，展开它的下级节点 · Esc 逐层返回</p>
        </div>
        <aside class="ko-nv-dirs" data-nv-dirs hidden aria-label="目录索引">
          <header>
            <span class="ko-nv-dirs-title">目录 <em>Directories</em></span>
            <b class="ko-nv-dirs-count" data-nv-dirs-count>0</b>
            <button class="ko-nv-icon-btn ko-nv-dirs-toggle" type="button" data-nv-dirs-toggle
              aria-expanded="true" aria-label="收起目录索引">–</button>
          </header>
          <div class="ko-nv-dirs-list" data-nv-dirs-list></div>
          <footer data-nv-dirs-foot hidden>
            <button class="ko-nv-pill" type="button" data-nv-dirs-all>显示全部</button>
          </footer>
        </aside>
        <p class="ko-nv-stage-hint" hidden>选择一个节点，查看它的全部分析 · Esc 返回</p>
        <div class="ko-nv-empty" hidden></div>
        <aside class="ko-nv-panel" hidden></aside>
      </div>
      <div class="ko-nv-dock">
        <div class="ko-nv-answers" hidden></div>
        <form class="ko-nv-ask">
          <input type="text" placeholder="问问你的知识图谱… Ask your graph" aria-label="向图谱提问" autocomplete="off">
          <button class="ko-nv-send" type="submit" aria-label="提交问题">→</button>
        </form>
        <div class="ko-nv-chips-row"></div>
      </div>`;
    return el;
  }

  // —— 场景：模块与条目 ——
  function renderScene() {
    const d = V.dom;
    const scene = d.scene;
    // 换了模块 → 条目的起点重新从模块边缘长出（伞状展开），不要从上一个模块的旧位置飞过来
    if (V._renderedMod !== V.mod) { V.cur.items = []; V._renderedMod = V.mod; }
    scene.querySelectorAll(".ko-nv-mod, .ko-nv-mod-label, .ko-nv-item").forEach((n) => n.remove());

    const mods = V.model ? V.model.modules : [];
    d.modBtns = new Map();
    d.modLabels = new Map();
    d.modVids = new Map();     // 每个模块贴水母视频的小 canvas
    d.itemBtns = [];

    mods.forEach((id) => {
      const node = V.model.byId.get(id);
      if (!node) return;
      const pal = paletteOf(node);
      const count = V.model.descCount.get(id) || 0;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ko-nv-mod";
      btn.style.setProperty("--nv-mod", pal.stroke);
      btn.setAttribute("aria-label", `${node.name}，${labelOf(node)}，${count} 个下级`);
      // 「发光水母」：伞盖（呼吸光晕）+ 光球本体 + 下垂摆动的触须。
      // 三样都长在按钮**内部**、且只做 transform 动画 —— 按钮自己的尺寸与位置不动，
      // 所以标签摆放与探针量的 boundingBox 一行都不受影响（形态改动对几何是纯增量）。
      btn.innerHTML = `<span class="ko-nv-mod-bell"></span><span class="ko-nv-mod-core"></span>
        <span class="ko-nv-mod-tentacles" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
        <canvas class="ko-nv-mod-vid" width="${JELLY_CV}" height="${JELLY_CV}" aria-hidden="true"></canvas>`;
      btn.addEventListener("click", () => gotoModule(id));
      btn.addEventListener("pointerenter", () => { V.hover = id; });
      btn.addEventListener("pointerleave", () => { if (V.hover === id) V.hover = null; });
      scene.appendChild(btn);

      const label = document.createElement("button");
      label.type = "button";
      label.className = "ko-nv-mod-label";
      label.style.setProperty("--nv-mod", pal.stroke);
      label.tabIndex = -1;
      label.innerHTML = `<span class="ko-nv-mod-name">${escapeText(node.name)}</span>
        <span class="ko-nv-mod-meta"><span class="ko-nv-mod-count">${count}</span><span class="ko-nv-mod-sub">个下级</span><span class="ko-nv-mod-dot"></span><span class="ko-nv-mod-status">${escapeText(labelOf(node))}</span></span>`;
      label.addEventListener("click", () => gotoModule(id));
      label.addEventListener("pointerenter", () => { V.hover = id; });
      label.addEventListener("pointerleave", () => { if (V.hover === id) V.hover = null; });
      scene.appendChild(label);

      d.modBtns.set(id, btn);
      d.modLabels.set(id, label);
      d.modVids.set(id, btn.querySelector(".ko-nv-mod-vid"));
    });

    if (V.stage !== "hub" && V.mod) {
      const items = V.model.children.get(V.mod) || [];
      items.forEach((id) => {
        const node = V.model.byId.get(id);
        if (!node) return;
        const pal = paletteOf(node);
        const score = Math.round((Number(node.mastery_score) || 0) * 100);
        const kids = (V.model.children.get(id) || []).length;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ko-nv-item";
        btn.style.setProperty("--nv-kc", pal.stroke);
        btn.setAttribute("aria-label", `打开 ${node.name} 的分析`);
        btn.innerHTML = `<span class="ko-nv-item-dot"></span>
          <span class="ko-nv-item-body">
            <span class="ko-nv-item-title">${escapeText(node.name)}</span>
            <span class="ko-nv-item-meta"><span>${escapeText(labelOf(node))}</span><span>掌握 <b>${score}%</b></span>${kids ? `<span>${kids} 子项</span>` : ""}</span>
          </span>`;
        btn.addEventListener("click", () => gotoNode(id));
        scene.appendChild(btn);
        d.itemBtns.push({ id, el: btn });
      });
    }

    // 神经丝：光球→模块
    const svg = d.threadsSvg;
    svg.innerHTML = `<defs>
      <filter id="ko-nv-blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3"/></filter>
      <radialGradient id="ko-nv-pulse-out"><stop offset="0" stop-color="#fffaf0"/><stop offset=".4" stop-color="${GOLD}"/><stop offset="1" stop-color="${GOLD}" stop-opacity="0"/></radialGradient>
      <radialGradient id="ko-nv-pulse-in"><stop offset="0" stop-color="#ffffff"/><stop offset=".4" stop-color="#e3b3c4"/><stop offset="1" stop-color="#e3b3c4" stop-opacity="0"/></radialGradient>
    </defs>`;
    d.threads = new Map();
    d.pulses = new Map();
    d.pulsePhase = new Map();   // 每条神经丝的流光相位（悬停提速时靠它平滑过渡）
    mods.forEach((id) => {
      const pal = paletteOf(V.model.byId.get(id) || {});
      const g = document.createElementNS(NS, "g");
      g.setAttribute("style", `color:${pal.stroke}`);
      const glow = document.createElementNS(NS, "path");
      glow.setAttribute("class", "ko-nv-thread-glow");
      glow.setAttribute("filter", "url(#ko-nv-blur)");
      const core = document.createElementNS(NS, "path");
      core.setAttribute("class", "ko-nv-thread-core");
      g.appendChild(glow); g.appendChild(core);
      const dots = [0, 1].map(() => {
        const c = document.createElementNS(NS, "circle");
        c.setAttribute("r", "5");
        c.setAttribute("fill", "url(#ko-nv-pulse-out)");
        g.appendChild(c);
        return c;
      });
      svg.appendChild(g);
      d.threads.set(id, { glow, core });
      d.pulses.set(id, dots);
    });
    d.fanPaths = [];
    d.fanPulses = [];
    if (V.stage !== "hub") {
      (V.model.children.get(V.mod) || []).forEach((id) => {
        const pal = paletteOf(V.model.byId.get(id) || {});
        const g = document.createElementNS(NS, "g");
        g.setAttribute("style", `color:${pal.stroke}`);
        const p = document.createElementNS(NS, "path");
        p.setAttribute("class", "ko-nv-fan");
        const c = document.createElementNS(NS, "circle");
        c.setAttribute("r", "4");
        c.setAttribute("fill", "url(#ko-nv-pulse-out)");
        g.appendChild(p); g.appendChild(c);
        svg.appendChild(g);
        d.fanPaths.push(p);
        d.fanPulses.push(c);
      });
    }
  }

  function renderChrome() {
    const d = V.dom;
    d.stage.dataset.stage = V.stage;
    const crumbs = d.root.querySelector(".ko-nv-crumbs");
    const modNode = V.mod ? V.model.byId.get(V.mod) : null;
    const selNode = V.sel ? V.model.byId.get(V.sel) : null;
    crumbs.hidden = V.stage === "hub";
    const modBtn = crumbs.querySelector("[data-nv-crumb='mod']");
    const sep1 = crumbs.querySelector("[data-nv-crumb-sep]");
    const sep2 = crumbs.querySelector("[data-nv-crumb-sep2]");
    const nodeB = crumbs.querySelector("[data-nv-crumb-node]");
    if (modNode) {
      modBtn.hidden = false; sep1.hidden = false;
      modBtn.textContent = modNode.name;
      modBtn.style.color = paletteOf(modNode).stroke;
    } else { modBtn.hidden = true; sep1.hidden = true; }
    if (selNode) { nodeB.hidden = false; sep2.hidden = false; nodeB.textContent = selNode.name; }
    else { nodeB.hidden = true; sep2.hidden = true; }
    d.hint.hidden = V.stage !== "module";
    renderPanel();
    renderDirs();
  }

  /* —— 目录索引（借鉴 neural-vault 的「图例 + 分组浏览」）——
   * 上游的「一级目录」在知源里就是**顶层节点**（= 本视图的模块），所以这里不新造分组，
   * 只把已有的分组列成一份可滚动的清单：色点 + 名称 + 下级数量。
   * 点一行 = 聚焦那个目录（其余模块与神经丝淡出），再点一次或 Esc 取消。
   * 「目录多时」靠这份清单浏览 —— 16 个球铺在椭圆上时，逐个去认球太慢。 */
  function renderDirs() {
    const d = V.dom;
    if (!d || !d.dirs) return;
    const mods = V.model ? V.model.modules : [];
    const show = V.stage === "hub" && !!V.model && V.model.nodes.length > 0 && mods.length >= DIRS_MIN;
    d.dirs.hidden = !show;
    if (!show) { V.railW = 0; return; }

    d.dirsCount.textContent = String(mods.length);
    d.dirsList.innerHTML = mods.map((id) => {
      const node = V.model.byId.get(id);
      if (!node) return "";
      const pal = paletteOf(node);
      const count = (V.model.children.get(id) || []).length;
      const on = V.focus === id;
      return `<button class="ko-nv-dir${on ? " is-focus" : ""}" type="button" data-nv-dir="${escapeText(id)}"
        style="--nv-dc:${pal.stroke}" aria-pressed="${on ? "true" : "false"}"
        aria-label="${escapeText(node.name)}，${count} 个下级${on ? "，已聚焦" : ""}">
        <i></i><span class="ko-nv-dir-name">${escapeText(node.name)}</span><small>${count}</small></button>`;
    }).join("");
    d.dirsList.querySelectorAll("[data-nv-dir]").forEach((b) => {
      const id = b.getAttribute("data-nv-dir");
      b.addEventListener("click", () => toggleFocus(id));
      b.addEventListener("pointerenter", () => { V.hover = id; });
      b.addEventListener("pointerleave", () => { if (V.hover === id) V.hover = null; });
    });
    d.dirsFoot.hidden = !V.focus;

    // 默认：宽屏展开、窄屏收起（窄屏的球和标签已经贴着边缘，再摆一列清单就没地方了）。
    // 用户点过开关之后就听用户的（dirsCollapsed 不为 null）。
    const collapsed = V.dirsCollapsed === null ? V.size.w < 1000 : V.dirsCollapsed;
    d.dirs.classList.toggle("is-collapsed", collapsed);
    d.dirsToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    d.dirsToggle.textContent = collapsed ? "+" : "–";
    // 展开时给图谱让出左侧一条道（收起只占一颗胶囊，不用让）
    V.railW = collapsed ? 0 : Math.min(V.size.w * 0.42, d.dirs.offsetWidth + 48);
  }

  function toggleFocus(id) {
    if (!V.model || !V.model.byId.has(id)) return;
    V.focus = V.focus === id ? null : id;
    renderDirs();
  }

  function renderPanel() {
    const panel = V.dom.panel;
    const node = V.sel ? V.model.byId.get(V.sel) : null;
    if (!node) { panel.hidden = true; panel.innerHTML = ""; return; }
    const pal = paletteOf(node);
    const score = Math.round((Number(node.mastery_score) || 0) * 100);
    const kids = V.model.children.get(node.node_id) || [];
    const desc = V.model.descCount.get(node.node_id) || 0;
    const parent = V.model.parentOf.get(node.node_id);
    const parentNode = parent ? V.model.byId.get(parent) : null;
    const lvl = score >= 80 ? "high" : score < 35 ? "low" : "";
    const sibs = parent ? (V.model.children.get(parent) || []).filter((x) => x !== node.node_id) : [];

    panel.hidden = false;
    panel.style.setProperty("--nv-kc", pal.stroke);
    panel.innerHTML = `
      <div class="ko-nv-panel-head">
        <span class="ko-nv-panel-cat"><i></i>${escapeText(labelOf(node))}</span>
        <button class="ko-nv-icon-btn" type="button" data-nv-panel-close aria-label="关闭分析栏">✕</button>
      </div>
      <div class="ko-nv-panel-scroll">
        <h3>${escapeText(node.name)}</h3>
        <p class="ko-nv-panel-sub">${parentNode ? `上级：${escapeText(parentNode.name)}` : "顶层节点（无上级）"}</p>
        <div class="ko-nv-metric">
          <header><span>掌握度 <em>Mastery</em></span><span class="ko-nv-lvl ${lvl}">${score >= 80 ? "已掌握" : score >= 35 ? "学习中" : "待推进"}</span></header>
          <div class="ko-nv-metric-body">
            <strong>${score}%</strong>
            <span class="ko-nv-metric-stat">直接下级 <b>${kids.length}</b></span>
            <span class="ko-nv-metric-stat">全部下级 <b>${desc}</b></span>
          </div>
        </div>
        ${kids.length ? `<section class="ko-nv-sec"><h4>下级节点 <em>Children</em></h4><div class="ko-nv-chips">${kids.map((k) => {
          const kn = V.model.byId.get(k); if (!kn) return "";
          const kp = paletteOf(kn);
          return `<button class="ko-nv-chip" type="button" data-nv-chip="${escapeText(k)}" style="--nv-kc:${kp.stroke}"><span>${escapeText(kn.name)}</span><small>${Math.round((Number(kn.mastery_score) || 0) * 100)}%</small></button>`;
        }).join("")}</div></section>` : `<section class="ko-nv-sec"><h4>下级节点</h4><p class="ko-nv-empty-line">这是叶子节点，没有下级。</p></section>`}
        ${sibs.length ? `<section class="ko-nv-sec"><h4>同级节点 <em>Siblings</em></h4><div class="ko-nv-chips">${sibs.map((k) => {
          const kn = V.model.byId.get(k); if (!kn) return "";
          const kp = paletteOf(kn);
          return `<button class="ko-nv-chip" type="button" data-nv-chip="${escapeText(k)}" style="--nv-kc:${kp.stroke}"><span>${escapeText(kn.name)}</span><small>${Math.round((Number(kn.mastery_score) || 0) * 100)}%</small></button>`;
        }).join("")}</div></section>` : ""}
        <section class="ko-nv-sec ko-nv-doc-sec">
          <h4>知识点文档 <em>Document</em><span class="ko-nv-doc-badge" data-nv-doc-badge>读取中</span></h4>
          <div class="ko-nv-doc-body" data-nv-doc-body><p class="ko-nv-empty-line">正在读取文档…</p></div>
        </section>
      </div>
      <div class="ko-nv-panel-foot">
        <button class="ko-nv-pill" type="button" data-nv-open-node>在框架中打开</button>
        ${parentNode ? `<button class="ko-nv-pill" type="button" data-nv-goto-parent>↑ 上级：${escapeText(parentNode.name)}</button>` : ""}
      </div>`;
    panel.querySelector("[data-nv-panel-close]").addEventListener("click", () => gotoModule(V.mod));
    const openBtn = panel.querySelector("[data-nv-open-node]");
    if (openBtn) openBtn.addEventListener("click", () => openInFramework(node.node_id));
    const upBtn = panel.querySelector("[data-nv-goto-parent]");
    if (upBtn && parent) upBtn.addEventListener("click", () => gotoNode(parent));
    panel.querySelectorAll("[data-nv-chip]").forEach((chip) => {
      chip.addEventListener("click", () => gotoNode(chip.getAttribute("data-nv-chip")));
    });
    // 换节点时回到顶部：否则会停在上一节点的滚动位置，把节点名和文档标题都切掉
    const sc = panel.querySelector(".ko-nv-panel-scroll");
    if (sc) sc.scrollTop = 0;
    loadDoc(node.node_id);
  }

  // —— 知识点文档：读 / 生成（侧边栏里的「文档内容」）——
  async function loadDoc(nodeId) {
    const panel = V.dom && V.dom.panel;
    if (!panel) return;
    const pid = projectId();
    const seq = ++V.docSeq;
    const badge = panel.querySelector("[data-nv-doc-badge]");
    if (!pid) {
      const el = panel.querySelector("[data-nv-doc-body]");
      if (el) el.innerHTML = `<p class="ko-nv-empty-line">还没选中项目。</p>`;
      return;
    }
    let doc = V.docCache.get(nodeId);
    if (doc === undefined) {
      if (badge) badge.textContent = "读取中";
      try {
        const resp = await fetch(
          `/api/projects/${encodeURIComponent(pid)}/nodes/${encodeURIComponent(nodeId)}/doc`,
          { credentials: "same-origin" }
        );
        const data = resp.ok ? await resp.json() : null;
        doc = (data && data.doc) || null;
      } catch (_) { doc = null; }
      V.docCache.set(nodeId, doc);
    }
    // 期间用户可能已经切到别的节点 —— 丢弃过期结果，别把 A 的文档贴到 B 上
    if (seq !== V.docSeq || !V.dom || V.dom.panel.hidden || V.sel !== nodeId) return;
    const el = panel.querySelector("[data-nv-doc-body]");
    if (!el) return;
    if (doc && String(doc.content_md || "").trim()) {
      if (badge) badge.textContent = "已生成";
      el.innerHTML = renderMarkdown(doc.content_md);
    } else {
      if (badge) badge.textContent = "未生成";
      el.innerHTML = `<p class="ko-nv-empty-line">这个节点还没有知识点文档。生成后会读该项目的资料，可能要一两分钟。</p>
        <button class="ko-nv-pill" type="button" data-nv-gen-doc>生成知识点文档</button>`;
      const btn = el.querySelector("[data-nv-gen-doc]");
      if (btn) btn.addEventListener("click", () => genDoc(nodeId, btn));
    }
  }

  async function genDoc(nodeId, btn) {
    const pid = projectId();
    if (!pid) return;
    btn.disabled = true;
    btn.textContent = "正在生成…（要读资料，可能一两分钟）";
    try {
      const resp = await fetch(
        `/api/projects/${encodeURIComponent(pid)}/nodes/${encodeURIComponent(nodeId)}/doc`,
        { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" }
      );
      if (!resp.ok) {
        let detail = "";
        try { const d = await resp.json(); detail = (d && d.detail && (d.detail.message || d.detail)) || ""; } catch (_) {}
        throw new Error(detail || `HTTP ${resp.status}`);
      }
      V.docCache.delete(nodeId);
      await loadDoc(nodeId);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "生成失败，点此重试";
      console.error("[神经图谱] 生成知识点文档失败", err);
    }
  }

  function renderKpis() {
    const m = V.model;
    const total = m.nodes.length;
    const mastered = m.nodes.filter((n) => (Number(n.mastery_score) || 0) >= 0.8).length;
    const weak = m.nodes.filter((n) => (Number(n.mastery_score) || 0) < 0.35).length;
    V.dom.kpis.innerHTML = [
      ["节点", "Nodes", total],
      ["模块", "Modules", m.modules.length],
      ["已掌握", "Mastered", mastered],
      ["待推进", "To push", weak]
    ].map(([zh, en, v]) => `<div><span>${zh} <em>${en}</em></span><strong>${v}</strong></div>`).join("");
  }

  // —— 问图谱：本地规则检索（不调模型）——
  function answerQuery(text) {
    const q = String(text || "").trim();
    const m = V.model;
    const cards = [];
    const top = (arr, n) => arr.slice(0, n);
    const byDesc = m.nodes.slice().sort((a, b) => (m.descCount.get(b.node_id) || 0) - (m.descCount.get(a.node_id) || 0));
    const byScore = m.nodes.slice().sort((a, b) => (Number(b.mastery_score) || 0) - (Number(a.mastery_score) || 0));
    const chip = (n) => {
      const p = paletteOf(n);
      return { id: n.node_id, name: n.name, meta: Math.round((Number(n.mastery_score) || 0) * 100) + "%", color: p.stroke };
    };

    if (/核心|枢纽|最重要|中心|主干/.test(q)) {
      const list = top(byDesc.filter((n) => (m.descCount.get(n.node_id) || 0) > 0), 6);
      cards.push({ tone: "gold", title: "最核心的节点", en: "Core nodes", text: list.length ? "按「下级节点数量」排序 —— 撑起最多内容的节点最像主干。" : "目前没有带下级的节点。", items: list.map(chip) });
    }
    if (/掌握|学得|最好|熟练|会了/.test(q)) {
      const list = top(byScore.filter((n) => (Number(n.mastery_score) || 0) > 0), 6);
      cards.push({ tone: "", title: "掌握最好的节点", en: "Best mastered", text: list.length ? `当前平均掌握度 ${Math.round(m.avg * 100)}%。` : "还没有产生掌握度记录。", items: list.map(chip) });
    }
    if (/薄弱|没学|不会|差|补|推进|落后/.test(q)) {
      const list = top(byScore.filter((n) => (Number(n.mastery_score) || 0) < 0.35), 6);
      cards.push({ tone: "", title: "需要推进的节点", en: "To push", text: list.length ? "掌握度低于 35% 的节点，建议优先安排。" : "没有明显薄弱的节点。", items: list.map(chip) });
    }
    if (/前置|基础|起点|从哪|入门/.test(q)) {
      const list = top(m.roots.map((id) => m.byId.get(id)).filter(Boolean), 6);
      cards.push({ tone: "", title: "顶层 / 起点节点", en: "Roots", text: "没有上级的节点 —— 学习顺序通常从这里开始。", items: list.map(chip) });
    }
    if (/来源|不足|缺|未覆盖/.test(q)) {
      const list = top(m.nodes.filter((n) => ["insufficient_source", "missing_prerequisite", "uncovered"].includes(n.coverage_status)), 6);
      cards.push({ tone: "gold", title: "来源不足 / 缺前置", en: "Gaps", text: list.length ? "这些节点的资料覆盖有缺口，答案可信度会打折。" : "没有检测到来源缺口。", items: list.map(chip) });
    }
    if (/多少|数量|统计|几个|几个节点/.test(q)) {
      cards.push({ tone: "", title: "图谱规模", en: "Scale", text: `共 ${m.nodes.length} 个节点、${m.modules.length} 个顶层模块，平均掌握度 ${Math.round(m.avg * 100)}%。`, items: [] });
    }
    if (!cards.length) {
      cards.push({ tone: "", title: "图谱概览", en: "Overview", text: `共 ${m.nodes.length} 个节点、${m.modules.length} 个顶层模块，平均掌握度 ${Math.round(m.avg * 100)}%。可以问「最核心的节点」「需要推进的」「来源不足的」「从哪开始」。`, items: top(byDesc, 4).map(chip) });
    }
    return cards;
  }

  function flash(text) {
    const box = V.dom.answers;
    box.hidden = false;
    box.innerHTML = `<header><span>提示</span><button class="ko-nv-icon-btn" type="button" data-nv-answers-close aria-label="关闭">✕</button></header>
      <article class="ko-nv-card"><p>${escapeText(text)}</p></article>`;
    box.querySelector("[data-nv-answers-close]").addEventListener("click", () => { box.hidden = true; });
  }

  function askHistory() {
    return V.ask.thread
      .filter((m) => !m.pending && !m.error && m.a)
      .map((m) => ({ question: m.q, answer: String(m.a).slice(0, 500) }))
      .slice(-3);
  }

  /** 裸 fetch 读 SSE —— app.js 的 api() 会按 JSON 解析，这里是 text/event-stream。 */
  async function streamAsk(payload, onEvent) {
    const pid = projectId();
    const resp = await fetch(`/api/projects/${encodeURIComponent(pid)}/knowledge-doc/ask`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (resp.status === 401) throw new Error("登录状态已失效，请刷新页面后再试。");
    if (!resp.ok || !resp.body) {
      let detail = "";
      try {
        const d = await resp.json();
        detail = (d && d.detail && (d.detail.message || d.detail)) || "";
      } catch (_) { /* 没有 JSON 就用状态码 */ }
      throw new Error(detail || `提问失败（HTTP ${resp.status}）。`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop();
      for (const part of parts) {
        const line = String(part).trim();
        if (line.indexOf("data:") !== 0) continue;
        try { onEvent(JSON.parse(line.slice(5).trim())); } catch (_) { /* 半截帧丢掉 */ }
      }
    }
  }

  async function askSend(question) {
    const q = String(question || "").trim();
    if (!q || V.ask.busy) return;
    const pid = projectId();
    if (!pid) { flash("先打开一个项目。"); return; }
    const nodeId = V.sel || "";
    const msg = { q, a: "", pending: true, error: "" };
    V.ask.thread.push(msg);
    V.ask.busy = true;
    V.ask.overview = "";
    paintAsk();
    const body = {
      // 选了节点 → 用这一节点的详解做材料；在总览里问 → 用整份合订稿
      scope: nodeId ? "node" : "project",
      node_id: nodeId,
      question: q,
      selection: "",
      section: V.mod ? `模块：${((V.model.byId.get(V.mod) || {}).name) || ""}` : "知识图谱总览",
      history: askHistory(),
      // 发散档：允许模型围绕话题自由发挥、讲材料外的知识（会单独标注来源）
      allow_extra: V.ask.extra,
    };
    try {
      await streamAsk(body, (event) => {
        if (!event || !event.type) return;
        if (event.type === "delta") {
          msg.a += String(event.text || "");
          msg.pending = false;
          // 流式期间只改这一格的纯文本，不做整块 Markdown 重绘
          if (V.ask.domA) V.ask.domA.textContent = msg.a;
        } else if (event.type === "done") {
          msg.a = String(event.text || msg.a);
          msg.pending = false;
          if (V.ask.domA) V.ask.domA.innerHTML = renderMarkdown(msg.a);
        } else if (event.type === "error") {
          msg.pending = false;
          msg.error = String(event.message || "这次没答上来。");
          paintAsk();
        }
      });
    } catch (err) {
      msg.pending = false;
      msg.error = (err && err.message) || "提问失败。";
    }
    msg.pending = false;
    V.ask.busy = false;
    paintAsk();
  }

  function paintAsk() {
    const box = V.dom.answers;
    const th = V.ask.thread;
    if (!th.length && !V.ask.overview) { box.hidden = true; box.innerHTML = ""; V.ask.domA = null; return; }
    box.hidden = false;
    const selNode = V.sel ? V.model.byId.get(V.sel) : null;
    const scopeNote = selNode ? `就「${selNode.name}」` : "就整个图谱";
    box.innerHTML = `<header>
        <span>问 AI <em>Ask</em></span>
        <small>${V.ask.extra ? "发散档 · 材料外也会讲并单独标注" : "严格档 · 材料里没写就直说"}｜${escapeText(scopeNote)}</small>
        <button class="ko-nv-icon-btn" type="button" data-nv-answers-close aria-label="关闭">✕</button>
      </header>
      ${V.ask.overview}
      <div class="ko-nv-thread">${th.map((m, i) => `
        <div class="ko-nv-turn is-q"><span class="ko-nv-mark">问</span><div>${escapeText(m.q)}</div></div>
        <div class="ko-nv-turn is-a"><span class="ko-nv-mark">答</span><div class="ko-nv-a-body" data-nv-a="${i}">${
          m.error ? `<span class="ko-nv-err">${escapeText(m.error)}</span>`
          : m.a ? renderMarkdown(m.a)
          : m.pending ? `<span class="ko-nv-typing">正在回答…</span>` : ""
        }</div></div>`).join("")}</div>`;
    box.querySelector("[data-nv-answers-close]").addEventListener("click", () => { box.hidden = true; });
    box.querySelectorAll("[data-nv-chip]").forEach((chip) => {
      chip.addEventListener("click", () => gotoNode(chip.getAttribute("data-nv-chip")));
    });
    const last = th[th.length - 1];
    V.ask.domA = last && last.pending ? box.querySelector(`[data-nv-a="${th.length - 1}"]`) : null;
    box.scrollTop = box.scrollHeight;
  }

  /** 本地规则速览：结构化事实（谁最核心 / 谁要推进），不调模型，秒出。 */
  function showOverview() {
    if (!V.model.nodes.length) { flash("图谱还是空的，先生成知识框架。"); return; }
    V.ask.overview = answerQuery("图谱概览").map((c) => `<article class="ko-nv-card ${c.tone ? "tone-" + c.tone : ""}">
        <h5>${escapeText(c.title)} <em>${escapeText(c.en || "")}</em></h5>
        <p>${escapeText(c.text)}</p>
        ${c.items && c.items.length ? `<div class="ko-nv-chips">${c.items.map((it) => `<button class="ko-nv-chip" type="button" data-nv-chip="${escapeText(it.id)}" style="--nv-kc:${it.color}"><span>${escapeText(it.name)}</span><small>${escapeText(it.meta)}</small></button>`).join("")}</div>` : ""}
      </article>`).join("");
    paintAsk();
  }

  function resetAsk() {
    V.ask.thread = [];
    V.ask.overview = "";
    V.ask.domA = null;
    if (V.dom && V.dom.answers) { V.dom.answers.hidden = true; V.dom.answers.innerHTML = ""; }
  }

  // —— 导航 ——
  function gotoModule(id) {
    if (!V.model || !V.model.byId.has(id)) return;
    V.focus = null;   // 进到某一层之后就不再是「目录总览」了，聚焦没有意义
    const changed = V.mod !== id || V.sel !== null;
    // 没有下级的模块：没有伞可展开，直接看它自己的分析（否则点了像没反应）
    if (!(V.model.children.get(id) || []).length) {
      V.mod = id; V.sel = id; V.stage = "note";
      renderScene(); renderChrome();
      resetAsk();
      return;
    }
    if (V.mod === id && V.stage !== "hub") { V.sel = null; V.stage = "module"; }
    else { V.mod = id; V.sel = null; V.stage = "module"; }
    renderScene(); renderChrome(); resetFan();
    if (changed) resetAsk();
  }
  function gotoNode(id) {
    if (!V.model || !V.model.byId.has(id)) return;
    const parent = V.model.parentOf.get(id);
    const changed = V.sel !== id;
    if (parent) V.mod = parent;
    V.sel = id; V.stage = "note";
    if (!V.dom.itemBtns.some((x) => x.id === id)) renderScene();
    renderChrome();
    // 换了提问对象 → 上一轮的对话不再适用，清掉（否则答案会串到别的节点上）
    if (changed) resetAsk();
  }
  function back() {
    // 聚焦也算一层：Esc 先取消聚焦，再退节点 / 模块，最后才关浮层
    if (V.focus) { V.focus = null; renderDirs(); return; }
    if (V.sel) { V.sel = null; V.stage = "module"; renderChrome(); }
    else if (V.mod) { V.mod = null; V.stage = "hub"; renderScene(); renderChrome(); }
    else close();
  }
  function openInFramework(nodeId) {
    close();
    setTimeout(() => {
      if (typeof kbOpenNode === "function") { try { kbOpenNode(nodeId); } catch (e) { console.error("[神经图谱] 打开节点失败", e); } }
    }, 60);
  }
  function resetFan() {
    V.dom.itemBtns.forEach(({ el }) => { el.style.opacity = "0"; });
  }

  // —— 动画主循环 ——
  function tick(now) {
    V.raf = requestAnimationFrame(tick);
    try { step(now); } catch (err) {
      if (!V.warned) { V.warned = true; console.error("[神经图谱] 渲染异常（已跳过本帧）", err); }
    }
  }

  /* —— 上游素材：orb.mp4 / jellyfish.mp4 ——
   * 深浅**两套都能用**，只是合成方式不同（都是实测出来的）：
   *   · 深色：jellyfish.mp4 黑底 → `mix-blend-mode: screen` 去底（白底上 screen = 加白会隐形）；
   *           orb.mp4 的浅灰底靠径向遮罩裁掉，深色球体正好压在暗场景上。
   *   · 浅色：jellyfish 换成 `invert(1) hue-rotate(180deg)` + `multiply` ——
   *           黑底反相成白底，multiply 对白底是恒等（等于透明），
   *           于是纸上留下一只**线描质地的水母**，金光也保住了（hue-rotate 把色相转回来）。
   *           orb 直接沿用遮罩版：它在暖纸底上是一颗深色火球，反差正好。
   * 解码失败（文件缺失 / 编解码不支持）一律静默回落 CSS 自绘 ——
   * 仓库里 `*.mp4` 默认是 gitignore 的，缺文件时必须照常能看。 */
  function syncMedia(reduced) {
    const d = V.dom;
    if (!d || !d.vids) return;
    const on = (V.media.orb || V.media.jelly) && !reduced;
    if (on !== V.mediaOn) {
      V.mediaOn = on;
      d.root.classList.toggle("ko-nv-has-video", on);
      // 注意：**不要**在这里顺手把 V.mediaPlaying 归零 —— 那会让下面那条
      // 「状态变了才同步」的判断以为已经同步过，于是开减少动效 / 关层时
      // 视频永远不会被 pause（实测被探针抓到）。
    }
    const play = on && !V.paused && !document.hidden;
    if (play !== V.mediaPlaying) {
      V.mediaPlaying = play;
      d.vids.forEach((v) => {
        if (play) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
        else v.pause();
      });
    }
  }

  // 水母视频 → 各模块的小 canvas。一台解码器 + N 次贴图，
  // 比给 16 个模块各挂一个 <video>（16 台解码器）轻得多。
  function drawJelly(reduced) {
    const d = V.dom;
    if (!V.mediaOn || !V.media.jelly || reduced || V.paused || document.hidden) return;
    const v = d.jellySrc;
    if (!v || !v.videoWidth) return;
    const side = Math.min(v.videoWidth, v.videoHeight);
    // 水母在画面里偏右：从右半边取一个正方形正好把它框住
    const sx = Math.max(0, Math.round((v.videoWidth - side) * 0.72));
    d.modBtns.forEach((btn, id) => {
      const cv = d.modVids.get(id);
      const cur = V.cur.mods.get(id);
      if (!cv || !cur || cur.o < 0.06) return;
      const g = cv.getContext("2d");
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, JELLY_CV, JELLY_CV);
      // 一半镜像、一半原样：同一个源文件也能看出「好几只」的层次
      if ((id || "").length % 2) g.setTransform(-1, 0, 0, 1, JELLY_CV, 0);
      g.drawImage(v, sx, 0, side, side, 0, 0, JELLY_CV, JELLY_CV);
      g.setTransform(1, 0, 0, 1, 0, 0);
    });
  }

  function step(now) {
    const dt = Math.max(0, Math.min(1 / 30, (now - (V.last || now)) / 1000));
    V.last = now;
    const reduced = reducedMotion();
    if (!V.paused && !reduced) V.time += dt;
    const t = V.time;
    const k = reduced ? 1 : Math.min(1, dt * 9);
    const T = targets();
    const d = V.dom;

    // 光球
    const o = V.cur.orb;
    o.x = lerp(o.x, T.orb.x, k); o.y = lerp(o.y, T.orb.y, k);
    o.s = lerp(o.s, T.orb.s, k); o.o = lerp(o.o, T.orb.o, k);
    d.orb.style.transform = `translate3d(${o.x - o.s / 2}px,${o.y - o.s / 2}px,0) scale(${o.s / 420})`;
    d.orb.style.opacity = clamp(o.o, 0, 1);

    // 模块
    T.mods.forEach((tg, id) => {
      let cur = V.cur.mods.get(id);
      if (!cur) { cur = { x: tg.x, y: tg.y, s: tg.s, o: 0 }; V.cur.mods.set(id, cur); }
      cur.x = lerp(cur.x, tg.x, k); cur.y = lerp(cur.y, tg.y, k);
      cur.s = lerp(cur.s, tg.s, k); cur.o = lerp(cur.o, tg.o, k);
      // 目录聚焦：没被选中的模块整体压暗（连同它的标签与神经丝），被选中的那个保持全亮。
      // 乘在 opacity 上而不是改颜色，是为了跟主题无关 —— 深浅两套都不用各写一遍。
      const dim = V.focus && id !== V.focus ? 0.14 : 1;
      const btn = d.modBtns.get(id);
      if (btn) {
        btn.style.transform = `translate3d(${cur.x - cur.s / 2}px,${cur.y - cur.s / 2}px,0) scale(${cur.s / 96})`;
        btn.style.opacity = clamp(cur.o, 0, 1) * dim;
        btn.classList.toggle("is-active", id === V.mod && V.stage !== "hub");
      }
      const label = d.modLabels.get(id);
      if (label) {
        const lw = label.offsetWidth || 150, lh = label.offsetHeight || 48;
        const W = V.size.w, H = V.size.h;
        let lx, ly;
        if (V.stage === "hub") {
          // 从中心向外摆：左右按外侧对齐，正上 / 正下的挪到球外，最后夹回舞台内。
          // 全部压在球下方会在模块密集时互相叠字。
          const ax = tg.ax || 0, ay = tg.ay || 0;
          if (ax > 0.18) lx = cur.x + cur.s / 2 + 10;
          else if (ax < -0.18) lx = cur.x - cur.s / 2 - 10 - lw;
          else lx = cur.x - lw / 2;
          if (ay > 0.5) ly = cur.y + cur.s / 2 + 8;
          else if (ay < -0.5) ly = cur.y - cur.s / 2 - 8 - lh;
          else ly = cur.y - lh / 2;
          lx = clamp(lx, 8, Math.max(8, W - lw - 8));
          ly = clamp(ly, 8, Math.max(8, H - lh - 8));
        } else {
          lx = T.labelX;
          ly = cur.y - lh / 2;
        }
        label.style.transform = `translate3d(${lx}px,${ly}px,0)`;
        // 标签一律压成一行（名称 + 数量）。原来总览是两行（名称 + 数量 + 状态），
        // 但目录索引一展开，椭圆要往右让、半径收窄，两行标签就会在垂直方向叠上
        // （探针量到的相邻标签 y 只差 37px，两行 ~60px 必叠）；一行 ~28px 恰好错开。
        // 状态信息没丢：球体的颜色本来就编码了掌握度，数量在目录索引里另有一份。
        const column = V.stage !== "hub";
        label.classList.add("is-column");
        label.style.opacity = String(clamp(cur.o, 0, 1) * dim * (column && id !== V.mod ? 0.6 : 1));
        label.classList.toggle("is-active", id === V.mod && V.stage !== "hub");
        label.classList.toggle("is-focus", id === V.focus);
        cur.label = { x: lx, y: ly, w: lw, h: lh };
      }
      // 神经丝：光球 → 模块
      const th = d.threads.get(id);
      if (th) {
        const bend = reduced ? 0 : 22 * Math.sin(t * 0.5 + (id || "").length);
        const x1 = o.x + (cur.x - o.x) * 0.18, y1 = o.y + (cur.y - o.y) * 0.18;
        const x2 = cur.x - (cur.x - o.x) * 0.16, y2 = cur.y - (cur.y - o.y) * 0.16;
        const dx = x2 - x1, dy = y2 - y1;
        const dPath = `M${x1},${y1} C${x1 + dx * 0.4 - dy * 0.12 * (bend / 22 || 0)},${y1 + dy * 0.4 + dx * 0.12 * (bend / 22 || 0)} ${x1 + dx * 0.6 + dy * 0.12 * (bend / 22 || 0)},${y1 + dy * 0.6 - dx * 0.12 * (bend / 22 || 0)} ${x2},${y2}`;
        th.glow.setAttribute("d", dPath);
        th.core.setAttribute("d", dPath);
        const active = id === V.mod || id === V.hover || id === V.focus;
        const vis = clamp(cur.o, 0, 1) * (V.stage === "hub" ? 1 : active ? 1 : 0.35) * dim;
        th.glow.style.opacity = String(vis * (active ? 0.85 : 0.35));
        th.core.style.opacity = String(vis);
        // 流光：悬停 / 聚焦时加速（上游「选中或悬停时加快流光」的那一手）。
        // 相位**按 dt 自己累加**，而不是写成 t*speed —— 否则一提速，t*0.3 会直接跳到
        // t*0.78，粒子瞬移一大截，看着像 bug。
        const still = reduced || V.paused;
        const phase = still
          ? (d.pulsePhase.get(id) || 0)
          : ((d.pulsePhase.get(id) || 0) + dt * (active ? 0.85 : 0.3)) % 1;
        d.pulsePhase.set(id, phase);
        (d.pulses.get(id) || []).forEach((c, i) => {
          const u = still ? 0 : ((phase + i * 0.5 + (id || "").length * 0.11) % 1);
          c.setAttribute("cx", String(x1 + dx * u));
          c.setAttribute("cy", String(y1 + dy * u));
          c.style.opacity = still ? "0" : String(vis * Math.sin(u * Math.PI));
        });
      }
    });

    // 伞状展开：模块 → 下级节点
    if (T.fan && V.stage !== "hub") {
      const items = V.model.children.get(V.mod) || [];
      const ox = T.fan.originX, oy = T.fan.originY;
      items.forEach((id, i) => {
        const entry = d.itemBtns[i];
        if (!entry || entry.id !== id) return;
        let cur = V.cur.items[i];
        if (!cur) { cur = { x: ox, y: oy, o: 0 }; V.cur.items[i] = cur; }
        const ty = T.fan.y0 + i * T.fan.gap;
        cur.x = lerp(cur.x, T.fan.x, k);
        cur.y = lerp(cur.y, ty, k);
        cur.o = lerp(cur.o, 1, k);
        entry.el.style.transform = `translate3d(${cur.x}px,${cur.y - 15}px,0)`;
        entry.el.style.opacity = String(clamp(cur.o, 0, 1));
        entry.el.classList.toggle("is-active", id === V.sel);
        const p = d.fanPaths[i];
        if (p) {
          const dx = cur.x - ox;
          p.setAttribute("d", `M${ox},${oy} C${ox + dx * 0.5},${oy} ${cur.x - dx * 0.45},${cur.y} ${cur.x},${cur.y}`);
          const on = id === V.sel;
          p.style.opacity = String(clamp(cur.o, 0, 1) * (V.sel ? (on ? 1 : 0.3) : 0.75));
          p.style.strokeWidth = on ? "1.8" : "1";
          const c = d.fanPulses[i];
          if (c) {
            const u = reduced || V.paused ? 0 : ((t * 0.34 + i * 0.13) % 1);
            c.setAttribute("cx", String(ox + dx * u));
            c.setAttribute("cy", String(oy + (cur.y - oy) * u));
            c.style.opacity = reduced || V.paused ? "0" : String(clamp(cur.o, 0, 1) * Math.sin(u * Math.PI));
          }
        }
      });
    }

    syncMedia(reduced);
    drawJelly(reduced);
    drawCanvas(reduced, t);
  }

  // —— 背景神经网络（Canvas）——
  function drawCanvas(reduced, t) {
    const d = V.dom;
    const canvas = d.canvas;
    const W = V.size.w, H = V.size.h;
    if (!W || !H) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const o = V.cur.orb;
    const cx = o.x || W / 2, cy = o.y || H / 2;
    const scale = Math.min(W * 0.36, H * 0.38) / Math.max(V.net.maxR, 1);
    const sc = scale * (V.stage === "hub" ? 1 : 0.55);
    // 浅色下不能用「加色发光」（lighter）——白底上会越加越白，什么都看不见；
    // 改成普通叠加 + 压深的暖色，靠对比而不是靠亮。
    const light = isLight();

    const posOf = (id) => {
      const p = V.net.pos.get(id);
      if (!p) return null;
      return [cx + p.x * sc, cy + p.y * sc];
    };

    // 连线
    ctx.lineWidth = 0.8;
    V.model.parentOf.forEach((pid, nid) => {
      const a = posOf(pid), b = posOf(nid);
      if (!a || !b) return;
      const both = false;
      ctx.strokeStyle = light ? "rgba(45,42,38,.11)" : (both ? "rgba(230,207,152,.30)" : "rgba(205,208,204,.13)");
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      ctx.quadraticCurveTo(mx, my, b[0], b[1]);
      ctx.stroke();
    });

    // 节点
    V.net.pos.forEach((p, id) => {
      const xy = posOf(id);
      if (!xy) return;
      const node = V.model.byId.get(id);
      if (!node) return;
      const pal = paletteOf(node);
      const r = p.d === 0 ? 3.4 : p.d === 1 ? 2.6 : 2;
      if (light) {
        ctx.globalAlpha = 0.14;
        ctx.fillStyle = pal.stroke;
        ctx.beginPath(); ctx.arc(xy[0], xy[1], r * 2.6, 0, 7); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = pal.stroke;
        ctx.beginPath(); ctx.arc(xy[0], xy[1], r, 0, 7); ctx.fill();
        return;
      }
      ctx.globalCompositeOperation = "lighter";
      const g = ctx.createRadialGradient(xy[0], xy[1], 0, xy[0], xy[1], r * 5);
      g.addColorStop(0, pal.stroke + "66");
      g.addColorStop(1, pal.stroke + "00");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(xy[0], xy[1], r * 5, 0, 7); ctx.fill();
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = pal.stroke;
      ctx.beginPath(); ctx.arc(xy[0], xy[1], r, 0, 7); ctx.fill();
    });

    // 光点：从中心向外飘散
    if (!reduced && V.stage === "hub") {
      ctx.globalCompositeOperation = light ? "source-over" : "lighter";
      const dust = d.dust;
      for (const p of dust) {
        const ph = ((t * p.v + p.o) % 1 + 1) % 1;
        const rr = 60 + ph * Math.min(W, H) * 0.46;
        const a = p.a + ph * p.w;
        const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * 0.94;
        const alpha = Math.pow(Math.max(0, Math.sin(ph * Math.PI)), 1.3) * p.b * (light ? 0.5 : 1);
        const rad = p.s * 2.4;
        const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
        g.addColorStop(0, `rgba(${light ? p.cl : p.c},${alpha})`);
        g.addColorStop(1, `rgba(${light ? p.cl : p.c},0)`);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, rad, 0, 7); ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
    }
  }

  // —— 打开 / 关闭 ——
  function open() {
    const nodes = readNodes();
    V.model = buildModel(nodes);
    V.net = networkLayout(V.model);
    V.dom = V.dom || (function () {
      const el = buildShell();
      document.body.appendChild(el);
      const dom = {
        root: el,
        stage: el.querySelector(".ko-nv-stage"),
        canvas: el.querySelector(".ko-nv-canvas"),
        scene: el.querySelector(".ko-nv-scene"),
        orb: el.querySelector(".ko-nv-orb"),
        threadsSvg: el.querySelector(".ko-nv-threads"),
        threads: new Map(),
        hint: el.querySelector(".ko-nv-stage-hint"),
        empty: el.querySelector(".ko-nv-empty"),
        panel: el.querySelector(".ko-nv-panel"),
        kpis: el.querySelector(".ko-nv-kpis"),
        dirs: el.querySelector("[data-nv-dirs]"),
        dirsList: el.querySelector("[data-nv-dirs-list]"),
        dirsCount: el.querySelector("[data-nv-dirs-count]"),
        dirsFoot: el.querySelector("[data-nv-dirs-foot]"),
        dirsToggle: el.querySelector("[data-nv-dirs-toggle]"),
        answers: el.querySelector(".ko-nv-answers"),
        ask: el.querySelector(".ko-nv-ask"),
        chipsRow: el.querySelector(".ko-nv-chips-row"),
        modBtns: new Map(),
        modLabels: new Map(),
        modVids: new Map(),
        vids: [...el.querySelectorAll("video")],
        jellySrc: el.querySelector('video[data-nv-media="jelly"]'),
        itemBtns: [],
        pulses: new Map(),
        fanPaths: [],
        fanPulses: [],
        dust: Array.from({ length: 84 }, (_, i) => ({
          a: i * 2.39996,
          v: 0.03 + ((i * 37) % 100) / 100 * 0.055,
          o: (i * 0.618034) % 1,
          w: (i % 2 ? 1 : -1) * (0.12 + (i % 7) * 0.04),
          s: 0.6 + (i % 5) * 0.3,
          b: 0.4 + (i % 3) * 0.22,
          // c = 深色场景（加色发光，用亮色）；cl = 浅色场景（普通叠加，用压深的暖色）
          c: ["236,236,232", "230,207,152", "200,205,210", "255,255,255"][i % 4],
          cl: ["176,166,146", "196,164,90", "146,154,162", "116,112,104"][i % 4]
        }))
      };
      // 事件：关闭 / 返回 / 重播 / 问图谱 / 面包屑
      el.querySelector("[data-nv-close]").addEventListener("click", close);
      el.querySelector("[data-nv-back]").addEventListener("click", back);
      el.querySelector("[data-nv-crumb='root']").addEventListener("click", () => { V.mod = null; V.sel = null; V.focus = null; V.stage = "hub"; renderScene(); renderChrome(); });
      el.querySelector("[data-nv-replay]").addEventListener("click", () => {
        V.mod = null; V.sel = null; V.focus = null; V.stage = "hub"; V.time = 0; resetCur();
        renderScene(); renderChrome();
      });
      // 目录索引：收起 / 展开、取消聚焦
      dom.dirsToggle.addEventListener("click", () => {
        const collapsed = dom.dirs.classList.contains("is-collapsed");
        V.dirsCollapsed = !collapsed;
        renderDirs();
      });
      dom.dirsFoot.addEventListener("click", () => { V.focus = null; renderDirs(); });
      dom.ask.addEventListener("submit", (e) => {
        e.preventDefault();
        const input = dom.ask.querySelector("input");
        const text = ((input && input.value) || "").trim();
        if (!text) return;
        if (!V.model.nodes.length) { flash("图谱还是空的，先生成知识框架。"); return; }
        if (input) input.value = "";
        askSend(text);
      });
      // 「发散」开关：默认开 —— 允许 AI 围绕话题自由发挥、讲材料外的东西（会单独标注）
      dom.chipsRow.innerHTML = `<button type="button" class="ko-nv-mode" data-nv-extra aria-pressed="true" title="发散：允许 AI 围绕话题自由发挥、讲材料外的知识（会单独标注）"><i></i>发散</button>
        <span>试问</span>` +
        ["最核心的节点", "需要推进的", "来源不足的", "从哪开始"].map((x) => `<button type="button" data-nv-quick>${x}</button>`).join("") +
        `<button type="button" data-nv-overview title="本地规则速览：结构化事实，不调模型">图谱速览</button>`;
      const extraBtn = dom.chipsRow.querySelector("[data-nv-extra]");
      extraBtn.addEventListener("click", () => {
        V.ask.extra = !V.ask.extra;
        extraBtn.setAttribute("aria-pressed", V.ask.extra ? "true" : "false");
        extraBtn.classList.toggle("is-off", !V.ask.extra);
        if (!dom.answers.hidden) paintAsk();
      });
      dom.chipsRow.querySelectorAll("[data-nv-quick]").forEach((b) => {
        b.addEventListener("click", () => askSend(b.textContent));
      });
      dom.chipsRow.querySelector("[data-nv-overview]").addEventListener("click", showOverview);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !e.isComposing) { e.stopPropagation(); back(); }
      });
      /* 本层是**模态全屏层**，挂在 body 上、不在 .studio-panel 里。
         而 app.js 有一条「点在 .studio-panel 之外 → collapseStudio()」的全局点击处理
         （以及 handleStudioFocusKeydown 的 Esc → collapseStudio）。
         不拦的话：用户在神经图谱里点任何一下，底下的知识框架视图就被折叠掉，
         一关浮层就只剩对话区 —— 看起来像「用完这个功能把页面搞坏了」。
         在**本层根节点冒泡阶段**截住即可：元素自己的处理器已经跑完，只是不再往外传。 */
      const swallow = (e) => e.stopPropagation();
      ["pointerdown", "mousedown", "click", "dblclick", "contextmenu"].forEach((t) => el.addEventListener(t, swallow));
      el.addEventListener("keydown", (e) => e.stopPropagation());
      // Esc 兜底：焦点不在浮层内（例如刚点了舞台空白）时，overlay 收不到 keydown，
      // 所以在 window 捕获阶段拦一道，保证「随时能按 Esc 返回」。
      window.addEventListener("keydown", (e) => {
        if (e.key !== "Escape" || e.isComposing) return;
        if (!dom.root.hidden) { e.stopImmediatePropagation(); e.preventDefault(); back(); }
      }, true);
      return dom;
    })();

    V.dom.root.hidden = false;
    document.body.classList.add("ko-nv-open");
    V.time = 0; V.paused = false; V.warned = false;
    V.stage = "hub"; V.mod = null; V.sel = null; V.hover = null; V.focus = null;
    V._renderedMod = undefined;
    // 视频：每次打开重新探一次就绪状态（文件可能刚被补上/删掉），
    // 失败就静默回落 CSS 自绘，绝不抛错。
    V.media = { orb: false, jelly: false };
    V.mediaOn = false; V.mediaPlaying = false;
    V.dom.vids.forEach((v) => {
      const kind = v.dataset.nvMedia;
      if (!kind) return;
      const mark = () => { V.media[kind] = true; };
      if (v.readyState >= 2) mark();
      v.addEventListener("loadeddata", mark);
      v.addEventListener("error", () => { V.media[kind] = false; });
    });
    V.docCache.clear();
    resetCur();
    resetAsk();

    const hasNodes = V.model.nodes.length > 0;
    V.dom.empty.hidden = hasNodes;
    V.dom.empty.innerHTML = hasNodes ? "" :
      `<h3>这张图谱还没有点亮</h3><p>先在学习工作台「生成 / 更新知识框架」，或在左侧框架目录新增节点，再回到这里。</p>`;
    V.dom.kpis.style.display = hasNodes ? "" : "none";
    V.dom.ask.style.display = hasNodes ? "" : "none";
    V.dom.chipsRow.style.display = hasNodes ? "" : "none";

    measure();
    // 光球从中心「长出来」：起点放在舞台中心、尺寸 0，开场更像点亮而不是从左上角飞入
    V.cur.orb = { x: V.size.w / 2, y: V.size.h / 2, s: 0, o: 0 };
    renderScene();
    renderChrome();
    renderKpis();
    V.dom.answers.hidden = true;

    if (!V.raf) { V.last = performance.now(); V.raf = requestAnimationFrame(tick); }
    const focusEl = V.dom.root.querySelector("[data-nv-close]");
    if (focusEl) focusEl.focus({ preventScroll: true });
  }

  function close() {
    if (!V.dom || V.dom.root.hidden) return;
    V.dom.root.hidden = true;
    document.body.classList.remove("ko-nv-open");
    if (V.raf) { cancelAnimationFrame(V.raf); V.raf = 0; }
    // 关层就把视频停下：别在看不见的地方继续解码烧电
    V.mediaPlaying = false;
    V.mediaOn = false;
    V.dom.root.classList.remove("ko-nv-has-video");
    if (V.dom.vids) V.dom.vids.forEach((v) => v.pause());
  }

  function measure() {
    if (!V.dom) return;
    const stage = V.dom.stage;
    V.size = { w: stage.clientWidth, h: stage.clientHeight };
  }

  // —— 入口按钮：注入图谱工具栏（不改 app.js）——
  let mo = null, moHost = null, moPending = false;
  function ensureEntryButton() {
    const toolbar = document.querySelector(".framework-view .graph-toolbar");
    if (!toolbar) return;
    if (toolbar.querySelector("[" + BTN_ATTR + "]")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "graph-export-btn kb-neural-open-btn";
    btn.setAttribute(BTN_ATTR, "1");
    btn.textContent = "神经图谱";
    btn.title = "全屏神经图谱：光球 + 模块 + 伞状展开";
    btn.addEventListener("click", open);
    const exp = toolbar.querySelector(".graph-export");
    if (exp) toolbar.insertBefore(btn, exp); else toolbar.appendChild(btn);
  }

  function hookToolbar() {
    ensureEntryButton();
    const host = document.getElementById("studio-output") || document.body;
    if (host === moHost) return;
    if (mo) mo.disconnect();
    mo = new MutationObserver(() => {
      if (moPending) return;
      moPending = true;
      requestAnimationFrame(() => { moPending = false; ensureEntryButton(); });
    });
    mo.observe(host, { childList: true, subtree: true });
    moHost = host;
  }

  function boot() {
    hookToolbar();
    window.addEventListener("resize", () => { if (V.dom && !V.dom.root.hidden) measure(); });
    // 项目切换 / 图谱重绘后，state.nodes 会变；下次打开时重新读即可，这里只需保证按钮在
    window.addEventListener("knoworigin:project-changed", hookToolbar);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.KbNeuralView = { open: open, close: close, _view: V };
})();
