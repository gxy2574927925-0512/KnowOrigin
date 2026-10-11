from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


CoverageStatus = Literal[
    "uncovered", "covered", "insufficient_source", "missing_prerequisite"
]
LearningStatus = Literal[
    "unexplored", "encountered", "pending_confirmation", "learning", "mastered"
]
ExamWeight = Literal[
    "exam_critical", "exam_important", "exam_normal", "exam_basic", "exam_skip"
]
SourceStatus = Literal["ok", "empty", "unsupported", "parse_error", "ocr_unavailable"]
FavoriteType = Literal["card", "quiz", "question"]


class ApiError(BaseModel):
    code: str
    message: str
    retryable: bool = False


class ProjectCreate(BaseModel):
    year: str = Field("", max_length=32)
    subject: str = Field(..., min_length=1, max_length=80)


class LiteratureUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    tags: list[str] | None = None
    last_position: float | None = Field(default=None, ge=0.0, le=1.0)
    reading_time_delta: int | None = Field(default=None, ge=0)


class ReadingProgressUpdate(BaseModel):
    last_position: float | None = Field(default=None, ge=0.0, le=1.0)
    reading_time_delta: int | None = Field(default=None, ge=0)


class LiteratureMarkUpdate(BaseModel):
    """文献标注写入：kind 见 api_server 的 _LITERATURE_MARK_KINDS，slot 默认空串。"""

    kind: str = Field(min_length=1, max_length=40)
    slot: str = Field(default="", max_length=200)
    payload: Any = None


class TranslateRequest(BaseModel):
    source_text: str | None = Field(default=None, min_length=1)
    segment_id: str | None = Field(default=None, max_length=80)


class TranslatePdfRequest(BaseModel):
    """版式保真全文翻译请求。

    pages 形如 "1-10" / "1,3,5"，留空翻整本（30 页约 30+ 分钟，慎点）。
    """

    source_id: str | None = Field(default=None, max_length=80)
    pages: str | None = Field(default=None, max_length=120)
    force: bool = False


class LinkSpreadRequest(BaseModel):
    """整页对照里「这一栏选中的文字，对面那栏对应哪几行」的定位请求。

    side 指用户**选中**的那一侧（left=原文页 / right=译文页），
    start/end 是该侧文本层行号（闭区间），与 /spread、/pages 返回的行序一致。
    """

    source_id: str | None = Field(default=None, max_length=80)
    pages: str | None = Field(default=None, max_length=120)
    index: int = Field(default=0, ge=0, le=100000)
    side: str = Field(default="left", max_length=8)
    start: int = Field(default=0, ge=0, le=100000)
    end: int = Field(default=0, ge=0, le=100000)


class AskRequest(BaseModel):
    question: str | None = Field(default=None, min_length=1, max_length=2000)


class CompareRequest(BaseModel):
    project_ids: list[str] = Field(..., min_length=2, max_length=4)


class SourceViewExplainRequest(BaseModel):
    """来源视图里点某个节点要 AI 解释的请求。

    kind 决定解释对象：concept=知识点节点、source=资料节点、note=用户自己的笔记节点。
    id 与 kind 对应（node_id / source_id / favorite_id），三者共用一个端点。
    """

    kind: Literal["concept", "source", "note"] = "concept"
    id: str = Field(..., min_length=1, max_length=160)


class AttachLiteratureRequest(BaseModel):
    """把文献阅读结论并入课程知识网的请求。

    literature_project_ids 只用来取论文标题（拼进来源文件名），不复制论文正文；
    report 是已经生成好的对比报告正文，会被落成课程项目下的一条「影子来源」。
    """

    literature_project_ids: list[str] = Field(default_factory=list, max_length=4)
    report: str = Field(..., min_length=1)


