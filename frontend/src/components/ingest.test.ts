import { describe, expect, it } from "vitest";
import {
  initialIngestSteps,
  markIngestStepActive,
  markIngestStepDone,
  markIngestStepError,
  nextPendingStep,
} from "./ingest";

describe("ingest pipeline steps", () => {
  it("lists the five backend stages in pipeline order", () => {
    const steps = initialIngestSteps();
    expect(steps.map((s) => s.id)).toEqual([
      "dsp",
      "transcribe",
      "sam",
      "draft",
      "critic",
    ]);
    expect(steps[0]?.label).toContain("FFMPEG");
    expect(steps[3]?.label).toContain("1026");
    expect(steps.every((s) => s.status === "idle")).toBe(true);
  });

  it("advances the active marker through the pipeline", () => {
    let steps = initialIngestSteps();
    expect(nextPendingStep(steps)).toBe("dsp");
    steps = markIngestStepActive(steps, "dsp");
    expect(nextPendingStep(steps)).toBe("transcribe");
    steps = markIngestStepDone(steps, "dsp");
    steps = markIngestStepActive(steps, "transcribe");
    expect(nextPendingStep(steps)).toBe("sam");
    steps = markIngestStepError(steps, "transcribe");
    expect(steps.find((s) => s.id === "transcribe")?.status).toBe("error");
  });

  it("reports null when every stage is done", () => {
    let steps = initialIngestSteps();
    for (const s of steps) {
      steps = markIngestStepDone(steps, s.id);
    }
    expect(nextPendingStep(steps)).toBeNull();
  });
});
