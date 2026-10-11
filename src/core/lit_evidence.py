# -*- coding: utf-8 -*-
"""文献「相关原文」定位：把正文切成可读的证据段 → 逐段打分 → 折算相对置信度。

做法复刻自 PaperFocus（github.com/YiLight0/paperfocus，MIT），落到知源**已有的**
文字层上（``core/pages.py`` 的 ``text_layer``：行级 bbox，单位是 PDF 点）：

    文字层行 → 合并成「证据段」（带页码 + bbox）→ 模型逐段打 0~3 分 → 相对置信度

为什么不能直接用文字层的行：
  行是排版单位（一行 40 个字符），段才是语义单位。把同栏相邻的行合并成段之后，
  喂给模型的是完整的一句话或一段论证；定位回来时 bbox 也正好盖住整段，
  点列表就能在原文页上框出那一段，不用再做一次模糊文本匹配。

为什么不该把整篇论文丢给模型一次问完：
  那样拿不到「哪几段相关」——只有一段散文。分段的第二个理由是可并行：
  前端提问时 N 批一起打，耗时从「读完一遍全文」降到「跑完一批」。

**相对置信度不是概率**：它只说明「这一次提问里，这段比其它段更值得读」。
最相关的一段记 100%，其余按名次与分差逐级降低。同一段 0 分内容，在只有 3 个候选时
和 200 个候选时拿到的百分数不同 —— 这是刻意的，别把它当成模型校准过的正确率。
"""

from __future__ import annotations

import re

# 单独的「参考文献 / References」标题行：见到它之后的内容一律不进候选。
# 允许标题带尾巴（Science 的 "References and Notes"、中文的「参考文献与注释」），
# 所以是「以它开头 + 整行很短」而不是全等 —— 正文里出现 "References show that..."
# 的句子都长于这个上限，不会被误判。页眉里的跑眉已被 pages._run_head_line 提前滤掉。
REF_HEAD = re.compile(
    r"^\s*(?:references|bibliography|参考文献|参考资料|致\s*谢|acknowledg\w*)"
    r"\s*(?:and\s+\w+|与\s*\w+)?\s*[:：]?\s{0,3}$",
    re.I,
)
REF_HEAD_MAX = 56  # REF_HEAD 只认短行，超长的当正文处理

# 同一段内相邻两行之间允许的最大垂直空隙（PDF 点）。
# 这个值必须按「最松的排版」留余量：实测同一批论文里，行距紧的（Science 双栏）
# 行间空隙只有 2.6pt，行距松的能到 7.3pt —— 卡 6.5 会让后者每行各成一段
# （2026-10-11 实测：一副 6 页论文切出 101 段，其中 59 段不足 60 字）。
# 而换段的空隙 ≥ 行距 + 段间距，通常 ≥ 15pt，9.0 仍留 6pt 余量，不会把两段并起来。
LINE_GAP = 9.0
# 与上一行的横向重叠度低于此值 → 换栏（双栏论文左右栏各成一段）。
X_OVERLAP = 0.5
# 按左边缘聚栏的容差（页宽的 5%，最小 6pt）：同一栏的行左边缘几乎重合。
COL_TOL = 0.05
# 单段长度上下限（字符）。太短的（表格碎片、轴标注）丢掉；
# 太长的按句号就近切开，保证每次打分喂进去的是一段而不是一整页。
MIN_UNIT_CHARS = 40
MAX_UNIT_CHARS = 900
# 候选段上限。超了就靠放大 MAX_UNIT_CHARS 把段合并得更粗，而不是砍掉后面的章节 ——
# 砍尾巴等于「结果章永远搜不到」，比结果粗一点严重得多。
MAX_UNITS = 120
_HARD_MAX_CHARS = 6000
# 一批送多少段给模型（段数 × 总字符双上限）。这是耗时的唯一旋钮：
# 批数 = 候选段数 / BATCH_UNITS，4 路并行跑完。
BATCH_UNITS = 20
BATCH_CHARS = 12000

_SENT_END = "。！？；.!?;"


def _overlap_ratio(a: list[float], b: list[float]) -> float:
    """两个 bbox 的横向重叠度（除以较窄的那个宽度）。"""
    wa = max(1e-6, a[2] - a[0])
    wb = max(1e-6, b[2] - b[0])
    inter = min(a[2], b[2]) - max(a[0], b[0])
    if inter <= 0:
        return 0.0
    return inter / min(wa, wb)


