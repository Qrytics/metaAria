/**
 * Stage 2.5 live pitch detector — zero-latency time-domain YIN pitch
 * tracking (autocorrelation difference + cumulative-mean normalization,
 * McLeod-style parabolic interpolation) over a Web Audio AnalyserNode.
 *
 * Pure math (`freqToMidiFloat`, `foldedCentsError`, `scorePitchFrame`,
 * `detectPitchYin`) is dependency-free so vitest can cover it without a
 * microphone or AudioContext. `LivePitchDetector` owns the mic stream and
 * emits readings at ~60fps; `SimulatedSinger` synthesizes a target-locked
 * reading (vibrato + drift) for offline demo/testing without a live mic.
 *
 * Scoring is octave-agnostic: the sung pitch is folded into ±600 cents of
 * the target tube, so baritone and soprano voices score identically as long
 * as the pitch class lands within ±1.5 semitones (±150 cents).
 */

/** One pitch reading, emitted at display frame rate. */
export interface PitchReading {
  /** Fundamental frequency in Hz (0 when unvoiced). */
  frequencyHz: number;
  /** Fractional MIDI note of the sung pitch (0 when unvoiced). */
  midiNote: number;
  /** Signed cents vs the active target tube, folded to ±600. */
  centsOff: number;
  /** Voicing confidence 0..1 (YIN aperiodicity complement). */
  clarity: number;
  voiced: boolean;
}

/** Silence detector: frames below this clarity are unvoiced. */
export const VOICED_CLARITY_FLOOR = 0.35;
/** Hit window: ±1.5 semitones around the target tube. */
export const PITCH_TOLERANCE_CENTS = 150;
/** YIN absolute threshold on the cumulative-mean normalized difference. */
export const YIN_THRESHOLD = 0.15;

/** MIDI note (fractional) for a frequency in Hz; 0 for non-positive input. */
export function freqToMidiFloat(freqHz: number): number {
  if (!Number.isFinite(freqHz) || freqHz <= 0) {
    return 0;
  }
  return 69 + 12 * Math.log2(freqHz / 440);
}

/** Frequency in Hz for a (fractional) MIDI note. */
export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Octave-agnostic pitch error in cents, folded into [-600, +600).
 * 0 = perfect pitch-class match regardless of octave.
 */
export function foldedCentsError(sungMidi: number, targetMidi: number): number {
  const raw = (sungMidi - targetMidi) * 100;
  return ((((raw + 600) % 1200) + 1200) % 1200) - 600;
}

export interface PitchScore {
  centsOff: number;
  hit: boolean;
  /** 1 at perfect pitch-class match, decaying to 0 at ±600 cents. */
  score: number;
}

/** Score one voiced frame against a target tube (midi 0 = unpitched: skip). */
export function scorePitchFrame(
  sungMidi: number,
  targetMidi: number,
  clarity: number,
): PitchScore {
  if (targetMidi === 0 || clarity < VOICED_CLARITY_FLOOR) {
    return { centsOff: 0, hit: false, score: 0 };
  }
  const centsOff = foldedCentsError(sungMidi, targetMidi);
  const hit = Math.abs(centsOff) <= PITCH_TOLERANCE_CENTS;
  const score = Math.max(0, 1 - Math.abs(centsOff) / 600);
  return { centsOff, hit, score };
}

/**
 * YIN fundamental-frequency estimate for one mono time-domain frame.
 * Returns null when the frame is silent or aperiodic (unvoiced).
 * Deterministic and allocation-light: safe to call per animation frame.
 */
