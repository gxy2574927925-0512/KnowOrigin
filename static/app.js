const APP_BUILD = "20261007-kb-note-panel-click";
window.APP_BUILD = APP_BUILD;
try { console.info("[KnowOrigin-Build]", APP_BUILD, "高亮修复版，请在控制台确认此版本号已加载"); } catch (e) {}
(function () {
  // 一次性提示当前运行的是修复版，方便用户/开发者确认已加载新代码（不发请求、不刷新页面）。
  const BUILD_TAG = "hg-20260908-highlight-guard-1";
  try {
    if (location.protocol !== "file:" && sessionStorage.getItem("knoworigin-hl-toast") !== BUILD_TAG) {
      sessionStorage.setItem("knoworigin-hl-toast", BUILD_TAG);
      setTimeout(() => {
        try { showToast(`已载入修复版 ${APP_BUILD}：高亮退出与保存已修复`, "ok"); } catch (e) {}
      }, 900);
    }
  } catch (e) {}
})();
const state = {
  authenticated: false,
  user: null,
  authMode: "login",
  currentProjectId: "",
  projects: [],
  projectsSyncInFlight: false,   // 主界面静默同步项目列表进行中（去重）
  sources: [],
  nodes: [],
  llmSuggested: [],
  llmSuggestedLoading: false,
  llmSuggestedProject: "",
  pendingFiles: [],
  selectedSourceIds: new Set(),
  sourceDeleteSelectionIds: new Set(),
  deletingSources: false,
  problemImage: null,
  problemImageUrl: "",
  sending: false,
  feature: "framework",
  cards: [],
  quiz: null,
  quizHistory: null,          // null = 未加载；数组 = 已加载的历史列表
  quizHistoryExpanded: false, // 历史记录面板是否展开
  viewingHistoryQuiz: null,   // 当前正在查看的历史测验对象（非 null 时进入历史查看模式）
  generatingCards: false,
  generatingQuiz: false,
  selectedCardIds: new Set(),
  selectedQuizQuestionIds: new Set(),
  deletingStudyItems: false,
  studyDifficulty: "auto",
  quizQuestionTypes: [],
  favorites: [],
  textHighlights: {},
  shownSourceMessageIds: new Set(),
  activeHighlight: null,
  overviewFilter: "priority",
  overviewSelectedNodeId: null, // 单个节点维度：当前选中的知识节点 id（掌握度来源分析视角）
  overviewAiPlan: null, // AI 优先复习建议：progress 端点返回的 steps 数组；非空时「优先复习」队列改用它
  overviewAiBusy: false, // AI 建议生成中（防止重复触发）
  overviewKits: {}, // 已保存的学习路径/清单报告（kind → kit），概览按钮据此显示「查看」还是「生成」
  overviewKitsProject: null, // 上面那份 kits 属于哪个项目（切项目要重新拉）
  overviewSuggestProject: null, // 已尝试恢复 AI 建议的项目（避免重复 GET）
  editingFavoriteId: "",
  favoriteQuery: "",
  undoAction: null,
  undoTimer: 0,
  globalUndoInFlight: false,
  retryAction: null,
  projectPendingDeleteId: "",
  sourceDragDepth: 0,
  sourceImportRequestId: 0,
  sourceImportProgress: null,
  sourceImportProgressTimer: 0,
  sourceImportProgressClearTimer: 0,
  studioFocus: false,
  studioFocusClosing: false,
  studioFocusOrigin: null,
  studioPreviousFocus: null,
  panelLayout: null,
  apiConfig: null,
  mathJaxTypesetQueued: false,
  studyRenameTarget: null,
  // 掌握度透明化：rules 为后端权威配置；breakdown 为按节点的来源贡献/正确率明细
  masteryRules: null,
  masteryBreakdown: null,
  // 自测状态持久化：提交中/完成后结果都存 state，界面重渲染也能恢复
  cardSelfRateState: {},   // { cardId: { loading:bool, selected:number|null, note:string|null, ok:bool, error:string|null } }
  // 卡片「查看答案」翻面状态：切 tab 再回来后仍保持翻面
  openCardIds: new Set(),
  // 答案展开状态：翻面后默认只露一个「展开答案」，点开才看正文（切 tab 回来仍保持）
  cardAnswerOpenIds: new Set(),
  // 沉浸式卡片浏览（放大单独页面）：open=false 未打开；index>=0 为正在浏览的卡片索引
  cardViewerOpen: false,
  cardViewerIndex: -1,
  // 小测验未提交的作答草稿：{ [questionIndex]: string | string[] }，切 tab 再回来后恢复
  quizDraftAnswers: {},
  // 主界面问答会话（Agent 布局：每个项目多条会话）。chatSessionId="" 表示项目默认单线程。
  // 这两个字段与 A 线的 agent 开关有交集：agent 模式下 sendMessage 会把 chatSessionId
  // 一起发给 /chat/stream，由后端决定是"新建会话"还是"复用当前会话"。
  chatSessionId: "",
  chatSessions: [],
  // A 线：主界面对话区是否走 Function Calling 工具链（默认开，关掉即退回纯 RAG 问答）
  chatAgent: readChatAgentPref(),
  // ---- 个人知识库（Obsidian 式）----
  kbNodeId: "",
  kbMode: "edit",
  kbDirty: false,
  kbSaveTimer: 0,
  kbQuery: "",
  kbActiveTag: "",
  kbTags: [],
  kbAgentMessages: [],
  kbAgentBusy: false,
  kbConvergeHasChange: false,   // 本轮收敛点是否有可固化改动（仅作记录，收敛条始终显示 apply/redo/stop）
  kbConversationId: null,   // 当前整理助手会话（null=新建）
  kbSessionList: [],        // 历史会话列表（按当前聚焦节点过滤）
  kbConvByNode: {},         // 每个节点记住的最近会话：{ nodeId(node_id 或 ""=全局): conversation_id }
  kbProposals: [],          // 待批准建议稿
  kbDigest: null,           // 库级摘要（记忆徽标数据源）
  kbAgentMode: "default",   // 整理助手模式："default" | "guide"（引导）
  kbNoteGuideIndex: [],     // 当前节点笔记解析出的索引项 [{id, tag, label, text, full}]，点击→放大+引导
  kbConvergeTask: "guide",  // 当前收敛任务类型："guide"引导复习 | "graph"建链/图谱 | "note"补全笔记 | "review"补漏复习
  kbConvergeApplied: false, // 当前任务是否已执行过 apply：防循环，执行后 apply 置灰，redo/stop/新任务再激活
  kbConvergeActive: false,  // 收敛条是否可见：首次进入节点时隐藏，用户发起任务/引导后才显示
  kbConvergeByNode: {},     // 收敛条状态按节点独立：{ nodeId: { active, task, applied } }，切节点不串扰
  kbLinkProposed: false,    // graph 任务：已推荐双链但尚未真正建链（等待用户确认执行）
  kbFocusNodeId: "",        // 引导/整理聚焦的框架节点 id（框架即入口）
  kbCardBusy: false,
  kbQuizBusy: false,
  kbNodeCards: [],   // 当前节点已生成的卡片（切换界面/重进节点后恢复）
  kbNodeQuiz: null,  // 当前节点最近一份小测验（切换界面/重进节点后恢复）
  kbDockPos: null,   // { left, top }：整理助手/笔记悬浮面板拖动后的位置（跨重渲染持久化）
  kbQuizReturn: null, // 从节点面板「去「小测验」作答」跳转而来时的返回上下文：{ nodeId }，测验页据此显示「返回」按钮
  kbModeByNode: {},    // 笔记编辑/预览模式按节点记忆：{ nodeId: "edit" | "preview" }，切节点回来还是上次的读法
  kbDiscussedNodes: {}, // 闭环 stepper 的「讨论」步：本会话已对该节点发起过讨论（后端不留讨论痕迹）
  // 双链「理解」：一对双链共享一条关系说明，键为 kbLinkPairKey(a,b)（node_id 字典序归一）
  kbLinkNotes: {},
};

const PANEL_LAYOUT_STORAGE_KEY = "knoworigin-panel-layout-v1";
const KB_DOCK_POS_STORAGE_KEY = "knoworigin-kb-dock-pos-v1";

// 选中整理预览/对话文字后的临时状态：{ text, source:{ mode:"preview"|"conversation", nodeName } }
let _kbSelInfo = null;
// 待应用高亮的选区快照：点击色块的 mousedown 可能塌陷文档选区并清空 state.activeHighlight，
// 用它兜底保存上一次有效选区，保证色块 click 时仍能取到要高亮的原文。
let _pendingTextHighlight = null;
const PANEL_LIMITS = Object.freeze({ left: 220, center: 420, right: 280 });
const TEXT_HIGHLIGHT_STORAGE_PREFIX = "knoworigin-text-highlights-v1:";
const SHOWN_SOURCE_STORAGE_PREFIX = "knoworigin-shown-source-messages-v1:";
const TEXT_HIGHLIGHT_COLORS = Object.freeze(["yellow", "green", "red", "blue", "purple"]);
const FAVORITE_HIGHLIGHT_COLORS = Object.freeze(["yellow", "green", "red", "blue", "purple", "none"]);
const MATH_DEBUG_STORAGE_KEY = "knoworigin:math-debug";
const SOURCE_IMPORT_PROGRESS_INTERVAL_MS = 800;
const SOURCE_IMPORT_STAGE_LABELS = Object.freeze(["上传", "解析", "准备", "OCR", "保存"]);
const SOURCE_IMPORT_STAGE_COUNT = SOURCE_IMPORT_STAGE_LABELS.length;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

// —— 主题（浅色 / 深色）：全局唯一来源，课程与文献两种模式共用 ——
const UI_STORAGE_KEY = "knoworigin-ui";
const UI_MODES = ["academic", "classic", "agent"];
function normalizeUi(mode) {
  return UI_MODES.includes(mode) ? mode : "agent";
}
function currentUi() {
  try { return normalizeUi(localStorage.getItem(UI_STORAGE_KEY)); } catch { return "agent"; }
}
function syncUiSegments(mode) {
  $$(".settings-segmented-btn[data-ui-value]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.uiValue === mode));
  });
}
function applyUi(mode) {
  const next = normalizeUi(mode);
  const prev = document.documentElement.dataset.ui;
  document.documentElement.dataset.ui = next;
  syncUiSegments(next);
  document.dispatchEvent(new CustomEvent("knoworigin:ui-changed", { detail: { ui: next } }));
  // 学习产出里有一批「算一次就烤进 DOM」的值：SVG 的渐变 defs、节点填充色、图例色点。
  // 它们在渲染那一刻用 usesCoolPalette() 取色，之后无论 CSS 令牌怎么换都刷不到它们。
  // 于是蓝灰界面里会留着一套暖白画布 + 紫晕 + 橙绿红图例（反过来也一样）——
  // 这是纯 CSS 覆盖不到的，必须按当前布局重渲染一次产出视图。
  // prev 为空是首次应用（模块顶层就调了 applyUi），那时还没渲染任何东西，别重渲染。
  if (prev && prev !== next && typeof renderStudio === "function") {
    try { renderStudio(); } catch (error) { console.warn("[ui] 切换布局后重渲染学习产出失败", error); }
  }
}
function setUi(mode) {
  const next = normalizeUi(mode);
  try { localStorage.setItem(UI_STORAGE_KEY, next); } catch {}
  applyUi(next);
}
window.KnowOriginUI = { current: currentUi, apply: applyUi, set: setUi };

// 学术极简与 Agent 工作台共用蓝灰状态色（学术极简的 CSS 也只认这两个 data-ui）。
// 注意：图谱节点填充色在 JS 里（nodePalette），CSS 换不掉，必须靠这个分支。
function usesCoolPalette() {
  const ui = document.documentElement.getAttribute("data-ui");
  return ui === "academic" || ui === "agent";
}
const THEME_STORAGE_KEY = "knoworigin-theme";
function currentTheme() {
  try { return localStorage.getItem(THEME_STORAGE_KEY) || "light"; } catch { return "light"; }
}
function syncThemeSegments(theme) {
  $$(".settings-segmented-btn[data-theme-value]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.themeValue === theme));
  });
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  syncThemeSegments(theme);
}
function setTheme(theme) {
  try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch {}
  applyTheme(theme);
}
function toggleTheme() {
  setTheme(currentTheme() === "dark" ? "light" : "dark");
}
window.KnowOriginTheme = { current: currentTheme, apply: applyTheme, set: setTheme, toggle: toggleTheme };

// —— 品牌主题（通用 / 天大）：叠加在 浅/深 之上，全局唯一来源 ——
const BRAND_STORAGE_KEY = "knoworigin-brand";
// 校徽：真实北洋蓝校徽图片（静态资源），天大主题下替换“题”字标识
const TJU_EMBLEM_SVG = `<img class="tju-emblem-img" src="/static/img/knoworigin-emblem.png" alt="天津大学校徽" role="img" aria-label="天津大学主题" />`;
// 通用主题使用产品正式的“源头涟漪”图标，不再用“题”字占位。
const KNOWORIGIN_EMBLEM_SVG = `<img class="ko-brand-img" src="/static/icon.svg" alt="" aria-hidden="true" />`;
function currentBrand() {
  try { return localStorage.getItem(BRAND_STORAGE_KEY) || "default"; } catch { return "default"; }
}
function syncBrandSegments(brand) {
  $$(".settings-segmented-btn[data-brand-value]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.brandValue === brand));
  });
}
function applyBrand(brand) {
  document.documentElement.dataset.brand = brand;
  $$(".course-brand-mark, .lit-brand-mark").forEach((el) => {
    if (el.dataset._brand === brand) return;
    el.dataset._brand = brand;
    if (brand === "tju") {
      if (el.dataset._brandOrig == null) el.dataset._brandOrig = el.textContent;
      el.innerHTML = TJU_EMBLEM_SVG;
      el.classList.add("tju-emblem");
      el.classList.remove("ko-emblem");
    } else {
      el.innerHTML = KNOWORIGIN_EMBLEM_SVG;
      el.classList.remove("tju-emblem");
      el.classList.add("ko-emblem");
    }
  });
  // 对话区头像也跟随品牌切换，避免左上角与主聊天框各用一套旧占位图标。
  $$(".assistant-message .avatar").forEach((el) => {
    if (el.classList.contains("hxt-pet-avatar")) return;
    el.classList.add("assistant-brand-avatar");
    el.innerHTML = brand === "tju"
      ? `<img class="assistant-brand-img" src="/static/img/knoworigin-emblem.png" alt="天津大学主题" />`
      : `<img class="assistant-brand-img" src="/static/icon.svg" alt="知源助手" />`;
  });
  syncBrandSegments(brand);
  // 切换品牌时重绘知识框架，让双链图谱的天大海棠主题即时生效
  if (state.nodes && state.nodes.length && state.feature === "framework") renderFramework();
}
function setBrand(brand) {
  try { localStorage.setItem(BRAND_STORAGE_KEY, brand); } catch {}
  applyBrand(brand);
}
window.KnowOriginBrand = { current: currentBrand, apply: applyBrand, set: setBrand };

// —— 卡片辉光开关 ——
// 沉浸层（styles-immersive.css）给卡片 / 知识点卡加了悬停辉光与釉面扫光。
// 长时间刷卡片时发光会累眼，所以默认关：只有 html[data-glow="on"] 才会挂上那些规则。
// 落点是一个 data 属性而不是加/撤 class：CSS 侧只认这一个开关，不会和别的主题分支打架。
const GLOW_STORAGE_KEY = "knoworigin-card-glow";
function currentGlow() {
  try { return localStorage.getItem(GLOW_STORAGE_KEY) || "off"; } catch { return "off"; }
}
function syncGlowSegments(glow) {
  $$(".settings-segmented-btn[data-glow-value]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.glowValue === glow));
  });
}
function applyGlow(glow) {
  document.documentElement.dataset.glow = glow === "on" ? "on" : "off";
  syncGlowSegments(currentGlow());
}
function setGlow(glow) {
  try { localStorage.setItem(GLOW_STORAGE_KEY, glow === "on" ? "on" : "off"); } catch {}
  applyGlow(glow);
}
window.KnowOriginCardGlow = { current: currentGlow, apply: applyGlow, set: setGlow };

// —— 全局字体缩放：设置 :root 的 --font-scale，全库 px 字号（styles.css 与各 UI 的 font-size）
//    都写成 calc(Npx * var(--font-scale, 1))，调档只放大文字、布局尺寸与边框完全不动。
//    不用 <html> 的 zoom：非整数缩放的亚像素取整会让严丝合缝的面板布局漂移（实测 XMind 按钮换行）。 ——
const FONT_ZOOM_STORAGE_KEY = "knoworigin-font-zoom";
const FONT_ZOOM_STEPS = ["1", "1.15", "1.3", "1.45"];
function currentFontZoom() {
  try {
    const v = localStorage.getItem(FONT_ZOOM_STORAGE_KEY);
    return FONT_ZOOM_STEPS.includes(v) ? v : "1";
  } catch { return "1"; }
}
function syncFontZoomSegments(zoom) {
  $$(".settings-segmented-btn[data-font-zoom-value]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.fontZoomValue === zoom));
  });
}
function applyFontZoom(zoom) {
  const next = FONT_ZOOM_STEPS.includes(zoom) ? zoom : "1";
  document.documentElement.style.setProperty("--font-scale", next);
  // 清掉旧方案的 inline zoom 残留（zoom 不持久，这里只是防御）
  document.documentElement.style.removeProperty("zoom");
  syncFontZoomSegments(next);
}
function setFontZoom(zoom) {
  try { localStorage.setItem(FONT_ZOOM_STORAGE_KEY, zoom); } catch {}
  applyFontZoom(zoom);
}
window.KnowOriginFontZoom = { current: currentFontZoom, apply: applyFontZoom, set: setFontZoom };

// —— 声效（Web Audio 合成，无外部资源） ——
const SOUND_STORAGE_KEY = "knoworigin-sound";
let _soundCtx = null;
let _lastHoverTarget = null;
// —— 「一次动作最多一声」的跨模块共享闸门 ——
// 主应用与桌宠各自持有独立的 AudioContext，但同一次点击常常同时命中两边的发声点
// （桌宠给它的按钮配了专属音效，而全站点击音是挂在 document 上的）—— 听感就是
// "点一下响好几声"。这里用一个近同刻闸门统一收口：默认 60ms 内只放行第一声。
// 桌宠按钮自己的音效在目标阶段先响，全站点击音在冒泡阶段后到，自然被挡下；
// 桌宠那些间隔 70~160ms 的双音提示音不受影响。
const SOUND_COALESCE_MS = 60;
let _soundGateAt = 0;
function soundGateOpen() {
  const now = Date.now();
  if (now - _soundGateAt < SOUND_COALESCE_MS) return false;
  _soundGateAt = now;
  return true;
}
window.KnowOriginSoundGate = soundGateOpen; // hxt-pet.js 复用同一个闸门
function soundPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(SOUND_STORAGE_KEY) || "{}");
    return { enabled: raw.enabled !== false };
  } catch {
    return { enabled: true };
  }
}
function saveSoundPrefs(prefs) {
  try { localStorage.setItem(SOUND_STORAGE_KEY, JSON.stringify(prefs)); } catch {}
}
function getSoundCtx() {
  if (!_soundCtx) {
    try { _soundCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { _soundCtx = null; }
  }
  return _soundCtx;
}
function playTone(freqFrom, freqTo, duration, volume) {
  const ctx = getSoundCtx();
  if (!ctx) return;
  try {
    if (ctx.state === "suspended") ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    osc.type = "sine";
    osc.frequency.setValueAtTime(freqFrom, now);
    if (freqTo && freqTo !== freqFrom) osc.frequency.exponentialRampToValueAtTime(freqTo, now + duration);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(volume || 0.06, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  } catch {}
}
function playClickSound() {
  const prefs = soundPrefs();
  if (!prefs.enabled) return;
  if (!soundGateOpen()) return;
  playTone(800, 400, 0.06, 0.05);
}
function playHoverSound() {
  const prefs = soundPrefs();
  if (!prefs.enabled) return;
  if (!soundGateOpen()) return;
  playTone(1600, 2200, 0.04, 0.025);
}
window.KnowOriginSound = {
  prefs: soundPrefs,
  save: saveSoundPrefs,
  click: playClickSound,
  hover: playHoverSound,
};

// 首次进入即应用已保存主题与品牌，避免页面闪烁
applyUi(currentUi());
applyTheme(currentTheme());
applyBrand(currentBrand());
applyFontZoom(currentFontZoom());
applyGlow(currentGlow());

// defer 脚本通常会等 DOMContentLoaded，但外部浏览器扩展、缓存脚本或某个
// 第三方资源可能让该事件迟迟不派发。初始化不能依赖单一事件，否则首屏只剩
// hidden 的空壳。readyState + 定时兜底都指向同一个幂等启动器。
let initStarted = false;
function startInit() {
  if (initStarted) return;
  initStarted = true;
  init();
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startInit, { once: true });
} else {
  queueMicrotask(startInit);
}
window.setTimeout(startInit, 1500);

async function init() {
  // ⚠️ 逐�� try/catch：以前这里是裸的串行调用，任何一步抛错就整个 init 中断，
  // 表现为「项目加载不出来 / 一直加载没有内容」——而且报错被 init 的 catch 吞掉，
  // 浏览器里看不到线索（曾排查过：prompt-lab.js / usage-ui.js 的请求发了，说明 app.js
  // 本身加载执行了，是 init() 一进去就抛；jsdom 里又跑得通，差异点在真实浏览器环境）。
  // 现在每步独立兜底并在报错条自报是哪一步 —— 这是当前最重要的排障杠杆。
  const step = async (label, fn) => {
    try {
      await fn();
    } catch (error) {
      console.error(`[KnowOrigin] 启动步骤失败：${label}`, error);
      showError(new Error(`启动步骤「${label}」失败：${error?.message || error}`));
    }
  };
  await step("绑定界面事件", () => bindEvents());
  await step("初始化面板宽度", () => initializePanelResizing());
  await step("初始化回答依据栏", () => initEvidencePanel());
  await step("初始化提问导轨", () => initQuestionRail());
  // 绑定设置项（含模型 API 与密钥）：把用户填过的密钥带进后台，防止切换表单模式时丢状态
  await step("同步密钥", () => syncStoredCredentials());
  // 检查后台在线与打卡阈值：决定界面禁用还是放行
  await step("检查服务健康", () => checkHealth());
  await step("加载会话与项目", () => loadSession());
  await step("渲染推荐问题", () => renderSuggestedQuestions());
  // 小桌宠也要通知当前视图与门槛状态：即使某一步失败，它也得知道用哪种形态出现
  await step("通知桌宠", () => {
    document.dispatchEvent(new CustomEvent("knoworigin:pet-view", { detail: { feature: state.feature, status: petViewStatus(state.feature) } }));
  });
  // 兜底：不管哪步失败/未跑到，页面也必须有一个可见视图（否则只剩一片空白）
  ensureSomeViewVisible();
}

// 顶层视图总表：登录壳 / 工作台 / 文章阅读 / 读书 / 报错条。
// ⚠️ 新增顶层视图必须一起登记（HTML 上打 data-top-view 即可），否则这个兜底会
// 把「#workspace 被该视图隐藏」误判成整页白屏，把登录卡塞到它顶上。
// 读书模式就是这么踩的：进「读书」后 #workspace 隐藏、可见的是 #reading-workspace，
// init() 收尾在这里强制露出登录壳 —— 表现就是「打开阅读模式出现登录界面」。
// index.html 的首屏兜底有一份同样口径的名单（JS 挂了也要能跑，不能共用）。
const TOP_LEVEL_VIEW_IDS = ["auth-shell", "workspace", "literature-workspace", "reading-workspace", "error-banner"];

function topLevelViews() {
  const nodes = TOP_LEVEL_VIEW_IDS
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  // data-top-view 是给新视图用的登记口：加了它就自动算数，不必回来改上面的名单。
  document.querySelectorAll("[data-top-view]").forEach((node) => {
    if (!nodes.includes(node)) nodes.push(node);
  });
  return nodes;
}

function isTopLevelViewVisible(node) {
  if (!node || node.hidden) return false;
  // 用计算样式判定：隐藏可能来自 .hidden(!important)、inline style 或别的类，
  // 只查 classList 会漏判。显示中的视图必须让兜底闭嘴。
  const style = window.getComputedStyle(node);
  return style.display !== "none" && style.visibility !== "hidden";
}

// 所有顶层视图（含登录壳 / 两个阅读模式 / 报错条）全 hidden 时，才露出登录壳。
// 否则用户看到的是纯白屏，连报错条都看不出来。
function ensureSomeViewVisible() {
  if (topLevelViews().some(isTopLevelViewVisible)) return;
  const fallback = document.querySelector("#auth-shell") || document.querySelector("#workspace");
  if (fallback) {
    fallback.classList.remove("hidden");
    fallback.hidden = false;
  }
}

// 未捕获的 promise 拒绝 / 资源加载失败也记一条：init 之外的静默失败同样难查。
window.addEventListener("unhandledrejection", (event) => {
  const message = event?.reason?.message || String(event?.reason || "");
  if (!message) return;
  console.error("[KnowOrigin] 未处理的异步错误", event.reason);
});
window.addEventListener("error", (event) => {
  if (event?.target?.src) console.warn("[KnowOrigin] 资源加载失败", event.target.src);
}, true);

function bindEvents() {
  $("#auth-form").addEventListener("submit", submitAuth);
  $("#auth-mode-toggle").addEventListener("click", toggleAuthMode);
  $("#new-project-button").addEventListener("click", () => $("#project-dialog").showModal());
  $("#api-config-form").addEventListener("submit", saveApiConfig);
  bindSecretToggles();
  setupSettings();
  setupFeatureNav();
  document.addEventListener("click", handleSettingsSoundClick);
  document.addEventListener("mouseover", handleHoverSound, { passive: true });
  $$(".close-dialog").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  bindLinkNoteDialog();
  $("#project-form").addEventListener("submit", createProject);
  $("#project-menu-button").addEventListener("click", toggleProjectMenu);
  $("#project-menu-button").addEventListener("keydown", handleProjectMenuButtonKeydown);
  $("#project-list").addEventListener("click", handleProjectListClick);
  $("#project-list").addEventListener("contextmenu", handleProjectListContext);
  $("#project-list").addEventListener("keydown", handleProjectMenuKeydown);
  $("#delete-project-form").addEventListener("submit", deleteProject);
  $("#delete-project-dialog").addEventListener("close", resetProjectDeleteDialog);
  $("#study-rename-form").addEventListener("submit", saveStudyItemRename);
  $("#study-rename-dialog").addEventListener("close", resetStudyItemRename);
  $$("[data-dialog-cancel]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  $("#file-input").addEventListener("change", selectFiles);
  $("#source-list").addEventListener("click", handleSourceListClick);
  $("#source-list").addEventListener("change", handleSourceListChange);
  $("#source-list").addEventListener("keydown", handleSourceListKeydown);
  bindSourceDropTarget();
  $("#paste-button").addEventListener("click", () => requireProject(() => $("#paste-dialog").showModal()));
  $("#paste-form").addEventListener("submit", uploadPastedText);
  $("#build-framework-button").addEventListener("click", () => requireProject(buildFramework));
  setupTjuImportDialog();
  $("#voice-input-button")?.addEventListener("click", startVoiceInput);
  $("#chat-agent-toggle")?.addEventListener("click", toggleChatAgent);
  syncChatAgentToggle();
  $("#composer").addEventListener("submit", sendMessage);
  $("#message-input").addEventListener("paste", handlePasteImage);
  $("#message-input").addEventListener("keydown", handleMessageInputKeydown);
  $("#message-input").addEventListener("input", autoResizeMessageInput);
  $$(".feature-button").forEach((button) => button.addEventListener("click", () => {
    switchFeature(button.dataset.feature);
    if (["cards", "quiz", "favorites"].includes(button.dataset.feature)) expandStudio(button);
  }));
  $("#studio-expand-button").addEventListener("click", toggleStudioFocus);
  $("#studio-output").addEventListener("click", handleStudioOutputClick);
  $("#studio-output").addEventListener("submit", handleStudioOutputSubmit);
  $("#studio-output").addEventListener("change", handleStudioOutputChange);
  $("#studio-output").addEventListener("keydown", handleStudioOutputKeydown);
  // 图谱「拖动 vs 点击」判定：只在按下点落在图谱里时记一笔。
  // capture 阶段装，先于画布自己的 pointerdown 处理器 —— 顺序反了会读到上一轮的值。
  document.addEventListener("pointerdown", kbGraphArmPanGuard, true);
  $("#conversation").addEventListener("click", handleConversationClick);
  $("#suggested-questions").addEventListener("click", handleSuggestedQuestionsClick);
  $("#suggested-restore")?.addEventListener("click", restoreSuggestedQuestions);
  $("#suggested-restore-inline")?.addEventListener("click", restoreSuggestedQuestions);
  $("#undo-button").addEventListener("click", performUndo);
  $("#dismiss-toast").addEventListener("click", hideUndoNotice);
  document.addEventListener("keydown", handleStudioFocusKeydown);
  document.addEventListener("keydown", handleGlobalUndoKeydown);
  document.addEventListener("keydown", handleKbDockEscapeKeydown);
  document.addEventListener("click", closeStudioFocusFromBackdrop);
  document.addEventListener("click", closeProjectMenuFromOutside);
  document.addEventListener("click", closeStudyMenusFromOutside);
  document.addEventListener("toggle", handleStudyMenuToggle, true);
  document.addEventListener("scroll", scheduleStudyMenuReposition, true);
  window.addEventListener("resize", scheduleStudyMenuReposition);
  document.addEventListener("keydown", handleCardViewerKeydown);
  document.addEventListener("click", handleCardViewerDocumentClick);
  document.addEventListener("click", handleDiffHelpDocumentClick);
  document.addEventListener("keydown", handleDiffHelpKeydown);
  document.addEventListener("selectionchange", handleTextSelectionChange);
  document.addEventListener("mouseup", handleTextSelectionChange);
  document.addEventListener("keyup", handleTextSelectionChange);
  document.addEventListener("click", handleTextHighlightDocumentClick);
  document.addEventListener("click", handleKbWikilinkClick);
  $("#dismiss-error").addEventListener("click", hideError);
  $("#retry-button").addEventListener("click", () => {
    const retry = state.retryAction;
    hideError();
    if (retry) retry();
  });
}

function handleSettingsSoundClick(event) {
  if (event.target.closest?.("button, [role='button']")) window.KnowOriginSound?.click();
}

// 派发桌宠交互反馈（海小棠气泡 + 表情动画 + 音效）；mood 见 hxt-pet.js 的 REACT_MOOD
function petReact(text, mood, opts) {
  document.dispatchEvent(new CustomEvent("knoworigin:pet-react", { detail: Object.assign({ text, mood }, opts || {}) }));
}

// 让 tju-llm 按海小棠固定人设生成一句反馈（不固定格式），失败则回退预设文案。
// 生成期间不给文字占位，而是让海小棠先做出对应表情动作（开心/沮丧/思考/鼓励…），避免干扰阅读。
function petReactAI(kind, context, mood, fallback, opts) {
  const o = Object.assign({}, opts || {});
  // 先出的只是"表情预告"（气泡随后就到），所以标 silent 不出声：
  // 否则同一次动作会前一声、后一声，听感就是"响了两遍"。
  if (mood) document.dispatchEvent(new CustomEvent("knoworigin:pet-react", { detail: { text: "", noBubble: true, silent: true, mood } }));
  let apply = (text) => {
    if (typeof text === "string" && text.trim()) petReact(text.trim(), mood, Object.assign({}, o, { stayMs: o.stayMs || 7000 }));
    else if (fallback) petReact(fallback, mood, Object.assign({}, o));
  };
  try {
    fetch("/api/hxt/react", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, context: context || {} }),
      signal: AbortSignal.timeout(7000),
    })
      .then((r) => r.json())
      .then((d) => apply(d && d.text))
      .catch(() => apply(""));
  } catch (_) { apply(""); }
}

// —— 掌握度实时播报：学习动作（卡片自评 / 测验交卷 / 对话测验）前记录基线，
// 刷新后由海小棠汇报具体哪些节点的掌握度涨了多少 ——
let _masteryGainBaseline = null;
function _setMasteryBaseline() {
  const m = {};
  (state.nodes || []).forEach((n) => { m[n.node_id] = Math.round((Number(n.mastery_score) || 0) * 100); });
  _masteryGainBaseline = m;
}
// 对比当前与基线，返回涨幅明细文本；无涨幅返回 null。同时把基线推进到当前。
function _masteryGainText() {
  const base = _masteryGainBaseline;
  _setMasteryBaseline();
  if (!base) return null;
  const gains = [];
  (state.nodes || []).forEach((n) => {
    const before = base[n.node_id];
    const now = Math.round((Number(n.mastery_score) || 0) * 100);
    if (Number.isFinite(before) && now - before >= 1) gains.push(`${n.name || "某节点"} +${now - before}%`);
  });
  if (!gains.length) return null;
  const shown = gains.slice(0, 5).join("、");
  return gains.length > 5 ? `掌握度上涨：${shown} 等 ${gains.length} 个节点` : `掌握度上涨：${shown}`;
}

// 悬停知识卡片时的提示文案池（tju-llm 未配置或生成失败时回退用）
const PET_CARD_HINTS = [
  "翻面前先别看答案——先在脑子里过一遍，再翻面验证，记得最牢。",
  "想想这张卡片对应哪个知识点、和什么相关，带着问题翻面效果更好。",
  "不确定也别慌：翻面看完答案再自评，我会按你的真实情况给掌握度记上一笔。",
  "这一步在测你对知识点的把握，翻面前先试着把它的要点说出来。",
];
// 悬停提示节流：两次提示之间的最小间隔（原为 9s，太慢会像"没反应"）
const PET_CARD_HINT_GAP_MS = 2500;
// 单飞：字面生成较慢，指针移到下一张卡片时取消上一次未完成的请求，避免旧提示盖掉新提示
let _cardHintAbort = null;
let _lastCardHintAt = 0;

// 从卡片 DOM 里取出题面（优先用渲染数据，兜底读正面文本）
function cardHintQuestion(hintCard) {
  let question = "";
  const card = (state.cards || []).find((c) => c.card_id === hintCard.dataset.originId);
  if (card) question = String(card.front || "").replace(/<[^>]+>/g, " ").trim();
  if (!question) {
    const frontEl = hintCard.querySelector(".card-front-text");
    if (frontEl) question = (frontEl.textContent || "").trim();
  }
  return question.replace(/\s+/g, " ").trim();
}

// 悬停卡片提示：**先 0 延迟**弹出预设提示（立刻有反馈），再让 tju-llm 生成个性化提示就地替换。
// 生成失败/超时就保留预设提示，不再出现"悬停半天没动静"。
function petReactCardHint(question, preset) {
  const opts = { ic: "💡", stayMs: 5600 };
  petReact(preset, "think", opts); // 立即反馈
  if (_cardHintAbort) { try { _cardHintAbort.abort(); } catch (_) {} }
  const ctrl = new AbortController();
  _cardHintAbort = ctrl;
  const timer = setTimeout(() => ctrl.abort(), 6000); // 6s 未返回就放弃，保留预设提示
  fetch("/api/hxt/react", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "card_hint", context: { question } }),
    signal: ctrl.signal,
  })
    .then((r) => r.json())
    .then((d) => {
      if (_cardHintAbort !== ctrl) return; // 已被更新的悬停取代，丢弃过期结果
      const text = d && typeof d.text === "string" ? d.text.trim() : "";
      // soft：只替换气泡文字，不重播动作、不打断正在做的表情
      if (text) petReact(text, null, Object.assign({ soft: true }, opts));
    })
    .catch(() => {})
    .finally(() => { clearTimeout(timer); if (_cardHintAbort === ctrl) _cardHintAbort = null; });
}

function handleHoverSound(event) {
  // 悬停知识卡片 → 让 tju-llm 按这张卡片的题面给一条引导提示，海小棠念出来
  // （仅"从卡片外进入卡片"时触发 + 2.5s 节流；已翻面看过答案就不提示）
  const hintCard = event.target.closest?.("article.card.flip-card");
  if (hintCard) {
    const from = event.relatedTarget;
    // mouseover 在卡片内部子元素之间也会反复触发，只有从卡片外进入才算一次悬停
    if (!(from && hintCard.contains(from))) {
      const inner = hintCard.querySelector(".flip-card-inner");
      const flipped = !!(inner && inner.classList.contains("is-flipped"));
      const now = Date.now();
      if (!flipped && now - _lastCardHintAt >= PET_CARD_HINT_GAP_MS) {
        _lastCardHintAt = now;
        const preset = PET_CARD_HINTS[Math.floor(Math.random() * PET_CARD_HINTS.length)];
        const question = cardHintQuestion(hintCard);
        // 提取不到题面就不麻烦 tju-llm，直接用回退文案，避免凭空编提示
        if (question) petReactCardHint(question, preset);
        else petReact(preset, "think", { ic: "💡", stayMs: 4600 });
      }
    }
  }
  const el = event.target.closest?.("button, [role='button'], .settings-switch-row, .feature-button, .settings-segmented-btn, .study-context-menu-button, #project-menu-button, .settings-api-button, #new-project-button, .close-dialog, [data-dialog-cancel], #paste-button, #build-framework-button, #voice-input-button, .source-list-item, #studio-expand-button, #undo-button, #dismiss-toast, #dismiss-error, #retry-button, .card-viewer-close, .card-viewer-nav, #mode-switch-lit, #mode-switch-course, .agent-rail-btn, .agent-session-main, .agent-new-session, .agent-import-button, #chat-agent-toggle");
  if (!el || el === _lastHoverTarget) return;
  _lastHoverTarget = el;
  window.KnowOriginSound?.hover();
}

function syncSettingsUI() {
  const ui = window.KnowOriginUI ? window.KnowOriginUI.current() : "academic";
  syncUiSegments(ui);
  const theme = window.KnowOriginTheme ? window.KnowOriginTheme.current() : "light";
  $$(".settings-segmented-btn[data-theme-value]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.themeValue === theme));
  });
  const brand = window.KnowOriginBrand ? window.KnowOriginBrand.current() : "default";
  $$(".settings-segmented-btn[data-brand-value]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.brandValue === brand));
  });
  const fontZoom = window.KnowOriginFontZoom ? window.KnowOriginFontZoom.current() : "1";
  $$(".settings-segmented-btn[data-font-zoom-value]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.fontZoomValue === fontZoom));
  });
  syncGlowSegments(window.KnowOriginCardGlow ? window.KnowOriginCardGlow.current() : "off");
  const petEnabled = window.KnowOriginPet ? window.KnowOriginPet.isEnabled() : true;
  const petToggle = $("#settings-pet-toggle");
  if (petToggle) petToggle.checked = petEnabled;
  const prefs = window.KnowOriginSound ? window.KnowOriginSound.prefs() : { enabled: true };
  const master = $("#settings-sound-toggle");
  if (master) master.checked = prefs.enabled;
}

function openSettings() {
  syncSettingsUI();
  const dialog = $("#settings-dialog");
  if (dialog && !dialog.open) dialog.showModal();
}

let usageDocOpen = false;

function openUsageDoc() {
  const viewer = $("#usage-doc-viewer");
  if (!viewer) return;
  usageDocOpen = true;
  document.body.classList.add("usage-doc-open");
  const dlg = $("#settings-dialog");
  if (dlg && dlg.open) dlg.close();
  // 先提交隐藏态布局，再切入打开态，触发 opacity/transform 过渡
  void viewer.offsetWidth;
  viewer.classList.add("is-open");
  const closeBtn = viewer.querySelector("[data-usage-doc-close]");
  closeBtn?.focus({ preventScroll: true });
}

function closeUsageDoc() {
  if (!usageDocOpen) return;
  usageDocOpen = false;
  document.body.classList.remove("usage-doc-open");
  $("#usage-doc-viewer")?.classList.remove("is-open");
  const dlg = $("#settings-dialog");
  if (dlg && !dlg.open) dlg.showModal();
}

function handleUsageDocKeydown(event) {
  if (!usageDocOpen) return;
  const openDialog = [...document.querySelectorAll("dialog")].find((d) => d.open);
  if (openDialog) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeUsageDoc();
  }
}

function handleUsageDocDocumentClick(event) {
  if (!usageDocOpen) return;
  if (event.target.closest("[data-usage-doc-close]")) {
    event.preventDefault();
    closeUsageDoc();
    return;
  }
  if (event.target.closest("[data-usage-doc-backdrop]")) {
    event.preventDefault();
    closeUsageDoc();
  }
}

function setupUsageDocViewer() {
  $("#usage-guide-toggle")?.addEventListener("click", openUsageDoc);
  const viewer = $("#usage-doc-viewer");
  if (viewer) {
    viewer.addEventListener("click", handleUsageDocDocumentClick);
  }
  document.addEventListener("keydown", handleUsageDocKeydown);
}

function setupSettings() {
  $("#course-settings-button")?.addEventListener("click", openSettings);

  $$(".settings-segmented-btn[data-ui-value]").forEach((btn) => btn.addEventListener("click", () => {
    window.KnowOriginUI?.set(btn.dataset.uiValue);
  }));

  // 文章阅读：主界面顶部入口按钮进入；文章阅读界面的「返回」退出回课程学习
  $("#article-reader-button")?.addEventListener("click", enterLiteratureMode);
  $("#lit-settings-button")?.addEventListener("click", exitLiteratureMode);

  $$(".settings-segmented-btn[data-theme-value]").forEach((btn) => btn.addEventListener("click", () => {
    window.KnowOriginTheme?.set(btn.dataset.themeValue);
  }));
  $$(".settings-segmented-btn[data-brand-value]").forEach((btn) => btn.addEventListener("click", () => {
    window.KnowOriginBrand?.set(btn.dataset.brandValue);
  }));
  $$(".settings-segmented-btn[data-font-zoom-value]").forEach((btn) => btn.addEventListener("click", () => {
    window.KnowOriginFontZoom?.set(btn.dataset.fontZoomValue);
  }));
  $$(".settings-segmented-btn[data-glow-value]").forEach((btn) => btn.addEventListener("click", () => {
    window.KnowOriginCardGlow?.set(btn.dataset.glowValue);
  }));

  $("#settings-pet-toggle")?.addEventListener("change", (event) => {
    window.KnowOriginPet?.setEnabled(event.target.checked);
    syncSettingsUI();
  });

  $("#settings-sound-toggle")?.addEventListener("change", (event) => {
    const prefs = window.KnowOriginSound.prefs();
    prefs.enabled = event.target.checked;
    window.KnowOriginSound.save(prefs);
    syncSettingsUI();
  });

  $("#settings-api-button")?.addEventListener("click", () => {
    $("#settings-dialog").close();
    openApiConfig();
  });
  $("#settings-logout-button")?.addEventListener("click", logout);

  setupUsageDocViewer();
}

function bindSourceDropTarget() {
  const panel = $("#sources-panel");
  if (!panel) return;
  panel.addEventListener("dragenter", handleSourceDragEnter);
  panel.addEventListener("dragover", handleSourceDragOver);
  panel.addEventListener("dragleave", handleSourceDragLeave);
  panel.addEventListener("drop", handleSourceDrop);
}

function hasDraggedFiles(event) {
  return [...(event.dataTransfer?.types || [])].includes("Files");
}

function handleSourceDragEnter(event) {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  state.sourceDragDepth += 1;
  $("#sources-panel").classList.add("is-dragover");
}

function handleSourceDragOver(event) {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  $("#sources-panel").classList.add("is-dragover");
}

function handleSourceDragLeave(event) {
  if (!hasDraggedFiles(event)) return;
  state.sourceDragDepth = Math.max(0, state.sourceDragDepth - 1);
  if (state.sourceDragDepth === 0) $("#sources-panel").classList.remove("is-dragover");
}

function handleSourceDrop(event) {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  state.sourceDragDepth = 0;
  $("#sources-panel").classList.remove("is-dragover");
  uploadFiles([...(event.dataTransfer?.files || [])]);
}

function setSourceUploadBusy(isBusy) {
  const dropzone = $(".dropzone");
  if (!dropzone) return;
  dropzone.classList.toggle("is-uploading", isBusy);
  dropzone.setAttribute("aria-busy", String(isBusy));
}

function startSourceImportProgress(files, projectId, requestId) {
  clearSourceImportProgress({ clearFiles: true, clearBusy: false, render: false });
  state.sourceImportProgress = {
    projectId,
    requestId,
    startedAt: Date.now(),
    fileCount: files.length,
    stageIndex: 0,
    percent: 0,
    label: "正在上传到本地服务",
    detail: "文件正在上传到本地服务，请保持窗口打开。",
    elapsedSeconds: 0,
    status: "active",
    currentFile: "",
    ocrTotal: 0,
    ocrDone: 0,
    ocrUsed: false,
    scanNote: "",
  };
  state.pendingFiles = files.map((file) => ({
    name: file.name,
    size: file.size,
    status: "上传中",
    progress: 0,
    ocr: false,
    progressLabel: "正在上传到本地服务",
    progressDetail: "文件正在上传到本地服务。",
  }));
  updateSourceImportProgress();
  state.sourceImportProgressTimer = window.setInterval(updateSourceImportProgress, SOURCE_IMPORT_PROGRESS_INTERVAL_MS);
}

function updateSourceImportProgress() {
  const progress = state.sourceImportProgress;
  if (!progress || progress.status !== "active") return;
  if (state.currentProjectId !== progress.projectId || state.sourceImportRequestId !== progress.requestId) return;
  // 真实进度：后端尚未开始（上传请求未到达）时保持初始态，到达后由 fetchRealUploadProgress 驱动
  fetchRealUploadProgress(progress.projectId);
}

async function fetchRealUploadProgress(projectId) {
  try {
    const pg = await api(`/api/projects/${encodeURIComponent(projectId)}/sources/upload-progress`);
    const progress = state.sourceImportProgress;
    if (!progress || progress.status !== "active") return;
    if (state.currentProjectId !== progress.projectId) return;

    if (!pg || pg.status === "idle") {
      // 后端还没收到这批文件：保持“上传中”，用不确定动画表示仍在传输
      progress.percent = 0;
      progress.indeterminate = true;
      progress.currentFile = "";
      progress.label = "正在上传到本地服务";
      progress.detail = "文件正在上传到本地服务，请保持窗口打开。";
      renderPendingFiles();
      return;
    }

    const total = pg.total || 1;
    const completed = Number(pg.completed) || 0;
    const realPct = clamp(Math.round((completed / total) * 100), 0, 100);
    const currentFile = pg.current_file || "";
    const ocrTotal = Number(pg.ocr_total) || 0;
    const ocrDone = Number(pg.ocr_done) || 0;
    const ocrUsed = Boolean(pg.ocr_used);

    progress.percent = realPct;
    progress.indeterminate = realPct <= 0 && completed === 0;
    progress.currentFile = currentFile;
    progress.ocrTotal = ocrTotal;
    progress.ocrDone = ocrDone;
    progress.ocrUsed = ocrUsed;
    progress.elapsedSeconds = Math.floor((Date.now() - progress.startedAt) / 1000);

    if (pg.status === "complete") {
      progress.stageIndex = SOURCE_IMPORT_STAGE_COUNT;
      progress.label = "正在完成导入";
      progress.detail = "文件已处理完成，正在收尾。";
    } else if (ocrUsed) {
      progress.stageIndex = 3;
      progress.label = "正在识别扫描件（OCR）";
      progress.detail = currentFile
        ? `正在对「${currentFile}」逐页 OCR 识别，扫描件比普通文件慢，请耐心等待。`
        : "正在逐页 OCR 识别扫描件，请耐心等待。";
    } else if (pg.stage === "saving") {
      progress.stageIndex = 4;
      progress.label = "正在保存文件";
      progress.detail = `已完成 ${completed}/${total} 个文件，正在写入数据库。`;
    } else if (pg.stage === "extracting") {
      progress.stageIndex = 1;
      progress.label = "正在解析文档内容";
      progress.detail = currentFile ? `正在解析：${currentFile}` : `已完成 ${completed}/${total} 个文件。`;
    } else {
      progress.stageIndex = 0;
      progress.label = "正在上传文件";
      progress.detail = `已完成 ${completed}/${total} 个文件。`;
    }

    progress.scanNote = ocrTotal > 0
      ? `检测到 ${ocrTotal} 个扫描件${ocrDone ? `，已完成 ${ocrDone} 个` : ""}；扫描件需要逐页 OCR 识别，可能需等待数分钟，请不要关闭窗口。`
      : "";

    state.pendingFiles = state.pendingFiles.map((file) => {
      if (file.error) return file;
      const isCurrent = currentFile && file.name === currentFile;
      return {
        ...file,
        ocr: file.ocr || (isCurrent && ocrUsed),
        status: isCurrent ? (ocrUsed ? "OCR 识别中" : "处理中") : file.status,
        progressLabel: isCurrent ? progress.label : file.progressLabel,
        progressDetail: isCurrent ? progress.detail : file.progressDetail,
      };
    });
    renderPendingFiles();
  } catch (_) { /* 轮询失败静默处理，进度保持上次状态 */ }
}

function finishSourceImportProgress(projectId, requestId, importedCount, failedCount) {
  const progress = state.sourceImportProgress;
  if (!progress || state.currentProjectId !== projectId || state.sourceImportRequestId !== requestId) return;
  clearSourceImportTimers();
  const hasIssues = failedCount > 0;
  Object.assign(progress, {
    status: hasIssues ? "warning" : "complete",
    stageIndex: SOURCE_IMPORT_STAGE_COUNT,
    percent: 100,
    indeterminate: false,
    label: hasIssues ? "部分文件需要处理" : "导入完成",
    detail: hasIssues
      ? `${importedCount} 个文件已导入，${failedCount} 个文件未成功。`
      : `${importedCount} 个文件已保存到当前项目。`,
    elapsedSeconds: Math.floor((Date.now() - progress.startedAt) / 1000),
  });
  setSourceUploadBusy(false);
  renderPendingFiles();
  state.sourceImportProgressClearTimer = window.setTimeout(() => {
    if (state.currentProjectId !== projectId || state.sourceImportRequestId !== requestId) return;
    state.sourceImportProgress = null;
    if (!state.pendingFiles.some((file) => file.error)) state.pendingFiles = [];
    renderPendingFiles();
  }, hasIssues ? 3200 : 1600);
}

function failSourceImportProgress(error, projectId, requestId) {
  const progress = state.sourceImportProgress;
  if (!progress || state.currentProjectId !== projectId || state.sourceImportRequestId !== requestId) return;
  clearSourceImportTimers();
  Object.assign(progress, {
    status: "error",
    percent: 100,
    label: "导入失败",
    detail: error.message || "请检查本地服务或模型配置后重试。",
    elapsedSeconds: Math.floor((Date.now() - progress.startedAt) / 1000),
  });
  setSourceUploadBusy(false);
  renderPendingFiles();
}

function clearSourceImportTimers() {
  window.clearInterval(state.sourceImportProgressTimer);
  window.clearTimeout(state.sourceImportProgressClearTimer);
  state.sourceImportProgressTimer = 0;
  state.sourceImportProgressClearTimer = 0;
}

function clearSourceImportProgress({ clearFiles = true, clearBusy = true, render = true } = {}) {
  clearSourceImportTimers();
  state.sourceImportProgress = null;
  if (clearFiles) state.pendingFiles = [];
  if (clearBusy) setSourceUploadBusy(false);
  if (render) renderPendingFiles();
}

function handleSourceListClick(event) {
  const bulkDeleteButton = event.target.closest("[data-source-delete-action]");
  if (bulkDeleteButton?.dataset.sourceDeleteAction === "delete-selected") {
    event.preventDefault();
    event.stopPropagation();
    deleteSelectedSources();
    return;
  }
  if (event.target.closest(".file-check")) {
    return;
  }
  const actionButton = event.target.closest("[data-file-action]");
  if (actionButton?.dataset.fileAction === "delete") {
    event.preventDefault();
    event.stopPropagation();
    const source = state.sources.find((item) => item.source_id === actionButton.dataset.sourceId);
    if (source) deleteSource(source);
    return;
  }
  const previewItem = event.target.closest(".source-preview-trigger");
  if (previewItem) {
    event.preventDefault();
    const source = state.sources.find((item) => item.source_id === previewItem.dataset.sourceId);
    if (!source) return;
    if (event.ctrlKey || event.metaKey) {
      toggleSourceDeleteSelection(source.source_id);
      return;
    }
    previewSource(source);
  }
}

function handleSourceListChange(event) {
  const checkbox = event.target.closest("[data-source-select]");
  if (!checkbox) return;
  const sourceId = checkbox.dataset.sourceSelect === "all" ? "all" : checkbox.dataset.sourceId;
  if (!sourceId) return;
  toggleSourceSelection(sourceId, checkbox.checked);
}

function handleSourceListKeydown(event) {
  if (!["Enter", " "].includes(event.key)) return;
  if (event.target.closest("button, input, label")) return;
  const previewItem = event.target.closest(".source-preview-trigger");
  if (!previewItem) return;
  event.preventDefault();
  const source = state.sources.find((item) => item.source_id === previewItem.dataset.sourceId);
  if (!source) return;
  if (event.ctrlKey || event.metaKey) {
    toggleSourceDeleteSelection(source.source_id);
    return;
  }
  previewSource(source);
}

function previewSource(source, quote) {
  openSourcePreview(source.source_id, typeof quote === "string" ? quote : "");
}

function initializePanelResizing() {
  const workspace = $(".workspace");
  if (!workspace) return;
  const saved = readSavedPanelLayout();
  const defaults = defaultPanelWidths(workspace);
  applyPanelWidths(saved?.left ?? defaults.left, saved?.right ?? defaults.right, { persist: false });

  $$(".panel-resizer").forEach((handle) => {
    handle.addEventListener("pointerdown", startPanelResize);
    handle.addEventListener("keydown", resizePanelsWithKeyboard);
    handle.addEventListener("dblclick", resetPanelWidths);
  });

  let resizeFrame = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      const current = state.panelLayout || defaultPanelWidths(workspace);
      applyPanelWidths(current.left, current.right, { persist: false });
    });
  });
}

function startPanelResize(event) {
  if (event.button !== 0 || state.studioFocus) return;
  event.preventDefault();
  const handle = event.currentTarget;
  const side = handle.dataset.resizer;
  const workspace = $(".workspace");
  const start = currentPanelWidths();
  const startX = event.clientX;
  handle.classList.add("is-active");
  workspace.classList.add(`resizing-${side}`);
  document.body.classList.add("is-resizing");

  const move = (moveEvent) => {
    if (moveEvent.pointerId !== event.pointerId) return;
    const delta = moveEvent.clientX - startX;
    if (side === "left") {
      const pairWidth = start.left + start.center;
      const left = clamp(start.left + delta, PANEL_LIMITS.left, pairWidth - PANEL_LIMITS.center);
      applyPanelWidths(left, start.right, { persist: false, activeSide: "left" });
    } else {
      const pairWidth = start.center + start.right;
      const right = clamp(start.right - delta, PANEL_LIMITS.right, pairWidth - PANEL_LIMITS.center);
      applyPanelWidths(start.left, right, { persist: false, activeSide: "right" });
    }
  };

  let finished = false;
  const finish = (finishEvent) => {
    if (finished || (finishEvent?.pointerId != null && finishEvent.pointerId !== event.pointerId)) return;
    finished = true;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    window.removeEventListener("blur", finish);
    handle.classList.remove("is-active");
    workspace.classList.remove(`resizing-${side}`);
    document.body.classList.remove("is-resizing");
    savePanelLayout();
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
  window.addEventListener("blur", finish);
}

function resizePanelsWithKeyboard(event) {
  if (state.studioFocus) return;
  const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
  if (!direction && event.key !== "Home") return;
  event.preventDefault();
  if (event.key === "Home") return resetPanelWidths();
  const side = event.currentTarget.dataset.resizer;
  const current = currentPanelWidths();
  const step = event.shiftKey ? 60 : 20;
  if (side === "left") {
    applyPanelWidths(current.left + direction * step, current.right, { activeSide: "left" });
  } else {
    applyPanelWidths(current.left, current.right - direction * step, { activeSide: "right" });
  }
}

function resetPanelWidths() {
  const workspace = $(".workspace");
  const defaults = defaultPanelWidths(workspace);
  workspace.classList.add("is-resetting");
  applyPanelWidths(defaults.left, defaults.right);
  window.setTimeout(() => workspace.classList.remove("is-resetting"), 220);
}

function applyPanelWidths(left, right, { persist = true, activeSide = "" } = {}) {
  const workspace = $(".workspace");
  if (!workspace) return;
  const available = availablePanelWidth(workspace);
  const maxOuterWidth = Math.max(PANEL_LIMITS.left + PANEL_LIMITS.right, available - PANEL_LIMITS.center);
  let nextLeft = Math.round(Math.max(PANEL_LIMITS.left, Number(left) || PANEL_LIMITS.left));
  let nextRight = Math.round(Math.max(PANEL_LIMITS.right, Number(right) || PANEL_LIMITS.right));

  if (activeSide === "left") {
    nextRight = clamp(nextRight, PANEL_LIMITS.right, maxOuterWidth - PANEL_LIMITS.left);
    nextLeft = clamp(nextLeft, PANEL_LIMITS.left, maxOuterWidth - nextRight);
  } else if (activeSide === "right") {
    nextLeft = clamp(nextLeft, PANEL_LIMITS.left, maxOuterWidth - PANEL_LIMITS.right);
    nextRight = clamp(nextRight, PANEL_LIMITS.right, maxOuterWidth - nextLeft);
  } else if (nextLeft + nextRight > maxOuterWidth) {
    const flexibleLeft = Math.max(0, nextLeft - PANEL_LIMITS.left);
    const flexibleRight = Math.max(0, nextRight - PANEL_LIMITS.right);
    const flexibleTotal = flexibleLeft + flexibleRight;
    const availableFlexible = Math.max(0, maxOuterWidth - PANEL_LIMITS.left - PANEL_LIMITS.right);
    const ratio = flexibleTotal ? Math.min(1, availableFlexible / flexibleTotal) : 0;
    nextLeft = Math.round(PANEL_LIMITS.left + flexibleLeft * ratio);
    nextRight = Math.round(PANEL_LIMITS.right + flexibleRight * ratio);
  }

  workspace.style.setProperty("--left-panel-width", `${nextLeft}px`);
  workspace.style.setProperty("--right-panel-width", `${nextRight}px`);
  state.panelLayout = { left: nextLeft, right: nextRight };
  updatePanelResizeFeedback(available, nextLeft, nextRight);
  if (persist) savePanelLayout();
}

function updatePanelResizeFeedback(available, left, right) {
  const center = Math.max(0, Math.round(available - left - right));
  const leftHandle = $('[data-resizer="left"]');
  const rightHandle = $('[data-resizer="right"]');
  if (leftHandle) {
    leftHandle.querySelector(".resize-hint").textContent = `左 ${left}px · 中 ${center}px`;
    leftHandle.setAttribute("aria-valuemin", String(PANEL_LIMITS.left));
    leftHandle.setAttribute("aria-valuemax", String(Math.max(PANEL_LIMITS.left, available - right - PANEL_LIMITS.center)));
    leftHandle.setAttribute("aria-valuenow", String(left));
  }
  if (rightHandle) {
    rightHandle.querySelector(".resize-hint").textContent = `中 ${center}px · 右 ${right}px`;
    rightHandle.setAttribute("aria-valuemin", String(PANEL_LIMITS.right));
    rightHandle.setAttribute("aria-valuemax", String(Math.max(PANEL_LIMITS.right, available - left - PANEL_LIMITS.center)));
    rightHandle.setAttribute("aria-valuenow", String(right));
  }
}

function currentPanelWidths() {
  const workspace = $(".workspace");
  const available = availablePanelWidth(workspace);
  const left = Math.round($(".sources-panel").getBoundingClientRect().width);
  const right = Math.round($(".studio-panel").getBoundingClientRect().width);
  return { left, center: Math.max(0, available - left - right), right };
}

function availablePanelWidth(workspace) {
  const style = getComputedStyle(workspace);
  const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const resizers = $$(".panel-resizer").reduce((total, item) => total + item.getBoundingClientRect().width, 0);
  return Math.max(0, workspace.clientWidth - padding - resizers);
}

function defaultPanelWidths(workspace) {
  return workspace.clientWidth <= 1260 ? { left: 250, right: 340 } : { left: 280, right: 390 };
}

function readSavedPanelLayout() {
  try {
    const value = JSON.parse(localStorage.getItem(PANEL_LAYOUT_STORAGE_KEY) || "null");
    return Number.isFinite(value?.left) && Number.isFinite(value?.right) ? value : null;
  } catch { return null; }
}

function savePanelLayout() {
  if (!state.panelLayout) return;
  try { localStorage.setItem(PANEL_LAYOUT_STORAGE_KEY, JSON.stringify(state.panelLayout)); } catch { /* Storage may be unavailable. */ }
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function expandStudioFromContent(event) {
  if (state.studioFocus || state.studioFocusClosing) return;
  if (event.target.closest(".graph-toolbar, .graph-control, .kb-flow-graph, .kb-view-switch")) return;
  const focusableContent = event.target.closest(".card, .quiz-question, .metric-card, .overview-dashboard, .overview-node-card, .graph-wrap, .node-detail");
  if (focusableContent) expandStudio(focusableContent);
}

function handleStudioOutputClick(event) {
  // 知识图谱节点单击 = 滑出语义护照（唯一入口，见 kbGraphNodeClickOpensPassport）
  if (kbGraphNodeClickOpensPassport(event)) return;
  const errTypeButton = event.target.closest("[data-quiz-error-type]");
  if (errTypeButton) {
    event.preventDefault();
    event.stopPropagation();
    submitQuizErrorType(errTypeButton);
    return;
  }
  // 掌握度来源：点击卡片 / 节点里的标签，弹框显示明细记录
  const trailBtn = event.target.closest("[data-mastery-trail-kind]");
  if (trailBtn && !trailBtn.disabled) {
    event.preventDefault();
    event.stopPropagation();
    const kind = trailBtn.dataset.masteryTrailKind;
    const scope = trailBtn.dataset.masteryTrailScope || "aggregate";
    const nodeId = trailBtn.dataset.masteryTrailNode || null;
    openMasteryTrailModal(kind, scope, nodeId);
    return;
  }
  const colorButton = event.target.closest("[data-color]");
  if (colorButton) {
    event.preventDefault();
    event.stopPropagation();
    updateFavoriteColor(colorButton);
    return;
  }
  const overviewActionButton = event.target.closest("[data-overview-action]");
  if (overviewActionButton) {
    event.preventDefault();
    event.stopPropagation();
    handleOverviewAction(overviewActionButton);
    return;
  }
  const studyActionButton = event.target.closest("[data-study-action]");
  if (studyActionButton) {
    event.preventDefault();
    event.stopPropagation();
    const action = studyActionButton.dataset.studyAction;
    if (action === "regenerate-cards") generateCards();
    if (action === "regenerate-quiz") generateQuiz();
    if (action === "delete-selected-cards") deleteSelectedStudyItems("card");
    if (action === "delete-selected-quiz") deleteSelectedStudyItems("quiz");
    if (action === "toggle-quiz-history") {
      state.quizHistoryExpanded = !state.quizHistoryExpanded;
      renderStudio();
    }
    if (action === "view-history-quiz") enterHistoricQuizView(studyActionButton.dataset.quizId);
    if (action === "exit-history-quiz") exitHistoricQuizView();
    if (action === "return-from-quiz") kbReturnFromQuiz();
    return;
  }
  const diffHelpButton = event.target.closest("[data-diff-help]");
  if (diffHelpButton) {
    event.preventDefault();
    event.stopPropagation();
    toggleDiffHelp(diffHelpButton);
    return;
  }
  const diffPill = event.target.closest("[data-study-diff]");
  if (diffPill) {
    event.preventDefault();
    event.stopPropagation();
    state.studyDifficulty = diffPill.dataset.studyDiff;
    renderStudio();
    const explain = {
      auto: "自动档：我会结合你现在的掌握情况，从易到难挑题，先巩固再挑战，放心交给我。",
      1: "简单档：考「记忆 + 理解」，先把基础概念吃透，后面的路才好走。",
      2: "中等档：考「运用 + 分析」，概念会被带进情景里，动动脑就能拿下。",
      3: "困难档：考「评价 + 创造」的硬核题，敢选就是在挑战自己，累了就歇，我陪你复盘。",
    };
    const diffLabel = { auto: "自动", 1: "简单", 2: "中等", 3: "困难" }[diffPill.dataset.studyDiff] || diffPill.dataset.studyDiff;
    petReactAI("diff", { difficulty: diffLabel }, "think", explain[diffPill.dataset.studyDiff] || "这个难度下，题会根据来源的真实考点来出。", { ic: "🎯" });
    return;
  }
  const studySourceButton = event.target.closest("[data-study-source-id]");
  if (studySourceButton) {
    event.preventDefault();
    event.stopPropagation();
    openSourcePreview(studySourceButton.dataset.studySourceId, studySourceButton.dataset.studySourceQuote || "");
    return;
  }
  if (event.target.closest(".study-item-menu > summary")) {
    event.stopPropagation();
    return;
  }
  const nodeJumpButton = event.target.closest("[data-study-node-jump]");
  if (nodeJumpButton) {
    event.preventDefault();
    event.stopPropagation();
    nodeJumpButton.closest(".study-item-menu")?.removeAttribute("open");
    jumpToKbNode(nodeJumpButton.dataset.nodeId);
    return;
  }
  const studyItemButton = event.target.closest("[data-study-item-action]");
  if (studyItemButton) {
    event.preventDefault();
    event.stopPropagation();
    studyItemButton.closest(".study-item-menu")?.removeAttribute("open");
    const action = studyItemButton.dataset.studyItemAction;
    if (action === "favorite") toggleFavorite(studyItemButton);
    if (action === "rename") openStudyItemRename(studyItemButton);
    if (action === "delete") deleteStudyItem(studyItemButton);
    return;
  }
  if (handleStudyItemSelectionClick(event)) return;
  const cardRateBtn = event.target.closest("[data-card-rate]");
  if (cardRateBtn) {
    event.preventDefault();
    event.stopPropagation();
    submitCardSelfRating(cardRateBtn);
    return;
  }
  const favoriteButton = event.target.closest(".favorite-button");
  if (favoriteButton) {
    event.preventDefault();
    event.stopPropagation();
    toggleFavorite(favoriteButton);
    return;
  }
  const actionButton = event.target.closest("[data-favorite-action]");
  if (actionButton) {
    event.preventDefault();
    event.stopPropagation();
    const favoriteId = actionButton.dataset.favoriteId;
    if (actionButton.dataset.favoriteAction === "edit") {
      state.editingFavoriteId = favoriteId;
      renderFavorites();
    } else if (actionButton.dataset.favoriteAction === "cancel") {
      state.editingFavoriteId = "";
      renderFavorites();
    } else if (actionButton.dataset.favoriteAction === "delete") {
      deleteFavorite(favoriteId);
    }
    return;
  }
  // 翻转式知识卡片：点击卡片本体翻面查看答案（交互控件在上方各 handler 已被拦截）
  const flipCardArticle = event.target.closest("article.card.flip-card");
  if (flipCardArticle) {
    const flipToggle = event.target.closest("[data-flip-toggle]");
    if (flipToggle) {
      event.preventDefault();
      event.stopPropagation();
      toggleCardFlip(flipCardArticle);
      return;
    }
    const openViewer = event.target.closest("[data-card-open-viewer]");
    if (openViewer) {
      event.preventDefault();
      event.stopPropagation();
      openCardViewer(Number(openViewer.dataset.cardOpenViewer));
      return;
    }
    // 答案展开/收起：只动答案，不翻面
    const answerToggle = event.target.closest("[data-card-answer-toggle]");
    if (answerToggle) {
      event.preventDefault();
      event.stopPropagation();
      const aid = answerToggle.dataset.cardAnswerToggle;
      setCardAnswerOpen(aid, !state.cardAnswerOpenIds.has(aid));
      return;
    }
    // 正在圈选高亮文字时不要误触翻面
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    // 其余可交互控件（菜单/source chip/按钮等）交给既有逻辑，不翻面；
    // 标题操作区/背面工具区/自评区也一律不翻面，避免误触（如收藏徽标、分类标签）
    if (event.target.closest("button, a, summary, .study-item-menu, .study-source-chip, input, textarea, label, select, .review-item-heading, .flip-card-back-tools, .card-self-rate")) return;
    event.preventDefault();
    event.stopPropagation();
    toggleCardFlip(flipCardArticle);
    return;
  }
  expandStudioFromContent(event);
}

function handleStudioOutputSubmit(event) {
  if (!event.target.matches(".favorite-edit-form")) return;
  event.preventDefault();
  saveFavoriteEdit(event.target);
}

function handleStudioOutputChange(event) {
  const quizTypeCheck = event.target.closest("[data-quiz-type]");
  if (quizTypeCheck) {
    const type = quizTypeCheck.dataset.quizType;
    if (quizTypeCheck.checked) {
      if (!state.quizQuestionTypes.includes(type)) state.quizQuestionTypes.push(type);
    } else {
      state.quizQuestionTypes = state.quizQuestionTypes.filter((t) => t !== type);
    }
  }
}

function handleConversationClick(event) {
  const colorButton = event.target.closest("[data-color]");
  if (colorButton) {
    event.preventDefault();
    event.stopPropagation();
    updateFavoriteColor(colorButton);
    return;
  }
  if (event.target.closest(".message-item-menu > summary")) {
    event.stopPropagation();
    return;
  }
  const messageActionButton = event.target.closest("[data-message-action]");
  if (messageActionButton) {
    event.preventDefault();
    event.stopPropagation();
    messageActionButton.closest(".message-item-menu")?.removeAttribute("open");
    const action = messageActionButton.dataset.messageAction;
    if (action === "favorite") toggleFavorite(messageActionButton);
    if (action === "delete") deleteConversationPair(messageActionButton);
    if (action === "toggle-sources") toggleMessageSources(messageActionButton);
    return;
  }
  const favoriteButton = event.target.closest(".favorite-button");
  if (!favoriteButton) return;
  event.preventDefault();
  toggleFavorite(favoriteButton);
}

function toggleStudioFocus() {
  if (state.studioFocus) collapseStudio();
  else expandStudio($("#studio-expand-button"));
}

function expandStudio(trigger = null) {
  if (state.studioFocus || state.studioFocusClosing) return;
  const panel = $(".studio-panel");
  const button = $("#studio-expand-button");
  state.studioFocusOrigin = panel.getBoundingClientRect();
  state.studioPreviousFocus = document.activeElement;
  state.studioFocus = true;
  document.body.classList.add("studio-focus-open");
  panel.classList.add("studio-focus");
  refreshQuestionRails();
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  button.setAttribute("aria-expanded", "true");
  const isAgentUi = currentUi() === "agent";
  button.setAttribute("aria-label", isAgentUi ? "返回对话" : "收起学习产出");
  button.title = isAgentUi ? "返回对话（Esc）" : "收起学习产出（Esc）";
  button.querySelector(".studio-expand-label").textContent = isAgentUi ? "返回对话" : "收起";

  // agent 布局的产出是整屏浮层，缩放形变动画与它不搭（且会闪一下整屏）→ 直接跳过
  if (!isAgentUi && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const target = panel.getBoundingClientRect();
    const origin = state.studioFocusOrigin;
    panel.animate([
      {
        transformOrigin: "top left",
        transform: `translate(${origin.left - target.left}px, ${origin.top - target.top}px) scale(${origin.width / target.width}, ${origin.height / target.height})`,
        opacity: 0.88,
      },
      { transformOrigin: "top left", transform: "translate(0, 0) scale(1)", opacity: 1 },
    ], { duration: 430, easing: "cubic-bezier(.2,.86,.2,1)" });
  }

  if (trigger && !panel.contains(document.activeElement)) button.focus({ preventScroll: true });
}

function collapseStudio() {
  if (!state.studioFocus || state.studioFocusClosing) return;
  const panel = $(".studio-panel");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const origin = state.studioFocusOrigin;
  state.studioFocusClosing = true;

  if ((currentUi() === "agent" || reducedMotion || !origin)) {
    finishStudioCollapse();
    return;
  }
  {
    const current = panel.getBoundingClientRect();
    const animation = panel.animate([
      { transformOrigin: "top left", transform: "translate(0, 0) scale(1)", opacity: 1 },
      {
        transformOrigin: "top left",
        transform: `translate(${origin.left - current.left}px, ${origin.top - current.top}px) scale(${origin.width / current.width}, ${origin.height / current.height})`,
        opacity: 0.82,
      },
    ], { duration: 300, easing: "cubic-bezier(.55,.05,.7,.25)" });
    animation.addEventListener("finish", finishStudioCollapse, { once: true });
    animation.addEventListener("cancel", finishStudioCollapse, { once: true });
  }
}

function finishStudioCollapse() {
  const panel = $(".studio-panel");
  const button = $("#studio-expand-button");
  document.body.classList.remove("studio-focus-open");
  panel.classList.remove("studio-focus");
  refreshQuestionRails();
  panel.removeAttribute("role");
  panel.removeAttribute("aria-modal");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-label", "展开学习产出");
  button.title = "展开学习产出";
  button.querySelector(".studio-expand-label").textContent =
    currentUi() === "agent" ? "返回对话" : "展开";
  state.studioFocus = false;
  state.studioFocusClosing = false;
  state.studioFocusOrigin = null;
  if (state.studioPreviousFocus?.isConnected) state.studioPreviousFocus.focus({ preventScroll: true });
  state.studioPreviousFocus = null;
}

function handleStudioFocusKeydown(event) {
  if (!state.studioFocus) return;
  if (usageDocOpen) return; // 使用说明全屏查看器打开时，Esc 交由它处理
  // If any modal dialog is currently open, let it handle its own Escape (to close).
  // We must NOT also collapse the studio focus, otherwise closing source preview
  // or any other dialog unexpectedly kicks the user back to the 3-pane layout.
  // dialog.open is still true during keydown (browser default closes it *after* the event).
  if (event.key === "Escape") {
    const openDialog = [...document.querySelectorAll("dialog")].find((d) => d.open);
    if (openDialog) return;
    event.preventDefault();
    collapseStudio();
    return;
  }
  if (event.key !== "Tab") return;

  const panel = $(".studio-panel");
  const focusable = [...panel.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex='-1'])")]
    .filter((element) => element.getClientRects().length > 0);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  } else if (!panel.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
  }
}

async function loadSession() {
  try {
    const session = await api("/api/auth/session");
    if (session.authenticated) {
      setAuthenticated(session.user);
      // loadProjects 内部会优先选中上次看的项目（见 rememberedProjectId）
      await loadProjects();
    } else {
      showAuthView();
    }
  } catch (error) {
    showAuthView();
  } finally {
    // 会话状态已表态：index.html 的首屏兜底（3 秒后仍无视图可见就露出登录页）
    // 从此不再介入。否则「刷新后 3 秒内进入文章阅读」（#workspace 被隐藏、
    // 可见的是 #literature-workspace）会被它误判成白屏，把登录卡片塞到阅读界面顶上。
    document.documentElement.dataset.sessionReady = "1";
  }
}

// 换账号判断用的「上一个登录账号」标记：存在 localStorage。页面刷新时 loadSession
// 也会走到 setAuthenticated，对照它才能区分「同一账号刷新」与「真的换了人」——
// 否则每次刷新都会把对比视图记录等本地内容清掉（对比视图记录只存在本地）。
const LAST_ACCOUNT_KEY = "knoworigin-last-account";

// 当前项目：刷新后要能回到上次那个，否则对话历史、过程条、依据栏会一起消失。
// 口径与 agent-shell.js 的 SESSION_MAP_KEY（knoworigin-chat-session-v1）一致，都是
// 「按后端会话状态恢复用户上次在看什么」。
const LAST_PROJECT_KEY = "knoworigin-last-project";

function rememberedProjectId() {
  try { return localStorage.getItem(LAST_PROJECT_KEY) || ""; } catch { return ""; }
}

function rememberProjectId(projectId) {
  try {
    if (projectId) localStorage.setItem(LAST_PROJECT_KEY, projectId);
    else localStorage.removeItem(LAST_PROJECT_KEY);
  } catch { /* ignore */ }
}

function accountKey(user) {
  const u = user || {};
  return String(u.user_id || u.email || "").trim();
}

function setAuthenticated(user) {
  state.authenticated = true;
  state.user = user || null;
  $("#auth-shell").classList.add("hidden");
  $("#workspace").classList.remove("hidden");
  $("#account-name").textContent = user?.name || user?.email || "";
  // 只在新账号登录时清文献模块：同一账号刷新页面，对比视图记录要保留
  const last = localStorage.getItem(LAST_ACCOUNT_KEY) || "";
  const next = accountKey(user);
  if (last && next && last !== next) resetLiteratureModule();
  if (next) localStorage.setItem(LAST_ACCOUNT_KEY, next);
  // 海小棠桌宠：登录成功广播（低侵入，桌宠由此知道可以展示）
  document.dispatchEvent(new CustomEvent("knoworigin:pet-login", { detail: { user: state.user } }));
}

// 切换账号（登出，或换个人登录）时，把文献模块的闭包状态与已渲染正文一起清掉。
// 文献数据在后端按 owner 隔离，但前端不清就会把上一位账号的论文留在中栏。
function resetLiteratureModule() {
  const lit = window.KnowOriginLiterature;
  if (lit && typeof lit.reset === "function") { try { lit.reset(); } catch (_) { /* 忽略 */ } }
  const cv = window.KnowOriginLitCompareView;
  if (cv && typeof cv.reset === "function") { try { cv.reset(); } catch (_) { /* 忽略 */ } }
}

function showAuthView() {
  const authShell = $("#auth-shell");
  // 只有登录页从"隐藏"变"可见"时才聚焦邮箱。已经可见时不再抢焦点，
  // 否则任何一次迟到的 401 / 重复调用都会把正在输入密码的用户弹回邮箱框。
  const wasVisible = !authShell.classList.contains("hidden");
  state.authenticated = false;
  state.user = null;
  state.currentProjectId = "";
  state.projects = [];
  resetProjectView();
  resetLiteratureModule();
  // 登出视为新会话：清掉账号标记，下一位（哪怕同一人）登录按新账号处理
  localStorage.removeItem(LAST_ACCOUNT_KEY);
  // 两个与工作台平级的阅读视图都要收起来，否则「在阅读模式里会话失效」时，
  // 登录壳会和还开着的阅读界面上下叠在一起 —— 用户看到的就是「阅读模式里冒出登录界面」。
  // 文章阅读早在名单里，读书（#reading-workspace）之前漏了。
  document.getElementById("literature-workspace")?.classList.add("hidden");
  const readingWorkspace = document.getElementById("reading-workspace");
  if (readingWorkspace) {
    // .is-open 才是 #reading-workspace 的 display:block 开关，一起复位；
    // 但不能走 KnowOriginReading.close()——那个会把 #workspace 又露出来。
    readingWorkspace.classList.add("hidden");
    readingWorkspace.classList.remove("is-open");
  }
  $("#workspace").classList.add("hidden");
  authShell.classList.remove("hidden");
  $("#account-name").textContent = "";
  if (!wasVisible) $("#auth-email").focus({ preventScroll: true });
}

function enterLiteratureMode() {
  if (typeof window.KnowOriginLiterature?.enter === "function") window.KnowOriginLiterature.enter();
}

function exitLiteratureMode() {
  if (typeof window.KnowOriginLiterature?.exit === "function") window.KnowOriginLiterature.exit();
  // 兜底：不管导入走的是哪条路径，退出文章阅读时都对一次项目列表
  syncProjectListSilently();
}

// 文章阅读里导入 / 删除论文会改变项目集合，literature.js 完成后广播此事件。
// 用事件解耦，避免在文献模块里反向引用 app.js 的内部函数（两边都是独立 IIFE）。
document.addEventListener("knoworigin:projects-changed", () => {
  syncProjectListSilently();
});

// 重新从服务端拉一遍卡片，覆盖本地快照。静默：失败就保持旧快照。
// 两条调用方共用它 —— ① knowledge-doc-ui.js 回流自测题后广播的事件 ② 切进本功能时补拉。
async function refreshCardsFromServer(projectId) {
  const pid = projectId || state.currentProjectId;
  if (!pid || !state.authenticated) return false;
  try {
    const data = await api(`/api/projects/${encodeURIComponent(pid)}/cards`);
    if (!data || !Array.isArray(data.cards)) return false;
    if (pid !== state.currentProjectId) { state.cardsStale = true; return false; }
    state.cards = data.cards;
    state.cardsStale = false;
    return true;
  } catch (_) {
    return false;
  }
}

// knowledge-doc-ui.js 把文档里的自测题回流成卡片后广播此事件。
// 不接的话，state.cards 里还是进这个功能之前的快照，用户刚被告知「已加入 N 道题」，
// 切过去却看不到，只能手动刷新页面 —— 这是最容易被当成「功能坏了」的一种不一致。
document.addEventListener("knoworigin:cards-changed", async (event) => {
  const detail = (event && event.detail) || {};
  const ok = await refreshCardsFromServer(detail.project_id);
  // 只有正停在「知识卡片」时才重绘：别把用户正在看的别的功能页顶掉。
  if (ok && state.feature === "cards") renderCards();
});

function toggleAuthMode() {
  setAuthMode(state.authMode === "login" ? "register" : "login");
}

function setAuthMode(mode) {
  state.authMode = mode;
  const isRegister = mode === "register";
  $("#auth-title").textContent = isRegister ? "注册知源" : "登录知源";
  $("#auth-submit").textContent = isRegister ? "注册并进入" : "登录";
  $("#auth-mode-toggle").textContent = isRegister ? "已有账号？登录" : "没有账号？注册";
  $("#auth-name-field").classList.toggle("hidden", !isRegister);
  $("#auth-password").autocomplete = isRegister ? "new-password" : "current-password";
  $("#auth-feedback").textContent = "";
  $("#auth-feedback").className = "config-feedback";
}

async function submitAuth(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $("#auth-submit");
  const feedback = $("#auth-feedback");
  if (!form.reportValidity()) return;
  const payload = {
    email: $("#auth-email").value.trim(),
    password: $("#auth-password").value,
  };
  if (state.authMode === "register") payload.name = $("#auth-name").value.trim();
  button.disabled = true;
  feedback.textContent = state.authMode === "register" ? "正在创建账号…" : "正在登录…";
  feedback.className = "config-feedback";
  try {
    const session = await api(`/api/auth/${state.authMode === "register" ? "register" : "login"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    form.reset();
    setAuthMode("login");
    setAuthenticated(session.user);
    await loadProjects();
  } catch (error) {
    feedback.textContent = error.message;
    feedback.className = "config-feedback is-error";
  } finally {
    button.disabled = false;
  }
}

async function logout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    // The local view should still clear even if the session has already expired.
  }
  $$("dialog").forEach((dialog) => { if (dialog.open) dialog.close(); });
  // 海小棠桌宠监听了这个事件（hxt-pet.js），登出时本来没人派发，桌宠会一直留在页面上
  document.dispatchEvent(new CustomEvent("knoworigin:pet-logout"));
  showAuthView();
}

function closeStudioFocusFromBackdrop(event) {
  if (!state.studioFocus || state.studioFocusClosing) return;
  // 点击传播途中目标已被重新渲染移出文档（如切换脑图/双链图谱、点标签筛选），
  // 它不是真正的背板点击，不能据此收起全屏工作台
  if (!(event.target instanceof Node) || !event.target.isConnected) return;
  // 高亮操作会在色块 mousedown 后重建文档选区与 mark、隐藏工具条，浏览器把随后的
  // click 重定向到公共祖先 <body>（目标既非工具条也非 mark）。此刻 target 是 body、
  // 不在 .studio-panel 内，会被误判成“点击背板”而收起全屏学习产出。用 applyTextHighlight
  // 写下的时间戳守卫：高亮应用瞬间释放的伪点击一律忽略。
  if (state._hlGuard && performance.now() - state._hlGuard < 350) return;
  if (event.target.closest?.(".text-highlight-toolbar")) return;
  // KB 选中浮动菜单（含「高亮」色板与索引/引导动作）也挂在 body 下、位于 .studio-panel 之外，
  // 在全屏工作台里点击其中色块/按钮不应被视为「点击背板」而退回三栏主界面。
  if (event.target.closest?.("[data-kb-sel-actions]")) return;
  // 已高亮的 <mark> 文字也属于正文内容：点击/圈选它（含主对话回答里被高亮的文字）不应被当成“点击背板”收起全屏。
  if (event.target.closest?.("mark, .text-highlight")) return;
  // Ignore clicks originating from any dialog (e.g. source-preview close button
  // or dialog backdrop) so closing a modal never collapses the studio focus.
  // Dialogs live outside .studio-panel in DOM but are displayed on top of it.
  if (event.target.closest?.("dialog")) return;
  // 沉浸式卡片浏览也覆盖在 studio 之上、DOM 却在 .studio-panel 之外：点击它的
  // 翻页/关闭按钮不应被视为「点击背板」而把全屏工作室收起来。
  if (event.target.closest?.("#card-viewer")) return;
  // 使用说明全屏查看器同样覆盖在 studio 之上：点击其内部按钮/折叠项不算背板点击。
  if (event.target.closest?.("#usage-doc-viewer")) return;
  // 海小棠桌宠/气泡/菜单/专属对话框挂在 body 下、位于 .studio-panel 之外：
  // 在全屏工作台（卡片/测验/花园）里点它或其弹层不应被当成“点背板”而退回三栏主界面。
  if (event.target.closest?.("#hxt-pet, .hxt-dialog, .hxt-bubble, .hxt-menu")) return;
  // Agent 布局把图标栏/会话侧栏抬到产出浮层之上，点它们不该被当成「点击背板」
  if (event.target.closest?.("#agent-rail, #agent-sessions")) return;
  if (!$(".studio-panel").contains(event.target)) collapseStudio();
}

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options });
  let body = {};
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) {
    const detail = body.detail && typeof body.detail === "object" ? body.detail : body;
    if (response.status === 401 && !path.startsWith("/api/auth/") && state.authenticated) {
      // 只在"本来已登录、会话中途失效"时才切回登录视图。登录页上后台模块的请求
      // 必然 401（如 /api/teaching-mode），若每次都切视图+聚焦邮箱，用户就永远
      // 无法在密码框里连续输入——这正是"注册时焦点老是弹回邮箱"的根因之一。
      showAuthView();
    }
    const error = new Error(detail.message || `请求失败（${response.status}）`);
    error.status = response.status;
    error.code = detail.code || "";
    error.retryable = Boolean(detail.retryable);
    throw error;
  }
  return body;
}

async function checkHealth() {
  try {
    const health = await api("/api/health");
    updateHealthStatus(health.model_configured ? "AI 服务已配置" : "本地模式 · 点此填入自己的 API Key", true);
  } catch (error) {
    updateHealthStatus("本地服务不可用", false);
    showError(error, checkHealth);
  }
}

function updateHealthStatus(text, ready) {
  const dot = $("#settings-health-dot");
  const label = $("#settings-health-text");
  if (dot) dot.classList.toggle("ready", ready);
  if (label) label.textContent = text;
  const apiButton = $("#settings-api-button");
  if (apiButton) apiButton.title = `API 设置：${text}`;
}

// —— API 密钥的两处保管位置 ——
// 主存储在服务端：data/local_api_config.json，DPAPI 加密（Windows 绑定当前账户），
// 重启服务后由 config.load_settings() 读回来，不用再粘一次。
// 这里是并行的第二份兜底：换浏览器、无痕窗口、或服务端那次保存没落成时靠它恢复，
// 每次加载页面用 /api/config/session 把内存补上（不回写凭据文件）。
const API_CREDENTIAL_STORAGE_KEY = "knoworigin-api-credentials-v1";

function readStoredCredentials() {
  try {
    const raw = JSON.parse(localStorage.getItem(API_CREDENTIAL_STORAGE_KEY) || "{}");
    if (!raw || typeof raw !== "object") return { api_key: "", vision_api_key: "" };
    return {
      api_key: typeof raw.api_key === "string" ? raw.api_key : "",
      vision_api_key: typeof raw.vision_api_key === "string" ? raw.vision_api_key : "",
    };
  } catch {
    return { api_key: "", vision_api_key: "" };
  }
}

// 字段传 undefined = 保持原值；传空串 = 显式清空。两项都空时整条记录删掉，
// 不留一个空壳对象在存储里假装「配置过」。
function writeStoredCredentials(next = {}) {
  const current = readStoredCredentials();
  const merged = {
    api_key: (next.api_key === undefined ? current.api_key : next.api_key) || "",
    vision_api_key: (next.vision_api_key === undefined ? current.vision_api_key : next.vision_api_key) || "",
  };
  try {
    if (!merged.api_key && !merged.vision_api_key) {
      localStorage.removeItem(API_CREDENTIAL_STORAGE_KEY);
    } else {
      localStorage.setItem(API_CREDENTIAL_STORAGE_KEY, JSON.stringify(merged));
    }
  } catch { /* 隐私模式 / 存储被禁用：降级为「本次会话内有效」 */ }
  return merged;
}

// 把浏览器保管的密钥下发给本机服务内存（服务端不回写凭据文件）。
// 失败不能只试一次就放弃：页面刚加载、服务刚重启的那一瞬最容易断，
// 而「同步没成」对用户的表现就是密钥又要重填一遍 —— 所以这里退避重试两次，
// 全失败才静默（那由健康状态如实反映成「本地模式」，用户看得到）。
async function syncStoredCredentials(attempt = 0) {
  const stored = readStoredCredentials();
  if (!stored.api_key && !stored.vision_api_key) return;
  try {
    await api("/api/config/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(stored),
    });
  } catch (error) {
    if (attempt >= 2) return;
    await new Promise((resolve) => window.setTimeout(resolve, 400 * (attempt + 1)));
    return syncStoredCredentials(attempt + 1);
  }
}

// 密钥框右侧的「小眼睛」：把 input.type 在 password / text 之间切。
// 状态只有一个来源 —— 按钮的 aria-pressed；图标由 CSS 依据它切换，
// 免得图标显示的和输入框实际的状态各说各话。
function bindSecretToggles() {
  $$("[data-secret-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = document.getElementById(button.dataset.secretToggle);
      if (!input) return;
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      button.setAttribute("aria-pressed", String(show));
      const text = show ? "隐藏密钥" : "显示密钥";
      button.setAttribute("aria-label", text);
      button.title = text;
    });
  });
}

// 远程访问时输入框是禁用的，眼睛也要一起禁用，别留个能点但没用的按钮。
function setSecretTogglesDisabled(disabled) {
  $$("[data-secret-toggle]").forEach((button) => { button.disabled = !!disabled; });
}

async function openApiConfig() {
  const dialog = $("#api-config-dialog");
  const feedback = $("#api-config-feedback");
  feedback.textContent = "正在读取本机配置…";
  feedback.className = "config-feedback";
  if (!dialog.open) dialog.showModal();
  try {
    const config = await api("/api/config");
    state.apiConfig = config;
    $("#api-base-url").value = config.base_url || "";
    $("#api-model").value = config.model || "";
    $("#api-vision-model").value = config.vision_model || "";
    $("#api-vision-base-url").value = config.vision_base_url || "";
    // 密钥由本浏览器保管：读出来直接回填，用户能看见自己存的到底是什么。
    // （上一版漏了这一行定义，打开面板就报 `stored is not defined`。）
    const stored = readStoredCredentials();
    $("#api-key").value = stored.api_key;
    $("#api-vision-key").value = stored.vision_api_key;
    const visionKeyHelp = $("#api-vision-key-help");
    if (visionKeyHelp) {
      visionKeyHelp.textContent = stored.vision_api_key
        ? "视觉模型密钥已保存。输入新密钥可替换，留空则保持不变。"
        : config.vision_key_configured
          ? "本机已有一把视觉模型密钥（来自环境变量或本机凭据文件）。重新粘贴一次并保存，即可改为在这里管理。"
          : "留空则使用上面的 API 密钥；仅当视觉模型走不同服务商时才需要单独填写。";
    }
    const inputs = $$("#api-config-form input");
    const canEdit = !!config.local_editable;
    inputs.forEach((input) => { input.disabled = !canEdit; });
    setSecretTogglesDisabled(!canEdit);
    $("#save-api-config").disabled = !canEdit;
    if (!config.local_editable) {
      feedback.textContent = "当前为远程访问，配置只允许在运行服务的本机修改。";
    } else if (stored.api_key) {
      feedback.textContent = "密钥已保存在本机 data/（加密）与本浏览器，换浏览器或重启服务都不用重填。输入新密钥可替换，留空则保持不变。";
    } else if (config.model_configured) {
      feedback.textContent = "本机已配好一把密钥（来自环境变量或本机凭据文件），直接用即可；要换成新密钥，粘贴后保存。";
    } else {
      feedback.textContent = "还没有配置 API Key。请到 ai.tju.edu.cn 个人中心获取你自己的一把密钥，粘贴到上面后保存——它会加密存在这台机器上，重启服务不用再填，也不会进入仓库。";
    }
  } catch (error) {
    feedback.textContent = error.message;
    feedback.classList.add("is-error");
  }
}

async function saveApiConfig(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const feedback = $("#api-config-feedback");
  const button = $("#save-api-config");
  if (!form.reportValidity()) return;
  const baseUrl = $("#api-base-url").value.trim();
  const model = $("#api-model").value.trim();
  const apiKey = $("#api-key").value.trim();
  const visionModel = $("#api-vision-model").value.trim();
  const visionBaseUrl = $("#api-vision-base-url").value.trim();
  const visionKey = $("#api-vision-key").value.trim();
  try {
    assertHttpsEndpoint(baseUrl, "API 地址");
    if (visionBaseUrl) assertHttpsEndpoint(visionBaseUrl, "视觉模型服务地址");
    if (apiKey && apiKey.length < 8) throw new Error("API 密钥至少需要 8 个字符。");
    if (visionKey && visionKey.length < 8) throw new Error("视觉模型 API 密钥至少需要 8 个字符。");
  } catch (error) {
    feedback.textContent = error.message;
    feedback.className = "config-feedback is-error";
    return;
  }

  button.disabled = true;
  feedback.textContent = "正在验证并保存…";
  feedback.className = "config-feedback";
  // 先写浏览器，再通知服务端 —— 顺序反过来的话，服务端这次没接受（重启中、
  // 被远程访问限制、网络抖一下）就等于这串密钥白填了，用户得再粘一遍。
  // 密钥的合法性（长度、HTTPS 端点、模型名）上面已经逐条校验过，服务端 422 的
  // 那几种情形都被前端挡在前面，所以这里乐观写入不会留下垃圾。
  const stored = writeStoredCredentials({
    api_key: apiKey || undefined,
    vision_api_key: visionKey || undefined,
  });
  $("#api-key").value = stored.api_key;
  $("#api-vision-key").value = stored.vision_api_key;
  try {
    const payload = {
      base_url: baseUrl,
      model,
      vision_model: visionModel,
      vision_base_url: visionBaseUrl,
    };
    if (apiKey) payload.api_key = apiKey;
    if (visionKey) payload.vision_api_key = visionKey;
    const saved = await api("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    state.apiConfig = { ...saved, local_editable: true };
    updateHealthStatus(saved.model_configured ? "AI 服务已配置" : "本地模式 · 点此填入自己的 API Key", true);
    feedback.textContent = saved.message;
    feedback.className = "config-feedback is-success";
  } catch (error) {
    feedback.textContent = `${error.message}（密钥已存在本浏览器，关掉服务重开就会自动带上，不用再填一次）`;
    feedback.className = "config-feedback is-error";
  } finally {
    button.disabled = false;
  }
}

function assertHttpsEndpoint(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`请输入完整、有效的${label}。`);
  }
  const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && localHost)) {
    throw new Error(`${label}必须使用 HTTPS；仅本机地址可使用 HTTP。`);
  }
}

async function loadProjects() {
  // 刷新后优先回到**上次看的那个**项目，不是 projects[0]（= 最新建的）。
  // 选错项目等于对话历史整个不加载 —— 过程条、回答依据会一起「消失」，
  // 用户看到的就是「依据没保存」。记忆值必须在任何 selectProject 之前读，
  // 因为 selectProject 自己会把它改写成当前项目。
  const remembered = rememberedProjectId();
  try {
    const data = await api("/api/projects");
    state.projects = Array.isArray(data?.projects) ? data.projects : [];
    renderProjectSelect();
    const rememberedExists = remembered
      && state.projects.some((item) => item.project_id === remembered);
    const target = state.currentProjectId && state.projects.some((i) => i.project_id === state.currentProjectId)
      ? state.currentProjectId
      : (rememberedExists ? remembered : (state.projects[0]?.project_id || ""));
    if (target) {
      await selectProject(target);
    } else {
      resetProjectView();
      // 自动弹「新建项目」只在用户**还停在工作台**时做。登录后这一步要等
      // /api/projects 回来才跑到，而用户在这段空档里可能已经先进了文章阅读 / 读书
      // （#workspace 被那两个视图隐藏）。此时 showModal 会把「建立独立项目」
      // 硬怼在阅读界面正中间 —— 和「阅读模式里冒出登录界面」是同一个时序病。
      // 用户回到工作台后，顶部「新建项目」与侧栏入口都还在，随时能建。
      const workspace = document.getElementById("workspace");
      if (workspace && isTopLevelViewVisible(workspace)) $("#project-dialog").showModal();
    }
  } catch (error) { showError(error, loadProjects); }
}

// 「文章阅读」里导入论文会新建项目、删除论文会移除项目，而主界面顶部的项目下拉是登录
// 那一刻拉取的 /api/projects 快照，不会自己更新。这里做一次「静默同步」：重拉项目列表、
// 重绘下拉；如果这次同步**多出了新项目**（导入论文 / 建对比项目），就直接切过去 ——
// 这正是刷新页面本来就有的效果（刷新后 loadProjects() 会选 projects[0]，而后端
// db.list_projects 是 ORDER BY created_at DESC，第一个就是最新建的项目）。
// 不切的话，用户回到主界面看到的仍是上一个项目，会以为"刚导入的论文没进来"。
// 触发点：literature.js 广播的 knoworigin:projects-changed / 退出文章阅读兜底 /
// 展开项目下拉（覆盖所有创建路径）。
async function syncProjectListSilently(retry = false) {
  if (!state.authenticated || state.projectsSyncInFlight) return;
  state.projectsSyncInFlight = true;
  try {
    const data = await api("/api/projects");
    const projects = data.projects || [];
    const idsOf = (list) => list.map((item) => item.project_id).join("|");
    const changed = idsOf(projects) !== idsOf(state.projects);
    const beforeIds = new Set(state.projects.map((item) => item.project_id));
    // 后端按 created_at DESC 排序，所以新增那批里的第一个就是最新建的项目
    const added = projects.filter((item) => !beforeIds.has(item.project_id));
    state.projects = projects;
    renderProjectSelect();
    if (!changed) return;
    try {
      console.info("[KnowOrigin] 项目列表已同步", { added: added.length, total: projects.length });
    } catch (_) { /* 忽略 */ }
    if (added.length) {
      // 刚在「文章阅读」里新建的项目：切过去，让用户回到主界面就能看到它（见上方注释）
      const dialog = $("#project-dialog");
      if (dialog && dialog.open) dialog.close();
      await selectProject(added[0].project_id);
      if (typeof showToast === "function") {
        showToast(`已切换到刚导入的项目「${projectLabel(added[0])}」`, "ok");
      }
      return;
    }
    // 当前选中的项目被删掉了（例如在文章阅读里删除了一篇论文）：回落到第一个项目或空态
    if (state.currentProjectId && !projects.some((item) => item.project_id === state.currentProjectId)) {
      if (projects.length) await selectProject(projects[0].project_id);
      else resetProjectView();
    }
  } catch (error) {
    // 静默同步：失败不打断用户（他什么都没操作，不该看到报错），保持现有列表即可。
    // 但导入刚结束时后端可能还在忙（AI 整理排版占着事件循环），一次失败就放弃会让用户
    // 回到主界面仍看到旧项目 —— 延迟重试一次，仍失败才作罢（retry 标记，不会循环）。
    if (!retry) {
      window.setTimeout(() => syncProjectListSilently(true), 1500);
    }
  } finally {
    state.projectsSyncInFlight = false;
  }
}

function renderProjectSelect() {
  const list = $("#project-list");
  const button = $("#project-menu-button");
  list.innerHTML = "";
  button.disabled = state.projects.length === 0;
  button.setAttribute(
    "aria-label",
    state.projects.length ? `切换项目，当前项目：${projectLabel(currentProject() || state.projects[0])}` : "暂无可切换项目",
  );
  state.projects.forEach((project) => {
    const isActive = project.project_id === state.currentProjectId;
    const item = document.createElement("div");
    item.className = `project-list-item${isActive ? " project-list-item-active" : ""}`;
    item.dataset.projectId = project.project_id;
    item.tabIndex = 0;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", isActive ? "true" : "false");
    item.innerHTML = `<span class="project-list-label">${escapeHtml(projectLabel(project))}</span><button class="project-list-delete" type="button" data-project-id="${escapeAttr(project.project_id)}" aria-label="删除项目：${escapeAttr(projectLabel(project))}" title="删除"><span aria-hidden="true">×</span></button>`;
    list.append(item);
  });
  if (!state.projects.length) setProjectMenuOpen(false);
}

function currentProject() {
  return state.projects.find((project) => project.project_id === state.currentProjectId) || null;
}

function toggleProjectMenu(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!state.projects.length) return;
  const willOpen = $("#project-menu-button").getAttribute("aria-expanded") !== "true";
  setProjectMenuOpen(willOpen);
  // 展开下拉时静默对一次列表：项目可能是在别处建的（文章阅读里导入论文、建对比项目），
  // 主界面这份快照不一定最新（见 syncProjectListSilently）。这里覆盖所有创建路径。
  if (willOpen) syncProjectListSilently();
}

function setProjectMenuOpen(isOpen) {
  const button = $("#project-menu-button");
  const list = $("#project-list");
  button.setAttribute("aria-expanded", isOpen ? "true" : "false");
  list.classList.toggle("hidden", !isOpen);
}

function closeProjectMenuFromOutside(event) {
  if (event.target.closest(".project-title-switcher")) return;
  setProjectMenuOpen(false);
}

function handleProjectMenuButtonKeydown(event) {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (!state.projects.length) return;
    setProjectMenuOpen(true);
    focusProjectMenuItem();
  } else if (event.key === "Escape") {
    setProjectMenuOpen(false);
  }
}

function handleProjectMenuKeydown(event) {
  const item = event.target.closest(".project-list-item");
  if (!item) return;
  if (event.key === "Escape") {
    event.preventDefault();
    setProjectMenuOpen(false);
    $("#project-menu-button").focus();
  } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    focusProjectMenuItem(item, event.key);
  } else if (["Enter", " "].includes(event.key)) {
    event.preventDefault();
    selectProject(item.dataset.projectId);
    setProjectMenuOpen(false);
  }
}

function focusProjectMenuItem(currentItem = null, key = "") {
  const items = $$(".project-title-menu .project-list-item");
  if (!items.length) return;
  const active = $(".project-title-menu .project-list-item-active");
  let index = Math.max(0, items.indexOf(currentItem || active));
  if (key === "ArrowDown") index = Math.min(items.length - 1, index + 1);
  if (key === "ArrowUp") index = Math.max(0, index - 1);
  if (key === "Home") index = 0;
  if (key === "End") index = items.length - 1;
  items[index].focus();
}

async function createProject(event) {
  event.preventDefault();
  const term = $("#project-term").value.trim();
  const subject = $("#project-subject").value.trim();
  if (!subject) return;
  const btn = $("#project-form").querySelector('button[type="submit"]');
  const original = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.classList.add("is-loading");
    btn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span> 创建中…';
  }
  try {
    const project = await api("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ year: term, subject }),
    });
    state.projects.unshift(project);
    state.currentProjectId = project.project_id;
    renderProjectSelect();
    $("#project-dialog").close();
    $("#project-form").reset();
    await selectProject(project.project_id);
  } catch (error) {
    showError(error);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("is-loading");
      btn.innerHTML = original;
    }
  }
}

function openProjectDeleteDialog(event) {
  event?.preventDefault();
  const projectId = event?.target?.dataset?.projectId || state.projectPendingDeleteId || state.currentProjectId;
  if (!projectId) return;
  const project = state.projects.find((item) => item.project_id === projectId);
  if (!project) return;
  state.projectPendingDeleteId = projectId;
  $("#delete-project-name").textContent = projectLabel(project);
  const dialog = $("#delete-project-dialog");
  if (!dialog.open) dialog.showModal();
}

function handleProjectListClick(event) {
  const deleteBtn = event.target.closest(".project-list-delete");
  if (deleteBtn) {
    event.stopPropagation();
    state.projectPendingDeleteId = deleteBtn.dataset.projectId;
    setProjectMenuOpen(false);
    openProjectDeleteDialog(event);
    return;
  }
  const item = event.target.closest(".project-list-item");
  if (item && item.dataset.projectId) {
    selectProject(item.dataset.projectId);
    setProjectMenuOpen(false);
  }
}

function handleProjectListContext(event) {
  const deleteBtn = event.target.closest(".project-list-delete");
  if (deleteBtn) return;
  const item = event.target.closest(".project-list-item");
  if (item && item.dataset.projectId) {
    state.projectPendingDeleteId = item.dataset.projectId;
    setProjectMenuOpen(false);
    openProjectDeleteDialog(event);
  }
}

async function deleteProject(event) {
  event.preventDefault();
  const projectId = state.projectPendingDeleteId;
  if (!projectId) return;
  const deletedIndex = state.projects.findIndex((item) => item.project_id === projectId);
  const button = $("#confirm-delete-project");
  button.disabled = true;
  try {
    await api(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
    state.projects = state.projects.filter((item) => item.project_id !== projectId);
    $("#delete-project-dialog").close();
    renderProjectSelect();
    if (state.currentProjectId === projectId) {
      const nextIndex = Math.min(Math.max(deletedIndex, 0), state.projects.length - 1);
      const nextProject = state.projects[nextIndex];
      if (nextProject) await selectProject(nextProject.project_id);
      else resetProjectView();
    }
  } catch (error) {
    showError(error, () => deleteProject(event));
  } finally {
    button.disabled = false;
  }
}

function resetProjectDeleteDialog() {
  state.projectPendingDeleteId = "";
  $("#delete-project-name").textContent = "";
  $("#confirm-delete-project").disabled = false;
}

function projectLabel(project) {
  const year = (project.year || "").trim();
  return year ? `${year} · ${project.subject}` : project.subject;
}

function selectFiles(event) {
  const files = [...(event.target.files || [])];
  event.target.value = "";
  if (!files.length) return;
  uploadFiles(files);
}

async function uploadFiles(files) {
  const usableFiles = files.filter((file) => file && file.size > 0);
  if (!usableFiles.length) return;
  if (!state.currentProjectId) return requireProject(() => {});
  const projectId = state.currentProjectId;
  const requestId = state.sourceImportRequestId + 1;
  state.sourceImportRequestId = requestId;
  startSourceImportProgress(usableFiles, projectId, requestId);
  setSourceUploadBusy(true);
  try {
    const form = new FormData();
    usableFiles.forEach((file) => form.append("files", file, file.name));
    const data = await api(`/api/projects/${encodeURIComponent(projectId)}/sources`, {
      method: "POST",
      body: form,
    });
    if (state.currentProjectId !== projectId || state.sourceImportRequestId !== requestId) return;
    const savedSources = (data.sources || []).filter((source) => source.source_id);
    state.sources = [...savedSources, ...state.sources.filter((source) => !savedSources.some((item) => item.source_id === source.source_id))];
    savedSources
      .filter((source) => source.status === "ok")
      .forEach((source) => state.selectedSourceIds.add(source.source_id));
    const sourceOutcomes = new Map();
    (data.sources || []).forEach((source) => {
      const filename = source.filename || "";
      if (!sourceOutcomes.has(filename)) sourceOutcomes.set(filename, []);
      sourceOutcomes.get(filename).push(source);
    });
    const failedSources = (data.sources || []).filter((source) => !source.source_id);
    state.pendingFiles = usableFiles.map((file) => {
      const outcomes = sourceOutcomes.get(file.name) || [];
      const outcome = outcomes.shift() || null;
      if (outcome) sourceOutcomes.set(file.name, outcomes);
      if (outcome && !outcome.source_id) {
        const status = sourceStatus(outcome);
        return {
          name: outcome.filename || file.name,
          size: outcome.size_bytes || file.size,
          status: status.label,
          error: true,
          progress: 100,
          progressLabel: "导入失败",
          progressDetail: outcome.error_message || status.label,
        };
      }
      return {
        name: file.name,
        size: file.size,
        status: "已导入",
        progress: 100,
        ocr: Boolean(outcome?.ocr_used),
        progressLabel: "导入完成",
        progressDetail: outcome?.ocr_used
          ? "扫描件已通过 OCR 识别并保存，识别内容可能存在误差，建议结合原文件核对。"
          : "材料已保存到当前项目。",
      };
    });
    renderSources();
    finishSourceImportProgress(projectId, requestId, savedSources.length, failedSources.length);
    updateMappingHint();
  } catch (error) {
    if (state.currentProjectId !== projectId || state.sourceImportRequestId !== requestId) return;
    state.pendingFiles = usableFiles.map((file) => ({
      name: file.name,
      size: file.size,
      status: "上传失败",
      error: true,
      progress: 100,
      progressLabel: "导入失败",
      progressDetail: error.message || "请稍后重试。",
    }));
    failSourceImportProgress(error, projectId, requestId);
    showError(error, () => uploadFiles(usableFiles));
  } finally {
    if (state.currentProjectId === projectId && state.sourceImportRequestId === requestId) {
      setSourceUploadBusy(false);
    }
  }
}

async function uploadPastedText(event) {
  event.preventDefault();
  if (!state.currentProjectId) return requireProject(() => {});
  const textarea = $("#pasted-text");
  const pastedText = textarea.value.trim();
  if (!pastedText) return showError(new Error("请先粘贴项目文本。"));
  const projectId = state.currentProjectId;
  const requestId = state.sourceImportRequestId + 1;
  state.sourceImportRequestId = requestId;
  const pastedItem = { name: "粘贴文本", size: new Blob([pastedText]).size };
  startSourceImportProgress([pastedItem], projectId, requestId);
  const button = event.submitter || $("#paste-form button[type='submit']");
  button.disabled = true;
  try {
    const form = new FormData();
    form.append("pasted_text", pastedText);
    const data = await api(`/api/projects/${encodeURIComponent(projectId)}/sources`, {
      method: "POST",
      body: form,
    });
    if (state.currentProjectId !== projectId || state.sourceImportRequestId !== requestId) return;
    const savedSources = (data.sources || []).filter((source) => source.source_id);
    state.sources = [...savedSources, ...state.sources.filter((source) => !savedSources.some((item) => item.source_id === source.source_id))];
    savedSources
      .filter((source) => source.status === "ok")
      .forEach((source) => state.selectedSourceIds.add(source.source_id));
    state.pendingFiles = [{
      name: pastedItem.name,
      size: pastedItem.size,
      status: "已导入",
      progress: 100,
      progressLabel: "导入完成",
      progressDetail: "文本已保存到当前项目。",
    }];
    $("#paste-dialog").close();
    $("#paste-form").reset();
    renderSources();
    finishSourceImportProgress(projectId, requestId, savedSources.length, 0);
    updateMappingHint();
  } catch (error) {
    if (state.currentProjectId !== projectId || state.sourceImportRequestId !== requestId) return;
    state.pendingFiles = [{
      name: pastedItem.name,
      size: pastedItem.size,
      status: "上传失败",
      error: true,
      progress: 100,
      progressLabel: "导入失败",
      progressDetail: error.message || "请稍后重试。",
    }];
    failSourceImportProgress(error, projectId, requestId);
    showError(error, () => uploadPastedText(event));
  } finally {
    if (state.currentProjectId === projectId && state.sourceImportRequestId === requestId) {
      button.disabled = false;
    }
  }
}

function renderPendingFiles() {
  const container = $("#pending-files");
  if (!container) return;
  container.innerHTML = "";
  const currentFile = state.sourceImportProgress?.currentFile || "";
  if (state.sourceImportProgress) container.append(sourceImportProgressElement(state.sourceImportProgress));
  if (!state.pendingFiles.length) return;
  state.pendingFiles.forEach((file) => {
    const item = document.createElement("div");
    item.className = `pending-file${file.error ? " pending-file-error" : ""}${file.name === currentFile ? " is-current" : ""}`;
    const meta = `${formatBytes(file.size)} · ${file.status || "等待上传"}${file.ocr ? " · 扫描件" : ""}`;
    item.innerHTML = fileRowMarkup(
      file.name,
      meta,
      extensionLabel(file.name),
      { error: file.error },
    ) + pendingFileProgressMarkup(file);
    container.append(item);
  });
}

function sourceImportProgressElement(progress) {
  const item = document.createElement("section");
  const percent = clamp(Math.round(Number(progress.percent) || 0), 0, 100);
  const activeIndex = progress.status === "complete" || progress.status === "warning"
    ? SOURCE_IMPORT_STAGE_COUNT
    : progress.stageIndex;
  const elapsed = progress.elapsedSeconds >= 3 ? `<span>已用 ${progress.elapsedSeconds}s</span>` : "";
  const trackClass = progress.indeterminate && progress.status === "active"
    ? " source-import-progress-track is-indeterminate"
    : "";
  const scanNote = progress.scanNote
    ? `<p class="source-import-scan-note">${escapeHtml(progress.scanNote)}</p>`
    : "";
  const currentFile = progress.currentFile
    ? `<span class="source-import-current-file" title="${escapeAttr(progress.currentFile)}">当前：${escapeHtml(progress.currentFile)}</span>`
    : "";
  item.className = `source-import-progress is-${escapeAttr(progress.status || "active")}`;
  item.setAttribute("role", "status");
  item.setAttribute("aria-live", "polite");
  item.innerHTML = `
    <div class="source-import-progress-heading">
      <strong>${escapeHtml(progress.label || "正在导入材料")}</strong>
      <span>${percent}%</span>
    </div>
    <div class="source-import-progress-track${trackClass}" aria-hidden="true"><i style="width:${percent}%"></i></div>
    <p>${escapeHtml(progress.detail || "正在处理项目材料。")}</p>
    ${scanNote}
    <div class="source-import-progress-foot">
      <span>${progress.fileCount || 1} 个材料${progress.ocrTotal ? ` · 扫描件 ${progress.ocrDone}/${progress.ocrTotal}` : ""}</span>
      ${elapsed}
    </div>
    ${currentFile}
    <ol class="source-import-stages" aria-label="导入进度阶段">
      ${SOURCE_IMPORT_STAGE_LABELS.map((label, index) => `<li class="${index < activeIndex ? "is-done" : index === activeIndex ? "is-active" : ""}">${label}</li>`).join("")}
    </ol>
  `;
  return item;
}

function pendingFileProgressMarkup(file) {
  if (file.ocr && !file.error && state.sourceImportProgress?.status === "active") {
    const detail = file.progressDetail ? `<p>${escapeHtml(file.progressDetail)}</p>` : "";
    return `
      <div class="pending-file-progress-wrap">
        <div class="pending-file-progress-head">
          <span>${escapeHtml(file.progressLabel || "OCR 识别中")}</span>
        </div>
        <div class="pending-file-progress is-indeterminate" aria-hidden="true"><i></i></div>
        ${detail}
      </div>
    `;
  }
  if (!file.error) return "";
  if (!Number.isFinite(Number(file.progress))) return "";
  const percent = clamp(Math.round(Number(file.progress)), 0, 100);
  const detail = file.progressDetail ? `<p>${escapeHtml(file.progressDetail)}</p>` : "";
  return `
    <div class="pending-file-progress-wrap">
      <div class="pending-file-progress-head">
        <span>${escapeHtml(file.progressLabel || file.status || "处理中")}</span>
        <strong>${percent}%</strong>
      </div>
      <div class="pending-file-progress" aria-hidden="true"><i style="width:${percent}%"></i></div>
      ${detail}
    </div>
  `;
}

function renderSources() {
  $("#source-count").textContent = state.sources.length;
  const container = $("#source-list");
  container.innerHTML = "";
  container.classList.toggle("empty-state", state.sources.length === 0);
  pruneSourceDeleteSelection();
  if (!state.sources.length) {
    container.innerHTML = "<p>这里会显示当前项目的来源。</p>";
    return;
  }
  container.append(sourceSelectionToolbar());
  state.sources.forEach((source) => container.append(sourceRow(source)));
}

function sourceSelectionToolbar() {
  const selectable = selectableSources();
  const selectedCount = selectable.filter((source) => state.selectedSourceIds.has(source.source_id)).length;
  const deleteCount = state.sourceDeleteSelectionIds.size;
  const wrapper = document.createElement("div");
  wrapper.className = "selection-toolbar";
  const allChecked = selectable.length > 0 && selectedCount === selectable.length;
  wrapper.innerHTML = `
    <label><input type="checkbox" data-source-select="all" ${allChecked ? "checked" : ""} ${selectable.length ? "" : "disabled"}><span>全选来源</span></label>
    <span class="selection-toolbar-meta">
      <small>${selectedCount}/${selectable.length} 已选</small>
      ${deleteCount ? `<button class="source-bulk-delete danger" type="button" data-source-delete-action="delete-selected" ${state.deletingSources ? "disabled" : ""}>删除选中 ${deleteCount}</button>` : ""}
    </span>`;
  return wrapper;
}

function sourceRow(source) {
  const status = sourceStatus(source);
  const selectable = status.label === "已解析" && sourceHasUsableContent(source);
  const selected = state.selectedSourceIds.has(source.source_id);
  const deleteSelected = state.sourceDeleteSelectionIds.has(source.source_id);
  const item = document.createElement("article");
  item.className = `source-item source-preview-trigger${selected ? " is-selected" : ""}${deleteSelected ? " is-delete-selected" : ""}`;
  item.dataset.sourceId = source.source_id;
  item.tabIndex = 0;
  item.setAttribute("aria-label", deleteSelected ? `已加入待删除：${source.filename}` : `预览来源：${source.filename}`);
  const metaText = status.detail
    ? `${formatBytes(source.size_bytes)} · ${status.label}`
    : `${formatBytes(source.size_bytes)} · ${status.label}`;
  const metaTitle = status.detail ? status.detail : "";
  item.innerHTML = fileRowMarkup(
    source.filename,
    metaText,
    extensionLabel(source.filename),
    {
      sourceId: source.source_id,
      selectable,
      selected,
      error: status.error,
      errorTitle: metaTitle,
      externalLinks: source.external_links || [],
    },
  );
  return item;
}

function fileRowMarkup(name, meta, icon, { sourceId = "", selectable = false, selected = false, error = false, errorTitle = "", externalLinks = [] } = {}) {
  const typeClass = `file-type-${escapeAttr(String(icon).toLowerCase())}`;
  const checkbox = sourceId && selectable
    ? `<label class="file-check" title="用于对话和测验"><input type="checkbox" data-source-select data-source-id="${escapeAttr(sourceId)}" ${selected ? "checked" : ""}><span class="checkmark"></span></label>`
    : "";
  const deleteButton = sourceId
    ? `<button class="file-action file-delete-action danger" type="button" data-file-action="delete" data-source-id="${escapeAttr(sourceId)}" aria-label="删除来源：${escapeAttr(name)}">×</button>`
    : "";

  // 外链按钮：README 里的外部资料站链接，点击新开标签页
  let externalButton = "";
  if (externalLinks.length > 0) {
    const link = externalLinks[0]; // 取第一条；多条时后续可扩展为下拉菜单
    externalButton = `<a class="file-action file-external-link" href="${escapeAttr(link.url)}" target="_blank" rel="noopener noreferrer" title="${escapeAttr(link.title)} — 外部资料站（新标签页打开）" aria-label="外部链接：${escapeAttr(link.title)}">↗</a>`;
  }

  const controls = checkbox || deleteButton || externalButton
    ? `<span class="file-row-controls">${checkbox}${externalButton}${deleteButton}</span>`
    : "";
  return `<div class="file-name-row"><span class="file-type-chip ${typeClass}">${escapeHtml(icon)}</span><span class="file-copy"><span class="file-title-row"><span class="file-name">${escapeHtml(name)}</span></span><span class="file-meta-row"><span class="file-meta${error ? " error" : ""}"${errorTitle ? ` title="${escapeAttr(errorTitle)}"` : ""}>${escapeHtml(meta)}</span></span></span>${controls}</div>`;
}

function selectableSources() {
  return state.sources.filter((source) => source.status === "ok" && sourceHasUsableContent(source));
}

function sourceHasUsableContent(source) {
  return Boolean(String(source?.text || "").trim() || (Array.isArray(source?.formulas) && source.formulas.length));
}

function pruneSourceDeleteSelection() {
  const currentIds = new Set(state.sources.map((source) => source.source_id));
  [...state.sourceDeleteSelectionIds].forEach((sourceId) => {
    if (!currentIds.has(sourceId)) state.sourceDeleteSelectionIds.delete(sourceId);
  });
}

function toggleSourceDeleteSelection(sourceId) {
  if (!sourceId) return;
  if (state.sourceDeleteSelectionIds.has(sourceId)) {
    state.sourceDeleteSelectionIds.delete(sourceId);
  } else {
    state.sourceDeleteSelectionIds.add(sourceId);
  }
  renderSources();
}

function toggleSourceSelection(sourceId, checked) {
  if (sourceId === "all") {
    const selectable = selectableSources();
    state.selectedSourceIds = checked ? new Set(selectable.map((source) => source.source_id)) : new Set();
  } else if (checked) {
    state.selectedSourceIds.add(sourceId);
  } else {
    state.selectedSourceIds.delete(sourceId);
  }
  renderSources();
  updateMappingHint();
}

async function deleteSource(source) {
  if (!source?.source_id || !state.currentProjectId) return;
  const confirmed = window.confirm(`删除来源“${source.filename || source.source_id}”？`);
  if (!confirmed) return;
  try {
    await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/sources/${encodeURIComponent(source.source_id)}`, {
      method: "DELETE",
    });
    state.sources = state.sources.filter((item) => item.source_id !== source.source_id);
    state.selectedSourceIds.delete(source.source_id);
    state.sourceDeleteSelectionIds.delete(source.source_id);
    renderSources();
    updateMappingHint();
  } catch (error) {
    showError(error, () => deleteSource(source));
  }
}

async function deleteSelectedSources() {
  if (!state.currentProjectId || state.deletingSources) return;
  const sources = state.sources.filter((source) => state.sourceDeleteSelectionIds.has(source.source_id));
  if (!sources.length) return;
  const names = sources.slice(0, 3).map((source) => source.filename || source.source_id).join("、");
  const suffix = sources.length > 3 ? `等 ${sources.length} 份来源` : `${sources.length} 份来源`;
  const confirmed = window.confirm(`删除已选的 ${suffix}？\n${names}\n删除后可按 Ctrl+Z 撤销。`);
  if (!confirmed) return;

  state.deletingSources = true;
  renderSources();
  try {
    const results = await Promise.allSettled(sources.map((source) => (
      api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/sources/${encodeURIComponent(source.source_id)}`, {
        method: "DELETE",
      }).then(() => source)
    )));
    const deletedIds = new Set(results
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value.source_id));
    if (deletedIds.size) {
      state.sources = state.sources.filter((source) => !deletedIds.has(source.source_id));
      deletedIds.forEach((sourceId) => {
        state.selectedSourceIds.delete(sourceId);
        state.sourceDeleteSelectionIds.delete(sourceId);
      });
      updateMappingHint();
    }
    const failedCount = results.length - deletedIds.size;
    if (failedCount) {
      const firstFailure = results.find((result) => result.status === "rejected")?.reason;
      showError(new Error(`${failedCount} 份来源删除失败：${firstFailure?.message || "请重试"}`), deleteSelectedSources);
    } else {
      showNotice(`已删除 ${deletedIds.size} 份来源。`);
    }
  } finally {
    state.deletingSources = false;
    renderSources();
  }
}

async function selectProject(projectId) {
  if (!projectId) return resetProjectView();
  if (state.currentProjectId !== projectId) {
    kbResetWorkspace();
    state.sourceImportRequestId += 1;
    clearSourceImportProgress();
  }
  try {
    const data = await api(`/api/projects/${encodeURIComponent(projectId)}`);
    // 单个字段不对最多是空态，不能整屏崩 —— 这里统一兜底
    const payload = data && typeof data === "object" ? data : {};
    state.currentProjectId = projectId;
    rememberProjectId(projectId);
    // 从 localStorage 恢复文本高亮（存在本页/会话刷新都会丢，所以读取失败不能抛）
    state.textHighlights = loadTextHighlights(projectId) || {};
    clearSourceImportProgress({ render: false });
    $("#paste-form button[type='submit']").disabled = false;
    state.sources   = Array.isArray(payload.sources)   ? payload.sources   : [];
    state.nodes     = Array.isArray(payload.nodes)     ? payload.nodes     : [];
    state.kbLinkNotes = kbLinkNotesFromPayload(payload.link_notes);
    state.favorites = Array.isArray(payload.favorites) ? payload.favorites : [];
    state.editingFavoriteId = "";
    state.favoriteQuery = "";
    hideUndoNotice();
    state.cards = Array.isArray(payload.cards) ? payload.cards : [];
    state.quiz  = payload.quiz || null;
    // 如果当前没有可用来源，清空残留的卡片和测验数据，避免无资料时仍显示旧内容
    if (selectableSources().length === 0) {
      state.cards = [];
      state.quiz = null;
    }
    state.quizHistory = null;          // 切换项目后历史记录失效
    state.viewingHistoryQuiz = null;
    state.cardSelfRateState = {};
    state.openCardIds = new Set();
    state.cardAnswerOpenIds = new Set();
    state.quizDraftAnswers = {};
    state.masteryRules = payload.mastery_rules || null;
    state.masteryBreakdown = null;
    // 默认选中所有可用来源
    state.selectedSourceIds = new Set(selectableSources().map((source) => source.source_id));
    state.sourceDeleteSelectionIds = new Set();
    clearProblemImage();
    // 掌握度透明化：每次切换到项目就异步拉一次；失败不阻塞主流程
    state.masteryRules = null;
    state.masteryBreakdown = null;
    refreshMasteryBreakdown().catch((e) => console.warn("[mastery] 首次加载失败", e));
    renderProjectSelect();
    $("#agent-title").textContent = projectLabel(payload.project);
    renderPendingFiles();
    renderSources();
    updateFavoriteCount();
    // agent 布局：这一屏显示哪条会话的消息由侧栏决定（空 cid = 项目默认单线程）
    const bootMessages = currentUi() === "agent" && window.KnowOriginAgentShell
      ? await window.KnowOriginAgentShell.resolveMessages(projectId, payload)
      : payload.messages || [];
    renderConversationHistory(bootMessages);
    switchFeature("framework", { reveal: false });   // 切项目不弹浮层
    // 海小棠桌宠：告知当前课程（低侵入，桌宠由此读取掌握度做陪伴关怀）
    document.dispatchEvent(new CustomEvent("knoworigin:pet-project", {
      detail: { project_id: projectId, label: projectLabel(data.project) },
    }));
    // 通知「当前项目已切换」：台历冲刺计划等按项目过滤的模块据此重拉
    document.dispatchEvent(new CustomEvent("knoworigin:project-switched", {
      detail: { project_id: projectId },
    }));
  } catch (error) { showError(error, () => selectProject(projectId)); }
}

function resetProjectView() {
  // 项目视图被重置（含登出）时清掉记忆：否则下次登录会自动跳进上一个账号的项目
  state.currentProjectId = "";
  kbResetWorkspace();
  state.currentProjectId = "";
  state.sourceImportRequestId += 1;
  clearSourceImportProgress({ render: false });
  $("#paste-form button[type='submit']").disabled = false;
  state.sources = [];
  state.nodes = [];
  state.favorites = [];
  state.editingFavoriteId = "";
  state.favoriteQuery = "";
  hideUndoNotice();
  state.cards = [];
  state.quiz = null;
  state.openCardIds = new Set();
  state.cardAnswerOpenIds = new Set();
  state.quizDraftAnswers = {};
  state.masteryRules = null;
  state.masteryBreakdown = null;
  clearStudySelections();
  state.textHighlights = {};
  state.shownSourceMessageIds = new Set();
  state.selectedSourceIds = new Set();
  state.sourceDeleteSelectionIds = new Set();
  clearProblemImage();
  renderProjectSelect();
  $("#agent-title").textContent = "从项目材料开始探索";
  renderSources();
  renderPendingFiles();
  updateFavoriteCount();
  renderEmptyOutput("还没有项目", "先在左侧新建项目。");
  renderSuggestedQuestions();
  // 通知「已切出项目」：台历冲刺计划等按项目过滤的模块据此清空
  document.dispatchEvent(new CustomEvent("knoworigin:project-switched", {
    detail: { project_id: "" },
  }));
}

function requireProject(action) {
  if (state.currentProjectId) {
    action();
    return;
  }
  showError(new Error("请先新建或选择项目。"));
  $("#project-dialog").showModal();
}

async function buildFramework() {
  const button = $("#build-framework-button");
  const previous = button.innerHTML;
  const progress = startBuildProgress();
  button.disabled = true;
  button.innerHTML = "<span>正在构建…</span><small>整理来源证据</small>";
  try {
    const data = await buildFrameworkStream((event) => progress.applyEvent(event));
    state.nodes = data.nodes || [];
    $("#fallback-label").classList.toggle("hidden", !data.fallback);
    showNotice(data.message || "知识框架已生成 / 更新。");
    await progress.complete();
    switchFeature("framework");
  } catch (error) {
    showError(error, buildFramework);
  } finally {
    progress.stop();
    button.disabled = false;
    button.innerHTML = previous;
  }
}

// 知识框架构建走 SSE：后端把「解析来源 / 模型生成 / 校验关联 / 落库」的真实阶段事件
// 逐条推过来，等待模型期间还有真实计时心跳。onEvent 收到的是后端事件对象。
async function buildFrameworkStream(onEvent) {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(state.currentProjectId)}/framework/build`,
    { method: "POST", credentials: "same-origin" },
  );
  if (!response.ok) {
    let detail = "";
    try {
      const data = await response.json();
      const d = data && (data.detail ?? data.message);
      if (typeof d === "string") detail = d;
      else if (d && typeof d.message === "string") detail = d.message;
      else if (d) detail = JSON.stringify(d);
    } catch (_) { /* ignore */ }
    throw new Error(`构建请求失败：HTTP ${response.status}${detail ? " " + detail : ""}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = null;
  let streamError = null;
  const handlePayload = (payload) => {
    let event;
    try { event = JSON.parse(payload); } catch (_) { return; }
    if (event.type === "result") result = event.data || {};
    else if (event.type === "error") streamError = new Error(event.message || "构建失败。");
    else if (typeof onEvent === "function") onEvent(event);
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data: ")) continue;
      const payload = t.slice(6).trim();
      if (payload) handlePayload(payload);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim().startsWith("data: ")) handlePayload(buffer.trim().slice(6).trim());
  if (streamError) throw streamError;
  if (!result) throw new Error("构建连接中断，未收到结果。");
  return result;
}

function startBuildProgress() {
  const container = $("#build-progress");
  const label = $("#build-progress-label");
  const percent = $("#build-progress-percent");
  const bar = $("#build-progress-bar");
  const stages = [
    { key: "parse", label: "解析来源" },
    { key: "extract", label: "提取主题" },
    { key: "link", label: "建立关联" },
    { key: "render", label: "生成图谱" },
  ];
  let lastIndex = 0;
  const showStage = (index, stagePercent, detail) => {
    lastIndex = index;
    container.classList.remove("hidden", "is-complete", "is-waiting");
    label.textContent = detail || stages[index].label;
    percent.textContent = `${Math.round(stagePercent)}%`;
    bar.style.width = `${Math.max(2, Math.min(100, stagePercent))}%`;
    container.querySelectorAll("[data-build-stage]").forEach((item) => {
      const itemIndex = stages.findIndex((candidate) => candidate.key === item.dataset.buildStage);
      item.classList.toggle("is-active", itemIndex === index);
      item.classList.toggle("is-done", itemIndex < index || (itemIndex === index && stagePercent >= 100));
    });
  };
  showStage(0, 3, "准备解析来源");
  return {
    // 后端真实进度事件：percent 只在真实阶段完成时前进；等待模型时用心跳显示已用秒数
    applyEvent(event) {
      if (!event || typeof event !== "object") return;
      if (event.type === "heartbeat") {
        // 模型生成中：百分比停在真实位置，文案显示真实计时，不编造进度
        container.classList.add("is-waiting");
        const secs = Math.max(1, Math.round(event.elapsed || 0));
        label.textContent = `模型正在生成知识框架 · 已用 ${secs} 秒`;
        return;
      }
      if (event.type === "error") return; // 错误由 buildFrameworkStream 统一抛出
      const index = stages.findIndex((candidate) => candidate.key === event.stage);
      if (index < 0 || typeof event.percent !== "number") return;
      showStage(index, event.percent, event.detail);
    },
    async complete() {
      container.querySelectorAll("[data-build-stage]").forEach((item) => {
        item.classList.add("is-done");
        item.classList.remove("is-active");
      });
      label.textContent = "知识框架已更新";
      percent.textContent = "100%";
      bar.style.width = "100%";
      container.classList.add("is-complete");
      container.classList.remove("is-waiting");
      await new Promise((resolve) => window.setTimeout(resolve, 260));
    },
    stop() {
      window.setTimeout(() => container.classList.add("hidden"), 280);
    },
  };
}

function updateMappingHint() {
  const selectedCount = selectableSources().filter((source) => state.selectedSourceIds.has(source.source_id)).length;
  const scope = selectedCount ? `已勾选 ${selectedCount} 份对话来源` : "未勾选对话来源";
  const intent = inferIntent($("#message-input")?.value || "", Boolean(state.problemImage));
  const hint = $("#mapping-hint");
  if (hint) {
    hint.textContent = intent === "solve"
      ? `已识别为做题 · ${scope}`
      : `自动识别 · ${scope}`;
  }
}

function handleMessageInputKeydown(event) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  $("#composer").requestSubmit();
}

function autoResizeMessageInput() {
  const input = $("#message-input");
  if (!input) return;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
}

async function sendMessage(event) {
  event.preventDefault();
  if (state.sending) return;
  const input = $("#message-input");
  const text = input.value.trim();
  const imageFile = state.problemImage;
  if (!text && !imageFile) return;
  if (!state.currentProjectId) return requireProject(() => {});
  const imageUrl = imageFile ? await fileToDataUrl(imageFile) : "";
  const userMessage = appendMessage("user", text || "请解答这张截图中的题目。", { imageUrl, created_at: new Date().toISOString() });
  input.value = "";
  const intent = inferIntent(text, Boolean(imageFile));
  const route = intent === "solve" ? "solve" : "chat";
  // 会话归属（B 线）：Agent 布局同一个项目可以有多条会话，带上 conversation_id 后端才分得开。
  // 空串 = 项目默认单线程。
  const sessionId = state.chatSessionId || "";
  const context = { node_ids: [], source_ids: [...state.selectedSourceIds], conversation_id: sessionId };
  // A 线：Agent 开关。打开时后端 /chat/stream 走 Function Calling 工具循环，模型自己检索资料、
  // 查掌握度、写操作只登记待确认；关掉时保持原来的一次性 RAG 问答。
  // solve 分支不看这个开关（解题是另一条链路）。
  context.agent = state.chatAgent !== false;
  // 海小棠代问：读取桌宠打上的隐形标记，随请求携带以便后端走温柔口吻；不进入可见正文
  const fromPet = input.dataset && input.dataset.hxtPet === "1";
  if (input.dataset) delete input.dataset.hxtPet;
  const body = intent === "solve" ? { problem: text, ...context } : { message: text, ...context, ...(fromPet ? { pet: true } : {}) };
  const pending = appendMessage("assistant", imageFile ? "正在识别截图并整理解题过程…" : "正在整理回答…", fromPet ? { pet: true } : {});
  setComposerSending(true);
  try {
    let data;
    let streamStats = null;
    if (imageFile) {
      const form = new FormData();
      form.append("image", imageFile, imageFile.name);
      form.append("message", text);
      form.append("source_ids", JSON.stringify(context.source_ids));
      form.append("conversation_id", sessionId);
      data = await api(`/api/projects/${state.currentProjectId}/solve-image`, { method: "POST", body: form });
    } else if (route === "chat") {
      // 纯文本提问走 SSE 流式，边生成边显示；任何异常都自动降级到一次性返回
      try {
        const _streamed = await sendMessageStreaming(state.currentProjectId, body, pending);
        data = _streamed.data;
        streamStats = _streamed;
      } catch (streamError) {
        console.warn("流式问答失败，降级为一次性返回：", streamError);
        data = await api(`/api/projects/${state.currentProjectId}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }
    } else {
      data = await api(`/api/projects/${state.currentProjectId}/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    pending.remove();
    if (data.question_message_id) userMessage.dataset.messageId = data.question_message_id;
    const needsTypewriter = streamStats && shouldTypewriterReveal(streamStats);
    const displayAnswer = stripThoughtBlocks(stripAnswerJsonWrapper(data.answer));
    const assistantMessage = appendMessage("assistant", displayAnswer, { ...data, created_at: data.message_created_at, __noRichUpgrade: needsTypewriter, ...(fromPet ? { pet: true } : {}) });
    attachQuestionFavoriteAction(assistantMessage, data.question_message_id, data.message_id);
    if (needsTypewriter) await typewriterReveal(assistantMessage, displayAnswer);
    clearProblemImage();
    if (data.node_ids?.length) {
      // 桌宠掌握度实时播报：对话触及节点并刷新后，若有掌握度变化就把涨幅交给 tju-llm 生成（无变化保持安静）
      _setMasteryBaseline();
      await refreshCurrentProject();
      const gainTxt = _masteryGainText();
      if (gainTxt) petReactAI("dialog", { gains: gainTxt }, "love", `聊完这轮，掌握度也有了新进展——${gainTxt}`, { ic: "📈", stayMs: 7000 });
    }
  } catch (error) {
    pending.remove();
    showError(error, () => {
      input.value = text;
      $("#composer").requestSubmit();
    });
  } finally {
    setComposerSending(false);
    updateMappingHint();
    // 会话清单可能要变（新建会话有了首条消息 → 后端自动补标题并置顶）
    document.dispatchEvent(new CustomEvent("knoworigin:chat-sent", {
      detail: { project_id: state.currentProjectId, session_id: sessionId },
    }));
  }
}

// ---- 流式问答：SSE 逐块接收，边生成边渲染 ----
// 流式渲染：合并多次 delta 一次性刷 DOM，滚动用单独的 rAF。
//
// 关键（踩过坑）：流式过程中**绝不能**调用 renderStudyTextContent。
// 它会对答案的每一行跑 renderKatex()（KaTeX 解析 + 正则），而流式每收到一个
// token 就对整段累积文本重跑一遍 —— 成本随答案长度线性增长、又被调用 n 次，
// 实际是 O(n²)。1000 字答案跑几百次就必然触发浏览器"页面无响应"。
// 所以流式期间只写 textContent（O(1)），公式与 Markdown 留给 done 后的
// appendMessage 一次性渲染（到那时只渲染一次，成本可接受）。
let _streamRafId = null;
let _streamScrollRaf = null;
let _streamRenderState = null;

function renderStreamingAnswer(pending, text) {
  _streamRenderState = { pending: pending, text: text };
  if (_streamRafId !== null) return;
  _streamRafId = requestAnimationFrame(function () {
    _streamRafId = null;
    const state = _streamRenderState;
    if (!state) return;
    const host = state.pending;
    // 占位元素可能已被移除（done 后 appendMessage 会重建），别再操作游离节点
    if (!host || !host.isConnected) {
      _streamRenderState = null;
      return;
    }
    const body = host.querySelector(".message-answer-content");
    if (!body) return;
    if (!body.classList.contains("is-streaming")) {
      body.classList.add("is-streaming");
    }
    // 弱模型偶尔无视"去 JSON 外壳"指令而吐 {"answer":"..."}，这里边收边剥掉，正文不受影响
    body.textContent = stripAnswerJsonWrapper(state.text);
    // 滚动独立 rAF：和正文渲染解耦，避免连续两次 DOM 写
    if (_streamScrollRaf === null) {
      _streamScrollRaf = requestAnimationFrame(function () {
        _streamScrollRaf = null;
        const conversation = $("#conversation");
        if (conversation) conversation.scrollTop = conversation.scrollHeight;
      });
    }
  });
}

async function sendMessageStreaming(projectId, body, pending) {
  const response = await fetch(`/api/projects/${projectId}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error(`流式问答失败：HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const _t0 = performance.now();
  let buffer = "";
  let answer = "";
  let done = null;
  let deltaCount = 0;
  let toolNames = [];
  while (true) {
    // ponytail: read() 返回 {value, done}——原代码解构了不存在的 streamDone，
    // 永远 falsy，流结束后 while(true) 变成无限微任务循环，页面彻底卡死。
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || ""; // 保留可能尚未接收完整的最后一行
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      let event;
      try {
        event = JSON.parse(line.slice(6));
      } catch (_) {
        continue;
      }
      if (event.type === "delta") {
        answer += event.text;
        deltaCount += 1;
        renderStreamingAnswer(pending, answer);
      } else if (event.type === "tool") {
        // Agent 模式：模型转入工具调用。丢掉调用前可能已吐出的半句（后端也会在 done 用
        // 权威全文重渲染），显示"正在查询"占位，避免用户看见半句话卡住不动。
        // ⚠️ 必须先撤掉还挂在 rAF 队列里的正文渲染：它后到一步就会把下面的状态覆盖掉。
        answer = "";
        toolNames = [...new Set([...toolNames, ...(event.names || [])])];
        if (_streamRafId !== null) {
          cancelAnimationFrame(_streamRafId);
          _streamRafId = null;
        }
        _streamRenderState = null;
        setStreamingToolStatus(pending, toolNames);
      } else if (event.type === "done") {
        done = event;
      } else if (event.type === "error") {
        throw new Error(event.message || "流式生成失败。");
      }
    }
  }
  if (!done) throw new Error("流式响应未正常结束。");
  // 收尾：取消待执行的 rAF，释放对占位元素的引用，避免长对话累积持有游离 DOM
  if (_streamRafId !== null) {
    cancelAnimationFrame(_streamRafId);
    _streamRafId = null;
  }
  if (_streamScrollRaf !== null) {
    cancelAnimationFrame(_streamScrollRaf);
    _streamScrollRaf = null;
  }
  _streamRenderState = null;
  return { data: done, deltaCount, elapsedMs: performance.now() - _t0 };
}

// =====================================================================
// AI 同学讨论模式（T7-T9）
// 面板 + SSE 流式 + 只听开关 + 用户作答。独立于主对话窗口，自成小微会话。
// 会话状态由后端落 kb_conversations.summary；前端只负责渲染 + act 推进。
// =====================================================================
let _discussionCtx = null; // { cid, nodeId, topic, stage, busy, listenOnly, paused }
let _discTimer = null;     // 只听连播的延迟推进
let _discCountdown = null; // 只听连播的倒计时秒表
const DISC_AVATARS = { "棠小怼": "🧐", "棠小补": "📚", "棠小引": "💡" };

function discussionRoot() {
  let el = document.querySelector("#discussion-pane");
  if (!el) {
    const host = document.querySelector(".kb-agent-wrap");
    if (!host) return null;
    el = document.createElement("div");
    el.id = "discussion-pane";
    el.className = "discussion-pane";
    const col = host.querySelector(".kb-msgs-col");
    (col || host).appendChild(el);
  }
  if (!el.querySelector("[data-disc-body]")) {
    el.innerHTML = `
    <div class="discussion-head">
      <div class="discussion-title">
        <span class="discussion-dot-label">AI 同学讨论</span>
        <span class="discussion-topic" data-disc-topic></span>
      </div>
      <label class="discussion-listener" title="只听模式：小组继续讨论，不需要你发言">
          <input type="checkbox" data-disc-listen class="discussion-switch">
          <span class="discussion-switch-track"><span class="discussion-switch-thumb"></span></span>
          <span class="discussion-switch-label">只听模式</span>
        </label>
    </div>
    <div class="discussion-body" data-disc-body>
      <div class="kb-loading">正在召集海小棠学习小组…</div>
    </div>`;
    el.querySelector("[data-disc-listen]").addEventListener("change", (e) => discussionApplyListen(e.target.checked, true));
  }
  return el;
}
function discussionReplyEl() {
  let bar = document.querySelector("[data-disc-reply]");
  if (bar) return bar;
  const host = document.querySelector(".kb-agent-wrap");
  if (!host) return null;
  bar = document.createElement("div");
  bar.className = "discussion-reply";
  bar.dataset.discReply = "";
  bar.innerHTML = `
    <div class="discussion-reply-row">
      <span class="discussion-prompt" data-disc-prompt>该你发言了</span>
      <label class="discussion-mark"><input type="checkbox" data-disc-correct> 我说对了</label>
    </div>
    <div class="kb-discuss-scaffold" data-disc-scaffold role="group" aria-label="发言模板">
      <span class="kb-discuss-scaffold-label">选一个说法，避免空手问：</span>
      <button class="mini-button" type="button" data-disc-say="我先说说我现在的理解：">我先说理解…</button>
      <button class="mini-button" type="button" data-disc-say="我卡在这一点：">我卡在这里…</button>
      <button class="mini-button" type="button" data-disc-say="我不确定的是：">我不确定…</button>
      <button class="mini-button" type="button" data-disc-say="能举个具体例子吗？">换个例子…</button>
    </div>
    <div class="discussion-reply-actions">
      <input class="discussion-input" data-disc-input type="text" placeholder="说说你的理解 / 站哪一边…">
      <button class="mini-button primary" data-disc-send>作答</button>
      <button class="mini-button" data-disc-next>继续讨论</button>
    </div>`;
  bar.querySelector("[data-disc-send]").addEventListener("click", () => discussionSubmitAnswer());
  // 发言模板：把「你怎么想」变成可落笔的结构，降低开口成本，也避免直接索要答案。
  // 填的是完整引导句（以冒号/问号收尾）而不是「我不确定」这种单词 —— 后者模型无从接话。
  bar.querySelectorAll("[data-disc-say]").forEach((btn) => btn.addEventListener("click", () => {
    const input = bar.querySelector("[data-disc-input]");
    if (!input) return;
    input.value = `${btn.dataset.discSay}`;
    input.focus();
  }));
  // 「继续讨论」优先不丢字：输入框里有内容就当作答提交，只有空输入才是"跳过作答"
  bar.querySelector("[data-disc-next]").addEventListener("click", () => {
    const input = bar.querySelector("[data-disc-input]");
    if ((input && input.value || "").trim()) {
      discussionSubmitAnswer();
      return;
    }
    discussionAdvance(false, undefined, true);
  });
  bar.querySelector("[data-disc-input]").addEventListener("keydown", (e) => {
    if (e.key === "Enter") discussionSubmitAnswer();
  });
  const composer = host.querySelector(".kb-agent-composer");
  if (composer) host.insertBefore(bar, composer);
  else host.appendChild(bar);
  return bar;
}

// 讨论态与引导态整区切换：退出讨论保留对话历史，重启进入即可复用
function discussionExit() {
  document.querySelectorAll(".kb-agent-wrap.is-discussing").forEach((w) => {
    w.classList.remove("is-discussing");
  });
  const dock = kbGetDock && kbGetDock();
  if (dock) {
    kbRenderAgentFocus && kbRenderAgentFocus();
    kbRenderGuidePreview && kbRenderGuidePreview();
  }
}

let _discStreamBubble = null;
function discussionScrollBottom() {
  const body = document.querySelector("[data-disc-body]");
  if (body) body.scrollTop = body.scrollHeight;
}
function discussionSetDelta(bub, chunk, tag) {
  if (!bub) return;
  bub.dataset.discRaw = (bub.dataset.discRaw || "") + (chunk == null ? "" : chunk);
  bub.innerHTML = tag ? escapeHtml(bub.dataset.discRaw) : kbRenderMarkdown(bub.dataset.discRaw);
  discussionScrollBottom();
}
function discussionAppendLine(persona, text, tag) {
  const pane = document.querySelector("#discussion-pane");
  const body = pane && pane.querySelector("[data-disc-body]");
  if (!body) return null;
  const ld = body.querySelector(".kb-loading");
  if (ld) ld.remove(); // 首条内容到达即撤下"正在召集"占位
  const row = document.createElement("div");
  row.className = "kb-agent-msg";
  if (persona) {
    const isUser = persona === "我" || persona === "你";
    row.classList.add(isUser ? "user-msg" : "assistant-msg");
    const role = document.createElement("div");
    role.className = "kb-agent-role";
    if (!isUser) {
      const av = document.createElement("span");
      av.className = "disc-avatar";
      av.textContent = DISC_AVATARS[persona] || "🌸";
      role.appendChild(av);
    }
    role.appendChild(document.createTextNode(persona));
    row.appendChild(role);
  }
  const bub = document.createElement("div");
  bub.className = "kb-agent-body";
  bub.dataset.discRaw = "";
  row.appendChild(bub);
  body.appendChild(row);
  if (tag) bub.classList.add("disc-error");
  if (text) discussionSetDelta(bub, text, tag);
  else discussionScrollBottom();
  return bub;
}

function discussionSetReply(visible, prompt) {
  const bar = discussionReplyEl();
  if (!bar) return;
  bar.hidden = !visible;
  const p = bar.querySelector("[data-disc-prompt]");
  if (visible && p) p.textContent = prompt || "该你发言了";
}

function discussionApplyListen(listen, notify) {
  const checked = Boolean(listen);
  if (_discussionCtx) _discussionCtx.listenOnly = checked;
  const pane = document.querySelector("#discussion-pane");
  if (pane) {
    pane.classList.toggle("is-listening", checked);
    const cb = pane.querySelector("[data-disc-listen]");
    if (cb) cb.checked = checked;
  }
  const bar = document.querySelector("[data-disc-reply]");
  if (bar) bar.hidden = checked;
  if (notify) {
    showToast(checked ? "已开启只听模式：海小棠小组继续讨论，静静听完即可" : "已关闭只听模式：现在轮到你了，可以发言", { variant: "notice" });
  }
  if (checked && _discussionCtx && !_discussionCtx.busy) {
    discussionAdvance(false); // 开启只听即自动推进一轮，进入"听讲"节奏
  }
}
function discussionBusy(busy) {
  if (_discussionCtx) _discussionCtx.busy = busy;
  const bar = discussionReplyEl();
  if (!bar) return;
  const send = bar.querySelector("[data-disc-send]");
  const next = bar.querySelector("[data-disc-next]");
  if (send) send.disabled = busy;
  if (next) next.disabled = busy;
}

// 只听模式连播调度：倒计时"N秒后 X 将发言"，带暂停按钮，方便看清内容
function discussionScheduleNext(nextPersona, delayMs) {
  const body = document.querySelector("[data-disc-body]");
  if (!body || !nextPersona) return;
  const delay = delayMs || 3000;
  const hint = document.createElement("div");
  hint.className = "disc-next-hint";
  hint.innerHTML =
    `<span class="disc-next-text"></span>` +
    `<button class="mini-button disc-pause-btn" type="button">暂停</button>`;
  body.appendChild(hint);
  discussionScrollBottom();
  const textEl = hint.querySelector(".disc-next-text");
  const who = document.createElement("b");
  who.textContent = nextPersona;
  const render = (remain) => {
    textEl.textContent = "";
    textEl.append("⏳ ");
    const s = document.createElement("b");
    s.textContent = `${Math.max(remain, 0)} 秒后 `;
    textEl.append(s, who, " 将发言");
  };
  render(Math.ceil(delay / 1000));
  _discCountdown = setInterval(() => {
    const remain = Math.ceil(delay / 1000) - 1;
    render(remain);
    if (remain <= 0) { clearInterval(_discCountdown); _discCountdown = null; }
  }, 1000);
  _discTimer = setTimeout(() => {
    if (_discCountdown) { clearInterval(_discCountdown); _discCountdown = null; }
    hint.remove();
    discussionAdvance(false);
  }, delay);
  hint.querySelector(".disc-pause-btn").addEventListener("click", () => discussionPause(hint));
}

function discussionPause(hint) {
  if (_discTimer) { clearTimeout(_discTimer); _discTimer = null; }
  if (_discCountdown) { clearInterval(_discCountdown); _discCountdown = null; }
  if (_discussionCtx) _discussionCtx.paused = true;
  if (hint) {
    hint.classList.add("is-paused");
    hint.innerHTML =
      `<span class="disc-next-text">已暂停 · 慢慢看，看完点继续</span>` +
      `<button class="mini-button primary disc-pause-btn" type="button">继续</button>`;
    hint.querySelector(".disc-pause-btn").addEventListener("click", () => discussionResume(hint));
  }
}

function discussionResume(hint) {
  if (_discussionCtx) _discussionCtx.paused = false;
  if (hint) hint.remove();
  discussionAdvance(false);
}

async function discussionStream(endpoint, body, onEvent) {
  const projectId = state.currentProjectId;
  const response = await fetch(`/api/projects/${projectId}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  if (!response.ok) {
    let detail = "";
    try {
      const data = await response.json();
      const d = data && (data.detail ?? data.message);
      if (typeof d === "string") detail = d;
      else if (d && typeof d.message === "string") detail = d.message;
      else if (d) detail = JSON.stringify(d);
    } catch (_) { /* ignore */ }
    throw new Error(`讨论请求失败：HTTP ${response.status}${detail ? " " + detail : ""}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || ""; // 保留可能尚未接收完整的最后一行
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data: ")) continue;
      const payload = t.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;
      try { onEvent(JSON.parse(payload)); } catch (_) { /* 非法帧忽略 */ }
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const t = buffer.trim();
    if (t.startsWith("data: ")) {
      const payload = t.slice(6).trim();
      if (payload && payload !== "[DONE]") {
        try { onEvent(JSON.parse(payload)); } catch (_) { /* 非法帧忽略 */ }
      }
    }
  }
}

// 讨论态进入布局联动：复用引导两栏网格，右列由讨论流接管，左列预览该讨论锚点节点的笔记
function discussionEnterLayout(nodeId) {
  const host = document.querySelector(".kb-agent-wrap");
  if (!host) return;
  const grid = host.querySelector("[data-kb-wb-grid]");
  if (grid) grid.classList.add("is-workbench");
  const panel = host.querySelector("[data-kb-guide-preview]");
  if (!panel || !nodeId) return;
  panel.dataset.kbPreviewNode = nodeId;
  const node = (state.nodes || []).find((n) => n.node_id === nodeId);
  panel.hidden = !node;
  if (!node) return;
  panel.innerHTML = kbWbPreviewHTML(node, "该节点还没有笔记。可让助手先整理。", _kbNoteIdxOpen);
}

async function openDiscussionForNode(nodeId, options) {
  if (!state.currentProjectId) return requireProject(() => openDiscussionForNode(nodeId, options));
  const host = document.querySelector(".kb-agent-wrap");
  if (!host) { showToast("请先进入整理助手工作区，再发起讨论。", "error"); return; }
  // 闭环 stepper 的「讨论」步据此点亮（后端不留讨论痕迹，只在前端标记本会话已发起）
  if (!state.kbDiscussedNodes) state.kbDiscussedNodes = {};
  state.kbDiscussedNodes[nodeId] = true;
  if (typeof kbRefreshNodeProgress === "function") kbRefreshNodeProgress();
  // 讨论面板挂在整理助手工作区（.kb-agent-wrap）里：从「笔记」页签的「AI 同学讨论」按钮发起时，
  // 必须先跳回整理助手页签，否则讨论在隐藏面板里跑起来，用户点按钮却看不到任何变化（同 kbStartGuide 的做法）。
  const dock = typeof kbGetDock === "function" ? kbGetDock() : null;
  if (dock) { dock.hidden = false; kbDockSwitch(dock, "agent"); }
  const quote = (options && options.quote || "").trim();
  const pane = discussionRoot();
  const body = pane.querySelector("[data-disc-body]");
  // 节点讨论完全独立：仅同一节点且已有会话时才复用历史；换节点（或围绕选中强制开新场）一律开新讨论
  const forceNew = Boolean(options && options.force);
  const hasSession = !forceNew && _discussionCtx && _discussionCtx.cid && _discussionCtx.nodeId === nodeId && body.childElementCount > 0;
  host.classList.add("is-discussing");
  discussionEnterLayout(nodeId);
  if (hasSession) return; // 已有进行中会话：直接切到讨论态并保留历史
  pane.querySelector("[data-disc-body]").innerHTML = `<div class="kb-loading">正在召集海小棠学习小组…</div>`;
  _discussionCtx = null;
  _discStreamBubble = null;
  discussionApplyListen(false, false);
  discussionSetReply(true, "该你发言了"); // 进入讨论态即常驻作答区，只听模式才隐藏
  try {
    let cid = null;
    let persona = null; // 本段发言由哪位同学开口（meta 携带），用于名字+头像
    await discussionStream(
      "/discussion/start",
      quote ? { node_id: nodeId, quote } : { node_id: nodeId },
      (ev) => {
        if (ev.type === "meta") {
          cid = ev.conversation_id;
          persona = ev.persona || null;
          _discussionCtx = { cid, nodeId, topic: "", stage: ev.stage, busy: true, listenOnly: false };
        } else if (ev.type === "delta") {
          if (!_discStreamBubble) _discStreamBubble = discussionAppendLine(persona, "");
          discussionSetDelta(_discStreamBubble, ev.text);
        } else if (ev.type === "error") {
          _discStreamBubble = null;
          discussionAppendLine(null, `⚠️ ${ev.message || "讨论出错"}`, true);
        } else if (ev.type === "done") {
          _discStreamBubble = null;
          if (_discussionCtx) _discussionCtx.stage = ev.stage;
        }
      }
    );
    if (!cid) throw new Error("未能建立讨论会话");
    const node = state.nodes.find((n) => n.node_id === nodeId);
    if (node) {
      _discussionCtx.topic = node.name;
      pane.querySelector("[data-disc-topic]").textContent = node.name || "";
    }
    discussionSetReply(true, "该你发言了");
    discussionBusy(false);
  } catch (err) {
    discussionAppendLine(null, `⚠️ ${err.message || "发起讨论失败"}`, true);
    discussionBusy(false);
  }
}

async function discussionAdvance(withReply, correct, forceSkip, opts) {
  const alreadyEchoed = Boolean(opts && opts.alreadyEchoed);
  // 提交方可能已经先把输入框清空（点了就回显+锁定按钮），原文必须由 opts 显式带进来。
  // 以前只从 input.value 读，清空后发出去的是空串 → 后端 422「该环节需要你先回答」，
  // 用户看到的就是「我明明说了话，却一直被要求先回答」。
  const replyText = opts && typeof opts.replyText === "string" ? opts.replyText : null;
  if (!_discussionCtx) {
    showToast("海小棠小组还在召集，稍等片刻…", "notice");
    discussionResetSendButtons();
    return;
  }
  if (_discussionCtx.busy) {
    showToast("上一句还在回应中，稍等一下～", { variant: "notice" });
    discussionResetSendButtons();
    return;
  }
  const ctx = _discussionCtx;
  discussionBusy(true);
  const body = { conversation_id: ctx.cid, listen_only: Boolean(ctx.listenOnly), force_skip: Boolean(forceSkip) };
  if (withReply) {
    const input = discussionReplyEl().querySelector("[data-disc-input]");
    const text = (replyText != null ? replyText : (input && input.value || "")).trim();
    if (!text) {
      discussionBusy(false);
      showToast("先写两句你的想法再作答～", "notice");
      discussionResetSendButtons();
      return;
    }
    body.user_reply = text;
    if (correct != null) body.correct = correct;
    // 正常路径在这里回显用户原话；作答按钮路径已在提交时回显过，避免同一句出现两次
    if (!alreadyEchoed) discussionAppendLine("我", text, true);
    if (correct === true) {
      // 「我说对了」的确定性反馈：不依赖模型是否记得夸你
      discussionAppendLine(null, "——— 已记录：我说对了 ✓（已计入本节点掌握度）———");
      if (typeof showToast === "function") showToast("已记为答对 ✓，掌握度已更新", { variant: "notice" });
    }
    const promptEl = discussionReplyEl().querySelector("[data-disc-prompt]");
    if (promptEl) promptEl.textContent = correct === true ? "已收到（你说对了✓），听小组怎么接你这句" : "已收到你的想法，听小组怎么接你这句";
    if (input) input.value = "";
  }
  let bub = null;
  let persona = null; // 本轮由哪位同学发言（meta 携带），用于名字+头像
  try {
    await discussionStream("/discussion/act", body, (ev) => {
      if (ev.type === "delta") {
        if (!bub) bub = discussionAppendLine(persona, "");
        discussionSetDelta(bub, ev.text);
      } else if (ev.type === "meta") {
        persona = ev.persona || null; // 自由对话：不再有「第N轮换角度」分隔线，围绕话题自然接力
      } else if (ev.type === "done") {
        ctx.stage = ev.stage;
        if (ev.finished) {
          if (_discTimer) { clearTimeout(_discTimer); _discTimer = null; }
          if (_discCountdown) { clearInterval(_discCountdown); _discCountdown = null; }
          discussionAppendLine(
            null,
            "——— 本期讨论已收束：已按「前提 / 依据 / 结论 / 边界」形成共识，待查证项已单列。可关闭面板，或接着聊继续深化。 ———"
          );
          // 交互模式保留作答区，想接着聊随时可以说；只听连播模式保持隐藏
          discussionSetReply(!ctx.listenOnly, "还想接着聊就继续说");
        } else {
          // 作答区常驻：只听模式才隐藏，wait_user 时提示选边
          discussionSetReply(
            !ctx.listenOnly,
            ev.stage === "wait_user" ? "该你发言了：站在哪一边？为什么？" : "该你发言了"
          );
          if (ctx.listenOnly && ev.next_persona && !_discussionCtx.paused) {
            // 只听模式连播：倒计时提示下一位发言人，可暂停
            discussionScheduleNext(ev.next_persona);
          }
        }
      } else if (ev.type === "error") {
        discussionAppendLine(null, `⚠️ ${ev.message || "讨论出错"}`);
      }
    });
  } catch (err) {
    const msg = err.message || "推进失败";
    discussionAppendLine(null, `⚠️ ${msg}`);
    // 讨论失败必须让用户在气泡之外也看见：toast 保证不被长对话淹没，
    // 命中「没配 API Key」时再给一个直达配置的按钮。
    showToast(msg, { variant: "notice" });
    if (typeof isApiConfigError === "function" && isApiConfigError({ message: msg })) {
      discussionAppendLine("我", "");
      const row = document.querySelector("#discussion-pane [data-disc-body]")?.lastElementChild;
      if (row) {
        const bub = row.querySelector(".kb-agent-body");
        if (bub) {
          bub.classList.remove("disc-error");
          bub.innerHTML = `<div class="kb-graph-jump"><button type="button" data-kb-action="open-api-config">⚙ 去配置 API Key 后再讨论</button></div>`;
        }
      }
    }
  } finally {
    discussionBusy(false);
    discussionResetSendButtons();   // 作答/继续讨论恢复可用，别把用户卡在禁用态
  }
}

// 作答按钮忙碌态复位：模型出完（或出错）后把「作答 / 继续讨论」放回可用
function discussionResetSendButtons() {
  const bar = document.querySelector("[data-disc-reply]");
  if (!bar) return;
  const sendBtn = bar.querySelector("[data-disc-send]");
  const nextBtn = bar.querySelector("[data-disc-next]");
  if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = sendBtn.dataset.discIdle || "作答"; }
  if (nextBtn) nextBtn.disabled = false;
}

function discussionSubmitAnswer() {
  const bar = discussionReplyEl();
  if (!bar) return;
  const input = bar.querySelector("[data-disc-input]");
  const sendBtn = bar.querySelector("[data-disc-send]");
  const nextBtn = bar.querySelector("[data-disc-next]");
  const correctBox = bar.querySelector("[data-disc-correct]");
  const correct = Boolean(correctBox && correctBox.checked);
  const text = (input && input.value || "").trim();
  if (!text) { showToast("先写两句你的想法再作答～", "notice"); if (input) input.focus(); return; }
  // 先把自己这句原样回显并锁定按钮：点了必须立刻有反应，
  // 否则等待模型的那几秒里界面毫无变化，像是「没起作用」。
  discussionAppendLine("我", text, true);
  if (input) input.value = "";
  if (correctBox) correctBox.checked = false;
  // 注意：这里不要再调 discussionBusy(true)。它会把 ctx.busy 置真，紧接着
  // discussionAdvance 开头的并发闸会当场 return + 复位按钮，请求发不出去。
  if (nextBtn) nextBtn.disabled = true;
  const promptEl = bar.querySelector("[data-disc-prompt]");
  if (promptEl) promptEl.textContent = "同学们正在接你的话…";
  if (sendBtn) {
    sendBtn.dataset.discIdle = sendBtn.dataset.discIdle || sendBtn.textContent.trim();
    sendBtn.textContent = "已发送";
  }
  // 原文随参数传下去：输入框已清空，discussionAdvance 再也读不到了
  discussionAdvance(true, correct, undefined, { alreadyEchoed: true, replyText: text });
}

// ---- 打字机兜底：上游若非真流式（整包一次返回），保证仍逐字上屏 ----
// 判定：真正逐 token 的流式会收到多个 delta 且持续时间 > 600ms；
// 若 delta 极少或耗时极短，说明上游把整段缓冲后一次性返回，用户什么也没"看到生成"，
// 此时就在最终消息元素上做逐字 reveal。真流式时跳过，避免把已经实时显示的内容再放一遍。
function shouldTypewriterReveal(stats) {
  if (!stats || typeof stats !== "object") return false;
  if (stats.elapsedMs && stats.elapsedMs < 600) return true;
  return (stats.deltaCount || 0) <= 2;
}

function typewriterReveal(article, content) {
  return new Promise((resolve) => {
    const slot = article && article.querySelector(".answer-rich-slot");
    const el = slot ? slot.querySelector(".message-answer-content") : null;
    // try/catch 之下元素可能已脱离 DOM，直接视为完成，避免挂起
    if (!el || !article.isConnected) return resolve();
    const text = String(content ?? "");
    if (!text) return resolve();
    // 动态打字速度：短答案利落呈现，长答案动态加速（最快约 1.5 秒完成），绝不折磨用户等待
    const cps = Math.max(160, Math.round(text.length / 1.5));
    let shown = 0;
    let raf = null;
    let last = performance.now();
    el.textContent = "";
    const tick = (t) => {
      if (!article.isConnected) {
        if (raf) cancelAnimationFrame(raf);
        return resolve();
      }
      const dt = Math.min(60, t - last);
      last = t;
      shown = Math.min(text.length, shown + Math.max(1, Math.round((cps * dt) / 1000)));
      el.textContent = text.slice(0, shown);
      if (shown >= text.length) {
        if (raf) cancelAnimationFrame(raf);
        // 打完收尾直接同步就地升级为富文本，零延迟
        const slotEl = article.querySelector(".answer-rich-slot");
        if (slotEl) {
          const renderedHtml = renderStudyTextContent(text) || `<p class="study-text-line">${escapeHtml(text)}</p>`;
          slotEl.innerHTML = highlightableMarkup(
            `message:${article.dataset.messageId || hashString(text)}:answer`,
            renderedHtml,
            "message-answer-content"
          );
          scheduleMathJaxTypeset();
        }
        return resolve();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  });
}

// 弱模型偶尔无视"去 JSON 外壳"指令，把答案包成 {"answer":"..."}。流式途中 JSON 未闭合
// 无法整体解析，这里兼容两种情况：已闭合就整段解包（取 answer + 尾部残余任何追加内容）；
// 未闭合就只剥掉前导 {"answer": 前缀，保证正文在打字机/流式里也照常逐字显示，不留裸 JSON。
function stripAnswerJsonWrapper(text) {
  const s = String(text ?? "");
  if (!s.trim().startsWith("{")) return s;
  const cut = kbExtractFirstJsonObject(s);
  if (cut) {
    try {
      const obj = JSON.parse(cut.json);
      if (obj && typeof obj.answer === "string") {
        const idx = s.indexOf(cut.json);
        return obj.answer + (idx >= 0 ? s.slice(idx + cut.json.length) : "");
      }
    } catch (_) {
      /* 解析失败走剥前缀逻辑 */
    }
  }
  return s.replace(/^\s*\{\s*"answer"\s*:\s*"?/, "");
}

// 模型偶尔会把推理过程包在 <thinking>/<thought>/<reasoning> 标签里输出，
// 这些内容不应展示给用户。本函数：先移除所有已闭合的推理块；流式途中遇到
// 尚未闭合的推理块时，把其后所有内容一并藏起（“藏到闭合为止”），避免 thinking 一闪而过。
function stripThoughtBlocks(text) {
  const s = String(text ?? "");
  const closed = s.replace(/<(thinking|thought|reasoning)\b[\s\S]*?<\/\1>/gi, "");
  const opening = closed.match(/<(thinking|thought|reasoning)\b/i);
  if (opening && opening.index !== undefined) return closed.slice(0, opening.index);
  return closed;
}

// ---- 富文本延迟升级队列 ----
// ponytail: renderStudyTextContent 会对答案的每一行同步跑 KaTeX。流式期间我们已经
// 只写纯文本所以很流畅，但收尾 appendMessage 时如果一次性渲染整段长答案，仍会独占
// 主线程数秒 —— 表现就是"回答完就卡在那儿动不了"。
// 因此：先把纯文本挂上去让用户立刻看到完整答案，再用空闲帧把富文本逐个补上。
const _richTextQueue = [];
let _richTextScheduled = false;

function _drainRichTextQueue(deadline) {
  _richTextScheduled = false;
  const timed =
    deadline && typeof deadline.timeRemaining === "function";
  const start = performance.now();
  while (_richTextQueue.length) {
    // 防饿死关键：先取出任务执行，保证每一轮调用至少前进一步，绝不能因 timeRemaining<=2 循环 break
    const job = _richTextQueue.shift();
    try {
      job();
    } catch (error) {
      logMathRenderDebug({ renderer: "rich-text-upgrade-error", error: String(error) });
    }
    // 保护：单次连续执行超过 12ms 时主动让出主线程保证动画不掉帧；若有空闲额度且未超时才检查余量
    if (performance.now() - start > 12) break;
    if (timed && !deadline.didTimeout && deadline.timeRemaining() <= 1) break;
    if (!timed) break;
  }
  if (_richTextQueue.length) _scheduleRichTextDrain();
}

function _scheduleRichTextDrain() {
  if (_richTextScheduled) return;
  _richTextScheduled = true;
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(_drainRichTextQueue, { timeout: 250 });
  } else {
    // Safari 等不支持 requestIdleCallback 的浏览器
    setTimeout(() => _drainRichTextQueue(null), 0);
  }
}

// 富文本（Markdown / KaTeX）延迟升级：把一条回答拆成若干「空行分隔的段落」，每个段落
// 作为一条独立的小任务进空闲队列。相比一次渲染整段长答案，拆开后每条任务的 KaTeX
// 工作量小很多，主线程能在段落之间让出（不整段卡死），且多个小任务在一个空闲帧里能
// 连做很多，公式整体更早冒出来。所有段落都渲染完后再一次性写入 DOM，保证
// highlightableMarkup 的 base 哈希基于最终完整 HTML 计算，不回退历史高亮标注。
function scheduleRichTextUpgrade(article, content, messageKey) {
  if (!article || !article.isConnected) return;
  const slot = article.querySelector(".answer-rich-slot");
  if (!slot) return;
  const text = String(content ?? "");
  // 常规长度（<= 10000 字符）单次渲染仅需 10~25ms，直接一步到位，零延迟零等待
  if (text.length <= 10000) {
    const renderedHtml = renderStudyTextContent(text) || `<p class="study-text-line">${escapeHtml(text)}</p>`;
    slot.innerHTML = highlightableMarkup(
      `message:${messageKey}:answer`,
      renderedHtml,
      "message-answer-content"
    );
    scheduleMathJaxTypeset();
    return;
  }
  // 超长文本按段落分批进队列，避免单次任务过重
  const chunks = text.split(/\n\s*\n/).map((c) => c.trim()).filter(Boolean);
  if (!chunks.length) chunks.push("");
  const parts = new Array(chunks.length);
  chunks.forEach((chunk, i) => {
    _richTextQueue.push(() => {
      if (!article.isConnected) return;
      try {
        const html = renderStudyTextContent(chunk) || "";
        parts[i] = html.replace(/^<div class="study-text-blocks">([\s\S]*?)<\/div>$/, "$1") || html;
      } catch (error) {
        logMathRenderDebug({ renderer: "rich-text-chunk-error", error: String(error) });
      }
    });
  });
  _richTextQueue.push(() => {
    if (!article.isConnected) return;
    const curSlot = article.querySelector(".answer-rich-slot");
    if (!curSlot) return;
    curSlot.innerHTML = highlightableMarkup(
      `message:${messageKey}:answer`,
      `<div class="study-text-blocks">${parts.join("")}</div>`,
      "message-answer-content"
    );
    scheduleMathJaxTypeset();
  });
  _scheduleRichTextDrain();
}

function appendMessage(role, content, meta = {}) {
  const article = document.createElement("article");
  article.className = `message ${role}-message`;
  if (meta.message_id) article.dataset.messageId = meta.message_id;
  article.dataset.role = role;
  const tags = [meta.source_ids?.length ? `引用 ${meta.source_ids.length} 个来源` : "", meta.node_ids?.length ? `关联 ${meta.node_ids.length} 个节点` : ""].filter(Boolean).join(" · ");
  const timeMarkup = messageTimeMarkup(meta.created_at);
  if (role === "assistant") {
    content = stripThoughtBlocks(content);
    const messageKey = meta.message_id || meta.created_at || hashString(content);
    if (meta.message_id && !state.shownSourceMessageIds.has(meta.message_id)) article.classList.add("message-sources-hidden");
    const segments = normalizeAnswerSegmentsForRender(Array.isArray(meta.answer_segments) ? meta.answer_segments : []);
    let answerMarkup;
    let needsRichUpgrade = false;
    if (segments.length) {
      answerMarkup = `<div class="answer-segments">${segments.map((segment, index) => renderAnswerSegment(segment, meta.source_refs, messageKey, index)).join("")}</div>`;
    } else if (meta.__noRichUpgrade) {
      // 仅打字机兜底路径先挂纯文本，后续由 typewriterReveal 逐字填充并在完成时即时升级
      answerMarkup = `<div class="answer-rich-slot"><div class="message-answer-content is-plain">${escapeHtml(content)}</div></div>`;
      needsRichUpgrade = true;
    } else {
      // 正常问答与流式收尾：直接生成排版好的富文本（耗时仅约 10ms），绝无二次等待与饿死卡顿
      const renderedHtml = renderStudyTextContent(content) || `<p class="study-text-line">${escapeHtml(content)}</p>`;
      answerMarkup = `<div class="answer-rich-slot">${highlightableMarkup(
        `message:${messageKey}:answer`,
        renderedHtml,
        "message-answer-content"
      )}</div>`;
    }
    // 海小棠代问的回覆：头像显示为海小棠，而不是通用的"题"
    // 形象与桌宠当前皮肤（v6 海棠花仙 · 粉瓣花冠）保持一致，不再用旧版 filled PNG
    const avatarHtml = meta.pet
      ? `<img class="avatar hxt-pet-avatar" src="/static/img/hxt/anime/v6/frames/happy/happy-01.png?v=s20260910c" alt="海小棠">`
      : `<span class="avatar assistant-brand-avatar"><img class="assistant-brand-img" src="${document.documentElement.getAttribute("data-brand") === "tju" ? "/static/img/knoworigin-emblem.png" : "/static/icon.svg"}" alt="${document.documentElement.getAttribute("data-brand") === "tju" ? "天津大学主题" : "知源助手"}"></span>`;
    article.innerHTML = `${avatarHtml}<div>${answerMarkup}${messageMetaMarkup(meta, tags, timeMarkup)}${agentActionCardMarkup(meta.staged_actions)}</div>`;
    if (needsRichUpgrade) {
      // 打字机路径：富文本升级推迟到逐字 reveal 完成后，由 typewriterReveal 主动触发
      if (!meta.__noRichUpgrade) scheduleRichTextUpgrade(article, content, messageKey);
    } else if (!segments.length) {
      scheduleMathJaxTypeset();
    }
    article.querySelectorAll(".citation-chip[data-source-id]").forEach((button) => {
      button.addEventListener("click", () => openSourcePreview(button.dataset.sourceId, button.dataset.quote || ""));
    });
  } else {
    const imageMarkup = meta.imageUrl
      ? `<img class="user-attachment" src="${escapeAttr(meta.imageUrl)}" alt="用户上传的题目截图">`
      : "";
    article.innerHTML = `<div>${imageMarkup}<p class="user-msg-content">${renderMathContent(content)}</p>${timeMarkup}</div>`;
  }
  bindAgentActionCard(article, meta.staged_actions);
  $("#conversation").append(article);
  if (evidencePanelOpen()) {
    // 开着就跟着长：不然它会停在打开那一瞬的旧状态，比没有更误导
    renderEvidence();
  } else if (_evidencePendingOpen) {
    // 刷新后恢复：等真的渲染出内容了再开，别开一个空面板
    _evidencePendingOpen = false;
    openEvidence();
  }
  $("#conversation").scrollTop = $("#conversation").scrollHeight;
  return article;
}

// 后端按句/按行切分 segments，Markdown 表格的每一行会被拆成独立 segment。
// 这里把连续的表格行 segment 重新拼回一个多行 segment，renderAnswerSegment 再整体渲染成 <table>。
// 除了合并"行首是 |"的连续表格行，还会吸收表格内的"续行碎片"：
// 模型可能把某个表格单元格拆成两行（单元格内插入真实换行或行内句号被后端切分），
// 该续行是不以 | 开头、却能补全打开表格行的碎片。只要补齐后仍与已有列数一致且当前行尚未闭合，就并入表格段。
// 遇标题、列表项或上一行已闭合时立即阻断，彻底防止整篇回答被错误吞噬进表格。
const TABLE_STRUCT_BREAK_RE = /^(?:#{1,6}\s|\d+[.)、\uFF0E]|[-*•]\s+|[一二三四五六七八九十]+[、.．]|(?:来源依据|补充脉络|相关对象|关键解释|正确答案|你的答案|解析|备注)[：:])/u;

function groupTableAnswerSegments(segments) {
  const grouped = [];
  let run = null;
  let tableCols = 0;
  let currentLogicalRow = "";
  const flush = () => {
    if (run) grouped.push(run);
    run = null;
    tableCols = 0;
    currentLogicalRow = "";
  };
  const mergeIntoRun = (run, text, segment) => {
    run.text = `${run.text}\n${text}`;
    run.source_ids = [...new Set([...(run.source_ids || []), ...(Array.isArray(segment?.source_ids) ? segment.source_ids : [])])];
    run.citations = [...(run.citations || []), ...(Array.isArray(segment?.citations) ? segment.citations : [])];
  };
  const newRun = (text, segment) => ({
    text,
    source_ids: Array.isArray(segment?.source_ids) ? [...segment.source_ids] : [],
    citations: Array.isArray(segment?.citations) ? [...segment.citations] : [],
  });
  const rowCellsCount = (text) => splitTableCells(String(text ?? "").trim()).length;
  const isSeparatorRow = (text) => {
    const cells = splitTableCells(String(text ?? "").trim());
    return cells.length >= 2 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
  };
  const isRowClosed = (rowText, cols) => {
    const t = String(rowText || "").trim();
    if (!t.startsWith("|") || !t.endsWith("|")) return false;
    if (!cols) return false;
    return rowCellsCount(t) >= cols;
  };

  (segments || []).forEach((segment) => {
    const text = String(segment?.text ?? "").trim();
    if (!text) {
      flush();
      grouped.push(segment);
      return;
    }

    // 强行结构阻断：标题、编号列表、特定引导词绝不作为表格续行
    if (TABLE_STRUCT_BREAK_RE.test(text)) {
      flush();
      grouped.push(segment);
      return;
    }

    if (run) {
      // 1. 如果是单独的 '|' 且当前逻辑行末尾尚未闭合，说明是被拆碎的行末闭合竖线
      if (/^\|+\s*$/.test(text) && currentLogicalRow && !currentLogicalRow.endsWith("|")) {
        currentLogicalRow = `${currentLogicalRow} |`;
        mergeIntoRun(run, text, segment);
        return;
      }

      // 2. 如果是新的表格行（以 | 开头且含多竖线）
      if (isTableRowLine(text)) {
        currentLogicalRow = text;
        mergeIntoRun(run, text, segment);
        if (isSeparatorRow(text)) tableCols = rowCellsCount(text);
        return;
      }

      // 3. 非表格行：只有当当前逻辑行存在且尚未闭合（列数不够或未以 | 闭合）时，才尝试作为单元格续行
      if (tableCols && currentLogicalRow && !isRowClosed(currentLogicalRow, tableCols)) {
        const candidateRow = `${currentLogicalRow} ${text}`;
        const candidateCols = rowCellsCount(candidateRow);
        if (candidateCols <= tableCols) {
          currentLogicalRow = candidateRow;
          mergeIntoRun(run, text, segment);
          return;
        }
      }

      // 否则说明当前表格已结束（上一行已闭合，且当前文本不是表格行）
      flush();
      grouped.push(segment);
      return;
    }

    // 尚未在 run 中：必须是表格行才能开启新表
    if (isTableRowLine(text)) {
      run = newRun(text, segment);
      currentLogicalRow = text;
      if (isSeparatorRow(text)) tableCols = rowCellsCount(text);
      return;
    }

    grouped.push(segment);
  });
  flush();
  return grouped;
}

// 多行文本若整体是一个 Markdown 表格（每行都是表格行、第 2 行是分隔行、列数一致），返回行数组。
// 若整段是"单行压缩表"（模型把一张表的所有行压到同一物理行，行间以 | | 连接、无换行），
// 或表格单元格内含真实换行（行被软换行折断），则尝试重建为多行表格行数组。
function parseAnswerTableRows(text) {
  const source = String(text ?? "");
  const lines = source.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (lines.length >= 3 && lines.every((line) => isTableRowLine(line))) {
    const aligns = parseTableSeparatorAligns(lines[1]);
    if (aligns && splitTableCells(lines[0]).length === aligns.length) return lines;
  }
  const packed = splitPackedSingleLineTable(source);
  if (packed) return packed;
  return rebuildTableRowsWithWrappedCells(source);
}

// 单元格内含真实换行的表格重建：表格行的格子被软换行拆成多行（并非每行都以 | 开头）。
// 先定位对齐分隔行确定列数 N，再把不以 | 开头的行并回上一行，校验每行列数一致后返回。
function rebuildTableRowsWithWrappedCells(value) {
  const lines = String(value ?? "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 3) return null;
  // 定位分隔行（该行以 | 开头且全部单元格为 :--- 形态）→ 得到列数 N
  let sepLine = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (!isTableRowLine(lines[i])) continue;
    const cells = splitTableCells(lines[i]);
    if (cells.length >= 2 && cells.every((cell) => /^:?-{2,}:?$/.test(cell))) {
      sepLine = lines[i];
      break;
    }
  }
  if (!sepLine) return null;
  const N = splitTableCells(sepLine).length;
  const rows = [];
  let current = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isTableRowLine(line)) {
      if (current && splitTableCells(rows[rows.length - 1]).length === N) current = null;
      if (!current) {
        rows.push(line);
        current = line;
      } else {
        current = `${current}\n${line}`;
        rows[rows.length - 1] = current;
      }
    } else if (current) {
      current = `${current} ${line}`;
      rows[rows.length - 1] = current;
    }
    // 表格开始前(尚未有 current)的散行会被忽略，视为非表格引导文本
  }
  if (rows.length < 3) return null;
  const sepRowIndex = rows.findIndex((row) => {
    const cells = splitTableCells(row);
    return cells.length === N && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
  });
  if (sepRowIndex !== 1) return null; // 必须：表头、分隔、数据… 顺序
  if (!rows.every((row) => splitTableCells(row).length === N)) return null;
  return rows;
}

// 单行压缩表重建：一行内出现对齐分隔行（| :--- | 等），则按列数把该行拆回
// 标准多行表格行数组（表头行 / 分隔行 / 若干数据行）。
function splitPackedSingleLineTable(value) {
  const source = String(value ?? "");
  if (!source || /\n/.test(source) || !isTableRowLine(source)) return null;
  // 保护数学段（$...$、\(...\)、\[...\]），避免 || 双竖线范数干扰分隔
  const stash = [];
  const masked = source.replace(
    /\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$|\$(?!\s)[^$\n]+?\$(?!\w)/g,
    (match) => {
      stash.push(match);
      return `\x00TC${stash.length - 1}\x00`;
    }
  );
  const tokens = masked.split("|").map((t) => t.trim().replace(/\x00TC(\d+)\x00/g, (_, i) => stash[Number(i)]));
  const sepIndexes = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (/^:?-{2,}:?$/.test(tokens[i])) sepIndexes.push(i);
  }
  if (sepIndexes.length < 2) return null;
  const N = sepIndexes.length;
  // 分隔格必须是一段连续区间（即完整的一行分隔行），否则不该重建
  const contiguous = sepIndexes.every((idx, offset) => idx === sepIndexes[0] + offset);
  if (!contiguous) return null;
  const sepStart = sepIndexes[0];
  const sepEnd = sepIndexes[N - 1];
  if (sepStart < 1) return null; // 行首必须是以 | 开头（表头前至少一个前导空 token）
  const headerCells = tokens.slice(0, sepStart).filter((t) => t !== "");
  if (headerCells.length !== N) return null;
  const bodyTokens = tokens.slice(sepEnd + 1).filter((t) => t !== "");
  if (bodyTokens.length < N) return null;
  const rows = [`| ${headerCells.join(" | ")} |`, `| ${tokens.slice(sepStart, sepEnd + 1).join(" | ")} |`];
  for (let r = 0; r + N <= bodyTokens.length; r += N) {
    rows.push(`| ${bodyTokens.slice(r, r + N).join(" | ")} |`);
  }
  return rows;
}

function normalizeAnswerSegmentsForRender(segments) {
  const normalized = [];
  let buffer = null;
  groupTableAnswerSegments(segments).forEach((segment) => {
    const current = {
      ...segment,
      text: String(segment?.text ?? ""),
      source_ids: Array.isArray(segment?.source_ids) ? segment.source_ids : [],
      citations: Array.isArray(segment?.citations) ? segment.citations : [],
    };
    if (!buffer) {
      buffer = current;
    } else if (hasOpenMathDelimiter(buffer.text) || looksLikeMathContinuation(current.text)) {
      buffer = mergeAnswerSegments(buffer, current);
    } else {
      normalized.push(buffer);
      buffer = current;
    }
    if (buffer && !hasOpenMathDelimiter(buffer.text) && !looksLikeDanglingLatexPrefix(buffer.text)) {
      normalized.push(buffer);
      buffer = null;
    }
  });
  if (buffer) normalized.push(buffer);
  return normalized;
}

function mergeAnswerSegments(left, right) {
  return {
    ...left,
    text: `${String(left.text || "").trim()} ${String(right.text || "").trim()}`.trim(),
    source_ids: [...new Set([...(left.source_ids || []), ...(right.source_ids || [])])],
    citations: [...(left.citations || []), ...(right.citations || [])],
  };
}

function hasOpenMathDelimiter(value) {
  const text = String(value ?? "");
  let mode = "";
  for (let index = 0; index < text.length; index += 1) {
    const token = text.slice(index, index + 2);
    const char = text[index];
    if (mode) {
      if ((mode === "\\)" && token === "\\)") || (mode === "\\]" && token === "\\]") || (mode === "$$" && token === "$$")) {
        mode = "";
        index += 1;
      } else if (mode === "$" && char === "$" && text[index - 1] !== "\\") {
        mode = "";
      }
      continue;
    }
    if (token === "\\(") {
      mode = "\\)";
      index += 1;
    } else if (token === "\\[") {
      mode = "\\]";
      index += 1;
    } else if (token === "$$") {
      mode = "$$";
      index += 1;
    } else if (char === "$" && text[index - 1] !== "\\") {
      mode = "$";
    }
  }
  return Boolean(mode);
}

function looksLikeMathContinuation(value) {
  return /^\s*(?:[}\])）]|_|\^|\\(?:ne|neq|le|ge|frac|sum|int)\b|eq\s+n\}|ne\s+n\}|\|?H['^_]|E[A-Za-z]?\(|psi[A-Za-z]?\()/i.test(String(value ?? ""));
}

function looksLikeDanglingLatexPrefix(value) {
  return /(?:\\|\\[A-Za-z]*|\{[^{}]*|\$[^$]*)\s*$/.test(String(value ?? ""));
}

// =====================================================================
// Agent 模式：开关 / 工具轨迹过程条 / 待确认写操作卡片
// =====================================================================

// 后端 trace 项形如 { name, arguments, observation }，与 /agent 端点完全一致。
const AGENT_TOOL_LABELS = {
  search_sources: "检索资料",
  search_knowledge_base: "检索知识库",
  get_mastery: "查掌握度",
  get_framework: "查知识框架",
  get_node: "读节点详情",
  get_kb_digest: "读知识库摘要",
  search_cards: "检索知识卡片",
  search_quiz: "读取小测验",
  search_highlights: "检索我的笔记",
  get_study_kit: "读速查表/学习路径/清单",
  get_learning_calendar: "读学习台历与冲刺计划",
  search_knowledge_docs: "读复习文档",
  list_sources: "看资料清单",
  plan_study_action: "安排薄弱点后续",
  add_node: "新建节点",
  update_node: "更新节点",
  delete_node: "删除节点",
  create_link: "建立双链",
  recommend_link_gaps: "双链补全建议",
  recommend_links: "双链推荐",
  complete_note: "补全笔记",
  propose_note: "拟笔记稿",
  list_proposals: "查看建议稿",
  campus_query: "校内资讯",
  socratic_ask: "出引导题",
  record_miscue: "记录错因",
  converge: "收敛点",
};

// 默认关闭：没存过偏好时按「普通问答」起步，Agent 工具循环由用户主动打开。
// 存过就认存的值（"on" / "off"），所以这个默认值只影响首次访问。
function readChatAgentPref() {
  try { return localStorage.getItem("knoworigin.chatAgent") === "on"; }
  catch (_) { return false; }
}

function agentToolLabel(name) {
  return AGENT_TOOL_LABELS[name] || String(name || "工具");
}

// 检索工具的观察文本形如「命中 3 段资料」，把它提到折叠标题上，
// 这样一眼就能看出 AI 到底有没有在资料里找到东西（而不是空检索一轮就作答）。
const AGENT_HIT_COUNT_RE = /命中\s*(\d+)\s*段/;

function agentToolLabelWithHits(item) {
  const label = agentToolLabel(item.name);
  if (item.name !== "search_sources") return label;
  const hit = AGENT_HIT_COUNT_RE.exec(String(item.observation || ""));
  return hit ? `${label} · 命中 ${hit[1]} 段` : label;
}

function compactTraceArgs(args) {
  if (!args || typeof args !== "object") return String(args || "");
  const text = Object.entries(args)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("  ");
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

// 折叠时只给一行"用了哪些动作"，展开才看参数与观察摘要：默认不抢正文的视线。
function agentTraceMarkup(trace, running) {
  const items = (Array.isArray(trace) ? trace : []).filter((item) => item && item.name);
  if (!items.length) return "";
  const labels = [...new Set(items.map(agentToolLabelWithHits))];
  const hitLabels = labels.filter((label) => label.includes("命中"));
  const plainLabels = labels.filter((label) => !label.includes("命中"));
  const head = running ? `🛠 正在使用 ${items.length} 个动作` : `🛠 已使用 ${items.length} 个动作`;
  const rows = items.map((item) => {
    const args = compactTraceArgs(item.arguments);
    const observation = String(item.observation || "").replace(/\s+/g, " ").trim();
    const observationText = observation.length > 180 ? `${observation.slice(0, 180)}…` : observation;
    // data-tool 放原始工具名：显示用中文标签，但按类别上色/统计只能靠原始名
    return [
      `<li data-tool="${escapeAttr(item.name)}"><span class="agent-trace-name">${escapeHtml(agentToolLabelWithHits(item))}</span>`,
      args ? `<code class="agent-trace-args">${escapeHtml(args)}</code>` : "",
      observationText ? `<span class="agent-trace-obs">${escapeHtml(observationText)}</span>` : "",
      "</li>",
    ].join("");
  }).join("");
  const summary = `${head} · ${[...plainLabels, ...hitLabels].slice(0, 3).join(" · ")}${labels.length > 3 ? " …" : ""}`;
  return `<details class="message-agent-trace${running ? " is-running" : ""}"><summary>${escapeHtml(summary)}</summary><ol class="agent-trace-list">${rows}</ol></details>`;
}

/* ---- 本轮回答的依据（顶栏按钮 + 挤压式侧栏）----
   要解决的真实问题：回答正文下面那条 🛠 过程条默认折叠，一屏只看得到"已使用 3 个动作"。
   但要紧的不是"用了几个动作"，而是**哪几条回答一个动作都没用** —— 那种答案完全来自模型
   自己的知识，跟用户上传的资料、生成的知识文档都无关，却是长得最像"查过的"那种。

   侧栏为什么挤压对话区而不是盖住它：arXiv:2601.14611（2026-01）把来源展示做了四组对照，
   折叠式平均要戳 4.03 次才看到内容，常驻侧栏鼓励直接 hover（26~33 次）—— 侧栏是"外部
   工作记忆"。盖住对话区等于把那段线性流又挡回去。 */

const EVIDENCE_WIDTH_KEY = "knoworigin.evidenceWidth";
const EVIDENCE_OPEN_KEY = "knoworigin.evidenceOpen";
const EVIDENCE_WIDTH_MIN = 300;
const EVIDENCE_WIDTH_MAX = 760;
const EVIDENCE_WIDTH_DEFAULT = 380;
// 完整视图 = **对话区**展开（用户要的是正文那一片变宽，不是侧栏变宽）：
// 侧栏收成一条 52px 窄边，只留时间线圆点，宽度全让给对话区。
const EVIDENCE_RAIL_W = 52;
const EVIDENCE_CHAT_MIN = 360; // 与 agent-layout.css 里的 minmax(360px,1fr) 必须一致

/* 工具按「读的是什么」分四类上色。分类依据不是工具名，是它返回的东西 ——
   依据面板要让人一眼看出「这条答案的料来自哪一类」，颜色就是那个分类。 */
const EVIDENCE_TOOL_KINDS = {
  list_sources: "source", search_sources: "source", campus_query: "source",
  search_knowledge_docs: "doc", get_study_kit: "doc", search_cards: "doc",
  search_quiz: "doc", search_highlights: "doc",
  get_framework: "kb", get_node: "kb", search_knowledge_base: "kb",
  get_kb_digest: "kb", get_mastery: "kb", get_learning_calendar: "kb",
  add_node: "write", update_node: "write", create_link: "write",
  delete_node: "write", plan_study_action: "write",
};
const EVIDENCE_KIND_VARS = {
  source: { line: "color-mix(in srgb, #3867d6 42%, transparent)", ink: "#3867d6", bg: "color-mix(in srgb, #3867d6 8%, transparent)" },
  doc: { line: "color-mix(in srgb, #7c4dbd 42%, transparent)", ink: "#7c4dbd", bg: "color-mix(in srgb, #7c4dbd 8%, transparent)" },
  kb: { line: "color-mix(in srgb, #bd7a22 45%, transparent)", ink: "#a86a17", bg: "color-mix(in srgb, #bd7a22 10%, transparent)" },
  write: { line: "color-mix(in srgb, #c84b57 45%, transparent)", ink: "#c84b57", bg: "color-mix(in srgb, #c84b57 8%, transparent)" },
};
const EVIDENCE_KIND_LABEL = { source: "资料", doc: "成文产物", kb: "知识库", write: "写入" };

function evidenceKindStyle(kind) {
  const v = EVIDENCE_KIND_VARS[kind];
  return v ? `--chip-line:${v.line};--chip-ink:${v.ink};--chip-bg:${v.bg};` : "";
}

/* ---------------- 宽度：唯一权威是 --evidence-w ---------------- */

/** 上限同时受自身封顶与「对话区至少 EVIDENCE_CHAT_MIN」两条约束。 */
function evidenceWidthMax() {
  const ws = document.getElementById("workspace");
  const available = ws ? ws.getBoundingClientRect().width : 0;
  if (available <= 0) return EVIDENCE_WIDTH_MAX;
  const railAndSessions = 56 + 256;
  return Math.max(EVIDENCE_WIDTH_MIN,
    Math.min(EVIDENCE_WIDTH_MAX, available - railAndSessions - EVIDENCE_CHAT_MIN));
}

function evidenceWidth() {
  // 从 <html> 读：变量定义在那里（.workspace 的 grid-template-columns 与
  // suggested-questions 的避让偏移都要读它），别从 .evidence-panel 读——那是子元素，读不到。
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--evidence-w"));
  if (Number.isFinite(v)) return Math.round(v);
  const panel = document.getElementById("evidence-panel");
  if (panel) {
    const p = parseFloat(getComputedStyle(panel).getPropertyValue("--evidence-w"));
    if (Number.isFinite(p)) return Math.round(p);
  }
  try {
    const saved = Number(localStorage.getItem(EVIDENCE_WIDTH_KEY));
    if (Number.isFinite(saved) && saved >= EVIDENCE_WIDTH_MIN && saved <= EVIDENCE_WIDTH_MAX) return saved;
  } catch { /* Storage may be unavailable. */ }
  return EVIDENCE_WIDTH_DEFAULT;
}

/** 设宽的唯一入口：夹取 + 落盘 + 广播。其它模块（含「完整视图」按钮）一律走这里。 */
function setEvidenceWidth(px, { persist = true, broadcast = true } = {}) {
  const panel = document.getElementById("evidence-panel");
  if (!panel) return evidenceWidth();
  // 完整态是「窄边」，宽度本来就小于常规下限 —— 这时用窄边宽度当下界，
  // 否则永远被夹在 300px，对话区只多让出几十像素，根本不算展开。
  const floor = isEvidenceExpanded() ? EVIDENCE_RAIL_W : EVIDENCE_WIDTH_MIN;
  const next = Math.max(floor, Math.min(evidenceWidthMax(), Math.round(px)));
  document.documentElement.style.setProperty("--evidence-w", `${next}px`);
  if (persist) {
    try { localStorage.setItem(EVIDENCE_WIDTH_KEY, String(next)); } catch { /* ignore */ }
  }
  if (broadcast) {
    try {
      document.dispatchEvent(new CustomEvent("knoworigin:evidence-width", { detail: { width: next } }));
    } catch { /* 广播失败不影响宽度本身 */ }
  }
  return next;
}

function isEvidenceExpanded() {
  // 看 class 而不是量宽度：完整态的宽度是「窄边」，量宽度会分不清
  // 「用户自己拖到很窄」和「进了完整视图」。
  return Boolean(document.getElementById("evidence-panel")?.classList.contains("is-full"));
}

/** 退出完整视图时该回到多宽：优先回进完整态前的那个宽度。 */
function evidenceRestoreWidth() {
  return Math.max(EVIDENCE_WIDTH_MIN, Math.min(evidenceWidthMax(), _fullRestoreWidth || EVIDENCE_WIDTH_DEFAULT));
}

/* ---------------- 开 / 关 ---------------- */

function evidencePanelOpen() {
  const panel = document.getElementById("evidence-panel");
  return Boolean(panel && !panel.hidden);
}

function panelEl() {
  return document.getElementById("evidence-panel");
}

/** 「完整视图」：按宽度判定，所以拖完分隔条按钮状态自动跟上（照 lit-aside-expand-btn 的做法）。 */
function syncEvidenceExpandVisual() {
  const full = isEvidenceExpanded();
  const panel = document.getElementById("evidence-panel");
  const btn = document.getElementById("evidence-expand");
  if (!btn) return;
  btn.setAttribute("aria-pressed", full ? "true" : "false");
  const icon = btn.querySelector(".evidence-expand-icon");
  const text = btn.querySelector(".evidence-expand-text");
  if (icon) icon.textContent = full ? "⤡" : "⤢";
  if (text) text.textContent = full ? "还原" : "完整";
  btn.title = full
    ? "还原依据栏（对话区回到常规宽度）"
    : "完整视图：把宽度全让给对话区，依据栏收成窄边";
}

let _fullRestoreWidth = 0;

function toggleEvidenceExpand() {
  const panel = document.getElementById("evidence-panel");
  if (!panel) return;
  // 面板没开就先开它：否则 html 上只会有 evidence-full、没有 evidence-open，
  // agent-layout.css 的「依据栏占领对话区」那条规则要求两个 class 同时在才生效，
  // 结果就是点了「完整」什么也没发生。
  if (panel.hidden) {
    openEvidence();
    return;
  }
  if (isEvidenceExpanded()) {
    panel.classList.remove("is-full");
    document.documentElement.classList.remove("evidence-full");
    setEvidenceWidth(evidenceRestoreWidth());
  } else {
    // 进完整态前记住当前宽度，退回去时还原
    _fullRestoreWidth = evidenceWidth();
    panel.classList.add("is-full");
    // 完整态是「专注看回答」，把「试试这样问」藏掉：它避让量只有侧栏宽 + 12px，
    // 侧栏收成 52px 后它会正好压住顶栏的「回答依据」按钮。
    document.documentElement.classList.add("evidence-full");
    setEvidenceWidth(EVIDENCE_RAIL_W);
  }
  syncEvidenceExpandVisual();
}

/* 面板开着这件事也要记住：只存在内存里的话，一刷新就关掉，
   用户看到的就是「回答依据没有保存」。 */
function evidenceWantsOpen() {
  try { return localStorage.getItem(EVIDENCE_OPEN_KEY) === "1"; } catch { return false; }
}

function rememberEvidenceOpen(open) {
  try {
    if (open) localStorage.setItem(EVIDENCE_OPEN_KEY, "1");
    else localStorage.removeItem(EVIDENCE_OPEN_KEY);
  } catch { /* ignore */ }
}

/**
 * 历史消息是异步渲染的，init 时面板里还没有内容。所以不在 init 里直接打开，
 * 而是留一个「待恢复」标记，等第一条消息渲染出来再开（见 appendMessage 末尾）。
 * 用完即清，免得用户手动关掉后又被立刻弹回来。
 */
function consumeEvidenceOpenHint() {
  if (!evidenceWantsOpen()) return false;
  rememberEvidenceOpen(false);
  return true;
}

let _evidencePendingOpen = false;

function openEvidence() {
  const panel = document.getElementById("evidence-panel");
  if (!panel) return;
  rememberEvidenceOpen(true);
  // 先把 html 上的变量摆出来再显示：不然首帧会拿 CSS 默认值渲染一下再跳
  setEvidenceWidth(evidenceWidth(), { persist: false });
  panel.hidden = false;
  // 挤压靠 html 上的 class：agent-layout.css 据此给 .workspace 加第 4 列
  document.documentElement.classList.add("evidence-open");
  document.getElementById("evidence-button")?.setAttribute("aria-expanded", "true");
  renderEvidence();
  syncEvidenceExpandVisual();
}

function closeEvidence() {
  const panel = document.getElementById("evidence-panel");
  if (!panel || panel.hidden) return;
  // 用户主动关 = 明确不想看，别在本次会话里又自动弹回来
  _evidencePendingOpen = false;
  rememberEvidenceOpen(false);
  clearEvidenceFocus();
  panel.hidden = true;
  panel.classList.remove("is-full");
  document.documentElement.classList.remove("evidence-open", "evidence-full");
  document.getElementById("evidence-button")?.setAttribute("aria-expanded", "false");
}

function toggleEvidence() {
  if (evidencePanelOpen()) closeEvidence();
  else openEvidence();
}

/* ---------------- 数据：从对话区已经渲染好的过程条读 ---------------- */

function evidenceToolsOf(node) {
  return Array.from(node.querySelectorAll(".message-agent-trace .agent-trace-list li"))
    .map((li) => ({
      name: (li.querySelector(".agent-trace-name")?.textContent || "").trim(),
      // 原始工具名（渲染时写进 data-tool）；旧消息没有这个属性时退回标签匹配
      raw: (li.dataset.tool || "").trim(),
      args: (li.querySelector(".agent-trace-args")?.textContent || "").trim(),
      obs: (li.querySelector(".agent-trace-obs")?.textContent || "").trim(),
    }))
    .filter((tool) => tool.name);
}

/** 落进 HTML 之前的旧消息没有 data-tool：按中文标签反查一次兜底。 */
function evidenceToolKind(tool) {
  if (tool.raw && EVIDENCE_TOOL_KINDS[tool.raw]) return EVIDENCE_TOOL_KINDS[tool.raw];
  const label = String(tool.name).split("·")[0].trim();
  const hit = Object.entries(AGENT_TOOL_LABELS || {}).find(([, text]) => text === label);
  return hit && EVIDENCE_TOOL_KINDS[hit[0]] ? EVIDENCE_TOOL_KINDS[hit[0]] : "other";
}

function evidencePlainText(node, limit = 120) {
  // 提问在 .user-msg-content，回答在 .message-answer-content —— 两种角色取各自的容器，
  // 混用会永远读到空字符串，侧栏就成了每条都显示「无提问记录的回答」。
  const source = node.querySelector(".user-msg-content")
    || node.querySelector(".message-answer-content");
  const raw = (source?.textContent || "").replace(/\s+/g, " ").trim();
  return raw.length > limit ? `${raw.slice(0, limit)}…` : raw;
}

function evidenceTimeOf(node) {
  const time = node.querySelector(".message-meta time[datetime]");
  return time ? time.getAttribute("datetime") || "" : "";
}

/** 一条 assistant 消息 = 一条独立依据记录。
    刻意**不**按「一问一答」合并：同一问下的追问补充常常一条查了工具、一条没查，
    合并过去就等于用有依据的那条替没依据的背书 —— 那正是这个面板要揭出来的。 */
function evidenceTurns() {
  const conv = document.getElementById("conversation");
  if (!conv) return [];
  const turns = [];
  let question = "";
  let questionTime = "";
  for (const node of Array.from(conv.querySelectorAll(".message"))) {
    const isUser = node.dataset.role === "user" || node.classList.contains("user-message");
    if (isUser) {
      question = evidencePlainText(node);
      questionTime = evidenceTimeOf(node);
      continue;
    }
    turns.push({
      q: question,
      time: evidenceTimeOf(node) || questionTime,
      tools: evidenceToolsOf(node),
      node,
    });
  }
  return turns;
}

/* ---------------- 渲染 ---------------- */

function evidenceDonut(ratio) {
  // SVG 环：r=15 的周长约 94.2；用 dasharray 画占比，起点转到 12 点方向
  const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  const c = 2 * Math.PI * 15;
  return `
    <div class="evidence-donut" role="img" aria-label="${pct}% 的回答查过资料">
      <svg viewBox="0 0 36 36" width="42" height="42" aria-hidden="true">
        <circle class="evidence-donut-track" cx="18" cy="18" r="15" fill="none" stroke-width="3.5"></circle>
        <circle class="evidence-donut-fill" cx="18" cy="18" r="15" fill="none" stroke-width="3.5"
          stroke-dasharray="${(c * pct) / 100} ${c}"></circle>
      </svg>
      <span class="evidence-donut-num">${pct}%</span>
    </div>`;
}

function evidenceStats(turns) {
  const bare = turns.filter((turn) => !turn.tools.length).length;
  const toolCount = turns.reduce((sum, turn) => sum + turn.tools.length, 0);
  const grounded = turns.length - bare;
  const ratio = turns.length ? grounded / turns.length : 0;
  return `
    ${evidenceDonut(ratio)}
    <dl class="evidence-stat-list">
      <div class="evidence-stat"><dt>回答</dt><dd>${turns.length}</dd></div>
      <div class="evidence-stat"><dt>动作</dt><dd>${toolCount}</dd></div>
      <div class="evidence-stat${bare ? " is-warn" : ""}"><dt>未查</dt><dd>${bare}</dd></div>
    </dl>`;
}

function evidenceChip(tool) {
  const kind = evidenceToolKind(tool);
  const args = tool.args ? `<span class="evidence-chip-args">${escapeHtml(tool.args)}</span>` : "";
  const detail = tool.obs
    ? `<span class="evidence-chip-detail">${escapeHtml(tool.obs)}</span>`
    : "";
  return `<li class="evidence-chip" tabindex="0" role="button"
      style="${evidenceKindStyle(kind)}"
      title="${escapeAttr(EVIDENCE_KIND_LABEL[kind] || "其他")}：点开看这次调用的返回"
      ><span class="evidence-chip-mark" aria-hidden="true"></span><span class="evidence-chip-name">${escapeHtml(tool.name)}</span>${args}${detail}</li>`;
}

function evidenceTurnHtml(turn, index) {
  const bare = turn.tools.length === 0;
  const when = turn.time ? escapeHtml(formatMessageTime(new Date(turn.time))) : "";
  const note = bare
    ? `<p class="evidence-bare-note"><strong>没有调用任何工具。</strong>这一条的内容来自模型自己的知识，没有依据你上传的资料、生成的知识文档或卡片。</p>`
    : `<ul class="evidence-chips">${turn.tools.map(evidenceChip).join("")}</ul>`;
  return `
    <section class="evidence-turn${bare ? " is-bare" : ""}" data-turn="${index}">
      <div class="evidence-turn-rail" aria-hidden="true"><span class="evidence-dot"></span></div>
      <div class="evidence-turn-card">
        <div class="evidence-turn-head">
          <p class="evidence-turn-q">${escapeHtml(turn.q || "（无提问记录的回答）")}</p>
          ${when ? `<time class="evidence-turn-time">${when}</time>` : ""}
        </div>
        ${note}
      </div>
    </section>`;
}

function renderEvidence() {
  const body = document.getElementById("evidence-body");
  const stats = document.getElementById("evidence-stats");
  const summary = document.getElementById("evidence-summary");
  if (!body) return;
  const turns = evidenceTurns();
  if (!turns.length) {
    if (stats) stats.innerHTML = "";
    body.innerHTML = '<div class="evidence-empty">这段对话还没有回答。<br>先问一句，再回来看它查了什么。</div>';
    if (summary) summary.textContent = "这一问读了什么、调了什么";
    return;
  }
  const bare = turns.filter((turn) => !turn.tools.length).length;
  const toolCount = turns.reduce((sum, turn) => sum + turn.tools.length, 0);
  if (stats) stats.innerHTML = evidenceStats(turns);
  if (summary) {
    summary.textContent = bare
      ? `${turns.length} 条回答 · ${toolCount} 个动作 · ${bare} 条没查任何东西`
      : `${turns.length} 条回答 · ${toolCount} 个动作 · 每条都查了`;
  }
  // 最近的在最上面
  const ordered = turns.map((turn, i) => ({ turn, i })).reverse();
  body.innerHTML = `<div class="evidence-timeline">${ordered
    .map(({ turn, i }) => evidenceTurnHtml(turn, i)).join("")}</div>`;
  bindEvidenceBody();
}

/* ---------------- 与对话联动 ---------------- */

function clearEvidenceFocus() {
  document.querySelectorAll(".conversation .message.is-evidence-focus, .conversation .message.is-evidence-dim")
    .forEach((node) => node.classList.remove("is-evidence-focus", "is-evidence-dim"));
}

/**
 * 指向第 index 条回答：压暗其余、高亮它。
 *
 * ⚠️ 这里**不做任何滚动**。之前用 scrollIntoView({behavior:"smooth"})，结果鼠标在
 * 依据栏里每划过一条就触发一次 —— 而 scrollIntoView 会同时滚动「页面 + 侧栏 +
 * 对话区」三个可滚动祖先，三重动画叠在一起就是右侧滚动时的剧烈抖动。
 * 真要滚动由调用方显式要求（见 bindEvidenceBody 里的点击分支）。
 */
function focusEvidenceTurn(index, { scroll = false } = {}) {
  const conv = document.getElementById("conversation");
  if (!conv) return;
  clearEvidenceFocus();
  const nodes = Array.from(conv.querySelectorAll(".message"));
  let seen = -1;
  let target = null;
  for (const node of nodes) {
    const isUser = node.dataset.role === "user" || node.classList.contains("user-message");
    if (isUser) continue;
    seen += 1;
    if (seen === index) { target = node; break; }
  }
  nodes.forEach((node) => node.classList.add("is-evidence-dim"));
  if (target) {
    target.classList.remove("is-evidence-dim");
    target.classList.add("is-evidence-focus");
    if (scroll) scrollConversationTo(target);
  }
}

/** 只滚对话区自身，不碰页面与侧栏；用 instant —— smooth 在连续触发时同样会抖。 */
function scrollConversationTo(node) {
  const conv = document.getElementById("conversation");
  if (!conv || !node || typeof node.getBoundingClientRect !== "function") return;
  const cRect = conv.getBoundingClientRect();
  const nRect = node.getBoundingClientRect();
  const delta = nRect.top - cRect.top - (cRect.height - nRect.height) / 2;
  if (Math.abs(delta) < 8) return;
  conv.scrollTop += delta;
}

/* 面板开着时新回答自动进来 —— 否则它会停在打开那一瞬的旧状态，比没有更误导 */
function bindEvidenceBody() {
  const body = document.getElementById("evidence-body");
  if (!body || body.dataset.bound === "1") return;
  body.dataset.bound = "1";

  // 芯片点开看返回（完整视图下本来就全展开）
  body.addEventListener("click", (event) => {
    const chip = event.target.closest(".evidence-chip");
    if (!chip) return;
    if (document.getElementById("evidence-panel")?.classList.contains("is-expanded")) return;
    chip.classList.toggle("is-open");
  });
  body.addEventListener("keydown", (event) => {
    const chip = event.target.closest(".evidence-chip");
    if (!chip || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    chip.classList.toggle("is-open");
  });

  // 指向某一条 → 对话里那一条亮起来（Aligned Sidebar 的轻量版）
  // pointerover 会在子元素之间反复冒泡，必须按 turn 序号去重，否则一次划过
  // 能触发十几次（而且每次都会 scrollIntoView，那就是抖动的来源）。
  let lastTurn = null;
  body.addEventListener("pointerover", (event) => {
    const turn = event.target.closest(".evidence-turn");
    const index = turn ? Number(turn.dataset.turn) : null;
    if (index === lastTurn) return;
    lastTurn = index;
    if (index !== null && Number.isFinite(index)) focusEvidenceTurn(index);
  });
  body.addEventListener("pointerleave", () => {
    lastTurn = null;
    clearEvidenceFocus();
  });

  // 点那一条才真的滚过去（hover 不滚，见 focusEvidenceTurn 的注释）
  body.addEventListener("click", (event) => {
    if (event.target.closest(".evidence-chip")) return;
    const turn = event.target.closest(".evidence-turn");
    if (!turn) return;
    const index = Number(turn.dataset.turn);
    if (!Number.isFinite(index)) return;
    // 窄边里只剩圆点，不点一下看不出这是干什么的：先退出完整态把卡片还回来，
    // 再定位到那一条 —— 否则用户点了像没反应。
    if (isEvidenceExpanded()) {
      panelEl()?.classList.remove("is-full");
      document.documentElement.classList.remove("evidence-full");
      setEvidenceWidth(evidenceRestoreWidth());
      syncEvidenceExpandVisual();
      renderEvidence();
    }
    focusEvidenceTurn(index, { scroll: true });
  });
}

/* ---------------- 拖拽 ---------------- */

function bindEvidenceResizer() {
  const panel = document.getElementById("evidence-panel");
  const handle = panel?.querySelector(".evidence-resizer");
  if (!panel || !handle) return;

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("is-dragging");
    document.body.classList.add("is-evidence-resizing");
    const startX = event.clientX;
    const startW = panel.getBoundingClientRect().width;
    // 面板贴着 workspace 右缘：往左拖变宽，所以用起点减位移
    let target = startW;
    const onMove = (move) => {
      if (move.pointerId !== event.pointerId) return;
      target = startW + (startX - move.clientX);
      setEvidenceWidth(target, { persist: false, broadcast: false });
    };
    const onUp = () => {
      handle.classList.remove("is-dragging");
      document.body.classList.remove("is-evidence-resizing");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      // 拖动中不落盘不广播（每秒几十次，没必要）；松手才落盘。
      // 用 target（意图值）而不是 rect：CSS 上有 0.2s 过渡，动画期间渲染宽度落在指针后面。
      setEvidenceWidth(target);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  });

  handle.addEventListener("dblclick", () => setEvidenceWidth(EVIDENCE_WIDTH_DEFAULT));

  handle.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 64 : 20;
    let dir = 0;
    if (event.key === "ArrowLeft") dir = 1;      // 往左 = 变宽
    else if (event.key === "ArrowRight") dir = -1;
    if (!dir) return;
    event.preventDefault();
    setEvidenceWidth(evidenceWidth() + dir * step);
  });
}

function initEvidencePanel() {
  // 刷新后恢复：记下「上次是开着的」，等第一条消息渲染出来再真的打开
  _evidencePendingOpen = consumeEvidenceOpenHint();
  document.getElementById("evidence-button")?.addEventListener("click", toggleEvidence);
  document.getElementById("evidence-close")?.addEventListener("click", closeEvidence);
  document.getElementById("evidence-expand")?.addEventListener("click", toggleEvidenceExpand);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && evidencePanelOpen()) closeEvidence();
  });
  // 拖拽分隔条也会改宽度：跟着广播走，「完整/还原」文案才不会和画面打架
  document.addEventListener("knoworigin:evidence-width", syncEvidenceExpandVisual);
  // 视口变窄时把宽度重新夹一次：不然挤压出来的对话区会被挤没
  window.addEventListener("resize", () => {
    if (evidencePanelOpen()) setEvidenceWidth(evidenceWidth());
  });
  bindEvidenceResizer();
}

// 流式期间的"正在查询"占位：正文区显示动作名，下方挂一条进行中的过程条。
function setStreamingToolStatus(pending, names) {
  if (!pending || !pending.isConnected) return;
  const body = pending.querySelector(".message-answer-content");
  if (!body) return;
  const labels = [...new Set((names || []).map(agentToolLabel))];
  const label = labels.length ? `正在${labels.slice(0, 2).join("、")}…` : "正在查询知识库…";
  body.innerHTML = `<span class="agent-tool-pulse">${escapeHtml(label)}</span>${agentTraceMarkup((names || []).map((name) => ({ name })), true)}`;
}

function toggleChatAgent() {
  state.chatAgent = state.chatAgent === false;
  try {
    localStorage.setItem("knoworigin.chatAgent", state.chatAgent ? "on" : "off");
  } catch (_) {
    /* 隐私模式等场景下写不进去也不影响本次会话内切换 */
  }
  syncChatAgentToggle();
  showToast(state.chatAgent
    ? "已切到 Agent 模式：AI 会自己检索资料、查掌握度，改知识库前会让你确认。"
    : "已切回普通问答：不调用工具，直接基于检索到的资料作答。");
}

function syncChatAgentToggle() {
  const button = $("#chat-agent-toggle");
  if (!button) return;
  const on = state.chatAgent !== false;
  button.classList.toggle("is-on", on);
  button.setAttribute("aria-pressed", on ? "true" : "false");
  button.title = on
    ? "Agent 模式：AI 会自己检索资料、查掌握度，改知识库前先问过你。点一下切回普通问答。"
    : "普通问答：不调用工具，直接基于检索到的资料作答。点一下切到 Agent 模式。";
}

// ---- 待确认的写操作卡片 ----
// Agent 那一轮只是登记（后端 AGENT_WRITE_TOOLS 闸门），真正的写入发生在这里点按钮之后。
// 这一屏没有 kb 面板的收敛条与建议稿审批流，所以确认必须做在消息自身下面。
// 提议型动作（plan_study_action）不是写库操作：它是「针对某个薄弱点，下一步可以做什么」的
// 可点选项。渲染成一排按钮，走前端直接调已有的单节点端点，不进 /agent/actions/execute
// —— 那个端点只认 AGENT_WRITE_TOOLS，提议型动作到那儿会被判「不支持的写操作」。
const AGENT_STUDY_ACTION_LABELS = {
  // 生成族：点一下真的跑一次生成，必须绑在某个知识点上
  card: "生成知识卡片",
  quiz: "生成小测验",
  doc: "生成复习文档",
  cheatsheet: "生成一页速查表",
  learning_path: "生成学习路径",
  checklist: "生成清单报告",
  focus: "只看这个知识点",
  // 跳转族：纯前端切页/定位，不花钱不改数据，所以项目级也能给（可以没有 node）
  view_cards: "看知识卡片",
  view_quiz: "看小测验",
  view_framework: "看知识框架",
  view_overview: "看学习概览",
  view_cheatsheet: "看一页速查表",
  view_learning_path: "看学习路径",
  view_checklist: "看清单报告",
};
const AGENT_STUDY_ACTION_ICONS = {
  card: "▣", quiz: "✓", doc: "📄",
  cheatsheet: "📋", learning_path: "🗺", checklist: "✅", focus: "◎",
  view_cards: "▣", view_quiz: "✓", view_framework: "⌥", view_overview: "◷",
  view_cheatsheet: "📋", view_learning_path: "🗺", view_checklist: "✅",
};

// 哪些选项没有 node_id 就点不动。必须与后端 AGENT_STUDY_ACTION_NODE_KINDS 逐项一致
// （tools/verify_agent_read_scope.py 有交叉断言）—— 两端口径不一致时会出现
// 「后端准了、前端不渲染」的空按钮，或者反过来凭空造个节点去调生成端点。
const AGENT_STUDY_ACTION_NEEDS_NODE = {
  card: true, quiz: true, doc: true, focus: true,
  cheatsheet: true, learning_path: true, checklist: true,
  view_cards: false, view_quiz: false, view_framework: false, view_overview: false,
  view_cheatsheet: false, view_learning_path: false, view_checklist: false,
};

// 成文产物三类：key 直接就是 study_kit.KINDS 的取值，原样透传给 generate 端点。
const AGENT_STUDY_ACTION_KIT_KINDS = ["cheatsheet", "learning_path", "checklist"];

// 跳转族落到哪：全部是既有的入口函数，不新造路由。
const AGENT_STUDY_ACTION_JUMPS = {
  view_cards: () => switchFeature("cards"),
  view_quiz: () => switchFeature("quiz"),
  view_framework: () => switchFeature("framework"),
  view_overview: () => switchFeature("overview"),
  view_cheatsheet: () => openStudyDesk("cheatsheet"),
  view_learning_path: () => openStudyDesk("learning_path"),
  view_checklist: () => openStudyDesk("checklist"),
};

/** 打开学习台历并落到某一门课的那一页（速查表 / 学习路径 / 清单报告）。 */
function openStudyDesk(kind) {
  const calendar = window.KnowOriginCalendar;
  if (!calendar?.open || !window.KnowOriginDesk?.open) {
    showToast("学习台历还没就绪，刷新页面后再试。", "error");
    return false;
  }
  calendar.open();
  return window.KnowOriginDesk.open(state.currentProjectId, kind);
}

// 每个选项的第二行说明。图一那种「标题 + 说明」双行块才是有效的选项卡：
// 一排只写着「生成知识卡片」的小按钮，用户无法判断该选哪个，只能全点一遍。
const AGENT_STUDY_ACTION_HINTS = {
  card: "按这个知识点出记忆卡，翻面看答案，适合碎片时间过一遍",
  quiz: "出 5 道题检验是否真会了，答完给解析并更新掌握度",
  doc: "生成可搜索的复习详解，能就着某一段继续追问",
  cheatsheet: "把这一块压成一页可打印的对照表，考前过一遍",
  learning_path: "列出前置知识、下一步与推荐资源，据此排冲刺节奏",
  checklist: "按掌握度分组的可勾选复习清单，逐项打勾扫尾",
  focus: "只把这个知识点在知识框架里定位高亮，不生成任何内容",
  view_cards: "切到知识卡片页看已有卡片，不生成、不改数据",
  view_quiz: "切到小测验页继续做，不生成、不改数据",
  view_framework: "切到知识框架页看整体结构，不生成、不改数据",
  view_overview: "切到学习概览看掌握度与复习建议，不生成、不改数据",
  view_cheatsheet: "打开学习台历里的一页速查表，不生成、不改数据",
  view_learning_path: "打开学习台历里的学习路径，不生成、不改数据",
  view_checklist: "打开学习台历里的清单报告，不生成、不改数据",
};

// 写操作按工具给一句说明。纯提议型的说明在 AGENT_STUDY_ACTION_HINTS 里。
const AGENT_WRITE_ACTION_HINTS = {
  add_node: "会在知识框架里新建一个节点",
  update_node: "会覆盖该节点被改动的字段（笔记正文 / 标签 / 双链 / 描述）",
  delete_node: "会移除这个节点及其子节点，不可撤销",
  create_link: "会在两个节点之间建一条双链",
};

/** 把 staged_actions 摊平成一张选项表。

    提议型 action 内含多个 kinds，必须摊成独立项 —— 否则「多选」无从谈起，
    也没法逐项汇报进度。index 保留原数组下标，执行时用它反查原始对象
    （不把 JSON 塞进 data 属性：模型给的 arguments 可能很长）。
*/
function agentActionRows(actions) {
  const rows = [];
  (Array.isArray(actions) ? actions : []).forEach((action, index) => {
    if (!action || !action.tool) return;
    if (action.tool !== "plan_study_action") {
      rows.push({
        index,
        kind: "write",
        tool: action.tool,
        action,
        title: action.label || action.tool,
        hint: AGENT_WRITE_ACTION_HINTS[action.tool] || "",
      });
      return;
    }
    const args = action?.arguments || {};
    const nodeId = String(args.node_id || "").trim();
    const nodeName = String(args.node_name || "");
    const scope = nodeName || nodeId;
    (Array.isArray(args.kinds) ? args.kinds : [])
      .filter((k) => AGENT_STUDY_ACTION_LABELS[k])
      // 跳转族是项目级的可以没有 node；生成族缺 node 就点不动，整项不渲染
      .filter((k) => nodeId || !AGENT_STUDY_ACTION_NEEDS_NODE[k])
      .forEach((offerKind) => rows.push({
        index,
        kind: "offer",
        offerKind,
        action,
        nodeId,
        nodeName,
        title: AGENT_STUDY_ACTION_LABELS[offerKind],
        hint: AGENT_STUDY_ACTION_HINTS[offerKind] || "",
        scope: scope && AGENT_STUDY_ACTION_NEEDS_NODE[offerKind] ? scope : "",
      }));
  });
  return rows;
}

/** 默认勾哪些。

    生成族只勾第一项 —— 一次生成七个产物既慢又烧网关，而 AI 已经把最该做的排在最前；
    写库族全勾 —— 「待确认」的意义是用户过一遍再执行，全都勾上才不会让用户
    误以为「我确认了」其实只执行了一项。
*/
function agentActionDefaultChecked(row, position) {
  return row.kind === "write" || position === 0;
}

function agentActionRowMarkup(row, position) {
  const checked = agentActionDefaultChecked(row, position);
  const payload = row.kind === "offer"
    ? ` data-agent-offer-kind="${escapeHtml(row.offerKind)}"
       data-agent-offer-node="${escapeHtml(row.nodeId)}"
       data-agent-offer-name="${escapeHtml(row.nodeName)}"`
    : "";
  return `
    <li class="agent-action-item${checked ? " is-picked" : ""}" data-agent-action-index="${row.index}"
        data-agent-action-row="${row.kind}"${payload}>
      <label class="agent-action-option">
        <input type="checkbox" data-agent-action-check${checked ? " checked" : ""}>
        <span class="agent-action-box" aria-hidden="true"></span>
        <span class="agent-action-main">
          <span class="agent-action-label">${escapeHtml(row.title)}</span>
          ${row.hint ? `<span class="agent-action-desc">${escapeHtml(row.hint)}${
            row.scope ? ` · 针对「${escapeHtml(row.scope)}」` : ""}</span>` : ""}
        </span>
      </label>
      ${row.kind === "write" ? `<code class="agent-action-tool">${escapeHtml(row.tool)}</code>` : ""}
    </li>`;
}

function agentActionCardMarkup(actions) {
  const rows = agentActionRows(actions);
  if (!rows.length) return "";
  const hasWrite = rows.some((row) => row.kind === "write");
  const hasOffer = rows.some((row) => row.kind === "offer");
  const title = hasWrite
    ? `待你确认 ${rows.length} 项修改`
    : hasOffer ? `接下来可以这样学（${rows.length} 项）` : "待你确认";
  const hint = hasWrite && hasOffer
    ? "改知识库与生成学习产物会一并执行，勾掉不想做的再提交。"
    : hasWrite
      ? "这些会改动你的知识库。勾掉不想做的，再提交。"
      : "勾选要做的项目再提交；提交前不会生成任何东西。";
  // AI 给的理由放在正文顶部 —— 它是判断「该不该信这几项」的唯一依据。
  const reason = (Array.isArray(actions) ? actions : [])
    .map((action) => String(action?.arguments?.reason || "").trim())
    .find(Boolean) || "";
  const body = rows.map((row, i) => agentActionRowMarkup(row, i)).join("");
  // 计数在纯函数里就算对，别等 bind 时再同步 —— 否则首屏会闪一下「0/N」，
  // 而实际已经勾好了一项，用户会以为勾选没生效。
  const pickedCount = rows.filter((row, i) => agentActionDefaultChecked(row, i)).length;
  return `
    <div class="agent-action-card" data-agent-action-card>
      <div class="agent-action-shell">
        <button type="button" class="agent-action-head" data-agent-action-toggle aria-expanded="true">
          <span class="agent-action-title">${escapeHtml(title)}</span>
          <span class="agent-action-head-right">
            <span class="agent-action-count" data-agent-action-count>${pickedCount}/${rows.length}</span>
            <span class="agent-action-caret" aria-hidden="true"></span>
          </span>
        </button>
        <div class="agent-action-body" data-agent-action-body>
          ${reason ? `<p class="agent-action-reason">${escapeHtml(reason)}</p>` : ""}
          <div class="agent-action-progress" data-agent-action-progress hidden>
            <span class="agent-action-progress-bar" data-agent-action-progress-bar></span>
          </div>
          <ul class="agent-action-list">${body}</ul>
          <p class="agent-action-hint">${escapeHtml(hint)}</p>
        </div>
      </div>
      <div class="agent-action-actions">
        <button type="button" class="agent-action-dismiss" data-agent-action-dismiss>忽略</button>
        <div class="agent-action-actions-right">
          <button type="button" class="agent-action-stop" data-agent-action-stop hidden>不再等待</button>
          <button type="button" class="agent-action-run" data-agent-action-run>提交</button>
        </div>
      </div>
      <div class="agent-action-status" data-agent-action-status></div>
      <div class="agent-action-result" data-agent-action-result></div>
    </div>`;
}

// 生成一次产物要走网关，常见几十秒。没有超时的话按钮会一直停在「执行中」，
// 用户既分不清「还在跑」还是「已经死了」，也没法重试 —— 这就是「一直加载」体感。
const AGENT_ACTION_TIMEOUT_MS = 90_000;

/** 发一次带超时、且可被用户中止的请求。

    超时与主动中止必须分开报：前者是「慢」，用户该重试；后者是用户自己不想等了，
    后端可能仍在继续 —— 提示文案要说清这一点，否则用户会误以为操作被撤销了。
*/
function agentRequest(path, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    const error = new Error(`等了 ${Math.round(timeoutMs / 1000)} 秒还没返回，已停下。可以点重试。`);
    error.code = "timeout";
    controller.abort(error);
  }, timeoutMs);
  return {
    abort: (reason) => controller.abort(reason),
    promise: api(path, { ...options, signal: controller.signal })
      .catch((error) => {
        if (error?.name === "AbortError") throw controller.signal.reason || error;
        throw error;
      })
      .finally(() => clearTimeout(timer)),
  };
}

// 提议型动作的执行器。分三族，走三条既有通路：
//   · 跳转族  —— 纯前端切页/定位，什么都不调；
//   · 成文产物 —— study-kit/generate（项目级端点，node_id 可选，聚焦到那棵子树）；
//   · 单节点生成 —— card / quiz / doc 三个节点端点，本来就是速查表「＋卡片/＋测验/＋文档」
//     在用的，agent 只是把同一个入口做成可点选项；focus 则纯前端定位。
// 全部不进 /agent/actions/execute：那个端点只认 AGENT_WRITE_TOOLS。
// register(path, options) 由调用方提供：它建 AbortController 并挂到「不再等待」上。
// 返回 { ok, message }，由调用方汇总进度 —— 不自己往 DOM 写结果行，
// 否则重试时几处结果会互相覆盖，用户看到的是哪一条都说不清。
async function runAgentOfferAction(row, register) {
  const kind = row.offerKind;
  const nodeId = row.nodeId;
  const label = row.title;
  // 跳转族与 focus 是瞬时的：不碰网络、没有失败可能，也就**不该**让它们进加载态。
  // 之前这里统一设了「处理中…」再 return，按钮就永久停在那儿 —— 这正是
  // 「一直加载」的来源：用户点了「看知识卡片」，界面却像卡死了。
  if (AGENT_STUDY_ACTION_JUMPS[kind]) {
    AGENT_STUDY_ACTION_JUMPS[kind]();
    return { ok: true, message: `已跳到${label}` };
  }
  if (kind === "focus") {
    if (typeof jumpToKbNode !== "function") throw new Error("定位功能不可用");
    jumpToKbNode(nodeId);
    return { ok: true, message: `已定位到「${row.nodeName || nodeId}」` };
  }
  if (AGENT_STUDY_ACTION_KIT_KINDS.includes(kind)) {
    const data = await register(
      `/api/projects/${encodeURIComponent(state.currentProjectId)}/study-kit/generate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nodeId ? { kind, node_id: nodeId } : { kind }),
      },
    ).promise;
    const kitLabel = data?.kit?.kind_label || label;
    // openStudyDesk 内部会 loadKits 重拉；成文产物不碰知识库，不用 refreshCurrentProject。
    openStudyDesk(kind);
    return { ok: true, message: `已生成${kitLabel}${row.nodeName ? `（针对「${row.nodeName}」）` : ""}` };
  }
  const base = `/api/projects/${encodeURIComponent(state.currentProjectId)}/nodes/${encodeURIComponent(nodeId)}`;
  const endpoint = { card: `${base}/card`, quiz: `${base}/quiz`, doc: `${base}/doc` }[kind];
  if (!endpoint) throw new Error("未知的操作类型");
  const body = kind === "card" ? { difficulty: 2, count: 3 }
    : kind === "quiz" ? { difficulty: 2, question_count: 5 } : {};
  // 这三个端点都要网关 key；没有 key 时后端回 503，要把原因原样告诉用户，不能吞成「执行失败」。
  const data = await register(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).promise;
  const what = kind === "card" ? `${(data?.cards || []).length} 张知识卡片`
    : kind === "quiz" ? `${(data?.questions || []).length} 道小测验题`
    : "复习文档";
  if (kind === "doc") {
    window.KnowOriginKnowledgeDoc?.openOrGenerate?.(nodeId, row.nodeName);
  } else {
    switchFeature(kind === "card" ? "cards" : "quiz");
  }
  await refreshCurrentProject();
  return { ok: true, message: `已生成${what}${row.nodeName ? `（针对「${row.nodeName}」）` : ""}` };
}

function agentActionSetStatus(card, text, tone) {
  const status = card.querySelector("[data-agent-action-status]");
  if (!status) return;
  status.textContent = text || "";
  status.className = `agent-action-status${tone ? ` is-${tone}` : ""}`;
  status.hidden = !text;
}

function agentActionSetProgress(card, done, total) {
  const bar = card.querySelector("[data-agent-action-progress-bar]");
  const wrap = card.querySelector("[data-agent-action-progress]");
  if (!bar || !wrap) return;
  wrap.hidden = false;
  const ratio = total > 0 ? Math.min(1, done / total) : 0;
  bar.style.width = `${Math.round(ratio * 100)}%`;
}

/** 同步「已选 M/N」计数，并返回当前勾上的**行节点**（不是 row 对象）。 */
function agentActionSyncCount(card) {
  const rows = [...card.querySelectorAll("[data-agent-action-row]")];
  const checkedNodes = rows.filter((row) => row.querySelector("[data-agent-action-check]")?.checked);
  const counter = card.querySelector("[data-agent-action-count]");
  if (counter) counter.textContent = `${checkedNodes.length}/${rows.length}`;
  return checkedNodes;
}

function bindAgentActionCard(article, actions) {
  const card = article?.querySelector("[data-agent-action-card]");
  if (!card || !state.currentProjectId) return;
  // 反查表：DOM 上只留 index 与 kind，原始 action（含 arguments）留在这份 Map 里。
  const rowsByIndex = new Map(agentActionRows(actions).map((row) => [
    `${row.index}:${row.kind === "offer" ? row.offerKind : "write"}`, row,
  ]));
  const result = card.querySelector("[data-agent-action-result]");
  const runButton = card.querySelector("[data-agent-action-run]");
  const stopButton = card.querySelector("[data-agent-action-stop]");
  let running = false;

  agentActionSyncCount(card);

  card.querySelector("[data-agent-action-toggle]")?.addEventListener("click", () => {
    const head = card.querySelector("[data-agent-action-toggle]");
    const body = card.querySelector("[data-agent-action-body]");
    const collapsed = card.classList.toggle("is-collapsed");
    body.hidden = collapsed;
    head.setAttribute("aria-expanded", collapsed ? "false" : "true");
  });
  card.querySelector("[data-agent-action-dismiss]")?.addEventListener("click", () => {
    card.classList.add("is-dismissed");
    card.querySelector(".agent-action-actions")?.remove();
  });
  // 勾选变化只更新计数，不重排 DOM —— 正在跑的那一项不能因为用户又勾了一个而跳走。
  card.addEventListener("change", (event) => {
    if (!event.target.matches("[data-agent-action-check]")) return;
    event.target.closest("[data-agent-action-row]")?.classList.toggle(
      "is-picked", event.target.checked);
    agentActionSyncCount(card);
  });
  stopButton?.addEventListener("click", () => {
    // 只停「正在飞的那一个请求」：没在飞时点它没意义，但也不该报错。
    const reason = new Error("已停止等待（后端可能仍在继续，刷新后可见结果）。");
    reason.code = "aborted";
    card.__agentAbort?.(reason);
  });

  runButton?.addEventListener("click", async () => {
    if (running) return;
    const picked = agentActionSyncCount(card);
    if (!picked.length) {
      showToast("请先勾选要执行的项目。", "error");
      return;
    }
    running = true;
    card.classList.add("is-running");
    card.classList.remove("is-done");
    runButton.disabled = true;
    runButton.textContent = "执行中…";
    if (stopButton) stopButton.hidden = false;
    result.innerHTML = "";
    agentActionSetProgress(card, 0, picked.length);

    const writeRows = [];
    const offerRows = [];
    for (const node of picked) {
      const row = rowsByIndex.get(
        `${node.dataset.agentActionIndex}:${node.dataset.agentActionRow === "offer"
          ? node.dataset.agentOfferKind : "write"}`);
      if (row) (row.kind === "write" ? writeRows : offerRows).push(row);
    }

    const lines = [];
    const settled = new Set();
    const keyOf = (row) => `${row.index}:${row.kind === "offer" ? row.offerKind : "write"}`;
    const pushLine = (row, res) => {
      if (res.ok) settled.add(keyOf(row));
      lines.push(
        `<div class="agent-action-line ${res.ok ? "is-ok" : "is-fail"}">`
        + `${res.ok ? "✅" : "⚠️"} ${escapeHtml(row.title)}：${escapeHtml(
          String(res.message || "").slice(0, 200))}</div>`);
    };
    let done = 0;
    let failed = 0;
    let stopped = false;

    // 写库类一次性提交：走 /agent/actions/execute，后端逐条 try，单条失败不影响其它。
    if (writeRows.length) {
      done += 1;
      agentActionSetStatus(card, `正在写入知识库… ${done}/${picked.length}`, "run");
      agentActionSetProgress(card, done, picked.length);
      try {
        const data = await api(
          `/api/projects/${encodeURIComponent(state.currentProjectId)}/agent/actions/execute`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              actions: writeRows.map((row) => row.action),
              conversation_id: state.chatSessionId || "",
            }),
          }
        );
        const results = Array.isArray(data.results) ? data.results : [];
        results.forEach((item, i) => {
          const row = writeRows[i] || writeRows[0];
          const ok = Boolean(item.ok);
          if (!ok) failed += 1;
          pushLine(row, { ok, message: item.label || item.message || item.tool });
        });
        if (results.length !== writeRows.length) {
          failed += writeRows.length - results.length;
          lines.push(`<div class="agent-action-line is-fail">⚠️ 有 ${writeRows.length - results.length} 项没有返回结果</div>`);
        }
      } catch (error) {
        failed += writeRows.length;
        writeRows.forEach((row) => pushLine(row, { ok: false, message: error.message || "执行失败。" }));
      }
      // 节点可能新增/删除/改链，图谱与知识框架要跟着重画
      await refreshCurrentProject();
    }

    // 生成类逐项串行：并发放网关会把配额打爆，而且进度条会一次跳到 100%。
    // register 在这里造带超时的请求，并把 abort 句柄挂到卡片上供「不再等待」按。
    for (const row of offerRows) {
      if (stopped) {
        pushLine(row, { ok: false, message: "已跳过（你点了「不再等待」）" });
        failed += 1;
        continue;
      }
      agentActionSetStatus(card, `正在${row.title}… ${done}/${picked.length}`, "run");
      try {
        const res = await runAgentOfferAction(row, (path, options) => {
          const handle = agentRequest(path, options, AGENT_ACTION_TIMEOUT_MS);
          card.__agentAbort = handle.abort;
          return handle;
        });
        card.__agentAbort = null;
        pushLine(row, res);
      } catch (error) {
        card.__agentAbort = null;
        failed += 1;
        // 用户主动中止：后续几项不再发起，标成「已跳过」而不是「失败」——
        // 混成失败会让完成态显示成红色，用户以为操作出错，其实是他自己停的。
        if (error.code === "aborted") stopped = true;
        pushLine(row, {
          ok: false,
          message: error.code === "aborted"
            ? "已停止等待（后端可能仍在继续，刷新后可见结果）"
            : error.message || "执行失败。",
        });
      }
      done += 1;
      agentActionSetProgress(card, done, picked.length);
      result.innerHTML = lines.join("");
    }

    card.__agentAbort = null;
    result.innerHTML = lines.join("");
    card.classList.remove("is-running");
    if (stopButton) stopButton.hidden = true;
    runButton.disabled = false;
    running = false;
    const okCount = picked.length - failed;
    if (stopped) {
      agentActionSetStatus(card, `已停止等待 · 完成 ${okCount}/${picked.length} 项`, "warn");
    } else if (failed) {
      agentActionSetStatus(card, `完成 ${okCount}/${picked.length} 项，${failed} 项未成功`, "warn");
    } else {
      agentActionSetStatus(card, `✅ ${picked.length} 项全部完成`, "ok");
      card.classList.add("is-done");
      runButton.textContent = "已完成";
      runButton.disabled = true;
      showToast(`${picked.length} 项已全部完成。`);
      return;
    }
    // 有失败或被中止：只把没成功的重新勾上，用户直接再点一次提交即可，
    // 不必从头再选一遍（长列表里重新勾选是最容易放弃的地方）。
    runButton.textContent = stopped ? "重试未完成项" : `重试 ${failed} 项`;
    for (const node of card.querySelectorAll("[data-agent-action-row]")) {
      const key = `${node.dataset.agentActionIndex}:${
        node.dataset.agentActionRow === "offer" ? node.dataset.agentOfferKind : "write"}`;
      const check = node.querySelector("[data-agent-action-check]");
      const pickedNow = !settled.has(key);
      if (check) check.checked = pickedNow;
      node.classList.toggle("is-picked", pickedNow);
      node.classList.toggle("is-ok", settled.has(key));
      node.classList.toggle("is-fail", !settled.has(key) && done > 0);
    }
    agentActionSyncCount(card);
    showToast(stopped
      ? `已停止等待，完成 ${okCount}/${picked.length} 项。`
      : `完成 ${okCount}/${picked.length} 项，${failed} 项未成功（见卡片说明）。`, "error");
  });
}

function messageMetaMarkup(meta, tags, timeMarkup) {
  // tool_trace = 本轮 SSE 终态带来的轨迹；meta.trace = 落库后重读历史时的同一份轨迹。
  //
  // ⚠️ 历史消息还有**第三层嵌套**：renderConversationHistory 传进来的是整条 message，
  // 它的形状是 {message_id, role, content, meta:{trace:[...], ...}} —— 真值在
  // meta.meta.trace，顶层的 meta.trace 是 undefined。以前只认前两种，
  // 于是**刷新后所有历史回答的过程条全部消失**（对话里看不到 🛠，依据栏也读不到）。
  const inner = meta && typeof meta.meta === "object" && meta.meta ? meta.meta : null;
  const trace = (meta && (meta.tool_trace || meta.trace))
    || (inner && (inner.tool_trace || inner.trace));
  const traceMarkup = agentTraceMarkup(trace);
  const isFallback = Boolean((meta && meta.fallback) || (inner && inner.fallback));
  if (!isFallback && !tags && !timeMarkup && !traceMarkup) return "";
  const fallback = isFallback ? '<i class="fallback-chip">演示内容</i>未调用模型 API' : "";
  const sourceSummary = tags ? `<span class="message-source-summary">${escapeHtml(tags)}</span>` : "";
  const metaLine = (!isFallback && !tags && !timeMarkup)
    ? ""
    : `<span class="message-meta">${fallback}${sourceSummary}${timeMarkup}</span>`;
  return traceMarkup + metaLine;
}

function messageTimeMarkup(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `<time class="message-time" datetime="${escapeAttr(date.toISOString())}">${escapeHtml(formatMessageTime(date))}</time>`;
}

function formatMessageTime(date) {
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return time;
  return `${date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })} ${time}`;
}

function attachQuestionFavoriteAction(article, questionMessageId, answerMessageId) {
  if (!article || !questionMessageId || !answerMessageId) return;
  const container = article.querySelector(":scope > div");
  if (!container) return;
  const actions = document.createElement("div");
  actions.className = "message-favorite-actions";
  article.dataset.questionMessageId = questionMessageId;
  article.dataset.messageId = answerMessageId;
  article.classList.toggle("message-sources-hidden", !state.shownSourceMessageIds.has(answerMessageId));
  actions.innerHTML = messageActionMenuMarkup(questionMessageId, answerMessageId);
  container.append(actions);
  syncFavoriteButtons("question", questionMessageId);
}

function messageActionMenuMarkup(questionMessageId, answerMessageId) {
  const favorite = findFavorite("question", questionMessageId);
  const sourcesHidden = !state.shownSourceMessageIds.has(answerMessageId);
  return `<details class="study-item-menu message-item-menu"><summary aria-label="更多操作" title="更多操作"><span aria-hidden="true">⋮</span></summary><div class="study-item-menu-popover message-item-menu-popover" role="menu"><button type="button" role="menuitem" data-message-action="favorite" data-item-type="question" data-origin-id="${escapeAttr(questionMessageId)}" data-answer-id="${escapeAttr(answerMessageId)}" data-empty-label="收藏">${favorite ? "取消收藏" : "收藏"}</button><button type="button" role="menuitem" data-message-action="toggle-sources" data-message-id="${escapeAttr(answerMessageId)}">${sourcesHidden ? "显示来源" : "隐藏来源"}</button><button class="danger" type="button" role="menuitem" data-message-action="delete" data-question-id="${escapeAttr(questionMessageId)}" data-answer-id="${escapeAttr(answerMessageId)}">删除对话</button></div></details>`;
}

async function deleteConversationPair(button) {
  const messageIds = [button.dataset.questionId, button.dataset.answerId].filter(Boolean);
  if (!state.currentProjectId || !messageIds.length) return;
  if (!window.confirm("确认删除这段对话？")) return;
  button.disabled = true;
  try {
    const data = await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/messages`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message_ids: messageIds }),
    });
    const deletedIds = new Set(data.message_ids || messageIds);
    deletedIds.forEach((messageId) => {
      $(`.message[data-message-id="${cssEscape(messageId)}"]`)?.remove();
      state.shownSourceMessageIds.delete(messageId);
    });
    saveShownSourceMessageIds();
    showNotice("已删除这段对话。");
  } catch (error) {
    showError(error, () => deleteConversationPair(button));
  } finally {
    button.disabled = false;
  }
}

function toggleMessageSources(button) {
  const messageId = button.dataset.messageId;
  if (!messageId) return;
  const hidden = state.shownSourceMessageIds.has(messageId);
  if (hidden) state.shownSourceMessageIds.delete(messageId);
  else state.shownSourceMessageIds.add(messageId);
  $$(`.message[data-message-id="${cssEscape(messageId)}"]`).forEach((article) => {
    article.classList.toggle("message-sources-hidden", hidden);
    article.querySelectorAll('[data-message-action="toggle-sources"]').forEach((toggle) => {
      toggle.textContent = hidden ? "显示来源" : "隐藏来源";
    });
  });
  saveShownSourceMessageIds();
}

function renderProblemImagePreview() {
  const preview = $("#problem-image-preview");
  if (!state.problemImage || !state.problemImageUrl) {
    preview.innerHTML = "";
    preview.classList.add("hidden");
    return;
  }
  preview.innerHTML = `<img src="${escapeAttr(state.problemImageUrl)}" alt="待发送的题目截图"><small title="${escapeAttr(state.problemImage.name)}">${escapeHtml(state.problemImage.name)}</small><button class="remove-attachment" type="button" aria-label="移除题目截图">×</button>`;
  preview.classList.remove("hidden");
  preview.querySelector(".remove-attachment").addEventListener("click", clearProblemImage);
}

function clearProblemImage() {
  if (state.problemImageUrl) URL.revokeObjectURL(state.problemImageUrl);
  state.problemImage = null;
  state.problemImageUrl = "";
  const input = $("#problem-image-input");
  if (input) input.value = "";
  const preview = $("#problem-image-preview");
  if (preview) {
    preview.innerHTML = "";
    preview.classList.add("hidden");
  }
  if ($("#mapping-hint")) updateMappingHint();
}

function handlePasteImage(event) {
  const items = event.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (!file) continue;
      if (!["image/png", "image/jpeg"].includes(file.type)) {
        showError(new Error("仅支持 PNG、JPG 或 JPEG 格式的图片。"));
        continue;
      }
      if (file.size > 10 * 1024 * 1024) {
        showError(new Error("图片不能超过 10 MB。"));
        continue;
      }
      clearProblemImage();
      state.problemImage = file;
      state.problemImageUrl = URL.createObjectURL(file);
      renderProblemImagePreview();
      updateMappingHint();
      event.preventDefault();
      break;
    }
  }
}

function startVoiceInput() {
  if (!("webkitSpeechRecognition" in window || "SpeechRecognition" in window)) {
    showError(new Error("您的浏览器不支持语音输入。"));
    return;
  }
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const recognition = new Recognition();
  recognition.lang = "zh-CN";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  const input = $("#message-input");
  input.placeholder = "正在聆听…";
  recognition.start();
  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    input.value = input.value ? input.value + " " + transcript : transcript;
    input.placeholder = "粘贴题目，Agent 会给出来源内的分析路径…";
    autoResizeMessageInput();
    updateMappingHint();
  };
  recognition.onerror = () => {
    input.placeholder = "粘贴题目，Agent 会给出来源内的分析路径…";
    showError(new Error("语音输入失败，请重试或手动输入。"));
  };
  recognition.onend = () => {
    input.placeholder = "粘贴题目，Agent 会给出来源内的分析路径…";
  };
}

function setComposerSending(sending) {
  state.sending = sending;
  const button = $("#send-button");
  button.disabled = sending;
  button.textContent = sending ? "处理中…" : "发送";
  $("#message-input").disabled = sending;
  if ($("#voice-input-button")) $("#voice-input-button").disabled = sending;
}

function inferIntent(text, hasImage = false) {
  if (hasImage) return "solve";
  const normalized = text.trim();
  if (!normalized) return "chat";
  const problemSignals = /(第\s*\d+\s*题|已知|求证|证明|计算|解方程|选择题|填空题|下列.{0,12}(正确|错误)|请解答|求.{0,18}(值|范围|焦距|位置|大小)|＝|=)/;
  return problemSignals.test(normalized) ? "solve" : "chat";
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("无法读取题目截图。"));
    reader.readAsDataURL(file);
  });
}

function renderAnswerSegment(segment, sourceRefs = [], messageId = "pending", index = 0) {
  const refs = new Map([
    ...state.sources.map((source) => [source.source_id, source.filename]),
    ...(sourceRefs || []).map((source) => [source.source_id, source.filename]),
  ]);
  const sourceIds = Array.isArray(segment.source_ids) ? segment.source_ids : [];
  const citationQuotes = new Map(
    (Array.isArray(segment.citations) ? segment.citations : [])
      .filter((citation) => citation?.source_id)
      .map((citation) => [citation.source_id, citation.quote || ""]),
  );
  const citations = sourceIds.length
    ? `<span class="sentence-citations">${sourceIds.map((sourceId) => {
      const filename = refs.get(sourceId) || "未知材料";
      const quote = citationQuotes.get(sourceId) || "";
      return `<button class="citation-chip" type="button" data-source-id="${escapeAttr(sourceId)}" data-quote="${escapeAttr(quote)}" title="查看来源：${escapeAttr(filename)}">来源：${escapeHtml(filename)}</button>`;
    }).join("")}</span>`
    : "";
  const presentation = answerSegmentPresentation(segment.text);
  const marker = presentation.marker ? `<span class="answer-segment-marker">${presentation.marker}</span>` : "";
  const displayMathClass = containsDisplayMath(presentation.text) ? " answer-segment-display-math" : "";
  const tableRows = parseAnswerTableRows(segment.text);
  const body = tableRows
    ? renderStudyTableMarkup(tableRows)
    : highlightableMarkup(`message:${messageId}:segment:${index}`, renderAnswerTextContent(presentation.text), "answer-segment-body");
  return `<div class="answer-segment ${presentation.className}${displayMathClass}">${marker}${body}${citations}</div>`;
}

function renderAnswerTextContent(value) {
  const text = String(value ?? "");
  const strongPattern = /\*\*([^*]+)\*\*/g;
  let markup = "";
  let cursor = 0;
  for (const match of text.matchAll(strongPattern)) {
    markup += renderMathContent(text.slice(cursor, match.index));
    markup += `<strong>${renderMathContent(match[1])}</strong>`;
    cursor = match.index + match[0].length;
  }
  markup += renderMathContent(text.slice(cursor));
  return markup;
}

function lineBlockPresentation(value) {
  const text = String(value ?? "").trim();
  const heading = text.match(/^#{1,4}\s*(.+)$/);
  if (heading) return { type: "heading", text: heading[1].trim(), marker: "" };

  const ordered = text.match(/^(\d+(?:[.)]|\u3001|\uFF0E|\u3002))\s*(.+)$/u);
  if (ordered) {
    // Defense: if marker is "." and rest starts with digit+decimal/sci-notation,
    // this is a decimal (e.g. "2. 529×10⁻¹⁰"), not a list item.
    const markerChar = ordered[1][ordered[1].length - 1];
    const rest = ordered[2];
    if (markerChar === "." && /^\d[\d\s.,×eE+\-⁺⁻]+/.test(rest)) {
      return { type: "text", text, marker: "" };
    }
    return { type: "ordered", text: rest.trim(), marker: ordered[1] };
  }

  const parenthesized = text.match(/^[\uFF08(](\d+)[)\uFF09]\s*(.+)$/u);
  if (parenthesized) return { type: "ordered", text: parenthesized[2].trim(), marker: `${parenthesized[1]}.` };

  const unordered = text.match(/^[-*]\s+(.+)$/) || text.match(/^[\u2022\u00B7]\s*(.+)$/u);
  if (unordered) return { type: "unordered", text: unordered[1].trim(), marker: "\u2022" };

  return { type: "text", text, marker: "" };
}

function isDisplayMathOnly(value) {
  return /^(?:\\\[[\s\S]*\\\]|\$\$[\s\S]*\$\$)$/.test(String(value ?? "").trim());
}

function shouldPromoteStudyHeading(block, nextLine) {
  if (block.type !== "ordered") return false;
  return isDisplayMathOnly(nextLine) || /^\*\*[^*]+\*\*$/.test(block.text);
}

function answerSegmentPresentation(value) {
  const block = lineBlockPresentation(normalizeMarkdownEscapesForRender(value));
  if (block.type === "heading") return { text: block.text, marker: "", className: "answer-segment-heading" };
  if (block.type === "ordered") return { text: block.text, marker: block.marker, className: "answer-segment-list" };
  if (block.type === "unordered") return { text: block.text, marker: "\u2022", className: "answer-segment-list" };
  return { text: block.text, marker: "", className: "" };
}

function normalizeMarkdownEscapesForRender(value) {
  let s = String(value ?? "");
  // Safety net: convert LITERAL \n (backslash + letter n) that slipped past the
  // backend cleaner into real newlines when 'n' is NOT followed by a latin letter
  // (so real LaTeX commands \nabla, \nu, \neg, \neq, \newline etc. are preserved).
  // Do the same for literal \r and \t.
  s = s.replace(/\\t(?![A-Za-z])/g, "\t").replace(/\\r(?![A-Za-z])/g, "\r").replace(/\\n(?![A-Za-z])/g, "\n");
  return s.replace(/\\-/g, "-");
}

function renderStudyTextContent(value) {
  // Also normalize literal \n here (before Phase A math protection) so text like
  // "解法：...\n其中，..." properly splits into lines. Preserve LaTeX \n-commands.
  let normalized = String(value ?? "")
    .replace(/\\t(?![A-Za-z])/g, "\t")
    .replace(/\\r(?![A-Za-z])/g, "\r")
    .replace(/\\n(?![A-Za-z])/g, "\n")
    .replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";
  // ---- Phase A: Protect ALL math blocks (display + inline) from being split on newlines ----
  // Covers: \[...\], $$...$$, \(...\), $...$
  const mathPlaceholders = [];
  const pushPlaceholder = (match) => {
    const id = `\x00MATH${mathPlaceholders.length}\x00`;
    mathPlaceholders.push(match);
    return id;
  };
  let protected_ = normalized
    .replace(/\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$/g, pushPlaceholder)   // display
    .replace(/\\\([\s\S]*?\\\)|\$(?!\s)[^$\n]+?\$(?!\w)/g, pushPlaceholder); // inline

  // ---- Phase B: Rejoin soft-wrapped lines (LLM wraps long lines at ~80 cols, breaking formulas) ----
  // A line should be JOINED with the NEXT line if:
  //   - This line does NOT end in a sentence / structure boundary
  //   - AND the next line does NOT start a structural marker (numbered list, heading, label)
  // This prevents "L = n(h\n/2\nπ)" from being split into paragraphs.
  const SENTENCE_END_RE = /[。！？!?；;）》」』】〕』”’》·…—\-—~:：、,]$|^.+[0-9A-Za-zΑ-Ωα-ωℏħ\u0370-\u03ff\u2100-\u214F+\-*/=≈≤≥≠^_()（）【】《》〈〉「」『』`'"%]$/;
  // Detect decimals disguised as list items: "2. 529×10⁻¹⁰" — marker followed by digit
  const DECIMAL_DISGUISE_RE = /^\d+[.)\uFF0E]\s*\d/;
  const STRUCT_START_RE = /^(?:\d+[.)、\uFF0E]|[\uFF08(]\d+[)\uFF09]|[一二三四五六七八九十]+[、.．]|#{1,4}\s|[-*]\s+|[\u2022\u00B7]\s*|来源依据[：:]|补充脉络[：:]|相关对象[：:]|关键解释[：:]|正确答案[：:]|你的答案[：:]|答案[：:]|解析[：:]|备注[：:])/u;
  const rawLines = protected_.split(/\n/);
  const rejoined = [];
  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i].trim();
    if (!line) { rejoined.push(""); continue; }
    // Attempt to merge with subsequent adjacent raw lines while they look like soft-wraps
    while (i + 1 < rawLines.length) {
      const nextTrim = rawLines[i + 1].trim();
      if (!nextTrim) break; // blank line = real paragraph break
      // 表格行（| ... |）绝不合并——否则整个 Markdown 表格被摊平成一行竖线文本
      if (isTableRowLine(line) || isTableRowLine(nextTrim)) break;
      // next line starts a structural marker → real break
      // BUT: "2. 529×10⁻¹⁰" decimals disguised as list items should NOT break
      if (STRUCT_START_RE.test(nextTrim) && !DECIMAL_DISGUISE_RE.test(nextTrim)) break;
      // Heuristic: current line looks "incomplete" (no sentence end) OR next line is formula-ish
      const looksIncomplete = !/[。！？!?；;）》」』】〕」』”’》·…]$/.test(line);
      // Added \\ (LaTeX cmds), | (pipe/abs), )}] (close brackets) — same fix as backend
      const nextLooksFormula = /^[+\-*/^=%~（()}\]{\[<|A-Za-z0-9Α-Ωα-ωℏħ\u0370-\u03ff\u2100-\u214F∞≠±∓≈≤≥√²³∂∇∑∏∫→←⇒⇐,.，；:：;\\]/.test(nextTrim);
      if (!looksIncomplete && !nextLooksFormula) break;
      line = (line + " " + nextTrim).trim();
      i++;
    }
    rejoined.push(line);
  }
  const rejoinedText = rejoined.join("\n");

  // ---- Phase C: Inject line breaks ONLY at conservative number-list boundaries ----
  // Only insert \n before \d+[.)] if it follows a sentence terminator or is at line start.
  // This avoids splitting formulas like "L = n(h/2π)" when they don't contain list markers.
  const conservativeBreak = rejoinedText.replace(
    /(?:^|(?<=[。！？!?；;）》」』】〕』”’》·…—:：；;]))\s+(?=\d+[.)]\s*(?!\d)|\([A-F]\)\s*|[A-F][．.]\s*)/gm,
    "\n"
  );

  const lines = conservativeBreak
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/\x00MATH(\d+)\x00/g, (_, i) => mathPlaceholders[Number(i)]));
  const blocks = [];
  let orderedItems = [];
  let unorderedItems = [];
  const flushOrderedItems = () => {
    if (!orderedItems.length) return;
    blocks.push(`<ol class="answer-list">${orderedItems.map((item) => `<li class="study-text-numbered-heading">${item}</li>`).join("")}</ol>`);
    orderedItems = [];
  };
  const flushUnorderedItems = () => {
    if (!unorderedItems.length) return;
    blocks.push(`<ul class="study-text-bullet-list">${unorderedItems.map((item) => `<li>${item}</li>`).join("")}</ul>`);
    unorderedItems = [];
  };
  const flushLists = () => {
    flushOrderedItems();
    flushUnorderedItems();
  };

  let skipTableUntil = -1;
  lines.forEach((line, index) => {
    if (index <= skipTableUntil) return;

    // ---- Markdown 表格块：表头行 + 分隔行（|:---:|）+ 若干数据行 → 真正的 <table> ----
    if (isTableRowLine(line) && index + 1 < lines.length && parseTableSeparatorAligns(lines[index + 1])) {
      const rows = [line, lines[index + 1]];
      let end = index + 2;
      while (end < lines.length && isTableRowLine(lines[end])) {
        rows.push(lines[end]);
        end += 1;
      }
      skipTableUntil = end - 1;
      flushLists();
      blocks.push(renderStudyTableMarkup(rows));
      return;
    }
    // 单行压缩表（模型把整张表压到同一物理行、无换行）→ 重建为标准表格
    const packedRows = isTableRowLine(line) ? splitPackedSingleLineTable(line) : null;
    if (packedRows) {
      flushLists();
      blocks.push(renderStudyTableMarkup(packedRows));
      return;
    }

    const block = lineBlockPresentation(line);
    if (block.type === "heading" || shouldPromoteStudyHeading(block, lines[index + 1])) {
      flushLists();
      const marker = block.type === "ordered" ? `<span class="study-text-marker">${escapeHtml(block.marker)}</span>` : "";
      const className = block.type === "ordered" ? "study-text-heading study-text-numbered-heading" : "study-text-heading";
      blocks.push(`<p class="${className}">${marker}<span>${renderAnswerTextContent(block.text)}</span></p>`);
      return;
    }

    const labeled = line.match(/^(来源依据|补充脉络|相关对象|关键解释)[：:]\s*(.*)$/);
    if (labeled) {
      flushLists();
      if (labeled[2]) {
        blocks.push(`<p class="study-text-lead"><strong>${escapeHtml(labeled[1])}：</strong>${renderMathContent(labeled[2])}</p>`);
      } else {
        blocks.push(`<p class="study-text-heading">${renderMathContent(`${labeled[1]}：`)}</p>`);
      }
      return;
    }

    if (block.type === "ordered") {
      flushUnorderedItems();
      orderedItems.push(renderAnswerTextContent(block.text));
      return;
    }

    if (block.type === "unordered") {
      flushOrderedItems();
      unorderedItems.push(renderAnswerTextContent(block.text));
      return;
    }

    flushLists();
    // has-display-math 会把所有子元素（含行内公式 <span>、<strong>）强制 display:block，
    // 因此只有"整行就是一个独立公式"时才可加——混合行（文字+行内公式）加了会把每个公式挤成独占一行。
    const className = isDisplayMathOnly(line) || isStandaloneBareFormulaLine(line) ? " study-text-line has-display-math" : " study-text-line";
    blocks.push(`<p class="${className.trim()}">${renderAnswerTextContent(line)}</p>`);
  });
  flushLists();
  return `<div class="study-text-blocks">${blocks.join("")}</div>`;
}

// ---- Markdown 表格支持 ----------------------------------------------------
// 只认标准 GFM 形态：行首 |、至少两个竖线；表头下一行必须是分隔行（|---|---|）。
// 单元格内可能含 \( ||x|| \) 这类范数公式，所以切分前先把数学段占位保护。

function isTableRowLine(value) {
  const text = String(value ?? "").trim();
  return text.startsWith("|") && text.indexOf("|", 1) >= 1;
}

function splitTableCells(line) {
  const stash = [];
  const masked = String(line ?? "").replace(
    /\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$|\$(?!\s)[^$\n]+?\$(?!\w)/g,
    (match) => {
      stash.push(match);
      return `\x00TC${stash.length - 1}\x00`;
    }
  );
  let text = masked.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text
    .split("|")
    .map((cell) => cell.trim().replace(/\x00TC(\d+)\x00/g, (_, i) => stash[Number(i)]));
}

// 分隔行（| :--- | :---: | ---: |）→ 对齐数组；不是分隔行则返回 null
function parseTableSeparatorAligns(line) {
  if (!isTableRowLine(line)) return null;
  const cells = splitTableCells(line);
  if (cells.length < 2) return null;
  const aligns = [];
  for (const cell of cells) {
    if (!/^:?-{2,}:?$/.test(cell)) return null;
    aligns.push(
      cell.startsWith(":") && cell.endsWith(":") ? "center"
        : cell.endsWith(":") ? "right"
          : cell.startsWith(":") ? "left"
            : ""
    );
  }
  return aligns;
}

function renderStudyTableMarkup(rows) {
  const aligns = parseTableSeparatorAligns(rows[1]) || [];
  const alignAttr = (col) => (aligns[col] ? ` style="text-align:${aligns[col]}"` : "");
  const head = splitTableCells(rows[0])
    .map((cell, col) => `<th${alignAttr(col)}>${renderAnswerTextContent(cell)}</th>`)
    .join("");
  const body = rows
    .slice(2)
    .map((row) => `<tr>${splitTableCells(row).map((cell, col) => `<td${alignAttr(col)}>${renderAnswerTextContent(cell)}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="study-table-wrap"><table class="study-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderMathContent(value) {
  // Literal \n (backslash-n) handling. Two distinct cases:
  //  1) "\npsi" (LLM jammed an 'n' into \psi): drop just the 'n' so the backslash
  //     survives and the true command forms (\npsi → \psi → ψ). Only do this when
  //     the following lowercase letters are NOT a real \n-command (\nu, \nabla, \neq,
  //     \notin, …), so genuine \n commands are never corrupted.
  //  2) "\nNonlinear" / "\n{1}" (spurious \n before an uppercase letter / non-letter):
  //     collapse the whole \n to a space (original behavior).
  let text = String(value ?? "").replace(
    /\\n(?=[a-z])(?!(?:ewline|u|abla|eq|e|ot|otin|exists|mid|cong|subseteq|supseteq|parallel|shortparallel|shortmid|vdash|vDash|leftarrow|rightarrow|leftrightarrow|earrow|warrow|less|leq|leqslant|gtr|geq|geqslant|preceq|prec|succeq|succ)(?![A-Za-z]))/g,
    "\\"
  );
  text = text.replace(/\\n(?![a-z])/g, " ");
  // Match explicit math markers: \[...\], \(...\), $$...$$, $...$
  const explicitMath = /\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$|\$(?!\$)[^$]+\$/g;
  let markup = "";
  let cursor = 0;
  for (const match of text.matchAll(explicitMath)) {
    markup += renderBareMathText(text.slice(cursor, match.index));
    const token = match[0];
    const display = token.startsWith("\\[") || token.startsWith("$$");
    const formula = token.startsWith("\\") ? token.slice(2, -2) : token.slice(display ? 2 : 1, display ? -2 : -1);
    const unitContext = hasUnitSlashContext(text, match.index, token.length);
    markup += renderKatex(formula, display, { unitContext });
    cursor = match.index + token.length;
  }
  markup += renderBareMathText(text.slice(cursor));
  return markup;
}

function containsDisplayMath(value) {
  return /\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$/.test(String(value ?? "")) || shouldDisplayBareFormula(value);
}

// A line that IS one bare formula (no CJK prose) — only such lines may carry the
// has-display-math class, whose CSS forces every child span to display:block.
// Applying it to mixed text+formula lines would push every inline formula onto
// its own line (the explanation-fragmentation bug).
function isStandaloneBareFormulaLine(value) {
  const text = String(value ?? "").trim().replace(/[。．.]+$/, "").trim();
  if (!text || !shouldDisplayBareFormula(text)) return false;
  return !/[一-鿿]/.test(text);
}

function mathJaxIsReady() {
  // window.MathJax 早在 head 的 inline 配置里就被赋值了，因此"存在"不等于"可用"。
  // 只有 tex2chtml 真正挂载、且 CDN 没有被 onerror 标记为不可用，才算就绪；
  // 否则一律回退到本地 KaTeX，保证校园网 / 断网时公式不会退化成原始 LaTeX 代码。
  if (typeof window === "undefined" || !window.MathJax) return false;
  if (window.__MathJaxUnavailable) return false;
  return typeof window.MathJax.tex2chtml === "function";
}

function renderKatex(formula, display = false, options = {}) {
  const original = String(formula ?? "");
  const source = normalizeLatexForRenderer(original, options);
  if (!source) return "";
  if (mathJaxIsReady()) {
    try {
      if (typeof window.MathJax.tex2chtml === "function") {
        const node = window.MathJax.tex2chtml(source, { display });
        const html = node.outerHTML;
        const wrapperClass = display ? "mathjax-display-wrapper" : "mathjax-inline-wrapper";
        const finalMarkup = `<span class="${wrapperClass}" data-math-renderer="mathjax">${html}</span>`;
        logMathRenderDebug({ renderer: "mathjax", original, source, html, finalMarkup });
        return finalMarkup;
      }
    } catch (error) {
      logMathRenderDebug({ renderer: "mathjax-error", original, source, error: String(error) });
    }
    const delimiter = display ? ["\\[", "\\]"] : ["\\(", "\\)"];
    const finalMarkup = `<span class="mathjax-pending ${display ? "mathjax-display-wrapper" : "mathjax-inline-wrapper"}" data-math-renderer="mathjax-pending">${escapeHtml(`${delimiter[0]}${source}${delimiter[1]}`)}</span>`;
    scheduleMathJaxTypeset();
    logMathRenderDebug({ renderer: "mathjax-pending", original, source, html: finalMarkup, finalMarkup });
    return finalMarkup;
  }
  if (typeof window === "undefined" || typeof window.katex === "undefined") {
    const html = renderInlineMath(source, options);
    const finalMarkup = `<span class="math-expression${display ? " math-display" : ""}">${html}</span>`;
    logMathRenderDebug({ renderer: "html-fallback", original, source, html, finalMarkup });
    return finalMarkup;
  }
  try {
    const html = window.katex.renderToString(source, {
      displayMode: display,
      throwOnError: false,
      strict: false,
      trust: false,
    });
    const wrapperClass = display ? "katex-display-wrapper" : "katex-inline-wrapper";
    const finalMarkup = `<span class="${wrapperClass}" data-math-renderer="katex">${html}</span>`;
    logMathRenderDebug({ renderer: "katex", original, source, html, finalMarkup });
    // throwOnError:false makes KaTeX embed a red <span class="katex-error"> instead of
    // throwing.  If any residual bad LaTeX slipped through, degrade to the styled
    // plain-math renderer so no red error box is shown in the UI.
    if (/\bclass="[^"]*katex-error/.test(html)) {
      const fallbackHtml = renderInlineMath(source, options);
      const fallbackMarkup = `<span class="math-expression${display ? " math-display" : ""}" data-math-renderer="katex-error-fallback" data-math-source="${escapeAttr(source)}">${fallbackHtml}</span>`;
      logMathRenderDebug({ renderer: "katex-error-fallback", original, source, html, finalMarkup, fallbackMarkup });
      return fallbackMarkup;
    }
    return finalMarkup;
  } catch (error) {
    const html = renderInlineMath(source, options);
    const finalMarkup = `<span class="math-expression${display ? " math-display" : ""}" title="${escapeAttr(source)}">${html}</span>`;
    logMathRenderDebug({ renderer: "katex-error", original, source, html, finalMarkup, error: String(error) });
    return finalMarkup;
  }
}

// Unwrap \text{...}/\mathrm{...}-style groups whose content is ONLY math
// commands and math-ish characters.  The Unicode→LaTeX conversion chains run
// before the \text{...} protection, so an LLM-written \text{ħω} becomes
// \text{\hbar\omega} — and LaTeX commands are rendered LITERALLY in text mode,
// which is how raw "\hbar\omega" ends up on screen.  Unwrapping restores the
// intended math-mode rendering (\hbar\omega → ℏω).  Groups holding real words
// or units (\text{ Hz}, \text{eV}) keep their wrapper.
function unwrapMathOnlyTextGroups(source) {
  return String(source ?? "").replace(
    /\\(text|mathrm|mathbf|mathit|mathsf|operatorname)\s*\{([^{}]*)\}/g,
    (match, command, inner) => {
      if (!/\\[A-Za-z]+/.test(inner)) return match;
      const leftover = inner.replace(/\\[A-Za-z]+/g, "");
      if (/^[\sA-Za-z0-9_{}^+\-*/=().,;'|[\]<>:!°-]*$/.test(leftover)) return inner;
      return match;
    },
  );
}

// KaTeX/MathJax throw "Double subscript"/"Double superscript" when one atom carries two
// consecutive same-direction script groups (LLM emits \mu_s _a, x^2 ^3, X_a^b_c …).
// Merge each run of consecutive script groups into one braced group each for _ and ^,
// so both render natively.  Valid single/varied scripts (x_i, x_i^2, \sum_{k \ne n})
// are left byte-identical.  Returns the ORIGINAL slice when no duplicate occurs.
function collapseDuplicateScriptGroups(s) {
  let out = "";
  let i = 0;
  const scriptEnd = (str, start) => {
    while (start < str.length && (str[start] === " " || str[start] === "\t")) start++;
    if (str[start] === "{") {
      let d = 1, k = start + 1;
      while (k < str.length && d > 0) { if (str[k] === "{") d++; else if (str[k] === "}") d--; k++; }
      return k;
    }
    if (str[start] === "\\") { let k = start; while (k + 1 < str.length && /[A-Za-z]/.test(str[k + 1])) k++; return k + 1; }
    return start + 1;
  };
  const unbrace = (t) => (t[0] === "{" && t[t.length - 1] === "}" ? t.slice(1, -1) : t);
  while (i < s.length) {
    if (s[i] !== "_" && s[i] !== "^") { out += s[i++]; continue; }
    const reads = [];
    let scan = i;
    while (scan < s.length) {
      const wsStart = scan;
      while (scan < s.length && (s[scan] === " " || s[scan] === "\t")) scan++;
      const dir = s[scan];
      if (dir !== "_" && dir !== "^") { scan = wsStart; break; } // keep whitespace for no-dup case
      const end = scriptEnd(s, scan + 1);
      reads.push({ dir, txt: unbrace(s.slice(scan + 1, end)) });
      scan = end;
    }
    const dup = reads.filter((r) => r.dir === "_").length > 1 || reads.filter((r) => r.dir === "^").length > 1;
    if (!dup) { out += s.slice(i, scan); i = scan; continue; }
    const sub = reads.filter((r) => r.dir === "_").map((r) => r.txt).join(" ");
    const sup = reads.filter((r) => r.dir === "^").map((r) => r.txt).join(" ");
    out += (sub ? "_{" + sub + "}" : "") + (sup ? "^{" + sup + "}" : "");
    i = scan;
  }
  return out;
}

function normalizeLatexForRenderer(value, options = {}) {
  let source = String(value ?? "")
    .trim()
    // LLM 偶发把 μ 的 Unicode 转义写成 \u000b，JSON 解析后变成控制字符，
    // KaTeX 会渲染成 ••• 乱码；统一还原为 μ 并清除其余 C0 控制字符。
    .replace(/\\u000b/gi, "μ")
    .replace(/\u000b/g, "μ")
    .replace(/[\u0000-\u0008\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/^\\\(|\\\)$/g, "")
    .replace(/^\\\[|\\\]$/g, "")
    .replace(/^\$\$|\$\$$/g, "")
    .replace(/^\$|\$$/g, "")
    // KaTeX 不支持 \tag：剥离公式编号（编号由阅读器版式层单独渲染）
    .replace(/\\tag\s*\*?\s*\{[^{}]*\}/g, "")
    .replace(/&bsol;|&#92;|&Backslash;/g, "\\")
    .replace(/&lbrace;|&#123;/g, "{")
    .replace(/&rbrace;|&#125;/g, "}")
    .replace(/<\/?[^>]+>/g, "")
    // Convert bare Unicode math symbols to LaTeX commands (before any auto-repair)
    .replaceAll("∞", "\\infty")
    .replaceAll("≠", "\\ne")
    .replaceAll("±", "\\pm")
    .replaceAll("∓", "\\mp")
    .replaceAll("⋅", "\\cdot ")
    .replaceAll("·", "\\cdot ")
    .replaceAll("×", "\\times")
    .replaceAll("÷", "\\div")
    .replaceAll("°", "^\\circ")
    .replaceAll("′", "^\\prime")
    .replaceAll("∞", "\\infty")
    .replaceAll("∝", "\\propto")
    .replaceAll("∑", "\\sum")
    .replaceAll("∏", "\\prod")
    .replaceAll("∫", "\\int")
    .replaceAll("∂", "\\partial")
    .replaceAll("∇", "\\nabla")
    .replaceAll("√", "\\sqrt")
    .replaceAll("→", "\\rightarrow")
    .replaceAll("←", "\\leftarrow")
    .replaceAll("∼", "\\sim")
    .replaceAll("≡", "\\equiv")
    .replaceAll("∈", "\\in")
    .replaceAll("∉", "\\notin")
    .replaceAll("∀", "\\forall")
    .replaceAll("∃", "\\exists")
    .replaceAll("⟩", "\\rangle")
    .replaceAll("⟨", "\\langle")
    .replaceAll("½", "\\frac{1}{2}")
    .replaceAll("¼", "\\frac{1}{4}")
    .replaceAll("¾", "\\frac{3}{4}")
    .replaceAll("⊗", "\\otimes")
    .replaceAll("⊕", "\\oplus")
    .replaceAll("⊂", "\\subset")
    .replaceAll("⊃", "\\supset")
    .replaceAll("∅", "\\emptyset")
    // Common Greek letters that may appear as bare Unicode in otherwise LaTeX-formatted content
    .replaceAll("μ", "\\mu")
    .replaceAll("ν", "\\nu")
    .replaceAll("λ", "\\lambda")
    .replaceAll("Δ", "\\Delta")
    .replaceAll("δ", "\\delta")
    .replaceAll("θ", "\\theta")
    .replaceAll("φ", "\\phi")
    .replaceAll("ψ", "\\psi")
    .replaceAll("χ", "\\chi")
    .replaceAll("ω", "\\omega")
    .replaceAll("σ", "\\sigma")
    .replaceAll("τ", "\\tau")
    .replaceAll("ρ", "\\rho")
    .replaceAll("η", "\\eta")
    .replaceAll("Π", "\\Pi")
    .replaceAll("π", "\\pi")
    .replaceAll("ℏ", "\\hbar")
    .replaceAll("ħ", "\\hbar")
    .replaceAll("＝", "=")
    .replaceAll("≈", "\\approx")
    .replaceAll("≤", "\\le")
    .replaceAll("≥", "\\ge")
    .replaceAll("/", "/") // keep slash for later frac detection
    .replace(/(?<!\\)\b(partial|frac|overline|hat|sum|Delta|hbar|geq|leq|approx|int|nabla|theta|phi|tau|times|cdot|infty|ne|le|ge|sim)\b/g, "\\$1")
    .trim();
  // OCR sometimes fuses "if" with a preceding slice → "extif"; the intended
  // piecewise condition is "if".  Only a standalone token is touched, so the
  // legitimate \text{if} (which merely contains "extif" as a substring) is safe.
  source = source.replace(/(^|[\s{,])(extif)(?=[\s,])/g, "$1if");
  // Grouped Unicode super/subscripts (10¹⁵ → 10^{15}, ⁽⁰⁾ → ^{(0)}) and fused
  // terminal commands created by the conversions above (\langlen → \langle n).
  source = convertUnicodeScripts(source);
  // Fix OCR/LLM-fused Greek macros like \mubs → \mu_{bs}, \muext → \mu_{ext},
  // \mus → \mu_s, \mufit → \mu_{fit}.  Only whitelisted subscript words are
  // captured so a legitimate \mu\beta or \mu α is never rewritten.
  source = source.replace(
    /\\(mu|rho|tau|sigma|kappa|alpha|beta|gamma|delta)\s*(bs|ext|fit|sa|zf|s|r|t|a|i|b|u|o|n|z)\s*(?![A-Za-z{])/g,
    (match, greekCmd, sub) => `\\${greekCmd}_{${sub}}`,
  );
  source = splitFusedTerminalLatexCommands(source);
  // Blanks (____), bare # / %, combining accents → KaTeX-safe forms.
  source = sanitizeLatexTextChars(source);
  // Protect \text{...} / \mathrm{...} groups (units like \text{ Hz}) from the
  // notation heuristics below — otherwise the H([A-Za-z]) → H_{...} rule rewrites
  // "Hz" to "H_{z}" inside \text{...}, which then shows up as raw text.
  const protectedTextGroups = [];
  source = source.replace(/\\(?:text|mathrm|mathbf|mathit|mathsf|operatorname)\s*\{[^{}]*\}/g, (match) => {
    protectedTextGroups.push(match);
    return `\x00TEXTG${protectedTextGroups.length - 1}\x00`;
  });
  source = repairBrokenLatexTokens(source)
    .replace(/\bpsi([A-Za-z])\((\d+)\)/g, "\\psi_{$1}^{($2)}")
    .replace(/\bE([A-Za-z])\((\d+)\)/g, "E_{$1}^{($2)}")
    .replace(/\bH([A-Za-z])\b/g, "H_{$1}")
    .replace(/\b([kn])\((\d+)\)(?=\s*(?:[|\u27E9]|\\rangle))/g, "$1^{($2)}")
    .replaceAll("\u27E8", "\\langle ")
    .replaceAll("\u27E9", " \\rangle")
    .replace(/\|H'\|/g, "|\\hat{H}'|")
    .replace(/\\sum\s*(?:\\+\s*)?eq\s+n\}/g, "\\sum_{k \\ne n}")
    .replace(/\\sum\s*_\s*\{\s*([A-Za-z\u0370-\u03ff])\s*(?:\\\s*)?(?:neq|ne|eq)\s*n\s*\}/g, (_, index) => `\\sum_{${index} \\ne n}`)
    .replace(/\\sum\s*\\\s*eq\s+n\}/g, "\\sum_{k \\ne n}")
    .replace(/\\sum\s+eq\s+n\}/g, "\\sum_{k \\ne n}")
    .replace(/\\sum\s+ne\s+n\}/g, "\\sum_{k \\ne n}")
    .replace(/\\sum\s*_\s*\{?k\s*\\?ne\s*n\}?/g, "\\sum_{k \\ne n}")
    .replace(/\s*-\s*/g, "-");
  source = repairPerturbationFormula(source);
  // Collapse LLM double-sub/superscript runs (\mu_s _a, x^2 ^3, X_a^b_c) so neither
  // KaTeX nor MathJax raises a red "Double subscript/superscript" error in the UI.
  source = collapseDuplicateScriptGroups(source);
  // Restore the protected \text{...} / \mathrm{...} groups.
  source = source.replace(/\x00TEXTG(\d+)\x00/g, (_, index) => protectedTextGroups[Number(index)]);
  // ...then unwrap the ones that only ever held math (see unwrapMathOnlyTextGroups).
  source = unwrapMathOnlyTextGroups(source);
  source = normalizeUnitFractionsForRenderer(source, Boolean(options.unitContext));
  // Render abbreviation fractions like \frac{CS}{SS} or \frac{I}{O} as roman text
  // to avoid single-letter variables looking like digits (e.g. I/O appearing as 1/0).
  source = source.replace(/\\frac\s*\{\s*([^{}]+?)\s*\}\s*\{\s*([^{}]+?)\s*\}/g, (match, numerator, denominator) => {
    if (looksLikeAbbreviationPair(numerator, denominator)) return `\\mathrm{${numerator}/${denominator}}`;
    return match;
  });
  // Wrap multi-char LaTeX commands after _ or ^ in braces so KaTeX/MathJax parses them correctly
  source = source.replace(/([_^])\\([A-Za-z]+)(?![A-Za-z])(?!\s*\{)/g, "$1{\\$2}");
  // Ensure any \sqrt (produced from Unicode √ conversion or original) that isn't
  // followed by a braced argument gets its following argument captured & wrapped.
  // E.g. "\sqrt2/a" → "\sqrt{2/a}".  Regex matches \sqrt + the next contiguous
  // "token block".  Terminator chars (1st branch excl. list): whitespace , ; = { } ( ) [ ]
  // so in-expression operators / * ^ + - are captured inside the arg.  Remaining
  // branches handle a LaTeX cmd w/ args, a (…)-group, or a {…}-group as one "token".
  source = source.replace(
    /\\sqrt(?!\s*\{)(\s*(?:[^\s,;={}()[\]]|\\[A-Za-z]+(?:\{[^}]*\})*|\([^()]*\)|\{[^}]*\})+)?/g,
    (match, arg) => arg ? `\\sqrt{${arg.trim()}}` : "\\sqrt{}"
  );
  // ---- Brace-balancing repair: if there are more '{' than '}', append closing.
  // If there are stray '}' without matching '{', strip them.  This is the last-resort
  // safety net against KaTeX "Missing close brace" errors.  We only count top-level
  // braces while ignoring backslash-escaped \{ \} which are literal set characters.
  source = (function balanceBraces(src) {
    let depth = 0;
    let extra = [];
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === "\\" && i + 1 < src.length) { i++; continue; } // skip escaped next char
      if (c === "{") depth++;
      else if (c === "}") {
        if (depth === 0) { extra.push(i); continue; } // stray close brace - drop it
        depth--;
      }
    }
    let out = src;
    if (extra.length) {
      out = "";
      for (let i = 0, j = 0; i < src.length; i++) {
        if (j < extra.length && i === extra[j]) { j++; continue; }
        out += src[i];
      }
    }
    if (depth > 0) out += "}".repeat(depth);
    return out;
  })(source);
  // ---- Defensive: ensure \frac has two arguments ----
  // The formula-pattern regex in renderBareMathText may truncate \frac{1}{2
  // (missing closing brace) to \frac{1}, which has balanced braces but only
  // one argument. KaTeX throws "Missing argument for \frac".  Fix both the
  // zero-argument and one-argument cases, but only at end-of-string to avoid
  // breaking valid LaTeX like \frac 1 2.
  // Fix 1: \frac without any braced argument (e.g. \frac at end of formula)
  source = source.replace(/\\frac\s*$/g, "\\frac{}{}");
  // Fix 2: \frac with only one braced argument (e.g. \frac{1} truncated)
  source = source.replace(/\\frac\s*(\{[^{}]*\})\s*$/g, "\\frac$1{}");
  return source.trim();
}

function hasUnitSlashContext(text, index, tokenLength = 0) {
  const source = String(text ?? "");
  const before = source.slice(Math.max(0, index - 24), index);
  const after = source.slice(index + tokenLength, index + tokenLength + 16);
  return /unit|common|SI|\u5355\u4f4d|\u91cf\u7eb2|\u5e38\u7528/i.test(`${before}${after}`);
}

function normalizeUnitFractionsForRenderer(value, unitContext = false) {
  // Numerator/denominator may contain one level of nested braces (m^{2}, cm^{-1}).
  return String(value ?? "").replace(/\\frac\s*\{\s*((?:[^{}]|\{[^{}]*\})+?)\s*\}\s*\{\s*((?:[^{}]|\{[^{}]*\})+?)\s*\}/g, (match, numerator, denominator) => {
    const candidate = `${numerator}/${denominator}`;
    return shouldRenderAsUnitSlash(candidate, unitContext) ? compactUnitSlash(candidate) : match;
  });
}

function shouldRenderAsUnitSlash(value, unitContext = false) {
  const parts = splitSimpleSlashExpression(value);
  if (!parts) return false;
  const [numerator, denominator] = parts;
  if (/^(?:d|\\partial)$/i.test(numerator) || /^d[A-Za-z]/.test(denominator)) return false;
  if (unitContext) return isKnownUnitToken(numerator) || isKnownUnitToken(denominator);
  if (/^p?_?m$/i.test(numerator) && /^v$/i.test(denominator)) return true;
  // Unit-vs-unit ratios (W/m², m²/W, MW/m²...) stay as inline slashes even
  // without an explicit 单位/量纲 keyword nearby — a stacked \frac for units
  // shatters the surrounding line.
  return isKnownUnitToken(numerator) && isKnownUnitToken(denominator);
}

function splitSimpleSlashExpression(value) {
  const source = String(value ?? "")
    .replace(/\\(?:mathrm|text)\{([^{}]+)\}/g, "$1")
    .replace(/\s+/g, "")
    .trim();
  // Unit tokens may carry super/subscripts: m^{2}, m^2, cm^{-1}, J_{s}...
  const match = source.match(/^([A-Za-z]+(?:[_^]\{?[A-Za-z0-9]+\}?)*)\/([A-Za-z]+(?:[_^]\{?[A-Za-z0-9]+\}?)*)$/);
  if (!match) return null;
  return [normalizeUnitToken(match[1]), normalizeUnitToken(match[2])];
}

function normalizeUnitToken(value) {
  return String(value ?? "").replace(/[{}]/g, "");
}

function compactUnitSlash(value) {
  const parts = splitSimpleSlashExpression(value);
  return parts ? `${parts[0]}/${parts[1]}` : String(value ?? "").replace(/\s+/g, "");
}

const KNOWN_UNIT_TOKENS = new Set(["m", "pm", "p_m", "nm", "um", "mm", "cm", "v", "kv", "mv", "s", "hz", "n", "pa", "w", "j", "c", "f", "kg", "mol", "k", "mw", "kw", "gw", "thz", "ev", "a", "l", "g"]);

function isKnownUnitToken(value) {
  const token = normalizeUnitToken(value).toLowerCase();
  if (KNOWN_UNIT_TOKENS.has(token)) return true;
  // Strip super/subscripts (m^2 → m, cm^{-1} → cm) and check the base unit.
  const base = token.replace(/[_^][a-z0-9]+/g, "");
  return base !== token && KNOWN_UNIT_TOKENS.has(base);
}

function looksLikeAbbreviationPair(numerator, denominator) {
  const a = String(numerator ?? "").replace(/[{}\\]/g, "").trim();
  const b = String(denominator ?? "").replace(/[{}\\]/g, "").trim();
  if (!a || !b) return false;
  if (a.length > 4 || b.length > 4) return false;
  if (!/^[A-Z0-9]+$/.test(a) || !/^[A-Z0-9]+$/.test(b)) return false;
  // A purely numeric fraction (1/2, 3/4, 22/7) is a real fraction, not an abbreviation.
  if (/^[0-9]+$/.test(a) && /^[0-9]+$/.test(b)) return false;
  return true;
}

function isAbbreviationSlashFormula(value) {
  return /^[A-Z0-9]{1,4}\s*\/\s*[A-Z0-9]{1,4}$/.test(String(value ?? "").trim());
}

function repairBrokenLatexTokens(value) {
  // Recognised LaTeX command names – used by the CMD_RE callback below so that a
  // short prefix (le, ge, ne) followed by a letter is NOT split when the maximal
  // letter-run after the backslash forms a valid longer command (left, leq, geq, neq, …).
  const KNOWN_LATEX_CMDS = new Set([
    // Greek letters (full set incl. pi/omicron so \pix splits at \pi)
    "alpha","beta","gamma","delta","epsilon","zeta","eta","theta","iota","kappa",
    "lambda","mu","nu","xi","omicron","pi","rho","sigma","tau","upsilon","phi",
    "chi","psi","omega",
    // Greek capitals & variants
    "Delta","Gamma","Theta","Lambda","Xi","Sigma","Upsilon","Phi","Psi","Omega",
    "varepsilon","vartheta","varphi","varrho","varsigma",
    // Operators / relations / arrows
    "approx","equiv","geq","geqq","hbar","hslash","infty","left","le","leq","leqq",
    "ne","neg","neq","right","sim","simeq","cong","propto","partial","nabla",
    "rightarrow","leftarrow","leftrightarrow","Rightarrow","Leftarrow","Leftrightarrow",
    "uparrow","downarrow","mapsto","nearrow","nwarrow","searrow","swarrow",
    "pm","mp","div","ast","star","circ","bullet","oplus","ominus","otimes","odot",
    "times","cup","cap","uplus","sqcup","vee","wedge","in","notin","ni","subset","supset",
    "subseteq","supseteq","sqsubseteq","sqsupseteq","emptyset","varnothing",
    "forall","exists","nexists","ll","gg","prec","succ","preceq","succeq",
    "perp","parallel","nparallel","mid","nmid","models","vdash","dashv","top","bot",
    "angle","measuredangle","prime","ell","Re","Im","aleph","wp",
    // Big-O / functions / structure (so fused forms like \sumh, \intx split correctly)
    "sum","prod","int","iint","iiint","oint","bigcup","bigcap","bigoplus","bigotimes",
    "exp","ln","log","sin","cos","tan","sec","csc","cot","arcsin","arccos","arctan",
    "sinh","cosh","tanh","min","max","lim","sup","inf","arg","deg","det","dim","ker",
    "frac","dfrac","tfrac","sqrt","hat","bar","vec","dot","ddot","tilde","acute",
    "grave","breve","check","overline","underline","overbrace","underbrace",
    "mathrm","text","textbf","textit","mathbf","mathit","mathcal","mathbb","mathfrak",
    "boldsymbol","bm",
    "cdot","cdots","ldots","vdots","ddots","dots","quad","qquad","newline",
    // Delimiters (fused forms like \langlen, \Deltax)
    "langle","rangle","lfloor","rfloor","lceil","rceil","lbrace","rbrace",
  ]);
  let source = String(value ?? "")
    .replace(/\\-/g, "-")
    .replace(/\\[\t ]+ext(?=\s*\{)/g, "\\text")
    // LLM sometimes writes \right arrow / \left arrow with a space
    .replace(/\\right\s+arrow/g, "\\rightarrow")
    .replace(/\\left\s+arrow/g, "\\leftarrow")
    .replace(/d\s*\\\s*a\s*u\b/g, "d\\tau")
    .replace(/d\s*\\\s*au\b/g, "d\\tau")
    .replace(/d\s+tau\b/g, "d\\tau")
    .replace(/\\\s*au(?=_|\b)/g, "\\tau")
    .replace(/\\\s*abla\b/g, "\\nabla")
    .replace(/\ba\s*b\s*l\s*a\b/g, "\\nabla")
    .replace(/\babla\b/g, "\\nabla")
    .replace(/\\\s*heta(?=_|\b)/g, "\\theta")
    .replace(/\\\s*imes(?=[A-Za-z])/g, "\\times ")
    .replace(/\\\s*imes\b/g, "\\times")
    .replace(/\b([A-Za-z])\^\s*=\s*([A-Za-z])\s*\\times\s*([A-Za-z])\b/g, "\\hat{$1}=$2\\times $3")
    // KaTeX 的 \boldsymbol / \hat / \frac 等"必须带参数"的命令，若 LLM 产出的是残缺形态
    // （裸命令、后面没有花括号/字母），会被 KaTeX 渲染成带 #cc0000 的红字错误
    // （典型如 \boldsymbol{n} = \boldsymbol{AB} \times \boldsymbol）。
    // 这里统一补一个合法占位参数 {}，使它不再报错；有正常参数/跟随字母/数字的用法不受影响。
    // 单个参数的命令：
    .replace(/\\(boldsymbol|bm|mathbf|mathit|mathrm|text|textbf|textit|mathcal|mathbb|mathfrak)(?!\s*[{A-Za-z0-9\\])/g, "$&{}")
    // 能加在单个符号上的装饰命令（\hat a 合法；裸 \hat 则补参）：
    .replace(/\\(hat|bar|vec|dot|ddot|tilde|overline|underline|overrightarrow|overleftrightarrow|stackrel)(?!\s*[{A-Za-z0-9\\])/g, "$&{}")
    // 分数类命令要两个参数，残缺时补 {}{}：
    .replace(/\\(frac|dfrac|tfrac|cfrac)(?!\s*[{A-Za-z0-9\\])/g, "$&{}{}");
  // Fix commands fused with trailing letters: \mua → \mu a, \pix → \pi x,
  // \langlen → \langle n, \rightarrowE → \rightarrow E.  Matches the FULL letter
  // run after a backslash; keeps it intact when it is (or has no) known command,
  // otherwise splits at the LONGEST known prefix.  Because the whole run is
  // consumed, the split never leaves orphaned letters behind.
  source = source.replace(/\\([A-Za-z]+)/g, (match, word) => {
    if (KNOWN_LATEX_CMDS.has(word)) return match;
    for (let len = word.length - 1; len >= 2; len--) {
      const prefix = word.slice(0, len);
      if (KNOWN_LATEX_CMDS.has(prefix)) return `\\${prefix} ${word.slice(len)}`;
    }
    return match;
  });
  return repairBrokenCasesLatex(source);
}

function repairBrokenCasesLatex(value) {
  return String(value ?? "").replace(/\\begin\{cases\}([\s\S]*?)\\end\{cases\}/g, (_, body) => {
    const repairedBody = body.replace(/(?<!\\)\\\s+(?=\\infty\b)/g, "\\\\ ");
    return `\\begin{cases}${repairedBody}\\end{cases}`;
  });
}

function repairPerturbationFormula(value) {
  let source = String(value ?? "");
  source = source.replace(
    /(E_\{n\}\^\{\(2\)\}\s*=\s*\\sum_\{k \\ne n\})\s*(\|\\langle\s*k\^\{\(0\)\}\s*\|\\hat\{H\}'\|\s*n\^\{\(0\)\}\s*\\rangle\s*\|\^2)\}\{(E_\{n\}\^\{\(0\)\}-E_\{k\}\^\{\(0\)\})\}?/,
    "$1 \\frac{|\\langle k^{(0)}|\\hat{H}'|n^{(0)}\\rangle|^2}{$3}",
  );
  source = source.replace(
    /(E_\{n\}\^\{\(2\)\}\s*=\s*\\sum_\{k \\ne n\})\s*\|H'\s*_\{nk\}\|\^2\}\{(E_\{n\}\^\{\(0\)\}-E_\{k\}\^\{\(0\)\})\}?/,
    "$1 \\frac{|H'_{nk}|^2}{$2}",
  );
  source = source.replace(
    /(\\sum_\{k \\ne n\})\s*'_\{kn\}\}\{(E_\{n\}\^\{\(0\)\}-E_\{k\}\^\{\(0\)\})\}?/,
    "$1 \\frac{H'_{kn}}{$2}",
  );
  return source;
}

function scheduleMathJaxTypeset() {
  if (typeof window === "undefined" || !window.MathJax || typeof window.MathJax.typesetPromise !== "function") return;
  if (state.mathJaxTypesetQueued) return;
  state.mathJaxTypesetQueued = true;
  requestAnimationFrame(() => {
    state.mathJaxTypesetQueued = false;
    const targets = [...document.querySelectorAll(".mathjax-pending")];
    if (!targets.length) return;
    window.MathJax.typesetPromise(targets)
      .then(() => targets.forEach((target) => target.classList.remove("mathjax-pending")))
      .catch((error) => logMathRenderDebug({ renderer: "mathjax-typeset-error", error: String(error) }));
  });
}

// MathJax 由 index.html 在首屏 load 完成后才后台加载；收到 ready 事件后，把
// 首屏期间暂存的复杂公式重新升级。没有 CDN 时事件不会触发，本地 KaTeX 仍可用。
window.addEventListener("knoworigin:mathjax-ready", scheduleMathJaxTypeset);

function mathDebugEnabled() {
  if (typeof window === "undefined") return false;
  const query = window.location?.search || "";
  let storageEnabled = false;
  try {
    storageEnabled = window.localStorage?.getItem(MATH_DEBUG_STORAGE_KEY) === "1";
  } catch {
    storageEnabled = false;
  }
  return new URLSearchParams(query).has("debugMath") || storageEnabled;
}

function logMathRenderDebug(payload) {
  if (!mathDebugEnabled()) return;
  console.debug("[KnowOrigin math]", payload);
}

function renderBareMathText(text) {
  const source = repairBrokenLatexTokens(text);
  if (!source) return "";
  // ---- Expanded Unicode sets for formula detection ----
  // Letterlike Symbols (U+2100-U+214F): ℏ ℎ ℕ ℤ ℚ ℝ ℂ etc.
  // Latin Extended-A   (U+0100-U+017F): ħ ĸ ŋ etc.
  // Number Forms       (U+2150-U+218F): ½ ¼ etc.
  // Full Math Operators(U+2200-U+22FF)
  // Superscripts/Subs  (U+2070-U+209F)
  // CJK brackets + quote + comma/colon/semicolon (allow in formula body/rest after operator)
  const EXTRA_START =  String.raw`\u0100-\u017F\u2100-\u214F`;
  // Math-operator-started chars that can BEGIN a bare formula (∫, ∑, √...)
  const OP_START = String.raw`∫∑∏√∂∇→←`;
  // FIX 1: Added Combining Diacritical Marks (U+0300-U+036F) for p̂, F̂, φ̂ etc.
  const EXTRA_BODY  =  String.raw`\u0100-\u017F\u0300-\u036F\u2100-\u214F\u2150-\u218F\u2200-\u22FF\u2070-\u209F`;
  const EXTRA_OPS   = `+*/=<>·≤≥≈≠≡±∓`;
  // NOTE: backtick is appended via + concat because String.raw template uses it as delimiter
  // FIX 4: Added curly quotes (U+2018-U+201D), em-dash, ellipsis for Tr(A') patterns
  // FIX 12: CJK sentence punctuation (，；：。！？、) REMOVED — a formula match must
  // stop at sentence boundaries instead of swallowing the comma + the next clause
  // into KaTeX (which renders CJK chars red). CJK brackets/quotes are kept for
  // f（x）/Tr(A') style formulas; trailing swallowed ones are stripped later.
  // Also dropped curly double/left quotes (U+2018/201C/201D) — only ' (U+2019)
  // is legitimately needed as a prime in Tr(A') patterns.
  const EXTRA_PUNCT = String.raw`,;:"'~[\]\uFF08\uFF09\u3010\u3011\u3008\u3009\u300A\u300B\u300C\u300D\u300E\u300F\u3014\u3015\u2019\u2014\u2026《》〈〉「」『』【】（〕〔〕…·|%#&@!?.\u27E8\u27E9\u27EA\u27EB` + "`";
  const GREEK = String.raw`Α-Ωα-ω\u0370-\u03ff`;
  // FIX 5: Added ¹ (U+00B9), ¼½¾ (U+00BC-U+00BE) so superscripts/vulgar fractions
  // like 10¹⁵ and E₀=½ℏω don't break formula matching mid-token.
  // Also added × ÷ so ω=1.00×10¹⁵ matches as one formula.
  const MATH_SET = String.raw`∞≠±∓≈≤≥≡∝∈∉⊗⊕⊂⊃∑∏∫∂∇√²³⁰¹⁄−→←↔⇒⇐⇔∅∼×÷\u00B9\u00BC-\u00BE`;
  // - inside char class must be escaped or at start/end
  // FIX 2 & 3: Added | (pipe), (, [ as valid start chars for |cn|², (-∞, +∞), [0, ∞) patterns
  const START_CHARS = `A-Za-z${GREEK}${EXTRA_START}|\\(\\[`;
  // FIX 6: Added {} to BODY so letter-started formulas with braced subscripts
  // (N_{D2}/N_{A1} = 0.025) match as one formula instead of staying raw text.
  const BODY_CHARS  = `A-Za-z0-9_{}${GREEK}${EXTRA_BODY}${MATH_SET}${EXTRA_OPS}\\-() ${EXTRA_PUNCT}`;
  const REST_CHARS  = `A-Za-z0-9_{}\\\\${GREEK}${EXTRA_BODY}${MATH_SET}${EXTRA_OPS}\\-() ${EXTRA_PUNCT}`;
  const OP = String.raw`(?:\s*[=＝≈≤≥≠≡±∓+\-*/^]\s*|\s*/\s*|(?:\s*→\s*|\s*←\s*|\s*↔\s*|\s*⇒\s*|\s*⇐\s*|\s*⇔\s*))`;
  const formulaPattern = new RegExp(
    [
      // Branch 1: LaTeX command sequences — chained.
      // FIX 7: braced groups (incl. nested one level & spaces like \text{ eV},
      // {\Delta E_g}) are matched as a unit so the formula is never truncated
      // inside braces (was the root cause of KaTeX "Missing argument for \frac").
      // Also allows decimal points, math symbols (×·⁻…) and spaces between tokens
      // (space only when followed by a formula-ish char, so it can't run into prose).
      String.raw`\\[A-Za-z]+(?:\{(?:[^{}]|\{[^{}]*\})*\})*(?:\{(?:[^{}]|\{[^{}]*\})*\}|\s*[=≈≤≥≠±∓+\-*/^_(),;:'"\[\]]|\s+(?=[\\A-Za-z0-9_(|{])|[A-Za-z0-9_.\\${GREEK}${EXTRA_START}${MATH_SET}]){0,}`,
      // Branch 2: Letter-started bare formula — CHAINED multiple operators
      `[${START_CHARS}](?:[${BODY_CHARS}]*${OP}[${REST_CHARS}]*)+`,
      // Branch 3: Operator-started bare formula (∫, ∑, √...)
      `[${OP_START.replace(/[-]/g, "\\-")}](?:[${BODY_CHARS}]*${OP}[${REST_CHARS}]*)+[${BODY_CHARS}]*`,
      // FIX 2: Branch 3b — Pipe-delimited absolute value/modulus |cn|², |ψ|²
      String.raw`\|[^|]+\|(?:\s*(?:[_^][^\s,;，；。.!？]|[\u00B2-\u00B9\u2070-\u2079\u2090-\u209C])[^\s,;，；。.!？]*)?`,
      // FIX 3: Branch 3c — Interval notation containing ∞: [0, ∞), (-∞, +∞)
      String.raw`[\[(][^\])]*∞[^\])]*[\])]`,
      // FIX 8: Branch 3d — Ket vector |ψ_n⁽⁰⁾⟩ (single pipe + rangle, no operator)
      String.raw`\|[^|\n]+⟩`,
      // FIX 9: Branch 3e — Letter token carrying Unicode super/subscripts only,
      // e.g. E_n⁽¹⁾, E₀, n² (no operator required)
      `[A-Za-z${GREEK}](?:_\\{?[A-Za-z0-9]+\\}?)?[⁰¹²³⁴⁵⁶⁷⁸⁹⁽⁾₀₁₂₃₄₅₆₇₈₉₍₎]+`,
      // Branch 4: Standalone function patterns
      String.raw`√\([^)]*\)`,
      String.raw`sin\([^)]*\)`,
      String.raw`exp\([^)]*\)`,
    ].join("|"),
    "g"
  );


  let markup = "";
  let cursor = 0;
  for (const match of source.matchAll(formulaPattern)) {
    markup += escapeHtml(source.slice(cursor, match.index));
    // FIX 10: Strip trailing CJK sentence punctuation / open brackets that the
    // (intentionally permissive) pattern swallowed, and re-append them as plain
    // text so they are never fed into KaTeX (which renders them red).
    let rawFormula = match[0];
    let tail = "";
    const tailMatch = rawFormula.match(/[，；：。！？、（《〈「『【]+$/u);
    if (tailMatch) {
      tail = tailMatch[0];
      rawFormula = rawFormula.slice(0, -tail.length);
    }
    while (rawFormula.endsWith("）")) {
      const openCount = (rawFormula.match(/（/g) || []).length;
      const closeCount = (rawFormula.match(/）/g) || []).length;
      if (closeCount <= openCount) break;
      tail = "）" + tail;
      rawFormula = rawFormula.slice(0, -1);
    }
    if (!rawFormula.trim()) {
      markup += escapeHtml(match[0]);
      cursor = match.index + match[0].length;
      continue;
    }
    const formula = rawFormula.trim();
    if (isAbbreviationSlashFormula(formula)) {
      markup += escapeHtml(rawFormula);
      markup += escapeHtml(tail);
      cursor = match.index + match[0].length;
      continue;
    }
    // FIX 11: Only promote a bare (delimiter-less) formula to display mode when it
    // IS the whole text fragment. Mid-sentence formulas must stay inline so quiz
    // questions / explanations don't shatter into centered blocks (换行碎片化).
    const beforeText = source.slice(cursor, match.index).trim();
    const afterText = source.slice(match.index + match[0].length).trim();
    const isStandalone = !beforeText && !afterText;
    const display = isStandalone && shouldDisplayBareFormula(formula);
    const unitContext = hasUnitSlashContext(source, match.index, match[0].length) || shouldRenderAsUnitSlash(formula);
    if (typeof window !== "undefined" && typeof window.katex !== "undefined") {
      markup += renderKatex(plainMathToLatex(formula, { unitContext }), display, { unitContext });
    } else {
      markup += `<span class="math-expression${display ? " math-display" : ""}">${renderInlineMath(formula, { unitContext })}</span>`;
    }
    markup += escapeHtml(tail);
    cursor = match.index + match[0].length;
  }
  markup += escapeHtml(source.slice(cursor));
  return markup;
}

function renderInlineMath(value, options = {}) {
  const source = normalizeMathSource(String(value ?? ""));
  const unitSlash = options.unitContext && shouldRenderAsUnitSlash(source, true);
  let markup = "";
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("\\frac", index)) {
      const numerator = readMathArgument(source, index + 5);
      const denominator = readMathArgument(source, numerator.next);
      if (looksLikeAbbreviationPair(numerator.value, denominator.value)) {
        markup += `<span class="math-roman">${escapeHtml(numerator.value)}</span><span class="math-operator">/</span><span class="math-roman">${escapeHtml(denominator.value)}</span>`;
      } else if (options.unitContext && shouldRenderAsUnitSlash(`${numerator.value}/${denominator.value}`, true)) {
        markup += renderInlineMath(compactUnitSlash(`${numerator.value}/${denominator.value}`), options);
      } else {
        markup += `<span class="math-frac"><span class="math-num">${renderInlineMath(numerator.value)}</span><span class="math-den">${renderInlineMath(denominator.value)}</span></span>`;
      }
      index = denominator.next;
      continue;
    }
    if (source.startsWith("\\sqrt", index)) {
      const radicand = readMathArgument(source, index + 5);
      markup += mathSqrtMarkup(radicand.value);
      index = radicand.next;
      continue;
    }
    if (source.startsWith("\\hat", index) || source.startsWith("\\vec", index) || source.startsWith("\\bar", index)) {
      const command = source.startsWith("\\hat", index) ? "hat" : source.startsWith("\\vec", index) ? "vec" : "bar";
      const argument = readMathArgument(source, index + command.length + 1);
      markup += `<span class="math-accent math-${command}">${renderInlineMath(argument.value)}</span>`;
      index = argument.next;
      continue;
    }
    // \text{...} / \mathrm{...} etc.: render the group's contents as upright
    // text (recursing so any math commands inside still resolve to symbols).
    const textCommand = source.slice(index).match(/^\\(text|mathrm|mathbf|mathit|mathsf|operatorname)\s*/);
    if (textCommand) {
      const argument = readMathArgument(source, index + textCommand[0].length);
      markup += `<span class="math-roman">${renderInlineMath(argument.value)}</span>`;
      index = argument.next;
      continue;
    }
    const command = source.slice(index).match(/^\\([A-Za-z]+)/);
    if (command) {
      markup += mathCommandMarkup(command[1]);
      index += command[0].length;
      continue;
    }
    if (source.startsWith("sqrt(", index) || source.startsWith("√(", index)) {
      const start = source.startsWith("sqrt(", index) ? index + 5 : index + 2;
      const end = findClosingParen(source, start - 1);
      if (end > start) {
        markup += mathSqrtMarkup(source.slice(start, end));
        index = end + 1;
        continue;
      }
    }
    const fn = source.slice(index).match(/^(sin|cos|tan|exp|ln|log)(?=\s*\()/);
    if (fn) {
      markup += `<span class="math-function">${escapeHtml(fn[1])}</span>`;
      index += fn[1].length;
      continue;
    }
    const char = source[index];
    if (char === "_" || char === "^") {
      const argument = readScriptArgument(source, index + 1);
      const tag = char === "_" ? "sub" : "sup";
      markup += `<${tag}>${renderInlineMath(argument.value)}</${tag}>`;
      index = argument.next;
      continue;
    }
    if (char === "/" && markup.trim() && !unitSlash) {
      const denominator = readSimpleDenominator(source, index + 1);
      if (denominator.value) {
        const numerator = takePreviousMathTerm(markup);
        const numeratorText = numerator.term.replace(/<[^>]+>/g, "");
        if (!looksLikeAbbreviationPair(numeratorText, denominator.value)) {
          markup = numerator.before + `<span class="math-frac"><span class="math-num">${numerator.term}</span><span class="math-den">${renderInlineMath(denominator.value)}</span></span>`;
          index = denominator.next;
          continue;
        }
      }
    }
    if (/\s/.test(char)) markup += '<span class="math-space"></span>';
    else if (/[A-Za-zΑ-Ωα-ω\u0370-\u03ff]/.test(char)) markup += `<span class="math-var">${escapeHtml(char)}</span>`;
    else if (/[=＝≈≤≥+\-−*/()]/.test(char)) markup += `<span class="math-operator">${escapeHtml(normalizeMathOperator(char))}</span>`;
    else markup += escapeHtml(char);
    index += 1;
  }
  return markup;
}

function normalizeMathSource(value) {
  return convertUnicodeScripts(repairBrokenLatexTokens(value))
    .replaceAll("＝", "=")
    .replaceAll("√", "\\sqrt")
    .replaceAll("π", "\\pi")
    .replaceAll("Π", "\\Pi")
    .replaceAll("μ", "\\mu")
    .replaceAll("Μ", "\\Mu")
    .replaceAll("ħ", "\\hbar")
    .replaceAll("ℏ", "\\hbar")
    .replaceAll("½", "\\frac{1}{2}")
    .replaceAll("²", "^2")
    .replaceAll("³", "^3");
}

// Shared maps for converting runs of Unicode super/subscript characters into
// grouped LaTeX scripts: 10¹⁵ → 10^{15}, E_n⁽¹⁾ → E_n^{(1)}, 10⁻³⁴ → 10^{-34}.
const SUPERSCRIPT_CHAR_MAP = {
  "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4",
  "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9",
  "⁺": "+", "⁻": "-", "⁽": "(", "⁾": ")", "ⁿ": "n",
};
const SUBSCRIPT_CHAR_MAP = {
  "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4",
  "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9",
  "₊": "+", "₋": "-", "₍": "(", "₎": ")",
};
const SUPERSCRIPT_RUN_RE = /[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁽⁾ⁿ]+/g;
const SUBSCRIPT_RUN_RE = /[₀₁₂₃₄₅₆₇₈₉₊₋₍₎]+/g;

function convertUnicodeScripts(value) {
  return String(value ?? "")
    .replace(SUPERSCRIPT_RUN_RE, (run) => `^{${[...run].map((c) => SUPERSCRIPT_CHAR_MAP[c] || c).join("")}}`)
    .replace(SUBSCRIPT_RUN_RE, (run) => `_{${[...run].map((c) => SUBSCRIPT_CHAR_MAP[c] || c).join("")}}`);
}

// Split terminal LaTeX commands that got fused with a following letter, either in
// the raw text or after Unicode→LaTeX conversion: \langlen → \langle n,
// \Deltax → \Delta x, \DeltaE → \Delta E.
function splitFusedTerminalLatexCommands(value) {
  return String(value ?? "").replace(
    /\\(varepsilon|vartheta|varphi|langle|rangle|propto|partial|nabla|Delta|Gamma|Theta|Lambda|Sigma|Upsilon|Omega|infty|hbar|Phi|Psi|Pi|Mu|Nu|Xi)(?=[A-Za-z])/g,
    "\\$1 ",
  );
}

const COMBINING_ACCENT_MAP = {
  "\u0300": "\\grave", "\u0301": "\\acute", "\u0302": "\\hat", "\u0303": "\\tilde",
  "\u0304": "\\bar", "\u0305": "\\overline", "\u0306": "\\breve", "\u0307": "\\dot", "\u0308": "\\ddot",
  "\u20d7": "\\vec",
};

// Sanitize non-LaTeX text characters that would otherwise crash or redden KaTeX:
// fill-in-the-blank underscore runs (____), bare # / %, and combining diacritical
// accents (combining overline/hat/vec from PDF extraction).
function sanitizeLatexTextChars(value) {
  let source = String(value ?? "");
  source = source.replace(/([A-Za-zΑ-Ωα-ω])([̀-̈⃗])/g, (match, ch, mark) => `${COMBINING_ACCENT_MAP[mark] || "\\bar"}{${ch}}`);
  source = source.replace(/_{2,}/g, (run) => "\\_".repeat(run.length));
  source = source.replace(/(?<!\\)#/g, "\\#");
  source = source.replace(/(?<!\\)%/g, "\\%");
  return source;
}

function plainMathToLatex(value, options = {}) {
  let source = repairBrokenLatexTokens(value).trim();
  source = source
    .replaceAll("＝", "=")
    .replaceAll("≈", "\\approx")
    .replaceAll("≤", "\\le")
    .replaceAll("≥", "\\ge")
    .replaceAll("≠", "\\ne")
    .replaceAll("±", "\\pm")
    .replaceAll("∓", "\\mp")
    // trailing space prevents \cdot fusing with a following letter (J·s → \cdot s,
    // not the accidental \cdots command)
    .replaceAll("⋅", "\\cdot ")
    .replaceAll("·", "\\cdot ")
    .replaceAll("×", "\\times")
    .replaceAll("÷", "\\div")
    .replaceAll("°", "^\\circ")
    .replaceAll("′", "^\\prime")
    .replaceAll("″", "^{\\prime\\prime}")
    .replaceAll("∞", "\\infty")
    .replaceAll("∝", "\\propto")
    .replaceAll("∈", "\\in")
    .replaceAll("∉", "\\notin")
    .replaceAll("∀", "\\forall")
    .replaceAll("∃", "\\exists")
    .replaceAll("∑", "\\sum")
    .replaceAll("∏", "\\prod")
    .replaceAll("∫", "\\int")
    .replaceAll("∂", "\\partial")
    .replaceAll("∇", "\\nabla")
    .replaceAll("√", "\\sqrt")
    .replaceAll("π", "\\pi")
    .replaceAll("Π", "\\Pi")
    .replaceAll("μ", "\\mu")
    .replaceAll("Μ", "\\Mu")
    .replaceAll("ν", "\\nu")
    .replaceAll("Ν", "\\Nu")
    .replaceAll("λ", "\\lambda")
    .replaceAll("Λ", "\\Lambda")
    .replaceAll("Δ", "\\Delta")
    .replaceAll("δ", "\\delta")
    .replaceAll("θ", "\\theta")
    .replaceAll("Θ", "\\Theta")
    .replaceAll("φ", "\\phi")
    .replaceAll("Φ", "\\Phi")
    .replaceAll("ψ", "\\psi")
    .replaceAll("Ψ", "\\Psi")
    .replaceAll("χ", "\\chi")
    .replaceAll("ω", "\\omega")
    .replaceAll("Ω", "\\Omega")
    .replaceAll("σ", "\\sigma")
    .replaceAll("Σ", "\\Sigma")
    .replaceAll("τ", "\\tau")
    .replaceAll("ρ", "\\rho")
    .replaceAll("η", "\\eta")
    .replaceAll("ξ", "\\xi")
    .replaceAll("Ξ", "\\Xi")
    .replaceAll("ζ", "\\zeta")
    .replaceAll("ι", "\\iota")
    .replaceAll("κ", "\\kappa")
    .replaceAll("ε", "\\varepsilon")
    .replaceAll("ħ", "\\hbar")
    .replaceAll("ℏ", "\\hbar")
    .replaceAll("½", "\\frac{1}{2}")
    .replaceAll("¼", "\\frac{1}{4}")
    .replaceAll("¾", "\\frac{3}{4}")
    .replaceAll("→", "\\rightarrow")
    .replaceAll("←", "\\leftarrow")
    .replaceAll("↔", "\\leftrightarrow")
    .replaceAll("⇒", "\\Rightarrow")
    .replaceAll("⇐", "\\Leftarrow")
    .replaceAll("⇔", "\\Leftrightarrow")
    .replaceAll("⟩", "\\rangle")
    .replaceAll("⟨", "\\langle")
    .replaceAll("∼", "\\sim")
    .replaceAll("≡", "\\equiv")
    .replaceAll("⊗", "\\otimes")
    .replaceAll("⊕", "\\oplus")
    .replaceAll("⊂", "\\subset")
    .replaceAll("⊃", "\\supset")
    .replaceAll("∅", "\\emptyset");
  // Grouped Unicode super/subscripts: 10¹⁵ → 10^{15}, E_n⁽¹⁾ → E_n^{(1)}
  source = convertUnicodeScripts(source);
  // Split fused commands produced by the Unicode→LaTeX conversion above
  // (⟨n⁽⁰⁾⟩ → \langlen^{(0)} → \langle n^{(0)}, ΔE → \DeltaE → \Delta E).
  source = splitFusedTerminalLatexCommands(source);
  // Second repair pass: lowercase-Greek fusions created by the conversions
  // (nπx → n\pix → n\pi x) are caught here via the maximal-word-safe CMD_RE.
  source = repairBrokenLatexTokens(source);
  // Blanks (____), bare # / %, combining accents → KaTeX-safe forms.
  source = sanitizeLatexTextChars(source);
  if (options.unitContext && shouldRenderAsUnitSlash(source, true)) return compactUnitSlash(source);
  source = source.replace(/\bsqrt\s*\(([^()]*)\)|√\s*\(([^()]*)\)/g, (_, left, right) => `\\sqrt{${plainMathToLatex(left || right)}}`);
  // FIX: (?<!\\) prevents already-correct \exp / \sin from becoming \\exp (double
  // backslash = LaTeX line-break command, which corrupts the formula).
  source = source.replace(/(?<!\\)\b(sin|cos|tan|exp|ln|log)\b/g, "\\$1");
  // Protect \text{...} / \mathrm{...} spans: slash→frac conversion must NOT fire
  // inside them (\frac is illegal in text mode).
  const textSpans = [];
  source = source.replace(/\\(?:text|mathrm)\{[^{}]*\}/g, (span) => {
    textSpans.push(span);
    return `\x00TSPAN${textSpans.length - 1}\x00`;
  });
  source = source.replace(/\(\s*([^()]+?)\s*\)\s*\/\s*\(\s*([^()]+?)\s*\)/g, (_, numerator, denominator) => `\\frac{${plainMathToLatex(numerator)}}{${plainMathToLatex(denominator)}}`);
  // FIX: restrict slash→\frac conversion to SINGLE tokens on each side, and never
  // when the numerator is the tail of a decimal (-13.6/1² must NOT become
  // -13.\frac{6}{1^2}), the middle of a word/command (\hbar^2 must NOT become
  // \h\frac{bar^2}{2}), or sits inside a brace/script group (^{1/2} stays as-is).
  const SLASH_TOKEN = String.raw`(?:\\[A-Za-z]+(?:\{[^{}]*\})?(?:[_^](?:\{[^{}]*\}|[A-Za-z0-9]+))?|[A-Za-z0-9]+(?:\.[0-9]+)?(?:[_^](?:\{[^{}]*\}|[A-Za-z0-9]+))?)`;
  source = source.replace(
    new RegExp(`(?<![\\d.\\\\/_A-Za-z{}^])(${SLASH_TOKEN})\\s*\\/\\s*(${SLASH_TOKEN})`, "g"),
    (match, numerator, denominator) => {
      // A numerator containing a decimal point is a measured value, not a
      // fraction part: -13.6/1² must stay a slash, never \frac{13.6}{1^2}.
      if (/\d\.\d/.test(numerator)) return match;
      if (looksLikeAbbreviationPair(numerator, denominator)) return match;
      return `\\frac{${numerator}}{${denominator}}`;
    },
  );
  source = source.replace(/\x00TSPAN(\d+)\x00/g, (_, i) => textSpans[Number(i)]);
  // Unwrap \text{...} spans that only contain math commands (e.g. \text{ħω} →
  // \text{\hbar\omega} would render the commands literally in text mode).
  source = unwrapMathOnlyTextGroups(source);
  // Wrap multi-char LaTeX commands after _ or ^ in braces so KaTeX/MathJax parses them correctly
  source = source.replace(/([_^])\\([A-Za-z]+)(?![A-Za-z])(?!\s*\{)/g, "$1{\\$2}");
  return source.replace(/\s+/g, " ");
}

function shouldDisplayBareFormula(value) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  if (/\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$/.test(text)) return true;
  const mathSignals = (text.match(/[=＝≈≤≥^_√πΠμΜħℏ]|\\frac|\\sqrt|\\int|\/|\bsin\b|\bexp\b/g) || []).length;
  return mathSignals >= 2 && (text.length >= 18 || /[=＝≈≤≥]/.test(text));
}

function normalizeMathOperator(char) {
  return char === "＝" ? "=" : char === "−" ? "-" : char;
}

function mathCommandMarkup(command) {
  const functions = new Set(["sin", "cos", "tan", "exp", "ln", "log"]);
  if (functions.has(command)) return `<span class="math-function">${escapeHtml(command)}</span>`;
  const symbols = {
    alpha: "α",
    beta: "β",
    gamma: "γ",
    Gamma: "Γ",
    Delta: "Δ",
    delta: "δ",
    epsilon: "ϵ",
    varepsilon: "ε",
    zeta: "ζ",
    eta: "η",
    theta: "θ",
    Theta: "Θ",
    iota: "ι",
    kappa: "κ",
    lambda: "λ",
    Lambda: "Λ",
    mu: "μ",
    Mu: "Μ",
    nu: "ν",
    Nu: "Ν",
    xi: "ξ",
    Xi: "Ξ",
    pi: "π",
    Pi: "Π",
    rho: "ρ",
    sigma: "σ",
    Sigma: "Σ",
    tau: "τ",
    Tau: "Τ",
    upsilon: "υ",
    Upsilon: "Υ",
    phi: "φ",
    Phi: "Φ",
    chi: "χ",
    psi: "ψ",
    Psi: "Ψ",
    omega: "ω",
    Omega: "Ω",
    hbar: "ℏ",
    approx: "≈",
    le: "≤",
    leq: "≤",
    ge: "≥",
    geq: "≥",
    ne: "≠",
    neq: "≠",
    equiv: "≡",
    pm: "±",
    mp: "∓",
    times: "×",
    div: "÷",
    cdot: "·",
    infty: "∞",
    propto: "∝",
    sim: "∼",
    nabla: "∇",
    partial: "∂",
    int: "∫",
    sum: "∑",
    prod: "∏",
    sqrt: "√",
    langle: "⟨",
    rangle: "⟩",
    in: "∈",
    notin: "∉",
    subset: "⊂",
    supset: "⊃",
    otimes: "⊗",
    oplus: "⊕",
    emptyset: "∅",
    forall: "∀",
    exists: "∃",
    rightarrow: "→",
    leftarrow: "←",
    leftrightarrow: "↔",
    Rightarrow: "⇒",
    Leftarrow: "⇐",
    Leftrightarrow: "⇔",
    circ: "∘",
    prime: "′",
    dots: "…",
    ldots: "…",
    cdots: "⋯",
  };
  const symbol = symbols[command];
  if (symbol) return `<span class="math-symbol">${escapeHtml(symbol)}</span>`;
  return `<span class="math-roman">${escapeHtml(command)}</span>`;
}

function mathSqrtMarkup(value) {
  return `<span class="math-sqrt"><span class="math-radical">√</span><span class="math-radicand">${renderInlineMath(value)}</span></span>`;
}

function findClosingParen(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")") depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function readScriptArgument(source, start) {
  if (source[start] === "{") return readMathArgument(source, start);
  const match = source.slice(start).match(/^\\[A-Za-z]+|^[A-Za-z0-9Α-Ωα-ω\u0370-\u03ff]+/);
  if (match) return { value: match[0], next: start + match[0].length };
  return { value: source[start] || "", next: Math.min(start + 1, source.length) };
}

function readSimpleDenominator(source, start) {
  let index = start;
  while (source[index] === " ") index += 1;
  const match = source.slice(index).match(/^(?:\\[A-Za-z]+|[A-Za-z0-9_{}Α-Ωα-ω\u0370-\u03ff]+)+/);
  if (!match) return { value: "", next: start };
  return { value: match[0], next: index + match[0].length };
}

function takePreviousMathTerm(markup) {
  const match = markup.match(/((?:(?:<span class="math-(?:var|operator|function|symbol|roman)">[^<]+<\/span>)(?:<sup>.*?<\/sup>|<sub>.*?<\/sub>)?)+|\S+)$/);
  if (!match) return { before: markup, term: "" };
  return { before: markup.slice(0, match.index), term: match[0] };
}

function readMathArgument(source, start) {
  let index = start;
  while (source[index] === " ") index += 1;
  if (source[index] === "(") {
    const end = findClosingParen(source, index);
    if (end > index) return { value: source.slice(index + 1, end), next: end + 1 };
  }
  if (source[index] !== "{") return { value: source[index] || "", next: Math.min(index + 1, source.length) };
  let depth = 1;
  let cursor = index + 1;
  while (cursor < source.length && depth > 0) {
    if (source[cursor] === "{") depth += 1;
    if (source[cursor] === "}") depth -= 1;
    cursor += 1;
  }
  return { value: source.slice(index + 1, Math.max(index + 1, cursor - 1)), next: cursor };
}

// ctx = { projectId, sources }：给「不是当前课程」的来源视图用
// （阅读界面的对比视图要点开的是那组文献所属项目里的资料，当前课程里当然找不到）。
// 不传 ctx 时一切照旧。
async function openSourcePreview(sourceId, quote = "", ctx = null) {
  const sources = (ctx && Array.isArray(ctx.sources)) ? ctx.sources : state.sources;
  const projectId = (ctx && ctx.projectId) ? ctx.projectId : state.currentProjectId;
  let source = sources.find((item) => item.source_id === sourceId);
  const previousStatus = source?.status;
  if (!source) return showError(new Error(ctx ? "未找到对应的资料。" : "未找到对应的项目材料。"));

  const dialog = $("#source-preview-dialog");
  const body = $("#source-preview-body");
  $("#source-preview-title").textContent = source.filename;
  $("#source-preview-meta").textContent = "正在准备视觉预览…";
  body.className = "source-preview-body text-preview-layout";
  body.innerHTML = '<div class="source-preview-loading">正在读取原文件和内嵌图片…</div>';
  if (!dialog.open) dialog.showModal();

  try {
    const preview = await api(`/api/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(source.source_id)}/preview`);
    const index = sources.findIndex((item) => item.source_id === sourceId);
    if (index >= 0) sources[index] = { ...sources[index], ...preview };
    source = index >= 0 ? sources[index] : preview;
    // ctx 场景不动课程侧的资料列表与界面
    if (!ctx && source.status !== previousStatus) renderSources();
  } catch (error) {
    body.innerHTML = `<div class="source-original-unavailable">${escapeHtml(error.message || "材料预览准备失败。")}</div>`;
    return;
  }

  const status = sourceStatus(source);
  const extension = extensionLabel(source.filename);
  const contentUrl = `/api/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(source.source_id)}/content`;
  const imageType = ["PNG", "JPG", "JPEG"].includes(extension);
  const pdfType = extension === "PDF";
  const documentType = ["DOC", "DOCX", "PPT", "PPTX"].includes(extension);
  const presentationType = ["PPT", "PPTX"].includes(extension);
  const hasOriginal = Boolean(source.content_available);
  const previewImages = Array.isArray(source.preview_images) ? source.preview_images : [];
  const previewPdfUrl = source.preview_pdf_url || "";
  const usePdfIframe = pdfType || (presentationType && !!previewPdfUrl);

  $("#source-preview-title").textContent = source.filename;
  $("#source-preview-meta").textContent = `${extension} · ${formatBytes(source.size_bytes)} · ${status.label}`;

  let originalMarkup = "";
  if (hasOriginal && imageType) {
    originalMarkup = `<section class="source-original source-image-original"><div class="source-preview-section-heading"><strong>原始图片</strong><a href="${escapeAttr(contentUrl)}" target="_blank" rel="noopener">单独打开</a></div><img src="${escapeAttr(contentUrl)}" alt="${escapeAttr(source.filename)}"></section>`;
  } else if (hasOriginal && usePdfIframe) {
    const iframeSrc = pdfType ? contentUrl : previewPdfUrl;
    const iframeLabel = pdfType ? "原始 PDF" : "PDF 预览";
    const downloadLabel = pdfType ? "单独打开" : "打开原文件";
    originalMarkup = `<section class="source-original source-pdf-original"><div class="source-preview-section-heading"><strong>${iframeLabel}</strong><a href="${escapeAttr(pdfType ? contentUrl : previewPdfUrl)}" target="_blank" rel="noopener">${downloadLabel}</a></div><iframe src="${escapeAttr(iframeSrc)}" title="${escapeAttr(source.filename)}"></iframe></section>`;
  } else if (hasOriginal && documentType && previewImages.length) {
    const visualLabel = presentationType ? "幻灯片预览" : "文档内图片";
    const captionLabel = presentationType ? "第" : "图片";
    originalMarkup = `<section class="source-original source-document-visuals"><div class="source-preview-section-heading"><strong>${visualLabel}（${previewImages.length}）</strong><a href="${escapeAttr(contentUrl)}" target="_blank" rel="noopener">打开原文件</a></div><div class="source-image-gallery">${previewImages.map((image, index) => `<figure><img src="${escapeAttr(image.url)}" alt="${escapeAttr(source.filename)} ${visualLabel} ${index + 1}" loading="lazy"><figcaption>${presentationType ? `${captionLabel} ${index + 1} 页` : `${captionLabel} ${index + 1}`}</figcaption></figure>`).join("")}</div></section>`;
  } else if (hasOriginal) {
    originalMarkup = `<div class="source-original-link"><span>${presentationType ? "当前环境未生成幻灯片预览，以下显示提取文本" : documentType ? "文档中未发现可提取的内嵌图片，以下显示文字内容" : "浏览器内显示提取文本"}</span><a href="${escapeAttr(contentUrl)}" target="_blank" rel="noopener">打开原文件</a></div>`;
  } else {
    originalMarkup = '<div class="source-original-unavailable">历史材料未保留原文件，以下显示已提取文本；重新上传后可预览原件。</div>';
  }

  const textMarkup = source.text?.trim()
    ? `<section class="source-text-section"><div class="source-preview-section-heading"><strong>${imageType ? "OCR 文字" : "提取文本"}</strong>${quote ? "<span>已定位引用位置</span>" : ""}</div><div class="source-text-content">${highlightSourceText(source.text, quote)}</div></section>`
    : '<section class="source-text-section"><div class="source-text-empty">该材料没有可显示的提取文本。</div></section>';
  const hasQuote = Boolean(quote?.trim());
  const pdfOnly = usePdfIframe && hasOriginal && !hasQuote;
  const pdfWithText = usePdfIframe && hasOriginal && hasQuote;
  body.className = `source-preview-body ${imageType ? "image-preview-layout" : pdfOnly || pdfWithText ? `pdf-preview-layout${pdfWithText ? " pdf-preview-with-text" : ""}` : documentType && previewImages.length ? "document-preview-layout" : "text-preview-layout"}`;
  body.innerHTML = pdfOnly ? originalMarkup : `${originalMarkup}${textMarkup}`;
  scheduleMathJaxTypeset();

  requestAnimationFrame(() => {
    const highlight = $("#source-text-highlight");
    if (highlight) highlight.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

function highlightSourceText(text, quote) {
  const range = findNormalizedQuoteRange(text, quote);
  if (!range) return escapeHtml(text);
  return `${escapeHtml(text.slice(0, range.start))}<mark id="source-text-highlight">${escapeHtml(text.slice(range.start, range.end))}</mark>${escapeHtml(text.slice(range.end))}`;
}

function findNormalizedQuoteRange(text, quote) {
  if (!text || !quote?.trim()) return null;
  const normalize = (value, includeMap = false) => {
    let normalized = "";
    const map = [];
    let previousWasSpace = false;
    [...value].forEach((char, index) => {
      const isSpace = /\s/.test(char);
      if (isSpace && (previousWasSpace || !normalized)) return;
      normalized += isSpace ? " " : char.toLowerCase();
      if (includeMap) map.push(index);
      previousWasSpace = isSpace;
    });
    if (normalized.endsWith(" ")) {
      normalized = normalized.slice(0, -1);
      if (includeMap) map.pop();
    }
    return { normalized, map };
  };
  const source = normalize(text, true);
  const target = normalize(quote).normalized;
  const normalizedStart = source.normalized.indexOf(target);
  if (normalizedStart < 0 || !target) return null;
  const start = source.map[normalizedStart];
  const endMapIndex = normalizedStart + target.length - 1;
  const end = (source.map[endMapIndex] ?? start) + 1;
  return { start, end };
}

function renderConversationHistory(messages) {
  $("#conversation").innerHTML = "";
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) {
    appendMessage("assistant", "当前项目已加载。上传材料、构建框架后即可开始提问或做题。");
    return;
  }
  let lastUserMessageId = "";
  list.forEach((message) => {
    const sourceRefs = state.sources
      .filter((source) => message.source_ids?.includes(source.source_id))
      .map((source) => ({ source_id: source.source_id, filename: source.filename }));
    const article = appendMessage(message.role, message.content, { ...message, source_refs: sourceRefs });
    if (message.role === "user") {
      lastUserMessageId = message.message_id;
    } else if (message.role === "assistant" && lastUserMessageId) {
      attachQuestionFavoriteAction(article, lastUserMessageId, message.message_id);
    }
  });
  refreshQuestionRails();
}

// —— 对话滚动栏「提问节点」：在滚动条上标出每个历史提问，点击可跳转回看 ——
// QUESTION_RAILS: scrollBox -> { rail, sel, nodes, raf, rafActive, sync }
const QUESTION_RAILS = new Map();
const QN_RAIL_PAD = 6;
const QN_RAIL_HIT = 12;
const QN_LIMIT = 400;

function addQuestionRail(scrollBox, userMsgSelector, opts) {
  if (!scrollBox || QUESTION_RAILS.has(scrollBox)) return;
  const rail = document.createElement("div");
  rail.className = "question-rail";
  rail.setAttribute("role", "group");
  rail.setAttribute("aria-label", "历史提问：点击星点可跳转到对应提问");
  document.body.appendChild(rail);
  const nodes = new Map(); // 消息元素 -> 节点按钮
  const st = { rail, sel: userMsgSelector, nodes, raf: 0, rafActive: 0, hideWhenKbDock: !!(opts && opts.hideWhenKbDock) };
  QUESTION_RAILS.set(scrollBox, st);

  function items() {
    return Array.from(scrollBox.querySelectorAll(st.sel)).slice(0, QN_LIMIT);
  }
  function build(list) {
    nodes.forEach((n, it) => { if (!list.includes(it)) { n.remove(); nodes.delete(it); } });
    list.forEach((it, idx) => {
      let n = nodes.get(it);
      if (!n) {
        n = document.createElement("button");
        n.type = "button";
        n.className = "question-node";
        n.tabIndex = 0;
        n.addEventListener("click", () => it.scrollIntoView({ block: "start" }));
        nodes.set(it, n);
        rail.appendChild(n);
      }
      const raw = (it.textContent || "").replace(/\s+/g, " ").trim();
      const preview = raw.slice(0, 24);
      n.setAttribute("aria-label", `跳转到第 ${idx + 1} 个提问：${preview || "（无文字）"}`);
      n.dataset.preview = `问题 ${idx + 1}：${preview || "（无文字）"}`;
      n.title = `问题 ${idx + 1}`;
    });
  }
  function sync() {
    const r = scrollBox.getBoundingClientRect();
    const list = items();
    build(list);
    // 被全屏覆盖（KB 弹窗或"学习产出"展开）时，主对话导轨若不隐藏会穿透盖到上层，故一并隐藏
    let covered = false;
    if (st.hideWhenKbDock) {
      const dock = document.querySelector("[data-kb-dock]");
      covered = !!(dock && !dock.hidden) || document.body.classList.contains("studio-focus-open");
    }
    const visible = covered ? false : (r.width > 4 && r.height > 4 && scrollBox.getClientRects().length > 0);
    if (!visible || !list.length) {
      rail.classList.remove("on");
      markActive();
      return;
    }
    rail.classList.add("on");
    const span = Math.max(1, scrollBox.scrollHeight - scrollBox.clientHeight);
    const trackH = Math.max(0, r.height - QN_RAIL_PAD * 2);
    // 贴靠在原生滚动条左侧；滚动条宽度用 offsetWidth-clientWidth 探测（overlay 模式为 0）
    const scrollbarW = Math.max(0, scrollBox.offsetWidth - scrollBox.clientWidth);
    const stripLeft = Math.max(2, r.right - scrollbarW - 11);
    rail.style.top = `${r.top + QN_RAIL_PAD}px`;
    rail.style.left = `${stripLeft}px`;
    rail.style.height = `${trackH}px`;
    list.forEach((it) => {
      const n = nodes.get(it);
      const offsetInContent = it.getBoundingClientRect().top - r.top + scrollBox.scrollTop;
      const frac = Math.min(1, Math.max(0, offsetInContent / span));
      n.style.top = `${Math.max(0, Math.min(trackH - QN_RAIL_HIT, frac * trackH))}px`;
    });
    markActive();
  }
  function markActive() {
    if (!scrollBox.offsetHeight) return;
    const viewTop = scrollBox.scrollTop;
    const boxTop = scrollBox.getBoundingClientRect().top;
    let best = null, bestDist = Number.POSITIVE_INFINITY;
    scrollBox.querySelectorAll(st.sel).forEach((it) => {
      const dist = it.getBoundingClientRect().top - boxTop + scrollBox.scrollTop - viewTop;
      if (dist >= -2 && dist < bestDist) { bestDist = dist; best = it; }
    });
    nodes.forEach((n, it) => {
      const grown = it.getBoundingClientRect().top - boxTop + viewTop <= viewTop;
      n.classList.toggle("active", it === best);
      // “节节生长”：已滚过/已到达的提问对应海棠盛开，未到的仍是花苞
      n.classList.toggle("bloomed", grown);
    });
  }
  st.sync = sync;

  scrollBox.addEventListener("scroll", () => {
    cancelAnimationFrame(st.rafActive);
    st.rafActive = requestAnimationFrame(markActive);
  }, { passive: true });
  const ro = new ResizeObserver(() => { st.raf = requestAnimationFrame(sync); });
  ro.observe(scrollBox);
  const mo = new MutationObserver(() => {
    cancelAnimationFrame(st.raf);
    st.raf = requestAnimationFrame(sync);
  });
  mo.observe(scrollBox, { subtree: true, childList: true, characterData: true });
  window.addEventListener("resize", () => { st.raf = requestAnimationFrame(sync); });
  window.addEventListener("scroll", () => { st.raf = requestAnimationFrame(sync); }, { passive: true });
  sync();
}

function refreshQuestionRails() {
  QUESTION_RAILS.forEach((st) => {
    cancelAnimationFrame(st.raf);
    st.raf = requestAnimationFrame(st.sync);
  });
}

function initQuestionRail() {
  addQuestionRail(document.getElementById("conversation"), ".message.user-message", { hideWhenKbDock: true });
}

/* ---- 主对话推荐问题（可换一批）---- */
const SUGGESTED_QUESTION_COUNT = 5;

const HIDE_SUGGESTED_KEY = "knoworigin.hideSuggested";
function isSuggestedHidden() {
  try { return localStorage.getItem(HIDE_SUGGESTED_KEY) === "1"; } catch { return false; }
}

// 把推荐问题里模型可能残留的 LaTeX 转成可读的 Unicode 文本，避免按钮上出现裸代码
const LATEX_TO_UNICODE = {
  "\\hbar": "ℏ", "\\epsilon": "ε", "\\varepsilon": "ε", "\\mu": "μ",
  "\\pi": "π", "\\psi": "ψ", "\\theta": "θ", "\\phi": "ϕ", "\\varphi": "φ",
  "\\alpha": "α", "\\beta": "β", "\\gamma": "γ", "\\lambda": "λ",
  "\\omega": "ω", "\\delta": "δ", "\\sigma": "σ", "\\tau": "τ",
  "\\eta": "η", "\\rho": "ρ", "\\kappa": "κ", "\\zeta": "ζ",
  "\\xi": "ξ", "\\zeta": "ζ",
  "\\geq": "≥", "\\leq": "≤", "\\ge": "≥", "\\le": "≤",
  "\\neq": "≠", "\\ne": "≠", "\\approx": "≈", "\\propto": "∝",
  "\\times": "×", "\\cdot": "·", "\\pm": "±", "\\mp": "∓",
  "\\infty": "∞", "\\nabla": "∇", "\\partial": "∂", "\\int": "∫",
  "\\sum": "∑", "\\prod": "∏", "\\sqrt": "√", "\\ldots": "…", "\\dots": "…",
  "\\text": "", "\\mathrm": "", "\\textrm": "", "\\mathit": "", "\\mathcal": "",
  "\\left": "", "\\right": "", "\\begin": "", "\\end": "",
};
const SUPER_MAP = { "0":"⁰","1":"¹","2":"²","3":"³","4":"⁴","5":"⁵","6":"⁶","7":"⁷","8":"⁸","9":"⁹","+":"⁺","-":"⁻","n":"ⁿ","m":"ᵐ","i":"ⁱ","j":"ʲ","a":"ᵃ","b":"ᵇ","t":"ᵗ","o":"ᵒ" };
const SUB_MAP = { "0":"₀","1":"₁","2":"₂","3":"₃","4":"₄","5":"₅","6":"₆","7":"₇","8":"₈","9":"₉","+":"₊","-":"₋","n":"ₙ","m":"ₘ","l":"ₗ","r":"ᵣ","i":"ᵢ","j":"ⱼ","e":"ₑ","x":"ₓ" };

function _toSuper(s) { return [...s].map((c) => SUPER_MAP[c] || c).join("") || s; }
function _toSub(s) { return [...s].map((c) => SUB_MAP[c] || c).join("") || s; }

function latexToPlain(text) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const [cmd, uni] of Object.entries(LATEX_TO_UNICODE)) {
    out = out.split(cmd).join(uni);
  }
  // “命令{内容}”形式（\bar{h}、\hat{x}、\tilde{y}）只保留内容
  out = out.replace(/\\(?:bar|hat|widehat|tilde|vec|mathrm|textbf|textit|mathcal)\{([^}]*)\}/g, "$1");
  // 分式 \frac{a}{b}／\dfrac{a}{b} → (a)/(b)，做多轮以摊平嵌套分式
  for (let i = 0; i < 4 && /\\d?frac\{/.test(out); i += 1) {
    out = out.replace(/\\d?frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1)/($2)");
  }
  // 上标/下标：先处理带花括号形式，再处理单字符形式，如 L^{2}、E_n、L_{+}
  out = out.replace(/\^\{([^}]*)\}/g, (m, inner) => _toSuper(inner));
  out = out.replace(/_\{([^}]*)\}/g, (m, inner) => _toSub(inner));
  out = out.replace(/\^([0-9A-Za-z+\-])/g, (m, c) => _toSuper(c));
  out = out.replace(/([A-Za-z0-9])_([0-9A-Za-z+\-])/g, (m, a, c) => `${a}${_toSub(c)}`);
  // 清除数学分隔符、残留花括号与反斜杠占位
  return out
    .split("$$").join("")
    .split("\\[").join("").split("\\]").join("")
    .split("\\(").join("").split("\\)").join("")
    .split("$").join("")
    .split("_").join("").split("^").join("")
    .split("{").join("").split("}").join("")
    .replace(/\\+/g, "");
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildSuggestedQuestionBatch() {
  const nodes = state.nodes || [];
  if (!nodes.length) return [];
  const byId = new Map(nodes.map((n) => [n.node_id, n]));
  const isMastered = (n) => n.learning_status === "mastered" || (Number(n.mastery_score) || 0) >= 0.8;

  // 子节点分组：一个父节点 -> 其直接子节点
  const kids = new Map();
  nodes.forEach((n) => {
    if (n.parent_id && n.parent_id !== n.node_id) {
      if (!kids.has(n.parent_id)) kids.set(n.parent_id, []);
      kids.get(n.parent_id).push(n);
    }
  });

  const pool = [];
  const name = (n) => n.name;

  // 按掌握度锚定深度的基础问题（置于关系类之前，避免被其淹没）
  const addBasic = (n) => {
    const desc = (n.description || "").trim();
    if (isMastered(n)) {
      pool.push(`我已经掌握「${name(n)}」，出 2 道需要综合运用相关概念的小题考考我`);
      const cs = kids.get(n.node_id);
      if (cs && cs.length >= 2) {
        pool.push(`「${name(n)}」下有「${cs[0].name}」「${cs[1].name}」等子概念，它们各自侧重考查什么？`);
      }
    } else {
      pool.push(`我还没掌握「${name(n)}」，请把要点讲清楚，并指出最常见的易错点`);
      if (desc) pool.push(`项目里「${name(n)}」（${desc.slice(0, 30)}）为什么这样设计？请结合资料讲清缘由`);
    }
  };

  // 结构/关系类问题：前置逻辑、兄弟对比、前置概念作用，比单纯的「是什么关系」更具体
  const addRel = (n) => {
    if (n.parent_id && n.parent_id !== n.node_id) {
      const p = byId.get(n.parent_id);
      if (p) {
        pool.push(`为什么理解「${p.name}」是学懂「${name(n)}」的前提？两者间的逻辑关系是什么？`);
        const sibs = (kids.get(n.parent_id) || []).filter((s) => s.node_id !== n.node_id);
        if (sibs.length) {
          const sib = sibs[0];
          pool.push(`「${name(n)}」和「${sib.name}」在本质上有何区别？各自适用的场景是什么？`);
        }
      }
    }
    if ((n.prerequisite_ids || []).length) {
      const pre = n.prerequisite_ids.map((id) => byId.get(id)).filter(Boolean).map((x) => x.name);
      if (pre.length) {
        pool.push(`要真正理解「${name(n)}」，需要先用好「${pre.join("」「")}」等前置概念，它们各起到什么作用？`);
      }
    }
  };

  const order = shuffle(nodes);
  order.slice(0, SUGGESTED_QUESTION_COUNT * 2).forEach(addBasic);
  order.slice(0, SUGGESTED_QUESTION_COUNT * 2).forEach(addRel);
  if (!pool.length) {
    order.slice(0, 3).forEach((n) => pool.push(`「${name(n)}」讲的是什么？请结合项目资料帮我总结`));
  }

  // 换一批时避开上一批，避免连续重复；候选不够时退回全量
  const prev = new Set(state.suggestedQuestionBatch || []);
  const uniq = [...new Set(pool)];
  const fresh = uniq.filter((q) => !prev.has(q));
  const chosen = shuffle(fresh.length >= SUGGESTED_QUESTION_COUNT ? fresh : uniq).slice(0, SUGGESTED_QUESTION_COUNT);
  state.suggestedQuestionBatch = chosen;
  return chosen;
}

function renderSuggestedQuestions() {
  const container = $("#suggested-questions");
  const list = $("#suggested-questions-list");
  const restore = $("#suggested-restore");
  const restoreInline = $("#suggested-restore-inline");
  if (!container || !list) return;
  // 折叠态（用户主动隐藏）：保留盒头并就地提供「显示」，避免整体消失后找不到恢复入口
  if (isSuggestedHidden()) {
    container.hidden = false;
    container.classList.add("is-collapsed");
    list.innerHTML = "";
    if (restore) restore.hidden = true;
    if (restoreInline) { restoreInline.hidden = false; restoreInline.disabled = false; }
    return;
  }
  // 切换项目后重置大模型批次，避免串台
  if (state.llmSuggestedProject !== state.currentProjectId) {
    state.llmSuggestedProject = state.currentProjectId;
    state.llmSuggested = [];
  }
  // 未导入课程/无节点：保持盒体可见，展示占位引导，避免点「显示」后整盒消失
  if (!state.currentProjectId || !(state.nodes || []).length) {
    container.hidden = false;
    container.classList.remove("is-collapsed");
    if (restore) restore.hidden = true;
    if (restoreInline) { restoreInline.hidden = true; }
    list.innerHTML = `<div class="suggested-questions-empty">导入项目材料后点「生成/更新知识框架」，这里会结合你的掌握度推荐恰合进度的深度问题，帮你复习与迁移。</div>`;
    return;
  }
  const questions = state.llmSuggested.length ? state.llmSuggested : buildSuggestedQuestionBatch();
  if (!questions.length && !state.llmSuggestedLoading) {
    container.hidden = false;
    container.classList.remove("is-collapsed");
    if (restore) restore.hidden = true;
    if (restoreInline) { restoreInline.hidden = true; }
    list.innerHTML = `<div class="suggested-questions-empty">先「生成/更新知识框架」，这里就会为你推荐深度问题。</div>`;
    return;
  }
  container.hidden = false;
  container.classList.remove("is-collapsed");
  if (restore) restore.hidden = true;
  if (restoreInline) { restoreInline.hidden = true; }
  if (state.llmSuggestedLoading && !state.llmSuggested.length) {
    list.innerHTML = `<button type="button" class="suggested-question-chip is-loading" disabled>正在根据资料生成深度问题…</button>`;
  } else {
    list.innerHTML = questions.map((q) =>
      `<button type="button" class="suggested-question-chip" data-suggested-question="${escapeAttr(q)}" title="点击直接提问">${escapeHtml(latexToPlain(q))}</button>`
    ).join("");
  }
  // 首次进入时异步升级为大模型深度问题（一次性，不阻塞当前本地展示）
  if (!state.llmSuggestedLoading && !state.llmSuggested.length) {
    fetchSuggestedQuestionsLLM(questions);
  }
}

async function fetchSuggestedQuestionsLLM(exclude = []) {
  const projectId = state.currentProjectId;
  if (!projectId || !(state.nodes || []).length || state.llmSuggestedLoading) return;
  state.llmSuggestedLoading = true;
  state.llmSuggested = [];
  renderSuggestedQuestions();
  let buffered = [];
  let failed = false;
  let optimized = null; // done 事件里的最终去重列表，非空则采纳
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/recommend-questions/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exclude: exclude || [] }),
    });
    if (!resp.ok || !resp.body) throw new Error("stream unavailable");
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let lastRender = 0;
    // 直接调用 api() 是阻塞式完整返回，这里改成消费 SSE：每收齐一道题就渲染一块，实现边生成边渲染
    for (;;) {
      const { value, done: doneReading } = await reader.read();
      if (doneReading) break;
      buf += decoder.decode(value, { stream: true });
      let boundary = buf.lastIndexOf("\n\n");
      if (boundary < 0) continue;
      const block = buf.slice(0, boundary);
      buf = buf.slice(boundary + 2);
      for (const evt of block.split("\n\n")) {
        const line = evt.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let d;
        try { d = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (!d || typeof d !== "object") continue;
        if (d.type === "question" && typeof d.text === "string" && d.text.trim()) {
          buffered.push(d.text);
          const now = Date.now();
          if (now - lastRender > 100) {
            lastRender = now;
            if (state.currentProjectId === projectId) {
              state.llmSuggested = buffered.filter(Boolean);
              renderSuggestedQuestions();
            }
          }
        } else if (d.type === "done") {
          optimized = Array.isArray(d.questions) && d.questions.length ? d.questions : null;
        } else if (d.type === "fallback" || d.type === "error") {
          failed = true;
        }
      }
    }
    // 收尾：流结束后若还有未拆分的残块，补解析一次
    if (buf.trim()) {
      try {
        const line = buf.split("\n").find((l) => l.startsWith("data:"));
        const d = line ? JSON.parse(line.slice(5).trim()) : null;
        if (d && d.type === "question" && typeof d.text === "string" && d.text.trim()) buffered.push(d.text);
      } catch { /* ignore */ }
    }
  } catch {
    failed = true;
  }
  let next;
  if (!failed && buffered.length) {
    next = optimized && optimized.length ? optimized : buffered.filter(Boolean);
  } else {
    next = optimized && optimized.length ? optimized : buildSuggestedQuestionBatch();
  }
  if (!next.length) next = buildSuggestedQuestionBatch();
  // 仅当仍是同一项目时覆盖，避免过期请求串台
  if (state.currentProjectId === projectId) {
    state.llmSuggested = next;
  }
  state.llmSuggestedLoading = false;
  if (state.currentProjectId === projectId) renderSuggestedQuestions();
}

function hideSuggestedQuestions() {
  try { localStorage.setItem(HIDE_SUGGESTED_KEY, "1"); } catch { /* ignore */ }
  renderSuggestedQuestions();
}

function restoreSuggestedQuestions() {
  try { localStorage.setItem(HIDE_SUGGESTED_KEY, "0"); } catch { /* ignore */ }
  renderSuggestedQuestions();
}

function askSuggestedQuestion(question) {
  if (state.sending) return;
  const input = $("#message-input");
  if (!input) return;
  input.value = question;
  $("#composer").requestSubmit();
}

function handleSuggestedQuestionsClick(event) {
  if (event.target.closest("#suggested-hide")) {
    hideSuggestedQuestions();
    return;
  }
  if (event.target.closest("#suggested-refresh")) {
    // 换一批：清空当前并重新向大模型请求，生成一批不同的深度问题
    const exclude = state.llmSuggested.length ? state.llmSuggested : buildSuggestedQuestionBatch();
    state.llmSuggested = [];
    fetchSuggestedQuestionsLLM(exclude);
    return;
  }
  const chip = event.target.closest("[data-suggested-question]");
  if (chip) askSuggestedQuestion(chip.dataset.suggestedQuestion);
}

async function refreshCurrentProject(options = {}) {
  const previousQuiz = state.quiz;
  const data = await api(`/api/projects/${state.currentProjectId}`);
  state.sources = data.sources || [];
  state.nodes = data.nodes || [];
  state.cards = data.cards || [];
  state.quiz = data.quiz || null;
  if (options.preserveQuizResults && previousQuiz?.quiz_id && previousQuiz.quiz_id === state.quiz?.quiz_id) {
    state.quiz.results = previousQuiz.results || [];
  }
  clearStudySelections();
  state.viewingHistoryQuiz = null;
  state.quizHistory = null; // 刷新后重新加载历史
  state.favorites = data.favorites || [];
  renderSources();
  updateFavoriteCount();
  if (options.renderStudio !== false) renderStudio();
  renderSuggestedQuestions();
}

function switchFeature(feature, opts = {}) {
  // reveal 默认 true：各模块调 switchFeature("cards") 只传一个参数，语义正是「点了就是想看它」。
  // 只有 selectProject 传 { reveal: false }（切项目不该弹浮层）。
  const reveal = opts.reveal !== false;
  const shouldReveal = () => {
    if (reveal && currentUi() === "agent") window.KnowOriginAgentShell?.revealStudio?.();
  };
  state.feature = feature;
  $$(".feature-button").forEach((button) => button.classList.toggle("active", button.dataset.feature === feature));
  syncFeatureNav();
  // 英语词汇视图是盖在 .studio-panel 上的兄弟节点（不在 #studio-output 里），
  // 切到别的功能页时必须收起 —— 否则它继续占着整屏，用户点了「知识卡片」看到的还是词汇页。
  window.enVocabCloseView?.();
  // 产出浮层顶栏/图标栏的高亮跟随 feature。除图标栏点击外还有速查表、卡片学习台、
  // 模块按钮等路径会直接 switchFeature，不同步的话标题会停在上一个功能。
  window.KnowOriginAgentShell?.syncRail?.();
  // 离开 quiz 时顺便退出历史查看模式
  if (feature !== "quiz") state.viewingHistoryQuiz = null;
  // fire-and-forget：后台生成卡片，切换 tab 继续用
  if (feature === "cards" && state.cardsStale && !state.generatingCards) {
    // 别处（知识点文档回流自测题）改过卡片，本地快照已作废：补拉一次再渲染。
    // 不这么做的话，只有 state.cards 为空才会拉 —— 用户本来就有卡片时永远看不到新增的。
    refreshCardsFromServer();
  }
  if (feature === "cards" && !state.cards.length && !state.generatingCards) {
    if (selectableSources().length === 0) {
      showError(new Error("请先导入项目资料。支持 PDF、Word、PPT 或粘贴文本后，即可生成知识卡片。"));
      renderStudio();
      shouldReveal();
      return;
    }
    generateCards();
  }
  if (feature === "quiz" && !state.quiz && !state.generatingQuiz) {
    if (selectableSources().length === 0) {
      showError(new Error("请先导入项目资料。支持 PDF、Word、PPT 或粘贴文本后，即可生成小测验。"));
      renderStudio();
      shouldReveal();
      return;
    }
    generateQuiz();
  }
  if (feature === "overview") overviewHydrate(); // 指挥一下后台生成的 AI 复习路线/清单
  renderStudio();
  shouldReveal();
}

// 学习产出导航收成下拉后，顶栏那颗触发按钮要显示「当前在哪一页」。
// 直接从 .feature-button 里读文案与图标，任何改 state.feature 的路径都自动跟上，
// 不必在每条路径上各写一遍同步。
const FEATURE_NAV_LABELS = {
  framework: "知识框架", overview: "学习概览", cards: "知识卡片",
  quiz: "小测验", favorites: "我的笔记",
};
function syncFeatureNav() {
  const label = document.querySelector("#feature-nav-trigger-label");
  if (!label) return;
  const activeBtn = document.querySelector(`.feature-button[data-feature="${state.feature}"]`);
  const text = (activeBtn?.querySelector(".feature-button > span:not(.feature-icon):not(.feature-count)")?.textContent
    || FEATURE_NAV_LABELS[state.feature] || "学习产出").trim();
  if (label.textContent !== text) label.textContent = text;
  const icon = document.querySelector(".feature-nav-trigger-icon");
  const glyph = activeBtn?.querySelector(".feature-icon")?.textContent;
  if (icon && glyph) icon.textContent = glyph;
}

function closeFeatureNav() {
  const shell = document.querySelector(".feature-nav-shell");
  const trigger = document.querySelector("#feature-nav-trigger");
  if (!shell?.classList.contains("is-open")) return;
  shell.classList.remove("is-open");
  trigger?.setAttribute("aria-expanded", "false");
}

function setupFeatureNav() {
  const shell = document.querySelector(".feature-nav-shell");
  const trigger = document.querySelector("#feature-nav-trigger");
  if (!shell || !trigger) return;
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = shell.classList.toggle("is-open");
    trigger.setAttribute("aria-expanded", String(open));
  });
  // 选中即收起。委托到 shell 上而不是逐个绑 —— 英语词汇页签是运行时注入的。
  shell.addEventListener("click", (event) => {
    if (event.target.closest(".feature-button")) closeFeatureNav();
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".feature-nav-shell")) closeFeatureNav();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeFeatureNav();
  });
  syncFeatureNav();
}

function updateFeatureButtons() {
  // 给正在后台生成的 feature 按钮加上 generating class，UI 显示生成中状态
  const cardBtn = document.querySelector('.feature-button[data-feature="cards"]');
  const quizBtn = document.querySelector('.feature-button[data-feature="quiz"]');
  if (cardBtn) cardBtn.classList.toggle("generating", !!state.generatingCards);
  if (quizBtn) quizBtn.classList.toggle("generating", !!state.generatingQuiz);
  updateRegenerateButtons();
}

// 「再来一批」按钮的加载态：生成中显示转圈并禁用，结束后恢复
function regenerateButtonMarkup(action, generating) {
  const inner = generating
    ? `<span class="btn-spinner" aria-hidden="true"></span> 正在生成…`
    : `<span aria-hidden="true">＋</span> 再来一批`;
  return `<button class="secondary-button${generating ? " is-generating" : ""}" type="button" data-study-action="${action}"${generating ? " disabled" : ""}>${inner}</button>`;
}

// 难度选择器：自动 / 简单 / 中等 / 困难
function studyDifficultySelector() {
  const diffs = [["auto", "自动"], ["1", "简单"], ["2", "中等"], ["3", "困难"]];
  const active = state.studyDifficulty;
  const pills = diffs.map(([val, label]) => {
    const isActive = String(active) === val;
    return `<button class="diff-pill${isActive ? " is-active" : ""}" type="button" data-study-diff="${val}" aria-pressed="${isActive ? "true" : "false"}">${label}</button>`;
  }).join("");
  // 难度药丸右侧挂一颗「?」：点开说明四档分别在考什么（见 difficultyHelpMarkup）
  return `<span class="study-difficulty-wrap"><div class="study-difficulty" role="radiogroup" aria-label="难度选择">${pills}</div>${difficultyHelpMarkup()}</span>`;
}

// 难度档位说明：小图标 + 点开的浮层。
// 档位文案与后端 DIFFICULTY_LADDER（api_server.py）对齐；「自动」= 请求里不带 difficulty，
// 由 _next_card_difficulty / _next_quiz_difficulty 按考点库存「先把基础问完再往上走」。
function difficultyHelpMarkup() {
  const icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"></circle><path d="M12 11.4v4.8"></path><path d="M12 7.9h.01"></path></svg>`;
  const rows = [
    ["自动", "不指定难度：先把基础考点问完，再自动往中等、困难递进（默认）"],
    ["简单", "基础识记：定义、术语、直接结论、关键公式"],
    ["中等", "机制理解：条件、因果链、对比、推导、易混点"],
    ["困难", "迁移应用：综合辨析、情境应用、推理边界、考试式分析"],
  ]
    .map(([name, desc]) => `<li><span class="diff-help-tag">${name}</span><span>${desc}</span></li>`)
    .join("");
  return `<button class="diff-help" type="button" data-diff-help aria-label="难度档位说明" aria-expanded="false">${icon}</button><div class="diff-help-panel"><p class="diff-help-title">四档难度分别在考什么</p><ul class="diff-help-list">${rows}</ul><p class="diff-help-foot">知识卡片与小测验都按所选档位生成。</p></div>`;
}

// 展开 / 收起说明浮层：同一时刻只留一个；点面板外或按 Esc 关掉
function toggleDiffHelp(button) {
  const wrap = button.closest(".study-difficulty-wrap");
  if (!wrap) return;
  const willOpen = !wrap.classList.contains("is-open");
  closeDiffHelpPanels();
  if (!willOpen) return;
  wrap.classList.add("is-open");
  button.setAttribute("aria-expanded", "true");
  placeDiffHelpPanel(wrap);
}

// 面板默认从药丸上方弹出；被滚动容器裁掉时（药丸靠近容器顶部）翻到下方。
// #studio-output 是 overflow-y:auto，越界的部分会被直接裁掉、看不出任何报错。
function diffHelpClipParent(element) {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY !== "visible" && node.clientHeight) return node;
  }
  return null;
}

function placeDiffHelpPanel(wrap) {
  wrap.classList.remove("is-below");
  const panel = wrap.querySelector(".diff-help-panel");
  if (!panel) return;
  const clip = diffHelpClipParent(wrap);
  const clipTop = clip ? clip.getBoundingClientRect().top : 0;
  const roomAbove = wrap.getBoundingClientRect().top - clipTop;
  if (panel.getBoundingClientRect().height + 10 > roomAbove) wrap.classList.add("is-below");
}

function closeDiffHelpPanels() {
  $$(".study-difficulty-wrap.is-open").forEach((wrap) => {
    wrap.classList.remove("is-open");
    const button = wrap.querySelector("[data-diff-help]");
    if (button) button.setAttribute("aria-expanded", "false");
  });
}

function handleDiffHelpDocumentClick(event) {
  if (!event.target || typeof event.target.closest !== "function") return;
  if (event.target.closest("[data-diff-help], .diff-help-panel")) return;
  closeDiffHelpPanels();
}

function handleDiffHelpKeydown(event) {
  if (event.key === "Escape") closeDiffHelpPanels();
}

// 题型选择器：单选 / 多选 / 填空 / 简答 / 计算
function quizQuestionTypeSelector() {
  const types = [
    ["choice", "单选"],
    ["multiple_choice", "多选"],
    ["fill_blank", "填空"],
    ["short_answer", "简答"],
    ["calculation", "计算"],
  ];
  const checks = types.map(([val, label]) => {
    const checked = state.quizQuestionTypes.includes(val) ? " checked" : "";
    return `<label class="type-check"><input type="checkbox" data-quiz-type="${val}"${checked}> ${label}</label>`;
  }).join("");
  return `<div class="quiz-type-selector" role="group" aria-label="题型选择">${checks}</div>`;
}

function updateRegenerateButtons() {
  [
    ["regenerate-cards", state.generatingCards],
    ["regenerate-quiz", state.generatingQuiz],
  ].forEach(([action, generating]) => {
    const btn = document.querySelector(`button[data-study-action="${action}"]`);
    if (!btn) return;
    btn.disabled = !!generating;
    btn.classList.toggle("is-generating", !!generating);
    btn.innerHTML = generating
      ? `<span class="btn-spinner" aria-hidden="true"></span> 正在生成…`
      : `<span aria-hidden="true">＋</span> 再来一批`;
  });
}

function petViewStatus(feature) {
  const nodes = state.nodes || [];
  const avg = nodes.length ? Math.round(nodes.reduce((s, n) => s + Number(n.mastery_score || 0), 0) / nodes.length * 100) : 0;
  switch (feature) {
    case "framework":
      return "知识框架页：共 " + nodes.length + " 个节点，已掌握 " + nodes.filter((n) => frameworkStatusClass(n) === "s-mastered").length + " 个，平均掌握度约 " + avg + "%。";
    case "overview":
      return "学习概览页：目前平均掌握约 " + avg + "%（" + (nodes.length || 0) + " 个知识点），下方是掌握度分配和下一步学习队列。";
    case "cards":
      return "知识卡片页：已生成 " + (state.cards || []).length + " 张卡片，翻面自评会沉淀你的掌握度。";
    case "quiz":
      return "小测验页：已完成 " + (Array.isArray(state.quizHistory) ? state.quizHistory.length : 0) + " 次测验，提交会更新掌握度。";
    case "favorites":
      return "我的笔记页：已收集 " + (state.favorites || []).length + " 条标亮内容，可继续补充批注、修改归类。";
    default:
      return "已切到" + (feature || "这个页面") + "～有需要随时戳我。";
  }
}

function renderStudio() {
  if (state.feature === "framework") renderFramework();
  if (state.feature === "overview") renderOverview();
  if (state.feature === "cards") renderCards();
  if (state.feature === "quiz") renderQuiz();
  if (state.feature === "favorites") renderFavorites();
}

/* -------- Framework tree/status helpers (sidebar + node open fix) -------- */
function frameworkStatusClass(node) {
  if (["insufficient_source", "missing_prerequisite", "uncovered"].includes(node.coverage_status)) return "s-missing";
  if (node.learning_status === "mastered") return "s-mastered";
  if (["pending_confirmation", "learning", "encountered"].includes(node.learning_status)) return "s-learning";
  return "s-unknown";
}

function buildFrameworkTree() {
  const nodeIds = new Set(state.nodes.map((n) => n.node_id));
  const byId = new Map(state.nodes.map((n) => [n.node_id, n]));
  const parentById = new Map();
  state.nodes.forEach((n) => {
    if (n.parent_id && n.parent_id !== n.node_id && nodeIds.has(n.parent_id)) {
      parentById.set(n.node_id, n.parent_id);
    }
  });
  state.nodes.forEach((n) => {
    const seen = new Set([n.node_id]);
    let cursor = n.node_id;
    while (parentById.has(cursor)) {
      cursor = parentById.get(cursor);
      if (seen.has(cursor)) { parentById.delete(n.node_id); break; }
      seen.add(cursor);
    }
  });
  const children = new Map(state.nodes.map((n) => [n.node_id, []]));
  parentById.forEach((pid, nid) => children.get(pid)?.push(nid));
  children.forEach((ids) => ids.sort((a, b) => {
    const an = byId.get(a), bn = byId.get(b);
    return (an?.order ?? 0) - (bn?.order ?? 0) || String(an?.name ?? "").localeCompare(String(bn?.name ?? ""));
  }));
  const roots = state.nodes.filter((n) => !parentById.has(n.node_id)).map((n) => n.node_id);
  return { byId, children, roots };
}

function frameworkTreeMarkup(nodeId, tree, depth) {
  const node = tree.byId.get(nodeId);
  if (!node) return "";
  const childIds = tree.children.get(nodeId) || [];
  const hasChildren = childIds.length > 0;
  const expanded = depth < 2; // top 2 levels open by default
  const status = frameworkStatusClass(node);
  const score = Math.round(node.mastery_score * 100);
  const childrenHtml = hasChildren
    ? `<ul class="framework-tree-children ${expanded ? "" : "is-collapsed"}" data-parent="${escapeAttr(nodeId)}">${childIds.map((cid) => frameworkTreeMarkup(cid, tree, depth + 1)).join("")}</ul>`
    : "";
  return `
    <li class="framework-tree-node" data-node-id="${escapeAttr(nodeId)}">
      <div style="display:flex;align-items:center;">
        <button class="framework-tree-toggle ${expanded ? "is-expanded" : ""}" type="button" data-tree-action="toggle" data-node-id="${escapeAttr(nodeId)}" aria-label="${hasChildren ? (expanded ? "折叠" : "展开") : "叶子节点"}"${hasChildren ? "" : " disabled"}>▶</button>
        <button class="framework-tree-label" type="button" data-tree-action="open" data-node-id="${escapeAttr(nodeId)}" title="${escapeAttr(`${node.name} · ${statusLabel(node)} · 掌握度 ${score}%`)}">
          <span class="framework-tree-status ${status}"></span>
          <span class="framework-tree-text">${escapeHtml(node.name)}</span>
          <span class="framework-tree-score">${score}%</span>
        </button>
      </div>
      ${childrenHtml}
    </li>
  `;
}

function frameworkProgressMarkup() {
  const total = state.nodes.length;
  const counts = { mastered: 0, learning: 0, unknown: 0, missing: 0 };
  state.nodes.forEach((node) => {
    const s = frameworkStatusClass(node);
    counts[s === "s-mastered" ? "mastered" : s === "s-learning" ? "learning" : s === "s-missing" ? "missing" : "unknown"] += 1;
  });
  const pct = (c) => total ? Math.round((c / total) * 100) : 0;
  const masteredCount = counts.mastered;
  const avgScore = total ? Math.round((state.nodes.reduce((s, n) => s + n.mastery_score, 0) / total) * 100) : 0;
  // Priority: nodes with problems (missing coverage/low mastery), sorted by mastery asc
  const priorityItems = [...state.nodes]
    .filter((n) => ["insufficient_source", "missing_prerequisite", "uncovered"].includes(n.coverage_status) || n.mastery_score < 0.55)
    .sort((a, b) => a.mastery_score - b.mastery_score)
    .slice(0, 5);
  const priorityHtml = priorityItems.length
    ? priorityItems.map((n) => {
        const subtitle = ["insufficient_source", "missing_prerequisite", "uncovered"].includes(n.coverage_status)
          ? `${statusLabel(n)} · 优先补全材料`
          : `掌握度 ${Math.round(n.mastery_score * 100)}% · 建议复习`;
        return `<button class="framework-priority-item" type="button" data-tree-action="open" data-node-id="${escapeAttr(n.node_id)}"><strong>${escapeHtml(n.name)}</strong><small>${subtitle}</small></button>`;
      }).join("")
    : `<p style="margin:6px 2px;color:var(--muted);font-size:calc(10px * var(--font-scale, 1));">暂无优先复习项，框架状态良好。</p>`;
  return `
    <div class="framework-progress-summary">
      <span class="framework-stat-chip"><span>总节点</span><b>${total}</b></span>
      <span class="framework-stat-chip"><span>平均掌握</span><b>${avgScore}%</b></span>
      <span class="framework-stat-chip"><span>已掌握</span><b>${masteredCount}</b></span>
    </div>
    <div class="framework-progress-block">
      <h5>掌握度分布</h5>
      <div class="framework-mastery-bars">
        <div class="framework-mastery-bar-row"><span>已掌握</span><div class="framework-mastery-bar-track"><div class="framework-mastery-bar-fill s-mastered" style="width:${pct(counts.mastered)}%"></div></div><span>${counts.mastered}</span></div>
        <div class="framework-mastery-bar-row"><span>学习中</span><div class="framework-mastery-bar-track"><div class="framework-mastery-bar-fill s-learning" style="width:${pct(counts.learning)}%"></div></div><span>${counts.learning}</span></div>
        <div class="framework-mastery-bar-row"><span>未探索</span><div class="framework-mastery-bar-track"><div class="framework-mastery-bar-fill s-unknown" style="width:${pct(counts.unknown)}%"></div></div><span>${counts.unknown}</span></div>
        <div class="framework-mastery-bar-row"><span>待补全</span><div class="framework-mastery-bar-track"><div class="framework-mastery-bar-fill s-missing" style="width:${pct(counts.missing)}%"></div></div><span>${counts.missing}</span></div>
      </div>
    </div>
    <div class="framework-progress-block">
      <h5>优先复习</h5>
      <div class="framework-priority-list">${priorityHtml}</div>
    </div>
  `;
}

/* renderFramework 会把整个 output.innerHTML 换掉，护照容器与目录栏随之被替换。
   这里按组件内部保存的状态补一次渲染与落宽，不重新请求 ——
   视图切换不该多打一次接口，用户拖好的宽度也不该被重置。 */
function kbPassportRestore() {
  if (!window.KBPassport) return;
  if (typeof window.KBPassport.refreshSides === "function") window.KBPassport.refreshSides();
  if (typeof window.KBPassport.reopen === "function") window.KBPassport.reopen();
}

/* ==================== 图谱节点单击 → 语义护照 ====================
   挂在常驻的 #studio-output 委托里（见 handleStudioOutputClick），不逐个节点挂监听。
   逐个挂的写法排在整个渲染链的末尾：dialog / 侧栏 / dock / 护照恢复里任何一处抛错，
   图谱照常画出来、节点却整片变成点不动的死区 —— 症状就是「点节点没反应、护照卡片
   不出现」，而且屏幕上没有任何错。委托只注册一次，渲染链出问题也点得动。

   拖动 / 点击判定：按下点 → 点击点的屏幕距离 > 5px 算平移画布，不弹护照。
   不用 svg._justPanned 那个布尔标记 —— 它会被上一轮拖动的残留值污染，键盘触发的
   click（Enter / 空格）又收不到 pointerdown，那种 click 会被永久吞掉。 */
const KB_GRAPH_PAN_GUARD = { armed: false, x: 0, y: 0 };

function kbGraphArmPanGuard(event) {
  const inGraph = event.button === 0
    && !!(event.target && event.target.closest && event.target.closest(".knowledge-graph"));
  KB_GRAPH_PAN_GUARD.armed = inGraph;
  if (inGraph) {
    KB_GRAPH_PAN_GUARD.x = event.clientX;
    KB_GRAPH_PAN_GUARD.y = event.clientY;
  }
}

function kbOpenPassportForNode(node) {
  if (!node || !window.KBPassport || typeof window.KBPassport.open !== "function") return false;
  const current = typeof window.KBPassport.current === "function" ? window.KBPassport.current() : null;
  // 已经为这个节点开着就别再打一次接口（委托与键盘路径可能同时命中）
  if (current && current.nodeId === node.dataset.nodeId && window.KBPassport.isOpen()) return true;
  window.KBPassport.open(node.dataset.nodeId);
  return true;
}

/** 返回 true 表示这个 click 已经被图谱节点消费掉，别的分支不用再看。 */
function kbGraphNodeClickOpensPassport(event) {
  const node = event.target && event.target.closest
    ? event.target.closest(".graph-node[data-node-id]")
    : null;
  if (!node || !node.closest(".knowledge-graph")) return false;
  // 节点上的点击不外传：以前挂在节点上的监听就这么做的，保持别的「点外面关东西」
  // 逻辑（关闭项目菜单 / 背板收起全屏）不会被点节点误触发。
  event.stopPropagation();
  // detail === 0 = 键盘 / 脚本触发的 click，没有按下这一步，直接算点击
  if (event.detail > 0 && KB_GRAPH_PAN_GUARD.armed
    && Math.hypot(event.clientX - KB_GRAPH_PAN_GUARD.x, event.clientY - KB_GRAPH_PAN_GUARD.y) > 5) {
    KB_GRAPH_PAN_GUARD.armed = false;
    return true;
  }
  kbOpenPassportForNode(node);
  return true;
}

/** 节点聚焦后 Enter / 空格 = 打开护照。节点带 tabindex，键盘用户只有这条路。 */
function handleStudioOutputKeydown(event) {
  if (!["Enter", " "].includes(event.key)) return;
  const node = event.target && event.target.closest
    ? event.target.closest(".graph-node[data-node-id]")
    : null;
  if (!node || !node.closest(".knowledge-graph")) return;
  event.preventDefault();
  kbOpenPassportForNode(node);
}

function bindFrameworkSidebars(output, svg, layout) {
  // 目录栏收起：宽度与收起态由 kb-passport-ui.js 统一管理（它也管护照那一侧）
  const collapseBtn = output.querySelector("[data-kb-collapse-left]");
  if (collapseBtn) {
    collapseBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (window.KBPassport && typeof window.KBPassport.setLeftCollapsed === "function") {
        window.KBPassport.setLeftCollapsed(true);
      }
    });
  }
  // Tree: expand/collapse toggles and open-node clicks
  output.querySelectorAll(".framework-tree-toggle").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const nodeId = btn.dataset.nodeId;
      const children = output.querySelector(`.framework-tree-children[data-parent="${CSS.escape(nodeId)}"]`);
      if (!children) return;
      const collapsed = children.classList.toggle("is-collapsed");
      btn.classList.toggle("is-expanded", !collapsed);
    });
  });
  const openFromSidebar = (nodeId) => {
    // Highlight active tree item
    output.querySelectorAll(".framework-tree-label").forEach((el) => el.classList.toggle("is-active", el.dataset.nodeId === nodeId));
    // Pan graph to the node if possible
    if (svg && svg._panToNodeId) svg._panToNodeId(nodeId);
    // Also highlight the graph node
    output.querySelectorAll(".graph-node").forEach((el) => {
      const selected = el.dataset.nodeId === nodeId;
      el.classList.toggle("graph-node-selected", selected);
      if (selected) el.setAttribute("aria-pressed", "true");
      else el.removeAttribute("aria-pressed");
    });
    // 打开掌握度分析 dialog
    openNodeMasteryAnalysisDialog(nodeId);
  };
  output.querySelectorAll("[data-tree-action='open']").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      openFromSidebar(btn.dataset.nodeId);
    });
  });
  // 学习进度（框架概览）折叠面板
  const progressHead = output.querySelector("[data-framework-progress-toggle]");
  const progressBody = output.querySelector("#framework-progress-body");
  if (progressHead && progressBody) {
    progressHead.addEventListener("click", () => {
      const isExpanded = progressHead.getAttribute("aria-expanded") === "true";
      progressHead.setAttribute("aria-expanded", String(!isExpanded));
      progressHead.classList.toggle("is-open", !isExpanded);
      progressBody.hidden = isExpanded;
    });
  }
}

function renderFramework() {
  hideTextHighlightToolbar();
  if (!state.nodes.length) {
    const output = $("#studio-output");
    // 有活跃筛选（搜索词/标签）但无匹配节点：与「知识库为空」区分，避免误显示「还没有知识框架」
    if (state.kbQuery || state.kbActiveTag) {
      output.innerHTML = `<div class="output-empty"><span class="compass">⌘</span><h3>没有匹配的节点</h3><p>当前搜索 / 筛选没有命中任何节点，请清除筛选查看全部。</p><button class="mini-button" data-framework-action="clear-filter" type="button">清除筛选</button></div><dialog id="node-detail-dialog" class="node-detail-dialog" aria-labelledby="node-detail-title"><div id="node-detail"></div></dialog>`;
      const clearBtn = output.querySelector("[data-framework-action='clear-filter']");
      if (clearBtn) clearBtn.addEventListener("click", () => { state.kbQuery = ""; state.kbActiveTag = ""; kbRenderFiltered(); });
      bindNodeDetailDialog(output.querySelector("#node-detail-dialog"));
      return;
    }
    output.innerHTML = `<div class="output-empty"><span class="compass">⌘</span><h3>还没有知识框架</h3><p>可以从来源生成，也可以手动创建。</p><button class="mini-button" data-framework-action="add-root" type="button">＋ 新增节点</button></div><dialog id="node-detail-dialog" class="node-detail-dialog" aria-labelledby="node-detail-title"><div id="node-detail"></div></dialog>`;
    output.querySelector("[data-framework-action='add-root']").addEventListener("click", () => renderNodeEditor());
    bindNodeDetailDialog(output.querySelector("#node-detail-dialog"));
    return;
  }
  const output = $("#studio-output");
  // 布局：保持 buildFrameworkLayout 的默认列限高（1500px）让树自己决定换列；
  // 旧版重布局（tunedCap）会让少节点框架被强行压成竖条，这里直接删。
  // 折叠状态来自 KbTreeFlow 的角标；没加载那个脚本时是 null，布局行为与原来完全一致
  let layout = buildFrameworkLayout(state.nodes, 1500, window.KbTreeFlow ? window.KbTreeFlow.collapsed() : null);
  const edges = [...layout.children.entries()].flatMap(([parentId, childIds]) => {
    const from = layout.positions.get(parentId);
    if (!from) return [];
    return childIds.map((childId) => {
      const child = layout.positions.get(childId);
      if (!child) return "";
      const parentCenterX = from.x + layout.nodeWidth / 2;
      const startY = from.y + layout.nodeHeight / 2;
      const childCenterX = child.x + layout.nodeWidth / 2;
      const endY = child.y + layout.nodeHeight / 2;
      const childSide = layout.sides.get(childId) || "right";
      const startsRight = childSide !== "left";
      const startX = startsRight ? from.x + layout.nodeWidth : from.x;
      const endX = startsRight ? child.x : child.x + layout.nodeWidth;
      const curve = Math.max(48, Math.abs(childCenterX - parentCenterX) * 0.46);
      const controlA = startsRight ? startX + curve : startX - curve;
      const controlB = startsRight ? endX - curve : endX + curve;
      const nodeIds = [parentId, childId].map(escapeAttr).join(" ");
      return `<path class="graph-edge" data-edge-nodes="${nodeIds}" d="M ${startX} ${startY} C ${controlA} ${startY}, ${controlB} ${endY}, ${endX} ${endY}"/>`;
    });
  }).join("");
  // 双链已移至独立「双链图谱」视图（Obsidian 式流动网络），不再绘入 XMind 脑图
  const nodes = state.nodes.map((node) => {
    const pos = layout.positions.get(node.node_id);
    // 被折叠收起的节点：布局已经把它们排除在外，positions 里没有坐标。
    // 这里必须跳过 —— 否则 pos.x 直接抛错，整次重排崩掉，表现就是"点了角标没反应"。
    if (!pos) return "";
    const palette = nodePalette(node);
    const side = layout.sides.get(node.node_id) || "root";
    const titleAlign = side === "left" ? "end" : "start";
    const textX = side === "left" ? layout.nodeWidth - 24 : 24;
    const accentX = side === "left" ? layout.nodeWidth - 14 : 10;
    const litClass = { lit: "node-lit", partial: "node-learning", dim: "node-dim", blocked: "node-blocked" }[palette.lit] || "node-dim";
    return `<g class="graph-node graph-node-${escapeAttr(side)} ${litClass}" data-mastery="${Math.round((Number(node.mastery_score) || 0) * 100)}" data-node-id="${escapeAttr(node.node_id)}" transform="translate(${pos.x} ${pos.y})" tabindex="0" role="button" aria-label="${escapeAttr(`${node.name}，${statusLabel(node)}，掌握度 ${Math.round(node.mastery_score * 100)}%`)}"><title>${escapeHtml(node.name)}</title><rect class="graph-node-card" width="${layout.nodeWidth}" height="${layout.nodeHeight}" rx="10" fill="${palette.fill}" stroke="${palette.stroke}"/><rect class="graph-node-accent" width="4" height="30" x="${accentX}" y="15" rx="2" fill="${palette.stroke}"/>${graphNodeTitleMarkup(node.name, textX, titleAlign)}<text class="graph-node-meta" x="${textX}" y="54" text-anchor="${titleAlign}">${escapeHtml(statusLabel(node))} · 掌握度 ${Math.round(node.mastery_score * 100)}%</text></g>`;
  }).join("");
  const kbDockHtml = `
    <div class="kb-dock" data-kb-dock hidden>
      <div class="kb-dock-head">
        <button class="kb-back" type="button" data-kb-action="back">← 返回知识图谱</button>
        <div class="kb-tabs" role="tablist" aria-label="知识库工具">
          <button class="kb-tab" type="button" data-kb-tab="agent" role="tab" aria-selected="false">整理助手</button>
          <button class="kb-tab is-active" type="button" data-kb-tab="note" role="tab" aria-selected="true">笔记</button>
        </div>
        <div class="kb-head-agent" data-kb-head-agent>
          <span class="kb-memory-badge" data-kb-digest-badge title="知识库现状（自动记忆）">记忆…</span>
          <span class="kb-guide-chip" data-kb-guide-chip hidden></span>
          <select data-kb-session-select aria-label="历史会话">
            <option value="">新建会话</option>
          </select>
          <span class="kb-head-sep" aria-hidden="true"></span>
          <button class="head-button" type="button" data-kb-new-session title="清空并开始新会话">↻ 新会话</button>
          <button class="head-button" type="button" data-kb-toggle-proposals>建议稿<span class="kb-prop-count" data-kb-prop-count>0</span></button>
        </div>
        <button class="kb-close" type="button" data-kb-action="close" aria-label="关闭面板">✕</button>
      </div>
      <div class="kb-pane kb-pane-note" data-kb-pane="note"></div>
      <div class="kb-pane kb-pane-agent" data-kb-pane="agent" hidden></div>
    </div>`;

  // --- Build sidebar content (tree + stats) ---
  const tree = buildFrameworkTree();
  const treeHtml = tree.roots.length
    ? `<ul class="framework-tree-root">${tree.roots.map((rid) => frameworkTreeMarkup(rid, tree, 0)).join("")}</ul>`
    : `<p style="padding:10px;color:var(--muted);font-size:calc(11px * var(--font-scale, 1));">暂无目录结构。</p>`;
  const progressHtml = frameworkProgressMarkup();
  const kbView = kbCurrentView();
  const isAcademicUi = usesCoolPalette();
  const graphGridDot = isAcademicUi ? "#cbd6e8" : (document.documentElement.getAttribute("data-brand") === "tju" ? "#b9cde0" : "#d8d2c7");
  // 图例色阶与掌握度四档（.mastery-stack-segment / .progress-track）必须一致，
  // 否则同一屏里「已掌握」在图例里是深蓝、在进度条里是另一档蓝，读起来像两套数据。
  // 「来源不足」是唯一保留暖色的：它标的是数据缺陷而非掌握度，得跟蓝灰区分开。
  const legendColors = isAcademicUi
    ? { untouched: "#ccd4e0", learning: "#8b9fc2", mastered: "#6a83bb", deficient: "#c08a6a" }
    : { untouched: "#d8d3ca", learning: "#d4a843", mastered: "#6b9e5c", deficient: "#c75c5c" };

  output.innerHTML = `
    <div class="framework-shell">
      <aside class="framework-sidebar framework-sidebar-left" aria-label="知识框架目录">
        <button type="button" class="kb-side-rail" data-kb-expand="left" aria-label="展开框架目录" title="展开框架目录">
          <span class="kb-side-rail-glyph expand" aria-hidden="true"></span><span class="kb-side-rail-label">框架目录</span>
        </button>
        <div class="framework-sidebar-header">
          <h4>框架目录</h4>
          <span class="sidebar-count">${state.nodes.length} 项</span>
          <button type="button" class="framework-sidebar-collapse" data-kb-collapse-left aria-label="收起框架目录" title="收起目录（点竖条可展开）">‹</button>
        </div>
        <nav class="framework-tree" aria-label="知识框架树形目录">${treeHtml}</nav>
        <section class="framework-progress" aria-label="学习进度">
          <button class="framework-progress-head" type="button" aria-expanded="false" aria-controls="framework-progress-body" data-framework-progress-toggle>
            <span>学习进度</span>
            <i class="framework-progress-chev" aria-hidden="true"></i>
          </button>
          <div class="framework-progress-body" id="framework-progress-body" hidden>${progressHtml}</div>
        </section>
      </aside>
      <section class="framework-view" data-kb-view-mode="${kbView}">
        <button type="button" class="kb-grip kb-grip-left" data-kb-grip="left" aria-label="拖动调整目录栏宽度" title="拖动调整宽度"></button>
        <div class="graph-toolbar">
          <span class="kb-view-switch" role="group" aria-label="图谱视图">
            <button class="kb-view-btn${kbView === "tree" ? " is-active" : ""}" type="button" data-kb-view="tree">XMind图谱</button>
            <button class="kb-view-btn${kbView === "graph" ? " is-active" : ""}" type="button" data-kb-view="graph">双链图谱</button>
          </span>
          <div class="graph-export" role="group" aria-label="导出图谱">
            <button class="graph-export-btn" type="button" data-graph-export-toggle aria-haspopup="true" aria-expanded="false">导出图谱</button>
            <div class="graph-export-menu" hidden>
              <button class="graph-export-item" type="button" data-graph-export="svg">SVG 矢量图</button>
              <button class="graph-export-item" type="button" data-graph-export="png">PNG 高清图片</button>
              <button class="graph-export-item" type="button" data-graph-export="json">JSON 节点数据</button>
              <button class="graph-export-item" type="button" data-graph-export="xmind">XMind 文件</button>
            </div>
          </div>
        </div>
        <div class="graph-wrap" tabindex="0">
          <svg class="knowledge-graph" viewBox="0 0 ${layout.viewportWidth} ${layout.viewportHeight}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="当前项目 XMind 式知识框架，可使用鼠标滚轮缩放">
            <defs>
              <pattern id="knowledge-grid" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r="1.2" fill="${graphGridDot}"/></pattern>
              <filter id="node-shadow" x="-20%" y="-30%" width="140%" height="170%"><feDropShadow dx="0" dy="5" stdDeviation="5" flood-color="#493e2f" flood-opacity=".12"/></filter>
            </defs>
            <rect class="graph-background" width="100%" height="100%" fill="url(#knowledge-grid)"/>
            <g class="graph-viewport">
              <g class="graph-links"></g>
              <g class="graph-edges">${edges}</g>
              <g class="graph-nodes">${nodes}</g>
            </g>
          </svg>
          <svg class="kb-flow-graph" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${KB_FLOW_W} ${KB_FLOW_H}" aria-label="Obsidian 式双链流动图谱，可通过鼠标滚轮缩放" role="img"></svg>
          <span class="graph-pan-hint" aria-hidden="true">拖动浏览左右分支</span>
        </div>
        <div class="legend">
          <span><i style="background:${legendColors.untouched}"></i>未探索</span>
          <span><i style="background:${legendColors.learning}"></i>待确认/学习中</span>
          <span><i style="background:${legendColors.mastered}"></i>已掌握</span>
          <span><i style="background:${legendColors.deficient}"></i>来源不足</span>
        </div>
        <div class="kb-mechanism" data-kb-mechanism hidden></div>
      </section>
      <aside class="kb-passport-host" aria-label="语义护照" hidden></aside>
    </div>
    ${kbDockHtml}
    <dialog id="node-detail-dialog" class="node-detail-dialog" aria-labelledby="node-detail-title"><div id="node-detail"></div></dialog>`;

  const svg = output.querySelector(".knowledge-graph");
  const detailDialog = output.querySelector("#node-detail-dialog");
  bindNodeDetailDialog(detailDialog);
  bindFrameworkSidebars(output, svg, layout);
  kbBindNav(output);
  kbBindDock(output);
  /* renderFramework 会把整个 output.innerHTML 换掉，护照容器与目录栏随之被替换。
     这里按组件内部保存的状态补一次渲染与落宽，不重新请求 ——
     视图切换不该多打一次接口，用户拖好的宽度也不该被重置。
     恢复的是「上一次的阅读状态」，不是本屏必须有的东西：它内部要重渲染护照正文，
     内容形状出问题就可能抛错，而下面还有视图切换 / 导出 / 节点交互要绑。
     一道 try 拦住，坏的最多是护照自己，不是整页图谱。 */
  try {
    kbPassportRestore();
  } catch (error) {
    console.error("[语义护照] 恢复上次状态失败，图谱其余交互继续绑定", error);
  }
  // 图谱视图切换（脑图 / 双链图谱）——放在渲染分支之前，确保无论渲染是否出错都能切回脑图。
  // 「来源视图」已整体搬到文章阅读界面的「对比视图」，不再与这两者并列。
  output.querySelectorAll("[data-kb-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const picked = btn.dataset.kbView;
      const next = picked === "graph" ? "graph" : "tree";
      if (next === kbCurrentView()) return;
      kbSetView(next);
      renderFramework();
    });
  });
  // 图谱导出：下拉菜单 + 三种格式（SVG / PNG / JSON）
  const exportToggle = output.querySelector("[data-graph-export-toggle]");
  if (exportToggle) exportToggle.addEventListener("click", graphExportMenuToggle);
  output.querySelectorAll("[data-graph-export]").forEach((btn) => {
    btn.addEventListener("click", graphExportItemClick);
  });
  if (kbView === "tree") {
    bindFrameworkViewport(svg, layout);
    // 流动增强：掌握度向上传导 + 层级蔓延入场 + 折叠角标（独立文件 static/kb-tree-flow.js）
    try {
      window.KbTreeFlow?.attach(svg, layout);
    } catch (error) {
      console.error("[知识框架流动层] 挂载失败，图谱其余交互不受影响", error);
    }
    const addRootBtn = output.querySelector("[data-framework-action='add-root']");
    if (addRootBtn) addRootBtn.addEventListener("click", () => renderNodeEditor());
    output.querySelectorAll(".graph-node").forEach((element) => {
      const openMastery = (event) => {
        event?.stopPropagation();
        // Use a boolean flag set by finishPan in the SAME task before the click task runs.
        // The class-based check (graph-was-dragged) was racy because setTimeout(0) fired AFTER the click handler.
        if (svg._justPanned === true) {
          svg._justPanned = false;
          return;
        }
        openNodeMasteryAnalysisDialog(element.dataset.nodeId);
      };
      // 单击节点 → 滑出语义护照（只读详解，图同时可见，能对照着看）
      // 双击仍然打开掌握度分析；动手的地方（笔记/卡片/测验）走护照底部按钮。
      // ⚠️ 单击与 Enter/空格**不在这里挂**：这段代码排在整个渲染链的末尾（dialog /
      //    侧栏 / dock / 护照恢复 之后），上面任何一处抛错，图谱照样画出来、节点却
      //    整片变死区 —— 表现就是「点节点没反应、护照卡片不出现」，屏幕上还没有任何
      //    报错。两者都交给常驻的 #studio-output 委托（handleStudioOutputClick /
      //    handleStudioOutputKeydown）：渲染链出问题也点得动、敲得开。
      element.addEventListener("dblclick", openMastery);
      element.addEventListener("pointerenter", () => highlightFrameworkBranch(svg, element.dataset.nodeId, true));
      element.addEventListener("pointerleave", () => highlightFrameworkBranch(svg, element.dataset.nodeId, false));
    });
  } else {
    try {
      kbFlowInit(output.querySelector(".kb-flow-graph"), output);
    } catch (error) {
      // 图谱异常时不让renderFramework崩溃：保留切换按钮与界面，方便回到脑图排查
      console.error("[双链图谱] 渲染失败", error);
      kbFlowRenderError(output.querySelector(".kb-flow-graph"), error);
    }
  }
  // 双击提示双击可开掌握度分析；返回原「点击节点编辑」能力经笔记面板「✎ 编辑」入口可达
}

/* ==================== 图谱导出（SVG / PNG / JSON） ==================== */

function graphExportSvg() {
  const view = kbCurrentView();
  return document.querySelector(
    view === "tree" ? "#studio-output .knowledge-graph" : "#studio-output .kb-flow-graph"
  );
}

function graphExportFileName(ext, label) {
  const project = currentProject();
  const base = project ? project.subject : "知识图谱";
  const safe = String(base).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40);
  const stamp = new Date().toISOString().slice(0, 10);
  const suffix = label ? `_${label}` : "";
  return `${safe}${suffix}_${stamp}.${ext}`;
}

function graphExportViewBox(svg) {
  const raw = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  if (raw.length === 4 && raw.every((n) => Number.isFinite(n))) {
    return { w: raw[2], h: raw[3] };
  }
  const rect = svg.getBoundingClientRect();
  return { w: rect.width || 1500, h: rect.height || 1050 };
}

function triggerFileDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// 把 SVG 里依赖站点 CSS 的 class 样式内联成 style 属性，导出的独立文件不再依赖 styles.css。
// 长度类属性（font-size / stroke-width 等）的 getComputedStyle 值是屏幕像素，需按
// viewBox 缩放比换回用户单位，否则独立 SVG 里会被再缩放一次、字号线宽整体缩小。
const GRAPH_EXPORT_LENGTH_PROPS = new Set(["font-size", "stroke-width", "letter-spacing", "word-spacing"]);
const GRAPH_EXPORT_PROPS = [
  "fill", "stroke", "stroke-opacity", "fill-opacity", "opacity",
  "font-family", "font-size", "font-weight", "font-style", "text-anchor",
  "dominant-baseline", "letter-spacing", "color", "stop-color", "stop-opacity",
  "display", "visibility", "stroke-linecap", "stroke-linejoin",
  "stroke-dasharray", "stroke-dashoffset",
];

function prepareGraphSvgForExport(svg) {
  const clone = svg.cloneNode(true);
  clone.removeAttribute("id");
  if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const vb = graphExportViewBox(svg);
  const rect = svg.getBoundingClientRect();
  const scale = vb.w && rect.width ? rect.width / vb.w : 1;

  // ⚠️ computed style 必须在「文档内」的原元素上取：getComputedStyle 对离屏副本一律返回
  // 空样式（v 为空串），上次在内联副本上取值导致全部 CSS 丢失、深底黑团。取到后写到副本
  // 对应节点上——cloneNode(true) 保证两棵树一一对应，按序同步遍历。
  const walk = (src, dst) => {
    const cs = getComputedStyle(src);
    const parts = [];
    for (const p of GRAPH_EXPORT_PROPS) {
      let v = cs.getPropertyValue(p);
      if (!v || v === "normal" || v === "auto") continue;
      // none 有语义（fill:none / stroke:none / display:none / stroke-dasharray:none），必须内联
      if (GRAPH_EXPORT_LENGTH_PROPS.has(p) && v.trim().endsWith("px")) {
        const num = parseFloat(v);
        if (Number.isFinite(num) && scale > 0) v = `${(num / scale).toFixed(2)}px`;
      }
      parts.push(`${p}:${v}`);
    }
    if (parts.length) dst.setAttribute("style", parts.join(";") + ";");
    const sc = src.children;
    const dc = dst.children;
    for (let i = 0; i < sc.length && i < dc.length; i++) walk(sc[i], dc[i]);
  };
  walk(svg, clone);
  return clone;
}

function graphExportDownload(format) {
  if (format === "json") { graphExportJson(); return; }
  if (format === "xmind") { graphExportXmind(); return; }
  const svg = graphExportSvg();
  if (!svg) { showToast("当前没有可导出的图谱", "error"); return; }

  // 导出一律用浅色主题：报告/论文底是白的，深色底图贴进去既不清楚也费墨。
  // 临时切主题 → 同步重渲染图谱 → 捕获序列化 → 立刻切回；同步块内浏览器不重绘，不闪屏。
  const root = document.documentElement;
  const wasDark = root.getAttribute("data-theme") === "dark";
  let clone;
  try {
    if (wasDark) {
      root.setAttribute("data-theme", "light");
      renderFramework();
    }
    const rendered = graphExportSvg() || svg;
    clone = prepareGraphSvgForExport(rendered);
  } finally {
    if (wasDark) {
      root.setAttribute("data-theme", "dark");
      renderFramework();
    }
  }

  const svgStr = new XMLSerializer().serializeToString(clone);
  const label = kbCurrentView() === "tree" ? "脑图" : "双链图";
  if (format === "svg") {
    triggerFileDownload(new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" }), graphExportFileName("svg", label));
    showToast("已导出 SVG 矢量图（浅色底）", "success");
    return;
  }
  // PNG：光栅化到 canvas，2 倍像素提高清晰度，中文字体沿用页面已加载字体。
  const vb = graphExportViewBox(clone);
  const px = 2;
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(vb.w * px));
    canvas.height = Math.max(1, Math.round(vb.h * px));
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) { showToast("PNG 导出失败", "error"); return; }
      triggerFileDownload(blob, graphExportFileName("png", label));
      showToast("已导出 PNG 高清图片（浅色底）", "success");
    }, "image/png");
  };
  img.onerror = () => showToast("PNG 导出失败：图片渲染出错", "error");
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgStr);
}

async function graphExportJson() {
  const projectId = state.currentProjectId;
  if (!projectId) { showToast("请先选择一个项目", "error"); return; }
  try {
    const data = await api(`/api/projects/${encodeURIComponent(projectId)}/graph/export`);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
    triggerFileDownload(blob, graphExportFileName("json", "图谱"));
    const s = data.stats || {};
    const edgeTotal = (s.tree_edges || 0) + (s.prerequisite_edges || 0) + (s.link_edges || 0);
    showToast(`已导出 JSON：${s.nodes || 0} 个节点 · ${edgeTotal} 条边`, "success");
  } catch (error) {
    showToast(`JSON 导出失败：${error.message || error}`, "error");
  }
}

async function graphExportXmind() {
  const projectId = state.currentProjectId;
  if (!projectId) { showToast("请先选择一个项目", "error"); return; }
  try {
    // 要二进制，所以用裸 fetch（api() 会把响应当 JSON 处理）
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/graph/export/xmind`, { credentials: "same-origin" });
    if (!response.ok) {
      if (response.status === 401) { showAuthView(); throw new Error("登录状态已过期，请重新登录后再导出。"); }
      let message = `XMind 导出失败（HTTP ${response.status}）`;
      try {
        const body = await response.json();
        message = (body.detail && body.detail.message) || message;
      } catch { /* 非 JSON 响应，用默认文案 */ }
      throw new Error(message);
    }
    const blob = await response.blob();
    let name = graphExportFileName("xmind", "图谱");
    const cd = response.headers.get("Content-Disposition") || "";
    const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    if (m) { try { name = decodeURIComponent(m[1]); } catch { /* 用兜底名 */ } }
    triggerFileDownload(blob, name);
    showToast("已导出 XMind 文件，用 XMind 打开后可继续编辑", "success");
  } catch (error) {
    showToast(`XMind 导出失败：${error.message || error}`, "error");
  }
}

function graphExportMenuToggle(event) {
  const root = event.target.closest(".graph-export");
  if (!root) return;
  const menu = root.querySelector(".graph-export-menu");
  const btn = root.querySelector("[data-graph-export-toggle]");
  if (!menu) return;
  const willOpen = menu.hidden;
  document.querySelectorAll(".graph-export-menu").forEach((m) => { m.hidden = true; });
  document.querySelectorAll("[data-graph-export-toggle]").forEach((b) => b.setAttribute("aria-expanded", "false"));
  if (willOpen) { menu.hidden = false; btn.setAttribute("aria-expanded", "true"); }
}

function graphExportItemClick(event) {
  const item = event.target.closest("[data-graph-export]");
  if (!item) return;
  document.querySelectorAll(".graph-export-menu").forEach((m) => { m.hidden = true; });
  document.querySelectorAll("[data-graph-export-toggle]").forEach((b) => b.setAttribute("aria-expanded", "false"));
  graphExportDownload(item.dataset.graphExport);
}

// 点击导出菜单之外时收起（全局只绑一次，renderFramework 重建不重复注册）
document.addEventListener("click", (event) => {
  if (event.target && typeof event.target.closest === "function" && !event.target.closest(".graph-export")) {
    document.querySelectorAll(".graph-export-menu").forEach((m) => { m.hidden = true; });
    document.querySelectorAll("[data-graph-export-toggle]").forEach((b) => b.setAttribute("aria-expanded", "false"));
  }
});

/* ==================== 双链图谱（Obsidian 式流动网络视图） ==================== */

const KB_FLOW_VIEW_KEY = "kb-flow-view";
const KB_FLOW_W = 1500;
const KB_FLOW_H = 1050;

// —— 自生长：图谱规模（节点数 + 双链数）越大，"大圆"越大 ——
// 由 kbFlowSettle 按当前规模算出，供画布尺寸 / 环半径 / 碰撞间距 / 初始适配读取。
// 目的：节点变多、双链变密时整簇自动长大，间距不被压缩，节点不互相遮挡、连线不缠绕。
let KB_FLOW_GROW = 1;   // 布局放大系数：环半径、节点最小间距都按它放大
let KB_FLOW_GAP = 14;   // 碰撞最小间距（SVG 单位）：随规模一起放大
let KB_FLOW_RO = 0;     // 大圆半径（最外层叶子所在环）：整图适配 / 边界判断基准
let KB_FLOW_NN = 0;     // 松弛后"典型最近邻距离"（15% 分位）：可读性缩放下限的基准
// 由 kbFlowInit 注入：把某对双链的理解就地同步到当前浮层（不再贴在图谱连线上，只刷新右侧浮层文案）
let kbFlowNoteSync = null;

// 可选视图只剩两种：XMind 脑图（tree）与双链图谱（graph）。
// 「来源视图」已搬到文章阅读界面的对比视图里；老会话里残留的 "source" 一律回落脑图，
// 否则会出现「切回来什么都不亮」的僵局。
function kbCurrentView() {
  let v = "tree";
  try {
    const s = sessionStorage.getItem(KB_FLOW_VIEW_KEY);
    if (s === "tree" || s === "graph") v = s;
  } catch (_) {}
  return v;
}

function kbSetView(view) {
  const nextView = view === "graph" ? "graph" : "tree";
  try { sessionStorage.setItem(KB_FLOW_VIEW_KEY, nextView); } catch (_) {}
}

// 整理助手建链/新建节点落库后，后台同步最新知识框架到 state.nodes 并重绘双链图谱，
// 使刚建立的双链/新节点在切到图谱时立即可见（否则渲染用的是写库前的旧快照）。
// 只更新图谱数据、不动对话区，避免打断整理助手会话。
async function kbSyncNodeCache() {
  if (!state.currentProjectId) return;
  try {
    const data = await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}`);
    if (!data || !Array.isArray(data.nodes)) return;
    const hadFocus = state.kbFocusNodeId && (state.nodes || []).some((n) => n.node_id === state.kbFocusNodeId);
    state.nodes = data.nodes;
    // 双链理解随项目详情一起取回，这里一并刷新，避免整理助手建链后图谱用的是旧理解
    if (Array.isArray(data.link_notes)) {
      state.kbLinkNotes = kbLinkNotesFromPayload(data.link_notes);
    }
    // 聚焦节点若已被删除则清除，避免后续整理助手/引导对不存在的节点进行操作
    if (hadFocus && !state.nodes.some((n) => n.node_id === state.kbFocusNodeId)) {
      state.kbFocusNodeId = null;
      state.kbNodeId = null;
    }
    // 当前正显示双链图谱 → 用新数据重绘，让刚建的双链/新增节点即时呈现
    if (kbCurrentView() === "graph") {
      const graph = document.querySelector(".kb-flow-graph");
      if (graph) {
        try { kbFlowInit(graph, document.querySelector("#studio-output")); }
        catch (error) { kbFlowRenderError(graph, error); }
      }
    }
  } catch (_) { /* 静默：后台同步失败不阻断 agent 主流程 */ }
}

// 从整理助手切换到双链图谱视图：关闭 dock、切到 graph 并重绘，随后将图谱滚入视野
function kbOpenGraphView() {
  const dock = kbGetDock();
  if (dock) dock.hidden = true; // 不重置 kbNodeId，保持图谱聚焦状态与视图切换按钮行为一致
  kbSetView("graph");
  renderFramework();
  // 图谱与消息 DOM 由 renderFramework 全量重建；用双重 rAF 确保首帧后定位生效，
  // 并兜底补绘一次，避免 force 首次绘制滞后导致的空白
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const graph = document.querySelector(".kb-flow-graph");
      if (graph && !graph.querySelector(".kb-flow-node")) {
        try { kbFlowInit(graph, document.querySelector("#studio-output")); }
        catch (error) { kbFlowRenderError(graph, error); }
      }
      const zone = document.querySelector(".framework-view") || graph;
      if (zone) zone.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  showToast("已切换到双链图谱，点击节点可再打开整理助手", "success");
}

// 本轮是否真正执行了建链（create_link/add_node），用于给汇报消息尾部附跳转链接
function kbTurnCreatedLinks(doneMeta) {
  return Array.isArray(doneMeta && doneMeta.tool_trace) &&
    doneMeta.tool_trace.some((t) => t && (t.name === "create_link" || t.name === "add_node"));
}
// 本轮是否只做了双链推荐（recommend_link_gaps），尚未真正建链
function kbTurnProposedLinks(doneMeta) {
  return Array.isArray(doneMeta && doneMeta.tool_trace) &&
    doneMeta.tool_trace.some((t) => t && t.name === "recommend_link_gaps");
}
function kbGraphJumpLink() {
  return `<div class="kb-graph-jump"><button type="button" data-kb-action="open-graph" title="打开双链图谱查看新建的连线">🔗 查看双链图谱</button></div>`;
}
// 该消息的工具轨迹里是否真正执行过建链（create_link/add_node）：据此给汇报消息持久补挂跳转链接
function kbMsgHasLinkTrace(meta) {
  return Array.isArray(meta && meta.trace) &&
    meta.trace.some((t) => t && (t.name === "create_link" || t.name === "add_node"));
}
// 推荐完但未建链：明确告知用户点击下方 apply 按钮才真正执行建链（不引导文字回复确认）
function kbExecHint() {
  return `<div class="kb-exec-hint">👆 请在下方点击 <b>✓ 执行双链·新建节点</b> 按钮，即可真正建立上面的双链。</div>`;
}
// 用户简短确认词（推荐后等待确认阶段），用于把打字确认转发为真正的建链执行
const KB_LINK_CONFIRM_RE = /^(确认|同意|可以|好的|好|没问题|就这么办|就这么定|执行|采纳|批准|ok|okay)([！!。.])?$/i;

// 双链「理解」：一对双链共享一条关系说明，键按 node_id 字典序归一（与后端 node_link_notes 一致），
// 因此 A↔B 与 B↔A 落在同一个键上，两个方向读到的永远是同一句话。
function kbLinkPairKey(a, b) {
  const x = String(a || ""), y = String(b || "");
  return x <= y ? `${x}::${y}` : `${y}::${x}`;
}
function kbLinkNoteOf(a, b) {
  return (state.kbLinkNotes || {})[kbLinkPairKey(a, b)] || "";
}
// 项目详情里的 link_notes 数组 → 前端按对键索引的映射（空理解不入表，与后端一致）
function kbLinkNotesFromPayload(rows) {
  const map = {};
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const note = String((row && row.note) || "").trim();
    if (row && row.a_node_id && row.b_node_id && note) {
      map[kbLinkPairKey(row.a_node_id, row.b_node_id)] = note;
    }
  });
  return map;
}

// 图谱里只挂一句短标签（太长会互相压住），完整理解在右侧浮层与编辑弹框里看。

// 本地写入一对双链的理解（空串即删除），并就地同步到当前图谱的标签上。
// 走本地同步而不是整图重绘：重绘会重置力导向布局与视角，用户刚拖好的位置会跑掉。
function kbFlowSetLinkNoteLocal(a, b, note) {
  const key = kbLinkPairKey(a, b);
  const text = String(note || "").trim();
  if (text) state.kbLinkNotes[key] = text; else delete state.kbLinkNotes[key];
  if (typeof kbFlowNoteSync === "function") kbFlowNoteSync(a, b, text);
}

// 组双链图数据：节点 = 知识节点；边 = [[wikilinks]] 双链（同名匹配，双向去重）
function kbFlowBuild() {
  const nodes = state.nodes.map((n) => ({
    id: n.node_id,
    name: n.name,
    mastery: Number(n.mastery_score) || 0,
    lit: n.learning_status === "mastered" || (Number(n.mastery_score) || 0) >= 0.8
      ? "lit"
      : n.coverage_status && ["insufficient_source", "missing_prerequisite", "uncovered"].includes(n.coverage_status)
        ? "blocked"
        : n.learning_status === "encountered" || (Number(n.mastery_score) >= 0.35 && ["learning", "pending_confirmation"].includes(n.learning_status))
          ? "partial"
          : "dim",
  }));
  const byName = new Map(nodes.map((n) => [n.name.trim().toLowerCase(), n]));
  // 层级深度：根节点 depth=0，层级越高（越靠近根）成熟度越高
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parentOf = new Map();
  state.nodes.forEach((n) => {
    if (n.parent_id && n.parent_id !== n.node_id && byId.has(n.parent_id)) parentOf.set(n.node_id, n.parent_id);
  });
  const depthOf = new Map();
  const walkDepth = (id) => {
    if (depthOf.has(id)) return depthOf.get(id);
    const p = parentOf.get(id);
    const d = p ? walkDepth(p) + 1 : 0;
    depthOf.set(id, d);
    return d;
  };
  state.nodes.forEach((n) => walkDepth(n.node_id));
  const maxDepth = Math.max(0, ...depthOf.values());
  nodes.forEach((n) => {
    n.depth = depthOf.get(n.id) || 0;
    n.m = maxDepth ? Math.max(0.35, 1 - n.depth / (maxDepth + 1)) : 1;
    n.parentId = parentOf.get(n.id) || null;
  });
  const linkById = new Map(nodes.map((n) => [n.id, []]));
  const seen = new Set();
  const links = [];
  state.nodes.forEach((n) => {
    (n.wikilinks || []).forEach((raw) => {
      const name = String(raw || "").split("|")[0].trim().toLowerCase();
      if (!name) return;
      const target = byName.get(name);
      if (!target || target.id === n.node_id) return;
      const key = n.node_id < target.id ? `${n.node_id}::${target.id}` : `${target.id}::${n.node_id}`;
      if (seen.has(key)) return;
      seen.add(key);
      links.push({ source: n.node_id, target: target.id, note: kbLinkNoteOf(n.node_id, target.id) });
      linkById.get(n.node_id).push(target.id);
      linkById.get(target.id).push(n.node_id);
    });
  });
  return { nodes, links, linkById, byName };
}

function kbFlowDotColor(lit, dark) {
  if (dark) {
    if (lit === "lit") return { f: "#eef3f9", s: "#a9bdd2" };      // 已掌握（近白，如 Obsidian 高亮）
    if (lit === "partial") return { f: "#9ecbff", s: "#4f7fb0" };  // 学习中（Obsidian 蓝）
    if (lit === "blocked") return { f: "#d98f8f", s: "#a05252" };  // 来源不足（哑红）
    return { f: "#aeb9c7", s: "#5d6b7b" };                          // 未探索（Obsidian 灰）
  }
  // 浅色画布：换用高饱和深色调,浅底上依旧清晰（掌握度再向浅提亮形成"点亮"高光）
  if (lit === "lit") return { f: "#4b7d43", s: "#cfe6c8" };        // 已掌握（品牌绿）
  if (lit === "partial") return { f: "#2f6fb0", s: "#cfdcea" };    // 学习中（蓝）
  if (lit === "blocked") return { f: "#b04a46", s: "#f0d3d0" };    // 来源不足（哑红）
  return { f: "#8b8173", s: "#e6e0d4" };                            // 未探索（暖灰）
}

// 向白色插值提亮：k=0 保持原色，k=1 接近纯白（掌握度越高中心点越亮）
function kbFlowBright(hex, k) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const lerp = (v) => Math.round(v + (255 - v) * Math.min(1, Math.max(0, k)));
  return `rgb(${lerp(r)} ${lerp(g)} ${lerp(b)})`;
}

// Obsidian 式力导向布局（混乱但有序）
// 力 = 全局斥力(分开家族/散点) + 连线弹簧(相连者成簇) + 父子凝聚力(家族聚团)
//     + 中心弱引力/大圆边界反弹(整体收成一个圆)。叶/散节点被密集中心挤出，自然漂向外围。
function kbFlowSettle(data) {
  const { nodes, links } = data;
  const N = nodes.length;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  const deg = new Array(N).fill(0);
  links.forEach((l) => { if (idx.has(l.source)) deg[idx.get(l.source)]++; if (idx.has(l.target)) deg[idx.get(l.target)]++; });
  // 自生长系数：节点越多、双链越密 → 整簇圆环越大。
  // 面积随"规模负载"线性增长 ⇒ 半径 ∝ √负载，节点密度恒定，间距不再被压缩。
  // 负载 = 节点数 + 双链数×0.7（连线密集时线容易缠成一团，同样需要空间）。
  // 基准 12：小于约 12 个节点的图谱保持原有紧凑观感，不无谓放大。
  const FLOW_L = links.length || 0;
  const FLOW_LOAD = N + FLOW_L * 0.7;
  KB_FLOW_GROW = Math.min(3.8, Math.max(1, Math.sqrt(FLOW_LOAD / 12)));
  const GROW = KB_FLOW_GROW;
  // 碰撞最小间距同步放大：大圆变大后，节点间也要留出同比例的呼吸空间
  KB_FLOW_GAP = 14 * Math.min(3, Math.max(1, GROW * 0.85));
  const cx = KB_FLOW_W / 2, cy = KB_FLOW_H / 2;
  const pos = nodes.map(() => ({ x: cx + (Math.random() - 0.5) * 80, y: cy + (Math.random() - 0.5) * 80 }));

  // 父→子邻接 + 深度
  const childMap = new Map();
  const roots = [];
  nodes.forEach((n) => {
    if (n.parentId && byId.has(n.parentId)) {
      const arr = childMap.get(n.parentId);
      if (arr) arr.push(n); else childMap.set(n.parentId, [n]);
    } else roots.push(n);
  });
  if (!roots.length) roots.push(nodes[0]);
  const depth = new Array(N);
  const maxD = { v: 0 };
  function dfs(id, d) {
    const i = idx.get(id);
    if (i == null) return;
    depth[i] = d;
    if (d > maxD.v) maxD.v = d;
    (childMap.get(id) || []).forEach((k) => dfs(k.id, d + 1));
  }
  roots.forEach((r) => dfs(r.id, 0));
  nodes.forEach((n, i) => { if (depth[i] == null) depth[i] = 0; });

  // 递归星环：父级居中，每个子级在全角均布的方位、等距躺在其外一层环上；
  // 子级各自又以自身为心生出它的子级环 → 层层外扩、逐级环绕，整体自然长成圆形。
  // 环半径随深度线性增长 + 随子数开方扩容 = 节点越深/越多，圆越大（自生长）。
  function placeHalo(id, px, py, d, parentAng, myRing) {
    const kids = childMap.get(id) || [];
    const i = idx.get(id);
    // 环半径：① 下限 55 保证父与子不贴脸 ② 每个同环兄弟再摊 10（周长 ∝ 兄弟数
    // ⇒ 兄弟间距恒定在 ~63，不再像 √n 那样人一多就挤成一团）③ 深度每加一层外扩 8
    // ④ 整体乘自生长系数 GROW —— 节点/双链越多，环越大、圆越长。
    const ringR = Math.max(55, 30 + kids.length * 10 + 8 * d) * GROW;
    const self = nodes[i];
    self._home = { x: px, y: py };      // 绝对原位（根的回位锚；子级仅作记录）
    self._relR = myRing || 0;           // 自身相对父级的环半径（父级调用时传入）
    self._relAng = parentAng || 0;      // 自身相对父级的方位角
    pos[i] = { x: px, y: py };
    if (!kids.length) return;
    const off = d % 2 ? Math.PI / kids.length : 0;          // 隔层错相，避免环间径向排成辐射线
    kids.forEach((k, ki) => {
      const a = off + (ki + 0.5) * (Math.PI * 2 / kids.length);
      placeHalo(k.id, px + Math.cos(a) * ringR, py + Math.sin(a) * ringR, d + 1, a, ringR);
    });
  }
  if (roots.length === 1) {
    placeHalo(roots[0].id, cx, cy, 0, 0, 0);
  } else if (roots.length > 1) {
    // 多根：各自为一个小岛，绕整体圆心排布，子树从自身向外星环展开
    // 岛屿环同样"周长 ∝ 根数"，根多了也不会挤成一坨
    const rootR = (20 + roots.length * 14) * GROW;
    roots.forEach((r, ri) => {
      const c0 = -Math.PI + (ri + 0.5) * (Math.PI * 2 / roots.length);
      placeHalo(r.id, cx + Math.cos(c0) * rootR, cy + Math.sin(c0) * rootR, 1, c0, 0);
    });
  } else {
    nodes.forEach((n, i) => { const a = (i / Math.max(1, N)) * Math.PI * 2; pos[i] = { x: cx + Math.cos(a) * 130 * GROW, y: cy + Math.sin(a) * 130 * GROW }; });
  }

  // 隐形球心 = 当前节点质心（父级/家族整体定位的中心）；圆的轮廓由此圆心展开
  let gcX = 0, gcY = 0;
  nodes.forEach((n, i) => { gcX += pos[i].x; gcY += pos[i].y; });
  gcX /= N; gcY /= N;

  // 圆形轮廓节点 = 物理上最外围的叶子：按"到隐形球心的环半径"取最外约六成的叶子上圆环。
  // 不同深度的岛屿各自向外长，贴近圆边缘的叶子都认定为边缘节点并统一上圆环，剪影圆润饱满；
  // 内层叶子/内部子级仍回绕各自父级，保证"父级被子级对称环绕"（第二优先）
  const leafRadii = [];
  nodes.forEach((n, i) => {
    if ((childMap.get(n.id) || []).length) return;          // 只统计叶子
    const dx = pos[i].x - gcX, dy = pos[i].y - gcY;
    leafRadii.push({ i, rr: Math.hypot(dx, dy) || 1 });
  });
  leafRadii.sort((p, q) => q.rr - p.rr);
  const edgeN = leafRadii.length ? Math.max(1, Math.ceil(leafRadii.length * 0.6)) : 0;
  const edgeSet = new Set(leafRadii.slice(0, edgeN).map((o) => o.i));

  nodes.forEach((n, i) => {
    n.fx = pos[i].x; n.fy = pos[i].y;
    n._leaf = !(childMap.get(n.id) || []).length;          // 是否叶子
    const dx = pos[i].x - gcX, dy = pos[i].y - gcY;
    const rr = Math.hypot(dx, dy) || 1;
    n._edge = n._leaf && !!n.parentId && edgeSet.has(i);   // 最外圈叶子 → 占据圆形边缘
    n._ringR = Math.max(60 * Math.min(2.6, GROW), rr);      // 相对球心的环半径（自生长）
    n._ang0 = Math.atan2(dy, dx);                           // 环绕方位角
    n._orbitR = n._ringR;
    n._hbx = 0; n._hby = 0;                                 // 原位惰性的永久偏置：回位到"基准+偏置"，故不全回原位
    n.phase = Math.random() * Math.PI * 2;
    n.speed = 0.02 + Math.random() * 0.04;
    n.amp = 1.8 + Math.random() * 2.2;
    n.tilt = 3 + Math.random() * 3;
    n.wob = 0.8 + Math.random() * 1.2;
    n.lx = pos[i].x; n.ly = pos[i].y;
    n.dx = 0; n.dy = 0;
    n.gx = 0; n.gy = 0;   // 拖拽父级时的"随带偏移"：子树整体跟随父级移动
    n.cx = 0; n.cy = 0;   // （保留字段，边缘游走改由 _ang0 驱动）
    n.deg = idx.has(n.id) ? deg[idx.get(n.id)] : 0;
    n.small = !!n.parentId && n.deg <= 3;
    // 节点大小由连接度决定——叶子小圆、枢纽大圆
    n.baseR = (n.small ? 3.0 : 4.6) + Math.min(7, n.deg * 1.15) + (n.lit === "lit" ? 1.1 : 0);
    n.drawR = n.baseR;
    // 3D 球体深度：前大后小，营造体积感
    n.dep = Math.random() * 2 - 1;
    n.r3 = n.baseR * (1 + 0.28 * n.dep);
  });

  // 优先①增强：把最外层叶子的环半径统一到均值(略外扩)，使圆形剪影平整——
  // 更深/更浅的最外叶都被固定在同一个隐形球边缘上，整体轮廓稳稳呈现一个圆
  let eSum = 0, eN = 0;
  nodes.forEach((n) => { if (n._edge) { eSum += n._ringR; eN++; } });
  if (eN) {
    const eR = (eSum / eN) * 1.12;
    // 只向外取齐、不向内拉回：比均值更靠外的叶子保持自己的半径，
    // 免得把外圈节点硬拽进内层去撞别人（圆形剪影依旧平整）
    nodes.forEach((n) => { if (n._edge) n._orbitR = Math.max(n._orbitR, eR); });
  }

  // 预松弛：全角星环布局有个固有缺陷——子节点的环可能"回头"盖到祖父/叔伯身上，
  // 首屏就出现节点叠节点。这里先离线跑若干轮"碰撞弹开 + 回位"，让簇自己撑开：
  // 节点/双链越多，需要撑开的量越大，大圆也就越大（自生长）。
  {
    const gap0 = KB_FLOW_GAP;
    const iters = N > 400 ? 40 : N > 240 ? 90 : 180;   // 超大图谱减少轮数，避免初始化卡顿
    for (let it = 0; it < iters; it++) {
      nodes.forEach((n) => {
        const h = kbFlowHomeOf(n, byId, gcX, gcY);
        n.dx = (h.x - n.fx) * 0.06; n.dy = (h.y - n.fy) * 0.06;
      });
      for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
        const a = nodes[i], b = nodes[j];
        const ddx = b.fx - a.fx, ddy = b.fy - a.fy;
        const d2 = ddx * ddx + ddy * ddy;
        const gapAB = gap0 + (a.baseR + b.baseR) * 0.5;
        if (d2 >= gapAB * gapAB) continue;
        const d = Math.sqrt(d2) || 1;
        const rep = ((gapAB - d) / gapAB) * 0.34;
        const pux = ddx / d, puy = ddy / d;
        a.dx -= pux * rep * gapAB; a.dy -= puy * rep * gapAB;
        b.dx += pux * rep * gapAB; b.dy += puy * rep * gapAB;
      }
      nodes.forEach((n) => { n.fx += n.dx; n.fy += n.dy; n.dx = 0; n.dy = 0; });
    }
    // 重新对齐边叶的方位角，使"回位锚"指向松弛后的实际位置，避免刚出场就被拉回去
    nodes.forEach((n, i) => {
      if (!n._edge) return;
      const dx = n.fx - gcX, dy = n.fy - gcY;
      n._ang0 = Math.atan2(dy, dx);
      n._orbitR = Math.max(n._orbitR || 0, Math.hypot(dx, dy));
    });
  }

  // 大圆半径 = 松弛后最外层节点的实际环半径（已随节点数/双链数自生长）：
  // 整图适配与边界判断的基准
  KB_FLOW_RO = 0;
  nodes.forEach((n) => { KB_FLOW_RO = Math.max(KB_FLOW_RO, Math.hypot(n.fx - gcX, n.fy - gcY)); });
  if (!KB_FLOW_RO) KB_FLOW_RO = Math.min(KB_FLOW_W, KB_FLOW_H) * 0.47;
  // 典型最近邻距离（取 15% 分位，避免个别极近的偶发对把整幅过度放大）：
  // 可读性缩放下限据此换算——保证这一距离在屏幕上不小于某个像素值
  const nnList = [];
  for (let i = 0; i < N; i++) {
    let best = Infinity;
    for (let j = 0; j < N; j++) {
      if (i === j) continue;
      const d = Math.hypot(nodes[i].fx - nodes[j].fx, nodes[i].fy - nodes[j].fy);
      if (d < best) best = d;
    }
    if (best < Infinity) nnList.push(best);
  }
  nnList.sort((a, b) => a - b);
  KB_FLOW_NN = nnList.length ? (nnList[Math.floor(nnList.length * 0.15)] || nnList[0]) : 0;
  try { window.__kbFlowNodes = nodes; } catch (e) {}   // 调试探查出口
}

// 节点的"基准回位点"（不含惰性偏置）：边缘叶绕球心、非边缘子级绕父、根回绝对原位
function kbFlowHomeOf(n, byId, gcX, gcY) {
  if (n._edge) return { x: gcX + Math.cos(n._ang0 || 0) * (n._orbitR || n._ringR || 1), y: gcY + Math.sin(n._ang0 || 0) * (n._orbitR || n._ringR || 1) };
  if (n.parentId) {
    const P = byId.get(n.parentId);
    if (P) return { x: P.fx + Math.cos(n._relAng || 0) * (n._relR || 0), y: P.fy + Math.sin(n._relAng || 0) * (n._relR || 0) };
  }
  return { x: n._home ? n._home.x : n.fx, y: n._home ? n._home.y : n.fy };
}

// 拖动节点时逐帧轻量联动：只让被拖节点的"直接双链邻居"朝拖拽方向轻微偏移（带位移上限），
// 一次到位、不沿连接链传播、不做多轮拉网松弛——否则整片相连的知识网络会被拖拽点一路塌缩成中心 blob。
function kbFlowDragSim(dragNode, nodes, linkById, byId) {
  const start = (dragNode._flock && dragNode._flock.start) || { x: dragNode.fx, y: dragNode.fy };
  const offX = dragNode.fx - start.x, offY = dragNode.fy - start.y;
  const direct = new Set(linkById.get(dragNode.id) || []);
  nodes.forEach((n) => {
    if (n === dragNode) { n.dx = 0; n.dy = 0; return; }
    if (!direct.has(n.id)) { n.dx = 0; n.dy = 0; return; }
    // 直接邻居向拖拽方向跟随 35%，封顶 42 单位；非邻居完全不动
    n.dx = Math.max(-42, Math.min(42, offX * 0.35));
    n.dy = Math.max(-42, Math.min(42, offY * 0.35));
  });
}

// 收集某节点的全部子孙，并按其与根的距离给出"随带权重"：
// 直系子节点跟随最强，孙辈/重孙辈随深度衰减（子>孙>重孙），构成层级带动。
function kbFlowDescendants(root, nodes) {
  const children = new Map();
  for (const x of nodes) {
    if (x.parentId != null) {
      const arr = children.get(x.parentId);
      if (arr) arr.push(x); else children.set(x.parentId, [x]);
    }
  }
  const res = [];
  const q = [[root, 1]];
  while (q.length) {
    const [cur, d] = q.shift();
    const kids = children.get(cur.id) || [];
    for (const k of kids) {
      const w = Math.pow(0.55, d - 1);   // 子=1.0，孙≈0.55，重孙≈0.30
      res.push({ n: k, w });
      q.push([k, d + 1]);
    }
  }
  return res;
}

let kbFlowRaf = 0;
let kbFlowPaused = false;

// 主题化空态：知识星球线稿 + 天大元素（九教钟楼/海棠花）+ 引导文案
// 自包含 defs（独立渐变 id），可被直接挂进 .kb-flow-graph
function kbFlowEmptyState() {
  const ns = "http://www.w3.org/2000/svg";
  const CX = KB_FLOW_W / 2, CY = KB_FLOW_H / 2;
  const isTju = document.documentElement.getAttribute("data-brand") === "tju";
  const isAcademic = usesCoolPalette();
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  const root = document.createElementNS(ns, "g");
  root.setAttribute("class", "kb-flow-empty");

  const defs = document.createElementNS(ns, "defs");
  const bg = document.createElementNS(ns, "radialGradient");
  bg.setAttribute("id", "kb-fe-bg");
  // userSpaceOnUse + 大半径：配合下方放大的背景矩形，铺满宽容器的 letterbox 留白
  bg.setAttribute("gradientUnits", "userSpaceOnUse");
  bg.setAttribute("cx", String(CX)); bg.setAttribute("cy", String(KB_FLOW_H * 0.42));
  bg.setAttribute("r", String(KB_FLOW_H * 1.25));
  const bgStops = isAcademic
    ? (dark
      ? [["0%", "#1b2a43"], ["55%", "#151d2a"], ["100%", "#111821"]]
      : [["0%", "#ffffff"], ["55%", "#f8faff"], ["100%", "#eef3fa"]])
    : isTju
    ? (dark
      ? [["0%", "#131f33"], ["55%", "#0d1828"], ["100%", "#070e1b"]]
      : [["0%", "#f2f8fe"], ["55%", "#e4eef9"], ["100%", "#d0e2f2"]])
    : (dark
      ? [["0%", "#241c3e"], ["55%", "#181229"], ["100%", "#0c0818"]]
      : [["0%", "#fdfcf8"], ["55%", "#f6f3ec"], ["100%", "#ece7db"]]);
  for (const [o, c2] of bgStops) {
    const st = document.createElementNS(ns, "stop");
    st.setAttribute("offset", o); st.setAttribute("stop-color", c2);
    bg.appendChild(st);
  }
  defs.appendChild(bg);
  const silver = document.createElementNS(ns, "linearGradient");
  silver.setAttribute("id", "kb-fe-silver");
  silver.setAttribute("x1", "0"); silver.setAttribute("y1", "0");
  silver.setAttribute("x2", "1"); silver.setAttribute("y2", "1");
  for (const [o, c2] of (dark
    ? [["0%", "#e8eef5"], ["45%", "#b6c3d4"], ["100%", "#7e8fa6"]]
    : [["0%", "#c7d2dc"], ["35%", "#aebbc9"], ["70%", "#93a4b6"], ["100%", "#74879c"]])) {
    const st = document.createElementNS(ns, "stop");
    st.setAttribute("offset", o); st.setAttribute("stop-color", c2);
    silver.appendChild(st);
  }
  defs.appendChild(silver);
  root.appendChild(defs);

  const bgRect = document.createElementNS(ns, "rect");
  bgRect.setAttribute("class", "kb-fe-bg");
  bgRect.setAttribute("x", String(-KB_FLOW_W * 3));
  bgRect.setAttribute("y", String(-KB_FLOW_H * 3));
  bgRect.setAttribute("width", String(KB_FLOW_W * 7));
  bgRect.setAttribute("height", String(KB_FLOW_H * 7));
  bgRect.setAttribute("fill", "url(#kb-fe-bg)");
  root.appendChild(bgRect);

  // 星球虚线轮廓：暗示"知识星球待点亮"
  const sphere = document.createElementNS(ns, "circle");
  sphere.setAttribute("class", "kb-flow-art-sphere");
  sphere.setAttribute("cx", CX); sphere.setAttribute("cy", CY - 20);
  sphere.setAttribute("r", "318");
  root.appendChild(sphere);
  // 球内零星星尘
  const dust = document.createElementNS(ns, "g");
  dust.setAttribute("class", "kb-flow-art-dust");
  const dustPal = isAcademic
    ? (dark ? ["#5d76a5", "#7898c8", "#9db8f4", "#c7d7ff", "#e4ecff"] : ["#9ab2df", "#7898c8", "#5577c8", "#b7c9e8", "#dce6f8"])
    : dark
    ? ["#7c6fce", "#9486e3", "#c9bff5", "#6a5fb8", "#f0ecff"]
    : (isTju ? ["#8fb6e0", "#a9c8ec", "#c3daf3", "#7aa3d0", "#dfe9f8"] : ["#c9a86a", "#dcbf8c", "#e8d3a8", "#b08a4e", "#f0e2c4"]);
  for (let i = 0; i < 22; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 40 + Math.random() * 265;
    const p = document.createElementNS(ns, "circle");
    p.setAttribute("cx", (CX + Math.cos(a) * r).toFixed(1));
    p.setAttribute("cy", (CY - 20 + Math.sin(a) * r).toFixed(1));
    p.setAttribute("r", (1 + Math.random() * 2.4).toFixed(1));
    p.setAttribute("fill", dustPal[i % dustPal.length]);
    p.setAttribute("opacity", (0.25 + Math.random() * 0.45).toFixed(2));
    dust.appendChild(p);
  }
  root.appendChild(dust);

  // 天大主题：第九教学楼钟楼线稿 + 海棠花；通用主题：星芒点缀
  if (isTju) {
    root.appendChild(kbFlowTowerArt());
    root.appendChild(kbFlowBlossomArt(1120, 545, 1.15));
    root.appendChild(kbFlowBlossomArt(1230, 660, 0.78));
  } else {
    const star1 = kbFlowEmptyStar(208, 430, 20, 0.9);
    const star2 = kbFlowEmptyStar(1210, 470, 15, 0.7);
    const star3 = kbFlowEmptyStar(1285, 620, 11, 0.6);
    star1.setAttribute("class", "kb-flow-art-star");
    star2.setAttribute("class", "kb-flow-art-star");
    star3.setAttribute("class", "kb-flow-art-star");
    root.appendChild(star1); root.appendChild(star2); root.appendChild(star3);
  }

  // 中央银蓝星芒点缀（呼应节点造型）
  const accent = kbFlowEmptyStar(CX, CY - 128, 26, 1);
  accent.setAttribute("class", "kb-flow-art-star");
  root.appendChild(accent);

  return root;
}

// 图谱画布上的 HTML 覆盖层：文案用 CSS 字号渲染，不随 SVG 缩放失真
// kind: "empty" 空态引导 / "hint" 少链提示条 / "crop" 大图只显示局部提示 / null 移除
function kbFlowOverlay(container, kind) {
  const wrap = (container.closest && container.closest(".graph-wrap")) || container.parentElement;
  if (!wrap) return;
  wrap.querySelectorAll(".kb-flow-overlay").forEach((el) => el.remove());
  if (!kind) return;
  const ov = document.createElement("div");
  ov.className = `kb-flow-overlay kb-flow-overlay-${kind}`;
  if (kind === "empty") {
    const isTju = document.documentElement.getAttribute("data-brand") === "tju";
    ov.innerHTML = `
      <div class="kb-flow-empty-inner">
        <div class="kb-flow-empty-kicker">${isTju ? "KNOWORIGIN · 知识星球" : "知识网络图谱"}</div>
        <h3 class="kb-flow-empty-title2">${isTju ? "知识星球" : "知识图谱"}尚未点亮</h3>
        <p class="kb-flow-empty-main2">在学习工作台「生成/更新知识框架」后，这里将呈现你的${isTju ? "知识星球" : "知识网络"}与双链连线</p>
        <span class="kb-flow-empty-hint2">也可以在左侧「框架目录」点击 ＋ 新增节点，逐步构建知识网络</span>
      </div>`;
  } else if (kind === "crop") {
    ov.innerHTML = `
      <div class="kb-flow-hint-inner">
        <i class="kb-flow-hint-star" aria-hidden="true">🔍</i>
        <span>知识点较多，为保证节点不互相遮挡只显示了局部 · 滚轮缩小或按 <b>0</b> 看全貌，拖动可浏览</span>
      </div>`;
  } else {
    ov.innerHTML = `
      <div class="kb-flow-hint-inner">
        <i class="kb-flow-hint-star" aria-hidden="true">✦</i>
        <span>暂无双链连线 · 点击图谱节点，在「整理助手」为知识点建立双链后这里会点亮</span>
      </div>`;
  }
  wrap.appendChild(ov);
}

// 第九教学楼钟楼线稿：屋顶 + 塔身 + 表盘 + 拱窗（stroke 线稿，靠 CSS 上色/透明）
function kbFlowTowerArt() {
  const ns = "http://www.w3.org/2000/svg";
  const g = document.createElementNS(ns, "g");
  g.setAttribute("class", "kb-flow-art-tower");
  g.setAttribute("transform", "translate(268 452) scale(1.1)");
  const D = [
    ["polygon", "28,0 52,13 4,13"],          // 钟楼坡顶
    ["rect", 8, 13, 40, 58],                 // 塔身
    ["circle", 28, 32, 11],                  // 表盘
    ["line", 28, 32, 33, 26],                // 分针
    ["line", 28, 32, 28, 37],                // 时针
    ["rect", 4, 68, 48, 5],                  // 基座
    ["path", "M 16 54 a 5 5 0 0 1 10 0 v 12 h -10 z"],   // 左拱窗
    ["path", "M 34 54 a 5 5 0 0 1 10 0 v 12 h -10 z"],   // 右拱窗
    ["rect", 22, 46, 12, 20],                // 中门
  ];
  for (const [tag, ...args] of D) {
    const el = document.createElementNS(ns, tag);
    if (tag === "polygon") el.setAttribute("points", args[0]);
    else if (tag === "path") el.setAttribute("d", args[0]);
    else if (tag === "circle") { el.setAttribute("cx", args[0]); el.setAttribute("cy", args[1]); el.setAttribute("r", args[2]); }
    else if (tag === "line") { el.setAttribute("x1", args[0]); el.setAttribute("y1", args[1]); el.setAttribute("x2", args[2]); el.setAttribute("y2", args[3]); }
    else { el.setAttribute("x", args[0]); el.setAttribute("y", args[1]); el.setAttribute("width", args[2]); el.setAttribute("height", args[3]); }
    g.appendChild(el);
  }
  return g;
}

// 海棠花线稿：五瓣 + 花心，stroke 描边（CSS 上色）
function kbFlowBlossomArt(x, y, s) {
  const ns = "http://www.w3.org/2000/svg";
  const g = document.createElementNS(ns, "g");
  g.setAttribute("class", "kb-flow-art-flower");
  g.setAttribute("transform", `translate(${x} ${y}) scale(${s})`);
  for (let i = 0; i < 5; i++) {
    const p = document.createElementNS(ns, "ellipse");
    p.setAttribute("rx", "7"); p.setAttribute("ry", "13");
    p.setAttribute("transform", `rotate(${i * 72} 0 0)`);
    g.appendChild(p);
  }
  const core = document.createElementNS(ns, "circle");
  core.setAttribute("r", "3.2");
  g.appendChild(core);
  return g;
}

// 简洁五角星（点缀用）：外轮廓 + 中央圆孔，fill-rule evenodd 镂空
function kbFlowEmptyStar(x, y, R, o, fillId) {
  const ns = "http://www.w3.org/2000/svg";
  const ir = R * 0.4;
  let d = "";
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? R : ir;
    const a = Math.PI / 2 + i * Math.PI / 5 - 0.16;
    d += `${i === 0 ? "M" : "L"} ${(x + r * Math.cos(a)).toFixed(1)} ${(y - r * Math.sin(a)).toFixed(1)} `;
  }
  d += "Z";
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", `url(#${fillId || "kb-fe-silver"})`);
  path.setAttribute("fill-rule", "evenodd");
  path.setAttribute("stroke", "#7c8aa0");
  path.setAttribute("stroke-width", "1");
  path.setAttribute("opacity", String(o));
  return path;
}

function kbFlowInit(container) {
  if (!container) return;
  cancelAnimationFrame(kbFlowRaf);
  kbFlowPaused = false;
  kbFlowOverlay(container, null);
  const data = kbFlowBuild();
  if (!data.nodes.length) {
    // 图谱无节点时给出主题化空态：星球线稿 + 天大元素 + 引导文案，避免白屏让用户误以为加载失败
    console.warn("[双链图谱] state.nodes 为空，暂无可展示节点", state.nodes && state.nodes.length);
    container.setAttribute("viewBox", `0 0 ${KB_FLOW_W} ${KB_FLOW_H}`);
    container.appendChild(kbFlowEmptyState());
    kbFlowOverlay(container, "empty");
    return;
  }
  kbFlowSettle(data);
  const { nodes, links, linkById } = data;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // 父→子映射：悬浮某节点时显示它以及它的直接子级名字（围抱在父级周围的那圈）
  const parentOf = new Map();
  nodes.forEach((n) => { if (n.parentId && byId.has(n.parentId)) parentOf.set(n.id, n.parentId); });
  const ns = "http://www.w3.org/2000/svg";
  // 画布随"大圆"一起长大：按簇到画布中心的最大距离放大 viewBox（世界坐标不变），
  // 否则长出去的节点会被 SVG 视口裁掉。
  let maxOff = 0;
  nodes.forEach((n) => { maxOff = Math.max(maxOff, Math.hypot(n.fx - KB_FLOW_W / 2, n.fy - KB_FLOW_H / 2)); });
  const worldS = Math.min(6, Math.max(1, (maxOff * 2 + 240) / Math.min(KB_FLOW_W, KB_FLOW_H)));
  const worldW = KB_FLOW_W * worldS, worldH = KB_FLOW_H * worldS;
  const worldX = (KB_FLOW_W - worldW) / 2, worldY = (KB_FLOW_H - worldH) / 2;
  container.setAttribute("viewBox", `${worldX} ${worldY} ${worldW} ${worldH}`);

  container.innerHTML = "";
  const defs = document.createElementNS(ns, "defs");
  const grid = document.createElementNS(ns, "pattern");
  grid.setAttribute("id", "kb-flow-grid");
  grid.setAttribute("width", "26"); grid.setAttribute("height", "26");
  grid.setAttribute("patternUnits", "userSpaceOnUse");
  const gdot = document.createElementNS(ns, "circle");
  gdot.setAttribute("cx", "1.4"); gdot.setAttribute("cy", "1.4"); gdot.setAttribute("r", "1.1");
  gdot.setAttribute("class", "kb-flow-grid-dot");
  grid.appendChild(gdot); defs.appendChild(grid);
  const glowGrad = document.createElementNS(ns, "radialGradient");
  glowGrad.setAttribute("id", "kb-flow-glow");
  glowGrad.setAttribute("cx", "0.5"); glowGrad.setAttribute("cy", "0.5"); glowGrad.setAttribute("r", "0.5");
  const glowStop1 = document.createElementNS(ns, "stop");
  glowStop1.setAttribute("offset", "0%"); glowStop1.setAttribute("stop-color", "#ffffff"); glowStop1.setAttribute("stop-opacity", "0.9");
  const glowStop2 = document.createElementNS(ns, "stop");
  glowStop2.setAttribute("offset", "100%"); glowStop2.setAttribute("stop-color", "#ffffff"); glowStop2.setAttribute("stop-opacity", "0");
  glowGrad.appendChild(glowStop1); glowGrad.appendChild(glowStop2);
  defs.appendChild(glowGrad);
  // 银蓝金属渐变：左上高光 → 右下钢蓝暗影，模拟参考图的金属反光
  const silverGrad = document.createElementNS(ns, "linearGradient");
  silverGrad.setAttribute("id", "kb-flow-silver");
  silverGrad.setAttribute("x1", "0"); silverGrad.setAttribute("y1", "0");
  silverGrad.setAttribute("x2", "1"); silverGrad.setAttribute("y2", "1");
  silverGrad.setAttribute("gradientUnits", "objectBoundingBox");
  const silStops = [["0%", "#F5F8FA"], ["28%", "#E3EAF0"], ["62%", "#BCC6D2"], ["100%", "#8797A8"]];
  for (const [off, col] of silStops) {
    const st = document.createElementNS(ns, "stop");
    st.setAttribute("offset", off); st.setAttribute("stop-color", col);
    silverGrad.appendChild(st);
  }
  defs.appendChild(silverGrad);
  // Obsidian 暗色背景：近黑底 + 中心泛光，营造"知识星云"深度
  // userSpaceOnUse：背景矩形会放大到超出 viewBox（补偿宽容器 letterbox 留白），
  // 渐变必须绑定用户坐标，放大后才不会拉伸变形、与原画布区无缝衔接
  const obsGrad = document.createElementNS(ns, "radialGradient");
  obsGrad.setAttribute("id", "kb-flow-obs");
  obsGrad.setAttribute("gradientUnits", "userSpaceOnUse");
  obsGrad.setAttribute("cx", String(KB_FLOW_W * 0.5)); obsGrad.setAttribute("cy", String(KB_FLOW_H * 0.45));
  obsGrad.setAttribute("r", String(KB_FLOW_H * 1.15 * worldS));   // 随画布一起放大，星云始终铺满大圆
  // Obsidian 紫罗兰星云底：中央暖紫光晕 → 外围深空靛色，呼应 Obsidian 暗色画布的紫调
  const obsStops = [["0%", "#2a2146"], ["45%", "#1d1730"], ["78%", "#141020"], ["100%", "#0d0a18"]];
  for (const [off, col] of obsStops) {
    const st = document.createElementNS(ns, "stop");
    st.setAttribute("offset", off); st.setAttribute("stop-color", col);
    obsGrad.appendChild(st);
  }
  defs.appendChild(obsGrad);
  // 浅色画布：暖白径向,与整体浅色调交融（深色主题用 obs 星云)
  // 同样改为 userSpaceOnUse，原因见上：背景矩形放大后渐变需绑定用户坐标
  const lightGrad = document.createElementNS(ns, "radialGradient");
  lightGrad.setAttribute("id", "kb-flow-light");
  lightGrad.setAttribute("gradientUnits", "userSpaceOnUse");
  lightGrad.setAttribute("cx", String(KB_FLOW_W * 0.5)); lightGrad.setAttribute("cy", String(KB_FLOW_H * 0.4));
  lightGrad.setAttribute("r", String(KB_FLOW_H * 1.25 * worldS));
  const isTjuCanvas = document.documentElement.getAttribute("data-brand") === "tju";
  // 学术极简 / Agent 工作台用冷白蓝灰纸面；其余保持原来的暖白与天大蓝。
  // 渐变必须在这里定色：CSS 令牌换了布局也刷不到 SVG defs。
  const lightStops = usesCoolPalette()
    ? [["0%", "#fbfcfe"], ["55%", "#f3f6fb"], ["100%", "#e8edf5"]]
    : isTjuCanvas
      ? [["0%", "#f1f7fd"], ["55%", "#e3eef9"], ["100%", "#d3e3f2"]]
      : [["0%", "#fdfcf8"], ["55%", "#f6f3ec"], ["100%", "#ece7db"]];
  for (const [off, col] of lightStops) {
    const st = document.createElementNS(ns, "stop");
    st.setAttribute("offset", off); st.setAttribute("stop-color", col);
    lightGrad.appendChild(st);
  }
  defs.appendChild(lightGrad);
  // 浅色画布下的星芒：钢蓝描影渐变,保持金属质感且在浅底清晰可辨
  const silverLightGrad = document.createElementNS(ns, "linearGradient");
  silverLightGrad.setAttribute("id", "kb-flow-silver-light");
  silverLightGrad.setAttribute("x1", "0"); silverLightGrad.setAttribute("y1", "0");
  silverLightGrad.setAttribute("x2", "1"); silverLightGrad.setAttribute("y2", "1");
  silverLightGrad.setAttribute("gradientUnits", "objectBoundingBox");
  const silLStops = [["0%", "#c7d2dc"], ["35%", "#aebbc9"], ["70%", "#93a4b6"], ["100%", "#74879c"]];
  for (const [off, col] of silLStops) {
    const st = document.createElementNS(ns, "stop");
    st.setAttribute("offset", off); st.setAttribute("stop-color", col);
    silverLightGrad.appendChild(st);
  }
  defs.appendChild(silverLightGrad);
  // 浅色画布下的掌握度光晕：从中心向外柔和渐隐的径向渐变。
  // ⚠️ 千万别用 CSS 的 fill 把它压成纯色 —— 那样每个节点会变成一枚硬边蓝盘，
  // 一屏节点叠在一起就是一团糊掉的蓝污渍（这正是之前蓝雾的成因）。
  // 冷蓝布局用蓝灰光晕，其余保留原来的柔和紫。
  const glowLightColor = usesCoolPalette() ? "#5f7fc4" : "#c9a86a";
  const glowLightGrad = document.createElementNS(ns, "radialGradient");
  glowLightGrad.setAttribute("id", "kb-flow-glow-light");
  glowLightGrad.setAttribute("cx", "0.5"); glowLightGrad.setAttribute("cy", "0.5"); glowLightGrad.setAttribute("r", "0.5");
  const glowL1 = document.createElementNS(ns, "stop");
  glowL1.setAttribute("offset", "0%"); glowL1.setAttribute("stop-color", glowLightColor); glowL1.setAttribute("stop-opacity", "0.85");
  const glowL2 = document.createElementNS(ns, "stop");
  glowL2.setAttribute("offset", "100%"); glowL2.setAttribute("stop-color", glowLightColor); glowL2.setAttribute("stop-opacity", "0");
  glowLightGrad.appendChild(glowL1); glowLightGrad.appendChild(glowL2);
  defs.appendChild(glowLightGrad);

  // 隐形自生长簇：不再裁剪固定球体，内容可自由摆放，圆形由最外层叶子自发生成
  const clipR = 20000;
  const sphClip = document.createElementNS(ns, "clipPath");
  sphClip.setAttribute("id", "kb-flow-clip");
  const clipC = document.createElementNS(ns, "circle");
  clipC.setAttribute("cx", KB_FLOW_W / 2); clipC.setAttribute("cy", KB_FLOW_H / 2);
  clipC.setAttribute("r", String(clipR));
  sphClip.appendChild(clipC); defs.appendChild(sphClip);

  // 球体受左上光源照射：中心亮、右下渐暗，形成立体球面的体积感
  const sphL = document.createElementNS(ns, "radialGradient");
  sphL.setAttribute("id", "kb-flow-sphere-s");
  sphL.setAttribute("cx", "0.34"); sphL.setAttribute("cy", "0.30"); sphL.setAttribute("r", "0.95");
  [["0%", "#fdfeff"], ["30%", "#e9f1fc"], ["55%", "#cfe0f7"], ["78%", "#a7c3e9"], ["100%", "#7b9ad4"]]
    .forEach(([o, c2]) => { const s = document.createElementNS(ns, "stop"); s.setAttribute("offset", o); s.setAttribute("stop-color", c2); sphL.appendChild(s); });
  defs.appendChild(sphL);

  const sphD = document.createElementNS(ns, "radialGradient");
  sphD.setAttribute("id", "kb-flow-sphere-sd");
  sphD.setAttribute("cx", "0.34"); sphD.setAttribute("cy", "0.30"); sphD.setAttribute("r", "0.95");
  [["0%", "#3e3373"], ["30%", "#2a2150"], ["58%", "#1a1336"], ["80%", "#110c28"], ["100%", "#080616"]]
    .forEach(([o, c2]) => { const s = document.createElementNS(ns, "stop"); s.setAttribute("offset", o); s.setAttribute("stop-color", c2); sphD.appendChild(s); });
  defs.appendChild(sphD);

  const sphHi = document.createElementNS(ns, "radialGradient");
  sphHi.setAttribute("id", "kb-flow-spec");
  sphHi.setAttribute("cx", "0.5"); sphHi.setAttribute("cy", "0.5"); sphHi.setAttribute("r", "0.5");
  const h1 = document.createElementNS(ns, "stop");
  h1.setAttribute("offset", "0%"); h1.setAttribute("stop-color", "#ffffff"); h1.setAttribute("stop-opacity", "0.55");
  const h2 = document.createElementNS(ns, "stop");
  h2.setAttribute("offset", "100%"); h2.setAttribute("stop-color", "#ffffff"); h2.setAttribute("stop-opacity", "0");
  sphHi.appendChild(h1); sphHi.appendChild(h2);
  defs.appendChild(sphHi);
  container.appendChild(defs);

  const bg = document.createElementNS(ns, "rect");
  bg.setAttribute("class", "kb-flow-bg");
  // 背景矩形远大于 viewBox：宽屏容器按 xMidYMid meet 适配时，viewBox 两侧/上下会留出
  // letterbox 空白（原先是页面白底，很扎眼）。放大矩形 + SVG 默认按元素框裁剪，
  // 背景即可无缝铺满整个容器，且不会外溢到面板之外。
  bg.setAttribute("x", String(-KB_FLOW_W * 3));
  bg.setAttribute("y", String(-KB_FLOW_H * 3));
  bg.setAttribute("width", String(KB_FLOW_W * 7));
  bg.setAttribute("height", String(KB_FLOW_H * 7));
  bg.setAttribute("fill", "url(#kb-flow-obs)");
  container.appendChild(bg);

  const viewport = document.createElementNS(ns, "g");
  viewport.setAttribute("class", "kb-flow-viewport");
  container.appendChild(viewport);
  // 球体外壳：置于内容之下，作为"细胞"的体积边界；内容都被裁剪在球内
  const SX = KB_FLOW_W / 2, SY = KB_FLOW_H / 2;
  // 大圆半径 = 最外层叶子所在环，随节点数/双链数自生长（kbFlowSettle 算出），不再是固定值
  const SR = KB_FLOW_RO;
  const sphereG = document.createElementNS(ns, "g");
  sphereG.setAttribute("class", "kb-flow-sphere");
  const sphBody = document.createElementNS(ns, "circle");
  sphBody.setAttribute("class", "kb-flow-sphere-body");
  sphBody.setAttribute("cx", SX); sphBody.setAttribute("cy", SY); sphBody.setAttribute("r", String(SR));
  sphBody.setAttribute("fill", "url(#kb-flow-sphere-s)");
  const sphRim = document.createElementNS(ns, "circle");
  sphRim.setAttribute("class", "kb-flow-sphere-rim");
  sphRim.setAttribute("cx", SX); sphRim.setAttribute("cy", SY); sphRim.setAttribute("r", String(SR));
  const sphSpec = document.createElementNS(ns, "ellipse");
  sphSpec.setAttribute("class", "kb-flow-sphere-spec");
  sphSpec.setAttribute("cx", String(SX - SR * 0.30)); sphSpec.setAttribute("cy", String(SY - SR * 0.34));
  sphSpec.setAttribute("rx", String(SR * 0.34)); sphSpec.setAttribute("ry", String(SR * 0.21));
  sphSpec.setAttribute("fill", "url(#kb-flow-spec)");
  sphereG.appendChild(sphBody); sphereG.appendChild(sphSpec); sphereG.appendChild(sphRim);
  // 去掉画出的球体边界：外壳球体不再挂载可见（保持容器结构以兼容其余逻辑），
  // 整体呈现为父级为心、子级环绕、最外层叶子围成圆形轮廓的"隐形自生长簇"
  sphereG.style.display = "none";
  viewport.appendChild(sphereG);
  const contentG = document.createElementNS(ns, "g");
  contentG.setAttribute("class", "kb-flow-content");
  contentG.setAttribute("clip-path", "url(#kb-flow-clip)");
  viewport.appendChild(contentG);
  // 尘埃流动层：铺满整个球体，缓慢环绕漂移 → Obsidian 式"知识星尘"流动感，
  // 淡紫星尘填补球体两侧的空白，让整幅不显空旷。
  const dustG = document.createElementNS(ns, "g");
  dustG.setAttribute("class", "kb-flow-dust");
  contentG.appendChild(dustG);
  const DUST_N = 105;  // 主画布区星尘：原 70 颗 × 1.5 ≈ 105，中心密度 1.5×
  const DUST_EXTRA = 46; // 四周留白区补撒的星尘：宽/窄容器 letterbox 不显空荡
  // 星尘活动范围向四周外扩：宽/窄容器 letterbox 留白区也有星尘，两侧不显死板
  // 星尘活动范围随画布一起外扩：大圆长大后四周仍有星尘，不显空荡
  const DUST_MX = KB_FLOW_W * 0.8 * worldS, DUST_MY = KB_FLOW_H * 0.6 * worldS;
  const dustDark = document.documentElement.getAttribute("data-theme") === "dark";
  const dustAcademic = usesCoolPalette();
  const dustPal = dustAcademic
    ? (dustDark ? ["#5d76a5", "#7898c8", "#9db8f4", "#c7d7ff", "#e4ecff"] : ["#9ab2df", "#7898c8", "#5577c8", "#b7c9e8", "#dce6f8"])
    : dustDark
    ? ["#6a5fb8", "#7c6fce", "#9486e3", "#c9bff5", "#f0ecff"]
    : ["#c9a86a", "#dcbf8c", "#e8d3a8", "#b08a4e", "#f0e2c4"];
  // 主画布内均匀撒点；留白区补撒的点若落进主画布，就推到最近的外侧，
  // 保证中心区域密度稳定、外圈只是轻点几笔
  const spawnDust = (inCore) => {
    if (inCore) return { x: worldX + Math.random() * worldW, y: worldY + Math.random() * worldH, outer: false };
    let x = worldX - DUST_MX + Math.random() * (worldW + DUST_MX * 2);
    let y = worldY - DUST_MY + Math.random() * (worldH + DUST_MY * 2);
    if (x > worldX && x < worldX + worldW && y > worldY && y < worldY + worldH) {
      if (Math.random() < 0.5) x = x < worldX + worldW / 2 ? worldX - Math.random() * DUST_MX : worldX + worldW + Math.random() * DUST_MX;
      else y = y < worldY + worldH / 2 ? worldY - Math.random() * DUST_MY : worldY + worldH + Math.random() * DUST_MY;
    }
    return { x, y, outer: true };
  };
  const dustPart = [];
  for (let i = 0; i < DUST_N + DUST_EXTRA; i++) {
    const seed = spawnDust(i < DUST_N);
    const col = dustPal[i % dustPal.length];
    const sz = 1.4 + Math.random() * 2.6 + (i % 6 === 0 ? 1.2 : 0);
    // 外层柔光晕 + 内层星点，让星尘在浅底/暗底都能被看清
    const halo = document.createElementNS(ns, "circle");
    halo.setAttribute("class", "kb-flow-dust-p");
    halo.setAttribute("r", String(sz * 2.6));
    halo.setAttribute("fill", col);
    dustG.appendChild(halo);
    const pc = document.createElementNS(ns, "circle");
    pc.setAttribute("class", "kb-flow-dust-p");
    pc.setAttribute("r", String(sz));
    pc.setAttribute("fill", col);
    dustG.appendChild(pc);
    dustPart.push({
      c: pc, h: halo,
      x: seed.x, y: seed.y,
      t: Math.random() * 100,
      sp: 0.1 + Math.random() * 0.32,
      ph: Math.random() * Math.PI * 2,
      // 外圈留白区略暗一档，视觉重心仍落在主画布的知识星球上
      vis: (0.18 + Math.random() * 0.5) * (seed.outer ? 0.78 : 1)
    });
  }
  // 连线淡化系数：按「平均度数 = 双链数 / 节点数」自适应。
  // 稀疏（<=1.1 条/节点）时保持 1、不额外淡化；越密越低（下限 0.58）。
  // 由 .kb-flow-link 的 opacity calc() 消费，连线多时不再糊成一张网、喧宾夺主。
  const linkDensity = links.length / Math.max(1, nodes.length);
  const linkAlphaK = linkDensity <= 1.1 ? 1 : Math.max(0.58, 1.1 / linkDensity);
  container.style.setProperty("--kb-link-alpha", linkAlphaK.toFixed(3));
  const linksG = document.createElementNS(ns, "g");
  linksG.setAttribute("class", "kb-flow-links");
  contentG.appendChild(linksG);
  // 连线命中区：可见连线只有 1px 上下，肉眼根本瞄不准，另起一层 16px 宽的透明粗线专接点击。
  // 单独成层放在可见连线之上、节点之下 —— 节点仍优先命中，点线不会被节点抢走。
  const linkHitsG = document.createElementNS(ns, "g");
  linkHitsG.setAttribute("class", "kb-flow-link-hits");
  contentG.appendChild(linkHitsG);
  const nodesG = document.createElementNS(ns, "g");
  nodesG.setAttribute("class", "kb-flow-nodes");
  contentG.appendChild(nodesG);

  const linkEls = links.map((l, li) => {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("class", "kb-flow-link");
    path.setAttribute("data-src", l.source);
    path.setAttribute("data-tgt", l.target);
    const a = byId.get(l.source), b = byId.get(l.target);
    const stem = Math.max(a ? a.m : 0.5, b ? b.m : 0.5);
    // 线宽整体收细一档（0.42~1.18，原 0.6~1.8）：细线在密网下不互相糊住
    path.style.setProperty("--stem-w", String(0.42 + 0.76 * stem));
    path._kbSW = 0.42 + 0.76 * stem;
    linksG.appendChild(path);
    const hit = document.createElementNS(ns, "path");
    hit.setAttribute("class", "kb-flow-link-hit");
    hit.setAttribute("data-src", l.source);
    hit.setAttribute("data-tgt", l.target);
    linkHitsG.appendChild(hit);
    // 双链「理解」不再贴在图谱连线上（影响观感），完整理解统一收在右侧浮层与编辑弹框里。
    return { el: path, hit, a: l.source, b: l.target, phase: li * 0.618 + 0.35 };
  });

  const nodeEls = nodes.map((n) => {
    const g = document.createElementNS(ns, "g");
    const depTier = (n.dep || 0) < -0.2 ? " kf-back" : (n.dep || 0) > 0.25 ? " kf-front" : "";
    g.setAttribute("class", `kb-flow-node${n.lit === "lit" ? " is-lit-node" : ""}${depTier}`);
    g.setAttribute("data-node-id", n.id);
    g.setAttribute("tabindex", "0");
    g.setAttribute("role", "button");
    g.setAttribute("aria-label", `${n.name}，掌握度 ${Math.round(n.mastery * 100)}%`);
    const g2 = document.createElementNS(ns, "g");
    g2.setAttribute("class", "kb-flow-dot-g");
    const ring = document.createElementNS(ns, "circle");
    ring.setAttribute("class", "kb-flow-ring");
    const mid = document.createElementNS(ns, "circle");
    mid.setAttribute("class", "kb-flow-dot-mid");
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("class", "kb-flow-dot");
    const flowDark = document.documentElement.getAttribute("data-theme") === "dark";
    const c = kbFlowDotColor(n.lit, flowDark);
    // 掌握度越高越亮：深色主题向白色插值，浅色主题适度提亮（保留可辨的主色）
    const masterK = Math.min(1, Math.max(0, n.mastery || 0));
    const defaultFill = flowDark ? kbFlowBright(c.f, masterK) : kbFlowBright(c.f, masterK * 0.45);
    dot.setAttribute("fill", defaultFill);
    dot.dataset.defaultFill = defaultFill;
    dot.setAttribute("stroke", flowDark ? kbFlowBright(c.s, masterK * 0.7) : c.s);
    const glow = document.createElementNS(ns, "circle");
    glow.setAttribute("class", "kb-flow-glow");
    glow.setAttribute("fill", flowDark ? "url(#kb-flow-glow)" : "url(#kb-flow-glow-light)");
    glow.setAttribute("r", String((n.r3 || n.baseR || 4) * (1.1 + 1.9 * masterK)));
    glow.setAttribute("opacity", String(flowDark ? 0.25 + 0.75 * masterK : 0.18 + 0.6 * masterK));
    g2.appendChild(glow); g2.appendChild(ring); g2.appendChild(mid); g2.appendChild(dot);
    const label = document.createElementNS(ns, "text");
    label.setAttribute("class", "kb-flow-label");
    label.setAttribute("text-anchor", "middle");
    // 掌握度决定文字层级：越高越醒目清晰；越低越退后收敛，减少杂乱
    const mkL = Math.min(1, Math.max(0, n.mastery || 0));
    label.classList.add(mkL >= 0.66 ? "is-mastered" : (mkL >= 0.33 ? "is-learning" : "is-faint"));
    // 深度视差：靠前的标签略下移，靠后的略上移，强化立体纵深
    label.setAttribute("y", -(n.r3 + 13) + (n.dep || 0) * 7);
    label.textContent = n.name;
    const title = document.createElementNS(ns, "title");
    title.textContent = `${n.name} · 掌握度 ${Math.round(n.mastery * 100)}%`;
    g.appendChild(title);
    const body = document.createElementNS(ns, "g");
    body.setAttribute("class", "kb-flow-body");
    body.appendChild(g2);
    g.appendChild(body);
    g.appendChild(label);
    const hit = document.createElementNS(ns, "circle");
    hit.setAttribute("class", "kb-flow-hit");
    hit.setAttribute("r", String(Math.max(n.baseR, 3.5 + 6.5 * n.m) + 6));
    g.appendChild(hit);
    nodesG.appendChild(g);
    return g;
  });

  // 无任何双链时提示建链入口（主题化提示条，HTML 覆盖层不随缩放失真）
  if (!links.length) {
    kbFlowOverlay(container, "hint");
  }

  const view = { zoom: 1, x: 0, y: 0, dragging: false, moved: false };
  // 首屏是否因"可读性下限"而只显示了局部（大图自动放大以保证间距）
  let flowCropped = false;
  const FLOW_CX = KB_FLOW_W / 2, FLOW_CY = KB_FLOW_H / 2;
  let inside = container.getBoundingClientRect();
  let viewportW = inside.width || 700;
  let viewportH = inside.height || 480;
  // 1 个 SVG 单位在屏幕上 = svgScale × view.zoom 像素。fit/尺寸补偿都必须计入它，
  // 否则窄视口（如右栏 244px）下整幅图谱被缩到约 1/6，节点缩成不可辨的尘埃。
  // 画布随大圆长大，故用 worldW/H（而非固定的 1500×1050）。
  const svgScaleInit = () => Math.min(viewportW / worldW, viewportH / worldH) || 1;
  let svgScale = svgScaleInit();
  let dragOrigin = null, panOrigin = null;

  const clamp = () => {
    const sw = worldW * view.zoom, sh = worldH * view.zoom;
    view.x = sw <= viewportW ? (viewportW - sw) / 2 : Math.max(viewportW - sw, Math.min(0, view.x));
    view.y = sh <= viewportH ? (viewportH - sh) / 2 : Math.max(viewportH - sh, Math.min(0, view.y));
  };
  const applyView = () => {
    clamp();
    viewport.setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.zoom})`);
    const label = container.closest(".framework-view")?.querySelector(".graph-zoom-label");
    if (label) { label.value = `${Math.round(view.zoom * 100)}%`; label.textContent = label.value; }
  };
  const svgPoint = (clientX, clientY) => {
    const p = container.createSVGPoint(); p.x = clientX; p.y = clientY;
    const m = container.getScreenCTM();
    return m ? p.matrixTransform(m.inverse()) : { x: viewportW / 2, y: viewportH / 2 };
  };
  const setZoom = (z, anchor = { x: viewportW / 2, y: viewportH / 2 }) => {
    const gx = (anchor.x - view.x) / view.zoom, gy = (anchor.y - view.y) / view.zoom;
    view.zoom = Math.max(0.12, Math.min(4, z));
    view.x = anchor.x - gx * view.zoom; view.y = anchor.y - gy * view.zoom;
    applyView();
  };
  const overview = () => {
    // 用布局尺寸（clientWidth/clientHeight），避免全屏展开动画期间
    // getBoundingClientRect 混入 transform 缩放导致适配到过渡中的小尺寸
    viewportW = container.clientWidth || viewportW;
    viewportH = container.clientHeight || viewportH;
    svgScale = svgScaleInit();
    // 默认适配节点实际包围范围（含标签边距），而非整张 1500×1050 画布：
    // 节点很少时自动放大到可看清，节点变多后自然回落为整图可见。
    // 节点集群包围（含标签边距）：节点很少时优先适配集群，让节点在窄视口下足够大
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      const r = (n.baseR || 4) + 34;
      minX = Math.min(minX, n.fx - r); minY = Math.min(minY, n.fy - r);
      maxX = Math.max(maxX, n.fx + r); maxY = Math.max(maxY, n.fy + r);
    }
    const clusterW = Math.max(48, maxX - minX), clusterH = Math.max(48, maxY - minY);
    // 球体包围：节点铺满球体时（节点多），整体适配进视口展示完整星球
    const sphereMinX = Math.min(minX, FLOW_CX - SR), sphereMinY = Math.min(minY, FLOW_CY - SR);
    const sphereMaxX = Math.max(maxX, FLOW_CX + SR), sphereMaxY = Math.max(maxY, FLOW_CY + SR);
    const sphereW = Math.max(48, sphereMaxX - sphereMinX), sphereH = Math.max(48, sphereMaxY - sphereMinY);
    const pad = Math.min(90, Math.max(14, Math.min(viewportW, viewportH) * 0.05));
    // 屏幕尺寸 = SVG 单位 × svgScale × zoom，故 fitZoom = 视口 / (包围 × svgScale)
    const fitCluster = Math.min((viewportW - pad * 2) / (clusterW * svgScale), (viewportH - pad * 2) / (clusterH * svgScale));
    const fitSphere = Math.min((viewportW - pad * 2) / (sphereW * svgScale), (viewportH - pad * 2) / (sphereH * svgScale));
    // 节点少：按集群适配（放大可读），球体边缘自然露出作上下文；
    // 节点多：集群≈球体，自然回落为整图可见。
    // 上限 2.2×集群缩放：仅在球体能"不远"看清时才切到球体全景，避免窄视口下节点缩成尘埃。
    const fitZoom = Math.max(fitCluster, Math.min(fitSphere, fitCluster * 2.2));
    // 可读性下限：节点/双链一多，"整图可见"会把整簇压成毛线球（节点互相遮挡、连线缠绕）。
    // 大圆虽已随规模长大，但"整图适配"会把长大的部分又缩回去，故再给一个最小可读缩放：
    // 取布局收敛后的典型最近邻距离（kbFlowSettle 已算好），保证它在屏幕上 ≥ 24px；
    // 超出视口的部分不再硬塞进来，改由拖动画布浏览。
    let ringN = 0;
    nodes.forEach((n) => { if (n._edge) ringN++; });
    const outerGap = (2 * Math.PI * Math.max(1, KB_FLOW_RO)) / Math.max(1, ringN || nodes.length);
    const nnSvg = Math.max(6, KB_FLOW_NN || Math.min(outerGap, 63 * KB_FLOW_GROW));
    const zRead = 24 / Math.max(1e-3, nnSvg * svgScale);
    // 至多比"整图适配"放大 1.8 倍：既保住可读性，又不至于只露出小小一角
    const zFloor = Math.min(zRead, fitZoom * 1.8);
    // 下限 0.2：右栏窄视口下节点极多时 fitZoom 可能很小，避免钳死导致切出可视区
    view.zoom = Math.max(0.2, Math.min(4, Math.max(fitZoom, zFloor)));
    // 记录"为保证可读性而裁掉了局部"，供首屏提示用
    flowCropped = view.zoom > fitZoom * 1.06;
    // 对准节点最密集处：以距所有节点质心最近的那个节点为锚点，
    // 保证默认聚焦在集群核心，而非空旷的图中心。
    let meanX = 0, meanY = 0;
    for (const n of nodes) { meanX += n.fx; meanY += n.fy; }
    meanX /= nodes.length; meanY /= nodes.length;
    let anchorX = nodes[0].fx, anchorY = nodes[0].fy, best = Infinity;
    for (const n of nodes) {
      const d = (n.fx - meanX) ** 2 + (n.fy - meanY) ** 2;
      if (d < best) { best = d; anchorX = n.fx; anchorY = n.fy; }
    }
    view.x = viewportW / 2 - anchorX * view.zoom;
    view.y = viewportH / 2 - anchorY * view.zoom;
    applyView();
  };
  // 容器尺寸变化（全屏展开/收起/视窗缩放）时防抖后重新整图适配
  let flowFitTimer = null;
  const flowResize = typeof ResizeObserver !== "undefined"
    ? new ResizeObserver(() => {
        clearTimeout(flowFitTimer);
        flowFitTimer = setTimeout(overview, 180);
      })
    : null;
  if (flowResize) flowResize.observe(container);

  container.addEventListener("wheel", (e) => {
    e.preventDefault();
    setZoom(view.zoom * Math.exp(-e.deltaY * 0.0015), svgPoint(e.clientX, e.clientY));
  }, { passive: false });
  let dragNode = null, dragEl = null, dragStart = null, dragClient = null, dragLeash = null;
  // 拖动结束后「留住名字」的节点 id：松手时不清，下一次拖动 / 点空白 / hover 别的节点才清
  let dragFocusKeep = null;
  container.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    container._justPanned = false;
    const nodeG = e.target.closest ? e.target.closest(".kb-flow-node") : null;
    const n = nodeG ? byId.get(nodeG.dataset.nodeId) : null;
    if (n) {
      dragNode = n;
      n.__reacted = false; // 每次新拖动重置：未松手就触发海小棠组织语言，只触发一次
      dragStart = { x: n.fx, y: n.fy };
      view.moved = false;
      dragOrigin = svgPoint(e.clientX, e.clientY);
      dragClient = { x: e.clientX, y: e.clientY };
      // 小节点限制拖拽半径：以开始时与父级的距离为基准，允许少量余量
      dragLeash = null;
      if (n.small && n.parentId) {
        const parent = byId.get(n.parentId);
        if (parent) {
          const px = parent.fx + (parent.dx || 0), py = parent.fy + (parent.dy || 0);
          dragLeash = Math.hypot(n.fx - px, n.fy - py) * 1.35 + 16;
        }
      }
      // 新一次拖动开始：上一轮留下的名字到这里才清除（这就是「第二次拖动才消失」）
      kbFlowDropKeep();
      container.classList.add("kb-flow-node-dragging");
      // Obsidian 拖拽层次感：把被拖节点提到顶层并标记 is-dragging（CSS 负责投影放大）
      dragEl = nodeG;
      nodeG.classList.add("is-dragging");
      nodesG.appendChild(nodeG);
      // 拖拽高亮：被拖节点(is-focus) + 双链关联节点(is-neighbor) + 连线(is-active) 同时提亮，持续到松手
      kbFlowFocus(n.id, true);
      // 层级带动：父级被拖，整棵子树跟着跑；子孙越多拖拽越"沉"，越难拉动
      const dl = kbFlowDescendants(n, nodes);
      dragNode._flock = {
        start: { x: n.fx, y: n.fy },
        list: dl,
        heft: Math.max(0.72, Math.min(1, 1 / (1 + dl.length * 0.05)))
      };
      return;
    }
    kbFlowDropKeep();   // 按住空白处平移画布：留存的聚焦与名字一并清除
    view.dragging = true; view.moved = false;
    dragOrigin = svgPoint(e.clientX, e.clientY);
    dragClient = { x: e.clientX, y: e.clientY };
    panOrigin = { x: view.x, y: view.y };
    container.classList.add("kb-flow-panning");
  });
  container.addEventListener("pointermove", (e) => {
    if (dragNode) {
      if (!(e.buttons & 1)) { endPan(e); return; }
      const cdx = e.clientX - dragClient.x, cdy = e.clientY - dragClient.y;
      if (!view.moved && Math.hypot(cdx, cdy) > 3) {
        view.moved = true;
        try { container.setPointerCapture(e.pointerId); } catch (_) {}
      }
      if (!view.moved) return;
      // 未松手就开始组织语言：判定为拖动后立即触发一次，海小棠先反应，LLM 后台组织话术
      if (dragNode && dragNode.id != null && !dragNode.__reacted) {
        dragNode.__reacted = true;
        const nick = dragNode.name || "这个节点";
        const linked = (linkById.get(dragNode.id) || []).map((id) => (byId.get(id) || {}).name).filter(Boolean);
        const fb = linked.length
          ? `你把「${nick}」拽起来了，它牵着 ${linked.slice(0, 6).map((s) => `「${s}」`).join("、")}${linked.length > 6 ? " 等" : ""} 这些双链节点。`
          : `你把「${nick}」拽起来了，这个节点暂时还没连上双链邻居，需要的话可以让 AI 同学帮你找找配对。`;
        petReactAI("graph_drag", { node: nick, links: linked }, "think", fb, { ic: "🔗", stayMs: 7200 });
      }
      const p = svgPoint(e.clientX, e.clientY);
      // viewBox 增量需除以缩放，节点才能在屏幕上精确跟手
      let nx = dragStart.x + (p.x - dragOrigin.x) / view.zoom;
      let ny = dragStart.y + (p.y - dragOrigin.y) / view.zoom;
      // 带动拖拽重量：子孙越多越"沉"，越难拖动（位移被按比例削减，产生沉重感）
      if (dragNode._flock && dragNode._flock.heft < 1) {
        nx = dragStart.x + (nx - dragStart.x) * dragNode._flock.heft;
        ny = dragStart.y + (ny - dragStart.y) * dragNode._flock.heft;
      }
      // 小节点不超过约束半径：尽量别离父级比开始拖动时更远
      if (dragLeash != null && dragNode.parentId) {
        const parent = byId.get(dragNode.parentId);
        if (parent) {
          const px = parent.fx + (parent.dx || 0), py = parent.fy + (parent.dy || 0);
          const ddx = nx - px, ddy = ny - py;
          const d = Math.hypot(ddx, ddy);
          if (d > dragLeash) {
            nx = px + ddx / d * dragLeash;
            ny = py + ddy / d * dragLeash;
          }
        }
      }
      // 无固定边界：父级可自由拖到任意位置，其环绕子级会随之移动
      dragNode.fx = nx; dragNode.fy = ny;
      // 层级带动：父级动多少，子孙按深度衰减地跟着动（子最强、孙弱、重孙更弱）
      if (dragNode._flock) {
        const offX = dragNode.fx - dragNode._flock.start.x;
        const offY = dragNode.fy - dragNode._flock.start.y;
        for (const f of dragNode._flock.list) { f.n.gx = offX * f.w; f.n.gy = offY * f.w; }
      }
      return;
    }
    if (!view.dragging) return;
    if (!(e.buttons & 1)) { endPan(e); return; }
    const cdx = e.clientX - dragClient.x, cdy = e.clientY - dragClient.y;
    if (!view.moved && Math.hypot(cdx, cdy) > 3) {
      view.moved = true;
      try { container.setPointerCapture(e.pointerId); } catch (_) {}
    }
    if (!view.moved) return;
    const p = svgPoint(e.clientX, e.clientY);
    const dx = p.x - dragOrigin.x, dy = p.y - dragOrigin.y;
    view.x = panOrigin.x + dx; view.y = panOrigin.y + dy; applyView();
  });
  // 节点单击/双击判定：native click/dblclick 会因拖动逻辑的 appendChild 重排
  // 触发「按下/抬起目标不一致」而偶发不合成，故在每次松手时用时间戳自行判定。
  // 单击 → 固定双链理解浮层（没有双链的节点也给浮层，里面写清「还没有建立双链」）；
  // 双击（同一节点 400ms 内第二次松手）→ 进入整理助手。
  let nodeTapLast = null;   // { id, at }
  const kbFlowHandleNodeTap = (id) => {
    const now = Date.now();
    if (nodeTapLast && nodeTapLast.id === id && now - nodeTapLast.at < 400) {
      nodeTapLast = null;
      unpinNotePanel();
      kbOpenNode(id);
      return;
    }
    nodeTapLast = { id, at: now };
    pinNotePanel(id, { allowEmpty: true });
  };
  const endPan = (e) => {
    if (dragNode) {
      const dragged = view.moved;
      const tapOpenId = !dragged && dragEl ? dragEl.dataset.nodeId : null;
      if (e && container.hasPointerCapture(e.pointerId)) container.releasePointerCapture(e.pointerId);
      container.classList.remove("kb-flow-node-dragging");
      if (dragEl) { dragEl.classList.remove("is-dragging"); dragEl = null; }
      if (tapOpenId) { container._kbNodeOpenGuardAt = Date.now(); kbFlowHandleNodeTap(tapOpenId); }
      // 松手：把子孙随带偏移固化进基准位置，父节点保留拖拽位置——
      // 拖动后停在新位置，不做猛烈回弹，方便观察层级带动。
      // 随后固化"原位惰性偏置"：把本次落点相对基准点净偏移的一部分(约30%)写进永久偏置 _hb，
      // 回位锚 = 基准 + _hb → 节点只象征性回到"基准与落点之间"，永远不会完全返回原位。
      if (dragNode && dragNode._flock) {
        for (const f of dragNode._flock.list) {
          const o = f.n;
          o.fx += (o.gx || 0); o.fy += (o.gy || 0);
          o.lx = o.fx; o.ly = o.fy;
          o.gx = 0; o.gy = 0;
        }
        dragNode.lx = dragNode.fx; dragNode.ly = dragNode.fy;
        dragNode.dx = 0; dragNode.dy = 0;
        // 惰性偏置固化前，先以拖后状态计算当前球心，供边缘叶子的回位基准使用
        let hgX = 0, hgY = 0, hgN = 0;
        nodes.forEach((nd) => { hgX += nd.fx; hgY += nd.fy; hgN++; });
        hgX /= hgN || 1; hgY /= hgN || 1;
        const applyHomeBias = (o) => {
          const h = kbFlowHomeOf(o, byId, hgX, hgY);
          const cap = 90 * Math.max(1, Math.min(2.6, KB_FLOW_GROW));
          // 0.3×净偏移 + 0.2×原偏置（缓释旧漂移，避免无限累积），钳到 cap 内
          o._hbx = Math.max(-cap, Math.min(cap, (o.fx - h.x) * 0.3 + (o._hbx || 0) * 0.2));
          o._hby = Math.max(-cap, Math.min(cap, (o.fy - h.y) * 0.3 + (o._hby || 0) * 0.2));
        };
        applyHomeBias(dragNode);
        for (const f of dragNode._flock.list) applyHomeBias(f.n);
        dragNode._flock = null;
      }
      // 松手后不再立刻抹掉高亮：真拖动时把「名字」留下来（kbFlowKeepNames），
      // 直到下一次拖动开始 / 按空白处 / hover 到别的节点才清除；
      // 拾起即松手（= 一次点击）不留存，照旧清除。
      if (dragNode) {
        if (dragged) kbFlowKeepNames(dragNode.id);
        else kbFlowFocus(dragNode.id, false);
      }
      // 海小棠记录：把本次拖动的节点名与关联节点写入本地最近拖动记录（语言已在拖动中组织，这里只落数据）
      if (dragged && dragNode) {
        const linkedNames = (linkById.get(dragNode.id) || [])
          .map((id) => (byId.get(id) || {}).name).filter(Boolean);
        const nick = dragNode.name || "这个节点";
        try {
          const rec = JSON.parse(localStorage.getItem("knoworigin_pet_recent_drags") || "[]");
          rec.unshift({ id: dragNode.id, name: nick, linked: linkedNames, ts: Date.now() });
          localStorage.setItem("knoworigin_pet_recent_drags", JSON.stringify(rec.slice(0, 20)));
        } catch (_) {}
      }
      dragNode = null; dragStart = null; dragLeash = null;
      container._justPanned = dragged;
      if (dragged) container._kbDragEndAt = Date.now();
      return;
    }
    if (!view.dragging) return;
    view.dragging = false;
    if (e && container.hasPointerCapture(e.pointerId)) container.releasePointerCapture(e.pointerId);
    container.classList.remove("kb-flow-panning");
    container._justPanned = !!view.moved;
  };
  container.addEventListener("pointerup", endPan);
  container.addEventListener("pointercancel", endPan);
  container.addEventListener("keydown", (e) => {
    if (["+", "="].includes(e.key)) setZoom(view.zoom * 1.2);
    else if (["-", "_"].includes(e.key)) setZoom(view.zoom / 1.2);
    else if (e.key === "0") overview();
    else return;
    e.preventDefault();
  });

  // —— 右侧浮层：列出某节点的双链邻居与已有理解 ——
  // 完整理解与「补写」入口都收在这个浮层里；单击节点 / 拖拽松手会「固定」它，
  // 之后指针移到别处也不再改变内容，直到点空画布、点关闭或双击进入整理助手。
  let notePanelTimer = null;
  let notePanelNodeId = null;
  let notePanelPinnedId = null;   // 固定中的节点 id：非空时浮层不受悬浮影响
  const hideNotePanelNow = () => {
    clearTimeout(notePanelTimer);
    const el = container.closest(".graph-wrap")?.querySelector(".kb-flow-note-panel");
    if (el) { el.hidden = true; el.innerHTML = ""; }
    notePanelNodeId = null;
  };
  const hideNotePanelSoon = (delay) => {
    clearTimeout(notePanelTimer);
    notePanelTimer = setTimeout(() => {
      if (notePanelPinnedId) return;   // 固定中不收起
      hideNotePanelNow();
    }, delay || 0);
  };
  const unpinNotePanel = () => {
    notePanelPinnedId = null;
    hideNotePanelNow();
  };
  const pinNotePanel = (id, opts) => {
    const linked = (linkById.get(id) || []).length;
    // 单击节点也要能看到浮层：没有双链的节点不再只弹一句右下角提示（用户会把那句
    // 「还没有双链连接」错读成「这个节点未建立」），改成浮层里就地说明缺席的原因。
    // allowEmpty 只有单击路径给：悬浮（hover）仍不打开展示空态的浮层，免得扫过节点就闪。
    if (!linked && (!opts || !opts.allowEmpty)) {
      if (!opts || !opts.silent) {
        showToast("这个节点还没有双链连接，双击可进入整理助手建立双链", { variant: "notice" });
      }
      return;
    }
    notePanelPinnedId = id;
    notePanelNodeId = id;
    showNotePanel(id, !linked);
  };
  const notePanelEl = () => {
    const wrap = container.closest(".graph-wrap") || container.parentElement;
    if (!wrap) return null;
    let el = wrap.querySelector(".kb-flow-note-panel");
    if (!el) {
      el = document.createElement("div");
      el.className = "kb-flow-note-panel";
      el.hidden = true;
      // 指针进浮层就取消收起：否则从节点挪到浮层上会先被 pointerout 收掉，点不到按钮
      el.addEventListener("pointerenter", () => clearTimeout(notePanelTimer));
      el.addEventListener("pointerleave", () => hideNotePanelSoon(220));
      // 标题栏可拖动：按住标题栏移动整块浮层（行按钮/关闭按钮不受影响）
      el.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        const head = e.target.closest ? e.target.closest(".kb-flow-note-head") : null;
        if (!head) return;
        if (e.target.closest && e.target.closest(".kb-flow-note-close")) return;
        const rect = el.getBoundingClientRect();
        const wrect = wrap.getBoundingClientRect();
        const startX = e.clientX, startY = e.clientY;
        const startLeft = rect.left - wrect.left;
        const startTop = rect.top - wrect.top;
        let dragging = false;
        const onMove = (ev) => {
          if (!dragging) {
            if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 3) return;
            dragging = true;
            clearTimeout(notePanelTimer);   // 拖动中不因 pointerleave 收起浮层
            el.style.left = `${startLeft}px`;
            el.style.top = `${startTop}px`;
            el.style.right = "auto";
            el.classList.add("is-dragging");
            try { el.setPointerCapture(ev.pointerId); } catch (_) {}
          }
          const nx = Math.max(0, Math.min(startLeft + (ev.clientX - startX), wrect.width - rect.width));
          const ny = Math.max(0, Math.min(startTop + (ev.clientY - startY), wrect.height - rect.height));
          el.style.left = `${nx}px`;
          el.style.top = `${ny}px`;
        };
        const onUp = () => {
          el.classList.remove("is-dragging");
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        e.preventDefault();
      });
      wrap.appendChild(el);
    }
    return el;
  };
  const showNotePanel = (id, allowEmpty) => {
    const el = notePanelEl();
    if (!el) return;
    const n = byId.get(id);
    const neighborIds = linkById.get(id) || [];
    if (!n) { hideNotePanelSoon(0); return; }
    if (!neighborIds.length && !allowEmpty) { hideNotePanelSoon(0); return; }
    clearTimeout(notePanelTimer);
    notePanelNodeId = id;
    // 每条双链一行：明说「双链已建立」，缺的只是这句理解 —— 行里只剩「还没有写理解」时，
    // 用户会误以为这条双链本身没建起来。
    const rows = neighborIds.length ? neighborIds.map((nid) => {
      const nb = byId.get(nid);
      if (!nb) return "";
      const note = kbLinkNoteOf(id, nid);
      return `<button type="button" class="kb-flow-note-row${note ? "" : " is-empty"}" data-a="${escapeAttr(id)}" data-b="${escapeAttr(nid)}">
          <span class="kb-flow-note-who">${escapeHtml(nb.name)}</span>
          <span class="kb-flow-note-body">${note ? escapeHtml(note) : "双链已建立 · 理解还没写，点这里写一句"}</span>
        </button>`;
    }).join("") : `<button type="button" class="kb-flow-note-row is-empty" data-kb-note-none="1">
          <span class="kb-flow-note-who">还没有建立双链</span>
          <span class="kb-flow-note-body">点这里进整理助手，为它牵上双链后就能写理解</span>
        </button>`;
    el.innerHTML = `
      <div class="kb-flow-note-head">
        <span class="kb-flow-note-title">「${escapeHtml(n.name)}」的双链理解</span>
        <span class="kb-flow-note-count">${neighborIds.length} 条</span>
        <button type="button" class="kb-flow-note-close" aria-label="关闭">×</button>
      </div>
      <div class="kb-flow-note-list">${rows}</div>`;
    el.hidden = false;
    el.querySelectorAll(".kb-flow-note-row").forEach((b) => {
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (b.dataset.kbNoteNone) { unpinNotePanel(); kbOpenNode(id); return; }
        kbOpenLinkNoteEditor(b.dataset.a, b.dataset.b);
      });
    });
    const closeBtn = el.querySelector(".kb-flow-note-close");
    if (closeBtn) closeBtn.addEventListener("click", (ev) => { ev.stopPropagation(); unpinNotePanel(); });
  };

  // 编辑弹框保存后：双链理解不再贴在图谱连线上，只需刷新右侧浮层里的理解文案。
  kbFlowNoteSync = (a, b, note) => {
    if (!container.isConnected) return;
    if (notePanelNodeId) showNotePanel(notePanelNodeId);
  };

  const kbFlowFocus = (id, active) => {
    const neighbors = new Set(linkById.get(id) || []);
    nodeEls.forEach((g) => {
      const nid = g.dataset.nodeId;
      g.classList.toggle("is-focus", active && nid === id);
      g.classList.toggle("is-neighbor", active && neighbors.has(nid));
      // 名字显隐：默认全隐藏，仅悬浮节点 + 它的直接子级（围抱环）+ 与它双链关联的节点显示
      g.classList.toggle("is-revealed", active && (nid === id || parentOf.get(nid) === id || neighbors.has(nid)));
      g.classList.toggle("is-dimmed", active && !(nid === id || neighbors.has(nid)));
    });
    linkEls.forEach(({ el, a, b }) => {
      const hit = a === id || b === id;
      el.classList.toggle("is-active", active && hit);
      el.classList.toggle("is-dimmed", active && !hit);
    });
    // 浮层显隐：固定后不受悬浮影响（指针移到别处也不改变内容）
    if (active) {
      if (!notePanelPinnedId) showNotePanel(id);
    } else if (!notePanelPinnedId) {
      hideNotePanelSoon(240);
    }
  };
  // —— 拖动结束后「留住名字」 ——
  // 拖动中 kbFlowFocus 把被拖节点 + 双链邻居 + 父子点亮（is-focus / is-neighbor / is-revealed），
  // 其余节点压暗（is-dimmed）、相关连线转紫（is-active）。松手时用户仍想看清刚拖的是谁，
  // 所以只把「名字」留下来：保留 is-revealed（它本身就覆盖自己 + 父子 + 双链邻居），
  // 其余强调与压暗的拖拽态一律复原 —— 不是整张图停在拖拽态，而是名字继续挂着。
  const kbFlowKeepNames = (id) => {
    nodeEls.forEach((g) => g.classList.remove("is-dimmed", "is-focus", "is-neighbor"));
    linkEls.forEach(({ el }) => el.classList.remove("is-active", "is-dimmed"));
    dragFocusKeep = id;
    // 拖拽松手后固定浮层：指针移开也不收起，照着浮层核对/补写关系（无邻居则不固定）。
    pinNotePanel(id, { silent: true });
  };
  // 清除上一轮拖动的留存（名字显隐 + 邻居/自身高亮），恢复到无聚焦状态
  const kbFlowDropKeep = () => {
    if (!dragFocusKeep) return;
    kbFlowFocus(dragFocusKeep, false);
    dragFocusKeep = null;
  };

  container.addEventListener("pointerover", (e) => {
    if (dragNode) return;   // 拖拽中锁定被拖高亮，不被 hover 覆盖
    const g = e.target.closest ? e.target.closest(".kb-flow-node") : null;
    if (!g) return;
    // 留存中的节点：名字已经挂着，不再重新聚焦 —— 否则会把「其余节点压暗 + 连线转紫」
    // 的拖拽态又带回来（松手后指针往往还停在这个节点上，会立刻踩到）
    if (dragFocusKeep === g.dataset.nodeId) return;
    // hover 到别的节点：上一轮拖动的留存就此作废（视觉已被新的聚焦接管）
    if (dragFocusKeep) kbFlowDropKeep();
    kbFlowFocus(g.dataset.nodeId, true);
  });
  container.addEventListener("pointerout", (e) => {
    if (dragNode) return;   // 拖拽中不因指针离开而清除高亮
    const g = e.target.closest ? e.target.closest(".kb-flow-node") : null;
    if (!g) return;
    // 留存态：指针从上一个被拖节点上移开也不清除，名字继续挂到下一次拖动
    if (dragFocusKeep === g.dataset.nodeId) return;
    kbFlowFocus(g.dataset.nodeId, false);
  });
  container.addEventListener("click", (e) => {
    e.stopPropagation();
    if (container._justPanned === true) { container._justPanned = false; return; }
    // 点连线 = 写/改这两个知识点之间的理解（命中区是加粗透明线，细线本身也接）
    const linkEl = e.target.closest ? e.target.closest(".kb-flow-link-hit, .kb-flow-link") : null;
    if (linkEl && linkEl.dataset.src && linkEl.dataset.tgt) {
      e.preventDefault();
      kbOpenLinkNoteEditor(linkEl.dataset.src, linkEl.dataset.tgt);
      return;
    }
    if (Date.now() - (container._kbNodeOpenGuardAt || 0) < 400) { container._kbNodeOpenGuardAt = 0; return; }
    const g = e.target.closest ? e.target.closest(".kb-flow-node") : null;
    if (g) { container._kbNodeOpenGuardAt = Date.now(); kbFlowHandleNodeTap(g.dataset.nodeId); return; }
    // 主界面（非全屏）下点击图谱空白处 → 取消固定浮层并展开学习产出进入知识框架全屏（与脑图视图一致）
    unpinNotePanel();
    if (!state.studioFocus && !state.studioFocusClosing) {
      expandStudio(container.closest(".graph-wrap") || container);
    }
  });
  container.addEventListener("dblclick", (e) => {
    // 双击节点由 kbFlowHandleNodeTap（松手时间戳判定）处理，这里只负责双击空白放大画布。
    if (e.target.closest && e.target.closest(".kb-flow-node")) return;
    // 刚拖拽完节点后的一对 click 不应触发画布缩放
    if (Date.now() - (container._kbDragEndAt || 0) < 350) return;
    e.preventDefault();
    setZoom(view.zoom * 1.28, svgPoint(e.clientX, e.clientY));
  });
  container.addEventListener("focusin", (e) => {
    if (dragNode) return;   // 拖拽中锁定高亮
    const g = e.target.closest ? e.target.closest(".kb-flow-node") : null;
    if (g) kbFlowFocus(g.dataset.nodeId, true);
  });
  container.addEventListener("focusout", (e) => {
    if (dragNode) return;   // 拖拽中锁定高亮
    const g = e.target.closest ? e.target.closest(".kb-flow-node") : null;
    if (g) kbFlowFocus(g.dataset.nodeId, false);
  });

  // 工具栏动作
  container.closest(".framework-view")?.querySelectorAll("[data-kb-graph-action]").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const a = b.dataset.kbGraphAction;
      if (a === "zoom-in") setZoom(view.zoom * 1.2);
      else if (a === "zoom-out") setZoom(view.zoom / 1.2);
      else if (a === "overview") overview();
      else if (a === "relayout") { kbFlowPaused = false; kbFlowInit(container); }
      else if (a === "pause") {
        kbFlowPaused = !kbFlowPaused;
        b.textContent = kbFlowPaused ? "▶" : "⏸";
        b.title = kbFlowPaused ? "恢复流动" : "暂停流动";
      }
    });
  });

  // 节点的最终绘制坐标 = 基准位置 fx/fy + 水波浮动与双链牵引偏置 dx/dy + 层级带动随位偏置 gx/gy
  // + 拖拽中的"上浮"层次感（被拖节点微微浮起，制造离开画布的立体感）。
  // 连线端点与节点本体都必须走这里取值：早先连线只取 fx+dx，漏了拖拽父级时子孙的随带位移 gx/gy，
  // 于是拖动一个带子树的节点时，子孙跟着走了、连向它们的线却留在原地（线与节点脱离）。
  const DRAG_LIFT_Y = -2.5;
  const drawPos = (n) => ({
    x: n.fx + (n.dx || 0) + (n.gx || 0),
    y: n.fy + (n.dy || 0) + (n.gy || 0) + (n === dragNode ? DRAG_LIFT_Y : 0),
  });

  let t = 0;
  const frame = () => {
    // 视图切走或 DOM 被重建时自行停止动画循环，避免后台空转
    if (!container.isConnected || getComputedStyle(container).display === "none") {
      cancelAnimationFrame(kbFlowRaf);
      return;
    }
    t += 0.016;
    // 尘埃流动：缓慢环绕漂移 + 呼吸闪烁，铺满画布两侧留白
    for (const p of dustPart) {
      p.t += 0.016;
      const ang = p.t * p.sp * 0.11 + p.ph;
      p.x += Math.cos(ang) * p.sp * 0.22 - p.sp * 0.05;
      p.y += Math.sin(p.t * 0.001 + p.ph) * p.sp * 0.14;
      if (p.x < worldX - DUST_MX - 5) p.x = worldX + worldW + DUST_MX + 5;
      if (p.x > worldX + worldW + DUST_MX + 5) p.x = worldX - DUST_MX - 5;
      if (p.y < worldY - DUST_MY - 5) p.y = worldY + worldH + DUST_MY + 5;
      if (p.y > worldY + worldH + DUST_MY + 5) p.y = worldY - DUST_MY - 5;
      const tw = Math.sin(p.t * p.sp * 1.6 + p.ph) * 0.5 + 0.5;
      p.c.setAttribute("cx", String(p.x));
      p.c.setAttribute("cy", String(p.y));
      p.h.setAttribute("cx", String(p.x));
      p.h.setAttribute("cy", String(p.y));
      p.c.style.opacity = String((p.vis * (0.6 + 0.4 * tw)).toFixed(3));
      p.h.style.opacity = String((p.vis * 0.28 * (0.5 + 0.5 * tw)).toFixed(3));
    }
    // 名字默认隐藏，仅悬浮节点及其子级显示；不再按缩放批量显示
    if (dragNode) {
      kbFlowDragSim(dragNode, nodes, linkById, byId);
      nodes.forEach((n) => {
        n.drawR = n === dragNode ? (n.r3 || n.baseR) * 1.4 : (n.r3 || n.baseR) * (1 + 0.18 * Math.sin(t * n.speed * 0.5 + n.phase));
      });
    } else if (!kbFlowPaused) {
      // 水波/呼吸（视觉生机层：围绕 fx 的 dx/dy 抖动 + 呼吸缩放）
      nodes.forEach((n) => {
        n.lx += (n.fx - n.lx) * 0.1;
        n.ly += (n.fy - n.ly) * 0.1;
        n.dx = (n.lx - n.fx) + Math.sin(t * n.speed * 0.7 + n.phase * 1.1) * n.amp * 0.35 + Math.sin(t * n.speed * 2.3 + n.phase * 0.7) * n.wob * 0.3;
        n.dy = (n.ly - n.fy) + Math.sin(t * n.speed + n.phase) * n.amp + Math.sin(t * n.speed * 3.1 + n.phase * 1.7) * n.amp * 0.22 + Math.sin(t * n.speed * 5.3 + n.phase * 0.4) * n.wob * 0.35;
        n.drawR = (n.r3 || n.baseR) * (1 + 0.18 * Math.sin(t * n.speed * 0.5 + n.phase));
      });
      // 动态隐形球心 = 当前节点质心（父级被拖走后球心跟随，自生长圆的圆心始终贴合家族）
      let gcX = 0, gcY = 0, gcN = 0;
      nodes.forEach((n) => { gcX += n.fx; gcY += n.fy; gcN++; });
      gcX /= gcN || 1; gcY /= gcN || 1;
      // 三重回位锚 + 原位惰性：按首选项分组施加回位力
      //   ① 边缘叶子 → 围抱在"球心周围圆环"上（不转动，静态围抱）
      //   ② 非边缘子级 → 围绕父级极坐标锚（父动子随，始终对称围抱父级在中心）
      //   ③ 根/悬浮 → 弱引力流回绝对原位
      // 每类都"回位到 基准+_hb"，_hb 为拖拽后固化的永久偏置 → 只象征性回半程，不全回原位
      nodes.forEach((n) => {
        let tx, ty, kPull;
        if (n._edge) {
          const rr = n._orbitR || n._ringR || 1;
          tx = gcX + Math.cos(n._ang0 || 0) * rr + n._hbx;
          ty = gcY + Math.sin(n._ang0 || 0) * rr + n._hby;
          kPull = 0.05;                                 // 优先①：强拉回圆环（静态围抱，不公转）
        } else if (n.parentId) {
          const P = byId.get(n.parentId);
          if (P) {
            tx = P.fx + Math.cos(n._relAng || 0) * (n._relR || 0) + n._hbx;
            ty = P.fy + Math.sin(n._relAng || 0) * (n._relR || 0) + n._hby;
            kPull = 0.032;                             // 优先②：对称环绕父级
          } else { tx = n.fx + n._hbx; ty = n.fy + n._hby; kPull = 0.0; }
        } else {
          tx = (n._home ? n._home.x : n.fx) + n._hbx;
          ty = (n._home ? n._home.y : n.fy) + n._hby;
          kPull = 0.018;                               // 优先③：根回原位
        }
        n.fx += (tx - n.fx) * kPull;
        n.fy += (ty - n.fy) * kPull;
      });
      // 圆形缝隙自愈：最外环叶子在球心圆环上角度均布，某段边缘被拖走出现空缺时，
      // 相邻叶子沿切向缓缓滑入弥合，另一侧缺口又由后续叶子填补 → 自生长、永不缺角的隐形球边缘
      {
        const leaves = nodes.filter((n) => n._edge);
        if (leaves.length >= 3) {
          const items = leaves.map((n) => {
            const dx = n.fx - gcX, dy = n.fy - gcY;
            return { n, ang: Math.atan2(dy, dx), rr: Math.hypot(dx, dy) || 1 };
          });
          items.sort((p, q) => p.ang - q.ang);
          const ideal = Math.PI * 2 / items.length;
          const along = (n, cur, tgt, rr, k) => {
            let d = tgt - cur;
            d = ((d + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
            if (Math.abs(d) < 1e-4) return;
            const s = rr * d * k;                      // 沿圆周切向滑入的弧长
            n.fx += -Math.sin(cur) * s; n.fy += Math.cos(cur) * s;
            // 同步推进方位角，使"回位锚"也指向愈合后的位置，二者不再互相抵消
            n._ang0 = n._ang0 + s / rr;
          };
          for (let i = 0; i < items.length; i++) {
            const a = items[i], b = items[(i + 1) % items.length];
            let gap = b.ang - a.ang; if (gap <= 0) gap += Math.PI * 2;
            if (gap <= ideal * 2.0) continue;                         // 正常/轻微空隙(含游走节点晃动)不补位；
                                                                      // 只有真正被拖走出现的大缺口才触发自愈
            const mid = a.ang + gap / 2;
            const kp = Math.min(0.03, (gap - ideal) * 0.004);         // 象征性的轻量补位
            along(a.n, a.ang, mid, a.rr, kp);
            along(b.n, b.ang, mid, b.rr, kp);
          }
        }
      }
      // 碰撞间距按"屏幕尺度"换算：缩得越小，节点被最小尺寸补偿放大得越厉害，
      // 若仍按原始半径判碰撞，屏幕上就会糊成一团。这里保证屏幕上中心距 ≥ 30px，
      // 于是节点一多/一密，整簇就被自己撑开 —— 大圆随规模自生长（上限 KB_FLOW_GAP×2.6，
      // 避免极端缩放下间距被反推成天文数字导致整簇炸开）。
      const zNow = Math.max(1e-3, view.zoom * svgScale);
      const gapNow = Math.min(KB_FLOW_GAP * 2.6, Math.max(KB_FLOW_GAP, 30 / zNow));
      // 碰撞弹开 + 轻微切向旋转：叶子/子级相遇像细胞质那样错开
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const ddx = (b.fx + b.dx) - (a.fx + a.dx), ddy = (b.fy + b.dy) - (a.fy + a.dy);
        const d2 = ddx * ddx + ddy * ddy;
        // 再叠加两节点自身半径：双链越多的节点越"胖"，需要更大呼吸空间，否则枢纽盖住邻居
        const gapAB = gapNow + ((a.baseR || 4) + (b.baseR || 4)) * 0.5;
        if (d2 >= gapAB * gapAB) continue;
        const d = Math.sqrt(d2) || 1;
        const rep = (gapAB - d) / gapAB;
        const push = 3 * Math.min(2.6, Math.max(1, gapNow / 14));
        const pux = ddx / d, puy = ddy / d;
        a.dx -= pux * rep * push; a.dy -= puy * rep * push;
        b.dx += pux * rep * push; b.dy += puy * rep * push;
        const spin = rep * 1.4 * Math.min(2, Math.max(1, gapNow / 14)) * ((i * 7 + j * 13) % 2 === 0 ? 1 : -1);
        const tnx = -puy, tny = pux;
        a.dx -= tnx * spin; a.dy -= tny * spin;
        b.dx += tnx * spin; b.dy += tny * spin;
      }
      // 阻尼：削弱碰撞累积偏移，使节点贴合各自的回位锚（不飘散、圆不回弹）
      nodes.forEach((n) => { n.dx *= 0.985; n.dy *= 0.985; });
    }
    // 无固定边界：簇由最外层叶子自然围成圆形，允许节点自由错落与游走
    // 连线水波振荡与粗细呼吸
    linkEls.forEach(({ el, hit, a, b, phase }) => {
      const na = byId.get(a), nb = byId.get(b);
      const pa = drawPos(na), pb = drawPos(nb);
      const ax = pa.x, ay = pa.y;
      const bx = pb.x, by = pb.y;
      // 连线弧度随大圆一起放大：圆越大、线越长，弓起得越明显，多线并行时不再糊成一团
      const bow = 4.2 * Math.min(2.4, Math.max(1, KB_FLOW_GROW * 0.7));
      const mx = (ax + bx) / 2, my = (ay + by) / 2 + Math.sin(t * 2.2 + phase) * bow;
      const d = `M ${ax} ${ay} Q ${mx} ${my} ${bx} ${by}`;
      el.setAttribute("d", d);
      // 命中区跟着同一条路径走，否则拖完节点后点击位置和视觉连线对不上
      hit.setAttribute("d", d);
      // 高亮线（is-active）在这里一并加粗：本行逐帧写内联 stroke-width，内联优先于
      // 样式表（非 !important），所以 CSS 里给 .is-active 写 stroke-width 永远无效——
      // 悬停/拖拽时只有颜色变、线条不变粗。加粗必须在逐帧这一步按 class 补偿。
      const linkOn = el.classList.contains("is-active");
      el.style.strokeWidth = String(el._kbSW * (linkOn ? 2.6 : 1) * (1 + 0.2 * Math.sin(t * 2 + phase)));
    });
    nodeEls.forEach((g) => {
      const n = byId.get(g.dataset.nodeId);
      const flowDark = document.documentElement.getAttribute("data-theme") === "dark";
      // 节点越多，单个节点的最小屏幕半径越小（7.5 → 6.5 → 5.5），给彼此留出可见间隙
      const minNodePx = nodes.length > 120 ? 5.5 : nodes.length > 60 ? 6.5 : 7.5;
      const draggingThis = g.classList.contains("is-dragging");
      // 位置（含拖拽上浮）与连线端点同源：见 drawPos
      const pos = drawPos(n);
      g.setAttribute("transform", `translate(${pos.x} ${pos.y})`);
      // Obsidian：悬停时邻节点放大——刻意在逐帧 transform 里放大，避免被 CSS transform 覆盖
      const zoomN = g.classList.contains("is-neighbor") ? 1.32 : 1;
      // 最小屏幕尺寸补偿：屏幕 = SVG 单位 × svgScale × zoom。窄视口整图适配
      // （zoom 可低至 0.2，svgScale 约 0.16）后节点/标签缩成 1-2px 不可辨，
      // 必须按 屏幕缩放 = svgScale × zoom 反推放大系数，
      // 保证节点屏幕半径 ≥ minNodePx、标签屏幕字号 ≥ 11.5px（漏乘 svgScale 会低估补偿 6 倍）
      // minNodePx 随规模下调：节点极多时若都保 7.5px，放大后的圆点会互相盖住，
      // 宁可小一点也要留出间隙 —— 与上面 30px 的屏幕碰撞间距配套。
      const zSafe = Math.max(view.zoom * svgScale, 1e-3);
      const kMin = Math.max(1, minNodePx / ((n.r3 || n.baseR || 4) * zSafe));
      const dispR = (n.drawR || n.r3 || n.baseR || 4) * kMin;
      const heart = dispR * 0.68 * zoomN;
      const glowEl = g.querySelector(".kb-flow-glow");
      if (glowEl) {
        const gr = dispR * 1.5 * zoomN;
        glowEl.setAttribute("r", String(gr));
        glowEl.setAttribute("opacity", String(g.classList.contains("is-dimmed") ? 0.08 : 0.55));
      }
      g.querySelector(".kb-flow-dot").setAttribute("r", heart);
      g.querySelector(".kb-flow-dot-mid").setAttribute("r", Math.max(1, heart * 0.42));
      if (g.classList.contains("is-neighbor")) g.querySelector(".kb-flow-dot").setAttribute("fill", flowDark ? "#cfe6fb" : "#3f78c2");
      else if (g.classList.contains("is-focus")) g.querySelector(".kb-flow-dot").setAttribute("fill", flowDark ? "#ffffff" : "#2a5f9c");
      else g.querySelector(".kb-flow-dot").setAttribute("fill", g.querySelector(".kb-flow-dot").dataset.defaultFill);
      const ring = g.querySelector(".kb-flow-ring");
      ring.setAttribute("r", n.lit === "lit" ? dispR * 2.6 : 0);
      ring.setAttribute("opacity", n.lit === "lit" ? 0.35 + 0.2 * Math.sin(t * 2 + n.phase) : 0);
      const flake = g.querySelector(".kb-flow-snowflake");
      if (flake) flake.setAttribute("transform", `rotate(${(Math.sin(t * 0.35 + n.phase * 2.2) * 6).toFixed(2)}) scale(${kMin.toFixed(3)})`);
      const labelEl = g.querySelector(".kb-flow-label");
      if (labelEl) {
        // 掌握度层级比例（对应原 13.5/12.2/11px），内联样式压过 .is-* 类的 font-size，
        // 保证屏幕字号 ≥ 11.5px（CSS 固定字号会被 g 的 svgScale×zoom 缩放成尘埃）
        const mkR = n.mastery >= 0.66 ? 1.23 : (n.mastery >= 0.33 ? 1.06 : 0.96);
        // 悬停(pointerover 已置 is-focus)时节点名放大 ~1.5×，配合 CSS 提亮描边更清晰醒目
        const hoverK = g.classList.contains("is-focus") ? 1.5 : 1;
        labelEl.style.fontSize = `${Math.max(12, 11.5 * mkR * hoverK / zSafe).toFixed(1)}px`;
        labelEl.setAttribute("y", String(-(dispR + 13 / zSafe) + (n.dep || 0) * 7));
      }
      const hitEl = g.querySelector(".kb-flow-hit");
      if (hitEl) hitEl.setAttribute("r", String(Math.max(dispR * 1.9, 8 / zSafe)));
      const body = g.querySelector(".kb-flow-body");
      if (body) {
        // 挤压与拉伸 + 左右轻摆：像浮在水面的活物随水流起伏
        const vel = (n.dy || 0) - (n.pdy || n.dy || 0);
        const stretch = Math.max(-0.09, Math.min(0.09, vel * 0.05));
        const breath = 0.045 * Math.sin(t * n.speed * 1.3 + n.phase * 2);
        const tilt = Math.sin(t * n.speed * 0.9 + n.phase) * (n.tilt || 4);
        const dsc = draggingThis ? 1.16 : 1;
        body.setAttribute("transform", `rotate(${tilt.toFixed(2)}) scale(${((1 - stretch * 0.55 + breath) * dsc).toFixed(3)} ${((1 + stretch + breath * 0.6) * dsc).toFixed(3)})`);
        n.pdy = n.dy;
      }
    });
    kbFlowRaf = requestAnimationFrame(frame);
  };
  kbFlowRaf = requestAnimationFrame(frame);
  overview();
  // 大图被裁：给一句提示，免得用户以为图谱残缺（7 秒后自行淡出，不打扰）
  if (flowCropped && links.length) {
    kbFlowOverlay(container, "crop");
    const ov = container.closest(".graph-wrap")?.querySelector(".kb-flow-overlay-crop");
    if (ov) {
      ov.style.transition = "opacity .8s ease";
      setTimeout(() => { ov.style.opacity = "0"; }, 6200);
      setTimeout(() => { ov.remove(); }, 7200);
    }
  }
  // 神经脉冲流动层（独立文件 static/kb-flow-pulse.js，自带 rAF，不进本函数的主循环）
  window.KbFlowPulse?.attach(container);
}

// 双链图谱渲染异常时的兜底展示（避免空白区域让用户以为卡死）
function kbFlowRenderError(container) {
  if (!container) return;
  cancelAnimationFrame(kbFlowRaf);
  container.innerHTML = "";
  const ns = "http://www.w3.org/2000/svg";
  const g = document.createElementNS(ns, "g");
  g.setAttribute("class", "kb-flow-error");
  const tx = document.createElementNS(ns, "text");
  tx.setAttribute("x", KB_FLOW_W / 2);
  tx.setAttribute("y", KB_FLOW_H / 2 - 8);
  tx.setAttribute("text-anchor", "middle");
  tx.textContent = "双链图谱暂时无法渲染";
  const sub = document.createElementNS(ns, "text");
  sub.setAttribute("x", KB_FLOW_W / 2);
  sub.setAttribute("y", KB_FLOW_H / 2 + 18);
  sub.setAttribute("text-anchor", "middle");
  sub.textContent = "可切回「脑图」继续浏览知识框架";
  g.appendChild(tx); g.appendChild(sub);
  container.appendChild(g);
}

/* ==================== 双链「理解」编辑弹框 ==================== */
// 一对双链共享一句「理解」：图谱上点连线、或点右侧浮层里的邻居条目都会到这里。
// AI 只负责起草草稿，落库一律要用户按「保存」——避免模型编出来的关系被当成事实存进库。
function kbOpenLinkNoteEditor(aId, bId) {
  if (!aId || !bId || aId === bId) return;
  const dialog = $("#link-note-dialog");
  const form = $("#link-note-form");
  if (!dialog || !form) return;
  const a = (state.nodes || []).find((n) => n.node_id === aId);
  const b = (state.nodes || []).find((n) => n.node_id === bId);
  if (!a || !b) return;
  form.dataset.a = aId;
  form.dataset.b = bId;
  $("#link-note-pair").innerHTML = `<span class="link-note-node">${escapeHtml(a.name)}</span><i class="link-note-arrow" aria-hidden="true">⇄</i><span class="link-note-node">${escapeHtml(b.name)}</span>`;
  const existing = kbLinkNoteOf(aId, bId);
  $("#link-note-input").value = existing;
  const status = $("#link-note-status");
  status.textContent = "";
  status.className = "link-note-status";
  const delBtn = $("#link-note-delete");
  if (delBtn) delBtn.hidden = !existing;
  const aiBtn = $("#link-note-ai");
  if (aiBtn) aiBtn.disabled = false;
  if (!dialog.open) dialog.showModal();
  setTimeout(() => $("#link-note-input").focus(), 30);
}

// 保存（note 为空串 = 删除这条理解）：PUT 落库 → 本地状态 → 右侧浮层同步
async function kbSubmitLinkNote(aId, bId, note, statusEl) {
  const status = statusEl || $("#link-note-status");
  await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/link-notes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ a_node_id: aId, b_node_id: bId, note }),
  });
  kbFlowSetLinkNoteLocal(aId, bId, note);
}

async function saveLinkNote(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const aId = form.dataset.a, bId = form.dataset.b;
  if (!aId || !bId) return;
  const note = String($("#link-note-input").value || "").trim().slice(0, 500);
  const status = $("#link-note-status");
  const saveBtn = $("#link-note-save");
  saveBtn.disabled = true;
  status.textContent = "保存中…";
  status.className = "link-note-status";
  try {
    await kbSubmitLinkNote(aId, bId, note, status);
    status.textContent = note ? "已保存，图谱上的理解已更新" : "已删除这条理解";
    status.classList.add("is-ok");
    const delBtn = $("#link-note-delete");
    if (delBtn) delBtn.hidden = !note;
    showToast(note ? "已保存双链理解" : "已删除双链理解", { variant: "notice" });
    setTimeout(() => { const d = $("#link-note-dialog"); if (d && d.open) d.close(); }, 420);
  } catch (error) {
    status.textContent = error.message || "保存失败，请重试";
    status.classList.add("is-error");
  } finally {
    saveBtn.disabled = false;
  }
}

async function deleteLinkNote() {
  const form = $("#link-note-form");
  const aId = form && form.dataset.a, bId = form && form.dataset.b;
  if (!aId || !bId) return;
  const status = $("#link-note-status");
  const delBtn = $("#link-note-delete");
  delBtn.disabled = true;
  status.textContent = "删除中…";
  status.className = "link-note-status";
  try {
    await kbSubmitLinkNote(aId, bId, "", status);
    $("#link-note-input").value = "";
    delBtn.hidden = true;
    status.textContent = "已删除这条理解";
    status.classList.add("is-ok");
    showToast("已删除双链理解", { variant: "notice" });
    setTimeout(() => { const d = $("#link-note-dialog"); if (d && d.open) d.close(); }, 420);
  } catch (error) {
    status.textContent = error.message || "删除失败，请重试";
    status.classList.add("is-error");
  } finally {
    delBtn.disabled = false;
  }
}

async function suggestLinkNote() {
  const form = $("#link-note-form");
  const aId = form && form.dataset.a, bId = form && form.dataset.b;
  if (!aId || !bId) return;
  const btn = $("#link-note-ai");
  const status = $("#link-note-status");
  const input = $("#link-note-input");
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span> AI 正在读这两个知识点…';
  status.textContent = "";
  status.className = "link-note-status";
  try {
    const res = await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/link-notes/suggest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a_node_id: aId, b_node_id: bId, hint: String(input.value || "").trim().slice(0, 200) }),
    });
    const note = String((res && res.note) || "").trim();
    if (!note) throw new Error("AI 没能给出可用的理解，请自己写一句或重试。");
    input.value = note;
    const basisText = { note: "依据你的笔记", description: "依据节点说明", name: "只依据节点名称" }[res.basis] || "";
    status.textContent = `AI 草稿已填入（${basisText || "依据节点信息"}），改完再点「保存」`;
    status.classList.add("is-ok");
    input.focus();
  } catch (error) {
    status.textContent = error.message || "AI 起草失败，请重试";
    status.classList.add("is-error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

function bindLinkNoteDialog() {
  const form = $("#link-note-form");
  if (!form) return;
  form.addEventListener("submit", saveLinkNote);
  const aiBtn = $("#link-note-ai");
  if (aiBtn) aiBtn.addEventListener("click", suggestLinkNote);
  const delBtn = $("#link-note-delete");
  if (delBtn) delBtn.addEventListener("click", deleteLinkNote);
}

/* ==================== 个人知识库（Obsidian 式·前端） ==================== */
function kbNodeVisible(n) {
  const q = (state.kbQuery || "").trim().toLowerCase();
  if (q) {
    const hay = [n.name, n.description || "", n.note_content || "", (n.tags || []).join(" ")]
      .map((s) => String(s).toLowerCase());
    if (!hay.some((s) => s.includes(q))) return false;
  }
  if (state.kbActiveTag && !(n.tags || []).includes(state.kbActiveTag)) return false;
  return true;
}

function kbRenderFiltered() {
  const backup = state.nodes;
  state.nodes = backup.filter(kbNodeVisible);
  const caret = kbSearchCaret;
  try { renderFramework(); }
  finally {
    state.nodes = backup;
    if (caret != null) {
      const inp = document.querySelector(".kb-search-input");
      if (inp) { inp.focus(); try { inp.setSelectionRange(caret, caret); } catch (_) {} }
    }
  }
  kbSearchCaret = null;
}

let kbSearchCaret = null;
let kbSearchTimer = 0;

function kbExtractWikilinks(text) {
  const out = [];
  const re = /\[\[([^\[\]]+?)\]\]/g;
  let m;
  while ((m = re.exec(String(text || "")))) {
    const nm = (m[1].split("|")[0] || "").trim();
    if (nm && !out.includes(nm)) out.push(nm);
  }
  return out;
}

function kbGetDock() { return document.querySelector("[data-kb-dock]"); }

// Esc 关闭悬浮的整理助手/笔记面板（仅在面板可见且无其它弹窗时生效）
function handleKbDockEscapeKeydown(event) {
  if (event.key !== "Escape") return;
  const openDialog = [...document.querySelectorAll("dialog")].find((d) => d.open);
  if (openDialog) return;
  const zoomOv = document.querySelector("[data-kb-prop-zoom]");
  if (zoomOv && !zoomOv.hidden) {
    event.preventDefault();
    kbClosePropZoom();
    return;
  }
  const overlay = document.querySelector("[data-kb-proposals-overlay]");
  if (overlay && !overlay.hidden) {
    event.preventDefault();
    overlay.hidden = true;
    document.body.classList.remove("kb-overlay-open");
    return;
  }
  const dock = kbGetDock();
  if (dock && !dock.hidden) {
    event.preventDefault();
    dock.hidden = true;
    state.kbNodeId = "";
    refreshQuestionRails();
  }
}

function kbBindNav(output) {
  const search = output.querySelector(".kb-search-input");
  if (search) {
    search.addEventListener("input", () => {
      state.kbQuery = search.value.trim();
      kbSearchCaret = search.selectionStart;
      clearTimeout(kbSearchTimer);
      kbSearchTimer = setTimeout(kbRenderFiltered, 260);
    });
    const clear = output.querySelector("[data-kb-action='clear-search']");
    if (clear) clear.addEventListener("click", () => { state.kbQuery = ""; kbRenderFiltered(); });
  }
  output.querySelectorAll("[data-kb-tag]").forEach((chip) => {
    chip.addEventListener("click", () => {
      state.kbActiveTag = chip.dataset.kbTag || "";
      kbRenderFiltered();
    });
  });
  const exportBtn = output.querySelector("[data-kb-action='export']");
  if (exportBtn) exportBtn.addEventListener("click", kbExportVault);
}

function kbBindDock(output) {
  const dock = output.querySelector("[data-kb-dock]");
  if (!dock) return;
  const agentPane = dock.querySelector("[data-kb-pane='agent']");
  if (agentPane) agentPane.innerHTML = kbAgentPaneMarkup();
  bindAgentPane(dock);
  dock.querySelectorAll("[data-kb-tab]").forEach((tab) => {
    tab.addEventListener("click", () => kbDockSwitch(dock, tab.dataset.kbTab));
  });
  const closeBtn = dock.querySelector("[data-kb-action='close']");
  if (closeBtn) closeBtn.addEventListener("click", () => { dock.hidden = true; state.kbNodeId = ""; });
  const backBtn = dock.querySelector("[data-kb-action='back']");
  if (backBtn) backBtn.addEventListener("click", () => { dock.hidden = true; state.kbNodeId = ""; });
  // 节点面板卡片/测验的 ⋮ 三点菜单：收藏/重命名/删除（stopPropagation 避免与主界面委托重复触发）
  dock.addEventListener("click", (event) => {
    // 建链汇报里的「查看双链图谱」跳转链接：关闭整理助手并切换到双链图谱视图
    const graphJump = event.target.closest("[data-kb-action='open-graph']");
    if (graphJump) {
      event.preventDefault();
      event.stopPropagation();
      kbOpenGraphView();
      return;
    }
    const apiConfig = event.target.closest("[data-kb-action='open-api-config']");
    if (apiConfig) {
      event.preventDefault();
      event.stopPropagation();
      openApiConfig();
      return;
    }
    const nodeJump = event.target.closest("[data-study-node-jump]");
    if (nodeJump) {
      event.preventDefault();
      event.stopPropagation();
      nodeJump.closest(".study-item-menu")?.removeAttribute("open");
      return;
    }
    const jumpQuiz = event.target.closest("[data-kb-quiz-jump]");
    if (jumpQuiz) {
      event.preventDefault();
      kbJumpToQuiz();
      return;
    }
    const menuButton = event.target.closest("[data-study-item-action]");
    if (!menuButton) return;
    event.preventDefault();
    event.stopPropagation();
    menuButton.closest(".study-item-menu")?.removeAttribute("open");
    const action = menuButton.dataset.studyItemAction;
    if (action === "favorite") toggleFavorite(menuButton);
    if (action === "rename") openStudyItemRename(menuButton);
    if (action === "delete") deleteStudyItem(menuButton);
  });
  // 节点测验（表单在绑定后才渲染，用事件委托）：提交 / 作答草稿
  dock.addEventListener("submit", (event) => {
    if (event.target.matches("[data-kb-quiz-form]")) kbSubmitNodeQuiz(event);
  });
  dock.addEventListener("input", kbCaptureNodeQuizDraft);
  dock.addEventListener("change", kbCaptureNodeQuizDraft);
}

function kbDockSwitch(dock, tab) {
  dock.querySelectorAll("[data-kb-tab]").forEach((t) => {
    const on = t.dataset.kbTab === tab;
    t.classList.toggle("is-active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  dock.querySelectorAll("[data-kb-pane]").forEach((p) => { p.hidden = p.dataset.kbPane !== tab; });
  dock.classList.toggle("kb-dock-agent", tab === "agent");
  if (tab === "note" && state.kbNodeId) kbLoadNoteDetail(state.kbNodeId);
  if (tab === "agent") {
    kbRenderAgentMessages(dock.querySelector("[data-kb-agent-msgs]"));
    // 懒装载整理助手的数据：记忆徽章 / 会话列表 / 待批准建议稿都只在真正要用时取一次，
    // 避免刚点开节点就打三个接口。
    kbLoadSessions(state.kbNodeId || undefined);
    kbLoadProposals();
    kbRefreshDigest();
  }
}

function kbOpenNode(nodeId) {
  // 切节点 → 每个节点会话独立：先记住上个节点当前会话，再按新节点装载
  const prevGroup = kbActiveNodeGroup();
  if (prevGroup && state.kbConversationId) state.kbConvByNode[prevGroup] = state.kbConversationId;
  // 收敛条状态按节点独立：先把当前节点的收敛条状态归档，避免切到别的节点还显示上个节点的三个按钮
  if (prevGroup) state.kbConvergeByNode[prevGroup] = { active: state.kbConvergeActive, task: state.kbConvergeTask, applied: state.kbConvergeApplied };
  state.kbNodeId = nodeId;
  state.kbFocusNodeId = nodeId;   // 当前节点：整理助手把它作为「补全/引导」的目标
  // 笔记模式按节点记忆：默认落在「笔记」页签（学习的主场），有内容的节点首屏直接给
  // 「预览」，空笔记给「编辑」，避免一进来就是裸输入框。
  const target = (state.nodes || []).find((n) => n.node_id === nodeId);
  if (state.kbModeByNode[nodeId] !== undefined) state.kbMode = state.kbModeByNode[nodeId];
  else state.kbMode = (target?.note_content || "").trim() ? "preview" : "edit";
  // 清空上个节点的会话与引导状态，避免显示上个节点的对话 / apply-redo-stop 收敛条
  state.kbConversationId = null;
  state.kbAgentMode = "default";
  state.kbConvergeHasChange = false;
  // 恢复新节点的收敛条状态：没在这个节点发起过任务/引导 → 默认隐藏，不显示红框三个按钮
  const saved = state.kbConvergeByNode[nodeId] || { active: false, task: "guide", applied: false };
  state.kbConvergeActive = saved.active;
  state.kbConvergeTask = saved.task || "guide";
  state.kbConvergeApplied = saved.applied;
  const dock = kbGetDock();
  if (dock) { dock.hidden = false; kbDockSwitch(dock, "note"); refreshQuestionRails(); }
  kbLoadNoteDetail(nodeId);
  kbRenderAgentFocus();
  // 未在忙碌时才切换会话装载，避免打断流式回答
  if (dock && !state.kbAgentBusy) kbLoadSessions(nodeId);
}

function kbNodeStatusClass(node) {
  return frameworkStatusClass(node);
}

// ---- 学习路径：把图谱的树形顺序摊平成一条可通读的序列 ----
// 之前只有「按掌握度排序的队列」散落在侧栏/进步面板/概览三处，彼此不知情，
// 也没有任何一个「下一个节点」的跳转原语。这里给出唯一的路径原语：
// 前序遍历(深度优先)得到与框架目录一致的顺序，供面板 breadcrumb 与上/下一节点共用。
function kbLearningPath(nodeId) {
  const tree = buildFrameworkTree();
  const order = [];
  const indexById = new Map();
  const visit = (id) => {
    if (indexById.has(id)) return;
    indexById.set(id, order.length);
    order.push(id);
    for (const childId of tree.children.get(id) || []) visit(childId);
  };
  tree.roots.forEach(visit);
  // 树里漏掉的孤儿节点（parent_id 指向已删除节点）也补进来，避免路径出现空洞
  for (const n of state.nodes || []) if (!indexById.has(n.node_id)) visit(n.node_id);
  const i = indexById.get(nodeId);
  if (i == null) return { order, index: -1, total: order.length, prevId: "", nextId: "" };
  return {
    order,
    index: i,
    total: order.length,
    prevId: i > 0 ? order[i - 1] : "",
    nextId: i < order.length - 1 ? order[i + 1] : "",
  };
}

function kbLearningNodeName(nodeId) {
  const n = (state.nodes || []).find((x) => x.node_id === nodeId);
  return n ? n.name : "";
}

// 面板顶部的学习路径导航：面包屑（根…父…当前）+ 上/下一节点。
// 「上一节点/下一节点」直接换节点并留在面板里，形成连续学习而不是回图谱。
function kbPathBarMarkup(nodeId) {
  const path = kbLearningPath(nodeId);
  if (path.index < 0) return "";
  const tree = buildFrameworkTree();
  const crumbs = [];
  let cursor = nodeId;
  const guard = new Set();
  while (cursor && tree.byId.has(cursor) && !guard.has(cursor)) {
    guard.add(cursor);
    crumbs.unshift({ id: cursor, name: (tree.byId.get(cursor) || {}).name || "" });
    cursor = (tree.byId.get(cursor) || {}).parent_id || "";
  }
  const crumbHtml = crumbs.map((c, i) => {
    const isLast = i === crumbs.length - 1;
    const name = escapeHtml(c.name || "");
    return isLast
      ? `<span class="kb-crumb is-current">${name}</span>`
      : `<button class="kb-crumb" type="button" data-kb-goto-node="${escapeAttr(c.id)}">${name}</button>` +
        `<span class="kb-crumb-sep" aria-hidden="true">›</span>`;
  }).join("");
  const prevName = kbLearningNodeName(path.prevId);
  const nextName = kbLearningNodeName(path.nextId);
  return `
    <div class="kb-path-bar" data-kb-path-bar>
      <nav class="kb-path-crumbs" aria-label="学习路径">${crumbHtml}</nav>
      <span class="kb-path-pos">第 ${path.index + 1} / ${path.total} 个</span>
      <span class="kb-path-nav">
        <button class="mini-button kb-path-step" type="button" data-kb-goto-node="${escapeAttr(path.prevId)}"${path.prevId ? "" : " disabled"} title="${escapeAttr(prevName || "已是第一个节点")}">‹ 上一节点</button>
        <button class="mini-button kb-path-step" type="button" data-kb-goto-node="${escapeAttr(path.nextId)}"${path.nextId ? "" : " disabled"} title="${escapeAttr(nextName || "已是最后一个节点")}">下一节点 ›</button>
      </span>
    </div>`;
}

// 学习闭环 stepper：把「读懂 → 讨论 → 练习 → 复习」四个分散在不同界面的动作
// 显式排在节点面板顶部，让用户一眼看到自己在哪一步、下一步该做什么。
// 每一步都是可点的真实入口，不是装饰。
function kbStepperMarkup(node) {
  const hasNote = Boolean((node.note_content || "").trim());
  const hasCards = Array.isArray(state.kbNodeCards) && state.kbNodeCards.length > 0;
  const hasQuiz = Boolean(state.kbNodeQuiz);
  const mastered = node.learning_status === "mastered" || (Number(node.mastery_score) || 0) >= 0.85;
  // 讨论没有可查的「完成」标记（后端不留痕），默认记为未做；
  // 但掌握度已达标时不再用它拦住「下一步」，否则四步永远走不完。
  const discussed = Boolean(state.kbDiscussedNodes && state.kbDiscussedNodes[node.node_id]);
  const steps = [
    { key: "read", label: "读懂", done: hasNote || mastered, act: "read", hint: hasNote ? "笔记已写，回到正文" : "写下你对这个节点的理解" },
    { key: "discuss", label: "讨论", done: discussed || mastered, act: "discuss", hint: "和 AI 同学把这个点讲透" },
    { key: "practice", label: "练习", done: hasQuiz || hasCards, act: "practice", hint: hasQuiz ? "做一份小测验自测" : "生成卡片或小测验" },
    { key: "review", label: "复习", done: mastered, act: "mastery", hint: "看掌握度缺口，安排复习" },
  ];
  const currentIdx = steps.findIndex((s) => !s.done);
  return `
    <div class="kb-stepper" data-kb-stepper>
      <span class="kb-stepper-label">学习闭环</span>
      <ol class="kb-stepper-list">
        ${steps.map((s, i) => `
          <li class="kb-step${s.done ? " is-done" : ""}${i === currentIdx ? " is-current" : ""}">
            <button type="button" data-kb-step="${s.act}" title="${escapeAttr(s.hint)}">
              <span class="kb-step-dot" aria-hidden="true">${s.done ? "✓" : i + 1}</span>
              <span class="kb-step-label">${s.label}</span>
            </button>
          </li>`).join("")}
      </ol>
      ${currentIdx >= 0 ? `<span class="kb-stepper-next">下一步：${escapeHtml(steps[currentIdx].hint)}</span>` : `<span class="kb-stepper-next is-done">四步已完成，可跳到下一节点</span>`}
    </div>`;
}

function kbNotePaneMarkup(node) {
  const score = Math.round((Number(node.mastery_score) || 0) * 100);
  return `
    ${kbPathBarMarkup(node.node_id)}
    <div class="kb-note-head">
      <div class="kb-note-title">
        <span class="framework-tree-status ${kbNodeStatusClass(node)}"></span>
        <strong>${escapeHtml(node.name)}</strong>
        <span class="kb-note-meta">${escapeHtml(statusLabel(node))} · 掌握 ${score}%</span>
      </div>
      <div class="kb-note-actions">
        <button class="mini-button" type="button" data-kb-note-action="editNode">✎ 编辑节点</button>
        <button class="mini-button" type="button" data-kb-note-action="complete" title="切换到整理助手，用 AI 生成详细高质量笔记（待批准建议稿）">✎ 补全当前节点笔记</button>
        <button class="mini-button" type="button" data-kb-note-action="mastery">掌握度分析</button>
      </div>
    </div>
    ${kbStepperMarkup(node)}
    <div class="kb-note-toolbar">
      <div class="kb-mode-tabs" role="group" aria-label="笔记模式">
        <button class="kb-mode-tab${state.kbMode === "preview" ? "" : " is-active"}" type="button" data-kb-mode="edit">编辑</button>
        <button class="kb-mode-tab${state.kbMode === "preview" ? " is-active" : ""}" type="button" data-kb-mode="preview">预览</button>
      </div>
      <span class="kb-save-state" data-kb-save-state></span>
    </div>
    <div class="kb-editor-wrap" data-kb-editor-wrap${state.kbMode === "preview" ? " hidden" : ""}>
      <textarea class="kb-markdown-editor" data-kb-editor spellcheck="false" placeholder="用 Markdown 记下你的理解（支持 [[节点名|别名]] 双链、**加粗**、# 标题）…"></textarea>
    </div>
    <div class="kb-preview-area" data-kb-preview${state.kbMode === "preview" ? "" : " hidden"}></div>
    <div class="kb-gen-row">
      <button class="mini-button primary" type="button" data-kb-note-action="card">生成知识卡片</button>
      <button class="mini-button" type="button" data-kb-note-action="quiz">生成小测验</button>
      <span class="kb-ai-seg" role="group" aria-label="AI 学习互动">
        <span class="kb-ai-seg-label" aria-hidden="true">AI 学习</span>
        <button class="mini-button" type="button" data-kb-note-action="discuss" title="以当前节点为锚点，进入海小棠学习小组讨论">AI 同学讨论</button>
        <button class="mini-button" type="button" data-kb-note-action="guide" title="从当前节点进入苏格拉底式引导学习">${state.kbAgentMode === "guide" ? "退出引导" : "苏格拉底引导"}</button>
      </span>
      <button class="mini-button" type="button" data-kb-note-action="save">保存</button>
    </div>
    <div class="kb-gen-result${state.kbNodeCards.length ? " kb-slot-open" : ""}" data-kb-card-result></div>
    <div class="kb-gen-result${state.kbNodeQuiz ? " kb-slot-open" : ""}" data-kb-quiz-result></div>
    <details class="kb-fold">
      <summary class="kb-fold-head"><span>组织：标签与双链</span><span class="kb-fold-hint">分类与连接</span></summary>
      <div class="kb-fold-body">
        <div class="kb-tags-row">
          <input class="kb-tags-input" data-kb-tags placeholder="标签（逗号分隔），如：代数, 定义" aria-label="节点标签"/>
          <div class="kb-tags-chips" data-kb-tags-chips></div>
        </div>
        <div class="kb-links-loop">
          <div class="kb-links-block">
            <h5>双链</h5>
            <div class="kb-link-items" data-kb-wikilinks><span class="kb-muted">暂无</span></div>
            <div class="kb-wl-add">
              <input class="kb-wl-input" data-kb-wl-input placeholder="输入节点名添加双链…" autocomplete="off"/>
              <button class="mini-button kb-wl-add-btn" type="button" data-kb-wl-add>＋ 添加</button>
            </div>
          </div>
          <div class="kb-links-block">
            <h5>反向链接</h5>
            <div class="kb-link-items" data-kb-backlinks><span class="kb-muted">暂无</span></div>
          </div>
        </div>
      </div>
    </details>
  `;
}

function kbRefreshSaveState(pane, dirty, msg) {
  const el = pane ? pane.querySelector("[data-kb-save-state]") : null;
  if (!el) return;
  el.textContent = msg || (dirty ? "未保存…" : "");
  el.classList.toggle("is-dirty", Boolean(dirty));
}

function kbRenderTagsChips(pane, tags) {
  const box = pane.querySelector("[data-kb-tags-chips]");
  if (!box) return;
  box.innerHTML = (tags || []).map(
    (t) => `<span class="kb-chip">${escapeHtml(t)}</span>`
  ).join("") || "";
}

function kbLinkItem(name, removable) {
  const chip = `<button class="kb-link-item" type="button" data-link-name="${escapeAttr(name)}">[[${escapeHtml(name)}]]</button>`;
  const x = removable ? `<button class="kb-link-x" type="button" title="移除双链" data-link-remove="${escapeAttr(name)}">×</button>` : "";
  return `<span class="kb-link-chip">${chip}${x}</span>`;
}

function kbFillLinks(pane, node, backlinks) {
  const open = (nm) => kbOpenNodeByName(nm);
  const wl = pane.querySelector("[data-kb-wikilinks]");
  if (wl) {
    const names = Array.isArray(node.wikilinks) ? node.wikilinks : [];
    wl.innerHTML = names.length
      ? names.map((nm) => kbLinkItem(nm, true)).join("")
      : `<span class="kb-muted">暂无，输入节点名添加双链</span>`;
    wl.querySelectorAll("[data-link-name]").forEach((el) => el.addEventListener("click", () => open(el.dataset.linkName)));
    wl.querySelectorAll("[data-link-remove]").forEach((btn) => btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      kbRemoveManualLink(pane, node, btn.dataset.linkRemove);
    }));
  }
  if (backlinks) {
    const bl = pane.querySelector("[data-kb-backlinks]");
    if (bl) {
      const names = (backlinks || []).map((b) => b.name);
      bl.innerHTML = names.length ? names.map((nm) => kbLinkItem(nm)).join("") : `<span class="kb-muted">暂无反向链接</span>`;
      bl.querySelectorAll("[data-link-name]").forEach((el) => el.addEventListener("click", () => open(el.dataset.linkName)));
    }
  }
}

let kbWlDrop = null;
function kbWlClose() { if (kbWlDrop) { kbWlDrop.remove(); kbWlDrop = null; } }

function kbWlCommit(input, nodeId, pane) {
  const name = (input.value || "").trim();
  if (!name) return;
  kbWlClose();
  input.value = "";
  kbAddManualLink(pane, nodeId, name);
}

function kbWlSuggest(input, nodeId, pane) {
  kbWlClose();
  const term = input.value.trim();
  if (term.length < 1) return;
  const editorText = (pane.querySelector("[data-kb-editor]") || {}).value || "";
  const existing = kbExtractWikilinks(editorText);
  api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/notes/search?q=${encodeURIComponent(term)}`)
    .then((data) => {
      const list = (data.nodes || [])
        .filter((x) => x.node_id !== nodeId && !existing.includes(x.name))
        .slice(0, 6);
      if (!list.length) return;
      const rect = input.getBoundingClientRect();
      const dd = document.createElement("div");
      dd.className = "kb-autofill";
      dd.dataset.kbWlDrop = "";
      dd.style.top = `${rect.bottom + 4}px`;
      dd.style.left = `${rect.left}px`;
      dd.style.minWidth = `${Math.max(260, rect.width)}px`;
      dd.innerHTML = list.map((n) => `<button type="button" data-name="${escapeAttr(n.name)}">${escapeHtml(n.name)}</button>`).join("");
      dd.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
        const nm = b.dataset.name;
        kbWlClose();
        input.value = "";
        kbAddManualLink(pane, nodeId, nm);
      }));
      document.body.appendChild(dd);
      kbWlDrop = dd;
    })
    .catch(() => {});
}

function kbAddManualLink(pane, nodeId, name) {
  const node = state.nodes.find((x) => x.node_id === nodeId);
  if (!node) return;
  const target = state.nodes.find((x) => String(x.name).toLowerCase() === String(name).toLowerCase());
  if (!target) { showToast(`未找到节点「${name}」，请先在知识库中创建`, { variant: "notice" }); return; }
  const editor = pane.querySelector("[data-kb-editor]");
  const text = editor ? editor.value : "";
  if (kbExtractWikilinks(text).includes(target.name)) { showToast(`已与「${target.name}」建立双链`); return; }
  const insert = text ? (text.endsWith("\n") ? "" : "\n") + `[[${target.name}]]` : `[[${target.name}]]`;
  if (editor) {
    editor.value = text + insert;
    editor.dispatchEvent(new Event("input"));
  }
  node.wikilinks = kbExtractWikilinks(editor ? editor.value : "");
  kbFillLinks(pane, node);
  showToast(`已建立双链 →「${target.name}」`);
}

function kbRemoveManualLink(pane, node, name) {
  const editor = pane.querySelector("[data-kb-editor]");
  if (!editor) return;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\[\\[${esc}(?:\\|[^\\]]*)?\\]\\]`, "g");
  const newText = editor.value.replace(re, "");
  if (newText === editor.value) {
    node.wikilinks = kbExtractWikilinks(newText);
    kbFillLinks(pane, node);
    return;
  }
  editor.value = newText;
  editor.dispatchEvent(new Event("input"));
  node.wikilinks = kbExtractWikilinks(newText);
  kbFillLinks(pane, node);
  showToast(`已移除双链「${name}」`);
}

window.addEventListener("click", (e) => {
  if (!e.target.closest("[data-kb-wl-add], [data-kb-wl-input], [data-kb-wl-drop]")) kbWlClose();
});

function kbBindNotePane(pane, node) {
  const editor = pane.querySelector("[data-kb-editor]");
  pane.querySelectorAll("[data-kb-mode]").forEach((b) => {
    b.addEventListener("click", () => {
      state.kbMode = b.dataset.kbMode;
      state.kbModeByNode[node.node_id] = state.kbMode;   // 按节点记忆，下次回到本节点保持同一读法
      pane.querySelectorAll("[data-kb-mode]").forEach((x) => x.classList.toggle("is-active", x === b));
      const editorWrap = pane.querySelector("[data-kb-editor-wrap]");
      const preview = pane.querySelector("[data-kb-preview]");
      if (editorWrap) editorWrap.hidden = state.kbMode === "preview";
      if (preview) {
        preview.hidden = state.kbMode !== "preview";
        if (state.kbMode === "preview") {
          preview.innerHTML = kbRenderMarkdown(editor ? editor.value : "");
          kbBindWikilinks(preview);
        }
      }
    });
  });
  if (editor) {
    editor.addEventListener("input", () => {
      state.kbDirty = true;
      kbRefreshSaveState(pane, true);
      clearTimeout(state.kbSaveTimer);
      state.kbSaveTimer = setTimeout(() => { state.kbDirty = false; kbSave(node.node_id, pane); }, 900);
    });
    // [[ 自动补全：输入 [[ 时触发检索
    editor.addEventListener("keyup", (e) => { if (e.key === "[") kbAutofillSuggest(editor, node.node_id); });
    editor.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "Tab") kbAutofillCommit(editor, e);
    });
  }
  const wlInput = pane.querySelector("[data-kb-wl-input]");
  if (wlInput) {
    wlInput.addEventListener("input", () => kbWlSuggest(wlInput, node.node_id, pane));
    wlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); kbWlCommit(wlInput, node.node_id, pane); }
    });
  }
  const wlAdd = pane.querySelector("[data-kb-wl-add]");
  if (wlAdd) wlAdd.addEventListener("click", () => kbWlCommit(wlInput, node.node_id, pane));
  const tagsInput = pane.querySelector("[data-kb-tags]");
  if (tagsInput) {
    tagsInput.addEventListener("change", () => {
      const tags = tagsInput.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      kbRenderTagsChips(pane, tags);
      state.kbDirty = true;
      clearTimeout(state.kbSaveTimer);
      state.kbSaveTimer = setTimeout(() => { state.kbDirty = false; kbSave(node.node_id, pane, { tags }); }, 700);
    });
  }
  const actions = {
    save: () => kbSave(node.node_id, pane, { force: true }),
    card: () => kbGenerateCard(node),
    quiz: () => kbGenerateQuiz(node),
    editNode: () => renderNodeDetail(node.node_id),
    complete: () => kbCompleteNoteFromPane(node, pane),
    mastery: () => openNodeMasteryAnalysisDialog(node.node_id),
    discuss: () => openDiscussionForNode(node.node_id),
    guide: () => (state.kbAgentMode === "guide" ? kbExitGuide() : kbStartGuide(node.node_id)),
  };
  pane.querySelectorAll("[data-kb-note-action]").forEach((b) => {
    const fn = actions[b.dataset.kbNoteAction];
    if (fn) b.addEventListener("click", fn);
  });
  // 学习路径：面包屑与上/下一节点都在面板内换节点，不必回图谱重来一遍。
  pane.querySelectorAll("[data-kb-goto-node]").forEach((b) => {
    b.addEventListener("click", () => {
      const target = b.dataset.kbGotoNode;
      if (!target) return;
      if (state.kbDirty) { kbRefreshSaveState(pane, true, "有未保存内容，先保存再切换"); return; }
      kbOpenNode(target);
    });
  });
  // 闭环 stepper：每一步都接到真实动作上，不做纯展示。
  pane.querySelectorAll("[data-kb-step]").forEach((b) => {
    b.addEventListener("click", () => kbRunStep(node, b.dataset.kbStep, pane));
  });
}

// 笔记保存后只刷新闭环进度，不重渲染卡片/测验层：
// 重渲染会替换掉 quiz 表单，正在作答的输入与焦点会被打断。
function kbRefreshNodeProgress() {
  const node = (state.nodes || []).find((n) => n.node_id === state.kbNodeId);
  if (!node) return;
  const pane = document.querySelector(".kb-pane-note");
  if (!pane) return;
  const old = pane.querySelector("[data-kb-stepper]");
  const next = kbStepperMarkup(node);
  if (old && next) {
    const tmp = document.createElement("div");
    tmp.innerHTML = next;
    const fresh = tmp.firstElementChild;
    // 新 stepper 是刚解析出来的元素，原节点上的监听器随之失效，这里补回绑定。
    if (fresh) {
      fresh.querySelectorAll("[data-kb-step]").forEach((b) => {
        b.addEventListener("click", () => kbRunStep(node, b.dataset.kbStep, pane));
      });
      old.replaceWith(fresh);
    }
  }
}

// 闭环 stepper 的动作分发：读懂 / 讨论 / 练习 / 复习，各自接到真实能力上。
function kbRunStep(node, step, pane) {
  if (step === "read") {
    state.kbMode = "edit";
    state.kbModeByNode[node.node_id] = "edit";
    const wrap = pane.querySelector("[data-kb-editor-wrap]");
    const preview = pane.querySelector("[data-kb-preview]");
    if (wrap) wrap.hidden = false;
    if (preview) preview.hidden = true;
    pane.querySelectorAll("[data-kb-mode]").forEach((x) => x.classList.toggle("is-active", x.dataset.kbMode === "edit"));
    const editor = pane.querySelector("[data-kb-editor]");
    if (editor) editor.focus();
    return;
  }
  if (step === "discuss") { openDiscussionForNode(node.node_id); return; }
  if (step === "practice") {
    // 「练习」一步同时产出卡片与测验：已有测验就只补卡片，都没有就两个都生成。
    showToast(state.kbNodeQuiz ? "已有一份小测验，正在补知识卡片…" : "正在生成知识卡片与小测验…", { variant: "notice" });
    kbGenerateCard(node);
    if (!state.kbNodeQuiz) kbGenerateQuiz(node);
    return;
  }
  if (step === "mastery") { openNodeMasteryAnalysisDialog(node.node_id); }
}

function kbBindWikilinks(container) {
  if (!container) return;
  container.querySelectorAll("[data-link-name]").forEach((el) => {
    el.addEventListener("click", () => kbOpenNodeByName(el.dataset.linkName));
  });
}

function handleKbWikilinkClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  const link = target ? target.closest(".kb-wl-link") : null;
  if (!link) return;
  event.preventDefault();
  kbOpenNodeByName(link.dataset.linkName || "");
}

function kbOpenNodeByName(name) {
  const n = state.nodes.find((x) => x.name === name);
  if (n) { kbOpenNode(n.node_id); }
  else { showToast(`未找到节点「${name}」`, { variant: "notice" }); }
}

async function kbLoadNoteDetail(nodeId) {
  const pane = document.querySelector(".kb-pane-note");
  if (!pane) return;
  pane.innerHTML = `<div class="kb-loading">加载笔记…</div>`;
  let data;
  try {
    data = await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/notes/${encodeURIComponent(nodeId)}`);
  } catch (err) {
    pane.innerHTML = `<div class="kb-loading">${escapeHtml(err.message || "加载失败")}</div>`;
    return;
  }
  const node = data.node;
  // 已有卡片/测验（生成即落库），切换界面 / 重进节点后恢复展示；
  // 本会话已提交过同一份测验 → 保留逐题结果，避免重开面板后回退成未作答
  let quiz = data.quiz || null;
  if (quiz && state.kbNodeQuiz && state.kbNodeQuiz.quiz_id === quiz.quiz_id && Array.isArray(state.kbNodeQuiz.results)) {
    quiz.results = state.kbNodeQuiz.results;
  }
  state.kbNodeCards = Array.isArray(data.cards) ? data.cards : [];
  state.kbNodeQuiz = quiz;
  pane.innerHTML = kbNotePaneMarkup(node);
  const editor = pane.querySelector("[data-kb-editor]");
  if (editor) editor.value = node.note_content || "";
  const tagsInput = pane.querySelector("[data-kb-tags]");
  if (tagsInput) tagsInput.value = (node.tags || []).join(", ");
  kbRenderTagsChips(pane, node.tags || []);
  kbFillLinks(pane, node, data.backlinks || []);
  kbBindNotePane(pane, node);
  kbRenderNodeResults(node);
  kbRefreshSaveState(pane, false, node.note_content ? "" : "暂无笔记");
  // 有笔记时首屏给「预览」而不是裸 textarea：先看内容再决定要不要编辑，降低首屏噪声。
  if (state.kbMode === "preview") {
    const preview = pane.querySelector("[data-kb-preview]");
    if (preview && editor && (node.note_content || "").trim()) {
      preview.innerHTML = kbRenderMarkdown(editor.value);
      kbBindWikilinks(preview);
    }
  }
}

async function kbSave(nodeId, pane, opts = {}) {
  if (!state.kbNodeId) return;
  const text = (pane.querySelector("[data-kb-editor]") || {}).value ?? "";
  const tagsInput = pane.querySelector("[data-kb-tags]");
  const tags = opts.tags || (tagsInput ? tagsInput.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : []);
  if (opts.tags === undefined && !tagsInput) { /* noop */ }
  const wikilinks = kbExtractWikilinks(text);
  kbRefreshSaveState(pane, true, "保存中…");
  try {
    await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/notes/${encodeURIComponent(nodeId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note_content: text, tags, wikilinks }),
    });
    kbRefreshSaveState(pane, false, "已保存 ✓");
    const n = state.nodes.find((x) => x.node_id === nodeId);
    if (n) { n.note_content = text; n.tags = tags; n.wikilinks = wikilinks; }
    kbRefreshNodeProgress();   // 「读懂」这一步随即点亮
  } catch (err) {
    kbRefreshSaveState(pane, true, "保存失败");
    showToast(err.message || "保存失败", { variant: "notice" });
  }
}

// ---- [[ 自动补全 ----
function kbAutofillSuggest(editor, nodeId) {
  if (!editor) return;
  const caret = editor.selectionStart;
  const before = editor.value.slice(0, caret);
  const m = before.match(/\[\[([^\[\]]*)$/);
  if (!m) return;
  const term = m[1] || "";
  if (term.length < 1) return;
  api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/notes/search?q=${encodeURIComponent(term)}`)
    .then((data) => {
      const list = (data.nodes || []).filter((x) => x.node_id !== nodeId).slice(0, 6);
      kbShowAutofill(editor, term, list);
    })
    .catch(() => {});
}
function kbShowAutofill(editor, term, list) {
  const existing = document.querySelector("[data-kb-autofill]");
  if (existing) existing.remove();
  if (!list.length) return;
  const ta = editor;
  const rect = ta.getBoundingClientRect();
  const dd = document.createElement("div");
  dd.className = "kb-autofill";
  dd.dataset.kbAutofill = "";
  dd.style.top = `${rect.top}px`;
  dd.style.left = `${rect.left}px`;
  dd.innerHTML = list.map((n) => `<button type="button" data-kb-af="true" data-name="${escapeAttr(n.name)}">${escapeHtml(n.name)}</button>`).join("");
  dd.querySelectorAll("[data-kb-af]").forEach((b) => b.addEventListener("click", () => {
    kbInsertAutofill(editor, term, b.dataset.name);
  }));
  document.body.appendChild(dd);
  window._kbAutofill = { editor, term };
}
function kbInsertAutofill(editor, term, name) {
  const caret = editor.selectionStart;
  const before = editor.value.slice(0, caret);
  const openAt = before.lastIndexOf("[[");
  if (openAt < 0) return;
  const start = openAt + 2;
  const after = editor.value.slice(caret);
  if (!after.startsWith("]]")) {
    // 插入并补全闭合
    editor.value = editor.value.slice(0, start) + name + editor.value.slice(start + term.length);
    const pos = start + name.length + 2;
    editor.value = editor.value.slice(0, pos) + "]]" + editor.value.slice(pos);
    editor.selectionStart = editor.selectionEnd = pos + 2;
  }
  document.querySelector("[data-kb-autofill]")?.remove();
  editor.dispatchEvent(new Event("input"));
}
function kbAutofillCommit(editor, event) {
  const dd = document.querySelector("[data-kb-autofill]");
  if (!dd) return;
  const active = dd.querySelector("button");
  if (active) {
    event.preventDefault();
    kbInsertAutofill(editor, window._kbAutofill?.term || "", active.dataset.name);
  }
}
window.addEventListener("click", (e) => { if (!e.target.closest("[data-kb-autofill]")) document.querySelector("[data-kb-autofill]")?.remove(); });

// ---- 卡片 / 测验生成 ----
function kbResultWrite(selector, html) {
  const pane = document.querySelector(".kb-pane-note");
  const box = pane ? pane.querySelector(selector) : null;
  if (box) box.innerHTML = html;
}
// 卡片与小测验各自写入独立结果区，互不覆盖，可分别反复生成。
function kbCardResultMarkup(html) { kbResultWrite("[data-kb-card-result]", html); }
function kbQuizResultMarkup(html) { kbResultWrite("[data-kb-quiz-result]", html); }

// 刚生成的内容滚到可见处：折叠层默认不展开视野，用户点完「生成」不该还要自己去找。
function kbScrollFoldIntoView(key) {
  const pane = document.querySelector(".kb-pane-note");
  const fold = pane ? pane.querySelector(`[data-kb-fold="${key}"]`) : null;
  if (!fold) return;
  fold.open = true;
  fold.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function kbSlotSelector(key) {
  return key === "card" ? "[data-kb-card-result]" : "[data-kb-quiz-result]";
}

function kbGenButtonSelector(key) {
  return key === "card" ? '[data-kb-note-action="card"]' : '[data-kb-note-action="quiz"]';
}

// 生成中/出错的可见反馈：槽位必须先占位（渐进披露 CSS 会把没占位的槽位 display:none，
// loading 写进去用户根本看不见，点了按钮像没反应），同时把按钮切成忙碌态。
function kbSlotLoading(key, text) {
  const pane = document.querySelector(".kb-pane-note");
  if (!pane) return;
  const slot = pane.querySelector(kbSlotSelector(key));
  if (slot) {
    slot.classList.add("kb-slot-open");   // 让 loading 可见
    slot.innerHTML = `<div class="kb-loading">${escapeHtml(text)}</div>`;
  }
  kbMarkGenBusy(key, true);
}

// 生成失败：把原因留在槽位里（用户能读到），而不是写进隐藏容器后静默消失。
function kbSlotError(key, message) {
  const pane = document.querySelector(".kb-pane-note");
  if (!pane) return;
  const slot = pane.querySelector(kbSlotSelector(key));
  if (!slot) return;
  slot.classList.add("kb-slot-open");
  const hint = (typeof isApiConfigError === "function" && isApiConfigError({ message }))
    ? `<div class="kb-graph-jump"><button type="button" data-kb-action="open-api-config">⚙ 去配置 API Key</button></div>`
    : "";
  slot.innerHTML = `<div class="kb-err">${escapeHtml(message)}</div>${hint}`;
}

// 按钮忙碌态：文案 + 转圈 + 禁用，让「点了有反应」发生在按钮自己身上。
function kbMarkGenBusy(key, busy) {
  const pane = document.querySelector(".kb-pane-note");
  if (!pane) return;
  const btn = pane.querySelector(kbGenButtonSelector(key));
  if (!btn) return;
  const busyLabel = key === "card" ? "生成中…" : "出题中…";
  if (busy) {
    btn.dataset.kbIdleText = btn.dataset.kbIdleText || btn.textContent;
    btn.textContent = busyLabel;
    btn.disabled = true;
    btn.classList.add("is-busy");
  } else {
    btn.textContent = btn.dataset.kbIdleText || (key === "card" ? "生成知识卡片" : "生成小测验");
    btn.disabled = false;
    btn.classList.remove("is-busy");
  }
}

function kbTypeLabel(type) {
  return {"choice":"单选","single_choice":"单选","multiple_choice":"多选","indefinite_choice":"不定项","fill":"填空","fill_blank":"填空","short_answer":"简答","calculation":"计算"}[type] || type || "题";
}

// 节点面板卡片：带文字高亮 + ⋮ 三点菜单（收藏/重命名/删除）
function kbNodeCardMarkup(card) {
  const front = kbRenderMarkdown(card.front || "");
  const back = kbRenderMarkdown(card.back || "");
  return `
    <section class="kb-card-item" data-kb-card-id="${escapeAttr(card.card_id)}">
      <div class="kb-card-item-head">
        <span class="kb-cat">${escapeHtml(card.category || "概念")}</span>
        ${studyItemMenuMarkup("card", card.card_id, card.front || "", card.node_ids)}
      </div>
      ${highlightableMarkup(`kbcard:${card.card_id}:front`, front, "kb-card-front")}
      <details><summary>查看要点</summary><div class="kb-card-back">${highlightableMarkup(`kbcard:${card.card_id}:back`, back)}</div></details>
    </section>`;
}

// 节点面板测验：与「小测验」入口一致——可作答、提交更新掌握度、就地查看解析；⋮ 三点菜单保留。
function kbNodeQuizMarkup(quiz, node) {
  if (!quiz) return "";
  const qs = quiz.questions || [];
  const results = Array.isArray(quiz.results) && quiz.results.length === qs.length ? quiz.results : null;
  const answered = Boolean(results || quiz.score != null); // 已提交：本会话有逐题结果，或刷新后仅有得分
  const draft = state.kbNodeQuizDraft || {};
  const scoreText = results
    ? `得分 ${results.filter((r) => r.correct).length}/${results.length}`
    : (quiz.score != null ? `已提交 · 得分 ${Math.round(quiz.score * 100)}%` : "");
  const items = qs.map((q, index) => {
    const result = results ? results[index] : null;
    const originId = `${quiz.quiz_id}:${index}`;
    const feedback = result
      ? quizFeedbackContent(q, result)
      : (answered ? kbNodeQuizReview(q) : `<div id="kbq-result-${index}"></div>`);
    return `<li class="kb-quiz-item${result ? (result.correct ? " is-correct" : " is-wrong") : ""}">
      <div class="kb-quiz-q-wrap">${highlightableMarkup(`kbquiz:${originId}:question`, `<div class="kb-quiz-q">${kbRenderMarkdown(q.question || "")}</div>`, "kb-quiz-q-wrap")}</div>
      ${kbNodeQuizInput(q, index, result, draft[index], answered)}
      ${answered ? "" : quizSelfConfidenceMarkup(index, state.kbNodeQuizSelfConfidence?.[`${quiz.quiz_id}:${index}`])}
      ${feedback}
      ${result ? quizErrorTypeMarkup(index, quiz.quiz_id, result.correct === false, result.error_type) : ""}
      <div class="kb-quiz-meta"><span>${escapeHtml(kbTypeLabel(q.type))} · 难度 ${q.difficulty ?? 1}</span>${studyItemMenuMarkup("quiz", originId, q.question || "", q.node_ids)}</div>
    </li>`;
  }).join("");
  return `
    <div class="kb-quiz-result">
      ${quizQuadrantSummaryMarkup(results)}
      <div class="kb-quiz-head">
        <h5>小测验（${qs.length} 题）${scoreText ? `<span class="kb-quiz-score">${escapeHtml(scoreText)}</span>` : ""}</h5>
        <button class="mini-button" type="button" data-kb-quiz-jump title="跳到主界面「小测验」完整作答与历史记录">去「小测验」作答 →</button>
      </div>
      <form data-kb-quiz-form>
        <ol class="kb-quiz-list">${items}</ol>
        <div class="kb-quiz-submit-row">
          <button class="mini-button primary" type="submit"${answered ? " disabled" : ""}>${answered ? "已提交" : "提交并更新掌握度"}</button>
        </div>
      </form>
    </div>`;
}

// 节点测验作答控件：单选 / 多选 / 填空 / 简答（已提交后禁用并回显提交答案）
function kbNodeQuizInput(q, index, result, draft, locked) {
  const name = `q${index}`;
  const disabled = locked ? " disabled" : "";
  if (q.type === "choice" || q.type === "single_choice") {
    return `<div class="kb-quiz-opts">${q.options.map((o) => {
      const checked = result ? (isSubmittedChoice(q, o, result.submitted_answer) ? " checked" : "") : (!locked && draft === o ? " checked" : "");
      return `<label class="kb-quiz-opt${quizOptionStateClasses(q, o, result)}">${quizOptionMark(q, o, result)}<input type="radio" name="${name}" value="${escapeAttr(o)}"${disabled}${checked ? " checked" : ""} required><span class="quiz-option-text">${renderQuizOptionText(o)}</span></label>`;
    }).join("")}</div>`;
  }
  if (q.type === "multiple_choice" || q.type === "indefinite_choice") {
    const submittedLetters = new Set((result?.submitted_answer || "").toUpperCase().match(/[A-F]/g) || []);
    return `<div class="kb-quiz-opts">${q.options.map((o) => {
      const letter = o.trim().charAt(0).toUpperCase();
      const checked = result ? (submittedLetters.has(letter) ? " checked" : "") : (!locked && Array.isArray(draft) && draft.includes(o) ? " checked" : "");
      return `<label class="kb-quiz-opt${quizOptionStateClasses(q, o, result)}">${quizOptionMark(q, o, result)}<input type="checkbox" name="${name}" value="${escapeAttr(o)}"${disabled}${checked ? " checked" : ""}><span class="quiz-option-text">${renderQuizOptionText(o)}</span></label>`;
    }).join("")}</div>`;
  }
  if (q.type === "fill_blank" || q.type === "fill") {
    return `<input class="kb-quiz-input" type="text" name="${name}" value="${escapeAttr(result?.submitted_answer || (!locked && typeof draft === "string" ? draft : ""))}"${disabled}${locked ? "" : " required"} placeholder="填入空位答案">`;
  }
  return `<textarea class="kb-quiz-input" name="${name}" rows="2"${disabled}${locked ? "" : " required"} placeholder="写出你的答案">${escapeHtml(result?.submitted_answer || (!locked && typeof draft === "string" ? draft : ""))}</textarea>`;
}

// 历史已提交但缺少逐题结果（极少数兜底场景）：绿色标注正确答案 + 解析供复习
function kbNodeQuizReview(q) {
  return `<div class="quiz-result review"><span class="kb-correct-mark">✓ 正确答案：${renderMathContent(displayQuizAnswer(q, q.answer))}</span><div class="quiz-explanation">${renderStudyTextContent(q.explanation || "请回到来源材料复核这一题。")}</div></div>`;
}

// 提交节点测验：与「小测验」入口共用后端端点，更新掌握度并就地展示逐题解析
async function kbSubmitNodeQuiz(event) {
  event.preventDefault();
  const quiz = state.kbNodeQuiz;
  if (!quiz || quiz.results) return;
  const form = event.target;
  const answers = quiz.questions.map((question, index) => {
    if (question.type === "multiple_choice" || question.type === "indefinite_choice") {
      const selected = new FormData(form).getAll(`q${index}`) || [];
      const letters = selected.map((opt) => opt.trim().charAt(0).toUpperCase()).filter((c) => /[A-F]/.test(c));
      return letters.sort().join("");
    }
    return new FormData(form).get(`q${index}`) || "";
  });
  const btn = form.querySelector("[type='submit']");
  if (btn) { btn.disabled = true; btn.textContent = "提交中…"; }
  try {
    _setMasteryBaseline(); // 桌宠掌握度实时播报：记录对话测验前基线
    const selfConfidences = quiz.questions.map((_, index) => {
      const raw = new FormData(form).get(`sc${index}`);
      if (raw === null || raw === "") return null;
      return raw === "1" ? 1.0 : 0.0;
    });
    const data = await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/quiz/${encodeURIComponent(quiz.quiz_id)}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers, self_confidences: selfConfidences }),
    });
    quiz.results = data.results || [];
    state.kbNodeQuizDraft = {};
    // 同步到主界面「小测验」：跳转过去可看到同样的已提交状态与解析
    state.quiz = quiz;
    state.quiz.results = quiz.results;
    state.quizDraftAnswers = {};
    state.quizHistory = null;
    kbRenderNodeResults();
    kbRefreshNodeProgress();   // 「练习」这一步点亮，掌握度可能也变了
    showToast(`本次测验得分 ${data.correct}/${data.total}，掌握度已更新`, { variant: "notice" });
    await refreshCurrentProject({ renderStudio: false, preserveQuizResults: true });
    try { await refreshMasteryBreakdown({ reRender: false }); } catch (e) { console.warn("[mastery] 节点测验后刷新明细失败", e); }
    // 桌宠掌握度实时播报：对话中的节点测验后，把涨幅交给 tju-llm 生成
    const gainTxt = _masteryGainText();
    if (gainTxt) petReactAI("dialog_quiz", { gains: gainTxt }, "love", `这次对话测验后的掌握度来了——${gainTxt}`, { ic: "📈", stayMs: 7000 });
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = "提交并更新掌握度"; }
    showToast(err.message || "提交失败", { variant: "notice" });
  }
}

// 节点测验作答草稿：切走/重渲染不丢失（仅在未提交时记录）
function kbCaptureNodeQuizDraft(event) {
  const field = event.target;
  if (!field || !field.name) return;
  if (/^sc\d+$/.test(field.name)) {
    const kbQuiz = state.kbNodeQuiz;
    if (!kbQuiz || kbQuiz.results) return;
    if (!state.kbNodeQuizSelfConfidence) state.kbNodeQuizSelfConfidence = {};
    state.kbNodeQuizSelfConfidence[`${kbQuiz.quiz_id}:${Number(field.name.slice(2))}`] = field.value === "1" ? 1 : 0;
    return;
  }
  if (!/^q\d+$/.test(field.name)) return;
  const quiz = state.kbNodeQuiz;
  if (!quiz || quiz.results) return;
  const index = Number(field.name.slice(1));
  if (!quiz.questions?.[index]) return;
  if (!state.kbNodeQuizDraft) state.kbNodeQuizDraft = {};
  if (field.type === "checkbox") {
    const checked = [...field.form.querySelectorAll(`input[name="${field.name}"]:checked`)].map((el) => el.value);
    if (checked.length) state.kbNodeQuizDraft[index] = checked;
    else delete state.kbNodeQuizDraft[index];
  } else if (field.type === "radio") {
    state.kbNodeQuizDraft[index] = field.value;
  } else {
    if (field.value.trim()) state.kbNodeQuizDraft[index] = field.value;
    else delete state.kbNodeQuizDraft[index];
  }
}

// 跳到主界面「小测验」完整作答：关闭面板、切到 quiz 功能（同一份测验，结果同步）
function kbJumpToQuiz() {
  const dock = kbGetDock();
  if (dock) dock.hidden = true;
  // 记录来源节点：测验页据此显示「返回」按钮，可一键回到该节点面板
  state.kbQuizReturn = state.kbNodeId ? { nodeId: state.kbNodeId } : null;
  state.kbNodeId = "";
  if (state.kbNodeQuiz) {
    state.quiz = state.kbNodeQuiz;
    state.quizHistory = null;
  }
  state.viewingHistoryQuiz = null;
  switchFeature("quiz");
}

// 从主界面「小测验」返回：回到此前跳转来源的节点面板（打开整理助手并聚焦该节点）
// 注意：kb-dock 面板是框架视图 DOM 的一部分，切到 quiz 后就被移除了，
// 因此必须先切回「知识框架」视图重建 dock，再打开节点面板。
function kbReturnFromQuiz() {
  const nodeId = state.kbQuizReturn?.nodeId;
  state.kbQuizReturn = null;
  if (!nodeId || !(state.nodes || []).some((n) => n.node_id === nodeId)) {
    showNotice("找不到原节点，已留在当前页。");
    return;
  }
  kbSetView("tree");
  switchFeature("framework");
  requestAnimationFrame(() => kbOpenNode(nodeId));
}

// 依据 state.kbNodeCards / state.kbNodeQuiz 重渲染节点面板的卡片与测验结果区。
// 生成 / 收藏 / 重命名 / 删除 / 切换界面后都会调用它，保证内容不丢失、不重复。
function kbRenderNodeResults(node) {
  const current = node || state.nodes.find((n) => n.node_id === state.kbNodeId);
  const cards = Array.isArray(state.kbNodeCards) ? state.kbNodeCards : [];
  const quiz = state.kbNodeQuiz || null;
  // 渐进披露：有内容才把折叠层展开；空态只留一行摘要，且槽位不占位
  kbCardResultMarkup(
    `<details class="kb-fold" data-kb-fold="card"${cards.length ? " open" : ""}>` +
    `<summary class="kb-fold-head"><span>知识卡片</span><span class="kb-fold-hint">${cards.length ? `${cards.length} 张 · 复习用` : "尚未生成"}</span></summary>` +
    `<div class="kb-fold-body">` +
    `<div class="kb-card-result"><h5>知识卡片（${cards.length}）</h5>` +
    (cards.length
      ? cards.map(kbNodeCardMarkup).join("") + `<p class="kb-muted">已保存到「知识卡片」库，可到该入口复习。</p>`
      : `<p class="kb-muted">点击上方「生成知识卡片」为该节点生成卡片。</p>`) +
    `</div></div></details>`);
  kbQuizResultMarkup(
    `<details class="kb-fold" data-kb-fold="quiz"${quiz ? " open" : ""}>` +
    `<summary class="kb-fold-head"><span>小测验</span><span class="kb-fold-hint">${quiz ? `${(quiz.questions || []).length} 题 · 自测用` : "尚未生成"}</span></summary>` +
    `<div class="kb-fold-body">${quiz ? kbNodeQuizMarkup(quiz, current) : `<div class="kb-quiz-result"><p class="kb-muted">点击上方「生成小测验」为该节点生成一份测验。</p></div>`}</div></details>`);
  // 槽位是否占位跟着内容走，CSS 据此 display:none（否则空槽会留一个光秃秃的块）
  const cardBox = document.querySelector("[data-kb-card-result]");
  if (cardBox) cardBox.classList.toggle("kb-slot-open", cards.length > 0);
  const quizBox = document.querySelector("[data-kb-quiz-result]");
  if (quizBox) quizBox.classList.toggle("kb-slot-open", Boolean(quiz));
}

// 收藏/重命名/删除后的统一刷新：整理面板打开时只刷新面板结果区（不重建整个界面），否则整页重渲染。
function kbReconcileStudyView() {
  const dock = kbGetDock();
  if (dock && !dock.hidden) kbRenderNodeResults();
  else renderStudio();
}

async function kbGenerateCard(node) {
  if (state.kbCardBusy) return;
  state.kbCardBusy = true;
  kbSlotLoading("card", "正在生成知识卡片…");
  try {
    const data = await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/nodes/${encodeURIComponent(node.node_id)}/card`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ difficulty: 2, count: 3 }),
    });
    const cards = data.cards || [];
    // 同步到知识卡片库：主「知识卡片」界面也能看到新卡（去重，避免重复生成时叠加）
    const known = new Set(state.cards.map((c) => c.card_id));
    state.cards = [...state.cards, ...cards.filter((c) => !known.has(c.card_id))];
    const knownNode = new Set(state.kbNodeCards.map((c) => c.card_id));
    state.kbNodeCards = [...state.kbNodeCards, ...cards.filter((c) => !knownNode.has(c.card_id))];
    kbRenderNodeResults(node);
    kbMarkGenBusy("card", false);
    kbScrollFoldIntoView("card");
    showToast(`已生成 ${cards.length} 张知识卡片并保存`, { variant: "notice" });
  } catch (err) {
    kbSlotError("card", err.message || "生成失败");
    showToast(err.message || "生成失败", { variant: "notice" });
  } finally {
    state.kbCardBusy = false;
    kbMarkGenBusy("card", false);
  }
}
async function kbGenerateQuiz(node) {
  if (state.kbQuizBusy) return;
  state.kbQuizBusy = true;
  kbSlotLoading("quiz", "正在生成小测验…");
  try {
    const data = await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/nodes/${encodeURIComponent(node.node_id)}/quiz`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ difficulty: 2, question_count: 5, question_types: ["single_choice", "multiple_choice", "fill_blank", "short_answer"] }),
    });
    // 节点测验已存为最新，同步到主「小测验」界面；历史缓存失效，下次进入重新拉取
    state.quiz = data;
    state.quizHistory = null;
    state.kbNodeQuiz = data;
    kbRenderNodeResults(node);
    kbMarkGenBusy("quiz", false);
    kbScrollFoldIntoView("quiz");
    showToast(`已生成 ${(data.questions || []).length} 题小测验并保存`, { variant: "notice" });
  } catch (err) {
    kbSlotError("quiz", err.message || "生成失败");
    showToast(err.message || "生成失败", { variant: "notice" });
  } finally {
    state.kbQuizBusy = false;
    kbMarkGenBusy("quiz", false);
  }
}

// ---- Markdown 预览（含双链）----
function kbEsc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function kbRenderMarkdown(text) {
  // 兜底：内容含有苏格拉底 question 键、且整段可解析为苏格拉底 JSON 时，直接渲染成问题卡片，
  // 绝不让任何渲染入口把原始 JSON 当正文漏给用户（函数声明后置提升，此处调用安全）。
  if (String(text ?? "").indexOf("question") >= 0 && kbTryParseSocratic(text)) return kbRenderAnswer(text);
  // 先把公式块（$..$、$$..$$、\(..\)、\[..\]）替换成占位符，避免下面这些
  // Markdown 正则（**、`、[[ ]]、#、-）把公式拦腰截断；行解析结束后再逐个还原渲染。
  const mathBlocks = [];
  const protectMath = (match) => {
    const id = `\x00MATH${mathBlocks.length}\x00`;
    mathBlocks.push(match);
    return id;
  };
  const restoreMath = (chunk) => chunk.replace(/\x00MATH(\d+)\x00/g, (_, i) => renderMathContent(mathBlocks[Number(i)]));
  let s = String(text ?? "")
    // LLM 常把换行写成字面量 \n（如 "### 完整解释\\n..."），先还原成真实换行，标题/列表才能正确切分；
    // \n 后跟小写字母视为 LaTeX 命令（\nu、\nabla…）予以保留。
    .replace(/\\t(?![A-Za-z])/g, "\t")
    .replace(/\\r(?![A-Za-z])/g, "\r")
    .replace(/\\n(?![a-z])/g, "\n")
    .replace(/\r\n?/g, "\n")
    // 兜底：清掉控制字符（LLM 偶发 \u000b 等，浏览器会显示成 �）
    .replace(/\u000b/gi, "μ")
    .replace(/[\u0000-\u0008\u000c\u000e-\u001f\u007f]/g, "");
  s = s.replace(/\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$/g, protectMath);
  s = s.replace(/\\\([\s\S]*?\\\)|\$(?!\s)[^$\n]+?\$(?!\w)/g, protectMath);
  let html = kbEsc(s);
  html = html.replace(/\[\[([^\[\]]+?)\]\]/g, (m, inner) => {
    const sep = inner.indexOf("|");
    const nm = (sep >= 0 ? inner.slice(0, sep) : inner).trim();
    const al = (sep >= 0 ? inner.slice(sep + 1) : inner).trim() || nm;
    if (!nm || nm.includes("\x00") || al.includes("\x00")) return m;
    return `<a class="kb-wl-link" href="javascript:void(0)" data-link-name="${kbEsc(nm)}">[[${kbEsc(al)}]]</a>`;
  });
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const lines = html.split("\n");
  const out = [];
  let inList = false;
  for (const raw of lines) {
    const h = raw.match(/^(#{1,4})\s+(.*)$/);
    if (h) { if (inList) { out.push("</ul>"); inList = false; } out.push(`<h${h[1].length}>${restoreMath(h[2])}</h${h[1].length}>`); continue; }
    const li = raw.match(/^\s*[-*]\s+(.*)$/);
    if (li) { if (!inList) { out.push("<ul>"); inList = true; } out.push(`<li>${restoreMath(li[1])}</li>`); continue; }
    if (inList) { out.push("</ul>"); inList = false; }
    if (!raw.trim()) continue;
    out.push(`<p>${restoreMath(raw)}</p>`);
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}

// 宽松 JSON 解析：弱模型输出的 JSON 常带三类「肉眼看不出的非法字符」，严格 JSON.parse 会直接抛异常，
// 导致整段原始 JSON 被当正文漏给用户：
//   1) 字符串值里的裸换行 / 回车 / 制表符（HTML 渲染时被折叠，用户看不出，但 JSON.parse 必然失败）
//   2) ] 或 } 前的悬挂逗号
//   3) 字符串值里未转义的英文引号（如「他说"你好"了」）
// 修复只动结构、不动内容：1) 在字符串内转义控制字符，2) 只在字符串外丢逗号，
// 3) 用「向后看」启发式区分内容引号与真正的收尾引号——收尾引号后面紧跟 , } ] : 之一。
function kbJsonParseLoose(raw) {
  const s = String(raw ?? "");
  let out = "";
  let inStr = false, esc = false;
  const nextNonWs = (k) => {
    while (k < s.length && /\s/.test(s[k])) k++;
    return k < s.length ? s[k] : "";
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { out += c; esc = false; continue; }
      if (c === "\\") {
        // JSON 只认 \" \\ \/ \b \f \n \r \t \uXXXX 这几种转义；\c \m \d \s 等是非法的，
        // 而 LaTeX 命令（\frac \cos \Delta \varphi...）几乎必然带这类序列，且 \f \b 还会被
        // 悄悄解析成控制字符毁掉内容。判据：\ 后是字母，且（后两字符也是字母 => \frac 这类
        // 多字母命令）或（该字母不属于标准转义集 => \d \s 这类非法转义），就当 LaTeX 处理，
        // 把反斜杠转成 \\ 让内容原样保留。
        const n1 = s[i + 1];
        if (n1 === undefined) { out += "\\\\"; continue; }
        const STD = 'bfnrt"\\/';
        // LaTeX 命令判据：\后是字母，且（命令名至少两个字母，如 \frac \Delta）
        // 或（该字母不属于标准转义集，如 \d \s \o）
        const looksLikeLatex = /[a-zA-Z]/.test(n1) &&
            (/[a-zA-Z]/.test(s[i + 2] || "") || !STD.includes(n1));
        if (looksLikeLatex) {
          out += "\\\\";
          esc = true;
          continue;
        }
        out += c;
        esc = true;
        continue;
      }
      if (c === '"') {
        // 后面紧跟结构符才算收尾引号，否则视为内容里的引号，转义之
        if (",}]:\"".includes(nextNonWs(i + 1))) { inStr = false; out += c; }
        else out += '\\"';
        continue;
      }
      if (c === "\n") { out += "\\n"; continue; }
      if (c === "\r") { out += "\\r"; continue; }
      if (c === "\t") { out += "\\t"; continue; }
      out += c;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === ",") {
      // 悬挂逗号：向后看第一个非空白字符，若是 } 或 ] 则丢弃该逗号
      let k = i + 1;
      while (k < s.length && /\s/.test(s[k])) k++;
      if (k < s.length && (s[k] === "}" || s[k] === "]")) continue;
    }
    out += c;
  }
  try { return JSON.parse(out); } catch (_) { return null; }
}
// 先严格解析（零风险路径），失败再用宽松解析兜底
function kbJsonTryParse(raw) {
  try { return JSON.parse(String(raw ?? "")); } catch (_) { return kbJsonParseLoose(raw); }
}
// 引导模式下，模型可能直接返回苏格拉底结构化 JSON（{question,hints,answer,answer_hidden,next_action}）。
// 抽出来渲染成干净的问题卡片，而不是把原始 JSON 当正文扔给用户。
// answer 字段在「查看答案」短路时出现，渲染成可展开的答案块。
// 返回 { obj: 苏格拉底对象, pre: JSON 前面的说明文字 }；找不到则返回 null。
function kbTryParseSocratic(text) {
  const isSoc = (o) => o && typeof o === "object" && !Array.isArray(o) && (o.question || o.hints);
  let raw = String(text ?? "").trim();
  // 双重编码兜底：多次引导续问后，弱模型偶发把苏格拉底 JSON 再套一层字符串转义输出
  // （形如 `"{\"question\":\"...\"}"`，最外是英文引号、内含 \ 转义）。先解一次壳再走正常解析，
  // 否则 kbExtractFirstJsonObject 会把内侧转义 JSON 当普通文本、最终把一坨转义 JSON 漏给用户。
  for (let _i = 0; _i < 3; _i++) {
    if (!(raw.startsWith('"') && raw.endsWith('"'))) break;
    let inner;
    try { inner = JSON.parse(raw); } catch { break; }
    if (typeof inner !== "string") break;
    const p = String(inner).trim();
    if (!(p.startsWith("{") || p.startsWith('"'))) break;
    raw = p;
  }
  // 1) 整段就是（或被 ```json 围栏包裹的）JSON：最快路径
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  if (candidate.startsWith("{") && candidate.endsWith("}")) {
    const obj = kbJsonTryParse(candidate);
    if (isSoc(obj)) return { obj, pre: fenced ? raw.slice(0, raw.indexOf("```")).trim() : "" };
  }
  // 2) JSON 外层裹了模型写的说明文字（例：`好，下面来考你：{...}`）：从容错提取第一个 JSON 对象。
  //    前缀说明里可能含 LaTeX 下标花括号（如 $h_{i+1}$），首个 {...} 会是 `{i+1}` 这种数学碎片而非
  //    真正的 JSON——所以解析失败不能就此放弃，要从该对象之后继续扫描下一个候选，直到成功或扫完。
  let cursor = 0;
  for (let guard = 0; guard < 50; guard++) {
    const cut = kbExtractFirstJsonObject(raw, cursor);
    if (!cut) break;
    const obj = kbJsonTryParse(cut.json);
    if (isSoc(obj)) return { obj, pre: raw.slice(0, cut.start).trim() };
    cursor = cut.start + 1;
  }
  return null;
}
// 从任意文本中提取一个完整的 JSON 对象（跳过字符串与转义），可指定扫描起点，
// 返回 { pre, json, start }（start 为 `{` 在原文中的下标）；找不到则返回 null
function kbExtractFirstJsonObject(text, from = 0) {
  const s = String(text ?? "");
  let start = -1, depth = 0, inStr = false, esc = false;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") { if (start < 0) start = i; depth++; continue; }
    if (c === "}") {
      if (start < 0) continue;
      depth--;
      if (depth === 0) return { pre: s.slice(from, start).trim(), json: s.slice(start, i + 1), start };
    }
  }
  return null;
}
function kbStreamHtml(stream) {
  // 流式中途的苏格拉底 JSON 还没收尾，直接渲染会露出原始 JSON；
  // 未闭合前显示轻量占位，收尾后由 kbRenderAnswer 完整解析成问题卡片。
  const t = String(stream || "").trim();
  const doneJson = t.endsWith("}") || t.endsWith("```");
  if ((t.startsWith("{") || t.startsWith("```") || kbJsonInProgress(t)) && !doneJson) {
    return `<span class="kb-loading">正在组织引导问题…</span>`;
  }
  return kbRenderAnswer(t);
}
// 判定流式文本里是否有一个尚未闭合的 JSON 对象（含说明文字前缀也适用），有则渲染暂缓
function kbJsonInProgress(text) {
  const s = String(text ?? "");
  let depth = 0, inStr = false, esc = false, sawBrace = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") { sawBrace = true; depth++; continue; }
    if (c === "}") { if (depth > 0) depth--; continue; }
  }
  return sawBrace && (depth > 0 || inStr);
}
// 收敛点说明已由底部 apply/redo/stop 按钮承担，这里把 AI 回答正文里的收敛点文字剥掉
function kbStripConverge(text) {
  let s = String(text || "");
  // 收敛点标题块（**收敛点选择/**收敛点：…）
  s = s.replace(/^[ \t]*[#>*\-\s]*收敛点[：:][^\n]*(\n|$)/gim, " ");
  // 收敛点三选一的选项行：- apply（…）／- redo（…）／- stop（…）
  s = s.replace(/^[ \t]*[-•*]?\s*(apply|redo|stop)\b[^\n]*(\n|$)/gim, " ");
  // 行内「apply／redo／stop（…）」串（可能被折叠在普通段落）
  s = s.replace(/\s*[（(]\s*apply\s*(?:\uFF0F|\/)\s*redo\s*(?:\uFF0F|\/)\s*stop\s*[)）][^\n]*(\n|$)/gi, " ");
  // 引导回答里被模型复述的确认/操作行（如「请确认是否进入下一问？」「✓ 执行双链 · 新建节点」）。
  // 这些操作的语义由底部收敛条按钮承担，响应正文不应再出现，避免红框混入建链/确认类说明。
  s = s.replace(/^[ \t]*[-•*]?(?:请)?确认[^\n]*?(?:下一问|下一题|是否|双链|新建节点)[^\n]*(\n|$)/gim, " ");
  s = s.replace(/^[ \t]*[-•*]?✓[ \t]*[^\n]*(?:执行双链|新建节点|采用此笔记|按此补漏)[^\n]*(\n|$)/gim, " ");
  return s.replace(/[ \t]{2,}/g, " ").trim();
}
function kbRenderAnswer(text) {
  const s = kbTryParseSocratic(text);
  if (!s) return kbRenderMarkdown(kbStripConverge(text));
  const obj = s.obj;
  const qs = Array.isArray(obj.question) ? obj.question : [obj.question];
  const qHtml = qs.filter((x) => String(x ?? "").trim())
    .map((q) => `<li>${kbRenderMarkdown(String(q))}</li>`).join("");
  const hints = Array.isArray(obj.hints) ? obj.hints : [obj.hints];
  const hList = hints.filter((x) => String(x ?? "").trim())
    .map((h) => `<li>${kbRenderMarkdown(String(h))}</li>`).join("");
  const preHtml = s.pre ? kbRenderMarkdown(kbStripConverge(s.pre)) : "";
  // 「查看答案」短路时后端会把完整解答写进 answer 字段；有 answer 就优先展示可展开的答案块，
  // 此时不再显示「答案暂不直接给」的提示，两者语义互斥。
  const hasAnswer = String(obj.answer ?? "").trim().length > 0;
  const answerBlock = hasAnswer
    ? `<details class="kb-socratic-answer"><summary>答案与讲解（点击展开）</summary><div class="kb-socratic-answer-body">${kbRenderMarkdown(String(obj.answer))}</div></details>`
    : "";
  const hiddenNote = !hasAnswer && obj.answer_hidden
    ? `<div class="kb-socratic-note">答案暂不直接给，答完由我评估再继续。</div>`
    : "";
  return `
    ${preHtml}
    <div class="kb-socratic-card">
      <div class="kb-socratic-head">苏格拉底引导 · ${obj.next_action ? escapeHtml(String(obj.next_action)) : "出题"}</div>
      <ol class="kb-socratic-questions">${qHtml || "<li>（未提供题干）</li>"}</ol>
      ${hList ? `<details class="kb-socratic-hints"><summary>提示（先自己答，再展开）</summary><ul>${hList}</ul></details>` : ""}
      ${answerBlock}
      ${hiddenNote}
    </div>`;
}

// ---- 整理助手（Agent）----
const KB_AGENT_COMMANDS = {
  patch: "请根据我对整个知识库的掌握情况，给出建议的补漏与复习顺序，并说明理由。",
  link: "请以当前聚焦节点为锚，给出双链推荐：1) 列举知识库里已有节点之间值得建立的双链并说明为什么相关；2) 同时调用 recommend_link_gaps 识别图谱中还不存在、但值得以当前节点为锚补全进去的新知识点，并对其给出补全小结；3) 对缺失节点，说明用户只需确认即可由你 add_node 新建并 create_link 建链，完成后提示可返回双链图谱查看。",
};

// 会真正改动知识库/产生待批准内容的工具：本轮命中了任一，收敛点才需要 apply/redo/stop
const KB_WRITE_TOOLS = new Set(["add_node", "update_node", "create_link", "delete_node", "propose_note", "complete_note"]);
function kbAgentPaneMarkup() {
  return `
    <div class="kb-agent-wrap">
      <div class="kb-agent-nodebar" data-kb-agent-nodebar hidden>
        <span class="kb-agent-node-tag">当前节点</span>
        <strong class="kb-agent-node-name" data-kb-agent-node-name></strong>
        <span class="kb-agent-node-actions">
          <button class="mini-button primary" type="button" data-kb-cmd="complete" aria-label="补全当前节点笔记" title="用 AI 生成详细高质量笔记，作为待批准建议稿">✎ 补全当前节点笔记</button>
          <span class="kb-ai-seg" role="group" aria-label="AI 学习互动">
            <button class="mini-button" type="button" data-kb-cmd="discuss" aria-label="AI 同学讨论" title="以当前节点为锚点，进入海小棠学习小组讨论">AI 同学讨论</button>
            <button class="mini-button" type="button" data-kb-cmd="guide" aria-label="苏格拉底引导当前节点" title="从当前节点进入苏格拉底式引导学习">苏格拉底引导</button>
          </span>
        </span>
      </div>
      <div class="kb-agent-commands" role="group" aria-label="快捷指令">
        <button class="mini-button" type="button" data-kb-cmd="patch">🧭 建议补漏顺序</button>
        <button class="mini-button" type="button" data-kb-cmd="link">🔗 推荐双链</button>
      </div>
      <div class="kb-wb-grid" data-kb-wb-grid>
        <div class="kb-guide-preview" data-kb-guide-preview hidden></div>
        <div class="kb-msgs-col">
          <div class="kb-agent-messages" data-kb-agent-msgs></div>
          <div class="discussion-pane" id="discussion-pane"></div>
        </div>
      </div>
      <div class="kb-agent-composer">
        <textarea data-kb-agent-input rows="2" placeholder="跟整理助手聊聊，让它帮你梳理知识库…"></textarea>
        <button class="primary-button kb-voice-btn" type="button" data-kb-agent-voice title="语音输入" aria-label="语音输入">🎤 语音</button>
        <button class="primary-button" type="button" data-kb-agent-send>发送</button>
      </div>
      <div class="kb-converge-bar" data-kb-converge-bar hidden>
        <span class="kb-converge-job" data-kb-converge-job></span>
        <button class="mini-button" type="button" data-kb-conv="apply" title="已答对，继续引导下一问">✓ 继续下一问 apply</button>
        <button class="mini-button" type="button" data-kb-conv="redo" title="直接给出当前这一问的答案与讲解">📖 查看答案 redo</button>
        <button class="mini-button" type="button" data-kb-conv="stop" title="停止本轮引导">⏹ 停止引导 stop</button>
      </div>
    </div>`;
}
function renderMemoryBadge() {
  const badge = document.querySelector("[data-kb-digest-badge]");
  if (!badge) return;
  const d = state.kbDigest;
  if (!d) { badge.textContent = "记忆…"; return; }
  const stats = d.stats || {};
  const weak = Array.isArray(d.weak_points) ? d.weak_points.length : 0;
  const gaps = Array.isArray(d.gaps) ? d.gaps.length : 0;
  badge.textContent = `已记忆 ${stats.node_count ?? "?"} 节点 · 薄弱 ${weak} · 缺笔记 ${gaps}`;
}
function renderSessionSelect() {
  const sel = document.querySelector("[data-kb-session-select]");
  if (!sel) return;
  const prev = state.kbConversationId;
  sel.innerHTML = `<option value="">新建会话</option>` +
    state.kbSessionList.map((s) =>
      `<option value="${escapeHtml(s.conversation_id)}"${s.conversation_id === prev ? " selected" : ""}>${escapeHtml((s.title || "会话").slice(0, 24))}</option>`
    ).join("");
}
function renderProposalCount() {
  const el = document.querySelector("[data-kb-prop-count]");
  if (el) el.textContent = state.kbProposals.length;
}
function bindAgentPane(dock) {
  const msgs = dock.querySelector("[data-kb-agent-msgs]");
  const input = dock.querySelector("[data-kb-agent-input]");
  const send = dock.querySelector("[data-kb-agent-send]");
  const push = () => { if (state.kbAgentBusy) return; const v = (input.value || "").trim(); if (!v) return; input.value = ""; kbAgentTurn(v, msgs); };
  if (send) send.addEventListener("click", push);
  if (input) input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); push(); } });
  const voice = dock.querySelector("[data-kb-agent-voice]");
  if (voice) {
    const voiceInput = () => {
      if (state.kbAgentBusy) return;
      if (!("webkitSpeechRecognition" in window || "SpeechRecognition" in window)) {
        showToast("您的浏览器不支持语音输入，请手动输入。", "error");
        return;
      }
      const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      const rec = new Recognition();
      rec.lang = "zh-CN";
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      const prevPlaceholder = input ? input.placeholder : "";
      const restore = () => {
        if (voice) { voice.disabled = false; voice.textContent = "🎤 语音"; }
        if (input) input.placeholder = prevPlaceholder;
      };
      voice.disabled = true;
      voice.textContent = "聆听中…";
      if (input) { input.placeholder = "正在聆听…"; input.focus(); }
      rec.start();
      rec.onresult = (e) => {
        const t = e.results[0] && e.results[0][0] ? e.results[0][0].transcript : "";
        if (t && input) input.value = input.value ? input.value + " " + t : t;
      };
      rec.onerror = () => { showToast("语音输入失败，请重试或手动输入。", "error"); restore(); };
      rec.onend = (e) => { if (e && e.error) return; restore(); };
    };
    voice.addEventListener("click", voiceInput);
  }
  dock.querySelectorAll("[data-kb-cmd]").forEach((b) => {
    b.addEventListener("click", async () => {
      const cmd = b.dataset.kbCmd;
      if (cmd === "complete") { await kbCompleteNodeNote(); return; }
      if (cmd === "discuss") {
        if (!state.kbFocusNodeId) { showToast("请先在知识图谱点击一个节点，再发起讨论。", "error"); return; }
        openDiscussionForNode(state.kbFocusNodeId);
        return;
      }
      if (cmd === "guide") {
        // 讨论态与引导态并行：从讨论态点「苏格拉底引导」先退回引导会话界面
        if (document.querySelector(".kb-agent-wrap.is-discussing")) {
          discussionExit();
          if (state.kbAgentMode !== "guide" && state.kbFocusNodeId) kbStartGuide(state.kbFocusNodeId);
          return;
        }
        if (state.kbAgentMode === "guide") { kbExitGuide(); return; }
        if (state.kbFocusNodeId) kbStartGuide(state.kbFocusNodeId);
        return;
      }
      const text = KB_AGENT_COMMANDS[cmd];
      if (text) {
        // 建议补漏顺序 / 推荐双链：自动退回整理会话界面（图一）再执行
        discussionExit();
        if (state.kbAgentBusy) return;
        kbAgentTurn(text, msgs);
      }
    });
  });
  // 根据笔记引导：点索引项 → 放大查看该条完整笔记 + AI 围绕该要点引导复习
  if (msgs) msgs.addEventListener("click", (e) => {
    const it = e.target.closest("[data-note-idx-item]");
    if (!it) return;
    const id = it.dataset.noteIdxItem;
    const row = (state.kbNoteGuideIndex || []).find((r) => String(r.id) === String(id));
    if (!row) return;
    const node = (state.nodes || []).find((n) => n.node_id === state.kbFocusNodeId);
    kbOpenProposalZoom({ content: row.full, nodeName: node ? `${node.name} · ${row.tag}` : row.tag });
    if (state.kbAgentBusy) return;
    kbAgentTurn(`围绕当前节点笔记${row.tag}「${row.text}」对我做引导复习：先让我用自己的话复述，答对前不给完整讲解，逐步出题巩固。`, msgs);
  });
  const sessionSelect = dock.querySelector("[data-kb-session-select]");
  if (sessionSelect) sessionSelect.addEventListener("change", async (e) => {
    const cid = e.target.value;
    if (!cid) { kbStartNewConversation(msgs); return; }
    await kbLoadConversation(cid, msgs);
  });
  const newBtn = dock.querySelector("[data-kb-new-session]");
  if (newBtn) newBtn.addEventListener("click", () => kbStartNewConversation(msgs));
  const propToggle = dock.querySelector("[data-kb-toggle-proposals]");
  if (propToggle) propToggle.addEventListener("click", () => kbToggleProposals(dock));
  // 建议稿按钮事件冒泡委托
  dock.addEventListener("click", onProposalAction);
  // 引导收敛点快回（apply / redo / stop）
  dock.querySelectorAll("[data-kb-conv]").forEach((b) => {
    b.addEventListener("click", () => {
      // 生成中只放行 stop（用于中断）；apply/redo 在生成中禁点
      if (state.kbAgentBusy && b.dataset.kbConv !== "stop") return;
      const cmd = b.dataset.kbConv;
      if (cmd === "apply") {
        // apply 已执行则置灰，避免重复固化/建链形成循环；redo/stop 或新任务再激活
        state.kbConvergeApplied = true;
        kbPersistConverge();
        kbRenderConvergeBar();
      } else if (cmd === "stop") {
        // stop：生成中点击即中断对话生成；不生成时按钮置灰不可点（不发任何对话）
        if (state.kbAgentBusy && state.kbAbortCtrl) state.kbAbortCtrl.abort();
        return;
      } else {
        state.kbConvergeApplied = false; // 重做后允许再次 apply
        kbPersistConverge();
        kbRenderConvergeBar();
      }
      b.disabled = true; // 防止连点重复固化/建链
      let sendText = ""; // 气泡里展示给用户的中文指令
      let wireToken = ""; // 命中后端收敛短路所需的裸 token（仅默认引导任务；其余任务走工具循环，必须发完整指令）
      const _task = state.kbConvergeTask;
      if (cmd === "apply") {
        if (_task === "review") {
          // 补漏复习的 apply：不再重新生成建议，而是执行状态汇报 + 逐个引导复习薄弱点
          sendText = "我已按这套补漏顺序开始复习。请先做一次补漏状态汇报（当前共有哪些薄弱点、各自掌握情况），然后对照每个薄弱点逐个引导我复习：先让我用自己的话复述，答对前不要直接给完整讲解，一次只引导一个薄弱点，循序渐进。";
        } else if (_task === "graph") {
          // 建双链的 apply：不再重复推荐，而是真正执行建链（逐条建立并给连接理由）
          sendText = "请执行我刚才同意的双链：把已推荐并确认的这些关联实际建立起来（逐条调用建链工具，每条都要给出连接理由），建完汇报结果即可，不要重复推荐新的双链。";
        } else if (_task === "note") {
          // 补全笔记的 apply：采纳当前建议稿写入知识库
          sendText = "我采纳这版补全笔记建议稿。请按建议稿内容将笔记写入当前节点的知识库，写完汇报即可，不要重复生成建议。";
        } else {
          // 引导的 apply：用户确认本题已掌握，继续下一问
          wireToken = "apply";
          sendText = "这一问我已经掌握了，请继续引导下一个问题。";
        }
      } else if (cmd === "redo") {
        // 重做：明确只重新做一次当前任务并归位，等用户确认，绝不连续多次重做
        if (_task === "note") {
          sendText = "请重新补全当前这个节点的笔记：按要求重新生成一版建议稿，生成完就停下来等我确认，先不要写入库，也不要连续多次补全。";
        } else if (_task === "graph") {
          sendText = "请重新评估这两个节点的双链：调整并重新列出关联候选，先不要执行建链，列完等我确认即可。";
        } else if (_task === "review") {
          sendText = "请换一批补漏建议：重新给出补漏顺序，先不要执行，等我再确认。";
        } else {
          // 「查看答案」：必须发裸 token，后端才会短路成单次生成并要求模型交出完整解答
          wireToken = "redo";
          sendText = "这一问我答不上来，请直接给出当前这一问的答案与讲解。";
        }
      }
      kbAgentTurn(wireToken || sendText, msgs, sendText);
    });
  });
  // 首屏减负：记忆徽章、待批准建议稿都不是「打开节点」这件事的必要条件，
// 延后到整理助手真正被打开（kbDockSwitch 切到 agent）时再取，避免刚进面板就打三个接口。
  kbRenderAgentFocus();
  kbRenderAgentMessages(msgs);
  _kbSetupSelectionGuide(); // 选中整理预览/对话文字 → 引导对话 + 生成选中索引
  _kbSetupNoteIndexDiscuss(); // 整理预览「笔记索引」→ 点某条即围绕它发起 AI 同学讨论
}

async function kbLoadSessions(nodeId) {
  // 会话按节点独立：nodeId 缺省时用当前聚焦节点；无节点聚焦则为库级全局会话
  const group = (nodeId !== undefined ? nodeId : kbActiveNodeGroup()) || "";
  try {
    const q = group ? `?node_id=${encodeURIComponent(group)}` : "";
    const data = await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/agent/sessions${q}`);
    // AI 同学讨论会话与引导/整理共用 kb_conversations 存同节点，切到苏格拉底引导时不得装载进引导流
    const sessions = (data.sessions || []).filter((s) => (s.summary || {}).kind !== "discussion");
    state.kbSessionList = sessions;
    renderSessionSelect();
    // 自动装载本组会话：优先记住的，其次最近一条；都没有则空会话（等待新建）
    const inList = (cid) => (state.kbSessionList || []).some((s) => s.conversation_id === cid);
    let target = (state.kbConvByNode[group] && inList(state.kbConvByNode[group])) ? state.kbConvByNode[group] : null;
    if (!target && state.kbSessionList.length && !inList(state.kbConversationId)) {
      target = state.kbSessionList[0].conversation_id;
    }
    if (target && state.kbConversationId !== target) {
      await kbLoadConversation(target);
      return true; // 已续接该节点历史会话
    } else if (!target && !state.kbConversationId) {
      state.kbConversationId = null;
      state.kbAgentMessages = [];
      renderSessionSelect();
      const msgs = kbAgentMsgsEl();
      if (msgs) kbRenderAgentMessages(msgs);
      return false; // 无历史且无可装载会话 → 全新
    }
    // 当前会话已属于本组且已装载 → 视为已有历史
    return Boolean(state.kbConversationId && state.kbAgentMessages.length);
  } catch { return false; }
}
function kbActiveNodeGroup() { return state.kbFocusNodeId || ""; }
function kbAgentMsgsEl() {
  const dock = kbGetDock();
  return dock ? dock.querySelector("[data-kb-agent-msgs]") : null;
}
async function kbLoadConversation(cid, msgs) {
  try {
    const data = await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/agent/sessions/${encodeURIComponent(cid)}`);
    const msgsArr = data.messages || [];
    state.kbConversationId = cid;
    state.kbAgentMessages = msgsArr.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      html: m.role === "assistant" ? kbRenderAnswer(m.content || "") : renderMathContent(m.content || ""),
      meta: m.meta || {},
    }));
    renderSessionSelect();
    kbRenderAgentMessages(msgs || kbAgentMsgsEl());
  } catch (err) {
    state.kbAgentMessages.push({ role: "assistant", html: `<div class="kb-err">${escapeHtml(err.message || "加载会话失败")}</div>` });
    kbRenderAgentMessages(msgs || kbAgentMsgsEl());
  }
}
function kbStartNewConversation(msgs) {
  // 新建会话归属于当前聚焦节点；节点保持聚焦，避免新建后丢失节点上下文
  const group = kbActiveNodeGroup();
  if (group) { delete state.kbConvByNode[group]; }
  state.kbConversationId = null;
  state.kbAgentMessages = [];
  state.kbAgentMode = "default";
  renderSessionSelect();
  kbRenderAgentFocus();
  kbRenderAgentMessages(msgs);
}

// 框架即入口：选中某节点 → 在这里进入苏格拉底式引导，聚焦该节点
function kbStartGuide(nodeId) {
  discussionExit(); // 苏格拉底引导与 AI 同学讨论并行：进入引导即退出讨论态
  const node = (state.nodes || []).find((n) => n.node_id === nodeId);
  state.kbAgentMode = "guide";
  // 海小棠桌宠：进入引导模式广播，桌宠据此趴到不挡视线的位置
  document.dispatchEvent(new CustomEvent("knoworigin:pet-guide", { detail: { active: true, nodeId } }));
  state.kbNoteGuideIndex = [];
  state.kbConvergeTask = "guide"; // 进入引导学习时收敛条回到默认引导语义
  state.kbConvergeApplied = false; // 防循环：进入引导重新激活 apply
  state.kbConvergeActive = true;   // 进入引导即显示收敛条（继续下一问 / 查看答案 / 停止）
  state.kbFocusNodeId = nodeId;
  kbPersistConverge();
  const dock = kbGetDock();
  if (dock) { dock.hidden = false; kbDockSwitch(dock, "agent"); }
  kbRenderAgentFocus();
  const msgs = dock ? dock.querySelector("[data-kb-agent-msgs]") : null;
  // 以该节点是否已有会话为续接依据：有历史 → 装载最近会话接着上次进度引导，不再重发开场
  kbLoadSessions(nodeId).then((hadSession) => {
    if (hadSession) return;
    let starter = `请用苏格拉底式引导的方法，带我学习节点「${node ? node.name : nodeId}」，先诊断我再一步步出题（不到你说出答案不铺开讲解）。`;
    if (node && (node.note_content || "").trim()) {
      starter += `\n\n我已写下的笔记如下，请结合它来引导：\n----\n${node.note_content}\n----`;
    }
    kbAgentTurn(starter, msgs);
  });
}

// 把三段式笔记（一句话摘要 / 要点索引 / 易错或适用条件）宽松解析成索引项
function kbParseNoteIndex(note) {
  const rows = [];
  const cnt = { 摘要: 0, 要点: 0, 易错: 0 };
  const push = (tag, label, text) => {
    const t = String(text || "").trim().replace(/[*#`]/g, "");
    if (!t) return;
    const key = tag === "摘要" ? "ni-summary" : tag === "易错" ? "ni-pitfall" : `ni-point${++cnt.要点}`;
    rows.push({ id: key, tag, label, text: t, full: t });
  };
  const lines = String(note || "").split("\n").map((s) => s.replace(/\r/g, "").trim()).filter(Boolean);
  const para = [];
  const KEY = /^(一句话)?(摘要|要点|易错|适用|注意|易错\/适用|适用条件)/;
  for (const ln of lines) {
    const m = ln.match(/^[-*•]\s+(.+)$/);
    if (m) { push("要点", "要点", m[1]); continue; }
    if (KEY.test(ln)) {
      const seg = ln.split(/[:：]/).slice(1).join("：" ).trim();
      let tag = "易错";
      if (/^(一句话)?摘要/.test(ln)) tag = "摘要";
      else if (/^(要点)/.test(ln)) tag = "要点";
      push(tag, tag, seg || ln);
      continue;
    }
    para.push(ln);
  }
  // 剩余非列表段落：第一段归摘要，末尾若含关键词归易错
  const firstPara = para.find((p) => !KEY.test(p)) || para[0] || "";
  if (firstPara) push("摘要", "一句话摘要", firstPara);
  const pit = para.find((p) => /(易错|适用|注意|前提|条件)/.test(p));
  const lastPara = pit || para[para.length - 1];
  if (lastPara && lastPara !== firstPara) push("易错", "易错或适用", lastPara);
  return rows;
}
// 工作台整理预览的统一渲染：头部带「笔记索引」按钮（选某条即可围绕它讨论/引导），供引导态与讨论态共用。
// keepOpen 用于在触发讨论/引导后仍保留已展开的索引浮层，不随重渲染消失。
function kbWbPreviewHTML(node, emptyText, keepOpen) {
  const head =
    `<div class="kb-wb-preview-head"><span class="kb-wb-preview-title">整理预览 · ${escapeHtml(node.name)}</span>` +
    `<button type="button" class="mini-button kb-wb-idx-btn" data-kb-note-idx-discuss title="把节点笔记做成索引，选某条即可围绕它讨论或引导">📌 笔记索引</button></div>`;
  const body = (node.note_content || "").trim()
    ? `<div class="kb-wb-preview-md">${highlightableMarkup(`kbnote:${escapeAttr(node.node_id)}`, kbRenderMarkdown(node.note_content))}</div>`
    : `<p class="kb-muted kb-wb-preview-empty">${emptyText}</p>`;
  const open = keepOpen && keepOpen.nodeId === node.node_id ? keepOpen : null;
  const picker = open
    ? `<div class="kb-note-idx-discuss" data-kb-note-idx-picker>${kbNoteIdxDiscussHTML(open.rows, kbNoteIdxCurrentMode())}</div>`
    : `<div class="kb-note-idx-discuss" data-kb-note-idx-picker hidden></div>`;
  // 浮层生成在笔记正文上方，便于直接对照选取
  return `${head}${picker}${body}`;
}
// 当前语境：AI 同学讨论态 → "discuss"；苏格拉底引导态（及预览可见的一般态）→ "guide"
function kbNoteIdxCurrentMode() {
  const wrap = document.querySelector(".kb-agent-wrap");
  return wrap && wrap.classList.contains("is-discussing") ? "discuss" : "guide";
}
function kbNoteIdxDiscussHTML(rows, mode) {
  const discuss = mode !== "guide";
  const actionHtml = (r) => discuss
    ? `<button type="button" class="mini-button" data-note-idx-discuss="${escapeAttr(r.id)}" title="以这条笔记为焦点召集海小棠学习小组讨论">💬 讨论</button>`
    : `<button type="button" class="mini-button" data-note-idx-guide="${escapeAttr(r.id)}" title="围绕这条笔记做苏格拉底式引导复习">🧭 引导</button>`;
  return `<div class="kb-note-idx-discuss-panel">
    <div class="kb-note-idx-discuss-head">${discuss ? "围绕哪条笔记讨论？" : "围绕哪条笔记引导？"}</div>
    <ul>${rows.map((r) =>
      `<li class="kb-note-idx-entry" data-note-idx-entry="${escapeAttr(r.id)}">` +
      `<span class="kb-note-idx-tag" data-tag="${escapeAttr(r.tag)}">${escapeHtml(r.tag)}</span>` +
      `<span class="kb-note-idx-text">${renderMathContent(r.text)}</span>` +
      `<span class="kb-note-idx-actions">${actionHtml(r)}</span></li>`
    ).join("")}</ul>
    <p class="kb-muted kb-note-idx-tip">${discuss ? "点「讨论」即以该条笔记为焦点，召集海小棠学习小组讨论。" : "点「引导」即围绕该条笔记逐问引导复习。"}</p>
  </div>`;
}
function kbToggleNoteIdxDiscuss(panel) {
  const node = (state.nodes || []).find((n) => n.node_id === (panel && panel.dataset.kbPreviewNode)) ||
    (state.nodes || []).find((n) => n.node_id === state.kbFocusNodeId);
  const holder = panel && panel.querySelector("[data-kb-note-idx-picker]");
  if (!holder) return;
  if (!holder.hidden) { holder.hidden = true; _kbNoteIdxOpen = null; return; }
  const note = String((node && node.note_content) || "").trim();
  if (!note) { showToast("该节点还没有笔记，可先用「补全当前节点笔记」生成后再讨论。", "error"); return; }
  const rows = kbParseNoteIndex(note);
  if (!rows.length) { showToast("暂未从笔记中解析出可讨论的索引，可直接划选正文触发讨论。", "notice"); return; }
  const html = kbNoteIdxDiscussHTML(rows, kbNoteIdxCurrentMode());
  holder.innerHTML = html;
  holder.hidden = false;
  if (node) _kbNoteIdxOpen = { nodeId: node.node_id, rows };
}
function kbNoteIdxStartDiscuss(btn) {
  const panel = btn.closest("[data-kb-guide-preview]");
  const nodeId = (panel && panel.dataset.kbPreviewNode) || state.kbFocusNodeId;
  if (!nodeId) { showToast("请先在知识图谱点击一个节点，再围绕某条笔记发起讨论。", "error"); return; }
  const node = (state.nodes || []).find((n) => n.node_id === nodeId);
  if (!node) { showToast("当前知识点不在本项目图谱里，请先切到对应项目。", "error"); return; }
  const row = kbParseNoteIndex(String(node.note_content || ""))
    .find((r) => String(r.id) === String(btn.dataset.noteIdxDiscuss));
  if (!row) return;
  const sameNodeDiscussing = _discussionCtx && _discussionCtx.cid && _discussionCtx.nodeId === nodeId;
  openDiscussionForNode(nodeId, { quote: row.full, force: Boolean(sameNodeDiscussing) });
}
// 笔记索引 → 苏格拉底引导：严格围绕所选索引条目展开逐问复习
function kbNoteIdxStartGuide(btn) {
  const panel = btn.closest("[data-kb-guide-preview]");
  const nodeId = (panel && panel.dataset.kbPreviewNode) || state.kbFocusNodeId;
  if (!nodeId) { showToast("请先在知识图谱点击一个节点，再围绕某条笔记引导。", "error"); return; }
  const node = (state.nodes || []).find((n) => n.node_id === nodeId);
  if (!node) { showToast("当前知识点不在本项目图谱里，请先切到对应项目。", "error"); return; }
  const row = kbParseNoteIndex(String(node.note_content || ""))
    .find((r) => String(r.id) === String(btn.dataset.noteIdxGuide));
  if (!row) return;
  if (state.kbAgentBusy) { showToast("助手正在处理上一轮，请稍候再试。", "error"); return; }
  discussionExit(); // 从讨论态退回，再围绕该条笔记做引导
  const msgs = kbAgentMsgsEl();
  state.kbAgentMessages.push({
    role: "user",
    html: `<div class="kb-sel-cite"><div class="kb-sel-cite-head">笔记索引 · ${escapeHtml(node.name)} · ${escapeHtml(row.tag)}</div><div class="kb-sel-cite-body">${escapeHtml(row.full)}</div></div>`,
  });
  state.kbAgentMode = "guide";
  state.kbFocusNodeId = nodeId;
  kbRenderAgentFocus();
  kbRenderAgentMessages(msgs);
  kbAgentTurn(`围绕当前节点笔记${row.tag}「${row.text}」对我做苏格拉底式引导复习：先让我用自己的话复述，答对前不给完整讲解，逐步出题巩固，严格只围绕这条笔记展开，不要扯到别的内容。`, msgs);
}
let _kbNoteIdxOpen = null; // 已展开索引浮层（nodeId + rows），触发讨论/引导后仍保留，重渲染时按当前语境重生成
function _kbSetupNoteIndexDiscuss() {
  if (window._kbNoteIdxBound) return;
  window._kbNoteIdxBound = true;
  document.addEventListener("click", (e) => {
    if (!e.target || !e.target.closest) return;
    const toggle = e.target.closest("[data-kb-note-idx-discuss]");
    if (toggle) { e.preventDefault(); kbToggleNoteIdxDiscuss(toggle.closest("[data-kb-guide-preview]")); return; }
    const disc = e.target.closest("[data-note-idx-discuss]");
    if (disc) { e.preventDefault(); kbNoteIdxStartDiscuss(disc); return; }
    const gui = e.target.closest("[data-note-idx-guide]");
    if (gui) { e.preventDefault(); kbNoteIdxStartGuide(gui); }
  });
}
// 切换/新建课程时清空整理助手工作区，避免上个课程的对话/聚焦节点串扰到新课程
function kbResetWorkspace() {
  state.kbConversationId = null;
  state.kbSessionList = [];
  state.kbConvByNode = {};
  state.kbAgentMessages = [];
  state.kbAgentMode = "default";
  state.kbNoteGuideIndex = [];
  state.kbConvergeTask = "guide";
  state.kbConvergeApplied = false;
  state.kbConvergeActive = false;
  state.kbConvergeByNode = {}; // 课程切换后收敛条状态整体清空，避免跨课程串扰
  state.kbFocusNodeId = "";
  state.kbNodeId = "";
  state.kbProposals = [];
  state.kbDigest = null;
  const dock = kbGetDock();
  if (dock) dock.hidden = true;
  refreshQuestionRails();
}
function kbExitGuide() {
  state.kbAgentMode = "default";
  state.kbConvergeApplied = false;
  // 海小棠桌宠：退出引导模式广播
  document.dispatchEvent(new CustomEvent("knoworigin:pet-guide", { detail: { active: false } }));
  document.querySelectorAll("[data-kb-agent-msgs]").forEach(kbRenderAgentMessages);
  kbRenderAgentFocus();
}

function kbRenderAgentFocus() {
  // 当前聚焦节点条（整理助手：补全 / 引导的目标）
  const focusNode = (state.nodes || []).find((n) => n.node_id === state.kbFocusNodeId);
  document.querySelectorAll("[data-kb-agent-nodebar]").forEach((bar) => {
    bar.hidden = !focusNode;
    if (!focusNode) return;
    const nameEl = bar.querySelector("[data-kb-agent-node-name]");
    if (nameEl) nameEl.textContent = focusNode.name;
    const completeBtn = bar.querySelector('[data-kb-cmd="complete"]');
    if (completeBtn) completeBtn.disabled = Boolean(state.kbAgentBusy);
    const guideBtn = bar.querySelector('[data-kb-cmd="guide"]');
    if (guideBtn) {
      const inGuide = state.kbAgentMode === "guide";
      guideBtn.textContent = inGuide ? "退出引导" : "苏格拉底引导";
      guideBtn.title = inGuide ? "退出当前引导学习" : "从当前节点进入苏格拉底式引导学习";
      guideBtn.setAttribute("aria-label", inGuide ? "退出引导" : "苏格拉底引导当前节点");
    }
  });
  document.querySelectorAll('[data-kb-note-action="guide"]').forEach((b) => {
    b.textContent = state.kbAgentMode === "guide" ? "退出引导" : "苏格拉底引导";
  });
  // 笔记面板的「补全当前节点笔记」与 nodebar 上那个按钮同一件事：忙碌时一起置灰
  document.querySelectorAll('[data-kb-note-action="complete"]').forEach((b) => {
    b.disabled = Boolean(state.kbAgentBusy);
  });
  document.querySelectorAll("[data-kb-guide-chip]").forEach((chip) => {
    const node = (state.nodes || []).find((n) => n.node_id === state.kbFocusNodeId);
    if (state.kbAgentMode === "guide" && node) {
      chip.hidden = false;
      chip.innerHTML = "";
      const name = document.createElement("span");
      name.className = "kb-guide-node";
      name.textContent = `引导 · ${node.name}`;
      chip.appendChild(name);
    } else {
      chip.hidden = true;
    }
  });
  document.querySelectorAll("[data-kb-agent-input]").forEach((inp) => {
    inp.placeholder = state.kbAgentMode === "guide"
      ? "用自己的话回答 / 追问，向导会逐步给提示"
      : "跟整理助手聊聊，让它帮你梳理知识库…";
  });
  kbRenderGuidePreview();
}

// 工作台「整理预览」：guide 模式下并排呈现被选节点的三段笔记预览
function kbRenderGuidePreview() {
  document.querySelectorAll("[data-kb-guide-preview]").forEach((panel) => {
    const node = (state.nodes || []).find((n) => n.node_id === state.kbFocusNodeId);
    panel.dataset.kbPreviewNode = node ? node.node_id : "";
    const inGuide = state.kbAgentMode === "guide";
    panel.hidden = !(inGuide && node);
    if (panel.hidden) return;
    if (node) panel.innerHTML = kbWbPreviewHTML(node, "该节点还没有笔记。可让助手先整理，或直接开始引导。", _kbNoteIdxOpen);
  });
  document.querySelectorAll("[data-kb-wb-grid]").forEach((g) => {
    g.classList.toggle("is-workbench", state.kbAgentMode === "guide");
  });
  document.querySelectorAll("[data-kb-converge-bar]").forEach((bar) => {
    bar.hidden = !state.kbConvergeActive; // 首次进入节点收敛条隐藏，仅当有任务要收敛时才显示
    if (bar.hidden) return;
    // 引导模式下始终显示 apply/redo/stop 三个收敛键，由用户主动拍板
    bar.querySelectorAll("[data-kb-conv]").forEach((btn) => { btn.disabled = Boolean(state.kbAgentBusy); });
    kbRenderConvergeBar();
  });
}

// 收敛点按钮文案随当前任务自动切换，避免 AI 在回答正文里写收敛点说明
// 有明确信号才换任务；无信号返回 null（由调用方保留上一次的任务，避免被弱回复冲掉）
function kbResolveConvergeTask(doneMeta, answerText, userText) {
  // 用户显式意图优先：避免“推荐双链/补漏”流程调用了摸底工具后任务被降级
  const ut = String(userText || "").toLowerCase();
  // 引导问答进行中：除非用户当前输入明确要切去别的任务，否则恒为引导语义。
  // 避免苏格拉底评估时调用的 kb 查询工具（get_mastery/search 等）把收敛条误判成「补漏」。
  if (state.kbAgentMode === "guide" &&
      !/(双链|构建双链|关联建议|新建节点|缺失节点|建立关系|建链|推荐双链|知识图谱接线|建议稿|笔记建议|采用这个笔记|补全.*笔记|提案|补漏|补缺口|薄弱|复习顺序|复习建议|优先级排序|换一批)/.test(ut)) {
    return "guide";
  }
  if (/(双链|构建双链|关联建议|新建节点|缺失节点|建立关系|建链|推荐双链|知识图谱接线)/.test(ut)) return "graph";
  if (/(建议稿|笔记建议|采用这个笔记|补全.*笔记|提案)/.test(ut)) return "note";
  if (/(补漏|补缺口|薄弱|复习顺序|复习建议|优先级排序|换一批)/.test(ut)) return "review";
  const trace = Array.isArray(doneMeta && doneMeta.tool_trace) ? doneMeta.tool_trace : [];
  const names = trace.map((t) => t && t.name).filter(Boolean);
  if (names.some((n) => ["create_link", "add_node", "delete_node", "recommend_link_gaps"].includes(n))) return "graph";
  if (names.some((n) => ["complete_note", "propose_note", "update_node", "list_proposals"].includes(n))) return "note";
  if (names.some((n) => ["get_kb_digest", "get_mastery", "search_knowledge_base"].includes(n))) return "review";
  // 引导类工具或对话 → 回到引导语义
  if (names.some((n) => ["socratic_ask", "socratic_assess", "record_miscue", "converge"].includes(n))) return "guide";
  const t = String(((answerText || "") + " " + (userText || "")).toLowerCase());
  if (/(双链|构建双链|关联建议|新建节点|缺失节点|建立关系|建链|知识图谱接线)/.test(t)) return "graph";
  if (/(建议稿|笔记建议|采用这个笔记|补全.*笔记|提案)/.test(t)) return "note";
  if (/(补漏|补缺口|薄弱|复习顺序|复习建议|优先级排序)/.test(t)) return "review";
  if (/(出一题|复述|主动回忆|引导复习|要不要我|来回答|这问)/.test(t)) return "guide";
  return null;
}
function kbConvergeTaskLabels(task) {
  switch (task) {
    case "graph":
      return { job: "构建双链 / 知识图谱", apply: "✓ 执行双链·新建节点", redo: "♻ 重做补全·调整关联", stop: "⏹ 停止整理", tip: { apply: "执行实际建链并汇报本轮结果", redo: "重做当前任务，生成单次结果后停下等待确认", stop: "停止本轮整理" } };
    case "note":
      return { job: "补全节点笔记", apply: "✓ 采用此笔记建议", redo: "♻ 重新生成", stop: "⏹ 放弃并停止", tip: { apply: "采用当前建议稿写入知识库", redo: "重新生成一次建议稿", stop: "放弃本次补全并停止" } };
    case "review":
      return { job: "补漏 / 复习建议", apply: "✓ 按此补漏复习", redo: "♻ 换一批建议", stop: "⏹ 停止", tip: { apply: "按此补漏顺序开始复习并逐个引导薄弱点", redo: "换一批补漏建议（先不执行，等确认）", stop: "停止本轮补漏" } };
    default:
      return { job: "苏格拉底引导", apply: "✓ 继续下一问", redo: "📖 查看答案", stop: "⏹ 停止引导", tip: { apply: "已答对，继续引导下一问", redo: "直接给出当前这一问的答案与讲解", stop: "停止本轮引导" } };
  }
}
// 把当前节点的收敛条状态归档进 kbConvergeByNode，保证不同节点间三个按钮状态独立、互不串扰
function kbPersistConverge() {
  const nodeId = state.kbFocusNodeId;
  if (!nodeId) return;
  state.kbConvergeByNode[nodeId] = { active: state.kbConvergeActive, task: state.kbConvergeTask, applied: state.kbConvergeApplied };
}
// 设置收敛任务并立即刷新收敛条（发送时就触发，不必等 AI 回复完）
function kbSetConvergeTask(task) {
  // 用户已发起对话/任务：收敛条转为可见，随任务切换文案（首次进入节点默认隐藏，见 kbOpenNode）
  state.kbConvergeActive = true;
  // 收敛条在任意模式下都随任务切换（不依赖是否点击引导学习）
  if (task && task !== state.kbConvergeTask) {
    state.kbConvergeTask = task;
    state.kbConvergeApplied = false; // 切换到新任务时重新激活 apply（回到可执行态）
    if (task !== "graph") state.kbLinkProposed = false; // 离开建链任务时清掉「已推荐待确认」标记
  }
  kbPersistConverge();
  kbRenderConvergeBar();
}
function kbRenderConvergeBar() {
  const labels = kbConvergeTaskLabels(state.kbConvergeTask || "guide");
  const applied = state.kbConvergeApplied;
  document.querySelectorAll("[data-kb-converge-bar]").forEach((bar) => {
    bar.hidden = !state.kbConvergeActive; // 隐藏态不渲染；active 后随任务刷新显示
    if (bar.hidden) return;
    const job = bar.querySelector("[data-kb-converge-job]");
    if (job && job.textContent !== labels.job) {
      job.textContent = labels.job;
      job.classList.remove("kb-conv-switch"); void job.offsetWidth; job.classList.add("kb-conv-switch");
    }
    bar.querySelectorAll("[data-kb-conv]").forEach((btn) => {
      const key = btn.dataset.kbConv;
      const appliedNow = key === "apply" && applied;
      // 悬浮提示跟随当前任务语义更新（与按钮文字解耦，避免固定文案错配）
      const tip = labels.tip?.[key];
      if (tip && btn.title !== tip) btn.title = tip;
      // stop 仅在生成中可点（用于中断对话生成），不生成时置灰
      btn.disabled = key === "stop" ? !state.kbAgentBusy : (appliedNow || Boolean(state.kbAgentBusy));
      const txt = appliedNow ? "✓ 已执行" : labels[key];
      if (!txt || btn.dataset.prev === txt) return;
      btn.dataset.prev = txt;
      btn.textContent = txt;
      btn.classList.remove("kb-conv-switch"); void btn.offsetWidth; btn.classList.add("kb-conv-switch");
    });
  });
}
function kbToggleProposals() {
  openProposalsOverlay();
}
// 建议稿放大界面：点击头部「建议稿」按钮时弹出全屏覆盖层，让用户能看清待批准内容
let _proposalsOverlay = null;
function kbGetProposalsOverlay() {
  if (_proposalsOverlay && document.body.contains(_proposalsOverlay)) return _proposalsOverlay;
  const ov = document.createElement("div");
  ov.className = "kb-proposals-overlay";
  ov.setAttribute("data-kb-proposals-overlay", "");
  ov.hidden = true;
  ov.innerHTML = `
    <div class="kb-proposals-modal" role="dialog" aria-modal="true" aria-label="待批准建议稿">
      <div class="kb-proposals-modal-head">
        <span class="kb-prop-title" data-prop-title>待批准建议稿</span>
        <button class="kb-close" type="button" data-props-close aria-label="关闭建议稿" title="关闭（Esc）">✕</button>
      </div>
      <div class="kb-proposals-modal-body" data-prop-list></div>
    </div>`;
  document.body.appendChild(ov);
  ov.addEventListener("click", (e) => { if (e.target === ov) closeProposalsOverlay(); });
  ov.querySelector("[data-props-close]").addEventListener("click", closeProposalsOverlay);
  ov.addEventListener("click", onProposalAction);
  _proposalsOverlay = ov;
  return ov;
}
function openProposalsOverlay() {
  const ov = kbGetProposalsOverlay();
  const body = ov.querySelector("[data-prop-list]");
  const title = ov.querySelector("[data-prop-title]");
  if (title) title.textContent = `待批准建议稿（${state.kbProposals.length}）`;
  renderProposalList(body, false);
  ov.hidden = false;
  document.body.classList.add("kb-overlay-open");
}
function closeProposalsOverlay() {
  if (_proposalsOverlay) _proposalsOverlay.hidden = true;
  document.body.classList.remove("kb-overlay-open");
}

// —— 建议稿放大预览 ——
let _propZoomOverlay = null;
function kbGetPropZoomOverlay() {
  if (_propZoomOverlay && document.body.contains(_propZoomOverlay)) return _propZoomOverlay;
  const ov = document.createElement("div");
  ov.className = "kb-prop-zoom-overlay";
  ov.setAttribute("data-kb-prop-zoom", "");
  ov.hidden = true;
  ov.innerHTML = `
    <div class="kb-prop-zoom-modal" role="dialog" aria-modal="true" aria-label="放大预览">
      <div class="kb-prop-zoom-head">
        <span class="kb-prop-title" data-zoom-title>放大预览</span>
        <button class="kb-close" type="button" data-zoom-close aria-label="关闭预览" title="关闭（Esc）">✕</button>
      </div>
      <div class="kb-prop-zoom-body kb-prop-md" data-zoom-body></div>
    </div>`;
  document.body.appendChild(ov);
  ov.addEventListener("click", (e) => { if (e.target === ov) kbClosePropZoom(); });
  ov.querySelector("[data-zoom-close]").addEventListener("click", kbClosePropZoom);
  _propZoomOverlay = ov;
  return ov;
}
function kbOpenProposalZoom({ content, nodeName }) {
  const ov = kbGetPropZoomOverlay();
  const title = ov.querySelector("[data-zoom-title]");
  const body = ov.querySelector("[data-zoom-body]");
  if (title) title.textContent = nodeName ? `放大预览 · ${nodeName}` : "放大预览";
  body.innerHTML = kbRenderMarkdown(content || "");
  ov.hidden = false;
  document.body.classList.add("kb-overlay-open");
}
function kbClosePropZoom() {
  if (_propZoomOverlay) _propZoomOverlay.hidden = true;
  document.body.classList.remove("kb-overlay-open");
}
async function kbLoadProposals() {
  try {
    const data = await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/proposals?status=pending`);
    state.kbProposals = data.proposals || [];
    renderProposalCount();
  } catch { /* 静默 */ }
}
function renderProposalList(box, withTitle = true) {
  if (!box) return;
  if (!state.kbProposals.length) {
    box.innerHTML = `<p class="kb-muted" style="padding:10px;">暂时没有待批准的建议稿。让整理助手帮你补全某个节点的笔记，就会在这里出现待你确认的草稿。</p>`;
    return;
  }
  const nodeName = (id) => {
    const n = (state.nodes || []).find((x) => x.node_id === id);
    return n ? n.name : id;
  };
  const typeLabel = (p) => ({
    add_note: "新建笔记", update_note: "更新笔记", complete_note: "补全笔记",
  }[p.type] || p.type || "笔记");
  const titleHtml = withTitle ? `<div class="kb-prop-title">待批准建议稿（${state.kbProposals.length}）</div>` : "";
  box.innerHTML = titleHtml + state.kbProposals.map((p) => `
    <div class="kb-proposal" data-proposal-id="${escapeHtml(p.proposal_id)}">
      <div class="kb-prop-node" data-prop-node-id="${escapeAttr(p.node_id)}">
        <span class="kb-prop-type">${escapeHtml(typeLabel(p))}</span>
        节点：${escapeHtml(nodeName(p.node_id))}
        ${p.reason ? `<span class="kb-muted kb-prop-reason">${escapeHtml(p.reason)}</span>` : ""}
      </div>
      <div class="kb-prop-preview-wrap" data-prop-preview-wrap>
        <button class="kb-prop-zoom" type="button" data-prop-zoom aria-label="放大预览" title="放大预览">⛶</button>
        <div class="kb-prop-preview kb-prop-md" data-prop-preview>${kbRenderMarkdown(p.proposed_content || "")}</div>
      </div>
      <textarea data-prop-edit rows="6" hidden data-prop-raw="${escapeAttr(p.proposed_content || "")}"></textarea>
      <div class="kb-prop-actions">
        <button class="mini-button" type="button" data-prop-act="approve">批准</button>
        <button class="mini-button" type="button" data-prop-act="edit">编辑后批准</button>
        <button class="mini-button" type="button" data-prop-act="reject">拒绝</button>
      </div>
    </div>`).join("");
  renderProposalCount();
}
function onProposalAction(e) {
  const zoomBtn = e.target.closest("[data-prop-zoom]");
  if (zoomBtn) {
    const zcard = zoomBtn.closest("[data-proposal-id]");
    if (!zcard) return;
    const zie = zcard.querySelector("[data-prop-edit]");
    const zraw = zie ? zie.dataset.propRaw : "";
    const znode = zcard.querySelector("[data-prop-node-id]");
    kbOpenProposalZoom({ content: zraw || "", nodeName: znode ? znode.dataset.propNodeId : "" }, zcard);
    return;
  }
  // 直接点击预览内容区本身也可放大预览（编辑态下预览隐藏时不触发）
  const previewWrap = e.target.closest("[data-prop-preview-wrap]");
  if (previewWrap) {
    const pcard = previewWrap.closest("[data-proposal-id]");
    if (!pcard) return;
    const pView = pcard.querySelector("[data-prop-preview]");
    if (pView && pView.hidden) return;
    const pie = pcard.querySelector("[data-prop-edit]");
    const praw = pie ? pie.dataset.propRaw : "";
    const pnode = pcard.querySelector("[data-prop-node-id]");
    kbOpenProposalZoom({ content: praw || "", nodeName: pnode ? pnode.dataset.propNodeId : "" }, pcard);
    return;
  }
  const actBtn = e.target.closest("[data-prop-act]");
  if (!actBtn) return;
  const card = actBtn.closest("[data-proposal-id]");
  if (!card) return;
  const pid = card.dataset.proposalId;
  const act = actBtn.dataset.propAct;
  const preview = card.querySelector("[data-prop-preview]");
  const edit = card.querySelector("[data-prop-edit]");

  if (act === "edit" && edit) {
    if (edit.hidden) {
      // 首次点击：进入编辑态，预填建议稿原文
      edit.hidden = false;
      if (preview) preview.hidden = true;
      edit.value = edit.dataset.propRaw || (preview ? preview.textContent : "");
      actBtn.textContent = "保存批准";
      return;
    }
    const content = edit.value.trim();
    if (!content) { return; }
    kbApplyProposal(pid, "edited", content);
    return;
  }
  if (act === "approve") { kbApplyProposal(pid, "accepted"); return; }
  if (act === "reject") { kbApplyProposal(pid, "rejected"); }
}
async function kbApplyProposal(pid, status, content) {
  const prop = state.kbProposals.find((p) => p.proposal_id === pid);
  try {
    await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/proposals/${encodeURIComponent(pid)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, content }),
    });
    state.kbProposals = state.kbProposals.filter((p) => p.proposal_id !== pid);
    // 批准/编辑后：节点笔记已写库，同步更新本地节点缓存并重渲染工作台「整理预览」
    if (status && status !== "rejected" && prop) {
      const finalNote = status === "edited" ? (content || "").trim() : (prop.proposed_content || "").trim();
      const node = (state.nodes || []).find((n) => n.node_id === prop.node_id);
      if (node) node.note_content = finalNote;
      if (state.kbFocusNodeId === prop.node_id) kbRenderGuidePreview();
    }
    renderProposalCount();
    if (_proposalsOverlay && !_proposalsOverlay.hidden) {
      const body = _proposalsOverlay.querySelector("[data-prop-list]");
      const title = _proposalsOverlay.querySelector("[data-prop-title]");
      if (title) title.textContent = `待批准建议稿（${state.kbProposals.length}）`;
      if (body) renderProposalList(body, false);
    }
    kbRefreshDigest();
  } catch (err) {
    alert(err.message || "审批失败");
  }
}
async function kbRefreshDigest() {
  try {
    const data = await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/kb/digest`);
    state.kbDigest = data.digest || null;
  } catch { /* 静默 */ }
  renderMemoryBadge();
}
function kbAgentMsgMarkup(role, html, meta) {
  const article = document.createElement("div");
  article.className = `kb-agent-msg ${role}-msg`;
  article.innerHTML = `<div class="kb-agent-role">${role === "user" ? "你" : "整理助手"}</div><div class="kb-agent-body">${html}</div>`;
  return article;
}
function kbRenderAgentMessages(msgs) {
  if (!msgs) return;
  addQuestionRail(msgs, ".kb-agent-msg.user-msg");
  msgs.innerHTML = "";
  if (!state.kbAgentMessages.length) {
    msgs.innerHTML = `<div class="kb-firstuse">
      <div class="kb-firstuse-title">Hi，我是知识库整理助手</div>
      <p class="kb-muted">直接用大白话告诉我想干什么即可——我会先自主整理，再像班主任一样引导你消化。例如：</p>
      <ul class="kb-firstuse-demo">
        <li>“帮我补全「导数」这个节点的笔记”</li>
        <li>“针对我的薄弱点给我复习顺序”</li>
        <li>“推荐一些应该建立双链的节点”</li>
      </ul>
      ${state.kbAgentMode === "guide"
        ? `<p class="kb-muted">引导模式已开启：用自己的话回答，答完我可以评估并升级提示，直到你 apply / stop 收敛。</p>`
        : `<p class="kb-muted">或在右侧框架上选一个节点点【引导学习】，从这里苏格拉底式带你学。</p>`}
    </div>`;
    return;
  }
  state.kbAgentMessages.forEach((m) => {
    let html = m.html;
    // 建链汇报消息统一补挂「查看双链图谱」跳转链接：任何一次进/出面板重新渲染都不丢，可反复点击
    if (m.role === "assistant" && kbMsgHasLinkTrace(m.meta) && !String(html).includes("data-kb-action='open-graph'")) {
      html += kbGraphJumpLink();
    }
    // 整理助手对话内容也包成可选中高亮的容器（主对话同样如此），scope 用内容哈希保证渲染恢复高亮
    html = highlightableMarkup(`kb-agent:${m.role}:${hashString(html)}`, html, "kb-agent-body-hl");
    const el = kbAgentMsgMarkup(m.role, html, m.meta || {});
    msgs.appendChild(el);
  });
  msgs.scrollTop = msgs.scrollHeight;
  refreshQuestionRails();
}
async function kbAgentTurn(text, msgs, displayText) {
  // displayText：气泡里展示给用户看的文案；text 才是真正发给后端的内容。
  // 二者分离用于收敛快捷键——后端契约要求收到裸 token（apply/redo/stop）才会短路，
  // 而对话气泡里应显示自然的中文指令，而不是让用户看到 "redo" 这种内部命令。
  const rawText = displayText || text;
  // 处于「已推荐双链、待确认」时，用户简短确认词直接转发为真正的建链执行，避免只口头应答而不建链
  const userConfirmingLink = state.kbLinkProposed && KB_LINK_CONFIRM_RE.test(String(text || "").trim());
  if (userConfirmingLink) {
    text = "请执行我刚才同意的双链：把已推荐并确认的这些关联实际建立起来（逐条调用建链工具，每条都要给出连接理由），建完汇报结果即可，不要重复推荐新的双链。";
    state.kbConvergeApplied = true; // 置灰 apply，避免重复建链
  }
  // 收敛命令（apply/redo/stop）不改收敛任务、不重置 applied，防循环置灰由按钮 handler 管理
  const isConvergeCmd = text === "apply" || text === "redo" || text === "stop";
  if (!isConvergeCmd) {
    // 发送前先按用户输入的语义预置收敛任务并立即刷新（例如提到“双链/补漏/补全”）
    kbSetConvergeTask(kbResolveConvergeTask(null, null, text));
  }
  state.kbAgentMessages.push({ role: "user", html: renderMathContent(rawText) });
  const pending = { role: "assistant", html: `<span class="kb-loading">思考中…</span>`, stream: "" };
  state.kbAgentMessages.push(pending);
  kbRenderAgentMessages(msgs);
  state.kbAgentBusy = true;
  kbRenderConvergeBar(); // 生成中立即刷新：stop 变亮为可点（可中断）
  const ab = new AbortController();
  state.kbAbortCtrl = ab; // 供 stop 键中断本次生成
  const convGroup = kbActiveNodeGroup(); // 会话归属节点（空=库级全局会话）
  let convId = state.kbConversationId || "";
  let doneMeta = null;
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(state.currentProjectId)}/agent`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      signal: ab.signal,
      body: JSON.stringify({
        message: text, conversation_id: state.kbConversationId || undefined,
        mode: state.kbAgentMode || "default",
        node_id: convGroup, focus_node_id: state.kbFocusNodeId || undefined,
      }),
    });
    if (!resp.ok) {
      let detail = {};
      try { detail = await resp.json(); } catch { /* 非 JSON 错误体 */ }
      const dd = detail.detail && typeof detail.detail === "object" ? detail.detail : detail;
      const err = new Error(dd.message || `请求失败（${resp.status}）`);
      err.status = resp.status;
      err.retryable = Boolean(dd.retryable);
      throw err;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let lastRender = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop();
      for (const evt of events) {
        const line = evt.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let data;
        try { data = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (!data || typeof data !== "object") continue;
        if (data.type === "delta") {
          pending.stream += data.text || "";
          pending.html = kbStreamHtml(pending.stream);
          const now = Date.now();
          if (now - lastRender > 80) { lastRender = now; kbRenderAgentMessages(msgs); }
        } else if (data.type === "tool") {
          // 模型要先调工具：清掉本轮已显示的残句，进入「正在查询」状态
          pending.stream = "";
          const names = Array.isArray(data.names) ? data.names : [];
          const label = names.length ? `正在查询知识库（${names.length} 个动作）…` : "正在查询知识库…";
          pending.html = `<span class="kb-loading">${escapeHtml(label)}</span>`;
          kbRenderAgentMessages(msgs);
        } else if (data.type === "done") {
          doneMeta = data;
          if (data.conversation_id) convId = data.conversation_id;
          pending.meta = { trace: data.tool_trace || [] };
        } else if (data.type === "error") {
          pending.html = kbErrHtml(data.message || "请求失败");
        }
      }
    }
    // 收尾：以 done.answer 为权威全文重渲染，避免分块丢失导致缺字
    if (doneMeta && doneMeta.answer) {
      pending.stream = doneMeta.answer;
      pending.html = kbRenderAnswer(doneMeta.answer);
      const madeLink = kbTurnCreatedLinks(doneMeta);
      // 更新「已推荐待确认」状态：建过链则关闭，推荐但未建则开启
      state.kbLinkProposed = madeLink ? false : kbTurnProposedLinks(doneMeta);
      // 跳转链接统一由 kbRenderAgentMessages 按消息 meta.trace 持久补挂，这里只补一次性「执行」提示
      if (!madeLink && kbTurnProposedLinks(doneMeta)) {
        // 仅做了推荐、尚未建链：明确告知用户点击下方按钮才真正执行；
        // 新的待执行轮次重新激活 apply（清除上一次执行残留的置灰），保证按钮与提示状态一致
        state.kbConvergeApplied = false;
        // 引导问答进行中不注入「执行双链」提示：建链操作不属于引导学习流，避免红框混入建链确认
        if (state.kbAgentMode !== "guide") pending.html += kbExecHint();
      }
    } else if (!pending.stream) {
      pending.html = `<div class="kb-err">未收到回答，请重试。</div>`;
    }
    if (convId) {
      state.kbConversationId = convId;
      if (convGroup) state.kbConvByNode[convGroup] = convId; // 记住该节点最近会话
      kbLoadSessions(convGroup); // 刷新下拉，纳入新建/延续的会话
    }
    state.kbConvergeHasChange =
      Array.isArray(doneMeta && doneMeta.tool_trace) &&
      doneMeta.tool_trace.some((t) => KB_WRITE_TOOLS.has((t && t.name) || ""));
    // 根据本轮工具与回答推断收敛任务并刷新（无信号则保留上次任务）
    // 收敛命令（apply/redo/stop）除外：保持当前任务与防循环置灰
    // apply 已执行后：锁住当前任务与「✓ 已执行」，避免后续引导/复习等弱信号把任务降级/回跳成引导，导致按钮从灰色
    // 「已执行」变回「继续下一问」；仅 redo/stop 或用户发起全新任务（见 kbSetConvergeTask 的前置解析）才解锁
    if (!isConvergeCmd && !state.kbConvergeApplied) {
      kbSetConvergeTask(kbResolveConvergeTask(doneMeta, doneMeta && doneMeta.answer, text));
    }
    // 建议稿/摘要可能因本轮工具调用而变化，随手刷新
    kbLoadProposals();
    kbRefreshDigest();
    // 本轮有写库动作（建双链/新建节点/更新节点等）→ 同步图谱节点缓存，
    // 否则双链图谱重绘仍用旧 state.nodes，刚建的关联看不到（await 会拖慢收尾，后台执行）
    if (state.kbConvergeHasChange) void kbSyncNodeCache();
  } catch (err) {
    if (err && err.name === "AbortError") {
      pending.html = `<div class="kb-note-stop">已停止生成</div>`;
    } else {
      pending.html = kbErrHtml(err.message || "请求失败");
    }
  } finally {
    state.kbAbortCtrl = null;
    state.kbAgentBusy = false;
    kbRenderAgentMessages(msgs);
    // 刷新收敛条（apply/redo/stop 的状态与文案统一由 kbRenderConvergeBar 管理，含防循环置灰）
    kbRenderGuidePreview();
  }
}

// 整理助手：「补全当前节点笔记」→ 用 AI 生成详细高质量笔记建议稿（待批准，不直接改库）
async function kbCompleteNodeNote() {
  discussionExit(); // 退讨论态
  if (state.kbAgentMode === "guide") { // 退引导态：补全笔记后自动回到图一会话界面
    kbExitGuide();
    state.kbConvergeActive = false;
    state.kbConvergeApplied = false;
    kbPersistConverge();
  }
  const nodeId = state.kbFocusNodeId;
  const node = (state.nodes || []).find((n) => n.node_id === nodeId);
  const name = node ? node.name : (nodeId || "");
  if (!nodeId) {
    showToast("请先在知识图谱点击一个节点，再补全它的笔记。", "error");
    return;
  }
  if (state.kbAgentBusy) return;
  const dock = kbGetDock();
  const msgs = dock ? dock.querySelector("[data-kb-agent-msgs]") : null;
  state.kbAgentMessages.push({ role: "user", html: renderMathContent(`补全当前节点「${name}」的笔记（生成详细高质量 Markdown）`) });
  const pending = { role: "assistant", html: `<span class="kb-loading">正在用 AI 补全节点笔记（生成待批准建议稿）…</span>` };
  state.kbAgentMessages.push(pending);
  kbRenderAgentMessages(msgs);
  kbRenderAgentFocus();
  state.kbAgentBusy = true;
  try {
    const data = await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/kb/node/${encodeURIComponent(nodeId)}/complete`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    let note = "";
    try { note = (data.proposal && data.proposal.proposed_content) || ""; } catch (_) {}
    pending.html = data.created === false
      ? `<div class="kb-ok">该节点已有待批准建议稿，未重复生成。可到右上角「建议稿」中审批。</div>`
      : `<div class="kb-ok">已为「${escapeHtml(name)}」生成详细笔记建议稿（${note.length} 字）。请打开右上角「建议稿」审批：批准后才写库。</div>`;
    kbLoadProposals();
    kbRefreshDigest();
  } catch (err) {
    pending.html = kbErrHtml(err.message || "补全笔记失败");
  } finally {
    state.kbAgentBusy = false;
    kbRenderAgentMessages(msgs);
    kbRenderAgentFocus();
  }
}
// 笔记面板的「补全当前节点笔记」：先跳到整理助手页签，再就地发起补全。
// 补全的消息流、建议稿审批、收敛条都长在 agent 页签里；留在笔记页签发起的话，
// 用户在隐藏面板里跑完整轮却看不到任何变化（同 kbStartGuide / AI 同学讨论的做法）。
async function kbCompleteNoteFromPane(node, pane) {
  if (!node) return;
  if (state.kbAgentBusy) { showToast("整理助手正在忙，等它答完再补全。", { variant: "notice" }); return; }
  // 编辑器里可能有未保存草稿：补全会把现有笔记正文一起交给 AI，
  // 不先落库的话 AI 看到的是旧内容，建议稿跟眼前写的东西对不上。
  const editor = pane ? pane.querySelector("[data-kb-editor]") : null;
  const current = editor ? (editor.value || "") : "";
  if (editor && current !== (node.note_content || "")) {
    await kbSave(node.node_id, pane, { force: true });
  }
  state.kbFocusNodeId = node.node_id;
  const dock = kbGetDock();
  if (dock) { dock.hidden = false; kbDockSwitch(dock, "agent"); refreshQuestionRails(); }
  kbRenderAgentFocus();
  await kbCompleteNodeNote();
}
function kbExportVault() {
  const url = `/api/projects/${encodeURIComponent(state.currentProjectId)}/vault/export`;
  const a = document.createElement("a");
  a.href = url; a.download = "";
  document.body.appendChild(a); a.click(); a.remove();
}

// —— 选中整理预览 / 对话文字 → 引导对话 + 生成选中索引 ——
function _kbSelHost(node) {  // 文本节点取其父元素，其余取自身
  return node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
}
function _kbSelZoneInfo(node) {  // 判断选中点是否落在可选的文字区：整理预览、KB 对话或主对话
  const h = _kbSelHost(node);
  if (!h || !h.closest) return null;
  const sec = h.closest("[data-kb-guide-preview], [data-kb-agent-msgs]");
  if (sec) return { mode: sec.classList.contains("kb-guide-preview") ? "preview" : "conversation", section: sec };
  if (h.closest("#conversation .message")) return { mode: "main", section: null };
  return null;
}
function _kbSetupSelectionGuide() {
  if (window._kbSelectionHandlersBound) return;
  window._kbSelectionHandlersBound = true;
  // 浮动操作菜单挂在 body 下，避免被 dock 的 transform/overflow 裁剪，保证 fixed 定位准确
  const menu = document.createElement("div");
  menu.className = "kb-sel-actions";
  menu.setAttribute("data-kb-sel-actions", "");
  menu.hidden = true;
  menu.innerHTML =
    `<button type="button" class="mini-button" data-kb-sel-add title="把选中的文字生成为索引放入对话输入框，便于追问">📎 生成选中索引</button>` +
    `<button type="button" class="mini-button primary" data-kb-sel-guide title="围绕选中的文字进入苏格拉底式引导对话">💬 围绕选中引导</button>` +
    `<button type="button" class="mini-button" data-kb-sel-discuss title="围绕选中的文字进入 AI 同学讨论">💬 围绕选中讨论</button>` +
    `<button type="button" class="mini-button" data-kb-sel-add-main title="把选中的对话文字放入主输入框，便于补充追问">📎 加入输入框</button>` +
    `<button type="button" class="mini-button primary" data-kb-sel-ask title="围绕选中的对话文字直接提问">💬 围绕选中提问</button>` +
    `<span class="kb-sel-hl-row" data-kb-sel-hl hidden>` +
    TEXT_HIGHLIGHT_COLORS.map((color) =>
      `<button type="button" class="text-highlight-swatch text-highlight-${color}" data-kb-sel-hl-color="${color}" aria-label="高亮：${highlightColorLabel(color)}" title="高亮：${highlightColorLabel(color)}"></button>`
    ).join("") +
    `<button type="button" class="text-highlight-clear" data-kb-sel-hl-color="clear" title="清除选中文字的高亮">清除高亮</button>` +
    `</span>`;
  document.body.appendChild(menu);
  // 与 #text-highlight-toolbar 同理：点击这些操作按钮的 mousedown 会塌陷当前文字选区，
  // 触发 selectionchange 清空 _kbSelInfo / state.activeHighlight，导致后续 applyTextHighlight
  // 或索引/引导动作静默失效。preventDefault 在按下瞬间保住选区；
  // 高亮色板则直接在 mousedown 上同步应用（此刻选区尚未被清理，click 阶段再走会空转不重复）。
  menu.addEventListener("mousedown", (e) => {
    const btn = e.target.closest?.("button");
    if (!btn) return;
    e.preventDefault();
    const swatch = btn.closest?.("[data-kb-sel-hl-color]");
    if (swatch) applyTextHighlight(swatch.dataset.kbSelHlColor);
  });
  menu.querySelector("[data-kb-sel-add]").addEventListener("click", kbSelAddToComposer);
  menu.querySelector("[data-kb-sel-guide]").addEventListener("click", kbSelToGuide);
  menu.querySelector("[data-kb-sel-discuss]").addEventListener("click", kbSelToDiscuss);
  menu.querySelector("[data-kb-sel-add-main]").addEventListener("click", kbSelAddMainComposer);
  menu.querySelector("[data-kb-sel-ask]").addEventListener("click", kbSelAskMain);
  menu.addEventListener("click", (e) => {
    const swatch = e.target.closest("[data-kb-sel-hl-color]");
    if (!swatch) return;
    e.preventDefault();
    e.stopPropagation();
    applyTextHighlight(swatch.dataset.kbSelHlColor);
  });
  function isSelectable() {
    const s = window.getSelection && window.getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) return false;
    if (!String(s.toString() || "").trim()) return false;
    return Boolean(_kbSelZoneInfo(s.anchorNode) && _kbSelZoneInfo(s.focusNode));
  }
  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection && window.getSelection();
    if (!isSelectable()) { _kbSelInfo = null; kbHideSelMenu(); return; }
    const text = String(sel.toString() || "").trim();
    const anchor = _kbSelZoneInfo(sel.anchorNode);
    const focus = _kbSelZoneInfo(sel.focusNode);
    const info = anchor || focus;
    const isMain = info.mode === "main";
    const nodeName = !isMain && info.mode === "preview"
      ? ((state.nodes || []).find((n) => n.node_id === state.kbFocusNodeId) || {}).name || ""
      : "";
    // 各模式选中内容都解析可高亮选区：落在 .highlightable-text 内即启用高亮色板（主对话 / KB 引导一致）。
    // 先隐藏独立高亮工具条（其 hide 会清空 activeHighlight），再记录本次选区供色板使用。
    hideTextHighlightToolbar();
    const range = sel.getRangeAt(0);
    const hostNode = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    const container = hostNode?.closest?.(".highlightable-text");
    let highlight = null;
    if (container && container.isConnected && container.contains(range.startContainer) && container.contains(range.endContainer)) {
      highlight = { container, range: range.cloneRange() };
      state.activeHighlight = highlight;
      _pendingTextHighlight = highlight;
    }
    _kbSelInfo = { text, source: { mode: info.mode, nodeName }, highlight };
    menu.querySelector("[data-kb-sel-add]").hidden = isMain;
    menu.querySelector("[data-kb-sel-guide]").hidden = isMain;
    menu.querySelector("[data-kb-sel-discuss]").hidden = isMain || info.mode !== "preview"; // 围绕选中讨论：仅整理预览可用
    menu.querySelector("[data-kb-sel-add-main]").hidden = !isMain;
    menu.querySelector("[data-kb-sel-ask]").hidden = !isMain;
    const hlRow = menu.querySelector("[data-kb-sel-hl]");
    if (hlRow) hlRow.hidden = !highlight;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    kbShowSelMenu(rect);
  });
  document.addEventListener("mousedown", (e) => {
    if (e.target && e.target.closest && e.target.closest("[data-kb-sel-actions]")) return;
    kbHideSelMenu();
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") kbHideSelMenu(); });
}
function kbShowSelMenu(rect) {
  const menu = document.querySelector("[data-kb-sel-actions]");
  if (!menu) return;
  menu.hidden = false;
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = Math.max(8, rect.left);
  if (left + menu.offsetWidth > vw - 8) left = Math.max(8, vw - menu.offsetWidth - 8);
  let top = rect.bottom + 8;
  if (top + menu.offsetHeight > vh - 8) top = Math.max(8, rect.top - menu.offsetHeight - 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}
function kbHideSelMenu() {
  const menu = document.querySelector("[data-kb-sel-actions]");
  if (menu) menu.hidden = true;
}
// 「生成选中索引」：把选中文字作为可追溯索引插入对话输入框，便于继续补充追问再发送
function kbSelAddToComposer() {
  const info = _kbSelInfo;
  if (!info || !info.text) return;
  const inp = document.querySelector("[data-kb-agent-input]");
  if (!inp) { showToast("请先打开整理助手的对话输入框。", "error"); return; }
  const head = info.source && info.source.mode === "preview"
    ? `〔选中索引 · ${info.source.nodeName || "整理预览"}〕`
    : "〔选中索引 · 对话〕";
  const block = `${head}「${info.text}」`;
  const pos = inp.selectionStart != null ? inp.selectionStart : inp.value.length;
  const end = inp.selectionEnd != null ? inp.selectionEnd : pos;
  const ins = (inp.value && pos > 0 ? "\n" : "") + block + "\n";
  inp.value = inp.value.slice(0, pos) + ins + inp.value.slice(end);
  inp.focus();
  autoResizeMessageInput();
  const cur = pos + ins.length;
  inp.setSelectionRange(cur, cur);
  kbHideSelMenu();
  showToast("已生成选中索引到输入框，可继续补充追问再发送。", "ok");
}
// 「围绕选中引导」：把选中文字生成为来源卡片放进对话，并立即围绕它做苏格拉底式引导
function kbSelToGuide() {
  const info = _kbSelInfo;
  if (!info || !info.text) return;
  if (state.kbAgentBusy) { showToast("助手正在处理上一轮，请稍候再试。", "error"); return; }
  const msgs = kbAgentMsgsEl();
  const text = info.text;
  const sourceLabel = info.source && info.source.mode === "preview"
    ? `选中索引 · ${info.source.nodeName || "整理预览"}`
    : "选中索引 · 对话";
  const citeHtml =
    `<div class="kb-sel-cite"><div class="kb-sel-cite-head">${escapeHtml(sourceLabel)}</div>` +
    `<div class="kb-sel-cite-body">${escapeHtml(text)}</div></div>`;
  state.kbAgentMessages.push({ role: "user", html: citeHtml });
  // 未在引导模式则切入引导：同步收敛条、预览与占位提示
  state.kbAgentMode = "guide";
  kbRenderAgentFocus();
  kbRenderAgentMessages(msgs);
  kbHideSelMenu();
  kbAgentTurn(
    `我选中了下面这段内容，请围绕它对我做苏格拉底式引导复习：先把这一点讲透，再用小问题逐问检验我的理解，答对前不要一次性铺开完整讲解。\n\n选中内容：\n「${text}」`,
    msgs
  );
}
// 「围绕选中讨论」：以当前聚焦节点为锚、以选中文字为讨论焦点，进入 AI 同学讨论
function kbSelToDiscuss() {
  const info = _kbSelInfo;
  if (!info || !info.text) return;
  // 优先用配置文件聚焦节点；若未聚焦，则从正在显示的整理预览面板反查它渲染的是哪个节点
  const previewNode = document
    .querySelector("[data-kb-guide-preview][data-kb-preview-node]");
  const nodeId = state.kbFocusNodeId
    || (previewNode && previewNode.dataset.kbPreviewNode)
    || "";
  if (!nodeId) {
    showToast("请先在知识图谱点击一个节点，再围绕选中发起讨论。", "error");
    return;
  }
  if (!(state.nodes || []).some((n) => n.node_id === nodeId)) {
    showToast("当前知识点不在本项目图谱里，请先切到对应项目再围绕选中讨论。", "error");
    return;
  }
  kbHideSelMenu();
  // 已在同一节点讨论中：强制以选中句为新焦点开一场新讨论，避免静默复用旧会话
  const sameNodeDiscussing = _discussionCtx && _discussionCtx.cid && _discussionCtx.nodeId === nodeId;
  openDiscussionForNode(nodeId, { quote: info.text, force: Boolean(sameNodeDiscussing) });
}
// 「加入输入框」：把主对话选中文字作为引用放入主输入框，便于补充追问
function kbSelAddMainComposer() {
  const info = _kbSelInfo;
  if (!info || !info.text) return;
  const inp = $("#message-input");
  if (!inp) { showToast("请先打开对话输入框。", "error"); return; }
  const block = `〔选中对话内容〕「${info.text}」`;
  const pos = inp.selectionStart != null ? inp.selectionStart : inp.value.length;
  const end = inp.selectionEnd != null ? inp.selectionEnd : pos;
  const ins = (inp.value && pos > 0 ? "\n" : "") + block + "\n";
  inp.value = inp.value.slice(0, pos) + ins + inp.value.slice(end);
  inp.focus();
  const cur = pos + ins.length;
  inp.setSelectionRange(cur, cur);
  kbHideSelMenu();
  showToast("已把选中内容放入输入框，可补充追问后发送。", "ok");
}
// 「围绕选中提问」：选中内容带进主对话，直接发问
function kbSelAskMain() {
  const info = _kbSelInfo;
  if (!info || !info.text) return;
  if (state.sending) { showToast("上一轮还在处理中，请稍候。", "error"); return; }
  const inp = $("#message-input");
  if (!inp) return;
  inp.value = `请围绕我选中的这段对话内容讲解：\n〔选中对话内容〕「${info.text}」`;
  kbHideSelMenu();
  $("#composer").requestSubmit();
}

function buildFrameworkLayout(nodes, maxColumnHeight = 1500, collapsed = null) {
  // 折叠（KbTreeFlow 的角标维护这个集合）：被折叠节点的整棵子树都不参与布局。
  // 先按全量节点建一次父子表才能算出隐藏集，算完再把 nodes 换成过滤后的 —— 后面
  // 所有逻辑（列装箱、主轴、左右分配）都直接用 nodes，替换参数即可，无需逐处改。
  if (collapsed && collapsed.size) {
    const kids0 = new Map(nodes.map((n) => [n.node_id, []]));
    nodes.forEach((n) => {
      if (n.parent_id && n.parent_id !== n.node_id && kids0.has(n.parent_id)) {
        kids0.get(n.parent_id).push(n.node_id);
      }
    });
    const hidden = new Set();
    const mark = (id) => (kids0.get(id) || []).forEach((k) => {
      if (!hidden.has(k)) { hidden.add(k); mark(k); }
    });
    collapsed.forEach(mark);
    nodes = nodes.filter((n) => !hidden.has(n.node_id));
  }
  const nodeWidth = 188;
  const nodeHeight = 64;
  const columnGap = 64;
  const rowGap = 12;
  const rootGap = 28;
  const marginX = 64;
  const marginY = 48;
  const nodeIds = new Set(nodes.map((node) => node.node_id));
  const parentById = new Map();
  nodes.forEach((node) => {
    if (node.parent_id && node.parent_id !== node.node_id && nodeIds.has(node.parent_id)) {
      parentById.set(node.node_id, node.parent_id);
    }
  });

  nodes.forEach((node) => {
    const seen = new Set([node.node_id]);
    let cursor = node.node_id;
    while (parentById.has(cursor)) {
      cursor = parentById.get(cursor);
      if (seen.has(cursor)) {
        parentById.delete(node.node_id);
        break;
      }
      seen.add(cursor);
    }
  });

  const children = new Map(nodes.map((node) => [node.node_id, []]));
  parentById.forEach((parentId, nodeId) => children.get(parentId)?.push(nodeId));
  const roots = nodes.filter((node) => !parentById.has(node.node_id)).map((node) => node.node_id);
  const positions = new Map();
  const sides = new Map();
  const columnPitch = nodeWidth + columnGap;

  // —— 列装箱（保持逻辑顺序）——
  // 把若干「盒子」（子树包围盒，宽 cols 列 × 高 height）按给定顺序装进纵向列：
  // 每列总高不超过 maxColumnHeight，装不下就横向另起一列，把「又细又长」摊成横向铺开。
  // 宽盒子（cols>1）跨列放置时，把它占到的每一列的游标都推到盒子底部，保证互不重叠。
  const packColumns = (entries, gap) => {
    const colHeights = [];
    const placed = [];
    entries.forEach((entry) => {
      const span = Math.max(1, entry.box.cols);
      let target = -1;
      for (let c = 0; c <= colHeights.length; c++) {
        let fits = true;
        for (let k = 0; k < span; k++) {
          const h = colHeights[c + k] || 0;
          if (h + (h ? gap : 0) + entry.box.height > maxColumnHeight) { fits = false; break; }
        }
        if (fits) { target = c; break; }
      }
      if (target < 0) { target = colHeights.length; }
      let baseHeight = 0;
      for (let k = 0; k < span; k++) baseHeight = Math.max(baseHeight, colHeights[target + k] || 0);
      const offsetY = baseHeight + (baseHeight ? gap : 0);
      for (let k = 0; k < span; k++) colHeights[target + k] = offsetY + entry.box.height;
      placed.push({ id: entry.id, col: target, offsetY, box: entry.box });
    });
    return { colHeights, placed, height: colHeights.length ? Math.max(...colHeights) : 0 };
  };

  // —— 度量：递归给每个子树量出包围盒。节点自己占第 0 列，孩子从第 1 列开始装箱。——
  const boxById = new Map();
  const measure = (nodeId) => {
    const childIds = children.get(nodeId) || [];
    if (!childIds.length) {
      const box = { cols: 1, height: nodeHeight, nodeY: 0, packed: null };
      boxById.set(nodeId, box);
      return box;
    }
    const packed = packColumns(childIds.map((childId) => ({ id: childId, box: measure(childId) })), rowGap);
    const height = Math.max(nodeHeight, packed.height);
    const box = {
      cols: 1 + Math.max(packed.colHeights.length, 1),
      height,
      nodeY: (height - nodeHeight) / 2,
      packed,
    };
    boxById.set(nodeId, box);
    return box;
  };

  const mainRootId = roots[0];
  const extraRootIds = roots.slice(1);
  if (mainRootId && extraRootIds.length) {
    extraRootIds.forEach((rootId) => children.get(mainRootId)?.push(rootId));
  }
  // —— 主轴 + 枢纽：沿根的单链往下走，找到第一个有 ≥2 个孩子的「扇出点」当枢纽。——
  // 浅而宽的框架（根只有一个孩子，再往下才分叉）不会再整棵挂到一侧：
  // 主轴节点横向排在枢纽左侧，枢纽的孩子左右分挂。
  const spine = [];
  let hubId = mainRootId;
  while (hubId) {
    spine.push(hubId);
    const kids = children.get(hubId) || [];
    if (kids.length !== 1) break;
    hubId = kids[0];
  }
  const spineLen = spine.length - 1; // 枢纽之前的主轴节点数（占据枢纽左侧的前几列）
  const hubChildren = hubId ? [...(children.get(hubId) || [])] : [];
  // 枢纽的孩子左右分配：保持逻辑顺序，哪边累计更矮挂哪边
  const leftBranches = [];
  const rightBranches = [];
  hubChildren.forEach((childId) => {
    const leftHeight = leftBranches.reduce((sum, entry) => sum + entry.box.height, 0);
    const rightHeight = rightBranches.reduce((sum, entry) => sum + entry.box.height, 0);
    if (leftHeight < rightHeight) leftBranches.push({ id: childId, box: measure(childId) });
    else rightBranches.push({ id: childId, box: measure(childId) });
  });
  // 每侧独立装箱：超过单列限高就再开一列，向外扩宽
  const leftPack = packColumns(leftBranches, rootGap);
  const rightPack = packColumns(rightBranches, rootGap);

  // ⚠️ 列数必须按「盒子占的列跨度」算，不能只数 packColumns 的列数。
  // 原版 bug：`leftCols = spineLen + leftPack.colHeights.length` 只数了顶层分支有几列，
  // 完全没算子树的内部宽度（entry.box.cols）。于是当某个分支自己还带子节点时，
  // 递归把它推到 `hubX ± depth*columnPitch`，depth 很快超过 leftCols/rightCols，
  // 节点就跑到 viewBox 外被裁切 —— 这正是截图里右侧只剩一列竖排文字的根因。
  // 正确做法：每侧的列跨度 = max(item.col + item.box.cols)。
  const sideSpan = (pack) => pack.placed.reduce((max, item) => Math.max(max, item.col + Math.max(1, item.box.cols)), 0);
  const leftPackCols = sideSpan(leftPack);
  const rightPackCols = sideSpan(rightPack);
  const leftCols = Math.max(spineLen, 0) + leftPackCols;
  const rightCols = Math.max(rightPackCols, hubId ? 1 : 0);

  // 先用「理论最大跨度」铺一张足够大的画布摆节点。
  // 这一步的 viewportWidth 只用于 clamp，不是最终 viewBox —— 见下方 shrinkToContent。
  const wideW = Math.max(620, marginX * 2 + nodeWidth + (leftCols + rightCols) * columnPitch);
  const packHeight = Math.max(leftPack.height, rightPack.height, nodeHeight);
  const wideH = Math.max(340, marginY * 2 + packHeight);
  const viewportWidth = wideW;
  const viewportHeight = wideH;
  const hubX = marginX + leftCols * columnPitch;
  const centerY = viewportHeight / 2;

  // 边界守卫：把 x 夹进各自的半区，防止任何递归深度爆出画布。
  // 有了正确的 sideSpan 后它几乎不触发，留着是为了让超深嵌套 / 环数据也不会甩出画布。
  const hubLeftBound = marginX;
  const hubRightBound = viewportWidth - nodeWidth - marginX;
  const clampX = (x, side) => {
    if (side === "left") return Math.min(Math.max(x, hubLeftBound), Math.max(hubLeftBound, hubX - nodeWidth));
    if (side === "right") return Math.min(Math.max(x, hubX + nodeWidth), hubRightBound);
    return Math.min(Math.max(x, hubLeftBound), hubRightBound);
  };

  // 递归摆放。`depth` = 「距枢纽的列数」，恒 ≥ 1，方向由 direction 决定。
  // 子节点列号 = 父列号 + item.col + 1（+1 = 跨出父所在列）。
  // 配合 sideSpan 的正确列数，深度不会超过画布。
  const placeBox = (nodeId, box, side, depth, topY) => {
    const direction = side === "left" ? -1 : 1;
    sides.set(nodeId, side);
    positions.set(nodeId, { x: clampX(hubX + direction * depth * columnPitch, side), y: topY + (box.nodeY || 0) });
    if (!box.packed) return;
    const nodeCenterY = topY + (box.nodeY || 0) + nodeHeight / 2;
    const blockTop = nodeCenterY - box.packed.height / 2;
    box.packed.placed.forEach((item) => {
      placeBox(item.id, item.box, side, depth + 1 + item.col, blockTop + item.offsetY);
    });
  };
  // 枢纽先注册为「root」，让视口回位（reset / 数字键 0）以它为中心
  if (hubId) {
    sides.set(hubId, "root");
    positions.set(hubId, { x: clampX(hubX, "root"), y: centerY - nodeHeight / 2 });
  }
  // 主轴其余节点横向排在枢纽左侧，同样标记为 root（文字左对齐）
  spine.slice(0, -1).forEach((nodeId, index) => {
    sides.set(nodeId, "root");
    positions.set(nodeId, { x: clampX(hubX - (spineLen - index) * columnPitch, "root"), y: centerY - nodeHeight / 2 });
  });
  const placeSide = (pack, side, extraDepth) => {
    const blockTop = centerY - pack.height / 2;
    pack.placed.forEach((item) => {
      placeBox(item.id, item.box, side, extraDepth + item.col, blockTop + item.offsetY);
    });
  };
  placeSide(leftPack, "left", 1);
  placeSide(rightPack, "right", 1);

  // ————————————————————————————————————————————————————————————————
  // 紧贴内容收缩 viewBox（shrink-to-content）
  // 原版把 viewBox 按「理论列数 × columnPitch」铺满，于是内容只占一半时
  // 图形被等比缩小 + 大片留白 —— 截图里图谱"又小又挤"的直接原因。
  // 这里改为量出所有节点的真实包围盒，再把 viewBox 收到它 + margin，
  // 保证任何规模的图谱都撑满画布、不浪费一像素。
  // ————————————————————————————————————————————————————————————————
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  positions.forEach((pos) => {
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + nodeWidth);
    maxY = Math.max(maxY, pos.y + nodeHeight);
  });
  // 空图谱：positions 为空时退回到原来的居中默认框
  if (!Number.isFinite(minX)) {
    minX = hubX; maxX = hubX + nodeWidth; minY = centerY - nodeHeight / 2; maxY = centerY + nodeHeight / 2;
  }
  const bboxW = maxX - minX;
  const bboxH = maxY - minY;
  // 画布至少 620×340，避免一两个节点时被拉成极端比例；
  // 内容比下限大时，左右各留 marginX、上下各留 marginY 的呼吸位。
  const finalWidth = Math.max(620, bboxW + marginX * 2);
  const finalHeight = Math.max(340, bboxH + marginY * 2);
  // 把内容整体平移，使包围盒左沿落在 marginX、垂直居中。
  const shiftX = marginX - minX + (finalWidth - (bboxW + marginX * 2)) / 2;
  const shiftY = (finalHeight - bboxH) / 2 - minY;
  positions.forEach((pos, id) => {
    positions.set(id, { x: pos.x + shiftX, y: pos.y + shiftY });
  });

  return {
    positions, children, sides,
    width: finalWidth, height: finalHeight,
    viewportWidth: finalWidth, viewportHeight: finalHeight,
    nodeWidth, nodeHeight,
  };
}

function graphNodeTitleMarkup(name, x = 25, anchor = "start") {
  const normalized = String(name || "未命名知识点").trim();
  const maxChars = 13;
  const firstLine = truncate(normalized, maxChars + 1).replace(/…$/, "");
  const remainder = normalized.slice(firstLine.length);
  const secondLine = remainder ? truncate(remainder, maxChars + 1) : "";
  const lines = secondLine ? [firstLine, secondLine] : [truncate(normalized, maxChars + 1)];
  return `<text class="graph-node-title" x="${x}" y="22" text-anchor="${anchor}">${lines.map((line, index) => `<tspan x="${x}" dy="${index ? 14 : 0}">${escapeHtml(line)}</tspan>`).join("")}</text>`;
}

function bindFrameworkViewport(svg, layout) {
  const viewport = svg.querySelector(".graph-viewport");
  const wrap = svg.closest(".graph-wrap");
  const label = wrap.parentElement.querySelector(".graph-zoom-label") || null;
  const controls = wrap.parentElement.querySelectorAll("[data-graph-action]");
  const view = { zoom: 1, x: 0, y: 0, dragging: false, moved: false };
  const rootEntry = [...layout.sides.entries()].find(([, side]) => side === "root");
  const rootPosition = rootEntry ? layout.positions.get(rootEntry[0]) : null;
  let dragOrigin = null;
  let panOrigin = null;
  // 指针按下时的屏幕坐标：拖动阈值只按屏幕像素判（见 pointermove），
  // 不能拿 svgPoint() 的 SVG 单位去比 —— 那个会被 viewBox 缩放放大。
  let dragClient = null;

  // Ensure a fresh flag on the SVG element (used by node click handler instead of racy class+setTimeout)
  svg._justPanned = false;

  const clampPan = () => {
    const scaledWidth = layout.width * view.zoom;
    const scaledHeight = layout.height * view.zoom;
    view.x = scaledWidth <= layout.viewportWidth
      ? (layout.viewportWidth - scaledWidth) / 2
      : Math.max(layout.viewportWidth - scaledWidth, Math.min(0, view.x));
    view.y = scaledHeight <= layout.viewportHeight
      ? (layout.viewportHeight - scaledHeight) / 2
      : Math.max(layout.viewportHeight - scaledHeight, Math.min(0, view.y));
  };
  const renderView = () => {
    clampPan();
    viewport.setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.zoom})`);
    if (label) { label.value = `${Math.round(view.zoom * 100)}%`; label.textContent = label.value; }
    svg.classList.toggle("graph-is-zoomed", view.zoom > 1.001);
  };
  const svgPoint = (clientX, clientY) => {
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const matrix = svg.getScreenCTM();
    return matrix ? point.matrixTransform(matrix.inverse()) : { x: layout.viewportWidth / 2, y: layout.viewportHeight / 2 };
  };
  const setZoom = (nextZoom, anchor = { x: layout.viewportWidth / 2, y: layout.viewportHeight / 2 }) => {
    const previousZoom = view.zoom;
    const graphX = (anchor.x - view.x) / previousZoom;
    const graphY = (anchor.y - view.y) / previousZoom;
    view.zoom = Math.max(0.15, Math.min(4, nextZoom));
    view.x = anchor.x - graphX * view.zoom;
    view.y = anchor.y - graphY * view.zoom;
    renderView();
  };
  const centerRootView = () => {
    // 回位 = 以根节点为中心放大看（zoom=1 已是全图总览，这里放大到 1.5 保证文字可读）
    view.zoom = 1.5;
    view.x = rootPosition ? layout.viewportWidth / 2 - (rootPosition.x + layout.nodeWidth / 2) * view.zoom : 0;
    view.y = rootPosition ? layout.viewportHeight / 2 - (rootPosition.y + layout.nodeHeight / 2) * view.zoom : 0;
    renderView();
  };
  const overviewView = () => {
    view.zoom = Math.min(1, layout.viewportWidth / layout.width, layout.viewportHeight / layout.height);
    view.x = 0;
    view.y = 0;
    renderView();
  };

  // ----- Expose API for sidebar to pan+zoom to a specific node by ID -----
  svg._panToNodeId = (nodeId) => {
    const pos = layout.positions.get(nodeId);
    if (!pos) return;
    const nodeCenterX = pos.x + layout.nodeWidth / 2;
    const nodeCenterY = pos.y + layout.nodeHeight / 2;
    // Zoom in a bit for clarity (between overview zoom and 1.25, capped at 1.25)
    const overviewZoom = Math.min(1, layout.viewportWidth / layout.width, layout.viewportHeight / layout.height);
    view.zoom = Math.max(Math.min(1.25, overviewZoom * 1.8), Math.min(1.25, overviewZoom + 0.2));
    view.x = layout.viewportWidth / 2 - nodeCenterX * view.zoom;
    view.y = layout.viewportHeight / 2 - nodeCenterY * view.zoom;
    renderView();
  };

  svg.addEventListener("wheel", (event) => {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0015);
    setZoom(view.zoom * factor, svgPoint(event.clientX, event.clientY));
  }, { passive: false });
  svg.addEventListener("dblclick", (event) => {
    // 双击节点 = 打开掌握度分析，不触发画布缩放
    if (event.target?.closest?.(".graph-node")) return;
    event.preventDefault();
    setZoom(view.zoom * 1.28, svgPoint(event.clientX, event.clientY));
  });
  svg.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    // Reset leftover pan flag from previous interaction (in case click landed on non-node area)
    svg._justPanned = false;
    view.dragging = true;
    view.moved = false;
    dragOrigin = svgPoint(event.clientX, event.clientY);
    dragClient = { x: event.clientX, y: event.clientY };
    panOrigin = { x: view.x, y: view.y };
    // 注意：不能在这里 setPointerCapture——捕获会把同一手势的 click/dblclick 重定向到 svg，
    // 导致节点 <g> 上的点击/双击处理器永远不触发。改为在 pointermove 判定为拖动后再捕获。
    svg.classList.add("graph-is-panning");
  });
  svg.addEventListener("pointermove", (event) => {
    if (!view.dragging) return;
    // 兜底：未捕获指针时在 svg 外松开按键，靠 buttons 状态纠正卡住的拖动标记
    if (!(event.buttons & 1)) { view.dragging = false; svg.classList.remove("graph-is-panning"); return; }
    const point = svgPoint(event.clientX, event.clientY);
    const deltaX = point.x - dragOrigin.x;
    const deltaY = point.y - dragOrigin.y;
    // ⚠️ 阈值必须按「屏幕像素」判，不能按 SVG 单位。图谱缩放到 0.45 时，3 个
    // SVG 单位只有约 1.3 屏幕像素 —— 鼠标抖 2px 就被判成拖动，pointerup 把
    // svg._justPanned 置真，随后 click 被节点处理器当作"刚拖完"吞掉，表现就是
    // 「点节点没反应、语义护照不出现」。双链图谱用的是同一套 client 像素判法
    // （kbFlowInit 里的 cdx/cdy），这里对齐它。
    if (!view.moved && Math.hypot(event.clientX - dragClient.x, event.clientY - dragClient.y) > 5) {
      view.moved = true;
      // 确认是拖动后再捕获指针，保证移出 svg 后平移不中断
      try { svg.setPointerCapture(event.pointerId); } catch { /* 忽略不支持的情况 */ }
    }
    if (!view.moved) return; // 未超阈值不动画布，避免单击产生微小位移
    view.x = panOrigin.x + deltaX;
    view.y = panOrigin.y + deltaY;
    renderView();
  });
  const finishPan = (event) => {
    if (!view.dragging) return;
    view.dragging = false;
    if (event && svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    svg.classList.remove("graph-is-panning");
    // Use a plain boolean flag (set in pointerup TASK, checked in click TASK which runs after).
    // Avoids the racy class+setTimeout(0) pattern where setTimeout callback executed AFTER click handler.
    svg._justPanned = !!view.moved;
    if (view.moved) {
      svg.classList.add("graph-was-dragged");
      setTimeout(() => svg.classList.remove("graph-was-dragged"), 0);
    }
  };
  svg.addEventListener("pointerup", finishPan);
  svg.addEventListener("pointercancel", finishPan);
  svg.addEventListener("keydown", (event) => {
    if (["+", "="].includes(event.key)) setZoom(view.zoom * 1.2);
    else if (["-", "_"].includes(event.key)) setZoom(view.zoom / 1.2);
    else if (event.key === "0") centerRootView();
    else return;
    event.preventDefault();
  });
  controls.forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    const action = button.dataset.graphAction;
    if (action === "zoom-in") setZoom(view.zoom * 1.2);
    if (action === "zoom-out") setZoom(view.zoom / 1.2);
    if (action === "overview") overviewView();
    if (action === "reset") centerRootView();
  }));
  overviewView();
}

function highlightFrameworkBranch(svg, nodeId, active) {
  svg.querySelectorAll(".graph-edge").forEach((edge) => {
    const connected = (edge.dataset.edgeNodes || "").split(" ").includes(nodeId);
    if (connected) edge.classList.toggle("graph-edge-active", active);
  });
}

function bindNodeDetailDialog(dialog) {
  if (!dialog) return;
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => {
    $("#studio-output").querySelectorAll(".graph-node").forEach((element) => {
      element.classList.remove("graph-node-selected");
      element.removeAttribute("aria-pressed");
    });
  });
}

function frameworkDescendantIds(nodeId) {
  const descendants = new Set();
  const queue = [nodeId];
  while (queue.length) {
    const parentId = queue.shift();
    state.nodes.forEach((node) => {
      if (node.parent_id === parentId && !descendants.has(node.node_id)) {
        descendants.add(node.node_id);
        queue.push(node.node_id);
      }
    });
  }
  return descendants;
}

function renderNodeDetail(nodeId) {
  renderNodeEditor(nodeId);
}

function renderNodeEditor(nodeId = "", parentId = null) {
  const node = state.nodes.find((item) => item.node_id === nodeId) || null;
  const dialog = $("#node-detail-dialog");
  if (!dialog) return;
  const activeParentId = node ? node.parent_id : parentId;
  const excluded = node ? frameworkDescendantIds(node.node_id) : new Set();
  if (node) excluded.add(node.node_id);
  const parentOptions = state.nodes
    .filter((item) => !excluded.has(item.node_id))
    .map((item) => `<option value="${escapeAttr(item.node_id)}" ${item.node_id === activeParentId ? "selected" : ""}>${escapeHtml(item.name)}</option>`)
    .join("");
  const title = node ? "编辑知识节点" : "新增知识节点";
  const status = node ? statusLabel(node) : "手动创建";
  const coverageToggle = node
    ? node.coverage_status === "uncovered"
      ? `<button class="mini-button" data-node-command="cover" type="button" title="将该节点重新标记为已被来源覆盖">恢复覆盖</button>`
      : `<button class="mini-button" data-node-command="remove" type="button" title="手动移除此节点的覆盖标记（视为未覆盖/待补全）">移出覆盖</button>`
    : "";
  // 「确认关联」仅对「待确认」节点有意义：AI 学习事件置信度过低时节点进入待确认且不加分，
  // 此按钮是解除该状态的唯一入口。对其他状态的节点点击只会把状态误改为「已遇到」，故隐藏。
  const confirmToggle = node && node.learning_status === "pending_confirmation"
    ? `<button class="mini-button" data-node-command="confirm" type="button" title="确认 AI 的关联无误，将节点从「待确认」标记为「已遇到」">确认关联</button>`
    : "";
  $("#node-detail").innerHTML = `<article class="node-detail"><header class="node-detail-heading"><div><p class="eyebrow">${escapeHtml(status)}</p><h3 id="node-detail-title">${title}</h3></div><button class="node-detail-close" data-dialog-action="close" type="button" aria-label="关闭节点编辑" title="关闭">×</button></header><form id="node-edit-form" class="node-edit-form"><label>节点名称<input id="node-edit-name" maxlength="80" required value="${escapeAttr(node?.name || "")}"></label><label>知识内容<textarea id="node-edit-description" rows="5" maxlength="2000" placeholder="填写定义、机制、条件或结论">${escapeHtml(node?.description || "")}</textarea></label><label>上级节点<select id="node-edit-parent"><option value="">无（顶层节点）</option>${parentOptions}</select></label>${node ? `<small>来源 ${(node.source_ids || []).length} · 掌握度 ${Math.round(node.mastery_score * 100)}%</small>` : ""}<div class="node-edit-actions"><button class="primary-button" type="submit">保存</button>${node ? `<button class="mini-button" data-node-command="add-child" type="button">＋ 子节点</button>${confirmToggle}${coverageToggle}<button class="mini-button danger" data-node-command="delete" type="button">删除</button>` : ""}</div></form></article>`;
  $("#node-detail [data-dialog-action='close']").addEventListener("click", () => dialog.close());
  $("#node-edit-form").addEventListener("submit", (event) => saveFrameworkNode(event, node));
  $$("#node-detail [data-node-command]").forEach((button) => button.addEventListener("click", () => {
    const command = button.dataset.nodeCommand;
    if (command === "add-child") renderNodeEditor("", node.node_id);
    else if (command === "delete") deleteFrameworkNode(node);
    else correctNode(node, command);
  }));
  $("#studio-output").querySelectorAll(".graph-node").forEach((element) => {
    const selected = Boolean(node && element.dataset.nodeId === node.node_id);
    element.classList.toggle("graph-node-selected", selected);
    if (selected) element.setAttribute("aria-pressed", "true");
    else element.removeAttribute("aria-pressed");
  });
  if (!dialog.open) dialog.showModal();
  $("#node-edit-name").focus({ preventScroll: true });
}

async function saveFrameworkNode(event, node) {
  event.preventDefault();
  const name = $("#node-edit-name").value.trim();
  const description = $("#node-edit-description").value.trim();
  const parentId = $("#node-edit-parent").value || null;
  if (!name) return showError(new Error("节点名称不能为空。"));
  const request = node
    ? {
        url: `/api/projects/${state.currentProjectId}/framework/${encodeURIComponent(node.node_id)}`,
        options: {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ node_id: node.node_id, action: "edit", target_node_id: parentId, name, description }),
        },
      }
    : {
        url: `/api/projects/${state.currentProjectId}/framework/nodes`,
        options: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, description, parent_id: parentId }),
        },
      };
  try {
    await api(request.url, request.options);
    await refreshCurrentProject();
    renderFramework();
  } catch (error) {
    showError(error, () => saveFrameworkNode(event, node));
  }
}

async function deleteFrameworkNode(node) {
  if (!window.confirm(`删除节点“${node.name}”？其直接子节点会自动上移一层。`)) return;
  try {
    await api(`/api/projects/${state.currentProjectId}/framework/${encodeURIComponent(node.node_id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node_id: node.node_id, action: "delete" }),
    });
    await refreshCurrentProject();
    renderFramework();
  } catch (error) {
    showError(error, () => deleteFrameworkNode(node));
  }
}

async function correctNode(node, action) {
  const retry = () => correctNode(node, action);
  try {
    await api(`/api/projects/${state.currentProjectId}/framework/${encodeURIComponent(node.node_id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node_id: node.node_id, action }),
    });
    await refreshCurrentProject();
    renderFramework();
    // Important: renderFramework() recreates the entire output DOM (including the dialog).
    // Re-open the node editor so the user sees the *new* state immediately:
    //   - top eyebrow label (e.g. "未覆盖" → "来源覆盖")
    //   - bottom coverage toggle button (e.g. "恢复覆盖" → "移出覆盖")
    // Without this the dialog silently vanishes → appears like a no-op to the user.
    const latest = state.nodes.find((n) => n.node_id === node.node_id);
    if (latest) renderNodeEditor(latest.node_id);
  } catch (error) {
    // Prepend a short hint so that 422 (e.g. stale server rejecting action="cover")
    // or network errors are harder to miss even when the error toast is behind the dialog.
    const detail = (error && typeof error === "object" && "message" in error)
      ? String(error.message)
      : String(error);
    const visible = new Error(`[${actionLabelForAction(action)}] 操作失败：${detail}${
      action === "cover"
        ? "（若提示 action 值不合法，请重启后端服务使 models.py 新的 action 字面量生效）"
        : ""
    }`);
    showError(visible, retry);
  }
}

function actionLabelForAction(action) {
  switch (action) {
    case "confirm": return "确认关联";
    case "remove":  return "移出覆盖";
    case "cover":   return "恢复覆盖";
    case "reassign":return "重新归类";
    case "edit":    return "编辑";
    case "delete":  return "删除";
    default:        return action;
  }
}

function renderOverview() {
  hideTextHighlightToolbar();
  if (!state.nodes.length) return renderEmptyOutput("暂无学习数据", "构建框架后，学习行为会在这里积累。");
  const stats = overviewStats();
  const activeFilter = overviewFilter(stats);
  // AI 建议激活时，「优先复习」队列改由进步引擎的候选顺序驱动（每条带 AI 写的理由）
  let focusNodes = overviewFocusNodes(stats, activeFilter);
  const aiActive = activeFilter === "priority" && Array.isArray(state.overviewAiPlan) && state.overviewAiPlan.length;
  if (aiActive) {
    const byId = new Map(state.nodes.map((n) => [n.node_id, n]));
    focusNodes = state.overviewAiPlan.map((s) => byId.get(s.node_id)).filter(Boolean);
  }
  $("#studio-output").innerHTML = `
    <section class="overview-dashboard" aria-label="学习概览">
      <div class="overview-hero">
        <div>
          <p class="eyebrow">Mastery</p>
          <h3>${stats.average}%</h3>
          <span>平均掌握度 · ${stats.total} 个知识点</span>
        </div>
        <button class="mini-button" type="button" data-overview-action="open-framework">查看知识框架</button>
      </div>
      <div class="metrics">
        ${metricCard("来源覆盖", `${stats.covered}/${stats.total}`, stats.covered / stats.total * 100)}
        ${metricCard("已经遇到", `${stats.encountered}/${stats.total}`, stats.encountered / stats.total * 100)}
        ${metricCard("已经掌握", stats.mastered, stats.mastered / stats.total * 100)}
        ${metricCard("待补证据", stats.needsSource, stats.needsSource / stats.total * 100)}
      </div>
      <article class="overview-panel">
        <div class="overview-section-heading">
          <div>
            <h3>掌握度分配</h3>
            <p>每个知识点按当前掌握度落入一个档位，下面的百分比合计为 100%。</p>
          </div>
          <span>${stats.masteryReadyPercent}% 达到可确认学习区间</span>
        </div>
        <div class="mastery-stack" aria-label="掌握度档位分配">
          ${stats.buckets.map((bucket) => `<button class="mastery-stack-segment ${bucket.className}" style="width:${bucket.percent}%" type="button" data-overview-action="filter" data-filter="${bucket.key}" tabindex="${bucket.percent ? "0" : "-1"}" aria-label="${escapeAttr(`${bucket.label} ${bucket.percent}%`)}" title="${escapeAttr(`${bucket.label} ${bucket.percent}%`)}"><span>${bucket.percent}%</span></button>`).join("")}
        </div>
        <div class="mastery-buckets">
          ${stats.buckets.map((bucket) => `<button class="mastery-bucket ${activeFilter === bucket.key ? "active" : ""}" type="button" data-overview-action="filter" data-filter="${bucket.key}" aria-pressed="${activeFilter === bucket.key ? "true" : "false"}"><i class="${bucket.className}"></i><strong>${bucket.percent}%</strong><span>${bucket.label}</span><small>${bucket.count} 个 · ${bucket.range}</small></button>`).join("")}
        </div>
      </article>
      <article class="overview-panel overview-action-panel">
        <div class="overview-section-heading">
          <div>
            <h3>${overviewListTitle(activeFilter)}</h3>
            <p>${aiActive ? `<span class="overview-ai-note">✨ 以下建议由 AI 生成（基于进步引擎分桶）</span>` : escapeHtml(nextStudySuggestion())}</p>
          </div>
          <div class="overview-actions">
            <button class="mini-button" type="button" data-overview-action="ai-suggest">${aiActive ? "更新 AI 建议" : "✨ AI 建议"}</button>
            <button class="mini-button" type="button" data-overview-action="start-quiz">打开测验</button>
            <button class="mini-button" type="button" data-overview-action="open-cards">打开卡片</button>
            <button class="mini-button" type="button" data-overview-action="${state.overviewKits?.learning_path ? "view-path" : "gen-path"}">${state.overviewKits?.learning_path ? "查看学习路径" : "生成学习路径"}</button>
            <button class="mini-button" type="button" data-overview-action="${state.overviewKits?.checklist ? "view-report" : "gen-report"}">${state.overviewKits?.checklist ? "查看清单报告" : "生成清单报告"}</button>
          </div>
        </div>
        <div class="overview-node-list">
          ${focusNodes.length ? focusNodes.map((node, idx) => overviewNodeMarkup(node, activeFilter === "priority" ? idx + 1 : 0)).join("") : `<p class="overview-empty-note">这个分组暂时没有知识点。</p>`}
        </div>
      </article>
    </section>`;
}

function metricCard(label, value, percent) {
  return `<article class="metric-card"><strong>${value}</strong><span>${label}</span><div class="progress-track"><i style="width:${Math.max(0, Math.min(100, percent))}%"></i></div></article>`;
}

/** 掌握度透明化：拉取 rules + breakdown，刷新后按需重绘当前视图 */
async function refreshMasteryBreakdown({ reRender = true } = {}) {
  if (!state.currentProjectId) return null;
  const data = await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/mastery/breakdown`);
  state.masteryRules = data.rules || null;
  state.masteryBreakdown = data || null;
  if (reRender) {
    if (state.feature === "framework") renderFramework();
  }
  return data;
}

/** 把 kind 代码转中文标签（优先用后端 rules） */
function masteryKindLabel(kind) {
  return state.masteryRules?.kind_labels?.[kind]
    || ({ question: "提问", solve: "做题", card: "知识卡片", quiz: "测验", discuss: "讨论", baseline: "历史/基线" }[kind] || kind);
}
function masteryKindClass(kind) {
  return ({ question: "k-question", solve: "k-solve", card: "k-card", quiz: "k-quiz", baseline: "k-baseline" }[kind] || "k-other");
}

/** 返回「单个节点维度的掌握度来源分析」面板（原黄框 + 蓝框合并改造）
 * - 顶部：下拉选节点（默认是当前「优先复习/筛选结果」的第一个节点）
 * - 主体：左边展示该节点总分 + 测验正确率；右边是 4 个悬浮小图标（=蓝框改造：默认只显示图标，不直接展示贡献条）
 *   图标角标直接显示"该来源贡献了多少%"；悬停气泡预览贡献分 / 行为次数；点击弹出明细记录弹框（复用 openMasteryTrailModal）
 */
function masteryNodeBreakdownPanelMarkup(preferredNodeId) {
  const nodes = state.nodes || [];
  if (!nodes.length) {
    return `<article class="overview-panel">
      <div class="overview-section-heading">
        <div><h3>掌握度来源分析</h3><p class="muted">项目还没有任何知识节点，去「知识框架」先生成或创建节点吧。</p></div>
      </div>
    </article>`;
  }

  // 选默认视角：优先用调用方传入的 preferredNodeId；否则用 state 记忆；再退回到当前筛选/全部第一个
  let currentId = preferredNodeId || state.overviewSelectedNodeId;
  if (!currentId || !nodes.some((n) => n.node_id === currentId)) {
    const firstList = overviewListForFilter();
    currentId = (firstList[0]?.node_id) || (state.overviewPriorityList?.[0]?.node_id) || nodes[0].node_id;
  }
  state.overviewSelectedNodeId = currentId;
  const currentNode = nodes.find((n) => n.node_id === currentId) || nodes[0];
  const info = state.masteryBreakdown?.by_node?.[currentId];
  const rules = state.masteryRules || null;
  const kinds = ["question", "card", "solve", "quiz"];
  const contributions = info?.contributions || {};
  const trails = info?.trail_by_kind || {};
  const correctness = info?.correctness || {};
  const eventCount = Number(info?.event_count || 0);
  // 每个 kind 给出"可展示行为数"，优先用 trails 长度；当 trails 缺但 info 汇总仍有时，
  // 用该 kind 的 correctness count 兜底（避免"22.8% · 0 次行为"这种矛盾文案）。
  const kindDisplayCount = (k) => {
    const n = Array.isArray(trails[k]) ? trails[k].length : 0;
    if (n > 0) return n;
    if (k === "quiz" && correctness.quiz?.count) return Number(correctness.quiz.count) || 0;
    // 总事件数 > 0 且 该 kind 有贡献时，至少回退为"若干次"（给一个有意义的最小下限 1）
    const s = Number(contributions[k] || 0);
    if (eventCount > 0 && s > 1e-9) return 1;
    return 0;
  };
  const quizCorr = info?.correctness?.quiz || null;
  const totalScore = Number(currentNode?.mastery_score ?? 0);
  const sumContrib = kinds.reduce((s, k) => s + Number(contributions[k] || 0), 0) + Number(contributions.baseline || 0);

  // 排序：先把所有节点按 name 稳定列（当前筛选结果在前）
  const listNodeIds = new Set((overviewListForFilter() || []).map((n) => n.node_id));
  const orderedNodes = [...nodes].sort((a, b) => {
    const aIn = listNodeIds.has(a.node_id) ? 0 : 1;
    const bIn = listNodeIds.has(b.node_id) ? 0 : 1;
    if (aIn !== bIn) return aIn - bIn;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
  const options = orderedNodes.map((n) => {
    const score = Math.round((n.mastery_score || 0) * 100);
    const sel = n.node_id === currentId ? " selected" : "";
    const inList = listNodeIds.has(n.node_id) ? " ●" : "";
    return `<option value="${escapeAttr(n.node_id)}"${sel}>${escapeHtml(n.name)} — ${score}%${inList}</option>`;
  }).join("");

  const kindIcon = {
    question: "💬", // 提问(对话气泡)
    card: "🎴",    // 卡片
    solve: "📝",   // 做题(钢笔/练习本)
    quiz: "✅",    // 测验(对勾)
  };
  const sideIcons = kinds.map((k) => {
    const score = Number(contributions[k] || 0);
    const trailLen = Array.isArray(trails[k]) ? trails[k].length : 0;
    const count = kindDisplayCount(k);
    const w = rules?.weights?.[k] != null ? `权重 ${pct(rules.weights[k])}` : "";
    // 禁用条件：既没有贡献分、也没有任何可展示行为数、也没有明细 trail
    const disabled = trailLen === 0 && count === 0 && score <= 1e-9;
    // 角标：百分比，>0 才显示
    const badge = score > 1e-9 ? `<em class="side-badge">${pct(score)}</em>` : (count > 0 ? `<em class="side-badge side-badge-dot">${count}</em>` : "");
    const title = `${masteryKindLabel(k)}${w ? " · " + w : ""}${score > 1e-9 ? ` · 贡献 ${pct(score)}` : count ? ` · 已有 ${count} 次` : " · 暂无记录"}`;
    return `<button
      type="button"
      class="side-kind-icon ${masteryKindClass(k)}${disabled ? " is-empty" : ""}"
      data-mastery-trail-kind="${escapeAttr(k)}"
      data-mastery-trail-scope="node"
      data-mastery-trail-node="${escapeAttr(currentId)}"
      ${disabled ? "disabled" : ""}
      title="${escapeAttr(title)}"
    >
      <span class="sicon-emoji" aria-hidden="true">${kindIcon[k] || "•"}</span>
      <span class="sicon-label">${masteryKindLabel(k)}</span>
      ${badge}
    </button>`;
  }).join("");

  const emptyHint = !info
    ? `<p class="muted empty-state-tip">掌握度明细还没加载，点击右上角 ↻ 刷新或提问/做卡片/做题/测验一次后会生成。</p>`
    : "";

  return `
  <article class="overview-panel node-breakdown-panel" data-role="node-breakdown-panel">
    <div class="overview-section-heading">
      <div>
        <h3>单个节点 · 掌握度来源分析</h3>
        <p>选择任意知识点查看 提问 / 知识卡片 / 做题 / 测验 分别带来了多少掌握度。右侧 4 个图标 = 四来源（蓝框收起为可点击悬浮图标）。</p>
      </div>
      <button class="mini-button" type="button" data-overview-action="refresh-mastery" title="刷新掌握度明细">↻ 刷新</button>
    </div>
    <div class="node-breakdown-layout">
      <section class="node-breakdown-main">
        <label class="node-breakdown-select">
          <span>当前节点</span>
          <select data-role="node-breakdown-select" id="node-breakdown-select">
            ${options}
          </select>
        </label>
        <div class="node-breakdown-summary">
          <div class="nbs-card nbs-score">
            <small>当前掌握度</small>
            <strong>${pct(totalScore)}</strong>
            <div class="progress-track"><i style="width:${Math.round(totalScore * 100)}%"></i></div>
          </div>
          <div class="nbs-card nbs-quiz">
            <small>测验正确率（仅看判分题）</small>
            ${quizCorr ? `<strong>${pct(quizCorr.avg_correctness)}</strong><span>${quizCorr.count} 道</span>` : `<strong class="muted">—</strong><span>暂无判分测验</span>`}
          </div>
        </div>
        ${emptyHint}
        <div class="node-breakdown-hot">
          <small class="muted">直接点击右侧图标查看该来源的完整记录（时间/正确度/置信度/对掌握度的贡献）：</small>
          <ul class="nb-hot-links">
            ${kinds.map((k) => {
              const s = Number(contributions[k] || 0);
              const n = kindDisplayCount(k);
              const trailLen = Array.isArray(trails[k]) ? trails[k].length : 0;
              const cls = masteryKindClass(k);
              let disp;
              if (s > 1e-9) {
                disp = n > 0 ? `${pct(s)} · ${n}次行为` : `${pct(s)}`;
              } else if (n > 0) {
                disp = `${n}次行为`;
              } else {
                disp = "暂无记录";
              }
              const hasTrail = trailLen > 0;
              const clickable = (s > 1e-9) || (n > 0) || hasTrail;
              if (clickable) {
                return `<li class="nbk-mini nbk-mini-btn ${cls}"
                  role="button"
                  tabindex="0"
                  title="${masteryKindLabel(k)}：${disp}${hasTrail ? " · 点击查看明细" : ""}"
                  data-mastery-trail-kind="${escapeAttr(k)}"
                  data-mastery-trail-scope="node"
                  data-mastery-trail-node="${escapeAttr(currentId)}">
                  <span>${masteryKindLabel(k)}</span><em>${disp}</em>
                </li>`;
              }
              return `<li class="nbk-mini ${cls}" title="${masteryKindLabel(k)}：${disp}">
                <span>${masteryKindLabel(k)}</span><em>${disp}</em>
              </li>`;
            }).join("")}
          </ul>
        </div>
      </section>
      <aside class="side-kind-icons" aria-label="四来源悬浮图标">
        ${sideIcons}
      </aside>
    </div>
  </article>`;
}

/** 懒创建并打开「节点掌握度分析」dialog，展示 masteryNodeBreakdownPanelMarkup 的内容 */
function openNodeMasteryAnalysisDialog(preferredNodeId) {
  let dlg = document.getElementById("node-mastery-dialog");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "node-mastery-dialog";
    dlg.className = "node-mastery-dialog";
    dlg.innerHTML = `
      <form method="dialog" class="node-mastery-inner" onsubmit="event.preventDefault()">
        <header class="node-mastery-header">
          <div>
            <h3 id="node-mastery-title">节点掌握度分析</h3>
            <p id="node-mastery-subtitle" class="muted">从概览或框架点击任意节点即可打开。</p>
          </div>
          <div class="node-mastery-header-actions">
            <button type="button" class="mini-button" id="node-mastery-edit-btn" title="编辑这个节点">✎ 编辑节点</button>
            <button type="button" class="node-detail-close" id="node-mastery-close" aria-label="关闭" title="关闭">×</button>
          </div>
        </header>
        <div id="node-mastery-body" class="node-mastery-body"></div>
      </form>`;
    document.body.appendChild(dlg);
    dlg.querySelector("#node-mastery-close").addEventListener("click", () => dlg.close());
    dlg.addEventListener("click", (ev) => {
      const rect = dlg.getBoundingClientRect();
      if (ev.clientX < rect.left || ev.clientX > rect.right || ev.clientY < rect.top || ev.clientY > rect.bottom) {
        dlg.close();
      }
    });
  }

  // 先确保 breakdown 数据已加载
  const doRender = () => {
    const body = dlg.querySelector("#node-mastery-body");
    const panelHtml = masteryNodeBreakdownPanelMarkup(preferredNodeId);
    // 去掉外层 article 的 overview-panel 外壳（dialog 里不需要），直接取内部内容
    // 但保留 class 以便样式
    body.innerHTML = panelHtml;

    // 更新 title
    const currentNode = state.nodes.find((n) => n.node_id === state.overviewSelectedNodeId);
    dlg.querySelector("#node-mastery-title").textContent = currentNode
      ? `「${currentNode.name}」· 掌握度分析`
      : "节点掌握度分析";

    // 绑定下拉切换事件（之前没绑定过）
    const select = body.querySelector("[data-role='node-breakdown-select']");
    if (select) {
      select.addEventListener("change", () => {
        state.overviewSelectedNodeId = select.value;
        // 更新 preferredNodeId 以编辑按钮能用
        preferredNodeId = select.value;
        doRender();
      });
    }

    // 绑定 dialog 内的刷新按钮（全局 handleStudioOutputClick 不覆盖 body 下的 dialog）
    body.querySelectorAll("[data-overview-action='refresh-mastery']").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "加载中…";
        try {
          await refreshMasteryBreakdown({ reRender: false });
          doRender();
        } catch (e) {
          showError(e);
        } finally {
          btn.disabled = false;
          btn.innerHTML = "↻ 刷新";
        }
      });
    });

    // 绑定所有来源明细入口（side-kind-icon 按钮 + nbk 小按钮 + nbk-mini 红框标签）
    // 统一 stopPropagation 避免 dialog 外层"点击 outside 关闭"逻辑误触发
    const handleOpenTrail = (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      const el = ev.currentTarget;
      const kind = el.dataset.masteryTrailKind;
      const scope = el.dataset.masteryTrailScope || "aggregate";
      const nodeId = el.dataset.masteryTrailNode || null;
      openMasteryTrailModal(kind, scope, nodeId);
    };
    body.querySelectorAll("[data-mastery-trail-kind]").forEach((el) => {
      if (el.hasAttribute("disabled") && el.getAttribute("disabled") !== "false") return;
      el.addEventListener("click", handleOpenTrail);
      // 键盘可达
      el.addEventListener("keydown", (ev) => {
        if (["Enter", " "].includes(ev.key)) {
          ev.preventDefault();
          ev.stopPropagation();
          handleOpenTrail(ev);
        }
      });
    });
  };

  // 编辑节点按钮
  const editBtn = dlg.querySelector("#node-mastery-edit-btn");
  editBtn.onclick = () => {
    const nid = state.overviewSelectedNodeId;
    dlg.close();
    // 如果当前在 framework 视图，直接开编辑弹窗；否则先切到 framework
    if (state.feature !== "framework") {
      switchFeature("framework");
      requestAnimationFrame(() => renderNodeDetail(nid));
    } else {
      renderNodeDetail(nid);
    }
  };

  // 如果 breakdown 还没加载过，先加载
  if (!state.masteryBreakdown) {
    refreshMasteryBreakdown({ reRender: false }).then(() => {
      doRender();
      if (!dlg.open) dlg.showModal();
    }).catch((e) => {
      showError(e);
    });
  } else {
    doRender();
    if (!dlg.open) dlg.showModal();
  }
}

function nodeMasteryBreakdownMarkup(nodeId) {
  const info = state.masteryBreakdown?.by_node?.[nodeId];
  if (!info) return "";
  const kinds = ["question", "card", "solve", "quiz"];
  const trails = info.trail_by_kind || {};
  const parts = kinds.map((k) => {
    const s = Number(info.contributions?.[k] || 0);
    if (s <= 1e-9) return "";
    const n = Array.isArray(trails[k]) ? trails[k].length : 0;
    const canClick = n > 0;
    if (canClick) {
      return `<button
        type="button"
        class="nbk nbk-btn ${masteryKindClass(k)}"
        title="点击查看本节点的「${masteryKindLabel(k)}」明细记录（${n} 条）"
        data-mastery-trail-kind="${escapeAttr(k)}"
        data-mastery-trail-scope="node"
        data-mastery-trail-node="${escapeAttr(nodeId)}"
      >${masteryKindLabel(k)} ${pct(s)} · ${n}次</button>`;
    }
    return `<span class="nbk ${masteryKindClass(k)}" title="${masteryKindLabel(k)} 贡献 ${pct(s)}（无明细记录）">${masteryKindLabel(k)} ${pct(s)}</span>`;
  }).filter(Boolean).join("") || `<span class="muted">尚无行为贡献</span>`;
  const base = Number(info.contributions?.baseline || 0);
  return `
    <div class="node-mastery-breakdown" data-node-id="${escapeAttr(nodeId)}">
      <div class="nbk-row">${parts}${base > 1e-9 ? `<span class="nbk k-baseline" title="历史/基线">基线 ${pct(base)}</span>` : ""}</div>
    </div>`;
}

function pct(x) {
  const n = Number(x || 0);
  return `${Math.round(n * 1000) / 10}%`;
}

/** 懒创建「掌握度来源记录」dialog。 */
function ensureMasteryTrailDialog() {
  let dlg = document.getElementById("mastery-trail-dialog");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "mastery-trail-dialog";
    dlg.className = "mastery-trail-dialog";
    dlg.innerHTML = `
      <form method="dialog" class="mastery-trail-inner" onsubmit="event.preventDefault()">
        <header class="mastery-trail-header">
          <div>
            <h3 id="mastery-trail-title">掌握度记录</h3>
            <p id="mastery-trail-subtitle" class="mastery-trail-sub"></p>
          </div>
          <button type="button" class="node-detail-close" id="mastery-trail-close" aria-label="关闭" title="关闭">×</button>
        </header>
        <div id="mastery-trail-toolbar" class="mastery-trail-toolbar"></div>
        <div id="mastery-trail-body" class="mastery-trail-body"></div>
        <footer id="mastery-trail-footer" class="mastery-trail-footer"></footer>
      </form>`;
    document.body.appendChild(dlg);
    dlg.querySelector("#mastery-trail-close").addEventListener("click", () => dlg.close());
    // backdrop/ESC 关
    dlg.addEventListener("click", (ev) => {
      const rect = dlg.getBoundingClientRect();
      if (ev.clientX < rect.left || ev.clientX > rect.right || ev.clientY < rect.top || ev.clientY > rect.bottom) {
        dlg.close();
      }
    });
  }
  return dlg;
}

function _formatMasteryTime(s) {
  if (!s) return "-";
  try {
    const d = new Date(typeof s === "string" && !/Z$/i.test(s) ? s.replace(" ", "T") + "Z" : s);
    if (Number.isNaN(d.getTime())) return String(s);
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch (_) {
    return String(s);
  }
}

/** 从掌握度 trail 记录跳转回原始卡片或测验题目 */
async function navigateFromTrail(kind, referenceId) {
  if (!referenceId) { showNotice("该条记录没有关联的卡片/测验，无法跳转。"); return; }

  // 先关闭 trail 弹窗（否则遮住跳转效果）
  try {
    const dlg = document.getElementById("mastery-trail-dialog");
    if (dlg && typeof dlg.close === "function") dlg.close();
  } catch (e) { /* ignore */ }

  if (kind === "card") {
    switchFeature("cards");
    // 可能正在后台生成 cards → 轮询等生成完成（最多等 15s）
    await _waitUntil(() => !state.generatingCards, 15000);
    // 如果 cards 为空，尝试通过 API 加载（可能还没加载过）
    if (!state.cards.length && state.currentProjectId) {
      try {
        const data = await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/cards`);
        if (data.cards) state.cards = data.cards;
      } catch (_) { /* ignore */ }
    }
    if (!state.cards.length) {
      showNotice("还没有可用的知识卡片，无法跳转。"); return;
    }
    // 先精确匹配 data-origin-id = cardId
    let el = document.querySelector(`.card[data-origin-id="${CSS.escape(referenceId)}"]`);
    if (!el) {
      // 匹配不到可能是 trail 的 cardId 是历史脏值，尝试在 state.cards 中按 card_id 找
      const matched = state.cards.find((c) => c.card_id === referenceId);
      if (matched) {
        // 重新渲染后重试——如果卡片存在但不在当前视图，重新渲染使其出现
        renderCards();
        await _waitUntil(() => !!document.querySelector(`.card[data-origin-id="${CSS.escape(referenceId)}"]`), 5000, 100);
        el = document.querySelector(`.card[data-origin-id="${CSS.escape(referenceId)}"]`);
      }
    }
    if (!el) {
      // 兜底：滚动到第一张卡片 + 友好提示
      showNotice(`参考卡片 ID：${referenceId.slice(0, 12)}… 没在当前列表中找到；请尝试在卡片列表中手动查找。`);
      el = document.querySelector(".card");
    }
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("is-flash");
      setTimeout(() => el.classList.remove("is-flash"), 2500);
      const inner = el.querySelector(".flip-card-inner");
      if (inner && !inner.classList.contains("is-flipped")) {
        inner.classList.add("is-flipped");
        if (el.dataset.originId) state.openCardIds.add(el.dataset.originId);
      }
    }
  } else if (kind === "quiz") {
    const [quizId, idxStr] = String(referenceId).split(":");
    let idx = Number(idxStr);
    if (!Number.isFinite(idx) || idx < 0) idx = 0;

    // 先检查当前是否在历史测验视图中，且匹配的是同一历史测验
    if (state.viewingHistoryQuiz && state.viewingHistoryQuiz.quiz_id === quizId) {
      // 已在历史测验视图，直接定位
      let target = document.querySelector(`.quiz-question[data-origin-id="${CSS.escape(referenceId)}"]`);
      if (!target) {
        const arr = document.querySelectorAll(".quiz-question");
        target = arr[idx] || arr[arr.length - 1] || null;
      }
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.add("is-flash");
        setTimeout(() => target.classList.remove("is-flash"), 2500);
        return;
      }
    }

    // 尝试切换到当前测验视图
    switchFeature("quiz");
    await _waitUntil(() => !state.generatingQuiz, 15000);
    
    // 如果 quiz 还没加载，尝试通过 API 拉取
    if ((!state.quiz || !state.quiz.quiz_id) && state.currentProjectId) {
      try {
        const data = await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/quiz/current`);
        if (data && data.quiz) state.quiz = data.quiz;
      } catch (_) { /* ignore */ }
    }

    if (!state.quiz || !(state.quiz.questions || []).length) {
      // 当前没有可用测验，尝试切换到历史测验视图
      if (state.quizHistory === null) await loadQuizHistory();
      const historicEntry = (state.quizHistory || []).find((q) => q.quiz_id === quizId);
      if (historicEntry) {
        enterHistoricQuizView(quizId);
        await _waitUntil(() => !!document.querySelector(".historic-quiz-questions"), 5000, 100);
        let target = document.querySelector(`.quiz-question[data-origin-id="${CSS.escape(referenceId)}"]`);
        if (!target) {
          const arr = document.querySelectorAll(".quiz-question");
          target = arr[idx] || arr[arr.length - 1] || null;
        }
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "center" });
          target.classList.add("is-flash");
          setTimeout(() => target.classList.remove("is-flash"), 2500);
          return;
        }
      }
      showNotice("还没有可用的小测验，无法跳转。"); return;
    }

    // 如果 trail 里 quizId ≠ 当前 latest quiz（可能历史），提醒用户但仍跳到最近一次的对应题号
    const latestQuizId = state.quiz.quiz_id;
    const qs = state.quiz.questions || [];
    if (idx >= qs.length) idx = qs.length - 1;

    let target = null;
    // 优先 data-origin-id = {quizId}:{idx} 精确定位
    const exactOrigin = `${quizId}:${idx}`;
    target = document.querySelector(`.quiz-question[data-origin-id="${CSS.escape(exactOrigin)}"]`);
    if (!target && latestQuizId && latestQuizId !== quizId) {
      // 历史 quizId ≠ latest，用 latest 的同题号 origin
      target = document.querySelector(`.quiz-question[data-origin-id="${CSS.escape(`${latestQuizId}:${idx}`)}"]`);
    }
    if (!target) {
      // 兜底：按 nth 匹配
      const arr = document.querySelectorAll(".quiz-question");
      target = arr[idx] || arr[arr.length - 1] || null;
    }
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.add("is-flash");
      setTimeout(() => target.classList.remove("is-flash"), 2500);
    } else {
      showNotice("跳转失败：当前小测验列表中找不到对应题目。");
    }
    if (latestQuizId && latestQuizId !== quizId) {
      setTimeout(() => showNotice(`当前显示的是最近一次小测验（${latestQuizId.slice(0, 10)}…），已定位到第 ${idx + 1} 题。`), 800);
    }
  } else {
    showNotice("此来源类型暂无对应视图可跳转。");
  }
}

/**
 * 学习日历的事件行点击 → 跳回对应内容。
 * 契约来自 static/streak.js 的 CustomEvent（两文件保持解耦，streak.js 不读 state）。
 * detail: { kind, referenceId, projectId, projectName, nodeId, date }
 */
document.addEventListener("knoworigin:calendar-jump", async (event) => {
  const d = event.detail || {};
  try {
    // 日历是跨课程聚合的：记录属于别的课程时先切过去（selectProject 内部会重渲染并回到 framework）
    if (d.projectId && d.projectId !== state.currentProjectId) {
      await selectProject(d.projectId);
    }
    if (!state.currentProjectId) {
      showNotice("请先选择一个项目，再跳转。");
      return;
    }
    if ((d.kind === "card" || d.kind === "quiz") && d.referenceId) {
      await navigateFromTrail(d.kind, d.referenceId);
      return;
    }
    // question / solve：后端已按 ±15s 把对应对话消息的 message_id 带回，直接跳回那条对话
    if ((d.kind === "question" || d.kind === "solve") && d.messageId) {
      const msg = document.querySelector(`.message[data-message-id="${CSS.escape(d.messageId)}"]`);
      if (msg) {
        msg.scrollIntoView({ behavior: "smooth", block: "center" });
        msg.classList.add("is-flash");
        setTimeout(() => msg.classList.remove("is-flash"), 2500);
      } else {
        showNotice("这条对话记录已不存在（可能已被删除）。");
      }
      return;
    }
    // 无 message_id 可回跳的 question / solve（历史旧数据）才退到对应知识节点的掌握度分析
    if (d.nodeId) {
      switchFeature("framework");
      await _waitUntil(() => (state.nodes || []).length > 0, 5000);
      if (!state.nodes.some((n) => n.node_id === d.nodeId)) {
        showNotice(`该知识点不在「${d.projectName || "当前项目"}」的知识框架里。`);
        return;
      }
      openNodeMasteryAnalysisDialog(d.nodeId);
      return;
    }
    // 有卡片/测验但缺引用 → 至少切到对应 tab
    if (d.kind === "card") { switchFeature("cards"); return; }
    if (d.kind === "quiz") { switchFeature("quiz"); return; }
    showNotice("这条记录没有可跳转的目标。");
  } catch (error) {
    showNotice("跳转失败：" + (error?.message || error));
  }
});

/** 轮询等条件满足，直到 timeout；返回是否等到。 */
function _waitUntil(cond, timeoutMs = 5000, intervalMs = 60) {
  return new Promise((resolve) => {
    if (cond()) return resolve(true);
    const start = Date.now();
    const t = setInterval(() => {
      if (cond()) { clearInterval(t); return resolve(true); }
      if (Date.now() - start > timeoutMs) { clearInterval(t); return resolve(false); }
    }, intervalMs);
  });
}

/**
 * 打开掌握度来源记录弹框。
 * scope: "aggregate" 全项目；"node" 仅某节点
 */
async function openMasteryTrailModal(kind, scope = "aggregate", nodeId = null) {
  const dlg = ensureMasteryTrailDialog();

  // 自动刷新：如果 breakdown 还没加载，先拉数据
  if (!state.masteryBreakdown) {
    try {
      await refreshMasteryBreakdown({ reRender: false });
    } catch (e) {
      showError(e);
      return;
    }
  }

  const scopeLabel = scope === "aggregate" ? "全项目" : `节点「${state.masteryBreakdown?.by_node?.[nodeId]?.node_name || nodeId || ""}」`;
  const label = masteryKindLabel(kind);
  document.getElementById("mastery-trail-title").textContent = `我的${label}记录 · ${scopeLabel}`;

  let records = [];
  let contributionScore = 0;
  if (scope === "aggregate") {
    records = (state.masteryBreakdown?.aggregate?.trails_by_kind?.[kind]) || [];
    contributionScore = Number(state.masteryBreakdown?.aggregate?.contributions?.[kind] || 0);
  } else {
    records = (state.masteryBreakdown?.by_node?.[nodeId]?.trail_by_kind?.[kind]) || [];
    contributionScore = Number(state.masteryBreakdown?.by_node?.[nodeId]?.contributions?.[kind] || 0);
  }

  // 如果 records 为空但有贡献分，可能是 breakdown 未就绪，自动刷新一次
  if (records.length === 0 && contributionScore > 1e-9) {
    try {
      await refreshMasteryBreakdown({ reRender: false });
      if (scope === "aggregate") {
        records = (state.masteryBreakdown?.aggregate?.trails_by_kind?.[kind]) || [];
        contributionScore = Number(state.masteryBreakdown?.aggregate?.contributions?.[kind] || 0);
      } else {
        records = (state.masteryBreakdown?.by_node?.[nodeId]?.trail_by_kind?.[kind]) || [];
        contributionScore = Number(state.masteryBreakdown?.by_node?.[nodeId]?.contributions?.[kind] || 0);
      }
    } catch (e) {
      showError(e);
      return;
    }
  }

  const showNode = scope === "aggregate";
  const total = records.length;
  document.getElementById("mastery-trail-subtitle").textContent = `共 ${total} 条 · 按时间倒序显示，点击「掌握度明细」可随时切换来源。`;

  const PAGE_SIZE = 20;
  let page = 1;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function renderPage() {
    const start = (page - 1) * PAGE_SIZE;
    const pageRows = records.slice(start, start + PAGE_SIZE);
    const rows = pageRows.map((r) => {
      const gain = Number(r.gain || 0);
      const corr = r.correctness;
      const corrStr = corr == null ? "<em class=\"muted\">默认</em>" : pct(corr);
      const conf = Number(r.confidence ?? 0);
      const outcome = r.outcome === "applied"
        ? `<span class="trail-status applied">已计入 +${pct(gain)}</span>`
        : `<span class="trail-status pending">待确认（置信度过低）</span>`;
      const nodeCell = showNode ? `<td>${escapeHtml(r.node_name || r.node_id || "-")}</td>` : "";
      const kindLabel = { question: "提问", solve: "做题", card: "知识卡片", quiz: "测验", discuss: "讨论" }[r.kind] || r.kind;
      const ref = r.reference_id;
      const refLabel = (() => {
        if (!ref) return "-";
        if (r.kind === "card") {
          const card = state.cards.find((c) => c.card_id === ref);
          if (card) return escapeHtml(card.front.slice(0, 40) + (card.front.length > 40 ? "…" : ""));
          return `卡片 ${escapeHtml(ref.slice(-6))}`;
        }
        if (r.kind === "quiz") {
          const parts = ref.split(":");
          if (parts.length === 2 && state.quiz?.questions?.[Number(parts[1])]) {
            const q = state.quiz.questions[Number(parts[1])];
            return escapeHtml(q.question.slice(0, 40) + (q.question.length > 40 ? "…" : ""));
          }
          return `测验第 ${Number(parts[1] || 0) + 1} 题`;
        }
        return escapeHtml(ref.slice(-10));
      })();
      const clickable = !!ref && (r.kind === "card" || r.kind === "quiz");
      const refCell = `<td class="trail-ref" title="${clickable ? "点击跳转" : ""}">${escapeHtml(kindLabel)} · ${refLabel}</td>`;
      return `<tr class="${clickable ? "is-clickable" : ""}" ${clickable ? `data-trail-kind="${r.kind}" data-trail-ref="${escapeAttr(ref)}"` : ""}>
        <td>${_formatMasteryTime(r.created_at)}</td>
        ${nodeCell}
        ${refCell}
        <td>${corrStr}</td>
        <td>${pct(conf)}</td>
        <td>${pct(Number(r.gain_basis ?? 0))}</td>
        <td>${outcome}</td>
        <td class="trail-id muted"><code>${escapeHtml(String(r.event_id || "").slice(0, 10))}</code></td>
      </tr>`;
    }).join("");
    let table;
    if (total === 0) {
      if (contributionScore > 1e-9) {
        // 贡献存在但明细 trails 为空（历史/压缩/统计汇总来源）——给兜底文案避免误导"没有任何记录"
        table = `<div class="empty-state"><p>该来源贡献 ${pct(contributionScore)}，但明细 trail 暂无可展示条目。<br><small>贡献通常来自历史数据或按题汇总的统计值；你可以先到「学习概览 → 刷新掌握度明细」拉取最新数据，或稍后再试。</small></p></div>`;
      } else {
        table = `<div class="empty-state"><p>当前范围内还没有任何${label}记录。<br><small>试着去提问、做一张卡片、做一道题或提交一次测验，这里就会出现行为明细。</small></p></div>`;
      }
    } else {
      table = `<div class="mastery-trail-table-wrap">
          <table class="mastery-trail-table">
            <thead>
              <tr>
                <th style="width:150px">时间</th>
                ${showNode ? "<th style=\"min-width:180px\">知识点</th>" : ""}
                <th style="min-width:200px">来源（点击可跳转）</th>
                <th style="width:90px">正确度</th>
                <th style="width:90px">置信度</th>
                <th style="width:110px">实际基础度*<br><small class=\"muted\">=正确度/默认正确度（进入公式前）</small></th>
                <th style="min-width:150px">对掌握度的影响</th>
                <th style="width:90px">记录ID</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }
    document.getElementById("mastery-trail-body").innerHTML = table;
    // 绑定行点击
    document.getElementById("mastery-trail-body")?.querySelectorAll("tr.is-clickable").forEach((tr) => {
      tr.addEventListener("click", () => {
        const k = tr.dataset.trailKind;
        const r = tr.dataset.trailRef;
        if (k && r) navigateFromTrail(k, r);
      });
    });
    const pager = (() => {
      if (total <= PAGE_SIZE) return "";
      const prev = page <= 1 ? "<button disabled class=\"mini-button\">上一页</button>" : `<button class="mini-button" data-trail-page="prev">上一页</button>`;
      const next = page >= totalPages ? "<button disabled class=\"mini-button\">下一页</button>" : `<button class="mini-button" data-trail-page="next">下一页</button>`;
      const first = page === 1 ? "<button disabled class=\"mini-button\">首页</button>" : `<button class="mini-button" data-trail-page="first">首页</button>`;
      const last = page === totalPages ? "<button disabled class=\"mini-button\">末页</button>" : `<button class="mini-button" data-trail-page="last">末页</button>`;
      return `<div class="mastery-trail-pager">${first}${prev}<span class="pager-info">第 ${page} / ${totalPages} 页 · 记录 ${start + 1}-${Math.min(start + PAGE_SIZE, total)} / ${total}</span>${next}${last}</div>`;
    })();
    document.getElementById("mastery-trail-footer").innerHTML = pager;
    document.getElementById("mastery-trail-footer").querySelectorAll("[data-trail-page]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const act = btn.dataset.trailPage;
        if (act === "first") page = 1;
        else if (act === "prev") page = Math.max(1, page - 1);
        else if (act === "next") page = Math.min(totalPages, page + 1);
        else if (act === "last") page = totalPages;
        renderPage();
      });
    });
  }
  renderPage();

  // 工具栏：切来源 + 刷新按钮
  const kinds = ["question", "card", "solve", "quiz"];
  const countMap = {};
  const contribMap = {};
  kinds.forEach((k) => {
    if (scope === "aggregate") {
      countMap[k] = state.masteryBreakdown?.aggregate?.trails_by_kind?.[k]?.length || 0;
      contribMap[k] = Number(state.masteryBreakdown?.aggregate?.contributions?.[k] || 0);
    } else {
      countMap[k] = state.masteryBreakdown?.by_node?.[nodeId]?.trail_by_kind?.[k]?.length || 0;
      contribMap[k] = Number(state.masteryBreakdown?.by_node?.[nodeId]?.contributions?.[k] || 0);
    }
  });
  document.getElementById("mastery-trail-toolbar").innerHTML = `
    <div class="mastery-trail-switch">
      ${kinds.map((k) => {
        const showContrib = countMap[k] === 0 && contribMap[k] > 1e-9;
        const labelCount = countMap[k];
        const disable = (countMap[k] === 0 && contribMap[k] <= 1e-9);
        return `
        <button type="button"
          class="pill ${masteryKindClass(k)}${k === kind ? " is-active" : ""}${labelCount === 0 ? " is-empty" : ""}"
          data-trail-switch="${escapeAttr(k)}"
          ${disable ? "disabled" : ""}>
          ${masteryKindLabel(k)} · ${showContrib ? `${pct(contribMap[k])} 贡献` : labelCount}
        </button>`;
      }).join("")}
      <button type="button" class="mini-button" id="mastery-trail-refresh" title="刷新记录">↻ 刷新</button>
    </div>`;
  document.getElementById("mastery-trail-toolbar").querySelectorAll("[data-trail-switch]").forEach((b) => {
    b.addEventListener("click", async () => {
      const nk = b.dataset.trailSwitch;
      if (!nk || nk === kind) return;
      // 按需刷新：若 breakdown 还没就绪，先拉一次
      if (!state.masteryBreakdown) {
        try { await refreshMasteryBreakdown({ reRender: false }); } catch (e) { showError(e); return; }
      }
      openMasteryTrailModal(nk, scope, nodeId);
    });
  });
  document.getElementById("mastery-trail-refresh")?.addEventListener("click", async () => {
    try {
      await refreshMasteryBreakdown({ reRender: false });
      openMasteryTrailModal(kind, scope, nodeId);
    } catch (e) { showError(e); }
  });

  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
}

function overviewStats() {
  const nodes = state.nodes;
  const total = nodes.length || 1;
  const buckets = [
    { key: "unstarted", label: "未开始", range: "0%", className: "is-unstarted", nodes: nodes.filter((node) => node.mastery_score <= 0) },
    { key: "encountered", label: "已接触", range: "1-34%", className: "is-encountered", nodes: nodes.filter((node) => node.mastery_score > 0 && node.mastery_score < 0.35) },
    { key: "learning", label: "学习中", range: "35-79%", className: "is-learning", nodes: nodes.filter((node) => node.mastery_score >= 0.35 && node.mastery_score < 0.8) },
    { key: "mastered", label: "已掌握", range: "80-100%", className: "is-mastered", nodes: nodes.filter((node) => node.mastery_score >= 0.8) },
  ];
  const percents = allocatePercentages(buckets.map((bucket) => bucket.nodes.length), nodes.length);
  buckets.forEach((bucket, index) => {
    bucket.count = bucket.nodes.length;
    bucket.percent = percents[index];
  });
  const covered = nodes.filter((node) => node.coverage_status === "covered").length;
  const mastered = buckets.find((bucket) => bucket.key === "mastered")?.count || 0;
  const learning = buckets.find((bucket) => bucket.key === "learning")?.count || 0;
  return {
    total: nodes.length,
    covered,
    mastered,
    buckets,
    encountered: nodes.filter((node) => node.learning_status !== "unexplored").length,
    needsSource: nodes.filter((node) => ["insufficient_source", "missing_prerequisite"].includes(node.coverage_status)).length,
    average: Math.round(nodes.reduce((sum, node) => sum + node.mastery_score, 0) / total * 100),
    masteryReadyPercent: Math.round((learning + mastered) / total * 100),
  };
}

function allocatePercentages(counts, total) {
  if (!total) return counts.map(() => 0);
  const raw = counts.map((count) => count / total * 100);
  const rounded = raw.map(Math.floor);
  let remaining = 100 - rounded.reduce((sum, value) => sum + value, 0);
  raw
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder)
    .forEach(({ index }) => {
      if (remaining > 0) {
        rounded[index] += 1;
        remaining -= 1;
      }
    });
  return rounded;
}

function overviewFilter(stats) {
  const validFilters = new Set(["priority", ...stats.buckets.map((bucket) => bucket.key)]);
  if (!validFilters.has(state.overviewFilter)) state.overviewFilter = "priority";
  return state.overviewFilter;
}

function overviewFocusNodes(stats, filter) {
  if (filter !== "priority") return stats.buckets.find((bucket) => bucket.key === filter)?.nodes || [];
  return [...state.nodes]
    .sort((a, b) => {
      const aNeedsSource = ["insufficient_source", "missing_prerequisite"].includes(a.coverage_status) ? -1 : 0;
      const bNeedsSource = ["insufficient_source", "missing_prerequisite"].includes(b.coverage_status) ? -1 : 0;
      return aNeedsSource - bNeedsSource || a.mastery_score - b.mastery_score;
    })
    .slice(0, 6);
}

function overviewListForFilter() {
  const stats = overviewStats();
  const filter = overviewFilter(stats);
  if (filter !== "priority") return stats.buckets.find((bucket) => bucket.key === filter)?.nodes || [];
  return [...state.nodes]
    .sort((a, b) => {
      const aNeedsSource = ["insufficient_source", "missing_prerequisite"].includes(a.coverage_status) ? -1 : 0;
      const bNeedsSource = ["insufficient_source", "missing_prerequisite"].includes(b.coverage_status) ? -1 : 0;
      return aNeedsSource - bNeedsSource || a.mastery_score - b.mastery_score;
    })
    .slice(0, 6);
}

function overviewListTitle(filter) {
  const titles = {
    priority: "下一步学习队列",
    unstarted: "未开始知识点",
    encountered: "已接触知识点",
    learning: "学习中知识点",
    mastered: "已掌握知识点",
  };
  return titles[filter] || titles.priority;
}

function overviewNodeMarkup(node, rank = 0) {
  const score = Math.round(node.mastery_score * 100);
  const sourceCount = (node.source_ids || []).length;
  const sourceText = sourceCount ? `${sourceCount} 个来源` : "暂无来源";
  const breakdownBar = nodeMasteryBreakdownMarkup(node.node_id) || `<div class="node-mastery-breakdown placeholder"></div>`;
  // AI 建议：优先复习模式下，若有该节点的 AI 文案就展示在状态行上方（替换普通状态行）
  const aiStep = Array.isArray(state.overviewAiPlan)
    ? state.overviewAiPlan.find((s) => s.node_id === node.node_id)
    : null;
  const aiText = aiStep ? String(aiStep.suggestion || "").trim() : "";
  const statusLine = aiText
    ? `<small class="overview-ai-suggestion"><span class="ai-spark" aria-hidden="true">✦</span><span class="ai-text">${escapeHtml(aiText)}</span></small>`
    : `<small class="overview-node-status"><span class="status-chip">${escapeHtml(statusLabel(node))}</span><span>${escapeHtml(sourceText)}</span></small>`;
  // NOTE: 这里用 div + role=button 而不是 <button>，是因为卡片内部还要放明细
  // 条的 <button>（nbk-btn），HTML 不允许 <button> 嵌套 <button>。
  return `<div class="overview-node-card is-with-breakdown${rank > 0 ? " has-rank" : ""}" role="button" tabindex="0"
    data-overview-action="open-node" data-node-id="${escapeAttr(node.node_id)}">
    ${rank > 0 ? `<span class="onc-rank" aria-hidden="true">${rank}</span>` : ""}
    <span class="onc-main">
      <span class="onc-head">
        <strong>${escapeHtml(node.name)}</strong>
        <span class="mastery-ring${score > 0 ? "" : " is-zero"}" style="--p:${score}" role="img" aria-label="${escapeAttr(`掌握度 ${score}%`)}"><b>${score}%</b></span>
      </span>
      ${statusLine}
      ${breakdownBar}
      <span class="overview-node-quick-actions" role="group" aria-label="${escapeAttr(`为「${node.name}」快速生成学习材料`)}">
        <button class="mini-button qa-card" type="button" data-overview-action="node-card" data-node-id="${escapeAttr(node.node_id)}"
          title="为「${escapeAttr(node.name)}」生成知识卡片（存入卡片库）">＋卡片</button>
        <button class="mini-button qa-quiz" type="button" data-overview-action="node-quiz" data-node-id="${escapeAttr(node.node_id)}"
          title="为「${escapeAttr(node.name)}」生成小测验（存入测验库）">＋测验</button>
      </span>
    </span>
    <span class="progress-track" aria-hidden="true"><i style="width:${score}%"></i></span>
  </div>`;
}

function handleOverviewAction(button) {
  const action = button.dataset.overviewAction;
  if (action === "filter") {
    const nextFilter = button.dataset.filter || "priority";
    // 「优先复习」独立按钮已移除：再点一次当前档位 = 回到优先队列（默认视图）
    state.overviewFilter = (state.overviewFilter === nextFilter) ? "priority" : nextFilter;
    renderOverview();
  } else if (action === "refresh-mastery") {
    button.disabled = true;
    refreshMasteryBreakdown({ reRender: true })
      .catch((e) => showError(e))
      .finally(() => { button.disabled = false; });
  } else if (action === "open-node") {
    const nodeId = button.dataset.nodeId;
    openNodeMasteryAnalysisDialog(nodeId);
  } else if (action === "open-framework") {
    switchFeature("framework");
  } else if (action === "start-quiz") {
    switchFeature("quiz");
    expandStudio(button);
  } else if (action === "open-cards") {
    switchFeature("cards");
    expandStudio(button);
  } else if (action === "node-card") {
    overviewQuickGenerate("card", button.dataset.nodeId, button);
  } else if (action === "node-quiz") {
    overviewQuickGenerate("quiz", button.dataset.nodeId, button);
  } else if (action === "ai-suggest") {
    overviewAiSuggest(button);
  } else if (action === "gen-path") {
    overviewGenerateReport("learning_path", button);
  } else if (action === "gen-report") {
    overviewGenerateReport("checklist", button);
  } else if (action === "view-path") {
    overviewViewReport("learning_path");
  } else if (action === "view-report") {
    overviewViewReport("checklist");
  }
}

/** 打开已保存的学习路径 / 清单报告（不重新生成）。 */
function overviewViewReport(kind) {
  const kit = state.overviewKits?.[kind];
  if (!kit) return;
  const markdown = String(kit.content_md || "").trim();
  if (!markdown) return;
  openStudyReportDialog(kind, kit.title || (kind === "checklist" ? "清单报告" : "学习路径"), markdown);
}

/** 生成「学习路径 / 清单报告」并在弹窗里展示。
 * 复用 study-kit 端点（POST /study-kit/generate {kind}），生成结果同时落库（学习台历也能看到）。
 * 学习路径 = learning_path，清单报告 = checklist。生成中按钮置灰；完成后弹窗渲染 Markdown。 */
async function overviewGenerateReport(kind, button) {
  if (!state.currentProjectId) return requireProject(() => {});
  if (button && button.disabled) return;
  const projectId = state.currentProjectId;
  const originalText = button ? button.textContent : "";
  if (button) {
    button.disabled = true;
    button.textContent = "生成中…";
  }
  const restore = () => {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  };
  try {
    const data = await api(`/api/projects/${encodeURIComponent(projectId)}/study-kit/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind }),
    });
    if (state.currentProjectId !== projectId) return;
    const kit = data?.kit || {};
    const markdown = String(kit.content_md || "").trim();
    if (!markdown) throw new Error("这次没有生成出正文，稍后重试。");
    // 记进本地缓存，概览按钮下次直接显示「查看…」，不用再生成
    state.overviewKits = state.overviewKits || {};
    state.overviewKits[kind] = kit;
    openStudyReportDialog(kind, kit.title || (kind === "checklist" ? "清单报告" : "学习路径"), markdown);
    showToast(`已生成${kit.title || "报告"}，同时保存到学习台历`, { variant: "notice" });
    renderOverview(); // 让按钮从「生成」翻成「查看」
  } catch (error) {
    if (state.currentProjectId !== projectId) return;
    restore();
    showError(error, () => overviewGenerateReport(kind, button));
    return;
  }
  restore();
}

/** 打开「学习路径 / 清单报告」大号预览弹窗，支持重新生成与编辑。
 * kind ∈ {learning_path, checklist}：决定「重新生成/编辑保存」落到哪个 study-kit。 */
function openStudyReportDialog(kind, title, markdown) {
  let dialog = $("#study-report-dialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "study-report-dialog";
    dialog.className = "study-report-dialog";
    dialog.innerHTML = `
      <header class="study-report-head">
        <h3 id="study-report-title"></h3>
        <div class="study-report-head-actions">
          <button type="button" class="mini-button" data-report-action="edit">编辑</button>
          <button type="button" class="mini-button" data-report-action="regenerate">重新生成</button>
          <button type="button" class="study-report-close" data-report-close aria-label="关闭" title="关闭">×</button>
        </div>
      </header>
      <div class="study-report-body" id="study-report-body"></div>
      <textarea class="study-report-editor" id="study-report-editor" spellcheck="false" hidden></textarea>
      <footer class="study-report-foot">
        <span class="study-report-hint" id="study-report-hint"></span>
        <span class="study-report-foot-actions">
          <button type="button" class="mini-button" data-report-action="save" hidden>保存</button>
          <button type="button" class="mini-button" data-report-action="cancel" hidden>取消</button>
          <button type="button" class="primary-button" data-report-close>关闭</button>
        </span>
      </footer>`;
    document.body.appendChild(dialog);
    dialog.addEventListener("click", (event) => {
      if (event.target.closest("[data-report-close]")) {
        if (dialog.dataset.editing === "1") {
          showToast("编辑中，先「保存」或「取消」。", { variant: "notice" });
          return;
        }
        dialog.close();
        return;
      }
      if (event.target === dialog) {
        if (dialog.dataset.editing === "1") return; // 编辑中点遮罩不关，防误丢
        dialog.close();
        return;
      }
      const actionBtn = event.target.closest("[data-report-action]");
      if (actionBtn) handleStudyReportAction(actionBtn.dataset.reportAction, dialog);
    });
  }
  dialog.dataset.kind = kind;
  dialog.dataset.editing = "0";
  $("#study-report-title").textContent = title;
  $("#study-report-editor").value = markdown;
  $("#study-report-hint").textContent = "";
  $("#study-report-editor").hidden = true;
  $("#study-report-body").hidden = false;
  $("#study-report-body").innerHTML = renderStudyReportMarkdown(markdown);
  enhanceStudyReportChecklist();
  toggleReportEditButtons(dialog, false);
  if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
}

/** 把报告 Markdown 渲染成 HTML（含公式 + 清单复选框 ☐/☑）。 */
function renderStudyReportMarkdown(markdown) {
  return renderStudyTextContent(markdown)
    .replace(/<li>\[ \]\s*/g, '<li><span class="study-ck">☐</span> ')
    .replace(/<li>\[[xX]\]\s*/g, '<li><span class="study-ck done">☑</span> ');
}

/** 清单报告渲染后，给每条知识点补「🌷 问海小棠」入口（能力由海小棠桌宠模块提供）。 */
function enhanceStudyReportChecklist() {
  const pet = window.HXT_PET;
  if (pet && typeof pet.enhanceChecklistItems === "function") {
    const body = $("#study-report-body");
    if (body) pet.enhanceChecklistItems(body);
  }
}

/** 切换弹窗的「查看 / 编辑」按钮可见性。 */
function toggleReportEditButtons(dialog, editing) {
  const editBtn = dialog.querySelector('[data-report-action="edit"]');
  const regenBtn = dialog.querySelector('[data-report-action="regenerate"]');
  const saveBtn = dialog.querySelector('[data-report-action="save"]');
  const cancelBtn = dialog.querySelector('[data-report-action="cancel"]');
  if (editBtn) editBtn.hidden = editing;
  if (regenBtn) regenBtn.hidden = editing;
  if (saveBtn) saveBtn.hidden = !editing;
  if (cancelBtn) cancelBtn.hidden = !editing;
}

/** 弹窗内动作分发：编辑 / 取消 / 保存 / 重新生成。 */
function handleStudyReportAction(action, dialog) {
  if (action === "edit") {
    dialog.dataset.editing = "1";
    $("#study-report-body").hidden = true;
    $("#study-report-editor").hidden = false;
    toggleReportEditButtons(dialog, true);
    $("#study-report-editor").focus();
  } else if (action === "cancel") {
    dialog.dataset.editing = "0";
    $("#study-report-editor").hidden = true;
    $("#study-report-body").hidden = false;
    toggleReportEditButtons(dialog, false);
  } else if (action === "save") {
    saveStudyReport(dialog.dataset.kind, dialog);
  } else if (action === "regenerate") {
    regenerateStudyReport(dialog.dataset.kind, dialog);
  }
}

/** 保存编辑后的报告正文（PATCH /study-kit/{kind}），成功回到查看态。 */
async function saveStudyReport(kind, dialog) {
  const pid = state.currentProjectId;
  if (!pid || !kind) return;
  const content = ($("#study-report-editor").value || "").trim();
  if (!content) {
    showError(new Error("报告内容不能为空。"));
    return;
  }
  const saveBtn = dialog.querySelector('[data-report-action="save"]');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "保存中…";
  }
  // 保存只是一次本地 SQLite 写入，正常几百毫秒。给它一个硬超时：
  // 服务重启 / 无响应时（比如另一个窗口改了 src/ 触发 uvicorn 自动重载），
  // 没有 signal 的话 fetch 会一直挂着，「保存中…」永远不消失。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const data = await api(`/api/projects/${encodeURIComponent(pid)}/study-kit/${encodeURIComponent(kind)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content_md: content }),
      signal: controller.signal,
    });
    if (state.currentProjectId !== pid) return;
    const kit = data?.kit || {};
    state.overviewKits = state.overviewKits || {};
    state.overviewKits[kind] = { ...(state.overviewKits[kind] || {}), ...kit };
    dialog.dataset.editing = "0";
    $("#study-report-editor").value = kit.content_md || content;
    $("#study-report-editor").hidden = true;
    $("#study-report-body").hidden = false;
    $("#study-report-body").innerHTML = renderStudyReportMarkdown(kit.content_md || content);
    enhanceStudyReportChecklist();
    toggleReportEditButtons(dialog, false);
    showToast("已保存修改", { variant: "notice" });
  } catch (error) {
    if (error && error.name === "AbortError") {
      showError(
        new Error("保存超时：本地服务此刻没有响应（可能正在重启）。编辑内容还在输入框里，稍等几秒再点「保存」即可。"),
        () => saveStudyReport(kind, dialog),
      );
    } else {
      showError(error, () => saveStudyReport(kind, dialog));
    }
  } finally {
    clearTimeout(timer);
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = "保存";
    }
  }
}

/** 重新生成报告（POST /study-kit/generate），就地替换弹窗内容并更新本地缓存。 */
async function regenerateStudyReport(kind, dialog) {
  const pid = state.currentProjectId;
  if (!pid || !kind) return;
  const regenBtn = dialog.querySelector('[data-report-action="regenerate"]');
  const body = $("#study-report-body");
  if (regenBtn) {
    regenBtn.disabled = true;
    regenBtn.textContent = "重新生成中…";
  }
  if (body) {
    body.hidden = false;
    body.innerHTML = `<p class="muted">正在重新生成，稍候…</p>`;
  }
  try {
    const data = await api(`/api/projects/${encodeURIComponent(pid)}/study-kit/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind }),
    });
    if (state.currentProjectId !== pid) return;
    const kit = data?.kit || {};
    const markdown = String(kit.content_md || "").trim();
    if (!markdown) throw new Error("这次没有生成出正文，稍后重试。");
    state.overviewKits = state.overviewKits || {};
    state.overviewKits[kind] = kit;
    $("#study-report-title").textContent = kit.title || $("#study-report-title").textContent;
    $("#study-report-editor").value = markdown;
    if (body) body.innerHTML = renderStudyReportMarkdown(markdown);
    enhanceStudyReportChecklist();
    showToast("已重新生成", { variant: "notice" });
  } catch (error) {
    if (body) body.innerHTML = `<p class="muted">重新生成失败。</p>`;
    showError(error, () => regenerateStudyReport(kind, dialog));
  } finally {
    if (regenBtn) {
      regenBtn.disabled = false;
      regenBtn.textContent = "重新生成";
    }
  }
}

/** 进入学习概览时恢复「上次生成的内容」，避免重启后每次都要重新生成：
 * 1. 拉 /study-kit 已保存的学习路径/清单报告 → 按钮显示「查看」而非「生成」；
 * 2. 拉 /progress/{id}/suggest 已保存的 AI 建议 → 自动恢复队列（不重新调 LLM）。
 * 都按项目缓存，切项目才重拉；失败静默忽略（保持规则排序，不报错打扰）。 */
async function overviewHydrate() {
  const pid = state.currentProjectId;
  if (!pid) return;

  if (state.overviewKitsProject !== pid) {
    state.overviewKitsProject = pid;
    try {
      const data = await api(`/api/projects/${encodeURIComponent(pid)}/study-kit`);
      const byKind = {};
      (Array.isArray(data?.kits) ? data.kits : []).forEach((k) => {
        if (k?.kind && !byKind[k.kind]) byKind[k.kind] = k;
      });
      state.overviewKits = byKind;
    } catch {
      state.overviewKits = {};
    }
  }

  if (!state.overviewAiPlan && state.overviewSuggestProject !== pid) {
    state.overviewSuggestProject = pid;
    try {
      const data = await api(`/api/progress/${encodeURIComponent(pid)}/suggest`);
      if (data?.saved && Array.isArray(data.steps) && data.steps.length) {
        state.overviewAiPlan = data.steps;
      }
    } catch {
      /* 没保存过 / 无 key：保持规则排序 */
    }
  }

  if (state.feature === "overview") renderOverview();
}

/** 生成 / 更新「AI 优先复习建议」。
 * 点一下 → 拉 progress 端点的 AI 建议并重绘队列；再点一下（按钮已变「更新」）→ 重新生成。
 * 无 API Key（503）或生成失败时保持现状，提示用户，绝不破坏现有队列。 */
async function overviewAiSuggest(button) {
  if (!state.currentProjectId) return;
  if (state.overviewAiBusy) return;
  const projectId = state.currentProjectId;
  state.overviewAiBusy = true;
  if (button) button.disabled = true;
  try {
    const data = await api(`/api/progress/${encodeURIComponent(projectId)}/suggest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (state.currentProjectId !== projectId) return;
    const steps = Array.isArray(data?.steps) ? data.steps : [];
    state.overviewAiPlan = steps;
    if (!steps.length) {
      showToast("暂时没有可生成建议的候选，先上传材料或做点练习。", { variant: "notice" });
    } else if (data?.ai) {
      showToast(`已更新 ${steps.length} 条 AI 复习建议`, { variant: "notice" });
    } else {
      showToast("AI 暂不可用，已回退到规则建议。", { variant: "notice" });
    }
    renderOverview();
  } catch (error) {
    if (state.currentProjectId !== projectId) return;
    // 503（没配 key）等：不破坏现有队列，只提示
    state.overviewAiPlan = null;
    showError(error, () => overviewAiSuggest(button));
  } finally {
    state.overviewAiBusy = false;
    if (button) button.disabled = false;
  }
}

/** 学习队列条目级快捷生成：为单个知识点生成知识卡片 / 小测验。
 * 复用个人知识库面板的按节点端点（/nodes/{id}/card、/nodes/{id}/quiz），
 * 生成结果与主「知识卡片」「小测验」界面共享同一份数据。
 *
 * 切走界面的行为：fetch 不会被取消，后台会继续生成完（数据照常落进 state）；
 * 生成完成后若用户还停在概览页，自动跳转到对应产出页直接看结果；已切走的只提示不抢焦点。
 * 项目已切换时静默丢弃结果（与 generateCards/generateQuiz 同一口径，避免串项目）。 */
async function overviewQuickGenerate(kind, nodeId, button) {
  const projectId = state.currentProjectId; // 捕获，防 await 期间切换项目后的 race
  const node = state.nodes.find((n) => n.node_id === nodeId);
  if (!node || !projectId || button.disabled) return;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "生成中…";
  const restore = () => {
    button.disabled = false;
    button.textContent = originalText;
  };
  try {
    if (kind === "card") {
      const data = await api(`/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/card`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ difficulty: 2, count: 3 }),
      });
      if (state.currentProjectId !== projectId) return; // 已切项目，静默丢弃
      const cards = data.cards || [];
      // 去重合并进卡片库（与 kbGenerateCard 同一口径，重复生成不叠加）
      const known = new Set(state.cards.map((c) => c.card_id));
      state.cards = [...state.cards, ...cards.filter((c) => !known.has(c.card_id))];
      showToast(`已为「${node.name}」生成 ${cards.length} 张知识卡片`, { variant: "notice" });
      if (state.feature === "overview") switchFeature("cards");
    } else {
      const data = await api(`/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/quiz`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ difficulty: 2, question_count: 5, question_types: ["single_choice", "multiple_choice", "fill_blank", "short_answer"] }),
      });
      if (state.currentProjectId !== projectId) return; // 已切项目，静默丢弃
      // 节点测验已存为最新，同步到主「小测验」界面；历史缓存失效
      state.quiz = data;
      state.quizHistory = null;
      showToast(`已为「${node.name}」生成 ${(data.questions || []).length} 题小测验`, { variant: "notice" });
      if (state.feature === "overview") switchFeature("quiz");
    }
  } catch (error) {
    if (state.currentProjectId !== projectId) return; // 已切项目，静默忽略错误
    restore();
    showError(error, () => overviewQuickGenerate(kind, nodeId, button));
    return;
  }
  restore();
}

function nextStudySuggestion() {
  const missing = state.nodes.find((node) => ["insufficient_source", "missing_prerequisite"].includes(node.coverage_status));
  if (missing) return `“${missing.name}”的来源证据不完整，建议补充材料。`;
  const weak = [...state.nodes].sort((a, b) => a.mastery_score - b.mastery_score)[0];
  return weak ? `优先复习“${weak.name}”，完成小测验后再判断是否掌握。` : "继续上传项目材料。";
}

function selectedStudyDifficulty() {
  const difficulty = Number(state.studyDifficulty);
  return Number.isInteger(difficulty) && difficulty >= 1 && difficulty <= 3 ? difficulty : null;
}

function studyGenerationOptions(sourceIds) {
  const body = {};
  if (sourceIds.length) body.source_ids = sourceIds;
  const difficulty = selectedStudyDifficulty();
  if (difficulty) body.difficulty = difficulty;
  // 仅小测验场景携带用户自选题型；卡片生成不受影响。
  if (state.feature === "quiz" && state.quizQuestionTypes.length) {
    body.question_types = [...state.quizQuestionTypes];
  }
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function studySelectionSet(itemType) {
  if (itemType === "card") return state.selectedCardIds;
  if (itemType === "quiz") return state.selectedQuizQuestionIds;
  return null;
}

function studyItemLabel(itemType) {
  return itemType === "card" ? "知识卡片" : "小测验题";
}

function clearStudySelections({ cards = true, quiz = true } = {}) {
  if (cards) state.selectedCardIds = new Set();
  if (quiz) state.selectedQuizQuestionIds = new Set();
}

function currentQuizQuestionOriginIds() {
  const quizId = state.quiz?.quiz_id;
  if (!quizId) return new Set();
  return new Set((state.quiz.questions || []).map((_, index) => `${quizId}:${index}`));
}

function pruneStudySelections() {
  const cardIds = new Set(state.cards.map((card) => card.card_id));
  state.selectedCardIds = new Set([...state.selectedCardIds].filter((cardId) => cardIds.has(cardId)));
  const questionIds = currentQuizQuestionOriginIds();
  state.selectedQuizQuestionIds = new Set([...state.selectedQuizQuestionIds].filter((originId) => questionIds.has(originId)));
}

function studyArtifactToolbarMarkup(itemType, title, detail, meta = {}) {
  pruneStudySelections();
  const badgeLabel = meta.badge || (itemType === "quiz" ? "小测验" : itemType === "card" ? "知识卡" : "学习产出");
  const subLine = meta.sub ? `<span class="sat-sub">${escapeHtml(meta.sub)}</span>` : "";
  const metaLine = `<span class="sat-meta">${escapeHtml(detail)}${subLine}</span>`;
  return `
<div class="study-artifact-toolbar">
  <div class="sat-header">
    <span class="sat-badge" aria-hidden="true">${escapeHtml(badgeLabel)}</span>
    <div class="sat-title-block">
      <strong>${escapeHtml(title)}</strong>
      ${metaLine}
    </div>
  </div>
  <div class="study-artifact-actions">
    ${studyBulkDeleteMarkup(itemType)}
  </div>
</div>`.trim();
}

function studyBulkDeleteMarkup(itemType) {
  const selectedCount = studySelectionSet(itemType)?.size || 0;
  if (!selectedCount) return "";
  const action = itemType === "card" ? "delete-selected-cards" : "delete-selected-quiz";
  return `<button class="mini-button danger study-bulk-delete" type="button" data-study-action="${action}" ${state.deletingStudyItems ? "disabled" : ""}>删除选中 ${selectedCount}</button>`;
}

function handleStudyItemSelectionClick(event) {
  if (!event.ctrlKey && !event.metaKey) return false;
  const item = event.target.closest("[data-study-selectable]");
  if (!item || !$("#studio-output").contains(item)) return false;
  if (event.target.closest("button, input, select, textarea, label, summary, .study-item-menu, .study-source-chip, a")) return false;
  event.preventDefault();
  event.stopPropagation();
  toggleStudyItemSelection(item.dataset.studyItemType, item.dataset.originId);
  return true;
}

function toggleStudyItemSelection(itemType, originId) {
  const selected = studySelectionSet(itemType);
  if (!originId || !selected) return;
  if (selected.has(originId)) selected.delete(originId);
  else selected.add(originId);
  updateStudyItemSelectionElement(itemType, originId);
  renderStudyBulkControls();
}

function updateStudyItemSelectionElement(itemType, originId) {
  const item = $$("[data-study-selectable]").find((element) => (
    element.dataset.studyItemType === itemType && element.dataset.originId === originId
  ));
  if (!item) return;
  const isSelected = studySelectionSet(itemType).has(originId);
  item.classList.toggle("is-bulk-selected", isSelected);
  item.setAttribute("aria-selected", isSelected ? "true" : "false");
}

function renderStudyBulkControls() {
  const actions = $(".study-artifact-actions");
  if (!actions) return;
  const itemType = state.feature === "cards" ? "card" : state.feature === "quiz" ? "quiz" : "";
  if (!itemType) return;
  actions.innerHTML = `${studyBulkDeleteMarkup(itemType)}`;
}

function studyEvidenceQuote(text) {
  const value = String(text || "");
  const match = value.match(/^来源依据[：:]\s*([^\n]+)$/m);
  if (match) return sourceQuoteSnippet(match[1]);
  const alt = value.match(/^关键解释[：:]\s*([^\n]+)$/m);
  if (alt) return sourceQuoteSnippet(alt[1]);
  return "";
}

function sourceQuoteSnippet(value) {
  const text = String(value || "").trim();
  const quoted = text.match(/[“"]([^”"]{8,180})[”"]/);
  if (quoted) return quoted[1].trim();
  return text.replace(/^《[^》]+》[^中]*中的?/, "").trim();
}

function studySourceBadgeMarkup(sourceIds, quote = "", label = "查看来源") {
  const ids = Array.isArray(sourceIds) ? sourceIds.filter(Boolean) : [];
  if (!ids.length) return "";
  const source = state.sources.find((item) => item.source_id === ids[0]);
  const filename = source?.filename || "项目来源";
  return `<button class="study-source-chip" type="button" data-study-source-id="${escapeAttr(ids[0])}" data-study-source-quote="${escapeAttr(quote)}" aria-label="${escapeAttr(`${label}：${filename}`)}" title="${escapeAttr(`${label}：${filename}`)}"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 L17 7"/><path d="M9.5 7 H17 V14.5"/></svg></button>`;
}

async function generateCards() {
  if (!state.currentProjectId) return requireProject(() => {});
  if (state.generatingCards) return; // 防重复触发
  const projectId = state.currentProjectId; // 捕获项目 id，防切换项目后的 race
  const selectable = selectableSources();
  if (!selectable.length) {
    showError(new Error("请先导入项目资料。在左侧上传 PDF、Word、PPT 或粘贴文本后，才能生成知识卡片。"));
    if (state.feature === "cards") renderEmptyOutput("暂无项目资料", "请先在左侧上传项目材料，再生成知识卡片。");
    return;
  }
  const sourceIds = selectable
    .filter((source) => state.selectedSourceIds.has(source.source_id))
    .map((source) => source.source_id);
  if (selectable.length && !sourceIds.length) {
    showError(new Error("请先在左侧至少勾选一个项目来源。"));
    if (state.feature === "cards") renderEmptyOutput("尚未选择卡片来源", "在左侧勾选来源后，再生成知识卡片。");
    return;
  }
  state.generatingCards = true;
  updateFeatureButtons();
  try {
    const options = studyGenerationOptions(sourceIds);
    const data = await api(`/api/projects/${projectId}/cards/generate`, options);
    // 后台返回时如果已切换项目，静默丢弃结果
    if (state.currentProjectId !== projectId) return;
    state.cards = [...state.cards, ...(data.cards || [])];
    $("#fallback-label").classList.toggle("hidden", !data.fallback);
  } catch (error) {
    if (state.currentProjectId !== projectId) return; // 已切换项目，静默忽略错误
    showError(error, generateCards);
    if (state.feature === "cards") renderEmptyOutput("卡片生成失败", "可重试。");
  } finally {
    state.generatingCards = false;
    updateFeatureButtons();
    if (state.currentProjectId === projectId && state.feature === "cards") renderCards();
  }
}

function renderCards() {
  hideTextHighlightToolbar();
  // 无可用来源时，即使 state.cards 有残留数据也不渲染
  if (selectableSources().length === 0) {
    clearStudySelections({ quiz: false });
    return renderEmptyOutput("暂无项目资料", "请先在左侧上传项目材料，再生成知识卡片。");
  }
  if (!state.cards.length) {
    clearStudySelections({ quiz: false });
    if (state.generatingCards) return renderEmptyOutput("知识卡片正在后台生成中", "你可以先去看知识框架、学习概览或我的笔记，完成后会自动出现在这里。");
    return renderEmptyOutput("还没有知识卡片", "选择此功能后会自动生成。");
  }
  const toolbar = studyArtifactToolbarMarkup("card", `已保存 ${state.cards.length} 张知识卡片`, "依据所选来源生成 · 重新进入项目后仍会保留");
  $("#studio-output").innerHTML = `${toolbar}<div class="cards-grid">${state.cards.map((card, i) => renderCard(card, i)).join("")}</div><div class="study-more">${studyDifficultySelector()}${regenerateButtonMarkup("regenerate-cards", state.generatingCards)}</div>`;
}

function cardSelfRateMarkup(cardId) {
  const pending = state.cardSelfRateState[cardId];
  const rateBtnDisabled = pending ? (pending.loading || pending.ok || pending.error) : false;
  const rateButtons = [0, 1, 2, 3, 4].map((r) => {
    const selected = pending && pending.selected === r;
    return `<button type="button" class="card-rate-btn${selected ? " is-selected" : ""}" data-card-rate="${r}" data-card-id="${escapeAttr(cardId)}" ${rateBtnDisabled ? "disabled" : ""} title="${["完全不会", "想错了", "模糊记得", "基本会了", "非常熟"][r]}">${["❌ 不会", "⚠️ 错误", "❓ 模糊", "✔️ 会了", "🔥 很熟"][r]}</button>`;
  }).join("");
  let noteHtml = "";
  if (pending) {
    if (pending.loading) noteHtml = `<p class="card-rate-note" data-role="rate-note" data-state="loading">⌛ 正在把自测记录到掌握度…</p>`;
    else if (pending.error) noteHtml = `<p class="card-rate-note warning" data-role="rate-note" data-state="error">⚠️ 提交失败：${escapeHtml(pending.error)}</p>`;
    else if (pending.ok) noteHtml = `<p class="card-rate-note" data-role="rate-note" data-state="done">${escapeHtml(pending.note || "✔ 自测已记录")}</p>`;
  }
  return `
    <div class="card-self-rate" role="group" aria-label="自测掌握度">
      <small>看完答案后，自测一下掌握程度（计入掌握度）：</small>
      <div class="card-self-rate-btns">${rateButtons}</div>
      ${noteHtml}
    </div>`;
}

// 只更新单张卡片的自测区域，避免整页 renderCards() 重绘导致
// 展开的 <details> 折叠、滚动位置回弹到顶部
function updateCardSelfRateInPlace(cardId) {
  if (state.feature !== "cards") return;
  const output = $("#studio-output");
  if (!output) return;
  const article = output.querySelector(`article.card[data-origin-id="${CSS.escape(cardId)}"]`);
  if (!article) return;
  const old = article.querySelector(".card-self-rate");
  if (!old) return;
  const tpl = document.createElement("template");
  tpl.innerHTML = cardSelfRateMarkup(cardId).trim();
  if (tpl.content.firstElementChild) old.replaceWith(tpl.content.firstElementChild);
}

// 回流自测卡（core/knowledge_doc.SYNC_ORIGIN_SECTION）带 origin_section + node_ids，
// 凭这两样就能定位回文档里那一节。没有 origin_section 的卡（普通生成的卡片）不显示 ——
// 别给每张卡都挂一个跳不动的按钮。
function cardOriginDocMarkup(card) {
  const section = String((card && card.origin_section) || "").trim();
  const nodeId = String(((card && card.node_ids) || [])[0] || "").trim();
  if (!section || !nodeId) return "";
  const node = (state.nodes || []).find((n) => n.node_id === nodeId);
  const nodeName = node ? node.name : "这个知识点";
  return `<button type="button" class="card-origin-doc-btn" data-card-origin-doc="${escapeAttr(nodeId)}" data-card-origin-section="${escapeAttr(section)}" title="打开「${escapeAttr(nodeName)}」的知识点文档，滚到「${escapeAttr(section)}」那一节">↗ 回到文档 · ${escapeHtml(section)}</button>`;
}

// 答案默认收起：翻到背面只看到「展开答案」，点一下才露正文。
// 卡片网格与沉浸查看器共用这段结构 + 同一个 state.cardAnswerOpenIds，
// 所以两处永远同步（setCardAnswerOpen 一次刷两个 DOM）。
function cardAnswerSectionMarkup(cardId, open, extraClass, inner) {
  return `<div class="${extraClass}" data-card-answer-root="${escapeAttr(cardId)}"><button type="button" class="card-answer-toggle" data-card-answer-toggle="${escapeAttr(cardId)}" aria-expanded="${open ? "true" : "false"}">${open ? "▾ 收起答案" : "▸ 展开答案"}</button><div class="card-answer-body"${open ? "" : " hidden"}>${inner}</div></div>`;
}

function setCardAnswerOpen(cardId, open) {
  if (!cardId) return;
  if (open) state.cardAnswerOpenIds.add(cardId);
  else state.cardAnswerOpenIds.delete(cardId);
  document.querySelectorAll(`[data-card-answer-root="${CSS.escape(cardId)}"]`).forEach((root) => {
    const body = root.querySelector(".card-answer-body");
    const btn = root.querySelector("[data-card-answer-toggle]");
    if (body) body.hidden = !open;
    if (btn) {
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      btn.textContent = open ? "▾ 收起答案" : "▸ 展开答案";
    }
  });
}

function renderCard(card, index) {
  const num = (index ?? 0) + 1;
  const flipped = state.openCardIds.has(card.card_id);
  const sourceBadge = studySourceBadgeMarkup(card.source_ids, studyEvidenceQuote(card.back), "查看来源");
  const front = `<p class="study-title-line"><strong>${renderMathContent(card.front)}</strong></p>`;
  const selected = state.selectedCardIds.has(card.card_id);
	const selfRateRow = cardSelfRateMarkup(card.card_id);
  const originDoc = cardOriginDocMarkup(card);
  const heading = `<div class="review-item-heading"><span class="card-heading-left"><span class="card-number" aria-hidden="true">${num}</span><span class="count-pill">${escapeHtml(card.category)} · 难度 ${card.difficulty}</span></span><span class="review-item-actions">${sourceBadge}${studyItemMenuMarkup("card", card.card_id, card.front, card.node_ids)}</span></div>`;
  const frontFace = `${heading}${highlightableMarkup(`card:${card.card_id}:front`, front, "card-front-text")}<div class="flip-card-cue"><span>点击卡片翻面查看答案</span><button type="button" class="flip-cue-btn" data-flip-toggle aria-label="翻面查看答案">↻ 翻面</button></div>`;
  const backTools = `<div class="flip-card-back-tools"><button type="button" class="flip-back-btn" data-flip-toggle aria-label="返回题目">↩ 返回题目</button><button type="button" class="card-viewer-open-btn" data-card-open-viewer="${escapeAttr(String(index ?? 0))}" aria-label="放大沉浸浏览">⤢ 放大沉浸</button>${originDoc}</div>`;
  const backFace = `${backTools}${cardAnswerSectionMarkup(card.card_id, state.cardAnswerOpenIds.has(card.card_id), "card-answer", `${highlightableMarkup(`card:${card.card_id}:back`, renderStudyTextContent(card.back), "card-answer-content")}${selfRateRow}`)}`;
  return `<article class="card flip-card${favoriteHighlightClass("card", card.card_id)}${selected ? " is-bulk-selected" : ""}" data-study-selectable data-study-item-type="card" data-origin-id="${escapeAttr(card.card_id)}" data-card-index="${escapeAttr(String(index ?? 0))}" aria-selected="${selected ? "true" : "false"}"><div class="flip-card-inner${flipped ? " is-flipped" : ""}"><div class="flip-card-face flip-card-front">${frontFace}</div><div class="flip-card-face flip-card-back">${backFace}</div></div></article>`;
}

function toggleCardFlip(article) {
  if (!article) return;
  const inner = article.querySelector(".flip-card-inner");
  if (!inner) return;
  const cardId = article.dataset.originId;
  const willFlip = !inner.classList.contains("is-flipped");
  inner.classList.toggle("is-flipped", willFlip);
  if (willFlip) {
    state.openCardIds.add(cardId);
    const index = Number(article.dataset.cardIndex);
    openCardViewer(Number.isFinite(index) ? index : 0);
  } else {
    state.openCardIds.delete(cardId);
    setCardAnswerOpen(cardId, false); // 翻回题面就把答案收回，下次翻面还是从「展开答案」开始
  }
}

function ensureCardViewer() {
  let viewer = $("#card-viewer");
  if (viewer) return viewer;
  viewer = document.createElement("div");
  viewer.id = "card-viewer";
  viewer.className = "card-viewer";
  viewer.setAttribute("role", "dialog");
  viewer.setAttribute("aria-modal", "true");
  viewer.setAttribute("aria-label", "知识卡片沉浸浏览");
  viewer.innerHTML = `
    <div class="card-viewer-backdrop" data-card-viewer-backdrop></div>
    <div class="card-viewer-panel" role="document">
      <div class="card-viewer-topbar">
        <div class="card-viewer-heading">
          <span class="card-viewer-count" data-card-viewer-count></span>
          <span class="card-viewer-hint">Esc 关闭 · ← → 上一张 / 下一张</span>
        </div>
        <div class="card-viewer-nav">
          <button type="button" class="card-viewer-nav-btn" data-card-viewer-prev aria-label="上一张">‹</button>
          <button type="button" class="card-viewer-nav-btn" data-card-viewer-next aria-label="下一张">›</button>
          <button type="button" class="card-viewer-close" data-card-viewer-close aria-label="关闭">✕</button>
        </div>
      </div>
      <div class="card-viewer-body" data-card-viewer-body></div>
    </div>`;
  document.body.append(viewer);
  return viewer;
}

function openCardViewer(index) {
  const n = state.cards.length;
  if (!n) return;
  const idx = Number.isFinite(index) ? index : 0;
  state.cardViewerIndex = Math.max(0, Math.min(n - 1, idx));
  state.cardViewerOpen = true;
  const viewer = ensureCardViewer();
  document.body.classList.add("card-viewer-open");
  renderCardViewer();
  // 先提交隐藏态布局，再切入打开态，才能让 opacity/transform 过渡动画正常触发
  void viewer.offsetWidth;
  viewer.classList.add("is-open");
  viewer.querySelector(".card-viewer-close")?.focus({ preventScroll: true });
}

function closeCardViewer() {
  if (!state.cardViewerOpen) return;
  state.cardViewerOpen = false;
  state.cardViewerIndex = -1;
  document.body.classList.remove("card-viewer-open");
  $("#card-viewer")?.classList.remove("is-open");
}

function renderCardViewer() {
  const viewer = $("#card-viewer");
  if (!viewer) return;
  const n = state.cards.length;
  const idx = state.cardViewerIndex;
  const card = state.cards[idx];
  const countEl = viewer.querySelector("[data-card-viewer-count]");
  const prevBtn = viewer.querySelector("[data-card-viewer-prev]");
  const nextBtn = viewer.querySelector("[data-card-viewer-next]");
  if (prevBtn) prevBtn.disabled = n <= 1;
  if (nextBtn) nextBtn.disabled = n <= 1;
  if (!card) {
    if (countEl) countEl.textContent = "";
    return;
  }
  if (countEl) countEl.textContent = `${idx + 1} / ${n}`;
  const sourceBadge = studySourceBadgeMarkup(card.source_ids, studyEvidenceQuote(card.back), "查看来源");
  const front = `<p class="study-title-line"><strong>${renderMathContent(card.front)}</strong></p>`;
  const selfRateRow = cardSelfRateMarkup(card.card_id);
  const body = viewer.querySelector("[data-card-viewer-body]");
  if (body) {
    body.innerHTML = `
      <div class="card-viewer-meta"><span class="count-pill">${escapeHtml(card.category)} · 难度 ${card.difficulty}</span>${sourceBadge ? `<span class="card-viewer-meta-actions">${sourceBadge}</span>` : ""}</div>
      <section class="card-viewer-section card-viewer-question">
        <h3 class="card-viewer-section-title">题目</h3>
        ${highlightableMarkup(`card:${card.card_id}:front`, front, "card-front-text")}
      </section>
      <section class="card-viewer-section card-viewer-answer">
        <h3 class="card-viewer-section-title">答案</h3>
        ${cardAnswerSectionMarkup(card.card_id, state.cardAnswerOpenIds.has(card.card_id), "card-answer", `${highlightableMarkup(`card:${card.card_id}:back`, renderStudyTextContent(card.back), "card-answer-content")}${selfRateRow}`)}
      </section>`;
    body.scrollTop = 0;
  }
}

function navigateCardViewer(delta) {
  const n = state.cards.length;
  if (n <= 1) return;
  state.cardViewerIndex = (state.cardViewerIndex + delta + n) % n;
  renderCardViewer();
}

function handleCardViewerKeydown(event) {
  if (!state.cardViewerOpen) return;
  const openDialog = [...document.querySelectorAll("dialog")].find((d) => d.open);
  if (openDialog) return; // 有普通 dialog 打开时，按键交给它处理，避免误关/误翻
  if (event.key === "Escape") {
    event.preventDefault();
    closeCardViewer();
    return;
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    navigateCardViewer(event.key === "ArrowLeft" ? -1 : 1);
  }
}

function handleCardViewerDocumentClick(event) {
  if (!state.cardViewerOpen) return;
  if (event.target.closest("[data-card-viewer-close]")) {
    event.preventDefault();
    closeCardViewer();
    return;
  }
  if (event.target.closest("[data-card-viewer-backdrop]")) {
    event.preventDefault();
    closeCardViewer();
    return;
  }
  if (event.target.closest("[data-card-viewer-prev]")) {
    event.preventDefault();
    navigateCardViewer(-1);
    return;
  }
  if (event.target.closest("[data-card-viewer-next]")) {
    event.preventDefault();
    navigateCardViewer(1);
    return;
  }
  // 沉浸查看器里的答案同样默认收起（与网格卡片同一个 state，点一处两处同步）
  const viewerAnswerToggle = event.target.closest("[data-card-answer-toggle]");
  if (viewerAnswerToggle) {
    event.preventDefault();
    event.stopPropagation();
    const aid = viewerAnswerToggle.dataset.cardAnswerToggle;
    setCardAnswerOpen(aid, !state.cardAnswerOpenIds.has(aid));
    return;
  }
  const rateBtn = event.target.closest("[data-card-rate]");  if (rateBtn) {
    event.preventDefault();
    event.stopPropagation();
    const cardId = rateBtn.dataset.cardId;
    submitCardSelfRating(rateBtn).then(() => {
      if (state.cardViewerOpen && state.cards[state.cardViewerIndex]?.card_id === cardId) renderCardViewer();
    });
    return;
  }
  const srcBtn = event.target.closest("[data-study-source-id]");
  if (srcBtn) {
    event.preventDefault();
    event.stopPropagation();
    openSourcePreview(srcBtn.dataset.studySourceId, srcBtn.dataset.studySourceQuote || "");
    return;
  }
  // 自测卡「回到文档」：关掉卡片大图/翻面态，让阅读页滚到出自的那一节。
  const originDocBtn = event.target.closest("[data-card-origin-doc]");
  if (originDocBtn) {
    event.preventDefault();
    event.stopPropagation();
    const kd = (typeof window !== "undefined" && window.KnowOriginKnowledgeDoc) || null;
    if (!kd || typeof kd.openNodeAtSection !== "function") {
      if (typeof showToast === "function") showToast("知识点文档模块没加载出来，暂时跳不过去。", { variant: "error" });
      return;
    }
    const nodeId = originDocBtn.dataset.cardOriginDoc;
    const node = (state.nodes || []).find((n) => n.node_id === nodeId);
    // 大图还开着的话它会盖在阅读页上，先收掉。
    closeCardViewer();
    kd.openNodeAtSection(nodeId, node ? node.name : "", originDocBtn.dataset.cardOriginSection || "");
  }
}

async function submitCardSelfRating(btn) {
  const cardId = btn.dataset.cardId;
  const recall = Number(btn.dataset.cardRate);
  if (!cardId || !state.currentProjectId || Number.isNaN(recall)) return;
  if (state.cardSelfRateState[cardId]?.loading) return; // 防重复提交

  // 即时写入全局 state —— 界面重渲染也不丢
  state.cardSelfRateState[cardId] = { loading: true, selected: recall, note: null, ok: false, error: null };
  updateCardSelfRateInPlace(cardId); // 原地更新，避免整页重绘导致回弹

  // 先保存点击前节点分，用于给用户显示「XX 节点 +X%」的透明化反馈
  const beforeMastery = {};
  (state.nodes || []).forEach((n) => { beforeMastery[n.node_id] = Number(n.mastery_score || 0); });
  _setMasteryBaseline(); // 桌宠掌握度实时播报：记录自评前基线

  try {
    const resp = await api(
      `/api/projects/${encodeURIComponent(state.currentProjectId)}/cards/${encodeURIComponent(cardId)}/self-rate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recall }),
      },
    );
    // 更新节点 state
    (resp.updated_nodes || []).forEach((n) => {
      const idx = state.nodes.findIndex((x) => x.node_id === n.node_id);
      if (idx >= 0) state.nodes[idx] = n;
    });
    // 刷新掌握度明细；如果当前在学习概览，也要重绘
    await refreshMasteryBreakdown({ reRender: false });
    if (state.feature === "framework") renderFramework();
    else if (state.feature === "overview") renderOverview();

    // 精确文案：受影响几个节点、每个节点掌握度实际涨多少
    const perNode = (resp.updated_nodes || []).map((n) => {
      const before = Number(beforeMastery[n.node_id] ?? 0);
      const gain = (n.mastery_score || 0) - before;
      const name = n.name ? `「${n.name}」` : "某节点";
      const pctNow = Math.round((n.mastery_score || 0) * 100);
      const gainStr = gain >= 0 ? `+${Math.round(gain * 1000) / 10}%` : `${Math.round(gain * 1000) / 10}%`;
      return `${name} ${pctNow}% (${gainStr})`;
    }).join("；");

    const tips = {
      0: "已记录为「完全不会」，后续会优先复习这张卡片。",
      1: "已记录为「想错了」，本次贡献会较低以反映错误。",
      2: "已记录为「模糊」，继续复习即可稳步上涨。",
      3: "已记录为「会了」，掌握度已加分。",
      4: "已记录为「非常熟」，掌握度大幅加分。",
    };
    const baseTip = (resp.affected_count ?? resp.updated_nodes?.length ?? 0) > 0
      ? (perNode || `共影响 ${resp.affected_count} 个节点`)
      : (resp.node_ids && resp.node_ids.length
          ? `本次置信度过低（挂到 ${resp.node_ids.length} 个节点较分散），已进入「待确认」不加分。`
          : "卡片未关联任何节点，本次未改变掌握度。");
    const note = `✔ ${tips[recall] || "自测已记录"}（本次正确率 ${Math.round((resp.correctness || 0) * 100)}% · 置信度 ${Math.round((resp.confidence || 0) * 100)}% · ${baseTip}）`;
    state.cardSelfRateState[cardId] = { loading: false, selected: recall, note, ok: true, error: null };
    updateCardSelfRateInPlace(cardId); // 原地更新，避免整页重绘导致回弹

    // 桌宠真诚反馈：按自评档位给出鼓励/安抚（0不会 1错误 2模糊 3会了 4很熟）
    const rateFeedback = [
      ["完全不会没关系，正好找到了该补的地方——我陪你把它讲明白，先回来源看一遍再回来，一定豁然开朗。", "think"],
      ["想错了也是大收获：现在我知道你的盲区在哪了，我们一起把它掰正。错题最养人，别着急。", "think"],
      ["能想起来一点，说明根子已经扎下，再浇两遍水就开花——翻回答案再确认一遍，会更扎实。", "love"],
      ["记住了，真棒！掌握度已经加上去，继续保持这个节奏，稳扎稳打。", "happy"],
      ["这么熟！给你点个大赞，这种状态太给力了，可以多来几张巩固手感。", "cheer"],
    ][recall];
    if (rateFeedback) {
      // 掌握度实时播报 + 动态生成鼓励：把具体涨幅喂给 tju-llm，失败回退预设
      const gainTxt = _masteryGainText();
      const rateLabel = ["完全不会", "想错了", "模糊", "会了", "很熟"][recall] || "";
      const fallback = gainTxt ? `${rateFeedback[0]}——${gainTxt}` : rateFeedback[0];
      petReactAI("rate", { rate: rateLabel, gains: gainTxt || [] }, rateFeedback[1], fallback, { ic: ["🩹", "🧭", "🌱", "🌷", "🤗"][recall] || "🌷" });
    }
  } catch (e) {
    const errMsg = (e && (e.message || e.detail)) ? (e.message || e.detail) : "请重试";
    state.cardSelfRateState[cardId] = { loading: false, selected: recall, note: null, ok: false, error: errMsg };
    updateCardSelfRateInPlace(cardId); // 原地更新，避免整页重绘导致回弹
    showError(e);
  }
}

async function generateQuiz() {
  if (!state.currentProjectId) return requireProject(() => {});
  if (state.generatingQuiz) return; // 防重复触发
  const projectId = state.currentProjectId; // 捕获项目 id，防切换项目后的 race
  const selectable = selectableSources();
  if (!selectable.length) {
    showError(new Error("请先导入项目资料。在左侧上传 PDF、Word、PPT 或粘贴文本后，才能生成小测验。"));
    if (state.feature === "quiz") renderEmptyOutput("暂无项目资料", "请先在左侧上传项目材料，再生成小测验。");
    return;
  }
  const sourceIds = selectable
    .filter((source) => state.selectedSourceIds.has(source.source_id))
    .map((source) => source.source_id);
  if (selectable.length && !sourceIds.length) {
    showError(new Error("请先在左侧至少勾选一个项目来源。"));
    if (state.feature === "quiz") renderEmptyOutput("尚未选择测验来源", "在左侧勾选来源后，再生成小测验。");
    return;
  }
  state.generatingQuiz = true;
  updateFeatureButtons();
  try {
    const options = studyGenerationOptions(sourceIds);
    const quiz = await api(`/api/projects/${projectId}/quiz/generate`, options);
    // 后台返回时如果已切换项目，静默丢弃结果
    if (state.currentProjectId !== projectId) return;
    state.quiz = quiz;
    state.quizDraftAnswers = {}; // 新一套测验，旧草稿作废
    state.quizHistory = null; // 新测验生成后历史失效，下次渲染时重新加载
    state.viewingHistoryQuiz = null;
    $("#fallback-label").classList.toggle("hidden", !state.quiz.fallback);
  } catch (error) {
    if (state.currentProjectId !== projectId) return; // 已切换项目，静默忽略错误
    showError(error, generateQuiz);
    if (state.feature === "quiz") renderEmptyOutput("测验生成失败", "可重试。");
  } finally {
    state.generatingQuiz = false;
    updateFeatureButtons();
    if (state.currentProjectId === projectId && state.feature === "quiz") renderQuiz();
  }
}

function renderQuiz() {
  hideTextHighlightToolbar();
  // 无可用来源时，即使 state.quiz 有残留数据也不渲染
  if (selectableSources().length === 0) {
    clearStudySelections({ cards: false });
    return renderEmptyOutput("暂无项目资料", "请先在左侧上传项目材料，再生成小测验。");
  }
  // 如果正在查看历史测验，渲染历史视图
  if (state.viewingHistoryQuiz) return renderHistoricQuizView();
  if (!state.quiz) {
    clearStudySelections({ cards: false });
    if (state.generatingQuiz) return renderEmptyOutput("小测验正在后台生成中", "你可以先去看知识框架、学习概览或我的笔记，完成后会自动出现在这里。");
    return renderEmptyOutput("还没有小测验", "选择此功能后会自动生成。");
  }
  if (!(state.quiz.questions || []).length) return renderEmptyOutput("还没有可用小测验", "先上传来源并构建知识框架。");
  const sourceIds = state.quiz.source_ids || [...new Set((state.quiz.questions || []).flatMap((question) => question.source_ids || []))];
  const sourceLabel = sourceIds.length ? `依据 ${sourceIds.length} 个已选来源` : "依据当前知识框架";
  const toolbar = studyArtifactToolbarMarkup("quiz", "小测验已保存", sourceLabel, { badge: "小测验", sub: "重新进入项目后仍会保留" });
  // 从节点面板「去「小测验」作答」跳转而来时，顶部提供「返回」按钮回到原节点
  const backMarkup = state.kbQuizReturn
    ? `<div class="quiz-return-row"><button class="secondary-button" type="button" data-study-action="return-from-quiz">← 返回</button></div>`
    : "";
  // 懒加载历史记录：切到 quiz tab 时自动拉取
  if (state.quizHistory === null) loadQuizHistory();
  const historySection = renderQuizHistorySection();
  $("#studio-output").innerHTML = `${backMarkup}${toolbar}${quizQuadrantSummaryMarkup(state.quiz.results)}<form id="quiz-form">${(state.quiz.questions || []).map((question, index) => renderQuestion(question, index, state.quiz.results?.[index])).join("")}<div class="quiz-submit-row"><button class="primary-button" type="submit"${state.quiz.results ? " disabled" : ""}>${state.quiz.results ? "已提交" : "提交并更新掌握度"}</button></div></form><div class="quiz-footer"><div class="study-more">${studyDifficultySelector()}${quizQuestionTypeSelector()}${regenerateButtonMarkup("regenerate-quiz", state.generatingQuiz)}</div>${historySection}</div>`;
  $("#quiz-form").addEventListener("submit", submitQuiz);
  // 作答草稿：每次输入/勾选都记录到 state，切 tab 重渲染后由 renderQuestion 恢复
  $("#quiz-form").addEventListener("input", captureQuizDraft);
  $("#quiz-form").addEventListener("change", captureQuizDraft);
}

function captureQuizDraft(event) {
  const field = event.target;
  if (!field || !field.name) return;
  // 「先押一个」自评：键按 quiz_id 存，免得换一套测验后旧勾选被当成新答案（那就是造假数据）
  if (/^sc\d+$/.test(field.name)) {
    if (!state.quiz || state.quiz.results) return;
    if (!state.quizSelfConfidence) state.quizSelfConfidence = {};
    state.quizSelfConfidence[`${state.quiz.quiz_id}:${Number(field.name.slice(2))}`] = field.value === "1" ? 1 : 0;
    return;
  }
  if (!/^q\d+$/.test(field.name)) return;
  if (!state.quiz || state.quiz.results) return; // 已提交的测验不再记录草稿
  const index = Number(field.name.slice(1));
  if (!state.quiz.questions?.[index]) return;
  const form = field.form;
  if (!form) return;
  if (field.type === "checkbox") {
    const checked = [...form.querySelectorAll(`input[name="${field.name}"]:checked`)].map((el) => el.value);
    if (checked.length) state.quizDraftAnswers[index] = checked;
    else delete state.quizDraftAnswers[index];
  } else if (field.type === "radio") {
    state.quizDraftAnswers[index] = field.value; // radio 只在被选中时触发
  } else {
    if (field.value.trim()) state.quizDraftAnswers[index] = field.value;
    else delete state.quizDraftAnswers[index];
  }
}

function renderQuizOptionText(option) {
  const match = String(option).match(/^([A-Fa-f][.．。、])\s*/);
  if (!match) return renderMathContent(option);
  return `${escapeHtml(match[0])}${renderMathContent(option.slice(match[0].length))}`;
}

function renderQuestion(question, index, result = null) {
  // 未提交时恢复用户的作答草稿（切 tab 再回来不丢失）
  const draft = result ? null : state.quizDraftAnswers[index];
  let input = "";
  if (question.type === "choice" || question.type === "single_choice") {
    input = question.options.map((option) => {
      const checked = result
        ? (isSubmittedChoice(question, option, result?.submitted_answer) ? " checked" : "")
        : (draft === option ? " checked" : "");
      return `<label${result ? ` class="${quizOptionStateClasses(question, option, result).trim()}"` : ""}><input type="radio" name="q${index}" value="${escapeAttr(option)}"${result ? " disabled" : " required"}${checked}>${result ? quizOptionMark(question, option, result) : ""} <span class="quiz-option-text">${renderQuizOptionText(option)}</span></label>`;
    }).join("");
  } else if (question.type === "multiple_choice" || question.type === "indefinite_choice") {
    const submittedLetters = new Set((result?.submitted_answer || "").toUpperCase().match(/[A-F]/g) || []);
    input = question.options.map((option) => {
      const letter = option.trim().charAt(0).toUpperCase();
      const checked = result
        ? (submittedLetters.has(letter) ? " checked" : "")
        : (Array.isArray(draft) && draft.includes(option) ? " checked" : "");
      return `<label${result ? ` class="${quizOptionStateClasses(question, option, result).trim()}"` : ""}><input type="checkbox" name="q${index}" value="${escapeAttr(option)}"${result ? " disabled" : ""}${checked}>${result ? quizOptionMark(question, option, result) : ""} <span class="quiz-option-text">${renderQuizOptionText(option)}</span></label>`;
    }).join("");
  } else if (question.type === "fill_blank" || question.type === "fill") {
    input = `<input type="text" name="q${index}" value="${escapeAttr(result?.submitted_answer || (typeof draft === "string" ? draft : ""))}"${result ? " disabled" : " required"} placeholder="填入空位答案">`;
  } else if (question.type === "calculation") {
    input = `<textarea name="q${index}" rows="2"${result ? " disabled" : " required"} placeholder="写出数值+单位">${escapeHtml(result?.submitted_answer || (typeof draft === "string" ? draft : ""))}</textarea>`;
  } else if (question.type === "short_answer") {
    input = `<textarea name="q${index}" rows="3"${result ? " disabled" : " required"}>${escapeHtml(result?.submitted_answer || (typeof draft === "string" ? draft : ""))}</textarea>`;
  } else {
    input = `<input type="text" name="q${index}" value="${escapeAttr(result?.submitted_answer || (typeof draft === "string" ? draft : ""))}"${result ? " disabled" : " required"}>`;
  }
  const originId = `${state.quiz.quiz_id}:${index}`;
  const sourceBadge = studySourceBadgeMarkup(question.source_ids, studyEvidenceQuote(question.explanation), "查看来源");
  const prompt = `<p class="study-title-line"><strong>${index + 1}. ${renderMathContent(question.question)}</strong></p>`;
  const selected = state.selectedQuizQuestionIds.has(originId);
  const feedback = result ? renderQuizFeedback(question, result, index) : `<div id="result-${index}"></div>`;
  const errRow = result
    ? quizErrorTypeMarkup(index, state.quiz.quiz_id, result.correct === false, result.error_type)
    : "";
  const typeLabel = {"choice":"单选","single_choice":"单选","multiple_choice":"多选","indefinite_choice":"不定项","fill":"填空","fill_blank":"填空","short_answer":"简答","calculation":"计算"}[question.type] || question.type || "题";
  // 填空题/简答/计算题：题干在左、答案在右，横向铺开、垂直更紧凑，提升阅读效率
  const inlineAnswer = ["fill", "fill_blank", "short_answer", "calculation"].includes(question.type);
  const promptBlock = highlightableMarkup(`quiz:${originId}:question`, prompt, "quiz-question-text");
  const selfcRow = result ? "" : quizSelfConfidenceMarkup(index, state.quizSelfConfidence?.[`${state.quiz.quiz_id}:${index}`]);
  const body = inlineAnswer
    ? `<div class="quiz-answer-inline">${promptBlock}${input}</div>${selfcRow}${feedback}${errRow}`
    : `${promptBlock}${input}${selfcRow}${feedback}${errRow}`;
  return `<article class="quiz-question${inlineAnswer ? " quiz-question--inline" : ""}${favoriteHighlightClass("quiz", originId)}${selected ? " is-bulk-selected" : ""}" data-study-selectable data-study-item-type="quiz" data-origin-id="${escapeAttr(originId)}" aria-selected="${selected ? "true" : "false"}"><div class="review-item-heading"><span class="count-pill">第 ${index + 1} 题 · ${typeLabel} · 难度 ${question.difficulty}</span><span class="review-item-actions">${sourceBadge}${studyItemMenuMarkup("quiz", originId, question.question, question.node_ids)}</span></div>${body}</article>`;
}

function studyItemMenuMarkup(itemType, originId, title, nodeIds) {
  const favorite = findFavorite(itemType, originId);
  const names = [...new Set((nodeIds || []).map((id) => {
    const n = state.nodes.find((x) => x.node_id === id);
    return n ? n.name : "";
  }).filter(Boolean))];
  const nodeInfo = names.length ? `<button class="study-item-menu-node" type="button" data-study-node-jump data-node-id="${escapeAttr(nodeIds[0])}" title="跳转到知识图谱对应位置">节点 · ${names.map(escapeHtml).join("、")}</button>` : "";
  return `<details class="study-item-menu"><summary aria-label="更多操作" title="更多操作"><span aria-hidden="true">⋮</span></summary><div class="study-item-menu-popover" role="menu">${nodeInfo}<button type="button" role="menuitem" data-study-item-action="favorite" data-item-type="${escapeAttr(itemType)}" data-origin-id="${escapeAttr(originId)}" data-empty-label="收藏">${favorite ? "取消收藏" : "收藏"}</button><button type="button" role="menuitem" data-study-item-action="rename" data-item-type="${escapeAttr(itemType)}" data-origin-id="${escapeAttr(originId)}" data-title="${escapeAttr(title)}">重命名</button><button class="danger" type="button" role="menuitem" data-study-item-action="delete" data-item-type="${escapeAttr(itemType)}" data-origin-id="${escapeAttr(originId)}" data-title="${escapeAttr(title)}">删除</button></div></details>`;
}

function jumpToKbNode(nodeId) {
  if (!nodeId || !state.nodes.some((n) => n.node_id === nodeId)) return;
  kbSetView("tree");
  switchFeature("framework");
  requestAnimationFrame(() => {
    const svg = document.querySelector(".knowledge-graph");
    const out = document.querySelector("#studio-output");
    if (!svg || !out) return;
    if (typeof svg._panToNodeId === "function") svg._panToNodeId(nodeId);
    out.querySelectorAll(".graph-node").forEach((el) => {
      const on = el.dataset.nodeId === nodeId;
      el.classList.toggle("graph-node-selected", on);
      if (on) el.setAttribute("aria-pressed", "true");
      else el.removeAttribute("aria-pressed");
    });
    out.querySelectorAll(".framework-tree-label").forEach((el) => {
      el.classList.toggle("is-active", el.dataset.nodeId === nodeId);
    });
  });
}

function closeStudyMenusFromOutside(event) {
  $$(".study-item-menu[open]").forEach((menu) => {
    if (!menu.contains(event.target)) menu.removeAttribute("open");
  });
}

// —— 三点菜单下拉被滚动容器裁剪的修复 ——
// 当 ⋮ 菜单展开时，若它会被某个 overflow 容器（典型：整理助手 dock 的 .kb-pane）裁掉，
// 就把下拉摘出用 position:fixed 定位到视口；关闭时还原为原来的 absolute 定位。
function studyMenuClipHost(menu) {
  let node = menu.parentElement;
  while (node && node !== document.documentElement) {
    const cs = getComputedStyle(node);
    // 有 transform/perspective/filter 祖先时，fixed 会相对它（而非视口）定位、坐标会错，
    // 直接放弃 fixed 定位（例如翻面卡片 .card.flip-card 的 perspective 3D 上下文）
    if (cs.transform !== "none" || cs.perspective !== "none" || cs.filter !== "none") return null;
    if (cs.overflowY !== "visible" || cs.overflowX !== "visible") return node;
    node = node.parentElement;
  }
  return null;
}

function positionStudyMenuPopover(menu) {
  const popover = menu.querySelector(":scope > .study-item-menu-popover");
  const summary = menu.querySelector(":scope > summary");
  if (!popover || !summary) return;
  const host = studyMenuClipHost(menu);
  if (!host) { resetStudyMenuPopover(menu); return; }
  const hostRect = host.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  // 只有确实被裁剪容器裁掉（上或下越界）时才切 fixed；否则维持原 absolute 行为
  const clipped = popRect.bottom > hostRect.bottom + 0.5 || popRect.top < hostRect.top - 0.5;
  if (!clipped) return;
  const sr = summary.getBoundingClientRect();
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = document.documentElement.clientHeight || window.innerHeight;
  popover.style.position = "fixed";
  popover.style.left = "auto";
  popover.style.bottom = "auto";
  popover.style.right = `${Math.max(0, Math.round(vw - sr.right))}px`;
  popover.style.top = `${Math.round(sr.bottom + 5)}px`;
  const h = popover.offsetHeight;
  if (sr.bottom + 5 + h > vh && sr.top - 5 - h > 0) {
    popover.style.top = `${Math.round(sr.top - 5 - h)}px`;
  }
  popover.dataset.fixed = "1";
}

function resetStudyMenuPopover(menu) {
  const popover = menu.querySelector(":scope > .study-item-menu-popover");
  if (!popover) return;
  popover.style.position = "";
  popover.style.left = "";
  popover.style.right = "";
  popover.style.bottom = "";
  popover.style.top = "";
  delete popover.dataset.fixed;
}

function handleStudyMenuToggle(event) {
  const menu = event.target;
  if (!(menu instanceof Element) || !menu.classList.contains("study-item-menu")) return;
  if (menu.open) positionStudyMenuPopover(menu);
  else resetStudyMenuPopover(menu);
}

let studyMenuRepositionRaf = 0;
function scheduleStudyMenuReposition() {
  if (studyMenuRepositionRaf) return;
  studyMenuRepositionRaf = requestAnimationFrame(() => {
    studyMenuRepositionRaf = 0;
    $$(".study-item-menu[open]").forEach(positionStudyMenuPopover);
  });
}

function openStudyItemRename(button) {
  state.studyRenameTarget = {
    itemType: button.dataset.itemType,
    originId: button.dataset.originId,
  };
  $("#study-rename-input").value = button.dataset.title || "";
  $("#study-rename-kind").textContent = button.dataset.itemType === "card" ? "知识卡片" : "小测验题目";
  $("#study-rename-dialog").showModal();
  $("#study-rename-input").focus();
  $("#study-rename-input").select();
}

function resetStudyItemRename() {
  state.studyRenameTarget = null;
  $("#study-rename-input").value = "";
}

async function saveStudyItemRename(event) {
  event.preventDefault();
  const target = state.studyRenameTarget;
  const title = $("#study-rename-input").value.trim();
  if (!target || !title) return;
  const button = $("#confirm-study-rename");
  button.disabled = true;
  try {
    if (target.itemType === "card") {
      const updated = await api(`/api/projects/${state.currentProjectId}/cards/${encodeURIComponent(target.originId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      state.cards = state.cards.map((card) => card.card_id === target.originId ? updated : card);
      state.kbNodeCards = state.kbNodeCards.map((card) => card.card_id === target.originId ? updated : card);
    } else {
      const [quizId, rawIndex] = splitQuizOrigin(target.originId);
      const updated = await api(`/api/projects/${state.currentProjectId}/quiz/${encodeURIComponent(quizId)}/questions/${rawIndex}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      state.quiz.questions[Number(rawIndex)] = updated;
      if (state.kbNodeQuiz?.quiz_id === quizId) state.kbNodeQuiz.questions[Number(rawIndex)] = updated;
    }
    state.favorites = state.favorites.map((favorite) => (
      favorite.item_type === target.itemType && favorite.origin_id === target.originId
        ? { ...favorite, title, content: title }
        : favorite
    ));
    $("#study-rename-dialog").close();
    kbReconcileStudyView();
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
  }
}

async function deleteStudyItem(button) {
  const itemType = button.dataset.itemType;
  const originId = button.dataset.originId;
  const label = itemType === "card" ? "这张知识卡片" : "这道小测验题";
  if (!window.confirm(`确认删除${label}？`)) return;
  try {
    if (itemType === "card") {
      await api(`/api/projects/${state.currentProjectId}/cards/${encodeURIComponent(originId)}`, { method: "DELETE" });
      removeDeletedCards([originId]);
    } else {
      const [quizId, rawIndex] = splitQuizOrigin(originId);
      const deletedIndex = Number(rawIndex);
      await api(`/api/projects/${state.currentProjectId}/quiz/${encodeURIComponent(quizId)}/questions/${deletedIndex}`, { method: "DELETE" });
      removeDeletedQuizQuestions(quizId, [deletedIndex]);
    }
    updateFavoriteCount();
    kbReconcileStudyView();
  } catch (error) {
    showError(error);
  }
}

async function deleteSelectedStudyItems(itemType) {
  if (state.deletingStudyItems) return;
  const selection = studySelectionSet(itemType);
  if (!selection) return;
  const selected = [...selection];
  if (!selected.length) return;
  const label = itemType === "card" ? `${selected.length} 张知识卡片` : `${selected.length} 道小测验题`;
  if (!window.confirm(`确认删除选中的 ${label}？`)) return;

  state.deletingStudyItems = true;
  renderStudyBulkControls();
  try {
    const result = itemType === "card"
      ? await deleteSelectedCards(selected)
      : await deleteSelectedQuizQuestions(selected);
    updateFavoriteCount();
    if (result.failedCount) {
      const itemLabel = studyItemLabel(itemType);
      showError(new Error(`${result.failedCount} 个${itemLabel}删除失败：${result.firstFailure?.message || "请重试"}`), () => deleteSelectedStudyItems(itemType));
    } else {
      showNotice(`已删除 ${result.deletedCount} 个${studyItemLabel(itemType)}。`);
    }
  } catch (error) {
    showError(error, () => deleteSelectedStudyItems(itemType));
  } finally {
    state.deletingStudyItems = false;
    renderStudio();
  }
}

async function deleteSelectedCards(cardIds) {
  const results = await Promise.allSettled(cardIds.map((cardId) => (
    api(`/api/projects/${state.currentProjectId}/cards/${encodeURIComponent(cardId)}`, { method: "DELETE" })
  )));
  const deletedIds = cardIds.filter((_, index) => results[index].status === "fulfilled");
  removeDeletedCards(deletedIds);
  return {
    deletedCount: deletedIds.length,
    failedCount: cardIds.length - deletedIds.length,
    firstFailure: results.find((result) => result.status === "rejected")?.reason,
  };
}

async function deleteSelectedQuizQuestions(originIds) {
  const quizId = state.quiz?.quiz_id;
  const indexedQuestions = originIds
    .map((originId) => {
      const [originQuizId, rawIndex] = splitQuizOrigin(originId);
      return { originQuizId, index: Number(rawIndex) };
    })
    .filter((item) => item.originQuizId === quizId && Number.isInteger(item.index))
    .sort((a, b) => b.index - a.index);
  const failures = [];
  const deletedIndexes = [];

  for (const item of indexedQuestions) {
    try {
      await api(`/api/projects/${state.currentProjectId}/quiz/${encodeURIComponent(quizId)}/questions/${item.index}`, { method: "DELETE" });
      deletedIndexes.push(item.index);
    } catch (error) {
      failures.push(error);
    }
  }

  removeDeletedQuizQuestions(quizId, deletedIndexes);
  return {
    deletedCount: deletedIndexes.length,
    failedCount: originIds.length - deletedIndexes.length,
    firstFailure: failures[0],
  };
}

function removeDeletedCards(cardIds) {
  const deletedIds = new Set(cardIds);
  if (!deletedIds.size) return;
  state.cards = state.cards.filter((card) => !deletedIds.has(card.card_id));
  state.kbNodeCards = state.kbNodeCards.filter((card) => !deletedIds.has(card.card_id));
  state.favorites = state.favorites.filter((favorite) => !(favorite.item_type === "card" && deletedIds.has(favorite.origin_id)));
  deletedIds.forEach((cardId) => state.selectedCardIds.delete(cardId));
}

function removeDeletedQuizQuestions(quizId, deletedIndexes) {
  const deleted = [...new Set(deletedIndexes)].filter(Number.isInteger).sort((a, b) => a - b);
  if (!quizId || !deleted.length) return;
  const deletedSet = new Set(deleted);
  if (state.quiz?.quiz_id === quizId) {
    state.quiz.questions = (state.quiz.questions || []).filter((_, index) => !deletedSet.has(index));
  }
  if (state.kbNodeQuiz?.quiz_id === quizId) {
    state.kbNodeQuiz.questions = (state.kbNodeQuiz.questions || []).filter((_, index) => !deletedSet.has(index));
  }
  state.favorites = reindexQuizItemCollection(state.favorites, quizId, deleted);
  state.selectedQuizQuestionIds = new Set(reindexQuizItemCollection([...state.selectedQuizQuestionIds], quizId, deleted));
}

function reindexQuizItemCollection(items, quizId, deletedIndexes) {
  return items.flatMap((item) => {
    const originId = typeof item === "string" ? item : item.origin_id;
    if (typeof item !== "string" && item.item_type !== "quiz") return [item];
    const [itemQuizId, rawIndex] = splitQuizOrigin(originId);
    if (itemQuizId !== quizId) return [item];
    const index = Number(rawIndex);
    if (!Number.isInteger(index)) return [item];
    if (deletedIndexes.includes(index)) return [];
    const shift = deletedIndexes.filter((deletedIndex) => deletedIndex < index).length;
    if (!shift) return [item];
    const nextOriginId = `${quizId}:${index - shift}`;
    return [typeof item === "string" ? nextOriginId : { ...item, origin_id: nextOriginId }];
  });
}

function splitQuizOrigin(originId) {
  const separator = originId.lastIndexOf(":");
  return [originId.slice(0, separator), originId.slice(separator + 1)];
}

async function submitQuiz(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const answers = state.quiz.questions.map((question, index) => {
    if (question.type === "multiple_choice" || question.type === "indefinite_choice") {
      // 多选/不定项：FormData.getAll 收集所有勾选的选项，提取字母拼接
      const selected = form.getAll(`q${index}`) || [];
      const letters = selected.map((opt) => opt.trim().charAt(0).toUpperCase()).filter((c) => /[A-F]/.test(c));
      return letters.sort().join("");
    }
    return form.get(`q${index}`) || "";
  });
  try {
    _setMasteryBaseline(); // 桌宠掌握度实时播报：记录交卷前基线
    // 自评从 FormData 直接读（权威来源）；没勾 → null，后端据此不参与判据
    const selfConfidences = state.quiz.questions.map((_, index) => {
      const raw = form.get(`sc${index}`);
      if (raw === null || raw === "") return null;
      return raw === "1" ? 1.0 : 0.0;
    });
    const data = await api(`/api/projects/${state.currentProjectId}/quiz/${state.quiz.quiz_id}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers, self_confidences: selfConfidences }),
    });
    state.quiz.results = data.results || [];
    state.quizDraftAnswers = {}; // 已提交，草稿清空
    data.results.forEach((result, index) => {
      const container = $(`#result-${index}`);
      container.className = `quiz-result ${result.correct ? "correct" : "wrong"}`;
      container.innerHTML = quizFeedbackContent(state.quiz.questions[index], result);
    });
    appendMessage("assistant", `本次测验得分 ${data.correct}/${data.total}。知识节点掌握度已更新。`);
    $("#quiz-form button[type='submit']").disabled = true;
    $("#quiz-form button[type='submit']").textContent = "已提交";
    await refreshCurrentProject({ renderStudio: false, preserveQuizResults: true });
    // 掌握度透明化：测验后刷新明细，再刷新 framework 视图显示新的来源贡献
    try {
      await refreshMasteryBreakdown({ reRender: false });
      if (state.feature === "framework") renderFramework();
    } catch (e) {
      console.warn("[mastery] 测验后刷新明细失败", e);
    }
    // 桌宠整体评价：按正确率分档给出鼓励/复盘，并直播本次掌握度涨幅（由 tju-llm 动态生成，失败回退分档文案）
    (function assessQuiz() {
      const total = data.total || 0, correct = data.correct || 0, ratio = total ? correct / total : 0;
      if (!total) return;
      // 「先押一个」翻车统计：押「确定」却答错的题，点评里顺嘴调侃一句
      const oc = (data.results || []).filter(
        (r) => r && r.correct === false && r.self_confidence != null && Number(r.self_confidence) >= 0.5,
      ).length;
      const ocLine = oc ? ` 另有 ${oc} 道你押了「确定」却翻车——别慌，这种题是全卷最值钱的情报，明天优先修它们。` : "";
      let text, mood, ic, stayMs = 7000;
      if (correct >= total) { text = "全对！这就是「火候到了」，掌握度的节点都开花了，可以冲下一个难度了！"; mood = "cheer"; ic = "🏆"; }
      else if (ratio >= 0.8) { text = `干得漂亮！${correct}/${total} 拿下，个别失手的题回来源材料复看一遍，会更稳。${ocLine}`; mood = "happy"; ic = "🌟"; }
      else if (ratio >= 0.6) { text = `站稳及格线了，${correct}/${total}，主干已经掌握。没答对的题回来源复看，重点会浮出来。${ocLine}`; mood = "love"; ic = "🌷"; }
      else { text = `先别灰心，${correct}/${total} 正好告诉我们哪儿还要补。回到笔记逐题复盘，再战一定能翻盘，我陪着你。${ocLine}`; mood = "think"; ic = "🩹"; stayMs = 8000; }
      const gainTxt = _masteryGainText();
      const fallback = gainTxt ? `${text} ${gainTxt}` : text;
      petReactAI("quiz", { correct, total, gains: gainTxt || [] }, mood, fallback, { ic, stayMs });
    })();
  } catch (error) { showError(error); }
}

// ── 「先押一个」自评把握度 ───────────────────────────────────────────────
// 语义：1 = 我确定，0 = 我不确定，没勾 = 跳过（写 NULL，不参与任何判据）。
// 这是**学习者自己说的**，与 learning_events.confidence（LLM 的节点映射置信度）是两回事。
// 只在校验型题目（小测验 / 节点测验）上问；开放题的 0~4 自评走 FSRS，别混。
function quizSelfConfidenceMarkup(index, picked) {
  const mark = (value, text) =>
    `<label class="quiz-selfc-opt"><input type="radio" name="sc${index}" value="${value}"${picked === Number(value) ? " checked" : ""}><span>${text}</span></label>`;
  return `<div class="quiz-selfc"><span class="quiz-selfc-prompt">先押一个：</span>${mark(1, "我确定")}${mark(0, "我不确定")}</div>`;
}

// 四象限：自评 × 结果。没勾自评就不给标签 —— 不编数据。
function quizQuadrantKey(result) {
  if (!result) return null;
  const sc = result.self_confidence;
  if (sc === null || sc === undefined || sc === "") return null;
  const sure = Number(sc) >= 0.5;
  return sure ? (result.correct ? "solid" : "overconfident") : (result.correct ? "shaky" : "expected");
}

function quizQuadrantMarkup(result) {
  const key = quizQuadrantKey(result);
  if (!key) return "";
  const text = { solid: "✓ 稳", overconfident: "⚠ 误以为会", shaky: "待巩固", expected: "正常" }[key];
  return `<span class="quiz-quad quiz-quad--${key}">${text}</span>`;
}

// ── 「先押一个」× 对错的幽默点评 ──────────────────────────────────────────
// 口径：调侃自己不嘲弄人。「误以为会」在本项目里是「最值钱的发现」，不是「你打脸了」；
// 每象限备几句随机抽，同一题重进历史会换一句，属预期。没押（NULL）不给 —— 不硬抖机灵。
const QUIZ_SELFC_HUMOR = {
  solid: [
    "押「确定」还真对了——这题在你手里已经是案板上的肉。",
    "自信不是盲目的，至少这题不是。",
    "「我确定」的含金量，这题盖章认证了。",
  ],
  overconfident: [
    "嘴上说「确定」，答案却是另一个故事——它已经进「明天优先修」蹲你了。",
    "自信是好东西，但这个知识点表示：我们还不太熟。",
    "押「确定」答错不亏：你用一格自信，换到了全卷最值钱的情报——这里有个坑。",
  ],
  shaky: [
    "嘴上说「没底」，答得比谁都准——是运气还是直觉？下回押个「确定」验验货。",
    "蒙对的题不会消失，只会挂上「待巩固」在复习里等你。",
    "「我不确定」还答对了，这题对你来说是薛定谔的会。",
  ],
  expected: [
    "押「不确定」也真错了——你和判分系统难得意见一致：这题确实还不会。",
    "押得准，错得也稳。已知不会，现在官方盖章了。",
    "诚实押注 + 诚实答错 = 一个干净的待办，比含糊的自我感觉值钱多了。",
  ],
};

// 点评挂在每题反馈里：只在押了自评时出现
function quizSelfcHumor(result) {
  const key = quizQuadrantKey(result);
  if (!key) return "";
  const lines = QUIZ_SELFC_HUMOR[key];
  if (!lines || !lines.length) return "";
  const line = lines[Math.floor(Math.random() * lines.length)];
  return `<div class="quiz-selfc-humor" data-humor-kind="${key}">${escapeHtml(line)}</div>`;
}

// 顶部汇总：把「误以为会」接到第 7 环（它会进明日计划的「先修这个」桶），
// 否则用户看见标签也不知道有什么用。文案带点幽默，但仍要说清「接下来会发生什么」。
function quizQuadrantSummaryMarkup(results) {
  if (!Array.isArray(results) || !results.length) return "";
  const n = results.filter(
    (r) => r && r.correct === false && r.self_confidence != null && Number(r.self_confidence) >= 0.5,
  ).length;
  if (!n) return "";
  const m = results.filter(
    (r) => r && r.correct && r.self_confidence != null && Number(r.self_confidence) < 0.5,
  ).length;
  const leads = [
    `「我确定」翻车 ${n} 题——别灰心，这是整张卷子最值钱的发现，`,
    `${n} 道嘴上说会、身体答错，自信和实力打了个时间差。`,
    `${n} 道押「确定」翻车：你自信地走进去，又自信地被抬出来。`,
  ];
  const lead = leads[Math.floor(Math.random() * leads.length)];
  const tail = m ? ` 另有 ${m} 道「没底」却蒙对，在待巩固里排队。` : "";
  return `<div class="quiz-quad-summary">${lead}已加入<b>明天优先修</b>。${tail}</div>`;
}

// ── 错因：答错之后自己选，可跳过 ──────────────────────────────────────────
// 四档不是随便定的 —— 每一档对应一个**不同的下一步动作**（见后端 ERROR_TYPE_ACTIONS）。
// 再拆细（审题粗心 / 算错 / 表达不规范）下游动作完全一样，那就是加壳。
// ⚠️ 必须与后端 framework.ERROR_TYPES 的键一致 —— tools/check_error_type.py 有漂移断言。
const QUIZ_ERROR_TYPES = [
  ["prereq_missing", "这块我压根没学过"],
  ["confused", "和别的东西记混了"],
  ["forgotten", "想不起来"],
  ["other", "其他"],
];
const QUIZ_ERROR_HINTS = {
  prereq_missing: "先把它的前置补上，再回来做这道",
  confused: "做一次对比辨析，把这两个东西分开",
  forgotten: "交给间隔复习，别指望今天记住",
  other: "换个角度再练一遍",
};

function quizErrorTypeMarkup(index, quizId, wrong, chosen) {
  if (!wrong) return ""; // 答对的题不问 —— 没有错因可问
  const picked = chosen || "";
  const chips = QUIZ_ERROR_TYPES.map((pair) =>
    `<button class="quiz-errc-opt${picked === pair[0] ? " is-picked" : ""}" type="button"` +
    ` data-quiz-error-type="${pair[0]}" data-quiz-id="${escapeAttr(quizId)}" data-q-index="${index}"` +
    ` aria-pressed="${picked === pair[0] ? "true" : "false"}" title="${escapeAttr(QUIZ_ERROR_HINTS[pair[0]] || "")}">` +
    `${escapeHtml(pair[1])}</button>`
  ).join("");
  return `<div class="quiz-errc"><span class="quiz-errc-prompt">错在哪？（可跳过）</span>${chips}</div>`;
}

async function submitQuizErrorType(button) {
  const value = button.dataset.quizErrorType;
  const quizId = button.dataset.quizId;
  const index = Number(button.dataset.qIndex);
  if (!quizId || !Number.isInteger(index)) return;
  const row = button.closest(".quiz-errc");
  try {
    await api(`/api/projects/${encodeURIComponent(state.currentProjectId)}/quiz/${encodeURIComponent(quizId)}/questions/${index}/error-type`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error_type: value }),
    });
    // 写进 state，重渲染时才能还原选中态（两套测验共用同一个后端端点）
    const holder = state.quiz && state.quiz.quiz_id === quizId ? state.quiz.results?.[index] : null;
    if (holder) holder.error_type = value;
    const kb = state.kbNodeQuiz && state.kbNodeQuiz.quiz_id === quizId ? state.kbNodeQuiz : null;
    if (kb && kb.results?.[index]) kb.results[index].error_type = value;
    if (row) {
      row.querySelectorAll(".quiz-errc-opt").forEach((el) => {
        const on = el.dataset.quizErrorType === value;
        el.classList.toggle("is-picked", on);
        el.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }
  } catch (err) {
    showToast(err.message || "没记下这个错因", { variant: "notice" });
  }
}

function renderQuizFeedback(question, result, index) {
  return `<div id="result-${index}" class="quiz-result ${result.correct ? "correct" : "wrong"}">${quizFeedbackContent(question, result)}</div>`;
}

function quizFeedbackContent(question, result) {
  const correctAnswer = displayQuizAnswer(question, result.answer);
  const submittedAnswer = displayQuizAnswer(question, result.submitted_answer || "");
  const label = result.correct ? "正确" : "需要复习";
  return `<strong>${label} · 难度 ${result.difficulty || question?.difficulty || 1}${quizQuadrantMarkup(result)}</strong>${quizSelfcHumor(result)}<span>你的答案：${renderMathContent(submittedAnswer || "未作答")}</span><span>正确答案：${renderMathContent(correctAnswer)}</span><div class="quiz-explanation">${renderStudyTextContent(result.explanation || "请回到来源材料复核这一题。")}</div>`;
}

function displayQuizAnswer(question, answer) {
  if (question?.type === "choice" || question?.type === "single_choice") {
    const expected = String(answer || "").trim().slice(0, 1).toUpperCase();
    const option = (question.options || []).find((item) => item.trim().toUpperCase().startsWith(`${expected}.`));
    return option || answer;
  }
  if (question?.type === "multiple_choice" || question?.type === "indefinite_choice") {
    const letters = (String(answer || "").toUpperCase().match(/[A-F]/g) || []).sort();
    return letters.map((letter) => {
      const option = (question.options || []).find((item) => item.trim().toUpperCase().startsWith(`${letter}.`));
      return option || letter;
    }).join("、");
  }
  return answer;
}

function isSubmittedChoice(question, option, answer) {
  if (!answer) return false;
  if (question.type === "multiple_choice" || question.type === "indefinite_choice") {
    const letters = new Set((answer || "").toUpperCase().match(/[A-F]/g) || []);
    const letter = option.trim().charAt(0).toUpperCase();
    return letters.has(letter);
  }
  return option === answer || displayQuizAnswer(question, answer) === option;
}

// 判断某个选项是否为该题的标准答案（按选项首字母对标 q.answer）
function isQuizOptionCorrect(question, option) {
  const letter = String(option || "").trim().charAt(0).toUpperCase();
  if (!/[A-F]/.test(letter)) return false;
  const answerLetters = (String(question.answer || "").toUpperCase().match(/[A-F]/g) || []);
  return answerLetters.includes(letter);
}

// 提交后选项着色：正确答案标绿（opt-correct）、错选标红（opt-wrong），未判分为空串
function quizOptionStateClasses(question, option, result) {
  if (!result) return "";
  if (isQuizOptionCorrect(question, option)) return " opt-correct";
  if (isSubmittedChoice(question, option, result.submitted_answer)) return " opt-wrong";
  return "";
}

// 提交后选项图标：正确答案 ✓、错选 ✗
function quizOptionMark(question, option, result) {
  if (!result) return "";
  if (isQuizOptionCorrect(question, option)) return '<span class="opt-mark opt-mark-correct">✓</span>';
  if (isSubmittedChoice(question, option, result.submitted_answer)) return '<span class="opt-mark opt-mark-wrong">✗</span>';
  return "";
}

/* ======== Quiz History (查看历史记录) ======== */

async function loadQuizHistory() {
  if (!state.currentProjectId) return;
  try {
    const data = await api(`/api/projects/${state.currentProjectId}/quiz/history?limit=50`);
    state.quizHistory = data.history || [];
  } catch (error) {
    console.warn("[quiz-history] 加载历史失败", error);
    state.quizHistory = [];
  }
  // 数据到达后，如果仍在 quiz tab，重新渲染以显示历史列表
  if (state.feature === "quiz" && !state.viewingHistoryQuiz) renderQuiz();
}

function formatQuizHistoryDate(dateStr) {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `今天 ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const sameAsYesterday = date.getFullYear() === yesterday.getFullYear()
    && date.getMonth() === yesterday.getMonth()
    && date.getDate() === yesterday.getDate();
  if (sameAsYesterday) return `昨天 ${time}`;
  return `${date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" })} ${time}`;
}

function renderQuizHistorySection() {
  if (!state.quizHistory || !state.quizHistory.length) {
    return `<div class="quiz-history-section">
      <button class="quiz-history-toggle secondary-button" type="button" data-study-action="toggle-quiz-history">
        <span aria-hidden="true">📋</span> 查看历史记录
      </button>
      <p class="quiz-history-empty-hint">暂无测验记录</p>
    </div>`;
  }
  const currentQuizId = state.quiz?.quiz_id;
  const historyItems = state.quizHistory.map((entry) => {
    const isCurrent = entry.quiz_id === currentQuizId;
    const dateStr = formatQuizHistoryDate(entry.created_at);
    const scoreStr = entry.score != null ? `${Math.round(entry.score * 100)}%` : "未提交";
    const scoreClass = entry.score != null ? (entry.score >= 0.8 ? "high" : entry.score >= 0.5 ? "mid" : "low") : "none";
    const isViewing = state.viewingHistoryQuiz?.quiz_id === entry.quiz_id;
    return `<button class="quiz-history-item${isCurrent ? " is-current" : ""}${isViewing ? " is-viewing" : ""}" type="button" data-study-action="view-history-quiz" data-quiz-id="${escapeAttr(entry.quiz_id)}">
      <span class="quiz-history-date">${escapeHtml(dateStr)}</span>
      <span class="quiz-history-meta">
        <span class="quiz-history-count">${entry.question_count} 题</span>
        <span class="quiz-history-score score-${scoreClass}">${scoreStr}</span>
      </span>
      ${isCurrent ? '<span class="quiz-history-current-badge">当前</span>' : ""}
    </button>`;
  }).join("");
  const expanded = state.quizHistoryExpanded;
  return `<div class="quiz-history-section${expanded ? " is-expanded" : ""}">
    <button class="quiz-history-toggle secondary-button" type="button" data-study-action="toggle-quiz-history">
      <span aria-hidden="true">📋</span> ${expanded ? "收起历史记录" : "查看历史记录"}
      <span class="quiz-history-count-badge">${state.quizHistory.length}</span>
    </button>
    ${expanded ? `<div class="quiz-history-list">${historyItems}</div>` : ""}
  </div>`;
}

function renderHistoricQuizView() {
  const quiz = state.viewingHistoryQuiz;
  if (!quiz) return;
  const questions = quiz.questions || [];
  const dateStr = formatQuizHistoryDate(quiz.created_at);
  const scoreStr = quiz.score != null ? `得分 ${Math.round(quiz.score * 100)}%` : "未提交";
  const heading = `<div class="historic-quiz-header">
    <div class="historic-quiz-header-info">
      <span class="historic-quiz-badge">历史测验</span>
      <strong>${escapeHtml(dateStr)} · ${questions.length} 题 · ${scoreStr}</strong>
    </div>
    <button class="secondary-button historic-quiz-back" type="button" data-study-action="exit-history-quiz">
      <span aria-hidden="true">←</span> 返回当前测验
    </button>
  </div>`;
  const questionsHtml = questions.map((question, index) => {
    return renderHistoricQuestion(question, index, quiz);
  }).join("");
  $("#studio-output").innerHTML = `${heading}<div class="historic-quiz-questions">${questionsHtml}</div>`;
}

function renderHistoricQuestion(question, index, quiz) {
  let input = "";
  if (question.type === "choice" || question.type === "single_choice") {
    input = (question.options || []).map((option) => {
      const letter = option.trim().charAt(0).toUpperCase();
      const correctLetter = String(question.answer || "").trim().charAt(0).toUpperCase();
      const isCorrect = letter === correctLetter;
      return `<label class="${isCorrect ? "historic-correct" : ""}"><span class="quiz-option-text">${renderMathContent(option)}</span>${isCorrect ? ' <span class="historic-correct-mark">✓ 正确答案</span>' : ""}</label>`;
    }).join("");
  } else if (question.type === "multiple_choice" || question.type === "indefinite_choice") {
    const correctLetters = new Set((String(question.answer || "").toUpperCase().match(/[A-F]/g) || []).sort());
    input = (question.options || []).map((option) => {
      const letter = option.trim().charAt(0).toUpperCase();
      const isCorrect = correctLetters.has(letter);
      return `<label class="${isCorrect ? "historic-correct" : ""}"><span class="quiz-option-text">${renderMathContent(option)}</span>${isCorrect ? ' <span class="historic-correct-mark">✓</span>' : ""}</label>`;
    }).join("");
  } else {
    input = `<div class="historic-answer"><strong>参考答案：</strong>${renderMathContent(question.answer || "")}</div>`;
  }
  const typeLabel = {"choice":"单选","single_choice":"单选","multiple_choice":"多选","indefinite_choice":"不定项","fill":"填空","fill_blank":"填空","short_answer":"简答","calculation":"计算"}[question.type] || question.type || "题";
  const explanation = question.explanation ? `<div class="quiz-explanation historic-explanation">${renderStudyTextContent(question.explanation)}</div>` : "";
  const originId = `${quiz.quiz_id}:${index}`;
  return `<article class="quiz-question historic-question" data-study-selectable data-study-item-type="quiz" data-origin-id="${escapeAttr(originId)}"><div class="review-item-heading"><span class="count-pill">第 ${index + 1} 题 · ${typeLabel} · 难度 ${question.difficulty || 1}</span></div><p class="study-title-line"><strong>${index + 1}. ${renderMathContent(question.question)}</strong></p>${input}${explanation}</article>`;
}

async function enterHistoricQuizView(quizId) {
  if (!state.quizHistory) await loadQuizHistory();
  const entry = (state.quizHistory || []).find((q) => q.quiz_id === quizId);
  if (!entry) {
    showError(new Error("找不到该历史测验。"));
    return;
  }
  state.viewingHistoryQuiz = entry;
  // 从「学习概览 / 知识框架」等非 quiz 视图跳进来时（如进步面板的「看那道错题」），
  // feature 还不是 quiz：renderStudio 只按 feature 分发，viewingHistoryQuiz 只在
  // renderQuiz 里被检查，不切过去就渲染不到历史测验。这里直接设 feature（不走
  // switchFeature——它会在 state.quiz 为空时触发 generateQuiz），只补按钮高亮。
  if (state.feature !== "quiz") {
    state.feature = "quiz";
    $$(".feature-button").forEach((button) =>
      button.classList.toggle("active", button.dataset.feature === "quiz")
    );
    syncFeatureNav();
  }
  renderStudio();
}

function exitHistoricQuizView() {
  state.viewingHistoryQuiz = null;
  renderStudio();
}

function favoriteColorPickerMarkup(itemType, originId, activeColor) {
  return `<span class="color-picker">${FAVORITE_HIGHLIGHT_COLORS.map((color) => `<button class="color-dot color-${color}${color === activeColor ? " active" : ""}" type="button" data-color="${color}" data-item-type="${escapeAttr(itemType)}" data-origin-id="${escapeAttr(originId)}" title="${highlightColorText(color)}高亮"></button>`).join("")}</span>`;
}

function findFavorite(itemType, originId) {
  return state.favorites.find((item) => item.item_type === itemType && item.origin_id === originId);
}

function favoriteHighlightColor(favorite) {
  return FAVORITE_HIGHLIGHT_COLORS.includes(favorite?.highlight_color) ? favorite.highlight_color : "none";
}

function favoriteHighlightClass(itemType, originId) {
  const favorite = findFavorite(itemType, originId);
  return favorite ? ` note-highlighted note-highlight-${favoriteHighlightColor(favorite)}` : "";
}

function setFavoriteHighlightClasses(element, favorite) {
  if (!element) return;
  element.classList.toggle("note-highlighted", Boolean(favorite));
  FAVORITE_HIGHLIGHT_COLORS.forEach((color) => element.classList.remove(`note-highlight-${color}`));
  if (favorite) element.classList.add(`note-highlight-${favoriteHighlightColor(favorite)}`);
}

async function toggleFavorite(button) {
  if (!state.currentProjectId || button.disabled) return;
  const itemType = button.dataset.itemType;
  const originId = button.dataset.originId;
  const existing = findFavorite(itemType, originId);
  button.disabled = true;
  try {
    if (existing) {
      await api(`/api/projects/${state.currentProjectId}/favorites/${encodeURIComponent(existing.favorite_id)}`, { method: "DELETE" });
      state.favorites = state.favorites.filter((item) => item.favorite_id !== existing.favorite_id);
      showUndoNotice("已从“我的笔记”移除。", () => restoreFavorite(existing));
    } else {
      const favorite = await api(`/api/projects/${state.currentProjectId}/favorites`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_type: itemType,
          origin_id: originId,
          answer_id: button.dataset.answerId || null,
        }),
      });
      state.favorites = [favorite, ...state.favorites.filter((item) => item.favorite_id !== favorite.favorite_id)];
      showUndoNotice(`已标亮并加入“${favorite.chapter_name}”。`, () => deleteFavorite(favorite.favorite_id, { offerUndo: false }));
    }
    updateFavoriteCount();
    syncFavoriteButtons(itemType, originId);
    if (state.feature === "favorites") renderFavorites();
    else kbReconcileStudyView();
  } catch (error) {
    showError(error, () => toggleFavorite(button));
  } finally {
    button.disabled = false;
  }
}

function syncFavoriteButtons(itemType, originId) {
  const favorite = findFavorite(itemType, originId);
  $$(".favorite-button").filter((button) => (
    button.dataset.itemType === itemType && button.dataset.originId === originId
  )).forEach((button) => {
    const label = favorite ? "取消收藏" : (button.dataset.emptyLabel || "收藏");
    const color = favoriteHighlightColor(favorite);
    button.dataset.favoriteId = favorite?.favorite_id || "";
    button.classList.toggle("is-favorite", Boolean(favorite));
    FAVORITE_HIGHLIGHT_COLORS.forEach((item) => button.classList.remove(`favorite-${item}`));
    button.classList.add(`favorite-${color}`);
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", favorite ? "true" : "false");
    button.title = label;
    button.textContent = favorite ? "★" : "☆";
    const colorPicker = button.nextElementSibling?.classList?.contains("color-picker") ? button.nextElementSibling : null;
    if (favorite && !colorPicker) button.insertAdjacentHTML("afterend", favoriteColorPickerMarkup(itemType, originId, color));
    if (!favorite && colorPicker) colorPicker.remove();
    setFavoriteHighlightClasses(button.closest(".card, .quiz-question, .message"), favorite);
  });
  $$('[data-study-item-action="favorite"]').filter((button) => (
    button.dataset.itemType === itemType && button.dataset.originId === originId
  )).forEach((button) => {
    button.textContent = favorite ? "取消收藏" : "收藏";
    setFavoriteHighlightClasses(button.closest(".card, .quiz-question"), favorite);
  });
  $$('[data-message-action="favorite"]').filter((button) => (
    button.dataset.itemType === itemType && button.dataset.originId === originId
  )).forEach((button) => {
    button.textContent = favorite ? "取消收藏" : "收藏";
    setFavoriteHighlightClasses(button.closest(".message"), favorite);
  });
  $$(".color-dot").filter((button) => (
    button.dataset.itemType === itemType && button.dataset.originId === originId
  )).forEach((button) => {
    button.classList.toggle("active", Boolean(favorite) && button.dataset.color === favoriteHighlightColor(favorite));
  });
  $$(".favorite-entry").filter((entry) => (
    entry.dataset.itemType === itemType && entry.dataset.originId === originId
  )).forEach((entry) => {
    FAVORITE_HIGHLIGHT_COLORS.forEach((c) => entry.classList.remove(`favorite-highlight-${c}`));
    if (favorite) entry.classList.add(`favorite-highlight-${favoriteHighlightColor(favorite)}`);
  });
}

async function updateFavoriteColor(button) {
  if (!state.currentProjectId || button.disabled) return;
  const itemType = button.dataset.itemType;
  const originId = button.dataset.originId;
  const color = button.dataset.color;
  const favorite = findFavorite(itemType, originId);
  if (!favorite || !FAVORITE_HIGHLIGHT_COLORS.includes(color) || favorite.highlight_color === color) return;
  button.disabled = true;
  try {
    const updated = await updateFavorite(favorite.favorite_id, { highlight_color: color });
    state.favorites = state.favorites.map((item) => item.favorite_id === updated.favorite_id ? updated : item);
    syncFavoriteButtons(itemType, originId);
  } catch (error) {
    showError(error, () => updateFavoriteColor(button));
  } finally {
    button.disabled = false;
  }
}

function updateFavoriteCount() {
  const badge = $("#favorite-count");
  if (badge) {
    badge.textContent = String(state.favorites.length);
    badge.classList.toggle("hidden", state.favorites.length === 0);
  }
  // Agent 布局的图标栏上也挂一颗同样的计数（那边没有 .feature-button 可借）
  const railBadge = $("#agent-rail-favorite-count");
  if (railBadge) {
    railBadge.textContent = String(state.favorites.length);
    railBadge.classList.toggle("hidden", state.favorites.length === 0);
  }
}

function renderFavorites() {
  // Clean up stale text-highlight state before destroying DOM — the
  // activeHighlight range may point into content that is about to be
  // replaced (either immediately or via an async resume that runs before
  // pending selection-change setTimeout callbacks). If we don't clear it,
  // the floating toolbar's color swatches will silently abort because
  // active.container.isConnected becomes false on the next click.
  hideTextHighlightToolbar();
  if (!state.favorites.length) {
    return renderEmptyOutput("还没有笔记", "在知识卡片、AI 问答或小测验中点击“标亮并记笔记”。");
  }
  const groups = new Map();
  state.favorites.forEach((favorite) => {
    const chapter = favorite.chapter_name || "未归类";
    if (!groups.has(chapter)) groups.set(chapter, []);
    groups.get(chapter).push(favorite);
  });
  const orderedGroups = [...groups.entries()].sort(([left], [right]) => {
    if (left === "未归类") return 1;
    if (right === "未归类") return -1;
    return left.localeCompare(right, "zh-CN");
  });
  $("#studio-output").innerHTML = `<div class="favorites-overview"><div><p class="eyebrow">Study notes</p><h3>我的笔记</h3><p>已按知识章节整理 ${state.favorites.length} 条标亮内容，可继续补充批注、修改归类或撤销操作。</p></div><span class="favorite-total">${state.favorites.length}</span></div><div class="favorite-groups">${orderedGroups.map(([chapter, items]) => `<section class="favorite-group"><header><div><span class="chapter-marker">§</span><h3>${escapeHtml(chapter)}</h3></div><span>${items.length} 条</span></header><div class="favorite-items">${items.map(favoriteEntryMarkup).join("")}</div></section>`).join("")}</div>`;
}

function favoriteEntryMarkup(favorite) {
  if (state.editingFavoriteId === favorite.favorite_id) return favoriteEditMarkup(favorite);
  const color = favoriteHighlightColor(favorite);
  const content = favorite.content && favorite.content !== favorite.title
    ? highlightableMarkup(`favorite:${favorite.favorite_id}:content`, `<p class="favorite-content">${renderMathContent(favorite.content)}</p>`, "favorite-highlight-text")
    : "";
  const answer = favorite.answer
    ? `<details class="favorite-answer"><summary>查看原答案</summary>${highlightableMarkup(`favorite:${favorite.favorite_id}:answer`, renderStudyTextContent(favorite.answer), "favorite-answer-text")}</details>`
    : "";
  const note = favorite.note
    ? `<div class="favorite-note"><strong>我的批注</strong>${highlightableMarkup(`favorite:${favorite.favorite_id}:note`, renderStudyTextContent(favorite.note), "favorite-note-text")}</div>`
    : '<p class="favorite-note-placeholder">还没有批注，点击“修改”补充自己的理解。</p>';
  return `<article class="favorite-entry favorite-highlight-${color}" data-item-type="${escapeAttr(favorite.item_type)}" data-origin-id="${escapeAttr(favorite.origin_id)}"><div class="favorite-entry-heading"><span class="favorite-type">${favoriteTypeLabel(favorite.item_type)}</span><div class="favorite-entry-actions">${favoriteColorPickerMarkup(favorite.item_type, favorite.origin_id, color)}<button class="mini-button" type="button" data-favorite-action="edit" data-favorite-id="${escapeAttr(favorite.favorite_id)}">修改</button><button class="mini-button danger" type="button" data-favorite-action="delete" data-favorite-id="${escapeAttr(favorite.favorite_id)}">移除</button></div></div>${highlightableMarkup(`favorite:${favorite.favorite_id}:title`, `<h4>${renderMathContent(favorite.title)}</h4>`, "favorite-title-text")}${content}${answer}${note}</article>`;
}

function favoriteEditMarkup(favorite) {
  const listId = `favorite-chapters-${favorite.favorite_id}`;
  const chapterNames = [...new Set([
    ...state.nodes.map((node) => node.name),
    ...state.favorites.map((item) => item.chapter_name),
  ].filter(Boolean))];
  return `<form class="favorite-entry favorite-edit-form" data-favorite-id="${escapeAttr(favorite.favorite_id)}"><div class="favorite-edit-heading"><p class="eyebrow">修改笔记</p><span>保存后可一键撤销</span></div><label>标题<input name="title" maxlength="200" value="${escapeAttr(favorite.title)}" required></label><label>所属章节<input name="chapter_name" maxlength="80" list="${escapeAttr(listId)}" value="${escapeAttr(favorite.chapter_name)}" required><datalist id="${escapeAttr(listId)}">${chapterNames.map((name) => `<option value="${escapeAttr(name)}"></option>`).join("")}</datalist></label><label>我的批注<textarea name="note" maxlength="1000" rows="4" placeholder="记下自己的理解、易错点或待复习内容…">${escapeHtml(favorite.note || "")}</textarea></label><div class="favorite-edit-actions"><button class="primary-button" type="submit">保存修改</button><button class="mini-button" type="button" data-favorite-action="cancel" data-favorite-id="${escapeAttr(favorite.favorite_id)}">取消</button></div></form>`;
}

async function saveFavoriteEdit(form) {
  const favoriteId = form.dataset.favoriteId;
  const previous = state.favorites.find((item) => item.favorite_id === favoriteId);
  if (!previous) return;
  const fields = new FormData(form);
  const payload = {
    title: String(fields.get("title") || "").trim(),
    chapter_name: String(fields.get("chapter_name") || "").trim(),
    note: String(fields.get("note") || "").trim(),
  };
  if (!payload.title || !payload.chapter_name) return showError(new Error("标题和所属章节不能为空。"));
  const submitButton = form.querySelector('[type="submit"]');
  submitButton.disabled = true;
  try {
    const updated = await updateFavorite(favoriteId, payload);
    state.favorites = state.favorites.map((item) => item.favorite_id === favoriteId ? updated : item);
    state.editingFavoriteId = "";
    renderFavorites();
    showUndoNotice("笔记修改已保存。", () => undoFavoriteUpdate(previous));
  } catch (error) {
    showError(error, () => saveFavoriteEdit(form));
    submitButton.disabled = false;
  }
}

async function updateFavorite(favoriteId, payload) {
  return api(`/api/projects/${state.currentProjectId}/favorites/${encodeURIComponent(favoriteId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function undoFavoriteUpdate(previous) {
  const restored = await updateFavorite(previous.favorite_id, {
    title: previous.title,
    chapter_name: previous.chapter_name,
    note: previous.note,
    highlight_color: previous.highlight_color,
  });
  state.favorites = state.favorites.map((item) => item.favorite_id === restored.favorite_id ? restored : item);
  if (state.feature === "favorites") renderFavorites();
  showUndoNotice("已撤销笔记修改。");
}

async function deleteFavorite(favoriteId, { offerUndo = true } = {}) {
  const removed = state.favorites.find((item) => item.favorite_id === favoriteId);
  try {
    await api(`/api/projects/${state.currentProjectId}/favorites/${encodeURIComponent(favoriteId)}`, { method: "DELETE" });
    state.favorites = state.favorites.filter((item) => item.favorite_id !== favoriteId);
    state.editingFavoriteId = "";
    updateFavoriteCount();
    if (removed) syncFavoriteButtons(removed.item_type, removed.origin_id);
    if (state.feature === "favorites") renderFavorites();
    if (removed && offerUndo) showUndoNotice("已从“我的笔记”移除。", () => restoreFavorite(removed));
  } catch (error) { showError(error, () => deleteFavorite(favoriteId, { offerUndo })); }
}

async function restoreFavorite(previous) {
  const projectId = previous.project_id;
  const restored = await api(`/api/projects/${projectId}/favorites/${encodeURIComponent(previous.favorite_id)}/restore`, { method: "POST" });
  if (state.currentProjectId !== projectId) return;
  state.favorites = [restored, ...state.favorites.filter((item) => item.favorite_id !== restored.favorite_id)];
  updateFavoriteCount();
  syncFavoriteButtons(restored.item_type, restored.origin_id);
  if (state.feature === "favorites") renderFavorites();
  showUndoNotice("笔记已恢复。");
}

function showUndoNotice(message, action = null) {
  window.clearTimeout(state.undoTimer);
  state.undoAction = action;
  const messageEl = $("#undo-message");
  const buttonEl = $("#undo-button");
  const toastEl = $("#undo-toast");
  if (!messageEl || !buttonEl || !toastEl) return; // 容器结构可能已被 showToast 毁掉，兜底不崩
  messageEl.textContent = message;
  buttonEl.classList.toggle("hidden", !action);
  toastEl.classList.remove("hidden");
  state.undoTimer = window.setTimeout(hideUndoNotice, 6000);
}

async function performUndo() {
  const action = state.undoAction;
  hideUndoNotice();
  if (!action) return;
  try { await action(); }
  catch (error) { showError(error, action); }
}

function hideUndoNotice() {
  window.clearTimeout(state.undoTimer);
  state.undoTimer = 0;
  state.undoAction = null;
  $("#undo-toast").classList.add("hidden");
}

// ---------- 全局撤销（Ctrl+Z） ----------

function handleGlobalUndoKeydown(event) {
  if (event.defaultPrevented) return;
  if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
  if (String(event.key).toLowerCase() !== "z") return;
  const target = event.target;
  if (
    target &&
    (target.isContentEditable ||
      target.closest("input, textarea, select, [contenteditable='true']"))
  ) {
    return; // 输入框内保留浏览器原生文本撤销
  }
  if (!state.authenticated) return;
  event.preventDefault();
  performGlobalUndo();
}

async function performGlobalUndo() {
  if (state.globalUndoInFlight) return;
  state.globalUndoInFlight = true;
  try {
    const result = await api("/api/undo", { method: "POST" });
    await loadProjects();
    showUndoNotice(`已撤销：${result.summary || "上一步操作"}`);
  } catch (error) {
    if (error && error.status === 404) {
      showUndoNotice(error.message || "没有可撤销的操作。");
    } else {
      showError(error, performGlobalUndo);
    }
  } finally {
    state.globalUndoInFlight = false;
  }
}

function favoriteTypeLabel(type) {
  return { card: "知识卡片", quiz: "测验题", question: "AI 问答" }[type] || "学习内容";
}

function highlightableMarkup(scope, html, className = "") {
  const baseHash = hashString(html);
  const saved = state.textHighlights?.[scope];
  // Repair legacy saved highlights whose marks swallowed block fragments.
  const content = saved?.baseHash === baseHash ? sanitizeTextHighlightHtml(saved.html) : html;
  return `<div class="highlightable-text ${className}" data-highlight-scope="${escapeAttr(scope)}" data-highlight-base="${baseHash}">${content}</div>`;
}

function handleTextSelectionChange(event) {
  if (event?.target?.closest?.(".text-highlight-toolbar")) return;
  // 选中浮动菜单已接管（主对话提问 / KB 引导），不再叠加高亮工具条
  const selMenu = document.querySelector("[data-kb-sel-actions]");
  if (selMenu && !selMenu.hidden) return;
  window.setTimeout(() => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return hideTextHighlightToolbar();
    const range = selection.getRangeAt(0);
    const node = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    const container = node?.closest?.(".highlightable-text");
    // KB 整理助手（整理预览 / 对话）的选中高亮统一交给 kb-sel-actions 菜单，不叠加独立高亮工具条
    if (container && container.closest("[data-kb-guide-preview], [data-kb-agent-msgs]")) return hideTextHighlightToolbar();
    if (!container || !container.isConnected || !container.contains(range.startContainer) || !container.contains(range.endContainer)) {
      return hideTextHighlightToolbar();
    }
    state.activeHighlight = { container, range: range.cloneRange() };
    _pendingTextHighlight = state.activeHighlight;
    showTextHighlightToolbar(range.getBoundingClientRect());
  }, 0);
}

function handleTextHighlightDocumentClick(event) {
  const button = event.target.closest?.("[data-text-highlight-color]");
  if (button) {
    event.preventDefault();
    applyTextHighlight(button.dataset.textHighlightColor);
    return;
  }
  if (!event.target.closest?.(".highlightable-text, .text-highlight-toolbar")) hideTextHighlightToolbar();
}

function showTextHighlightToolbar(rect) {
  const toolbar = ensureTextHighlightToolbar();
  toolbar.classList.remove("hidden");
  const x = Math.min(window.innerWidth - toolbar.offsetWidth - 12, Math.max(12, rect.left + rect.width / 2 - toolbar.offsetWidth / 2));
  const y = Math.max(12, rect.top - toolbar.offsetHeight - 10);
  toolbar.style.left = `${Math.round(x)}px`;
  toolbar.style.top = `${Math.round(y)}px`;
}

function ensureTextHighlightToolbar() {
  let toolbar = $("#text-highlight-toolbar");
  if (toolbar) return toolbar;
  toolbar = document.createElement("div");
  toolbar.id = "text-highlight-toolbar";
  toolbar.className = "text-highlight-toolbar hidden";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "文本高亮颜色");
  toolbar.innerHTML = TEXT_HIGHLIGHT_COLORS.map((color) => (
    `<button class="text-highlight-swatch text-highlight-${color}" type="button" data-text-highlight-color="${color}" aria-label="${highlightColorLabel(color)}"></button>`
  )).join("") + '<button class="text-highlight-clear" type="button" data-text-highlight-color="clear">清除</button>';
  document.body.append(toolbar);
  // 点击色块的 mousedown 默认会塌陷文字选区 → 触发 selectionchange 把 activeHighlight 清空，
  // 并可能在 click 命中前就隐藏工具条，导致高亮静默失效。
  // 因此在 mousedown 上同步应用高亮（此刻选区尚未被清理），并 preventDefault 保住选区。
  // applyTextHighlight 完成时会清空 state.activeHighlight/_pendingTextHighlight，
  // 所以其后的 click 再进入 applyTextHighlight 只会空转，不会重复包裹。
  toolbar.addEventListener("mousedown", (e) => {
    const swatch = e.target.closest?.("[data-text-highlight-color]");
    if (!swatch) return;
    e.preventDefault();
    applyTextHighlight(swatch.dataset.textHighlightColor);
  });
  return toolbar;
}

function applyTextHighlight(color) {
  // 高亮应用会重建 DOM 并重定向随后 click 到 body，守卫让 closeStudioFocusFromBackdrop
  // 忽略这段窗口内发生的背板点击，避免误收起全屏学习产出。
  state._hlGuard = performance.now();
  // 色块点击可能已把文档选区塌陷并清空 state.activeHighlight，
  // 用 _pendingTextHighlight 兜底取回上一次有效选区。
  const active = state.activeHighlight || _pendingTextHighlight;
  if (!active?.range || !active.container?.isConnected) return hideTextHighlightToolbar();
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(active.range);
  if (color === "clear") {
    clearSelectedTextHighlight(active.range, active.container);
  } else {
    try {
      // 高亮只圈选中的文字，不再吸附到整段/整句（否则选一个字会高亮整个句子）。
      expandRangePastMathNodes(active.range, active.container);
      // 对已高亮的文字再次上色是“换色”而非“套娃”：先摘掉旧高亮，再包新色，
      // 否则旧底色会叠在新 mark 下面，看起来像背景颜色没变。
      clearSelectedTextHighlight(active.range, active.container);
      // 不吞图片/图注/内嵌预览：选区跨过媒体时，拆成前后两段各自包裹，媒体本身不高亮。
      const highlightRanges = splitRangeAroundMedia(active.range, active.container);
      // 每个相交文本节点各自包 <mark>，而不是一个大 mark 套 extractContents()：
      // 跨段选区若把不完整块元素塞进内联 mark，浏览器会按块渲染，撑裂行布局。
      for (const highlightRange of highlightRanges) {
        wrapRangeInTextHighlights(highlightRange, active.container, color);
      }
    } catch {
      hideTextHighlightToolbar();
      return;
    }
  }
  active.container.normalize();
  saveTextHighlightContainer(active.container);
  _pendingTextHighlight = null;
  selection?.removeAllRanges();
  hideTextHighlightToolbar();
}

function expandRangePastMathNodes(range, container) {
  const mathSelectors = ".katex-inline-wrapper, .katex-display-wrapper, .mathjax-inline-wrapper, .mathjax-display-wrapper, .math-expression";
  const mathNodes = [...container.querySelectorAll(mathSelectors)];
  for (const mathNode of mathNodes) {
    if (!range.intersectsNode(mathNode)) continue;
    // If the range partially overlaps a math node, expand to include the full node
    const cmp1 = range.compareBoundaryPoints(Range.START_TO_START, createNodeRange(mathNode));
    const cmp2 = range.compareBoundaryPoints(Range.END_TO_END, createNodeRange(mathNode));
    if (cmp1 > 0) range.setStartBefore(mathNode);
    if (cmp2 < 0) range.setEndAfter(mathNode);
  }
}

function createNodeRange(node) {
  const r = document.createRange();
  r.selectNode(node);
  return r;
}

// Atomic inline units that must never be split by a highlight (math wrappers).
// Display-math wrappers are block-level, so they are intentionally NOT wrapped —
// wrapping them in an inline <mark> would recreate the line-shattering bug.
// Instead we tint the wrapper itself with a "display" colour class so the
// formula stays in place and the surrounding paragraph is not truncated.
const TEXT_HIGHLIGHT_ATOMIC_INLINE = ".katex-inline-wrapper, .mathjax-inline-wrapper, .math-expression";
const TEXT_HIGHLIGHT_ATOMIC_ANY = ".katex-inline-wrapper, .katex-display-wrapper, .mathjax-inline-wrapper, .mathjax-display-wrapper, .math-expression";
// Block-level math wrappers that get a dedicated "block highlight" colour class
// (rather than being wrapped in an inline <mark>) so the layout never shatters.
const TEXT_HIGHLIGHT_DISPLAY_SELECTOR = ".katex-display-wrapper, .mathjax-display-wrapper";
const TEXT_HIGHLIGHT_DISPLAY_CLASS = "text-highlight-display";
// Block-level tags that must never live inside an inline <mark>.
const TEXT_HIGHLIGHT_BLOCK_SELECTOR = "address,article,aside,blockquote,details,div,dl,fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hr,li,main,nav,ol,p,pre,section,table,ul";
// Inline-level media that should never end up inside a text-highlight (we
// either expand the range to skip past them, or wrap each side independently).
const TEXT_HIGHLIGHT_MEDIA_SELECTOR = [
  "img", "svg", "picture", "video", "audio", "canvas",
  "iframe", "embed", "object",
  "figure",
  ".sr-figure-block",
  ".sr-figure-composite",
  ".sr-figure-img",
].join(",");

function makeTextHighlightMark(color) {
  const mark = document.createElement("mark");
  mark.className = `text-highlight text-highlight-${color}`;
  mark.dataset.highlightColor = color;
  return mark;
}

function wrapRangeInTextHighlights(range, container, color) {
  // Plan phase (no DOM mutation): record every intersecting text node with its
  // covered [start, end) offsets, plus fully-covered atomic math nodes, plus
  // block-level display-math wrappers that get a dedicated tint class instead
  // of being wrapped (wrapping them in <mark> would shatter the line layout).
  const atomicNodes = [...container.querySelectorAll(TEXT_HIGHLIGHT_ATOMIC_INLINE)]
    .filter((node) => range.intersectsNode(node) && !node.closest(".text-highlight"));
  const displayNodes = [...container.querySelectorAll(TEXT_HIGHLIGHT_DISPLAY_SELECTOR)]
    .filter((node) => range.intersectsNode(node) && !node.closest(`.${TEXT_HIGHLIGHT_DISPLAY_CLASS}`));
  const entries = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest(TEXT_HIGHLIGHT_ATOMIC_ANY)) return NodeFilter.FILTER_REJECT;
      return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  let current;
  while ((current = walker.nextNode())) {
    const start = current === range.startContainer ? range.startOffset : 0;
    const end = current === range.endContainer ? range.endOffset : current.nodeValue.length;
    if (end > start) entries.push({ node: current, start, end });
  }
  if (!entries.length && !atomicNodes.length && !displayNodes.length) throw new Error("empty highlight range");

  // Mutation phase: wrap atomic math nodes whole, then wrap each planned text
  // slice in its own mark. Splitting one text node never shifts another entry's
  // offsets, because every entry references a distinct original node.
  atomicNodes.forEach((node) => {
    const mark = makeTextHighlightMark(color);
    node.replaceWith(mark);
    mark.append(node);
  });
  // Block-level display math never goes into <mark> — tint the wrapper directly
  // so the formula stays in place and the surrounding paragraph isn't truncated.
  displayNodes.forEach((node) => {
    paintTextHighlightDisplay(node, color);
  });
  entries.forEach(({ node, start, end }) => {
    if (!node.isConnected) return;
    let target = node;
    if (end < target.nodeValue.length) target.splitText(end);
    if (start > 0) target = target.splitText(start);
    const mark = makeTextHighlightMark(color);
    target.replaceWith(mark);
    mark.append(target);
  });
}

// Apply (or replace) a block-level highlight tint to a display-math wrapper.
function paintTextHighlightDisplay(wrapper, color) {
  wrapper.classList.add(TEXT_HIGHLIGHT_DISPLAY_CLASS);
  TEXT_HIGHLIGHT_COLORS.forEach((c) => wrapper.classList.remove(`text-highlight-display-${c}`));
  wrapper.classList.add(`text-highlight-display-${color}`);
  wrapper.dataset.highlightColor = color;
}

// Media nodes (images, figures, embedded previews …) carry no selectable text,
// so a drag crossing one would otherwise wrap the whole <img>/<svg> in a
// highlight. Split the range into the text before and after the media run and
// return each side as an independent range.
function splitRangeAroundMedia(range, container) {
  if (!range || !container?.querySelectorAll) return [range];
  const mediaNodes = [...container.querySelectorAll(TEXT_HIGHLIGHT_MEDIA_SELECTOR)]
    .filter((el) => range.intersectsNode(el) && !el.closest(".text-highlight"))
    .sort((a, b) => (
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    ));
  if (!mediaNodes.length) return [range];
  const ranges = [];
  const before = document.createRange();
  try {
    before.setStart(range.startContainer, range.startOffset);
    before.setEndBefore(mediaNodes[0]);
  } catch { return [range]; }
  if (!before.collapsed) ranges.push(before);
  const after = document.createRange();
  try {
    after.setStartAfter(mediaNodes[mediaNodes.length - 1]);
    after.setEnd(range.endContainer, range.endOffset);
  } catch { /* keep whatever the before-side produced */ }
  if (!after.collapsed) ranges.push(after);
  // Both sides collapsed → nothing textual was selected. Fall back to the
  // original range so the click isn't a silent no-op.
  return ranges.length ? ranges : [range];
}

// --- Legacy highlight repair -------------------------------------------------
// Highlights saved before the per-text-node fix may contain partial block
// elements (e.g. <mark>…<p class="study-text-line">振</p></mark>) which render
// as blocks and shatter the line layout. sanitizeTextHighlightHtml rewrites
// such marks into pure inline marks and merges the fragments back into their
// neighbouring paragraph blocks, restoring the original flow.
function sanitizeTextHighlightHtml(html) {
  if (!html || html.indexOf("text-highlight") === -1) return html;
  let current = html;
  // A few passes so that blocky marks nested inside other blocky marks also
  // get repaired (each pass only reaches the outermost layer).
  for (let pass = 0; pass < 3; pass += 1) {
    const template = document.createElement("template");
    template.innerHTML = current;
    let changed = false;
    template.content.querySelectorAll(".text-highlight").forEach((mark) => {
      if (repairBlockyTextHighlight(mark)) changed = true;
    });
    if (!changed) return current;
    current = template.innerHTML;
  }
  return current;
}

function repairBlockyTextHighlight(mark) {
  if (!mark.isConnected && !mark.parentNode) return false;
  // Trigger on either a classic block descendant OR a display-math wrapper —
  // display-math wrappers are <span> (not in BLOCK_SELECTOR), but they are
  // forced display:block by .study-text-line CSS, so wrapping them in <mark>
  // still shatters the line layout.
  if (
    !mark.querySelector(TEXT_HIGHLIGHT_BLOCK_SELECTOR)
    && !mark.querySelector(TEXT_HIGHLIGHT_DISPLAY_SELECTOR)
  ) return false;
  const color = mark.dataset.highlightColor
    || TEXT_HIGHLIGHT_COLORS.find((c) => mark.classList.contains(`text-highlight-${c}`))
    || "yellow";
  const makeMark = () => makeTextHighlightMark(color);

  // Rebuild the mark's children into "parts": block children keep their block
  // wrapper (with inline runs re-highlighted inside); consecutive inline
  // content is grouped into a single inline mark. Whitespace-only text between
  // blocks is dropped — it was inter-block spacing, not content.
  const parts = [];
  let inlineBuffer = null;
  const flushInline = () => {
    if (inlineBuffer && inlineBuffer.childNodes.length) parts.push(inlineBuffer);
    inlineBuffer = null;
  };
  const fillBlock = (src, dest) => {
    [...src.childNodes].forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.nodeValue.trim()) {
          const m = makeMark();
          m.textContent = child.nodeValue;
          dest.append(m);
        } else {
          dest.append(document.createTextNode(child.nodeValue));
        }
      } else if (child.nodeType !== Node.ELEMENT_NODE) {
        // skip comments etc.
      } else if (child.matches(".text-highlight")) {
        dest.append(child.cloneNode(true)); // existing inline highlight: keep as-is
      } else if (child.matches(TEXT_HIGHLIGHT_DISPLAY_SELECTOR)) {
        // Display-math wrappers stay whole — we will tint them below instead
        // of cloning them with their inner runs re-highlighted.
        dest.append(child.cloneNode(true));
      } else if (child.querySelector(TEXT_HIGHLIGHT_BLOCK_SELECTOR)) {
        const clone = child.cloneNode(false);
        fillBlock(child, clone);
        dest.append(clone);
      } else {
        const m = makeMark();
        m.append(child.cloneNode(true));
        dest.append(m);
      }
    });
  };
  const isDisplayMath = (node) => (
    node?.nodeType === Node.ELEMENT_NODE && node.matches(TEXT_HIGHLIGHT_DISPLAY_SELECTOR)
  );
  [...mark.childNodes].forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE && !child.nodeValue.trim()) return;
    if (child.nodeType === Node.ELEMENT_NODE && (child.matches(TEXT_HIGHLIGHT_BLOCK_SELECTOR) || isDisplayMath(child))) {
      flushInline();
      const block = child.cloneNode(false);
      fillBlock(child, block);
      parts.push(block);
    } else if (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.ELEMENT_NODE) {
      if (!inlineBuffer) inlineBuffer = makeMark();
      inlineBuffer.append(child.cloneNode(true));
    }
  });
  flushInline();
  if (!parts.length) { mark.remove(); return true; }

  const isMergeableInto = (part, block) => (
    part.nodeType === Node.ELEMENT_NODE
    && (part.matches(".text-highlight") || (part.matches(TEXT_HIGHLIGHT_BLOCK_SELECTOR) && part.tagName === block.tagName))
  );
  const moveChildren = (src, dest, prepend) => {
    const nodes = [...src.childNodes];
    nodes.forEach((n) => (prepend ? dest.insertBefore(n, dest.firstChild) : dest.append(n)));
  };

  const prev = mark.previousElementSibling;
  const next = mark.nextElementSibling;
  // First part of a multi-block mark is the tail fragment of the previous
  // paragraph → merge it back. (For single-part marks the head-fragment case
  // below is far more common, so prefer merging forward.)
  if (parts.length >= 2 && prev?.matches(TEXT_HIGHLIGHT_BLOCK_SELECTOR) && isMergeableInto(parts[0], prev)) {
    moveChildren(parts.shift(), prev, false);
  }
  // Last part is the head fragment of the following paragraph → merge forward.
  if (parts.length && next?.matches(TEXT_HIGHLIGHT_BLOCK_SELECTOR) && isMergeableInto(parts[parts.length - 1], next)) {
    moveChildren(parts.pop(), next, true);
  } else if (parts.length === 1 && prev?.matches(TEXT_HIGHLIGHT_BLOCK_SELECTOR) && isMergeableInto(parts[0], prev)) {
    moveChildren(parts.pop(), prev, false);
  }
  mark.replaceWith(...parts);
  // Display-math wrappers escape as parts → tint them with the mark's colour.
  parts.forEach((part) => {
    if (!isDisplayMath(part)) return;
    // Drop any inner mark we accidentally cloned from inside the wrapper so the
    // tinted background is the only highlight visible.
    part.querySelectorAll(".text-highlight").forEach((m) => {
      const frag = document.createDocumentFragment();
      while (m.firstChild) frag.append(m.firstChild);
      m.replaceWith(frag);
    });
    paintTextHighlightDisplay(part, color);
  });
  return true;
}

function clearSelectedTextHighlight(range, container) {
  const selectedMarks = [...container.querySelectorAll(".text-highlight")].filter((mark) => range.intersectsNode(mark));
  selectedMarks.forEach((mark) => {
    const fragment = document.createDocumentFragment();
    while (mark.firstChild) fragment.append(mark.firstChild);
    mark.replaceWith(fragment);
  });
  // Also clear block-level tints applied to display-math wrappers.
  const selectedDisplays = [...container.querySelectorAll(`.${TEXT_HIGHLIGHT_DISPLAY_CLASS}`)]
    .filter((el) => range.intersectsNode(el));
  selectedDisplays.forEach((el) => {
    el.classList.remove(TEXT_HIGHLIGHT_DISPLAY_CLASS);
    TEXT_HIGHLIGHT_COLORS.forEach((c) => el.classList.remove(`text-highlight-display-${c}`));
    delete el.dataset.highlightColor;
  });
}

function saveTextHighlightContainer(container) {
  const scope = container.dataset.highlightScope;
  if (!scope || !state.currentProjectId) return;
  state.textHighlights[scope] = {
    baseHash: container.dataset.highlightBase,
    html: container.innerHTML,
  };
  saveTextHighlights();
}

function hideTextHighlightToolbar() {
  $("#text-highlight-toolbar")?.classList.add("hidden");
  state.activeHighlight = null;
}

function loadTextHighlights(projectId) {
  try {
    return JSON.parse(localStorage.getItem(TEXT_HIGHLIGHT_STORAGE_PREFIX + projectId) || "{}");
  } catch {
    return {};
  }
}

function saveTextHighlights() {
  if (!state.currentProjectId) return;
  try {
    localStorage.setItem(TEXT_HIGHLIGHT_STORAGE_PREFIX + state.currentProjectId, JSON.stringify(state.textHighlights || {}));
  } catch { /* Storage may be unavailable. */ }
}

function saveShownSourceMessageIds() {
  if (!state.currentProjectId) return;
  try {
    localStorage.setItem(SHOWN_SOURCE_STORAGE_PREFIX + state.currentProjectId, JSON.stringify([...state.shownSourceMessageIds]));
  } catch { /* Storage may be unavailable. */ }
}

function highlightColorLabel(color) {
  return { yellow: "黄色高亮", green: "绿色高亮", red: "红色高亮", blue: "蓝色高亮", purple: "紫色高亮", none: "无色高亮" }[color] || "文本高亮";
}

function highlightColorText(color) {
  return { yellow: "黄色", green: "绿色", red: "红色", blue: "蓝色", purple: "紫色", none: "无色" }[color] || "文本";
}

function hashString(value) {
  let hash = 0;
  const text = String(value ?? "");
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function cssEscape(value) {
  if (window.CSS?.escape) return CSS.escape(String(value));
  return String(value).replace(/["\\]/g, "\\$&");
}

function renderEmptyOutput(title, description) {
  hideTextHighlightToolbar();
  $("#studio-output").innerHTML = `<div class="output-empty"><span class="compass">⌘</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p></div>`;
}

function nodePalette(node) {
  if (["insufficient_source", "missing_prerequisite", "uncovered"].includes(node.coverage_status)) return { fill: "#f8e1df", stroke: "#c75c5c", lit: "blocked" };
  // 知识点点亮图：灰（未点亮）→ 蓝（学习中）→ 金（已点亮）。
  // 让"学到哪、亮到哪"一眼可见，比单纯的状态标签更有推进感。
  const score = Number(node.mastery_score) || 0;
  // 学术极简使用蓝灰状态色，避免经典工作台的绿色节点与冷色纸面冲突。
  if (usesCoolPalette()) {
    if (node.learning_status === "mastered" || score >= 0.8) return { fill: "#e4ecff", stroke: "#3457e8", lit: "lit" };
    if (score >= 0.35 && ["learning", "pending_confirmation"].includes(node.learning_status)) return { fill: "#eaf1ff", stroke: "#6b8de0", lit: "partial" };
    if (node.learning_status === "encountered") return { fill: "#f0f3f8", stroke: "#9aa8bd", lit: "partial" };
    return { fill: "#f7f9fc", stroke: "#c5cfde", lit: "dim" };
  }
  if (node.learning_status === "mastered" || score >= 0.8) return { fill: "#fdf0c8", stroke: "#d4a843", lit: "lit" };
  if (score >= 0.35 && ["learning", "pending_confirmation"].includes(node.learning_status)) return { fill: "#dbeafe", stroke: "#4f8cff", lit: "partial" };
  if (node.learning_status === "encountered") return { fill: "#edf2e9", stroke: "#8caf80", lit: "partial" };
  return { fill: "#f4f1ea", stroke: "#c7bfb2", lit: "dim" };
}

function statusLabel(node) {
  const coverage = { uncovered: "未覆盖", covered: "来源覆盖", insufficient_source: "来源不足", missing_prerequisite: "缺前置知识" };
  const learning = { unexplored: "未探索", encountered: "已遇到", pending_confirmation: "待确认", learning: "学习中", mastered: "已掌握" };
  return node.coverage_status === "covered" ? learning[node.learning_status] : coverage[node.coverage_status];
}

function sourceStatus(source) {
  const labels = { ok: "已解析", empty: "未提取到文本", unsupported: "不支持", parse_error: "解析失败", ocr_unavailable: "缺少 OCR" };
  const label = labels[source.status] || source.status;
  const error = source.status !== "ok";
  // 带上具体错误信息，供前端展示 tooltip 或详情
  const detail = error && source.error_message ? source.error_message : null;
  return { label, error, detail };
}

// 判断错误是不是「还没配置 AI 模型密钥」这一类——此时正确的下一步是去配置，而不是重试。
function isApiConfigError(error) {
  if (!error) return false;
  if (["missing_api_key", "api_key_required", "model_auth_failed"].includes(error.code)) return true;
  const msg = String(error.message || "");
  return /未配置|API\s*Key|TJU_API_KEY/.test(msg);
}

// 知识库整理助手 / 苏格拉底引导里的内联报错：命中「未配置密钥」时额外挂一个「去配置」按钮。
function kbErrHtml(message) {
  const text = message || "请求失败";
  let html = `<div class="kb-err">${escapeHtml(text)}</div>`;
  if (isApiConfigError({ message: text })) {
    html += `<div class="kb-graph-jump"><button type="button" data-kb-action="open-api-config">⚙ 去配置 API Key</button></div>`;
  }
  return html;
}

function showError(error, retryAction = null) {
  state.retryAction = retryAction;
  $("#error-banner").classList.remove("is-notice");
  const retryButton = $("#retry-button");
  if (isApiConfigError(error)) {
    // 还没配密钥：把「重试」换成「去配置」，直接把用户带到 API 配置弹窗
    $("#error-message").textContent = "还没有配置 AI 模型密钥，AI 功能暂不可用。请填入你自己的 API Key。";
    state.retryAction = openApiConfig;
    retryButton.textContent = "去配置 API";
    retryButton.classList.remove("hidden");
  } else {
    $("#error-message").textContent = error.message || "发生未知错误。";
    retryButton.textContent = "重试";
    retryButton.classList.toggle("hidden", !retryAction);
  }
  $("#error-banner").classList.remove("hidden");
}

function showNotice(message) {
  state.retryAction = null;
  $("#error-banner").classList.add("is-notice");
  $("#error-message").textContent = message || "操作已完成。";
  $("#retry-button").classList.add("hidden");
  $("#error-banner").classList.remove("hidden");
}

function hideError() {
  $("#error-banner").classList.add("hidden");
  $("#error-banner").classList.remove("is-notice");
  state.retryAction = null;
}

function formatBytes(bytes) {
  if (!Number.isFinite(Number(bytes)) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function extensionLabel(name) {
  return ((name.split(".").pop() || "TXT").toUpperCase()).slice(0, 4);
}

function truncate(value, length) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function escapeAttr(value) { return escapeHtml(value); }

// ---------------------------------------------------------------------------
// 「导入」按钮：从 cs.tjuse.com 拉取课程目录下选中的资料
// 入口：新建课程 dialog 下拉项右侧的「导入」标签（course-autocomplete.js）
// 关键流程：
//   1) 选课名下拉项 → 触发 onImportTju 回调 → 弹出"导入 dialog"
//   2) dialog 里展示该课程目录的全部文件，按 kind 分组、默认勾选 README/PDF/PPTX/DOCX
//   3) 用户确认 → 先 POST /api/projects 创建项目（后端会自动 README 一次），
//      再 POST /api/projects/{id}/sources/import-tju-folder 批量入库（include_readme=false
//      避免 README 重复入库）→ selectProject 跳进新项目
// 版权：UI 上已加风险提示，回调内部假定用户已明示确认，开发者不为版权后果负责。
// ---------------------------------------------------------------------------
const TJU_KIND_ORDER = ["pdf", "pptx", "ppt", "docx", "doc", "image", "text", "other"];
const TJU_KIND_LABEL = {
  pdf: "PDF",
  pptx: "PPTX",
  ppt: "PPT",
  docx: "DOCX",
  doc: "DOC",
  image: "图片",
  text: "文本",
  other: "其它",
};

function setupTjuImportDialog() {
  // 注入回调，让 course-autocomplete.js 的「导入」标签能调到这边
  window.tjuAutocomplete = window.tjuAutocomplete || {};
  window.tjuAutocomplete.onImportTju = openTjuImportDialog;

  const dialog = $("#tju-import-dialog");
  if (!dialog) return;
  const form = $("#tju-import-form");
  const list = dialog.querySelector(".tju-import-list");
  const summary = dialog.querySelector(".tju-import-summary");
  const courseLabel = dialog.querySelector(".tju-import-course");

  // 暴露给回调；保留上次选中的课程信息，dialog 重开时仍能恢复
  let pendingCourse = null;
  // 导入进行中标记：锁定弹窗，禁止取消 / ESC 关闭
  let importing = false;
  dialog.addEventListener("cancel", (e) => {
    if (importing) e.preventDefault();
  });
  dialog.addEventListener("tju-retry", () => {
    if (pendingCourse) refreshFiles(pendingCourse);
  });

  async function refreshFiles(course) {
    if (!course || !course.code) {
      courseLabel.textContent = "";
      list.textContent = "";
      summary.textContent = "";
      return;
    }
    courseLabel.textContent =
      `课程：${course.code} ${course.name}（${disciplineTag(course.discipline)}）` +
      ` · 数据源：cs.tjuse.com`;
    list.textContent = "";
    summary.innerHTML = '<span class="tju-loading-spinner"></span> 正在拉取文件清单…';
    let slowTimer = 0;
    slowTimer = window.setTimeout(() => {
      summary.innerHTML = '<span class="tju-loading-spinner"></span> 目录较深，仍在遍历子文件夹…';
    }, 3000);
    try {
      const res = await fetch(
        `/api/tju-courses/${encodeURIComponent(course.code)}/files`,
        { credentials: "same-origin" }
      );
      window.clearTimeout(slowTimer);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        summary.innerHTML = `<span style="color:#c75c5c">${escapeHtml(data.reason || "拉取失败")}</span> <button class="ghost-button" type="button" style="font-size:calc(11px * var(--font-scale, 1));margin-left:6px" onclick="document.querySelector('#tju-import-dialog').dispatchEvent(new Event('tju-retry'))">重试</button>`;
        return;
      }
      pendingTree = data.tree || [];
      pendingDir = data.dir || "";
      if (!pendingTree.length) {
        summary.innerHTML = `该课程目录下暂无资料，请到 <a href="https://cs.tjuse.com" target="_blank" rel="noopener">cs.tjuse.com</a> 自行浏览。 <button class="ghost-button" type="button" style="font-size:calc(11px * var(--font-scale, 1));margin-left:6px" onclick="document.querySelector('#tju-import-dialog').dispatchEvent(new Event('tju-retry'))">重试</button>`;
        return;
      }
      renderTjuFileTree(pendingTree);
      updateTjuSummary();
    } catch (err) {
      window.clearTimeout(slowTimer);
      summary.textContent = "网络异常：" + (err && err.message ? err.message : err);
    }
  }

  let pendingTree = [];
  let pendingDir = "";

  function disciplineTag(disc) {
    return ({
      humanities: "文科",
      economics_management: "经管",
      medicine_biology: "医/生",
    })[disc] || "理工";
  }

  // 树状渲染：文件夹可展开/折叠
  function renderTjuFileTree(tree, parentEl) {
    const container = parentEl || list;
    if (!parentEl) container.textContent = "";
    tree.forEach((node) => {
      if (node.type === "dir") {
        renderFolderNode(node, container);
      } else {
        renderFileNode(node, container, 0);
      }
    });
  }

  function renderFolderNode(node, container) {
    const wrap = document.createElement("details");
    wrap.className = "tju-import-folder";
    wrap.open = true;
    const summaryEl = document.createElement("summary");
    summaryEl.className = "tju-import-folder-summary";
    const icon = document.createElement("span");
    icon.className = "tju-folder-icon";
    icon.textContent = "\ud83d\udcc1";
    summaryEl.appendChild(icon);
    const name = document.createElement("span");
    name.className = "tju-folder-name";
    name.textContent = node.name;
    summaryEl.appendChild(name);
    const count = document.createElement("span");
    count.className = "tju-folder-count";
    const fileCount = countFilesInTree(node.children || []);
    count.textContent = `${fileCount} 个文件`;
    summaryEl.appendChild(count);
    wrap.appendChild(summaryEl);
    const childrenWrap = document.createElement("div");
    childrenWrap.className = "tju-import-folder-children";
    (node.children || []).forEach((child) => {
      if (child.type === "dir") {
        renderFolderNode(child, childrenWrap);
      } else {
        renderFileNode(child, childrenWrap, 1);
      }
    });
    wrap.appendChild(childrenWrap);
    container.appendChild(wrap);
  }

  function renderFileNode(f, container, depth) {
    const row = document.createElement("label");
    row.className = "tju-import-row" + (f.is_readme ? " is-readme" : "");
    if (depth > 0) row.classList.add("is-nested");
    const kindTag = `<span class="tju-import-kind tag-${f.kind}">${TJU_KIND_LABEL[f.kind] || f.kind}</span>`;
    row.innerHTML =
      `<input type="checkbox" value="${escapeAttr(f.path)}">` +
      kindTag +
      `<span class="tju-import-name">${escapeHtml(f.name)}</span>` +
      `<span class="tju-import-meta">${formatBytes(f.size_bytes)}</span>`;
    container.appendChild(row);
  }

  function countFilesInTree(tree) {
    let n = 0;
    tree.forEach((node) => {
      if (node.type === "file") n += 1;
      else if (node.type === "dir") n += countFilesInTree(node.children || []);
    });
    return n;
  }

  function updateTjuSummary() {
    const checked = list.querySelectorAll("input[type=checkbox]:checked");
    const total = list.querySelectorAll("input[type=checkbox]").length;
    if (!total) { summary.textContent = ""; return; }
    summary.textContent = `已选 ${checked.length}/${total} 项`;
  }

  list.addEventListener("change", (e) => {
    const cb = e.target.closest("input[type=checkbox]");
    if (!cb) return;
    updateTjuSummary();
  });

  // 导入按钮：用 click 而非 form submit，避免 method="dialog" 提前关弹窗
  form.querySelector("[data-action=import-selected]").addEventListener("click", async () => {
    const projectTerm = $("#project-term").value.trim();
    const projectSubject = $("#project-subject").value.trim();
    if (!projectSubject) {
      showError(new Error("请先在「建立独立项目」对话框里填写项目名称。"));
      return;
    }
    // 只取文件 checkbox（文件夹已无勾选框，此处即全部文件勾选）
    const checked = Array.from(list.querySelectorAll("input[type=checkbox]:checked"));
    if (!checked.length) {
      showError(new Error("请至少勾选一个文件，或直接取消。"));
      return;
    }
    const btn = form.querySelector("[data-action=import-selected]");
    const cancelBtn = form.querySelector("[data-dialog-cancel]");
    const closeBtn = dialog.querySelector(".close-dialog");
    const progressEl = $("#tju-import-progress");
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add("is-loading");
    btn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span> 导入中…';
    cancelBtn.disabled = true;
    closeBtn.disabled = true;
    importing = true;
    const restore = () => {
      btn.disabled = false;
      btn.classList.remove("is-loading");
      btn.innerHTML = original;
      cancelBtn.disabled = false;
      closeBtn.disabled = false;
      importing = false;
      if (progressEl) progressEl.classList.add("hidden");
    };
    let pollTimer = 0;
    const stopPoll = () => { window.clearInterval(pollTimer); pollTimer = 0; };
    try {
      // 1) 创建项目
      const project = await api("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ year: projectTerm, subject: projectSubject }),
      });
      const paths = checked.map((c) => c.value).filter((p) => p && !p.toLowerCase().endsWith("/readme.md"));
      const totalFiles = paths.length;

      // 2) 显示进度条并启动轮询
      if (progressEl) {
        progressEl.classList.remove("hidden");
        const strong = progressEl.querySelector("strong");
        const span = progressEl.querySelector("span");
        const track = progressEl.querySelector("i");
        const stageP = progressEl.querySelector(".tju-import-progress-stage");
        const fileP = progressEl.querySelector(".tju-import-progress-file");
        const noteEl = progressEl.querySelector(".tju-import-progress-note");
        if (strong) strong.textContent = `正在从课程共享站下载文件（0/${totalFiles}）`;
        if (span) span.textContent = "0%";
        if (track) track.style.width = "0%";
        if (stageP) stageP.textContent = "阶段：准备下载";
        if (fileP) fileP.textContent = "准备中…";
        if (noteEl) noteEl.classList.add("hidden");
      }
      pollTimer = window.setInterval(async () => {
        try {
          const pg = await api(`/api/projects/${encodeURIComponent(project.project_id)}/sources/import-tju-folder/progress`);
          if (!pg || pg.status === "idle") return;
          const pct = pg.total > 0 ? Math.round((pg.completed / pg.total) * 100) : 0;
          if (progressEl) {
            const strong = progressEl.querySelector("strong");
            const span = progressEl.querySelector("span");
            const track = progressEl.querySelector("i");
            const stageP = progressEl.querySelector(".tju-import-progress-stage");
            const fileP = progressEl.querySelector(".tju-import-progress-file");
            const noteEl = progressEl.querySelector(".tju-import-progress-note");
            if (strong) strong.textContent = `正在从课程共享站下载文件（${pg.completed}/${pg.total}）`;
            if (span) span.textContent = `${pct}%`;
            if (track) track.style.width = `${pct}%`;
            if (stageP) stageP.textContent = pg.stage_label ? `阶段：${pg.stage_label}` : "处理中…";
            if (fileP) fileP.textContent = pg.current_file ? `正在处理：${pg.current_file}` : "处理中…";
            if (noteEl) {
              const curFile = pg.current_file || "";
              if (pg.ocr_used && curFile) {
                noteEl.textContent = `「${curFile}」为扫描件，需要逐页 OCR 识别，可能需等待数分钟，请不要关闭窗口。`;
                noteEl.classList.remove("hidden");
              } else if (pg.current_kind && curFile) {
                const sizeText = Number(pg.current_size_bytes) > 0
                  ? `（约 ${formatBytes(Number(pg.current_size_bytes))}）`
                  : "";
                noteEl.textContent = `「${curFile}」为${pg.current_kind}${sizeText}，正在解析内容，请稍候。`;
                noteEl.classList.remove("hidden");
              } else {
                noteEl.classList.add("hidden");
              }
            }
          }
        } catch (_) { /* 轮询失败不影响导入 */ }
      }, 800);

      // 3) 批量拉勾选文件
      const data = await api(
        `/api/projects/${encodeURIComponent(project.project_id)}/sources/import-tju-folder`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: pendingCourse && pendingCourse.code,
            name: pendingCourse && pendingCourse.name,
            paths,
            include_readme: false,
            include_linked: true,
          }),
        }
      );
      stopPoll();
      // 进度条填满
      if (progressEl) {
        const strong = progressEl.querySelector("strong");
        const span = progressEl.querySelector("span");
        const track = progressEl.querySelector("i");
        const stageP = progressEl.querySelector(".tju-import-progress-stage");
        const fileP = progressEl.querySelector(".tju-import-progress-file");
        const noteEl = progressEl.querySelector(".tju-import-progress-note");
        if (strong) strong.textContent = "导入完成";
        if (span) span.textContent = "100%";
        if (track) track.style.width = "100%";
        if (stageP) stageP.textContent = "阶段：导入完成";
        if (fileP) fileP.textContent = `成功 ${data.imported || 0} / 跳过 ${data.skipped || 0} / 失败 ${data.failed || 0}`;
        if (noteEl) noteEl.classList.add("hidden");
      }
      // 4) 关闭 dialog、加入项目列表、跳进新项目
      state.projects.unshift(project);
      dialog.close();
      $("#project-dialog").close();
      $("#project-form").reset();
      state.currentProjectId = project.project_id;
      renderProjectSelect();
      await selectProject(project.project_id);
      const msg = `导入完成：成功 ${data.imported || 0} / 跳过 ${data.skipped || 0} / 失败 ${data.failed || 0}` +
        (data.results && data.results.length ? "（详见左边来源列表）" : "");
      showToast(msg, { variant: "notice" });
    } catch (err) {
      stopPoll();
      showError(err);
    } finally {
      restore();
    }
  });

  // 暴露给 onImportTju 回调使用
  async function openTjuImportDialog(course) {
    pendingCourse = course;
    dialog.showModal();
    await refreshFiles(course);
  }
  // 上面 openTjuImportDialog 已在 setupTjuImportDialog 内部 hoist 到顶；
  // 但顶部那一行只是占位声明，替换为真实实现。
  window.tjuAutocomplete.onImportTju = openTjuImportDialog;
  return openTjuImportDialog;
}

// showToast 简易封装 —— 给导入流程"成功 X / 跳过 Y"等短提示用
function showToast(message, opts) {
  // 复用 toast undo-notice 容器（如有）；fallback 到 error-banner。
  // 注意：绝不能给容器整体写 textContent——那会把 #undo-message / #error-message
  // 等内层节点整个替换掉，随后 showUndoNotice / showError 再取它们就拿到 null 崩掉。
  const undo = $("#undo-toast");
  const msgEl = $("#undo-message");
  if (undo && msgEl) {
    msgEl.textContent = message;
    $("#undo-button")?.classList.add("hidden");
    if (opts && opts.variant === "notice") undo.classList.add("is-notice");
    undo.classList.remove("hidden");
    setTimeout(() => undo.classList.add("hidden"), 4000);
    return;
  }
  const banner = $("#error-banner");
  const errMsg = $("#error-message");
  if (banner && errMsg) {
    errMsg.textContent = message;
    $("#retry-button")?.classList.add("hidden");
    banner.classList.remove("hidden");
    banner.classList.add("is-notice");
    setTimeout(() => banner.classList.add("hidden"), 4000);
  }
}
