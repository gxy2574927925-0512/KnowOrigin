// 一次性探针：「试试这样问」推荐问题浮层 —— 背景覆盖 / 可滚动 / 标题行不被卷走
// 跑法：node tools/_probe_suggested_panel.mjs
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

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  → " + detail : ""}`);
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

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
await page.evaluate(() => {
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());
  window.KnowOriginUI?.set("agent");
});
await page.waitForTimeout(400);

const fill = (chips) =>
  page.evaluate((list) => {
    const c = document.querySelector("#suggested-questions");
    const l = document.querySelector("#suggested-questions-list");
    c.hidden = false;
    c.classList.remove("is-collapsed");
    c.style.removeProperty("display");
    l.innerHTML = list
      .map((q) => `<button type="button" class="suggested-question-chip">${q}</button>`)
      .join("");
    return l.children.length;
  }, chips);

console.log("chips:", await fill(CHIPS));
await page.waitForTimeout(250);

const geo = await page.evaluate(() => {
  const c = document.querySelector("#suggested-questions");
  const l = document.querySelector("#suggested-questions-list");
  const head = c.querySelector(".suggested-questions-head");
  const chips = [...c.querySelectorAll(".suggested-question-chip")];
  const cs = getComputedStyle(c);
  const ls = getComputedStyle(l);
  const r = c.getBoundingClientRect();
  const lr = l.getBoundingClientRect();
  const hr = head.getBoundingClientRect();
  const last = chips[chips.length - 1].getBoundingClientRect();
  // 滚到底，看最后一张卡是否还落在面板盒体里
  l.scrollTop = l.scrollHeight;
  const scrolledTo = l.scrollTop;
  const lastAfter = chips[chips.length - 1].getBoundingClientRect();
  const lrAfter = l.getBoundingClientRect();
  return {
    panel: { top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
    panelCss: { overflow: cs.overflow, maxHeight: cs.maxHeight, display: cs.display, background: cs.backgroundColor, radius: cs.borderRadius },
    list: { h: +lr.height.toFixed(1), scrollHeight: l.scrollHeight, clientHeight: l.clientHeight, overflowY: ls.overflowY },
    listScrolledTo: +scrolledTo.toFixed(1),
    lastChipOverflowBeforeScroll: +(last.bottom - lr.bottom).toFixed(1),
    lastChipOverflowAfterScroll: +(lastAfter.bottom - lrAfter.bottom).toFixed(1),
    lastChipBottomVsPanelBottom: +(lastAfter.bottom - r.bottom).toFixed(1),
    headTopVsPanelTop: +(hr.top - r.top).toFixed(1),
    headVisible: hr.bottom <= r.bottom + 0.5 && hr.top >= r.top - 0.5,
    chips: chips.length,
  };
});
console.log("\n=== agent 模式 · 1440x900 · 6 条问题 ===");
console.log("  " + JSON.stringify(geo, null, 2).replace(/\n/g, "\n  "));

console.log("\n--- 断言 ---");
ok("面板不再是 overflow:visible（内容被裁进盒体）", geo.panelCss.overflow !== "visible", geo.panelCss.overflow);
ok("列表成为滚动容器", geo.list.overflowY === "auto" || geo.list.overflowY === "scroll", geo.list.overflowY);
ok("列表内容确实溢出（需要滚动）", geo.list.scrollHeight > geo.list.clientHeight, `${geo.list.scrollHeight} > ${geo.list.clientHeight}`);
ok("可以滚动（scrollTop 生效）", geo.listScrolledTo > 0, `scrollTop=${geo.listScrolledTo}`);
ok("滚到底后最后一张卡仍在面板盒体内", geo.lastChipBottomVsPanelBottom <= 0.5, `超出 ${geo.lastChipBottomVsPanelBottom}px`);
ok("标题行（拖动/换一批/隐藏）仍在面板内", geo.headVisible, `headTop 距面板顶 ${geo.headTopVsPanelTop}px`);
ok("面板高度被夹住（没撑满整屏）", geo.panel.h <= 401, `${geo.panel.h}px`);

// 重渲染（流式每 100ms 换一次 innerHTML）会不会把滚动位置顶回顶部
const keep = await page.evaluate((list) => {
  const l = document.querySelector("#suggested-questions-list");
  l.scrollTop = l.scrollHeight;
  const before = l.scrollTop;
  l.innerHTML = list.map((q) => `<button type="button" class="suggested-question-chip">${q}</button>`).join("");
  const after = l.scrollTop;
  return { before, after };
}, CHIPS);
ok("重渲染后滚动位置不跳回顶部", keep.after === keep.before && keep.before > 0, `before=${keep.before} after=${keep.after}`);

// 折叠态：药丸不能被改坏
const collapsed = await page.evaluate(() => {
  const c = document.querySelector("#suggested-questions");
  c.classList.add("is-collapsed");
  const r = c.getBoundingClientRect();
  const cs = getComputedStyle(c);
  const l = document.querySelector("#suggested-questions-list");
  const ls = getComputedStyle(l);
  return { w: +r.width.toFixed(1), h: +r.height.toFixed(1), radius: cs.borderRadius, overflow: cs.overflow, listDisplay: ls.display };
});
console.log("\n=== 折叠态 ===");
console.log("  " + JSON.stringify(collapsed));
ok("折叠后仍是 232px 的药丸（高度 ~28px）", Math.abs(collapsed.w - 232) < 2 && collapsed.h < 40, `${collapsed.w}x${collapsed.h}`);
ok("折叠态列表隐藏", collapsed.listDisplay === "none", collapsed.listDisplay);

// 只有 1 条问题（不溢出）时不该出现滚动条
console.log("\n=== 只有 1 条问题 ===");
await page.evaluate(() => document.querySelector("#suggested-questions").classList.remove("is-collapsed"));
await fill([CHIPS[0]]);
await page.waitForTimeout(200);
const single = await page.evaluate(() => {
  const c = document.querySelector("#suggested-questions");
  const l = document.querySelector("#suggested-questions-list");
  const r = c.getBoundingClientRect();
  const last = c.querySelector(".suggested-question-chip").getBoundingClientRect();
  return { panelH: +r.height.toFixed(1), listScrollH: l.scrollHeight, listClientH: l.clientHeight, chipInPanel: last.bottom <= r.bottom + 0.5 };
});
console.log("  " + JSON.stringify(single));
ok("单条时面板贴合内容（不出现空滚动区）", single.panelH < 200 && single.chipInPanel, `h=${single.panelH}`);

// 截图留证：顶部 / 滚到底（与 _shot_suggested_before.mjs 同取景，便于左右对比）
await fill(CHIPS);
await page.waitForTimeout(200);
const clip = await page.evaluate(() => {
  const r = document.querySelector("#suggested-questions").getBoundingClientRect();
  return { x: Math.max(0, r.left - 12), y: 0, width: r.width + 24, height: 760 };
});
await page.screenshot({ path: "screenshots/suggested-panel-after.png", clip });
await page.locator("#suggested-questions").screenshot({ path: "screenshots/suggested-panel-fixed-top.png" });
await page.evaluate(() => {
  const l = document.querySelector("#suggested-questions-list");
  l.scrollTop = l.scrollHeight;
});
await page.waitForTimeout(200);
await page.locator("#suggested-questions").screenshot({ path: "screenshots/suggested-panel-fixed-scrolled.png" });
console.log("截图：screenshots/suggested-panel-{after,fixed-top,fixed-scrolled}.png");

const failed = results.filter((r) => !r.pass);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) console.log("失败项：" + failed.map((f) => f.name).join(" / "));

await browser.close();
process.exit(failed.length ? 1 : 0);
