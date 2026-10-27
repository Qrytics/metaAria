/**
 * requestAnimationFrame Canvas renderer (target 60fps) — arcade perspective edition.
 *
 * Every note Y position derives from the caller-supplied `songTimeMs`
 * (which must come from `MasterClock.songTimeMs()`). The renderer never
 * reads `Date.now()` and never advances notes on `setInterval`.
 *
 * Timing math is unchanged: APPROACH_MS visibility window, linear
 * receptor-anchored Y scroll. Perspective only warps the X coordinate and
 * note size (lanes converge toward a horizon), so hit timing is identical
 * to the flat build.
 */
import type { Chart, ChartNote } from "../types/chart";
import { isManiaChart } from "../types/chart";
import type { Judgment } from "./judgments";
import {
  MANIA_LANE_COLORS,
  MANIA_LANE_LABELS,
  PAD_FOOT,
  PUMP_RECEPTOR_POS,
  padColor,
} from "./input";
import type { PumpPad } from "../types/chart";

/** How far ahead notes become visible. */
export const APPROACH_MS = 2000;
/** Pixels per millisecond of scroll. */
const PX_PER_MS = 0.35;
/** Horizon line as a fraction of canvas height. */
const HORIZON_FRAC = 0.1;

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
  /** Live combo, for the center-highway callout. */
  combo: number;
  /** Studio EDIT preview: foot badges + denser guides. */
  editMode?: boolean;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  birth: number;
  color: string;
  size: number;
}

const JUDGMENT_FLASH_COLORS: Record<Judgment, string> = {
  PERFECT: "#facc15",
  GREAT: "#4ade80",
  GOOD: "#38bdf8",
  MISS: "#ef4444",
};

const JUDGMENT_CALLOUT: Record<Judgment, string> = {
  PERFECT: "PERFECT!!",
  GREAT: "GREAT!",
  GOOD: "GOOD",
  MISS: "MISS",
};

/** Pump arrow heading per pad (radians, 0 = pointing up). */
const PUMP_ARROW_ANGLE: Record<PumpPad, number> = {
  Q: -Math.PI * 0.75,
  E: -Math.PI * 0.25,
  S: 0,
  Z: Math.PI * 0.75,
  C: Math.PI * 0.25,
};

const PUMP_ORDER: readonly PumpPad[] = ["Q", "E", "S", "Z", "C"];

export function laneKey(note: ChartNote): number | string {
  return note.lane ?? note.pad ?? "?";
}

import type { NoteMark } from "./studio";

export type { NoteMark };

export function createRenderState(): {
  flashes: Map<number | string, ReceptorFlash>;
  held: Set<number | string>;
  activeHolds: Set<number>;
  pops: HitPop[];
  combo: number;
} {
  return {
    flashes: new Map(),
    held: new Set(),
    activeHolds: new Set(),
    pops: [],
    combo: 0,
  };
}

/**
 * Inverse of the perspective lane mapping, in CSS px: which column owns
 * point (clientX, clientY) inside a rect of (rectW, rectH). Used for EDIT
 * lane clicks so taps land on the visually tapped lane.
 */
export function columnAtPoint(
  clientX: number,
  clientY: number,
  rectW: number,
  rectH: number,
  cols: number,
): number {
  if (rectW <= 0 || rectH <= 0 || cols <= 0) {
    return 0;
  }
  const t = depthOf(clientY / rectH, rectH);
  const s = perspectiveScale(t);
  const laneF = 0.5 + (clientX / rectW - 0.5) / s;
  const i = Math.round(laneF * (cols + 1) - 1);
  return Math.min(cols - 1, Math.max(0, i));
}

/** Normalized depth 0 (horizon) .. 1 (receptor) for a height fraction. */
function depthOf(yFrac: number, hPx: number): number {
  const horizonF = HORIZON_FRAC;
  const receptorF = receptorFrac(hPx);
  const t = (yFrac - horizonF) / Math.max(1e-6, receptorF - horizonF);
  return Math.min(1, Math.max(0, t));
}

function receptorFrac(hPx: number): number {
  return 1 - Math.min(150, Math.max(64, hPx * 0.14)) / Math.max(1, hPx);
}

/** Lane convergence scale at depth t: 0.30 at the horizon, 1 at receptors. */
function perspectiveScale(t: number): number {
  const s = t * t * (3 - 2 * t);
  return 0.3 + 0.7 * s;
}

