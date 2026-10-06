/* 知源 · 英语词汇面板
   ============================================================
   为什么单独一个文件：
     这里只做「加一个页签 + 一个覆盖层视图 + 调用 /api/en/*」。样式在本文件里注入，
     不碰 app.js / styles.css / index.html 的核心结构 —— 删掉这个文件（和 index.html
     里那行 <script>）就等于完全回退。

   四个已经踩过的坑（改动前请先读）：
     1. 第 6 个页签用 `data-en-entry` 而**不是** `data-feature`。app.js 在加载时对
        所有 `.feature-button` 绑了 `switchFeature(button.dataset.feature)`，
        本脚本又在 app.js 之后执行，所以新按钮不会被误绑；但若用了 data-feature，
        一旦脚本顺序变化就会被喂 undefined。
     2. 反过来白捡一个好处：app.js 的 switchFeature 会
        `toggle("active", button.dataset.feature === feature)`，我们这个按钮的
        dataset.feature 恒为 undefined，所以用户点别的页签时高亮会自动掉。
     3. `#studio-output` 是 innerHTML 重渲染的，绝不能往里插节点。我们的视图是
        `.studio-panel` 的直接子元素 + position:absolute —— 绝对定位不占 grid 行，
        所以 `.studio-panel { grid-template-rows: auto auto 1fr }` 不会被撑坏
        （多一个 static 子元素会把 #studio-output 挤到隐式第 4 行，布局崩掉）。
     4. 只写主题变量（--panel/--ink/--line/--muted/--green/--gold/--red），
        深浅色与通用/天大两套品牌自动适配，绝不硬编码颜色。
   ============================================================ */
