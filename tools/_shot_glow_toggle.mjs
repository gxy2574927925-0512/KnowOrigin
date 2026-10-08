// 辉光开关验证：默认 off（安静）→ on（有辉光）各截一张，并断言真实页面开关持久化
// 跑法：node tools/_shot_glow_toggle.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'screenshots');
const PREVIEW = 'http://127.0.0.1:17321/static/_immersive_preview.html';
const browser = await chromium.launch();
let FAIL = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) FAIL += 1; };

// —— 预览页：关 / 开 两张 ——
let offShadow = '';
for (const glow of ['off', 'on']) {
  const page = await browser.newPage({ viewport: { width: 1340, height: 900 }, deviceScaleFactor: 2 });
  await page.route('**/*', r => r.continue({ headers: { ...r.request().headers(), 'cache-control': 'no-cache' } }));
  await page.goto(PREVIEW, { waitUntil: 'load' });
  await page.evaluate((g) => document.documentElement.setAttribute('data-glow', g), glow);
  await page.waitForTimeout(600);
  const card = page.locator('.card.flip-card').first();
  await card.hover();
  await page.waitForTimeout(500);
  // 辉光挂在 .card.flip-card 元素本身（hover 态），不在 .flip-card-face 上
  const shadow = await card.evaluate(el => getComputedStyle(el).boxShadow);
  const sheen = await card.evaluate(el => getComputedStyle(el.querySelector('.flip-card-front'), '::after').content);
  if (glow === 'off') offShadow = shadow;
  console.log(`glow=${glow} 卡片阴影=${shadow.slice(0, 70)}…  扫光=${sheen}`);
  if (glow === 'off') {
    ok(shadow.includes('rgba(0, 0, 0') && !/[0-9]+, [0-9]+, [0-9]+, 0\.1[89]/.test(shadow), '关闭时是中性影、无品牌色发光');
    ok(sheen === 'none' || sheen === 'normal', '关闭时釉面扫光不存在');
  } else {
    ok(shadow !== offShadow && shadow.includes('rgba('), '开启时辉光阴影与关闭时不同');
    ok(sheen.includes('linear-gradient') || sheen === '""', '开启时扫光挂上');
  }
  await page.screenshot({ path: path.join(OUT, `immersive_glow_${glow}.png`), fullPage: true, clip: { x: 0, y: 0, width: 1340, height: 900 } }).catch(() => page.screenshot({ path: path.join(OUT, `immersive_glow_${glow}.png`) }));
  await page.close();
}

// —— 真实页面：开关持久化 ——
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const reg = await ctx.request.post('http://127.0.0.1:17321/api/auth/register', { data: { email: 'glow-check@example.com', password: 'glow-check-1234' } });
if (reg.status() === 409) await ctx.request.post('http://127.0.0.1:17321/api/auth/login', { data: { email: 'glow-check@example.com', password: 'glow-check-1234' } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e.message).slice(0, 140)));
await p.goto('http://127.0.0.1:17321/', { waitUntil: 'load' });
await p.waitForFunction(() => document.documentElement.dataset.sessionReady === '1', { timeout: 30000 }).catch(() => {});
const init = await p.evaluate(() => ({
  has: typeof window.KnowOriginCardGlow,
  attr: document.documentElement.dataset.glow,
  ls: localStorage.getItem('knoworigin-card-glow'),
}));
ok(init.has === 'object', '开关 API 已挂载');
ok(init.attr === 'off', `默认关闭（data-glow=${init.attr}）`);
await p.evaluate(() => window.KnowOriginCardGlow.set('on'));
const after = await p.evaluate(() => ({ attr: document.documentElement.dataset.glow, ls: localStorage.getItem('knoworigin-card-glow') }));
ok(after.attr === 'on' && after.ls === 'on', `开启后属性与持久化都对（${after.attr}/${after.ls}）`);
await p.reload({ waitUntil: 'load' });
await p.waitForTimeout(1200);
const reloadAttr = await p.evaluate(() => document.documentElement.dataset.glow);
ok(reloadAttr === 'on', `刷新后保持开启（${reloadAttr}）`);
ok(errs.length === 0, `无 JS 报错${errs.length ? '：' + errs[0] : ''}`);
await browser.close();
console.log(FAIL ? `\n${FAIL} 项未过` : '\n全部通过');
process.exit(FAIL ? 1 : 0);
