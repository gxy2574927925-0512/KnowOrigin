/**
 * kb-tree-flow.js 冒烟（放射特性迁移到 XMind 树之后）
 * 覆盖：折叠角标只给有子节点的卡片、传导只在悬浮时发生、聚合掌握度、折叠重排、蔓延入场。
 *
 * 用法：node tools/_kb_tree_flow_smoke.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "static", "kb-tree-flow.js");

let fail = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) fail++;
};

const dom = new JSDOM(
  `<!doctype html><html><body><svg id="g" xmlns="http://www.w3.org/2000/svg">
     <g class="graph-viewport">
       <g class="graph-edges"></g>
       <g class="graph-nodes"></g>
     </g>
   </svg></body></html>`,
  { pretendToBeVisual: false, runScripts: "outside-only" }
);
const { window } = dom;
const NS = "http://www.w3.org/2000/svg";

const queue = [];
window.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
window.cancelAnimationFrame = () => {};
const pump = (n) => {
  for (let i = 0; i < n; i++) {
    const q = queue.splice(0, queue.length);
    q.forEach((cb) => cb(1000 + i * 16.7));
  }
};

const svg = window.document.getElementById("g");
const edgesG = svg.querySelector(".graph-edges");
const nodesG = svg.querySelector(".graph-nodes");

// 树：root(50) → ch1(80) → ch1a(90)/ch1b(70)；root → ch2(40)
// 期望聚合：agg(ch1)=80, agg(ch2)=40 → agg(root)=60
const NODES = [
  ["root", 50, "translate(500 300)"],
  ["ch1", 80, "translate(700 200)"],
  ["ch1a", 90, "translate(900 150)"],
  ["ch1b", 70, "translate(900 250)"],
  ["ch2", 40, "translate(700 400)"]
];
NODES.forEach(([id, m, tr]) => {
  const g = window.document.createElementNS(NS, "g");
  g.setAttribute("class", "graph-node graph-node-right");
  g.setAttribute("data-node-id", id);
  g.setAttribute("data-mastery", String(m));
  g.setAttribute("transform", tr);
  nodesG.appendChild(g);
});
[["root", "ch1"], ["root", "ch2"], ["ch1", "ch1a"], ["ch1", "ch1b"]].forEach(([p, c]) => {
  const path = window.document.createElementNS(NS, "path");
  path.setAttribute("class", "graph-edge");
  path.setAttribute("data-edge-nodes", `${p} ${c}`);
  path.setAttribute("d", `M 0 0 L 100 100`);
  path.getTotalLength = () => 200;
  path.getPointAtLength = (l) => ({ x: l, y: l });
  edgesG.appendChild(path);
});

let reRendered = 0;
window.renderFramework = () => { reRendered++; };

const layout = {
  children: new Map([["root", ["ch1", "ch2"]], ["ch1", ["ch1a", "ch1b"]]]),
  nodeWidth: 188,
  nodeHeight: 64
};

window.eval(readFileSync(SRC, "utf8"));
const F = window.KbTreeFlow;
ok(!!F, "KbTreeFlow 已挂到 window");

F.attach(svg, layout);

ok(F.visibleCount === 5, `扫到 5 个节点（实得 ${F.visibleCount}）`);

// —— 折叠角标：只给有子节点的（root、ch1），叶子不该有 ——
const folds = Array.from(svg.querySelectorAll(".kb-tree-fold"));
ok(folds.length === 2, `只有 2 个折叠角标（root / ch1，实得 ${folds.length}）`);
const foldIds = folds.map((b) => b.dataset.foldId).sort();
ok(foldIds.join(",") === "ch1,root", `角标挂在有子节点的卡片上（实得 ${foldIds.join(",")}）`);
ok(folds[0].querySelector("text").textContent === "−", "展开态显示 −");

// —— 蔓延入场：刚挂载时节点是透明的，跑完帧后不透明 ——
const rootEl = svg.querySelector('[data-node-id="root"]');
ok(Number(rootEl.getAttribute("opacity")) === 0, "首帧：节点从透明开始（入场动画起点）");
pump(60);
ok(Number(rootEl.getAttribute("opacity")) === 1, "入场结束：节点完全显示");

// —— 传导：平时一个光点都没有 ——
const litSparks = () => Array.from(svg.querySelectorAll(".kb-tree-sparks circle"))
  .filter((c) => Number(c.getAttribute("opacity")) > 0).length;
pump(20);
ok(litSparks() === 0, `静置时没有传导光点（实得 ${litSparks()}，必须为 0）`);

// —— 悬浮 root：子树 4 条边应有光点朝它汇聚，并显示聚合掌握度 60% ——
rootEl.dispatchEvent(new window.Event("pointerover", { bubbles: true }));
pump(60);
ok(litSparks() > 0, `悬浮 root 后传导光点出现（实得 ${litSparks()}）`);
const agg = svg.querySelector(".kb-tree-agg");
ok(!!agg, "悬浮后浮出聚合掌握度标签");
ok(agg && /60%/.test(agg.textContent), `聚合掌握度 60%（实得「${agg ? agg.textContent : "无"}」）`);

// —— 悬浮 ch1：子树只有 2 条边，光点应更少 ——
const litOnRoot = litSparks();
svg.querySelector('[data-node-id="ch1"]').dispatchEvent(new window.Event("pointerover", { bubbles: true }));
pump(60);
const agg2 = svg.querySelector(".kb-tree-agg");
ok(agg2 && /80%/.test(agg2.textContent), `悬浮 ch1 聚合 80%（实得「${agg2 ? agg2.textContent : "无"}」）`);
ok(litSparks() > 0 && litSparks() < litOnRoot, `ch1 子树更小，光点更少（${litSparks()} < ${litOnRoot}）`);

// —— 离开：熄灭 ——
svg.querySelector('[data-node-id="ch1"]').dispatchEvent(new window.Event("pointerout", { bubbles: true }));
pump(80);
ok(litSparks() === 0, `离开后传导熄灭（实得 ${litSparks()}）`);
ok(!svg.querySelector(".kb-tree-agg"), "离开后聚合标签移除");

// —— 折叠：点角标应触发重排，且不冒泡到"单击开护照" ——
const rootFold = svg.querySelector('.kb-tree-fold[data-fold-id="root"]');
const ev = new window.Event("click", { bubbles: true, cancelable: true });
rootFold.dispatchEvent(ev);
ok(reRendered === 1, `点角标触发了一次重排（实得 ${reRendered}）`);
ok(ev.defaultPrevented, "角标拦下了默认行为与冒泡（不会误开语义护照）");
ok(F.collapsedCount === 1, `root 已折叠（实得 ${F.collapsedCount}）`);
ok(F.collapsed().has("root"), "collapsed 集合含 root（供 buildFrameworkLayout 过滤）");

// 再点一次展开
reRendered = 0;
svg.querySelector('.kb-tree-fold[data-fold-id="root"]').dispatchEvent(
  new window.Event("click", { bubbles: true, cancelable: true })
);
ok(F.collapsedCount === 0, "再点一次展开回来");

// —— 折叠后角标必须留着：否则节点一被折叠就再也展不开 ——
// 模拟重排：折叠 root 后子树被 buildFrameworkLayout 过滤掉，DOM 里只剩 root、layout.children 为空
svg.querySelector('.kb-tree-fold[data-fold-id="root"]').dispatchEvent(
  new window.Event("click", { bubbles: true, cancelable: true })
);
["ch1", "ch1a", "ch1b", "ch2"].forEach((id) => {
  const el = svg.querySelector(`[data-node-id="${id}"]`);
  if (el) el.remove();
});
Array.from(svg.querySelectorAll(".graph-edge")).forEach((e) => e.remove());
Array.from(svg.querySelectorAll(".kb-tree-fold")).forEach((e) => e.remove());
F.attach(svg, { children: new Map(), nodeWidth: 188, nodeHeight: 64 });
ok(F.collapsedCount === 1, "折叠状态跨重排保留");
const kept = svg.querySelectorAll('.kb-tree-fold[data-fold-id="root"]');
ok(kept.length === 1, `折叠后 root 的角标仍在（实得 ${kept.length}）—— 否则再也展不开`);
ok(kept[0] && kept[0].querySelector("text").textContent === "2", "收起态角标显示子节点数 2");

// —— detach 收干净 ——
F.detach();
ok(!svg.querySelector(".kb-tree-sparks"), "detach 后光点层已移除");
ok(!svg.querySelector("#kb-tree-flow-defs"), "detach 后 defs 已移除");
ok(!svg.querySelector(".kb-tree-agg"), "detach 后聚合标签已移除");
ok(F.visibleCount === 0, "detach 后状态清空");

// —— reset：清空折叠与"已见过"记录 ——
F.reset();
ok(F.collapsedCount === 0, "reset 清空折叠集合");

console.log(fail ? `\n${fail} 项失败` : "\n全部通过");
process.exit(fail ? 1 : 0);
