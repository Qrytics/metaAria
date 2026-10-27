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
SAM_MODEL = "sam-3.1"
IMAGE_MODEL = "muse-image"

# --- Static system prompts (cacheable: no per-song data allowed here) ---

CHART_JSON_SCHEMA_STATIC = """\
CHART JSON SCHEMA (static, cached):
{"mode": "mania-4k" | "pump-5pad", "title": str, "bpm": float > 0,
 "offset_ms": int >= 0, "duration_ms": int > 0,
 "notes": [{"time_ms": int >= 0, "lane": 0-3 | null, "pad": Q/E/S/Z/C | null,
            "kind": "tap"|"hold"|"slide", "duration_ms": int >= 0}],
 "vocal_phrases": [{"text": str, "speaker_id": str (e.g. SPEAKER_00),
            "start_ms": int >= 0, "end_ms": int > start_ms,
            "midi_pitch": 36-84 pitched | 0 unpitched rap/talkie}]}
Rules: mania-4k uses lane 0-3 with pad null; pump-5pad uses pad Q/E/S/Z/C
with lane null; notes sorted by time_ms ascending; vocal_phrases sorted by
start_ms ascending and non-overlapping per speaker (cross-speaker overlap
= duet harmony, allowed)."""

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
    "Output ONLY JSON {\"phrases\": [{\"text\": str, \"speaker_id\": str "
    "(diarized label, e.g. SPEAKER_00), \"start_ms\": int, \"end_ms\": int}]}. "
    "Attribute every phrase to its speaker; overlapping phrases from distinct "
    "speakers are duet harmony — keep both."
)

SAM_SYSTEM_PROMPT = (
    "You are Aria's webcam air-pad tracker. Given one video frame plus a text "
    "prompt naming body parts, output ONLY a JSON object "
    "{\"detections\": [{\"label\": str, \"box\": [x, y, w, h] (normalized 0-1), "
    "\"polygon\": [[x, y], ...] (normalized 0-1), \"confidence\": 0-1}], "
    "\"overdrive\": bool}. "
    "Mapping rules: left-hand mass low/left triggers Q or Z; right-hand mass "
    "low/right triggers E or C; center mass triggers S; BOTH hands raised "
    "above shoulder line sets overdrive true (2x score multiplier). "
    "Coordinates are normalized 0-1; never emit pixels."
)

DIRECTOR_SYSTEM_PROMPT = (
    "You are Aria's chart director (open-weight track). Rewrite the active "
    "Chart JSON to honor the player's spoken remix command. Output ONLY valid "
    "Chart JSON matching the schema; keep mode, title, and duration_ms; keep "
    "vocal_phrases byte-identical unless the command names vocals. "
    "Honor every biomechanical grading rule below — a validator audits you.\n"
    + CHART_JSON_SCHEMA_STATIC
    + "\n"
    + BIOMECH_RULES_STATIC
)

