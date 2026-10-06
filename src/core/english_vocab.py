"""英语词汇 · 纯逻辑层：分词、候选词判据、语料覆盖率、FSRS 间隔调度。

设计约束（刻意的）：
  * **不 import api_server、不碰数据库、不发网络请求** —— 本模块每个函数都能脱库单测；
  * 依赖一律通过参数注入（`is_known` / `lemma_of` / `rng`），而不是在内部去查全局状态；
  * 随机量（FSRS 的 fuzz 抖动）接受可注入的 `random.Random`，测试里传固定种子即可复现。

FSRS 的公式与默认参数移植自 py-fsrs（MIT License, Copyright (c) 2022 Open Spaced
Repetition）。移植时**去掉了 Anki 式的多级 learning_steps 学习阶梯**，换成更适合
本产品的简单规则：评分「忘了」→ 10 分钟后重来，否则 → 按 FSRS 算出的天数到期。
记忆模型（stability / difficulty / retrievability）、难度更新、稳定性增长与遗忘
公式保持与 FSRS-6 一致。
"""

from __future__ import annotations

import math
import random
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterable, NamedTuple, Sequence

# --------------------------------------------------------------------------
# FSRS 常量（与 py-fsrs 一致，勿随手改：默认参数与边界是一套）
# --------------------------------------------------------------------------

FSRS_DEFAULT_PARAMETERS: tuple[float, ...] = (
    0.212,
    1.2931,
    2.3065,
    8.2956,
    6.4133,
    0.8334,
    3.0194,
    0.001,
    1.8722,
    0.1666,
    0.796,
    1.4835,
    0.0614,
    0.2629,
    1.6483,
    0.6014,
    1.8729,
    0.5425,
    0.0912,
    0.0658,
    0.1542,  # = FSRS_DEFAULT_DECAY，参数表的最后一项
)

STABILITY_MIN = 0.001
MIN_DIFFICULTY = 1.0
MAX_DIFFICULTY = 10.0
MAX_INTERVAL_DAYS = 36500
DEFAULT_RETENTION = 0.9

# 评分：1=忘了 2=模糊 3=认识 4=秒懂（对齐 FSRS 的 Again/Hard/Good/Easy）
RATING_AGAIN = 1
RATING_HARD = 2
RATING_GOOD = 3
RATING_EASY = 4
RATINGS = (RATING_AGAIN, RATING_HARD, RATING_GOOD, RATING_EASY)
RATING_LABELS = {RATING_AGAIN: "忘了", RATING_HARD: "模糊", RATING_GOOD: "认识", RATING_EASY: "秒懂"}

# 「忘了」之后多久重来（替代 Anki 的 relearning_steps）
AGAIN_DELAY = timedelta(minutes=10)

# 与 py-fsrs 的 FUZZ_RANGES 同构：(起始天数, 结束天数, 抖动系数)
FUZZ_RANGES: tuple[tuple[float, float, float], ...] = (
    (2.5, 7.0, 0.15),
    (7.0, 20.0, 0.10),
    (20.0, math.inf, 0.05),
)


def _parameters(params: Sequence[float] | None) -> tuple[float, ...]:
    chosen = tuple(params) if params else FSRS_DEFAULT_PARAMETERS
    if len(chosen) < 20:
        raise ValueError(f"FSRS 参数至少需要 20 项，收到 {len(chosen)} 项")
    return chosen


def decay_of(params: Sequence[float] | None = None) -> float:
    """DECAY = -w[20]（py-fsrs 里 `self._DECAY = -parameters[20]`）。"""
    return -_parameters(params)[20]


def factor_of(params: Sequence[float] | None = None) -> float:
    """FACTOR = 0.9 ** (1 / DECAY) - 1。"""
    return 0.9 ** (1 / decay_of(params)) - 1


def clamp_difficulty(value: float) -> float:
    return min(max(value, MIN_DIFFICULTY), MAX_DIFFICULTY)


def clamp_stability(value: float) -> float:
    return max(value, STABILITY_MIN)


# --------------------------------------------------------------------------
# 分词与词形归一
# --------------------------------------------------------------------------

