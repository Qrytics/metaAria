/**
 * Key maps and foot color coding for both modes.
 * Mania 4-key: DFJK. Pump 5-pad: Q/E/S/Z/C (physical receptor layout
 * UL/UR/C/DL/DR), color-coded by dance foot: L = cyan, R = orange,
 * center = violet (alternates feet, cf. validator `_assign_foot`).
 */
import type { Foot, ManiaLane, PumpPad } from "../types/chart";

export const MANIA_KEY_TO_LANE: Record<string, ManiaLane> = {
  d: 0,
  f: 1,
  j: 2,
  k: 3,
};

export const MANIA_LANE_LABELS: readonly string[] = ["D", "F", "J", "K"];

export const PUMP_KEY_TO_PAD: Record<string, PumpPad> = {
  q: "Q",
  e: "E",
  s: "S",
  z: "Z",
  c: "C",
};

/** Pump receptor position names (arcade layout). */
export const PUMP_RECEPTOR_POS: Record<PumpPad, "UL" | "UR" | "C" | "DL" | "DR"> = {
  Q: "UL",
  E: "UR",
  S: "C",
  Z: "DL",
  C: "DR",
};

/** Static foot side per pad; center alternates at runtime (see chart.ts). */
export const PAD_FOOT: Record<PumpPad, Foot | "C"> = {
  Q: "L",
  E: "R",
  S: "C",
  Z: "L",
  C: "R",
};

export const FOOT_COLORS: Record<Foot | "C", string> = {
  L: "#22d3ee",
  R: "#fb923c",
  C: "#a78bfa",
};

/** Receptor/note color for a pump pad. */
export function padColor(pad: PumpPad): string {
  return FOOT_COLORS[PAD_FOOT[pad]];
}

export const MANIA_LANE_COLORS: readonly string[] = [
  "#22d3ee",
  "#e879f9",
  "#e879f9",
  "#22d3ee",
];

/** Normalize a KeyboardEvent.key to a mania lane, or null. */
export function keyToLane(key: string): ManiaLane | null {
  return MANIA_KEY_TO_LANE[key.toLowerCase()] ?? null;
}

/** Normalize a KeyboardEvent.key to a pump pad, or null. */
export function keyToPad(key: string): PumpPad | null {
  return PUMP_KEY_TO_PAD[key.toLowerCase()] ?? null;
}
