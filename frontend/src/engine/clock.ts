/**
 * Master song clock — `AudioContext.currentTime` is the ONLY time source.
 *
 * Note Y positions in the renderer and hit deltas in the engine are derived
 * exclusively from `songTimeMs()`. Never use `setInterval`/`Date.now()` for
 * note positions: the audio hardware clock is what keeps AV sync <5ms.
 */
export class MasterClock {
  private readonly ctx: AudioContext;
  private startCtxTime = 0;
  private offsetMs = 0;
  private running = false;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  get audioContext(): AudioContext {
    return this.ctx;
  }

  /** Anchor time zero to "now" on the audio clock. Call on (re)start. */
  start(offsetMs = 0): void {
    // Resume a suspended context so currentTime actually advances.
    void this.ctx.resume();
    this.offsetMs = offsetMs;
    this.startCtxTime = this.ctx.currentTime;
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Current song position in ms, from the audio clock only. */
  songTimeMs(): number {
    if (!this.running) {
      return 0;
    }
    return (this.ctx.currentTime - this.startCtxTime) * 1000 + this.offsetMs;
  }
}
