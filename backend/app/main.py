"""Aria Stage 1 FastAPI surface: DSP + validation + critic pipeline."""

from __future__ import annotations

import shutil
import tempfile
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from .critic import MAX_CRITIC_RETRIES, run_critic_loop
from .dsp import extract_grid
from .ingest import (
    AUDIO_EXTS,
    VIDEO_EXTS,
    extract_motion_peaks,
    mock_vocal_phrases_from_grid,
    synthesize_draft_chart,
)
from .llm import (
    SAM_DEFAULT_PROMPT,
    RouterConfig,
    _use_mock,
    generate_draft_chart,
    generate_stage_art,
    remix_chart,
    segment_frame,
    transcribe_vocals,
)
from .schemas import (
    ChartSchema,
    CriticReportSchema,
    IngestResponseSchema,
    IngestTelemetrySchema,
    SamSegmentRequestSchema,
    SamSegmentResponseSchema,
    StageArtRequestSchema,
    StageArtResponseSchema,
    VoiceRemixRequestSchema,
    VoiceRemixResponseSchema,
)
from .validator import validate_chart

app = FastAPI(title="Aria Charting Studio (Stage 3)")


class ValidateRequest(BaseModel):
    chart: ChartSchema
    onset_times_ms: list[int] = Field(default_factory=list)


class GenerateRequest(BaseModel):
    audio_path: str
    mode: str = Field(pattern="^(mania-4k|pump-5pad)$")
    title: str = "Untitled"


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "max_critic_retries": MAX_CRITIC_RETRIES}


@app.post("/charts/validate", response_model=CriticReportSchema)
def validate_endpoint(req: ValidateRequest) -> CriticReportSchema:
    return validate_chart(req.chart, req.onset_times_ms)


@app.post("/charts/generate")
def generate_endpoint(req: GenerateRequest) -> dict:
    from .audio import normalize_to_wav16k

    try:
        wav = normalize_to_wav16k(req.audio_path)
        grid = extract_grid(wav)
    except Exception as exc:  # surface DSP failures as 400s
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    cfg = RouterConfig.from_env()
    vocals = transcribe_vocals(str(wav), cfg)
    # Stage 2.5: align F0 → MIDI reference pitches onto transcribed phrases.
    # Pitch extraction is best-effort — transcription timestamps still flow
    # to the draft generator if the contour fails (e.g. a cappella silence).
    try:
        from .dsp import align_phrase_pitches, extract_pitch_contour

        contour = extract_pitch_contour(wav)
        vocal_phrases = align_phrase_pitches(vocals.get("phrases", []), contour)
    except Exception:
        vocal_phrases = vocals.get("phrases", [])
    draft_dict = generate_draft_chart(
        grid.bpm, grid.onset_times_ms, vocal_phrases,
        [], req.mode, req.title, grid.duration_ms, cfg,
    )
    draft = ChartSchema.model_validate(draft_dict)
    final, report, attempts = run_critic_loop(draft, grid.onset_times_ms, cfg)
    return {
        "chart": final.model_dump(),
        "report": report.model_dump(),
        "attempts": attempts,
        "bpm": grid.bpm,
    }


