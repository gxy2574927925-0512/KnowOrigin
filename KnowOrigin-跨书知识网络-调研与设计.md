# 知源 · 跨书知识网络 —— 把读过的书接成一张网，长出方法论与技能

> 需求：**系统读书的思维** —— 用 AI 把读过的书里「类似或相邻」的知识点串接起来，
> 形成一张思维网，最终**沉淀为方法论与技能**。
> 本文档 = 理论调研 + 可借鉴实现 + 落到知源的设计。调研时间：2026-10-07

---

## 0. 一句话结论

跨书串联**不是「把几本书的摘要堆在一起」**，而是一条三层递进的链：

```
概念归并（同一件事的不同叫法）→ 图（类型化的边）→ 簇级方法论归纳 → 技能
```

知源已经有地基：`core/concept_graph.py` 解决了「同一个概念出现在多个项目里」的
**身份问题**（跨项目概念键 + 概念表 + LLM 对齐）。缺的是从「书的收获文档」灌进来、
连边、**找桥**、归纳方法论、沉淀技能这一段 —— 已实现于 `core/knowledge_net.py`。

---

## 1. 调研：六条结论，每条都直接决定一个实现

| 来源 | 核心结论 | 落到实现 |
| --- | --- | --- |
| **Andy Matuschak**《Evergreen notes》 | 笔记应**原子化、概念导向、密集链接**；**偏好关联式本体而非层级分类**；用自己的话写 | **只建图、不建树**；概念是节点，学科只是节点上的标签；用户批注优先于 AI 摘要 |
| **Luhmann**（Zettelkasten，40 年 70 本书） | **没有唯一的主本体**，每条笔记的位置由局部语境决定；**跨域交叉引用才产生新洞见**（"connections make new insights possible"）；他专门维护 **hub notes** 当高速公路 | 允许多套局部语义并存（**每本书就是一套视角**）；`find_hubs` 把枢纽概念捞出来当导航 |
| **Munger**《A Latticework of Mental Models》 | 两步：① 抽取各学科的**大思想** ② **学会识别相似性模式**；**隐喻**是「把想法翻译成模型」的机制；**同一结论被多个学科独立指向时，决策更可能正确** | `analogy` 边类型；`cross_support` 统计「被几本书支持」；**孤证显式标注** |
| **Agentic deep graph reasoning**（J. Mater. Res. 2025） | 递归图扩展会形成 scale-free 网络：**hub 爆发式出现**、模块化稳定、**bridging nodes 连接原本分离的知识簇**；「巩固—发现」交替 | `find_bridges`（割点识别）；用户确认合并 = 巩固，新桥浮现 = 发现 |
| **NLP-AKG**（arXiv 2502.14192） | **sub-graph community summary**：把「子图社区」的摘要喂给模型，比喂整张图准确得多 | 方法论生成**只喂一个簇**，不喂整张网 |
| **CLARE**（MDPI 2025） | 让领域专家用 15 分钟**人工精修**图，事实准确率平均 **+22.7%** | 概念合并**必须用户确认**，绝不自动落库 |

> 一句话串起来：**Matuschak 给了形态（原子 + 概念 + 密集链接），Luhmann 给了结构（无主本体 + 枢纽），
> Munger 给了目标（格栅 + 交叉验证），三篇 2025 年的论文给了算法（桥、社区摘要、人工精修）。**

---

## 2. 五步流水线

```
① 灌入        各书的《读书收获》里已有 models（可复用框架）与 connections（关联对象）
              ↓ 复用 concept_graph 的 concept_key 落成概念节点
② 连边        6 种类型化关系：same / prereq / extends / contrast / analogy / applies_to
              ↓ 术语相似度只产出**候选**，用户确认后才合并
③ 找结构      hub（枢纽概念，Luhmann 的 hub notes）
              bridge（桥接节点，割点）—— **整张网里最值钱的东西**
④ 归纳        对一个**概念簇**做子图社区摘要 → 一份《方法论》
⑤ 沉淀        方法论 → 技能卡（考「该用哪套、什么时候别用」，不是考识记）
```

### 2.1 六种边，各有各的用途

| 类型 | 含义 | 谁来定 |
| --- | --- | --- |
| `same` | 同一件事，两本书叫法不同 | 术语相似度候选 + 用户确认 |
| `prereq` | 先懂 A 才可能懂 B | 模型（带出处） |
| `extends` | A 是 B 的特例 / 深化 | 模型 |
| `contrast` | **两本书说法冲突** | 模型；必须显式呈现，不要和稀泥 |
| `analogy` | 跨域隐喻 —— Munger 说的「翻译成模型」 | 模型 |
| `applies_to` | 概念 → 它适用的场景 | 模型 |

