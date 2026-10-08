/**
 * 读书模块请求体检：把 static/reading.js 在 jsdom 里真跑一遍，点按钮，
 * 检查它发出去的请求是不是**合法的 fetch 选项**。
 *
 * 为什么必须有这个脚本：
 *   `window.api` 就是 `fetch(path, {credentials, ...options})` 的薄封装 —— 它**不会**
 *   帮你序列化 body。写成 `api(path, {method:"POST", body:{...}})` 会发出去一个
 *   body 是 `[object Object]`、又没有 Content-Type 的畸形请求，后端回 422/400。
 *   表现是「按钮点了没反应」，而控制台里什么都看不到 —— 静态检查抓不到，
 *   Python 侧的门禁也抓不到（它压根不碰前端请求体）。
 *   2026-10-07 真实踩过一次：读书模块六个写操作**全废**。
 *
 * 用法：node tools/_probe_reading_widget.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FAILS = [];

function check(name, ok, detail = "") {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? " -> " + detail : ""}`);
  if (!ok) FAILS.push(name);
}

const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (e) => console.error("[jsdom]", e.message));

const dom = new JSDOM(
  `<!doctype html><html data-theme="light"><body>
     <div id="workspace"></div>
     <main id="reading-workspace" class="hidden">
       <div class="rd-tabs">
         <button class="rd-tab is-on" type="button" data-rd-tab="shelf">书架</button>
         <button class="rd-tab" type="button" data-rd-tab="digest">读书收获</button>
       </div>
       <div class="rd-pane is-on" data-rd-pane="shelf"><div data-rd-shelf></div></div>
       <div class="rd-pane" data-rd-pane="digest"><div data-rd-digest></div></div>
     </main>
   </body></html>`,
  { runScripts: "outside-only", url: "http://localhost/", virtualConsole }
);
const w = dom.window;

const calls = [];
w.api = (path, options) => {
  calls.push({ path, options: options || {} });
  if (path === "/api/reading/books") {
    return Promise.resolve({ books: [], groups: [], summary: { total: 0 } });
  }
  if (path === "/api/reading/weread/status") {
    return Promise.resolve({ configured: false, origin: "" });
  }
  return Promise.resolve({});
};

w.eval(readFileSync(join(ROOT, "static/reading.js"), "utf8"));

const flush = async (n = 6) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

check("模块暴露 window.KnowOriginReading", typeof w.KnowOriginReading?.open === "function");

// ⚠️ jsdom 里 readyState 是 "loading"，DOMContentLoaded 要等一轮微任务才触发；
// 真实浏览器里 <script defer> 也是这个顺序，所以先 flush 再 open 才符合真实时序。
await flush();
w.KnowOriginReading.open();
await flush();
check("打开后工作区可见", !w.document.getElementById("reading-workspace").classList.contains("hidden"));
check("隐藏了主工作区", w.document.getElementById("workspace").classList.contains("hidden"));
check("书架请求发出", calls.some((c) => c.path === "/api/reading/books"));
check("微信读书状态请求发出", calls.some((c) => c.path === "/api/reading/weread/status"));

const q = (sel) => w.document.querySelector(sel);
check("渲染出 Key 输入框", !!q("[data-rd-wkey]"));
check("渲染出搜书按钮", !!q("[data-rd-search]"));
check("渲染出同步按钮", !!q("[data-rd-wsync]"));

// ---- 点「保存 Key」----
q("[data-rd-wkey]").value = "wrk-probe-value";
q("[data-rd-wsave]").click();
await flush();

const keyCall = calls.filter((c) => c.path === "/api/reading/weread/key").pop();
check("保存 Key 发出了请求", !!keyCall, String(calls.length));
if (keyCall) {
  check("保存 Key 用 PUT", keyCall.options.method === "PUT", String(keyCall.options.method));
  check(
    "保存 Key 带 Content-Type: application/json",
    keyCall.options.headers?.["Content-Type"] === "application/json",
    JSON.stringify(keyCall.options.headers || {})
  );
  check("保存 Key 的 body 是**字符串**（不是对象）", typeof keyCall.options.body === "string",
    typeof keyCall.options.body);
  let parsed = null;
  try { parsed = JSON.parse(keyCall.options.body); } catch (e) { /* 留空给断言报错 */ }
  check("保存 Key 的 body 是合法 JSON 且含 api_key", parsed?.api_key === "wrk-probe-value",
    String(keyCall.options.body));
}

// ---- 点「同步微信读书书架」----
q("[data-rd-wsync]").click();
await flush();
const syncCall = calls.filter((c) => c.path === "/api/reading/weread/sync").pop();
check("同步发出了请求", !!syncCall);
if (syncCall) {
  check("同步用 POST", syncCall.options.method === "POST", String(syncCall.options.method));
  check("同步的 body 是字符串", typeof syncCall.options.body === "string", typeof syncCall.options.body);
}

// ---- 点「搜书」----
q("[data-rd-query]").value = "原子习惯";
q("[data-rd-search]").click();
await flush();
const searchCall = calls.filter((c) => c.path === "/api/reading/search").pop();
check("搜书发出了请求", !!searchCall);
if (searchCall) {
  check("搜书用 POST", searchCall.options.method === "POST", String(searchCall.options.method));
  check("搜书的 body 是字符串", typeof searchCall.options.body === "string", typeof searchCall.options.body);
  check("搜书 body 含 query", JSON.parse(searchCall.options.body).query === "原子习惯",
    String(searchCall.options.body));
}

// ---- 全局回归：任何写请求都不许出现「body 是对象」----
const badBodies = calls.filter(
  (c) => ["POST", "PUT", "PATCH"].includes(String(c.options.method || "").toUpperCase())
    && c.options.body !== undefined
    && typeof c.options.body !== "string"
);
check("没有任何写请求把对象直接当 body 传（本次真实 bug 的回归）", badBodies.length === 0,
  badBodies.map((c) => c.path).join(","));

const missingCT = calls.filter(
  (c) => ["POST", "PUT", "PATCH"].includes(String(c.options.method || "").toUpperCase())
    && c.options.body !== undefined
    && c.options.headers?.["Content-Type"] !== "application/json"
);
check("所有带体的写请求都带了 Content-Type", missingCT.length === 0,
  missingCT.map((c) => c.path).join(","));

// ---- 退出时收掉主工作区 ----
w.KnowOriginReading.close();
check("关闭后隐藏工作区", w.document.getElementById("reading-workspace").classList.contains("hidden"));
check("关闭后恢复主工作区", !w.document.getElementById("workspace").classList.contains("hidden"));

console.log(FAILS.length ? `\n${FAILS.length} 项未通过` : "\n全部通过");
process.exit(FAILS.length ? 1 : 0);