class ApiSettingsUpdate(BaseModel):
    api_key: str | None = Field(default=None, max_length=512)
    base_url: str = Field(..., min_length=8, max_length=500)
    model: str = Field(..., min_length=1, max_length=120)
    # 视觉模型（扫描件 / 拍照讲义识别）为可选覆盖项：
    # None = 不修改；空串 = 显式关闭（模型）/ 回落到主配置（地址、密钥）。
    vision_model: str | None = Field(default=None, max_length=120)
    vision_base_url: str | None = Field(default=None, max_length=500)
    vision_api_key: str | None = Field(default=None, max_length=512)
    admin_override: bool = Field(default=False, description="管理员强制解锁（调试用）")


class SessionApiConfig(BaseModel):
    """浏览器把本地保管的密钥下发到本机服务内存（**不回写凭据文件**）。

    主存储是 data/local_api_config.json（加密落盘，由 PUT /api/config 写入），
    这个端点只负责把它补进内存，让本次运行立刻可用 —— 每次刷新页面都会发一遍，
    为此回写磁盘纯属白折腾。字段可选：只覆盖传了的那一项，没传的保持现状。
    """

    api_key: str | None = Field(default=None, max_length=512)
    vision_api_key: str | None = Field(default=None, max_length=512)


class AuthCredentials(BaseModel):
    email: str = Field(..., min_length=3, max_length=254)
    password: str = Field(..., min_length=8, max_length=128)
    name: str | None = Field(default=None, max_length=80)


class AdminCredentials(BaseModel):
    password: str = Field(..., min_length=1, max_length=256)


class User(BaseModel):
    user_id: str
    email: str
    name: str
    created_at: datetime
    last_seen_at: datetime | None = None


class Project(BaseModel):
    project_id: str
    owner_id: str | None = None
    year: str
    subject: str
    project_type: str = "course"
    tags: list[str] = Field(default_factory=list)
    last_position: float = 0.0
    last_opened_at: datetime | None = None
    total_reading_seconds: int = 0
    created_at: datetime


class SourceCreate(BaseModel):
    filename: str
    mime_type: str = "application/octet-stream"
    size_bytes: int = 0
    text: str = ""
    formulas: list[dict[str, Any]] = Field(default_factory=list)
    figures: list[dict[str, Any]] = Field(default_factory=list)
    status: SourceStatus = "ok"
    error_message: str | None = None
    ocr_used: bool = False


class Source(SourceCreate):
    source_id: str
    project_id: str
    created_at: datetime


class ExtractedSource(SourceCreate):
    pass


class FrameworkNode(BaseModel):
    node_id: str
    parent_id: str | None = None
    name: str
    description: str = ""
    coverage_status: CoverageStatus = "covered"
    learning_status: LearningStatus = "unexplored"
    mastery_score: float = Field(default=0.0, ge=0.0, le=1.0)
    # 迁移分：与 mastery_score 分开的第二个数字。mastery 记「记住了多少」，
    # transfer 记「换个情境还用不用得上」。默认 0 = 迁移未验证（不猜）。
    transfer_score: float = Field(default=0.0, ge=0.0, le=1.0)
    source_ids: list[str] = Field(default_factory=list)
    prerequisite_ids: list[str] = Field(default_factory=list)
    exam_weight: ExamWeight = "exam_normal"
    # 个人知识库（Obsidian 式）扩展字段
    note_content: str = ""
    tags: list[str] = Field(default_factory=list)
    wikilinks: list[str] = Field(default_factory=list)


class NoteUpdate(BaseModel):
    """个人知识库：节点笔记/标签/双链更新请求。"""

    note_content: str | None = Field(default=None, max_length=20000)
    tags: list[str] | None = Field(default=None, max_length=50)
    wikilinks: list[str] | None = Field(default=None, max_length=200)


class NoteRenderRequest(BaseModel):
    """解析笔记正文中的 Obsidian 双链 [[名|别名]]。"""

    text: str = Field(..., max_length=20000)


class LinkNoteUpdate(BaseModel):
    """双链「理解」：为一对双链写一句关系说明（无序节点对，两端任意顺序均可）。"""

    a_node_id: str = Field(..., min_length=1, max_length=120)
    b_node_id: str = Field(..., min_length=1, max_length=120)
    note: str = Field(default="", max_length=500)


