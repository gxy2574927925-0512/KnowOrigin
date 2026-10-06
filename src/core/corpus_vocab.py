# -*- coding: utf-8 -*-
"""从「用户自己导入的资料」里摘录语料，并统一用英文表述。

产品主张（这一层存在的理由）：
    词不该从别人的词书里来，该从**你正在读的东西**里来。内置词表回答的是
    「考研要考哪些词」，而资料回答的是「**你现在**被哪些词绊住」。后者才是
    真正要背的那批，而且它自带语境——你记得住「这个词是在哪句话里不认识它的」。

    所以本模块只做一件事：把用户导入的资料（中文的、英文的、中英混排的）
    摘成一批**可学的英文语料片段**，每片带术语表。之后由 /api/en/corpus/promote
    把片里的词推进生词本，走已有的 FSRS 复习链路。

两种资料、两条路：
  - **英文资料**：零模型调用。复用 core/english_vocab.py 的客观判据找生词，
    再摘「含金量最高的那几段」——含候选词最多的段落。原文即英文表述，不用转写。
  - **中文资料**：必须过模型。规则先切片段、抽出中文概念锚点（高频 n-gram），
    再让模型产出「这段的英文表述 + 核心术语的中英对照」。规则只负责给模型
    递线索，不负责下结论——中译英的准确度只有模型能保证。

设计原则只有一条：内容优先。生词不是从词书里背来的，是从自己正在读的
材料里长出来的；每片语料都保留原句当记忆锚点，复习时能回到出处。
"""

from __future__ import annotations

import json
import re
from typing import Any, Callable, Iterable

# ================================================================ 常量

#: 单个语料片段的目标字数。太短没语境，太长模型会糊、用户也读不完。
CHUNK_SIZE = 620
#: 英文资料每片最多带几个词。
MAX_TERMS_EN = 8
#: 英文段落至少要有这么多 token 才够格当一片语料（一句话太短，不像「一段」）。
MIN_CHUNK_TOKENS = 24
#: 至少命中几个候选词才值得摘——一个生词的段落不值得单独存一片。
MIN_TERM_HITS = 3
#: 生词密度上限。只用来挡参考文献列表、纯数据表、公式残渣这类非散文段落；
#: 专业课正文生词占到三成是常态，卡太死会把最难、也最该学的那批资料全滤掉。
MAX_UNKNOWN_DENSITY = 0.5
#: 中文资料每片请模型给的术语数（给个区间，让模型按段落密度自己定）。
TERM_RANGE_ZH = "3~6"

#: 判断「这份资料是中文的还是英文的」用的阈值：中文字符占非空字符的比例。
ZH_RATIO_ZH = 0.25
ZH_RATIO_MIXED = 0.05

_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_LATIN_RE = re.compile(r"[A-Za-z]")
#: 连续中文串——中文术语只会长在这里面
_CJK_RUN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{2,}")
#: 公式/表格噪声，切片段前先抹掉，否则会把一片 LaTeX 当成正文
_MATH_NOISE_RE = re.compile(r"\$\$?[^$]{0,200}\$\$?|\\\[[^\]]{0,300}\\\]")

#: 阅读器渲染用的结构标记（[[FIG:id]] 图片锚点 / [[MATH:id]] 公式占位 / [[H:n]] 标题）。
#: 在文献阅读器里它们是渲染锚点，但语料片段是**纯文本**——留着只会让用户看到
#: 「[[H:3]] 光子的动量」这类实现细节，且它们会把连续中文切成碎段。
_STRUCT_MARK_RE = re.compile(r"\[\[(?:FIG|H|MATH):[^\]]*\]\]")

#: PDF 抽取的「看不见的垃圾」：私用区字符（MathType/Symbol 字体的公式字形落不进
#: Unicode 就被塞进 U+E000~U+F8FF——这是「□」乱码的主要来源）、替换符、实心方块
#: 与控制字符。它们不携带任何可读信息，直接删（不是换成空格，避免词间多出空洞）。
_INVISIBLE_GARBAGE_RE = re.compile(
    r"[\ue000-\uf8ff\ufffd\u25a1\u25af\u25fb\u25fc\x00-\x08\x0b\x0c\x0e-\x1f\u200b\u200e\u200f]"
)
#: 可见的装饰符号（•、·）：当噪声删会粘词，换成空格保住词边界。
_DECOR_RE = re.compile(r"[\u2022\u00b7]")


