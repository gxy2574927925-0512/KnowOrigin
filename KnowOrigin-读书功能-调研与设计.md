# 知源 · 读书功能（接入微信读书）调研与设计

> 目标：在知源里开一个「读书」功能，接入微信读书，书架封面可视化。
> 本文档 = 竞品/开源调研 + 可借鉴架构 + 落到知源的集成设计。
> 调研时间：2026-10-07

---

## 0. 一句话结论

**微信读书有官方 Agent API，不用爬虫。** 统一入口 `POST https://i.weread.qq.com/api/agent/gateway`，用 `Bearer wrk-xxx` 密钥鉴权（不是 Cookie），官方直接返回书架、**封面 URL**、阅读进度、划线、笔记、阅读统计。

知源的架构天然能接：`projects` 表已有 `project_type` 机制（course / literature），加一个 `book` 类型即可；封面墙是一个纯静态页 + 一个出网适配模块。而且能和知源的核心价值打通——**把一本书的划线/笔记一键变成「资料」，走完 知识框架 → 卡片 → 测验 → 掌握度 的完整学习闭环**，这是 Notion 同步类项目做不到的差异化。

---

## 1. 可借鉴项目清单

| 项目 | 类型 | 认证 | 能拿到什么 | 借鉴点 | 局限 |
| --- | --- | --- | --- | --- | --- |
| **`Tencent/WeChatReading`**（官方，250★） | Agent Skills 文档 + API 网关 | **API Key**（`wrk-`） | 搜索/书架/书籍详情/章节/进度/笔记划线/热门划线/书评/推荐/阅读统计 | **首选底座**。接口清单、字段语义、分页口径、坑点官方都写好了；密钥绑定用户身份，不用传 vid | 只有文档，无 SDK；需自己申请 Key |
| **`ChenyqThu/mcp-server-weread`** | MCP Server（Node） | Cookie | 书架、搜索、单书笔记划线、热门书评 | **工具设计范本**：`get_bookshelf` / `search_books` / `get_book_notes_and_highlights` / `get_book_best_reviews` 四个工具的粒度可直接抄进知源 Agent 的工具集 | Cookie 方式，会过期 |
| **`malinkang/weread2notion`** | GitHub Actions 同步 | API Key | 书籍、划线、笔记 → Notion | **增量同步思路**：API Key 读数据 + 定时任务；「检测到更新就删旧页重建」的坑值得记 | 只同步，无学习闭环 |
| **`hodgekou/weread2notion-AI`** | Actions 同步 + 模板 | API Key | 书架、进度、时长、划线、笔记、**原生阅读统计图表** | **统计可视化参考**：每日阅读快照、时长/进度/状态，做成图表；「全量同步前先导出 JSON 备份」 | 绑定 Notion |
| **`lbq110/weread-exporter`** | Playwright 逆向 | 扫码登录 | **全本正文**（Canvas Hook 抓字） | 反面参照：证明「全本导出」可行但重、慢、有版权与封号风险，**不建议做进知源** | 20-30 秒/章，部分书禁网页端 |

> 检索渠道：GitHub 官方仓库 + Exa 语义搜索。GitHub CLI 未登录，用 `api.github.com` / raw 直取。

---

## 2. 官方接口能力地图（`/api/agent/gateway`）

**请求规范**：`POST` + `Authorization: Bearer $WEREAD_API_KEY` + JSON body。
body 里 `api_name` 指定接口，**业务参数必须平铺在顶层**（不能包在 `params` 里），且每次必带 `skill_version`。

| `api_name` | 作用 | 关键参数 | 关键回包字段 |
| --- | --- | --- | --- |
| `/shelf/sync` | **书架全量** | 无 | `books[]`（`bookId`/`title`/`author`/**`cover`**/`category`/`readUpdateTime`/`finishReading`/`secret`/`isTop`/`deepLink`）、`albums[]`（有声书）、`mp`（文章收藏入口） |
| `/book/info` | 书籍详情 | `bookId` | `title`/`author`/**`cover`**/`intro`/`category`/`publisher`/`isbn`/`wordCount`/`newRating`/`deepLink` |
| `/book/chapterinfo` | 章节目录 | `bookId` | `chapters[]`（`chapterUid`/`chapterIdx`/`title`/`wordCount`/`level`/`paid`） |
| `/book/getprogress` | 阅读进度 | `bookId` | `book.progress`（0-100 整数，**1=1%**）、`book.recordReadingTime`（秒）、`book.updateTime`、`book.finishTime` |
| `/user/notebooks` | 有笔记的书概览 | `count` / `lastSort`（游标） | `books[].reviewCount`（想法）+`noteCount`（划线）+`bookmarkCount`（书签）、`readingProgress`、`sort` |
| `/book/bookmarklist` | 单书**划线内容** | `bookId` | `updated[]`（`bookmarkId`/`chapterUid`/`markText`/`range`） |
| `/review/list/mine` | 单书**个人想法/点评** | `bookId` | 个人想法内容 |
| `/book/underlines` | 章节热门划线 | `bookId` + `chapterUid` | 划线热度 + 划线下想法 |
| `/book/bestbookmarks` | 全书热门划线 | `bookId` | 热门划线榜 |
| `/review/list` | 书籍**公开点评** | `bookId` + `reviewListType` | `reviews[].review.review.{content,star,author,book}`（**双层嵌套**） |
| `/readdata/detail` | **阅读统计** | `mode`(weekly/monthly/annually/overall) + `baseTime` | `totalReadTime`（**秒**）/`readDays`/`dayAverageReadTime`/`readTimes`（分桶）/`readLongest[]`（读最多的书，带 `book.cover`）/`preferCategory`/`preferTime`（**从 6 点开始排序**） |
| `/book/recommend` | 个性化推荐 | `count`/`maxIdx` | `books[]`（含 `cover`/`reason`/`newRating`） |
| `/book/similar` | 相似推荐 | `bookId`+`count`+`maxIdx` | 相似书 |
| `/store/search` | 书城搜索 | `keyword`+`scope` | `results[].books[].bookInfo`（含 `cover`）；scope：0 全部 / 10 电子书 / 16 网文 / 14 听书 / 6 作者 / 12 全文 / 13 书单 |

**封面可视化最关键的三个字段**：
- 每本书对象都有 **`cover`**（封面图 URL）——封面墙直接用；
- **`deepLink`**（跳转链接）——点封面「去 App 阅读」直接用，**不要自己拼**；
- `newRating`（0-100 评分）、`intro`（简介）——悬停/详情卡用。

---

## 3. 三条技术路线对比

| | **A. 官方 API Key**（推荐） | B. MCP Server / Cookie | C. Playwright 全本逆向 |
| --- | --- | --- | --- |
| 鉴权 | `Bearer wrk-xxx`，官方签发 | Cookie（浏览器导出） | 扫码登录 + Canvas Hook |
| 稳定性 | 高，官方契约 | 中，Cookie 会过期、易失效 | 低，页面改版即挂 |
| 能拿到 | 书架/封面/进度/划线/笔记/统计/推荐 | 同上（少统计） | **全本正文** |
| 封号风险 | 低 | 中 | **高** |
| 版权风险 | 只取用户自己的笔记/划线，低 | 同 A | **高（抓全本）** |
| 工程量 | 小（一个适配层 + 一页前端） | 中（要处理 Cookie 生命周期） | 大（浏览器自动化、双页拆分、坐标重建） |
| 结论 | ✅ **做这个** | ⚠️ 仅作工具设计参考 | ❌ 不建议进知源 |

