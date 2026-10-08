# 知源（KnowOrigin）· 技术设计文档

> 你的资料值得一个更懂它的 AI。

本文档基于代码图谱（CodeGraph 对 `api_server.py` + `core/` 的 AST 分析）撰写，描述知源的**真实架构与实现**，而非产品愿景。代码现状以仓库 `agent2026-Knoworigin` 为准。

知源是一个**本地优先（Local-first）的 AI 学习工作台**：把一门课的课件、一本难啃的书、一批精读的论文、一个刚入门的领域「导进来」，陪用户走完整条学习链路——搭知识框架、按薄弱处引导深入、生成可翻面记忆卡片、出带解析的测验、精读文献、整理笔记，并把每一次努力沉淀为看得见的掌握度。核心主张：问答与解析优先依据用户自己的资料作答，并标明来源。

---

## 1. 分层架构

```
┌──────────────────────────────────────────────────────────────┐
│  表现层   原生 JS 单页应用（无打包工具）                          │
│  index.html · app.js · agent-shell.js（工作台外壳）              │
│  literature.js · english-exam-ui.js · english-vocab-ui.js       │
│  study-desk-ui.js · streak.js · hxt-pet.js（桌宠）               │
│  reading.js（读书）· kb-neural-view.js / rd-neural-view.js（沉浸图谱）│
│  三套布局：styles.css + agent-layout.css + classic-palette.css   │
│  纯样式增强层：styles-polish / styles-immersive / styles-neural  │
│  KaTeX（完全本地化）· Web Manifest                                │
└────────────────────────────┬─────────────────────────────────┘
                               │  HTTP + SSE（流式）
┌────────────────────────────┴─────────────────────────────────┐
│  接口层   FastAPI（api_server.py，单文件 ~3.2 万行）              │
│  create_app() 聚合所有路由；依赖注入 db / settings / llm_client   │
│  认证 · 项目 · 资料 · 框架 · 卡片 · 测验 · 收藏 · 撤销 · 文献      │
│  多会话 · Agent 工具循环 · 论文检索 · 英语应试 · 台历排期           │
│  读书（多书源）· 跨书知识网络 · 长期记忆 · 校园信源 · 用量记账       │
└────────────────────────────┬─────────────────────────────────┘
                               │
┌────────────────────────────┴─────────────────────────────────┐
│  业务层   core/（55 个模块）                                      │
│  database.py  framework.py  llm.py  parsers.py  models.py       │
│  english_vocab/exam/writing  exam_scheduler  review             │
│  paper_recall  user_memory  teaching_mode  mastery_bkt          │
│  reading_store  reading_digest  knowledge_net                   │
│  weread  book_sources  progress_engine  transfer …              │
└──────────┬───────────────────────────┬────────────────────────┘
           │                           │
┌──────────┴───────────┐   ┌───────────┴────────────────────────┐
│  存储层               │   │  模型层（OpenAI 协议兼容）            │
│  SQLite + 本地文件     │   │  主模型 tju-llm（天津大学 AI 平台）   │
│  data/ · logs/        │   │  本地不跑权重，仅做 HTTP 调用         │
└───────────────────────┘   └──────────────────────────────────┘
```

> **模型层即推理引擎**：本地不跑模型、不装权重。所有「理解」类工作都交给走 OpenAI 兼容协议的 `tju-llm`（默认 `ai.tju.edu.cn`）。换模型只需改 `KNOWORIGIN_BASE_URL` + `KNOWORIGIN_MODEL`，代码不动。OCR 主路走本地 RapidOCR（`core/parsers.py:_RapidOCREngine`），可选配置视觉模型作最终兜底。

---