# 英文词：字母开头结尾，中间允许连字符与撇号（email-like、don't、state-of-the-art）
_TOKEN_RE = re.compile(r"[A-Za-z]+(?:['\u2019\-][A-Za-z]+)*")
# 数学公式区域。**必须先剔除再分词**：`\frac{a}{b}`、`\mu_{bs}`、`x \cdot y` 里的
# `frac` / `mu` / `cdot` 会被当成英文单词，在理工科文献里能刷出一屏垃圾候选词
# （实测踩到：`cdot`、`frac`、`delta` 都进了生词本）。知源的主力用户读的正是
# 这种带公式的论文，所以这一步不是可选项。
_MATH_RE = re.compile(
    r"\$\$[^$]{0,2000}?\$\$"          # 行间公式 $$...$$
    r"|\$[^$\n]{1,400}?\$"            # 行内公式 $...$
    r"|\\\[.{0,2000}?\\\]"            # \[ ... \]
    r"|\\\(.{0,400}?\\\)",            # \( ... \)
    re.S,
)
# 反斜杠开头的命令（\alpha、\times）即使公式定界符已被破坏，也不该进词表
_LATEX_CMD_RE = re.compile(r"\\[A-Za-z]+")

# 句子边界。三件事都靠它：判断哪些 token 位于句首（句首大写不能当作"专有名词"
# 的证据）、抽取"这个词出现在哪句话里"、以及把 markdown 表格拆散。
#
# **必须包含中文标点**：知源的主力用户读的是中文论文夹英文术语的文献，只用英文
# 标点切分的话，一整段中文会被当成"一句话"，词卡上的例句就成了大段中文。
# **也必须包含 `|`**：从 PDF/网页抽出来的正文里常混着表格行（"| 方法 | 结论 |"），
# 而表格行与正文句子往往在同一行上，不拆开的话整段会被表格判据误杀，
# 连带把真正有用的那句英文例句一起丢掉（实测踩到的坑）。
_SENT_SPLIT_RE = re.compile(r"[.!?;:\n\r。！？；：…|]+")


def strip_math(text: str) -> str:
    """去掉公式区域与 LaTeX 命令，留下可读正文。"""
    if not text:
        return ""
    return _LATEX_CMD_RE.sub(" ", _MATH_RE.sub(" ", text))


class Token(NamedTuple):
    """一个词在原文中的出现。``at_start`` 为真时，首字母大写不代表专有名词。"""

    surface: str
    lower: str
    sentence: int
    at_start: bool


def tokenize(text: str) -> list[Token]:
    """按英文词切分文本，并标出每个词是否处于句首。

    先剥离数学公式再切分 —— 否则 `\\frac` / `\\cdot` / `\\mu` 里的字母会被当成
    英文单词（这条是实测踩出来的，不剥离会在带公式的论文里产生成屏的垃圾候选词）。

    句首标记是给"疑似专有名词"判据用的：`Coherent` 出现在句首是正常的，出现在
    句中还大写才可疑。
    """
    tokens: list[Token] = []
    if not text:
        return tokens

    text = strip_math(text)
    cursor = 0
    sentence = 0
    for chunk in _SENT_SPLIT_RE.split(text):
        offset = text.find(chunk, cursor)
        cursor = (offset + len(chunk)) if offset >= 0 else cursor
        first = True
        for match in _TOKEN_RE.finditer(chunk):
            surface = match.group(0)
            tokens.append(
                Token(
                    surface=surface,
                    lower=surface.lower(),
                    sentence=sentence,
                    at_start=first,
                )
            )
            first = False
        sentence += 1
    return tokens


def normalize_token(token: str) -> str:
    """小写化并去掉名词所有格：`Children's` → `children`。"""
    word = (token or "").strip().lower().replace("\u2019", "'")
    if word.endswith("'s"):
        word = word[:-2]
    return word.strip("'-")


_SIBILANT = ("s", "x", "z", "ch", "sh")
_VOWELS = "aeiou"


def _doubled(stem: str) -> bool:
    """`runn` / `plann` 这类末尾叠辅音，去一个才是原形。"""
    return len(stem) > 3 and stem[-1] == stem[-2] and stem[-1] not in _VOWELS


