/* 「整页对照」前端取图路径回归（极简 DOM stub，不需要 jsdom、不联网）。
 *
 * 跑法：node tools/verify_pdf_spread_frontend.mjs
 *
 * 只断言一件事：开启对照后，前端是**先请求 /translate-pdf/spread**（它会渲染）
 * 再拿返回的 right_url 设 img.src，而不是自己去拼 /spread-image（只读缓存 → 裂图）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "static", "pdf-spread-ui.js"), "utf8");

const requests = [];
const FAILS = [];
const check = (name, ok, detail = "") => {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? " -> " + detail : ""}`);
  if (!ok) FAILS.push(name);
};

function el(extra = {}) {
  return {
    hidden: false,
    dataset: {},
    style: {},
    innerHTML: "",
    textContent: "",
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
    getAttribute: () => null,
    appendChild() {},
    addEventListener() {},
    ...extra,
  };
}

const btn = el();
const nav = el({ appendChild: (child) => { nav.child = child; } });
const pane = el();
const statusEl = el();
const bodyEl = el();
const img = el({ src: "/api/projects/P1/sources/S1/page-image?page=0" });
const label = el({ textContent: "1 / 30" });
btn.addEventListener = (type, fn) => { if (type === "click") btn._click = fn; };

const map = {
  "[data-orig-pagenav]": nav,
  "[data-orig-body]": el(),
  "[data-orig-trans]": null,
  "[data-orig-body] .orig-trans-resizer": null,
  "[data-orig-img]": img,
  "[data-orig-pagelabel]": label,
  "[data-pdf-spread-pane]": pane,
  "[data-pdf-spread-toggle]": null,
  "[data-ps-status]": statusEl,
  "[data-ps-body]": bodyEl,
  "[data-pdf-spread-pane] img.ps-img": null,
};

global.document = {
  readyState: "complete",
  body: el(),
  querySelector: (sel) => (sel in map ? map[sel] : null),
  createElement: () => btn,
  addEventListener() {},
};
global.MutationObserver = class { observe() {} disconnect() {} };
global.window = {
  api: async (url) => {
    requests.push(url);
    if (url.includes("/status")) {
      return { available: true, state: "done", dual_ready: true, spreads: 30 };
    }
    if (url.includes("/spread?")) {
      return {
        index: 0,
        total: 30,
        right_url:
          "/api/literature/P1/translate-pdf/spread-image?source_id=S1&pages=&side=right&index=0&dpi=130",
        left_url:
          "/api/literature/P1/translate-pdf/spread-image?source_id=S1&pages=&side=left&index=0&dpi=130",
      };
    }
    return {};
  },
};

(0, eval)(SRC);
check("挂上了「整页对照」按钮", typeof btn._click === "function");

btn._click();
await new Promise((r) => setTimeout(r, 30));

const spreadReq = requests.find((u) => u.includes("/translate-pdf/spread?"));
const directImgReq = requests.find((u) => u.includes("/spread-image"));
check("先请求 /spread（触发渲染）", Boolean(spreadReq), spreadReq || requests.join(" | "));
check(
  "不再自己拼 /spread-image 的地址",
  !directImgReq,
  directImgReq || "（无，符合预期）"
);
check(
  "状态栏显示组数",
  statusEl.textContent.includes("30"),
  statusEl.textContent
);

console.log();
if (FAILS.length) {
  console.log(`${FAILS.length} 项未通过：${FAILS.join(", ")}`);
  process.exit(1);
}
console.log("全部通过。");
