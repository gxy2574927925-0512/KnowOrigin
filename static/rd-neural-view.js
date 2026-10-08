/* 读书 · 神经图谱（Reading Neural View）· 沉浸式跨书知识网络
 * ------------------------------------------------------------------
 * 把「读书」模块里那张跨书知识网画成一张会呼吸的神经网络：
 *   第一层 光球 = 整张网，四周是**领域**（图的连通分量，也就是这张网自己长出来的分组）；
 *   第二层 点开一个领域 → 领域收成一列，概念按 BFS 分层放射展开，
 *          边按**类型**画出来（6 种 kind 各一种线型，只有「对立」单独一色）；
 *   第三层 点一个概念 → 右侧概念卡：被几本书支持 / 类型化的关联概念 / 来源书单。
 *
 * 与「知识框架」那个神经图谱（kb-neural-view.js）的关系：
 *   同一个视觉语言、同一套 `.ko-nv-layer` 材质（styles-neural.css），
 *   但**数据模型完全不同，所以是另一个文件而不是复用**：
 *   那边是**树**（父子节点），这边是**图**（类型化的边 + 连通分量 + 割点）。
 *   所以这边没有「下级 / 同级」，换成「关联概念（按关系类型分组）」。
 *
 * 三个必须说清楚的事实（决定了这套映射为什么长这样）：
 * 1. `analyze().clusters` 是**连通分量** —— 按定义，簇与簇之间**不可能有边**。
 *    所以第一层画不出「模块之间的连线」，那是数据本身没有的东西（不猜结构）。
 *    模块之间唯一真实的连线是**合并候选**（同一件事的不同叫法，待用户确认），
 *    用虚线画出来并明确标注「待确认」—— 它是**候选**，不是既成事实。
 * 2. 「桥」是**簇内的割点**，不是两个簇之间的桥。去掉它，它所在的那个领域会裂开。
 *    所以桥的舞台在第二层：金色放大 + 「去掉它这个领域会裂成 N 块」。
 * 3. 成熟度（孤证 / 待验证 / 已成熟）只看「被几本书支持」这一条客观事实，
 *    不引入人工标记 —— 与 core/knowledge_net.py 的口径完全一致。
 *
 * 配色纪律：整层只有一个强调色（香槟金 = 桥），外加一个语义色（红 = 两本书说法冲突）。
 * 其余关系一律中性银灰，靠线型区分 —— 高级感来自克制，不是来自颜色多。
 *
 * 接入方式（刻意不改 reading.js）：
 *   本文件是经典脚本，排在 reading.js 之后；入口按钮由本文件注入到
 *   「知识网络」页签的 .rd-head（MutationObserver 跟随重渲染）。
 *   → 删掉 index.html 里的一行 <link> 与一行 <script> 即完全回退。
 *
 * 刻意的取舍（别推翻）：
 * 1. 不做力导向：位置由「连通分量 + BFS 层」决定，刷新后位置不变，用户才有空间记忆。
 * 2. 平时场景是静的，悬浮 / 选中才点亮对应的边与脉冲 ——
 *    动的那几条必须等于「我现在关心的那几条」。
 * 3. 一切动效可被 prefers-reduced-motion 关掉。
 * 4. 每帧先排好下一帧再计算，某帧出错也不会让场景卡死。
 */
