/* 双链图谱 · 神经脉冲流动层（悬浮点亮式）
 * ------------------------------------------------------------------
 * 指针悬浮到某个节点时，只让「与它相连的那几条双链」流光，方向统一从该节点射向邻居，
 * 像一圈波纹向外扩散；指针离开后淡出。平时图谱是静的。
 *
 * 为什么改成悬浮才流（第一版是 32 条线常驻匀速跑）：
 * 常驻 32 条的问题不是"太花"，是**没有指向性** —— 处处在动就等于处处没在动，
 * 而且匀速小点连成片，观感就是一窝蚂蚁在爬。悬浮点亮之后，动的那几条恰好是
 * "我现在关心的这个节点连着谁"，动效变成了信息而不是噪声。
 *
 * 设计取舍（别推翻）：
 * 1. 不进 app.js 的逐帧主循环 —— 自己起一条 rAF，只调 getPointAtLength 取点。
 * 2. 固定大小的光点池（POOL_N 个），悬浮时动态绑定到当前节点的连线上，
 *    而不是给上百条连线各建一套 DOM。图谱重建/切节点都不重建元素。
 * 3. 尾迹 = 头点最近几帧的历史位置，不再额外算路径 —— 每帧只 POOL_N 次取点。
 * 4. 辉光用径向渐变假出来，不用 SVG blur filter（几百节点下 filter 会卡死）。
 * 5. 连线每帧都在做水波振荡（d 逐帧重写），线长缓存每 40 帧重测；
 *    长度为 0（首帧 d 还没写）时每帧重测，自愈。
 */
