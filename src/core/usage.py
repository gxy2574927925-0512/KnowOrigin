"""AI 用量记账与每日限额。

为什么单开一张表、一个 store，而不是并进 ``core/database.py``：
  与 ``core/english_store.py`` 同一取向 —— 既有 ``Database`` 已 2600 行、服务着
  整个产品，横向的用户级功能往里面加表会让 diff 无法评审。这里复用同一份 sqlite
  文件，表名统一 ``ai_`` 前缀，不碰 learning_events / cards / framework_nodes。

为什么不写 ``learning_events``：
  那张表记的是**学习行为**（提问/做题/翻卡/测验），行会被掌握度算法与打卡日历
  消费。用量记的是**系统消耗**，与学习成果无关。混表会污染掌握度口径 ——
  生成一次周报不该让学生看起来"多学了东西"。

为什么口径是**估算**而不是精确 token：
  天大的 OpenAI 兼容接口不保证回 usage（流式响应尤其没有，非流式也不能依赖）。
  与其为了精确而彻底不记账，不如记一个量级正确的估算：CJK 1 字 ≈ 1 token、
  非 CJK 4 字符 ≈ 1 token。对"发现有人正在刷爆额度"这个目的完全够用，且不会
  失真到量级以外。**界面与文案一律标注"估算"，不假装它是账单。**

为什么用 contextvar 传用户，而不是给每个方法加参数：
  调用链是「端点 → 若干 core 函数 → llm.xxx」。一路加 ``user_id`` 参数要改几十个
  既有函数签名（违反"不改既有签名"的硬约定）。contextvar 由中间件在请求入口设置，
  包装器在出口读，链路中间不需要任何人知道这件事。
"""

from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager
from contextvars import ContextVar, Token
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Iterator

from .database import new_id, utc_now

# 用量明细的保留天数。表会随使用一直长，但半年足够回答"谁在什么时候刷了多少"，
# 更老的明细留着只是占空间。清理在记录时按小时节流触发，不另起线程。
RETENTION_DAYS = 180

# 单张图片的 token 估算值。视觉模型按图块计费，一张常规截图大致落在这个量级；
# 这里不追求精确，只为避免"图片 base64 字符串按字符计数"造成的百倍虚高。
IMAGE_TOKEN_ESTIMATE = 1200

# 采样长度：流式输出不保留全文（长回答可能有几 MB），只留头部样本用于外推
# CJK 比例。4000 字符足以让中英比例稳定下来。
STREAM_SAMPLE_CHARS = 4000

SCHEMA = """
CREATE TABLE IF NOT EXISTS ai_usage (
    usage_id     TEXT PRIMARY KEY,
    owner_id     TEXT NOT NULL,
    task         TEXT NOT NULL,
    mode         TEXT NOT NULL,
    prompt_chars INTEGER NOT NULL DEFAULT 0,
    output_chars INTEGER NOT NULL DEFAULT 0,
    est_tokens   INTEGER NOT NULL DEFAULT 0,
    day          TEXT NOT NULL,
    created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_usage_owner_day ON ai_usage(owner_id, day);
CREATE INDEX IF NOT EXISTS ai_usage_day ON ai_usage(day);
"""


# --------------------------------------------------------------------------- #
# 时区：day 用**本地**时区，created_at 用 UTC
# --------------------------------------------------------------------------- #
# 限额按"用户眼里的今天"算。若 day 用 UTC，中国用户会看到额度在北京时间早上 8 点
# 悄然重置，第一反应是"系统出 bug 了"。所以 day 刻意走本地时区，与 created_at
# （沿用项目惯例的 UTC ISO 串）分开存。
def local_day(moment: datetime | None = None) -> str:
    """本地时区的 ``YYYY-MM-DD``。"""
    if moment is None:
        return datetime.now().astimezone().strftime("%Y-%m-%d")
    return moment.astimezone().strftime("%Y-%m-%d")


