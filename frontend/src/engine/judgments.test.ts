import { describe, expect, it } from "vitest";
import {
  GOOD_WINDOW_MS,
  GREAT_WINDOW_MS,
  PERFECT_WINDOW_MS,
  accuracy,
  createScoreState,
  isMissWindowExceeded,
  judgeHit,
  registerJudgment,
} from "./judgments";

describe("judgeHit windows", () => {
  it("grades PERFECT within ±22ms inclusive", () => {
    expect(judgeHit(0)).toBe("PERFECT");
    expect(judgeHit(22)).toBe("PERFECT");
    expect(judgeHit(-22)).toBe("PERFECT");
    expect(judgeHit(PERFECT_WINDOW_MS)).toBe("PERFECT");
  });

  it("grades GREAT within ±45ms exclusive of PERFECT", () => {
    expect(judgeHit(23)).toBe("GREAT");
    expect(judgeHit(-45)).toBe("GREAT");
    expect(judgeHit(GREAT_WINDOW_MS)).toBe("GREAT");
    expect(judgeHit(-GREAT_WINDOW_MS)).toBe("GREAT");
  });

  it("grades GOOD within ±90ms exclusive of GREAT", () => {
    expect(judgeHit(46)).toBe("GOOD");
    expect(judgeHit(-90)).toBe("GOOD");
    expect(judgeHit(GOOD_WINDOW_MS)).toBe("GOOD");
  });

  it("grades MISS beyond ±90ms on either side", () => {
    expect(judgeHit(91)).toBe("MISS");
    expect(judgeHit(-91)).toBe("MISS");
    expect(judgeHit(500)).toBe("MISS");
  });

  it("is symmetric for early vs late hits", () => {
    for (const d of [0, 10, 22, 30, 45, 60, 90, 120]) {
      expect(judgeHit(-d)).toBe(judgeHit(d));
    }
  });
});

describe("isMissWindowExceeded", () => {
  it("fires only past +90ms", () => {
    expect(isMissWindowExceeded(1090, 1000)).toBe(false);
    expect(isMissWindowExceeded(1091, 1000)).toBe(true);
  });
});

describe("scoring", () => {
  it("combo builds on hits and resets on MISS", () => {
    const s = createScoreState();
    registerJudgment(s, "PERFECT");
    registerJudgment(s, "GREAT");
    expect(s.combo).toBe(2);
    expect(s.maxCombo).toBe(2);
    registerJudgment(s, "MISS");
    expect(s.combo).toBe(0);
    expect(s.maxCombo).toBe(2);
  });

  it("accuracy is 1 with no judgments and weights hits", () => {
    expect(accuracy(createScoreState())).toBe(1);
    const s = createScoreState();
    registerJudgment(s, "PERFECT");
    registerJudgment(s, "MISS");
    expect(accuracy(s)).toBeCloseTo(0.5);
  });
});
