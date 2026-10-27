import { useEffect, useRef, useState } from "react";
import { samSegment, type SamSegmentResult } from "../api";
import { PUMP_PADS, type ChartMode, type PumpPad } from "../types/chart";
import {
  blobsToPads,
  CAMPAD_ZONES,
  firePadHit,
  holdProgress,
  initialBlobs,
  MOTION_FIRE_THRESHOLD,
  OVERDRIVE_HOLD_MS,
  PAD_FIRE_COOLDOWN_MS,
  padsAboveThreshold,
  raisedHandsFromEnergies,
  stepBlobs,
  type PadEnergies,
  type SimBlob,
} from "./campad";

type CamMode = "SIM" | "CAM" | "OFF";

type CamState = "idle" | "starting" | "live" | "denied" | "missing" | "error";

const OVERDRIVE_SECONDS = 8;
const FRAME_W = 480;
const FRAME_H = 300;
/** Low-res motion sampler: 96x60 luma diffs, cheap enough at 30fps. */
const SAMPLE_W = 96;
const SAMPLE_H = 60;
/** EMA smoothing for per-zone motion energy (0..1). */
const EMA_ALPHA = 0.35;
/** HUD text refresh interval; the canvas itself redraws every frame. */
const HUD_HZ_MS = 200;
/** AI box overlays linger this long after an AI VERIFY snapshot. */
const AI_BOX_TTL_MS = 2500;

function emptyEnergies(): PadEnergies {
  return { Q: 0, E: 0, S: 0, Z: 0, C: 0 };
}

function friendlyCamError(e: unknown): { state: CamState; msg: string } {
  const name = e instanceof DOMException ? e.name : "";
  const raw = e instanceof Error ? e.message : String(e);
  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      state: "denied",
      msg: "Camera blocked — click the camera icon in the address bar, allow access, then reopen CAM. (macOS: System Settings → Privacy → Camera.)",
    };
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return {
      state: "missing",
      msg: "No camera found with those settings — pick another device or reconnect it, then reopen CAM.",
    };
  }
  return { state: "error", msg: `Camera failed: ${raw}` };
}

interface CamPadOverlayProps {
  chartMode: ChartMode;
  onOverdriveChange: (active: boolean) => void;
}

/**
 * SAM 3.1 Cam-Pad + Overdrive overlay: mirror-view webcam HUD with virtual
 * 5-pad hit zones and a raised-hands Overdrive pose detector.
 * SIM mode animates two tracked-hand blobs offline; CAM mode runs a
 * continuous client-side motion tracker (frame differencing, no network)
 * that fires pads and arms Overdrive while both hands stay in the top
 * corners. `AI VERIFY` takes one backend `sam-3.1` snapshot as a second
 * opinion. Pad hits fire through the real keyboard path, so they judge
 * like key presses. Overdrive holds the engine 2x score multiplier.
 */