def _is_residue_token(token: str) -> bool:
    """一个 token 是否像公式残渣（既不是中文、不像英文单词，也没有希腊字母/数学符号）。

    希腊字母（ε μ ψ）与数学符号块（←~∫ ∑ ≤）单独豁免——它们出现说明
    这是真公式内容，哪怕排版乱了也留给模型/用户，不在这里下结论。
    """
    if _CJK_RE.search(token):
        return False
    if len(token) >= 3 and all(c.isascii() and c.isalpha() for c in token):
        return False  # 纯字母短词（含 END/THE 这类元音不全的大写词）不是残渣
    if _looks_like_word(token):
        return False
    for ch in token:
        if "\u0370" <= ch <= "\u03ff" or "\u2190" <= ch <= "\u22ff":
            return False
    return True


def _strip_inline_residue(line: str) -> str:
    """抹掉一行内部连续 ≥3 个残渣 token 组成的公式骨架。

    两道保险，防误杀：
      - 串里任何一个 token 有 ≥4 个字母（占半数以上，像「form」「nn」反例是
        长度不够）→ 可能是正常英文短语，整串保留；
      - 串里出现 = / << / >> → 像一条真等式（「H = H0 + H'」），整串保留。
    """
    tokens = line.split()
    kept: list[str] = []
    run: list[str] = []

    def _run_is_residue() -> bool:
        if len(run) < 3:
            return False
        for token in run:
            if "=" in token or "<<" in token or ">>" in token:
                return False  # 像一条真等式（「H = H0 + H'」），整串保留
        return True

    def flush() -> None:
        if not _run_is_residue():
            kept.extend(run)
        run.clear()

    for token in tokens:
        if _is_residue_token(token):
            run.append(token)
        else:
            flush()
            kept.append(token)
    flush()
    return " ".join(kept)


def _looks_like_word(token: str) -> bool:
    """一个 token 像不像真正的英文单词（≥3 字符、以字母为主、含 ≥2 种元音字母）。

    用来区分「Figure 3.1 Schematic of...」（真英文句子，整行要留）和
    「E1(0) = 1 E2(0) = 3」（公式残渣，整行该丢）。
    """
    if len(token) < 3:
        return False
    alpha = [c for c in token if c.isalpha()]
    if len(alpha) < len(token) * 0.6:
        return False
    vowels = {c.lower() for c in token if c.lower() in "aeiou"}
    return len(vowels) >= 2


def _is_residue_line(line: str) -> bool:
    """一整行是否纯属公式残渣/乱码，该整个丢掉。

    判据（对**不含中文**的行才生效——含中文的行再乱也留着，交给模型）：
    没有任何「像英文单词」的 token（``_looks_like_word``）。真实的英文句子
    几乎必然含一个元音齐全的词（Figure / matrix / theory）；公式骨架抽出来
    只剩「kn a mn mn mk kn」「33 3 22 11」这类下标残渣，一个都凑不出来。
    """
    tokens = line.split()
    if not tokens or _CJK_RE.search(line):
        return False
    return not any(_looks_like_word(token) for token in tokens)


def _merge_wrapped_lines(lines: list[str]) -> str:
    """把被 PDF 硬换行切断的段落拼回去。

    空行 = 段落边界（保留）；单个换行 = 硬换行（拼回）。
    中文接中文直接连（「Schrodinger 方\\n程的精确解」→「Schrodinger 方程的精确解」），
    否则补一个空格。
    """
    paragraphs: list[str] = []
    buf = ""
    for line in lines:
        line = line.strip()
        if not line:
            if buf:
                paragraphs.append(buf)
                buf = ""
            continue
        if not buf:
            buf = line
            continue
        if _CJK_RE.search(buf[-1]) and _CJK_RE.match(line[0]):
            buf += line
        else:
            buf += " " + line
    if buf:
        paragraphs.append(buf)
    # 段落之间用空行（\n\n）输出——保证 clean_source_text 幂等：
    # 第二遍重跑时，空行仍被判成段落边界，而不是被当软换行拼回去。
    return "\n\n".join(paragraphs)


