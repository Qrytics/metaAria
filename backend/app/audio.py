"""FFmpeg audio pre-processor (AGENTS.md §1 hard precondition).

Every input file is converted to mono 16-bit PCM WAV at 16kHz before any
`muse-voice-transcribe` call. Uses the system `ffmpeg` binary via subprocess
so no extra Python dependency is required.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

TARGET_SAMPLE_RATE = 16_000
TARGET_CHANNELS = 1
TARGET_SAMPLE_FMT = "s16"  # 16-bit PCM


class FFmpegNotFoundError(RuntimeError):
    pass


def ensure_ffmpeg_available() -> str:
    path = shutil.which("ffmpeg")
    if path is None:
        raise FFmpegNotFoundError(
            "ffmpeg binary not found on PATH. Install FFmpeg to use the pre-processor."
        )
    return path


def normalize_to_wav16k(src: str | Path, dst: str | Path | None = None) -> Path:
    """Convert `src` audio to mono 16-bit PCM WAV @ 16kHz.

    Returns the path of the normalized file. Overwrites `dst` when given;
    otherwise writes alongside `src` with a `.16k.wav` suffix.
    """
    ffmpeg = ensure_ffmpeg_available()
    src_path = Path(src)
    if not src_path.is_file():
        raise FileNotFoundError(f"input audio not found: {src_path}")
    dst_path = Path(dst) if dst is not None else src_path.with_suffix(".16k.wav")
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        str(src_path),
        "-ac",
        str(TARGET_CHANNELS),
        "-ar",
        str(TARGET_SAMPLE_RATE),
        "-sample_fmt",
        TARGET_SAMPLE_FMT,
        "-c:a",
        "pcm_s16le",
        str(dst_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed ({proc.returncode}): {proc.stderr[-2000:]}")
    return dst_path
