"""英语词汇 · 本地词典：加载 ``data/english/*.json`` 并提供查词、词形还原、词根。

数据来源：ECDICT（MIT License, Copyright (c) 2025 Linwei），由
``tools/build_english_dict.py`` 抽取生成。字段与许可说明见 ``data/english/NOTICE.md``。

三条设计原则：
  1. **懒加载 + 进程内缓存**：words.json 有 4MB / 4.3 万词条，没用到就不读盘；
  2. **不联网**：知源是本地优先产品，查词不能有网络依赖；
  3. **诚实降级**：查不到就返回 None，绝不编一个释义出来骗用户。
"""

from __future__ import annotations

import json
import threading
from difflib import get_close_matches
from pathlib import Path

from .english_vocab import lemma_candidates, normalize_token

# 词条字段顺序由 words.json 自己声明（"fields"），这里只做默认值兜底
DEFAULT_FIELDS = ["phonetic", "translation", "pos", "tag", "collins", "oxford", "frq"]

# 词根匹配时，太短的键（如 "-en"）会误伤一堆词，故设下限
MIN_ROOT_LEN = 3


class EnglishDict:
    """只读的本地英语词典。线程安全（懒加载用锁保护）。"""

    def __init__(self, data_dir: str | Path):
        self.dir = Path(data_dir)
        self._lock = threading.Lock()
        self._words: dict[str, dict] | None = None
        self._word_keys: list[str] | None = None
        self._lemma: dict[str, str] | None = None
        self._basic: set[str] | None = None
        self._roots: dict[str, dict] | None = None
        self._decks: dict[str, dict] | None = None

    # ---------------------------------------------------------------- 懒加载

    def _load(self, name: str) -> dict | None:
        path = self.dir / name
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            # 数据文件损坏时宁可当作"没有词典"，也不要让整个服务起不来
            return None

    @property
    def available(self) -> bool:
        return (self.dir / "words.json").exists()

    @property
    def words(self) -> dict[str, dict]:
        if self._words is None:
            with self._lock:
                if self._words is None:
                    payload = self._load("words.json") or {}
                    fields = payload.get("fields") or DEFAULT_FIELDS
                    raw = payload.get("words") or {}
                    self._words = {
                        word: dict(zip(fields, record)) for word, record in raw.items()
                    }
        return self._words

    @property
    def lemma_map(self) -> dict[str, str]:
        if self._lemma is None:
            with self._lock:
                if self._lemma is None:
                    payload = self._load("lemma.json") or {}
                    self._lemma = payload.get("lemma") or {}
        return self._lemma

    @property
    def basic(self) -> set[str]:
        if self._basic is None:
            with self._lock:
                if self._basic is None:
                    payload = self._load("basic.json") or {}
                    self._basic = set(payload.get("words") or [])
        return self._basic

    @property
    def roots(self) -> dict[str, dict]:
        if self._roots is None:
            with self._lock:
                if self._roots is None:
                    payload = self._load("wordroot.json") or {}
                    self._roots = payload.get("roots") or {}
        return self._roots

    def _deck_payload(self) -> dict:
        if self._decks is None:
            with self._lock:
                if self._decks is None:
                    payload = self._load("decks.json") or {}
                    self._decks = payload.get("decks") or {}
        return self._decks

    # ------------------------------------------------------------------ 查询

    def entry(self, word: str) -> dict | None:
        """精确查词（会先做小写与所有格归一）。"""
        key = normalize_token(word)
        if not key:
            return None
        return self.words.get(key)

    def resolve_lemma(self, word: str) -> str:
        """返回原形。优先用 ECDICT 的 lemma 数据，没有再用保守的规则兜底。

        ECDICT README 明确说纯算法做词形还原"都不靠谱"，所以顺序不能反：
        先查表，表里没有再猜，猜出来的结果**只在字典里确实存在时才采用**。
        """
        key = normalize_token(word)
        if not key:
            return ""
        known = self.lemma_map.get(key)
        if known:
            return known
        for candidate in lemma_candidates(key):
            if candidate in self.words:
                return candidate
        return key

    def lookup(self, word: str) -> dict | None:
        """查词：精确 → 词形还原 → 其它候选。全都不中返回 None（不编释义）。"""
        key = normalize_token(word)
        if not key:
            return None
        direct = self.words.get(key)
        if direct:
            return {"word": key, **direct}
        # 先走 lemma 表（比规则可靠），再走规则候选
        resolved = self.resolve_lemma(key)
        found = self.words.get(resolved)
        if found:
            return {"word": resolved, **found}
        for candidate in lemma_candidates(key):
            found = self.words.get(candidate)
            if found:
                return {"word": candidate, **found}
        return None

    def is_basic(self, word: str) -> bool:
        """是否属于"应该已经会了"的基础词（牛津3000 / 柯林斯≥3星 / 词频前3000）。"""
        key = normalize_token(word)
        if not key:
            return True
        if key in self.basic:
            return True
        entry = self.words.get(key)
        if not entry:
            return False
        return (
            int(entry.get("oxford") or 0) == 1
            or int(entry.get("collins") or 0) >= 3
            or 0 < int(entry.get("frq") or 0) < 3000
        )

    def roots_of(self, word: str) -> list[dict]:
        """找出这个词能拆出的词根/前缀/后缀。

        做法是遍历词根表做匹配 —— 611 条的量级，暴力匹配足够快，也不需要引入
        分词模型。但**匹配位置必须按词缀类型区分**，否则会误伤：

          * 前缀（`co-` / `re-`）只能匹配词首 —— 否则 `coherent` 会拆出一个并不
            存在的 `re-`（cohERent 里确实有 "re" 这两个字母）；
          * 后缀（`-ent` / `-less`）只能匹配词尾；
          * 词根可以出现在词中（`coherent` 的 `her` 就在中间）。

        **只给"依据"，不给解释**：词根的中文讲解交给模型，本地数据只负责事实
        （是什么、源自哪种语言）。
        """
        key = normalize_token(word)
        if not key or len(key) < MIN_ROOT_LEN:
            return []
        found: list[dict] = []
        for raw_key, info in self.roots.items():
            kind = str(info.get("class", "")).lower()
            is_prefix = "prefix" in kind
            is_suffix = "suffix" in kind
            for part in (p.strip() for p in raw_key.split(",")):
                core = part.strip("-").lower()
                # 2 个字母的键只对前缀放行（co- / de- / re-），否则会误伤一大片词
                if len(core) < (2 if is_prefix else MIN_ROOT_LEN) or core == key:
                    continue
                if is_prefix:
                    if not key.startswith(core):
                        continue
                elif is_suffix:
                    if not key.endswith(core):
                        continue
                elif core not in key:
                    continue
                found.append(
                    {
                        "root": part,
                        "core": core,
                        "meaning": info.get("meaning", ""),
                        "class": info.get("class", ""),
                        "origin": info.get("origin", ""),
                        "at_start": key.startswith(core),
                        "at_end": key.endswith(core),
                    }
                )
                break
        # 前缀优先、长词根优先，取前 4 条，避免把一个词拆得七零八落
        found.sort(key=lambda r: (not r["at_start"], -len(r["core"])))
        return found[:4]

    def similar_of(self, word: str, limit: int = 5) -> list[dict]:
        """形近词：在本地词典里找拼写接近的词（编辑相似度 ≥ 0.72）。

        4.3 万词条全量过一遍 difflib，实测一次几十毫秒，作为查词/复习时的
        按需调用完全够用；词条列表做进程内缓存避免每次重建。
        太短的词（≤3 字母）形近结果基本是噪音，直接不给。
        """
        key = normalize_token(word)
        if not key or len(key) <= 3:
            return []
        if self._word_keys is None:
            # 注意顺序：必须先在锁外访问 self.words 触发懒加载（它内部也要拿
            # 同一把非重入锁），否则自己等自己 → 死锁。
            words = self.words
            with self._lock:
                if self._word_keys is None:
                    self._word_keys = sorted(words.keys())
        matches = get_close_matches(key, self._word_keys, n=limit + 2, cutoff=0.72)
        out: list[dict] = []
        for candidate in matches:
            if candidate == key:
                continue
            entry = self.words.get(candidate) or {}
            # ECDICT 的 translation 是 "中文 / [领域] 中文 / 英文原注" 的长串，
            # 界面只要第一段够用的释义；再长就会在窄栏里挤成一片。
            translation = str(entry.get("translation") or "")
            for sep in ("\\r", "\r", " / ", "/"):
                translation = translation.split(sep)[0]
            meaning = translation.strip()
            if len(meaning) > 48:
                meaning = meaning[:47].rstrip() + "…"
            out.append({"word": candidate, "meaning": meaning})
            if len(out) >= limit:
                break
        return out

    # ------------------------------------------------------------------ 词表

    def deck_list(self) -> list[dict]:
        out: list[dict] = []
        for deck_id, meta in self._deck_payload().items():
            out.append(
                {
                    "deck_id": deck_id,
                    "name": meta.get("name", deck_id),
                    "description": meta.get("description", ""),
                    "tag": meta.get("tag", ""),
                    "word_count": int(
                        meta.get("word_count") or len(meta.get("words") or [])
                    ),
                }
            )
        return out

    def has_deck(self, deck_id: str) -> bool:
        return deck_id in self._deck_payload()

    def deck_words(self, deck_id: str, offset: int = 0, limit: int = 200) -> list[dict]:
        """按词频降序（高频先学）返回词表里的一段词。"""
        meta = self._deck_payload().get(deck_id)
        if not meta:
            return []
        names = meta.get("words") or []
        out: list[dict] = []
        for word in names[offset : offset + limit]:
            out.append({"word": word, **(self.words.get(word) or {})})
        return out

    def deck_size(self, deck_id: str) -> int:
        meta = self._deck_payload().get(deck_id)
        return len(meta.get("words") or []) if meta else 0

    def stats(self) -> dict:
        return {
            "available": self.available,
            "data_dir": str(self.dir),
            "words": len(self.words) if self._words is not None else None,
            "decks": len(self._deck_payload()) if self._decks is not None else None,
        }


_DICT: EnglishDict | None = None
_DICT_LOCK = threading.Lock()


def get_dict(data_dir: str | Path | None = None) -> EnglishDict:
    """进程级单例。``data_dir`` 传的是 settings.data_dir（data/ 的绝对路径）。"""
    global _DICT
    if _DICT is None:
        with _DICT_LOCK:
            if _DICT is None:
                base = (
                    Path(data_dir)
                    if data_dir
                    else Path(__file__).resolve().parents[2] / "data"
                )
                _DICT = EnglishDict(base / "english")
    return _DICT