## 2. 业务层模块职责

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `core/database.py` | 3130 | `Database` 类，封装全部 SQLite 访问；表结构、用户/项目/来源/节点/卡片/测验 CRUD；掌握度事件写入；撤销快照（`undo_history`）；异常 `UserNotFound` / `UserAlreadyExists` / `ProjectNotFound` / `NodeNotFound` / `SourceNotFound` / `FavoriteNotFound` |
| `core/framework.py` | 1761 | 知识框架与掌握度：`build_framework` 由资料生成节点树；`record_evidence` 写入学习事件；`mastery_evidence_rules` 与 `compute_mastery_breakdown` 给出可解释掌握度；`generate_fallback_cards` / `generate_fallback_quiz` 模型失败时的本地兜底 |
| `core/llm.py` | 2323 | `LlmClient` 统一模型调用：OpenAI 兼容、SSE 流式、Function Calling、JSON 强约束；`_StreamRepetitionGuard` 流式重复检测与裁剪；异常 `ModelApiError` / `ModelOutputError` |
| `core/parsers.py` | 3846 | 多格式解析：PDF 文本层（PyMuPDF / pdfplumber）+ RapidOCR 扫描兜底；公式 LaTeX 抽取（`_RapidOCREngine`）；`_repair_formulas_latex` 公式修复；页面切块与位置信息 |
| `core/models.py` | 526 | Pydantic 请求/响应模型：`User` / `TranslateRequest` / `SourceViewExplainRequest` / `StudyItemRename` 等 |
| `core/discussion.py` | 504 | AI 同学讨论状态机：`SEED`（播种）→ `OPEN`（开放讨论）→ `ASSESS`（评估）→ `ARBITRATE`（仲裁）；`build_turn_messages` / `compress_point` 维护多轮对话与接力账本 |
| `core/digest.py` | 146 | 知识库摘要（`kb_digests`）：通读全库生成知识空白、可写论断、资料张力 |
| `core/knowledge_doc.py` | 1637 | 知识点文档：单节点详解的逐字段校验与本地兜底合并、递进坐标本地计算（第 N 站 / 第 M 层 / 承接谁）、按章节或按层序合订、正文手工编辑的落库（`save_markdown` 只改 `content_md`，结构化留档与指纹不动） |
| `core/mineru.py` / `core/pages.py` | 543 / 418 | 可选高质量 PDF 通道（MinerU）与页面级抽取（公式区域检测，公式不重排保持原貌） |
| `core/tju_courses.py` | 189 | 天津大学课程库 116 条元数据（课程号 / 名称 / 学科；113 条带课程号，另 3 条是体育 / 大学英语 / 文化素质选修三类公共项）；按课名预判学科选择题卡 few-shot |
| `core/campus_sources.py` / `campus_lexicon.py` / `wx_accounts.py` | 2079 / 368 / 849 | 校园检索抓取：北洋维基全站正文 + 官网矩阵 + 公众号文章；60 个天大公众号订阅库清单 |
| `core/prompt_catalog.py` | 487 | 提示词模板目录：按学科/难度汇聚 few-shot 示例（光学、通用等） |
| `core/prompt_overrides.py` | 101 | 提示词本地覆盖层：用户在提示词实验室改过的模板落在这里，读取时盖在 `prompt_catalog` 之上 |
| `core/tesseract_auto.py` | 66 | RapidOCR / Tesseract 自动探测与降级 |
| `core/review.py` | 787 | 卡片 FSRS 间隔复习：到期队列、复习提交、排期预览 |
| `core/mastery_bkt.py` / `mastery_audit.py` | 282 / 215 | BKT 贝叶斯知识追踪（识别「会做错 / 蒙对」的掌握度误判）与掌握度证据审计 |
| `core/progress_engine.py` / `transfer.py` | 1094 / 662 | 进步引擎（BKT 当闸门、界面用四档位阶替代百分数；陪练台的五档提示强度梯子在这里）与迁移式学习（跨知识点迁移训练与回归验证） |
| `core/teaching_mode.py` | 1402 | 教学模式：direct / guided 两档讲解口径 + 按问题分类的轮次动作（卡壳 / 答错时直接给答案；卡壳轮开场角度由规则层按历史轮换；「练练 / 来一道」识别为练习请求直接出题） |
| `core/study_kit.py` / `conflicts.py` | 394 / 383 | 学习路径建议与知识冲突（矛盾说法）检测 |
| `core/english_vocab.py` | 917 | 英语词汇纯逻辑层：候选词判据、FSRS 调度（公式与参数移植自 py-fsrs, MIT License）、语料覆盖率 |
| `core/english_dict.py` / `english_store.py` | 314 / 1331 | 内置词书（ECDICT 衍生数据）加载与英语数据存取（`en_*` 表） |
| `core/english_exam.py` / `english_exam_data.py` | 3114 / 2838 | 考研应试精读：三级级联选文、六维深度解析、熟词生义库、同义替换 FSRS 沉淀；内置题库数据 |
| `core/english_writing.py` | 1810 | 作文升格批改：规则体检（中式英语/可升级词/句式级差）+ AI 升格 + 翻译批改 + 精华回填 |
| `core/corpus_vocab.py` | 661 | 语料采词：从用户资料摘录英文语料片段（英文零模型、中文过模型转写），每词带原句锚点 |
| `core/english_reading_sources.py` | 916 | 联网英语阅读泳道：11 个源注册表、发布时间过滤（60 天）、全文抽取 |
| `core/exam_scheduler.py` | 2166 | 期末自适应冲刺：强度模型（目标分×掌握度缺口×天数×带宽）、倒推三阶段装配、RFC-5545 ICS 导出 |
| `core/paper_recall.py` / `paper_search.py` | 1034 / 1079 | 论文检索四层管线（改写→多源并发→RRF→精排）与期刊检索 |
| `core/citation.py` | 417 | 文献引用补全（Crossref 标题相似度消歧）与 BibTeX/CSL 导出 |
| `core/evidence_matrix.py` / `peer_review.py` | 279 / 240 | PRISMA 综述矩阵（8 维抽取、Gap 标注、CSV 导出）与顶刊同行评审红队 |
| `core/user_memory.py` / `notify.py` / `usage.py` | 1718 / 612 / 816 | AI 长期记忆（两层固定槽位）、学习周报、AI 用量记账与每日限额 |
| `core/vault_export.py` | 551 | 导出 Obsidian 知识库：标准 Markdown + `[[双链]]`，前端只有薄薄一层按钮 |
| `core/book_sources.py` | 1712 | 多书源注册表（11 源 × 全文/元数据/外链，逐源标注 `has_fulltext` / `rights` / `needs_proxy`）+ **版权红线**（`has_fulltext=True` 只对 `public-domain` / `user-provided` 放行，由 `_norm()` 强制）+ **单源失败隔离**（`_safe_fetch` 下沉到每个源）；豆瓣 / 微信读书 / 古腾堡 / 维基文库 / 本地导入归一化为同一记录结构 |
| `core/weread.py` | 571 | 微信读书适配层（**唯一出网口**）：官方 Agent API `POST /api/agent/gateway`，`Bearer wrk-` 鉴权；书架 / 进度 / 划线 / 想法 / 统计 / 推荐；`transport` 可注入，**自己不读凭据**（由 `api_server` 注入，core 层保持纯净可测） |
| `core/reading_store.py` | 531 | 读书数据存取：`reading_books` / `reading_docs` 两表；**按需建项目**（`ensure_project`，加入书架不建）+ 收获自动沉淀卡片（稳定 `rd_` card_id upsert + 回收，只认前缀） |
| `core/reading_digest.py` | 1487 | 读书收获：三级分类（纯规则 `guess_category`，不依赖模型）/ 每书简介 / 逐章收获；逐字段校验 + 本地兜底（兜底走宽松门槛 `_dict_list(strict=False)`）+ Markdown 渲染；`READING_ASK_SYSTEM` 定义陪读讨论口径 |
| `core/knowledge_net.py` | 1306 | 跨书知识网络：纯函数引擎（`similarity` / `candidate_pairs` / `build_graph` / `clusters` / `find_hubs` / **`find_bridges` 割点** / `cross_support` / `build_methodology_payload` / `build_skill_cards`）+ `NetStore` 四表 + `analyze()` 一次算全（nodes / edges / clusters / hubs / bridges / support / summary） |

