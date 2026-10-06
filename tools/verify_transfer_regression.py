"""迁移（泛化）链路回归：计分 → 出题 → 提交 → 跨项目 → 推荐位。

这个脚本存在的理由：本次改动动了**掌握度的计分公式**，而掌握度是这个产品
最不能错的那一个数字。所以每一条约束都写成断言，而不是靠人记得：

1. **刷分漏洞真的堵住了**：4 道 D1 识记题不能再把节点顶到 mastered
   （改动前 4×0.228 = 0.912 ≥ 0.80，一遍 D1 就「掌握了」）。
2. **D3 与 D1 不再等价**：同一节点，D3 的单次增益必须显著高于 D1。
3. **同题边际递减**：同一指纹连做，增益单调下降。
4. **衰减不自伤**：长期不复习的节点显示为衰减，但**库里���累加值一个字节没动**
   —— 这一点是「零数据迁移」承诺的硬保证，必须钉死。
5. **回放等于真值**：可解释下钻（compute_mastery_breakdown）加总出来的分数
   必须与库里 mastery_score 相符。回放与写入不同算式 ⇒ 审计面板对用户说谎。
6. **迁移分与记忆分分离**：做迁移题只加 transfer_score，mastery_score 不动。
7. **渐进式对齐是硬约束**：模型不给逐项对齐表 ⇒ 整题判废（不出「像迁移」的题）。
8. **跨项目概念对齐只合并本地能确认的**：不同名不合并；跨项目视图只收 ≥2 项目命中的。
9. **推荐位把迁移排在复习前面**：会了但不迁移的节点应落进 transfer 桶。
10. **提示词任务名与目录一致**：api_server 用字面量调 complete_json，
    必须与 transfer.TRANSFER_TASK_NAME 同名，否则提示词实验室里改不动。

不需要模型、不需要 key：全程本地临时库。
跑法：python tools/verify_transfer_regression.py
"""

from __future__ import annotations

import sys
import tempfile
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from core import transfer as T  # noqa: E402
from core import progress_engine as PE  # noqa: E402
from core.concept_graph import ConceptStore  # noqa: E402
from core.database import Database  # noqa: E402
from core.framework import (  # noqa: E402
    MASTERY_THRESHOLD_MASTERED,
    compute_mastery_breakdown,
    mastery_evidence_rules,
    record_evidence,
)
from core.models import FrameworkNode  # noqa: E402

FAILURES: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail else ''}")
    if not ok:
        FAILURES.append(name)


def seed(db: Database, pid: str, name: str, prereqs: list[str] | None = None) -> str:
    node = FrameworkNode(
        node_id=f"n_{name}",
        name=name,
        description=f"{name} 的说明",
        source_ids=[],
        prerequisite_ids=list(prereqs or []),
    )
    db.upsert_framework_nodes(pid, [node])
    return node.node_id


