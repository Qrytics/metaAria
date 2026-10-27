"""Stage 5: real-audio/video ingest helpers (AGENTS.md §6).

All fallbacks are deterministic and $0-cost: when `ENV=dev` without API
keys, vocal phrases are synthesized on the real onset grid and aligned to
the real `pyin` pitch contour, motion peaks come from a frame-diff over
FFmpeg-sampled keyframes (onset-derived when video is absent), and the
draft chart is a rhythm-pattern synthesizer snapped exactly to the real
`librosa` onsets so the result passes the ±15ms validator.
"""

from __future__ import annotations

import base64
import bisect
import subprocess
import tempfile
from pathlib import Path

AUDIO_EXTS = frozenset({".mp3", ".wav", ".ogg", ".m4a"})
VIDEO_EXTS = frozenset({".mp4", ".webm"})

PUMP_CYCLE = ("Q", "E", "S", "Z", "C")
MANIA_CYCLE = (0, 1, 2, 3)

_LYRIC_POOL = (
    "Oh oh",
    "Feel the beat",
    "Move your feet",
    "Call it out",
    "Lift it up",
    "Sing it loud",
    "Hold on now",
    "Break it down",
)


def mock_vocal_phrases_from_grid(
    onset_times_ms: list[int],
    duration_ms: int,
    contour_times_ms: list[int],
    contour_midis: list[int],
    phrase_ms: int = 2000,
) -> list[dict]:
    """Deterministic beat-synced vocal phrases for ENV=dev uploads.

    Phrase windows tile the track in `phrase_ms` blocks starting on the
    nearest onset at/after each block start; reference pitches come from
    the real pyin contour median inside each window (0 = unpitched).
    Speakers alternate so the Rock Band ribbon shows a duet.
    """
    from .dsp import PitchContour, align_phrase_pitches

    grid = sorted(onset_times_ms)
    contour = PitchContour(times_ms=list(contour_times_ms), midi_notes=list(contour_midis))
    phrases: list[dict] = []
    idx = 0
    start = grid[0] if grid else 0
    while start < duration_ms:
        end = min(start + phrase_ms, duration_ms)
        if end - start < 400:
            break
        phrases.append(
            {
                "text": _LYRIC_POOL[idx % len(_LYRIC_POOL)],
                "speaker_id": f"SPEAKER_{idx % 2:02d}",
                "start_ms": start,
                "end_ms": end,
            }
        )
        idx += 1
        nxt = bisect.bisect_right(grid, start + phrase_ms)
        if nxt >= len(grid):
            break
        start = grid[nxt]
    return align_phrase_pitches(phrases, contour)


def mock_motion_peaks(
    onset_times_ms: list[int], duration_ms: int, stride: int = 4
) -> list[int]:
    """Onset-derived motion peaks (no video, or ENV=dev video fallback)."""
    grid = sorted(onset_times_ms)
    if grid:
        return grid[::stride]
    step = 2000
    return list(range(0, duration_ms, step))


def sample_video_keyframes(video_path: str | Path, fps: int = 1, max_frames: int = 8) -> list[Path]:
    """Sample JPEG keyframes via FFmpeg into a temp dir. Returns [] on failure."""
    import shutil

    if shutil.which("ffmpeg") is None:
        return []
    tmpdir = Path(tempfile.mkdtemp(prefix="aria-sam-"))
    pattern = tmpdir / "kf-%03d.jpg"
    cmd = [
        "ffmpeg", "-y", "-i", str(video_path),
        "-vf", f"fps={fps}", "-frames:v", str(max_frames),
        str(pattern),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True)
    except OSError:
        return []
    if proc.returncode != 0:
        return []
    return sorted(tmpdir.glob("kf-*.jpg"))


