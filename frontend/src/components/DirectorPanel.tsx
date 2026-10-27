import { useRef, useState } from "react";
import {
  generateStageArt,
  uploadDirectorAudio,
  voiceRemix,
  type StageArtResult,
} from "../api";
import type { Chart, CriticReport } from "../types/chart";
import {
  DIRECTOR_PRESETS,
  initialDirectorSteps,
  markStepActive,
  markStepDone,
  markStepError,
  type DirectorStep,
  type DirectorStepId,
} from "./director";

interface DirectorPanelProps {
  chart: Chart;
  grid: number[];
  onChart: (chart: Chart, report: CriticReport | null) => void;
  onStageArt: (art: StageArtResult) => void;
}

interface DirectorOutcome {
  command: string;
  attempts: number;
  passed: boolean;
  diffLog: string[];
  artMock: boolean;
}

/**
 * Live AI Chart Director: push-to-talk Director Mic + preset command bar.
 * Lights the pipeline steps in sequence (transcribe -> remix -> critic ->
 * art), then hot-swaps the verified remixed chart and reactive background
 * into the live game engine.
 */
export function DirectorPanel({
  chart,
  grid,
  onChart,
  onStageArt,
}: DirectorPanelProps): React.JSX.Element {
  const [command, setCommand] = useState(DIRECTOR_PRESETS[0] ?? "");
  const [steps, setSteps] = useState<DirectorStep[]>(initialDirectorSteps);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<DirectorOutcome | null>(null);
  const [jacket, setJacket] = useState<string | null>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const setStep = (
    id: DirectorStepId,
    fn: (s: DirectorStep[], i: DirectorStepId) => DirectorStep[],
  ): void => {
    setSteps((prev) => fn(prev, id));
  };

  const runRemix = async (audioPath?: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setOutcome(null);
    setSteps(initialDirectorSteps());
    try {
      setStep("transcribe", markStepActive);
      const remixPromise = voiceRemix(
        chart,
        grid,
        audioPath === undefined ? command : undefined,
        audioPath,
      );
      // Typed fallback path has no audio to transcribe; mic path is
      // transcribed server-side inside the same call.
      setStep("transcribe", markStepDone);
      setStep("remix", markStepActive);
      const res = await remixPromise;
      setStep("remix", markStepDone);
      setStep("critic", markStepActive);
      const passed = res.report.passed;
      setStep("critic", passed ? markStepDone : markStepError);
      setStep("art", markStepActive);
      const art = await generateStageArt(res.chart.title, command);
      setStep("art", markStepDone);
      setJacket(art.jacket_svg);
      setOutcome({
        command: res.command,
        attempts: res.attempts,
        passed,
        diffLog: res.diff_log,
        artMock: art.mock,
      });
      onChart(res.chart, res.report);
      onStageArt(art);
    } catch (e) {
      setSteps((prev) => {
        const active = prev.find((s) => s.status === "active");
        return active === undefined ? prev : markStepError(prev, active.id);
      });
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const startMic = async (): Promise<void> => {
    if (recording) {
      return;
    }
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const rec = new MediaRecorder(stream);
      mediaRef.current = rec;
      chunksRef.current = [];
      rec.ondataavailable = (e: BlobEvent) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };
      rec.start();
      setRecording(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const stopMicAndRun = async (): Promise<void> => {
    const rec = mediaRef.current;
    if (!rec || !recording) {
      return;
    }
    setRecording(false);
    const stopped = new Promise<Blob>((resolve) => {
      rec.onstop = () => {
        resolve(new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" }));
      };
    });
    rec.stop();
    const blob = await stopped;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    mediaRef.current = null;
    try {
      const audioPath = await uploadDirectorAudio(blob);
      await runRemix(audioPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="panel" aria-label="Live AI chart director">
      <header className="panel-head">
        <span className="led" data-on={busy || recording} />
        AI CHART DIRECTOR
      </header>
      <div className="director-presets" role="group" aria-label="Preset commands">
        {DIRECTOR_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            className="hw-btn preset"
            aria-pressed={command === p}
            disabled={busy}
            onClick={() => setCommand(p)}
          >
            {p.length > 42 ? `${p.slice(0, 42)}...` : p}
          </button>
        ))}
      </div>
      <label className="field" style={{ marginTop: 8 }}>
        <span>REMIX COMMAND</span>
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          spellCheck={false}
          disabled={busy}
        />
      </label>
      <div className="transport">
        <button
          type="button"
          className={`hw-btn mic${recording ? " live" : ""}`}
          aria-pressed={recording}
          disabled={busy}
          onPointerDown={() => void startMic()}
          onPointerUp={() => void stopMicAndRun()}
          onPointerLeave={() => {
            if (recording) {
              void stopMicAndRun();
            }
          }}
        >
          {recording ? "RELEASE TO REMIX" : "HOLD DIRECTOR MIC"}
        </button>
        <button
          type="button"
          className="hw-btn primary"
          disabled={busy || command.trim() === ""}
          onClick={() => void runRemix()}
        >
          {busy ? "DIRECTING..." : "RUN REMIX"}
        </button>
      </div>
      <ol className="director-steps">
        {steps.map((s) => (
          <li key={s.id} data-status={s.status} className="director-step">
            <span className="led" data-on={s.status === "active" || s.status === "done"} />
            {s.label}
          </li>
        ))}
      </ol>
      {error !== null && <div className="alert">{error}</div>}
      {outcome !== null && (
        <div style={{ marginTop: 8 }}>
          <div className="kv">
            <span>HEARD</span>
            <b>{outcome.command}</b>
          </div>
          <div className="kv">
            <span>CRITIC</span>
            <b>
              {outcome.passed ? "PASS" : "FAIL"} · {outcome.attempts} loop(s)
            </b>
          </div>
          <div className="kv">
            <span>STAGE ART</span>
            <b>{outcome.artMock ? "MOCK SVG $0" : "MUSE IMAGE"}</b>
          </div>
          <div className="violations">
            <div className="sub-head">CRITIC DIFF LOG</div>
            {outcome.diffLog.slice(0, 8).map((line, i) => (
              <span key={`${i}-${line}`} className="badge">
                {line}
              </span>
            ))}
          </div>
        </div>
      )}
      {jacket !== null && (
        <div
          className="director-jacket"
          aria-label="Generated song jacket"
          dangerouslySetInnerHTML={{ __html: jacket }}
        />
      )}
    </section>
  );
}
