// 验证「打开阅读模式 → 出现登录界面」已修复，且白屏兜底本身仍然有效。
// 跑法：node tools/verify_reading_login_fix.mjs
//
// 覆盖：
//   ① 兜底（index.html 3 秒）不再把可见的 #reading-workspace 误判成白屏
//   ② 兜底同样不再误判 #literature-workspace（原有漏洞：app.js 的 init 收尾那份名单漏了它）
//   ③ 真的什么都没显示时，兜底仍必须露出登录页（不能为了修①把兜底弄哑）
//   ④ 真实时序：登录后 init 未跑完（/api/projects 慢）时进「读书」，登录卡不得出现
//   ⑤ 未登录时必须照常显示登录页
//   ⑥ 常规流程回归：登录 → 读书 → 返回工作台
import { chromium } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
console.log(`服务 ${BASE}\n`);

const EMAIL = 'reading-login-probe@example.com';
const PASSWORD = 'probe-pass-1234';

let FAIL = 0;
function ok(cond, msg, detail = '') {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}${detail ? `（${detail}）` : ''}`);
  if (!cond) FAIL += 1;
}

const browser = await chromium.launch();

async function newContext() {
  return browser.newContext({ viewport: { width: 1500, height: 940 } });
}

async function login(context) {
  const reg = await context.request.post(`${BASE}/api/auth/register`, { data: { email: EMAIL, password: PASSWORD, name: '读书探针' } });
  if (reg.status() !== 201) await context.request.post(`${BASE}/api/auth/login`, { data: { email: EMAIL, password: PASSWORD } });
}

const VIS_FN = `(() => {
  const v = (id) => {
    const el = document.getElementById(id);
    if (!el) return 'missing';
    const cs = getComputedStyle(el);
    return (cs.display === 'none' || cs.visibility === 'hidden') ? 'hidden' : 'VISIBLE';
  };
  return { auth: v('auth-shell'), workspace: v('workspace'), reading: v('reading-workspace'),
           literature: v('literature-workspace'), sessionReady: document.documentElement.dataset.sessionReady || '' };
})()`;

function show(tag, state) { console.log(`       ${tag}: ${JSON.stringify(state)}`); }

// ---------- ①②③：直接验兜底判定（拦掉 app.js，sessionReady 永远为空） ----------
// 拦掉 app.js = 模拟「脚本异常 / 首屏兜底必须独立生效」的极端场景。
for (const [caseName, keepVisible] of [['① 读书视图可见', 'reading-workspace'], ['② 文章阅读视图可见', 'literature-workspace']]) {
  const context = await newContext();
  const page = await context.newPage();
  await page.route('**/app.js*', (route) => route.abort());
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  // 造出「只有该阅读视图可见」的局面
  await page.evaluate((keep) => {
    ['auth-shell', 'workspace', 'literature-workspace', 'reading-workspace', 'error-banner']
      .forEach((id) => document.getElementById(id)?.classList.add('hidden'));
    const el = document.getElementById(keep);
    el.classList.remove('hidden');
    if (keep === 'reading-workspace') el.classList.add('is-open');
  }, keepVisible);
  show('注入后', await page.evaluate(VIS_FN));
  await page.waitForTimeout(4000);
  const after = await page.evaluate(VIS_FN);
  show('4 秒后', after);
  ok(after.auth === 'hidden', `${caseName}：3 秒兜底不得露出登录页`);
  await context.close();
}

{
  const context = await newContext();
  const page = await context.newPage();
  await page.route('**/app.js*', (route) => route.abort());
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.evaluate(() => {
    ['auth-shell', 'workspace', 'literature-workspace', 'reading-workspace', 'error-banner']
      .forEach((id) => document.getElementById(id)?.classList.add('hidden'));
  });
  await page.waitForTimeout(4000);
  const after = await page.evaluate(VIS_FN);
  show('③ 全隐藏 4 秒后', after);
  ok(after.auth === 'VISIBLE', '③ 真·白屏时兜底仍必须露出登录页');
  await context.close();
}

// ---------- ④：真实时序 —— init 未跑完时进「读书」 ----------
{
  const context = await newContext();
  await login(context);
  const page = await context.newPage();
  // 只拖慢 /api/projects（loadProjects）：setAuthenticated 已跑（工作台可见）但 init 未收尾
  await page.route('**/api/projects', async (route) => {
    await new Promise((r) => setTimeout(r, 6000));
    await route.continue();
  });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => {
    const w = document.getElementById('workspace');
    return w && getComputedStyle(w).display !== 'none';
  }, { timeout: 20000 });
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => { try { d.close(); } catch { /* ignore */ } }));
  await page.locator('[data-agent-module="reading"]').click({ force: true });
  await page.waitForTimeout(8000);
  const after = await page.evaluate(VIS_FN);
  show('④ 拖慢 /api/projects 后进读书', after);
  ok(after.auth === 'hidden', '④ 阅读模式里不得叠出登录界面');
  ok(after.reading === 'VISIBLE', '④ 读书视图仍在最前');
  const dialogs = await page.evaluate(() => [...document.querySelectorAll('dialog[open]')].map((d) => d.id));
  ok(dialogs.length === 0, '④ 阅读模式里不得被自动弹窗（新建项目）挡住', dialogs.join(','));
  await page.screenshot({ path: path.join(ROOT, 'screenshots', 'verify-reading-no-login.png') });
  await context.close();
}

// ---------- ④b：同一时序下的「文章阅读」（旧 app.js 名单也漏了它） ----------
{
  const context = await newContext();
  await login(context);
  const page = await context.newPage();
  await page.route('**/api/projects', async (route) => {
    await new Promise((r) => setTimeout(r, 6000));
    await route.continue();
  });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => {
    const w = document.getElementById('workspace');
    return w && getComputedStyle(w).display !== 'none';
  }, { timeout: 20000 });
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => { try { d.close(); } catch { /* ignore */ } }));
  await page.locator('[data-agent-action="literature"]').click({ force: true });
  await page.waitForTimeout(8000);
  const after = await page.evaluate(VIS_FN);
  show('④b 拖慢 /api/projects 后进文章阅读', after);
  ok(after.auth === 'hidden', '④b 文章阅读里不得叠出登录界面');
  await context.close();
}

// ---------- ⑤：未登录 ----------
{
  const context = await newContext();
  const page = await context.newPage();
  await page.goto(BASE + '/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(4000);
  const after = await page.evaluate(VIS_FN);
  show('⑤ 未登录', after);
  ok(after.auth === 'VISIBLE' && after.workspace === 'hidden', '⑤ 未登录时照常显示登录页');
  await context.close();
}

// ---------- ⑥：常规流程回归 ----------
{
  const context = await newContext();
  await login(context);
  const page = await context.newPage();
  await page.goto(BASE + '/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => document.documentElement.dataset.sessionReady === '1', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => { try { d.close(); } catch { /* ignore */ } }));
  const before = await page.evaluate(VIS_FN);
  ok(before.auth === 'hidden' && before.workspace === 'VISIBLE', '⑥ 登录后工作台可见、登录页收起');
  await page.locator('[data-agent-module="reading"]').click();
  await page.waitForTimeout(2000);
  const mid = await page.evaluate(VIS_FN);
  ok(mid.auth === 'hidden' && mid.reading === 'VISIBLE', '⑥ 进「读书」正常，无登录页');
  await page.locator('[data-rd-exit]').click();
  await page.waitForTimeout(600);
  const end = await page.evaluate(VIS_FN);
  ok(end.auth === 'hidden' && end.workspace === 'VISIBLE', '⑥「返回工作台」回到工作台，无登录页');
  await context.close();
}

// ---------- ⑦：新账号（没有任何项目）登录，必须照常自动弹「建立独立项目」 ----------
// 这是 ④ 里那个弹窗守卫的回归项：守卫只能在用户已经离开工作台时闭嘴。
{
  const context = await newContext();
  const fresh = 'reading-probe-noproject@example.com';
  const reg = await context.request.post(`${BASE}/api/auth/register`, { data: { email: fresh, password: PASSWORD, name: '无项目探针' } });
  if (reg.status() !== 201) await context.request.post(`${BASE}/api/auth/login`, { data: { email: fresh, password: PASSWORD } });
  const page = await context.newPage();
  await page.goto(BASE + '/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(2500);
  const state = await page.evaluate(() => ({
    workspace: getComputedStyle(document.getElementById('workspace')).display !== 'none',
    dialog: !!document.querySelector('#project-dialog[open]'),
  }));
  show('⑦ 无项目新账号登录', state);
  ok(state.workspace && state.dialog, '⑦ 停在工作台时仍自动弹「建立独立项目」');
  await context.close();
}

await browser.close();
console.log(FAIL ? `\n${FAIL} 项未过` : '\n全部通过');
process.exit(FAIL ? 1 : 0);