> **决策**：走 A。C 的「全本导出」价值可以用别的路子满足——用户真要精读一本书，让他自己导入 PDF/EPUB 到现有「文献模式」，读书功能只负责**书架 + 进度 + 划线笔记 + 统计 + 陪读问答**。

---

## 4. 落到知源的集成设计

### 4.1 后端

**新建 `src/core/weread.py`**——唯一的出网适配层，风格对齐 `core/paper_search.py` / `core/campus_sources.py`：
- `WereadClient`：封装 `POST /api/agent/gateway`，统一 `skill_version`、超时、重试、`errcode != 0` 抛 `WereadApiError`；
- 每个 `api_name` 一个薄方法：`shelf_sync()` / `book_info(bid)` / `progress(bid)` / `notes(bid)` / `notebooks()` / `readdata(mode)` / `search(kw, scope)`；
- **密钥读取沿用现有凭据链**：环境变量 `WEREAD_API_KEY` → `data/local_api_config.json`（DPAPI 加密，与天大模型 key 同一套机制）→ 浏览器下发。**绝不写进代码/仓库**。

**新增路由 `/api/reading/*`**（独立命名空间，对齐 `/api/en/*` 的做法）：
```
GET  /api/reading/shelf               书架（本地缓存，?refresh=1 触发同步）
POST /api/reading/sync                增量同步（SSE 推送进度）
GET  /api/reading/books/{book_id}     书籍详情 + 章节 + 进度
GET  /api/reading/books/{book_id}/notes   划线 + 想法
GET  /api/reading/stats?mode=monthly  阅读统计
POST /api/reading/books/{book_id}/import  一键导入为「资料」（进学习闭环）
GET  /api/reading/recommend           推荐
```

### 4.2 数据表（对齐 `core/database.py` 的迁移风格）

```sql
-- 书架缓存：一本书一行
CREATE TABLE IF NOT EXISTS weread_books (
    book_id TEXT PRIMARY KEY,          -- 微信读书 bookId
    title TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    cover TEXT NOT NULL DEFAULT '',    -- 封面 URL（可视化用）
    category TEXT NOT NULL DEFAULT '',
    deep_link TEXT NOT NULL DEFAULT '',-- 官方跳转链接
    progress INTEGER NOT NULL DEFAULT 0,       -- 0-100
    finish_reading INTEGER NOT NULL DEFAULT 0,
    secret INTEGER NOT NULL DEFAULT 0,
    is_top INTEGER NOT NULL DEFAULT 0,
    read_update_time INTEGER NOT NULL DEFAULT 0,
    word_count INTEGER NOT NULL DEFAULT 0,
    rating INTEGER NOT NULL DEFAULT 0,
    synced_at TEXT NOT NULL
);
-- 划线/笔记
CREATE TABLE IF NOT EXISTS weread_notes (
    note_id TEXT PRIMARY KEY,          -- bookmarkId 或 reviewId
    book_id TEXT NOT NULL,
    kind TEXT NOT NULL,                -- underline / thought / bookmark
    chapter_uid INTEGER NOT NULL DEFAULT 0,
    chapter_name TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',     -- 划线原文 或 想法内容
    ref_text TEXT NOT NULL DEFAULT '', -- 想法所依附的划线原文
    created_at INTEGER NOT NULL DEFAULT 0
);
-- 阅读统计快照（每日一条，供画趋势）
CREATE TABLE IF NOT EXISTS weread_stats (
    period TEXT NOT NULL,              -- weekly/monthly/annually/overall
    base_time INTEGER NOT NULL,
    total_seconds INTEGER NOT NULL DEFAULT 0,
    read_days INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL DEFAULT '{}',-- 原始 readdata 裁剪后 JSON
    synced_at TEXT NOT NULL,
    PRIMARY KEY (period, base_time)
);
CREATE TABLE IF NOT EXISTS weread_sync_state (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
);
```

**复用现有 `projects` 表**：导入一本书为资料时，走 `create_literature` 的同款模式建一个 `project_type='book'` 项目（`projects` 已有 `reading_status` / `last_position` / `total_reading_seconds` 三个列，正好承接进度与时长），`subject` = 书名，`tags` 记 `["weread", book_id]` 便于反查。

### 4.3 前端

- **新建 `static/reading.js` + `static/styles-reading.css`**（对齐 `literature.js` / `styles-literature.css` 的独立文件模式，摘一行 `<link>`/`<script>` 即可完整回退）；
- 三块视图：
  1. **书架（封面墙）**——核心，见 §5；
  2. **笔记划线**——按书/章节分组，每条可「加入资料」「收藏到我的笔记」；
  3. **阅读统计**——时长趋势、日历热力、偏好分类/时段、读最多的书。
- 接入点：侧栏新增一级入口「读书」，或复用知源现有的视图切换机制。

### 4.4 与学习闭环打通（知源的差异化）

这是接 Notion / 单独做个书架做不到的部分：

```
微信读书划线/笔记  ──导入──▶  sources 表（一本书 = 一个 project）
                                   │
                    ┌──────────────┼──────────────┐
                    ▼              ▼              ▼
              framework 知识框架   卡片/测验     RAG 陪读问答
             （书的脉络树）      （划线出题）   （只答书里写过的）
                    │              │              │
                    └──────────────┴──────────────┘
                                   ▼
                          learning_events 掌握度
```

- **划线出题**：把一本书的划线作为素材，复用 `framework.build_framework` + `generate_fallback_cards`，生成「这本书的核心观点」卡片；
- **RAG 陪读**：`chat/stream` 检索范围限定到该书，回答标注来源章节，实现「只依据这本书作答」；
- **阅读打卡**：把 `/readdata/detail` 的 `readDays` 并进现有 `/api/me/streak` 日历热力图，读书和学课件同一张打卡图。

---

## 5. 封面可视化的实现细节

**1. 封面来源**：直接用 `cover` 字段 URL。注意两点——
- 微信读书封面走腾讯云 CDN，**部分域名有防盗链**，前端 `<img>` 直连可能 403。稳妥做法：后端加一个 `/api/reading/cover?url=...` 代理（校验域名白名单 `*.image.myqcloud.com` / `cdn.weread.qq.com`，带正确 `Referer`），前端只连自家域名；
- 加载失败要有**兜底占位**：用书名首字 + 稳定哈希色（同一本书永远同色），不要出现破图。

**2. 版式三选（可按主题切换）**：
- **网格封面墙**（推荐默认）：`grid-template-columns: repeat(auto-fill, minmax(120px, 1fr))`，封面 3:4，封面下方一行进度条 + 最近阅读时间，未读置灰、读完打角标；
- **3D 书脊**：`transform: perspective() rotateY()`，像真书架，适合「已读完」展示墙；
- **层板书架**：横向一排封面立在木纹层板上，适合桌面端大屏。

**3. 进度与状态编码**：
- 进度环 / 底部细条；`finishReading=1` → 打「已读完」角标；
- `secret=1` → 私密书加小锁标；`isTop=1` → 置顶排最前；
- `readUpdateTime` 降序 = 默认排序（最近在读在最前）。

**4. 性能**：封面 `loading="lazy"` + 固定宽高比占位（避免抖动）；书架一次几百本时用 IntersectionObserver 分批渲染。

**5. 交互**：点封面 → 详情卡（简介/评分/章节/进度）→ 「去 App 阅读」（`deepLink`）/「导入为资料」（进学习闭环）/「看划线」。

---

## 6. 三件新增需求：分类体系 · 每书简介 · AI 收获文档

