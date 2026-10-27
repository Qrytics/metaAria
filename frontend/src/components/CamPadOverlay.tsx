import { useEffect, useRef, useState } from "react";
import { samSegment, type SamSegmentResult } from "../api";
import { PUMP_PADS, type ChartMode, type PumpPad } from "../types/chart";
import {
  blobsToPads,
  CAMPAD_ZONES,
  firePadHit,
  initialBlobs,
  PAD_FIRE_COOLDOWN_MS,
  stepBlobs,
  type SimBlob,
} from "./campad";

type CamMode = "SIM" | "CAM" | "OFF";

const OVERDRIVE_SECONDS = 8;
const FRAME_W = 480;
const FRAME_H = 300;

interface CamPadOverlayProps {
  chartMode: ChartMode;
  onOverdriveChange: (active: boolean) => void;
}

/**
 * SAM 3.1 Cam-Pad + Overdrive overlay: webcam picture-in-picture HUD with
 * virtual 5-pad hit zones and a raised-hands Overdrive pose detector.
 * SIM mode animates two tracked-hand blobs offline; CAM mode scans real
 * frames through `POST /vision/sam-segment` and renders neon mask overlays.
 * Pad hits fire through the real keyboard path, so they judge like key
 * presses. Overdrive holds the engine 2x score multiplier while active.
 */
