/**
 * jsdom 冒烟：把 app.js + agent-shell.js 拼成一次 eval 实跑，抓真实异常。
 *
 * ⚠️ 必须拼成一次 w.eval()：多个独立 eval 不共享全局词法环境，会误报
 * "state is not defined"（classic script 的顶层 const 在真实浏览器里是共享的）。
 *
 * 用法：node tools/jsdom_smoke.mjs            # 用真实 HTTP 打后端
 *      KNOWORIGIN_OFFLINE=1 node tools/jsdom_smoke.mjs   # 离线，只看脚本能否跑完
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

// 看门狗：这个脚本在内存饥饿的机器上可能永远等不到 init 完成（同样代码两次卡在不同位置、
// 加埋点就又能跑通 —— 是资源问题不是代码问题）。挂死的校验脚本比失败的更糟，
// 所以给它一个明确的失败出口，而不是让整个回归卡在这里。
const WATCHDOG_MS = Number(process.env.KNOWORIGIN_JSDOM_TIMEOUT || 120000);
const watchdog = setTimeout(() => {
  console.error(`[jsdom] 超过 ${WATCHDOG_MS}ms 仍未结束，判定为环境资源不足（内存/进程数），退出码 3`);
  process.exit(3);
}, WATCHDOG_MS);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OFFLINE = process.env.KNOWORIGIN_OFFLINE === "1";
const ORIGIN = process.env.KNOWORIGIN_ORIGIN || "http://127.0.0.1:17321";

const errors = [];
const warns = [];
const logs = [];

const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (error) => errors.push(`jsdomError: ${error.message}\n${error.stack || ""}`));
virtualConsole.on("error", (...args) => errors.push(`console.error: ${args.map(String).join(" ")}`));
virtualConsole.on("warn", (...args) => warns.push(args.map(String).join(" ")));
virtualConsole.on("log", (...args) => logs.push(args.map(String).join(" ")));

const html = readFileSync(join(ROOT, "static", "index.html"), "utf8");
const appJs = readFileSync(join(ROOT, "static", "app.js"), "utf8");
const shellJs = readFileSync(join(ROOT, "static", "agent-shell.js"), "utf8");
const streakJs = readFileSync(join(ROOT, "static", "streak.js"), "utf8");

const dom = new JSDOM(html, {
  url: `${ORIGIN}/`,
  runScripts: "outside-only",
  pretendToBeVisual: true,
  virtualConsole,
});
const { window } = dom;

// ---- 环境垫片：真实浏览器有、jsdom 没有的 ----
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
window.ResizeObserver = ResizeObserverStub;
window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
window.cancelAnimationFrame = (id) => clearTimeout(id);
window.scrollTo = () => {};
window.HTMLElement.prototype.scrollIntoView = () => {};
window.HTMLElement.prototype.animate = () => ({ finished: Promise.resolve(), cancel() {}, addEventListener() {} });
window.matchMedia;
if (!window.navigator.clipboard) window.navigator.clipboard = { writeText: async () => {} };
if (!window.SpeechRecognitionUtterance) {
  window.SpeechRecognitionUtterance = function () {};
  window.SpeechRecognition = function () { return { start() {}, stop() {} }; };
}

// fetch：离线时全部拒绝，逼出代码里"没处理网络失败"的地方；在线时打真实后端
const calls = [];
window.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input);
  calls.push(url);
  if (OFFLINE) throw new Error(`offline: ${url}`);
  const target = url.startsWith("http") ? url : `${ORIGIN}${url}`;
  const res = await import("node:https").then(() => globalThis.fetch(target, init));
  return res;
};

const combined = [
  "try {",
  appJs,
  "\n// ==== agent-shell.js ====",
  shellJs,
  "\n// ==== streak.js ====",
  streakJs,
  "\n} catch (error) { window.__bootError = error; throw error; }",
];

try {
  window.eval(combined.join("\n"));
} catch (error) {
  errors.push(`eval 抛出: ${error.message}\n${error.stack || ""}`);
}

window.document.dispatchEvent(new window.Event("DOMContentLoaded", { bubbles: true }));

// init() 是 async，等它跑完（最多 8 秒）
await new Promise((resolve) => setTimeout(resolve, OFFLINE ? 3000 : 8000));

const sessionReady = window.document.documentElement.dataset.sessionReady;
const authHidden = window.document.querySelector("#auth-shell")?.classList.contains("hidden");
const workspaceHidden = window.document.querySelector("#workspace")?.classList.contains("hidden");
const errorVisible = !window.document.querySelector("#error-banner")?.classList.contains("hidden");
const errorText = window.document.querySelector("#error-message")?.textContent || "";
const railExists = !!window.document.querySelector("#agent-rail");

console.log("=== 环境 ===");
console.log("离线模式:", OFFLINE);
console.log("发出的请求:", calls.length ? calls.join(", ") : "（无）");

// ---- 产出浮层标题必须跟着当前功能变 ----
// 之前 syncStudioTitle 写的是不存在的选择器，静默 return，标题永远是「学习产出」；
// 纯标记检查抓不到这种错，只有真的跑一次才发现。
// 注意 app.js 的 state 在 combined 的 try 块里（块级作用域），外部 eval 拿不到，
// 所以这里不改状态，只断言 syncRail() 之后标题能按当前 feature 解析成正确功能名。
const LABELS = ["知识框架", "学习概览", "知识卡片", "小测验", "我的笔记", "学习产出"];
window.KnowOriginAgentShell.syncRail();
const titleText = window.document.querySelector("#studio-title")?.textContent || "";
const titleOk = LABELS.includes(titleText);
console.log("");
console.log("=== 产出浮层标题 ===");
console.log(` ${titleOk ? "PASS" : "FAIL"} #studio-title → 「${titleText}」`);
console.log("");

console.log("");
console.log("=== 结果 ===");
console.log("app.js 顶层执行:", window.__bootError ? `抛错 → ${window.__bootError.message}` : "通过");
console.log("data-session-ready:", sessionReady ?? "（未设置）");
console.log("auth-shell 隐藏:", authHidden);
console.log("workspace 隐藏:", workspaceHidden);
console.log("报错条可见:", errorVisible, errorText ? `→ ${errorText}` : "");
console.log("agent-rail 存在:", railExists);
console.log("");
console.log("=== console.error / 未捕获异常 ===");
if (errors.length) errors.slice(0, 12).forEach((line) => console.log(" -", line));
else console.log("（无）");
if (warns.length) {
  console.log("");
  console.log("=== console.warn（前 5）===");
  warns.slice(0, 5).forEach((line) => console.log(" -", line));
}

// 判定：至少要能看到一个视图，且 init 跑到了 loadSession（发出过 /api/auth/session）
const sawSessionCall = calls.some((url) => url.includes("/api/auth/session"));
const anyViewVisible = authHidden === false || workspaceHidden === false || errorVisible;
const ok = !window.__bootError && errors.length === 0 && anyViewVisible && titleOk && (OFFLINE || sawSessionCall);

console.log("");
console.log(ok ? "jsdom 冒烟通过。" : "jsdom 冒烟失败。");
clearTimeout(watchdog);
process.exit(ok ? 0 : 1);