> 这一节对应用户追加的三条需求：**书籍要详细分类**、**每本书底下要有一段介绍**、
> **AI 要用高质量结构化文档总结出我能复用的东西**。
> 核心设计原则：**不另造一套生成引擎，直接移植知源已被验证的
> 「事实铁律 + 逐字段校验 + 本地兜底」机制**（见 `core/knowledge_doc.py`）。

### 6.1 三级分类体系

| 级别 | 来源 | 作用 | 落地方式 |
| --- | --- | --- | --- |
| **一级：领域** | 知源自定 14 个（文学小说 / 人文社科 / 历史 / 哲学思想 / 经济管理 / 心理 / 科技互联网 / 自然科学 / 职场成长 / 生活健康 / 艺术设计 / 教育学习 / 童书 / 其他） | **导航骨架**——书架按它分组 | `core/reading_digest.py` 的 `CATEGORIES` + `guess_category()` |
| **二级：原生分类** | 微信读书 `category`（如「文学-小说」「经济理财-理财」） | 只作**兜底线索**，不作导航 | 粒度碎、命名不统一，直接拿来当导航会碎成一地；仅喂给规则层 |
| **三级：主题标签** | AI 产出的 `topics`（多标签）+ 用户自定义书架/分组 | **检索与个性化** | AI 生成 + 用户可增删 |

**分类怎么保证不依赖模型**：`guess_category(native_category, title, topics)` 是**纯规则函数**
——关键词最长匹配（「经济学」比「经济」更具体，不被后者抢走）。模型不可用时书架照样分得开，
而不是全部掉进「其他」。

### 6.2 每本书的介绍

- **输入**：书籍自带 `intro` + 用户前 20 条划线（都不编造）。
- **产出字段**：`one_liner`（一句话定位）/ `intro`（150~300 字）/ `topics` / `level`（入门·进阶·专业）/ `use_case`（什么情况下读）/ `category`。
- **成色门槛 + 兜底**：`one_liner` < 10 字、`intro` < 60 字 → 退回兜底；兜底**用书籍自带的简介**，
  不编造评价（`build_intro_fallback`）。
- **展示**：封面下方一行 `one_liner`，悬停/点开展开完整介绍。
- **可编辑**：复用 `knowledge_docs` 的 **`content_json`（结构化留档）/ `content_md`（可手工编辑正文）分离**模式——
  用户改的是 `content_md`，AI 原稿留在 `content_json`，重新生成时才覆盖。

### 6.3 AI 收获文档（「学有所获」的核心）

字段设计（**已实现于 `src/core/reading_digest.py`**）：

| 字段 | 含义 | 为什么需要 |
| --- | --- | --- |
| `thesis` | 一句话主张 | 先让读者抓住这本书到底在说什么 |
| `core_arguments[]` | 核心论点 + 怎么论证的 + 出处 | 骨架 |
| **`models[]`** | **可复用的模型/框架**：是什么 · **什么场景怎么用** · 出处 | ⭐ **「能复用的东西」的主角**——换个场景还能用 |
| `insights[]` | 反常识点：大多数人以为 → 书里说 → **差在哪一步** | 认知升级点 |
| **`actions[]`** | 明天就能用的清单（动词开头） | ⭐ 把「知道」变成「能做」 |
| `quotes[]` | 原文金句（**必须是划线原话，一字不改**） | 留存的原文 |
| `connections[]` | 与我的其他书 / 知识点 / 项目的联系 | 接进知识网络 |
| `self_check[]` | 自测题 + 答案要点 | 检验是否真的读进去 |
| `grounding` | 依据说明（哪些来自哪条划线，书里没写的点名） | 溯源，防编造 |

**两条铁律（与知源所有生成模块一致）**：
1. **事实铁律**：只依据用户自己的划线/想法/书籍简介，**绝不拿通识硬凑**；书里没写就写「书中未涉及」。
2. **逐字段校验 + 本地兜底**：某个字段没写好（太短/条数不够/类型不对），**只退回该字段的兜底**，
   其余照用——整份文档不会因为一个字没写好而整篇失败。

**踩坑（已修）**：兜底内容必须走**宽松门槛**。第一版把兜底也按「模型成色门槛」卡，
一条 7 个字的兜底论点被 `MIN_INSIGHT=8` 静默吃掉，表现为「兜底明明写了、文档里却是空的」且不报错。
现 `_dict_list(strict=False)` 专供兜底分支。

**已交付**：
- `src/core/reading_digest.py`——纯函数引擎（分类 / payload / 归一化 / 兜底 / Markdown 渲染）；
- `tools/verify_reading_digest.py`——**50 条断言全绿**；
- `src/tools/ci_gate.py` 语法 + 凭据门禁通过。

### 6.4 与知源既有生成物件的分工（三份并存，不重复）

| 物件 | 输入 | 骨架 | 回答的问题 | 模块 |
| --- | --- | --- | --- | --- |
| **知识点文档** | 课程资料 + 框架节点 | 定义 / 推导 / 公式 / 相邻知识点 | 「这个知识点是什么」 | `knowledge_doc.py` |
| **学习套件** | 课程资料 + 节点掌握度 | 速查表 / 学习路径 / 清单报告 | 「考前怎么过、下一步学什么」 | `study_kit.py` |
| **读书收获**（新） | 一本书的划线 / 想法 | **可复用模型 / 行动清单 / 反常识** | 「我能拿走什么、能用在哪」 | `reading_digest.py` |

三者输入不同、骨架不同、回答的问题不同，**并存不重复**。

---

## 7. 多书源获取 · 侧边辅助阅读 · 高亮笔记

> 对应用户追加的需求：**获取书单/全文的渠道不限于微信读书**（因为微信读书给不了整本正文）、
> **AI 侧边辅助阅读**、**高亮笔记**。

### 7.1 微信读书的能力边界（这是必须换源的根本原因）

微信读书官方接口能给的是**书架、封面、进度、用户自己的划线与想法**，
**给不了整本书的正文**——正文留在它的 App 里读，这是商业边界，不是接口缺陷。
所以「读书功能」的两类需求必须分开满足：

| 需求 | 谁最合适 |
| --- | --- |
| 元数据 + 个人笔记（书名/作者/封面/分类/划线） | **微信读书**（最强） |
| 整本书正文（要能全文检索、侧边问 AI、划词高亮） | **必须另找合法可全文的源** |

### 7.2 书源注册表（**已实现**：`src/core/book_sources.py`）

每个源**显式标注它到底能给什么**，不让上层猜：

| 源 | 能力 | 版权 | 要 Key | 说明 |
| --- | --- | --- | --- | --- |
| `weread` 微信读书 | 仅元数据 | licensed | ✅ `wrk-` | 书架/封面/进度/划线，**无正文** |
| `gutenberg` 古腾堡 | **可获取全文** | public-domain | ❌ | 7 万+ 英文公版书，EPUB/TXT/HTML |
| `wikisource` 维基文库 | **可获取全文** | public-domain | ❌ | 中文公版典籍与文献 |
| `ctext` 中国哲学书电子化 | **可获取全文** | public-domain | ✅ 注册 IP | 先秦至清代典籍 |
| `standardebooks` | **可获取全文** | public-domain | ❌ | 精校公版书，目录浏览（无搜索 API） |
| `openlibrary` | 仅元数据 | unknown | ❌ | 全球书目 + 封面，覆盖面最广 |
| `googlebooks` | 仅元数据 | unknown | ❌ | 元数据 + 简介，中文覆盖较好 |
| `douban` 豆瓣读书 | 仅外链 | unknown | ❌ | 中文书单最全，**无公开 API，只跳转不抓取** |
| `local` 本地导入 | **可获取全文** | user-provided | ❌ | 用户自备 EPUB/PDF/TXT，走现有解析器 |

