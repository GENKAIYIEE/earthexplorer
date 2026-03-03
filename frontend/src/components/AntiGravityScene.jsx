import { useRef, useMemo, useState, useCallback, useEffect } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";

// ════════════════════════════════════════════════════════════════
//  ANTI-GRAVITY 3D SCENE
//
//  Key optimizations (marked with "⚡ PERF"):
//    1. Reads gesture data from a shared REF, not props
//       → FloatingObjects NEVER re-renders from gesture changes
//    2. Low-poly geometries with static args declared outside
//    3. Shadows disabled, minimal lighting
//    4. Lerp-smoothed motion in useFrame for fluid anti-gravity
//    5. Memoized materials (ShaderMaterial for glow, standard for objects)
//    6. Context recovery via webglcontextlost/restored
// ════════════════════════════════════════════════════════════════

// ── Anti-Gravity Physics Constants ──────────────────────
const LEVITATE_SENSITIVITY = 4.0;    // pinch → height
const PULL_SENSITIVITY = 3.0;        // index → directional pull
const FLOAT_BOB_SPEED = 0.8;         // open palm bob frequency
const FLOAT_BOB_AMPLITUDE = 0.3;     // open palm bob height
const FLOAT_DRIFT_SPEED = 0.15;      // open palm drift rotation
const LERP_SPEED = 0.08;             // smooth transitions
const PARTICLE_COUNT = 60;           // ambient floating particles

// ⚡ PERF: Static geometry args — declared outside, no array per render
const BOX_GEO_ARGS = [1, 1, 1];
const SPHERE_GEO_ARGS = [0.7, 24, 24];
const TORUS_GEO_ARGS = [0.6, 0.25, 16, 32];
const OCTA_GEO_ARGS = [0.8];
const ICO_GEO_ARGS = [0.65, 0];
const PARTICLE_GEO_ARGS = [0.03, 6, 6];

function lerpVal(a, b, t) { return a + (b - a) * t; }

// ── Object definitions (positions, materials, types) ────
const OBJECT_DEFS = [
    { type: "box", pos: [-2.2, 0.5, 0], color: "#22d3ee", emissive: "#0e7490", metalness: 0.8, roughness: 0.2 },
    { type: "sphere", pos: [1.8, -0.3, -1], color: "#a855f7", emissive: "#7e22ce", metalness: 0.6, roughness: 0.3 },
    { type: "torus", pos: [0, 1.5, -0.5], color: "#f472b6", emissive: "#be185d", metalness: 0.7, roughness: 0.25 },
    { type: "octa", pos: [-1.2, -1.5, 0.5], color: "#34d399", emissive: "#059669", metalness: 0.9, roughness: 0.15 },
    { type: "ico", pos: [2.5, 1.2, -0.3], color: "#fbbf24", emissive: "#d97706", metalness: 0.5, roughness: 0.4 },
];

/**
 * AmbientParticles — tiny glowing dots drifting through space.
 * ⚡ PERF: InstancedMesh with a single geometry + material.
 */
function AmbientParticles() {
    const meshRef = useRef();
    const dummy = useMemo(() => new THREE.Object3D(), []);

    // ⚡ PERF: Generate positions once, store in a typed array
    const particles = useMemo(() => {
        const arr = new Float32Array(PARTICLE_COUNT * 4); // x, y, z, speed
        for (let i = 0; i < PARTICLE_COUNT; i++) {
            arr[i * 4 + 0] = (Math.random() - 0.5) * 16;   // x
            arr[i * 4 + 1] = (Math.random() - 0.5) * 10;   // y
            arr[i * 4 + 2] = (Math.random() - 0.5) * 12;   // z
            arr[i * 4 + 3] = 0.2 + Math.random() * 0.6;    // speed
        }
        return arr;
    }, []);

    useFrame(({ clock }) => {
        if (!meshRef.current) return;
        const t = clock.getElapsedTime();
        for (let i = 0; i < PARTICLE_COUNT; i++) {
            const off = i * 4;
            const speed = particles[off + 3];
            dummy.position.set(
                particles[off + 0] + Math.sin(t * speed + i) * 0.5,
                particles[off + 1] + Math.cos(t * speed * 0.7 + i * 0.3) * 0.4,
                particles[off + 2] + Math.sin(t * speed * 0.5 + i * 0.7) * 0.3
            );
            dummy.scale.setScalar(0.5 + Math.sin(t * 2 + i) * 0.3);
            dummy.updateMatrix();
            meshRef.current.setMatrixAt(i, dummy.matrix);
        }
        meshRef.current.instanceMatrix.needsUpdate = true;
    });

    const material = useMemo(() => new THREE.MeshBasicMaterial({
        color: "#6366f1",
        transparent: true,
        opacity: 0.4,
    }), []);

    return (
        <instancedMesh ref={meshRef} args={[null, null, PARTICLE_COUNT]} material={material}>
            <sphereGeometry args={PARTICLE_GEO_ARGS} />
        </instancedMesh>
    );
}

