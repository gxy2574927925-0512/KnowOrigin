/* 学习文档（全屏沉浸式阅读台）端到端探针。
 *
 * 为什么自建临时账号 + 拦路由：/study-kit 是项目级的，别人的项目拿不到；而
 * /study-kit/ask 要真调模型（要 key、要花钱、结果还不确定）。所以
 *   1) 页面内注册临时账号 → 2) 新建一个项目 →
 *   3) GET  /study-kit       换成 tools/_study_kit_fixture.json（从只读库捞的真实内容）
 *   4) POST /study-kit/ask   换成一段固定 SSE
 * 这样既走通真实登录 / 侧栏 / 点击 / 流式渲染链路，又能确定性断言。
 *
 * 夹具重新生成：
 *   F:/pppython/python.exe -c "
 *   import sqlite3, json
 *   c=sqlite3.connect('file:data/knoworigin.sqlite3?mode=ro',uri=True); c.row_factory=sqlite3.Row
 *   rows=[dict(r) for r in c.execute(\"SELECT * FROM study_kits WHERE project_id='proj_2c34329de1f34d19' AND node_id IS NULL\")]
 *   open('tools/_study_kit_fixture.json','w',encoding='utf-8').write(json.dumps({'kits':rows},ensure_ascii=False))"
 *
 * 跑法（必须在项目根）：node tools/_probe_study_doc.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = "http://127.0.0.1:17321";
const FIXTURE = JSON.parse(
  fs.readFileSync(new URL("./_study_kit_fixture.json", import.meta.url), "utf8")
);
// 假的流式回答：只验前端「收到 SSE → 逐字渲染 → 收尾」这条路，不碰真模型。
const ANSWER = "这条说的是**增益饱和**：光强 I 增大时反转集居数差下降，于是 G 下降。文档里没写 $I_s$ 的具体数值。";
const ASK_SSE =
  `data: ${JSON.stringify({ type: "start", kits: ["cheatsheet"], context_chars: 1234 })}\n\n` +
  `data: ${JSON.stringify({ type: "delta", text: ANSWER.slice(0, 18) })}\n\n` +
  `data: ${JSON.stringify({ type: "delta", text: ANSWER.slice(18) })}\n\n` +
  `data: ${JSON.stringify({ type: "done", text: ANSWER })}\n\n`;

const FAILS = [];
function check(name, ok, detail = "") {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? " -> " + detail : ""}`);
  if (!ok) FAILS.push(name);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 860 } });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });

// ⚠️ 项目记忆里的坑：Playwright 会命中 HTTP 缓存，改完前端仍读旧脚本 → 结果假绿。
await context.route("**/static/**", async (route) => {
  await route.continue({
    headers: { ...route.request().headers(), "cache-control": "no-cache", pragma: "no-cache" },
  });
});

const page = await context.newPage();
const pageErrors = [];
const badResponses = [];
page.on("pageerror", (err) => pageErrors.push(String(err)));
page.on("console", (msg) => {
  if (msg.type() === "error") pageErrors.push("console: " + msg.text());
});
page.on("response", (res) => {
  if (res.status() >= 400) badResponses.push(`${res.status()} ${res.url()}`);
});

// ---- 1. 临时账号 ----
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
const email = `studyui+${Date.now()}@e.com`;
await page.evaluate(async (em) => {
  await fetch("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: em, name: "ui", password: "test123456" }),
  });
}, email);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach((d) => d.close()));

// ---- 2. 新建项目 ----
const projectId = await page.evaluate(async () => {
  await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subject: "UI 验证课程", year: "2026" }),
  });
  const data = await (await fetch("/api/projects")).json();
  const list = data.projects || [];
  return list.length ? String(list[0].project_id) : "";
});
check("临时项目已建出来", Boolean(projectId), projectId);

// ---- 3. 拦 /study-kit（GET）与 /study-kit/ask（POST）----
let kitMode = "full";
let askHits = 0;
let lastAskBody = null;
await context.route(
  (url) => /\/api\/projects\/[^/]+\/study-kit$/.test(url.pathname),
  async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const body = kitMode === "full" ? FIXTURE : { kits: [], kinds: [] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  }
);
await context.route(
  (url) => /\/api\/projects\/[^/]+\/study-kit\/ask$/.test(url.pathname),
  async (route) => {
    askHits += 1;
    try { lastAskBody = JSON.parse(route.request().postData() || "{}"); } catch { lastAskBody = null; }
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      body: ASK_SSE,
    });
  }
);

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach((d) => d.close()));
await page.evaluate(() => window.KnowOriginAgentShell?.renderSidebar?.());
await page.waitForTimeout(300);

// ---- 4. 侧栏图标 ----
check("侧栏项目行出现「学习文档」图标",
  (await page.locator("#agent-session-list .agent-project-study").count()) > 0);
check("图标在「知识文档」图标左侧（同列并排）", await page.evaluate(() => {
  const row = document.querySelector("#agent-session-list .agent-project-row");
  if (!row) return false;
  const kids = [...row.children].map((n) => n.className);
  return kids.indexOf("agent-project-study") >= 0 &&
    kids.indexOf("agent-project-study") < kids.indexOf("agent-project-doc");
}));
const geom = await page.evaluate(() => {
  const row = document.querySelector("#agent-session-list .agent-project-row");
  if (!row) return null;
  const rr = row.getBoundingClientRect();
  let worst = 0;
  row.querySelectorAll(".agent-project-name, .agent-project-study, .agent-project-doc").forEach((n) => {
    worst = Math.max(worst, n.getBoundingClientRect().right - rr.right);
  });
  return {
    overflow: Math.round(worst),
    nameW: Math.round(row.querySelector(".agent-project-name")?.getBoundingClientRect().width || 0),
  };
});
check("两个图标没把项目名/自己挤出侧栏", geom && geom.overflow <= 1 && geom.nameW > 40, JSON.stringify(geom));

// 侧栏局部截图：悬停整行让两个图标都点亮
await page.locator("#agent-session-list .agent-project-row").first().hover();
await page.waitForTimeout(200);
const side = await page.locator("#agent-sessions").boundingBox();
if (side) {
  await page.screenshot({
    path: "screenshots/study-doc-sidebar.png",
    clip: { x: side.x, y: side.y, width: side.width, height: Math.min(side.height, 300) },
  });
}

// ---- 5. 点图标打开阅读台（带手抖位移，覆盖「零位移 click 复现不出来」的盲区）----
const box = await page.locator("#agent-session-list .agent-project-study").first().boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx, cy + 3);
await page.mouse.up();
await page.waitForTimeout(1000);

const shell = await page.evaluate(() => {
  const n = document.getElementById("ko-sd-overlay");
  if (!n) return null;
  const r = n.getBoundingClientRect();
  return {
    open: n.classList.contains("ko-sd-is-open"),
    w: Math.round(r.width), h: Math.round(r.height),
    // 基线取 body 的布局宽度而不是 documentElement.clientWidth：根滚动条会占掉右侧 10px，
    // position:fixed; inset:0 的包含块是「视口 - 滚动条」，跟 body 同宽（实测 1430）。
    fullscreen: r.width >= document.body.getBoundingClientRect().width - 1 &&
      r.height >= document.documentElement.clientHeight - 1,
    view: {
      inner: [window.innerWidth, window.innerHeight],
      client: [document.documentElement.clientWidth, document.documentElement.clientHeight],
      position: getComputedStyle(n).position,
      rect: [Math.round(r.left), Math.round(r.right)],
      offsetW: n.offsetWidth,
      htmlOverflow: getComputedStyle(document.documentElement).overflowY,
      bodyOverflow: getComputedStyle(document.body).overflowY,
      bodyScrollbar: document.body.offsetWidth - document.body.clientWidth,
      bodyRect: [Math.round(document.body.getBoundingClientRect().width), document.body.offsetWidth],
      edgeEl: (() => {
        const el = document.elementFromPoint(window.innerWidth - 4, 300);
        return el ? (el.id || el.className || el.tagName) : "none";
      })(),
    },
    bodyOpenClass: document.body.classList.contains("ko-sd-open"),
    title: document.getElementById("ko-sd-title")?.textContent || "",
    meta: document.getElementById("ko-sd-meta")?.textContent || "",
    hasToc: !!document.querySelector("#ko-sd-toc .ko-sd-toc-item"),
    hasGripL: !!document.getElementById("ko-sd-grip-l"),
    hasAsk: !!document.getElementById("ko-sd-ask"),
    hasReadbar: !!document.getElementById("ko-sd-readbar"),
  };
});
check("点击后阅读台打开", shell?.open === true);
check("是全屏（铺满视口）而不是弹窗", shell?.fullscreen === true,
  `${shell?.w}x${shell?.h} / ${JSON.stringify(shell?.view)}`);
check("打开时给 body 挂了 ko-sd-open（藏掉提问导轨）", shell?.bodyOpenClass === true);
check("顶栏 / 目录 / 拖动把手 / 提问抽屉 / 进度条都在位",
  Boolean(shell?.hasToc && shell?.hasGripL && shell?.hasAsk && shell?.hasReadbar));
check("顶栏标题带项目名", /UI 验证课程/.test(shell?.title || ""), shell?.title);
check("顶栏副标带生成进度", /已生成 3\/3/.test(shell?.meta || ""), shell?.meta);

// ---- 6. 合并正文与目录 ----
const doc = await page.evaluate(() => {
  const secs = [...document.querySelectorAll("#ko-sd-body [data-sd-sec]")];
  const tocItems = [...document.querySelectorAll("#ko-sd-toc .ko-sd-toc-item")];
  return {
    sections: secs.length,
    order: secs.map((s) => s.id),
    tocTotal: tocItems.length,
    tocTop: tocItems.filter((b) => !b.classList.contains("ko-sd-is-sub")).length,
    tocSub: tocItems.filter((b) => b.classList.contains("ko-sd-is-sub")).length,
    tables: document.querySelectorAll("#ko-sd-body .ko-sd-md table").length,
    boxes: document.querySelectorAll("#ko-sd-body .ko-sd-md .ko-ck").length,
    katex: document.querySelectorAll("#ko-sd-body .katex").length,
    docTitle: document.querySelector(".ko-sd-doc-title")?.textContent || "",
    colWidth: Math.round(document.querySelector(".ko-sd-doc")?.getBoundingClientRect().width || 0),
    bodyScrollable: (() => {
      const b = document.getElementById("ko-sd-body");
      return b ? b.scrollHeight > b.clientHeight + 50 : false;
    })(),
  };
});
check("三块小节齐全且顺序为 速查表 → 路径 → 清单",
  doc.sections === 3 &&
    doc.order.join(",") === "ko-sd-sec-cheatsheet,ko-sd-sec-learning_path,ko-sd-sec-checklist",
  JSON.stringify(doc.order));
check("目录含三块小节 + 正文子标题（真 h2/h3 才做得到）",
  doc.tocTop === 3 && doc.tocSub >= 4, `top=${doc.tocTop} sub=${doc.tocSub}`);
check("速查表渲染出表格", doc.tables > 0, `tables=${doc.tables}`);
check("清单渲染出可勾选方框（.ko-ck，海小棠增强认它）", doc.boxes > 0, `boxes=${doc.boxes}`);
check("公式渲染成 KaTeX", doc.katex > 0, `katex=${doc.katex}`);
check("正文是单栏阅读宽度（不铺满整屏）", doc.colWidth > 600 && doc.colWidth <= 900, `w=${doc.colWidth}`);
check("整份文档一个滚动条", doc.bodyScrollable === true);
check("文档大标题带项目名", /UI 验证课程/.test(doc.docTitle || ""), doc.docTitle);

await page.screenshot({ path: "screenshots/study-doc-reader-top.png" });

// ---- 7. 目录跳转 + 滚动联动 + 阅读进度 ----
const before = await page.evaluate(() => ({
  top: document.getElementById("ko-sd-body").scrollTop,
  fill: document.getElementById("ko-sd-readbar").style.width,
}));
await page.locator('#ko-sd-toc [data-sd-jump="checklist"]').click();
await page.waitForTimeout(700);
const after = await page.evaluate(() => ({
  top: document.getElementById("ko-sd-body").scrollTop,
  fill: document.getElementById("ko-sd-readbar").style.width,
  active: document.querySelector("#ko-sd-toc .ko-sd-is-active")?.textContent.trim() || "",
  topBtn: document.getElementById("ko-sd-top")?.classList.contains("ko-sd-is-on"),
}));
check("点目录能跳到对应小节", after.top > before.top, `${before.top} -> ${after.top}`);
check("阅读进度条跟着走", parseFloat(after.fill || "0") > parseFloat(before.fill || "0"),
  `${before.fill} -> ${after.fill}`);
check("目录高亮跟着滚动走", /清单报告/.test(after.active || ""), after.active);
check("滚动后出现「回到顶部」", after.topBtn === true);

await page.screenshot({ path: "screenshots/study-doc-reader-checklist.png" });

// ---- 8. 沉浸模式 ----
await page.locator("#ko-sd-focus").click();
await page.waitForTimeout(300);
const focus = await page.evaluate(() => {
  const n = document.getElementById("ko-sd-overlay");
  const vis = (sel) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el).display !== "none" : false;
  };
  return {
    on: n.classList.contains("ko-sd-is-focus"),
    bar: vis("#ko-sd-overlay .ko-sd-bar"),
    toc: vis("#ko-sd-overlay .ko-sd-toc"),
    escape: vis("#ko-sd-escape"),
    colWidth: Math.round(document.querySelector(".ko-sd-doc")?.getBoundingClientRect().width || 0),
  };
});
check("沉浸模式收掉顶栏与目录", focus.on && !focus.bar && !focus.toc);
check("沉浸模式留一个退出入口", focus.escape === true);
check("沉浸模式正文更窄更好读", focus.colWidth > 0 && focus.colWidth <= 780, `w=${focus.colWidth}`);
await page.screenshot({ path: "screenshots/study-doc-reader-focus.png" });
await page.locator("[data-sd-focus-off]").click();
await page.waitForTimeout(300);
check("退出沉浸模式后顶栏回来", await page.evaluate(() =>
  getComputedStyle(document.querySelector("#ko-sd-overlay .ko-sd-bar")).display !== "none"));

// ---- 9. 选中原文 → 浮条 → 问 AI ----
await page.evaluate(() => {
  // 找一段够长的**文本节点**再选 —— 段落第一个子节点常常是 <strong> 之类的元素，
  // 直接 setEnd(el, 24) 会因为「没有第 24 个子节点」抛 IndexSizeError。
  function firstText(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let t = walker.nextNode();
    while (t) {
      if ((t.nodeValue || "").trim().length >= 12) return t;
      t = walker.nextNode();
    }
    return null;
  }
  // 必须挑**当前可见**的那一块：前面已经滚到清单小节了，拿最上面那段（滚出视口之外）
  // 选出来的浮条会被摆到屏幕外，Playwright 点不到。
  const body = document.getElementById("ko-sd-body");
  const view = body.getBoundingClientRect();
  const blocks = [...document.querySelectorAll("#ko-sd-body .ko-sd-md p, #ko-sd-body .ko-sd-md li")];
  let node = null;
  for (const b of blocks) {
    const r = b.getBoundingClientRect();
    if (r.top < view.top + 40 || r.bottom > view.bottom - 40) continue;
    node = firstText(b);
    if (node) break;
  }
  if (!node) return;
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, Math.min(20, node.nodeValue.length));
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
});
await page.waitForTimeout(300);
const selBar = await page.evaluate(() => {
  const bar = document.getElementById("ko-sd-selbar");
  return {
    on: bar?.classList.contains("ko-sd-is-on"),
    text: bar?.textContent || "",
  };
});
check("选中正文后浮出工具条", selBar.on === true, selBar.text.trim());
await page.screenshot({ path: "screenshots/study-doc-reader-selection.png" });

await page.locator("[data-sd-ask-sel]").click();
await page.waitForTimeout(400);
const askOpen = await page.evaluate(() => {
  const panel = document.getElementById("ko-sd-ask");
  const r = panel?.getBoundingClientRect();
  return {
    on: panel?.classList.contains("ko-sd-is-on"),
    width: Math.round(r?.width || 0),
    gripR: getComputedStyle(document.getElementById("ko-sd-grip-r")).display !== "none",
    ref: document.getElementById("ko-sd-ask-ref-text")?.textContent || "",
    section: document.getElementById("ko-sd-ask-section")?.textContent || "",
  };
});
check("点浮条「问 AI」打开右侧抽屉", askOpen.on === true && askOpen.width > 280, `w=${askOpen.width}`);
check("抽屉带上了选中的原文引用", askOpen.ref.length > 4, askOpen.ref.slice(0, 30));
check("抽屉标出当前在读哪一节", askOpen.section.length > 1, askOpen.section);
check("抽屉打开时右把手出现", askOpen.gripR === true);

// ---- 10. 提问 → SSE 流式 → 渲染 ----
await page.locator("#ko-sd-ask-input").fill("增益饱和到底是什么？");
await page.locator("[data-sd-ask-send]").click();
await page.waitForTimeout(900);
const asked = await page.evaluate(() => {
  const thread = document.getElementById("ko-sd-ask-thread");
  return {
    q: thread.querySelector(".ko-sd-ask-q")?.textContent || "",
    a: thread.querySelector(".ko-sd-ask-a")?.textContent || "",
    katex: thread.querySelectorAll(".katex").length,
    strong: thread.querySelectorAll("strong").length,
    hasCopy: !!thread.querySelector("[data-sd-ask-copy]"),
  };
});
check("问题进了问答记录", /增益饱和/.test(asked.q), asked.q.trim());
check("流式回答渲染出来了", /增益饱和/.test(asked.a) && asked.a.length > 30, asked.a.slice(0, 40));
check("回答里的 Markdown 与公式都渲染了", asked.katex > 0 && asked.strong > 0,
  `katex=${asked.katex} strong=${asked.strong}`);
check("回答带「复制」按钮", asked.hasCopy === true);
check("提问打到了 /study-kit/ask", askHits === 1, `hits=${askHits}`);
check("提问体带上了所在小节与产物类型",
  Boolean(lastAskBody && lastAskBody.question && lastAskBody.kind && lastAskBody.section),
  JSON.stringify({ kind: lastAskBody?.kind, section: lastAskBody?.section }));

await page.screenshot({ path: "screenshots/study-doc-reader-ask.png" });

// ---- 11. 分栏拖动 ----
const tocBefore = await page.evaluate(() =>
  Math.round(document.getElementById("ko-sd-toc").getBoundingClientRect().width));
const grip = await page.locator("#ko-sd-grip-l").boundingBox();
await page.mouse.move(grip.x + grip.width / 2, grip.y + 200);
await page.mouse.down();
await page.mouse.move(grip.x + grip.width / 2 + 70, grip.y + 200, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(200);
const tocAfter = await page.evaluate(() =>
  Math.round(document.getElementById("ko-sd-toc").getBoundingClientRect().width));
check("拖动左把手能改目录宽度", tocAfter > tocBefore + 40, `${tocBefore} -> ${tocAfter}`);
await page.locator("#ko-sd-grip-l").dblclick();
await page.waitForTimeout(200);
const tocReset = await page.evaluate(() =>
  Math.round(document.getElementById("ko-sd-toc").getBoundingClientRect().width));
check("双击把手复位目录宽度", Math.abs(tocReset - 248) <= 2, `${tocReset}`);

// ---- 12. 复制合并 Markdown ----
await page.locator("[data-sd-copy-all]").click();
await page.waitForTimeout(500);
const clip = await page.evaluate(() => navigator.clipboard.readText());
check("复制合并 Markdown：标题 + 三块小节都在",
  clip.startsWith("# ") && clip.includes("· 学习文档") &&
    clip.includes("## 一页速查表") && clip.includes("## 学习路径") && clip.includes("## 清单报告"),
  clip.slice(0, 34).replace(/\n/g, "⏎"));

// ---- 13. 缺块时就地生成入口 ----
kitMode = "empty";
await page.locator("[data-sd-refresh]").click();
await page.waitForTimeout(800);
const empty = await page.evaluate(() => ({
  tocMissing: document.querySelectorAll("#ko-sd-toc .ko-sd-toc-chip.ko-sd-is-off").length,
  genButtons: document.querySelectorAll("#ko-sd-body [data-sd-gen]").length,
}));
check("没生成时目录标为未生成", empty.tocMissing === 3, `missing=${empty.tocMissing}`);
check("三块各有一个就地「生成」按钮（且不重复）", empty.genButtons === 3, `btns=${empty.genButtons}`);
await page.screenshot({ path: "screenshots/study-doc-reader-empty.png" });

// ---- 14. Esc 分层退出 + 关闭 ----
await page.keyboard.press("Escape");   // 先收抽屉
await page.waitForTimeout(250);
check("Esc 先收提问抽屉", await page.evaluate(() =>
  !document.getElementById("ko-sd-ask").classList.contains("ko-sd-is-on")));
await page.keyboard.press("Escape");   // 再关整层
await page.waitForTimeout(300);
check("再按 Esc 关闭阅读台", await page.evaluate(() =>
  !document.getElementById("ko-sd-overlay").classList.contains("ko-sd-is-open")));
check("关闭后 body 上的类也摘掉了", await page.evaluate(() =>
  !document.body.classList.contains("ko-sd-open")));

// ⚠️ 注册**之前**那次首屏加载必然有一批 401（未登录），属预期，不算回归。
const realErrors = pageErrors.filter((text) => !/401|Unauthorized/.test(text));
const realBad = badResponses.filter((line) => !line.startsWith("401 "));
check("无页面级报错", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));
check("无 4xx/5xx 接口失败（401 除外）", realBad.length === 0, realBad.slice(0, 3).join(" | "));

await browser.close();

console.log();
if (FAILS.length) {
  console.log(`失败 ${FAILS.length} 项：${JSON.stringify(FAILS)}`);
  process.exit(1);
}
console.log("学习文档（沉浸式阅读台）端到端探针全部通过。");