**三条写进代码的硬约束**：

1. **版权红线**：`has_fulltext=True` 只对 `public-domain` / `user-provided` 放行，
   由 `_norm()` 强制——**杜绝「不小心把有版权的书当公版书下全文」**。
   商业书即使有下载链接也会被降级为「无全文」，取全文接口直接拒绝并说明原因。
2. **单源失败隔离**：防线**下沉到每个源**（`_safe_fetch`），任一源超时/报错只算 0 条，
   绝不让整轮搜索炸掉。外层 `search_books` 再兜一层作最后保险。
3. **不重复造轮子**：本地导入只**登记**书目，正文解析交给 `core/parsers.py`
   （它已支持 PDF / 扫描件 / OCR）。

**归一化记录**：所有源 → 同一种 `{source, source_id, title, author, cover, language,
year, topics, category, detail_url, download_url, has_fulltext, fulltext_format, rights, kind}`。
`category` 复用 §6.1 的 `guess_category()`——所以**多源的书和微信读书的书在同一套分类里**。

**已交付**：`tools/verify_book_sources.py` —— **138 条断言全绿**（含版权红线、单源失败隔离、
各源字段落位、全文优先级、本地导入、书单聚合，以及 §8.8 新增的 Standard Ebooks 解析与分章、
Internet Archive 版权分流、Open Library 三档、HTML/古腾堡页眉处理、HathiTrust 反查、代理与跳过策略）。

> **踩坑（已修）**：分类关键词表原先只有中文，导致古腾堡/Open Library 的书
> **全部掉进「其他」**——而它们恰恰是最能拿到全文的那批。已补英文关键词，
> 并改为**词边界匹配**（否则 `art` 会命中 `heart`、`artificial` 被 `art` 抢走）。

### 7.3 侧边辅助阅读 + 高亮笔记：**复用现有实现，不重造**

知源的文献模式已经把这套做完了，读书页**直接复用**即可：

| 能力 | 现有实现 |
| --- | --- |
| 六种标注 | `literature_marks` 表：`highlight`（原文高亮）/ `ai_highlight`（AI 划词高亮）/ `keypoints`（阅读重点）/ `notes`（划词笔记）/ `note`（阅读笔记）/ `ai_answer`（AI 回答落库） |
| 标注读写 | `GET/PUT /api/literature/{project_id}/marks` |
| 侧边问 AI | `POST /api/literature/{project_id}/ask`（SSE） |
| 前端交互 | `literature.js`：`askQuestion(question, attachSel)` / `addHighlightSelection()` / `showAiHlMarkTip()` |

**设计取舍**：不新建一套标注表，也不新建一套问答端点。读书页把「书」当成
`project_type='book'` 的项目（与 `literature` 平级），直接挂同一套标注与问答机制——
`kind` 的语义天然适配（原文高亮 / 划词笔记 / AI 回答）。

### 7.4 一条完整的阅读链路

```
选书（多源搜索，§7.2）
   └─ 公版书 → 直下全文      ┐
   └─ 微信读书 → 只取元数据+划线 ├─▶ 阅读页（正文 + 侧边问 AI + 高亮笔记，§7.3）
   └─ 本地书 → 导入解析        ┘            │
                                            ▼
                                读书收获文档（§6.3）
                                            │
                                            ▼
                                  卡片 / 测验 / 掌握度
```

### 7.5 微信读书接入（**已实测**）

`core/weread.py` + `/api/reading/weread/*` 四个端点：

| 端点 | 作用 |
| --- | --- |
| `GET /api/reading/weread/status` | 连接状态；`?probe=1` 真打一次接口验证 Key |
| `PUT /api/reading/weread/key` | 保存 `wrk-` Key（校验前缀；**响应绝不回显**） |
| `POST /api/reading/weread/sync` | 拉书架 → 入库（**不建项目**，避免几百本空项目）→ 顺带拉最近 N 本进度 |
| `GET /api/reading/weread/books/{id}/notes` | 拉划线与个人想法（收获文档的直接输入） |

**实测结果**（真实账号）：书架 5 本电子书 + 1 个文章收藏入口 → 全部入库（**不建项目**，
只有元数据时不给它凭空建空项目）；
3 本拉到真实进度（「一本书读懂30部经济学经典」8% 在读）；按一级领域分成
经济管理 4 / 人文社科 1。

**三个必须记住的坑（都写进了代码注释与断言）**：
1. **请求体参数必须平铺**，包进 `params` 会让后端收不到 —— 表现为「分页失效、永远第一页」。
2. **`upgrade_info` 出现时必须中断**，不能忽略（官方硬要求）。
3. **口径不能按字段名直译**：`progress` 是 0-100 整数（`1` = 1%）；时长单位是**秒**；
   `noteCount` 是**划线数**不是总笔记数（总数 = `reviewCount + noteCount + bookmarkCount`）；
   书架总数 = `books + albums + (mp 非空 ? 1 : 0)`，**有声书不进书架卡片**（它读不了也划不了线）。

**凭据安全**：Key 只从环境变量 `WEREAD_API_KEY` 或 `data/local_api_config.json`
（DPAPI 密文，`data/` 已 gitignore）读取；`ci_gate.py` 已加 `wrk-` 扫描模式。
`core/weread.py` **自己不读凭据** —— 由 `api_server` 解析后注入，core 层保持纯净可测。

---

## 8. 分阶段落地步骤

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| **P0** 多书源取数 | `core/book_sources.py` + `/api/reading/search` | ✅ **已完成** |
| **P0.5** 取正文 / 文件链接 | `/api/reading/books/{key}/fulltext/fetch` + `/api/reading/links`（§8.8） | ✅ **已完成并真实联网实测** |
| **P1** 微信读书接入 | `core/weread.py` + `/api/reading/weread/*`（Key 管理 / 书架同步 / 划线拉取） | ✅ **已完成并实测** |
| **P2** 书架封面墙 | `static/reading.js` + `static/styles-reading.css` + `/api/reading/books` | ✅ **已完成** |
| **P3** 分类与简介 | `core/reading_digest.py`（`guess_category` / intro） | ✅ 引擎完成（简介路由待接） |
| **P4** 阅读页 | 正文 + 侧边问 AI + 高亮笔记（复用 `literature_marks`，§7.3） | ⬜ 待 fulltext/import 路由 |
| **P5** 收获文档 | `/api/reading/books/{key}/digest` + 自动沉淀卡片 + 正文编辑 | ✅ **已完成** |
| **P6** 统计与打卡 | `/readdata/detail` 统计页 + 时长并入打卡热力图 | ⬜ |
| **P7** 学习闭环 | 全文导入为资料 → 复用框架/卡片/测验；RAG 陪读限定该书 | ⬜ |
| **P8** Agent 工具 | 把读书相关工具注册进知源 Agent 工具集 | ⬜ |

> **P0–P5 是「读书功能」的最小可用闭环**：能搜到书 → 分类摆好 → 每本有介绍 →
> 能读能问能划 → 读完有收获。P6 之后是锦上添花。

### 8.1 已交付清单（本轮）

