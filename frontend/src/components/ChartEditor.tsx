import { useEffect, useRef } from "react";
import { keyToLane, keyToPad } from "../engine/input";
import type { NoteMark } from "../engine/renderer";
import type { Chart, CriticReport, ManiaLane, PumpPad } from "../types/chart";

interface ChartEditorProps {
  editing: boolean;
  active: boolean;
  chart: Chart;
  grid: number[];
  cursorMs: number;
  markers: ReadonlyMap<number, NoteMark[]>;
  report: CriticReport | null;
  validating: boolean;
  validateError: string | null;
  repairBusy: boolean;
  repairError: string | null;
  repairLog: string[] | null;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canRevert: boolean;
  importError: string | null;
  onToggleEdit: () => void;
  onScrub: (step: number) => void;
  onToggleKey: (key: ManiaLane | PumpPad) => void;
  onMirror: () => void;
  onHalve: () => void;
  onDouble: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onValidate: () => void;
  onRepair: () => void;
  onJumpToViolation: (timeMs: number) => void;
  onExport: () => void;
  onImportFile: (file: File) => void;
  onRevert: () => void;
}

function isTypingTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement
  );
}

/**
 * The studio only trusts physical keys. The SAM cam-pad SIM/CAM loop replays
 * air-pad hits as synthetic `window` KeyboardEvents (see `firePadHit` in
 * campad.ts) so they judge through the engine's live keyboard path — but those
 * same events must never toggle notes, scrub the cursor, or flip studio
 * panels while stepping a chart.
 */
export function acceptsStudioKey(e: Pick<KeyboardEvent, "isTrusted">): boolean {
  return e.isTrusted;
}

/**
 * Stage 4 paused step-sequencer. All shortcuts are dead while PLAY runs —
 * this panel is purely a view until `active` (EDIT + paused) holds.
 */
