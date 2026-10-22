/* ============================================================
   SpaceDebris — browser-side engineering telemetry bus (Session 6)

   A tiny, dependency-free pub/sub that lets hot paths report
   timings without React state churn:
     - OrbitalMap reports every SGP4 propagation tick (ms, objects)
       and its FPS readout.
     - Panels that call /api/* through timedFetch() report latency
       per route.
   The System Telemetry panel subscribes and renders p50 / p95.

   Pure client module: no React, no network. Safe to import from
   any "use client" component. Ring buffers are bounded.
   ============================================================ */

const RING = 120;

export interface MapTelemetry {
  samples: number;
  lastTickMs: number | null;
  p50TickMs: number | null;
  p95TickMs: number | null;
  maxTickMs: number | null;
  objects: number;
  fps: number | null;
  lastTickAt: number | null; // epoch ms
}

export interface RouteTelemetry {
  route: string;
  count: number;
  errors: number;
  lastMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  lastAt: number | null;
}

export interface TelemetrySnapshot {
  map: MapTelemetry;
  routes: RouteTelemetry[];
}

type Listener = (snapshot: TelemetrySnapshot) => void;

const tickRing: number[] = [];
let mapObjects = 0;
let mapFps: number | null = null;
let lastTickAt: number | null = null;

const routeRings = new Map<string, { ms: number[]; count: number; errors: number; lastAt: number | null }>();
const listeners = new Set<Listener>();

function pushRing(ring: number[], v: number): void {
  ring.push(v);
  if (ring.length > RING) ring.shift();
}

function percentile(ring: number[], p: number): number | null {
  if (ring.length === 0) return null;
  const sorted = [...ring].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function notify(): void {
  if (listeners.size === 0) return;
  const snap = getTelemetrySnapshot();
  listeners.forEach((cb) => {
    try {
      cb(snap);
    } catch {
      /* a listener must never break the hot path */
    }
  });
}

/** OrbitalMap: one SGP4 re-propagation pass finished. */
export function recordMapTick(tickMs: number, objects: number): void {
  if (!Number.isFinite(tickMs) || tickMs < 0) return;
  pushRing(tickRing, tickMs);
  mapObjects = objects;
  lastTickAt = Date.now();
  notify();
}

/** OrbitalMap: FPS readout updated (every ~500 ms). */
export function recordMapFps(fps: number): void {
  if (!Number.isFinite(fps)) return;
  mapFps = fps;
}

/** Any panel: an /api/<route> call completed. */
export function recordApiTiming(route: string, ms: number, ok: boolean): void {
  if (!route || !Number.isFinite(ms) || ms < 0) return;
  let entry = routeRings.get(route);
  if (!entry) {
    entry = { ms: [], count: 0, errors: 0, lastAt: null };
    routeRings.set(route, entry);
  }
  pushRing(entry.ms, ms);
  entry.count++;
  if (!ok) entry.errors++;
  entry.lastAt = Date.now();
  notify();
}

/**
 * fetch() wrapper that reports latency to the bus. Route label is the
 * pathname (query string stripped) so /api/debris?limit=2000 and
 * /api/debris?search=ISS share one row.
 */
export async function timedFetch(input: string, init?: RequestInit): Promise<Response> {
  let route = input;
  try {
    route = new URL(input, "http://localhost").pathname;
  } catch {
    /* keep raw string */
  }
  const t0 = performance.now();
  try {
    const res = await fetch(input, init);
    recordApiTiming(route, performance.now() - t0, res.ok);
    return res;
  } catch (err) {
    recordApiTiming(route, performance.now() - t0, false);
    throw err;
  }
}

export function getTelemetrySnapshot(): TelemetrySnapshot {
  const routes: RouteTelemetry[] = [];
  routeRings.forEach((e, route) => {
    routes.push({
      route,
      count: e.count,
      errors: e.errors,
      lastMs: e.ms.length ? e.ms[e.ms.length - 1] : null,
      p50Ms: percentile(e.ms, 50),
      p95Ms: percentile(e.ms, 95),
      lastAt: e.lastAt,
    });
  });
  routes.sort((a, b) => a.route.localeCompare(b.route));
  return {
    map: {
      samples: tickRing.length,
      lastTickMs: tickRing.length ? tickRing[tickRing.length - 1] : null,
      p50TickMs: percentile(tickRing, 50),
      p95TickMs: percentile(tickRing, 95),
      maxTickMs: tickRing.length ? Math.max(...tickRing) : null,
      objects: mapObjects,
      fps: mapFps,
      lastTickAt,
    },
    routes,
  };
}

/** Subscribe to every update; returns an unsubscribe function. */
export function subscribeTelemetry(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
