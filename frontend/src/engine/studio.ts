/**
 * Stage 4 studio logic: paused step-sequencer edits, mirror/density
 * transforms, capped undo/redo, `.aria.json` portable packs, results
 * grades, and validator-marker mapping. Pure and DOM-free so vitest
 * covers it; components only render the results. Never touches the
 * PLAY-mode engine path, so the <5ms sync contract is unaffected.
 */
import {
  SNAP_TOLERANCE_MS,
  type Chart,
  type ChartNote,
  type CriticReport,
  type ManiaLane,
  type PumpPad,
} from "../types/chart";
import type { Judgment } from "./judgments";

/** Undo/redo depth cap (locked scope). */
export const HISTORY_CAP = 50;

/** Repair prompt: smallest possible fix, everything else identical. */
export const REPAIR_COMMAND =
  "Fix every validator violation (timing drift, foot parity, density) " +
  "with the smallest possible note changes. Keep all other notes exactly " +
  "identical: same times, lanes, and pads.";

/** localStorage key for autosaved edits of one chart. */
export function editStorageKey(chartKey: string): string {
  return `aria.edit.${chartKey}`;
}

/** Nearest grid pulse to timeMs, or null outside ±SNAP_TOLERANCE_MS. */
export function snapTimeToGrid(timeMs: number, grid: number[]): number | null {
  let best: number | null = null;
  let bestAbs = SNAP_TOLERANCE_MS + 1;
  for (const pulse of grid) {
    const d = Math.abs(timeMs - pulse);
    if (d < bestAbs) {
      bestAbs = d;
      best = pulse;
    }
  }
  return bestAbs <= SNAP_TOLERANCE_MS ? best : null;
}

/** Nearest grid pulse regardless of distance (cursor jumps). */
export function nearestGridTime(timeMs: number, grid: number[]): number {
  let best = grid[0] ?? 0;
  let bestAbs = Number.POSITIVE_INFINITY;
  for (const pulse of grid) {
    const d = Math.abs(timeMs - pulse);
    if (d < bestAbs) {
      bestAbs = d;
      best = pulse;
    }
  }
  return best;
}

function sameKey(a: ChartNote, b: ChartNote): boolean {
  return a.lane === b.lane && a.pad === b.pad;
}

/**
 * Toggle a tap note for `key` at an exact (already grid-snapped) time:
 * remove the matching note when present, otherwise insert a tap and keep
 * time order. Returns a new chart; the input is never mutated.
 */
export function toggleNoteAt(
  chart: Chart,
  timeMs: number,
  key: ManiaLane | PumpPad,
): Chart {
  const probe: ChartNote =
    typeof key === "number"
      ? { time_ms: timeMs, lane: key, pad: null, kind: "tap", duration_ms: 0 }
      : { time_ms: timeMs, lane: null, pad: key, kind: "tap", duration_ms: 0 };
  const atTime = chart.notes.filter((n) => n.time_ms === timeMs);
  if (atTime.some((n) => sameKey(n, probe))) {
    return {
      ...chart,
      notes: chart.notes.filter((n) => !(n.time_ms === timeMs && sameKey(n, probe))),
    };
  }
  return {
    ...chart,
    notes: [...chart.notes, probe].sort((a, b) => a.time_ms - b.time_ms),
  };
}

const PUMP_MIRROR: Record<PumpPad, PumpPad> = {
  Q: "E",
  E: "Q",
  S: "S",
  Z: "C",
  C: "Z",
};

const MANIA_MIRROR: Record<ManiaLane, ManiaLane> = {
  0: 3,
  1: 2,
  2: 1,
  3: 0,
};

/** Mirror L<->R: pump Q<->E + Z<->C (S stays), mania 0<->3 + 1<->2. */
export function mirrorChart(chart: Chart): Chart {
  return {
    ...chart,
    notes: chart.notes.map((n) => ({
      ...n,
      lane: n.lane === null ? null : MANIA_MIRROR[n.lane],
      pad: n.pad === null ? null : PUMP_MIRROR[n.pad],
    })),
  };
}

/** Halve density: keep even-indexed notes (deterministic). */
export function halveDensity(chart: Chart): Chart {
  return {
    ...chart,
    notes: chart.notes.filter((_, i) => i % 2 === 0),
  };
}

/**
 * Double density: insert a tap at each gap midpoint, borrowing the earlier
 * note's key. Skips gaps that already hold a note within ±15ms so repeated
 * doubling converges instead of stacking duplicates.
 */