/**
 * FloatingObject — A single anti-gravity object driven by gesture data.
 *
 * ⚡ PERF: Receives trackingDataRef (a ref, not state).
 * Props never change → React never re-renders this component.
 * All animation happens inside useFrame().
 */
function FloatingObject({ trackingDataRef, def, index }) {
    const meshRef = useRef();
    const glowRef = useRef();

    // Internal accumulated state (never triggers re-render)
    const s = useRef({
        posX: def.pos[0],
        posY: def.pos[1],
        posZ: def.pos[2],
        baseY: def.pos[1],           // original Y for float offset
        rotX: 0,
        rotY: 0,
        rotZ: 0,
        levitateOffset: 0,           // accumulated height from PINCH
        frozen: false,
        floating: false,
        pullTargetX: 0,              // INDEX_MOVE direction pull target
        pullTargetY: 0,
        glowIntensity: 0,
    });

    // Phase offset for each object so they bob at different cycles
    const phaseOffset = useMemo(() => index * 1.3, [index]);

    // ⚡ PERF: Memoized glow material per object
    const glowMaterial = useMemo(() => new THREE.ShaderMaterial({
        vertexShader: `
            varying vec3 vNormal;
            void main() {
                vNormal = normalize(normalMatrix * normal);
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform vec3 uColor;
            uniform float uIntensity;
            varying vec3 vNormal;
            void main() {
                float rim = pow(0.7 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 2.5);
                gl_FragColor = vec4(uColor, rim * uIntensity * 0.5);
            }
        `,
        uniforms: {
            uColor: { value: new THREE.Color(def.emissive) },
            uIntensity: { value: 0.0 },
        },
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
    }), [def.emissive]);

    useFrame(({ clock }) => {
        if (!meshRef.current) return;

        // ⚡ PERF: Read from shared ref — no props, no re-renders
        const td = trackingDataRef.current;
        const st = s.current;
        const t = clock.getElapsedTime();

        let targetGlow = 0.3; // idle glow

        switch (td.gestureState) {
            case "PINCH": {
                // Levitation — pinch delta controls height
                st.frozen = false;
                st.floating = false;
                st.levitateOffset -= td.pinchDeltaY * LEVITATE_SENSITIVITY;
                st.levitateOffset = Math.max(-4, Math.min(4, st.levitateOffset));
                targetGlow = 1.0;
                // Gentle spin while levitating
                st.rotY += 0.015;
                break;
            }
            case "OPEN_PALM": {
                // Global suspension — objects float & bob weightlessly
                st.frozen = false;
                st.floating = true;
                targetGlow = 0.7;
                // Gentle drift rotation
                st.rotX += FLOAT_DRIFT_SPEED * 0.01;
                st.rotY += FLOAT_DRIFT_SPEED * 0.015;
                st.rotZ += FLOAT_DRIFT_SPEED * 0.008;
                break;
            }
            case "FIST": {
                // Zero-gravity freeze — lock everything
                st.frozen = true;
                st.floating = false;
                targetGlow = 0.15;
                break;
            }
            case "INDEX_MOVE": {
                // Directional pull — objects drift toward finger
                st.frozen = false;
                st.floating = false;
                // Map index finger normalised coords (0-1) to scene coords
                // Mirrored X because webcam is mirrored
                st.pullTargetX = (1 - td.indexX - 0.5) * 8;
                st.pullTargetY = -(td.indexY - 0.5) * 6;
                targetGlow = 0.85;
                st.rotY += 0.01;
                break;
            }
            default: {
                // IDLE/NONE — gentle ambient rotation
                st.floating = false;
                st.frozen = false;
                st.rotY += 0.005;
                targetGlow = 0.2;
                break;
            }
        }

        // ── Compute target position ──────────────────────
        let targetX = def.pos[0];
        let targetY = st.baseY + st.levitateOffset;
        let targetZ = def.pos[2];

        // Float / bob effect
        if (st.floating) {
            targetY += Math.sin(t * FLOAT_BOB_SPEED + phaseOffset) * FLOAT_BOB_AMPLITUDE;
            targetX += Math.sin(t * FLOAT_BOB_SPEED * 0.6 + phaseOffset + 1.0) * 0.15;
            targetZ += Math.cos(t * FLOAT_BOB_SPEED * 0.4 + phaseOffset + 2.0) * 0.1;
        }

        // INDEX_MOVE pull — blend toward pull target
        if (td.gestureState === "INDEX_MOVE") {
            const pullFactor = 0.25; // how strongly objects are attracted
            targetX = lerpVal(targetX, st.pullTargetX + def.pos[0] * 0.3, pullFactor);
            targetY = lerpVal(targetY, st.pullTargetY + def.pos[1] * 0.3, pullFactor);
        }

        // ── Apply position (lerp for smoothness) ─────────
        if (!st.frozen) {
            st.posX = lerpVal(st.posX, targetX, LERP_SPEED);
            st.posY = lerpVal(st.posY, targetY, LERP_SPEED);
            st.posZ = lerpVal(st.posZ, targetZ, LERP_SPEED);
        }
        // Frozen = no position updates, objects stay put

        // ⚡ PERF: Direct mutation of Three.js objects — no VDOM
        meshRef.current.position.set(st.posX, st.posY, st.posZ);
        meshRef.current.rotation.set(st.rotX, st.rotY, st.rotZ);

        // Glow pulsing
        st.glowIntensity = lerpVal(st.glowIntensity, targetGlow, 0.05);
        if (glowRef.current) {
            glowRef.current.position.copy(meshRef.current.position);
            glowRef.current.rotation.copy(meshRef.current.rotation);
            const gs = 1.15 + Math.sin(t * 2 + phaseOffset) * 0.05;
            glowRef.current.scale.setScalar(gs);
            glowMaterial.uniforms.uIntensity.value = st.glowIntensity;
        }
    });

    // ── Select geometry based on type ────────────────────
    const geometryJsx = useMemo(() => {
        switch (def.type) {
            case "box": return <boxGeometry args={BOX_GEO_ARGS} />;
            case "sphere": return <sphereGeometry args={SPHERE_GEO_ARGS} />;
            case "torus": return <torusGeometry args={TORUS_GEO_ARGS} />;
            case "octa": return <octahedronGeometry args={OCTA_GEO_ARGS} />;
            case "ico": return <icosahedronGeometry args={ICO_GEO_ARGS} />;
            default: return <boxGeometry args={BOX_GEO_ARGS} />;
        }
    }, [def.type]);

    return (
        <group>
            {/* Main object */}
            <mesh ref={meshRef}>
                {geometryJsx}
                <meshStandardMaterial
                    color={def.color}
                    emissive={def.emissive}
                    emissiveIntensity={0.3}
                    metalness={def.metalness}
                    roughness={def.roughness}
                />
            </mesh>
            {/* Glow shell */}
            <mesh ref={glowRef} material={glowMaterial}>
                {geometryJsx}
            </mesh>
        </group>
    );
}

