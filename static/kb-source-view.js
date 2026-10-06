/* ==================== 来源视图（资料 ⇄ 概念 二部图） ====================
   双链图谱看「知识点之间」的关系，来源视图看「资料与知识点」的关系：
   一个概念被几份资料支撑。多份 = 交叉验证；仅一份 = 孤证，提示换来源补。

   数据全部来自现成的 node.source_ids 与 state.sources：不改库、不改模型、
   不碰 P0 禁改清单。仅在本文件内实现，app.js 只保留最小挂载钩子。
   ========================================================================== */

const KB_SRC_COLS = 3;
const KB_SRC_X = 60;          // 资料列起点
const KB_SRC_W = 240;         // 资料卡片宽
const KB_SRC_H = 56;
const KB_SRC_PITCH = 84;      // 资料行距
const KB_CPT_X = 560;         // 概念列起点
const KB_CPT_W = 320;
const KB_CPT_H = 60;
const KB_CPT_PITCH = 78;
const KB_CPT_COL_PITCH = 364;
const KB_SRC_TOP = 56;

// 近似按像素宽度截断文本（CJK 按 1 字宽估，拉丁按 0.55 字宽估）
function kbSrcClip(text, maxPx) {
  const str = String(text == null ? "" : text);
  let width = 0;
  let out = "";
  for (const ch of str) {
    const w = /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 12.5 : 6.9;
    if (width + w > maxPx) return out + "…";
    width += w;
    out += ch;
  }
  return out;
}

// 组图数据：资料节点 + 概念节点 + 支撑关系
// override 用于「不是当前课程」的场景（文献组合的来源视图）：直接喂 {nodes, sources, favorites}，
// 不传则读全局 state —— 课程侧的既有调用一行都不用改。
function kbSourceData(override) {
  const src = (override && typeof override === "object") ? override : state;
  const nodes = Array.isArray(src.nodes) ? src.nodes : [];
  const sources = (Array.isArray(src.sources) ? src.sources : []).filter((s) => s && s.source_id);
  const byId = new Map(sources.map((s) => [s.source_id, s]));
  const linked = [];
  const orphan = [];
  nodes.forEach((node) => {
    const ids = Array.isArray(node.source_ids) ? node.source_ids.filter((id) => byId.has(id)) : [];
    if (ids.length) linked.push({ node, sourceIds: ids });
    else orphan.push(node);
  });
  // 支撑数多的排前面：交叉验证的概念先看
  linked.sort((a, b) => (b.sourceIds.length - a.sourceIds.length) || String(a.node.name).localeCompare(String(b.node.name), "zh"));
  const support = new Map();
  sources.forEach((s) => support.set(s.source_id, 0));
  linked.forEach((item) => item.sourceIds.forEach((id) => support.set(id, (support.get(id) || 0) + 1)));
  const single = linked.filter((item) => item.sourceIds.length === 1).length;
  const favorites = Array.isArray(src.favorites) ? src.favorites : [];
  // onOpenSource 让「不是当前课程」的场景自己决定「打开资料」怎么走；
  // 课程侧不传，仍走原来的 previewSource。
  const onOpenSource = (typeof src.onOpenSource === "function") ? src.onOpenSource : null;
  // projectId 同理：节点上的「AI 解释」要打到正确项目上。
  // 阅读界面里那组文献自成一个项目（src.projectId）；课程侧不传，回落当前课程项目。
  const projectId = (src && src.projectId) || (state && state.currentProjectId) || null;
  return { nodes, sources, favorites, onOpenSource, projectId, byId, linked, orphan, support, single };
}

/* ---- 笔记胶囊：把「我的笔记」也放进这张网 ----
   概念由资料支撑，笔记由你产生 —— 两者并排，一眼看出
   「哪些概念既有资料、我也想过」和「哪些概念只有资料、我没留下任何思考」。 */

const KB_NOTE_W = 264;
const KB_NOTE_H = 40;
const KB_NOTE_PITCH = 50;
const KB_NOTE_GAP = 84;
const KB_SRC_NOTE_KEY = "kb-src-show-notes";

function kbSrcShowNotes() {
  try { return localStorage.getItem(KB_SRC_NOTE_KEY) === "1"; } catch (_) { return false; }
}

function kbSrcSetShowNotes(on) {
  try { localStorage.setItem(KB_SRC_NOTE_KEY, on ? "1" : "0"); } catch (_) { /* 忽略 */ }
}

// 笔记按关联节点归拢；只保留能挂到当前有来源的概念上的那些
function kbSrcNotesByNode(data) {
  const map = new Map();
  const list = Array.isArray(data.favorites) ? data.favorites : [];
  const valid = new Set(data.linked.map((item) => item.node.node_id));
  list.forEach((fav) => {
    if (!fav || !fav.favorite_id) return;
    const ids = Array.isArray(fav.node_ids) && fav.node_ids.length
      ? fav.node_ids
      : (fav.chapter_node_id ? [fav.chapter_node_id] : []);
    ids.forEach((nid) => {
      if (!valid.has(nid)) return;
      if (!map.has(nid)) map.set(nid, []);
      map.get(nid).push(fav);
    });
  });
  return map;
}

function kbSourceLayout(data, notesByNode, showNotes) {
  const cols = showNotes ? 2 : KB_SRC_COLS;
  const rows = Math.max(1, Math.ceil(data.linked.length / cols));
  const srcH = Math.max(1, data.sources.length) * KB_SRC_PITCH;
  const cptH = rows * KB_CPT_PITCH;
  const tailH = data.orphan.length ? 128 : 48;
  const srcPos = new Map();
  data.sources.forEach((s, i) => srcPos.set(s.source_id, { x: KB_SRC_X, y: KB_SRC_TOP + i * KB_SRC_PITCH }));
  const cptPos = new Map();
  data.linked.forEach((item, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    cptPos.set(item.node.node_id, { x: KB_CPT_X + col * KB_CPT_COL_PITCH, y: KB_SRC_TOP + row * KB_CPT_PITCH });
  });

  const noteX = KB_CPT_X + (cols - 1) * KB_CPT_COL_PITCH + KB_CPT_W + KB_NOTE_GAP;
  const notePos = new Map();
  let noteRow = 0;
  if (showNotes) {
    data.linked.forEach((item) => {
      (notesByNode.get(item.node.node_id) || []).forEach((fav) => {
        notePos.set(fav.favorite_id, {
          x: noteX,
          y: KB_SRC_TOP + noteRow * KB_NOTE_PITCH,
          nodeId: item.node.node_id,
        });
        noteRow += 1;
      });
    });
  }
  const noteH = noteRow * KB_NOTE_PITCH;

  return {
    width: showNotes
      ? noteX + KB_NOTE_W + 60
      : KB_CPT_X + cols * KB_CPT_COL_PITCH + 40,
    height: Math.max(srcH, cptH, noteH) + KB_SRC_TOP + tailH,
    cols,
    noteX,
    srcPos,
    cptPos,
    notePos,
    noteCount: noteRow,
  };
}

/* ---- 节点上的「AI 解释」小徽标 ----
   来源视图里每个节点（概念 / 资料 / 笔记）都能让 AI 讲一遍。
   刻意不动卡片本体的点击行为：点卡片还是原来的（概念→出处对照、资料→预览、笔记→笔记详情），
   只有点右上角这个小徽标才走 AI 解释，免得把已有的肌肉记忆改掉。 */

const KB_AI_W = 32;
const KB_AI_H = 18;

