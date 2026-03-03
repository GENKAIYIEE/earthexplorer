import { Suspense, useRef, useEffect } from "react";
import useHandTracking from "./hooks/useHandTracking";
import GlobeScene from "./components/GlobeScene";
import "./index.css";

// ════════════════════════════════════════════════════════════════
//  PERFORMANCE-OPTIMIZED APP
//
//  ⚡ PERF: This component only re-renders when hudGesture changes
//  (~4 fps from the HUD throttle). The 3D scene and hand tracking
//  overlay run entirely off refs and requestAnimationFrame.
// ════════════════════════════════════════════════════════════════

// Fingertip indices for rendering dots
const LANDMARK_INDICES = [4, 8, 12, 16, 20];

const GESTURE_DISPLAY = {
  PINCH_ZOOM: { icon: "🤏", label: "ZOOM ↕", color: "#22d3ee" },
  INDEX_MOVE: { icon: "☝️", label: "MOVE", color: "#a855f7" },
  OPEN_PALM: { icon: "🖐️", label: "AUTO-ROTATE", color: "#34d399" },
  FIST: { icon: "✊", label: "STOPPED", color: "#f87171" },
  IDLE: { icon: "👁", label: "TRACKING", color: "#94a3b8" },
  NONE: { icon: "🖐️", label: "SHOW HAND", color: "#64748b" },
};

/**
 * FullscreenWebcam — Renders mirrored webcam as full-page background.
 * ⚡ PERF: Uses its own rAF loop, never causes React re-renders.
 */
function FullscreenWebcam({ webcamRef }) {
  const canvasRef = useRef(null);
  const animRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    // ⚡ PERF: Cache dimensions — only resize when viewport changes
    let lastW = 0, lastH = 0;

    function draw() {
      const video = webcamRef.current;
      if (video && video.readyState >= 2) {
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        // ⚡ PERF: Only resize canvas buffer when dimensions actually change
        if (w !== lastW || h !== lastH) {
          canvas.width = w;
          canvas.height = h;
          lastW = w;
          lastH = h;
        }
        ctx.save();
        ctx.scale(-1, 1);
        ctx.drawImage(video, -w, 0, w, h);
        ctx.restore();
      }
      animRef.current = requestAnimationFrame(draw);
    }

    draw();
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [webcamRef]);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
    />
  );
}

/**
 * HandDotsOverlay — Renders pink fingertip dots + floating label.
 *
 * ⚡ PERF: Uses its own rAF loop to update DOM directly via style mutations.
 * NEVER triggers React re-renders. The dots are plain DOM divs positioned
 * by direct style writes inside requestAnimationFrame.
 */
function HandDotsOverlay({ trackingDataRef }) {
  const containerRef = useRef(null);
  const dotRefs = useRef([]);
  const labelRef = useRef(null);
  const animRef = useRef(null);

  useEffect(() => {
    function update() {
      const td = trackingDataRef.current;
      const lm = td.landmarks;

      if (lm && lm.length > 0) {
        // Update fingertip dots via direct DOM mutation
        LANDMARK_INDICES.forEach((idx, i) => {
          const dot = dotRefs.current[i];
          if (dot && lm[idx]) {
            dot.style.display = "block";
            dot.style.left = `${(1 - lm[idx].x) * 100}%`;
            dot.style.top = `${lm[idx].y * 100}%`;
          }
        });

        // Update floating label
        if (labelRef.current) {
          const gesture = td.gestureState;
          if (gesture !== "NONE" && gesture !== "IDLE") {
            const cfg = GESTURE_DISPLAY[gesture];
            const labelX = (1 - lm[8].x) * 100;
            const labelY = lm[8].y * 100;
            labelRef.current.style.display = "block";
            labelRef.current.style.left = `${Math.max(5, Math.min(85, labelX - 5))}%`;
            labelRef.current.style.top = `${Math.max(5, Math.min(90, labelY + 6))}%`;
            labelRef.current.style.color = cfg ? cfg.color : "#fff";
            labelRef.current.textContent = cfg ? cfg.label : "";
          } else {
            labelRef.current.style.display = "none";
          }
        }
      } else {
        // Hide everything when no hand
        dotRefs.current.forEach(dot => { if (dot) dot.style.display = "none"; });
        if (labelRef.current) labelRef.current.style.display = "none";
      }

      animRef.current = requestAnimationFrame(update);
    }

    update();
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [trackingDataRef]);

  return (
    <div ref={containerRef} style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 5 }}>
      {/* ⚡ PERF: Pre-rendered static DOM elements, positioned via direct style mutation */}
      {LANDMARK_INDICES.map((_, i) => (
        <div
          key={i}
          ref={el => dotRefs.current[i] = el}
          style={{
            display: "none",
            position: "absolute",
            width: 12, height: 12, borderRadius: "50%",
            backgroundColor: "#f472b6",
            transform: "translate(-50%, -50%)",
            boxShadow: "0 0 8px rgba(244, 114, 182, 0.8)",
            // ⚡ PERF: will-change hint for GPU-composited positioning
            willChange: "left, top",
          }}
        />
      ))}
      <div
        ref={labelRef}
        style={{
          display: "none",
          position: "absolute",
          fontFamily: "sans-serif", fontWeight: "bold", fontSize: 16,
          textShadow: "1px 1px 4px rgba(0,0,0,0.9)",
          whiteSpace: "nowrap",
          willChange: "left, top",
        }}
      />
    </div>
  );
}

