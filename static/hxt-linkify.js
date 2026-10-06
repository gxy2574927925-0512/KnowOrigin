/* 海小棠回答里「原文 URL 可点化」增强（独立 addon，不改 app.js / hxt-pet.js）
 *
 * 背景：hxt-pet.js 的 renderChat 只处理粗体/斜体/行内码，不认链接，所以回答里的
 * 「原文：https://mp.weixin.qq.com/s/xxx」是点不开的死文本。这里在它的消息容器上
 * 做一层纯增强：流式更新会重写 innerHTML，所以每次都要重新链接化。
 *
 * 触发：观察海小棠消息容器 [data-hxt-msgs] 的 DOM 变化（含流式增量），用 rAF 节流后
 *       对每条 .hxt-dmsg-b 做 URL -> <a> 链接化。已链接化的盒子会被跳过，防止观察者自激。
 *
 * 此文件从原「校园速递」addon 中抽离，仅保留链接增强，与校园速递功能无关。
 * 删除此文件即可让海小棠回答里的链接回到纯文本（不可点）。
 */
(function () {
  "use strict";

  // 排除全角标点，避免把 URL 后的中文句号/括号算进链接里
  var LINK_RE = /(https?:\/\/[^\s<>"'\uFF09\uFF0C\u3002\uFF1B\u3001]+)/g;

  function linkifyIn(root) {
    if (!root) return;
    var boxes = root.querySelectorAll ? root.querySelectorAll(".hxt-dmsg-b") : [];
    for (var i = 0; i < boxes.length; i++) {
      var box = boxes[i];
      if (box.querySelector("a.wxfeed-link")) continue;   // 已处理过（也防止观察者自激）
      var walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT, null);
      var targets = [];
      var node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue && node.nodeValue.indexOf("http") >= 0) targets.push(node);
      }
      targets.forEach(function (textNode) {
        var text = textNode.nodeValue || "";
        LINK_RE.lastIndex = 0;
        if (!LINK_RE.test(text)) return;
        LINK_RE.lastIndex = 0;
        var frag = document.createDocumentFragment();
        var last = 0;
        var m;
        while ((m = LINK_RE.exec(text))) {
          if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
          var a = document.createElement("a");
          a.className = "wxfeed-link";
          a.href = m[1];
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = m[1].length > 56 ? m[1].slice(0, 56) + "…" : m[1];
          frag.appendChild(a);
          last = m.index + m[1].length;
        }
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        if (textNode.parentNode) textNode.parentNode.replaceChild(frag, textNode);
      });
    }
  }

  function watchHxtMessages() {
    var pending = null;
    var mo = new MutationObserver(function () {
      if (pending) return;
      var msgs = document.querySelector("[data-hxt-msgs]");
      if (!msgs) return;
      // 流式回答每来一小段就重写一次 DOM，用 rAF 节流，避免每次都全量扫
      pending = (window.requestAnimationFrame || setTimeout)(function () {
        pending = null;
        linkifyIn(msgs);
      });
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  function boot() {
    watchHxtMessages();
    // 主动处理一次：若消息容器在 boot 时已存在（非流式首屏内容），也能立即链接化
    linkifyIn(document.querySelector("[data-hxt-msgs]"));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
