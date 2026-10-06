/**
 * Agent 工作台「真实计算样式」量测 —— 用 Edge + CDP 打开真页面，量 getComputedStyle。
 *
 * 为什么要这个：配色问题静态看 CSS 永远说不清。之前两次误判都是同一个教训 ——
 *   1. 「令牌覆盖了 → 界面应该是冷的」：其实有 139 条字面绿，令牌管不到；
 *   2. 「选择器写对了 → 元素应该可见」：其实那个 class 在项目里根本不存在。
 * 只有真的渲染出来量，才能知道「用户屏幕上到底是什么颜色」。
 *
 * 同时量三件非颜色的事：
 *   - 返回对话按钮是否真的可见（有 rect、不被遮挡）；
 *   - #studio-output 与 #en-vocab-view 是否抢同一个格子（矩形相交 = 重叠）；
 *   - 每个功能页各截图，供人眼复核。
 *
 * 用法（一般由 tools/verify_agent_visual.py 调用）：
 *   KNOWORIGIN_BASE=http://127.0.0.1:PORT \
 *   KNOWORIGIN_COOKIE=knoworigin_session=xxx \
 *   KNOWORIGIN_SHOT_DIR=out \
 *   node tools/measure_agent_ui.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = process.env.KNOWORIGIN_EDGE
  || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = process.env.KNOWORIGIN_BASE;
const COOKIE = process.env.KNOWORIGIN_COOKIE;
const SHOT_DIR = process.env.KNOWORIGIN_SHOT_DIR || "tmp-shots";
const PORT = Number(process.env.KNOWORIGIN_CDP_PORT || 9334);
const OUT = process.env.KNOWORIGIN_OUT || "";

if (!BASE || !COOKIE) {
  console.error("缺少 KNOWORIGIN_BASE / KNOWORIGIN_COOKIE");
  process.exit(2);
}
mkdirSync(SHOT_DIR, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), "ko-edge-"));
const child = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "--force-device-scale-factor=1",
  "--window-size=1600,900", `--user-data-dir=${profile}`,
  `--remote-debugging-port=${PORT}`, "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
let seq = 0;
const pending = new Map();

function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  // 必须用 async IIFE：页面内的体检代码要 await 下一帧（scrollIntoView 之后才能量位置），
  // 普通函数里 await 是语法错误。配合 awaitPromise:true 取回结果。
  const r = await send("Runtime.evaluate", {
    expression: `(async () => { ${expression} })()`,
    returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(`页面内异常: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  }
  return r.result.value;
}

/* ---------- 页面内脚本 ---------- */

// 可见元素 + 它的计算色。cssText 的 rgba 逗号写法要留，不能用 css 颜色解析（会丢 alpha）。
const SCAN = `
  const parse = (v) => {
    const m = String(v || '').match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(/[,\\s\\/]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.some(Number.isNaN)) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const sel = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = (el.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean).slice(0, 3);
    if (cls.length) s += '.' + cls.join('.');
    return s;
  };
  const visible = (el, cs) => {
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (Number(cs.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const scope = document.querySelector('#studio-panel.studio-focus') || document.body;
  const out = [];
  scope.querySelectorAll('*').forEach((el) => {
    const cs = getComputedStyle(el);
    if (!visible(el, cs)) return;
    const rect = el.getBoundingClientRect();
    const item = {
      sel: sel(el), rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      area: Math.round(rect.width * rect.height),
    };
    item.colors = {
      background: cs.backgroundColor,
      color: cs.color,
      borderTop: cs.borderTopColor, borderLeft: cs.borderLeftColor,
      boxShadow: cs.boxShadow, outline: cs.outlineColor,
    };
    // 渐变/图片背景在 backgroundColor 里是 transparent，真实颜色藏在 backgroundImage
    const bgi = cs.backgroundImage;
    if (bgi && bgi !== 'none' && /gradient/.test(bgi)) item.gradients = bgi;
    out.push(item);
  });
  return out;
`;

