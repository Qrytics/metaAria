/**
 * requestAnimationFrame Canvas renderer (target 60fps).
 *
 * Every note Y position derives from the caller-supplied `songTimeMs`
 * (which must come from `MasterClock.songTimeMs()`). The renderer never
 * reads `Date.now()` and never advances notes on `setInterval`.
 */
import type { Chart, ChartNote } from "../types/chart";
import { isManiaChart } from "../types/chart";
import type { Judgment } from "./judgments";
import { MANIA_LANE_COLORS, MANIA_LANE_LABELS, PUMP_RECEPTOR_POS, padColor } from "./input";

/** How far ahead notes become visible. */
export const APPROACH_MS = 2000;
/** Pixels per millisecond of scroll. */
const PX_PER_MS = 0.35;

export interface ReceptorFlash {
  /** Song-time ms of the last hit on this key. */
  timeMs: number;
  judgment: Judgment;
}

export interface HitPop {
  /** Index into chart.notes of the struck note. */
  noteIndex: number;
  /** Song-time ms of the hit (from MasterClock). */
  timeMs: number;
  judgment: Judgment;
}

export interface RenderOptions {
  /** Flash per lane index (mania) or pad (pump). */
  flashes: ReadonlyMap<number | string, ReceptorFlash>;
  /** Currently held-down lane/pad keys. */
  held: ReadonlySet<number | string>;
  /** Note indices currently in a hold (head hit, tail sounding). */
  activeHolds: ReadonlySet<number>;
  /** Recent hit marks, drawn at the struck note's position. */
  pops: ReadonlyArray<HitPop>;
}

const JUDGMENT_FLASH_COLORS: Record<Judgment, string> = {
  PERFECT: "#facc15",
  GREAT: "#4ade80",
  GOOD: "#38bdf8",
  MISS: "#ef4444",
};

function laneKey(note: ChartNote): number | string {
  return note.lane ?? note.pad ?? "?";
}

