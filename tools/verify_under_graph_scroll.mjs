/**
 * 校验：鼠标停在图谱下方的「推导与机制 / 自检」卡片上时，滚轮仍应滚动整块内容区。
 *   KO_BASE=http://127.0.0.1:17321 node tools/verify_under_graph_scroll.mjs
 *
 * 历史 bug：.kb-mec-body 自己是个滚动区
 *   （max-height:40vh; overflow-y:auto; overscroll-behavior:contain）
 * —— 滚轮被吃掉 + contain 截断滚动链，鼠标停在卡片上滚不动，必须挪到空白处才滚得动。
 * 本用例先注入旧规则证明能复现，再验证现状（无嵌套滚动）正常。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.KO_BASE || 'http://127.0.0.1:17321';
const STRUCT = JSON.parse(fs.readFileSync(path.join(__dirname, '_real_structure.json'), 'utf8'));

const fails = [];
const ok = [];
const check = (name, pass, detail = '') => (pass ? ok : fails).push(`${pass ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1381, height: 742 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));

await page.goto(BASE + '/static/index.html', { waitUntil: 'load' });
await page.waitForTimeout(1000);
const { pid } = await page.evaluate(async (struct) => {
  const email = 'us' + Date.now() + '@example.com';
  await fetch('/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'probe-pass-123', name: '滚动' }), credentials: 'same-origin',
  });
  const proj = await fetch('/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject: '非线性光学', year: '2026' }), credentials: 'same-origin',
  });
  const body = await proj.json();
  const pid = body.project_id || (body.project && body.project.project_id);
  const idMap = {}; let pending = struct.slice(), guard = 0;
  while (pending.length && guard++ < 20) {
    const next = [];
    for (const n of pending) {
      if (n.parent_id && !idMap[n.parent_id]) { next.push(n); continue; }
      const r = await fetch(`/api/projects/${pid}/framework/nodes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: n.name, description: n.description || '', parent_id: n.parent_id ? idMap[n.parent_id] : null }),
        credentials: 'same-origin',
      });
      const b = await r.json();
      if (b.node) idMap[n.node_id] = b.node.node_id;
    }
    if (next.length === pending.length) break;
    pending = next;
  }
  return { pid };
}, STRUCT);

await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1400);
await page.evaluate(async (pid) => {
  await selectProject(pid);
  if (typeof switchFeature === 'function') switchFeature('framework');
  if (typeof expandStudio === 'function') expandStudio();
}, pid);
await page.waitForTimeout(1400);

// 注入图谱下方两张卡（结构照 kb-passport-ui.js 的 underCard / mechanismBody / checksBody）
await page.evaluate(() => {
  const host = document.querySelector('[data-kb-mechanism]');
  const steps = Array.from({ length: 14 }, (_, i) =>
    `<li class="kb-mec-step"><span class="kb-mec-num">${i + 1}</span><div class="kb-mec-line">第 ${i + 1} 步：把入射场代入耦合波方程，比较相位失配量随波长的变化趋势，判断走离长度量级是否可忽略。</div></li>`).join('');
  const checks = Array.from({ length: 8 }, (_, i) =>
    `<details class="kb-mec-check"${i === 0 ? ' open' : ''}><summary class="kb-mec-check-q"><span class="kb-mec-check-n">${i + 1}</span><span>自检第 ${i + 1} 题：为什么准相位匹配的周期与相干长度成反比？</span></summary><div class="kb-mec-check-a">因为每半个相干长度翻转一次畴向，把累积相位误差折回，周期 Λ=2L_c。</div></details>`).join('');
  const card = (kicker, count, key, body) =>
    `<section class="kb-mec" data-kb-card="${key}" data-open="true"><div class="kb-mec-head"><span class="kb-mec-kicker">${kicker}</span><span class="kb-mec-title">非线性光学</span><span class="kb-mec-count">${count}</span><button type="button" class="kb-mec-toggle" data-kb-mec-toggle aria-expanded="true">收起</button></div><div class="kb-mec-body">${body}</div></section>`;
  host.hidden = false;
  host.innerHTML = card('推导与机制', '14 步', 'mechanism', `<ol class="kb-mec-steps">${steps}</ol>`)
    + card('自检', '8 题', 'checks', `<div class="kb-mec-checks">${checks}</div>`);
});
await page.waitForTimeout(300);

// 把卡片滚进视野，取卡片正文中心作为滚轮落点
const target = await page.evaluate(() => {
  const out = document.querySelector('#studio-output');
  const body = document.querySelector('.kb-mec-body');
  body.scrollIntoView({ block: 'center' });
  const r = body.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: Math.max(80, Math.min(r.y + 40, 680)), outTop: out.scrollTop, hostRect: { y: Math.round(r.y) } };
});
await page.waitForTimeout(250);

const wheelOver = async (x, y, delta = 320) => {
  await page.mouse.move(x, y);
  const before = await page.evaluate(() => document.querySelector('#studio-output').scrollTop);
  await page.mouse.wheel(0, delta);
  await page.waitForTimeout(350);
  const after = await page.evaluate(() => document.querySelector('#studio-output').scrollTop);
  return { before, after, delta: after - before };
};

// --- 先证明诊断：把旧规则塞回去，滚轮就该被卡片吃掉 ---
await page.addStyleTag({ content: '.kb-mec-body { max-height: 40vh; overflow-y: auto; overscroll-behavior: contain; }' });
await page.waitForTimeout(200);
const broken = await wheelOver(target.x, target.y);
check('复现旧 bug（卡片自己变成滚动区时，滚轮带不动整块内容区）', broken.delta === 0,
  `#studio-output.scrollTop ${broken.before} → ${broken.after}`);

// --- 现状：去掉嵌套滚动后，滚轮必须穿透到内容区 ---
await page.evaluate(() => {
  document.querySelectorAll('style').forEach((s) => { if (s.textContent.includes('max-height: 40vh')) s.remove(); });
});
await page.waitForTimeout(200);
const fine = await wheelOver(target.x, target.y);
check('鼠标停在卡片上滚轮能滚动内容区', fine.delta > 100, `#studio-output.scrollTop ${fine.before} → ${fine.after}`);

// --- 对照：空白处本来就能滚（先把滚动位置复位，免得撞到底部提前"滚不动"）---
await page.evaluate(() => { document.querySelector('#studio-output').scrollTop = 0; });
await page.waitForTimeout(250);
const blank = await page.evaluate(() => {
  const legend = document.querySelector('.legend');
  const r = legend.getBoundingClientRect();
  return { x: Math.min(r.x + 20, 1300), y: Math.max(90, r.y - 8) };
});
const ctrl = await wheelOver(blank.x, blank.y, 300);
check('对照：鼠标在空白处同样能滚动', ctrl.delta > 100, `#studio-output.scrollTop ${ctrl.before} → ${ctrl.after}`);

// --- 源码级护栏：卡片正文不能再被写成滚动区 ---
const passportCss = fs.readFileSync(path.join(__dirname, '..', 'static', 'styles-passport.css'), 'utf8');
const bodyRule = passportCss.match(/\.kb-mec-body\s*\{[^}]*\}/);
check('.kb-mec-body 不再是滚动容器（无 overflow-y / max-height / overscroll-behavior）',
  !!bodyRule && !/overflow(-y)?\s*:|max-height\s*:|overscroll-behavior\s*:/.test(bodyRule[0]),
  bodyRule ? bodyRule[0].replace(/\s+/g, ' ').slice(0, 140) : '未找到 .kb-mec-body 规则');

check('页面无未捕获异常', pageErrors.length === 0, pageErrors.join(' / '));

console.log('\n=== 图谱下方卡片：滚轮穿透 ===');
ok.forEach((line) => console.log('  ' + line));
if (fails.length) {
  console.log('\n=== 失败 ===');
  fails.forEach((line) => console.log('  ' + line));
}
await page.screenshot({ path: path.join(__dirname, '..', 'screenshots', 'under_graph_scroll_verify.png') });
await browser.close();
console.log(fails.length ? `\n结果：${fails.length} 项失败` : `\n结果：全部 ${ok.length} 项通过`);
process.exit(fails.length ? 1 : 0);