const geom = `
  const pick = (id) => {
    const el = document.getElementById(id);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      id, display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
  };
  const back = document.getElementById('studio-expand-button');
  let backInfo = null;
  if (back) {
    const cs = getComputedStyle(back);
    const r = back.getBoundingClientRect();
    // 命中测试：按钮中心点最上面的元素是不是它自己/它的后代
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    backInfo = {
      text: (back.innerText || '').trim(),
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      hitSelf: !!(hit && (hit === back || back.contains(hit))),
      hitTag: hit ? hit.tagName.toLowerCase() + '.' + (hit.getAttribute('class') || '').split(/\\s+/)[0] : null,
    };
  }
  return {
    output: pick('studio-output'), envocab: pick('en-vocab-view'), heading: pick('studio-title'),
    // 学习产出浮层整块（不是标题）：用来量它占了多大、会不会压到左栏
    panel: pick('studio-panel'),
    rail: pick('agent-rail'), sessions: pick('agent-sessions'),
    back: backInfo,
  };
`;

const GEOM = geom;

function overlap(a, b) {
  if (!a || !b) return null;
  const ax = a.rect.x, ay = a.rect.y, aw = a.rect.w, ah = a.rect.h;
  const bx = b.rect.x, by = b.rect.y, bw = b.rect.w, bh = b.rect.h;
  const w = Math.min(ax + aw, bx + bw) - Math.max(ax, bx);
  const h = Math.min(ay + ah, by + bh) - Math.max(ay, by);
  if (w <= 1 || h <= 1) return { overlapArea: 0 };
  return { overlapArea: Math.round(w * h), overlapPx: `${w}x${h}` };
}

/* ---------- 走查 ---------- */
const clickRail = (attr, value) =>
  `document.querySelector('#agent-rail [${attr}="${value}"]').click(); return true;`;

const views = [
  { key: "cards", open: clickRail("data-agent-feature", "cards"), contrast: true },
  { key: "quiz", open: clickRail("data-agent-feature", "quiz") },
  { key: "favorites", open: clickRail("data-agent-feature", "favorites") },
  { key: "framework", open: clickRail("data-agent-feature", "framework") },
  { key: "english", open: clickRail("data-agent-module", "english") },
  // 提议型卡片（plan_study_action）单独验：它不在产出浮层里，而是在对话区的气泡内。
  { key: "offer", open: clickRail("data-agent-feature", "framework"), offer: true },
  // 深色模式下的卡片题面：真机反馈「看不清」，这里量对比度而不是靠眼睛
  { key: "cards-dark", open: clickRail("data-agent-feature", "cards"), theme: "dark", contrast: true },
];

/* 对比度探针：取卡片题面文字与其最近的不透明祖先背景，算 WCAG 对比度。
   「看不清」是能测的 —— 深色主题下 --green-soft 是深底色，拿它当字色
   就是深底深字，肉眼明显但静态看 CSS 完全正常。 */
/* classic 配色回退探针：采集几个"原始是暖色字面值"的元素，看它们现在的实际渲染色。
   回退层把 #f3eee4 / #a9c39f 这类值写回了 CSS，这里确认浏览器真的算出了暖色，
   而不是仍在用 :root 的通用值。 */
