"""Acrobat-mode page primitives (S1).

Pure, headless-testable helpers that turn a PDF into *page-as-image + text-layer*
for faithful reading where formulas are never re-rendered from reconstructed LaTeX.

Design decisions:
- ``pdf_text_layer`` returns the PDF's built-in text layer (selectable words/lines).
- For scanned PDFs the caller provides OCR lines (from the existing RapidOCR path,
  coordinates already normalized to page units); ``label_formula_regions`` then runs
  the same coordinate logic on that source.
- Formulas are only *located as bboxes* here — never rebuilt into LaTeX.
"""
from __future__ import annotations

import re

import pymupdf

_RUN_HEAD_RE = re.compile(
    r"(^\s*(\d{1,4}\s+)?(www\.[^\s]+|doi\s*[:：]|http[s]?://)|^\s*(-\s*)?(第?\s*\d+\s*页|page\s*\d+|卷\s*\d+)\s*$|^\s*\d{1,2}\s*$)",
    re.I,
)


def _run_head_line(txt: str) -> bool:
    """识别常见页眉/页脚行（页码、域名、doi、卷期）。"""
    if not txt or len(txt) > 64:
        return False
    if _RUN_HEAD_RE.search(txt):
        return True
    return False


def pdf_page_count(data: bytes) -> int:
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        return len(doc)


def pdf_page_size(data: bytes, page_idx: int) -> tuple[float, float]:
    """返回 (page_w, page_h)，均为 PDF 点坐标。"""
    idx = max(0, min(page_idx, pdf_page_count(data) - 1))
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        page = doc.load_page(idx)
        return page.rect.width, page.rect.height


def rasterize_page(
    data: bytes, page_idx: int, dpi: int = 170, path: str | None = None
) -> bytes:
    """把某一页栅格化为 PNG。返回 PNG bytes；给定 path 时同时落盘。"""
    idx = max(0, min(page_idx, pdf_page_count(data) - 1))
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        page = doc.load_page(idx)
        pix = page.get_pixmap(matrix=pymupdf.Matrix(dpi / 72.0, dpi / 72.0), alpha=False)
        png = pix.tobytes("png")
    if path:
        with open(path, "wb") as f:
            f.write(png)
    return png


def rasterize_crop(
    data: bytes, page_idx: int, bbox: list[float], dpi: int = 300, path: str | None = None
) -> bytes:
    """按页面坐标 bbox=[x0,y0,x1,y1] 裁切某一区域为高清 PNG（公式放大用）。

    坐标单位是 PDF 点（pt，72dpi），直接喂给 pymupdf 的 clip。
    """
    idx = max(0, min(page_idx, pdf_page_count(data) - 1))
    x0, y0, x1, y1 = [float(v) for v in bbox]
    if x1 <= x0 or y1 <= y0:
        raise ValueError("invalid bbox")
    # clip 直接用原坐标；dpi 通过 matrix 放大像素
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        page = doc.load_page(idx)
        # bbox 钳制到页面范围内：越界 clip（负坐标/超出页宽高）会导致渲染失败 → 前端整幅图加载失败
        rect = page.rect
        cx0 = max(rect.x0, min(x0, rect.x1))
        cy0 = max(rect.y0, min(y0, rect.y1))
        cx1 = max(rect.x0, min(x1, rect.x1))
        cy1 = max(rect.y0, min(y1, rect.y1))
        if cx1 - cx0 < 1 or cy1 - cy0 < 1:
            # 裁剪区域完全在页面外：退化为整页
            cx0, cy0, cx1, cy1 = rect.x0, rect.y0, rect.x1, rect.y1
        pix = page.get_pixmap(
            matrix=pymupdf.Matrix(dpi / 72.0, dpi / 72.0),
            clip=pymupdf.Rect(cx0, cy0, cx1, cy1),
            alpha=False,
        )
        png = pix.tobytes("png")
    if path:
        with open(path, "wb") as f:
            f.write(png)
    return png


def pdf_text_layer(
    data: bytes, page_idx: int
) -> list[dict]:
    """返回该页内置文本层的行：``[{bbox, text, kind}]``（过滤页眉/页脚）。"""
    idx = max(0, min(page_idx, pdf_page_count(data) - 1))
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        return _text_lines_from_page(doc.load_page(idx))


def _text_lines_from_page(page) -> list[dict]:
    """从已打开的 pymupdf 页对象提取文本层行（过滤页眉/页脚），供批量建页复用。"""
    out: list[dict] = []
    for block in page.get_text("dict").get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            txt = "".join(s.get("text", "") for s in line.get("spans", [])).strip()
            if not txt or _run_head_line(txt):
                continue
            bb = [float(v) for v in line.get("bbox", (0, 0, 0, 0))]
            out.append({"bbox": bb, "text": txt, "kind": "text"})
    return out