function kbSrcAiChip(x, y, kind, id, name, projectId) {
  const label = String(name == null ? "" : name);
  return `<g class="kb-src-ai" data-kb-src-ai="1"`
    + ` data-kb-src-ai-kind="${escapeAttr(kind)}"`
    + ` data-kb-src-ai-id="${escapeAttr(id)}"`
    + ` data-kb-src-ai-name="${escapeAttr(label)}"`
    + ` data-kb-src-ai-project="${escapeAttr(projectId || "")}"`
    + ` transform="translate(${x} ${y})" role="button"`
    + ` aria-label="${escapeAttr(`AI 解释：${label}`)}">`
    + "<title>AI 解释</title>"
    + `<rect class="kb-src-ai-bg" width="${KB_AI_W}" height="${KB_AI_H}" rx="${KB_AI_H / 2}"/>`
    + `<text class="kb-src-ai-text" x="${KB_AI_W / 2}" y="${KB_AI_H / 2}" text-anchor="middle" dominant-baseline="central">AI</text></g>`;
}

function kbSourceRenderError(svg, error) {
  if (!svg) return;
  svg.setAttribute("viewBox", "0 0 900 200");
  svg.innerHTML = '<text class="kb-src-empty-text" x="60" y="80">来源视图渲染失败</text>'
    + `<text class="kb-src-hint" x="60" y="106">${escapeHtml(String((error && error.message) || error || "未知错误"))}。可切回 XMind 图谱继续使用。</text>`;
}

// 画布 defs 里的 id 必须按实例唯一：文献侧的对比视图会同时挂多张来源视图，
// 同 id 的 <pattern> 在页面里只有第一个生效，会串色。
let KB_SRC_SEQ = 0;

function kbSourceInit(svg, override) {
  if (!svg) return;
  svg.innerHTML = "";
  const data = kbSourceData(override);
  svg.__kbSrcData = data;   // 节点点击要开「出处对照」弹窗，得复用同一份数据
  const gridId = "kb-src-grid-" + (++KB_SRC_SEQ);
  if (!data.sources.length || !data.linked.length) {
    const tip = !data.sources.length
      ? "还没有导入资料。导入 PDF / 课件后，这里会显示每个概念由哪些资料支撑。"
      : "资料已导入，但知识点还没有关联到具体资料。生成一次知识框架后即可看到支撑关系。";
    svg.setAttribute("viewBox", "0 0 900 260");
    svg.innerHTML = '<text class="kb-src-empty-text" x="60" y="96">还没有可追溯的资料关联</text>'
      + `<text class="kb-src-hint" x="60" y="124">${escapeHtml(tip)}</text>`;
    return;
  }

  const showNotes = kbSrcShowNotes();
  const notesByNode = kbSrcNotesByNode(data);
  const layout = kbSourceLayout(data, notesByNode, showNotes);
  svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);

  const edges = [];
  data.linked.forEach((item) => {
    const target = layout.cptPos.get(item.node.node_id);
    if (!target) return;
    const isSingle = item.sourceIds.length === 1;
    item.sourceIds.forEach((sid) => {
      const from = layout.srcPos.get(sid);
      if (!from) return;
      const x1 = from.x + KB_SRC_W;
      const y1 = from.y + KB_SRC_H / 2;
      const x2 = target.x;
      const y2 = target.y + KB_CPT_H / 2;
      const dx = Math.max(80, (x2 - x1) * 0.45);
      edges.push(`<path class="kb-src-edge${isSingle ? " is-single" : ""}" data-source="${escapeAttr(sid)}" data-node="${escapeAttr(item.node.node_id)}" d="M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}"/>`);
    });
  });

  // 笔记 → 概念：虚线连回它所挂的知识点
  if (showNotes) {
    layout.notePos.forEach((pos, favId) => {
      const cpt = layout.cptPos.get(pos.nodeId);
      if (!cpt) return;
      const x1 = cpt.x + KB_CPT_W;
      const y1 = cpt.y + KB_CPT_H / 2;
      const x2 = pos.x;
      const y2 = pos.y + KB_NOTE_H / 2;
      const dx = Math.max(50, (x2 - x1) * 0.45);
      edges.push(`<path class="kb-src-note-edge" data-note="${escapeAttr(favId)}" data-node="${escapeAttr(pos.nodeId)}" d="M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}"/>`);
    });
  }

  const srcNodes = data.sources.map((s) => {
    const pos = layout.srcPos.get(s.source_id);
    const count = data.support.get(s.source_id) || 0;
    const name = kbSrcClip(s.filename || "未命名资料", KB_SRC_W - 96);
    return `<g class="kb-src-node" data-kind="source" data-source-id="${escapeAttr(s.source_id)}" transform="translate(${pos.x} ${pos.y})" tabindex="0" role="button" aria-label="${escapeAttr(`资料 ${s.filename || "未命名资料"}，支撑 ${count} 个概念`)}">`
      + `<title>${escapeHtml(s.filename || "未命名资料")}</title>`
      + `<rect class="kb-src-card" width="${KB_SRC_W}" height="${KB_SRC_H}" rx="10" fill="#ece7dc" stroke="#b9ae9c"/>`
      + '<rect class="kb-src-bar" width="4" height="32" x="12" y="12" fill="#8a8172"/>'
      + `<text class="kb-src-title" x="26" y="25">${escapeHtml(name)}</text>`
      + `<text class="kb-src-meta" x="26" y="43">支撑 ${count} 个概念</text>`
      + `<text class="kb-src-side" x="${KB_SRC_W - 14}" y="24" text-anchor="end">资料</text>`
      + kbSrcAiChip(KB_SRC_W - 12 - KB_AI_W, KB_SRC_H - 8 - KB_AI_H, "source", s.source_id, s.filename || "未命名资料", data.projectId)
      + "</g>";
  });

  const cptNodes = data.linked.map((item) => {
    const node = item.node;
    const pos = layout.cptPos.get(node.node_id);
    const palette = nodePalette(node);
    const score = Math.round((Number(node.mastery_score) || 0) * 100);
    const n = item.sourceIds.length;
    const name = kbSrcClip(node.name, KB_CPT_W - 140);
    // 孤证徽标挪到底部，把右上角让给「AI」徽标，两者不打架
    const badge = n === 1
      ? `<rect class="kb-src-badge-bg" x="${KB_CPT_W - 90}" y="33" width="76" height="21" rx="10"/><text class="kb-src-badge-text" x="${KB_CPT_W - 52}" y="47" text-anchor="middle">孤证</text>`
      : `<text class="kb-src-side" x="${KB_CPT_W - 14}" y="45" text-anchor="end">${n} 份</text>`;
    return `<g class="kb-src-node" data-kind="concept" data-node-id="${escapeAttr(node.node_id)}" transform="translate(${pos.x} ${pos.y})" tabindex="0" role="button" aria-label="${escapeAttr(`${node.name}，${statusLabel(node)}，${n} 份资料支撑，掌握度 ${score}%`)}">`
      + `<title>${escapeHtml(node.name)}</title>`
      + `<rect class="kb-src-card" width="${KB_CPT_W}" height="${KB_CPT_H}" rx="10" fill="${palette.fill}" stroke="${palette.stroke}"/>`
      + `<rect class="kb-src-bar" width="4" height="34" x="12" y="13" fill="${palette.stroke}"/>`
      + `<text class="kb-src-title" x="26" y="26">${escapeHtml(name)}</text>`
      + `<text class="kb-src-meta" x="26" y="45">${escapeHtml(statusLabel(node))} · 掌握度 ${score}%</text>`
      + badge
      + kbSrcAiChip(KB_CPT_W - 12 - KB_AI_W, 6, "concept", node.node_id, node.name, data.projectId)
      + "</g>";
  });

  // 笔记胶囊：圆角拉满成胶囊形，和方形的资料、圆角矩形的概念一眼区分
  const noteNodes = [];
  if (showNotes) {
    layout.notePos.forEach((pos, favId) => {
      const fav = (state.favorites || []).find((f) => f.favorite_id === favId);
      if (!fav) return;
      const rawTitle = fav.title || fav.note || fav.content || "未命名笔记";
      const label = kbSrcClip(rawTitle, KB_NOTE_W - 46 - KB_AI_W - 8);
      const tip = `${rawTitle}\n${fav.note || fav.content || ""}`.trim();
      noteNodes.push(`<g class="kb-src-node kb-src-note" data-kind="note" data-note-id="${escapeAttr(favId)}" transform="translate(${pos.x} ${pos.y})" tabindex="0" role="button" aria-label="${escapeAttr(`我的笔记 ${rawTitle}`)}">`
        + `<title>${escapeHtml(tip.slice(0, 300))}</title>`
        + `<rect class="kb-src-note-card" width="${KB_NOTE_W}" height="${KB_NOTE_H}" rx="${KB_NOTE_H / 2}"/>`
        + `<circle class="kb-src-note-dot" cx="20" cy="${KB_NOTE_H / 2}" r="4.5"/>`
        + `<text class="kb-src-note-text" x="36" y="${KB_NOTE_H / 2}" dominant-baseline="central">${escapeHtml(label)}</text>`
        + kbSrcAiChip(KB_NOTE_W - 10 - KB_AI_W, (KB_NOTE_H - KB_AI_H) / 2, "note", favId, rawTitle, data.projectId)
        + "</g>");
    });
  }
  const noteHeader = showNotes && layout.noteCount
    ? `<text class="kb-src-col-title" x="${layout.noteX}" y="${KB_SRC_TOP - 22}">我的笔记（${layout.noteCount}）</text>`
    : "";

  const orphanBox = data.orphan.length
    ? `<g><rect class="kb-src-empty-box" x="${KB_SRC_X}" y="${layout.height - 104}" width="560" height="64" rx="12"/>`
      + `<text class="kb-src-empty-text" x="${KB_SRC_X + 18}" y="${layout.height - 76}">${data.orphan.length} 个节点暂无来源支撑</text>`
      + `<text class="kb-src-hint" x="${KB_SRC_X + 18}" y="${layout.height - 56}">这些概念还没关联到任何资料，建议补充资料或在节点笔记里手动关联。</text></g>`
    : "";

  svg.innerHTML = `<defs><pattern id="${gridId}" width="30" height="30" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r="1.1" fill="#d9d1c2" opacity="0.5"/></pattern></defs>`
    + `<rect class="kb-src-canvas" width="100%" height="100%" fill="url(#${gridId})"/>`
    + `<g class="kb-src-edges">${edges.join("")}</g>`
    + `<g class="kb-src-nodes">${srcNodes.join("")}${cptNodes.join("")}${noteNodes.join("")}</g>`
    + noteHeader
    + orphanBox;

  kbSourceBindViewport(svg, layout);
  kbSourceBindNodes(svg);
}

