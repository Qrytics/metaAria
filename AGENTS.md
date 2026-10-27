# AGENTS.md — Aria (Final)

> Status: **Final** — accepted by the user 2026-10-26 in grill interview.
> Single authoritative agent-instruction file for this repo. `MUSE.md` was consolidated
> into this file and removed to avoid duplicate context burning input tokens.

## 0. Project identity

- **Aria**: AI-powered Rhythm Game & Audio/Visual Charting Studio.
- Modes in scope: **4-key mania** and **5-pad Pump It Up (Q/E/S/Z/C)**.
- Built for the Meta Global AI Developer Hackathon (building period Oct 27 – Nov 4).
  Oct 26 is prep day: instructions and architecture planning only.

## 1. Tech stack (mandatory)

- Frontend: React + TypeScript + Vite (`frontend/`). HTML5 Canvas + Web Audio API.
  Strict **<5ms audio-visual sync**. Zero generic AI UI templates.
- Backend: Python 3.11 + FastAPI + librosa/FFmpeg (`backend/`). Local deterministic
  onset/BPM detection. **Pydantic v2 schemas for all LLM outputs.**
- Audio pre-processing (hard precondition): always convert input audio via FFmpeg to
  **mono 16-bit PCM WAV at 16kHz** before calling `muse-voice-transcribe`.
- Code style: strict TypeScript types; no unrequested scaffolding, controls, or panels.

## 2. Model routing (mandatory — exact IDs)

All Meta Model API calls use the OpenAI-compatible SDK (`base_url`). Baseten is used
only for the open-weight track.

| # | Model ID | Provider | Role |
|---|----------|----------|------|
| 1 | `muse-voice-transcribe` | Meta Model API | Audio/lyrics transcription (vocal phrase timestamps). Requires the 16kHz mono 16-bit PCM WAV precondition. |
| 2 | `sam-3.1` | Meta Model API | Visual/motion tracking: segment dancer/instrument motion peaks from video clips via text prompt; anchors visual beat triggers. |
| 3 | `meta-models/muse-spark-open-1026` | Baseten API | **Primary chart generator (Open-Weight Bonus Track).** Takes local librosa onset grids + vocal timestamps + SAM 3.1 motion peaks; outputs structured JSON note charts. MUST use the `-1026` suffix; never `meta-models/muse-spark-open`. |
| 4 | `muse-wonder-1.0` | Meta Model API | **Verifiable Playability Critic** (production/demo): audits draft JSON charts for biomechanical playability, foot parity on 5-pad, and timing drift; forces self-correction loops. |
| 5 | `muse-spark-1.3-contributor` | Meta Model API | Dev/iteration agentic routing. Also serves as the Critic when `ENV=dev` (cost control). |
| 6 | `muse-spark-1.3` | Meta Model API | Production/demo run. |
| 7 | `muse-image` | Meta Model API | Reactive stage backgrounds and song jacket art (search-grounded). |

## 3. Chart data-flow (mandatory)

1. Local deterministic stage (Python): librosa onset/BPM grids + FFmpeg-normalized audio.
2. Model feature stage: `muse-voice-transcribe` vocal timestamps + `sam-3.1` motion peaks.
3. Draft stage: `meta-models/muse-spark-open-1026` (Baseten) synthesizes structured JSON charts.
4. Critic stage: deterministic Python pre-checks first (see §5), then the Critic LLM audits
   and forces corrections until pass or retry cap.

## 4. Prompt-caching rule (MANDATORY for all backend LLM calls)

- Static JSON schemas and biomechanical grading rules go strictly at the **top of the
  system prompt**. Zero dynamic timestamps or per-song data in the system prompt.
- All dynamic song data — onset grids, vocal timestamps, motion peaks, violation
  reports — goes strictly in the **user message**, to maximize cached input tokens.

## 5. Playability checks and cost-control safeguards (mandatory)

- Every chart (4-key and 5-pad) must pass: **foot-parity** (strict on 5-pad Q/E/S/Z/C),
  **timing-drift**, and **biomechanical playability** checks.
- Pre-compute deterministic math checks in Python first and pass the compact violation
  report + draft JSON to the Critic, so the Critic LLM spends minimal output tokens
  diagnosing and fixing:
  - exact millisecond onset snapping within **±15ms**;
  - basic foot-parity state transitions.
- Cap the critic self-correction loop at a strict maximum of **`MAX_CRITIC_RETRIES = 3`**
  per chart generation, so an edge-case track can never cause an unbounded token loop.
- Critic selection: `muse-wonder-1.0` by default; `muse-spark-1.3-contributor` when
  `ENV=dev`.

## 6. Scope notes

- This document governs agent behavior for the hackathon build. Later stages
  (scaffolding, pipeline, client) are deferred proposals — each needs its own approval.
- **Stage 2.5 — Rock Band Multi-Speaker Vocal & Live Mic Pitch Scoring Layer
  (in scope):** `ChartSchema.vocal_phrases` (text, `speaker_id` e.g.
  `SPEAKER_00`/`SPEAKER_01` from `muse-voice-transcribe` 20+ speaker
  attribution, `start_ms`/`end_ms`, `midi_pitch` 36–84 or 0 = unpitched);
  librosa.pyin F0→MIDI contour aligned to phrase timestamps; per-speaker
  non-overlap validation; Web Audio YIN pitch detector (60fps, ±1.5-semitone
  octave-folded scoring, simulated-singer mode); Rock Band vocal ribbon synced
  to the shared `AudioContext.currentTime` master clock.
- **Stage 3 — Multimodal Studio (active):** SAM 3.1 webcam air-pad + pose
  Overdrive (`POST /vision/sam-segment`, `CamPadOverlay.tsx` with `SIM/CAM/OFF`
  toggle), Voice AI Chart Director (`POST /director/voice-remix`,
  `DirectorPanel.tsx` with the `Muse Voice Transcribe` -> `Muse Spark Open 1026
  Remix` -> `Foot-Parity Validator + Muse Wonder Critic` -> `Muse Image Stage
  Art` pipeline), and Muse Image reactive stage (`POST /stage/generate-art`,
  procedural SVG/cyber-stage fallback in `ENV=dev`). Remixed charts hot-swap
  into the live game engine with the verified chart + critic diff log.
- **Stage 4 — Studio & Sharing (deferred proposal):** chart studio editor and
  export/share flows.
- Interview provenance: target record (root `AGENTS.md`, Option A), docs-only turn with
  no runtime code/commits (Option A), canonical IDs, mandatory caching rule (Option A),
  Q1 game modes accepted as recommended, Q2 data-flow accepted with the two safeguards
  above, Q3 full-contract acceptance — all settled 2026-10-26.
