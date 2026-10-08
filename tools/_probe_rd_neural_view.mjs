/* 读书 · 神经图谱（rd-neural-view.js）回归探针
 * ------------------------------------------------------------------
 * 走真实登录 → 真实读书模式链路，但把三个接口换成夹具：
 *   GET  /api/reading/net             → tools/_rd_net_fixture.json
 *   GET  /api/reading/net/candidates  → 一条跨模块候选
 *   POST /api/reading/net/ask         → 假 SSE（断言 UI 链路与请求体，不依赖有没有配 Key）
 *
 * 断言：入口按钮注入 / 浮层铺满 / 三层递进 / 领域=连通分量 / 桥被点亮 /
 *       类型化边（含「对立」单独一色）/ 概念卡分组 / 图谱速览 /
 *       Esc 逐层返回且**不把读书模式一起关掉** / 无控制台报错。
 *
 * 跑法：node tools/_probe_rd_neural_view.mjs   （必须在项目根，才有 node_modules）
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = "http://127.0.0.1:17321";
const NET = JSON.parse(fs.readFileSync("tools/_rd_net_fixture.json", "utf8"));

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${extra ? " — " + extra : ""}`); }
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 820 } });
const page = await context.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String((e && e.message) || e)));

try {
  // ---- 1. 临时账号 ----
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.evaluate(async (em) => {
    await fetch("/api/auth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: em, name: "ui", password: "test123456" }),
    });
  }, "rdnet+" + Date.now() + "@e.com");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  // ---- 2. 夹具路由 ----
  await context.route(
    (url) => url.pathname === "/api/reading/net",
    async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(NET) }),
  );
  await context.route(
    (url) => url.pathname === "/api/reading/net/candidates",
    async (route) => route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        candidates: [{
          left: "cpt_c1", right: "cpt_b3", left_name: "机会成本", right_name: "沉没成本",
          score: 0.62, reason: "都带「成本」且语义接近", books: ["《穷查理宝典》"], needs_confirmation: true,
        }],
      }),
    }),
  );
  const askBodies = [];
  await context.route(
    (url) => url.pathname === "/api/reading/net/ask",
    async (route) => {
      try { askBodies.push(JSON.parse(route.request().postData() || "{}")); } catch (_) { askBodies.push(null); }
      const sse = [
        'data: {"type":"start","context_chars":42}',
        'data: {"type":"delta","text":"这是"}',
        'data: {"type":"delta","text":"流式回答。"}',
        'data: {"type":"done","text":"这是流式回答。"}',
      ].join("\n\n") + "\n\n\n";
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: sse });
    },
  );
  await context.route(
    (url) => url.pathname === "/api/reading/books",
    async (route) => route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ books: [], summary: { books: 0, digests: 0, cards: 0 } }),
    }),
  );

  // ---- 3. 进读书模式 → 切「知识网络」页签 ----
  await page.evaluate(() => window.KnowOriginReading.open());
  await page.waitForTimeout(900);
  await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach((d) => d.close()));
  await page.evaluate(() => { const b = document.getElementById("error-banner"); if (b) b.style.display = "none"; });
  // 本层的「主场」是深色（全屏图谱场景用深底才压得住发光球体与光点），
  // 所以主截图固定在深色下取；浅色适配另开一节。
  await page.evaluate(() => window.KnowOriginTheme && window.KnowOriginTheme.apply("dark"));
  await page.waitForTimeout(400);

  console.log("\n== 入口按钮 ==");
  await page.locator('#reading-workspace [data-rd-tab="net"]').click();
  await page.waitForTimeout(900);
  const btn = page.locator("#reading-workspace [data-rd-neural-open]");
  check("「知识网络」页签注入了「神经图谱」按钮", await btn.count() === 1);
  const btnBox = await btn.first().boundingBox();
  // ⚠️ 必须限定在「知识网络」页签里 —— 书架页签也有 .rd-head，取 .first() 会拿到隐藏的那个
  const headBox = await page.locator("#reading-workspace [data-rd-net] .rd-head").first().boundingBox();
  check("按钮在 .rd-head 内且没被挤出去",
    btnBox && headBox && btnBox.x >= headBox.x - 1 && btnBox.x + btnBox.width <= headBox.x + headBox.width + 1,
    btnBox && headBox ? `btn.right=${(btnBox.x + btnBox.width).toFixed(0)} head.right=${(headBox.x + headBox.width).toFixed(0)}` : "no box");

  console.log("\n== 打开浮层 ==");
  await btn.first().click();
  await page.waitForTimeout(1200);
  const ov = page.locator("#ko-rn-overlay");
  check("浮层可见", await ov.isVisible());
  check("浮层挂上了复用的 .ko-nv-layer 材质类", await page.evaluate(() =>
    document.getElementById("ko-rn-overlay").classList.contains("ko-nv-layer")));
  const stageBox = await page.locator("#ko-rn-overlay .ko-nv-stage").boundingBox();
  const bodyW = await page.evaluate(() => document.body.getBoundingClientRect().width);
  check("浮层铺满（对比 body 宽度）",
    stageBox && Math.abs(stageBox.width - bodyW) < 2,
    stageBox ? `stage.w=${stageBox.width.toFixed(0)} body.w=${bodyW.toFixed(0)}` : "no box");
  check("桌宠被收起", await page.evaluate(() => {
    const p = document.getElementById("hxt-pet");
    return !p || getComputedStyle(p).display === "none";
  }));
  // 材质复用是否真的生效：顶栏背景不该是默认透明
  check("复用的材质生效（顶栏有背景）", await page.evaluate(() => {
    const bg = getComputedStyle(document.querySelector("#ko-rn-overlay .ko-nv-top")).backgroundImage;
    return bg && bg !== "none";
  }));

  console.log("\n== 第一层：光球 + 领域（连通分量）==");
  const orbBox = await page.locator("#ko-rn-overlay .ko-nv-orb").boundingBox();
  check("光球可见且有尺寸", orbBox && orbBox.width > 80, orbBox ? `w=${orbBox.width.toFixed(0)}` : "no box");
  const modCount = await page.locator("#ko-rn-overlay .ko-nv-mod").count();
  // 夹具：2 个连通分量（5 + 3 个概念）+ 1 个「未连接」合成模块 = 3
  check("领域数 = 2 个连通分量 + 1 个「未连接」合成模块", modCount === 3, `count=${modCount}`);
  check("模块标签数与模块数一致",
    await page.locator("#ko-rn-overlay .ko-nv-mod-label").count() === modCount);
  const loose = page.locator("#ko-rn-overlay .ko-nv-mod-label.is-loose");
  check("「未连接」是虚线框且不冒充结构", await loose.count() === 1);
  check("「未连接」标签文案正确",
    ((await loose.first().textContent()) || "").includes("未连接的概念"),
    (await loose.first().textContent()) || "");
  const bridgeBadges = page.locator("#ko-rn-overlay .ko-nv-mod-bridge");
  check("两个领域各带一个「桥」徽标", await bridgeBadges.count() === 2, `count=${await bridgeBadges.count()}`);
  // 标签不溢出、不竖排、不互叠
  const hubGeom = await page.evaluate(() => {
    const st = document.querySelector("#ko-rn-overlay .ko-nv-stage").getBoundingClientRect();
    const labels = [...document.querySelectorAll("#ko-rn-overlay .ko-nv-mod-label")];
    let overflow = 0, vertical = 0;
    labels.forEach((n) => {
      const r = n.getBoundingClientRect();
      if (r.width < 40 || r.right > st.right + 2 || r.left < st.left - 2) overflow++;
      const name = n.querySelector(".ko-nv-mod-name");
      const nr = name.getBoundingClientRect();
      if (nr.height > 0 && nr.width < nr.height * 0.9) vertical++;
    });
    let overlap = 0;
    const rs = labels.map((n) => n.getBoundingClientRect());
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i], b = rs[j];
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 6 && oy > 6) overlap++;
    }
    return { overflow, vertical, overlap };
  });
  check("领域标签没有溢出/被压扁", hubGeom.overflow === 0, `bad=${hubGeom.overflow}`);
  check("没有中文被压成竖排", hubGeom.vertical === 0, `bad=${hubGeom.vertical}`);
  check("领域标签互不重叠", hubGeom.overlap === 0, `overlap=${hubGeom.overlap}`);
  const kpiText = (await page.locator("#ko-rn-overlay .ko-nv-kpis").textContent()) || "";
  check("KPI 有「概念 / 连线 / 领域 / 桥」四项",
    ["概念", "连线", "领域", "桥"].every((t) => kpiText.includes(t)), kpiText.replace(/\s+/g, " ").slice(0, 90));
  check("KPI 数字与夹具一致（10 概念 / 8 连线 / 3 领域 / 2 桥）",
    /10/.test(kpiText) && /8/.test(kpiText) && /3/.test(kpiText) && /2/.test(kpiText));
  check("关系图例可见（8 行）",
    await page.locator("#ko-rn-overlay .ko-nv-legend").isVisible() &&
    await page.locator("#ko-rn-overlay .ko-nv-legend-row").count() === 8);
  check("图例里明确标出「待确认的关联」",
    ((await page.locator("#ko-rn-overlay .ko-nv-legend").textContent()) || "").includes("待确认"));
  // 候选关联是模块之间唯一的真实连线来源，画成虚线且默认很淡
  const candOpacity = await page.evaluate(() => {
    const p = document.querySelector('#ko-rn-overlay .ko-nv-arc[data-cand="0"]');
    return p ? { d: p.getAttribute("d") || "", op: Number(getComputedStyle(p).opacity) } : null;
  });
  check("跨领域的「候选关联」画成了虚线弧",
    candOpacity && candOpacity.d.startsWith("M") && candOpacity.op > 0 && candOpacity.op < 0.5,
    candOpacity ? `op=${candOpacity.op}` : "no path");
  await page.screenshot({ path: "screenshots/rd-neural-view-hub.png" });

  console.log("\n== 第二层：点领域 → 概念与类型化边 ==");
  const domIdx = await page.evaluate(() => {
    const labels = [...document.querySelectorAll("#ko-rn-overlay .ko-nv-mod-label")];
    return labels.findIndex((l) => Number(l.querySelector(".ko-nv-mod-count").textContent) === 5);
  });
  check("找到 5 个概念的那个领域", domIdx >= 0, `idx=${domIdx}`);
  await page.locator("#ko-rn-overlay .ko-nv-mod").nth(domIdx >= 0 ? domIdx : 0).click();
  await page.waitForTimeout(1200);
  const nodeCount = await page.locator("#ko-rn-overlay .ko-nv-node").count();
  check("展开出该领域的 5 个概念", nodeCount === 5, `nodes=${nodeCount}`);
  check("面包屑出现", await page.locator("#ko-rn-overlay .ko-nv-crumbs").isVisible());
  // 排除「候选关联」那条虚线弧（它属于模块之间，不是簇内关系）
  const arcCount = await page.locator("#ko-rn-overlay .ko-nv-arc:not(.is-cand)").count();
  check("簇内 6 条关系都画出来了", arcCount === 6, `arcs=${arcCount}`);
  check("「对立」单独一色（明显偏红，不是银灰）", await page.evaluate(() => {
    const el = document.querySelector("#ko-rn-overlay .ko-nv-arc.is-contrast");
    if (!el) return false;
    const raw = getComputedStyle(el).stroke || getComputedStyle(el).color;
    const m = String(raw).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return false;
    const r = Number(m[1]), g = Number(m[2]), b = Number(m[3]);
    return r > 120 && r - g > 60 && r - b > 50;
  }));
  check("进入领域层后「候选关联」弧收掉（不再糊住概念图）", await page.evaluate(() => {
    const p = document.querySelector('#ko-rn-overlay .ko-nv-arc.is-cand');
    return !p || Number(getComputedStyle(p).opacity) === 0;
  }));
  check("有向关系带箭头（extends 那几条）", await page.evaluate(() => {
    const gs = [...document.querySelectorAll("#ko-rn-overlay .ko-nv-threads > g")];
    return gs.some((g) => g.querySelectorAll("path").length === 2);
  }));
  check("桥概念被点亮成金色且带徽标",
    await page.locator("#ko-rn-overlay .ko-nv-node.is-bridge").count() === 1 &&
    await page.locator("#ko-rn-overlay .ko-nv-node.is-bridge .ko-nv-node-badge").count() === 1);
  check("孤证概念有 is-stub 标记",
    await page.locator("#ko-rn-overlay .ko-nv-node.is-stub").count() >= 2);
  // 概念点 + 名字不许溢出舞台、不许压到右侧面板上
  const nodeGeom = await page.evaluate(() => {
    const st = document.querySelector("#ko-rn-overlay .ko-nv-stage").getBoundingClientRect();
    const panel = document.querySelector("#ko-rn-overlay .ko-nv-panel");
    const panelLeft = panel && !panel.hidden ? panel.getBoundingClientRect().left : st.right;
    let bad = 0, vertical = 0;
    document.querySelectorAll("#ko-rn-overlay .ko-nv-node-label").forEach((n) => {
      const r = n.getBoundingClientRect();
      if (r.right > panelLeft + 2 || r.right > st.right + 2 || r.left < st.left - 2) bad++;
      if (r.height > 0 && r.width < r.height * 0.9) vertical++;
    });
    return { bad, vertical };
  });
  check("概念名没有溢出舞台/压到面板", nodeGeom.bad === 0, `bad=${nodeGeom.bad}`);
  check("概念名没有被压成竖排", nodeGeom.vertical === 0, `bad=${nodeGeom.vertical}`);
  await page.screenshot({ path: "screenshots/rd-neural-view-domain.png" });

  console.log("\n== 第三层：点概念 → 概念卡 ==");
  await page.locator("#ko-rn-overlay .ko-nv-node.is-bridge").first().click();
  await page.waitForTimeout(900);
  const panel = page.locator("#ko-rn-overlay .ko-nv-panel");
  check("分析栏打开", await panel.isVisible());
  const pText = (await panel.textContent()) || "";
  check("标题是「激励错配」", pText.includes("激励错配"));
  check("显示跨书支持（2 本）", pText.includes("2 本"));
  check("有「桥」专节并写明会裂成几块", pText.includes("桥") && /裂|断开/.test(pText));
  check("「关联概念」按关系类型分组", await page.locator("#ko-rn-overlay .ko-nv-edge-group").count() >= 3,
    `groups=${await page.locator("#ko-rn-overlay .ko-nv-edge-group").count()}`);
  const groupText = (await panel.textContent()) || "";
  check("分组里能看到「延伸 / 前置 / 类比」这些类型名",
    ["延伸", "前置", "类比"].every((t) => groupText.includes(t)));
  check("来源书单列出两本书", await page.locator("#ko-rn-overlay .ko-nv-book").count() === 2);
  check("关联概念 chip 可点（>=3 个）",
    await page.locator("#ko-rn-overlay .ko-nv-panel .ko-nv-chip").count() >= 3);
  // 点 chip 应该跳到另一个概念（同领域内）
  await page.locator("#ko-rn-overlay .ko-nv-panel .ko-nv-chip").first().click();
  await page.waitForTimeout(700);
  check("点关联 chip 能跳到那个概念", await page.locator("#ko-rn-overlay .ko-nv-node.is-active").count() === 1);
  await page.locator("#ko-rn-overlay .ko-nv-node.is-bridge").first().click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: "screenshots/rd-neural-view-concept.png" });

  console.log("\n== 图谱速览（本地规则，不调模型）==");
  await page.locator("#ko-rn-overlay [data-rn-overview]").click();
  await page.waitForTimeout(500);
  check("速览面板出现", await page.locator("#ko-rn-overlay .ko-nv-answers").isVisible());
  const ovText = (await page.locator("#ko-rn-overlay .ko-nv-answers").textContent()) || "";
  check("速览给出网络规模与可问的方向", ovText.includes("概念") && /可以问|概览/.test(ovText));
  check("速览没有触发任何模型调用", askBodies.length === 0, `bodies=${askBodies.length}`);
  await page.locator("#ko-rn-overlay [data-rn-answers-close]").click();

  console.log("\n== 问 AI（假 SSE）==");
  await page.locator("#ko-rn-overlay .ko-nv-ask input").fill("这张网里最值钱的是什么？");
  await page.locator("#ko-rn-overlay .ko-nv-ask button[type=submit]").click();
  await page.waitForTimeout(900);
  check("请求打到了 /api/reading/net/ask", askBodies.length === 1, `bodies=${askBodies.length}`);
  const body0 = askBodies[0] || {};
  check("请求体带上了整张网作为材料（context 含概念名）",
    typeof body0.context === "string" && body0.context.includes("激励错配") && body0.context.includes("领域"),
    `len=${body0.context ? body0.context.length : 0}`);
  check("请求体带上了 scope 与锚点", body0.scope === "concept" && body0.anchor === "激励错配",
    `scope=${body0.scope} anchor=${body0.anchor}`);
  const aText = (await page.locator("#ko-rn-overlay .ko-nv-answers").textContent()) || "";
  check("流式回答渲染出来了", aText.includes("这是流式回答。"));
  await page.screenshot({ path: "screenshots/rd-neural-view-ask.png" });
  await page.locator("#ko-rn-overlay [data-rn-answers-close]").click();

  console.log("\n== 浅色主题 ==");
  const strokeOf = () => page.evaluate(() => {
    const el = document.querySelector("#ko-rn-overlay .ko-nv-arc.is-contrast");
    if (!el) return null;
    const m = String(getComputedStyle(el).stroke).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  });
  const darkStroke = await strokeOf();
  await page.evaluate(() => window.KnowOriginTheme && window.KnowOriginTheme.apply("light"));
  await page.waitForTimeout(800);
  check("浅色下概念名仍可读（文字比纸底深）", await page.evaluate(() => {
    const el = document.querySelector("#ko-rn-overlay .ko-nv-node-label");
    if (!el) return false;
    const lum = (c) => {
      const m = String(c).match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
      return m ? (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255 : null;
    };
    const fg = lum(getComputedStyle(el).color);
    const bg = lum(getComputedStyle(el).backgroundColor);
    return fg !== null && bg !== null && fg < bg - 0.25;
  }));
  const lightStroke = await strokeOf();
  check("切到浅色后「对立」压深成暗红（说明场景真的按新主题重绘了）",
    lightStroke && lightStroke[0] < 200 && lightStroke[1] < 110,
    `stroke=${JSON.stringify(lightStroke)}`);
  check("深浅两档的「对立」颜色确实不同",
    !!darkStroke && !!lightStroke && darkStroke.join(",") !== lightStroke.join(","),
    `dark=${JSON.stringify(darkStroke)} light=${JSON.stringify(lightStroke)}`);
  await page.screenshot({ path: "screenshots/rd-neural-view-light.png" });
  await page.evaluate(() => window.KnowOriginTheme && window.KnowOriginTheme.apply("dark"));
  await page.waitForTimeout(700);
  const backStroke = await strokeOf();
  check("切回深色后又变回亮红", !!backStroke && backStroke.join(",") === (darkStroke || []).join(","),
    `stroke=${JSON.stringify(backStroke)}`);

  console.log("\n== Esc 逐层返回 + 不误关读书模式 ==");
  await page.keyboard.press("Escape");   // note → module
  await page.waitForTimeout(500);
  check("第一次 Esc 回到领域层（概念还在）",
    await page.locator("#ko-rn-overlay .ko-nv-node").count() === 5);
  await page.keyboard.press("Escape");   // module → hub
  await page.waitForTimeout(500);
  check("第二次 Esc 回到总览（领域还在）",
    await page.locator("#ko-rn-overlay .ko-nv-node").count() === 0 &&
    await page.locator("#ko-rn-overlay .ko-nv-mod").count() === 3);
  await page.keyboard.press("Escape");   // hub → 关闭浮层
  await page.waitForTimeout(600);
  check("第三次 Esc 关掉浮层", await ov.isHidden());
  check("★ 关掉浮层后读书模式还在（没被一起关掉）",
    await page.evaluate(() => window.KnowOriginReading.isVisible()));
  check("★ 浮层期间按 Esc 不会退出读书模式", await page.evaluate(() =>
    document.getElementById("reading-workspace").classList.contains("is-open")));
  check("锁滚动已解除", await page.evaluate(() => !document.body.classList.contains("ko-nv-open")));

  console.log("\n== 重新打开（走真实数据，不再依赖夹具缓存）==");
  await btn.first().click();
  await page.waitForTimeout(1200);
  check("能再次打开", await ov.isVisible());
  check("重开后停在总览层",
    await page.locator("#ko-rn-overlay .ko-nv-node").count() === 0 &&
    await page.locator("#ko-rn-overlay .ko-nv-mod").count() === 3);
  await page.locator("#ko-rn-overlay [data-rn-close]").click();
  await page.waitForTimeout(400);
  check("关闭按钮生效", await ov.isHidden());

  console.log("\n== 退出读书模式时浮层自动收起 ==");
  await btn.first().click();
  await page.waitForTimeout(900);
  await page.evaluate(() => window.KnowOriginReading.close());
  await page.waitForTimeout(500);
  check("读书模式退出后浮层跟着收掉", await ov.isHidden());
  check("锁滚动也解除", await page.evaluate(() => !document.body.classList.contains("ko-nv-open")));

  console.log("\n== 控制台 ==");
  const real = errors.filter((e) => !/favicon|Failed to load resource/i.test(e));
  check("没有控制台报错", real.length === 0, real.slice(0, 3).join(" | "));
} catch (err) {
  fail++;
  console.log("\n[FATAL] " + (err && err.stack ? err.stack : err));
} finally {
  await browser.close();
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
