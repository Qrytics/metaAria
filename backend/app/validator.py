"""Deterministic Python pre-checks (AGENTS.md §5).

Runs BEFORE the Critic LLM so the model spends minimal output tokens
diagnosing and fixing. Checks:

1. `snap` — every note must fall within ±SNAP_TOLERANCE_MS of a detected onset.
2. `parity` — 5-pad foot-parity state transitions (strict on Q/E/S/Z/C).
3. `density` — biomechanical cap on notes per rolling window.
4. `vocal` — Stage 2.5: vocal phrases sorted by `start_ms` and non-overlapping
   per speaker (overlaps across different speakers = duet harmony, allowed).
"""

from __future__ import annotations

import bisect

from .schemas import ChartSchema, CriticReportSchema, ViolationSchema

SNAP_TOLERANCE_MS = 15
MIN_FOOT_SHIFT_MS = 150  # same foot can't cover 2 pads faster than this
MAX_CONSECUTIVE_SAME_FOOT = 2  # 3rd consecutive note on one foot = parity break
DENSITY_WINDOW_MS = 1000
DENSITY_MAX_NOTES = 10  # >10 notes/sec is unplayable on either mode

# 2D pad coordinates for travel-distance reasoning.
PAD_XY: dict[str, tuple[float, float]] = {
    "Q": (-1.0, 1.0),
    "E": (1.0, 1.0),
    "S": (0.0, 0.0),
    "Z": (-1.0, -1.0),
    "C": (1.0, -1.0),
}
LEFT_PADS = frozenset({"Q", "Z"})
RIGHT_PADS = frozenset({"E", "C"})


def _nearest_onset_gap(time_ms: int, onsets_ms: list[int]) -> int:
    """Absolute gap to the closest onset (onsets must be pre-sorted)."""
    if not onsets_ms:
        return time_ms  # degenerate: everything is a violation
    i = bisect.bisect_left(onsets_ms, time_ms)
    best = abs(onsets_ms[0] - time_ms)
    if i < len(onsets_ms):
        best = min(best, abs(onsets_ms[i] - time_ms))
    if i > 0:
        best = min(best, abs(onsets_ms[i - 1] - time_ms))
    return best


def check_snap(chart: ChartSchema, onsets_ms: list[int]) -> list[ViolationSchema]:
    out: list[ViolationSchema] = []
    for note in chart.notes:
        gap = _nearest_onset_gap(note.time_ms, sorted(onsets_ms))
        if gap > SNAP_TOLERANCE_MS:
            out.append(
                ViolationSchema(
                    type="snap",
                    time_ms=note.time_ms,
                    message=(
                        f"note at {note.time_ms}ms is {gap}ms from nearest onset "
                        f"(tolerance ±{SNAP_TOLERANCE_MS}ms)"
                    ),
                )
            )
    return out


def _assign_foot(pad: str, prev_pad: str | None, prev_foot: str | None) -> str:
    """Greedy foot assignment: side pads prefer their foot, center alternates."""
    if pad in LEFT_PADS:
        return "L"
    if pad in RIGHT_PADS:
        return "R"
    # Center pad S: alternate from previous foot, default to L.
    if prev_foot is None:
        return "L"
    return "R" if prev_foot == "L" else "L"


