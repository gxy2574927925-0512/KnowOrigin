import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'screenshots');
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1180, height: 1400 }, deviceScaleFactor: 2 });
await page.route('**/*', r => r.continue({ headers: { ...r.request().headers(), 'cache-control': 'no-cache' } }));
await page.goto('http://127.0.0.1:17321/static/_immersive_preview.html', { waitUntil: 'load' });
// 演示外壳放开高度，把对话区与收敛条一起拍进来
await page.evaluate(() => {
  const d = document.querySelector('.kb-dock-demo');
  d.style.height = 'auto';
  d.style.overflow = 'visible';
  d.querySelector('.kb-pane').style.overflow = 'visible';
});
await page.waitForTimeout(700);
await page.locator('.kb-dock-demo').screenshot({ path: path.join(OUT, 'immersive_chat_area.png') });
console.log('saved');
await b.close();