def clean_source_text(text: str) -> str:
    """把 PDF 抽取出的原始文本洗成「能当语料原文读」的样子。

    处理四类噪声（全部来自真实库数据的实测）：
      1. 结构标记 [[FIG:fig25]] / [[MATH:f1]] / [[H:3]] —— 阅读器的渲染锚点，
         纯文本里是噪声，剥掉标记、留下标题文字本身；
      2. 私用区/替换符/方块字符 —— 公式字形的残骸，「□」乱码的主来源；
      3. 公式残渣 —— 整行没有可读内容的（「3 3 3 c c c」）丢行，
         行内连续一串孤立单字符的（「求解 3 c c c 取实解」）掐掉那段；
      4. 硬换行 —— 单个换行拼回段落，空行才算段落边界。
    """
    body = _STRUCT_MARK_RE.sub(" ", text or "")
    body = _INVISIBLE_GARBAGE_RE.sub("", body)
    body = _DECOR_RE.sub(" ", body)
    lines: list[str] = []
    for raw_line in body.split("\n"):
        line = _strip_inline_residue(raw_line)
        if line and _is_residue_line(line):
            continue
        lines.append(line)
    return _merge_wrapped_lines(lines)


def _clean(text: str) -> str:
    """抹掉公式与多余空白，让切分与 n-gram 统计都落在真实正文上。"""
    return re.sub(r"[ \t]+", " ", _MATH_NOISE_RE.sub(" ", clean_source_text(text or ""))).strip()

#: 中文虚词与万能动词。它们频次最高却最不值得学，不能当概念锚点。
#: 注意：这里**故意不**过滤「研究/方法/系统/结果」这类学术实词——
#: 它们既是虚词感的万能词，也是中文论文里真实的核心概念，交给模型判断更稳。
_ZH_STOPWORDS = frozenset(
    """
    的 了 和 是 在 有 与 及 对 为 以 中 个 这 那 其 此 之 于 而 且 被 所 从 到
    由 把 使 并 也 还 就 都 又 很 更 最 不 无 未 非 会 能 可 要 将 已 正在 通过
    由于 因此 但是 而且 然而 同时 然后 首先 其次 最后 我们 他们 它们 可以 应该
    需要 进行 存在 出现 表示 说明 认为 提出 给出 得到 成为 属于 关于 对于 以及
    或者 以及 例如 比如 其中 这样 那样 什么 如何 为什么 一个 一种 一些 一般
    主要 重要 不同 相应 直接 有效 基本 一定 非常 十分 比较 较大 较小 较高 较低
    本文 本 该 各 每 若干 多个 大量 少量 上述 如下 以上 以下 之内 之外 之间
    """.split()
)
#: 锚点里不该出现的纯噪声：数字串、单字、页码
_NOISE_TERM_RE = re.compile(r"^[\d\W_]+$")

#: 英文段落切分：空行 > 单换行
_EN_PARA_SPLIT_RE = re.compile(r"\n\s*\n|\n(?=[A-Z(\[])")
#: 中文段落切分
_ZH_PARA_SPLIT_RE = re.compile(r"\n\s*\n|(?<=[。！？；])\s*\n")


# ================================================================ 语言与切分

def detect_lang(text: str) -> str:
    """判断一份资料的主体语言：zh / en / mixed。

    中英混排是知源用户的常态（中文论文夹英文术语），所以不是二分类。
    判据只看比例不看绝对量，短标题之类的边角不影响整份资料的判断。
    """
    body = (text or "").strip()
    if not body:
        return "en"
    zh = len(_CJK_RE.findall(body))
    latin = len(_LATIN_RE.findall(body))
    total = max(1, zh + latin)
    ratio = zh / total
    if ratio >= ZH_RATIO_ZH:
        return "zh"
    if ratio >= ZH_RATIO_MIXED:
        return "mixed"
    return "en"