def check_parity(chart: ChartSchema) -> list[ViolationSchema]:
    """Foot-parity state machine. Only applies to pump-5pad charts."""
    out: list[ViolationSchema] = []
    if chart.mode != "pump-5pad":
        return out
    prev_pad: str | None = None
    prev_foot: str | None = None
    prev_time: int | None = None
    run_length = 0
    for note in chart.notes:
        assert note.pad is not None
        foot = _assign_foot(note.pad, prev_pad, prev_foot)
        if foot == prev_foot:
            run_length += 1
        else:
            run_length = 1
        if run_length > MAX_CONSECUTIVE_SAME_FOOT:
            out.append(
                ViolationSchema(
                    type="parity",
                    time_ms=note.time_ms,
                    message=(
                        f"foot '{foot}' used {run_length}x in a row ending at "
                        f"{note.time_ms}ms (pad {note.pad}); break parity"
                    ),
                )
            )
        if (
            prev_pad is not None
            and prev_time is not None
            and foot == prev_foot
            and note.pad != prev_pad
            and (note.time_ms - prev_time) < MIN_FOOT_SHIFT_MS
        ):
            a = PAD_XY[prev_pad]
            b = PAD_XY[note.pad]
            dist = ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
            if dist >= 1.0:
                out.append(
                    ViolationSchema(
                        type="parity",
                        time_ms=note.time_ms,
                        message=(
                            f"foot '{foot}' must travel {prev_pad}->{note.pad} "
                            f"in {note.time_ms - prev_time}ms "
                            f"(min {MIN_FOOT_SHIFT_MS}ms)"
                        ),
                    )
                )
        prev_pad, prev_foot, prev_time = note.pad, foot, note.time_ms
    return out


def check_density(chart: ChartSchema) -> list[ViolationSchema]:
    out: list[ViolationSchema] = []
    times = [n.time_ms for n in chart.notes]
    left = 0
    for right, t in enumerate(times):
        while times[left] < t - DENSITY_WINDOW_MS:
            left += 1
        if right - left + 1 > DENSITY_MAX_NOTES:
            out.append(
                ViolationSchema(
                    type="density",
                    time_ms=t,
                    message=(
                        f"{right - left + 1} notes within "
                        f"{DENSITY_WINDOW_MS}ms ending at {t}ms "
                        f"(max {DENSITY_MAX_NOTES})"
                    ),
                )
            )
            left += 1  # report once per sliding cluster
    return out


def check_vocals(chart: ChartSchema) -> list[ViolationSchema]:
    """Stage 2.5: vocal phrases sorted by start_ms, non-overlapping per speaker.

    Same-speaker overlaps are errors (one voice can't sing two phrases at
    once). Cross-speaker overlaps are legal duet/harmony call-and-response.
    Reports use type "critic" so the Critic LLM loop sees them.
    """
    out: list[ViolationSchema] = []
    starts = [p.start_ms for p in chart.vocal_phrases]
    if starts != sorted(starts):
        out.append(
            ViolationSchema(
                type="critic",
                time_ms=None,
                message="vocal_phrases must be sorted by start_ms ascending",
            )
        )
    last_end_by_speaker: dict[str, int] = {}
    for phrase in chart.vocal_phrases:
        last_end = last_end_by_speaker.get(phrase.speaker_id)
        if last_end is not None and phrase.start_ms < last_end:
            out.append(
                ViolationSchema(
                    type="critic",
                    time_ms=phrase.start_ms,
                    message=(
                        f"vocal phrase '{phrase.text}' ({phrase.speaker_id}) "
                        f"starts at {phrase.start_ms}ms before previous "
                        f"{phrase.speaker_id} phrase ends at {last_end}ms"
                    ),
                )
            )
        prev = last_end_by_speaker.get(phrase.speaker_id, -1)
        last_end_by_speaker[phrase.speaker_id] = max(prev, phrase.end_ms)
    return out


def validate_chart(chart: ChartSchema, onsets_ms: list[int]) -> CriticReportSchema:
    """Run all deterministic checks and pack the compact violation report."""
    snaps = check_snap(chart, onsets_ms)
    parity = check_parity(chart)
    density = check_density(chart)
    vocals = check_vocals(chart)
    errors = [v for v in (*snaps, *parity, *density, *vocals) if v.severity == "error"]
    return CriticReportSchema(
        passed=not errors,
        chart_mode=chart.mode,
        snap_violations=len([v for v in snaps if v.severity == "error"]),
        parity_violations=len([v for v in parity if v.severity == "error"]),
        density_violations=len([v for v in density if v.severity == "error"]),
        violations=[*snaps, *parity, *density, *vocals],
    )
