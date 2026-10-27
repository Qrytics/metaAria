/**
 * Sample charts: one per mode plus one intentionally broken pump chart.
 *
 * The broken chart (`pumpBrokenQZ`) steps Q -> Z 100ms apart. Both pads sit
 * under the LEFT foot and the hop is faster than the validator's
 * MIN_FOOT_SHIFT_MS (150ms), so `check_parity` flags it — exactly the
 * Q->Z parity violation the Critic demo needs.
 */
import type {
  Chart,
  ChartNote,
  ManiaLane,
  PumpPad,
  VocalPhrase,
} from "../types/chart";

function tap4(time_ms: number, lane: ManiaLane): ChartNote {
  return { time_ms, lane, pad: null, kind: "tap", duration_ms: 0 };
}

function tap5(time_ms: number, pad: PumpPad): ChartNote {
  return { time_ms, lane: null, pad, kind: "tap", duration_ms: 0 };
}

/**
 * Offline duet vocal track (Stage 2.5): SPEAKER_00 leads, SPEAKER_01
 * answers, and both overlap at 8000–9000ms for the harmony chorus.
 * MIDI 0 marks the unpitched talkie break.
 */
export const duetVocals: VocalPhrase[] = [
  { text: "Oh oh", speaker_id: "SPEAKER_00", start_ms: 0, end_ms: 900, midi_pitch: 60 },
  { text: "Yeah yeah", speaker_id: "SPEAKER_01", start_ms: 1000, end_ms: 1900, midi_pitch: 65 },
  { text: "Feel the beat", speaker_id: "SPEAKER_00", start_ms: 2000, end_ms: 3400, midi_pitch: 64 },
  { text: "Move your feet", speaker_id: "SPEAKER_01", start_ms: 4000, end_ms: 5400, midi_pitch: 69 },
  { text: "Call", speaker_id: "SPEAKER_00", start_ms: 6000, end_ms: 6900, midi_pitch: 67 },
  { text: "Response", speaker_id: "SPEAKER_01", start_ms: 7000, end_ms: 7900, midi_pitch: 71 },
  { text: "Hold on", speaker_id: "SPEAKER_00", start_ms: 8000, end_ms: 9500, midi_pitch: 67 },
  { text: "Hold on", speaker_id: "SPEAKER_01", start_ms: 8000, end_ms: 9500, midi_pitch: 72 },
  { text: "Break it down", speaker_id: "SPEAKER_00", start_ms: 10000, end_ms: 11400, midi_pitch: 0 },
  { text: "Lift it up", speaker_id: "SPEAKER_01", start_ms: 12000, end_ms: 13400, midi_pitch: 72 },
  { text: "Sing it out", speaker_id: "SPEAKER_00", start_ms: 14000, end_ms: 15500, midi_pitch: 69 },
];

/** 8 bars of quarter notes at 120bpm, cycling lanes, with one hold. */
export const maniaSample: Chart = {
  mode: "mania-4k",
  title: "Synth Groove (4K sample)",
  bpm: 120,
  offset_ms: 0,
  duration_ms: 16_000,
  vocal_phrases: duetVocals,
  notes: [
    tap4(0, 0),
    tap4(500, 1),
    tap4(1000, 2),
    tap4(1500, 3),
    tap4(2000, 3),
    tap4(2500, 2),
    tap4(3000, 1),
    tap4(3500, 0),
    tap4(4000, 0),
    tap4(4500, 2),
    tap4(5000, 1),
    tap4(5500, 3),
    tap4(6000, 2),
    tap4(6500, 0),
    tap4(7000, 3),
    tap4(7500, 1),
    { time_ms: 8000, lane: 1, pad: null, kind: "hold", duration_ms: 1000 },
    tap4(9500, 2),
    tap4(10000, 0),
    tap4(10500, 3),
    tap4(11000, 1),
    tap4(11500, 2),
    tap4(12000, 3),
    tap4(12500, 0),
    tap4(13000, 1),
    tap4(13500, 2),
    tap4(14000, 0),
    tap4(14500, 3),
    tap4(15000, 1),
    tap4(15500, 2),
  ],
};

/** Alternating-feet pump pattern with a center hold. Feet: L R L R ... */
export const pumpSample: Chart = {
  mode: "pump-5pad",
  title: "Synth Groove (5-pad sample)",
  bpm: 120,
  offset_ms: 0,
  duration_ms: 16_000,
  vocal_phrases: duetVocals,
  notes: [
    tap5(0, "Q"),
    tap5(500, "E"),
    tap5(1000, "Z"),
    tap5(1500, "C"),
    tap5(2000, "Q"),
    tap5(2500, "E"),
    tap5(3000, "S"),
    tap5(3500, "E"),
    tap5(4000, "Z"),
    tap5(4500, "C"),
    tap5(5000, "Q"),
    tap5(5500, "C"),
    tap5(6000, "Z"),
    tap5(6500, "E"),
    tap5(7000, "S"),
    tap5(7500, "Q"),
    { time_ms: 8000, lane: null, pad: "S", kind: "hold", duration_ms: 1000 },
    tap5(9500, "E"),
    tap5(10000, "Q"),
    tap5(10500, "C"),
    tap5(11000, "Z"),
    tap5(11500, "E"),
    tap5(12000, "Q"),
    tap5(12500, "E"),
    tap5(13000, "Z"),
    tap5(13500, "C"),
    tap5(14000, "S"),
    tap5(14500, "E"),
    tap5(15000, "Q"),
    tap5(15500, "C"),
  ],
};

/**
 * Intentionally broken: Q -> Z in 100ms. Same LEFT foot must travel two
 * pads apart (dist 2.0) in under MIN_FOOT_SHIFT_MS (150ms) — a strict
 * foot-parity violation on 5-pad.
 */
export const pumpBrokenQZ: Chart = {
  mode: "pump-5pad",
  title: "Broken Q->Z parity demo",
  bpm: 120,
  offset_ms: 0,
  duration_ms: 4000,
  notes: [
    tap5(0, "Q"),
    tap5(500, "E"),
    tap5(1000, "S"),
    tap5(1500, "C"),
    tap5(2000, "Q"),
    tap5(2100, "Z"),
    tap5(2600, "E"),
    tap5(3100, "S"),
  ],
};

export const sampleCharts: Record<string, Chart> = {
  "mania-4k": maniaSample,
  "pump-5pad": pumpSample,
  broken: pumpBrokenQZ,
};