def _day_before(days: int) -> str:
    """本地时区下 ``days`` 天前的日期串，用于范围查询与清理。"""
    anchor = datetime.now().astimezone() - timedelta(days=max(0, int(days)))
    return anchor.strftime("%Y-%m-%d")


# --------------------------------------------------------------------------- #
# token 估算
# --------------------------------------------------------------------------- #
# 覆盖中日韩统一表意文字、扩展 A、兼容表意文字，以及日文假名与韩文谚文。
# 这些字符在主流 tokenizer 里基本都是 1 字 1 token 上下。
_CJK_RANGES = (
    (0x3400, 0x4DBF),
    (0x4E00, 0x9FFF),
    (0xF900, 0xFAFF),
    (0x3040, 0x30FF),
    (0xAC00, 0xD7AF),
)


def _is_cjk(char: str) -> bool:
    code = ord(char)
    for low, high in _CJK_RANGES:
        if low <= code <= high:
            return True
    return False


def estimate_tokens(text: str | None) -> int:
    """粗估 token 数：CJK 1 字 ≈ 1 token，其余 4 字符 ≈ 1 token。

    刻意不引 tiktoken：那会为"估算"引入一个几 MB 的依赖与一次模型下载，
    而本地优先产品的开箱体验不允许为了记账拖进这种成本。
    """
    if not text:
        return 0
    cjk = 0
    for char in text:
        if _is_cjk(char):
            cjk += 1
    rest = len(text) - cjk
    return int(cjk + rest / 4)


def estimate_from_sample(sample: str | None, total_chars: int) -> int:
    """已知总字符数、只有头部样本时，按样本的中英比例外推。

    流式回答不保留全文（长回答可达数 MB，存全文只为了记账不划算）。
    """
    total = max(0, int(total_chars))
    if total <= 0:
        return 0
    text = sample or ""
    sample_len = len(text)
    if sample_len <= 0:
        # 连样本都没有（例如首块就失败）：按中英混合的常见比例取中庸值
        return int(total / 3)
    if sample_len >= total:
        return estimate_tokens(text)
    return int(estimate_tokens(text) / sample_len * total)


def _payload_text(payload: Any) -> str:
    """把 prompt payload 压成可计数的文本。"""
    if payload is None:
        return ""
    if isinstance(payload, str):
        return payload
    try:
        return json.dumps(payload, ensure_ascii=False, default=str)
    except Exception:
        return str(payload)


def _messages_text(messages: Any) -> str:
    """把 messages 压成可计数的文本。

    图片必须特殊处理：视觉请求的 ``image_url`` 里是 data:base64，原样按字符计数
    会让一次截图提问被算成几十万 token。图片改为按固定估算值计入。
    """
    if not messages:
        return ""
    parts: list[str] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            for item in content:
                if not isinstance(item, dict):
                    continue
                if isinstance(item.get("text"), str):
                    parts.append(item["text"])
                elif item.get("type") == "image_url" or "image_url" in item:
                    parts.append("x" * (IMAGE_TOKEN_ESTIMATE * 4))
    return "\n".join(parts)


def _event_text(event: Any) -> str:
    """从流式事件里抽出可计数的正文。

    ``astream_chat_with_tools`` 的 chunk 是**事件字典**而不是纯文本
    （``{"type": "delta", "text": ...}`` / ``{"type": "tool_calls", "calls": [...]}``），
    直接对它取 ``len()`` 数到的是字典键个数，会让带工具的对话几乎全被记成 0。
    """
    if isinstance(event, str):
        return event or ""
    if isinstance(event, dict):
        text = event.get("text")
        if isinstance(text, str):
            return text
        content = event.get("content")
        if isinstance(content, str):
            return content
        calls = event.get("calls")
        if isinstance(calls, list):
            return _result_text(calls)
    return ""


