/**
 * Sprite atlas contract tests (node-safe: bake is lazy, no DOM touched).
 */
import { describe, expect, it } from "vitest";
import {
  ATLAS_COLS,
  ATLAS_ROWS,
  CELL,
  CENTER_STOMP_COLOR,
  NOTE_COLORS,
  SPARK_FRAMES,
  beatQuant,
  blit,
  ensureAtlas,
  getAtlas,
  holdBodyKey,
  holdTailKey,
  noteKey,
  receptorKey,
  sparkKey,
} from "./spriteAtlas";

describe("beatQuant", () => {
  it("quantizes quarter / eighth / twelfth / sixteenth fractions", () => {
    expect(beatQuant(120, 0, 0)).toBe("4th");
    expect(beatQuant(120, 0, 500)).toBe("4th");
    expect(beatQuant(120, 0, 250)).toBe("8th");
    expect(beatQuant(120, 0, 750)).toBe("8th");
    expect(beatQuant(120, 0, 1000 / 3)).toBe("12th");
    expect(beatQuant(120, 0, 125)).toBe("16th");
  });

  it("anchors the grid to offset_ms", () => {
    expect(beatQuant(120, 250, 250)).toBe("4th");
    expect(beatQuant(120, 250, 500)).toBe("8th");
  });
});

describe("atlas palette + UV key contract", () => {
  it("uses the mandated StepMania/PIU rhythm colors", () => {
    expect(NOTE_COLORS["4th"]).toBe("#ff2a54");
    expect(NOTE_COLORS["8th"]).toBe("#00d2ff");
    expect(NOTE_COLORS["12th"]).toBe("#ffd000");
    expect(NOTE_COLORS["16th"]).toBe("#00f59b");
    expect(CENTER_STOMP_COLOR).toBe("#ffd000");
  });

  it("keys are stable strings across baked and static sheets", () => {
    expect(receptorKey("Q", "hit")).toBe("receptor:Q:hit");
    expect(receptorKey("M0", "dim")).toBe("receptor:M0:dim");
    expect(noteKey("S", "4th")).toBe("note:S:4th");
    expect(holdBodyKey("8th")).toBe("hold-body:8th");
    expect(holdTailKey("16th")).toBe("hold-tail:16th");
    expect(sparkKey("perfect", 0)).toBe("spark:perfect:0");
    expect(sparkKey("great", SPARK_FRAMES - 1)).toBe(
      `spark:great:${SPARK_FRAMES - 1}`,
    );
  });

  it("atlas grid fits 9 glyph columns and 8-frame spark runs", () => {
    expect(ATLAS_COLS).toBe(9);
    expect(ATLAS_ROWS).toBeGreaterThanOrEqual(12);
    expect(SPARK_FRAMES).toBe(8);
    expect(CELL).toBeGreaterThanOrEqual(64);
  });

  it("stays null-safe without a DOM (vitest/node import)", async () => {
    expect(getAtlas()).toBeNull();
    expect(await ensureAtlas()).toBeNull();
    const ctx = {} as CanvasRenderingContext2D;
    expect(blit(ctx, null, "note:Q:4th", 0, 0, 32, 32)).toBe(false);
  });
});
