const $ = (selector) => document.querySelector(selector);

document.addEventListener("DOMContentLoaded", init);

async function init() {
  $("#admin-login-form").addEventListener("submit", login);
  $("#refresh-button").addEventListener("click", loadOverview);
  $("#logout-button").addEventListener("click", logout);
  await loadSession();
}

async function loadSession() {
  try {
    const session = await api("/api/admin/session");
    if (!session.enabled) {
      showLogin("管理员密码还没有配置。");
      return;
    }
    if (session.authenticated) {
      showDashboard();
      await loadOverview();
      return;
    }
    showLogin();
  } catch (error) {
    showLogin(error.message);
  }
}

async function login(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const feedback = $("#login-feedback");
  const button = form.querySelector("button");
  feedback.textContent = "";
  button.disabled = true;
  try {
    await api("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: $("#admin-password").value }),
    });
    form.reset();
    showDashboard();
    await loadOverview();
  } catch (error) {
    feedback.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function logout() {
  try {
    await api("/api/admin/logout", { method: "POST" });
  } catch {}
  showLogin();
}

async function loadOverview() {
  const button = $("#refresh-button");
  button.disabled = true;
  try {
    const data = await api("/api/admin/overview");
    renderOverview(data);
  } catch (error) {
    if (error.status === 401) showLogin(error.message);
  } finally {
    button.disabled = false;
  }
}

function showLogin(message = "") {
  $("#dashboard-view").classList.add("hidden");
  $("#login-view").classList.remove("hidden");
  $("#login-feedback").textContent = message;
  $("#admin-password").focus({ preventScroll: true });
}

function showDashboard() {
  $("#login-view").classList.add("hidden");
  $("#dashboard-view").classList.remove("hidden");
}

function renderOverview(data) {
  const summary = data.summary || {};
  $("#generated-at").textContent = `更新于 ${formatTime(data.generated_at)}`;
  $("#summary-grid").innerHTML = [
    metric("注册用户", summary.total_users),
    metric("有效登录", summary.active_sessions),
    metric("5 分钟活跃", summary.active_users_5m),
    metric("项目数", summary.total_projects),
    metric("资料数", summary.total_sources),
  ].join("");
  renderUsers(data.users || []);
  renderEvents(data.recent_events || []);
}

function metric(label, value) {
  return `<article class="metric"><span>${escapeHtml(label)}</span><strong>${Number(value || 0)}</strong></article>`;
}

function renderUsers(users) {
  $("#users-count").textContent = `${users.length} 个用户`;
  $("#users-body").innerHTML = users.length ? users.map((user) => `
    <tr>
      <td>
        <div class="user-cell">
          <strong>${escapeHtml(user.name || "-")}</strong>
          <span>${escapeHtml(user.email || "-")}</span>
        </div>
      </td>
      <td>${formatTime(user.created_at)}</td>
      <td>${formatTime(user.last_login_at)}</td>
      <td>${formatTime(user.last_seen_at)}</td>
      <td>${Number(user.active_sessions || 0)}</td>
      <td>${Number(user.project_count || 0)}</td>
      <td>${Number(user.source_count || 0)}</td>
      <td>${Number(user.failed_login_count || 0)}</td>
    </tr>
  `).join("") : `<tr><td class="empty-row" colspan="8">暂无用户</td></tr>`;
}

function renderEvents(events) {
  $("#events-count").textContent = `${events.length} 条记录`;
  $("#events-body").innerHTML = events.length ? events.map((event) => `
    <tr>
      <td>${formatTime(event.created_at)}</td>
      <td>${escapeHtml(event.email || "-")}</td>
      <td>${eventLabel(event.event_type)}</td>
      <td>${event.success ? '<span class="status-pill">成功</span>' : '<span class="status-pill failed">失败</span>'}</td>
      <td>${escapeHtml(event.ip_address || "-")}</td>
      <td>${escapeHtml(compactUserAgent(event.user_agent || "-"))}</td>
    </tr>
  `).join("") : `<tr><td class="empty-row" colspan="6">暂无事件</td></tr>`;
}

function eventLabel(type) {
  return {
    register: "注册",
    login: "登录",
    logout: "退出",
  }[type] || type || "-";
}

function compactUserAgent(value) {
  return value.length > 90 ? `${value.slice(0, 90)}...` : value;
}

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const detail = body.detail && typeof body.detail === "object" ? body.detail : body;
    const error = new Error(detail.message || `请求失败：${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