def split_chunks(text: str, *, size: int = CHUNK_SIZE) -> list[str]:
    """把一份资料切成片段。

    先按段落断（段落是作者划好的语义单位，从这里断最不容易切断意思），
    再把过短的段落往相邻段落合并、过长的一段按字数再切。宁可稍短，
    也不要把两个不相干的意思揉进同一片。
    """
    body = _clean(text)
    if not body:
        return []
    splitter = _ZH_PARA_SPLIT_RE if detect_lang(body) == "zh" else _EN_PARA_SPLIT_RE
    paragraphs = [p.strip() for p in splitter.split(body) if p and p.strip()]
    if not paragraphs:
        paragraphs = [body]

    chunks: list[str] = []
    buffer = ""
    for para in paragraphs:
        # 超长段落：先把 buffer 冲掉，再按 size 硬切
        if len(para) > size * 1.8:
            if buffer:
                chunks.append(buffer)
                buffer = ""
            start = 0
            while start < len(para):
                chunks.append(para[start : start + size])
                start += size
            continue
        if len(buffer) + len(para) + 1 <= size * 1.25:
            buffer = f"{buffer}\n{para}".strip() if buffer else para
        else:
            if buffer:
                chunks.append(buffer)
            buffer = para
    if buffer:
        chunks.append(buffer)
    return [c for c in chunks if len(c.strip()) >= 40]


# ================================================================ 中文：概念锚点

def _context_diversity(body: str, gram: str) -> tuple[int, int]:
    """统计一个候选串左右邻接字符的多样性（分支熵思路的极简版）。

    滑动窗口切出来的 n-gram 里有大量「切错边界」的碎片（「像具有高」
    「声成像具」）。它们的共同特征是：**每次出现的左右邻居都一模一样**——
    说明它不是一个独立的语言单位，只是一个更长固定串被窗口切下来的一段。
    真正的术语（「光致超声」）左右会接不同的字。用这一点区分，代价只是几次 find。
    """
    lefts: set[str] = set()
    rights: set[str] = set()
    start = 0
    size = len(gram)
    while True:
        index = body.find(gram, start)
        if index < 0:
            break
        if index > 0:
            lefts.add(body[index - 1])
        if index + size < len(body):
            rights.add(body[index + size])
        start = index + 1
    return len(lefts), len(rights)


def zh_anchor_terms(text: str, *, limit: int = 12) -> list[str]:
    """从中文片段里抽「概念锚点」——给模型的线索，不是最终术语表。

    做法：在连续中文串上滑 2/3/4-gram 统计词频，去掉虚词、噪声与**边界固定的
    碎片**（见 ``_context_diversity``），再做子串压制（「光致超声成像」频次和
    「光致超声」差不多时，说明后者只是前者的前缀，留长的那个）。

    为什么只做线索：中文术语的边界到底在哪，「光致超声」算一个词还是「光致」+
    「超声」，规则说了不算。规则只负责把明显的高频实词递上去，让模型在完整
    段落里判断——这比让规则硬切要准得多。
    """
    body = _clean(text)
    if not body:
        return []

    counts: dict[str, int] = {}
    for run in _CJK_RUN_RE.findall(body):
        for n in (2, 3, 4):
            if len(run) < n:
                continue
            for i in range(len(run) - n + 1):
                gram = run[i : i + n]
                if gram in _ZH_STOPWORDS or _NOISE_TERM_RE.match(gram):
                    continue
                # 首尾是虚词的 gram 大概率是切错的边界（如「的系」）
                if gram[0] in _ZH_STOPWORDS or gram[-1] in _ZH_STOPWORDS:
                    continue
                counts[gram] = counts.get(gram, 0) + 1

    if not counts:
        return []

    # 只出现一次的串没有统计意义；左右邻居都只有一种的，是窗口切下来的碎片
    usable = {
        gram: count
        for gram, count in counts.items()
        if count >= 2 and _context_diversity(body, gram) != (1, 1)
    }
    if not usable:
        # 短段落里可能没有任何串重复出现两次，那就退回频次榜，交给模型筛
        usable = counts

    ranked = sorted(usable.items(), key=lambda kv: (-kv[1], -len(kv[0]), kv[0]))
    picked: list[tuple[str, int]] = []
    for gram, count in ranked:
        # 子串压制：已有更长且频次接近的候选，就跳过这个短的
        if any(gram in longer and count <= longer_count * 1.35 for longer, longer_count in picked):
            continue
        picked.append((gram, count))
        if len(picked) >= limit:
            break

    # 频次相同时长词优先（「光致超声」优于「超声」），但展示时按频次排
    return sorted((g for g, _ in picked), key=lambda g: -counts[g])[:limit]


# ================================================================ 中文：模型报文