| 文件 | 内容 |
| --- | --- |
| `core/book_sources.py` | 多书源注册表（**11 源** × 全文/元数据/外链 + `needs_proxy`/`blocked` 可达性标注）+ 版权红线 + 单源失败隔离（§8.8 扩到 SE / IA / HathiTrust 与文件链接） |
| `core/weread.py` | 微信读书适配层（唯一出网口）：书架 / 进度 / 划线 / 统计；`transport` 可注入 |
| `config.py` | 新增 `read_extra_local_secret` / `save_extra_local_secret`（模型之外的第二把凭据） |
| `core/reading_digest.py` | 三级分类 / 每书简介 / 读书收获（逐字段校验 + 本地兜底 + Markdown 渲染） |
| `core/reading_store.py` | `reading_books` / `reading_docs` 两表；**按需建项目**（有资料才建）+ **收获自动沉淀卡片** |
| `core/database.py` | 新增 `create_book_project` / `list_book_projects`（`project_type='book'`） |
| `core/llm.py` | 新增 `make_reading_digest` / `make_book_intro` 两个任务分支 |
| `api_server.py` | `/api/reading/*` 七个端点 |
| `static/reading.js` + `static/styles-reading.css` | 书架封面墙 / 跨源搜索 / 读书收获（独立文件，可摘链接回退） |
| `static/index.html` + `static/agent-shell.js` | 侧栏「读」入口 + 工作区 + 模块接线 |
| `_reading_preview.html` | 高保真预览（书架 / 阅读页含 AI 侧栏与高亮 / 收获文档，含深色模式） |
| `tools/verify_weread.py` | 微信读书适配层（归一化 / 口径 / 客户端约定 / Key 安全）**60 条** |
| `tools/verify_reading_*.py` | **247 条断言全绿**（含上面 60 条） |

### 8.2 两件自动化的实现要点

1. **按需建项目**：加入书架**不建** —— 只有真要往里放资料时才调
   `ReadingStore.ensure_project()` → `Database.create_book_project()`（`project_type='book'`）：
   本地导入 / 导入正文（`POST /api/reading/books` 带 `with_project=True`）、取回正文、
   生成收获沉淀卡片。幂等：重复加入复用同一项目。
   书一旦有项目，就直接继承 框架 / 卡片 / 测验 / 掌握度 / 撤销 / 导出 整条链路。
2. **收获自动沉淀为知识卡片**：`POST /api/reading/books/{key}/digest` →
   `build_sync_cards()`（稳定 `rd_` card_id）→ `sync_cards()`（upsert + 回收）。
   机制照搬 `knowledge_doc`，所以**重新生成不会丢 FSRS 排期**，
   且只认 `rd_` 前缀 —— 用户手工建的卡绝不被回收。

### 8.4 找书与正文：能力边界的实测结论（2026-10-07）

用户反馈「搜索不到书籍、没有原文、收获太少没按章节展开」，实测后确认**根因是能力边界**：

| 路径 | 实测结果 |
| --- | --- |
| 微信读书 `/store/search` | **HTTP 200 但 results 恒为空**（该 key 无搜索权限）。`/_list` 确认它是唯一搜索接口 |
| 古腾堡 / Open Library / Google Books / 维基文库 | **HTTP 000，全部不可达**（国内网络） |
| 微信读书 `/book/chapterinfo` | ✅ 16 章目录 |
| 微信读书 `/book/bestbookmarks` | ✅ **全书热门划线 20 条（共 330）**，含原文与划线人数 |
| 微信读书 `/book/recommend` | ✅ 个性化推荐（**可作发现入口**） |
| 微信读书正文 | ❌ **不提供**（商业边界，改不了） |

**据此定下的三条路径**：

1. **找书**：主路径改为 **本地导入 + 为你推荐 + 书架同步**；
   跨书源搜索降级为折叠区（并如实显示「书源全部不可达」）。
2. **正文**：本地导入的书 → **真全文**（走既有上传/解析/OCR 链路）；
   微信读书的书 → **「精华阅读」＝ 章节目录 + 每章最热原文片段**（诚实标注不是全文）。
3. **收获逐章展开**：`digest` schema 新增 `chapters[]`（title / summary / key_points / takeaway）。
   微信读书的书喂「全部章节 + 各章热门划线」，本地书喂 `split_chapters()` 切出的
   **章节正文摘录**。没有材料的章**照样输出**，渲染成「本章材料不足」——
   **静默少章比显示缺口更糟**。

**两个关键设计取舍**：

- **章节序号改为渲染时动态算**，且「自测」小节标题**去掉序号**。
  原来写死「七、自测…」，一旦新增「逐章精读」小节，序号全变 ——
  而卡片是永久数据，老卡片的 `origin_section` 不会跟着改，锚点就失效了。
- **收获正文弃用 `<details>` 折叠块**：正文是 contenteditable 的，保存要把 DOM
  反写回 Markdown，折叠块反写不回去（会把答案挤成一行或整段丢）。

### 8.4.1 「一手书源」的正解：国内可达的源（2026-10-07 补）

前面那张表只测了海外源，结论是「全不可达」——**漏了一半**。补测国内站点后发现：

| 站点 | 可达性 |
| --- | --- |
| **豆瓣读书 `book.douban.com`** | ✅ **200** —— `/j/subject_suggest` 返回干净 JSON，条目页可解析**简介与评分** |
| 中国哲学书电子化 `ctext.org` | ✅ 200（API 搜索需注册 IP） |
| 识典古籍 / 古诗文网 / 书格 / 国家图书馆 | ✅ 200 |
| 古腾堡 / Open Library / Google Books / 维基文库 | ❌ 超时或代理 502 |

**所以「一手书源」有解，只是要找国内的。** 本轮已落地 **豆瓣源**：

- `_search_douban()`：`/j/subject_suggest?q=` → 书名 / 作者 / **封面** / 年份。
  **它是国内网络唯一稳定可达的中文书目源**，所以排在 `DEFAULT_SEARCH_SOURCES` 第一位。
  同一接口还会返回影视条目（`type != "b"`），必须滤掉。
- `douban_detail()`：条目页 → **简介（成段论述）** + 评分。只解析这两个字段，
  其余一律不取（既是版权边界，也避免把 HTML 噪音喂给模型）。
- 豆瓣**不返回分类标签**，所以分类只能靠书名推断 —— 有可识别关键词能归类，
  没有就落「其他」（比瞎猜强）。这是它的真实限制，已写进断言。

**简介是「减少碎片化」的关键**：微信读书只给 20 条热门划线 + 章节标题，全是碎片；
`/book/info` 的 `intro` 与豆瓣的简介是**成段论述**。现在收获生成时会自动按源去拉：
`_reading_book_intro()` 对 weread 走 `/book/info`、对 douban 走条目页。

**同时修掉一个让状态失真很久的 bug**：`_http_json` / `_http_text` 原先失败时
`return None` —— 于是 `_safe_fetch` 什么都捕获不到，「书源连不上」被记成
「ok，0 结果」，界面把网络故障显示成「没有找到这本书」。现在改为**抛 `FetchError`**：
`_safe_fetch` 照常兜住（单源挂掉不炸整轮），但错误会先被记一笔，状态就准了。
实测海外源现在如实报 `FetchError: ReadTimeout / ProxyError: 502`。

### 8.4.2 本地导入全链路（真·原文）

「没有原文」的唯一可靠解法是本地导入 —— 已端到端验证：

```
① POST /api/reading/books（source=local, with_project）→ 按需建项目 ✅
② POST /api/projects/{pid}/sources（multipart）→ 解析入库  ✅ 11598B → 3992 字
③ GET  /api/reading/books/{key}/outline → kind=fulltext     ✅
④ POST /api/reading/books/{key}/digest → 逐章展开           ✅ 4 章全部有正文
```

**对比**：同一套引擎，微信读书的书只能出「章节 + 20 条热门划线」，本地书能出
「章节 + 每章正文摘录」—— 后者才是用户要的「不碎片」。

### 8.4.3 阅读字号（高亮 / AI 辅助 / 正文共用一档）

