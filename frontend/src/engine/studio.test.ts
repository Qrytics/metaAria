import { describe, expect, it } from "vitest";
import { pumpSample, maniaSample } from "./charts";
import type { Chart, CriticReport } from "../types/chart";
import {
  HISTORY_CAP,
  REPAIR_COMMAND,
  buildMarkers,
  bucketAccuracy,
  doubleDensity,
  editStorageKey,
  emptyHistory,
  exportPack,
  gradeForAccuracy,
  halveDensity,
  importPack,
  mirrorChart,
  nearestGridTime,
  nearestNoteIndex,
  pushHistory,
  redoHistory,
  snapTimeToGrid,
  toggleNoteAt,
  undoHistory,
} from "./studio";

const GRID = [0, 500, 1000, 1500, 2000];

function emptyReport(violations: CriticReport["violations"]): CriticReport {
  return {
    passed: violations.length === 0,
    chart_mode: "pump-5pad",
    snap_violations: 0,
    parity_violations: violations.length,
    density_violations: 0,
    violations,
  };
}

describe("snapTimeToGrid", () => {
  it("snaps within ±15ms and rejects outside", () => {
    expect(snapTimeToGrid(1000, GRID)).toBe(1000);
    expect(snapTimeToGrid(1014, GRID)).toBe(1000);
    expect(snapTimeToGrid(986, GRID)).toBe(1000);
    expect(snapTimeToGrid(1016, GRID)).toBeNull();
    expect(snapTimeToGrid(750, GRID)).toBeNull();
  });

  it("finds the nearest grid time without tolerance", () => {
    expect(nearestGridTime(760, GRID)).toBe(1000);
    expect(nearestGridTime(740, GRID)).toBe(500);
  });
});

describe("toggleNoteAt", () => {
  it("removes a matching note and re-adds it (pump)", () => {
    const removed = toggleNoteAt(pumpSample, 0, "Q");
    expect(removed.notes.length).toBe(pumpSample.notes.length - 1);
    expect(removed.notes.some((n) => n.time_ms === 0 && n.pad === "Q")).toBe(false);
    // Input chart untouched: toggle is immutable.
    expect(pumpSample.notes.length).toBe(removed.notes.length + 1);
    const added = toggleNoteAt(removed, 0, "Q");
    expect(added.notes.length).toBe(pumpSample.notes.length);
    expect(added.notes.some((n) => n.time_ms === 0 && n.pad === "Q")).toBe(true);
  });

  it("adds a tap on an empty lane and keeps time order (mania)", () => {
    const next = toggleNoteAt(maniaSample, 0, 1);
    expect(next.notes.length).toBe(maniaSample.notes.length + 1);
    const times = next.notes.map((n) => n.time_ms);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    const added = next.notes.find((n) => n.time_ms === 0 && n.lane === 1);
    expect(added?.kind).toBe("tap");
    // Toggling a different lane at the same time does not remove the first.
    const both = toggleNoteAt(next, 0, 1);
    expect(both.notes.length).toBe(maniaSample.notes.length);
  });
});

describe("mirrorChart", () => {
  it("swaps pump sides and keeps center", () => {
    const mirrored = mirrorChart(pumpSample);
    const at = (t: number) => mirrored.notes.find((n) => n.time_ms === t)?.pad;
    expect(at(0)).toBe("E"); // was Q
    expect(at(500)).toBe("Q"); // was E
    expect(at(3000)).toBe("S"); // center stays
    expect(at(1000)).toBe("C"); // was Z
    expect(mirrored.notes.length).toBe(pumpSample.notes.length);
  });

  it("swaps mania lanes 0<->3 and 1<->2", () => {
    const mirrored = mirrorChart(maniaSample);
    expect(mirrored.notes[0]?.lane).toBe(3);
    expect(mirrored.notes[1]?.lane).toBe(2);
  });

  it("is its own inverse", () => {
    expect(mirrorChart(mirrorChart(pumpSample))).toEqual(pumpSample);
  });
});