def lemma_candidates(word: str) -> list[str]:
    """给出该词可能的原形，**按可能性从高到低，原词本身恒为最后一项**。

    为什么返回候选而不是直接猜一个：词形还原最可靠的做法是查 ECDICT 的 lemma 数据，
    本函数只是没有命中时的兜底（ECDICT README 明说纯算法"都不靠谱"）。调用方应该
    依次拿候选去查字典，第一个命中的才是原形；都没命中就用原词兜底 —— 宁可少还原，
    不要错还原（错还原会污染词频统计和覆盖率，且用户会看到错误的词条）。

    注意原词排在最后：像 `studies` 这种既能自成一词、又是 `study` 的变形时，词频
    统计应当并入 `study`，所以原形要优先于原词被查到。
    """
    w = normalize_token(word)
    if not w or "-" in w:
        return [w] if w else []

    stems: list[str] = []

    def push(stem: str) -> None:
        if len(stem) >= 3 and stem != w and stem not in stems:
            stems.append(stem)

    # —— 复数 / 第三人称单数 ——：三种结尾互斥，只走一条分支
    if w.endswith("ies") and len(w) > 4:
        push(w[:-3] + "y")                                   # studies → study
    elif w.endswith("es") and len(w) > 3 and w[:-2].endswith(_SIBILANT):
        push(w[:-2])                                         # boxes → box
    elif w.endswith("s") and not w.endswith("ss") and len(w) > 3:
        push(w[:-1])                                         # hopes → hope, words → word

    # —— 现在分词 / 动名词 ——：叠辅音优先去叠（running→run），否则先试裸词干
    if w.endswith("ing") and len(w) > 5:
        stem = w[:-3]
        if _doubled(stem):
            push(stem[:-1])                                  # running → run
            push(stem)                                       # running → runn
        else:
            push(stem)                                       # walking → walk
        push(stem + "e")                                     # making → make

    # —— 过去式 / 过去分词 ——：`-ied` 必须先于 `-ed`（embodied → embody，不是 embodi）
    if w.endswith("ied") and len(w) > 4:
        push(w[:-3] + "y")                                   # studied → study
    elif w.endswith("ed") and len(w) > 4:
        stem = w[:-2]
        if _doubled(stem):
            push(stem[:-1])                                  # planned → plan
            push(stem)
        else:
            push(stem)                                       # walked → walk
        push(stem + "e")                                     # used → use

    # —— 副词 ——
    if w.endswith("ly") and len(w) > 4:
        push(w[:-2])                                         # quickly → quick

    return stems + [w]


# --------------------------------------------------------------------------
# 候选词判据
# --------------------------------------------------------------------------

MIN_CANDIDATE_LEN = 4
BASE_FRQ_CEILING = 3000       # 当代语料库前 3000 名 = 基础词
BASE_COLLINS_FLOOR = 3        # 柯林斯 3 星及以上 = 高频基础词

_ACRONYM_RE = re.compile(r"^[A-Z0-9]{2,}$")


def is_candidate(
    lower: str,
    *,
    surface: str = "",
    at_start: bool = False,
    entry: dict | None = None,
    is_known: bool = False,
    min_len: int = MIN_CANDIDATE_LEN,
) -> bool:
    """判断一个词是否"值得学"。

    `entry` 是 ECDICT 的查表结果（可为 None）。判据全部是客观标注，不花模型调用：
    已在已知集合 / 牛津3000核心词 / 柯林斯>=3星 / 词频前3000 的，都不是候选。
    """
    if not lower or len(lower) < min_len:
        return False
    if is_known:
        return False
    if not re.fullmatch(r"[a-z]+(?:['\-][a-z]+)*", lower):
        return False

    # 带连字符的复合词/缩写组合（state-of-the-art、THz-TDS）不是"一个可背的单词"。
    # 实测中文文献里这类噪声很多，而且卡片上没有可用的释义。
    if "-" in lower:
        return False

    # 全大写缩写（SNR / FFT / CNN）
    if surface and _ACRONYM_RE.match(surface):
        return False

    # 疑似专有名词：句中大写，且不是一个普通词
    if surface and surface[:1].isupper() and not at_start and surface[1:].islower():
        if entry is None:
            return False

    if entry:
        if int(entry.get("oxford") or 0) == 1:
            return False
        collins = int(entry.get("collins") or 0)
        if collins >= BASE_COLLINS_FLOOR:
            return False
        frq = int(entry.get("frq") or 0)
        if 0 < frq < BASE_FRQ_CEILING:
            return False

    return True


