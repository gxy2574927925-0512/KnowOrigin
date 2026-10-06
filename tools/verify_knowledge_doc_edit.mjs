/**
 * 知识文档「高亮 + 正文直改」回归（jsdom）
 *
 * 跑法：``node tools/verify_knowledge_doc_edit.mjs``
 *
 * 覆盖 ——
 *   1. 渲染：`==一句==` 出 <mark>；正文带 contenteditable（点进去就能改，没有「编辑」按钮）
 *   2. 高亮：选中一句 → 浮条「高亮」→ 写回库，正文出现 <mark>，且滚动位置保住
 *   3. 去高亮：选中已有高亮时按钮写「去高亮」，点了库里的 == 就没了
 *   4. 直改：在正文里改字 → 防抖自动保存（不重画，光标不丢）→ 库里是反写回的 Markdown
 *   5. 反写：标题、列表、引用这些块级结构改完不散架
 *
 * 与 coach-ui 同一套装法：宿主 stub 与被测脚本必须在**同一次** eval 里跑，
 * knowledge-doc-ui.js 是 classic script，读的是共享全局词法环境。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "static", "knowledge-doc-ui.js");

const failures = [];
function check(name, ok, detail = "") {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? " -> " + detail : ""}`);
  if (!ok) failures.push(name);
}

const MD = [
  "# 康普顿散射",
  "",
  "> 掌握度 6% · 生成于 2026-10-06 23:00",
  "",
  "## 一句话把握",
  "",
  "光子与电子碰撞后波长变长。",
  "",
  "## 易错点",
  "",
  "- 偏移量只跟散射角有关",
  "- 与入射波长无关",
  "",
  "## 自测",
].join("\n");

const DOC = {
  doc_key: "k1",
  project_id: "p1",
  node_id: "n1",
  scope: "node",
  title: "康普顿散射",
  signature: "s1",
  content: { sections: [] },
  content_md: MD,
  created_at: "2026-10-06T10:00:00+00:00",
  updated_at: "2026-10-06T10:00:00+00:00",
};

// 合订稿：槽位键里 node_id 那格是 <project>，保存时 scope 走 "project" ——
// 用户在阅读页上改的多半是这一份，必须单独验一遍，别把上一份的 node_id 带过去。
const COMPILED = {
  doc_key: "k2",
  project_id: "p1",
  node_id: "",
  scope: "project",
  title: "物理 · 知识文档",
  signature: "",
  content: { sections: [], order: "tree", max_layer: 0 },
  content_md: MD,
  created_at: "2026-10-06T10:00:00+00:00",
  updated_at: "2026-10-06T10:00:00+00:00",
};

const writes = [];

const dom = new JSDOM(
  `<!doctype html><html><body><script>${fs.readFileSync(SRC, "utf8")}</script></body></html>`,
  {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "http://localhost/",
    beforeParse(w) {
      w.state = { currentProjectId: "p1", projects: [{ project_id: "p1", subject: "物理" }] };
      w.escapeHtml = (v) =>
        String(v == null ? "" : v)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
      w.showToast = () => {};
      w.api = async (url, options) => {
        const method = (options && options.method) || "GET";
        if (method === "PUT") {
          writes.push(JSON.parse(options.body));
          return { ok: true, chars: (JSON.parse(options.body).content_md || "").length };
        }
        if (String(url).indexOf("/compiled") > 0) return { doc: COMPILED };
        if (String(url).indexOf("/doc") > 0) return { doc: DOC };
        return { doc: null };
      };
    },
  }
);
const w = dom.window;
const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));

function fire(el) {
  el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
}
function bodyEl() {
  return w.document.getElementById("ko-kd-body");
}
function findP(keyword) {
  return Array.prototype.find.call(
    bodyEl().querySelectorAll("p"),
    (p) => p.textContent.indexOf(keyword) >= 0
  );
}
function selectNode(node) {
  const sel = w.getSelection();
  const range = w.document.createRange();
  range.selectNodeContents(node);
  sel.removeAllRanges();
  sel.addRange(range);
  w.document.dispatchEvent(new w.MouseEvent("mouseup", { bubbles: true }));
}

async function main() {
  await wait(30);
  await w.KnowOriginKnowledgeDoc.openNode("n1", "康普顿散射");

  // —— 1. 渲染 ——
  const root = bodyEl().querySelector(".ko-kd-md");
  check("正文已渲染", !!root && root.innerHTML.indexOf("康普顿散射") >= 0);
  check("正文可编辑（点进去就能改）", root && root.getAttribute("contenteditable") === "true",
    root ? String(root.getAttribute("contenteditable")) : "无正文");
  check("没有「编辑」按钮", !w.document.querySelector("[data-kd-edit]"));
  check("目录已建起来", w.document.querySelectorAll(".ko-kd-toc-item").length >= 3,
    String(w.document.querySelectorAll(".ko-kd-toc-item").length));

  // —— 2. 高亮 ——
  const para = findP("波长变长");
  check("找得到那句话", !!para);
  bodyEl().scrollTop = 120; // 高亮之后不该被弹回顶部
  selectNode(para);
  const hlBtn = w.document.getElementById("ko-kd-hl");
  check("浮条按钮写「高亮」", hlBtn && hlBtn.textContent === "高亮", hlBtn ? hlBtn.textContent : "无按钮");
  fire(hlBtn);
  await wait();

  check("高亮写回库", writes.length === 1 &&
    String(writes[0].content_md).indexOf("==光子与电子碰撞后波长变长。==") >= 0,
    JSON.stringify(writes[0] || {}));
  check("正文出现 <mark>", bodyEl().innerHTML.indexOf("<mark>光子与电子碰撞后波长变长。</mark>") >= 0);
  check("滚动位置保住了", bodyEl().scrollTop === 120, String(bodyEl().scrollTop));

  // —— 3. 去高亮 ——
  const mark = bodyEl().querySelector("mark");
  check("正文里确实有 mark", !!mark);
  selectNode(mark);
  check("选中高亮时按钮写「去高亮」", hlBtn.textContent === "去高亮", hlBtn.textContent);
  fire(hlBtn);
  await wait();
  check("去高亮写回库", writes.length === 2 &&
    String(writes[1].content_md).indexOf("==") < 0, JSON.stringify(writes[1] || {}));
  check("正文里没有 mark 了", bodyEl().innerHTML.indexOf("<mark>") < 0);

  // —— 4. 正文直改：改一个字 ——
  const rootNow = bodyEl().querySelector(".ko-kd-md"); // 去高亮重画过，重新取一次
  const target = findP("波长变长");
  target.textContent = "光子与电子碰撞后波长变长，这是重点。";
  target.dispatchEvent(new w.Event("input", { bubbles: true }));
  await wait(1200); // 防抖 900ms
  check("改字触发了自动保存", writes.length === 3, String(writes.length));
  check("保存的是反写回的 Markdown",
    writes[2] && String(writes[2].content_md).indexOf("这是重点。") >= 0,
    writes[2] ? String(writes[2].content_md).slice(0, 60) : "");
  check("自动保存不重画（光标不丢）", bodyEl().querySelector(".ko-kd-md") === rootNow);
  check("改的还是同一个 <p> 节点", target === findP("这是重点"));

  // —— 5. 块级结构反写不散架 ——
  const saved = String(writes[2].content_md);
  check("顶层标题还在", saved.indexOf("# 康普顿散射") >= 0);
  check("二级标题还在", saved.indexOf("## 一句话把握") >= 0);
  check("列表还在", saved.indexOf("- 偏移量只跟散射角有关") >= 0 && saved.indexOf("- 与入射波长无关") >= 0);
  check("引用还在", saved.indexOf("> 掌握度 6%") >= 0);

  // —— 6. 合订稿：同一套交互，但 scope 必须走 project 且 node_id 要空 ——
  await w.KnowOriginKnowledgeDoc.openCompiled(false);
  const compPara = findP("波长变长");
  check("合订稿也能读到正文", !!compPara);
  selectNode(compPara);
  fire(w.document.getElementById("ko-kd-hl"));
  await wait();
  const last = writes[writes.length - 1] || {};
  check("合订稿高亮写回 scope=project", last.scope === "project", String(last.scope));
  check("合订稿不带 node_id", last.node_id === "", JSON.stringify(last.node_id));
  check("合订稿正文出现高亮", bodyEl().innerHTML.indexOf("<mark>") >= 0);

  console.log(failures.length ? `\n${failures.length} 项未通过` : "\n全部通过");
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
