import { describe, expect, it } from "vitest";
import { activePhraseAt } from "../components/VocalHighway";
import { duetVocals } from "./charts";
import {
  PITCH_TOLERANCE_CENTS,
  detectPitchYin,
  foldedCentsError,
  freqToMidiFloat,
  midiToFreq,
  scorePitchFrame,
  simulatedReading,
} from "./pitchDetector";
import { speakerColor } from "../types/chart";

/** Render a pure sine frame for the YIN detector. */
function sineFrame(freqHz: number, sampleRate = 48000, n = 2048): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = 0.8 * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return out;
}

describe("freq/midi conversion", () => {
  it("maps A4 to MIDI 69 and round-trips", () => {
    expect(freqToMidiFloat(440)).toBeCloseTo(69, 6);
    expect(midiToFreq(69)).toBeCloseTo(440, 6);
    expect(freqToMidiFloat(0)).toBe(0);
    expect(freqToMidiFloat(-5)).toBe(0);
  });
});

describe("foldedCentsError (octave-agnostic)", () => {
  it("scores the same pitch class at any octave as 0", () => {
    expect(foldedCentsError(69, 69)).toBeCloseTo(0, 6);
    expect(foldedCentsError(81, 69)).toBeCloseTo(0, 6); // A5 vs A4
    expect(foldedCentsError(57, 69)).toBeCloseTo(0, 6); // A3 vs A4
  });

  it("folds a near-miss across the octave boundary", () => {
    // One cent flat of A2 == −1 cent vs A4, not −1201 cents.
    expect(foldedCentsError(56.99, 69)).toBeCloseTo(-1, 0);
    // One semitone sharp in the same octave stays +100.
    expect(foldedCentsError(70, 69)).toBeCloseTo(100, 6);
  });

  it("caps the worst error at ±600 cents", () => {
    expect(Math.abs(foldedCentsError(75, 69))).toBeLessThanOrEqual(600);
  });
});

describe("scorePitchFrame", () => {
  it("hits within ±1.5 semitones inclusive", () => {
    expect(scorePitchFrame(69, 69, 0.9).hit).toBe(true);
    expect(scorePitchFrame(69 + PITCH_TOLERANCE_CENTS / 100, 69, 0.9).hit).toBe(
      true,
    );
  });

  it("misses beyond the tolerance, even an octave up", () => {
    expect(scorePitchFrame(69 + 2, 69, 0.9).hit).toBe(false);
    // Same pitch class one octave up still hits (folded to ~0).
    expect(scorePitchFrame(81, 69, 0.9).hit).toBe(true);
  });

  it("skips unpitched tubes and unclear frames", () => {
    expect(scorePitchFrame(69, 0, 0.9).hit).toBe(false);
    expect(scorePitchFrame(69, 69, 0.1).hit).toBe(false);
  });
});

describe("detectPitchYin", () => {
  it("locks a 440Hz sine within a few Hz with high clarity", () => {
    const est = detectPitchYin(sineFrame(440), 48000);
    expect(est).not.toBeNull();
    expect(est!.frequencyHz).toBeCloseTo(440, -1);
    expect(est!.clarity).toBeGreaterThan(0.5);
  });

  it("tracks a second octave (880Hz) without halving", () => {
    const est = detectPitchYin(sineFrame(880), 48000);
    expect(est).not.toBeNull();
    expect(est!.frequencyHz).toBeCloseTo(880, -1);
  });

  it("returns null for silence", () => {
    expect(detectPitchYin(new Float32Array(2048), 48000)).toBeNull();
  });
});

describe("simulatedReading", () => {
  it("stays inside the hit window around the target", () => {
    for (const t of [0, 0.37, 1.13, 2.71]) {
      const r = simulatedReading(69, t);
      expect(r.voiced).toBe(true);
      expect(Math.abs(r.centsOff)).toBeLessThanOrEqual(PITCH_TOLERANCE_CENTS);
    }
  });

  it("marks unpitched targets unvoiced", () => {
    expect(simulatedReading(0, 1).voiced).toBe(false);
  });
});

describe("demo duet chart contract", () => {
  it("is sorted and overlap-free per speaker (backend validator mirror)", () => {
    const starts = duetVocals.map((p) => p.start_ms);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    const lastEnd = new Map<string, number>();
    for (const p of duetVocals) {
      const prev = lastEnd.get(p.speaker_id) ?? -1;
      expect(p.start_ms).toBeGreaterThanOrEqual(prev);
      lastEnd.set(p.speaker_id, Math.max(prev, p.end_ms));
    }
  });

  it("contains both duet speakers plus one harmony overlap", () => {
    const speakers = new Set(duetVocals.map((p) => p.speaker_id));
    expect(speakers.has("SPEAKER_00")).toBe(true);
    expect(speakers.has("SPEAKER_01")).toBe(true);
    const overlap = duetVocals.some(
      (a) =>
        a.speaker_id === "SPEAKER_00" &&
        duetVocals.some(
          (b) =>
            b.speaker_id === "SPEAKER_01" &&
            a.start_ms < b.end_ms &&
            b.start_ms < a.end_ms,
        ),
    );
    expect(overlap).toBe(true);
  });

  it("colors SPEAKER_00 cyan and SPEAKER_01 magenta", () => {
    expect(speakerColor("SPEAKER_00")).toBe("#22d3ee");
    expect(speakerColor("SPEAKER_01")).toBe("#ff4fd8");
  });
});

describe("activePhraseAt", () => {
  it("returns the pitched phrase under the song clock", () => {
    expect(activePhraseAt(duetVocals, 100)?.text).toBe("Oh oh");
    expect(activePhraseAt(duetVocals, 950)).toBeNull(); // gap
  });

  it("skips the unpitched talkie break", () => {
    expect(activePhraseAt(duetVocals, 10500)).toBeNull();
  });
});
