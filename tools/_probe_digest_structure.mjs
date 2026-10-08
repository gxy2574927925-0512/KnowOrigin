// 收获结构真实生成验证：拿一本已导入真全文的书跑一次 digest，看新结构是否落地。
// 跑法：node tools/_probe_digest_structure.mjs
const BASE = 'http://127.0.0.1:17321';
const EMAIL = 'ui-probe-reading@example.com';
const PASS = 'ui-probe-reading-1234';

let r = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASS }),
});
if (!r.ok) {
  r = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  });
}
const cookie = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map(c => c.split(';')[0]).join('; ');
console.log('登录状态', r.status);

const books = await (await fetch(`${BASE}/api/reading/books`, { headers: { cookie } })).json();
const target = (books.books || []).find(b => b.has_fulltext && b.source === 'standardebooks');
if (!target) { console.log('没有已导入全文的 SE 书，先跑 _probe_reading_ui.mjs'); process.exit(1); }
console.log('目标书：', target.title, '｜', target.book_key, '｜全文标记', target.has_fulltext);

const outline = await (await fetch(`${BASE}/api/reading/books/${target.book_key}/outline`, { headers: { cookie } })).json();
console.log('阅读页视图：', outline.kind, '｜正文块数：', (outline.sources || []).length);

console.log('正在生成收获（真实模型调用，可能要 1~2 分钟）…');
const t0 = Date.now();
const res = await fetch(`${BASE}/api/reading/books/${target.book_key}/digest`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
  body: JSON.stringify({}),
});
const body = await res.json();
console.log(`digest 状态 ${res.status}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，fallback=${body.fallback}，insufficient=${body.insufficient}`);

const md = (body.doc && body.doc.content_md) || '';
const struct = (body.doc && body.doc.content) || {};
const headings = md.split('\n').filter(l => l.startsWith('## ')).map(l => l.replace(/^##\s*/, ''));
console.log('\n小节：');
headings.forEach(h => console.log('  ·', h));
console.log('\njudgment 字段：', JSON.stringify(struct.judgment, null, 1));
console.log('critique 条数：', (struct.critique || []).length);
console.log('spine 条数：', (struct.spine || []).length, '｜chapters 条数：', (struct.chapters || []).length);

const hasJudgment = headings.some(h => h.includes('我的判断'));
const hasCritique = headings.some(h => h.includes('边界与反例'));
console.log('\n结论：', hasJudgment ? '✅ 有「我的判断」' : '❌ 缺「我的判断」',
  '｜', hasCritique ? '✅ 有「边界与反例」' : '❌ 缺「边界与反例」');
if (hasJudgment) {
  const at = md.indexOf('我的判断');
  console.log('\n——「我的判断」小节原文 ——\n' + md.slice(at - 4, at + 420));
}
