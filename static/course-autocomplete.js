// 天大课程库自动补全：自定义绝对定位下拉，比 <datalist> 显眼得多。
// ponytail: 失败一律静默，绝不影响手输；append 到所在 dialog 内，避开
// 顶层 fixed 元素与 <dialog> top layer 的层级陷阱。
// 2026-09：在每条下拉项右侧加一个「导入」标签，点击触发 onImportTju 回调，
// 由 app.js 弹出文件选择对话框。按钮点击与回填课名互不干扰。
(function () {
  const input = document.getElementById("project-subject");
  if (!input) return;
  const host = input.closest("dialog") || document.body;

  const dropdown = document.createElement("div");
  dropdown.className = "course-autocomplete-dropdown";
  dropdown.setAttribute("role", "listbox");
  dropdown.hidden = true;
  host.appendChild(dropdown);

  let timer = null;
  let cursor = -1;
  let items = [];
  let activeQuery = "";

  // 点击「导入」时的回调，由 app.js 的 setupTjuImportDialog 注入到
  // window.tjuAutocomplete.onImportTju。app.js 与本文件同为 defer 且后执行，
  // 因此必须在点击时实时读取，否则加载期拿到的是空的 no-op。
  function onImportTju(course) {
    const fn = (window.tjuAutocomplete || {}).onImportTju;
    if (typeof fn === "function") fn(course);
  }

  function position() {
    const rect = input.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const top = rect.bottom - hostRect.top + (host === document.body ? window.scrollY : 0);
    const left = rect.left - hostRect.left + (host === document.body ? window.scrollX : 0);
    dropdown.style.left = left + "px";
    dropdown.style.top = top + "px";
    dropdown.style.width = rect.width + "px";
  }

  function show() {
    if (!dropdown.hidden) return;
    position();
    dropdown.hidden = false;
  }
  function hide() {
    dropdown.hidden = true;
    cursor = -1;
    activeQuery = "";
  }

  function highlight(text) {
    if (!activeQuery) return text;
    const idx = text.toLowerCase().indexOf(activeQuery);
    if (idx < 0) return text;
    return (
      text.slice(0, idx) +
      "<mark>" + text.slice(idx, idx + activeQuery.length) + "</mark>" +
      text.slice(idx + activeQuery.length)
    );
  }

  function render(courses) {
    dropdown.textContent = "";
    items = [];
    cursor = -1;
    if (!courses.length) { hide(); return; }
    for (const course of courses) {
      const item = document.createElement("div");
      item.className = "course-autocomplete-item";
      item.setAttribute("role", "option");
      const code = document.createElement("span");
      code.className = "course-autocomplete-code";
      code.textContent = course.code || "";
      const name = document.createElement("span");
      name.className = "course-autocomplete-name";
      name.innerHTML = highlight(course.name);
      const tag = document.createElement("span");
      const disc = course.discipline || "";
      tag.className = "course-autocomplete-tag tag-" + disc.replace(/[^a-z_]/g, "");
      tag.textContent =
        disc === "humanities" ? "文科" :
        disc === "economics_management" ? "经管" :
        disc === "medicine_biology" ? "医/生" : "理工";

      // 「导入」标签：点击后弹文件选择对话框（不触发回填课名）
      const importBtn = document.createElement("button");
      importBtn.type = "button";
      importBtn.className = "course-autocomplete-import";
      importBtn.textContent = "导入";
      importBtn.title = "从 GitHub 课程共享仓库拉取该课程资料（含 PDF/PPT/DOCX 等）";
      importBtn.addEventListener("mousedown", function (e) {
        e.preventDefault();   // 阻止 input blur 关闭下拉
        e.stopPropagation();
        // 先回填课名（让 dialog 标题与项目名称一致），再触发回调
        pick(items.indexOf(item));
        try { onImportTju(course); } catch (_) { /* 回调异常也不破坏 UI */ }
      });
      // 阻止导入按钮上的 click 冒泡到 dropdown，避开顶层 document 的关闭逻辑
      importBtn.addEventListener("click", function (e) { e.stopPropagation(); });

      item.appendChild(code);
      item.appendChild(name);
      item.appendChild(tag);
      item.appendChild(importBtn);
      item.dataset.name = course.name;
      item.dataset.discipline = disc;
      item.dataset.code = course.code || "";
      item.addEventListener("mousedown", function (e) {
        // 导入按钮自己处理 mousedown，其它区域仍走回填
        if (e.target.closest(".course-autocomplete-import")) return;
        // mousedown 而非 click：避免 input blur 先于 click 导致列表消失
        e.preventDefault();
        pick(items.indexOf(item));
      });
      items.push(item);
      dropdown.appendChild(item);
    }
    show();
  }

  function pick(index) {
    if (index < 0 || index >= items.length) return;
    const item = items[index];
    input.value = item.dataset.name || "";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    hide();
  }

  function updateCursor() {
    items.forEach(function (el, i) {
      el.classList.toggle("is-selected", i === cursor);
    });
  }

  input.addEventListener("input", function () {
    if (timer) clearTimeout(timer);
    const q = input.value.trim();
    activeQuery = q.toLowerCase();
    if (q.length < 1) { hide(); return; }
    timer = setTimeout(async function () {
      try {
        const response = await fetch(
          "/api/tju-courses?q=" + encodeURIComponent(q) + "&limit=8",
          { credentials: "same-origin" }
        );
        if (!response.ok) { hide(); return; }
        const data = await response.json();
        if (input.value.trim().toLowerCase() !== activeQuery) return; // 防过期
        render(data.courses || []);
      } catch (_) {
        hide();
      }
    }, 160);
  });

  input.addEventListener("keydown", function (e) {
    if (dropdown.hidden) return;
    if (e.key === "ArrowDown") {
      cursor = Math.min(cursor + 1, items.length - 1);
      updateCursor();
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      cursor = Math.max(cursor - 1, 0);
      updateCursor();
      e.preventDefault();
    } else if (e.key === "Enter" && cursor >= 0) {
      pick(cursor);
      e.preventDefault();
    } else if (e.key === "Escape") {
      hide();
    }
  });

  input.addEventListener("blur", function () {
    setTimeout(hide, 180); // 延迟关闭，给 mousedown 留点击机会
  });
  input.addEventListener("focus", function () {
    if (input.value.trim() && items.length) show();
  });
  window.addEventListener("resize", function () {
    if (!dropdown.hidden) position();
  });
  // 滚 dialog 时跟随
  document.addEventListener("scroll", function () {
    if (!dropdown.hidden) position();
  }, true);
})();
