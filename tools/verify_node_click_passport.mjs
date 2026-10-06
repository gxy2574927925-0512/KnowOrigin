/**
 * 校验：单击知识图谱节点必定滑出语义护照。
 *   KO_BASE=http://127.0.0.1:17321 node tools/verify_node_click_passport.mjs
 *
 * 覆盖三种「点了没反应」的历史成因：
 *   1) 裸点击                 → 必须打开
 *   2) 位移 >5px 的拖动       → 不许当作点击弹护照（但也不许把节点搞死）
 *   3) 逐个节点挂监听的路径整段失效（cloneNode 抹掉监听）→ 委托路径仍须打开
 *      这是本用例存在的理由：旧写法把单击监听挂在 renderFramework 末尾，
 *      上游任何一处抛错，图谱照画、节点全成死区，脚本里看不出任何异常。
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
  const email = 'vc' + Date.now() + '@example.com';
  await fetch('/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'probe-pass-123', name: '校验' }), credentials: 'same-origin',
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

const passportState = () => page.evaluate(() => {
  const host = document.querySelector('.kb-passport-host');
  const r = host && host.getBoundingClientRect();
  return {
    attr: document.documentElement.getAttribute('data-kb-passport') || null,
    visible: !!(host && !host.hidden && r && r.width > 100 && r.height > 40),
    title: host && host.querySelector('.kp-title') ? host.querySelector('.kp-title').textContent : '',
  };
});
const nodeBox = (nth = 0) => page.evaluate((i) => {
  const el = [...document.querySelectorAll('.graph-node[data-node-id]')][i];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, id: el.dataset.nodeId };
}, nth);
const closePassport = async () => {
  await page.evaluate(() => { if (window.KBPassport) window.KBPassport.close(); });
  await page.waitForTimeout(250);
};

// ---- 1) 裸点击 ----
const box = await nodeBox(0);
await closePassport();
await page.mouse.click(box.x, box.y);
await page.waitForTimeout(700);
let st = await passportState();
check('裸点击节点 → 护照打开且可见', st.attr === 'open' && st.visible, JSON.stringify(st));

// ---- 2) 真实节奏的单击：按下 → 停 250ms（够 CSS 过渡跑完）→ 抬起 ----
// 这一条才是本 bug 的现场：styles-polish.css 的按压回弹 [role="button"]:active
// 会把 CSS transform 压在节点的 transform 属性上，节点丢掉 translate 飘到画布
// 左上角，抬手时鼠标已经不在节点上 → click 落到 <svg> 上，护照永远不弹。
await closePassport();
const geoBefore = await page.evaluate(() => {
  const el = document.querySelector('.graph-node[data-node-id]');
  const r = el.getBoundingClientRect();
  // 现代浏览器把 SVG 的 transform 表现属性也反映到 computed transform 上，
  // 所以「按下前后 computed transform 一致」就是「定位没被 CSS 抢走」的判据。
  return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), cssTransform: getComputedStyle(el).transform };
});
await page.mouse.move(box.x, box.y);
await page.mouse.down();
await page.waitForTimeout(250);
const pressed = await page.evaluate(() => {
  const el = document.querySelector('.graph-node[data-node-id]');
  const r = el.getBoundingClientRect();
  return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), cssTransform: getComputedStyle(el).transform };
});
await page.screenshot({ path: path.join(__dirname, '..', 'screenshots', 'node_click_passport_pressed.png') });
await page.mouse.up();
await page.waitForTimeout(700);
st = await passportState();
await page.screenshot({ path: path.join(__dirname, '..', 'screenshots', 'node_click_passport_after.png') });
const drift = Math.hypot(pressed.x - geoBefore.x, pressed.y - geoBefore.y);
check('按下 250ms 后节点没飘走', drift < 1, `位移 ${drift.toFixed(1)}px  ${JSON.stringify(geoBefore)} → ${JSON.stringify({ x: pressed.x, y: pressed.y })}`);
// :active 期间不能换掉节点的 transform —— 图谱节点的定位就写在 transform 属性上，
// 被 CSS 顶掉 = 飘到画布左上角（本 bug 的机制）
check('按下期间定位没被 CSS transform 顶掉', pressed.cssTransform === geoBefore.cssTransform,
  `按下前 ${geoBefore.cssTransform} / 按下时 ${pressed.cssTransform}`);
check('真实节奏单击 → 护照打开', st.attr === 'open' && st.visible, JSON.stringify(st));

// ---- 3) 拖动 8px：算平移，不该弹护照 ----
await closePassport();
await page.mouse.move(box.x, box.y);
await page.mouse.down();
await page.mouse.move(box.x + 8, box.y, { steps: 3 });
await page.mouse.up();
await page.waitForTimeout(600);
st = await passportState();
check('拖动 8px 后松开 → 不弹护照', st.attr !== 'open' && !st.visible, JSON.stringify(st));

// ---- 3) 逐个节点的监听整段失效（等价于 renderFramework 末段抛错）----
await closePassport();
await page.evaluate(() => {
  document.querySelectorAll('#studio-output .graph-node').forEach((node) => {
    node.replaceWith(node.cloneNode(true)); // cloneNode 丢掉全部 addEventListener
  });
});
const box3 = await nodeBox(0);
await page.mouse.click(box3.x, box3.y);
await page.waitForTimeout(700);
st = await passportState();
check('节点自身监听全丢后，委托路径仍能打开护照', st.attr === 'open' && st.visible, JSON.stringify(st));

// ---- 4) 键盘：Enter 打开 ----
await closePassport();
await page.evaluate(() => {
  const el = document.querySelector('#studio-output .graph-node[data-node-id]');
  el.focus();
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
});
await page.waitForTimeout(700);
st = await passportState();
check('节点聚焦后按 Enter → 护照打开', st.attr === 'open' && st.visible, JSON.stringify(st));

// ---- 5) 普通 HTML 按钮的按压回弹不能被误伤 ----
await closePassport();
const tabBox = await page.evaluate(() => {
  const btn = document.querySelector('[data-kb-view="tree"]');
  const r = btn.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.move(tabBox.x, tabBox.y);
await page.mouse.down();
await page.waitForTimeout(120);
const tabPressed = await page.evaluate(() => getComputedStyle(document.querySelector('[data-kb-view="tree"]')).transform);
await page.mouse.up();
await page.waitForTimeout(200);
check('普通 HTML 按钮仍保留按压回弹', tabPressed !== 'none', `:active computed transform = ${tabPressed}`);

// ---- 6) 源码级护栏：所有给 :active 设 transform 的规则都必须带着 :not([transform]) ----
// 来源视图的 .kb-src-node 与图谱节点是同一族（<g role="button" transform=...>），
// 这条断言让两个分支（正常回弹 / prefers-reduced-motion 的 transform:none）
// 都不能悄悄被改回去。
const polish = fs.readFileSync(path.join(__dirname, '..', 'static', 'styles-polish.css'), 'utf8');
const roleButtonActiveRules = [...polish.matchAll(/^[^{}]*\[role="button"\][^{}]*:active[^{}]*\{[^}]*\}/gm)].map((m) => m[0]);
const guardOk = roleButtonActiveRules.length >= 2
  && roleButtonActiveRules.every((rule) => /\[role="button"\][^{]*:not\(\[transform\]\)[^{]*:active/.test(rule));
check('所有 [role="button"]:active 规则都带 :not([transform])',
  guardOk, `命中 ${roleButtonActiveRules.length} 条：${roleButtonActiveRules.map((r) => r.split('{')[0].trim().replace(/\s+/g, ' ')).join(' | ')}`);

// ---- 7) 无脚本报错 ----
check('页面无未捕获异常', pageErrors.length === 0, pageErrors.join(' / '));

console.log('\n=== 图谱节点点击 → 语义护照 ===');
ok.forEach((line) => console.log('  ' + line));
if (fails.length) {
  console.log('\n=== 失败 ===');
  fails.forEach((line) => console.log('  ' + line));
}
await page.screenshot({ path: path.join(__dirname, '..', 'screenshots', 'node_click_passport_verify.png') });
await browser.close();
console.log(fails.length ? `\n结果：${fails.length} 项失败` : `\n结果：全部 ${ok.length} 项通过`);
process.exit(fails.length ? 1 : 0);