IMAGE_SYSTEM_PROMPT = (
    "You are Aria's reactive stage artist. Output ONLY a JSON object "
    "{\"jacket_svg\": str, \"background_svg\": str, \"palette\": [hex, ...]}. "
    "Both SVGs are 480x320 viewBox cyber-arcade scenes fusing the song title "
    "with the search-grounded style prompt: neon receptor rails for pads "
    "Q/E/S/Z/C, beat-pulse grid lines, dark chassis framing. No raster "
    "images, no external URLs, no <script> — pure SVG shapes and gradients."
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


def _use_mock(config: RouterConfig) -> bool:
    """$0-cost deterministic fallback: ENV=dev with no Meta API key set."""
    return config.env == "dev" and not config.meta_api_key


# --- Stage 3: SAM 3.1 webcam air-pad -------------------------------------

SAM_DEFAULT_PROMPT = "hands and feet"
SAM_OVERDRIVE_PROMPT = "raised hands overdrive pose"

# Fixed mock detections: left hand low-left, right hand low-right, both raised
# when the prompt names the overdrive pose.
_MOCK_SAM_DETECTIONS = [
    {"label": "left hand", "box": [0.10, 0.55, 0.18, 0.25],
     "polygon": [[0.10, 0.55], [0.28, 0.55], [0.28, 0.80], [0.10, 0.80]],
     "confidence": 0.93},
    {"label": "right hand", "box": [0.72, 0.55, 0.18, 0.25],
     "polygon": [[0.72, 0.55], [0.90, 0.55], [0.90, 0.80], [0.72, 0.80]],
     "confidence": 0.91},
]

_MOCK_SAM_OVERDRIVE_DETECTIONS = [
    {"label": "left hand raised", "box": [0.12, 0.05, 0.18, 0.25],
     "polygon": [[0.12, 0.05], [0.30, 0.05], [0.30, 0.30], [0.12, 0.30]],
     "confidence": 0.95},
    {"label": "right hand raised", "box": [0.70, 0.05, 0.18, 0.25],
     "polygon": [[0.70, 0.05], [0.88, 0.05], [0.88, 0.30], [0.70, 0.30]],
     "confidence": 0.94},
]


def mock_sam_detections(prompt: str) -> tuple[list[dict], bool]:
    """Deterministic mock: overdrive pose iff the prompt names raised hands."""
    if "raised hands" in prompt.lower() or "overdrive" in prompt.lower():
        return [dict(d) for d in _MOCK_SAM_OVERDRIVE_DETECTIONS], True
    return [dict(d) for d in _MOCK_SAM_DETECTIONS], False


def _detections_to_hit_zones(detections: list[dict], overdrive: bool) -> list[dict]:
    """Map tracked mass to 5-pad zones: left→Q, right→E, center→S, plus pose."""
    zones = [
        {"pad": "Q", "triggered": False, "confidence": 0.0},
        {"pad": "E", "triggered": False, "confidence": 0.0},
        {"pad": "S", "triggered": False, "confidence": 0.0},
        {"pad": "Z", "triggered": False, "confidence": 0.0},
        {"pad": "C", "triggered": False, "confidence": 0.0},
        {"pad": "OVERDRIVE", "triggered": overdrive,
         "confidence": 1.0 if overdrive else 0.0},
    ]
    for det in detections:
        try:
            x, _y, w, _h = det["box"]
            cx = float(x) + float(w) / 2.0
            conf = float(det.get("confidence", 0.0))
        except (KeyError, TypeError, ValueError):
            continue
        label = str(det.get("label", "")).lower()
        if "left" in label:
            zones[0]["triggered"] = True
            zones[0]["confidence"] = max(zones[0]["confidence"], conf)
            zones[3]["triggered"] = True
            zones[3]["confidence"] = max(zones[3]["confidence"], conf * 0.8)
        elif "right" in label:
            zones[1]["triggered"] = True
            zones[1]["confidence"] = max(zones[1]["confidence"], conf)
            zones[4]["triggered"] = True
            zones[4]["confidence"] = max(zones[4]["confidence"], conf * 0.8)
        elif "foot" in label or "feet" in label or "center" in label:
            zones[2]["triggered"] = True
            zones[2]["confidence"] = max(zones[2]["confidence"], conf)
        elif 0.35 <= cx <= 0.65:
            zones[2]["triggered"] = True
            zones[2]["confidence"] = max(zones[2]["confidence"], conf * 0.7)
    return zones


def segment_frame(
    prompt: str,
    image_b64: str | None,
    mode: str = "pump-5pad",
    config: RouterConfig | None = None,
) -> dict:
    """Call `sam-3.1` with a frame + text prompt; mock in ENV=dev w/o key."""
    cfg = config or RouterConfig.from_env()
    if _use_mock(cfg):
        detections, overdrive = mock_sam_detections(prompt)
        return {
            "detections": detections,
            "hit_zones": _detections_to_hit_zones(detections, overdrive),
            "overdrive_active": overdrive,
            "mock": True,
            "model": SAM_MODEL,
        }
    client = _client("meta", cfg)
    content: list[dict] = [{"type": "text", "text": prompt}]
    if image_b64:
        content.append(
            {"type": "image_url",
             "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}}
        )
    resp = client.chat.completions.create(
        model=SAM_MODEL,
        messages=[
            {"role": "system", "content": SAM_SYSTEM_PROMPT},
            {"role": "user", "content": content},  # type: ignore[typeddict-item]
        ],
        response_format={"type": "json_object"},
    )
    parsed = json.loads(resp.choices[0].message.content or "{}")
    detections = parsed.get("detections", [])
    overdrive = bool(parsed.get("overdrive", False))
    return {
        "detections": detections,
        "hit_zones": _detections_to_hit_zones(detections, overdrive),
        "overdrive_active": overdrive,
        "mock": False,
        "model": SAM_MODEL,
    }


# --- Stage 3: Voice AI Chart Director --------------------------------------

DIRECTOR_MOCK_COMMAND = "Make the chorus twice as fast with more crossovers"


def build_director_user_message(chart: dict, command: str, onsets_ms: list[int]) -> str:
    """Dynamic remix payload — always a USER message, never system."""
    payload = {
        "active_chart": chart,
        "remix_command": command,
        "onset_times_ms": onsets_ms,
    }
    return "REMIX TARGET (dynamic, uncached):\n" + json.dumps(payload)


def mock_remix_chart(chart: dict, command: str, onsets_ms: list[int]) -> dict:
    """Deterministic mock remix: snap notes to onsets, honor speed words."""
    import bisect as _bisect

    cmd = command.lower()
    out = json.loads(json.dumps(chart))  # deep copy
    grid = sorted(onsets_ms) if onsets_ms else []
    if grid:
        for note in out.get("notes", []):
            i = _bisect.bisect_left(grid, note["time_ms"])
            cands = [c for c in (i - 1, i) if 0 <= c < len(grid)]
            if cands:
                best = min(cands, key=lambda c: abs(grid[c] - note["time_ms"]))
                note["time_ms"] = grid[best]
    if "twice as fast" in cmd or "double" in cmd:
        out["bpm"] = float(out.get("bpm", 120.0)) * 2.0
    elif "half" in cmd or "slower" in cmd:
        out["bpm"] = float(out.get("bpm", 120.0)) * 0.5
    if "crossover" in cmd and out.get("mode") == "pump-5pad":
        cycle = ["Q", "C", "Z", "E", "S"]
        notes = sorted(out.get("notes", []), key=lambda n: n["time_ms"])
        for i, note in enumerate(notes):
            note["pad"] = cycle[i % len(cycle)]
        out["notes"] = sorted(notes, key=lambda n: n["time_ms"])
    out["title"] = f"{out.get('title', 'Untitled')} (Director Remix)"
    return out


def remix_chart(
    chart: dict,
    command: str,
    onsets_ms: list[int],
    config: RouterConfig | None = None,
) -> tuple[dict, bool]:
    """Mutate the chart via the open-weight director. Returns (chart, mock)."""
    cfg = config or RouterConfig.from_env()
    if _use_mock(cfg) or not cfg.baseten_api_key:
        return mock_remix_chart(chart, command, onsets_ms), True
    client = _client("baseten", cfg)
    resp = client.chat.completions.create(
        model=DRAFT_MODEL,
        messages=[
            {"role": "system", "content": DIRECTOR_SYSTEM_PROMPT},
            {"role": "user",
             "content": build_director_user_message(chart, command, onsets_ms)},
        ],
        response_format={"type": "json_object"},
    )
    return json.loads(resp.choices[0].message.content or "{}"), False


# --- Stage 3: Muse Image reactive stage ------------------------------------

CYBER_PALETTES: list[list[str]] = [
    ["#ff2fb3", "#22d3ee", "#ffb000", "#0b0e1a"],
    ["#7CFC00", "#4cc9f0", "#ff9f1c", "#0b0e1a"],
    ["#a78bfa", "#22d3ee", "#facc15", "#0b0e1a"],
]


def build_image_user_message(title: str, style_prompt: str, seed: int) -> str:
    """Dynamic art payload — always a USER message, never system."""
    return (
        "STAGE ART TARGET (dynamic, uncached):\n"
        + json.dumps({"title": title, "style_prompt": style_prompt, "seed": seed})
    )


def _shorten(text: str, width: int) -> str:
    """Truncate at a word boundary so jackets never cut mid-word."""
    text = " ".join(text.split())
    if len(text) <= width:
        return text
    return text[:width].rsplit(" ", 1)[0] + "…"


def procedural_stage_svg(title: str, style_prompt: str, seed: int, jacket: bool) -> str:
    """Deterministic cyber-stage fallback: pure SVG, no network, no raster."""
    palette = CYBER_PALETTES[seed % len(CYBER_PALETTES)]
    neon, cyan, amber, dark = palette
    short = (
        _shorten(title, 26)
        if jacket
        else f"{_shorten(title, 22)} — {_shorten(style_prompt, 22)}"
    )
    rails = ""
    for i, x in enumerate([60, 140, 220, 300, 380]):
        rails += (
            f'<rect x="{x}" y="40" width="40" height="220" fill="none" '
            f'stroke="{[neon, cyan, amber, neon, cyan][i]}" stroke-width="3"/>'
        )
    grid = "".join(
        f'<line x1="0" y1="{y}" x2="480" y2="{y}" stroke="{cyan}" '
        f'stroke-opacity="0.25"/>' for y in range(280, 321, 8)
    )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 320">'
        f'<defs><linearGradient id="bg{seed}" x1="0" y1="0" x2="0" y2="1">'
        f'<stop offset="0" stop-color="{dark}"/>'
        f'<stop offset="1" stop-color="#161c28"/></linearGradient></defs>'
        f'<rect width="480" height="320" fill="url(#bg{seed})"/>'
        f"{rails}{grid}"
        f'<rect x="8" y="8" width="464" height="304" fill="none" '
        f'stroke="{amber}" stroke-width="2"/>'
        f'<text x="24" y="300" fill="{amber}" font-family="monospace" '
        f'font-size="16">{short}</text></svg>'
    )


def generate_stage_art(
    title: str,
    style_prompt: str,
    seed: int = 7,
    config: RouterConfig | None = None,
) -> dict:
    """Call `muse-image`; procedural SVG fallback in ENV=dev w/o key."""
    cfg = config or RouterConfig.from_env()
    if _use_mock(cfg):
        return {
            "jacket_svg": procedural_stage_svg(title, style_prompt, seed, True),
            "background_svg": procedural_stage_svg(title, style_prompt, seed + 1, False),
            "palette": CYBER_PALETTES[seed % len(CYBER_PALETTES)],
            "mock": True,
            "model": IMAGE_MODEL,
        }
    client = _client("meta", cfg)
    resp = client.chat.completions.create(
        model=IMAGE_MODEL,
        messages=[
            {"role": "system", "content": IMAGE_SYSTEM_PROMPT},
            {"role": "user",
             "content": build_image_user_message(title, style_prompt, seed)},
        ],
        response_format={"type": "json_object"},
    )
    parsed = json.loads(resp.choices[0].message.content or "{}")
    return {
        "jacket_svg": parsed.get("jacket_svg", ""),
        "background_svg": parsed.get("background_svg", ""),
        "palette": parsed.get("palette", []),
        "mock": False,
        "model": IMAGE_MODEL,
    }
