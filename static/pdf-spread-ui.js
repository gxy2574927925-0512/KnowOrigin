/* 文献精读 · 整页对照翻译（版式保真）
 *
 * 左栏沿用原页阅读器已有的原文页图，右栏换成 pdf2zh 产出的**译文页图**——
 * 图表公式原位保留，就是 Zotero 那套双语对照效果。
 *
 * 完全靠 DOM 挂接，不改 literature.js：文献 id / 来源 id 从原文页图的 src 里解析，
 * 当前页从底栏页码标签读，翻页用 MutationObserver 跟随。删掉 index.html 里
 * 本文件的 <script> 那一行即完全回退。
 */
(function () {
  "use strict";

  var POLL_MS = 6000;
  var DPI = 130; // 与后端 spreads 缓存文件名绑定（right_{index}_{dpi}.png），改动要同步
  var MODE_KEY = "knoworigin-pdf-spread-mode";   // "side"（默认，侧栏） / "spread"（左右各 50% 铺满）
  var ZOOM_MIN = 0.5;  // 与 literature.js setOrigZoom() 的夹取范围保持一致
  var ZOOM_MAX = 3.0;
  var st = {
    pid: "",
    sid: "",
    pages: "", // 翻译时的页码范围，参与后端缓存键，后续所有请求都要带上
    index: 0,
    total: 0,
    on: false,
    mode: "side",          // "side" / "spread"
    tl: null,              // 当前译文页的文本层 { w, lines }，随 /spread 一起取回
    timer: null,
    obs: null,
    spreadModeDirty: false, // 进入铺满模式时该=true；退出时用来决定要不要把原文翻译栏放回来
  };

  function readPref(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v == null ? fallback : v;
    } catch (_) { return fallback; }
  }
  function writePref(key, val) {
    try { localStorage.setItem(key, String(val)); } catch (_) { /* 隐私模式写不进去也不影响本次 */ }
  }

  function q(sel) {
    return document.querySelector(sel);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // 原文页图 src 形如 /api/projects/<pid>/sources/<sid>/page-image?...
  function ids() {
    var img = q("[data-orig-img]");
    var m = img && img.src ? img.src.match(/\/api\/projects\/([^/]+)\/sources\/([^/]+)\//) : null;
    if (m) return { pid: decodeURIComponent(m[1]), sid: decodeURIComponent(m[2]) };
    return null;
  }

  function pageInfo() {
    var lab = q("[data-orig-pagelabel]");
    var m = (lab && lab.textContent || "").match(/(\d+)\s*\/\s*(\d+)/);
    return m ? { index: Math.max(0, parseInt(m[1], 10) - 1), total: parseInt(m[2], 10) } : { index: 0, total: 0 };
  }

  function baseUrl() {
    var id = ids();
    if (!id) return null;
    st.pid = id.pid;
    st.sid = id.sid;
    return "/api/literature/" + encodeURIComponent(id.pid) + "/translate-pdf";
  }

  // 译文页必须先问后端 /spread：它负责「按需把该组两页栅格化成 PNG 并缓存」，
  // 再把可用的 URL 回给我们。/spread-image 只读缓存、从不渲染——直接拼它的地址，
  // 缓存里没图时就是 404，界面上表现为右边一张裂图。
  async function loadSpread(index) {
    var base = baseUrl();
    if (!base || !st.on) return;
    var bodyEl = q("[data-ps-body]");
    var img = q("[data-pdf-spread-pane] img.ps-img");
    if (bodyEl && !img) {
      bodyEl.innerHTML = '<div class="ps-page ps-loading"><span class="ps-spin"></span></div>';
    }
    try {
      var res = await window.api(
        base +
          "/spread?source_id=" + encodeURIComponent(st.sid) +
          "&pages=" + encodeURIComponent(st.pages) +
          "&index=" + index + "&dpi=" + DPI
      );
      if (!st.on) return; // 请求期间用户关掉了对照，别再往上贴
      var url = (res.right_url || "") + "&t=" + Date.now();
      if (typeof res.index === "number") st.index = res.index;
      if (typeof res.total === "number" && res.total > 0) st.total = res.total;
      // 译文页文本层随 /spread 一起回来：页宽（换算比例）+ 逐行 bbox/文字
      st.tl = { w: res.right_w || 0, lines: res.right_text_layer || [] };
      _linkHit = null; // 换页了：上一页的联动色块属于旧页的行号，必须丢掉
      _linkSeq++;      // 同时作废在途请求，别让它回来画到新页上
      img = q("[data-pdf-spread-pane] img.ps-img");
      if (!img && bodyEl) {
        bodyEl.innerHTML =
          '<div class="ps-page"><img class="ps-img" alt="译文页">' +
          '<div class="ps-hl-layer" data-ps-hl></div>' +
          '<div class="ps-link-layer" data-ps-link></div>' +
          '<div class="ps-text-layer" data-ps-tl></div></div>' +
          '<div class="ps-foot"><a class="ps-link" target="_blank" rel="noopener" href="' +
          base + '/file?source_id=' + encodeURIComponent(st.sid) + '&pages=' + encodeURIComponent(st.pages) +
          '">打开双语 PDF</a><span class="ps-hint">左原文 · 右译文，图表公式原位保留</span></div>';
        img = q("[data-pdf-spread-pane] img.ps-img");
      }
      if (img) {
        // 先挂 onload 再写 src：图加载完才有正确的宽度/高度，文本层要等那时候才量得准
        img.onload = layoutText;
        img.src = url;
        img.setAttribute("data-ps-index", String(index));
        observeImg(img);
      }
      setStatus("第 " + (st.index + 1) + " / " + (res.total || st.total) + " 组");
      // 图刚贴上：如果抓手是开着的，把译文的可拖拽状态接上（innerHTML 重写会丢类名/监听）
      syncGrab();
    } catch (err) {
      setStatus("渲染失败");
      if (bodyEl) {
        bodyEl.innerHTML = '<div class="ps-empty"><p>' + esc(err.message || "该页渲染失败") + '</p>' +
          '<button class="secondary-button" type="button" data-ps-reload>重试</button></div>';
      }
    }
  }

  // ---------------------------------------------------------------- 译文页文本层
  // 译文页本身是 PNG（栅格图，没字可选）。这里把 dual PDF 译文页的**真实文本层**
  // 透明地叠上去，几何与左栏共用一套（window.KnowOriginOrigText）：
  // 图上看到的字与能选中的字是同一批，选中时靠 ::selection 出底色高亮。
  function layoutText() {
    var pane = q("[data-pdf-spread-pane]");
    var tl = pane && pane.querySelector("[data-ps-tl]");
    if (!tl) return;
    tl.innerHTML = ""; // 先清空：换到没有文本层的页（扫描件）时不能留上一页的残影
    var hl = pane.querySelector("[data-ps-hl]");
    if (hl) hl.innerHTML = "";
    var img = pane.querySelector("img.ps-img");
    var api = window.KnowOriginOrigText;
    if (!img || !api || !img.clientWidth || !st.tl || !st.tl.lines.length) return;
    var scale = img.clientWidth / (st.tl.w || img.naturalWidth || 612);
    var fit = [];
    for (var i = 0; i < st.tl.lines.length; i++) {
      var ln = st.tl.lines[i];
      if (!ln || !ln.bbox || ln.bbox.length !== 4) continue;
      var span = document.createElement("span");
      span.className = "ps-tl-line";
      // data-line = /spread 的 right_text_layer 行号，/link 与高亮都拿它当索引
      span.dataset.line = String(i);
      span.textContent = api.trimLine(ln.text);
      api.setLineGeo(span, ln.bbox, scale);
      tl.appendChild(span);
      fit.push(span);
    }
    // 已落库的译文页高亮：和左栏共用 store.originalHl（side="ps"），
    // 行内区间由 literature.js 的 renderOrigHlLine 渲染，字号贴合一起做（同一个 fitList）。
    if (hl && api.hlSegsFor && api.renderHlLine) {
      var segs = api.hlSegsFor(st.index, "ps");
      if (segs && segs.length) {
        for (var k = 0; k < st.tl.lines.length; k++) {
          var mk = api.renderHlLine(hl, k, st.tl.lines[k], st.tl.lines[k].bbox, scale, segs);
          if (mk) fit.push(mk);
        }
      }
    }
    api.fitLines(fit, tl);
    paintLinkLayers(); // 图宽变了，联动高亮的色块要跟着重贴
  }

  // 图宽变了（侧栏↔铺满、缩放、窗口/界面缩放）就重排文本层。
  // 只盯页图：文本层是绝对定位子层，改它的字号不会反过来改变图宽 —— 不会自激。
  var _ro = null;
  function observeImg(img) {
    if (typeof ResizeObserver === "undefined") return;
    if (!_ro) _ro = new ResizeObserver(function () { layoutText(); });
    _ro.disconnect(); // 换页/重渲染会换 <img>，先放开旧的（RO 强持有目标）
    _ro.observe(img);
  }

  // ================================================================ 跨栏联动高亮
  // 在**任意一栏**划词，都要去问「对面那栏对应哪几行」，然后把对面涂上同色底，
  // 看起来就是两边同时被选中。对应关系**推不出来**（pdf2zh 只保留图表原位，
  // 正文按译文长度重排过，按坐标配会整片配错），所以问一次模型 —— 见后端 /link。
  var LINK_DEBOUNCE = 320;
  var _linkTimer = null;
  var _linkSeq = 0;      // 只认最后一次请求的返回，防止慢响应盖掉新选区
  var _linkCache = {};   // "index|side|s|e" -> {side,start,end}
  var _linkHit = null;   // 当前生效的联动结果，图宽一变就靠它重贴

  function setLinkState(text, mod) {
    var el = q("[data-ps-link-state]");
    if (!el) return;
    el.textContent = text || "";
    el.className = "ps-link-state" + (mod ? " is-" + mod : "");
  }

  // 当前选区在哪一栏、覆盖哪几行（行号口径：左栏 = 原件 text_layer，右栏 = 译文页 text_layer）
  function selectionTarget() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    var nodeEl = function (n) { return n && n.nodeType === 1 ? n : (n && n.parentElement) || null; };
    var aEl = nodeEl(sel.anchorNode);
    var fEl = nodeEl(sel.focusNode);
    var side = null;
    if ((aEl && aEl.closest(".ps-tl-line")) || (fEl && fEl.closest(".ps-tl-line"))) side = "right";
    else if ((aEl && aEl.closest(".orig-tl-line")) || (fEl && fEl.closest(".orig-tl-line"))) side = "left";
    if (!side) return null;
    var cls = side === "right" ? ".ps-tl-line" : ".orig-tl-line";
    var lines = [];
    for (var i = 0; i < 2; i++) {
      var sp = (i ? fEl : aEl) && (i ? fEl : aEl).closest(cls);
      var v = sp && sp.dataset ? Number(sp.dataset.line) : NaN;
      if (Number.isFinite(v)) lines.push(v);
    }
    if (!lines.length) return null;
    return {
      side: side,
      start: Math.min.apply(null, lines),
      end: Math.max.apply(null, lines),
    };
  }

  function onSelectionSettled() {
    if (!st.on) return;
    var now = selectionTarget();
    if (!now) { _linkSeq++; clearLink(); return; }
    var key = st.index + "|" + now.side + "|" + now.start + "|" + now.end;
    if (_linkCache[key]) { applyLink(_linkCache[key]); return; }
    var seq = ++_linkSeq;
    setLinkState("↔ 对齐中…", "busy");
    window.api(baseUrl() + "/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_id: st.sid, pages: st.pages, index: st.index,
        side: now.side, start: now.start, end: now.end,
      }),
    }).then(function (res) {
      if (seq !== _linkSeq) return; // 用户又换了选区，这份结果已经过期
      if (res && res.ok) {
        var hit = { side: res.side, start: res.start, end: res.end };
        _linkCache[key] = hit;
        applyLink(hit);
      } else {
        clearLink(res && res.reason);
      }
    }).catch(function () {
      if (seq === _linkSeq) clearLink("error");
    });
  }

  function applyLink(hit) {
    _linkHit = hit;
    paintLinkLayers();
    setLinkState("↔ 已联动", "");
  }

  function clearLink(reason) {
    _linkHit = null;
    paintLinkLayers();
    setLinkState(reason === "model_unavailable" ? "↔ 未配模型" : reason ? "↔ 未找到对应" : "", "miss");
  }

  // 按当前 _linkHit 重贴两栏的色块。左栏交给 literature.js（它才是那一层的 DOM 主人），
  // 右栏自己画。两边互斥：只有一边会有联动高亮。
  function paintLinkLayers() {
    var pane = q("[data-pdf-spread-pane]");
    var layer = pane && pane.querySelector("[data-ps-link]");
    if (layer) layer.innerHTML = "";
    var api = window.KnowOriginOrigText;
    var onPs = !!(_linkHit && _linkHit.side === "right");
    if (api && typeof api.showLink === "function") {
      if (!onPs && _linkHit && _linkHit.side === "left") api.showLink(_linkHit.start, _linkHit.end);
      else api.showLink(-1, -1);
    }
    if (!onPs || !layer) return;
    var img = pane.querySelector("img.ps-img");
    if (!img || !img.clientWidth || !st.tl) return;
    var scale = img.clientWidth / (st.tl.w || img.naturalWidth || 612);
    for (var i = _linkHit.start; i <= _linkHit.end; i++) {
      var bb = st.tl.lines[i] && st.tl.lines[i].bbox;
      if (!bb || bb.length !== 4) continue;
      var d = document.createElement("div");
      d.className = "ps-link-box";
      d.style.left = (bb[0] * scale) + "px";
      d.style.top = (bb[1] * scale) + "px";
      d.style.width = (Math.max(4, bb[2] - bb[0]) * scale) + "px";
      d.style.height = (Math.max(6, bb[3] - bb[1]) * scale) + "px";
      layer.appendChild(d);
    }
  }

  function queueLink() {
    window.clearTimeout(_linkTimer);
    // 拖选过程中 selectionchange 会连发，等手停下来再问，别把每次位移都变成一次模型调用
    _linkTimer = window.setTimeout(onSelectionSettled, LINK_DEBOUNCE);
  }

  // 选区在文献阅读区里才管；点到别处（输入框、面板文字）不触发。
  // ⚠️ 选区被清空时 anchorNode 是 null —— 早期版本在这里直接 return，结果「点一下空白处」
  // 联动色块留在原地收不掉（探针 V9 抓到的）。清空同样要收尾。
  document.addEventListener("selectionchange", function () {
    if (!st.on) return;
    var sel = window.getSelection();
    var n = sel && !sel.isCollapsed ? sel.anchorNode : null;
    var el = n && (n.nodeType === 1 ? n : n.parentElement);
    if (!el || !el.closest || !el.closest(".sr-reader-body")) {
      // 只在「确实有东西要收」时才动手，免得在别处打字时每动一次光标都白跑一遍
      if (_linkHit) {
        window.clearTimeout(_linkTimer);
        onSelectionSettled();
      }
      return;
    }
    queueLink();
  });

  // 供 literature.js 调用：译文页高亮落库后重画这一层；以及把译文页行数据借出去
  // （划词气泡要用它算 bbox）。挂 window 而不是 import —— 两个文件都是经典 <script>。
  window.KnowOriginPsPane = {
    refreshHl: function () { layoutText(); },
    lines: function () { return (st.tl && st.tl.lines) || []; },
    page: function () { return st.index; },
  };

  // ---------------------------------------------------------------- 入口按钮
  function ensureButton() {
    var nav = q("[data-orig-pagenav]");
    if (!nav || q("[data-pdf-spread-toggle]")) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "secondary-button pdf-spread-toggle";
    btn.setAttribute("data-pdf-spread-toggle", "1");
    btn.textContent = "整页对照";
    btn.title = "版式保真翻译：左原文页 / 右译文页，图表公式原位保留";
    btn.addEventListener("click", function () {
      st.on = !st.on;
      apply();
    });
    nav.appendChild(btn);
    st.btn = btn;
  }

  function ensurePane() {
    // 必须挂 .orig-pan-canvas（不是 .orig-body）：canvas 是左右两栏共用的滚动容器，
    // 译文栏做它的直接子项才能和 .orig-stage 共享 scrollLeft/scrollTop —— 这就是联动。
    // 挂到 body 上就变成「body 的第三个 flex 子项」，脱离 canvas 滚动，拖不动。
    var host = q("[data-orig-canvas]") || q("[data-orig-body]");
    if (!host) return null;
    var pane = q("[data-pdf-spread-pane]");
    if (pane && pane.parentNode !== host) host.appendChild(pane);
    if (!pane) {
      pane = document.createElement("div");
      pane.className = "pdf-spread-pane hidden";
      pane.setAttribute("data-pdf-spread-pane", "1");
      pane.hidden = true;
      host.appendChild(pane);
    }
    return pane;
  }

  function apply() {
    var pane = ensurePane();
    if (!pane) return;
    var body = q("[data-orig-body]");
    var trans = q("[data-orig-trans]");
    var handle = q("[data-orig-body] .orig-trans-resizer");
    var info = pageInfo();
    st.index = info.index;
    st.total = info.total;
    if (st.btn) {
      st.btn.classList.toggle("active", st.on);
      st.btn.setAttribute("aria-pressed", st.on ? "true" : "false");
    }
    pane.hidden = !st.on;
    pane.classList.toggle("hidden", !st.on);
    if (st.on) {
      // 记下它被我们藏起来之前的显隐，关掉对照时原样还回去
      if (trans) {
        st.prevTransHidden = trans.classList.contains("hidden");
        trans.classList.add("hidden");
        trans.hidden = true;
      }
      if (handle) handle.classList.add("hidden");
      // 应用当前模式：铺满 ↔ 侧栏；缩放读数从原文阅读器同步过来
      applyMode();
      syncZoomFromReader();
    } else {
      // 关掉对照时复原——包括隐藏我们自己加的 spread-mode 类
      if (trans) {
        var hidden = st.prevTransHidden !== false;
        trans.classList.toggle("hidden", hidden);
        trans.hidden = hidden;
        if (handle) handle.classList.toggle("hidden", hidden);
      }
      if (body) body.classList.remove("is-spread-mode");
      pane.classList.remove("is-spread-mode");
      st.spreadModeDirty = false;
      clearLink(); // 关掉对照：两栏的联动高亮都要收干净
    }
    if (st.on) render();
    else stopPolling();
  }

  // 模式：侧栏 ↔ 铺满双页。状态写入 localStorage，刷新后恢复
  function applyMode() {
    var pane = q("[data-pdf-spread-pane]");
    var body = q("[data-orig-body]");
    if (!pane) return;
    var spread = st.mode === "spread";
    pane.classList.toggle("is-spread-mode", spread);
    if (body) body.classList.toggle("is-spread-mode", spread);
    st.spreadModeDirty = spread;
    // 顶部切换按钮：当前是 spread 时按钮文案显示「侧栏」提示可切回，按下=pressed
    var btn = q("[data-ps-mode]");
    if (btn) {
      btn.setAttribute("aria-pressed", spread ? "true" : "false");
      btn.textContent = spread ? "侧栏" : "铺满双页";
      btn.title = spread
        ? "切回侧栏显示（让出更多阅读器空间给批注/笔记）"
        : "左右各占 50% 铺满双页，方便逐字对照阅读";
    }
    // 缩放按钮在两种模式下都启用——铺满双页更适合放大查看细节
    syncZoomButtons();
  }

  // 缩放：整页对照与原文阅读器共用**一套** zoom。
  // literature.js 的 applyOrigZoom() 把 --ps-zoom 写在 [data-orig-body] 上，
  // 左右两栏（原文页 wrap 与译文页 .ps-img）一起吃这个值。
  // 本模块**不能**再往 pane 上写一份 --ps-zoom——pane 是 body 的后代，自己那份
  // 会盖掉继承来的值，结果就是「原文放大、译文不动」，对照就没法看。
  // 所以这里的 +/- 只是替用户去点原文阅读器那对按钮，再把读数同步过来。
  function readerZoomBtn(dir) {
    return q('[data-orig="' + (dir > 0 ? "zoom-in" : "zoom-out") + '"]');
  }

  function readerZoom() {
    var lab = q("[data-orig-label]");
    var m = (lab && lab.textContent || "").match(/(\d+(?:\.\d+)?)\s*%/);
    return m ? parseFloat(m[1]) / 100 : 1;
  }

  function syncZoomFromReader() {
    var z = readerZoom();
    var label = q("[data-ps-zoom]");
    var txt = Math.round(z * 100) + "%";
    // 只在真的变了才写：observer 监听 characterData，无脑写会自激成死循环
    if (label && label.textContent !== txt) label.textContent = txt;
    syncZoomButtons(z);
  }

  function syncZoomButtons(z) {
    if (z == null) z = readerZoom();
    var minus = q("[data-ps-zoom-out]");
    var plus = q("[data-ps-zoom-in]");
    if (minus) minus.disabled = z <= ZOOM_MIN + 1e-6;
    if (plus) plus.disabled = z >= ZOOM_MAX - 1e-6;
  }

  function stepZoom(dir) {
    var btn = readerZoomBtn(dir);
    if (btn && !btn.disabled) btn.click();
    syncZoomFromReader();
  }

  // ---------------------------------------------------------------- 渲染
  function render() {
    var pane = q("[data-pdf-spread-pane]");
    var base = baseUrl();
    if (!pane || !base) return;
    if (!pane.dataset.bound) {
      pane.dataset.bound = "1";
      pane.addEventListener("click", onPaneClick);
    }
    pane.innerHTML = '<div class="ps-head"><span class="ps-title">整页对照 · 译文页</span>' +
      '<span class="ps-status" data-ps-status>载入中…</span>' +
      '<span class="ps-link-state" data-ps-link-state title="在两栏任意一侧选中文字，对面栏的对应行会同时高亮"></span>' +
      '<button type="button" class="ps-zoom-btn" data-ps-zoom-out title="缩小译文页" aria-label="缩小译文页">−</button>' +
      '<span class="ps-zoom" data-ps-zoom>100%</span>' +
      '<button type="button" class="ps-zoom-btn" data-ps-zoom-in title="放大译文页" aria-label="放大译文页">+</button>' +
      '<button type="button" class="ps-mode-btn" data-ps-mode aria-pressed="false" title="左右各占 50% 铺满双页，方便逐字对照阅读">铺满双页</button>' +
      '</div>' +
      '<div class="ps-body" data-ps-body></div>';
    applyMode();
    syncZoomFromReader();
    _linkHit = null; // 面板被整块重写过，上一轮的联动色块已经不存在了
    setLinkState("");
    refresh();
  }

  // 抓手模式：译文栏不是独立滚动容器 —— 它挂在 .orig-pan-canvas 下，
  // 与原页 .orig-stage 共用同一个 scrollLeft/scrollTop（左右联动的实现）。
  // 所以这里只需确认「译文栏还在 canvas 里」并把抓手状态重新同步一次，
  // 真正的事件委托在 literature.js 的 initOrigPan（它管 canvas）。
  function syncGrab() {
    getPaneHost();
    var host = window.KnowOriginOrigGrab;
    if (host && typeof host.refresh === "function") host.refresh();
  }

  // 译文栏一旦脱离了 canvas（阅读器重渲染会重建整棵 DOM），就得挪回去，
  // 否则它变成 .orig-body 的 flex 子项：既不在滚动容器里，拖动画布时也纹丝不动。
  function getPaneHost() {
    var pane = q("[data-pdf-spread-pane]");
    if (!pane) return null;
    var canvas = q("[data-orig-canvas]");
    if (canvas && pane.parentNode !== canvas) canvas.appendChild(pane);
    return pane;
  }

  function onPaneClick(e) {
    var start = e.target.closest("[data-ps-start]");
    if (start) {
      var input = q("[data-ps-pages]");
      startTranslation((input && input.value || "").trim());
      return;
    }
    // 模式切换：侧栏 ↔ 铺满双页
    var modeBtn = e.target.closest("[data-ps-mode]");
    if (modeBtn) {
      st.mode = st.mode === "spread" ? "side" : "spread";
      writePref(MODE_KEY, st.mode);
      applyMode();
      return;
    }
    // 缩放 +/-：委托给原文阅读器，保证左右两栏是同一套 zoom
    var zoomOut = e.target.closest("[data-ps-zoom-out]");
    if (zoomOut) {
      stepZoom(-1);
      return;
    }
    var zoomIn = e.target.closest("[data-ps-zoom-in]");
    if (zoomIn) {
      stepZoom(1);
      return;
    }
    // 老接口保留：data-ps-wide 仍存在 CSS 类名（避免旧 CSS 断样式），但本次不再当入口用
    var wide = e.target.closest("[data-ps-wide]");
    if (wide) {
      // 已切换为模式按钮，此处不再响应——防止有人改回去再点出现按钮无反应
      return;
    }
    if (e.target.closest("[data-ps-reload]")) {
      loadSpread(st.index);
      return;
    }
    if (e.target.closest("[data-ps-retry]")) {
      startTranslation(st.pages);
    }
  }

  function setStatus(text) {
    var el = q("[data-ps-status]");
    if (el) el.textContent = text;
  }

  async function refresh() {
    var base = baseUrl();
    if (!base || !st.on) return;
    var bodyEl = q("[data-ps-body]");
    try {
      var res = await window.api(base + "/status?source_id=" + encodeURIComponent(st.sid) + "&pages=" + encodeURIComponent(st.pages));
      if (!res.available) {
        if (bodyEl) bodyEl.innerHTML = '<div class="ps-empty"><p>未检测到版式翻译工具 pdf2zh。</p>' +
          '<p class="ps-hint">它是可选组件，未安装时其余功能不受影响。</p></div>';
        setStatus("不可用");
        return;
      }
      if (res.dual_ready) {
        stopPolling();
        setStatus("第 " + (st.index + 1) + " / " + (res.spreads || st.total) + " 组");
        // 同一页已经贴好图就别重写 DOM，否则 <img> 被掀掉会白发一次请求；
        // 只有「还没有图」或「页码变了」才去 /spread 取（它会顺手渲染）。
        var cur = q("[data-pdf-spread-pane] img.ps-img");
        if (!cur || cur.getAttribute("data-ps-index") !== String(st.index)) {
          loadSpread(st.index);
        }
        return;
      }
      if (res.state === "running") {
        setStatus("翻译中…");
        if (bodyEl) bodyEl.innerHTML = '<div class="ps-empty"><span class="ps-spin"></span>' +
          '<p>正在整页翻译，约 1 分钟 / 页，可先继续读原文。</p></div>';
        startPolling();
        return;
      }
      if (res.state === "failed") {
        setStatus("失败");
        if (bodyEl) bodyEl.innerHTML = '<div class="ps-empty"><p>翻译失败：' + esc(res.error || "未知错误") + '</p>' +
          '<button class="secondary-button" type="button" data-ps-retry>重试</button></div>';
        return;
      }
      // idle：给一个页码范围输入，默认当前页起 10 页（整篇 30 页要半小时，别默认全翻）
      var from = st.index + 1;
      var to = Math.min(st.total || from + 9, from + 9);
      setStatus("未翻译");
      if (bodyEl) {
        bodyEl.innerHTML =
          '<div class="ps-setup"><p>整页翻译会调用大模型，按页计费、约 1 分钟 / 页。</p>' +
          '<label class="ps-field">页码范围<input type="text" data-ps-pages value="' +
          (st.total ? from + "-" + to : String(from)) + '" placeholder="如 1-10"></label>' +
          '<button class="primary-button" type="button" data-ps-start>开始翻译</button></div>';
      }
    } catch (err) {
      setStatus("出错");
      if (bodyEl) bodyEl.innerHTML = '<div class="ps-empty"><p>' + esc(err.message || "状态查询失败") + "</p></div>";
    }
  }

  async function startTranslation(pages) {
    var base = baseUrl();
    if (!base) return;
    st.pages = pages || "";
    try {
      await window.api(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_id: st.sid, pages: st.pages, force: false }),
      });
    } catch (err) {
      setStatus("启动失败");
      var bodyEl = q("[data-ps-body]");
      if (bodyEl) bodyEl.innerHTML = '<div class="ps-empty"><p>' + esc(err.message || "无法启动翻译") + "</p></div>";
      return;
    }
    startPolling();
    refresh();
  }

  function startPolling() {
    stopPolling();
    st.timer = setInterval(refresh, POLL_MS);
  }

  function stopPolling() {
    if (st.timer) {
      clearInterval(st.timer);
      st.timer = null;
    }
  }

  // ---------------------------------------------------------------- 挂接
  function mount() {
    ensureButton();
    if (st.on) ensurePane();
  }

  function watch() {
    if (st.obs) st.obs.disconnect();
    st.obs = new MutationObserver(function () {
      mount();
      if (!st.on) return;
      var info = pageInfo();
      if (info.index !== st.index && info.total) {
        st.index = info.index;
        st.total = info.total;
        // 只有对照已经出图时才跟随翻页；还在「未翻译」表单阶段就别乱发请求
        if (q("[data-pdf-spread-pane] img.ps-img")) loadSpread(st.index);
      }
      // 阅读器整块重渲染后按钮/面板会丢失，补回来并保持开关状态
      var pane = q("[data-pdf-spread-pane]");
      if (st.on && !pane) {
        ensurePane();
        apply();
      }
      // 用户在原文阅读器那边直接点缩放时，译文栏读数也要跟上
      syncZoomFromReader();
      // 译文栏是后注入的：它出现后要把抓手状态接上（否则放大了一直拖不动）
      syncGrab();
    });
    st.obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function boot() {
    // 恢复用户的铺满双页偏好（缩放任由原文阅读器管，不在这里存）
    var savedMode = readPref(MODE_KEY, "side");
    st.mode = savedMode === "spread" ? "spread" : "side";
    watch();
    mount();
    syncGrab();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
