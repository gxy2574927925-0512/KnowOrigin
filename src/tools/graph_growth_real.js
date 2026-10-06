// 直接抽取 app.js 里真实的 kbFlowSettle / kbFlowHomeOf 在 Node 中跑，验证自生长效果
// 用法：node tools/graph_growth_real.js
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");

function grab(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error("not found: " + name);
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error("unbalanced: " + name);
}

const KB_FLOW_W = 1500, KB_FLOW_H = 1050;
let KB_FLOW_GROW = 1, KB_FLOW_GAP = 14, KB_FLOW_RO = 0;
const ctx = { KB_FLOW_W, KB_FLOW_H, window: {} };
const fn = new Function("ctx", `
  let { KB_FLOW_W, KB_FLOW_H, window } = ctx;
  let KB_FLOW_GROW = 1, KB_FLOW_GAP = 14, KB_FLOW_RO = 0;
  ${grab("kbFlowSettle")}
  ${grab("kbFlowHomeOf")}
  return { kbFlowSettle, kbFlowHomeOf, get: () => ({ KB_FLOW_GROW, KB_FLOW_GAP, KB_FLOW_RO, KB_FLOW_NN }) };
`)(ctx);

function buildTree(nLeaves, fanout, linksPerNode) {
  const nodes = [];
  const childMap = new Map();
  const add = (pid) => {
    const id = "n" + nodes.length;
    nodes.push({ id, name: id, parentId: pid === null ? null : pid, mastery: 0.5, depth: 0, m: 1, parentId2: null });
    if (pid !== null) { if (!childMap.has(pid)) childMap.set(pid, []); childMap.get(pid).push(id); }
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
  // 双链：每个节点随机连 linksPerNode 条
  const links = [];
  const seen = new Set();
  for (const n of nodes) {
    for (let k = 0; k < linksPerNode; k++) {
      const t = nodes[Math.floor(Math.random() * nodes.length)];
      if (t.id === n.id) continue;
      const key = n.id < t.id ? n.id + "::" + t.id : t.id + "::" + n.id;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: n.id, target: t.id });
    }
  }
  const linkById = new Map(nodes.map((n) => [n.id, []]));
  links.forEach((l) => { linkById.get(l.source).push(l.target); linkById.get(l.target).push(l.source); });
  return { nodes, links, linkById, byName: new Map(nodes.map((n) => [n.name, n])) };
}

function run(label, nLeaves, fanout, linksPerNode, vw = 1000, vh = 700) {
  const data = buildTree(nLeaves, fanout, linksPerNode);
  const t0 = Date.now();
  fn.kbFlowSettle(data);
  const ms = Date.now() - t0;
  const g = fn.get();
  const nodes = data.nodes, N = nodes.length;
  let gcX = 0, gcY = 0;
  nodes.forEach((n) => { gcX += n.fx; gcY += n.fy; });
  gcX /= N; gcY /= N;
  let RO = 0, nnMin = Infinity;
  for (let i = 0; i < N; i++) {
    RO = Math.max(RO, Math.hypot(nodes[i].fx - gcX, nodes[i].fy - gcY));
    for (let j = i + 1; j < N; j++) {
      nnMin = Math.min(nnMin, Math.hypot(nodes[i].fx - nodes[j].fx, nodes[i].fy - nodes[j].fy));
    }
  }
  const worldS = Math.min(6, Math.max(1, (g.KB_FLOW_RO * 2 + 240) / Math.min(KB_FLOW_W, KB_FLOW_H)));
  const svgScale = Math.min(vw / (KB_FLOW_W * worldS), vh / (KB_FLOW_H * worldS));
  const pad = 35;
  const fitZoom = Math.min((vw - pad * 2) / (g.KB_FLOW_RO * 2 * svgScale), (vh - pad * 2) / (g.KB_FLOW_RO * 2 * svgScale));
  let ringN = 0;
  nodes.forEach((n) => { if (n._edge) ringN++; });
  const outerGap = (2 * Math.PI * Math.max(1, g.KB_FLOW_RO)) / Math.max(1, ringN || N);
  const nnSvg = Math.max(6, g.KB_FLOW_NN || Math.min(outerGap, 63 * g.KB_FLOW_GROW));
  const zRead = 24 / (nnSvg * svgScale);
  const zoom = Math.max(0.2, Math.min(4, Math.max(fitZoom, Math.min(zRead, fitZoom * 1.8))));
  const minPx = N > 120 ? 5.5 : N > 60 ? 6.5 : 7.5;
  console.log(
    label.padEnd(10),
    "N=" + String(N).padStart(3),
    "链=" + String(data.links.length).padStart(3),
    "GROW=" + g.KB_FLOW_GROW.toFixed(2),
    "GAP=" + g.KB_FLOW_GAP.toFixed(0),
    "大圆R=" + String(Math.round(g.KB_FLOW_RO)).padStart(5),
    "world=" + worldS.toFixed(2),
    "最近邻=" + String(Math.round(nnMin)).padStart(3) + "u/" + String(Math.round(nnMin * svgScale * zoom)).padStart(3) + "px",
    "节点=" + Math.round(Math.max(minPx, 9 * svgScale * zoom) * 2) + "px",
    "zoom=" + zoom.toFixed(2),
    "可见=" + Math.min(1, vh / (g.KB_FLOW_RO * 2 * svgScale * zoom)).toFixed(2),
    ms + "ms"
  );
}

run("小", 8, 3, 0.3);
run("中", 30, 4, 0.4);
run("中大", 60, 5, 0.5);
run("大", 120, 6, 0.6);
run("深树", 120, 3, 0.6);
run("超大", 220, 8, 0.8);
run("扁平", 60, 60, 0.5);
