# Project: Aria — Autonomous Multimodal Rhythm & Choreography Studio
Built for the Meta Global AI Developer Hackathon (Oct 27 – Nov 4, 2026).

## Architecture & Constraints
- Frontend: React + TypeScript + Vite (`frontend/`). Use HTML5 Canvas + Web Audio API for <5ms audio-visual sync.
- Backend: Python 3.11 + FastAPI (`backend/`).
- Audio Pre-processing: Always convert input audio to mono 16-bit PCM WAV (16kHz) via FFmpeg before calling Muse Voice Transcribe.
- Strict Model Routing:
  1. `muse-spark-1.3-contributor` (Meta Model API): Fast agentic tool routing & dev iteration.
  2. `meta-models/muse-spark-open-1026` (Baseten API): Primary note-chart JSON synthesis & pattern generation.
  3. `muse-wonder` (Meta Model API): Verifiable Playability Critic & multi-step orchestration.
  4. `sam-3.1` (Meta Model API): Video motion/dancer segmentation for visual tempo anchoring.
  5. `muse-image` (Meta Model API): Reactive stage backgrounds & song jacket generation.
- Code Style: Strict TypeScript types, Pydantic v2 schemas for all LLM outputs, zero generic UI templates (enforce `/taste` rules).