// 滚轮缩放 + 拖拽平移（直接操作 viewBox，不依赖第三方库）
function kbSourceBindViewport(svg, layout) {
  const vb = { x: 0, y: 0, w: layout.width, h: layout.height };
  const apply = () => svg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  apply();
  let moved = false;
  svg._srcMoved = () => moved;

  svg.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const px = (event.clientX - rect.left) / rect.width;
    const py = (event.clientY - rect.top) / rect.height;
    const factor = event.deltaY > 0 ? 1.12 : 1 / 1.12;
    const nextW = Math.min(layout.width * 2, Math.max(layout.width * 0.12, vb.w * factor));
    const nextH = nextW * (layout.height / layout.width);
    vb.x += (vb.w - nextW) * px;
    vb.y += (vb.h - nextH) * py;
    vb.w = nextW;
    vb.h = nextH;
    apply();
  }, { passive: false });

  let dragging = false;
  let last = null;
  let activePointerId = null;
  let captured = false;
  svg.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    dragging = true;
    moved = false;
    captured = false;
    activePointerId = event.pointerId;
    last = { x: event.clientX, y: event.clientY };
    // 这里**不能** setPointerCapture：指针一旦被 svg 捕获，紧接着的 click 会被
    // 重定向到 <svg> 自己（实测 pointerup/click 的 target 都变成 svg.kb-source-graph），
    // 于是节点和卡片上的小徽标全部收不到点击 —— 表现就是「点节点没反应、点 AI 也没反应」。
    // 改为：拖动真正开始了（超过阈值）才捕获，既保住顺滑平移，又不改纯点击的语义。
  });
  svg.addEventListener("pointermove", (event) => {
    if (!dragging || !last) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dx = (event.clientX - last.x) * (vb.w / rect.width);
    const dy = (event.clientY - last.y) * (vb.h / rect.height);
    if (Math.abs(dx) + Math.abs(dy) > 0.6) {
      moved = true;
      if (!captured) {
        captured = true;
        svg.classList.add("kb-src-panning");
        try { svg.setPointerCapture(activePointerId); } catch (_) { /* 忽略 */ }
      }
    }
    vb.x -= dx;
    vb.y -= dy;
    last = { x: event.clientX, y: event.clientY };
    apply();
  });
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    last = null;
    if (captured) {
      captured = false;
      try { svg.releasePointerCapture(activePointerId); } catch (_) { /* 忽略 */ }
    }
    svg.classList.remove("kb-src-panning");
  };
  svg.addEventListener("pointerup", stop);
  svg.addEventListener("pointercancel", stop);
  svg.addEventListener("pointerleave", stop);
}

// 三种节点各自的取 id 方式
const KB_SRC_KIND_ATTR = { source: "data-source", concept: "data-node", note: "data-note" };
const KB_SRC_EDGE_ATTRS = ["data-source", "data-node", "data-note"];

function kbSrcNodeId(el, kind) {
  if (kind === "source") return el.dataset.sourceId;
  if (kind === "note") return el.dataset.noteId;
  return el.dataset.nodeId;
}

// 悬浮聚焦：高亮当前节点与其直接关联方，其余淡出
function kbSourceFocus(svg, kind, id) {
  const edges = svg.querySelectorAll(".kb-src-edge, .kb-src-note-edge");
  const nodes = svg.querySelectorAll(".kb-src-node");
  if (!id) {
    svg.classList.remove("is-focusing");
    edges.forEach((el) => el.classList.remove("is-active"));
    nodes.forEach((el) => el.classList.remove("is-neighbor"));
    return;
  }
  const key = KB_SRC_KIND_ATTR[kind] || "data-node";
  const neighbors = new Set();
  edges.forEach((el) => {
    const hit = el.getAttribute(key) === id;
    el.classList.toggle("is-active", hit);
    if (hit) {
      KB_SRC_EDGE_ATTRS.forEach((attr) => {
        if (attr === key) return;
        const other = el.getAttribute(attr);
        if (other) neighbors.add(other);
      });
    }
  });
  nodes.forEach((el) => {
    const self = kbSrcNodeId(el, el.dataset.kind);
    const keys = [el.dataset.sourceId, el.dataset.nodeId, el.dataset.noteId].filter(Boolean);
    el.classList.toggle("is-neighbor", self === id || keys.some((k) => neighbors.has(k)));
  });
  svg.classList.add("is-focusing");
}

