/** CDP 最小连通性自检：起 Edge headless -> 连 WebSocket -> evaluate。 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = process.env.KNOWORIGIN_EDGE
  || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9333;

const profile = mkdtempSync(join(tmpdir(), "ko-edge-"));
const child = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${PORT}`,
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevTools() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch (_) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error("Edge DevTools 没起来");
}

let ws;
let seq = 0;
const pending = new Map();
function send(method, params = {}, sessionId) {
  const id = ++seq;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

try {
  const version = await waitForDevTools();
  console.log("DevTools:", version.Browser);

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("没有 page target");

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (e) => reject(new Error(`ws 失败: ${e.message || e.type}`));
  });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message}`));
      else resolve(msg.result);
    }
  };

  await send("Page.enable");
  await send("Runtime.enable");
  const r = await send("Runtime.evaluate", { expression: "1+1", returnByValue: true });
  console.log("evaluate 1+1 =", r.result.value);

  const ua = await send("Runtime.evaluate", {
    expression: "navigator.userAgent.slice(0,60)", returnByValue: true,
  });
  console.log("UA:", ua.result.value);
  console.log("CDP 通路 OK");
} catch (error) {
  console.error("失败:", error.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch (_) { /* ignore */ }
  // 同 measure_agent_ui.mjs：Windows 上必须杀整棵进程树，否则孙进程会攒下来吃内存
  if (process.platform === "win32" && child.pid) {
    const { spawnSync } = await import("node:child_process");
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill();
  }
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}
