import { useState } from "react";
import { generateChart } from "../api";
import type { Chart, ChartMode, CriticReport } from "../types/chart";

interface CriticInspectorProps {
  onChart: (chart: Chart, report: CriticReport | null) => void;
}

/**
 * AI Charting + Critic Inspector: fires the backend pipeline
 * (POST /charts/generate) and surfaces the critic verdict.
 */
export function CriticInspector({ onChart }: CriticInspectorProps): React.JSX.Element {
  const [audioPath, setAudioPath] = useState("");
  const [mode, setMode] = useState<ChartMode>("pump-5pad");
  const [title, setTitle] = useState("AI Draft");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<number | null>(null);
  const [report, setReport] = useState<CriticReport | null>(null);

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await generateChart({
        audio_path: audioPath,
        mode,
        title,
      });
      setAttempts(res.attempts);
      setReport(res.report);
      onChart(res.chart, res.report);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <header className="panel-head">AI CHARTING + CRITIC</header>
      <label className="field">
        <span>AUDIO PATH (server-side)</span>
        <input
          value={audioPath}
          onChange={(e) => setAudioPath(e.target.value)}
          placeholder="/data/tracks/song.mp3"
          spellCheck={false}
        />
      </label>
      <label className="field">
        <span>MODE</span>
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as ChartMode)}
        >
          <option value="pump-5pad">pump-5pad</option>
          <option value="mania-4k">mania-4k</option>
        </select>
      </label>
      <label className="field">
        <span>TITLE</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          spellCheck={false}
        />
      </label>
      <button
        type="button"
        className="hw-btn primary"
        onClick={() => void run()}
        disabled={busy || audioPath.trim() === ""}
      >
        {busy ? "GENERATING..." : "GENERATE CHART"}
      </button>
      {audioPath.trim() === "" && (
        <div className="dim" style={{ marginTop: 6 }}>
          Enter a server-side audio path to arm GENERATE — the button stays
          off until then, even after a failed run elsewhere.
        </div>
      )}
      {error !== null && <div className="alert">{error}</div>}
      {attempts !== null && (
        <div className="kv">
          <span>CRITIC LOOP</span>
          <b>{attempts} attempt(s)</b>
        </div>
      )}
      {report !== null && (
        <div className="violations">
          <div className="sub-head">
            CRITIC: {report.passed ? "PASS" : "FAIL"}
          </div>
          {report.violations.slice(0, 8).map((v, i) => (
            <span
              key={`${v.type}-${v.time_ms ?? "na"}-${i}`}
              className={`badge badge-${v.type} sev-${v.severity}`}
            >
              [{v.type}]{v.time_ms !== null ? ` @${v.time_ms}ms` : ""}{" "}
              {v.message}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