def _result_text(result: Any) -> str:
    if result is None:
        return ""
    if isinstance(result, str):
        return result
    if isinstance(result, dict):
        try:
            return json.dumps(result, ensure_ascii=False, default=str)
        except Exception:
            return str(result)
    if isinstance(result, list):
        return "".join(str(item) for item in result)
    return str(result)


# --------------------------------------------------------------------------- #
# 当前用户（contextvar）
# --------------------------------------------------------------------------- #
_OWNER: ContextVar[str] = ContextVar("knoworigin_usage_owner", default="")


def set_usage_owner(owner_id: str | None) -> Token:
    return _OWNER.set(owner_id or "")


def reset_usage_owner(token: Token | None) -> None:
    if token is None:
        return
    try:
        _OWNER.reset(token)
    except Exception:
        # 跨线程 reset 会抛 ValueError；此时宁可留下一个脏值，
        # 也不能让中间件的清理逻辑把请求本身弄挂。
        pass


def current_usage_owner() -> str:
    try:
        return _OWNER.get() or ""
    except Exception:
        return ""


# --------------------------------------------------------------------------- #
# 异常
# --------------------------------------------------------------------------- #
class QuotaExceeded(RuntimeError):
    """当日 AI 用量已达上限。

    由 ``api_server`` 的全局处理器映射为 **429** + 中文说明。之所以不在模型层的
    每个调用点各自处理：调用点有几十处，逐处处理既容易漏，也会把"限额"这件事
    泄漏进业务代码。

    ``__str__`` 刻意写成**能直接给用户看的完整句子**，而不只是给日志看的短信息。
    原因是 SSE 端点（如问答流）在流已经开始后无法再改 HTTP 状态码，那里的
    ``except Exception`` 会把异常转成一条 ``{"type":"error"}`` 事件，正文就是
    ``str(exc)``。如果这里只写 "AI 用量已达上限：779 / 100"，用户看到的就是一句
    没头没尾的报错，既不知道为什么、也不知道怎么解开。
    """

    code = "ai_quota_exceeded"

    def __init__(self, used: int, quota: int):
        super().__init__(f"AI 用量已达上限：{used} / {quota}")
        self.used = int(used)
        self.quota = int(quota)

    def __str__(self) -> str:
        # 「这不是故障」是刻意加的：SSE 端点会把它拼成「流式生成失败：<这句>」，
        # 不加这一句，用户会以为是系统坏了，然后反复重试。
        return (
            f"AI 用量已达上限（估算 {self.used:,} / {self.quota:,} tokens）"
            "——这不是故障，是今天分配的额度用完了。"
            "明天零点自动重置；如需临时放宽，把 .env 里的 "
            "KNOWORIGIN_USAGE_DAILY_QUOTA 调大后重启知源。"
        )


