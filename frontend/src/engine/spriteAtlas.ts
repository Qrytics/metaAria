/**
 * Pre-baked sprite sheet atlas + UV mapping for the 2D arcade highway.
 *
 * Arcade rule: gameplay NEVER draws raw procedural polygons per frame.
 * Every note, receptor, hold segment, and explosion frame is baked ONCE
 * into an offscreen atlas canvas (high-DPI ready) and blitted per frame
 * with a single `ctx.drawImage(atlas, sx, sy, sw, sh, dx, dy, dw, dh)`
 * using the explicit UV lookup tables below.
 *
 * Static sheets: if `/public/assets/atlas.png` + `/public/assets/atlas.json`
 * are present, `ensureAtlas()` adopts them (same UV key contract);
 * otherwise the procedural bake below is used. The bake runs lazily so
 * `vitest` (node, no DOM) can import this module safely.
 */

export type BeatQuant = "4th" | "8th" | "12th" | "16th";

/** StepMania/PIU rhythm note colors by beat fraction. */
export const NOTE_COLORS: Record<BeatQuant, string> = {
  "4th": "#ff2a54",
  "8th": "#00d2ff",
  "12th": "#ffd000",
  "16th": "#00f59b",
};

/** Center-stomp plate: iconic PIU gold with inner target crosshairs. */
export const CENTER_STOMP_COLOR = "#ffd000";

/** Atlas glyph columns: 5 Pump panels + 4 Mania arrows. */
export const GLYPHS = ["Q", "E", "S", "Z", "C", "M0", "M1", "M2", "M3"] as const;
export type AtlasGlyph = (typeof GLYPHS)[number];

/** Receptor states baked per glyph. */
export const RECEPTOR_STATES = ["dim", "beat", "pressed", "hit"] as const;
export type ReceptorState = (typeof RECEPTOR_STATES)[number];

export type UVRect = readonly [sx: number, sy: number, sw: number, sh: number];

/** Pixels per atlas cell. Bake at 2x of the largest on-screen sprite. */
export const CELL = 96;

const RECEPTOR_ROWS = RECEPTOR_STATES.length;
const NOTE_ROWS = 4;
const QUANTS: readonly BeatQuant[] = ["4th", "8th", "12th", "16th"];
const SPARK_KINDS = ["perfect", "great"] as const;
export type SparkKind = (typeof SPARK_KINDS)[number];
export const SPARK_FRAMES = 8;

export const ATLAS_COLS = GLYPHS.length;
export const ATLAS_ROWS =
  RECEPTOR_ROWS + NOTE_ROWS + 2 /* hold body + tail */ + SPARK_KINDS.length;

/**
 * Quantize a note time to its StepMania beat fraction.
 * `offsetMs` anchors the grid (chart.offset_ms), `bpm` sets the beat.
 */
export function beatQuant(bpm: number, offsetMs: number, timeMs: number): BeatQuant {
  const beatMs = 60000 / Math.max(1, bpm);
  const beats = (timeMs - offsetMs) / beatMs;
  const frac = ((beats % 1) + 1) % 1;
  const near = (x: number): boolean => Math.abs(frac - x) < 0.03 || Math.abs(frac - x) > 0.97;
  if (near(0)) {
    return "4th";
  }
  if (near(0.5)) {
    return "8th";
  }
  if (near(1 / 3) || near(2 / 3)) {
    return "12th";
  }
  return "16th";
}

/** Pump arrow rotation (radians, canvas-clockwise, 0 = pointing up). */
export const PUMP_GLYPH_ANGLE: Record<string, number> = {
  Q: -Math.PI / 4,
  E: Math.PI / 4,
  S: 0,
  Z: -((3 * Math.PI) / 4),
  C: (3 * Math.PI) / 4,
};

/** Mania arrow rotation per lane (lanes read ← ↓ ↑ →). */
export const MANIA_GLYPH_ANGLE: readonly number[] = [
  -Math.PI / 2,
  Math.PI,
  0,
  Math.PI / 2,
];

/** Glyph display labels for receptor chrome. */
export const GLYPH_LABEL: Record<AtlasGlyph, string> = {
  Q: "↖",
  E: "↗",
  S: "❖",
  Z: "↙",
  C: "↘",
  M0: "←",
  M1: "↓",
  M2: "↑",
  M3: "→",
};

export interface SpriteAtlas {
  readonly canvas: HTMLCanvasElement;
  readonly uv: ReadonlyMap<string, UVRect>;
  readonly cell: number;
}

