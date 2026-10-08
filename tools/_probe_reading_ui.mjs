// 读书 UI 验证：跨书源搜索的文件链接/取正文/找链接、阅读页的自动取正文与文件链接。
// 跑法：node tools/_probe_reading_ui.mjs   （需要应用已在 17321 运行）
//
// 用**独立测试账号**，不碰真实用户的书架。
// 搜索用注入响应（确定性，能一次覆盖三种状态）；正文走**真实网络**（SE 单页全文）。
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'http://127.0.0.1:17321';
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'screenshots');
const EMAIL = 'ui-probe-reading@example.com';
const PASS = 'ui-probe-reading-1234';

let FAIL = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) FAIL += 1; };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 2 });

// 注册（已存在则登录）—— 独立账号，书架空着开始
let r = await ctx.request.post(`${BASE}/api/auth/register`, { data: { email: EMAIL, password: PASS } });
if (r.status() === 409) r = await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: EMAIL, password: PASS } });
ok(r.ok(), `测试账号就绪（${r.status()}）`);

const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e.message).slice(0, 160)));
page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });

// 注入搜索响应：一次覆盖「有全文+多格式文件链接」「只有借阅链接」「纯元数据 + 海外源被跳过」
await page.route('**/api/reading/search', route => route.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({
    query: 'pride',
    results: [
      { source: 'standardebooks', source_name: 'Standard Ebooks', source_id: 'jane-austen/pride-and-prejudice',
        title: 'Pride and Prejudice', author: 'Jane Austen', year: '1813', rights: 'public-domain',
        has_fulltext: true, fulltext_format: 'text', category: '文学小说', cover: '',
        download_url: 'https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice/text/single-page',
        read_url: 'https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice/text/single-page',
        files: [
          { format: 'text', url: 'https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice/text/single-page', label: '在线阅读（全文）' },
          { format: 'epub', url: 'https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice/downloads/jane-austen_pride-and-prejudice.epub', label: '下载 EPUB' },
          { format: 'azw3', url: 'https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice/downloads/jane-austen_pride-and-prejudice.azw3', label: '下载 AZW3（Kindle）' },
        ] },
      { source: 'openlibrary', source_name: 'Open Library', source_id: 'OL2W', title: 'A Borrowable Modern Book',
        author: 'Someone', rights: 'licensed', has_fulltext: false, category: '其他', cover: '',
        borrow_url: 'https://openlibrary.org/works/OL2W',
        files: [{ format: 'borrow', url: 'https://openlibrary.org/works/OL2W', label: '借阅（需登录）' }] },
      { source: 'douban', source_name: '豆瓣读书', source_id: '1', title: '只有元数据的书', author: '某某',
        rights: 'unknown', has_fulltext: false, category: '其他', cover: '', files: [] },
    ],
    sources: { standardebooks: 1, openlibrary: 1, douban: 1 },
    source_status: {
      standardebooks: { count: 1, ok: true, error: '' },
      openlibrary: { count: 1, ok: true, error: '' },
      douban: { count: 1, ok: true, error: '' },
      gutenberg: { count: 0, ok: false, skipped: true, error: '需要代理：未配置 TJU_PROXY_URL，已跳过（避免整轮搜索空等）' },
      archive: { count: 0, ok: false, skipped: true, error: '需要代理：未配置 TJU_PROXY_URL，已跳过（避免整轮搜索空等）' },
    },
    all_failed: false,
    blocked_sources: ['gutenberg', 'archive', 'openlibrary', 'wikisource', 'googlebooks'],
    proxy_in_use: false,
    summary: { total: 3, fulltext: 1, with_links: 2, metadata_only: 0 },
  }),
}));

await page.goto(`${BASE}/`, { waitUntil: 'load' });
await page.waitForFunction(() => document.documentElement.dataset.sessionReady === '1', { timeout: 30000 }).catch(() => {});
// 全新账号进来会自动弹「建立独立项目」对话框，会挡住点击 —— 先关掉它
// （与 tools/verify_reading_login_fix.mjs 同一处理）。
await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => { try { d.close(); } catch { /* ignore */ } }));
await page.waitForTimeout(300);

