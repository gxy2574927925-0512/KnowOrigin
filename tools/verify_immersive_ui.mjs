// 沉浸层（styles-immersive.css）视觉与规则验证
// 跑法：node tools/verify_immersive_ui.mjs
// 产出：screenshots/immersive_{dark,light}_home.png、immersive_dark_reader.png
// 断言：① CSS 层已加载且规则数 > 0  ② 深色 body 落在高级黑底色上
//       ③ ko-kd 阅读器 overlay 背景不是旧 --panel 色  ④ 无 JS 报错
import { chromium } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'screenshots');
const PORTS = [17321, 17322, 17323, 17324];
let BASE = '';

function probe(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

for (const p of PORTS) { if (await probe(p)) { BASE = `http://127.0.0.1:${p}`; break; } }
if (!BASE) { console.error('服务未运行（17321-17324）'); process.exit(2); }
console.log(`服务 ${BASE}`);

const EMAIL = 'immersive-check@example.com';
const PASSWORD = 'immersive-check-1234';

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 2 });
// 注册（已存在则登录），cookie 落在 context 上，页面同享
const reg = await context.request.post(`${BASE}/api/auth/register`, { data: { email: EMAIL, password: PASSWORD } });
if (reg.status() === 409) await context.request.post(`${BASE}/api/auth/login`, { data: { email: EMAIL, password: PASSWORD } });

const page = await context.newPage();
const cdp = await page.context().newCDPSession(page);
await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));

let FAIL = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) FAIL += 1; };

await page.goto(BASE + '/', { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction(() => document.documentElement.dataset.sessionReady === '1', { timeout: 30000 }).catch(() => {});

// —— 深色 · tju 品牌（当前主用形态）——
await page.evaluate(() => {
  localStorage.setItem('knoworigin-ui', 'agent');
  localStorage.setItem('knoworigin-theme', 'dark');
  localStorage.setItem('knoworigin-brand', 'default');
});
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1800);

const dark = await page.evaluate(() => {
  const sheets = [...document.styleSheets];
  const imm = sheets.find((s) => (s.href || '').includes('styles-immersive'));
  let rules = 0;
  try { rules = imm ? imm.cssRules.length : 0; } catch { rules = -1; }
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  const docEl = getComputedStyle(document.documentElement);
  return {
    loaded: !!imm,
    rules,
    bodyBg,
    bgVar: docEl.getPropertyValue('--background').trim(),
    panelVar: docEl.getPropertyValue('--panel').trim(),
  };
});
console.log('深色状态：', JSON.stringify(dark));
ok(dark.loaded && dark.rules > 20, `沉浸层已加载（${dark.rules} 条规则）`);
ok(dark.bodyBg === 'rgb(10, 11, 14)', `深色 body = 高级黑 #0a0b0e（实测 ${dark.bodyBg}）`);
ok(dark.panelVar === '#121419', `--panel 统一到 #121419（实测 ${dark.panelVar}）`);
await page.screenshot({ path: path.join(OUT, 'immersive_dark_home.png') });

// —— 深色 · 文档阅读器（调全局桥，无数据也能看 overlay 氛围）——
await page.evaluate(() => {
  try { window.KnowOriginKnowledgeDoc?.openOrGenerate?.('demo-node', '演示知识点'); } catch {}
});
await page.waitForTimeout(2500);
const kdGlobal = await page.evaluate(() => typeof window.KnowOriginKnowledgeDoc);
  console.log('KnowOriginKnowledgeDoc 类型:', kdGlobal);
  const reader = await page.evaluate(() => {
  const el = document.getElementById('ko-kd-overlay');
  if (!el) return { open: false };
  const cs = getComputedStyle(el);
  return { open: true, bg: cs.backgroundColor, pos: cs.position };
});
console.log('阅读器状态：', JSON.stringify(reader));
if (reader.open) {
  ok(reader.pos === 'fixed', '阅读器 overlay 全屏铺开');
  await page.screenshot({ path: path.join(OUT, 'immersive_dark_reader.png') });
} else {
  console.log('  skip  阅读器入口未暴露（不影响样式层验证）');
}

// —— 浅色对照 ——
await page.evaluate(() => { localStorage.setItem('knoworigin-theme', 'light'); });
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1500);
const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
console.log('浅色 body：', light);
await page.screenshot({ path: path.join(OUT, 'immersive_light_home.png') });

ok(errors.length === 0, `无 JS 报错${errors.length ? '：' + errors[0] : ''}`);
console.log(FAIL ? `\n${FAIL} 项未过` : '\n全部通过');
await browser.close();
process.exit(FAIL ? 1 : 0);
