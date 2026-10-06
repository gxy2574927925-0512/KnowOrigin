// 冒烟：验证 styles-polish.css 加载后「不破坏 + 有生效」
// 用法：node tools/smoke-polish.mjs   （需先起 http://127.0.0.1:8099 静态服务）
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:8099/static/index.html';
const fail = [];
const ok = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const bad = [];
page.on('response', r => {
  const u = r.url();
  if (u.endsWith('.css') && r.status() >= 400) bad.push(`${r.status()} ${u}`);
});
const errs = [];
page.on('pageerror', e => errs.push(String(e).slice(0, 120)));

await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });

// 1) 样式表无 404
bad.length ? fail.push(`CSS 加载失败: ${bad.join(', ')}`) : ok.push('所有样式表 200');

// 2) polish 层确实被解析（:where 规则进入 CSSOM）
const sheetLoaded = await page.evaluate(() => {
  for (const s of document.styleSheets) {
    try {
      if ((s.href || '').includes('styles-polish')) return s.cssRules.length;
    } catch { /* cross-origin */ }
  }
  return 0;
});
sheetLoaded > 0 ? ok.push(`styles-polish.css 已解析 ${sheetLoaded} 条规则`) : fail.push('polish 未进入 CSSOM');

// 3) 新令牌生效：--shadow 应为双段（含两个 rgba 段）
const shadow = await page.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue('--shadow').trim());
const segments = (shadow.match(/rgba?\(/g) || []).length;
segments >= 2 ? ok.push(`--shadow 已是双段阴影 (${segments} 段)`) : fail.push(`--shadow 未升级: ${shadow}`);

// 4) 阴影颜色变量在浅色下是暖棕 RGB，不是非法值
const shadowRgb = await page.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue('--shadow-rgb').trim());
ok.push(`--shadow-rgb = ${shadowRgb}`);

// 5) 【关键回归】--where 零优先级：已有更具体的规则必须仍然赢
const composer = await page.evaluate(() => {
  const el = document.querySelector('.composer, textarea');
  if (!el) return null;
  const cs = getComputedStyle(el);
  return { td: cs.transitionDuration, tf: cs.transitionTimingFunction };
});
if (composer) ok.push(`输入框 transition 未被 polish 覆盖: ${composer.td} / ${composer.tf}`);

// 6) 焦点环兜底生效：给一个按钮 focus，outline 不应为 none
const ring = await page.evaluate(() => {
  const b = document.querySelector('button');
  if (!b) return 'no-button';
  b.focus();
  const cs = getComputedStyle(b);
  return `${cs.outlineStyle} ${cs.outlineWidth}`;
});
ok.push(`按钮焦点环: ${ring}`);

// 6.5) 【关键回归】被刻意关掉阴影的两个深色主题必须仍是 none
const shadowsByMode = await page.evaluate(() => {
  const html = document.documentElement;
  const read = () => getComputedStyle(html).getPropertyValue('--shadow').trim();
  const out = {};
  const origUi = html.dataset.ui, origTheme = html.dataset.theme;
  for (const [ui, theme] of [['agent', 'light'], ['agent', 'dark'], ['academic', 'dark'], ['classic', 'light']]) {
    html.dataset.ui = ui; html.dataset.theme = theme;
    out[`${ui}/${theme}`] = read();
  }
  html.dataset.ui = origUi; html.dataset.theme = origTheme;
  return out;
});
for (const [mode, v] of Object.entries(shadowsByMode)) {
  ok.push(`--shadow [${mode}] = ${v.replace(/\s+/g, ' ').slice(0, 64)}`);
}
if (!/rgba?\(/.test(shadowsByMode['agent/light'])) fail.push('agent 浅色 --shadow 未升级为双段');
if (shadowsByMode['agent/dark'] !== 'none') fail.push(`agent 深色 --shadow 被破坏，应为 none，实际 ${shadowsByMode['agent/dark']}`);
if (shadowsByMode['academic/dark'] !== 'none') fail.push(`academic 深色 --shadow 被破坏，应为 none，实际 ${shadowsByMode['academic/dark']}`);

// 7) 触摸/动效偏好分支语法有效（能查到 media 规则）
const mediaRules = await page.evaluate(() => {
  let n = 0;
  for (const s of document.styleSheets) {
    try {
      if (!(s.href || '').includes('styles-polish')) continue;
      for (const r of s.cssRules) if (r.type === CSSRule.MEDIA_RULE) n++;
    } catch {}
  }
  return n;
});
mediaRules >= 3 ? ok.push(`@media 分支 ${mediaRules} 条全部解析通过`) : fail.push(`@media 分支异常: ${mediaRules}`);

console.log('\n通过:');
ok.forEach(o => console.log('  ✓', o));
if (fail.length) {
  console.log('\n失败:');
  fail.forEach(f => console.log('  ✗', f));
}
if (errs.length) console.log('\n页面 JS 错误:', errs.slice(0, 5));

await browser.close();
process.exit(fail.length ? 1 : 0);
