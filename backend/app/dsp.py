"""Local deterministic DSP: librosa onset/BPM grid extractor.

Runs fully offline. `librosa` is imported lazily inside `extract_grid` so the
rest of the backend (schemas, validator, tests) works without the heavy
dependency installed.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class OnsetGrid:
    bpm: float
    beat_times_ms: list[int]
    onset_times_ms: list[int]
    duration_ms: int
    sample_rate: int = 16_000


def extract_grid(wav_path: str | Path, sr: int = 16_000) -> OnsetGrid:
    """Extract BPM + beat/onset grids (millisecond integers) from a WAV file."""
    import librosa

    y, _sr = librosa.load(str(wav_path), sr=sr, mono=True)
    if y.size == 0:
        raise ValueError(f"empty audio: {wav_path}")
    duration_ms = int(round(y.shape[0] / float(sr) * 1000))

    tempo, beats = librosa.beat.beat_track(y=y, sr=sr, units="time")
    bpm = float(tempo.item() if hasattr(tempo, "item") else tempo)
    if bpm <= 0:
        raise ValueError("beat tracker returned non-positive BPM")
    beat_times_ms = [int(round(float(t) * 1000)) for t in beats]

    onset_frames = librosa.onset.onset_detect(y=y, sr=sr, units="time")
    onset_times_ms = sorted({int(round(float(t) * 1000)) for t in onset_frames})

    return OnsetGrid(
        bpm=bpm,
        beat_times_ms=beat_times_ms,
        onset_times_ms=onset_times_ms,
        duration_ms=duration_ms,
        sample_rate=sr,
    )
