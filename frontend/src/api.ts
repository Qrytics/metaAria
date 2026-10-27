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

/* Stage 3: SAM 3.1 air-pad, Voice Director, Muse Image stage. */

export interface SamBox {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

export interface SamMask {
  label: string;
  polygon: Array<[number, number]>;
  confidence: number;
}

export interface SamHitZone {
  pad: string;
  triggered: boolean;
  confidence: number;
}

export interface SamSegmentResult {
  boxes: SamBox[];
  masks: SamMask[];
  hit_zones: SamHitZone[];
  overdrive_active: boolean;
  mock: boolean;
  model: string;
}

/** Track hands/body in a frame; masks map to 5-pad + Overdrive triggers. */
export function samSegment(
  prompt: string,
  mode: ChartMode,
  image_b64?: string,
): Promise<SamSegmentResult> {
  return postJson<SamSegmentResult>("/vision/sam-segment", {
    prompt,
    mode,
    image_b64: image_b64 ?? null,
  });
}

export interface VoiceRemixResult {
  chart: Chart;
  report: CriticReport;
  attempts: number;
  command: string;
  diff_log: string[];
}

/** Remix the active chart from a typed director command (or server audio). */
export function voiceRemix(
  chart: Chart,
  onset_times_ms: number[],
  command_text?: string,
  audio_path?: string,
): Promise<VoiceRemixResult> {
  return postJson<VoiceRemixResult>("/director/voice-remix", {
    chart,
    onset_times_ms,
    command_text: command_text ?? null,
    audio_path: audio_path ?? null,
  });
}

/** Upload a recorded mic blob; returns a server-side path for voice-remix. */
export async function uploadDirectorAudio(blob: Blob): Promise<string> {
  const form = new FormData();
  form.append("file", blob, "director.webm");
  const res = await fetch("/director/upload-audio", {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    throw new Error(`/director/upload-audio -> ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }
  const body = (await res.json()) as { audio_path: string };
  return body.audio_path;
}

export interface StageArtResult {
  jacket_svg: string;
  background_svg: string;
  palette: string[];
  mock: boolean;
  model: string;
}

/** Generate the song jacket + beat-reactive stage background layer. */
export function generateStageArt(
  title: string,
  style_prompt?: string,
  seed?: number,
): Promise<StageArtResult> {
  return postJson<StageArtResult>("/stage/generate-art", {
    title,
    style_prompt: style_prompt ?? "neon cyberpunk arcade stage",
    seed: seed ?? 7,
  });
}