def quiz(db: Database, pid: str, nid: str, *, difficulty: int, fp: str) -> float:
    """记一次「测验答对」，返回本次增量。"""
    before = db.get_framework_node(pid, nid).mastery_score
    record_evidence(
        db,
        pid,
        [nid],
        "quiz",
        1.0,
        0.95,
        reference_id=f"q:{nid}:{fp}",
        difficulty=difficulty,
        item_fingerprint=fp,
    )
    return db.get_framework_node(pid, nid).mastery_score - before


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="knoworigin-transfer-"))
    db = Database(tmp / "transfer.sqlite3")
    project = db.create_project("2026", "激光原理")
    pid = project.project_id

    # ── 0. 常数自检：单调性一旦被改坏，这里先炸 ────────────────────────────
    try:
        checks = T.math_sanity()
        check("常数自检（难度递增 / 递减单调 / 衰减有下限）", True, str(checks))
    except AssertionError as exc:
        check("常数自检", False, str(exc))
        return 1

    # ── 1. 刷分漏洞：4 道 D1 不能再到 mastered ─────────────────────────────
    a = seed(db, pid, "受激辐射")
    for index in range(4):
        quiz(db, pid, a, difficulty=1, fp=f"a-d1-{index}")
    node = db.get_framework_node(pid, a)
    check(
        "4 道 D1 识记题不再顶到 mastered",
        node.learning_status != "mastered" and node.mastery_score < MASTERY_THRESHOLD_MASTERED,
        f"score={node.mastery_score:.4f} status={node.learning_status}",
    )

    # ── 2. D3 与 D1 不再等价 ──────────────────────────────────────────────
    gain_d1 = quiz(db, pid, a, difficulty=1, fp="a-d1-x")
    gain_d3 = quiz(db, pid, a, difficulty=3, fp="a-d3-x")
    check(
        "D3 单次增益显著高于 D1",
        gain_d3 > gain_d1 * 2,
        f"d1={gain_d1:.5f} d3={gain_d3:.5f}",
    )

    # ── 3. 同题边际递减 ───────────────────────────────────────────────────
    c = seed(db, pid, "增益递减")
    gains = [quiz(db, pid, c, difficulty=3, fp="SAME") for _ in range(4)]
    check(
        "同一题连做 4 次，增益单调递减",
        all(gains[i] > gains[i + 1] for i in range(len(gains) - 1)),
        " > ".join(f"{g:.5f}" for g in gains),
    )

    # ── 4. 衰减只在读取时生效，不改存储 ────────────────────────────────────
    raw = db.get_framework_node(pid, a).mastery_score
    view = T.effective_mastery(raw, elapsed_days=30.0, stability=7.0)
    check("衰减后有效分低于累计分", view["effective"] < view["raw"], str(view))
    check("衰减有下限，不会归零", view["effective"] >= raw * T.DECAY_FLOOR - 1e-9, str(view))
    check(
        "库里累加值未被衰减改写（零数据迁移）",
        db.get_framework_node(pid, a).mastery_score == raw,
        f"db={raw:.6f}",
    )
    check(
        "长期未复习不会算出复数",
        T.retention_multiplier(9999.0) >= T.DECAY_FLOOR - 1e-9,
        f"r={T.retention_multiplier(9999.0)}",
    )

    # ── 5. 回放必须等于真值 ───────────────────────────────────────────────
    breakdown = compute_mastery_breakdown(db, pid, [a])[a]
    replayed = sum(v for k, v in breakdown["contributions"].items() if k != "baseline")
    check(
        "回放加总 ≈ 库里真值（可解释下钻不说谎）",
        abs(replayed - breakdown["total_score"]) < 0.02,
        f"replay={replayed:.4f} total={breakdown['total_score']:.4f} baseline={breakdown['contributions'].get('baseline', 0):.4f}",
    )
    check(
        "下钻里同时给出累计分与此刻分",
        "raw" in breakdown and "effective" in breakdown and "decay_note" in breakdown,
        breakdown.get("decay_note", "")[:70],
    )

    # ── 6. 迁移分与记忆分彻底分离 ──────────────────────────────────────────
    before_mastery = db.get_framework_node(pid, a).mastery_score
    transfer_scores = []
    for index in range(3):
        record_evidence(
            db,
            pid,
            [a],
            "quiz",
            1.0,
            0.95,
            reference_id=f"t:{index}",
            difficulty=3,
            repeat_count=index,
            target="transfer",
            transfer_distance="far",
        )
    node = db.get_framework_node(pid, a)
    check(
        "做迁移题不碰 mastery_score",
        abs(node.mastery_score - before_mastery) < 1e-9,
        f"before={before_mastery:.6f} after={node.mastery_score:.6f}",
    )
    transfer_scores.append(node.transfer_score)
    check(
        "迁移分只涨到「迁移待验证」（3 道 far 不够「得动」）",
        node.transfer_score > 0 and node.transfer_score < T.TRANSFER_THRESHOLD_SOLID,
        f"{node.transfer_score:.4f} stage={T.transfer_stage(node.transfer_score)}",
    )
    for index in range(3, 8):
        record_evidence(
            db,
            pid,
            [a],
            "quiz",
            1.0,
            0.95,
            reference_id=f"t:{index}",
            difficulty=3,
            repeat_count=index,
            target="transfer",
            transfer_distance="far",
        )
    node = db.get_framework_node(pid, a)
    check(
        "连续 8 道 far 之后才到「迁移得动」",
        T.transfer_stage(node.transfer_score) == "solid",
        f"{node.transfer_score:.4f}",
    )
    check(
        "迁移分低置信度节点映射一律不加（同一道闸门）",
        T.transfer_gain(correctness=1.0, confidence=0.3, distance="far") == 0.0,
    )
    check(
        "correctness=None 时迁移分不加（没判分≠答对）",
        T.transfer_gain(correctness=None, confidence=0.95, distance="far") == 0.0,
    )

    # ── 7. 渐进式对齐是硬约束 ─────────────────────────────────────────────
    good = {
        "distance": "far",
        "source_example": "受激辐射的源例：泵浦把粒子推到高能级，随后一个光子触发级联发射。",
        "target_example": "换领域的新情境：另一个系统里先积累势能，再由最小扰动触发放大输出。",
        "question": "这两个过程为什么是同一件事？各自的触发条件在哪一步成立？",
        "alignment": [
            {"source_step": "泵浦建立粒子数反转", "target_step": "先积累可释放的势能", "why": "都是先把系统推离平衡"},
            {"source_step": "一个光子引发级联发射", "target_step": "最小扰动触发放大输出", "why": "都是靠小扰动跨过阈值"},
            {"source_step": "输出与入射同频同相", "target_step": "输出与扰动保持同步", "why": "都要求相位锁定"},
        ],
        "answer_points": ["先建立非平衡", "小扰动触发", "相位锁定", "两者是同构过程"],
        "source_ids": ["src_1"],
    }
    cleaned = T.normalize_transfer_task(good)
    check("合规迁移题通过校验", cleaned is not None and len(cleaned["alignment"]) == 3)
    for label, broken in (
        ("缺对齐表", {**good, "alignment": []}),
        ("对齐步数不足 3", {**good, "alignment": good["alignment"][:2]}),
        ("某一步缺 why", {**good, "alignment": [{**good["alignment"][0], "why": ""}, *good["alignment"][1:]]}),
        ("某一步右侧为空", {**good, "alignment": [{**good["alignment"][0], "target_step": ""}, *good["alignment"][1:]]}),
        ("采分点不足 3 条", {**good, "answer_points": ["只有一条"]}),
        ("题干为空", {**good, "question": ""}),
    ):
        check(f"不合规迁移题被判废：{label}", T.normalize_transfer_task(broken) is None)

    # ── 8. 跨项目概念对齐：只合并能确认的 ──────────────────────────────────
    project_b = db.create_project("2026", "信号处理")
    pid_b = project_b.project_id
    db.upsert_framework_nodes(
        pid, [FrameworkNode(node_id="n_1", name="傅里叶变换", description="甲项目里的它")]
    )
    db.upsert_framework_nodes(
        pid_b,
        [
            FrameworkNode(node_id="n_1", name="傅里叶变换", description="乙项目里的它"),
            FrameworkNode(node_id="n_2", name="时域分析", description="只在一个项目里出现"),
        ],
    )

    store = ConceptStore(db.path)
    try:
        aligned_a = store.align_project(
            owner_id="user_legacy",
            project_id=pid,
            nodes=[
                {
                    "node_id": "n_1",
                    "name": "傅里叶变换",
                    "layer": 1,
                    "mastery": 0.8,
                    "transfer_score": 0.0,
                    "prereq_count": 1,
                }
            ],
        )
        aligned_b = store.align_project(
            owner_id="user_legacy",
            project_id=pid_b,
            nodes=[
                {
                    "node_id": "n_1",
                    "name": "傅里叶变换",
                    "layer": 1,
                    "mastery": 0.5,
                    "transfer_score": 0.0,
                    "prereq_count": 0,
                },
                {
                    "node_id": "n_2",
                    "name": "时域分析",
                    "layer": 0,
                    "mastery": 0.2,
                    "transfer_score": 0.0,
                    "prereq_count": 0,
                },
            ],
        )
        check("同名概念在两个项目里被对齐到同一个键", aligned_a["concepts"] >= 1)
        check("不同名概念不被强行合并", aligned_b["concepts"] == 2, str(aligned_b))

        view = store.cross_project_view(owner_id="user_legacy")
        names = [item["name"] for item in view["concepts"]]
        check("跨项目视图只收 ≥2 个项目命中的概念", len(view["concepts"]) == 1, str(names))
        check(
            "跨项目视图同时给出各项目的掌握度与迁移分",
            len(view["concepts"][0]["projects"]) == 2
            and "transfer" in view["concepts"][0]["projects"][0],
            str(view["concepts"][0]["projects"]),
        )

        # 迁移证据制造一个「别处验过、这边没验过」的缺口
        store.record_attempt(
            owner_id="user_legacy",
            project_id=pid,
            node_id="n_1",
            distance="far",
            payload={"question": "换个情境试试"},
        )
        store.submit_attempt(
            attempt_id=store.recent_attempts(project_id=pid, limit=1)[0]["attempt_id"],
            answer="先建立非平衡再触发",
            correctness=1.0,
        )
        # 队列门槛是「≥0.75 才算验实」，所以这里连做 4 道 far
        for _index in range(4):
            record_evidence(
                db,
                pid,
                ["n_1"],
                "quiz",
                1.0,
                0.95,
                reference_id=f"tq:{_index}",
                difficulty=3,
                repeat_count=_index,
                target="transfer",
                transfer_distance="far",
            )
        store.align_project(
            owner_id="user_legacy",
            project_id=pid,
            nodes=[
                {
                    "node_id": "n_1",
                    "name": "傅里叶变换",
                    "layer": 1,
                    "mastery": 0.8,
                    "transfer_score": db.get_framework_node(pid, "n_1").transfer_score,
                    "prereq_count": 1,
                }
            ],
        )
        store.align_project(
            owner_id="user_legacy",
            project_id=pid_b,
            nodes=[
                {
                    "node_id": "n_1",
                    "name": "傅里叶变换",
                    "layer": 1,
                    "mastery": 0.5,
                    "transfer_score": 0.0,
                    "prereq_count": 0,
                },
                {
                    "node_id": "n_2",
                    "name": "时域分析",
                    "layer": 0,
                    "mastery": 0.2,
                    "transfer_score": 0.0,
                    "prereq_count": 0,
                },
            ],
        )
        queue = store.transfer_queue(owner_id="user_legacy")
        check(
            "泛化队列给出「别处验过、这边没验过」的同一概念",
            any("傅里叶变换" in item["name"] for item in queue["items"]),
            str([item["name"] for item in queue["items"]]),
        )
        check(
            "已提交的迁移题不能重复计分",
            store.submit_attempt(
                attempt_id=store.recent_attempts(project_id=pid, limit=1)[0]["attempt_id"],
                answer="再来一次",
                correctness=1.0,
            )
            is None,
        )
        check(
            "概念别名可追加且不覆盖规范名",
            store.add_alias(concept_key=view["concepts"][0]["concept_key"], alias="傅里叶分析")
            and store.add_alias(concept_key="不存在的键", alias="x") is False,
        )
    finally:
        store.close()

    # ── 9. 推荐位：会了但不迁移的节点应落进 transfer 桶 ────────────────────
    # 给「受激辐射」补一个前置：没有前置就出不了组合题，
    # 按设计它就不该进迁移桶（见 transfer_gap_score 的 has_prereq 判据）。
    seed(db, pid, "粒子数反转")
    db.add_framework_prerequisites(pid, a, ["n_粒子数反转"])
    plan = PE.plan(db.path, "user_legacy", pid, limit=6)
    buckets = {step["bucket"] for step in plan["steps"]}
    check(
        "推荐位出现「换个情境」桶",
        "transfer" in buckets,
        str(sorted(buckets)),
    )
    transfer_step = next((s for s in plan["steps"] if s["bucket"] == "transfer"), None)
    check(
        "迁移桶的动作是开迁移弹窗（不是再出几道题）",
        bool(transfer_step) and transfer_step["action"] == "open-transfer",
        transfer_step["action"] if transfer_step else "(无)",
    )
    check(
        "迁移桶排在复习桶前面",
        PE.BUCKET_ORDER.index("transfer") < PE.BUCKET_ORDER.index("review"),
        " > ".join(PE.BUCKET_ORDER),
    )
    check(
        "进步引擎摘要里带迁移三档计数",
        "counts" in (plan.get("transfer") or {}),
        str((plan.get("transfer") or {}).get("counts")),
    )
    check(
        "没有前置的节点不进迁移桶（出不了组合题就别推）",
        PE.transfer_module.transfer_gap_score(
            stage="get", transfer_score=0.0, has_prereq=False, due_cards=0
        )
        == 0,
    )

    # ── 10. 权威配置与实现一致 ────────────────────────────────────────────
    rules = mastery_evidence_rules()
    check(
        "规则接口如实写出难度系数与新鲜度系数",
        rules["difficulty_factors"] == {1: 0.5, 2: 1.0, 3: 1.6}
        and "difficulty_factor" in rules["formula"]
        and "freshness_factor" in rules["formula"],
        rules["formula"],
    )
    check(
        "规则接口给出衰减与迁移阈值",
        rules["decay"]["floor"] == T.DECAY_FLOOR
        and rules["transfer"]["thresholds"]["solid"] == T.TRANSFER_THRESHOLD_SOLID,
    )
    source = (ROOT / "src" / "api_server.py").read_text(encoding="utf-8-sig")
    check(
        "api_server 的出题任务名与 transfer 常量一致（提示词实验室可改）",
        f'"{T.TRANSFER_TASK_NAME}"' in source and f'"{T.CONCEPT_ALIGN_TASK_NAME}"' in source,
    )
    catalog = (ROOT / "src" / "core" / "prompt_catalog.py").read_text(encoding="utf-8-sig")
    check(
        "两个新任务都在提示词目录里登记",
        f'"task": "{T.TRANSFER_TASK_NAME}"' in catalog
        and f'"task": "{T.CONCEPT_ALIGN_TASK_NAME}"' in catalog,
    )

    # ── 11. 交错计划：跨节点才叫交错 ──────────────────────────────────────
    chosen = T.pick_interleaved(["a", "b", "c", "d", "e", "f"], limit=3, seed=7)
    check("交错选取返回 3 项且互不相同", len(chosen) == 3 and len(set(chosen)) == 3, str(chosen))
    check(
        "交错选取是确定性的（同 seed 同结果，刷新不换人）",
        chosen == T.pick_interleaved(["a", "b", "c", "d", "e", "f"], limit=3, seed=7),
    )
    check("候选不足 2 个时不返回交错计划", len(T.pick_interleaved(["a"], limit=3, seed=1)) == 1)
    check(
        "层差 ≥1 ⇒ 判为需要组合题",
        T.migration_distance_from_layers(3, [1]) is True
        and T.migration_distance_from_layers(3, [3]) is False,
    )
    check(
        "D3 开放题自评上限被压到 0.85（自评不该拿满分）",
        _self_ceiling_ok(),
    )

    db.close()
    _smoke_endpoints(tmp)
    if FAILURES:
        print(f"\n回归未通过：{len(FAILURES)} 条")
        for item in FAILURES:
            print(f"  - {item}")
        return 1
    print("\n迁移链路回归全通过。")
    return 0


