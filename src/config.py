from __future__ import annotations

import os
import json
import base64
from dataclasses import dataclass
from pathlib import Path
from typing import Any


# 大赛要求使用「仓库专属 API 地址」（否则调用量不计分）；专属地址见 ai.tju.edu.cn 个人中心。
DEFAULT_TJU_BASE_URL = (
    "https://ai.tju.edu.cn/api/agent2026/gitlab-83-agent2026-笔记管理智能体/"
)
DEFAULT_TJU_MODEL = "tju-llm"
DEFAULT_TJU_TIMEOUT_SECONDS = 90.0
DEFAULT_TJU_JSON_MODE = "auto"

# 凭据一律不进仓库：运行时按「环境变量 / .env → data/local_api_config.json → 浏览器下发」读取。
# （.env 与 data/ 都已在 .gitignore 中。仓库不内置、也不从远端拉取任何密钥，
#   每个人都填自己在 ai.tju.edu.cn 个人中心获取的那把。）
#
# 2026-10-05 起，用户在「API 配置」里填的那把密钥会**写回 data/local_api_config.json**：
# 只落在这台机器、这个已被 gitignore 排除的目录里，重启服务后不用再粘贴一次。
# 文件里的密钥一律经 DPAPI 加密（Windows，绑定当前登录账户，别的账户/别的机器
# 解不开）；非 Windows 平台退化为明文，功能一致。
# 浏览器 localStorage（static/app.js 的 knoworigin-api-credentials-v1）**继续保留**，
# 作为换浏览器 / 无痕窗口场景下的兜底，两边都存不冲突：读取时环境变量优先，
# 其次文件，最后浏览器下发（POST /api/config/session 只在值不同时才回写文件）。

# Zhipu (BigModel) vision fallback for scanned-PDF / image OCR.
# Used only when neither env vars nor data/local_api_config.json provide
# vision_model / vision_api_key / vision_base_url.
VISION_DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4/"
VISION_DEFAULT_MODEL = "glm-4v-flash"

# 文献精读：图书馆数据库跳转入口（仅外链，不做程序化拉取），可用 KNOWORIGIN_LIBRARY_LINKS 覆盖（兼容旧名 KNOWORIGIN_LIBRARY_LINKS）
DEFAULT_LIBRARY_LINKS = json.dumps(
    [
        {"name": "天津大学图书馆", "url": "https://www.lib.tju.edu.cn/"},
        {"name": "读秀知识库", "url": "https://www.duxiu.com/"},
        {"name": "CARSI 校外访问", "url": "https://www.carsi.edu.cn/"},
    ],
    ensure_ascii=False,
)


