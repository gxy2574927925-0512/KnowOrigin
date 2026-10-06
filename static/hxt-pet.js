/* =====================================================
   海小棠桌宠 (Hai Xiaotang Pet) · 透明浮空 + 多锚点吸附 · 知源 KnowOrigin
   ------------------------------------------------------
   核心能力：
   1. 不限制在方框：透明PNG形象，自由浮空/拖拽、吸附到多个锚点
   2. 多锚点吸附系统：
      - 右上锚点（连学火苗旁）：陪伴/状态，露出头像
      - 左下锚点（输入框旁）：答疑/主动服务
      - 引导模式：感知 kbAgentMode=guide，趴到不挡视线的位置
      - 自由拖拽：可全屏任意拖动，松开后自动吸附回最近锚点
   3. 交互（用户选择"两者结合"）：
      - 点击桌宠 → 弹出轻量功能选项卡（校情/进度/陪聊/休息）
      - 头顶常驻小按钮 → 一键打开「专属聊天框」（静音时图标变 🔇）
      - 深度问答 → 复用主界面 SSE 对话（填入 #message-input 并触发发送）
   4. 连贯表情动作：状态机决定 attitude（站立/趴窝/睡眠/互动）+ 呼吸/摇摆动画
   5. 音效：Web Audio 轻量合成（点按/吸附/关怀提示），无外部资源
   6. 静音模式：一键关掉「自动气泡 + 音效」，你主动搭话她仍会回文字
   7. 平时气泡节奏：BUBBLE_GOV 闸门统一限流（默认最快 4 分钟一条、每小时至多 5 条），
      内容以天大校史校情为主（北洋故事 / 天大知识 / 校园生活 / 常见问答，共 40+ 条，
      全部离线可讲，不依赖联网）
   8. 校内资讯：向后端 /api/hxt/campus 查询（北洋维基 + 微北洋数据源），
      入口在功能选项卡和聊天框首屏快捷区里，结果以气泡/对话形式返回
   ------------------------------------------------------
   与主应用解耦：通过 CustomEvent 接收 knoworigin:pet-login / knoworigin:pet-project；
   引导模式通过轮询 window 上暴露的桥接对象感知（见 app.js 注入的 hxtBridge）。
   设置面板里的「海小棠静音模式」开关由本文件自行注入，
   不改动 app.js / index.html 的逻辑。
   ===================================================== */