@app.post("/charts/ingest", response_model=IngestResponseSchema)
async def ingest_endpoint(
    audio_file: UploadFile,
    mode: str = Form(...),
    difficulty: str = Form("normal"),
    title: str = Form("Untitled Upload"),
    video_file: UploadFile | None = None,
) -> IngestResponseSchema:
    """Stage 5: ingest a real audio (+optional video) upload into a verified chart.

    Pipeline: FFmpeg 16kHz transcode + librosa DSP -> `muse-voice-transcribe`
    (+ pyin MIDI align; onset-aligned deterministic fallback in ENV=dev) ->
    `sam-3.1` motion peaks from sampled keyframes (frame-diff fallback in
    ENV=dev) -> `meta-models/muse-spark-open-1026` draft (deterministic
    onset-snapped synthesizer fallback in ENV=dev) -> validator +
    `muse-wonder-1.0` critic loop (cap `MAX_CRITIC_RETRIES = 3`) + stage art.
    """
    from .audio import normalize_to_wav16k

    if mode not in ("mania-4k", "pump-5pad"):
        raise HTTPException(status_code=400, detail="mode must be mania-4k or pump-5pad")
    if difficulty not in ("normal", "hard"):
        raise HTTPException(status_code=400, detail="difficulty must be normal or hard")
    audio_ext = Path(audio_file.filename or "").suffix.lower()
    if audio_ext not in AUDIO_EXTS:
        raise HTTPException(
            status_code=400,
            detail=f"audio_file must be one of {sorted(AUDIO_EXTS)}",
        )
    video_path: Path | None = None
    if video_file is not None and (video_file.filename or "") != "":
        video_ext = Path(video_file.filename or "").suffix.lower()
        if video_ext not in VIDEO_EXTS:
            raise HTTPException(
                status_code=400,
                detail=f"video_file must be one of {sorted(VIDEO_EXTS)}",
            )

    tmpdir = Path(tempfile.mkdtemp(prefix="aria-ingest-"))
    audio_path = tmpdir / f"upload-{uuid.uuid4().hex}{audio_ext}"
    with open(audio_path, "wb") as fh:
        shutil.copyfileobj(audio_file.file, fh)
    if video_file is not None and (video_file.filename or "") != "":
        video_path = tmpdir / f"clip-{uuid.uuid4().hex}{video_ext}"
        with open(video_path, "wb") as fh:
            shutil.copyfileobj(video_file.file, fh)

    cfg = RouterConfig.from_env()
    mock_flags: dict[str, bool] = {}
    t0 = time.perf_counter()
    try:
        wav = normalize_to_wav16k(audio_path)
        grid = extract_grid(wav)
        from .dsp import align_phrase_pitches, extract_pitch_contour

        try:
            contour = extract_pitch_contour(wav)
        except Exception:
            from .dsp import PitchContour

            contour = PitchContour(times_ms=[], midi_notes=[])
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    dsp_ms = (time.perf_counter() - t0) * 1000

    t0 = time.perf_counter()
    if _use_mock(cfg) or not cfg.meta_api_key:
        vocal_phrases = mock_vocal_phrases_from_grid(
            grid.onset_times_ms, grid.duration_ms, contour.times_ms, contour.midi_notes
        )
        mock_flags["transcribe"] = True
    else:
        try:
            tv = transcribe_vocals(str(wav), cfg)
            vocal_phrases = align_phrase_pitches(tv.get("phrases", []), contour)
            mock_flags["transcribe"] = False
        except Exception as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
    transcribe_ms = (time.perf_counter() - t0) * 1000

    t0 = time.perf_counter()
    motion_peaks, sam_mock = extract_motion_peaks(
        video_path, grid.duration_ms, grid.onset_times_ms, cfg
    )
    mock_flags["sam"] = sam_mock
    sam_ms = (time.perf_counter() - t0) * 1000

    t0 = time.perf_counter()
    if _use_mock(cfg) or not cfg.baseten_api_key:
        draft_dict = synthesize_draft_chart(
            grid.bpm, grid.onset_times_ms, vocal_phrases, motion_peaks,
            mode, title, grid.duration_ms, difficulty,
        )
        mock_flags["draft"] = True
    else:
        try:
            draft_dict = generate_draft_chart(
                grid.bpm, grid.onset_times_ms, vocal_phrases, motion_peaks,
                mode, title, grid.duration_ms, cfg,
            )
            mock_flags["draft"] = False
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"draft failed: {exc}") from exc
    try:
        draft = ChartSchema.model_validate(draft_dict)
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=f"draft invalid: {exc}") from exc
    draft_ms = (time.perf_counter() - t0) * 1000

    t0 = time.perf_counter()
    final, report, attempts = run_critic_loop(draft, grid.onset_times_ms, cfg)
    art = generate_stage_art(final.title, "uploaded track stage", 7, cfg)
    mock_flags["art"] = bool(art.get("mock", False))
    critic_ms = (time.perf_counter() - t0) * 1000

    return IngestResponseSchema(
        chart=final,
        report=report,
        attempts=attempts,
        bpm=grid.bpm,
        duration_ms=grid.duration_ms,
        onset_times_ms=grid.onset_times_ms,
        motion_peaks_ms=motion_peaks,
        art=art,
        telemetry=IngestTelemetrySchema(
            dsp_ms=dsp_ms,
            transcribe_ms=transcribe_ms,
            sam_ms=sam_ms,
            draft_ms=draft_ms,
            critic_ms=critic_ms,
        ),
        mock=mock_flags,
    )