class LinkNoteSuggest(BaseModel):
    """请求 AI 为某对双链起草一句「理解」。"""

    a_node_id: str = Field(..., min_length=1, max_length=120)
    b_node_id: str = Field(..., min_length=1, max_length=120)
    hint: str = Field(default="", max_length=200)




class NodeCardRequest(BaseModel):
    difficulty: int | None = Field(default=None, ge=1, le=3)
    category: str | None = Field(default=None, max_length=20)
    count: int | None = Field(default=None, ge=1, le=8)


class NodeQuizRequest(BaseModel):
    difficulty: int | None = Field(default=None, ge=1, le=3)
    question_types: list[str] | None = None
    question_count: int | None = Field(default=None, ge=1, le=10)




class NodeCorrection(BaseModel):
    node_id: str
    action: Literal["confirm", "reassign", "remove", "cover", "edit", "delete"]
    target_node_id: str | None = None
    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=2000)


class FrameworkNodeCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    description: str = Field(default="", max_length=2000)
    parent_id: str | None = None
    source_ids: list[str] = Field(default_factory=list)


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1)
    # 由桌面宠"海小棠"代提的问题：正文仍为原始问题，不注入任何可见前缀，
    # 仅用于让后端以温柔陪伴口吻作答
    pet: bool = False
    node_ids: list[str] = Field(default_factory=list)
    source_ids: list[str] | None = None
    conversation_id: str | None = None
    mode: Literal["default", "organize", "guide"] = "default"
    node_id: str | None = None
    focus_node_id: str | None = None
    # 主界面对话区是否走 Function Calling 工具循环（/chat/stream 专用开关）。
    # False = 保持原样：一次性拼检索片段、单次模型调用（纯对话框行为，可完整回退）。
    agent: bool = False


class SolveRequest(BaseModel):
    problem: str = Field(..., min_length=1)
    node_ids: list[str] = Field(default_factory=list)
    source_ids: list[str] | None = None
    # 用户自报的做对程度（0~1）；None 表示未判断，走默认正确度
    correctness: float | None = Field(default=None, ge=0.0, le=1.0)
    # 归属的主界面会话（Agent 布局的「每个项目多个会话」）；空串=项目默认单线程
    conversation_id: str | None = None


# ── 迁移题（换个情境试试）────────────────────────────────────────────────


class TransferRequest(BaseModel):
    """请求一道渐进式对齐的迁移题。"""

    # 迁移距离档。None = 由后端按节点位阶与前置情况**推荐**一档并如实回传，
    # 前端展示的是「系统给你选的这档 + 为什么」，不是「你以为的难度」。
    distance: Literal["near", "mid", "far"] | None = None
    # 显式指定知识点；为空则由后端挑本项目最该补迁移证据的那个节点。
    node_id: str | None = None


class TransferSubmitRequest(BaseModel):
    attempt_id: str = Field(..., min_length=1, max_length=80)
    answer: str = Field(default="", max_length=20000)
    # 自评 0~4，口径与 CardSelfRating.recall 一致。
    # 迁移题**一定**是开放题（要人写出对齐过程），所以判分必然依赖自评；
    # 这里不设默认值 —— 没勾就是没勾，不替用户猜。
    self_rating: int | None = Field(default=None, ge=0, le=4)
    self_confidence: float | None = Field(default=None, ge=0.0, le=1.0)


class ConceptAlignRequest(BaseModel):
    """请求把本项目术语对齐到已知概念清单（跨学科对齐，默认不跑）。"""

    # 不传 = 全项目；传了只对齐这几个节点。
    node_ids: list[str] = Field(default_factory=list)


class ProposalActionRequest(BaseModel):
    status: Literal["accepted", "rejected", "edited"]
    content: str | None = None


class ImportTjuRequest(BaseModel):
    """从 superpung/TJU-CourseSharing 拉取指定课程的 README.md 作为项目 source。

    code 与 name 至少传一个（code 优先）。README 不存在时端点返回 imported=False，
    不会创建空 source 污染项目。
    """

    code: str | None = None
    name: str | None = None


