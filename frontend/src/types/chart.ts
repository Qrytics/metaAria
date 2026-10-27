/**
 * Shared chart types — strict TypeScript mirror of
 * `backend/app/schemas.py` (`ChartSchema`, `CriticReportSchema`) and the
 * mode/pad constants in `backend/app/validator.py`.
 *
 * Field names intentionally keep the backend snake_case so chart JSON
 * round-trips 1:1 with the Pydantic v2 API (`/charts/validate`,
 * `/charts/generate`). AGENTS.md §4: these static shapes belong in prompts
 * and shared code; per-song data travels separately.
 */

/** Chart play mode. Mirrors `ChartMode` in schemas.py. */
export type ChartMode = "mania-4k" | "pump-5pad";

/** 4-key mania lane indices. Mirrors `MANIA_LANES`. */
export const MANIA_LANES: readonly [0, 1, 2, 3] = [0, 1, 2, 3];
export type ManiaLane = (typeof MANIA_LANES)[number];

/** 5-pad Pump receptors. Mirrors `PUMP_PADS`. */
export const PUMP_PADS: readonly ["Q", "E", "S", "Z", "C"] = [
  "Q",
  "E",
  "S",
  "Z",
  "C",
];
export type PumpPad = (typeof PUMP_PADS)[number];

/** Dance foot used for 5-pad parity reasoning. Mirrors validator `_assign_foot`. */
export type Foot = "L" | "R";

export type NoteKind = "tap" | "hold" | "slide";

/** A single charted note. Mirrors `NoteSchema`: exactly one of lane/pad set. */
export interface ChartNote {
  /** Note time in milliseconds from track start (>= 0). */
  time_ms: number;
  /** 4-key lane index 0-3; null for pump-5pad. */
  lane: ManiaLane | null;
  /** 5-pad receptor Q/E/S/Z/C; null for mania-4k. */
  pad: PumpPad | null;
  kind: NoteKind;
  /** Hold/slide length in ms; 0 for taps. */
  duration_ms: number;
}

/** Structured JSON note chart. Mirrors `ChartSchema`. */
export interface Chart {
  mode: ChartMode;
  title: string;
  /** Reference BPM (> 0). */
  bpm: number;
  offset_ms: number;
  duration_ms: number;
  /** Notes sorted by time_ms ascending. */
  notes: ChartNote[];
  /** Rock Band vocal phrases. Mirrors `vocal_phrases` (Stage 2.5). */
  vocal_phrases?: VocalPhrase[];
}

/** One Rock Band vocal phrase. Mirrors `VocalPhraseSchema`. */
export interface VocalPhrase {
  /** Lyric text of the phrase. */
  text: string;
  /** Diarized speaker label, e.g. "SPEAKER_00". */
  speaker_id: string;
  start_ms: number;
  end_ms: number;
  /** Reference pitch 36–84, or 0 for unpitched rap/talkie. */
  midi_pitch: number;
}

/** Diarized speaker color on the vocal ribbon. */
export function speakerColor(speakerId: string): string {
  if (speakerId === "SPEAKER_01") {
    return "#ff4fd8";
  }
  if (speakerId === "SPEAKER_00") {
    return "#22d3ee";
  }
  let hash = 0;
  for (let i = 0; i < speakerId.length; i += 1) {
    hash = (hash * 31 + speakerId.charCodeAt(i)) | 0;
  }
  const hues = ["#ffd166", "#7CFC00", "#ff9f1c", "#4cc9f0"];
  return hues[Math.abs(hash) % hues.length];
}

export type ViolationType = "snap" | "parity" | "density" | "critic";
export type ViolationSeverity = "error" | "warning";

/** One playability violation. Mirrors `ViolationSchema`. */
export interface ChartViolation {
  type: ViolationType;
  time_ms: number | null;
  message: string;
  severity: ViolationSeverity;
}

/** Compact violation report. Mirrors `CriticReportSchema`. */
export interface CriticReport {
  passed: boolean;
  chart_mode: ChartMode;
  snap_violations: number;
  parity_violations: number;
  density_violations: number;
  violations: ChartViolation[];
}

/** Deterministic pre-check constants. Mirrors `backend/app/validator.py`. */
export const SNAP_TOLERANCE_MS = 15;
export const MIN_FOOT_SHIFT_MS = 150;
export const MAX_CONSECUTIVE_SAME_FOOT = 2;
export const DENSITY_WINDOW_MS = 1000;
export const DENSITY_MAX_NOTES = 10;

const LEFT_PADS: ReadonlySet<PumpPad> = new Set<PumpPad>(["Q", "Z"]);
const RIGHT_PADS: ReadonlySet<PumpPad> = new Set<PumpPad>(["E", "C"]);

/** Greedy foot assignment: side pads prefer their foot, center alternates. */
export function assignFoot(pad: PumpPad, prevFoot: Foot | null): Foot {
  if (LEFT_PADS.has(pad)) {
    return "L";
  }
  if (RIGHT_PADS.has(pad)) {
    return "R";
  }
  if (prevFoot === null) {
    return "L";
  }
  return prevFoot === "L" ? "R" : "L";
}

/** Narrow a note to its mania lane (null unless mania-4k). */
export function noteLane(note: ChartNote): ManiaLane | null {
  return note.lane;
}

/** Narrow a note to its pump pad (null unless pump-5pad). */
export function notePad(note: ChartNote): PumpPad | null {
  return note.pad;
}

/** Type guard: chart is a 4-key mania chart. */
export function isManiaChart(chart: Chart): boolean {
  return chart.mode === "mania-4k";
}

/** Type guard: chart is a 5-pad pump chart. */
export function isPumpChart(chart: Chart): boolean {
  return chart.mode === "pump-5pad";
}
