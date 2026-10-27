import { useEffect, useRef } from "react";
import type { VocalPhrase } from "../types/chart";
import { speakerColor } from "../types/chart";
import {
  foldedCentsError,
  scorePitchFrame,
  simulatedReading,
  type PitchReading,
} from "../engine/pitchDetector";

/** Where the live vocal pitch comes from. */
export type VocalPitchSource =
  | { kind: "mic"; getReading: () => PitchReading | null }
  | { kind: "sim" }
  | { kind: "off" };

export interface VocalStats {
  /** 0..100 over voiced, pitched frames this take. */
  accuracy: number;
  hitFrames: number;
  totalFrames: number;
  activeText: string | null;
}

interface VocalHighwayProps {
  chartTitle: string;
  phrases: VocalPhrase[];
  playing: boolean;
  /** Same AudioContext master clock as the pad canvas (exact sync). */
  getSongTimeMs: () => number;
  pitchSource: VocalPitchSource;
  onVocalStats?: (stats: VocalStats) => void;
}

const LEAD_MS = 4000;
const TRAIL_MS = 1000;
const NOW_X_RATIO = 0.24;
const SEMITONE_SPAN = 12;

/** Active pitched phrase at a song time (first match wins). */
export function activePhraseAt(
  phrases: VocalPhrase[],
  songMs: number,
): VocalPhrase | null {
  for (const p of phrases) {
    if (songMs >= p.start_ms && songMs < p.end_ms && p.midi_pitch !== 0) {
      return p;
    }
  }
  return null;
}

function tubeY(midi: number, center: number, h: number): number {
  const top = h * 0.16;
  const bottom = h * 0.78;
  const clamped = Math.min(center + SEMITONE_SPAN, Math.max(center - SEMITONE_SPAN, midi));
  const t = (center + SEMITONE_SPAN - clamped) / (2 * SEMITONE_SPAN);
  return top + t * (bottom - top);
}