def _diff_charts(before: ChartSchema, after: ChartSchema, limit: int = 50) -> list[str]:
    """Compact critic diff log: retimes, pad/lane swaps, adds, drops, bpm."""
    log: list[str] = []
    if before.title != after.title:
        log.append(f"title {before.title!r}->{after.title!r}")
    if before.bpm != after.bpm:
        log.append(f"bpm {before.bpm}->{after.bpm}")
    bmap = {(n.time_ms, n.pad, n.lane): n for n in before.notes}
    amap = {(n.time_ms, n.pad, n.lane): n for n in after.notes}
    for k in sorted(set(bmap) - set(amap)):
        log.append(f"removed note @{k[0]}ms pad={k[1]} lane={k[2]}")
    for k in sorted(set(amap) - set(bmap)):
        log.append(f"added note @{k[0]}ms pad={k[1]} lane={k[2]}")
    # Retimes keep the same pad/lane identity across a time shift.
    bpad = {(n.pad, n.lane, n.kind): n.time_ms for n in before.notes}
    apad = {(n.pad, n.lane, n.kind): n.time_ms for n in after.notes}
    for ident in sorted(set(bpad) & set(apad)):
        if bpad[ident] != apad[ident]:
            log.append(f"retimed pad={ident[0]} lane={ident[1]} "
                        f"{bpad[ident]}->{apad[ident]}ms")
    if len(log) > limit:
        log = log[:limit] + [f"... {len(log) - limit} more changes"]
    if not log:
        log = ["no note changes (command kept chart identical)"]
    return log


@app.post("/vision/sam-segment", response_model=SamSegmentResponseSchema)
def sam_segment_endpoint(req: SamSegmentRequestSchema) -> SamSegmentResponseSchema:
    """Track hands/body in a frame; map masks to 5-pad + Overdrive triggers."""
    prompt = req.prompt or SAM_DEFAULT_PROMPT
    seg = segment_frame(prompt, req.image_b64, req.mode)
    return SamSegmentResponseSchema(
        boxes=[
            {"x": d["box"][0], "y": d["box"][1],
             "w": d["box"][2], "h": d["box"][3],
             "label": d.get("label", "mask")}
            for d in seg["detections"]
        ],
        masks=[
            {"label": d.get("label", "mask"),
             "polygon": d.get("polygon", [[0, 0], [1, 0], [1, 1]]),
             "confidence": d.get("confidence", 0.0)}
            for d in seg["detections"]
        ],
        hit_zones=seg["hit_zones"],
        overdrive_active=seg["overdrive_active"],
        mock=seg["mock"],
        model=seg["model"],
    )


@app.post("/director/upload-audio")
def upload_audio_endpoint(file: UploadFile) -> dict:
    """Store a recorded Director Mic blob; returns a server-side audio_path."""
    import tempfile
    import uuid

    suffix = Path(file.filename or "director.webm").suffix or ".webm"
    dst = Path(tempfile.gettempdir()) / f"aria-director-{uuid.uuid4().hex}{suffix}"
    with open(dst, "wb") as fh:
        shutil.copyfileobj(file.file, fh)
    return {"audio_path": str(dst)}


@app.post("/director/voice-remix", response_model=VoiceRemixResponseSchema)
def voice_remix_endpoint(req: VoiceRemixRequestSchema) -> VoiceRemixResponseSchema:
    """Remix the active chart from a spoken (or typed) director command."""
    from .audio import normalize_to_wav16k

    cfg = RouterConfig.from_env()
    if req.audio_path:
        try:
            wav = normalize_to_wav16k(req.audio_path)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if cfg.env == "dev" and not cfg.meta_api_key:
            from .llm import DIRECTOR_MOCK_COMMAND

            command = DIRECTOR_MOCK_COMMAND
        else:
            try:
                tv = transcribe_vocals(str(wav), cfg)
                command = tv.get("text") or " ".join(
                    p.get("text", "") for p in tv.get("phrases", [])
                )
            except Exception as exc:
                raise HTTPException(status_code=502, detail=str(exc)) from exc
            if not command.strip():
                raise HTTPException(status_code=400, detail="empty transcription")
    elif req.command_text and req.command_text.strip():
        command = req.command_text.strip()
    else:
        raise HTTPException(
            status_code=400,
            detail="one of audio_path or command_text is required",
        )
    try:
        remixed_dict, _mock = remix_chart(
            req.chart.model_dump(), command, req.onset_times_ms, cfg
        )
        draft = ChartSchema.model_validate(remixed_dict)
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=f"director draft invalid: {exc}") from exc
    final, report, attempts = run_critic_loop(draft, req.onset_times_ms, cfg)
    return VoiceRemixResponseSchema(
        chart=final,
        report=report,
        attempts=attempts,
        command=command,
        diff_log=_diff_charts(req.chart, final),
    )


@app.post("/stage/generate-art", response_model=StageArtResponseSchema)
def stage_art_endpoint(req: StageArtRequestSchema) -> StageArtResponseSchema:
    """Generate the song jacket + beat-reactive stage background layer."""
    art = generate_stage_art(req.title, req.style_prompt, req.seed)
    return StageArtResponseSchema(**art)
