/** 对比 academic / classic / agent 三套在浅色下的实际渲染色。
 *  目的：验证 classic 浅色回退层生效，且没有波及其它两套。
 *  用法：node tools/measure_classic_palette.mjs   （需先起 KNOWORIGIN_OFFLINE=1 的服务）
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.KO_BASE || "http://127.0.0.1:8011/";
const EDGE = process.env.EDGE_PATH
  || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const COOKIE = process.env.KO_COOKIE || "knoworigin_session=probe";
const PROFILE = mkdtempSync(join(tmpdir(), "ko-classic-"));
const PORT = 9401;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 这些选择器在两套界面里都存在，颜色取自 styles.css 的 token，能反映配色是否被改动
const PROBES = [
  [".sources-panel", "左侧资料栏底色"],
  [".message > div", "气泡底色"],
  [".source-import-progress-track", "进度条槽底"],
  [".project-title-button", "项目标题按钮"],
  [".citation-chip", "引用 chip"],
  [".math-display", "公式块左边线"],
];

const child = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "--disable-background-networking", "--hide-scrollbars",
  "about:blank",
], { stdio: "ignore" });

let ws;
let seq = 0;
const pending = new Map();
const send = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
};

try {
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(300);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((x) => x.json());
      target = r.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    } catch (_) { /* 还没起来 */ }
  }
  if (!target) throw new Error("Edge 没起来");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  };

  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "eval 失败");
    return r.result.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  const [cookieName, cookieValue] = COOKIE.split("=");
  await send("Network.setCookie", { name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/" });

  const results = {};
  for (const mode of ["classic", "academic", "agent"]) {
    // 模式必须在页面脚本执行前写好，否则 applyUi 先读了默认值
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `try {
        localStorage.setItem("knoworigin-ui", ${JSON.stringify(mode)});
        localStorage.setItem("knoworigin-theme", "light");
      } catch (e) {}`,
    });
    await send("Page.navigate", { url: BASE });
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      await sleep(400);
      try { ready = await evaluate(`return document.documentElement.dataset.sessionReady === '1';`); }
      catch (_) { /* 导航中 */ }
    }
    const actualUi = await evaluate(`return document.documentElement.getAttribute('data-ui');`);
    const theme = await evaluate(`return document.documentElement.getAttribute('data-theme');`);
    const row = {};
    for (const [sel, label] of PROBES) {
      row[label] = await evaluate(`
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return "(无此元素)";
        const s = getComputedStyle(el);
        return s.backgroundColor !== "rgba(0, 0, 0, 0)" ? s.backgroundColor
             : (s.borderLeftColor !== "rgba(0, 0, 0, 0)" ? "左边线 " + s.borderLeftColor : s.color);
      `);
    }
    row.__meta = `data-ui=${actualUi} theme=${theme} ready=${ready}`;
    results[mode] = row;
  }

  console.log("=== 三套浅色实际渲染色 ===\n");
  const labels = PROBES.map((p) => p[1]);
  console.log("元素".padEnd(16) + "classic".padEnd(24) + "academic".padEnd(24) + "agent");
  for (const label of labels) {
    console.log(
      label.padEnd(14) +
      String(results.classic[label]).padEnd(24) +
      String(results.academic[label]).padEnd(24) +
      String(results.agent[label])
    );
  }
  console.log("");
  for (const mode of ["classic", "academic", "agent"]) console.log(mode.padEnd(10), results[mode].__meta);
  console.log("\n(JSON)\n" + JSON.stringify(results, null, 2));
} catch (error) {
  console.error("失败:", error.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch (_) { /* ignore */ }
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill();
  }
  await sleep(300);
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}
