# NOTICE — 知源 KnowOrigin 的授权与第三方声明

Required Notice: Copyright (c) 2026 KnowOrigin 项目组

本文件说明知源自身的授权政策，以及随仓库分发的第三方组件与内容的许可。
完整许可条款以仓库根 `LICENSE` 为准。

---

## 1. 知源自身的授权政策

- **当前授权：PolyForm Noncommercial License 1.0.0**（见 `LICENSE`）。
  允许学习、个人非商业使用，以及该协议列明的其他非商业用途
  （含**教育机构**、公益组织、公共研究机构、政府机构等）。
  **本许可不授予商业使用权限**；商业使用需另行取得授权。
- 这是 **source-available（源码公开）** 授权，不是允许任意商业使用的开源许可。
- 知源是**本地优先的学习工具**：资料、笔记与学习记录默认只存本机
  （详见 `README.md` 与 `DESIGN.md`）。

### 历史许可（不撤回既有权利）

- **2026-10-08 之前**发布的知源版本以 **MIT License** 提供。
  本次变更为 **MIT → PolyForm Noncommercial 1.0.0**。
- 本次变更**不撤回、不限制**此前按 MIT 已授出的权利
  —— 已按 MIT 获得知源旧版内容的人，其权利不受影响。
- 变更后的版本中，未变更的部分仍可能同时可按 MIT 取得（同上游做法）。

---

## 2. 第三方组件与数据

逐项来源与许可见 `README.md` 的「第三方组件与开源许可」一节。要点：

| 组件 / 数据 | 许可 | 备注 |
| --- | --- | --- |
| `superpung/TJU-CourseSharing`（生成 `core/tju_courses.py`） | **CC BY-NC-SA 4.0** | 只收课程**元数据**（编号 / 名称 / 学科） |
| `py-fsrs`（实现见 `core/english_vocab.py`） | MIT | 间隔重复调度 |
| `ECDICT`（生成 `data/english/*.json`） | MIT | 英语词库数据 |
| `KaTeX`（`static/vendor/`） | MIT | 公式离线渲染 |
| `PyMuPDF` | AGPL-3.0 / Artifex 商业双许可 | 可用 `.env` 关闭 MinerU 仅走 pdfplumber 通道 |
| 其余（FastAPI / RapidOCR / pdfplumber / trafilatura 等） | MIT / BSD / Apache-2.0 | 见 README 表格 |

### 2.1 来源：`neural-creator-dashboard`（设计借鉴 + 随仓库分发两个素材文件）

- 上游：https://github.com/luoluo-121/neural-creator-dashboard
- 上游许可：**PolyForm Noncommercial 1.0.0**。
- **Required Notice: Copyright (c) 2026 luoluo-121 and neural-creator-dashboard contributors**
- 设计关系：知源**借鉴其设计思想**（三层递进交互 / 银灰 + 香槟金配色 / 背景神经网络），
  并以自身技术栈（原生 JS，零构建）重新实现。

**随仓库分发的文件**（仅此两个素材，无任何上游代码）：

| 路径 | 体积 | 用途 |
| --- | --- | --- |
| `static/vendor/neural-creator-dashboard/media/orb.mp4` | 8,334,089 B | 神经图谱中心光球（径向遮罩后使用） |
| `static/vendor/neural-creator-dashboard/media/jellyfish.mp4` | 724,052 B | 神经图谱各模块的发光水母（`screen` 混合 + 椭圆遮罩） |
| `…/media/orb.jpg`、`…/media/jellyfish.jpg` | 35,428 / 25,289 B | 两者的 `poster` 封面帧 |

同目录还随附了上游的 `LICENSE`、`NOTICE.md` 与 `licenses/MIT-legacy.txt` 原文，
以履行其许可的 *Notices* 条款（**Required Notice 必须随分发保留**）。

**使用范围与限制**：

- 两个素材在知源的神经图谱里**深浅两套都启用**，只是合成方式不同：
  深色层 `jellyfish.mp4` 走 `mix-blend-mode: screen` 去黑底、`orb.mp4` 走径向遮罩；
  浅色层 `jellyfish.mp4` 换成 `invert(1) hue-rotate(180deg)` + `multiply`
  （黑底反相成白底，multiply 对白底是恒等 = 等于透明），`orb.mp4` 沿用遮罩版。
  **文件内容未被修改**，全部处理都在渲染层（CSS 遮罩 / 混合模式 / 滤镜）。