def _column_anchors(lines: list[dict], page_w: float) -> tuple[list[float], float]:
    """找出这一页的「栏左边缘」候选。

    判据是**频次**而不是相邻间距：同一栏的正文行几乎共用同一个 x0，一条栏会在
    页内出现几十次；而图注、轴标注、居中小标题这些的 x0 是零星散落的。
    只按 x0 排序后「相邻差距不超过容差就并簇」会**串**起来 —— 左栏(36.9)与
    右栏(214.9)之间只要夹杂几行 x0 落在中间的行，就会一路被链成一个簇，
    分栏等于没做（2026-10-11 实测：一篇 3 栏论文因此 93 行挤进同一簇）。

    返回 ``(anchors, tol)``。``anchors`` 为空表示这页看不出栏结构。
    """
    tol = max(6.0, page_w * COL_TOL) if page_w > 0 else 6.0
    counts: dict[float, int] = {}
    for line in lines:
        key = round(float(line["bbox"][0]))
        counts[key] = counts.get(key, 0) + 1
    need = max(2, int(len(lines) * 0.03))
    anchors: list[float] = []
    for value in sorted(k for k, c in counts.items() if c >= need):
        if anchors and value - anchors[-1] <= tol:
            continue  # 和上一根锚点同属一栏（缩进/首行缩排），保留靠左的那根
        anchors.append(float(value))
    return anchors, tol


def _ordered_lines(lines: list[dict], page_w: float) -> list[dict]:
    """把一页的文字层行排成「先左栏读完、再读右栏」的阅读顺序。

    pymupdf 给的 block 顺序是内容流顺序，双栏 PDF 里既不保证按栏读完再读下一栏，
    直接合并会把左栏第一行和右栏第一行并进同一段，于是每一行都成了独立的一段。

    不用 pages.py 的 ``_detect_single_column``：那个判据是「整页存在一条横跨左右边距的行」，
    只在公式区域检测那个语境下成立。论文首页的**大标题和摘要都是通栏**，
    于是它会把一个标准双栏正文页判成单栏 —— 实测一篇 6 页论文因此切出 270 段
    （中位数 46 字，即「一行一段」），完全丧失了段落语义。

    这里改用「栏左边缘锚点」（见 ``_column_anchors``）：每行归属到最近的锚点，
    先按锚点从左到右、再按 y。通栏标题的左边缘恰好等于左栏左边缘，
    会落进左栏且 y 最小，自然排在左栏最前 —— 正是想要的顺序。
    """
    if not lines:
        return []
    anchors, _tol = _column_anchors(lines, page_w)
    if len(anchors) < 2:
        return sorted(lines, key=lambda it: (it["bbox"][1], it["bbox"][0]))

    def column_of(line: dict) -> int:
        x0 = float(line["bbox"][0])
        return min(
            range(len(anchors)),
            key=lambda i: (abs(anchors[i] - x0), anchors[i]),
        )

    return sorted(
        lines, key=lambda it: (column_of(it), it["bbox"][1], it["bbox"][0])
    )


def _split_long(text: str, limit: int) -> list[str]:
    """超长段落按句末标点在 limit 附近切开，切不动就硬切。"""
    if len(text) <= limit:
        return [text]
    parts: list[str] = []
    rest = text
    while len(rest) > limit:
        window = rest[:limit]
        cut = max(window.rfind(ch, int(limit * 0.6)) for ch in _SENT_END)
        cut = cut + 1 if cut > 0 else limit
        parts.append(rest[:cut].strip())
        rest = rest[cut:].strip()
    if rest:
        parts.append(rest)
    return [p for p in parts if p]


