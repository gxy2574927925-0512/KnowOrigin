# 知源 · 同类项目调研 —— 可借鉴清单

> 需求：在 GitHub 上找类似项目，直接借鉴。
> 调研时间：2026-10-07 · 渠道：agent-reach（Exa / WebSearch / GitHub）

---

## 0. 一句话结论

**两个独立项目几乎收敛到了和知源一样的设计** —— 这是很强的方向验证：

| 我们的设计 | mnemex 的叫法 | 判断 |
| --- | --- | --- |
| 收获里的 `models`（可复用框架） | **Concepts**（含 `When to use` / `When NOT to use` + 来源计数） | **完全一致** |
| `cross_support`（被几本书支持） | Concepts 的 **source count** | **完全一致** |
| `EDGE_TYPES`（6 种类型化关系） | **关系词汇**（`Builds on` / `Subsumes` / `Contrasted with`） | **完全一致** |
| 桥 → 方法论 | **Syntheses**（多源理论：「这五本书怎么合起来看」） | **完全一致** |
| 「不猜合并，用户确认」 | 另一个项目：**「AI 绝不直接写文件，先给草稿、用户勾选才建」** | **完全一致** |

**mnemex 的一句话定位值得抄**：
> "It's the opposite of RAG: instead of re-discovering knowledge on every query,
> the wiki **compiles knowledge once and keeps it current**."

这正是知源在做的事 —— **不是每次提问都重新检索，而是把知识编译一次、持续维护**。

---

## 1. 项目对照表

| 项目 | 定位 | Star | 许可 | 与我们的关系 |
| --- | --- | --- | --- | --- |
| **`Daniil-Sokolskiy/mnemex`** | Books in, structured wiki out（LLM 策展的第二大脑） | — | MIT | ⭐ **最接近**：数据模型 + 关系词汇 + 生命周期 |
| **`codedogQBY/ReadAny`** | 本地优先 AI 电子书阅读器（桌面+移动） | 2058 | GPL-3.0 | ⭐ **最接近**：RAG 检索 + 高亮 + TTS + 统计 |
| **`han-yi-1212/obsidian-knowledge-graph-agent`** | Obsidian 知识图谱 + AI 对话 | — | MIT | 借鉴：**Plan → Preview → Confirm** |
| **`cubxxw/wechat-reader-ai-assistant`** | 微信读书 AI 助手（浏览器扩展） | — | MIT | ⭐ 借鉴：**DOM 抓取正文**（解决「没有原文」的新思路） |
| **`arry-lee/wereader`** | 微信读书笔记助手 | — | — | 已有方案，我们已覆盖 |
| **`Tencent/WeChatReading`** | 官方 Agent API 文档 | 250 | — | **已在用** |
| **`ChenyqThu/mcp-server-weread`** | 微信读书 MCP Server | — | — | **已在用**（工具设计范本） |
| `AI Knowledge Manager`（Obsidian 插件） | 自动分类书 + 标签 + **从微信读书导入划线** | — | — | 功能重叠，参考分类/导入 |
| **`luoluo-121/neural-creator-dashboard`** | 把创作内容可视化成「活体神经网络」的前端看板 | — | **PolyForm NC** | 仅借鉴 UI 设计思想（见 UI 专项文档），**代码/素材不可抄** |

---

## 2. 可借鉴清单（按优先级）

### ✅ 已落地（本轮）

**① 概念成熟度生命周期** —— 借自 mnemex 的 status lifecycle

```
stub（孤证，1 本）→ draft（待验证，2 本）→ mature（已成熟，3+ 本）
```

- 实现：`knowledge_net.concept_stage()`，`cross_support` 每条带 `stage` / `stage_label`；
  `analyze().summary` 增加 `mature / draft / stub` 三个计数。
- 前端「知识网络」页新增**概念成熟度**分组，已成熟标 primary 色。
- **为什么值得抄**：把「我到底懂没懂」变成看得见的状态。只在一本书里见过的概念，
  和三本书里反复被独立指向的概念，可信度天差地别 —— 界面上一视同仁就是骗自己。
