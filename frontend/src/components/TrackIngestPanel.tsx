import { useRef, useState } from "react";
import {
  ingestTrack,
  type IngestTelemetry,
  type StageArtResult,
} from "../api";
import type { Chart, ChartMode, CriticReport } from "../types/chart";
import {
  initialIngestSteps,
  markIngestStepActive,
  markIngestStepDone,
  markIngestStepError,
  type IngestStep,
  type IngestStepId,
} from "./ingest";

interface TrackIngestPanelProps {
  onIngested: (
    chart: Chart,
    report: CriticReport,
    audioUrl: string,
    art: StageArtResult,
  ) => void;
}

const AUDIO_ACCEPT = ".mp3,.wav,.ogg,.m4a";
const VIDEO_ACCEPT = ".mp4,.webm";
const STEP_ORDER: readonly IngestStepId[] = [
  "dsp",
  "transcribe",
  "sam",
  "draft",
  "critic",
];

const TELEMETRY_ROWS: ReadonlyArray<{ id: IngestStepId; key: keyof IngestTelemetry }> = [
  { id: "dsp", key: "dsp_ms" },
  { id: "transcribe", key: "transcribe_ms" },
  { id: "sam", key: "sam_ms" },
  { id: "draft", key: "draft_ms" },
  { id: "critic", key: "critic_ms" },
];

/** Backend `mock` flag per ladder step; null = always-local, never mocked. */
const MOCK_FLAG: Record<IngestStepId, string | null> = {
  dsp: null,
  transcribe: "transcribe",
  sam: "sam",
  draft: "draft",
  critic: null,
};

/**
 * Arcade LOAD TRACK dropzone (Stage 5): real MP3/WAV (+optional MP4) into
 * the 5-stage backend pipeline. The single-request pipeline is visualized
 * as a live step ladder, then stamped with the real per-stage timings
 * from the response telemetry. The verified chart hot-swaps into the live
 * game engine; the local audio file plays back through the engine clock.
 */