一个倍率 `--rd-scale` 管全篇：收获正文、精华阅读的高亮片段、编辑态 textarea 都跟着走。
顶栏四挡（A− / A / A+ / A++），落 localStorage。
**刻意不做「分三处各调各的」** —— 那正是「字号不可调」最烦人的地方。

顺带修了一处遗漏：`.rd-quote`（精华阅读的高亮原文片段）**在样式表里根本没有对应规则**，
一直是浏览器默认 blockquote 样式（又斜又挤）。已补：衬线 + 左侧暖色细线 + 出处右对齐。

### 8.5 正文直改（去掉编辑按钮）

用户要求「编辑正文不需要搞一个按钮，直接编辑即可」。改为 **contenteditable 直改 +
防抖自动保存**，与 `static/knowledge-doc-ui.js` 同一套思路（那边已跑通）：

- 渲染出的 HTML 放进 `contenteditable="true"` 的容器，点进去就能打字；
- 输入后防抖 1.2s 落库，失焦立即落一次；
- 保存时用 `serializeBlocks()` 把 DOM **反写回 Markdown**
  （认 h1~h6 / p / ul / ol / blockquote / strong / em / code / hr，Chrome 塞的 `<div>` 收编）；
- 因此渲染器**只产出这几种朴素块** —— 反写认不出的元素会丢字。

### 8.6 前端请求层的三个坑（都真实踩过）

1. **`window.api` 要的是 fetch 原生选项，不是「body 传对象我帮你序列化」**。
   `window.api = (path, options) => fetch(path, {credentials, ...options})` ——
   写 `api(path, {method:"POST", body:{...}})` 会发出去一个 **body 是 `[object Object]`、
   又没有 `Content-Type`** 的畸形请求，后端回 422/400。
   症状是「**按钮点了没反应，控制台还什么都不报**」——
   读书模块的六个写操作（搜书 / 保存 Key / 同步书架 / 加入书架 / 生成收获 / 保存正文）**一度全废**。
   修法：统一走 `postJson(path, payload, method)`。
   **回归**：`tools/_probe_reading_widget.mjs` —— 在 jsdom 里真点一遍按钮，
   断言每个写请求的 `body` 是字符串、带 `Content-Type`。
   已验证它**能抓到**这个 bug（退回旧写法报 4 条红，并直接打出 `[object Object]`）。
2. **改了前端 JS 必须提缓存串**，否则浏览器还在跑旧文件，改了等于没改。
3. **防御层会吞掉失败信号**。各源搜索器内部用 `_safe_fetch` 兜住网络异常
   （刻意的，为了让单源挂掉不炸整轮），代价是异常不再冒泡 ——
   于是「书源连不上」被记成「ok，0 结果」，新加的状态追踪形同虚设。
   修法：在 `search_books` 里挂一个**记录型 fetch**，先记一笔再原样抛出。
   这条修正让「书源全挂」和「确实没这本书」在界面上**终于分得开**。

### 8.7 收获质量复盘：根因是「没有米却硬做饭」（2026-10-07 二次实测）

用户反馈「搜不到书 / 没有原文 / AI 收获无效信息太多、有效信息太少、没有逻辑框架、
不能深入浅出」。逐条实测后定位到**五个各自独立的原因**，全部已修。

**① 收获里为什么全是通识 —— 输入是空的**

查 `reading_docs.signature`：8 本书**全部**是 `da39a3ee5e6b4b0d`（`sha1("")`），
即生成时 `highlights` 与 `thoughts` 都是空数组。再往上游查：

| 接口 | 实测 |
| --- | --- |
| `/user/notebooks` | `totalNoteCount=0`、`totalBookCount=0` —— **该账号本来就没有任何划线/想法** |
| `/book/bookmarklist` | 恒 **HTTP 499** |
| `/book/bestbookmarks` | 恒 **HTTP 499**（间隔重试 3 次仍 499，不是限流） |
| `/book/info` | 恒 **HTTP 499** |
| `/book/chapterinfo` | 200，但 8 本书 `chapters` **全为空数组** |
| `/shelf/sync`、`/user/notebooks`、`/readdata` | ✅ 正常 |

所以模型拿到的是「书名 + 作者」，却被要求填满 `models / insights / actions / quotes`。
它的做法是**违反事实铁律、拿训练数据里对这本书的印象硬填** ——
`纳瓦尔宝典` 那份的 `grounding` 自己招了：「均基于书籍的通用核心内容生成」。
这就是「无效信息太多、有效信息太少」的全部来源。

**修法（核心）**：给 payload 加 `material`（个人划线 / 想法 / 热门划线 / 章数 / 简介字数）
与 `mode`，产出定位随材料切换 ——

| 情形 | mode | 产出 |
| --- | --- | --- |
| 有用户自己的划线或想法 | `personal` | 《读书收获》——原样 |
| 有简介 / 目录 / 热门划线，但没有个人笔记 | `book` | 《**书籍导读**》，且**系统**在正文最前挂一条如实声明（不经模型，润色不掉） |
| 材料**全空** | — | **不调模型**，直接输出「材料不足 + 怎么才能有」 |

「材料全空不调模型」是这次最关键的一条：调了必然幻觉，省下这一次调用比拿到一篇假收获强得多。
对应实现：`reading_digest.material_is_empty()` / `build_insufficient_digest()`。

**② 没有逻辑框架**

原文只有 `core_arguments`（扁平的论点列表），读者拿不到整本书的骨架。
新增 **`spine`（全书逻辑主线）**：3~6 步，「要回答什么问题 → 主张 → 怎么论证 → 结论」，
渲染成文档的**第一节**（在逐章精读之前）。实测模型产出 5 步、层层递进，框架感立刻出来。

**③ 目录噪音被当成章**

`/book/chapterinfo` 会把**封面 / 版权信息 / 作者简介 / 内容简介 / 目录**也当章返回，
它们没有正文也没有划线 → 「逐章精读」里冒出一排「本章材料不足」，看着像功能坏了。
`weread.is_non_body_chapter()` 剔除这份**明确清单**（比较前去掉全部空白，
因为真实目录里会出现「目 录」这种写法）；**前言 / 序 / 后记 / 附录一律保留**，它们是正文。

**④ 搜不到书 —— 入口误导，不是源不可用**

豆瓣实测可用（`纳瓦尔宝典` 1 条、`认知觉醒` 3 条、`人类简史` 5 条），
但搜索框原先被折叠在 `<details>` 里，标题写着「海外公版书源，国内网络常常连不上」，
placeholder 也只列海外源 —— 用户根本不知道豆瓣能用。
现在搜索框提到最前、placeholder 写明「中文书目走豆瓣」，海外源在结果里如实标注可达性。

**⑤ 没有原文 —— 唯一合法路径是本地导入，但入口太深**

微信读书不给正文是商业边界，改不了。现在**阅读页**直接给「导入这本书的正文」按钮：
文件传进这本书自己的项目（复用既有上传 / 解析 / OCR 链路），再调
`PUT /api/reading/books/{key}/fulltext` 落一个标记 ——
书架卡片会打上「全文」徽标，阅读页也切成真全文。
`/outline` 现在**项目资料优先于书源**：只要项目里有正文就读它，
否则用户明明导入了，阅读页还是只给 20 条热门划线。

**已交付（本轮）**：