def _smoke_endpoints(tmp: Path) -> None:
    """端到端冒烟：注册 → 建项目 → 造框架 → 迁移 readiness / task / submit / concepts / queue。

    用注入的假模型（``LlmClient(settings, responder=...)``）替代真模型：
    既不花钱也能把**路由、鉴权、校验、落库**这一整条链路走通。
    没有这一段的话，上面所有断言都只在 core 层成立，
    而「端点挂错路径被通配段抢走」这类问题恰恰是本仓库踩过的坑
    （见 api_server 里 /api/review/status 的注释）。
    """
    from fastapi.testclient import TestClient  # noqa: PLC0415

    from api_server import create_app  # noqa: PLC0415
    from config import Settings  # noqa: PLC0415
    from core.llm import LlmClient  # noqa: PLC0415

    calls: list[str] = []

    def fake(task: str, payload: dict) -> dict:
        calls.append(task)
        if task == T.TRANSFER_TASK_NAME:
            return {
                "transfer": {
                    "distance": payload.get("target_distance", "near"),
                    "source_example": "源例：先建立粒子数反转，再由一个光子触发级联发射。",
                    "target_example": "新情境：先积累势能，再由最小扰动触发放大输出。",
                    "question": "这两个过程为什么是同一件事？触发条件分别在哪一步成立？",
                    "alignment": [
                        {
                            "source_step": "泵浦建立粒子数反转",
                            "target_step": "先积累可释放的势能",
                            "why": "都先把系统推离平衡",
                        },
                        {
                            "source_step": "一个光子引发级联发射",
                            "target_step": "最小扰动触发放大输出",
                            "why": "都靠小扰动跨过阈值",
                        },
                        {
                            "source_step": "输出与入射同频同相",
                            "target_step": "输出与扰动保持同步",
                            "why": "都要求相位锁定",
                        },
                    ],
                    "answer_points": [
                        "先建立非平衡",
                        "小扰动触发",
                        "相位锁定",
                        "两者同构",
                    ],
                    "source_ids": [],
                }
            }
        return {}

    settings = Settings(
        tju_api_key="fake-key-for-smoke",
        tju_base_url="https://example.invalid/api",
        tju_model="tju-llm",
        data_dir=tmp,
        usage_tracking_enabled=False,
    )
    app_db = Database(tmp / "smoke.sqlite3")
    client = TestClient(
        create_app(app_db, settings, llm_client=LlmClient(settings, responder=fake))
    )
    client.post(
        "/api/auth/register",
        json={"email": "tf@e.com", "password": "abcd1234", "name": "迁移"},
    )
    pid = client.post("/api/projects", json={"year": "2026", "subject": "激光原理"}).json()[
        "project_id"
    ]
    prereq_node = app_db.add_framework_node(pid, name="粒子数反转", description="前置")
    target = app_db.add_framework_node(pid, name="受激辐射", description="目标")
    # 必须显式传 prereq 的 id：add_framework_prerequisites 会过滤自指，
    # 而 list_framework_nodes 的顺序不保证第一个就是前置（曾因此踩过）。
    app_db.add_framework_prerequisites(pid, target.node_id, [prereq_node.node_id])
    # 把它推到「会了」，迁移桶才可能有候选
    for index in range(3):
        record_evidence(
            app_db,
            pid,
            [target.node_id],
            "quiz",
            1.0,
            0.95,
            reference_id=f"pre:{index}",
            difficulty=2,
            item_fingerprint=f"pre-fp-{index}",
        )

    ready = client.get(f"/api/transfer/{pid}/readiness")
    check("GET /api/transfer/{pid}/readiness 返回 200", ready.status_code == 200, ready.text[:120])
    body = ready.json()
    check(
        "readiness 推荐了一个候选节点并说明理由",
        body.get("recommended_node_id") == target.node_id
        and bool((body.get("recommendation") or {}).get("reason")),
        str(body.get("recommendation")),
    )
    check(
        "readiness 给出了该节点的前置名与层号",
        (body.get("target") or {}).get("prereq_names") == ["粒子数反转"]
        and int((body.get("target") or {}).get("layer", -1)) == 1,
        str(body.get("target")),
    )
    check(
        "readiness 给出了三档距离与它们的说明",
        len(body.get("distances") or []) == 3
        and all(item.get("hint") for item in body["distances"]),
    )
    # 兜底：一个节点都没有到「会了」时，界面不能就此什么都不显示 ——
    # 否则刚开始学的项目永远看不到这个能力（实测踩过：候选为空 ⇒ 入口消失）。
    # 走端点建项目（create_project 默认属主是 user_legacy，与本客户端的会话用户不同，
    # 直接调 core 的方法会得到 project_not_found —— 那是测试写错，不是功能问题）。
    bare_pid = client.post(
        "/api/projects", json={"year": "2026", "subject": "刚建的项目"}
    ).json()["project_id"]
    bare_pre = app_db.add_framework_node(bare_pid, name="前置甲", description="d")
    bare_target = app_db.add_framework_node(bare_pid, name="目标乙", description="d")
    app_db.add_framework_prerequisites(
        bare_pid, bare_target.node_id, [bare_pre.node_id]
    )
    bare_body = client.get(f"/api/transfer/{bare_pid}/readiness").json()
    check(
        "没有节点到「会了」时仍给出可手挑的候选",
        bare_body.get("recommended_node_id") is None
        and bare_body.get("has_recommendation") is False
        and any(
            item["node_id"] == bare_target.node_id
            for item in bare_body.get("candidates") or []
        ),
        str(bare_body.get("candidates")),
    )
    bare_node = client.get(
        f"/api/transfer/{bare_pid}/readiness", params={"node_id": bare_target.node_id}
    )
    check(
        "显式指定节点时 readiness 照样可用（推荐不是许可）",
        bare_node.status_code == 200
        and (bare_node.json().get("target") or {}).get("node_id") == bare_target.node_id,
        bare_node.text[:120],
    )

    made = client.post(
        f"/api/transfer/{pid}/task", json={"node_id": target.node_id}
    )
    check("POST /api/transfer/{pid}/task 返回 200", made.status_code == 200, made.text[:200])
    task_body = made.json()
    check(
        "出题确实调了 transfer_variant 任务",
        T.TRANSFER_TASK_NAME in calls,
        str(calls),
    )
    check(
        "返回的对齐表不少于最小步数",
        len((task_body.get("task") or {}).get("alignment") or [])
        >= T.MIN_ALIGNMENT_STEPS,
        str(len((task_body.get("task") or {}).get("alignment") or [])),
    )

    attempt_id = task_body.get("attempt_id")
    check("返回了 attempt_id", bool(attempt_id), str(attempt_id))

    no_rating = client.post(
        f"/api/transfer/{pid}/submit",
        json={"attempt_id": attempt_id, "answer": "写了对应关系"},
    )
    check(
        "不自评就提交会被拒（迁移题没标准答案）",
        no_rating.status_code == 422,
        f"status={no_rating.status_code}",
    )

    submitted = client.post(
        f"/api/transfer/{pid}/submit",
        json={"attempt_id": attempt_id, "answer": "写了对应关系", "self_rating": 3},
    )
    check(
        "提交成功并计入迁移分",
        submitted.status_code == 200
        and float(submitted.json().get("transfer_score") or 0) > 0,
        submitted.text[:160],
    )
    check(
        "响应里带下一步该做什么（诚实优先）",
        bool(submitted.json().get("next_hint")),
        str(submitted.json().get("next_hint"))[:70],
    )

    again = client.post(
        f"/api/transfer/{pid}/submit",
        json={"attempt_id": attempt_id, "answer": "再写一遍", "self_rating": 4},
    )
    check(
        "重复提交同一道题不重复计分",
        again.status_code == 200 and again.json().get("already_submitted") is True,
        again.text[:120],
    )

    # ---- 历史：每一道都要留痕，且能原样取回 ----
    second = client.post(
        f"/api/transfer/{pid}/task", json={"node_id": target.node_id, "distance": "mid"}
    ).json()
    hist = client.get(f"/api/transfer/{pid}/attempts")
    check(
        "GET /api/transfer/{pid}/attempts 返回全部历史",
        hist.status_code == 200 and len(hist.json()["items"]) == 2,
        str(hist.json().get("total")),
    )
    items = hist.json()["items"]
    check(
        "历史带「第几道」且序号与总数对得上",
        sorted(i["seq"] for i in items) == [1, 2] and items[0]["total"] == 2,
        str([(i["seq"], i["total"]) for i in items]),
    )
    check(
        "历史区分已答 / 未答并带自评折算",
        sum(1 for i in items if i["answered"]) == 1
        and any(i["correctness"] == 0.85 for i in items),
        str([(i["answered"], i["correctness"]) for i in items]),
    )
    check(
        "历史带距离档与题干摘要",
        all(i["distance"] in ("near", "mid", "far") for i in items)
        and all(i["question"] for i in items),
        str([(i["distance"], i["question"][:18]) for i in items]),
    )
    detail = client.get(
        f"/api/transfer/{pid}/attempts/{second['attempt_id']}"
    )
    check(
        "历史单条能原样取回（含完整对齐表）",
        detail.status_code == 200
        and len((detail.json().get("task") or {}).get("alignment") or [])
        == T.MIN_ALIGNMENT_STEPS
        and detail.json()["answered"] is False,
        detail.text[:140],
    )
    check(
        "重开历史里已作答的那道时如实标为已答",
        client.get(f"/api/transfer/{pid}/attempts/{attempt_id}").json()["answered"]
        is True,
    )
    other_pid = client.post(
        "/api/projects", json={"year": "2026", "subject": "别的项目"}
    ).json()["project_id"]
    check(
        "别的项目取不到这一项目的迁移题",
        client.get(f"/api/transfer/{other_pid}/attempts/{attempt_id}").status_code
        == 404,
    )
    ready_hist = client.get(f"/api/transfer/{pid}/readiness").json()
    check(
        "readiness 顺带带回历史（面板一次请求就够）",
        len(ready_hist.get("history") or []) == 2
        and ready_hist.get("history_total") == 2,
        str(ready_hist.get("history_total")),
    )

    concepts = client.get(f"/api/transfer/{pid}/concepts")
    check(
        "GET /api/transfer/{pid}/concepts 返回 200 且不抛",
        concepts.status_code == 200,
        concepts.text[:120],
    )
    queue = client.get("/api/transfer/queue")
    check(
        "GET /api/transfer/queue 返回 200（不被 /api/transfer/{project_id}/… 抢路由）",
        queue.status_code == 200,
        queue.text[:120],
    )
    rules = client.get(f"/api/projects/{pid}/mastery/rules")
    check(
        "mastery/rules 里出现了难度系数（新前端靠它解释增益）",
        rules.status_code == 200 and "difficulty_factors" in rules.json(),
        rules.text[:120],
    )
    _check_frontend_submit_flow()
    app_db.close()