export function TrackIngestPanel({ onIngested }: TrackIngestPanelProps): React.JSX.Element {
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [mode, setMode] = useState<ChartMode>("pump-5pad");
  const [difficulty, setDifficulty] = useState<"normal" | "hard">("normal");
  const [title, setTitle] = useState("");
  const [steps, setSteps] = useState<IngestStep[]>(initialIngestSteps);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState<IngestTelemetry | null>(null);
  const [mockFlags, setMockFlags] = useState<Record<string, boolean>>({});
  const [summary, setSummary] = useState<string | null>(null);
  const audioRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLInputElement | null>(null);

  const pickDropped = (files: FileList | File[]): void => {
    for (const f of Array.from(files)) {
      const ext = `.${f.name.split(".").pop()?.toLowerCase() ?? ""}`;
      if ([".mp3", ".wav", ".ogg", ".m4a"].includes(ext) && audioFile === null) {
        setAudioFile(f);
        if (title.trim() === "") {
          setTitle(f.name.replace(/\.[^.]+$/, ""));
        }
      } else if ([".mp4", ".webm"].includes(ext) && videoFile === null) {
        setVideoFile(f);
      }
    }
  };

  const run = async (): Promise<void> => {
    if (audioFile === null || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    setSummary(null);
    setTelemetry(null);
    setSteps(markIngestStepActive(initialIngestSteps(), "dsp"));
    // The backend pipeline is one request: walk the ladder on a timer and
    // hold on the critic step until the response lands with real timings.
    const timer = window.setInterval(() => {
      setSteps((prev) => {
        const ai = STEP_ORDER.findIndex(
          (id) => prev.find((s) => s.id === id)?.status === "active",
        );
        if (ai === -1) {
          return markIngestStepActive(prev, "dsp");
        }
        if (ai >= STEP_ORDER.length - 1) {
          return prev;
        }
        const next = STEP_ORDER[ai + 1] as IngestStepId;
        return markIngestStepActive(markIngestStepDone(prev, STEP_ORDER[ai] as IngestStepId), next);
      });
    }, 700);
    try {
      const form = new FormData();
      form.append("audio_file", audioFile, audioFile.name);
      if (videoFile !== null) {
        form.append("video_file", videoFile, videoFile.name);
      }
      form.append("mode", mode);
      form.append("difficulty", difficulty);
      form.append("title", title.trim() === "" ? audioFile.name.replace(/\.[^.]+$/, "") : title.trim());
      const res = await ingestTrack(form);
      window.clearInterval(timer);
      setSteps((prev) => prev.map((s) => ({ ...s, status: "done" as const })));
      setTelemetry(res.telemetry);
      setMockFlags(res.mock);
      setSummary(
        `${res.chart.notes.length} notes · ${res.onset_times_ms.length} onsets · ` +
          `${res.chart.vocal_phrases?.length ?? 0} phrases · ` +
          `critic ${res.report.passed ? "PASS" : "FAIL"} (${res.attempts} loop${res.attempts === 1 ? "" : "s"})`,
      );
      onIngested(res.chart, res.report, URL.createObjectURL(audioFile), res.art);
    } catch (e) {
      window.clearInterval(timer);
      setSteps((prev) => {
        const active = prev.find((s) => s.status === "active");
        return active === undefined ? prev : markIngestStepError(prev, active.id);
      });
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-label="Load track ingest" id="load-track">
      <header className="panel-head">
        <span className="led" data-on={busy} />
        LOAD TRACK <span className="dim">[L]</span>
      </header>
      <div
        className="dropzone"
        data-over={dragOver}
        data-has={audioFile !== null}
        role="button"
        tabIndex={0}
        title="Drop an audio file (MP3/WAV/OGG/M4A) plus an optional MP4/WEBM clip"
        onClick={() => audioRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            audioRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(false);
          pickDropped(e.dataTransfer.files);
        }}
      >
        <b>{audioFile === null ? "DROP MP3 / WAV / OGG / M4A" : audioFile.name}</b>
        <span className="dim">
          {videoFile === null ? "+ OPTIONAL MP4 / WEBM CLIP" : `+ ${videoFile.name}`}
        </span>
      </div>
      <input
        ref={audioRef}
        id="load-track-audio"
        type="file"
        accept={AUDIO_ACCEPT}
        hidden
        aria-label="Audio file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f !== undefined) {
            setAudioFile(f);
            if (title.trim() === "") {
              setTitle(f.name.replace(/\.[^.]+$/, ""));
            }
          }
          e.target.value = "";
        }}
      />
      <input
        ref={videoRef}
        type="file"
        accept={VIDEO_ACCEPT}
        hidden
        aria-label="Video clip"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f !== undefined) {
            setVideoFile(f);
          }
          e.target.value = "";
        }}
      />
      <div className="transport" style={{ marginTop: 8 }}>
        <div className="mode-switch" role="group" aria-label="Ingest mode">
          {(["mania-4k", "pump-5pad"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              disabled={busy}
              onClick={() => setMode(m)}
            >
              {m === "mania-4k" ? "4K" : "5-PAD"}
            </button>
          ))}
        </div>
        <div className="mode-switch" role="group" aria-label="Density">
          {(["normal", "hard"] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={difficulty === d}
              disabled={busy}
              onClick={() => setDifficulty(d)}
            >
              {d.toUpperCase()}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="hw-btn"
          disabled={busy}
          onClick={() => videoRef.current?.click()}
          title="Optional MP4/WEBM clip for SAM 3.1 motion peaks"
        >
          {videoFile === null ? "+ CLIP" : "CLIP ✓"}
        </button>
      </div>
      <label className="field" style={{ marginTop: 8 }}>
        <span>TRACK TITLE</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          spellCheck={false}
          disabled={busy}
          placeholder="Song title"
        />
      </label>
      <div className="transport" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="hw-btn primary"
          disabled={audioFile === null || busy}
          onClick={() => void run()}
        >
          {busy ? "INGESTING..." : "RUN INGEST"}
        </button>
        {(audioFile !== null || videoFile !== null) && (
          <button
            type="button"
            className="hw-btn"
            disabled={busy}
            onClick={() => {
              setAudioFile(null);
              setVideoFile(null);
            }}
          >
            CLEAR
          </button>
        )}
      </div>
      <ol className="director-steps">
        {steps.map((s) => {
          const tele = TELEMETRY_ROWS.find((t) => t.id === s.id);
          const ms = tele !== undefined && telemetry !== null ? telemetry[tele.key] : null;
          const flag = MOCK_FLAG[s.id];
          const mocked = flag !== null && mockFlags[flag] === true;
          return (
            <li key={s.id} data-status={s.status} className="director-step">
              <span className="led" data-on={s.status === "active" || s.status === "done"} />
              {s.label}
              {ms !== null && <span className="dim"> · {ms.toFixed(0)}ms{mocked ? " $0" : ""}</span>}
            </li>
          );
        })}
      </ol>
      {error !== null && <div className="alert">{error}</div>}
      {summary !== null && (
        <div className="kv" style={{ marginTop: 8 }}>
          <span>LOADED</span>
          <b>{summary}</b>
        </div>
      )}
    </section>
  );
}
