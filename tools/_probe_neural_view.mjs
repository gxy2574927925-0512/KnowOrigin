/* 神经图谱（kb-neural-view.js）回归探针
 * ------------------------------------------------------------------
 * 走真实登录 → 真实项目详情链路，但把 GET /api/projects/{id} 的响应
 * 换成从只读库捞出来的真实框架节点（临时账号看不到别人的项目）。
 * 断言：入口按钮注入 / 浮层打开 / 光球与模块几何 / 三层递进 / 分析栏 /
 *       问图谱 / Esc 逐层返回 / 无控制台报错。
 * 跑法：node tools/_probe_neural_view.mjs   （必须在项目根，才有 node_modules）
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = "http://127.0.0.1:17321";
const NODES = JSON.parse(fs.readFileSync("tools/_neural_nodes.json", "utf8"));

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${extra ? " — " + extra : ""}`); }
};
// 有效亮度：把 alpha 也算进去（深底上半透明白 = 很暗，不是纯白）
const lum = (c) => {
  const m = String(c).match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
  if (!m) return null;
  const a = m[4] === undefined ? 1 : Number(m[4]);
  return ((0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255) * a;
};
// 合成到已知底色上的亮度。getComputedStyle 现在会返回 color(srgb …) 形式，
// 只认 rgba() 会把「半透明深色」误判成通过 —— 必须两种都解析。
const effLum = (c, backdrop) => {
  let m = String(c).match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
  let r, g, b, a = 1;
  if (m) { r = +m[1]; g = +m[2]; b = +m[3]; a = m[4] === undefined ? 1 : +m[4]; }
  else {
    m = String(c).match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/);
    if (!m) return null;
    r = +m[1] * 255; g = +m[2] * 255; b = +m[3] * 255; a = m[4] === undefined ? 1 : +m[4];
  }
  const raw = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return a * raw + (1 - a) * backdrop;
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 820 } });
const page = await context.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e && e.message || e)));

try {
  // ---- 1. 注册临时账号 ----
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.evaluate(async (em) => {
    await fetch("/api/auth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: em, name: "ui", password: "test123456" }),
    });
  }, "uitest+" + Date.now() + "@e.com");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  // ---- 2. 建临时项目 ----
  const pid = await page.evaluate(async () => {
    const r = await fetch("/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "neural-probe", subject: "general" }),
    });
    const d = await r.json();
    return d && (d.project_id || d.id);
  });
  check("建临时项目成功", !!pid, String(pid));

  // ---- 3. 拦截项目详情 → 注入真实框架节点 ----
  await context.route(
    (url) => /\/api\/projects\/[^/]+$/.test(url.pathname),
    async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const u = new URL(route.request().url());
      if (!u.pathname.endsWith("/" + pid)) return route.continue();
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({
          project_id: pid, owner_id: "user_probe", name: "neural-probe",
          year: "", subject: "general", project_type: "course", tags: [],
          last_position: 0, last_opened_at: null, total_reading_seconds: 0,
          sources: [], nodes: NODES, link_notes: [],
          favorites: [{
            favorite_id: "fav_probe_1", chapter_name: "第一章 探针",
            kind: "answer", content: "夹具收藏内容", answer: "夹具答案",
            note: "夹具批注", created_at: "2026-10-08T00:00:00Z", deleted_at: null,
          }],
          cards: [], quiz: null,
        }),
      });
    },
  );

  // ---- 3b. 知识点文档夹具（确定性，不依赖库里是否生成过）----
  await context.route(
    (url) => /\/api\/projects\/[^/]+\/nodes\/[^/]+\/doc$/.test(url.pathname),
    async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ doc: { content_md: "# 测试知识点文档\n\n这是夹具正文。\n\n- 要点一\n- 要点二\n\n| 容易错的地方 | 正确理解 |\n| --- | --- |\n| 认为越高越好 | 必须适中 |\n\n**加粗**与 `代码`。" } }),
      });
    },
  );

  // ---- 3c. 问 AI：假 SSE（断言 UI 链路与请求体，不依赖服务端有没有配 API Key）----
  const askBodies = [];
  await context.route(
    (url) => /\/api\/projects\/[^/]+\/knowledge-doc\/ask$/.test(url.pathname),
    async (route) => {
      try { askBodies.push(JSON.parse(route.request().postData() || "{}")); } catch (_) { askBodies.push(null); }
      const sse = [
        'data: {"type":"start","scope":"node","context_chars":42}',
        'data: {"type":"delta","text":"这是"}',
        'data: {"type":"delta","text":"流式回答。"}',
        'data: {"type":"done","text":"这是流式回答。"}',
      ].join("\n\n") + "\n\n\n";
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: sse });
    },
  );

  // ---- 4. 选中项目 + 切到知识框架 ----
  await page.evaluate(async (p) => {
    await window.selectProject(p);
    window.switchFeature("framework");
  }, pid);
  await page.waitForTimeout(1200);
  // 表格泛白是**深色场景**的病：全局 .study-table 写死 background:#fff。
  // 所以文档那一段固定在深色下验；浅色适配另开一节。
  await page.evaluate(() => window.KnowOriginTheme && window.KnowOriginTheme.apply("dark"));
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach((d) => d.close()));
  // 夹具项目缺一些字段时 app 会弹顶部错误条，它会挡住工具栏的点击
  const banner = (await page.locator("#error-banner").first().textContent().catch(() => "")) || "";
  if (banner.trim()) console.log("  （页面错误条：" + banner.trim().slice(0, 120) + "）");
  await page.evaluate(() => { const b = document.getElementById("error-banner"); if (b) b.style.display = "none"; });

  console.log("\n== 入口按钮 ==");
  const btn = page.locator(".framework-view .graph-toolbar [data-kb-neural-open]");
  check("工具栏里注入了「神经图谱」按钮", await btn.count() === 1);
  check("按钮文案正确", (await btn.first().textContent() || "").trim() === "神经图谱");
  const btnBox = await btn.first().boundingBox();
  const tbBox = await page.locator(".graph-toolbar").first().boundingBox();
  check("按钮没被挤出工具栏", btnBox && tbBox && btnBox.x + btnBox.width <= tbBox.x + tbBox.width + 1,
    btnBox && tbBox ? `btn.right=${(btnBox.x + btnBox.width).toFixed(0)} tb.right=${(tbBox.x + tbBox.width).toFixed(0)}` : "no box");

  console.log("\n== 打开浮层 ==");
  await btn.first().click();
  await page.waitForTimeout(900);
  const ov = page.locator("#ko-nv-overlay");
  check("浮层可见", await ov.isVisible());
  const stageBox = await page.locator("#ko-nv-overlay .ko-nv-stage").boundingBox();
  const bodyW = await page.evaluate(() => document.body.getBoundingClientRect().width);
  check("浮层铺满（对比 body 宽度，不是 clientWidth）",
    stageBox && Math.abs(stageBox.width - bodyW) < 2,
    stageBox ? `stage.w=${stageBox.width.toFixed(0)} body.w=${bodyW.toFixed(0)}` : "no box");
  check("桌宠被收起", await page.evaluate(() => {
    const p = document.getElementById("hxt-pet");
    return !p || getComputedStyle(p).display === "none";
  }));

  console.log("\n== 第一层：光球 + 模块 ==");
  const orbBox = await page.locator("#ko-nv-overlay .ko-nv-orb").boundingBox();
  check("光球可见且有尺寸", orbBox && orbBox.width > 80, orbBox ? `w=${orbBox.width.toFixed(0)}` : "no box");
  check("光球在舞台内", orbBox && stageBox &&
    orbBox.x >= stageBox.x - 1 && orbBox.x + orbBox.width <= stageBox.x + stageBox.width + 1 &&
    orbBox.y >= stageBox.y - 1 && orbBox.y + orbBox.height <= stageBox.y + stageBox.height + 1);
  const modCount = await page.locator("#ko-nv-overlay .ko-nv-mod").count();
  check("模块数 >= 2（真实数据：顶层节点的子节点）", modCount >= 2, `count=${modCount}`);
  const labelCount = await page.locator("#ko-nv-overlay .ko-nv-mod-label").count();
  check("模块标签数与模块数一致", labelCount === modCount, `${labelCount} vs ${modCount}`);
  // 标签不得溢出舞台
  const overflow = await page.evaluate(() => {
    const st = document.querySelector("#ko-nv-overlay .ko-nv-stage").getBoundingClientRect();
    let bad = 0;
    document.querySelectorAll("#ko-nv-overlay .ko-nv-mod-label").forEach((n) => {
      const r = n.getBoundingClientRect();
      if (r.width < 40 || r.right > st.right + 2 || r.left < st.left - 2) bad++;
    });
    return bad;
  });
  check("模块标签没有溢出/被压扁", overflow === 0, `bad=${overflow}`);
  // 中文竖排检查：宽 > 高
  const vertical = await page.evaluate(() => {
    let bad = 0;
    document.querySelectorAll("#ko-nv-overlay .ko-nv-mod-name, #ko-nv-overlay .ko-nv-item-title").forEach((n) => {
      const r = n.getBoundingClientRect();
      if (r.height > 0 && r.width < r.height * 0.9) bad++;
    });
    return bad;
  });
  check("没有中文被压成竖排", vertical === 0, `bad=${vertical}`);
  // 总览里 16 个模块的标签不许互相叠（改版前就是叠成一团的）
  const overlap = await page.evaluate(() => {
    const rs = [...document.querySelectorAll("#ko-nv-overlay .ko-nv-mod-label")].map((n) => n.getBoundingClientRect());
    let bad = 0;
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i], b = rs[j];
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 6 && oy > 6) bad++;
    }
    return bad;
  });
  check("模块标签互不重叠", overlap === 0, `overlap=${overlap}`);
  await page.screenshot({ path: "screenshots/neural-view-hub.png" });

  console.log("\n== 第二层：点模块 → 伞状展开 ==");
  // 挑一个有下级的模块（真实数据里有的顶层模块是叶子，点了应当直接给它的分析）
  const modIdx = await page.evaluate(() => {
    const labels = [...document.querySelectorAll("#ko-nv-overlay .ko-nv-mod-label")];
    return labels.findIndex((l) => Number(l.querySelector(".ko-nv-mod-count").textContent) > 0);
  });
  check("存在带下级的模块", modIdx >= 0, `idx=${modIdx}`);
  await page.locator("#ko-nv-overlay .ko-nv-mod").nth(modIdx >= 0 ? modIdx : 0).click();
  await page.waitForTimeout(1100);
  const itemCount = await page.locator("#ko-nv-overlay .ko-nv-item").count();
  check("展开出下级节点条目", itemCount >= 1, `items=${itemCount}`);
  check("面包屑出现", await page.locator("#ko-nv-overlay .ko-nv-crumbs").isVisible());
  const itemOverflow = await page.evaluate(() => {
    const st = document.querySelector("#ko-nv-overlay .ko-nv-stage").getBoundingClientRect();
    const panel = document.querySelector("#ko-nv-overlay .ko-nv-panel");
    const panelLeft = panel && !panel.hidden ? panel.getBoundingClientRect().left : st.right;
    let bad = 0;
    document.querySelectorAll("#ko-nv-overlay .ko-nv-item").forEach((n) => {
      const r = n.getBoundingClientRect();
      if (r.right > panelLeft + 2 || r.right > st.right + 2) bad++;
    });
    return bad;
  });
  check("条目没有压到分析栏/溢出舞台", itemOverflow === 0, `bad=${itemOverflow}`);
  // 模块层的标签也不许互叠（选中的那个若是两行会压住上下邻居）
  const colOverlap = await page.evaluate(() => {
    const rs = [...document.querySelectorAll("#ko-nv-overlay .ko-nv-mod-label")].map((n) => n.getBoundingClientRect());
    let bad = 0;
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i], b = rs[j];
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 6 && oy > 6) bad++;
    }
    return bad;
  });
  check("模块层标签互不重叠", colOverlap === 0, `overlap=${colOverlap}`);
  await page.screenshot({ path: "screenshots/neural-view-fan.png" });

  console.log("\n== 第三层：点条目 → 分析栏 ==");
  await page.locator("#ko-nv-overlay .ko-nv-item").first().click();
  await page.waitForTimeout(800);
  const panel = page.locator("#ko-nv-overlay .ko-nv-panel");
  check("分析栏出现", await panel.isVisible());
  const panelTitle = (await page.locator("#ko-nv-overlay .ko-nv-panel h3").first().textContent() || "").trim();
  check("分析栏有节点名", panelTitle.length > 0, panelTitle);
  check("分析栏有掌握度指标", await page.locator("#ko-nv-overlay .ko-nv-metric strong").first().isVisible());
  check("分析栏有「在框架中打开」", await page.locator("#ko-nv-overlay [data-nv-open-node]").count() === 1);
  await page.screenshot({ path: "screenshots/neural-view-panel.png" });

  console.log("\n== 侧边栏：文档内容 ==");
  await page.waitForTimeout(800);
  const docBody = page.locator("#ko-nv-overlay [data-nv-doc-body]");
  check("面板里有文档区", await docBody.count() === 1);
  const docText = (await docBody.textContent()) || "";
  check("文档正文渲染出来了（夹具标题）", docText.includes("测试知识点文档"), docText.slice(0, 40));
  check("文档里的列表也渲染了", docText.includes("要点一") && docText.includes("要点二"));
  check("文档徽标显示「已生成」", ((await page.locator("#ko-nv-overlay [data-nv-doc-badge]").textContent()) || "").includes("已生成"));
  const docOverflow = await page.evaluate(() => {
    const p = document.querySelector("#ko-nv-overlay .ko-nv-panel").getBoundingClientRect();
    let bad = 0;
    document.querySelectorAll("#ko-nv-overlay .ko-nv-doc-body *").forEach((n) => {
      const r = n.getBoundingClientRect();
      if (r.width > 0 && r.right > p.right + 2) bad++;
    });
    return bad;
  });
  check("文档内容没有溢出面板", docOverflow === 0, `bad=${docOverflow}`);
  // 用户要的是「侧边栏里就能看到文档」—— 不能要滚一大截才露出正文
  const docHeadVisible = await page.evaluate(() => {
    const body = document.querySelector("#ko-nv-overlay [data-nv-doc-body]");
    const scroll = document.querySelector("#ko-nv-overlay .ko-nv-panel-scroll");
    const head = body && body.querySelector("h1, h2, h3, p");
    if (!head || !scroll) return false;
    const h = head.getBoundingClientRect(), s = scroll.getBoundingClientRect();
    return h.top >= s.top - 2 && h.top < s.bottom - 10;
  });
  check("文档正文在侧边栏可视区内（不用滚才看得到）", docHeadVisible);
  check("面板停在顶部（节点名没被切掉）", await page.evaluate(() => {
    const sc = document.querySelector("#ko-nv-overlay .ko-nv-panel-scroll");
    return !!sc && sc.scrollTop <= 1;
  }));
  // 表格：全局 .study-table 写死了 background:#fff、表头深棕字 —— 深色下会泛白 + 看不见
  const tc = await page.evaluate(() => {
    const t = document.querySelector("#ko-nv-overlay .ko-nv-doc-body .study-table");
    const th = document.querySelector("#ko-nv-overlay .ko-nv-doc-body .study-table thead th");
    if (!t || !th) return null;
    return { table: getComputedStyle(t).backgroundColor, th: getComputedStyle(th).color, thBg: getComputedStyle(th).backgroundColor };
  });
  check("文档里渲染出了表格", !!tc);
  check("深色下表格底不泛白", tc && lum(tc.table) < 0.3, tc ? tc.table : "no table");
  check("深色下表头底不泛白", tc && lum(tc.thBg) < 0.35, tc ? tc.thBg : "");
  check("深色下表头字看得见", tc && lum(tc.th) > 0.6, tc ? tc.th : "");
  await page.screenshot({ path: "screenshots/neural-view-doc.png" });

  console.log("\n== 问 AI（真接口 + SSE 流式）==");
  await page.fill("#ko-nv-overlay .ko-nv-ask input", "这个节点为什么重要？");
  await page.press("#ko-nv-overlay .ko-nv-ask input", "Enter");
  await page.waitForTimeout(900);
  check("请求打到了 knowledge-doc/ask", askBodies.length >= 1, `n=${askBodies.length}`);
  const b1 = askBodies[0] || {};
  check("scope=node 且带上了选中的节点", b1.scope === "node" && !!b1.node_id, JSON.stringify(b1).slice(0, 90));
  check("发散档默认开（allow_extra=true）", b1.allow_extra === true, String(b1.allow_extra));
  const ans = (await page.locator("#ko-nv-overlay .ko-nv-a-body").first().textContent()) || "";
  check("流式回答渲染出来了", ans.includes("流式回答"), ans.slice(0, 40));
  check("回答区可见", await page.locator("#ko-nv-overlay .ko-nv-answers").isVisible());
  check("回答区没有被侧边栏压住", await page.evaluate(() => {
    const a = document.querySelector("#ko-nv-overlay .ko-nv-answers");
    const p = document.querySelector("#ko-nv-overlay .ko-nv-panel");
    if (!a || !p || p.hidden) return true;
    return a.getBoundingClientRect().right <= p.getBoundingClientRect().left + 2;
  }));

  console.log("\n== 发散开关 ==");
  const modeBtn = page.locator("#ko-nv-overlay [data-nv-extra]");
  check("发散按钮存在且默认按下", await modeBtn.getAttribute("aria-pressed") === "true");
  await modeBtn.click();
  check("点击后切到严格档", await modeBtn.getAttribute("aria-pressed") === "false");
  await page.fill("#ko-nv-overlay .ko-nv-ask input", "再来一次");
  await page.press("#ko-nv-overlay .ko-nv-ask input", "Enter");
  await page.waitForTimeout(800);
  check("第二问带上了 allow_extra=false", (askBodies[1] || {}).allow_extra === false, JSON.stringify(askBodies[1] || {}).slice(0, 80));
  check("多轮对话都留在回答区", await page.locator("#ko-nv-overlay .ko-nv-turn.is-q").count() >= 2);
  check("历史被带上（history 非空）", Array.isArray((askBodies[1] || {}).history) && (askBodies[1] || {}).history.length >= 1);
  await page.screenshot({ path: "screenshots/neural-view-ask.png" });

  console.log("\n== 图谱速览（本地规则，不调模型）==");
  const before = askBodies.length;
  await page.locator("#ko-nv-overlay [data-nv-overview]").click();
  await page.waitForTimeout(400);
  check("速览不发起 AI 请求", askBodies.length === before, `${before} -> ${askBodies.length}`);
  check("速览卡片出现", await page.locator("#ko-nv-overlay .ko-nv-card").count() >= 1);

  console.log("\n== Esc 逐层返回 ==");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  check("Esc① 关掉分析栏（回到模块层）", !(await page.locator("#ko-nv-overlay .ko-nv-panel").isVisible()));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);
  check("Esc② 回到总览（模块层）", await page.locator("#ko-nv-overlay .ko-nv-item").count() === 0);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  check("Esc③ 关闭浮层", !(await page.locator("#ko-nv-overlay").isVisible()));
  check("关闭后 body 类被清掉", !(await page.evaluate(() => document.body.classList.contains("ko-nv-open"))));
  // 浮层挂在 body 上，点它等于「点 .studio-panel 之外」—— 不拦就会触发 collapseStudio()，
  // 用户一关浮层就被踢出知识框架视图。这条断言守住它。
  check("关闭后知识框架视图还在（没被 collapseStudio 折叠）", await page.evaluate(() => {
    const p = document.querySelector(".studio-panel");
    return !!p && getComputedStyle(p).display !== "none";
  }));

  console.log("\n== 主题跟随（浅色模式适配）==");
  const diag = await page.evaluate(() => {
    const b = document.querySelector(".framework-view .graph-toolbar [data-kb-neural-open]");
    if (!b) return "找不到按钮";
    const r = b.getBoundingClientRect();
    const hidden = [];
    let n = b;
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === "none" || cs.visibility === "hidden") hidden.push(`${n.tagName}.${n.className}:${cs.display}/${cs.visibility}`);
      n = n.parentElement;
    }
    return { box: [Math.round(r.width), Math.round(r.height)], hidden };
  });
  console.log("  （诊断：" + JSON.stringify(diag) + "）");
  await page.locator(".framework-view .graph-toolbar [data-kb-neural-open]").click();
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.KnowOriginTheme && window.KnowOriginTheme.apply("light"));
  await page.waitForTimeout(600);
  const lb = await page.evaluate(() => {
    const ov = document.querySelector("#ko-nv-overlay");
    const orb = document.querySelector("#ko-nv-overlay .ko-nv-orb-core");
    return { bg: getComputedStyle(ov).backgroundColor, text: getComputedStyle(ov).color, orb: getComputedStyle(orb).backgroundImage };
  });
  check("浅色：浮层底是浅的", lum(lb.bg) > 0.7, lb.bg);
  check("浅色：文字是深的", lum(lb.text) < 0.4, lb.text);
  check("浅色：光球换了材质（不再是深色那套）", lb.orb.includes("198, 205, 209") || lb.orb.includes("rgba(74, 82, 86"), lb.orb.slice(0, 60));
  check("浅色：光球仍然可见", await page.locator("#ko-nv-overlay .ko-nv-orb").isVisible());
  // 浅色下表格要回到「白底深字」—— 全局那套本来就是对的，不该被深色覆盖误伤
  const modIdx2 = await page.evaluate(() => {
    const labels = [...document.querySelectorAll("#ko-nv-overlay .ko-nv-mod-label")];
    return labels.findIndex((l) => Number(l.querySelector(".ko-nv-mod-count").textContent) > 0);
  });
  await page.locator("#ko-nv-overlay .ko-nv-mod").nth(modIdx2 >= 0 ? modIdx2 : 0).click();
  await page.waitForTimeout(900);
  await page.locator("#ko-nv-overlay .ko-nv-item").first().click();
  await page.waitForTimeout(900);
  const lt = await page.evaluate(() => {
    const t = document.querySelector("#ko-nv-overlay .ko-nv-doc-body .study-table");
    const th = t && t.querySelector("thead th");
    return t ? { table: getComputedStyle(t).backgroundColor, th: th ? getComputedStyle(th).color : "" } : null;
  });
  check("浅色：表格白底深字（没被深色覆盖误伤）", lt && lum(lt.table) > 0.7 && lum(lt.th) < 0.5, JSON.stringify(lt));
  // 选中态里有几处材质是深色写死的，浅色下要一起量出来
  const bits = await page.evaluate(() => {
    const g = (sel) => { const n = document.querySelector(sel); return n ? getComputedStyle(n).backgroundColor : "（无此元素）"; };
    return {
      activeItem: g("#ko-nv-overlay .ko-nv-item.is-active .ko-nv-item-body"),
      activeMod: g("#ko-nv-overlay .ko-nv-mod-label.is-active"),
      modLabel: g("#ko-nv-overlay .ko-nv-mod-label"),
      meta: g("#ko-nv-overlay .ko-nv-item-meta > span"),
      mark: g("#ko-nv-overlay .ko-nv-mark"),
    };
  });
  console.log("  （浅色材质：" + JSON.stringify(bits) + "）");
  for (const [k, v] of Object.entries(bits)) {
    check(`浅色：${k} 是浅底（合成到纸底上仍为亮）`, effLum(v, 0.95) === null || effLum(v, 0.95) > 0.6, v);
  }
  await page.screenshot({ path: "screenshots/neural-view-light.png" });

  await page.evaluate(() => window.KnowOriginTheme && window.KnowOriginTheme.apply("dark"));
  await page.waitForTimeout(600);
  const db = await page.evaluate(() => {
    const ov = document.querySelector("#ko-nv-overlay");
    return { bg: getComputedStyle(ov).backgroundColor, text: getComputedStyle(ov).color };
  });
  check("深色：浮层底是深的", lum(db.bg) < 0.3, db.bg);
  check("深色：文字是浅的", lum(db.text) > 0.6, db.text);
  await page.keyboard.press("Escape");

  console.log("\n== 神经皮肤：学习概览 ==");
  // 浅色段点过模块+节点，一次 Esc 只退一层 —— 显式关层，否则截到的还是浮层
  await page.evaluate(() => window.KbNeuralView && window.KbNeuralView.close());
  await page.waitForTimeout(400);
  check("浮层已关闭", !(await page.locator("#ko-nv-overlay").isVisible()));
  await page.evaluate(() => window.switchFeature("overview"));
  await page.waitForTimeout(1000);
  check("概览渲染出来了", await page.locator(".overview-dashboard").count() === 1);
  await page.evaluate(() => window.KnowOriginTheme.apply("dark"));
  await page.waitForTimeout(400);
  const skin = await page.evaluate(() => {
    const p = document.querySelector(".overview-dashboard .overview-panel");
    const m = document.querySelector(".overview-dashboard .metric-card");
    if (!p) return null;
    const cs = getComputedStyle(p);
    return {
      radius: cs.borderTopLeftRadius, shadow: cs.boxShadow, border: cs.borderTopColor,
      metricRadius: m ? getComputedStyle(m).borderTopLeftRadius : "",
      heroClip: getComputedStyle(document.querySelector(".overview-dashboard .overview-hero h3")).webkitBackgroundClip
        || getComputedStyle(document.querySelector(".overview-dashboard .overview-hero h3")).backgroundClip,
    };
  });
  check("面板套上玻璃卡（圆角 >= 14px）", skin && parseFloat(skin.radius) >= 14, skin ? skin.radius : "no panel");
  check("面板有投影", skin && skin.shadow !== "none", skin ? skin.shadow.slice(0, 40) : "");
  check("指标卡也套上了", skin && parseFloat(skin.metricRadius) >= 12, skin ? skin.metricRadius : "");
  check("概览大数字用了渐变字", skin && skin.heroClip === "text", skin ? skin.heroClip : "");
  await page.screenshot({ path: "screenshots/neural-skin-overview-dark.png" });
  await page.evaluate(() => window.KnowOriginTheme.apply("light"));
  await page.waitForTimeout(500);
  const skinLight = await page.evaluate(() => {
    const p = document.querySelector(".overview-dashboard .overview-panel");
    return p ? { shadow: getComputedStyle(p).boxShadow, radius: getComputedStyle(p).borderTopLeftRadius } : null;
  });
  check("浅色下皮肤仍然生效", skinLight && skinLight.shadow !== "none" && parseFloat(skinLight.radius) >= 14, JSON.stringify(skinLight).slice(0, 80));
  await page.screenshot({ path: "screenshots/neural-skin-overview-light.png" });

  console.log("\n== 神经皮肤：我的笔记 ==");
  await page.evaluate(() => window.switchFeature("favorites"));
  await page.waitForTimeout(800);
  check("我的笔记渲染出来了", await page.locator(".favorites-overview").count() === 1);
  const fav = await page.evaluate(() => {
    const g = document.querySelector(".favorite-groups .favorite-group");
    const e = document.querySelector(".favorites-overview .eyebrow");
    return {
      groupRadius: g ? getComputedStyle(g).borderTopLeftRadius : null,
      groupShadow: g ? getComputedStyle(g).boxShadow : null,
      eyebrow: e ? getComputedStyle(e).color : null,
    };
  });
  console.log("  （我的笔记：" + JSON.stringify(fav) + "）");
  check("分组标题走香槟金", fav.eyebrow === null || lum(fav.eyebrow) < 0.55, fav.eyebrow);
  // 空态时没有 .favorite-group，这条自动跳过（不假装通过）
  if (fav.groupRadius !== null) {
    check("分组卡套上玻璃卡（圆角 >= 14px）", parseFloat(fav.groupRadius) >= 14, fav.groupRadius);
    check("分组卡有投影", fav.groupShadow !== "none", fav.groupShadow);
  } else {
    console.log("  （空态：没有分组卡，跳过圆角/投影断言）");
  }
  await page.screenshot({ path: "screenshots/neural-skin-favorites.png" });

  console.log("\n== 控制台 ==");
  const realErrors = errors.filter((e) => !/favicon|net::ERR_|Failed to load resource/i.test(e));
  check("没有控制台报错", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

  await page.screenshot({ path: "screenshots/neural-view.png" });
} catch (err) {
  fail++;
  console.log("\n[FATAL] " + (err && err.stack || err));
} finally {
  await browser.close();
}

console.log(`\n===== 神经图谱探针：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