// ① 打开读书工作区
await page.evaluate(() => window.KnowOriginReading.open());
await page.waitForTimeout(1500);
await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => { try { d.close(); } catch { /* ignore */ } }));
const wsVisible = await page.evaluate(() => {
  const el = document.getElementById('reading-workspace');
  return !!el && !el.classList.contains('hidden');
});
ok(wsVisible, '读书工作区打开');

// ② 搜索并截图（覆盖文件链接 / 取正文 / 找链接 / 代理提示）
await page.fill('[data-rd-query]', 'pride');
await page.click('[data-rd-search]');
await page.waitForSelector('.rd-hit', { timeout: 10000 });
await page.waitForTimeout(400);

const ui = await page.evaluate(() => {
  const hits = Array.from(document.querySelectorAll('.rd-hit'));
  const notes = Array.from(document.querySelectorAll('[data-rd-hits] .rd-src-note'));
  return {
    hits: hits.length,
    fileChips: document.querySelectorAll('[data-rd-hits] .rd-file').length,
    fetchBtns: document.querySelectorAll('[data-rd-hitfetch]').length,
    linkBtns: document.querySelectorAll('[data-rd-hitlinksbtn]').length,
    proxyHint: (notes.find(n => /需要代理/.test(n.textContent)) || {}).textContent || '',
    chipText: Array.from(document.querySelectorAll('[data-rd-hits] .rd-file')).map(a => a.textContent.trim()),
    // 「借阅」只该出一颗：files 里那条与 borrow_url 是同一条，不能重复渲染
    borrowChips: Array.from(document.querySelectorAll('[data-rd-hits] .rd-file'))
      .filter(a => /借阅/.test(a.textContent)).length,
    // 操作区不能被行高截断：按钮底部必须落在所在行的范围内
    clipped: hits.filter(h => {
      const act = h.querySelector('.rd-hit-act');
      if (!act) return true;
      const a = act.getBoundingClientRect(), r = h.getBoundingClientRect();
      return a.bottom > r.bottom + 1 || a.top < r.top - 1;
    }).length,
  };
});
ok(ui.hits === 3, `渲染 3 条命中（实际 ${ui.hits}）`);
ok(ui.fileChips >= 4, `文件链接胶囊渲染（${ui.fileChips} 个：${ui.chipText.slice(0, 5).join(' / ')}）`);
ok(ui.fetchBtns === 1, `只有可自动取正文的那条出现「取正文」（实际 ${ui.fetchBtns}）`);
ok(ui.linkBtns === 3, `每条都有「找链接」（实际 ${ui.linkBtns}）`);
ok(ui.proxyHint.includes('需要代理'), `代理提示如实显示：「${ui.proxyHint.slice(0, 60)}…」`);
ok(ui.borrowChips === 1, `借阅胶囊不重复（实际 ${ui.borrowChips} 个）`);
ok(ui.clipped === 0, `操作按钮没有被行高截断（溢出 ${ui.clipped} 行）`);

await page.screenshot({ path: path.join(OUT, 'reading-ui-search.png'), clip: { x: 0, y: 0, width: 1440, height: 980 } });
await page.locator('[data-rd-hits]').screenshot({ path: path.join(OUT, 'reading-ui-hits.png') }).catch(() => {});

// ③ 「找链接」按钮 → 面板里出链接（注入响应，避免真实网络等待）
await page.route('**/api/reading/links', route => route.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({
    ok: true, checked: ['hathitrust'], proxy_in_use: false,
    links: [
      { label: 'HathiTrust 阅读', url: 'https://babel.hathitrust.org/cgi/pt?id=x', format: 'read', note: '公版，可全文阅读' },
      { label: 'HathiTrust 书目', url: 'https://catalog.hathitrust.org/Record/1', format: 'catalog', note: '馆藏与版本信息' },
    ],
  }),
}));
await page.click('[data-rd-hitlinksbtn="2"]');
await page.waitForTimeout(700);
const panel = await page.evaluate(() => {
  const host = document.querySelector('[data-rd-hitlinks="2"]');
  return { html: host ? host.innerHTML.length : 0, chips: host ? host.querySelectorAll('.rd-file').length : 0, text: host ? host.textContent.trim().slice(0, 60) : '' };
});
ok(panel.chips === 2, `找链接结果渲染成胶囊（${panel.chips} 个：${panel.text}）`);
await page.locator('[data-rd-hits]').screenshot({ path: path.join(OUT, 'reading-ui-links.png') }).catch(() => {});

