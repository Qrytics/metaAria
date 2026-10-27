"""Aria Stage 1 FastAPI surface: DSP + validation + critic pipeline."""

from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile
from pydantic import BaseModel, Field

from .critic import MAX_CRITIC_RETRIES, run_critic_loop
from .dsp import extract_grid
from .llm import (
    SAM_DEFAULT_PROMPT,
    RouterConfig,
    generate_draft_chart,
    generate_stage_art,
    remix_chart,
    segment_frame,
    transcribe_vocals,
)
from .schemas import (
    ChartSchema,
    CriticReportSchema,
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