function kbSourceBindNodes(svg) {
  svg.querySelectorAll(".kb-src-node").forEach((el) => {
    const kind = el.dataset.kind;
    const id = kbSrcNodeId(el, kind);
    el.addEventListener("pointerenter", () => kbSourceFocus(svg, kind, id));
    el.addEventListener("focus", () => kbSourceFocus(svg, kind, id));
    el.addEventListener("pointerleave", () => kbSourceFocus(svg, kind, null));
    el.addEventListener("blur", () => kbSourceFocus(svg, kind, null));
    const activate = (event) => {
      // 点的是卡片上的「AI」徽标：必须**放它继续冒泡**到 document 的委托那里去开 AI 解释。
      // 这里千万不能先 stopPropagation —— 卡片是徽标的祖先，在这儿掐断冒泡，
      // 事件就永远到不了 document，表现就是「点 AI 没反应」（踩过）。
      const hit = event.target;
      if (hit && typeof hit.closest === "function" && hit.closest("[data-kb-src-ai]")) return;
      event.stopPropagation();
      if (typeof svg._srcMoved === "function" && svg._srcMoved()) return; // 刚拖过画布，不当作点击
      const data = svg.__kbSrcData || kbSourceData();
      if (kind === "source") {
        const source = (data.sources || []).find((s) => s.source_id === id);
        if (!source) return;
        if (typeof data.onOpenSource === "function") data.onOpenSource(source);
        else previewSource(source);
      } else if (kind === "note") {
        kbSourceOpenNoteDialog(id, data);
      } else {
        kbSourceOpenDialog(id, data);
      }
    };
    el.addEventListener("click", activate);
    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate(event);
      }
    });
  });
}

/* ---- 原文片段对照：从资料正文里抽出提到该概念的原句 ----
   写综述时最需要的不是「哪几份资料提过」，而是「每一份到底怎么说的」。
   所以这里把每份资料正文里**所有**提到该概念的原句都抽出来（相邻/重叠的窗口并成一段，
   默认最多 3 段），命中词高亮；多份资料的片段在弹窗里并排铺开，方便直接比对说法差异。
   source.text 已随项目详情返回，这里纯前端抽取，不新增端点。 */

const KB_SRC_EXCERPT_RADIUS = 110;   // 命中词左右各取多少字符做上下文
const KB_SRC_EXCERPT_MAX = 3;        // 每份资料最多展示几段，避免长文刷屏

// 正文归一化：去掉控制字符（换行/制表保留，交给切片后统一折叠空白）
function kbSrcNormalizeText(text) {
  return String(text == null ? "" : text).replace(/[\u0000-\u0008\u000b-\u001f]/g, " ");
}

// [start, end) → 折叠空白 → 两端按需补省略号，标出这是被截断的上下文
function kbSrcSlice(text, start, end) {
  let snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = "…" + snippet;
  if (end < text.length) snippet = snippet + "…";
  return snippet;
}

// 某段正文里所有匹配的位置。total 是合并重叠窗口后的「处数」，
// 不是字符出现次数 —— 否则同一句话会被拆成好几条。
function kbSrcSpans(text, term, radius) {
  const spans = [];
  let from = 0;
  for (;;) {
    const idx = text.indexOf(term, from);
    if (idx < 0) break;
    from = idx + term.length;
    const start = Math.max(0, idx - radius);
    const end = Math.min(text.length, idx + term.length + radius);
    const last = spans[spans.length - 1];
    // 和上一段挨着或重叠：扩成一段，读者不用看两遍重复的句子
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end);
      continue;
    }
    spans.push({ start, end });
  }
  return spans;
}

/* 概念名 → 由「最精确」到「最宽松」的一串检索词。
   模型给的知识点多是对正文的概念化标签（"二阶非线性极化率 χ(2)"、"非线性光学的开端"、
   "受激辐射与激光原理"），实测只有约 9% 能与正文逐字对上。若只认原名，
   这个功能在真实数据上九成情况只会显示「未命中」，等于没做 —— 所以再加几级：
   去括号补充 → 拆连接词 → 去泛化前后缀 → 去序数前缀；
   最后还有 kbSrcLongestGram 兜底。放宽了就必须如实告诉用户用的是哪个词。 */
const KB_SRC_STOP_PREFIX = ["典型", "基本", "主要", "相关", "常见", "重要", "一般", "简单", "初步", "经典", "现代", "近代", "核心", "关键"];
const KB_SRC_STOP_SUFFIX = ["基本概念", "主要概念", "基本内容", "概念", "原理", "概述", "简介", "简述", "发展历程", "历程", "开端", "起源", "历史", "背景", "介绍", "方法", "技术", "分析", "综述", "总结", "应用", "意义", "特点", "机制"];

function kbSrcSearchTerms(keyword) {
  const name = String(keyword == null ? "" : keyword).trim();
  if (!name) return [];
  const out = [];
  // 派生候选统一收拾一下：去掉「的/之」这类虚词首尾，"非线性光学的" → "非线性光学"。
  // 原名本身不收拾 —— 它要原样保留，否则精确匹配就废了。
  const tidy = (value) => String(value == null ? "" : value).trim()
    .replace(/^[的之]+/, "")
    .replace(/[的之等地得]+$/, "")
    // 尾巴上孤零零的符号/希腊字母要摘掉："非线性极化率 χ" → "非线性极化率"。
    // 不摘的话，候选词会带着 χ 一起去匹配，逐字对不上，被迫下沉到生僻子串
    // （实测会把"三阶非线性"错当成"二阶非线性极化率 χ(2)"的出处）。
    .replace(/\s+[\u0370-\u03ff\u1f00-\u1fff]+$/u, "")
    .trim();
  const push = (value, verbatim) => {
    const term = verbatim ? String(value == null ? "" : value).trim() : tidy(value);
    if (term.length >= 2 && !out.includes(term)) out.push(term);
  };
  push(name, true);
  // 去括号里的补充说明 / 箭头类符号："二阶非线性极化率 χ(2)" → "二阶非线性极化率 χ"
  const bare = name.replace(/[（(][^）)]*[）)]/g, " ").replace(/[\/↔→←~～]/g, " ").trim();
  push(bare);
  // 按连接词切开，长的优先："受激辐射与激光原理" → "受激辐射" / "激光原理"
  bare.split(/[与及和跟、,，;；:：\-—]+/).map((part) => part.trim()).filter((part) => part.length >= 2)
    .sort((a, b) => b.length - a.length)
    .forEach((part) => push(part));
  // 泛化前缀/后缀反复剥，直到不再产生新候选：
  // "相关诺贝尔奖历程" → "诺贝尔奖历程" → "诺贝尔奖"；"非线性光学的开端" → "非线性光学"
  for (let round = 0; round < 3; round += 1) {
    const before = out.length;
    out.slice().forEach((term) => {
      KB_SRC_STOP_PREFIX.forEach((word) => { if (term.startsWith(word)) push(term.slice(word.length)); });
      KB_SRC_STOP_SUFFIX.forEach((word) => { if (term.endsWith(word)) push(term.slice(0, term.length - word.length)); });
    });
    if (out.length === before) break;
  }
  // 去掉序数前缀："二阶非线性极化率" → "非线性极化率"
  for (let round = 0; round < 2; round += 1) {
    const before = out.length;
    out.slice().forEach((term) => {
      const m = term.match(/^[0-9一二三四五六七八九十百千两]+(?:阶|次|级|维|元|重|种|类)/);
      if (m) push(term.slice(m[0].length));
    });
    if (out.length === before) break;
  }
  return out;
}