// ④ 真实网络：加入书架 → 阅读页 → 自动获取正文
const realKey = await page.evaluate(async () => {
  const rec = {
    source: 'standardebooks', source_id: 'jane-austen/pride-and-prejudice',
    title: 'Pride and Prejudice', author: 'Jane Austen',
    rights: 'public-domain', has_fulltext: true, fulltext_format: 'text',
    download_url: 'https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice/text/single-page',
    read_url: 'https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice/text/single-page',
    files: [
      { format: 'text', url: 'https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice/text/single-page', label: '在线阅读（全文）' },
      { format: 'epub', url: 'https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice/downloads/jane-austen_pride-and-prejudice.epub', label: '下载 EPUB' },
    ],
  };
  const res = await fetch('/api/reading/books', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ book: rec }) });
  const data = await res.json();
  return data.book && data.book.book_key;
});
ok(!!realKey, `真实书入架（book_key=${String(realKey).slice(0, 10)}…）`);

await page.evaluate(k => window.KnowOriginReading.openBook(k), realKey);
await page.waitForSelector('[data-rd-booklinksbtn]', { timeout: 15000 });
const bookUi = await page.evaluate(() => ({
  hasFetch: !!document.querySelector('[data-rd-fetchtext]'),
  hasLinks: !!document.querySelector('[data-rd-booklinksbtn]'),
  chips: document.querySelectorAll('.rd-files .rd-file').length,
  alreadyFulltext: /这本书的正文已导入项目/.test(document.querySelector('[data-rd-digest]').textContent),
}));
ok(bookUi.hasLinks, '阅读页出现「找文件链接」');
ok(bookUi.chips >= 2, `阅读页显示文件链接（${bookUi.chips} 个）`);
await page.screenshot({ path: path.join(OUT, 'reading-ui-book.png'), clip: { x: 0, y: 0, width: 1440, height: 980 } });

if (bookUi.hasFetch) {
  ok(true, '阅读页出现「自动获取正文」');
  console.log('  … 正在真实获取整本正文（约 25 秒）');
  await page.click('[data-rd-fetchtext]');
  const fetched = await page.waitForFunction(
    () => /这本书的正文已导入项目/.test(document.querySelector('[data-rd-digest]').textContent),
    { timeout: 90000 }
  ).then(() => true).catch(() => false);
  await page.waitForTimeout(1200);
  ok(fetched, '取正文后阅读页切到「正文」视图（真实网络）');
} else {
  // 幂等：同一本书第二次跑时正文已经在了，按钮**理应消失** —— 这本身就是要验证的行为。
  ok(bookUi.alreadyFulltext, '正文已在项目里 → 「自动获取正文」按钮正确隐藏，阅读页显示真全文');
}

const afterFetch = await page.evaluate(() => {
  const host = document.querySelector('[data-rd-digest]');
  const text = host ? host.textContent : '';
  return {
    chars: (text.match(/(\d{4,})\s*字/) || [])[1] || '',
    outlines: document.querySelectorAll('.rd-outline').length,
    hasSourceCard: /Pride and Prejudice/.test(text),
  };
});
ok(afterFetch.outlines >= 1 && afterFetch.hasSourceCard, '阅读页渲染出正文区块');
console.log(`     阅读页字数：${afterFetch.chars} 字，区块数 ${afterFetch.outlines}`);
await page.screenshot({ path: path.join(OUT, 'reading-ui-fulltext.png'), clip: { x: 0, y: 0, width: 1440, height: 980 } });

ok(errs.length === 0, `无 JS 报错${errs.length ? '：' + errs[0] : ''}`);

await browser.close();
console.log(FAIL ? `\n${FAIL} 项未过` : '\n全部通过');
process.exit(FAIL ? 1 : 0);
