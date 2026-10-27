/**
 * Procedural Web Audio synth demo track (no audio assets).
 *
 * Schedules kick/hat/bass/lead blips on the audio clock and returns the
 * onset grid (kick + lead accents) so sample charts can snap to it.
 */
export interface DemoTrack {
  onsetsMs: number[];
  durationMs: number;
  stop: () => void;
}

function blip(
  ctx: AudioContext,
  dest: AudioNode,
  atTime: number,
  freqHz: number,
  durSec: number,
  type: OscillatorType,
  gain: number,
): AudioScheduledSourceNode {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freqHz, atTime);
  g.gain.setValueAtTime(gain, atTime);
  g.gain.exponentialRampToValueAtTime(0.0001, atTime + durSec);
  osc.connect(g);
  g.connect(dest);
  osc.start(atTime);
  osc.stop(atTime + durSec + 0.02);
  return osc;
}

function noiseHat(ctx: AudioContext, dest: AudioNode, atTime: number, gain: number): void {
  const len = Math.floor(ctx.sampleRate * 0.05);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i += 1) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, atTime);
  src.connect(g);
  g.connect(dest);
  src.start(atTime);
}

const LEAD_SCALE = [0, 3, 5, 7, 10, 12, 15, 12, 10, 7, 5, 3];

/**
 * Schedule a looping demo groove; returns onset grid + stop handle.
 * When `vocals` phrases are given, their pitched melodies play back as soft
 * sine leads from the same `t0` anchor, so the vocal ribbon demo works fully
 * offline with zero extra clock plumbing.
 */
export function playDemoTrack(
  ctx: AudioContext,
  bpm = 120,
  bars = 8,
  dest?: AudioNode,
  vocals: { start_ms: number; end_ms: number; midi_pitch: number }[] = [],
): DemoTrack {
  const out: AudioNode = dest ?? ctx.destination;
  const beatSec = 60 / bpm;
  const beatMs = beatSec * 1000;
  const totalBeats = bars * 4;
  const durationMs = totalBeats * beatMs;
  const t0 = ctx.currentTime + 0.06;

  const onsetsMs: number[] = [];
  const scheduled: AudioScheduledSourceNode[] = [];

  for (let b = 0; b < totalBeats; b += 1) {
    const t = t0 + b * beatSec;
    const tMs = Math.round((t - t0) * 1000);
    const barPos = b % 4;
    // Kick on every beat; lead accent on off-beats.
    scheduled.push(blip(ctx, out, t, barPos === 0 ? 150 : 120, 0.18, "sine", 0.5));
    noiseHat(ctx, out, t + beatSec / 2, 0.12);
    const semitone = LEAD_SCALE[b % LEAD_SCALE.length];
    const freq = 440 * Math.pow(2, semitone / 12);
    scheduled.push(blip(ctx, out, t + beatSec / 2, freq, 0.22, "square", 0.08));
    onsetsMs.push(tMs, Math.round(tMs + beatMs / 2));
  }
  // Closing downbeat.
  scheduled.push(
    blip(ctx, out, t0 + totalBeats * beatSec, 150, 0.3, "sine", 0.5),
  );
  // Duet vocal melody playback (Stage 2.5): one soft sine lead per pitched
  // phrase, anchored to the same t0 so tubes and audio agree to the sample.
  for (const v of vocals) {
    if (v.midi_pitch <= 0 || v.end_ms <= v.start_ms) {
      continue;
    }
    const freq = 440 * Math.pow(2, (v.midi_pitch - 69) / 12);
    const at = t0 + v.start_ms / 1000;
    const dur = (v.end_ms - v.start_ms) / 1000;
    scheduled.push(blip(ctx, out, at, freq, dur, "sine", 0.06));
    scheduled.push(blip(ctx, out, at, freq * 2, dur, "triangle", 0.02));
  }

  return {
    onsetsMs,
    durationMs,
    stop: () => {
      for (const n of scheduled) {
        try {
          n.stop();
        } catch {
          // Already stopped; ignore.
        }
      }
    },
  };
}