(function () {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const OVERLAY_ID = "ko-rn-overlay";
  const BTN_ATTR = "data-rd-neural-open";
  const LOOSE_ID = "__loose__";     // 孤立概念合成的那个模块（不是图长出来的，标出来）
  const MAX_LOOSE = 60;             // 孤立概念最多画这么多个，再多只报数
  const ASK_CONTEXT_LIMIT = 14000;  // 送进模型的网文本上限（超了截断，别把整张网硬塞）

  // 6 种关系：线型区分 + 有向性。与 core/knowledge_net.py 的 EDGE_TYPES 一一对应。
  const EDGE_KINDS = {
    same:       { label: "同一件事", cls: "",            directed: false, hint: "两本书用不同叫法说同一个概念" },
    prereq:     { label: "前置",     cls: "",            directed: true,  hint: "先懂 A 才可能懂 B" },
    extends:    { label: "延伸",     cls: "is-dashed",   directed: true,  hint: "A 是 B 的特例或深化" },
    contrast:   { label: "对立",     cls: "is-contrast", directed: false, hint: "两本书说法冲突 —— 必须显式呈现，不要和稀泥" },
    analogy:    { label: "类比",     cls: "is-dotted",   directed: false, hint: "跨域隐喻，把想法翻译成模型" },
    applies_to: { label: "应用",     cls: "is-dashdot",  directed: true,  hint: "概念 → 它适用的场景" },
  };
  const EDGE_ORDER = ["contrast", "prereq", "extends", "same", "analogy", "applies_to"];
  const STAGE_LABEL = { mature: "已成熟", draft: "待验证", stub: "孤证" };
  // 成熟度 → 侧栏徽标的样式（复用 styles-neural.css 里已有的 .ko-nv-lvl.high/.low）
  const STAGE_LVL = { mature: "high", draft: "", stub: "low" };

  const reducedMotion = () =>
    !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (cur, target, k) => cur + (target - cur) * k;

  function escapeText(value) {
    if (typeof window.escapeHtml === "function") return window.escapeHtml(value);
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /** 复用 app.js 的 Markdown 渲染器（与读书收获同一套），失败才退成纯文本。 */
  function renderMarkdown(md) {
    if (typeof window.renderStudyReportMarkdown === "function") {
      try {
        const html = window.renderStudyReportMarkdown(md);
        if (html) return html;
      } catch (_) { /* 落到纯文本 */ }
    }
    return `<pre class="ko-nv-pre">${escapeText(md)}</pre>`;
  }

  function toast(msg, variant) {
    try {
      if (typeof window.showToast === "function") { window.showToast(msg, { variant: variant || "info" }); return; }
    } catch (_) { /* 忽略 */ }
    if (variant === "error") console.warn("[读书神经图谱]", msg);
  }

  /** 本层跟随知源主题：深色是默认（主场），浅色换成暖纸底（见 styles-neural.css 末尾）。 */
  function isLight() {
    return document.documentElement.getAttribute("data-theme") !== "dark";
  }

  // —— 配色：只有两个语义色（金 = 桥 / 红 = 对立），其余全部中性 ——
  const TONE = {
    gold:   { dark: "#e6cf98", light: "#a9822a" },
    silver: { dark: "#c9d6e0", light: "#5d6b78" },
    dim:    { dark: "#8d918e", light: "#a9a396" },
  };
  const pick = (tone) => (isLight() ? tone.light : tone.dark);

  // ==================================================================
  // 模型
  // ==================================================================

  function buildModel(data) {
    const nodes = (data.nodes || []).filter((n) => n && n.concept_key);
    const edges = (data.edges || []).filter((e) => e && e.source && e.target && e.source !== e.target);
    const byKey = new Map(nodes.map((n) => [n.concept_key, n]));

    const support = new Map();
    (data.support || []).forEach((s) => { if (s && s.concept_key) support.set(s.concept_key, s); });
    const bridges = new Map();
    (data.bridges || []).forEach((b) => { if (b && b.concept_key) bridges.set(b.concept_key, b); });
    const hubs = new Map();
    (data.hubs || []).forEach((h) => { if (h && h.concept_key) hubs.set(h.concept_key, h); });

    // 邻接（无向）—— 度数、BFS 分层、Canvas 背景网络都用它
    const adj = new Map();
    const link = (a, b) => {
      if (!adj.has(a)) adj.set(a, new Set());
      if (b !== a) adj.get(a).add(b);
    };
    edges.forEach((e) => { link(e.source, e.target); link(e.target, e.source); });
    const degree = (k) => (adj.get(k) || new Set()).size;

    // 簇 = 连通分量（以后端为准；没被覆盖到的节点各自成簇，绝不让节点掉出界面）
    const clusterOf = new Map();
    const groups = new Map();
    (data.clusters || []).forEach((group, i) => {
      const list = (group || []).filter((k) => byKey.has(k));
      if (!list.length) return;
      const id = (data.cluster_keys && data.cluster_keys[list[0]]) || ("cl" + i);
      list.forEach((k) => clusterOf.set(k, id));
      groups.set(id, list);
    });
    nodes.forEach((n) => {
      if (clusterOf.has(n.concept_key)) return;
      const id = "solo:" + n.concept_key;
      clusterOf.set(n.concept_key, id);
      groups.set(id, [n.concept_key]);
    });

    const nameOf = (k) => (byKey.get(k) || {}).name || k;
    const stageOf = (k) => (support.get(k) || {}).stage || "stub";
    const bookCountOf = (k) => Number((support.get(k) || {}).book_count) || 0;
    const booksOf = (k) => ((support.get(k) || {}).books || (byKey.get(k) || {}).books || []).slice();
    const isBridge = (k) => bridges.has(k);

    const byWeight = (a, b) => degree(b) - degree(a) || String(nameOf(a)).localeCompare(String(nameOf(b)));

    // 连通分量按「大小 → 最大度数 → 名字」排序，位置才稳定
    const connected = [...groups.entries()]
      .filter(([, keys]) => keys.length >= 2)
      .sort((a, b) => b[1].length - a[1].length
        || Math.max(...b[1].map(degree)) - Math.max(...a[1].map(degree))
        || String(nameOf(a[1].slice().sort(byWeight)[0])).localeCompare(String(nameOf(b[1].slice().sort(byWeight)[0]))));
    // 孤证概念（只自己一个、没有任何连线）合成一个模块。
    // 这是一个**合成**模块，不是图自己长出来的 —— 界面上用虚线框标出来，不冒充结构。
    const looseKeys = [...groups.values()].filter((keys) => keys.length === 1).map((keys) => keys[0]).sort(byWeight);

    const modules = connected.map(([id]) => id);
    if (looseKeys.length) modules.push(LOOSE_ID);

    const infoCache = new Map();
    function info(id) {
      if (infoCache.has(id)) return infoCache.get(id);
      let out;
      if (id === LOOSE_ID) {
        out = {
          id, keys: looseKeys.slice(0, MAX_LOOSE), size: looseKeys.length, loose: true,
          name: "未连接的概念", bridgeKeys: [],
        };
      } else {
        const keys = (groups.get(id) || []).slice().sort(byWeight);
        out = {
          id, keys, size: keys.length, loose: false,
          name: keys.length ? nameOf(keys[0]) : "（空领域）",
          bridgeKeys: keys.filter(isBridge),
          topKey: keys[0] || "",
        };
      }
      infoCache.set(id, out);
      return out;
    }

    /** 一个概念属于哪个模块（孤立概念全部归到合成模块）。 */
    function moduleIdOf(key) {
      const cid = clusterOf.get(key);
      const keys = groups.get(cid);
      if (!keys) return LOOSE_ID;
      return keys.length === 1 ? LOOSE_ID : cid;
    }

    const edgesOf = new Map();
    edges.forEach((e) => {
      if (!edgesOf.has(e.source)) edgesOf.set(e.source, []);
      edgesOf.get(e.source).push(e);
      if (!edgesOf.has(e.target)) edgesOf.set(e.target, []);
      edgesOf.get(e.target).push(e);
    });

    // 合并候选（待确认的跨模块关联）—— 唯一的「模块之间」连线来源
    const candidates = (data._candidates || [])
      .filter((c) => c && c.left && c.right && moduleIdOf(c.left) !== moduleIdOf(c.right))
      .slice(0, 24);

    const summary = data.summary || {};
    return {
      nodes, edges, byKey, adj, degree, support, bridges, hubs,
      clusterOf, groups, connected, looseKeys, modules, info, moduleIdOf,
      edgesOf, candidates, nameOf, stageOf, bookCountOf, booksOf, isBridge,
      avgDegree: nodes.length ? edges.length * 2 / nodes.length : 0,
      summary,
      methodologies: data.methodologies || [],
    };
  }

  /** 整张网的确定性径向布局（Canvas 背景用）：每个领域放在一个角度上，概念散在它周围。 */
  function networkLayout(model) {
    const out = new Map();
    const n = Math.max(model.modules.length, 1);
    model.modules.forEach((mid, i) => {
      const items = model.info(mid).keys;
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const cx = Math.cos(a) * 0.62, cy = Math.sin(a) * 0.62 * 0.82;
      const k = items.length;
      const rad = Math.min(0.34, 0.06 + 0.06 * Math.sqrt(k));
      items.forEach((key, j) => {
        if (k === 1) { out.set(key, { x: cx, y: cy, d: 1 }); return; }
        const t = (j / k) * Math.PI * 2 - Math.PI / 2;
        out.set(key, { x: cx + Math.cos(t) * rad, y: cy + Math.sin(t) * rad * 0.9, d: 1 });
      });
    });
    let maxR = 1;
    out.forEach((p) => { maxR = Math.max(maxR, Math.hypot(p.x, p.y)); });
    return { pos: out, maxR };
  }

  // ==================================================================
  // 视图状态
  // ==================================================================
  const V = {
    model: null,
    net: null,
    stage: "hub",          // hub | module | note
    mod: null,
    sel: null,
    hover: null,
    dom: null,
    raf: 0,
    last: 0,
    time: 0,
    paused: false,
    warned: false,
    size: { w: 0, h: 0 },
    cur: { orb: null, mods: new Map(), nodes: new Map() },
    _renderedMod: undefined,
    // 概念详解：按 concept_key 缓存（生成一次不再重复拉）。docSeq 用来丢弃过期响应 ——
    // 切概念比请求返回快时，A 的详解会被贴到 B 上。
    docCache: new Map(),
    docSeq: 0,
    ask: { busy: false, thread: [], domA: null, overview: "" },
  };

  function resetCur() {
    V.cur = { orb: { x: 0, y: 0, s: 0, o: 0 }, mods: new Map(), nodes: new Map() };
  }

  /** BFS 分层：以簇心（度数最高的概念）为第 0 层，层内按度数降序 —— 确定性，不用力导向。 */
  function bfsLevels(model, keys) {
    const inSet = new Set(keys);
    const level = new Map();
    if (!keys.length) return { level, max: 0 };
    const root = keys.slice().sort((a, b) => model.degree(b) - model.degree(a)
      || String(model.nameOf(a)).localeCompare(String(model.nameOf(b))))[0];
    level.set(root, 0);
    const queue = [root];
    while (queue.length) {
      const cur = queue.shift();
      (model.adj.get(cur) || new Set()).forEach((nb) => {
        if (!inSet.has(nb) || level.has(nb)) return;
        level.set(nb, level.get(cur) + 1);
        queue.push(nb);
      });
    }
    keys.forEach((k) => { if (!level.has(k)) level.set(k, 0); });
    let max = 0;
    level.forEach((d) => { if (d > max) max = d; });
    // 全是孤立概念（未连接模块）时，全部摆到同一环上 —— 否则会在圆心叠成一坨
    if (max === 0 && keys.length > 1) {
      keys.forEach((k) => level.set(k, 1));
      max = 1;
    }
    return { level, max };
  }

  // —— 目标位置 ——
  function targets() {
    const W = V.size.w, H = V.size.h;
    const narrow = W < 900;
    const res = {
      orb: { x: W / 2, y: H / 2, s: clamp(Math.min(W, H) * 0.34, 140, 250), o: 1 },
      mods: new Map(), nodes: new Map(), hub: true, labelX: 0, centerY: H / 2,
    };
    const mods = V.model ? V.model.modules : [];
    const m = Math.max(mods.length, 1);

    if (V.stage === "hub") {
      const rx = narrow ? W * 0.32 : Math.min(W * 0.30, 430);
      const ry = narrow ? H * 0.24 : Math.min(H * 0.26, 205);
      mods.forEach((id, i) => {
        const a = (i / m) * Math.PI * 2 - Math.PI / 2;
        res.mods.set(id, {
          x: W / 2 + Math.cos(a) * rx,
          y: H / 2 + Math.sin(a) * ry,
          s: narrow ? 50 : clamp(W * 0.040, 44, 60),
          o: 1,
          ax: Math.cos(a), ay: Math.sin(a),
        });
      });
      return res;
    }

    // module / note：光球缩到左侧，模块收成一列小光点（选中的放大），概念向右放射展开
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
        s: isSel ? 58 : 20,
        o: isSel ? 1 : 0.42,
        ax: 1, ay: 0,
      });
    });

    // 概念层：以簇心为原点做 BFS 分层，层内按角度均分
    const panelW = clamp(W * 0.33, 380, 500);
    const panelLeft = W - panelW - 18;
    const areaLeft = labelX + (narrow ? 96 : 128);
    const areaRight = Math.max(areaLeft + 160, panelLeft - 26);
    const cx = areaLeft + (areaRight - areaLeft) * 0.44;
    const cy = H / 2;
    res.centerY = cy;
    const items = V.model ? V.model.info(V.mod).keys : [];
    const { level, max } = V.model ? bfsLevels(V.model, items) : { level: new Map(), max: 0 };
    const span = Math.max(60, Math.min((areaRight - areaLeft) / 2, (H - 170) / 2));
    const radius = (d) => (d <= 0 ? 0 : span * (0.42 + 0.58 * (max > 1 ? (d - 1) / (max - 1) : 0)));
    const buckets = new Map();
    items.forEach((k) => {
      const d = level.get(k) || 0;
      if (!buckets.has(d)) buckets.set(d, []);
      buckets.get(d).push(k);
    });
    buckets.forEach((list, d) => {
      list.sort((a, b) => V.model.degree(b) - V.model.degree(a)
        || String(V.model.nameOf(a)).localeCompare(String(V.model.nameOf(b))));
      const r = radius(d);
      list.forEach((k, i) => {
        const a = (i / list.length) * Math.PI * 2 - Math.PI / 2 + (d % 2 ? Math.PI / list.length : 0);
        res.nodes.set(k, {
          x: cx + Math.cos(a) * r,
          y: cy + Math.sin(a) * r * 0.92,
          up: d > 0 && Math.sin(a) < -0.2,     // 上半个环的标签放到点的上方，避免互相压
        });
      });
    });
    return res;
  }

  // ==================================================================
  // 外壳
  // ==================================================================
  function buildShell() {
    const el = document.createElement("div");
    el.id = OVERLAY_ID;
    el.className = "ko-nv-layer";     // 复用 styles-neural.css 的整套材质
    el.hidden = true;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "读书神经图谱");
    el.innerHTML = `
      <div class="ko-nv-top">
        <div class="ko-nv-brand">
          <span class="ko-nv-brand-mark" aria-hidden="true"></span>
          <span class="ko-nv-brand-text"><b>神经图谱</b><small>Cross-book Knowledge Network</small></span>
        </div>
        <nav class="ko-nv-crumbs" aria-label="图谱路径" hidden>
          <button class="ko-nv-crumb-back" type="button" data-rn-back aria-label="返回上一层">‹</button>
          <button type="button" data-rn-crumb="root">跨书知识网络</button>
          <span data-rn-crumb-sep hidden>/</span>
          <button type="button" data-rn-crumb="mod" hidden></button>
          <span data-rn-crumb-sep2 hidden>/</span>
          <b data-rn-crumb-node hidden></b>
        </nav>
        <div class="ko-nv-kpis"></div>
        <div class="ko-nv-top-actions">
          <button class="ko-nv-pill" type="button" data-rn-replay>↻ 重播</button>
          <button class="ko-nv-icon-btn" type="button" data-rn-close aria-label="关闭神经图谱">✕</button>
        </div>
      </div>
      <div class="ko-nv-stage" data-stage="hub">
        <canvas class="ko-nv-canvas" aria-hidden="true"></canvas>
        <div class="ko-nv-scene">
          <div class="ko-nv-orb" aria-hidden="true">
            <div class="ko-nv-orb-halo"></div>
            <div class="ko-nv-orb-core"></div>
          </div>
          <svg class="ko-nv-threads" aria-hidden="true"></svg>
        </div>
        <div class="ko-nv-copy">
          <h2>读过的书，<br>长成一张网。</h2>
          <p>中心是全部读过的书，四周是这张网自己长出来的领域。</p>
          <p class="ko-nv-hint">点击领域，展开它的概念与关系 · Esc 逐层返回</p>
        </div>
        <div class="ko-nv-legend" hidden></div>
        <p class="ko-nv-stage-hint" hidden>选一个概念，看它的全部关联 · Esc 返回</p>
        <div class="ko-nv-empty" hidden></div>
        <aside class="ko-nv-panel" hidden></aside>
      </div>
      <div class="ko-nv-dock">
        <div class="ko-nv-answers" hidden></div>
        <form class="ko-nv-ask">
          <input type="text" placeholder="问问这张网… Ask your network" aria-label="向知识网络提问" autocomplete="off">
          <button class="ko-nv-send" type="submit" aria-label="提交问题">→</button>
        </form>
        <div class="ko-nv-chips-row"></div>
      </div>`;
    return el;
  }

  // ==================================================================
  // 场景
  // ==================================================================
  function toneOfNode(model, key) {
    if (model.isBridge(key)) return TONE.gold;
    if (model.stageOf(key) === "stub") return TONE.dim;
    return TONE.silver;
  }

  function renderScene() {
    const d = V.dom;
    const scene = d.scene;
    // 换了领域 → 概念的位置重新从簇心长出，不要从上一个领域的旧位置飞过来
    if (V._renderedMod !== V.mod) { V.cur.nodes = new Map(); V._renderedMod = V.mod; }
    scene.querySelectorAll(".ko-nv-mod, .ko-nv-mod-label, .ko-nv-node").forEach((n) => n.remove());

    const model = V.model;
    const T = targets();
    d.modBtns = new Map();
    d.modLabels = new Map();
    d.nodeBtns = new Map();

    model.modules.forEach((id) => {
      const info = model.info(id);
      const tone = pick(TONE.silver);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ko-nv-mod";
      btn.style.setProperty("--nv-mod", tone);
      btn.setAttribute("aria-label", `${info.name}，${info.size} 个概念`);
      btn.innerHTML = `<span class="ko-nv-mod-core"></span>`;
      btn.addEventListener("click", () => gotoModule(id));
      btn.addEventListener("pointerenter", () => { V.hover = id; });
      btn.addEventListener("pointerleave", () => { if (V.hover === id) V.hover = null; });
      scene.appendChild(btn);

      const label = document.createElement("button");
      label.type = "button";
      label.className = "ko-nv-mod-label" + (info.loose ? " is-loose" : "");
      label.style.setProperty("--nv-mod", tone);
      label.tabIndex = -1;
      label.innerHTML = `<span class="ko-nv-mod-name">${escapeText(info.name)}</span>
        <span class="ko-nv-mod-meta"><span class="ko-nv-mod-count">${info.size}</span><span class="ko-nv-mod-sub">个概念</span>${info.bridgeKeys.length ? `<span class="ko-nv-mod-bridge">★ ${info.bridgeKeys.length} 个桥</span>` : `<span class="ko-nv-mod-dot"></span>`}</span>`;
      label.addEventListener("click", () => gotoModule(id));
      label.addEventListener("pointerenter", () => { V.hover = id; });
      label.addEventListener("pointerleave", () => { if (V.hover === id) V.hover = null; });
      scene.appendChild(label);

      d.modBtns.set(id, btn);
      d.modLabels.set(id, label);
    });

    // 概念节点（module / note 层）
    if (V.stage !== "hub" && V.mod) {
      model.info(V.mod).keys.forEach((key) => {
        const tone = toneOfNode(model, key);
        const bridge = model.isBridge(key);
        const stage = model.stageOf(key);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ko-nv-node" + (bridge ? " is-bridge" : "") + (stage === "stub" ? " is-stub" : "");
        btn.style.setProperty("--nv-kc", pick(tone));
        btn.setAttribute("data-side", (T.nodes.get(key) || {}).up ? "up" : "down");
        const bc = model.bookCountOf(key);
        btn.setAttribute("aria-label", `打开 ${model.nameOf(key)} 的关联分析，被 ${bc} 本书支持`);
        btn.innerHTML = `<span class="ko-nv-node-dot"></span>
          <span class="ko-nv-node-label">${escapeText(model.nameOf(key))}</span>
          ${bridge ? `<span class="ko-nv-node-badge">★ 桥 · 裂 ${model.bridges.get(key).clusters_joined || 1} 块</span>` : ""}`;
        btn.addEventListener("click", () => gotoNode(key));
        scene.appendChild(btn);
        d.nodeBtns.set(key, btn);
      });
    }

    // —— SVG：神经丝（光球→模块）+ 类型化边（概念之间）+ 待确认的候选关联 ——
    const svg = d.threadsSvg;
    svg.innerHTML = `<defs>
      <filter id="ko-rn-blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3"/></filter>
      <radialGradient id="ko-rn-pulse"><stop offset="0" stop-color="#fffaf0"/><stop offset=".4" stop-color="#e6cf98"/><stop offset="1" stop-color="#e6cf98" stop-opacity="0"/></radialGradient>
    </defs>`;

    d.threads = new Map();
    d.threadPulses = new Map();
    model.modules.forEach((id) => {
      const g = document.createElementNS(NS, "g");
      g.setAttribute("style", `color:${pick(TONE.silver)}`);
      const glow = document.createElementNS(NS, "path");
      glow.setAttribute("class", "ko-nv-thread-glow");
      glow.setAttribute("filter", "url(#ko-rn-blur)");
      const core = document.createElementNS(NS, "path");
      core.setAttribute("class", "ko-nv-thread-core");
      g.appendChild(glow); g.appendChild(core);
      const dots = [0, 1].map(() => {
        const c = document.createElementNS(NS, "circle");
        c.setAttribute("r", "5");
        c.setAttribute("fill", "url(#ko-rn-pulse)");
        g.appendChild(c);
        return c;
      });
      svg.appendChild(g);
      d.threads.set(id, { glow, core });
      d.threadPulses.set(id, dots);
    });

    // 候选关联（模块之间，虚线，明确标注「待确认」）
    d.candPaths = [];
    model.candidates.forEach((c, i) => {
      const g = document.createElementNS(NS, "g");
      g.setAttribute("style", `color:${pick(TONE.dim)}`);
      const p = document.createElementNS(NS, "path");
      p.setAttribute("class", "ko-nv-arc is-dotted is-cand");
      p.setAttribute("data-cand", String(i));
      g.appendChild(p);
      svg.appendChild(g);
      d.candPaths.push(p);
    });

    // 概念之间的边：只在 module / note 层画（hub 层没有簇内边可画）
    d.arcs = [];
    if (V.stage !== "hub" && V.mod) {
      const inModule = model.info(V.mod).keys.filter((k) => model.byKey.has(k));
      const set = new Set(inModule);
      model.edges.forEach((e) => {
        if (!set.has(e.source) || !set.has(e.target)) return;
        const kind = EDGE_KINDS[e.kind] ? e.kind : "same";
        const g = document.createElementNS(NS, "g");
        g.setAttribute("style", `color:${kind === "contrast" ? "" : pick(TONE.silver)}`);
        if (kind === "contrast") g.style.color = isLight() ? "#b23b3b" : "#ff9aa2";
        const p = document.createElementNS(NS, "path");
        p.setAttribute("class", "ko-nv-arc " + EDGE_KINDS[kind].cls);
        g.appendChild(p);
        let head = null;
        if (EDGE_KINDS[kind].directed) {
          head = document.createElementNS(NS, "path");
          head.setAttribute("fill", "currentColor");
          g.appendChild(head);
        }
        svg.appendChild(g);
        d.arcs.push({ edge: e, kind, path: p, head, bridge: model.isBridge(e.source) || model.isBridge(e.target) });
      });
    }
    // 桥所在的边额外加一条金色脉冲
    d.arcPulses = [];
    if (V.stage !== "hub" && V.mod) {
      const model2 = V.model;
      d.arcs.forEach((a) => {
        if (!a.bridge) return;
        const c = document.createElementNS(NS, "circle");
        c.setAttribute("r", "4");
        c.setAttribute("fill", "url(#ko-rn-pulse)");
        svg.appendChild(c);
        d.arcPulses.push({ arc: a, dot: c });
      });
    }
    d.fanPaths = [];
  }

  /** 二次贝塞尔 + 两端各留 12px，避免线头压在节点圆点上。 */
  function arcGeom(ax, ay, bx, by, bow) {
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const pad = Math.min(12, len / 3);
    const sx = ax + ux * pad, sy = ay + uy * pad;
    const ex = bx - ux * pad, ey = by - uy * pad;
    const mx = (sx + ex) / 2 - uy * bow, my = (sy + ey) / 2 + ux * bow;
    return { d: `M${sx.toFixed(1)},${sy.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`, ex, ey, mx, my };
  }

  function arrowGeom(x, y, ang, size) {
    const s = size || 5.5;
    const a1 = ang + Math.PI * 0.82, a2 = ang - Math.PI * 0.82;
    return `M${x.toFixed(1)},${y.toFixed(1)} L${(x + Math.cos(a1) * s).toFixed(1)},${(y + Math.sin(a1) * s).toFixed(1)} L${(x + Math.cos(a2) * s).toFixed(1)},${(y + Math.sin(a2) * s).toFixed(1)} Z`;
  }

  function renderChrome() {
    const d = V.dom;
    d.stage.dataset.stage = V.stage;
    const crumbs = d.root.querySelector(".ko-nv-crumbs");
    const modInfo = V.mod ? V.model.info(V.mod) : null;
    const selName = V.sel ? V.model.nameOf(V.sel) : "";
    crumbs.hidden = V.stage === "hub";
    const modBtn = crumbs.querySelector("[data-rn-crumb='mod']");
    const sep1 = crumbs.querySelector("[data-rn-crumb-sep]");
    const sep2 = crumbs.querySelector("[data-rn-crumb-sep2]");
    const nodeB = crumbs.querySelector("[data-rn-crumb-node]");
    if (modInfo) {
      modBtn.hidden = false; sep1.hidden = false;
      modBtn.textContent = modInfo.name;
    } else { modBtn.hidden = true; sep1.hidden = true; }
    if (selName) { nodeB.hidden = false; sep2.hidden = false; nodeB.textContent = selName; }
    else { nodeB.hidden = true; sep2.hidden = true; }
    d.hint.hidden = V.stage !== "module";
    d.legend.hidden = V.stage !== "hub";
    renderPanel();
  }

  function renderLegend() {
    const rows = [
      ["is-gold", "", "桥", "去掉它，所在领域会裂成几块 —— 整张网最值钱的东西"],
      ["is-contrast", "", "对立", "两本书说法冲突，必须显式面对"],
      ["", "", "同一件事", "两本书用不同叫法说同一个概念"],
      ["", "", "前置", "先懂 A 才可能懂 B（带箭头 = 有方向）"],
      ["", "is-dashed", "延伸", "A 是 B 的特例或深化"],
      ["", "is-dotted", "类比", "跨域隐喻"],
      ["", "is-dashdot", "应用", "概念 → 它适用的场景"],
      ["", "is-dotted", "待确认的关联", "看起来是同一件事，还没合并 —— 点它才会成真"],
    ];
    V.dom.legend.innerHTML = `<h5>关系类型</h5>` + rows.map(([tone, line, name, hint]) =>
      `<div class="ko-nv-legend-row ${tone} ${line}"><i></i><b>${escapeText(name)}</b><small>${escapeText(hint)}</small></div>`
    ).join("");
  }

  function renderKpis() {
    const m = V.model;
    const s = m.summary;
    V.dom.kpis.innerHTML = [
      ["概念", "Concepts", s.concepts != null ? s.concepts : m.nodes.length],
      ["连线", "Edges", s.edges != null ? s.edges : m.edges.length],
      ["领域", "Domains", m.modules.length],
      ["桥", "Bridges", s.bridges != null ? s.bridges : m.bridges.size],
      ["跨书概念", "Cross-book", s.cross_book != null ? s.cross_book : 0],
      ["本书", "Books", s.books != null ? s.books : 0],
    ].map(([zh, en, v]) => `<div><span>${zh} <em>${en}</em></span><strong>${v}</strong></div>`).join("");
  }

  // ==================================================================
  // 概念卡（右侧）
  // ==================================================================
  function renderPanel() {
    const panel = V.dom.panel;
    const key = V.sel;
    if (!key || !V.model.byKey.has(key)) { panel.hidden = true; panel.innerHTML = ""; return; }
    const m = V.model;
    const stage = m.stageOf(key);
    const bc = m.bookCountOf(key);
    const books = m.booksOf(key);
    const bridge = m.bridges.get(key) || null;
    const info = m.info(m.moduleIdOf(key));
    const deg = m.degree(key);

    // 关联概念按关系类型分组。**对立排最前** —— 冲突最要紧，不能埋在一堆「同一件事」里。
    const byKind = new Map();
    (m.edgesOf.get(key) || []).forEach((e) => {
      const kind = EDGE_KINDS[e.kind] ? e.kind : "same";
      const other = e.source === key ? e.target : e.source;
      if (!byKind.has(kind)) byKind.set(kind, []);
      if (!byKind.get(kind).some((x) => x.other === other)) byKind.get(kind).push({ other, edge: e });
    });

    panel.hidden = false;
    panel.style.setProperty("--nv-kc", pick(toneOfNode(m, key)));
    panel.innerHTML = `
      <div class="ko-nv-panel-head">
        <span class="ko-nv-panel-cat"><i></i>${escapeText(STAGE_LABEL[stage] || stage)}</span>
        <button class="ko-nv-icon-btn" type="button" data-rn-panel-close aria-label="关闭分析栏">✕</button>
      </div>
      <div class="ko-nv-panel-scroll">
        <h3>${escapeText(m.nameOf(key))}</h3>
        <p class="ko-nv-panel-sub">领域：${escapeText(info.name)}${info.loose ? "（未连接）" : ""}</p>
        <div class="ko-nv-metric">
          <header><span>跨书支持 <em>Cross-book support</em></span><span class="ko-nv-lvl ${STAGE_LVL[stage] || ""}">${escapeText(STAGE_LABEL[stage] || "")}</span></header>
          <div class="ko-nv-metric-body">
            <strong>${bc} 本</strong>
            <span class="ko-nv-metric-stat">关联概念 <b>${deg}</b></span>
            <span class="ko-nv-metric-stat">${bridge ? "★ 是桥" : "非桥"}</span>
          </div>
        </div>
        ${bridge ? `<div class="ko-nv-edge-group is-bridge">
          <header><i></i><b>桥</b><small>去掉它这个领域会裂开</small></header>
          <p class="ko-nv-edge-note">去掉「${escapeText(m.nameOf(key))}」，网络会多出 <b>${bridge.clusters_joined || 1}</b> 个断开的块 —— 它同时被 ${books.length ? escapeText(books.join("、")) : "多本书"} 指向，是两个原本无关的方向之间唯一的接口。</p>
        </div>` : ""}
        <section class="ko-nv-sec ko-nv-doc-sec">
          <h4>概念详解 <em>Document</em><span class="ko-nv-doc-badge" data-rn-doc-badge>读取中</span></h4>
          <div class="ko-nv-doc-body" data-rn-doc-body><p class="ko-nv-empty-line">正在读取详解…</p></div>
        </section>
        <section class="ko-nv-sec">
          <h4>来源书单 <em>Sources</em></h4>
          ${books.length
            ? `<div class="ko-nv-books">${books.map((b) => `<span class="ko-nv-book${books.length < 2 ? " is-only" : ""}"><span>${escapeText(b)}</span></span>`).join("")}</div>
               ${books.length < 2 ? `<p class="ko-nv-edge-note" style="margin-top:8px">孤证：只在一本书里出现过，别当共识用。多读一本独立指向它的书，它才会升级。</p>` : ""}`
            : `<p class="ko-nv-empty-line">没有记录到来源书。</p>`}
        </section>
        <section class="ko-nv-sec">
          <h4>关联概念 <em>Typed relations</em></h4>
          ${byKind.size ? EDGE_ORDER.filter((k) => byKind.has(k)).map((kind) => {
            const rows = byKind.get(kind);
            const meta = EDGE_KINDS[kind];
            return `<div class="ko-nv-edge-group ${meta.cls}">
              <header><i></i><b>${escapeText(meta.label)}</b><small>${rows.length} 个 · ${escapeText(meta.hint)}</small></header>
              <div class="ko-nv-chips">${rows.map((r) => {
                const t = toneOfNode(m, r.other);
                const note = String(r.edge.note || "").trim();
                return `<button class="ko-nv-chip" type="button" data-rn-chip="${escapeText(r.other)}" style="--nv-kc:${pick(t)}" title="${escapeText(note || meta.hint)}"><span>${escapeText(m.nameOf(r.other))}</span><small>${m.bookCountOf(r.other)} 本</small></button>`;
              }).join("")}</div>
            </div>`;
          }).join("") : `<p class="ko-nv-empty-line">这个概念还没有连上任何东西。在「读书收获」里补上「和我的知识库的联系」，它就会长进网里。</p>`}
        </section>
      </div>
      <div class="ko-nv-panel-foot">
        <button class="ko-nv-pill" type="button" data-rn-method>${bridge ? "就这一簇生成方法论" : "就这一领域生成方法论"}</button>
        <button class="ko-nv-pill" type="button" data-rn-goto-domain>在知识网络里看这个领域</button>
      </div>`;
    panel.querySelector("[data-rn-panel-close]").addEventListener("click", () => gotoModule(V.mod));
    panel.querySelector("[data-rn-method]").addEventListener("click", (e) => genMethodology(key, e.currentTarget));
    panel.querySelector("[data-rn-goto-domain]").addEventListener("click", () => { close(); switchToNetTab(); });
    panel.querySelectorAll("[data-rn-chip]").forEach((chip) => {
      chip.addEventListener("click", () => gotoNode(chip.getAttribute("data-rn-chip")));
    });
    const sc = panel.querySelector(".ko-nv-panel-scroll");
    if (sc) sc.scrollTop = 0;
    loadConceptDoc(key);
  }

  // —— 概念详解：读 / 生成 ——
  //
  // 光有「被几本书支持 / 关联了谁」这些元数据不算干货 —— 读者点开一个概念，
  // 要的是「它到底是什么、每本书里分别怎么说」。详解由后端按「概念 + 材料指纹」
  // 缓存，所以这里只管拉；没生成过就给一个按钮，点了才花那一两分钟。
  async function loadConceptDoc(key) {
    const panel = V.dom && V.dom.panel;
    if (!panel) return;
    const seq = ++V.docSeq;
    const badge = panel.querySelector("[data-rn-doc-badge]");
    let doc = V.docCache.get(key);
    if (doc === undefined) {
      if (badge) badge.textContent = "读取中";
      try {
        const resp = await fetch(
          `/api/reading/net/concepts/${encodeURIComponent(key)}/doc`,
          { credentials: "same-origin" }
        );
        const data = resp.ok ? await resp.json() : null;
        doc = (data && data.doc) || null;
      } catch (_) { doc = null; }
      V.docCache.set(key, doc);
    }
    // 期间用户可能已经切到别的概念 —— 丢弃过期结果，别把 A 的详解贴到 B 上
    if (seq !== V.docSeq || !V.dom || V.dom.panel.hidden || V.sel !== key) return;
    const el = panel.querySelector("[data-rn-doc-body]");
    if (!el) return;
    if (doc && String(doc.content_md || "").trim()) {
      if (badge) badge.textContent = "已生成";
      el.innerHTML = renderMarkdown(doc.content_md);
      return;
    }
    if (badge) badge.textContent = "未生成";
    const bc = V.model.bookCountOf(key);
    el.innerHTML = `<p class="ko-nv-empty-line">还没有详解。生成后会读各本书《读书收获》里提到这个概念的部分，可能要一两分钟。</p>
      ${bc
        ? `<button class="ko-nv-pill" type="button" data-rn-gen-doc>生成概念详解</button>`
        : `<p class="ko-nv-empty-line">这个概念还没有来源书，先生成它的《读书收获》。</p>`}`;
    const btn = el.querySelector("[data-rn-gen-doc]");
    if (btn) btn.addEventListener("click", () => genConceptDoc(key, btn));
  }

  async function genConceptDoc(key, btn) {
    if (btn) { btn.disabled = true; btn.textContent = "正在生成…（要读各本书的收获，可能一两分钟）"; }
    try {
      const resp = await fetch(
        `/api/reading/net/concepts/${encodeURIComponent(key)}/doc`,
        { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" }
      );
      if (!resp.ok) {
        let detail = "";
        try { const d = await resp.json(); detail = (d && d.detail && (d.detail.message || d.detail)) || ""; } catch (_) { /* 用状态码 */ }
        throw new Error(detail || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      V.docCache.delete(key);
      await loadConceptDoc(key);
      toast(data && data.degraded
        ? "模型这次没给出详解，已先把各本书里的原句列出来。"
        : "概念详解已生成。");
    } catch (err) {
      toast("生成概念详解失败：" + ((err && err.message) || "未知错误"), "error");
      if (btn) { btn.disabled = false; btn.textContent = "生成失败，点此重试"; }
    }
  }

  /** 就着这个概念所在的**簇**生成方法论（后端按 cluster_key 去重，簇变了自然失效重建）。 */
  async function genMethodology(anchorKey, btn) {
    if (!anchorKey) return;
    const old = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "正在归纳…（要读这一簇的全部收获，可能一两分钟）"; }
    try {
      const resp = await fetch("/api/reading/net/methodology", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anchor_key: anchorKey }),
      });
      if (!resp.ok) {
        let detail = "";
        try { const d = await resp.json(); detail = (d && d.detail && (d.detail.message || d.detail)) || ""; } catch (_) { /* 用状态码 */ }
        throw new Error(detail || `HTTP ${resp.status}`);
      }
      toast("方法论已生成，并沉淀成技能卡（会自动进复习队列）。");
      await reload();
    } catch (err) {
      toast("生成方法论失败：" + ((err && err.message) || "未知错误"), "error");
      if (btn) { btn.disabled = false; btn.textContent = old || "重试"; }
    }
  }

  // ==================================================================
  // 图谱速览（本地规则检索，不调模型）
  // ==================================================================
  function answerQuery(text) {
    const q = String(text || "").trim();
    const m = V.model;
    const cards = [];
    const byDeg = m.nodes.slice().sort((a, b) => m.degree(b.concept_key) - m.degree(a.concept_key));
    const chip = (key) => ({
      id: key,
      name: m.nameOf(key),
      meta: m.bookCountOf(key) + " 本",
      color: pick(toneOfNode(m, key)),
    });
    const bySupport = m.nodes.slice().sort((a, b) => m.bookCountOf(b.concept_key) - m.bookCountOf(a.concept_key));

    if (/桥|割点|接口|枢纽|关键|最值钱/.test(q)) {
      const list = [...m.bridges.values()].slice(0, 6);
      cards.push({
        tone: "gold", title: "桥（整张网最值钱的节点）", en: "Bridges",
        text: list.length
          ? "去掉它们，所在领域就会裂成几块 —— 它们同时被两个原本无关的方向指向。"
          : "目前没有桥：说明每个领域内部都还没有「唯一的接口」。多读几本不同领域的书，或在收获里补上「和我的知识库的联系」，桥就会浮现。",
        items: list.map((b) => chip(b.concept_key)),
      });
    }
    if (/核心|中心|最重要|主干|主要/.test(q)) {
      const list = byDeg.filter((n) => m.degree(n.concept_key) > 0).slice(0, 6);
      cards.push({
        tone: "", title: "连接最多的概念", en: "Most connected",
        text: list.length ? "按「关联概念数」排序 —— 撑起最多关系的概念最像这张网的主干。" : "还没有连上任何关系的概念。",
        items: list.map((n) => chip(n.concept_key)),
      });
    }
    if (/孤证|来源不足|缺|只有一本|薄弱|补/.test(q)) {
      const list = bySupport.filter((n) => m.bookCountOf(n.concept_key) < 2).slice(0, 8);
      cards.push({
        tone: "gold", title: "孤证 / 待补来源", en: "Single-source",
        text: list.length
          ? "只被一本书提到 —— 别当共识用。再找一本独立指向它的书，它才会升级成「待验证」。"
          : "没有孤证：每个概念都至少被两本书支持。",
        items: list.map((n) => chip(n.concept_key)),
      });
    }
    if (/成熟|验证|可信|交叉|几本/.test(q)) {
      const list = bySupport.filter((n) => m.bookCountOf(n.concept_key) >= 2).slice(0, 8);
      cards.push({
        tone: "", title: "交叉验证过的概念", en: "Cross-validated",
        text: list.length
          ? `被 ≥2 本书独立指向 —— 当前共 ${list.length} 个。不同学科指向同一个结论时，判断更可能对。`
          : "还没有被两本书同时支持的概念。",
        items: list.map((n) => chip(n.concept_key)),
      });
    }
    if (/领域|分组|簇|分成|结构/.test(q)) {
      cards.push({
        tone: "", title: "领域（图的连通分量）", en: "Domains",
        text: `共 ${m.modules.length} 个领域。它们是这张网**自己长出来的**分组 —— 知源不预设分类，学科只是概念上的标签。`,
        items: m.modules.filter((id) => id !== LOOSE_ID).slice(0, 6).map((id) => {
          const info = m.info(id);
          return { id: "", name: info.name, meta: info.size + " 个", color: pick(TONE.silver), domain: id };
        }),
      });
    }
    if (/冲突|矛盾|对立|打架|不一致/.test(q)) {
      const list = m.edges.filter((e) => e.kind === "contrast");
      cards.push({
        tone: "gold", title: "两本书说法冲突", en: "Conflicts",
        text: list.length
          ? "这些地方两本书直接对立 —— 不要和稀泥，先把分歧本身记下来。"
          : "没有检测到显式冲突。",
        items: list.slice(0, 8).map((e) => ({ id: e.target, name: `${m.nameOf(e.source)} ↔ ${m.nameOf(e.target)}`, meta: "", color: isLight() ? "#b23b3b" : "#ff9aa2" })),
      });
    }
    if (/多少|数量|统计|几个|规模/.test(q)) {
      const s = m.summary;
      cards.push({
        tone: "", title: "网络规模", en: "Scale",
        text: `共 ${s.concepts != null ? s.concepts : m.nodes.length} 个概念、${s.edges != null ? s.edges : m.edges.length} 条关系、${m.modules.length} 个领域、${s.bridges != null ? s.bridges : m.bridges.size} 个桥；来自 ${s.books || 0} 本书，其中 ${s.mature || 0} 个概念已成熟。`,
        items: [],
      });
    }
    if (!cards.length) {
      const s = m.summary;
      cards.push({
        tone: "", title: "网络概览", en: "Overview",
        text: `共 ${s.concepts != null ? s.concepts : m.nodes.length} 个概念、${s.edges != null ? s.edges : m.edges.length} 条关系、${m.modules.length} 个领域、${s.bridges != null ? s.bridges : m.bridges.size} 个桥。可以问「最值钱的桥」「孤证的」「冲突的」「哪些成熟了」「怎么分组的」。`,
        items: byDeg.slice(0, 4).map((n) => chip(n.concept_key)),
      });
    }
    return cards;
  }

  function showOverview() {
    if (!V.model.nodes.length) { flash("这张网还是空的：先生成至少两本书的《读书收获》。"); return; }
    V.ask.overview = answerQuery("网络概览").map((c) => `<article class="ko-nv-card ${c.tone ? "tone-" + c.tone : ""}">
        <h5>${escapeText(c.title)} <em>${escapeText(c.en || "")}</em></h5>
        <p>${escapeText(c.text)}</p>
        ${c.items && c.items.length ? `<div class="ko-nv-chips">${c.items.map((it) => `<button class="ko-nv-chip" type="button" data-rn-chip="${escapeText(it.id)}" data-rn-domain="${escapeText(it.domain || "")}" style="--nv-kc:${it.color}"><span>${escapeText(it.name)}</span><small>${escapeText(it.meta || "")}</small></button>`).join("")}</div>` : ""}
      </article>`).join("");
    paintAsk();
  }

  function flash(text) {
    const box = V.dom.answers;
    box.hidden = false;
    box.innerHTML = `<header><span>提示</span><button class="ko-nv-icon-btn" type="button" data-rn-answers-close aria-label="关闭">✕</button></header>
      <article class="ko-nv-card"><p>${escapeText(text)}</p></article>`;
    box.querySelector("[data-rn-answers-close]").addEventListener("click", () => { box.hidden = true; });
  }

  // ==================================================================
  // 问 AI：把整张网渲染成文本送进去（SSE 流式）
  // ==================================================================
  function netContext() {
    const m = V.model;
    const lines = [];
    lines.push(`【这张网】共 ${m.nodes.length} 个概念、${m.edges.length} 条关系、${m.modules.length} 个领域、${m.bridges.size} 个桥；来自 ${(m.summary.book_names || []).length || m.summary.books || 0} 本书。`);
    lines.push("");
    lines.push("【概念】（按被几本书支持排序）");
    m.nodes.slice().sort((a, b) => m.bookCountOf(b.concept_key) - m.bookCountOf(a.concept_key))
      .forEach((n) => {
        const k = n.concept_key;
        lines.push(`- ${m.nameOf(k)}｜被 ${m.bookCountOf(k)} 本书支持（${STAGE_LABEL[m.stageOf(k)] || m.stageOf(k)}）｜来源：${m.booksOf(k).join("、") || "未记录"}${m.isBridge(k) ? "｜★桥" : ""}`);
      });
    lines.push("");
    lines.push("【关系】（source --类型--> target）");
    m.edges.forEach((e) => {
      const meta = EDGE_KINDS[e.kind] || EDGE_KINDS.same;
      lines.push(`- ${m.nameOf(e.source)} --${meta.label}--> ${m.nameOf(e.target)}${String(e.note || "").trim() ? `（${String(e.note).trim()}）` : ""}`);
    });
    if (m.bridges.size) {
      lines.push("");
      lines.push("【桥】（去掉它，所在领域会裂开）");
      m.bridges.forEach((b) => {
        lines.push(`- ${b.name || m.nameOf(b.concept_key)}｜去掉后多出 ${b.clusters_joined || 1} 个断开的块｜来源：${(b.books || []).join("、") || "未记录"}`);
      });
    }
    lines.push("");
    lines.push("【领域】（图的连通分量，是这张网自己长出来的分组，不是预设分类）");
    m.modules.forEach((id) => {
      const info = m.info(id);
      lines.push(`- 领域「${info.name}」（${info.size} 个概念）：${info.keys.map((k) => m.nameOf(k)).join("、")}`);
    });
    const text = lines.join("\n");
    return text.length > ASK_CONTEXT_LIMIT ? text.slice(0, ASK_CONTEXT_LIMIT) + "\n…（已截断）" : text;
  }

  function askHistory() {
    return V.ask.thread
      .filter((m) => !m.pending && !m.error && m.a)
      .map((m) => ({ question: m.q, answer: String(m.a).slice(0, 500) }))
      .slice(-3);
  }

  /** 裸 fetch 读 SSE —— app.js 的 api() 会按 JSON 解析，这里是 text/event-stream。 */
  async function streamAsk(payload, onEvent) {
    const resp = await fetch("/api/reading/net/ask", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (resp.status === 401) throw new Error("登录状态已失效，请刷新页面后再试。");
    if (!resp.ok || !resp.body) {
      let detail = "";
      try { const d = await resp.json(); detail = (d && d.detail && (d.detail.message || d.detail)) || ""; } catch (_) { /* 用状态码 */ }
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
    if (!V.model || !V.model.nodes.length) { flash("这张网还是空的：先生成至少两本书的《读书收获》。"); return; }
    const msg = { q, a: "", pending: true, error: "" };
    V.ask.thread.push(msg);
    V.ask.busy = true;
    V.ask.overview = "";
    paintAsk();
    const body = {
      question: q,
      context: netContext(),
      scope: V.sel ? "concept" : "network",
      anchor: V.sel ? V.model.nameOf(V.sel) : "",
      history: askHistory(),
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
    const scopeNote = V.sel ? `就「${V.model.nameOf(V.sel)}」` : "就整张网";
    box.innerHTML = `<header>
        <span>问 AI <em>Ask</em></span>
        <small>发散档 · 材料外也会讲并单独标注｜${escapeText(scopeNote)}</small>
        <button class="ko-nv-icon-btn" type="button" data-rn-answers-close aria-label="关闭">✕</button>
      </header>
      ${V.ask.overview}
      <div class="ko-nv-thread">${th.map((m, i) => `
        <div class="ko-nv-turn is-q"><span class="ko-nv-mark">问</span><div>${escapeText(m.q)}</div></div>
        <div class="ko-nv-turn is-a"><span class="ko-nv-mark">答</span><div class="ko-nv-a-body" data-rn-a="${i}">${
          m.error ? `<span class="ko-nv-err">${escapeText(m.error)}</span>`
          : m.a ? renderMarkdown(m.a)
          : m.pending ? `<span class="ko-nv-typing">正在回答…</span>` : ""
        }</div></div>`).join("")}</div>`;
    box.querySelector("[data-rn-answers-close]").addEventListener("click", () => { box.hidden = true; });
    box.querySelectorAll("[data-rn-chip]").forEach((chip) => {
      const domain = chip.getAttribute("data-rn-domain");
      if (domain) chip.addEventListener("click", () => gotoModule(domain));
      else chip.addEventListener("click", () => gotoNode(chip.getAttribute("data-rn-chip")));
    });
    const last = th[th.length - 1];
    V.ask.domA = last && last.pending ? box.querySelector(`[data-rn-a="${th.length - 1}"]`) : null;
    box.scrollTop = box.scrollHeight;
  }

  function resetAsk() {
    V.ask.thread = [];
    V.ask.overview = "";
    V.ask.domA = null;
    if (V.dom && V.dom.answers) { V.dom.answers.hidden = true; V.dom.answers.innerHTML = ""; }
  }

  // ==================================================================
  // 导航
  // ==================================================================
  function gotoModule(id) {
    if (!V.model || !V.model.modules.includes(id)) return;
    const changed = V.mod !== id || V.sel !== null;
    const info = V.model.info(id);
    // 没有概念可展开（理论上不会，但别让点击像没反应）
    if (!info.keys.length) { V.mod = id; V.sel = null; V.stage = "module"; renderScene(); renderChrome(); return; }
    if (V.mod === id && V.stage !== "hub") { V.sel = null; V.stage = "module"; }
    else { V.mod = id; V.sel = null; V.stage = "module"; }
    renderScene(); renderChrome();
    if (changed) resetAsk();
  }

  function gotoNode(key) {
    if (!V.model || !V.model.byKey.has(key)) return;
    const changed = V.sel !== key;
    V.mod = V.model.moduleIdOf(key);
    V.sel = key;
    V.stage = "note";
    if (!V.dom.nodeBtns.has(key)) renderScene();
    renderChrome();
    if (changed) resetAsk();
  }

  function back() {
    if (V.sel) { V.sel = null; V.stage = "module"; renderChrome(); }
    else if (V.mod) { V.mod = null; V.stage = "hub"; renderScene(); renderChrome(); }
    else close();
  }

  function switchToNetTab() {
    const tab = document.querySelector('#reading-workspace [data-rd-tab="net"]');
    if (tab) tab.click();
  }

  // ==================================================================
  // 动画主循环
  // ==================================================================
  function tick(now) {
    V.raf = requestAnimationFrame(tick);
    try { step(now); } catch (err) {
      if (!V.warned) { V.warned = true; console.error("[读书神经图谱] 渲染异常（已跳过本帧）", err); }
    }
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
    const model = V.model;

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
      const btn = d.modBtns.get(id);
      if (btn) {
        btn.style.transform = `translate3d(${cur.x - cur.s / 2}px,${cur.y - cur.s / 2}px,0) scale(${cur.s / 96})`;
        btn.style.opacity = clamp(cur.o, 0, 1);
        btn.classList.toggle("is-active", id === V.mod && V.stage !== "hub");
      }
      const label = d.modLabels.get(id);
      if (label) {
        const lw = label.offsetWidth || 150, lh = label.offsetHeight || 48;
        const W = V.size.w, H = V.size.h;
        let lx, ly;
        if (V.stage === "hub") {
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
        const column = V.stage !== "hub";
        label.classList.toggle("is-column", column);
        label.style.opacity = String(clamp(cur.o, 0, 1) * (column && id !== V.mod ? 0.6 : 1));
        label.classList.toggle("is-active", id === V.mod && V.stage !== "hub");
        cur.label = { x: lx, y: ly, w: lw, h: lh };
      }
      // 神经丝：光球 → 模块
      const th = d.threads.get(id);
      if (th) {
        const bend = reduced ? 0 : 22 * Math.sin(t * 0.5 + String(id).length);
        const x1 = o.x + (cur.x - o.x) * 0.18, y1 = o.y + (cur.y - o.y) * 0.18;
        const x2 = cur.x - (cur.x - o.x) * 0.16, y2 = cur.y - (cur.y - o.y) * 0.16;
        const dx = x2 - x1, dy = y2 - y1;
        const w = bend / 22 || 0;
        const dPath = `M${x1},${y1} C${x1 + dx * 0.4 - dy * 0.12 * w},${y1 + dy * 0.4 + dx * 0.12 * w} ${x1 + dx * 0.6 + dy * 0.12 * w},${y1 + dy * 0.6 - dx * 0.12 * w} ${x2},${y2}`;
        th.glow.setAttribute("d", dPath);
        th.core.setAttribute("d", dPath);
        const active = id === V.mod || id === V.hover;
        const vis = clamp(cur.o, 0, 1) * (V.stage === "hub" ? 1 : active ? 1 : 0.35);
        th.glow.style.opacity = String(vis * (active ? 0.85 : 0.35));
        th.core.style.opacity = String(vis);
        (d.threadPulses.get(id) || []).forEach((c, i) => {
          const u = reduced || V.paused ? 0 : ((t * 0.3 + i * 0.5 + String(id).length * 0.11) % 1);
          c.setAttribute("cx", String(x1 + dx * u));
          c.setAttribute("cy", String(y1 + dy * u));
          c.style.opacity = reduced || V.paused ? "0" : String(vis * Math.sin(u * Math.PI));
        });
      }
    });

    // 待确认的候选关联：模块之间（数据里唯一真实存在的「跨模块」线索）。
    // 只在总览层画 —— 进到领域层后模块收成一列，这时再把弧拉出来会糊住概念图。
    (d.candPaths || []).forEach((p, i) => {
      const c = model.candidates[i];
      if (!c || V.stage !== "hub") { p.setAttribute("d", ""); p.style.opacity = "0"; return; }
      const a = V.cur.mods.get(model.moduleIdOf(c.left));
      const b = V.cur.mods.get(model.moduleIdOf(c.right));
      if (!a || !b) { p.setAttribute("d", ""); return; }
      const g = arcGeom(a.x, a.y, b.x, b.y, 0);
      p.setAttribute("d", g.d);
      const focus = V.hover === model.moduleIdOf(c.left) || V.hover === model.moduleIdOf(c.right);
      p.style.opacity = String(clamp(Math.min(a.o, b.o), 0, 1) * (focus ? 0.75 : 0.22));
    });

    // 概念层：位置 + 类型化边
    if (V.stage !== "hub" && V.mod) {
      T.nodes.forEach((tg, key) => {
        let cur = V.cur.nodes.get(key);
        if (!cur) { cur = { x: tg.x, y: tg.y, o: 0 }; V.cur.nodes.set(key, cur); }
        cur.x = lerp(cur.x, tg.x, k); cur.y = lerp(cur.y, tg.y, k);
        cur.o = lerp(cur.o, 1, k);
        const el = d.nodeBtns.get(key);
        if (el) {
          el.style.transform = `translate3d(${cur.x}px,${cur.y}px,0)`;
          el.style.opacity = String(clamp(cur.o, 0, 1));
          el.classList.toggle("is-active", key === V.sel);
        }
      });

      (d.arcs || []).forEach((arc, i) => {
        const a = V.cur.nodes.get(arc.edge.source);
        const b = V.cur.nodes.get(arc.edge.target);
        if (!a || !b) { arc.path.setAttribute("d", ""); if (arc.head) arc.head.setAttribute("d", ""); return; }
        const bow = (i % 2 ? 1 : -1) * Math.min(26, Math.hypot(b.x - a.x, b.y - a.y) * 0.12);
        const g = arcGeom(a.x, a.y, b.x, b.y, bow);
        arc.path.setAttribute("d", g.d);
        if (arc.head) arc.head.setAttribute("d", arrowGeom(g.ex, g.ey, Math.atan2(g.ey - g.my, g.ex - g.mx)));
        const on = V.sel && (arc.edge.source === V.sel || arc.edge.target === V.sel);
        const op = V.sel ? (on ? 1 : 0.14) : (arc.kind === "contrast" || arc.bridge ? 0.9 : 0.5);
        arc.path.style.opacity = String(clamp(Math.min(a.o, b.o), 0, 1) * op);
        if (arc.head) arc.head.style.opacity = arc.path.style.opacity;
      });

      (d.arcPulses || []).forEach(({ arc, dot }) => {
        const a = V.cur.nodes.get(arc.edge.source);
        const b = V.cur.nodes.get(arc.edge.target);
        if (!a || !b) { dot.style.opacity = "0"; return; }
        const u = reduced || V.paused ? 0 : ((t * 0.4 + (arc.edge.source || "").length * 0.07) % 1);
        dot.setAttribute("cx", String(a.x + (b.x - a.x) * u));
        dot.setAttribute("cy", String(a.y + (b.y - a.y) * u));
        const on = !V.sel || arc.edge.source === V.sel || arc.edge.target === V.sel;
        dot.style.opacity = reduced || V.paused ? "0" : String(on ? Math.sin(u * Math.PI) * 0.95 : 0.12);
      });
    }

    drawCanvas(reduced, t);
  }

  // —— 背景：整张网（Canvas，确定性布局，不抢前景的戏）——
  function drawCanvas(reduced, t) {
    const d = V.dom;
    const canvas = d.canvas;
    const W = V.size.w, H = V.size.h;
    if (!W || !H) return;
    // 主循环在 open() 里就起来了，而网是异步拉回来的 ——
    // 头几帧 model / net 还是 null，这里必须早退（否则每帧抛一次空指针）。
    if (!V.model || !V.net) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const model = V.model;
    const o = V.cur.orb;
    const cx = o.x || W / 2, cy = o.y || H / 2;
    const scale = Math.min(W * 0.36, H * 0.38) / Math.max(V.net.maxR, 1);
    const sc = scale * (V.stage === "hub" ? 1 : 0.55);
    // 浅色下不能用「加色发光」（lighter）——白底上会越加越白，什么都看不见；
    // 改成普通叠加 + 压深的暖色，靠对比而不是靠亮。
    const light = isLight();
    const posOf = (key) => {
      const p = V.net.pos.get(key);
      return p ? [cx + p.x * sc, cy + p.y * sc] : null;
    };

    // 连线：整张网的关系骨架
    ctx.lineWidth = 0.8;
    model.edges.forEach((e) => {
      const a = posOf(e.source), b = posOf(e.target);
      if (!a || !b) return;
      const hot = e.kind === "contrast" || model.isBridge(e.source) || model.isBridge(e.target);
      if (light) ctx.strokeStyle = hot ? "rgba(150,74,32,.22)" : "rgba(45,42,38,.10)";
      else ctx.strokeStyle = hot ? "rgba(230,207,152,.26)" : "rgba(205,208,204,.13)";
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.quadraticCurveTo((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, b[0], b[1]);
      ctx.stroke();
    });

    // 节点
    V.net.pos.forEach((p, key) => {
      const xy = posOf(key);
      if (!xy) return;
      const bridge = model.isBridge(key);
      const tone = pick(bridge ? TONE.gold : model.stageOf(key) === "stub" ? TONE.dim : TONE.silver);
      const r = bridge ? 3.4 : 2.2;
      if (light) {
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = tone;
        ctx.beginPath(); ctx.arc(xy[0], xy[1], r * 2.6, 0, 7); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = tone;
        ctx.beginPath(); ctx.arc(xy[0], xy[1], r, 0, 7); ctx.fill();
        return;
      }
      ctx.globalCompositeOperation = "lighter";
      const g = ctx.createRadialGradient(xy[0], xy[1], 0, xy[0], xy[1], r * 5);
      g.addColorStop(0, tone + "66");
      g.addColorStop(1, tone + "00");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(xy[0], xy[1], r * 5, 0, 7); ctx.fill();
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = tone;
      ctx.beginPath(); ctx.arc(xy[0], xy[1], r, 0, 7); ctx.fill();
    });

    // 光点：从中心向外飘散（只在总览层，别在细看时晃）
    if (!reduced && V.stage === "hub") {
      ctx.globalCompositeOperation = light ? "source-over" : "lighter";
      for (const p of d.dust) {
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

  // ==================================================================
  // 打开 / 关闭
  // ==================================================================
  function emptyState(html) {
    V.dom.empty.hidden = false;
    V.dom.empty.innerHTML = html;
    V.dom.kpis.style.display = "none";
    V.dom.ask.style.display = "none";
    V.dom.chipsRow.style.display = "none";
    V.dom.legend.hidden = true;
  }

  function applyModel(data) {
    V.model = buildModel(data);
    V.net = networkLayout(V.model);
    const has = V.model.nodes.length > 0 && V.model.edges.length > 0;
    if (!has) {
      emptyState(V.model.nodes.length
        ? `<h3>这张网还没有连线</h3><p>目前只有孤立的概念。先生成至少两本书的《读书收获》—— 收获里的「可复用模型」和「和我的知识库的联系」就是这张网的节点与边。</p>`
        : `<h3>这张网还没有点亮</h3><p>去「读书收获」生成至少两本书的收获，概念会自动长成一张网。</p>`);
      V.dom.kpis.style.display = "none";
      V.dom.ask.style.display = "none";
      V.dom.chipsRow.style.display = "none";
      renderScene(); renderChrome();
      return;
    }
    V.dom.empty.hidden = true;
    V.dom.empty.innerHTML = "";
    V.dom.kpis.style.display = "";
    V.dom.ask.style.display = "";
    V.dom.chipsRow.style.display = "";
    renderScene();
    renderChrome();
    renderKpis();
    renderLegend();
  }

  /** 重新拉一次网（生成方法论之后用）。保留当前所在的层，别把用户踢回总览。 */
  async function reload() {
    const keep = { stage: V.stage, mod: V.mod, sel: V.sel };
    try {
      const data = await fetchNet();
      applyModel(data);
      if (keep.stage !== "hub" && keep.mod && V.model.modules.includes(keep.mod)) {
        V.stage = keep.sel && V.model.byKey.has(keep.sel) ? "note" : "module";
        V.mod = keep.mod;
        V.sel = keep.stage === "note" ? keep.sel : null;
        renderScene(); renderChrome();
      }
    } catch (err) {
      console.error("[读书神经图谱] 重新读取失败", err);
    }
  }

  async function fetchNet() {
    const [net, cand] = await Promise.all([
      fetch("/api/reading/net", { credentials: "same-origin" }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
      fetch("/api/reading/net/candidates", { credentials: "same-origin" })
        .then((r) => (r.ok ? r.json() : { candidates: [] }))
        .catch(() => ({ candidates: [] })),
    ]);
    net._candidates = (cand && cand.candidates) || [];
    return net;
  }

  async function open() {
    if (!V.dom) {
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
        legend: el.querySelector(".ko-nv-legend"),
        empty: el.querySelector(".ko-nv-empty"),
        panel: el.querySelector(".ko-nv-panel"),
        kpis: el.querySelector(".ko-nv-kpis"),
        answers: el.querySelector(".ko-nv-answers"),
        ask: el.querySelector(".ko-nv-ask"),
        chipsRow: el.querySelector(".ko-nv-chips-row"),
        modBtns: new Map(),
        modLabels: new Map(),
        nodeBtns: new Map(),
        threadPulses: new Map(),
        candPaths: [],
        arcs: [],
        arcPulses: [],
        dust: Array.from({ length: 84 }, (_, i) => ({
          a: i * 2.39996,
          v: 0.03 + ((i * 37) % 100) / 100 * 0.055,
          o: (i * 0.618034) % 1,
          w: (i % 2 ? 1 : -1) * (0.12 + (i % 7) * 0.04),
          s: 0.6 + (i % 5) * 0.3,
          b: 0.4 + (i % 3) * 0.22,
          c: ["236,236,232", "230,207,152", "200,205,210", "255,255,255"][i % 4],
          cl: ["176,166,146", "196,164,90", "146,154,162", "116,112,104"][i % 4],
        })),
      };
      el.querySelector("[data-rn-close]").addEventListener("click", close);
      el.querySelector("[data-rn-back]").addEventListener("click", back);
      el.querySelector("[data-rn-crumb='root']").addEventListener("click", () => {
        V.mod = null; V.sel = null; V.stage = "hub"; renderScene(); renderChrome();
      });
      el.querySelector("[data-rn-replay]").addEventListener("click", () => {
        V.mod = null; V.sel = null; V.stage = "hub"; V.time = 0; resetCur();
        renderScene(); renderChrome();
      });
      dom.ask.addEventListener("submit", (e) => {
        e.preventDefault();
        const input = dom.ask.querySelector("input");
        const text = ((input && input.value) || "").trim();
        if (!text) return;
        if (input) input.value = "";
        askSend(text);
      });
      dom.chipsRow.innerHTML = `<span>试问</span>` +
        ["最值钱的桥", "孤证的", "说法冲突的", "怎么分组的"].map((x) => `<button type="button" data-rn-quick>${x}</button>`).join("") +
        `<button type="button" data-rn-overview title="本地规则速览：结构化事实，不调模型">图谱速览</button>`;
      dom.chipsRow.querySelectorAll("[data-rn-quick]").forEach((b) => {
        b.addEventListener("click", () => askSend(b.textContent));
      });
      dom.chipsRow.querySelector("[data-rn-overview]").addEventListener("click", showOverview);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !e.isComposing) { e.stopPropagation(); back(); }
      });
      /* 本层是**模态全屏层**，挂在 body 上、不在 #reading-workspace 里。
         而 reading.js 有一条「document keydown → Esc → exit()」的处理 ——
         不拦的话，用户在神经图谱里按 Esc 会把整个读书模式一起关掉。
         在**本层根节点冒泡阶段**截住即可：元素自己的处理器已经跑完，只是不再往外传。 */
      const swallow = (e) => e.stopPropagation();
      ["pointerdown", "mousedown", "click", "dblclick", "contextmenu"].forEach((ty) => el.addEventListener(ty, swallow));
      el.addEventListener("keydown", (e) => e.stopPropagation());
      // Esc 兜底：焦点不在浮层内（例如刚点了舞台空白）时，overlay 收不到 keydown，
      // 所以在 window 捕获阶段拦一道，保证「随时能按 Esc 返回」。
      window.addEventListener("keydown", (e) => {
        if (e.key !== "Escape" || e.isComposing) return;
        if (!dom.root.hidden) { e.stopImmediatePropagation(); e.preventDefault(); back(); }
      }, true);
      V.dom = dom;
    }

    V.dom.root.hidden = false;
    document.body.classList.add("ko-nv-open");
    V.time = 0; V.paused = false; V.warned = false;
    V.stage = "hub"; V.mod = null; V.sel = null; V.hover = null;
    V._renderedMod = undefined;
    V.docCache.clear();
    V.docSeq += 1;          // 让上一轮还没回来的详解请求全部作废
    resetCur();
    resetAsk();
    measure();
    V.cur.orb = { x: V.size.w / 2, y: V.size.h / 2, s: 0, o: 0 };
    V.dom.empty.hidden = true;
    V.dom.empty.innerHTML = `<h3>正在读取跨书知识网络…</h3><p>把每本书的收获拼成一张网。</p>`;
    V.dom.kpis.style.display = "none";
    V.dom.ask.style.display = "none";
    V.dom.chipsRow.style.display = "none";
    V.dom.legend.hidden = true;
    V.dom.panel.hidden = true;

    if (!V.raf) { V.last = performance.now(); V.raf = requestAnimationFrame(tick); }
    const focusEl = V.dom.root.querySelector("[data-rn-close]");
    if (focusEl) focusEl.focus({ preventScroll: true });

    try {
      applyModel(await fetchNet());
    } catch (err) {
      emptyState(`<h3>知识网络读取失败</h3><p>${escapeText((err && err.message) || "未知错误")}</p>`);
    }
  }

  function close() {
    if (!V.dom || V.dom.root.hidden) return;
    V.dom.root.hidden = true;
    document.body.classList.remove("ko-nv-open");
    if (V.raf) { cancelAnimationFrame(V.raf); V.raf = 0; }
  }

  function measure() {
    if (!V.dom) return;
    const stage = V.dom.stage;
    V.size = { w: stage.clientWidth, h: stage.clientHeight };
  }

  // ==================================================================
  // 入口按钮：注入「知识网络」页签的头部（不改 reading.js）
  // ==================================================================
  function ensureEntryButton() {
    const host = document.querySelector("#reading-workspace [data-rd-net]");
    if (!host) return;
    const head = host.querySelector(".rd-head");
    if (!head || head.querySelector("[" + BTN_ATTR + "]")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rd-neural-open-btn";
    btn.setAttribute(BTN_ATTR, "1");
    btn.innerHTML = `神经图谱 <small>全屏 · 领域 → 概念 → 关系</small>`;
    btn.title = "全屏神经图谱：光球 + 领域 + 类型化关系（Esc 逐层返回）";
    btn.addEventListener("click", open);
    const stats = head.querySelector(".rd-stats");
    if (stats) head.insertBefore(btn, stats); else head.appendChild(btn);
  }

  let mo = null, moHost = null, moPending = false;
  function hookHost() {
    ensureEntryButton();
    const host = document.getElementById("reading-workspace") || document.body;
    if (host === moHost) return;
    if (mo) mo.disconnect();
    mo = new MutationObserver(() => {
      if (moPending) return;
      moPending = true;
      requestAnimationFrame(() => { moPending = false; ensureEntryButton(); });
    });
    mo.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    moHost = host;
  }

  function boot() {
    hookHost();
    window.addEventListener("resize", () => { if (V.dom && !V.dom.root.hidden) measure(); });
    // 主题切换要重绘场景：`--nv-*` token 会自己跟着 html[data-theme] 变，
    // 但场景里那些**内联写死**的颜色（对比度配色、边的 color）是 JS 在 renderScene
    // 时定下的，不重绘就会停在旧主题上（浅色底配深色档的金/红，直接看不见）。
    new MutationObserver(() => {
      if (V.dom && !V.dom.root.hidden && V.model) { renderScene(); renderChrome(); }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    // 读书模式被关掉时（侧栏切走 / 用户按 Esc 退出）本层必须跟着收 ——
    // 否则会留一层浮在全屏上，看起来像「页面坏了」。
    const ws = document.getElementById("reading-workspace");
    if (ws) {
      new MutationObserver(() => {
        if (ws.classList.contains("hidden") && V.dom && !V.dom.root.hidden) close();
      }).observe(ws, { attributes: true, attributeFilter: ["class"] });
    }
    if (window.KnowOriginReading && typeof window.KnowOriginReading.open === "function") hookHost();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.KnowOriginReadingNeural = { open: open, close: close, isOpen: () => !!(V.dom && !V.dom.root.hidden), _view: V };
})();