前端相关脚本位于 `tools/`（端到端冒烟测试与图谱增长预览），不进入运行时包、也不随仓库分发；CI 门禁为 `src/tools/ci_gate.py`。

---

## 3. API 端点清单（来自 `api_server.py` 路由）

> 全部路由注册在 `create_app()` 内，装饰对象名为 `application`。以下按职责分组。

### 3.1 系统与海小棠
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` · `/sw.js` · `/admin` | 前端入口、旧缓存清扫脚本（SW 已退役）、管理面板 |
| GET | `/api/health` | 健康检查 |
| POST | `/api/hxt/react` · `/api/hxt/ask` | 桌宠反应与随手问答（SSE） |
| GET | `/api/prompts/tasks` · `/api/prompts/preview` | 提示词任务清单与预览 |

### 3.2 认证与管理
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST/PUT | `/api/auth/session` · `register` · `login` · `logout` | 本地账户与会话 Cookie |
| GET/POST/POST | `/api/admin/session` · `login` · `logout` · `overview` | 管理面板会话 |
| GET/PUT | `/api/config` | 模型端点读取与更新（端点/模型/密钥写 `data/local_api_config.json`，密钥经 DPAPI 加密） |
| POST | `/api/config/session` | 浏览器把本地保管的密钥下发到服务端内存（仅限本机请求，不回写凭据文件） |

### 3.3 项目、资料与框架
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST/DELETE | `/api/projects` · `/projects/{id}` | 项目 CRUD |
| DELETE | `/api/projects/{id}/messages` | 清空对话 |
| POST | `/api/projects/{id}/sources` · `sources/import-tju` · `sources/import-tju-folder` | 上传/导入资料（含天大课程文件夹） |
| GET | `/api/projects/{id}/sources/upload-progress` · `.../import-tju-folder/progress` | 进度查询 |
| GET/DELETE | `/api/projects/{id}/sources/{sid}/content` · `preview` · `preview-pdf` · `page-crop` · `pages` · `delete` | 资料预览与删除 |
| POST/GET | `/api/projects/{id}/framework/build` · `/framework` | 框架构建与读取 |
| POST/PATCH | `/api/projects/{id}/framework/nodes` · `/framework/{node_id}` | 节点新建与编辑 |
| GET/PUT/POST | `/api/projects/{id}/notes/search` · `notes/{node_id}` · `render` | 节点笔记检索/读写/双链渲染 |

### 3.4 学习闭环（卡片 / 测验 / 掌握度 / 收藏）
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST/GET | `/api/projects/{id}/cards/generate` · `.../recommend-questions`(+`/stream`) | 生成卡片与深挖问题（SSE） |
| PATCH/DELETE/POST | `/api/projects/{id}/cards/{cid}` · `self-rate` | 卡片重命名/删除/自评掌握度 |
| POST/GET/PATCH/DELETE | `/api/projects/{id}/quiz/generate` · `history` · `{qid}` · `submit` | 测验生成/历史/改/提交 |
| GET | `/api/projects/{id}/mastery/rules` · `mastery/breakdown` | 掌握度规则与可解释下钻 |
| GET/POST/PATCH/DELETE | `/api/projects/{id}/favorites(+`/{fid}/restore`)` | 我的笔记收藏与回收站恢复 |
| GET/POST | `/api/undo` | 50 步撤销栈查看与执行 |
| GET | `/api/me/streak` · `learning-calendar(+`/{date}`)` | 连续打卡与日历热力图 |

### 3.5 对话、研究助手与来源视图
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/projects/{id}/chat` · `chat/stream` | RAG 问答（SSE，检索本库资料） |
| POST | `/api/projects/{id}/discussion/start` · `act` | AI 同学讨论（状态机，SSE） |
| POST | `/api/projects/{id}/agent` · `agent/sessions(+`/{cid}`)` · `kb/digest` · `kb/node/{node}/complete` | 智能体（Function Calling）与知识库摘要 |
| GET/PATCH | `/api/projects/{id}/proposals` · `proposals/{pid}` | 整理助手建议列表与应用 |
| POST | `/api/projects/{id}/solve` · `solve-image` · `research-insights` · `source-view/explain` | 解题/解题（图）/研究洞察/来源视图二部图解释 |
| GET/POST/PATCH/DELETE | `/api/projects/{id}/chat/sessions(+`/{sid}`)` | 每项目多会话：清单 / 新建 / 重命名 / 删除。消息本体仍按 `conversation_id` 落在 `messages` 表，`chat_sessions` 只存会话壳（标题 + 时间） |
| GET | `/api/projects/{id}/vault/export` | 导出为 Obsidian vault |

