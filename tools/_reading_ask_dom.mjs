/**
 * 读书「选中 → AI 陪读讨论」前端冒烟（jsdom，真 DOM，不手搓桩）。
 * 跑：node tools/_reading_ask_dom.mjs
 */
import { JSDOM } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const js = fs.readFileSync(path.join(ROOT, "static", "reading.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "static", "styles-reading.css"), "utf8");

const fails = [];
const check = (name, cond, extra = "") => {
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? " | " + extra : ""));
  if (!cond) fails.push(name);
};

const dom = new JSDOM(
  `<!doctype html><html><body>
     <main id="reading-workspace" class="reading-workspace">
       <div class="rd-top"><button data-rd-exit>返回</button></div>
       <div class="rd-wrap">
         <div class="rd-pane is-on" data-rd-pane="digest"><div data-rd-digest>
           <div class="rd-doc-body"><p>这是收获正文里的一段原文，可以被选中。</p></div>
           <div class="rd-quote">划线原文</div>
         </div></div>
       </div>
     </main>
     <div class="question-rail on"></div>
   </body></html>`,
  { runScripts: "outside-only", pretendToBeVisual: true }
);
const win = dom.window;
const doc = win.document;

win.TextDecoder = TextDecoder;
win.escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
win.showToast = () => {};

const calls = [];
function sseResp(text) {
  const enc = new TextEncoder();
  const chunks = [enc.encode(text)];
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: () => "text/event-stream" },
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }),
      }),
    },
    json: async () => ({}),
  };
}
const SSE = [
  'data: {"type":"start","context_chars":120}\n\n',
  'data: {"type":"delta","text":"结论："}\n\n',
  'data: {"type":"delta","text":"这段在讲 **X**。"}\n\n',
  'data: {"type":"done","text":"结论：这段在讲 **X**。\\n\\n> 原文引用"}\n\n',
].join("");

const BOOK = {
  book_key: "bk-1",
  title: "如何阅读一本书",
  author: "艾德勒",
  project_id: "p1",
};
win.fetch = (url, opts) => {
  calls.push({ url, opts });
  const u = String(url);
  if (u.indexOf("/ask") >= 0) return Promise.resolve(sseResp(SSE));
  if (u.indexOf("/outline") >= 0) return jsonResp({ kind: "empty", sources: [], chapters: [] });
  if (u.indexOf("/api/reading/books/") >= 0) {
    return jsonResp({ book: BOOK, digest: { content_md: "## 收获\n\n这是收获正文里的一段原文，可以被选中。" }, intro: null });
  }
  return jsonResp({ books: [], groups: [], summary: {}, results: [] });
};
function jsonResp(data) {
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => data,
    text: async () => JSON.stringify(data),
  });
}
// app.js 的 api() 返回的是**已解析的 JSON**，不是 Response —— 桩要跟着这个契约来
win.api = (p, o) => win.fetch(p, o).then((r) => r.json());

const SEL_TEXT = "这是收获正文里的一段原文";
function fakeSelection(anchor, text) {
  win.getSelection = () => ({
    anchorNode: anchor,
    toString: () => text,
    rangeCount: 1,
    getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 120, top: 260 }) }),
  });
}

win.eval(js);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const R = win.KnowOriginReading;
await tick(30);      // 等 DOMContentLoaded（jsdom 构造完还是 loading，init 挂在那个事件上）
R.open();
R.openBook("bk-1");  // 抽屉要挂在「某本书」上，所以得先开一本书
await tick(40);
const block = doc.querySelector(".rd-doc-body p");
fakeSelection(block.firstChild, SEL_TEXT);

const bar = doc.getElementById("rd-sel-bar");
const box = doc.getElementById("rd-ask-drawer");
const q = (sel) => doc.querySelector(sel);

check("模块暴露了接口", !!R && typeof R.open === "function");
check("工具条与抽屉是常驻节点", !!bar && !!box);
check(
  "挂在 #reading-workspace 上（不会被 pane 重渲染冲掉）",
  bar.parentElement.id === "reading-workspace" && box.parentElement.id === "reading-workspace"
);
check("初始都隐藏", bar.hidden === true && box.hidden === true);

// 1. 划选 → 工具条
doc.querySelector(".rd-doc-body").dispatchEvent(new win.MouseEvent("mouseup", { bubbles: true }));
await tick(10);
check("选中正文后工具条出现", bar.hidden === false, `left=${bar.style.left} top=${bar.style.top}`);
check("工具条定位在选区上方", bar.style.left === "120px" && bar.style.top === "216px", `${bar.style.left}/${bar.style.top}`);