(function () {
  if (window.__hxtPetReady) return;
  window.__hxtPetReady = true;

  var CONF = {
    storeKey: "knoworigin_hxt_pet_v2",
    pollStreakMs: 60000,
    pollMasteryMs: 90000,
    idleTalkMs: 45 * 60 * 1000,
    sound: true,
    // —— 平时气泡节奏（用户反馈"太吵"，这里统一收口） ——
    bubbleMinGapMs: 4 * 60 * 1000,  // 两条自动气泡之间的最小间隔
    bubbleMaxPerHour: 5,            // 每小时自动气泡上限
  };
  var IMG = {
    stand: "/static/img/hxt/png/filled/pet_sit.png",
    happy: "/static/img/hxt/png/filled/pet_happy.png",
    think: "/static/img/hxt/png/filled/pet_think.png",
    rest:  "/static/img/hxt/png/filled/pet_rest.png",
    sleep: "/static/img/hxt/png/filled/pet_sleep.png",
    shy:   "/static/img/hxt/png/filled/pet_shy.png",
    clutch:"/static/img/hxt/png/filled/pet_clutch.png",
  };

  // ================= 逐帧连续动画：高清插画海小棠图集 =================
  // 加载 sprite-manifest 用 setInterval 逐帧切换，让海小棠不是静态图 +
  // CSS 位移，而是真正"呼吸、眨眼、跳动"的连续动画。
  //
  // 形象皮肤（逐帧图集，每动作 6 帧真·逐帧，content-trimmed）：
  //   fairy  海棠花仙 —— 粉色大花瓣花冠 + 粉瓣裙（照天大海棠官方吉祥物设计，默认）
  //   bloom  海棠绽放 —— 浓艳海棠红发 + 大花瓣 + 粉裙
  //   legacy 粉发蓝衫 —— 初版形象存档
  // 切换：localStorage.setItem('knoworigin_hxt_skin','bloom') 后刷新，
  //       或在控制台执行 HXT_PET.setSkin('bloom')。
  var SKINS = {
    fairy:  { label: "海棠花仙 · 粉瓣花冠",  base: "/static/img/hxt/anime/v6/",        ver: "s20260910c" },
    bloom:  { label: "海棠绽放 · 花瓣红发",  base: "/static/img/hxt/anime/v5/",        ver: "s20260910b" },
    legacy: { label: "粉发蓝衫 · 初版存档",  base: "/static/img/hxt/anime/v5-legacy/", ver: "s20260910l" },
  };
  var DEFAULT_SKIN = "fairy";
  function currentSkin() {
    try {
      var k = localStorage.getItem("knoworigin_hxt_skin");
      return SKINS[k] ? k : DEFAULT_SKIN;
    } catch (e) { return DEFAULT_SKIN; }
  }
  var PIX = {
    skin: currentSkin(),
    // 帧图放在全新 v5 / v5-legacy 目录：URL 与旧版完全不同，任何浏览器/
    // 代理/SW 里残留的旧副本（曾出现过被压成黑底的副本）都不可能再被命中
    manifestUrl: SKINS[currentSkin()].base + "sprite-manifest.json?v=" + SKINS[currentSkin()].ver,
    base: SKINS[currentSkin()].base,
    ver: SKINS[currentSkin()].ver,
    loaded: false,
    actions: {},
    action: null,
    idx: 0,
    timer: null,
  };
  // ================= 透明通道自愈（黑底兜底） =================
  // 症状：个别环境下帧图被压扁，透明区变纯黑 → 桌宠出现黑底方块。
  // 兜底：canvas 检测四角是否为「不透明纯黑」，是则把纯黑像素 alpha 置 0，
  //      生成 blob URL 顶替。alpha 正常时零开销（只探针 7 张）。
  var HEALED = {}; // 原始路径 -> blob URL
  function frameUrl(p) { return HEALED[p] || (PIX.base + p + "?v=" + PIX.ver); }
  function loadImg(src) {
    return new Promise(function (res, rej) {
      var i = new Image();
      i.onload = function () { res(i); };
      i.onerror = rej;
      i.src = src;
    });
  }
  function drawTo(img) {
    var c = document.createElement("canvas");
    c.width = img.naturalWidth || 1; c.height = img.naturalHeight || 1;
    var x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(img, 0, 0);
    return { c: c, x: x };
  }
  // 四角都是「不透明纯黑」→ 判定 alpha 已丢失
  function isFlattened(img) {
    try {
      var d = drawTo(img);
      var w = d.c.width, h = d.c.height, data = d.x.getImageData(0, 0, w, h).data;
      var idxs = [0, (w - 1) * 4, (h - 1) * w * 4, (h * w - 1) * 4];
      for (var k = 0; k < idxs.length; k++) {
        var o = idxs[k];
        if (!(data[o + 3] > 240 && data[o] < 12 && data[o + 1] < 12 && data[o + 2] < 12)) return false;
      }
      return true;
    } catch (e) { return false; }
  }
  function healOne(p) {
    return loadImg(PIX.base + p + "?v=" + PIX.ver).then(function (img) {
      var d = drawTo(img), imgd = d.x.getImageData(0, 0, d.c.width, d.c.height), px = imgd.data;
      for (var i = 0; i < px.length; i += 4) {
        // 只抠纯黑/近黑背景（阈值 26），角色黑色描边内部混有过渡色，不会被误伤到整体
        if (px[i] < 26 && px[i + 1] < 26 && px[i + 2] < 26) px[i + 3] = 0;
      }
      d.x.putImageData(imgd, 0, 0);
      return new Promise(function (res) {
        try {
          d.c.toBlob(function (b) { if (b) HEALED[p] = URL.createObjectURL(b); res(); }, "image/png");
        } catch (e) { res(); }
      });
    }).catch(function () {});
  }
  function healFrames(m) {
    try {
      var probe = m.actions.map(function (a) { return a.frames[0]; });
      return Promise.all(probe.map(function (p) {
        return loadImg(PIX.base + p + "?v=" + PIX.ver).then(isFlattened).catch(function () { return false; });
      })).then(function (res) {
        if (!res.some(Boolean)) return; // alpha 正常 → 不做任何处理
        var jobs = [];
        m.actions.forEach(function (a) {
          a.frames.forEach(function (p) { if (p && !HEALED[p]) jobs.push(healOne(p)); });
        });
        return Promise.all(jobs).then(function () {
          var cur = PIX.actions[PIX.action];
          if (els.img && cur) els.img.src = frameUrl(cur.frames[0]); // 立即换上自愈后的帧
        });
      });
    } catch (e) { return Promise.resolve(); }
  }
  // 旧姿态名 -> 图集动作名；图集未就绪时回退到静态 IMG
  // 默认待机姿势：两只爪子扒着对话边缘，只眨眼不乱动
  var DEFAULT_POSTURE = "clutch";
  var PLAY_ACTION = {
    stand: "idle", crouch: "rest", sleep: "sleep", interact: "happy",
    clutch: "clutch", happy: "happy", think: "think", rest: "rest", shy: "shy",
    walk: "walk", run: "run", cry: "cry", angry: "angry", laugh: "laugh",
    wave: "wave", jump: "jump", surprised: "surprised", cheer: "cheer", love: "love",
  };
  function pixelReady() { return PIX.loaded && !!els.img; }
  function pixelType(name) {
    var a = PIX.actions[name];
    if (!a || !a.frames || !a.frames.length) return false;
    return a;
  }
  // ================= 矢量兜底形象（默认关闭） =================
  // 现在默认走「逐帧位图」通路：v5 图集的 alpha 通道干净、无黑底无切割，
  // 而且是真·6 帧动画，表现力比矢量好得多。
  // 若某个环境仍然把位图渲染坏，可用矢量兜底：
  //   localStorage.setItem('knoworigin_hxt_vector','1') 后刷新。
  function vecOn() {
    try { return localStorage.getItem("knoworigin_hxt_vector") === "1" && !!window.HXT_SPRITE; }
    catch (e) { return false; }
  }
  // 画一个动作：返回 true 表示已用矢量渲染
  function drawPose(action) {
    if (!vecOn() || !els.vec) return false;
    var S = window.HXT_SPRITE;
    var a = S.poses.indexOf(action) >= 0 ? action : "clutch";
    if (els.vec.getAttribute("data-pose") !== a) {
      els.vec.innerHTML = S.svg(a);
      els.vec.setAttribute("data-pose", a);
    }
    if (els.img) els.img.style.display = "none"; // 位图让位
    vecFit();
    return true;
  }
  // 矢量尺寸：严格按 viewBox 比例，任何动作同宽高
  function vecFit() {
    if (!els.vec || !els.wrap) return;
    var S = window.HXT_SPRITE;
    var h = parseFloat(window.getComputedStyle(els.wrap).height) || 150;
    els.vec.style.height = h + "px";
    els.vec.style.width = Math.round(h * S.ratio) + "px";
  }
  // 矢量/位图当前可视节点（动画挂在这里）
  function vecNode() { return (vecOn() && els.vec) ? els.vec : els.img; }
  // 统一绘制入口：矢量（默认关）→ 逐帧图集 → 静态图兜底
  function paintPose(action, fallbackSrc) {
    if (drawPose(action)) return true;
    if (pixelReady() && pixelPlay(action)) return true;
    if (els.img && fallbackSrc) {
      els.img.style.display = "";
      els.img.src = fallbackSrc;
      if (els.vec) els.vec.style.display = "none";
    }
    return false;
  }
  // 让容器宽度贴合当前动作真实宽高比，消除角色四周透明"隐藏框"并收紧点击热区
  // 矢量模式：按统一 viewBox 比例；位图模式：按帧宽高比 + 6px 余量
  function fitWrap(name) {
    if (!els.wrap) return;
    if (vecOn()) { vecFit(); els.wrap.style.width = els.vec.style.width; if (!els.wrap.style.transformOrigin) els.wrap.style.transformOrigin = "50% 85%"; return; }
    var a = pixelType(name);
    var h = parseFloat(window.getComputedStyle(els.wrap).height) || 150;
    var w = (a && a.frame_w && a.frame_h) ? h * a.frame_w / a.frame_h : h * 0.52;
    els.wrap.style.width = (Math.max(24, Math.round(w)) + 6) + "px";
    if (!els.wrap.style.transformOrigin) els.wrap.style.transformOrigin = "50% 85%"; // 以身体下部为轴心
  }
  // 滑轨系统：海小棠始终"扒/站"在一条水平滑轨上 ——
  //  · 默认滑轨：中栏对话输入框(#composer)上边缘
  //  · 展开学习产出(studio focus)时：滑轨切到面板内容区(#studio-output)顶边，
  //    即功能导航条下方、知识卡/框架边框上（用户红框位置）
  //  y = 滑轨线；xMin/xMax = 轨道左右边界（爪子不离轨）
  function panelExpanded() {
    var b = document.getElementById("studio-expand-button");
    return !!(b && b.getAttribute("aria-expanded") === "true");
  }
  function panelTrackRect() {
    var sp = document.getElementById("studio-panel");
    var out = sp && sp.querySelector("#studio-output");
    if (!sp || !out) return null;
    var pr = sp.getBoundingClientRect();
    var or_ = out.getBoundingClientRect();
    if (pr.width < 10 || or_.height < 10 || or_.top < 10) return null;
    var w = container.offsetWidth || 120, h = container.offsetHeight || 150;
    // 展开态顶部空间有限：按可用高度缩放桌宠，保证头不顶出屏幕、不压功能 Tab；
    // 回到默认滑轨时恢复统一身高
    var avail = or_.top - 26;
    if (avail < h) {
      var nh = Math.max(88, Math.round(avail));
      if (Math.abs(parseFloat(els.wrap.style.height) || 0) !== nh) {
        els.wrap.style.height = nh + "px";
        fitWrap(PIX.action || "idle");
      }
      w = container.offsetWidth || 120; h = container.offsetHeight || nh;
    } else if (els.wrap.style.height) {
      els.wrap.style.height = "";
      fitWrap(PIX.action || "idle");
      w = container.offsetWidth || 120; h = container.offsetHeight || 150;
    }
    // 滑轨线 = 内容区(studio-output)顶边：站在功能导航条下方、知识卡/框架边框上，
    // 不再压住顶部功能 Tab 按钮
    return { y: or_.top - h + 8, xMin: pr.left + 8, xMax: Math.max(pr.left + 8, pr.right - w - 8) };
  }
  function trackRect() {
    if (panelExpanded()) { var p = panelTrackRect(); if (p) return p; }
    var _c = document.getElementById("composer");
    if (!_c) return null;
    var r = _c.getBoundingClientRect();
    if (r.height < 20) return null;
    // 回到默认滑轨：清掉展开态的缩放身高，恢复统一起始尺寸
    if (els.wrap && els.wrap.style.height) {
      els.wrap.style.height = "";
      fitWrap(PIX.action || "idle");
    }
    var w = container.offsetWidth || 120, h = container.offsetHeight || 150;
    return { y: r.top - h + 8, xMin: r.left - 6, xMax: Math.max(r.left, r.left + r.width - w + 6) };
  }
  function homeX(tr) {
    tr = tr || trackRect();
    if (!tr) return null;
    // 默认吸附位：轨道左端内侧（扒着边缘，不越界）
    return Math.max(tr.xMin, Math.min(tr.xMax, tr.xMin + 8 + 8));
  }
  // 姿态切换/尺寸变化后，把 x clamp 回轨道、y 重新贴回滑轨线
  // —— 修复"站起来就飘走、不吸附在聊天框滑轨上"的问题
  function snapRailY() {
    var tr = trackRect();
    if (!tr) return;
    st.x = Math.min(tr.xMax, Math.max(tr.xMin, st.x == null ? homeX(tr) : st.x));
    st.y = tr.y;
    container.style.left = st.x + "px";
    container.style.top = st.y + "px";
    container.style.right = "auto";
    container.style.bottom = "auto";
  }
  function pixelPlay(name) {
    if (vecOn()) return false; // 矢量模式下关闭位图通路
    var a = pixelType(name);
    if (!a || !pixelReady()) return false;
    if (PIX.action !== name) { PIX.action = name; PIX.idx = 0; }
    if (els.img) {
      els.img.style.display = "";           // 位图归位
      els.img.classList.add("hxt-hd");
      if (els.vec) els.vec.style.display = "none";
    }
    els.img.src = frameUrl(a.frames[0]);
    clearInterval(PIX.timer);
    PIX.timer = setInterval(function () {
      PIX.idx = (PIX.idx + 1) % a.frames.length;
      els.img.src = frameUrl(a.frames[PIX.idx]);
    }, a.frame_duration_ms || 150);
    fitWrap(name);
    return true;
  }
  function pixelBoot() {
    return fetch(PIX.manifestUrl, { credentials: "same-origin" })
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (m) {
        m.actions.forEach(function (a) {
          // 预载全部帧，避免切换时白屏闪烁
          a.frames.forEach(function (p) { var i = new Image(); i.src = frameUrl(p); });
        });
        PIX.actions = {};
        m.actions.forEach(function (a) { PIX.actions[a.name] = a; });
        PIX.loaded = true;
        if (els.img) els.img.classList.add("hxt-hd"); // 高清插画帧：平滑渲染
        pixelPlay(PLAY_ACTION[st.posture] || "idle");
        healFrames(m); // 透明通道自愈（检测到黑底才动手，异步不阻塞）
      })
      .catch(function () { PIX.loaded = false; });
  }

  // ================= 音效（Web Audio 轻量合成） =================
  var AudioCtx = (window.AudioContext || window.webkitAudioContext);
  var actx = AudioCtx ? new AudioCtx() : null;
  // 修 bug：原来判断的是 st.sound，而 st 上根本没有这个字段（它在 CONF 上），
  // 于是 beep 永远在第一行 return，整套点按/吸附/关怀音效其实一直是哑的。
  // 现在统一读 CONF.sound，并且静音模式下一律不出声。
  function beep(freq, dur, type, gain) {
    if (!actx || !CONF.sound || st.muted) return;
    // 与主应用共用「一次动作最多一声」的闸门：桌宠按钮的专属音效先响，
    // 挂在 document 上的全站点击音随后就被挡下，避免同一次点击连响两下。
    // （桌宠自己的双音提示音间隔 70ms 以上，不会被这个闸门吃掉。）
    var gate = window.KnowOriginSoundGate;
    if (typeof gate === "function" && !gate()) return;
    try {
      if (actx.state === "suspended") actx.resume();
      var o = actx.createOscillator(), g = actx.createGain();
      o.type = type || "sine"; o.frequency.value = freq || 660;
      g.gain.setValueAtTime(0, actx.currentTime);
      g.gain.linearRampToValueAtTime((gain || 0.08), actx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + (dur || 0.15));
      o.connect(g); g.connect(actx.destination);
      o.start(); o.stop(actx.currentTime + (dur || 0.15) + 0.02);
    } catch (e) { /* ignore audio errors */ }
  }
  // 浏览器要求 AudioContext 在用户手势后才能出声：第一次点/按/滚就把它唤醒
  function wakeAudio() {
    if (!actx) return;
    try { if (actx.state === "suspended") actx.resume(); } catch (e) {}
  }
  ["mousedown", "touchstart", "keydown", "wheel"].forEach(function (ev) {
    window.addEventListener(ev, wakeAudio, { passive: true, once: false });
  });
  var SFX = {
    tap:    function () { beep(700, 0.07, "sine", 0.06); },
    pop:    function () { beep(520, 0.09, "triangle", 0.07); setTimeout(function(){beep(780,0.12,"sine",0.06);},70); },
    dock:   function () { beep(440, 0.1, "triangle", 0.07); setTimeout(function(){beep(660,0.14,"sine",0.05);},80); },
    care:   function () { beep(590, 0.1, "sine", 0.06); setTimeout(function(){beep(880,0.18,"sine",0.05);},100); },
    sleep:  function () { beep(330, 0.18, "sine", 0.05); },
    giggle: function () { beep(660, 0.07, "sine", 0.06); setTimeout(function(){beep(880,0.07,"sine",0.06);},80); setTimeout(function(){beep(1040,0.12,"sine",0.06);},160); },
  };

  // ================= 内部状态 =================
  var st = {
    login: false,
    enabled: true,        // 桌宠总开关（设置面板「海小棠桌宠开启」，右键可取消）
    project: null,
    posture: "rest",      // stand | crouch | rest | sleep | interact
    x: null, y: null,      // 自由浮空位置（无吸附锚点）
    mood: "calm",
    muted: false,
    focus: false,
    streak: 0,
    todayActive: false,
    mastery: null,
    nodes: [],          // 知识框架节点（来自 /framework）
    derived: null,      // 由节点+掌握度算出的陪伴画像 {avgPct, mastered, weakTops, counts}
    dozing: false,      // 专注太久后打盹
    lastInteract: Date.now(),
    railSnap: false,      // 自由浮空模式：不再吸附水平滑轨（默认自由漂浮/拖拽）
    persona: "shy",      // 性格（默认"安静海棠"：安静害羞温柔体贴鼓励可爱）
    chatsToday: 0,       // 日记埋点：当日聊天次数
    caredToday: 0,       // 日记埋点：当日浇花数
    caredTodayNames: [], // 日记埋点：当日浇花节点名
  };
  var els = {};

  // ================= 数据：复用主会话获取真实学习数据 =================
  function sfetch(url, opt) {
    return fetch(url, Object.assign({ credentials: "same-origin" }, opt || {}))
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .catch(function () { return null; });
  }

  st._streakSeen = false; // 首次拉取只记录状态，不误判为"刚打卡"
  function fetchStreak() {
    sfetch("/api/me/streak").then(function (d) {
      if (!d) return;
      var wasActive = st._streakSeen ? st.todayActive : null;
      st._streakSeen = true;
      st.streak = Number(d.current_streak) || 0;
      st.todayActive = Boolean(d.today_active);
      // 打卡成功瞬间：鼓掌庆祝 + 气泡（防首拉误判：仅状态由 false→true 时触发）
      if (wasActive === false && st.todayActive) {
        playOnce("jump", "hxt-jump", "care", 1800);
        // 打卡是"真事件"，允许插队：不受气泡闸门限制，也不占用每小时额度
        autoBubble({ ic: "🎉", t: "海小棠", m: "打卡成功！连续 " + st.streak + " 天，园子里的海棠都替你高兴～" }, 5000, { force: true });
      }
    });
  }
  function fetchMastery() {
    if (!st.project || !st.project.project_id) return;
    sfetch("/api/projects/" + encodeURIComponent(st.project.project_id) + "/mastery/breakdown").then(function (d) {
      if (d) { st.mastery = d; buildDerived(); }
    });
  }
  function fetchFramework() {
    if (!st.project || !st.project.project_id) return;
    sfetch("/api/projects/" + encodeURIComponent(st.project.project_id) + "/framework").then(function (d) {
      if (d && Array.isArray(d.nodes)) { st.nodes = d.nodes; buildDerived(); }
    });
  }

  // ================= 陪伴画像：由节点 + 掌握度实时推算 =================
  // 让桌宠不用依赖已失效的本地缓存，直接用真实学习数据做陪伴决策
  function nodeMastery(nodeId) {
    var b = st.mastery && st.mastery.by_node ? st.mastery.by_node[nodeId] : null;
    return b && b.total_score != null ? Number(b.total_score) : null;
  }
  function nodeRank(ls, cov) {
    if (ls && ["insufficient_source", "missing_prerequisite", "uncovered"].indexOf(ls) >= 0) return "wilted";
    if (cov && ["insufficient_source", "missing_prerequisite", "uncovered"].indexOf(cov) >= 0) return "wilted";
    if (ls === "mastered") return "bloomed";
    if (["learning", "pending_confirmation", "encountered"].indexOf(ls) >= 0) return "open";
    return "bud"; // unexplored
  }
  function buildDerived() {
    var nodes = st.nodes || [];
    if (!nodes.length) { st.derived = null; return; }
    var mastered = 0, sum = 0, counted = 0, weak = [];
    var counts = { mastered: 0, learning: 0, unknown: 0, missing: 0 };
    nodes.forEach(function (n) {
      var m = nodeMastery(n.node_id);
      var ms = m != null ? m : Number(n.mastery_score || 0);
      sum += isNaN(ms) ? 0 : ms; counted++;
      var ls = n.learning_status || "";
      var rank = nodeRank(ls, n.coverage_status || "");
      counts[rank === "bloomed" ? "mastered" : rank === "open" ? "learning" : rank === "wilted" ? "missing" : "unknown"] += 1;
      if (rank === "bloomed" || (ms >= 0.8)) mastered++;
      if (rank === "wilted") weak.push({ id: n.node_id, name: n.name, pct: Math.round((ms || 0) * 100), reason: "coverage" });
      else if (rank !== "bloomed" && (ms == null || ms < 0.55)) weak.push({ id: n.node_id, name: n.name, pct: Math.round((ms || 0) * 100), reason: "low" });
    });
    weak.sort(function (a, b) { return a.pct - b.pct; });
    st.derived = {
      avgPct: counted ? Math.round(sum / counted * 100) : 0,
      mastered: mastered,
      counts: counts,
      weakTops: weak.slice(0, 5),
      weakCount: weak.length,
    };
    diaryTodayUpsert({ avgPct: st.derived.avgPct, mastered: st.derived.mastered });
    maybeMorningBrief();
  }

  // ================= 海小棠日记（每日学习互动卡，localStorage 近 7 天） =================
  var DIARY_KEY = "knoworigin_hxt_diary";
  function todayKey(){ return new Date().toDateString(); }
  function diaryLoad(){ try { return JSON.parse(localStorage.getItem(DIARY_KEY) || "{}"); } catch(e){ return {}; } }
  function diarySave(obj){ try { localStorage.setItem(DIARY_KEY, JSON.stringify(obj)); } catch(e){} }
  // 跨日自动重置当日埋点；返回当日实时记录
  function diaryCollect(){
    var k = todayKey();
    if (st._dayKey !== k) { st._dayKey = k; st.chatsToday = 0; st.caredToday = 0; st.caredTodayNames = []; }
    var d = st.derived;
    return {
      streak: st.streak,
      todayActive: st.todayActive,
      cared: st.caredToday,
      caredNames: st.caredTodayNames.slice(0, 2),
      chats: st.chatsToday,
      avgPct: d ? d.avgPct : null,
      mastered: d ? d.mastered : null,
    };
  }
  function diaryTodayUpsert(merge){
    var obj = diaryLoad();
    if (!obj.days) obj.days = {};
    var rec = diaryCollect();
    if (merge) for (var k in merge) rec[k] = merge[k];
    obj.days[todayKey()] = rec;
    var keys = Object.keys(obj.days).sort();
    while (keys.length > 7) delete obj.days[keys.shift()]; // 只留近 7 天
    diarySave(obj);
  }
  function fmtDay(k){
    var d = new Date(k);
    if (isNaN(d.getTime())) return k;
    return (d.getMonth() + 1) + "月" + d.getDate() + "日";
  }
  function openDiary(){
    setPosture("interact"); SFX.pop();
    diaryTodayUpsert(); // 打开时先采集一次当日记录，保证「今天」卡存在
    var p = getPersona();
    var obj = diaryLoad(); var days = obj.days || {};
    var keys = Object.keys(days).sort().reverse();
    var today = todayKey();
    var html = '<div class="hxt-rich-title">📔 海小棠日记</div>'
      + '<div class="hxt-rich-sub">' + (p.diary.open[Math.floor(Math.random()*p.diary.open.length)]) + '</div>';
    if (!keys.length) {
      html += '<div class="hxt-garden-empty">还没有日记，先去学一会儿、和我说说话，今晚就会有第一张～</div>';
    } else {
      keys.slice(0, 7).forEach(function (k) {
        var r = days[k] || {};
        var lines = [];
        var streakTxt = r.streak ? "连续 " + r.streak + " 天" : "还没开始打卡";
        lines.push((r.todayActive ? "🔥 打卡：" : r.streak ? "💧 差一次打卡，" : "🌙 ") + streakTxt);
        if (r.cared) lines.push("💧 浇灌了 " + r.cared + " 株海棠" + (r.caredNames && r.caredNames.length ? "（" + r.caredNames.join("、") + "）" : ""));
        if (r.chats) lines.push("💬 和我聊了 " + r.chats + " 次");
        if (r.avgPct != null) lines.push("📈 平均掌握 " + r.avgPct + "%");
        if (!lines.length) lines.push("🌱 安安静静的一天");
        html += '<div class="hxt-diary-card' + (k === today ? " hxt-diary-today" : "") + '">'
          + '<div class="hxt-diary-head">' + (k === today ? "🌸 今天" : "📔 " + fmtDay(k)) + '</div>'
          + '<div class="hxt-diary-body">' + lines.map(function (l) { return '<div class="hxt-diary-line">' + l + '</div>'; }).join("") + '</div>'
          + '</div>';
      });
    }
    html += '<div class="hxt-rich-tip">' + p.diary.close[Math.floor(Math.random()*p.diary.close.length)] + '</div>';
    dialogRenderHtml(html);
  }

  // ================= 结合点5：晨间汇报（每日一次，低噪声） =================
  var _morningFired = false;
  function maybeMorningBrief(){
    if (_morningFired || !st.login || !st.project || !st.derived) return;
    if (localStorage.getItem("knoworigin_hxt_morning") === new Date().toDateString()) { _morningFired = true; return; }
    // 闸门没开就等下一轮再来（不写 localStorage，免得白白浪费掉今天这唯一一次汇报）
    if (!bubbleGateOpen()) return;
    localStorage.setItem("knoworigin_hxt_morning", new Date().toDateString());
    _morningFired = true;
    SFX.care();
    autoBubble(morningBriefItem(st.derived), 9000);
  }
  function morningBriefItem(d){
    var p = getPersona();
    var streakTxt = st.streak > 0 ? (st.todayActive ? "连续打卡 " + st.streak + " 天" : "连续打卡 " + st.streak + " 天，今天还没打卡") : "重新起步的第一天";
    var focusTxt = d.weakTops.length ? "最该关照的是「" + truncate(d.weakTops[0].name, 14) + "」" : "暂时没有明显薄弱点";
    var head = p.morning[Math.floor(Math.random()*p.morning.length)];
    return {
      ic: "🌅",
      m: head + " 目前「" + (st.project.label || "这门课") + "」平均掌握 " + d.avgPct + "%，已点亮 " + d.mastered + " 个知识点。" + streakTxt + "。" + focusTxt + "，就把它当成一株该浇水的小海棠吧。",
    };
  }

  // ================= 关心内容 =================
  var HOURS = ["夜间","凌晨","清晨","上午","中午","下午","傍晚","深夜"];
  function hourTag(h){ if(h<1)return 0; if(h<5)return 1; if(h<7)return 2; if(h<11)return 3; if(h<13)return 4; if(h<18)return 5; if(h<22)return 6; return 7; }

  // ================= 性格层（Persona Layer） =================
  // 全部文案由性格对象输出，为未来性格切换铺路。
  // 预留扩展：新增性格只需在 PERSONAS 加键（如 clingy=黏人搭子 / scholar=清冷学霸），
  // 并在持久化 persona 字段里切换即可，其余代码无需改动。
  var PERSONAS = {
    // 默认人设：安静害羞温柔善良体贴鼓励可爱
    shy: {
      id: "shy", name: "安静海棠", ic: "🌸",
      greet: {
        "夜间":["夜深了…我还陪着你，但也要早点休息好不好？","夜里安静，我陪着你这株夜来香，别熬太久哦。"],
        "凌晨":["这么晚还没睡呀…知识点不会跑的，明天它会乖乖等你。","我先替你把园子守好，你去做个好梦吧。"],
        "清晨":["早呀…今天的阳光很适合学习呢，慢慢开始就好。","早上好，我给你留了最亮的那株海棠，等你来点亮。"],
        "上午":["上午好呀，先从最想学的那一点点开始，好吗？","状态不错呢…要不要趁现在点亮一株最难的海棠？"],
        "中午":["中午啦，记得吃口热饭…我也会想你的。","去休息一下吧，下午我继续陪你。"],
        "下午":["下午好…学累了就看看窗外，我一直在这边。","喝口水再继续吧，我会帮你记着进度的。"],
        "傍晚":["傍晚了呀…今天学得怎么样？想说的话我都听着。","天快黑了，注意眼睛休息哦。"],
        "深夜":["深夜还在用功…你很努力了，也请对自己温柔一点。","今晚就到这里好不好？我送你到休息为止。"],
      },
      morning: [
        "早安…今天也一步一步来，我陪着你。",
        "新的一天，园子里的海棠在悄悄等你，不急哦。",
        "早上好呀，先从你最喜欢的那株开始浇水吧。",
      ],
      bully: [
        "呀…被你戳到了，痒痒的…",
        "唔…你、你别这样戳人家啦…",
        "（小声）我记住了…等你要复习的时候，我还是会帮你的哦。",
        "呜…再戳我就要躲到花瓣后面去了…",
        "嘿…你手指真灵活，要不…去做两道题？",
        "（脸红）好啦好啦，我在认真陪着你呢…",
      ],
      touch: {
        head:  ["（眯眼）唔…摸头的话，我会不好意思的…","嘿嘿…你的手好暖和…","再、再摸头我要脸红啦…"],
        body:  ["呀…那里怕痒…","唔…我正在帮你守着园子呢…","（小声）被你一戳，话都说不利索了…"],
        feet:  ["呀！别挠那里啦…我认输还不行嘛…","咯咯…再挠我就要躲起来了…","好啦好啦…用一朵海棠花跟你求饶…"],
      },
      click: [
        "呀，你叫我啦？我、我在这儿呢。",
        "（小声）有什么想问的…我都在。",
        "嗯…需要我陪你学一会儿吗？",
      ],
      diary: {
        open:  ["今天也悄悄长大了，我记下来了。","把你今天的样子，轻轻夹进花园日记里。"],
        close: ["明天也想见到你…我会在的。","今天辛苦啦，早点休息，我一直陪着你。"],
      },
    },
    gardener: {
      id: "gardener", name: "元气园丁", ic: "🌱",
      greet: {
        "夜间":["夜深啦，别把身体熬垮，海小棠陪着你这株夜来香。","夜凉如水，记得披件外套再战。"],
        "凌晨":["凌晨还醒着？知识点不会跑，明天再战，园子我给你守着。","这么晚啦，先休息吧，海棠记着你的进度。"],
        "清晨":["早呀！海小棠给你一个含苞待放的拥抱，今天也元气满满。","清晨的风最好，把最难的节点留给现在吧。"],
        "上午":["上午好～今天先啃哪块硬骨头？我帮你盯着。","状态正好，趁精神头足点亮一朵最难的海棠。"],
        "中午":["中午啦，记得吃口热饭、起身活动一下。","午休一下，我帮你守住下午的专注力。"],
        "下午":["下午好，累了就抬头看看窗外海棠。","下午是黄金档，也要记得起身喝口水。"],
        "傍晚":["傍晚了，今天学得怎么样？跟我说说。","天快黑了，注意用眼，给大脑放空一下。"],
        "深夜":["深夜还在用功，真了不起，记得适可而止。","这么晚了，挑个轻松复习就休息吧，我守着。"],
      },
      morning: [
        "新的一天，园子里的海棠都在等你来浇水。",
        "早安，今天也一步步来，海小棠陪你把花养开。",
        "又是元气满满的一天，先点亮最想攻克的那株吧。",
      ],
      bully: [
        "嘶——！又戳我！你是把我当按铃了吗？",
        "呜哇！停停停，海棠也会疼的呀！",
        "（踉跄一步）哎哟我滴天…再闹我要回园里种花不理你了。",
        "哼～！我可记着呢，等你要复习时看我帮不帮你。",
        "住手！抵押一下：我数三下你就得去学一道题！",
        "噗——被你戳到打喷嚏了，别急，我缓一缓就好了。",
      ],
      touch: {
        head:  ["(≧▽≦) 摸头杀…好吧，今天心情不错。","唔…摸头会困的，你再摸我可要打盹了。","嘿嘿，头顶的刘海被你摸乱了啦！"],
        body:  ["呀！你戳我肚皮！","诶诶——痒！我正守着园子呢！","噗，这招叫「海棠一指禅」吗？"],
        feet:  ["哈哈哈别挠啦～我认输我认输！","咯咯咯…再挠我就要飘起来了！","停停停！我用一朵海棠花贿赂你，别挠了！"],
      },
      diary: {
        open:  ["今天也好好长大了，记一笔。","把今天的学习悄悄记进花园里。"],
        close: ["明天想点亮哪株海棠，我陪你。","园丁大人辛苦了，海小棠明天也守着你。"],
      },
    },
    // clingy / scholar 预留：加键 + 提供同结构文案即可切换
  };
  function getPersona(){ return PERSONAS[st.persona] || PERSONAS.gardener; }

  function greeting(){
    var p = getPersona();
    var g = HOURS[hourTag(new Date().getHours())];
    var arr = p.greet[g] || p.greet["上午"];
    return arr[Math.floor(Math.random()*arr.length)];
  }

  // 天大关怀内容池：北洋故事 / 天大知识 / 校园生活 / 常见问答
  // —— 都是可反复出现的确定内容，不依赖联网，所以校园网抽风时也能聊校情。
  // 事实口径已逐条核对（校史、校徽、校歌、图书馆、食堂命名、双校区地理），
  // 涉及"以学校官网/教务为准"的办事类信息一律留活口，不写死流程。
  var TIDBITS = [
    // —— 北洋故事 ——
    { ic:"📜", t:"北洋故事", m:"我叫海小棠，名字取自天大的校花海棠。每年春天满园海棠开花，是天大最温柔的风景线——我就住在那片花里。" },
    { ic:"📜", t:"北洋故事", m:"1895 年 10 月 2 日，北洋大学堂创建，是中国第一所现代大学；由津海关道盛宣怀奏请设立，校名里的『北洋』从此写进中国高教史。" },
    { ic:"📜", t:"北洋故事", m:"甲午战败之后，盛宣怀提出『自强首在储才，储才必先兴学』——北洋大学堂就是在这句主张里诞生的，『兴学强国』是它的出厂设置。" },
    { ic:"📜", t:"北洋故事", m:"1900 年北洋大学堂校址被德军占为兵营，学校迁到西沽武库重建，背靠红桥区千年运河畔的桃花堤。天大人爱花、办花事的传统，就是从那儿起的头。" },
    { ic:"📜", t:"北洋故事", m:"1935 年建校四十周年，萧友梅作曲、廖辅叔作词的《北洋大学校歌》确立，开篇一句『花堤蔼蔼，北运滔滔，巍巍学府北洋高』，一直被传唱到今天。" },
    { ic:"📜", t:"北洋故事", m:"校歌里最提气的一句是『不从纸上逞空谈，要实地把中华改造』——重实验、不空谈，天大的工科脾气其实写在校歌里。" },
    { ic:"📜", t:"北洋故事", m:"校训『实事求是』由老校长赵天麟确立，语出《汉书》；2014 年《天津大学章程》正式把它定为校训——一百多年只认这一条。" },
    { ic:"📜", t:"北洋故事", m:"抗战期间北洋师生西迁，参与组建西北联合大学，在战火里坚持办学，『读书不忘救国』的说法就是从那段日子留下来的。" },
    { ic:"📜", t:"北洋故事", m:"1917 年起北洋大学专办工科；1951 年与河北工学院合并，定名天津大学；1952 年迁到卫津路六里台与八里台之间。今天你上课的地方，是这条路一步步走来的。" },
    { ic:"📜", t:"北洋故事", m:"张太雷是北洋大学校友，中共早期重要领导人之一。北洋园校区有太雷广场，学校至今保存着他的毕业证书。" },
    { ic:"📜", t:"北洋故事", m:"老校长李书田在 1933 年开学典礼上说：大学不该只提供校舍和院系，还要提供『能发明、能创造、能领袖群伦的一流人才』——这句话放到今天也不过时。" },

    // —— 天大知识 ——
    { ic:"🔍", t:"天大知识", m:"天大的校色叫『北洋蓝』（潘通 2955C）。校徽是『圆形里嵌盾形』：圆形取自《淮南子》『智圆行方』，盾形继承老北洋校徽，盾内是篆书『北洋』和建校年份 1895。" },
    { ic:"🔍", t:"天大知识", m:"老北洋校徽是一枚盾牌：正中一本打开的书，书上写着『实事求是』；四周三个堡垒、五支箭头，代表当时北洋大学的三个学科和五个班级。" },
    { ic:"🔍", t:"天大知识", m:"天大校徽最外圈的齿状修饰，象征学校以工为主、理工文管相结合——校徽本身就是一份浓缩的学科说明书。" },
    { ic:"🔍", t:"天大知识", m:"北洋园校区 2015 年建成启用，占地约 243.6 万平方米；卫津路校区约 182 万平方米。两校区加起来，就是常说的『一校两园』。" },
    { ic:"🔍", t:"天大知识", m:"郑东图书馆 2015 年 9 月开馆，由校友、建筑大师周恺设计，约 5.4 万平方米、3700 个座位，回字形庭院式布局，很多同学认为它才是新校区的『最美建筑』。" },
    { ic:"🔍", t:"天大知识", m:"郑东图书馆的名字来自 1988 级校友郑东捐赠的 5000 万元教育基金；正门两侧各立一株西府海棠，『海棠+图书馆』是经典取景点。" },
    { ic:"🔍", t:"天大知识", m:"天大图书馆 1895 年随北洋大学一同诞生，是全国最早的大学图书馆。卫津路校区有春水图书馆（北馆）和科学图书馆（南馆），北洋园校区是郑东图书馆。" },
    { ic:"🔍", t:"天大知识", m:"北洋园校区有『七星灯火』通宵自习室，考试周也能找到位置——不过能被图书馆收留，不代表就该通宵。" },
    { ic:"🔍", t:"天大知识", m:"天大的化学工程与技术学科在全国学科评估中蝉联 A+，是公认的王牌；建筑学则是『建筑老八校』之一。" },
    { ic:"🔍", t:"天大知识", m:"天大的光学工程、仪器科学与技术、管理科学与工程、船舶与海洋工程等学科长期排在全国前列，精仪学院的光学工程就在其中。" },
    { ic:"🔍", t:"天大知识", m:"北洋园校区的地标可以串成一条线：天麟广场（纪念老校长赵天麟）、三问桥、求是亭、日晷。校徽石 2015 年由香港校友会捐赠，就立在天麟广场与三问桥交界处。" },
    { ic:"🔍", t:"天大知识", m:"卫津路校区主校门 1995 年百年校庆前夕落成，由校友建筑师布正伟设计，门头正上方是『北洋』校徽雕塑，下面是『天津大学』四个字。" },

    // —— 校园生活 ——
    { ic:"🏫", t:"校园生活", m:"北洋园校区的食堂一律用『花』命名：梅园（学一）、兰园（学二）、棠园（学三）、竹园（学四）、桃园（学五）、菊园（学六·清真），再加留园（留学生）和青园（青年教师），一共八处。" },
    { ic:"🏫", t:"校园生活", m:"棠园和桃园是因为附近种着海棠树、桃花树才得名，另外四座拆的是『梅兰竹菊』四君子——食堂名本身就是一堂校花课。" },
    { ic:"🏫", t:"校园生活", m:"卫津路校区的食堂是学一至学五，另有留园和清真食堂。学四食堂三层做过饭店式点餐，一度号称『不出校门吃天津』。" },
    { ic:"🏫", t:"校园生活", m:"天大有『三节』：春天的海棠节、秋天的红叶节，还有一年两季免费发水果的『水果节』——2002 年启动，发什么水果由同学投票决定。" },
    { ic:"🏫", t:"校园生活", m:"『天大·海棠季』2012 年办第一届，2025 年开放日双校区一天涌进约 10 万人。去天大赏海棠，现在和去武大看樱花一样出名。" },
    { ic:"🏫", t:"校园生活", m:"卫津路校区有一条花堤路，北洋园校区有一条花堤道，纪念的都是北洋大学迁址西沽桃花堤那段历史——花堤是刻在路名里的校史。" },
    { ic:"🏫", t:"校园生活", m:"天大最早的一批海棠种在水利馆周边，大约一百株。因为卫津路那片土壤含盐量高，别的花不容易活，只有耐盐碱的海棠站住了脚。" },
    { ic:"🏫", t:"校园生活", m:"北洋园校区的宿舍是 2015 年新建，四人间、带独立卫浴；卫津路校区多为六人间，胜在出门就是市中心。两个校区各有各的活法。" },
    { ic:"🏫", t:"校园生活", m:"北洋园校区北门外有 615 路等线路进城，附近有津南永旺、吾悦广场等商圈；双校区通勤主要靠校班车和公交，出发前记得看一眼班次。" },
    { ic:"🏫", t:"校园生活", m:"冯骥才文学艺术研究院在卫津路校区，青砖院落、藤蔓爬墙，是校园里最文艺的一角，路过值得绕进去走两步。" },
    { ic:"🏫", t:"校园生活", m:"天大有一百多个学生社团，其中北洋合唱团和天津大学辩论社在高校圈里都挺有名——想找同好，社团是最快的入口。" },

    // —— 常见问答 ——
    { ic:"❓", t:"常见问答", m:"『选课冲突怎么办？』先走教务系统的调剂申请（classes.tju.edu.cn），不行再联系开课学院的教务老师人工协调，别自己硬扛。" },
    { ic:"❓", t:"常见问答", m:"『成绩单、在读证明怎么弄？』卫津路和北洋园校区都有自助打印终端，具体流程以官网办事大厅的指引为准。" },
    { ic:"❓", t:"常见问答", m:"『自习去哪？』图书馆可以预约座位；非教学时段公共教学楼也常有空位，北洋园校区 44 教和图书馆旁边还有通宵自习室。" },
    { ic:"❓", t:"常见问答", m:"『一卡通丢了？』先在校园一卡通小程序挂失，再去两个校区的卡务中心补办。挂失越早越安全。" },
    { ic:"❓", t:"常见问答", m:"『校园网怎么连？』宿舍和教学楼可用校园无线网，用账号密码认证即可，具体套餐以信息化办公室的说明为准。" },
    { ic:"❓", t:"常见问答", m:"『快递在哪取？』两个校区都有菜鸟驿站/代收点；北洋园校区 47、48 教附近还有京东、顺丰代收点。取件码到了就早点去，别让包裹过夜。" },
    { ic:"❓", t:"常见问答", m:"『压力大想找人聊聊？』校心理健康教育中心提供免费咨询预约，具体方式以学校官网通知为准——记得照顾好自己，这比多刷一套题重要。" },
    { ic:"❓", t:"常见问答", m:"『保研推免细则在哪查？』正式公告只发在研究生招生网（yzb.tju.edu.cn），教务处和官网首页一般只放教学通知，别只盯一个口。" },
  ];
  // 「天大知识」类（含校史、校情、校园生活）优先出场；常见问答兜底。
  var _tidbitTju = TIDBITS.filter(function (it) { return it.t !== "常见问答"; });
  var _tidbitFaq = TIDBITS.filter(function (it) { return it.t === "常见问答"; });
  var _tidbitBag = { tju: [], faq: [] };
  function drawTidbit(which) {
    var src = which === "faq" ? _tidbitFaq : _tidbitTju;
    var bag = _tidbitBag[which];
    if (!bag.length) {
      bag = src.slice();
      for (var i = bag.length - 1; i > 0; i--) { // 洗牌：一轮之内不重复，避免连着讲同一段校史
        var j = Math.floor(Math.random() * (i + 1)), tmp = bag[i]; bag[i] = bag[j]; bag[j] = tmp;
      }
      _tidbitBag[which] = bag;
    }
    return bag.pop();
  }
  function pickTidbit() {
    return (Math.random() < 0.78 || !_tidbitFaq.length) ? drawTidbit("tju") : drawTidbit("faq");
  }
  function isTjuTidbit(it) { return it && (it.t === "北洋故事" || it.t === "天大知识" || it.t === "校园生活"); }

  function pickEssay() {
    // 天大校情是常驻内容：两张签里至少有一张是校史/校情/校园生活，
    // 学习类（打卡、薄弱点、问候）各占一签 —— 既"有天大味道"，又不会只剩知识点刷屏。
    var pool = [];
    if (st.todayActive) pool.push({ ic:"🔥", t:"今日打卡", m:"今日已打卡，连续 " + st.streak + " 天啦！" });
    else if (st.streak > 0) pool.push({ ic:"💧", t:"今日未打卡", m:"连续 " + st.streak + " 天，今天还没打卡，抽1分钟做道练习吧。" });
    var weak = findWeakNode();
    if (weak) pool.push({ ic:"📚", t:"薄弱节点", m:"「" + truncate(weak.subject,12) + "」掌握度偏低（" + weak.pct + "%），建议回炉看一眼。" });
    pool.push({ ic:"🌱", t:"问候", m: greeting() });
    pool.push(pickTidbit());
    pool.push(pickTidbit());
    var it = pool[Math.floor(Math.random()*pool.length)];
    // 讲校史校情时换个灵动表情，别让表情一直一个样
    if (isTjuTidbit(it) || it.ic === "❓") {
      setPosture(Math.random()<0.5 ? "interact" : "stand");
    }
    return it;
  }
  function findWeakNode(){
    var d = st.derived;
    if (!d || !d.weakTops.length) return null;
    var w = d.weakTops[0];
    return { subject: w.name, pct: w.pct };
  }
  function truncate(s,n){s=String(s==null?"":s);return s.length>n?s.slice(0,n)+"…":s;}

  // ================= 主界面会话桥接（复用SSE对话） =================
  // 海小棠代问：正文保持原始问题、不加可见前缀；用 dataset 标记，交给主界面
  // 通过 body.pet 传给后端走温柔口吻，并让回覆显示海小棠头像
  function askInMain(text){
    var ta = document.getElementById("message-input");
    var form = document.getElementById("composer");
    if (!ta || !form) { toast("⚠️", "对话区未就绪"); return; }
    ta.value = String(text || "").trim();
    ta.dataset.hxtPet = "1"; // 供 sendMessage 读取，不写入正文
    if (window.requestAnimationFrame) window.requestAnimationFrame(function(){ try{ form.requestSubmit(); }catch(e){ form.dispatchEvent(new Event("submit",{cancelable:true})); } });
  }

  // ================= 功能选项卡 =================
  function showMenu(items){
    buildBubble();
    var bt = els.btTitle, msg = els.btMsg, menu = els.menu;
    bt.textContent = "🌸 海小棠 · 听听你的需要";
    msg.textContent = "点一个功能，我马上为你办：";
    menu.innerHTML = "";
    items.forEach(function(it){
      var b = document.createElement("button");
      b.innerHTML = '<span class="hxt-bt-ic">'+it.ic+'</span> ' + it.label;
      b.addEventListener("click", function(){ SFX.pop(); hideBubble(); if(it.act) it.act(); });
      menu.appendChild(b);
    });
    menu.style.display = "grid";
    els.bubble.classList.add("hxt-show");
    setPosture("interact");
  }

  // 安全的富文本渲染：转义所有 HTML，仅把 **重点** 渲染成粗体
  function renderRich(t){
    var s = String(t == null ? "" : t)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    return s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  }
  // 聊天框富文本渲染：先转义防注入，再还原常用 Markdown（粗体/斜体/行内码/换行）
  function renderChat(t){
    var s = String(t == null ? "" : t)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
         .replace(/\*(.+?)\*/g, "<i>$1</i>")
         .replace(/`([^`]+?)`/g, "<code>$1</code>")
         .replace(/\n{3,}/g, "\n\n")
         .replace(/\n/g, "<br>");
    return s;
  }
  // ================= 关怀气泡（自动轻提示） =================
  function showBubble(it){
    buildBubble();
    els.btTitle.textContent = (it.ic||"🌸") + " 海小棠";
    els.btMsg.innerHTML = renderRich(it.m || "");
    els.menu.style.display = "none";
    els.bubble.classList.add("hxt-show");
  }
  function hideBubble(){ if(els.bubble) els.bubble.classList.remove("hxt-show"); }

  // ================= 气泡节奏闸门（平时少说话） =================
  // 用户反馈"平时气泡太吵"。这里把「海小棠自己冒出来」的气泡统一收口到 autoBubble()：
  //   ① 静音模式 / 专注模式 / 打盹中 / 正在拖动 / 聊天框已打开 → 一律不说
  //   ② 距上一条自动气泡不足 bubbleMinGapMs → 不说
  //   ③ 最近一小时内自动气泡已满 bubbleMaxPerHour → 不说
  // 而「因你而发」的气泡（手动点她、打卡庆祝、聊天回覆）走 force / 直连，不受闸门限制。
  var BUBBLE_GOV = { last: 0, marks: [] };
  function govPrune(now) {
    BUBBLE_GOV.marks = BUBBLE_GOV.marks.filter(function (t) { return now - t < 3600000; });
  }
  function bubbleGateOpen() {
    if (st.muted || st.focus || st.dozing) return false;
    if (!st.login) return false;
    if (els.dialog && !els.dialog.classList.contains("hxt-hidden")) return false;
    if (container && container.classList.contains("hxt-dragging")) return false;
    if (els.bubble && els.bubble.classList.contains("hxt-show")) return false; // 上一条还挂着就别叠
    var now = Date.now();
    govPrune(now);
    if (now - BUBBLE_GOV.last < CONF.bubbleMinGapMs) return false;
    if (BUBBLE_GOV.marks.length >= CONF.bubbleMaxPerHour) return false;
    return true;
  }
  function govMark() {
    var now = Date.now();
    govPrune(now);
    BUBBLE_GOV.last = now;
    BUBBLE_GOV.marks.push(now);
  }
  // 自动气泡唯一入口。opt.force= 跳过闸门（用于打卡庆祝这类"真事件"）；
  function autoBubble(it, ms, opt) {
    opt = opt || {};
    if (!opt.force && !bubbleGateOpen()) return false;
    if (!opt.force) govMark();
    showBubble(it);
    if (ms) setTimeout(hideBubble, ms);
    return true;
  }  function buildBubble(){
    if (els.bubble) return els.bubble;
    var bb = document.createElement("div");
    bb.className = "hxt-bubble";
    bb.innerHTML =
      '<button class="hxt-close" data-hxt-close>x</button>' +
      '<div class="hxt-bt"><span class="hxt-bt-ic" data-hxt-btic>🌸</span><span data-hxt-bttitle>海小棠</span></div>' +
      '<div data-hxt-btmsg></div><div class="hxt-menu" data-hxt-menu></div>';
    container.appendChild(bb);
    els.bubble = bb;
    els.btIc = bb.querySelector("[data-hxt-btic]");
    els.btTitle = bb.querySelector("[data-hxt-bttitle]");
    els.btMsg = bb.querySelector("[data-hxt-btmsg]");
    els.menu = bb.querySelector("[data-hxt-menu]");
    bb.querySelector("[data-hxt-close]").addEventListener("click", function(){ SFX.tap(); hideBubble(); });
    return bb;
  }

  function toast(ic, text){
    if (!els.toast) { els.toast = document.createElement("div"); els.toast.id="hxtToast"; els.toast.className="hxt-toast hxt-show"; document.body.appendChild(els.toast); }
    els.toast.innerHTML = '<span class="hxt-toast-ic">'+ic+'</span><span>'+text+'</span>';
    els.toast.classList.add("hxt-show");
    clearTimeout(els.toast._t);
    els.toast._t = setTimeout(function(){ els.toast.classList.remove("hxt-show"); }, 3200);
  }

  // ================= 姿态 =================
  // 基础姿态不再一直上下飘：站立/趴窝/睡眠都落到"稳稳待着"(hxt-idle)，
  // 只有互动时挥手(hxt-wave)，可爱小动作由 runIdleAction 一次性播放后归位。
  function setPosture(p){
    var box = els.wrap;
    var size = p === "crouch" ? "hxt-crouch"
      : p === "rest" ? "hxt-rest"
      : p === "sleep" ? "hxt-sleep"
      : (p === "interact" || p === "stand") ? "hxt-stand-full" : "hxt-stand-half";
    box.className = "hxt-avatar-wrap " + size + (p === "interact" ? " hxt-wave" : p === "clutch" ? " hxt-static hxt-clutch-sm" : " hxt-idle");
    box.style.transform = "";
    var imgKey = (p === "crouch" || p === "rest") ? "rest" : p === "sleep" ? "sleep" : p === "interact" ? "happy" : "stand";
    paintPose(PLAY_ACTION[p] || "idle", IMG[imgKey]);
    fitWrap(PLAY_ACTION[p] || "idle");
    // 滑轨吸附模式下：姿态切换（如被点"站起来"）后仍贴回同一条滑轨，尺寸统一不突兀
    if (st.railSnap && p !== "crouch") snapRailY();
    // 萌萌休息/趴窝时，身后飘落海棠花瓣
    if (els.petals) container.classList.toggle("hxt-petal-mode", p === "rest" || p === "crouch");
  }

  // ================= 可爱待机小动作（不再一直飘，偶尔做丝滑动作后归位） =================
  // 列表：CSS class + 换形象图 + 播放时长 + 音效。空闲时随机挑一个，做完回昵静站姿。
  var IDLE_ACTIONS = [
    { cls: "hxt-bounce", img: "happy", t: 1000, sfx: null },
    { cls: "hxt-tilt",   img: "think", t: 1400, sfx: null },
    { cls: "hxt-peek",   img: "stand", t: 1200, sfx: null },
    { cls: "hxt-wave",   img: "happy", t: 1600, sfx: "care" },
    { cls: "hxt-nap",    img: "sleep", t: 1800, sfx: "sleep" },
    { cls: "hxt-bounce", img: "angry", t: 1200, sfx: null }, // 偶尔气鼓鼓蹦一下
    { cls: "hxt-tilt",   img: "cry",   t: 1400, sfx: null }, // 偶尔委屈一会儿
  ];
  var _idleT = null, _idleSeq = 0;
  function clearCuteAction(){
    boxCuteClasses.forEach(function (c) { els.wrap.classList.remove(c); });
  }
  var boxCuteClasses = IDLE_ACTIONS.map(function (a) { return a.cls; })
    .concat(["hxt-zone-head-anim","hxt-zone-body-anim","hxt-zone-feet-anim"]) // 部位反馈动画也可被一键清理
    .concat(["hxt-jump","hxt-shake","hxt-love"]); // 互动反馈动画类也纳入一键清理
  function scheduleIdle(){
    clearTimeout(_idleT);
    if (!st.login) return;
    _idleT = setTimeout(runIdleAction, 4200 + Math.random() * 5200);
  }
  function cancelIdle(){
    clearTimeout(_idleT); _idleT = null; _idleSeq++;
    clearCuteAction();
  }
  function runIdleAction(){
    // 忙/专注/静音/聊天框打开/正在拖动/侧坐休息时安安静静待着
    // 忙/专注/静音/扒框磨爪/抓睡/聊天框打开/正在拖动时安安静静待着（默认扒框时只眨眼）
    if (!st.login || st.focus || st.muted || st.dozing || st.posture === "rest" ||
        st.posture === "clutch" ||
        (els.dialog && !els.dialog.classList.contains("hxt-hidden")) ||
        container.classList.contains("hxt-dragging")) { scheduleIdle(); return; }
    var a = IDLE_ACTIONS[Math.floor(Math.random() * IDLE_ACTIONS.length)];
    var seq = ++_idleSeq;
    setPosture("stand");
    clearCuteAction();
    paintPose(PLAY_ACTION[a.img] || "idle", IMG[a.img] || IMG.stand);
    els.wrap.classList.add(a.cls);
    if (a.sfx && SFX[a.sfx]) SFX[a.sfx]();
    setTimeout(function () {
      if (_idleSeq === seq) { els.wrap.classList.remove(a.cls); setPosture(DEFAULT_POSTURE); }
      scheduleIdle();
    }, a.t);
  }

  // 一次性互动动作（事件触发）：换像素帧 + 挂 CSS 动画 + 音效，seq 防冲突，结束归位
  // img=像素帧动作名（见 PLAY_ACTION），cls=配套 CSS 动画类，sfx=音效名，ms=时长
  function playOnce(img, cls, sfx, ms){
    if (!st.login || st.muted || st.dozing) return;
    var seq = ++_idleSeq;
    setPosture("stand");
    clearCuteAction();
    paintPose(PLAY_ACTION[img] || "idle", IMG[img] || IMG.stand);
    els.wrap.classList.add(cls);
    if (sfx && SFX[sfx]) SFX[sfx]();
    setTimeout(function () {
      if (_idleSeq === seq) { els.wrap.classList.remove(cls); setPosture(DEFAULT_POSTURE); }
    }, ms);
  }

  // ================= 位置系统（滑轨吸附 / 自由浮空两种模式） =================
  function placeFree(x, y, posture){
    st.railSnap = false; // 自由浮空：不贴滑轨
    st.x = x; st.y = y;
    container.style.left = x + "px";
    container.style.top  = y + "px";
    container.style.right = "auto";
    container.style.bottom = "auto";
    if (posture){ st.posture = posture; setPosture(posture); }
  }
  // 引导模式：趴在左下角不挡对话主线（露出趴窝小图）
  document.addEventListener("knoworigin:pet-guide", function (e) {
    if (e.detail && e.detail.active) { placeFree(18, window.innerHeight - 130, "crouch"); SFX.sleep(); }
  });

  // ================= 权限持久化 =================
  function loadPersist(){
    try{ var o=JSON.parse(localStorage.getItem(CONF.storeKey)||"{}"); st.muted=!!o.muted; st.focus=!!o.focus; st.enabled = o.enabled!==false; CONF.sound = o.sound!==false; if(typeof o.x==="number" && typeof o.y==="number"){ st.x=o.x; st.y=o.y; } if(o.persona && PERSONAS[o.persona]) st.persona=o.persona; if(st.persona==="gardener") st.persona="shy"; }catch(e){}
  }
  function savePersist(){
    try{ localStorage.setItem(CONF.storeKey, JSON.stringify({ muted:st.muted, focus:st.focus, sound:CONF.sound, x:st.x, y:st.y, persona:st.persona, enabled:st.enabled, customPos:!!st.customPos })); }catch(e){}
  }

  // ================= 事件绑定 =================
  function bind(){
    // —— 拖拽 + 点击二合一：按下 < 800ms 且移动 < 6px 视为点击；否则为拖动 ——
    var downX=0,downY=0,ox=0,oy=0,dragging=false,didDrag=false,downT=0;

    container.addEventListener("mousedown", function(e){
      if (e.target.closest(".hxt-menu") || e.target.closest(".hxt-close") || e.target.closest(".hxt-garden")) return;
      if (e.button!==0) return;
      dragging=true; didDrag=false; downT=Date.now();
      downX=e.clientX; downY=e.clientY;
      var r=container.getBoundingClientRect(); ox=r.left; oy=r.top;
      e.preventDefault();
    });
    window.addEventListener("mousemove", function(e){
      if(!dragging)return;
      var dx=e.clientX-downX, dy=e.clientY-downY;
      var dist=Math.sqrt(dx*dx+dy*dy);
      if(dist>6){ // 超过阈值则进入真实拖动
        if(!didDrag){ didDrag=true; container.classList.add("hxt-dragging"); container.setAttribute("data-magnet","false"); }
      }
      if(didDrag){
        // 自由浮空：随指针拖动，限制在窗口内保持可见
        var _dw = container.offsetWidth || 120, _dh = container.offsetHeight || 150;
        st.x = Math.max(4, Math.min(window.innerWidth - _dw - 4, ox + e.clientX - downX));
        st.y = Math.max(4, Math.min(window.innerHeight - _dh - 4, oy + e.clientY - downY));
        container.style.left = st.x+"px";
        container.style.top = st.y+"px";
        container.style.right="auto"; container.style.bottom="auto";
      }
    });
    // 花园里的海棠花：点击 → 带上下文唤搭子温习
    container.addEventListener("click", function(e){
      var f = e.target.closest ? e.target.closest(".hxt-flower") : null;
      if (!f) return;
      e.stopPropagation();
      var fid = f.getAttribute("data-hxt-fid");
      if (fid) diveNode(fid);
    });
    window.addEventListener("mouseup", function(){
      if(!dragging)return;
      dragging=false;
      var isTap = !didDrag && (Date.now()-downT) < 800;
      if(didDrag){
        container.classList.remove("hxt-dragging");
        // 拖动也只在滑轨上：松手停在对话框边缘，5 秒无操作后自动滑回默认吸附位
        savePersist();
      } else if(isTap){
        var zone = zoneAt(downX, downY);
        if (zone) touchZone(zone); // 部位热区：摸头/戳一戳/挠痒
        else onTapRelease();       // 唤醒/欺负检测/打开专属对话框
      }
      savePersist();
    });

    // 鼠标悬浮到海小棠身上：歪头看过来 + 甜甜招呼（节流，避免频繁打扰）
    // 悬浮是"你主动凑近"，所以允许说话。
    var _hoverCd = 0;
    container.addEventListener("mouseenter", function(){
      if (!st.login || st.muted || st.dozing ||
          container.classList.contains("hxt-dragging")) return;
      var now = Date.now();
      if (now - _hoverCd < 8000) return;
      _hoverCd = now;
      st.lastInteract = now;
      playOnce("think", "hxt-tilt", null, 1500); // 歪头看过来（自动归位站立）
      if (!els.dialog || els.dialog.classList.contains("hxt-hidden")) {
        showBubble({ ic: "🌸", t: "海小棠", m: "咦，你来啦～" });
        setTimeout(hideBubble, 2400);
      }
    });

    // 关怀循环（每分钟看一眼状态；真正说话与否交给气泡闸门裁决）
    var _essayArmed = true; // 一轮"长时间没人理"只讲一次，靠人回来重新上膛
    setInterval(function(){
      var idleMin=(Date.now()-st.lastInteract)/60000;
      if (idleMin < 6) _essayArmed = true; // 人回来了：下一次闲置可以重新开口
      // 专注态：陪读→打盹映射。学太久没动静，海小棠趴下小睡，点击可唤醒
      if (st.login && st.focus && !st.muted) {
        if (idleMin > 35 && !st.dozing) { st.dozing=true; setPosture("sleep"); }
        return;
      }
      // 长时间没人理：侧坐萌萌休息（仅自由态；默认扒框态保持完全静止）；人一回来就重新站起
      if (st.login && !st.muted && st.posture === "rest") {
        if (idleMin < 5) setPosture(DEFAULT_POSTURE); // 人回来了：从侧坐歇息回到扒框眨眼
      } else if (st.login && !st.muted && !st.focus && !st.dozing &&
                 idleMin > 10 && st.posture !== "rest" && st.posture !== "clutch") {
        setPosture("rest");
        // 侧坐是个姿态动作，不受闸门限制；顺口那句"歇会儿"才受闸门管
        autoBubble({ ic: "🌷", t: "海小棠", m: "没人理我，我侧坐歇会儿～" }, 3600);
      }
      // 闲得够久（70 分钟）：讲一段天大校史校情/学习提醒。
      // _essayArmed 保证"一整段闲置只讲一次"，闸门再兜一层，避免整夜刷屏。
      if (st.login && !st.muted && !st.focus && !st.dozing && idleMin > 70 && _essayArmed) {
        var it = pickEssay();
        if (autoBubble(it, 7200)) { _essayArmed = false; SFX.care(); }
      }
    }, 60000);
  }

  function thinkAboutProgress(){
    var weak = findWeakNode(), d = st.derived;
    setPosture(weak || (d && d.weakCount) ? "interact" : "stand");
    var row = '<div class="hxt-progress-row">'
      + '<span class="hxt-chip">🔥 打卡 ' + st.streak + ' 天</span>'
      + '<span class="hxt-chip">🌸 平均 ' + (d ? d.avgPct : 0) + '%</span>'
      + (d ? '<span class="hxt-chip">🌷 学习中 ' + d.counts.learning + '</span>' : '')
      + (d && d.counts.missing ? '<span class="hxt-chip">🥀 待补全 ' + d.counts.missing + '</span>' : '')
      + '</div>';
    var msg = weak
      ? '薄弱点在「' + escapeHtml(weak.subject) + '」(' + weak.pct + '%)，去知识花园点那株海棠，我带你一株株浇回来。'
      : (d && !d.weakCount ? '园子状态不错！想回顾哪个节点，直说～' : '有 ' + (d ? d.weakCount : 0) + ' 株海棠有待关照，点知识花园就能补。');
    dialogRenderHtml('<div class="hxt-rich-title">🎯 项目进度</div>' + row + '<div class="hxt-rich-tip">' + msg + '</div>');
  }
  function dialogRenderHtml(html){
    dialogEnsureOpen();
    if (!els.dialogMsgs) return null;
    var m = document.createElement("div");
    m.className = "hxt-dmsg hxt-dmsg-pet hxt-dmsg-rich";
    m.innerHTML = '<span class="hxt-dmsg-avatar">🌷</span><div class="hxt-dmsg-b">' + html + '</div>';
    els.dialogMsgs.appendChild(m);
    els.dialogMsgs.scrollTop = els.dialogMsgs.scrollHeight;
    return m;
  }  // 「天大知识」快捷入口：当场地抽一条校史/校情讲出来（在聊天框内，可重读）
  function tellTidbitInDialog() {
    var it = drawTidbit("tju");
    setPosture("interact");
    dialogRenderHtml(
      '<div class="hxt-rich-title">' + (it.ic || "🌸") + " " + (it.t || "天大知识") + "</div>"
      + '<div class="hxt-rich-tip">' + renderRich(it.m) + "</div>"
    );
  }
  function dialogEnsureOpen(){
    if (!els.dialog || els.dialog.classList.contains("hxt-hidden")) openDialog();
  }
  // ================= 静音模式开关 =================
  // 静音模式 = 一键把海小棠变安静：不再自动冒泡、不出音效。
  // 你主动点她、或打开聊天框跟她说话，她依然会回话（只是不出声）。
  function syncMuteUI() {
    if (els.launcher) {
      els.launcher.classList.toggle("hxt-launcher-quiet", !!st.muted);
      var ic = els.launcher.querySelector(".hxt-launcher-ic");
      var tx = els.launcher.querySelector(".hxt-launcher-tx");
      if (ic) ic.textContent = st.muted ? "🔇" : "💬";
      if (tx) tx.textContent = st.muted ? "静音中 · 点我聊聊" : "找海小棠聊聊";
    }
    if (container) container.classList.toggle("hxt-quiet", !!st.muted);
    var mb = els.dialog && els.dialog.querySelector("[data-hxt-mute]");
    if (mb) {
      mb.classList.toggle("hxt-on", !!st.muted);
      mb.textContent = st.muted ? "🔇" : "🔕";
      mb.title = st.muted ? "退出静音模式" : "静音模式（不再自动冒泡 / 不出声）";
    }
  }
  function setMuted(on, quiet) {
    st.muted = !!on;
    if (st.muted) {
      cancelIdle();
      hideBubble();
    }
    savePersist();
    syncMuteUI(); syncSettingsRows();
    if (!quiet) {
      toast(st.muted ? "🔇" : "🔔", st.muted
        ? "静音模式已开：海小棠安静陪着，不再自动冒泡、不出声。想聊天直接点她。"
        : "已退出静音模式：恢复自动冒泡与音效。");
    }
  }
  function toggleMuted(){ setMuted(!st.muted); SFX.tap(); }

  // 专注模式开关：目前没有入口绑定它（全仓仅此一处定义），保留实现以备接线。
  function toggleFocus(){
    st.focus=!st.focus;
    st.dozing=false;
    savePersist();
    if (st.focus) { setPosture("stand"); }
    else if (st.posture === "sleep") { setPosture(DEFAULT_POSTURE); } // 点击唤醒：回到扒框眨眼
    toast(st.focus?"🧘":"🧘", st.focus?"专注模式：我安静陪读，太久不动就会打盹提醒你休息。":"退出专注模式。");
    SFX.tap();
  }

  // ================= 结合点1+3：知识花园 & 带上下文唤搭子 =================
  function flowerGlyph(rank){
    var g = { bloomed:"🌸", open:"🌷", wilted:"🥀", bud:"🌰" };
    return g[rank] || "🌰";
  }
  function flowerRow(n){
    var m = nodeMastery(n.node_id);
    var ms = m != null ? m : Number(n.mastery_score || 0);
    var pct = Math.round(ms * 100);
    var rank = nodeRank(n.learning_status || "", n.coverage_status || "");
    return '<button type="button" class="hxt-flower hxt-flower-' + rank + '" data-hxt-fid="'
      + escapeAttr(n.node_id) + '" title="浇灌 ' + truncate(n.name, 18) + '（' + pct + '%）">'
      + '<span class="hxt-flower-ic">' + flowerGlyph(rank) + '</span>'
      + '<span class="hxt-flower-name">' + truncate(n.name, 12) + '</span>'
      + '<span class="hxt-flower-pct">' + pct + '%</span>'
      + '</button>';
  }
  function openGarden(){
    setPosture("interact"); SFX.pop();
    var m = dialogRenderHtml(gardenHtml());
    if (m){
      var grid = m.querySelector(".hxt-garden-grid");
      if (grid) grid.querySelectorAll(".hxt-flower").forEach(function (b) {
        b.addEventListener("click", function () {
          var fid = b.getAttribute("data-hxt-fid");
          if (fid) diveNode(fid);
        });
      });
    }
  }
  function gardenHtml(){
    var d = st.derived;
    var intro = '<div class="hxt-rich-title">🌷 知识花园</div>'
      + '<div class="hxt-rich-sub">每棵知识点就是一小株海棠，点一下我带你把它浇开（苏格拉底式温习）。</div>';
    if (!st.nodes || !st.nodes.length) {
      return intro + '<div class="hxt-garden-empty">还没有知识节点，去「知识框架」构建后回来，花园才会长出海棠。</div>';
    }
    var legend = '<div class="hxt-garden-legend">'
      + '<span class="hxt-chip">🌸 已掌握 ' + (d ? d.counts.mastered : 0) + '</span>'
      + '<span class="hxt-chip">🌷 学习中 ' + (d ? d.counts.learning : 0) + '</span>'
      + '<span class="hxt-chip">🌰 未探索 ' + (d ? d.counts.unknown : 0) + '</span>'
      + (d && d.counts.missing ? '<span class="hxt-chip">🥀 待补全 ' + d.counts.missing + '</span>' : '')
      + '</div>';
    return intro + legend + '<div class="hxt-garden-grid">' + st.nodes.map(flowerRow).join("") + '</div>';
  }
  // 带上下文唤搭子：把具体知识点 + 当前掌握度 + 期望的认知层级一起带进学习搭子会话
  function diveNode(nid){
    var n = null; (st.nodes || []).forEach(function (x) { if (x.node_id === nid) n = x; });
    if (!n) return;
    var b = st.mastery && st.mastery.by_node ? st.mastery.by_node[nid] : null;
    var pct = b && b.total_percent != null ? Math.round(b.total_percent) : (n.mastery_score != null ? Math.round(n.mastery_score * 100) : 0);
    hideBubble(); closeDialog(); SFX.pop(); setPosture("interact");
    askInMain("带我温习知识点「" + truncate(n.name, 22) + "」：我目前掌握度只有 " + pct + "%。请用学习搭子的方式（苏格拉底式提问）帮我把这块往理解和应用层重新梳理，别停在浅层记忆，最后用一两个我容易出错的角度反问我，真正把这株海棠松下来的花瓣补回去。");
  }
  // —— 由「清单报告 / 冲刺清单」的「问海小棠」入口调用：按知识点名唤起苏格拉底温习 ——
  function diveByName(name) {
    name = String(name == null ? "" : name).trim();
    if (!name) return false;
    var key = name.toLowerCase();
    var n = null;
    (st.nodes || []).forEach(function (x) {
      if (!n && String(x.name || "").trim() === name) n = x;
    });
    if (!n) {
      (st.nodes || []).forEach(function (x) {
        if (!n) {
          var xn = String(x.name || "").trim().toLowerCase();
          if (xn && (xn.indexOf(key) >= 0 || key.indexOf(xn) >= 0)) n = x;
        }
      });
    }
    if (n) { diveNode(n.node_id); return true; }
    // 名字对不上任何框架节点（AI 用自己的措辞写清单项）：直接问一句，不硬套节点
    askInMain("帮我讲讲「" + name + "」，我还有点拿不准。");
    return false;
  }
  // —— 给「清单报告」里每条知识点补一个「🌷 问海小棠」入口（幂等） ——
  function enhanceChecklistItems(root) {
    if (!root || !root.querySelectorAll) return 0;
    var lis = root.querySelectorAll("li");
    var count = 0;
    for (var i = 0; i < lis.length; i++) {
      var li = lis[i];
      if (li.querySelector(".hxt-ck-ask")) continue;
      var ck = li.querySelector(".ko-ck, .study-ck");
      var txt = String(li.textContent || "");
      // 学情洞察侧卡里的清单是原始 `- [ ]`，没有 ☐ 徽标；其余两处有 ☐/☑ 徽标。两种都认。
      var isPlain = /^\s*\[[ xX]\]\s*/.test(txt);
      if (!ck && !isPlain) continue;
      var name = txt
        .replace(/^\s*\[[ xX]\]\s*/, "")
        .replace(/^[\u2610\u2611]\s*/, "")
        .trim();
      var idx = name.indexOf("——");
      if (idx >= 0) name = name.slice(0, idx).trim();
      if (!name) continue;
      var askName = name.replace(/[*_`~]/g, "").trim() || name;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "hxt-ck-ask";
      b.setAttribute("data-hxt-ask", askName);
      b.title = "让海小棠用苏格拉底式提问带你把「" + truncate(name, 12) + "」过一遍";
      b.textContent = "🌷 问海小棠";
      li.appendChild(b);
      count++;
    }
    return count;
  }
  // 入口点击：文档级委托，清单 / 弹窗 / 台历里长出来的「问海小棠」都走这里
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var b = t.closest(".hxt-ck-ask");
    if (!b) return;
    e.preventDefault();
    // 先把可能正开着的弹窗关掉，露出主界面（左栏对话区），让用户立刻看到海小棠的回复：
    //   - 学习台历（清单报告页 / 学情洞察侧卡都在里面）
    //   - 「清单报告」大号预览弹窗（学习概览里打开的那个）
    var dlg = document.getElementById("study-report-dialog");
    if (dlg && dlg.open) { try { dlg.close(); } catch (err) {} }
    try { document.dispatchEvent(new CustomEvent("knoworigin:calendar-close")); } catch (err) {}
    diveByName(b.getAttribute("data-hxt-ask") || "");
  });
  function escapeAttr(s){
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c];
    });
  }
  function escapeHtml(s){
    return escapeAttr(String(s == null ? "" : s));
  }

  // ================= 点击分发：单击开聊天框 / 双击欺负 =================
  // —— 身体部位热区：摸头 / 戳一戳 / 挠痒（经典 QQ 桌宠手感） ——
  function zoneAt(x, y){
    var zs = els.wrap.querySelectorAll(".hxt-zone");
    for (var i=0;i<zs.length;i++){
      if (zs[i].offsetParent === null) continue; // 趴窝/睡眠等隐藏态跳过
      var r = zs[i].getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return zs[i].getAttribute("data-hxt-zone");
    }
    return null;
  }
  // 点击/摸头等互动 → 害羞反馈（随机从多种害羞表达里挑一种）
  var SHY_LINES = [
    "呀，被你看到啦～",
    "人、人家会害羞的啦…",
    "你摸我头，我、我脸都热了…",
    "别一直盯着人家看嘛…",
    "唔…你这么一逗，我话都不会说啦～",
    "好、好啦，人家记住了啦…",
  ];
  var ZONE_CFG = {
    head: { img:"shy", sfx:"pop",   cls:"hxt-zone-head-anim", ic:"😳" },
    body: { img:"shy", sfx:"pop",   cls:"hxt-zone-body-anim", ic:"😳" },
    feet: { img:"shy", sfx:"pop",   cls:"hxt-zone-feet-anim", ic:"😳" },
  };
  function touchZone(zone){
    st.lastInteract = Date.now();
    if (st.dozing) { st.dozing = false; setPosture(DEFAULT_POSTURE); SFX.pop(); }
    var cfg = ZONE_CFG[zone] || ZONE_CFG.body;
    var p = getPersona();
    var lines = (p.touch && p.touch[zone] && p.touch[zone].length) ? p.touch[zone] : SHY_LINES;
    var msg = lines[Math.floor(Math.random()*lines.length)];
    setPosture("interact");
    paintPose(PLAY_ACTION[cfg.img] || "shy", IMG[cfg.img] || IMG.shy);
    els.wrap.classList.add(cfg.cls);
    if (cfg.sfx && SFX[cfg.sfx]) SFX[cfg.sfx]();
    showBubble({ ic: cfg.ic, t: "海小棠", m: msg });
    var seq = ++_idleSeq;
    setTimeout(function () {
      if (_idleSeq === seq) { els.wrap.classList.remove(cfg.cls); setPosture(DEFAULT_POSTURE); }
    }, 1000);
    setTimeout(hideBubble, 3400);
  }
  var _tapCount = 0, _tapReset = null, _pendingOpen = null;
  function onTapRelease(){
    st.lastInteract = Date.now();
    if (st.dozing) { st.dozing = false; setPosture(DEFAULT_POSTURE); SFX.pop(); }
    _tapCount++;
    if (_tapReset) clearTimeout(_tapReset);
    _tapReset = setTimeout(function () { _tapCount = 0; }, 380);
    if (_tapCount >= 2) {
      // 双击 = 欺负：取消正在等待打开的对话框
      _tapCount = 0; clearTimeout(_tapReset); _tapReset = null;
      if (_pendingOpen) { clearTimeout(_pendingOpen); _pendingOpen = null; }
      bully();
      return;
    }
    // 单击 = 打开聊天框；延迟一小段，等待可能到来的第二击判成双击
    if (_pendingOpen) clearTimeout(_pendingOpen);
    _pendingOpen = setTimeout(function () { _pendingOpen = null; openDialog(); }, 300);
  }
  // 欺负反馈：点击会有反应+气泡说话，点多会生气（文案走性格层）
  function bully(){
    if (st.muted) return;
    var p = getPersona();
    setPosture("interact");
    paintPose("happy", IMG.happy); // 生气也走矢量（害羞人设不真生气）
    showBubble({ ic:"😤", t:"海小棠", m: p.bully[Math.floor(Math.random()*p.bully.length)] });
    SFX.pop();
    container.classList.add("hxt-flinch");
    setTimeout(function(){ container.classList.remove("hxt-flinch"); }, 520);
    setTimeout(hideBubble, 3400);
    setTimeout(function(){ if (!st.muted) setPosture(DEFAULT_POSTURE); }, 2000); // 消气归位：回到扒框眨眼
  }

  // ================= 专属大对话框（对话单独一个框） =================
  function openDialog(){
    st.lastInteract = Date.now();
    buildDialog();
    hideBubble();
    els.dialog.classList.remove("hxt-hidden");
    els.dialog.classList.add("hxt-dialog-in");        // 弹出动画（CSS 里定义）
    container.classList.add("hxt-chatting");          // 聊天框开着时收起悬浮按钮，避免打架
    setTimeout(function(){ if (els.dialog) els.dialog.classList.remove("hxt-dialog-in"); }, 340);
    syncMuteUI();
    dialogGreet();
    // 点击唤起 → 害羞反应（随机一句害羞话 + 害羞表情），不再开心挥手
    var _p = getPersona();
    var _gl = (_p.click && _p.click.length) ? _p.click : SHY_LINES;
    playOnce("shy", "hxt-tilt", "pop", 1500);
    setTimeout(function(){ showBubble({ ic: "😳", t: "海小棠", m: _gl[Math.floor(Math.random()*_gl.length)] }); }, 260);
    setTimeout(hideBubble, 3200);
    setTimeout(function(){ els.chatInput && els.chatInput.focus(); }, 60);
  }
  function closeDialog(){
    if (els.dialog) els.dialog.classList.add("hxt-hidden");
    if (container) container.classList.remove("hxt-chatting");
  }
  function buildDialog(){
    if (els.dialog) return els.dialog;
    var d = document.createElement("div");
    d.id = "hxt-chat-dialog";
    d.className = "hxt-dialog hxt-hidden";
    d.innerHTML =
      '<div class="hxt-dialog-head">' +
        '<div class="hxt-dialog-title"><span class="hxt-dialog-pet">🌸</span><div><strong>海小棠 · 专属对话</strong><small data-hxt-dialog-sub>学习搭子 · 校情答疑 · 陪学都在这里</small></div></div>' +
        '<div class="hxt-dialog-headright">' +
          '<button class="hxt-dialog-iconbtn" data-hxt-mute type="button" title="静音模式">🔕</button>' +
          '<span class="hxt-dialog-dragtip" title="按住拖动">⠿</span>' +
          '<button class="hxt-dialog-close" data-hxt-close-dialog type="button" title="关闭">×</button>' +
        '</div>' +
      '</div>' +
      '<div class="hxt-dialog-chips" data-hxt-chips>' +
        '<button type="button" class="hxt-dchip" data-hxt-quick="tju">🌸 天大知识</button>' +
        '<button type="button" class="hxt-dchip" data-hxt-quick="progress">🎯 项目进度</button>' +
        '<button type="button" class="hxt-dchip" data-hxt-quick="garden">🌷 知识花园</button>' +
        '<button type="button" class="hxt-dchip" data-hxt-quick="diary">📔 我的日记</button>' +
      '</div>' +
      '<div class="hxt-dialog-msgs" data-hxt-msgs></div>' +
      '<form class="hxt-dialog-inputrow" data-hxt-form>' +
        '<input data-hxt-chat-input placeholder="和海小棠说话…" autocomplete="off">' +
        '<button type="submit" class="hxt-dialog-send">发送</button>' +
      '</form>';
    document.body.appendChild(d);
    els.dialog = d;
    els.dialogSub = d.querySelector("[data-hxt-dialog-sub]");
    els.dialogMsgs = d.querySelector("[data-hxt-msgs]");
    els.chatInput = d.querySelector("[data-hxt-chat-input]");
    d.querySelector("[data-hxt-close-dialog]").addEventListener("click", function(){ SFX.tap(); closeDialog(); });
    d.querySelector("[data-hxt-form]").addEventListener("submit", function(e){ e.preventDefault(); sendDialog(); });
    // 头部开关：静音模式（用户希望这个能随手一按就切）。提示音由 toggleMuted() 出，这里别再补一声
    d.querySelector("[data-hxt-mute]").addEventListener("click", function(){ toggleMuted(); });
    // 首屏快捷入口：不用打字就能到校史 / 进度 / 花园 / 日记
    d.querySelector("[data-hxt-chips]").addEventListener("click", function(e){
      var b = e.target.closest ? e.target.closest("[data-hxt-quick]") : null;
      if (!b) return;
      var k = b.getAttribute("data-hxt-quick");
      SFX.pop();
      if (k === "tju") tellTidbitInDialog();
      else if (k === "progress") thinkAboutProgress();
      else if (k === "garden") openGarden();
      else if (k === "diary") openDiary();
    });
    syncMuteUI();
    // —— 拖拽移动：按住头部拖动整个对话框，关闭按钮除外 ——
    var ddx=0,ddy=0,dlx=0,dlt=0,ddrag=false;
    var head = d.querySelector(".hxt-dialog-head");
    head.addEventListener("mousedown", function(e){
      if (e.target.closest("[data-hxt-close-dialog]")) return;
      if (e.button!==0) return;
      var r = d.getBoundingClientRect();
      dlx = r.left; dlt = r.top;
      ddx = e.clientX; ddy = e.clientY;
      ddrag = true;
      d.style.left = dlx+"px"; d.style.top = dlt+"px";
      d.style.right = "auto"; d.style.bottom = "auto";
      d.classList.add("hxt-dialog-moving");
      e.preventDefault();
    });
    window.addEventListener("mousemove", function(e){
      if (!ddrag) return;
      var nlx = dlx + (e.clientX - ddx);
      var nlt = dlt + (e.clientY - ddy);
      nlx = Math.min(Math.max(0, nlx), window.innerWidth - 90);
      nlt = Math.min(Math.max(0, nlt), window.innerHeight - 60);
      d.style.left = nlx + "px"; d.style.top = nlt + "px";
    });
    window.addEventListener("mouseup", function(){ ddrag = false; d.classList.remove("hxt-dialog-moving"); });
    return d;
  }
  function dialogGreet(){
    if (els.dialogMsgs.querySelectorAll(".hxt-dmsg").length) return;
    var d = st.derived;
    var txt = d
      ? ("你好呀，我是海小棠🌸 现在「" + (st.project && st.project.label ? st.project.label : "这门课") + "」平均掌握 " + d.avgPct + "%，薄弱点还有 " + d.weakCount + " 个。想复习、做题、翻花园，还是随便聊两句？")
      : "你好呀，我是海小棠🌸 先在左侧上传资料、构建知识框架，我就能陪你复习、做题啦。";
    dialogLog("pet", txt);
  }
  function dialogLog(who, text){
    if (who === "user") { st.chatsToday++; diaryTodayUpsert({ chats: st.chatsToday }); }
    var m = document.createElement("div");
    m.className = "hxt-dmsg " + (who === "user" ? "hxt-dmsg-user" : "hxt-dmsg-pet");
    m.innerHTML = who === "user"
      ? "<span class='hxt-dmsg-b'>" + escapeHtml(text) + "</span>"
      : "<span class='hxt-dmsg-avatar'>🌸</span><span class='hxt-dmsg-b'>" + renderChat(text) + "</span>";
    els.dialogMsgs.appendChild(m);
    els.dialogMsgs.scrollTop = els.dialogMsgs.scrollHeight;
  }
  function sendDialog(){
    var v = els.chatInput.value.trim();
    if (!v) return;
    els.chatInput.value = "";
    dialogLog("user", v);
    if (v.indexOf("花园") >= 0) { openGarden(); return; }
    if (v.indexOf("进度") >= 0) { thinkAboutProgress(); return; }
    if (v.indexOf("日记") >= 0) { openDiary(); return; }
    askPetInDialog(v);   // 就地在面板问答，不再写入主界面
  }
  // 海小棠就地回答：请求 /api/hxt/ask（带校园信源、海小棠人设），回答只显示在专属面板
  function askPetInDialog(text){
    var bubble = document.createElement("div");
    bubble.className = "hxt-dmsg hxt-dmsg-pet";
    bubble.innerHTML = "<span class='hxt-dmsg-avatar'>🌸</span><span class='hxt-dmsg-b'>海小棠正在琢磨…</span>";
    els.dialogMsgs.appendChild(bubble);
    els.dialogMsgs.scrollTop = els.dialogMsgs.scrollHeight;
    var bodyEl = bubble.querySelector(".hxt-dmsg-b");
    var acc = "";
    var settled = false;
    // 看门狗：后端再慢也不该让人对着"正在琢磨"无限等。90s 一个字都没出就给交代。
    var watchdog = setTimeout(function () {
      if (settled || acc) return;
      settled = true;
      bodyEl.textContent = "这次等得有点久——后台可能在更新校园信源，过一会儿再问我一次？";
    }, 90000);
    function done(){
      clearTimeout(watchdog);
      if (settled) return; // 流结束与错误回调都会进来，只结算一次
      settled = true;
      if (!acc.trim()) { bodyEl.textContent = "嗯…刚才没接上，你再戳我一次？"; return; }
    }
    fetch("/api/hxt/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ message: text }),
    }).then(function (r) {
        if (!r.ok || !r.body) throw new Error("HTTP " + r.status);
        var reader = r.body.getReader(), dec = new TextDecoder(), buf = "";
        function pump(){
          return reader.read().then(function (res) {
            if (res.done) { done(); return; }
            buf += dec.decode(res.value, { stream: true });
            var idx;
            while ((idx = buf.indexOf("\n\n")) >= 0) {
              var raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
              if (raw.indexOf("data: ") !== 0) continue;
              var ev = null;
              try { ev = JSON.parse(raw.slice(6)); } catch (e) { ev = null; }
              if (ev && ev.type === "delta" && ev.text) {
                acc += ev.text;
                bodyEl.innerHTML = renderChat(acc);
                els.dialogMsgs.scrollTop = els.dialogMsgs.scrollHeight;
              } else if (ev && ev.type === "error") {
                bodyEl.textContent = "…" + (ev.message || "接不上，再试一次？");
              }
            }
            return pump();
          }, function () { done(); });
        }
        return pump();
      }).catch(function () { bodyEl.textContent = "网络开小差了，稍后再问我一次？"; });
  }

  // ================= 视图休息位：自由浮空归位 =================
  // 切到学习产出的某个界面时，海小棠滑到窗口右下角休息，不再扒住某条滑轨
  function restMove(feature){
    var w = container.offsetWidth || 120, h = container.offsetHeight || 150;
    container.setAttribute("data-magnet", "true");
    placeFree(Math.min(Math.max(8, window.innerWidth - w - 16), window.innerWidth - 24),
              Math.max(8, window.innerHeight - h - 24), "clutch");
    setTimeout(function(){ container.setAttribute("data-magnet", "false"); }, 300);
  }
  function goRest(feature, status){
    restMove(feature);
    // 切视图是很频繁的动作：这里只"有机会"说一句，
    // 大部分时候会被气泡闸门挡掉 —— 这正是"平时别太吵"想要的效果。
    if (!st.login || st.muted || st.focus) return;
    autoBubble({ ic: "🌷", t: "海小棠", m: status }, 7000);
  }
  document.addEventListener("knoworigin:pet-view", function (e) {
    if (!e.detail) return;
    // 切视图时清掉图谱联动残留（陪游高亮 / 关照环 / 孤岛框）
    clearTourFlags(); clearIslandRings();
    var f = e.detail.feature;
    if (f === "framework") {
      if (st.probe) toggleProbe(false); // 双链专属探链，离开时收起
      onFrameworkView();
      return;
    }
    if (f !== "framework") { st.tour && tourStop(null); }
    goRest(f, e.detail.status || petViewStatusFallback(f));
  });
  function petViewStatusFallback(feature){
    var names = { framework:"知识框架", overview:"学习概览", cards:"知识卡片", quiz:"小测验", favorites:"我的笔记" };
    return "嘿，换到「" + (names[feature] || feature || "这里") + "」啦～需要我陪你逛逛这块吗？";
  }

  // ================= 项目感知 / 登录感知 =================
  document.addEventListener("knoworigin:pet-login", function(){ st.login=true; show(); fetchStreak(); scheduleIdle(); setTimeout(function(){ pickEssay(); },3000); });
  document.addEventListener("knoworigin:pet-logout", function(){ st.login=false; cancelIdle(); hide(); });
  document.addEventListener("knoworigin:pet-project", function(e){
    if(!e.detail) return;
    st.project = e.detail; st.nodes = []; st.derived = null;
    fetchMastery(); fetchFramework();
  });

  // ================= 交互反馈（悬停卡片 / 选难度 / 掌握度自评 / 测验交卷） =================
  // 主应用在关键学习动作处派发 knoworigin:pet-react，海小棠据此弹出气泡给出提示/解释/鼓励/评价。
  // detail: { ic, text, mood, sfx, stayMs }；mood 取 REACT_MOOD 的键（PLAY_ACTION）
  var REACT_MOOD = {
    think: { img: "think", cls: "hxt-tilt",  sfx: null },
    happy: { img: "happy", cls: "hxt-bounce", sfx: "giggle" },
    cheer: { img: "cheer", cls: "hxt-bounce", sfx: "care" },
    shy:   { img: "shy",   cls: "hxt-tilt",   sfx: "pop" },
    jump:  { img: "jump",  cls: "hxt-jump",   sfx: "care" },
    love:  { img: "think", cls: "hxt-sway",   sfx: "care" },
    cry:   { img: "cry",   cls: "hxt-tilt",   sfx: null },
    wave:  { img: "wave",  cls: "hxt-wave",   sfx: "care" },
  };
  document.addEventListener("knoworigin:pet-react", function (e) {
    var d = (e && e.detail) || {};
    var mood = REACT_MOOD[d.mood] || REACT_MOOD.think;
    var stay = d.stayMs || 5600;
    // soft：只就地替换气泡里的文字（预设提示 → AI 个性化提示），
    // 不重播姿态/动作、不重新触发音效，避免二次弹动造成"卡一下"的观感。
    if (d.soft && d.text) {
      if (els.bubble && els.bubble.classList.contains("hxt-show")) {
        els.btMsg.innerHTML = renderRich(d.text);
        clearTimeout(st._reactT);
        st._reactT = setTimeout(hideBubble, stay);
        return;
      }
      // 气泡已自动收起（生成较慢）→ 落到下面的常规路径重新弹出
    }
    // noBubble 模式：只做表情动作（不弹文字气泡），用于 LLM 生成期间给出即时反应，避免干扰阅读。
    // silent：连音效也不出 —— 真正的音效留给随后落地的那条气泡，否则一次动作会响两遍。
    if (!d.text) {
      if (d.noBubble) playOnce(mood.img, mood.cls, d.silent ? null : (d.sfx || mood.sfx), Math.min(stay, 2600));
      return;
    }
    showBubble({ ic: d.ic || "🌸", t: "海小棠", m: d.text });
    playOnce(mood.img, mood.cls, d.sfx || mood.sfx, Math.min(stay, 2400));
    clearTimeout(st._reactT);
    st._reactT = setTimeout(hideBubble, stay);
  });

  function show(){ if (st.enabled) container.classList.remove("hxt-hidden"); }
  function hide(){ container.classList.add("hxt-hidden"); }

  // ================= 桌宠总开关（设置面板 + 右键取消） =================
  function setEnabled(on){
    st.enabled = !!on;
    savePersist();
    if (on) { if (st.login) { show(); SFX.tap(); } }
    else { cancelIdle(); hide(); }
  }
  // 右键点击桌宠本体：快速取消桌宠（等同关闭设置里的「海小棠桌宠开启」）
  document.addEventListener("contextmenu", function(e){
    if (!container || !container.contains(e.target)) return;
    if (e.target.nodeType === 1 && (e.target.closest(".hxt-menu") || e.target.closest(".hxt-dialog") || e.target.closest(".hxt-bubble"))) return;
    e.preventDefault();
    setEnabled(false);
    toast("🌱", "海小棠先下班啦～想再召唤她：设置 → 海小棠桌宠开启。");
  });
  window.KnowOriginPet = {
    setEnabled: setEnabled,
    isEnabled: function(){ return st.enabled; },
    isMuted: function(){ return st.muted; },
    setMuted: setMuted,
    openChat: openDialog,
  };

  // ================= 设置面板接线（不动 app.js / index.html 的逻辑） =================
  // 「陪伴」组里原本只有「海小棠桌宠开启」。新增的开关由桌宠模块自己注入，
  // 用 MutationObserver 盯 <dialog open> 来同步状态——这样零侵入主应用代码。
  function ensureSettingsRows() {
    var dlg = document.getElementById("settings-dialog");
    if (!dlg) return false;
    if (dlg.querySelector("[data-hxt-settings]")) return true;
    var groups = dlg.querySelectorAll(".settings-group");
    var target = null;
    for (var i = 0; i < groups.length; i++) {
      if (/陪伴/.test(groups[i].textContent || "")) { target = groups[i]; break; }
    }
    target = target || groups[0];
    if (!target) return false;
    // 设置弹窗每组现在是「标题 + .settings-group-body」两层，
    // 注入的行要落在 body 里，否则会掉到分组卡片外面（样式对不齐）。
    var mount = target.querySelector(".settings-group-body") || target;
    var holder = document.createElement("div");
    holder.setAttribute("data-hxt-settings", "1");
    holder.innerHTML =
      '<label class="settings-switch-row">' +
        '<span class="settings-row-label">海小棠静音模式</span>' +
        '<input id="hxt-settings-mute" class="settings-switch-input" type="checkbox" role="switch">' +
        '<span class="settings-switch" aria-hidden="true"></span>' +
      '</label>' +
      '<p class="settings-account-hint hxt-settings-hint">静音模式下海小棠不再自动冒泡、不出声；你主动找她说话仍会回话。</p>';
    mount.appendChild(holder);
    holder.querySelector("#hxt-settings-mute").addEventListener("change", function (e) { setMuted(e.target.checked); });
    return true;
  }
  function syncSettingsRows() {
    var m = document.getElementById("hxt-settings-mute");
    if (m) m.checked = !!st.muted;
  }
  function setupPetSettings() {
    var dlg = document.getElementById("settings-dialog");
    if (!dlg) { setTimeout(setupPetSettings, 1200); return; }   // 设置面板可能比桌宠晚就位
    ensureSettingsRows();
    syncSettingsRows();
    try {
      new MutationObserver(function () {
        if (!dlg.open) return;
        ensureSettingsRows();
        syncSettingsRows();
      }).observe(dlg, { attributes: true, attributeFilter: ["open"] });
    } catch (e) { /* 老浏览器没有 MutationObserver：退化成只在点齿轮时同步 */ }
    document.addEventListener("click", function (e) {
      if (e.target && e.target.closest && e.target.closest("#course-settings-button")) {
        setTimeout(function () { ensureSettingsRows(); syncSettingsRows(); }, 0);
      }
    });
  }

  // ================= 图谱联动 · 陪游 / 浇园 / 探链（composite 于 diagram） =================
  // 所有功能都落到"图"上：海小棠滑到节点旁 → 讲解 → 可笃绘（复用 askInMain 苏格拉底路径）。
  // 节点 HTML 一律实时查询 #studio-output 里 [data-node-id]，随图谱平移/缩放自动跟随，最稳、不侵入 app.js。

  // —— 图谱节点定位（按当前活动视图作用域查找，不依赖 CSS 转义，逐元素匹配最稳） ——
  function graphScopeSelector(){
    var kind = diagramKind();
    if (kind === "tree") return "#studio-output .knowledge-graph [data-node-id]";
    if (kind === "graph") return "#studio-output .kb-flow-graph [data-node-id]";
    return "#studio-output [data-node-id]";
  }
  function graphNodeEl(nodeId){
    var all = document.querySelectorAll(graphScopeSelector());
    for (var i=0;i<all.length;i++) if (String(all[i].getAttribute("data-node-id"))===String(nodeId)) return all[i];
    return null;
  }
  // 当前图谱后缀视图：knowledge-graph=XMind 脑图，kb-flow-graph=双链图谱
  function diagramKind(){
    if (document.querySelector("#studio-output .kb-flow-graph")) return "graph";
    if (document.querySelector("#studio-output .knowledge-graph")) return "tree";
    return "";
  }
  function flagNode(el, cls, on){ if(!el) return; if(on) el.classList.add(cls); else el.classList.remove(cls); }

  // —— 按 parent_id 做根优先 DFS，得出陪游顺序 ——
  function orderedNodes(){
    if (!st.nodes || !st.nodes.length) return [];
    var byId = {}; st.nodes.forEach(function(n){ byId[n.node_id]=n; });
    var childOf = {}; st.nodes.forEach(function(n){ var p=n.parent_id; if(p!=null && byId[p]) (childOf[p]=childOf[p]||[]).push(n); });
    var order = [], seen = {};
    function add(n){ if(!n || seen[n.node_id]) return; seen[n.node_id]=true; order.push(n); (childOf[n.node_id]||[]).forEach(add); }
    st.nodes.forEach(function(n){ if(n.parent_id==null || !byId[n.parent_id]) add(n); });
    st.nodes.forEach(add); // 兜底：isolated 或环，也能带上
    return order;
  }
  function parentOf(id){ var byId={}; st.nodes.forEach(function(n){byId[n.node_id]=n;}); var n=byId[id]; return (n && byId[n.parent_id]) ? byId[n.parent_id] : null; }
  function nodeStatusTxt(n){
    var m = nodeMastery(n.node_id); var ms = m!=null ? m : Number(n.mastery_score || 0);
    var pct = isNaN(ms)?0:Math.round(ms*100);
    var rank = nodeRank(n.learning_status||"", n.coverage_status||"");
    if (rank==="bloomed") return "已经盛开（掌握 "+pct+"%）";
    if (rank==="wilted") return "有点蔫、待补全（掌握 "+pct+"%）";
    if (rank==="open")    return "正在绽放（掌握 "+pct+"%）";
    return "还是花苞，等你来点亮";
  }
  // 温习提示词：把节点名+当前掌握度+苏格拉底意图带给主界面向导（不发明新事实）
  function socraticPrompt(n){
    var b = st.mastery && st.mastery.by_node ? st.mastery.by_node[n.node_id] : null;
    var pct = b && b.total_percent != null ? Math.round(b.total_percent) : (n.mastery_score!=null?Math.round(n.mastery_score*100):0);
    return "带我温习知识点「"+truncate(n.name,22)+"」：我目前掌握 " + pct + "%。请用学习搭子（苏格拉底式提问）帮我把它往理解和应用层重新梳理，别停在浅层记忆，最后用一两个我容易出错的角度反问我，把这株海棠松掉的花瓣补回去。";
  }
  // 飞移到屏上某处（磁力过渡，不落锚点持久化）
  function flyTo(x, y, posture){
    st.railSnap = false; // 图谱联动是自由位，不占滑轨
    container.setAttribute("data-magnet","true");
    st.posture = posture || "interact";
    setPosture(st.posture);
    container.style.left = x+"px"; container.style.top = y+"px";
    container.style.right="auto"; container.style.bottom="auto";
  }
  // 停在某节点元素旁（自动避让，不遮节点/标签）
  function glideToNode(el, posture){
    var r = el.getBoundingClientRect();
    var pw = container.getBoundingClientRect().width || 120;
    var hm = 20, left = r.right + hm, top = r.top + (r.height-120)/2;
    if (left + pw > window.innerWidth - 8) left = r.left - pw - hm;
    if (left < 8) left = r.right + hm;
    top = Math.max(8, Math.min(top, window.innerHeight - 132));
    flyTo(Math.max(8,left), top, posture);
  }
  function clearTourFlags(){
    (st.tour || {}).prevEl = null;
    // 清除上次陪游/探链遗留在节点上的高亮
    document.querySelectorAll("#studio-output .hxt-tour-active").forEach(function(el){ el.classList.remove("hxt-tour-active"); });
    document.querySelectorAll("#studio-output .hxt-care-ring").forEach(function(el){ el.classList.remove("hxt-care-ring"); });
  }

  // —— 模块一 · 陪游图谱 ——
  st.tour = { active:false, list:[], idx:0, prevEl:null };

  function tourStop(backTo){
    if (!st.tour.active) return false;
    st.tour.active = false;
    if (st.tour.timer){ clearTimeout(st.tour.timer); st.tour.timer=null; }
    clearTourFlags();
    return true;
  }
  function tourStep(delta){
    var t = st.tour; var N = t.list.length;
    if (!N){ toast("🌃","图谱里还没有可陪游的知识节点，先去左侧构建框架吧。"); return; }
    t.idx = ((t.idx + delta) % N + N) % N;
    var n = t.list[t.idx];
    var el = graphNodeEl(n.node_id);
    if (el){ glideToNode(el, "interact"); flagNode(t.prevEl,"hxt-tour-active",false); flagNode(el,"hxt-tour-active",true); t.prevEl = el; }
    else { flyTo(Math.max(12, window.innerWidth-270), 90, "interact"); }
    // 薄弱节点：停留提示补
    var rank = nodeRank(n.learning_status||"", n.coverage_status||"");
    var weak = (rank==="wilted") || (nodeMastery(n.node_id)==null ? Number(n.mastery_score||0)<0.55 : nodeMastery(n.node_id)<0.55);
    var p = parentOf(n.node_id);
    var parentTxt = p ? " · 上一个落脚点是「"+truncate(p.name,12)+"」" : " · 这是这一枝的起点";
    var msg = "第 "+(t.idx+1)+"/"+N+" 篇 ·「"+truncate(n.name,16)+"」"+nodeStatusTxt(n)+parentTxt+"。";
    var items = [];
    if (weak) items.push({ ic:"💧", label:"这株有点蔫，带我去补", act:function(){ helpNode(n); } });
    items.push({ ic:"🌸", label:"下一朵", act:function(){ tourStep(1); } });
    items.push({ ic:"✨", label:"再看一眼上一朵", act:function(){ tourStep(-1); } });
    items.push({ ic:"🏁", label:"到此为止", act:function(){ tourStop(null); hideBubble(); } });
    showMenu(items);
    els.btTitle.textContent = (weak?"💧 海小棠 · 这条路走到底":"🌃 海小棠 · 图谱陪游");
    els.btMsg.textContent = msg;
    SFX.tap();
  }
  // 带具体节点去补课：走 askInMain 苏格拉底（复用 diveNode 意图）
  function helpNode(n){
    bumpCared(); // 成长刻度：每实际帮补一株 +1，语气随之成熟
    if (st.caredTodayNames.length < 2 && n && n.name) st.caredTodayNames.push(truncate(n.name, 8));
    hideBubble(); SFX.pop();
    playOnce("jump", "hxt-jump", null, 1500); // 接下这株，先蹦一下打气
    askInMain(socraticPrompt(n));
    toast("💧","已把这株（"+truncate(n.name,12)+"）交给海小棠，正在主界面带你补…");
  }

  // —— 模块二 · 浇园关照（主动干预 + 成长刻度） ——
  // 成长刻度：累计关照薄弱节点数，语气随成熟度变化（持久化但不做重养成）
  function careCount(){ return Number(localStorage.getItem("knoworigin_hxt_cared")||0); }
  function bumpCared(){
    localStorage.setItem("knoworigin_hxt_cared", String(careCount()+1));
    st.caredToday++;
    diaryTodayUpsert({ cared: st.caredToday });
  }
  function readCared(){ var c=careCount(); return c>=4?"已经帮你照看了不少海棠，你这园丁当得可以呀。": c>=1?("看你又浇活了一株，海小棠觉得你这园丁有模有样。") : null; }

  function pickCareNode(){
    var d = st.derived; if (!d || !d.weakTops || !d.weakTops.length) return null;
    for (var i=0;i<d.weakTops.length;i++){ var el=graphNodeEl(d.weakTops[i].id); if (el) return {n:d.weakTops[i], el:el}; }
    return null;
  }
  function openCare(){
    if (st.muted || st.focus || st.tour.active) return;
    setPosture("interact"); SFX.care();
    clearTourFlags();
    var c = pickCareNode();
    if (!c){
      var empty = !st.nodes || !st.nodes.length;
      showBubble({ ic: empty?"🌱":"🌸", t:"海小棠", m: empty ? "园子还空着～先去左侧上传资料、生成知识框架，我的海棠园才会长出花来。" : "园子里暂时没有要浇水的小海棠，状态不错——想逛就对我说「陪游图谱」。" });
      setTimeout(hideBubble,7000); return;
    }
    var n = c.n;
    glideToNode(c.el, "interact");
    flagNode(c.el,"hxt-care-ring",true);
    showMenu([
      { ic:"💧", label:"带我补回来", act:function(){ helpNode(n); } },
      { ic:"🍃", label:"稍后我自己来", act:function(){ flagNode(c.el,"hxt-care-ring",false); } },
    ]);
    var grow = readCared();
    els.btTitle.textContent = "💧 海小棠 · 浇园关照";
    els.btMsg.textContent = "这株「"+truncate(n.name,14)+"」"+nodeStatusTxt(n)+"，"+ (grow?grow:"要不要我陪你把它浇开？");
  }
  function maybeOpenCare(){
    // 低噪声去重：2 小时内不重复弹关照，避免每次切视图都打扰
    var k = "knoworigin_hxt_care_at";
    var last = Number(localStorage.getItem(k)||0);
    if (Date.now() - last < 2*3600*1000) return false;
    localStorage.setItem(k, String(Date.now()));
    openCare();
    return true;
  }

  // —— 模块三 · 双链探链（双链图谱专属） ——
  st.probe = false; st._probeBound = false;
  function buildEdgeMap(){
    // 边 = parent_id 层级 + wikilinks 名称匹配；返回 { id:Set(neighborId) }
    var byId={}; st.nodes.forEach(function(n){byId[n.node_id]=n;});
    var nameIdx={}; st.nodes.forEach(function(n){ if(n.name) nameIdx[String(n.name).trim()]=n.node_id; });
    var adj={}; st.nodes.forEach(function(n){ adj[n.node_id]={set:{}, arr:[]}; });
    st.nodes.forEach(function(n){
      if (n.parent_id && adj[n.parent_id]) linkAdj(adj,n.node_id,n.parent_id);
      (n.wikilinks||[]).forEach(function(w){
        var name = String(w||"").split("|")[0].trim();
        var tgt = nameIdx[name];
        if (tgt && tgt!==n.node_id) linkAdj(adj, n.node_id, tgt);
      });
    });
    return adj;
  }
  function linkAdj(adj,a,b){ if(adj[a]&&adj[b]){ if(!adj[a].set[b]){adj[a].set[b]=1;adj[a].arr.push(b);} if(!adj[b].set[a]){adj[b].set[a]=1;adj[b].arr.push(a);} } }
  function islands(){
    var adj=buildEdgeMap(); var out=[];
    st.nodes.forEach(function(n){ if(!adj[n.node_id] || !adj[n.node_id].arr.length) out.push(n); });
    return out;
  }
  function toggleProbe(on){
    var next = on!=null ? on : !st.probe;
    st.probe = next;
    bindProbeOnce();
    toast(next?"🔗":"🔍", next?"探链已开：点任意节点，我沿它的链一条条讲给你听，并盯出孤岛。":"已关掉探链讲解。");
    SFX.tap();
    if (next) drawIslandRings(); else clearIslandRings();
  }
  function bindProbeOnce(){
    if (st._probeBound) return; st._probeBound=true;
    var out = document.getElementById("studio-output");
    if (!out) return;
    out.addEventListener("click", function(e){
      if (!st.probe) return;
      var g = e.target.closest ? e.target.closest("g[data-node-id]") : null;
      st._lastProbeEl = null;
      if (!g){ _probeExplain(null); return; }
      st._lastProbeEl = g;
      // 让 app 的默认节点行为照常发生，探链气泡延时补上、不拦截
      clearTimeout(st._probeT); st._probeT = setTimeout(function(){ _probeExplain(g.getAttribute("data-node-id")); }, 450);
    });
  }
  function _probeExplain(nodeId){
    var el = st._lastProbeEl; clearTourFlags();
    // 孤岛高亮恢复
    if (el && nodeId){ flagNode(el,"hxt-tour-active",true); var n=nodesById()[nodeId]; if(!n){toast("🔗","稍等浓度，我先看下这株的状态…");return;} explainNode(n,el); }
  }
  function nodesById(){ var m={}; st.nodes.forEach(function(n){m[n.node_id]=n;}); return m; }
  function explainNode(n, el){
    var adj = buildEdgeMap();
    var nb = (adj[n.node_id]||{}).arr || [];
    var items=[];
    if (nb.length){ items.push({ ic:"🧭", label:"随缘下一位邻居", act:function(){ var t=nb[Math.floor(Math.random()*nb.length)]; var m=nodesById(); if(m[t]){flagNode(el,"hxt-tour-active",false); explainNode(m[t], graphNodeEl(t));} } }); }
    items.push({ ic:"💧", label:"带我去补这株", act:function(){ helpNode(n); } });
    items.push({ ic:"❌", label:"收起探链", act:function(){ clearTourFlags(); } });
    showMenu(items);
    var grow = readCared();
    if (!nb.length){
      els.btTitle.textContent="🏝️ 海小棠 · 孤岛提醒";
      els.btMsg.textContent="「"+truncate(n.name,14)+"」现在和园子里谁都没连着，像是掉队的孤岛。"+(grow||"")+" 要不要我帮你和其他海棠牵上链？";
      return;
    }
    els.btTitle.textContent="🔗 海小棠 · 探链";
    els.btMsg.textContent = "「"+truncate(n.name,14)+"」目前和 "+nb.length+" 株连着。点一个我沿它的链解释，想补就让我带你下钻。";
  }
  function drawIslandRings(){
    clearIslandRings();
    islands().slice(0,4).forEach(function(n){
      var el = graphNodeEl(n.node_id);
      if (el) el.classList.add("hxt-island-ring");
    });
  }
  function clearIslandRings(){
    document.querySelectorAll("#studio-output .hxt-island-ring").forEach(function(el){ el.classList.remove("hxt-island-ring"); });
  }

  // 视图切换：进入知识框架时，歇到图谱留白 + 自动做一次浇园关照
  var _careOnce = false;
  function onFrameworkView(){
    _careOnce = false;
    restMove("framework");
    setTimeout(function(){ if(!_careOnce){ _careOnce=true; maybeOpenCare(); } }, 900);
  }

  // ================= 初始化 =================
  // 创建透明浮空容器（不占文档流、透明背景、可拖拽、吸附）
  var container = document.createElement("div");
  container.id = "hxt-pet";
  container.className = "hxt-hidden";
  container.style.cssText =
    "position:fixed;z-index:2147483000;background:transparent;transition:all .24s cubic-bezier(.2,.8,.2,1);";
  loadPersist();
  container.innerHTML =
    '<div class="hxt-avatar-wrap hxt-stand-full hxt-breathe" id="hxtWrap">' +
    '  <div id="hxtVec" class="hxt-vec"></div>' +
    '  <img id="hxtImg" src="' + IMG.stand + '" alt="海小棠" draggable="false">' +
    '  <div class="hxt-zone hxt-zone-head" data-hxt-zone="head" title="摸摸头"></div>' +
    '  <div class="hxt-zone hxt-zone-body" data-hxt-zone="body" title="戳一戳"></div>' +
    '  <div class="hxt-zone hxt-zone-feet" data-hxt-zone="feet" title="挠痒痒"></div>' +
    '</div>';
  els.wrap = container.querySelector("#hxtWrap");
  els.img = container.querySelector("#hxtImg");
  els.vec = container.querySelector("#hxtVec");
  // 默认走逐帧位图，矢量节点先藏起来（避免空 div 占位）
  if (els.vec && !vecOn()) els.vec.style.display = "none";
  if (els.img) els.img.classList.add("hxt-hd"); // 高清插画帧：平滑渲染

  // ---------- 打开聊天框的入口 UI ----------
  // 以前只能"单击桌宠"才能发现聊天框（还得等 300ms 判双击），新用户基本找不到。
  // 现在桌宠右下角常驻一枚圆形小按钮：悬停展开「找海小棠聊聊」，静音模式下变成 🔇。
  // 位置由 hxt-pet.css 的 .hxt-launcher 控制（2026-09-11 从头顶挪到右下角）。
  var launcher = document.createElement("button");
  launcher.type = "button";
  launcher.className = "hxt-launcher";
  launcher.setAttribute("aria-label", "打开海小棠聊天框");
  launcher.innerHTML = '<span class="hxt-launcher-ic">💬</span><span class="hxt-launcher-tx">找海小棠聊聊</span>';
  launcher.addEventListener("mousedown", function (e) { e.stopPropagation(); }); // 按它不该把她拖走
  launcher.addEventListener("click", function (e) {
    e.stopPropagation();
    if (!st.enabled) return;
    setPosture("interact");
    SFX.pop();
    openDialog();
  });
  container.appendChild(launcher);
  els.launcher = launcher;
  syncMuteUI(); // 让图标/文案反映当前静音状态
  // 休息态背景花瓣层：随机大小/横位/时长/摇摆的粉色花瓣，CSS 无限飘落
  els.petals = document.createElement("div");
  els.petals.id = "hxtPetals";
  els.petals.className = "hxt-petals";
  for (var pi = 0; pi < 10; pi++) {
    var pl = document.createElement("i");
    pl.className = "hxt-petal";
    pl.style.left = (2 + Math.random() * 88) + "%";
    pl.style.width = pl.style.height = (7 + Math.random() * 7) + "px";
    pl.style.animationDuration = (3.2 + Math.random() * 3.4) + "s";
    pl.style.animationDelay = (Math.random() * 4.5) + "s";
    pl.style.setProperty("--sway", (8 + Math.random() * 26) + "px");
    pl.style.setProperty("--o", (0.5 + Math.random() * 0.42).toFixed(2));
    els.petals.appendChild(pl);
  }
  container.appendChild(els.petals);
  document.body.appendChild(container);
  bind();
  pixelBoot(); // 异步加载像素图集，就绪后开始逐帧连续动画
  // 首次定位：自由浮空，默认停在窗口右下角；若之前拖拽过则沿用记忆位置
  var _placedOnce = false;
  function placeFreeInitial(){
    if (_placedOnce) return;
    var w = container.offsetWidth || 120, h = container.offsetHeight || 150;
    var x = (typeof st.x === "number" && !isNaN(st.x)) ? st.x : Math.min(Math.max(8, window.innerWidth - w - 16), window.innerWidth - 24);
    var y = (typeof st.y === "number" && !isNaN(st.y)) ? st.y : Math.max(8, window.innerHeight - h - 16);
    placeFree(x, y, DEFAULT_POSTURE);
    _placedOnce = true;
  }
  placeFreeInitial();
  // ================= 默认在窗口内自由溜达（除非点击/交互时暂停） =================
  // 安静害羞的人设：多数时候安静待着眨眼，每隔一阵在窗口下半区慢慢飘一段，
  // 到站偶尔给一点小反馈。
  // 一旦被点击/悬浮/拖拽/对话框打开等交互，就停下来陪你，9 秒后才继续溜达。
  var _lastAct = Date.now();
  function _noteAct(){ _lastAct = Date.now(); }
  ["mousedown", "touchstart", "keydown", "wheel"].forEach(function (ev) {
    window.addEventListener(ev, _noteAct, { passive: true });
  });
  container.addEventListener("mousedown", _noteAct);
  var WANDER_LINES = [
    "我、我就悄悄挪一小步，不吵你～",
    "这边的风景…也还不错呢。",
    "嘘，我在巡逻小海棠～",
    "你专注的样子，很好看呀。",
    "嗯…挪到这里看得更清楚一点。",
    "别担心，慢慢来，我一直在的。",
  ];
  function wanderPaused(){
    return !st.login || st.focus || st.dozing || st.muted ||
      (els.dialog && !els.dialog.classList.contains("hxt-hidden")) ||
      container.classList.contains("hxt-dragging") ||
      (els.bubble && els.bubble.classList.contains("hxt-show")) ||
      (st.tour && st.tour.active) ||
      (Date.now() - _lastAct < 6000) ||
      (Date.now() - st.lastInteract < 9000);
  }
  function startWander(){
    setInterval(function () {
      // 1) 保持吸附：任何时刻只要处于滑轨模式却偏离了轨（布局变化/展开切换），先贴回去
      if (st.railSnap) {
        var trk = trackRect();
        if (trk) {
          var cr = container.getBoundingClientRect();
          if (Math.abs(cr.top - trk.y) > 4 || st.x < trk.xMin - 4 || st.x > trk.xMax + 4) snapRailY();
        }
      }
      if (wanderPaused()) return;
      var _w = container.offsetWidth || 120, _h = container.offsetHeight || 150;
      var spanW = window.innerWidth - _w - 16, spanH = window.innerHeight - _h - 24;
      if (spanW < _w * 0.6 || spanH < _h) return; // 窗口太窄就不溜达，安静待着
      var cur = container.getBoundingClientRect();
      // 自由浮空：在窗口下半区随机挑个落脚点，慢慢挪过去（不上任何滑轨）
      var targetX = 8 + Math.random() * Math.max(1, spanW - 8);
      var targetY = Math.max(8, Math.min(spanH, window.innerHeight * 0.3 + Math.random() * Math.max(1, spanH * 0.55)));
      if (Math.abs(targetX - cur.left) < _w * 0.6 && Math.abs(targetY - cur.top) < _h * 0.6) return;
      var dur = Math.min(2600, 500 + (Math.abs(targetX - cur.left) + Math.abs(targetY - cur.top)) * 1.2);
      st.x = targetX; st.y = targetY;
      container.setAttribute("data-magnet", "true"); // 柔和磁力滑过去
      vecNode().classList.add("hxt-waddle");          // 小碎步摇摆（避开 hxt-static 的 animation:none）
      pixelPlay("idle");
      container.style.left = targetX + "px";
      container.style.top = targetY + "px";
      setTimeout(function () {
        vecNode().classList.remove("hxt-waddle");
        container.setAttribute("data-magnet", "false");
        // 到站反馈：害羞小动作，偶尔轻轻说一句（安静人设：低频、轻声）
        if (!wanderPaused() && Math.random() < 0.45) {
          playOnce("shy", "hxt-tilt", null, 1200);
          if (Math.random() < 0.12) {
            autoBubble({ ic: ["🌸", "😳", "🌷"][Math.floor(Math.random() * 3)], t: "海小棠",
              m: WANDER_LINES[Math.floor(Math.random() * WANDER_LINES.length)] }, 3000);
          }
        }
      }, dur + 60);
    }, 7000);
  }
  startWander();
  setupPetSettings(); // 把「静音模式」开关挂进设置面板的「陪伴」组
  if (!document.hidden) { fetchStreak(); }
  setInterval(fetchStreak, CONF.pollStreakMs);
  // 校情/学习数据预热
  setInterval(fetchMastery, CONF.pollMasteryMs);
  setInterval(fetchFramework, CONF.pollMasteryMs);

  // ---- 对外小接口：切换形象 / 切换渲染通路 / 静音 / 查看运行状态 ----
  // 控制台里可以：
  //   HXT_PET.setSkin('legacy')  切回初版「粉发蓝衫」存档形象
  //   HXT_PET.setSkin('bloom')   切到「海棠绽放」大花瓣粉裙（默认）
  //   HXT_PET.setVector(true)    位图在某个环境被渲染坏时改用矢量兜底
  //   HXT_PET.setMute(true)      静音模式：不自动冒泡、不出声
  window.HXT_PET = {
    skins: SKINS,
    get skin() { return PIX.skin; },
    get skinLabel() { return (SKINS[PIX.skin] || {}).label || PIX.skin; },
    get framesLoaded() { return PIX.loaded; },
    get action() { return PIX.action; },
    setSkin: function (k) {
      if (!SKINS[k]) { console.warn("[海小棠] 未知形象:", k, "可选:", Object.keys(SKINS)); return false; }
      try { localStorage.setItem("knoworigin_hxt_skin", k); } catch (e) {}
      location.reload();
      return true;
    },
    setVector: function (on) {
      try { localStorage.setItem("knoworigin_hxt_vector", on ? "1" : "0"); } catch (e) {}
      location.reload();
      return true;
    },
    // —— 静音 ——
    mute: function () { return st.muted; },
    setMute: setMuted,
    openChat: openDialog,
    // —— 清单报告 / 冲刺清单里的「问海小棠」入口 ——
    ask: diveByName,
    enhanceChecklistItems: enhanceChecklistItems,
    // —— 气泡节奏（想更安静就把两个数调小） ——
    bubbleConfig: function () { return { minGapMs: CONF.bubbleMinGapMs, maxPerHour: CONF.bubbleMaxPerHour }; },
    setBubbleConfig: function (minGapMs, maxPerHour) {
      if (typeof minGapMs === "number") CONF.bubbleMinGapMs = minGapMs;
      if (typeof maxPerHour === "number") CONF.bubbleMaxPerHour = maxPerHour;
      return { minGapMs: CONF.bubbleMinGapMs, maxPerHour: CONF.bubbleMaxPerHour };
    },
    // —— 平时气泡内容（校情）手动抽一条看看 ——
    tidbit: function () { return pickTidbit(); },
  };
})();