import { useRef, useMemo, useState, useCallback, useEffect } from "react";
import { Canvas, useFrame, useLoader } from "@react-three/fiber";
import * as THREE from "three";

// ════════════════════════════════════════════════════════════════
//  PERFORMANCE-OPTIMIZED 3D GLOBE SCENE
//
//  Key optimizations (marked with "⚡ PERF"):
//    1. Reads gesture data from a shared REF, not props
//       → EarthMesh NEVER re-renders from gesture changes
//    2. Reduced sphere segments: 48 → 32 (saves ~3,000 triangles)
//    3. Shadows disabled, minimal lighting
//    4. Atmosphere geometry reduced to 32 segments
//    5. Geometry args memoized (static arrays)
// ════════════════════════════════════════════════════════════════

const EARTH_ALBEDO_URL =
    "https://unpkg.com/three-globe@2.41.12/example/img/earth-blue-marble.jpg";
const EARTH_BUMP_URL =
    "https://unpkg.com/three-globe@2.41.12/example/img/earth-topology.png";

const AUTO_ROTATE_SPEED = 0.003;
const ZOOM_SENSITIVITY = 3.0;
const INDEX_ROT_SENSITIVITY = 3.0;
const LERP_SPEED = 0.08;
const MIN_SCALE = 0.3;
const MAX_SCALE = 3.0;

// ⚡ PERF: Static geometry args — no new array created per render
const EARTH_GEO_ARGS = [2, 32, 32];       // was [2, 48, 48] = 33% fewer triangles
const ATMOSPHERE_GEO_ARGS = [2.05, 32, 32]; // was [2.05, 48, 48]

function lerpVal(a, b, t) { return a + (b - a) * t; }

/**
 * EarthMesh – Reads gesture data from trackingDataRef via useFrame.
 *
 * ⚡ PERF: This component receives trackingDataRef (a ref, not state).
 * Props never change → React never re-renders this component.
 * All animation happens inside useFrame(), which runs outside React.
 */
function EarthMesh({ trackingDataRef }) {
    const meshRef = useRef();
    const atmosphereRef = useRef();

    const [albedoMap, bumpMap] = useLoader(THREE.TextureLoader, [
        EARTH_ALBEDO_URL,
        EARTH_BUMP_URL,
    ]);

    // Internal accumulated state (never triggers re-render)
    const s = useRef({
        rotX: 0,
        rotY: 0,
        scale: 1.0,
        autoRotate: false,
        prevIndexX: 0.5,
        prevIndexY: 0.5,
        frozen: false,
    });

    useFrame(() => {
        if (!meshRef.current) return;

        // ⚡ PERF: Read from shared ref — no props, no re-renders
        const td = trackingDataRef.current;
        const st = s.current;

        switch (td.gestureState) {
            case "PINCH_ZOOM": {
                st.autoRotate = false;
                st.frozen = false;
                const zoomChange = -td.pinchDeltaY * ZOOM_SENSITIVITY;
                st.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, st.scale + zoomChange));
                st.prevIndexX = 0.5;
                st.prevIndexY = 0.5;
                break;
            }
            case "INDEX_MOVE": {
                st.autoRotate = false;
                st.frozen = false;
                const dx = td.indexX - st.prevIndexX;
                const dy = td.indexY - st.prevIndexY;
                st.rotY -= dx * INDEX_ROT_SENSITIVITY;
                st.rotX += dy * INDEX_ROT_SENSITIVITY;
                st.rotX = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, st.rotX));
                st.prevIndexX = td.indexX;
                st.prevIndexY = td.indexY;
                break;
            }
            case "OPEN_PALM": {
                st.autoRotate = true;
                st.frozen = false;
                st.prevIndexX = 0.5;
                st.prevIndexY = 0.5;
                break;
            }
            case "FIST": {
                st.autoRotate = false;
                st.frozen = true;
                st.prevIndexX = 0.5;
                st.prevIndexY = 0.5;
                break;
            }
            default: {
                st.prevIndexX = td.indexX;
                st.prevIndexY = td.indexY;
                break;
            }
        }

        if (st.autoRotate && !st.frozen) {
            st.rotY += AUTO_ROTATE_SPEED;
        }

        // ⚡ PERF: Direct mutation of Three.js objects — no VDOM involved
        meshRef.current.rotation.x = lerpVal(meshRef.current.rotation.x, st.rotX, LERP_SPEED);
        meshRef.current.rotation.y = lerpVal(meshRef.current.rotation.y, st.rotY, LERP_SPEED);

        const ns = lerpVal(meshRef.current.scale.x, st.scale, LERP_SPEED);
        meshRef.current.scale.set(ns, ns, ns);

        if (atmosphereRef.current) {
            atmosphereRef.current.rotation.copy(meshRef.current.rotation);
            const as = ns * 1.025;
            atmosphereRef.current.scale.set(as, as, as);
        }
    });

    // ⚡ PERF: Atmosphere material created once via useMemo, never reconstructed
    const atmosphereMaterial = useMemo(
        () =>
            new THREE.ShaderMaterial({
                vertexShader: `
                    varying vec3 vNormal;
                    void main() {
                        vNormal = normalize(normalMatrix * normal);
                        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    }
                `,
                fragmentShader: `
                    varying vec3 vNormal;
                    void main() {
                        float intensity = pow(0.72 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 2.2);
                        vec3 color = vec3(0.13, 0.53, 0.96);
                        gl_FragColor = vec4(color, intensity * 0.6);
                    }
                `,
                blending: THREE.AdditiveBlending,
                side: THREE.BackSide,
                transparent: true,
                depthWrite: false,
            }),
        []
    );

    return (
        <group>
            {/* ⚡ PERF: 32 segments instead of 48 = ~3,000 fewer triangles */}
            <mesh ref={meshRef}>
                <sphereGeometry args={EARTH_GEO_ARGS} />
                <meshStandardMaterial
                    map={albedoMap}
                    bumpMap={bumpMap}
                    bumpScale={0.06}
                    metalness={0.1}
                    roughness={0.7}
                />
            </mesh>
            <mesh ref={atmosphereRef} material={atmosphereMaterial}>
                <sphereGeometry args={ATMOSPHERE_GEO_ARGS} />
            </mesh>
        </group>
    );
}

/**
 * GlobeScene – R3F Canvas wrapper with context loss recovery.
 *
 * ⚡ PERF: trackingDataRef is a stable ref that never changes identity,
 * so this component and EarthMesh never re-render from gesture data.
 */
export default function GlobeScene({ trackingDataRef }) {
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
            {/* ⚡ PERF: Minimal lighting — 1 ambient + 1 directional (removed 2nd directional) */}
            <ambientLight intensity={0.4} color="#b0c4de" />
            <directionalLight position={[5, 3, 5]} intensity={2.0} color="#ffffff" />

            {/* ⚡ PERF: trackingDataRef identity never changes → zero re-renders */}
            <EarthMesh trackingDataRef={trackingDataRef} />
        </Canvas>
    );
}