export function ChartEditor(props: ChartEditorProps): React.JSX.Element {
  const {
    editing,
    active,
    chart,
    grid,
    cursorMs,
    markers,
    report,
    validating,
    validateError,
    repairBusy,
    repairError,
    repairLog,
    dirty,
    canUndo,
    canRedo,
    canRevert,
    importError,
  } = props;
  const ref = useRef(props);
  ref.current = props;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const p = ref.current;
      if (!acceptsStudioKey(e)) {
        return;
      }
      if (e.key === "F2") {
        e.preventDefault();
        p.onToggleEdit();
        return;
      }
      if (e.key === "Escape") {
        if (p.editing) {
          p.onToggleEdit();
        }
        return;
      }
      if (!p.active || isTypingTarget(e)) {
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          p.onRedo();
        } else {
          p.onUndo();
        }
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        p.onRedo();
        return;
      }
      if (mod) {
        return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const dir = e.key === "ArrowDown" ? 1 : -1;
        p.onScrub(e.shiftKey ? dir * 4 : dir);
        return;
      }
      if (e.repeat) {
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "m") {
        p.onMirror();
        return;
      }
      if (k === "h") {
        p.onHalve();
        return;
      }
      if (k === "2") {
        p.onDouble();
        return;
      }
      if (k === "v") {
        p.onValidate();
        return;
      }
      if (k === "r") {
        p.onRepair();
        return;
      }
      const lane = keyToLane(e.key);
      const pad = keyToPad(e.key);
      if (chart.mode === "mania-4k" && lane !== null) {
        p.onToggleKey(lane);
      } else if (chart.mode === "pump-5pad" && pad !== null) {
        p.onToggleKey(pad);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const gridIdx = grid.indexOf(cursorMs);
  const markRows = [...markers.entries()].map(([idx, arr]) => ({
    idx,
    timeMs: chart.notes[idx]?.time_ms ?? 0,
    arr,
  }));

  return (
    <section className="panel" aria-label="Chart studio editor">
      <header className="panel-head">
        <span className="led" data-on={editing} />
        CHART STUDIO {dirty ? <span className="badge">EDITED</span> : null}
      </header>
      <div className="transport">
        <button type="button" className="hw-btn primary" onClick={props.onToggleEdit}>
          {editing ? "EXIT EDIT [F2]" : "EDIT [F2]"}
        </button>
        {!active && editing && (
          <span className="dim">Paused required — press PLAY to exit edit.</span>
        )}
      </div>
      {editing && (
        <div style={{ marginTop: 8 }}>
          <div className="kv">
            <span>CURSOR</span>
            <b>
              {gridIdx >= 0 ? `${gridIdx + 1}/${grid.length}` : "—"} · {cursorMs}ms
            </b>
          </div>
          <div className="transport" style={{ marginTop: 8 }}>
            <button type="button" className="hw-btn" onClick={() => props.onScrub(-1)}>
              STEP- [↑]
            </button>
            <button type="button" className="hw-btn" onClick={() => props.onScrub(1)}>
              STEP+ [↓]
            </button>
            <span className="dim">Shift = 4x · wheel on highway</span>
          </div>
          <div className="transport" style={{ marginTop: 8 }}>
            <button type="button" className="hw-btn" onClick={props.onMirror}>
              MIRROR [M]
            </button>
            <button type="button" className="hw-btn" onClick={props.onHalve}>
              HALVE [H]
            </button>
            <button type="button" className="hw-btn" onClick={props.onDouble}>
              DOUBLE [2]
            </button>
          </div>
          <div className="transport" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="hw-btn"
              onClick={props.onUndo}
              disabled={!canUndo}
            >
              UNDO [^Z]
            </button>
            <button
              type="button"
              className="hw-btn"
              onClick={props.onRedo}
              disabled={!canRedo}
            >
              REDO [^Y]
            </button>
            <span className="dim">
              {chart.mode === "mania-4k"
                ? "D/F/J/K toggles lanes"
                : "Q/E/S/Z/C toggles pads"}
              {" · click lanes on canvas"}
            </span>
          </div>
          <div className="transport" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="hw-btn"
              onClick={props.onValidate}
              disabled={validating || !active}
            >
              {validating ? "VALIDATING..." : "VALIDATE [V]"}
            </button>
            <button
              type="button"
              className="hw-btn primary"
              onClick={props.onRepair}
              disabled={repairBusy || !active}
            >
              {repairBusy ? "REPAIRING..." : "CRITIC REPAIR [R]"}
            </button>
          </div>
          {validateError !== null && <div className="alert">{validateError}</div>}
          {repairError !== null && <div className="alert">{repairError}</div>}
          {report !== null && (
            <div className="kv" style={{ marginTop: 8 }}>
              <span>REPORT</span>
              <b className={report.passed ? "t-great" : "t-miss"}>
                {report.passed ? "PASS" : "FAIL"}
              </b>
            </div>
          )}
          {markRows.length > 0 && (
            <div className="violations">
              <div className="sub-head">MARKERS (click to jump cursor)</div>
              {markRows.slice(0, 12).map(({ idx, timeMs, arr }) => (
                <button
                  key={idx}
                  type="button"
                  className={`badge badge-${arr[0]?.severity === "error" ? "err" : "snap"}`}
                  onClick={() => props.onJumpToViolation(timeMs)}
                  title={arr.map((a) => a.text).join(" · ")}
                >
                  @{timeMs}ms {arr[0]?.text.slice(0, 32)}
                </button>
              ))}
            </div>
          )}
          {repairLog !== null && (
            <div className="violations">
              <div className="sub-head">CRITIC DIFF</div>
              {repairLog.slice(0, 10).map((line) => (
                <span key={line} className="badge">
                  {line.slice(0, 48)}
                </span>
              ))}
            </div>
          )}
          <div className="sub-head">PORTABLE PACKS</div>
          <div className="transport">
            <button type="button" className="hw-btn" onClick={props.onExport}>
              EXPORT .ARIA.JSON
            </button>
            <label className="hw-btn" style={{ cursor: "pointer" }}>
              IMPORT .ARIA.JSON
              <input
                type="file"
                accept=".json,.aria.json,application/json"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f !== undefined) {
                    props.onImportFile(f);
                  }
                }}
              />
            </label>
            {canRevert && (
              <button type="button" className="hw-btn" onClick={props.onRevert}>
                REVERT TO STOCK
              </button>
            )}
          </div>
          {importError !== null && <div className="alert">{importError}</div>}
          <div className="dim" style={{ marginTop: 8 }}>
            Drop an .aria.json anywhere on the chassis to import. Autosaves
            while edited.
          </div>
        </div>
      )}
    </section>
  );
}