export function CamPadOverlay({
  chartMode,
  onOverdriveChange,
}: CamPadOverlayProps): React.JSX.Element {
  const [camMode, setCamMode] = useState<CamMode>("SIM");
  const [prompt, setPrompt] = useState("hands and feet");
  const [result, setResult] = useState<SamSegmentResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [camLive, setCamLive] = useState(false);
  const [overdrive, setOverdrive] = useState(false);
  const [overdriveLeft, setOverdriveLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [camError, setCamError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const blobsRef = useRef<[SimBlob, SimBlob]>(initialBlobs());
  const flashesRef = useRef<Map<PumpPad, number>>(new Map());
  const lastFireRef = useRef<Map<string, number>>(new Map());
  const overdriveUntilRef = useRef(0);
  const overdriveRef = useRef(false);
  const overdriveCbRef = useRef(onOverdriveChange);
  overdriveCbRef.current = onOverdriveChange;

  const setOverdriveState = (active: boolean): void => {
    if (overdriveRef.current === active) {
      return;
    }
    overdriveRef.current = active;
    setOverdrive(active);
    overdriveCbRef.current(active);
  };

  const fireWithCooldown = (pad: PumpPad): void => {
    const now = performance.now();
    const last = lastFireRef.current.get(pad) ?? -Infinity;
    if (now - last < PAD_FIRE_COOLDOWN_MS) {
      return;
    }
    lastFireRef.current.set(pad, now);
    flashesRef.current.set(pad, now);
    firePadHit(pad);
  };

  const triggerOverdrive = (): void => {
    const now = performance.now();
    if (overdriveRef.current || now < overdriveUntilRef.current) {
      return;
    }
    overdriveUntilRef.current = now + OVERDRIVE_SECONDS * 1000;
    setOverdriveLeft(OVERDRIVE_SECONDS);
    setOverdriveState(true);
  };

  // SIM motion loop: two bouncing hand blobs sweep the pad zones.
  useEffect(() => {
    if (camMode !== "SIM") {
      return undefined;
    }
    let raf = 0;
    let last = performance.now();
    const tick = (now: number): void => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      blobsRef.current = stepBlobs(blobsRef.current, dt);
      const { pads } = blobsToPads(
        blobsRef.current[0],
        blobsRef.current[1],
      );
      for (const pad of pads) {
        fireWithCooldown(pad);
      }
      // No automatic pose arming here: SIM blobs sweep the top band as part
      // of normal motion, which would arm 2x scoring silently. Overdrive
      // arms only via the explicit OVERDRIVE POSE action below, or a real
      // sam-3.1 raised-hands pose in CAM mode.
      if (overdriveRef.current && now >= overdriveUntilRef.current) {
        setOverdriveState(false);
      }
      drawSimFrame();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
    // Fires stable helpers only; refs carry mutable state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camMode]);

  // Overdrive countdown readout.
  useEffect(() => {
    if (!overdrive) {
      return undefined;
    }
    const id = window.setInterval(() => {
      const left = Math.max(
        0,
        (overdriveUntilRef.current - performance.now()) / 1000,
      );
      setOverdriveLeft(left);
      if (left <= 0) {
        setOverdriveState(false);
      }
    }, 200);
    return () => {
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overdrive]);

  // CAM mode: own the webcam stream, release it on mode change/unmount.
  useEffect(() => {
    if (camMode !== "CAM") {
      return undefined;
    }
    let cancelled = false;
    setCamError(null);
    const start = async (): Promise<void> => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 480, height: 300 },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video !== null) {
          video.srcObject = stream;
          await video.play().catch(() => undefined);
          if (!cancelled) {
            setCamLive(true);
          }
        }
      } catch (e) {
        if (!cancelled) {
          setCamError(e instanceof Error ? e.message : String(e));
        }
      }
    };
    void start();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setCamLive(false);
    };
  }, [camMode]);

  const drawSimFrame = (): void => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      return;
    }
    const now = performance.now();
    ctx.fillStyle = "#05070c";
    ctx.fillRect(0, 0, FRAME_W, FRAME_H);
    for (const z of CAMPAD_ZONES) {
      const flash = flashesRef.current.get(z.pad) ?? -Infinity;
      const lit = now - flash < 180;
      ctx.strokeStyle = lit ? "#ffb000" : "#2a3342";
      ctx.lineWidth = lit ? 3 : 1;
      ctx.strokeRect(z.x * FRAME_W, z.y * FRAME_H, z.w * FRAME_W, z.h * FRAME_H);
      ctx.fillStyle = lit ? "#ffb000" : "#7d8aa0";
      ctx.font = "12px monospace";
      ctx.fillText(z.pad, z.x * FRAME_W + 6, z.y * FRAME_H + 16);
    }
    // Shoulder line: everything above it counts as a raised hand.
    ctx.strokeStyle = "#a78bfa";
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(0, 0.3 * FRAME_H);
    ctx.lineTo(FRAME_W, 0.3 * FRAME_H);
    ctx.stroke();
    ctx.setLineDash([]);
    const colors = ["#22d3ee", "#fb923c"];
    blobsRef.current.forEach((b, i) => {
      ctx.save();
      ctx.shadowColor = colors[i] ?? "#fff";
      ctx.shadowBlur = 18;
      ctx.fillStyle = colors[i] ?? "#fff";
      ctx.beginPath();
      ctx.arc(b.x * FRAME_W, b.y * FRAME_H, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  };

  const raiseBothHands = (): void => {
    // Simulate the raise: blobs visibly jump above the shoulder line, and
    // the explicit button press arms the 2x multiplier — never the sweep.
    blobsRef.current = [
      { ...blobsRef.current[0], x: 0.18, y: 0.12, vy: -0.2 },
      { ...blobsRef.current[1], x: 0.82, y: 0.12, vy: -0.2 },
    ];
    triggerOverdrive();
  };

  const scanFrame = async (scanPrompt: string): Promise<void> => {
    const video = videoRef.current;
    if (video === null || video.videoWidth === 0) {
      setError("Camera not ready yet — wait for the PiP preview.");
      return;
    }
    setScanning(true);
    setError(null);
    try {
      const cap = document.createElement("canvas");
      cap.width = FRAME_W;
      cap.height = FRAME_H;
      const ctx = cap.getContext("2d");
      if (ctx === null) {
        throw new Error("2d canvas unavailable");
      }
      ctx.drawImage(video, 0, 0, FRAME_W, FRAME_H);
      const b64 = cap.toDataURL("image/jpeg", 0.7).split(",")[1] ?? "";
      const seg = await samSegment(scanPrompt, chartMode, b64);
      setResult(seg);
      for (const zone of seg.hit_zones) {
        if (zone.triggered && (PUMP_PADS as readonly string[]).includes(zone.pad)) {
          fireWithCooldown(zone.pad as PumpPad);
        }
      }
      if (seg.overdrive_active) {
        triggerOverdrive();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  };

  const switchMode = (m: CamMode): void => {
    setCamMode(m);
    setError(null);
    setResult(null);
  };

  return (
    <section className="panel" aria-label="SAM 3.1 cam-pad and overdrive">
      <header className="panel-head">
        <span className="led" data-on={camMode !== "OFF" || overdrive} />
        SAM 3.1 CAM-PAD + OVERDRIVE
      </header>
      <div className="transport">
        <div className="mode-switch" role="group" aria-label="Cam-pad source">
          {(["SIM", "CAM", "OFF"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={camMode === m}
              onClick={() => switchMode(m)}
            >
              {m}
            </button>
          ))}
        </div>
        {overdrive ? (
          <span className="badge badge-critic sev-error" role="status">
            OVERDRIVE x2 · {overdriveLeft.toFixed(1)}s
          </span>
        ) : (
          <span className="dim">raise both hands for 2x</span>
        )}
      </div>
      {camMode === "SIM" && (
        <div style={{ marginTop: 8 }}>
          <canvas
            ref={canvasRef}
            width={FRAME_W}
            height={FRAME_H}
            className="campad-frame"
            aria-label="Simulated hand tracking over 5 pad zones"
          />
          <div className="transport" style={{ marginTop: 8 }}>
            <button type="button" className="hw-btn" onClick={raiseBothHands}>
              OVERDRIVE POSE
            </button>
            <span className="dim">SIM blobs sweep Q/E/S/Z/C offline</span>
          </div>
        </div>
      )}
      {camMode === "CAM" && (
        <div style={{ marginTop: 8 }}>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            ref={videoRef}
            width={FRAME_W}
            height={FRAME_H}
            muted
            playsInline
            className="campad-frame"
            aria-label="Webcam picture-in-picture"
          />
          {!camLive && camError === null && (
            <div className="dim" style={{ marginTop: 8 }}>
              No camera signal — allow webcam access, or play the SIM blobs
              offline.
            </div>
          )}
          {result !== null && (
            <svg
              viewBox="0 0 1 1"
              className="campad-masks"
              aria-label="Segmentation mask overlays"
            >
              {result.masks.map((m, i) => (
                <polygon
                  key={`${m.label}-${i}`}
                  points={m.polygon.map((p) => p.join(",")).join(" ")}
                  fill="none"
                  stroke="#22d3ee"
                  strokeWidth={0.008}
                />
              ))}
              {result.boxes.map((b, i) => (
                <rect
                  key={`${b.label}-box-${i}`}
                  x={b.x}
                  y={b.y}
                  width={b.w}
                  height={b.h}
                  fill="none"
                  stroke="#ffb000"
                  strokeWidth={0.006}
                />
              ))}
            </svg>
          )}
          <label className="field" style={{ marginTop: 8 }}>
            <span>TRACK PROMPT</span>
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              spellCheck={false}
            />
          </label>
          <div className="transport">
            <button
              type="button"
              className="hw-btn primary"
              disabled={scanning}
              onClick={() => void scanFrame(prompt)}
            >
              {scanning ? "SCANNING..." : "SCAN FRAME"}
            </button>
            <button
              type="button"
              className="hw-btn"
              disabled={scanning}
              onClick={() => void scanFrame("raised hands overdrive pose")}
            >
              POSE CHECK
            </button>
            {result?.mock === true && <span className="dim">MOCK $0</span>}
          </div>
          {camError !== null && <div className="alert">{camError}</div>}
        </div>
      )}
      {camMode === "OFF" && (
        <div className="dim" style={{ marginTop: 8 }}>
          Cam-pad off. Keyboard (Q/E/S/Z/C · D/F/J/K) still live.
        </div>
      )}
      {error !== null && <div className="alert">{error}</div>}
    </section>
  );
}
