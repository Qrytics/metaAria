import type { EngineSnapshot } from "../engine/engine";
import { accuracy } from "../engine/judgments";
import type { Chart } from "../types/chart";

/**
 * Floating arcade telemetry HUD: angled clip-path panels with a giant
 * combo counter, rolling score digits, and a life/Overdrive gauge.
 * Pure view over EngineSnapshot — no game math lives here.
 */

function fmtPoints(points: number): string {
  return Math.max(0, Math.round(points)).toString().padStart(7, "0");
}

/** One rolling score digit: remounts (ticks) only when its digit changes. */
function RollDigit({ digit, pos }: { digit: string; pos: number }): React.JSX.Element {
  return (
    <span className="roll-digit" key={`${pos}:${digit}`}>
      {digit}
    </span>
  );
}

/**
 * Top-left arcade HUD: giant combo counter + rolling score + judgment mini
 * strip. Clipped with an angled polygon so it reads as cabinet hardware.
 */
export function ArcadeHudLeft({
  snap,
  playing,
}: {
  snap: EngineSnapshot | null;
  playing: boolean;
}): React.JSX.Element {
  const counts = snap?.score.counts;
  const combo = snap?.score.combo ?? 0;
  const digits = fmtPoints(snap?.score.points ?? 0).split("");
  return (
    <div className="arcade-hud hud-left" role="status" aria-label="Combo and score">
      <div className="hud-combo-block">
        <span className="hud-caption">COMBO</span>
        <span
          key={combo}
          className={`hud-combo${combo >= 50 ? " mega" : ""}${combo === 0 && !playing ? " idle" : ""}`}
        >
          {combo}
        </span>
      </div>
      <div className="hud-score-block">
        <span className="hud-caption">SCORE</span>
        <span className="hud-score" aria-label={`Score ${fmtPoints(snap?.score.points ?? 0)}`}>
          {digits.map((d, i) => (
            <RollDigit key={i} digit={d} pos={i} />
          ))}
        </span>
      </div>
      <div className="hud-verdicts">
        <span className="t-perfect">P{counts?.PERFECT ?? 0}</span>
        <span className="t-great">G{counts?.GREAT ?? 0}</span>
        <span className="t-good">g{counts?.GOOD ?? 0}</span>
        <span className="t-miss">M{counts?.MISS ?? 0}</span>
        {snap?.overdrive === true && <span className="t-overdrive blink">2x</span>}
      </div>
    </div>
  );
}

/**
 * Top-right arcade HUD: song title/BPM plate + life gauge + Overdrive
 * state + accuracy/song clock. Mirrors hud-left with the opposite angle.
 */
export function ArcadeHudRight({
  snap,
  chart,
  playing,
}: {
  snap: EngineSnapshot | null;
  chart: Chart;
  playing: boolean;
}): React.JSX.Element {
  const acc = snap === null ? 1 : accuracy(snap.score);
  const life = Math.round(acc * 100);
  const overdrive = snap?.overdrive === true;
  const judged = snap?.judged ?? 0;
  const total = snap?.total ?? 0;
  return (
    <div className="arcade-hud hud-right" role="status" aria-label="Song status">
      <div className="hud-title-block">
        <span className="hud-song">{chart.title}</span>
        <span className="hud-sub">
          {chart.mode === "pump-5pad" ? "5-PAD" : "4-KEY"} · {chart.bpm} BPM ·{" "}
          {playing ? "PLAYING" : "READY"}
        </span>
      </div>
      <div className="hud-life-block">
        <div className="hud-life-row">
          <span className="hud-caption">LIFE</span>
          <span className={`hud-life-num${life < 50 ? " danger" : ""}`}>{life}%</span>
        </div>
        <div
          className="hud-life-bar"
          role="progressbar"
          aria-valuenow={life}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Life gauge"
        >
          <div
            className={`hud-life-fill${overdrive ? " od" : ""}`}
            style={{ width: `${Math.min(100, Math.max(0, life))}%` }}
          />
        </div>
        <div className="hud-od-row">
          <span className={`hud-od${overdrive ? " live" : ""}`}>
            {overdrive ? "◆ OVERDRIVE ×2" : "◇ OVERDRIVE"}
          </span>
          <span className="hud-clock">
            T+{Math.max(0, Math.round(snap?.songTimeMs ?? 0)).toString().padStart(6, "0")} ·{" "}
            {judged}/{total}
          </span>
        </div>
      </div>
    </div>
  );
}