- **我们做了一处改动**：mnemex 的 mature 还要求人工 review 标记；知源是本地优先、
  单人使用的工具，再让用户手动标状态就没人标了，所以**判据只用「被几本书支持」这一条客观事实**。

### 🔜 建议做（按性价比排序）

**② 微信读书正文捕获（书签小工具）** —— 借自 `wechat-reader-ai-assistant` 的 DOM 抓取

这是**唯一能真正解决「微信读书没有原文」的思路**，而且比它更干净：

| | wechat-reader-ai-assistant | 知源的方案 |
| --- | --- | --- |
| 运行位置 | 浏览器扩展，注入脚本自动抓 | **用户主动点一下书签** |
| 内容 | 页面 DOM 里的高亮 + 当前章正文 | 当前章正文（用户自己正在读的那一页） |
| 去向 | 发给 OpenAI | **POST 到本机 127.0.0.1**，只存本地 |
| 合规 | 扩展自动抓取 | **用户自己的账号、自己的阅读行为、只存本机** |

技术要点（无 CORS 问题）：书签小工具在页面里建一个隐藏 iframe，用一个 `target` 指向它的
表单 POST 到 `http://127.0.0.1:<port>/api/reading/capture`，带 `token` + `chapter_title` + `text`。
**表单提交不受 CORS 限制**，也不需要跨站带 Cookie（用一次性捕获令牌鉴权）。

配套：`GET /api/reading/capture-token` 取令牌（需登录）→ 前端生成可拖拽的书签链接。

> ⚠️ **2026-10-07 复核后暂缓，原因是一个技术事实**：
> 微信读书**网页版用 Canvas 渲染正文**（不是 DOM 文本节点）——
> 这正是 `weread-exporter` 要用 Playwright + `CanvasRenderingContext2D.fillText` 钩子
> 才能拿到字的原因。书签小工具是页面加载**之后**注入的，钩不住已经画完的内容，
> 只能「装上钩子 → 用户翻页 → 累积文本」—— 交互很别扭。
>
> 更关键的是：**这条我无法在本机验证**（需要一个已登录微信读书的浏览器），
> 贸然发布一个验证不了的功能违背本项目「门禁不依赖外网、改动必须可验证」的规矩。
>
> 所以**服务端那一半可以先做**（捕获端点 + 一次性令牌，完全可测），
> 浏览器那一半等有真机环境时再上。要推进的话告诉我。

**③ Cluster ingest（批量读）** —— 借自 mnemex ✅ **本轮已落地（简化版）**

> "ingest 5 themed books together with cross-link 'sibling hooks' so concepts mature fast."

原版是「一次 ingest 5 本同主题书 + 互相挂钩」。我做了它的**最小可用版**：
**「一键补全收获」** —— 给所有还没有收获的书批量生成。

为什么先做这个：知识网络的节点**全部来自各书的「可复用模型」**，
一本都没生成时网络是空的；而书一多，一本一本点就成了负担。
批量跑完，网络才有东西可连 —— 这是「概念成熟」的前置条件。

实现要点：
- 把生成逻辑从单本路由里抽成 `_generate_reading_digest(user, book, body)`，**两条路由共用同一实现**；
- `POST /api/reading/digests/generate-missing`（`limit` 默认 8，上限 20，逐本 try）；
- **已生成的不重复跑**（幂等）；
- 前端书架页加「一键补全收获」按钮，返回里带 `remaining`（还有几本没跑，再点一次继续）。

> **测试意外发现（比预期更好）**：模型失败**不会**变成「失败」——
> `_generate_reading_digest` 内部已经把它降级成本地兜底文档了。
> 所以批量跑完，**每本书都有产出**，`errors` 只在非模型故障（DB、网络）时才非空。
> 我原本写的「坏书应该进 errors」断言是错的，已按真实行为改写。

**仍未做**：真正的「同主题集群」概念 —— 让用户圈定一组书、一起生成、并把它们的概念
互相挂钩。现在只是「全量补全」，还没有「按主题分组」这一层。

**④ 两段式生成（Two-phase ingest）** —— 借自 mnemex

> "split content writing (sub-agent) from bookkeeping (parent) to avoid timeouts on big books."