def _page_units(page_meta: dict, max_chars: int) -> tuple[list[tuple[str, list[float]]], bool]:
    """一页文字层 → ``([(段文本, 段 bbox)], 是否撞上参考文献标题)``。

    bbox 是段内所有行的并集，PDF 点坐标。

    参考文献标题必须在**逐行**这一层判：它自己那一行既短又没有句末标点，
    先和下面的条目合并成段就再也匹配不上 ``^...$`` 了 —— 结果是把整段参考文献
    当成正文候选送进模型（2026-10-11 自检抓到的就是这个）。
    """
    lines = [it for it in (page_meta.get("text_layer") or []) if (it.get("text") or "").strip()]
    if not lines:
        return [], False
    out: list[tuple[str, list[float]]] = []
    buf: list[str] = []
    box: list[float] | None = None
    prev: list[float] | None = None
    hit_refs = False

    def flush() -> None:
        nonlocal buf, box
        if buf and box:
            text = " ".join(buf).strip()
            if len(text) >= MIN_UNIT_CHARS:
                out.append((text, list(box)))
        buf = []
        box = None

    for line in _ordered_lines(lines, float(page_meta.get("w") or 0)):
        bb = [float(v) for v in line["bbox"]]
        txt = str(line["text"]).strip()
        if REF_HEAD.match(txt) and len(txt) <= REF_HEAD_MAX:
            flush()
            hit_refs = True
            break
        joined = len(" ".join(buf)) if buf else 0
        continues = (
            prev is not None
            and _overlap_ratio(prev, bb) >= X_OVERLAP
            and 0 <= bb[1] - prev[3] <= LINE_GAP
            and joined + len(txt) <= max_chars
        )
        if not continues:
            flush()
        buf.append(txt)
        box = bb if box is None else [
            min(box[0], bb[0]),
            min(box[1], bb[1]),
            max(box[2], bb[2]),
            max(box[3], bb[3]),
        ]
        prev = bb
    flush()
    return out, hit_refs


def build_units(pages: list[dict], max_units: int = MAX_UNITS) -> list[dict]:
    """pages_meta 的 ``pages`` → 证据段列表。

    每个证据段：``{"id", "page", "text", "bbox"}``，``page`` 是 **0 基**页序号
    （与前端 ``store.originalPage`` / ``goToOrigPage`` 同一口径），
    ``bbox`` 是 ``[x0, y0, x1, y1]``（PDF 点，72dpi），交给原页视图当定位框。

    候选段数超过 ``max_units`` 时**把段合并得更粗**再重来，而不是砍掉后面的章节 ——
    砍尾巴等于「结果章永远搜不到」，比给模型的段粗一点严重得多。
    """
    max_chars = MAX_UNIT_CHARS
    while True:
        units: list[dict] = []
        in_refs = False
        for page_meta in pages:
            if in_refs:
                break
            page_no = int(page_meta.get("page") or 0)
            page_units, hit_refs = _page_units(page_meta, max_chars)
            for text, bbox in page_units:
                for piece in _split_long(text, max_chars):
                    units.append(
                        {
                            "id": "u%04d" % len(units),
                            "page": page_no,
                            "text": piece,
                            "bbox": bbox,
                        }
                    )
            in_refs = hit_refs
        if len(units) <= max_units or max_chars >= _HARD_MAX_CHARS:
            return units
        max_chars = int(max_chars * 1.5)


def plan_batches(
    units: list[dict], batch_units: int = BATCH_UNITS, batch_chars: int = BATCH_CHARS
) -> list[list[dict]]:
    """按「段数 + 总字符」两个上限把证据段分批。顺序不变，不丢段。"""
    batches: list[list[dict]] = []
    current: list[dict] = []
    chars = 0
    for unit in units:
        size = len(unit.get("text") or "")
        if current and (len(current) >= batch_units or chars + size > batch_chars):
            batches.append(current)
            current = []
            chars = 0
        current.append(unit)
        chars += size
    if current:
        batches.append(current)
    return batches


def coerce_scores(raw: object, ids: list[str]) -> dict[str, int]:
    """从模型输出里取 {id: 0~3}，越界/缺失/非整数的段一律按 0 分。

    宁可把一段判成 0（它只是不出现在列表里），也不要让一次畸形输出掀翻整次提问。
    """
    table = raw.get("scores") if isinstance(raw, dict) else None
    if not isinstance(table, dict):
        return {uid: 0 for uid in ids}
    out: dict[str, int] = {}
    for uid in ids:
        value = table.get(uid)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            out[uid] = 0
            continue
        out[uid] = max(0, min(3, int(value)))
    return out


