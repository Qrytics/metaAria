"""Stage 5 tests: multipart audio/video ingest -> verified chart + telemetry.

All LLM stages run through the deterministic ENV=dev mock fallback (no API
keys), so the suite is $0-cost and hermetic. The WAV fixture is synthesized
locally with numpy/soundfile (no audio assets in the repo).
"""

from __future__ import annotations

import shutil

import pytest
from fastapi.testclient import TestClient

from app import ingest
from app.critic import MAX_CRITIC_RETRIES
from app.main import app

client = TestClient(app)

SR = 16_000


@pytest.fixture(autouse=True)
def dev_no_keys(monkeypatch):
    monkeypatch.setenv("ENV", "dev")
    monkeypatch.delenv("META_API_KEY", raising=False)
    monkeypatch.delenv("BASETEN_API_KEY", raising=False)


def make_click_wav(path, bpm: float = 120.0, beats: int = 16, sr: int = SR):
    """Write a 16kHz mono click track (sine pips on every beat)."""
    import numpy as np
    import soundfile as sf

    beat_s = 60.0 / bpm
    total_s = beats * beat_s
    n = int(total_s * sr)
    y = np.zeros(n, dtype=np.float32)
    pip_len = int(0.05 * sr)
    t = np.arange(pip_len) / sr
    pip = (0.8 * np.sin(2 * np.pi * 880.0 * t) * np.exp(-t * 60)).astype(np.float32)
    for b in range(beats):
        start = int(b * beat_s * sr)
        y[start : start + pip_len] += pip
    sf.write(str(path), y, sr, subtype="PCM_16")
    return path


def test_ingest_pump_happy_path(tmp_path):
    wav = make_click_wav(tmp_path / "song.wav")
    with open(wav, "rb") as fh:
        res = client.post(
            "/charts/ingest",
            files={"audio_file": ("song.wav", fh, "audio/wav")},
            data={"mode": "pump-5pad", "difficulty": "normal", "title": "Click Test"},
        )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["chart"]["mode"] == "pump-5pad"
    assert body["chart"]["title"] == "Click Test"
    assert body["report"]["passed"] is True
    assert body["attempts"] <= MAX_CRITIC_RETRIES
    assert body["bpm"] > 0
    assert body["duration_ms"] > 0
    assert len(body["chart"]["notes"]) > 0
    assert len(body["onset_times_ms"]) > 0
    # Vocal phrases exist and are sorted (beat-synced fallback, $0).
    starts = [p["start_ms"] for p in body["chart"]["vocal_phrases"]]
    assert len(starts) > 0
    assert starts == sorted(starts)
    # Stage art + telemetry contract for the rack progress bar.
    assert body["art"]["jacket_svg"].startswith("<svg")
    for key in ("dsp_ms", "transcribe_ms", "sam_ms", "draft_ms", "critic_ms"):
        assert body["telemetry"][key] >= 0
    assert body["mock"]["transcribe"] is True
    assert body["mock"]["draft"] is True


def test_ingest_mania_hard(tmp_path):
    wav = make_click_wav(tmp_path / "song.wav", bpm=100.0, beats=12)
    with open(wav, "rb") as fh:
        res = client.post(
            "/charts/ingest",
            files={"audio_file": ("song.wav", fh, "audio/wav")},
            data={"mode": "mania-4k", "difficulty": "hard", "title": "Hard Clicks"},
        )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["chart"]["mode"] == "mania-4k"
    assert all(n["lane"] in (0, 1, 2, 3) for n in body["chart"]["notes"])
    assert body["report"]["passed"] is True


def test_ingest_rejects_bad_audio_extension(tmp_path):
    wav = make_click_wav(tmp_path / "song.wav")
    with open(wav, "rb") as fh:
        res = client.post(
            "/charts/ingest",
            files={"audio_file": ("song.txt", fh, "text/plain")},
            data={"mode": "pump-5pad"},
        )
    assert res.status_code == 400


def test_ingest_rejects_bad_mode(tmp_path):
    wav = make_click_wav(tmp_path / "song.wav")
    with open(wav, "rb") as fh:
        res = client.post(
            "/charts/ingest",
            files={"audio_file": ("song.wav", fh, "audio/wav")},
            data={"mode": "ddr-8pad"},
        )
    assert res.status_code == 400


def test_ingest_rejects_bad_video_extension(tmp_path):
    wav = make_click_wav(tmp_path / "song.wav")
    with open(wav, "rb") as fh:
        res = client.post(
            "/charts/ingest",
            files={
                "audio_file": ("song.wav", fh, "audio/wav"),
                "video_file": ("clip.txt", b"not a video", "text/plain"),
            },
            data={"mode": "pump-5pad"},
        )
    assert res.status_code == 400


def test_ingest_with_video_clip(tmp_path):
    if shutil.which("ffmpeg") is None:
        pytest.skip("ffmpeg not on PATH")
    wav = make_click_wav(tmp_path / "song.wav")
    mp4 = tmp_path / "clip.mp4"
    proc = __import__("subprocess").run(
        ["ffmpeg", "-y", "-f", "lavfi",
         "-i", "testsrc=duration=2:size=160x120:rate=5",
         str(mp4)],
        capture_output=True,
    )
    if proc.returncode != 0:
        pytest.skip("ffmpeg testsrc failed")
    with open(wav, "rb") as afh, open(mp4, "rb") as vfh:
        res = client.post(
            "/charts/ingest",
            files={
                "audio_file": ("song.wav", afh, "audio/wav"),
                "video_file": ("clip.mp4", vfh, "video/mp4"),
            },
            data={"mode": "pump-5pad", "difficulty": "normal", "title": "AV Test"},
        )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["report"]["passed"] is True
    assert isinstance(body["motion_peaks_ms"], list)


def test_synthesizer_caps_density():
    grid = list(range(0, 2000, 50))  # 20 onsets/sec — over the 10/sec cap
    draft = ingest.synthesize_draft_chart(120.0, grid, [], [], "pump-5pad", "Dense", 2000, "hard")
    times = [n["time_ms"] for n in draft["notes"]]
    assert times == sorted(times)
    assert all(t in grid for t in times)  # snapped exactly to real onsets
    left = 0
    for right, t in enumerate(times):
        while times[left] < t - 1000:
            left += 1
        assert right - left + 1 <= 10


def test_mock_phrases_tile_and_align():
    phrases = ingest.mock_vocal_phrases_from_grid(
        [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000],
        4000,
        [0, 1000, 2000, 3000],
        [60, 64, 67, 0],
    )
    assert len(phrases) >= 1
    starts = [p["start_ms"] for p in phrases]
    assert starts == sorted(starts)
    for p in phrases:
        assert p["end_ms"] > p["start_ms"]
        assert p["speaker_id"] in ("SPEAKER_00", "SPEAKER_01")
        assert 0 <= p["midi_pitch"] <= 84