/**
 * App — Main layout.
 *
 * ⚡ PERF: Only re-renders when hudGesture changes (~4fps).
 * The webcam canvas, hand dots, and 3D scene all run off refs/rAF.
 */
export default function App() {
  const {
    trackingDataRef,
    hudGesture,
    hudTracking,
    webcamRef,
    error,
  } = useHandTracking();

  const config = GESTURE_DISPLAY[hudGesture] || GESTURE_DISPLAY.NONE;

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden", background: "#0f172a" }}>

      {/* Layer 1: Webcam (own rAF loop) */}
      <FullscreenWebcam webcamRef={webcamRef} />

      {/* Layer 2: 3D Globe (reads trackingDataRef in useFrame) */}
      <Suspense fallback={null}>
        <GlobeScene trackingDataRef={trackingDataRef} />
      </Suspense>

      {/* Layer 3: Hand dots (own rAF loop, direct DOM mutation) */}
      <HandDotsOverlay trackingDataRef={trackingDataRef} />

      {/* Layer 4: Static HUD (only re-renders at ~4fps via hudGesture) */}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 10 }}>

        {/* Top-left: MAP LAYERS */}
        <div style={{
          position: "absolute", top: 16, left: 16, width: 160,
          background: "rgba(30,41,59,0.8)", border: "1px solid rgba(255,255,255,0.1)",
          backdropFilter: "blur(4px)", pointerEvents: "auto",
        }}>
          <div style={{ padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.1)", color: "#fff", fontSize: 11, fontWeight: "bold", letterSpacing: "0.1em" }}>
            MAP LAYERS
          </div>
          <div style={{ padding: "8px 12px", color: "#fff", fontSize: 12, borderLeft: "3px solid #fff", background: "rgba(255,255,255,0.1)" }}>
            ◉ TERRAIN
          </div>
          <div style={{ padding: "8px 12px", color: "#a1a1aa", fontSize: 12, borderLeft: "3px solid transparent" }}>
            STREETS
          </div>
        </div>

        {/* Top-right: Gesture indicator (re-renders at ~4fps) */}
        <div style={{
          position: "absolute", top: 16, right: 16,
          background: "rgba(15,23,42,0.7)", backdropFilter: "blur(12px)",
          border: "1px solid rgba(99,102,241,0.15)",
          borderRadius: 12, padding: "8px 16px",
          display: "flex", alignItems: "center", gap: 8,
          boxShadow: `0 0 16px ${config.color}25`,
        }}>
          <span style={{ fontSize: 20 }}>{config.icon}</span>
          <span style={{ fontFamily: "sans-serif", fontSize: 12, fontWeight: 600, letterSpacing: "0.1em", color: config.color }}>
            {config.label}
          </span>
        </div>

        {/* Bottom-right: Controls */}
        <div style={{
          position: "absolute", bottom: 16, right: 16, width: 250,
          background: "rgba(15,23,42,0.85)", border: "1px solid rgba(255,255,255,0.1)",
          padding: 16, color: "#e2e8f0", fontSize: 12, lineHeight: 1.7,
        }}>
          <div style={{ color: "#fff", fontWeight: "bold", fontSize: 11, letterSpacing: "0.1em", marginBottom: 8 }}>
            CONTROLS
          </div>
          <div>🤏 <b style={{ color: "#22d3ee" }}>Pinch</b> + move up/down → Zoom</div>
          <div>☝️ <b style={{ color: "#a855f7" }}>Point index</b> → Rotate globe</div>
          <div>🖐️ <b style={{ color: "#34d399" }}>Open palm</b> → Auto-rotate</div>
          <div>✊ <b style={{ color: "#f87171" }}>Fist</b> → Stop all motion</div>
        </div>

        {/* Bottom-left: Watermark */}
        <div style={{ position: "absolute", bottom: 16, left: 16, color: "rgba(255,255,255,0.4)", fontSize: 14, fontWeight: "bold" }}>
          CESIUM ion
        </div>
      </div>

      {error && (
        <div style={{
          position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)",
          background: "rgba(239,68,68,0.9)", color: "#fff", padding: "8px 16px",
          borderRadius: 8, fontSize: 13, zIndex: 50, fontFamily: "monospace",
        }}>
          ⚠️ {error}
        </div>
      )}
    </div>
  );
}