export function doubleDensity(chart: Chart): Chart {
  const extra: ChartNote[] = [];
  for (let i = 0; i + 1 < chart.notes.length; i += 1) {
    const a = chart.notes[i];
    const b = chart.notes[i + 1];
    if (a === undefined || b === undefined) {
      continue;
    }
    const mid = Math.round((a.time_ms + b.time_ms) / 2);
    if (mid <= a.time_ms || mid >= b.time_ms) {
      continue;
    }
    const crowded = chart.notes.some(
      (n) => Math.abs(n.time_ms - mid) <= SNAP_TOLERANCE_MS,
    );
    if (crowded) {
      continue;
    }
    extra.push({
      time_ms: mid,
      lane: a.lane,
      pad: a.pad,
      kind: "tap",
      duration_ms: 0,
    });
  }
  return {
    ...chart,
    notes: [...chart.notes, ...extra].sort((a, b) => a.time_ms - b.time_ms),
  };
}

/** Index of the nearest note to timeMs within windowMs, else -1. */
export function nearestNoteIndex(
  chart: Chart,
  timeMs: number,
  windowMs = 120,
): number {
  let best = -1;
  let bestAbs = windowMs + 1;
  chart.notes.forEach((n, i) => {
    const d = Math.abs(n.time_ms - timeMs);
    if (d < bestAbs) {
      bestAbs = d;
      best = i;
    }
  });
  return bestAbs <= windowMs ? best : -1;
}

export interface NoteMark {
  text: string;
  severity: "error" | "warning";
}

/**
 * Map a critic report onto note indices for inline canvas markers:
 * each violation lands on its nearest note within ±120ms.
 */
export function buildMarkers(
  chart: Chart,
  report: CriticReport,
): Map<number, NoteMark[]> {
  const marks = new Map<number, NoteMark[]>();
  for (const v of report.violations) {
    if (v.time_ms === null) {
      continue;
    }
    const idx = nearestNoteIndex(chart, v.time_ms);
    if (idx < 0) {
      continue;
    }
    const arr = marks.get(idx) ?? [];
    arr.push({ text: `${v.type.toUpperCase()}: ${v.message}`, severity: v.severity });
    marks.set(idx, arr);
  }
  return marks;
}

/* --- Capped undo/redo over immutable snapshots --- */

export interface EditHistory<T> {
  past: T[];
  future: T[];
}

export function emptyHistory<T>(): EditHistory<T> {
  return { past: [], future: [] };
}

export function pushHistory<T>(
  h: EditHistory<T>,
  snap: T,
  cap: number = HISTORY_CAP,
): EditHistory<T> {
  const past = [...h.past, snap];
  while (past.length > cap) {
    past.shift();
  }
  return { past, future: [] };
}

export function undoHistory<T>(
  h: EditHistory<T>,
  current: T,
): { history: EditHistory<T>; value: T | null } {
  if (h.past.length === 0) {
    return { history: h, value: null };
  }
  const past = [...h.past];
  const value = past.pop() as T;
  return { history: { past, future: [current, ...h.future] }, value };
}

export function redoHistory<T>(
  h: EditHistory<T>,
  current: T,
): { history: EditHistory<T>; value: T | null } {
  if (h.future.length === 0) {
    return { history: h, value: null };
  }
  const [value, ...future] = h.future;
  if (value === undefined) {
    return { history: h, value: null };
  }
  return { history: { past: [...h.past, current], future }, value };
}

/* --- `.aria.json` portable song packs --- */

export interface AriaPack {
  app: "aria";
  pack: 1;
  chart: Chart;
  onset_grid_ms: number[];
  stage: {
    title: string;
    mode: Chart["mode"];
    bpm: number;
    exported_ms: number;
  };
}