# --------------------------------------------------------------------------- #
# 存储
# --------------------------------------------------------------------------- #
class UsageStore:
    """``ai_usage`` 表的读写。复用主库文件，独立连接。"""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        if str(path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        # 主连接与本连接会并发写同一个文件，不设超时就会抛 "database is locked"
        self._conn.execute("PRAGMA busy_timeout = 5000")
        self._last_prune_at = 0.0
        self.init_schema()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        try:
            yield self._conn
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise

    def init_schema(self) -> None:
        with self.transaction() as conn:
            conn.executescript(SCHEMA)

    # -- 写入 ------------------------------------------------------------- #
    def record(
        self,
        *,
        owner_id: str,
        task: str,
        mode: str,
        prompt_chars: int = 0,
        output_chars: int = 0,
        est_tokens: int = 0,
    ) -> None:
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO ai_usage(usage_id, owner_id, task, mode,"
                " prompt_chars, output_chars, est_tokens, day, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    new_id("usage"),
                    owner_id or "",
                    task or "",
                    mode or "json",
                    max(0, int(prompt_chars)),
                    max(0, int(output_chars)),
                    max(0, int(est_tokens)),
                    local_day(),
                    utc_now().isoformat(),
                ),
            )
        self._maybe_prune()

    def _maybe_prune(self) -> None:
        """按小时节流清理过期明细。

        放进 record 而不是单起定时线程：本地优先的产品不该为了维护操作凭空多一个
        常驻线程，而记账本身是低频动作（一次 AI 调用才存一行），顺路清理零成本。
        """
        now = time.monotonic()
        if now - self._last_prune_at < 3600:
            return
        self._last_prune_at = now
        try:
            self.prune()
        except Exception:
            pass

    def prune(self, keep_days: int = RETENTION_DAYS) -> int:
        cutoff = _day_before(keep_days)
        with self.transaction() as conn:
            cursor = conn.execute("DELETE FROM ai_usage WHERE day < ?", (cutoff,))
            return int(cursor.rowcount or 0)

    # -- 读取 ------------------------------------------------------------- #
    def today_tokens(self, owner_id: str) -> int:
        row = self._conn.execute(
            "SELECT COALESCE(SUM(est_tokens), 0) AS total FROM ai_usage"
            " WHERE owner_id = ? AND day = ?",
            (owner_id or "", local_day()),
        ).fetchone()
        return int(row["total"] or 0)

    def today_calls(self, owner_id: str) -> int:
        row = self._conn.execute(
            "SELECT COUNT(*) AS total FROM ai_usage WHERE owner_id = ? AND day = ?",
            (owner_id or "", local_day()),
        ).fetchone()
        return int(row["total"] or 0)

    def daily(self, owner_id: str, days: int = 30) -> list[dict[str, Any]]:
        """按天倒序的用量序列，用于"最近用了多少"的小图。"""
        since = _day_before(days)
        rows = self._conn.execute(
            "SELECT day, COUNT(*) AS calls, COALESCE(SUM(est_tokens), 0) AS tokens"
            " FROM ai_usage WHERE owner_id = ? AND day >= ?"
            " GROUP BY day ORDER BY day DESC",
            (owner_id or "", since),
        ).fetchall()
        return [
            {
                "day": row["day"],
                "calls": int(row["calls"] or 0),
                "tokens": int(row["tokens"] or 0),
            }
            for row in rows
        ]

    def by_task(self, owner_id: str, days: int = 7) -> list[dict[str, Any]]:
        """按任务聚合 —— 用来回答"额度都花在哪了"。"""
        since = _day_before(days)
        rows = self._conn.execute(
            "SELECT task, COUNT(*) AS calls, COALESCE(SUM(est_tokens), 0) AS tokens"
            " FROM ai_usage WHERE owner_id = ? AND day >= ?"
            " GROUP BY task ORDER BY tokens DESC LIMIT 20",
            (owner_id or "", since),
        ).fetchall()
        return [
            {
                "task": row["task"] or "(未命名)",
                "calls": int(row["calls"] or 0),
                "tokens": int(row["tokens"] or 0),
            }
            for row in rows
        ]

    def summary(self, owner_id: str, days: int = 7) -> dict[str, Any]:
        """个人视图要的一整包数据。"""
        since = _day_before(days)
        row = self._conn.execute(
            "SELECT COUNT(*) AS calls, COALESCE(SUM(est_tokens), 0) AS tokens"
            " FROM ai_usage WHERE owner_id = ? AND day >= ?",
            (owner_id or "", since),
        ).fetchone()
        return {
            "today_tokens": self.today_tokens(owner_id),
            "today_calls": self.today_calls(owner_id),
            "window_days": int(days),
            "window_tokens": int(row["tokens"] or 0),
            "window_calls": int(row["calls"] or 0),
            "daily": self.daily(owner_id, days),
            "by_task": self.by_task(owner_id, days),
        }

    def admin_ranking(self, days: int = 7, limit: int = 50) -> list[dict[str, Any]]:
        """全局消耗排行（管理员视图）。"""
        since = _day_before(days)
        rows = self._conn.execute(
            "SELECT owner_id, COUNT(*) AS calls, COALESCE(SUM(est_tokens), 0) AS tokens,"
            " MAX(created_at) AS last_at"
            " FROM ai_usage WHERE day >= ?"
            " GROUP BY owner_id ORDER BY tokens DESC LIMIT ?",
            (since, max(1, int(limit))),
        ).fetchall()
        return [
            {
                "owner_id": row["owner_id"] or "",
                "calls": int(row["calls"] or 0),
                "tokens": int(row["tokens"] or 0),
                "last_at": row["last_at"] or "",
            }
            for row in rows
        ]

    def totals(self) -> dict[str, Any]:
        """全局总量 + 未识别用户的用量。

        ``owner_id`` 为空串说明是"没有登录态时的调用"（例如启动预热、后台任务）。
        把它单独列出来，是因为它一旦异常增长，往往意味着有绕过鉴权的调用路径。
        """
        today = local_day()
        row = self._conn.execute(
            "SELECT COUNT(*) AS calls, COALESCE(SUM(est_tokens), 0) AS tokens"
            " FROM ai_usage WHERE day = ?",
            (today,),
        ).fetchone()
        anon = self._conn.execute(
            "SELECT COUNT(*) AS calls, COALESCE(SUM(est_tokens), 0) AS tokens"
            " FROM ai_usage WHERE day = ? AND owner_id = ''",
            (today,),
        ).fetchone()
        return {
            "day": today,
            "calls": int(row["calls"] or 0),
            "tokens": int(row["tokens"] or 0),
            "anonymous_calls": int(anon["calls"] or 0),
            "anonymous_tokens": int(anon["tokens"] or 0),
        }