def acronym_lemmas(tokens: Iterable[Token]) -> set[str]:
    """在语料里出现过「多个大写字母」写法的词，视为缩写（QOCT、THz-TDS、SEM…）。

    为什么单看单词本身不够：`qOCT` / `QOCT` / `qoct` 会在同一篇文章里混用，
    只判断「当前这个词是不是全大写」必然漏。所以按**整篇语料的写法聚合**来判断 ——
    只要它在文中以两个以上大写字母出现过，就是这个领域自造的缩写，不是该背的单词。
    这类词在实测里贡献了大量噪声（例句还是参考文献的作者列表）。
    """
    flagged: set[str] = set()
    for token in tokens:
        surface = token.surface
        if surface.islower():
            continue
        if sum(1 for ch in surface if ch.isupper()) >= 2:
            flagged.add(token.lower)
    return flagged


def exam_tags_of(entry: dict | None) -> list[str]:
    """把 ECDICT 的 tag 字段（空格分隔）拆成列表。"""
    if not entry:
        return []
    raw = entry.get("tag") or ""
    return [t for t in str(raw).split() if t]


# 考试标签的展示名与默认优先级（越靠前越优先推荐）
EXAM_LABELS = {
    "cet4": "四级",
    "cet6": "六级",
    "ky": "考研",
    "ielts": "雅思",
    "toefl": "托福",
    "gre": "GRE",
    "gk": "高考",
    "zk": "中考",
}


def exam_rank(tags: Iterable[str], goals: Sequence[str]) -> int:
    """目标考试命中越靠前，返回的排名越小；完全没命中排到最后。"""
    tag_set = set(tags)
    for index, goal in enumerate(goals or []):
        if goal in tag_set:
            return index
    return len(goals or []) if tag_set & set(EXAM_LABELS) else len(goals or []) + 1




# --------------------------------------------------------------------------
# 释义清洗：ECDICT 的 translation 是给「词典查阅」用的长串，
# 直接当背单词卡用会出现「n. 消费, 消费量, 痨病 / [化] 消耗量; 耗量」这种东西 ——
# 生僻义与领域标注会干扰记忆。这里只做**展示层**的整理，不动入库数据。
# --------------------------------------------------------------------------

# 词性前缀：n. vt. a. ad. ... 只认出现在段首的
_POS_PREFIX = re.compile(
    r"^(n|v|vt|vi|a|adj|ad|adv|prep|conj|pron|num|art|int|aux|abbr|pl)\.\s*",
    re.IGNORECASE,
)
# 领域标注 [医] [化] [计] ...（最多 6 个字，避免吃掉正文里的方括号）
_DOMAIN_MARK = re.compile(r"\[[^\[\]]{1,6}\]")
# 义项分隔：逗号（中英）、分号、顿号
_SENSE_SPLIT = re.compile(r"[,;，；、]")
# 词性段落分隔：ECDICT 用「 / 」或换行分隔不同词性
_POS_SPLIT = re.compile(r"\s+/\s+|\n")

DEFAULT_MAX_SENSES = 4
DEFAULT_MAX_LEN = 96

# 批量预生成拓展时一次最多带多少个词。8 是个折中：再多容易出现模型漏答
# （漏掉的词还得再发一次请求），再少就把原本能省下的系统提示词又摊回去了。
MAX_BATCH_EXTRAS = 8


def meaning_sections(
    text: str | None, *, max_pos: int = 3, max_senses: int = DEFAULT_MAX_SENSES
) -> list[dict]:
    """把 ECDICT 释义串拆成 [{pos, senses[]}]，供界面按词性分行展示。

    规则（都只影响展示，不改数据）：
      * `\\r` / 换行 / ` / ` 视为词性段落分隔；
      * 段首的 `n.` `vt.` 等作为词性标记，段内义项按中英逗号、分号、顿号切分；
      * 去掉 `[医]` `[化]` 这类领域标注；
      * 义项里「几乎没有中文」的（如缩写词的英文全称）在有中文义项时丢弃 ——
        背单词卡上出现一整串英文原注只会占地方；
      * 每个词性最多留 max_senses 个义项，最多 max_pos 个词性。
    """
    raw = str(text or "").replace("\\r", "\n").replace("\r", "\n")
    sections: list[dict] = []
    for segment in _POS_SPLIT.split(raw):
        segment = _DOMAIN_MARK.sub("", segment).strip()
        if not segment:
            continue
        match = _POS_PREFIX.match(segment)
        pos = match.group(0).strip() if match else ""
        body = segment[match.end() :] if match else segment
        senses = [
            piece.strip(" ．.。'\"")
            for piece in _SENSE_SPLIT.split(body)
        ]
        senses = [s for s in senses if s]
        if not senses:
            continue
        # 中文义项优先；只有中文义项一个都没有时才退回英文原注
        chinese = [s for s in senses if _latin_ratio(s) < 0.6]
        picked = chinese or senses
        deduped: list[str] = []
        for sense in picked:
            if sense not in deduped:
                deduped.append(sense)
        # 并进上一段的两种情况：
        #   1. 词性相同（ECDICT 里「n. 频率, 频数 / n. 频率」很常见）；
        #   2. 本段没有词性标记，如「… / 放任, 无拘束」。
        # 合并时必须按已有义项去重，否则卡片上会出现「频率、频数、频率」。
        if sections and (sections[-1]["pos"] == pos or not pos):
            merged: list[str] = []
            for sense in list(sections[-1]["senses"]) + deduped:
                if sense not in merged:
                    merged.append(sense)
            sections[-1]["senses"] = merged[:max_senses]
            continue
        sections.append({"pos": pos, "senses": deduped[:max_senses]})
    return sections[:max_pos]


