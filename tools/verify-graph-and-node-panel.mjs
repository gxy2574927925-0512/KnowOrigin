// 验证图谱 bug 修复 + 节点面板改版实装
// 用法：node tools/verify-graph-and-node-panel.mjs
import { chromium } from 'playwright';

const URL = process.env.KO_URL || 'http://127.0.0.1:17321/static/index.html';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
// 禁掉 HTTP 缓存 —— 否则改完 app.js 仍会读到旧版本，验证结果不可信（踩过）。
await page.route('**/static/app.js*', route => route.continue({ headers: { ...route.request().headers(), 'cache-control': 'no-cache' } }));

const issues = [];
const ok = [];
page.on('pageerror', e => issues.push(`pageerror: ${String(e).slice(0, 120)}`));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForFunction(() => typeof window.buildFrameworkLayout === 'function' || document.readyState === 'complete', { timeout: 30000 }).catch(() => {});

// 直接调用 buildFrameworkLayout 跑一遍 fixture
const fixture = await page.evaluate(() => {
  if (typeof buildFrameworkLayout !== 'function') {
    return { error: 'buildFrameworkLayout not on window' };
  }
  const nodes = [
    { node_id: 'root', name: '激光原理', parent_id: null, mastery_score: 0.4, learning_status: 'learning' },
    { node_id: 'a', name: '光的基础', parent_id: 'root', mastery_score: 0.2, learning_status: 'encountered' },
    { node_id: 'b', name: '推动齿在左边的齿', parent_id: 'a', mastery_score: 0.1, learning_status: 'unexplored' },
    { node_id: 'c', name: '未探索', parent_id: 'a', mastery_score: 0.0, learning_status: 'unexplored' },
    { node_id: 'd', name: '待确认/学习', parent_id: 'a', mastery_score: 0.3, learning_status: 'pending_confirmation' },
    { node_id: 'r1', name: '右支1', parent_id: 'root', mastery_score: 0.6, learning_status: 'learning' },
  ];
  const layout = buildFrameworkLayout(nodes);
  const points = [];
  nodes.forEach(n => {
    const p = layout.positions.get(n.node_id);
    if (p) points.push({ id: n.node_id, name: n.name, x: p.x, y: p.y });
  });
  return {
    viewportWidth: layout.viewportWidth,
    viewportHeight: layout.viewportHeight,
    points,
  };
});

if (fixture.error) {
  issues.push(fixture.error);
} else {
  console.log('viewport:', fixture.viewportWidth, 'x', fixture.viewportHeight);
  fixture.points.forEach(p => {
    const inX = p.x >= 0 && p.x + 188 <= fixture.viewportWidth;
    const inY = p.y >= 0 && p.y + 64 <= fixture.viewportHeight;
    const mark = inX && inY ? '✓' : '✗';
    if (inX && inY) ok.push(`${mark} ${p.name}  (${p.x.toFixed(0)}, ${p.y.toFixed(0)})`);
    else issues.push(`${mark} OUT: ${p.name}  (${p.x.toFixed(0)}, ${p.y.toFixed(0)})  viewport=${fixture.viewportWidth}x${fixture.viewportHeight}`);
  });
}

console.log('\n=== 节点位置（应全部在 viewport 内）===');
ok.forEach(o => console.log('  ', o));
if (issues.length) {
  console.log('\n=== 问题 ===');
  issues.forEach(i => console.log('  ', i));
}

await browser.close();
process.exit(issues.length ? 1 : 0);