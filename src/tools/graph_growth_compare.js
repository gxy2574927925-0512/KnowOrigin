// 对照：抽取 app.js 里真实的 kbFlowSettle，分别在"改动前/改动后"两套参数下跑同一批数据
// 用法：node tools/graph_growth_compare.js
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");

function grab(name) {
  const start = src.indexOf(`function ${name}(`);
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error("unbalanced " + name);
}

// 把新逻辑回退成旧逻辑，得到"改动前"的基线
function toOld(s) {
  return s
    .replace("KB_FLOW_GROW = Math.min(3.8, Math.max(1, Math.sqrt(FLOW_LOAD / 12)));", "KB_FLOW_GROW = 1;")
    .replace("KB_FLOW_GAP = 14 * Math.min(3, Math.max(1, GROW * 0.85));", "KB_FLOW_GAP = 14;")
    .replace("const ringR = Math.max(55, 30 + kids.length * 10 + 8 * d) * GROW;", "const ringR = 40 + 30 * d + Math.sqrt(kids.length + 1) * 20;")
    .replace("const iters = N > 240 ? 90 : 180;", "const iters = 0;");
}

function make(settleSrc) {
  return new Function(`
    let KB_FLOW_W = 1500, KB_FLOW_H = 1050;
    let KB_FLOW_GROW = 1, KB_FLOW_GAP = 14, KB_FLOW_RO = 0, KB_FLOW_NN = 0;
    const window = {};
    ${settleSrc}
    ${grab("kbFlowHomeOf")}
    return { kbFlowSettle, get: () => ({ KB_FLOW_GROW, KB_FLOW_GAP, KB_FLOW_RO, KB_FLOW_NN }) };
  `)();
}
const NEW = make(grab("kbFlowSettle"));
const OLD = make(toOld(grab("kbFlowSettle")));

function buildTree(nLeaves, fanout, linksPerNode) {
  const nodes = [];
  const add = (pid) => {
    const id = "n" + nodes.length;
    nodes.push({ id, name: id, parentId: pid, mastery: 0.5 });
    return id;
  };
  const root = add(null);
  let frontier = [root];
  while (nodes.length <= nLeaves) {
    const nf = [];
    for (const p of frontier) for (let k = 0; k < fanout && nodes.length <= nLeaves; k++) nf.push(add(p));
    if (!nf.length) break;
    frontier = nf;
  }
  const links = [], seen = new Set();
  for (const n of nodes) for (let k = 0; k < linksPerNode; k++) {
    const t = nodes[Math.floor(Math.random() * nodes.length)];
    if (t.id === n.id) continue;
    const key = n.id < t.id ? n.id + "::" + t.id : t.id + "::" + n.id;
    if (seen.has(key)) continue;
    seen.add(key); links.push({ source: n.id, target: t.id });
  }
  const linkById = new Map(nodes.map((n) => [n.id, []]));
  links.forEach((l) => { linkById.get(l.source).push(l.target); linkById.get(l.target).push(l.source); });
  return { nodes, links, linkById, byName: new Map(nodes.map((n) => [n.name, n])) };
}

const KB_FLOW_W = 1500, KB_FLOW_H = 1050;
function measure(mod, data, oldMode, vw = 1000, vh = 700) {
  mod.kbFlowSettle(data);
  const g = mod.get(), nodes = data.nodes, N = nodes.length;
  let gcX = 0, gcY = 0;
  nodes.forEach((n) => { gcX += n.fx; gcY += n.fy; });
  gcX /= N; gcY /= N;
  let nnMin = Infinity, overlap = 0;
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    const d = Math.hypot(nodes[i].fx - nodes[j].fx, nodes[i].fy - nodes[j].fy);
    nnMin = Math.min(nnMin, d);
    if (d < nodes[i].baseR + nodes[j].baseR) overlap++;      // 圆点相交 = 遮挡
  }
  // 旧逻辑：大圆固定 493，画布固定 1500×1050，且没有可读性缩放下限
  const RO = oldMode ? 493 : g.KB_FLOW_RO;
  const worldS = oldMode ? 1 : Math.min(6, Math.max(1, (RO * 2 + 240) / Math.min(KB_FLOW_W, KB_FLOW_H)));
  const svgScale = Math.min(vw / (KB_FLOW_W * worldS), vh / (KB_FLOW_H * worldS));
  const pad = 35;
  const fitZoom = Math.min((vw - pad * 2) / (RO * 2 * svgScale), (vh - pad * 2) / (RO * 2 * svgScale));
  let zoom = oldMode ? fitZoom : Math.max(fitZoom, Math.min(24 / Math.max(6, g.KB_FLOW_NN) / svgScale, fitZoom * 1.8));
  zoom = Math.max(0.2, Math.min(4, zoom));
  const minPx = N > 120 ? 5.5 : N > 60 ? 6.5 : 7.5;
  return {
    R: Math.round(RO), overlap,
    gapPx: Math.round(nnMin * svgScale * zoom),
    dotPx: Math.round(Math.max(minPx, 9 * svgScale * zoom) * 2),
    visible: +Math.min(1, vh / (RO * 2 * svgScale * zoom)).toFixed(2),
  };
}

console.log("规模       | 旧：大圆R/遮挡对/间距/点径 | 新：大圆R/遮挡对/间距/点径/可见");
for (const [label, n, f, l] of [["小 9", 8, 3, 0.3], ["中 31", 30, 4, 0.4], ["中大 61", 60, 5, 0.5], ["大 121", 120, 6, 0.6], ["超大 221", 220, 8, 0.8]]) {
  const a = measure(OLD, buildTree(n, f, l), true);
  const b = measure(NEW, buildTree(n, f, l), false);
  console.log(
    label.padEnd(10),
    "|", String(a.R).padStart(4), String(a.overlap).padStart(4) + "对", String(a.gapPx).padStart(3) + "px", String(a.dotPx).padStart(3) + "px",
    "|", String(b.R).padStart(4), String(b.overlap).padStart(4) + "对", String(b.gapPx).padStart(3) + "px", String(b.dotPx).padStart(3) + "px", "可见" + b.visible
  );
}
