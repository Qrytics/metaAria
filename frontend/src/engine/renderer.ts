/**
 * Flat 2D arcade scrolling-lane renderer (StepMania / OpenITG / PIU style).
 *
 * Zero perspective distortion: every lane is a crisp vertical 2D column.
 * Every note and hold-body Y position is a hard deterministic function of
 * the audio clock — never incremental velocity:
 *
 *   y = receptorY + scrollSign * (noteTimeMs - currentAudioMs) * pxPerMs
 *
 * UP-SCROLL (StepMania/DDR/PIU classic): receptors at the top, arrows
 * scroll UP into them. DOWN-SCROLL (mania style): receptors at the
 * bottom, arrows scroll DOWN into them.
 *
 * Gameplay pixels come from the pre-baked sprite atlas (`spriteAtlas.ts`)
 * via single drawImage blits. Micro-animation (receptor stomp, popup
 * scale-pop, hold glow) is driven by the closed-form spring in
 * `spring.ts` — no CSS transitions, no bezier curves anywhere.
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
import { holdGlow, popScale, receptorScale } from "./spring";
import {
  GLYPH_LABEL,
  beatQuant,
  blit,
  getAtlas,
  holdBodyKey,
  holdTailKey,
  noteKey,
  receptorKey,
  sparkKey,
  type AtlasGlyph,
  type BeatQuant,
  type ReceptorState,
  type SpriteAtlas,
} from "./spriteAtlas";

export type ScrollDirection = "up" | "down";

/** How far ahead notes become visible. */
export const APPROACH_MS = 2000;
/** Base pixels per millisecond of scroll (× scrollSpeed). */
export const PX_PER_MS = 0.35;

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
  /** Song-time ms of the last keydown per lane/pad (receptor stomp). */
  pressedAt: ReadonlyMap<number | string, number>;
  /** Note indices currently in a hold (head hit, tail sounding). */
  activeHolds: ReadonlySet<number>;
  /** Recent hit marks, drawn as explosion sprites. */
  pops: ReadonlyArray<HitPop>;
  /** Live combo, for the center-highway callout. */
  combo: number;
  /** Studio EDIT preview: foot badges + denser guides. */
  editMode?: boolean;
}

const JUDGMENT_CALLOUT: Record<Judgment, string> = {
  PERFECT: "PERFECT!!",
  GREAT: "GREAT!",
  GOOD: "GOOD",
  MISS: "MISS",
};

const JUDGMENT_FLASH_COLORS: Record<Judgment, string> = {
  PERFECT: "#ff2a54",
  GREAT: "#00f59b",
  GOOD: "#00d2ff",
  MISS: "#ef4444",
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
  pressedAt: Map<number | string, number>;
  activeHolds: Set<number>;
  pops: HitPop[];
  combo: number;
} {
  return {
    flashes: new Map(),
    held: new Set(),
    pressedAt: new Map(),
    activeHolds: new Set(),
    pops: [],
    combo: 0,
  };
}

/** Centered flat-highway geometry for a canvas W px wide with n columns. */
export interface HighwayLayout {
  /** Left edge of the lane backing. */
  x0: number;
  /** Column width (all columns equal — zero perspective). */
  laneW: number;
  /** Right edge of the lane backing. */
  x1: number;
  /** X center of the highway. */
  cx: number;
}

export function highwayLayout(W: number, cols: number): HighwayLayout {
  const laneW = Math.min(W * 0.62, 560) / Math.max(1, cols);
  const totalW = laneW * Math.max(1, cols);
  const x0 = (W - totalW) / 2;
  return { x0, laneW, x1: x0 + totalW, cx: W / 2 };
}

/**
 * Flat inverse lane mapping: which column owns point (clientX, clientY)
 * inside a rect of (rectW, rectH). Y is irrelevant on a flat highway —
 * kept in the signature for EDIT call-site compatibility.
 */
export function columnAtPoint(
  clientX: number,
  _clientY: number,
  rectW: number,
  _rectH: number,
  cols: number,
): number {
  if (rectW <= 0 || cols <= 0) {
    return 0;
  }
  const { x0, laneW } = highwayLayout(rectW, cols);
  const i = Math.floor((clientX - x0) / Math.max(1, laneW));
  return Math.min(cols - 1, Math.max(0, i));
}

