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

### 2.1 设计借鉴来源：`neural-creator-dashboard`（未随仓库分发）

- 上游：https://github.com/luoluo-121/neural-creator-dashboard
- 上游许可：**PolyForm Noncommercial 1.0.0**。
- **Required Notice: Copyright (c) 2026 luoluo-121 and neural-creator-dashboard contributors**
- 关系：知源**只借鉴其设计思想**（三层递进交互 / 银灰 + 香槟金配色 / 背景神经网络），
  并以自身技术栈（原生 JS，零构建）重新实现。
- **本仓库不包含、也不分发上游的任何代码、样式或素材文件**
  —— 因此不触发其许可的 *Notices*（随分发保留许可原文）义务；
  此处列出仅作来源与致谢说明。
- **未取用其视频素材**（`orb.mp4` / `jellyfish.mp4` 为其识别标志），
  知源的光球与神经丝全部由 CSS 渐变 + Canvas 自绘。

---

## 3. 合规说明

- 仓库根 `版权合规承诺书.pdf` 为大赛附件（手签扫描件），承诺
  「全部内容版权合规，原创素材无抄袭；引用第三方资源均已获得合法授权，标注来源」。
  本文件与 README 的第三方表格即为「标注来源」的落实。
- 文献正文不内置：截图中的论文页面均为用户本地阅读界面的演示。
- 课程数据只收元数据，不含任何课件、试卷内容。
