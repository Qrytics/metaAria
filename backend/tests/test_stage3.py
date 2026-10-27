"""Stage 3 tests: SAM air-pad, Voice Director remix, Muse Image stage art.

All LLM calls run through the deterministic ENV=dev mock fallback (no API
keys), so the suite is $0-cost and hermetic.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import llm
from app.critic import MAX_CRITIC_RETRIES
from app.main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def dev_no_keys(monkeypatch):
    monkeypatch.setenv("ENV", "dev")
    monkeypatch.delenv("META_API_KEY", raising=False)
    monkeypatch.delenv("BASETEN_API_KEY", raising=False)


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


# --- model IDs + prompt-caching contract ---


def test_stage3_model_ids_are_exact():
    assert llm.SAM_MODEL == "sam-3.1"
    assert llm.IMAGE_MODEL == "muse-image"
    assert llm.SAM_DEFAULT_PROMPT == "hands and feet"
    assert llm.SAM_OVERDRIVE_PROMPT == "raised hands overdrive pose"


def test_stage3_system_prompts_carry_no_dynamic_song_data():
    for prompt in (
        llm.SAM_SYSTEM_PROMPT,
        llm.DIRECTOR_SYSTEM_PROMPT,
        llm.IMAGE_SYSTEM_PROMPT,
    ):
        assert "SONG DATA" not in prompt
        assert "REMIX TARGET" not in prompt
        assert "STAGE ART TARGET" not in prompt
        assert "onset_times_ms" not in prompt


def test_director_user_message_holds_dynamic_payload():
    msg = llm.build_director_user_message(_pump_chart(), "faster", [0, 500])
    assert "faster" in msg
    assert "onset_times_ms" in msg
    assert llm.DIRECTOR_SYSTEM_PROMPT.splitlines()[0] not in msg


# --- SAM 3.1 air-pad ---


def test_mock_sam_default_pose_tracks_hands_no_overdrive():
    dets, overdrive = llm.mock_sam_detections("hands and feet")
    assert overdrive is False
    assert {d["label"] for d in dets} == {"left hand", "right hand"}
    zones = llm._detections_to_hit_zones(dets, overdrive)
    by_pad = {z["pad"]: z for z in zones}
    assert by_pad["Q"]["triggered"] and by_pad["E"]["triggered"]
    assert by_pad["OVERDRIVE"]["triggered"] is False


def test_mock_sam_overdrive_pose_sets_2x_state():
    dets, overdrive = llm.mock_sam_detections("raised hands overdrive pose")
    assert overdrive is True
    zones = llm._detections_to_hit_zones(dets, overdrive)
    by_pad = {z["pad"]: z for z in zones}
    assert by_pad["OVERDRIVE"]["triggered"] is True
    assert by_pad["OVERDRIVE"]["confidence"] == 1.0


def test_sam_segment_endpoint_mock_shape():
    res = client.post(
        "/vision/sam-segment",
        json={"prompt": "hands and feet", "mode": "pump-5pad"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["mock"] is True
    assert body["model"] == "sam-3.1"
    assert len(body["boxes"]) == 2
    assert len(body["masks"]) == 2
    assert all(len(m["polygon"]) >= 3 for m in body["masks"])
    assert {z["pad"] for z in body["hit_zones"]} == {"Q", "E", "S", "Z", "C", "OVERDRIVE"}
    assert body["overdrive_active"] is False


def test_sam_segment_endpoint_overdrive_prompt():
    res = client.post(
        "/vision/sam-segment",
        json={"prompt": "raised hands overdrive pose", "mode": "pump-5pad"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["overdrive_active"] is True


# --- Voice AI Chart Director ---


def test_mock_remix_snaps_and_doubles_bpm():
    chart = _pump_chart(notes=[
        {"time_ms": 12, "pad": "Q"},   # off-grid by 12ms
        {"time_ms": 500, "pad": "S"},
    ])
    out = llm.mock_remix_chart(chart, "twice as fast", [0, 500, 1000])
    assert out["bpm"] == pytest.approx(280.0)
    assert [n["time_ms"] for n in out["notes"]] == [0, 500]
    assert out["title"].endswith("(Director Remix)")


def test_mock_remix_crossover_cycle_alternates_feet():
    chart = _pump_chart(notes=[{"time_ms": i * 500, "pad": "Q"} for i in range(5)])
    out = llm.mock_remix_chart(chart, "more crossovers", [i * 500 for i in range(5)])
    assert [n["pad"] for n in out["notes"]] == ["Q", "C", "Z", "E", "S"]


def test_voice_remix_endpoint_happy_path():
    onsets = [0, 500, 1000]
    res = client.post(
        "/director/voice-remix",
        json={
            "chart": _pump_chart(),
            "onset_times_ms": onsets,
            "command_text": "Make the chorus twice as fast with more crossovers",
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["attempts"] <= MAX_CRITIC_RETRIES
    assert body["report"]["passed"] is True
    assert body["chart"]["bpm"] == pytest.approx(280.0)
    assert any("bpm" in line for line in body["diff_log"])
    assert "crossovers" in body["command"].lower() or "chorus" in body["command"].lower()


def test_upload_audio_endpoint_stores_blob(tmp_path):
    res = client.post(
        "/director/upload-audio",
        files={"file": ("director.webm", b"fake-audio-bytes", "audio/webm")},
    )
    assert res.status_code == 200, res.text
    audio_path = res.json()["audio_path"]
    assert audio_path.endswith(".webm")
    with open(audio_path, "rb") as fh:
        assert fh.read() == b"fake-audio-bytes"


def test_voice_remix_endpoint_requires_command_or_audio():
    res = client.post(
        "/director/voice-remix",
        json={"chart": _pump_chart(), "onset_times_ms": [0]},
    )
    assert res.status_code == 400


def test_voice_remix_endpoint_missing_audio_is_400():
    res = client.post(
        "/director/voice-remix",
        json={
            "chart": _pump_chart(),
            "onset_times_ms": [0],
            "audio_path": "/nonexistent/mic.wav",
        },
    )
    assert res.status_code == 400


# --- Muse Image reactive stage ---


def test_stage_art_endpoint_procedural_fallback():
    res = client.post(
        "/stage/generate-art",
        json={"title": "Neon Run", "style_prompt": "neon cyberpunk arcade stage"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["mock"] is True
    assert body["model"] == "muse-image"
    assert body["jacket_svg"].startswith("<svg")
    assert body["background_svg"].startswith("<svg")
    assert "Neon Run" in body["jacket_svg"]
    assert len(body["palette"]) == 4


def test_stage_art_shortens_titles_at_word_boundaries():
    assert llm._shorten("Synth Groove (5-pad sample)", 26) == "Synth Groove (5-pad…"
    assert llm._shorten("Neon Run", 26) == "Neon Run"


def test_stage_art_is_deterministic_per_seed():
    first = client.post("/stage/generate-art", json={"title": "T"}).json()
    second = client.post("/stage/generate-art", json={"title": "T"}).json()
    assert first["jacket_svg"] == second["jacket_svg"]
    other = client.post("/stage/generate-art", json={"title": "T", "seed": 8}).json()
    assert other["jacket_svg"] != first["jacket_svg"]