# 单文件上限（30MB）/ 单批上限（150MB）/ 递归深度上限（3 层）
# —— 防止大课目录把 FastAPI 拉超时
MAX_TJU_FILE_BYTES = 30 * 1024 * 1024
MAX_TJU_BATCH_BYTES = 150 * 1024 * 1024
MAX_TJU_RECURSIVE_DEPTH = 3


class ImportTjuFolderRequest(BaseModel):
    """从 superpung/TJU-CourseSharing 拉取指定课程目录下用户勾选的文件。

    paths 为空时退化为仅拉 README.md（与旧 ImportTjuRequest 行为一致），
    保证向后兼容。

    版权声明：调用前调用方必须在 UI 上明示「该操作涉及批量下载第三方仓库资料，
    使用者自负版权风险，开发者与平台不承担任何责任」，仅响应具有此明确授权的请求。
    """

    code: str | None = None
    name: str | None = None
    # 来自 list_tju_course_files 返回的 path 字段（相对仓库根）
    paths: list[str] = Field(default_factory=list)
    include_readme: bool = True
    # 是否自动拉取 Markdown/文本文件中相对链接指向的文件
    include_linked: bool = True


class CardSelfRating(BaseModel):
    """知识卡片自测反馈。recall 值含义：
    0 = 完全不会 / 1 = 想错了 / 2 = 模糊 / 3 = 会了 / 4 = 非常熟
    会被归一化到 0.00 / 0.25 / 0.55 / 0.85 / 1.00 作为掌握度 correctnes。
    """

    recall: int = Field(..., ge=0, le=4)


class CitationLocation(BaseModel):
    source_id: str
    quote: str = ""


class AnswerSegment(BaseModel):
    text: str
    source_ids: list[str] = Field(default_factory=list)
    citations: list[CitationLocation] = Field(default_factory=list)




class Card(BaseModel):
    card_id: str | None = None
    front: str
    back: str
    category: str = "概念"
    difficulty: int = Field(default=1, ge=1, le=3)
    source_ids: list[str] = Field(default_factory=list)
    node_ids: list[str] = Field(default_factory=list)
    # 这张卡来自知识点文档的哪一节（标题原文，如「自测」）。空串 = 与文档无关，
    # 前端据此决定要不要显示「回到文档」。配合 node_ids[0] 就能定位到文档里那一段，
    # 所以不需要另存 doc_key —— 文档按节点寻址，节点 id 已经是全部所需。
    origin_section: str = ""




class CardGenerateRequest(BaseModel):
    source_ids: list[str] | None = None
    difficulty: int | None = Field(default=None, ge=1, le=3)


class QuizGenerateRequest(BaseModel):
    source_ids: list[str] | None = None
    difficulty: int | None = Field(default=None, ge=1, le=3)
    # 用户自选题型；为空/None 时由系统按 type_diversity 默认多元混合出题。
    # 合法值与 QuizQuestion.type 一致；choice 视作 single_choice、fill 视作 fill_blank。
    question_types: list[str] | None = None


class QuizQuestion(BaseModel):
    question: str
    type: Literal[
        "choice",  # 单选题（向后兼容别名 = single_choice）
        "single_choice",  # 单选题
        "multiple_choice",  # 多选题（2~4 个正确选项）
        "indefinite_choice",  # 不定项选择题（1~4 个正确，可能单可能多）
        "fill",  # 填空题（向后兼容别名 = fill_blank）
        "fill_blank",  # 填空题
        "short_answer",  # 简答题
        "calculation",  # 计算题（含数值/公式推导，答案含具体数值+单位）
    ] = "choice"
    options: list[str] = Field(default_factory=list)
    answer: str
    explanation: str = ""
    difficulty: int = Field(default=1, ge=1, le=3)
    node_ids: list[str] = Field(default_factory=list)
    source_ids: list[str] = Field(default_factory=list)
    # 认知层级（布鲁姆 6 级）。此前端点要求模型回填它、schema 侧却没有这个字段，
    # 于是模型填了也接不住、落库即丢 —— 结果是「学情按认知层级分布」永远做不了。
    # 现在补上，缺省空串 = 未标注（老题与没标注的模型输出都归这里，不猜）。
    cognitive_level: str = ""
    # 迁移距离档（near/mid/far）。只有「换个情境试试」出的迁移题才带；
    # 普通题留空。与 difficulty 正交：难度是题面属性，距离是表征/领域属性。
    transfer_distance: str = ""
    # 题干指纹：由出题侧按题干归一后算好落进来，供边际递减判断「第几遍」。
    # 不在出题时算，是因为「同一道题」的定义必须由**出题口径**决定，
    # 事后从库里反推（strip 后比字符串）会与出题时的避让规则漂移。
    item_fingerprint: str = ""