def _build_one_page(page, page_idx: int, text_pdf: bool) -> dict:
    """从已打开的页对象构建单页元数据（尺寸 + 文本层 + 公式区域，坐标 only）。"""
    w, h = page.rect.width, page.rect.height
    tl: list[dict] = []
    regs: list[dict] = []
    if text_pdf:
        tl = _text_lines_from_page(page)
        rows = [(it["text"], it["bbox"]) for it in tl]
        page_w = max((bb[2] for _, bb in rows), default=1)
        regs = _label_formula_regions_from_rows(rows, page_w, page_idx)
    return {"page": page_idx, "w": w, "h": h, "text_layer": tl, "formula_regions": regs}


def build_pages_meta(data: bytes) -> dict:
    """单次打开 PDF 一次性构建全部页元数据（尺寸 + 文本层 + 公式区域坐标）。

    原实现逐页调用 ``pdf_page_size``／``pdf_text_layer``／``label_formula_regions``，
    每个函数都会重新打开文件（每页解析 3~4 次）；这里只在一次 ``open`` 内遍历全部页，
    大幅缩短大文件（成百上千页）的 ``/pages`` 构建耗时，从而加快原页视图的首屏渲染。
    返回 ``{"n", "is_scanned", "pages"}``，单页结构同 ``/pages`` 接口。
    """
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        n = len(doc)
        text_pdf = False
        if n > 0:
            text_pdf = bool(_text_lines_from_page(doc.load_page(0)))
        pages = [_build_one_page(doc.load_page(i), i, text_pdf) for i in range(n)]
    return {"n": n, "is_scanned": not text_pdf, "pages": pages}


# ---- formula number token & naive bbox locator (coordinates only) ----

def _number_token(txt: str) -> str | None:
    """纯公式编号 token（（7）/(10)/5.4a/(2.1)）→ 数字串，否则 None。

    编号都极短（≤2 段数字，可带一个字母尾缀）；坐标轴整行刻度去空格后
    会连成超长数字串（如 ``1803.58.5``），用长度与分隔符数量排除。
    """
    t = re.sub(r"[\s\u00a0]+", "", txt or "")
    m = re.fullmatch(r"[\(（]?(\d+(?:[,，.]\d+)*[a-zA-Z]?)[\)）]?", t)
    if not m or not re.search(r"\d", m.group(1)):
        return None
    label = m.group(1)
    if len(label) > 6 or len(re.findall(r"[,，.]", label)) > 1:
        return None
    return label


def _looks_like_year(label: str) -> bool:
    """参考文献里的（2019）年份误作公式编号 → 排除 4 位年份。"""
    return bool(re.fullmatch(r"(19|20)\d{2}", label or ""))


def label_formula_regions(
    data: bytes, page_idx: int, ocr_lines: list[tuple[str, list[float]]] | None = None
) -> list[dict]:
    """标注该页的带编号显示公式区域（坐标 only，不做 LaTeX 重建）。

    - ``ocr_lines`` 提供时使用它作为文本源（扫描件场景，坐标已归一）；否则用内置文本层。
    - 逻辑：先找（N）编号行，再向左/上下吸纳同一公式的非正文行，返回
      ``[{bbox, label, page}]``。返回空列表表示本页无可置信的带编号公式。
    """
    lines: list[tuple[str, list[float]]]
    page_w: float
    if ocr_lines:
        lines = [(t or "", [float(v) for v in bb]) for t, bb in ocr_lines]
        page_w = max((bb[2] for _, bb in lines), default=1)
    else:
        tl = pdf_text_layer(data, page_idx)
        lines = [(it["text"], it["bbox"]) for it in tl]
        page_w = max((bb[2] for _, bb in lines), default=1)
    return _label_formula_regions_from_rows(lines, page_w, page_idx)


def _number_token_at_edge(txt: str, bb: list[float], col_right: float) -> str | None:
    """行文本是「公式编号」且位于所在栏右缘时返回编号，否则 None。

    矩阵行（``0 0.921``）、定界符乱码（``66664``）等纯数字 token 也会命中
    ``_number_token``，但它们不会贴着栏右缘；公式编号（(4)/(9)/(2.1)）几乎总是
    排在栏最右侧。用位置过滤避免把矩阵行误判为编号（误判会导致其成为硬墙、
    把同一公式的矩阵主体拦在区域外，裁出碎片图）。
    """
    label = _number_token(txt)
    if not label or _looks_like_year(label):
        return None
    if bb[2] < col_right - 30.0:
        return None
    return label


