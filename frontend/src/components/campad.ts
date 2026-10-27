/**
 * Cam-Pad pure logic: 5-pad hit-zone geometry (arcade UL/UR/C/DL/DR layout),
 * simulated hand-blob physics for SIM mode, and the Overdrive pose rule.
 * Kept DOM-free so vitest can cover it; `CamPadOverlay.tsx` renders it.
 */
import type { PumpPad } from "../types/chart";

export interface ZoneRect {
  pad: PumpPad;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Normalized 0–1 hit zones matching the arcade receptor layout. */
export const CAMPAD_ZONES: readonly ZoneRect[] = [
  { pad: "Q", x: 0.03, y: 0.05, w: 0.3, h: 0.28 },
  { pad: "E", x: 0.67, y: 0.05, w: 0.3, h: 0.28 },
  { pad: "S", x: 0.35, y: 0.35, w: 0.3, h: 0.28 },
  { pad: "Z", x: 0.03, y: 0.65, w: 0.3, h: 0.28 },
  { pad: "C", x: 0.67, y: 0.65, w: 0.3, h: 0.28 },
];

/** Which zone (if any) contains the normalized point. */
export function zoneAt(x: number, y: number): PumpPad | null {
  for (const z of CAMPAD_ZONES) {
    if (x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) {
      return z.pad;
    }
  }
  return null;
}

export interface SimBlob {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** Two deterministic hand blobs for offline SIM motion. */
export function initialBlobs(): [SimBlob, SimBlob] {
  return [
    { x: 0.18, y: 0.7, vx: 0.22, vy: -0.31 },
    { x: 0.82, y: 0.7, vx: -0.26, vy: -0.27 },
  ];
}

/** Advance blobs by dt seconds, bouncing off the unit frame. Pure. */
export function stepBlobs(
  blobs: readonly [SimBlob, SimBlob],
  dt: number,
): [SimBlob, SimBlob] {
  const step = (b: SimBlob): SimBlob => {
    let { x, y, vx, vy } = b;
    x += vx * dt;
    y += vy * dt;
    if (x < 0.05 || x > 0.95) {
      vx = -vx;
      x = Math.min(0.95, Math.max(0.05, x));
    }
    if (y < 0.05 || y > 0.95) {
      vy = -vy;
      y = Math.min(0.95, Math.max(0.05, y));
    }
    return { x, y, vx, vy };
  };
  return [step(blobs[0]), step(blobs[1])];
}

/** Overdrive pose: BOTH hands raised above the shoulder line (y < 0.3). */
export function overdrivePose(a: SimBlob, b: SimBlob): boolean {
  return a.y < 0.3 && b.y < 0.3;
}

/** Which pads (if any) the two blobs currently cover. */
export function blobsToPads(
  a: SimBlob,
  b: SimBlob,
): { pads: PumpPad[]; overdrive: boolean } {
  const pads = new Set<PumpPad>();
  for (const blob of [a, b]) {
    const z = zoneAt(blob.x, blob.y);
    if (z !== null) {
      pads.add(z);
    }
  }
  return { pads: [...pads], overdrive: overdrivePose(a, b) };
}

/** Minimum ms between two air-pad fires on the same pad. */
export const PAD_FIRE_COOLDOWN_MS = 250;

/** How long an air-pad press stays held (ms) so hold notes can register. */
export const PAD_HOLD_MS = 120;

/**
 * Fire a pad hit through the REAL keyboard path the engine listens on
 * (`window` keydown/keyup), so air-pad hits judge exactly like key presses.
 * The key stays down for PAD_HOLD_MS (a real tap duration) instead of
 * releasing synchronously, which previously killed hold notes instantly and
 * never lit the receptor flash.
 */
export function firePadHit(pad: PumpPad, holdMs: number = PAD_HOLD_MS): void {
  const key = pad.toLowerCase();
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  window.setTimeout(() => {
    window.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
  }, Math.max(0, holdMs));
}

/* --- Local motion tracker (CAM mode): energies -> pads/pose --------------- */

/** Per-pad motion energy in 0..1 from the frame-differencing tracker. */
export type PadEnergies = Record<PumpPad, number>;

/** Default energy a zone must exceed to fire (slider-adjustable). */
export const MOTION_FIRE_THRESHOLD = 0.18;

/** Both-hands-up must be held this long to arm Overdrive (anti-flutter). */
export const OVERDRIVE_HOLD_MS = 700;

/** Pads whose motion energy exceeds the fire threshold. */
export function padsAboveThreshold(
  energies: PadEnergies,
  threshold: number = MOTION_FIRE_THRESHOLD,
): PumpPad[] {
  const out: PumpPad[] = [];
  for (const z of CAMPAD_ZONES) {
    if ((energies[z.pad] ?? 0) >= threshold) {
      out.push(z.pad);
    }
  }
  return out;
}

/**
 * Raised-hands pose from motion energies: BOTH upper zones (Q + E) hot.
 * Low-zone waving (Z/C/S) never counts, so footwork can't arm Overdrive.
 */
export function raisedHandsFromEnergies(
  energies: PadEnergies,
  threshold: number = MOTION_FIRE_THRESHOLD,
): boolean {
  return (
    (energies.Q ?? 0) >= threshold && (energies.E ?? 0) >= threshold
  );
}

/** Hold-to-arm progress 0..1 for a sustained pose of `heldMs`. */
export function holdProgress(
  heldMs: number,
  requiredMs: number = OVERDRIVE_HOLD_MS,
): number {
  if (requiredMs <= 0) {
    return 1;
  }
  return Math.min(1, Math.max(0, heldMs / requiredMs));
}