function glyphOf(chart: Chart, col: number): AtlasGlyph {
  if (isManiaChart(chart)) {
    return `M${col}` as AtlasGlyph;
  }
  if (col === 0) {
    return "Q";
  }
  if (col === 1) {
    return "E";
  }
  if (col === 2) {
    return "S";
  }
  if (col === 3) {
    return "Z";
  }
  return "C";
}

function quantOf(chart: Chart, note: ChartNote): BeatQuant {
  return beatQuant(chart.bpm, chart.offset_ms, note.time_ms);
}

export class ChartRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** Scroll-speed multiplier (1 = nominal 0.35px/ms). Set by the studio UI. */
  public scrollSpeed = 1;
  /** UP-SCROLL (receptors top) or DOWN-SCROLL (receptors bottom). */
  public scrollDir: ScrollDirection = "up";
  /** Live FFT magnitudes (analyser byte data), or null for the idle wave. */
  public spectrum: Uint8Array | null = null;
  /** SAM Overdrive: gold/cyan border fire + stage tint. */
  public overdrive = false;
  /** Baked obsidian backdrop (gradient + scanlines), rebuilt on resize. */
  private backdrop: HTMLCanvasElement | null = null;
  private backdropW = 0;
  private backdropH = 0;
  /** Display density from the last fitToDisplay (device px per CSS px). */
  private dpr = 1;

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
    this.dpr = dpr;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    // A zero-height rect (hidden canvas) still needs a paintable backing.
    const h = Math.max(1, Math.round((rect.height || 480) * dpr));
    this.canvas.width = w;
    this.canvas.height = h;
    this.backdrop = null;
  }

  /** Baked obsidian backdrop: near-black gradient + faint scanlines. */
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
      grad.addColorStop(0.5, "#07090e");
      grad.addColorStop(1, "#04060d");
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

  private layout(chart: Chart): HighwayLayout {
    return highwayLayout(this.canvas.width, this.columnCount(chart));
  }

  /** X center of a flat 2D column (identical at every Y). */
  columnX(chart: Chart, index: number): number {
    const { x0, laneW } = this.layout(chart);
    return x0 + (index + 0.5) * laneW;
  }

  /** Flat-highway lane X: no perspective warp — identical to columnX. */
  laneX(chart: Chart, index: number, _y: number): number {
    return this.columnX(chart, index);
  }

  /**
   * Receptor line: top rail for UP-SCROLL, bottom rail for DOWN-SCROLL.
   * The UP rail clears the 212 CSS px top cabinet stack (vocal ribbon +
   * opaque sub-row buttons) so strike plates never hide behind the HUD.
   */
  receptorY(): number {
    const H = this.canvas.height;
    if (this.scrollDir === "up") {
      return Math.min(H * 0.32, Math.max(212 * this.dpr, H * 0.24));
    }
    const margin = Math.min(150, Math.max(64, H * 0.14));
    return H - margin;
  }

  /**
   * Hard deterministic audio-visual time-snapping for one note time.
   * Pure function of the audio clock — never incremental velocity.
   */
  noteY(noteTimeMs: number, songTimeMs: number): number {
    const pxPerMs = PX_PER_MS * this.scrollSpeed;
    const sign = this.scrollDir === "up" ? 1 : -1;
    return this.receptorY() + sign * (noteTimeMs - songTimeMs) * pxPerMs;
  }

  /** Centered obsidian lane backing + chrome rails + lane dividers. */
  private drawHighwayChrome(
    chart: Chart,
    H: number,
    layout: HighwayLayout,
  ): void {
    const { ctx } = this;
    const n = this.columnCount(chart);
    ctx.save();
    // Obsidian backing.
    ctx.fillStyle = "#07090e";
    ctx.fillRect(layout.x0, 0, layout.x1 - layout.x0, H);
    // Alternating lane bands for column readability.
    for (let i = 0; i < n; i += 1) {
      if (i % 2 === 1) {
        ctx.fillStyle = "rgba(148,163,184,0.05)";
        ctx.fillRect(layout.x0 + i * layout.laneW, 0, layout.laneW, H);
      }
    }
    // Lane dividers.
    ctx.strokeStyle = "rgba(148,163,184,0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < n; i += 1) {
      const x = layout.x0 + i * layout.laneW;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
    }
    ctx.stroke();
    // Chrome outer rails.
    const railGrad = ctx.createLinearGradient(0, 0, 0, H);
    railGrad.addColorStop(0, "#f8fafc");
    railGrad.addColorStop(0.5, "#64748b");
    railGrad.addColorStop(1, "#cbd5e1");
    ctx.strokeStyle = this.overdrive ? "#fbbf24" : railGrad;
    ctx.lineWidth = 3;
    ctx.shadowColor = this.overdrive ? "#f59e0b" : "#22d3ee";
    ctx.shadowBlur = this.overdrive ? 18 : 8;
    ctx.beginPath();
    ctx.moveTo(layout.x0, 0);
    ctx.lineTo(layout.x0, H);
    ctx.moveTo(layout.x1, 0);
    ctx.lineTo(layout.x1, H);
    ctx.stroke();
    ctx.restore();
  }

  /** Measure/beat grid: thick bars on downbeats, thin ticks on quarters. */
  private drawBeatTicks(
    chart: Chart,
    songTimeMs: number,
    layout: HighwayLayout,
  ): void {
    const { ctx } = this;
    const H = this.canvas.height;
    const beatMs = 60000 / Math.max(1, chart.bpm);
    const w = layout.x1 - layout.x0;
    // Cover the visible window with margin on both sides.
    const t0 = songTimeMs - APPROACH_MS;
    const t1 = songTimeMs + APPROACH_MS;
    const k0 = Math.floor((t0 - chart.offset_ms) / beatMs);
    const k1 = Math.ceil((t1 - chart.offset_ms) / beatMs);
    ctx.save();
    for (let k = k0; k <= k1; k += 1) {
      const t = chart.offset_ms + k * beatMs;
      const y = this.noteY(t, songTimeMs);
      if (y < -2 || y > H + 2) {
        continue;
      }
      const downbeat = ((k % 4) + 4) % 4 === 0;
      ctx.fillStyle = downbeat
        ? "rgba(226,232,240,0.5)"
        : "rgba(148,163,184,0.22)";
      ctx.fillRect(layout.x0, y - (downbeat ? 1.5 : 0.5), w, downbeat ? 3 : 1);
    }
    ctx.restore();
  }

  /** Vertical FFT VU ladders flanking the outer rails (never over notes). */
  private drawVuLadders(
    songTimeMs: number,
    layout: HighwayLayout,
  ): void {
    const { ctx } = this;
    const H = this.canvas.height;
    const bins = 24;
    const stripW = Math.max(8, layout.laneW * 0.16);
    const gap = Math.max(6, layout.laneW * 0.08);
    const segH = H / bins;
    const ladders: readonly number[] = [
      layout.x0 - gap - stripW,
      layout.x1 + gap,
    ];
    ctx.save();
    for (const x of ladders) {
      for (let i = 0; i < bins; i += 1) {
        let v: number;
        const spec = this.spectrum;
        if (spec !== null && spec.length > 0) {
          const src = spec[Math.floor((i / bins) * spec.length)] ?? 0;
          v = src / 255;
        } else {
          v =
            0.25 +
            0.18 * Math.sin(i * 0.7 + songTimeMs / 320) +
            0.08 * Math.sin(i * 1.7 - songTimeMs / 210);
          v = Math.max(0.05, v);
        }
        // Bottom-up LED ladder: lit segments glow green->gold->red.
        const y = H - (i + 1) * segH + 2;
        const heat = i / bins;
        const color =
          heat > 0.8 ? "#ef4444" : heat > 0.55 ? "#ffd000" : "#00f59b";
        const on = v * bins > i;
        ctx.globalAlpha = on ? 0.9 : 0.12;
        ctx.fillStyle = on ? color : "#1e293b";
        ctx.fillRect(x, y, stripW, Math.max(2, segH - 3));
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /** Segmented hold energy body: repeated atlas tiles + tail cap. */
  private drawHold(
    atlas: SpriteAtlas | null,
    x: number,
    yHead: number,
    yTail: number,
    quant: BeatQuant,
    color: string,
    active: boolean,
    ageActiveMs: number,
    songTimeMs: number,
  ): void {
    const { ctx } = this;
    const H = this.canvas.height;
    const top = Math.min(yHead, yTail);
    const bottom = Math.max(yHead, yTail);
    if (bottom < -40 || top > H + 40) {
      return;
    }
    // Spring-driven glow: eruption on the head strike, full while held.
    const glow = active
      ? 0.55 + 0.45 * Math.min(1.25, Math.max(0, holdGlow(ageActiveMs)))
      : 0.5 + 0.08 * Math.sin(songTimeMs / 160);
    const sw = Math.max(10, CELL_PX(atlas) * 0.42);
    const segH = 44;
    ctx.save();
    ctx.globalAlpha = Math.min(1, glow);
    if (this.overdrive) {
      ctx.shadowColor = "#f59e0b";
      ctx.shadowBlur = active ? 20 : 8;
    } else {
      ctx.shadowColor = color;
      ctx.shadowBlur = active ? 18 : 8;
    }
    let blitted = false;
    if (atlas !== null) {
      for (let y = top; y < bottom; y += segH) {
        const h = Math.min(segH + 2, bottom - y);
        blitted =
          blit(ctx, atlas, holdBodyKey(quant), x - sw / 2, y, sw, h) ||
          blitted;
      }
      // Tail cap at the far end.
      const tailY = yHead <= yTail ? bottom - sw : top;
      blit(ctx, atlas, holdTailKey(quant), x - sw / 2, tailY, sw, sw);
    }
    if (!blitted) {
      ctx.fillStyle = color;
      ctx.fillRect(x - sw / 2, top, sw, Math.max(2, bottom - top));
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fillRect(x - 2, top, 4, Math.max(2, bottom - top));
    }
    ctx.restore();
  }

  /** One scrolling note: a single atlas blit sized to the lane. */
  private drawNote(
    atlas: SpriteAtlas | null,
    glyph: AtlasGlyph,
    quant: BeatQuant,
    color: string,
    x: number,
    y: number,
    size: number,
    held: boolean,
  ): void {
    const { ctx } = this;
    const grow = held ? 1.12 : 1;
    const dw = size * grow;
    if (
      atlas !== null &&
      blit(ctx, atlas, noteKey(glyph, quant), x - dw / 2, y - dw / 2, dw, dw)
    ) {
      return;
    }
    // No-DOM fallback (vitest / static preview): crisp flat diamond.
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.95;
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
    const s = dw / 2;
    ctx.beginPath();
    ctx.moveTo(0, -s);
    ctx.lineTo(s * 0.85, 0);
    ctx.lineTo(0, s);
    ctx.lineTo(-s * 0.85, 0);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  /** Receptor row: atlas strike plates + spring stomp + beam flash. */
  private drawReceptors(
    atlas: SpriteAtlas | null,
    chart: Chart,
    songTimeMs: number,
    opts: RenderOptions,
    layout: HighwayLayout,
  ): void {
    const { ctx } = this;
    const n = this.columnCount(chart);
    const receptorY = this.receptorY();
    const mania = isManiaChart(chart);
    const beatMs = 60000 / Math.max(1, chart.bpm);
    const phase = ((songTimeMs - chart.offset_ms) % beatMs + beatMs) % beatMs;
    const onBeat = phase < beatMs * 0.14;
    const size = layout.laneW * 0.94;

    for (let i = 0; i < n; i += 1) {
      const x = this.columnX(chart, i);
      const glyph = glyphOf(chart, i);
      let mapKey: number | string;
      let baseColor: string;
      let sub: string;
      if (mania) {
        mapKey = i;
        baseColor = MANIA_LANE_COLORS[i] ?? "#22d3ee";
        sub = MANIA_LANE_LABELS[i] ?? "";
      } else {
        const pad = PUMP_ORDER[i] ?? "S";
        mapKey = pad;
        baseColor = padColor(pad);
        sub = `${pad}·${PUMP_RECEPTOR_POS[pad]}`;
      }
      const flash = opts.flashes.get(mapKey);
      const ageFlash =
        flash === undefined ? Number.POSITIVE_INFINITY : songTimeMs - flash.timeMs;
      const lit = ageFlash < 180;
      const heldDown = opts.held.has(mapKey);
      const pressAge = songTimeMs - (opts.pressedAt.get(mapKey) ?? NaN);

      // Mechanical stomp: press snaps to 0.82, spring returns to 1.0.
      const scale = heldDown ? receptorScale(Number.isFinite(pressAge) ? pressAge : 0) : 1;
      const state: ReceptorState = heldDown
        ? "pressed"
        : lit
          ? "hit"
          : onBeat
            ? "beat"
            : "dim";
      const dw = size * (heldDown ? scale : lit ? 1 + 0.3 * Math.exp(-ageFlash / 90) : 1);
      ctx.save();
      if (atlas !== null) {
        blit(ctx, atlas, receptorKey(glyph, state), x - dw / 2, receptorY - dw / 2, dw, dw);
      } else {
        ctx.translate(x, receptorY);
        ctx.fillStyle = lit && flash !== undefined
          ? JUDGMENT_FLASH_COLORS[flash.judgment]
          : heldDown
            ? baseColor
            : "#101728";
        ctx.globalAlpha = lit || heldDown ? 0.95 : 0.85;
        ctx.fillRect((-dw / 2), (-dw / 2), dw, dw);
        ctx.lineWidth = heldDown ? 4 : 2.5;
        ctx.strokeStyle = baseColor;
        ctx.strokeRect((-dw / 2), (-dw / 2), dw, dw);
      }
      ctx.restore();

      // Lane hit flash: spring-driven beam pillar along the scroll axis.
      if (heldDown || lit) {
        const strength = heldDown
          ? Math.min(1.2, Math.max(0.35, holdGlow(Number.isFinite(pressAge) ? pressAge : 0)))
          : Math.max(0, 1 - ageFlash / 180);
        const beamH = Math.min(320, this.canvas.height * 0.3) * strength;
        const y0 = receptorY;
        const y1 = this.scrollDir === "up" ? receptorY + beamH : receptorY - beamH;
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        const grad = ctx.createLinearGradient(0, y0, 0, y1);
        grad.addColorStop(0, baseColor);
        grad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.globalAlpha = 0.45 * Math.min(1, strength);
        ctx.fillStyle = grad;
        const bw = Math.max(10, layout.laneW * 0.5 * strength);
        ctx.fillRect(x - bw / 2, Math.min(y0, y1), bw, Math.abs(y1 - y0));
        ctx.restore();
      }

      // Crisp vector label on the outer side of the receptor line.
      ctx.save();
      ctx.fillStyle = "#e2e8f0";
      ctx.font = "11px ui-monospace, monospace";
      ctx.textAlign = "center";
      const label = `${GLYPH_LABEL[glyph]} ${sub}`;
      const ly = this.scrollDir === "up" ? receptorY + dw / 2 + 16 : receptorY - dw / 2 - 8;
      ctx.fillText(label, x, ly);
      ctx.restore();
    }
  }

  /** SPRITE explosion sequence for PERFECT/GREAT hit marks. */
  private drawSparks(
    atlas: SpriteAtlas | null,
    chart: Chart,
    songTimeMs: number,
    opts: RenderOptions,
    layout: HighwayLayout,
  ): void {
    const { ctx } = this;
    const SPARK_MS = 360;
    const FRAME_MS = SPARK_MS / 8;
    for (const pop of opts.pops) {
      const age = songTimeMs - pop.timeMs;
      if (age < 0 || age > SPARK_MS) {
        continue;
      }
      if (pop.judgment !== "PERFECT" && pop.judgment !== "GREAT") {
        continue;
      }
      const note = chart.notes[pop.noteIndex];
      if (note === undefined) {
        continue;
      }
      const col = isManiaChart(chart)
        ? (note.lane ?? 0)
        : PUMP_ORDER.indexOf(note.pad ?? "S");
      const x = this.columnX(chart, Math.max(0, col));
      const y = this.receptorY();
      const size = layout.laneW * (2 - (age / SPARK_MS) * 0.6);
      const frame = Math.min(7, Math.floor(age / FRAME_MS));
      const kind = pop.judgment === "PERFECT" ? "perfect" : "great";
      ctx.save();
      if (
        atlas === null ||
        !blit(ctx, atlas, sparkKey(kind, frame), x - size / 2, y - size / 2, size, size)
      ) {
        const color = JUDGMENT_FLASH_COLORS[pop.judgment];
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 1 - age / SPARK_MS;
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y, 14 + age * 0.12, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /** Center-highway judgment callout: spring scale-pop, fixed vertical. */
  private drawCallout(songTimeMs: number, newest: HitPop | undefined, combo: number): void {
    if (newest === undefined) {
      return;
    }
    const age = songTimeMs - newest.timeMs;
    if (age < 0 || age > 520) {
      return;
    }
    const { ctx } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const color = JUDGMENT_FLASH_COLORS[newest.judgment];
    const pop = popScale(age);
    const alpha = age > 380 ? 1 - (age - 380) / 140 : 1;
    const cx = W / 2;
    const cy = H * 0.4;
    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.translate(cx, cy);
    ctx.scale(pop, pop);
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

  /** Overdrive border fire: gold/cyan flames on the highway rails. */
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
      const grad = w < h
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
   * to note indices. The PLAY path never passes marks.
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
    const atlas = getAtlas();
    const layout = this.layout(chart);
    const mania = isManiaChart(chart);
    const noteSize = layout.laneW * 0.88;

    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(this.paintBackdrop(W, H), 0, 0);
    this.drawHighwayChrome(chart, H, layout);
    this.drawBeatTicks(chart, songTimeMs, layout);
    this.drawVuLadders(songTimeMs, layout);

    const colOf = (note: ChartNote): number =>
      mania ? (note.lane ?? 0) : PUMP_ORDER.indexOf(note.pad ?? "S");
    const colorOf = (note: ChartNote): string => {
      if (mania) {
        return MANIA_LANE_COLORS[note.lane ?? 0] ?? "#22d3ee";
      }
      return padColor(note.pad ?? "S");
    };

    // Hold ribbons first (under the note heads).
    for (let noteIndex = 0; noteIndex < chart.notes.length; noteIndex += 1) {
      const note = chart.notes[noteIndex];
      if (note === undefined || note.duration_ms <= 0) {
        continue;
      }
      const yHead = this.noteY(note.time_ms, songTimeMs);
      const yTail = this.noteY(note.time_ms + note.duration_ms, songTimeMs);
      const top = Math.min(yHead, yTail);
      const bottom = Math.max(yHead, yTail);
      if (bottom < -80 || top > H + 80) {
        continue;
      }
      const active = opts.activeHolds.has(noteIndex);
      const mapKey = note.lane ?? note.pad ?? "?";
      const pressAt = opts.pressedAt.get(mapKey);
      this.drawHold(
        atlas,
        this.columnX(chart, Math.max(0, colOf(note))),
        yHead,
        yTail,
        quantOf(chart, note),
        colorOf(note),
        active,
        active && pressAt !== undefined ? songTimeMs - pressAt : 0,
        songTimeMs,
      );
    }

    // Notes: one atlas blit each, hard-snapped to the audio clock.
    for (let noteIndex = 0; noteIndex < chart.notes.length; noteIndex += 1) {
      const note = chart.notes[noteIndex];
      if (note === undefined) {
        continue;
      }
      const dt = note.time_ms - songTimeMs;
      if (dt < -200 || dt > APPROACH_MS) {
        continue;
      }
      const col = Math.max(0, colOf(note));
      const y = this.noteY(note.time_ms, songTimeMs);
      if (y < -50 || y > H + 50) {
        continue;
      }
      const x = this.columnX(chart, col);
      this.drawNote(
        atlas,
        glyphOf(chart, col),
        quantOf(chart, note),
        colorOf(note),
        x,
        y,
        noteSize,
        opts.activeHolds.has(noteIndex),
      );

      // Studio EDIT foot-parity badges on pump notes.
      if (opts.editMode === true && !mania) {
        const foot = PAD_FOOT[note.pad ?? "S"];
        const tag = foot === "C" ? "L/R" : foot;
        ctx.save();
        ctx.font = "700 11px ui-monospace, monospace";
        ctx.textAlign = "center";
        const tw = ctx.measureText(tag).width + 8;
        ctx.fillStyle =
          foot === "L"
            ? "rgba(34,211,238,0.9)"
            : foot === "R"
              ? "rgba(251,146,60,0.9)"
              : "rgba(167,139,250,0.9)";
        ctx.fillRect(x - tw / 2, y - noteSize / 2 - 16, tw, 14);
        ctx.fillStyle = "#0b0e1a";
        ctx.fillText(tag, x, y - noteSize / 2 - 5);
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
        const r = noteSize / 2 + 8;
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

    this.drawReceptors(atlas, chart, songTimeMs, opts, layout);
    this.drawSparks(atlas, chart, songTimeMs, opts, layout);

    const newest = opts.pops.length > 0 ? opts.pops[opts.pops.length - 1] : undefined;
    this.drawCallout(songTimeMs, newest, opts.combo);

    if (this.overdrive) {
      this.drawOverdriveBorders(W, H, songTimeMs);
    }
  }
}

/** Atlas cell size in px (96 when no atlas: fallback path sizes itself). */
function CELL_PX(atlas: SpriteAtlas | null): number {
  return atlas?.cell ?? 96;
}