### 3.6 文献模式
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/literature` · `/literature/stream` | 文献列表与流式导入 |
| GET/PATCH | `/api/literature/{pid}` · `/reading-progress` · `marks` | 文献读取/进度/高亮标记 |
| POST | `/api/literature/{pid}/extract` · `rearrange` · `repair-formulas` · `translate` · `translate-all` · `compare` · `ask` · `insights` | 抽取/重排/公式修复/翻译/对比/问答/研究洞察 |
| GET | `/api/literature/{pid}/rearrange-status` · `translate/status` | 异步任务状态 |
| POST | `/api/literature/compare/project` · `/literature/source-view/project` | 新建「多文献对比项目」/「来源视图项目」 |
| GET | `/api/library-links` · `/api/tju-courses` · `/tju-courses/{code}/files` | 资源库链接与天大课程元数据/文件树 |

### 3.7 复习、台历与记忆
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/review/queue` · `submit` · `card-rate` · `preview` | 卡片 FSRS 到期队列 / 复习提交 / 排期 / 间隔预览 |
| GET/POST/DELETE | `/api/exams` (+`import-weipeiyang`) | 考期管理（支持微北洋考表导入） |
| POST/GET | `/api/sprint/generate` · `current` · `task-toggle` · `export-ics` | 期末冲刺计划生成 / 当日任务打卡 / ICS 导出 |
| GET | `/api/me/streak` · `learning-calendar(+`/{date}`)` | 连续打卡与学习日历热力图 |
| GET/PUT/POST | `/api/memory/slots` · `profile` · `notes*` · `opt-out` | AI 长期记忆：槽位读写 / 全局画像 / 项目卡点 / 总开关 |
| GET | `/api/me/usage` | 个人 AI 用量记账查询 |

