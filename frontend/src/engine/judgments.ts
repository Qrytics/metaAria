/** Hit judgments and scoring. Pure math — covered by vitest. */

export type Judgment = "PERFECT" | "GREAT" | "GOOD" | "MISS";

export const PERFECT_WINDOW_MS = 22;
export const GREAT_WINDOW_MS = 45;
export const GOOD_WINDOW_MS = 90;

/** Classify a hit by its signed timing error (hitTime - noteTime). */
export function judgeHit(deltaMs: number): Judgment {
  const a = Math.abs(deltaMs);
  if (a <= PERFECT_WINDOW_MS) {
    return "PERFECT";
  }
  if (a <= GREAT_WINDOW_MS) {
    return "GREAT";
  }
  if (a <= GOOD_WINDOW_MS) {
    return "GOOD";
  }
  return "MISS";
}

/** Anything past the GOOD window unhit is a MISS (>90ms). */
export function isMissWindowExceeded(songTimeMs: number, noteTimeMs: number): boolean {
  return songTimeMs - noteTimeMs > GOOD_WINDOW_MS;
}

export type JudgmentCounts = Record<Judgment, number>;

export interface ScoreState {
  counts: JudgmentCounts;
  combo: number;
  maxCombo: number;
}

export function createScoreState(): ScoreState {
  return {
    counts: { PERFECT: 0, GREAT: 0, GOOD: 0, MISS: 0 },
    combo: 0,
    maxCombo: 0,
  };
}

/** Register one judged hit. MISS resets the combo; anything else extends it. */
export function registerJudgment(state: ScoreState, judgment: Judgment): void {
  state.counts[judgment] += 1;
  if (judgment === "MISS") {
    state.combo = 0;
    return;
  }
  state.combo += 1;
  if (state.combo > state.maxCombo) {
    state.maxCombo = state.combo;
  }
}

const JUDGMENT_WEIGHTS: Record<Judgment, number> = {
  PERFECT: 1,
  GREAT: 0.7,
  GOOD: 0.4,
  MISS: 0,
};

/** Weighted accuracy in [0, 1]; 1 when nothing has been judged yet. */
export function accuracy(state: ScoreState): number {
  const total =
    state.counts.PERFECT + state.counts.GREAT + state.counts.GOOD + state.counts.MISS;
  if (total === 0) {
    return 1;
  }
  const earned =
    state.counts.PERFECT * JUDGMENT_WEIGHTS.PERFECT +
    state.counts.GREAT * JUDGMENT_WEIGHTS.GREAT +
    state.counts.GOOD * JUDGMENT_WEIGHTS.GOOD;
  return earned / total;
}