_CJK_RE = re.compile(r"[\u4e00-\u9fff]")


def has_cjk(text: str | None) -> bool:
    """释义里到底有没有中文。

    语料摘出来的词，释义常常是模型写的**英文注释**（`A subatomic particle with
    negative charge…`）。背单词卡上「释义栏一整行英文、一个中文字都没有」就是这么来的
    —— 不是空，是**没有中文**。得能分辨这两件事，才知道该不该去词典补。
    """
    return bool(_CJK_RE.search(str(text or "")))


def zh_meaning_from_dict(dictionary: Any, lemma: str | None) -> tuple[str, str]:
    """给「只有英文释义」的词补中文。返回 `(中文释义, 来源)`，补不到返回 `("", "")`。

    只查**单词**（ECDICT 的中文在 `translation` 字段，没有 `meaning` 字段）。

    ⚠️ 词组（`wave function` / `probability density`）**绝不机械拼** —— 实测拼出来的
    是「波官能」「可能性密度」「校长哈密顿」「时间依赖他人者不安理论」，比英文原注
    更糟：那不是没中文，是**错的中文**。词组的中文只认可靠来源 —— 用户自己资料里的
    中英对照（`en_corpus_excerpts.terms_json` 的 zh，见 `EnglishStore.term_zh`），
    那才是「自由粒子 / 光电效应 / 微扰哈密顿」这种正确译名。
    """
    key = normalize_token(str(lemma or ""))
    if not key or " " in key or "-" in key:
        return "", ""
    entry = (dictionary.lookup(key) if hasattr(dictionary, "lookup") else None) or {}
    direct = clean_meaning(entry.get("translation") or "")
    if direct and has_cjk(direct):
        return direct, "dict"
    return "", ""


def clean_meaning(text: str | None, *, max_len: int = DEFAULT_MAX_LEN) -> str:
    """清洗后的单串释义（「n. 消费、消费量；vt. 消耗」），供卡片主显示。

    用户自己手写的释义（一般没有 ` / `、`[领域]`、`\\r`）会被原样返回，
    不做任何改写 —— 那是用户自己的措辞。
    """
    stripped = str(text or "").strip()
    if not stripped:
        return ""
    sections = meaning_sections(stripped)
    if not sections:
        return stripped[:max_len]
    parts = []
    for section in sections:
        body = "、".join(section["senses"])
        parts.append(f"{section['pos']} {body}".strip() if section["pos"] else body)
    joined = "；".join(parts)
    if len(joined) > max_len:
        joined = joined[: max_len - 1].rstrip("、；,; ") + "…"
    return joined


# --------------------------------------------------------------------------
# 语料覆盖率：这份材料对用户有多难
# --------------------------------------------------------------------------