class Quiz(BaseModel):
    quiz_id: str
    questions: list[QuizQuestion]
    source_ids: list[str] = Field(default_factory=list)
    fallback: bool = False
    created_at: datetime | None = None


class QuizSubmitRequest(BaseModel):
    answers: list[str]
    # 困难档（评价/创造）开放题由用户自评 0~4（0=完全不会…4=非常熟），长度应与 answers 一致；
    # 缺省/为 None 的项回退为自动判对（保持老客户端向后兼容）。
    self_ratings: list[int | None] = Field(default_factory=list)
    # 每题作答时顺手勾的把握度：1.0 = 我确定，0.0 = 我不确定，None = 没勾/跳过。
    # 允许整份缺省、允许比 answers 短 —— 老客户端一个都不发，长度不齐只在对应位当 None，
    # 绝不能为「长度不一致」报 422（那是把兼容性问题变成可用性问题）。
    # 语义：这是**学习者自己说的**，与 learning_events.confidence（LLM 的节点映射置信度）无关。
    self_confidences: list[float | None] = Field(default_factory=list)


class PrereqApplyEdge(BaseModel):
    node_id: str
    prerequisite_ids: list[str] = Field(default_factory=list)


class PrereqApplyRequest(BaseModel):
    """确认落库一批补建的前置边。

    只收「节点 → 要追加哪些前置」，不做删除 —— 补建是 AI 建议 + 人工确认的动作，
    落库走的是**并集**，已有的（可能是用户自己标的）前置不会被删。
    """

    edges: list[PrereqApplyEdge] = Field(default_factory=list)


class QuizErrorTypeRequest(BaseModel):
    """给某一道**已经提交过的**题补写错因。

    error_type 取 framework.ERROR_TYPES 的键（或 None = 清除/没选）。
    取值校验在端点里做，这样错误信息能带上「有哪些合法值」，而不是 pydantic 的默认报错。
    """

    error_type: str | None = None




class StudyItemRename(BaseModel):
    title: str = Field(..., min_length=1, max_length=500)


class Message(BaseModel):
    message_id: str
    project_id: str
    role: Literal["user", "assistant"]
    content: str
    node_ids: list[str] = Field(default_factory=list)
    source_ids: list[str] = Field(default_factory=list)
    conversation_id: str = ""
    meta: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


class MessageDeleteRequest(BaseModel):
    message_ids: list[str] = Field(..., min_length=1, max_length=8)


class FavoriteCreate(BaseModel):
    item_type: FavoriteType
    origin_id: str = Field(..., min_length=1, max_length=160)
    answer_id: str | None = Field(default=None, max_length=80)


class FavoriteUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    chapter_name: str | None = Field(default=None, min_length=1, max_length=80)
    note: str | None = Field(default=None, max_length=1000)
    highlight_color: str | None = Field(default=None, max_length=20)


class FavoriteItem(BaseModel):
    favorite_id: str
    project_id: str
    item_type: FavoriteType
    origin_id: str
    title: str
    content: str
    answer: str = ""
    chapter_node_id: str | None = None
    chapter_name: str = "未归类"
    note: str = ""
    highlight_color: str = "none"
    node_ids: list[str] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


def model_to_dict(model: BaseModel) -> dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump(mode="json")
    return model.dict()