### 3.8 英语应试（`/api/en/*` 独立命名空间）
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/en/overview` · `decks` · `review` · `prefs` · `lookup` · `words` | 词书管理与 FSRS 复习队列 |
| POST/GET | `/api/en/scan` · `candidates` · `known` · `notebook` | 资料采词候选、熟词标记、生词本 |
| POST/GET/DELETE | `/api/en/corpus/scan` · `list` · `promote` · `collect` · `{id}` | 语料摘录：SSE 扫描 / 采词 / 手动划词收录 |
| POST | `/api/en/exam/side-analysis` · `translate` · `syntax-parse` · `paraphrase-*` | 精读侧栏解析（落库缓存）/ 划词翻译 / 长难句 / 同义替换 |
| GET/POST | `/api/en/exam/builtins` · `articles` · `journals` · `online-*` · `search-articles` | 级联选文与联网阅读泳道 |
| GET/POST | `/api/en/exam/writing/*` · `translation/*` · `demo-records` | 作文体检/升格、翻译指南/批改、演示历史 |

### 3.9 科研与检索
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST/GET | `/api/search/papers` · `authors` · `journals` · `paper/{id}` · `deep-analysis` | 四层检索管线（响应含来源可用状态与降级标记） |
| POST/GET/DELETE | `/api/research/matrix/*` · `reviewer/*` | 综述矩阵生成/导出 CSV 与审稿红队 |
| GET/POST/PATCH/DELETE | `/api/en/exam/highlights` · `conflicts*` · `study-kit` · `teaching-mode` | 高亮批注 / 冲突检测 / 学习路径 / 教学模式档位 |

### 3.10 知识点文档
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST/DELETE | `/api/projects/{id}/nodes/{nid}/doc` | 单个知识点的详解：读取 / 生成 / 删除 |
| GET | `/api/projects/{id}/knowledge-doc` · `knowledge-doc/compiled` · `layers` · `export.md` | 整份文档、合订稿、各前置层号上的知识点分布（前端用它画「只到第 N 层」选择器）、导出 Markdown |
| POST | `/api/projects/{id}/knowledge-doc/compile` · `knowledge-doc/ask` | 本地合订（可带 `order` / `maxLayer`，不调模型）/ 就本节材料提问（SSE，`allow_extra` 切发散档） |
| PUT | `/api/projects/{id}/knowledge-doc/content` | 手工编辑正文落库：只改 `content_md`，结构化留档（`content_json`）与指纹不动 |

### 3.11 读书与跨书知识网络（`/api/reading/*` 独立命名空间）

> 与 `/api/en/*` 同一做法：整块新能力锁在自己的命名空间里，便于回退与权限收口。

**书源与书架**
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/reading/sources` | 书源注册表：每个源能给什么（全文 / 元数据 / 外链）、版权状态、可达性 |
| POST | `/api/reading/search` | 跨书源搜书（单源失败隔离；**「源全挂」与「没这本书」分开报**） |
| GET/POST | `/api/reading/books` | 书架清单（可按一级领域筛选）/ 加入书架（默认**不建项目**，`with_project=true` 才建） |
| GET | `/api/reading/books/{book_key}` | 书籍详情：简介 / 评分 / 章节 / 进度 / 划线数 |
| PUT | `/api/reading/books/{book_key}/doc` | 保存手工编辑过的正文（`content_md` 直改，防抖落库） |

**收获、简介与卡片**
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/reading/books/{book_key}/digest` | 生成《读书收获》（逐章展开），并按 `rd_` 前缀沉淀知识卡片 |
| POST | `/api/reading/books/{book_key}/intro` | 生成每本书的一句话定位与介绍（成色不达标退回书籍自带简介） |
| POST | `/api/reading/digests/generate-missing` | 批量补齐还没有收获的书 |
| GET | `/api/reading/books/{book_key}/cards` | 该书收获沉淀出的卡片 |

**正文与阅读**
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/reading/books/{book_key}/outline` | 阅读大纲：有全文走正文分章，微信读书走「章节目录 + 每章最热原文片段」 |
| PUT | `/api/reading/books/{book_key}/fulltext` | 标记该书已有全文（本地导入登记） |
| POST | `/api/reading/books/{book_key}/fulltext/fetch` | 按源取回正文（**仅公版 / 用户自备放行**，商业书直接拒绝并说明原因） |
| POST | `/api/reading/links` | 查该书可用的外部阅读 / 下载链接 |
| POST | `/api/reading/books/{book_key}/ask` | **陪读讨论**（SSE）：前端给选区，只送选区所在那一块；默认发散档（温度 0.8） |

**微信读书（`wrk-` 密钥）**
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/reading/weread/status` | 连接状态；`?probe=1` 真打一次接口验证 Key |
| PUT | `/api/reading/weread/key` | 保存 `wrk-` Key（校验前缀；**响应绝不回显**） |
| POST | `/api/reading/weread/sync` | 同步书架 → 入库（**不建项目**）→ 顺带拉最近 N 本进度 |
| GET | `/api/reading/weread/books/{book_id}/notes` | 拉划线与个人想法（收获文档的直接输入） |
| GET | `/api/reading/weread/recommend` | 个性化推荐（发现入口） |

**跨书知识网络**
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/reading/net` | 整张网 + 结构分析（簇 / 枢纽 / **桥** / 跨书支持度）+ 已生成的方法论 |
| GET | `/api/reading/net/candidates` | 概念合并候选（**只给候选**，必带 `needs_confirmation`） |
| POST | `/api/reading/net/merge` · DELETE `.../merge/{from_key}` | 确认合并 / 撤销（合并错误 = 假连接，故绝不自动落库） |
| POST | `/api/reading/net/methodology` | 就某概念所在的**簇**生成方法论，并沉淀技能卡（`kn_` 前缀） |
| POST | `/api/reading/net/ask` | 就整张网提问（SSE）；材料由前端渲染后送来，无原文选段 |

---

## 4. 核心数据流

### 4.1 资料导入 → 框架 → 掌握度
1. `upload_sources` / `import-tju` 接收文件，`parse_upload` 调用 `core/parsers.py` 抽取文本层与公式 LaTeX，扫描版启用 RapidOCR。
2. `framework/build` 调 `core/framework.build_framework` 把资料结构化为带覆盖/学习/掌握状态的节点树（可折叠 + `[[双链]]`）。
3. 用户在节点上「翻卡 / 做题 / 提问 / 复习」，`record_evidence` 写入 `learning_events`；掌握度由 `mastery_evidence_rules` 按权重累积，`compute_mastery_breakdown` 可下钻查看。

### 4.2 流式问答与智能体
- `chat/stream` 与 `agent` 均走 SSE：`event_stream` 逐字推送 `delta` / `tool_call` / `done` 事件。
- 智能体（`agent_chat`）通过 `_run_agent_tool` 暴露检索、校园查询、来源视图等工具，由模型 Function Calling 自主选择；`_agent_trace_answer` 归整调用轨迹。
- 模型异常 → `ModelApiError`/`ModelOutputError` 被对应 handler 捕获，降级为本地启发式（`generate_fallback_cards` / `generate_fallback_quiz`）。

### 4.3 AI 同学讨论状态机
`core/discussion.py` 四态：`SEED`（播种问题）→ `OPEN`（三位 AI 同学接力，每轮只推进一件事）→ `ASSESS`（评估结论是否锚定资料）→ `ARBITRATE`（超范围显式标注）。`discussion_start` / `discussion_act` 通过 SSE 返回每一轮发言，`build_turn_messages` 维护对话上下文与接力账本。

### 4.4 多文献对比与来源视图
- 勾选多篇文献 → `compare_literature` 按「研究问题/方法/贡献/实验/结果/局限」逐维度对照，结果缓存于 `kb_digests`。
- `create_source_view_project` + `source-view/explain` 生成「资料 → 概念」二部图：多源支撑的概念高亮为交叉验证，孤证概念提示需补来源（`SourceViewExplainRequest` 承载请求）。

### 4.5 撤销与收藏
- 写操作前 `record_undo` 写入 `undo_history` 快照（`UNDO_KEEP_LIMIT = 50`）；`/api/undo` 执行回滚。
- 问答中值得留存的片段经 `favorites` 收藏，支持回收站 `restore`。

### 4.6 知识点文档：生成 → 合订 → 手工编辑
1. **逐节点生成**：`POST /nodes/{nid}/doc` 让模型写一份详解，返回后 `normalize_node_result` **逐字段校验** —— 某字段不满足成色要求（太短、条数不够、类型不对）**只退回该字段的本地兜底**（`build_node_fallback`），其余字段照用；兜底填的章节会在正文里自报家门，不拿学科通识硬凑。
2. **递进坐标本地算**：第 N 站 / 第 M 层 / 承接谁 / 引出谁 全部由本地按框架前置关系算出，**模型只负责写「为什么这个顺序不能颠倒」**，它给出的坐标一律被框架值覆盖 —— 顺序这类事实不进模型的手。
3. **合订**：`knowledge-doc/compile` 纯本地拼接（不调模型、不花钱），`order` 决定按框架章节还是按前置层号由浅入深，`maxLayer` 决定只收进前几层；合订稿目录据此挂「第 M 层」徽标。
4. **手工编辑**：正文是 `contenteditable` 的 Markdown，打字后防抖调 `PUT /knowledge-doc/content`。这一层**只覆盖 `content_md`** —— `content_json` 与 `signature` 保留「模型当初写了什么」的留档，所以「全部重新生成」会用模型结果盖掉手工改动；这是有意为之，生成前会先确认。

### 4.7 读书：多书源 → 书架 → 收获 → 卡片

1. **取数**：`search_books` 并发问各书源（豆瓣 / 微信读书 / 古腾堡 / 维基文库 / Open Library …），每源各自 `_safe_fetch` 兜住异常并**记一笔失败**，最后归一化成同一种记录（`{source, source_id, title, cover, has_fulltext, rights, kind, …}`）；`has_fulltext` 只对公版与用户自备为真。
2. **入库**：加入书架写 `reading_books`（只元数据）；`POST /books` 带 `with_project=True` 或后续取正文 / 沉淀卡片时才 `ensure_project()` → `Database.create_book_project()`（`project_type='book'`），幂等复用。
3. **阅读**：`outline` 按能力分流 —— 本地导入的书走 `split_chapters()` 切出的**真正文**；微信读书的书走**章节目录 + 每章热门划线**（诚实标注不是全文）。选区提问走 `ask`（SSE），上下文由前端给出，服务端用 `knowledge_doc.excerpt_around` 只截选区那一块。
4. **收获**：`digest` 把「划线 + 想法 + 书籍简介」喂给 `make_reading_digest`，逐字段校验（不达标只退回该字段的兜底），渲染成 Markdown 存进 `reading_docs`（`content_md` / `content_json` / `signature` 三者分离，与 `knowledge_docs` 同构）。
5. **沉淀**：收获里的可复用模型 / 行动清单经 `build_sync_cards()` 生成稳定 `rd_` card_id，`sync_cards()` upsert 进 `cards` 并回收已消失的旧卡 —— **重新生成不丢 FSRS 排期**，且只认 `rd_` 前缀，用户手工建的卡碰不到。

### 4.8 跨书知识网络：收获 → 图 → 桥 → 方法论 → 技能卡

1. **灌入**：`nodes_from_digests()` 从各书收获的 `models` **与 `connections`** 抽概念节点（关联对象也必须建节点并把当前书算进书单，否则「被几本书支持」是假的）。
2. **连边**：`edges_from_models()` 把每本书的 `connections` 连成 6 种类型化边（该书每个模型最多 3 个做起点）；`same` 由 `candidate_pairs()` 产出候选，**必带 `needs_confirmation`**。
3. **结构分析**：`analyze()` 一次算全 `nodes / edges / clusters / cluster_keys / hubs / bridges / support / summary`。`clusters()` 不按预设目录切，`find_bridges()` 用割点识别（朴素实现：逐节点试删比连通分量数 —— 在「一个人读过的书」量级完全够用，刻意不上 Tarjan）。
4. **合并**：用户确认后写 `net_merges`，`apply_merges()` 重新归并（**书单要并起来**，指向被合并节点的边改指新节点，自环丢弃，支持链式合并）。
5. **归纳**：`build_methodology_payload()` 只取**一个簇**做子图社区摘要（比喂整张图准确得多），模型产出经 `normalize_methodology_result` 逐字段校验，`build_methodology_fallback` 兜底**不编方法论**；`when_not_to_use` 必须能挡住误用。
6. **沉淀**：`build_skill_cards()` 生成 `kn_` 前缀技能卡（考「该用哪套、什么时候别用」，不是考识记），落 `cards` 表 → 自动进 FSRS。

---

## 5. 数据模型（SQLite，`data/knoworigin.sqlite3`，gitignore）

核心表（与 `core/database.py`、`english_store.py`、`knowledge_doc.py`、`reading_store.py`、`knowledge_net.py` 等建表处一致）。**代码中共 70 张表**（含 `memory_notes` 这类早期版本留下的备份表），按职责归类：

| 表 | 职责 |
| --- | --- |
| `users` / `user_profiles` / `sessions` / `login_events` | 账户、画像、会话 Cookie 与登录事件（账户隔离） |
| `projects` / `sources` / `framework_nodes` / `node_socratic_state` | 项目、导入资料及其切片元数据（含公式 LaTeX 与图表引用）、知识节点树、苏格拉底引导状态 |
| `node_link_notes` / `concepts` / `project_concepts` | 双链理解、概念抽取与项目概念表（图谱与来源视图用） |
| `learning_events` / `progress_suggestions` | 提问 / 做题 / 翻卡 / 测验四类行为（掌握度的唯一来源）与「下一步学什么」的建议队列 |
| `cards` / `quizzes` / `card_srs_state` / `card_review_log` | 可翻面卡片、测验题、FSRS 调度状态与复习流水 |
| `messages` / `chat_sessions` / `kb_conversations` / `kb_digests` | 对话、会话壳（每项目多会话，只存标题与时间）、智能体会话、知识库摘要 |
| `knowledge_docs` / `study_kits` | 知识点文档（单节点详解与合订稿：`content_md` / `content_json` / `signature` 三者分离）与速查表、学习路径、清单报告 |
| `favorites` / `note_proposals` | 我的笔记收藏（含回收站标记）与整理助手给出的笔记、双链建议 |
| `evidence_matrices` / `research_profiles` | PRISMA 综述矩阵与科研画像（只当上下文，与检索证据严格分离） |
| `literature_meta` / `literature_marks` / `literature_comparisons` / `translation_segments` | 文献元数据、高亮标记、多文献对比结果缓存与翻译分段 |
| `undo_history` | 50 步操作快照（撤销 / 回收站） |
| `sprint_plans` / `exam_entries` | 期末冲刺计划与考期（支持微北洋考表导入） |
| `transfer_attempts` / `teaching_prefs` | 迁移式学习的作答记录与教学模式档位偏好 |
| `ai_usage` | AI 用量记账（个人限额） |
| `memory_notes` / `memory_slots` / `memory_slot_history` / `memory_state` | AI 长期记忆：v1 备份、v2 两层固定槽位、槽位变更历史与总开关 |
| `en_words` / `en_decks` / `en_reviews` / `en_srs_state` / `en_prefs` / `en_candidates` / `en_known_words` / `en_contexts` / `en_scan_state` / `en_word_extras` | 英语词汇：词书、词条（唯一索引 `(deck_id, lemma)`）、复习记录、调度状态、偏好，以及采词候选 / 熟词标记 / 语境 / 扫描状态 / 扩展字段 |
| `en_corpus_excerpts` | 语料摘录片段（每片带原句语境与术语表） |
| `en_feed_sources` | 联网阅读泳道的源状态与缓存 |
| `en_passages` / `en_exam_paraphrases` / `en_exam_highlights` / `en_exam_side_cache` / `en_exam_demo_records` / `en_exam_gems` | 考研精读题库、同义替换、高亮批注、侧栏解析缓存、演示历史与精华回填 |
| `reading_books` / `reading_docs` | 读书：书架缓存（元数据 / 封面 / 进度 / 分类 / 书源 / `has_fulltext` / `rights`）与成文产物（收获 / 简介，`content_md` / `content_json` / `signature` 三者分离） |
| `net_nodes` / `net_edges` / `net_merges` / `net_methodologies` / `net_concept_docs` | 跨书知识网络：概念节点（名称 + 书单 + 说明）、6 种类型化边（带来源书）、**用户确认过的合并**（可累积可撤销）、簇级方法论文档（按 `cluster_key` 去重，簇变了自然失效重建）、概念文档 |
| `node_conflicts` / `node_study_plans` / `peer_reviews` / `notices` | 知识冲突检测、单节点补课规划（后台生成）、顶刊审稿红队结果、学习周报通知 |

> **技能卡不另建表**：读书收获用 `rd_` 前缀、跨书方法论用 `kn_` 前缀，都落在既有的 `cards` 表里 —— 于是自动进 FSRS 复习队列、自动被「今天该复习」统计到，回收逻辑只认前缀，用户手工建的卡永远碰不到。

掌握度由 `learning_events` 按 `mastery_evidence_rules` 累积，规则通过 `compute_mastery_breakdown` 下钻。

---

## 6. 关键技术决策

- **单文件后端 + 零前端构建链**：FastAPI 集中在 `api_server.py`（依赖注入 `db/settings/llm_client`，便于测试）；前端为原生 JS 单页应用，无打包、无构建，克隆即用。
- **放弃 Service Worker 缓存**：早期用 `sw.js` 缓存静态外壳以求离线，但它在校园网与 http/https 切换下会顽固地拿旧文件，排查成本远大于收益，已整体退役 —— `service-worker.js` 现在只清扫旧缓存并反注册自己。需要复杂公式时才显式加 `?mathjax=1` 后台加载 MathJax，避免 CDN 不可达时首屏卡在「正在加载」。
- **三套布局 + 两层纯样式增强，各自独立成文件**：`styles.css` 是基础层，`agent-layout.css` 与 `classic-palette.css` 各自锁在 `html[data-ui="…"]` 作用域内、靠加载顺序覆盖。第三套布局因此对前两套是纯增量，回退只需摘掉一行 `<link>`。在此之上还有两层**不含任何逻辑**的增强层：`styles-polish.css` 全部规则用 `:where()` 包裹（优先级恒为 0），只填空、不覆盖，排在最后兜住所有主题与布局分支；`styles-immersive.css` 反过来用强选择器「定调」，重塑深色模式与文档 / 卡片 / 测验 / 图谱 / 概览五个阅读场景，必须排在 polish 之后。两层各自摘掉一行 `<link>` 即完整回退，`app.js` / `styles.css` 一行不改。`agent-shell.js` 读写 `app.js` 的顶层 `state`，必须排在 `app.js` 之后。
- **侧栏是「项目 → 会话」两层树**：会话清单按项目分别缓存（`state.chatSessions` 只装得下当前项目，树里要能同时展开多个项目），展开状态落 localStorage，展开非当前项目时按需补拉它的会话。**项目行右侧的「知识文档」入口刻意不切换当前项目** —— 它给知识文档模块一个项目覆盖位（`VIEW.pid` 参与 `currentProjectId()` 的解析），于是模块内十几处取数、合订、提问自动跟着走，不必给每个端点加参数；而**清除只发生在关闭文档页时**，因为合订等内部重画会再次调用 `openCompiled()`，若在那里顺手清空覆盖位，用户点「按层级合订」就会被悄悄切回当前项目。
- **「点得动」优先于「画得对」**：图谱节点的单击与 Enter / 空格挂在常驻容器的**事件委托**上，而不是渲染完成后再逐个绑定。渲染链上任何一环抛错（dialog / 侧栏 / dock / 护照恢复），图谱照样画得出来、节点依然可点；老做法的症状是「点节点没反应，而屏幕上没有任何报错」，属最难查的一类。拖动与点击另用 `pointerdown` 守卫区分（capture 阶段先记一笔「按下点是否落在图谱里」），所以拖图不会误开浮层。
- **SSE 流式 + 工具循环**：问答、卡片、测验、讨论、智能体全部 SSE 逐字呈现；模型异常自动降级本地启发式，功能不中断。天大网关不提供原生 Function Calling，工具调用靠「模型输出约定 JSON → 本地解析」（`_LiteralToolCallAccumulator` 同时接住 XML 与两种畸形 JSON 形态）。
- **Agent 的读写权限分开授权**：27 个工具里读类直接执行，写类（建节点 / 改笔记 / 建双链 / 删节点）一律先返回 `staged_actions` 交给前端渲染成待确认卡片，逐项勾选后才走 `/agent/actions/execute`。`done` 事件同时带 `answer_segments` / `source_refs`，供「回答依据」面板把每次调用摊开成可审阅的时间线。
- **端口自愈**：默认从 17321 在 17321–17341 探测首个空闲端口，整段被占则交系统分配随机空闲端口，保证服务必起。
- **依赖隔离**：启动脚本在项目内创建 `.venv311`，依赖仅装此处；按 `importlib.find_spec` 逐个校验，缺谁装谁。
- **凭据不进仓库，重启也不用重填**：API Key 主存储是 `data/local_api_config.json`（`data/` 已 gitignore），文件里存 DPAPI 密文（Windows 绑定当前登录账户；其他平台明文），浏览器 localStorage 存一份作为换浏览器 / 无痕窗口的兜底；运行时按「环境变量 / `.env` → 凭据文件 → 浏览器下发」读取，绝不内置到仓库。
- **双链实时反查**：节点维护 `[[链接]]` 列表，反向链接由数据库按名实时反查；图谱连线即一对双链（同名匹配、双向去重）。
- **OCR 本地化**：扫描件/图片型页面用 RapidOCR（`_RapidOCREngine`），不再依赖外部视觉模型；RapidOCR 不可用时自动降级。
- **多书源「能力自述」+ 版权红线写进代码**：11 个书源在注册表里逐源标注 `has_fulltext` / `rights` / `needs_proxy` / `blocked`，上层不猜。`has_fulltext=True` **只对 `public-domain` / `user-provided` 放行**，由归一化函数 `_norm()` 强制 —— 商业书即使碰巧有下载链接也会被降级为「无全文」，取全文接口直接拒绝并说明原因。失败隔离**下沉到每个源**（`_safe_fetch`），任一源超时只算 0 条；但 `_http_json` / `_http_text` 改为**抛 `FetchError`**（原先 `return None` 会让 `_safe_fetch` 什么都捕获不到，把网络故障记成「ok，0 结果」，界面上「源全挂」与「没这本书」分不开）。
- **读书按需建项目（惰性 ensure）**：加入书架、同步书架、拉划线**都不建项目**，只写 `reading_books`；只有真要往里放资料时才 `ReadingStore.ensure_project()` → `create_book_project()`（本地导入 / 取回正文 / 沉淀卡片）。否则微信读书同步一次几百本 = 几百个空项目把侧栏塞满。书一旦有项目，就继承框架 / 卡片 / 测验 / 掌握度 / 撤销 / 导出整条链路。**只读路径全部降级为空而不报错**（`outline` / `cards` / `ask` / `intro` 在无项目时都给空态，不抛 `project_not_found`）。
- **跨书网络只建图、不建树**：原子化 + 概念导向 + 密集链接，**偏好关联式本体而非层级分类**；学科只是节点上的标签，「哪些概念该在一起」由图自己长出来。图里最值钱的是**割点（桥）**——去掉它连通分量会变多，也就是「同时被两本书支持、又是两个领域唯一接口」的概念。**合并必须用户确认**：合并错了 = 假连接，之后所有跨书洞见都建立在假连接上，**比没有网更糟**（`candidate_pairs` 只给候选，必带 `needs_confirmation`）。方法论生成**只喂一个簇**（子图社区摘要比喂整张图准确得多），前端**刻意不上力导向**（每次刷新位置都变会毁掉空间记忆，「桥在两个环之间」才是要一眼看到的）。
- **神经图谱：一套 token 供两处用，回退只删两行**：`--nv-*` 变量上提到 `:root`（浅色覆盖在 `html[data-theme="light"]`），沉浸层与页面内皮肤（学习概览 / 我的笔记）**共用同一套**、深浅自动跟随主题，而不是复制一份样式；皮肤选择器一律带 `html[data-theme]`，否则压不过 app 自己的 `html[data-theme="dark"] .overview-panel`。浅色模式**单独适配**而非反色（浅底上光球不能靠辉光，改描边 + 投影；香槟金压深到 `#a9822a`；Canvas 关掉加色合成）。浮层挂在 `body` 上会触发 `app.js` 的 `collapseStudio()`，所以在本层根节点**冒泡阶段截住指针 / 点击 / 键盘事件**、`Esc` 另在 window 捕获阶段 `stopImmediatePropagation()`。入口按钮由脚本注入 `.graph-toolbar`（`MutationObserver` 跟随重渲染），新脚本排在 `app.js` 之后直接读它的顶层 `state` —— **`app.js` 一行不改，删掉 `index.html` 两行即完全回退**。

---

## 7. 安全与隐私

- 资料、笔记、学习记录仅存本机 SQLite 与文件系统，无强制云端同步。
- 仅当用户主动发起模型调用时，相关文本片段才按需发送给模型服务（默认天大 AI 平台 `ai.tju.edu.cn`），除此之外无数据外发。
- 管理面板与会话签名使用本地密钥（`KNOWORIGIN_SESSION_SECRET` / `KNOWORIGIN_ADMIN_PASSWORD`），默认留空并提示用户设置，绝不内置到仓库。
- 校园检索抓取仅取正文摘要，不外发用户资料；图书馆数据库跳转仅为外链。

---

## 8. 部署与运行

### 方式 A：双击启动（Windows，推荐）
克隆后双击 `打开知源.cmd`：Python 3.11+ 检测 → 项目内虚拟环境 → 依赖安装 → `.env` 生成 → 清理残留进程 → 端口探测 → 启动 → 打开浏览器。Ctrl+C 停止。

### 方式 B：命令行（跨平台）
```bash
python src/start.py
```
看到 `Uvicorn running on http://0.0.0.0:17321` 即成功；同 Wi-Fi 设备访问 `logs/knoworigin-mobile-url.txt` 中的局域网地址。

### 方式 C：手动
```bash
python -m pip install -r requirements.txt
cp .env.example .env          # 填入 KNOWORIGIN_API_KEY（ai.tju.edu.cn 智能体广场获取）
python -m uvicorn api_server:app --app-dir src --host 0.0.0.0 --port 17321
```
> 注：`api_server` 模块位于 `src/` 下，启动命令需带 `--app-dir src`。

---

## 9. 命名约定

- 包/模块/环境变量/文件：`knoworigin_*`；类名 `KnowOriginXxx`；大写环境变量 `KNOWORIGIN_*`。
- 用户可见文案统一「知源」，英文副标「KnowOrigin」；数据库表名保持通用语义，避免二次迁移。
- 历史兼容：早期版本曾用「题源/TiYuan」「北洋问学/Beiyang」，现统一为「知源/KnowOrigin」，相关标识符已迁移，老用户升级后无需重配。

---

## 10. 路线图

- 持续提升命题质量与跨学科适配（理工/经管/医学 few-shot 调优，`core/prompt_catalog.py`）。
- 优化公式渲染与图表解释准确率（`repair-formulas` / `pages.py`）。
- 增强文献阅读：引用网络可视化、笔记导出为 Obsidian vault（已有 `vault/export` 雏形）。
- 深化校园检索与天大官方入口接入（`core/campus_sources.py` / `tju_courses.py`）。
- 本地优先前提下，探索可选的端到端加密云备份（用户自愿开启）。

---

**用 AI，把一样东西真正学透。**
