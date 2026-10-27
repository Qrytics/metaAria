/** Thin fetch wrappers over the FastAPI studio backend (via Vite proxy). */
import type { Chart, ChartMode, CriticReport } from "./types/chart";

export interface GenerateResult {
  chart: Chart;
  report: CriticReport;
  attempts: number;
  bpm: number;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const ctype = res.headers.get("content-type") ?? "";
    if (!ctype.includes("json")) {
      // Static file server / proxy stub: not the FastAPI backend at all.
      await res.text().catch(() => "");
      throw new Error(
        `${path} -> ${res.status} (backend unreachable or not FastAPI — is it running on :8000?)`,
      );
    }
    const body = await res.text();
    throw new Error(`${path} -> ${res.status}: ${body.slice(0, 160)}`);
  }
  return (await res.json()) as T;
}

/** Deterministic pre-checks: chart + onset grid -> compact violation report. */
export function validateChart(chart: Chart, onset_times_ms: number[]): Promise<CriticReport> {
  return postJson<CriticReport>("/charts/validate", {
    chart,
    onset_times_ms,
  });
}

export interface GenerateParams {
  audio_path: string;
  mode: ChartMode;
  title: string;
}

/** Full pipeline: DSP grid + vocals + draft + critic loop. */
export function generateChart(params: GenerateParams): Promise<GenerateResult> {
  return postJson<GenerateResult>("/charts/generate", params);
}