// 兜底子串不允许以虚词/序数词起止：否则会捞出「阶非线性」这种断头碎片
// （正文写的是"三阶非线性"，却拿去当"二阶非线性极化率 χ(2)"的出处）。
const KB_SRC_WEAK_EDGE = "的之的地得与及和跟阶次而或则了着过等";

// 名字里最长、且确实出现在正文里的子串。按「词」切分后再取子串，
// 避免跨标点拼出正文里并不存在的假词；再滤掉首尾是虚词的碎片。
function kbSrcLongestGram(text, name, minLen = 2, maxLen = 8) {
  const tokens = String(name || "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const clean = (gram) => gram.length >= minLen
    && !KB_SRC_WEAK_EDGE.includes(gram[0])
    && !KB_SRC_WEAK_EDGE.includes(gram[gram.length - 1]);
  let best = "";
  tokens.forEach((token) => {
    for (let len = Math.min(maxLen, token.length); len >= minLen; len -= 1) {
      if (best.length >= len) break;
      for (let i = 0; i + len <= token.length; i += 1) {
        const gram = token.slice(i, i + len);
        if (!clean(gram)) continue;
        if (text.includes(gram)) { if (gram.length > best.length) best = gram; break; }
      }
    }
  });
  return best;
}

/* 在正文里给一个概念找「原句」。逐级放宽，某一级命中就停，
   并把真正用上的检索词（term）带回去 —— 界面要如实告诉用户这是原文里的哪个词，
   不能让人误以为概念名在正文里逐字出现过。 */
function kbSrcFind(source, keyword, radius = KB_SRC_EXCERPT_RADIUS, max = KB_SRC_EXCERPT_MAX) {
  const text = kbSrcNormalizeText(source && source.text);
  const raw = String(keyword == null ? "" : keyword).trim();
  if (!text || !raw) return { total: 0, snippets: [], term: "", exact: false };
  const tryTerm = (term, exact) => {
    const spans = kbSrcSpans(text, term, radius);
    if (!spans.length) return null;
    return {
      total: spans.length,
      snippets: spans.slice(0, max).map((span) => ({ text: kbSrcSlice(text, span.start, span.end), term })),
      term,
      exact,
    };
  };
  const terms = kbSrcSearchTerms(raw);
  for (let i = 0; i < terms.length; i += 1) {
    const hit = tryTerm(terms[i], terms[i] === raw);
    if (hit) return hit;
  }
  const gram = kbSrcLongestGram(text, raw);
  if (gram) {
    const hit = tryTerm(gram, false);
    if (hit) return hit;
  }
  return { total: 0, snippets: [], term: "", exact: false, terms };
}

// 命中词高亮：先转义再拼 <mark>，关键词本身也走转义，不给出注入口子
function kbSrcHighlight(raw, keyword) {
  const key = String(keyword == null ? "" : keyword).trim();
  if (!key) return escapeHtml(raw);
  return String(raw)
    .split(key)
    .map((part) => escapeHtml(part))
    .join(`<mark class="kb-src-mark">${escapeHtml(key)}</mark>`);
}

/* 一份资料的出处片段（可多段，均含命中词高亮）；一处都没有时给可操作的兜底文案。
   found 已算过就直接复用，避免弹窗里重复扫一遍正文。
   放宽后才命中时，明确写出用的是哪个词，不让用户误判成原文就长这样。 */
function kbSrcExcerptMarkup(source, keyword, found) {
  const hit = found || kbSrcFind(source, keyword);
  const name = String(keyword == null ? "" : keyword).trim();
  if (!hit.total) {
    return '<div class="kb-src-excerpt is-empty">这份资料的正文里没有直接出现这个词，可能换了叫法，可点「打开资料」自行核对。</div>';
  }
  const blocks = hit.snippets
    .map((snip) => `<div class="kb-src-excerpt">${kbSrcHighlight(snip.text, snip.term || hit.term || name)}</div>`)
    .join("");
  const notes = [];
  if (hit.exact === false) {
    notes.push(`正文里没有原样的「${escapeHtml(name)}」，上面按「${escapeHtml(hit.term)}」定位。`);
  }
  if (hit.total > hit.snippets.length) {
    notes.push(`正文里共提到 ${hit.total} 处，这里显示最靠前的 ${hit.snippets.length} 处。`);
  }
  const more = notes.length ? `<div class="kb-src-excerpt-more">${notes.join(" ")}</div>` : "";
  return blocks + more;
}

// 出处对照：并排列出支撑这个概念的全部资料 + 各自原句，可逐条打开原文
function kbSourceOpenDialog(nodeId, dataArg) {
  const data = dataArg || kbSourceData();
  const item = data.linked.find((x) => x.node.node_id === nodeId);
  if (!item) return;
  const node = item.node;
  const n = item.sourceIds.length;
  const rows = item.sourceIds.map((sid) => {
    const source = data.byId.get(sid);
    if (!source) return "";
    const name = escapeHtml(source.filename || "未命名资料");
    const sub = n === 1 ? "唯一来源 · 建议再找一份交叉验证" : `共同支撑 · 共 ${n} 份`;
    const found = kbSrcFind(source, node.name);
    const hits = found.total
      ? (found.exact ? `正文命中 ${found.total} 处` : `按「${found.term}」命中 ${found.total} 处`)
      : "正文未命中该词";
    // 命中词一定能逐字出现在正文里：作为打开资料时的定位词，
    // openSourcePreview 会高亮并滚动到对应位置。未命中就退回到原概念名。
    const jumpQuote = (found && found.total && found.term) ? found.term : node.name;
    return '<li class="kb-src-dialog-item">'
      + '<div class="kb-src-dialog-head"><div>'
      + `<div class="kb-src-dialog-name">${name}</div>`
      + `<div class="kb-src-dialog-sub">${escapeHtml(sub)} · ${escapeHtml(hits)}</div></div>`
      + `<button class="mini-button" type="button" data-kb-src-open="${escapeAttr(sid)}" data-kb-src-quote="${escapeAttr(jumpQuote)}">打开资料</button></div>`
      + kbSrcExcerptMarkup(source, node.name, found)
      + "</li>";
  }).join("");
  const summary = n >= 2
    ? `这个结论有 ${n} 份资料互相印证，可信度较高。下面并排列出每份资料里提到它的原句，可直接比对说法差异。`
    : "只有一份资料支撑，属于孤证。建议另找一份资料交叉验证，或标记为待补充。";
  // 多份资料才并排：单份时并排没有比对对象，反而把一行拉长
  const compare = n >= 2;

  let dialog = document.getElementById("kb-src-dialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "kb-src-dialog";
    dialog.setAttribute("aria-labelledby", "kb-src-dialog-title");
    document.body.appendChild(dialog);
  }
  // 弹窗是复用的：类名每次都要按本次是几份资料重算
  dialog.className = compare ? "node-detail-dialog kb-src-compare" : "node-detail-dialog";
  dialog.innerHTML = '<article class="node-detail"><header class="node-detail-heading"><div>'
    + `<p class="eyebrow">出处对照 · ${n} 份资料</p><h3 id="kb-src-dialog-title">${escapeHtml(node.name)}</h3></div>`
    + '<button class="node-detail-close" type="button" data-kb-src-close aria-label="关闭">×</button></header>'
    + `<p class="kb-src-dialog-sub" style="margin:2px 0 12px;">${escapeHtml(summary)}</p>`
    + `<ul class="kb-src-dialog-list${compare ? " is-compare" : ""}">${rows}</ul>`
    + '<div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;">'
    + `<button class="mini-button primary" type="button" data-kb-src-explain="${escapeAttr(nodeId)}">AI 解释这个概念</button>`
    + '<button class="mini-button" type="button" data-kb-src-close>关闭</button></div>'
    + "</article>";

  dialog.querySelectorAll("[data-kb-src-close]").forEach((btn) => {
    btn.addEventListener("click", () => { try { dialog.close(); } catch (_) { dialog.remove(); } });
  });
  dialog.querySelectorAll("[data-kb-src-open]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const source = (data.sources || []).find((s) => s.source_id === btn.dataset.kbSrcOpen);
      if (!source) return;
      const quote = btn.dataset.kbSrcQuote || "";
      if (typeof data.onOpenSource === "function") data.onOpenSource(source, quote);
      else previewSource(source, quote);
    });
  });
  const explainBtn = dialog.querySelector("[data-kb-src-explain]");
  if (explainBtn) {
    explainBtn.addEventListener("click", () => {
      try { dialog.close(); } catch (_) { /* 忽略 */ }
      kbSourceOpenExplain("concept", nodeId, node.name, data.projectId);
    });
  }
  try { dialog.showModal(); } catch (_) { dialog.setAttribute("open", ""); }
}

