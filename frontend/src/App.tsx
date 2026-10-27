import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { validateChart, voiceRemix, type StageArtResult } from "./api";
import { CamPadOverlay } from "./components/CamPadOverlay";
import { ChartEditor, acceptsStudioKey } from "./components/ChartEditor";
import { DirectorPanel } from "./components/DirectorPanel";
import { HighwayCanvas } from "./components/HighwayCanvas";
import { ResultsPanel } from "./components/ResultsPanel";
import { TrackIngestPanel } from "./components/TrackIngestPanel";
import {
  VocalHighway,
  type VocalPitchSource,
  type VocalStats,
} from "./components/VocalHighway";
import { LivePitchDetector } from "./engine/pitchDetector";
import { ArcadeHudLeft, ArcadeHudRight } from "./components/TelemetryPanel";
import { ChartPanel } from "./components/ChartPanel";
import { CriticInspector } from "./components/CriticInspector";
import { RhythmEngine, type EngineSnapshot } from "./engine/engine";
import { maniaSample, pumpBrokenQZ, pumpSample } from "./engine/charts";
import { onsetGrid } from "./footpath";
import {
  buildMarkers,
  doubleDensity,
  editStorageKey,
  emptyHistory,
  exportPack,
  halveDensity,
  importPack,
  mirrorChart,
  nearestGridTime,
  pushHistory,
  redoHistory,
  toggleNoteAt,
  undoHistory,
  REPAIR_COMMAND,
  type EditHistory,
} from "./engine/studio";
import type { NoteMark } from "./engine/renderer";
import type {
  Chart,
  ChartMode,
  CriticReport,
  ManiaLane,
  PumpPad,
} from "./types/chart";
import "./studio.css";

const LIB: Record<string, Chart> = {
  "pump-5pad": pumpSample,
  "mania-4k": maniaSample,
  broken: pumpBrokenQZ,
};

function isTypingTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement
  );
}

