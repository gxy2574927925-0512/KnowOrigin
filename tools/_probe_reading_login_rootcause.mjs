// 复现根因：初始化未完成（loadProjects 慢）时打开阅读模式 → 首屏兜底把登录卡塞回来
// 跑法：node tools/_probe_reading_login_rootcause.mjs
import { chromium } from 'playwright';
import http from 'node:http';

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
if (!BASE) { console.error('服务未运行'); process.exit(2); }

const EMAIL = 'reading-login-probe@example.com';
const PASSWORD = 'probe-pass-1234';

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1500, height: 940 } });
await context.request.post(`${BASE}/api/auth/login`, { data: { email: EMAIL, password: PASSWORD } });
const page = await context.newPage();

// 关键：只延迟 /api/projects（loadProjects），让「已登录但 init 未跑完」的窗口拉长
await page.route('**/api/projects', async (route) => {
  await new Promise((r) => setTimeout(r, 6000));
  await route.continue();
});

const vis = () => page.evaluate(() => {
  const v = (id) => {
    const el = document.getElementById(id);
    if (!el) return 'missing';
    // 必须看计算样式：hidden 类被别处覆盖时 classList 看不出来
    return getComputedStyle(el).display === 'none' ? 'hidden' : 'VISIBLE';
  };
  return {
    auth: v('auth-shell'), workspace: v('workspace'),
    reading: v('reading-workspace'), literature: v('literature-workspace'),
    sessionReady: document.documentElement.dataset.sessionReady || '',
  };
});

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
// 等「工作台可见」（setAuthenticated 已跑，但 loadProjects 还卡着）那一刻点「读书」
await page.waitForFunction(() => {
  const w = document.getElementById('workspace');
  return w && getComputedStyle(w).display !== 'none';
}, { timeout: 20000 });
console.log('工作台刚可见（init 未完成）:', JSON.stringify(await vis()));
await page.evaluate(() => {
  document.querySelectorAll('dialog[open]').forEach((d) => { try { d.close(); } catch { /* ignore */ } });
});
await page.locator('[data-agent-module="reading"]').click({ force: true });
console.log('点「读书」之后立刻:', JSON.stringify(await vis()));
await page.waitForTimeout(7000);
console.log('等兜底与 init 都跑完:', JSON.stringify(await vis()));
await page.screenshot({ path: 'screenshots/probe-login-rootcause.png' });
await browser.close();