def frame_diff_peaks(keyframes: list[Path], duration_ms: int) -> list[int]:
    """Deterministic motion peaks from mean byte-level frame differences.

    Pure-stdlib fallback: consecutive JPEG byte streams are compared and
    frames whose normalized difference exceeds the median are mapped to
    evenly spaced timestamps across the track duration.
    """
    if len(keyframes) < 2:
        return []
    blobs = []
    for kf in keyframes:
        try:
            blobs.append(kf.read_bytes())
        except OSError:
            continue
    if len(blobs) < 2:
        return []
    diffs: list[float] = []
    for prev, cur in zip(blobs, blobs[1:]):
        n = max(len(prev), len(cur))
        table = 0
        for a, b in zip(prev, cur):
            if a != b:
                table += 1
        table += abs(len(prev) - len(cur))
        diffs.append(table / max(n, 1))
    if not diffs:
        return []
    ordered = sorted(diffs)
    median = ordered[len(ordered) // 2]
    peaks = []
    for i, d in enumerate(diffs):
        if d >= median:
            peaks.append(int(round((i + 1) * duration_ms / len(blobs))))
    return sorted(set(peaks))


def extract_motion_peaks(
    video_path: str | Path | None,
    duration_ms: int,
    onset_times_ms: list[int],
    config=None,
) -> tuple[list[int], bool]:
    """Sample `video_path` keyframes and map them to motion peak timestamps.

    Returns (peaks_ms, mock). Real path calls `sam-3.1` per keyframe and
    keeps timestamps whose zones fire; ENV=dev (or sampling failure) uses
    the deterministic frame-diff, falling back to onset-derived peaks.
    `None` video input yields onset-derived peaks with mock=True.
    """
    from .llm import RouterConfig, _use_mock, segment_frame

    cfg = config or RouterConfig.from_env()
    if video_path is None:
        return mock_motion_peaks(onset_times_ms, duration_ms), True
    keyframes = sample_video_keyframes(video_path)
    if _use_mock(cfg):
        peaks = frame_diff_peaks(keyframes, duration_ms)
        if not peaks:
            peaks = mock_motion_peaks(onset_times_ms, duration_ms)
        return peaks, True
    peaks: list[int] = []
    per = duration_ms / max(len(keyframes), 1)
    for i, kf in enumerate(keyframes):
        try:
            b64 = base64.b64encode(kf.read_bytes()).decode("ascii")
        except OSError:
            continue
        try:
            seg = segment_frame("hands and feet", "pump-5pad", b64, cfg)
        except Exception:
            continue
        zones = seg.get("hit_zones", [])
        if seg.get("overdrive_active") or any(z.get("triggered") for z in zones):
            peaks.append(int(round((i + 0.5) * per)))
    if not peaks:
        peaks = mock_motion_peaks(onset_times_ms, duration_ms)
        return peaks, True
    return sorted(set(peaks)), False


def synthesize_draft_chart(
    bpm: float,
    onset_times_ms: list[int],
    vocal_phrases: list[dict],
    motion_peaks_ms: list[int],
    mode: str,
    title: str,
    duration_ms: int,
    difficulty: str = "normal",
) -> dict:
    """Deterministic rhythm-pattern draft snapped exactly to real onsets.

    `normal` charts every 2nd onset, `hard` every onset; both thin further
    when the grid exceeds the 10-notes/sec density cap. Pad/lane cycles
    alternate feet so the parity pre-check passes by construction.
    """
    from .validator import DENSITY_MAX_NOTES, DENSITY_WINDOW_MS

    grid = sorted(onset_times_ms)
    stride = 1 if difficulty == "hard" else 2
    picks = grid[::stride] if grid else [0]
    # Enforce the density cap by construction: widen the stride until no
    # rolling 1000ms window holds more than DENSITY_MAX_NOTES notes.
    while True:
        bad = False
        left = 0
        for right, t in enumerate(picks):
            while picks[left] < t - DENSITY_WINDOW_MS:
                left += 1
            if right - left + 1 > DENSITY_MAX_NOTES:
                bad = True
                break
        if not bad:
            break
        stride += 1
        picks = grid[::stride] if grid else [0]
        if stride > max(len(grid), 1):
            picks = grid[:1] if grid else [0]
            break
    notes: list[dict] = []
    if mode == "pump-5pad":
        for i, t in enumerate(picks):
            notes.append(
                {"time_ms": t, "lane": None, "pad": PUMP_CYCLE[i % len(PUMP_CYCLE)],
                 "kind": "tap", "duration_ms": 0}
            )
    else:
        for i, t in enumerate(picks):
            notes.append(
                {"time_ms": t, "lane": MANIA_CYCLE[i % len(MANIA_CYCLE)], "pad": None,
                 "kind": "tap", "duration_ms": 0}
            )
    notes.sort(key=lambda n: n["time_ms"])
    last = notes[-1]["time_ms"] if notes else 0
    safe_duration = max(duration_ms, last + 1, 1000)
    return {
        "mode": mode,
        "title": title or "Untitled Upload",
        "bpm": bpm,
        "offset_ms": 0,
        "duration_ms": safe_duration,
        "notes": notes,
        "vocal_phrases": vocal_phrases,
    }