const PALETTE_PROBE = `
  const parse = (v) => {
    const m = String(v || '').match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(/[,\\s\\/]+/).filter(Boolean).map(Number);
    return p.length >= 3 ? { r: p[0], g: p[1], b: p[2] } : null;
  };
  // 暖 = r 明显高于 b；academic 的冷蓝 --green 是 rgb(56,103,214)，b 远高于 r
  const isWarm = (c) => c && c.r > c.b + 6;
  const targets = [
    ['.sources-panel', 'backgroundColor'],
    ['.message > div', 'backgroundColor'],
    ['.source-import-progress-track', 'backgroundColor'],
    ['.panel-resizer', 'borderLeftColor'],
    ['.citation-chip', 'borderTopColor'],
  ];
  const out = [];
  for (const [sel, prop] of targets) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const raw = getComputedStyle(el)[prop];
    const rgb = parse(raw);
    if (rgb && isWarm(rgb)) out.push([sel, raw]);
  }
  return { warm: out, ui: document.documentElement.getAttribute('data-ui'),
           theme: document.documentElement.getAttribute('data-theme') };
`;
const CONTRAST_PROBE = `
  const parse = (v) => {
    const m = String(v || '').match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(/[,\\s\\/]+/).filter(Boolean).map(Number);
    return p.length >= 3 ? { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 } : null;
  };
  const lum = ({ r, g, b }) => {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1,
  });
  const bgOf = (el) => {
    let node = el;
    while (node && node !== document.documentElement) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0.85) return c;
      node = node.parentElement;
    }
    return parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
  };
  const ratio = (el) => {
    const fg = parse(getComputedStyle(el).color);
    if (!fg) return null;
    const bg = bgOf(el);
    const l1 = lum(over(fg, bg));
    const l2 = lum(bg);
    const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };
  const targets = [
    ["卡片题面", ".card .study-title-line strong"],
    ["卡片分类难度", ".card .count-pill"],
    ["卡片提示", ".card .flip-card-cue"],
    ["翻面按钮", ".card .flip-cue-btn"],
    ["顶栏标题", "#studio-title"],
  ];
  const items = [];
  for (const [label, sel] of targets) {
    const el = document.querySelector(sel);
    if (!el) { items.push({ label, sel, missing: true }); continue; }
    items.push({ label, sel, ratio: ratio(el), color: getComputedStyle(el).color });
  }
  return { theme: document.documentElement.dataset.theme || "light", items };
`;

/* 提议型卡片的体检：把两段真实的 staged action 灌进渲染函数，看卡片结构、选项是否真渲染出来、
   是否可点（elementFromPoint 命中自己）、以及文案对不对。
   直接调 agentActionCardMarkup —— 它是纯函数，不需要真发一轮对话（那要网关 key）。
   两段是刻意分开的：**带 node** 的走生成族（要靠 node_id 调端点），
   **不带 node** 的走跳转族（项目级选项）。合成一段量不出第二条分支对不对 ——
   而「跳转族不该被 node 门槛挡住、生成族缺 node 就整条不渲染」正是那次改动的要害。
   两段各挂各的 host：两张卡叠在一起超过视口高度时，scrollIntoView 会把第一张卡的
   顶部顶出视口，于是量出一堆假的「不可点」，把真实缺陷淹掉。 */