def _detect_single_column(rows: list[tuple[str, list[float]]], flush: list[float]) -> bool:
    """整页是否存在横跨左右边距的整行 → 单栏排版。

    真·双栏论文的行不会跨过栏间中缝；存在任一「左起左缘、右抵右缘」的行
    （典型如整段正文）即判定为单栏。单栏时不再按 x 中点拆栏——否则公式左半
    片段（右边缘落在中点左侧）会被误认为属于另一栏而被整体丢弃，裁出半截公式。
    """
    if not flush or flush[1] <= flush[0]:
        return True
    span = flush[1] - flush[0]
    lo, hi = flush[0] + span * 0.05, flush[1] - span * 0.05
    for _, bb in rows:
        if bb[0] <= lo and bb[2] >= hi:
            return True
    return False


def _label_formula_regions_from_rows(
    lines: list[tuple[str, list[float]]],
    page_w: float,
    page_idx: int,
) -> list[dict]:
    """与 ``label_formula_regions`` 相同的吸纳逻辑，但直接消费已提取的行序列。

    供「单次打开 PDF 批量建页」路径复用，避免每页多次重复解析文件。
    """
    region_rows: list[tuple[str, list[float]]] = []
    for txt, bb in lines:
        t = txt.strip()
        if not t or _run_head_line(t):
            continue
        region_rows.append((t, [float(v) for v in bb]))

    if not region_rows:
        return []
    flush = _detect_flush(region_rows)
    single_col = _detect_single_column(region_rows, flush)
    mid = (flush[0] + flush[1]) / 2 if flush else 0.0

    def col_of(bb: list[float]) -> float:
        if single_col:
            return flush[0]
        return _column_left(bb[2], flush)

    def col_right_of(bb: list[float]) -> float:
        """该行所在栏的右边缘（编号位置过滤用）。"""
        if single_col:
            return flush[1]
        return flush[1] if _column_left(bb[2], flush) != flush[0] else mid

    targets: list[tuple[list[float], str]] = []
    for txt, bb in region_rows:
        label = _number_token_at_edge(txt, list(bb), col_right_of(list(bb)))
        if label and not _run_head_line(txt):
            targets.append((list(bb), label))
    if not targets:
        return []

    out: list[dict] = []
    GAP = 6.0  # 同一公式块内相邻行的最大垂直空隙；堆叠公式块间自然行距(~8pt+)不会被桥接
    PAD = 20.0  # 公式右边缘/编号左边缘的横向容差
    page_b = max((bb[3] for _, bb in region_rows), default=1e9)
    for num_bb, label in targets:
        col = col_of(num_bb)
        region = [float(v) for v in num_bb]

        # 从编号行右下角为核心，把同栏、横向落在编号窗口内的行分为两类：
        #   barrier_rows —— 正文/说明/页眉/其他编号行，作为上、下两个方向的硬墙；
        #   cand_rows   —— 真正的公式片段token，只在两堵墙之间吸收。
        barrier_rows: list[tuple[str, list[float]]] = []
        cand_rows: list[list[float]] = []
        for txt, bb in region_rows:
            rbb = [float(v) for v in bb]
            if rbb == num_bb:
                continue
            if col_of(rbb) != col:
                continue
            if rbb[2] > num_bb[2] + PAD:
                continue
            # 其他编号行（必须同样贴栏右缘，排除矩阵数字行）：另一条公式的右角标，不得并入
            is_num = _number_token_at_edge(txt, rbb, col_right_of(rbb)) is not None
            if (
                is_num
                or _is_flush(rbb, flush)
                or _is_prose(rbb, page_w)
                or _has_explanation_cjk(txt)
                or _is_decorative_label(txt)  # 期刊跑眉/章节小标题等装饰性文字
            ):
                barrier_rows.append((txt, rbb))
            else:
                cand_rows.append(rbb)

        # 上方/下方最近的墙：保证公式只吸收自己所在的整块，正文与相邻公式不再桥接进来。
        # 墙体严格取「完全在编号行上/下方」的行，避免把落在编号正下方的说明行误当上方墙。
        up_wall = max(
            (b[3] for _, b in barrier_rows if b[3] <= num_bb[1]), default=0.0
        )
        dn_wall = min(
            (b[1] for _, b in barrier_rows if b[1] >= num_bb[3]), default=page_b
        )

        # 迭代吸纳：候选行须与当前块垂直间隔 ≤ GAP（同一公式块内行间紧密堆叠，
        # 相邻编号公式块之间有明显空隙），从编号行向外聚拢成连续块；
        # 墙（正文行/其他编号行）之外的候选不吸收。
        grew = True
        while grew:
            grew = False
            for rbb in cand_rows:
                x0, y0, x1, y1 = rbb
                if y1 <= up_wall or y0 >= dn_wall:
                    continue
                if y1 >= region[1] - GAP and y0 <= region[3] + GAP:
                    if x0 < region[0] or y0 < region[1] or x1 > region[2] or y1 > region[3]:
                        region[0] = min(region[0], x0)
                        region[1] = min(region[1], y0)
                        region[2] = max(region[2], x1)
                        region[3] = max(region[3], y1)
                        grew = True
        if region[2] - region[0] <= 12 and region[3] - region[1] <= 12:
            continue  # 编号单独成行、没有可吸纳公式 → 视为无公式
        # 收边：期刊排版行距紧，紧邻正文行的 bbox 常与公式首/末行交叠，若按原 bbox
        # 渲染会把相邻正文行的半行文字裁进截图。行中心在区域外的「确定性正文行」
        # （宽行正文/含中文说明/其他编号），按其近侧边缘把区域收回来。
        center_y = (region[1] + region[3]) / 2
        for btxt, fbb in barrier_rows:
            if min(region[2], fbb[2]) - max(region[0], fbb[0]) <= 0:
                continue  # 无水平重叠
            definite_prose = (
                _is_prose(fbb, page_w)
                or _has_explanation_cjk(btxt)
                or _number_token_at_edge(btxt, fbb, col_right_of(fbb)) is not None
            )
            if not definite_prose:
                continue
            fc = (fbb[1] + fbb[3]) / 2
            if fc < center_y and fbb[1] < region[1] < fbb[3]:
                region[1] = max(region[1], fbb[3] + 0.3)
            elif fc > center_y and fbb[1] < region[3] < fbb[3]:
                region[3] = min(region[3], fbb[1] - 0.3)
        if region[3] - region[1] < 10:
            continue  # 过度收边 → 区域存疑，放弃
        reg_h = region[3] - region[1]
        reg_w = region[2] - region[0]
        if reg_h < 14 and reg_w / max(reg_h, 1e-6) > 15:
            continue  # 极扁宽条：图表坐标轴刻度行，非公式
        out.append({"bbox": region, "label": label, "page": page_idx})
    return out


