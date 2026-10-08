// 一次性脚本：还原「试试这样问」修复前的旧 CSS，截出「背景破了 + 滚不动」的现场，
// 与修复后同框对比。跑法：node tools/_shot_suggested_before.mjs
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:17321";
const CHIPS = [
  "在「调Q工作过程与速率方程」中，第一阶段高损耗下粒子数反转积累储能，第二阶段低损耗下光子数激增输出激光。请结合速率方程分析，为什么在第二阶段光子数激增时，反转粒子数会迅速下降至阈值以下，从而自动实现脉冲的截止？",
  "「主动锁模技术」要求外加调制器的调制频率必须等于纵模间隔。请从频域（等间距谱线）和时域（周期性超短脉冲）两个角度，解释为什么只有当调制频率严格匹配纵模间隔时，才能形成稳定的锁模脉冲？",
  "「被动可饱和吸收调Q」中，染料溶液的浓度和输入能量对输出脉冲有显著影响。资料指出「一定的输入能量对应一个最佳浓度」，如果输入能量超过该范围，为什么会导致激光器输出多脉冲而不是单脉冲？",
  "在「激光放大器设计考虑」中，系统通常由振荡级、放大级及延时同步装置组成。请解释延时同步装置在双程放大中的具体作用。",
  "为什么 Nd:YAG 激光器的热透镜效应会随泵浦功率变化，而谐振腔的稳定区又该如何据此设计？",
  "对比调Q与锁模两种技术：同样是把连续输出变成脉冲，为什么脉宽差了三到四个数量级？",
];
const OLD_CSS = `
  #suggested-questions { max-height: 300px !important; overflow: visible !important; display: block !important; }
  #suggested-questions-list { overflow: visible !important; flex: none !important; }
`;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.evaluate(async (em) => {
  await fetch("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: em, name: "ui", password: "test123456" }),
  });
}, "uitest+" + Date.now() + "@e.com");
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await page.evaluate((chips) => {
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());
  window.KnowOriginUI?.set("agent");
  const c = document.querySelector("#suggested-questions");
  c.hidden = false;
  c.classList.remove("is-collapsed");
  document.querySelector("#suggested-questions-list").innerHTML = chips
    .map((q) => `<button type="button" class="suggested-question-chip">${q}</button>`)
    .join("");
}, CHIPS);
await page.waitForTimeout(400);

const clip = await page.evaluate(() => {
  const r = document.querySelector("#suggested-questions").getBoundingClientRect();
  return { x: Math.max(0, r.left - 12), y: 0, width: r.width + 24, height: 760 };
});

await page.addStyleTag({ content: OLD_CSS });
await page.waitForTimeout(200);
await page.screenshot({ path: "screenshots/suggested-panel-before.png", clip });

const stuck = await page.evaluate(() => {
  const c = document.querySelector("#suggested-questions");
  c.scrollTop = 400;
  return { scrollTop: c.scrollTop, scrollHeight: c.scrollHeight, clientHeight: c.clientHeight };
});
console.log("旧样式下尝试 scrollTop=400 →", JSON.stringify(stuck));
console.log("截图：screenshots/suggested-panel-before.png");

await browser.close();