def build_coverage(
    tokens: Sequence[Token],
    *,
    lemma_of: Callable[[Token], str] | None = None,
    is_known: Callable[[str], bool] | None = None,
    entry_of: Callable[[str], dict | None] | None = None,
    limit: int = 50,
) -> dict:
    """算出"已认识词次 / 总词次"，并给出性价比最高的待学生词。

    `gain` = 掌握该词后能提升的覆盖率（该词的词次 / 总词次）。按 gain 排序比按词频
    排序更有说服力：用户看到的是"再背 10 个词就能多读懂 3%"。
    """
    lemma_of = lemma_of or (lambda t: t.lower)
    is_known = is_known or (lambda _w: False)
    entry_of = entry_of or (lambda _w: None)

    total = 0
    known_tokens = 0
    freq: dict[str, int] = {}
    surfaces: dict[str, str] = {}

    for token in tokens:
        if not re.fullmatch(r"[a-z][a-z'\-]*", token.lower):
            continue
        total += 1
        lemma = lemma_of(token) or token.lower
        surfaces.setdefault(lemma, token.surface)
        freq[lemma] = freq.get(lemma, 0) + 1
        if is_known(lemma):
            known_tokens += 1

    unknown = [w for w in freq if not is_known(w)]
    gain_map = {
        w: (freq[w] / total if total else 0.0)
        for w in unknown
    }
    ordered = sorted(unknown, key=lambda w: (-freq[w], w))

    coverage = (known_tokens / total) if total else 1.0
    return {
        "total_tokens": total,
        "known_tokens": known_tokens,
        "coverage": round(coverage, 4),
        "unique_total": len(freq),
        "unknown_total": len(unknown),
        "gain_map": gain_map,
        "unknown": [
            {
                "lemma": w,
                "surface": surfaces.get(w, w),
                "freq": freq[w],
                "gain": round(gain_map[w], 5),
                "entry": entry_of(w),
            }
            for w in ordered[:limit]
        ],
    }




# --------------------------------------------------------------------------
# FSRS 调度
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class SrsState:
    """一张卡片的记忆状态。stability=0 表示还没学过。"""

    stability: float = 0.0
    difficulty: float = 0.0
    reps: int = 0
    lapses: int = 0
    state: str = "new"          # new | learning | review | relearning
    last_review: datetime | None = None

    def as_dict(self) -> dict:
        return {
            "stability": self.stability,
            "difficulty": self.difficulty,
            "reps": self.reps,
            "lapses": self.lapses,
            "state": self.state,
            "last_review": self.last_review.isoformat() if self.last_review else None,
        }


def initial_stability(rating: int, params: Sequence[float] | None = None) -> float:
    return clamp_stability(_parameters(params)[rating - 1])


def initial_difficulty(
    rating: int, params: Sequence[float] | None = None, *, clamp: bool = True
) -> float:
    w = _parameters(params)
    value = w[4] - (math.e ** (w[5] * (rating - 1))) + 1
    return clamp_difficulty(value) if clamp else value


def retrievability(
    elapsed_days: float, stability: float, params: Sequence[float] | None = None
) -> float:
    """R(t, S) = (1 + FACTOR * t / S) ** DECAY。"""
    if stability <= 0:
        return 0.0
    return (1 + factor_of(params) * max(0.0, elapsed_days) / stability) ** decay_of(params)


def next_difficulty(
    difficulty: float, rating: int, params: Sequence[float] | None = None
) -> float:
    """难度更新 = 线性阻尼 + 朝"秒懂初始难度"的均值回归（与 py-fsrs 一致）。"""
    w = _parameters(params)
    delta = -(w[6] * (rating - 3))
    damped = difficulty + (MAX_DIFFICULTY - difficulty) * delta / 9.0
    easy_initial = initial_difficulty(RATING_EASY, params, clamp=False)
    reverted = w[7] * easy_initial + (1 - w[7]) * damped
    return clamp_difficulty(reverted)


def short_term_stability(
    stability: float, rating: int, params: Sequence[float] | None = None
) -> float:
    """同日重复复习的稳定性。py-fsrs 里对非 Again 评分有 min=1.0 的下界保护。"""
    w = _parameters(params)
    increase = (math.e ** (w[17] * (rating - 3 + w[18]))) * (stability ** -w[19])
    if rating in (RATING_HARD, RATING_GOOD, RATING_EASY):
        increase = max(increase, 1.0)
    return clamp_stability(stability * increase)


def recall_stability(
    stability: float,
    difficulty: float,
    r: float,
    rating: int,
    params: Sequence[float] | None = None,
) -> float:
    """记住了：稳定性按 FSRS 公式增长，模糊打折、秒懂加成。"""
    w = _parameters(params)
    hard_penalty = w[15] if rating == RATING_HARD else 1
    easy_bonus = w[16] if rating == RATING_EASY else 1
    return clamp_stability(
        stability
        * (
            1
            + (math.e ** w[8])
            * (11 - difficulty)
            * (stability ** -w[9])
            * ((math.e ** ((1 - r) * w[10])) - 1)
            * hard_penalty
            * easy_bonus
        )
    )


