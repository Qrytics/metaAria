import { useEffect, useRef } from "react";
import { RhythmEngine, type EngineSnapshot } from "../engine/engine";
import { ChartRenderer, createRenderState, type NoteMark } from "../engine/renderer";
import { playDemoTrack, type DemoTrack } from "../engine/synth";
import { isManiaChart, PUMP_PADS, type Chart, type ManiaLane, type PumpPad } from "../types/chart";

interface HighwayCanvasProps {
  chart: Chart;
  playing: boolean;
  speed: number;
  audioOn: boolean;
  engineRef: React.MutableRefObject<RhythmEngine | null>;
  onSnapshot: (snap: EngineSnapshot) => void;
  /** Stage 4 EDIT mode: static paused view at cursorMs, never the engine. */
  editing: boolean;
  cursorMs: number;
  marks: ReadonlyMap<number, NoteMark[]>;
  onLaneClick: (key: ManiaLane | PumpPad) => void;
  onWheelScrub: (dir: 1 | -1) => void;
}

/** Column index from a click x (CSS px) — inverse of columnX. */
export function columnAtX(clientX: number, rectWidth: number, cols: number): number {
  const i = Math.round((clientX * (cols + 1)) / rectWidth - 1);
  return Math.min(cols - 1, Math.max(0, i));
}

/**
 * Live Canvas highway. Owns the AudioContext + RhythmEngine + demo synth
 * so note positions and hit deltas share one audio clock (<5ms AV sync).
 * Telemetry is pushed to the parent on a 100ms poll. EDIT mode paints a
 * static paused frame (engine untouched) with validator markers.
 */
export function HighwayCanvas({
  chart,
  playing,
  speed,
  audioOn,
  engineRef,
  onSnapshot,
  editing,
  cursorMs,
  marks,
  onLaneClick,
  onWheelScrub,
}: HighwayCanvasProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const snapRef = useRef(onSnapshot);
  snapRef.current = onSnapshot;

  useEffect(() => {
    if (!playing) {
      return undefined;
    }
    const canvas = canvasRef.current;
    if (canvas === null) {
      return undefined;
    }
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (Ctor === undefined) {
      return undefined;
    }
    const ctx = new Ctor();
    const engine = new RhythmEngine(canvas, ctx, chart);
    engine.setScrollSpeed(speed);
    engineRef.current = engine;
    engine.start();
    const bars = Math.max(1, Math.round(chart.duration_ms / ((60 / chart.bpm) * 4000)));
    const track: DemoTrack | null = audioOn
      ? playDemoTrack(ctx, chart.bpm, bars, undefined, chart.vocal_phrases ?? [])
      : null;
    const poll = window.setInterval(() => {
      snapRef.current(engine.snapshot());
    }, 100);
    const onResize = (): void => {
      engine.setScrollSpeed(speed);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.clearInterval(poll);
      window.removeEventListener("resize", onResize);
      track?.stop();
      engine.destroy();
      void ctx.close().catch(() => undefined);
      if (engineRef.current === engine) {
        engineRef.current = null;
      }
    };
    // Rebuild the take whenever chart/play state changes. Speed applies live
    // below without restarting the song.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, playing]);

  useEffect(() => {
    engineRef.current?.setScrollSpeed(speed);
  }, [engineRef, speed]);

  // Idle / EDIT preview: when not playing, paint one static frame for the
  // loaded chart so a chart/mode switch never leaves a stale frame behind.
  // EDIT mode centers the window on the step cursor and overlays validator
  // markers; the engine is never constructed here.
  useEffect(() => {
    if (playing) {
      return;
    }
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }
    const preview = new ChartRenderer(canvas);
    preview.fitToDisplay();
    preview.scrollSpeed = speed;
    preview.render(
      chart,
      editing ? cursorMs : chart.offset_ms,
      createRenderState(),
      editing ? marks : undefined,
    );
    if (editing) {
      const ctx = canvas.getContext("2d");
      if (ctx !== null) {
        const W = canvas.width;
        const H = canvas.height;
        ctx.save();
        ctx.strokeStyle = "#ffb000";
        ctx.lineWidth = 4;
        ctx.setLineDash([14, 10]);
        ctx.strokeRect(4, 4, W - 8, H - 8);
        ctx.setLineDash([]);
        ctx.fillStyle = "#ffb000";
        ctx.font = `bold ${Math.max(14, W / 28)}px ui-monospace, monospace`;
        ctx.textAlign = "left";
        ctx.fillText(`EDIT @ ${cursorMs}ms`, 14, 30);
        ctx.restore();
      }
    }
  }, [chart, playing, speed, editing, cursorMs, marks]);

  const cols = isManiaChart(chart) ? 4 : 5;

  return (
    <div className="cab-screen">
      <div className="cab-screen-bezel">
        <canvas
          ref={canvasRef}
          className="highway"
          width={480}
          height={560}
          onClick={(e) => {
            if (!editing || playing) {
              return;
            }
            const rect = e.currentTarget.getBoundingClientRect();
            const col = columnAtX(e.clientX - rect.left, rect.width, cols);
            if (isManiaChart(chart)) {
              onLaneClick(col as ManiaLane);
            } else {
              onLaneClick(PUMP_PADS[col] as PumpPad);
            }
          }}
          onWheel={(e) => {
            if (!editing || playing) {
              return;
            }
            onWheelScrub(e.deltaY > 0 ? 1 : -1);
          }}
          style={editing && !playing ? { cursor: "crosshair" } : undefined}
          aria-label={editing ? "Chart editor: click a lane to toggle a note" : "Note highway"}
        />
      </div>
      <div className="cab-screen-label">
        <span>{chart.title}</span>
        <span>
          {chart.mode} @ {chart.bpm} BPM{editing && !playing ? " · EDIT" : ""}
        </span>
      </div>
    </div>
  );
}