def _check_frontend_submit_flow() -> None:
    """钉住静态/transfer-ui.js 的提交状态机。

    为什么用「读源码 + 断言」而不是跑真实 DOM：这个 bug（提交成功后
    ``task.loading`` 没复位 ⇒ 弹窗永远停在「正在出题」）当时的症状是
    「点了提交一直加载没有反应」—— 纯视觉、纯交互，本地无浏览器环境跑不出来。
    于是退一步：把状态机的关键赋值钉成断言。谁再把 ``.loading = false``
    从 then 分支里删掉，这里立刻红。

    同时钉住排版约定：字号必须走 ``--text-*`` 阶梯，
    否则设置里的「字体大小」对这个面板无效（写死 px 曾经就是这么错的）。
    """
    ui = (ROOT / "static" / "transfer-ui.js").read_text(encoding="utf-8")

    def _then_block(marker: str) -> str:
        head = ui.find(marker)
        if head < 0:
            return ""
        stop = ui.find("})\n      .catch", head)
        return ui[head : stop if stop > 0 else head + 900]

    submit_block = _then_block('api("/api/transfer/" + encodeURIComponent')
    check(
        "提交/出题的 then 分支里复位了 loading（否则永远转圈）",
        submit_block.count("task.loading = false") >= 1,
        submit_block[:160].replace("\n", " "),
    )
    check(
        "提交成功有独立的结果态（不会被重渲染冲掉）",
        "task.result" in ui and "task.result = result" in ui,
    )
    # 从 submitTask 函数本身开始找：同一串 api("/api/transfer/…/submit") 的
    # 兄弟调用在 generateTask 里出现过，只按字符串取会抓到错的那个块。
    fn_at = ui.find("function submitTask()")
    submit_fn = ui[fn_at : fn_at + 2600] if fn_at >= 0 else ""
    catch_at = submit_fn.find(".catch(function (error)")
    catch_block = submit_fn[catch_at:] if catch_at >= 0 else ""
    check(
        "提交失败保留题目内容（不让人把一屏答案重写一遍）",
        bool(catch_block)
        and "task.loading = false" in catch_block
        and "task.data = null" not in catch_block,
        catch_block[:120].replace("\n", " "),
    )
    gen_at = ui.find("function generateTask(options)")
    # 窗口给足：出题函数里多了 pointer 落盘/轮询，窗口太窄会切在 catch 之前，
    # 于是「catch 里到底清没清 task.data」这件事根本没被检查到（假绿）。
    gen_fn = ui[gen_at : gen_at + 3200] if gen_at >= 0 else ""
    gen_catch = gen_fn[gen_fn.find(".catch(function (error)") :]
    check(
        "出题失败清空题目（不能留一道不合规的半成品）",
        "task.loading = false" in gen_catch
        and "task.data = null" in gen_catch
        and "status: \"\"" in gen_catch,
        gen_catch[:100].replace("\n", " "),
    )
    check(
        "出题请求发出前先落 pointer（在途状态要能跨刷新恢复）",
        "status: \"generating\"" in gen_fn[: gen_fn.find("api(\"/api/transfer/\"") + 400],
    )
    check(
        "字号走 --text-* 阶梯（设置里的字体大小才生效）",
        "font-size: 13px" not in ui
        and "font-size: 11px" not in ui
        and "var(--text-base" in ui
        and "var(--text-lg" in ui,
    )
    check(
        "弹窗铺满全屏 + 左右双栏（长题不会把采分点/提交按钮顶走）",
        "height: 100dvh" in ui
        and "grid-template-columns: minmax(0, 1.15fr) minmax(340px, .85fr)" in ui
        and "ko-tf-col-read" in ui
        and "ko-tf-col-write" in ui,
    )
    check(
        "小字说明收进原生 details（可折叠、键盘可达）",
        "<details class=\"ko-tf-more\">" in ui and "ko-tf-more-body" in ui,
    )
    check(
        "空采集不覆盖已记住的展开状态（否则刷新后说明永远折回去）",
        "if (collected.length) moreOpenKeys = collected;" in ui,
    )
    check(
        "三档迁移各有语义色（不给未验证上重色）",
        ui.count("--tf-s0") >= 2 and ui.count("--tf-s1") >= 2 and ui.count("--tf-s2") >= 2,
    )
    check(
        "从历史打开必须走 openModal（否则关掉不回学习概览 —— 实报 bug）",
        "openModal(" in ui.split('var reopen = target.closest("[data-ko-tf-attempt]")')[1][:600]
        and "hidden = false" not in ui.split('var reopen = target.closest("[data-ko-tf-attempt]")')[1][:600],
    )


def _self_ceiling_ok() -> bool:
    """api_server 里的自评上限常量必须是 0.85，且自评映射表不得超过它。"""
    source = (ROOT / "src" / "api_server.py").read_text(encoding="utf-8-sig")
    if "_SELF_ASSESSED_TRANSFER_CEILING = 0.85" not in source:
        return False
    if "_SELF_RATING_CORRECTNESS = (0.00, 0.25, 0.55, 0.85, 1.00)" not in source:
        return False
    # D3 开放题的 evidence_kind 必须是 quiz（不是 card）
    return 'evidence_kind = "quiz"' in source


if __name__ == "__main__":
    sys.exit(main())