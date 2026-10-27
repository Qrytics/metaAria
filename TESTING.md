# Aria — Full Test Checklist

> Goal: prove everything works before building more.
> Run top to bottom. Stop and fix red before moving on.
> All commands assume the repo root (`metaAria/`).

Base contract: backend on `http://127.0.0.1:8000`, frontend on
`http://localhost:5173`, `ENV=dev` (mocked LLMs, $0 cost, works offline).

---

## 0. Prerequisites

- [ ] Python ≥ 3.11: `python3 --version`
- [ ] Node ≥ 18: `node --version`
- [ ] FFmpeg on PATH (backend shells out to it): `ffmpeg -version`
- [ ] No keys needed. Do **not** set `META_API_KEY` / `BASETEN_API_KEY` for this pass.

---

## 1. Start both servers

Terminal 1 — backend:

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate   # first time only
pip install -e ".[dev]"                               # first time only
ENV=dev uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Terminal 2 — frontend (repo root):

```bash
cd frontend
npm install   # first time only
npm run dev
```

- [ ] Backend log shows startup with no traceback.
- [ ] `http://localhost:5173` loads and shows **ARIA CHARTING STUDIO**.

---

## 2. Automated checks (must all be green)

Backend (from `backend/`, venv active, `ENV=dev`):

```bash
python -m pytest -q
```

- [ ] All tests pass (covers DSP/FFmpeg precondition, schemas, validator,
      vocals, pipeline prompt-caching/model-ID contracts, Stage 3 endpoints).

Frontend (from `frontend/`):

```bash
npm run test       # vitest: judgments, vocals, Stage 3 panels, Stage 4 studio
npm run typecheck  # strict tsc --noEmit
```

- [ ] `npm run test` — all suites pass.
- [ ] `npm run typecheck` — zero errors.

Optional production-bundle check (from `frontend/`):

```bash
npm run build
npm run preview
```

- [ ] Build succeeds; preview serves the bundle.

---

## 3. Backend API checks (curl)

Health:

```bash
curl http://127.0.0.1:8000/health
```

- [ ] Returns `{"status":"ok",...}`.

Validate (deterministic pre-checks + dev critic, no audio needed):

```bash
curl -X POST http://127.0.0.1:8000/charts/validate \
  -H 'Content-Type: application/json' \
  -d '{"chart": {"title":"smoke","mode":"pump-5pad","bpm":128,"duration_ms":8000,"notes":[{"time_ms":1000,"pad":"Q"},{"time_ms":1500,"pad":"E"}]},"onset_times_ms":[1000,1500]}'
```

- [ ] Returns a critic report JSON (pass/fail + violations list).

Full generation from a real file (any FFmpeg-decodable mp3/wav/webm/ogg):

```bash
curl -X POST http://127.0.0.1:8000/charts/generate \
  -H 'Content-Type: application/json' \
  -d '{"audio_path": "/absolute/path/to/song.mp3", "mode": "pump-5pad", "title": "My Song"}'
```

- [ ] Returns `chart` + `report` + `attempts` + `bpm`.
- [ ] `attempts` stays within the retry cap (`MAX_CRITIC_RETRIES = 3`).

Remaining endpoints (all mocked in `dev`, all should return JSON, none should 500):

- [ ] `POST /director/voice-remix` with `{"chart": <chart JSON>, "command_text": "make it denser", "onset_times_ms": []}` returns a remixed chart + report.
- [ ] `POST /vision/sam-segment` with `{"mode":"pose"}` returns boxes/masks/hit-zones.
- [ ] `POST /stage/generate-art` with `{"title":"smoke","bpm":128}` returns procedural SVG in `dev`.
- [ ] `POST /director/upload-audio` accepts a multipart audio blob and returns `audio_path`.

---

## 4. Frontend manual checks (http://localhost:5173)

Play:

- [ ] Library loads `pump-5pad` by default. Press play — notes fall, receptors flash, verdict strip updates.
- [ ] Switch to `mania-4k`. Hit `D F J K` as notes cross the receptors.
- [ ] Back on pump, hit `Q E S Z C`. Try `Space` to start/stop, speed multiplier, mute.
- [ ] Finish (or press `RESULTS [TAB]`) — bench readout shows grade, accuracy, max combo, vocal %, per-key P/G/g/M. `PLAY AGAIN` replays.

Chart Studio (paused only — editor is dead during PLAY):

- [ ] Press `EDIT [F2]` — highway gains the amber dashed frame + `EDIT @ ms`. Keys do nothing while playing.
- [ ] `Up/Down` scrubs the grid (`Shift` = 4x), wheel works on the canvas. Cursor readout tracks `idx/total · ms`.
- [ ] `D/F/J/K` or `Q/E/S/Z/C` (or clicking a lane) toggles a note at the cursor line; toggle again removes it.
- [ ] `M` mirrors sides, `H`/`2` halve/double density, `Ctrl+Z`/`Ctrl+Y` undo/redo.
- [ ] Load `broken`, EDIT, `VALIDATE [V]` — hazard brackets + tags (e.g. `PARITY…`) pin to the offending notes; clicking a marker badge jumps the cursor there.
- [ ] `CRITIC REPAIR [R]` remixes via the fix command and shows the CRITIC DIFF log; markers rebuild on the repaired chart.
- [ ] Edit, reload the page, reload the chart — edits persist (autosave). `REVERT TO STOCK` restores the sample.
- [ ] `EXPORT .ARIA.JSON`, then drag the file onto the chassis (or IMPORT) — chart loads as `imported`. A hand-corrupted JSON is rejected with a reason.

Critic:

- [ ] Load `broken`, press Validate. CriticInspector shows failures (deliberate parity violations).
- [ ] Load `pump-5pad`, press Validate. Report passes (or only minor violations).

Vocals:

- [ ] Vocal ribbon renders phrases. Mode `sim` scores a demo singer. `off` silences it.
- [ ] Mode `mic` asks for microphone permission; with permission granted it scores live input via the YIN detector. (No mic? Skip — `sim` covers the path.)

Director:

- [ ] In DirectorPanel, type `make the chorus denser but keep the feet fair` and submit. The verified chart hot-swaps into the engine with a critic diff log.

Camera pad:

- [ ] CamPadOverlay `SIM` replays scripted motion. `CAM` needs a webcam grant: the mirror preview goes `LIVE`, waving inside a zone fires that pad, and holding both hands in the TOP CORNERS fills the bar and arms Overdrive 2x (keep them up to hold it). (No camera? Skip — `SIM` covers the path.)
- [ ] With 2+ cameras (FaceTime + Continuity), the CAMERA picker lists both. If the room is noisy, hit CALIBRATE while still (or drag SENSITIVITY) until the meter idles below the amber marker.
- [ ] `AI VERIFY` takes one SAM 3.1 snapshot (mock `$0` in `dev`) whose boxes linger on the preview; it is a second opinion only — the live tracker needs no backend.

Stage art:

- [ ] Generate art for the active song. In `dev` you get the instant procedural SVG backdrop (`MOCK SVG $0` label), beat-reactive while playing.

---

## 5. Done criteria

Everything above is green or knowingly skipped (mic/camera only):

- [ ] `pytest` green, `npm run test` green, `npm run typecheck` clean.
- [ ] `/health` ok; `validate` + `generate` return real JSON.
- [ ] All studio paths exercised at least in mock form: play, validate, remix, stage art, plus edit/repair/pack.
- [ ] `git status --short` shows no surprise files (only intended changes).

If anything is red, note the exact command + error output and fix that layer
before starting new feature work.