def forget_stability(
    stability: float,
    difficulty: float,
    r: float,
    params: Sequence[float] | None = None,
) -> float:
    """忘了：稳定性按 FSRS 公式衰减，并取"长期项 vs 短期项"的较小值。"""
    w = _parameters(params)
    long_term = (
        w[11]
        * (difficulty ** -w[12])
        * (((stability + 1) ** w[13]) - 1)
        * (math.e ** ((1 - r) * w[14]))
    )
    short_term = stability / (math.e ** (w[17] * w[18]))
    return clamp_stability(min(long_term, short_term))


def interval_days(
    stability: float,
    retention: float = DEFAULT_RETENTION,
    params: Sequence[float] | None = None,
) -> int:
    """把稳定性换算成天数。注意 retention=0.9 时结果恰好等于 stability 本身。"""
    factor = factor_of(params)
    decay = decay_of(params)
    raw = (stability / factor) * ((retention ** (1 / decay)) - 1)
    return max(1, min(int(round(raw)), MAX_INTERVAL_DAYS))


def fuzz_days(days: int, rng: random.Random | None = None) -> int:
    """给天数加一点随机抖动，避免所有卡片挤在同一天到期（"卡片扎堆"）。

    抖动幅度沿用 py-fsrs 的分档；<2.5 天不抖动。
    """
    if days < 3:
        return days
    for start, end, factor in FUZZ_RANGES:
        if start <= days < end:
            delta = max(1, int(round(factor * days)))
            rng = rng or random.Random()
            return max(1, days + rng.randint(-delta, delta))
    return days


def review(
    state: SrsState,
    rating: int,
    *,
    now: datetime | None = None,
    params: Sequence[float] | None = None,
    retention: float = DEFAULT_RETENTION,
    rng: random.Random | None = None,
    fuzz: bool = True,
) -> tuple[SrsState, datetime]:
    """提交一次评分，返回新状态与下次到期时间。

    这是本功能的调度核心，也是唯一会"移动时间"的地方 —— 因此做成纯函数：
    给定 (状态, 评分, 当前时间)，结果完全确定（除非显式开启 fuzz）。
    """
    if rating not in RATINGS:
        raise ValueError(f"评分必须是 {RATINGS} 之一，收到 {rating!r}")

    now = now or datetime.now(timezone.utc)
    params = _parameters(params)

    # —— 首次学习：只初始化记忆状态 ——
    if state.state == "new" or state.stability <= 0:
        new_state = SrsState(
            stability=initial_stability(rating, params),
            difficulty=initial_difficulty(rating, params),
            reps=1,
            lapses=1 if rating == RATING_AGAIN else 0,
            state="learning" if rating == RATING_AGAIN else "review",
            last_review=now,
        )
    else:
        elapsed = 0.0
        if state.last_review is not None:
            elapsed = max(0.0, (now - state.last_review).total_seconds() / 86400.0)

        r = retrievability(elapsed, state.stability, params)
        difficulty = next_difficulty(state.difficulty, rating, params)

        if elapsed < 1.0:
            # 同一天内重复：用短期稳定性，避免"当天再点一次就跳到 30 天"
            stability = short_term_stability(state.stability, rating, params)
        elif rating == RATING_AGAIN:
            stability = forget_stability(state.stability, difficulty, r, params)
        else:
            stability = recall_stability(state.stability, difficulty, r, rating, params)

        new_state = SrsState(
            stability=stability,
            difficulty=difficulty,
            reps=state.reps + 1,
            lapses=state.lapses + (1 if rating == RATING_AGAIN else 0),
            state="relearning" if rating == RATING_AGAIN else "review",
            last_review=now,
        )

    # —— 到期时间：「忘了」当堂重来，其余按天数 ——
    if rating == RATING_AGAIN:
        return new_state, now + AGAIN_DELAY

    days = interval_days(new_state.stability, retention, params)
    if fuzz:
        days = fuzz_days(days, rng)
    return new_state, now + timedelta(days=days)