let cached: SpriteAtlas | null = null;
let staticTried = false;

function hasDom(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof document.createElement === "function"
  );
}

/** Synchronous accessor: procedural bake, cached. Safe without a DOM. */
export function getAtlas(): SpriteAtlas | null {
  if (cached !== null) {
    return cached;
  }
  if (!hasDom()) {
    return null;
  }
  cached = bakeAtlas();
  return cached;
}

/**
 * Async accessor: adopt `/assets/atlas.png` + `/assets/atlas.json` when
 * both exist and match the UV contract, else fall back to the bake.
 */
export async function ensureAtlas(
  baseUrl = "/assets/atlas",
): Promise<SpriteAtlas | null> {
  const baked = getAtlas();
  if (!hasDom() || staticTried) {
    return baked;
  }
  staticTried = true;
  try {
    const res = await fetch(`${baseUrl}.json`);
    if (!res.ok) {
      return baked;
    }
    const uv = (await res.json()) as Record<string, UVRect>;
    const img = new Image();
    img.src = `${baseUrl}.png`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      return baked;
    }
    ctx.drawImage(img, 0, 0);
    const map = new Map<string, UVRect>();
    for (const [k, v] of Object.entries(uv)) {
      if (Array.isArray(v) && v.length === 4) {
        map.set(k, [v[0], v[1], v[2], v[3]]);
      }
    }
    if (map.size > 0) {
      cached = { canvas, uv: map, cell: CELL };
    }
  } catch {
    // Missing/undecodable static sheet: keep the procedural bake.
  }
  return cached;
}

/** UV key helpers (single contract for baked + static sheets). */
export function receptorKey(glyph: AtlasGlyph, state: ReceptorState): string {
  return `receptor:${glyph}:${state}`;
}
export function noteKey(glyph: AtlasGlyph, quant: BeatQuant): string {
  return `note:${glyph}:${quant}`;
}
export function holdBodyKey(quant: BeatQuant): string {
  return `hold-body:${quant}`;
}
export function holdTailKey(quant: BeatQuant): string {
  return `hold-tail:${quant}`;
}
export function sparkKey(kind: SparkKind, frame: number): string {
  return `spark:${kind}:${frame}`;
}

/* ------------------------------------------------------------------ */
/* Procedural bake (runs ONCE; per-frame rendering is blits only).     */
/* ------------------------------------------------------------------ */

function bakeAtlas(): SpriteAtlas {
  const canvas = document.createElement("canvas");
  canvas.width = ATLAS_COLS * CELL;
  canvas.height = ATLAS_ROWS * CELL;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new Error("2d canvas context unavailable for atlas bake");
  }
  const uv = new Map<string, UVRect>();
  const put = (key: string, col: number, row: number): void => {
    uv.set(key, [col * CELL, row * CELL, CELL, CELL]);
  };

  GLYPHS.forEach((glyph, col) => {
    RECEPTOR_STATES.forEach((state, r) => {
      bakeReceptor(ctx, col * CELL, r * CELL, glyph, state);
      put(receptorKey(glyph, state), col, r);
    });
  });
  const noteRow0 = RECEPTOR_ROWS;
  GLYPHS.forEach((glyph, col) => {
    QUANTS.forEach((quant, r) => {
      bakeNote(ctx, col * CELL, (noteRow0 + r) * CELL, glyph, quant);
      put(noteKey(glyph, quant), col, noteRow0 + r);
    });
  });
  const holdRow = RECEPTOR_ROWS + NOTE_ROWS;
  // Hold tiles span the row width: one body + one tail cell per quant.
  QUANTS.forEach((quant, i) => {
    const bx = i * 2 * CELL;
    bakeHoldBody(ctx, bx, holdRow * CELL, quant);
    uv.set(holdBodyKey(quant), [bx, holdRow * CELL, CELL, CELL]);
    const tx = (i * 2 + 1) * CELL;
    bakeHoldTail(ctx, tx, (holdRow + 1) * CELL, quant);
    uv.set(holdTailKey(quant), [tx, (holdRow + 1) * CELL, CELL, CELL]);
  });
  const sparkRow0 = RECEPTOR_ROWS + NOTE_ROWS + 2;
  SPARK_KINDS.forEach((kind, k) => {
    for (let f = 0; f < SPARK_FRAMES; f += 1) {
      bakeSpark(ctx, f * CELL, (sparkRow0 + k) * CELL, kind, f);
      put(sparkKey(kind, f), f, sparkRow0 + k);
    }
  });
  return { canvas, uv, cell: CELL };
}