(function () {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const POOL_N = 18;        // 光点池上限：一个节点的双链几乎不会超过这个数，超了取最重要的几条
  // —— 流星尾 ——
  // 尾迹不能再取「最近几帧的历史位置」了：光点每帧只挪约 1% 线长，
  // 三帧历史连起来只有 3% 线长，肉眼就是一粒尘后面跟两个点 —— 不是尾巴。
  // 改成沿路径参数往回取点（uk = u - 步长），尾巴长度 = TRAIL_SPAN × 线长，
  // 精确可控、不随帧率变化，而且过弯时贴着曲线走（历史位置会在转角切角）。
  const TRAIL_N = 8;        // 尾迹节数
  const TRAIL_SPAN = 0.17;  // 尾巴总长占整条线的比例
  const TRAIL_STEP = TRAIL_SPAN / TRAIL_N;  // 每节尾迹往回退多少（u 空间）
  const HEAD_R = 4.0;       // 头点半径：流星的头
  const REMEASURE_EVERY = 40;
  const STYLE_ID = "kb-flow-pulse-style";

  const S = {
    svg: null, layer: null, aura: null, pool: [], raf: 0, tick: 0,
    index: null, dark: false, on: true,
    hoverId: "", want: 0, fade: 0, outTimer: 0
  };

  const reduceMotion = () =>
    !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const isDark = () => document.documentElement.getAttribute("data-theme") === "dark";

  // —— 辉光渐变：中心实色 → 边缘全透明 ——
  function ensureDefs(svg, dark) {
    const id = "kb-pulse-glow";
    let defs = svg.querySelector("#kb-pulse-defs");
    if (!defs) {
      defs = document.createElementNS(NS, "defs");
      defs.setAttribute("id", "kb-pulse-defs");
      svg.appendChild(defs);
    }
    defs.textContent = "";
    const grad = document.createElementNS(NS, "radialGradient");
    grad.setAttribute("id", id);
    // 深色用近白冷光（叠在暗底上像真的在发光），浅色用饱和蓝（浅底上才看得见）
    const rgb = dark ? "226,240,255" : "26,90,178";
    [[0, "1"], [40, "0.62"], [100, "0"]].forEach(([off, op]) => {
      const st = document.createElementNS(NS, "stop");
      st.setAttribute("offset", off + "%");
      st.setAttribute("stop-color", "rgb(" + rgb + ")");
      st.setAttribute("stop-opacity", op);
      grad.appendChild(st);
    });
    defs.appendChild(grad);
    return id;
  }

  // —— 一次性注入的样式表：降噪加强 + 辉光混合模式 ——
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = [
      /* focus+context 加强：app.js 只把辉光降到 0.08，节点本体还是原样亮着，
         图谱一大照样看不出焦点在哪。这里让被淡化的节点连本体和标签一起压暗。 */
      ".kb-flow-node.is-dimmed .kb-flow-dot{opacity:.26}",
      ".kb-flow-node.is-dimmed .kb-flow-dot-mid{opacity:.26}",
      ".kb-flow-node.is-dimmed .kb-flow-label{opacity:.28}",
      /* 辉光用加色混合叠出来（只深色主题：浅底上 screen 会把光洗成白色、反而消失） */
      'html[data-theme="dark"] .kb-flow-node .kb-flow-glow{mix-blend-mode:screen}',
      ".kb-pulse-layer{pointer-events:none}"
    ].join("\n");
    document.head.appendChild(st);
  }

  // —— 中心辉光呼吸：常驻，与悬浮无关。周期约 14 秒，慢到不抢戏 ——
  function ensureAura(svg, contentG, dark) {
    const body = svg.querySelector(".kb-flow-sphere-body");
    if (!body) return null;
    const cx = parseFloat(body.getAttribute("cx")) || 0;
    const cy = parseFloat(body.getAttribute("cy")) || 0;
    const r = parseFloat(body.getAttribute("r")) || 300;
    const gid = "kb-pulse-aura";
    const defs = svg.querySelector("#kb-pulse-defs");
    let grad = defs && defs.querySelector("#" + gid);
    if (!grad) {
      grad = document.createElementNS(NS, "radialGradient");
      grad.setAttribute("id", gid);
      defs.appendChild(grad);
    }
    grad.textContent = "";
    const rgb = dark ? "150,196,255" : "120,160,220";
    [[0, dark ? "0.30" : "0.18"], [45, dark ? "0.12" : "0.07"], [100, "0"]].forEach(([off, op]) => {
      const s = document.createElementNS(NS, "stop");
      s.setAttribute("offset", off + "%");
      s.setAttribute("stop-color", "rgb(" + rgb + ")");
      s.setAttribute("stop-opacity", op);
      grad.appendChild(s);
    });
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("class", "kb-pulse-aura");
    c.setAttribute("cx", cx); c.setAttribute("cy", cy); c.setAttribute("r", r * 1.15);
    c.setAttribute("fill", "url(#" + gid + ")");
    const dust = contentG.querySelector(".kb-flow-dust");
    if (dust) contentG.insertBefore(c, dust); else contentG.insertBefore(c, contentG.firstChild);
    return c;
  }

  // —— 连线索引：nodeId → 该节点伸出去的每条双链 ——
  // 每条连线登记两次（两端各一次），并记下"这条线的另一端是谁、那人有多少链"，
  // 悬浮时按对端度数降序取前 POOL_N 条 —— 先点亮最重要的关联。
  function buildIndex(svg) {
    const linksG = svg.querySelector(".kb-flow-links");
    if (!linksG) return null;
    const paths = Array.prototype.slice.call(linksG.querySelectorAll("path.kb-flow-link"));
    if (!paths.length) return null;
    const deg = new Map();
    paths.forEach((p) => {
      const s = p.dataset.src, t = p.dataset.tgt;
      if (!s || !t) return;
      deg.set(s, (deg.get(s) || 0) + 1);
      deg.set(t, (deg.get(t) || 0) + 1);
    });
    const idx = new Map();
    const put = (k, v) => { const a = idx.get(k); if (a) a.push(v); else idx.set(k, [v]); };
    paths.forEach((p) => {
      const s = p.dataset.src, t = p.dataset.tgt;
      if (!s || !t) return;
      put(s, { path: p, other: t, w: deg.get(t) || 0, asSource: true });
      put(t, { path: p, other: s, w: deg.get(s) || 0, asSource: false });
    });
    idx.forEach((arr) => arr.sort((a, b) => b.w - a.w));
    return idx;
  }

  // —— 光点池：建一次，之后只换绑定的 path，不重建 DOM ——
  function buildPool(layer, gradId) {
    const pool = [];
    for (let i = 0; i < POOL_N; i++) {
      const trail = [];
      for (let k = 0; k < TRAIL_N; k++) {
        const c = document.createElementNS(NS, "circle");
        // 由粗到细：头端 0.81×、尾端收到 0.18× 头半径 —— 是彗尾，不是一串等大的珠子
        c.setAttribute("r", (HEAD_R * (0.9 - 0.72 * ((k + 1) / TRAIL_N))).toFixed(2));
        c.setAttribute("fill", "url(#" + gradId + ")");
        c.setAttribute("opacity", "0");
        layer.appendChild(c);
        trail.push(c);
      }
      const head = document.createElementNS(NS, "circle");
      head.setAttribute("r", String(HEAD_R));
      head.setAttribute("fill", "url(#" + gradId + ")");
      head.setAttribute("opacity", "0");
      layer.appendChild(head);
      pool.push({ trail, head, path: null, dir: 1, len: 0, seed: 0, speed: 0.3 });
    }
    return pool;
  }

  // —— 悬浮绑定：把池里的光点指到「当前节点」伸出去的连线上 ——
  function bind(nodeId) {
    const arr = (S.index && S.index.get(nodeId)) || [];
    for (let i = 0; i < S.pool.length; i++) {
      const u = S.pool[i], e = arr[i];
      if (!e) { u.path = null; hideUnit(u); continue; }
      u.path = e.path;
      // 一律从悬浮节点射向对端：path 的起点是 source，
      // 悬浮的是 source 就顺着跑(1)，是 target 就倒着跑(-1)
      u.dir = e.asSource ? 1 : -1;
      u.len = 0;
      // 相位只轻微错开：几乎同时射出、又不是死板齐步 —— 一圈向外推的波纹
      u.seed = i * 0.06;
      // 慢：跑完一条线约 3.4~3.8 秒。快了就不是流星，是溅出来的火星
      u.speed = 0.27 + (i % 3) * 0.03;
    }
  }

  // 取一条束在 u 处的路径点。u 是「0→1 走完整条线」的参数，
  // dir=-1 表示这条线是倒着跑的（悬浮的是 target），此时沿路径要取 1-u。
  const pointAt = (u, uk) => {
    let p;
    try { p = u.path.getPointAtLength((u.dir > 0 ? uk : 1 - uk) * u.len); } catch (e) { return null; }
    return (p && isFinite(p.x) && isFinite(p.y)) ? p : null;
  };

  function hideUnit(u) {
    u.head.setAttribute("opacity", "0");
    for (let k = 0; k < u.trail.length; k++) u.trail[k].setAttribute("opacity", "0");
  }

  function hideAll() { S.pool.forEach(hideUnit); }

  function frame(now) {
    S.raf = requestAnimationFrame(frame);
    const t = now / 1000;
    // 中心辉光缓慢呼吸：±28% 亮度，慢到不抢戏，让整幅图谱"在呼吸"
    if (S.aura) S.aura.setAttribute("opacity", (0.72 + 0.28 * Math.sin(t * 0.45)).toFixed(3));

    // 淡入要快（悬浮立刻有反馈），淡出要慢（离开时不生硬地啪一下没了）
    S.fade += (S.want - S.fade) * (S.want > S.fade ? 0.25 : 0.10);
    if (Math.abs(S.want - S.fade) < 0.008) S.fade = S.want;
    if (S.fade <= 0.008 && S.want === 0) { hideAll(); return; }

    const remeasure = (S.tick++ % REMEASURE_EVERY) === 0;
    for (let i = 0; i < S.pool.length; i++) {
      const u = S.pool[i];
      if (!u.path) continue;
      // 线长缓存；首帧 d 还没写出来时 len 为 0，此时每帧重测直到拿到真值
      if (remeasure || !u.len) {
        try { u.len = u.path.getTotalLength() || 0; } catch (e) { u.len = 0; }
        if (!u.len) continue;
      }
      const uu = (t * u.speed + u.seed) % 1;
      const pt = pointAt(u, uu);
      if (!pt) continue;
      // 两端淡入淡出：光点不会凭空出现或突然消失；再乘整体 fade 做悬浮淡入淡出
      const life = 0.3 + 0.7 * Math.sin(uu * Math.PI);
      u.head.setAttribute("transform", "translate(" + pt.x.toFixed(1) + " " + pt.y.toFixed(1) + ")");
      u.head.setAttribute("opacity", (life * S.fade).toFixed(3));
      // 流星尾：沿路径参数往回退着取点，整条尾巴贴着曲线走
      for (let k = 0; k < u.trail.length; k++) {
        const c = u.trail[k];
        const uk = uu - (k + 1) * TRAIL_STEP;
        // uk <= 0：尾巴这一段还没进入线的起点，先不画
        if (uk <= 0) { c.setAttribute("opacity", "0"); continue; }
        const pk = pointAt(u, uk);
        if (!pk) { c.setAttribute("opacity", "0"); continue; }
        c.setAttribute("transform", "translate(" + pk.x.toFixed(1) + " " + pk.y.toFixed(1) + ")");
        // 亮度 = 两端淡入淡出 × 离头越远越淡；1.5 次幂让尾巴收得干脆，不拖泥带水
        const decay = Math.pow(1 - (k + 1) / (TRAIL_N + 1), 1.5);
        c.setAttribute("opacity", (Math.sin(uk * Math.PI) * decay * S.fade).toFixed(3));
      }
    }
  }

  function stop() { if (S.raf) cancelAnimationFrame(S.raf); S.raf = 0; }
  function run() { if (!S.raf) S.raf = requestAnimationFrame(frame); }

  function onOver(e) {
    const g = e.target && e.target.closest ? e.target.closest(".kb-flow-node") : null;
    if (!g) return;
    const id = g.dataset.nodeId;
    if (!id || id === S.hoverId) return;
    if (S.outTimer) { clearTimeout(S.outTimer); S.outTimer = 0; }
    S.hoverId = id;
    bind(id);
    S.want = 1;
    if (S.on && !reduceMotion()) run();
  }

  function onOut(e) {
    const g = e.target && e.target.closest ? e.target.closest(".kb-flow-node") : null;
    if (!g) return;
    S.hoverId = "";
    // 从一个节点滑到另一个节点时 pointerout 先于 pointerover，
    // 直接淡出会闪一下 —— 等一小会儿，若期间没有新的悬浮再真正淡出
    if (S.outTimer) clearTimeout(S.outTimer);
    S.outTimer = setTimeout(() => { S.outTimer = 0; if (!S.hoverId) S.want = 0; }, 40);
  }

  function detach() {
    stop();
    if (S.outTimer) { clearTimeout(S.outTimer); S.outTimer = 0; }
    if (S.svg) {
      S.svg.removeEventListener("pointerover", onOver);
      S.svg.removeEventListener("pointerout", onOut);
    }
    if (S.layer && S.layer.parentNode) S.layer.parentNode.removeChild(S.layer);
    if (S.aura && S.aura.parentNode) S.aura.parentNode.removeChild(S.aura);
    const defs = S.svg && S.svg.querySelector("#kb-pulse-defs");
    if (defs && defs.parentNode) defs.parentNode.removeChild(defs);
    S.svg = null; S.layer = null; S.aura = null; S.pool = []; S.index = null;
    S.hoverId = ""; S.want = 0; S.fade = 0;
  }

  function attach(svg) {
    if (!svg) return;
    detach();
    S.svg = svg;
    S.dark = isDark();
    ensureStyle();
    const gradId = ensureDefs(svg, S.dark);
    const contentG = svg.querySelector(".kb-flow-content");
    const nodesG = svg.querySelector(".kb-flow-nodes");
    if (!contentG || !nodesG) { S.svg = null; return; }

    S.aura = ensureAura(svg, contentG, S.dark);
    S.index = buildIndex(svg);
    if (!S.index) { detach(); return; }

    // 脉冲层夹在「连线命中区」和「节点」之间：光点在线上跑，但不遮住节点本体
    const layer = document.createElementNS(NS, "g");
    layer.setAttribute("class", "kb-pulse-layer");
    contentG.insertBefore(layer, nodesG);
    S.layer = layer;
    S.pool = buildPool(layer, gradId);

    // 平时不流光，只有中心辉光在呼吸 —— rAF 只做这一件事，开销可忽略
    svg.addEventListener("pointerover", onOver);
    svg.addEventListener("pointerout", onOut);
    if (!reduceMotion()) run();
  }

  function refresh() {
    if (!S.svg) return;
    const dark = isDark();
    if (dark !== S.dark) attach(S.svg);   // 渐变色是建层时烤进去的，不重建就还是旧主题的色
  }

  window.KbFlowPulse = {
    attach: attach,
    detach: detach,
    refresh: refresh,
    setEnabled: function (on) {
      S.on = !!on;
      if (!on) {
        S.want = 0; S.fade = 0; S.hoverId = "";
        hideAll();
        if (S.aura) S.aura.setAttribute("opacity", "0");
      } else if (S.svg && !reduceMotion()) {
        run();
      }
    },
    get count() { return S.pool.filter((u) => !!u.path).length; },
    get poolSize() { return S.pool.length; }
  };
})();