def normalize_rating(value: object) -> int:
    """把外部传进来的评分收敛成 1..4，非法值抛 ValueError（端点会转成 400）。"""
    try:
        rating = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        raise ValueError(f"评分必须是 {RATINGS} 之一，收到 {value!r}") from None
    if rating not in RATINGS:
        raise ValueError(f"评分必须是 {RATINGS} 之一，收到 {rating!r}")
    return rating


def _latin_ratio(text: str) -> float:
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return 0.0
    return sum(1 for c in letters if c.isascii()) / len(letters)


def _usable_sentence(segment: str) -> bool:
    """这一段配不配当"例句"。

    实测踩到的坑：中文文献里 `qoct` 的取句结果是**参考文献的作者列表**
    （"杨晓玉 1， 彭念 1， 沈毅 2…"），`thz-tds` 取到的是 markdown 表格行
    （"| 研究方法/技术路线 |"）。这类片段对背单词毫无价值，混进卡片反而是负分，
    所以宁可不给例句也不要给错的。
    """
    if not segment or len(segment) > 600:
        return False
    words = list(_TOKEN_RE.finditer(segment))
    if len(words) < 4:                       # 没有 4 个英文词的，不是英文句子
        return False
    digits = sum(1 for ch in segment if ch.isdigit())
    if digits / len(segment) > 0.12:          # 数字密集 → 参考文献/表格
        return False
    if segment.count("|") >= 2:               # markdown 表格行
        return False
    return _latin_ratio(segment) >= 0.45 or len(segment) <= 90


def sample_sentence(text: str, word: str, *, max_len: int = 200) -> str:
    """从原文里摘出**包含该词的那一句** —— 词卡上「你原文里那句话」的来源。

    中英混排的文献（中文论文夹英文术语）是知源用户的常态，所以选句有两条偏好：
      1. **优先英文占多数的那句** —— "optical" 出现在一整段中文里，那句中文当例句
         毫无价值；同一篇里通常也有一句真正的英文原文，那才值得背；
      2. 同等条件下取更短的 —— 短句更像"一句话"，长段落不像。

    找不到（或找到的都不合格）就返回空串：宁可卡片上没有例句，也不要塞一句不相关
    的文本充数 —— 那会直接破坏"这个词是在哪绊住你的"这个产品主张。
    """
    key = normalize_token(word)
    if not text or not key:
        return ""

    hits: list[str] = []
    for raw in _SENT_SPLIT_RE.split(strip_math(text)):
        segment = raw.strip()
        if not segment:
            continue
        if any(normalize_token(m.group(0)) == key for m in _TOKEN_RE.finditer(segment)):
            if _usable_sentence(segment):
                hits.append(segment)

    if not hits:
        return ""

    best = min(
        hits,
        key=lambda segment: (
            0 if _latin_ratio(segment) >= 0.5 else 1,   # 英文占多数优先
            len(segment) if len(segment) <= max_len else max_len + len(segment) - max_len,
        ),
    )
    return best if len(best) <= max_len else best[: max_len - 1] + "…"


def preview_intervals(
    state: SrsState,
    *,
    now: datetime | None = None,
    params: Sequence[float] | None = None,
    retention: float = DEFAULT_RETENTION,
) -> dict[int, str]:
    """给界面上四个按钮标注"下次什么时候再见"，让用户看得见选择后果。

    两个必须注意的点：
      * **不启用 fuzz** —— 预览必须确定，否则四个按钮的数字会自己跳；
      * **基准时间只取一次** —— 曾经在循环里前后各取一次 `datetime.now()`，
        两次相差几微秒，于是"1 天"被显示成了"23 小时"（真实踩到的坑）。
    """
    base = now or datetime.now(timezone.utc)
    out: dict[int, str] = {}
    for rating in RATINGS:
        _state, due = review(
            state, rating, now=base, params=params, retention=retention, fuzz=False
        )
        out[rating] = humanize_delta(due - base)
    return out


def humanize_delta(delta: timedelta) -> str:
    minutes = int(delta.total_seconds() // 60)
    if minutes < 60:
        return f"{max(1, minutes)} 分钟"
    hours = minutes // 60
    if hours < 24:
        return f"{hours} 小时"
    days = hours // 24
    if days < 30:
        return f"{days} 天"
    months = days / 30
    if months < 12:
        return f"{months:.1f} 个月"
    return f"{days / 365:.1f} 年"


# --------------------------------------------------------------------------
# 时间工具
# --------------------------------------------------------------------------


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def to_iso(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)