_MINERU_BACKENDS = {
    "pipeline",
    "vlm-engine",
    "hybrid-engine",
    "vlm-http-client",
    "hybrid-http-client",
}


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _as_positive_float(value: Any, default: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed >= 1.0 else default


def _as_non_negative_int(value: Any, default: int = 0) -> int:
    """把配置读成非负整数。

    非法值一律回落、绝不抛异常：配置项写错不该让服务起不来。
    ``0`` 在用量限额里是**有意义的取值**（表示不限额），所以不能被当成空值丢掉。
    """
    text = str(value if value is not None else "").strip()
    if not text:
        return default
    try:
        parsed = int(float(text))
    except (TypeError, ValueError):
        return default
    return max(0, parsed)


def _b64_decode(value: str) -> str:
    """解码 base64 形式的密钥（可选写法，便于避免明文出现在 shell 历史里）。失败返回空串。"""
    value = (value or "").strip()
    if not value:
        return ""
    try:
        return base64.b64decode(value).decode("utf-8").strip()
    except (ValueError, UnicodeDecodeError):
        return ""


# 密钥在 data/local_api_config.json 里的加密前缀。只有带这个前缀的值才走解密，
# 升级前写进去的明文会被原样当成密钥继续用（迁移不需要用户重填一次）。
_DPAPI_PREFIX = "dpapi1:"


def _dpapi(data: bytes, *, protect: bool) -> bytes | None:
    """调用 Windows DPAPI 加/解密数据；非 Windows 或任何一步失败都返回 None。

    DPAPI 把密文绑定到「当前登录的 Windows 账户 + 这台机器」：别的账户、
    别人的机器、拷贝走的 data/ 目录都解不开，比裸存明文强一个档次。
    只用标准库 ctypes，不引入 pywin32（requirements.txt 里没有它）。
    """
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class _Blob(ctypes.Structure):
            _fields_ = [
                ("cbData", wintypes.DWORD),
                ("pbData", ctypes.POINTER(ctypes.c_ubyte)),
            ]

        entry = "CryptProtectData" if protect else "CryptUnprotectData"
        function = getattr(ctypes.windll.crypt32, entry)
        function.restype = wintypes.BOOL
        function.argtypes = [
            ctypes.POINTER(_Blob),
            ctypes.c_wchar_p,
            ctypes.POINTER(_Blob),
            ctypes.c_void_p,
            ctypes.c_void_p,
            wintypes.DWORD,
            ctypes.POINTER(_Blob),
        ]
        buffer = ctypes.create_string_buffer(data, len(data))
        source = _Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
        target = _Blob()
        # CRYPTPROTECT_UI_FORBIDDEN = 0x1：不弹任何系统对话框（服务是无头跑的）。
        if not function(
            ctypes.byref(source), None, None, None, None, 0x1, ctypes.byref(target)
        ):
            return None
        try:
            return ctypes.string_at(target.pbData, target.cbData)
        finally:
            ctypes.windll.kernel32.LocalFree(target.pbData)
    except Exception:
        # 密钥存不存得下都不该让服务起不来：失败就退回明文，功能不受影响。
        return None


def _encode_secret(value: str) -> str:
    """把密钥编码成可写进 json 的字符串：能加密就加密，加密不可用则原样明文。"""
    value = (value or "").strip()
    if not value:
        return ""
    sealed = _dpapi(value.encode("utf-8"), protect=True)
    if sealed:
        return _DPAPI_PREFIX + base64.b64encode(sealed).decode("ascii")
    return value


def _decode_secret(value: Any) -> str:
    """还原密钥：带前缀的走 DPAPI，历史明文与无法解密的值一律当明文用。"""
    value = str(value or "").strip()
    if not value.startswith(_DPAPI_PREFIX):
        return value
    try:
        raw = base64.b64decode(value[len(_DPAPI_PREFIX) :])
    except (ValueError, TypeError):
        return ""
    opened = _dpapi(raw, protect=False)
    if not opened:
        # 换账户 / 换机器后解不开：宁可当没配过，也不要把密文当密钥发出去。
        return ""
    try:
        return opened.decode("utf-8").strip()
    except UnicodeDecodeError:
        return ""


def _normalized_mineru_backend(value: Any) -> str:
    backend = str(value or "").strip()
    return backend if backend in _MINERU_BACKENDS else "pipeline"


def _normalized_scanned_pdf_backend(value: Any) -> str:
    backend = str(value or "").strip().lower()
    return backend if backend in {"fast", "quality"} else "fast"


def _vision_setting(local_config: dict[str, Any], key: str, fallback: str) -> str:
    """读取视觉模型的本地覆盖值。

    关键点：``local_api_config.json`` 里**显式写了空串**表示用户主动留空
    （关闭视觉模型 / 回落到主配置），此时不再套用内置默认值；只有从未配置过
    这一项（键不存在）才使用内置默认。否则用户在「API 配置」里清空视觉模型
    后会被默认值悄悄打回，界面与实际行为对不上。
    """
    if key in local_config:
        return str(local_config.get(key, "") or "").strip()
    return fallback


def _resolve_mineru_enabled(value: Any, cli: Any) -> bool:
    """解析 MinerU 开关：显式 true/false 直接生效；未配置（默认 "auto"）时按 CLI 是否可用自动启用。"""
    if isinstance(value, str) and value.strip().lower() == "auto":
        import shutil

        cli_name = str(cli or "").strip() or "mineru"
        return shutil.which(cli_name) is not None
    return _as_bool(value)


@dataclass(frozen=True)
class Settings:
    tju_api_key: str
    tju_base_url: str
    tju_model: str
    data_dir: Path
    tju_proxy_url: str = ""
    tju_timeout_seconds: float = DEFAULT_TJU_TIMEOUT_SECONDS
    tju_json_mode: str = DEFAULT_TJU_JSON_MODE
    tju_vision_api_key: str = ""
    tju_vision_base_url: str = ""
    tju_vision_model: str = ""
    session_secret: str = ""
    admin_password: str = ""
    library_links: str = ""
    mineru_enabled: bool = False
    mineru_backend: str = "pipeline"
    mineru_method: str = "auto"
    mineru_lang: str = "ch"
    mineru_cli: str = "mineru"
    mineru_timeout_seconds: float = 600.0
    mineru_skip_text_pdf: bool = True
    scanned_pdf_backend: str = "fast"
    tesseract_cmd: str = ""
    tesseract_lang: str = "chi_sim"
    # ---- AI 用量记账与长期记忆（均可在 .env 里关掉）----
    # usage_daily_quota 的单位是"估算 token"（CJK 1 字 ≈ 1 token）。0 = 不限额。
    usage_tracking_enabled: bool = True
    usage_daily_quota: int = 0
    memory_enabled: bool = True
    notice_weekly_enabled: bool = True


def _load_dotenv_if_available() -> None:
    # 兼容旧版：新名 KNOWORIGIN_DISABLE_DOTENV 优先，未设置时回落 KNOWORIGIN_DISABLE_DOTENV。
    if os.getenv("KNOWORIGIN_DISABLE_DOTENV", os.getenv("KNOWORIGIN_DISABLE_DOTENV")):
        return
    try:
        from dotenv import load_dotenv
    except Exception:
        return
    candidates = [
        Path(__file__).resolve().parent / ".env",  # src/.env（保留兼容）
        Path(__file__).resolve().parent.parent / ".env",  # 项目根/.env（迁移后默认）
        Path.cwd() / ".env",
    ]
    loaded: set[Path] = set()
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
        except OSError:
            resolved = candidate
        if resolved in loaded:
            continue
        loaded.add(resolved)
        load_dotenv(dotenv_path=resolved, override=False)


def _normalized_base_url(value: str) -> str:
    value = (value or DEFAULT_TJU_BASE_URL).strip()
    return value if value.endswith("/") else f"{value}/"


def _normalized_optional_base_url(value: str) -> str:
    value = (value or "").strip()
    if not value:
        return ""
    return value if value.endswith("/") else f"{value}/"


def _project_dir() -> Path:
    # src/ 迁移后 config.py 位于 src/ 下，项目根是其上一级；
    # 兼容旧布局：若上一级没有 requirements.txt，则自身即项目根。
    here = Path(__file__).resolve().parent
    if (here.parent / "requirements.txt").exists():
        return here.parent
    return here


def _resolved_data_dir(value: str | None) -> Path:
    data_dir = Path((value or "data").strip() or "data").expanduser()
    if not data_dir.is_absolute():
        data_dir = _project_dir() / data_dir
    return data_dir


def load_settings() -> Settings:
    """Load local settings without ever requiring or exposing a real secret."""

    _load_dotenv_if_available()
    data_dir = _resolved_data_dir(os.getenv("DATA_DIR", "data"))
    local_config = _read_local_api_config(data_dir)
    try:
        timeout_seconds = float(
            os.getenv("TJU_TIMEOUT_SECONDS", str(DEFAULT_TJU_TIMEOUT_SECONDS))
        )
    except ValueError:
        timeout_seconds = DEFAULT_TJU_TIMEOUT_SECONDS
    _lc_key = _decode_secret(local_config.get("api_key"))
    _lc_base = str(local_config.get("base_url", "")).strip()
    _lc_model = str(local_config.get("model", "")).strip()
    _lc_json = str(local_config.get("json_mode", "")).strip()
    # 凭据来源优先级：环境变量 / .env → data/local_api_config.json
    # → 浏览器 localStorage 下发的运行期密钥。都没有时留空，由上层给出明确的
    # "请先配置模型密钥"提示，绝不内置到仓库里。
    # 文件里那一项是主存储：用户在「API 配置」里保存的密钥会写回去（加密），
    # 所以重启服务后不必再粘贴一次。浏览器下发的密钥只在服务端内存里用，
    # 不回写文件（每次刷新都发一遍，回写只会白折腾磁盘；真正换密钥走
    # PUT /api/config，那条路径才落盘）。
    # 环境变量同时支持明文 TJU_API_KEY 与 base64 编码形式 TJU_API_KEY_B64
    # （后者只是避免明文落在 shell 历史里；仓库本身不含任何密钥）。
    _env_key = os.getenv("TJU_API_KEY", "").strip() or _b64_decode(
        os.getenv("TJU_API_KEY_B64", "")
    )
    if _env_key.startswith("your-"):
        _env_key = ""
    _key = (_env_key or _lc_key).strip()
    if _key.startswith("your-"):
        _key = ""
    _base = os.getenv("TJU_BASE_URL", "") or _lc_base or DEFAULT_TJU_BASE_URL
    _model = (os.getenv("TJU_MODEL", "") or _lc_model).strip() or DEFAULT_TJU_MODEL
    _json = os.getenv("TJU_JSON_MODE", "") or _lc_json or DEFAULT_TJU_JSON_MODE
    return Settings(
        tju_api_key=_key,
        tju_base_url=_normalized_base_url(_base),
        tju_model=_model,
        data_dir=data_dir,
        tju_proxy_url=os.getenv("TJU_PROXY_URL", "").strip(),
        tju_timeout_seconds=max(5.0, timeout_seconds),
        tju_json_mode=_normalized_json_mode(_json),
        tju_vision_api_key=(
            os.getenv("TJU_VISION_API_KEY", "").strip()
            or _b64_decode(os.getenv("TJU_VISION_API_KEY_B64", ""))
            or _decode_secret(local_config.get("vision_api_key"))
        ),
        tju_vision_base_url=_normalized_optional_base_url(
            os.getenv(
                "TJU_VISION_BASE_URL",
                _vision_setting(
                    local_config, "vision_base_url", VISION_DEFAULT_BASE_URL
                ),
            )
        ),
        tju_vision_model=os.getenv(
            "TJU_VISION_MODEL",
            _vision_setting(local_config, "vision_model", VISION_DEFAULT_MODEL),
        ).strip(),
        # 兼容旧版环境变量：新名 KNOWORIGIN_* 优先，未设置时回落 KNOWORIGIN_*。
        session_secret=os.getenv(
            "KNOWORIGIN_SESSION_SECRET", os.getenv("KNOWORIGIN_SESSION_SECRET", "")
        ).strip(),
        admin_password=os.getenv(
            "KNOWORIGIN_ADMIN_PASSWORD", os.getenv("KNOWORIGIN_ADMIN_PASSWORD", "")
        ).strip(),
        library_links=os.getenv(
            "KNOWORIGIN_LIBRARY_LINKS", os.getenv("KNOWORIGIN_LIBRARY_LINKS", "")
        ).strip()
        or DEFAULT_LIBRARY_LINKS,
        mineru_enabled=_resolve_mineru_enabled(
            os.getenv("MINERU_ENABLED", local_config.get("mineru_enabled", "auto")),
            os.getenv("MINERU_CLI", str(local_config.get("mineru_cli", "mineru"))),
        ),
        mineru_backend=_normalized_mineru_backend(
            os.getenv("MINERU_BACKEND", local_config.get("mineru_backend", "pipeline"))
        ),
        mineru_method=os.getenv(
            "MINERU_METHOD", str(local_config.get("mineru_method", "auto"))
        ).strip(),
        mineru_lang=os.getenv(
            "MINERU_LANG", str(local_config.get("mineru_lang", "ch"))
        ).strip(),
        mineru_cli=os.getenv(
            "MINERU_CLI", str(local_config.get("mineru_cli", "mineru"))
        ).strip(),
        mineru_timeout_seconds=_as_positive_float(
            os.getenv(
                "MINERU_TIMEOUT_SECONDS",
                local_config.get("mineru_timeout_seconds", "600"),
            ),
            600.0,
        ),
        mineru_skip_text_pdf=_as_bool(
            os.getenv(
                "MINERU_SKIP_TEXT_PDF",
                local_config.get("mineru_skip_text_pdf", "true"),
            )
        ),
        scanned_pdf_backend=_normalized_scanned_pdf_backend(
            os.getenv(
                "SCANNED_PDF_BACKEND",
                str(local_config.get("scanned_pdf_backend", "fast")),
            )
        ),
        tesseract_cmd=os.getenv(
            "TESSERACT_CMD", str(local_config.get("tesseract_cmd", ""))
        ).strip(),
        tesseract_lang=os.getenv(
            "TESSERACT_LANG", str(local_config.get("tesseract_lang", "chi_sim"))
        ).strip()
        or "chi_sim",
        usage_tracking_enabled=_as_bool(
            os.getenv(
                "KNOWORIGIN_USAGE_TRACKING",
                local_config.get("usage_tracking_enabled", "true"),
            )
        ),
        usage_daily_quota=_as_non_negative_int(
            os.getenv(
                "KNOWORIGIN_USAGE_DAILY_QUOTA",
                local_config.get("usage_daily_quota", "0"),
            ),
            0,
        ),
        memory_enabled=_as_bool(
            os.getenv(
                "KNOWORIGIN_MEMORY_ENABLED",
                local_config.get("memory_enabled", "true"),
            )
        ),
        notice_weekly_enabled=_as_bool(
            os.getenv(
                "KNOWORIGIN_NOTICE_WEEKLY",
                local_config.get("notice_weekly_enabled", "true"),
            )
        ),
    )


def _normalized_json_mode(value: str) -> str:
    normalized = (value or DEFAULT_TJU_JSON_MODE).strip().lower()
    return (
        normalized if normalized in {"auto", "force", "off"} else DEFAULT_TJU_JSON_MODE
    )


def _read_local_api_config(data_dir: Path) -> dict[str, str]:
    path = data_dir / "local_api_config.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def read_extra_local_secret(data_dir: Path, key: str) -> str:
    """读一项「模型之外」的本地凭据（例如微信读书的 ``wrk-`` Key）。

    与模型密钥走**同一个文件、同一套加密**（DPAPI 密文，非 Windows 退化为明文），
    所以「重启不用重填」这条对读书功能同样成立。读不到就返回空串。
    """
    payload = _read_local_api_config(data_dir)
    raw = payload.get(str(key) or "")
    if not isinstance(raw, str) or not raw.strip():
        return ""
    try:
        return _decode_secret(raw).strip()
    except Exception:
        return ""


def save_extra_local_secret(data_dir: Path, key: str, value: str) -> None:
    """把一项额外凭据写进 ``data/local_api_config.json``。

    与 ``save_local_api_config`` 用同一套落盘方式（加密 + 临时文件原子替换），
    但**不碰模型那几项** —— 两条凭据各写各的，不会互相覆盖。
    ``value`` 为空即删除该项（用户主动清空要能覆盖掉旧值）。
    """
    name = str(key or "").strip()
    if not name:
        raise ValueError("凭据名不能为空")
    data_dir.mkdir(parents=True, exist_ok=True)
    path = data_dir / "local_api_config.json"
    temporary = path.with_suffix(".tmp")
    payload = _read_local_api_config(data_dir)
    text = str(value or "").strip()
    if text:
        payload[name] = _encode_secret(text)
    else:
        payload.pop(name, None)
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def save_local_api_config(settings: Settings) -> None:
    """Persist local-only model settings, secrets included but encrypted.

    密钥**写盘但不明文**：data/ 已在 .gitignore 里，文件里存的是 DPAPI 密文
    （非 Windows 平台退化为明文）。这样重启服务后不必再粘一次密钥 ——
    这是「每次开都要重新配置」这个老毛病的根因修法。旧版本留在文件里的明文
    会在这次保存时被重新加密，升级过程不需要用户再动手。
    """

    settings.data_dir.mkdir(parents=True, exist_ok=True)
    path = settings.data_dir / "local_api_config.json"
    temporary = path.with_suffix(".tmp")
    payload = _read_local_api_config(settings.data_dir)
    payload.update(
        {
            "base_url": settings.tju_base_url,
            "model": settings.tju_model,
            "json_mode": _normalized_json_mode(settings.tju_json_mode),
            # 视觉字段必须**无条件写入**：清空后要能覆盖掉旧值，否则
            # 「关闭视觉模型」会因旧键残留而失效。
            "vision_base_url": settings.tju_vision_base_url,
            "vision_model": settings.tju_vision_model,
        }
    )
    # 密钥两项同样无条件写入：空串 = 用户主动清空，必须能覆盖掉旧值
    # （「留空不修改」在前端已经翻译成不传这两项，服务端到不了这里）。
    for _field, _value in (
        ("api_key", settings.tju_api_key),
        ("vision_api_key", settings.tju_vision_api_key),
    ):
        if _value:
            payload[_field] = _encode_secret(_value)
        else:
            payload.pop(_field, None)
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    temporary.replace(path)