/**
 * AntiGravityScene — R3F Canvas wrapper with context loss recovery.
 *
 * ⚡ PERF: trackingDataRef is a stable ref that never changes identity,
 * so this component and its children never re-render from gesture data.
 */
export default function AntiGravityScene({ trackingDataRef }) {
    const [contextLost, setContextLost] = useState(false);
    const canvasKeyRef = useRef(0);
    const [canvasKey, setCanvasKey] = useState(0);

    const handleCreated = useCallback(({ gl }) => {
        gl.setClearColor(0x000000, 0);
        // ⚡ PERF: Disable shadow maps entirely — not used
        gl.shadowMap.enabled = false;
        const canvas = gl.domElement;
        canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); setContextLost(true); });
        canvas.addEventListener("webglcontextrestored", () => setContextLost(false));
    }, []);

    useEffect(() => {
        if (!contextLost) return;
        const t = setTimeout(() => {
            canvasKeyRef.current++;
            setCanvasKey(canvasKeyRef.current);
            setContextLost(false);
        }, 1000);
        return () => clearTimeout(t);
    }, [contextLost]);

    if (contextLost) {
        return (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <div style={{ width: 48, height: 48, border: "3px solid rgba(99,102,241,0.3)", borderTopColor: "#22d3ee", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
                <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
            </div>
        );
    }

    return (
        <Canvas
            key={canvasKey}
            camera={{ position: [0, 0, 9], fov: 45, near: 0.1, far: 1000 }}
            gl={{
                antialias: true,
                alpha: true,
                powerPreference: "default",
                failIfMajorPerformanceCaveat: false,
                // ⚡ PERF: preserveDrawingBuffer off saves a GPU copy per frame
                preserveDrawingBuffer: false,
            }}
            onCreated={handleCreated}
            style={{ position: "absolute", inset: 0, background: "transparent" }}
        >
            {/* ⚡ PERF: Minimal lighting — 1 ambient + 1 directional + 1 point for depth */}
            <ambientLight intensity={0.3} color="#b0c4de" />
            <directionalLight position={[5, 3, 5]} intensity={1.8} color="#ffffff" />
            <pointLight position={[-3, -2, 4]} intensity={0.6} color="#6366f1" />

            {/* Floating objects — each reads trackingDataRef in useFrame() */}
            {OBJECT_DEFS.map((def, i) => (
                <FloatingObject
                    key={i}
                    trackingDataRef={trackingDataRef}
                    def={def}
                    index={i}
                />
            ))}

            {/* Ambient particles for depth */}
            <AmbientParticles />
        </Canvas>
    );
}