// 笔记详情：胶囊点开，看这条笔记正文 + 它挂在哪些概念上
function kbSourceOpenNoteDialog(favoriteId, dataArg) {
  const data = dataArg || kbSourceData();
  const fav = (data.favorites || []).find((f) => f.favorite_id === favoriteId);
  if (!fav) return;
  const nameOf = new Map(data.linked.map((x) => [x.node.node_id, x.node.name]));
  const names = (Array.isArray(fav.node_ids) ? fav.node_ids : [])
    .map((nid) => nameOf.get(nid))
    .filter(Boolean);
  const title = fav.title || "未命名笔记";
  const bodyText = String(fav.note || fav.content || fav.answer || "").trim() || "（这条笔记没有正文）";
  const links = names.length
    ? `<div class="kb-src-dialog-sub">挂在概念：${names.map((n) => escapeHtml(n)).join("、")}</div>`
    : '<div class="kb-src-dialog-sub">这条笔记还没挂到具体概念上</div>';
  const sourceLine = fav.chapter_name
    ? `<div class="kb-src-dialog-sub">归类：${escapeHtml(fav.chapter_name)}</div>`
    : "";

  let dialog = document.getElementById("kb-src-note-dialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "kb-src-note-dialog";
    dialog.className = "node-detail-dialog";
    dialog.setAttribute("aria-labelledby", "kb-src-note-title");
    document.body.appendChild(dialog);
  }
  dialog.innerHTML = '<article class="node-detail"><header class="node-detail-heading"><div>'
    + '<p class="eyebrow">我的笔记</p>'
    + `<h3 id="kb-src-note-title">${escapeHtml(title)}</h3></div>`
    + '<button class="node-detail-close" type="button" data-kb-src-note-close aria-label="关闭">×</button></header>'
    + links + sourceLine
    + `<div class="kb-src-excerpt" style="margin-top:12px;">${escapeHtml(bodyText)}</div>`
    + '<div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;">'
    + '<button class="mini-button" type="button" data-kb-src-note-close>关闭</button></div></article>';

  dialog.querySelectorAll("[data-kb-src-note-close]").forEach((btn) => {
    btn.addEventListener("click", () => { try { dialog.close(); } catch (_) { dialog.remove(); } });
  });
  try { dialog.showModal(); } catch (_) { dialog.setAttribute("open", ""); }
}

/* ---- AI 研究洞察：把「我读到了什么」推成「我下一步能做什么」 ----
   数据都是现成的（知识点 + 来源 + 笔记），这里交给模型通读一遍，
   要回四类能直接推动写作的东西：可用的论断、资料间的张力、知识空白、下一步问题。
   只读：一次模型调用，不写库、不改动任何既有数据。 */

const KB_SRC_INSIGHT_SECTIONS = [
  { key: "solid_claims", title: "可以直接写进综述的论断", hint: "有 2 份以上资料互相印证" },
  { key: "tensions", title: "资料之间的张力", hint: "说法不一致的地方，往往就是切入点" },
  { key: "blanks", title: "知识空白", hint: "已读资料没覆盖、但相邻概念暗示存在的方向" },
  { key: "next_questions", title: "下一步可以研究的问题", hint: "具体到查什么、比什么、验证什么" },
];

function kbSourceInsightItemMarkup(kind, item) {
  const obj = (item && typeof item === "object") ? item : { text: item };
  if (kind === "solid_claims") {
    const names = Array.isArray(obj.nodes) ? obj.nodes.filter(Boolean) : [];
    return '<li class="kb-insight-item">'
      + `<p class="kb-insight-main">${escapeHtml(obj.claim || obj.text || "")}</p>`
      + (obj.evidence ? `<p class="kb-insight-sub">依据：${escapeHtml(obj.evidence)}</p>` : "")
      + (names.length
        ? `<p class="kb-insight-chips">${names.map((nm) => `<span class="kb-insight-chip">${escapeHtml(nm)}</span>`).join("")}</p>`
        : "")
      + "</li>";
  }
  if (kind === "tensions") {
    return '<li class="kb-insight-item">'
      + `<p class="kb-insight-main">${escapeHtml(obj.topic || obj.text || "")}</p>`
      + (obj.conflict ? `<p class="kb-insight-sub">${escapeHtml(obj.conflict)}</p>` : "")
      + (obj.suggestion ? `<p class="kb-insight-do">可这样核实：${escapeHtml(obj.suggestion)}</p>` : "")
      + "</li>";
  }
  if (kind === "blanks") {
    return '<li class="kb-insight-item">'
      + `<p class="kb-insight-main">${escapeHtml(obj.area || obj.text || "")}</p>`
      + (obj.hint ? `<p class="kb-insight-do">该去补：${escapeHtml(obj.hint)}</p>` : "")
      + "</li>";
  }
  return `<li class="kb-insight-item"><p class="kb-insight-main">${escapeHtml(obj.text || obj.claim || "")}</p></li>`;
}

function kbSourceInsightsMarkup(result) {
  if (!result) return '<p class="kb-src-dialog-sub">还没有生成。</p>';
  const overview = result.overview
    ? `<div class="kb-insight-overview">${escapeHtml(result.overview)}</div>`
    : "";
  const sections = KB_SRC_INSIGHT_SECTIONS.map((sec) => {
    const list = Array.isArray(result[sec.key]) ? result[sec.key] : [];
    if (!list.length) return "";
    return `<section class="kb-insight-section kb-insight-${sec.key}">`
      + `<header><h4>${escapeHtml(sec.title)}</h4><span>${escapeHtml(sec.hint)}</span></header>`
      + `<ul class="kb-insight-list">${list.map((item) => kbSourceInsightItemMarkup(sec.key, item)).join("")}</ul>`
      + "</section>";
  }).join("");
  if (!overview && !sections) {
    return '<p class="kb-src-dialog-sub">这一轮没有生成出可用的洞察。可以先补充资料、或先把知识框架建起来再试。</p>';
  }
  return overview + sections;
}

function kbSourceInsightSet(dialog, selector, html) {
  const el = dialog.querySelector(selector);
  if (el) el.innerHTML = html;
}

function kbSourceInsightMeta(dialog, text) {
  const el = dialog.querySelector(".kb-insight-meta");
  if (el) el.textContent = text || "";
}