export function App(): React.JSX.Element {
  const [chartKey, setChartKey] = useState("pump-5pad");
  const [chart, setChart] = useState<Chart>(pumpSample);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [scrollDir, setScrollDir] = useState<"up" | "down">("up");
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
  // Stage 4: paused chart studio (PLAY and EDIT never overlap).
  const [editing, setEditing] = useState(false);
  const [cursorMs, setCursorMs] = useState(0);
  const [markers, setMarkers] = useState<Map<number, NoteMark[]>>(new Map());
  const [repairBusy, setRepairBusy] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [repairLog, setRepairLog] = useState<string[] | null>(null);
  const [showResults, setShowResults] = useState(false);
  // Stage 5: ingested real-audio track — chart + playable object URL.
  const [ingested, setIngested] = useState<Chart | null>(null);
  const [trackAudioUrl, setTrackAudioUrl] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [histLen, setHistLen] = useState({ undo: 0, redo: 0 });
  const historyRef = useRef<EditHistory<Chart>>(emptyHistory());
  const micRef = useRef<LivePitchDetector | null>(null);
  // Studio rack drawer: slides over the right rail; auto-hides during PLAY.
  const [drawerOpen, setDrawerOpen] = useState(true);

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

  // Autosave edited charts; stock reload restores them via loadChart.
  useEffect(() => {
    if (!dirty) {
      return;
    }
    try {
      localStorage.setItem(
        editStorageKey(chartKey),
        JSON.stringify(exportPack(chart, grid)),
      );
    } catch {
      // Quota or private mode: edits stay in memory for this session.
    }
  }, [dirty, chart, chartKey, grid]);

  const canRevert = dirty && LIB[chartKey] !== undefined;

  const loadChart = (key: string): void => {
    const next = LIB[key];
    if (next === undefined) {
      return;
    }
    setPlaying(false);
    setChartKey(key);
    // Restore autosaved edits for stock charts only.
    let restored: Chart | null = null;
    try {
      const raw = localStorage.getItem(editStorageKey(key));
      if (raw !== null) {
        const parsed = importPack(JSON.parse(raw) as unknown);
        if (parsed.chart.mode === next.mode) {
          restored = parsed.chart;
        }
      }
    } catch {
      restored = null;
    }
    setChart(restored ?? structuredClone(next));
    setDirty(restored !== null);
    setSnap(null);
    setReport(null);
    setError(null);
    setVocalStats(null);
    setStageArt(null);
    setEditing(false);
    setCursorMs(0);
    setMarkers(new Map());
    setRepairLog(null);
    setRepairError(null);
    setShowResults(false);
    setImportError(null);
    historyRef.current = emptyHistory();
    setHistLen({ undo: 0, redo: 0 });
  };

  const runValidator = async (): Promise<void> => {
    setValidating(true);
    setError(null);
    try {
      const res = await validateChart(chart, grid);
      setReport(res);
      setMarkers(buildMarkers(chart, res));
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
    setEditing(false);
    setMarkers(new Map());
    setRepairLog(null);
    setDirty(false);
    setShowResults(false);
    historyRef.current = emptyHistory();
    setHistLen({ undo: 0, redo: 0 });
  };

  /* Stage 5: an ingested upload hot-swaps in with its real audio + art. */
  const onIngested = (
    next: Chart,
    rep: CriticReport | null,
    audioUrl: string,
    art: StageArtResult,
  ): void => {
    setPlaying(false);
    setTrackAudioUrl((old) => {
      if (old !== null) {
        URL.revokeObjectURL(old);
      }
      return audioUrl;
    });
    setIngested(structuredClone(next));
    setChartKey("ingested");
    setChart(next);
    setSnap(null);
    setReport(rep);
    setStageArt(art);
    setEditing(false);
    setMarkers(new Map());
    setRepairLog(null);
    setRepairError(null);
    setDirty(false);
    setShowResults(false);
    setImportError(null);
    historyRef.current = emptyHistory();
    setHistLen({ undo: 0, redo: 0 });
  };

  const loadIngested = (): void => {
    if (ingested === null) {
      return;
    }
    setPlaying(false);
    setChartKey("ingested");
    setChart(structuredClone(ingested));
    setSnap(null);
    setEditing(false);
    setCursorMs(0);
    setMarkers(new Map());
    setRepairLog(null);
    setRepairError(null);
    setShowResults(false);
    setImportError(null);
    historyRef.current = emptyHistory();
    setHistLen({ undo: 0, redo: 0 });
  };

  const replay = (): void => {
    setSnap(null);
    setShowResults(false);
    setRunId((i) => i + 1);
    setPlaying(true);
  };

  /* Stage 4 edit ops: all paused-only, all immutable chart swaps. */
  const activeEdit = editing && !playing;

  const commitEdit = (next: Chart): void => {
    historyRef.current = pushHistory(
      historyRef.current,
      structuredClone(chart),
    );
    setHistLen({ undo: historyRef.current.past.length, redo: 0 });
    setChart(next);
    setDirty(true);
    setMarkers(new Map());
  };

  const toggleEdit = (): void => {
    if (editing) {
      setEditing(false);
      return;
    }
    setPlaying(false);
    setCursorMs(grid[0] ?? 0);
    setEditing(true);
  };

  const scrub = (step: number): void => {
    if (grid.length === 0) {
      return;
    }
    let best = 0;
    let bestAbs = Number.POSITIVE_INFINITY;
    grid.forEach((g, i) => {
      const d = Math.abs(g - cursorMs);
      if (d < bestAbs) {
        bestAbs = d;
        best = i;
      }
    });
    const next = Math.min(grid.length - 1, Math.max(0, best + step));
    setCursorMs(grid[next] ?? cursorMs);
  };

  const toggleEditKey = (key: ManiaLane | PumpPad): void => {
    if (!activeEdit) {
      return;
    }
    commitEdit(toggleNoteAt(chart, cursorMs, key));
  };

  const doUndo = (): void => {
    const { history, value } = undoHistory(
      historyRef.current,
      structuredClone(chart),
    );
    if (value === null) {
      return;
    }
    historyRef.current = history;
    setHistLen({ undo: history.past.length, redo: history.future.length });
    setChart(value);
    setDirty(true);
    setMarkers(new Map());
  };

  const doRedo = (): void => {
    const { history, value } = redoHistory(
      historyRef.current,
      structuredClone(chart),
    );
    if (value === null) {
      return;
    }
    historyRef.current = history;
    setHistLen({ undo: history.past.length, redo: history.future.length });
    setChart(value);
    setDirty(true);
    setMarkers(new Map());
  };

  const runRepair = async (): Promise<void> => {
    if (!activeEdit || repairBusy) {
      return;
    }
    setRepairBusy(true);
    setRepairError(null);
    try {
      const res = await voiceRemix(chart, grid, REPAIR_COMMAND);
      historyRef.current = pushHistory(
        historyRef.current,
        structuredClone(chart),
      );
      setHistLen({ undo: historyRef.current.past.length, redo: 0 });
      setChart(res.chart);
      setReport(res.report);
      setRepairLog(res.diff_log);
      setMarkers(buildMarkers(res.chart, res.report));
      setDirty(true);
    } catch (e) {
      setRepairError(e instanceof Error ? e.message : String(e));
    } finally {
      setRepairBusy(false);
    }
  };

  const revertStock = (): void => {
    const stock = LIB[chartKey];
    if (stock === undefined) {
      return;
    }
    setChart(structuredClone(stock));
    setDirty(false);
    setMarkers(new Map());
    setRepairLog(null);
    setReport(null);
    historyRef.current = emptyHistory();
    setHistLen({ undo: 0, redo: 0 });
    try {
      localStorage.removeItem(editStorageKey(chartKey));
    } catch {
      // Storage unavailable: in-memory state is already clean.
    }
  };

  const exportPackFile = (): void => {
    const blob = new Blob([JSON.stringify(exportPack(chart, grid), null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${chart.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "chart"}.aria.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importPackFile = (file: File): void => {
    setImportError(null);
    file
      .text()
      .then((text) => {
        try {
          const parsed = importPack(JSON.parse(text) as unknown);
          historyRef.current = emptyHistory();
          setHistLen({ undo: 0, redo: 0 });
          setPlaying(false);
          setChartKey("imported");
          setChart(parsed.chart);
          setDirty(false);
          setEditing(false);
          setMarkers(new Map());
          setReport(null);
          setRepairLog(null);
          setShowResults(false);
          setSnap(null);
        } catch (e) {
          setImportError(e instanceof Error ? e.message : String(e));
        }
      })
      .catch((e: unknown) => {
        setImportError(e instanceof Error ? e.message : String(e));
      });
  };

  const handleSnapshot = (snap: EngineSnapshot): void => {
    setSnap(snap);
    if (snap.finished) {
      setShowResults(true);
    }
  };

  const mode: ChartMode = chart.mode;
  const switchMode = (m: ChartMode): void => {
    loadChart(m);
  };

  /* Global arcade keys: Space = PLAY/PAUSE, TAB = studio rack, E = rack
     when it cannot collide with a live pad key or an edit pad toggle. */
  const playStateRef = useRef({ playing, activeEdit, mode });
  playStateRef.current = { playing, activeEdit, mode };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Synthetic cam-pad replays (firePadHit) drive the engine, never chrome.
      if (!acceptsStudioKey(e) || isTypingTarget(e)) {
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        setDrawerOpen((v) => !v);
        return;
      }
      if (e.key === " ") {
        e.preventDefault();
        if (!e.repeat) {
          setPlaying((v) => !v);
        }
        return;
      }
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) {
        return;
      }
      // L is no pad key in either mode and no EDIT key — it always jumps
      // to the LOAD TRACK dropzone in the studio rack.
      if (e.key.toLowerCase() === "l") {
        e.preventDefault();
        setDrawerOpen(true);
        window.requestAnimationFrame(() => {
          document
            .querySelector<HTMLElement>("#load-track .dropzone")
            ?.focus();
        });
        return;
      }
      if (e.key.toLowerCase() === "e") {
        const s = playStateRef.current;
        // E is a live pad key during pump PLAY and the pad toggle in pump
        // EDIT — the game/engine owns it there, never the drawer.
        if (s.mode === "pump-5pad" && (s.playing || s.activeEdit)) {
          return;
        }
        e.preventDefault();
        setDrawerOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const drawerVisible = drawerOpen && !playing;

  return (
    <div
      className="arcade-viewport"
      data-playing={playing}
      data-editing={editing}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = [...e.dataTransfer.files].find((x) =>
          x.name.endsWith(".json"),
        );
        if (f !== undefined) {
          setEditing(false);
          importPackFile(f);
        }
      }}
    >
      {/* Reactive stage backdrop: Muse Image art (screen-blended over the
          highway) or a beat-pulsed fallback arena wash. */}
      <div className="arcade-stage" aria-hidden="true">
        {stageArt !== null ? (
          <div
            className="stage-backdrop"
            data-playing={playing}
            style={{ ["--beat" as string]: `${60 / chart.bpm}s` }}
            dangerouslySetInnerHTML={{ __html: stageArt.background_svg }}
          />
        ) : (
          <div
            className="stage-fallback"
            data-playing={playing}
            style={{ ["--beat" as string]: `${60 / chart.bpm}s` }}
          />
        )}
      </div>

      <HighwayCanvas
        key={runId}
        chart={chart}
        playing={playing}
        speed={speed}
        scrollDir={scrollDir}
        audioOn={audioOn}
        audioUrl={chartKey === "ingested" ? trackAudioUrl : null}
        engineRef={engineRef}
        onSnapshot={handleSnapshot}
        editing={editing}
        cursorMs={cursorMs}
        marks={markers}
        onLaneClick={toggleEditKey}
        onWheelScrub={scrub}
      />
      <div className="arcade-vignette" aria-hidden="true" />

      {/* Floating arcade HUD */}
      <ArcadeHudLeft snap={snap} playing={playing} />
      <ArcadeHudRight snap={snap} chart={chart} playing={playing} />
      <div className="hud-top-center">
        <div className="vocal-hud-bar">
          <VocalHighway
            chartTitle={chart.title}
            phrases={chart.vocal_phrases ?? []}
            playing={playing}
            getSongTimeMs={getSongTimeMs}
            pitchSource={pitchSource}
            onVocalStats={setVocalStats}
          />
          <div className="vocal-hud-sub">
            <div className="mini-switch" role="group" aria-label="Vocal pitch source">
              {(["sim", "mic", "off"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={vocalMode === m}
                  onClick={() => setVocalMode(m)}
                >
                  {m === "sim" ? "SIM" : m.toUpperCase()}
                </button>
              ))}
            </div>
            <span aria-live="polite">
              {vocalStats !== null &&
                `VOCAL ${vocalStats.accuracy.toFixed(0)}% · ${vocalStats.activeText ?? "—"}`}
              {micError !== null && ` · MIC ERROR: ${micError}`}
            </span>
          </div>
        </div>
      </div>

      {/* Bottom-left arcade picture-in-picture: SAM cam-pad tracker */}
      <div className="arcade-pip">
        <CamPadOverlay
          chartMode={mode}
          onOverdriveChange={(active) => {
            engineRef.current?.setOverdrive(active);
          }}
        />
      </div>

      {/* Bottom control deck */}
      <div className="arcade-deck" role="toolbar" aria-label="Arcade control deck">
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
          <button type="button" className="hw-btn lit deck-play" onClick={() => setPlaying(true)}>
            ▶ PLAY
          </button>
        ) : (
          <button type="button" className="hw-btn deck-play" onClick={() => setPlaying(false)}>
            ❚❚ PAUSE
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
        <button
          type="button"
          className="hw-btn"
          onClick={() => setShowResults((s) => !s)}
        >
          RESULTS
        </button>
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
          {ingested !== null && (
            <button
              type="button"
              aria-pressed={chartKey === "ingested"}
              onClick={loadIngested}
            >
              INGESTED
            </button>
          )}
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={audioOn}
            onChange={(e) => setAudioOn(e.target.checked)}
          />
          AUDIO
        </label>
        <div className="mode-switch" role="group" aria-label="Scroll direction">
          <button
            type="button"
            aria-pressed={scrollDir === "up"}
            onClick={() => setScrollDir("up")}
            title="UP-SCROLL: receptors at the top (StepMania / PIU classic)"
          >
            ↑ UP
          </button>
          <button
            type="button"
            aria-pressed={scrollDir === "down"}
            onClick={() => setScrollDir("down")}
            title="DOWN-SCROLL: receptors at the bottom (mania style)"
          >
            ↓ DOWN
          </button>
        </div>
        <label className="slider">
          {speed.toFixed(2)}x
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.05}
            value={speed}
            aria-label="Scroll speed"
            onChange={(e) => setSpeed(Number(e.target.value))}
          />
        </label>
      </div>

      {/* Studio rack drawer toggle rail */}
      <button
        type="button"
        className="drawer-tab"
        data-open={drawerVisible}
        onClick={() => {
          if (!playing) {
            setDrawerOpen((v) => !v);
          }
        }}
        title={playing ? "Pause to open the studio rack" : "Toggle studio rack [TAB]"}
      >
        {drawerVisible ? "RACK ▸" : "◂ RACK"}
      </button>

      {/* Slide-over hardware rack: studio panels live here, never over gameplay */}
      <aside
        className="rack-drawer"
        data-open={drawerVisible}
        aria-hidden={!drawerVisible}
        aria-label="Studio rack drawer"
      >
        <header className="rack-head">
          <span>STUDIO RACK</span>
          <span className="dim">[TAB]/[E]</span>
        </header>
        <div className="rack-scroll">
          <TrackIngestPanel onIngested={onIngested} />
          <ChartPanel
            chart={chart}
            grid={grid}
            report={report}
            validating={validating}
            error={error}
            onValidate={() => void runValidator()}
          />
          <ChartEditor
            editing={editing}
            active={activeEdit}
            chart={chart}
            grid={grid}
            cursorMs={cursorMs}
            markers={markers}
            report={report}
            validating={validating}
            validateError={error}
            repairBusy={repairBusy}
            repairError={repairError}
            repairLog={repairLog}
            dirty={dirty}
            canUndo={histLen.undo > 0}
            canRedo={histLen.redo > 0}
            canRevert={canRevert}
            importError={importError}
            onToggleEdit={toggleEdit}
            onScrub={scrub}
            onToggleKey={toggleEditKey}
            onMirror={() => activeEdit && commitEdit(mirrorChart(chart))}
            onHalve={() => activeEdit && commitEdit(halveDensity(chart))}
            onDouble={() => activeEdit && commitEdit(doubleDensity(chart))}
            onUndo={doUndo}
            onRedo={doRedo}
            onValidate={() => void runValidator()}
            onRepair={() => void runRepair()}
            onJumpToViolation={(t) => setCursorMs(nearestGridTime(t, grid))}
            onExport={exportPackFile}
            onImportFile={importPackFile}
            onRevert={revertStock}
          />
          <CriticInspector onChart={onGenerated} />
          <DirectorPanel
            chart={chart}
            grid={grid}
            onChart={onGenerated}
            onStageArt={setStageArt}
          />
        </div>
      </aside>

      {showResults && (
        <div className="results-overlay" role="dialog" aria-label="Run results">
          <ResultsPanel
            snap={snap}
            vocalAccuracy={vocalStats?.accuracy ?? null}
            mode={mode}
            onClose={() => setShowResults(false)}
            onReplay={replay}
          />
        </div>
      )}
    </div>
  );
}
