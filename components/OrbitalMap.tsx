"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import * as satellite from "satellite.js";
import type { SpaceTrackTLE } from "@/lib/spacetrack";

/* ============================================================
   Panel 1 — Live 3D Orbital Map (Three.js)

   Locked-in architecture (CONTEXT.md lines 204-219) — DO NOT
   change these:
   - THREE.Points (one draw call) + custom ShaderMaterial glow
   - log-scale altitude: 1.0 + log1p(altKm / 2000) * 1.4
   - ECI -> ECF -> Three.js: x->x, z->y, y->-z
   - OrbitControls from three/examples/jsm/controls/OrbitControls
   - useRef for renderer/scene/camera/controls/points/objectData
   - cleanup: cancelAnimationFrame + controls.dispose + renderer.dispose
   ============================================================ */

const DEBRIS_LIMIT = 2000;
const EARTH_RADIUS_KM = 6371;

type Zone = "ALL" | "LEO" | "MEO" | "GEO";
const ZONES: Zone[] = ["ALL", "LEO", "MEO", "GEO"];

interface DebrisObject {
  name: string;
  noradId: string;
  altKm: number;
  zone: Exclude<Zone, "ALL">;
  pos: [number, number, number];
  color: [number, number, number];
}

interface TooltipState {
  x: number;
  y: number;
  name: string;
  noradId: string;
  altKm: number;
  zone: string;
}

/* ---- pure helpers ---- */

/** Log-scale altitude compression (CONTEXT.md line 211). */
function altToSceneR(altKm: number): number {
  return 1.0 + Math.log1p(altKm / 2000) * 1.4;
}

/** Risk color by altitude (CONTEXT.md line 117), normalized 0-1 RGB. */
function riskColor(altKm: number): [number, number, number] {
  if (altKm > 800) return [0, 1.0, 0.2549]; // #00FF41 green
  if (altKm >= 400) return [1.0, 0.7216, 0]; // #FFB800 amber
  return [1.0, 0.1922, 0.1922]; // #FF3131 red
}

function classifyZone(altKm: number): Exclude<Zone, "ALL"> {
  if (altKm < 2000) return "LEO";
  if (altKm < 35000) return "MEO";
  return "GEO";
}

/** Propagate one TLE to a scene-space debris object (null if invalid). */
function propagateOne(o: SpaceTrackTLE, now: Date, gmst: number): DebrisObject | null {
  try {
    const satrec = satellite.twoline2satrec(o.TLE_LINE1, o.TLE_LINE2);
    const pv = satellite.propagate(satrec, now);
    if (!pv.position || typeof pv.position === "boolean") return null;

    const ecf = satellite.eciToEcf(pv.position, gmst);
    const r = Math.sqrt(ecf.x * ecf.x + ecf.y * ecf.y + ecf.z * ecf.z);
    if (!Number.isFinite(r) || r === 0) return null;

    const altKm = r - EARTH_RADIUS_KM;
    if (altKm < 0 || altKm > 60000) return null; // sanity bounds

    const sceneR = altToSceneR(altKm);
    const inv = 1 / r;
    // ECF -> Three.js axis mapping: x->x, z->y, y->-z
    const pos: [number, number, number] = [
      ecf.x * inv * sceneR,
      ecf.z * inv * sceneR,
      -ecf.y * inv * sceneR,
    ];

    return {
      name: o.OBJECT_NAME,
      noradId: o.NORAD_CAT_ID,
      altKm,
      zone: classifyZone(altKm),
      pos,
      color: riskColor(altKm),
    };
  } catch {
    return null;
  }
}

/* ---- shaders ---- */

const POINT_VERTEX_SHADER = `
  uniform float uSize;
  attribute vec3 color;
  varying vec3 vColor;
  void main() {
    vColor = color;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = uSize * (300.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const POINT_FRAGMENT_SHADER = `
  varying vec3 vColor;
  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv);
    if (d > 0.5) discard;
    float alpha = smoothstep(0.5, 0.0, d); // soft additive glow
    gl_FragColor = vec4(vColor, alpha);
  }
`;

const ATMO_VERTEX_SHADER = `
  varying vec3 vNormal;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const ATMO_FRAGMENT_SHADER = `
  varying vec3 vNormal;
  void main() {
    float intensity = pow(0.72 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 2.0);
    gl_FragColor = vec4(0.0, 0.6, 1.0, 1.0) * intensity;
  }
`;

