import { useEffect, useRef } from "react";
import { RhythmEngine, type EngineSnapshot } from "../engine/engine";
import { ChartRenderer, createRenderState } from "../engine/renderer";
import { playDemoTrack, type DemoTrack } from "../engine/synth";
import type { Chart } from "../types/chart";

interface HighwayCanvasProps {
  chart: Chart;
  playing: boolean;
  speed: number;
  audioOn: boolean;
  engineRef: React.MutableRefObject<RhythmEngine | null>;
  onSnapshot: (snap: EngineSnapshot) => void;
}

/**
 * Live Canvas highway. Owns the AudioContext + RhythmEngine + demo synth
 * so note positions and hit deltas share one audio clock (<5ms AV sync).
 * Telemetry is pushed to the parent on a 100ms poll.
 */
export function HighwayCanvas({
  chart,
  playing,
  speed,
  audioOn,
  engineRef,
  onSnapshot,
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

  // Idle preview: when not playing, paint one static frame for the loaded
  // chart so a chart/mode switch never leaves a stale frame behind.
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
    preview.render(chart, chart.offset_ms, createRenderState());
  }, [chart, playing, speed]);

  return (
    <div className="cab-screen">
      <div className="cab-screen-bezel">
        <canvas ref={canvasRef} className="highway" width={480} height={560} />
      </div>
      <div className="cab-screen-label">
        <span>{chart.title}</span>
        <span>
          {chart.mode} @ {chart.bpm} BPM
        </span>
      </div>
    </div>
  );
}
