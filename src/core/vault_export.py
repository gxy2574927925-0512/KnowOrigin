"""把知识框架导出为 Obsidian 兼容的知识库：标准 Markdown + ``[[双链]]``。

产品口径（对应 README「你的第二大脑不会被任何私有格式锁住」）：
  1. 一篇 = 一个知识点，文件名 = 节点名 —— Obsidian 靠文件名解析 ``[[双链]]``；
  2. 节点名含 `/ : * ?` 等字符时文件名必须清洗，此时链接写成 ``[[清洗后名|原名]]``
     并在 frontmatter 补 ``aliases: [原名]``，保证「点得开、搜得到原名」；
     两个同名节点会去重成 ``名_1``，这时改用带路径的 ``[[文件夹/名_1|名]]`` 消歧。
     旧端点 ``/vault/export`` 直接写 ``[[原名]]``，上面两类节点会断链，这里修掉；
  3. 双链只写「出链」一处（frontmatter 的 ``links`` + 正文末尾的「关联」清单），
     反向链接交给 Obsidian 自己推 —— 不在导出时补反向边，避免与 Obsidian 去重打架；
  4. 「我的笔记」收藏片段按 ``chapter_node_id`` 归到对应知识点正文后面，
     归不了类的单独出一篇，不丢内容。

旧端点保持原样不动（P0 约定：不改既有端点的签名与行为），
本模块只服务新增的 ``/api/projects/{id}/obsidian/*`` 两个端点。
"""

from __future__ import annotations

import io
import re
import zipfile
from typing import Any, Iterable

# Obsidian 双链语法里不能出现的字符（会破坏 [[...]] 解析）
_LINK_UNSAFE = re.compile(r"[\[\]|#^]")
# 文件系统（尤其 Windows）不接受的字符
_ILLEGAL = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
# Windows 保留设备名，撞上会写不出文件
_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}

_MAX_NAME = 120


def safe_name(name: str) -> str:
    """把节点名/文件夹名清洗成各平台都能落盘的文件名。"""
    cleaned = _ILLEGAL.sub("", str(name or "")).strip().replace(" ", "_")
    cleaned = cleaned.strip(". ")
    if len(cleaned) > _MAX_NAME:
        cleaned = cleaned[:_MAX_NAME].rstrip(". ")
    if cleaned.upper() in _RESERVED:
        cleaned = "_" + cleaned
    return cleaned or "节点"


def _link_text(name: str) -> str:
    """双链的显示文本：去掉会破坏 [[...]] 语法的字符。"""
    text = _LINK_UNSAFE.sub("", str(name or "")).strip()
    return text or "节点"


def _dedupe(path: str, used: set[str]) -> str:
    """同一路径重复时追加 _1 / _2 …… 保证 zip 内不互相覆盖。"""
    if path not in used:
        used.add(path)
        return path
    i = 1
    while f"{path}_{i}" in used:
        i += 1
    path = f"{path}_{i}"
    used.add(path)
    return path


def _mastery_label(score: float) -> str:
    if score >= 0.8:
        return "已掌握"
    if score > 0:
        return "学习中"
    return "未探索"


def _row_field(row: Any, key: str, default: Any = "") -> Any:
    """取一行字段：兼容 dict（db 返回）与对象（测试用 SimpleNamespace）。"""
    if row is None:
        return default
    if isinstance(row, dict):
        return row.get(key, default)
    return getattr(row, key, default)


# 双链与代码块：代码里的 [[示例]] 不是真链接
_LINK_RE = re.compile(r"\[\[([^\]\n]+)\]\]")
_CODE_RE = re.compile(r"```.*?```|`[^`\n]*`", re.S)


def _visible_text(text: str) -> str:
    """去掉行内代码与代码块 —— 里面出现的 [[双链]] 只是示例文字。"""
    return _CODE_RE.sub(" ", text)


def scan_links(files: dict[str, str]) -> tuple[int, int, list[str]]:
    """统计导出的全部双链，并算出哪些指向了本次没导出的知识点。

    笔记正文里用户手写的 ``[[链接]]`` 也要算 —— 只数 frontmatter 的 ``links``
    会漏掉一半，导出的「悬空」统计就成了撒谎。
    """
    stems = {p.rsplit("/", 1)[-1][:-3] for p in files if p.endswith(".md")}
    paths = {p[:-3] for p in files if p.endswith(".md")}
    total = 0
    dangling: set[str] = set()
    for text in files.values():
        for raw in _LINK_RE.findall(_visible_text(text)):
            total += 1
            target = raw.split("|")[0].strip()
            if target in paths or target in stems:
                continue
            if "/" in target and target.rsplit("/", 1)[-1] in stems:
                continue
            dangling.add(target)
    return total, len(dangling), sorted(dangling)