export function CamPadOverlay({
  chartMode,
  onOverdriveChange,
}: CamPadOverlayProps): React.JSX.Element {
  const [camMode, setCamMode] = useState<CamMode>("SIM");
  const [prompt, setPrompt] = useState("hands and feet");
  const [result, setResult] = useState<SamSegmentResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [camState, setCamState] = useState<CamState>("idle");
  const [overdrive, setOverdrive] = useState(false);
  const [overdriveLeft, setOverdriveLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [camError, setCamError] = useState<string | null>(null);
  // Continuous-tracker controls: device picker, motion sensitivity, live HUD.
  const [devices, setDevices] = useState<Array<{ id: string; label: string }>>(
    [],
  );
  const [deviceId, setDeviceId] = useState("auto");
  const [sensitivity, setSensitivity] = useState(MOTION_FIRE_THRESHOLD);
  const [calibrating, setCalibrating] = useState(false);
  const [hud, setHud] = useState({ fps: 0, motion: 0, progress: 0 });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const camCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const blobsRef = useRef<[SimBlob, SimBlob]>(initialBlobs());
  const flashesRef = useRef<Map<PumpPad, number>>(new Map());
  const lastFireRef = useRef<Map<string, number>>(new Map());
  const overdriveUntilRef = useRef(0);
  const overdriveRef = useRef(false);
  const overdriveCbRef = useRef(onOverdriveChange);
  overdriveCbRef.current = onOverdriveChange;
  // Continuous-tracker refs (hot loop state; HUD mirrors a subset to React).
  const energiesRef = useRef<PadEnergies>(emptyEnergies());
  const prevLumaRef = useRef<Uint8Array | null>(null);
  const zoneOfCellRef = useRef<Int8Array | null>(null);
  const poseSinceRef = useRef<number | null>(null);
  const aiBoxesRef = useRef<{ boxes: SamSegmentResult["boxes"]; until: number }>(
    { boxes: [], until: 0 },
  );
  const calibrateRef = useRef<{ peak: number; frames: number } | null>(null);
  const hudLastRef = useRef(0);
  const fpsCountRef = useRef(0);
  const fpsTimeRef = useRef(0);
  const sensitivityRef = useRef(sensitivity);
  sensitivityRef.current = sensitivity;

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

  // CAM mode: own the webcam stream, release it on mode/device change.
  // The picker exists because Macs often expose 2+ cameras (FaceTime +
  // Continuity/iPhone); the old code always grabbed the default and gave up.
  useEffect(() => {
    if (camMode !== "CAM") {
      setCamState("idle");
      return undefined;
    }
    let cancelled = false;
    setCamError(null);
    setCamState("starting");

    const refreshDevices = (): void => {
      navigator.mediaDevices
        .enumerateDevices()
        .then((all) => {
          if (cancelled) {
            return;
          }
          const cams = all
            .filter((d) => d.kind === "videoinput")
            .map((d, i) => ({
              id: d.deviceId,
              label: d.label || `Camera ${i + 1}`,
            }));
          if (cams.length > 0) {
            setDevices(cams);
          }
        })
        .catch(() => undefined);
    };
    refreshDevices();
    navigator.mediaDevices.addEventListener?.("devicechange", refreshDevices);

    const attach = (stream: MediaStream): void => {
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      prevLumaRef.current = null;
      energiesRef.current = emptyEnergies();
      poseSinceRef.current = null;
      const video = videoRef.current;
      if (video === null) {
        setCamState("live");
        return;
      }
      video.srcObject = stream;
      video
        .play()
        .then(() => {
          if (!cancelled) {
            setCamState("live");
            refreshDevices(); // labels unlock after permission is granted
          }
        })
        .catch(() => {
          if (!cancelled) {
            setCamState("live"); // draw loop reports readiness itself
          }
        });
    };

    const start = async (): Promise<void> => {
      try {
        if (deviceId !== "auto") {
          try {
            attach(
              await navigator.mediaDevices.getUserMedia({
                video: {
                  deviceId: { exact: deviceId },
                  width: { ideal: 640 },
                  height: { ideal: 480 },
                },
                audio: false,
              }),
            );
            return;
          } catch {
            // Exact-device match failed (unplugged Continuity cam etc):
            // fall through to the default camera instead of dying.
          }
        }
        attach(
          await navigator.mediaDevices.getUserMedia({
            video: {
              width: { ideal: 640 },
              height: { ideal: 480 },
              facingMode: "user",
            },
            audio: false,
          }),
        );
      } catch (e) {
        if (!cancelled) {
          const friendly = friendlyCamError(e);
          setCamError(friendly.msg);
          setCamState(friendly.state);
        }
      }
    };
    void start();
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener?.(
        "devicechange",
        refreshDevices,
      );
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [camMode, deviceId]);

  // CAM mode: continuous local motion tracker. Mirror-view frame
  // differencing runs fully client-side at ~30fps — no button presses, no
  // network round-trip — so hands-up actually registers while held. The
  // backend SAM call survives only as a manual AI VERIFY snapshot.
  useEffect(() => {
    if (camMode !== "CAM") {
      return undefined;
    }
    if (zoneOfCellRef.current === null) {
      const map = new Int8Array(SAMPLE_W * SAMPLE_H).fill(-1);
      for (let j = 0; j < SAMPLE_H; j += 1) {
        for (let i = 0; i < SAMPLE_W; i += 1) {
          const nx = (i + 0.5) / SAMPLE_W;
          const ny = (j + 0.5) / SAMPLE_H;
          for (let k = 0; k < CAMPAD_ZONES.length; k += 1) {
            const z = CAMPAD_ZONES[k];
            if (
              z !== undefined &&
              nx >= z.x &&
              nx <= z.x + z.w &&
              ny >= z.y &&
              ny <= z.y + z.h
            ) {
              map[j * SAMPLE_W + i] = k;
              break;
            }
          }
        }
      }
      zoneOfCellRef.current = map;
    }
    const sampler = document.createElement("canvas");
    sampler.width = SAMPLE_W;
    sampler.height = SAMPLE_H;
    const sctx = sampler.getContext("2d", { willReadFrequently: true });
    let raf = 0;
    let tickN = 0;
    fpsTimeRef.current = performance.now();
    fpsCountRef.current = 0;
    hudLastRef.current = 0;

    const updateEnergies = (data: Uint8ClampedArray): void => {
      const n = SAMPLE_W * SAMPLE_H;
      const prev = prevLumaRef.current;
      if (prev === null || prev.length !== n) {
        // First sample after (re)connect: seed the baseline, skip the spike.
        const seed = new Uint8Array(n);
        for (let p = 0; p < n; p += 1) {
          const o = p * 4;
          seed[p] =
            (data[o]! * 0.299 + data[o + 1]! * 0.587 + data[o + 2]! * 0.114) |
            0;
        }
        prevLumaRef.current = seed;
        return;
      }
      const zonemap = zoneOfCellRef.current;
      if (zonemap === null) {
        return;
      }
      const sums = [0, 0, 0, 0, 0];
      const counts = [0, 0, 0, 0, 0];
      for (let p = 0; p < n; p += 1) {
        const o = p * 4;
        const luma =
          (data[o]! * 0.299 + data[o + 1]! * 0.587 + data[o + 2]! * 0.114) | 0;
        const d = Math.abs(luma - prev[p]!);
        prev[p] = luma;
        const zi = zonemap[p]!;
        if (zi >= 0) {
          sums[zi]! += d;
          counts[zi]! += 1;
        }
      }
      const next = emptyEnergies();
      CAMPAD_ZONES.forEach((z, k) => {
        const mean = counts[k]! > 0 ? sums[k]! / counts[k]! / 255 : 0;
        const e = energiesRef.current[z.pad];
        next[z.pad] = e + EMA_ALPHA * (mean - e);
      });
      energiesRef.current = next;
    };

    const drawOverlays = (
      ctx: CanvasRenderingContext2D,
      now: number,
      progress: number,
      pose: boolean,
    ): void => {
      const nowMs = performance.now();
      for (const z of CAMPAD_ZONES) {
        const energy = energiesRef.current[z.pad];
        const flash = flashesRef.current.get(z.pad) ?? -Infinity;
        const lit = nowMs - flash < 180;
        const hot = energy >= sensitivityRef.current;
        ctx.strokeStyle = lit ? "#ffb000" : hot ? "#22d3ee" : "#2a3342";
        ctx.lineWidth = lit || hot ? 3 : 1;
        ctx.globalAlpha = 0.35 + Math.min(0.65, energy * 3);
        ctx.strokeRect(z.x * FRAME_W, z.y * FRAME_H, z.w * FRAME_W, z.h * FRAME_H);
        ctx.globalAlpha = 1;
        ctx.fillStyle = lit ? "#ffb000" : hot ? "#22d3ee" : "#7d8aa0";
        ctx.font = "12px monospace";
        ctx.fillText(z.pad, z.x * FRAME_W + 6, z.y * FRAME_H + 16);
      }
      // Shoulder line: the bottom edge of the two upper zones.
      ctx.strokeStyle = "#a78bfa";
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(0, 0.33 * FRAME_H);
      ctx.lineTo(FRAME_W, 0.33 * FRAME_H);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#a78bfa";
      ctx.font = "11px monospace";
      ctx.fillText("HANDS UP = TOP CORNERS", 8, 0.33 * FRAME_H - 6);
      // Hold-to-arm progress bar.
      if (pose || progress > 0) {
        ctx.fillStyle = "#1a2230";
        ctx.fillRect(8, FRAME_H - 22, FRAME_W - 16, 12);
        ctx.fillStyle = progress >= 1 ? "#4ade80" : "#ffb000";
        ctx.fillRect(8, FRAME_H - 22, (FRAME_W - 16) * progress, 12);
        ctx.fillStyle = "#d7dee8";
        ctx.font = "10px monospace";
        ctx.fillText(
          progress >= 1 ? "OVERDRIVE ARMED" : "HOLD POSE…",
          12,
          FRAME_H - 12,
        );
      }
      // AI VERIFY boxes (backend coords are unmirrored: flip x for our view).
      const ai = aiBoxesRef.current;
      if (now < ai.until) {
        ctx.strokeStyle = "#ffb000";
        ctx.lineWidth = 1;
        for (const b of ai.boxes) {
          const fx = 1 - b.x - b.w;
          ctx.strokeRect(fx * FRAME_W, b.y * FRAME_H, b.w * FRAME_W, b.h * FRAME_H);
        }
      }
      if (calibrateRef.current !== null) {
        ctx.fillStyle = "#ffb000";
        ctx.font = "bold 14px monospace";
        ctx.fillText("STAY STILL — CALIBRATING…", 16, 28);
      }
    };

    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick);
      const video = videoRef.current;
      const canvas = camCanvasRef.current;
      if (canvas === null) {
        return;
      }
      const ctx = canvas.getContext("2d");
      if (ctx === null) {
        return;
      }
      if (video === null || video.videoWidth === 0 || video.readyState < 2) {
        ctx.fillStyle = "#05070c";
        ctx.fillRect(0, 0, FRAME_W, FRAME_H);
        ctx.fillStyle = "#7d8aa0";
        ctx.font = "12px monospace";
        ctx.fillText("OPENING CAMERA…", 16, FRAME_H / 2);
        return;
      }
      // Mirror view: screen-left is YOUR left hand (Q/Z side).
      ctx.save();
      ctx.scale(-1, 1);
      ctx.drawImage(video, -FRAME_W, 0, FRAME_W, FRAME_H);
      ctx.restore();

      tickN += 1;
      if (sctx !== null && tickN % 2 === 0) {
        sctx.save();
        sctx.scale(-1, 1);
        sctx.drawImage(video, -SAMPLE_W, 0, SAMPLE_W, SAMPLE_H);
        sctx.restore();
        updateEnergies(sctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data);
      }

      const threshold = sensitivityRef.current;
      const energies = energiesRef.current;
      for (const pad of padsAboveThreshold(energies, threshold)) {
        fireWithCooldown(pad);
      }

      const pose = raisedHandsFromEnergies(energies, threshold);
      if (pose) {
        if (poseSinceRef.current === null) {
          poseSinceRef.current = now;
        }
      } else {
        poseSinceRef.current = null;
      }
      const held = poseSinceRef.current === null ? 0 : now - poseSinceRef.current;
      const progress = holdProgress(held, OVERDRIVE_HOLD_MS);
      if (pose && held >= OVERDRIVE_HOLD_MS) {
        // Keep-overdrive-alive: re-arms after expiry while hands stay up.
        triggerOverdrive();
        poseSinceRef.current = now;
      }

      const cal = calibrateRef.current;
      if (cal !== null) {
        const peak = Math.max(
          energies.Q,
          energies.E,
          energies.S,
          energies.Z,
          energies.C,
        );
        cal.peak = Math.max(cal.peak, peak);
        cal.frames += 1;
        if (cal.frames >= 45) {
          setSensitivity(Math.min(0.5, Math.max(0.05, cal.peak + 0.08)));
          calibrateRef.current = null;
          setCalibrating(false);
        }
      }

      drawOverlays(ctx, now, progress, pose);

      fpsCountRef.current += 1;
      if (now - hudLastRef.current >= HUD_HZ_MS) {
        const dt = (now - fpsTimeRef.current) / 1000;
        const fps = dt > 0 ? fpsCountRef.current / dt : 0;
        fpsCountRef.current = 0;
        fpsTimeRef.current = now;
        hudLastRef.current = now;
        const motion = Math.max(
          energies.Q,
          energies.E,
          energies.S,
          energies.Z,
          energies.C,
        );
        const rounded = Math.round(fps);
        setHud((h) =>
          Math.abs(h.motion - motion) < 0.01 &&
          Math.abs(h.progress - progress) < 0.02 &&
          h.fps === rounded
            ? h
            : { fps: rounded, motion, progress },
        );
      }
      if (overdriveRef.current && now >= overdriveUntilRef.current) {
        setOverdriveState(false);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
    // Hot-loop refs carry mutable state; helpers are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Manual AI snapshot: one backend SAM 3.1 pass over the current frame.
  // The continuous tracker above is the real gameplay input; this is a
  // second opinion whose boxes linger on the canvas for a few seconds.
  const scanFrame = async (scanPrompt: string): Promise<void> => {
    const video = videoRef.current;
    if (video === null || video.videoWidth === 0) {
      setError("Camera not ready yet — wait for the live preview.");
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
      aiBoxesRef.current = {
        boxes: seg.boxes,
        until: performance.now() + AI_BOX_TTL_MS,
      };
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

  const startCalibration = (): void => {
    if (camState !== "live") {
      setError("Start the camera first, then calibrate on a still frame.");
      return;
    }
    calibrateRef.current = { peak: 0, frames: 0 };
    setCalibrating(true);
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
          {/* Hidden capture element; the canvas below is the mirror preview. */}
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            ref={videoRef}
            muted
            playsInline
            autoPlay
            style={{ display: "none" }}
            aria-hidden="true"
          />
          <canvas
            ref={camCanvasRef}
            width={FRAME_W}
            height={FRAME_H}
            className="campad-frame"
            aria-label="Mirrored webcam with live motion zones"
          />
          <div className="readout" role="status" style={{ marginTop: 8 }}>
            <span>
              {camState === "live"
                ? `LIVE · ${hud.fps}fps`
                : camState === "starting"
                  ? "OPENING…"
                  : camState.toUpperCase()}
            </span>
            <span className="dim">
              {devices.length > 1
                ? `${devices.length} cameras`
                : "mirror view · your left = Q/Z"}
            </span>
          </div>
          <div className="campad-meter" aria-hidden="true">
            <div
              className="campad-meter-fill"
              style={{ width: `${Math.min(100, hud.motion * 300)}%` }}
            />
            <div
              className="campad-meter-threshold"
              style={{ left: `${Math.min(100, sensitivity * 300)}%` }}
            />
          </div>
          <div className="kv" style={{ marginTop: 4 }}>
            <span>MOTION vs THRESHOLD</span>
            <b>
              {hud.motion.toFixed(2)} / {sensitivity.toFixed(2)}
            </b>
          </div>
          {devices.length > 1 && (
            <label className="field" style={{ marginTop: 8 }}>
              <span>CAMERA</span>
              <select
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
              >
                <option value="auto">Auto (default camera)</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="slider" style={{ marginTop: 8 }}>
            SENSITIVITY {sensitivity.toFixed(2)}
            <input
              type="range"
              min={0.05}
              max={0.5}
              step={0.01}
              value={sensitivity}
              onChange={(e) => setSensitivity(Number(e.target.value))}
              aria-label="Motion sensitivity"
            />
          </label>
          <div className="transport" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="hw-btn"
              disabled={calibrating || camState !== "live"}
              onClick={startCalibration}
            >
              {calibrating ? "STAY STILL…" : "CALIBRATE"}
            </button>
            <span className="dim">
              Sit still, hit CALIBRATE — threshold tunes to your room.
            </span>
          </div>
          <label className="field" style={{ marginTop: 8 }}>
            <span>AI VERIFY PROMPT (SAM 3.1 SNAPSHOT)</span>
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
              disabled={scanning || camState !== "live"}
              onClick={() => void scanFrame(prompt)}
            >
              {scanning ? "SCANNING..." : "AI VERIFY"}
            </button>
            {result?.mock === true && (
              <span className="dim">MOCK $0 — snapshot only, tracker is live</span>
            )}
          </div>
          <div className="dim" style={{ marginTop: 8 }}>
            Raise both hands into the TOP CORNERS and hold — the bar fills,
            then OVERDRIVE x2 arms. Keep them up to hold it. Wave inside any
            zone to fire that pad.
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