- 素材**缺失或解码失败时自动回落**为知源自绘的 CSS 光球与水母，功能不受影响。
- **不得给这两个文件挂 MIT，也不得宣称其可商用**；知源整体按 PolyForm Noncommercial 1.0.0
  分发，商业使用需另行取得授权。
- 上游在其 `NOTICE.md` 中写明：「项目只授出许可方实际持有的权利……**不保证 AI 生成素材
  存在排他版权**」。这两个素材系**即梦（Dreamina）AI 生成**，其权利基础在上游一侧即不明确；
  知源据此仅作非商业、非排他的引用，并在此如实标注来源与上述保留。
- 上游 README 视这两个文件为其识别标志（其 `npm run verify` 会检查是否被替换）；
  知源未修改文件内容，仅在渲染层加遮罩与混合模式。

**未取用**：上游的 React 源码、`neural.css`、示例数据与其余素材。
知源的光球光晕、伞盖、触须、神经丝、脉冲全部由 CSS 渐变 + Canvas 自绘，
仅在上述两个视频文件上做了遮罩/混合的渲染层处理。

> 素材缺失时的行为：视频加载失败（或仓库副本被剥离）会自动回落 CSS 自绘版本，
> 神经图谱照常可用，不报错、不白屏。

### 2.2 设计借鉴来源：`neural-vault`（未随仓库分发）

- 上游：https://github.com/useroneoneone/neural-vault
- 上游许可：**PolyForm Noncommercial 1.0.0**（SPDX：`PolyForm-Noncommercial-1.0.0`）。
- 上游要求二次开发分发时保留：`LICENSE`（或官方许可链接）及 `NOTICE` 中两条
  `Required Notice:`，注明原作者 `useroneoneone` 与原始仓库地址。
- 关系：知源**只借鉴其「目录图例 + 分组浏览」这一层设计**（把顶层分组列成可浏览的清单、
  点一行聚焦到该目录），并以自身技术栈（原生 JS，零构建）重新实现 ——
  见 `static/kb-neural-view.js` 的 `renderDirs()` / `toggleFocus()` 与
  `static/styles-neural.css` 的 `.ko-nv-dirs` 一节。
- **本仓库不包含、也不分发上游的任何代码、样式或素材文件**
  —— 因此不触发其许可的 *Notices*（随分发保留许可原文）义务；
  此处列出仅作来源与致谢说明。
- 未取用其 `main.js` / `styles.css` 构建产物、React / Vite / Tailwind 依赖，
  也未使用其水母星图的素材；知源的「水母」由 CSS 径向渐变自绘。

### 2.3 算法移植来源：`PaperFocus`（MIT）

- 上游：https://github.com/YiLight0/paperfocus
- 上游许可：**MIT License**（SPDX：`MIT`）。
- 关系：知源**移植了它「相对显著度」的折算公式**（先按名次衰减、再按分差铺开、
  最后抬升低值三段），用于文献精读的「相关原文」相对置信度 ——
  见 `src/core/lit_evidence.py` 的 `salience_map()`，逐项与上游 `app.js` 的
  `evidenceEntries()` 一致。选段与分批的思路（把候选段落交给模型逐段打 0~3 分，
  再由本地代码做排序、阈值与渲染）同样受其启发。
- 知源**自行实现**的部分：候选段落来自知源既有的页面文字层
  （`core/pages.py` 的 `text_layer`，行级 bbox），因此段落地图能直接复用原页视图的
  坐标定位；上游的两阶段（先筛段落、再定位句子）在知源简化为单阶段段落打分；
  模型调用走知源自己的 `core/llm.py`，**不依赖 TypeSafe / Jev**。
- **本仓库不包含、也不分发上游的任何文件**（`server.py` / `document.py` / `app.js` /
  `style.css` 等均未入库），此处列出仅作来源与致谢说明。

---

## 3. 合规说明

- 仓库根 `版权合规承诺书.pdf` 为大赛附件（手签扫描件），承诺
  「全部内容版权合规，原创素材无抄袭；引用第三方资源均已获得合法授权，标注来源」。
  本文件与 README 的第三方表格即为「标注来源」的落实。
- 文献正文不内置：截图中的论文页面均为用户本地阅读界面的演示。
- 课程数据只收元数据，不含任何课件、试卷内容。
