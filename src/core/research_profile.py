"""科研画像（Research Profile）：用户显式声明的研究兴趣与科研阶段。

两处设计约束：
  1. 多用户 —— 按 owner_id 分槽，存独立 SQLite 表；
  2. 画像只做「上下文」，与检索证据严格分离 —— 只注入深度分析 prompt，绝不混进
     论文元数据或检索结果。

画像驱动两个下游：
  - 相关度判定：深度分析时给出 direction_match_level（强/中/弱/不相关/无法判断）
    + relation_to_user_direction（与研究方向的关系）+ reading_recommendation（阅读建议）；
  - 缓存失效：profile_version 每次保存 +1，并进深度分析缓存 key —— 用户改了方向，
    旧 AI 分析自动失效重算，不必手动清缓存。

默认空画像：发布版不预置任何具体方向（预置某个方向会被误当通用默认）。
画像为空时深度分析诚实降级为「未配置画像，无法判断」，不做个性化相关性表述。
"""
from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

# 科研阶段枚举
STAGE_UNDERGRADUATE = "undergraduate"
STAGE_MASTER = "master"
STAGE_PHD = "phd"
STAGE_RESEARCHER = "researcher"
RESEARCH_STAGES = (
    STAGE_UNDERGRADUATE,
    STAGE_MASTER,
    STAGE_PHD,
    STAGE_RESEARCHER,
)
RESEARCH_STAGE_LABELS = {
    STAGE_UNDERGRADUATE: "本科生",
    STAGE_MASTER: "硕士生",
    STAGE_PHD: "博士生",
    STAGE_RESEARCHER: "研究员",
}

# 输出风格枚举
STYLE_BRIEF = "brief"
STYLE_NORMAL = "normal"
STYLE_DETAILED = "detailed"
OUTPUT_STYLES = (STYLE_BRIEF, STYLE_NORMAL, STYLE_DETAILED)

# 相关度等级（深度分析 LLM 输出枚举）
MATCH_STRONG = "strong"
MATCH_MEDIUM = "medium"
MATCH_WEAK = "weak"
MATCH_NONE = "none"
MATCH_UNKNOWN = "unknown"
DIRECTION_MATCH_LEVELS = (
    MATCH_STRONG,
    MATCH_MEDIUM,
    MATCH_WEAK,
    MATCH_NONE,
    MATCH_UNKNOWN,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS research_profiles (
    owner_id        TEXT PRIMARY KEY,
    payload         TEXT NOT NULL,
    profile_version INTEGER NOT NULL DEFAULT 1,
    updated_at      TEXT NOT NULL
);
"""


def default_profile() -> "ResearchProfile":
    """发布版默认画像：不含任何具体研究方向（须用户自行填写）。"""
    return ResearchProfile(
        research_area="",
        sub_direction=[],
        keywords=[],
        excluded_topics=[],
        research_stage=STAGE_UNDERGRADUATE,
        preferred_output_style=STYLE_NORMAL,
    )


@dataclass
class ResearchProfile:
    """用户科研画像（单用户一份，按 owner_id 隔离）。"""

    research_area: str = ""
    sub_direction: list[str] = field(default_factory=list)
    keywords: list[str] = field(default_factory=list)
    excluded_topics: list[str] = field(default_factory=list)
    research_stage: str = STAGE_UNDERGRADUATE
    preferred_output_style: str = STYLE_NORMAL
    profile_version: int = 1
    updated_time: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "research_area": self.research_area,
            "sub_direction": list(self.sub_direction),
            "keywords": list(self.keywords),
            "excluded_topics": list(self.excluded_topics),
            "research_stage": self.research_stage,
            "preferred_output_style": self.preferred_output_style,
            "profile_version": int(self.profile_version),
            "updated_time": self.updated_time,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "ResearchProfile":
        data = data or {}
        stage = str(data.get("research_stage") or STAGE_UNDERGRADUATE)
        if stage not in RESEARCH_STAGES:
            stage = STAGE_UNDERGRADUATE
        style = str(data.get("preferred_output_style") or STYLE_NORMAL)
        if style not in OUTPUT_STYLES:
            style = STYLE_NORMAL

        def _str_list(value: Any) -> list[str]:
            if not isinstance(value, list):
                return []
            return [str(v).strip() for v in value if str(v).strip()]

        return cls(
            research_area=str(data.get("research_area") or "").strip(),
            sub_direction=_str_list(data.get("sub_direction")),
            keywords=_str_list(data.get("keywords")),
            excluded_topics=_str_list(data.get("excluded_topics")),
            research_stage=stage,
            preferred_output_style=style,
            profile_version=int(data.get("profile_version") or 1),
            updated_time=str(data.get("updated_time") or ""),
        )

    def is_configured(self) -> bool:
        """画像是否已配置（领域/方向/关键词任一非空）。"""
        return bool(
            self.research_area.strip()
            or [s for s in self.sub_direction if s.strip()]
            or [k for k in self.keywords if k.strip()]
        )

    def bump_version(self) -> int:
        """保存时自增版本（触发深度分析缓存失效）。"""
        self.profile_version = int(self.profile_version or 0) + 1
        self.updated_time = time.strftime("%Y-%m-%dT%H:%M:%S")
        return self.profile_version

    def context_summary(self) -> str:
        """生成给 LLM 的用户研究上下文文本（不进检索证据）。"""
        parts = [f"研究领域：{self.research_area or '未提供'}"]
        if self.sub_direction:
            parts.append(f"主要方向：{'、'.join(self.sub_direction)}")
        if self.keywords:
            parts.append(f"关注关键词：{'、'.join(self.keywords)}")
        if self.excluded_topics:
            parts.append(f"暂不关注：{'、'.join(self.excluded_topics)}")
        stage = RESEARCH_STAGE_LABELS.get(self.research_stage, self.research_stage)
        parts.append(f"科研阶段：{stage}")
        return "；".join(parts)


class ResearchProfileStore:
    """科研画像持久化（独立表 research_profiles，与主链路零耦合）。"""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        if str(path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._conn.execute("PRAGMA busy_timeout = 5000")
        self._conn.executescript(SCHEMA)
        self._conn.commit()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        try:
            yield self._conn
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise

    def load(self, owner_id: str) -> ResearchProfile:
        """读取画像；缺失/损坏 → 返回默认空画像（不落盘）。"""
        row = self._conn.execute(
            "SELECT payload FROM research_profiles WHERE owner_id = ?", (owner_id,)
        ).fetchone()
        if row is None:
            return default_profile()
        try:
            data = json.loads(row["payload"])
            if isinstance(data, dict):
                return ResearchProfile.from_dict(data)
        except (json.JSONDecodeError, TypeError, ValueError):
            pass
        return default_profile()

    def save(self, owner_id: str, profile: ResearchProfile) -> ResearchProfile:
        """保存画像并自增版本。"""
        profile.bump_version()
        payload = json.dumps(profile.to_dict(), ensure_ascii=False)
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO research_profiles (owner_id, payload, profile_version, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(owner_id) DO UPDATE SET
                    payload = excluded.payload,
                    profile_version = excluded.profile_version,
                    updated_at = excluded.updated_at
                """,
                (owner_id, payload, profile.profile_version, profile.updated_time),
            )
        return profile