_QUIZ_TYPE_LABELS = {
    "choice": "单选题",
    "single_choice": "单选题",
    "multiple_choice": "多选题",
    "indefinite_choice": "不定项选择",
    "fill": "填空题",
    "fill_blank": "填空题",
    "short_answer": "简答题",
    "calculation": "计算题",
}


def _render_cards_section(cards: Iterable[Any]) -> list[str]:
    """把一组知识卡片渲染成 Markdown 小节（挂在 ``## 知识卡片`` 之下）。

    用「问/答」两行 + 分类·难度角标，纯标准 Markdown，不依赖任何插件。
    """
    lines: list[str] = []
    for card in cards:
        front = str(getattr(card, "front", "") or "").strip()
        back = str(getattr(card, "back", "") or "").strip()
        if not front and not back:
            continue
        category = str(getattr(card, "category", "") or "").strip() or "概念"
        try:
            difficulty = max(1, min(3, int(getattr(card, "difficulty", 1) or 1)))
        except (TypeError, ValueError):
            difficulty = 1
        stars = "★" * difficulty + "☆" * (3 - difficulty)
        lines.append("")
        lines.append(f"**问**：{front}")
        if back:
            lines.append("")
            lines.append(f"**答**：{back}")
        lines.append("")
        lines.append(f"*{category} · 难度 {stars}*")
    return lines


def _render_quiz_section(questions: Iterable[Any]) -> list[str]:
    """把一组测验题渲染成 Markdown 小节（挂在 ``## 小测验`` 之下）。"""
    lines: list[str] = []
    for idx, q in enumerate(questions, 1):
        if not isinstance(q, dict):
            continue
        qtext = str(q.get("question") or "").strip()
        qtype = str(q.get("type") or "single_choice")
        label = _QUIZ_TYPE_LABELS.get(qtype, qtype)
        options = q.get("options") if isinstance(q.get("options"), list) else []
        answer = str(q.get("answer") or "").strip()
        explanation = str(q.get("explanation") or "").strip()
        lines.append("")
        lines.append(f"**{idx}. 【{label}】** {qtext}")
        for opt in options:
            lines.append(f"- {opt}")
        if answer:
            lines.append("")
            lines.append(f"**答案**：{answer}")
        if explanation:
            lines.append("")
            lines.append(f"> 解析：{explanation}")
    return lines