def build_zh_payload(
    chunk: str,
    *,
    anchors: Iterable[str],
    title: str = "",
    domain: str = "",
) -> dict[str, Any]:
    """把一片中文正文拼成给模型的报文。

    要求模型交回两样东西：这段的**英文表述**，以及**核心术语的中英对照**。
    英文表述要忠于原文意思，不是自由发挥的改写——用户是要拿它当精读材料的。
    """
    anchor_list = [a for a in anchors if a][:12]
    return {
        "title": title or "",
        "domain": domain or "",
        "passage": chunk,
        "anchor_terms": anchor_list,
        "instruction": (
            "阅读这段中文（来自用户自己导入的学习资料），产出四样东西：\n"
            "1. english_text：这段内容的**英文表述**。忠于原意、用规范的学术/书面英文，"
            "长度与原文相当，不要扩写也不要写成摘要；专有名词与术语用该领域通行的英文说法。"
            "若原文夹着英文术语，保留它。\n"
            f"2. terms：这段里的核心术语/概念的中英对照，{TERM_RANGE_ZH} 个。"
            "每个 term 给 zh（中文原词）、en（英文表述）、pos（词性，可空）、"
            "gloss（一句话英文释义或搭配提示，控制在 20 个英文词内）。\n"
            "3. gist：一句话英文主旨，不超过 25 个英文词。\n"
            "4. origin_clean：这段内容的**中文整理稿**。原文是从 PDF 抽出来的，"
            "字有缺漏、句子被切断、还夹着公式乱码，用户要拿它当中文对照读，"
            "所以你要把它整理成一段通顺、完整、结构清楚的中文：\n"
            "   - 忠于原意，只补顺句子与缺失的连接，**不得新增原文没有的信息**；\n"
            "   - 公式保留可读写法（如「H = H0 + H'」），认不出来的地方直接略过，"
            "不要留下乱码、占位符或「此处有公式」这类注释；\n"
            "   - 用**空行分段**（一个意思一段）；段落有明确小标题的，"
            "那一行以「# 」开头；\n"
            "   - 纯文本：不要用加粗、列表符号等 Markdown 标记；\n"
            "   - 长度与原文相当（不超过 1.2 倍）。\n"
            "候选锚点只是线索，**以段落实际内容为准**；锚点里没出现的真术语也要给，"
            "锚点里是虚词或不是术语的直接丢掉。\n"
            "只输出 JSON：{\"english_text\": 字符串, \"gist\": 字符串, "
            "\"terms\": [{\"zh\": 字符串, \"en\": 字符串, \"pos\": 字符串, \"gloss\": 字符串}], "
            "\"origin_clean\": 字符串}"
        ),
    }


def normalize_zh_result(parsed: Any, *, chunk: str) -> dict[str, Any] | None:
    """把模型回包洗成能落库的形状。模型不靠谱时返回 None，由调用方跳过。

    拒收条件很硬：没有 english_text，或 english_text 里几乎没有英文
    （说明模型把「英文表述」理解成了「中文总结」），这种片宁可不入库——
    用户拿它当精读材料会被误导。
    """
    if not isinstance(parsed, dict):
        return None
    english = str(parsed.get("english_text") or "").strip()
    if not english or len(_LATIN_RE.findall(english)) < 40:
        return None

    terms: list[dict[str, str]] = []
    raw_terms = parsed.get("terms")
    if isinstance(raw_terms, list):
        seen: set[str] = set()
        for item in raw_terms:
            if not isinstance(item, dict):
                continue
            en = str(item.get("en") or "").strip()
            zh = str(item.get("zh") or "").strip()
            if not en or not zh:
                continue
            key = en.lower()
            if key in seen:
                continue
            seen.add(key)
            terms.append(
                {
                    "zh": zh[:40],
                    "en": en[:80],
                    "pos": str(item.get("pos") or "").strip()[:20],
                    "gloss": str(item.get("gloss") or "").strip()[:200],
                }
            )
    if not terms:
        return None

    return {
        "origin_text": chunk,
        "origin_clean": clean_origin_candidate(parsed.get("origin_clean"), chunk),
        "english_text": english[:4000],
        "gist": str(parsed.get("gist") or "").strip()[:300],
        "terms": terms[:12],
    }


# ================================================================ 英文：客观摘录