内容生成与记账分离，避免大书超时。**知源的大部头书（几十万字）生成收获时同样有超时风险**，
值得在 digest 生成上做同样的拆分。

**⑤ 本地嵌入做概念相似度** —— 借自 ReadAny（Transformers.js 本地嵌入，可离线）

我们现在的 `candidate_pairs` **只认字面**：「傅里叶变换」和「Fourier Transform」永远匹配不上。
本地嵌入能把这一层补上，而且**不破坏 local-first**（模型跑在本机）。
ReadAny 的做法值得抄：`Transformers.js` + 本地向量库 + 离线可用。

**⑥ 混合检索（向量 + BM25 + RRF）** —— 借自 ReadAny

知源的 `paper_recall.py` 已有 RRF 四层管线，但**读书功能里的搜索/概念匹配还是纯字符串**。
把 RRF 用到读书侧，检索质量会有台阶式提升。

**⑦ 来源面板带相关度** —— 借自 obsidian-knowledge-graph-agent

它每次回答下方挂 `📚 Sources`：**📌 Pinned（用户手动固定，最高优先）+ 🔍 Retrieved（自动匹配，
带 0~100% 归一化相关度 + 命中片段）**。知源的「回答依据」面板可以加「手动固定」这一档 ——
用户把关键资料钉住，AI 优先依据它作答。

### ❌ 不建议做

| 做法 | 为什么不做 |
| --- | --- |
| mnemex 的 **Anna's Archive** 下载 | 有明确法律风险（项目自己也标了 ⚠️）。知源只走公版书源 + 本地导入。 |
| wechat-reader-ai-assistant 的 **自动注入抓取** | 服务端/扩展自动抓取越界；用户主动点一下是可接受的边界。 |
| ReadAny 的 **TTS / WebDAV 同步 / 移动端** | 不是当前阶段要解决的问题，且 Tauri/RN 的技术栈与知源（FastAPI + 原生 JS）完全不同。 |
| 全盘照搬 ReadAny 的 **GPL-3.0 代码** | 知源是自有项目，抄 GPL 代码会传染许可。**只借鉴设计，不抄代码**。 |

---

## 3. 三个值得写进设计原则的表述

1. **「编译一次，持续维护」**（mnemex）——
   知源不是「每次提问重新检索」，而是把知识编译成结构化产物并保持最新。
   这句话可以当读书功能的定位语。
2. **「AI 绝不直接写文件」**（obsidian-knowledge-graph-agent 的 Plan → Preview → Confirm）——
   和知源既有的「写操作先登记、用户确认才落库」是同一条原则。
   我们的「不猜合并」正是它在概念层上的体现。
3. **「状态可见」**（mnemex 的 status lifecycle）——
   知识系统里最容易骗自己的就是「我读过了 = 我懂了」。用客观计数把状态摊开，
   比任何自我评估都诚实。

---

## 4. 本轮已交付

- `core/knowledge_net.py`：`CONCEPT_STAGES` / `STAGE_LABELS` / `STAGE_HINTS` / `concept_stage()`；
  `cross_support` 带 `stage`；`analyze().summary` 带成熟度分布。
- `static/reading.js`：知识网络页新增**概念成熟度**三段分组（已成熟 / 待验证 / 孤证）。
- `tools/verify_knowledge_net.py`：**117 条断言全绿**（新增 11 条成熟度覆盖）。

---

## 5. 参考资料

> UI 设计专项评估见：`KnowOrigin-UI设计借鉴-neural-creator-dashboard.md`
> （结论：借鉴「三层递进交互」等设计思想，不抄代码与素材 —— 源项目是 PolyForm 非商业许可。）

- `https://github.com/Daniil-Sokolskiy/mnemex`（MIT）
- `https://github.com/codedogQBY/ReadAny`（GPL-3.0，2058★）
- `https://github.com/han-yi-1212/obsidian-knowledge-graph-agent`（MIT）
- `https://github.com/cubxxw/wechat-reader-ai-assistant`（MIT）
- `https://github.com/Tencent/WeChatReading`（官方接口文档）
