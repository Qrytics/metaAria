import { describe, expect, it } from "vitest";
import {
  blobsToPads,
  CAMPAD_ZONES,
  holdProgress,
  initialBlobs,
  MOTION_FIRE_THRESHOLD,
  OVERDRIVE_HOLD_MS,
  overdrivePose,
  PAD_FIRE_COOLDOWN_MS,
  padsAboveThreshold,
  raisedHandsFromEnergies,
  stepBlobs,
  zoneAt,
  type PadEnergies,
} from "./campad";
import {
  DIRECTOR_PRESETS,
  initialDirectorSteps,
  markStepActive,
  markStepDone,
  markStepError,
} from "./director";
import {
  createScoreState,
  registerJudgment,
} from "../engine/judgments";
import { acceptsStudioKey } from "./ChartEditor";

describe("campad zones", () => {
  it("covers all five pump pads exactly once", () => {
    expect([...CAMPAD_ZONES.map((z) => z.pad)].sort()).toEqual(
      ["C", "E", "Q", "S", "Z"],
    );
  });

  it("maps corners and center to the arcade layout", () => {
    expect(zoneAt(0.1, 0.1)).toBe("Q");
    expect(zoneAt(0.9, 0.1)).toBe("E");
    expect(zoneAt(0.5, 0.5)).toBe("S");
    expect(zoneAt(0.1, 0.9)).toBe("Z");
    expect(zoneAt(0.9, 0.9)).toBe("C");
    expect(zoneAt(0.5, 0.05)).toBeNull();
  });
});

describe("sim blobs", () => {
  it("starts with one blob on each side", () => {
    const [a, b] = initialBlobs();
    expect(a.x).toBeLessThan(0.5);
    expect(b.x).toBeGreaterThan(0.5);
  });

  it("stays inside the unit frame after many steps", () => {
    let blobs = initialBlobs();
    for (let i = 0; i < 500; i += 1) {
      blobs = stepBlobs(blobs, 1 / 60);
    }
    for (const b of blobs) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x).toBeLessThanOrEqual(1);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeLessThanOrEqual(1);
    }
  });

  it("detects the raised-hands overdrive pose only when both are up", () => {
    const [a, b] = initialBlobs();
    expect(overdrivePose(a, b)).toBe(false);
    expect(
      overdrivePose({ ...a, y: 0.1 }, { ...b, y: 0.1 }),
    ).toBe(true);
    expect(
      overdrivePose({ ...a, y: 0.1 }, { ...b, y: 0.9 }),
    ).toBe(false);
  });

  it("maps blob positions to pads with a cooldown floor", () => {
    expect(PAD_FIRE_COOLDOWN_MS).toBeGreaterThanOrEqual(100);
    const [a, b] = initialBlobs();
    const { pads, overdrive } = blobsToPads(a, b);
    expect(pads).toContain("Z");
    expect(pads).toContain("C");
    expect(overdrive).toBe(false);
  });
});

describe("director steps", () => {
  it("starts all four pipeline steps idle in order", () => {
    const steps = initialDirectorSteps();
    expect(steps.map((s) => s.id)).toEqual([
      "transcribe",
      "remix",
      "critic",
      "art",
    ]);
    expect(steps.every((s) => s.status === "idle")).toBe(true);
  });

  it("transitions active -> done and active -> error", () => {
    let steps = initialDirectorSteps();
    steps = markStepActive(steps, "remix");
    expect(steps[1]?.status).toBe("active");
    steps = markStepDone(steps, "remix");
    expect(steps[1]?.status).toBe("done");
    steps = markStepError(steps, "critic");
    expect(steps[2]?.status).toBe("error");
  });

  it("ships non-empty preset commands", () => {
    expect(DIRECTOR_PRESETS.length).toBeGreaterThan(0);
    for (const p of DIRECTOR_PRESETS) {
      expect(p.trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps presets short and mock-keyword wired", () => {
    const joined = DIRECTOR_PRESETS.join(" ").toLowerCase();
    expect(joined).toContain("twice as fast");
    expect(joined).toContain("crossover");
    expect(joined).toContain("half");
    for (const p of DIRECTOR_PRESETS) {
      expect(p.length).toBeLessThanOrEqual(42);
    }
  });
});

describe("local motion energies (CAM tracker)", () => {
  const quiet: PadEnergies = { Q: 0.01, E: 0.02, S: 0.0, Z: 0.01, C: 0.0 };

  it("fires only pads above the motion threshold", () => {
    expect(padsAboveThreshold(quiet)).toEqual([]);
    const energies: PadEnergies = { ...quiet, Q: 0.5, C: 0.3 };
    expect(padsAboveThreshold(energies).sort()).toEqual(["C", "Q"]);
    // Sensitivity slider just moves the threshold.
    expect(padsAboveThreshold(energies, 0.6)).toEqual([]);
  });

  it("defaults to a threshold strict enough to ignore sensor noise", () => {
    expect(MOTION_FIRE_THRESHOLD).toBeGreaterThanOrEqual(0.1);
    expect(padsAboveThreshold({ ...quiet, Q: 0.09 })).toEqual([]);
  });

  it("needs BOTH upper zones hot for the raised-hands pose", () => {
    expect(raisedHandsFromEnergies(quiet)).toBe(false);
    expect(
      raisedHandsFromEnergies({ ...quiet, Q: 0.9, E: 0.05 }),
    ).toBe(false);
    expect(
      raisedHandsFromEnergies({ ...quiet, Q: 0.9, E: 0.9 }),
    ).toBe(true);
    // Waving low (Z/C) never arms overdrive.
    expect(
      raisedHandsFromEnergies({ ...quiet, Z: 0.9, C: 0.9 }),
    ).toBe(false);
  });

  it("hold-to-arm progress clamps and completes at the hold window", () => {
    expect(holdProgress(-50)).toBe(0);
    expect(holdProgress(0)).toBe(0);
    expect(holdProgress(OVERDRIVE_HOLD_MS / 2, OVERDRIVE_HOLD_MS)).toBeCloseTo(
      0.5,
    );
    expect(holdProgress(OVERDRIVE_HOLD_MS, OVERDRIVE_HOLD_MS)).toBe(1);
    expect(holdProgress(OVERDRIVE_HOLD_MS * 9, OVERDRIVE_HOLD_MS)).toBe(1);
    expect(OVERDRIVE_HOLD_MS).toBeGreaterThanOrEqual(500);
  });
});

describe("overdrive scoring", () => {
  it("doubles judged points under the 2x multiplier", () => {
    const plain = createScoreState();
    registerJudgment(plain, "PERFECT");
    const over = createScoreState();
    registerJudgment(over, "PERFECT", 2);
    expect(over.points).toBe(plain.points * 2);
    expect(over.combo).toBe(plain.combo);
  });

  it("awards no points on MISS even with the multiplier", () => {
    const s = createScoreState();
    registerJudgment(s, "MISS", 2);
    expect(s.points).toBe(0);
    expect(s.combo).toBe(0);
  });
});

describe("studio key trust", () => {
  it("rejects synthetic cam-pad replays so SIM air-pad hits cannot edit charts", () => {
    // firePadHit dispatches `new KeyboardEvent("keydown", { key })` with no
    // trust: the engine must still receive these, but the studio must not.
    expect(acceptsStudioKey({ isTrusted: false })).toBe(false);
  });

  it("accepts physical player keys for studio shortcuts", () => {
    expect(acceptsStudioKey({ isTrusted: true })).toBe(true);
  });
});