⚠️ `prereq` / `extends` / `applies_to` **有方向**，`same` / `contrast` / `analogy` 对称。
方向搞错会让「前置」反过来显示 —— 这在代码里由 `DIRECTED_EDGE_TYPES` 强制。

### 2.2 为什么「桥」最值钱

Munger 说「当来自不同学科的想法指向同一个结论时，投资决策更可能正确」；
2025 年的图推理论文说「bridging nodes 连接原本分离的知识簇」。

**这两句说的是同一件事**，落到实现就是割点识别：去掉它之后图的连通分量会变多。

举例（示意）：

```
   地方竞争 ── 周期对齐 ──┐
                          ├── 激励错配 ★ ← 桥：一边是「制度/组织」簇，
   复利效应 ── 长期主义 ──┘              一边是「个人/决策」簇
```

`激励错配` 就是桥：它同时被《置身事内》（讲地方政府）和《穷查理宝典》（讲个人决策）
支持，是两个原本无关的领域的**唯一接口**。用户最该花时间的就是这种节点。

### 2.3 孤证要显式标出来

`cross_support` 统计一个概念被几本书提到：

- **≥2 本** = 交叉验证（Munger 的「多学科独立指向」）→ 高置信；
- **=1 本** = 孤证 → 界面上标出来，别当共识用。

> 知源的「来源视图」早就有同样的设计（孤证概念提示需补来源），这里保持一致。

---

## 3. 数据模型

| 表 | 来源 | 说明 |
| --- | --- | --- |
| `concepts` / `project_concepts` | **已有**（`concept_graph.py`） | 概念身份与归属，不重建 |
| `net_edges`（待建） | 新增 | 跨书边：`(owner_id, source_key, target_key, kind, note, books, confirmed)` |
| `net_methodologies`（待建） | 新增 | 方法论文档：`cluster_key` / `content_json` / `content_md` / `signature` |
| `cards` | **已有** | 技能卡落这里，前缀 `kn_`（与 `rd_` / `kd_` 并列，互不干扰） |

**技能卡复用 `cards` 表**：`kn_` 前缀 + `origin_section="方法论"`，
所以它自动进 FSRS 复习队列、自动被「今天该复习」统计到 —— 一行都不用重写。
回收逻辑只认前缀，用户手工建的卡永远碰不到。

---

## 4. 与既有模块的分工（四层，各管一段）

| 模块 | 粒度 | 回答的问题 |
| --- | --- | --- |
| `core/reading_digest.py` | **一本书** | 这本书我能拿走什么？ |
| `core/concept_graph.py` | **一个概念** | 「傅里叶变换」在不同项目里是不是同一个东西？ |
| `core/knowledge_net.py`（新） | **跨书一张网** | 这些书之间有什么结构？哪些是桥？能归纳出什么做法？ |
| `core/transfer.py` | **一次迁移** | 换个情境还用不用得上？（训练 + 回归验证） |

`knowledge_net` 的产出（方法论 + 技能卡）**天然是 `transfer` 的题目来源**：
技能卡考的就是「换一个场景该用哪套做法」，正是迁移训练要的东西。

---

## 5. 已实现（本轮）

`src/core/knowledge_net.py` —— 纯函数引擎，无 DB、无网络、无模型依赖：

| 能力 | 函数 |
| --- | --- |
| 术语相似度（只两档，**刻意不做同尾词**） | `similarity` |
| 合并候选（**只给候选，必带 `needs_confirmation`**） | `candidate_pairs` |
| 建边 / 从收获文档抽边 | `make_edge` / `edges_from_digests` |
| 建图（对称边双向、有向边单向） | `build_graph` |
| 连通分量（不按预设目录切） | `clusters` |
| 枢纽（Luhmann hub notes） | `find_hubs` |
| **桥接节点（割点）** | `find_bridges` |
| 跨书支持度 / 孤证标注 | `cross_support` |
| 簇级方法论 payload（子图社区摘要） | `build_methodology_payload` |
| 逐字段校验 + 本地兜底（**兜底不编方法论**） | `normalize_methodology_result` / `build_methodology_fallback` |
| 渲染 Markdown | `render_methodology_markdown` |
| 技能卡（稳定 `kn_` id、情境题） | `build_skill_cards` |

**验证**：`tools/verify_knowledge_net.py` —— **106 条断言全绿**。

### 5.1 「桥」的端到端实现（本轮补全）

从「算得出」到「看得见、用得上」，补了三层：

**① 数据层（`NetStore`，`core/knowledge_net.py`）**

