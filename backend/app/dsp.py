"""Local deterministic DSP: librosa onset/BPM grid extractor.

Runs fully offline. `librosa` is imported lazily inside `extract_grid` so the
rest of the backend (schemas, validator, tests) works without the heavy
dependency installed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import math


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


# --- Stage 2.5: F0 → MIDI pitch contour -------------------------------------

MIN_VOCAL_MIDI = 36
MAX_VOCAL_MIDI = 84


def freq_to_midi(freq_hz: float) -> int:
    """Convert a fundamental frequency in Hz to the nearest MIDI note.

    Returns 0 for non-positive / non-finite input (unpitched).
    """
    if not math.isfinite(freq_hz) or freq_hz <= 0:
        return 0
    midi = int(round(69 + 12 * math.log2(freq_hz / 440.0)))
    if midi < MIN_VOCAL_MIDI or midi > MAX_VOCAL_MIDI:
        return 0
    return midi


def midi_to_freq(midi: int) -> float:
    """Convert a MIDI note number to its frequency in Hz."""
    return 440.0 * (2.0 ** ((midi - 69) / 12.0))


@dataclass(frozen=True)
class PitchContour:
    """Frame-wise reference pitch track aligned to the audio timeline."""

    times_ms: list[int]
    midi_notes: list[int] = field(default_factory=list)


def _deterministic_fallback_contour(y: object, sr: int, hop_s: float = 0.01) -> PitchContour:
    """Fast deterministic F0 fallback for synthetic/clean audio.

    Plain autocorrelation over 40–1000 Hz; used when `librosa.pyin`
    is unavailable or returns all-unvoiced (common on pure synth tones).
    Pure-Python/numpy only so tests never need audio plugins.
    """
    import numpy as np

    y = np.asarray(y, dtype=float)
    hop = max(1, int(sr * hop_s))
    win = min(len(y), int(sr * 0.05))  # 50ms analysis window
    min_period = max(1, int(sr / 1000))
    max_period = int(sr / 40)
    times_ms: list[int] = []
    midis: list[int] = []
    for start in range(0, max(len(y) - win, 1), hop):
        frame = y[start : start + win] - y[start : start + win].mean()
        if float((frame**2).sum()) < 1e-9:
            times_ms.append(int(round(start / sr * 1000)))
            midis.append(0)
            continue
        corr = np.correlate(frame, frame, mode="full")[len(frame) - 1 :]
        corr /= max(float(corr[0]), 1e-12)
        lo, hi = min(min_period, len(corr) - 1), min(max_period, len(corr) - 1)
        if hi <= lo:
            midis.append(0)
        else:
            peak = lo + int(np.argmax(corr[lo:hi]))
            clarity = float(corr[peak])
            freq = sr / peak if peak > 0 and clarity > 0.3 else 0.0
            midis.append(freq_to_midi(freq) if freq else 0)
        times_ms.append(int(round(start / sr * 1000)))
    return PitchContour(times_ms=times_ms, midi_notes=midis)


def extract_pitch_contour(wav_path: str | Path, sr: int = 16_000) -> PitchContour:
    """Extract an F0 → MIDI contour from a WAV file.

    Primary path is `librosa.pyin` (fmin 40 Hz honoring the 16 kHz mono
    precondition); falls back to the deterministic autocorrelator when
    pyin is unavailable or yields no voiced frames (synthetic audio).
    """
    import numpy as np

    import librosa

    y, _sr = librosa.load(str(wav_path), sr=sr, mono=True)
    if y.size == 0:
        raise ValueError(f"empty audio: {wav_path}")
    try:
        f0, _voiced_flag, _voiced_prob = librosa.pyin(
            y, fmin=40.0, fmax=1000.0, sr=sr, frame_length=1024, hop_length=160
        )
        hop_s = 160 / sr
        voiced = [
            (int(round(i * hop_s * 1000)), freq_to_midi(float(f)))
            for i, f in enumerate(f0)
            if np.isfinite(f)
        ]
        if voiced:
            times = [t for t, _ in voiced]
            midis = [m for _, m in voiced]
            return PitchContour(times_ms=times, midi_notes=midis)
    except Exception:
        pass  # pyin missing/failed → deterministic fallback below
    return _deterministic_fallback_contour(y, sr)


def align_phrase_pitches(
    phrases: list[dict], contour: PitchContour
) -> list[dict]:
    """Attach reference `midi_pitch` to word/phrase timestamps.

    For each phrase with `start_ms`/`end_ms`, takes the median of voiced
    (non-zero) contour frames inside the window; phrases with no voiced
    frames keep `midi_pitch = 0` (unpitched rap/talkie). Input dicts are
    never mutated — enriched copies are returned.
    """
    import bisect

    out: list[dict] = []
    for phrase in phrases:
        enriched = dict(phrase)
        if enriched.get("midi_pitch"):
            out.append(enriched)
            continue
        start = int(enriched.get("start_ms", 0))
        end = int(enriched.get("end_ms", start))
        lo = bisect.bisect_left(contour.times_ms, start)
        hi = bisect.bisect_right(contour.times_ms, end)
        voiced = [m for m in contour.midi_notes[lo:hi] if m > 0]
        if not voiced:
            enriched["midi_pitch"] = 0
        else:
            voiced.sort()
            enriched["midi_pitch"] = voiced[len(voiced) // 2]
        enriched.setdefault("speaker_id", "SPEAKER_00")
        out.append(enriched)
    return out