function roundRect(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/**
 * Rock Band vocal ribbon docked above the pad highway. Reads song position
 * from the shared audio-clock getter every frame — no own clock, no drift.
 */
export function VocalHighway({
  chartTitle,
  phrases,
  playing,
  getSongTimeMs,
  pitchSource,
  onVocalStats,
}: VocalHighwayProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastChartRef = useRef<string | null>(null);
  const statsRef = useRef({ hits: 0, total: 0 });
  const trailRef = useRef<{ x: number; y: number; hit: boolean }[]>([]);
  const cbRef = useRef(onVocalStats);
  cbRef.current = onVocalStats;
  const srcRef = useRef(pitchSource);
  srcRef.current = pitchSource;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return undefined;
    }
    const g = canvas.getContext("2d");
    if (g === null) {
      return undefined;
    }
    let raf = 0;
    let lastReport = 0;
    if (lastChartRef.current !== chartTitle) {
      lastChartRef.current = chartTitle;
      statsRef.current = { hits: 0, total: 0 };
      trailRef.current = [];
    }

    const fit = (): void => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) {
        return;
      }
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit();

    const draw = (nowMs: number): void => {
      const W = canvas.clientWidth;
      const H = canvas.clientHeight;
      if (W === 0 || H === 0) {
        return;
      }
      const nowX = W * NOW_X_RATIO;
      const pxPerMs = (W * (1 - NOW_X_RATIO) - 24) / LEAD_MS;

      // Backdrop.
      g.fillStyle = "#0b0e14";
      g.fillRect(0, 0, W, H);
      g.fillStyle = "#111826";
      g.fillRect(0, H - 26, W, 26);

      // Pitch center: active phrase, else nearest visible, else E4.
      const active = activePhraseAt(phrases, nowMs);
      let center = 64;
      if (active !== null) {
        center = active.midi_pitch;
      } else {
        let best: VocalPhrase | null = null;
        let bestDist = Infinity;
        for (const p of phrases) {
          if (p.midi_pitch === 0) {
            continue;
          }
          const d = p.start_ms >= nowMs ? p.start_ms - nowMs : Infinity;
          if (d < bestDist) {
            bestDist = d;
            best = p;
          }
        }
        if (best !== null) {
          center = best.midi_pitch;
        }
      }

      // Pitch gridlines every octave step (C lines labeled).
      g.font = "9px ui-monospace, monospace";
      for (let m = center - SEMITONE_SPAN; m <= center + SEMITONE_SPAN; m += 1) {
        const y = tubeY(m, center, H);
        g.strokeStyle = m % 12 === 0 ? "#2a3648" : "#182030";
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(W, y);
        g.stroke();
        if (m % 12 === 0) {
          g.fillStyle = "#5b6b82";
          g.fillText(`C${Math.floor(m / 12) - 1}`, 4, y - 2);
        }
      }

      const xFor = (t: number): number => nowX + (t - nowMs) * pxPerMs;
      const lo = nowMs - TRAIL_MS;
      const hi = nowMs + LEAD_MS;

      // Phrase tubes + scrolling lyrics.
      g.font = "11px ui-monospace, monospace";
      for (const p of phrases) {
        if (p.end_ms < lo || p.start_ms > hi) {
          continue;
        }
        const x0 = Math.max(0, xFor(p.start_ms));
        const x1 = Math.min(W, xFor(p.end_ms));
        if (x1 - x0 < 2) {
          continue;
        }
        const color = speakerColor(p.speaker_id);
        if (p.midi_pitch === 0) {
          // Unpitched rap/talkie: thin dashed gray tube, unscored.
          const y = tubeY(center, center, H);
          g.strokeStyle = "#6b7280";
          g.lineWidth = 3;
          g.setLineDash([6, 4]);
          g.beginPath();
          g.moveTo(x0, y);
          g.lineTo(x1, y);
          g.stroke();
          g.setLineDash([]);
        } else {
          const y = tubeY(p.midi_pitch, center, H);
          const sung = p.end_ms <= nowMs;
          g.globalAlpha = sung ? 0.35 : 1;
          g.fillStyle = color;
          roundRect(g, x0, y - 11, x1 - x0, 22, 11);
          g.fill();
          if (p.speaker_id === "SPEAKER_01") {
            g.strokeStyle = "#ffd166";
            g.lineWidth = 1.5;
            roundRect(g, x0, y - 11, x1 - x0, 22, 11);
            g.stroke();
          }
          g.globalAlpha = 1;
          g.fillStyle = "#e8eef7";
          const label = p.text.length > 26 ? `${p.text.slice(0, 25)}…` : p.text;
          g.fillText(label, Math.min(x0 + 4, W - 90), y + 26);
        }
        g.fillStyle = "#8b98ad";
        g.fillText(p.speaker_id, Math.min(x0 + 4, W - 90), H - 9);
      }

      // Now line.
      g.strokeStyle = "#f2f5fa";
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(nowX, 0);
      g.lineTo(nowX, H - 26);
      g.stroke();

      // Live vocal comet needle.
      const src = srcRef.current;
      let reading: PitchReading | null = null;
      if (src.kind === "mic") {
        const raw = src.getReading();
        // Octave-folded scoring happens here against the active tube, so any
        // octave the singer chooses scores identically within ±150 cents.
        reading =
          raw !== null && raw.voiced && active !== null
            ? { ...raw, centsOff: foldedCentsError(raw.midiNote, active.midi_pitch) }
            : raw;
      } else if (src.kind === "sim" && active !== null) {
        reading = simulatedReading(active.midi_pitch, nowMs / 1000);
      }
      if (reading !== null && reading.voiced && active !== null) {
        const s = scorePitchFrame(
          reading.midiNote,
          active.midi_pitch,
          reading.clarity,
        );
        statsRef.current.total += 1;
        if (s.hit) {
          statsRef.current.hits += 1;
        }
        const y = tubeY(reading.midiNote, center, H);
        const cy = Math.min(H - 30, Math.max(4, y));
        trailRef.current.push({ x: nowX, y: cy, hit: s.hit });
        if (trailRef.current.length > 24) {
          trailRef.current.shift();
        }
        // Trail.
        for (let i = 0; i < trailRef.current.length; i += 1) {
          const t = trailRef.current[i];
          const a = (i + 1) / trailRef.current.length;
          g.globalAlpha = a * 0.5;
          g.fillStyle = t.hit ? "#4ade80" : "#f87171";
          g.beginPath();
          g.arc(t.x - (trailRef.current.length - i) * 2, t.y, 5 * a + 1, 0, Math.PI * 2);
          g.fill();
        }
        g.globalAlpha = 1;
        // Needle head.
        g.fillStyle = s.hit ? "#4ade80" : "#f87171";
        g.beginPath();
        g.arc(nowX, cy, 8, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = "#0b0e14";
        g.beginPath();
        g.arc(nowX, cy, 3.5, 0, Math.PI * 2);
        g.fill();
        // Cents readout.
        g.fillStyle = s.hit ? "#4ade80" : "#f87171";
        g.font = "10px ui-monospace, monospace";
        const sign = s.centsOff >= 0 ? "+" : "";
        g.fillText(`${sign}${Math.round(s.centsOff)}¢`, nowX + 12, cy - 8);
      } else {
        trailRef.current.length = 0;
      }

      // Vocal Phrase Accuracy meter (top-right).
      const { hits, total } = statsRef.current;
      const acc = total === 0 ? 100 : (hits / total) * 100;
      const label = `VOCAL ${acc.toFixed(0)}%`;
      g.font = "11px ui-monospace, monospace";
      const lw = g.measureText(label).width + 108;
      g.fillStyle = "#111826";
      roundRect(g, W - lw - 8, 6, lw, 20, 6);
      g.fill();
      g.fillStyle = "#8b98ad";
      g.fillText(label, W - lw - 4, 20);
      g.fillStyle = "#1e293b";
      g.fillRect(W - 104, 10, 92, 12);
      g.fillStyle = acc >= 80 ? "#4ade80" : acc >= 50 ? "#ffd166" : "#f87171";
      g.fillRect(W - 104, 10, (92 * acc) / 100, 12);

      // Throttled stats callback (~4Hz) for the side panel.
      if (nowMs - lastReport > 250) {
        lastReport = nowMs;
        cbRef.current?.({
          accuracy: acc,
          hitFrames: hits,
          totalFrames: total,
          activeText: active?.text ?? null,
        });
      }
    };

    if (!playing) {
      draw(getSongTimeMs());
      return undefined;
    }
    const tick = (): void => {
      draw(getSongTimeMs());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    window.addEventListener("resize", fit);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", fit);
    };
    // Rebind per take; hot refs carry pitch source + callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartTitle, phrases, playing]);

  return (
    <canvas
      ref={canvasRef}
      aria-label="Rock Band vocal highway"
      style={{ width: "100%", height: 148, display: "block" }}
    />
  );
}