def build_export(
    project: Any,
    nodes: Iterable[Any],
    *,
    scope: str = "all",
    include_index: bool = True,
    include_links: bool = True,
    include_favorites: bool = True,
    favorites: Iterable[Any] | None = None,
    include_cards: bool = True,
    include_quizzes: bool = True,
    cards: Iterable[Any] | None = None,
    quizzes: Iterable[Any] | None = None,
    link_notes: Iterable[Any] | None = None,
    folder_name: str | None = None,
) -> dict[str, Any]:
    """生成导出文件清单与统计。

    返回 ``{"root": 顶层文件夹名, "files": {相对路径: 文本}, "stats": {...}}``。
    只做纯计算，不碰数据库、不写磁盘，方便先出统计（preview）再决定要不要打包。

    知识卡片（``cards``，Card 对象，有 ``front/back/node_ids``）与小测验
    （``quizzes``，dict 载荷，``questions`` 里每道题有 ``node_ids``）按
    ``node_ids`` 归并到对应知识点的「知识卡片」「小测验」小节；挂不到任何
    已导出节点的（node_ids 为空或全在导出范围外）单独落成「未归类」文件，
    保证不丢内容。归并规则与前端「某知识点下挂哪些卡片」的口径一致：
    一个卡片/一道题挂在**每一个**命中节点下。
    """
    node_list = list(nodes)
    by_id = {n.node_id: n for n in node_list}
    fav_list = list(favorites or [])
    card_list = list(cards or [])
    quiz_list = list(quizzes or [])

    # —— 收藏片段先按挂载的知识点分组，后面决定 scope=noted 时要用到 ——
    fav_by_node: dict[str, list[Any]] = {}
    fav_loose: list[Any] = []
    for fav in fav_list:
        cid = getattr(fav, "chapter_node_id", None)
        if cid and cid in by_id:
            fav_by_node.setdefault(cid, []).append(fav)
        else:
            fav_loose.append(fav)

    # —— 双链「理解」：一对双链共享一句关系说明，两端节点各写一遍 ——
    # 行结构 {a_node_id, b_node_id, note}（db.list_link_notes 返回）；仅保留
    # note 非空、且两端都在本次 node_list 里的行——任一端已删，这条理解就失去意义。
    link_note_rows = list(link_notes or [])
    link_note_by_node: dict[str, list[tuple[str, str, str]]] = {}
    valid_link_notes = 0
    for row in link_note_rows:
        a = _row_field(row, "a_node_id")
        b = _row_field(row, "b_node_id")
        text = str(_row_field(row, "note") or "").strip()
        if not a or not b or not text:
            continue
        if a not in by_id or b not in by_id:
            continue
        na = by_id[a].name
        nb = by_id[b].name
        valid_link_notes += 1
        link_note_by_node.setdefault(a, []).append((b, nb, text))
        link_note_by_node.setdefault(b, []).append((a, na, text))

    def _has_note(node: Any) -> bool:
        return bool((getattr(node, "note_content", "") or "").strip())

    def _is_worth_keeping(node: Any) -> bool:
        return _has_note(node) or bool(fav_by_node.get(node.node_id))

    # —— 归属文件夹：镜像知识框架的层级 ——
    # 根节点落 vault 根；其余节点落「根节点名 + 中间各级祖先名」拼出的文件夹，
    # 于是「第一章.md」和「第一章/子节点.md」永远挨着，不会一个在根、一个在别处。
    container_of: dict[str, str | None] = {}
    for n in node_list:
        chain: list[Any] = []
        cur = n.parent_id
        while cur in by_id:
            chain.append(by_id[cur])
            if by_id[cur].parent_id is None:
                break
            cur = by_id[cur].parent_id
        if not chain:
            container_of[n.node_id] = None
        else:
            ordered = [safe_name(x.name) for x in reversed(chain)]  # 根 → 父
            container_of[n.node_id] = "/".join(ordered)

    exported = [n for n in node_list if _is_worth_keeping(n)] if scope == "noted" else node_list

    # —— 知识卡片与小测验按 node_ids 归并到本次导出的节点 ——
    exported_ids = {n.node_id for n in exported}
    cards_by_node: dict[str, list[Any]] = {}
    cards_loose: list[Any] = []
    if include_cards:
        for card in card_list:
            matched = [
                nid for nid in (getattr(card, "node_ids", None) or [])
                if nid in exported_ids
            ]
            if matched:
                for nid in matched:
                    cards_by_node.setdefault(nid, []).append(card)
            else:
                cards_loose.append(card)

    quiz_q_by_node: dict[str, list[dict]] = {}
    quiz_loose: list[dict] = []
    if include_quizzes:
        for quiz in quiz_list:
            if not isinstance(quiz, dict):
                continue
            for q in quiz.get("questions") or []:
                if not isinstance(q, dict):
                    continue
                matched = [
                    nid for nid in (q.get("node_ids") or [])
                    if nid in exported_ids
                ]
                if matched:
                    for nid in matched:
                        quiz_q_by_node.setdefault(nid, []).append(q)
                else:
                    quiz_loose.append(q)

    # —— 分配文件名（去重），并记录「链接该怎么写」——
    used: set[str] = set()
    link_path: dict[str, str] = {}   # node_id -> 相对路径（无 .md），供消歧使用
    ambiguous: set[str] = set()      # 名字撞车被改名过的节点：链接必须带路径
    for n in exported:
        # container 已经是清洗好、用 / 拼好的多级路径，不能再过 safe_name（会把 / 抹掉）
        container = container_of.get(n.node_id)
        base = safe_name(n.name)
        full = f"{container}/{base}" if container else base
        resolved = _dedupe(full, used)
        if resolved != full:
            # 同名撞车被改名：这类节点的链接必须带路径才能唯一解析
            ambiguous.add(n.node_id)
        link_path[n.node_id] = resolved

    name_to_id: dict[str, str] = {}
    for n in exported:
        name_to_id.setdefault(n.name, n.node_id)

    def render_link(target: str) -> str:
        """按目标节点名渲染一条 [[双链]]：名字干净就写裸名，改动过就带路径+别名。"""
        tid = name_to_id.get(target)
        if tid is None:
            # 指向本次没导出的节点：保留成悬空链接，Obsidian 里会标灰，方便日后补建
            return f"[[{_link_text(target)}]]"
        path = link_path[tid]
        stem = path.rsplit("/", 1)[-1]
        if stem == target and tid not in ambiguous:
            return f"[[{_link_text(target)}]]"
        return f"[[{path}|{_link_text(target)}]]"

    # —— 逐篇生成 markdown ——
    files: dict[str, str] = {}
    with_note = 0
    fav_attached = 0

    for n in exported:
        path = link_path[n.node_id]
        stem = path.rsplit("/", 1)[-1]
        links = list(getattr(n, "wikilinks", None) or [])
        tags = list(getattr(n, "tags", None) or [])
        body = (getattr(n, "note_content", "") or "").strip()
        if body:
            with_note += 1
        else:
            body = (getattr(n, "description", "") or "").strip()
        if not body:
            body = "（该知识点暂无笔记。可在知源里补全，或直接在 Obsidian 中书写。）"

        lines: list[str] = ["---"]
        lines.append(f"node_id: {n.node_id}")
        if tags:
            lines.append("tags: [" + ", ".join(tags) + "]")
        lines.append(f"mastery: {round(float(getattr(n, 'mastery_score', 0.0) or 0.0), 3)}")
        lines.append(f"status: {_mastery_label(float(getattr(n, 'mastery_score', 0.0) or 0.0))}")
        if links:
            lines.append("links: [" + ", ".join(_link_text(t) for t in links) + "]")
        if stem != n.name:
            # 文件名被清洗或去重：补别名，让 [[原名]] 也能被 Obsidian 认出来
            lines.append(f"aliases: [{_link_text(n.name)}]")
        lines.append("---")
        lines.append("")
        lines.append(body)

        if include_links and links:
            lines.append("")
            lines.append("## 关联")
            lines.append("")
            lines.extend(f"- {render_link(t)}" for t in links)

        # 双链理解随「关联」开关一起导出：它是双链的补充说明，关掉关联清单时一并隐去
        ln_rows = link_note_by_node.get(n.node_id) if include_links else None
        if ln_rows:
            lines.append("")
            lines.append("## 双链理解")
            lines.append("")
            for _other_id, other_name, text in ln_rows:
                lines.append(f"- {render_link(other_name)}：{text}")

        favs = fav_by_node.get(n.node_id) if include_favorites else None
        if favs:
            fav_attached += len(favs)
            lines.append("")
            lines.append("## 收藏片段")
            for fav in favs:
                lines.append("")
                title = (getattr(fav, "title", "") or "").strip() or "未命名片段"
                lines.append(f"### {title}")
                content = (getattr(fav, "content", "") or "").strip()
                if content:
                    lines.append("")
                    lines.append("\n".join(f"> {ln}" for ln in content.splitlines() if ln.strip()))
                answer = (getattr(fav, "answer", "") or "").strip()
                if answer:
                    lines.append("")
                    lines.append(answer)
                note = (getattr(fav, "note", "") or "").strip()
                if note:
                    lines.append("")
                    lines.append(f"**我的批注**：{note}")

        if include_cards and cards_by_node.get(n.node_id):
            lines.append("")
            lines.append("## 知识卡片")
            lines.extend(_render_cards_section(cards_by_node[n.node_id]))

        if include_quizzes and quiz_q_by_node.get(n.node_id):
            lines.append("")
            lines.append("## 小测验")
            lines.extend(_render_quiz_section(quiz_q_by_node[n.node_id]))

        files[f"{path}.md"] = "\n".join(lines) + "\n"

    # —— 未归类的收藏片段单独成篇，别让它消失 ——
    if include_favorites and fav_loose:
        fav_attached += len(fav_loose)
        lines = ["---", "tags: [我的笔记, 未归类]", "---", "", "# 我的笔记（未归类）", ""]
        for fav in fav_loose:
            lines.append(f"## {(getattr(fav, 'title', '') or '').strip() or '未命名片段'}")
            lines.append("")
            chapter = (getattr(fav, "chapter_name", "") or "").strip()
            if chapter and chapter != "未归类":
                lines.append(f"*章节：{chapter}*")
                lines.append("")
            content = (getattr(fav, "content", "") or "").strip()
            if content:
                lines.append("\n".join(f"> {ln}" for ln in content.splitlines() if ln.strip()))
                lines.append("")
            answer = (getattr(fav, "answer", "") or "").strip()
            if answer:
                lines.append(answer)
                lines.append("")
            note = (getattr(fav, "note", "") or "").strip()
            if note:
                lines.append(f"**我的批注**：{note}")
                lines.append("")
        files["我的笔记-未归类.md"] = "\n".join(lines).rstrip() + "\n"

    # —— 挂不到任何导出节点的卡片/测验单独成篇，别让它消失 ——
    if include_cards and cards_loose:
        lines = ["---", "tags: [知识卡片, 未归类]", "---", "", "# 知识卡片（未归类）", ""]
        lines.append("")
        lines.append("> 以下知识卡片没有挂到本次导出的任何知识点，单独收在这里。")
        lines.extend(_render_cards_section(cards_loose))
        files["知识卡片-未归类.md"] = "\n".join(lines).rstrip() + "\n"

    if include_quizzes and quiz_loose:
        lines = ["---", "tags: [小测验, 未归类]", "---", "", "# 小测验（未归类）", ""]
        lines.append("")
        lines.append("> 以下测验题没有挂到本次导出的任何知识点，单独收在这里。")
        lines.extend(_render_quiz_section(quiz_loose))
        files["小测验-未归类.md"] = "\n".join(lines).rstrip() + "\n"

    # —— 本次导出的卡片 / 测验题总数（供 README 与 stats 报数）——
    cards_total = len(card_list) if include_cards else 0
    quizzes_total = 0
    if include_quizzes:
        for quiz in quiz_list:
            if isinstance(quiz, dict):
                questions = quiz.get("questions") or []
                if isinstance(questions, list):
                    quizzes_total += len(questions)
    # 双链理解跟随「关联」开关：关掉关联清单时一并隐去，计数也归零
    link_notes_total = valid_link_notes if include_links else 0

    # —— README 索引：只列本次真正导出的节点，避免点开是空 ——
    root_name = safe_name(folder_name) if folder_name else "知识库"
    if include_index:
        children_of: dict[str | None, list[Any]] = {}
        for n in exported:
            parent = n.parent_id if n.parent_id in by_id else None
            children_of.setdefault(parent, []).append(n)
        for lst in children_of.values():
            lst.sort(key=lambda x: x.name)

        index_lines = ["# " + root_name, ""]
        subject = getattr(project, "subject", "") or ""
        year = getattr(project, "year", "") or ""
        meta = " ｜ ".join(x for x in [subject, f"年份：{year}" if year else ""] if x)
        index_lines.append(
            f"{meta} ｜ 共 {len(exported)} 个知识点" if meta else f"共 {len(exported)} 个知识点"
        )
        index_lines.append("")
        index_lines.append("> 由知源 KnowOrigin 导出：标准 Markdown + `[[双链]]`，用 Obsidian 直接打开这个文件夹即可。")
        index_lines.append("")
        index_lines.append("## 目录")
        index_lines.append("")

        def walk(parent: str | None, depth: int, seen: set[str]) -> None:
            for child in children_of.get(parent, []):
                if child.node_id in seen:
                    continue
                seen.add(child.node_id)
                if child.node_id in link_path:
                    index_lines.append("  " * depth + f"- {render_link(child.name)}")
                else:
                    index_lines.append("  " * depth + f"- {child.name}")
                walk(child.node_id, depth + 1, seen)

        walk(None, 0, set())
        index_lines.append("")
        if fav_attached:
            index_lines.append(f"另有 {fav_attached} 条「我的笔记」收藏片段已并入对应知识点正文的「收藏片段」小节。")
            index_lines.append("")
        if cards_total:
            index_lines.append(f"另有 {cards_total} 张知识卡片已并入对应知识点正文的「知识卡片」小节。")
            index_lines.append("")
        if quizzes_total:
            index_lines.append(f"另有 {quizzes_total} 道小测验题已并入对应知识点正文的「小测验」小节。")
            index_lines.append("")
        if link_notes_total:
            index_lines.append(f"另有 {link_notes_total} 条双链理解已并入对应知识点正文的「双链理解」小节。")
            index_lines.append("")
        files["README.md"] = "\n".join(index_lines)

    folders = {p.rsplit("/", 1)[0] for p in files if "/" in p}
    links_total, links_dangling, dangling_names = scan_links(files)
    stats = {
        "root": root_name,
        "nodes_total": len(node_list),
        "nodes_exported": len(exported),
        "with_note": with_note,
        "files": len(files),
        "folders": len(folders),
        "links": links_total,
        "dangling_links": links_dangling,
        "dangling_names": dangling_names[:20],
        "favorites": fav_attached,
        "cards": cards_total,
        "quizzes": quizzes_total,
        "link_notes": link_notes_total,
        "scope": scope,
        "note_chars": sum(len(getattr(n, "note_content", "") or "") for n in exported),
    }
    return {"root": root_name, "files": files, "stats": stats}


def build_zip(root: str, files: dict[str, str]) -> bytes:
    """打包成 zip；整体套一层以 root 命名的文件夹，解压即得一个 Obsidian vault。"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for path, content in sorted(files.items()):
            zf.writestr(f"{root}/{path}", content)
    return buf.getvalue()

