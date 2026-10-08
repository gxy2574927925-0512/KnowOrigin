/**
 * 真浏览器（Chromium）验收：知识文档的「高亮」与「正文直改」。
 *
 * 为什么要真浏览器：jsdom 证明不了「选中一段话 → 点浮条按钮」在 Chrome 里会不会
 * 因为 mousedown 把选区收起来而失效 —— 那正是「高亮没反应」的现场。
 *
 * 跑法（需要一个带新代码的实例，端口不占用户正在跑的 17321）：
 *   DATA_DIR=<tmp> .venv311\\Scripts\\python.exe -m uvicorn api_server:app --app-dir src --port 17999
 *   node tools/_kd_browser_check.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.KD_BASE || "http://127.0.0.1:17999";
const EMAIL = "kdcheck@example.com";
const PASSWORD = "abcd1234";
const PROJECT_ID = process.env.KD_PID;
const NODE_ID = process.env.KD_NODE;

const puts = [];
const fails = [];
function check(name, ok, detail = "") {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? " -> " + detail : ""}`);
  if (!ok) fails.push(name);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("request", (req) => {
  if (req.method() === "PUT" && String(req.url()).indexOf("/knowledge-doc/content") > 0) {
    puts.push(JSON.parse(req.postData() || "{}").content_md || "");
  }
});
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

// —— 登录 ——
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await page.evaluate(
  async ([email, password]) => {
    const r = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name: "kd-check" }),
    });
    if (!r.ok) {
      await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
    }
  },
  [EMAIL, PASSWORD]
);
await page.reload({ waitUntil: "networkidle" });

// —— 打开文档 ——
await page.evaluate(
  async ([pid, nid]) => {
    if (window.state) window.state.currentProjectId = pid;
    await window.KnowOriginKnowledgeDoc.openNode(nid, "康普顿散射");
  },
  [PROJECT_ID, NODE_ID]
);
await page.waitForSelector("#ko-kd-body .ko-kd-md");

const md = page.locator("#ko-kd-body .ko-kd-md");
check("正文可编辑", (await md.getAttribute("contenteditable")) === "true");

// —— 1. 真鼠标拖选 → 真点击「高亮」——
const para = page.locator("#ko-kd-body p", { hasText: "波长变长" }).first();
const box = await para.boundingBox();
await page.mouse.move(box.x + 4, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width - 6, box.y + box.height / 2, { steps: 12 });
await page.mouse.up();
await page.waitForSelector("#ko-kd-selbar.ko-kd-is-on", { timeout: 3000 });
check("拖选之后浮条出现了", true);
check("浮条上是「高亮」", (await page.locator("#ko-kd-hl").textContent()) === "高亮",
  (await page.locator("#ko-kd-hl").textContent()) || "");

await page.click("#ko-kd-hl"); // 真点击：含 mousedown，就是这一步原来会失效
await page.waitForTimeout(600);
const marks = await page.locator("#ko-kd-body mark").count();
check("真点击后正文出现高亮", marks > 0, "mark 数=" + marks);
check("高亮写回了库", puts.length === 1 && puts[0].indexOf("==") >= 0, (puts[0] || "").slice(0, 80));

// —— 2. 点正文直接改字 ——
await page.click("#ko-kd-body p >> nth=0"); // 点进去放光标
await page.keyboard.type("ABC");
await page.waitForTimeout(1400); // 防抖 900ms + 网络
await page.keyboard.type("DEF");
await page.waitForTimeout(1400);

const text = await page.locator("#ko-kd-body .ko-kd-md").innerText();
check("两次输入都落在同一个位置（没有被重画打断）", text.indexOf("ABCDEF") >= 0,
  text.slice(0, 60).replace(/\n/g, " | "));
check("改动自动写回了库", puts.length >= 2 && puts[puts.length - 1].indexOf("ABCDEF") >= 0,
  (puts[puts.length - 1] || "").slice(0, 80));
check("标题结构还在", puts[puts.length - 1].indexOf("## 一句话把握") >= 0);

await page.screenshot({ path: "screenshots/kd-inline-edit.png" });
console.log("\n截图 screenshots/kd-inline-edit.png");
console.log(fails.length ? `\n${fails.length} 项未通过` : "\n全部通过");
await browser.close();
process.exit(fails.length ? 1 : 0);
