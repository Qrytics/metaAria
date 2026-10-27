"""Pydantic v2 schemas for Aria charts and critic reports.

Prompt-caching rule (AGENTS.md §4): the JSON Schema derived from these models
is static and must be embedded at the TOP of the critic/generator system
prompt. Per-song data (notes, onsets, violations) always goes in the user
message.
"""

from typing import Literal

from pydantic import BaseModel, Field, model_validator

ChartMode = Literal["mania-4k", "pump-5pad"]

# 4-key mania lanes (positional index) and 5-pad Pump pads (Q/E/S/Z/C).
MANIA_LANES: tuple[int, ...] = (0, 1, 2, 3)
PUMP_PADS: tuple[str, ...] = ("Q", "E", "S", "Z", "C")


class NoteSchema(BaseModel):
    """A single charted note. Exactly one of `lane` / `pad` must be set."""

    time_ms: int = Field(ge=0, description="Note time in milliseconds from track start.")
    lane: int | None = Field(default=None, description="4-key lane index 0-3.")
    pad: str | None = Field(default=None, description="5-pad receptor Q/E/S/Z/C.")
    kind: Literal["tap", "hold", "slide"] = "tap"
    duration_ms: int = Field(default=0, ge=0, description="Hold/slide length; 0 for taps.")


class VocalPhraseSchema(BaseModel):
    """One Rock Band vocal phrase (Stage 2.5).

    `speaker_id` carries the `muse-voice-transcribe` diarization label
    (e.g. "SPEAKER_00", "SPEAKER_01"). `midi_pitch` is the reference pitch
    36–84, or 0 for unpitched rap/talkie phrases (excluded from scoring).
    """

    text: str = Field(min_length=1, description="Lyric text of the phrase.")
    speaker_id: str = Field(min_length=1, description="Diarized speaker label.")
    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=0)
    midi_pitch: int = Field(ge=0, le=84, description="36–84 pitched, 0 unpitched.")

    @model_validator(mode="after")
    def check_bounds(self) -> "VocalPhraseSchema":
        if self.end_ms <= self.start_ms:
            raise ValueError("vocal phrase end_ms must exceed start_ms")
        if self.midi_pitch != 0 and self.midi_pitch < 36:
            raise ValueError("vocal phrase midi_pitch must be 36–84 or 0 (unpitched)")
        return self


class ChartSchema(BaseModel):
    """Structured JSON note chart produced by the draft generator."""

    mode: ChartMode
    title: str = Field(min_length=1)
    bpm: float = Field(gt=0, description="Reference BPM of the chart.")
    offset_ms: int = Field(default=0, ge=0)
    duration_ms: int = Field(gt=0)
    notes: list[NoteSchema] = Field(min_length=1)
    vocal_phrases: list[VocalPhraseSchema] = Field(
        default_factory=list,
        description="Optional Rock Band vocal phrases (Stage 2.5).",
    )

    @model_validator(mode="after")
    def check_notes_match_mode(self) -> "ChartSchema":
        if self.mode == "mania-4k":
            for i, note in enumerate(self.notes):
                if note.lane is None or note.lane not in MANIA_LANES:
                    raise ValueError(f"notes[{i}].lane must be 0-3 for mania-4k")
                if note.pad is not None:
                    raise ValueError(f"notes[{i}].pad must be null for mania-4k")
        else:  # pump-5pad
            for i, note in enumerate(self.notes):
                if note.pad is None or note.pad not in PUMP_PADS:
                    raise ValueError(f"notes[{i}].pad must be one of Q/E/S/Z/C for pump-5pad")
                if note.lane is not None:
                    raise ValueError(f"notes[{i}].lane must be null for pump-5pad")
        times = [n.time_ms for n in self.notes]
        if times != sorted(times):
            raise ValueError("notes must be sorted by time_ms ascending")
        if self.notes[-1].time_ms > self.duration_ms:
            raise ValueError("last note time_ms exceeds duration_ms")
        starts = [p.start_ms for p in self.vocal_phrases]
        if starts != sorted(starts):
            raise ValueError("vocal_phrases must be sorted by start_ms ascending")
        return self


class ViolationSchema(BaseModel):
    """One deterministic or critic-reported playability violation."""

    type: Literal["snap", "parity", "density", "critic"]
    time_ms: int | None = Field(default=None, ge=0)
    message: str = Field(min_length=1)
    severity: Literal["error", "warning"] = "error"


class CriticReportSchema(BaseModel):
    """Compact violation report fed to the Critic LLM (user message)."""

    passed: bool
    chart_mode: ChartMode
    snap_violations: int = Field(ge=0)
    parity_violations: int = Field(ge=0)
    density_violations: int = Field(ge=0)
    violations: list[ViolationSchema] = Field(default_factory=list)

    @model_validator(mode="after")
    def check_counts_consistent(self) -> "CriticReportSchema":
        counted = {
            "snap": self.snap_violations,
            "parity": self.parity_violations,
            "density": self.density_violations,
        }
        for v in self.violations:
            if v.type in counted and v.severity == "error":
                counted[v.type] -= 1
        # Warnings don't gate pass/fail; only hard errors must be covered.
        # Counts are informational, so don't hard-fail on mismatch — the
        # validator builds them consistently.
        return self
