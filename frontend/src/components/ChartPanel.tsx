import {
  SNAP_TOLERANCE_MS,
  isPumpChart,
  type Chart,
  type CriticReport,
} from "../types/chart";
import {
  footTransitions,
  nearestOnsetDelta,
  type FootTransition,
} from "../footpath";

interface ChartPanelProps {
  chart: Chart;
  grid: number[];
  report: CriticReport | null;
  validating: boolean;
  error: string | null;
  onValidate: () => void;
}

function TransitionRow({ t }: { t: FootTransition }): React.JSX.Element {
  return (
    <div className={`foot-row${t.tooFast ? " foot-bad" : ""}`}>
      <span className={`foot-tag foot-${t.from.foot}`}>{t.from.foot}</span>
      <span className="foot-path">
        {t.from.pad}--{t.deltaMs}ms--&gt;{t.to.pad}
      </span>
      <span className={`foot-tag foot-${t.to.foot}`}>{t.to.foot}</span>
      {t.tooFast && <span className="badge badge-err">FAST</span>}
    </div>
  );
}

/**
 * Loaded-chart inspector: onset grid snap preview, L->R->L foot
 * transitions, violation badges, and the run-validator trigger.
 */
export function ChartPanel({
  chart,
  grid,
  report,
  validating,
  error,
  onValidate,
}: ChartPanelProps): React.JSX.Element {
  const transitions = footTransitions(chart);
  const shown = transitions.slice(0, 12);
  const worstSnap = chart.notes.reduce((worst, note) => {
    const d = nearestOnsetDelta(note.time_ms, grid);
    return d !== null && d > worst ? d : worst;
  }, 0);
  return (
    <section className="panel">
      <header className="panel-head">CHART INSPECTOR</header>
      <div className="kv">
        <span>TITLE</span>
        <b>{chart.title}</b>
      </div>
      <div className="kv">
        <span>NOTES</span>
        <b>{chart.notes.length}</b>
      </div>
      <div className="kv">
        <span>ONSET GRID</span>
        <b>
          {grid.length} pulses @ {chart.bpm} BPM
        </b>
      </div>
      <div className="kv">
        <span>WORST SNAP</span>
        <b className={worstSnap <= SNAP_TOLERANCE_MS ? "t-great" : "t-miss"}>
          {worstSnap.toFixed(0)}ms (tol +/-{SNAP_TOLERANCE_MS}ms)
        </b>
      </div>
      <div className="grid-strip" title="Onset grid (first 24 pulses)">
        {grid.slice(0, 24).map((onset) => (
          <i key={onset} className="grid-tick" style={{ height: 6 + (onset % 2000 === 0 ? 10 : 0) }} />
        ))}
      </div>
      {isPumpChart(chart) ? (
        <div className="foot-list">
          <div className="sub-head">
            FOOT PATH L/R ({transitions.length} transitions)
          </div>
          {shown.map((t) => (
            <TransitionRow key={`${t.from.index}-${t.to.index}`} t={t} />
          ))}
          {transitions.length > shown.length && (
            <div className="dim">
              +{transitions.length - shown.length} more...
            </div>
          )}
        </div>
      ) : (
        <div className="foot-list">
          <div className="sub-head">LANE SEQUENCE (4K)</div>
          <div className="dim">
            {chart.notes
              .slice(0, 24)
              .map((n) => n.lane ?? "-")
              .join(" ")}
            {chart.notes.length > 24 ? " ..." : ""}
          </div>
        </div>
      )}
      <button
        type="button"
        className="hw-btn"
        onClick={onValidate}
        disabled={validating}
      >
        {validating ? "VALIDATING..." : "RUN VALIDATOR"}
      </button>
      {error !== null && <div className="alert">{error}</div>}
      {report !== null && (
        <div className="violations">
          <div className="sub-head">
            REPORT: {report.passed ? "PASS" : "FAIL"} (snap{" "}
            {report.snap_violations} / parity {report.parity_violations} /
            density {report.density_violations})
          </div>
          {report.violations.length === 0 && (
            <div className="t-great">No violations. Chart is playable.</div>
          )}
          {report.violations.slice(0, 12).map((v, i) => (
            <span
              key={`${v.type}-${v.time_ms ?? "na"}-${i}`}
              className={`badge badge-${v.type} sev-${v.severity}`}
            >
              [{v.type}]{v.time_ms !== null ? ` @${v.time_ms}ms` : ""}{" "}
              {v.message}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
