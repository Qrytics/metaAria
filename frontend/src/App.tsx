import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { validateChart, type StageArtResult } from "./api";
import { CamPadOverlay } from "./components/CamPadOverlay";
import { DirectorPanel } from "./components/DirectorPanel";
import { HighwayCanvas } from "./components/HighwayCanvas";
import {
  VocalHighway,
  type VocalPitchSource,
  type VocalStats,
} from "./components/VocalHighway";
import { LivePitchDetector } from "./engine/pitchDetector";
import { TelemetryPanel, VerdictStrip } from "./components/TelemetryPanel";
import { ChartPanel } from "./components/ChartPanel";
import { CriticInspector } from "./components/CriticInspector";
import { RhythmEngine, type EngineSnapshot } from "./engine/engine";
import { maniaSample, pumpBrokenQZ, pumpSample } from "./engine/charts";
import { onsetGrid } from "./footpath";
import type { Chart, ChartMode, CriticReport } from "./types/chart";
import "./studio.css";

const LIB: Record<string, Chart> = {
  "pump-5pad": pumpSample,
  "mania-4k": maniaSample,
  broken: pumpBrokenQZ,
};

export function App(): React.JSX.Element {
  const [chartKey, setChartKey] = useState("pump-5pad");
  const [chart, setChart] = useState<Chart>(pumpSample);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [audioOn, setAudioOn] = useState(true);
  const [snap, setSnap] = useState<EngineSnapshot | null>(null);
  const [report, setReport] = useState<CriticReport | null>(null);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stageArt, setStageArt] = useState<StageArtResult | null>(null);
  const engineRef = useRef<RhythmEngine | null>(null);
  const [vocalMode, setVocalMode] = useState<"sim" | "mic" | "off">("sim");
  const [micError, setMicError] = useState<string | null>(null);
  const [vocalStats, setVocalStats] = useState<VocalStats | null>(null);
  const [runId, setRunId] = useState(0);
  const micRef = useRef<LivePitchDetector | null>(null);

  // Same AudioContext master clock the pad highway reads — one clock, no drift.
  const getSongTimeMs = useCallback(
    () => engineRef.current?.songTimeMs() ?? 0,
    [],
  );

  useEffect(() => {
    if (vocalMode !== "mic") {
      micRef.current?.stop();
      micRef.current = null;
      return undefined;
    }
    const detector = new LivePitchDetector();
    micRef.current = detector;
    setMicError(null);
    detector.start().catch((e: unknown) => {
      setMicError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      detector.stop();
      if (micRef.current === detector) {
        micRef.current = null;
      }
    };
  }, [vocalMode]);

  const pitchSource: VocalPitchSource = useMemo(() => {
    if (vocalMode === "mic") {
      return {
        kind: "mic",
        getReading: () => micRef.current?.latest ?? null,
      };
    }
    return { kind: vocalMode };
  }, [vocalMode]);

  const grid = useMemo(
    () => onsetGrid(chart.bpm, chart.duration_ms),
    [chart.bpm, chart.duration_ms],
  );

  const loadChart = (key: string): void => {
    const next = LIB[key];
    if (next === undefined) {
      return;
    }
    setPlaying(false);
    setChartKey(key);
    setChart(next);
    setSnap(null);
    setReport(null);
    setError(null);
    setVocalStats(null);
    setStageArt(null);
  };

  const runValidator = async (): Promise<void> => {
    setValidating(true);
    setError(null);
    try {
      const res = await validateChart(chart, grid);
      setReport(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setValidating(false);
    }
  };

  const onGenerated = (next: Chart, rep: CriticReport | null): void => {
    setPlaying(false);
    setChartKey("generated");
    setChart(next);
    setSnap(null);
    setReport(rep);
  };

  const replay = (): void => {
    setSnap(null);
    setRunId((i) => i + 1);
    setPlaying(true);
  };

  const mode: ChartMode = chart.mode;
  const switchMode = (m: ChartMode): void => {
    loadChart(m);
  };

  return (
    <div className="studio">
      <header className="studio-head">
        <h1>ARIA CHARTING STUDIO</h1>
        <span className="sub">HW-DAW // ARCADE CABINET REV A</span>
      </header>
      <div className="deck">
        <div>
          <VerdictStrip snap={snap} playing={playing} />
          <section className="panel">
            <header className="panel-head">VOCAL RIBBON</header>
            <VocalHighway
              chartTitle={chart.title}
              phrases={chart.vocal_phrases ?? []}
              playing={playing}
              getSongTimeMs={getSongTimeMs}
              pitchSource={pitchSource}
              onVocalStats={setVocalStats}
            />
            <div className="transport" style={{ marginTop: 8 }}>
              <div className="mode-switch" role="group" aria-label="Vocal pitch source">
                {(["sim", "mic", "off"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={vocalMode === m}
                    onClick={() => setVocalMode(m)}
                  >
                    {m === "sim" ? "SIM SINGER" : m.toUpperCase()}
                  </button>
                ))}
              </div>
              <span aria-live="polite">
                {vocalStats !== null &&
                  `VOCAL ${vocalStats.accuracy.toFixed(0)}% · ${vocalStats.activeText ?? "—"}`}
                {micError !== null && ` · MIC ERROR: ${micError}`}
              </span>
            </div>
          </section>
          {stageArt !== null && (
            <section className="panel" aria-label="Reactive stage background">
              <header className="panel-head">
                STAGE BACKDROP · {stageArt.mock ? "MOCK SVG $0" : "MUSE IMAGE"}
              </header>
              <div
                className="stage-backdrop"
                data-playing={playing}
                style={{ ["--beat" as string]: `${60 / chart.bpm}s` }}
                aria-label="Beat-reactive stage background"
                dangerouslySetInnerHTML={{ __html: stageArt.background_svg }}
              />
            </section>
          )}
          {snap?.finished === true && playing && (
            <section className="panel results" aria-label="Chart complete results">
              <header className="panel-head">CHART COMPLETE</header>
              <div className="telemetry-grid">
                <div className="meter">
                  <span className="meter-label">MAX COMBO</span>
                  <span className="meter-value t-combo">{snap.score.maxCombo}</span>
                </div>
                <div className="meter">
                  <span className="meter-label">POINTS</span>
                  <span className="meter-value t-combo">
                    {Math.round(snap.score.points)}
                  </span>
                </div>
                <div className="meter">
                  <span className="meter-label">JUDGED</span>
                  <span className="meter-value">
                    {snap.judged}/{snap.total}
                  </span>
                </div>
              </div>
              <div className="transport" style={{ marginTop: 8 }}>
                <button type="button" className="hw-btn lit" onClick={replay}>
                  PLAY AGAIN
                </button>
              </div>
            </section>
          )}
          <HighwayCanvas
            key={runId}
            chart={chart}
            playing={playing}
            speed={speed}
            audioOn={audioOn}
            engineRef={engineRef}
            onSnapshot={setSnap}
          />
          <section className="panel">
            <header className="panel-head">TRANSPORT</header>
            <div className="transport">
              <div className="mode-switch" role="group" aria-label="Mode">
                <button
                  type="button"
                  aria-pressed={mode === "mania-4k"}
                  onClick={() => switchMode("mania-4k")}
                >
                  4K
                </button>
                <button
                  type="button"
                  aria-pressed={mode === "pump-5pad"}
                  onClick={() => switchMode("pump-5pad")}
                >
                  5-PAD
                </button>
              </div>
              {!playing ? (
                <button
                  type="button"
                  className="hw-btn lit"
                  onClick={() => setPlaying(true)}
                >
                  PLAY
                </button>
              ) : (
                <button
                  type="button"
                  className="hw-btn"
                  onClick={() => setPlaying(false)}
                >
                  PAUSE
                </button>
              )}
              <button
                type="button"
                className="hw-btn"
                onClick={() => {
                  setPlaying(false);
                  setSnap(null);
                }}
              >
                RESET
              </button>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={audioOn}
                  onChange={(e) => setAudioOn(e.target.checked)}
                />
                AUDIO
              </label>
              <label className="slider">
                SPEED {speed.toFixed(2)}x
                <input
                  type="range"
                  min={0.5}
                  max={2}
                  step={0.05}
                  value={speed}
                  onChange={(e) => setSpeed(Number(e.target.value))}
                />
              </label>
            </div>
            <div className="transport" style={{ marginTop: 8 }}>
              <div className="mode-switch" role="group" aria-label="Chart library">
                {(Object.keys(LIB) as string[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={chartKey === key}
                    onClick={() => loadChart(key)}
                  >
                    {key.toUpperCase()}
                  </button>
                ))}
                {chartKey === "generated" && (
                  <button type="button" aria-pressed={true}>
                    GENERATED
                  </button>
                )}
              </div>
            </div>
          </section>
          <TelemetryPanel snap={snap} playing={playing} />
          <CamPadOverlay
            chartMode={mode}
            onOverdriveChange={(active) => {
              engineRef.current?.setOverdrive(active);
            }}
          />
        </div>
        <div>
          <ChartPanel
            chart={chart}
            grid={grid}
            report={report}
            validating={validating}
            error={error}
            onValidate={() => void runValidator()}
          />
          <CriticInspector onChart={onGenerated} />
          <DirectorPanel
            chart={chart}
            grid={grid}
            onChart={onGenerated}
            onStageArt={setStageArt}
          />
        </div>
      </div>
    </div>
  );
}
