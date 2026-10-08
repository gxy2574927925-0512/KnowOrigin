# 第三方参考：neural-creator-dashboard

本目录是**上游项目的只读参考快照**，用于把它的 UI 设计与实现思路**移植**到知源。
它不是知源的运行时依赖，**不参与知源的构建与运行**（知源是原生 JS + 零构建）。

| 项 | 值 |
| --- | --- |
| 上游仓库 | https://github.com/luoluo-121/neural-creator-dashboard |
| 上游定位 | 把作品 / 笔记 / 选题 / 草稿可视化成「活体神经网络」的纯前端看板 |
| 上游技术栈 | React + Vite + npm（纯前端，数据存 localStorage） |
| 上游许可 | **PolyForm Noncommercial 1.0.0**（见本目录 `LICENSE`、`NOTICE.md`） |
| 快照日期 | 2026-10-08（`main` 分支） |
| 快照方式 | 逐个文件按原文取回；**上游仓库为准**（如发现差异，以上游为权威） |

> **Required Notice: Copyright (c) 2026 luoluo-121 and neural-creator-dashboard contributors**
>
> 本目录依 PolyForm Noncommercial 1.0.0 的 *Notices* 条款保留上游 `LICENSE`、`NOTICE.md`
> 与 `licenses/MIT-legacy.txt` 原文件，未作删改。

---

## 已收录的文件

| 文件 | 上游大小 | 作用 |
| --- | --- | --- |
| `src/neural/theme.js` | 1515 B | **配色与素材路径**（银灰 / 香槟金 / 各模块色）——最直接可移植 |
| `src/neural/neural.css` | 48402 B | **整套视觉系统**（毛玻璃、辉光、光球遮罩、伞状展开、分析栏、响应式、`prefers-reduced-motion`）。CSS 与框架无关，可直接借鉴 |
| `src/neural/Home.jsx` | 29579 B | **三层递进交互**：hub → 点模块（水母）→ 触须伞状展开到每条内容 → 右侧滑出分析栏；含 `Esc` 与面包屑回退 |
| `src/neural/NetworkCanvas.jsx` | 8301 B | **背景神经网络**：按链接层数蔓延、粒子迸发、双向连接的**金色往返脉冲** |
| `src/neural/icons.jsx` | 1984 B | 线性图标集（24×24 stroke，可转成 SVG path 直接用） |
| `src/neural/works.js` | 394 B | 作品库数据入口 |
| `src/config.js` | 840 B | 品牌 / 头像 / 存储前缀配置 |

## 未收录（有意）

| 未收录 | 原因 |
| --- | --- |
| `public/media/orb.mp4`（**8.3 MB**）、`jellyfish.mp4`、两个 `.jpg` | 体积大；且是**上游的识别标志**（即梦 AI 生成），知源**不取用**，观感由知源自己用 SVG / Canvas 复刻 |
| `src/neural/Analysis.jsx`、`graph.js`、`main.jsx`、`pages.jsx` | 分析栏 / 数据模型 / 应用外壳 / 内页。属于可另取的上游文件，非本快照必需 |
| `src/data/sample.js`、`examples/vault/`、`scripts/`、`skills/` | 虚构示例数据、导入脚本、Agent Skill，与 UI 移植无关 |
| `package.json` / `package-lock.json` / `vite.config.js` | 上游构建链；知源不引入 React / Vite |

## 取回完整上游

```bash
# 需要可直连 GitHub 的网络环境
git clone --depth 1 https://github.com/luoluo-121/neural-creator-dashboard.git
```

## 使用边界（务必遵守）

1. **只移植设计，不复用素材**：两个视频不取用；观感由知源自绘。
2. **知源整体已是非商业许可**（PolyForm NC 1.0.0，见仓库根 `LICENSE`）——
   本目录的内容可与知源共存，但**不得**给本目录内容挂 MIT 或宣称可商用。
3. **保留本目录的许可与署名文件**，不得删除。
4. 移植产出的知源代码是知源自己的实现（重写而非拷贝），不因此变成上游代码。
