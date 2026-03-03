import { useEffect, useRef, useState, useCallback } from "react";
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

// ── Constants ───────────────────────────────────────────
const PINCH_MIN = 0.03;
const PINCH_MAX = 0.25;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const LERP_FACTOR = 0.1;
const ROTATION_SENSITIVITY = 4.0;
const DRAG_THRESHOLD = 0.005;
const PINCH_ENGAGE_THRESHOLD = 0.08;

// MediaPipe WASM version – pin to avoid CDN cache issues
const MEDIAPIPE_VISION_VERSION = "0.10.18";

/**
 * Euclidean distance between two 3D landmarks.
 */
function euclidean(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Linear interpolation.
 */
function lerp(current, target, factor) {
    return current + (target - current) * factor;
}

/**
 * Map a value from [inMin, inMax] to [outMin, outMax], clamped.
 */
function mapRange(value, inMin, inMax, outMin, outMax) {
    const clamped = Math.max(inMin, Math.min(inMax, value));
    const ratio = (clamped - inMin) / (inMax - inMin);
    return outMin + ratio * (outMax - outMin);
}

/**
 * useHandTracking – React hook for real-time hand gesture recognition.
 *
 * Initialises the webcam → MediaPipe HandLandmarker pipeline and exposes
 * smoothed gesture state for controlling the 3D globe.
 */
export default function useHandTracking() {
    // ── Refs (mutable, no re-renders) ──────────────────────
    const webcamRef = useRef(null);
    const handLandmarkerRef = useRef(null);
    const rafIdRef = useRef(null);
    const streamRef = useRef(null);
    const initDoneRef = useRef(false);

    // Previous-frame landmark for delta calculation
    const prevPalmRef = useRef(null);
    const lastVideoTimeRef = useRef(-1);
    const isTrackingRef = useRef(false);

    // Smoothed values (avoid re-renders on every frame)
    const smoothedRef = useRef({
        zoom: 1.0,
        rotX: 0,
        rotY: 0,
    });

    // ── State (exposed to consumers) ──────────────────────
    const [zoomLevel, setZoomLevel] = useState(1.0);
    const [rotationX, setRotationX] = useState(0);
    const [rotationY, setRotationY] = useState(0);
    const [activeGesture, setActiveGesture] = useState("NONE");
    const [isTracking, setIsTracking] = useState(false);
    const [error, setError] = useState(null);
    const [landmarks, setLandmarks] = useState(null);

    // Throttle React state updates to ~30 fps for HUD
    const lastUIUpdate = useRef(0);
    const UI_UPDATE_INTERVAL = 33; // ms

    // ── Detection loop (stable ref, never changes) ─────────
    const detectRef = useRef(null);
    detectRef.current = function detect() {
        const video = webcamRef.current;
        const handLandmarker = handLandmarkerRef.current;

        if (
            !video ||
            !handLandmarker ||
            video.readyState < 2 ||
            video.videoWidth === 0
        ) {
            rafIdRef.current = requestAnimationFrame(detectRef.current);
            return;
        }

        // Ensure explicit dimensions are set for MediaPipe
        if (video.width !== video.videoWidth || video.height !== video.videoHeight) {
            video.width = video.videoWidth;
            video.height = video.videoHeight;
        }

        const now = performance.now();

        // Only process if we have a new video frame
        if (video.currentTime !== lastVideoTimeRef.current) {
            lastVideoTimeRef.current = video.currentTime;

            let results;
            try {
                results = handLandmarker.detectForVideo(video, now);
            } catch (e) {
                // MediaPipe can throw on timestamp issues; just skip this frame
                rafIdRef.current = requestAnimationFrame(detectRef.current);
                return;
            }

            if (results.landmarks && results.landmarks.length > 0) {
                const landmarks = results.landmarks[0];

                // ── Landmark references ──────────────────────────
                const thumbTip = landmarks[4];
                const indexTip = landmarks[8];
                const palmCenter = landmarks[9];

                // ── Pinch-to-Zoom ────────────────────────────────
                const pinchDist = euclidean(thumbTip, indexTip);
                const targetZoom = mapRange(pinchDist, PINCH_MIN, PINCH_MAX, ZOOM_MIN, ZOOM_MAX);
                smoothedRef.current.zoom = lerp(smoothedRef.current.zoom, targetZoom, LERP_FACTOR);

                // ── Drag-to-Rotate ───────────────────────────────
                let deltaX = 0;
                let deltaY = 0;
                let dragMagnitude = 0;

                if (prevPalmRef.current) {
                    deltaX = palmCenter.x - prevPalmRef.current.x;
                    deltaY = palmCenter.y - prevPalmRef.current.y;
                    dragMagnitude = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

                    if (dragMagnitude > DRAG_THRESHOLD) {
                        const targetRotY = smoothedRef.current.rotY - deltaX * ROTATION_SENSITIVITY;
                        const targetRotX = smoothedRef.current.rotX + deltaY * ROTATION_SENSITIVITY;

                        smoothedRef.current.rotY = lerp(smoothedRef.current.rotY, targetRotY, LERP_FACTOR * 3);
                        smoothedRef.current.rotX = lerp(smoothedRef.current.rotX, targetRotX, LERP_FACTOR * 3);
                    }
                }
                prevPalmRef.current = { x: palmCenter.x, y: palmCenter.y };

                // ── Gesture classification ───────────────────────
                let gesture = "IDLE";
                if (pinchDist < PINCH_ENGAGE_THRESHOLD) {
                    gesture = "ZOOM";
                } else if (dragMagnitude > DRAG_THRESHOLD) {
                    gesture = "ROTATE";
                }

                // ── Throttled UI updates ─────────────────────────
                if (now - lastUIUpdate.current > UI_UPDATE_INTERVAL) {
                    setZoomLevel(smoothedRef.current.zoom);
                    setRotationX(smoothedRef.current.rotX);
                    setRotationY(smoothedRef.current.rotY);
                    setActiveGesture(gesture);
                    setLandmarks([...landmarks]);
                    if (!isTrackingRef.current) {
                        isTrackingRef.current = true;
                        setIsTracking(true);
                    }
                    lastUIUpdate.current = now;
                }
            } else {
                // No hand detected
                prevPalmRef.current = null;
                if (now - lastUIUpdate.current > UI_UPDATE_INTERVAL) {
                    setActiveGesture("NONE");
                    setLandmarks(null);
                    if (isTrackingRef.current) {
                        isTrackingRef.current = false;
                        setIsTracking(false);
                    }
                    lastUIUpdate.current = now;
                }
            }
        }

        rafIdRef.current = requestAnimationFrame(detectRef.current);
    };

    // ── Initialisation (runs ONCE, empty deps) ────────────
    useEffect(() => {
        // Guard against StrictMode double-invoke
        if (initDoneRef.current) return;
        initDoneRef.current = true;

        let cancelled = false;

        async function init() {
            try {
                // 1. Request webcam
                const stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: "user", width: 640, height: 480 },
                });

                if (cancelled) {
                    stream.getTracks().forEach((t) => t.stop());
                    return;
                }

                streamRef.current = stream;

                // Create hidden video element
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

                // 2. Initialise MediaPipe HandLandmarker (CPU only – avoids WebGL contention)
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
                    numHands: 1,
                });

                if (cancelled) {
                    handLandmarker.close();
                    return;
                }

                handLandmarkerRef.current = handLandmarker;

                // 3. Start detection loop
                rafIdRef.current = requestAnimationFrame(detectRef.current);
            } catch (err) {
                if (!cancelled) {
                    console.error("[useHandTracking] Initialisation error:", err);
                    setError(err.message || "Failed to initialise hand tracking.");
                }
            }
        }

        // Delay MediaPipe init to let Three.js establish WebGL context first
        const initTimer = setTimeout(init, 3000);

        // ── Cleanup ──────────────────────────────────────────
        return () => {
            cancelled = true;
            clearTimeout(initTimer);

            if (rafIdRef.current) {
                cancelAnimationFrame(rafIdRef.current);
            }

            if (handLandmarkerRef.current) {
                handLandmarkerRef.current.close();
                handLandmarkerRef.current = null;
            }

            if (streamRef.current) {
                streamRef.current.getTracks().forEach((t) => t.stop());
                streamRef.current = null;
            }

            if (webcamRef.current) {
                webcamRef.current.remove();
                webcamRef.current = null;
            }
        };
    }, []); // Empty deps – runs once

    return {
        zoomLevel,
        rotationX,
        rotationY,
        activeGesture,
        isTracking,
        webcamRef,
        landmarks,
        error,
    };
}