/** Multi-layer metallic arcade bevel around a rounded panel. */
function chromeFrame(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const frame = ctx.createLinearGradient(x, y, x, y + h);
  frame.addColorStop(0, "#f8fafc");
  frame.addColorStop(0.25, "#94a3b8");
  frame.addColorStop(0.5, "#475569");
  frame.addColorStop(0.75, "#cbd5e1");
  frame.addColorStop(1, "#64748b");
  ctx.fillStyle = frame;
  roundRect(ctx, x, y, w, h, r);
  ctx.fill();
  // Dark inner recess.
  const recess = ctx.createLinearGradient(x, y + 3, x, y + h - 3);
  recess.addColorStop(0, "#02040a");
  recess.addColorStop(0.5, "#0b0e1a");
  recess.addColorStop(1, "#05070c");
  ctx.fillStyle = recess;
  roundRect(ctx, x + 4, y + 4, w - 8, h - 8, Math.max(2, r - 4));
  ctx.fill();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Trace the glyph arrow path centered at (cx, cy) with radius s. */
function traceGlyph(
  ctx: CanvasRenderingContext2D,
  glyph: AtlasGlyph,
  cx: number,
  cy: number,
  s: number,
): void {
  ctx.beginPath();
  if (glyph === "S") {
    ctx.moveTo(cx, cy - s);
    ctx.lineTo(cx + s * 0.85, cy);
    ctx.lineTo(cx, cy + s);
    ctx.lineTo(cx - s * 0.85, cy);
    ctx.closePath();
    return;
  }
  let angle: number;
  if (glyph.startsWith("M")) {
    angle = MANIA_GLYPH_ANGLE[Number(glyph.slice(1))] ?? 0;
  } else {
    angle = PUMP_GLYPH_ANGLE[glyph] ?? 0;
  }
  // Arrow pointing up, rotated into place.
  const pts: Array<[number, number]> = [
    [0, -s],
    [s * 0.92, s * 0.62],
    [s * 0.36, s * 0.62],
    [s * 0.36, s],
    [-s * 0.36, s],
    [-s * 0.36, s * 0.62],
    [-s * 0.92, s * 0.62],
  ];
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  pts.forEach(([px, py], i) => {
    const rx = px * cos - py * sin + cx;
    const ry = px * sin + py * cos + cy;
    if (i === 0) {
      ctx.moveTo(rx, ry);
    } else {
      ctx.lineTo(rx, ry);
    }
  });
  ctx.closePath();
}

/** Fill a glyph with chrome bevel: white crown -> color -> dark root. */
function paintGlyph(
  ctx: CanvasRenderingContext2D,
  glyph: AtlasGlyph,
  cx: number,
  cy: number,
  s: number,
  color: string,
  coreAlpha: number,
): void {
  traceGlyph(ctx, glyph, cx, cy, s);
  const grad = ctx.createLinearGradient(cx, cy - s, cx, cy + s);
  grad.addColorStop(0, "#ffffff");
  grad.addColorStop(0.35, color);
  grad.addColorStop(1, "#0b0e1a");
  ctx.fillStyle = grad;
  ctx.globalAlpha = 0.98;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = "rgba(248,250,252,0.9)";
  ctx.stroke();
  // White core highlight.
  ctx.save();
  ctx.globalAlpha = coreAlpha;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(cx, cy - s * 0.18, Math.max(1.5, s * 0.16), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  if (glyph === "S") {
    // Inner target crosshairs on the center stomp plate.
    ctx.save();
    ctx.strokeStyle = "rgba(11,14,26,0.85)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.45, cy);
    ctx.lineTo(cx + s * 0.45, cy);
    ctx.moveTo(cx, cy - s * 0.45);
    ctx.lineTo(cx, cy + s * 0.45);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, s * 0.28, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function bakeReceptor(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  glyph: AtlasGlyph,
  state: ReceptorState,
): void {
  ctx.save();
  ctx.clearRect(ox, oy, CELL, CELL);
  ctx.translate(ox + CELL / 2, oy + CELL / 2);
  const panel = 78;
  chromeFrame(ctx, -panel / 2, -panel / 2, panel, panel, 12);
  const color =
    glyph === "S" ? CENTER_STOMP_COLOR : glyphColor(glyph, "4th");
  if (state === "dim") {
    paintGlyph(ctx, glyph, 0, 0, 24, "#475569", 0.25);
  } else if (state === "beat") {
    paintGlyph(ctx, glyph, 0, 0, 24, color, 0.7);
  } else if (state === "pressed") {
    paintGlyph(ctx, glyph, 0, 0, 21, "#ffffff", 1);
  } else {
    // hit: judgment flash — hot white-gold strike plate.
    paintGlyph(ctx, glyph, 0, 0, 26, "#fde047", 1);
  }
  // Crisp vector border label under the glyph.
  ctx.fillStyle =
    state === "dim" ? "rgba(148,163,184,0.75)" : "rgba(226,232,240,0.95)";
  ctx.font = "bold 11px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.fillText(GLYPH_LABEL[glyph], 0, 34);
  ctx.restore();
}

function glyphColor(glyph: AtlasGlyph, quant: BeatQuant): string {
  if (glyph === "S") {
    return CENTER_STOMP_COLOR;
  }
  return NOTE_COLORS[quant];
}

function bakeNote(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  glyph: AtlasGlyph,
  quant: BeatQuant,
): void {
  ctx.save();
  ctx.clearRect(ox, oy, CELL, CELL);
  ctx.translate(ox + CELL / 2, oy + CELL / 2);
  paintGlyph(ctx, glyph, 0, 0, 27, glyphColor(glyph, quant), 0.9);
  ctx.restore();
}

function bakeHoldBody(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  quant: BeatQuant,
): void {
  const color = NOTE_COLORS[quant];
  ctx.save();
  ctx.clearRect(ox, oy, CELL, CELL);
  // Segmented energy body: bright core thread + colored sheath.
  const grad = ctx.createLinearGradient(ox + 28, 0, ox + 68, 0);
  grad.addColorStop(0, "#0b0e1a");
  grad.addColorStop(0.5, color);
  grad.addColorStop(1, "#0b0e1a");
  ctx.fillStyle = grad;
  ctx.fillRect(ox + 28, oy, 40, CELL);
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.fillRect(ox + 46, oy, 4, CELL);
  // Segment ticks every 12px.
  ctx.fillStyle = "rgba(11,14,26,0.55)";
  for (let y = oy + 6; y < oy + CELL; y += 12) {
    ctx.fillRect(ox + 28, y, 40, 2);
  }
  ctx.restore();
}

function bakeHoldTail(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  quant: BeatQuant,
): void {
  const color = NOTE_COLORS[quant];
  ctx.save();
  ctx.clearRect(ox, oy, CELL, CELL);
  const grad = ctx.createLinearGradient(0, oy, 0, oy + CELL);
  grad.addColorStop(0, color);
  grad.addColorStop(1, "rgba(11,14,26,0.1)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(ox + CELL / 2, oy + CELL / 2, 20, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = "rgba(248,250,252,0.9)";
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.beginPath();
  ctx.arc(ox + CELL / 2, oy + CELL / 2, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function bakeSpark(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  kind: SparkKind,
  frame: number,
): void {
  const color = kind === "perfect" ? "#fde047" : "#4ade80";
  const t = frame / Math.max(1, SPARK_FRAMES - 1);
  const cx = ox + CELL / 2;
  const cy = oy + CELL / 2;
  ctx.save();
  ctx.clearRect(ox, oy, CELL, CELL);
  ctx.globalCompositeOperation = "lighter";
  // Expanding ring.
  ctx.globalAlpha = 0.95 * (1 - t * 0.8);
  ctx.strokeStyle = color;
  ctx.lineWidth = 5 * (1 - t) + 1;
  ctx.beginPath();
  ctx.arc(cx, cy, 6 + t * 34, 0, Math.PI * 2);
  ctx.stroke();
  // 8 shockwave rays.
  ctx.globalAlpha = 0.8 * (1 - t);
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2 + t * 0.6;
    const r0 = 8 + t * 30;
    const r1 = r0 + 10 * (1 - t) + 3;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    ctx.lineWidth = 3 * (1 - t) + 1;
    ctx.stroke();
  }
  // Hot core.
  ctx.globalAlpha = 0.9 * (1 - t * 0.7);
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(1, 7 * (1 - t) + 1.5), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * Blit one atlas cell in a single drawImage call.
 * Returns false when the atlas or key is unavailable (caller skips).
 */
export function blit(
  ctx: CanvasRenderingContext2D,
  atlas: SpriteAtlas | null,
  key: string,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): boolean {
  if (atlas === null) {
    return false;
  }
  const uv = atlas.uv.get(key);
  if (uv === undefined) {
    return false;
  }
  ctx.drawImage(atlas.canvas, uv[0], uv[1], uv[2], uv[3], dx, dy, dw, dh);
  return true;
}