def salience_map(scores: dict[str, int]) -> dict[str, int]:
    """0~3 分 → 相对置信度（0~100 的整数）。公式与 PaperFocus 逐项一致。

    三件事叠在一起：
    1. ``rank_part``：名次项，按 ``(1-名次/总数)^4.2`` 衰减 —— 指数 4.2 让第 2 名
       就掉得很快，列表天然收成「少数几条」；
    2. ``gap_part``：分差项，把最高分与最低分之间线性铺开 —— 全是 3 分时它退化成名次项，
       全是 0 分时同理，不会出现除零；
    3. 最后 ``x^0.415`` 把指数压出来的低值抬起来，让 20% 和 40% 在观感上拉得开。

    同分段的顺序按 id 升序（即原文顺序），保证同一篇论文同样的问题给出同样的百分数。
    """
    if not scores:
        return {}
    ranked = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))
    count = len(ranked)
    highest = ranked[0][1]
    lowest = ranked[-1][1]
    out: dict[str, int] = {}
    for rank, (uid, score) in enumerate(ranked):
        rank_base = 1.0 if count <= 1 else (count - 1 - rank) / (count - 1)
        rank_part = 100.0 * (rank_base ** 4.2)
        gap_part = (
            rank_part
            if highest == lowest
            else 100.0 * (score - lowest) / (highest - lowest)
        )
        raw = rank_part * 0.9 + gap_part * 0.1
        out[uid] = 0 if raw <= 0 else round(100.0 * ((raw / 100.0) ** 0.415))
    return out


