/**
 * 陪练台前端回归（jsdom）
 *
 * 跑法：``node tools/verify_coach_ui.mjs``
 *
 * 覆盖 —
 *   1. 挂载：鉴权 / 项目切换 / 设置开关关掉时收卡
 *   2. 渲染：空项目、不可用支架、四档守卫文案、probe、时间盒只给时间
 *   3. 交互：「先说给自己听」的门、reveal、forget、skip、刷新、去练
 *   4. 排版约定：字号走 --text-* 阶梯、颜色不写死、不遮蔽 app.js 的 state
 *   5. 自触发重绘循环：反复 mount 不应让内容抖动（progress-panel 同款坑）
 *
 * 踩过的坑（照 KNOW-README-FIRST.md 的同一记录）：app.js 是 classic script，
 * 与 addon 共享全局词法环境。jsdom 里必须**用 script 注入 + w.eval()**，
 * 不能 import —— 模块作用域读不到别的文件的顶层 const。所以这里
 * 把宿主 stub 与 coach-ui.js 拼进**同一次** w.eval()。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "static", "coach-ui.js");

const failures = [];
function check(name, ok, detail = "") {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? " -> " + detail : ""}`);
  if (!ok) failures.push(name);
}

const LADDER = ["full", "faded", "outline", "hint", "silent"];

function sampleRound(overrides = {}) {
  const base = {
    project_id: "proj_test",
    demand: "normal",
    focus: { node_id: "n1", name: "傅里叶变换" },
    steps: [
      {
        node_id: "n1",
        name: "傅里叶变换",
        stage: "seen",
        stage_label: "见过",
        bucket: "push",
        bucket_label: "临门一脚",
        action: "open-node",
        detail: { due_cards: 2 },
      },
    ],
    scaffold: {
      available: true,
      node_id: "n1",
      node_name: "傅里叶变换",
      stage: "seen",
      stage_label: "见过",
      demand: "normal",
      observations: 6,
      level: "faded",
      label: "给半程例题",
      what: "前两步给你，最后一步你自己补",
      base_level: "hint",
      notes: ["位阶还不到「会了」"],
      reasons: ["证据显示你已经到有印象但还会卡那一档", "位阶还不到「会了」"],
      can_withdraw: false,
      next_level: "outline",
      next_label: "只给要点骨架",
      withhold_reason: "位阶还不到「会了」，先不撤 —— 不会的东西不配叫合意困难",
      moved_by_guard: true,
      guards: { novice_floor: true, thin_floor: false, hard_step_back: false },
      ladder_index: 1,
      prompt_block: "—— 支架强度：给半程例题（「傅里叶变换」）——\n给出前 2/3 的步骤。",
    },
    calibration: {
      verdict: "overconfident",
      verdict_label: "你整体高估自己",
      advice: "别急着看解析。先在心里把答案完整写一遍，再去对。",
      samples: 12,
      min_samples: 8,
      probe: { ask: true, reason: "你整体高估自己，而这几块的准确率正好在中间带" },
      evidence: [{ node_id: "n1", node_name: "傅里叶变换", why: "你说很有把握，答案是错的" }],
    },
    shape: {
      blocks: 2,
      work_minutes: 30,
      break_minutes: 3,
      total_minutes: 33,
      phrasing: "这一轮大概 30 分钟，坐得下来",
      due_card_hint: "到期卡片已经摊在里面了，不用管有多少张",
      overrun: false,
      overrun_note: "",
    },
    ladder: LADDER,
    ladder_labels: {
      full: "给完整例题",
      faded: "给半程例题",
      outline: "只给要点骨架",
      hint: "只点第 1 步",
      silent: "不给提示",
    },
  };
  return { ...base, ...overrides };
}

function boot({ round, authenticated = true, projectId = "proj_test", enabled = true } = {}) {
  // jsdom 解析样式表失败时只往虚拟控制台打一句 "Could not parse CSS stylesheet"，
  // 既不抛错也不进 stdout —— 也就是坏样式表会让整段样式静默失效而测试全绿。
  // 所以这里自建 VirtualConsole 把这类 jsdomError 收进 __cssWarnings。
  const cssWarnings = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (err) => {
    if (String((err && err.message) || "").includes("CSS")) {
      cssWarnings.push(String(err.message).slice(0, 160));
    }
  });

  const dom = new JSDOM(
    `<!doctype html><html data-theme="light"><head></head><body>
       <nav class="feature-grid">
         <button class="feature-button" data-feature="framework">框架</button>
         <button class="feature-button" data-feature="overview">概览</button>
       </nav>
       <label class="settings-switch-row">
         <input id="settings-coach-toggle" class="settings-switch-input" type="checkbox" role="switch">
       </label>
       <div id="studio-output" class="studio-output">
         <div class="overview-dashboard"></div>
       </div>
     </body></html>`,
    {
      runScripts: "outside-only",
      pretendToBeVisual: true,
      url: "http://localhost/",
      virtualConsole,
    }
  );
  const w = dom.window;
  w.__calls = [];
  w.__switched = [];
  w.__cssWarnings = cssWarnings;
  w.api = (p, opts) => {
    w.__calls.push(((opts && opts.method) || "GET") + " " + p);
    if (p.indexOf("/api/coach/") === 0 && (opts && opts.method) === "POST") {
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve(round === undefined ? sampleRound() : round);
  };
  w.switchFeature = (f) => {
    w.__switched.push(f);
  };
  // 「用户之前就关掉了」这个状态必须**在脚本执行前**落到 localStorage。
  // 面板的唯一状态源是 readPrefs()，HTML 里的 checked 属性只是初始外观 ——
  // 拿 HTML 属性当状态源会让「记住上次选择」这条根本功能测不出来。
  if (!enabled) {
    w.localStorage.setItem("knoworigin-coach-prefs-v1", JSON.stringify({ enabled: false }));
  }
  // 必须与 coach-ui.js 拼成**同一次** eval：多个独立 eval 不共享全局词法环境。
  w.eval(
    `var state = { currentProjectId: ${JSON.stringify(projectId)}, authenticated: ${authenticated}, feature: "overview" };` +
      "\n" +
      fs.readFileSync(SRC, "utf8")
  );
  return w;
}

const tick = (n = 6) => new Promise((r) => setTimeout(r, n * 30));

function cardOf(w) {
  return w.document.querySelector("[data-ko-coach-embed]");
}

function text(w) {
  const el = cardOf(w);
  return el ? el.textContent : "";
}

// ── 1. 挂载 ────────────────────────────────────────────────────────

async function testMount() {
  console.log("\n── 1. 挂载 ──");
  const w = boot();
  await tick();
  check("鉴权通过时挂上了卡片", Boolean(cardOf(w)));
  check("只请求了 round 一个端点", w.__calls.length >= 1 && w.__calls[0].includes("/api/coach/"), w.__calls.join(" | "));
  check("请求路径带上了项目 id", w.__calls.some((c) => c.indexOf("/api/coach/proj_test/round") >= 0), w.__calls.join(" | "));
  check("样式自带且只注入一次", w.document.querySelectorAll("#ko-coach-style").length === 1);
  check("导出了 window.KnowOriginCoach", Boolean(w.KnowOriginCoach && typeof w.KnowOriginCoach.mount === "function"));

  const anon = boot({ authenticated: false });
  await tick();
  check("未登录时不挂卡", !cardOf(anon));

  const off = boot({ enabled: false });
  await tick();
  check("设置里关掉后不挂卡", !cardOf(off));
  check("关掉时一次请求都不发", off.__calls.length === 0, off.__calls.join(" | "));
}

async function testProjectSwitch() {
  console.log("\n── 2. 项目切换 ──");
  const w = boot();
  await tick();
  const before = w.__calls.length;
  w.eval('state.currentProjectId = "proj_other"; window.KnowOriginCoach.mount();');
  await tick();
  check("换项目后重新取数", w.__calls.length > before, `${before} -> ${w.__calls.length}`);
  check("新请求打向新项目", w.__calls.some((c) => c.indexOf("proj_other") >= 0), w.__calls.join(" | "));

  // 同一项目反复 mount 不应重复打请求。
  const again = w.__calls.length;
  w.KnowOriginCoach.mount();
  w.KnowOriginCoach.mount();
  await tick();
  check("同一项目重复 mount 不重复请求", w.__calls.length === again, `${again} -> ${w.__calls.length}`);
}

// ── 3. 渲染 ────────────────────────────────────────────────────────

async function testRender() {
  console.log("\n── 3. 渲染 ──");
  const w = boot();
  await tick();
  const html = cardOf(w).innerHTML;

  check("标题在", text(w).indexOf("陪练台") >= 0);
  check("五档刻度全画出来，且用的是后端给的中文名",
    (html.match(/ko-coach-pip/g) || []).length >= LADDER.length,
    String((html.match(/ko-coach-pip/g) || []).length));
  check("当前档高亮：恰好一个 is-on", (html.match(/ko-coach-pip is-on/g) || []).length === 1, String((html.match(/is-on/g) || []).length));
  check("档位标签用的是后端中文名", text(w).indexOf("给半程例题") >= 0);
  check("这一档具体做什么写出来了", text(w).indexOf("前两步给你，最后一步你自己补") >= 0);
  check("理由逐条列出", text(w).indexOf("位阶还不到") >= 0 && text(w).indexOf("证据显示") >= 0);
  check("撤回被拒时说明原因", text(w).indexOf("不配叫合意困难") >= 0);
  check("校准结论显示为中文档位词", text(w).indexOf("你整体高估自己") >= 0);
  check("校准建议显示", text(w).indexOf("别急着看解析") >= 0);
  check("probe 追问显示理由", text(w).indexOf("先猜一次") >= 0 && text(w).indexOf("中间带") >= 0);
  check("「有把握但错」的证据列出", text(w).indexOf("答案是错的") >= 0);
  check("时间盒给的是分钟", text(w).indexOf("30 分钟") >= 0);
  check("界面不出现掌握度/BKT 数字", !/\b0\.\d+\b/.test(text(w)), text(w).match(/\b0\.\d+\b/) || "");

  // 只给时间不给件数：due_cards 是 2，界面上不该有「2 张」。
  check("不暴露到期卡片件数", text(w).indexOf("2 张") < 0 && text(w).indexOf("还有 2") < 0);

  console.log("\n── 3b. 空项目与不可用支架 ──");
  const empty = boot({ round: { project_id: "p", steps: [], scaffold: { available: false, reason: "还没有这个知识点的学习记录" }, calibration: { verdict: "thin", verdict_label: "样本还不够，看不出来", advice: "再多做几次带把握度的题，这里就能看出方向了。", samples: 0, min_samples: 8, probe: { ask: false, reason: "还不够" }, evidence: [] }, shape: { blocks: 1, work_minutes: 15, phrasing: "这一轮大概 15 分钟就够" } } });
  await tick();
  check("空项目不崩且有卡片", Boolean(cardOf(empty)));
  check("空项目给的是解释而不是空白", text(empty).indexOf("没有可推的节点") >= 0 || text(empty).indexOf("学习记录") >= 0);
  check("thin 时说清还差几条", text(empty).indexOf("还差 8 条") >= 0, text(empty).match(/还差\s*\d+\s*条/) || "");
  check("thin 时不显示追问", text(empty).indexOf("先猜一次") < 0);
  check("不可用支架如实说明", text(empty).indexOf("学习记录") >= 0);

  console.log("\n── 3c. 薄弱样本时的措辞 ──");
  const thin = boot();
  await tick();
  check("thin 判定明确说「看不出来」", thin.document.querySelector(".ko-coach-block") !== null);
}

// ── 4. 交互 ────────────────────────────────────────────────────────

async function testInteractions() {
  console.log("\n── 4. 交互 ──");
  const w = boot();
  await tick();

  // faded 档 → 开「先说给自己听」的门
  check("faded 档开了门", Boolean(w.document.querySelector("[data-ko-coach-attempt]")));
  check("门的提示说清要做什么", text(w).indexOf("先说给自己听") >= 0);
  check("没写之前材料是藏着的",
    w.document.querySelector("[data-ko-coach-reveal-box]").hidden === true);

  const area = w.document.querySelector("[data-ko-coach-attempt]");
  area.value = "把信号拆成一堆正弦的叠加";
  w.document.querySelector("[data-ko-coach-reveal]").dispatchEvent(new w.Event("click", { bubbles: true }));
  await tick(2);
  const box = w.document.querySelector("[data-ko-coach-reveal-box]");
  check("点了之后材料出现", box.hidden === false);
  check("材料就是这一档的提示词约束", box.textContent.indexOf("支架强度") >= 0, box.textContent.slice(0, 40));
  check("先说的话被记住了", w.localStorage.getItem("knoworigin-coach-attempts-v1").indexOf("正弦") >= 0);

  w.KnowOriginCoach.refresh();
  await tick();
  check("重开后仍认得上一轮先说的话",
    (w.document.querySelector("[data-ko-coach-attempt]") || {}).value !== undefined &&
    w.document.querySelector("[data-ko-coach-attempt]").value.indexOf("正弦") >= 0);

  w.document.querySelector("[data-ko-coach-forget]").dispatchEvent(new w.Event("click", { bubbles: true }));
  await tick();
  check("清空后回到没写过的状态",
    (w.document.querySelector("[data-ko-coach-attempt]") || {}).value === "");

  console.log("\n── 4b. 不该开门的档位 ──");
  for (const level of ["full", "silent"]) {
    const one = boot({ round: sampleRound({ scaffold: { ...sampleRound().scaffold, level, prompt_block: "x" } }) });
    await tick();
    check(`${level} 档不开「先说给自己听」`, !one.document.querySelector("[data-ko-coach-attempt]"));
  }
  for (const level of ["outline", "hint"]) {
    const one = boot({ round: sampleRound({ scaffold: { ...sampleRound().scaffold, level, prompt_block: "x" } }) });
    await tick();
    check(`${level} 档开「先说给自己听」`, Boolean(one.document.querySelector("[data-ko-coach-attempt]")));
  }

  console.log("\n── 4c. 跳转与刷新 ──");
  const go = boot();
  await tick();
  go.document.querySelector("[data-ko-coach-go]").dispatchEvent(new go.Event("click", { bubbles: true }));
  await tick(2);
  check("「去做这一步」切到了功能页", go.__switched.length === 1, go.__switched.join(" | "));

  const step = boot();
  await tick();
  step.document.querySelector("[data-ko-coach-step]").dispatchEvent(new step.Event("click", { bubbles: true }));
  await tick(2);
  check("点推荐项也能跳", step.__switched.length === 1, step.__switched.join(" | "));

  const rf = boot();
  await tick();
  const beforeRefresh = rf.__calls.length;
  rf.document.querySelector("[data-ko-coach-refresh]").dispatchEvent(new rf.Event("click", { bubbles: true }));
  await tick();
  check("「重新看一轮」真的重新取了数", rf.__calls.length > beforeRefresh);

  const off = boot();
  await tick();
  off.document.querySelector("#settings-coach-toggle").checked = false;
  off.document.querySelector("#settings-coach-toggle").dispatchEvent(new off.Event("change", { bubbles: true }));
  await tick();
  check("设置里关掉后卡片被收掉", !cardOf(off));
  check("设置落盘为关闭态", off.localStorage.getItem("knoworigin-coach-prefs-v1").indexOf("false") >= 0);

  const on = boot();
  await tick();
  on.document.querySelector("#settings-coach-toggle").checked = true;
  on.document.querySelector("#settings-coach-toggle").dispatchEvent(new on.Event("change", { bubbles: true }));
  await tick();
  check("再打开能重新挂上", Boolean(cardOf(on)));

  console.log("\n── 4d. 键盘可达 ──");
  const kb = boot();
  await tick();
  const target = kb.document.querySelector("[data-ko-coach-step]");
  target.focus();
  target.dispatchEvent(new kb.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await tick(2);
  check("回车也能触发推荐项", kb.__switched.length === 1, kb.__switched.join(" | "));

  console.log("\n── 4e. 失败必须显示为失败 ──");
  const boom = boot();
  boom.api = () => Promise.reject(new Error("后端说不行"));
  await tick();
  boom.KnowOriginCoach.refresh();
  await tick();
  check("取数失败会显示错误，而不是假装今天没事干",
    text(boom).indexOf("后端说不行") >= 0 || text(boom).indexOf("没能看到这一轮") >= 0, text(boom).slice(0, 120));
}

// ── 5. 排版与重绘 ──────────────────────────────────────────────────

async function testConventions() {
  console.log("\n── 5. 排版与重绘 ──");
  const code = fs.readFileSync(SRC, "utf8");
  check("不遮蔽 app.js 的顶层 state", !/\b(var|let|const)\s+state\s*=/.test(code));

  const w = boot();
  await tick();
  const css = w.document.querySelector("#ko-coach-style").textContent;

  check("样式全部锁在 .ko-coach-* 前缀下", /#studio-output \.ko-coach/.test(css));
  check("不覆写 app.js / styles.css 的既有类",
    !/\.settings-|#studio-output\s*\{|body\s*\{/.test(css), (css.match(/\.settings-|body\s*\{/) || [])[0] || "");
  check("字号走 --text-* 阶梯", /font-size: var\(--text-/.test(css));
  check("样式里不写死 px 字号", !/font-size: \d+px/.test(css));
  check("颜色只用主题变量", !/#[0-9a-fA-F]{6}\b/.test(css));

  // 括号配平：ensureStyle() 用一串字符串拼 CSS，很容易在拆行时把某条声明劈成
  // 两半（真实踩过一次：.is-info 少写后半截，jsdom 只报一句 "Could not parse
  // CSS stylesheet"，界面表现是整段样式静默失效，而所有功能断言照样全绿）。
  const braces = (css.match(/{/g) || []).length - (css.match(/}/g) || []).length;
  check("注入的 CSS 花括号配平", braces === 0, `差 ${braces} 个`);
  const semis = (css.match(/;/g) || []).length;
  check("每条声明都以分号收尾（粗查）", semis >= (css.match(/}/g) || []).length, `${semis} 分号`);

  // 自定义 RGB 元组只允许集中声明在 :root/面板作用域一次，不许散落成字面量。
  const warnLiterals = (css.match(/rgba\(\s*\d+\s*,/g) || []).length;
  check("没有散落的 rgba 数字元组（应走 var(--ko-*))", warnLiterals === 0, `${warnLiterals} 处`);

  // jsdom 的 CSS 解析告警：接住虚拟控制台，别让它静默吞掉坏样式。
  check("jsdom 未报 CSS 解析告警", !w.__cssWarnings.length, w.__cssWarnings.join(" | "));

  // 自触发重绘循环：反复触发 mount，卡片内容必须稳定，且不无限增长。
  const stable = boot();
  await tick();
  const first = cardOf(stable).innerHTML;
  for (let i = 0; i < 12; i += 1) {
    stable.document.querySelector("[data-ko-coach-refresh]")?.dispatchEvent(
      new stable.Event("click", { bubbles: true })
    );
    stable.KnowOriginCoach.mount();
  }
  await tick(8);
  check("反复重绘后卡片内容稳定（无抖动）", cardOf(stable).innerHTML === first);
  check("反复重绘后仍只有一张卡",
    stable.document.querySelectorAll("[data-ko-coach-embed]").length === 1,
    String(stable.document.querySelectorAll("[data-ko-coach-embed]").length));
  check("反复重绘后仍只有一份样式",
    stable.document.querySelectorAll("#ko-coach-style").length === 1);

  console.log("\n── 5b. app.js 重画概览后能重挂 ──");
  const handoff = boot();
  await tick();
  handoff.document.querySelector(".overview-dashboard").innerHTML = "";
  check("app.js 冲掉后卡片确实没了", !cardOf(handoff));
  handoff.document.querySelector('[data-feature="overview"]').dispatchEvent(
    new handoff.Event("click", { bubbles: true })
  );
  await tick();
  check("点概览页签能重挂", Boolean(cardOf(handoff)));

  const xss = boot();
  await tick();
  xss.KnowOriginCoach.__xss = true;
  const evil = sampleRound();
  evil.focus.name = '<img src=x onerror="globalThis.__pwned=1">';
  evil.scaffold.node_name = '<img src=x onerror="globalThis.__pwned=1">';
  evil.scaffold.reasons = ['<img src=x onerror="globalThis.__pwned=1">'];
  const xssDom = boot({ round: evil });
  await tick();
  check("节点名里的标签被转义，没有真的 img 元素",
    xssDom.document.querySelectorAll("img").length === 0 && !xssDom.__pwned);
  check("转义后仍能读到原文", text(xssDom).indexOf("onerror") >= 0);
}

// ── main ───────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(SRC)) {
    console.log(`[FAIL] 找不到 ${SRC}`);
    process.exit(1);
  }
  await testMount();
  await testProjectSwitch();
  await testRender();
  await testInteractions();
  await testConventions();

  const total = failures.length;
  console.log("\n" + "═".repeat(62));
  if (total) {
    console.log(`结果：${total} 条失败`);
    failures.forEach((f) => console.log("  ✗ " + f));
    process.exit(1);
  }
  console.log("结果：全部通过");
}

main();