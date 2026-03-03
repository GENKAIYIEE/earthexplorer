import { useEffect, useRef, useState } from "react";
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

// ════════════════════════════════════════════════════════════════
//  ANTI-GRAVITY TRACKING HOOK
//
//  ⚡ PERF: Shared Data Ref architecture — the "data bus"
//    1. Single trackingDataRef mutated in-place (zero re-renders)
//    2. Frame-skipping: process every 2nd video frame
//    3. Zero heap allocation in hot detection loop
//    4. HUD useState throttled to ~4 fps (250ms)
//    5. Hand velocity computed via frame-to-frame deltas
//    6. CPU delegate prevents WebGL contention with Three.js
// ════════════════════════════════════════════════════════════════

// ── MediaPipe landmark indices ──────────────────────────
// Wrist=0, Thumb TIP=4, Index TIP=8, Middle TIP=12, Ring TIP=16, Pinky TIP=20
// Thumb IP=3, Index PIP=6, Middle PIP=10, Ring PIP=14, Pinky PIP=18

// ── Thresholds ──────────────────────────────────────────
const PINCH_THRESHOLD = 0.07;
const PINCH_DELTA_DEADZONE = 0.003;
const INDEX_MOVE_DEADZONE = 0.005;
const MEDIAPIPE_VISION_VERSION = "0.10.18";

// ⚡ PERF: HUD updates throttled to ~4 fps
const HUD_UPDATE_INTERVAL = 250; // ms

// ── Math (zero-allocation) ──────────────────────────────

