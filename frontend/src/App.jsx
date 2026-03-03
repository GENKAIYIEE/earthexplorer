import { Suspense, useEffect, useRef, useState } from "react";
import useHandTracking from "./hooks/useHandTracking";
import GlobeScene from "./components/GlobeScene";
import "./index.css";

// Key hand landmarks to render as dots
const LANDMARK_INDICES = [4, 8, 12, 16, 20]; // Thumb and fingertips

/**
 * FullscreenWebcam – Renders the webcam feed as the fullscreen background.
 * Mirrored horizontally.
 */
function FullscreenWebcam({ webcamRef }) {
  const canvasRef = useRef(null);
  const animRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    function draw() {
      const video = webcamRef.current;
      if (video && video.readyState >= 2) {
        canvas.width = canvas.clientWidth;
        canvas.height = canvas.clientHeight;
        ctx.save();
        ctx.scale(-1, 1);
        ctx.drawImage(video, -canvas.width, 0, canvas.width, canvas.height);
        ctx.restore();
      }
      animRef.current = requestAnimationFrame(draw);
    }

    draw();

    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [webcamRef]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "cover",
      }}
    />
  );
}

/**
 * HandTrackingOverlay – Renders pink dots on fingertips and floating label
 */
function HandTrackingOverlay({ landmarks, gesture }) {
  if (!landmarks || landmarks.length === 0) return null;

  // Use the index fingertip (landmark 8) for attaching floating text
  const indexPos = landmarks[8];
  const textX = (1 - indexPos.x) * 100;
  const textY = indexPos.y * 100;

  let gestureLabel = "";
  if (gesture === "ZOOM") gestureLabel = "ZOOM ↕";
  if (gesture === "ROTATE") gestureLabel = "ROTATE ↺";

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 5 }}>
      {/* Fingertip Dots */}
      {LANDMARK_INDICES.map((idx) => {
        const lm = landmarks[idx];
        if (!lm) return null;
        const x = (1 - lm.x) * 100;
        const y = lm.y * 100;
        return (
          <div
            key={idx}
            style={{
              position: "absolute",
              left: `${x}%`,
              top: `${y}%`,
              width: "12px",
              height: "12px",
              borderRadius: "50%",
              backgroundColor: "#f472b6", // Light pink to match reference
              transform: "translate(-50%, -50%)",
              transition: "left 0.05s linear, top 0.05s linear",
              boxShadow: "0 0 8px rgba(244, 114, 182, 0.8)",
            }}
          />
        );
      })}

      {/* Floating Gesture Text attached to hand */}
      {gestureLabel && (
        <div
          style={{
            position: "absolute",
            left: `${textX - 8}%`,
            top: `${textY + 5}%`,
            color: "white",
            fontFamily: "sans-serif",
            fontWeight: "bold",
            fontSize: "18px",
            textShadow: "1px 1px 4px rgba(0,0,0,0.8)",
            transition: "left 0.05s linear, top 0.05s linear",
          }}
        >
          {gestureLabel}
        </div>
      )}
    </div>
  );
}

/**
 * LayerButton - small helper for Map Layers UI
 */
function LayerButton({ label, active, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: "8px 12px",
        cursor: "pointer",
        color: active ? "#fff" : "#a1a1aa",
        backgroundColor: active ? "rgba(255,255,255,0.1)" : "transparent",
        fontSize: "12px",
        fontWeight: "bold",
        borderLeft: active ? "3px solid #fff" : "3px solid transparent",
        fontFamily: "sans-serif",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        transition: "all 0.2s"
      }}
    >
      {label}
    </div>
  );
}


export default function App() {
  const {
    zoomLevel,
    rotationX,
    rotationY,
    activeGesture,
    webcamRef,
    landmarks,
    error,
  } = useHandTracking();

  const [activeLayer, setActiveLayer] = useState("TERRAIN");

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden", background: "#f8f9fa", fontFamily: "sans-serif" }}>

      {/* ── Layer 1: Webcam Feed ─────────── */}
      <FullscreenWebcam webcamRef={webcamRef} />

      {/* ── Layer 2: 3D Globe (smaller scale) ─────────── */}
      <Suspense fallback={null}>
        <GlobeScene zoomLevel={zoomLevel} rotationX={rotationX} rotationY={rotationY} />
      </Suspense>

      {/* ── Layer 3: Hand Dots & Floating Text ────────────────────── */}
      <HandTrackingOverlay landmarks={landmarks} gesture={activeGesture} />

      {/* ── Layer 4: Minimal Static HUD (matching reference) ──────────────────────────── */}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 10 }}>

        {/* Top-Left: Map Layers Panel */}
        <div style={{
          position: "absolute", top: "16px", left: "16px",
          backgroundColor: "rgba(30, 41, 59, 0.8)", // Dark translucent box
          border: "1px solid rgba(255,255,255,0.1)",
          backdropFilter: "blur(4px)",
          width: "160px",
          pointerEvents: "auto",
        }}>
          <div style={{
            padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.1)",
            color: "#fff", fontSize: "11px", fontWeight: "bold", letterSpacing: "0.1em"
          }}>
            MAP LAYERS
          </div>
          <div style={{ padding: "4px 0" }}>
            <LayerButton label="O TERRAIN" active={activeLayer === "TERRAIN"} onClick={() => setActiveLayer("TERRAIN")} />
            <LayerButton label="STREETS" active={activeLayer === "STREETS"} onClick={() => setActiveLayer("STREETS")} />
            <LayerButton label="DARK MODE" active={activeLayer === "DARK MODE"} onClick={() => setActiveLayer("DARK MODE")} />
          </div>
        </div>

        {/* Bottom-Right: Controls Info Panel */}
        <div style={{
          position: "absolute", bottom: "16px", right: "16px",
          backgroundColor: "rgba(15, 23, 42, 0.85)",
          color: "#e2e8f0",
          border: "1px solid rgba(255,255,255,0.1)",
          padding: "16px",
          width: "240px",
          fontSize: "12px",
          lineHeight: "1.6",
        }}>
          <div style={{ color: "#fff", fontWeight: "bold", fontSize: "11px", letterSpacing: "0.1em", marginBottom: "8px" }}>
            CONTROLS
          </div>
          <div>Left hand: pinch and move<br />up/down to zoom</div>
          <div style={{ marginTop: "4px" }}>Right hand: pinch and drag to<br />rotate</div>
        </div>

        {/* Bottom-Left watermark placeholder */}
        <div style={{
          position: "absolute", bottom: "16px", left: "16px",
          color: "rgba(255,255,255,0.5)", fontSize: "14px", fontWeight: "bold", letterSpacing: "-0.5px"
        }}>
          CESIUM ion
        </div>

      </div>

      {error && (
        <div style={{ position: "absolute", top: 16, left: 16, background: "red", color: "white", padding: 8, zIndex: 50 }}>
          {error}
        </div>
      )}
    </div>
  );
}
