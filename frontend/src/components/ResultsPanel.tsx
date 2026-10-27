import type { EngineSnapshot } from "../engine/engine";
import { bucketAccuracy, gradeForAccuracy } from "../engine/studio";
import type { Chart } from "../types/chart";

interface ResultsPanelProps {
  snap: EngineSnapshot | null;
  vocalAccuracy: number | null;
  mode: Chart["mode"];
  onClose: () => void;
  onReplay: () => void;
}

const PUMP_ORDER = ["Q", "E", "S", "Z", "C"];
const MANIA_LABELS = ["D", "F", "J", "K"];

/**
 * Bench-equipment results readout: grade, accuracy, max combo, vocal
 * pitch %, and a per-key judgment breakdown. Pure view over the engine
 * snapshot — shown on finish or toggled from the control deck.
 */
export function ResultsPanel({
  snap,
  vocalAccuracy,
  mode,
  onClose,
  onReplay,
}: ResultsPanelProps): React.JSX.Element {
  const judged = snap?.judged ?? 0;
  const acc = snap === null ? null : bucketAccuracy(snap.score.counts);
  const grade = acc === null ? "—" : gradeForAccuracy(acc);
  const keys =
    mode === "mania-4k"
      ? ["0", "1", "2", "3"]
      : PUMP_ORDER;
  const label = (k: string): string =>
    mode === "mania-4k" ? (MANIA_LABELS[Number(k)] ?? k) : k;

  return (
    <section className="panel results" aria-label="Run results readout">
      <header className="panel-head">RESULTS</header>
      <div className="telemetry-grid">
        <div className="meter">
          <span className="meter-label">GRADE</span>
          <span className="meter-value t-combo">{grade}</span>
        </div>
        <div className="meter">
          <span className="meter-label">ACCURACY</span>
          <span className="meter-value">
            {acc === null ? "—" : `${(acc * 100).toFixed(2)}%`}
          </span>
        </div>
        <div className="meter">
          <span className="meter-label">MAX COMBO</span>
          <span className="meter-value t-combo">
            {snap?.score.maxCombo ?? 0}
          </span>
        </div>
        <div className="meter">
          <span className="meter-label">VOCAL</span>
          <span className="meter-value">
            {vocalAccuracy === null ? "—" : `${vocalAccuracy.toFixed(0)}%`}
          </span>
        </div>
      </div>
      <div className="sub-head">
        PER-KEY BREAKDOWN ({judged} judged)
      </div>
      {keys.map((k) => {
        const counts = snap?.score.byKey[k];
        const kAcc = counts === undefined ? null : bucketAccuracy(counts);
        return (
          <div className="kv" key={k}>
            <span>
              [{label(k)}] P:{counts?.PERFECT ?? 0} G:{counts?.GREAT ?? 0} g:
              {counts?.GOOD ?? 0} M:{counts?.MISS ?? 0}
            </span>
            <b>{kAcc === null ? "—" : `${(kAcc * 100).toFixed(1)}%`}</b>
          </div>
        );
      })}
      <div className="transport" style={{ marginTop: 8 }}>
        <button type="button" className="hw-btn lit" onClick={onReplay}>
          PLAY AGAIN
        </button>
        <button type="button" className="hw-btn" onClick={onClose}>
          CLOSE
        </button>
      </div>
    </section>
  );
}
