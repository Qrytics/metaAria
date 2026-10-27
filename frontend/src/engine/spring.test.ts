/**
 * Spring unit tests: the closed-form underdamped oscillator must settle
 * to its target within tolerance and overshoot predictably when zeta < 1.
 */
import { describe, expect, it } from "vitest";
import {
  GLOW_SPRING,
  POP_SPRING,
  RECEPTOR_STOMP,
  dampedFrequency,
  holdGlow,
  popScale,
  receptorScale,
  springValue,
} from "./spring";

describe("springValue closed form", () => {
  it("starts exactly at `from` when t = 0", () => {
    expect(springValue(0.82, 1.0, 45, 0.35, 0)).toBeCloseTo(0.82, 12);
    expect(springValue(1.45, 1.0, 18, 0.4, 0)).toBeCloseTo(1.45, 12);
  });

  it("settles to Target within tolerance for every gameplay spring", () => {
    const cases = [RECEPTOR_STOMP, POP_SPRING, GLOW_SPRING];
    for (const c of cases) {
      const v = springValue(c.from, c.target, c.omegaN, c.zeta, 3);
      expect(Math.abs(v - c.target)).toBeLessThan(1e-4);
    }
  });

  it("is already visually settled after a short gameplay window", () => {
    // Receptor stomp must be within 1% of rest after 300ms.
    expect(
      Math.abs(springValue(0.82, 1.0, 45, 0.35, 0.3) - 1.0),
    ).toBeLessThan(0.01);
    // Popup must be within 2% of rest after 500ms.
    expect(
      Math.abs(springValue(1.45, 1.0, 18, 0.4, 0.5) - 1.0),
    ).toBeLessThan(0.02);
  });

  it("overshoots predictably when zeta < 1", () => {
    // From below target with zero initial velocity, an underdamped
    // spring must cross above target at least once.
    let crossed = false;
    for (let ms = 1; ms <= 1000; ms += 1) {
      if (springValue(0.82, 1.0, 45, 0.35, ms / 1000) > 1.0) {
        crossed = true;
        break;
      }
    }
    expect(crossed).toBe(true);

    // From above target it must dip below target at least once.
    let dipped = false;
    for (let ms = 1; ms <= 1500; ms += 1) {
      if (springValue(1.45, 1.0, 18, 0.4, ms / 1000) < 1.0) {
        dipped = true;
        break;
      }
    }
    expect(dipped).toBe(true);
  });

  it("matches the analytical textbook form value(t) term by term", () => {
    const from = 0.5;
    const target = 2.0;
    const omegaN = 10;
    const zeta = 0.25;
    const t = 0.37;
    const omegaD = omegaN * Math.sqrt(1 - zeta * zeta);
    const a = from - target;
    const b = (zeta * omegaN * a) / omegaD;
    const expected =
      target +
      Math.exp(-zeta * omegaN * t) * (a * Math.cos(omegaD * t) + b * Math.sin(omegaD * t));
    expect(springValue(from, target, omegaN, zeta, t)).toBeCloseTo(
      expected,
      12,
    );
  });

  it("clamps negative time to the displaced start value", () => {
    expect(springValue(0.82, 1.0, 45, 0.35, -0.5)).toBeCloseTo(0.82, 12);
  });

  it("rejects non-underdamped parameters", () => {
    expect(() => springValue(0, 1, 45, 1, 0.1)).toThrow(RangeError);
    expect(() => springValue(0, 1, 45, 0, 0.1)).toThrow(RangeError);
    expect(() => springValue(0, 1, 45, 1.5, 0.1)).toThrow(RangeError);
    expect(() => springValue(0, 1, 0, 0.35, 0.1)).toThrow(RangeError);
  });

  it("dampedFrequency matches omegaN * sqrt(1 - zeta^2)", () => {
    expect(dampedFrequency(45, 0.35)).toBeCloseTo(
      45 * Math.sqrt(1 - 0.35 * 0.35),
      12,
    );
  });
});

describe("gameplay spring helpers", () => {
  it("receptorScale snaps to 0.82 on press and rests at 1.0", () => {
    expect(receptorScale(0)).toBeCloseTo(1.0, 12);
    expect(receptorScale(-10)).toBeCloseTo(1.0, 12);
    expect(receptorScale(1)).toBeLessThan(1.0);
    expect(Math.abs(receptorScale(2000) - 1.0)).toBeLessThan(1e-4);
  });

  it("popScale starts at 1.45 and settles crisply to 1.0", () => {
    expect(popScale(0)).toBeCloseTo(1.45, 12);
    expect(Math.abs(popScale(2000) - 1.0)).toBeLessThan(1e-4);
    expect(Math.abs(popScale(500) - 1.0)).toBeLessThan(0.02);
  });

  it("holdGlow erupts from 0 and holds full intensity", () => {
    expect(holdGlow(0)).toBeCloseTo(0.0, 12);
    expect(holdGlow(50)).toBeGreaterThan(0.3);
    expect(Math.abs(holdGlow(2000) - 1.0)).toBeLessThan(1e-4);
  });
});
