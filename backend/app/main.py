"""Aria Stage 1 FastAPI surface: DSP + validation + critic pipeline."""

from __future__ import annotations

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .critic import MAX_CRITIC_RETRIES, run_critic_loop
from .dsp import extract_grid
from .llm import RouterConfig, generate_draft_chart, transcribe_vocals
from .schemas import ChartSchema, CriticReportSchema
from .validator import validate_chart

app = FastAPI(title="Aria Charting Studio (Stage 1)")


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
    draft_dict = generate_draft_chart(
        grid.bpm, grid.onset_times_ms, vocals.get("phrases", []),
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