export class ChartRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** Scroll-speed multiplier (1 = nominal 0.35px/ms). Set by the studio UI. */
  public scrollSpeed = 1;
  /** Baked hardware-texture backdrop (gradient + scanlines), rebuilt on resize. */
  private backdrop: HTMLCanvasElement | null = null;
  private backdropW = 0;
  private backdropH = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      throw new Error("2d canvas context unavailable");
    }
    this.ctx = ctx;
  }

  fitToDisplay(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.backdrop = null;
  }

  /** Brushed-dark backdrop: vertical gradient + faint scanlines, baked once. */
  private paintBackdrop(W: number, H: number): HTMLCanvasElement {
    if (
      this.backdrop !== null &&
      this.backdropW === W &&
      this.backdropH === H
    ) {
      return this.backdrop;
    }
    const bg = document.createElement("canvas");
    bg.width = W;
    bg.height = H;
    const b = bg.getContext("2d");
    if (b !== null) {
      const grad = b.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, "#0d1322");
      grad.addColorStop(0.55, "#0b0e1a");
      grad.addColorStop(1, "#070a12");
      b.fillStyle = grad;
      b.fillRect(0, 0, W, H);
      b.fillStyle = "rgba(226,232,240,0.022)";
      for (let y = 0; y < H; y += 4) {
        b.fillRect(0, y, W, 1);
      }
    }
    this.backdrop = bg;
    this.backdropW = W;
    this.backdropH = H;
    return bg;
  }

  private columnCount(chart: Chart): number {
    return isManiaChart(chart) ? 4 : 5;
  }

  /** X center of a column across the canvas width. */
  columnX(chart: Chart, index: number): number {
    const n = this.columnCount(chart);
    return (this.canvas.width * (index + 1)) / (n + 1);
  }

  receptorY(): number {
    return this.canvas.height - 96;
  }

  render(chart: Chart, songTimeMs: number, opts: RenderOptions): void {
    const { ctx } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const receptorY = this.receptorY();
    const pxPerMs = PX_PER_MS * this.scrollSpeed;

    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(this.paintBackdrop(W, H), 0, 0);

    const n = this.columnCount(chart);
    for (let i = 0; i < n; i += 1) {
      const x = this.columnX(chart, i);
      // Alternate lane bands so columns read as hardware slots, not flat fill.
      if (i % 2 === 1) {
        const half = W / (n + 1) / 2;
        ctx.fillStyle = "rgba(148,163,184,0.05)";
        ctx.fillRect(x - half, 0, half * 2, H);
      }
      const isCenter = !isManiaChart(chart) && i === 2;
      ctx.strokeStyle = isCenter
        ? "rgba(167,139,250,0.55)"
        : "rgba(148,163,184,0.25)";
      ctx.lineWidth = isCenter ? 3 : 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }

    chart.notes.forEach((note, noteIndex) => {
      const dt = note.time_ms - songTimeMs;
      if (dt < -200 || dt > APPROACH_MS) {
        return;
      }
      const col = isManiaChart(chart)
        ? (note.lane ?? 0)
        : ["Q", "E", "S", "Z", "C"].indexOf(note.pad ?? "S");
      const x = this.columnX(chart, col);
      const y = receptorY - dt * pxPerMs;
      const color = isManiaChart(chart)
        ? MANIA_LANE_COLORS[note.lane ?? 0]
        : padColor(note.pad ?? "S");

      if ((note.kind === "hold" || note.kind === "slide") && note.duration_ms > 0) {
        const tailY = y - note.duration_ms * pxPerMs;
        const held = opts.activeHolds.has(noteIndex);
        ctx.fillStyle = held ? color : `${color}55`;
        const tailTop = Math.max(tailY, 0);
        ctx.fillRect(x - 9, tailTop, 18, y - tailTop);
      }

      ctx.beginPath();
      ctx.arc(x, y, 20, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#f8fafc";
      ctx.stroke();
    });

    // Receptors + flashes.
    for (let i = 0; i < n; i += 1) {
      const x = this.columnX(chart, i);
      let label: string;
      let baseColor: string;
      let mapKey: number | string;
      if (isManiaChart(chart)) {
        label = MANIA_LANE_LABELS[i];
        baseColor = MANIA_LANE_COLORS[i];
        mapKey = i;
      } else {
        const pad = (["Q", "E", "S", "Z", "C"] as const)[i];
        label = `${pad}·${PUMP_RECEPTOR_POS[pad]}`;
        baseColor = padColor(pad);
        mapKey = pad;
      }
      const flash = opts.flashes.get(mapKey);
      const ageMs = flash === undefined ? Number.POSITIVE_INFINITY : songTimeMs - flash.timeMs;
      const lit = ageMs < 180;
      // Receptor pop: radius punches out on hit, then settles.
      const radius = lit ? 26 + 10 * (1 - ageMs / 180) : 26;
      ctx.beginPath();
      ctx.arc(x, receptorY, radius, 0, Math.PI * 2);
      ctx.fillStyle = lit ? JUDGMENT_FLASH_COLORS[flash!.judgment] : "#11172e";
      ctx.fill();
      ctx.lineWidth = opts.held.has(mapKey) ? 5 : 3;
      ctx.strokeStyle = baseColor;
      ctx.stroke();
      if (lit) {
        ctx.beginPath();
        ctx.arc(x, receptorY, radius + 5, 0, Math.PI * 2);
        ctx.lineWidth = 2;
        ctx.strokeStyle = JUDGMENT_FLASH_COLORS[flash!.judgment];
        ctx.globalAlpha = 1 - ageMs / 180;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = "#e2e8f0";
      ctx.font = "12px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText(label, x, receptorY + 44);
    }

    // Hit marks AT the struck note's position (expanding judgment ring + word).
    for (const pop of opts.pops) {
      const age = songTimeMs - pop.timeMs;
      if (age < 0 || age > 450) {
        continue;
      }
      const note = chart.notes[pop.noteIndex];
      if (note === undefined) {
        continue;
      }
      const col = isManiaChart(chart)
        ? (note.lane ?? 0)
        : ["Q", "E", "S", "Z", "C"].indexOf(note.pad ?? "S");
      const x = this.columnX(chart, col);
      const struckY = receptorY - (note.time_ms - pop.timeMs) * pxPerMs;
      const y = Math.max(24, Math.min(receptorY + 8, struckY));
      const color = JUDGMENT_FLASH_COLORS[pop.judgment];
      const alpha = 1 - age / 450;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(x, y, 14 + age * 0.09, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.font = "bold 11px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillStyle = color;
      ctx.fillText(pop.judgment, x, y - 22);
      ctx.globalAlpha = 1;
    }
  }
}

/** Build the empty per-frame option maps the engine mutates in place. */
export function createRenderState(): {
  flashes: Map<number | string, ReceptorFlash>;
  held: Set<number | string>;
  activeHolds: Set<number>;
  pops: HitPop[];
} {
  return { flashes: new Map(), held: new Set(), activeHolds: new Set(), pops: [] };
}

export { laneKey };