export function detectPitchYin(
  samples: ArrayLike<number>,
  sampleRate: number,
): { frequencyHz: number; clarity: number } | null {
  const n = samples.length;
  if (n < 64 || sampleRate <= 0) {
    return null;
  }
  let energy = 0;
  for (let i = 0; i < n; i += 1) {
    energy += samples[i] * samples[i];
  }
  if (energy < 1e-9) {
    return null;
  }
  // Search 40–1000 Hz: tau in [sampleRate/1000, sampleRate/40].
  const minTau = Math.max(2, Math.floor(sampleRate / 1000));
  const maxTau = Math.min(n >> 1, Math.ceil(sampleRate / 40));
  if (maxTau <= minTau) {
    return null;
  }
  // Difference function + cumulative-mean normalized difference (YIN).
  let runningSum = 0;
  let tauEstimate = -1;
  for (let tau = minTau; tau <= maxTau; tau += 1) {
    let diff = 0;
    for (let i = 0; i + tau < n; i += 1) {
      const d = samples[i] - samples[i + tau];
      diff += d * d;
    }
    runningSum += diff;
    const cmndf =
      runningSum === 0 ? 1 : (diff * tau) / runningSum;
    if (tauEstimate === -1 && cmndf < YIN_THRESHOLD) {
      // First dip below threshold: refine with parabolic interpolation.
      let better = tau;
      if (tau > minTau && tau < maxTau) {
        let prev = 0;
        let next = 0;
        for (let i = 0; i + tau - 1 < n; i += 1) {
          const d = samples[i] - samples[i + tau - 1];
          prev += d * d;
        }
        for (let i = 0; i + tau + 1 < n; i += 1) {
          const d = samples[i] - samples[i + tau + 1];
          next += d * d;
        }
        const denom = prev + next - 2 * diff;
        if (denom !== 0) {
          better = tau + (prev - next) / (2 * denom);
        }
      }
      const clamped = Math.min(Math.max(better, minTau), maxTau);
      const frequencyHz = sampleRate / clamped;
      return { frequencyHz, clarity: Math.min(1, Math.max(0, 1 - cmndf)) };
    }
    if (tau === maxTau && tauEstimate === -1) {
      return null;
    }
  }
  return null;
}

/** Simulated singer: target-locked pitch with vibrato + slow drift. */
export function simulatedReading(
  targetMidi: number,
  timeSec: number,
  detuneCents = 25,
): PitchReading {
  if (targetMidi === 0) {
    return { frequencyHz: 0, midiNote: 0, centsOff: 0, clarity: 0, voiced: false };
  }
  const vibrato = 18 * Math.sin(2 * Math.PI * 5.5 * timeSec);
  const drift = detuneCents * Math.sin(2 * Math.PI * 0.23 * timeSec);
  const sungMidi = targetMidi + (vibrato + drift) / 100;
  const centsOff = foldedCentsError(sungMidi, targetMidi);
  return {
    frequencyHz: midiToFreq(sungMidi),
    midiNote: sungMidi,
    centsOff,
    clarity: 0.92,
    voiced: true,
  };
}

/**
 * Live microphone pitch tracker. Owns getUserMedia + AnalyserNode and polls
 * the time-domain buffer on requestAnimationFrame (~60fps). Readings stay
 * available via `latest`; no React state churn in the hot loop.
 */
export class LivePitchDetector {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private buffer: Float32Array<ArrayBuffer> | null = null;
  private rafId = 0;
  private running = false;
  private targetMidi = 0;
  private reading: PitchReading = {
    frequencyHz: 0,
    midiNote: 0,
    centsOff: 0,
    clarity: 0,
    voiced: false,
  };

  /** Open the mic; rejects when permission is denied or unavailable. */
  async start(audioCtx?: AudioContext): Promise<void> {
    if (this.running) {
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.stream = stream;
    this.ctx =
      audioCtx ??
      new (window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext)();
    const src = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    src.connect(this.analyser);
    this.buffer = new Float32Array(this.analyser.fftSize);
    this.running = true;
    const tick = (): void => {
      if (!this.running || this.analyser === null || this.buffer === null) {
        return;
      }
      this.analyser.getFloatTimeDomainData(this.buffer);
      const est = detectPitchYin(this.buffer, this.ctx?.sampleRate ?? 48000);
      if (est === null) {
        this.reading = {
          frequencyHz: 0,
          midiNote: 0,
          centsOff: 0,
          clarity: 0,
          voiced: false,
        };
      } else {
        const midi = freqToMidiFloat(est.frequencyHz);
        this.reading = {
          frequencyHz: est.frequencyHz,
          midiNote: midi,
          centsOff:
            this.targetMidi === 0
              ? 0
              : foldedCentsError(midi, this.targetMidi),
          clarity: est.clarity,
          voiced: est.clarity >= VOICED_CLARITY_FLOOR,
        };
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  /** Active target tube for per-frame cents-off display. */
  setTarget(midi: number): void {
    this.targetMidi = midi;
  }

  get latest(): PitchReading {
    return this.reading;
  }

  get isRunning(): boolean {
    return this.running;
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.analyser?.disconnect();
    this.analyser = null;
    this.buffer = null;
  }
}