/** Euclidean distance. Inlined z-fallback for MediaPipe landmarks. */
function dist(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = (a.z || 0) - (b.z || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Is a finger extended? Tip farther from wrist than PIP/IP joint. */
function isFingerExtended(lm, tipIdx, pipIdx) {
    const w = lm[0];
    return dist(lm[tipIdx], w) > dist(lm[pipIdx], w);
}

/**
 * Count extended fingers.
 * ⚡ PERF: No temporary array or .filter() — just a counter.
 */
function countExtendedTotal(lm) {
    let total = 0;
    if (isFingerExtended(lm, 4, 3)) total++;  // thumb
    if (isFingerExtended(lm, 8, 6)) total++;  // index
    if (isFingerExtended(lm, 12, 10)) total++; // middle
    if (isFingerExtended(lm, 16, 14)) total++; // ring
    if (isFingerExtended(lm, 20, 18)) total++; // pinky
    return total;
}

/** Is the index finger specifically extended? */
function isIndexExtended(lm) {
    return isFingerExtended(lm, 8, 6);
}

/**
 * Classify gesture. Priority: PINCH → FIST → OPEN_PALM → INDEX_MOVE → IDLE
 * ⚡ PERF: Returns interned string constants, no object allocation.
 */
function classifyGesture(lm) {
    if (dist(lm[4], lm[8]) < PINCH_THRESHOLD) return "PINCH";
    const total = countExtendedTotal(lm);
    if (total <= 1) return "FIST";
    if (total >= 4) return "OPEN_PALM";
    if (isIndexExtended(lm)) return "INDEX_MOVE";
    return "IDLE";
}

// ════════════════════════════════════════════════════════════════
//  SHARED DATA REF (the core optimization)
//
//  ⚡ PERF: This single ref object is the "data bus" between the
//  detection loop (writes) and the Three.js useFrame loop (reads).
//  NO useState means NO React re-renders on every frame.
//
//  Anti-Gravity additions:
//    - handVelocity { x, y } — frame-over-frame hand movement speed
//    - pinchDeltaY — vertical pinch delta for levitation control
// ════════════════════════════════════════════════════════════════

/**
 * Creates the initial shared data object.
 * ⚡ PERF: Pre-allocated once, mutated in-place. Never replaced.
 */
function createTrackingData() {
    return {
        gestureState: "NONE",    // PINCH | OPEN_PALM | FIST | INDEX_MOVE | IDLE | NONE
        pinchDeltaY: 0,          // vertical pinch delta (levitation intensity)
        indexX: 0.5,             // index fingertip X (normalised 0-1)
        indexY: 0.5,             // index fingertip Y (normalised 0-1)
        handVelocity: { x: 0, y: 0 }, // ⚡ hand movement velocity for physics
        landmarks: null,         // raw array ref, NOT a copy
        isTracking: false,
        frameCounter: 0,         // for frame-skipping
    };
}

// ════════════════════════════════════════════════════════════════

export default function useAntiGravityTracking() {
    const webcamRef = useRef(null);
    const handLandmarkerRef = useRef(null);
    const rafIdRef = useRef(null);
    const streamRef = useRef(null);
    const initDoneRef = useRef(false);
    const lastVideoTimeRef = useRef(-1);

    // ⚡ PERF: Shared data ref — Three.js reads this directly via useFrame()
    const trackingDataRef = useRef(createTrackingData());

    // Previous-frame refs for delta calculation
    const prevPinchMidY = useRef(0);
    const prevPinchValid = useRef(false);
    const prevIndexX = useRef(0.5);
    const prevIndexY = useRef(0.5);

    // Hand velocity tracking (wrist position deltas)
    const prevWristX = useRef(0.5);
    const prevWristY = useRef(0.5);
    const prevWristValid = useRef(false);

    // ⚡ PERF: Only these 3 use useState — for slow-updating HUD elements
    const [hudGesture, setHudGesture] = useState("NONE");
    const [hudTracking, setHudTracking] = useState(false);
    const [error, setError] = useState(null);

    const lastHudUpdate = useRef(0);

    // ── Detection loop ────────────────────────────────────
    const detectRef = useRef(null);
    detectRef.current = function detect() {
        const video = webcamRef.current;
        const hl = handLandmarkerRef.current;

        if (!video || !hl || video.readyState < 2 || video.videoWidth === 0) {
            rafIdRef.current = requestAnimationFrame(detectRef.current);
            return;
        }

        // ⚡ PERF: Ensure dimensions only if changed
        if (video.width !== video.videoWidth) {
            video.width = video.videoWidth;
            video.height = video.videoHeight;
        }

        const now = performance.now();
        const td = trackingDataRef.current;

        // Only process new video frames
        if (video.currentTime !== lastVideoTimeRef.current) {
            lastVideoTimeRef.current = video.currentTime;

            // ⚡ PERF: Frame-skipping — process every 2nd frame
            // Halves CPU load from MediaPipe inference with minimal perceptual loss
            td.frameCounter++;
            if (td.frameCounter % 2 !== 0) {
                rafIdRef.current = requestAnimationFrame(detectRef.current);
                return;
            }

            let results;
            try {
                results = hl.detectForVideo(video, now);
            } catch (_) {
                rafIdRef.current = requestAnimationFrame(detectRef.current);
                return;
            }

            if (results.landmarks && results.landmarks.length > 0) {
                const lm = results.landmarks[0];
                const gesture = classifyGesture(lm);

                // ⚡ PERF: Mutate shared ref in-place — zero object allocation
                td.gestureState = gesture;
                td.landmarks = lm; // Direct reference, NOT a copy
                td.isTracking = true;

                // ── Hand velocity (wrist delta per frame) ──────────
                const wristX = lm[0].x;
                const wristY = lm[0].y;
                if (prevWristValid.current) {
                    // ⚡ PERF: Mutate existing velocity object in-place
                    td.handVelocity.x = wristX - prevWristX.current;
                    td.handVelocity.y = wristY - prevWristY.current;
                } else {
                    td.handVelocity.x = 0;
                    td.handVelocity.y = 0;
                }
                prevWristX.current = wristX;
                prevWristY.current = wristY;
                prevWristValid.current = true;

                // ── Per-gesture delta computation ──────────
                if (gesture === "PINCH") {
                    const midY = (lm[4].y + lm[8].y) / 2;
                    if (prevPinchValid.current) {
                        const rawDy = midY - prevPinchMidY.current;
                        // ⚡ PERF: Deadzone applied without object allocation
                        td.pinchDeltaY = Math.abs(rawDy) > PINCH_DELTA_DEADZONE ? rawDy : 0;
                    } else {
                        td.pinchDeltaY = 0;
                    }
                    prevPinchMidY.current = midY;
                    prevPinchValid.current = true;
                } else {
                    td.pinchDeltaY = 0;
                    prevPinchValid.current = false;

                    if (gesture === "INDEX_MOVE") {
                        const tipX = lm[8].x;
                        const tipY = lm[8].y;
                        // ⚡ PERF: Deadzone — suppress jitter using scalar comparison
                        const dx = Math.abs(tipX - prevIndexX.current);
                        const dy = Math.abs(tipY - prevIndexY.current);
                        if (dx > INDEX_MOVE_DEADZONE || dy > INDEX_MOVE_DEADZONE) {
                            td.indexX = tipX;
                            td.indexY = tipY;
                            prevIndexX.current = tipX;
                            prevIndexY.current = tipY;
                        }
                        // else: keep previous values, suppress jitter
                    }
                }

                // ⚡ PERF: HUD React state only updates every 250ms (~4fps)
                if (now - lastHudUpdate.current > HUD_UPDATE_INTERVAL) {
                    setHudGesture(gesture);
                    if (!hudTracking) setHudTracking(true);
                    lastHudUpdate.current = now;
                }
            } else {
                // No hand detected
                td.gestureState = "NONE";
                td.landmarks = null;
                td.isTracking = false;
                td.pinchDeltaY = 0;
                td.handVelocity.x = 0;
                td.handVelocity.y = 0;
                prevPinchValid.current = false;
                prevWristValid.current = false;

                if (now - lastHudUpdate.current > HUD_UPDATE_INTERVAL) {
                    setHudGesture("NONE");
                    if (hudTracking) setHudTracking(false);
                    lastHudUpdate.current = now;
                }
            }
        }

        rafIdRef.current = requestAnimationFrame(detectRef.current);
    };

    // ── Init (runs once) ─────────────────────────────────
    useEffect(() => {
        if (initDoneRef.current) return;
        initDoneRef.current = true;

        let cancelled = false;

        async function init() {
            try {
                // ⚡ PERF: Cap webcam to 640×480 — higher res slows MediaPipe inference
                const stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: "user", width: 640, height: 480 },
                });

                if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
                streamRef.current = stream;

                const video = document.createElement("video");
                video.srcObject = stream;
                video.setAttribute("playsinline", "true");
                video.setAttribute("autoplay", "true");
                video.muted = true;
                video.style.display = "none";
                video.onloadedmetadata = () => {
                    video.width = video.videoWidth;
                    video.height = video.videoHeight;
                };
                document.body.appendChild(video);
                webcamRef.current = video;
                await video.play();

                // MediaPipe (CPU delegate — avoids WebGL contention with Three.js)
                const vision = await FilesetResolver.forVisionTasks(
                    `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VISION_VERSION}/wasm`
                );
                if (cancelled) return;

                const handLandmarker = await HandLandmarker.createFromOptions(vision, {
                    baseOptions: {
                        modelAssetPath:
                            "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
                        delegate: "CPU",
                    },
                    runningMode: "VIDEO",
                    numHands: 1, // ⚡ PERF: Single hand = 50% less inference work
                });

                if (cancelled) { handLandmarker.close(); return; }
                handLandmarkerRef.current = handLandmarker;
                rafIdRef.current = requestAnimationFrame(detectRef.current);
            } catch (err) {
                if (!cancelled) {
                    console.error("[useAntiGravityTracking] Init error:", err);
                    setError(err.message || "Failed to initialise hand tracking.");
                }
            }
        }

        const timer = setTimeout(init, 3000);

        return () => {
            cancelled = true;
            clearTimeout(timer);
            if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
            if (handLandmarkerRef.current) {
                handLandmarkerRef.current.close();
                handLandmarkerRef.current = null;
            }
            if (streamRef.current) {
                streamRef.current.getTracks().forEach(t => t.stop());
                streamRef.current = null;
            }
            if (webcamRef.current) {
                webcamRef.current.remove();
                webcamRef.current = null;
            }
        };
    }, []);

    // ⚡ PERF: Return the REF, not state values.
    // AntiGravityScene reads trackingDataRef.current inside useFrame() (zero re-renders).
    // Only hudGesture/hudTracking are React state (for the HUD text, ~4fps).
    return {
        trackingDataRef,    // REF — Three.js reads this directly in useFrame()
        hudGesture,         // STATE — for HUD label only (~4fps updates)
        hudTracking,        // STATE — for HUD tracking indicator
        webcamRef,          // REF — for FullscreenWebcam canvas drawing
        error,              // STATE — one-time error display
    };
}