// 2. 选在正文之外不该弹（按钮上的文字不算「正在读的原文」）
fakeSelection(doc.querySelector(".rd-top button").firstChild, "返回");
doc.querySelector(".rd-top").dispatchEvent(new win.MouseEvent("mouseup", { bubbles: true }));
await tick(10);
check("选在按钮上不弹工具条", bar.hidden === true);

// 3. 点开抽屉
fakeSelection(block.firstChild, SEL_TEXT);
doc.querySelector(".rd-doc-body").dispatchEvent(new win.MouseEvent("mouseup", { bubbles: true }));
await tick(10);
q("[data-rd-ask-start]").click();
check("抽屉打开", box.hidden === false);
check("body 打上 rd-ask-open（藏着主界面提问导轨）", doc.body.classList.contains("rd-ask-open"));
check("引用条显示选中的原文", q("[data-rd-ask-quote]").textContent === SEL_TEXT);
check("工具条收掉了", bar.hidden === true);

// 4. 发问（点快捷问题）
q("[data-rd-ask-chip]").click();
await tick(40);
const askCall = calls.filter((c) => String(c.url).indexOf("/ask") >= 0)[0];
check("调了 /ask 端点", !!askCall, askCall && askCall.url);
const sent = askCall ? JSON.parse(askCall.opts.body) : {};
check("带上了选区", sent.selection === SEL_TEXT, sent.selection);
check("带上了所在块的上下文", String(sent.context || "").indexOf(SEL_TEXT) >= 0, String(sent.context || "").slice(0, 30));
check("问题是芯片上的那句", sent.question === "这段在说什么", sent.question);
check("Content-Type 是 JSON（漏了会被后端当裸字符串，422）", (askCall.opts.headers || {})["Content-Type"] === "application/json");

// 5. 流式渲染
const msgs = q("[data-rd-ask-msgs]");
check("渲染出问答", msgs.querySelectorAll(".rd-ask-msg").length === 1);
check("答案走了 Markdown 渲染（**X** → strong）", msgs.querySelectorAll(".rd-ask-a strong").length === 1, msgs.innerHTML.slice(0, 120));
check("done 覆盖增量文本", msgs.textContent.indexOf("原文引用") >= 0);
check("答案里没有 script 元素", msgs.querySelectorAll("script").length === 0);

// 6. XSS：问题里的尖括号只能当文本
q("[data-rd-ask-input]").value = "<script>alert(1)</script> 是什么意思？";
q("[data-rd-ask-send]").click();
await tick(40);
check(
  "尖括号被转义（不生成 script 元素，但文本可见）",
  msgs.querySelectorAll("script").length === 0 && msgs.textContent.indexOf("<script>alert(1)</script>") >= 0
);

// 7. Esc：先收抽屉，再退出阅读
doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await tick(5);
check("Esc 先关抽屉", box.hidden === true && !doc.body.classList.contains("rd-ask-open"));
const ws = doc.getElementById("reading-workspace");
check("关抽屉时没退出读书模式", !ws.classList.contains("hidden"));
doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await tick(5);
check("再按 Esc 才退出", ws.classList.contains("hidden"));

// 8. 换书要清空上一场的讨论
R.open();
R.openBook("bk-2");
await tick(20);
check("换书后抽屉关掉", box.hidden === true);
check("换书后没有 body 标记", !doc.body.classList.contains("rd-ask-open"));
check("换书后讨论记录清空", q("[data-rd-ask-msgs]").children.length === 0);

// 9. CSS 护栏（源码级，回归防线）
check(
  "hidden 时强制 display:none（作者 display:flex 会盖掉 UA 的 [hidden]）",
  /\.rd-ask\[hidden\][^}]*display:\s*none\s*!important/.test(css)
);
check(
  "划词条 1570 / 抽屉 1560（与全站浮层分档同档）",
  /\.rd-selbar\s*\{[^}]*z-index:\s*1570/.test(css) && /\.rd-ask\s*\{[^}]*z-index:\s*1560/.test(css)
);
check(
  "抽屉正文区自己滚动（min-height:0 不能省）",
  /\.rd-ask-msgs\s*\{[^}]*overflow-y:\s*auto/.test(css) && /\.rd-ask-msgs\s*\{[^}]*min-height:\s*0/.test(css)
);
check("抽屉开着时藏掉主界面提问导轨", /body\.rd-ask-open\s+\.question-rail\s*\{\s*display:\s*none/.test(css));

console.log("\n=== FAILS: %d ===", fails.length);
fails.forEach((f) => console.log(" -", f));
process.exit(fails.length ? 1 : 0);
