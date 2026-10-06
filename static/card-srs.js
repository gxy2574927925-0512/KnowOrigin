/* 间隔复习 —— 直接长在知识卡片上。
 *
 * 为什么不做成独立页签：
 *   复习一旦有了自己的页面，就变成"另一个要去的地方"。用户本来就在翻卡片，
 *   顺手评一下才是自然的动作；把人先拽到别处，再让他重新找到同一张卡，
 *   等于给一个本来不存在的步骤收费。
 *
 * 所以这里全部是**在既有卡片上的叠加**，`static/app.js` 一个字不改：
 *   1. 卡片自评（既有 5 档按钮）→ 顺带推进 FSRS 排期
 *   2. 卡片列表 → 直接标出「今天复习 / 3 天后」，到期的加金色描边
 *   3. 卡片正面 → 可选的一句「先说给自己听」，翻面后自动与标准答案对照
 *
 * 硬约束（本项目通用）：
 *   - 不改 app.js / styles.css，不改既有端点签名与行为
 *   - 颜色只写主题变量，自动适配深浅色
 *   - DOM 注入必须**增量**：用户正在输入框里打字时，任何一次全量重建
 *     都会让焦点丢失、字打不进去（本项目已踩过一次同类坑）
 */
(function () {
  "use strict";

  var API = "/api/review";
  var BAR_CLASS = "ko-srs-bar";

  var view = {
    projectId: null,
    status: null,
    loading: false,
    failing: false,
    drafts: {}, // card_id -> 用户写的答案（跨重绘保留，否则打字白打）
    writeOpen: {}, // card_id -> 「先说给自己听」是否展开
    results: {}, // card_id -> 最近一次提交结果（下次间隔）
    previews: {}, // card_id -> 四档各自的下次间隔
    previewLoading: {},
    pending: {}, // card_id -> 上次提交时间戳，防止手抖双击
    onlyDue: false,
    lastCardSig: undefined, // 上次见到的卡片集合签名（id 串），变了就重拉排期
    notifiedFailure: false,
  };

  /* ---------------------------------------------------------------------- */
  /* 基础工具                                                                */
  /* ---------------------------------------------------------------------- */
  function esc(value) {
    var text = value === null || value === undefined ? "" : String(value);
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function call(path, options) {
    if (typeof api === "function") return api(path, options);
    return fetch(path, options).then(function (response) {
      if (!response.ok) throw new Error("请求失败（" + response.status + "）");
      return response.json();
    });
  }

  function notify(text) {
    try {
      if (typeof showToast === "function") showToast(text, { variant: "notice" });
    } catch (error) {
      /* toast 只是锦上添花 */
    }
  }

  // app.js 顶层是 classic script，state 在共享词法环境里，可直接读；
  // 读不到（脚本被单独加载等）时返回 null，各调用点都按"没项目"处理。
  function currentProjectId() {
    try {
      if (typeof state !== "undefined" && state && state.currentProjectId) {
        return String(state.currentProjectId);
      }
    } catch (error) {
      /* ignore */
    }
    return null;
  }

  function currentFeature() {
    try {
      if (typeof state !== "undefined" && state) return state.feature;
    } catch (error) {
      /* ignore */
    }
    return null;
  }

  // 服务端给的 scheduled.days_left 是**日历天差**（整数），
  // 而提交结果的 interval_days 是精确天数。这里把两者显示成同一套说法：
  // 用户要的是"明天还是三天后"，不是"0.9 天后"。
  function formatDays(days) {
    var value = Number(days);
    if (!isFinite(value)) return "";
    if (value < 1) return "今天";
    if (value < 1.5) return "明天";
    if (value < 30) return Math.round(value) + " 天后";
    if (value < 365) return Math.round(value / 30) + " 个月后";
    return (value / 365).toFixed(1) + " 年后";
  }

  /* ---------------------------------------------------------------------- */
  /* 样式                                                                    */
  /* ---------------------------------------------------------------------- */
  function ensureStyle() {
    if (document.getElementById("ko-srs-style")) return;
    var style = document.createElement("style");
    style.id = "ko-srs-style";
    style.textContent = [
      "." + BAR_CLASS + "{display:flex;align-items:center;gap:10px;flex-wrap:wrap;",
      "padding:10px 14px;margin-bottom:12px;border:1px solid var(--line);",
      "border-radius:10px;background:var(--panel);color:var(--ink);font-size:calc(13px * var(--font-scale, 1))}",
      "." + BAR_CLASS + " .ko-srs-text{flex:1 1 220px;line-height:1.6}",
      "." + BAR_CLASS + " .ko-srs-num{color:var(--gold);font-weight:700;padding:0 2px}",
      "." + BAR_CLASS + " .ko-srs-quiet{color:var(--muted)}",
      "." + BAR_CLASS + " button{font:inherit;font-size:calc(12px * var(--font-scale, 1));cursor:pointer;",
      "padding:4px 10px;border-radius:999px;border:1px solid var(--line);",
      "background:transparent;color:var(--ink)}",
      "." + BAR_CLASS + " button:hover{border-color:var(--gold);color:var(--gold)}",
      "." + BAR_CLASS + " button.is-on{background:var(--green);border-color:var(--green);color:#0e1410}",
      ".ko-srs-badge{display:inline-flex;align-items:center;flex:0 0 auto;",
      "padding:1px 8px;border-radius:999px;font-size:calc(11px * var(--font-scale, 1));font-weight:600;",
      "line-height:1.7;border:1px solid var(--line);color:var(--muted);background:transparent}",
      ".ko-srs-badge.is-due{border-color:var(--gold);color:var(--gold)}",
      "article.card.ko-srs-due{outline:2px solid var(--gold);outline-offset:-2px}",
      ".ko-srs-hide{display:none !important}",
      /* 输入框必须显式给底色与字色：深色主题下 UA 默认白底黑字会刺眼 */
      ".ko-srs-write{margin:10px 0 2px}",
      ".ko-srs-write summary{cursor:pointer;font-size:calc(12px * var(--font-scale, 1));color:var(--muted);list-style:none}",
      ".ko-srs-write summary::-webkit-details-marker{display:none}",
      ".ko-srs-write summary:hover{color:var(--gold)}",
      ".ko-srs-write textarea{display:block;width:100%;box-sizing:border-box;",
      "min-height:56px;margin-top:8px;padding:8px 10px;border-radius:8px;",
      "border:1px solid var(--line);background:var(--panel);color:var(--ink);",
      "font:inherit;font-size:calc(13px * var(--font-scale, 1));line-height:1.6;resize:vertical}",
      ".ko-srs-write textarea:focus{outline:none;border-color:var(--gold)}",
      ".ko-srs-mine{margin:0 0 12px;padding:8px 12px;border-left:3px solid var(--gold);",
      "border-radius:0 8px 8px 0;background:var(--panel);font-size:calc(13px * var(--font-scale, 1));line-height:1.6}",
      ".ko-srs-mine-label{display:block;font-size:calc(11px * var(--font-scale, 1));color:var(--muted);margin-bottom:4px}",
      ".ko-srs-mine-body{white-space:pre-wrap;word-break:break-word}",
      ".ko-srs-next{margin:8px 0 0;font-size:calc(12px * var(--font-scale, 1));color:var(--muted)}",
      ".ko-srs-next strong{color:var(--gold);font-weight:600}",
      /* 每档下面那行小字：告诉用户选这一档下次什么时候见 */
      ".ko-srs-eta{display:block;font-size:calc(10px * var(--font-scale, 1));font-weight:400;opacity:.72;margin-top:2px}",
    ].join("");
    document.head.appendChild(style);
  }

  /* ---------------------------------------------------------------------- */
  /* 数据                                                                    */
  /* ---------------------------------------------------------------------- */
  function refreshStatus() {
    var projectId = currentProjectId();
    if (!projectId || view.loading) return;
    view.loading = true;
    call(API + "/status?project_id=" + encodeURIComponent(projectId))
      .then(function (data) {
        // 请求飞在路上时用户切了项目 —— 丢掉这份数据，别污染新项目的角标
        if (currentProjectId() !== projectId) return;
        view.projectId = projectId;
        view.status = data || null;
        view.failing = false;
        decorate();
      })
      .catch(function () {
        if (currentProjectId() !== projectId) return;
        view.failing = true;
        withBar(function (bar) {
          bar.__koSrsHtml = null; // 失败提示不走的 renderBar 口径，清指纹防止恢复后被 diff 跳过
          bar.innerHTML =
            '<span class="ko-srs-text ko-srs-quiet">复习排期暂时读不到（不影响翻卡与掌握度）。</span>';
        });
      })
      .then(function () {
        view.loading = false;
      });
  }

  function dueSet() {
    var set = {};
    var status = view.status;
    if (!status || !status.due_ids) return set;
    status.due_ids.forEach(function (id) {
      set[id] = true;
    });
    return set;
  }

  function scheduledOf(cardId) {
    var status = view.status;
    if (!status || !status.scheduled) return null;
    return status.scheduled[cardId] || null;
  }

  // 提交后立刻更新本地计数，不去重新拉整个状态 —— 用户点完就该看到数字动，
  // 而不是等一个网络往返（那一下的延迟会让"点了没反应"的错觉回来）。
  function applyLocalResult(cardId, result) {
    var status = view.status;
    if (!status) return;
    var wasDue = status.due_ids && status.due_ids.indexOf(cardId) >= 0;
    status.due_ids = (status.due_ids || []).filter(function (id) {
      return id !== cardId;
    });
    if (!result) {
      status.due_count = status.due_ids.length;
      return;
    }
    if (result.replaced_same_day) {
      // 同一天改档位：不是新的一次复习，今日计数不动
    } else if (wasDue || scheduledOf(cardId)) {
      status.reviewed_today = (status.reviewed_today || 0) + 1;
    } else {
      status.new_count = Math.max(0, (status.new_count || 0) - 1);
      status.reviewed_today = (status.reviewed_today || 0) + 1;
    }
    var days = Number(result.interval_days);
    if (isFinite(days) && days > 0.02) {
      status.scheduled = status.scheduled || {};
      status.scheduled[cardId] = {
        due_at: result.due_at,
        days_left: days,
        state: result.state,
        reps: result.reps,
      };
    } else {
      // Again —— 今天还会再见到它，别让用户以为"过关了"
      status.due_ids.push(cardId);
    }
    status.due_count = status.due_ids.length;
  }

  /* ---------------------------------------------------------------------- */
  /* 状态条                                                                  */
  /* ---------------------------------------------------------------------- */
  function withBar(apply) {
    var output = document.getElementById("studio-output");
    if (!output) return;
    var bar = output.querySelector("." + BAR_CLASS);
    if (!bar) {
      bar = document.createElement("div");
      bar.className = BAR_CLASS;
      output.insertBefore(bar, output.firstChild);
    }
    apply(bar);
    return bar;
  }

  function renderBar() {
    var status = view.status;
    if (!status) return;
    var total = Number(status.total_cards) || 0;
    var due = Number(status.due_count) || 0;
    var reviewed = Number(status.reviewed_today) || 0;
    var fresh = Number(status.new_count) || 0;
    var scheduled = Number(status.scheduled_count) || 0;

    var text = "";
    if (due > 0) {
      // 到期分支必须最前：状态是「进项目那一刻」拉的话，total_cards 可能还是生成卡片前的 0，
      // 不能让过期的 total 把「今天该复习 N 张」顶成「还没有卡片可以安排复习」。
      text =
        '今天该复习 <span class="ko-srs-num">' + due + "</span> 张" +
        (reviewed > 0
          ? ' · 今天已复习 <span class="ko-srs-num">' + reviewed + "</span> 张"
          : "") +
        (fresh > 0
          ? ' · <span class="ko-srs-quiet">另有 ' + fresh + " 张新卡</span>"
          : "");
    } else if (total === 0) {
      text = '<span class="ko-srs-quiet">还没有卡片可以安排复习。</span>';
    } else if (scheduled > 0) {
      var soonest = 9999;
      Object.keys(status.scheduled || {}).forEach(function (id) {
        var item = status.scheduled[id];
        var days = Number(item && item.days_left);
        if (isFinite(days) && days < soonest) soonest = days;
      });
      text =
        "今天的复习做完了" +
        (reviewed > 0
          ? "（已复习 <span class=\"ko-srs-num\">" + reviewed + "</span> 张）"
          : "") +
        (soonest < 9999
          ? ' · <span class="ko-srs-quiet">最近一次是 ' + esc(formatDays(soonest)) + "</span>"
          : "");
    } else if (fresh > 0) {
      text =
        '还没有卡片进入复习排期 —— 翻卡后自评一下，就会按记忆规律安排下次。' +
        '<span class="ko-srs-quiet">（' + fresh + " 张新卡）</span>";
    } else {
      text = '<span class="ko-srs-quiet">今天没有到期的卡片。</span>';
    }

    var button =
      due > 0
        ? '<button type="button" data-ko-srs-toggle="due" class="' +
          (view.onlyDue ? "is-on" : "") +
          '">' +
          (view.onlyDue ? "显示全部" : "只看这 " + due + " 张") +
          "</button>"
        : "";

    var html = '<span class="ko-srs-text">' + text + "</span>" + button;
    withBar(function (bar) {
      // 内容没变就绝不碰 DOM：innerHTML 无条件重写会喂给自己挂的 MutationObserver，
      // 观察器拉起 decorate → decorate 再重写 → 状态条（连同按钮）每帧被销毁重建
      //（实测 ~63 次/秒）。按下与抬起之间按钮已不在原位，click 落不到按钮上，
      // 用户看到的就是「点击未生效」。exam-countdown-ui 的 focus 条踩过同一个坑。
      if (bar.__koSrsHtml === html) return;
      bar.__koSrsHtml = html;
      bar.innerHTML = html;
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 卡片装饰（全部增量，绝不重建正在输入的节点）                              */
  /* ---------------------------------------------------------------------- */
  // 各档"下次什么时候见"要问服务端（依赖这张卡当前的实际记忆状态）。
  // 只在**卡片已翻面**时请求 —— 那才是用户真的要评的时候；否则一个 500 张卡
  // 的项目会瞬间打 500 个请求。同一张卡只问一次，结果缓存复用。
  function ensurePreview(cardId) {
    if (view.previews[cardId] || view.previewLoading[cardId]) return;
    view.previewLoading[cardId] = true;
    call(API + "/preview?card_id=" + encodeURIComponent(cardId))
      .then(function (data) {
        view.previews[cardId] = (data && data.intervals) || {};
        decorate();
      })
      .catch(function () {
        // 拿不到就不显示天数，按钮上什么都没有，用户照常能评
        view.previews[cardId] = {};
      })
      .then(function () {
        view.previewLoading[cardId] = false;
      });
  }

  // 既有自评是 5 档，FSRS 是 4 档，映射见 core/review.py::rating_from_recall
  function ratingOfRecall(recall) {
    if (recall <= 1) return "1";
    if (recall === 2) return "2";
    if (recall === 3) return "3";
    return "4";
  }

  function decorateEta(article, cardId) {
    var intervals = view.previews[cardId];
    if (!intervals) return;
    var buttons = article.querySelectorAll(".card-self-rate [data-card-rate]");
    Array.prototype.forEach.call(buttons, function (button) {
      var recall = Number(button.getAttribute("data-card-rate"));
      if (!isFinite(recall)) return;
      var info = intervals[ratingOfRecall(recall)];
      var slot = button.querySelector(".ko-srs-eta");
      if (!info || !isFinite(Number(info.days))) return;
      var text = formatDays(info.days);
      if (!slot) {
        slot = document.createElement("span");
        slot.className = "ko-srs-eta";
        slot.setAttribute("data-ko-srs-part", "eta");
        button.appendChild(slot);
      }
      if (slot.textContent !== text) slot.textContent = text;
    });
  }

  function decorate() {
    if (currentFeature() !== "cards") return;
    if (!view.status) return;
    renderBar();
    var output = document.getElementById("studio-output");
    if (output) {
      var cards = output.querySelectorAll("article.card[data-origin-id]");
      Array.prototype.forEach.call(cards, function (article) {
        try {
          decorateCard(article);
        } catch (error) {
          /* 单张卡片装饰失败不该让整页失效 */
        }
      });
      applyFilter();
      refreshStatusIfCardsChanged(output);
    }
    // 沉浸查看器里有同一组自评按钮（app.js 的 renderCardViewer 生成）——
    // 排期反馈必须跟过去，否则翻面进查看器后，"下次见"这条线就断了
    var viewerBody = document.querySelector("#card-viewer [data-card-viewer-body]");
    if (viewerBody) {
      try {
        decorateViewer(viewerBody);
      } catch (error) {
        /* ignore */
      }
    }
  }

  function decorateViewer(viewerBody) {
    var rateButton = viewerBody.querySelector("[data-card-rate][data-card-id]");
    if (!rateButton) return;
    var cardId = rateButton.getAttribute("data-card-id");
    // 打开查看器 = 用户真的在评这张卡，此时才值得请求各档间隔
    ensurePreview(cardId);
    decorateEta(viewerBody, cardId);
    decorateRateFeedback(viewerBody, cardId);
  }

  function decorateCard(article) {
    var cardId = article.getAttribute("data-origin-id");
    if (!cardId) return;
    var due = !!dueSet()[cardId];
    var item = scheduledOf(cardId);
    var result = view.results[cardId] || null;

    // 1) 到期标记：金色描边（outline 不参与布局，不会把网格挤变形）
    article.classList.toggle("ko-srs-due", due);

    // 2) 角标：今天复习 / 3 天后
    var headingLeft = article.querySelector(".card-heading-left");
    if (headingLeft) {
      var badge = headingLeft.querySelector(".ko-srs-badge");
      var label = "";
      var extraClass = "";
      if (due) {
        label = result ? "今天再来" : "今天复习";
        extraClass = "is-due";
      } else if (item) {
        label = formatDays(item.days_left);
      }
      if (label) {
        if (!badge) {
          badge = document.createElement("span");
          badge.className = "ko-srs-badge";
          headingLeft.appendChild(badge);
        }
        var cls = "ko-srs-badge" + (extraClass ? " " + extraClass : "");
        if (badge.className !== cls) badge.className = cls;
        if (badge.textContent !== label) badge.textContent = label;
      } else if (badge) {
        badge.remove();
      }
    }

    // 3) 正面：可选的一句「先说给自己听」
    //    默认收起 —— 每张卡都展开会让列表长得没法翻，而"先想一下"本身
    //    即使不写也有价值，所以这里只是给想写的人一个顺手的位置。
    var front = article.querySelector(".flip-card-front");
    var cue = front && front.querySelector(".flip-card-cue");
    if (front && cue && !front.querySelector(".ko-srs-write")) {
      var box = document.createElement("details");
      box.className = "ko-srs-write";
      box.setAttribute("data-ko-srs-part", "write");
      if (view.writeOpen[cardId]) box.open = true;
      var summary = document.createElement("summary");
      summary.textContent = "✍ 先说给自己听（可选，写完再翻面）";
      var area = document.createElement("textarea");
      area.setAttribute("data-ko-srs-draft", cardId);
      area.setAttribute("placeholder", "用一句话说清它是什么 —— 说不出来，就是还没记住。");
      area.value = view.drafts[cardId] || "";
      box.appendChild(summary);
      box.appendChild(area);
      front.insertBefore(box, cue);
    }

    // 4) 反面：把"我写的"和标准答案摆在一起（这才是对照）
    var answer = article.querySelector(".card-answer");
    var draft = (view.drafts[cardId] || "").trim();
    if (answer) {
      // 「你写的」要塞进答案正文里（.card-answer 现在是 [展开按钮, 正文] 两段），
      // 放外层会挤在「展开答案」按钮前面
      var answerHost = answer.querySelector(".card-answer-body") || answer;
      var mine = answerHost.querySelector(".ko-srs-mine");
      if (draft) {
        if (!mine) {
          mine = document.createElement("div");
          mine.className = "ko-srs-mine";
          mine.setAttribute("data-ko-srs-part", "mine");
          mine.innerHTML =
            '<span class="ko-srs-mine-label">你写的</span>' +
            '<div class="ko-srs-mine-body"></div>';
          answerHost.insertBefore(mine, answerHost.firstChild);
        }
        var body = mine.querySelector(".ko-srs-mine-body");
        if (body && body.textContent !== draft) body.textContent = draft;
      } else if (mine) {
        mine.remove();
      }
    }

    // 5) 自评之后：告诉用户"下次什么时候见"
    decorateRateFeedback(article, cardId);

    // 6) 已翻面 → 给每一档标出"选它下次什么时候见"。
    //    用户在「会了」和「很熟」之间犹豫时，唯一能帮他决策的信息就是这个。
    if (article.querySelector(".card-self-rate") && article.querySelector(".flip-card-inner.is-flipped")) {
      ensurePreview(cardId);
      decorateEta(article, cardId);
    }
  }

  // "已排期：3 天后再见"这一行。卡片网格与沉浸查看器共用同一套 ——
  // 两个地方都能自评，反馈就不能只在一边出现。
  // 注意插在 .card-self-rate **外面**：既有代码会整块替换那个节点，
  // 放里面会被冲掉（本项目已踩过同类坑）。
  function decorateRateFeedback(container, cardId) {
    var selfRate = container.querySelector(".card-self-rate");
    if (!selfRate) return;
    var result = view.results[cardId] || null;
    var next = container.querySelector(".ko-srs-next");
    if (result) {
      var days = Number(result.interval_days);
      var line = "";
      if (isFinite(days) && days > 0.02) {
        line =
          "已排期：<strong>" +
          esc(formatDays(days)) +
          "</strong>再见（第 " +
          esc(result.reps) +
          " 次复习" +
          (result.is_lapse ? " · 这次没想起来，从头来过" : "") +
          "）";
      } else {
        line = "已排期：<strong>今天还会再见到它</strong> —— 下次翻面时再想一想。";
      }
      if (!next) {
        next = document.createElement("p");
        next.className = "ko-srs-next";
        next.setAttribute("data-ko-srs-part", "next");
        selfRate.insertAdjacentElement("afterend", next);
      }
      if (next.innerHTML !== line) next.innerHTML = line;
    } else if (next) {
      next.remove();
    }
  }

  function applyFilter() {
    var output = document.getElementById("studio-output");
    if (!output) return;
    var set = dueSet();
    var cards = output.querySelectorAll("article.card[data-origin-id]");
    Array.prototype.forEach.call(cards, function (article) {
      var cardId = article.getAttribute("data-origin-id");
      var hide = view.onlyDue && !set[cardId];
      article.classList.toggle("ko-srs-hide", !!hide);
    });
  }

  // 卡片的生成/重生成发生在本模块之外（app.js 一个字不改），而状态只有切项目才重拉 ——
  // 结果是 total_cards 停留在生成之前（比如 0），条上出现「还没有卡片」与
  // 「只看这 N 张」并存的矛盾态。卡片集合一变就重拉一次，数字才能跟上现实。
  function refreshStatusIfCardsChanged(output) {
    if (view.loading) return; // 上一发请求还在路上，等它落地再比，别把过渡态当新集合
    var ids = [];
    var nodes = output.querySelectorAll("article.card[data-origin-id]");
    Array.prototype.forEach.call(nodes, function (node) {
      ids.push(node.getAttribute("data-origin-id"));
    });
    var sig = ids.join("|");
    if (view.lastCardSig === undefined) {
      view.lastCardSig = sig; // 首次只记账：状态刚拉过，不需要再请求
      return;
    }
    if (view.lastCardSig === sig) return;
    view.lastCardSig = sig;
    refreshStatus();
  }

  /* ---------------------------------------------------------------------- */
  /* 事件：卡片自评 → 顺带推进排期                                            */
  /* ---------------------------------------------------------------------- */
  function submitRating(btn) {
    var cardId = btn.getAttribute("data-card-id");
    var recall = Number(btn.getAttribute("data-card-rate"));
    var projectId = currentProjectId();
    if (!cardId || !projectId || !isFinite(recall)) return;

    // 手抖双击：既有的防重复是异步的，这里再加一道纯时间窗
    var now = Date.now();
    if (view.pending[cardId] && now - view.pending[cardId] < 800) return;
    view.pending[cardId] = now;

    var draft = (view.drafts[cardId] || "").trim();
    call(API + "/card-rate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        card_id: cardId,
        recall: recall,
        self_answer: draft,
        elapsed_ms: 0,
      }),
    })
      .then(function (data) {
        if (currentProjectId() !== projectId) return;
        view.results[cardId] = data || {};
        // 状态变了 → 之前算的"各档下次间隔"作废，否则按钮上会留着过期天数
        delete view.previews[cardId];
        applyLocalResult(cardId, data || {});
        decorate();
      })
      .catch(function () {
        // 排期失败不能影响自评本身 —— 掌握度那条路径是独立的，且多半已经成功。
        // 只提一句，别每点一次弹一次（那会盖住掌握度回执，反而更吵）。
        if (!view.notifiedFailure) {
          view.notifiedFailure = true;
          notify("复习排期没记上，掌握度不受影响；下次自评会重试。");
        }
      });
  }

  function onClick(event) {
    var target = event.target;
    if (!target || !target.closest) return;

    if (target.closest("[data-ko-srs-toggle]")) {
      event.preventDefault();
      view.onlyDue = !view.onlyDue;
      renderBar();
      applyFilter();
      return;
    }

    // 捕获阶段拿自评点击：既有处理器会 stopPropagation，
    // 冒泡阶段不一定轮得到我们，而"顺手把它排上期"不该被别人的事件处理挡住。
    var rateBtn = target.closest("[data-card-rate]");
    if (rateBtn) {
      submitRating(rateBtn);
      return;
    }
  }

  function onInput(event) {
    var target = event.target;
    if (!target || !target.getAttribute) return;
    var cardId = target.getAttribute("data-ko-srs-draft");
    if (!cardId) return;
    view.drafts[cardId] = target.value;
  }

  function onChange(event) {
    var target = event.target;
    if (!target || !target.classList) return;
    if (!target.classList.contains("ko-srs-write")) return;
    var article = target.closest("article.card[data-origin-id]");
    if (!article) return;
    var cardId = article.getAttribute("data-origin-id");
    if (cardId) view.writeOpen[cardId] = !!target.open;
  }

  /* ---------------------------------------------------------------------- */
  /* 启动                                                                    */
  /* ---------------------------------------------------------------------- */
  var scheduled = false;
  var lastProjectId = null;

  function tick() {
    var projectId = currentProjectId();
    if (projectId && projectId !== lastProjectId) {
      lastProjectId = projectId;
      // 换项目：排期与结果作废；草稿保留（用户可能是切出去查个东西再回来）
      view.projectId = null;
      view.status = null;
      view.results = {};
      view.onlyDue = false;
      view.lastCardSig = undefined;
      refreshStatus();
      return;
    }
    if (projectId && view.projectId === projectId && currentFeature() === "cards") {
      decorate();
    }
  }

  function onDomChange() {
    if (scheduled) return;
    scheduled = true;
    // 卡片页每次重绘都是整块 innerHTML，用 rAF 合并掉同一帧内的多次变化，
    // 否则一次 renderCards 会触发几十轮 decorate
    requestAnimationFrame(function () {
      scheduled = false;
      try {
        tick();
      } catch (error) {
        /* ignore */
      }
    });
  }

  function boot() {
    ensureStyle();
    document.addEventListener("click", onClick, true);
    document.addEventListener("input", onInput, true);
    document.addEventListener("change", onChange, true);
    try {
      new MutationObserver(onDomChange).observe(document.body, {
        childList: true,
        subtree: true,
      });
    } catch (error) {
      /* 观察器建不起来时，下面的定时器还能兜住 */
    }
    // 兜底：项目切换与"数据加载完成但 DOM 没变"这两种情况未必触发观察器
    setInterval(function () {
      try {
        tick();
      } catch (error) {
        /* ignore */
      }
    }, 2500);
    tick();
  }

  window.KnowOriginCardSrs = {
    refresh: function () {
      view.status = null;
      view.projectId = null;
      refreshStatus();
    },
    status: function () {
      return view.status;
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
