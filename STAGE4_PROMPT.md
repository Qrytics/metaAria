You are helping with Aria, an AI-powered rhythm game + audio/visual charting
studio (repo: metaAria). Read this whole prompt before answering. For this
first reply, do NOT write code — critique the idea, sharpen the scope, and
propose a build plan. We will approve the plan before any implementation.

## What Aria is today

- Frontend: React + TypeScript + Vite (`frontend/`). HTML5 Canvas highway +
  Web Audio. Two modes: 4-key mania (D/F/J/K) and 5-pad Pump (Q/E/S/Z/C).
- Backend: Python 3.11 + FastAPI + librosa (`backend/`). Local onset/BPM DSP,
  foot-parity validator, critic loop capped at `MAX_CRITIC_RETRIES = 3`.
- Pipeline (frozen — do not redesign): DSP grids -> `muse-voice-transcribe`
  vocal timestamps + `sam-3.1` motion peaks -> `meta-models/muse-spark-open-1026`
  draft chart -> deterministic pre-checks -> critic LLM fixes till pass/cap.
- Stage 3 (just shipped): webcam air-pad with continuous local motion
  tracking + hold-to-arm Overdrive, Voice AI Director remix panel, Muse
  Image reactive stage art. Studio runs offline free with `ENV=dev` mocks.

## The idea to evaluate: Stage 4 — Chart Studio & Sharing

The charts are currently read-only (generated, then played). Stage 4 makes
them editable and portable:

1. In-browser note editor on the existing highway canvas: click empty lane
   to add a note, drag notes to retime, right-click/Delete to remove, all
   snapped to the onset grid (±15ms, the same tolerance the validator uses).
2. Edit tools: quantize selection to grid, halve/double density, mirror
   patterns (L/R swap with foot-parity re-check), undo/redo (Ctrl+Z/Y).
3. One-click Validate against the existing `/charts/validate` endpoint with
   inline violation markers on the notes themselves (not just a log panel).
4. Persistence: autosave work-in-progress to localStorage per song; explicit
   Save/Discard.
5. Portable song packs: export chart JSON + audio reference + vocal phrases
   as one `.aria.json` file; import it back via drag-drop. Share = send the
   file (no accounts, no server storage in this stage).
6. Results screen upgrade: grade (SSS–F), accuracy %, max combo, per-pad
   hit breakdown — the data already exists in the engine snapshot.

Non-goals for this stage: user accounts, cloud storage, multiplayer,
audio waveform editing, new game modes, touching the generation pipeline.

## How to judge and shape it

- Tell me what is overscoped or underscoped for one hackathon build week.
- Cut or defer anything with a cheaper version that still feels like a
  studio. Propose the smallest cut that keeps "edit, validate, share."
- Flag anything that risks the <5ms audio-visual sync contract or the
  existing engine judgment windows.
- Suggest what to user-test first (I have a MacBook webcam + mic, no external
  controllers).

## UI direction (hard constraints, not suggestions)

The studio already has a look — hardware-DAW + arcade cabinet — defined in
`frontend/src/studio.css` (dark chassis `#0d1119`, phosphor mono type,
amber `#ffb000` accents, cyan `#22d3ee` / orange `#fb923c` foot colors,
square corners everywhere: `border-radius: 0`). Extend that language; do
not redecorate. Specifically, do NOT use any of these:

- purple/indigo gradients, `bg-clip-text` gradient headlines, cream page
  backgrounds, aurora blobs or glow-everywhere shadows, Inter-everywhere
  typography, gray placeholder body text, all-caps kickers over centered
  hero layouts, 3-card feature grids, bento grids, `rounded-2xl` uniformity,
  glassmorphism, `hover:scale-105` card lifts, emoji-as-icons, left-border
  accent cards, cards nested in cards, scroll-triggered fade-ups, motion
  that ignores `prefers-reduced-motion`.

The editor must look like bench equipment: dense, labeled, keyboard-first
(shortcuts listed on the panel), every control reachable without a mouse
where it matters mid-song (Space, arrows, Delete, Q–C).

## Contracts your plan must respect

- Backend generation pipeline, model IDs, and the prompt-caching rule (static
  schemas top of system prompt, song data in the user message only) stay as
  specified in `AGENTS.md`. This stage adds at most one small export/import
  endpoint — prefer pure-frontend file handling.
- The validator is the source of truth: the editor must surface its exact
  violation types (timing drift, foot parity, biomechanical flags), never
  invent new severity labels.
- `ENV=dev` must keep working fully offline with $0 cost; no new required
  API keys or network calls in the play/edit path.
- Verification gates: `python -m pytest -q` (backend), `npm run test` and
  `npm run typecheck` (frontend), plus new checklist lines in `TESTING.md`.
- Do not commit or push; leave the tree reviewable.

## Your reply format

1. Verdict on the idea (2–3 sentences) + the one riskiest assumption.
2. Scoped plan: numbered build order, each step with its visible result and
   how we verify it (command or manual check).
3. Open questions for me (max 3, each with your recommendation).
4. What you would cut if we only get half the time.
