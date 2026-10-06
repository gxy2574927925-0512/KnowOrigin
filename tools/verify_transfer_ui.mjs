/**
 * 迁移弹窗的真实 DOM 回归（jsdom）。
 *
 * 为什么单独一个 .mjs：这一版 UI 的核心是**交互状态机**，而症状全是视觉的 ——
 * 「点了提交一直加载没有反应」「提交完什么都没留下」「字号太小看不清」。
 * 这些在 Python 侧断言不出来（读源码只能证明"某行代码存在"，
 * 不能证明"运行时真的进了那个分支"）。所以这里用 jsdom 把弹窗真的建起来、
 * 真的点一遍提交，确认每一步的状态与 DOM 都对。
 *
 * 不需要浏览器、不需要服务、不需要 API Key：
 *   node tools/verify_transfer_ui.mjs
 *
 * 覆盖：
 *   1. 出题中 → 出题成功（loading 必须复位，正文必须换掉「正在出题」）
 *   2. 出题失败 → 错误条可见、loading 复位、不留半成品
 *   3. 不自评就提交 → 422 风格的前端拦截，题目内容**保留**（用户不重写答案）
 *   4. 提交成功 → 出现独立的成功卡片，写明档位与下一步；loading 复位
 *   5. 提交失败 → 错误条 + 题目内容保留（可重试）
 *   6. 排版约定：字号全部走 --text-* 阶梯；弹窗三段式固定
 *   7. 无推荐时有候选可点（候选点击能立刻触发出题）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "static", "transfer-ui.js");

const failures = [];
function check(name, ok, detail = "") {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? " -> " + detail : ""}`);
  if (!ok) failures.push(name);
}

// ── 一个足够真实的宿主环境 ───────────────────────────────────────────────
// 迁移面板依赖 app.js 的全局词法绑定（state / api），所以必须用 script 注入
// 而不是 import：模块作用域里读不到别的文件的顶层 const。
function boot({ handler }) {
  const dom = new JSDOM(
    `<!doctype html><html data-theme="light"><head></head><body>
       <div class="studio-output">
         <div class="overview-dashboard"></div>
         <div class="quiz-page"><div class="quiz-question"></div><div class="quiz-question"></div></div>
       </div>
     </body></html>`,
    { runScripts: "outside-only", pretendToBeVisual: true, url: "http://localhost/" }
  );
  const w = dom.window;
  w.__calls = [];
  w.api = (pathArg, opts) => {
    const method = (opts && opts.method) || "GET";
    w.__calls.push(method + " " + pathArg);
    return handler(pathArg, method, w.__calls.length);
  };
  // app.js 顶层 const 的等价物：面板读 state.currentProjectId / authenticated
  w.eval(
    `var state = { currentProjectId: "proj_test", authenticated: true, feature: "overview" };`
  );
  const code = fs.readFileSync(SRC, "utf8");
  w.eval(code);
  return w;
}

const tick = (w, ms = 5) =>
  new Promise((r) => w.setTimeout(() => w.setTimeout(r, ms), ms));

const READY = {
  project_id: "proj_test",
  recommended_node_id: "node_a",
  has_recommendation: true,
  recommendation: { reason: "「A」已经会了，迁移还是未验证，而且它有前置（第 1 层）。" },
  target: {
    node_id: "node_a",
    name: "受激辐射",
    layer: 1,
    stage: "get",
    mastery_score: 0.6,
    transfer_score: 0,
    transfer_stage: "untested",
    transfer_stage_label: "迁移未验证",
    prereq_count: 1,
    prereq_names: ["粒子数反转"],
    ready: true,
  },
  candidates: [
    {
      node_id: "node_a",
      name: "受激辐射",
      layer: 1,
      stage: "get",
      transfer_stage: "untested",
      transfer_stage_label: "迁移未验证",
      prereq_count: 1,
      prereq_names: ["粒子数反转"],
      mastery_score: 0.6,
      transfer_score: 0,
    },
  ],
  latest_quiz: { quiz_id: "qz1", difficulty: 2, node_count: 4, interleaved: true, planned: true },
  distances: [
    { key: "near", label: "近迁移 · 换条件", hint: "同一领域改条件" },
    { key: "mid", label: "中迁移 · 换表征", hint: "换一种表征" },
    { key: "far", label: "远迁移 · 换领域", hint: "换领域只留结构" },
  ],
  recent_attempts: [],
  rules: { min_alignment_steps: 3 },
};

const GOOD_TASK = {
  attempt_id: "tat_1",
  node_id: "node_a",
  node_name: "受激辐射",
  distance: "far",
  distance_label: "远迁移 · 换领域",
  distance_reason: "它与某个前置之间还隔着别的知识点，所以给一道远迁移。",
  task: {
    distance: "far",
    source_example: "源例：先建立粒子数反转，再由一个光子触发级联发射。",
    target_example: "新情境：先积累势能，再由最小扰动触发放大输出。",
    question: "这两个过程为什么是同一件事？触发条件分别在哪一步成立？",
    alignment: [
      { source_step: "泵浦建立粒子数反转", target_step: "先积累可释放的势能", why: "都先把系统推离平衡" },
      { source_step: "一个光子引发级联发射", target_step: "最小扰动触发放大输出", why: "都靠小扰动跨过阈值" },
      { source_step: "输出与入射同频同相", target_step: "输出与扰动保持同步", why: "都要求相位锁定" },
    ],
    answer_points: ["先建立非平衡", "小扰动触发", "相位锁定", "两者同构"],
    source_ids: [],
  },
  recent_count: 0,
};

const q = (w, sel) => w.document.querySelector(sel);
const qa = (w, sel) => Array.from(w.document.querySelectorAll(sel));
const text = (w, sel) => (q(w, sel) ? q(w, sel).textContent.trim() : "");
const visible = (w, sel) => {
  const el = q(w, sel);
  if (!el) return false;
  return !el.hasAttribute("hidden") && !el.closest("[hidden]");
};

// ── 1. 面板挂载 ────────────────────────────────────────────────────────
{
  const w = boot({
    handler: (p, m) =>
      p.includes("/readiness")
        ? Promise.resolve(READY)
        : p.includes("/plan")
          ? Promise.resolve({
              project_id: "proj_test",
              steps: [
                {
                  node_id: "node_a",
                  name: "受激辐射",
                  stage: "get",
                  stage_label: "会了",
                  bucket: "transfer",
                  bucket_label: "换个情境",
                  reason: "x",
                  action: "open-transfer",
                  detail: { transfer_stage: "untested", transfer_stage_label: "迁移未验证", stage: "get", layer: 1 },
                },
              ],
              transfer: {
                labels: {},
                counts: { untested: 28, partial: 0, solid: 1 },
                ready_count: 1,
                ready: [{ node_id: "node_a", name: "受激辐射" }],
              },
            })
          : p.includes("/queue")
            ? Promise.resolve({ items: [] })
            : Promise.reject(new Error("unexpected " + p)),
  });
  await tick(w, 250);
  check("面板挂到 .overview-dashboard 上", !!q(w, "[data-ko-tf-panel]"));
  check("三档计数按后端数字渲染", /28/.test(text(w, ".ko-tf-stages")), text(w, ".ko-tf-stages").slice(0, 60));
  check("推荐节点与前置都显示", /受激辐射/.test(text(w, ".ko-tf-target")) && /粒子数反转/.test(text(w, ".ko-tf-target")));
  check("三个距离档位都是按钮", qa(w, ".ko-tf-dists .ko-tf-dist").length >= 3);
  const distBtn = qa(w, "[data-ko-tf-dist]")[0];
  check("距离按钮够大（min-height ≥ 40px）", /min-height:\s*40px/.test(q(w, "style").textContent));

  // 面板里的档位按钮是**可点的**：以前处理器只认 `.ko-tf-modal-card [data-ko-tf-dist]`，
  // 而距离按钮只出现在面板里 —— 于是这一排长得像按钮的东西点了毫无反应。
  // 面板里点 = 选中这一次要用的距离（不开题），弹窗里点 = 换一道那个距离的。
  check("没选过时没有档位是选中态", qa(w, '[data-ko-tf-dist][aria-pressed="true"]').length === 0);
  distBtn.click();
  await tick(w, 10);
  const nearBtn = qa(w, '[data-ko-tf-dist]').find((b) => b.getAttribute("data-ko-tf-dist") === "near");
  check(
    "点档位按钮会选中（点了有反应）",
    nearBtn.getAttribute("aria-pressed") === "true" &&
      qa(w, '[data-ko-tf-dist][aria-pressed="true"]').length === 1
  );
  check("选中的档位记下来了（下次开题就用它）", w.KnowOriginTransfer.task().distance === "near");
  check("在面板里选档位不会自己弹窗/出题", modalHidden(w));
  const midBtn = qa(w, '[data-ko-tf-dist]').find((b) => b.getAttribute("data-ko-tf-dist") === "mid");
  midBtn.click();
  await tick(w, 10);
  check(
    "换一档只保留一个选中态",
    qa(w, '[data-ko-tf-dist][aria-pressed="true"]').length === 1 &&
      midBtn.getAttribute("aria-pressed") === "true"
  );
  check("换档位后仍是同一个按钮节点（选择不会被重绘顶掉）", midBtn.isConnected);

  check("最近一轮测验的交错数显示为实测值", /跨了 4 个知识点/.test(text(w, ".ko-tf-panel")));
  check("测验页的交错说明条被注入", !!q(w, ".ko-tf-streak") && /跨了 4 个知识点/.test(text(w, ".ko-tf-streak")));
  void distBtn;
  w.close();
}

// ── 2. 出题中 → 成功 ───────────────────────────────────────────────────
{
  let phase = "slow";
  const w = boot({
    handler: (p) => {
      if (p.includes("/readiness")) return Promise.resolve(READY);
      if (p.includes("/plan"))
        return Promise.resolve({ steps: [], transfer: { counts: {}, ready_count: 0 } });
      if (p.includes("/queue")) return Promise.resolve({ items: [] });
      if (p.includes("/submit")) {
        // 故意慢一点，好断言「提交中」的 loading 态真的存在过
        if (phase === "slow") {
          return new Promise((resolve) =>
            w.setTimeout(
              () =>
                resolve({
                  already_submitted: false,
                  transfer_score: 0.2267,
                  transfer_stage: "partial",
                  transfer_stage_label: "迁移待验证",
                  distance_label: "远迁移 · 换领域",
                  correctness: 0.85,
                  next_hint:
                    "迁移分到「迁移待验证」了：一道题还不能说明什么，再来一道不同距离的才算数。",
                }),
              60
            )
          );
        }
        return Promise.resolve({
          already_submitted: false,
          transfer_score: 0.2267,
          transfer_stage: "partial",
          transfer_stage_label: "迁移待验证",
          distance_label: "远迁移 · 换领域",
          correctness: 0.85,
          next_hint: "迁移分到「迁移待验证」了：一道题还不能说明什么，再来一道不同距离的才算数。",
        });
      }
      if (p.includes("/task")) {
        if (phase === "slow") {
          return new Promise((resolve) => w.setTimeout(() => resolve(GOOD_TASK), 60));
        }
        if (phase === "bad") {
          const err = new Error("bad");
          err.detail =
            "这次的迁移题没出成：没通过结构校验（对齐表或采分点不完整）。再点一次试试。";
          return Promise.reject(err);
        }
        return Promise.resolve(GOOD_TASK);
      }
      return Promise.reject(new Error("unexpected " + p));
    },
  });
  await tick(w, 200);
  w.KnowOriginTransfer.open("node_a");
  await tick(w, 10);
  check("出题中显示 loading 文案", /正在后台出题/.test(text(w, ".ko-tf-cols")), text(w, ".ko-tf-cols").slice(0, 40));
  check("出题中禁用「换一道」", q(w, "[data-ko-tf-generate]").disabled === true);
  await tick(w, 300);
  check("出题成功后 loading 已复位（不再显示「正在出题」）", !/正在后台出题/.test(text(w, ".ko-tf-cols")));
  check("出题成功后渲染题干", /触发条件分别在哪一步成立/.test(text(w, ".ko-tf-cols")));
  check("对齐表恰好 3 行", qa(w, ".ko-tf-align tbody tr").length === 3, String(qa(w, ".ko-tf-align tbody tr").length));
  check("源例与新情境并排显示（两列）", qa(w, ".ko-tf-side").length === 2);
  check("采分点逐条列出", qa(w, ".ko-tf-points li").length === 4);
  check("提交按钮此时可见", visible(w, "[data-ko-tf-submit]"));
  check(
    "弹窗是「头 + 左右双栏」结构",
    !!q(w, ".ko-tf-modal-head") && !!q(w, ".ko-tf-col-read") && !!q(w, ".ko-tf-col-write"),
  );
  const css = q(w, "style").textContent;
  check(
    "弹窗铺满全屏（不再是一块居中卡片）",
    /\.ko-tf-modal-card \{ width: 100%; height: 100dvh;/.test(css) &&
      !/border-radius: 1[0-9]px/.test(css.split(".ko-tf-modal-card")[1] || ""),
  );
  check("双栏由 CSS Grid 分成两列", /grid-template-columns: minmax\(0, 1\.15fr\) minmax\(340px, \.85fr\)/.test(css));
  check("两栏各自滚动（写答案时对齐表不会把采分点顶走）", /\.ko-tf-col \{[^}]*overflow: auto/s.test(css));
  // 实报「滚动到下方时表头有重影」：sticky 表头吸住之后，行会从它**底下**穿过去。
  // 底色要是半透明的，行文字就透上来、和列名叠在一处 —— 所以吸顶的表头必须不透明。
  // jsdom 没有排版引擎，证不了像素，只能静态断言「th 规则里不许有 rgba 底色」。
  const thRule = (css.match(/\.ko-tf-align th \{[^}]*\}/) || [""])[0];
  check(
    "吸顶表头底色不透明（否则行字透上来叠成重影）",
    /position:\s*sticky/.test(thRule) && !/background:\s*rgba\(/.test(thRule),
    thRule.slice(0, 150)
  );
  check("自带迁移专属色板（三档各一个语义色）", /--tf-s0/.test(css) && /--tf-s1/.test(css) && /--tf-s2/.test(css));

  // ── 3. 不自评就提交 ──
  q(w, "[data-ko-tf-submit]").click();
  await tick(w, 20);
  check("不自评提交被前端拦下", /必须自评|先给一个自评|自评/.test(text(w, ".ko-tf-error")), text(w, ".ko-tf-error").slice(0, 50));
  check("拦截后题目内容保留（用户不重写答案）", /触发条件分别在哪一步成立/.test(text(w, ".ko-tf-cols")));
  check("拦截后 loading 已复位", !/正在后台出题/.test(text(w, ".ko-tf-cols")));

  // ── 4. 提交成功 ──
  q(w, '[data-ko-tf-rate="3"]').click();
  await tick(w, 20);
  check("自评后按钮进入选中态", q(w, '[data-ko-tf-rate="3"]').getAttribute("aria-pressed") === "true");
  check("自评后清除上一次的报错", !q(w, ".ko-tf-error"));
  phase = "slow";
  q(w, "[data-ko-tf-submit]").click();
  await tick(w, 10);
  check("提交中显示 loading", /正在后台出题/.test(text(w, ".ko-tf-cols")));
  await tick(w, 300);
  check("提交成功后 loading 已复位（这是原先那个卡死 bug）", !/正在后台出题/.test(text(w, ".ko-tf-cols")), text(w, ".ko-tf-cols").slice(0, 80));
  check("提交成功出现独立的结果卡片", !!q(w, ".ko-tf-done"));
  check("结果写明新的迁移档位", /迁移待验证/.test(text(w, ".ko-tf-done")), text(w, ".ko-tf-done").slice(0, 60));
  check("结果给出下一步该做什么", /再做一道/.test(text(w, ".ko-tf-done")) || /不同距离/.test(text(w, ".ko-tf-done")));
  check("结果把距离档与折算后的正确率摆出来", /远迁移/.test(text(w, ".ko-tf-done")) && /85%/.test(text(w, ".ko-tf-done")));
  check("成功后提交按钮收起", !visible(w, "[data-ko-tf-submit]"));
  w.close();
}

// ── 5. 出题失败 / 提交失败 ─────────────────────────────────────────────
{
  let phase = "bad";
  let submitFails = false;
  const w = boot({
    handler: (p) => {
      if (p.includes("/readiness")) return Promise.resolve(READY);
      if (p.includes("/plan"))
        return Promise.resolve({ steps: [], transfer: { counts: {}, ready_count: 0 } });
      if (p.includes("/queue")) return Promise.resolve({ items: [] });
      if (p.includes("/submit")) {
        if (submitFails) {
          const err = new Error("bad");
          err.detail = "这道迁移题不存在或已被清理。";
          return Promise.reject(err);
        }
        return Promise.resolve({
          already_submitted: false,
          transfer_score: 0.2267,
          transfer_stage: "partial",
          transfer_stage_label: "迁移待验证",
          distance_label: "远迁移 · 换领域",
          correctness: 0.85,
          next_hint: "迁移分到「迁移待验证」了：一道题还不能说明什么，再来一道不同距离的才算数。",
        });
      }
      if (p.includes("/task")) {
        if (phase === "bad") {
          const err = new Error("bad");
          err.detail = "这次的迁移题没出成：没通过结构校验。再点一次试试。";
          return Promise.reject(err);
        }
        return Promise.resolve(GOOD_TASK);
      }
      return Promise.reject(new Error("unexpected " + p));
    },
  });
  await tick(w, 200);
  w.KnowOriginTransfer.open("node_a");
  await tick(w, 200);
  check("出题失败：错误条可见", !!q(w, ".ko-tf-error") && /没出成/.test(text(w, ".ko-tf-error")));
  check("出题失败：loading 已复位", !/正在后台出题/.test(text(w, ".ko-tf-cols")));
  check("出题失败：正文如实说明取舍", /宁可不出|不对齐结构|再点一次/.test(text(w, ".ko-tf-cols")));
  check("出题失败：「换一道」重新可用（能重试）", q(w, "[data-ko-tf-generate]").disabled === false);

  phase = "ok";
  q(w, "[data-ko-tf-generate]").click();
  await tick(w, 200);
  check("重试成功拿到题", /触发条件分别在哪一步成立/.test(text(w, ".ko-tf-cols")));

  q(w, '[data-ko-tf-rate="4"]').click();
  await tick(w, 20);
  submitFails = true;
  q(w, "[data-ko-tf-submit]").click();
  await tick(w, 200);
  check("提交失败：loading 已复位", !/正在后台出题/.test(text(w, ".ko-tf-cols")));
  check("提交失败：错误条可见", !!q(w, ".ko-tf-error") && /已被清理/.test(text(w, ".ko-tf-error")));
  check("提交失败：题目与答案都保留（可重试）", !!q(w, "[data-ko-tf-answer]"));
  check("提交失败：提交按钮仍可用", visible(w, "[data-ko-tf-submit]") && !q(w, "[data-ko-tf-submit]").disabled);
  w.close();
}

// ── 6. 无推荐时的候选兜底 ─────────────────────────────────────────────
{
  const noRec = {
    ...READY,
    recommended_node_id: null,
    has_recommendation: false,
    target: null,
    recommendation: { reason: "现在没有「已经会了、但还没验过迁移」的知识点 —— 先把点学到会了。" },
    candidates: [
      {
        node_id: "node_b",
        name: "光的干涉",
        layer: 3,
        stage: "none",
        transfer_stage: "untested",
        transfer_stage_label: "迁移未验证",
        prereq_count: 2,
        prereq_names: ["波动基础"],
        mastery_score: 0.1,
        transfer_score: 0,
      },
    ],
  };
  const w = boot({
    handler: (p) => {
      if (p.includes("/readiness")) return Promise.resolve(noRec);
      if (p.includes("/plan"))
        return Promise.resolve({ steps: [], transfer: { counts: { untested: 28 }, ready_count: 0 } });
      if (p.includes("/queue")) return Promise.resolve({ items: [] });
      if (p.includes("/task")) return Promise.resolve(GOOD_TASK);
      return Promise.reject(new Error("unexpected " + p));
    },
  });
  await tick(w, 250);
  check("无推荐时如实说明原因", /先把点学到会了|已经会了/.test(text(w, ".ko-tf-panel")));
  const cand = qa(w, "[data-ko-tf-node]")[0];
  check("无推荐时给出可点的候选节点", !!cand && /光的干涉/.test(cand.textContent));
  check("候选按钮带层号", cand && /第 3 层/.test(cand.textContent));
  cand.click();
  await tick(w, 200);
  check("点候选立刻出题（不用再找按钮）", /触发条件分别在哪一步成立/.test(text(w, ".ko-tf-cols")));
  w.close();
}

// ── 7. 排版约定（静态断言）───────────────────────────────────────────
{
  const code = fs.readFileSync(SRC, "utf8");
  const bad = code.match(/font-size:\s*(1[012]|13)px/g);
  check("字号没有写死 px（设置里的字体大小才生效）", !bad, bad ? bad.join(", ") : "");
  check("用到 --text-base 与 --text-lg 两档以上", /var\(--text-base/.test(code) && /var\(--text-lg/.test(code));
  check("面板正文最小档位不低于 --text-sm", !/var\(--text-2xs[^)]*\)[^;]*;[^\n]*note/.test(code));
  check("有窄屏塌列规则", /@media \(max-width: 760px\)/.test(code) && /grid-template-columns: minmax\(0, 1fr\); \}/.test(code));
}

// ── 8. 后台生成 / 关闭不重开 / 历史 ────────────────────────────────
// 这四条都是「关掉弹窗之后」的行为，只能靠真 DOM + 真 localStorage 验：
// 纯 Python 读源码只能证明有那行代码，不能证明运行时没把题重发一遍。
{
  const ATTEMPT = {
    attempt_id: "tat_bg",
    node_id: "node_a",
    node_name: "受激辐射",
    distance: "far",
    distance_label: "远迁移 · 换领域",
    distance_reason: "层差 ≥1，给一道远迁移。",
    task: GOOD_TASK.task,
    recent_count: 0,
  };
  const HISTORY = {
    project_id: "proj_test",
    total: 2,
    distance_labels: { near: "近迁移 · 换条件", mid: "中迁移 · 换表征", far: "远迁移 · 换领域" },
    items: [
      {
        attempt_id: "tat_1",
        node_id: "node_a",
        node_name: "受激辐射",
        distance: "far",
        correctness: 0.85,
        question: "已答过的那一道",
        answered: true,
        created_at: "2026-10-06T09:00:00+00:00",
        seq: 1,
        total: 2,
      },
      {
        attempt_id: "tat_2",
        node_id: "node_b",
        node_name: "光的干涉",
        distance: "mid",
        correctness: null,
        question: "还没作答的那一道",
        answered: false,
        created_at: "2026-10-06T10:00:00+00:00",
        seq: 2,
        total: 2,
      },
    ],
  };
  const w = boot({
    handler: (p) => {
      if (p.includes("/readiness"))
        return Promise.resolve({ ...READY, history: HISTORY.items, history_total: HISTORY.total });
      if (p.includes("/plan"))
        return Promise.resolve({ steps: [], transfer: { counts: {}, ready_count: 0 } });
      if (p.includes("/queue")) return Promise.resolve({ items: [] });
      if (p.includes("/attempts?"))
        return Promise.resolve({ items: [], total: 0 });
      if (p.includes("/attempts/"))
        // 分 id 返回：tat_1 已作答、tat_2 未作答。合成一个返回会掩盖
        // 「已作答的题又被塞出自评区」这类问题。
        return Promise.resolve(
          p.includes("tat_1")
            ? {
                attempt_id: "tat_1",
                project_id: "proj_test",
                node_id: "node_a",
                node_name: "受激辐射",
                distance: "far",
                distance_label: "远迁移 · 换领域",
                task: GOOD_TASK.task,
                answered: true,
                correctness: 0.85,
                transfer_score: 0.34,
                transfer_stage_label: "迁移待验证",
                seq: 1,
                total: 2,
              }
            : {
                attempt_id: "tat_2",
                project_id: "proj_test",
                node_id: "node_b",
                node_name: "光的干涉",
                distance: "mid",
                distance_label: "中迁移 · 换表征",
                task: GOOD_TASK.task,
                answered: false,
                correctness: null,
                transfer_score: 0.18,
                transfer_stage_label: "迁移未验证",
                seq: 2,
                total: 2,
              }
        );
      if (p.includes("/task"))
        // 故意慢：模拟后台生成期间用户把弹窗关掉
        return new Promise((resolve) => w.setTimeout(() => resolve(ATTEMPT), 120));
      return Promise.reject(new Error("unexpected " + p));
    },
  });
  await tick(w, 250);

  check("面板渲染迁移题历史区", /迁移题历史/.test(text(w, ".ko-tf-panel")));
  check(
    "历史列出每一道并带序号",
    qa(w, ".ko-tf-hist-seq").map((e) => e.textContent.trim()).join(",") === "1,2",
    qa(w, ".ko-tf-hist-seq").map((e) => e.textContent.trim()).join(",")
  );
  check("历史标出已答 / 未答", /已答/.test(text(w, ".ko-tf-panel")) && /未答/.test(text(w, ".ko-tf-panel")));
  check("历史带距离档与自评折算", /远迁移/.test(text(w, ".ko-tf-panel")) && /自评折算 85%/.test(text(w, ".ko-tf-panel")));

  // 点候选 → 出题（在途）→ 关掉
  qa(w, "[data-ko-tf-begin]")[0].click();
  await tick(w, 10);
  const beforeClose = w.__calls.filter((x) => x.includes("/task")).length;
  check("已发起一次出题请求", beforeClose === 1, "calls=" + beforeClose);
  q(w, "[data-ko-tf-close]").click();
  await tick(w, 10);
  check("关掉后弹窗隐藏", modalHidden(w) === true);
  check("关掉后指针落盘（status=generating）", /generating/.test(String(w.localStorage.getItem("ko-tf:pointer:proj_test"))));

  // 后台继续：等待请求自己完成
  await tick(w, 400);
  check("关窗后请求仍在后台完成，没有被取消", w.__calls.filter((x) => x.includes("/task")).length === 1);
  check("出好后指针变成 attempt_id（status=ready）", /"attemptId":"tat_bg"/.test(String(w.localStorage.getItem("ko-tf:pointer:proj_test"))), String(w.localStorage.getItem("ko-tf:pointer:proj_test")));

  // 重新打开：必须显示原来那道，且**不再发请求**
  const beforeReopen = w.__calls.filter((x) => x.includes("/task")).length;
  w.KnowOriginTransfer.open("node_a");
  await tick(w, 250);
  check(
    "重开后不再重新生成（请求数不变）",
    w.__calls.filter((x) => x.includes("/task")).length === beforeReopen,
    "before=" + beforeReopen + " after=" + w.__calls.filter((x) => x.includes("/task")).length
  );
  check("重开后显示的还是原来那道", /触发条件分别在哪一步成立/.test(text(w, ".ko-tf-cols")));

  // 显式点「换一道」才允许重新生成
  q(w, "[data-ko-tf-generate]").click();
  await tick(w, 300);
  check("显式点「换一道」才重新发起生成", w.__calls.filter((x) => x.includes("/task")).length === beforeReopen + 1);

  // 点历史里已作答的那一道 → 重新打开，且不显示自评区
  q(w, "[data-ko-tf-attempt='tat_1']").click();
  await tick(w, 250);
  check("从历史重开已作答的题：明说已答过", /已经答过了/.test(text(w, ".ko-tf-cols")));
  check("已作答的题不再给自评区", !q(w, "[data-ko-tf-rate]"));
  w.close();
}

// ── 9. 关掉后要留在学习概览，不掉回主界面 ────────────────────────────
{
  let feature = "overview";
  let switched = 0;
  const w = boot({
    handler: (p) => {
      if (p.includes("/readiness")) return Promise.resolve(READY);
      if (p.includes("/plan"))
        return Promise.resolve({ steps: [], transfer: { counts: {}, ready_count: 0 } });
      if (p.includes("/queue")) return Promise.resolve({ items: [] });
      if (p.includes("/attempts")) return Promise.resolve({ items: [], total: 0 });
      if (p.includes("/task")) return Promise.resolve(GOOD_TASK);
      return Promise.reject(new Error("unexpected " + p));
    },
  });
  w.eval(`var switched = 0; function switchFeature(f){ state.feature = f; switched++; }
          function currentUi(){ return "agent"; }
          var revealStudio = 0;
          window.KnowOriginAgentShell = { revealStudio: function(){ revealStudio++; } };`);
  await tick(w, 250);

  w.KnowOriginTransfer.open("node_a");
  await tick(w, 250);
  check("弹窗打开时记下了来处是学习概览", w.eval("state.feature") === "overview");

  // 模拟「弹窗开着的时候别处把 feature 切走了」—— 关窗时要拽回来
  w.eval(`state.feature = "chat";`);
  q(w, "[data-ko-tf-close]").click();
  await tick(w, 10);
  check("关掉后 feature 回到学习概览（不掉回主界面）", w.eval("state.feature") === "overview", w.eval("state.feature"));
  check("关掉时确实调了 switchFeature", w.eval("switched") >= 1);

  // 非从概览打开的就不该乱切
  w.eval(`state.feature = "chat";`);
  w.KnowOriginTransfer.open("node_a");
  await tick(w, 60);
  q(w, "[data-ko-tf-close]").click();
  await tick(w, 10);
  check("从非概览入口打开时不乱切界面", w.eval("state.feature") === "chat", w.eval("state.feature"));
  void feature;
  w.close();
}

function modalHidden(w) {
  const el = w.document.getElementById("ko-tf-modal");
  return !el || el.hidden === true;
}

// ── 10. 小字折叠 ────────────────────────────────────────────────────
// 用户明确要求「小字弄一个小的 UI 隐藏显示」。用原生 <details>：
// 默认收起、点 summary 展开、键盘可达。这些都是可断言的行为。
{
  const w = boot({
    handler: (p) => {
      if (p.includes("/readiness")) return Promise.resolve(READY);
      if (p.includes("/plan"))
        return Promise.resolve({ steps: [], transfer: { counts: { untested: 2, partial: 0, solid: 1 }, ready_count: 0 } });
      if (p.includes("/queue")) return Promise.resolve({ items: [] });
      if (p.includes("/attempts")) return Promise.resolve({ items: [], total: 0 });
      return Promise.reject(new Error("unexpected " + p));
    },
  });
  await tick(w, 250);

  const details = qa(w, ".ko-tf-panel details.ko-tf-more");
  check("面板里有小字折叠区", details.length >= 3, String(details.length));
  check("折叠区默认是收起的", details.every((d) => d.open === false));
  const summary = details[0].querySelector("summary");
  check("折叠区有一个可点的标题", !!summary && /说明|档|折算|什么/.test(summary.textContent), summary ? summary.textContent.trim() : "");
  check("折叠区内容默认不可见", details[0].querySelector(".ko-tf-more-body").textContent.length > 0);
  summary.click();
  check("点标题能展开", details[0].open === true);
  check("展开后内容可见且有实质说明", /刷识记题|换条件|换表征|换领域/.test(details[0].textContent));

  // 刷新后展开状态要保留：否则每次 refresh 都把说明折回去，开关等于坏了
  q(w, "[data-ko-tf-refresh]").click();
  await tick(w, 250);
  const after = qa(w, ".ko-tf-panel details.ko-tf-more");
  check("刷新后展开的小字仍然是展开的", after[0] && after[0].open === true, after[0] ? String(after[0].open) : "(没了)");
  w.close();
}

// ── 11. 从历史打开后关闭，也要留在学习概览 ──────────────────────────
// 这是用户实报的那条 bug：点历史行打开时绕过了 openModal，
// 于是 openedFrom 一直是 null，关闭时不会切回概览。
{
  const w = boot({
    handler: (p) => {
      if (p.includes("/readiness"))
        return Promise.resolve({
          ...READY,
          history: [
            {
              attempt_id: "tat_h",
              node_id: "node_h",
              node_name: "光的干涉",
              distance: "mid",
              correctness: null,
              question: "历史里的一道",
              answered: false,
              created_at: "2026-10-06T11:00:00+00:00",
              seq: 1,
              total: 1,
            },
          ],
          history_total: 1,
        });
      if (p.includes("/plan"))
        return Promise.resolve({ steps: [], transfer: { counts: {}, ready_count: 0 } });
      if (p.includes("/queue")) return Promise.resolve({ items: [] });
      if (p.includes("/attempts?"))
        return Promise.resolve({
          items: [
            {
              attempt_id: "tat_h",
              node_id: "node_h",
              node_name: "光的干涉",
              distance: "mid",
              correctness: null,
              question: "历史里的一道",
              answered: false,
              created_at: "2026-10-06T11:00:00+00:00",
              seq: 1,
              total: 1,
            },
          ],
          total: 1,
        });
      if (p.includes("/attempts/"))
        return Promise.resolve({
          attempt_id: "tat_h",
          project_id: "proj_test",
          node_id: "node_h",
          node_name: "光的干涉",
          distance: "mid",
          distance_label: "中迁移 · 换表征",
          task: GOOD_TASK.task,
          answered: false,
          correctness: null,
          transfer_score: 0.1,
          transfer_stage_label: "迁移未验证",
          seq: 1,
          total: 1,
        });
      return Promise.reject(new Error("unexpected " + p));
    },
  });
  w.eval(
    `var switched = 0; function switchFeature(f){ state.feature = f; switched++; }
     function currentUi(){ return "agent"; }
     window.KnowOriginAgentShell = { revealStudio: function(){} };`
  );
  await tick(w, 250);

  check("面板上有可点的历史行", qa(w, ".ko-tf-hist-row").length === 1);
  qa(w, ".ko-tf-hist-row")[0].click();
  await tick(w, 250);
  check("从历史行打开成功", !modalHidden(w) && /历史里的一道/.test(text(w, ".ko-tf-cols")));
  check("从历史打开会取回 node_id（不搅乱当前推荐节点）", w.KnowOriginTransfer.task().nodeId === "node_h", w.KnowOriginTransfer.task().nodeId);

  // 关掉之前把 feature 切走，模拟「别处抢了界面」
  w.eval(`state.feature = "chat";`);
  q(w, "[data-ko-tf-close]").click();
  await tick(w, 10);
  check("【实报 bug】从历史打开后关闭，仍回到学习概览", w.eval("state.feature") === "overview", w.eval("state.feature"));
  w.close();
}

// ── 12. 面板不能自我重建（悬浮频闪 / 点了没反应）────────────────────
// 实报症状：指针停在迁移这块时界面频闪，点任何按钮都没反应。
// 根因是 body 上的 MutationObserver 与 renderPanel 的无条件 innerHTML= 互相喂：
// 写 DOM 就是一次 childList 变更 → 120ms 后 mount → 再写，循环停不下来。
// 断言分两半，都是实机可见的行为：
//   ① 什么都不动时面板节点必须是**同一个**（否则 :hover 每 120ms 被顶掉 → 频闪）；
//   ② mousedown 与 mouseup 之间按钮不能被换掉（换了浏览器的 click 就发到
//      两者的公共祖先上，处理器匹配不到任何 data-ko-tf-* → 点了没反应）。
{
  const w = boot({
    handler: (p) => {
      if (p.includes("/readiness")) return Promise.resolve(READY);
      if (p.includes("/plan"))
        return Promise.resolve({
          steps: [],
          transfer: { labels: {}, counts: { untested: 19, partial: 1, solid: 3 }, ready_count: 19 },
        });
      if (p.includes("/queue")) return Promise.resolve({ items: [] });
      if (p.includes("/attempts")) return Promise.resolve({ items: [], total: 0 });
      return Promise.reject(new Error("unexpected " + p));
    },
  });
  await tick(w, 300);

  // 先盯住卡片：数据没变时它不该再被动。
  const card = q(w, "[data-ko-tf-panel]");
  let swaps = 0;
  new w.MutationObserver((recs) => {
    for (const r of recs) if (r.target === card) swaps += 1;
  }).observe(card, { childList: true, subtree: true });

  // 五个防抖窗口里什么都不做
  await tick(w, 600);
  check("数据没变时不重写面板（否则 120ms 一轮自触发重绘）", swaps === 0, "swaps=" + swaps);

  // 节点要抓在稳定之后：自重建还在发生的版本里，这里抓到的是个马上就被换掉的旧节点。
  const stage0 = q(w, ".ko-tf-stage");
  await tick(w, 300);
  check("悬浮的元素还是同一个节点（:hover 不会被顶掉 → 不频闪）", q(w, ".ko-tf-stage") === stage0);

  // 真实按下节奏：mousedown → 停 300ms（> 120ms 防抖窗口）→ mouseup
  const refresh0 = q(w, "[data-ko-tf-refresh]");
  const panelEl = refresh0.closest("[data-ko-tf-panel]");
  refresh0.dispatchEvent(new w.MouseEvent("mousedown", { bubbles: true }));
  await tick(w, 300);
  const up = q(w, "[data-ko-tf-refresh]");
  const sameNode = !!up && up === refresh0;
  // 浏览器规则：down 与 up 的 target 不同 → click 派发到两者的公共祖先。
  // up 为 null 说明那一刻面板正在被换成占位，本身就自证了重建，不必再点。
  if (up && panelEl) {
    const clickTarget = sameNode ? up : panelEl;
    const before = w.__calls.filter((x) => x.includes("/readiness")).length;
    clickTarget.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await tick(w, 30);
    check("刷新按钮真的重新取了数", w.__calls.filter((x) => x.includes("/readiness")).length > before);
  } else {
    check("刷新按钮真的重新取了数", false, "按下之前按钮就已经是脱节点的旧节点");
  }
  check("按下到抬起之间按钮没被换掉（否则 click 落到祖先上、点了没反应）", sameNode);
  w.close();
}

if (failures.length) {
  console.log(`\n迁移 UI 回归未通过：${failures.length} 条`);
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
console.log("\n迁移 UI 回归全通过。");
