"""Critic self-correction loop (AGENTS.md §§3–5).

Deterministic Python pre-checks run first; the Critic LLM then audits and
forces corrections until pass or the strict retry cap.
"""

from __future__ import annotations

from .llm import RouterConfig, audit_chart_with_critic
from .schemas import ChartSchema, CriticReportSchema
from .validator import validate_chart

MAX_CRITIC_RETRIES = 3


def run_critic_loop(
    draft: ChartSchema,
    onsets_ms: list[int],
    config: RouterConfig | None = None,
    audit_fn=audit_chart_with_critic,
) -> tuple[ChartSchema, CriticReportSchema, int]:
    """Audit `draft` until it passes or `MAX_CRITIC_RETRIES` is hit.

    Returns (final_chart, final_report, attempts_used). `attempts_used` counts
    critic LLM calls; 0 means the draft passed pre-checks with no LLM needed.
    """
    cfg = config or RouterConfig.from_env()
    current = draft
    report = validate_chart(current, onsets_ms)
    if report.passed:
        return current, report, 0

    attempts = 0
    while attempts < MAX_CRITIC_RETRIES:
        attempts += 1
        audit = audit_fn(
            current.model_dump(), [v.model_dump() for v in report.violations], cfg
        )
        fixed = audit.get("fixed_chart")
        if fixed:
            try:
                current = ChartSchema.model_validate(fixed)
            except ValueError:
                # Malformed fix: keep current chart, re-audit next round.
                pass
        report = validate_chart(current, onsets_ms)
        if audit.get("passed", False) and report.passed:
            break
        if report.passed:
            break
    return current, report, attempts
