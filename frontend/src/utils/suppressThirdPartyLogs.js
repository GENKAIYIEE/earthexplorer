/**
 * suppressThirdPartyLogs.js
 *
 * Patches console.warn, console.info, and console.log to suppress
 * known noisy messages from Three.js and MediaPipe WASM internals.
 *
 * Import this file ONCE at the top of main.jsx, before any other imports.
 */

const SUPPRESSED_PATTERNS = [
    // Three.js v0.183+ deprecation (used internally by @react-three/fiber)
    "THREE.Clock",
    "has been deprecated",
    // MediaPipe WASM C++ stdout/stderr
    "Created TensorFlow Lite XNNPACK delegate",
    "Feedback manager requires a model",
    "NORM_RECT without IMAGE_DIMENSIONS",
    "Graph successfully started running",
    "gl_context.cc",
    "OpenGL error checking is disabled",
    "landmark_projection_calculator",
    "inference_feedback_manager",
];

function shouldSuppress(args) {
    if (!args || args.length === 0) return false;
    const msg = typeof args[0] === "string" ? args[0] : String(args[0]);
    return SUPPRESSED_PATTERNS.some((pattern) => msg.includes(pattern));
}

// Patch console methods
const originalWarn = console.warn;
const originalInfo = console.info;
const originalLog = console.log;

console.warn = (...args) => {
    if (shouldSuppress(args)) return;
    originalWarn.apply(console, args);
};

console.info = (...args) => {
    if (shouldSuppress(args)) return;
    originalInfo.apply(console, args);
};

console.log = (...args) => {
    if (shouldSuppress(args)) return;
    originalLog.apply(console, args);
};