const OFFER_PROBE = `
  const GEN_KINDS = ["card", "quiz", "doc", "cheatsheet", "learning_path", "checklist", "focus"];
  const JUMP_KINDS = ["view_cards", "view_cheatsheet", "view_learning_path", "view_checklist"];
  const mk = (args, label) => agentActionCardMarkup([{ tool: "plan_study_action", arguments: args, label }]);
  const genHost = document.createElement("div");
  genHost.id = "offer-probe";
  genHost.innerHTML = mk(
    { node_id: "node_probe", node_name: "康普顿散射", kinds: GEN_KINDS, reason: "掌握度只有 20%" },
    "针对「康普顿散射」：" + GEN_KINDS.join(" / "),
  );
  const jumpHost = document.createElement("div");
  jumpHost.id = "jump-probe";
  jumpHost.innerHTML = mk(
    { node_id: "", node_name: "", kinds: JUMP_KINDS, reason: "你上次问过它在哪" },
    "看知识卡片 / 看一页速查表 / 看学习路径 / 看清单报告",
  );
  document.querySelector("#conversation")?.append(genHost, jumpHost);
  // 必须先滚进视口再量：对话区在页面下方，落在视口外时 elementFromPoint 返回 null，
  // 会被误判成「不可点」。
  genHost.scrollIntoView({ block: "center" });
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const pick = (node) => ({
    text: (node?.innerText || "").trim(),
    color: node ? getComputedStyle(node).color : null,
    bg: node ? getComputedStyle(node).backgroundColor : null,
    radius: node ? getComputedStyle(node).borderTopLeftRadius : null,
    w: node ? Math.round(node.getBoundingClientRect().width) : 0,
    h: node ? Math.round(node.getBoundingClientRect().height) : 0,
  });
  const scanOptions = (card) => {
    // 选项列表自己带 max-height + overflow，末尾几项会被裁掉。
    // getBoundingClientRect() 不反映祖先裁剪 —— 被裁掉的项照样报告一个视口内的
    // rect，于是 elementFromPoint 必然命中不到，先前会把它们误判成「不可点」。
    // 所以 visible 必须同时过「视口内」与「未被 ul 裁剪」两道。
    const listRect = card?.querySelector(".agent-action-list")?.getBoundingClientRect() || null;
    return [...(card?.querySelectorAll("[data-agent-action-row]") || [])].map((li) => {
      const label = li.querySelector(".agent-action-option");
      const input = li.querySelector("[data-agent-action-check]");
      const box = li.querySelector(".agent-action-box");
      const r = label.getBoundingClientRect();
      const inView = r.top >= 0 && r.bottom <= window.innerHeight
        && r.left >= 0 && r.right <= window.innerWidth;
      const notClipped = !listRect
        || (r.top >= listRect.top - 1 && r.bottom <= listRect.bottom + 1);
      const visible = inView && notClipped;
      const hit = visible
        ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
        : null;
      return {
        kind: li.dataset.agentOfferKind || "write",
        node: li.dataset.agentOfferNode || "",
        checked: Boolean(input?.checked),
        label: (li.querySelector(".agent-action-label")?.innerText || "").trim(),
        desc: (li.querySelector(".agent-action-desc")?.innerText || "").trim(),
        w: Math.round(r.width), h: Math.round(r.height),
        inView, visible,
        hitSelf: !!(hit && (hit === label || label.contains(hit) || li.contains(hit))),
        hitTag: hit ? hit.tagName.toLowerCase() + '.' + (hit.getAttribute('class') || '').split(/\\s+/).slice(0,2).join('.') : null,
        cold: (() => {
          const cs = getComputedStyle(label);
          const bs = getComputedStyle(box || label);
          return { bg: cs.backgroundColor, color: cs.color, mark: bs.borderTopColor };
        })(),
      };
    });
  };
  const gen = genHost.querySelector(".agent-action-card");
  const jump = jumpHost.querySelector(".agent-action-card");
  const vocab = document.getElementById("en-vocab-view");
  // 计数是「已选几项 / 共几项」的唯一常驻出口。innerText 有值不代表用户看得见：
  // 被 flex 挤出、被 overflow: clip 裁掉、或与背景同色，量测都只看到「有文字」。
  // 这里直接量它的几何与实际渲染色，交给断言判可见性。
  const measureChip = (card, sel) => {
    const el = card?.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const box = el.closest(".agent-action-shell")?.getBoundingClientRect();
    const inShell = !!box && r.left >= box.left - 1 && r.right <= box.right + 1 && r.bottom <= box.bottom + 1;
    // 有面积不等于看得见：可能被同位置的兄弟节点盖住。中心点打一次命中测试。
    const hit = inShell ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
    return {
      text: (el.innerText || "").trim(),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      color: cs.color, bg: cs.backgroundColor,
      inShell,
      visible: r.width > 3 && r.height > 3,
      // 命中自己或自己的后代 = 没被遮；命中别的元素就是被盖住了
      notCovered: !!(hit && (hit === el || el.contains(hit))),
      hitTag: hit ? hit.tagName.toLowerCase() + '.' + (hit.getAttribute('class') || '').split(/\\s+/).slice(0,2).join('.') : null,
    };
  };
  // 故意不 remove：截图要拍到这两张卡片，移除放到量测结束之后。
  return {
    head: pick(gen?.querySelector(".agent-action-head")),
    count: measureChip(gen, "[data-agent-action-count]"),
    caret: measureChip(gen, ".agent-action-caret"),
    countText: (gen?.querySelector("[data-agent-action-count]")?.innerText || "").trim(),
    shell: pick(gen?.querySelector(".agent-action-shell")),
    shellH: gen ? Math.round(gen.getBoundingClientRect().height) : 0,
    viewportH: window.innerHeight,
    rowW: Math.round(gen?.querySelector("[data-agent-action-row]")
      ?.getBoundingClientRect().width || 0),
    shellW: Math.round(gen?.querySelector(".agent-action-shell")
      ?.getBoundingClientRect().width || 0),
    listClipped: (() => {
      const el = gen?.querySelector(".agent-action-list");
      if (!el) return false;
      return el.scrollHeight > el.clientHeight + 1;
    })(),
    options: scanOptions(gen),
    jumpOptions: scanOptions(jump),
    jumpCount: (jump?.querySelector("[data-agent-action-count]")?.innerText || "").trim(),
    dismissText: (gen?.querySelector('[data-agent-action-dismiss]')?.innerText || '').trim(),
    runText: (gen?.querySelector('[data-agent-action-run]')?.innerText || '').trim(),
    stopHidden: Boolean(gen?.querySelector('[data-agent-action-stop]')?.hidden),
    runDisabled: Boolean(gen?.querySelector('[data-agent-action-run]')?.disabled),
    run: pick(gen?.querySelector("[data-agent-action-run]")),
    dismiss: pick(gen?.querySelector("[data-agent-action-dismiss]")),
    caretPick: pick(gen?.querySelector(".agent-action-caret")),
    html: genHost.innerHTML.length + jumpHost.innerHTML.length,
    closeFn: typeof window.enVocabCloseView,
    vocabClass: vocab ? vocab.className : null,
    vocabDisplay: vocab ? getComputedStyle(vocab).display : null,
  };
`;
const OFFER = OFFER_PROBE;