def clean_origin_candidate(candidate: Any, chunk: str) -> str:
    """洗一遍模型交回的中文整理稿，不合格就退回规则清洗的原文。

    拒收三条（宁可显示规则清洗的原文，也不显示更糟的东西）：
      - 不是中文（模型把「中文整理稿」理解成了英文总结）；
      - 比原文长出太多（模型借题发挥，违背「不新增信息」的约束）；
      - 比原文短得太多（模型写成摘要了，用户要的是对照全文不是摘要）。
    """
    text = str(candidate or "").strip()
    if not text:
        return ""
    if len(_CJK_RE.findall(text)) < 20:
        return ""
    if len(text) > len(chunk) * 1.35 + 40:
        return ""
    if len(text) < len(chunk) * 0.5:
        return ""
    return clean_source_text(text)[:6000]


def en_rank_paragraphs(
    text: str,
    *,
    lemma_of: Callable[[str], str],
    is_known: Callable[[str], bool],
    entry_of: Callable[[str], dict | None],
) -> list[dict[str, Any]]:
    """给英文资料的段落按「含金量」排个序。

    含金量 = 这段里有几个**你不认识且值得背**的词。全是你认识的词，这段
    读起来顺，没必要当语料；一个生词都没有的低频专有名词堆，也不值得。
    """
    from core import english_vocab as en_vocab  # 局部导入：避免模块加载期的循环依赖

    results: list[dict[str, Any]] = []
    for chunk in split_chunks(text):
        tokens = en_vocab.tokenize(chunk)
        if len(tokens) < MIN_CHUNK_TOKENS:
            continue
        acronyms = en_vocab.acronym_lemmas(tokens)
        hits: dict[str, str] = {}
        for token in tokens:
            lemma = lemma_of(token.lower)
            if not lemma or lemma in acronyms or lemma in hits:
                continue
            if is_known(lemma):
                continue
            if not en_vocab.is_candidate(
                lemma, surface=token.surface, entry=entry_of(lemma), is_known=False
            ):
                continue
            hits[lemma] = token.surface
        if len(hits) < MIN_TERM_HITS:
            continue
        density = len(hits) / max(1, len(tokens))
        # 密度上限只在挡「根本不是散文」的东西：参考文献列表、纯数据表、
        # 公式残渣。专业课正文生词占到三成是常态，卡太死会把最难的那批资料
        # ——恰恰是最该拿来学的——全给滤掉（实测 0.22 会误杀整段学术论文）。
        if density > MAX_UNKNOWN_DENSITY:
            continue
        results.append(
            {
                "origin_text": chunk,
                "english_text": chunk,
                "gist": "",
                "terms": [
                    {"zh": "", "en": surface, "pos": "", "gloss": ""}
                    for lemma, surface in list(hits.items())[:MAX_TERMS_EN]
                ],
                "_score": len(hits),
            }
        )
    results.sort(key=lambda r: -r["_score"])
    return results


# ================================================================ 收录口径
#
# 「一条术语／一段划词能不能进生词本」——全站只认这一处判据。
#
# 为什么单独抽出来：它原先是写在 /api/en/corpus/promote 里的一条正则
# `[a-z][a-z\-']*(?: [a-z][a-z\-']*){0,2}`，把「收录本片全部术语」变成了玄学：
# 实测 126 片语料里有 27 条术语被它**静默丢掉**，而且集中在该学最难词的那几片——
#   Schrödinger equation                    （ö 不属于 [a-z]）
#   Symmetric 1D potential well             （带数字）
#   Optical Coherence Tomography (OCT)      （带括号缩写）
#   square of the angular momentum operator （超过 3 个词）
# 丢了还不说：接口只回一个 added 数字，界面照着「请求里那批」全打成已收，
# 用户看到的就是「点了收录本片全部术语，只收进去一半，剩下那半再也收不了」。
#
# 现在两处都改：判据放宽到真实术语该有的样子 + 收不进去的**点名报原因**，
# 界面只把真收进去的标成已收，没收进去的留在原地还能再试。

#: 一条术语最多允许几个词。中文教材/论文转写出来的术语动辄五六个词
#: （square of the angular momentum operator），卡在 3 个词等于把最该背的
#: 那批术语直接扔掉。上限仍然要有：模型偶尔会把一整句塞进术语位。
MAX_TERM_WORDS = 6
#: lemma 长度上限（同样是挡「整句当术语」）。
MAX_TERM_CHARS = 64

