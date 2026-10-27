"""Stage 2.5 tests: vocal schemas, F0→MIDI DSP, phrase alignment, validator."""

from __future__ import annotations

import math
import wave
from collections import Counter
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.dsp import (
    PitchContour,
    align_phrase_pitches,
    extract_pitch_contour,
    freq_to_midi,
    midi_to_freq,
)
from app.schemas import ChartSchema
from app.validator import check_vocals


def _mania_notes(n: int = 2) -> list[dict]:
    return [{"time_ms": i * 500, "lane": i % 4} for i in range(n)]


def _chart(vocal_phrases: list[dict]) -> ChartSchema:
    return ChartSchema.model_validate(
        {
            "mode": "mania-4k",
            "title": "T",
            "bpm": 120.0,
            "duration_ms": 60_000,
            "notes": _mania_notes(),
            "vocal_phrases": vocal_phrases,
        }
    )


def _phrase(text="Hey", speaker="SPEAKER_00", start=0, end=500, midi=69) -> dict:
    return {
        "text": text,
        "speaker_id": speaker,
        "start_ms": start,
        "end_ms": end,
        "midi_pitch": midi,
    }


# --- freq ↔ MIDI conversion ---


def test_freq_to_midi_reference_pitches():
    assert freq_to_midi(440.0) == 69  # A4
    assert freq_to_midi(261.63) == 60  # C4 (rounds correctly)
    assert freq_to_midi(midi_to_freq(64)) == 64


def test_freq_to_midi_rejects_unpitched_and_out_of_range():
    assert freq_to_midi(0.0) == 0
    assert freq_to_midi(-10.0) == 0
    assert freq_to_midi(float("nan")) == 0
    assert freq_to_midi(30.0) == 0  # below MIDI 36
    assert freq_to_midi(5000.0) == 0  # above MIDI 84


def test_midi_to_freq_roundtrip():
    for midi in (36, 60, 69, 84):
        assert freq_to_midi(midi_to_freq(midi)) == midi


# --- schema validation ---


def test_vocal_phrases_optional_and_parse():
    chart = _chart([_phrase()])
    assert chart.vocal_phrases[0].speaker_id == "SPEAKER_00"
    assert _chart([]).vocal_phrases == []


def test_vocal_phrase_rejects_bad_bounds_and_pitch():
    with pytest.raises(ValidationError):
        _chart([_phrase(start=500, end=500)])
    with pytest.raises(ValidationError):
        _chart([_phrase(midi=35)])
    with pytest.raises(ValidationError):
        _chart([_phrase(midi=85)])


def test_vocal_phrases_must_be_sorted():
    with pytest.raises(ValidationError):
        _chart([_phrase(start=1000, end=1500), _phrase(start=0, end=500)])


# --- validator: per-speaker non-overlap ---


def test_same_speaker_overlap_is_violation():
    chart = _chart(
        [
            _phrase("Call", "SPEAKER_00", 0, 1000),
            _phrase("Clash", "SPEAKER_00", 500, 1500),
        ]
    )
    violations = check_vocals(chart)
    assert len(violations) == 1
    assert violations[0].time_ms == 500


def test_cross_speaker_overlap_is_duet_not_violation():
    chart = _chart(
        [
            _phrase("Hold on", "SPEAKER_00", 8000, 9500, midi=67),
            _phrase("Hold on", "SPEAKER_01", 8000, 9500, midi=72),
        ]
    )
    assert check_vocals(chart) == []


def test_clean_call_and_response_passes():
    chart = _chart(
        [
            _phrase("Call", "SPEAKER_00", 0, 900),
            _phrase("Response", "SPEAKER_01", 1000, 1900),
        ]
    )
    assert check_vocals(chart) == []


# --- phrase pitch alignment ---


def test_align_takes_median_of_voiced_frames():
    contour = PitchContour(
        times_ms=[0, 100, 200, 300, 400],
        midi_notes=[0, 69, 71, 69, 0],
    )
    (enriched,) = align_phrase_pitches([_phrase(midi=0)], contour)
    assert enriched["midi_pitch"] == 69
    assert enriched["speaker_id"] == "SPEAKER_00"


def test_align_unvoiced_window_stays_unpitched():
    contour = PitchContour(times_ms=[0, 100], midi_notes=[0, 0])
    (enriched,) = align_phrase_pitches([_phrase(midi=0)], contour)
    assert enriched["midi_pitch"] == 0


def test_align_never_mutates_input_and_keeps_existing_pitch():
    original = _phrase(midi=72)
    snapshot = dict(original)
    contour = PitchContour(times_ms=[0], midi_notes=[60])
    (enriched,) = align_phrase_pitches([original], contour)
    assert original == snapshot
    assert enriched["midi_pitch"] == 72


# --- end-to-end contour on synthetic audio ---


def _write_sine_wav(path: Path, freq: float = 440.0, seconds: float = 1.0) -> None:
    sr = 16_000
    frames = int(sr * seconds)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sr)
        for i in range(frames):
            sample = int(10_000 * math.sin(2 * math.pi * freq * i / sr))
            wav.writeframes(sample.to_bytes(2, "little", signed=True))


def test_extract_pitch_contour_on_synthetic_sine(tmp_path: Path):
    wav = tmp_path / "sine.wav"
    _write_sine_wav(wav)
    contour = extract_pitch_contour(wav)
    assert contour.times_ms
    voiced = [m for m in contour.midi_notes if m > 0]
    # Synthetic tone: the deterministic fallback must still lock A4.
    assert voiced, "expected voiced frames on a pure sine tone"
    top, _ = Counter(voiced).most_common(1)[0]
    assert top == 69
