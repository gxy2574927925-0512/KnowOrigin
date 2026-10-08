/* 神经图谱顶栏 KPI · 视觉验证截图
 * 目的：确认「底部 KPI 条 → 顶栏」这一改动在浅色 / 深色两套主题下都正常。
 * 跑法：node tools/_shot_neural_topbar.mjs（项目根，服务需已在 17321 运行）
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = "http://127.0.0.1:17321";
const NODES = JSON.parse(fs.readFileSync("tools/_neural_nodes.json", "utf8"));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 820 } });
const page = await context.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String((e && e.message) || e)));

await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await page.evaluate(async (em) => {
  await fetch("/api/auth/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: em, name: "ui", password: "test123456" }),
  });
}, "uitest+" + Date.now() + "@e.com");
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);

const pid = await page.evaluate(async () => {
  const r = await fetch("/api/projects", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "neural-topbar", subject: "general" }),
  });
  const d = await r.json();
  return d && (d.project_id || d.id);
});

await context.route(
  (url) => /\/api\/projects\/[^/]+$/.test(url.pathname),
  async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const u = new URL(route.request().url());
    if (!u.pathname.endsWith("/" + pid)) return route.continue();
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        project_id: pid, owner_id: "user_probe", name: "neural-topbar",
        year: "", subject: "general", project_type: "course", tags: [],
        last_position: 0, last_opened_at: null, total_reading_seconds: 0,
        sources: [], nodes: NODES, link_notes: [], favorites: [], cards: [], quiz: null,
      }),
    });
  },
);

await page.evaluate(async (p) => {
  await window.selectProject(p);
  window.switchFeature("framework");
}, pid);
await page.waitForTimeout(1200);
await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach((d) => d.close()));
await page.evaluate(() => { const b = document.getElementById("error-banner"); if (b) b.style.display = "none"; });

await page.locator(".framework-view .graph-toolbar [data-kb-neural-open]").first().click();
await page.waitForTimeout(1000);

for (const theme of ["light", "dark"]) {
  await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `screenshots/neural-topbar-${theme}.png` });
  const box = await page.locator("#ko-nv-overlay .ko-nv-top .ko-nv-kpis").boundingBox();
  const top = await page.locator("#ko-nv-overlay .ko-nv-top").boundingBox();
  console.log(`[${theme}] kpis box =`, box, " top bar =", top);
}

console.log("控制台报错:", errors.length ? errors : "无");
await browser.close();
