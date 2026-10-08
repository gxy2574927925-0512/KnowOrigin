/**
 * 真机量测 + 截图：读书「选中 → AI 陪读讨论」。
 * 跑：node tools/_reading_ask_shot.mjs [--shot]
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = "file:///" + path.join(ROOT, "_reading_ask_preview.html").replace(/\\/g, "/");
const variants = [
  { hash: "", name: "light" },
  { hash: "#dark", name: "dark" },
];

const browser = await chromium.launch();
const out = {};
for (const v of variants) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(url + v.hash, { waitUntil: "load" });
  await page.waitForFunction(() => window.__done === true, null, { timeout: 15000 });
  out[v.name] = JSON.parse(await page.$eval("#out", (el) => el.textContent));
  if (process.argv.includes("--shot")) {
    await page.evaluate(() => document.body.classList.add("shot"));
    await page.screenshot({ path: path.join(ROOT, "logs", `_reading_ask_${v.name}.png`) });
  }
  await page.close();
}
await browser.close();
console.log(JSON.stringify(out, null, 1));
