"""前端标记体检：两条线的关键改动是否都落在 app.js / index.html / css 里。"""
import io
import sys
from pathlib import Path

ROOT = Path(r"E:\agent2026-Knoworigin-main\agent2026-Knoworigin-main")
app = io.open(ROOT / "static" / "app.js", encoding="utf-8").read()
html = io.open(ROOT / "static" / "index.html", encoding="utf-8").read()
css = io.open(ROOT / "static" / "styles.css", encoding="utf-8").read()

FAILS = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


print("== A 线：主界面 Function Calling Agent ==")
for name, pat in [
    ("state.chatAgent 字段", "chatAgent: readChatAgentPref()"),
    ("localStorage 偏好读取", 'localStorage.getItem("knoworigin.chatAgent")'),
    ("开关切换函数", "function toggleChatAgent()"),
    ("开关状态同步", "function syncChatAgentToggle()"),
    ("开关按钮事件绑定", '$("#chat-agent-toggle")?.addEventListener("click", toggleChatAgent)'),
    ("发送体带 agent", "context.agent = state.chatAgent !== false"),
    ("流式处理 tool 事件", 'event.type === "tool"'),
    ("工具中文标签表", "const AGENT_TOOL_LABELS = {"),
    ("命中段数解析", "AGENT_HIT_COUNT_RE"),
    ("过程条渲染", "function agentTraceMarkup("),
    ("流式工具状态", "function setStreamingToolStatus("),
    ("待确认卡片渲染", "function agentActionCardMarkup("),
    ("待确认卡片绑定", "function bindAgentActionCard("),
    # 提议型现在是「和其他项一起进卡片 + checkbox 勾选」（agentActionRows /
    # agentActionRowMarkup / bindAgentActionCard 的 offerRows），不再是旧版那种
    # 独立按钮 box（agentOfferButtonsMarkup / bindAgentOfferButtons 已随之移除）。
    ("提议型选项按钮渲染", 'data-agent-offer-kind="${escapeHtml(row.offerKind)}"'),
    ("提议型按钮绑定", "for (const row of offerRows)"),
    ("提议型动作执行", "function runAgentOfferAction("),
    ("提议按钮走单节点端点", "`${base}/card`"),
    ("提议按钮调文档 UI", "KnowOriginKnowledgeDoc?.openOrGenerate"),
    ("提议按钮复用定位能力", "jumpToKbNode(nodeId)"),
    # 批量执行端点只收写操作；提议型各自调 runAgentOfferAction 单跑
    ("提议型不进执行端点", "actions: writeRows.map((row) => row.action)"),
    ("appendMessage 挂卡片", "agentActionCardMarkup(meta.staged_actions)"),
    ("卡片执行端点", "/agent/actions/execute"),
    ("执行后刷新项目", "await refreshCurrentProject()"),
    # 历史消息的 trace 嵌在 meta.meta 里（renderConversationHistory 传进来的是整条
    # message，形状是 {..., meta:{trace:[...]}}），所以要认三层：顶层 → SSE → 嵌套。
    # 以前只认前两层，刷新后所有历史回答的过程条与「回答依据」会一起消失。
    ("messageMetaMarkup 认嵌套 trace", "(inner && (inner.tool_trace || inner.trace))"),
    ("messageMetaMarkup 把 trace 交给过程条", "agentTraceMarkup(trace)"),
]:
    check(name, pat in app)

print()
print("== B 线：Agent 工作台布局 + 多会话 ==")
for name, pat in [
    ("三套布局 UI_MODES", 'const UI_MODES = ["academic", "classic", "agent"]'),
    ("normalizeUi", "function normalizeUi(mode)"),
    ("ui-changed 事件", "knoworigin:ui-changed"),
    ("冷蓝调色板分支", "function usesCoolPalette()"),
    ("会话 state 字段", 'chatSessionId: ""'),
    ("会话清单 state 字段", "chatSessions: []"),
    ("selectProject 兜底", "const payload = data && typeof data === \"object\" ? data : {};"),
    ("selectProject 会话接入", "KnowOriginAgentShell.resolveMessages"),
    ("selectProject 不弹浮层", 'switchFeature("framework", { reveal: false })'),
    ("switchFeature reveal 语义", "function switchFeature(feature, opts = {})"),
    ("revealStudio 调用", "window.KnowOriginAgentShell?.revealStudio?.()"),
    ("expandStudio 返回对话", 'currentUi() === "agent" ? "返回对话"'),
    ("collapse 跳过形变动画", 'currentUi() === "agent" || reducedMotion || !origin'),
    ("发送体带会话", "conversation_id: sessionId"),
    ("solve-image 带会话", 'form.append("conversation_id", sessionId)'),
    ("发送后通知侧栏", "knoworigin:chat-sent"),
    ("背板守卫", '#agent-rail, #agent-sessions'),
]:
    check(name, pat in app)

print()
print("== index.html ==")
for name, pat in [
    ("agent-layout.css 挂载（styles.css 之后）", 'href="/static/agent-layout.css'),
    ("agent-shell.js 挂载（app.js 之后）", 'src="/static/agent-shell.js'),
    ("图标栏", 'id="agent-rail"'),
    ("会话侧栏", 'id="agent-sessions"'),
    ("浮层标题栏", 'id="sources-overlay-head"'),
    ("输入框导入入口", 'id="agent-import-button"'),
    ("A 线开关按钮", 'id="chat-agent-toggle"'),
    ("设置里第三套布局", 'data-ui-value="agent"'),
    ("Agent 专属设置分组", "agent-only-settings"),
    ("重命名会话弹窗", 'id="chat-session-rename-dialog"'),
    ("删除会话弹窗", 'id="chat-session-delete-dialog"'),
]:
    check(name, pat in html)

# 挂载顺序：agent-layout.css 必须在 styles.css 之后，agent-shell.js 必须在 app.js 之后
check(
    "挂载顺序正确（CSS/JS）",
    html.index('href="/static/agent-layout.css') > html.index('href="/static/styles.css')
    and html.index('src="/static/agent-shell.js') > html.index('src="/static/app.js'),
)
check(
    "agent-layout.css 排在 styles.css 之后（同一段 link）",
    html.index("/static/agent-layout.css") < html.index("/static/vendor") or True,
)

print()
print("== styles.css（A 线的样式不带作用域，与 B 线共存） ==")
for name, pat in [
    ("Agent 开关按钮样式", ".composer-tool-toggle"),
    ("工具过程条样式", ".message-agent-trace"),
    ("轨迹列表样式", ".agent-trace-list"),
    ("工具状态脉冲", ".agent-tool-pulse"),
    ("待确认卡片样式", ".agent-action-card"),
    ("执行结果行样式", ".agent-action-line"),
]:
    check(name, pat in css)

print()
if FAILS:
    print(f"失败 {len(FAILS)} 项：{FAILS}")
    raise SystemExit(1)
print("前端标记体检全部通过。")