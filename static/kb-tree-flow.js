/* XMind 知识框架 · 流动增强层
 * ------------------------------------------------------------------
 * 放射层级视图取消后，把它的三件东西搬到 XMind 左右树上（布局仍是左右树，不动）：
 * 1. 掌握度向上传导：悬浮节点时，它子树里的每条边有光点朝它汇聚 —— "这个节点的分是下面汇上来的"。
 * 2. 层级蔓延入场：新出现的节点从父节点位置长出来，按层级错开。展开折叠时只对新增节点播 =
 *    伞状展开（不用把整棵树重播一遍）。
 * 3. 折叠角标：有子节点的卡片边上多一个圆点按钮，点它收起/展开子树，不抢"单击开护照"。
 *
 * 不依赖 app.js 的内部函数：树结构从 layout.children 读，掌握度从卡片的 data-mastery 读。
 * 只调一个 window.renderFramework() 触发重排。
 *
 * 动效纪律（踩过坑，别推翻）：**动的那几条必须等于"我现在关心的那几条"。**
 * 传导只在悬浮节点的子树内发生，平时一个光点都没有。
 */
(function () {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const STYLE_ID = "kb-tree-flow-style";

  const SPARK_N = 30;        // 传导光点池上限
  const TRAIL_N = 6;         // 每条边的尾迹节数
  const TRAIL_SPAN = 0.15;   // 尾巴占整条边长的比例
  const ENTER_DUR = 0.42;    // 入场时长（秒）
  const ENTER_STAGGER = 0.07; // 每级延迟（秒）

  const S = {
    svg: null, layout: null,
    collapsed: new Set(),
    children: new Map(), parent: new Map(), depth: new Map(),
    allChildren: new Map(),   // 全量子节点快照（含被折叠的），只用于画角标/计数
    pos: new Map(),        // id -> {x, y} 目标位置（布局给的）
    mastery: new Map(),    // id -> 0..1
    els: new Map(),        // id -> g 元素
    edges: [],             // {el, p, c, len, seed}
    sparks: [],            // {head, trail[]}
    hoverId: "", want: 0, fade: 0,
    raf: 0, t0: 0, dark: false,
    entering: new Map(),   // id -> {px, py, depth} 正在入场的节点
    seen: new Set(),       // 上一轮可见过的节点（用来判断谁是"新出现的"）
    mo: null
  };

  const reduceMotion = () =>
    !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const isDark = () => document.documentElement.getAttribute("data-theme") === "dark";
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = [
      ".kb-tree-sparks { pointer-events: none; }",
      ".kb-tree-fold { cursor: pointer; }",
      ".kb-tree-fold-hit { fill: transparent; }",
      ".kb-tree-agg { font-size: 11px; pointer-events: none; }"
    ].join("\n");
    document.head.appendChild(st);
  }

  // —— 从 DOM + layout 反推出树结构，不碰 app.js ——
  function scan(svg, layout) {
    S.els.clear(); S.mastery.clear(); S.pos.clear();
    svg.querySelectorAll(".graph-node").forEach((g) => {
      const id = g.dataset.nodeId;
      if (!id) return;
      S.els.set(id, g);
      S.mastery.set(id, clamp((Number(g.dataset.mastery) || 0) / 100, 0, 1));
    });
    // 父子关系：layout.children 是权威来源，但它**只含当前可见的节点**
    // （折叠的子树已被 buildFrameworkLayout 过滤掉）。所以另存一份全量快照：
    // 只在某节点这次还看得见子节点时才更新，折叠那一次的"空"不覆盖旧值 ——
    // 否则节点一被折叠，它的角标就因为没有子节点而消失，再也展不开。
    S.children = new Map();
    S.parent = new Map();
    layout.children.forEach((kids, pid) => {
      const ks = kids.filter((k) => S.els.has(k));
      if (ks.length) S.allChildren.set(pid, ks);
      S.children.set(pid, ks);
      ks.forEach((k) => S.parent.set(k, pid));
    });
    // 深度：从没有父的节点往下推
    S.depth = new Map();
    const roots = Array.from(S.els.keys()).filter((id) => !S.parent.has(id));
    const walk = (id, d) => {
      if (S.depth.has(id)) return;
      S.depth.set(id, d);
      (S.children.get(id) || []).forEach((k) => walk(k, d + 1));
    };
    roots.forEach((r) => walk(r, 0));
    // 目标位置：读卡片自己的 transform（布局写在 g 上）
    S.pos.clear();
    S.els.forEach((g, id) => {
      const m = /translate\(([-\d.]+)[ ,]([-\d.]+)\)/.exec(g.getAttribute("transform") || "");
      if (m) S.pos.set(id, { x: Number(m[1]), y: Number(m[2]) });
    });
  }

  // —— 边：光点沿它流动 ——
  function scanEdges(svg) {
    if (S.edgeLayer && S.edgeLayer.parentNode) S.edgeLayer.parentNode.removeChild(S.edgeLayer);
    S.edges = [];
    svg.querySelectorAll(".graph-edge").forEach((el, i) => {
      const pair = (el.dataset.edgeNodes || "").split(/\s+/).filter(Boolean);
      if (pair.length !== 2) return;
      // data-edge-nodes 是 "parent child"；也可能反向，按父子表校正
      let p = pair[0], c = pair[1];
      if (S.parent.get(c) !== p && S.parent.get(p) === c) { p = pair[1]; c = pair[0]; }
      S.edges.push({ el, p, c, len: 0, seed: (i * 0.37) % 1 });
    });
    // 光点层：插在节点之前，光在连线上跑但不遮节点
    const layer = document.createElementNS(NS, "g");
    layer.setAttribute("class", "kb-tree-sparks");
    const nodesG = svg.querySelector(".graph-nodes");
    const viewport = svg.querySelector(".graph-viewport");
    if (nodesG && nodesG.parentNode) nodesG.parentNode.insertBefore(layer, nodesG);
    else if (viewport) viewport.appendChild(layer);
    S.edgeLayer = layer;

    const rgb = S.dark ? "226,240,255" : "26,90,178";
    S.sparks = [];
    for (let i = 0; i < SPARK_N; i++) {
      const trail = [];
      for (let k = 0; k < TRAIL_N; k++) {
        const c = document.createElementNS(NS, "circle");
        c.setAttribute("r", (3.6 * (0.9 - 0.72 * ((k + 1) / TRAIL_N))).toFixed(2));
        c.setAttribute("fill", "url(#kb-tree-glow)");
        c.setAttribute("opacity", "0");
        layer.appendChild(c);
        trail.push(c);
      }
      const head = document.createElementNS(NS, "circle");
      head.setAttribute("r", "3.6");
      head.setAttribute("fill", "url(#kb-tree-glow)");
      head.setAttribute("opacity", "0");
      layer.appendChild(head);
      S.sparks.push({ head, trail });
    }
  }

  function ensureDefs(svg) {
    const id = "kb-tree-glow";
    let defs = svg.querySelector("#kb-tree-flow-defs");
    if (!defs) {
      defs = document.createElementNS(NS, "defs");
      defs.setAttribute("id", "kb-tree-flow-defs");
      svg.appendChild(defs);
    }
    defs.textContent = "";
    const grad = document.createElementNS(NS, "radialGradient");
    grad.setAttribute("id", id);
    const rgb = S.dark ? "226,240,255" : "26,90,178";
    [[0, "1"], [45, "0.6"], [100, "0"]].forEach(([off, op]) => {
      const s = document.createElementNS(NS, "stop");
      s.setAttribute("offset", off + "%");
      s.setAttribute("stop-color", "rgb(" + rgb + ")");
      s.setAttribute("stop-opacity", op);
      grad.appendChild(s);
    });
    defs.appendChild(grad);
  }

  // —— 折叠角标：只在有子节点（且未被折叠隐藏）的卡片上画 ——
  function buildFoldButtons(svg, layout) {
    const w = layout.nodeWidth || 188, h = layout.nodeHeight || 64;
    S.els.forEach((g, id) => {
      // 用全量快照：被折叠的节点这次 S.children 是空的，但角标必须留着才能再展开
      const kids = S.allChildren.get(id) || S.children.get(id) || [];
      if (!kids.length) return;
      // side 决定角标挂在卡片的哪一侧：朝子节点伸出去的那一边
      const isLeft = g.classList.contains("graph-node-left");
      const cx = isLeft ? 0 : w;
      const on = S.collapsed.has(id);
      const btn = document.createElementNS(NS, "g");
      btn.setAttribute("class", "kb-tree-fold");
      btn.setAttribute("data-fold-id", id);
      btn.setAttribute("transform", `translate(${cx} ${h / 2})`);
      btn.setAttribute("role", "button");
      btn.setAttribute("tabindex", "0");
      btn.setAttribute("aria-label", on ? `展开「${g.getAttribute("aria-label") || ""}」的子节点` : "收起子节点");

      const hit = document.createElementNS(NS, "circle");
      hit.setAttribute("class", "kb-tree-fold-hit");
      hit.setAttribute("r", "13");
      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("r", "7.5");
      dot.setAttribute("fill", S.dark ? "#2a2f36" : "#f4f1ea");
      dot.setAttribute("stroke", S.dark ? "#7d848e" : "#9a9186");
      dot.setAttribute("stroke-width", "1.3");
      const sign = document.createElementNS(NS, "text");
      sign.setAttribute("text-anchor", "middle");
      sign.setAttribute("y", "3.6");
      sign.setAttribute("fill", S.dark ? "#d8dde4" : "#5c564e");
      sign.style.fontSize = "11px";
      // 收起时显示 +N（有几个子节点），展开时显示 −
      sign.textContent = on ? String(kids.length) : "−";
      btn.appendChild(hit); btn.appendChild(dot); btn.appendChild(sign);
      g.appendChild(btn);
    });
  }

  function toggleFold(id) {
    if (S.collapsed.has(id)) S.collapsed.delete(id); else S.collapsed.add(id);
    // 重排：renderFramework 会把 collapsed 集合喂给 buildFrameworkLayout
    if (typeof window.renderFramework === "function") window.renderFramework();
  }

  // —— 聚合掌握度：叶子取自身，内部节点取子节点平均 ——
  function aggMastery(id, guard) {
    if (guard.has(id)) return S.mastery.get(id) || 0;
    guard.add(id);
    const ks = (S.children.get(id) || []).filter((k) => S.els.has(k));
    const v = ks.length
      ? ks.reduce((s, k) => s + aggMastery(k, guard), 0) / ks.length
      : (S.mastery.get(id) || 0);
    guard.delete(id);
    return v;
  }

  // 悬浮节点子树内的边
  function subtreeEdges(rootId) {
    const out = [];
    const walk = (id) => {
      (S.children.get(id) || []).forEach((kid) => {
        if (!S.els.has(kid)) return;
        const e = S.edges.find((x) => x.p === id && x.c === kid);
        if (e) out.push(e);
        walk(kid);
      });
    };
    walk(rootId);
    return out;
  }

  const pointAt = (e, u) => {
    if (!e.len) { try { e.len = e.el.getTotalLength() || 0; } catch (err) { e.len = 0; } }
    if (!e.len) return null;
    let p;
    try { p = e.el.getPointAtLength(u * e.len); } catch (err) { return null; }
    return (p && isFinite(p.x) && isFinite(p.y)) ? p : null;
  };

  function frame(now) {
    S.raf = requestAnimationFrame(frame);
    const t = now / 1000;

    // —— 入场：新出现的节点从父节点位置长出来，按层级错开 ——
    if (S.entering.size) {
      const done = [];
      S.entering.forEach((info, id) => {
        const g = S.els.get(id);
        if (!g) { done.push(id); return; }
        const p = clamp((t - info.t0) / ENTER_DUR, 0, 1);
        const ease = 1 - Math.pow(1 - p, 3);
        const tgt = S.pos.get(id);
        if (!tgt) { done.push(id); return; }
        const x = info.px + (tgt.x - info.px) * ease;
        const y = info.py + (tgt.y - info.py) * ease;
        g.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
        g.setAttribute("opacity", ease.toFixed(3));
        if (p >= 1) { g.setAttribute("opacity", "1"); done.push(id); }
      });
      done.forEach((id) => S.entering.delete(id));
    }

    // —— 传导 ——
    S.fade += (S.want - S.fade) * (S.want > S.fade ? 0.25 : 0.10);
    if (Math.abs(S.want - S.fade) < 0.008) S.fade = S.want;

    if (S.fade > 0.01 && S.hoverId) {
      const sub = subtreeEdges(S.hoverId).slice(0, SPARK_N);
      const step = TRAIL_SPAN / TRAIL_N;
      S.sparks.forEach((sp, i) => {
        const e = sub[i];
        if (!e) { hideSpark(sp); return; }
        // 方向：一律从子节点流向悬浮的祖先方向。边本身是 parent→child 画的，
        // 所以要朝 parent 端跑 = 参数 u 从 1(子) 到 0(父)
        const uu = 1 - ((t * 0.3 + e.seed) % 1);
        const pt = pointAt(e, uu);
        if (!pt) { hideSpark(sp); return; }
        sp.head.setAttribute("transform", `translate(${pt.x.toFixed(1)} ${pt.y.toFixed(1)})`);
        sp.head.setAttribute("opacity", (Math.sin(uu * Math.PI) * 0.95 * S.fade).toFixed(3));
        for (let k = 0; k < sp.trail.length; k++) {
          const c = sp.trail[k];
          // 尾迹在运动方向的后方：u 往"来路"退，即 uu + 步长（因为是从 1 往 0 跑）
          const uk = uu + (k + 1) * step;
          if (uk >= 1) { c.setAttribute("opacity", "0"); continue; }
          const pk = pointAt(e, uk);
          if (!pk) { c.setAttribute("opacity", "0"); continue; }
          c.setAttribute("transform", `translate(${pk.x.toFixed(1)} ${pk.y.toFixed(1)})`);
          const decay = Math.pow(1 - (k + 1) / (TRAIL_N + 1), 1.5);
          c.setAttribute("opacity", (Math.sin(uk * Math.PI) * decay * S.fade).toFixed(3));
        }
      });
    } else {
      S.sparks.forEach(hideSpark);
    }
  }

  function hideSpark(sp) {
    sp.head.setAttribute("opacity", "0");
    for (let k = 0; k < sp.trail.length; k++) sp.trail[k].setAttribute("opacity", "0");
  }

  function onOver(e) {
    const g = e.target && e.target.closest ? e.target.closest(".graph-node") : null;
    if (!g) return;
    // 悬在折叠角标上不算悬浮整个节点（避免角标 hover 也触发一树光点）
    if (e.target.closest && e.target.closest(".kb-tree-fold")) return;
    const id = g.dataset.nodeId;
    if (!id || id === S.hoverId) return;
    S.hoverId = id;
    S.want = 1;
    showAgg(id, g);
  }

  function onOut(e) {
    const g = e.target && e.target.closest ? e.target.closest(".graph-node") : null;
    if (!g) return;
    if (S.hoverId === g.dataset.nodeId) { S.hoverId = ""; S.want = 0; hideAgg(); }
  }

  // 悬浮时在节点上方浮出一行聚合掌握度
  let aggEl = null;
  function showAgg(id, g) {
    hideAgg();
    const m = aggMastery(id, new Set());
    const t = document.createElementNS(NS, "text");
    t.setAttribute("class", "kb-tree-agg");
    t.setAttribute("x", "4");
    t.setAttribute("y", "-8");
    t.setAttribute("fill", S.dark ? "#e6cf98" : "#8a6a12");
    t.textContent = `子树 ${Math.round(m * 100)}%`;
    g.appendChild(t);
    aggEl = t;
  }
  function hideAgg() {
    if (aggEl && aggEl.parentNode) aggEl.parentNode.removeChild(aggEl);
    aggEl = null;
  }

  function onFoldClick(e) {
    const btn = e.target && e.target.closest ? e.target.closest(".kb-tree-fold") : null;
    if (!btn) return;
    // 别冒泡上去：单击节点是"打开语义护照"，双击是掌握度分析，都不该被角标触发
    e.stopPropagation();
    e.preventDefault();
    toggleFold(btn.dataset.foldId);
  }

  function onFoldKey(e) {
    const btn = e.target && e.target.closest ? e.target.closest(".kb-tree-fold") : null;
    if (!btn) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); toggleFold(btn.dataset.foldId); }
  }

  function watchTheme() {
    if (S.mo) S.mo.disconnect();
    if (!window.MutationObserver) return;
    S.mo = new MutationObserver(() => {
      S.dark = isDark();
      ensureDefs(S.svg);
      S.edges.forEach((e) => { e.len = 0; });
    });
    S.mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }

  function attach(svg, layout) {
    if (!svg || !layout) return;
    detach();
    S.svg = svg; S.layout = layout;
    S.dark = isDark();
    ensureStyle();
    ensureDefs(svg);
    scan(svg, layout);
    scanEdges(svg);
    buildFoldButtons(svg, layout);

    // 入场：只对"上一轮没见过"的节点播 —— 展开折叠时新增的子树才长出来（伞状展开）
    const t = performance.now() / 1000;
    const firstRun = S.seen.size === 0;
    S.els.forEach((g, id) => {
      if (!firstRun && S.seen.has(id)) return;
      const tgt = S.pos.get(id);
      if (!tgt) return;
      const pid = S.parent.get(id);
      const from = (pid && S.pos.get(pid)) || tgt;
      const d = S.depth.get(id) || 0;
      S.entering.set(id, { px: from.x, py: from.y, t0: t + d * ENTER_STAGGER });
      g.setAttribute("opacity", "0");
    });
    S.seen = new Set(S.els.keys());
    if (reduceMotion()) { S.entering.clear(); S.els.forEach((g) => g.setAttribute("opacity", "1")); }

    svg.addEventListener("pointerover", onOver);
    svg.addEventListener("pointerout", onOut);
    svg.addEventListener("click", onFoldClick, true);   // 捕获阶段，先于节点自身的单击
    svg.addEventListener("dblclick", onFoldClick, true);
    svg.addEventListener("keydown", onFoldKey, true);
    watchTheme();

    if (!S.raf) S.raf = requestAnimationFrame(frame);
  }

  function detach() {
    if (S.raf) cancelAnimationFrame(S.raf);
    S.raf = 0;
    hideAgg();
    if (S.svg) {
      S.svg.removeEventListener("pointerover", onOver);
      S.svg.removeEventListener("pointerout", onOut);
      S.svg.removeEventListener("click", onFoldClick, true);
      S.svg.removeEventListener("dblclick", onFoldClick, true);
      S.svg.removeEventListener("keydown", onFoldKey, true);
    }
    if (S.mo) { S.mo.disconnect(); S.mo = null; }
    if (S.edgeLayer && S.edgeLayer.parentNode) S.edgeLayer.parentNode.removeChild(S.edgeLayer);
    const defs = S.svg && S.svg.querySelector("#kb-tree-flow-defs");
    if (defs && defs.parentNode) defs.parentNode.removeChild(defs);
    S.edgeLayer = null; S.edges = []; S.sparks = [];
    S.els.clear(); S.hoverId = ""; S.want = 0; S.fade = 0;
    S.entering.clear();
  }

  window.KbTreeFlow = {
    attach: attach,
    detach: detach,
    // 给 buildFrameworkLayout 用：被折叠节点的整棵子树不参与布局
    collapsed: function () { return S.collapsed; },
    reset: function () { S.collapsed.clear(); S.seen.clear(); S.allChildren.clear(); },
    get visibleCount() { return S.els.size; },
    get collapsedCount() { return S.collapsed.size; }
  };
})();
