# Aria — AI-Powered Rhythm Game & Audio/Visual Charting Studio

> Built for the **Meta Global AI Developer Hackathon** (building period Oct 27 – Nov 4).
> Turn any track into a playable rhythm chart: local DSP finds the beats,
> Meta models hear the vocals and see the motion, an open-weight model drafts the
> chart, and a playability critic fixes it until it's actually fun — and fair — to play.

Aria supports two modes out of the box:

| Mode | Layout | Keys |
|------|--------|------|
| **4-key mania** | 4 lanes | `D` `F` `J` `K` |
| **5-pad Pump** | 5 pads (`Q` / `E` / `S` / `Z` / `C`) | physical receptor layout — left foot `Q`/`Z`, right foot `E`/`C`, either foot `S` (center) |

Plus a **Rock Band-style vocal highway** (Stage 2.5): multi-speaker vocal phrases
with MIDI pitch targets, scored live from your mic (YIN pitch detection) or a
simulated singer — synced to the same `AudioContext.currentTime` master clock as
the pad highway.

---

## Table of contents

- [How it works](#how-it-works)
- [Model routing](#model-routing)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Quickstart](#quickstart)
- [Running the backend](#running-the-backend)
- [Running the frontend](#running-the-frontend)
- [Environment variables](#environment-variables)
- [Using the studio](#using-the-studio)
- [API reference](#api-reference)
- [Playability guarantees](#playability-guarantees)
- [Project structure](#project-structure)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

---

## How it works

```
┌──────────────┐   ┌──────────────────┐   ┌─────────────────────────┐
│  Your audio  │──▶│ 1. LOCAL (free)  │──▶│ 2. MODEL FEATURES       │
│  mp3/wav/webm│   │ FFmpeg → mono    │   │ muse-voice-transcribe   │
└──────────────┘   │ 16-bit PCM WAV   │   │   vocal timestamps +    │
                   │ @ 16 kHz, then   │   │   20+ speaker labels    │
                   │ librosa onsets / │   │ sam-3.1 motion peaks    │
                   │ BPM / F0→MIDI    │   │   from video/webcam     │
                   └──────────────────┘   └────────────┬────────────┘
                                                       ▼
                   ┌──────────────────┐   ┌─────────────────────────┐
                   │ 4. CRITIC LOOP   │◀──│ 3. DRAFT (open-weight)  │
                   │ deterministic    │   │ meta-models/            │
                   │ pre-checks, then │   │ muse-spark-open-1026    │
                   │ Wonder audit,    │   │ (Baseten) → Chart JSON  │
                   │ ≤ 3 retries      │   │                         │
                   └────────┬─────────┘   └─────────────────────────┘
                            ▼
                   ┌──────────────────┐
                   │ PLAYABLE CHART   │──▶ Canvas highway + Web Audio,
                   │ Chart JSON +     │    vocal ribbon, reactive stage
                   │ violation report │    art, telemetry & critic log
                   └──────────────────┘
```

1. **Local deterministic stage (Python, $0).** Every input file is normalized
   with FFmpeg to **mono 16-bit PCM WAV at 16 kHz** (hard precondition), then
   librosa extracts the onset grid, BPM, duration, and a pyin F0→MIDI contour.
2. **Model feature stage.** `muse-voice-transcribe` returns vocal phrase
   timestamps with speaker attribution (`SPEAKER_00`, `SPEAKER_01`, … — duet
   overlap allowed across speakers, never within one). `sam-3.1` segments
   dancer/instrument motion peaks from video frames to anchor visual beat triggers.
3. **Draft stage.** `meta-models/muse-spark-open-1026` (Baseten, open-weight
   bonus track) fuses onsets + vocals + motion peaks into structured Chart JSON.
4. **Critic stage.** Cheap deterministic Python checks run first (exact-ms onset
   snapping, foot-parity transitions, density), then the Critic LLM audits the
   compact violation report + draft and self-corrects — capped at
   **`MAX_CRITIC_RETRIES = 3`** so no track can cause an unbounded token loop.

**Prompt-caching rule:** static JSON schemas + biomechanical grading rules live at
the top of the system prompt; all per-song data (onsets, vocals, motion peaks,
violations) goes in the user message. This maximizes cached input tokens on every
backend LLM call.

---

## Model routing

All Meta Model API calls use the OpenAI-compatible SDK (`base_url`). Baseten is
used only for the open-weight track.

| # | Model ID | Provider | Role |
|---|----------|----------|------|
| 1 | `muse-voice-transcribe` | Meta Model API | Vocal transcription + 20+ speaker diarization (requires the 16 kHz mono WAV precondition) |
| 2 | `sam-3.1` | Meta Model API | Visual/motion tracking: segment dancer/instrument motion peaks via text prompt; anchors visual beat triggers |
| 3 | `meta-models/muse-spark-open-1026` | Baseten API | **Primary chart generator (Open-Weight Bonus Track).** Fuses onset grids + vocals + motion peaks into Chart JSON. Always the `-1026` suffix |
| 4 | `muse-wonder-1.0` | Meta Model API | **Verifiable Playability Critic** (production/demo): audits biomechanics, foot parity, timing drift; forces correction loops |
| 5 | `muse-spark-1.3-contributor` | Meta Model API | Dev/iteration routing. Also the Critic when `ENV=dev` (cost control) |
| 6 | `muse-spark-1.3` | Meta Model API | Production/demo run |
| 7 | `muse-image` | Meta Model API | Reactive stage backgrounds + song jacket art (search-grounded; procedural SVG fallback in `ENV=dev`) |

---

## Features

- **Playable game engine** — HTML5 Canvas highway + Web Audio synth clock with a
  strict **< 5 ms audio-visual sync** budget. Sample charts ship built-in, so the
  game is playable with zero backend calls.
- **4-key mania & 5-pad Pump** — `D F J K` lanes plus `Q / E / S / Z / C` pads
  with strict foot-parity validation on 5-pad (alternate feet, same-foot travel
  ≥ 150 ms, max 2 consecutive same-foot notes).
- **Rock Band vocal highway (Stage 2.5)** — `ChartSchema.vocal_phrases` with
  `text`, `speaker_id`, `start_ms`/`end_ms`, `midi_pitch` (36–84, or `0` =
  unpitched rap/talkie). Live mic scoring via Web Audio YIN detector at 60 fps
  (±1.5-semitone octave-folded window), plus a simulated-singer mode for demos.
- **Multimodal studio (Stage 3)** —
  - **Webcam air-pad + pose Overdrive** (`CamPadOverlay.tsx`, `SIM`/`CAM`/`OFF`
    toggle): SAM 3.1 maps hand/body mass to pads; both hands raised = 2× score Overdrive.
  - **Voice AI Chart Director** (`DirectorPanel.tsx`): speak or type a remix
    command → `Muse Voice Transcribe` → `Muse Spark Open 1026 Remix` →
    `Foot-Parity Validator + Muse Wonder Critic` → verified chart hot-swaps into
    the live engine with a critic diff log.
  - **Reactive stage art** (`POST /stage/generate-art`): `muse-image` jackets +
    beat-reactive backgrounds, procedural cyber-stage SVG fallback in `ENV=dev`.
- **Critic inspector & telemetry** — every generation/validation surfaces the
  violation report, attempts count, and before/after diff log in the UI.

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Python | ≥ 3.11 | Backend + DSP |
| Node.js | ≥ 18 | Frontend (Vite + React 18 + TS) |
| FFmpeg | any recent | **Required.** `ffmpeg` must be on `PATH` — the backend shells out to it for the 16 kHz mono normalization precondition |
| API keys | — | `META_API_KEY`, `BASETEN_API_KEY` for live model calls. **Not needed for local dev:** `ENV=dev` without keys uses deterministic mocks + offline fallbacks |

---

## Quickstart

```bash
# 1. Clone and enter the repo
git clone <your-fork-url> metaAria
cd metaAria

# 2. Backend — terminal 1
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
ENV=dev uvicorn app.main:app --host 127.0.0.1 --port 8000

# 3. Frontend — terminal 2 (repo root)
cd frontend
npm install
npm run dev
```

Then open **http://localhost:5173** in a browser. The game plays immediately
with built-in sample charts; with the backend running on `:8000`, validation,
generation, Director remixes, SAM air-pad, and stage art light up via the Vite
dev proxy (no CORS setup needed).

> `ENV=dev` without API keys runs everything on deterministic mocks — full UI,
> critic loop, and stage art work offline. Set real keys (see below) for live
> model calls.

---

## Running the backend

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate   # once
pip install -e ".[dev]"                              # once (includes pytest + httpx)

# Dev (mocked LLMs, $0 cost — recommended for iteration)
ENV=dev uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload

# Production/demo (live Muse Wonder critic + Baseten draft model)
ENV=prod META_API_KEY=... BASETEN_API_KEY=... \
  uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Health check: `curl http://127.0.0.1:8000/health` → `{"status":"ok",...}`.

**Full chart generation** from an audio file (runs the whole pipeline):

```bash
curl -X POST http://127.0.0.1:8000/charts/generate \
  -H 'Content-Type: application/json' \
  -d '{"audio_path": "/absolute/path/to/song.mp3", "mode": "pump-5pad", "title": "My Song"}'
```

`audio_path` must be readable by the server process; any FFmpeg-decodable format
works (mp3/wav/webm/ogg) — it's normalized to 16 kHz mono WAV server-side.
`mode` is `mania-4k` or `pump-5pad`.

---

## Running the frontend

```bash
cd frontend
npm install     # once
npm run dev     # dev server on http://localhost:5173 (proxies /charts /vision /director /stage → :8000)
```

| Script | What it does |
|--------|--------------|
| `npm run dev` | Vite dev server + API proxy to the backend |
| `npm run build` | `tsc --noEmit && vite build` → static bundle in `frontend/dist/` |
| `npm run preview` | Serve the production bundle locally |
| `npm run test` | Vitest suite (engine judgments, vocals, Stage 3 panels) |
| `npm run typecheck` | Strict TypeScript check, no emit |

---

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ENV` | `dev` | `dev` → `muse-spark-1.3-contributor` critic + mocks/fallbacks, zero model spend. Anything else → `muse-wonder-1.0` critic + live calls |
| `META_API_KEY` | — | Meta Model API key (`muse-voice-transcribe`, `sam-3.1`, critic, `muse-image`). Absent in `dev` → deterministic mocks |
| `BASETEN_API_KEY` | — | Baseten key for `meta-models/muse-spark-open-1026` draft generation. Absent in `dev` → offline draft fallback |
| `META_API_BASE_URL` | `https://api.meta-model.example/v1` | Override for the Meta OpenAI-compatible endpoint |
| `BASETEN_API_BASE_URL` | `https://api.baseten.example/v1` | Override for the Baseten OpenAI-compatible endpoint |

Never commit real keys — `.env` is git-ignored.

---

## Using the studio

1. **Pick a chart** — the chart library ships `pump-5pad`, `mania-4k`, and a
   `broken` demo (deliberate parity violations so you can watch the critic catch them).
2. **Play** — press `Space`/▶ to start. Hit `D F J K` (mania) or `Q E S Z C`
   (pump) as notes cross the receptors. Speed multiplier and mute are on the panel.
3. **Validate** — `Validate` sends the active chart + onset grid to
   `POST /charts/validate`; the CriticInspector shows pass/fail + violations.
4. **Sing** — vocal ribbon mode `sim` (demo singer) / `mic` (your microphone via
   the YIN detector) / `off`. Mic needs a mic-permission grant; scores flat when
   the phrase is unpitched (`midi_pitch: 0`).
5. **Direct** — in DirectorPanel, record or type a command like
   *"make the chorus denser but keep the feet fair"* → the remix pipeline returns
   a verified chart + diff log and hot-swaps it into the engine.
6. **Move** — CamPadOverlay `SIM` replays scripted motion; `CAM` uses your webcam
   frame + SAM 3.1 hit zones as air-pads (raise both hands for Overdrive 2×).
7. **Stage art** — generate a jacket + beat-reactive background per song
   (`muse-image`, or instant procedural SVG in `dev`).

---

## API reference

Base URL (dev): `http://127.0.0.1:8000`. All bodies/returns are JSON with
Pydantic v2 schemas.

| Method & path | Input | Output |
|---------------|-------|--------|
| `GET /health` | — | `{status, max_critic_retries}` |
| `POST /charts/validate` | `{chart: ChartSchema, onset_times_ms: int[]}` | `CriticReportSchema` (pass/fail + violations) |
| `POST /charts/generate` | `{audio_path, mode: mania-4k\|pump-5pad, title}` | `{chart, report, attempts, bpm}` — full DSP→vocals→draft→critic pipeline |
| `POST /vision/sam-segment` | `{image_b64, prompt?, mode}` | `{boxes, masks, hit_zones, overdrive_active, mock, model}` |
| `POST /director/upload-audio` | multipart mic blob | `{audio_path}` server-side path for the remix call |
| `POST /director/voice-remix` | `{chart, command_text? \| audio_path?, onset_times_ms}` | `{chart, report, attempts, command, diff_log}` |
| `POST /stage/generate-art` | `{title, style_prompt?, seed?}` | `{jacket_svg, background_svg, palette}` |

Chart JSON shape (abridged):

```jsonc
{
  "mode": "pump-5pad", "title": "Hold On", "bpm": 128.0,
  "offset_ms": 0, "duration_ms": 210000,
  "notes": [{ "time_ms": 8000, "pad": "S", "lane": null, "kind": "hold", "duration_ms": 1000 }],
  "vocal_phrases": [{ "text": "Hold on", "speaker_id": "SPEAKER_00",
                      "start_ms": 8000, "end_ms": 9500, "midi_pitch": 67 }]
}
```

Rules: mania uses `lane` 0–3 with `pad: null`; pump uses `pad` Q/E/S/Z/C with
`lane: null`; notes sorted by `time_ms`; phrases sorted, non-overlapping per
speaker (cross-speaker overlap = duet, allowed).

---

## Playability guarantees

Every chart — human- or model-made — must pass three checks, enforced first by
deterministic Python (`backend/app/validator.py` + `critic.py`) and then by the
Critic LLM:

1. **Timing drift** — every note snaps within **±15 ms** of a detected onset.
2. **Foot parity** — strict on 5-pad: alternate feet, ≤ 2 consecutive same-foot
   notes, same foot needs ≥ 150 ms to travel between distinct pads.
3. **Density** — max 10 notes per rolling 1000 ms window (biomechanical cap).

The critic loop is capped at `MAX_CRITIC_RETRIES = 3` per generation — an
edge-case track can never spin an unbounded token loop.

---

## Project structure

```
metaAria/
├── AGENTS.md                  # authoritative agent/architecture contract (model IDs, data-flow, rules)
├── backend/
│   ├── app/
│   │   ├── main.py            # FastAPI surface: /charts /vision /director /stage
│   │   ├── dsp.py             # librosa onset/BPM grid + pyin F0→MIDI contour
│   │   ├── audio.py           # FFmpeg → mono 16-bit PCM WAV @ 16 kHz precondition
│   │   ├── schemas.py         # Pydantic v2: ChartSchema, vocal phrases, critic reports
│   │   ├── validator.py       # deterministic snap/parity/density checks
│   │   ├── critic.py          # critic loop (≤ 3 retries) + diff log
│   │   └── llm.py             # prompt-cached routers: voice/SAM/draft/critic/image
│   ├── tests/                 # pipeline contracts, schemas, validator, vocals, Stage 3
│   └── pyproject.toml         # aria-backend (fastapi, uvicorn, librosa, openai, …)
└── frontend/
    ├── src/
    │   ├── App.tsx            # studio shell: chart lib, transport, mic wiring
    │   ├── api.ts             # fetch wrappers over the FastAPI backend
    │   ├── footpath.ts        # onset grid helpers
    │   ├── components/        # HighwayCanvas, VocalHighway, CamPadOverlay,
    │   │                      # DirectorPanel, ChartPanel, CriticInspector, TelemetryPanel
    │   ├── engine/            # clock, judgments, input, renderer, synth, pitchDetector
    │   └── types/chart.ts     # Chart / CriticReport TS types
    ├── index.html
    ├── vite.config.ts         # dev proxy: /charts /vision /director /stage → :8000
    └── package.json
```

---

## Testing

```bash
# Backend (from backend/, venv active)
pytest -q

# Frontend (from frontend/)
npm run test        # vitest run
npm run typecheck   # tsc --noEmit
```

Backend tests cover pipeline contracts, Pydantic schemas, the foot-parity /
snap / density validator, vocal phrase alignment, and Stage 3 routes. Frontend
tests cover hit judgments, YIN pitch detection, and Stage 3 panels. In `ENV=dev`
with no keys set, the whole suite runs offline against deterministic mocks.

---

## Troubleshooting

| Symptom | Likely cause & fix |
|---------|--------------------|
| Frontend: `… -> 404 (backend unreachable or not FastAPI — is it running on :8000?)` | Backend isn't up. Start it: `cd backend && ENV=dev uvicorn app.main:app --port 8000` |
| `ffmpeg binary not found on PATH` | Install FFmpeg (`brew install ffmpeg`, `apt install ffmpeg`, …) and retry |
| `POST /charts/generate → 400` | `audio_path` unreadable by the server, or undecodable audio. Use an absolute path to an mp3/wav/webm |
| Mic scores nothing / `mic` permission error | Grant mic permission in the browser; check the mic-error line in the vocal panel. Use `sim` mode for keyless demos |
| Webcam overlay stays dark | Grant camera permission, or switch to `SIM` mode for scripted motion |
| Empty transcription → `400 empty transcription` | The mic clip had no speech, or (dev) the mock path was bypassed — retry with `command_text` instead of audio |
| Slow generation / high token use | Expected on long tracks with live models; `ENV=dev` mocks the LLMs for instant offline iteration |

---

*Contract source of truth: [AGENTS.md](./AGENTS.md) — model IDs, chart data-flow,
prompt-caching rule, and playability safeguards.*
