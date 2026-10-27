/**
 * Director pipeline step machine. DOM-free so vitest can cover it;
 * `DirectorPanel.tsx` renders it.
 */

export type DirectorStepId = "transcribe" | "remix" | "critic" | "art";

export type StepStatus = "idle" | "active" | "done" | "error";

export interface DirectorStep {
  id: DirectorStepId;
  label: string;
  status: StepStatus;
}

export const DIRECTOR_STEP_LABELS: Record<DirectorStepId, string> = {
  transcribe: "Muse Voice Transcribe",
  remix: "Muse Spark Open 1026 Remix",
  critic: "Foot-Parity Validator + Muse Wonder Critic",
  art: "Muse Image Stage Art",
};

const ORDER: readonly DirectorStepId[] = [
  "transcribe",
  "remix",
  "critic",
  "art",
];

export function initialDirectorSteps(): DirectorStep[] {
  return ORDER.map((id) => ({ id, label: DIRECTOR_STEP_LABELS[id], status: "idle" }));
}

function setStatus(
  steps: DirectorStep[],
  id: DirectorStepId,
  status: StepStatus,
): DirectorStep[] {
  return steps.map((s) => (s.id === id ? { ...s, status } : s));
}

export function markStepActive(
  steps: DirectorStep[],
  id: DirectorStepId,
): DirectorStep[] {
  return setStatus(steps, id, "active");
}

export function markStepDone(
  steps: DirectorStep[],
  id: DirectorStepId,
): DirectorStep[] {
  return setStatus(steps, id, "done");
}

export function markStepError(
  steps: DirectorStep[],
  id: DirectorStepId,
): DirectorStep[] {
  return setStatus(steps, id, "error");
}

/**
 * Preset spoken-style commands for the Director command bar. Kept under 42
 * characters so no label truncates mid-word; each keeps the keywords the
 * ENV=dev mock director keys on ("twice as fast", "crossover", "half").
 */
export const DIRECTOR_PRESETS: readonly string[] = [
  "Chorus twice as fast with crossovers",
  "Slow the bridge to half speed",
  "Add crossovers through the verse",
];
