"""从 ECDICT 抽取知源英语词汇功能的内置数据（开发期跑一次，产物入库）。

用法：
    .venv311/Scripts/python.exe src/tools/build_english_dict.py \
        --src .workbuddy/scratch/ecdict --out data/english

输入（均来自 https://github.com/skywind3000/ECDICT ，MIT License, (c) 2025 Linwei）：
    ecdict.csv       主词典（13 列：word, phonetic, definition, translation, pos,
                     collins, oxford, tag, bnc, frq, exchange, detail, audio）
    lemma.en.txt     词形还原（BNC 1 亿词语料扫描生成），格式 `lemma/count -> v1,v2`
    wordroot.txt     词根表 JSON，611 条

输出（data/english/）：
    words.json       词条数据。**只收录"可能被用到"的词**：有考试标签的 ∪ 有词频
                     排名的 ∪ 基础词。frq=0 且无标签的多是化学名/专名，不收。
    decks.json       6 套内置词表（四六级/考研/雅思/托福/GRE）的元数据与词序
    lemma.json       变体 → 原形
    wordroot.json    词根表（裁掉不用的字段）
    NOTICE.md        ECDICT 的 MIT 署名（使用条件，必须随数据一起分发）

**为什么产物要入库**：用户侧必须完全离线（知源是本地优先产品），不可能让每个
用户装完再下 66MB。本脚本是这些数据可复现的唯一凭证。
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

# 词条字段顺序 —— 写进产物里，读取方按名字取，不靠位置硬编码
WORD_FIELDS = ["phonetic", "translation", "pos", "tag", "collins", "oxford", "frq"]

# 单个英文词（允许内部连字符/撇号）。带空格的是词组，不进词表。
WORD_RE = re.compile(r"^[a-z][a-z'\-]*$")

TAG_ORDER = ["cet4", "cet6", "ky", "ielts", "toefl", "gre"]

DECKS = [
    ("cet4", "四级核心", "大学英语四级大纲词汇", "cet4"),
    ("cet6", "六级核心", "大学英语六级大纲词汇", "cet6"),
    ("kaoyan", "考研核心", "考研英语大纲词汇", "ky"),
    ("ielts", "雅思核心", "IELTS 高频词汇", "ielts"),
    ("toefl", "托福核心", "TOEFL 高频词汇", "toefl"),
    ("gre", "GRE 核心", "GRE 高频词汇", "gre"),
]

# 基础词判据（与 core/english_vocab.py 的 is_candidate 保持一致，改一处要改两处）
BASE_FRQ_CEILING = 3000
BASE_COLLINS_FLOOR = 3

MAX_TRANSLATION = 150
MAX_POS = 24


def log(msg: str) -> None:
    print(msg, flush=True)


def normalize_text(raw: str) -> str:
    """ECDICT 里换行是**字面量** `\\n`（两个字符），要还原后重新排版。"""
    if not raw:
        return ""
    text = raw.replace("\\n", "\n")
    parts = [p.strip() for p in text.split("\n") if p.strip()]
    return " / ".join(parts)


def trim(text: str, limit: int) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def clean_pos(raw: str) -> str:
    """ECDICT 的 pos 形如 `n:46/v:54`，只留词性字母。"""
    if not raw:
        return ""
    letters: list[str] = []
    for chunk in str(raw).replace("/", " ").split():
        head = chunk.split(":")[0].strip()
        if head and head not in letters:
            letters.append(head)
    return trim(" / ".join(letters), MAX_POS)


def to_int(raw: str) -> int:
    try:
        return int(str(raw or "0").strip() or 0)
    except ValueError:
        return 0


def build(src: Path, out: Path) -> dict:
    csv_path = src / "ecdict.csv"
    if not csv_path.exists():
        raise SystemExit(f"找不到 {csv_path}，请先下载 ECDICT 数据")

    words: dict[str, list] = {}
    basic_words: list[str] = []
    rows = 0
    single = 0

    with csv_path.open(encoding="utf-8", newline="") as handle:
        reader = csv.reader(handle)
        header = next(reader)
        col = {name: i for i, name in enumerate(header)}
        required = {"word", "phonetic", "translation", "tag", "frq"}
        missing = required - set(col)
        if missing:
            raise SystemExit(f"ecdict.csv 缺少字段：{sorted(missing)}")

        for row in reader:
            rows += 1
            if len(row) < len(header):
                continue
            word = row[col["word"]].strip().lower()
            if not WORD_RE.match(word):
                continue
            single += 1

            frq = to_int(row[col["frq"]])
            collins = to_int(row[col["collins"]])
            oxford = 1 if row[col["oxford"]].strip() == "1" else 0
            tags = [t for t in row[col["tag"]].split() if t in TAG_ORDER]

            # 基础词集合：判据与运行时的 is_candidate 一致
            if (
                oxford == 1
                or collins >= BASE_COLLINS_FLOOR
                or 0 < frq < BASE_FRQ_CEILING
            ):
                basic_words.append(word)

            # 词条只收「有考试标签 ∪ 有词频排名」的词，其余（化学名/专名）不收
            if not tags and frq <= 0:
                continue

            translation = normalize_text(row[col["translation"]])
            if not translation:
                continue

            words[word] = [
                trim(row[col["phonetic"]], 48),
                trim(translation, MAX_TRANSLATION),
                clean_pos(row[col["pos"]]),
                " ".join(sorted(tags, key=TAG_ORDER.index)),
                collins,
                oxford,
                frq,
            ]

    log(f"读入 {rows:,} 行，单英文词 {single:,}")
    log(f"收录词条 {len(words):,}，基础词 {len(set(basic_words)):,}")

    # —— 词表：按 tag 取词，**剔除基础词**，词频升序（高频先学）——

    # 为什么必须剔除基础词：ECDICT 的 cet4/cet6 标签是"大纲收录"而非"值得学"，
    # 不剔除的话四级词表开篇就是 state / might / against / system，用户一天就弃坑。
    # 实测 cet6 剔除后从 5,406 → 3,018 词，开篇变成 composition / consume / frequency
    # / tobacco / wealthy —— 这才是词表该有的样子。
    basic_set = set(basic_words)
    decks: dict[str, dict] = {}
    for deck_id, name, desc, tag in DECKS:
        picked = [
            w
            for w, rec in words.items()
            if tag in rec[WORD_FIELDS.index("tag")].split() and w not in basic_set
        ]
        picked.sort(key=lambda w: (words[w][WORD_FIELDS.index("frq")] or 10**9, w))
        decks[deck_id] = {
            "name": name,
            "description": desc,
            "tag": tag,
            "word_count": len(picked),
            "words": picked,
        }
        log(f"  词表 {deck_id:8} {len(picked):>6,} 词")

    # —— 词形还原：variant → lemma ——
    lemma: dict[str, str] = {}
    lemma_path = src / "lemma.en.txt"
    if lemma_path.exists():
        with lemma_path.open(encoding="utf-8") as handle:
            for line in handle:
                if line.startswith(";") or "->" not in line:
                    continue
                head, _, tail = line.partition("->")
                base = head.split("/")[0].strip().lower()
                if not base or not WORD_RE.match(base):
                    continue
                for variant in tail.split(","):
                    variant = variant.strip().lower()
                    if (
                        variant
                        and variant != base
                        and WORD_RE.match(variant)
                        and variant not in lemma  # 先到先得，同形只记一次
                    ):
                        lemma[variant] = base
        log(f"词形还原 {len(lemma):,} 条")

    # —— 词根：裁掉不用的字段 ——
    roots: dict[str, dict] = {}
    root_path = src / "wordroot.txt"
    if root_path.exists():
        raw_roots = json.loads(root_path.read_text(encoding="utf-8"))
        for key, value in raw_roots.items():
            if not isinstance(value, dict):
                continue
            roots[key] = {
                "meaning": value.get("meaning", ""),
                "class": value.get("class", ""),
                "origin": value.get("origin", ""),
                "example": (value.get("example") or [])[:6],
            }
        log(f"词根 {len(roots):,} 条")

    # —— 落盘 ——
    out.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    def dump(name: str, payload: object) -> None:
        path = out / name
        path.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        log(f"写出 {name:16} {path.stat().st_size:>10,} B")

    dump(
        "words.json",
        {
            "fields": WORD_FIELDS,
            "source": "ECDICT/MIT",
            "generated": stamp,
            "words": words,
        },
    )
    dump("decks.json", {"source": "ECDICT/MIT", "generated": stamp, "decks": decks})
    dump("lemma.json", {"source": "ECDICT/MIT", "generated": stamp, "lemma": lemma})
    dump("wordroot.json", {"source": "ECDICT/MIT", "generated": stamp, "roots": roots})

    (out / "basic.json").write_text(
        json.dumps(
            {
                "source": "ECDICT/MIT",
                "generated": stamp,
                "words": sorted(set(basic_words)),
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    log(f"写出 {'basic.json':16} {(out / 'basic.json').stat().st_size:>10,} B")

    notice = out / "NOTICE.md"
    notice.write_text(NOTICE_TEXT.format(stamp=stamp), encoding="utf-8")
    log(f"写出 {'NOTICE.md':16} {notice.stat().st_size:>10,} B")

    total = sum(p.stat().st_size for p in out.iterdir() if p.is_file())
    log(f"产物合计 {total:,} B ({total / 1024 / 1024:.2f} MB)")
    return {
        "words": len(words),
        "basic": len(set(basic_words)),
        "lemma": len(lemma),
        "roots": len(roots),
        "bytes": total,
    }


NOTICE_TEXT = """# 内置英语数据来源与许可

本目录下的 `words.json` / `decks.json` / `lemma.json` / `wordroot.json` / `basic.json`
由 `tools/build_english_dict.py` 从 **ECDICT** 抽取生成，生成日期 {stamp}。

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
"""


def main() -> int:
    parser = argparse.ArgumentParser(description="从 ECDICT 构建知源内置英语数据")
    parser.add_argument(
        "--src", default=".workbuddy/scratch/ecdict", help="ECDICT 原始数据目录"
    )
    parser.add_argument("--out", default="data/english", help="输出目录")
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[2]
    stats = build((root / args.src).resolve(), (root / args.out).resolve())
    log(f"完成：{stats}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