def _self_check() -> None:
    """纯函数自检：合并成段、分栏、超长切分、分批、置信度单调性。"""
    # 1) 同栏相邻行应合并成一段，段间距过大则断开
    pages = [
        {
            "page": 0,
            "w": 600.0,
            "h": 800.0,
            "text_layer": [
                {"text": "这是第一行的正文内容，长度足够通过最小长度阈值这一关。", "bbox": [50, 100, 550, 112]},
                {"text": "这是第二行的正文内容，和上一行同栏且紧挨着，应当被并进同一段。", "bbox": [50, 114, 550, 126]},
                {"text": "这是第三行的正文内容，仍然和上一行同栏且紧挨着。", "bbox": [50, 128, 550, 140]},
                {"text": "这是另外一段的开头一行，和上面隔了很远，应当单独成段。", "bbox": [50, 200, 550, 212]},
                {"text": "这是另外一段的第二行，同样应当被并进这第二段里。", "bbox": [50, 214, 550, 226]},
            ],
        }
    ]
    units = build_units(pages)
    assert len(units) == 2, units
    assert units[0]["bbox"] == [50.0, 100.0, 550.0, 140.0], units[0]["bbox"]
    assert units[0]["page"] == 0 and units[0]["id"] == "u0000"
    assert len(units[0]["text"]) > len(units[1]["text"]), units
    # 不足 MIN_UNIT_CHARS 的段落被丢掉
    short = build_units([
        {"page": 0, "w": 600.0, "h": 800.0, "text_layer": [
            {"text": "太短", "bbox": [50, 100, 550, 112]},
        ]},
    ])
    assert short == [], short

    # 2) 双栏：左栏两行 + 右栏两行，排序后必须按栏读完再读下一栏
    two_col = [
        {"text": "左栏第一行的正文内容", "bbox": [40, 100, 290, 112]},
        {"text": "右栏第一行的正文内容", "bbox": [310, 100, 560, 112]},
        {"text": "左栏第二行的正文内容", "bbox": [40, 114, 290, 126]},
        {"text": "右栏第二行的正文内容", "bbox": [310, 114, 560, 126]},
    ]
    ordered = _ordered_lines(two_col, 600.0)
    assert [it["text"][:2] for it in ordered] == ["左栏", "左栏", "右栏", "右栏"], ordered

    # 2b) 通栏大标题 + 双栏正文：标题左边缘等于左栏左边缘，应排在左栏最前
    titled = [
        {"text": "一个通栏的大标题", "bbox": [40, 40, 560, 56]},
        {"text": "左栏正文", "bbox": [40, 100, 290, 112]},
        {"text": "右栏正文", "bbox": [310, 100, 560, 112]},
        {"text": "左栏正文二", "bbox": [40, 114, 290, 126]},
        {"text": "右栏正文二", "bbox": [310, 114, 560, 126]},
    ]
    assert [it["text"] for it in _ordered_lines(titled, 600.0)] == [
        "一个通栏的大标题",
        "左栏正文",
        "左栏正文二",
        "右栏正文",
        "右栏正文二",
    ], _ordered_lines(titled, 600.0)

    # 2b2) 锚点靠频次而不是相邻间距：中间夹几行零散 x0，不得把两栏链成一簇
    bridged = titled + [
        {"text": "零散中间行一", "bbox": [190, 130, 290, 142]},
        {"text": "零散中间行二", "bbox": [195, 144, 290, 156]},
    ]
    got_bridged = [it["text"] for it in _ordered_lines(bridged, 600.0)]
    assert got_bridged.index("右栏正文") > got_bridged.index("左栏正文二"), got_bridged

    # 2c) 单栏：所有行左边缘一致 → 纯按 y 排
    single = [
        {"text": "第一", "bbox": [40, 100, 560, 112]},
        {"text": "第二", "bbox": [40, 114, 560, 126]},
    ]
    assert [it["text"] for it in _ordered_lines(single, 600.0)] == ["第一", "第二"]

    # 2d) 双栏正文真的能合并成段（左栏两行接在一起）
    two_col_long = [
        {"text": "左栏第一行的正文内容足够长才能通过最小长度阈值", "bbox": [40, 100, 290, 112]},
        {"text": "右栏第一行的正文内容也足够长但属于另一栏", "bbox": [310, 100, 560, 112]},
        {"text": "左栏第二行紧接着上一行应当被并进同一段", "bbox": [40, 114, 290, 126]},
        {"text": "右栏第二行紧接着上一行应当被并进同一段", "bbox": [310, 114, 560, 126]},
    ]
    got = build_units([{"page": 3, "w": 600.0, "h": 800.0, "text_layer": two_col_long}])
    assert len(got) == 2, got
    assert got[0]["page"] == 3 and "左栏第一行" in got[0]["text"] and "左栏第二行" in got[0]["text"]
    assert got[1]["bbox"][0] == 310.0, got[1]["bbox"]

    # 3) 参考文献标题之后的内容不再进候选
    body_line = "正文段落内容" * 8  # 48 字，稳过 MIN_UNIT_CHARS
    ref_line = "假装是参考文献的条目内容" * 4
    refs = [
        {"page": 0, "w": 600.0, "h": 800.0, "text_layer": [
            {"text": body_line, "bbox": [50, 100, 550, 112]},
        ]},
        {"page": 1, "w": 600.0, "h": 800.0, "text_layer": [
            {"text": "References", "bbox": [50, 100, 200, 112]},
            {"text": ref_line, "bbox": [50, 114, 550, 126]},
        ]},
    ]
    got_refs = build_units(refs)
    assert len(got_refs) == 1 and got_refs[0]["page"] == 0, got_refs

    # 4) 超长段按句号切开，且尽量在 limit 附近切
    long_text = "。".join(["这是一句用来测试切分逻辑的句子"] * 200) + "。"
    pieces = _split_long(long_text, 300)
    assert len(pieces) > 1 and all(len(p) <= 320 for p in pieces), [len(p) for p in pieces]

    # 5) 分批：段数上限与字符上限各自生效
    fake = [{"id": "u%04d" % i, "page": 0, "text": "x" * 100, "bbox": [0, 0, 1, 1]} for i in range(40)]
    got = plan_batches(fake, batch_units=16, batch_chars=14000)
    assert [len(b) for b in got] == [16, 16, 8], [len(b) for b in got]
    assert sum(len(b) for b in got) == 40
    got = plan_batches(fake, batch_units=99, batch_chars=250)
    assert all(sum(len(u["text"]) for u in b) <= 250 for b in got[:-1]), [len(b) for b in got]

    # 6) 置信度：单调不增、满分给 100、0 分不拿 100
    scores = {"u0000": 3, "u0001": 3, "u0002": 2, "u0003": 1, "u0004": 0}
    sal = salience_map(scores)
    assert sal["u0000"] == 100, sal
    assert sal["u0000"] >= sal["u0001"] >= sal["u0002"] >= sal["u0003"] >= sal["u0004"], sal
    assert 0 <= sal["u0004"] < sal["u0003"], sal
    # 全 0 分时最高分仍应非零（否则用户把阈值一降还是空列表）
    flat = salience_map({k: 0 for k in scores})
    assert flat["u0000"] > 0 and flat["u0000"] >= flat["u0004"], flat
    # 单条候选独占 100%
    assert salience_map({"u0000": 0}) == {"u0000": 100}
    assert salience_map({}) == {}
    # 越界与缺失一律按 0 分
    assert coerce_scores({"scores": {"u0000": 5, "u0001": "2"}}, ["u0000", "u0001", "u0002"]) == {
        "u0000": 3,
        "u0001": 0,
        "u0002": 0,
    }
    print("lit_evidence self-check passed")


if __name__ == "__main__":
    _self_check()
