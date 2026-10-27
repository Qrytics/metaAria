"""Prompt-cached LLM client routers (AGENTS.md §§2–4).

Caching rule: static JSON schemas + biomechanical grading rules go at the TOP
of the system prompt. Zero dynamic timestamps or per-song data there. All
dynamic song data (onset grids, vocal timestamps, motion peaks, violation
reports) goes in the USER message so cached input tokens are maximized.

Model routing (exact IDs):
- voice  → `muse-voice-transcribe` (Meta Model API)
- draft  → `meta-models/muse-spark-open-1026` (Baseten, `-1026` suffix required)
- critic → `muse-wonder-1.0` (default) or `muse-spark-1.3-contributor` (ENV=dev)
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass

VOICE_MODEL = "muse-voice-transcribe"
DRAFT_MODEL = "meta-models/muse-spark-open-1026"
CRITIC_MODEL_PROD = "muse-wonder-1.0"
CRITIC_MODEL_DEV = "muse-spark-1.3-contributor"

# --- Static system prompts (cacheable: no per-song data allowed here) ---

CHART_JSON_SCHEMA_STATIC = """\
CHART JSON SCHEMA (static, cached):
{"mode": "mania-4k" | "pump-5pad", "title": str, "bpm": float > 0,
 "offset_ms": int >= 0, "duration_ms": int > 0,
 "notes": [{"time_ms": int >= 0, "lane": 0-3 | null, "pad": Q/E/S/Z/C | null,
            "kind": "tap"|"hold"|"slide", "duration_ms": int >= 0}]}
Rules: mania-4k uses lane 0-3 with pad null; pump-5pad uses pad Q/E/S/Z/C
with lane null; notes sorted by time_ms ascending."""

BIOMECH_RULES_STATIC = """\
BIOMECHANICAL GRADING RULES (static, cached):
1. Snap: every note within ±15ms of a detected onset.
2. Foot parity (5-pad): alternate feet; same foot max 2 consecutive notes;
   same foot needs >=150ms to travel between distinct pads.
3. Density: max 10 notes per rolling 1000ms window.
4. Fix by moving/retiming notes, never by loosening the rules."""

DRAFT_SYSTEM_PROMPT = (
    "You are Aria's chart generator (open-weight track). "
    "Output ONLY valid Chart JSON matching the schema.\n"
    + CHART_JSON_SCHEMA_STATIC
    + "\n"
    + BIOMECH_RULES_STATIC
)

CRITIC_SYSTEM_PROMPT = (
    "You are Aria's verifiable playability critic. "
    "Audit the draft Chart JSON against the schema and grading rules. "
    "Output ONLY a JSON object {\"passed\": bool, \"fixed_chart\": Chart|null, "
    "\"violations\": [{\"type\": snap|parity|density|critic, \"time_ms\": int|null, "
    "\"message\": str}]}. Repair violations by editing notes.\n"
    + CHART_JSON_SCHEMA_STATIC
    + "\n"
    + BIOMECH_RULES_STATIC
)

VOICE_SYSTEM_PROMPT = (
    "You are Aria's vocal transcriber. "
    "Output ONLY JSON {\"phrases\": [{\"text\": str, \"start_ms\": int, \"end_ms\": int}]}."
)


@dataclass(frozen=True)
class RouterConfig:
    meta_api_key: str | None
    baseten_api_key: str | None
    meta_base_url: str
    baseten_base_url: str
    env: str = "dev"

    @classmethod
    def from_env(cls) -> "RouterConfig":
        return cls(
            meta_api_key=os.getenv("META_API_KEY"),
            baseten_api_key=os.getenv("BASETEN_API_KEY"),
            meta_base_url=os.getenv("META_API_BASE_URL", "https://api.meta-model.example/v1"),
            baseten_base_url=os.getenv("BASETEN_API_BASE_URL", "https://api.baseten.example/v1"),
            env=os.getenv("ENV", "dev"),
        )

    @property
    def critic_model(self) -> str:
        return CRITIC_MODEL_DEV if self.env == "dev" else CRITIC_MODEL_PROD


def _client(provider: str, config: RouterConfig):
    """Build an OpenAI-compatible client. Imported lazily for testability."""
    from openai import OpenAI

    if provider == "meta":
        return OpenAI(api_key=config.meta_api_key or "test", base_url=config.meta_base_url)
    return OpenAI(api_key=config.baseten_api_key or "test", base_url=config.baseten_base_url)


def build_draft_user_message(
    bpm: float,
    onsets_ms: list[int],
    vocal_timestamps: list[dict],
    motion_peaks_ms: list[int],
    mode: str,
    title: str,
    duration_ms: int,
) -> str:
    """Dynamic per-song payload — always a USER message, never system."""
    payload = {
        "mode": mode,
        "title": title,
        "duration_ms": duration_ms,
        "bpm": bpm,
        "onset_times_ms": onsets_ms,
        "vocal_timestamps": vocal_timestamps,
        "motion_peaks_ms": motion_peaks_ms,
    }
    return "SONG DATA (dynamic, uncached):\n" + json.dumps(payload)


def build_critic_user_message(draft_chart: dict, violations: list[dict]) -> str:
    payload = {"draft_chart": draft_chart, "deterministic_violations": violations}
    return "AUDIT TARGET (dynamic, uncached):\n" + json.dumps(payload)


def transcribe_vocals(wav_path: str, config: RouterConfig | None = None) -> dict:
    """Call `muse-voice-transcribe` on a 16kHz mono WAV file."""
    cfg = config or RouterConfig.from_env()
    client = _client("meta", cfg)
    with open(wav_path, "rb") as fh:
        resp = client.audio.transcriptions.create(model=VOICE_MODEL, file=fh)
    text = getattr(resp, "text", None)
    if isinstance(resp, dict):
        return resp
    try:
        return json.loads(text) if text else {"text": text}
    except (TypeError, json.JSONDecodeError):
        return {"text": text}


def generate_draft_chart(
    bpm: float,
    onsets_ms: list[int],
    vocal_timestamps: list[dict],
    motion_peaks_ms: list[int],
    mode: str,
    title: str,
    duration_ms: int,
    config: RouterConfig | None = None,
) -> dict:
    """Call the Baseten open-weight generator for a draft chart."""
    cfg = config or RouterConfig.from_env()
    client = _client("baseten", cfg)
    resp = client.chat.completions.create(
        model=DRAFT_MODEL,
        messages=[
            {"role": "system", "content": DRAFT_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": build_draft_user_message(
                    bpm, onsets_ms, vocal_timestamps, motion_peaks_ms,
                    mode, title, duration_ms,
                ),
            },
        ],
        response_format={"type": "json_object"},
    )
    return json.loads(resp.choices[0].message.content or "{}")


def audit_chart_with_critic(
    draft_chart: dict, violations: list[dict], config: RouterConfig | None = None
) -> dict:
    """One critic pass: returns {passed, fixed_chart, violations}."""
    cfg = config or RouterConfig.from_env()
    client = _client("meta", cfg)
    resp = client.chat.completions.create(
        model=cfg.critic_model,
        messages=[
            {"role": "system", "content": CRITIC_SYSTEM_PROMPT},
            {"role": "user", "content": build_critic_user_message(draft_chart, violations)},
        ],
        response_format={"type": "json_object"},
    )
    return json.loads(resp.choices[0].message.content or "{}")
