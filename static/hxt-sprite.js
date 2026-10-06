/* =====================================================
   海小棠 · 纯矢量形象（SVG）· 知源 KnowOrigin
   ------------------------------------------------------
   为什么改用矢量：
   1. 没有位图 → 不存在透明通道被压扁导致的「黑底方块」
   2. 没有裁剪框 → 不存在「左右切割 / 隐藏热区」
   3. 所有动作共用 120×150 的 viewBox → 尺寸绝对统一，切换不跳变
   4. 形象是代码 → 改颜色/表情不用重新出图，也不受缓存影响
   ------------------------------------------------------
   画布约定：viewBox "0 0 120 150"，底边 y=150 为「滑轨线」，
   两只爪子搭/抓在这条线上（cy≈143，爪尖探到 149），
   所以无论身高怎么缩放，爪子永远扒在聊天框边缘上。
   ===================================================== */
(function () {
  var C = {
    skin: "#fff4f1",
    skinShade: "#ffe6e0",
    hair: "#f6a7c0",
    hairDark: "#e8809f",
    petal: "#ffc4d6",
    petalDeep: "#ff9fbb",
    petalCore: "#ffd35c",
    leaf: "#7ec98a",
    dress: "#f8b8cc",
    dressLight: "#ffdbe6",
    collar: "#ffffff",
    bow: "#7a5560",
    eye: "#4a3540",
    blush: "#ff92b0",
    line: "#c9708c",
  };

  // ---------- 公共零件 ----------
  // 海棠花头饰（5 瓣 + 花心 + 两片叶）
  function flower(cx, cy, r) {
    var s = "";
    for (var i = 0; i < 5; i++) {
      var a = -90 + i * 72;
      var x = cx + Math.cos(a * Math.PI / 180) * r * 0.78;
      var y = cy + Math.sin(a * Math.PI / 180) * r * 0.78;
      s += '<ellipse cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" rx="' + (r * 0.46).toFixed(1) +
        '" ry="' + (r * 0.36).toFixed(1) + '" fill="' + C.petal +
        '" stroke="' + C.petalDeep + '" stroke-width="1.1" transform="rotate(' + (a + 90) + ' ' + x.toFixed(1) + ' ' + y.toFixed(1) + ')"/>';
    }
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + (r * 0.24).toFixed(1) + '" fill="' + C.petalCore + '"/>';
    return s;
  }
  function leaves(cx, cy) {
    return '<ellipse cx="' + (cx - 13) + '" cy="' + (cy + 6) + '" rx="7" ry="4" fill="' + C.leaf +
      '" transform="rotate(-24 ' + (cx - 13) + ' ' + (cy + 6) + ')"/>' +
      '<ellipse cx="' + (cx + 13) + '" cy="' + (cy + 6) + '" rx="7" ry="4" fill="' + C.leaf +
      '" transform="rotate(24 ' + (cx + 13) + ' ' + (cy + 6) + ')"/>';
  }
  // 眼睛：mode = open | happy(弯弯) | closed(睡着) | down(害羞下看) | side(思考)
  function eyes(mode) {
    var y = 66;
    if (mode === "happy") {
      return '<g class="hxt-v-eye">' +
        '<path d="M44 ' + y + ' q6 -7 12 0" fill="none" stroke="' + C.eye + '" stroke-width="3" stroke-linecap="round"/>' +
        '<path d="M64 ' + y + ' q6 -7 12 0" fill="none" stroke="' + C.eye + '" stroke-width="3" stroke-linecap="round"/>' +
        '</g>';
    }
    if (mode === "closed") {
      return '<g class="hxt-v-eye">' +
        '<path d="M44 ' + y + ' q6 6 12 0" fill="none" stroke="' + C.eye + '" stroke-width="3" stroke-linecap="round"/>' +
        '<path d="M64 ' + y + ' q6 6 12 0" fill="none" stroke="' + C.eye + '" stroke-width="3" stroke-linecap="round"/>' +
        '</g>';
    }
    if (mode === "side") {
      return '<g class="hxt-v-eye">' +
        '<ellipse cx="50" cy="' + y + '" rx="4.6" ry="6" fill="' + C.eye + '"/>' +
        '<ellipse cx="74" cy="' + y + '" rx="4.6" ry="6" fill="' + C.eye + '"/>' +
        '<circle cx="52.6" cy="' + (y - 2) + '" r="1.5" fill="#fff"/>' +
        '<circle cx="76.6" cy="' + (y - 2) + '" r="1.5" fill="#fff"/>' +
        '</g>';
    }
    if (mode === "down") {
      return '<g class="hxt-v-eye">' +
        '<ellipse cx="50" cy="' + (y + 1) + '" rx="4.6" ry="5.4" fill="' + C.eye + '"/>' +
        '<ellipse cx="74" cy="' + (y + 1) + '" rx="4.6" ry="5.4" fill="' + C.eye + '"/>' +
        '<circle cx="48" cy="' + (y - 1.5) + '" r="1.5" fill="#fff"/>' +
        '<circle cx="72" cy="' + (y - 1.5) + '" r="1.5" fill="#fff"/>' +
        '</g>';
    }
    // open（默认）：圆眼 + 高光
    return '<g class="hxt-v-eye">' +
      '<ellipse cx="50" cy="' + y + '" rx="5" ry="6.4" fill="' + C.eye + '"/>' +
      '<ellipse cx="74" cy="' + y + '" rx="5" ry="6.4" fill="' + C.eye + '"/>' +
      '<circle cx="48" cy="' + (y - 2) + '" r="1.8" fill="#fff"/>' +
      '<circle cx="72" cy="' + (y - 2) + '" r="1.8" fill="#fff"/>' +
      '<circle cx="52" cy="' + (y + 2.6) + '" r="1" fill="#fff" opacity=".75"/>' +
      '<circle cx="76" cy="' + (y + 2.6) + '" r="1" fill="#fff" opacity=".75"/>' +
      '</g>';
  }
  function blush(strong) {
    var o = strong ? 0.75 : 0.45, r = strong ? 7.5 : 6;
    return '<ellipse cx="36" cy="78" rx="' + r + '" ry="' + (r * 0.58).toFixed(1) + '" fill="' + C.blush + '" opacity="' + o + '"/>' +
      '<ellipse cx="88" cy="78" rx="' + r + '" ry="' + (r * 0.58).toFixed(1) + '" fill="' + C.blush + '" opacity="' + o + '"/>';
  }
  function mouth(kind) {
    if (kind === "o") return '<ellipse cx="62" cy="82" rx="3" ry="3.6" fill="' + C.eye + '" opacity=".8"/>';
    if (kind === "w") return '<path d="M57 81 q5 5 10 0" fill="none" stroke="' + C.eye + '" stroke-width="2.4" stroke-linecap="round"/>';
    return '<path d="M57 81 q5 4.5 10 0" fill="none" stroke="' + C.eye + '" stroke-width="2.2" stroke-linecap="round"/>';
  }
  // 头部（含头发、花、五官）—— 可整体微调角度
  function head(eyeMode, mouthKind, blushStrong, tilt) {
    var t = tilt ? ' transform="rotate(' + tilt + ' 60 62)"' : '';
    return '<g' + t + '>' +
      // 后发
      '<circle cx="60" cy="62" r="34" fill="' + C.hair + '"/>' +
      // 脸
      '<ellipse cx="60" cy="66" rx="27" ry="25" fill="' + C.skin + '"/>' +
      // 刘海
      '<path d="M33 58 q6 -26 27 -26 q21 0 27 26 q-8 -12 -14 -8 q-6 -12 -13 -6 q-9 -6 -13 6 q-8 -4 -14 8z" fill="' + C.hair + '"/>' +
      '<path d="M36 52 q10 -8 20 -6" fill="none" stroke="' + C.hairDark + '" stroke-width="1.6" stroke-linecap="round" opacity=".5"/>' +
      // 头饰：海棠花 + 叶
      leaves(84, 30) +
      flower(84, 30, 15) +
      // 五官
      eyes(eyeMode) + blush(blushStrong) + mouth(mouthKind) +
      '</g>';
  }
  // 身体 + 围领 + 蝴蝶结
  function body(squash) {
    var ry = squash ? 20 : 24, cy = squash ? 118 : 112;
    return '<g>' +
      '<ellipse cx="60" cy="' + cy + '" rx="27" ry="' + ry + '" fill="' + C.dress + '"/>' +
      '<path d="M33 ' + (cy + 6) + ' q27 14 54 0 q-6 14 -27 14 q-21 0 -27 -14z" fill="' + C.dressLight + '"/>' +
      // 围领
      '<path d="M47 92 q13 9 26 0 q-3 -7 -13 -7 q-10 0 -13 7z" fill="' + C.collar + '"/>' +
      // 蝴蝶结
      '<path d="M60 97 l-7 -4 v9z" fill="' + C.bow + '"/>' +
      '<path d="M60 97 l7 -4 v9z" fill="' + C.bow + '"/>' +
      '<circle cx="60" cy="97" r="2.2" fill="' + C.bow + '"/>' +
      '</g>';
  }
  // 手臂：从身体伸向爪子（side: left/right）
  function arm(side, toY, lift) {
    var x1 = side === "l" ? 40 : 80, x2 = side === "l" ? 30 : 90;
    if (lift) {
      return '<path d="M' + x1 + ' 108 q' + (side === "l" ? -14 : 14) + ' -10 ' + (side === "l" ? -18 : 18) + ' -22" ' +
        'fill="none" stroke="' + C.skin + '" stroke-width="9" stroke-linecap="round"/>';
    }
    return '<path d="M' + x1 + ' 108 q' + (side === "l" ? -8 : 8) + ' 18 ' + (x2 - x1) + ' ' + (toY - 108) + '" ' +
      'fill="none" stroke="' + C.skin + '" stroke-width="9" stroke-linecap="round"/>';
  }
  // 爪子：扒在底边（y≈143），带 3 个小趾；lift 时抬起来
  function paw(cx, cy, cls) {
    return '<g class="' + (cls || "") + '">' +
      '<ellipse cx="' + cx + '" cy="' + cy + '" rx="11" ry="7.5" fill="' + C.skin + '" stroke="' + C.skinShade + '" stroke-width="1.2"/>' +
      '<circle cx="' + (cx - 5) + '" cy="' + (cy + 3) + '" r="2.6" fill="' + C.skinShade + '"/>' +
      '<circle cx="' + cx + '" cy="' + (cy + 4.4) + '" r="2.6" fill="' + C.skinShade + '"/>' +
      '<circle cx="' + (cx + 5) + '" cy="' + (cy + 3) + '" r="2.6" fill="' + C.skinShade + '"/>' +
      '</g>';
  }

  // ---------- 动作定义 ----------
  // 所有动作都在同一 120×150 画布里，爪子统一落在 y≈143，保证尺寸一致
  var POSES = {
    // 扒着聊天框边缘（默认）：两只爪子抓边，眼睛偶尔眨
    clutch: function () {
      return head("open", "smile", false, 0) + body(false) +
        arm("l", 140) + arm("r", 140) +
        '<g class="hxt-v-pawL">' + paw(31, 143, "") + '</g>' +
        '<g class="hxt-v-pawR">' + paw(93, 143, "") + '</g>';
    },
    // 站立：与 clutch 同尺寸，只是身体挺拔一点点、爪子仍搭在轨上
    idle: function () {
      return head("open", "smile", false, 0) + body(false) +
        arm("l", 140) + arm("r", 140) +
        '<g class="hxt-v-pawL">' + paw(31, 143, "") + '</g>' +
        '<g class="hxt-v-pawR">' + paw(93, 143, "") + '</g>';
    },
    // 开心：弯弯眼 + 举一只爪子欢呼
    happy: function () {
      return head("happy", "w", true, 0) + body(false) +
        arm("r", 0, true) +
        '<g class="hxt-v-wave">' + paw(104, 84, "") + '</g>' +
        arm("l", 140) +
        '<g class="hxt-v-pawL">' + paw(31, 143, "") + '</g>';
    },
    // 害羞：脸更红、眼帘下垂、一只爪子贴脸
    shy: function () {
      return head("down", "smile", true, -4) + body(false) +
        arm("r", 0, true) +
        '<g class="hxt-v-shypaw">' + paw(96, 88, "") + '</g>' +
        arm("l", 140) +
        '<g class="hxt-v-pawL">' + paw(31, 143, "") + '</g>';
    },
    // 思考：眼睛看向一侧，一只爪子托腮
    think: function () {
      return head("side", "smile", false, 3) + body(false) +
        arm("r", 0, true) +
        '<g>' + paw(94, 92, "") + '</g>' +
        arm("l", 140) +
        '<g class="hxt-v-pawL">' + paw(31, 143, "") + '</g>';
    },
    // 休息/侧坐：身体压扁，眯眼微笑
    rest: function () {
      return head("happy", "smile", false, 0) + body(true) +
        arm("l", 140) + arm("r", 140) +
        '<g class="hxt-v-pawL">' + paw(30, 143, "") + '</g>' +
        '<g class="hxt-v-pawR">' + paw(94, 143, "") + '</g>';
    },
    // 睡觉：闭眼 + Zzz
    sleep: function () {
      return head("closed", "smile", false, -6) + body(true) +
        arm("l", 140) + arm("r", 140) +
        '<g class="hxt-v-pawL">' + paw(30, 143, "") + '</g>' +
        '<g class="hxt-v-pawR">' + paw(94, 143, "") + '</g>' +
        '<text x="96" y="46" font-size="13" fill="' + C.hairDark + '" class="hxt-v-zzz">z</text>' +
        '<text x="106" y="34" font-size="10" fill="' + C.hairDark + '" class="hxt-v-zzz" style="animation-delay:.6s">z</text>';
    },
  };

  var W = 120, H = 150;
  function svg(action) {
    var f = POSES[action] || POSES.clutch;
    return '<svg class="hxt-v-svg" viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" ' +
      'shape-rendering="geometricPrecision" aria-label="海小棠">' +
      '<g class="hxt-v-body">' + f() + '</g>' +
      '</svg>';
  }

  window.HXT_SPRITE = {
    W: W, H: H,
    ratio: W / H,   // 0.8 —— 所有动作统一宽高比
    svg: svg,
    poses: Object.keys(POSES),
  };
})();
