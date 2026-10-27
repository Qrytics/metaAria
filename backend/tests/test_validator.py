"""Unit tests: deterministic validator (±15ms snap, 5-pad parity, density)."""

from app.critic import MAX_CRITIC_RETRIES, run_critic_loop
from app.llm import CRITIC_MODEL_DEV, CRITIC_MODEL_PROD, RouterConfig
from app.schemas import ChartSchema
from app.validator import (
    DENSITY_MAX_NOTES,
    SNAP_TOLERANCE_MS,
    validate_chart,
)


def _mania_note(t: int, lane: int = 0) -> dict:
    return {"time_ms": t, "lane": lane}


def _pad_note(t: int, pad: str) -> dict:
    return {"time_ms": t, "pad": pad}


def _mania_chart(notes) -> ChartSchema:
    return ChartSchema.model_validate(
        {
            "mode": "mania-4k",
            "title": "T",
            "bpm": 120.0,
            "duration_ms": 60_000,
            "notes": notes,
        }
    )


def _pump_chart(notes) -> ChartSchema:
    return ChartSchema.model_validate(
        {
            "mode": "pump-5pad",
            "title": "T",
            "bpm": 140.0,
            "duration_ms": 60_000,
            "notes": notes,
        }
    )


def test_snap_tolerance_boundary():
    assert SNAP_TOLERANCE_MS == 15
    onsets = [1000, 2000]
    ok = _mania_chart([_mania_note(985), _mania_note(2015)])
    assert validate_chart(ok, onsets).passed
    bad = _mania_chart([_mania_note(1016)])
    report = validate_chart(bad, [1000])
    assert not report.passed
    assert report.snap_violations == 1
    assert report.violations[0].type == "snap"


def test_snap_exact_onset_passes():
    chart = _mania_chart([_mania_note(2000)])
    assert validate_chart(chart, [2000]).passed


def test_parity_ignores_mania_mode():
    chart = _mania_chart([_mania_note(t) for t in (0, 50, 100, 150)])
    report = validate_chart(chart, [0, 50, 100, 150])
    assert report.parity_violations == 0


def test_parity_flags_same_foot_fast_travel():
    # Q (left) then E (right) would alternate feet — no violation.
    ok = _pump_chart([_pad_note(0, "Q"), _pad_note(500, "E")])
    assert validate_chart(ok, [0, 500]).parity_violations == 0
    # Q -> Z both left-foot pads within 150ms: same-foot fast travel.
    bad = _pump_chart([_pad_note(0, "Q"), _pad_note(100, "Z")])
    report = validate_chart(bad, [0, 100])
    assert report.parity_violations >= 1
    assert any(v.type == "parity" for v in report.violations)


def test_parity_flags_three_consecutive_same_foot():
    # Q, Q, Q → left foot 3x in a row.
    chart = _pump_chart([_pad_note(t, "Q") for t in (0, 500, 1000)])
    report = validate_chart(chart, [0, 500, 1000])
    assert report.parity_violations >= 1


def test_density_flags_overcrowded_window():
    notes = [_mania_note(t * 50, lane=t % 4) for t in range(DENSITY_MAX_NOTES + 1)]
    onsets = [n["time_ms"] for n in notes]
    report = validate_chart(_mania_chart(notes), onsets)
    assert report.density_violations >= 1


def test_critic_retry_cap_is_three():
    assert MAX_CRITIC_RETRIES == 3


def test_critic_loop_passes_without_llm_call():
    chart = _mania_chart([_mania_note(1000)])
    calls: list = []

    def audit_fn(*_a, **_k):
        calls.append(1)
        raise AssertionError("LLM should not be called for a clean chart")

    final, report, attempts = run_critic_loop(chart, [1000], audit_fn=audit_fn)
    assert report.passed and attempts == 0 and calls == []
    assert final == chart


def test_critic_loop_retries_until_cap():
    chart = _pump_chart([_pad_note(0, "Q"), _pad_note(100, "Z")])
    calls: list = []

    def audit_fn(draft, violations, _cfg):
        calls.append(1)
        return {"passed": False, "fixed_chart": None, "violations": violations}

    _, report, attempts = run_critic_loop(chart, [0, 100], audit_fn=audit_fn)
    assert attempts == MAX_CRITIC_RETRIES == len(calls)
    assert not report.passed


def test_critic_loop_accepts_llm_fix():
    bad = _pump_chart([_pad_note(0, "Q"), _pad_note(100, "Z")])
    fixed = _pump_chart([_pad_note(0, "Q"), _pad_note(500, "E")]).model_dump()

    def audit_fn(_draft, _violations, _cfg):
        return {"passed": True, "fixed_chart": fixed, "violations": []}

    final, report, attempts = run_critic_loop(bad, [0, 500], audit_fn=audit_fn)
    assert report.passed and attempts == 1
    assert [n.pad for n in final.notes] == ["Q", "E"]


def test_critic_model_selection_dev_vs_prod():
    dev = RouterConfig(
        meta_api_key=None, baseten_api_key=None,
        meta_base_url="x", baseten_base_url="y", env="dev",
    )
    prod = RouterConfig(
        meta_api_key=None, baseten_api_key=None,
        meta_base_url="x", baseten_base_url="y", env="prod",
    )
    assert dev.critic_model == CRITIC_MODEL_DEV == "muse-spark-1.3-contributor"
    assert prod.critic_model == CRITIC_MODEL_PROD == "muse-wonder-1.0"