#: 括号里的缩写不是词本身：Optical Coherence Tomography (OCT) → 主体。
_PAREN_RE = re.compile(r"\s*\([^()]*\)")
#: 边角上的标点/引号/斜杠——划词时最容易带进来。
_EDGE_JUNK_RE = re.compile(r"^[\s\-'’\"“”`.,;:!?/\\|\[\]{}]+|[\s\-'’\"“”`.,;:!?/\\|\[\]{}]+$")
#: 词内允许的字符：拉丁字母（含重音 Schrödinger / µm）、希腊字母、数字，
#: 外加连字符、撇号、斜杠、点（16-bit / Planck's / Tx/Rx / Ph.D.）。
_TERM_CHARS = "A-Za-z0-9µÀ-ÿĀ-ſͰ-Ͽ"
_TERM_WORD_RE = re.compile(r"^[" + _TERM_CHARS + r"][A-Za-z0-9µÀ-ÿĀ-ſͰ-Ͽ\-'/.]*$")
#: 至少要有一个真字母：纯数字（2026 / 6050）不是单词。
_TERM_LETTER_RE = re.compile(r"[A-Za-zµÀ-ÿĀ-ſͰ-Ͽ]")


def collectable_lemma(text: str, *, max_words: int = MAX_TERM_WORDS) -> tuple[str, str]:
    """把一条术语／划词整理成可以进生词本的 lemma。

    返回 `(lemma, reason)`：lemma 为空串表示这一条收不进去，reason 是**能直接
    给用户看**的中文原因。调用方（promote / collect）必须把 reason 回传界面——
    静默丢词是「收录本片全部术语收不全」的根源。

    整理顺序是有讲究的：先去括号缩写、再去边角标点，最后才判字符。顺序反了
    会把「(OCT)」判成空、把「OCT.」判成不合法。
    """
    raw = str(text or "").strip()
    if not raw:
        return "", "这一条是空的。"

    # 全角/排版字符归一：中文排版里的乘号、弯撇号
    body = raw.replace("’", "'").replace("×", "x").replace("✕", "x")

    stripped = _PAREN_RE.sub(" ", body).strip()
    if len(stripped) >= 2:
        body = stripped
    else:
        # 整条就只剩个括号缩写（(OCT)）：取括号里的东西，还是没有就认收不了
        inner = re.sub(r"[()]", " ", body).strip()
        if len(inner) < 2:
            return "", f"「{raw}」不是能背的英文词或搭配。"
        body = inner

    body = _EDGE_JUNK_RE.sub("", body)
    body = re.sub(r"\s+", " ", body).strip().lower()
    if body.endswith("'s"):
        body = body[:-2]  # Planck's → planck（与 english_vocab.normalize_token 同口径）
    body = body.strip("-'")
    if not body:
        return "", f"「{raw}」不是能背的英文词或搭配。"

    words = body.split(" ")
    if len(words) > max_words:
        return "", (
            f"「{raw}」有 {len(words)} 个词，超过 {max_words} 个词的搭配就不当单词收了"
            "（在正文里划词选中要背的那一段就行）。"
        )
    if len(body) > MAX_TERM_CHARS:
        return "", f"「{raw}」太长了，划词选中要背的那一段再收。"
    for word in words:
        if not _TERM_WORD_RE.match(word):
            return "", f"「{raw}」里有不是英文单词的成分，划词选中要背的那一段再收。"
    if not _TERM_LETTER_RE.search(body):
        return "", f"「{raw}」里没有英文字母。"
    return body, ""


# ================================================================ 落库形状

def excerpt_row(
    *,
    owner_id: str,
    source_id: str,
    source_title: str,
    lang: str,
    ordinal: int,
    item: dict[str, Any],
) -> dict[str, Any]:
    """把一条摘录压成 en_corpus_excerpts 的一行。"""
    return {
        "owner_id": owner_id,
        "source_id": source_id,
        "source_title": source_title,
        "lang": lang,
        "ordinal": ordinal,
        "origin_text": str(item.get("origin_text") or "")[:6000],
        "origin_clean": str(item.get("origin_clean") or "")[:6000],
        "english_text": str(item.get("english_text") or "")[:6000],
        "gist": str(item.get("gist") or "")[:300],
        "terms_json": json.dumps(item.get("terms") or [], ensure_ascii=False),
    }