function kbSourceInsightDialog() {
  let dialog = document.getElementById("kb-src-insights-dialog");
  if (dialog) return dialog;
  dialog = document.createElement("dialog");
  dialog.id = "kb-src-insights-dialog";
  dialog.className = "node-detail-dialog kb-insight-dialog";
  dialog.setAttribute("aria-labelledby", "kb-src-insights-title");
  dialog.innerHTML = '<article class="node-detail">'
    + '<header class="node-detail-heading"><div>'
    + '<p class="eyebrow">通读你的知识库</p>'
    + '<h3 id="kb-src-insights-title">AI 研究洞察</h3></div>'
    + '<button class="node-detail-close" type="button" data-kb-insight-close aria-label="关闭">×</button></header>'
    + '<div class="kb-insight-toolbar">'
    + '<span class="kb-insight-meta"></span>'
    + '<button class="mini-button" type="button" data-kb-insight-action="refresh">重新生成</button>'
    + '<button class="mini-button" type="button" data-kb-insight-close>关闭</button></div>'
    + '<div class="kb-insight-body" aria-live="polite"></div>'
    + '</article>';
  document.body.appendChild(dialog);
  dialog.querySelectorAll("[data-kb-insight-close]").forEach((btn) => {
    btn.addEventListener("click", () => { try { dialog.close(); } catch (_) { dialog.remove(); } });
  });
  dialog.querySelectorAll('[data-kb-insight-action="refresh"]').forEach((btn) => {
    // 记住上一次的上下文（哪个项目 / 哪份数据），「重新生成」才对回同一个对象
    btn.addEventListener("click", () => kbSourceInsightRun(dialog, dialog.__kbInsightProjectId, dialog.__kbInsightData));
  });
  return dialog;
}

async function kbSourceInsightRun(dialog, projectIdArg, dataArg) {
  const projectId = projectIdArg || state.currentProjectId;
  if (!projectId) {
    kbSourceInsightMeta(dialog, "");
    kbSourceInsightSet(dialog, ".kb-insight-body", '<p class="kb-src-dialog-sub">先选择或新建一个项目。</p>');
    return;
  }
  const data = dataArg || kbSourceData();
  kbSourceInsightMeta(dialog, `${data.sources.length} 份资料 · ${data.nodes.length} 个知识点`);
  kbSourceInsightSet(dialog, ".kb-insight-body",
    '<div class="kb-insight-loading"><span class="btn-spinner" aria-hidden="true"></span>'
    + '<p>正在通读你的知识库，寻找可切入的方向…（通常十几秒）</p></div>');
  try {
    const result = await window.api(
      `/api/projects/${encodeURIComponent(projectId)}/research-insights`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
    );
    kbSourceInsightMeta(dialog, `${result.source_count || 0} 份资料 · ${result.node_count || 0} 个知识点`);
    kbSourceInsightSet(dialog, ".kb-insight-body", kbSourceInsightsMarkup(result));
  } catch (error) {
    const msg = (error && error.message) ? error.message : String(error);
    kbSourceInsightSet(dialog, ".kb-insight-body", `<p class="kb-src-dialog-sub">生成失败：${escapeHtml(msg)}</p>`);
  }
}

function kbSourceOpenInsights(projectId, data) {
  const dialog = kbSourceInsightDialog();
  dialog.__kbInsightProjectId = projectId || null;
  dialog.__kbInsightData = data || null;
  try { dialog.showModal(); } catch (_) { dialog.setAttribute("open", ""); }
  kbSourceInsightRun(dialog, projectId, data);
}

/* ---- 节点 AI 解释：把「这个节点到底在讲什么」交给模型 ----
   三种节点共用一套弹窗：概念讲解、资料通读、笔记展开。
   只读：一次模型调用，不写库、不改动任何既有数据。 */

const KB_SRC_EXPLAIN_KIND_LABEL = {
  concept: "知识点",
  source: "资料",
  note: "我的笔记",
};

const KB_SRC_EXPLAIN_SECTIONS = [
  { key: "key_points", title: "要点", hint: "是什么 / 为什么重要 / 怎么用" },
  { key: "connections", title: "与库内其它内容的关系", hint: "概念之间、资料与结论之间" },
  { key: "pitfalls", title: "容易搞混的地方", hint: "想当然的坑" },
  { key: "follow_up", title: "下一步可以", hint: "查什么 / 比什么 / 自问什么" },
];

function kbSourceExplainMarkup(result, fallbackName) {
  if (!result) return '<p class="kb-src-dialog-sub">还没有生成。</p>';
  const summary = result.summary
    ? `<div class="kb-insight-overview">${escapeHtml(String(result.summary))}</div>`
    : "";
  const sections = KB_SRC_EXPLAIN_SECTIONS.map((sec) => {
    const list = Array.isArray(result[sec.key]) ? result[sec.key].filter(Boolean) : [];
    if (!list.length) return "";
    const items = list
      .map((text) => `<li class="kb-insight-item"><p class="kb-insight-main">${escapeHtml(String(text))}</p></li>`)
      .join("");
    return '<section class="kb-insight-section">'
      + `<header><h4>${escapeHtml(sec.title)}</h4><span>${escapeHtml(sec.hint)}</span></header>`
      + `<ul class="kb-insight-list">${items}</ul></section>`;
  }).join("");
  if (!summary && !sections) {
    const who = String(result.name || fallbackName || "");
    return `<p class="kb-src-dialog-sub">这一次没生成出可用的解释${who ? `（${escapeHtml(who)}）` : ""}，可以点「重新生成」再试一次。</p>`;
  }
  return summary + sections;
}

function kbSourceExplainSet(dialog, selector, html) {
  const el = dialog.querySelector(selector);
  if (el) el.innerHTML = html;
}

function kbSourceExplainDialog() {
  let dialog = document.getElementById("kb-src-explain-dialog");
  if (dialog) return dialog;
  dialog = document.createElement("dialog");
  dialog.id = "kb-src-explain-dialog";
  dialog.className = "node-detail-dialog";
  dialog.setAttribute("aria-labelledby", "kb-src-explain-title");
  dialog.innerHTML = '<article class="node-detail">'
    + '<header class="node-detail-heading"><div>'
    + '<p class="eyebrow"></p>'
    + '<h3 id="kb-src-explain-title"></h3></div>'
    + '<button class="node-detail-close" type="button" data-kb-explain-close aria-label="关闭">×</button></header>'
    + '<div class="kb-insight-toolbar">'
    + '<span class="kb-insight-meta"></span>'
    + '<button class="mini-button" type="button" data-kb-explain-action="refresh">重新生成</button>'
    + '<button class="mini-button" type="button" data-kb-explain-close>关闭</button></div>'
    + '<div class="kb-insight-body" aria-live="polite"></div>'
    + '</article>';
  document.body.appendChild(dialog);
  dialog.querySelectorAll("[data-kb-explain-close]").forEach((btn) => {
    btn.addEventListener("click", () => { try { dialog.close(); } catch (_) { dialog.remove(); } });
  });
  dialog.querySelectorAll('[data-kb-explain-action="refresh"]').forEach((btn) => {
    // 记住这次问的是哪个节点，「重新生成」才对得回同一个对象
    btn.addEventListener("click", () => kbSourceExplainRun(dialog, dialog.__kbExplainTarget));
  });
  return dialog;
}

