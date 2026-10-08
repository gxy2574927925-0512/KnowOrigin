// 沉浸层预览页截图：node tools/_shot_immersive_preview.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'screenshots');
const URL = 'http://127.0.0.1:17321/static/_immersive_preview.html';
const browser = await chromium.launch();
for (const theme of ['dark', 'light']) {
  const page = await browser.newPage({ viewport: { width: 1340, height: 900 }, deviceScaleFactor: 2 });
  await page.route('**/*', r => r.continue({ headers: { ...r.request().headers(), 'cache-control': 'no-cache' } }));
  await page.goto(URL, { waitUntil: 'load' });
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, `immersive_preview_${theme}.png`), fullPage: true });
  console.log(`saved immersive_preview_${theme}.png`);
  await page.close();
}
await browser.close();
