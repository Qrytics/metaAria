/**
 * LOAD TRACK pipeline step machine (Stage 5). DOM-free so vitest can cover
 * it; `TrackIngestPanel.tsx` renders it.
 */

export type IngestStepId = "dsp" | "transcribe" | "sam" | "draft" | "critic";

export type StepStatus = "idle" | "active" | "done" | "error";

export interface IngestStep {
  id: IngestStepId;
  label: string;
  status: StepStatus;
}

export const INGEST_STEP_LABELS: Record<IngestStepId, string> = {
  dsp: "1. FFMPEG + LIBROSA DSP",
  transcribe: "2. MUSE VOICE TRANSCRIBE",
  sam: "3. SAM 3.1 MOTION PEAKS",
  draft: "4. MUSE SPARK OPEN 1026 DRAFT",
  critic: "5. MUSE WONDER CRITIC VERIFY",
};

const ORDER: readonly IngestStepId[] = [
  "dsp",
  "transcribe",
  "sam",
  "draft",
  "critic",
];

export function initialIngestSteps(): IngestStep[] {
  return ORDER.map((id) => ({ id, label: INGEST_STEP_LABELS[id], status: "idle" }));
}

function setStatus(
  steps: IngestStep[],
  id: IngestStepId,
  status: StepStatus,
): IngestStep[] {
  return steps.map((s) => (s.id === id ? { ...s, status } : s));
}

export function markIngestStepActive(
  steps: IngestStep[],
  id: IngestStepId,
): IngestStep[] {
  return setStatus(steps, id, "active");
}

export function markIngestStepDone(
  steps: IngestStep[],
  id: IngestStepId,
): IngestStep[] {
  return setStatus(steps, id, "done");
}

export function markIngestStepError(
  steps: IngestStep[],
  id: IngestStepId,
): IngestStep[] {
  return setStatus(steps, id, "error");
}

/** Next step to light while the single-request pipeline is in flight. */
export function nextPendingStep(steps: IngestStep[]): IngestStepId | null {
  const active = steps.find((s) => s.status === "active");
  if (active !== undefined) {
    const i = ORDER.indexOf(active.id);
    return ORDER[Math.min(i + 1, ORDER.length - 1)];
  }
  const idle = steps.find((s) => s.status === "idle");
  return idle === undefined ? null : idle.id;
}
