/**
 * kb-flow-pulse.js 冒烟（悬浮点亮版）
 * 关键回归点：平时图谱必须是静的（不能有一窝光点在爬），只有悬浮节点时那几条双链才流光，
 * 且方向统一从悬浮节点射向邻居；离开后淡出。
 *
 * jsdom 没有真实的 getTotalLength/getPointAtLength，给 path 打桩；
 * rAF 换成手动队列，好精确控制帧数。
 *
 * 用法：node tools/_kb_flow_pulse_smoke.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "static", "kb-flow-pulse.js");

let fail = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dom = new JSDOM(
  `<!doctype html><html><body><svg id="g" xmlns="http://www.w3.org/2000/svg">
     <circle class="kb-flow-sphere-body" cx="750" cy="525" r="300"/>
     <g class="kb-flow-content">
       <g class="kb-flow-dust"></g>
       <g class="kb-flow-links"></g>
       <g class="kb-flow-link-hits"></g>
       <g class="kb-flow-nodes"></g>
     </g>
   </svg></body></html>`,
  // runScripts 必须开：否则 window.eval 拿不到 window 上下文，脚本里引用 window 会 ReferenceError
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
const litCount = (layer) =>
  Array.from(layer.querySelectorAll("circle")).filter((c) => Number(c.getAttribute("opacity")) > 0).length;

const svg = window.document.getElementById("g");
const linksG = svg.querySelector(".kb-flow-links");
const nodesG = svg.querySelector(".kb-flow-nodes");

// 前 10 条挂在 hub 上（枢纽），其余 40 条各自独立 —— hub 悬浮时应点亮 10 条
for (let i = 0; i < 50; i++) {
  const p = window.document.createElementNS(NS, "path");
  p.setAttribute("class", "kb-flow-link");
  p.setAttribute("data-src", i < 10 ? "hub" : "n" + i);
  p.setAttribute("data-tgt", "m" + i);
  p.setAttribute("d", "M 0 0 Q 50 50 100 100");
  p.getTotalLength = () => 200;
  p.getPointAtLength = (l) => ({ x: l, y: l * 0.5 });
  linksG.appendChild(p);
}
// 两个可悬浮的节点
["hub", "n10"].forEach((id) => {
  const g = window.document.createElementNS(NS, "g");
  g.setAttribute("class", "kb-flow-node");
  g.setAttribute("data-node-id", id);
  nodesG.appendChild(g);
});
const hubNode = nodesG.querySelector('[data-node-id="hub"]');
const n10Node = nodesG.querySelector('[data-node-id="n10"]');
const hover = (el) => el.dispatchEvent(new window.Event("pointerover", { bubbles: true }));
const unhover = (el) => el.dispatchEvent(new window.Event("pointerout", { bubbles: true }));

window.eval(readFileSync(SRC, "utf8"));
const P = window.KbFlowPulse;
ok(!!P, "KbFlowPulse 已挂到 window");

P.attach(svg);

const layer = svg.querySelector(".kb-pulse-layer");
ok(!!layer, "脉冲层 .kb-pulse-layer 已插入");
ok(layer && layer.nextElementSibling === nodesG, "脉冲层夹在连线与节点之间（不遮节点本体）");
ok(P.poolSize === 18, `光点池固定 18 个（实得 ${P.poolSize}）`);
ok(layer.querySelectorAll("circle").length === 18 * 9, `18 束 × (1 头 + 8 尾) = 162 个圆（实得 ${layer.querySelectorAll("circle").length}）`);

ok(!!svg.querySelector(".kb-pulse-aura"), "中心辉光 .kb-pulse-aura 已插入");
ok(svg.querySelector(".kb-pulse-aura").nextElementSibling === svg.querySelector(".kb-flow-dust"),
  "辉光在尘埃层之前（被 clip 裁进球内）");
const defs = svg.querySelector("#kb-pulse-defs");
ok(!!(defs && defs.querySelector("#kb-pulse-glow")), "辉光渐变 kb-pulse-glow 已建");
ok(!!(defs && defs.querySelector("#kb-pulse-aura")), "中心光晕渐变 kb-pulse-aura 已建");

// —— 核心回归：没悬浮时不许有光点在爬 ——
pump(20);
ok(litCount(layer) === 0, `静置 20 帧：没有任何光点亮着（实得 ${litCount(layer)}，必须为 0，否则又是一窝蚂蚁）`);
ok(Number(svg.querySelector(".kb-pulse-aura").getAttribute("opacity")) > 0, "静置时中心辉光仍在呼吸");

// —— 悬浮枢纽：hub 有 10 条双链 ——
hover(hubNode);
pump(2);
ok(P.count === 10, `悬浮 hub：只点亮它自己的 10 条双链（实得 ${P.count}）`);
pump(8);
const litOnHub = litCount(layer);
ok(litOnHub > 0, `悬浮 hub：光点已点亮（实得 ${litOnHub}）`);
// 10 条线 × 9 点 = 90 个可见上限
ok(litOnHub >= 10, `点亮数覆盖每条线的头点（实得 ${litOnHub}，应 ≥ 10）`);
ok(litOnHub <= 90, `未被点亮的 8 条仍隐藏，没有全池乱放（实得 ${litOnHub}，应 ≤ 90）`);
// 流星尾：尾巴节数必须真的亮起来，不能只有头在跑（否则又是一粒尘）
ok(litOnHub >= 10 * 5, `尾巴成串亮着，不是只有头（实得 ${litOnHub}，应 ≥ 50）`);

// —— 方向：hub 是 source，光点应从起点向终点跑；首帧位置应靠近起点 ——
const firstHead = layer.querySelectorAll("circle")[3];
ok(firstHead && firstHead.hasAttribute("transform"), "悬浮后头点已定位");

// —— 切到另一个节点：n10 只有 1 条双链 ——
hover(n10Node);
pump(2);
ok(P.count === 1, `切到 n10：只点亮 1 条（实得 ${P.count}）`);

// —— 离开：淡出到全灭 ——
unhover(n10Node);
await sleep(70);          // 等 outTimer（40ms）把 want 归零
pump(80);                 // 淡出约需 45+ 帧
ok(litCount(layer) === 0, `离开后淡出干净（实得 ${litCount(layer)}，必须为 0）`);
ok(P.count === 1, "淡出期间绑定关系保留（下次悬浮不用重建）");

// —— 关闭开关 ——
hover(hubNode);
pump(5);
P.setEnabled(false);
ok(litCount(layer) === 0, "setEnabled(false) 后所有光点归零");
ok(Number(svg.querySelector(".kb-pulse-aura").getAttribute("opacity")) === 0, "setEnabled(false) 后辉光归零");

// —— detach 收干净 ——
P.detach();
ok(!svg.querySelector(".kb-pulse-layer"), "detach 后脉冲层已移除");
ok(!svg.querySelector(".kb-pulse-aura"), "detach 后辉光已移除");
ok(!svg.querySelector("#kb-pulse-defs"), "detach 后 defs 已移除");
ok(P.poolSize === 0, "detach 后池已清空");

// —— 重挂不残留 ——
P.attach(svg);
P.attach(svg);
ok(svg.querySelectorAll(".kb-pulse-layer").length === 1, "连续 attach 两次只留一层");
ok(svg.querySelectorAll(".kb-pulse-aura").length === 1, "连续 attach 两次只留一个辉光");
ok(P.poolSize === 18, "重挂后池仍是 18");

console.log(fail ? `\n${fail} 项失败` : "\n全部通过");
process.exit(fail ? 1 : 0);