(function () {
  "use strict";

  var API = "/api/en";
  var STYLE_ID = "en-vocab-style";
  var VIEW_ID = "en-vocab-view";
  var BUTTON_FLAG = "enVocabBound";

  var view = {
    // 默认落在「语料」：词从用户自己的资料里来，这是主渠道，不是备选项
    tab: "corpus",
    overview: null,
    // 内置词表默认收起：它只是「资料还没导入时的兜底」，不是主推路径
    showBuiltin: false,
    queue: [],
    index: 0,
    preview: {},
    candidates: [],
    picked: {},
    busy: false,
    scan: null,
    error: "",
    notice: "",
    extras: {}, // lemma -> 拓展数据（含 ai_error 时表示生成失败）
    extrasLoading: "",
    extrasOpen: false,
    answerShown: false, // 释义卡是否展开（重渲染时不能丢，否则"先看释义"会被折叠回去）
    showFullMeaning: false, // 是否展开词典原始长释义
    queueMeta: null,   // {review_count, new_count, new_today, new_per_day}
    prefill: "",       // 批量预生成拓展的状态文案
    spokenFor: "",     // 已自动朗读过的词，避免重渲染时重复发音
    autoSpeak: readAutoSpeak(), // 函数声明会提升，这里可以直接调用
    notebook: null,        // 生词本页签的数据
    notebookLoading: false,
    lookup: "",            // 手动加词时的查词结果
    addContext: false,     // 加词表单是否展开"原句"输入框
    roundWords: [],        // 本轮已学词列表 [{word, lemma, meaning, rating, phonetic, tags, root_explain}]
    roundFinished: false,  // 是否展示本轮通关结算与联结故事
    combo: 0,              // 连击数（连续 3 或 4 分）
    maxCombo: 0,           // 本轮最高连击
    story: null,           // AI 生成的联结短文与助记
    storyLoading: false,   // 是否正在生成故事
    storySpeaking: false,  // 是否正在朗读故事
    storyShowZh: true,     // 是否展示中文对译
    storyMode: "read",     // "read" | "cloze" (故事阅读 / 挖词填空挑战)
    clozeAnswers: {},      // wordLower -> user input
    clozeRevealed: {},     // wordLower -> boolean
    spellMode: false,      // 拼写模式：听发音输入拼写（主动回忆），不显示单词
    spellInput: "",        // 拼写输入框的当前值
    spellResult: "",       // "" | "correct" | "wrong" —— 本次比对结果
    filterDeck: null,      // 筛熟词面板 {deck_id, name, suggest, total, loading}
    history: null,         // 记忆曲线 {days, history: [{day, count}]}
  };

  /* ------------------------------------------------------------ 发音（浏览器自带 TTS）

     为什么用 Web Speech API 而不是服务端音频：知源是本地优先产品，
     发音不该依赖网络请求；浏览器自带英文语音零成本零依赖。
     不支持的极旧内核静默降级成"没声音"，不影响背单词。 */

  var AUTO_SPEAK_KEY = "knoworigin_en_autospeak";
  var _voice = null;

  function readAutoSpeak() {
    try {
      return localStorage.getItem(AUTO_SPEAK_KEY) !== "0"; // 默认开
    } catch (e) {
      return true;
    }
  }

  function writeAutoSpeak(value) {
    try {
      localStorage.setItem(AUTO_SPEAK_KEY, value ? "1" : "0");
    } catch (e) {
      /* 隐私模式写不了 localStorage，只在本次会话生效 */
    }
  }

  function pickVoice() {
    try {
      var list = window.speechSynthesis.getVoices() || [];
      if (!list.length) return null;
      if (_voice && list.indexOf(_voice) >= 0) return _voice;
      var english = list.filter(function (v) {
        return /^en([-_]|$)/i.test(v.lang || "");
      });
      _voice =
        english.filter(function (v) {
          return /[-_](US|GB)/i.test(v.lang || "");
        })[0] ||
        english[0] ||
        null;
      return _voice;
    } catch (e) {
      return null;
    }
  }

  function speak(text) {
    var content = String(text || "").trim();
    if (!content || !window.speechSynthesis || typeof SpeechSynthesisUtterance === "undefined") {
      return;
    }
    try {
      window.speechSynthesis.cancel(); // 连点时不排队，只念最后点的那个
      var utterance = new SpeechSynthesisUtterance(content);
      utterance.lang = "en-US";
      utterance.rate = 0.92;
      var voice = pickVoice();
      if (voice) utterance.voice = voice;
      window.speechSynthesis.speak(utterance);
    } catch (e) {
      /* 发音失败不影响背单词 */
    }
  }

  function maybeAutoSpeak(word) {
    if (!view.autoSpeak || !word) return;
    var key = String(word.word_id || word.lemma || "");
    if (!key || view.spokenFor === key) return;
    view.spokenFor = key;
    speak(word.lemma || word.word);
  }

  /* ---------------------------------------------------------------- 工具 */

  function esc(value) {
    try {
      return escapeHtml(String(value == null ? "" : value));
    } catch (e) {
      var node = document.createElement("div");
      node.textContent = String(value == null ? "" : value);
      return node.innerHTML;
    }
  }

  function currentProjectId() {
    try {
      return (typeof state !== "undefined" && state && state.currentProjectId) || "";
    } catch (e) {
      return "";
    }
  }

  function call(path, options) {
    /* 注意：app.js 的 api() 是 `fetch(path, {credentials, ...options})`，即 options
       会被原样摊给 fetch。所以**不能直接把对象当 body 传**——那会被 fetch 转成
       字符串 "[object Object]"，后端一律 422（这是实测踩到的坑，会让所有 POST 静默失败）。
       这里统一在这里序列化并补 Content-Type。 */
    var opts = options || {};
    var init = { method: opts.method || "GET" };
    if (opts.body !== undefined && opts.body !== null) {
      init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
      init.headers = { "Content-Type": "application/json" };
    }
    if (typeof api === "function") return api(path, init);

    init.credentials = "same-origin";
    return fetch(path, init).then(function (response) {
      return response.json().catch(function () {
        return {};
      }).then(function (data) {
        if (!response.ok) {
          var error = new Error((data && data.detail && data.detail.message) || "请求失败");
          error.status = response.status;
          throw error;
        }
        return data;
      });
    });
  }

  function pct(value) {
    return Math.round((Number(value) || 0) * 100) + "%";
  }

  function toast(message, kind) {
    view.notice = message || "";
    view.error = kind === "error" ? message || "" : "";
    render();
  }

  /* ---------------------------------------------------------------- 样式 */

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      /* 视图靠绝对定位覆盖在产出区上，所以父容器需要成为定位参照。
         position: relative 不改变 grid 布局流，安全。 */
      ".studio-panel { position: relative; }",

      "#" + VIEW_ID + " {",
      "  position: absolute;",
      "  left: 0; right: 0;",
      "  top: 0; bottom: 0;",
      "  z-index: 6;",
      "  display: flex;",
      "  flex-direction: column;",
      "  background: var(--panel);",
      "  color: var(--ink);",
      "  border-radius: inherit;",
      "  overflow: hidden;",
      "}",
      "#" + VIEW_ID + ".hidden { display: none; }",

      ".feature-button.en-entry .feature-icon { color: var(--green); }",

      ".en-head {",
      "  display: flex; align-items: center; justify-content: space-between;",
      "  gap: 8px; padding: 10px 12px 8px;",
      "  border-bottom: 1px solid var(--line);",
      "  flex: 0 0 auto; flex-wrap: wrap;",
      "}",
      ".en-tabs { display: flex; gap: 4px; flex-wrap: wrap; min-width: 0; }",
      ".en-back { flex: 0 0 auto; padding: 5px 10px; font-size: calc(12px * var(--font-scale, 1)); }",
      ".en-collapse-btn { flex: 0 0 auto; padding: 5px 10px; font-size: calc(12px * var(--font-scale, 1)); margin-left: 6px; }",
      ".en-tab {",
      "  border: 1px solid var(--line); background: transparent; color: var(--muted);",
      "  border-radius: 999px; padding: 5px 12px; font-size: calc(12px * var(--font-scale, 1)); font-weight: 500;",
      "  cursor: pointer; white-space: nowrap;",
      "}",
      ".en-tab:hover { color: var(--ink); }",
      ".en-tab.active { background: var(--green); border-color: var(--green); color: #fff; }",
      "html[data-theme='dark'] .en-tab.active { color: #0e1410; }",
      ".en-count {",
      "  display: inline-block; min-width: 16px; padding: 0 4px; margin-left: 4px;",
      "  border-radius: 999px; background: var(--gold); color: #2a2410;",
      "  font-size: calc(11px * var(--font-scale, 1)); line-height: 16px; text-align: center;",
      "}",
      ".en-head-meta { font-size: calc(11px * var(--font-scale, 1)); color: var(--muted); white-space: nowrap; }",

      ".en-body { flex: 1 1 auto; overflow-y: auto; padding: 12px; min-height: 0; }",
      ".en-card {",
      "  border: 1px solid var(--line); border-radius: 12px;",
      "  background: var(--panel); padding: 12px; margin-bottom: 10px;",
      "}",
      ".en-title { font-size: calc(13px * var(--font-scale, 1)); font-weight: 500; margin: 0 0 8px; }",
      ".en-muted { color: var(--muted); font-size: calc(12px * var(--font-scale, 1)); }",
      ".en-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }",
      ".en-row + .en-row { margin-top: 8px; }",
      ".en-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }",
      ".en-stat { border: 1px solid var(--line); border-radius: 10px; padding: 8px; text-align: center; }",
      ".en-stat b { display: block; font-size: calc(17px * var(--font-scale, 1)); font-weight: 500; }",
      ".en-stat span { font-size: calc(11px * var(--font-scale, 1)); color: var(--muted); }",

      ".en-btn {",
      "  border: 1px solid var(--line); background: transparent; color: var(--ink);",
      "  border-radius: 10px; padding: 7px 12px; font-size: calc(12px * var(--font-scale, 1)); font-weight: 500;",
      "  cursor: pointer; white-space: nowrap;",
      "}",
      ".en-btn:hover { border-color: var(--muted); }",
      ".en-btn:disabled { opacity: .5; cursor: not-allowed; }",
      /* 主按钮必须自带配色：.mini-button.primary 只在特定容器里生效 */
      ".en-btn.primary { background: var(--green); border-color: var(--green); color: #fff; }",
      ".en-btn.primary:hover { border-color: var(--green); filter: brightness(1.06); }",
      "html[data-theme='dark'] .en-btn.primary { color: #0e1410; }",
      ".en-btn.ghost { border-style: dashed; color: var(--muted); }",
      ".en-btn.wide { width: 100%; justify-content: center; padding: 11px; font-size: calc(13px * var(--font-scale, 1)); }",
      ".en-btn.danger { color: var(--red); border-color: var(--red-soft, var(--line)); }",

      ".en-deck {",
      "  display: flex; align-items: center; justify-content: space-between; gap: 10px;",
      "  border: 1px solid var(--line); border-radius: 10px; padding: 9px 10px; margin-bottom: 8px;",
      "}",
      ".en-deck-name { font-size: calc(12.5px * var(--font-scale, 1)); font-weight: 500; }",
      ".en-bar { height: 4px; border-radius: 3px; background: var(--line); overflow: hidden; margin-top: 6px; }",
      ".en-bar > i { display: block; height: 100%; background: var(--green); }",
      ".en-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }",

      ".en-word { font-size: calc(25px * var(--font-scale, 1)); font-weight: 500; letter-spacing: .4px; word-break: break-word; }",
      /* 单词与发音按钮同排；发音按钮是次要操作，不做成实心按钮抢占视线 */
      ".en-word-row { display: flex; align-items: center; gap: 8px; }",
      ".en-say {",
      "  flex: 0 0 auto; border: 1px solid var(--line); background: transparent;",
      "  color: var(--muted); border-radius: 8px; padding: 2px 7px;",
      "  font-size: calc(13px * var(--font-scale, 1)); line-height: 1.5; cursor: pointer;",
      "}",
      ".en-say:hover { border-color: var(--green); color: var(--ink); }",
      ".en-toolbar {",
      "  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;",
      "  margin-bottom: 10px;",
      "}",
      ".en-toolbar .en-muted { margin-right: auto; font-size: calc(11.5px * var(--font-scale, 1)); }",
      ".en-new-tag {",
      "  display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 999px;",
      "  background: var(--gold); color: #2a2410; font-size: calc(10px * var(--font-scale, 1));",
      "}",
      /* 释义按词性分行，比一大段逗号串好读 */
      /* 生词本：加词表单与词条列表 */
      ".en-add-row { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; }",
      ".en-add-row .en-input { flex: 1 1 auto; }",
      ".en-nb-row { padding: 9px 0; border-top: 1px solid var(--line); }",
      ".en-nb-row:first-of-type { border-top: 0; }",
      ".en-nb-head { display: flex; align-items: center; gap: 8px; }",
      ".en-nb-word {",
      "  display: flex; align-items: baseline; gap: 6px;",
      "  flex: 1 1 auto; min-width: 0; flex-wrap: wrap;",
      "}",
      ".en-nb-word b { font-size: calc(14px * var(--font-scale, 1)); font-weight: 500; }",
      ".en-mean-line { font-size: calc(13px * var(--font-scale, 1)); line-height: 1.75; }",
      ".en-mean-line + .en-mean-line { margin-top: 3px; }",
      ".en-mean-note { margin-top: 4px; font-size: calc(11.5px * var(--font-scale, 1)); color: var(--muted); }",
      ".en-mean-line b { font-weight: 600; color: var(--muted); margin-right: 2px; }",
      ".en-mean-raw {",
      "  margin-top: 6px; padding: 7px 9px; border-radius: 8px;",
      "  background: var(--background); color: var(--muted);",
      "  font-size: calc(11.5px * var(--font-scale, 1)); line-height: 1.6; word-break: break-word;",
      "}",
      ".en-link {",
      "  display: inline-block; margin-top: 6px; border: 0; background: transparent;",
      "  color: var(--green); font-size: calc(11.5px * var(--font-scale, 1)); cursor: pointer; padding: 0;",
      "  text-decoration: underline;",
      "}",
      ".en-phon { color: var(--muted); font-size: calc(12.5px * var(--font-scale, 1)); margin-top: 3px; }",
      ".en-tag {",
      "  display: inline-block; border: 1px solid var(--line); border-radius: 999px;",
      "  padding: 1px 7px; font-size: calc(10.5px * var(--font-scale, 1)); color: var(--muted); margin: 2px 4px 0 0;",
      "}",
      ".en-ctx {",
      "  border-left: 2px solid var(--gold); padding: 6px 0 6px 9px; margin: 10px 0;",
      "  font-size: calc(13px * var(--font-scale, 1)); line-height: 1.65; color: var(--ink);",
      "}",
      ".en-ctx-src { display: block; font-size: calc(11px * var(--font-scale, 1)); color: var(--muted); margin-top: 3px; }",
      ".en-blank { color: var(--gold); font-weight: 500; }",
      ".en-ratings { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-top: 12px; }",
      ".en-rate {",
      "  border: 1px solid var(--line); background: transparent; border-radius: 10px;",
      "  padding: 9px 4px; cursor: pointer; color: var(--ink); text-align: center;",
      "  transition: all .12s cubic-bezier(0.4, 0, 0.2, 1);",
      "}",
      ".en-rate:hover { border-color: var(--green); }",
      ".en-rate:active, .en-rate.is-pressed {",
      "  transform: scale(0.93); border-color: var(--green);",
      "  background: rgba(34,197,94,.12); box-shadow: 0 0 10px rgba(34,197,94,.25);",
      "}",
      ".en-rate b { display: block; font-size: calc(12.5px * var(--font-scale, 1)); font-weight: 500; }",
      ".en-rate span { font-size: calc(10.5px * var(--font-scale, 1)); color: var(--muted); }",
      ".en-rate[data-rating='1']:hover { border-color: var(--red); }",
      ".en-progress { height: 4px; border-radius: 3px; background: var(--line); overflow: hidden; margin-bottom: 12px; }",
      ".en-progress > i { display: block; height: 100%; background: var(--gold); transition: width .2s ease; }",

      ".en-cand {",
      "  display: flex; gap: 9px; align-items: flex-start;",
      "  border: 1px solid var(--line); border-radius: 10px; padding: 9px; margin-bottom: 7px;",
      "}",
      ".en-cand input { margin-top: 4px; accent-color: var(--green); }",
      ".en-cand-main { flex: 1 1 auto; min-width: 0; }",
      ".en-cand-word { font-size: calc(14px * var(--font-scale, 1)); font-weight: 500; }",
      ".en-cand-say { font-size: calc(12px * var(--font-scale, 1)); color: var(--muted); margin-top: 2px; }",
      ".en-cand-sample { font-size: calc(11.5px * var(--font-scale, 1)); color: var(--muted); margin-top: 4px; line-height: 1.5; }",
      ".en-gain { color: var(--green); font-size: calc(11px * var(--font-scale, 1)); white-space: nowrap; }",
      ".en-actions { display: flex; gap: 6px; flex-wrap: wrap; margin: 10px 0; }",
      ".en-note {",
      "  border-radius: 10px; padding: 8px 10px; font-size: calc(12px * var(--font-scale, 1)); margin-bottom: 10px;",
      "  background: var(--green-soft, rgba(127,127,127,.12)); color: var(--ink);",
      "}",
      ".en-note.error { background: var(--red-soft, rgba(200,60,60,.14)); }",
      ".en-textarea {",
      "  width: 100%; min-height: 96px; box-sizing: border-box; resize: vertical;",
      "  border: 1px solid var(--line); border-radius: 10px; background: transparent;",
      "  color: var(--ink); padding: 9px; font-size: calc(12.5px * var(--font-scale, 1)); line-height: 1.6;",
      "  font-family: var(--font-mono, monospace);",
      "}",
      ".en-input {",
      "  border: 1px solid var(--line); border-radius: 10px; background: transparent;",
      "  color: var(--ink); padding: 7px 9px; font-size: calc(12.5px * var(--font-scale, 1)); width: 100%; box-sizing: border-box;",
      "}",
      ".en-empty { text-align: center; color: var(--muted); font-size: calc(12.5px * var(--font-scale, 1)); padding: 28px 12px; line-height: 1.7; }",
      ".en-kbd { font-size: calc(11px * var(--font-scale, 1)); color: var(--muted); text-align: center; margin-top: 10px; }",
      ".en-roots { margin-top: 8px; font-size: calc(11.5px * var(--font-scale, 1)); color: var(--muted); line-height: 1.7; }",
      ".en-roots code { color: var(--ink); font-size: calc(11.5px * var(--font-scale, 1)); }",

      /* 词义拓展：例句 / 近反义 / 搭配 / 形近 */
      ".en-extra-sec { margin-top: 12px; }",
      ".en-extra-sec:first-of-type { margin-top: 4px; }",
      ".en-extra-label {",
      "  display: flex; align-items: center; gap: 8px;",
      "  font-size: calc(12px * var(--font-scale, 1)); font-weight: 600; color: var(--ink); margin-bottom: 7px;",
      "}",
      /* 标题右侧补一条细线，分组一眼分明 */
      ".en-extra-label::after { content: ''; flex: 1; height: 1px; background: var(--line); }",
      ".en-extra-item {",
      "  padding: 1px 0 1px 10px; margin-bottom: 8px;",
      "  font-size: calc(12.5px * var(--font-scale, 1)); line-height: 1.65; color: var(--ink);",
      "  border-left: 2px solid var(--gold);",
      "}",
      ".en-extra-item .en-muted { margin-top: 1px; }",
      ".en-extra-say { display: flex; align-items: flex-start; gap: 6px; }",
      ".en-extra-en { flex: 1 1 auto; }",
      ".en-extra-tag {",
      "  display: inline-block; border: 1px solid var(--line); border-radius: 999px;",
      "  padding: 3px 9px; font-size: calc(11.5px * var(--font-scale, 1)); color: var(--ink); margin: 0 5px 5px 0;",
      "  max-width: 100%; box-sizing: border-box;",
      "}",
      ".en-extra-tag b { font-weight: 500; }",
      /* 形近词一行一条：词在前、释义在后，不用胶囊以免长释义撑成三行 */
      ".en-extra-row {",
      "  padding: 5px 0; font-size: calc(12.5px * var(--font-scale, 1)); line-height: 1.55;",
      "  border-bottom: 1px dashed var(--line);",
      "}",
      ".en-extra-row:last-child { border-bottom: 0; padding-bottom: 0; }",
      ".en-extra-row b { font-weight: 500; margin-right: 6px; }",
      ".en-extra-row .en-muted { font-size: calc(11.5px * var(--font-scale, 1)); }",
      /* 连击 Combo 徽章与里程碑特效 */
      ".en-combo-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 9px; border-radius: 999px; background: rgba(234,179,8,.15); border: 1px solid var(--gold); color: var(--gold); font-size: calc(11px * var(--font-scale, 1)); font-weight: 600; margin-left: 6px; transition: all .2s ease; }",
      ".en-combo-badge.fire { background: rgba(249,115,22,.15); border-color: #f97316; color: #f97316; animation: enPulse 1.2s infinite ease-in-out; }",
      ".en-combo-badge.electric { background: rgba(59,130,246,.15); border-color: #3b82f6; color: #60a5fa; animation: enPulse 0.9s infinite ease-in-out; }",
      ".en-combo-badge.star { background: rgba(234,179,8,.22); border-color: var(--gold); color: var(--gold); box-shadow: 0 0 10px rgba(234,179,8,.4); font-weight: 700; }",
      "@keyframes enPulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }",
      /* 精致音标行 */
      ".en-phon-row { display: flex; align-items: center; gap: 8px; margin: 4px 0 8px; flex-wrap: wrap; }",
      ".en-phon-pill { font-family: var(--font-mono, monospace); font-size: calc(12.5px * var(--font-scale, 1)); color: var(--muted); background: rgba(127,127,127,.08); padding: 2px 8px; border-radius: 6px; border: 1px solid var(--line); }",
      ".en-phon-say { border: 0; background: transparent; color: var(--muted); cursor: pointer; font-size: calc(11.5px * var(--font-scale, 1)); padding: 2px 6px; border-radius: 4px; }",
      ".en-phon-say:hover { color: var(--green); background: rgba(34,197,94,.08); }",
      /* 快捷键提示 */
      ".en-rate-top { display: flex; align-items: center; justify-content: center; gap: 4px; }",
      ".en-rate-kbd { font-size: calc(9.5px * var(--font-scale, 1)); border-radius: 4px; padding: 0 4px; background: var(--line); color: var(--muted); font-family: monospace; font-weight: 400; line-height: 14px; }",
      /* 主卡联想记忆锚点 */
      ".en-assoc-clue { margin-top: 8px; padding: 6px 9px; border-radius: 8px; background: rgba(127,127,127,.08); border-left: 2px solid var(--green); font-size: calc(12px * var(--font-scale, 1)); line-height: 1.5; color: var(--ink); }",
      ".en-assoc-label { font-weight: 600; color: var(--green); margin-right: 4px; }",
      ".en-assoc-clue code { font-weight: 600; color: var(--ink); background: var(--line); padding: 1px 4px; border-radius: 4px; }",
      /* 例句重点词高亮 */
      ".en-ex-hl { background: rgba(34,197,94,.16); color: var(--green); font-weight: 600; padding: 0 3px; border-radius: 3px; }",
      "html[data-theme='dark'] .en-ex-hl { color: #4ade80; }",
      /* 通关战报卡片 */
      ".en-summary-hero { border: 1px solid var(--line); border-radius: 12px; background: var(--panel); padding: 14px; margin-bottom: 10px; }",
      ".en-summary-title { font-size: calc(16px * var(--font-scale, 1)); font-weight: 600; color: var(--ink); }",
      ".en-summary-rate-pill { flex: 0 0 auto; width: 44px; height: 44px; border-radius: 50%; border: 2px solid var(--green); display: flex; align-items: center; justify-content: center; font-size: calc(13px * var(--font-scale, 1)); font-weight: 600; color: var(--green); }",
      ".en-word-chips { display: flex; flex-wrap: wrap; gap: 6px; }",
      ".en-chip { display: inline-flex; align-items: center; padding: 3px 8px; border-radius: 6px; border: 1px solid var(--line); font-size: calc(12px * var(--font-scale, 1)); cursor: pointer; transition: all .15s ease; color: var(--ink); }",
      ".en-chip:hover { border-color: var(--green); transform: translateY(-1px); }",
      ".en-chip.master { border-color: var(--green); color: var(--green); background: rgba(34,197,94,.08); }",
      ".en-chip.good { border-color: var(--ink); }",
      ".en-chip.hard { border-color: var(--gold); color: var(--gold); background: rgba(234,179,8,.08); }",
      ".en-chip.again { border-color: var(--red); color: var(--red); background: rgba(239,68,68,.08); }",
      /* 故事与挖词挑战卡片 */
      ".en-story-card { border: 1px solid var(--line); border-radius: 12px; padding: 14px; background: var(--panel); margin-bottom: 10px; }",
      ".en-story-card.en-cloze-card { border-color: var(--green); box-shadow: 0 0 14px rgba(34,197,94,.08); }",
      ".en-story-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }",
      ".en-story-theme-badge { font-size: calc(14px * var(--font-scale, 1)); font-weight: 600; color: var(--ink); display: flex; align-items: center; gap: 6px; }",
      ".en-story-ctrls { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }",
      ".en-story-explain { padding: 8px 10px; border-radius: 8px; background: rgba(234,179,8,.08); border-left: 3px solid var(--gold); font-size: calc(12px * var(--font-scale, 1)); line-height: 1.6; color: var(--ink); margin-bottom: 12px; }",
      ".en-story-body { font-size: calc(13.5px * var(--font-scale, 1)); line-height: 1.85; color: var(--ink); margin-bottom: 12px; letter-spacing: .2px; }",
      ".en-story-word { display: inline-block; font-weight: 600; color: var(--green); background: rgba(34,197,94,.12); padding: 0 4px; border-radius: 4px; cursor: pointer; border-bottom: 1.5px solid var(--green); }",
      ".en-story-word:hover { filter: brightness(1.15); transform: scale(1.04); }",
      ".en-story-zh { font-size: calc(12.5px * var(--font-scale, 1)); line-height: 1.75; color: var(--muted); padding: 9px 12px; border-radius: 8px; background: rgba(127,127,127,.06); border-left: 2px solid var(--line); margin-bottom: 12px; }",
      /* 挖词挑战元素 */
      ".en-cloze-wrap { display: inline-flex; align-items: baseline; vertical-align: baseline; margin: 0 3px; position: relative; }",
      ".en-cloze-input { border: 0; border-bottom: 2px solid var(--gold); background: rgba(127,127,127,.09); color: var(--ink); font-family: inherit; font-size: calc(13px * var(--font-scale, 1)); font-weight: 600; text-align: center; padding: 0 4px; border-radius: 4px 4px 0 0; outline: none; transition: all .15s ease; box-sizing: border-box; }",
      ".en-cloze-input:focus { border-bottom-color: var(--green); background: rgba(34,197,94,.12); }",
      ".en-cloze-input.is-correct { border-bottom-color: var(--green); background: rgba(34,197,94,.18); color: var(--green); }",
      ".en-cloze-blank { display: inline-flex; align-items: center; gap: 3px; font-weight: 600; border-radius: 4px; padding: 0 5px; cursor: pointer; }",
      ".en-cloze-blank.correct { color: var(--green); background: rgba(34,197,94,.14); border-bottom: 2px solid var(--green); }",
      ".en-cloze-blank.revealed { color: var(--gold); background: rgba(234,179,8,.14); border-bottom: 2px solid var(--gold); }",
      ".en-cloze-hint-btn { border: 0; background: transparent; color: var(--muted); cursor: pointer; padding: 0 2px; font-size: calc(11px * var(--font-scale, 1)); }",
      ".en-cloze-hint-btn:hover { color: var(--gold); }",
      ".en-cloze-banner { margin-bottom: 12px; padding: 10px 14px; border-radius: 8px; background: rgba(34,197,94,.15); border: 1px solid var(--green); color: var(--ink); display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }",
      ".en-cloze-stats { font-size: calc(12px * var(--font-scale, 1)); color: var(--muted); margin-bottom: 10px; padding: 6px 10px; border-radius: 6px; background: rgba(127,127,127,.06); }",
      /* 历史故事集 */
      ".en-history-sec { margin-top: 14px; padding-top: 12px; border-top: 1px dashed var(--line); }",
      ".en-history-item { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; margin-bottom: 6px; cursor: pointer; transition: all .15s ease; background: rgba(127,127,127,.03); }",
      ".en-history-item:hover { border-color: var(--green); background: rgba(34,197,94,.04); }",
      ".en-history-item-head { display: flex; align-items: center; justify-content: space-between; font-size: calc(12px * var(--font-scale, 1)); font-weight: 500; }",
      ".en-history-item-words { font-size: calc(11px * var(--font-scale, 1)); color: var(--muted); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
      ".en-links-grid { display: grid; grid-template-columns: 1fr; gap: 8px; }",
      ".en-link-item { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font-size: calc(12px * var(--font-scale, 1)); background: rgba(127,127,127,.03); }",
      ".en-link-head { display: flex; align-items: center; gap: 6px; font-size: calc(13px * var(--font-scale, 1)); }",
      ".en-link-mne { color: var(--gold); font-size: calc(11.5px * var(--font-scale, 1)); margin-top: 3px; font-weight: 500; }",
      ".en-link-sent { color: var(--muted); font-size: calc(11.5px * var(--font-scale, 1)); margin-top: 2px; font-style: italic; line-height: 1.5; }",
      ".en-story-loading { text-align: center; padding: 28px 12px; color: var(--ink); }",
      ".en-spinner { width: 24px; height: 24px; margin: 0 auto 8px; border: 2.5px solid var(--line); border-top-color: var(--green); border-radius: 50%; animation: enSpin .8s linear infinite; }",
      "@keyframes enSpin { to { transform: rotate(360deg); } }",
      /* 记忆曲线柱状图 */
      ".en-hist { display: flex; align-items: flex-end; gap: 2px; height: 72px; padding-top: 4px; }",
      ".en-hist-bar { flex: 1 1 auto; min-width: 2px; background: var(--green); border-radius: 2px 2px 0 0; opacity: .8; transition: opacity .15s ease; }",
      ".en-hist-bar:hover { opacity: 1; }",
      ".en-hist-bar.zero { opacity: .16; }",
      ".en-hist-axis { display: flex; justify-content: space-between; font-size: calc(10px * var(--font-scale, 1)); color: var(--muted); margin-top: 4px; }",
      /* 词库卡片操作按钮组 */
      ".en-deck-actions { display: flex; gap: 6px; flex: 0 0 auto; }",
      /* 拼写模式 */
      ".en-spell-hint { font-size: calc(12.5px * var(--font-scale, 1)); color: var(--muted); line-height: 1.6; }",
      ".en-spell-row { display: flex; gap: 6px; align-items: center; margin: 10px 0 4px; }",
      ".en-spell-row .en-input { flex: 1 1 auto; font-size: calc(15px * var(--font-scale, 1)); letter-spacing: 1px; }",
      ".en-spell-result { margin-top: 8px; font-size: calc(13px * var(--font-scale, 1)); padding: 8px 10px; border-radius: 8px; line-height: 1.6; }",
      ".en-spell-result.correct { background: rgba(34,197,94,.14); border: 1px solid var(--green); color: var(--green); }",
      ".en-spell-result.wrong { background: rgba(239,68,68,.12); border: 1px solid var(--red); color: var(--red); }",
      ".en-spell-answer { font-weight: 600; letter-spacing: .5px; }",
      ".en-rate.suggest { border-color: var(--green); box-shadow: inset 0 0 0 1px var(--green); }",
      /* 筛熟词面板 */
      ".en-filter-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }",
      ".en-filter-preview { font-size: calc(12px * var(--font-scale, 1)); color: var(--muted); line-height: 1.7; margin-bottom: 10px; }",
      ".en-filter-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 12px; }",
      ".en-filter-chip { border: 1px solid var(--line); border-radius: 999px; padding: 2px 9px; font-size: calc(11.5px * var(--font-scale, 1)); color: var(--ink); }",
    ].join("\n");
    var node = document.createElement("style");
    node.id = STYLE_ID;
    node.textContent = css;
    document.head.appendChild(node);
  }

  /* ------------------------------------------------------------ 页签注入 */

  function ensureButton() {
    var grid = document.querySelector(".feature-grid");
    if (!grid || grid.querySelector("[data-en-entry]")) return;
    var button = document.createElement("button");
    button.type = "button";
    button.className = "feature-button en-entry";
    button.setAttribute("data-en-entry", "vocab");
    button.innerHTML =
      '<span class="feature-icon">EN</span><span>英语词汇</span>' +
      '<span class="en-count hidden" data-en-badge></span>';
    grid.appendChild(button);
  }

  function setBadge(count) {
    var badge = document.querySelector("[data-en-badge]");
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count > 99 ? "99+" : String(count);
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }

  /* ---------------------------------------------------------- 视图容器 */

  function isStudioExpanded() {
    try {
      if (typeof state !== "undefined" && state && typeof state.studioFocus !== "undefined") {
        return !!state.studioFocus;
      }
    } catch (e) {}
    var btn = document.getElementById("studio-expand-button");
    if (btn && btn.getAttribute("aria-expanded") === "true") return true;
    var panel = document.querySelector(".studio-panel");
    return !!(panel && panel.classList.contains("studio-focus")) || document.body.classList.contains("studio-focus-open");
  }

  function ensureStudioExpanded(trigger) {
    if (isStudioExpanded()) return;
    function doExpand() {
      try {
        if (typeof state !== "undefined" && state && state.studioFocusClosing) {
          setTimeout(doExpand, 100);
          return;
        }
      } catch (e) {}
      try {
        if (typeof expandStudio === "function") {
          expandStudio(trigger || document.querySelector("[data-en-entry]") || document.getElementById("studio-expand-button"));
          return;
        }
      } catch (e) {}
      try {
        var btn = document.getElementById("studio-expand-button");
        if (btn && btn.getAttribute("aria-expanded") !== "true") {
          btn.click();
        }
      } catch (e) {}
    }
    doExpand();
  }

  function ensureView() {
    var existing = document.getElementById(VIEW_ID);
    if (existing) return existing;
    var panel = document.querySelector(".studio-panel");
    if (!panel) return null;
    var node = document.createElement("div");
    node.id = VIEW_ID;
    node.className = "hidden";
    panel.appendChild(node);
    return node;
  }

  function openView() {
    var node = ensureView();
    if (!node) return;
    node.classList.remove("hidden");
    // 摘掉其它页签的高亮（app.js 只在它自己切换时清理，我们进来得自己清）
    Array.prototype.forEach.call(
      document.querySelectorAll(".feature-button"),
      function (button) {
        if (!button.hasAttribute("data-en-entry")) button.classList.remove("active");
      }
    );
    var mine = document.querySelector("[data-en-entry]");
    if (mine) mine.classList.add("active");
    // 先画一次骨架：/api/en/overview 还没回来之前不能白屏（后端慢时这段空窗会被拉得很长）。
    // 语料视图自带「正在读取语料…」的加载态，这里 render() 一把就会立刻有东西可看。
    if (!view.overview) render();
    loadOverview();
    // 主界面点击或打开英语词汇时自动展开工作室面板
    ensureStudioExpanded(mine);
  }

  // 模块对外入口。
  // ⚠️ 必须在这里（openView 定义之后、模块作用域顶层）赋值一次：
  // 原先只在 render() 内部赋值，而 render() 又要先 openView() 才跑到 ——
  // 于是模块外（Agent 工作台的图标栏）首次点击拿到 undefined，点了没反应。
  window.enVocabOpenView = openView;

  function closeView() {
    var node = document.getElementById(VIEW_ID);
    if (node) node.classList.add("hidden");
    var mine = document.querySelector("[data-en-entry]");
    if (mine) mine.classList.remove("active");
    try {
      if (typeof state !== "undefined" && state && state.feature) {
        var activeBtn = document.querySelector('.feature-button[data-feature="' + state.feature + '"]');
        if (activeBtn) activeBtn.classList.add("active");
      }
    } catch (e) {}
  }

  /* ------------------------------------------------------------ 数据 */

  function loadOverview() {
    call(API + "/overview")
      .then(function (data) {
        view.overview = data;
        view.error = "";
        setBadge(data.candidate_count || 0);
        if (view.tab === "candidates" && !view.candidates.length) return loadCandidates();
        if (view.tab === "review" && !view.queue.length) return loadQueue();
        render();
        if (view.tab === "decks" && !view.history) loadHistory();
        return null;
      })
      .catch(function (error) {
        view.error = (error && error.message) || "加载失败";
        render();
      });
  }

  /* extraNew = 一次性多放行几个新词（「今天再学 N 个」）。不传 = 严格按今日配额。 */
  function loadQueue(extraNew) {
    view.queueLoading = true;
    render(); // 先把「正在拉取…」画出来：否则队列为空时点按钮，屏幕纹丝不动像坏了
    var url = API + "/review" + (extraNew ? "?extra_new=" + encodeURIComponent(extraNew) : "");
    return call(url)
      .then(function (data) {
        view.queueLoading = false;
        view.queue = data.items || [];
        view.index = 0;
        view.preview = {};
        view.answerShown = false;
        view.extrasOpen = false;
        view.showFullMeaning = false;
        view.spokenFor = "";
        view.prefill = "";
        view.queueMeta = {
          review_count: data.review_count || 0,
          new_count: data.new_count || 0,
          new_today: data.new_today || 0,
          new_per_day: data.new_per_day || 0,
        };
        // 队列接口本身回了一份最新 stats，顺手同步给概览——
        // 否则结算页判断「还剩几个到期词」时读到的是旧数字。
        if (view.overview && data.stats) view.overview.stats = data.stats;
        view.error = "";
        render();
        if (view.queue.length) {
          requestPreview();
        } else if (extraNew) {
          // 点了「今天再学 N 个」却一个都没回来：说明词库里真没新词了，
          // 必须说出来 —— 屏幕纹丝不动会被当成按钮坏了。
          toast("词库里没有还没学的新词了。去「📄 语料」扫一份资料就能攒出新词。");
        }
        return null;
      })
      .catch(function (error) {
        view.queueLoading = false;
        view.error = (error && error.message) || "取复习队列失败";
        render();
      });
  }

  function requestPreview() {
    var word = view.queue[view.index];
    if (!word) return;
    call(API + "/review", { method: "POST", body: { word_id: word.word_id, preview: true } })
      .then(function (data) {
        view.preview = data.preview || {};
        render();
        return null;
      })
      .catch(function () {
        /* 预览拿不到不影响评分，静默即可 */
      });
  }

  function loadCandidates() {
    return call(API + "/candidates")
      .then(function (data) {
        view.candidates = data.items || [];
        view.picked = {};
        view.error = "";
        render();
        return null;
      })
      .catch(function (error) {
        view.error = (error && error.message) || "取候选词失败";
        render();
      });
  }

  function submitRating(rating) {
    var word = view.queue[view.index];
    if (!word || view.busy) return;
    view.busy = true;

    // 记录本轮复习轨迹（用于结算战报与 AI 联结故事创作）
    if (!view.roundWords) view.roundWords = [];
    view.roundWords.push({
      word: word.word || word.lemma,
      lemma: word.lemma || word.word,
      meaning: word.meaning || "",
      rating: rating,
      phonetic: word.phonetic || "",
      tags: word.tags || "",
      root_explain: word.root_explain || []
    });

    // 连击 Combo（认识 3 分或秒懂 4 分增加连击，遗忘或模糊重置）
    if (rating >= 3) {
      view.combo = (view.combo || 0) + 1;
      if (view.combo > (view.maxCombo || 0)) view.maxCombo = view.combo;
    } else {
      view.combo = 0;
    }

    call(API + "/review", {
      method: "POST",
      body: { word_id: word.word_id, rating: rating, elapsed_ms: Date.now() - (view.shownAt || Date.now()) },
    })
      .then(function (data) {
        view.busy = false;
        // 后端在响应里回了最新统计，直接用上 —— 否则用户连背十个词，
        // 顶栏还写着"今日 4 词"，看起来像没生效。
        if (data && data.stats && view.overview) view.overview.stats = data.stats;
        view.queue.splice(view.index, 1);        // 评分后立刻出下一张，不等重新拉队列
        if (view.index >= view.queue.length) view.index = Math.max(0, view.queue.length - 1);
        view.preview = {};
        view.extrasOpen = false;                 // 新一张卡从干净状态开始
        view.answerShown = false;
        view.showFullMeaning = false;
        view.spokenFor = "";
        view.spellInput = "";
        view.spellResult = "";
        if (view.queue.length) {
          render();
          requestPreview();
        } else {
          // 队列全部刷完，进入本轮通关结算并触发故事生成
          view.roundFinished = true;
          render();
          if (!view.story && !view.storyLoading) {
            generateRoundStory();
          }
        }
        return null;
      })
      .catch(function (error) {
        view.busy = false;
        view.error = (error && error.message) || "提交失败";
        render();
      });
  }

  function finishRound() {
    if (!view.roundWords || !view.roundWords.length) {
      toast("本轮还没有刷过词，先背几个词吧！");
      return;
    }
    view.roundFinished = true;
    render();
    if (!view.story && !view.storyLoading) {
      generateRoundStory();
    }
  }

  function startNewRound(extraNew) {
    view.roundWords = [];
    view.roundFinished = false;
    view.story = null;
    view.storyLoading = false;
    view.storySpeaking = false;
    view.combo = 0;
    if (window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
    loadQueue(extraNew);
  }

  function generateRoundStory() {
    if (!view.roundWords || !view.roundWords.length) return;
    view.storyLoading = true;
    render();

    var wordsPayload = view.roundWords.map(function (item) {
      return {
        word: item.word || item.lemma,
        meaning: item.meaning || "",
      };
    });

    var deckName = (view.overview && view.overview.decks && view.overview.decks[0] && view.overview.decks[0].name) || "知源词库";

    call(API + "/round-story", {
      method: "POST",
      body: {
        words: wordsPayload,
        deck_name: deckName,
      },
    })
      .then(function (data) {
        view.storyLoading = false;
        view.story = data || null;
        view.clozeAnswers = {};
        view.clozeRevealed = {};
        view.storyMode = "read";
        saveStoryToArchive(view.story, view.roundWords);
        render();
        return null;
      })
      .catch(function (error) {
        view.storyLoading = false;
        view.error = (error && error.message) || "生成联结短文失败";
        render();
      });
  }

  function toggleSpeakStory() {
    if (!view.story || !view.story.story_en) return;
    if (view.storySpeaking) {
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      view.storySpeaking = false;
      render();
      return;
    }
    var cleanEn = view.story.story_en.replace(/\*\*/g, "");
    speak(cleanEn);
    view.storySpeaking = true;
    render();
    try {
      if (window.speechSynthesis) {
        var checkTimer = setInterval(function () {
          if (!window.speechSynthesis.speaking) {
            clearInterval(checkTimer);
            view.storySpeaking = false;
            render();
          }
        }, 500);
      }
    } catch (e) {}
  }

  function copyStory() {
    if (!view.story) return;
    var text = "【" + (view.story.theme || "知源词汇联结短文") + "】\n" +
      (view.story.theme_explanation ? view.story.theme_explanation + "\n\n" : "\n") +
      view.story.story_en.replace(/\*\*/g, "") + "\n\n" +
      (view.story.story_zh || "");
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          toast("短文已复制到剪贴板！");
        }).catch(function () {
          toast("已复制");
        });
      } else {
        toast("短文已就绪，请手动复制");
      }
    } catch (e) {
      toast("已复制");
    }
  }

  var STORY_ARCHIVE_KEY = "knoworigin_en_story_archive";

  function loadStoryArchive() {
    try {
      var raw = localStorage.getItem(STORY_ARCHIVE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveStoryToArchive(story, roundWords) {
    if (!story || !story.story_en) return;
    try {
      var list = loadStoryArchive();
      var exists = list.some(function (item) {
        return item.story_en === story.story_en;
      });
      if (exists) return;
      var now = new Date();
      var timeStr = (now.getMonth() + 1) + "月" + now.getDate() + "日 " +
        (now.getHours() < 10 ? "0" : "") + now.getHours() + ":" +
        (now.getMinutes() < 10 ? "0" : "") + now.getMinutes();
      var entry = {
        id: "story_" + Date.now(),
        created_at: timeStr,
        theme: story.theme || "联结短文",
        theme_explanation: story.theme_explanation || "",
        story_en: story.story_en,
        story_zh: story.story_zh || "",
        word_links: story.word_links || [],
        words: (roundWords || []).map(function (w) { return w.word || w.lemma; })
      };
      list.unshift(entry);
      if (list.length > 15) list = list.slice(0, 15);
      localStorage.setItem(STORY_ARCHIVE_KEY, JSON.stringify(list));
    } catch (e) {}
  }

  /* 联结短文里 **加粗** 块的统一匹配正则。
     为什么不能只认「单个英文词」：模型有时会把词组整块加粗
     （如 **diffuse reflectance spectroscopy**），甚至带括号缩写
     （如 **optical coherence tomography (oct)**）。
     旧正则 \*\*([a-zA-Z0-9'\-]+)\*\* 一遇到空格/括号就整段失配，
     后果是：挖词进度恒为 0/0、星号原样露在正文里 —— 2026-09-28 修。
     改成「双星号内允许任意非星号非换行内容」，词组也能出挑战。 */
  var STORY_BOLD_RE = /\*\*([^*\n]+?)\*\*/g;

  /* 挖词答案归一化：trim + 小写 + 折叠连续空白。
     词组答案里「多敲一个空格」不应该判错。 */
  function normClozeAnswer(value) {
    return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  function formatStoryEn(text) {
    if (!text) return "";
    var escaped = esc(text);
    return escaped.replace(STORY_BOLD_RE, function (match, word) {
      var key = String(word).toLowerCase();
      if (view.storyMode === "cloze") {
        var userAns = (view.clozeAnswers && view.clozeAnswers[key]) || "";
        var isRevealed = view.clozeRevealed && view.clozeRevealed[key];
        var isCorrect = normClozeAnswer(userAns) === normClozeAnswer(key);
        if (isCorrect) {
          return '<span class="en-cloze-blank correct" data-say="' + esc(word) + '" title="回答正确！点击发音">✅ <b>' + esc(word) + '</b></span>';
        }
        if (isRevealed) {
          return '<span class="en-cloze-blank revealed" data-say="' + esc(word) + '" title="已提示">💡 <b>' + esc(word) + '</b></span>';
        }
        /* 词组比单词长，宽度上限放宽到 240px，太长换行也不至于挤成一团 */
        var widthPx = Math.max(56, Math.min(240, word.length * 9 + 20));
        var lead = word.charAt(0);
        return (
          '<span class="en-cloze-wrap">' +
          '<input class="en-cloze-input" data-cloze-word="' + esc(key) + '" data-cloze-orig="' + esc(word) + '" ' +
          'style="width:' + widthPx + 'px" value="' + esc(userAns) + '" placeholder="' + esc(lead) + '..." ' +
          'autocomplete="off" spellcheck="false" />' +
          '<button class="en-cloze-hint-btn" data-en-action="cloze-hint" data-cloze-word="' + esc(key) + '" title="查看提示">💡</button>' +
          '</span>'
        );
      }
      return '<span class="en-story-word" data-say="' + esc(word) + '" title="点击发音">' + esc(word) + '</span>';
    });
  }

  function renderRoundSummary() {
    var words = view.roundWords || [];
    var total = words.length;

    var count4 = 0, count3 = 0, count2 = 0, count1 = 0;
    words.forEach(function (w) {
      if (w.rating === 4) count4++;
      else if (w.rating === 3) count3++;
      else if (w.rating === 2) count2++;
      else count1++;
    });

    var goodPercent = total ? Math.round(((count3 + count4) / total) * 100) : 0;

    // 顶部战报卡片
    var reportCard =
      '<div class="en-card en-summary-hero">' +
      '<div class="en-row">' +
      '<div>' +
      '<div class="en-summary-title">🎉 本轮刷词通关！</div>' +
      '<div class="en-muted" style="margin-top:3px">本轮共巩固 <b>' + total + '</b> 个单词 · 掌握度 <b>' + goodPercent + '%</b>' +
      (view.maxCombo >= 2 ? ' · <span style="color:var(--gold)">🔥 最高 ' + view.maxCombo + ' 连击</span>' : '') +
      '</div></div>' +
      '<div class="en-summary-rate-pill">' + goodPercent + '%</div>' +
      '</div>' +
      '<div class="en-stats" style="margin-top:10px">' +
      '<div class="en-stat"><b style="color:var(--green)">' + count4 + '</b><span>秒懂</span></div>' +
      '<div class="en-stat"><b style="color:var(--ink)">' + count3 + '</b><span>认识</span></div>' +
      '<div class="en-stat"><b style="color:var(--gold)">' + count2 + '</b><span>模糊</span></div>' +
      '<div class="en-stat"><b style="color:var(--red)">' + count1 + '</b><span>忘了</span></div>' +
      '</div>' +
      '<div class="en-word-chips" style="margin-top:10px">' +
      words.map(function(w) {
        var colorClass = w.rating === 4 ? 'master' : (w.rating === 3 ? 'good' : (w.rating === 2 ? 'hard' : 'again'));
        return '<span class="en-chip ' + colorClass + '" data-say="' + esc(w.word) + '" title="' + esc(w.meaning) + ' (点击发音)">' +
          esc(w.word) + '</span>';
      }).join(' ') +
      '</div>' +
      '</div>';

    // 联结短文与故事卡片
    var storySection = '';
    if (view.storyLoading) {
      storySection =
        '<div class="en-card en-story-card">' +
        '<div class="en-story-loading">' +
        '<div class="en-spinner"></div>' +
        '<div style="font-weight:600;margin-top:8px">小源正在构思联结故事与助记短文…</div>' +
        '<div class="en-muted" style="font-size:calc(11.5px * var(--font-scale, 1));margin-top:4px">正在挖掘本轮 ' + total + ' 个单词的内在语义网与逻辑关系</div>' +
        '</div></div>';
    } else if (view.story) {
      var s = view.story;
      var linksHtml = '';
      if (Array.isArray(s.word_links) && s.word_links.length) {
        linksHtml =
          '<div class="en-extra-sec" style="margin-top:16px">' +
          '<div class="en-extra-label">🧠 单词联想与助记点</div>' +
          '<div class="en-links-grid">' +
          s.word_links.map(function(l) {
            return (
              '<div class="en-link-item">' +
              '<div class="en-link-head">' +
              '<b>' + esc(l.word) + '</b>' +
              '<button class="en-say" data-say="' + esc(l.word) + '" title="朗读" aria-label="朗读">🔊</button>' +
              '</div>' +
              (l.mnemonic ? '<div class="en-link-mne">💡 ' + esc(l.mnemonic) + '</div>' : '') +
              (l.context_sentence ? '<div class="en-link-sent">“' + esc(l.context_sentence) + '”</div>' : '') +
              '</div>'
            );
          }).join('') +
          '</div></div>';
      }

      /* 与 formatStoryEn 共用同一正则 —— 两处口径不一致会导致「看得见挑战、进度却 0/0」 */
      var matches = (s.story_en.match(STORY_BOLD_RE) || []);
      var totalCloze = matches.length;
      var solvedCloze = 0;
      matches.forEach(function (m) {
        var w = m.replace(/\*\*/g, "").toLowerCase();
        if ((view.clozeAnswers && view.clozeAnswers[w] && normClozeAnswer(view.clozeAnswers[w]) === normClozeAnswer(w)) ||
            (view.clozeRevealed && view.clozeRevealed[w])) {
          solvedCloze++;
        }
      });

      var clozeBannerHtml = '';
      if (view.storyMode === 'cloze') {
        if (totalCloze > 0 && solvedCloze >= totalCloze) {
          clozeBannerHtml =
            '<div class="en-cloze-banner">' +
            '<div><b>🎉 太棒了！全部 ' + totalCloze + ' 个目标词挖词通关！</b>' +
            '<div class="en-muted" style="font-size:calc(11.5px * var(--font-scale, 1));margin-top:2px">已在完整微小说语境中完成主动提取与拼写</div></div>' +
            '<button class="en-btn" data-en-action="toggle-story-mode">📖 切换为纯享阅读</button>' +
            '</div>';
        } else {
          clozeBannerHtml =
            '<div class="en-cloze-stats">' +
            '🧩 挖词挑战进度：<b>' + solvedCloze + ' / ' + totalCloze + '</b> · 输入完整单词自动核对，可点 💡 提示' +
            '</div>';
        }
      }

      storySection =
        '<div class="en-card en-story-card' + (view.storyMode === 'cloze' ? ' en-cloze-card' : '') + '">' +
        '<div class="en-story-head">' +
        '<div class="en-story-theme-badge">📖 联结故事 · ' + esc(s.theme || '本轮串联') + '</div>' +
        '<div class="en-story-ctrls">' +
        '<button class="en-btn ' + (view.storyMode === 'cloze' ? 'primary' : '') + '" data-en-action="toggle-story-mode">' +
        (view.storyMode === 'cloze' ? '📖 退出挑战·阅读' : '🧩 开启挖词挑战') +
        '</button>' +
        '<button class="en-btn ' + (view.storySpeaking ? 'primary' : '') + '" data-en-action="speak-story">' +
        (view.storySpeaking ? '⏸️ 停止朗读' : '🔊 全文朗读') +
        '</button>' +
        '<button class="en-btn" data-en-action="toggle-story-zh">' + (view.storyShowZh ? '隐藏中文' : '中文对照') + '</button>' +
        '<button class="en-btn" data-en-action="copy-story">📋 复制</button>' +
        '</div>' +
        '</div>' +
        (s.theme_explanation ? '<div class="en-story-explain">💡 <b>联结线索：</b>' + esc(s.theme_explanation) + '</div>' : '') +
        clozeBannerHtml +
        '<div class="en-story-body">' + formatStoryEn(s.story_en) + '</div>' +
        (view.storyShowZh && s.story_zh ? '<div class="en-story-zh">' + esc(s.story_zh) + '</div>' : '') +
        linksHtml +
        '</div>';
    } else {
      storySection =
        '<div class="en-card">' +
        '<div class="en-empty" style="padding:16px 8px">' +
        '<div style="font-weight:600;margin-bottom:4px">将本轮复习的单词编织为联结短文</div>' +
        '<div class="en-muted" style="margin-bottom:12px">用 AI 寻找单词间的内在联结，在真实语境中强化长效记忆</div>' +
        '<button class="en-btn primary" data-en-action="gen-story">✨ 立即生成本轮联结短文与记忆故事</button>' +
        '</div></div>';
    }

    // 底部操作栏
    var bottomBar =
      '<div class="en-actions" style="justify-content:center;margin-top:12px">' +
      '<button class="en-btn primary wide" data-en-action="new-round">🔄 开启下一轮复习 [Enter]</button>' +
      '<button class="en-btn" data-en-action="go-decks">📚 返回词库</button>' +
      '</div>';

    return reportCard + storySection + bottomBar;
  }

  /* ------------------------------------------------------ 渲染：各页签 */

  /* ------------------------------------------------------ 记忆曲线 */

  function tzOffsetMinutes() {
    // 浏览器当前时区相对 UTC 的分钟偏移（东八区 getTimezoneOffset() 返回 -480）
    return -new Date().getTimezoneOffset();
  }

  function loadHistory() {
    call(API + "/review-history?days=30&tz_offset_minutes=" + tzOffsetMinutes())
      .then(function (data) {
        view.history = data;
        render();
        return null;
      })
      .catch(function () {
        /* 记忆曲线拿不到不影响词库页 */
      });
  }

  function renderHistoryCard() {
    var data = view.history;
    if (!data || !data.history || !data.history.length) return "";
    var days = data.history;
    var max = 0;
    days.forEach(function (d) {
      if (d.count > max) max = d.count;
    });
    var bars = days
      .map(function (d) {
        var h = max > 0 ? Math.round((d.count / max) * 100) : 0;
        return (
          '<div class="en-hist-bar' + (d.count ? "" : " zero") + '"' +
          ' style="height:' + Math.max(h, 6) + '%"' +
          ' title="' + esc(d.day.slice(5)) + " · " + d.count + ' 词"></div>'
        );
      })
      .join("");
    var total = days.reduce(function (s, d) {
      return s + d.count;
    }, 0);
    return (
      '<div class="en-card">' +
      '<div class="en-row"><p class="en-title" style="margin:0">📈 近 30 天复习节奏</p>' +
      '<span class="en-muted">共 ' + total + " 词</span></div>" +
      '<div class="en-hist">' + bars + "</div>" +
      '<div class="en-hist-axis"><span>' + esc(days[0].day.slice(5)) + "</span>" +
      "<span>" + esc(days[days.length - 1].day.slice(5)) + "</span></div></div>"
    );
  }

  /* ------------------------------------------------------ 筛熟词 */

  function openFilterDeck(deckId) {
    var decks = (view.overview && view.overview.decks) || [];
    var deck = decks.filter(function (d) {
      return d.deck_id === deckId;
    })[0];
    view.filterDeck = {
      deck_id: deckId,
      name: deck ? deck.name : "这个词库",
      suggest: [],
      total: 0,
      loading: true,
    };
    render();
    call(API + "/decks/" + encodeURIComponent(deckId) + "/known-suggest")
      .then(function (data) {
        if (!view.filterDeck || view.filterDeck.deck_id !== deckId) return;
        view.filterDeck.suggest = data.suggest || [];
        view.filterDeck.total = data.total || 0;
        view.filterDeck.loading = false;
        render();
        return null;
      })
      .catch(function (error) {
        if (!view.filterDeck || view.filterDeck.deck_id !== deckId) return;
        view.filterDeck.loading = false;
        view.error = (error && error.message) || "筛熟词失败";
        render();
      });
  }

  function renderFilterPanel() {
    var f = view.filterDeck;
    if (!f) return "";
    if (f.loading) {
      return '<div class="en-card"><div class="en-empty">正在找出你已认识的高频词…</div></div>';
    }
    if (!f.total) {
      return (
        '<div class="en-card"><div class="en-filter-head"><p class="en-title" style="margin:0">⚡ 筛熟词</p>' +
        '<button class="en-btn" data-en-action="filter-close">关闭</button></div>' +
        '<div class="en-empty">这个词表里没有还没学的词了。</div></div>'
      );
    }
    var preview = f.suggest
      .map(function (w) {
        return '<span class="en-filter-chip" title="' + esc(w.meaning) + '">' + esc(w.word) + "</span>";
      })
      .join("");
    var count = f.suggest.length;
    return (
      '<div class="en-card">' +
      '<div class="en-filter-head"><p class="en-title" style="margin:0">⚡ 筛熟词 · ' + esc(f.name) + "</p>" +
      '<button class="en-btn" data-en-action="filter-close">关闭</button></div>' +
      '<div class="en-filter-preview">这个词表还有 <b>' + f.total + "</b> 个词没学。下面是最高频、你最可能已经认识的 <b>" + count + "</b> 个（悬停看释义）：</div>" +
      '<div class="en-filter-chips">' + preview + "</div>" +
      '<div class="en-actions"><button class="en-btn primary" data-en-action="filter-do">筛除这 ' +
      count + " 个高频熟词</button>" +
      '<button class="en-btn" data-en-action="filter-close">取消</button></div></div>'
    );
  }

  function doFilterKnown() {
    var f = view.filterDeck;
    if (!f || !f.suggest.length) return;
    var ids = f.suggest.map(function (w) {
      return w.word_id;
    });
    view.busy = true;
    render();
    call(API + "/decks/" + encodeURIComponent(f.deck_id) + "/filter-known", {
      method: "POST",
      body: { word_ids: ids },
    })
      .then(function (data) {
        view.busy = false;
        view.filterDeck = null;
        view.notice = "已筛除 " + (data.removed || 0) + " 个熟词。";
        return loadOverview();
      })
      .catch(function (error) {
        view.busy = false;
        view.error = (error && error.message) || "筛除失败";
        render();
      });
  }

  function renderDecks() {
    var data = view.overview || {};
    var stats = data.stats || {};
    var decks = data.decks || [];
    var builtin = data.builtin || [];
    var mine = decks.map(function (deck) {
      return (
        '<div class="en-deck"><div style="min-width:0"><div class="en-deck-name">' +
        esc(deck.name) +
        '</div><div class="en-muted">' +
        deck.word_count +
        " 词 · 已掌握 " +
        deck.mastered +
        ' 词</div><div class="en-bar"><i style="width:' +
        pct(deck.mastery) +
        '"></i></div></div>' +
        '<div class="en-deck-actions">' +
        '<button class="en-btn" data-en-action="filter-deck" data-deck="' +
        esc(deck.deck_id) +
        '" title="筛掉你已经认识的基础词">⚡ 筛熟词</button>' +
        '<button class="en-btn danger" data-en-action="del-deck" data-deck="' +
        esc(deck.deck_id) +
        '">删除</button></div></div>'
      );
    });
    var cards = builtin.map(function (item) {
      var owned = decks.some(function (deck) {
        return deck.source_kind === "builtin" && deck.source_ref === item.deck_id;
      });
      return (
        '<div class="en-deck"><div style="min-width:0"><div class="en-deck-name">' +
        esc(item.name) +
        '</div><div class="en-muted">' +
        esc(item.description || "") +
        " · " +
        item.word_count +
        " 词</div></div>" +
        (owned
          ? '<span class="en-muted">已加入</span>'
          : '<button class="en-btn" data-en-action="add-builtin" data-deck="' +
            esc(item.deck_id) +
            '">加入</button>') +
        "</div>"
      );
    });

    var archive = loadStoryArchive();
    var archiveHtml = "";
    if (archive.length) {
      archiveHtml =
        '<div class="en-card">' +
        '<div class="en-row">' +
        '<p class="en-title" style="margin:0">📖 往期联结短文与故事 (' + archive.length + ' 篇)</p>' +
        '<span class="en-muted" style="font-size:calc(11.5px * var(--font-scale, 1))">点击重温故事与挖词挑战</span>' +
        '</div>' +
        '<div style="margin-top:10px">' +
        archive.slice(0, 6).map(function (item) {
          return (
            '<div class="en-history-item" data-en-action="view-history-story" data-story-id="' + esc(item.id) + '">' +
            '<div class="en-history-item-head">' +
            '<b>📖 ' + esc(item.theme || "联结短文") + '</b>' +
            '<span class="en-muted">' + esc(item.created_at || "") + '</span>' +
            '</div>' +
            '<div class="en-history-item-words">涉及词汇：' + esc((item.words || []).join(" · ")) + '</div>' +
            '</div>'
          );
        }).join("") +
        '</div></div>';
    }

    return (
      renderFilterPanel() +
      '<div class="en-card"><div class="en-stats">' +
      '<div class="en-stat"><b>' +
      (stats.total || 0) +
      "</b><span>词库总量</span></div>" +
      '<div class="en-stat"><b>' +
      (stats.due || 0) +
      "</b><span>今日待复习</span></div>" +
      '<div class="en-stat"><b>' +
      (stats.mastered || 0) +
      "</b><span>已掌握</span></div>" +
      "</div>" +
      '<div style="margin-top:10px"><button class="en-btn primary wide" data-en-action="go-review"' +
      (stats.due ? "" : " disabled") +
      ">" +
      (stats.due ? "开始复习（" + stats.due + " 词）" : "今天没有待复习的词") +
      "</button></div>" +
      '<div class="en-kbd">今日已复习 ' +
      (stats.reviewed_today || 0) +
      " 词 · 连续 " +
      (stats.streak_days || 0) +
      " 天</div></div>" +
      renderHistoryCard() +

      '<div class="en-card"><p class="en-title">我的词库</p>' +
      (mine.join("") || '<div class="en-empty">还没有词库。先去「语料」从你导入的资料里摘一批来学。</div>') +
      "</div>" +
      archiveHtml +

      // 主渠道：从自己的资料里采。放最上面，因为这才是词的来源。
      '<div class="en-card"><p class="en-title">① 从我的资料里采词（主渠道）</p>' +
      '<div class="en-muted" style="line-height:1.7">扫描当前项目已导入的资料，自动找出你还不认识的词，' +
      "并算出每份材料的「词覆盖率」——告诉你再掌握多少词就能读顺这篇。</div>" +
      '<div class="en-actions"><button class="en-btn primary" data-en-action="scan">扫描当前项目</button>' +
      '<button class="en-btn" data-en-action="go-candidates">查看待加入<span class="en-count" data-en-pending>' +
      (view.overview && view.overview.candidate_count ? view.overview.candidate_count : 0) +
      "</span></button></div>" +
      '<div class="en-muted" data-en-scan-status>' +
      esc(view.scan || "") +
      "</div></div>" +

      // 兜底：内置词表降级成折叠区。它是「资料还没导入时的过渡」，不是主推。
      '<div class="en-card"><div class="en-row">' +
      '<p class="en-title" style="margin:0">② 内置词表（兜底，非主推）</p>' +
      '<button class="en-btn" style="padding:3px 10px; font-size:calc(11.5px * var(--font-scale, 1))" data-en-action="toggle-builtin">' +
      (view.showBuiltin ? "收起 ▲" : "展开 ▼") +
      "</button></div>" +
      '<div class="en-muted" style="margin:6px 0 0">考研/四六级等通用词书。它回答的是「考试要考哪些词」，' +
      "不回答「你现在被哪些词绊住」——有自己的资料时，请优先用上面那条路。</div>" +
      (view.showBuiltin
        ? '<div style="margin-top:10px">' +
          (cards.join("") || '<div class="en-empty">内置词表数据缺失。</div>') +
          "</div>"
        : "") +
      "</div>"
    );
  }

  function renderExtrasCard(word) {
    var lemma = String(word.lemma || word.word || "").toLowerCase();
    var head = '<p class="en-title">拓展</p>';
    if (!view.extrasOpen) {
      return (
        '<div class="en-card">' + head +
        '<div class="en-actions" style="margin-bottom:0">' +
        '<button class="en-btn" data-en-action="open-extras">查看拓展</button>' +
        '<span class="en-muted" style="align-self:center">例句 · 近义词 · 反义词 · 常见搭配 · 形近词</span>' +
        "</div></div>"
      );
    }
    if (view.extrasLoading === lemma) {
      return '<div class="en-card">' + head + '<div class="en-muted">正在准备拓展内容…</div></div>';
    }
    var data = view.extras[lemma];
    if (!data) {
      return (
        '<div class="en-card">' + head +
        '<div class="en-actions"><button class="en-btn" data-en-action="open-extras">重新加载</button></div></div>'
      );
    }

    function tagRow(label, list) {
      if (!list || !list.length) return "";
      return (
        '<div class="en-extra-sec"><span class="en-extra-label">' + label + "</span><div>" +
        list
          .map(function (item) {
            return '<span class="en-extra-tag">' + esc(item) + "</span>";
          })
          .join("") +
        "</div></div>"
      );
    }

    function highlightWordInText(text, targetWord) {
      if (!text || !targetWord) return esc(text || "");
      var escaped = esc(text);
      var targetClean = String(targetWord).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      var reg = new RegExp("\\b(" + targetClean + "(?:s|es|ed|ing|d|r|er)?)\\b", "gi");
      return escaped.replace(reg, '<mark class="en-ex-hl">$1</mark>');
    }

    var sections = "";
    if (data.examples && data.examples.length) {
      sections +=
        '<div class="en-extra-sec"><span class="en-extra-label">例句</span>' +
        data.examples
          .map(function (item) {
            return (
              '<div class="en-extra-item">' +
              '<div class="en-extra-say"><span class="en-extra-en">' +
              highlightWordInText(item.en, word.lemma || word.word) +
              '</span><button class="en-say" data-en-action="say-example" data-say="' +
              esc(item.en) +
              '" title="朗读例句" aria-label="朗读例句">🔊</button></div>' +
              (item.zh ? '<div class="en-muted">' + esc(item.zh) + "</div>" : "") +
              "</div>"
            );
          })
          .join("") +
        "</div>";
    }
    sections += tagRow("近义词", data.synonyms);
    sections += tagRow("反义词", data.antonyms);
    sections += tagRow("常见搭配", data.collocations);
    if (data.similar && data.similar.length) {
      // 形近词带词典释义，文案长 → 用「词 + 释义」两段式列表，窄栏里也不会挤成一片
      sections +=
        '<div class="en-extra-sec"><span class="en-extra-label">形近词</span>' +
        data.similar
          .map(function (item) {
            return (
              '<div class="en-extra-row"><b>' +
              esc(item.word) +
              "</b>" +
              (item.meaning ? '<span class="en-muted">' + esc(item.meaning) + "</span>" : "") +
              "</div>"
            );
          })
          .join("") +
        "</div>";
    }

    var err = data.ai_error
      ? '<div class="en-note error">' + esc(data.ai_error) + "</div>"
      : "";
    var body = sections || '<div class="en-muted">暂时没有可用的拓展内容。</div>';
    return '<div class="en-card">' + head + err + body + "</div>";
  }

  function loadExtras() {
    var word = view.queue[view.index];
    if (!word) return;
    var lemma = String(word.lemma || "").toLowerCase();
    view.extrasOpen = true;
    // 批量预生成写进来的缓存只有 AI 那几个字段（没有形近词/语境），
    // 所以这里以「有没有 similar」判断是否需要再向服务端要一次完整数据。
    var cached = view.extras[lemma];
    if (!cached || !cached.similar) {
      view.extrasLoading = lemma;
      render();
      call(API + "/extras?word_id=" + encodeURIComponent(word.word_id || ""))
        .then(function (data) {
          view.extras[lemma] = data || {};
          view.extrasLoading = "";
          render();
          return null;
        })
        .catch(function (error) {
          view.extras[lemma] = { ai_error: (error && error.message) || "拓展内容加载失败" };
          view.extrasLoading = "";
          render();
        });
      return;
    }
    render();
  }

  /* 批量预生成当前队列前 8 个词的拓展：一次模型调用覆盖多个词，
     用户真点开时命中缓存、不用边背边等。已经在缓存里的词服务端会跳过。 */
  function prefillExtras() {
    var ids = view.queue
      .slice(view.index, view.index + 8)
      .map(function (word) {
        return word.word_id || "";
      })
      .filter(Boolean);
    if (!ids.length) {
      view.prefill = "当前队列里没有可预生成的词。";
      render();
      return;
    }
    view.prefill = "正在预生成 " + ids.length + " 个词的拓展…";
    render();
    call(API + "/extras/batch", { method: "POST", body: { word_ids: ids } })
      .then(function (data) {
        Object.keys((data && data.extras) || {}).forEach(function (lemma) {
          view.extras[lemma] = data.extras[lemma];
        });
        if (data && data.ai_error) {
          view.prefill = data.ai_error;
        } else {
          view.prefill =
            "已生成 " +
            (data.generated || 0) +
            " 个词，缓存命中 " +
            (data.cached_hits || 0) +
            " 个" +
            (data.pending && data.pending.length
              ? "，另有 " + data.pending.length + " 个未成功（可再点一次重试）"
              : "") +
            "。";
        }
        render();
        return null;
      })
      .catch(function (error) {
        view.prefill = (error && error.message) || "预生成失败";
        render();
      });
  }

  function toggleSpell() {
    view.spellMode = !view.spellMode;
    view.spellInput = "";
    view.spellResult = "";
    view.spokenFor = ""; // 进入拼写模式立刻把当前词读一遍
    render();
    if (view.spellMode && view.queue.length) {
      var word = view.queue[view.index] || {};
      speak(word.lemma || word.word || "");
    }
  }

  function checkSpelling() {
    var word = view.queue[view.index];
    if (!word || view.spellResult) return; // 已判定过就不再重复判
    var target = String(word.lemma || word.word || "").trim().toLowerCase();
    var input = String(view.spellInput || "").trim().toLowerCase();
    if (!input) return;
    if (input === target) {
      view.spellResult = "correct";
      speak(target);
    } else {
      view.spellResult = "wrong";
    }
    render();
    var inputNode = document.querySelector("[data-en-spell-input]");
    if (inputNode) inputNode.focus();
  }

  /* 「现在还能刷几个词」= 到期复习词 + 今日新词配额余额（再受词库剩余新词封顶）。
     ⚠️ 绝不能用 stats.due：它把从来没学过的新词也算成「到期」（新词建卡时 due_at 就在
     过去），而队列只收 reps>0 的复习词、新词另受 new_per_day 限制。实测同一份数据
     due=31 而到期复习词=0、新词配额 15/15 用尽 → 队列真的空，按钮点了没反应。 */
  function reviewAvailability() {
    var st = (view.overview && view.overview.stats) || {};
    var prefs = (view.overview && view.overview.prefs) || {};
    var meta = view.queueMeta || {};
    var perDay = Number(meta.new_per_day || prefs.new_per_day || 0);
    var fresh = Number(st.fresh || 0);
    var quotaLeft = Math.max(0, perDay - Number(st.new_today || 0));
    return {
      dueReview: Number(st.due_review || 0),
      fresh: fresh,
      quotaLeft: quotaLeft,
      more: Number(st.due_review || 0) + Math.min(fresh, quotaLeft),
    };
  }

  function renderReview() {
    if (view.roundFinished || !view.queue.length) {
      if (view.roundWords && view.roundWords.length > 0) {
        return renderRoundSummary();
      }
      var avail = reviewAvailability();
      var dueReview = avail.dueReview;
      var freshLeft = avail.fresh;
      var more = avail.more;
      var st = (view.overview && view.overview.stats) || {};
      var meta = view.queueMeta || {};

      if (view.queueLoading) {
        return (
          '<div class="en-card"><div class="en-empty">正在拉取下一轮…</div></div>'
        );
      }
      if (more > 0) {
        return (
          '<div class="en-card"><div class="en-empty">本轮刷完了，还能接着刷 <b>' + more + '</b> 个词' +
          (dueReview ? "（其中 " + dueReview + " 个是到期复习）" : "") +
          '。<br>点下面的按钮开下一轮，也可以先歇会儿再回来。</div>' +
          '<div class="en-actions" style="justify-content:center"><button class="en-btn primary" data-en-action="reload-queue">继续下一轮（可刷 ' + more + ' 词）</button></div></div>'
        );
      }
      if (freshLeft > 0) {
        // 到期复习刷完了、新词也还有，但今日新词配额用尽 —— 说清楚为什么刷不动，
        // 并给一条用户自己能按的开关（一次性多放行 10 个），而不是摆个死按钮。
        var batch = Math.min(10, freshLeft);
        return (
          '<div class="en-card"><div class="en-empty">到期复习都刷完了 👍<br>还有 <b>' + freshLeft + '</b> 个新词没学，但今日新词配额 <b>' +
          Number(st.new_today || 0) + '/' + Number(meta.new_per_day || 0) +
          '</b> 已用完。<br>留到明天按节奏学效果更好；想今天就啃完也可以自己放行。</div>' +
          '<div class="en-actions" style="justify-content:center">' +
          '<button class="en-btn primary" data-en-action="extra-new" data-count="' + batch + '">今天再学 ' + batch + ' 个</button>' +
          '<button class="en-btn" data-en-action="reload-queue">刷新一下</button></div></div>'
        );
      }
      return (
        '<div class="en-card"><div class="en-empty">今天的词都复习完了。<br>可以去「📄 语料」扫一份资料积累生词，或到「词库」看看还有没有没学的词。</div>' +
        '<div class="en-actions" style="justify-content:center"><button class="en-btn primary" data-en-action="reload-queue">重新拉取队列</button></div></div>'
      );
    }
    var word = view.queue[view.index] || {};
    var total = view.queue.length;
    var done = total - view.index;
    var contexts = word.contexts || [];
    var ctx = contexts[0] || null;

    var ctxHtml = "";
    if (ctx && ctx.text) {
      var shown = ctx.text;
      if (ctx.cloze) {
        shown = esc(ctx.text).replace(
          new RegExp("\\b" + esc(word.word || word.lemma) + "\\b", "i"),
          '<span class="en-blank">____</span>'
        );
      } else {
        shown = esc(shown);
      }
      ctxHtml =
        '<div class="en-ctx">' +
        shown +
        '<span class="en-ctx-src">' +
        esc(ctx.source_title || "来自你导入的资料") +
        "</span></div>";
    }

    var roots = (word.root_explain || []).length
      ? '<div class="en-roots">' +
        (word.root_explain || [])
          .map(function (item) {
            return "<code>" + esc(item.root) + "</code> " + esc(item.meaning);
          })
          .join(" &nbsp;·&nbsp; ") +
        "</div>"
      : "";

    // 释义分段：ECDICT 的原始串又长又杂，按词性拆行看才不吃力
    function meaningKey(text) {
      // 只比「内容」，不比标点 —— 否则「vt. 消耗, 消费 / vi. 耗尽」因为逗号
      // 变成顿号就会被误判成"有内容被砍掉"，凭空多出一个入口。
      return String(text || "")
        .replace(/[\s,，、;；/／·.。:：()（）\[\]【】]/g, "")
        .toLowerCase();
    }

    // 释义里到底有没有中文：语料收进来的词常常只有模型写的英文注释，
    // 那不是「没显示」，是**一个中文字都没有**——两种情况要给的说法不一样。
    function hasCjk(text) {
      return /[\u4e00-\u9fff]/.test(String(text || ""));
    }

    function renderMeaning() {
      var sections = Array.isArray(word.meaning_sections) ? word.meaning_sections : [];
      var cleaned = word.meaning || "";
      var full = word.meaning_full || "";
      // 中文来源标注：让用户知道这个中文是「自己资料里的对照」还是「词典」，
      // 而不是凭空冒出来的。词组拼不出中文时宁可明说，也不假装是翻译。
      var zhNote = "";
      if (!hasCjk(cleaned)) {
        zhNote = '<div class="en-mean-note">暂无中文释义（词典未收录这个词组）' +
          (word.meaning_en ? "，下面是资料里的英文注释" : "") + "。</div>";
      } else if (word.meaning_zh_source === "corpus-zh") {
        zhNote = '<div class="en-mean-note">中文来自你资料里的中英对照</div>';
      } else if (word.meaning_zh_source === "dict") {
        zhNote = '<div class="en-mean-note">中文来自内置词典</div>';
      }
      if (!sections.length) {
        return (
          '<div class="en-mean-line">' +
          esc(cleaned || "（词典里没有这个词，可点「忘了」稍后再看）") +
          "</div>" +
          zhNote
        );
      }
      var rows = sections
        .map(function (section) {
          return (
            '<div class="en-mean-line">' +
            (section.pos ? '<b>' + esc(section.pos) + "</b> " : "") +
            esc((section.senses || []).join("、")) +
            "</div>"
          );
        })
        .join("");
      // 只有真的丢过内容（领域标注、超出的义项、英文原注）才给展开入口
      var expandable = full && meaningKey(full) !== meaningKey(cleaned);
      if (expandable && !view.showFullMeaning) {
        rows +=
          '<button class="en-link" data-en-action="toggle-full-meaning">查看完整释义</button>';
      } else if (expandable) {
        rows +=
          '<div class="en-mean-raw">' +
          esc(full) +
          '</div><button class="en-link" data-en-action="toggle-full-meaning">收起</button>';
      }
      return rows + zhNote;
    }

    // 复习工具条：新词配额 + 自动朗读开关 + 拓展预生成 + 连击
    var meta = view.queueMeta || {};
    var comboClass = "";
    var comboIcon = "🔥";
    if (view.combo >= 10) {
      comboClass = " star";
      comboIcon = "⚡⭐";
    } else if (view.combo >= 5) {
      comboClass = " electric";
      comboIcon = "⚡";
    } else if (view.combo >= 2) {
      comboClass = " fire";
      comboIcon = "🔥";
    }
    var comboHtml = view.combo >= 2
      ? '<span class="en-combo-badge' + comboClass + '">' + comboIcon + ' 连对 ' + view.combo + ' 词</span>'
      : "";
    var toolbar =
      '<div class="en-toolbar">' +
      '<span class="en-muted">复习 ' +
      (meta.review_count || 0) +
      " · 新词 " +
      (meta.new_today || 0) +
      "/" +
      (meta.new_per_day || 0) +
      "</span>" +
      comboHtml +
      '<button class="en-tab' +
      (view.autoSpeak ? " active" : "") +
      '" data-en-action="toggle-speak">' +
      (view.autoSpeak ? "🔊 自动朗读" : "🔈 已静音") +
      "</button>" +
      '<button class="en-tab' +
      (view.spellMode ? " active" : "") +
      '" data-en-action="toggle-spell">✍️ 拼写</button>' +
      '<button class="en-tab" data-en-action="prefill-extras">预生成拓展</button>' +
      "</div>" +
      (view.prefill ? '<div class="en-note">' + esc(view.prefill) + "</div>" : "");


    var ratings = [1, 2, 3, 4]
      .map(function (rating) {
        var labels = { 1: "忘了", 2: "模糊", 3: "认识", 4: "秒懂" };
        var when = view.preview[String(rating)] || "";
        var suggest = "";
        if (view.spellResult === "correct" && rating >= 3) suggest = " suggest";
        else if (view.spellResult === "wrong" && rating <= 2) suggest = " suggest";
        return (
          '<button class="en-rate' + suggest + '" data-en-action="rate" data-rating="' +
          rating +
          '"><div class="en-rate-top"><b>' +
          labels[rating] +
          '</b><span class="en-rate-kbd">' +
          rating +
          '</span></div><span>' +
          esc(when) +
          "</span></button>"
        );
      })
      .join("");

    var rootsClue = "";
    if (word.root_explain && word.root_explain.length) {
      rootsClue =
        '<div class="en-assoc-clue">' +
        '<span class="en-assoc-label">🧠 联想拆解</span>' +
        word.root_explain
          .map(function (item) {
            return "<code>" + esc(item.root) + "</code> " + esc(item.meaning);
          })
          .join(" &nbsp;+&nbsp; ") +
        "</div>";
    }

    // 拼写模式：不显示单词本身，改听发音输入拼写（主动回忆）。释义只当义项线索，
    // 词根拆解会泄露拼写，所以拼写模式下不展示 rootsClue。
    var spellHtml = "";
    if (view.spellMode) {
      var spellResultHtml = "";
      if (view.spellResult === "correct") {
        spellResultHtml = '<div class="en-spell-result correct">✓ 拼写正确！</div>';
      } else if (view.spellResult === "wrong") {
        spellResultHtml =
          '<div class="en-spell-result wrong">✗ 正确拼写：<span class="en-spell-answer">' +
          esc(word.lemma || word.word) +
          "</span></div>";
      }
      spellHtml =
        (word.meaning
          ? '<div class="en-spell-hint">释义：' + esc(word.meaning) + "</div>"
          : "") +
        '<div class="en-spell-row">' +
        '<input class="en-input en-spell-input" data-en-spell-input type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="🔊 听发音，输入拼写…" value="' +
        esc(view.spellInput) +
        '">' +
        '<button class="en-btn primary" data-en-action="spell-check">提交</button>' +
        "</div>" +
        spellResultHtml;
    }

    return (
      '<div class="en-progress"><i style="width:' +
      Math.round(((view.index + 1) / total) * 100) +
      '%"></i></div>' +
      toolbar +
      '<div class="en-card">' +
      '<div class="en-row"><span class="en-muted">' +
      (view.index + 1) +
      " / " +
      total +
      (word.is_new ? '<span class="en-new-tag">新词</span>' : "") +
      "</span><span class=\"en-muted\">" +
      esc(
        (word.tags || "")
          .split(" ")
          .filter(Boolean)
          .slice(0, 3)
          .join(" · ")
      ) +
      "</span></div>" +
      (view.spellMode
        ? spellHtml
        : '<div class="en-word-row">' +
          '<span class="en-word">' +
          esc(word.word || word.lemma || "") +
          '</span><button class="en-say" data-en-action="say-word" title="朗读单词" aria-label="朗读单词">🔊</button>' +
          "</div>" +
          '<div class="en-phon-row">' +
          (word.phonetic ? '<span class="en-phon-pill">/' + esc(word.phonetic.replace(/^\/|\/$/g, '')) + '/</span>' : '') +
          '<button class="en-phon-say" data-en-action="say-word">朗读发音</button>' +
          "</div>" +
          rootsClue) +
      ctxHtml +
      '<div class="en-ratings">' +
      ratings +
      "</div></div>" +

      // 操作按钮紧跟主卡：先看释义 / 结束本轮 不用滚到最底下才点得到
      '<div class="en-actions">' +
      '<button class="en-btn primary" data-en-action="show-answer">先看释义 [Space]</button>' +
      (view.roundWords && view.roundWords.length > 0
        ? '<button class="en-btn" data-en-action="finish-round">完成本轮 & 串联短文 (' + view.roundWords.length + '词)</button>'
        : '') +
      '<button class="en-btn" data-en-action="go-decks">结束本轮</button></div>' +

      // 释义卡的展开状态存在 view.answerShown 里 —— 之前靠直接改 DOM.hidden，
      // 一触发重渲染（例如加载拓展）就会被重新折起来，看起来像"点了没反应"。
      '<div class="en-card" data-en-answer' +
      (view.answerShown ? "" : " hidden") +
      ">" +
      '<p class="en-title">释义</p>' +
      renderMeaning() +
      roots +
      '<div class="en-actions"><button class="en-btn ghost" data-en-action="mark-known">这个词我已经会了</button></div>' +
      "</div>" +
      renderExtrasCard(word)
    );
  }

  function renderNotebook() {
    var data = view.notebook || null;
    var words = (data && data.words) || [];

    // 手动加词：以前唯一缺的入口（此前只能靠扫描资料自动收）
    var form =
      '<div class="en-card"><p class="en-title">加一个生词</p>' +
      '<div class="en-add-row">' +
      '<input class="en-input" data-en-field="add-word" placeholder="输入英文单词，如 coherent" autocomplete="off" />' +
      '<button class="en-btn primary" data-en-action="add-word">加入</button>' +
      '<button class="en-btn" data-en-action="lookup-word">查词</button></div>' +
      '<div class="en-muted" data-en-lookup>' +
      esc(view.lookup || "不指定词库时收进「自动生词本」，音标与释义会自动补齐。") +
      "</div>" +
      (view.addContext
        ? '<textarea class="en-textarea" style="min-height:58px;margin-top:8px" data-en-field="add-context"' +
          ' placeholder="它在原文里的那句话（可留空）"></textarea>'
        : "") +
      '<button class="en-link" data-en-action="toggle-context">' +
      (view.addContext ? "不带原句了" : "要不要带上原句？") +
      "</button></div>";

    if (view.notebookLoading) {
      return form + '<div class="en-card"><div class="en-muted">正在载入生词本…</div></div>';
    }
    if (!words.length) {
      return (
        form +
        '<div class="en-card"><div class="en-empty">生词本还是空的。<br>' +
        "可以在上面手动加一个词，或去「词库」页扫描资料自动捞生词。</div></div>"
      );
    }

    var rows = words
      .map(function (word) {
        var ctx = (word.contexts || [])[0];
        return (
          '<div class="en-nb-row">' +
          '<div class="en-nb-head">' +
          '<div class="en-nb-word"><b>' +
          esc(word.word || word.lemma) +
          "</b>" +
          '<button class="en-say" data-en-action="say-example" data-say="' +
          esc(word.lemma || word.word) +
          '" title="朗读" aria-label="朗读">🔊</button>' +
          (word.phonetic ? '<span class="en-muted">' + esc(word.phonetic) + "</span>" : "") +
          "</div>" +
          '<button class="en-btn ghost" data-en-action="remove-word" data-word="' +
          esc(word.word_id) +
          '">已会，移出</button>' +
          "</div>" +
          (word.meaning ? '<div class="en-muted">' + esc(word.meaning) + "</div>" : "") +
          (ctx && ctx.text
            ? '<div class="en-ctx" style="margin:6px 0 0">' +
              esc(ctx.text) +
              '<span class="en-ctx-src">' +
              esc(ctx.source_title || "来自你导入的资料") +
              "</span></div>"
            : "") +
          '<div class="en-muted" style="margin-top:4px">加入于 ' +
          (esc(String(word.created_at || "").slice(0, 10)) || "—") +
          (word.reps ? " · 已复习 " + word.reps + " 次" : " · 还没复习过") +
          "</div></div>"
        );
      })
      .join("");

    return (
      form +
      '<div class="en-card"><p class="en-title">生词本 · ' +
      words.length +
      " 词" +
      (data && data.total > words.length ? "（共 " + data.total + "）" : "") +
      "</p>" +
      '<div class="en-muted" style="margin-bottom:8px">按加入时间排序，最近遇到的在最上面；' +
      "「已会，移出」会同时把它标成认识，扫描资料时不再当生词。</div>" +
      rows +
      "</div>"
    );
  }

  function loadNotebook() {
    view.notebookLoading = true;
    render();
    return call(API + "/notebook")
      .then(function (data) {
        view.notebook = data || {};
        view.notebookLoading = false;
        render();
        return null;
      })
      .catch(function (error) {
        view.notebookLoading = false;
        view.error = (error && error.message) || "生词本加载失败";
        render();
      });
  }

  function lookupForAdd() {
    var field = document.querySelector("[data-en-field='add-word']");
    var lemma = field ? String(field.value || "").trim() : "";
    if (!lemma) {
      view.lookup = "先输入一个英文单词。";
      render();
      return;
    }
    view.lookup = "正在查词…";
    render();
    call(API + "/lookup?word=" + encodeURIComponent(lemma))
      .then(function (data) {
        if (data && data.found) {
          var entry = data.entry || {};
          view.lookup =
            (entry.phonetic ? entry.phonetic + "  " : "") +
            (entry.meaning || "（词典里没有这个词的释义）");
        } else {
          view.lookup = "词典里没有「" + lemma + "」，仍可加入（释义会留空）。";
        }
        render();
        return null;
      })
      .catch(function () {
        view.lookup = "查词失败，仍可直接加入。";
        render();
      });
  }

  function addWord() {
    var field = document.querySelector("[data-en-field='add-word']");
    var ctxField = document.querySelector("[data-en-field='add-context']");
    var lemma = field ? String(field.value || "").trim() : "";
    if (!lemma) {
      view.error = "请先输入要加入的词。";
      render();
      return;
    }
    view.busy = true;
    render();
    call(API + "/words", {
      method: "POST",
      body: {
        lemma: lemma,
        context: ctxField ? String(ctxField.value || "").trim() : "",
      },
    })
      .then(function (data) {
        view.busy = false;
        if (field) field.value = "";
        if (ctxField) ctxField.value = "";
        view.lookup = "";
        view.notice =
          data.added > 0
            ? "已把「" +
              lemma +
              "」收进生词本" +
              (data.found_in_dict ? "，词典释义已补齐。" : "；词典里没有它，释义留空，记得自己补。")
            : "「" + lemma + "」已经在生词本里了。";
        return loadNotebook();
      })
      .catch(function (error) {
        view.busy = false;
        view.error = (error && error.message) || "加入失败";
        render();
      });
  }

  function removeWord(wordId) {
    call(API + "/words/" + encodeURIComponent(wordId) + "?known=1", { method: "DELETE" })
      .then(function () {
        view.notice = "已移出生词本，并标记为认识。";
        return loadNotebook();
      })
      .catch(function (error) {
        view.error = (error && error.message) || "移出失败";
        render();
      });
  }

  function renderCandidates() {
    var items = view.candidates || [];
    var head =
      '<div class="en-card"><p class="en-title">待加入的生词</p>' +
      '<div class="en-muted" style="line-height:1.7">按「掌握后能提升多少词覆盖率」排序，' +
      "越靠前越划算。勾选后加入「自动生词本」，每个词都会带上它在原文里的那句话。</div>" +
      '<div class="en-actions">' +
      '<button class="en-btn" data-en-action="pick-all">全选</button>' +
      '<button class="en-btn" data-en-action="pick-none">清空</button>' +
      '<button class="en-btn primary" data-en-action="accept">加入生词本</button>' +
      '<button class="en-btn ghost" data-en-action="dismiss">忽略勾选</button>' +
      "</div></div>";

    if (!items.length) {
      return head + '<div class="en-empty">还没有候选词。<br>去「词库」页扫描当前项目的资料，或换个有英文资料的项目再试。</div>';
    }

    var rows = items
      .map(function (item) {
        var tags = (item.known_tags || []).slice(0, 3).join(" · ");
        return (
          '<label class="en-cand">' +
          '<input type="checkbox" data-en-pick="' +
          esc(item.cand_id) +
          '"' +
          (view.picked[item.cand_id] ? " checked" : "") +
          " />" +
          '<div class="en-cand-main">' +
          '<div class="en-row"><span class="en-cand-word">' +
          esc(item.lemma) +
          (item.phonetic ? ' <span class="en-muted">' + esc(item.phonetic) + "</span>" : "") +
          '</span><span class="en-gain">+' +
          (Number(item.gain || 0) * 100).toFixed(1) +
          "% 覆盖</span></div>" +
          '<div class="en-cand-say">' +
          esc(item.meaning || "（暂无语义，加入后由词典补齐）") +
          "</div>" +
          (item.sample
            ? '<div class="en-cand-sample">“' + esc(item.sample) + "”</div>"
            : "") +
          '<div><span class="en-tag">出现 ' +
          item.freq +
          " 次</span>" +
          (tags ? '<span class="en-tag">' + esc(tags) + "</span>" : "") +
          "</div></div></label>"
        );
      })
      .join("");

    return head + rows;
  }

  function notebookCount() {
    var decks = (view.overview && view.overview.decks) || [];
    var auto = decks.filter(function (deck) {
      return deck.source_kind === "auto";
    });
    return auto.reduce(function (sum, deck) {
      return sum + (deck.word_count || 0);
    }, 0);
  }

  /* 弹顶根因：整块 innerHTML 重写的瞬间旧节点先被移除，滚动容器 scrollHeight≈0，
     浏览器把 scrollTop 钳回 0。真正的滚动容器是**后代**，不是祖先——
     列表/语料滚 `.en-body`，全屏阅读页滚 `.en-reader-body`（祖先里根本没这两层）。
     重写前记下这两个容器的 scrollTop，重写后按 class 找回它们，交互就原地不动了。 */
  function keepScroll() {
    var node = document.getElementById(VIEW_ID);
    if (!node) return [];
    var saved = [];
    [".en-body", ".en-reader-body"].forEach(function (cls) {
      var el = node.querySelector(cls);
      if (el && el.scrollTop > 0) saved.push([cls, el.scrollTop]);
    });
    return saved;
  }

  function restoreScroll(saved) {
    var node = document.getElementById(VIEW_ID);
    if (!node || !saved || !saved.length) return;
    saved.forEach(function (pair) {
      var el = node.querySelector(pair[0]);
      if (el) {
        el.scrollTop = pair[1];
        requestAnimationFrame(function () {
          el.scrollTop = pair[1];
        });
      }
    });
  }

  function render() {
    var node = document.getElementById(VIEW_ID);
    if (!node) return;

    var savedScroll = keepScroll();

    /* 先把出口挂上，再渲染 body。
       原因：语料视图是在下面 body 拼装时被调用的，它要复用 call()/currentProjectId()。
       原先这几个赋值在函数末尾，第一次进语料页时它们还没挂上——语料模块只能走
       自带兜底（能跑，但属于「碰巧能跑」）。挪到最前面，这条依赖就不再靠时序侥幸。 */
    window.enVocabRerender = render;
    window.enVocabReloadOverview = loadOverview;
    window.enVocabSwitchTab = function (t) {
      switchTab(t);
      if (t === "review") loadQueue();
      else if (t === "decks") loadOverview();
    };
  window.enVocabOpenView = openView;
  // 导出关闭：英语词汇视图是盖在 .studio-panel 上的兄弟节点，切到别的功能页时必须收起，
  // 否则它会继续盖住卡片/测验（app.js 的 switchFeature 调这个）。
  window.enVocabCloseView = closeView;
    // 交给语料模块复用：POST 必须在这里补 Content-Type，别让它自己再造一个 fetch 封装
    window.enVocabCall = call;
    window.enVocabProjectId = currentProjectId;
    window.enVocabRerenderVocab = render;
    window.enVocabExpandStudio = ensureStudioExpanded; // 窄轨下的精读入口卡要靠它展开面板

    /* 窄轨标记：应试精读工作台按展开面板宽度设计，收起状态下改渲染入口卡。
       必须在拼 body 之前设好——精读的 render() 在这里被同步调用。 */
    window.__enStudioNarrow = !isStudioExpanded();

    var tabs = [
      ["corpus", "📄 语料", 0],
      ["decks", "词库", 0],
      // 角标说的是「现在能刷几个」，不是 stats.due（后者把未学新词算成到期，会虚高）
      ["review", "复习", view.overview && view.overview.stats ? reviewAvailability().more : 0],
      ["notebook", "生词本", view.overview ? notebookCount() : 0],
      ["candidates", "待加入", view.overview ? view.overview.candidate_count : 0],
      ["exam", "🎯 考研精读", 0],
    ]
      .map(function (tab) {
        return (
          '<button class="en-tab' +
          (view.tab === tab[0] ? " active" : "") +
          '" data-en-tab="' +
          tab[0] +
          '">' +
          tab[1] +
          (tab[2] ? '<span class="en-count">' + tab[2] + "</span>" : "") +
          "</button>"
        );
      })
      .join("");

    var stats = (view.overview && view.overview.stats) || {};
    var meta = view.overview
      ? "今日 " + (stats.reviewed_today || 0) + " 词 · 连续 " + (stats.streak_days || 0) + " 天"
      : "正在加载…";
    var body = "";
    if (view.error) body += '<div class="en-note error">' + esc(view.error) + "</div>";
    if (view.notice && !view.error) body += '<div class="en-note">' + esc(view.notice) + "</div>";
    if (view.tab === "corpus") {
      // 语料视图由独立模块渲染（自带样式与状态），这里只负责给它一块地方
      body += (window.KnowOriginCorpus
        ? window.KnowOriginCorpus.render()
        : '<div class="en-note">正在加载语料摘录...</div>');
    } else if (view.tab === "decks") body += renderDecks();
    else if (view.tab === "review") {
      body += renderReview();
      // 自动朗读：放在渲染之后，用词 id 去重，重渲染（如预览回填）不会重复念
      if (view.queue.length) maybeAutoSpeak(view.queue[view.index]);
    } else if (view.tab === "notebook") body += renderNotebook();
    else if (view.tab === "exam") {
      body += (window.KnowOriginExam ? window.KnowOriginExam.render() : '<div class="en-note">正在加载应试精读工作台...</div>');
    }
    else body += renderCandidates();

    var expanded = isStudioExpanded();
    var expandBtnText = expanded ? "⤢ 收起" : "⤢ 展开";
    var expandBtnTitle = expanded ? "收起面板（Esc）" : "展开面板";

    node.innerHTML =
      '<div class="en-head">' +
      '<button class="en-btn en-back" data-en-action="en-back" title="回到学习产出">‹ 返回</button>' +
      '<div class="en-tabs">' +
      tabs +
      '</div><span class="en-head-meta">' +
      esc(meta) +
      "</span>" +
      '<button class="en-btn en-collapse-btn" data-en-action="en-collapse" title="' + esc(expandBtnTitle) + '">' + esc(expandBtnText) + '</button>' +
      "</div>" +
      '<div class="en-body">' +
      body +
      "</div>";
    view.shownAt = Date.now();
    restoreScroll(savedScroll);
  }

  /* ------------------------------------------------------------ 交互 */

  function switchTab(tab) {
    if (view.tab === tab) return;
    view.tab = tab;
    view.error = "";
    view.notice = "";
    if (tab === "exam") {
      // 精读工作台是宽屏设计：从窄轨点进来直接展开面板，别让用户看到挤碎的布局
      ensureStudioExpanded();
      render();
    }
    else if (tab === "review" && !view.queue.length) loadQueue();
    else if (tab === "candidates" && !view.candidates.length) loadCandidates();
    else if (tab === "notebook") loadNotebook();
    else if (tab === "corpus" && window.KnowOriginCorpus) window.KnowOriginCorpus.refresh();
    else render();
  }

  /* 「导入自己的词表」已于 2026-09-26 移除。
     理由：它鼓励用户从别处抄一份通用词书进来，而产品的主张恰恰相反——
     词该从你自己正在读的资料里来。抄来的词书没有语境，背完也不知道它
     出现在你哪份资料里；而资料里摘的词自带「你是在哪被它绊住的」。
     留着这个入口只会把用户引回老路，所以整个删掉（含后端 kind=import 分支）。 */

  function addBuiltin(deckId) {
    view.busy = true;
    render();
    call(API + "/decks", { method: "POST", body: { kind: "builtin", deck_id: deckId } })
      .then(function (data) {
        view.busy = false;
        view.notice = data.created ? "已加入 " + data.added + " 个词。" : "这个词表已经在你的词库里了。";
        return loadOverview();
      })
      .catch(function (error) {
        view.busy = false;
        view.error = (error && error.message) || "加入失败";
        render();
      });
  }

  function deleteDeck(deckId) {
    call(API + "/decks/" + encodeURIComponent(deckId), { method: "DELETE" })
      .then(function () {
        view.notice = "已删除词库。";
        return loadOverview();
      })
      .catch(function (error) {
        view.error = (error && error.message) || "删除失败";
        render();
      });
  }

  /* 扫描走 SSE：逐份资料推进度，让用户看得见它在动 */
  function scanProject() {
    var projectId = currentProjectId();
    if (!projectId) {
      view.error = "请先在左侧选择一个项目。";
      render();
      return;
    }
    view.scan = "正在扫描…";
    view.error = "";
    render();

    fetch(API + "/scan", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId }),
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
              var event;
              try {
                event = JSON.parse(line.slice(5).trim());
              } catch (e) {
                return;
              }
              handleScanEvent(event);
            });
            return pump();
          });
        }
        return pump();
      })
      .catch(function (error) {
        view.scan = "";
        view.error = (error && error.message) || "扫描失败";
        render();
      });
  }

  function handleScanEvent(event) {
    if (event.type === "start") {
      view.scan = event.total ? "共 " + event.total + " 份资料，开始扫描…" : "这个项目还没有导入资料。";
    } else if (event.type === "progress") {
      var suffix = event.skipped
        ? "（已扫过，跳过）"
        : "覆盖率 " + pct(event.coverage) + "，发现 " + (event.found || 0) + " 个生词";
      view.scan = "[" + event.current + "/" + event.total + "] " + (event.title || "") + " " + suffix;
    } else if (event.type === "done") {
      view.scan = event.pending
        ? "扫描完成，共有 " + event.pending + " 个生词待确认。"
        : "扫描完成，这次没有新增生词。";
      view.notice = view.scan;
      view.scan = "";
      loadCandidates().then(loadOverview);
      return;
    } else if (event.type === "error") {
      view.error = event.message || "扫描出错";
      view.scan = "";
    }
    render();
  }

  function acceptCandidates() {
    var ids = Object.keys(view.picked).filter(function (key) {
      return view.picked[key];
    });
    if (!ids.length) {
      view.error = "请先勾选要加入的词。";
      render();
      return;
    }
    call(API + "/candidates/accept", { method: "POST", body: { cand_ids: ids } })
      .then(function (data) {
        view.notice = "已把 " + data.added + " 个词加入「自动生词本」，带上原文语境。";
        return loadCandidates().then(loadOverview);
      })
      .catch(function (error) {
        view.error = (error && error.message) || "加入失败";
        render();
      });
  }

  function dismissCandidates() {
    var ids = Object.keys(view.picked).filter(function (key) {
      return view.picked[key];
    });
    if (!ids.length) {
      view.error = "请先勾选要忽略的词。";
      render();
      return;
    }
    call(API + "/candidates/dismiss", { method: "POST", body: { cand_ids: ids } })
      .then(function (data) {
        view.notice = "已忽略 " + data.dismissed + " 个词，之后不会再冒出来。";
        return loadCandidates().then(loadOverview);
      })
      .catch(function (error) {
        view.error = (error && error.message) || "忽略失败";
        render();
      });
  }

  function markKnown() {
    var word = view.queue[view.index];
    if (!word) return;
    call(API + "/known", { method: "POST", body: { lemma: word.lemma, known: true } })
      .then(function () {
        view.notice = "记住了，之后不再按生词处理。";
        view.queue.splice(view.index, 1);
        if (view.index >= view.queue.length) view.index = Math.max(0, view.queue.length - 1);
        view.extrasOpen = false;
        view.answerShown = false;
        view.showFullMeaning = false;
        view.spokenFor = "";
        view.spellInput = "";
        view.spellResult = "";
        render();
        return null;
      })
      .catch(function (error) {
        view.error = (error && error.message) || "操作失败";
        render();
      });
  }

  function onClick(event) {
    var target = event.target;
    var sayItem = target.closest ? target.closest("[data-say]") : null;
    if (sayItem && (!target.closest("[data-en-action]") || sayItem.classList.contains("en-chip") || sayItem.classList.contains("en-story-word"))) {
      event.preventDefault();
      speak(sayItem.getAttribute("data-say") || "");
      return;
    }

    var button = target.closest ? target.closest("[data-en-action], [data-en-tab], [data-en-entry]") : null;
    if (!button) return;

    if (button.hasAttribute("data-en-entry")) {
      event.preventDefault();
      event.stopPropagation();
      openView();
      return;
    }
    if (button.hasAttribute("data-en-tab")) {
      event.preventDefault();
      switchTab(button.getAttribute("data-en-tab"));
      return;
    }
    var action = button.getAttribute("data-en-action");
    if (!action) return;
    event.preventDefault();
    if (action === "go-review") switchTab("review");
    else if (action === "go-decks") {
      view.roundFinished = false;
      switchTab("decks");
    }
    else if (action === "go-candidates") switchTab("candidates");
    else if (action === "en-back") closeView();
    else if (action === "en-collapse") {
      if (isStudioExpanded()) {
        try {
          if (typeof collapseStudio === "function") collapseStudio();
          else {
            var expBtn = document.getElementById("studio-expand-button");
            if (expBtn) expBtn.click();
          }
        } catch (e) {}
      } else {
        ensureStudioExpanded(button);
      }
      setTimeout(render, 350);
    }
    else if (action === "open-extras") loadExtras();
    else if (action === "reload-queue") startNewRound();
    else if (action === "extra-new") startNewRound(Number(button.getAttribute("data-count")) || 10);
    else if (action === "finish-round") finishRound();
    else if (action === "new-round") startNewRound();
    else if (action === "gen-story") generateRoundStory();
    else if (action === "speak-story") toggleSpeakStory();
    else if (action === "toggle-story-zh") {
      view.storyShowZh = !view.storyShowZh;
      render();
    }
    else if (action === "copy-story") copyStory();
    else if (action === "toggle-story-mode") {
      view.storyMode = view.storyMode === "cloze" ? "read" : "cloze";
      render();
    }
    else if (action === "cloze-hint") {
      var hintWord = button.getAttribute("data-cloze-word");
      if (hintWord) {
        if (!view.clozeRevealed) view.clozeRevealed = {};
        view.clozeRevealed[hintWord.toLowerCase()] = true;
        render();
      }
    }
    else if (action === "view-history-story") {
      var sId = button.getAttribute("data-story-id");
      var archiveList = loadStoryArchive();
      var targetStory = archiveList.filter(function (it) { return it.id === sId; })[0];
      if (targetStory) {
        view.story = targetStory;
        view.storyMode = "read";
        view.clozeAnswers = {};
        view.clozeRevealed = {};
        view.roundWords = (targetStory.words || []).map(function (w) {
          return { word: w, lemma: w, meaning: "往期故事收录词", rating: 4 };
        });
        view.roundFinished = true;
        switchTab("review");
      }
    }
    else if (action === "rate") submitRating(Number(button.getAttribute("data-rating")));
    else if (action === "show-answer") {
      view.answerShown = true;
      loadExtras(); // 展开释义时顺手把拓展准备好（有缓存就不花模型调用）
    } else if (action === "say-word") {
      var current = view.queue[view.index] || {};
      speak(current.lemma || current.word || "");
    } else if (action === "say-example") {
      speak(button.getAttribute("data-say") || "");
    } else if (action === "toggle-speak") {
      view.autoSpeak = !view.autoSpeak;
      writeAutoSpeak(view.autoSpeak);
      view.spokenFor = ""; // 刚打开时允许立刻朗读当前词
      render();
      if (view.autoSpeak) {
        var nowWord = view.queue[view.index] || {};
        speak(nowWord.lemma || nowWord.word || "");
      } else if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    } else if (action === "toggle-spell") toggleSpell();
    else if (action === "spell-check") checkSpelling();
    else if (action === "toggle-full-meaning") {
      view.showFullMeaning = !view.showFullMeaning;
      render();
    } else if (action === "prefill-extras") prefillExtras();
    else if (action === "add-word") addWord();
    else if (action === "lookup-word") lookupForAdd();
    else if (action === "toggle-context") {
      view.addContext = !view.addContext;
      render();
    } else if (action === "remove-word") removeWord(button.getAttribute("data-word"));
    else if (action === "mark-known") markKnown();
    else if (action === "add-builtin") addBuiltin(button.getAttribute("data-deck"));
    else if (action === "del-deck") deleteDeck(button.getAttribute("data-deck"));
    else if (action === "filter-deck") openFilterDeck(button.getAttribute("data-deck"));
    else if (action === "filter-close") {
      view.filterDeck = null;
      render();
    } else if (action === "filter-do") doFilterKnown();
    else if (action === "toggle-builtin") {
      // 内置词表已降级为兜底入口，默认收起：主推的是「从我的资料里采词」
      view.showBuiltin = !view.showBuiltin;
      render();
    } else if (action === "scan") scanProject();
    else if (action === "pick-all") {
      view.candidates.forEach(function (item) {
        view.picked[item.cand_id] = true;
      });
      render();
    } else if (action === "pick-none") {
      view.picked = {};
      render();
    } else if (action === "accept") acceptCandidates();
    else if (action === "dismiss") dismissCandidates();
  }

  function onChange(event) {
    var target = event.target;
    if (target && target.hasAttribute && target.hasAttribute("data-en-pick")) {
      view.picked[target.getAttribute("data-en-pick")] = target.checked;
    }
  }

  function onInput(event) {
    var target = event.target;
    if (target && target.classList && target.classList.contains("en-spell-input")) {
      view.spellInput = target.value || "";
    }
    if (target && target.classList && target.classList.contains("en-cloze-input")) {
      var wordKey = target.getAttribute("data-cloze-word");
      if (!wordKey) return;
      var val = target.value || "";
      if (!view.clozeAnswers) view.clozeAnswers = {};
      view.clozeAnswers[wordKey.toLowerCase()] = val;
      if (normClozeAnswer(val) === normClozeAnswer(wordKey)) {
        target.classList.add("is-correct");
        speak(val.trim());
        setTimeout(function () {
          render();
        }, 320);
      }
    }
  }

  function onKeydown(event) {
    var node = document.getElementById(VIEW_ID);
    if (!node || node.classList.contains("hidden")) return;
    if (event.key === "Escape") {
      closeView();
      return;
    }
    if (view.tab !== "review") return;
    if (event.target && /INPUT|TEXTAREA/.test(event.target.tagName)) {
      if (event.target.classList.contains("en-spell-input") && event.key === "Enter") {
        event.preventDefault();
        checkSpelling();
      }
      return;
    }

    if (view.roundFinished || !view.queue.length) {
      if (event.key === "Enter") {
        event.preventDefault();
        startNewRound();
      }
      return;
    }

    var map = { "1": 1, "2": 2, "3": 3, "4": 4 };
    if (map[event.key]) {
      event.preventDefault();
      submitRating(map[event.key]);
    } else if (event.key === " ") {
      event.preventDefault();
      if (!view.answerShown) {
        view.answerShown = true;
        loadExtras();
        render();
      } else {
        var current = view.queue[view.index] || {};
        speak(current.lemma || current.word || "");
      }
    }
  }

  /* ------------------------------------------------------------ 启动 */

  function boot() {
    ensureStyle();
    ensureButton();
    ensureView();

    /* 面板展开/收起时（app.js 给 body 加摘 studio-focus-open），精读页签要跟着
       在「完整工作台 / 窄轨入口卡」之间切换。收起可能不经过本模块的按钮
       （比如点遮罩），靠这个观察器兜住，窄标变化才重渲染，不会成环。 */
    try {
      new MutationObserver(function () {
        var node = document.getElementById(VIEW_ID);
        if (!node || node.classList.contains("hidden")) return;
        if (view.tab !== "exam") return;
        var narrow = !document.body.classList.contains("studio-focus-open");
        if (!!window.__enStudioNarrow !== narrow) render();
      }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
    } catch (e) { /* 老内核没有 MutationObserver 就退回手动路径 */ }

    // Chrome 首次 getVoices() 常返回空数组，语音列表是异步就绪的
    try {
      if (window.speechSynthesis) {
        window.speechSynthesis.onvoiceschanged = function () {
          pickVoice();
        };
        pickVoice();
      }
    } catch (e) {
      /* 没有 TTS 就只是没有声音 */
    }

    document.addEventListener("click", onClick, false);
    document.addEventListener("change", onChange, false);
    document.addEventListener("input", onInput, false);
    document.addEventListener("keydown", onKeydown, false);

    // 捕获阶段拦下其它功能页签的点击：用户切走时把我们的覆盖层收起来。
    // 用捕获是为了比 app.js 的元素级 handler 更早拿到事件。
    document.addEventListener(
      "click",
      function (event) {
        var target = event.target;
        if (!target || !target.closest) return;
        var other = target.closest(".feature-button[data-feature]");
        if (other) closeView();
      },
      true
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