export class ChartRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** Scroll-speed multiplier (1 = nominal 0.35px/ms). Set by the studio UI. */
  public scrollSpeed = 1;
  /** Live FFT magnitudes (analyser byte data), or null for the idle wave. */
  public spectrum: Uint8Array | null = null;
  /** SAM Overdrive: gold/cyan border fire + stage tint. */
  public overdrive = false;
  /** Baked hardware-texture backdrop (gradient + scanlines), rebuilt on resize. */
  private backdrop: HTMLCanvasElement | null = null;
  private backdropW = 0;
  private backdropH = 0;
  private particles: Particle[] = [];
  private seenBursts = new Set<string>();

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

  /** Baked deep-arena backdrop: vertical gradient + faint scanlines. */
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
      grad.addColorStop(0, "#04060d");
      grad.addColorStop(0.45, "#0a1024");
      grad.addColorStop(0.75, "#0b0e1a");
      grad.addColorStop(1, "#05070c");
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

  /** X center of a column at the receptor line (unwarped). */
  columnX(chart: Chart, index: number): number {
    const n = this.columnCount(chart);
    return (this.canvas.width * (index + 1)) / (n + 1);
  }

  /** X center of a column at a given canvas Y (perspective-warped). */
  laneX(chart: Chart, index: number, y: number): number {
    const H = this.canvas.height;
    const rx = this.columnX(chart, index);
    const cx = this.canvas.width / 2;
    return cx + (rx - cx) * this.depthScale(y, H);
  }

  private depthScale(y: number, H: number): number {
    const hz = H * HORIZON_FRAC;
    const ry = this.receptorY();
    const t = Math.min(1, Math.max(0, (y - hz) / Math.max(1, ry - hz)));
    return perspectiveScale(t);
  }

  receptorY(): number {
    const H = this.canvas.height;
    return H - Math.min(150, Math.max(64, H * 0.14));
  }

  private horizonY(): number {
    return this.canvas.height * HORIZON_FRAC;
  }

  /** Spawn impact particles for a fresh hit mark (PERFECT/GREAT shower). */
  private burst(x: number, y: number, judgment: Judgment, now: number): void {
    const count =
      judgment === "PERFECT" ? 42 : judgment === "GREAT" ? 30 : judgment === "GOOD" ? 12 : 8;
    const color = JUDGMENT_FLASH_COLORS[judgment];
    for (let i = 0; i < count; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const speed = 60 + Math.random() * 420;
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed - 140,
        birth: now,
        color,
        size: 1.5 + Math.random() * 3.5,
      });
    }
    if (this.particles.length > 420) {
      this.particles.splice(0, this.particles.length - 420);
    }
  }

  private drawParticles(now: number): void {
    const { ctx } = this;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const alive: Particle[] = [];
    for (const p of this.particles) {
      const age = (now - p.birth) / 1000;
      if (age < 0 || age > 0.7) {
        continue;
      }
      alive.push(p);
      const fade = 1 - age / 0.7;
      ctx.globalAlpha = fade * 0.9;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x + p.vx * age, p.y + p.vy * age + 320 * age * age, p.size * fade + 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    this.particles = alive;
  }

  /** FFT spectrum bars glowing behind the highway (idle wave when null). */
  private drawSpectrum(W: number, H: number, now: number): void {
    const { ctx } = this;
    const bins = 40;
    const bw = W / bins;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < bins; i += 1) {
      let v: number;
      const spec = this.spectrum;
      if (spec !== null && spec.length > 0) {
        const src = spec[Math.floor((i / bins) * spec.length)] ?? 0;
        v = src / 255;
      } else {
        v = 0.1 + 0.07 * Math.sin(i * 0.7 + now / 320) + 0.04 * Math.sin(i * 1.7 - now / 210);
        v = Math.max(0.03, v);
      }
      const bh = Math.max(3, v * H * 0.52);
      const x = i * bw + bw * 0.18;
      const grad = ctx.createLinearGradient(0, H, 0, H - bh);
      if (this.overdrive) {
        grad.addColorStop(0, "rgba(250,204,21,0.05)");
        grad.addColorStop(1, "rgba(34,211,238,0.5)");
      } else {
        grad.addColorStop(0, "rgba(34,211,238,0.04)");
        grad.addColorStop(0.6, "rgba(99,102,241,0.28)");
        grad.addColorStop(1, "rgba(232,121,249,0.5)");
      }
      ctx.fillStyle = grad;
      ctx.fillRect(x, H - bh, bw * 0.64, bh);
    }
    ctx.restore();
  }

  /** Beat-synced horizon pulse: the far glow breathes on the BPM. */
  private drawHorizon(W: number, H: number, now: number, bpm: number): void {
    const { ctx } = this;
    const beatMs = 60000 / Math.max(1, bpm);
    const phase = (now % beatMs) / beatMs;
    const pulse = Math.pow(1 - phase, 2);
    const y = this.horizonY();
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.25 + 0.65 * pulse;
    ctx.strokeStyle = this.overdrive ? "#fbbf24" : "#22d3ee";
    ctx.lineWidth = 2 + 4 * pulse;
    ctx.shadowColor = this.overdrive ? "#f59e0b" : "#22d3ee";
    ctx.shadowBlur = 18 + 26 * pulse;
    ctx.beginPath();
    ctx.moveTo(W * 0.18, y);
    ctx.lineTo(W * 0.82, y);
    ctx.stroke();
    // Horizon sun glow.
    const glow = ctx.createRadialGradient(W / 2, y, 0, W / 2, y, W * 0.3);
    glow.addColorStop(0, this.overdrive ? "rgba(251,191,36,0.35)" : "rgba(34,211,238,0.30)");
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = 0.5 + 0.5 * pulse;
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  /** Pump pad arrowhead path pointing up, scaled by s, caller rotates. */
  private tracePumpArrow(s: number): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(0, -s);
    ctx.lineTo(s * 0.92, s * 0.62);
    ctx.lineTo(s * 0.36, s * 0.62);
    ctx.lineTo(s * 0.36, s);
    ctx.lineTo(-s * 0.36, s);
    ctx.lineTo(-s * 0.36, s * 0.62);
    ctx.lineTo(-s * 0.92, s * 0.62);
    ctx.closePath();
  }

  /** Center diamond (S pad) path, scaled by s. */
  private traceDiamond(s: number): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(0, -s);
    ctx.lineTo(s * 0.85, 0);
    ctx.lineTo(0, s);
    ctx.lineTo(-s * 0.85, 0);
    ctx.closePath();
  }

  /** Glowing pump note: directional arrow, or the gold center diamond. */
  private drawPumpNote(
    pad: PumpPad,
    x: number,
    y: number,
    s: number,
    held: boolean,
    now: number,
  ): void {
    const { ctx } = this;
    const color = padColor(pad);
    const size = (held ? 30 : 26) * s + (held ? 2 * Math.sin(now / 90) : 0);
    ctx.save();
    ctx.translate(x, y);
    ctx.shadowColor = color;
    ctx.shadowBlur = held ? 26 : 16;
    if (pad === "S") {
      this.traceDiamond(size);
    } else {
      ctx.rotate(PUMP_ARROW_ANGLE[pad]);
      this.tracePumpArrow(size);
    }
    const grad = ctx.createLinearGradient(0, -size, 0, size);
    grad.addColorStop(0, "#ffffff");
    grad.addColorStop(0.35, color);
    grad.addColorStop(1, "#0b0e1a");
    ctx.fillStyle = grad;
    ctx.globalAlpha = 0.95;
    ctx.fill();
    ctx.shadowBlur = 0;
    // Crisp inner bevel: bright core + dark rim.
    ctx.lineWidth = Math.max(1.5, 2.5 * s);
    ctx.strokeStyle = "rgba(248,250,252,0.85)";
    ctx.stroke();
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.beginPath();
    ctx.arc(0, -size * 0.18, Math.max(1, size * 0.16), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.restore();
  }

  /** Mania note: beveled synth-key bar with a glowing core line. */
  private drawManiaNote(
    lane: number,
    x: number,
    y: number,
    s: number,
    laneW: number,
    held: boolean,
    now: number,
  ): void {
    const { ctx } = this;
    const color = MANIA_LANE_COLORS[lane] ?? "#22d3ee";
    const w = laneW * 0.66 * s;
    const h = (held ? 30 : 24) * s + 6 + (held ? 2 * Math.sin(now / 90) : 0);
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = held ? 26 : 15;
    const grad = ctx.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
    grad.addColorStop(0, "#0b0e1a");
    grad.addColorStop(0.5, color);
    grad.addColorStop(1, "#0b0e1a");
    ctx.fillStyle = grad;
    ctx.globalAlpha = 0.95;
    ctx.fillRect(x - w / 2, y - h / 2, w, h);
    ctx.shadowBlur = 0;
    ctx.lineWidth = Math.max(1.5, 2 * s);
    ctx.strokeStyle = "rgba(248,250,252,0.9)";
    ctx.strokeRect(x - w / 2, y - h / 2, w, h);
    // Glowing core line across the key.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fillRect(x - w / 2 + 2, y - Math.max(1, 1.6 * s), w - 4, Math.max(2, 3.2 * s));
    ctx.restore();
    ctx.restore();
  }

  /** Hold ribbon head->tail: energy beam that pulses while actively held. */
  private drawHoldRibbon(
    xHead: number,
    yHead: number,
    xTail: number,
    yTail: number,
    color: string,
    active: boolean,
    now: number,
  ): void {
    const { ctx } = this;
    const wHead = active ? 20 : 13;
    const wTail = active ? 15 : 9;
    const pulse = active ? 0.75 + 0.25 * Math.sin(now / 110) : 0.5;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = pulse;
    ctx.shadowColor = color;
    ctx.shadowBlur = active ? 22 : 10;
    const grad = ctx.createLinearGradient(xHead, yHead, xTail, yTail);
    grad.addColorStop(0, color);
    grad.addColorStop(1, "rgba(11,14,26,0.1)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(xHead - wHead / 2, yHead);
    ctx.lineTo(xHead + wHead / 2, yHead);
    ctx.lineTo(xTail + wTail / 2, yTail);
    ctx.lineTo(xTail - wTail / 2, yTail);
    ctx.closePath();
    ctx.fill();
    // Bright core thread down the ribbon center.
    ctx.globalAlpha = Math.min(1, pulse + 0.35);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = active ? 3 : 1.5;
    ctx.beginPath();
    ctx.moveTo(xHead, yHead);
    ctx.lineTo(xTail, yTail);
    ctx.stroke();
    ctx.restore();
  }

  /** Receptor beam flash: vertical light pillar while the key is held. */
  private drawReceptorBeam(x: number, receptorY: number, color: string, strength: number): void {
    const { ctx } = this;
    const beamH = Math.min(320, this.canvas.height * 0.32) * strength;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const grad = ctx.createLinearGradient(0, receptorY, 0, receptorY - beamH);
    grad.addColorStop(0, color);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = 0.4 * strength;
    ctx.fillStyle = grad;
    ctx.fillRect(x - 13 * strength, receptorY - beamH, 26 * strength, beamH);
    ctx.restore();
  }

  /** Big kinetic center-highway judgment callout with scale-pop. */
  private drawCallout(now: number, newest: HitPop | undefined, combo: number): void {
    if (newest === undefined) {
      return;
    }
    const age = now - newest.timeMs;
    if (age < 0 || age > 520) {
      return;
    }
    const { ctx } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const color = JUDGMENT_FLASH_COLORS[newest.judgment];
    const pop = 1 + 0.65 * Math.exp(-age / 90);
    const alpha = age > 380 ? 1 - (age - 380) / 140 : 1;
    const cx = W / 2;
    const cy = H * 0.4;
    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.translate(cx, cy);
    ctx.scale(pop, pop);
    ctx.rotate(-0.03);
    ctx.textAlign = "center";
    ctx.shadowColor = color;
    ctx.shadowBlur = 28;
    ctx.font = `900 ${Math.max(20, W * 0.042)}px "Arial Black", "Segoe UI", sans-serif`;
    ctx.lineWidth = Math.max(3, W * 0.004);
    ctx.strokeStyle = newest.judgment === "MISS" ? "#7f1d1d" : color;
    const word = JUDGMENT_CALLOUT[newest.judgment];
    ctx.strokeText(word, 0, 0);
    ctx.fillStyle = color;
    ctx.fillText(word, 0, 0);
    ctx.shadowBlur = 0;
    if (combo >= 2 && newest.judgment !== "MISS") {
      ctx.font = `900 ${Math.max(16, W * 0.03)}px "Arial Black", "Segoe UI", sans-serif`;
      ctx.fillStyle = "#fbbf24";
      ctx.strokeStyle = "#0b0e1a";
      ctx.lineWidth = 4;
      const label = `${combo} COMBO`;
      ctx.strokeText(label, 0, Math.max(24, W * 0.035));
      ctx.fillText(label, 0, Math.max(24, W * 0.035));
    }
    ctx.restore();
  }

  /** Overdrive border fire: gold/cyan flames licking the highway edges. */
  private drawOverdriveBorders(W: number, H: number, now: number): void {
    const { ctx } = this;
    const flicker = 0.55 + 0.25 * Math.sin(now / 47) + 0.12 * Math.sin(now / 23);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const edges: Array<[number, number, number, number, string]> = [
      [0, 0, 10, H, "#f59e0b"],
      [W - 10, 0, 10, H, "#22d3ee"],
      [0, 0, W, 8, "#fbbf24"],
    ];
    for (const [x, y, w, h, color] of edges) {
      const grad =
        w < h
          ? ctx.createLinearGradient(x, 0, x + w, 0)
          : ctx.createLinearGradient(0, y, 0, y + h);
      grad.addColorStop(0, "rgba(0,0,0,0)");
      grad.addColorStop(0.5, color);
      grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.globalAlpha = flicker;
      ctx.shadowColor = color;
      ctx.shadowBlur = 24;
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, w, h);
    }
    ctx.restore();
  }

  /**
   * Render one frame. `marks` is EDIT-mode only: validator violations pinned
   * to note indices, drawn as high-contrast square brackets + tag. The PLAY
   * path never passes marks, so its pixels are byte-identical to before.
   */
  render(
    chart: Chart,
    songTimeMs: number,
    opts: RenderOptions,
    marks?: ReadonlyMap<number, NoteMark[]>,
  ): void {
    const { ctx } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const receptorY = this.receptorY();
    const horizonY = this.horizonY();
    const pxPerMs = PX_PER_MS * this.scrollSpeed;
    const mania = isManiaChart(chart);
    const n = this.columnCount(chart);
    const laneW = W / (n + 1);

    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(this.paintBackdrop(W, H), 0, 0);
    this.drawSpectrum(W, H, songTimeMs);
    this.drawHorizon(W, H, songTimeMs, chart.bpm);

    // Perspective trapezoid: alternating lane bands + glowing dividers.
    for (let i = 0; i < n; i += 1) {
      const xr = this.columnX(chart, i);
      const cx = W / 2;
      const xTop = cx + (xr - cx) * perspectiveScale(0);
      const xBot = cx + (xr - cx) * 1;
      const halfTop = (laneW / 2) * perspectiveScale(0);
      const halfBot = laneW / 2;
      if (i % 2 === 1) {
        ctx.fillStyle = "rgba(148,163,184,0.055)";
        ctx.beginPath();
        ctx.moveTo(xTop - halfTop, horizonY);
        ctx.lineTo(xTop + halfTop, horizonY);
        ctx.lineTo(xBot + halfBot, receptorY);
        ctx.lineTo(xBot - halfBot, receptorY);
        ctx.closePath();
        ctx.fill();
      }
      const isCenter = !mania && i === 2;
      ctx.save();
      ctx.strokeStyle = isCenter
        ? "rgba(167,139,250,0.7)"
        : this.overdrive
          ? "rgba(251,191,36,0.6)"
          : "rgba(34,211,238,0.4)";
      ctx.lineWidth = isCenter ? 3 : 2;
      ctx.shadowColor = isCenter ? "#a78bfa" : this.overdrive ? "#f59e0b" : "#22d3ee";
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(xTop, horizonY);
      ctx.lineTo(xBot, receptorY + (H - receptorY) * 0.6);
      ctx.stroke();
      ctx.restore();
    }

    const colOf = (note: ChartNote): number =>
      mania ? (note.lane ?? 0) : PUMP_ORDER.indexOf(note.pad ?? "S");
    const colorOf = (note: ChartNote): string =>
      mania ? (MANIA_LANE_COLORS[note.lane ?? 0] ?? "#22d3ee") : padColor(note.pad ?? "S");

    // Hold ribbons first (under the note heads).
    for (let noteIndex = 0; noteIndex < chart.notes.length; noteIndex += 1) {
      const note = chart.notes[noteIndex];
      if (note === undefined || note.duration_ms <= 0) {
        continue;
      }
      const dt = note.time_ms - songTimeMs;
      if (dt < -400 || dt > APPROACH_MS) {
        continue;
      }
      const col = colOf(note);
      const yHead = receptorY - dt * pxPerMs;
      const yTail = yHead - note.duration_ms * pxPerMs;
      const yHeadC = Math.min(receptorY + 30, Math.max(horizonY - 40, yHead));
      const yTailC = Math.min(receptorY + 30, Math.max(horizonY - 40, yTail));
      this.drawHoldRibbon(
        this.laneX(chart, col, yHeadC),
        yHeadC,
        this.laneX(chart, col, yTailC),
        yTailC,
        colorOf(note),
        opts.activeHolds.has(noteIndex),
        songTimeMs,
      );
    }

    // Notes.
    for (let noteIndex = 0; noteIndex < chart.notes.length; noteIndex += 1) {
      const note = chart.notes[noteIndex];
      if (note === undefined) {
        continue;
      }
      const dt = note.time_ms - songTimeMs;
      if (dt < -200 || dt > APPROACH_MS) {
        continue;
      }
      const col = colOf(note);
      const y = receptorY - dt * pxPerMs;
      const s = this.depthScale(y, H);
      const x = this.laneX(chart, col, y);
      ctx.save();
      ctx.globalAlpha = Math.min(1, Math.max(0.25, (y - horizonY) / Math.max(1, (receptorY - horizonY) * 0.4)));
      const headHeld = opts.activeHolds.has(noteIndex);
      if (mania) {
        this.drawManiaNote(note.lane ?? 0, x, y, s, laneW, headHeld, songTimeMs);
      } else {
        this.drawPumpNote(note.pad ?? "S", x, y, s, headHeld, songTimeMs);
      }
      ctx.restore();

      // Studio EDIT foot-parity badges on pump notes.
      if (opts.editMode === true && !mania) {
        const foot = PAD_FOOT[note.pad ?? "S"];
        const tag = foot === "C" ? "L/R" : foot;
        ctx.save();
        ctx.font = `700 ${Math.max(9, 11 * s)}px ui-monospace, monospace`;
        ctx.textAlign = "center";
        const tw = ctx.measureText(tag).width + 8;
        ctx.fillStyle = foot === "L" ? "rgba(34,211,238,0.9)" : foot === "R" ? "rgba(251,146,60,0.9)" : "rgba(167,139,250,0.9)";
        ctx.fillRect(x - tw / 2, y - 34 * s - 14, tw, 14);
        ctx.fillStyle = "#0b0e1a";
        ctx.fillText(tag, x, y - 34 * s - 3);
        ctx.restore();
      }

      const mark = marks?.get(noteIndex);
      if (mark !== undefined && mark.length > 0) {
        const sev = mark.some((m) => m.severity === "error") ? "#ef4444" : "#ffb000";
        ctx.save();
        ctx.strokeStyle = sev;
        ctx.lineWidth = 3;
        ctx.shadowColor = sev;
        ctx.shadowBlur = 10;
        const r = 30 * s + 8;
        const arm = 10;
        ctx.beginPath();
        ctx.moveTo(x - r + arm, y - r);
        ctx.lineTo(x - r, y - r);
        ctx.lineTo(x - r, y + r);
        ctx.lineTo(x - r + arm, y + r);
        ctx.moveTo(x + r - arm, y - r);
        ctx.lineTo(x + r, y - r);
        ctx.lineTo(x + r, y + r);
        ctx.lineTo(x + r - arm, y + r);
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.fillStyle = sev;
        ctx.font = "bold 10px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.fillText(mark[0]!.text.slice(0, 28), x, y - r - 8);
        ctx.restore();
      }
    }

    // Receptors + flashes + hold beams.
    for (let i = 0; i < n; i += 1) {
      const x = this.columnX(chart, i);
      let mapKey: number | string;
      let baseColor: string;
      let label: string;
      if (mania) {
        mapKey = i;
        baseColor = MANIA_LANE_COLORS[i] ?? "#22d3ee";
        label = MANIA_LANE_LABELS[i] ?? "";
      } else {
        const pad = PUMP_ORDER[i] ?? "S";
        mapKey = pad;
        baseColor = padColor(pad);
        label = `${pad}·${PUMP_RECEPTOR_POS[pad]}`;
      }
      const flash = opts.flashes.get(mapKey);
      const ageMs = flash === undefined ? Number.POSITIVE_INFINITY : songTimeMs - flash.timeMs;
      const lit = ageMs < 180;
      const heldDown = opts.held.has(mapKey);
      const size = (lit ? 34 + 12 * (1 - ageMs / 180) : 30) * 1;

      ctx.save();
      ctx.translate(x, receptorY);
      if (lit && flash !== undefined) {
        ctx.shadowColor = JUDGMENT_FLASH_COLORS[flash.judgment];
        ctx.shadowBlur = 30;
      } else {
        ctx.shadowColor = baseColor;
        ctx.shadowBlur = heldDown ? 26 : 12;
      }
      if (mania) {
        const w = laneW * 0.72;
        const h = 34;
        ctx.fillStyle = lit && flash !== undefined ? JUDGMENT_FLASH_COLORS[flash.judgment] : heldDown ? baseColor : "#101728";
        ctx.globalAlpha = lit || heldDown ? 0.95 : 0.85;
        ctx.fillRect(-w / 2, -h / 2, w, h);
        ctx.shadowBlur = 0;
        ctx.lineWidth = heldDown ? 4 : 2.5;
        ctx.strokeStyle = baseColor;
        ctx.strokeRect(-w / 2, -h / 2, w, h);
      } else {
        const pad = PUMP_ORDER[i] ?? "S";
        if (pad === "S") {
          this.traceDiamond(size);
        } else {
          ctx.rotate(PUMP_ARROW_ANGLE[pad]);
          this.tracePumpArrow(size);
        }
        ctx.fillStyle = lit && flash !== undefined ? JUDGMENT_FLASH_COLORS[flash.judgment] : heldDown ? baseColor : "#101728";
        ctx.globalAlpha = lit || heldDown ? 0.95 : 0.85;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.lineWidth = heldDown ? 5 : 3;
        ctx.strokeStyle = baseColor;
        ctx.stroke();
      }
      ctx.restore();

      if (heldDown) {
        this.drawReceptorBeam(x, receptorY, baseColor, 1);
      }
      if (lit && flash !== undefined) {
        ctx.save();
        ctx.globalAlpha = 1 - ageMs / 180;
        ctx.strokeStyle = JUDGMENT_FLASH_COLORS[flash.judgment];
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, receptorY, size + 8, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      ctx.save();
      ctx.fillStyle = "#e2e8f0";
      ctx.font = "11px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText(label, x, receptorY + 40);
      ctx.restore();
    }

    // Spawn impact bursts for fresh hit marks, then draw everything.
    const liveKeys = new Set<string>();
    for (const pop of opts.pops) {
      const key = `${pop.noteIndex}:${pop.timeMs}`;
      liveKeys.add(key);
      if (!this.seenBursts.has(key) && (pop.judgment === "PERFECT" || pop.judgment === "GREAT")) {
        const note = chart.notes[pop.noteIndex];
        if (note !== undefined) {
          const col = colOf(note);
          this.burst(this.columnX(chart, col), receptorY, pop.judgment, pop.timeMs);
        }
      }
      // Hit marks AT the struck note's position (expanding judgment ring).
      const age = songTimeMs - pop.timeMs;
      if (age < 0 || age > 450) {
        continue;
      }
      const note = chart.notes[pop.noteIndex];
      if (note === undefined) {
        continue;
      }
      const col = colOf(note);
      const x = this.laneX(chart, col, receptorY);
      const y = Math.max(24, Math.min(receptorY + 8, receptorY));
      const color = JUDGMENT_FLASH_COLORS[pop.judgment];
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 1 - age / 450;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.shadowColor = color;
      ctx.shadowBlur = 16;
      ctx.beginPath();
      ctx.arc(x, y, 16 + age * 0.12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    this.seenBursts = liveKeys;

    this.drawParticles(songTimeMs);

    const newest = opts.pops.length > 0 ? opts.pops[opts.pops.length - 1] : undefined;
    this.drawCallout(songTimeMs, newest, opts.combo);

    if (this.overdrive) {
      this.drawOverdriveBorders(W, H, songTimeMs);
    }
  }
}