const PACK_MODES: ReadonlySet<string> = new Set(["mania-4k", "pump-5pad"]);
const PACK_KINDS: ReadonlySet<string> = new Set(["tap", "hold", "slide"]);
const PACK_PADS: ReadonlySet<string> = new Set(["Q", "E", "S", "Z", "C"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function checkNote(n: unknown, mode: string): ChartNote {
  if (!isRecord(n)) {
    throw new Error("pack note must be an object");
  }
  const time_ms = n["time_ms"];
  const kind = n["kind"];
  const duration_ms = n["duration_ms"];
  const lane = n["lane"];
  const pad = n["pad"];
  if (typeof time_ms !== "number" || !Number.isFinite(time_ms) || time_ms < 0) {
    throw new Error("pack note needs a finite time_ms >= 0");
  }
  if (typeof kind !== "string" || !PACK_KINDS.has(kind)) {
    throw new Error(`pack note has bad kind ${String(kind)}`);
  }
  if (typeof duration_ms !== "number" || !Number.isFinite(duration_ms) || duration_ms < 0) {
    throw new Error("pack note needs a finite duration_ms >= 0");
  }
  if (mode === "mania-4k") {
    if (lane !== 0 && lane !== 1 && lane !== 2 && lane !== 3) {
      throw new Error("mania pack note needs lane 0-3");
    }
    if (pad !== null) {
      throw new Error("mania pack note must have pad null");
    }
    return { time_ms, lane, pad, kind: kind as ChartNote["kind"], duration_ms };
  }
  if (typeof pad !== "string" || !PACK_PADS.has(pad)) {
    throw new Error(`pump pack note needs pad Q/E/S/Z/C, got ${String(pad)}`);
  }
  if (lane !== null) {
    throw new Error("pump pack note must have lane null");
  }
  return { time_ms, lane, pad: pad as PumpPad, kind: kind as ChartNote["kind"], duration_ms };
}

/** Bundle the edited chart + grid + stage meta into a portable pack. */
export function exportPack(chart: Chart, grid: number[]): AriaPack {
  return {
    app: "aria",
    pack: 1,
    chart: JSON.parse(JSON.stringify(chart)) as Chart,
    onset_grid_ms: [...grid],
    stage: {
      title: chart.title,
      mode: chart.mode,
      bpm: chart.bpm,
      exported_ms: Date.now(),
    },
  };
}

/** Validate + normalize an imported pack. Throws with the reason. */
export function importPack(raw: unknown): { chart: Chart; grid: number[] } {
  if (!isRecord(raw)) {
    throw new Error("pack must be a JSON object");
  }
  if (raw["app"] !== "aria" || raw["pack"] !== 1) {
    throw new Error("not an .aria.json pack (app/pack mismatch)");
  }
  const c = raw["chart"];
  if (!isRecord(c)) {
    throw new Error("pack is missing chart");
  }
  const mode = c["mode"];
  if (typeof mode !== "string" || !PACK_MODES.has(mode)) {
    throw new Error(`pack chart has bad mode ${String(mode)}`);
  }
  if (typeof c["title"] !== "string" || c["title"].length === 0) {
    throw new Error("pack chart needs a title");
  }
  if (typeof c["bpm"] !== "number" || !(c["bpm"] > 0)) {
    throw new Error("pack chart needs bpm > 0");
  }
  if (!Array.isArray(c["notes"])) {
    throw new Error("pack chart needs a notes array");
  }
  const notes = (c["notes"] as unknown[]).map((n) => checkNote(n, mode));
  notes.sort((a, b) => a.time_ms - b.time_ms);
  const gridRaw = raw["onset_grid_ms"];
  if (!Array.isArray(gridRaw)) {
    throw new Error("pack is missing onset_grid_ms");
  }
  const grid = gridRaw.map((g) => {
    if (typeof g !== "number" || !Number.isFinite(g) || g < 0) {
      throw new Error("pack onset_grid_ms must hold finite ms >= 0");
    }
    return g;
  });
  grid.sort((a, b) => a - b);
  const chart: Chart = {
    mode: mode as Chart["mode"],
    title: c["title"] as string,
    bpm: c["bpm"] as number,
    offset_ms: typeof c["offset_ms"] === "number" ? c["offset_ms"] : 0,
    duration_ms:
      typeof c["duration_ms"] === "number" ? c["duration_ms"] : 0,
    notes,
    vocal_phrases: Array.isArray(c["vocal_phrases"])
      ? (c["vocal_phrases"] as Chart["vocal_phrases"])
      : undefined,
  };
  return { chart, grid };
}

/* --- Results grades --- */

export type Grade = "SSS" | "SS" | "S" | "A" | "B" | "C" | "D" | "F";

/** Letter grade from weighted accuracy in [0, 1]. */
export function gradeForAccuracy(acc: number): Grade {
  if (acc >= 0.98) {
    return "SSS";
  }
  if (acc >= 0.95) {
    return "SS";
  }
  if (acc >= 0.9) {
    return "S";
  }
  if (acc >= 0.8) {
    return "A";
  }
  if (acc >= 0.7) {
    return "B";
  }
  if (acc >= 0.5) {
    return "C";
  }
  if (acc >= 0.3) {
    return "D";
  }
  return "F";
}

const GRADE_WEIGHTS: Record<Judgment, number> = {
  PERFECT: 1,
  GREAT: 0.7,
  GOOD: 0.4,
  MISS: 0,
};

/**
 * Weighted accuracy for one judgment-count bucket (mirrors the engine's
 * weights). Null when nothing was judged, so the readout prints a dash.
 */
export function bucketAccuracy(
  counts: Record<Judgment, number>,
): number | null {
  const total = counts.PERFECT + counts.GREAT + counts.GOOD + counts.MISS;
  if (total === 0) {
    return null;
  }
  return (
    (counts.PERFECT * GRADE_WEIGHTS.PERFECT +
      counts.GREAT * GRADE_WEIGHTS.GREAT +
      counts.GOOD * GRADE_WEIGHTS.GOOD) /
    total
  );
}