def _detect_flush(rows: list[tuple[str, list[float]]]) -> list[float]:
    """检测文本层的左右页边距（栏边界近似）。"""
    xs0 = [bb[0] for _, bb in rows]
    xs1 = [bb[2] for _, bb in rows]
    return [min(xs0) if xs0 else 0.0, max(xs1) if xs1 else 0.0]


def _column_left(x1: float, flush: list[float]) -> float:
    """按右边缘判断文本所处栏的左边界（近似分栏）。"""
    if not flush:
        return 0.0
    if x1 - flush[0] <= (flush[1] - flush[0]) / 2 + 1:
        return flush[0]
    return (flush[0] + flush[1]) / 2


def _is_flush(bb: list[float], flush: list[float]) -> bool:
    if not flush:
        return False
    # 贴整页/整栏边缘的整段正文行视为栏边界
    if bb[2] - flush[1] > -4:
        return True
    if bb[0] - flush[0] < 4:
        return True
    return False


def _is_prose(bb: list[float], page_w: float) -> bool:
    """过宽的贴栏行视为正文，不并入公式。"""
    return (bb[2] - bb[0]) > page_w * 0.30


_CJK = re.compile(r"[\u4e00-\u9fff]")
_CJK_LEAD = re.compile(
    r"^\s*(式中|其中|这里|此处|该式中|该公式中|式(?:中)?\s*[:：]|其中\s*[:：])"
)
_CJK_ONLY_SHORT = re.compile(r"^[\u4e00-\u9fff]{1,6}$")


def _is_decorative_label(txt: str) -> bool:
    """纯汉字、字数极有限的短行（期刊跑眉/章节小标题，如“综 述”常被拆成单字行）。
    公式本体不会出现纯汉字的短行，故统一视为装饰性标签：不并入公式，并作为
    垂直方向的硬墙，避免截进页眉/栏眉文字边边。
    """
    s = (txt or "").strip()
    return bool(s) and bool(_CJK_ONLY_SHORT.match(s))


def _has_explanation_cjk(txt: str) -> bool:
    """公式区域吸纳时排除含明显中文解释/正文的行（“式中：…”“得…为”等）。

    公式本体通常不含成段中文；含 Δ≥3 个汉字即视为文字说明，避免区域截图带进正文。
    """
    s = (txt or "").strip()
    if not s:
        return False
    if _CJK_LEAD.search(s):
        return True
    return len(_CJK.findall(s)) >= 3