export default function OrbitalMap() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const pointsRef = useRef<THREE.Points | null>(null);
  const frameRef = useRef<number | null>(null);

  const objectDataRef = useRef<DebrisObject[]>([]); // all loaded objects
  const filteredDataRef = useRef<DebrisObject[]>([]); // currently shown (raycast index map)
  const zoneRef = useRef<Zone>("ALL");

  const [zone, setZone] = useState<Zone>("ALL");
  const [fps, setFps] = useState(0);
  const [count, setCount] = useState(0); // currently filtered/visible count
  const [total, setTotal] = useState(0); // total propagated objects (does not change after load)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  /** Rebuild the single Points geometry for the active zone filter. */
  const applyFilter = useCallback((z: Zone) => {
    const points = pointsRef.current;
    if (!points) return;

    const all = objectDataRef.current;
    const filtered = z === "ALL" ? all : all.filter((o) => o.zone === z);

    const n = filtered.length;
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const o = filtered[i];
      positions[i * 3] = o.pos[0];
      positions[i * 3 + 1] = o.pos[1];
      positions[i * 3 + 2] = o.pos[2];
      colors[i * 3] = o.color[0];
      colors[i * 3 + 1] = o.color[1];
      colors[i * 3 + 2] = o.color[2];
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    points.geometry.dispose();
    points.geometry = geo;
    filteredDataRef.current = filtered;
    setCount(filtered.length); // keep counter in sync with the active filter
  }, []);

  // ---- one-time scene setup ----
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let disposed = false;
    const disposables: { dispose: () => void }[] = [];

    const width = mount.clientWidth || 1;
    const height = mount.clientHeight || 1;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000008);

    const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
    camera.position.set(0, 4, 9);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    mount.appendChild(renderer.domElement);

    // Lights
    scene.add(new THREE.AmbientLight(0x335577, 0.6));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
    dirLight.position.set(5, 3, 5);
    scene.add(dirLight);

    // Earth
    const earthGeo = new THREE.SphereGeometry(1, 64, 64);
    const earthMat = new THREE.MeshPhongMaterial({
      color: 0x0a1a3f,
      emissive: 0x06122b,
      shininess: 6,
    });
    scene.add(new THREE.Mesh(earthGeo, earthMat));
    disposables.push(earthGeo, earthMat);

    // Atmosphere glow (rim shader on a slightly larger back-side sphere)
    const atmoGeo = new THREE.SphereGeometry(1.12, 64, 64);
    const atmoMat = new THREE.ShaderMaterial({
      vertexShader: ATMO_VERTEX_SHADER,
      fragmentShader: ATMO_FRAGMENT_SHADER,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
    });
    scene.add(new THREE.Mesh(atmoGeo, atmoMat));
    disposables.push(atmoGeo, atmoMat);

    // Zone shell wireframes: LEO boundary, GPS/MEO, GEO belt
    const shellAlts = [2000, 20200, 35786];
    for (const altKm of shellAlts) {
      const shellGeo = new THREE.SphereGeometry(altToSceneR(altKm), 48, 24);
      const shellMat = new THREE.MeshBasicMaterial({
        color: 0x224466,
        wireframe: true,
        transparent: true,
        opacity: 0.07,
      });
      scene.add(new THREE.Mesh(shellGeo, shellMat));
      disposables.push(shellGeo, shellMat);
    }

    // Background stars (2000)
    const starCount = 2000;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const v = new THREE.Vector3()
        .randomDirection()
        .multiplyScalar(60 + Math.random() * 40);
      starPos[i * 3] = v.x;
      starPos[i * 3 + 1] = v.y;
      starPos[i * 3 + 2] = v.z;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.15,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.7,
    });
    scene.add(new THREE.Points(starGeo, starMat));
    disposables.push(starGeo, starMat);

    // Debris points — ONE draw call, custom glow shader
    const pointsMat = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: 7.0 } },
      vertexShader: POINT_VERTEX_SHADER,
      fragmentShader: POINT_FRAGMENT_SHADER,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const points = new THREE.Points(new THREE.BufferGeometry(), pointsMat);
    points.frustumCulled = false;
    scene.add(points);
    disposables.push(pointsMat);

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.3;
    controls.minDistance = 2;
    controls.maxDistance = 40;

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;
    controlsRef.current = controls;
    pointsRef.current = points;

    // Hover tooltip via raycaster
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 0.05 };
    const pointer = new THREE.Vector2();

    const onPointerMove = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObject(points);
      if (hits.length > 0 && hits[0].index != null) {
        const o = filteredDataRef.current[hits[0].index];
        if (o) {
          setTooltip({
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
            name: o.name,
            noradId: o.noradId,
            altKm: o.altKm,
            zone: o.zone,
          });
          return;
        }
      }
      setTooltip(null);
    };
    const onPointerLeave = () => setTooltip(null);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerleave", onPointerLeave);

    // Resize with the panel
    const resize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    // Animation loop + FPS
    let frames = 0;
    let lastFpsTime = performance.now();
    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
      frames++;
      const now = performance.now();
      if (now - lastFpsTime >= 500) {
        setFps(Math.round((frames * 1000) / (now - lastFpsTime)));
        frames = 0;
        lastFpsTime = now;
      }
    };
    animate();

    // Fetch TLEs + propagate
    (async () => {
      try {
        const res = await fetch(`/api/debris?limit=${DEBRIS_LIMIT}`);
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data?.error ?? `Request failed (HTTP ${res.status}).`);
        }
        if (disposed) return;

        const objs: SpaceTrackTLE[] = data.objects ?? [];
        const now = new Date();
        const gmst = satellite.gstime(now);
        const built: DebrisObject[] = [];
        for (const o of objs) {
          const d = propagateOne(o, now, gmst);
          if (d) built.push(d);
        }

        objectDataRef.current = built;
        setTotal(built.length);
        applyFilter(zoneRef.current); // also sets count for the active filter
        setLoading(false);
      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err.message : "Failed to load debris.");
          setLoading(false);
        }
      }
    })();

    // Cleanup (CONTEXT.md line 219)
    return () => {
      disposed = true;
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
      controls.dispose();
      points.geometry.dispose();
      for (const d of disposables) d.dispose();
      renderer.dispose();
      if (mount.contains(renderer.domElement)) {
        mount.removeChild(renderer.domElement);
      }
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
      pointsRef.current = null;
    };
  }, [applyFilter]);

  // Re-filter when the zone changes
  useEffect(() => {
    zoneRef.current = zone;
    applyFilter(zone);
  }, [zone, applyFilter]);

  return (
    <div className="relative h-full w-full">
      <div ref={mountRef} className="absolute inset-0" />

      {/* Zone filter */}
      <div className="absolute left-2 top-2 flex gap-1">
        {ZONES.map((z) => (
          <button
            key={z}
            onClick={() => setZone(z)}
            className={`rounded border px-2 py-1 font-mono text-[0.65rem] tracking-wide transition-colors ${
              zone === z
                ? "border-safe/60 bg-safe/15 text-safe"
                : "border-glass bg-white/5 text-text-secondary hover:text-text-primary"
            }`}
          >
            {z}
          </button>
        ))}
      </div>

      {/* FPS + object count */}
      <div className="absolute right-2 top-2 flex flex-col items-end gap-0.5 font-mono text-[0.65rem] text-text-secondary">
        <span>
          <span className="text-safe">{fps}</span> FPS
        </span>
        <span>
          <span className="text-text-primary">{count}</span>
          <span className="text-text-muted"> / {total}</span> objects
        </span>
      </div>

      {/* Loading / error overlays */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center font-mono text-xs text-text-secondary blink-cursor">
          Propagating orbits via SGP4
        </div>
      )}
      {error && (
        <div className="absolute bottom-2 left-2 right-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
          {error}
        </div>
      )}

      {/* Hover tooltip */}
      {tooltip && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-glass bg-black/80 px-2 py-1 font-mono text-[0.65rem] text-text-primary"
          style={{ left: tooltip.x + 12, top: tooltip.y + 12 }}
        >
          <div className="font-semibold text-safe">{tooltip.name}</div>
          <div className="text-text-secondary">NORAD {tooltip.noradId}</div>
          <div className="text-text-secondary">
            {tooltip.altKm.toFixed(0)} km · {tooltip.zone}
          </div>
        </div>
      )}
    </div>
  );
}
