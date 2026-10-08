// 复现「点节点 → 节点飘走」：把点击前后节点屏幕坐标、图谱变换、各渲染入口都记下来。
// KO_BASE=http://127.0.0.1:17321 node tools/_probe_drift.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.KO_BASE || 'http://127.0.0.1:17321';
const STRUCT = JSON.parse(fs.readFileSync(path.join(__dirname, '_real_structure.json'), 'utf8'));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1381, height: 742 } });
page.on('pageerror', (e) => console.log('pageerror:', String(e).slice(0, 240)));

await page.goto(BASE + '/static/index.html', { waitUntil: 'load' });
await page.waitForTimeout(1000);
const { pid } = await page.evaluate(async (struct) => {
  const email = 'dr' + Date.now() + '@example.com';
  await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'probe-pass-123', name: 'drift' }), credentials: 'same-origin' });
  const proj = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subject: '非线性光学', year: '2026' }), credentials: 'same-origin' });
  const b0 = await proj.json();
  const pid = b0.project_id || (b0.project && b0.project.project_id);
  const idMap = {}; let pending = struct.slice(), guard = 0;
  while (pending.length && guard++ < 20) {
    const next = [];
    for (const n of pending) {
      if (n.parent_id && !idMap[n.parent_id]) { next.push(n); continue; }
      const r = await fetch(`/api/projects/${pid}/framework/nodes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n.name, description: n.description || '', parent_id: n.parent_id ? idMap[n.parent_id] : null }), credentials: 'same-origin' });
      const b = await r.json(); if (b.node) idMap[n.node_id] = b.node.node_id;
    }
    if (next.length === pending.length) break; pending = next;
  }
  return { pid };
}, STRUCT);

await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1400);
await page.evaluate(async (pid) => {
  await selectProject(pid);
  switchFeature('framework');
  expandStudio();
  window.KBPassport.setLeftCollapsed(true);
}, pid);
await page.waitForTimeout(1400);

// 插桩：谁在重渲染 / 谁在改视图
await page.evaluate(() => {
  window.__log = [];
  ['renderFramework', 'buildFrameworkLayout', 'kbPassportRestore', 'kbFlowInit'].forEach((name) => {
    const fn = window[name];
    if (typeof fn !== 'function') return;
    window[name] = function (...args) {
      window.__log.push(name + '()');
      return fn.apply(this, args);
    };
  });
  const openFn = window.KBPassport.open;
  window.KBPassport.open = function (id) { window.__log.push('KBPassport.open(' + (id || '').slice(0, 10) + ')'); return openFn.call(this, id); };
  ['pointerdown', 'pointermove', 'pointerup', 'click', 'dblclick'].forEach((type) => {
    document.addEventListener(type, (e) => {
      window.__log.push(type + ' target=' + (e.target.tagName || '?') + '.' + String(e.target.getAttribute && e.target.getAttribute('class') || '').slice(0, 28) + ' detail=' + e.detail);
    }, true);
  });
});

const snapshot = () => page.evaluate(() => {
  const svg = document.querySelector('.knowledge-graph');
  const viewport = document.querySelector('.graph-viewport');
  const host = document.querySelector('.kb-passport-host');
  const hr = host && host.hidden === false ? host.getBoundingClientRect() : null;
  const nodes = [...document.querySelectorAll('.graph-node[data-node-id]')].slice(0, 4).map((n) => {
    const r = n.getBoundingClientRect();
    return { id: n.dataset.nodeId.slice(-6), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) };
  });
  const sr = svg.getBoundingClientRect();
  return {
    svgRect: { x: Math.round(sr.x), w: Math.round(sr.width), h: Math.round(sr.height) },
    transform: viewport ? viewport.getAttribute('transform') : null,
    viewBox: svg.getAttribute('viewBox'),
    cols: getComputedStyle(document.querySelector('.framework-shell')).gridTemplateColumns,
    passportAttr: document.documentElement.dataset.kbPassport || null,
    hostHidden: host ? host.hidden : 'NONE',
    hostRect: hr ? { x: Math.round(hr.x), w: Math.round(hr.width), h: Math.round(hr.height) } : null,
    nodes,
  };
});

const show = (label, s) => {
  console.log(`\n### ${label}`);
  console.log('  svg:', JSON.stringify(s.svgRect), 'viewBox:', s.viewBox, 'transform:', s.transform);
  console.log('  cols:', s.cols, '| passport:', s.passportAttr, '| hostHidden:', s.hostHidden, '| host:', JSON.stringify(s.hostRect));
  s.nodes.forEach((n) => console.log(`   node ${n.id}  x=${n.x} y=${n.y} w=${n.w}`));
};

console.log('=== 点击前 ===');
const before = await snapshot();
show('before', before);

// 悬停 + 点击第一个节点
const box = await page.evaluate(() => {
  const el = document.querySelector('.graph-node[data-node-id]');
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, id: el.dataset.nodeId };
});
await page.mouse.move(box.x, box.y);
await page.waitForTimeout(300);
show('悬停后', await snapshot());

await page.evaluate(() => { window.__log = []; });
await page.mouse.down();
await page.waitForTimeout(120);
show('按下后', await snapshot());
await page.mouse.up();
await page.waitForTimeout(900);
const after = await snapshot();
show('抬起 + 800ms 后', after);

const log = await page.evaluate(() => window.__log);
console.log('\n=== 事件 / 调用顺序 ===');
log.forEach((l) => console.log('  ' + l));

console.log('\n=== 位移 ===');
const moved = before.nodes.map((b) => {
  const a = after.nodes.find((n) => n.id === b.id);
  return a ? { id: b.id, dx: a.x - b.x, dy: a.y - b.y, dw: a.w - b.w } : { id: b.id, gone: true };
});
moved.forEach((m) => console.log('  ', JSON.stringify(m)));

await page.screenshot({ path: path.join(__dirname, '..', 'screenshots', '_probe_drift.png') });
await browser.close();