describe("density", () => {
  it("halves deterministically and doubles back past the original", () => {
    const halved = halveDensity(pumpSample);
    expect(halved.notes.length).toBe(Math.ceil(pumpSample.notes.length / 2));
    const doubled = doubleDensity(halved);
    expect(doubled.notes.length).toBeGreaterThan(halved.notes.length);
    const times = doubled.notes.map((n) => n.time_ms);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("double converges instead of stacking duplicates", () => {
    const once = doubleDensity(pumpSample);
    const twice = doubleDensity(once);
    const dupes = twice.notes.filter(
      (n, i) =>
        twice.notes.findIndex((m) => m.time_ms === n.time_ms) !== i,
    );
    expect(dupes.length).toBe(0);
  });
});

describe("nearestNoteIndex + buildMarkers", () => {
  it("finds the nearest note inside the window only", () => {
    expect(nearestNoteIndex(pumpSample, 5)).toBe(0);
    expect(nearestNoteIndex(pumpSample, 250, 120)).toBe(-1);
  });

  it("maps violations onto note indices with severities", () => {
    const report = emptyReport([
      { type: "parity", time_ms: 2100, message: "Q->Z 100ms", severity: "error" },
      { type: "snap", time_ms: null, message: "global", severity: "warning" },
      { type: "drift", time_ms: 99999, message: "far", severity: "error" } as never,
    ]);
    const marks = buildMarkers(pumpSample, report);
    // 2100ms is the Z note in pumpSample.
    const idx = pumpSample.notes.findIndex((n) => n.time_ms === 2100);
    expect(idx).toBe(-1); // 2100 lives in the broken demo, not the sample
    const landed = pumpSample.notes.findIndex((n) => n.time_ms === 2000);
    expect(marks.get(landed)?.[0]?.text ?? "").toContain("PARITY");
    expect(marks.get(landed)?.[0]?.severity).toBe("error");
    expect(marks.size).toBe(1);
  });
});

describe("history", () => {
  it("pushes, undoes, and redoes in order", () => {
    let h = emptyHistory<Chart>();
    h = pushHistory(h, pumpSample);
    const edited = toggleNoteAt(pumpSample, 0, "Q");
    const u = undoHistory(h, edited);
    expect(u.value).toEqual(pumpSample);
    const r = redoHistory(u.history, pumpSample);
    expect(r.value).toEqual(edited);
  });

  it("returns null at the ends and clears redo on push", () => {
    const h = emptyHistory<number>();
    expect(undoHistory(h, 1).value).toBeNull();
    expect(redoHistory(h, 1).value).toBeNull();
    const h2 = pushHistory(pushHistory(h, 1), 2);
    const u = undoHistory(h2, 3);
    const h3 = pushHistory(u.history, 9);
    expect(redoHistory(h3, 9).value).toBeNull();
  });

  it("caps the past at HISTORY_CAP", () => {
    let h = emptyHistory<number>();
    for (let i = 0; i < HISTORY_CAP + 10; i += 1) {
      h = pushHistory(h, i);
    }
    expect(h.past.length).toBe(HISTORY_CAP);
    expect(h.past[0]).toBe(10);
  });
});

describe("aria packs", () => {
  it("round-trips chart + grid + stage meta", () => {
    const pack = exportPack(pumpSample, GRID);
    expect(pack.app).toBe("aria");
    expect(pack.stage.mode).toBe("pump-5pad");
    const back = importPack(JSON.parse(JSON.stringify(pack)) as unknown);
    expect(back.chart).toEqual(pumpSample);
    expect(back.grid).toEqual(GRID);
    // Export is a deep copy: mutating it cannot touch the chart.
    const before = pumpSample.notes.length;
    pack.chart.notes.length = 0;
    expect(pumpSample.notes.length).toBe(before);
  });

  it("sorts unsorted notes and grids on import", () => {
    const pack = exportPack(pumpSample, [...GRID].reverse());
    pack.chart.notes.reverse();
    const back = importPack(pack as unknown);
    const times = back.chart.notes.map((n) => n.time_ms);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(back.grid).toEqual(GRID);
  });

  it("rejects garbage with reasons", () => {
    for (const bad of [
      null,
      {},
      { app: "aria", pack: 2 },
      { app: "aria", pack: 1 },
      { app: "aria", pack: 1, chart: { mode: "nope" } },
      exportPack({ ...pumpSample, mode: "mania-4k" }, GRID),
    ]) {
      expect(() => importPack(bad as unknown)).toThrow();
    }
    const wrongKey = exportPack(pumpSample, GRID);
    (wrongKey.chart.notes[0] as { lane?: number }).lane = 0;
    expect(() => importPack(wrongKey as unknown)).toThrow();
  });

  it("keys storage per chart", () => {
    expect(editStorageKey("pump-5pad")).toBe("aria.edit.pump-5pad");
  });
});

describe("grades", () => {
  it("maps accuracy boundaries to letters", () => {
    expect(gradeForAccuracy(1)).toBe("SSS");
    expect(gradeForAccuracy(0.98)).toBe("SSS");
    expect(gradeForAccuracy(0.979)).toBe("SS");
    expect(gradeForAccuracy(0.95)).toBe("SS");
    expect(gradeForAccuracy(0.9)).toBe("S");
    expect(gradeForAccuracy(0.8)).toBe("A");
    expect(gradeForAccuracy(0.7)).toBe("B");
    expect(gradeForAccuracy(0.5)).toBe("C");
    expect(gradeForAccuracy(0.3)).toBe("D");
    expect(gradeForAccuracy(0.29)).toBe("F");
  });

  it("scores buckets with engine weights and nulls empty ones", () => {
    expect(
      bucketAccuracy({ PERFECT: 1, GREAT: 0, GOOD: 0, MISS: 0 }),
    ).toBe(1);
    expect(
      bucketAccuracy({ PERFECT: 0, GREAT: 1, GOOD: 1, MISS: 2 }),
    ).toBeCloseTo((0.7 + 0.4) / 4);
    expect(
      bucketAccuracy({ PERFECT: 0, GREAT: 0, GOOD: 0, MISS: 0 }),
    ).toBeNull();
  });

  it("ships a static repair command", () => {
    expect(REPAIR_COMMAND.length).toBeGreaterThan(20);
  });
});