| 文件 | 改动 |
| --- | --- |
| `core/weread.py` | `is_non_body_chapter()` + `chapter_list()` 过滤非正文条目 |
| `core/reading_digest.py` | `spine` 字段与渲染；`material` / `mode`；`digest_scope_note()`；`material_is_empty()`；`build_insufficient_digest()`；`heading` 参数 |
| `core/llm.py` | `make_reading_digest` 角色词：先看 `payload.mode`、深入浅出硬要求、spine 优先于细节 |
| `core/reading_store.py` | `mark_fulltext()` |
| `api_server.py` | 材料全空不调模型；scope 声明与标题随 mode 切换；`PUT /api/reading/books/{key}/fulltext`；`/outline` 项目资料优先 |
| `static/reading.js` | 搜索提到最前并如实标注；阅读页「导入这本书的正文」入口 |
| `tools/verify_reading_digest.py` | +21 条断言（mode / spine / scope / 材料不足） |
| `tools/verify_weread.py` | +10 条断言（非正文章节过滤） |
| `tools/verify_reading_api.py` | +4 条断言（材料全空 → insufficient 且不沉淀卡片） |

> **存量 8 份收获是旧渲染器产物**（正文里还有 `<details>` 折叠块，且序号会跳号，
> 当前渲染器已不产出这两者），且生成时划线为空。它们会在用户点「重新生成收获」时
> 被新版覆盖 —— 按当前材料状况，这些书会得到《书籍导读》或「材料不足」，
> 而**不再是**拿通识凑出来的假收获。这是有意的：宁可少，不要假。

### 8.8 取正文与文件链接：把「有函数没入口」补成一条真链路（2026-10-07 三次迭代）

用户原话是「最好能获取书籍正文**或者文件链接**」。查下来发现两件事：

**① `fetch_fulltext()` 早就写好了，但 API 层一次都没调过它** —— 全仓库只有测试在用它。
所以「公版书取全文」这个能力一直是**有函数、没入口**的死代码。

**② 书源表里只有一个国内可达的全文源，而它当时被标成不可搜索。**
重新实测（本机直连，2026-10-07）：

| 源 | 结果 |
| --- | --- |
| **standardebooks.org** | ✅ 搜索页 200（22s）、单页全文 200（850KB） |
| **ctext.org** | ✅ 页面 200，但内容是 **Cloudflare 挑战页**；搜索 API 需注册 IP → **拿不到正文** |
| **book.douban.com** | ✅ 1.2s |
| gutendex / openlibrary / archive.org / zh.wikisource / hathitrust / googleapis | ❌ 全部超时（googlebooks 甚至卡到 192s） |

**结论**：海外源不是代码问题，是线路问题 —— 所以这一轮做的是「**可达的源用足 + 不可达的源不空等 + 配上代理就能用**」。

#### 已交付（本轮）

| 文件 | 改动 |
| --- | --- |
| `core/book_sources.py` | `proxy_url()` / `using_proxy()`（复用 `TJU_PROXY_URL`，不新增配置项）；**代理贯通所有出网请求** |
| 同上 | 记录新增 `files[]`（多格式文件链接）/ `read_url` / `borrow_url` / `isbn` —— 「文件链接」的载体 |
| 同上 | **新增 Standard Ebooks 源**：搜索页解析 + `slug → 书名/作者/下载链接`；单页全文按 `epub:type="bodymatter chapter"` **结构化分章** |
| 同上 | **新增 Internet Archive 源**：`_djvu.txt` 直取 OCR 全文；**只有条目自己声明公版许可才给全文**，其余只给阅读/借阅链接 |
| 同上 | **新增 HathiTrust 反查**（按 ISBN → 馆藏/阅读链接，公开 `rightsCode`）；`find_file_links()` 汇总「能读/能借/能下」 |
| 同上 | Open Library 补 `ebook_access / ia / public_scan_b`：`public` 直取 IA 全文，`borrowable` 给借阅链接 |
| 同上 | `fetch_fulltext()` 返回 `chapters[]`；HTML→文本；古腾堡页眉页脚剥离；**`pick_fetchable()`：TXT 优先于 EPUB**（否则抓 EPUB 得到乱码） |
| 同上 | `_http_any()`：按响应内容自动判 JSON/HTML —— 书源里两种混着，早先只会解析 JSON，抓 SE 搜索页报的是「返回的不是合法 JSON」，而真相是「这个源不是 JSON 接口」 |
| `core/reading_store.py` | `files_json / read_url / borrow_url / isbn` 四列 + **增量迁移**（`CREATE TABLE IF NOT EXISTS` 不会给老表补列） |
| `api_server.py` | **`POST /api/reading/books/{key}/fulltext/fetch`**：取正文 → 走「粘贴文本」既有链路入库 → 落 `mark_fulltext`；搜索响应新增 `blocked_sources` / `proxy_in_use` |
| 同上 | **`POST /api/reading/links`**：找文件链接（正文拿不到时的兜底，经常更有用） |
| `static/reading.js` | 搜索结果显示文件链接胶囊 + 「取正文」/「找链接」；阅读页加「自动获取正文」/「找文件链接」；失败清单剔除「被跳过」的源 |
| `tools/verify_book_sources.py` | +60 条断言（SE 解析与分章、IA 版权分流、OL 三档、HTML/页眉处理、HathiTrust、跳过策略） |
| `tools/verify_reading_api.py` | +18 条断言（取正文 200/400、过短不入库、阅读页切 fulltext、找链接、代理状态） |
| `tools/_probe_book_e2e.py` | **真实网络端到端验证脚本**（本轮所有数字都出自它） |

#### 实测结果（本机直连，无代理）

| 项目 | 结果 |
| --- | --- |
| SE 搜索「pride and prejudice」 | 22.8s，1 条命中（Pride and Prejudice / Jane Austen / public-domain） |
| **取整本正文** | ✅ **234,342 字**，**40 章结构化章节**，交给既有 `split_chapters` 切出 24 章 |
| 文件链接 | 在线阅读 / EPUB / AZW3 / KEPUB 四条全部给出 |
| 豆瓣中文检索 | 1.2s，3 条 |
| **默认全源搜索** | **23.0s（优化前 241.6s）** |
| **找文件链接（无代理）** | **0.0s 直接说明需要代理（优化前 48.9s）** |

#### 两个关键取舍

1. **没配代理时「跳过」需要代理的源，而不是让它们挨个超时。**
   八个源里五个在墙外，DNS/握手会挂到远超 timeout 的位置 —— 实测一轮默认搜索要 **240 秒**，
   用户看到的就是「卡死了」。现在跳过并把状态写成「需要代理：未配置 TJU_PROXY_URL，已跳过」，
   感受从「坏了」变成「原来要配代理」。**两个例外**：调用方点名要某个源时照试；
   配置了代理时全部照试（`HTTPS_PROXY` / `TJU_PROXY_URL` 任一即可）。
   同时 `all_failed` 的口径改成「**真的试过并失败**」—— 被跳过的源没被尝试过，
   拿它们下「所有书源都没连上」的结论是错的。
2. **按源分档超时。** 默认 12 秒是给 JSON 接口的；Standard Ebooks 搜索页是 18KB HTML，
   实测 10~22 秒 —— 用默认档会把**唯一可达的全文源**判成超时。整本下载单独放宽到 60 秒
   （`_http_text_long()`，不直接给 `_http_text` 加参数是因为 `fetch_text` 可注入，多一个参数会把测试的假实现全打挂）。

#### 版权边界（延续既有铁律，没有放宽）

- `has_fulltext=True` 仍然**只对 `public-domain` 与 `user-provided` 放行**（`_norm` 强制）。
- Internet Archive 按**条目自己声明的许可**分流：`licenseurl` 写明公版才给 `_djvu.txt` 全文；
  可借阅的版权书只给 `details` 阅读页与借阅链接。
