/* 知源 · 英语应试精读与自动化备考引擎（static/english-exam-ui.js）
   ============================================================
   升级特性：
     1. 13 大权威母源期刊全谱系（经济学人、卫报、大西洋月刊、科学美国人、自然系列、科学、
        基督教科学箴言报、MIT科技评论、华盛顿邮报、纽约时报、哈佛商业评论、BBC未来视野、全国统考原卷）；
     2. 海量文章多维实时检索（按期刊、按主题、按难度、关键词即时过滤搜索）；
     3. 整篇通读与段落显微镜级深度分析两层视图（Full Passage & Paragraph-by-Paragraph Analysis）；
     4. 田静长难句手术刀（结构化剥离从句修饰，秒提主谓宾极简骨架）；
     5. 唐迟「阅读的逻辑」：同义改写链自动萃取、FSRS 一键入库；
     6. 熟词生义雷达：160+ 高频熟词僻义自动预警；
     7. 全局深浅主题变量无缝适配，完全遵循知源长期记忆与变量规范。
   ============================================================ */
(function () {
  "use strict";

  var STYLE_ID = "en-exam-style";
  var API = "/api/en/exam";

  /* ------------------------------------------------------------ 离线期刊全谱系与文章数据兜底 */

  var DEFAULT_JOURNALS = [
    {
      id: "j_economist",
      name: "The Economist (经济学人)",
      en_name: "The Economist",
      badge: "考研头号题源 · 宏观政经与商业科技",
      stars: "★★★★★",
      weight_score: 98,
      style_description: "考研英语(一)首选题源；文笔辛辣反讽，长难句多层嵌套，自由市场立场鲜明。",
      article_count: 2
    },
    {
      id: "j_guardian",
      name: "The Guardian (英国卫报)",
      en_name: "The Guardian",
      badge: "英二高频榜首 · 社会民生与职场生态",
      stars: "★★★★★",
      weight_score: 95,
      style_description: "英国老牌报纸；洋葱式由浅入深行文，语言平实易懂，观点温和直白。",
      article_count: 1
    },
    {
      id: "j_atlantic",
      name: "The Atlantic (大西洋月刊)",
      en_name: "The Atlantic",
      badge: "近五年考研新宠 · 深度人文与社会反思",
      stars: "★★★★☆",
      weight_score: 92,
      style_description: "深度综合文化杂志；文章结构极度标准（引入现象 ➔ 剖析利弊 ➔ 总结反思）。",
      article_count: 1
    },
    {
      id: "j_sciam",
      name: "Scientific American (科学美国人)",
      en_name: "Scientific American",
      badge: "科技说明文基石 · 前沿科普与气候生态",
      stars: "★★★★★",
      weight_score: 94,
      style_description: "考研科技类文章固定来源；遵循「现象 ➔ 研究 ➔ 结论」说明文框架。",
      article_count: 1
    },
    {
      id: "j_nature",
      name: "Nature & Nature Series (自然系列)",
      en_name: "Nature / Nature Neuroscience",
      badge: "国际顶尖学术 · 硬核科学与神经认知",
      stars: "★★★★★",
      weight_score: 96,
      style_description: "殿堂级科学期刊；学术客观性极强，长难句多为介词短语嵌套与复杂同位语。",
      article_count: 1
    },
    {
      id: "j_science",
      name: "Science (美国科学)",
      en_name: "Science",
      badge: "全学科领军综合 · 系统地球科学",
      stars: "★★★★★",
      weight_score: 96,
      style_description: "美国科学促进会出版顶刊；探讨重大科学发现对公共政策的深远投射。",
      article_count: 1
    },
    {
      id: "j_csmonitor",
      name: "The Christian Science Monitor (基督教科学箴言报)",
      en_name: "The Christian Science Monitor",
      badge: "考研隐形冠军 · 数据与故事混搭",
      stars: "★★★★☆",
      weight_score: 90,
      style_description: "真题历史上出现频次极高的低调母源；擅长从小人物故事切入宏观制度变迁。",
      article_count: 1
    },
    {
      id: "j_mit_tr",
      name: "MIT Technology Review (麻省理工科技评论)",
      en_name: "MIT Technology Review",
      badge: "新锐科技黑马 · 算法伦理与前沿工程",
      stars: "★★★★☆",
      weight_score: 93,
      style_description: "全球最著名的技术商业杂志；重点揭示前沿数字技术的伦理与环境代价。",
      article_count: 1
    },
    {
      id: "j_washington_post",
      name: "The Washington Post (华盛顿邮报)",
      en_name: "The Washington Post",
      badge: "社论深度调查 · 政策法规与公共利益",
      stars: "★★★★☆",
      weight_score: 91,
      style_description: "美国权威大报；长于政府监管、反垄断政策、劳工权益与司法争端。",
      article_count: 1
    },
    {
      id: "j_nytimes",
      name: "The New York Times (纽约时报)",
      en_name: "The New York Times",
      badge: "文化观察名篇 · 专栏Op-Ed与时代思潮",
      stars: "★★★★☆",
      weight_score: 93,
      style_description: "文化与思想界风向标；语言讲究修辞与隐喻，长难句多含典故与多重视角辩难。",
      article_count: 1
    },
    {
      id: "j_hbr",
      name: "Harvard Business Review (哈佛商业评论)",
      en_name: "Harvard Business Review",
      badge: "商业决策智囊 · 组织行为与管理洞察",
      stars: "★★★★★",
      weight_score: 94,
      style_description: "考研英语(二)命题母池；职场心理学、企业管理模式、领导力与创新转型。",
      article_count: 1
    },
    {
      id: "j_bbc_future",
      name: "BBC Future (未来视野)",
      en_name: "BBC Future",
      badge: "现代心理学与深度思考 · 认知科学",
      stars: "★★★★☆",
      weight_score: 89,
      style_description: "深度智识专栏；探讨数字化时代人类注意力破碎化、睡眠习惯与心智韧性。",
      article_count: 1
    },
    {
      id: "j_official_ky",
      name: "全国统考真题官方原卷",
      en_name: "National Graduate Entrance Exam",
      badge: "教育部命题委员会 · 统考原卷",
      stars: "★★★★★",
      weight_score: 100,
      style_description: "全国硕士研究生招生考试官方真题精选原卷；阅读理解与命题专家心机对决实战靶场。",
      article_count: 1
    }
  ];

  /* ------------------------------------------------------------ 内部状态 */

  var examView = {
    subTab: "reading", // "reading" | "syntax" | "paraphrase" | "radar"
    loading: false,
    error: "",
    notice: "",

    // 母源期刊与海量文章实时检索
    journalsCatalog: DEFAULT_JOURNALS,
    selectedJournalId: "all", // "all" 或具体的 j_economist 等
    selectedTopicCategory: "all",
    articleSearchQuery: "",
    articlesList: [],
    selectedArticleId: "economist_ai_paradox",

    // 当前研读篇章详情（含整文 + paragraphs 逐段解析）
    activeReading: null,
    readingViewMode: "original", // "original" (默认状态: 只保留英文原文，无分析) | "both" (整篇+逐段深度分析) | "paragraphs" (纯逐段显微镜)
    readingShowZh: false,
    // 独立阅读页开关：点文章后整页切入正文，而不是把正文拼在文章列表下面。
    // 拼在下面意味着用户要先滚过「检索框 + 13 刊胶囊 + 整个文章瀑布流」才看到原文，
    // 实测这是最劝退的一步。关掉即回到列表。
    readerOpen: false,
    selectedAnswer: "",
    collapsedParagraphs: {}, // pIndex -> boolean
    customToolsOpen: false,

    // 辅助工具与抓取
    fetchUrl: "https://www.economist.com/leaders/2024/02/the-ai-productivity-paradox",
    genTopic: "人工智能与生产率悖论",
    genStyle: "考研真题",
    genLevel: "考研英语(一)",

    // 长难句手术刀
    sentenceInput: "",
    syntaxResult: null,
    collapsedParts: {}, // 成分下标 -> 是否折叠（只对 can_collapse 的修饰成分生效）
    syntaxFocus: null, // 当前聚焦的成分下标，null = 不聚焦、全部正常显示

    // 同义替换提取与已存库追踪
    paraSource: "",
    paraExam: "",
    paraResult: null,
    savedPairs: [],
    savedParaphraseIds: {},

    // 熟词生义雷达
    radarQuery: "",
    radarResults: null,

    // 联网实时检索（纯联网语料层，默认开启 —— 本地不落地大语料，降低启动成本）
    onlineMode: true,
    onlineSources: [],
    onlineSourceId: "all",
    onlineTopic: "all",
    onlineQuery: "",
    onlineList: [],
    onlineStats: null,
    onlineLoading: false,
    quickstartList: [], // 已废弃 UI，字段仅为兼容旧存档视图状态，不再写入
    onlineArticle: null,
    readingFontSize: 17, // 精读正文字号(px)，与文献阅读共用一套「自己调舒服」的思路

    // 划词交互：高亮笔记 + 选区动作
    highlights: [],
    hlEditingId: "", // 正在展开笔记编辑框的高亮 id
    hlDraft: "", // 笔记草稿（编辑中）
    hlBusy: false,
    sel: null, // { text, paraIndex, prefix, suffix, x, y }
    selBusy: "", // 正在执行的选区动作名，用于按钮转圈与防重复点击
    selResult: null, // 选区动作的结果卡 { kind, title, ... }
    selToast: "", // 顶部一闪而过的提示（如「已加入生词本」）

    // 右侧分析抽屉
    sideOpen: false,
    sideTab: "notes", // notes | collocations | argument | false-friends
    side: null, // { collocations: [], argument: {...} }
    sideBusy: false,
    sideError: "",

    // 同义改写（单句 → 多版本），与上面「原文句 × 选项句」的成对萃取并存
    rewriteSentence: "",
    rewriteResult: null,
    rewriteBusy: false,

    // ---- 写作提分（把博主讲的模板/句型/替换词/纠错做成随手可用的工具）----
    writingKit: null,
    writingKitLoading: false,
    writingTopic: "",
    writingDraft: "",
    writingTemplateId: "tpl_phenomenon",
    writingToolTab: "sentence", // sentence | upgrade | transition | chinglish | rubric
    writingCheck: null, // 规则体检报告
    writingPolish: null, // 模型升格报告
    writingBusy: "", // "check" | "polish"
    writingError: "",

    // ---- 翻译提分（三步法引导 + 文化词表 + 译文体检）----
    translationKit: null,
    translationKitLoading: false,
    translationSource: "",
    translationTarget: "",
    translationPanelTab: "guide", // guide | check | culture
    translationGuide: null,
    translationCheck: null,
    translationBusy: "",
    translationError: "",
    cultureCat: "全部",
    cultureQuery: "",
    cultureQueryDraft: "",
    // 「按标签演示」当前选中的标签（空 = 随机）
    translationDemoCategory: "",
    // 术语便签：翻译时点文化词卡片攒下来的标准译法，写译文时对着抄
    translationTerms: [],

    // AI 演示历史记录（自动留存，可回看 / 载入 / 删除）
    writingHistory: [],
    writingHistoryLoaded: false,
    writingHistoryLoading: false,
    translationHistory: [],
    translationHistoryLoaded: false,
    translationHistoryLoading: false,
  };

  // 精读正文字号偏好：和文献阅读一样落 localStorage，下次打开还是你调过的那个大小
  var READ_SIZE_KEY = "knoworigin-en-read-fontsize";
  var READ_SIZE_MIN = 14;
  var READ_SIZE_MAX = 24;

  /* 字号偏好：只写一个 --en-read-size 到根节点，正文两处
     (.en-read-surface / .en-online-passage) 都读这个变量，改一处就整体生效。 */
  function readSizeClamp(px) {
    var n = Number(px);
    if (!n || isNaN(n)) n = 17;
    return Math.min(READ_SIZE_MAX, Math.max(READ_SIZE_MIN, Math.round(n)));
  }

  function readSizeApply() {
    examView.readingFontSize = readSizeClamp(examView.readingFontSize);
    document.documentElement.style.setProperty("--en-read-size", examView.readingFontSize + "px");
  }

  function readSizeLoad() {
    try {
      var saved = window.localStorage.getItem(READ_SIZE_KEY);
      if (saved !== null && saved !== "") {
        examView.readingFontSize = readSizeClamp(parseInt(saved, 10));
      }
    } catch (_) {
      // 隐私模式下 localStorage 会抛异常，用默认字号继续就好
    }
    readSizeApply();
  }

  function readSizeStep(delta) {
    examView.readingFontSize = readSizeClamp(examView.readingFontSize + delta);
    readSizeApply();
    try {
      window.localStorage.setItem(READ_SIZE_KEY, String(examView.readingFontSize));
    } catch (_) {}
    if (window.enVocabRerender) window.enVocabRerender();
    refocusReadSize(delta);
  }

  /* 整个精读视图是「每次交互重写 innerHTML」的，所以点一下按钮焦点就掉回 body。
     字号是要连点好几下的控件，掉焦点对键盘用户等于每调一格都要重新 Tab 一遍，
     这里把焦点放回去。已经调到顶/底时按钮会变灰、没法聚焦，
     就退到同组另一个还能按的按钮上，免得焦点直接飞出工具条。 */
  function refocusReadSize(delta) {
    requestAnimationFrame(function () {
      var group = document.querySelector(".en-read-tools");
      if (!group) return;
      var want = group.querySelector('[data-delta="' + delta + '"]');
      if (want && !want.disabled) {
        want.focus();
        return;
      }
      var other = group.querySelector("button:not([disabled])");
      if (other) other.focus();
    });
  }

  function readToolsHtml() {
    var atMin = examView.readingFontSize <= READ_SIZE_MIN;
    var atMax = examView.readingFontSize >= READ_SIZE_MAX;
    return (
      '<div class="en-read-tools" role="group" aria-label="正文字号">' +
      '<button type="button" data-en-exam-action="set-read-fontsize" data-delta="-1"' +
      (atMin ? ' disabled aria-disabled="true"' : "") +
      ' title="缩小正文字号" aria-label="缩小正文字号">A-</button>' +
      '<span class="v" aria-live="polite" title="当前正文字号">' + examView.readingFontSize + '</span>' +
      '<button type="button" data-en-exam-action="set-read-fontsize" data-delta="1"' +
      (atMax ? ' disabled aria-disabled="true"' : "") +
      ' title="放大正文字号" aria-label="放大正文字号">A+</button>' +
      "</div>"
    );
  }

  /* 独立阅读页的外壳：顶栏固定在页首，正文在自己那层里滚动。
     用 position:fixed 而不是在面板内排版，是因为 .studio-panel 只有 278/1230 × 539px
     且 overflow:hidden——正文塞在面板里必然又变成「小窗口里滚半天」。
     z-index 取 1500，必须高于 .studio-panel.studio-focus 的 80，否则展开工作室时
     阅读页会被面板整个盖住（划词浮层再往上抬到 1560+，见样式表）。 */
  function readerShell(barHtml, bodyHtml) {
    return (
      '<div class="en-reader-overlay' + (examView.sideOpen ? " has-side" : "") + '" role="dialog" aria-label="文章阅读页">' +
      barHtml +
      '<div class="en-reader-body">' +
      bodyHtml +
      '</div>' +
      '</div>'
    );
  }

  /* 换篇之后把阅读页自己的滚动条拉回顶部。
     用 scrollIntoView 是不行的——它会连带滚动外层容器，把工作台面板也拽走。 */
  function scrollReaderTop() {
    setTimeout(function () {
      var body = document.querySelector(".en-reader-body");
      if (body) body.scrollTop = 0;
    }, 60);
  }

  /* ------------------------------------------------------------ 样式注入 */

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent =
      ".en-exam-wrap { display: flex; flex-direction: column; gap: 14px; padding: 4px 0 20px; font-size: calc(13px * var(--font-scale, 1)); color: var(--ink); }" +
      ".en-exam-nav { display: flex; gap: 8px; border-bottom: 1px solid var(--line); padding-bottom: 10px; margin-bottom: 6px; overflow-x: auto; }" +
      ".en-exam-nav-btn { background: var(--panel); border: 1px solid var(--line); color: var(--muted); border-radius: 6px; padding: 6px 12px; font-size: calc(12px * var(--font-scale, 1)); cursor: pointer; transition: all 0.15s ease; white-space: nowrap; }" +
      ".en-exam-nav-btn:hover { color: var(--ink); border-color: var(--muted); }" +
      ".en-exam-nav-btn.active { background: var(--ink); color: var(--panel); border-color: var(--ink); font-weight: 500; }" +

      ".en-exam-card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }" +
      ".en-exam-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }" +
      ".en-exam-title { font-size: calc(14px * var(--font-scale, 1)); font-weight: 600; color: var(--ink); display: flex; align-items: center; gap: 8px; }" +
      ".en-exam-desc { font-size: calc(12px * var(--font-scale, 1)); color: var(--muted); line-height: 1.5; }" +

      ".en-exam-textarea { width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.03); border: 1px solid var(--line); border-radius: 8px; color: var(--ink); font-family: var(--font-mono, monospace); font-size: calc(13px * var(--font-scale, 1)); line-height: 1.6; padding: 10px 12px; min-height: 72px; resize: vertical; outline: none; transition: border-color 0.2s; }" +
      ".en-exam-textarea:focus { border-color: var(--ink); }" +

      ".en-exam-actions { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }" +
      ".en-exam-btn { background: var(--ink); color: var(--panel); border: none; border-radius: 6px; padding: 6px 14px; font-size: calc(12px * var(--font-scale, 1)); font-weight: 500; cursor: pointer; transition: opacity 0.15s ease; display: inline-flex; align-items: center; gap: 4px; }" +
      ".en-exam-btn:hover { opacity: 0.88; }" +
      ".en-exam-btn.sec { background: transparent; border: 1px solid var(--line); color: var(--ink); }" +
      ".en-exam-btn.sec:hover { background: rgba(128,128,128,0.08); }" +
      ".en-exam-btn.warn { background: var(--gold, #e6a23c); color: #000; }" +

      /* 13 大母源期刊全谱系交互区 */
      ".en-search-hero { display: flex; flex-direction: column; gap: 12px; background: rgba(0,0,0,0.015); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }" +
      ".en-search-bar { display: flex; gap: 8px; align-items: center; width: 100%; }" +
      ".en-search-input { flex: 1; height: 36px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 0 12px; font-size: calc(13px * var(--font-scale, 1)); color: var(--ink); outline: none; transition: all 0.2s; }" +
      ".en-search-input:focus { border-color: var(--ink); box-shadow: 0 0 0 2px rgba(128,128,128,0.15); }" +

      /* 期冠胶囊滚动条 */
      ".en-journal-capsules { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; scrollbar-width: thin; -webkit-overflow-scrolling: touch; }" +
      ".en-journal-pill { background: var(--panel); border: 1px solid var(--line); border-radius: 20px; padding: 5px 12px; font-size: calc(12px * var(--font-scale, 1)); cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; transition: all 0.15s ease; }" +
      ".en-journal-pill:hover { border-color: var(--muted); background: rgba(128,128,128,0.06); }" +
      ".en-journal-pill.active { background: var(--ink); color: var(--panel); border-color: var(--ink); font-weight: 600; box-shadow: 0 2px 6px rgba(0,0,0,0.12); }" +
      ".en-journal-pill-count { font-size: calc(10px * var(--font-scale, 1)); background: rgba(128,128,128,0.18); padding: 1px 6px; border-radius: 10px; }" +
      ".en-journal-pill.active .en-journal-pill-count { background: var(--panel); color: var(--ink); }" +

      /* 主题类别胶囊 */
      ".en-category-row { display: flex; gap: 6px; overflow-x: auto; align-items: center; padding: 2px 0; }" +
      ".en-cat-btn { background: transparent; border: 1px dashed var(--line); border-radius: 4px; padding: 3px 8px; font-size: calc(11px * var(--font-scale, 1)); color: var(--muted); cursor: pointer; white-space: nowrap; }" +
      ".en-cat-btn:hover { color: var(--ink); border-color: var(--ink); }" +
      ".en-cat-btn.active { background: rgba(64,158,255,0.1); border-color: #409eff; color: #409eff; font-weight: 600; }" +

      /* 海量篇章动态瀑布流书架 */
      /* 结果流不再自己限高滚动：max-height:290px 的内层滚动条把文章挤在
         底下一小条里（嵌套滚动区问题），交给外层整页滚动，用户能一眼扫全。 */
      ".en-article-stream { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 10px; }" +
      ".en-article-item { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; cursor: pointer; display: flex; flex-direction: column; gap: 6px; transition: all 0.15s ease; position: relative; }" +
      ".en-article-item:hover { border-color: var(--muted); transform: translateY(-1px); box-shadow: 0 3px 8px rgba(0,0,0,0.05); }" +
      ".en-article-item.active { border-color: var(--green, #67c23a); background: rgba(103,194,58,0.06); box-shadow: 0 0 0 1.5px var(--green, #67c23a); }" +
      ".en-item-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }" +
      ".en-item-title { font-size: calc(13px * var(--font-scale, 1)); font-weight: 600; color: var(--ink); line-height: 1.4; flex: 1; }" +
      ".en-item-source-badge { font-size: calc(10px * var(--font-scale, 1)); padding: 1px 6px; border-radius: 4px; background: rgba(230,162,60,0.12); color: var(--gold, #e6a23c); white-space: nowrap; font-weight: 500; }" +
      ".en-item-snippet { font-size: calc(12px * var(--font-scale, 1)); color: var(--muted); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }" +
      ".en-item-meta { display: flex; gap: 8px; font-size: calc(11px * var(--font-scale, 1)); color: var(--muted); align-items: center; flex-wrap: wrap; margin-top: auto; padding-top: 4px; border-top: 1px dashed var(--line); }" +

      /* 篇章主研读区 */
      ".en-reading-container { display: flex; flex-direction: column; gap: 14px; margin-top: 4px; }" +
      /* ---- 独立阅读页（考研精读 + 联网车道共用）----
         z-index 1500：必须高于 .studio-panel.studio-focus 的 80，否则展开工作室时
         阅读页会被面板盖住。划词浮层再往上抬到 1560/1570/1580，见下面那三条。 */
      ".en-reader-overlay { position: fixed; inset: 0; z-index: 1500; display: flex; flex-direction: column; background: var(--panel); color: var(--ink); }" +
      ".en-reader-bar { flex: 0 0 auto; display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap; padding: 10px 18px; border-bottom: 1px solid var(--line); background: var(--panel); }" +
      ".en-reader-bar-title { font-size: calc(16px * var(--font-scale, 1)); font-weight: 600; line-height: 1.35; color: var(--ink); }" +
      ".en-reader-bar-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-left: auto; }" +
      /* 正文列宽收到 880px 并居中：太宽一行读不进眼，是阅读页而不是表格页 */
      ".en-reader-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 20px max(16px, calc((100% - 880px) / 2)) 72px; }" +
      "@media (max-width: 760px) { .en-reader-bar { padding: 10px 12px; } .en-reader-bar-actions { margin-left: 0; width: 100%; } .en-reader-body { padding: 14px 12px 56px; } }" +
      /* 抽屉一开，顶栏与正文一起让出右侧抽屉那一条：否则抽屉正好压住居中正文列的
         右半边，一边读一边被挡。窄屏腾不出这么多宽度，就维持覆盖式抽屉。 */
      ".en-reader-overlay.has-side { padding-right: min(400px, 92vw); }" +
      "@media (max-width: 860px) { .en-reader-overlay.has-side { padding-right: 0; } }" +
      ".en-reading-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; border-bottom: 1px solid var(--line); padding-bottom: 12px; flex-wrap: wrap; }" +
      ".en-reading-title-area { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 260px; }" +
      ".en-reading-title { font-size: calc(18px * var(--font-scale, 1)); font-weight: 700; color: var(--ink); line-height: 1.35; letter-spacing: -0.2px; }" +
      ".en-reading-meta-tags { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: calc(11px * var(--font-scale, 1)); color: var(--muted); }" +

      /* 主旨论点与情感立场卡片 */
      ".en-thesis-box { background: rgba(64,158,255,0.06); border: 1px solid rgba(64,158,255,0.25); border-radius: 8px; padding: 10px 14px; display: flex; flex-direction: column; gap: 6px; font-size: calc(12px * var(--font-scale, 1)); line-height: 1.5; }" +
      ".en-thesis-row { display: flex; align-items: flex-start; gap: 6px; }" +
      ".en-thesis-badge { font-weight: 600; color: #409eff; white-space: nowrap; }" +
      ".en-tone-badge { font-weight: 600; color: var(--gold, #e6a23c); white-space: nowrap; }" +

      /* 整篇通读双语正文 —— 英文长文按「阅读测度」收窄并居中，做成书页而不是通栏 */
      ".en-read-surface { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 22px 26px; color: var(--ink); font-family: var(--font-serif); font-size: var(--en-read-size, var(--read-size, 17px)); line-height: var(--read-leading, 1.75); }" +
      ".en-read-surface > * { max-width: var(--read-measure, 68ch); margin-inline: auto; }" +
      ".en-read-surface p { margin: 0 0 1.1em 0; }" +
      ".en-read-surface p:last-child { margin-bottom: 0; }" +
      /* 段落首行缩进会让英文长文更难扫读，这里用「段间距」代替缩进区分段落 */
      ".en-read-surface p + p { text-indent: 0; }" +
      ".en-read-surface ::selection { background: var(--gold-soft, #f6ebcb); }" +
      ".en-passage-zh-para { font-size: calc(13px * var(--font-scale, 1)); color: var(--muted); font-family: var(--font-sans); line-height: 1.7; margin-top: 8px; padding-left: 12px; border-left: 2px solid var(--line); }" +

      /* 逐段显微镜微观拆解流 (Paragraph-by-Paragraph Micro Analysis) */
      ".en-para-micro-stream { display: flex; flex-direction: column; gap: 14px; }" +
      ".en-para-micro-card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; transition: border-color 0.2s; }" +
      ".en-para-micro-card:hover { border-color: var(--muted); }" +
      ".en-para-micro-head { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px dashed var(--line); padding-bottom: 8px; flex-wrap: wrap; gap: 8px; }" +
      ".en-para-index-badge { background: var(--ink); color: var(--panel); font-size: calc(11px * var(--font-scale, 1)); font-weight: 700; padding: 2px 8px; border-radius: 12px; }" +
      ".en-para-role-tag { font-size: calc(11px * var(--font-scale, 1)); font-weight: 600; color: #409eff; background: rgba(64,158,255,0.12); padding: 2px 8px; border-radius: 4px; }" +
      ".en-para-idea { font-size: calc(12px * var(--font-scale, 1)); font-weight: 500; color: var(--ink); line-height: 1.5; background: rgba(0,0,0,0.02); padding: 6px 10px; border-radius: 6px; }" +

      ".en-para-bilingual { display: flex; flex-direction: column; gap: 8px; font-size: calc(13.5px * var(--font-scale, 1)); line-height: 1.75; font-family: var(--font-serif, Georgia, serif); color: var(--ink); }" +
      ".en-para-zh { font-size: calc(12.5px * var(--font-scale, 1)); color: var(--muted); line-height: 1.6; font-family: var(--font-sans, sans-serif); padding-left: 10px; border-left: 2px solid var(--line); }" +

      /* 段内长难句手术刀与骨架展示 */
      ".en-para-sentence-block { background: rgba(230,162,60,0.06); border: 1px solid rgba(230,162,60,0.25); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }" +
      ".en-para-sent-title { font-size: calc(11px * var(--font-scale, 1)); font-weight: 700; color: var(--gold, #e6a23c); display: flex; justify-content: space-between; align-items: center; }" +
      ".en-para-backbone { font-size: calc(12.5px * var(--font-scale, 1)); font-weight: 600; color: var(--ink); font-style: italic; background: rgba(0,0,0,0.03); padding: 4px 8px; border-radius: 4px; }" +

      /* 段内生词与熟词生义 */
      ".en-para-vocab-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; font-size: calc(11px * var(--font-scale, 1)); }" +
      ".en-vocab-tag { background: rgba(128,128,128,0.08); border: 1px solid var(--line); padding: 2px 6px; border-radius: 4px; color: var(--ink); }" +
      ".en-ff-alert { background: rgba(245,108,108,0.08); border: 1px solid rgba(245,108,108,0.25); padding: 4px 8px; border-radius: 4px; color: var(--red, #f56c6c); font-size: calc(11px * var(--font-scale, 1)); line-height: 1.4; }" +
      ".en-logic-hint { font-size: calc(11px * var(--font-scale, 1)); color: var(--muted); font-style: italic; display: flex; align-items: center; gap: 4px; }" +

      /* 仿真考题样式 */
      ".en-quiz-option { border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; font-size: calc(13px * var(--font-scale, 1)); line-height: 1.45; cursor: pointer; display: flex; align-items: flex-start; gap: 10px; transition: all 0.15s ease; }" +
      ".en-quiz-option:hover { border-color: var(--ink); background: rgba(128,128,128,0.04); }" +
      ".en-quiz-option.selected { border-color: var(--ink); background: rgba(128,128,128,0.08); font-weight: 500; }" +
      ".en-quiz-option.correct { border-color: var(--green, #67c23a); background: rgba(103,194,58,0.1); color: var(--green, #67c23a); font-weight: 600; }" +
      ".en-quiz-option.wrong { border-color: var(--red, #f56c6c); background: rgba(245,108,108,0.1); color: var(--red, #f56c6c); }" +

      /* 手术刀成分染色 */
      ".en-tok-trunk { font-weight: 700; color: var(--ink); background: rgba(128,128,128,0.12); padding: 1px 4px; border-radius: 3px; }" +
      ".en-tok-clause { color: #409eff; text-decoration: underline dotted #409eff; cursor: pointer; }" +
      ".en-tok-insert { color: var(--gold, #e6a23c); font-style: italic; background: rgba(230,162,60,0.08); padding: 1px 4px; border-radius: 3px; cursor: pointer; }" +
      ".en-tok-prep { color: var(--muted); border-bottom: 1px dashed var(--line); cursor: pointer; }" +

      /* 同义改写卡片 */
      ".en-para-item { background: rgba(0,0,0,0.015); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; display: flex; flex-direction: column; gap: 6px; font-size: calc(13px * var(--font-scale, 1)); }" +
      ".en-para-head { display: flex; justify-content: space-between; align-items: center; font-size: calc(11px * var(--font-scale, 1)); color: var(--muted); }" +
      ".en-para-pair { display: flex; align-items: center; gap: 10px; font-size: calc(13px * var(--font-scale, 1)); flex-wrap: wrap; margin: 2px 0; }" +
      ".en-para-src { color: var(--ink); font-weight: 600; font-family: var(--font-serif, Georgia, serif); background: rgba(0,0,0,0.04); padding: 2px 6px; border-radius: 4px; }" +
      ".en-para-arrow { color: var(--gold, #e6a23c); font-weight: bold; font-size: calc(14px * var(--font-scale, 1)); }" +
      ".en-para-tgt { color: var(--green, #67c23a); font-weight: 600; font-family: var(--font-serif, Georgia, serif); background: rgba(103,194,58,0.08); padding: 2px 6px; border-radius: 4px; }" +

      /* 联网实时检索泳道（纯联网语料层） */
      ".en-lane-switch { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; background: rgba(64,158,255,0.06); border: 1px solid rgba(64,158,255,0.25); border-radius: 10px; padding: 8px 12px; }" +
      ".en-lane-btn { background: transparent; border: 1px solid var(--line); color: var(--muted); border-radius: 6px; padding: 5px 12px; font-size: calc(12px * var(--font-scale, 1)); cursor: pointer; font-weight: 500; transition: all 0.15s ease; }" +
      ".en-lane-btn:hover { color: var(--ink); border-color: var(--muted); }" +
      ".en-lane-btn.active { background: var(--ink); color: var(--panel); border-color: var(--ink); font-weight: 600; }" +

      /* 联网精读正文：与 .en-read-surface 同一套排版。
         刻意不再给内层 max-height/overflow —— 外层 .en-body 已经在滚，
         正文里再套一层滚动条会变成「滚动条里还有滚动条」，读到一半就被截断。 */
      ".en-online-passage { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 22px 26px; color: var(--ink); font-family: var(--font-serif); font-size: var(--en-read-size, var(--read-size, 17px)); line-height: var(--read-leading, 1.75); }" +
      ".en-online-passage > p { max-width: var(--read-measure, 68ch); margin: 0 auto 1.1em; }" +
      ".en-online-passage > p:last-child { margin-bottom: 0; }" +
      ".en-online-passage ::selection { background: var(--gold-soft, #f6ebcb); }" +

      /* ================= 补齐「用了但没定义」的类 =================
         这些类名在渲染代码里已经出现，但样式表里一直没有对应规则，
         结果就是步骤数字徽章退化成裸文本、熟词生义预警块完全没有边框和底色。 */
      ".en-step-row { display: flex; align-items: center; gap: 8px; font-size: var(--text-sm); color: var(--ink); }" +
      ".en-step-badge { flex: 0 0 auto; width: 20px; height: 20px; border-radius: 50%; background: var(--ink); color: var(--panel); font-size: var(--text-xs); font-weight: 700; display: inline-flex; align-items: center; justify-content: center; line-height: 1; }" +
      ".en-ff-badge { display: flex; flex-direction: column; gap: 6px; background: var(--red-soft, #f8e1df); border: 1px solid rgba(199, 92, 92, 0.3); border-radius: 8px; padding: 10px 12px; }" +
      ".en-ff-tag { font-size: var(--text-sm); font-weight: 700; color: var(--red, #c75c5c); }" +
      ".en-adv-drawer { border-top: 1px dashed var(--line); padding-top: 6px; }" +
      ".en-adv-toggle { font-size: var(--text-xs); color: var(--muted); display: flex; justify-content: space-between; align-items: center; gap: 8px; cursor: pointer; padding: 5px 4px; border-radius: 4px; transition: color 0.15s ease; }" +
      ".en-adv-toggle:hover { color: var(--ink); }" +

      /* ================= 交互状态：焦点 / 按下 / 禁用 ================= */
      /* 键盘焦点环：鼠标点击不出现（:focus-visible），Tab 走到才出现；2px + offset 才看得见 */
      ".en-exam-wrap :is(button, [role='button'], input, select, textarea, a):focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }" +
      ".en-exam-wrap :is(button, [role='button'], input, select, textarea, a):focus:not(:focus-visible) { outline: none; }" +
      /* 按下态：下沉 1px，让「点到了」有物理反馈；旧样式只有 hover 没有 active */
      ".en-exam-btn:active, .en-lane-btn:active, .en-exam-nav-btn:active, .en-journal-pill:active, .en-cat-btn:active, .en-article-item:active { transform: translateY(1px); }" +
      ".en-exam-btn:disabled, .en-exam-btn[aria-disabled='true'] { opacity: 0.5; cursor: not-allowed; pointer-events: none; }" +
      /* 数字列等宽：词数、百分比、源健康度刷新时不会左右抖 */
      ".en-item-meta, .en-reading-meta-tags, .en-journal-pill-count { font-variant-numeric: tabular-nums; }" +
      /* 卡片改成 <button> 后要补回左对齐——按钮的 text-align 默认是居中，
         标题和摘要居中会立刻变得很难读。 */
      ".en-article-item { text-align: left; }" +
      "" +

      /* ================= 骨架屏 =================
         「正在加载…」只说明系统在忙；骨架屏画出即将出现的内容形状，读起来更快。 */
      ".en-skel { background: linear-gradient(90deg, rgba(128,128,128,0.09) 25%, rgba(128,128,128,0.17) 37%, rgba(128,128,128,0.09) 63%); background-size: 400% 100%; animation: en-skel-shimmer 1.4s ease-in-out infinite; border-radius: 6px; }" +
      ".en-skel-card { display: flex; flex-direction: column; gap: 9px; border: 1px solid var(--line); border-radius: 8px; padding: 11px 12px; }" +
      "@keyframes en-skel-shimmer { 0% { background-position: 100% 50%; } 100% { background-position: 0 50%; } }" +

      /* ================= 阅读工具条（正文字号调节） ================= */
      ".en-read-tools { display: inline-flex; align-items: center; gap: 2px; background: rgba(0,0,0,0.03); border: 1px solid var(--line); border-radius: 8px; padding: 2px; }" +
      ".en-read-tools button { width: 26px; height: 24px; border: none; background: transparent; color: var(--ink); font-size: var(--text-sm); font-weight: 600; border-radius: 6px; cursor: pointer; line-height: 1; }" +
      ".en-read-tools button:hover { background: rgba(128,128,128,0.14); }" +
      ".en-read-tools button:active { background: rgba(128,128,128,0.22); }" +
      ".en-read-tools button:disabled { opacity: 0.35; cursor: not-allowed; background: transparent; }" +
      ".en-read-tools .v { min-width: 36px; text-align: center; font-size: var(--text-xs); color: var(--muted); font-variant-numeric: tabular-nums; }" +

      /* ================= 长难句成分卡：层级 / 折叠 / 聚焦 =================
         原来的成分卡是一列等宽等距的方块，从句和主干长得一模一样，看不出谁修饰谁。
         现在用「缩进 + 连接线」表达 depth，用配色区分主干/从句/插入语，
         再把 can_collapse 真正用起来——点标题左侧的方块折叠，点卡片本身聚焦。 */
      ".en-comp-stream { display: flex; flex-direction: column; gap: 6px; }" +
      ".en-comp { position: relative; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; transition: border-color 0.18s ease, box-shadow 0.18s ease, opacity 0.18s ease; }" +
      ".en-comp[data-depth='1'] { margin-left: 20px; }" +
      ".en-comp[data-depth='2'] { margin-left: 40px; }" +
      ".en-comp[data-depth='1']::before, .en-comp[data-depth='2']::before { content: ''; position: absolute; left: -13px; top: 50%; width: 12px; height: 1px; background: var(--line); }" +
      ".en-comp[data-depth='1']::after, .en-comp[data-depth='2']::after { content: ''; position: absolute; left: -14px; top: -7px; bottom: 50%; width: 1px; background: var(--line); }" +
      ".en-comp-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; }" +
      /* 成分标题本身就是按钮：键盘可 Tab 到、可回车触发，而不是给 div 挂个 click 了事 */
      ".en-comp-focus { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; border: none; background: transparent; padding: 0; font: inherit; cursor: pointer; text-align: left; border-radius: 4px; }" +
      ".en-comp-focus:hover .en-comp-label { color: var(--ink); }" +
      ".en-syntax-backbone { background: rgba(0,0,0,0.03); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }" +
      ".en-syntax-backbone-label { font-size: var(--text-sm); font-weight: 700; color: var(--ink); }" +
      ".en-syntax-backbone-text { font-size: var(--text-lg); font-weight: 700; color: var(--ink); font-family: var(--font-serif); line-height: var(--leading-snug); }" +
      ".en-syntax-backbone-zh { font-size: var(--text-base); color: var(--muted); line-height: var(--leading-snug); }" +
      ".en-comp-toggle { flex: 0 0 auto; width: 18px; height: 18px; border: 1px solid var(--line); background: var(--panel); color: var(--muted); border-radius: 4px; font-size: calc(10px * var(--font-scale, 1)); line-height: 1; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; transition: transform 0.18s ease, color 0.15s ease, border-color 0.15s ease; }" +
      ".en-comp-toggle:hover { color: var(--ink); border-color: var(--muted); }" +
      ".en-comp.is-collapsed .en-comp-toggle { transform: rotate(-90deg); }" +
      ".en-comp-toggle.is-static { cursor: default; opacity: 0.35; }" +
      ".en-comp-role { font-size: var(--text-xs); font-weight: 700; padding: 2px 7px; border-radius: 4px; white-space: nowrap; transition: background 0.18s ease, color 0.18s ease; }" +
      ".en-comp-trunk .en-comp-role { background: rgba(128,128,128,0.18); color: var(--ink); }" +
      ".en-comp-clause .en-comp-role { background: rgba(64,158,255,0.14); color: #409eff; }" +
      ".en-comp-insert .en-comp-role { background: rgba(212,168,67,0.18); color: var(--gold, #d4a843); }" +
      ".en-comp-label { font-size: var(--text-xs); color: var(--muted); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }" +
      ".en-comp-body { padding: 0 10px 10px 36px; display: flex; flex-direction: column; gap: 5px; }" +
      ".en-comp-text { font-size: var(--text-base); color: var(--ink); font-family: var(--font-serif); line-height: var(--leading-normal); }" +
      ".en-comp-zh { font-size: var(--text-sm); color: var(--muted); line-height: var(--leading-snug); }" +
      /* 折叠不是「整块消失」而是「收成一行」：保留一句预览，用户还知道这条是什么，
         想细看再展开。全隐藏会让读者失去上下文，反而要多点几次。 */
      ".en-comp.is-collapsed .en-comp-text { display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }" +
      ".en-comp.is-collapsed .en-comp-body { padding-bottom: 8px; }" +
      ".en-comp.is-collapsed .en-comp-zh { display: none; }" +
      /* 聚焦态：只让被点中的成分亮着，其余压暗——一次只盯一个从句看 */
      ".en-comp-stream.has-focus .en-comp { opacity: 0.4; }" +
      ".en-comp-stream.has-focus .en-comp.is-focus { opacity: 1; border-color: var(--ink); box-shadow: 0 2px 10px rgba(0,0,0,0.07); }" +
      ".en-comp-trunk.is-focus .en-comp-role { background: var(--ink); color: var(--panel); }" +
      ".en-comp-clause.is-focus .en-comp-role { background: #409eff; color: #fff; }" +
      ".en-comp-insert.is-focus .en-comp-role { background: var(--gold, #d4a843); color: #fff; }" +
      ".en-comp-hint { font-size: var(--text-xs); color: var(--muted); font-style: italic; }" +
      ".en-logic-chip { display: inline-flex; align-items: baseline; gap: 4px; font-size: var(--text-xs); border: 1px solid var(--line); border-radius: 12px; padding: 3px 9px; color: var(--ink); background: rgba(0,0,0,0.02); line-height: 1.45; }" +
      ".en-logic-chip b { color: var(--gold, #d4a843); }" +

      /* ================= 划词交互：高亮 / 浮出工具条 / 侧边抽屉 =================
         高亮的底色由 JS 算成 rgba 塞进 --hl-bg / --hl-line 两个变量，
         不直接用 color-mix，免得旧内核上整块高亮变成透明看不到。 */
      ".en-read-surface p[data-en-para], .en-online-passage p[data-en-para] { cursor: text; }" +
      "mark.en-hl { background: var(--hl-bg, rgba(230,162,60,0.22)); border-bottom: 1.5px solid var(--hl-line, rgba(230,162,60,0.7)); border-radius: 2px; padding: 0 1px; color: inherit; cursor: pointer; transition: background 0.15s ease; }" +
      "mark.en-hl:hover { background: var(--hl-bg-hover, rgba(230,162,60,0.36)); }" +
      "mark.en-hl .en-hl-dot { display: inline-block; width: 5px; height: 5px; border-radius: 50%; background: var(--hl-line, rgba(230,162,60,0.7)); margin-left: 3px; vertical-align: super; }" +
      "mark.en-hl.is-flash { animation: en-hl-flash 1.1s ease; }" +
      "mark.en-sel-mark { background: rgba(64,158,255,0.16); outline: 1.5px dashed var(--gold, #e6a23c); outline-offset: 1px; border-radius: 3px; padding: 0 1px; color: inherit; }" +
      "@keyframes en-hl-flash { 0%, 100% { background: var(--hl-bg, rgba(230,162,60,0.22)); } 35% { background: rgba(64,158,255,0.42); } }" +

      ".en-sel-bar { position: fixed; z-index: 1570; background: var(--panel, #fff); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 8px 26px rgba(0,0,0,0.14); padding: 8px 10px; display: flex; flex-direction: column; gap: 7px; font-size: calc(12px * var(--font-scale, 1)); color: var(--ink); }" +
      ".en-sel-quote { font-size: calc(11.5px * var(--font-scale, 1)); color: var(--muted); font-style: italic; line-height: 1.4; max-height: 34px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }" +
      ".en-sel-actions { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }" +
      ".en-sel-btn { border: 1px solid var(--line); background: rgba(0,0,0,0.02); color: var(--ink); border-radius: 6px; padding: 4px 9px; font-size: calc(11.5px * var(--font-scale, 1)); cursor: pointer; white-space: nowrap; transition: background 0.15s ease, border-color 0.15s ease; }" +
      ".en-sel-btn:hover { background: rgba(64,158,255,0.1); border-color: #409eff; }" +
      ".en-sel-btn.busy { opacity: 0.65; cursor: progress; }" +
      ".en-sel-btn:disabled { cursor: progress; opacity: 0.6; }" +
      ".en-sel-btn.ghost { border-color: transparent; background: transparent; color: var(--muted); }" +
      ".en-sel-result { border-top: 1px dashed var(--line); padding-top: 7px; display: flex; flex-direction: column; gap: 6px; max-height: 46vh; overflow-y: auto; }" +
      ".en-sel-res-head { display: flex; align-items: center; justify-content: space-between; font-size: calc(11.5px * var(--font-scale, 1)); font-weight: 700; color: var(--ink); }" +
      ".en-sel-x { border: none; background: transparent; color: var(--muted); cursor: pointer; font-size: calc(12px * var(--font-scale, 1)); line-height: 1; padding: 2px 4px; border-radius: 4px; }" +
      ".en-sel-x:hover { background: rgba(128,128,128,0.14); color: var(--ink); }" +
      ".en-sel-res-main { font-size: calc(13px * var(--font-scale, 1)); line-height: 1.6; color: var(--ink); }" +
      ".en-sel-res-hint { font-size: calc(11.5px * var(--font-scale, 1)); color: var(--muted); line-height: 1.5; }" +
      ".en-sel-res-note { font-size: calc(11.5px * var(--font-scale, 1)); color: var(--muted); line-height: 1.5; }" +
      ".en-sel-res-list { display: flex; flex-direction: column; gap: 7px; }" +
      ".en-sel-res-item { background: rgba(0,0,0,0.02); border: 1px solid var(--line); border-radius: 7px; padding: 7px 9px; display: flex; flex-direction: column; gap: 4px; }" +
      ".en-sel-res-line { font-size: calc(12.5px * var(--font-scale, 1)); line-height: 1.55; color: var(--ink); font-family: var(--font-serif); }" +
      ".en-sel-idx { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 50%; background: rgba(64,158,255,0.16); color: #409eff; font-size: calc(10px * var(--font-scale, 1)); font-weight: 700; margin-right: 5px; vertical-align: 1px; font-family: var(--font-sans, sans-serif); }" +
      ".en-sel-tag { display: inline-block; font-size: calc(10px * var(--font-scale, 1)); padding: 1px 6px; border-radius: 10px; background: rgba(64,158,255,0.12); color: #409eff; align-self: flex-start; }" +
      ".en-sel-tag.ai { background: rgba(160,108,213,0.14); color: #a06cd5; }" +
      ".en-sel-tag.sig { background: rgba(230,162,60,0.14); color: var(--gold, #e6a23c); }" +
      ".en-sel-tag.method { background: rgba(103,194,58,0.14); color: var(--green, #67c23a); }" +
      ".en-sel-swaps { display: flex; flex-wrap: wrap; gap: 5px; }" +
      ".en-sel-swap { font-size: calc(10.5px * var(--font-scale, 1)); background: rgba(0,0,0,0.03); border: 1px solid var(--line); border-radius: 10px; padding: 1px 7px; color: var(--muted); }" +
      ".en-sel-swap b { color: var(--ink); }" +
      ".en-sel-kw { display: flex; flex-wrap: wrap; gap: 5px; }" +
      ".en-sel-kw-item { font-size: calc(10.5px * var(--font-scale, 1)); background: rgba(0,0,0,0.03); border: 1px solid var(--line); border-radius: 10px; padding: 1px 7px; color: var(--muted); }" +
      ".en-sel-kw-item b { color: var(--ink); }" +
      ".en-sel-toast { position: fixed; left: 50%; transform: translateX(-50%); bottom: 28px; z-index: 1580; background: rgba(20,28,38,0.92); color: #fff; font-size: calc(12px * var(--font-scale, 1)); padding: 8px 16px; border-radius: 20px; box-shadow: 0 6px 20px rgba(0,0,0,0.2); }" +

      ".en-side-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(400px, 92vw); z-index: 1560; background: var(--panel, #fff); border-left: 1px solid var(--line); box-shadow: -10px 0 30px rgba(0,0,0,0.1); display: flex; flex-direction: column; font-size: calc(12px * var(--font-scale, 1)); color: var(--ink); }" +
      ".en-side-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--line); }" +
      ".en-side-title { font-size: calc(13.5px * var(--font-scale, 1)); font-weight: 700; }" +
      ".en-side-tabs { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 12px 0; border-bottom: 1px solid var(--line); }" +
      ".en-side-tab { border: 1px solid transparent; border-bottom: none; background: transparent; color: var(--muted); font-size: calc(12px * var(--font-scale, 1)); padding: 6px 10px; cursor: pointer; border-radius: 7px 7px 0 0; }" +
      ".en-side-tab:hover { color: var(--ink); }" +
      ".en-side-tab.active { background: rgba(64,158,255,0.1); border-color: var(--line); color: #409eff; font-weight: 600; }" +
      ".en-side-body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 14px 24px; display: flex; flex-direction: column; gap: 9px; }" +
      ".en-side-empty { font-size: calc(12px * var(--font-scale, 1)); color: var(--muted); line-height: 1.65; padding: 14px 4px; }" +
      ".en-side-hint { font-size: calc(11px * var(--font-scale, 1)); color: var(--muted); line-height: 1.5; }" +
      ".en-side-list { display: flex; flex-direction: column; gap: 8px; }" +
      ".en-side-note { border-left: 3px solid var(--hl, #e6a23c); background: rgba(0,0,0,0.02); border-radius: 0 8px 8px 0; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }" +
      ".en-side-note-quote { font-size: calc(12px * var(--font-scale, 1)); font-style: italic; color: var(--ink); line-height: 1.5; border-bottom: 1px dashed var(--line); padding-bottom: 5px; }" +
      ".en-side-note-text { font-size: calc(12px * var(--font-scale, 1)); color: var(--ink); line-height: 1.6; white-space: pre-wrap; }" +
      ".en-side-note-text.empty { color: var(--muted); font-style: italic; }" +
      ".en-side-note-ops { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; }" +
      ".en-hl-swatches { display: inline-flex; gap: 4px; margin-right: auto; }" +
      ".en-hl-swatch { width: 15px; height: 15px; border-radius: 50%; border: 1px solid var(--line); background: var(--hl); cursor: pointer; padding: 0; }" +
      ".en-hl-swatch.on { box-shadow: 0 0 0 2px rgba(64,158,255,0.5); }" +
      ".en-side-coll { background: rgba(0,0,0,0.02); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }" +
      ".en-side-coll-head { display: flex; align-items: center; gap: 6px; font-size: calc(13px * var(--font-scale, 1)); }" +
      ".en-side-coll-mean { font-size: calc(11.5px * var(--font-scale, 1)); color: var(--ink); }" +
      ".en-side-coll-sent { font-size: calc(11px * var(--font-scale, 1)); color: var(--muted); font-style: italic; line-height: 1.5; border-left: 2px solid var(--line); padding-left: 7px; }" +
      ".en-side-thesis { background: rgba(64,158,255,0.07); border: 1px solid rgba(64,158,255,0.22); border-radius: 8px; padding: 9px 11px; font-size: calc(12px * var(--font-scale, 1)); line-height: 1.6; color: var(--ink); }" +
      ".en-side-thesis span { display: block; font-size: calc(10.5px * var(--font-scale, 1)); font-weight: 700; color: #409eff; margin-bottom: 3px; }" +
      ".en-side-arg { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 5px; }" +
      ".en-side-arg-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }" +
      ".en-side-arg-idx { font-size: calc(10.5px * var(--font-scale, 1)); font-weight: 700; color: var(--muted); }" +
      ".en-side-arg-role { font-size: calc(12px * var(--font-scale, 1)); font-weight: 600; color: var(--ink); }" +
      ".en-side-arg-gist { font-size: calc(11.5px * var(--font-scale, 1)); color: var(--muted); line-height: 1.55; }" +
      ".en-side-arg-signals { display: flex; flex-wrap: wrap; gap: 4px; }" +
      ".en-rw-list { display: flex; flex-direction: column; gap: 8px; }" +
      ".en-rw-item { background: rgba(0,0,0,0.02); border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px; display: flex; flex-direction: column; gap: 5px; }" +
      ".en-rw-line { font-size: calc(13px * var(--font-scale, 1)); line-height: 1.6; color: var(--ink); font-family: var(--font-serif); }" +
      ".en-rw-note { font-size: calc(11.5px * var(--font-scale, 1)); color: var(--muted); line-height: 1.5; }" +

      /* ---- 写作提分 / 翻译提分（把博主讲的技巧做成随手可用的小工具）---- */
      ".en-wk-grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr); gap: 12px; align-items: start; }" +
      "@media (max-width: 980px) { .en-wk-grid { grid-template-columns: 1fr; } }" +
      ".en-wk-col { display: flex; flex-direction: column; gap: 12px; min-width: 0; }" +
      ".en-wk-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(92px, 1fr)); gap: 8px; }" +
      ".en-wk-metric { background: rgba(64,158,255,0.06); border: 1px solid rgba(64,158,255,0.22); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; }" +
      ".en-wk-metric b { font-size: calc(17px * var(--font-scale, 1)); font-weight: 700; color: var(--ink); line-height: 1.2; }" +
      ".en-wk-metric span { font-size: calc(10.5px * var(--font-scale, 1)); color: var(--muted); }" +
      ".en-wk-metric.ok { background: rgba(103,194,58,0.09); border-color: rgba(103,194,58,0.3); }" +
      ".en-wk-metric.warn { background: rgba(230,162,60,0.09); border-color: rgba(230,162,60,0.32); }" +
      ".en-wk-metric.bad { background: rgba(245,108,108,0.09); border-color: rgba(245,108,108,0.32); }" +
      ".en-wk-tabs { display: flex; gap: 6px; flex-wrap: wrap; }" +
      ".en-wk-tab { background: transparent; border: 1px solid var(--line); color: var(--muted); border-radius: 14px; padding: 3px 10px; font-size: calc(11.5px * var(--font-scale, 1)); cursor: pointer; white-space: nowrap; transition: all .15s ease; }" +
      ".en-wk-tab:hover { color: var(--ink); border-color: var(--muted); }" +
      ".en-wk-tab.active { background: rgba(64,158,255,0.12); border-color: #409eff; color: #409eff; font-weight: 600; }" +
      ".en-wk-seg { border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px; display: flex; flex-direction: column; gap: 5px; }" +
      ".en-wk-seg-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }" +
      ".en-wk-seg-para { font-size: calc(12.5px * var(--font-scale, 1)); font-weight: 700; color: var(--ink); }" +
      ".en-wk-seg-words { font-size: calc(10.5px * var(--font-scale, 1)); color: var(--gold, #e6a23c); background: rgba(230,162,60,0.12); border-radius: 4px; padding: 1px 6px; }" +
      ".en-wk-seg-role { font-size: calc(11.5px * var(--font-scale, 1)); font-weight: 600; color: #409eff; }" +
      ".en-wk-seg-point { font-size: calc(11.5px * var(--font-scale, 1)); color: var(--muted); line-height: 1.55; }" +
      ".en-wk-sent { background: rgba(0,0,0,0.02); border: 1px dashed var(--line); border-radius: 7px; padding: 6px 9px; font-size: calc(12.5px * var(--font-scale, 1)); line-height: 1.55; font-family: var(--font-serif); color: var(--ink); cursor: pointer; transition: all .15s ease; }" +
      ".en-wk-sent:hover { border-color: #409eff; background: rgba(64,158,255,0.07); }" +
      ".en-wk-sent-zh { display: block; font-size: calc(11px * var(--font-scale, 1)); color: var(--muted); font-family: var(--font-sans); margin-top: 2px; }" +
      ".en-wk-issue { border-radius: 7px; padding: 7px 10px; font-size: calc(11.5px * var(--font-scale, 1)); line-height: 1.55; color: var(--ink); }" +
      ".en-wk-issue.ok { background: rgba(103,194,58,0.08); border: 1px solid rgba(103,194,58,0.28); }" +
      ".en-wk-issue.warn { background: rgba(230,162,60,0.08); border: 1px solid rgba(230,162,60,0.3); }" +
      ".en-wk-issue.bad { background: rgba(245,108,108,0.08); border: 1px solid rgba(245,108,108,0.3); }" +
      ".en-wk-mono { font-family: var(--font-mono, monospace); font-size: calc(11.5px * var(--font-scale, 1)); border-radius: 4px; padding: 1px 5px; }" +
      ".en-wk-mono.bad { background: rgba(245,108,108,0.12); text-decoration: line-through; }" +
      ".en-wk-mono.fix { background: rgba(103,194,58,0.14); }" +
      ".en-wk-src { font-size: calc(10.5px * var(--font-scale, 1)); color: var(--muted); font-style: italic; border-left: 2px solid var(--line); padding-left: 7px; line-height: 1.5; }" +
      ".en-wk-list { display: flex; flex-direction: column; gap: 8px; }" +
      ".en-wk-term { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 8px; }" +
      ".en-wk-term-card { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 3px; cursor: pointer; transition: all .15s ease; }" +
      ".en-wk-term-card:hover { border-color: #409eff; background: rgba(64,158,255,0.06); }" +
      ".en-wk-term-zh { font-size: calc(12.5px * var(--font-scale, 1)); font-weight: 600; color: var(--ink); }" +
      ".en-wk-term-en { font-size: calc(12px * var(--font-scale, 1)); color: #409eff; font-family: var(--font-serif); }" +
      ".en-wk-term-note { font-size: calc(10.5px * var(--font-scale, 1)); color: var(--muted); line-height: 1.45; }" +
      ".en-wk-note-strip { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }" +
      ".en-wk-note-chip { display: inline-flex; align-items: center; gap: 5px; font-size: calc(11.5px * var(--font-scale, 1)); background: rgba(64,158,255,0.1); border: 1px solid rgba(64,158,255,0.28); color: #409eff; border-radius: 12px; padding: 2px 9px; }" +
      ".en-wk-note-chip button { background: none; border: none; color: inherit; cursor: pointer; font-size: calc(13px * var(--font-scale, 1)); line-height: 1; padding: 0; }" +
      ".en-tl-sent { border: 1px solid var(--line); border-radius: 9px; padding: 10px 12px; display: flex; flex-direction: column; gap: 7px; }" +
      ".en-tl-zh { font-size: calc(13px * var(--font-scale, 1)); font-weight: 500; line-height: 1.6; color: var(--ink); }" +
      ".en-tl-chunks { display: flex; flex-wrap: wrap; gap: 5px; }" +
      ".en-tl-chunk { font-size: calc(11px * var(--font-scale, 1)); background: rgba(128,128,128,0.08); border: 1px solid var(--line); border-radius: 4px; padding: 2px 7px; color: var(--muted); }" +
      ".en-tl-chunk.main { background: rgba(64,158,255,0.1); border-color: rgba(64,158,255,0.3); color: #409eff; font-weight: 600; }" +
      ".en-tl-cue { font-size: calc(11.5px * var(--font-scale, 1)); line-height: 1.5; color: var(--ink); background: rgba(230,162,60,0.08); border-left: 2px solid var(--gold, #e6a23c); border-radius: 0 5px 5px 0; padding: 4px 8px; }" +
      ".en-tl-cue b { color: var(--gold, #e6a23c); }" +
      ".en-tl-step { font-size: calc(11.5px * var(--font-scale, 1)); color: var(--muted); line-height: 1.55; padding-left: 2px; }" +

      /* 窄轨兜底：收起状态下（约 280px 侧边轨）不渲染完整工作台，只给一张入口卡 */
      ".en-exam-narrow { display: flex; flex-direction: column; gap: 10px; }" +
      ".en-exam-narrow-title { font-size: calc(14px * var(--font-scale, 1)); font-weight: 600; color: var(--ink); }" +
      ".en-exam-narrow-desc { font-size: calc(12px * var(--font-scale, 1)); line-height: 1.7; color: var(--muted); }" +
      ".en-exam-narrow-list { display: flex; flex-direction: column; gap: 5px; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }" +
      ".en-exam-narrow-list div { font-size: calc(12px * var(--font-scale, 1)); color: var(--ink); }" +
      ".en-exam-narrow-btn { border: 1px solid var(--green); background: var(--green); color: #fff; border-radius: 10px; padding: 10px 12px; font-size: calc(13px * var(--font-scale, 1)); font-weight: 500; cursor: pointer; white-space: nowrap; }" +
      "html[data-theme='dark'] .en-exam-narrow-btn { color: #0e1410; }" +
      ".en-exam-narrow-btn:hover { filter: brightness(1.06); }" +

      /* 尊重系统的「减少动态效果」设置 */
      "@media (prefers-reduced-motion: reduce) { .en-exam-wrap *, .en-exam-wrap *::before, .en-exam-wrap *::after { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; } .en-article-item:hover, .en-exam-btn:active, .en-lane-btn:active, .en-exam-nav-btn:active, .en-journal-pill:active, .en-cat-btn:active { transform: none !important; } }";

    document.head.appendChild(el);
  }

  function esc(s) {
    if (s === undefined || s === null) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* ------------------------------------------------------------ 模块 1：海量母源期刊检索与研读渲染 */

  function renderReadingTab() {
    var rd = examView.activeReading;
    var journals = examView.journalsCatalog || DEFAULT_JOURNALS;
    var curJournalId = examView.selectedJournalId;
    var curCat = examView.selectedTopicCategory;

    // 语料来源泳道切换：联网实时检索（默认，零本地占用） ↔ 本地精选母源库
    var laneSwitchHtml =
      '<div class="en-lane-switch">' +
      '<span style="font-size:calc(12px * var(--font-scale, 1)); font-weight:600; color:var(--ink); white-space:nowrap;">🎯 精读语料来源：</span>' +
      '<button class="en-lane-btn' + (examView.onlineMode ? ' active' : '') + '" data-en-exam-action="set-lane" data-lane="online">🌐 联网实时检索（推荐）</button>' +
      '<button class="en-lane-btn' + (!examView.onlineMode ? ' active' : '') + '" data-en-exam-action="set-lane" data-lane="local">🏛 本地精选母源库</button>' +
      '<span style="font-size:calc(11px * var(--font-scale, 1)); color:var(--muted); margin-left:auto;">' +
      (examView.onlineMode
        ? '实时抓取各刊最新文章，本地不落地大语料 · 打开即可读'
        : '内置 13 篇深度拆解母源，离线可读 · 逐段显微镜精析') +
      '</span>' +
      '</div>';

    if (examView.onlineMode) {
      return (
        '<div style="display:flex; flex-direction:column; gap:12px;">' +
        laneSwitchHtml +
        renderOnlineLane() +
        '</div>'
      );
    }

    // 主题分类集合
    var categories = [
      { id: "all", name: "全部学科主题" },
      { id: "科技创新与人工智能", name: "🤖 科技创新与人工智能" },
      { id: "商业金融与宏观治理", name: "💼 商业金融与宏观治理" },
      { id: "生命科学与认知心理", name: "🧬 生命科学与认知心理" },
      { id: "地球生态与气候科学", name: "🌍 地球生态与气候科学" },
      { id: "历年考研官方真题精选", name: "🏛️ 官方真题原卷" }
    ];

    // 1. 顶部检索与母源期刊全谱系选择矩阵
    var searchMatrixHtml =
      '<div class="en-search-hero">' +
      // 标题与说明
      '<div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px;">' +
      '<div class="en-step-row">' +
      '<span class="en-step-badge">1</span>' +
      '<span><b>13 大权威母源期刊全谱系</b> · 实时文章检索库</span>' +
      '</div>' +
      '<span style="font-size:calc(11px * var(--font-scale, 1)); color:var(--muted);">覆盖历年考研英语 80%+ 命题母源 · 点击直选文章</span>' +
      '</div>' +

      // 实时搜索输入框
      '<div class="en-search-bar">' +
      '<input type="text" id="en-article-search-input" class="en-search-input" placeholder="输入关键词、篇名、概念或作者实时检索海量母源文章 (如: AI / memory / climate / algorithm)..." value="' + esc(examView.articleSearchQuery) + '" />' +
      '<button class="en-exam-btn" data-en-exam-action="do-articles-search">' +
      (examView.loading ? '正在检索...' : '🔍 检索文章') +
      '</button>' +
      '</div>' +

      // 13 大权威母源期刊胶囊栏
      '<div class="en-journal-capsules">' +
      '<div class="en-journal-pill' + (curJournalId === "all" ? " active" : "") + '" data-en-exam-action="filter-journal" data-journal-id="all">' +
      '<span>🏛 全部权威母源</span>' +
      '<span class="en-journal-pill-count">' + (examView.articlesList.length || 13) + '</span>' +
      '</div>' +
      journals
        .map(function (j) {
          var isAct = curJournalId === j.id;
          return (
            '<div class="en-journal-pill' + (isAct ? ' active' : '') + '" data-en-exam-action="filter-journal" data-journal-id="' + esc(j.id) + '" title="' + esc(j.style_description || j.name) + '">' +
            '<span>' + esc(j.name) + '</span>' +
            '<span class="en-journal-pill-count">' + (j.article_count || 1) + '</span>' +
            '</div>'
          );
        })
        .join("") +
      '</div>' +

      // 学科主题标签级联
      '<div class="en-category-row">' +
      '<span style="font-size:calc(11px * var(--font-scale, 1)); color:var(--muted); font-weight:600; white-space:nowrap;">学科领域：</span>' +
      categories
        .map(function (cat) {
          var isAct = curCat === cat.id;
          return (
            '<button class="en-cat-btn' + (isAct ? ' active' : '') + '" data-en-exam-action="filter-category" data-cat-id="' + esc(cat.id) + '">' +
            esc(cat.name) +
            '</button>'
          );
        })
        .join("") +
      '</div>' +

      // 海量匹配篇章瀑布流一览
      '<div class="en-article-stream">' +
      (examView.articlesList && examView.articlesList.length
        ? examView.articlesList
            .map(function (art) {
              var isAct = rd && (rd.id === art.id || rd.title === art.title);
              return (
                '<div class="en-article-item' + (isAct ? ' active' : '') + '" data-en-exam-action="load-article" data-article-id="' + esc(art.id) + '">' +
                '<div class="en-item-head">' +
                '<div class="en-item-title">' + (isAct ? '📖 ' : '') + esc(art.title) + '</div>' +
                '<span class="en-item-source-badge">' + esc(art.source || art.source_name) + '</span>' +
                '</div>' +
                '<div class="en-item-snippet">' + esc(art.snippet || art.sample_passage || '') + '</div>' +
                '<div class="en-item-meta">' +
                '<span>📊 ' + (art.word_count || 310) + ' 词</span>' +
                '<span>📑 ' + (art.paragraph_count || (art.paragraphs ? art.paragraphs.length : 3)) + ' 段深度剖析</span>' +
                '<span>🎯 ' + esc(art.difficulty || '考研英语(一)') + '</span>' +
                (isAct ? '<span style="color:var(--green); font-weight:600; margin-left:auto;">当前研读中 · 点击进入阅读页 ➔</span>' : '<span style="color:var(--muted); margin-left:auto;">点击开始阅读 ➔</span>') +
                '</div>' +
                '</div>'
              );
            })
            .join("")
        : '<div style="grid-column:1/-1; text-align:center; padding:16px; color:var(--muted);">正在载入母源文章列表...</div>') +
      '</div>' +

      // 自定义 URL 与 TJU-LLM 命题合成折叠抽屉
      '<div class="en-adv-drawer" style="margin-top:2px;">' +
      '<div class="en-adv-toggle" data-en-exam-action="toggle-custom-tools" style="font-size:calc(11px * var(--font-scale, 1)); cursor:pointer; color:var(--muted); display:flex; justify-content:space-between;">' +
      '<span>🛠 <b>高级探索工具箱</b>：输入任意链接抓取外刊正文 / 调用 TJU-LLM 命题合成仿真篇章</span>' +
      '<span>' + (examView.customToolsOpen ? '▲ 收起' : '▼ 点击展开') + '</span>' +
      '</div>' +
      (examView.customToolsOpen
        ? '<div style="display:flex; flex-direction:column; gap:8px; margin-top:8px; background:rgba(0,0,0,0.02); padding:10px 12px; border-radius:8px;">' +
          '<div class="en-exam-row" style="font-size:calc(12px * var(--font-scale, 1));">' +
          '<input type="text" id="en-fetch-url" class="en-exam-textarea" style="min-height:30px; padding:3px 8px; flex:1; font-size:calc(12px * var(--font-scale, 1));" placeholder="输入外刊文章在线 URL (如: https://www.economist.com/...)" value="' + esc(examView.fetchUrl) + '" />' +
          '<button class="en-exam-btn sec" style="padding:3px 10px; font-size:calc(11px * var(--font-scale, 1));" data-en-exam-action="do-fetch-url">🌐 抓取网络正文</button>' +
          '</div>' +
          '<div class="en-exam-row">' +
          '<span style="font-size:calc(12px * var(--font-scale, 1)); color:var(--muted);">🤖 TJU-LLM 命题：</span>' +
          '<input type="text" id="en-gen-topic" class="en-exam-textarea" style="min-height:30px; padding:3px 8px; flex:1; font-size:calc(12px * var(--font-scale, 1));" placeholder="指定学术主题 (如: 行为经济学与注意力黑洞)..." value="' + esc(examView.genTopic) + '" />' +
          '<select id="en-gen-style" class="en-exam-textarea" style="min-height:30px; width:120px; padding:3px 6px; font-size:calc(12px * var(--font-scale, 1));">' +
          '<option value="考研真题"' + (examView.genStyle === "考研真题" ? " selected" : "") + '>考研真题风格</option>' +
          '<option value="经济学人"' + (examView.genStyle === "经济学人" ? " selected" : "") + '>The Economist</option>' +
          '<option value="自然前沿"' + (examView.genStyle === "自然前沿" ? " selected" : "") + '>Nature 科研速递</option>' +
          '</select>' +
          '<button class="en-exam-btn" style="padding:3px 10px; font-size:calc(11px * var(--font-scale, 1));" data-en-exam-action="do-gen-reading">' +
          (examView.loading ? '生成中...' : '⚡ 命题生成') +
          '</button>' +
          '</div>' +
          '</div>'
        : '') +
      '</div>' +
      '</div>';

    if (!rd) {
      return (
        '<div style="display:flex; flex-direction:column; gap:12px;">' +
        laneSwitchHtml +
        searchMatrixHtml +
        '<div class="en-exam-card" style="text-align:center; padding:36px 16px; color:var(--muted);">' +
        '在上方母源书架中点击任意篇章即可开启「整篇通读 + 逐段显微镜深度剖析」。' +
        '</div>' +
        '</div>'
      );
    }

    // 2. 阅读页顶栏：篇章信息 + 返回 + 视图切换（固定在阅读页顶部，不随正文滚动）
    var readerBarHtml =
      '<div class="en-reader-bar">' +
      '<button class="en-exam-btn sec" style="font-size:calc(12px * var(--font-scale, 1)); padding:5px 12px; flex:0 0 auto;" data-en-exam-action="close-reader" title="回到文章列表">‹ 返回列表</button>' +
      '<div class="en-reading-title-area">' +
      '<div class="en-reader-bar-title">' + esc(rd.title) + '</div>' +
      '<div class="en-reading-meta-tags">' +
      '<span class="en-item-source-badge" style="font-size:calc(11px * var(--font-scale, 1));">🏛 ' + esc(rd.source || rd.source_name) + '</span>' +
      '<span>📂 ' + esc(rd.category || '综合学科') + '</span>' +
      '<span>📊 ' + (rd.word_count || 315) + ' 词</span>' +
      '<span>🎯 ' + esc(rd.difficulty || '考研英语(一)') + '</span>' +
      (rd.date ? '<span>📅 ' + esc(rd.date) + '</span>' : '') +
      '</div>' +
      '</div>' +

      // 视图切换控制组 (支持一键收起分析只保留原文与展开分析)
      '<div class="en-reader-bar-actions">' +
      (examView.readingViewMode === "original"
        ? '<button class="en-exam-btn" style="font-size:calc(11px * var(--font-scale, 1)); padding:5px 12px; font-weight:600;" data-en-exam-action="set-view-mode" data-mode="both">' +
          '💡 展开深度分析' +
          '</button>'
        : '<button class="en-exam-btn warn" style="font-size:calc(11px * var(--font-scale, 1)); padding:5px 12px; font-weight:600;" data-en-exam-action="set-view-mode" data-mode="original">' +
          '📖 只看英文原文' +
          '</button>' +
          '<button class="en-exam-btn' + (examView.readingViewMode === "both" ? "" : " sec") + '" style="font-size:calc(11px * var(--font-scale, 1)); padding:4px 10px;" data-en-exam-action="set-view-mode" data-mode="both">' +
          '📑 整篇 + 逐段' +
          '</button>' +
          '<button class="en-exam-btn' + (examView.readingViewMode === "paragraphs" ? "" : " sec") + '" style="font-size:calc(11px * var(--font-scale, 1)); padding:4px 10px;" data-en-exam-action="set-view-mode" data-mode="paragraphs">' +
          '🔬 仅看段落显微镜' +
          '</button>') +
      '<button class="en-exam-btn sec" style="font-size:calc(11px * var(--font-scale, 1)); padding:4px 10px;" data-en-exam-action="toggle-reading-zh">' +
      (examView.readingShowZh ? "🔤 纯享英文" : "🌐 双语译文") +
      '</button>' +
      readToolsHtml() +
      '<button class="en-exam-btn sec" style="font-size:calc(11px * var(--font-scale, 1)); padding:4px 10px;" data-en-exam-action="close-reader" title="关闭阅读页，回到文章列表">✕</button>' +
      '</div>' +
      '</div>';

    // 3. 核心主旨论点与感情立场态度分析 (仅在展开分析模式下显示)
    var thesisToneHtml = "";
    if (examView.readingViewMode !== "original" && rd.thesis_tone) {
      var tt = rd.thesis_tone;
      thesisToneHtml =
        '<div class="en-thesis-box">' +
        '<div class="en-thesis-row">' +
        '<span class="en-thesis-badge">🎯 全文核心主旨 (Thesis)：</span>' +
        '<span style="color:var(--ink); font-weight:500;">' + esc(tt.thesis) + '</span>' +
        '</div>' +
        '<div class="en-thesis-row">' +
        '<span class="en-tone-badge">🧭 情感态度与学术立场 (Author\'s Tone)：</span>' +
        '<span style="color:var(--ink); font-weight:600;">' + esc(tt.tone) + '</span>' +
        (tt.tone_analysis ? '<span style="color:var(--muted);"> —— ' + esc(tt.tone_analysis) + '</span>' : '') +
        '</div>' +
        '</div>';
    }

    // 4. 完整整篇文章通读流 (Full Passage Section)
    var fullPassageHtml = "";
    if (examView.readingViewMode === "original" || examView.readingViewMode === "both" || examView.readingViewMode === "full") {
      var paragraphsData = rd.paragraphs || [];
      var bodyParagraphsHtml = "";

      if (paragraphsData && paragraphsData.length) {
        bodyParagraphsHtml = paragraphsData
          .map(function (p, idx) {
            return (
              '<p data-en-para="' + idx + '">' +
              buildHighlightHtml(p.text_en, idx) +
              (examView.readingShowZh && p.text_zh
                ? '<div class="en-passage-zh-para">' + esc(p.text_zh) + '</div>'
                : '') +
              '</p>'
            );
          })
          .join("");
      } else {
        var rawEnParas = (rd.passage || "").split(/\n\n+/);
        var rawZhParas = (rd.passage_zh || "").split(/\n\n+/);
        bodyParagraphsHtml = rawEnParas
          .map(function (pEn, pIdx) {
            return (
              '<p data-en-para="' + pIdx + '">' +
              buildHighlightHtml(pEn, pIdx) +
              (examView.readingShowZh && rawZhParas[pIdx]
                ? '<div class="en-passage-zh-para">' + esc(rawZhParas[pIdx]) + '</div>'
                : '') +
              '</p>'
            );
          })
          .join("");
      }

      var expandPromptHtml = "";
      if (examView.readingViewMode === "original") {
        expandPromptHtml =
          '<div class="en-exam-card" style="margin-top:10px; border:1px dashed var(--line); background:rgba(0,0,0,0.015); padding:14px 18px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">' +
          '<div>' +
          '<div style="font-size:calc(13px * var(--font-scale, 1)); font-weight:600; color:var(--ink);">📖 原文阅读完毕？需要深度剖析？</div>' +
          '<div style="font-size:calc(12px * var(--font-scale, 1)); color:var(--muted);">点击即可展开全文核心主旨、逐段显微镜论证剖析、长难句极简骨架、高频考词与仿真考题。</div>' +
          '</div>' +
          '<button class="en-exam-btn" style="padding:6px 14px; font-size:calc(12px * var(--font-scale, 1));" data-en-exam-action="set-view-mode" data-mode="both">' +
          '💡 展开深度分析 (含逐段显微镜与考点) ▼' +
          '</button>' +
          '</div>';
      }

      fullPassageHtml =
        '<div style="display:flex; flex-direction:column; gap:8px;">' +
        '<div class="en-exam-title" style="justify-content:space-between; flex-wrap:wrap; gap:6px;">' +
        '<span>' + (examView.readingViewMode === "original" ? '📖 英文原文 (Original Text)' : '📖 完整整篇通读 (Full Text Reading)') + '</span>' +
        '<span style="display:flex; align-items:center; gap:6px; font-weight:normal; flex-wrap:wrap;">' +
        '<span style="font-size:calc(11px * var(--font-scale, 1)); color:var(--muted);">选中正文任意词句 → 高亮 / 入生词库 / 翻译 / 改写</span>' +
        readSideButtonsHtml() +
        '</span>' +
        '</div>' +
        '<div class="en-read-surface">' +
        bodyParagraphsHtml +
        '</div>' +
        expandPromptHtml +
        '</div>';
    }

    // 5. 逐段显微镜深度剖析流 (Paragraph-by-Paragraph Micro Analysis)
    var paragraphsMicroHtml = "";
    if (examView.readingViewMode === "both" || examView.readingViewMode === "paragraphs") {
      var pList = rd.paragraphs || [];
      if (pList && pList.length) {
        paragraphsMicroHtml =
          '<div style="display:flex; flex-direction:column; gap:10px; margin-top:6px;">' +
          '<div class="en-exam-title" style="justify-content:space-between;">' +
          '<span>🔬 逐段显微镜深度剖析 (Paragraph-by-Paragraph Analysis)</span>' +
          '<span style="font-size:calc(11px * var(--font-scale, 1)); color:var(--muted); font-weight:normal;">解构每个自然段的论证角色、主旨大意、长难句骨架与潜伏考点</span>' +
          '</div>' +
          '<div class="en-para-micro-stream">' +
          pList
            .map(function (p, idx) {
              var pIdx = p.p_index || idx + 1;
              var isCollapsed = !!examView.collapsedParagraphs[pIdx];

              // 段内核心长难句
              var keySentHtml = "";
              if (p.key_sentence) {
                keySentHtml =
                  '<div class="en-para-sentence-block">' +
                  '<div class="en-para-sent-title">' +
                  '<span>⚡ 段内长难句手术刀 & 骨架提取：</span>' +
                  '<button class="en-exam-btn sec" style="padding:2px 8px; font-size:calc(10px * var(--font-scale, 1));" data-en-exam-action="send-sent-to-syntax" data-sent-text="' + esc(p.key_sentence) + '">✂️ 带入长难句手术刀</button>' +
                  '</div>' +
                  '<div style="font-size:calc(12px * var(--font-scale, 1)); font-style:italic; color:var(--ink); line-height:1.5;">' + esc(p.key_sentence) + '</div>' +
                  (p.key_sentence_backbone
                    ? '<div style="font-size:calc(11px * var(--font-scale, 1)); margin-top:2px;"><b>极简骨架句：</b> <span class="en-para-backbone">' + esc(p.key_sentence_backbone) + '</span></div>'
                    : '') +
                  '</div>';
              }

              // 段内生词与熟词生义
              var vocabHtml = "";
              if ((p.vocab && p.vocab.length) || (p.false_friends && p.false_friends.length)) {
                var vTags = (p.vocab || [])
                  .map(function (v) {
                    return '<span class="en-vocab-tag"><b>' + esc(v.word) + '</b> ' + esc(v.sense) + '</span>';
                  })
                  .join("");

                var ffBadges = (p.false_friends || [])
                  .map(function (ff) {
                    return (
                      '<div class="en-ff-alert">' +
                      '🚨 <b>熟词生义预警</b>：【<b>' + esc(ff.word) + '</b>】日常作「' + esc(ff.common_sense) + '」，文中取「<b>' + esc(ff.exam_sense) + '</b>」' +
                      (ff.example ? ' <i>(' + esc(ff.example) + ')</i>' : '') +
                      '</div>'
                    );
                  })
                  .join("");

                vocabHtml =
                  '<div style="display:flex; flex-direction:column; gap:4px;">' +
                  (vTags ? '<div class="en-para-vocab-row"><span style="font-weight:600; color:var(--muted);">核心生词：</span>' + vTags + '</div>' : '') +
                  (ffBadges || '') +
                  '</div>';
              }

              // 逻辑连接词
              var logicHtml = "";
              if (p.logic_signals && p.logic_signals.length) {
                logicHtml =
                  '<div class="en-logic-hint">' +
                  '<span>🔍 <b>逻辑线索</b>：</span>' +
                  p.logic_signals
                    .map(function (ls) {
                      // 后端字段是 implication，之前读 ls.hint 会渲染出 "undefined"
                      return '<span>【' + esc(ls.signal) + '】(' + esc(ls.type) + ') —— ' + esc(ls.implication || ls.hint || "") + '</span>';
                    })
                    .join("；") +
                  '</div>';
              }

              return (
                '<div class="en-para-micro-card">' +
                // 卡片头
                '<div class="en-para-micro-head">' +
                '<div style="display:flex; align-items:center; gap:8px;">' +
                '<span class="en-para-index-badge">第 ' + pIdx + ' 段</span>' +
                '<span class="en-para-role-tag">' + esc(p.role_badge || '论证主体') + '</span>' +
                '<span style="font-weight:600; font-size:calc(12px * var(--font-scale, 1)); color:var(--ink);">' + esc(p.role || '') + '</span>' +
                '</div>' +
                '<button class="en-exam-btn sec" style="padding:2px 8px; font-size:calc(10px * var(--font-scale, 1));" data-en-exam-action="toggle-para-collapse" data-para-index="' + pIdx + '">' +
                (isCollapsed ? '展开分析 ▼' : '收起分析 ▲') +
                '</button>' +
                '</div>' +

                // 段落核心大意
                '<div class="en-para-idea">💡 <b>段落大意</b>：' + esc(p.main_idea) + '</div>' +

                (!isCollapsed
                  ? // 双语正文
                    '<div class="en-para-bilingual">' +
                    '<div>' + esc(p.text_en) + '</div>' +
                    (p.text_zh ? '<div class="en-para-zh">' + esc(p.text_zh) + '</div>' : '') +
                    '</div>' +
                    keySentHtml +
                    vocabHtml +
                    logicHtml
                  : '') +
                '</div>'
              );
            })
            .join("") +
          '</div>' +
          '</div>';
      }
    }

    // 6. 仿真考题与干扰项陷阱剖析 (仅在展开分析模式下显示)
    var quizHtml = "";
    if (examView.readingViewMode !== "original" && rd.exam_question && rd.exam_question.stem) {
      var q = rd.exam_question;
      var hasAnswered = !!examView.selectedAnswer;
      var isCorrect = examView.selectedAnswer === q.correct_key;

      quizHtml =
        '<div class="en-exam-card" style="margin-top:8px; border-left:3px solid var(--ink);">' +
        '<div class="en-exam-title">🎯 考研真题仿真考题 · 唐迟「阅读的逻辑」解题实测</div>' +
        '<div style="font-size:calc(14px * var(--font-scale, 1)); font-weight:600; color:var(--ink); line-height:1.5;">' + esc(q.stem) + '</div>' +
        '<div style="display:flex; flex-direction:column; gap:8px; margin-top:8px;">' +
        (q.options || [])
          .map(function (opt) {
            var isThis = examView.selectedAnswer === opt.key;
            var cls = "en-quiz-option";
            if (hasAnswered) {
              if (opt.key === q.correct_key) cls += " correct";
              else if (isThis) cls += " wrong";
            } else if (isThis) {
              cls += " selected";
            }
            return (
              '<div class="' + cls + '" data-en-exam-action="select-quiz-option" data-quiz-key="' + esc(opt.key) + '">' +
              '<b style="min-width:20px;">' + esc(opt.key) + '.</b>' +
              '<span>' + esc(opt.text) + '</span>' +
              (hasAnswered && opt.key === q.correct_key ? '<span style="margin-left:auto; color:var(--green); font-weight:600;">✅ 正确答案 (同义替换)</span>' : "") +
              (hasAnswered && isThis && opt.key !== q.correct_key ? '<span style="margin-left:auto; color:var(--red); font-weight:600;">❌ 误踩陷阱</span>' : "") +
              '</div>'
            );
          })
          .join("") +
        "</div>" +
        (hasAnswered
          ? '<div style="margin-top:12px; display:flex; flex-direction:column; gap:8px;">' +
            '<div style="font-weight:600; font-size:calc(13px * var(--font-scale, 1)); color:' + (isCorrect ? "var(--green)" : "var(--red)") + ';">' +
            (isCorrect ? "🎉 恭喜你！精准识破同义替换！" : "🚨 遗憾！不幸踩中命题人预设陷阱。") +
            '</div>' +
            '<div style="font-size:calc(12px * var(--font-scale, 1)); font-weight:600; color:var(--muted);">四大干扰项设坑心机全透视：</div>' +
            '<div style="display:flex; flex-direction:column; gap:6px;">' +
            Object.keys(q.distractor_analysis || {})
              .map(function (k) {
                var isCorKey = k === q.correct_key;
                var colorCls = isCorKey ? "var(--green)" : "var(--red)";
                return (
                  '<div style="font-size:calc(12px * var(--font-scale, 1)); line-height:1.5; background:rgba(0,0,0,0.02); padding:6px 10px; border-radius:6px;">' +
                  '<b style="color:' + colorCls + ';">选项 ' + esc(k) + '</b>：' + esc(q.distractor_analysis[k]) +
                  '</div>'
                );
              })
              .join("") +
            "</div>" +
            (q.defense_tip
              ? '<div style="font-size:calc(12px * var(--font-scale, 1)); color:var(--gold); line-height:1.5; background:rgba(230,162,60,0.08); padding:8px 12px; border-radius:6px;">🛡 <b>唐迟破局指引</b>：' + esc(q.defense_tip) + '</div>'
              : '') +
            '</div>'
          : '<div style="font-size:calc(11px * var(--font-scale, 1)); color:var(--muted); margin-top:4px;">💡 点击上方任一选项，即可立即展开命题人四大陷阱深度诊断与唐迟破局法。</div>') +
        "</div>";
    }

    // 7. 同义改写链提取与入库 (仅在展开分析模式下显示)
    var paraExtractHtml = "";
    if (examView.readingViewMode !== "original" && rd.paraphrases && rd.paraphrases.length) {
      paraExtractHtml =
        '<div class="en-exam-card" style="margin-top:8px;">' +
        '<div class="en-exam-title">🎯 本篇考研同义改写链 (Paraphrase Pairs)</div>' +
        '<div style="display:flex; flex-direction:column; gap:8px;">' +
        rd.paraphrases
          .map(function (p, idx) {
            var pairKey = (p.source_phrase || "") + "->" + (p.target_phrase || "");
            var isSaved = !!(examView.savedParaphraseIds && examView.savedParaphraseIds[pairKey]);
            return (
              '<div class="en-para-item">' +
              '<div class="en-para-head">' +
              '<span>替换模式：' + esc(p.type || "动词/名词抽象化同义替换") + '</span>' +
              (isSaved
                ? '<button class="en-exam-btn" style="padding:2px 10px; font-size:calc(11px * var(--font-scale, 1)); background:var(--green); color:#fff;" data-en-exam-action="go-review-saved">✅ 已排入FSRS</button>'
                : '<button class="en-exam-btn sec" style="padding:2px 8px; font-size:calc(11px * var(--font-scale, 1))" data-en-exam-action="save-para" data-para-idx="' + idx + '">⭐ 存入 FSRS 复习库</button>') +
              '</div>' +
              '<div class="en-para-pair">' +
              '<span class="en-para-src" title="原文原词">' + esc(p.source_phrase) + '</span>' +
              '<span class="en-para-arrow">➔</span>' +
              '<span class="en-para-tgt" title="正确选项同义改写">' + esc(p.target_phrase) + '</span>' +
              '</div>' +
              '<div style="font-size:calc(12px * var(--font-scale, 1)); color:var(--muted); line-height:1.4;">' + esc(p.explanation) + '</div>' +
              (isSaved
                ? '<div style="font-size:calc(11px * var(--font-scale, 1)); color:var(--green); font-weight:500;">📌 已同步至「🎯 考研真题同义替换库」，已按 FSRS 算法立即排入今日首位复习队列</div>'
                : '') +
              '</div>'
            );
          })
          .join("") +
        '</div>' +
        '</div>';
    }

    var bottomCollapseHtml = "";
    if (examView.readingViewMode !== "original") {
      bottomCollapseHtml =
        '<div style="margin-top:14px; display:flex; justify-content:center;">' +
        '<button class="en-exam-btn warn" style="padding:8px 20px; font-size:calc(12px * var(--font-scale, 1)); font-weight:600;" data-en-exam-action="set-view-mode" data-mode="original">' +
        '📖 收起分析 · 只保留英文原文 ▲' +
        '</button>' +
        '</div>';
    }

    /* 独立阅读页：选中文章后整页切进来读正文。
       为什么必须另起一页而不是「拼在下面」：正文原本排在 searchMatrixHtml（检索框 +
       13 刊胶囊 + 主题标签 + 整个文章瀑布流）之后，用户点完文章还得往下滚过一整屏
       列表才看得到第一句原文——「点了没反应」的观感就是这么来的。
       现在点文章即整页切入，原文紧贴顶部，顶栏固定、正文自己滚。 */
    var ffHtml = "";
    if (rd && rd.false_friends && rd.false_friends.length) {
      ffHtml =
        '<div class="en-exam-card" style="border-left:3px solid var(--red,#f56c6c);">' +
        '<div class="en-exam-title">🚨 熟词生义雷达 · 本篇命中 ' + rd.false_friends.length + ' 个</div>' +
        '<div style="display:flex; flex-direction:column; gap:6px;">' +
        rd.false_friends
          .map(function (ff) {
            return (
              '<div class="en-ff-alert">' +
              '【<b>' + esc(ff.word) + '</b>】日常作「' + esc(ff.common_sense || ff.common || "") + '」，文中取「<b>' + esc(ff.exam_sense) + '</b>」' +
              (ff.example ? ' <i>(' + esc(ff.example) + ')</i>' : "") +
              '</div>'
            );
          })
          .join("") +
        '</div>' +
        '</div>';
    }

    if (examView.readerOpen) {
      return readerShell(
        readerBarHtml,
        '<div class="en-reading-container">' +
          thesisToneHtml +
          fullPassageHtml +
          ffHtml +
          paragraphsMicroHtml +
          quizHtml +
          paraExtractHtml +
          bottomCollapseHtml +
          '</div>'
      );
    }


    // 不在阅读页时只给书架列表：正文**不再**拼在列表下面。
    // 这正是本次要修的东西——正文排在检索框 + 13 刊胶囊 + 主题标签 + 整个文章
    // 瀑布流之后，用户点完文章还得往下滚过一整屏才看得到第一句原文。
    // 现在列表就是列表（选中那条会标「点击进入阅读页 ➔」），正文在阅读页里。
    return (
      '<div style="display:flex; flex-direction:column; gap:12px;">' +
      laneSwitchHtml +
      searchMatrixHtml +
      '</div>'
    );
  }

  /* ------------------------------------------------ 模块 1-B：联网实时检索泳道 */

  // 骨架屏：比「正在加载…」更能预告「马上会出现一片卡片」，等待感明显更短。
  // 宽度按下标错开一点，避免整排等宽的灰块看起来像表格线。
  function skeletonCards(count, cls) {
    var out = "";
    for (var i = 0; i < count; i++) {
      out +=
        '<div class="' + (cls || "en-skel-card") + '" aria-hidden="true">' +
        '<div class="en-skel" style="height:13px; width:' + (70 + ((i * 9) % 24)) + '%;"></div>' +
        '<div class="en-skel" style="height:10px; width:94%;"></div>' +
        '<div class="en-skel" style="height:10px; width:58%;"></div>' +
        "</div>";
    }
    return out;
  }

  /* 文章年龄展示：优先用后端算好的 age_days（天），没有就回退到原始日期串。
     目的是让用户一眼分清「今天的新文」和「几个月前的旧文」。 */
  function ageLabel(a) {
    if (a && typeof a.age_days === "number") {
      if (a.age_days <= 0) return "今天";
      if (a.age_days === 1) return "昨天";
      if (a.age_days < 7) return a.age_days + " 天前";
      if (a.age_days < 28) return Math.round(a.age_days / 7) + " 周前";
    }
    return String((a && a.date) || "").slice(0, 16) || "日期未知";
  }

  function renderOnlineLane() {
    // 主题胶囊：由可达源的领域并集动态生成
    var topics = [{ id: "all", name: "全部主题" }];
    var seen = { all: true };
    (examView.onlineSources || []).forEach(function (s) {
      (s.topics || []).forEach(function (t) {
        if (!seen[t]) {
          seen[t] = true;
          topics.push({ id: t, name: t });
        }
      });
    });

    var sourcePills =
      '<div class="en-journal-capsules" role="group" aria-label="按外刊源筛选">' +
      '<button type="button" class="en-journal-pill' + (examView.onlineSourceId === "all" ? " active" : "") + '" data-en-exam-action="filter-online-source" data-source-id="all" aria-pressed="' + (examView.onlineSourceId === "all" ? "true" : "false") + '">' +
      '<span>🌐 全部可达源</span>' +
      '<span class="en-journal-pill-count">' + (examView.onlineSources.length || 0) + '</span>' +
      '</button>' +
      (examView.onlineSources || [])
        .map(function (s) {
          var on = examView.onlineSourceId === s.id;
          return (
            '<button type="button" class="en-journal-pill' + (on ? " active" : "") + '" data-en-exam-action="filter-online-source" data-source-id="' + esc(s.id) + '" aria-pressed="' + (on ? "true" : "false") + '" title="' + esc(s.badge || s.name) + '">' +
            '<span>' + esc(s.name) + '</span>' +
            '<span class="en-journal-pill-count">' + (s.fulltext ? "全文" : "索引") + '</span>' +
            '</button>'
          );
        })
        .join("") +
      '</div>';

    var topicPills =
      '<div class="en-category-row">' +
      '<span style="font-size:calc(11px * var(--font-scale, 1)); color:var(--muted); font-weight:600; white-space:nowrap;">考研主题：</span>' +
      topics
        .map(function (t) {
          var on = examView.onlineTopic === t.id;
          return (
            '<button class="en-cat-btn' + (on ? " active" : "") + '" data-en-exam-action="filter-online-topic" data-topic-id="' + esc(t.id) + '">' +
            esc(t.name) +
            '</button>'
          );
        })
        .join("") +
      '</div>';

    var resultsHtml =
      '<div class="en-article-stream" aria-busy="' + (examView.onlineLoading ? "true" : "false") + '">' +
      (examView.onlineLoading
        ? skeletonCards(6)
        : examView.onlineList && examView.onlineList.length
        ? examView.onlineList
            .map(function (a) {
              var isAct = examView.onlineArticle && examView.onlineArticle.id === a.id;
              // 主内容入口做成真按钮：Tab 可达、回车可开，屏幕阅读器也能报出当前研读项
              return (
                '<button type="button" class="en-article-item' + (isAct ? " active" : "") + '" data-en-exam-action="load-online-article" data-article-id="' + esc(a.id) + '" data-article-url="' + esc(a.url) + '" aria-current="' + (isAct ? "true" : "false") + '">' +
                '<span class="en-item-head">' +
                '<span class="en-item-title">' + (isAct ? "📖 " : "") + esc(a.title) + '</span>' +
                '<span class="en-item-source-badge">' + esc(a.source_name || a.source) + '</span>' +
                '</span>' +
                '<span class="en-item-snippet">' + esc(a.snippet || "") + '</span>' +
                '<span class="en-item-meta">' +
                '<span>🕒 ' + esc(ageLabel(a)) + '</span>' +
                '<span>📂 ' + esc(a.topic || "综合外刊") + '</span>' +
                '<span>📊 ' + (a.word_count || 0) + ' 词</span>' +
                (a.fulltext ? '<span style="color:var(--green,#67c23a);">✔ 可读全文</span>' : '<span style="color:var(--muted);">仅索引</span>') +
                (isAct ? '<span style="color:var(--green); font-weight:600; margin-left:auto;">当前研读中 ✔</span>' : '<span style="color:var(--muted); margin-left:auto;">点击抓取 ➔</span>') +
                '</span>' +
                '</button>'
              );
            })
            .join("")
        : '<div style="grid-column:1/-1; text-align:center; padding:16px; color:var(--muted);">' +
          (examView.onlineStats && examView.onlineStats.sources_ok === 0
            ? "⚠️ " +
              (examView.onlineStats.notice ||
                "所有外刊源都连不上，请检查网络后重试。")
            : "暂无匹配文章。换个关键词，或切到「全部主题」看看各刊最新更新。") +
          '</div>') +
      '</div>';

    var searchBox =
      '<div class="en-search-hero">' +
      '<div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px;">' +
      '<div class="en-step-row">' +
      '<span class="en-step-badge">1</span>' +
      '<span><b>联网实时检索</b> · 国内可达外刊源 · 本地零大语料</span>' +
      '</div>' +
      '<span style="font-size:calc(11px * var(--font-scale, 1)); color:var(--muted);">' +
      (examView.onlineStats && examView.onlineStats.sources_total
        ? "源健康：" + examView.onlineStats.sources_ok + "/" + examView.onlineStats.sources_total + " 在线 · "
        : "") +
      '全文实时抓取 · 不占本地内存 · 点开即读</span>' +
      '</div>' +
      '<div class="en-search-bar">' +
      '<input type="text" id="en-online-search-input" class="en-search-input" placeholder="输入关键词实时检索 (如: AI / memory / climate / sleep)..." value="' + esc(examView.onlineQuery) + '" />' +
      '<button class="en-exam-btn" data-en-exam-action="do-online-search">' +
      (examView.onlineLoading ? "检索中..." : "🔍 联网检索") +
      '</button>' +
      '</div>' +
      sourcePills +
      topicPills +
      resultsHtml +
      '</div>';

    // 选了文章就整页切入阅读页——联网车道的文章正文同样不该埋在搜索框下面。
    // 顶栏只放返回，篇章信息由 renderOnlineReader() 自己的标题栏承担（避免两行标题重复）。
    if (examView.onlineArticle && examView.readerOpen) {
      return readerShell(
        '<div class="en-reader-bar">' +
          '<button class="en-exam-btn sec" style="font-size:calc(12px * var(--font-scale, 1)); padding:5px 12px; flex:0 0 auto;" data-en-exam-action="close-reader" title="回到文章列表">‹ 返回列表</button>' +
          '<div class="en-reader-bar-actions" style="margin-left:auto">' +
          readToolsHtml() +
          '<button class="en-exam-btn sec" style="font-size:calc(11px * var(--font-scale, 1)); padding:4px 10px;" data-en-exam-action="close-reader" title="关闭阅读页，回到文章列表">✕</button>' +
          '</div>' +
          '</div>',
        renderOnlineReader()
      );
    }

    return searchBox + (examView.onlineArticle ? renderOnlineReader() : "");
  }

  function renderOnlineReader() {
    var a = examView.onlineArticle;
    if (!a) return "";

    // 抓取失败的降级卡片：给原因、给摘要、给原文逃生口，绝不留一页空白
    if (a.ok === false) {
      return (
        '<div class="en-reading-container">' +
        '<div class="en-reading-header">' +
        '<div class="en-reading-title-area">' +
        '<div class="en-reading-title">' + esc(a.title) + '</div>' +
        (a.source_name ? '<div class="en-reading-meta-tags"><span class="en-item-source-badge" style="font-size:calc(11px * var(--font-scale, 1));">🌐 ' + esc(a.source_name) + '</span></div>' : "") +
        '</div>' +
        '<div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">' +
        (a.url ? '<a class="en-exam-btn" style="font-size:calc(11px * var(--font-scale, 1)); padding:4px 10px; text-decoration:none;" href="' + esc(a.url) + '" target="_blank" rel="noopener">🔗 在浏览器打开原文</a>' : "") +
        '<button class="en-exam-btn sec" style="font-size:calc(11px * var(--font-scale, 1)); padding:4px 10px;" data-en-exam-action="close-online-article">✕ 关闭</button>' +
        '</div>' +
        '</div>' +
        '<div class="en-exam-card" style="border-left:3px solid var(--red,#f56c6c);">' +
        '<div class="en-exam-title"> :( 这篇正文没能抓取下来</div>' +
        '<div style="font-size:calc(12.5px * var(--font-scale, 1)); color:var(--muted); line-height:1.6;">' + esc(a.error || "抓取失败，请换一篇试试。") +
        '。部分站点反爬较严或需登录，可以：<b>换一篇同源文章</b>，或点上方按钮在浏览器里阅读原文。</div>' +
        (a.snippet
          ? '<div style="margin-top:10px; font-size:calc(12.5px * var(--font-scale, 1)); font-style:italic; color:var(--muted); line-height:1.55; border-top:1px dashed var(--line); padding-top:8px;">摘要：' + esc(a.snippet) + '</div>'
          : "") +
        '</div>' +
        '</div>'
      );
    }

    var paras = onlineParagraphs();

    var passageHtml =
      '<div class="en-online-passage">' +
      paras
        .map(function (p, idx) {
          return '<p data-en-para="' + idx + '">' + buildHighlightHtml(p, idx) + "</p>";
        })
        .join("") +
      '</div>';

    var keyHtml = "";
    if (a.key_sentences && a.key_sentences.length) {
      keyHtml =
        '<div class="en-exam-card" style="border-left:3px solid var(--gold,#e6a23c);">' +
        '<div class="en-exam-title">⚡ 全文核心长难句（可带入手术刀拆句）</div>' +
        a.key_sentences
          .map(function (s) {
            return (
              '<div class="en-exam-row" style="align-items:flex-start; gap:8px; border-bottom:1px dashed var(--line); padding-bottom:6px;">' +
              '<div style="flex:1; font-size:calc(12.5px * var(--font-scale, 1)); font-style:italic; line-height:1.55;">' + esc(s) + '</div>' +
              '<button class="en-exam-btn sec" style="padding:2px 8px; font-size:calc(10px * var(--font-scale, 1)); white-space:nowrap;" data-en-exam-action="send-sent-to-syntax" data-sent-text="' + esc(s) + '">✂️ 拆句</button>' +
              '</div>'
            );
          })
          .join("") +
        '</div>';
    }

    var ffHtml = "";
    if (a.false_friends && a.false_friends.length) {
      ffHtml =
        '<div class="en-exam-card" style="border-left:3px solid var(--red,#f56c6c);">' +
        '<div class="en-exam-title">🚨 熟词生义雷达 · 本篇命中 ' + a.false_friends.length + ' 个</div>' +
        '<div style="display:flex; flex-direction:column; gap:6px;">' +
        a.false_friends
          .map(function (ff) {
            return (
              '<div class="en-ff-alert">' +
              '【<b>' + esc(ff.word) + '</b>】日常作「' + esc(ff.common_sense) + '」，文中取「<b>' + esc(ff.exam_sense) + '</b>」' +
              (ff.example ? ' <i>(' + esc(ff.example) + ')</i>' : "") +
              '</div>'
            );
          })
          .join("") +
        '</div>' +
        '</div>';
    }

    return (
      '<div class="en-reading-container">' +
      '<div class="en-reading-header">' +
      '<div class="en-reading-title-area">' +
      '<div class="en-reading-title">' + esc(a.title) + '</div>' +
      '<div class="en-reading-meta-tags">' +
      '<span class="en-item-source-badge" style="font-size:calc(11px * var(--font-scale, 1));">🌐 ' + esc(a.source_name || a.source) + '</span>' +
      '<span>📂 ' + esc(a.category || "综合外刊") + '</span>' +
      '<span>📊 ' + (a.word_count || 0) + ' 词</span>' +
      '<span>🎯 ' + esc(a.difficulty || "考研英语(一)") + '</span>' +
      (a.date ? '<span>📅 ' + esc(a.date) + '</span>' : "") +
      '</div>' +
      '</div>' +
      '<div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">' +
      (a.url ? '<a class="en-exam-btn sec" style="font-size:calc(11px * var(--font-scale, 1)); padding:4px 10px; text-decoration:none;" href="' + esc(a.url) + '" target="_blank" rel="noopener">🔗 原文</a>' : "") +
      readToolsHtml() +
      readSideButtonsHtml() +
      '<button class="en-exam-btn sec" style="font-size:calc(11px * var(--font-scale, 1)); padding:4px 10px;" data-en-exam-action="close-online-article">✕ 关闭</button>' +
      '</div>' +
      '</div>' +
      passageHtml +
      keyHtml +
      ffHtml +
      '</div>'
    );
  }

  /* ---------------------------------------- 模块 1.5：划词交互层（高亮笔记 / 选区动作 / 侧边分析） */

  var HL_COLORS = [
    { id: "gold", hex: "#e6a23c", name: "琥珀" },
    { id: "blue", hex: "#409eff", name: "海蓝" },
    { id: "green", hex: "#67c23a", name: "青竹" },
    { id: "red", hex: "#f56c6c", name: "朱砂" },
    { id: "purple", hex: "#a06cd5", name: "丁香" },
  ];

  function hlHex(color) {
    for (var i = 0; i < HL_COLORS.length; i++) {
      if (HL_COLORS[i].id === color) return HL_COLORS[i].hex;
    }
    return HL_COLORS[0].hex;
  }

  /* 高亮底色在 JS 里算成 rgba，而不是靠 CSS color-mix：老内核上 color-mix
     会整条声明失效，高亮就直接看不见了，这类「看着像没生效」的坑最难查。 */
  function hlRgba(hex, alpha) {
    var h = String(hex || "").replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) return "rgba(230,162,60," + alpha + ")";
    return (
      "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + alpha + ")"
    );
  }

  /* doc_key 用「来源 + 稳定 id/url」而不是标题：外刊改标题、LLM 重生成标题之后，
     标题一变整篇笔记就全对不上号了。 */
  function currentDocKey() {
    if (examView.onlineMode && examView.onlineArticle) {
      var oa = examView.onlineArticle;
      return "online:" + (oa.url || oa.article_id || oa.title || "");
    }
    var rd = examView.activeReading;
    if (rd) return "local:" + (rd.id || rd.title || "");
    return "";
  }

  function currentDocTitle() {
    if (examView.onlineMode && examView.onlineArticle) {
      return examView.onlineArticle.title || "外刊精读";
    }
    return (examView.activeReading && examView.activeReading.title) || "精读文章";
  }

  /* 段落取法必须和渲染时逐字一致，否则划词算出来的 para_index 会与
     data-en-para 错位，高亮就贴到别的段上去了。 */
  function onlineParagraphs() {
    var a = examView.onlineArticle;
    if (!a) return [];
    if (a.paragraphs && a.paragraphs.length) {
      return a.paragraphs.map(function (p) {
        return String(p == null ? "" : p);
      });
    }
    return String(a.passage || "")
      .split(/\n{2,}/)
      .map(function (s) {
        return s.trim();
      })
      .filter(function (s) {
        return !!s;
      });
  }

  function currentParagraphs() {
    if (examView.onlineMode && examView.onlineArticle) return onlineParagraphs();
    var rd = examView.activeReading;
    if (!rd) return [];
    if (rd.paragraphs && rd.paragraphs.length) {
      return rd.paragraphs.map(function (p) {
        return String((p && p.text_en) || "");
      });
    }
    return String(rd.passage || "").split(/\n\n+/);
  }

  function docHighlights() {
    var key = currentDocKey();
    if (!key) return [];
    return (examView.highlights || []).filter(function (h) {
      return h.doc_key === key;
    });
  }

  function findHighlight(highlightId) {
    var hit = null;
    (examView.highlights || []).forEach(function (h) {
      if (h.highlight_id === highlightId) hit = h;
    });
    return hit;
  }

  async function loadHighlights() {
    var key = currentDocKey();
    if (!key || !window.api) return;
    try {
      var res = await window.api(API + "/highlights?doc_key=" + encodeURIComponent(key));
      if (res && res.ok) examView.highlights = res.items || [];
    } catch (_) {
      // 笔记拉不到不该挡住正文阅读，静默降级成「这篇还没笔记」
    }
    if (window.enVocabRerender) window.enVocabRerender();
  }

  function hlMarkHtml(hl, surface) {
    var hex = hlHex(hl.color);
    var note = String(hl.note || "").trim();
    return (
      '<mark class="en-hl' + (note ? " has-note" : "") + '"' +
      ' data-en-exam-action="open-hl" data-hl-id="' + esc(hl.highlight_id) + '"' +
      ' style="--hl:' + hex + "; --hl-bg:" + hlRgba(hex, 0.24) +
      "; --hl-bg-hover:" + hlRgba(hex, 0.38) + "; --hl-line:" + hlRgba(hex, 0.78) + ';"' +
      ' title="' + esc(note || "点一下写批注") + '">' +
      esc(surface) +
      (note ? '<span class="en-hl-dot" aria-hidden="true"></span>' : "") +
      "</mark>"
    );
  }

  /* 把一段正文里命中的高亮包成 <mark>。
     定位顺序：prefix+quote+suffix 整串锚定（重排版后仍认得出）→ 退化到直接找 quote。
     重叠的高亮直接跳过，不然会出现 mark 套 mark 的错乱。

     当前划词选区也画成一条临时 mark（.en-sel-mark）：任何一次重渲染都会把
     浏览器原生选区清掉，用户就再也看不出「我选的到底是哪段」了。
     关掉浮出条后 sel 置空，这条标记自动消失，不需要额外清理。 */
  function buildHighlightHtml(rawText, paraIndex) {
    var text = String(rawText == null ? "" : rawText);
    var key = currentDocKey();
    if (!key) return esc(text);

    var spans = [];
    (examView.highlights || []).forEach(function (h) {
      if (h.doc_key !== key) return;
      if (Number(h.para_index) !== paraIndex) return;
      var q = String(h.quote || "");
      if (!q) return;
      var pre = String(h.prefix || "");
      var suf = String(h.suffix || "");
      var start = -1;
      if (pre || suf) {
        var at = text.indexOf(pre + q + suf);
        if (at >= 0) start = at + pre.length;
      }
      if (start < 0) start = text.indexOf(q);
      if (start >= 0) spans.push({ start: start, end: start + q.length, hl: h });
    });

    var s = examView.sel;
    if (s && Number(s.paraIndex) === paraIndex && s.text) {
      var selStart = -1;
      if (s.prefix || s.suffix) {
        var selAt = text.indexOf(s.prefix + s.text + s.suffix);
        if (selAt >= 0) selStart = selAt + s.prefix.length;
      }
      if (selStart < 0) selStart = text.indexOf(s.text);
      if (selStart >= 0) spans.push({ start: selStart, end: selStart + s.text.length, selMark: true });
    }

    if (!spans.length) return esc(text);

    spans.sort(function (a, b) {
      return a.start - b.start || b.end - a.end || (b.selMark ? 1 : 0) - (a.selMark ? 1 : 0);
    });
    var out = "";
    var cursor = 0;
    spans.forEach(function (sp) {
      if (sp.start < cursor) return;
      out += esc(text.slice(cursor, sp.start));
      var surface = text.slice(sp.start, sp.end);
      out += sp.selMark
        ? '<mark class="en-sel-mark" title="当前选中的内容">' + esc(surface) + "</mark>"
        : hlMarkHtml(sp.hl, surface);
      cursor = sp.end;
    });
    return out + esc(text.slice(cursor));
  }

  function readSideButtonsHtml() {
    var n = docHighlights().length;
    return (
      '<button type="button" class="en-exam-btn sec" style="font-size:calc(11px * var(--font-scale, 1)); padding:4px 10px;" data-en-exam-action="open-side" data-side-tab="notes">🖍 高亮笔记' +
      (n ? " " + n : "") +
      "</button>" +
      '<button type="button" class="en-exam-btn sec" style="font-size:calc(11px * var(--font-scale, 1)); padding:4px 10px;" data-en-exam-action="open-side" data-side-tab="collocations">📊 侧边分析</button>'
    );
  }

  /* 从当前选区读出「选了什么、在第几段、前后文是什么」。
     prefix/suffix 各取 40 字，够锚定又不至于把整段塞进数据库。 */
  function captureSelection(surfaceEl) {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    var range = sel.getRangeAt(0);
    var node = range.startContainer;
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    var pEl = el && el.closest ? el.closest("[data-en-para]") : null;
    if (!pEl) return;
    if (surfaceEl && !surfaceEl.contains(pEl)) return;

    var text = String(sel.toString() || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return;

    var paraIndex = parseInt(pEl.getAttribute("data-en-para"), 10);
    if (isNaN(paraIndex)) return;

    var full = currentParagraphs()[paraIndex] || "";
    var at = full.indexOf(text);
    if (at < 0) {
      full = pEl.textContent || "";
      at = full.indexOf(text);
    }
    var prefix = at > 0 ? full.slice(Math.max(0, at - 40), at) : "";
    var suffix = at >= 0 ? full.slice(at + text.length, at + text.length + 40) : "";

    var rect = range.getBoundingClientRect();
    examView.sel = {
      text: text,
      paraIndex: paraIndex,
      prefix: prefix,
      suffix: suffix,
      x: rect.left + rect.width / 2,
      y: rect.top,
      wordCount: (text.match(/[A-Za-z][A-Za-z\-']*/g) || []).length,
    };
    examView.selResult = null;
    examView.selBusy = "";
    if (window.enVocabRerender) window.enVocabRerender();
  }

  function closeSelection() {
    examView.sel = null;
    examView.selResult = null;
    examView.selBusy = "";
    if (window.enVocabRerender) window.enVocabRerender();
  }

  function selToast(msg) {
    examView.selToast = msg;
    if (window.enVocabRerender) window.enVocabRerender();
    setTimeout(function () {
      if (examView.selToast === msg) {
        examView.selToast = "";
        if (window.enVocabRerender) window.enVocabRerender();
      }
    }, 2600);
  }

  var SEL_ACTIONS = [
    { id: "sel-highlight", label: "🖍 高亮笔记", hint: "存进本篇笔记，可写批注" },
    { id: "sel-vocab", label: "📒 入生词库", hint: "查词典并挂上文中原句" },
    { id: "sel-syntax", label: "✂️ 拆长难句", hint: "骨架 + 成分分层" },
    { id: "sel-translate", label: "🌐 翻译", hint: "整句译文 + 翻译难点" },
    { id: "sel-rewrite", label: "🔄 同义改写", hint: "TJU-LLM 等价改写" },
  ];

  function renderSelOverlay() {
    var toast = examView.selToast
      ? '<div class="en-sel-toast">' + esc(examView.selToast) + "</div>"
      : "";
    var s = examView.sel;
    if (!s) return toast;

    var width = Math.min(620, Math.max(300, window.innerWidth - 24));
    var left = Math.max(12, Math.min(s.x - width / 2, window.innerWidth - width - 12));
    var top = Math.max(12, s.y - 112);

    var busy = examView.selBusy;
    var btns = SEL_ACTIONS.map(function (a) {
      var on = busy === a.id;
      return (
        '<button type="button" class="en-sel-btn' + (on ? " busy" : "") + '"' +
        ' data-en-exam-action="' + a.id + '" title="' + esc(a.hint) + '"' +
        (busy ? " disabled" : "") +
        ">" + (on ? "处理中…" : a.label) + "</button>"
      );
    }).join("");

    return (
      toast +
      '<div class="en-sel-bar" style="left:' + left + "px; top:" + top + "px; width:" + width + 'px;">' +
      '<div class="en-sel-quote" title="' + esc(s.text) + '">' + esc(s.text) + "</div>" +
      '<div class="en-sel-actions">' + btns +
      '<button type="button" class="en-sel-btn ghost" data-en-exam-action="sel-close" title="关闭（Esc）">✕</button>' +
      "</div>" +
      renderSelResult() +
      "</div>"
    );
  }

  function renderSelResult() {
    var r = examView.selResult;
    if (!r) return "";
    var head =
      '<div class="en-sel-res-head"><span>' + esc(r.title || "") + "</span>" +
      '<button type="button" class="en-sel-x" data-en-exam-action="sel-close-result" title="收起">✕</button></div>';

    var body = "";
    if (r.kind === "translate") {
      body =
        (r.translation
          ? '<div class="en-sel-res-main">' + esc(r.translation) + "</div>"
          : '<div class="en-sel-res-hint">' + esc(r.notice || "暂无整句译文，稍后重试。") + "</div>") +
        (r.notes ? '<div class="en-sel-res-note">🪧 ' + esc(r.notes) + "</div>" : "") +
        ((r.keywords || []).length
          ? '<div class="en-sel-kw">' +
            r.keywords
              .map(function (k) {
                return '<span class="en-sel-kw-item"><b>' + esc(k.word) + "</b> " + esc(k.meaning) + "</span>";
              })
              .join("") +
            "</div>"
          : "");
    } else if (r.kind === "rewrite") {
      body =
        (r.core_meaning ? '<div class="en-sel-res-note">🎯 原句核心：' + esc(r.core_meaning) + "</div>" : "") +
        ((r.rewrites || []).length
          ? '<div class="en-sel-res-list">' +
            r.rewrites
              .map(function (w, i) {
                var swaps = (w.swaps || [])
                  .map(function (sp) {
                    return '<span class="en-sel-swap"><s>' + esc(sp.from) + "</s> → <b>" + esc(sp.to) + "</b></span>";
                  })
                  .join("");
                return (
                  '<div class="en-sel-res-item">' +
                  '<div class="en-sel-res-line"><span class="en-sel-idx">' + (i + 1) + "</span>" + esc(w.rewritten || "") + "</div>" +
                  (w.strategy ? '<span class="en-sel-tag">' + esc(w.strategy) + "</span>" : "") +
                  (swaps ? '<div class="en-sel-swaps">' + swaps + "</div>" : "") +
                  (w.note ? '<div class="en-sel-res-note">' + esc(w.note) + "</div>" : "") +
                  "</div>"
                );
              })
              .join("") +
            "</div>"
          : '<div class="en-sel-res-hint">' + esc(r.notice || "这句里没有可替换的考纲高频词。") + "</div>");
    } else if (r.kind === "vocab") {
      body =
        '<div class="en-sel-res-main"><b>' + esc(r.lemma || "") + "</b> " + esc(r.meaning || "") + "</div>" +
        '<div class="en-sel-res-note">' + esc(r.notice || "") + "</div>";
    } else {
      body = '<div class="en-sel-res-hint">' + esc(r.notice || "") + "</div>";
    }

    return '<div class="en-sel-result">' + head + body + "</div>";
  }

  /* ------------------------------------------------------------ 侧边分析抽屉 */

  function renderSideDrawer() {
    if (!examView.sideOpen) return "";
    var tabs = [
      { id: "notes", label: "📝 高亮笔记" },
      { id: "collocations", label: "🧩 搭配提取" },
      { id: "argument", label: "🏗 论证结构" },
      { id: "false-friends", label: "⚠️ 熟词生义" },
    ];
    var tabHtml = tabs
      .map(function (t) {
        return (
          '<button type="button" class="en-side-tab' + (examView.sideTab === t.id ? " active" : "") + '"' +
          ' data-en-exam-action="side-tab" data-side-tab="' + t.id + '">' + t.label + "</button>"
        );
      })
      .join("");

    var body = "";
    if (examView.sideTab === "notes") body = renderSideNotes();
    else if (examView.sideTab === "collocations") body = renderSideCollocations();
    else if (examView.sideTab === "false-friends") body = renderSideFalseFriends();
    else body = renderSideArgument();

    return (
      '<aside class="en-side-drawer" aria-label="原文侧边分析">' +
      '<div class="en-side-head">' +
      '<span class="en-side-title">📐 原文侧边分析</span>' +
      '<button type="button" class="en-sel-x" data-en-exam-action="close-side" title="关闭（Esc）">✕</button>' +
      "</div>" +
      '<div class="en-side-tabs">' + tabHtml + "</div>" +
      '<div class="en-side-body">' + body + "</div>" +
      "</aside>"
    );
  }

  function hlSwatchesHtml(current) {
    return HL_COLORS.map(function (c) {
      return (
        '<button type="button" class="en-hl-swatch' + (c.id === current ? " on" : "") + '"' +
        ' data-en-exam-action="pick-hl-color" data-color="' + c.id + '"' +
        ' style="--hl:' + c.hex + ';" title="' + esc(c.name) + '" aria-label="' + esc(c.name) + '"></button>'
      );
    }).join("");
  }

  function renderSideNotes() {
    var items = docHighlights();
    if (!items.length) {
      return (
        '<div class="en-side-empty">这篇还没有高亮。选中正文里的词句，点「🖍 高亮笔记」就能存下来，还能补批注。<br />' +
        "笔记按文章归档，文章重排版后靠前后文重新定位，不会丢。</div>"
      );
    }
    var cards = items.map(function (h) {
      var editing = examView.hlEditingId === h.highlight_id;
      var note = String(h.note || "");
      var opsHtml;
      if (editing) {
        opsHtml =
          '<textarea class="en-exam-textarea" style="min-height:56px;" id="en-hl-note-input" placeholder="写点什么：这处为什么重要？命题点在哪？">' +
          esc(examView.hlDraft) +
          "</textarea>" +
          '<div class="en-side-note-ops">' +
          '<span class="en-hl-swatches">' + hlSwatchesHtml(h.color) + "</span>" +
          '<button type="button" class="en-exam-btn" style="padding:3px 10px; font-size:calc(11px * var(--font-scale, 1));" data-en-exam-action="save-hl-note" data-hl-id="' + esc(h.highlight_id) + '">保存批注</button>' +
          "</div>";
      } else {
        opsHtml =
          '<div class="en-side-note-text' + (note ? "" : " empty") + '">' + esc(note || "（还没写批注）") + "</div>" +
          '<div class="en-side-note-ops">' +
          '<button type="button" class="en-exam-btn sec" style="padding:3px 10px; font-size:calc(11px * var(--font-scale, 1));" data-en-exam-action="edit-hl-note" data-hl-id="' + esc(h.highlight_id) + '">' +
          (note ? "改批注" : "写批注") +
          "</button>" +
          '<button type="button" class="en-exam-btn sec" style="padding:3px 10px; font-size:calc(11px * var(--font-scale, 1));" data-en-exam-action="jump-hl" data-hl-id="' + esc(h.highlight_id) + '">定位</button>' +
          '<button type="button" class="en-exam-btn sec" style="padding:3px 10px; font-size:calc(11px * var(--font-scale, 1));" data-en-exam-action="del-hl" data-hl-id="' + esc(h.highlight_id) + '">删除</button>' +
          "</div>";
      }
      return (
        '<div class="en-side-note" style="--hl:' + hlHex(h.color) + ';">' +
        '<div class="en-side-note-quote">' + esc(h.quote) + "</div>" +
        opsHtml +
        "</div>"
      );
    });
    return (
      '<div class="en-side-hint">共 ' + items.length + " 条 · 点「定位」跳回原文对应位置</div>" +
      '<div class="en-side-list">' + cards.join("") + "</div>"
    );
  }

  /* 结果已按篇缓存在后端；这个按钮只是让用户对不满意的提取结果手动重算一遍 */
  function sideRefreshBtn() {
    return (
      '<div style="display:flex; justify-content:flex-end; margin:2px 0 6px;">' +
      '<button type="button" class="en-exam-btn sec" style="padding:2px 9px; font-size:calc(10.5px * var(--font-scale, 1));"' +
      ' data-en-exam-action="refresh-side" title="重新提取一遍，会覆盖当前结果">↻ 重新生成</button></div>'
    );
  }

  function renderSideCollocations() {
    if (examView.sideBusy) return '<div class="en-side-empty">正在从全文里捞搭配…</div>';
    var side = examView.side;
    if (!side) return sideRefreshBtn() + '<div class="en-side-empty">' + esc(examView.sideError || "打开文章后这里会自动提取全文高频搭配。") + "</div>";
    var items = side.collocations || [];
    if (!items.length) return sideRefreshBtn() + '<div class="en-side-empty">这篇没命中本地高频搭配表，TJU-LLM 也没补上。</div>';
    return (
      '<div class="en-side-hint">共 ' + items.length + " 条" + (side.collocation_ai ? " · 含 TJU-LLM 补充" : "") + " · 每条都带文中原句</div>" +
      sideRefreshBtn() +
      '<div class="en-side-list">' +
      items
        .map(function (c) {
          return (
            '<div class="en-side-coll">' +
            '<div class="en-side-coll-head"><b>' + esc(c.phrase) + "</b>" +
            (c.kind ? '<span class="en-sel-tag">' + esc(c.kind) + "</span>" : "") +
            (c.ai ? '<span class="en-sel-tag ai">AI 补</span>' : "") +
            "</div>" +
            (c.meaning ? '<div class="en-side-coll-mean">' + esc(c.meaning) + "</div>" : "") +
            (c.sentence ? '<div class="en-side-coll-sent">' + esc(c.sentence) + "</div>" : "") +
            "</div>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function renderSideArgument() {
    if (examView.sideBusy) return '<div class="en-side-empty">正在拆解论证骨架…</div>';
    var side = examView.side;
    if (!side || !side.argument) {
      return sideRefreshBtn() + '<div class="en-side-empty">' + esc(examView.sideError || "打开文章后这里会自动拆出全文论证骨架。") + "</div>";
    }
    var arg = side.argument;
    var skeleton = arg.skeleton || [];
    if (!skeleton.length) return sideRefreshBtn() + '<div class="en-side-empty">这篇没有可拆的段落结构。</div>';
    var methodsLine = (arg.methods && arg.methods.length)
      ? " · 论证方法：" + arg.methods.map(esc).join(" · ")
      : "";
    return (
      '<div class="en-side-hint">' + (arg.total || skeleton.length) + " 段" + methodsLine + "</div>" +
      (arg.flow ? '<div class="en-side-hint" style="margin-top:2px;">论证流向：' + esc(arg.flow) + "</div>" : "") +
      sideRefreshBtn() +
      (arg.thesis ? '<div class="en-side-thesis"><span>中心论点（首段）</span>' + esc(arg.thesis) + "</div>" : "") +
      '<div class="en-side-list">' +
      skeleton
        .map(function (p) {
          var methodTags = ((p.method || []).map(function (m) {
            return '<span class="en-sel-tag method">' + esc(m) + "</span>";
          })).join("");
          return (
            '<div class="en-side-arg">' +
            '<div class="en-side-arg-head">' +
            '<span class="en-side-arg-idx">第 ' + (p.index + 1) + " 段</span>" +
            '<span class="en-side-arg-role">' + esc(p.role) + "</span>" +
            methodTags +
            (p.relation ? '<span class="en-sel-tag">' + esc(p.relation) + "</span>" : "") +
            "</div>" +
            '<div class="en-side-arg-gist">' + esc(p.gist) + "</div>" +
            ((p.signals || []).length
              ? '<div class="en-side-arg-signals">' +
                p.signals
                  .map(function (sg) {
                    return '<span class="en-sel-tag sig">' + esc(sg) + "</span>";
                  })
                  .join("") +
                "</div>"
              : "") +
            "</div>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  /* 整篇熟词生义：数据在篇章落地时就算好了（本地母源库自带，联网篇抓完即扫），
     直接读当前篇的那份，不再为划一小段而多跑一趟网络。 */
  function currentFalseFriends() {
    if (examView.onlineMode && examView.onlineArticle) {
      return examView.onlineArticle.false_friends || [];
    }
    var rd = examView.activeReading;
    return (rd && rd.false_friends) || [];
  }

  function renderSideFalseFriends() {
    var items = currentFalseFriends();
    if (!items.length) {
      return '<div class="en-side-empty">这篇没有命中高频熟词生义。僻义库整篇扫过一遍，说明本篇用词比较本分。</div>';
    }
    return (
      '<div class="en-side-hint">共 ' + items.length + " 个 · 日常义之外，考研真题常考这些僻义</div>" +
      '<div class="en-side-list">' +
      items
        .map(function (ff) {
          return (
            '<div class="en-side-coll">' +
            '<div class="en-side-coll-head"><b>' + esc(ff.word) + "</b></div>" +
            '<div class="en-side-coll-mean">日常作「' + esc(ff.common_sense || ff.common || "") + "」</div>" +
            '<div class="en-side-coll-mean" style="color:var(--red, #f56c6c);">考研考「' + esc(ff.exam_sense || "") + "」</div>" +
            (ff.example ? '<div class="en-side-coll-sent">' + esc(ff.example) + "</div>" : "") +
            "</div>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  async function loadSideAnalysis(force) {
    if (!force && examView.side) return;
    var paras = currentParagraphs();
    if (!paras.length) {
      examView.sideError = "先打开一篇精读文章，侧边分析才有原文可拆。";
      if (window.enVocabRerender) window.enVocabRerender();
      return;
    }
    examView.sideBusy = true;
    examView.sideError = "";
    if (window.enVocabRerender) window.enVocabRerender();
    try {
      if (window.api) {
        var res = await window.api(API + "/side-analysis", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: paras.join("\n\n"),
            paragraphs: paras,
            doc_key: currentDocKey(),
            // 结果按篇存在后端：再进来秒出旧结果；force=true 才重新过模型
            force: force === true,
          }),
        });
        if (res && res.ok) examView.side = res;
      }
    } catch (err) {
      examView.sideError = friendlyErr(err, "侧边分析失败：");
    } finally {
      examView.sideBusy = false;
      if (window.enVocabRerender) window.enVocabRerender();
    }
  }

  /* ------------------------------------------------------------ 选区动作 */

  function selGuard() {
    var s = examView.sel;
    if (!s || !s.text) {
      selToast("请先在正文里选中一段文字。");
      return null;
    }
    return s;
  }

  async function selHighlight() {
    var s = selGuard();
    if (!s) return;
    var key = currentDocKey();
    if (!key) {
      selToast("还没打开文章，先载入一篇再高亮。");
      return;
    }
    examView.selBusy = "sel-highlight";
    if (window.enVocabRerender) window.enVocabRerender();
    try {
      var res = await window.api(API + "/highlights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          doc_key: key,
          doc_title: currentDocTitle(),
          quote: s.text,
          para_index: s.paraIndex,
          prefix: s.prefix,
          suffix: s.suffix,
          color: "gold",
        }),
      });
      if (res && res.ok && res.item) {
        examView.highlights = (examView.highlights || []).concat([res.item]);
        examView.sel = null;
        examView.selResult = null;
        selToast("已高亮，存入本篇笔记（共 " + docHighlights().length + " 条）。点它可写批注。");
      }
    } catch (err) {
      selToast(friendlyErr(err, "高亮失败："));
    } finally {
      examView.selBusy = "";
      if (window.enVocabRerender) window.enVocabRerender();
    }
  }

  async function selAddVocab() {
    var s = selGuard();
    if (!s) return;
    var one = s.text.trim();
    if (s.wordCount !== 1 || !/^[A-Za-z][A-Za-z\-']*$/.test(one)) {
      examView.selResult = {
        kind: "plain",
        title: "整段收词",
        notice:
          "划词入生词库只收单个单词。整段或整句请拆成单个词再划取，一次收一个。",
      };
      if (window.enVocabRerender) window.enVocabRerender();
      return;
    }
    examView.selBusy = "sel-vocab";
    if (window.enVocabRerender) window.enVocabRerender();
    try {
      var res = await window.api(API + "/selection-vocab", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          word: one,
          sample: s.prefix + s.text + s.suffix,
          source_title: currentDocTitle(),
        }),
      });
      if (res && res.ok) {
        examView.selResult = {
          kind: "vocab",
          title: "已收进生词本",
          lemma: res.lemma,
          meaning: res.meaning,
          notice: res.added
            ? "已排入复习队列。待加入池子里还有 " + (res.pending || 0) + " 个词。"
            : "这个词之前已在词库里，这次补挂了文中原句。",
        };
      }
    } catch (err) {
      examView.selResult = { kind: "plain", title: "收词失败", notice: friendlyErr(err, "") };
    } finally {
      examView.selBusy = "";
      if (window.enVocabRerender) window.enVocabRerender();
    }
  }

  async function selTranslate() {
    var s = selGuard();
    if (!s) return;
    examView.selBusy = "sel-translate";
    examView.selResult = null;
    if (window.enVocabRerender) window.enVocabRerender();
    try {
      var res = await window.api(API + "/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: s.text, context: s.prefix + " " + s.suffix }),
      });
      if (res && res.ok) {
        examView.selResult = {
          kind: "translate",
          title: res.ai_generated ? "TJU-LLM 译文" : "逐词释义（TJU-LLM 暂不可用）",
          translation: res.translation || "",
          notes: res.notes || "",
          keywords: res.keywords || [],
          notice: res.notice || "",
        };
      }
    } catch (err) {
      examView.selResult = { kind: "plain", title: "翻译失败", notice: friendlyErr(err, "") };
    } finally {
      examView.selBusy = "";
      if (window.enVocabRerender) window.enVocabRerender();
    }
  }

  async function selRewrite() {
    var s = selGuard();
    if (!s) return;
    examView.selBusy = "sel-rewrite";
    examView.selResult = null;
    examView.rewriteSentence = s.text;
    if (window.enVocabRerender) window.enVocabRerender();
    try {
      var res = await window.api(API + "/paraphrase-rewrite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sentence: s.text, count: 3 }),
      });
      if (res && res.ok) {
        examView.rewriteResult = res;
        examView.selResult = {
          kind: "rewrite",
          title: res.ai_generated ? "TJU-LLM 同义改写" : "词级替换版改写（TJU-LLM 暂不可用）",
          core_meaning: res.core_meaning || "",
          rewrites: res.rewrites || [],
          notice: res.notice || "",
        };
      }
    } catch (err) {
      examView.selResult = { kind: "plain", title: "改写失败", notice: friendlyErr(err, "") };
    } finally {
      examView.selBusy = "";
      if (window.enVocabRerender) window.enVocabRerender();
    }
  }

  /* 长难句不走浮出卡：拆句结果本身有一整套成分卡 UI，
     塞进小浮窗只会缩成一团。直接把句子送进手术刀页签。 */
  async function selSyntax() {
    var s = selGuard();
    if (!s) return;
    examView.selBusy = "sel-syntax";
    if (window.enVocabRerender) window.enVocabRerender();
    try {
      var res = await window.api(API + "/syntax-parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sentence: s.text }),
      });
      if (res && res.ok) {
        examView.sentenceInput = s.text;
        examView.syntaxResult = res;
        resetSyntaxPartState();
        examView.subTab = "syntax";
        examView.sel = null;
        examView.selResult = null;
        examView.notice = "已把选中的句子送进长难句手术刀。";
      }
    } catch (err) {
      selToast(friendlyErr(err, "拆句失败："));
    } finally {
      examView.selBusy = "";
      if (window.enVocabRerender) window.enVocabRerender();
    }
  }

  async function patchHighlight(highlightId, patch) {
    if (!highlightId) return;
    try {
      var res = await window.api(API + "/highlights/note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ highlight_id: highlightId, note: patch.note, color: patch.color }),
      });
      if (res && res.ok && res.item) {
        examView.highlights = (examView.highlights || []).map(function (h) {
          return h.highlight_id === res.item.highlight_id ? res.item : h;
        });
      }
    } catch (err) {
      selToast(friendlyErr(err, "保存失败："));
    } finally {
      if (window.enVocabRerender) window.enVocabRerender();
    }
  }

  async function removeHighlight(highlightId) {
    if (!highlightId) return;
    try {
      var res = await window.api(API + "/highlights/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ highlight_id: highlightId }),
      });
      if (res && res.ok) {
        examView.highlights = (examView.highlights || []).filter(function (h) {
          return h.highlight_id !== highlightId;
        });
        if (examView.hlEditingId === highlightId) examView.hlEditingId = "";
      }
    } catch (err) {
      selToast(friendlyErr(err, "删除失败："));
    } finally {
      if (window.enVocabRerender) window.enVocabRerender();
    }
  }

  function jumpToHighlight(highlightId) {
    var safe = String(highlightId || "").replace(/[^A-Za-z0-9_\-]/g, "");
    if (!safe) return;
    var el = document.querySelector('mark[data-hl-id="' + safe + '"]');
    if (!el) {
      selToast("这处高亮在当前视图里没找到，可能正文还没渲染出来。");
      return;
    }
    if (el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("is-flash");
    setTimeout(function () {
      el.classList.remove("is-flash");
    }, 1200);
  }

  async function doParaphraseRewrite() {
    var el = document.getElementById("en-rewrite-sentence");
    var txt = el ? el.value.trim() : examView.rewriteSentence;
    if (!txt) {
      examView.error = "请先输入，或从正文划词带入一句要改写的英文。";
      if (window.enVocabRerender) window.enVocabRerender();
      return;
    }
    examView.rewriteSentence = txt;
    examView.rewriteBusy = true;
    examView.error = "";
    if (window.enVocabRerender) window.enVocabRerender();
    try {
      var res = await window.api(API + "/paraphrase-rewrite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sentence: txt, count: 3 }),
      });
      if (res && res.ok) {
        examView.rewriteResult = res;
        if (res.ai_generated) examView.notice = "TJU-LLM 已生成同义改写。";
      }
    } catch (err) {
      examView.error = friendlyErr(err, "改写失败：");
    } finally {
      examView.rewriteBusy = false;
      if (window.enVocabRerender) window.enVocabRerender();
    }
  }

  /* ------------------------------------------------------------ 模块 2：田静长难句手术刀 */

  /* 后端（LLM 与规则引擎两路）统一返回 role / role_label / depth / can_collapse。
     这里把 role 归到「主干 / 修饰从句 / 插入语」三族，用于配色与层级视觉；
     中文名优先用后端给的 role_label，缺失时才按 role 兜底翻译。 */
  var SYNTAX_FAMILY = {
    main: "trunk", predicate_obj: "trunk", subject: "trunk", predicate: "trunk",
    object: "trunk", other: "trunk", trunk: "trunk",
    attr_clause: "clause", adv_clause: "clause", clause: "clause",
    parenthesis: "insert", insert: "insert",
  };
  var SYNTAX_FAMILY_ZH = { trunk: "主干", clause: "修饰从句", insert: "插入语" };
  var SYNTAX_ROLE_ZH = {
    main: "主句主干", predicate_obj: "谓语/宾语", subject: "主语", predicate: "谓语",
    object: "宾语", other: "其他成分", trunk: "主干",
    attr_clause: "定语从句", adv_clause: "状语从句", clause: "修饰从句",
    parenthesis: "插入语", insert: "插入语",
  };

  function syntaxFamily(role) {
    return SYNTAX_FAMILY[String(role || "").toLowerCase()] || "trunk";
  }

  function syntaxPartZh(c) {
    return c.role_label || SYNTAX_ROLE_ZH[String(c.role || "").toLowerCase()] || c.role || "";
  }

  // 换句子就要把上一条句子的折叠/聚焦状态清掉，否则下标会串到新句子的成分上
  function resetSyntaxPartState() {
    examView.collapsedParts = {};
    examView.syntaxFocus = null;
  }

  function renderSyntaxPart(c, idx) {
    var fam = syntaxFamily(c.role);
    var depth = Math.min(Number(c.depth) || 0, 2);
    var canCollapse = !!c.can_collapse;
    var collapsed = canCollapse && !!examView.collapsedParts[idx];
    var focused = examView.syntaxFocus === idx;
    var zh = c.zh || c.text_zh || "";
    var detail = syntaxPartZh(c);
    var words = String(c.text || "").split(/\s+/).filter(Boolean).length;

    // 可折叠的给一个真按钮（带 aria-expanded），不可折叠的放一个等宽占位，
    // 这样同一列卡片左边缘对齐，不会因为有没有箭头而参差。
    var toggleHtml = canCollapse
      ? '<button type="button" class="en-comp-toggle" data-en-exam-action="toggle-syntax-part" data-part-index="' + idx + '"' +
        ' aria-expanded="' + (collapsed ? "false" : "true") + '" aria-label="' + esc((collapsed ? "展开" : "折叠") + detail) + '"' +
        ' title="' + esc(collapsed ? "展开这条修饰成分" : "折叠这条修饰成分") + '">▾</button>'
      : '<span class="en-comp-toggle is-static" aria-hidden="true">·</span>';

    return (
      '<div class="en-comp en-comp-' + fam + (collapsed ? " is-collapsed" : "") + (focused ? " is-focus" : "") + '" data-depth="' + depth + '">' +
      '<div class="en-comp-head">' +
      toggleHtml +
      '<button type="button" class="en-comp-focus" data-en-exam-action="focus-syntax-part" data-part-index="' + idx + '"' +
      ' aria-pressed="' + (focused ? "true" : "false") + '" title="聚焦这一成分，压暗其余">' +
      '<span class="en-comp-role">' + esc(SYNTAX_FAMILY_ZH[fam]) + "</span>" +
      '<span class="en-comp-label">' + esc(detail || words + " 词") + "</span>" +
      "</button>" +
      "</div>" +
      '<div class="en-comp-body">' +
      '<div class="en-comp-text">' + esc(c.text || "") + "</div>" +
      (zh ? '<div class="en-comp-zh">' + esc(zh) + "</div>" : "") +
      "</div>" +
      "</div>"
    );
  }

  function renderSyntaxSection() {
    var val = esc(examView.sentenceInput || "");
    var resHtml = "";

    if (examView.syntaxResult) {
      var r = examView.syntaxResult;
      var comps = r.components || [];

      var bbHtml =
        '<div class="en-syntax-backbone">' +
        '<div class="en-syntax-backbone-label">🎯 提炼出的极简主干句 (Core Skeleton)</div>' +
        '<div class="en-syntax-backbone-text">' +
        esc(r.backbone || r.skeleton || "未能提取到主干，建议换一句结构更完整的长难句") +
        "</div>" +
        (r.backbone_zh ? '<div class="en-syntax-backbone-zh">' + esc(r.backbone_zh) + "</div>" : "") +
        "</div>";

      var compHtml = "";
      if (comps.length) {
        var collapsible = [];
        comps.forEach(function (c, i) {
          if (c.can_collapse) collapsible.push(i);
        });
        var collapsedCount = collapsible.filter(function (i) {
          return !!examView.collapsedParts[i];
        }).length;
        var allCollapsed = collapsible.length > 0 && collapsedCount === collapsible.length;
        var hasFocus = examView.syntaxFocus !== null && examView.syntaxFocus !== undefined;

        compHtml =
          '<div style="display:flex; flex-direction:column; gap:8px;">' +
          '<div class="en-exam-row" style="justify-content:space-between;">' +
          '<span style="font-size:var(--text-sm); font-weight:600; color:var(--muted);">结构化分层拆解 · 共 ' + comps.length + ' 个成分</span>' +
          (collapsible.length
            ? '<button class="en-exam-btn sec" style="padding:3px 10px; font-size:var(--text-xs);" data-en-exam-action="toggle-all-syntax-parts">' +
              (allCollapsed
                ? "展开全部枝叶（" + collapsible.length + "）"
                : "只看主干（折叠 " + collapsible.length + " 处枝叶）") +
              "</button>"
            : "") +
          "</div>" +
          '<div class="en-comp-stream' + (hasFocus ? " has-focus" : "") + '">' +
          comps
            .map(function (c, idx) {
              return renderSyntaxPart(c, idx);
            })
            .join("") +
          "</div>" +
          '<div class="en-comp-hint">点击成分卡片可聚焦该成分（其余压暗），再点一次取消；带 ▾ 的修饰成分可折叠成一行。</div>' +
          "</div>";
      }

      // 逻辑信号后端一直有返回（signal / type / implication），此前前端整个丢掉了 —— 
      // 这恰恰是「阅读的逻辑」最好用的抓手：命题人常在这些连接词处设题。
      var logicHtml = "";
      if (r.logic_signals && r.logic_signals.length) {
        logicHtml =
          '<div style="display:flex; flex-direction:column; gap:6px;">' +
          '<div style="font-size:var(--text-sm); font-weight:600; color:var(--muted);">🔍 逻辑信号 · 命题人常在这里设题</div>' +
          '<div style="display:flex; flex-wrap:wrap; gap:6px;">' +
          r.logic_signals
            .map(function (ls) {
              var note = ls.implication || ls.hint || "";
              return (
                '<span class="en-logic-chip"><b>' + esc(ls.signal || "") + "</b>" +
                (ls.type ? "（" + esc(ls.type) + "）" : "") +
                (note ? " " + esc(note) : "") +
                "</span>"
              );
            })
            .join("") +
          "</div></div>";
      }

      var ffHtml = "";
      if (r.false_friends && r.false_friends.length) {
        ffHtml =
          '<div class="en-ff-badge">' +
          '<div class="en-ff-tag">⚠️ 命中熟词生义高能预警：</div>' +
          r.false_friends
            .map(function (f) {
              return '<div style="font-size:var(--text-sm); line-height:var(--leading-snug);"><b>' + esc(f.word) + '</b>：常态释义「' + esc(f.common_sense) + '」，但文中取「<b style="color:var(--red)">' + esc(f.exam_sense) + '</b>」</div>';
            })
            .join("") +
          "</div>";
      }

      resHtml =
        '<div style="display:flex; flex-direction:column; gap:12px; margin-top:8px;">' +
        bbHtml +
        compHtml +
        logicHtml +
        ffHtml +
        (r.exam_tips ? '<div style="font-size:var(--text-sm); color:var(--muted); line-height:var(--leading-snug); background:rgba(0,0,0,0.02); padding:8px 12px; border-radius:6px;">💡 <b>名师点拨</b>：' + esc(r.exam_tips) + "</div>" : "") +
        "</div>";
    }

    return (
      '<div class="en-exam-card">' +
      '<div class="en-exam-row" style="justify-content:space-between">' +
      '<span class="en-exam-title">⚡ 长难句分层手术刀</span>' +
      '<button class="en-exam-btn sec" data-en-exam-action="fill-syntax-example">填入考研经典长难句示范</button>' +
      "</div>" +
      '<div class="en-exam-desc">粘贴任意考研/四六级或外刊长难句。系统自动剥离定状从句与插入语枝叶，秒提主谓宾极简主干句，并按成分分层着色。</div>' +
      '<textarea class="en-exam-textarea" id="en-syntax-input" placeholder="输入或粘贴英文长难句...">' + val + "</textarea>" +
      '<div class="en-exam-actions">' +
      '<span style="font-size:var(--text-xs); color:var(--muted)">可折叠枝叶 · 可单击聚焦单条成分</span>' +
      '<button class="en-exam-btn" data-en-exam-action="do-syntax-parse">' +
      (examView.loading ? "正在庖丁解牛..." : "立即手术刀拆解 ➔") +
      "</button>" +
      "</div>" +
      resHtml +
      "</div>"
    );
  }

  /* ------------------------------------------------------------ 模块 3：同义改写链萃取 */

  function renderParaphraseSection() {
    var pResHtml = "";
    if (examView.paraResult) {
      var r = examView.paraResult;
      pResHtml =
        '<div style="display:flex; flex-direction:column; gap:10px; margin-top:10px;">' +
        '<div style="font-size:calc(12px * var(--font-scale, 1)); font-weight:600; color:var(--muted)">自动抽取的同义改写链 (Paraphrase Pairs)：</div>' +
        (r.paraphrases || [])
          .map(function (p, idx) {
            var pairKey = (p.source_phrase || "") + "->" + (p.target_phrase || "");
            var isSaved = !!(examView.savedParaphraseIds && examView.savedParaphraseIds[pairKey]);
            return (
              '<div class="en-para-item">' +
              '<div class="en-para-head">' +
              '<span>标签：' + esc(p.type || "同义改写") + '</span>' +
              (isSaved
                ? '<button class="en-exam-btn" style="padding:2px 10px; font-size:calc(11px * var(--font-scale, 1)); background:var(--green); color:#fff;" data-en-exam-action="go-review-saved">✅ 已排入FSRS</button>'
                : '<button class="en-exam-btn sec" style="padding:2px 8px; font-size:calc(11px * var(--font-scale, 1))" data-en-exam-action="save-para" data-para-idx="' + idx + '">⭐ 存入 FSRS 复习库</button>') +
              '</div>' +
              '<div class="en-para-pair">' +
              '<span class="en-para-src" title="原文表达">' + esc(p.source_phrase) + '</span>' +
              '<span class="en-para-arrow">➔</span>' +
              '<span class="en-para-tgt" title="题目选项改写">' + esc(p.target_phrase) + '</span>' +
              '</div>' +
              '<div style="font-size:calc(12px * var(--font-scale, 1)); color:var(--muted); line-height:1.4;">' + esc(p.explanation) + '</div>' +
              '</div>'
            );
          })
          .join("") +
        "</div>";
    }

    return (
      '<div class="en-exam-card">' +
      '<div class="en-exam-row" style="justify-content:space-between">' +
      '<span class="en-exam-title">🎯 唐迟「同义改写链」智能萃取</span>' +
      '<button class="en-exam-btn sec" data-en-exam-action="fill-para-example">填入真题对比示范</button>' +
      "</div>" +
      '<div class="en-exam-desc">考研阅读本质是同义替换的艺术。输入原文句与选项句，系统自动萃取对齐对并可一键沉淀至 FSRS 复习库。</div>' +
      '<div style="display:flex; flex-direction:column; gap:8px;">' +
      '<textarea class="en-exam-textarea" id="en-para-src" placeholder="输入文章原文句 (Source Passage/Sentence)...">' + esc(examView.paraSource) + '</textarea>' +
      '<textarea class="en-exam-textarea" id="en-para-exam" style="min-height:48px;" placeholder="输入题目正确选项句 (Exam Target/Option)...">' + esc(examView.paraExam) + '</textarea>' +
      '</div>' +
      '<div class="en-exam-actions">' +
      '<span style="font-size:calc(11px * var(--font-scale, 1)); color:var(--muted)">点击提取后，可一键加入闪卡复习计划</span>' +
      '<button class="en-exam-btn" data-en-exam-action="do-para-extract">' +
      (examView.loading ? "正在对齐比对..." : "抽取同义替换对 ➔") +
      "</button>" +
      "</div>" +
      pResHtml +
      "</div>" +
      renderRewriteSection()
    );
  }

  /* 单句同义改写：与上面「原文句 × 选项句」成对萃取互补——那个是拿现成选项来对齐，
     这个是你手上只有原文、想自己造几个等价说法时用。主力是 TJU-LLM。 */
  function renderRewriteSection() {
    var r = examView.rewriteResult;
    var resHtml = "";
    if (r) {
      var items = r.rewrites || [];
      var listHtml = items.length
        ? '<div class="en-rw-list">' +
          items
            .map(function (w, i) {
              var swaps = (w.swaps || [])
                .map(function (sp) {
                  return '<span class="en-sel-swap"><s>' + esc(sp.from) + "</s> → <b>" + esc(sp.to) + "</b></span>";
                })
                .join("");
              return (
                '<div class="en-rw-item">' +
                '<div class="en-rw-line"><span class="en-sel-idx">' + (i + 1) + "</span>" + esc(w.rewritten || "") + "</div>" +
                (w.strategy ? '<span class="en-sel-tag">' + esc(w.strategy) + "</span>" : "") +
                (swaps ? '<div class="en-sel-swaps">' + swaps + "</div>" : "") +
                (w.note ? '<div class="en-rw-note">' + esc(w.note) + "</div>" : "") +
                "</div>"
              );
            })
            .join("") +
          "</div>"
        : '<div class="en-exam-desc">' + esc(r.notice || "这句里没有可替换的考纲高频词，换一句再试。") + "</div>";

      resHtml =
        (r.core_meaning ? '<div class="en-exam-desc" style="color:var(--ink);">🎯 原句核心：' + esc(r.core_meaning) + "</div>" : "") +
        listHtml +
        (r.ai_generated === false && items.length
          ? '<div class="en-exam-desc" style="color:var(--gold);">⚠️ ' + esc(r.notice || "TJU-LLM 暂不可用，以上为词级替换版。") + "</div>"
          : "");
    }

    return (
      '<div class="en-exam-card" style="margin-top:12px;">' +
      '<div class="en-exam-row" style="justify-content:space-between;">' +
      '<span class="en-exam-title">🔄 单句同义改写（TJU-LLM 驱动）</span>' +
      '<span style="font-size:calc(11px * var(--font-scale, 1)); color:var(--muted);">也可在正文里划词，从浮出条一键带入</span>' +
      "</div>" +
      '<div class="en-exam-desc">给一句话，产出多个语义等价、可直接当考研阅读选项的写法，并逐处标出同义替换点（同义词替换 / 词性转换 / 主动被动互换 / 肯定否定转换 / 上位词概括 / 句式重组）。</div>' +
      '<textarea class="en-exam-textarea" id="en-rewrite-sentence" placeholder="粘贴一句英文原文，例如：Most modern enterprises still struggle to weather the messy organizational transitions required to harness its full potential.">' +
      esc(examView.rewriteSentence) +
      "</textarea>" +
      '<div class="en-exam-actions">' +
      '<span style="font-size:calc(11px * var(--font-scale, 1)); color:var(--muted);">优先 TJU-LLM；不可用时退回词级替换版并明确标注</span>' +
      '<button class="en-exam-btn" data-en-exam-action="do-rewrite">' +
      (examView.rewriteBusy ? "正在改写..." : "生成同义改写 ➔") +
      "</button>" +
      "</div>" +
      resHtml +
      "</div>"
    );
  }

  /* ------------------------------------------------------------ 模块 4：熟词生义雷达 */

  function renderRadarSection() {
    var items = examView.radarResults || [];
    return (
      '<div class="en-exam-card">' +
      '<span class="en-exam-title">⚠️ 高频熟词生义雷达</span>' +
      '<div class="en-exam-desc">自动扫描高频熟词僻义（如 weather 经受住、sound 健全的、balance 差额结余、school 鱼群/学派等 160+ 高频点）。</div>' +
      '<div style="display:flex; gap:8px;">' +
      '<input type="text" id="en-radar-query" class="en-exam-textarea" style="min-height:36px; padding:6px 12px;" placeholder="输入要扫描的英文单词或一段真题文本..." value="' + esc(examView.radarQuery) + '" />' +
      '<button class="en-exam-btn" data-en-exam-action="do-radar-search">雷达扫描</button>' +
      '</div>' +
      '<div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(280px, 1fr)); gap:10px; margin-top:8px;">' +
      items
        .map(function (item) {
          return (
            '<div style="background:rgba(0,0,0,0.02); border:1px solid var(--line); border-radius:8px; padding:10px 12px; display:flex; flex-direction:column; gap:4px;">' +
            '<div style="display:flex; justify-content:space-between; align-items:center;">' +
            '<span style="font-size:calc(14px * var(--font-scale, 1)); font-weight:700; color:var(--ink);">' + esc(item.word) + '</span>' +
            '<span style="font-size:calc(10px * var(--font-scale, 1)); color:var(--gold); background:rgba(230,162,60,0.12); padding:1px 6px; border-radius:10px;">考研核心</span>' +
            '</div>' +
            '<div style="font-size:calc(12px * var(--font-scale, 1)); color:var(--muted);">熟义：' + esc(item.common || item.common_sense) + '</div>' +
            '<div style="font-size:calc(12px * var(--font-scale, 1)); font-weight:600; color:var(--red);">考研生义：' + esc(item.exam_sense) + '</div>' +
            (item.example ? '<div style="font-size:calc(11px * var(--font-scale, 1)); color:var(--muted); font-style:italic;">例句：' + esc(item.example) + '</div>' : '') +
            '</div>'
          );
        })
        .join("") +
      "</div>" +
      "</div>"
    );
  }

  /* ============================================================
     模块：六级写作提分（写作工具箱 + 规则体检 + 可选 AI 升格）
     把博主讲的模板骨架、功能句型、替换词、过渡词、中式英语纠错，
     做成「左边写、右边抄、点一下插进去」的随手工具，而不是又一篇攻略。
     ============================================================ */

  function wkCountWords(text) {
    var m = String(text || "").match(/[A-Za-z][A-Za-z'\-]*/g);
    return m ? m.length : 0;
  }

  function wkDraftMeta() {
    var raw = String(examView.writingDraft || "");
    var paras = raw.split(/\n\s*\n/).filter(function (p) {
      return p.trim();
    }).length;
    return "已写 " + wkCountWords(raw) + " 词 · " + paras + " 段";
  }

  function metricTile(cls, value, label) {
    return (
      '<div class="en-wk-metric ' + (cls || "") + '"><b>' + esc(value) + "</b><span>" + esc(label) + "</span></div>"
    );
  }

  function renderWritingSection() {
    loadWritingHistory();
    if (examView.writingKitLoading && !examView.writingKit) {
      return '<div class="en-exam-card"><div class="en-exam-desc">正在加载写作工具箱…</div></div>';
    }
    var kit = examView.writingKit;
    if (!kit) {
      return (
        '<div class="en-exam-card"><div class="en-exam-desc">写作工具箱没加载出来。' +
        (examView.writingError ? "（" + esc(examView.writingError) + "）" : "") +
        '</div><div class="en-exam-row"><button class="en-exam-btn" data-en-exam-action="wk-load-kit">重新加载</button></div></div>'
      );
    }

    var demoTypes = kit.demo_types || [];
    var demoTpl = examView.writingTemplateId || (demoTypes[0] && demoTypes[0].id) || "";
    var demoChips = demoTypes
      .map(function (t) {
        return (
          '<button class="en-lane-btn' + (t.id === demoTpl ? " active" : "") + '" data-en-exam-action="wk-tpl" data-tpl="' + esc(t.id) + '">' + esc(t.name) + "</button>"
        );
      })
      .join("");

    var editor =
      '<div class="en-exam-card">' +
      '<div class="en-exam-title">✍️ 我的作文</div>' +
      '<div class="en-exam-desc">粘进来点「规则体检」——字数、段落、中式英语、可升级词一次查清。规则是毫秒级的，改一版查一版。</div>' +
      /* 一键演示：不想自己写也能看完整流程 —— AI 出题、自己写、自己升格 */
      '<div class="en-lane-switch" style="margin-bottom:10px">' +
      '<span class="en-exam-desc">懒得动笔？选个题型，让 AI 出题并自己写一篇：</span>' +
      demoChips +
      '<button class="en-exam-btn" data-en-exam-action="wk-demo" data-tpl="' + esc(demoTpl) + '">' +
      (examView.writingBusy === "demo" ? "演示中…" : "🎲 AI 演示") +
      "</button>" +
      "</div>" +
      '<input id="en-writing-topic" class="en-search-input" placeholder="题目（可选）：Should college students take part-time jobs?" value="' + esc(examView.writingTopic) + '" />' +
      '<textarea id="en-writing-draft" class="en-exam-textarea" style="min-height:200px" placeholder="把作文正文粘到这里…">' + esc(examView.writingDraft) + "</textarea>" +
      '<div class="en-exam-actions">' +
      '<span class="en-exam-desc">' + esc(wkDraftMeta()) + "</span>" +
      '<span class="en-exam-row">' +
      '<button class="en-exam-btn sec" data-en-exam-action="wk-clear">清空</button>' +
      '<button class="en-exam-btn sec" data-en-exam-action="wk-check">' + (examView.writingBusy === "check" ? "体检中…" : "规则体检") + "</button>" +
      '<button class="en-exam-btn" data-en-exam-action="wk-polish">' + (examView.writingBusy === "polish" ? "升格中…" : "AI 升格批改") + "</button>" +
      "</span>" +
      "</div>" +
      "</div>";

    return (
      '<div class="en-wk-grid">' +
      '<div class="en-wk-col">' +
      editor +
      renderWritingReport() +
      renderHistoryCard(examView.writingHistory, "wk", "还没有演示记录，点上面的「🎲 AI 演示」跑一次试试。") +
      "</div>" +
      '<div class="en-wk-col">' +
      renderWritingTools(kit) +
      "</div>" +
      "</div>"
    );
  }

  function renderWritingReport() {
    var html = "";
    var c = examView.writingCheck;
    var p = examView.writingPolish;

    if (examView.writingError) {
      html += '<div class="en-wk-issue bad">' + esc(examView.writingError) + "</div>";
    }

    if (p && p.ai_generated) {
      var fixHtml = (p.fixes || [])
        .map(function (f) {
          return (
            '<div class="en-wk-issue warn"><div>' +
            '<span class="en-wk-mono bad">' + esc(f.original || "") + "</span> → " +
            '<span class="en-wk-mono fix">' + esc(f.improved || "") + "</span>" +
            (f.reason ? '<div class="en-exam-desc" style="margin-top:3px">' + esc(f.reason) + "</div>" : "") +
            "</div></div>"
          );
        })
        .join("");
      var skeletonHtml = (p.skeleton || [])
        .map(function (s) {
          return (
            '<div class="en-wk-seg"><div class="en-wk-seg-head"><span class="en-wk-seg-para">' + esc(s.para || "") + "</span>" +
            '<span class="en-wk-seg-role">' + esc(s.role || "") + "</span></div>" +
            '<div class="en-wk-seg-point">' + esc(s.advice || "") + "</div></div>"
          );
        })
        .join("");
      html +=
        '<div class="en-exam-card">' +
        '<div class="en-exam-title">🧭 AI 升格批改</div>' +
        '<div class="en-wk-metrics">' +
        metricTile("", p.band || "—", "分档判断") +
        metricTile("", (p.fixes || []).length, "逐处修改") +
        "</div>" +
        (p.band_reason ? '<div class="en-exam-desc">依据：' + esc(p.band_reason) + "</div>" : "") +
        (p.strengths && p.strengths.length
          ? '<div class="en-wk-list">' +
            p.strengths
              .map(function (s) {
                return '<div class="en-wk-issue ok">✓ ' + esc(s) + "</div>";
              })
              .join("") +
            "</div>"
          : "") +
        (fixHtml ? '<div class="en-exam-desc" style="font-weight:600">逐处修改</div><div class="en-wk-list">' + fixHtml + "</div>" : "") +
        (p.upgraded_essay
          ? '<div class="en-exam-desc" style="font-weight:600">升格范文</div>' +
            '<div class="en-wk-issue ok" style="font-family:var(--font-serif); white-space:pre-wrap; line-height:1.7">' + esc(p.upgraded_essay) + "</div>"
          : "") +
        (skeletonHtml ? '<div class="en-exam-desc" style="font-weight:600">这篇题目的骨架建议</div><div class="en-wk-list">' + skeletonHtml + "</div>" : "") +
        "</div>";
    } else if (p && p.notice) {
      html += '<div class="en-wk-issue warn">' + esc(p.notice) + "</div>";
    }

    if (!c) return html;

    html +=
      '<div class="en-exam-card">' +
      '<div class="en-exam-title">📋 规则体检报告</div>' +
      '<div class="en-wk-metrics">' +
      metricTile(c.word_state, c.words, "词数（要求 150–200）") +
      metricTile(c.paragraph_count >= 3 ? "ok" : c.paragraph_count === 2 ? "warn" : "bad", c.paragraph_count, "段落数（要 ≥3）") +
      metricTile("", c.sentence_count, "句子数") +
      metricTile("", c.estimate ? c.estimate.score : "—", "规则粗估 / 15 分") +
      "</div>" +
      '<div class="en-wk-issue ' + esc(c.word_state === "ok" ? "ok" : c.word_state === "warn" ? "warn" : "bad") + '">' + esc(c.word_tip) + "</div>" +
      (c.estimate
        ? '<div class="en-exam-desc">落档参考 <b>' + esc(c.estimate.band) + "（" + esc(c.estimate.label) + "）</b> —— " + esc(c.estimate.note) + "</div>"
        : "");

    if (c.structure && c.structure.length) {
      html +=
        '<div class="en-exam-desc" style="font-weight:600">结构</div><div class="en-wk-list">' +
        c.structure
          .map(function (s) {
            return '<div class="en-wk-issue ' + esc(s.level) + '">' + esc(s.text) + "</div>";
          })
          .join("") +
        "</div>";
    }

    if (c.chinglish && c.chinglish.length) {
      html +=
        '<div class="en-exam-desc" style="font-weight:600">中式英语 / 语法（' + c.chinglish.length + " 处）</div><div class=\"en-wk-list\">" +
        c.chinglish
          .map(function (x) {
            return (
              '<div class="en-wk-issue bad"><div>' +
              '<span class="en-wk-mono bad">' + esc(x.hit) + "</span> → " +
              '<span class="en-wk-mono fix">' + esc(x.fix) + "</span>" +
              '<div class="en-exam-desc" style="margin-top:3px">' + esc(x.why) + "</div>" +
              '<div class="en-wk-src" style="margin-top:3px">' + esc(x.sentence) + "</div>" +
              "</div></div>"
            );
          })
          .join("") +
        "</div>";
    } else {
      html += '<div class="en-wk-issue ok">✓ 没命中已知的中式英语规则，这一步可以放心。</div>';
    }

    if (c.upgrades && c.upgrades.length) {
      html +=
        '<div class="en-exam-desc" style="font-weight:600">可以升级的词（点一下就替换）</div><div class="en-wk-list">' +
        c.upgrades
          .slice(0, 8)
          .map(function (u) {
            var chips = (u.upgrades || [])
              .map(function (g) {
                return (
                  '<button class="en-exam-btn sec" style="padding:1px 7px; font-size:calc(11px * var(--font-scale, 1))" data-en-exam-action="wk-upgrade" data-basic="' +
                  esc(u.basic) + '" data-to="' + esc(g) + '">' + esc(g) + "</button>"
                );
              })
              .join(" ");
            return (
              '<div class="en-wk-issue warn"><div>' +
              '<span class="en-wk-mono bad">' + esc(u.basic) + "</span> → " + chips +
              '<div class="en-exam-desc" style="margin-top:4px">例句：' + esc(u.example) + "</div>" +
              '<div class="en-wk-src" style="margin-top:3px">' + esc((u.sentences || [])[0] || "") + "</div>" +
              "</div></div>"
            );
          })
          .join("") +
        "</div>";
    }

    html += '<div class="en-exam-desc" style="font-weight:600">逻辑连接词</div>';
    if (c.transitions_used && c.transitions_used.length) {
      html +=
        '<div class="en-exam-row">' +
        c.transitions_used
          .map(function (t) {
            return '<span class="en-wk-mono fix">' + esc(t) + "</span>";
          })
          .join("") +
        "</div>";
    }
    if (c.transition_tip) {
      html += '<div class="en-wk-issue warn">' + esc(c.transition_tip) + "</div>";
    }

    if (c.style_tips && c.style_tips.length) {
      html +=
        '<div class="en-exam-desc" style="font-weight:600">句式</div><div class="en-wk-list">' +
        c.style_tips
          .map(function (t) {
            return '<div class="en-wk-issue warn">' + esc(t) + "</div>";
          })
          .join("") +
        "</div>";
    }

    if (c.checklist && c.checklist.length) {
      html +=
        '<div class="en-exam-desc" style="font-weight:600">改这一版先做这几件事</div><div class="en-wk-list">' +
        c.checklist
          .map(function (t, i) {
            return '<div class="en-wk-issue ok">' + (i + 1) + ". " + esc(t) + "</div>";
          })
          .join("") +
        "</div>";
    }

    html += "</div>";
    return html;
  }

  function renderWritingTools(kit) {
    var tabs = [
      { id: "sentence", label: "高分句型" },
      { id: "tpl", label: "模板骨架" },
      { id: "upgrade", label: "替换词库" },
      { id: "transition", label: "过渡词库" },
      { id: "chinglish", label: "中式英语" },
      { id: "rubric", label: "评分标准" },
      { id: "advanced", label: "冲刺满分" },
    ];
    var cur = examView.writingToolTab;
    var tabHtml = tabs
      .map(function (t) {
        return (
          '<button class="en-wk-tab' + (cur === t.id ? " active" : "") + '" data-en-exam-action="wk-tool" data-tool="' + t.id + '">' +
          esc(t.label) + "</button>"
        );
      })
      .join("");

    var body = "";
    if (cur === "tpl") {
      var tpls = kit.templates || [];
      var picked = tpls.filter(function (t) {
        return t.id === examView.writingTemplateId;
      })[0] || tpls[0];
      body =
        '<div class="en-exam-row">' +
        tpls
          .map(function (t) {
            return (
              '<button class="en-wk-tab' + (picked && picked.id === t.id ? " active" : "") + '" data-en-exam-action="wk-tpl" data-tpl="' + esc(t.id) + '">' +
              esc(t.name) + "</button>"
            );
          })
          .join("") +
        "</div>";
      if (picked) {
        body += '<div class="en-exam-desc">适用：' + esc(picked.when) + "</div>";
        body +=
          '<div class="en-wk-list">' +
          (picked.segments || [])
            .map(function (seg) {
              var sents = (seg.sentences || [])
                .map(function (s) {
                  return (
                    '<div class="en-wk-sent" data-en-exam-action="wk-insert" data-text="' + esc(s) + '" title="点一下插入到作文末尾">' +
                    esc(s) + "</div>"
                  );
                })
                .join("");
              var points = (seg.points || [])
                .map(function (pt) {
                  return '<div class="en-wk-seg-point">· ' + esc(pt) + "</div>";
                })
                .join("");
              return (
                '<div class="en-wk-seg">' +
                '<div class="en-wk-seg-head"><span class="en-wk-seg-para">' + esc(seg.para) + "</span>" +
                '<span class="en-wk-seg-words">' + esc(seg.words) + "</span>" +
                '<span class="en-wk-seg-role">' + esc(seg.role) + "</span></div>" +
                points +
                sents +
                "</div>"
              );
            })
            .join("") +
          "</div>";
      }
    } else if (cur === "upgrade") {
      body =
        '<div class="en-exam-desc">基础词换成高级词，是提分里最省力的一步。点高级词会替换掉作文里对应的基础词。</div>' +
        '<div class="en-wk-list">' +
        (kit.upgrade_words || [])
          .map(function (u) {
            var chips = (u.upgrades || [])
              .map(function (g) {
                return (
                  '<button class="en-exam-btn sec" style="padding:1px 7px; font-size:calc(11px * var(--font-scale, 1))" data-en-exam-action="wk-upgrade" data-basic="' +
                  esc(u.basic) + '" data-to="' + esc(g) + '">' + esc(g) + "</button>"
                );
              })
              .join(" ");
            return (
              '<div class="en-wk-seg"><div class="en-wk-seg-head">' +
              '<span class="en-wk-mono bad">' + esc(u.basic) + "</span> → " + chips + "</div>" +
              '<div class="en-wk-seg-point">' + esc(u.example) + "</div></div>"
            );
          })
          .join("") +
        "</div>";
    } else if (cur === "transition") {
      body =
        '<div class="en-exam-desc">「连贯」分就靠这些词撑着。点一下插入到作文末尾。</div>' +
        '<div class="en-wk-list">' +
        (kit.transitions || [])
          .map(function (g) {
            return (
              '<div class="en-wk-seg"><div class="en-wk-seg-head"><span class="en-wk-seg-role">' + esc(g.type) + "</span></div>" +
              '<div class="en-tl-chunks">' +
              (g.words || [])
                .map(function (w) {
                  return '<span class="en-tl-chunk" data-en-exam-action="wk-insert" data-text="' + esc(w) + '" style="cursor:pointer">' + esc(w) + "</span>";
                })
                .join("") +
              "</div></div>"
            );
          })
          .join("") +
        "</div>";
    } else if (cur === "chinglish") {
      body =
        '<div class="en-exam-desc">这些是六级写作里最高频的中式英语与语法坑，写的时候绕着走。</div>' +
        '<div class="en-wk-list">' +
        (kit.chinglish_rules || [])
          .map(function (r) {
            return (
              '<div class="en-wk-issue warn"><div>' +
              '<span class="en-wk-mono bad">' + esc(r.bad) + "</span> → " +
              '<span class="en-wk-mono fix">' + esc(r.fix) + "</span>" +
              '<div class="en-exam-desc" style="margin-top:3px">' + esc(r.why) + "</div>" +
              "</div></div>"
            );
          })
          .join("") +
        "</div>";
    } else if (cur === "rubric") {
      var rb = kit.rubric || {};
      body =
        '<div class="en-exam-desc">满分 ' + esc(rb.full_score) + " 分（报道分 " + esc(rb.reported_score) + "） · " + esc(rb.weight) +
        " · " + esc(rb.time_minutes) + " 分钟 · " + esc(rb.word_rule) + "</div>" +
        '<div class="en-wk-list">' +
        (rb.bands || [])
          .map(function (b) {
            return (
              '<div class="en-wk-seg"><div class="en-wk-seg-head"><span class="en-wk-seg-para">' + esc(b.band) + "</span>" +
              '<span class="en-wk-seg-role">' + esc(b.label) + "</span></div>" +
              '<div class="en-wk-seg-point">' + esc(b.desc) + "</div></div>"
            );
          })
          .join("") +
        "</div>" +
        '<div class="en-exam-desc" style="font-weight:600">扣分点</div><div class="en-wk-list">' +
        (rb.deductions || [])
          .map(function (d) {
            return '<div class="en-wk-issue warn">' + esc(d) + "</div>";
          })
          .join("") +
        "</div>" +
        '<div class="en-exam-desc" style="font-weight:600">30 分钟怎么分</div><div class="en-wk-list">' +
        (rb.time_plan || [])
          .map(function (t) {
            return (
              '<div class="en-wk-seg"><div class="en-wk-seg-head"><span class="en-wk-seg-para">' + esc(t.stage) + "</span>" +
              '<span class="en-wk-seg-role">' + esc(t.task) + "</span></div>" +
              '<div class="en-wk-seg-point">' + esc(t.detail) + "</div></div>"
            );
          })
          .join("") +
        "</div>";
    } else if (cur === "advanced") {
      var patterns = kit.advanced_sentence_patterns || [];
      var advVocab = kit.advanced_vocab || [];
      var markers = kit.advanced_discourse_markers || [];
      body =
        '<div class="en-exam-desc">这一栏是冲 13–15 档（优秀）的「加分项」：高级句式 + 学术搭配 + 隐形衔接词。基础库解决「不犯错」，这里解决「有文采」。</div>' +
        '<div class="en-exam-desc" style="font-weight:600">高级句型（普通写法 → 满分写法，点满分句可插入）</div>' +
        '<div class="en-wk-list">' +
        patterns.map(function (p) {
          return (
            '<div class="en-wk-seg"><div class="en-wk-seg-head"><span class="en-wk-seg-para">' + esc(p.name) + '</span>' +
            '<span class="en-wk-seg-role">' + esc(p.formula || "") + '</span></div>' +
            '<div class="en-wk-seg-point">普通：' + esc(p.plain || "") + '</div>' +
            '<div class="en-wk-sent" data-en-exam-action="wk-insert" data-text="' + esc(p.advanced || "") + '" title="点一下插入到作文末尾">满分：' + esc(p.advanced || "") + '</div>' +
            '<div class="en-exam-desc" style="margin-top:3px">' + esc(p.note || "") + '</div></div>'
          );
        }).join("") +
        '</div>' +
        '<div class="en-exam-desc" style="font-weight:600">高阶词汇与搭配（基础表达 → 学术语域）</div>' +
        '<div class="en-wk-list">' +
        advVocab.map(function (v) {
          var chips = (v.advanced || []).map(function (g) {
            return '<button class="en-exam-btn sec" style="padding:1px 7px; font-size:calc(11px * var(--font-scale, 1))" data-en-exam-action="wk-insert" data-text="' + esc(g) + '">' + esc(g) + '</button>';
          }).join(" ");
          return (
            '<div class="en-wk-seg"><div class="en-wk-seg-head"><span class="en-wk-mono bad">' + esc(v.basic) + '</span> → ' + chips + '</div>' +
            '<div class="en-wk-seg-point">' + esc(v.example || "") + '</div></div>'
          );
        }).join("") +
        '</div>' +
        '<div class="en-exam-desc" style="font-weight:600">隐形衔接词（替代满篇 Moreover / However）</div>' +
        '<div class="en-wk-list">' +
        markers.map(function (g) {
          return (
            '<div class="en-wk-seg"><div class="en-wk-seg-head"><span class="en-wk-seg-role">' + esc(g.type) + '</span></div>' +
            '<div class="en-tl-chunks">' +
            (g.words || []).map(function (w) {
              return '<span class="en-tl-chunk" data-en-exam-action="wk-insert" data-text="' + esc(w) + '" style="cursor:pointer">' + esc(w) + '</span>';
            }).join("") +
            '</div></div>'
          );
        }).join("") +
        '</div>';
    } else {
      body =
        '<div class="en-exam-desc">点一句就能插到作文末尾，改掉主语和关键词就能用。</div>' +
        '<div class="en-wk-list">' +
        (kit.sentence_bank || [])
          .map(function (g) {
            return (
              '<div class="en-wk-seg"><div class="en-wk-seg-head"><span class="en-wk-seg-role">' + esc(g.group) + "</span></div>" +
              (g.items || [])
                .map(function (it) {
                  return (
                    '<div class="en-wk-sent" data-en-exam-action="wk-insert" data-text="' + esc(it.en) + '" title="点一下插入到作文末尾">' +
                    esc(it.en) +
                    '<span class="en-wk-sent-zh">' + esc(it.zh) + "　· " + esc(it.note) + "</span></div>"
                  );
                })
                .join("") +
              "</div>"
            );
          })
          .join("") +
        "</div>";
    }

    return (
      '<div class="en-exam-card">' +
      '<div class="en-exam-title">🧰 写作工具箱</div>' +
      '<div class="en-wk-tabs">' + tabHtml + "</div>" +
      body +
      "</div>"
    );
  }

  /* ============================================================
     模块：六级翻译提分（三步法引导 + 文化词表 + 译文体检）
     只给脚手架不代译：用户自己动手译，卡在哪一步看得见。
     ============================================================ */

  function renderTranslationSection() {
    loadTranslationHistory();
    if (examView.translationKitLoading && !examView.translationKit) {
      return '<div class="en-exam-card"><div class="en-exam-desc">正在加载翻译工具箱…</div></div>';
    }
    var kit = examView.translationKit;
    if (!kit) {
      return (
        '<div class="en-exam-card"><div class="en-exam-desc">翻译工具箱没加载出来。' +
        (examView.translationError ? "（" + esc(examView.translationError) + "）" : "") +
        '</div><div class="en-exam-row"><button class="en-exam-btn" data-en-exam-action="tl-load-kit">重新加载</button></div></div>'
      );
    }

    var termStrip = "";
    if (examView.translationTerms.length) {
      termStrip =
        '<div class="en-wk-note-strip"><span class="en-exam-desc">术语便签：</span>' +
        examView.translationTerms
          .map(function (t) {
            return (
              '<span class="en-wk-note-chip">' + esc(t.zh) + " = " + esc(t.en) +
              '<button data-en-exam-action="tl-del-term" data-zh="' + esc(t.zh) + '" title="移除">×</button></span>'
            );
          })
          .join("") +
        "</div>";
    }

    var demoCats = kit.demo_categories || [];
    var demoCat = examView.translationDemoCategory || "";
    var demoCatChips = demoCats
      .map(function (c) {
        return (
          '<button class="en-lane-btn' + (c.category === demoCat ? " active" : "") + '" data-en-exam-action="tl-demo-cat" data-cat="' + esc(c.category) + '">' + esc(c.category) + "</button>"
        );
      })
      .join("");

    var editor =
      '<div class="en-exam-card">' +
      '<div class="en-exam-title">🔤 我的翻译</div>' +
      '<div class="en-exam-desc">先把中文段落丢进去点「三步法引导」——它只帮你拆句、标考点、给文化词标准译法，译文还是你自己写。</div>' +
      /* 一键演示：按标签出题，AI 自己译、自己体检 */
      '<div class="en-lane-switch" style="margin-bottom:10px">' +
      '<span class="en-exam-desc">懒得动笔？选个标签，让 AI 出题并自己译一版：</span>' +
      demoCatChips +
      '<button class="en-exam-btn" data-en-exam-action="tl-demo" data-cat="' + esc(demoCat) + '">' +
      (examView.translationBusy === "demo" ? "演示中…" : "🎲 AI 演示") +
      "</button>" +
      "</div>" +
      '<textarea id="en-tl-source" class="en-exam-textarea" style="min-height:110px" placeholder="中文原文（六级翻译是 180–200 字的一段话）…">' + esc(examView.translationSource) + "</textarea>" +
      '<div class="en-exam-actions">' +
      '<span class="en-exam-desc">' + esc(String(examView.translationSource || "").replace(/\s/g, "").length) + " 字</span>" +
      '<span class="en-exam-row">' +
      '<button class="en-exam-btn sec" data-en-exam-action="tl-clear">清空</button>' +
      '<button class="en-exam-btn" data-en-exam-action="tl-guide">' + (examView.translationBusy === "guide" ? "拆解中…" : "三步法引导") + "</button>" +
      "</span>" +
      "</div>" +
      "</div>" +
      '<div class="en-exam-card">' +
      '<div class="en-exam-title">📝 我的译文</div>' +
      termStrip +
      '<textarea id="en-tl-target" class="en-exam-textarea" style="min-height:140px" placeholder="写完译文贴进来，点「译文体检」查中式英语、长度比、文化词漏译…">' + esc(examView.translationTarget) + "</textarea>" +
      '<div class="en-exam-actions">' +
      '<span class="en-exam-desc">' + esc(wkCountWords(examView.translationTarget)) + " 词</span>" +
      '<button class="en-exam-btn" data-en-exam-action="tl-check">' + (examView.translationBusy === "check" ? "体检中…" : "译文体检") + "</button>" +
      "</div>" +
      "</div>";

    return (
      '<div class="en-wk-grid">' +
      '<div class="en-wk-col">' +
      editor +
      renderTranslationReport() +
      renderHistoryCard(examView.translationHistory, "tl", "还没有演示记录，点上面的「🎲 AI 演示」跑一次试试。") +
      "</div>" +
      '<div class="en-wk-col">' +
      renderTranslationTools(kit) +
      "</div>" +
      "</div>"
    );
  }

  function renderTranslationReport() {
    var html = "";
    if (examView.translationError) {
      html += '<div class="en-wk-issue bad">' + esc(examView.translationError) + "</div>";
    }

    var g = examView.translationGuide;
    if (g && g.sentences) {
      html +=
        '<div class="en-exam-card">' +
        '<div class="en-exam-title">🧩 三步法引导（' + esc(g.sentence_count) + " 句）</div>" +
        '<div class="en-exam-desc">拆主干 → 换说法 → 加被动 / 调语序。先按这个顺序自己译一遍，再回头看体检报告。</div>' +
        '<div class="en-wk-list">' +
        g.sentences
          .map(function (s) {
            var chunks = (s.chunks || [])
              .map(function (c) {
                return '<span class="en-tl-chunk' + (c === s.backbone_guess ? " main" : "") + '">' + esc(c) + "</span>";
              })
              .join("");
            var cues = (s.cues || [])
              .map(function (c) {
                return '<div class="en-tl-cue"><b>' + esc(c.label) + "</b>：" + esc(c.hint) + "</div>";
              })
              .join("");
            var culture = (s.culture || [])
              .map(function (c) {
                return '<div class="en-wk-issue ok">文化词 <b>' + esc(c.zh) + "</b> → " + esc(c.en) + "（" + esc(c.note) + "）</div>";
              })
              .join("");
            var phrases = (s.phrases || [])
              .map(function (p) {
                return '<div class="en-wk-issue warn">「' + esc(p.zh) + "」可译作 " + esc(p.en) + "</div>";
              })
              .join("");
            return (
              '<div class="en-tl-sent">' +
              '<div class="en-tl-zh">' + esc(s.index) + ". " + esc(s.zh) + "</div>" +
              '<div class="en-tl-chunks">' + chunks + "</div>" +
              cues +
              culture +
              phrases +
              (s.steps || [])
                .map(function (t) {
                  return '<div class="en-tl-step">' + esc(t) + "</div>";
                })
                .join("") +
              "</div>"
            );
          })
          .join("") +
        "</div>" +
        "</div>";
    }

    var c = examView.translationCheck;
    if (c) {
      html +=
        '<div class="en-exam-card">' +
        '<div class="en-exam-title">📋 译文体检报告</div>' +
        '<div class="en-wk-metrics">' +
        metricTile("", c.zh_chars, "原文汉字") +
        metricTile("", c.en_words, "译文词数") +
        metricTile("", c.sentence_count, "译文句数") +
        metricTile(c.chinglish && c.chinglish.length ? "bad" : "ok", (c.chinglish || []).length, "中式英语") +
        "</div>";
      html +=
        '<div class="en-wk-list">' +
        (c.issues || [])
          .map(function (i) {
            return '<div class="en-wk-issue ' + esc(i.level) + '">' + esc(i.text) + "</div>";
          })
          .join("") +
        "</div>";
      if (c.chinglish && c.chinglish.length) {
        html +=
          '<div class="en-exam-desc" style="font-weight:600">中式英语（' + c.chinglish.length + " 处）</div><div class=\"en-wk-list\">" +
          c.chinglish
            .map(function (x) {
              return (
                '<div class="en-wk-issue bad"><div>' +
                '<span class="en-wk-mono bad">' + esc(x.hit) + "</span> → " +
                '<span class="en-wk-mono fix">' + esc(x.fix) + "</span>" +
                '<div class="en-exam-desc" style="margin-top:3px">' + esc(x.why) + "</div>" +
                '<div class="en-wk-src" style="margin-top:3px">' + esc(x.sentence) + "</div>" +
                "</div></div>"
              );
            })
            .join("") +
          "</div>";
      } else {
        html += '<div class="en-wk-issue ok">✓ 没命中已知的中式英语规则。</div>';
      }
      if (c.culture_missing && c.culture_missing.length) {
        html +=
          '<div class="en-exam-desc" style="font-weight:600">文化词漏译 / 待补（' + c.culture_missing.length + "）</div><div class=\"en-wk-list\">" +
          c.culture_missing
            .map(function (t) {
              return (
                '<div class="en-wk-issue bad"><div>「' + esc(t.zh) + "」→ " + esc(t.en) +
                '<div class="en-exam-desc" style="margin-top:3px">' + esc(t.note) + "</div>" +
                '<button class="en-exam-btn sec" style="margin-top:4px; padding:1px 7px; font-size:calc(11px * var(--font-scale, 1))" data-en-exam-action="tl-add-term" data-zh="' +
                esc(t.zh) + '" data-en="' + esc(t.en) + '" data-note="' + esc(t.note) + '">记进术语便签</button></div></div>'
              );
            })
            .join("") +
          "</div>";
      }
      if (c.culture_ok && c.culture_ok.length) {
        html +=
          '<div class="en-exam-desc" style="font-weight:600">文化词已译对</div><div class="en-wk-list">' +
          c.culture_ok
            .map(function (t) {
              return '<div class="en-wk-issue ok">✓ ' + esc(t.zh) + " → " + esc(t.en) + "</div>";
            })
            .join("") +
          "</div>";
      }
      if (c.case_issues && c.case_issues.length) {
        html +=
          '<div class="en-exam-desc" style="font-weight:600">大小写</div><div class="en-wk-list">' +
          c.case_issues
            .map(function (i) {
              return '<div class="en-wk-issue warn">' + esc(i.text) + "</div>";
            })
            .join("") +
          "</div>";
      }
      if (c.checklist && c.checklist.length) {
        html +=
          '<div class="en-exam-desc" style="font-weight:600">交卷前必查</div><div class="en-wk-list">' +
          c.checklist
            .map(function (t, i) {
              return '<div class="en-wk-issue ok">' + (i + 1) + ". " + esc(t) + "</div>";
            })
            .join("") +
          "</div>";
      }
      html += "</div>";
    }
    return html;
  }

  function renderTranslationTools(kit) {
    var tabs = [
      { id: "guide", label: "三步法" },
      { id: "culture", label: "文化词表" },
      { id: "phrase", label: "高频表达" },
      { id: "rubric", label: "评分标准" },
      { id: "chinglish", label: "中式英语" },
      { id: "advanced", label: "冲刺满分" },
    ];
    var cur = examView.translationPanelTab;
    var tabHtml = tabs
      .map(function (t) {
        return (
          '<button class="en-wk-tab' + (cur === t.id ? " active" : "") + '" data-en-exam-action="tl-tab" data-tab="' + t.id + '">' +
          esc(t.label) + "</button>"
        );
      })
      .join("");

    var body = "";
    if (cur === "culture") {
      var cats = ["全部"].concat(kit.culture_categories || []);
      var q = examView.cultureQuery.trim().toLowerCase();
      var terms = (kit.culture_terms || []).filter(function (t) {
        if (examView.cultureCat !== "全部" && t.cat !== examView.cultureCat) return false;
        if (q && t.zh.toLowerCase().indexOf(q) < 0 && t.en.toLowerCase().indexOf(q) < 0) return false;
        return true;
      });
      body =
        '<div class="en-wk-tabs">' +
        cats
          .map(function (c) {
            return (
              '<button class="en-wk-tab' + (examView.cultureCat === c ? " active" : "") + '" data-en-exam-action="tl-cat" data-cat="' + esc(c) + '">' +
              esc(c) + "</button>"
            );
          })
          .join("") +
        "</div>" +
        '<input id="en-culture-search" class="en-search-input" placeholder="搜中文或英文，如「科举」「opera」" value="' + esc(examView.cultureQueryDraft) + '" />' +
        '<div class="en-exam-desc">点卡片把标准译法记进术语便签，写译文时对着抄。共 ' + terms.length + " 条。</div>" +
        '<div class="en-wk-term">' +
        terms
          .map(function (t) {
            return (
              '<div class="en-wk-term-card" data-en-exam-action="tl-add-term" data-zh="' + esc(t.zh) + '" data-en="' + esc(t.en) + '" data-note="' + esc(t.note) + '">' +
              '<div class="en-wk-term-zh">' + esc(t.zh) + "　<span style=\"font-weight:400;color:var(--muted);font-size:calc(10.5px * var(--font-scale, 1))\">" + esc(t.cat) + "</span></div>" +
              '<div class="en-wk-term-en">' + esc(t.en) + "</div>" +
              '<div class="en-wk-term-note">' + esc(t.note) + "</div>" +
              "</div>"
            );
          })
          .join("") +
        "</div>";
    } else if (cur === "phrase") {
      body =
        '<div class="en-exam-desc">中文里看着简单、一译就翻车的高频表达，直接背这些对应关系。</div>' +
        '<div class="en-wk-list">' +
        (kit.phrase_hints || [])
          .map(function (p) {
            return (
              '<div class="en-wk-issue warn"><div><span class="en-wk-mono bad">' + esc(p.zh) + "</span> → " +
              '<span class="en-wk-mono fix">' + esc(p.en) + "</span>" +
              (p.note ? '<div class="en-exam-desc" style="margin-top:3px">' + esc(p.note) + "</div>" : "") +
              "</div></div>"
            );
          })
          .join("") +
        "</div>";
    } else if (cur === "rubric") {
      var rb = kit.rubric || {};
      body =
        '<div class="en-exam-desc">满分 ' + esc(rb.full_score) + " 分 · " + esc(rb.weight) + " · " + esc(rb.time_minutes) +
        " 分钟 · " + esc(rb.text_length) + "</div>" +
        '<div class="en-exam-desc">常考主题：' + esc(rb.topics) + "</div>" +
        '<div class="en-wk-list">' +
        (rb.bands || [])
          .map(function (b) {
            return (
              '<div class="en-wk-seg"><div class="en-wk-seg-head"><span class="en-wk-seg-para">' + esc(b.band) + "</span>" +
              '<span class="en-wk-seg-role">' + esc(b.label) + "</span></div>" +
              '<div class="en-wk-seg-point">' + esc(b.desc) + "</div></div>"
            );
          })
          .join("") +
        "</div>" +
        '<div class="en-exam-desc" style="font-weight:600">核心考点</div><div class="en-wk-list">' +
        (rb.key_points || [])
          .map(function (p) {
            return '<div class="en-wk-issue warn">' + esc(p) + "</div>";
          })
          .join("") +
        "</div>" +
        '<div class="en-exam-desc" style="font-weight:600">扣分点</div><div class="en-wk-list">' +
        (rb.deductions || [])
          .map(function (d) {
            return '<div class="en-wk-issue bad">' + esc(d) + "</div>";
          })
          .join("") +
        "</div>";
    } else if (cur === "chinglish") {
      body =
        '<div class="en-exam-desc">翻译和写作共用同一套中式英语规则，写译文时对照着看。</div>' +
        '<div class="en-wk-list">' +
        (kit.chinglish_rules || [])
          .map(function (r) {
            return (
              '<div class="en-wk-issue warn"><div>' +
              '<span class="en-wk-mono bad">' + esc(r.bad) + "</span> → " +
              '<span class="en-wk-mono fix">' + esc(r.fix) + "</span>" +
              '<div class="en-exam-desc" style="margin-top:3px">' + esc(r.why) + "</div>" +
              "</div></div>"
            );
          })
          .join("") +
        "</div>";
    } else if (cur === "advanced") {
      var tecs = kit.advanced_translation_techniques || [];
      body =
        '<div class="en-exam-desc">这一栏是冲 13–15 档译文的「加分项」：四字格浓缩、词性转换、长句揉合、语域。基础库解决「不翻错」，这里解决「翻得地道」。</div>' +
        '<div class="en-wk-list">' +
        tecs.map(function (t) {
          return (
            '<div class="en-wk-seg"><div class="en-wk-seg-head"><span class="en-wk-seg-para">' + esc(t.name) + '</span>' +
            '<span class="en-wk-seg-role">' + esc(t.when || "") + '</span></div>' +
            '<div class="en-wk-seg-point">普通：' + esc(t.plain || "") + '</div>' +
            '<div class="en-wk-seg-point" style="color:var(--gold,#e6a23c)">满分：' + esc(t.advanced || "") + '</div>' +
            '<div class="en-exam-desc" style="margin-top:3px">' + esc(t.hint || "") + '</div></div>'
          );
        }).join("") +
        '</div>';
    } else {
      body =
        '<div class="en-wk-list">' +
        (kit.steps || [])
          .map(function (s) {
            return (
              '<div class="en-wk-seg"><div class="en-wk-seg-head"><span class="en-wk-seg-para">第 ' + esc(s.step) + " 步</span>" +
              '<span class="en-wk-seg-role">' + esc(s.name) + " · " + esc(s.goal) + "</span></div>" +
              '<div class="en-wk-seg-point">' + esc(s.detail) + "</div>" +
              '<div class="en-wk-seg-point" style="color:var(--gold,#e6a23c)">自检：' + esc(s.check) + "</div></div>"
            );
          })
          .join("") +
        "</div>" +
        '<div class="en-exam-desc" style="font-weight:600">逐句会被标出来的结构考点</div><div class="en-wk-list">' +
        (kit.cues || [])
          .map(function (c) {
            return '<div class="en-wk-issue warn"><div><b>' + esc(c.label) + "</b>：" + esc(c.hint) + "</div></div>";
          })
          .join("") +
        "</div>";
    }

    return (
      '<div class="en-exam-card">' +
      '<div class="en-exam-title">🧰 翻译工具箱</div>' +
      '<div class="en-wk-tabs">' + tabHtml + "</div>" +
      body +
      "</div>"
    );
  }

  /* ------------------------------------------------------------ 主入口渲染 */

  /* 窄轨检测：词汇面板收起时（约 280px 侧边轨），完整工作台放不下——
     六个子模块的检索条、胶囊、双栏布局都是按展开面板（约 1230px）设计的，
     硬塞进窄轨只会得到一坨横向滚动的碎片。窄轨下只渲染一张入口卡。 */
  function isNarrowHost() {
    try {
      if (window.__enStudioNarrow === true) return true;
      var host = document.getElementById("en-vocab-view");
      return !!(host && host.offsetWidth > 0 && host.offsetWidth < 420);
    } catch (e) {
      return false;
    }
  }

  function renderNarrowLauncher() {
    var features = [
      "📚 母源期刊精读",
      "⚡ 长难句手术刀",
      "🎯 同义改写链",
      "⚠️ 熟词生义雷达",
      "✍️ 写作提分",
      "🔤 翻译提分",
    ];
    return (
      '<div class="en-exam-narrow">' +
      '<div class="en-exam-narrow-title">🎯 考研精读工作台</div>' +
      '<div class="en-exam-narrow-desc">精读、长难句、写作与翻译提分都收在工作台里，需要展开面板使用——收起状态下放不下。</div>' +
      '<div class="en-exam-narrow-list">' +
      features.map(function (f) { return "<div>" + f + "</div>"; }).join("") +
      "</div>" +
      '<button type="button" class="en-exam-narrow-btn" data-en-exam-action="exam-expand">⤢ 展开面板使用</button>' +
      "</div>"
    );
  }

  function render() {
    injectStyle();

    if (isNarrowHost()) return renderNarrowLauncher();

    var tabs = [
      { id: "reading", label: "📚 母源期刊精读" },
      { id: "syntax", label: "⚡ 长难句手术刀" },
      { id: "paraphrase", label: "🎯 同义改写链" },
      { id: "radar", label: "⚠️ 熟词生义雷达" },
      { id: "writing", label: "✍️ 写作提分" },
      { id: "translation", label: "🔤 翻译提分" },
    ];

    var navHtml =
      '<div class="en-exam-nav">' +
      tabs
        .map(function (t) {
          var active = examView.subTab === t.id ? " active" : "";
          return (
            '<button class="en-exam-nav-btn' + active + '" data-en-exam-subtab="' + t.id + '">' +
            t.label +
            "</button>"
          );
        })
        .join("") +
      "</div>";

    var contentHtml = "";
    if (examView.subTab === "reading") contentHtml = renderReadingTab();
    else if (examView.subTab === "syntax") contentHtml = renderSyntaxSection();
    else if (examView.subTab === "paraphrase") contentHtml = renderParaphraseSection();
    else if (examView.subTab === "radar") contentHtml = renderRadarSection();
    else if (examView.subTab === "writing") contentHtml = renderWritingSection();
    else if (examView.subTab === "translation") contentHtml = renderTranslationSection();

    var errHtml = examView.error
      ? '<div style="background:rgba(245,108,108,0.1); border:1px solid var(--red); color:var(--red); padding:8px 12px; border-radius:6px; font-size:calc(12px * var(--font-scale, 1));">' + esc(examView.error) + '</div>'
      : "";

    var notHtml = examView.notice
      ? '<div style="background:rgba(103,194,58,0.1); border:1px solid var(--green); color:var(--green); padding:8px 12px; border-radius:6px; font-size:calc(12px * var(--font-scale, 1));">' + esc(examView.notice) + '</div>'
      : "";

    return (
      '<div class="en-exam-wrap">' +
      navHtml +
      errHtml +
      notHtml +
      contentHtml +
      renderSelOverlay() +
      renderSideDrawer() +
      "</div>"
    );
  }

  /* ------------------------------------------------------------ 动作分发处理器 */

  async function handleAction(action, target) {
    /* 窄轨入口卡：展开面板后重渲染，换回完整工作台（等展开动画落定再渲染，
       否则 isNarrowHost 还读到旧宽度） */
    if (action === "exam-expand") {
      if (window.enVocabExpandStudio) window.enVocabExpandStudio(target);
      setTimeout(function () {
        if (window.enVocabRerender) window.enVocabRerender();
      }, 400);
      return;
    }
    if (action === "filter-journal") {
      var jid = target.dataset.journalId;
      if (jid) {
        examView.selectedJournalId = jid;
        examView.loading = true;
        if (window.enVocabRerender) window.enVocabRerender();
        await fetchArticlesList();
      }
      return;
    }

    if (action === "filter-category") {
      var catId = target.dataset.catId;
      if (catId) {
        examView.selectedTopicCategory = catId;
        examView.loading = true;
        if (window.enVocabRerender) window.enVocabRerender();
        await fetchArticlesList();
      }
      return;
    }

    if (action === "do-articles-search") {
      var inputEl = document.getElementById("en-article-search-input");
      examView.articleSearchQuery = inputEl ? inputEl.value.trim() : "";
      examView.loading = true;
      if (window.enVocabRerender) window.enVocabRerender();
      await fetchArticlesList();
      return;
    }

    /* ---------------- 联网实时检索泳道动作 ---------------- */

    if (action === "set-lane") {
      examView.onlineMode = target.dataset.lane !== "local";
      if (window.enVocabRerender) window.enVocabRerender();
      if (examView.onlineMode && !examView.onlineList.length) {
        fetchOnlineSearch();
      }
      return;
    }

    if (action === "filter-online-source") {
      var sid = target.dataset.sourceId;
      if (sid) {
        examView.onlineSourceId = sid;
        examView.onlineLoading = true;
        if (window.enVocabRerender) window.enVocabRerender();
        await fetchOnlineSearch();
      }
      return;
    }

    if (action === "filter-online-topic") {
      var tid = target.dataset.topicId;
      if (tid) {
        examView.onlineTopic = tid;
        examView.onlineLoading = true;
        if (window.enVocabRerender) window.enVocabRerender();
        await fetchOnlineSearch();
      }
      return;
    }

    if (action === "do-online-search") {
      var oEl = document.getElementById("en-online-search-input");
      examView.onlineQuery = oEl ? oEl.value.trim() : "";
      examView.onlineLoading = true;
      if (window.enVocabRerender) window.enVocabRerender();
      await fetchOnlineSearch();
      return;
    }

    if (action === "load-online-article") {
      await loadOnlineArticle(target.dataset.articleId, target.dataset.articleUrl);
      return;
    }

    if (action === "close-online-article") {
      examView.onlineArticle = null;
      examView.highlights = [];
      examView.side = null;
      examView.sel = null;
      examView.selResult = null;
      examView.hlEditingId = "";
      if (window.enVocabRerender) window.enVocabRerender();
      return;
    }

    if (action === "close-reader") {
      examView.readerOpen = false;
      // 关掉阅读页时把划词浮层一起收掉：它们挂在 body 层级，不会随阅读页一起消失，
      // 留着就会浮在文章列表上，看起来像「点了关闭但弹层还在」。
      examView.sel = null;
      examView.selResult = null;
      examView.side = null;
      if (window.enVocabRerender) window.enVocabRerender();
      return;
    }

    if (action === "open-reader") {
      if (examView.activeReading) {
        examView.readerOpen = true;
        if (window.enVocabRerender) window.enVocabRerender();
      }
      return;
    }

    if (action === "load-article") {
      var artId = target.dataset.articleId;
      if (artId) {
        await loadArticleDetail(artId);
      }
      return;
    }

    if (action === "set-view-mode") {
      var mode = target.dataset.mode;
      if (mode) {
        examView.readingViewMode = mode;
        if (window.enVocabRerender) window.enVocabRerender();
      }
      return;
    }

    if (action === "toggle-para-collapse") {
      var pIndex = target.dataset.paraIndex;
      if (pIndex) {
        examView.collapsedParagraphs[pIndex] = !examView.collapsedParagraphs[pIndex];
        if (window.enVocabRerender) window.enVocabRerender();
      }
      return;
    }

    if (action === "send-sent-to-syntax") {
      var sentTxt = target.dataset.sentText;
      if (sentTxt) {
        examView.subTab = "syntax";
        examView.sentenceInput = sentTxt;
        examView.syntaxResult = null;
        resetSyntaxPartState();
        if (window.enVocabRerender) window.enVocabRerender();
        handleAction("do-syntax-parse", null);
      }
      return;
    }

    /* 长难句成分的折叠与聚焦。状态存在 examView 上而不是 DOM 上：
       这个视图每次交互都整块重渲染（node.innerHTML = ...），
       挂在元素上的 class 会被下一次渲染冲掉。 */
    if (action === "toggle-syntax-part") {
      var partIdx = parseInt(target.dataset.partIndex, 10);
      if (!isNaN(partIdx)) {
        examView.collapsedParts[partIdx] = !examView.collapsedParts[partIdx];
        if (window.enVocabRerender) window.enVocabRerender();
      }
      return;
    }

    if (action === "focus-syntax-part") {
      var focusIdx = parseInt(target.dataset.partIndex, 10);
      if (!isNaN(focusIdx)) {
        examView.syntaxFocus = examView.syntaxFocus === focusIdx ? null : focusIdx;
        if (window.enVocabRerender) window.enVocabRerender();
      }
      return;
    }

    if (action === "toggle-all-syntax-parts") {
      var allComps = (examView.syntaxResult && examView.syntaxResult.components) || [];
      var collapsibleIdx = [];
      allComps.forEach(function (c, i) {
        if (c.can_collapse) collapsibleIdx.push(i);
      });
      var everyCollapsed =
        collapsibleIdx.length > 0 &&
        collapsibleIdx.every(function (i) {
          return !!examView.collapsedParts[i];
        });
      collapsibleIdx.forEach(function (i) {
        examView.collapsedParts[i] = !everyCollapsed;
      });
      if (window.enVocabRerender) window.enVocabRerender();
      return;
    }

    if (action === "toggle-custom-tools") {
      examView.customToolsOpen = !examView.customToolsOpen;
      if (window.enVocabRerender) window.enVocabRerender();
      return;
    }

    /* 「高级探索工具箱」里这两个按钮此前只渲染、没接处理函数，点了没反应。
       后端 /fetch-reading 与 /generate-reading 其实早就存在，这里接上并落到同一个
       activeReading，于是「任意链接抓取」和「LLM 命题合成」产出的篇章
       与母源库篇章共用同一套精读视图，不再各走各的。 */
    if (action === "do-fetch-url") {
      var urlEl = document.getElementById("en-fetch-url");
      var fetchUrl = urlEl ? urlEl.value.trim() : examView.fetchUrl || "";
      if (!fetchUrl) {
        examView.error = "请先粘贴外刊文章网址（以 http:// 或 https:// 开头）。";
        if (window.enVocabRerender) window.enVocabRerender();
        return;
      }
      examView.fetchUrl = fetchUrl;
      examView.loading = true;
      examView.error = "";
      if (window.enVocabRerender) window.enVocabRerender();
      try {
        var fetchRes = await window.api(API + "/fetch-reading", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: fetchUrl }),
        });
        if (fetchRes && fetchRes.ok) {
          adoptReading(fetchRes, "已抓取《" + fetchRes.title + "》正文，可直接开始精读。");
        }
      } catch (err) {
        examView.error = friendlyErr(err, "外刊正文抓取失败：");
      } finally {
        examView.loading = false;
        if (window.enVocabRerender) window.enVocabRerender();
        scrollReaderTop();
      }
      return;
    }

    if (action === "do-gen-reading") {
      var topicEl = document.getElementById("en-gen-topic");
      var styleEl = document.getElementById("en-gen-style");
      examView.genTopic = topicEl ? topicEl.value.trim() : examView.genTopic || "";
      examView.genStyle = styleEl ? styleEl.value : examView.genStyle || "考研真题";
      examView.loading = true;
      examView.error = "";
      if (window.enVocabRerender) window.enVocabRerender();
      try {
        var genRes = await window.api(API + "/generate-reading", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            topic: examView.genTopic,
            style: examView.genStyle,
            level: examView.genLevel,
          }),
        });
        if (genRes && genRes.ok) {
          adoptReading(
            genRes,
            (genRes.ai_generated ? "TJU-LLM 已生成《" : "已载入《") +
              genRes.title +
              "》，可直接开始精读。"
          );
        }
      } catch (err) {
        examView.error = friendlyErr(err, "命题生成失败：");
      } finally {
        examView.loading = false;
        if (window.enVocabRerender) window.enVocabRerender();
        scrollReaderTop();
      }
      return;
    }

    if (action === "toggle-reading-zh") {
      examView.readingShowZh = !examView.readingShowZh;
      if (window.enVocabRerender) window.enVocabRerender();
      return;
    }

    if (action === "set-read-fontsize") {
      var sizeDelta = parseInt(target.dataset.delta, 10);
      if (!isNaN(sizeDelta)) readSizeStep(sizeDelta);
      return;
    }

    if (action === "select-quiz-option") {
      var qk = target.dataset.quizKey;
      if (qk) {
        examView.selectedAnswer = qk;
        if (window.enVocabRerender) window.enVocabRerender();
      }
      return;
    }

    if (action === "fill-syntax-example") {
      var demo = "Although generative artificial intelligence has been hailed as the most consequential breakthrough since electrification, most modern enterprises still struggle to weather the messy organizational transitions required to harness its full potential.";
      examView.sentenceInput = demo;
      var el = document.getElementById("en-syntax-input");
      if (el) el.value = demo;
      if (window.enVocabRerender) window.enVocabRerender();
      return;
    }

    if (action === "do-syntax-parse") {
      var inEl = document.getElementById("en-syntax-input");
      var txt = inEl ? inEl.value.trim() : (examView.sentenceInput || "");
      if (!txt) {
        examView.error = "请先输入长难句。";
        if (window.enVocabRerender) window.enVocabRerender();
        return;
      }
      examView.sentenceInput = txt;
      examView.loading = true;
      examView.error = "";
      if (window.enVocabRerender) window.enVocabRerender();

      try {
        var res = await window.api(API + "/syntax-parse", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sentence: txt }),
        });
        if (res && res.ok) {
          examView.syntaxResult = res;
          resetSyntaxPartState();
          examView.notice = "长难句拆解成功！";
        }
      } catch (err) {
        examView.error = "拆解失败：" + (err.message || String(err));
      } finally {
        examView.loading = false;
        if (window.enVocabRerender) window.enVocabRerender();
      }
      return;
    }

    if (action === "fill-para-example") {
      examView.paraSource = "most modern enterprises still struggle to weather the messy organizational transitions required to harness its full potential";
      examView.paraExam = "corporations encounter great challenges in adapting to internal structural changes";
      var sEl = document.getElementById("en-para-src");
      var eEl = document.getElementById("en-para-exam");
      if (sEl) sEl.value = examView.paraSource;
      if (eEl) eEl.value = examView.paraExam;
      if (window.enVocabRerender) window.enVocabRerender();
      return;
    }

    if (action === "do-para-extract") {
      var sEl2 = document.getElementById("en-para-src");
      var eEl2 = document.getElementById("en-para-exam");
      var sTxt = sEl2 ? sEl2.value.trim() : examView.paraSource;
      var eTxt = eEl2 ? eEl2.value.trim() : examView.paraExam;
      if (!sTxt || !eTxt) {
        examView.error = "请同时提供原文句与题目选项句。";
        if (window.enVocabRerender) window.enVocabRerender();
        return;
      }
      examView.paraSource = sTxt;
      examView.paraExam = eTxt;
      examView.loading = true;
      examView.error = "";
      if (window.enVocabRerender) window.enVocabRerender();

      try {
        var pRes = await window.api(API + "/paraphrase-extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source_sentence: sTxt, exam_sentence: eTxt }),
        });
        if (pRes && pRes.ok) {
          examView.paraResult = pRes;
          examView.notice = "成功萃取同义替换对！";
        }
      } catch (err) {
        examView.error = "提取失败：" + (err.message || String(err));
      } finally {
        examView.loading = false;
        if (window.enVocabRerender) window.enVocabRerender();
      }
      return;
    }

    if (action === "save-para") {
      var pIdx = parseInt(target.dataset.paraIdx, 10);
      var pItem = null;
      if (examView.paraResult && examView.paraResult.paraphrases) {
        pItem = examView.paraResult.paraphrases[pIdx];
      } else if (examView.activeReading && examView.activeReading.paraphrases) {
        pItem = examView.activeReading.paraphrases[pIdx];
      }
      if (!pItem) return;

      var pKey = (pItem.source_phrase || "") + "->" + (pItem.target_phrase || "");
      target.disabled = true;
      target.innerText = "⏳ 正在排入FSRS...";

      try {
        var sRes = await window.api(API + "/paraphrase-save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source_phrase: pItem.source_phrase,
            target_phrase: pItem.target_phrase,
            type: pItem.type || "同义改写",
            explanation: pItem.explanation || "",
          }),
        });

        if (sRes && sRes.ok) {
          examView.savedParaphraseIds[pKey] = true;
          if (window.showToast) {
            window.showToast("已排入今日 FSRS 复习计划！", { variant: "success" });
          }
          if (window.enVocabRerender) window.enVocabRerender();
        }
      } catch (err) {
        target.disabled = false;
        target.innerText = "⭐ 存入 FSRS 复习库";
        if (window.showToast) window.showToast("保存失败：" + err.message, { variant: "error" });
      }
      return;
    }

    if (action === "go-review-saved") {
      if (window.enVocabSwitchTab) {
        window.enVocabSwitchTab("study");
      } else if (window.showToast) {
        window.showToast("请在上方切换至『今日复习』开始同义替换闪卡记忆！", { variant: "info" });
      }
      return;
    }

    if (action === "do-radar-search") {
      var qEl = document.getElementById("en-radar-query");
      var q = qEl ? qEl.value.trim() : "";
      examView.radarQuery = q;
      try {
        var rRes = await window.api(API + "/scan-false-friends", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: q || "weather sound balance school prompt subject address appreciate game novel harbor flat vehicle pool plant draft minute coin account consume capital" }),
        });
        if (rRes && rRes.ok) {
          examView.radarResults = rRes.items || [];
          if (window.enVocabRerender) window.enVocabRerender();
        }
      } catch (err) {
        examView.error = "雷达扫描失败：" + err.message;
      }
      return;
    }

    /* ---------------- 划词交互：浮出条 / 高亮笔记 / 侧边分析 ---------------- */

    if (action === "sel-close") {
      closeSelection();
      return;
    }

    if (action === "sel-close-result") {
      examView.selResult = null;
      if (window.enVocabRerender) window.enVocabRerender();
      return;
    }

    if (action === "sel-highlight") { await selHighlight(); return; }
    if (action === "sel-vocab") { await selAddVocab(); return; }
    if (action === "sel-translate") { await selTranslate(); return; }
    if (action === "sel-rewrite") { await selRewrite(); return; }
    if (action === "sel-syntax") { await selSyntax(); return; }

    if (action === "open-side") {
      examView.sideOpen = true;
      var sideWant = target.dataset.sideTab;
      if (sideWant) examView.sideTab = sideWant;
      examView.hlEditingId = "";
      if (window.enVocabRerender) window.enVocabRerender();
      if (examView.sideTab === "collocations" || examView.sideTab === "argument") loadSideAnalysis(false);
      return;
    }

    if (action === "close-side") {
      examView.sideOpen = false;
      examView.hlEditingId = "";
      if (window.enVocabRerender) window.enVocabRerender();
      return;
    }

    if (action === "side-tab") {
      var sideTab = target.dataset.sideTab;
      if (sideTab) {
        examView.sideTab = sideTab;
        examView.hlEditingId = "";
        if (window.enVocabRerender) window.enVocabRerender();
        if (sideTab === "collocations" || sideTab === "argument") loadSideAnalysis(false);
      }
      return;
    }

    if (action === "refresh-side") {
      await loadSideAnalysis(true);
      return;
    }

    if (action === "open-hl") {
      var hlItem = findHighlight(target.dataset.hlId);
      if (hlItem) {
        examView.sideOpen = true;
        examView.sideTab = "notes";
        examView.hlEditingId = hlItem.highlight_id;
        examView.hlDraft = String(hlItem.note || "");
        if (window.enVocabRerender) window.enVocabRerender();
      }
      return;
    }

    if (action === "edit-hl-note") {
      var editItem = findHighlight(target.dataset.hlId);
      examView.sideOpen = true;
      examView.sideTab = "notes";
      examView.hlEditingId = target.dataset.hlId;
      examView.hlDraft = editItem ? String(editItem.note || "") : "";
      if (window.enVocabRerender) window.enVocabRerender();
      return;
    }

    if (action === "pick-hl-color") {
      if (target.dataset.color && examView.hlEditingId) {
        await patchHighlight(examView.hlEditingId, { color: target.dataset.color });
      }
      return;
    }

    if (action === "save-hl-note") {
      var noteInput = document.getElementById("en-hl-note-input");
      var draft = noteInput ? noteInput.value : examView.hlDraft;
      examView.hlDraft = draft;
      await patchHighlight(target.dataset.hlId, { note: draft });
      examView.hlEditingId = "";
      if (window.enVocabRerender) window.enVocabRerender();
      return;
    }

    if (action === "del-hl") {
      await removeHighlight(target.dataset.hlId);
      return;
    }

    if (action === "jump-hl") {
      jumpToHighlight(target.dataset.hlId);
      return;
    }

    if (action === "do-rewrite") {
      await doParaphraseRewrite();
      return;
    }

    /* ---------------- 写作提分 / 翻译提分动作 ---------------- */

    if (action === "wk-load-kit") {
      await loadWritingKit(true);
      return;
    }

    if (action === "wk-tool") {
      examView.writingToolTab = target.dataset.tool || "sentence";
      if (window.enVocabRerender) window.enVocabRerender();
      return;
    }

    if (action === "wk-tpl") {
      examView.writingTemplateId = target.dataset.tpl || examView.writingTemplateId;
      if (window.enVocabRerender) window.enVocabRerender();
      return;
    }

    if (action === "wk-clear") {
      examView.writingDraft = "";
      examView.writingTopic = "";
      examView.writingCheck = null;
      examView.writingPolish = null;
      examView.writingError = "";
      if (window.enVocabRerender) window.enVocabRerender();
      return;
    }

    /* 句型 / 过渡词点一下就接到作文末尾，用户再改主语和关键词 */
    if (action === "wk-insert") {
      var insText = String(target.dataset.text || "").trim();
      if (insText) {
        var curDraft = String(examView.writingDraft || "").replace(/\s+$/, "");
        examView.writingDraft = curDraft ? curDraft + "\n" + insText : insText;
        if (window.enVocabRerender) window.enVocabRerender();
      }
      return;
    }

    if (action === "wk-upgrade") {
      var upBasic = String(target.dataset.basic || "");
      var upTo = String(target.dataset.to || "");
      var draftNow = String(examView.writingDraft || "");
      if (!upBasic || !upTo) return;
      if (!draftNow.trim()) {
        examView.writingError = "先写点正文，再点替换词——不然没东西可换。";
        if (window.enVocabRerender) window.enVocabRerender();
        return;
      }
      var reBasic = new RegExp("\\b" + upBasic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "gi");
      examView.writingDraft = draftNow.replace(reBasic, upTo);
      if (window.enVocabRerender) window.enVocabRerender();
      return;
    }

    if (action === "wk-check") {
      await runWritingCheck();
      return;
    }

    if (action === "wk-polish") {
      await runWritingPolish();
      return;
    }

    if (action === "wk-demo") {
      await runWritingDemo(target.dataset.tpl || "");
      return;
    }

    if (action === "tl-load-kit") {
      await loadTranslationKit(true);
      return;
    }

    if (action === "tl-tab") {
      examView.translationPanelTab = target.dataset.tab || "guide";
      if (window.enVocabRerender) window.enVocabRerender();
      return;
    }

    if (action === "tl-cat") {
      examView.cultureCat = target.dataset.cat || "全部";
      if (window.enVocabRerender) window.enVocabRerender();
      return;
    }

    /* 文化词标准译法收进术语便签，写译文时对着抄 */
    if (action === "tl-add-term") {
      var termZh = String(target.dataset.zh || "");
      if (termZh) {
        var dup = examView.translationTerms.some(function (t) {
          return t.zh === termZh;
        });
        if (!dup) {
          examView.translationTerms.push({
            zh: termZh,
            en: String(target.dataset.en || ""),
            note: String(target.dataset.note || ""),
          });
          if (window.enVocabRerender) window.enVocabRerender();
        }
      }
      return;
    }

    if (action === "tl-del-term") {
      var delZh = String(target.dataset.zh || "");
      examView.translationTerms = examView.translationTerms.filter(function (t) {
        return t.zh !== delZh;
      });
      if (window.enVocabRerender) window.enVocabRerender();
      return;
    }

    if (action === "tl-clear") {
      examView.translationSource = "";
      examView.translationTarget = "";
      examView.translationGuide = null;
      examView.translationCheck = null;
      examView.translationError = "";
      if (window.enVocabRerender) window.enVocabRerender();
      return;
    }

    if (action === "tl-guide") {
      await runTranslationGuide();
      return;
    }

    if (action === "tl-check") {
      await runTranslationCheck();
      return;
    }

    if (action === "tl-demo-cat") {
      examView.translationDemoCategory = target.dataset.cat || "";
      if (window.enVocabRerender) window.enVocabRerender();
      return;
    }

    if (action === "tl-demo") {
      await runTranslationDemo(target.dataset.cat || "");
      return;
    }

    /* ---------------- AI 演示历史动作 ---------------- */

    if (action === "wk-history-refresh") {
      await loadWritingHistory(true);
      return;
    }
    if (action === "wk-history-open") {
      var wrec = (examView.writingHistory || []).filter(function (r) {
        return r.record_id === target.dataset.id;
      })[0];
      if (wrec && wrec.payload) {
        applyWritingResult(wrec.payload);
        if (window.enVocabRerender) window.enVocabRerender();
      }
      return;
    }
    if (action === "wk-history-del") {
      await deleteHistoryRecord("wk", target.dataset.id);
      return;
    }

    if (action === "tl-history-refresh") {
      await loadTranslationHistory(true);
      return;
    }
    if (action === "tl-history-open") {
      var trec = (examView.translationHistory || []).filter(function (r) {
        return r.record_id === target.dataset.id;
      })[0];
      if (trec && trec.payload) {
        applyTranslationResult(trec.payload);
        if (window.enVocabRerender) window.enVocabRerender();
      }
      return;
    }
    if (action === "tl-history-del") {
      await deleteHistoryRecord("tl", target.dataset.id);
      return;
    }
  }

  /* ------------------------------------------------------------ 写作 / 翻译提分数据层 */

  async function loadWritingKit(force) {
    if (examView.writingKitLoading) return;
    if (examView.writingKit && !force) return;
    examView.writingKitLoading = true;
    examView.writingError = "";
    if (window.enVocabRerender) window.enVocabRerender();
    try {
      var res = await window.api(API + "/writing/kit");
      if (res && res.ok) {
        examView.writingKit = res;
        var tpls = res.templates || [];
        if (tpls.length && !tpls.some(function (t) { return t.id === examView.writingTemplateId; })) {
          examView.writingTemplateId = tpls[0].id;
        }
      } else {
        examView.writingError = "写作工具箱返回异常。";
      }
    } catch (err) {
      examView.writingError = friendlyErr(err, "写作工具箱加载失败：");
    } finally {
      examView.writingKitLoading = false;
      if (window.enVocabRerender) window.enVocabRerender();
    }
  }

  /* 重渲染会把 textarea 换成新节点，所以点按钮前先从 DOM 收一次最新草稿 */
  function syncWritingDraft() {
    var draftEl = document.getElementById("en-writing-draft");
    if (draftEl) examView.writingDraft = draftEl.value;
    var topicEl = document.getElementById("en-writing-topic");
    if (topicEl) examView.writingTopic = topicEl.value.trim();
  }

  async function runWritingCheck() {
    syncWritingDraft();
    var text = String(examView.writingDraft || "").trim();
    if (!text) {
      examView.writingError = "请先粘贴作文正文，再点规则体检。";
      if (window.enVocabRerender) window.enVocabRerender();
      return;
    }
    examView.writingBusy = "check";
    examView.writingError = "";
    if (window.enVocabRerender) window.enVocabRerender();
    try {
      var res = await window.api(API + "/writing/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text, topic: examView.writingTopic }),
      });
      if (res && res.ok) {
        examView.writingCheck = res;
      } else {
        examView.writingError = "体检没有返回结果，稍后再试。";
      }
    } catch (err) {
      examView.writingError = friendlyErr(err, "体检失败：");
    } finally {
      examView.writingBusy = "";
      if (window.enVocabRerender) window.enVocabRerender();
    }
  }

  async function runWritingPolish() {
    syncWritingDraft();
    var text = String(examView.writingDraft || "").trim();
    if (!text) {
      examView.writingError = "请先粘贴作文正文，再点 AI 升格。";
      if (window.enVocabRerender) window.enVocabRerender();
      return;
    }
    examView.writingBusy = "polish";
    examView.writingError = "";
    if (window.enVocabRerender) window.enVocabRerender();
    try {
      var res = await window.api(API + "/writing/polish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text, topic: examView.writingTopic }),
      });
      if (res && res.ok) {
        examView.writingPolish = res;
        /* 模型不可用时后端退回规则报告，顺手把它当体检结果用 */
        if (res.rule_report) examView.writingCheck = res.rule_report;
      } else {
        examView.writingError = "升格没有返回结果，稍后再试。";
      }
    } catch (err) {
      examView.writingError = friendlyErr(err, "升格失败：");
    } finally {
      examView.writingBusy = "";
      if (window.enVocabRerender) window.enVocabRerender();
    }
  }

  /* 把一次写作演示的结果铺回编辑器与报告区。演示与「载入历史」共用这一条，
     保证两边的呈现完全一致。 */
  function applyWritingResult(res) {
    examView.writingDraft = String(res.essay || "");
    examView.writingTopic = String(res.topic_en || res.topic_zh || "");
    examView.writingCheck = res.rule_report || null;
    if (res.template_id) examView.writingTemplateId = res.template_id;
    if (res.ai_generated) {
      examView.writingPolish = {
        ai_generated: true,
        band: res.band,
        band_reason: res.band_reason,
        strengths: res.strengths,
        fixes: res.fixes,
        upgraded_essay: res.upgraded_essay,
        skeleton: res.skeleton,
      };
      examView.notice = "AI 已按「" + String(res.template_name || "所选题型") + "」出题并写好范文，右侧是它对自己的升格批改。";
    } else {
      /* 模型没接上时后端给的是题库范文，仍然是一份能看的样板 */
      examView.writingPolish = null;
      examView.notice = String(res.notice || "已载入题库范文。");
    }
  }

  function applyTranslationResult(res) {
    examView.translationSource = String(res.source || "");
    examView.translationTarget = String(res.target || "");
    examView.translationGuide = res.guide || null;
    examView.translationCheck = res.check || null;
    if (res.category) examView.translationDemoCategory = res.category;
    examView.notice = res.ai_generated
      ? "AI 已按「" + String(res.category || "") + "」出题并自己译了一版，右侧是它对自己的体检。"
      : String(res.notice || "已载入题库参考译文。");
  }

  /* 一键演示：后端出题 + 写范文 + 自升格，这里把结果灌回编辑器和报告区，
     于是「体检 / 升格 / 换词」这些按钮立刻都能在这个范本上继续用。 */
  async function runWritingDemo(templateId) {
    if (examView.writingBusy) return;
    if (String(examView.writingDraft || "").trim()) {
      var okToReplace = window.confirm("演示会用 AI 的范文覆盖你现在的正文，确定继续？");
      if (!okToReplace) return;
    }
    examView.writingBusy = "demo";
    examView.writingError = "";
    if (window.enVocabRerender) window.enVocabRerender();
    try {
      var res = await window.api(API + "/writing/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template_id: templateId || "" }),
      });
      if (res && res.ok) {
        applyWritingResult(res);
        examView.writingHistoryLoaded = false; // 演示已落库，历史列表要重取
      } else {
        examView.writingError = "演示没有返回结果，稍后再试。";
      }
    } catch (err) {
      examView.writingError = friendlyErr(err, "演示失败：");
    } finally {
      examView.writingBusy = "";
      if (window.enVocabRerender) window.enVocabRerender();
    }
  }

  async function loadTranslationKit(force) {
    if (examView.translationKitLoading) return;
    if (examView.translationKit && !force) return;
    examView.translationKitLoading = true;
    examView.translationError = "";
    if (window.enVocabRerender) window.enVocabRerender();
    try {
      var res = await window.api(API + "/translation/kit");
      if (res && res.ok) {
        examView.translationKit = res;
      } else {
        examView.translationError = "翻译工具箱返回异常。";
      }
    } catch (err) {
      examView.translationError = friendlyErr(err, "翻译工具箱加载失败：");
    } finally {
      examView.translationKitLoading = false;
      if (window.enVocabRerender) window.enVocabRerender();
    }
  }

  function syncTranslationInputs() {
    var srcEl = document.getElementById("en-tl-source");
    if (srcEl) examView.translationSource = srcEl.value;
    var tgtEl = document.getElementById("en-tl-target");
    if (tgtEl) examView.translationTarget = tgtEl.value;
  }

  async function runTranslationGuide() {
    syncTranslationInputs();
    var zh = String(examView.translationSource || "").trim();
    if (!zh) {
      examView.translationError = "请先粘贴要翻译的中文段落。";
      if (window.enVocabRerender) window.enVocabRerender();
      return;
    }
    examView.translationBusy = "guide";
    examView.translationError = "";
    if (window.enVocabRerender) window.enVocabRerender();
    try {
      var res = await window.api(API + "/translation/guide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: zh }),
      });
      if (res && res.ok) {
        examView.translationGuide = res;
      } else {
        examView.translationError = "引导没有返回结果，稍后再试。";
      }
    } catch (err) {
      examView.translationError = friendlyErr(err, "三步法引导失败：");
    } finally {
      examView.translationBusy = "";
      if (window.enVocabRerender) window.enVocabRerender();
    }
  }

  async function runTranslationCheck() {
    syncTranslationInputs();
    var zh = String(examView.translationSource || "").trim();
    var en = String(examView.translationTarget || "").trim();
    if (!en) {
      examView.translationError = "请先粘贴你的英文译文，再点体检。";
      if (window.enVocabRerender) window.enVocabRerender();
      return;
    }
    examView.translationBusy = "check";
    examView.translationError = "";
    if (window.enVocabRerender) window.enVocabRerender();
    try {
      var res = await window.api(API + "/translation/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: zh, target: en }),
      });
      if (res && res.ok) {
        examView.translationCheck = res;
      } else {
        examView.translationError = "体检没有返回结果，稍后再试。";
      }
    } catch (err) {
      examView.translationError = friendlyErr(err, "译文体检失败：");
    } finally {
      examView.translationBusy = "";
      if (window.enVocabRerender) window.enVocabRerender();
    }
  }

  /* 一键演示：后端按标签出题 + 自己译一版，原文/译文/引导/体检一次到位 */
  async function runTranslationDemo(category) {
    if (examView.translationBusy) return;
    if (String(examView.translationSource || "").trim() || String(examView.translationTarget || "").trim()) {
      var okToReplace = window.confirm("演示会用 AI 的原文与译文覆盖你现在的内容，确定继续？");
      if (!okToReplace) return;
    }
    examView.translationBusy = "demo";
    examView.translationError = "";
    if (window.enVocabRerender) window.enVocabRerender();
    try {
      var res = await window.api(API + "/translation/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: category || "" }),
      });
      if (res && res.ok) {
        applyTranslationResult(res);
        examView.translationHistoryLoaded = false; // 演示已落库，历史列表要重取
      } else {
        examView.translationError = "演示没有返回结果，稍后再试。";
      }
    } catch (err) {
      examView.translationError = friendlyErr(err, "演示失败：");
    } finally {
      examView.translationBusy = "";
      if (window.enVocabRerender) window.enVocabRerender();
    }
  }

  /* ------------------------------------------------------------ AI 演示历史 */

  function shortDate(iso) {
    if (!iso) return "";
    var m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[2] + "/" + m[3] + " " + String(iso).slice(11, 16);
    return String(iso).slice(0, 16);
  }

  async function loadWritingHistory(force) {
    if (examView.writingHistoryLoading) return;
    if (!window.api) return;
    if (examView.writingHistoryLoaded && !force) return;
    examView.writingHistoryLoading = true;
    try {
      var res = await window.api(API + "/demo-records?kind=writing");
      if (res && res.ok) {
        examView.writingHistory = res.items || [];
      }
      examView.writingHistoryLoaded = true; // 无论成败都标记，避免 render 反复触发重取
    } catch (_) {
      examView.writingHistoryLoaded = true;
    } finally {
      examView.writingHistoryLoading = false;
      if (window.enVocabRerender) window.enVocabRerender();
    }
  }

  async function loadTranslationHistory(force) {
    if (examView.translationHistoryLoading) return;
    if (!window.api) return;
    if (examView.translationHistoryLoaded && !force) return;
    examView.translationHistoryLoading = true;
    try {
      var res = await window.api(API + "/demo-records?kind=translation");
      if (res && res.ok) {
        examView.translationHistory = res.items || [];
      }
      examView.translationHistoryLoaded = true;
    } catch (_) {
      examView.translationHistoryLoaded = true;
    } finally {
      examView.translationHistoryLoading = false;
      if (window.enVocabRerender) window.enVocabRerender();
    }
  }

  function renderHistoryCard(items, kind, emptyHint) {
    var rows = (items || [])
      .map(function (r) {
        var badge =
          r.source === "ai"
            ? '<span class="en-wk-seg-role" style="color:var(--green,#67c23a)">AI 生成</span>'
            : '<span class="en-wk-seg-role">题库样板</span>';
        return (
          '<div class="en-wk-seg">' +
          '<div class="en-wk-seg-head">' +
          '<span class="en-wk-seg-para">' + esc(r.title || "（无题）") + "</span>" +
          badge +
          '<span class="en-wk-seg-words">' + esc(shortDate(r.created_at)) + "</span>" +
          "</div>" +
          '<div class="en-exam-row" style="margin-top:4px">' +
          '<button class="en-exam-btn sec" style="padding:2px 10px; font-size:calc(11px * var(--font-scale, 1))" data-en-exam-action="' + kind + '-history-open" data-id="' + esc(r.record_id) + '">载入</button>' +
          '<button class="en-exam-btn sec" style="padding:2px 10px; font-size:calc(11px * var(--font-scale, 1))" data-en-exam-action="' + kind + '-history-del" data-id="' + esc(r.record_id) + '">删除</button>' +
          "</div></div>"
        );
      })
      .join("");
    return (
      '<div class="en-exam-card">' +
      '<div class="en-exam-title">🕘 历史记录' +
      '<button class="en-exam-btn sec" style="padding:2px 10px; font-size:calc(11px * var(--font-scale, 1)); margin-left:8px" data-en-exam-action="' + kind + '-history-refresh">↻ 刷新</button>' +
      "</div>" +
      '<div class="en-exam-desc">每次 AI 演示都会自动留存，点「载入」把那次结果原样铺回编辑器。</div>' +
      (rows
        ? '<div class="en-wk-list">' + rows + "</div>"
        : '<div class="en-exam-desc" style="margin-top:6px">' + esc(emptyHint) + "</div>") +
      "</div>"
    );
  }

  async function deleteHistoryRecord(kind, id) {
    if (!id) return;
    try {
      var res = await window.api(API + "/demo-records/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ record_id: id }),
      });
      if (res && res.ok) {
        if (kind === "wk") {
          examView.writingHistoryLoaded = false;
          await loadWritingHistory(true);
        } else {
          examView.translationHistoryLoaded = false;
          await loadTranslationHistory(true);
        }
      }
    } catch (err) {
      if (window.showToast) window.showToast("删除失败：" + err.message, { variant: "error" });
    }
  }

  /* ------------------------------------------------------------ 异步数据拉取与初始化 */

  async function fetchArticlesList() {
    examView.loading = true;
    try {
      if (window.api) {
        var params = [];
        if (examView.articleSearchQuery) {
          params.push("query=" + encodeURIComponent(examView.articleSearchQuery));
        }
        if (examView.selectedJournalId && examView.selectedJournalId !== "all") {
          params.push("journal_id=" + encodeURIComponent(examView.selectedJournalId));
        }
        if (examView.selectedTopicCategory && examView.selectedTopicCategory !== "all") {
          params.push("category=" + encodeURIComponent(examView.selectedTopicCategory));
        }

        var url = API + "/articles" + (params.length ? "?" + params.join("&") : "");
        var res = await window.api(url);
        if (res && res.ok && res.items) {
          examView.articlesList = res.items;
        }
      }
    } catch (_) {
      // 离线容灾
    } finally {
      examView.loading = false;
      if (window.enVocabRerender) window.enVocabRerender();
    }
  }

  /* 把「抓取 / 生成」拿到的篇章装进精读视图。它与母源库篇章共用同一套渲染，
     所以换一篇就要把上一轮的作答、段落折叠、视图模式一并清掉，
     否则新篇章会继承旧篇章的展开状态，看起来像串了页。 */
  function adoptReading(payload, notice) {
    examView.activeReading = payload;
    examView.selectedAnswer = "";
    examView.readingViewMode = "original";
    examView.collapsedParagraphs = {};
    examView.notice = notice;
    examView.error = "";
    // 联网泳道 / URL 抓取 / 命题合成都走这里，一律同样切入阅读页，
    // 否则「从列表点」与「从联网车道点」的体验会不一致。
    examView.readerOpen = true;
    // 换篇就要把上一篇的笔记与侧边分析清掉，否则会把旧篇的高亮贴到新篇上
    examView.highlights = [];
    examView.side = null;
    examView.sel = null;
    examView.selResult = null;
    examView.hlEditingId = "";
    loadHighlights();
  }

  async function loadArticleDetail(articleId, opts) {
    opts = opts || {};
    examView.selectedArticleId = articleId;
    examView.selectedAnswer = "";
    examView.readingViewMode = "original"; // 默认状态下没有分析，只保留英文原文
    examView.loading = true;
    examView.error = "";
    examView.highlights = [];
    examView.side = null;
    examView.sel = null;
    examView.selResult = null;
    examView.hlEditingId = "";
    if (window.enVocabRerender) window.enVocabRerender();

    try {
      if (window.api) {
        var res = await window.api(API + "/article/" + encodeURIComponent(articleId));
        if (res && res.ok && res.article) {
          examView.activeReading = res.article;
          // 用户点文章的意图就是「读它」→ 整页切入阅读页。
          // 但模块初始化时的预载不是用户意图，那边会显式传 openReader:false。
          examView.readerOpen = opts.openReader !== false;
          examView.notice = "已载入《" + res.article.title + "》整篇通读与逐段解析！";
          loadHighlights();
        }
      }
    } catch (err) {
      examView.error = "篇章载入失败：" + (err.message || String(err));
    } finally {
      examView.loading = false;
      if (window.enVocabRerender) window.enVocabRerender();
      // 阅读页是从顶部开始读的，把它自己的滚动容器归零即可，不用再滚动外层列表
      if (examView.readerOpen) scrollReaderTop();
    }
  }

  async function initSystem() {
    readSizeLoad();
    try {
      if (window.api) {
        // 1. 获取期刊全谱系
        var jRes = await window.api(API + "/journals");
        if (jRes && jRes.ok && jRes.journals) {
          examView.journalsCatalog = jRes.journals;
        }

        // 2. 获取文章初始列表
        await fetchArticlesList();

        // 3. 初始载入第一篇完整详情。
        //    注意 openReader:false —— 这里是模块打开时的**预载**，不是用户点击。
        //    预载也跳进阅读页的话，用户一进「考研精读」就被直接塞进一篇文章里，
        //    连书架长什么样都没看到。阅读页只在用户真的点了文章时才打开。
        if (examView.articlesList && examView.articlesList.length) {
          var firstId = examView.articlesList[0].id;
          await loadArticleDetail(firstId, { openReader: false });
        }

        // 4. 联网泳道：可达源目录 + 首屏检索（默认泳道）
        if (examView.onlineMode) {
          await fetchOnlineSources();
          fetchOnlineSearch();
        }
      }
    } catch (_) {
      // 离线容灾
    }
  }

  /* ------------------------------------------------ 联网泳道异步数据 */

  // 后端 en_error 返回的已是中文提示，直接展示即可；只有纯英文/网络层错误才补前缀，
  // 否则会出现「联网检索失败：联网检索失败：...」这种重复前缀。
  function friendlyErr(err, fallbackPrefix) {
    var msg = (err && err.message) || String(err || "");
    if (/[\u4e00-\u9fa5]/.test(msg)) return msg;
    return fallbackPrefix + msg;
  }

  async function fetchOnlineSources() {
    try {
      if (!window.api) return;
      var res = await window.api(API + "/online-sources");
      if (res && res.ok && res.sources) {
        examView.onlineSources = res.sources;
      }
    } catch (_) {
      // 源目录拉取失败不阻断
    } finally {
      if (window.enVocabRerender) window.enVocabRerender();
    }
  }

  async function fetchOnlineSearch() {
    examView.onlineLoading = true;
    if (window.enVocabRerender) window.enVocabRerender();
    try {
      if (window.api) {
        var params = ["limit=48"];
        if (examView.onlineQuery) {
          params.push("query=" + encodeURIComponent(examView.onlineQuery));
        }
        if (examView.onlineSourceId && examView.onlineSourceId !== "all") {
          params.push("source_id=" + encodeURIComponent(examView.onlineSourceId));
        }
        if (examView.onlineTopic && examView.onlineTopic !== "all") {
          params.push("topic=" + encodeURIComponent(examView.onlineTopic));
        }
        var res = await window.api(API + "/online-search?" + params.join("&"));
        if (res && res.ok && res.items) {
          examView.onlineList = res.items;
          examView.onlineStats = {
            sources_ok: res.sources_ok,
            sources_total: res.sources_total,
            notice: res.notice || "",
          };
        }
      }
    } catch (err) {
      examView.error = friendlyErr(err, "联网检索失败：");
    } finally {
      examView.onlineLoading = false;
      if (window.enVocabRerender) window.enVocabRerender();
    }
  }

  /* 抓取失败时的降级卡片数据：从当前列表里把这篇的元信息捞出来，
     让用户至少看得到标题、摘要，并能一键跳原文——而不是一页空白。 */
  function degradeOnlineArticle(articleId, url, message) {
    var meta = null;
    (examView.onlineList || []).some(function (x) {
      if (x.id === articleId || (url && x.url === url)) {
        meta = x;
        return true;
      }
      return false;
    });
    examView.onlineArticle = {
      ok: false,
      title: (meta && meta.title) || "外刊文章",
      url: url || (meta && meta.url) || "",
      snippet: (meta && meta.snippet) || "",
      source_name: (meta && meta.source_name) || "",
      error: message || "这篇正文抓取失败。",
    };
    examView.notice = "";
  }

  async function loadOnlineArticle(articleId, url) {
    if (!articleId && !url) return;
    examView.loading = true;
    examView.onlineLoading = true;
    examView.error = "";
    // 联网车道与本地书架走同一套阅读页：点哪一篇都是整页切入，体验必须一致
    examView.readerOpen = true;
    examView.highlights = [];
    examView.side = null;
    examView.sel = null;
    examView.selResult = null;
    examView.hlEditingId = "";
    if (window.enVocabRerender) window.enVocabRerender();
    try {
      if (window.api) {
        var res = await window.api(API + "/online-fetch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ article_id: articleId || "", url: url || "" }),
        });
        if (res && res.ok && res.passage) {
          examView.onlineArticle = res;
          examView.notice = "已联网抓取《" + res.title + "》全文，可直接开始精读。";
          loadHighlights();
        } else {
          degradeOnlineArticle(articleId, url, (res && res.error) || "这篇正文抓取失败，换一篇试试。");
        }
      }
    } catch (err) {
      var msg = friendlyErr(err, "全文抓取失败：");
      examView.error = msg;
      // 阅读页已经打开了，不能留一页空白：降级成「失败卡片」，给出原文链接逃生口
      degradeOnlineArticle(articleId, url, msg);
    } finally {
      examView.loading = false;
      examView.onlineLoading = false;
      if (window.enVocabRerender) window.enVocabRerender();
      scrollReaderTop();
    }
  }

  setTimeout(initSystem, 100);

  // 绑定全局点击事件委托
  document.addEventListener("click", function (evt) {
    var subTabBtn = evt.target.closest("[data-en-exam-subtab]");
    if (subTabBtn) {
      var st = subTabBtn.dataset.enExamSubtab;
      if (st && examView.subTab !== st) {
        examView.subTab = st;
        examView.error = "";
        examView.notice = "";
        if (st === "radar" && !examView.radarResults) {
          handleAction("do-radar-search", subTabBtn);
        } else if (st === "writing" && !examView.writingKit) {
          handleAction("wk-load-kit", subTabBtn);
        } else if (st === "translation" && !examView.translationKit) {
          handleAction("tl-load-kit", subTabBtn);
        } else if (window.enVocabRerender) {
          window.enVocabRerender();
        }
      }
      return;
    }

    var actBtn = evt.target.closest("[data-en-exam-action]");
    if (actBtn) {
      var act = actBtn.dataset.enExamAction;
      handleAction(act, actBtn);
    }
  });

  /* 划词：mouseup 之后再取选区。用 setTimeout 0 是因为拖选刚结束时
     浏览器可能还没把 selection 定下来，立刻读会拿到空串。 */
  document.addEventListener("mouseup", function (evt) {
    if (!evt.target || !evt.target.closest) return;
    var surface = evt.target.closest(".en-read-surface, .en-online-passage");
    if (!surface) return;
    if (evt.target.closest(".en-sel-bar")) return;
    setTimeout(function () {
      captureSelection(surface);
    }, 0);
  });

  /* 点空白处收起浮出条。落在浮出条、高亮块、侧边抽屉里的点击不算「点空白」，
     否则点高亮块想开笔记时会先被自己关掉。 */
  document.addEventListener("mousedown", function (evt) {
    if (!examView.sel) return;
    if (!evt.target || !evt.target.closest) return;
    if (evt.target.closest(".en-sel-bar") || evt.target.closest("mark.en-hl") || evt.target.closest("mark.en-sel-mark") || evt.target.closest(".en-side-drawer")) {
      return;
    }
    examView.sel = null;
    examView.selResult = null;
    if (window.enVocabRerender) window.enVocabRerender();
  });

  document.addEventListener("keydown", function (evt) {
    if (evt.key !== "Escape") return;
    if (examView.sel) {
      closeSelection();
      return;
    }
    if (examView.sideOpen) {
      examView.sideOpen = false;
      examView.hlEditingId = "";
      if (window.enVocabRerender) window.enVocabRerender();
    }
  });

  // 实时搜索防抖输入监听
  var searchTimer = null;
  var onlineSearchTimer = null;
  document.addEventListener("input", function (evt) {
    if (evt.target && evt.target.id === "en-article-search-input") {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        var kw = evt.target.value.trim();
        examView.articleSearchQuery = kw;
        fetchArticlesList();
      }, 250);
    }
    if (evt.target && evt.target.id === "en-online-search-input") {
      clearTimeout(onlineSearchTimer);
      onlineSearchTimer = setTimeout(function () {
        examView.onlineQuery = evt.target.value.trim();
        fetchOnlineSearch();
      }, 400);
    }
    /* 批注与改写框只暂存草稿、不触发重渲染：每敲一个字就重画一次会让输入框失焦 */
    if (evt.target && evt.target.id === "en-hl-note-input") {
      examView.hlDraft = evt.target.value;
    }
    if (evt.target && evt.target.id === "en-rewrite-sentence") {
      examView.rewriteSentence = evt.target.value;
    }
    /* 作文 / 译文 / 原文三块也只暂存草稿：重渲染会把 textarea 换掉，正在敲字会失焦 */
    if (evt.target && evt.target.id === "en-writing-draft") {
      examView.writingDraft = evt.target.value;
    }
    if (evt.target && evt.target.id === "en-writing-topic") {
      examView.writingTopic = evt.target.value;
    }
    if (evt.target && evt.target.id === "en-tl-source") {
      examView.translationSource = evt.target.value;
    }
    if (evt.target && evt.target.id === "en-tl-target") {
      examView.translationTarget = evt.target.value;
    }
    /* 文化词表搜索要即时过滤，只能重渲染；重渲染后把光标放回原位，否则打一个字就断 */
    if (evt.target && evt.target.id === "en-culture-search") {
      var cultureVal = evt.target.value;
      var caret = evt.target.selectionStart;
      examView.cultureQueryDraft = cultureVal;
      examView.cultureQuery = cultureVal.trim();
      if (window.enVocabRerender) window.enVocabRerender();
      var cultureNext = document.getElementById("en-culture-search");
      if (cultureNext) {
        cultureNext.focus();
        if (typeof caret === "number") {
          try {
            cultureNext.setSelectionRange(caret, caret);
          } catch (_) {
            // 非文本输入类型不支持选区，忽略即可
          }
        }
      }
    }
  });

  // 挂载到全局
  window.KnowOriginExam = {
    render: render,
    handleAction: handleAction,
    view: examView,
    DEFAULT_JOURNALS: DEFAULT_JOURNALS,
  };
})();