const report = { views: {}, errors: [] };

try {
  // 等 DevTools
  let version = null;
  for (let i = 0; i < 80 && !version; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) version = await r.json(); }
    catch (_) { /* retry */ }
    if (!version) await sleep(250);
  }
  if (!version) throw new Error("Edge DevTools 没起来");
  report.browser = version.Browser;

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("没有 page target");

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("ws 连接失败"));
  });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1600, height: 900, deviceScaleFactor: 1, mobile: false,
  });

  // localStorage 要在 app.js 之前写好，否则 UI 模式会先被读成默认值
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      try {
        localStorage.setItem("knoworigin-ui", "agent");
        localStorage.setItem("knoworigin-theme", "light");
        localStorage.setItem("knoworigin.chatAgent", "on");
      } catch (e) {}
    `,
  });
  const [cookieName, cookieValue] = COOKIE.split("=");
  await send("Network.setCookie", {
    name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/",
  });

  await send("Page.navigate", { url: BASE });
  // 等 app 就绪：app.js 跑完 init() 会置 data-session-ready
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(500);
    try { ready = await evaluate(`return document.documentElement.dataset.sessionReady === '1';`); }
    catch (_) { /* 还在导航 */ }
  }
  if (!ready) throw new Error("app 没就绪（data-session-ready 未置位）");
  report.ui = await evaluate(`return document.documentElement.getAttribute('data-ui');`);
  if (report.ui !== "agent") report.errors.push(`data-ui 不是 agent（是 ${report.ui}）`);

  for (const view of views) {
    const entry = { key: view.key };
    report.views[view.key] = entry;
    try {
      if (view.theme) {
        // 深色模式：直接切 data-theme（App 把主题写在 html 元素上）
        await evaluate(`
          document.documentElement.dataset.theme = ${JSON.stringify(view.theme)};
          return true;
        `);
        await sleep(300);
      }
      await evaluate(`${view.open} return true;`);
      await sleep(1500);
      if (view.offer) {
        // 必须收起整屏浮层才能量对话区里的卡片：浮层开着的时候它盖住整个视口，
        // 提议按钮的命中测试全都会打到浮层自己的元素上。
        // 用 collapseStudio 而不是点展开按钮（点按钮等于又把它展开）。
        await evaluate(`
          if (typeof collapseStudio === "function") collapseStudio();
          return true;
        `);
        await sleep(900);
        entry.offer = await evaluate(OFFER);
      }
      entry.elements = await evaluate(SCAN);
      entry.geom = await evaluate(GEOM);
      entry.overlap = overlap(entry.geom.output, entry.geom.envocab);
      entry.contrast = await evaluate(CONTRAST_PROBE);
      const shot = await send("Page.captureScreenshot", { format: "png" });
      if (shot?.data) {
        const file = join(SHOT_DIR, `agent-${view.key}.png`);
        writeFileSync(file, Buffer.from(shot.data, "base64"));
        entry.shot = file;
      }
      if (view.offer) {
        // 截图拍完再把注入的卡片拿走，别污染后面的量测
        await evaluate(`document.getElementById("offer-probe")?.remove(); return true;`);
      }
    } catch (error) {
      entry.error = error.message;
      report.errors.push(`${view.key}: ${error.message}`);
    }
  }

  // ---- classic 浅色：单独重新导航一次 ----
  // 切 data-ui 会让 app.js 重建整个 DOM（agent 壳层/左栏都不一样），所以不能像
  // view.theme 那样事后改属性，只能重走一遍导航。放在最后，避免打乱上面的视图。
  // 目的：验证 static/classic-palette.css 的配色回退层在真浏览器里生效，
  // 且还原后的暖色仍然满足 WCAG 对比度（可读性不能为了"看起来像原来"而牺牲）。
  try {
    const entry = { key: "cards-classic" };
    report.views["cards-classic"] = entry;
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `try {
        localStorage.setItem("knoworigin-ui", "classic");
        localStorage.setItem("knoworigin-theme", "light");
      } catch (e) {}`,
    });
    await send("Page.navigate", { url: BASE });
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      await sleep(500);
      try { ready = await evaluate(`return document.documentElement.dataset.sessionReady === '1';`); }
      catch (_) { /* 导航中 */ }
    }
    entry.ready = ready;
    entry.ui = await evaluate(`return document.documentElement.getAttribute('data-ui');`);
    entry.theme = await evaluate(`return document.documentElement.getAttribute('data-theme');`);
    if (entry.ui !== "classic") report.errors.push(`classic 视图 data-ui=${entry.ui}`);
    entry.elements = await evaluate(SCAN);
    entry.contrast = await evaluate(CONTRAST_PROBE);
    entry.palette = await evaluate(PALETTE_PROBE);
    const shot = await send("Page.captureScreenshot", { format: "png" });
    if (shot?.data) {
      const file = join(SHOT_DIR, "classic-light.png");
      writeFileSync(file, Buffer.from(shot.data, "base64"));
      entry.shot = file;
    }
  } catch (error) {
    report.errors.push(`cards-classic: ${error.message}`);
  }
} catch (error) {
  report.errors.push(error.message);
}

console.log(JSON.stringify(report, null, 2));
if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
try { ws?.close(); } catch (_) { /* ignore */ }
// ⚠️ Windows 上 child.kill() 只杀 Edge 的父进程，孙进程（渲染器/GPU/utility）会活下来。
// 反复跑这个脚本会攒出几十个 msedge，把内存吃到 1GB 出头，然后 jsdom 冒烟开始
// 随机卡死（同样代码两次卡在不同位置 = 资源耗尽而非代码问题）。
// 所以这里杀整棵进程树。
await killProcessTree(child);
await sleep(300);
try { rmSync(profile, { recursive: true, force: true }); } catch (_) { /* ignore */ }
process.exit(report.errors.length ? 1 : 0);

/** 连同子孙进程一起杀掉（Windows 用 taskkill /T；其它平台退回 kill）。 */
async function killProcessTree(proc) {
  if (!proc?.pid) return;
  if (process.platform === "win32") {
    try {
      const { spawnSync } = await import("node:child_process");
      spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch (_) { /* 退回下面的 kill */ }
  }
  try { proc.kill("SIGKILL"); } catch (_) { /* ignore */ }
}