- Open Library 的 `borrowable` 标成 `licensed`：给借阅入口，**不落全文**。
- HathiTrust 只反查馆藏与阅读链接（`rightsCode` 原样透出：PD/US 可读、IC 仅检索）。
- 中文商业书（微信读书）依旧**只有本地导入一条正文路**，这一轮没动。

#### 怎么启用海外源

在 `.env` 里填 `TJU_PROXY_URL=http://127.0.0.1:7897`（与模型共用同一个变量），
古腾堡 / Internet Archive / Open Library / HathiTrust / 维基文库 会立刻出现在搜索结果里，
`/api/reading/links` 也会真的去反查馆藏。

### 8.9 收获结构对齐调研：补上「我的判断」，并挖出一个静默的截断 bug（2026-10-07 四次迭代）

拿调研结论逐条比对现有 digest schema 后发现：**大部分早就落地了，但最重的一条没有**。

| 调研建议 | 现状 |
| --- | --- |
| 全书骨架（spine） | ✅ 早有（§8.7 加的） |
| 逐章展开 | ✅ 早有（`chapters[]`） |
| 「反例与质疑」 | ⚠️ 有 `critique` 字段，但**条数下限是 0**，允许整节消失 |
| **「我的判断」** | ❌ **完全没有** —— 而调研里它是「收获」与「复述」的分界线 |
| **`confidence`（把握程度）** | ❌ 没有 |
| 链接短语（关系类型 + 为何） | ✅ 早有（`connections.relation` 六选一 + `note` 必填） |
| 练习性测验最强 | ✅ 早有（`self_check` → 自动沉淀知识卡片） |
| 依据可回源 | ✅ 早有（`grounding`） |

**本轮改动**

| 文件 | 改动 |
| --- | --- |
| `core/reading_digest.py` | 新增 **`judgment`**：`verdict`（必须表态：信 / 只信一部分 / 不信）+ `confidence`(1–5) + `why` + `when_not`（适用边界）+ `open_questions`；`_normalize_judgment()` 校验（confidence 越界当没给，过短 verdict 视为未答） |
| 同上 | `critique` 条数要求从 `0~4` 改为 **至少 1 条**；材料不足以判断时要求如实写「现有材料不足以判断」而不是编 |
| 同上 | 渲染新增「我的判断（我自己怎么想）」一节，紧跟在「边界与反例」之后 |
| 同上 | **`critique` / `judgment` 缺失不再静默消失**：有材料却没答时，渲染出一节空位 + 该填什么（把缺口变成一句明确的邀约，而不是假装完整） |
| `core/llm.py` | 角色词补上 judgment 的硬要求（「把作者的话换个说法不算判断」） |
| `tools/verify_reading_digest.py` | +13 条断言（结构、confidence 夹取、缺失兜底、渲染顺序） |

**顺带挖出的静默 bug（比新字段本身更重要）**

真实跑一次 20 章的收获，发现 `critique` 与 `judgment` **永远是空的**。根因不在 schema，而在 token 预算：

- `_max_tokens_for_task()` 里**没有 `make_reading_digest` 这一档**，落到默认 **4096**；
- 一本 20 章的书，光 `chapters`（每章摘要 + 2~4 条要点 + 拿走一条）就要 6000~9000 token；
- 于是响应在写到 schema 后半段前被截断，`_close_truncated_json()` 补上括号救回前半段 ——
  **结果看着"成功"，实际上排在最后的 `critique` 整节丢了**，日志里只有一行原始响应。

修法两条，缺一不可：
1. `make_reading_digest` 单独给 **16384**（网关限流时由 `_max_tokens_cap_from_error` 自动降级重发）；
2. **schema 字段顺序调整**：把 `critique` 与 `judgment` 移到 `chapters` **之前** ——
   模型按顺序往下写，一旦截断，后面写的先丢；吃预算的大户（chapters）必须排在必答项之后。
   （渲染成文档时的小节顺序不受影响，由 `render_digest_markdown` 决定。）

**验证（真实模型，20 章 / 23.4 万字正文）**

```
小节：一、全书逻辑主线  二、逐章精读  三、这本书在讲什么  四、可以拿走的模型与框架
      五、反常识的地方  六、明天就能用上的清单  **七、这本书说得有道理吗（边界与反例）**
      **八、我的判断（我自己怎么想）**  九、和我的知识库的联系  自测  依据说明
judgment：confidence=4，verdict=「只信其中一部分…」
critique：2 条
```

「我的判断」的实际产出质量（节选）：

> **我的判断**（把握 4/5）：只信其中一部分。我完全信服书中关于"打破自我中心与主观臆断"对于建立健康关系的论述……但我对书中隐含的"只要克服性格缺陷，阶级与物质的障碍就能被浪漫化消解"持保留态度，这在现实中往往过于理想化。
> **什么情况下我不用它**：当面对结构性歧视、系统性贫困或极度不对等的权力关系时，仅靠"克服偏见"与"自我反省"不足以解决问题。

这正是调研想要的东西：**不是复述作者，而是给出自己的立场和边界**。

> ⚠️ **本轮 Python 改动需要重启一次后端才生效**（前端只需刷新，缓存串已提）。
> 验证脚本：`tools/_probe_digest_structure.py`（进程内真实模型调用，不依赖运行中的服务）。

---

## 9. 风险与注意

1. **密钥安全**：`wrk-` 密钥绑定用户身份，等同账号凭证。沿用知源现有凭据链（环境变量 / DPAPI 加密文件），**绝不进仓库、不进日志**；`ci_gate.py` 可加 `wrk-` 模式扫描。
2. **只存用户自己的内容**：只落**用户自己的划线/笔记/进度**，**不抓、不落全本正文**——既规避版权，也符合知源「本地优先、数据不出本机」的定位（只有调模型时按需发片段）。
3. **频控**：同步要**增量**（`/user/notebooks` 游标 `lastSort` 翻页、按 `readUpdateTime` 判断变化），别每次全量拉；书架几百本时 `getprogress` 只查最近若干本。
4. **字段单位坑**（官方文档明确强调）：`totalReadTime` / `recordReadingTime` 是**秒**；`progress` 是 **0-100 整数，1 表示 1%**；`preferTime` **从 6 点开始排序**。这些必须在适配层统一换算，别让前端猜。
5. **字段名误导**：`noteCount` 是**划线数**不是总笔记数；总笔记数 = `reviewCount + noteCount + bookmarkCount`；书架总数 = `books + albums + (mp ? 1 : 0)`（有声书也算书）。
6. **多书源的版权红线**：`has_fulltext` 只对公版书与用户自备文件放行（代码强制）。
   豆瓣**无公开 API**，只作外链入口，**不抓取**。任何「聚合全文」的做法都要先过这一关。
7. **多书源的外部依赖**：古腾堡/维基文库等在国内网络可能需代理；单个源不可用只影响该源，
   门禁与单测一律**注入假 fetch**，不依赖外网。

---

## 10. 参考资料

- 官方：`https://github.com/Tencent/WeChatReading`（`skills/*.md` 接口文档）
- MCP：`https://github.com/ChenyqThu/mcp-server-weread`
- 同步：`https://github.com/malinkang/weread2notion`、`https://github.com/hodgekou/weread2notion-AI`
- 逆向（仅参考）：`https://github.com/lbq110/weread-exporter`
- 公版书源：古腾堡（`gutendex.com`）、维基文库（`zh.wikisource.org/w/api.php`）、
  ctext（`api.ctext.org`）、Standard Ebooks
- 书目元数据：Open Library（`openlibrary.org/search.json`）、Google Books（`googleapis.com/books/v1`）
