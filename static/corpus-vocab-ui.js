/* 知源 KnowOrigin · 语料摘录视图（自带样式与状态，独立于 english-vocab-ui.js）
 *
 * 为什么单独一个文件：english-vocab-ui.js 已经 2300 行，往里再塞一块「语料摘录」
 * 会让它变成两种功能的混合体，评审时看不出哪段代码属于谁。这里只做一件事——
 * 把 /api/en/corpus/* 摘出来的语料渲染成人能读、能采词的界面，并由
 * english-vocab-ui.js 在「📄 语料」页签里调 render() 挂上。
 *
 * 它解决的产品问题：内置词表回答「考试要考哪些词」，但不回答「你现在被哪些词绊住」。
 * 用户自己导入的中文/英文资料才回答后者——中文资料由后端转成英文表述，
 * 所以中文论文也能拿来学英语，摘出来的每一片都带术语表，点一下就进生词本（带原句）。
 */
(function () {
  "use strict";

  var API = "/api/en/corpus";
  var STYLE_ID = "ko-corpus-style";

  /* 注意：这里绝不能叫 state —— 会遮蔽 app.js 的全局 state，
     那样 window.enVocabProjectId() 就再也读不到 currentProjectId（已踩过）。 */
  var cv = {
    excerpts: [],
    stats: null,
    loading: false,
    scanning: false,
    progress: "",
    error: "",
    notice: "",
    openZh: {},      // excerpt_id -> 是否展开中文原文
    openSource: {},  // source_id -> 是否收起该资料分组
    picked: {},      // "excerpt_id::en" -> 是否勾选该术语
    /* excerpt_id -> { "term.en": true }，已经收进生词本的术语。
       拉列表时由服务端重建（服务端按「词在不在自动生词本里」算），
       收录成功时先乐观补一条。 */
    collected: {},
    skipped: [],     // 上一次收录没收进去的术语 [{ en, reason }]，必须让用户看见
    collectSel: null, // 当前手动划词收录的选区 { text, sample, sourceTitle }
    loadedFor: null, // 已加载语料的 projectId，用来判断项目是否换过
  };

  function esc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* ------------------------------------------------------------ 中文原文清洗
     与 core/corpus_vocab.py 的 clean_source_text() 同一套规则（JS 版）。
     为什么前端也要做：库里已存的语料片是按旧管线落的，中文原文里带着
     PDF 抽取的乱码（私用区字符、[[H:3]]/[[FIG:]] 标记、公式残渣）。
     重新扫描要花模型调用；显示时洗一遍是零成本的，旧数据立刻能读。 */

  function zhLooksLikeWord(token) {
    if (token.length < 3) return false;
    var alpha = (token.match(/[A-Za-z]/g) || []).length;
    if (alpha < token.length * 0.6) return false;
    var seen = {};
    var vowels = (token.toLowerCase().match(/[aeiou]/g) || []);
    for (var i = 0; i < vowels.length; i++) seen[vowels[i]] = 1;
    var kinds = 0;
    for (var k in seen) kinds++;
    return kinds >= 2;
  }

  function zhIsResidueToken(token) {
    if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(token)) return false; // 中文
    if (/^[A-Za-z]{3,}$/.test(token)) return false; // 纯字母短词（含 END/THE 这类大写词）
    if (zhLooksLikeWord(token)) return false; // 像英文单词（≥2 种元音）
    if (/[\u0370-\u03ff\u2190-\u22ff]/.test(token)) return false; // 希腊字母/数学符号=真公式，不下结论
    return true;
  }

  function zhStripInlineResidue(line) {
    var tokens = line.split(/\s+/).filter(Boolean);
    var kept = [];
    var run = [];
    function runIsResidue() {
      if (run.length < 3) return false;
      for (var i = 0; i < run.length; i++) {
        if (/[=]|<<|>>/.test(run[i])) return false; // 像真等式（H = H0 + H'），保留
      }
      return true;
    }
    function flush() {
      if (!runIsResidue()) kept = kept.concat(run);
      run = [];
    }
    for (var i = 0; i < tokens.length; i++) {
      if (zhIsResidueToken(tokens[i])) run.push(tokens[i]);
      else { flush(); kept.push(tokens[i]); }
    }
    flush();
    return kept.join(" ");
  }

  function zhIsResidueLine(line) {
    var tokens = line.split(/\s+/).filter(Boolean);
    if (!tokens.length) return false;
    if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(line)) return false; // 含中文的行再乱也留着
    for (var i = 0; i < tokens.length; i++) {
      if (zhLooksLikeWord(tokens[i])) return false; // 有一个像样的词就不算残渣行
    }
    return true;
  }

  function cleanZhOrigin(raw) {
    var body = String(raw == null ? "" : raw);
    body = body.replace(/\[\[(?:FIG|H|MATH):[^\]]*\]\]/g, " "); // 阅读器渲染标记
    body = body.replace(/[\ue000-\uf8ff\ufffd\u25a1\u25af\u25fb\u25fc\x00-\x08\x0b\x0c\x0e-\x1f\u200b\u200e\u200f]/g, ""); // 乱码字符
    body = body.replace(/[\u2022\u00b7]/g, " ");
    var cjkRe = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
    var lines = body.split("\n").map(function (rawLine) {
      return zhStripInlineResidue(rawLine).trim();
    }).filter(function (line) {
      return !(line && zhIsResidueLine(line));
    });
    // 空行=段落边界；单个换行=PDF 硬换行，拼回去（中文接中文不加空格）
    var paras = [];
    var buf = "";
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line) { if (buf) { paras.push(buf); buf = ""; } continue; }
      if (!buf) { buf = line; continue; }
      if (cjkRe.test(buf.charAt(buf.length - 1)) && cjkRe.test(line.charAt(0))) buf += line;
      else buf += " " + line;
    }
    if (buf) paras.push(buf);
    return paras.join("\n\n"); // 与 Python 版一致：段落间空行，保证幂等
  }

  /* 整理稿是模型按「空行分段、# 开头为小标题」给的：照这个渲染成段落，
     而不是把整块文本塞进 pre-wrap 里——用户要的是能读的结构，不是一坨。 */
  function renderZhParagraphs(text) {
    return String(text || "")
      .split(/\n{2,}/)
      .map(function (para) {
        var p = para.trim();
        if (!p) return "";
        var inner = esc(p).replace(/\n/g, "<br>");
        if (p.charAt(0) === "#") {
          return '<p class="ko-corpus-zh-h">' + inner.replace(/^#\s*/, "") + "</p>";
        }
        return "<p>" + inner + "</p>";
      })
      .join("");
  }

  function projectId() {
    if (typeof window.enVocabProjectId === "function") {
      try {
        return window.enVocabProjectId() || "";
      } catch (e) {}
    }
    try {
      return (typeof state !== "undefined" && state && state.currentProjectId) || "";
    } catch (e) {
      return "";
    }
  }

  /* 复用 english-vocab-ui.js 的 call()：它已经补了 Content-Type。
     自己再写一个 fetch 封装必然忘记补头，后端会一律 422（那是最难查的一类静默失败）。 */
  function call(path, options) {
    if (typeof window.enVocabCall === "function") return window.enVocabCall(path, options);
    var opts = options || {};
    var init = { method: opts.method || "GET", credentials: "same-origin" };
    if (opts.body !== undefined && opts.body !== null) {
      init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
      init.headers = { "Content-Type": "application/json" };
    }
    return fetch(path, init).then(function (response) {
      return response.json().catch(function () {
        return {};
      }).then(function (data) {
        if (!response.ok) {
          throw new Error((data && data.detail && data.detail.message) || "请求失败");
        }
        return data;
      });
    });
  }

  function rerender() {
    if (typeof window.enVocabRerenderVocab === "function") window.enVocabRerenderVocab();
  }

  /* ------------------------------------------------------------ 数据 */

  /* 每次拉列表都用服务端算的「已收」名单**重建**本地记账。
     为什么服务端说了算：内存记账一刷新就清零，换个入口（划词收录、手动加词）
     收进来的词也认不出来 —— 用户会看到「刚才收过的词又变成没收过」，再点一次
     「收录本片全部术语」却只新增 0 个，看起来就像没收全。反过来，只信本地
     记账则会把「实际没进去」的词一直标成已收，那批词再也收不了。
     所以：拉列表时以服务端为准，收录成功时先乐观补一条，下次拉取再校正。 */
  function syncCollected() {
    var next = {};
    cv.excerpts.forEach(function (item) {
      var done = {};
      ((item && item.collected) || []).forEach(function (en) {
        done[en] = true;
      });
      next[item.excerpt_id] = done;
    });
    cv.collected = next;
  }

  function isCollected(excerptId, en) {
    if (!en) return false;
    var done = cv.collected[excerptId] || {};
    return !!done[en];
  }

  function refresh() {
    cv.loading = true;
    cv.loadedFor = projectId();
    cv.skipped = [];
    rerender();
    return call(API + "/list?limit=100")
      .then(function (data) {
        cv.loading = false;
        cv.excerpts = (data && data.excerpts) || [];
        cv.stats = (data && data.stats) || null;
        syncCollected();
      })
      .catch(function (error) {
        cv.loading = false;
        cv.stats = cv.stats || {};
        cv.error = (error && error.message) || "语料加载失败";
      })
      .then(rerender);
  }

  /* 自己负责「第一次被画出来时去取数」，而不是指望调用方记得先调 refresh()：
     render() 可能因为概览刷新、项目切换、页签切换被调用很多次，
     只要不是「本项目已加载过」就补一次，比在三个地方各写一遍可靠。 */
  function ensureLoaded() {
    if (cv.loading) return;
    if (cv.stats !== null && cv.loadedFor === projectId()) return;
    refresh();
  }

  function scan() {
    var pid = projectId();
    if (!pid) {
      cv.error = "请先在左侧选择一个项目。";
      rerender();
      return;
    }
    cv.scanning = true;
    cv.error = "";
    cv.notice = "";
    cv.progress = "正在扫描…";
    rerender();

    fetch(API + "/scan", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: pid, max_chunks: 6 }),
    })
      .then(function (response) {
        if (response.status === 401) throw new Error("登录状态已失效，请刷新页面。");
        if (!response.ok || !response.body) throw new Error("扫描请求被拒绝。");
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var buffer = "";
        function pump() {
          return reader.read().then(function (chunk) {
            if (chunk.done) return null;
            buffer += decoder.decode(chunk.value, { stream: true });
            var parts = buffer.split("\n\n");
            buffer = parts.pop();
            parts.forEach(function (part) {
              var line = part.trim();
              if (line.indexOf("data:") !== 0) return;
              try {
                handleEvent(JSON.parse(line.slice(5).trim()));
              } catch (e) {}
            });
            return pump();
          });
        }
        return pump();
      })
      .catch(function (error) {
        cv.scanning = false;
        cv.progress = "";
        cv.error = (error && error.message) || "扫描失败";
        rerender();
      })
      .then(function () {
        cv.scanning = false;
        cv.progress = "";
        rerender();
        return refresh();
      });
  }

  function handleEvent(event) {
    if (!event || !event.type) return;
    if (event.type === "start") {
      cv.progress = event.total
        ? "共 " + event.total + " 份资料，开始摘录…" + (event.llm ? "（中文资料将由 AI 转成英文表述）" : "（未接模型：中文资料先留原文，接了模型再回来扫）")
        : "这个项目还没有导入资料。";
    } else if (event.type === "progress") {
      if (event.skipped) {
        cv.progress = "[" + event.current + "/" + event.total + "] " + (event.title || "") + "（正文太短，跳过）";
      } else if (event.failed) {
        cv.progress = "[" + event.current + "/" + event.total + "] " + (event.title || "") + " 摘录失败：" + (event.message || "");
      } else {
        cv.progress =
          "[" + event.current + "/" + event.total + "] " + (event.title || "") +
          (event.lang === "en" ? " · 英文资料，直接摘了 " : " · 中文资料，已转写 ") +
          (event.found || 0) + " 片";
      }
    } else if (event.type === "warn") {
      cv.progress = (event.title || "") + "：" + (event.message || "") ;
    } else if (event.type === "done") {
      var bits = [];
      bits.push("共摘出 " + (event.saved || 0) + " 片");
      if (event.skipped) bits.push("跳过 " + event.skipped + " 份（正文太短）");
      if (event.zh_pending) bits.push("有 " + event.zh_pending + " 片中文待转写");
      cv.notice = "摘录完成，" + bits.join("，") + "。";
      cv.progress = "";
    } else if (event.type === "error") {
      cv.error = event.message || "摘录出错";
      cv.progress = "";
    }
    rerender();
  }

  /* 这片里还没收进生词本的术语。
     已收的按「词」记账（excerpt_id -> { en: true }），不是按片记一个布尔——
     按片记的话，收「勾选的词」收掉三个里的一个，整片就被标成「✅ 已收录」，
     「收录本片全部术语」跟着消失，剩下的术语再也收不了（实测踩到的 bug）。
     按词记账还顺带挡住重复收录：同一个词不会被再挂一条一模一样的例句。 */
  function remainingTerms(excerpt, excerptId, onlyPicked) {
    var wanted = [];
    (excerpt.terms || []).forEach(function (term) {
      if (!term.en || isCollected(excerptId, term.en)) return;
      if (!onlyPicked || cv.picked[excerptId + "::" + term.en]) wanted.push(term.en);
    });
    return wanted;
  }

  /* 整片的术语是否都收完了。一片还没转写的中文语料「没有可收的术语」，
     不算收完——否则它会顶着一个「✅ 已收录」，看起来像收过了。 */
  function allCollected(excerpt) {
    var collectable = (excerpt.terms || []).filter(function (term) {
      return !!term.en;
    }).length;
    return collectable > 0 && !remainingTerms(excerpt, excerpt.excerpt_id, false).length;
  }

  function promote(excerptId, onlyPicked) {
    var excerpt = null;
    cv.excerpts.forEach(function (item) {
      if (item.excerpt_id === excerptId) excerpt = item;
    });
    if (!excerpt) return;
    var wanted = remainingTerms(excerpt, excerptId, onlyPicked);
    if (!wanted.length) {
      cv.error = onlyPicked
        ? "这片里没有可收的词——先勾选术语，或者它还没被转写成英文。"
        : "这片术语都已经在生词本里了。";
      rerender();
      return;
    }
    call(API + "/promote", {
      method: "POST",
      body: { excerpt_id: excerptId, terms: wanted },
    })
      .then(function (data) {
        cv.error = "";
        var done = cv.collected[excerptId] || (cv.collected[excerptId] = {});
        /* 只把服务端点名收下的词标成「已收」。
           以前是照着请求里那批全标——后端把带括号缩写、带数字、超过 3 个词的
           术语（Schrödinger equation / Optical Coherence Tomography (OCT)）静默
           丢掉，界面却把它们全打成已收，于是「收录本片全部术语」永远收不全，
           剩下那几个还再也点不了。现在没收进去的留在原地，并说明原因。 */
        var accepted =
          data && Array.isArray(data.accepted) && data.accepted.length
            ? data.accepted
            : wanted; // 老后端/桩应答没有 accepted 时退回请求集，行为不变
        var skipped = (data && Array.isArray(data.skipped) && data.skipped) || [];
        var okSet = {};
        accepted.forEach(function (en) {
          okSet[en] = true;
          done[en] = true;
          delete cv.picked[excerptId + "::" + en];
        });
        // 没收进去的保留勾选状态，用户一眼能看见是哪些没进去
        skipped.forEach(function (item) {
          if (item && item.en && !okSet[item.en]) {
            cv.picked[excerptId + "::" + item.en] = true;
          }
        });
        cv.skipped = skipped;

        var bits = [];
        var existing = (data && Number(data.existing)) || 0;
        bits.push("新收 " + ((data && Number(data.added)) || 0) + " 个词");
        if (existing) bits.push(existing + " 个本来就在生词本里（原句已补上）");
        if (data && data.contexts) bits.push(data.contexts + " 个带上了这句原文");
        cv.notice = "已收进生词本：" + bits.join("，") + "。";
        // 顺手刷新概览：页签上的「生词本 / 待加入」角标来自 overview，
        // 不刷的话刚收进去的词不会体现在角标里，看起来像没生效。
        if (typeof window.enVocabReloadOverview === "function") {
          window.enVocabReloadOverview();
        } else {
          rerender();
        }
      })
      .catch(function (error) {
        cv.error = (error && error.message) || "收录失败";
        rerender();
      });
  }

  function discard(excerptId) {
    call(API + "/" + encodeURIComponent(excerptId), { method: "DELETE" })
      .then(function () {
        cv.notice = "已丢掉这片语料。";
        return refresh();
      })
      .catch(function (error) {
        cv.error = (error && error.message) || "丢弃失败";
        rerender();
      });
  }

  /* ------------------------------------------------------------ 手动划词收录 */

  var SELBAR_ID = "ko-corpus-selbar";
  var CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

  function selbarNode() {
    return document.getElementById(SELBAR_ID);
  }

  function hideSelbar() {
    var node = selbarNode();
    if (node) node.remove();
    cv.collectSel = null;
  }

  /* 浮条挂 body（.studio-output 是 overflow:hidden，塞进去会被裁掉；
     fixed 定位不受裁剪，与考研精读的划词条同一套做法）。 */
  function ensureSelbar() {
    var node = selbarNode();
    if (!node) {
      node = document.createElement("div");
      node.id = SELBAR_ID;
      // mousedown 阻止冒泡：不然 document 上的收起逻辑会先把浮条关掉
      node.addEventListener("mousedown", function (e) {
        e.stopPropagation();
      });
      /* click 也必须拦：词汇界面是全屏工作台（state.studioFocus）里用的，
         app.js 的 closeStudioFocusFromBackdrop 在 document 上按 click 判「点了背板」，
         浮条挂 body、在 .studio-panel 之外 → 点「收进生词本」会被当成背板点击，
         整个工作台直接收起退回主界面。mousedown 的 stopPropagation 挡不住 click。
         拦掉后 document 级委托收不到这个 click，所以浮条上的两个动作就地处理。 */
      node.addEventListener("click", function (e) {
        e.stopPropagation();
        var btn = e.target && e.target.closest ? e.target.closest("[data-corpus-action]") : null;
        if (!btn) return;
        var action = btn.getAttribute("data-corpus-action");
        if (action === "collect-sel") collectPicked();
        else if (action === "collect-cancel") hideSelbar();
      });
      node.innerHTML =
        '<span class="ko-cs-quote"></span>' +
        '<button type="button" class="en-btn primary" data-corpus-action="collect-sel"' +
        ' style="padding:3px 10px; font-size:calc(11.5px * var(--font-scale, 1));">📒 收进生词本</button>' +
        '<button type="button" class="en-btn" data-corpus-action="collect-cancel"' +
        ' style="padding:3px 8px; font-size:calc(11.5px * var(--font-scale, 1));" title="取消">✕</button>';
      document.body.appendChild(node);
    }
    return node;
  }

  /* 从选区读出要收的词和它所在的原句语境。
     sample 不追求切出完整句子：前后各 140 字的语境足够辨识「是在哪句话里
     被这个词绊住的」，与 promote 找不到例句时退回整片的口径一致。 */
  function captureCorpusSelection() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      hideSelbar();
      return;
    }
    var range = sel.getRangeAt(0);
    var node = range.startContainer;
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    var host = el && el.closest ? el.closest(".ko-corpus-en") : null;
    if (!host) {
      hideSelbar();
      return;
    }
    var text = String(sel.toString() || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || text.length > 120 || CJK_RE.test(text)) {
      // 只收英文：中文正文的词要走「重新扫描」由 AI 转写后收，这里弹了也收不进
      hideSelbar();
      return;
    }

    var full = host.textContent || "";
    var at = full.indexOf(text);
    var sample =
      at >= 0
        ? full.slice(Math.max(0, at - 140), Math.min(full.length, at + text.length + 140)).trim()
        : "";

    var card = host.closest(".en-card");
    var titleEl = card && card.querySelector(".ko-corpus-group-title");
    var sourceTitle = titleEl ? titleEl.textContent.replace(/^📄\s*/, "").trim() : "";

    var bar = ensureSelbar();
    bar.querySelector(".ko-cs-quote").textContent = text;
    var btn = bar.querySelector('[data-corpus-action="collect-sel"]');
    if (btn) {
      btn.disabled = false;
      btn.textContent = "📒 收进生词本";
    }
    var rect = range.getBoundingClientRect();
    var left = Math.max(8, Math.min(rect.left + rect.width / 2 - bar.offsetWidth / 2, window.innerWidth - bar.offsetWidth - 8));
    var top = rect.top - bar.offsetHeight - 8;
    if (top < 8) top = rect.bottom + 8; // 贴顶时放选区下方
    bar.style.left = left + "px";
    bar.style.top = top + "px";
    cv.collectSel = { text: text, sample: sample, sourceTitle: sourceTitle };
  }

  function collectPicked() {
    var info = cv.collectSel;
    if (!info || !info.text) {
      hideSelbar();
      return;
    }
    var bar = selbarNode();
    var btn = bar && bar.querySelector('[data-corpus-action="collect-sel"]');
    if (btn) {
      btn.disabled = true;
      btn.textContent = "收录中…";
    }
    call(API + "/collect", {
      method: "POST",
      body: {
        text: info.text,
        sample: info.sample,
        source_title: info.sourceTitle || "",
      },
    })
      .then(function (data) {
        var lemma = (data && data.lemma) || info.text;
        cv.error = "";
        cv.notice =
          "已收进生词本：" + lemma +
          (data && data.contexts ? "（带上了原文语境）" : "") + "。";
        hideSelbar();
        // 角标（待加入/生词本数）来自 overview，刷新一下；render 现在会保住滚动位置
        if (typeof window.enVocabReloadOverview === "function") {
          window.enVocabReloadOverview();
        } else {
          rerender();
        }
      })
      .catch(function (error) {
        cv.error = (error && error.message) || "收录失败";
        hideSelbar();
        rerender();
      });
  }

  /* ------------------------------------------------------------ 渲染 */

  function renderStats() {
    var stats = cv.stats || {};
    var zh = stats.zh_excerpts || 0;
    return (
      '<div class="en-card"><div class="en-stats">' +
      '<div class="en-stat"><b>' + (stats.sources || 0) + "</b><span>资料份数</span></div>" +
      '<div class="en-stat"><b>' + (stats.excerpts || 0) + "</b><span>语料片数</span></div>" +
      '<div class="en-stat"><b>' + (stats.terms || 0) + "</b><span>术语条数</span></div>" +
      "</div>" +
      (zh
        ? '<div class="ko-corpus-zh-hint">其中 <b>' + zh + '</b> 片来自中文资料，已由 AI 转写成英文表述——中文论文也能拿来学英语。</div>'
        : "") +
      '<div class="en-actions">' +
      '<button class="en-btn primary" data-corpus-action="scan"' + (cv.scanning ? " disabled" : "") + ">" +
      (cv.scanning ? "正在摘录…" : (stats.excerpts ? "重新扫描当前项目" : "扫描当前项目")) +
      "</button>" +
      '<button class="en-btn" data-corpus-action="refresh">刷新</button>' +
      "</div>" +
      (cv.progress ? '<div class="ko-corpus-progress">' + esc(cv.progress) + "</div>" : "") +
      "</div>"
    );
  }

  function renderTerms(excerpt) {
    var terms = excerpt.terms || [];
    if (!terms.length) {
      return '<div class="en-muted" style="font-size:calc(11.5px * var(--font-scale, 1))">这片还没抽出术语。</div>';
    }
    return (
      '<div class="ko-corpus-terms">' +
      terms
        .map(function (term) {
          var key = excerpt.excerpt_id + "::" + term.en;
          var on = !!cv.picked[key];
          var isDone = isCollected(excerpt.excerpt_id, term.en);
          if (!term.en) {
            // 中文资料但还没转写：只展示中文锚点，不能勾
            return '<span class="ko-corpus-term is-pending">' + esc(term.zh || "") + "<i>待转写</i></span>";
          }
          if (isDone) {
            // 已经在生词本里：留个记号但不再可点，免得重复收录挂出重复例句
            return (
              '<span class="ko-corpus-term is-collected" title="已经在生词本里了">' +
              "<b>" + esc(term.en) + "</b>" +
              (term.zh ? "<i>" + esc(term.zh) + "</i>" : "") +
              "<em>已收</em></span>"
            );
          }
          return (
            '<button class="ko-corpus-term' + (on ? " is-picked" : "") +
            '" data-corpus-action="pick" data-excerpt="' + esc(excerpt.excerpt_id) +
            '" data-en="' + esc(term.en) + '" title="' + esc(term.gloss || "点一下勾选，再点「收录勾选的词」") + '">' +
            "<b>" + esc(term.en) + "</b>" +
            (term.zh ? "<i>" + esc(term.zh) + "</i>" : "") +
            (term.pos ? '<em>' + esc(term.pos) + "</em>" : "") +
            "</button>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function renderExcerpt(excerpt) {
    var langTag = excerpt.lang === "en" ? "英文资料" : "中文资料 · AI 转写";
    var eid = excerpt.excerpt_id;
    var left = remainingTerms(excerpt, eid, false).length;      // 还没收的术语数
    var pickedCount = remainingTerms(excerpt, eid, true).length; // 勾了、且还没收的
    var zhOpen = !!cv.openZh[excerpt.excerpt_id];
    var english = String(excerpt.english_text || "");
    var body = english
      ? '<div class="ko-corpus-en">' + esc(english) + "</div>"
      : '<div class="ko-corpus-pending">这片中文还没转写成英文——接上模型后重新扫描即可（下面的术语是规则抽的中文锚点，先留着）。</div>';

    var zhBlock = "";
    if (excerpt.lang !== "en" && (excerpt.origin_clean || excerpt.origin_text)) {
      // 优先显示模型整理稿：它补齐了 PDF 抽取的缺字与断句，还分好了段和小标题。
      // 没有整理稿（旧数据/无模型）时退回规则清洗过的 PDF 原文，并如实标注来源。
      var hasClean = !!String(excerpt.origin_clean || "").trim();
      zhBlock =
        '<div class="ko-corpus-zh-toggle" data-corpus-action="toggle-zh" data-excerpt="' +
        esc(excerpt.excerpt_id) + '">' +
        (zhOpen ? "▲ 收起中文原文" : "▼ 看中文原文对照") +
        "</div>" +
        (zhOpen
          ? '<div class="ko-corpus-zh' + (hasClean ? " is-structured" : "") + '">' +
            '<div class="ko-corpus-zh-tag">' +
            (hasClean
              ? "AI 整理稿 · 已补全断句与缺字"
              : "PDF 原文 · 已滤除公式乱码（重新扫描可得 AI 整理稿）") +
            "</div>" +
            (hasClean
              ? renderZhParagraphs(excerpt.origin_clean)
              : esc(cleanZhOrigin(excerpt.origin_text))) +
            "</div>"
          : "");
    }

    return (
      '<div class="ko-corpus-piece">' +
      '<div class="ko-corpus-piece-head">' +
      '<span class="ko-corpus-lang">' + esc(langTag) + "</span>" +
      (excerpt.gist ? '<span class="ko-corpus-gist">' + esc(excerpt.gist) + "</span>" : "") +
      "</div>" +
      body +
      zhBlock +
      renderTerms(excerpt) +
      '<div class="en-actions" style="margin-bottom:0">' +
      (allCollected(excerpt)
        ? '<button class="en-btn" disabled style="opacity:.72; cursor:default;">✅ 已收录</button>'
        : '<button class="en-btn primary" data-corpus-action="promote-all" data-excerpt="' +
          /* 带上还剩几个：用户点「收录本片全部术语」后对照这个数字，
             一眼就能看出是不是真收全了（以前收不全还以为是玄学）。 */
          esc(excerpt.excerpt_id) + '">收录本片全部术语（' + left + "）</button>") +
      '<button class="en-btn" data-corpus-action="promote-picked" data-excerpt="' +
      esc(excerpt.excerpt_id) + '"' + (pickedCount ? "" : " disabled style=\"opacity:.62; cursor:default;\"") +
      ">收录勾选的词" + (pickedCount ? "（" + pickedCount + "）" : "") + "</button>" +
      '<button class="en-btn" data-corpus-action="discard" data-excerpt="' +
      esc(excerpt.excerpt_id) + '">丢掉这片</button>' +
      "</div></div>"
    );
  }

  function renderGroups() {
    if (!cv.excerpts.length) {
      return (
        '<div class="en-card"><p class="en-title">还没有语料</p>' +
        '<div class="en-empty">点上面的「扫描当前项目」，我会把你导入的资料读一遍：<br>' +
        "英文资料直接摘出含金量最高的段落；<br>" +
        "中文资料由 AI 转写成英文表述，并抽出术语的中英对照。<br>" +
        "然后你就能从这里选词进生词本——每个词都带着它在资料里的那句话。</div></div>"
      );
    }

    var groups = [];
    var index = {};
    cv.excerpts.forEach(function (item) {
      var key = item.source_id || item.source_title || "unknown";
      if (!index[key]) {
        index[key] = { title: item.source_title || "未命名资料", items: [] };
        groups.push(index[key]);
      }
      index[key].items.push(item);
    });

    return groups
      .map(function (group, gi) {
        var sid = group.items[0].source_id || String(gi);
        var folded = !!cv.openSource[sid]; // 收起状态（默认展开，先给用户看见内容）
        return (
          '<div class="en-card"><div class="ko-corpus-group-head" data-corpus-action="toggle-source" data-source="' +
          esc(sid) + '">' +
          '<span class="ko-corpus-group-title">📄 ' + esc(group.title) + "</span>" +
          '<span class="en-muted" style="font-size:calc(11.5px * var(--font-scale, 1))">' + group.items.length + " 片 " +
          (folded ? "▶" : "▼") + "</span></div>" +
          (folded ? "" : group.items.map(renderExcerpt).join("")) +
          "</div>"
        );
      })
      .join("");
  }

  /* 没收进去的术语必须点名：静默丢词就是「收录本片全部术语收不全」的全部成因。
     每条 reason 里已经带上了那个词，直接拼起来就是一句人话。 */
  function renderSkipped() {
    if (!cv.skipped || !cv.skipped.length) return "";
    var lines = cv.skipped.slice(0, 3).map(function (item) {
      return esc(item.reason || "「" + (item.en || "") + "」没收进去。");
    });
    if (cv.skipped.length > 3) lines.push("等 " + cv.skipped.length + " 个");
    return (
      '<div class="en-note error">有 ' + cv.skipped.length + " 条术语没收进生词本：" +
      lines.join("；") + "。它们还留在这片里，划词选中其中一段就能单独收。</div>"
    );
  }

  function render() {
    injectStyle();
    ensureLoaded();
    return (
      '<div class="ko-corpus-wrap">' +
      (cv.error ? '<div class="en-note error">' + esc(cv.error) + "</div>" : "") +
      (cv.notice && !cv.error ? '<div class="en-note">' + esc(cv.notice) + "</div>" : "") +
      (!cv.error ? renderSkipped() : "") +
      renderStats() +
      (cv.loading && !cv.excerpts.length
        ? '<div class="en-card"><div class="en-empty">正在读取语料…</div></div>'
        : renderGroups()) +
      "</div>"
    );
  }

  /* ------------------------------------------------------------ 样式 */

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var node = document.createElement("style");
    node.id = STYLE_ID;
    node.textContent = [
      /* 一律用主题变量，不硬编码颜色：深色主题下才不会被一块白底刺穿 */
      ".ko-corpus-wrap { display: flex; flex-direction: column; gap: 0; }",
      ".ko-corpus-zh-hint { margin-top: 8px; font-size: calc(11.5px * var(--font-scale, 1)); line-height: 1.7; color: var(--muted); border-left: 2px solid var(--gold); padding-left: 8px; }",
      ".ko-corpus-zh-hint b { color: var(--gold); }",
      ".ko-corpus-progress { margin-top: 8px; font-size: calc(11.5px * var(--font-scale, 1)); line-height: 1.6; color: var(--muted); }",
      ".ko-corpus-group-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; cursor: pointer; user-select: none; }",
      ".ko-corpus-group-head:hover .ko-corpus-group-title { color: var(--green); }",
      ".ko-corpus-group-title { font-size: calc(13px * var(--font-scale, 1)); font-weight: 500; color: var(--ink); }",
      ".ko-corpus-piece { border: 1px solid var(--line); border-radius: 10px; padding: 11px 12px; margin-top: 10px; background: rgba(127,127,127,.03); }",
      ".ko-corpus-piece-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }",
      ".ko-corpus-lang { font-size: calc(10.5px * var(--font-scale, 1)); padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }",
      ".ko-corpus-gist { font-size: calc(11.5px * var(--font-scale, 1)); color: var(--muted); font-style: italic; }",
      /* 英文正文：这是用户真正要读的东西，行距放宽、字略大 */
      ".ko-corpus-en { font-size: calc(13.5px * var(--font-scale, 1)); line-height: 1.9; color: var(--ink); letter-spacing: .2px; margin-bottom: 8px; }",
      ".ko-corpus-pending { font-size: calc(12px * var(--font-scale, 1)); line-height: 1.7; color: var(--muted); padding: 8px 10px; border-radius: 8px; border: 1px dashed var(--line); margin-bottom: 8px; }",
      ".ko-corpus-zh-toggle { font-size: calc(11.5px * var(--font-scale, 1)); color: var(--muted); cursor: pointer; margin-bottom: 6px; }",
      ".ko-corpus-zh-toggle:hover { color: var(--green); }",
      ".ko-corpus-zh { font-size: calc(12.5px * var(--font-scale, 1)); line-height: 1.8; color: var(--muted); padding: 8px 10px; border-radius: 8px; background: rgba(127,127,127,.06); border-left: 2px solid var(--line); margin-bottom: 8px; white-space: pre-wrap; }",
      /* 整理稿按段落渲染，pre-wrap 会把模型给的换行原样堆出来，反而更乱 */
      ".ko-corpus-zh.is-structured { white-space: normal; }",
      ".ko-corpus-zh p { margin: 0 0 7px; }",
      ".ko-corpus-zh p:last-child { margin-bottom: 0; }",
      ".ko-corpus-zh-h { color: var(--ink); font-weight: 600; font-size: calc(12.5px * var(--font-scale, 1)); }",
      ".ko-corpus-zh-tag { font-size: calc(10.5px * var(--font-scale, 1)); color: var(--gold); opacity: .9; margin-bottom: 6px; }",
      ".ko-corpus-terms { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 10px; }",
      ".ko-corpus-term { display: inline-flex; align-items: baseline; gap: 5px; border: 1px solid var(--line); background: transparent; border-radius: 7px; padding: 3px 8px; cursor: pointer; font-size: calc(12px * var(--font-scale, 1)); color: var(--ink); transition: all .15s ease; }",
      ".ko-corpus-term:hover { border-color: var(--green); }",
      ".ko-corpus-term b { font-weight: 600; }",
      ".ko-corpus-term i { font-style: normal; font-size: calc(11px * var(--font-scale, 1)); color: var(--muted); }",
      ".ko-corpus-term em { font-style: normal; font-size: calc(10.5px * var(--font-scale, 1)); color: var(--muted); opacity: .8; }",
      ".ko-corpus-term.is-picked { border-color: var(--green); background: rgba(34,197,94,.12); }",
      ".ko-corpus-term.is-picked i, .ko-corpus-term.is-picked em { color: var(--green); }",
      ".ko-corpus-term.is-pending { cursor: default; opacity: .65; }",
      ".ko-corpus-term.is-pending i { font-size: calc(10px * var(--font-scale, 1)); }",
      ".ko-corpus-term.is-collected { cursor: default; border-color: var(--green); opacity: .72; }",
      ".ko-corpus-term.is-collected em { color: var(--green); }",
      /* 手动划词收录浮条：挂 body，z-index 与考研精读划词条同档（1570） */
      "#ko-corpus-selbar { position: fixed; z-index: 1570; display: flex; align-items: center; gap: 6px; background: var(--panel); border: 1px solid var(--line); border-radius: 9px; box-shadow: 0 8px 26px rgba(0,0,0,.14); padding: 6px 8px; font-size: calc(12px * var(--font-scale, 1)); color: var(--ink); }",
      "#ko-corpus-selbar .ko-cs-quote { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }",
    ].join("\n");
    document.head.appendChild(node);
  }

  /* ------------------------------------------------------------ 事件 */

  /* 用 document 上的委托而不是绑在容器上：容器每渲染一次就被 innerHTML 重写，
     绑在容器上需要每次重绑，漏一次整块就死了。委托只绑一次，天生免疫重渲染。

     注意选择器前缀是 data-corpus-action —— 绝不能用 data-en-action：
     那是 english-vocab-ui.js / app.js 的事件命名空间，混用会被它们的处理器抢走。 */
  function onClick(evt) {
    var node = evt.target && evt.target.closest
      ? evt.target.closest("[data-corpus-action]")
      : null;
    if (!node) return;
    var action = node.getAttribute("data-corpus-action");
    var excerptId = node.getAttribute("data-excerpt");

    if (action === "scan") {
      scan();
    } else if (action === "refresh") {
      cv.error = "";
      cv.notice = "";
      refresh();
    } else if (action === "toggle-zh") {
      cv.openZh[excerptId] = !cv.openZh[excerptId];
      rerender();
    } else if (action === "toggle-source") {
      var sid = node.getAttribute("data-source");
      cv.openSource[sid] = !cv.openSource[sid];
      rerender();
    } else if (action === "pick") {
      var key = excerptId + "::" + node.getAttribute("data-en");
      cv.picked[key] = !cv.picked[key];
      rerender();
    } else if (action === "promote-all") {
      promote(excerptId, false);
    } else if (action === "promote-picked") {
      promote(excerptId, true);
    } else if (action === "discard") {
      discard(excerptId);
    } else if (action === "collect-sel") {
      collectPicked();
    } else if (action === "collect-cancel") {
      hideSelbar();
    } else {
      return;
    }
    evt.preventDefault();
  }

  document.addEventListener("click", onClick, false);

  /* 正文划词 → 弹「收进生词本」浮条。mouseup 后延迟一帧读选区，
     与考研精读划词同样的时序（拖选刚结束时 selection 可能还没定下来）。
     点浮条本身不触发重收（closest 挡掉），点正文外任何地方自动收起。 */
  document.addEventListener("mouseup", function (evt) {
    if (!evt.target || !evt.target.closest) return;
    if (evt.target.closest("#" + SELBAR_ID)) return;
    setTimeout(captureCorpusSelection, 0);
  }, false);

  document.addEventListener("keydown", function (evt) {
    if (evt.key === "Escape" && selbarNode()) hideSelbar();
  }, false);

  /* ------------------------------------------------------------ 出口 */

  window.KnowOriginCorpus = {
    render: render,
    refresh: refresh,
    view: cv,
  };
})();