async function kbSourceExplainRun(dialog, target) {
  const t = target || {};
  if (!t.projectId || !t.id) {
    kbSourceExplainSet(dialog, ".kb-insight-body",
      '<p class="kb-src-dialog-sub">没能确定这个节点属于哪个项目，刷新页面后再试。</p>');
    return;
  }
  const who = escapeHtml(String(t.name || "这个节点"));
  kbSourceExplainSet(dialog, ".kb-insight-body",
    '<div class="kb-insight-loading"><span class="btn-spinner" aria-hidden="true"></span>'
    + `<p>正在解释「${who}」…（通常几秒）</p></div>`);
  try {
    const result = await window.api(
      `/api/projects/${encodeURIComponent(t.projectId)}/source-view/explain`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: t.kind || "concept", id: t.id }),
      }
    );
    kbSourceExplainSet(dialog, ".kb-insight-body", kbSourceExplainMarkup(result, t.name));
  } catch (error) {
    const msg = (error && error.message) ? error.message : String(error);
    kbSourceExplainSet(dialog, ".kb-insight-body",
      `<p class="kb-src-dialog-sub">解释失败：${escapeHtml(msg)}</p>`);
  }
}

// 三处入口共用：徽标点击、出处对照里的按钮、键盘激活
function kbSourceOpenExplain(kind, id, name, projectId) {
  const target = {
    kind: kind || "concept",
    id: id || "",
    name: String(name == null ? "" : name),
    // 阅读界面里那组文献自成一个项目：优先用它带来的 projectId
    projectId: projectId || state.currentProjectId || null,
  };
  const dialog = kbSourceExplainDialog();
  dialog.__kbExplainTarget = target;
  const eyebrow = dialog.querySelector(".eyebrow");
  if (eyebrow) eyebrow.textContent = `AI 解释 · ${KB_SRC_EXPLAIN_KIND_LABEL[target.kind] || "节点"}`;
  const titleEl = dialog.querySelector("#kb-src-explain-title");
  if (titleEl) titleEl.textContent = target.name || "未命名节点";
  const metaEl = dialog.querySelector(".kb-insight-meta");
  if (metaEl) metaEl.textContent = "";
  try { dialog.showModal(); } catch (_) { dialog.setAttribute("open", ""); }
  kbSourceExplainRun(dialog, target);
}

// 来源视图专用统计条 + 笔记开关 + 导出入口
// opts.data / opts.projectId 让阅读界面的对比视图复用同一条统计条；
// opts.showNotes === false 时不出现「我的笔记」开关（组合项目里没有笔记可挂）。
function kbSourceSummaryMarkup(opts) {
  const opt = opts || {};
  // 两种喂法都收：opt.data 是已经算好的数据集（画布刚算过，直接复用、不重算），
  // opt.override 是原始 {nodes, sources, favorites}（调用方手上只有原始数据时用）。
  const data = (opt.data && Array.isArray(opt.data.linked)) ? opt.data : kbSourceData(opt.override);
  const cross = data.linked.length - data.single;
  const disabled = data.linked.length ? "" : " disabled";
  const showNotes = opt.showNotes === false ? false : kbSrcShowNotes();
  const projectAttr = opt.projectId ? ` data-kb-src-project="${escapeAttr(opt.projectId)}"` : "";
  const notesByNode = kbSrcNotesByNode(data);
  const noteIds = new Set();
  notesByNode.forEach((arr) => arr.forEach((f) => noteIds.add(f.favorite_id)));
  const noteCount = noteIds.size;
  return '<div class="kb-src-summary">'
    + `<span><i style="background:#b9ae9c"></i>${data.sources.length} 份资料</span>`
    + `<span><i style="background:#d4a843"></i>${cross} 个概念交叉验证</span>`
    + `<span><i style="background:#c75c5c"></i>${data.single} 处孤证</span>`
    + (data.orphan.length ? `<span><i style="background:#c7bfb2"></i>${data.orphan.length} 个节点暂无来源</span>` : "")
    + '<span class="kb-src-export">'
    + (opt.showNotes === false
      ? ""
      : `<button class="mini-button${showNotes ? " is-active" : ""}" type="button" data-kb-src-action="toggle-notes" aria-pressed="${showNotes ? "true" : "false"}">我的笔记 ${noteCount}${showNotes ? " · 已显示" : ""}</button>`)
    + `<button class="mini-button" type="button" data-kb-src-action="insights"${projectAttr}${disabled}>AI 研究洞察</button>`
    + "</span>"
    + "</div>";
}

// 来源视图专用图例：沿用掌握度配色，并说明孤证
// 孤证处数来自图谱统计 data.single，与统计条一致，避免写死的「1」和真实数量对不上
function kbSourceLegendMarkup(data) {
  const single = (data && typeof data.single === "number") ? data.single : null;
  return '<div class="legend">'
    + '<span><i style="background:#d8d3ca"></i>未探索</span>'
    + '<span><i style="background:#dbeafe"></i>学习中</span>'
    + '<span><i style="background:#fdf0c8"></i>已掌握</span>'
    + '<span><i style="background:#f8e1df"></i>来源不足</span>'
    + `<span><i style="background:#c75c5c"></i>${single == null ? "孤证" : `${single} 处孤证`}</span>`
    + "</div>";
}

/* ==================== 事件委托（统一入口） ====================
   为什么不用内联 <script>：文献对比报告是用 innerHTML 注入的，
   而 innerHTML 插入的 <script> 浏览器不会执行 —— 之前按钮点了没反应就是这个原因。
   改用 document 级委托，无论节点何时、以何种方式进入 DOM 都能生效。
============================================================== */

document.addEventListener("click", (event) => {
  // 「AI 研究洞察」的关闭按钮（标题栏 X 与工具栏「关闭」）：走文档级委托兜底。
  // 即便按钮自身绑定偶发丢失，这里也能保证关掉弹窗，避免「点叉退不出去」。
  const insightClose = event.target.closest && event.target.closest("[data-kb-insight-close]");
  if (insightClose) {
    event.preventDefault();
    event.stopPropagation();
    const dlg = insightClose.closest("dialog");
    if (dlg) { try { dlg.close(); } catch (_) { dlg.remove(); } }
    return;
  }
  // 节点上的「AI」徽标：必须是第一个判断 ——
  // 卡片本体的 handler 已对徽标点击放行（见 kbSourceBindNodes），只会走到这里。
  const aiChip = event.target.closest && event.target.closest("[data-kb-src-ai]");
  if (aiChip) {
    event.preventDefault();
    kbSourceOpenExplain(
      aiChip.dataset.kbSrcAiKind || "concept",
      aiChip.dataset.kbSrcAiId || "",
      aiChip.dataset.kbSrcAiName || "",
      aiChip.dataset.kbSrcAiProject || ""
    );
    return;
  }
  const actionBtn = event.target.closest("[data-kb-src-action]");
  if (!actionBtn) return;
  const action = actionBtn.dataset.kbSrcAction;
  if (action === "insights") {
    event.preventDefault();
    // 对比视图会在统计条上带 data-kb-src-project 并把数据集挂成 __kbSrcData：
    // 洞察要针对那组文献所属的项目，而不是当前课程项目。
    const box = actionBtn.closest(".kb-src-summary");
    kbSourceOpenInsights(
      actionBtn.dataset.kbSrcProject || null,
      (box && box.__kbSrcData) || null
    );
  } else if (action === "toggle-notes") {
    event.preventDefault();
    kbSrcSetShowNotes(!kbSrcShowNotes());
    // 走整屏重绘，保证统计条上的开关状态与画布同步
    if (typeof renderFramework === "function") {
      renderFramework();
    } else {
      const svg = document.querySelector(".kb-source-graph");
      if (svg) kbSourceInit(svg);
    }
  }
});
