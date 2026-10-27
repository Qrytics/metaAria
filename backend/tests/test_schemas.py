"""Unit tests: Pydantic v2 schema parsing for both chart modes."""

import pytest
from pydantic import ValidationError

from app.schemas import ChartSchema, CriticReportSchema, ViolationSchema


def _mania_chart(**over) -> dict:
    base = {
        "mode": "mania-4k",
        "title": "Test",
        "bpm": 128.0,
        "offset_ms": 0,
        "duration_ms": 5000,
        "notes": [
            {"time_ms": 0, "lane": 0},
            {"time_ms": 500, "lane": 3},
        ],
    }
    base.update(over)
    return base


def _pump_chart(**over) -> dict:
    base = {
        "mode": "pump-5pad",
        "title": "Test",
        "bpm": 140.0,
        "offset_ms": 0,
        "duration_ms": 5000,
        "notes": [
            {"time_ms": 0, "pad": "Q"},
            {"time_ms": 500, "pad": "S"},
            {"time_ms": 1000, "pad": "C"},
        ],
    }
    base.update(over)
    return base


def test_mania_chart_parses():
    chart = ChartSchema.model_validate(_mania_chart())
    assert chart.mode == "mania-4k"
    assert [n.lane for n in chart.notes] == [0, 3]


def test_pump_chart_parses_all_pads():
    notes = [{"time_ms": i * 500, "pad": p} for i, p in enumerate(["Q", "E", "S", "Z", "C"])]
    chart = ChartSchema.model_validate(_pump_chart(notes=notes))
    assert [n.pad for n in chart.notes] == ["Q", "E", "S", "Z", "C"]


def test_mania_rejects_pad_notes():
    with pytest.raises(ValidationError):
        ChartSchema.model_validate(_mania_chart(notes=[{"time_ms": 0, "pad": "Q"}]))


def test_pump_rejects_lane_notes_and_bad_pad():
    with pytest.raises(ValidationError):
        ChartSchema.model_validate(_pump_chart(notes=[{"time_ms": 0, "lane": 1}]))
    with pytest.raises(ValidationError):
        ChartSchema.model_validate(_pump_chart(notes=[{"time_ms": 0, "pad": "X"}]))


def test_notes_must_be_sorted():
    with pytest.raises(ValidationError):
        ChartSchema.model_validate(
            _mania_chart(notes=[{"time_ms": 500, "lane": 0}, {"time_ms": 100, "lane": 1}])
        )


def test_critic_report_schema_parses():
    report = CriticReportSchema.model_validate(
        {
            "passed": False,
            "chart_mode": "pump-5pad",
            "snap_violations": 1,
            "parity_violations": 0,
            "density_violations": 0,
            "violations": [
                {"type": "snap", "time_ms": 100, "message": "off grid", "severity": "error"}
            ],
        }
    )
    assert not report.passed
    assert report.violations[0].type == "snap"


def test_violation_requires_message():
    with pytest.raises(ValidationError):
        ViolationSchema.model_validate({"type": "snap"})