# --------------------------------------------------------------------------- #
# 透明代理：给模型客户端套一层记账
# --------------------------------------------------------------------------- #
class UsageTrackedLlm:
    """转发 ``LlmClient`` 的全部方法，只对会消耗 token 的调用落账。

    为什么用代理而不是改 ``core/llm.py``：
      llm.py 是模型层核心（1800 行），四条 HTTP 路径各自构造请求。往每个路径里插
      记账代码，等于把"观测"楔进"推理"里；日后模型层重构还得同步搬一遍。代理把
      这件事收在一处，删掉一行 attach 即完全回退。

    为什么流式方法用 ``def`` 而不是 ``async def``：
      需要在**调用发生的同步时刻**读取 contextvar。``async def`` 的函数体要等第一次
      迭代才执行，那时请求可能已经结束、contextvar 已被中间件清理，记账就会落到
      "未识别用户"上。返回一个内层生成的 async generator，调用方写法完全不变。
    """

    # 会消耗 token 的方法名。其余方法（如 _parse_payload）由 __getattr__ 透传。
    _TRACKED = frozenset(
        {
            "complete_json",
            "complete_json_with_image",
            "complete_with_tools",
            "stream_chat_content",
            "astream_chat_content",
            "astream_chat_with_tools",
            "astream_complete_content",
        }
    )

    def __init__(
        self,
        inner: Any,
        store_provider: Callable[[], UsageStore | None],
        quota_provider: Callable[[], int],
    ) -> None:
        object.__setattr__(self, "_inner", inner)
        object.__setattr__(self, "_store_provider", store_provider)
        object.__setattr__(self, "_quota_provider", quota_provider)

    def __getattr__(self, name: str) -> Any:
        # 只在属性查不到时触发，因此 _TRACKED 里的显式方法优先。
        return getattr(object.__getattribute__(self, "_inner"), name)

    # -- 内部 ------------------------------------------------------------- #
    def _store(self) -> UsageStore | None:
        try:
            return object.__getattribute__(self, "_store_provider")()
        except Exception:
            return None

    def _quota(self) -> int:
        try:
            return int(object.__getattribute__(self, "_quota_provider")() or 0)
        except Exception:
            return 0

    def _guard(self, owner: str) -> None:
        """调用前的额度检查。超限直接抛，不把请求发出去。"""
        quota = self._quota()
        if quota <= 0:
            return
        store = self._store()
        if store is None:
            return
        try:
            used = store.today_tokens(owner)
        except Exception:
            return
        if used >= quota:
            raise QuotaExceeded(used, quota)

    def _charge(
        self,
        owner: str,
        task: str,
        mode: str,
        prompt_text: str,
        output_text: str,
        *,
        prompt_tokens: int | None = None,
        output_tokens: int | None = None,
    ) -> None:
        """落账。**任何异常都吞掉** —— 记账失败绝不能影响用户拿到回答。"""
        store = self._store()
        if store is None:
            return
        try:
            store.record(
                owner_id=owner,
                task=task,
                mode=mode,
                prompt_chars=len(prompt_text or ""),
                output_chars=len(output_text or ""),
                est_tokens=(
                    estimate_tokens(prompt_text)
                    if prompt_tokens is None
                    else int(prompt_tokens)
                )
                + (
                    estimate_tokens(output_text)
                    if output_tokens is None
                    else int(output_tokens)
                ),
            )
        except Exception:
            pass

    # -- 非流式 ----------------------------------------------------------- #
    def complete_json(self, task: str, payload: dict[str, Any]) -> dict[str, Any]:
        owner = current_usage_owner()
        self._guard(owner)
        prompt = _payload_text(payload)
        try:
            result = self._inner.complete_json(task, payload)
        except Exception:
            # 失败的调用同样把 prompt 送出去并被计费，所以照样记一笔（输出记 0）。
            # 不这样做的话，"反复重试直到成功"的刷法在账面上是隐形的。
            self._charge(owner, task, "json", prompt, "")
            raise
        self._charge(owner, task, "json", prompt, _result_text(result))
        return result

    def complete_json_with_image(
        self,
        task: str,
        payload: dict[str, Any],
        image: bytes,
        mime_type: str,
    ) -> dict[str, Any]:
        owner = current_usage_owner()
        self._guard(owner)
        # 图片本身按固定值估算（base64 字符串不能按字符计数，否则百倍虚高）；
        # 这里用一个占位串让 estimate_tokens 产出与 IMAGE_TOKEN_ESTIMATE 等值的量。
        prompt = _payload_text(payload) + "x" * (IMAGE_TOKEN_ESTIMATE * 4)
        try:
            result = self._inner.complete_json_with_image(task, payload, image, mime_type)
        except Exception:
            self._charge(owner, task, "image", prompt, "")
            raise
        self._charge(owner, task, "image", prompt, _result_text(result))
        return result

    def complete_with_tools(
        self,
        messages: list[dict[str, Any]],
        task: str,
        tools: list[dict[str, Any]],
        *,
        temperature: float | None = None,
    ) -> dict[str, Any]:
        owner = current_usage_owner()
        self._guard(owner)
        prompt = _messages_text(messages)
        try:
            result = self._inner.complete_with_tools(
                messages, task, tools, temperature=temperature
            )
        except Exception:
            self._charge(owner, task, "tools", prompt, "")
            raise
        self._charge(owner, task, "tools", prompt, _result_text(result))
        return result

    # -- 流式 ------------------------------------------------------------- #
    def stream_chat_content(
        self,
        messages: list[dict[str, Any]],
        task: str,
        *,
        temperature: float | None = None,
    ) -> Iterator[str]:
        owner = current_usage_owner()
        self._guard(owner)
        prompt = _messages_text(messages)
        inner = object.__getattribute__(self, "_inner")

        def _generate() -> Iterator[str]:
            total = 0
            sample: list[str] = []
            sample_len = 0
            try:
                for chunk in inner.stream_chat_content(
                    messages, task, temperature=temperature
                ):
                    text = chunk or ""
                    total += len(text)
                    if sample_len < STREAM_SAMPLE_CHARS:
                        sample.append(text)
                        sample_len += len(text)
                    yield chunk
            finally:
                self._charge(
                    owner,
                    task,
                    "stream",
                    prompt,
                    "",
                    output_tokens=estimate_from_sample("".join(sample), total),
                )

        return _generate()

    def astream_chat_content(
        self,
        messages: list[dict[str, Any]],
        task: str,
        *,
        temperature: float | None = None,
        extra_payload: dict[str, Any] | None = None,
    ) -> AsyncIterator[str]:
        owner = current_usage_owner()
        self._guard(owner)
        prompt = _messages_text(messages)
        inner = object.__getattribute__(self, "_inner")

        async def _generate() -> AsyncIterator[str]:
            total = 0
            sample: list[str] = []
            sample_len = 0
            try:
                async for chunk in inner.astream_chat_content(
                    messages,
                    task,
                    temperature=temperature,
                    extra_payload=extra_payload,
                ):
                    text = chunk or ""
                    total += len(text)
                    if sample_len < STREAM_SAMPLE_CHARS:
                        sample.append(text)
                        sample_len += len(text)
                    yield chunk
            finally:
                self._charge(
                    owner,
                    task,
                    "stream",
                    prompt,
                    "",
                    output_tokens=estimate_from_sample("".join(sample), total),
                )

        return _generate()

    def astream_chat_with_tools(
        self,
        messages: list[dict[str, Any]],
        task: str,
        tools: list[dict[str, Any]],
        *,
        temperature: float | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        owner = current_usage_owner()
        self._guard(owner)
        prompt = _messages_text(messages)
        inner = object.__getattribute__(self, "_inner")

        async def _generate() -> AsyncIterator[dict[str, Any]]:
            total = 0
            sample: list[str] = []
            sample_len = 0
            try:
                async for chunk in inner.astream_chat_with_tools(
                    messages, task, tools, temperature=temperature
                ):
                    text = _event_text(chunk)
                    total += len(text)
                    if sample_len < STREAM_SAMPLE_CHARS:
                        sample.append(text)
                        sample_len += len(text)
                    yield chunk
            finally:
                self._charge(
                    owner,
                    task,
                    "stream",
                    prompt,
                    "",
                    output_tokens=estimate_from_sample("".join(sample), total),
                )

        return _generate()

    def astream_complete_content(
        self,
        task: str,
        payload: dict[str, Any],
        temperature: float | None = None,
    ) -> AsyncIterator[str]:
        owner = current_usage_owner()
        self._guard(owner)
        prompt = _payload_text(payload)
        inner = object.__getattribute__(self, "_inner")

        async def _generate() -> AsyncIterator[str]:
            total = 0
            sample: list[str] = []
            sample_len = 0
            try:
                async for chunk in inner.astream_complete_content(
                    task, payload, temperature
                ):
                    text = chunk or ""
                    total += len(text)
                    if sample_len < STREAM_SAMPLE_CHARS:
                        sample.append(text)
                        sample_len += len(text)
                    yield chunk
            finally:
                self._charge(
                    owner,
                    task,
                    "stream",
                    prompt,
                    "",
                    output_tokens=estimate_from_sample("".join(sample), total),
                )

        return _generate()


def attach_usage_tracking(
    llm: Any,
    store_provider: Callable[[], UsageStore | None],
    quota_provider: Callable[[], int],
    *,
    enabled: bool = True,
) -> Any:
    """给模型客户端套上记账代理。

    幂等：重复包装直接返回原对象，避免测试里多次 create_app 造成叠套。
    ``enabled=False`` 时原样返回 —— 这就是这个功能的"总开关"。
    """
    if not enabled or llm is None:
        return llm
    if isinstance(llm, UsageTrackedLlm):
        return llm
    return UsageTrackedLlm(llm, store_provider, quota_provider)
