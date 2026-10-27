/**
 * RhythmEngine: wires MasterClock + ChartRenderer + input + scoring.
 *
 * Loop is a single `requestAnimationFrame` callback. Hit/miss deltas and
 * note positions both come from `MasterClock.songTimeMs()` — the audio
 * clock is the single source of truth for <5ms AV sync.
 */
import type { Chart, ChartNote } from "../types/chart";
import { isManiaChart } from "../types/chart";
import { MasterClock } from "./clock";
import { keyToLane, keyToPad } from "./input";
import {
  GOOD_WINDOW_MS,
  accuracy,
  createScoreState,
  isMissWindowExceeded,
  judgeHit,
  registerJudgment,
  type Judgment,
  type ScoreState,
} from "./judgments";
import {
  ChartRenderer,
  createRenderState,
  type HitPop,
  type ScrollDirection,
} from "./renderer";

export interface EngineSnapshot {
  songTimeMs: number;
  score: ScoreState;
  judged: number;
  total: number;
  lastJudgment: Judgment | null;
  /** True while a SAM Overdrive pose holds the 2x score multiplier. */
  overdrive: boolean;
  /** True once every note has been judged — the chart is complete. */
  finished: boolean;
}

export class RhythmEngine {
  private readonly clock: MasterClock;
  private readonly renderer: ChartRenderer;
  private readonly audioCtx: AudioContext;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  /** Live uploaded-song source (Stage 5). Null while the demo synth runs. */
  private bufferSrc: AudioBufferSourceNode | null = null;
  private spectrum: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private readonly flashes = createRenderState();
  private chart: Chart;
  private score: ScoreState = createScoreState();
  private hitFlags: boolean[] = [];
  private rafId = 0;
  private running = false;
  private lastJudgment: Judgment | null = null;
  private overdrive = false;
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onKeyUp: (e: KeyboardEvent) => void;

  constructor(canvas: HTMLCanvasElement, audioCtx: AudioContext, chart: Chart) {
    this.clock = new MasterClock(audioCtx);
    this.audioCtx = audioCtx;
    this.renderer = new ChartRenderer(canvas);
    this.chart = chart;
    this.hitFlags = chart.notes.map(() => false);
    this.onKeyDown = (e: KeyboardEvent) => {
      if (!e.repeat) {
        this.press(e.key);
      }
    };
    this.onKeyUp = (e: KeyboardEvent) => {
      this.release(e.key);
    };
  }

  load(chart: Chart): void {
    this.chart = chart;
    this.hitFlags = chart.notes.map(() => false);
    this.score = createScoreState();
    this.lastJudgment = null;
    this.flashes.flashes.clear();
    this.flashes.held.clear();
    this.flashes.pressedAt.clear();
    this.flashes.activeHolds.clear();
    this.flashes.pops.length = 0;
    this.flashes.combo = 0;
  }

  /**
   * Master bus for the demo synth: synth -> master -> analyser ->
   * destination. The renderer reads FFT magnitudes from the same tap, so the
   * stage visualizer pulses with the exact audible mix.
   */
  synthDest(): AudioNode {
    if (this.master === null || this.analyser === null) {
      const master = this.audioCtx.createGain();
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.78;
      master.connect(analyser);
      analyser.connect(this.audioCtx.destination);
      this.master = master;
      this.analyser = analyser;
      this.spectrum = new Uint8Array(analyser.frequencyBinCount);
    }
    return this.master;
  }

  /** Refit the canvas backing store (fullscreen resize). */
  refit(): void {
    this.renderer.fitToDisplay();
  }

  /** Record a hit mark at the note's position; newest last, capped. */
  private pushPop(pop: HitPop): void {
    this.flashes.pops.push(pop);
    if (this.flashes.pops.length > 12) {
      this.flashes.pops.splice(0, this.flashes.pops.length - 12);
    }
  }

  start(): void {
    this.clock.start(this.chart.offset_ms);
    this.beginLoop();
  }

  /**
   * Stage 5: play a decoded real-audio `AudioBuffer` through the same
   * master bus + FFT analyser the synth uses, and lock `songTimeMs()` to
   * the exact playback offset. The source and the clock share one `t0`,
   * so AV sync stays on the audio hardware clock (<5ms).
   */
  startWithBuffer(buf: AudioBuffer): void {
    this.stopUploadedBuffer();
    const src = this.audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(this.synthDest());
    const t0 = this.audioCtx.currentTime + 0.03;
    src.start(t0);
    this.bufferSrc = src;
    this.clock.startAt(t0, this.chart.offset_ms);
    this.beginLoop();
  }

  /** True while an uploaded-song buffer is wired into the master bus. */
  get hasUploadedBuffer(): boolean {
    return this.bufferSrc !== null;
  }

