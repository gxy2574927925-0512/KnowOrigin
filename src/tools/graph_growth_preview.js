// 生成一份 HTML 预览：同一批数据在"改动前 / 改动后"两套布局下的样子，肉眼可比对
// 用法：node tools/graph_growth_preview.js  → 打开 static/../graph-growth-preview.html
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
function toOld(s) {
  return s
    .replace("KB_FLOW_GROW = Math.min(3.8, Math.max(1, Math.sqrt(FLOW_LOAD / 12)));", "KB_FLOW_GROW = 1;")
    .replace("KB_FLOW_GAP = 14 * Math.min(3, Math.max(1, GROW * 0.85));", "KB_FLOW_GAP = 14;")
    .replace("const ringR = Math.max(55, 30 + kids.length * 10 + 8 * d) * GROW;", "const ringR = 40 + 30 * d + Math.sqrt(kids.length + 1) * 20;")
    .replace("const iters = N > 400 ? 40 : N > 240 ? 90 : 180;", "const iters = 0;");
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
  const add = (pid) => { const id = "n" + nodes.length; nodes.push({ id, name: id, parentId: pid, mastery: 0.5 }); return id; };
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

const VW = 460, VH = 330;      // 预览视口（模拟 1000×700 的图谱区，按同比例缩小）
function render(mod, data, oldMode) {
  mod.kbFlowSettle(data);
  const g = mod.get(), nodes = data.nodes, N = nodes.length;
  let gcX = 0, gcY = 0;
  nodes.forEach((n) => { gcX += n.fx; gcY += n.fy; });
  gcX /= N; gcY /= N;
  let nnMin = Infinity, overlap = 0;
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    const d = Math.hypot(nodes[i].fx - nodes[j].fx, nodes[i].fy - nodes[j].fy);
    nnMin = Math.min(nnMin, d);
    if (d < nodes[i].baseR + nodes[j].baseR) overlap++;
  }
  const RO = oldMode ? 493 : g.KB_FLOW_RO;
  const worldS = oldMode ? 1 : Math.min(6, Math.max(1, (RO * 2 + 240) / 1050));
  const svgScale = Math.min(1000 / (1500 * worldS), 700 / (1050 * worldS));
  const fitZoom = Math.min((1000 - 70) / (RO * 2 * svgScale), (700 - 70) / (RO * 2 * svgScale));
  let zoom = oldMode ? fitZoom : Math.max(fitZoom, Math.min(24 / Math.max(6, g.KB_FLOW_NN) / svgScale, fitZoom * 1.8));
  zoom = Math.max(0.2, Math.min(4, zoom));
  const minPx = N > 120 ? 5.5 : N > 60 ? 6.5 : 7.5;
  // 视口裁剪：只画落在 1000×700 视窗内的部分（新逻辑会裁，旧逻辑整图可见）
  const k = svgScale * zoom * (VW / 1000);          // SVG 单位 → 预览像素
  const anchorN = nodes.reduce((best, n) => {
    const d = (n.fx - gcX) ** 2 + (n.fy - gcY) ** 2;
    return d < best.d ? { d, n } : best;
  }, { d: Infinity, n: nodes[0] }).n;
  const ox = VW / 2 - anchorN.fx * k, oy = VH / 2 - anchorN.fy * k;
  const px = (n) => ({ x: n.fx * k + ox, y: n.fy * k + oy });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let links = "", dots = "";
  data.links.forEach((l) => {
    const a = px(byId.get(l.source)), b = px(byId.get(l.target));
    links += `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="#7f8fa6" stroke-width="0.7" opacity="0.5"/>`;
  });
  nodes.forEach((n) => {
    const p = px(n);
    if (p.x < -20 || p.x > VW + 20 || p.y < -20 || p.y > VH + 20) return;
    const r = Math.max(minPx, (n.r3 || n.baseR || 4) * svgScale * zoom) * (VW / 1000);
    dots += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${Math.max(1.2, r).toFixed(2)}" fill="#4b7d43" fill-opacity="0.85"/>`;
  });
  return {
    svg: `<svg width="${VW}" height="${VH}" viewBox="0 0 ${VW} ${VH}" style="background:#eef2f7;border-radius:10px">
      <clipPath id="c${Math.random().toString(36).slice(2, 7)}"><rect width="${VW}" height="${VH}"/></clipPath>
      <g clip-path="url(#c)">${links}${dots}</g></svg>`,
    R: Math.round(RO), overlap, gapPx: Math.round(nnMin * svgScale * zoom), dotPx: Math.round(Math.max(minPx, 9 * svgScale * zoom) * 2),
  };
}

const cases = [["9 个节点", 8, 3, 0.3], ["31 个节点", 30, 4, 0.4], ["61 个节点", 60, 5, 0.5], ["121 个节点", 120, 6, 0.6], ["221 个节点", 220, 8, 0.8]];
let html = `<!doctype html><meta charset="utf-8"><title>双链图谱 · 大圆自生长对照</title>
<style>
body{margin:0;padding:22px;background:#151a21;color:#e6edf3;font:14px/1.6 -apple-system,"Microsoft YaHei",sans-serif}
h1{font-size:17px;margin:0 0 4px}h2{font-size:13px;color:#8b98a8;margin:0 0 18px;font-weight:400}
table{border-collapse:collapse}td{padding:0 18px 18px 0;vertical-align:top}
.cap{font-size:12px;color:#9fb0c3;margin-bottom:6px}
.old .cap{color:#d98f8f}.new .cap{color:#7fd18b}
.mut{opacity:.62}
</style>
<h1>双链图谱 · 「大圆随规模自生长」改动前后对照</h1>
<h2>同一批数据在两套布局下的渲染结果（视口按 1000×700 等比缩小；绿=改动后，红=改动前）</h2><table>`;
for (const [label, n, f, l] of cases) {
  const o = render(OLD, buildTree(n, f, l), true);
  const w = render(NEW, buildTree(n, f, l), false);
  html += `<tr>
    <td class="old"><div class="cap">改动前 · ${label}｜大圆 R=${o.R}（固定）｜遮挡 ${o.overlap} 对｜相邻间距 ${o.gapPx}px / 点径 ${o.dotPx}px</div>${o.svg}</td>
    <td class="new"><div class="cap">改动后 · ${label}｜大圆 R=${w.R}（自生长）｜遮挡 ${w.overlap} 对｜相邻间距 ${w.gapPx}px / 点径 ${w.dotPx}px</div>${w.svg}</td>
  </tr>`;
}
html += "</table>";
const out = path.join(__dirname, "..", "graph-growth-preview.html");
fs.writeFileSync(out, html, "utf8");
console.log("已生成：" + out);
