import { useEffect, useRef } from "react";
import { RhythmEngine, type EngineSnapshot } from "../engine/engine";
import {
  ChartRenderer,
  columnAtPoint,
  createRenderState,
  type NoteMark,
  type ScrollDirection,
} from "../engine/renderer";
import { ensureAtlas } from "../engine/spriteAtlas";
import { playDemoTrack, type DemoTrack } from "../engine/synth";
import { isManiaChart, PUMP_PADS, type Chart, type ManiaLane, type PumpPad } from "../types/chart";

interface HighwayCanvasProps {
  chart: Chart;
  playing: boolean;
  speed: number;
  /** 1-click UP/DOWN scroll direction (receptors top vs bottom). */
  scrollDir: ScrollDirection;
  audioOn: boolean;
  /** Object URL of an uploaded real-audio file (Stage 5). Null = demo synth. */
  audioUrl: string | null;
  engineRef: React.MutableRefObject<RhythmEngine | null>;
  onSnapshot: (snap: EngineSnapshot) => void;
  /** Stage 4 EDIT mode: static paused view at cursorMs, never the engine. */
  editing: boolean;
  cursorMs: number;
  marks: ReadonlyMap<number, NoteMark[]>;
  onLaneClick: (key: ManiaLane | PumpPad) => void;
  onWheelScrub: (dir: 1 | -1) => void;
}

/** Column index from a click x (CSS px) — linear inverse of columnX. */
export function columnAtX(clientX: number, rectWidth: number, cols: number): number {
  const i = Math.round((clientX * (cols + 1)) / rectWidth - 1);
  return Math.min(cols - 1, Math.max(0, i));
}

/**
 * Live fullscreen arcade highway. Owns the AudioContext + RhythmEngine +
 * demo synth so note positions and hit deltas share one audio clock (<5ms AV
 * sync). The synth routes through the engine master bus so the renderer's
 * FFT stage visualizer pulses with the audible mix. Telemetry is pushed to
 * the parent on a 100ms poll. EDIT mode paints a static paused frame (engine
 * untouched) with validator markers.
 */
/**
 * Adopt a static `/assets/atlas.png` + `.json` sheet when the cabinet
 * ships one (same UV key contract); otherwise the procedural bake
 * stands in. Runs once per mount, never blocks the first frame.
 */
export function useStaticAtlas(baseUrl = "/assets/atlas"): void {
  useEffect(() => {
    void ensureAtlas(baseUrl);
  }, [baseUrl]);
}

export function HighwayCanvas({
  chart,
  playing,
  speed,
  scrollDir,
  audioOn,
  audioUrl,
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
  // Live static-sheet support: adopts /assets/atlas.png + .json when the
  // cabinet ships them (one benign 404 probe otherwise), else the bake.
  useStaticAtlas();

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
    engine.setScrollDirection(scrollDir);
    engineRef.current = engine;
    let cancelled = false;
    let track: DemoTrack | null = null;
    const useBuffer = audioUrl !== null && audioOn;
    if (useBuffer) {
      // Stage 5: decode the real upload on the playback context and lock
      // the clock to the exact buffer offset. Synth stays off for uploads.
      void (async () => {
        try {
          const res = await fetch(audioUrl);
          const bytes = await res.arrayBuffer();
          const buf = await ctx.decodeAudioData(bytes);
          if (!cancelled) {
            engine.startWithBuffer(buf);
          }
        } catch {
          // Corrupt download or undecodable bytes: fall back to the synth
          // groove so the chart stays playable.
          if (!cancelled) {
            engine.start();
            track = playDemoTrack(
              ctx,
              chart.bpm,
              Math.max(1, Math.round(chart.duration_ms / ((60 / chart.bpm) * 4000))),
              engine.synthDest(),
              chart.vocal_phrases ?? [],
            );
          }
        }
      })();
    } else {
      engine.start();
      const bars = Math.max(1, Math.round(chart.duration_ms / ((60 / chart.bpm) * 4000)));
      track = audioOn
        ? playDemoTrack(ctx, chart.bpm, bars, engine.synthDest(), chart.vocal_phrases ?? [])
        : null;
    }
    const poll = window.setInterval(() => {
      snapRef.current(engine.snapshot());
    }, 100);
    const onResize = (): void => {
      engine.refit();
      engine.setScrollSpeed(speed);
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelled = true;
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
  }, [chart, playing, audioUrl]);

  useEffect(() => {
    engineRef.current?.setScrollSpeed(speed);
  }, [engineRef, speed]);

  useEffect(() => {
    engineRef.current?.setScrollDirection(scrollDir);
  }, [engineRef, scrollDir]);

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
    preview.scrollDir = scrollDir;
    preview.render(
      chart,
      editing ? cursorMs : chart.offset_ms,
      { ...createRenderState(), editMode: editing },
      editing ? marks : undefined,
    );
    if (editing) {
      const ctx2d = canvas.getContext("2d");
      if (ctx2d !== null) {
        const W = canvas.width;
        const H = canvas.height;
        ctx2d.save();
        // Amber edit frame + cursor readout, drawn over the highway.
        ctx2d.strokeStyle = "#ffb000";
        ctx2d.lineWidth = 4;
        ctx2d.setLineDash([14, 10]);
        ctx2d.strokeRect(4, 4, W - 8, H - 8);
        ctx2d.setLineDash([]);
        // Mid-highway pill: clear of the UP/DOWN receptor rails and the
        // top vocal-ribbon cabinet stack.
        const cssW = canvas.clientWidth > 0 ? canvas.clientWidth : W;
        const dpr = W / cssW;
        const label = `EDIT @ ${cursorMs}ms`;
        ctx2d.font = `bold ${Math.max(14, W / 40)}px ui-monospace, monospace`;
        ctx2d.textAlign = "center";
        const tw = ctx2d.measureText(label).width + 28 * dpr;
        const ly = 300 * dpr;
        ctx2d.fillStyle = "rgba(4,6,13,0.82)";
        ctx2d.fillRect(W / 2 - tw / 2, ly - 24 * dpr, tw, 32 * dpr);
        ctx2d.strokeStyle = "#ffb000";
        ctx2d.lineWidth = 2;
        ctx2d.strokeRect(W / 2 - tw / 2, ly - 24 * dpr, tw, 32 * dpr);
        ctx2d.fillStyle = "#ffb000";
        ctx2d.fillText(label, W / 2, ly);
        ctx2d.restore();
      }
    }
  }, [chart, playing, speed, scrollDir, editing, cursorMs, marks]);

  const cols = isManiaChart(chart) ? 4 : 5;

  return (
    <canvas
      ref={canvasRef}
      className="arcade-highway"
      width={1280}
      height={800}
      onClick={(e) => {
        if (!editing || playing) {
          return;
        }
        const rect = e.currentTarget.getBoundingClientRect();
        const col = columnAtPoint(
          e.clientX - rect.left,
          e.clientY - rect.top,
          rect.width,
          rect.height,
          cols,
        );
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
  );
}