  private beginLoop(): void {
    this.renderer.fitToDisplay();
    this.running = true;
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    const tick = (): void => {
      if (!this.running) {
        return;
      }
      this.frame();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopUploadedBuffer(): void {
    if (this.bufferSrc === null) {
      return;
    }
    try {
      this.bufferSrc.stop();
    } catch {
      // Already finished playing; ignore.
    }
    try {
      this.bufferSrc.disconnect();
    } catch {
      // Node already torn down with the AudioContext; ignore.
    }
    this.bufferSrc = null;
  }

  destroy(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.clock.stop();
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.stopUploadedBuffer();
    try {
      this.analyser?.disconnect();
      this.master?.disconnect();
    } catch {
      // Nodes already torn down with the AudioContext; ignore.
    }
    this.analyser = null;
    this.master = null;
  }

  /** Live song position in ms, straight from the audio master clock. */
  songTimeMs(): number {
    return this.clock.songTimeMs();
  }

  snapshot(): EngineSnapshot {
    return {
      songTimeMs: this.clock.songTimeMs(),
      score: this.score,
      judged: this.hitFlags.filter(Boolean).length,
      total: this.chart.notes.length,
      lastJudgment: this.lastJudgment,
      overdrive: this.overdrive,
      finished:
        this.chart.notes.length > 0 &&
        this.hitFlags.every((hit) => hit),
    };
  }

  getAccuracy(): number {
    return accuracy(this.score);
  }

  /** Studio UI scroll-speed control (multiplier, 1 = nominal). */
  setScrollSpeed(speed: number): void {
    this.renderer.scrollSpeed = speed;
  }

  /** 1-click UP/DOWN scroll toggle: receptors top (up) or bottom (down). */
  setScrollDirection(dir: ScrollDirection): void {
    this.renderer.scrollDir = dir;
  }

  /** SAM Cam-Pad Overdrive pose: doubles judged points while true. */
  setOverdrive(active: boolean): void {
    this.overdrive = active;
    this.renderer.overdrive = active;
  }

  private resolveKey(key: string): number | string | null {
    if (isManiaChart(this.chart)) {
      return keyToLane(key);
    }
    return keyToPad(key);
  }

  /** Public for tests: judge a press on a lane/pad at a song time. */
  pressAt(mapKey: number | string, songTimeMs: number): Judgment | null {
    const idx = this.findClosestUnhit(mapKey, songTimeMs);
    if (idx === -1) {
      return null;
    }
    const delta = songTimeMs - this.chart.notes[idx].time_ms;
    const judgment = judgeHit(delta);
    this.applyHit(idx, mapKey, judgment, this.chart.notes[idx]);
    return judgment;
  }

  private press(key: string): void {
    const mapKey = this.resolveKey(key);
    if (mapKey === null) {
      return;
    }
    this.flashes.held.add(mapKey);
    this.flashes.pressedAt.set(mapKey, this.clock.songTimeMs());
    this.pressAt(mapKey, this.clock.songTimeMs());
  }

  private release(key: string): void {
    const mapKey = this.resolveKey(key);
    if (mapKey === null) {
      return;
    }
    this.flashes.held.delete(mapKey);
    // End holds whose key was released.
    this.chart.notes.forEach((note, i) => {
      if (
        note.duration_ms > 0 &&
        this.flashes.activeHolds.has(i) &&
        this.noteKey(note) === mapKey
      ) {
        this.flashes.activeHolds.delete(i);
      }
    });
  }

  private noteKey(note: ChartNote): number | string {
    return note.lane ?? note.pad ?? "?";
  }

  private findClosestUnhit(mapKey: number | string, songTimeMs: number): number {
    let best = -1;
    let bestAbs = GOOD_WINDOW_MS + 1;
    this.chart.notes.forEach((note, i) => {
      if (this.hitFlags[i] || this.noteKey(note) !== mapKey) {
        return;
      }
      const a = Math.abs(songTimeMs - note.time_ms);
      if (a <= GOOD_WINDOW_MS && a < bestAbs) {
        best = i;
        bestAbs = a;
      }
    });
    return best;
  }

  private applyHit(
    idx: number,
    mapKey: number | string,
    judgment: Judgment,
    note: ChartNote,
  ): void {
    this.hitFlags[idx] = true;
    this.lastJudgment = judgment;
    registerJudgment(this.score, judgment, this.overdrive ? 2 : 1, mapKey);
    const hitTimeMs = this.clock.songTimeMs();
    // Flash map is keyed by lane/pad for the renderer.
    this.flashes.flashes.set(mapKey, {
      timeMs: hitTimeMs,
      judgment,
    });
    this.pushPop({ noteIndex: idx, timeMs: hitTimeMs, judgment });
    if (note.duration_ms > 0 && judgment !== "MISS") {
      this.flashes.activeHolds.add(idx);
    }
  }

  private frame(): void {
    const now = this.clock.songTimeMs();
    // Feed the stage visualizer + callout from the same audio clock.
    if (this.analyser !== null) {
      this.analyser.getByteFrequencyData(this.spectrum);
      this.renderer.spectrum = this.spectrum;
    }
    this.flashes.combo = this.score.combo;
    // Miss sweep: unhit notes past the GOOD window become MISS.
    this.chart.notes.forEach((note, i) => {
      if (!this.hitFlags[i] && isMissWindowExceeded(now, note.time_ms)) {
        this.hitFlags[i] = true;
        this.lastJudgment = "MISS";
        registerJudgment(this.score, "MISS", 1, this.noteKey(note));
        this.flashes.flashes.set(this.noteKey(note), {
          timeMs: now,
          judgment: "MISS",
        });
        this.pushPop({ noteIndex: i, timeMs: now, judgment: "MISS" });
      }
    });
    // Drop stale hit marks so the pops list never grows unbounded.
    while (
      this.flashes.pops.length > 0 &&
      now - this.flashes.pops[0]!.timeMs > 600
    ) {
      this.flashes.pops.shift();
    }
    this.renderer.render(this.chart, now, this.flashes);
  }
}
