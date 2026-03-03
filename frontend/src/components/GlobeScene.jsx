import { useRef, useMemo, useState, useCallback, useEffect } from "react";
import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import { Stars } from "@react-three/drei";
import * as THREE from "three";

// ── Earth texture URLs (NASA Blue Marble via public CDN) ──
const EARTH_ALBEDO_URL =
    "https://unpkg.com/three-globe@2.41.12/example/img/earth-blue-marble.jpg";
const EARTH_BUMP_URL =
    "https://unpkg.com/three-globe@2.41.12/example/img/earth-topology.png";

// ── Lerp helper ──────────────────────────────────────────
function lerpVal(current, target, factor) {
    return current + (target - current) * factor;
}

/**
 * EarthMesh – The 3D globe mesh with albedo + bump textures.
 */
function EarthMesh({ zoomLevel, rotationX, rotationY }) {
    const meshRef = useRef();
    const atmosphereRef = useRef();

    // Load textures
    const [albedoMap, bumpMap] = useLoader(THREE.TextureLoader, [
        EARTH_ALBEDO_URL,
        EARTH_BUMP_URL,
    ]);

    // Internal smoothed values
    const smoothed = useRef({ rotX: 0, rotY: 0, scale: 1 });

    useFrame(() => {
        if (!meshRef.current) return;

        // Smooth transitions
        smoothed.current.rotX = lerpVal(smoothed.current.rotX, rotationX, 0.06);
        smoothed.current.rotY = lerpVal(smoothed.current.rotY, rotationY, 0.06);
        smoothed.current.scale = lerpVal(smoothed.current.scale, zoomLevel, 0.08);

        // Apply rotation
        meshRef.current.rotation.x = smoothed.current.rotX;
        meshRef.current.rotation.y = smoothed.current.rotY + performance.now() * 0.00005;

        // Apply scale from zoom
        const s = smoothed.current.scale;
        meshRef.current.scale.set(s, s, s);

        // Sync atmosphere
        if (atmosphereRef.current) {
            atmosphereRef.current.rotation.copy(meshRef.current.rotation);
            const as = s * 1.025;
            atmosphereRef.current.scale.set(as, as, as);
        }
    });

    // Atmosphere shader material
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
            {/* Earth */}
            <mesh ref={meshRef}>
                <sphereGeometry args={[2, 48, 48]} />
                <meshStandardMaterial
                    map={albedoMap}
                    bumpMap={bumpMap}
                    bumpScale={0.06}
                    metalness={0.1}
                    roughness={0.7}
                />
            </mesh>

            {/* Atmosphere glow */}
            <mesh ref={atmosphereRef} material={atmosphereMaterial}>
                <sphereGeometry args={[2.05, 48, 48]} />
            </mesh>
        </group>
    );
}

/**
 * GlobeScene – Full R3F canvas with Earth, lighting, and stars.
 * Uses alpha: true so the webcam background shows through.
 */
export default function GlobeScene({ zoomLevel, rotationX, rotationY }) {
    const [contextLost, setContextLost] = useState(false);
    const canvasKeyRef = useRef(0);
    const [canvasKey, setCanvasKey] = useState(0);

    const handleCreated = useCallback(({ gl }) => {
        gl.setClearColor(0x000000, 0); // Fully transparent clear

        const canvas = gl.domElement;
        canvas.addEventListener("webglcontextlost", (e) => {
            e.preventDefault();
            setContextLost(true);
        });
        canvas.addEventListener("webglcontextrestored", () => {
            setContextLost(false);
        });
    }, []);

    // Auto-recover from context loss
    useEffect(() => {
        if (!contextLost) return;
        const timer = setTimeout(() => {
            canvasKeyRef.current += 1;
            setCanvasKey(canvasKeyRef.current);
            setContextLost(false);
        }, 1000);
        return () => clearTimeout(timer);
    }, [contextLost]);

    if (contextLost) {
        return (
            <div
                style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                }}
            >
                <div style={{
                    width: "48px",
                    height: "48px",
                    border: "3px solid rgba(99, 102, 241, 0.3)",
                    borderTopColor: "#22d3ee",
                    borderRadius: "50%",
                    animation: "spin 1s linear infinite",
                }} />
                <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
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
                preserveDrawingBuffer: true,
            }}
            onCreated={handleCreated}
            style={{
                position: "absolute",
                inset: 0,
                background: "transparent",
            }}
        >
            {/* Lighting */}
            <ambientLight intensity={0.35} color="#b0c4de" />
            <directionalLight
                position={[5, 3, 5]}
                intensity={2.0}
                color="#ffffff"
                castShadow={false}
            />
            <directionalLight position={[-5, -2, -3]} intensity={0.4} color="#4a6fa5" />

            {/* Earth */}
            <EarthMesh
                zoomLevel={zoomLevel}
                rotationX={rotationX}
                rotationY={rotationY}
            />
        </Canvas>
    );
}
