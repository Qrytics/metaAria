import type { EngineSnapshot } from "../engine/engine";

/**
 * Pinned verdict strip: lives directly above the highway so the verdict of
 * every hit is visible during play without scrolling.
 */
export function VerdictStrip({
  snap,
  playing,
}: {
  snap: EngineSnapshot | null;
  playing: boolean;
}): React.JSX.Element {
  const counts = snap?.score.counts;
  const judged = snap?.judged ?? 0;
  const acc =
    snap === null
      ? 1
      : (snap.score.counts.PERFECT +
          snap.score.counts.GREAT * 0.7 +
          snap.score.counts.GOOD * 0.4) /
        Math.max(1, judged);
  return (
    <div
      className="verdict-strip"
      role="status"
      aria-label="Live judgment verdict"
    >
      <span className="t-perfect">P:{counts?.PERFECT ?? 0}</span>
      <span className="t-great">G:{counts?.GREAT ?? 0}</span>
      <span className="t-good">g:{counts?.GOOD ?? 0}</span>
      <span className="t-miss">M:{counts?.MISS ?? 0}</span>
      <span className="t-combo">x{snap?.score.combo ?? 0}</span>
      <span>PTS:{Math.round(snap?.score.points ?? 0)}</span>
      {snap?.overdrive === true && <span className="t-overdrive">OVERDRIVE x2</span>}
      <span>{(acc * 100).toFixed(1)}%</span>
      <span className="verdict-last">
        {playing ? (snap?.lastJudgment ?? "--") : "READY"}
      </span>
    </div>
  );
}

/** Monospace judgment telemetry: counts, combo, accuracy, song clock. */
export function TelemetryPanel({
  snap,
  playing,
}: {
  snap: EngineSnapshot | null;
  playing: boolean;
}): React.JSX.Element {
  const counts = snap?.score.counts;
  const judged = snap?.judged ?? 0;
  const total = snap?.total ?? 0;
  const acc =
    snap === null
      ? 1
      : (snap.score.counts.PERFECT +
          snap.score.counts.GREAT * 0.7 +
          snap.score.counts.GOOD * 0.4) /
        Math.max(1, judged);
  const rows: Array<[string, number | string, string]> = [
    ["PERFECT", counts?.PERFECT ?? 0, "t-perfect"],
    ["GREAT", counts?.GREAT ?? 0, "t-great"],
    ["GOOD", counts?.GOOD ?? 0, "t-good"],
    ["MISS", counts?.MISS ?? 0, "t-miss"],
  ];
  return (
    <section className="panel">
      <header className="panel-head">
        <span className="led" data-on={playing} />
        JUDGMENT TELEMETRY
      </header>
      <div className="telemetry-grid">
        {rows.map(([label, value, cls]) => (
          <div key={label} className="meter">
            <span className="meter-label">{label}</span>
            <span className={`meter-value ${cls}`}>{value}</span>
          </div>
        ))}
        <div className="meter">
          <span className="meter-label">COMBO</span>
          <span className="meter-value t-combo">{snap?.score.combo ?? 0}</span>
        </div>
        <div className="meter">
          <span className="meter-label">MAX COMBO</span>
          <span className="meter-value">{snap?.score.maxCombo ?? 0}</span>
        </div>
        <div className="meter">
          <span className="meter-label">POINTS</span>
          <span className="meter-value t-combo">
            {Math.round(snap?.score.points ?? 0)}
          </span>
        </div>
        <div className="meter">
          <span className="meter-label">ACCURACY</span>
          <span className="meter-value">{(acc * 100).toFixed(2)}%</span>
        </div>
        <div className="meter">
          <span className="meter-label">NOTES</span>
          <span className="meter-value">
            {judged}/{total}
          </span>
        </div>
      </div>
      <div className="readout">
        <span>
          T+{Math.max(0, Math.round(snap?.songTimeMs ?? 0))
            .toString()
            .padStart(6, "0")}ms
        </span>
        <span className="readout-last">
          LAST: {snap?.lastJudgment ?? "--"}
        </span>
      </div>
    </section>
  );
}
