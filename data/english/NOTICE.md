# 内置英语数据来源与许可

本目录下的 `words.json` / `decks.json` / `lemma.json` / `wordroot.json` / `basic.json`
由 `tools/build_english_dict.py` 从 **ECDICT** 抽取生成，生成日期 2026-09-13。

## ECDICT

- 项目：https://github.com/skywind3000/ECDICT
- 作者：Lin Wei (skywind3000)
- 许可：**MIT License**
- 版权：Copyright (c) 2025 Linwei

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.

知源对原始数据做了以下**衍生处理**：按考试标签与词频筛选子集、截断过长的释义、
规整 `pos` 字段格式、从 `lemma.en.txt` 提取词形映射。原始数据的准确性由 ECDICT 负责。

## 同类项目说明

`words.json` 的词条字段结构参考了 [qwerty-learner](https://github.com/RealKai42/qwerty-learner)
（**GPL-3.0**）的 schema 设计思路。**仅借鉴字段结构，未复制其任何代码或词库数据文件**
—— GPL-3.0 具有传染性，知源刻意与其保持隔离。

间隔重复调度使用 [FSRS](https://github.com/open-spaced-repetition/py-fsrs)，MIT License，
Copyright (c) 2022 Open Spaced Repetition；实现见 `core/english_vocab.py` 顶部注释。
