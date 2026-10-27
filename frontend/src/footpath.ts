/**
 * Foot-path + onset-grid helpers for the studio inspector panels.
 * Foot assignment mirrors `assignFoot` in types/chart (greedy side feet,
 * center alternates) so the UI preview matches the backend validator.
 */
import {
  MIN_FOOT_SHIFT_MS,
  assignFoot,
  isPumpChart,
  type Chart,
  type Foot,
  type PumpPad,
} from "./types/chart";

export interface FootStep {
  index: number;
  time_ms: number;
  pad: PumpPad;
  foot: Foot;
}

export interface FootTransition {
  from: FootStep;
  to: FootStep;
  deltaMs: number;
  /** Same-foot hop faster than the validator allows. */
  tooFast: boolean;
}

/** Greedy foot assignment over every pump note in time order. */
export function footPath(chart: Chart): FootStep[] {
  if (!isPumpChart(chart)) {
    return [];
  }
  let prev: Foot | null = null;
  return chart.notes.map((note, index) => {
    const pad = note.pad ?? "S";
    const foot = assignFoot(pad, prev);
    prev = foot;
    return { index, time_ms: note.time_ms, pad, foot };
  });
}

/** Consecutive L->R->L style transitions with travel-time checks. */
export function footTransitions(chart: Chart): FootTransition[] {
  const steps = footPath(chart);
  const out: FootTransition[] = [];
  for (let i = 1; i < steps.length; i += 1) {
    const from = steps[i - 1];
    const to = steps[i];
    const deltaMs = to.time_ms - from.time_ms;
    out.push({
      from,
      to,
      deltaMs,
      tooFast: from.foot === to.foot && deltaMs < MIN_FOOT_SHIFT_MS,
    });
  }
  return out;
}

/**
 * Synthetic onset grid: quarter-note pulses from the chart BPM across its
 * duration. Stands in for the librosa onset grid until a real audio file is
 * run through `/charts/generate`.
 */
export function onsetGrid(bpm: number, duration_ms: number): number[] {
  if (!(bpm > 0) || !(duration_ms > 0)) {
    return [];
  }
  const beatMs = 60000 / bpm;
  const grid: number[] = [];
  for (let t = 0; t <= duration_ms; t += beatMs) {
    grid.push(Math.round(t));
  }
  return grid;
}

/** Distance from a note time to the nearest onset in the grid. */
export function nearestOnsetDelta(time_ms: number, grid: number[]): number | null {
  if (grid.length === 0) {
    return null;
  }
  let best = Number.POSITIVE_INFINITY;
  for (const onset of grid) {
    const d = Math.abs(time_ms - onset);
    if (d < best) {
      best = d;
    }
  }
  return best;
}
