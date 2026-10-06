/* ==================== 提示词实验室（可编辑 · 可重置） ====================
   收录知源的全部 AI 任务（数量以 core/prompt_catalog.py 的目录为准，勿在文案里写死），
   每个任务一段 system prompt。这个面板把它们摆出来，让「AI 是怎么被问的」可读、可核对，
   并且能就地改写。

   设计底线：**与实际调用同源**。
   面板读到、改到的就是真正发给模型的那一份（端点走 llm._system_prompt，
   与真实调用同一条路）。改写保存后立即对该任务的真实调用生效；
   随时可「重置为默认」，回到 core/llm.py 的出厂提示词。

   入口：设置 → AI 透明度 → 提示词实验室。
   ============================================================= */

(function () {
  var esc = (typeof window.escapeHtml === "function")
    ? window.escapeHtml
    : function (s) {
        return String(s == null ? "" : s)
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
      };

  var state = {
    groups: [],
    tasks: [],
    active: "",
    loaded: false,
    promptCache: {},
  };

  function ensureDialog() {
    var dialog = document.getElementById("prompt-lab-dialog");
    if (dialog) return dialog;
    dialog = document.createElement("dialog");
    dialog.id = "prompt-lab-dialog";
    dialog.className = "node-detail-dialog prompt-lab-dialog";
    dialog.setAttribute("aria-labelledby", "prompt-lab-title");
    dialog.innerHTML = ''
      + '<article class="node-detail">'
      + '<header class="node-detail-heading"><div>'
      + '<p class="eyebrow">可编辑 · 与实际调用同源</p>'
      + '<h3 id="prompt-lab-title">提示词实验室</h3></div>'
      + '<button class="node-detail-close" type="button" data-prompt-lab-close aria-label="关闭">×</button>'
      + '</header>'
      + '<p class="prompt-lab-lede">知源本地不跑模型，所有「理解」类工作都交给模型完成。'
      + '下面是每个 AI 任务实际使用的 system prompt —— 看到的就是真正发给模型的那一份；'
      + '你可以就地改写，保存后立即对该任务的真实调用生效，随时可重置回默认。</p>'
      + '<div class="prompt-lab-body">'
      + '<nav class="prompt-lab-list" aria-label="AI 任务清单"><p class="prompt-lab-empty">正在加载任务清单…</p></nav>'
      + '<section class="prompt-lab-detail" aria-live="polite">'
      + '<p class="prompt-lab-empty">从左边选一个任务，查看它的提示词。</p>'
      + '</section>'
      + '</div>'
      + '</article>';
    document.body.appendChild(dialog);
    dialog.querySelectorAll("[data-prompt-lab-close]").forEach(function (btn) {
      btn.addEventListener("click", function () { try { dialog.close(); } catch (_) { dialog.remove(); } });
    });
    return dialog;
  }

  function listMarkup() {
    if (!state.tasks.length) return '<p class="prompt-lab-empty">没有取到任务清单。</p>';
    var byGroup = {};
    state.tasks.forEach(function (t) {
      if (!byGroup[t.group]) byGroup[t.group] = [];
      byGroup[t.group].push(t);
    });
    var order = state.groups.length ? state.groups : Object.keys(byGroup);
    var html = "";
    order.forEach(function (g) {
      var items = byGroup[g];
      if (!items || !items.length) return;
      html += '<div class="prompt-lab-group">';
      html += '<p class="prompt-lab-group-title">' + esc(g) + '</p>';
      items.forEach(function (t) {
        var active = t.task === state.active ? " is-active" : "";
        var merged = t.merged_into ? " is-merged" : "";
        html += '<button class="prompt-lab-item' + active + merged + '" type="button" data-prompt-task="' + esc(t.task) + '">'
          + '<span class="prompt-lab-item-label">' + esc(t.label)
          + (t.merged_into ? '<span class="prompt-lab-item-flag">已并入</span>' : '') + '</span>'
          + '<span class="prompt-lab-item-task">' + esc(t.task) + '</span>'
          + '</button>';
      });
      html += '</div>';
    });
    return html;
  }

  // 这段提示词归谁管：决定「在这里改了到底发不发得出去」。
  // system=在 core/llm.py，所见即所用；payload=主指令随内容下发；
  // external=调用方自己拼 messages，这里改了也发不出去 —— 必须说清楚，不让人白改。
  // 没有独立调用点的任务：把并入到哪个任务说清楚 —— 是「这个任务」没被调用，
  // 不是「这个功能」没了，别写成停用/下线。
  function labelOf(task) {
    var hit = null;
    state.tasks.forEach(function (t) {
      if (t.task === task) hit = t;
    });
    return hit ? hit.label : task;
  }

  function sourceNotice(meta) {
    if (meta.retired) {
      var into = meta.merged_into ? "，功能由「" + esc(labelOf(meta.merged_into)) + "」承担" : "";
      return '<p class="prompt-lab-notice is-merged">这个任务现在没有独立调用点'
        + into + '。功能本身仍在，只是换了实现 —— 这里的提示词保留备用，改它对当前功能不生效。</p>';
    }
    if (meta.source === "external") {
      return '<p class="prompt-lab-notice is-external">这个任务的提示词由调用方自己拼装'
        + '（要带上本次的人设与上下文），不走实验室这条链路 —— 在这里改写的 system prompt '
        + '<strong>不会</strong>发给模型。要改真正的提示词，请到对应的调用模块。</p>';
    }
    if (meta.source === "payload") {
      return '<p class="prompt-lab-notice is-payload">主导指令随每次请求的具体内容一起下发'
        + '（payload 里的 system_prompt / instruction），因为里面要带上本次要处理的句子或篇章。'
        + '下面这份是它的 system 人设 —— 你改它会生效，但命题要求以调用方那份为准。</p>';
    }
    if (!meta.has_dedicated_prompt) {
      return '<p class="prompt-lab-notice">这个任务在 core/llm.py 里没有专用分支，'
        + '模型只收到一句通用人设加 JSON 输出协议。</p>';
    }
    return "";
  }

  function detailMarkup(meta) {
    var badges = "";
    if (meta.retired) {
      badges += '<span class="prompt-lab-badge is-merged">已并入</span>';
    } else if (meta.source === "external") {
      badges += '<span class="prompt-lab-badge is-external">不在本链路</span>';
    } else if (meta.source === "payload") {
      badges += '<span class="prompt-lab-badge is-payload">指令随内容下发</span>';
    } else if (meta.has_dedicated_prompt) {
      badges += '<span class="prompt-lab-badge is-ok">专用提示词</span>';
    } else {
      badges += '<span class="prompt-lab-badge is-missing">落到通用兜底人设</span>';
    }
    if (meta.is_overridden) {
      badges += '<span class="prompt-lab-badge is-edited">已改写</span>';
    }
    var isDefault = meta.system_prompt === meta.default_system_prompt;
    var resetDisabled = isDefault && !meta.is_overridden;
    var stream = meta.streaming_prompt && meta.streaming_prompt !== meta.system_prompt
      ? '<details class="prompt-lab-stream"><summary>流式问答用的变体（去掉了「只返回 JSON」协议，以便逐字渲染）</summary>'
        + '<pre class="prompt-lab-pre">' + esc(meta.streaming_prompt) + '</pre></details>'
      : "";
    return ''
      + '<header class="prompt-lab-detail-head">'
      + '<div><h4>' + esc(meta.label) + '</h4>'
      + '<p class="prompt-lab-detail-task">' + esc(meta.task) + '　·　' + esc(meta.group) + '</p></div>'
      + '<div class="prompt-lab-badges">' + badges + '</div>'
      + '</header>'
      + '<p class="prompt-lab-desc">' + esc(meta.desc) + '</p>'
      + sourceNotice(meta)
      + '<div class="prompt-lab-pre-head"><span>system prompt　' + meta.system_prompt.length + ' 字'
      + (meta.is_overridden ? '　·　已改写，对该任务真实调用生效' : '　·　出厂默认') + '</span>'
      + '<span class="prompt-lab-pre-actions">'
      + '<button class="mini-button" type="button" data-prompt-lab-copy>复制</button>'
      + '<button class="mini-button prompt-lab-reset" type="button" data-prompt-lab-reset'
      + (resetDisabled ? ' disabled' : '') + '>重置为默认</button>'
      + '<button class="mini-button" type="button" data-prompt-lab-save disabled>保存修改</button>'
      + '</span></div>'
      + '<textarea class="prompt-lab-editor' + (meta.is_overridden ? ' is-overridden' : '')
      + '" data-prompt-editor spellcheck="false" aria-label="编辑 system prompt">'
      + esc(meta.system_prompt) + '</textarea>'
      + stream;
  }

  function renderList(dialog) {
    var nav = dialog.querySelector(".prompt-lab-list");
    if (nav) nav.innerHTML = listMarkup();
  }

  function renderDetail(dialog, html) {
    var box = dialog.querySelector(".prompt-lab-detail");
    if (box) box.innerHTML = html;
  }

  function selectTask(dialog, task) {
    state.active = task;
    renderList(dialog);
    if (state.promptCache[task]) {
      renderDetail(dialog, detailMarkup(state.promptCache[task]));
      return;
    }
    renderDetail(dialog, '<p class="prompt-lab-empty">正在读取提示词…</p>');
    window.api("/api/prompts/preview?task=" + encodeURIComponent(task))
      .then(function (meta) {
        state.promptCache[task] = meta;
        if (state.active === task) renderDetail(dialog, detailMarkup(meta));
      })
      .catch(function (error) {
        renderDetail(dialog, '<p class="prompt-lab-empty">读取失败：' + esc(error && error.message ? error.message : error) + '</p>');
      });
  }

  async function loadCatalog(dialog) {
    try {
      var data = await window.api("/api/prompts/tasks");
      state.groups = data.groups || [];
      state.tasks = data.tasks || [];
      state.loaded = true;
      renderList(dialog);
      if (state.tasks.length) selectTask(dialog, state.tasks[0].task);
    } catch (error) {
      renderList(dialog);
      renderDetail(dialog, '<p class="prompt-lab-empty">取不到任务清单：' + esc(error && error.message ? error.message : error) + '</p>');
    }
  }

  function activeDialog() {
    return document.getElementById("prompt-lab-dialog");
  }

  function editorValue(dialog) {
    var box = dialog && dialog.querySelector("[data-prompt-editor]");
    return box ? box.value : "";
  }

  // 保存按钮：与载入值一致或内容为空时禁用；重置按钮：已等于默认时禁用。
  function syncEditorButtons(dialog) {
    var meta = state.promptCache[state.active];
    if (!meta || !dialog) return;
    var value = editorValue(dialog);
    var saveBtn = dialog.querySelector("[data-prompt-lab-save]");
    var resetBtn = dialog.querySelector("[data-prompt-lab-reset]");
    if (saveBtn) saveBtn.disabled = value === meta.system_prompt || !value.trim();
    if (resetBtn) resetBtn.disabled = value === meta.default_system_prompt && !meta.is_overridden;
  }

  function reloadTask(dialog, task) {
    delete state.promptCache[task];
    selectTask(dialog, task);
  }

  function postPrompt(url, body) {
    return window.api(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function notify(message) {
    if (typeof showToast === "function") showToast(message);
  }

  // 设置页入口卡片上的「N 个 AI 任务」：数字跟目录走，不写死 —— 写死必漂移
  //（2026-09-28 目录都到 54 了，卡片还写着 36）。未登录时 401，静默放弃即可。
  function refreshEntryCount() {
    window.api("/api/prompts/tasks")
      .then(function (data) {
        var count = (data && data.tasks ? data.tasks.length : 0);
        if (!count) return;
        document.querySelectorAll("[data-prompt-lab-count]").forEach(function (el) {
          el.textContent = String(count);
        });
      })
      .catch(function () { /* 未登录 / 离线：保持占位数字，不弹错 */ });
  }

  function open() {
    var dialog = ensureDialog();
    // 每次打开都重新拉一次，避免加了新任务后清单过期
    state.loaded = false;
    state.active = "";
    state.promptCache = {};
    try { dialog.showModal(); } catch (_) { dialog.setAttribute("open", ""); }
    loadCatalog(dialog);
  }

  document.addEventListener("input", function (event) {
    if (event.target && event.target.closest && event.target.closest("[data-prompt-editor]")) {
      syncEditorButtons(activeDialog());
    }
  });

  document.addEventListener("click", function (event) {
    if (event.target.closest("#settings-prompt-lab-button")) {
      event.preventDefault();
      var settings = document.getElementById("settings-dialog");
      if (settings && settings.open) { try { settings.close(); } catch (_) { /* 忽略 */ } }
      open();
      return;
    }
    var taskBtn = event.target.closest("[data-prompt-task]");
    if (taskBtn) {
      var dialog = activeDialog();
      if (dialog) selectTask(dialog, taskBtn.dataset.promptTask);
      return;
    }
    var copyBtn = event.target.closest("[data-prompt-lab-copy]");
    if (copyBtn) {
      var copyDialog = activeDialog();
      var text = editorValue(copyDialog);
      var done = function () { notify("已复制该任务的 system prompt"); };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(function () {
            notify("复制失败，可手动选中复制");
          });
        } else {
          notify("当前环境不支持自动复制，可手动选中复制");
        }
      } catch (_) { /* 忽略 */ }
      return;
    }
    var saveBtn = event.target.closest("[data-prompt-lab-save]");
    if (saveBtn) {
      var saveDialog = activeDialog();
      var saveMeta = state.promptCache[state.active];
      if (!saveDialog || !saveMeta || saveBtn.disabled) return;
      var value = editorValue(saveDialog);
      saveBtn.disabled = true;
      postPrompt("/api/prompts/override", { task: saveMeta.task, prompt: value })
        .then(function () {
          notify("已保存，对该任务的真实调用生效");
          reloadTask(saveDialog, saveMeta.task);
        })
        .catch(function (error) {
          notify("保存失败：" + (error && error.message ? error.message : error));
          syncEditorButtons(saveDialog);
        });
      return;
    }
    var resetBtn = event.target.closest("[data-prompt-lab-reset]");
    if (resetBtn) {
      var resetDialog = activeDialog();
      var resetMeta = state.promptCache[state.active];
      if (!resetDialog || !resetMeta || resetBtn.disabled) return;
      if (!window.confirm("重置为默认？将放弃对该任务的改写，恢复出厂提示词。")) return;
      resetBtn.disabled = true;
      postPrompt("/api/prompts/reset", { task: resetMeta.task })
        .then(function () {
          notify("已重置为默认提示词");
          reloadTask(resetDialog, resetMeta.task);
        })
        .catch(function (error) {
          notify("重置失败：" + (error && error.message ? error.message : error));
          syncEditorButtons(resetDialog);
        });
      return;
    }
  });

  window.KnowOriginPromptLab = { open: open };

  // 脚本是 defer，执行时 DOM 已就绪；直接刷一次入口数字
  refreshEntryCount();
})();