| 表 | 作用 |
| --- | --- |
| `net_nodes` | 概念节点（名称 + 书单 + 说明） |
| `net_edges` | 跨书边（类型化，带来源书） |
| `net_merges` | **用户确认过的合并**（`from → to`，可累积可撤销） |
| `net_methodologies` | 方法论文档（按 `cluster_key` 去重，簇变了自然失效重建） |

- `nodes_from_digests()`：从各书收获的 `models` **与 `connections`** 抽节点。
  ⚠️ 关联对象也必须建节点并把当前书算进书单 —— 只收 models 会造成隐蔽失真：
  A 书把「激励错配」当关联对象提到、B 书当模型写，书单里就只剩 B，
  于是 `cross_support` 判它孤证、桥的名字也丢成 `cpt_xxx`。
- `edges_from_models()`：把每本书的 `connections` 连成边（该书每个模型最多 3 个做起点）。
- `apply_merges()`：按用户确认的合并重新归并 —— **书单要并起来**（否则「被几本书支持」是假的），
  指向被合并节点的边改指新节点，产生的自环丢弃，链式合并（A→B、B→C）要能一路走到 C。
- `analyze()`：一次算全 `nodes / edges / clusters / cluster_keys / hubs / bridges / support / summary`。

**② 路由（`/api/reading/net*`）**

| 端点 | 作用 |
| --- | --- |
| `GET /api/reading/net` | 整张网 + 结构分析 + 已生成的方法论 |
| `GET /api/reading/net/candidates` | 合并候选（**只给候选**，必带 `needs_confirmation`） |
| `POST /api/reading/net/merge` · `DELETE .../merge/{key}` | 确认合并 / 撤销 |
| `POST /api/reading/net/methodology` | 就着某概念所在的**簇**生成方法论，并沉淀技能卡 |

**③ 前端（`reading.js` 的「知识网络」页签）**

- 顶部统计：概念 / 连线 / 簇 / **桥** / 跨书概念 / 本书数；
- **SVG 图**：每个簇画成一个圆环、簇与簇横向排开，**桥用琥珀色大点**标出。
  刻意不上力导向 —— 力导向每次刷新位置都不同，用户会失去空间记忆；
  而「桥在两个环之间」这个视觉关系，正是要让人一眼看到的；
- **「桥」单独一节**：每个桥一张卡，写明「去掉它网络会多出 N 个断开的簇」+ 来自哪几本书，
  一键「就这一簇生成方法论」；
- 枢纽 / 跨书支持（孤证不标 primary）/ 已生成方法论 / 合并候选（确认才合）。

---

## 6. 踩过的坑（都是测试抓出来的）

1. **`find_bridges` 的前置条件写反了**。第一版写 `if base <= 1: return []`
   （「连通分量只有 1 个就直接返回空」）—— 恰好把**唯一存在桥的情形**（图是连通的）
   排除掉，函数永远返回空。判空只需「有没有边」。
2. **同尾词档是死代码，而且是噪音源**。第一版给了「词尾相同 → 0.40」一档，
   但它低于候选门槛 0.45，永远走不到；更糟的是「沉没成本 / 机会成本」
   「固定成本 / 边际成本」两两同尾却是不同概念 —— 加这一档的结果是书一多候选列表就被淹没。
   **已整档删除**。
3. **`adjacency` 存的是边、不是邻居键**。写测试时踩了一次；用 `_neighbors()` 取邻居。

---

## 7. 风险与边界

1. **合并错了 = 假连接**。之后所有「跨书洞见」都建立在假连接上，**比没有网更糟**。
   所以合并必须用户确认（CLARE 的 +22.7% 就是这么来的）。
2. **图规模**：割点用朴素实现（每个节点试删一次比连通分量数）。
   在「一个人读过的书」量级（几十到几百节点）完全够用，不值得上 Tarjan —— 这是刻意的取舍。
3. **方法论幻觉**：靠事实铁律（只依据给定概念与边）+ 兜底不编 + `when_not_to_use` 必须能挡住误用。
4. **不建强制分类**：Matuschak 明确反对层级分类压过关联。
   学科标签只是节点属性，**「哪些概念该在一起」由图自己长出来**。

---

## 8. 参考资料

- Andy Matuschak, *Evergreen notes* — https://notes.andymatuschak.org/
- Dinis Cruz, *Bridging Luhmann's Ideas with Semantic Knowledge Graphs and G³* (2025)
- *A Latticework of Mental Models*（Munger，哥伦比亚大学出版社 PDF）
- *Agentic deep graph reasoning yields self-organizing knowledge networks*, J. Mater. Res. (2025)
- *NLP-AKG: Few-Shot Construction of NLP Academic Knowledge Graph Based on LLM*, arXiv 2502.14192
- *CLARE: Context-Aware, Interactive Knowledge Graph Construction from Transcripts*, MDPI Information (2025)
