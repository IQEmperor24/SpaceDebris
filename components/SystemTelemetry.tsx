"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { SatRec } from "satellite.js";
import type { SpaceTrackBudget } from "@/lib/health";
import type { RouteTelemetry, TelemetrySnapshot } from "@/lib/telemetry";
import {
  getTelemetrySnapshot,
  subscribeTelemetry,
  timedFetch,
} from "@/lib/telemetry";
import { getDebrisSample } from "@/lib/debrisClient";
import {
  formatUtc,
  formatUtcTime,
  minutesSinceEpoch,
  parseTle,
  propagateMinutes,
} from "@/lib/orbital";

/* ============================================================
   Session 6 — Feature 7: System Telemetry

   "Know your system": a performance + request-budget console for
   the dashboard itself. Four sections:

   1. SPACE-TRACK REQUEST BUDGET — GET /api/health (through
      timedFetch, so this panel shows up in its own latency table)
      every 60 s; renders the serving instance's spaceTrackBudget
      block: requests in the last hour vs the published 300/hr
      limit, last minute vs 30/min, shared-cache hits / misses /
      hit rate, session cookie age, last login (UTC). An older
      server without the block renders "—".
   2. ORBIT PROPAGATION — subscribes to the lib/telemetry bus that
      OrbitalMap feeds on every SGP4 re-propagation pass. The bus
      can notify several times a second (map ticks at 1 Hz live /
      4 Hz warped, plus every timed API call), so the listener
      throttles React state to <= 1 update per second (leading +
      trailing edge, timestamp ref). Every distinct tick is still
      pushed into a 60-entry ring (ref) for the sparkline.
   3. API LATENCY — per-route calls / errors / last / p50 / p95
      from the same snapshot (only calls made through timedFetch).
   4. CLIENT SGP4 BENCHMARK — on demand only. Loads the shared
      2,000-object sample (lib/debrisClient), parses satrecs with
      lib/orbital parseTle, runs one untimed warm-up pass, then
      propagates every object 25 times (t = now … now + 96 min,
      increasing) with propagateMinutes. All three stages (parse,
      warm-up, timed) run in batches of 200 objects with a
      setTimeout(0) yield between batches so the page (and the 3D
      map) stays responsive.

   Cadence: health poll 60 s (skipped while the tab is hidden,
   caught up on return) · bus snapshot <= 1 Hz · benchmark on demand.
   Zero Claude cost. /api/health caches its one Space-Track probe for
   5 min per instance but has NO in-flight dedupe, so this panel's
   FIRST poll waits until the header's (MissionStatusBar) mount poll
   has finished — seen through Resource Timing — or 13 s at most
   (past the route's 12 s probe timeout); it then lands on a filled
   cache instead of starting a second concurrent probe. After that,
   the 60 s poll re-triggers at most one probe per instance per
   5 min. Two callers that hit a cold cache at the same moment can
   still probe twice; the real fix is one in-flight probe promise in
   app/api/health/route.ts (the loginInFlight pattern).

   ASSUMPTIONS (also printed in the footnote)
   - Server counters are per serverless instance: Vercel may run
     several, and each keeps its own request log and caches.
   - Space-Track's 30/min and 300/hr limits are per ACCOUNT; each bar
     is one instance's count, so with several instances it is a lower
     bound on account usage. Server counters include every visitor's
     traffic on that instance but carry no per-user data.
   - A map tick is one OrbitalMap pass over every VISIBLE (zone-
     filtered) object: SGP4 + ECI→ECF + scene mapping + position-
     attribute write (CPU-side Float32Array) + bounding-sphere refresh.
     The GPU upload (bufferSubData) happens later inside
     renderer.render() and is NOT timed, so "throughput" is end-to-end
     on the CPU side, not SGP4-only. Throughput and frame budget use
     the ring's p50 tick against one 60 Hz frame (16.7 ms); "last tick"
     is the raw sample.
   - p50 / p95 are nearest-rank over the bus's bounded rolling window
     (RING in lib/telemetry.ts — not exported, so no count is
     hard-coded here). performance.now() resolution is
     browser-limited, so sub-ms timings are quantised.
   - Instance uptime = uptime reported at the (cached, <= 5 min)
     probe + the probe's age, measured server clock to server clock
     (HTTP Date header − checkedAt). Without a Date header it falls
     back to this browser's clock; the clamp to the 5-min probe cache
     bounds any skew error to <= 5 min.
   - The benchmark is single-threaded on the main thread after one
     untimed warm-up pass of the exact timed workload (Node 22: a
     1,000-call warm-up left the first click ~2x slower than the
     second; a full pass brings it within ~1.2x). Compute time is the
     timed pass only, UI yields excluded. Nothing is sent anywhere —
     results stay in this browser.
   ============================================================ */

/* ---- Cadence ---- */
const HEALTH_POLL_MS = 60_000;
/** /api/health caches its probe for 5 min per instance: bounds checkedAt staleness. */
const HEALTH_PROBE_CACHE_S = 300;
const HEALTH_PATH = "/api/health";
/**
 * Longest wait for the header's mount poll before this panel's first
 * poll: the route's 12 s probe timeout (PROBE_TIMEOUT_MS) + 1 s margin,
 * so a probe that started at mount has normally finished and been
 * cached (a serverless cold start on top of a full timeout can exceed
 * it). Only matters where Resource Timing does not report the header's
 * response — otherwise the gate opens the moment that response lands.
 */
const HEALTH_FIRST_POLL_MAX_WAIT_MS = 13_000;
const SNAPSHOT_MIN_INTERVAL_MS = 1_000;

/* ---- Map section ---- */
const SPARK_LEN = 60;
/** One frame at 60 Hz. */
const FRAME_BUDGET_MS = 1000 / 60;

/* ---- Benchmark ---- */
const BENCH_STEPS = 25;
/** 25 steps × 4 min → t = now … now + 96 min (≈ one LEO revolution). */
const BENCH_STEP_MINUTES = 4;
const BENCH_BATCH = 200;
/** satellite.js switches to SDP4 (deep space) for periods >= 225 min. */
const DEEP_SPACE_PERIOD_MIN = 225;

/* ---- Palette ---- */
const SAFE = "#00FF41";
const CAUTION = "#FFB800";
const DANGER = "#FF3131";
const DATA_HUE = "#5FB3FF";

const DASH = "—";

/* ------------------------------------------------------------
   Pure helpers
   ------------------------------------------------------------ */

function isFiniteNonNeg(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** Utilisation / budget colour: < 50 % safe, < 80 % caution, else danger. */
function levelColor(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction < 0.5) return SAFE;
  if (fraction < 0.8) return CAUTION;
  return DANGER;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Coarse age: "42s", "17m", "3h 05m", "2d 4h". */
function formatAge(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds)) return DASH;
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${pad2(m % 60)}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function fmtInt(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : DASH;
}

/** Compact rate for big stats: "9,870", "45.3k", "622k", "1.23M". */
function fmtCompact(n: number): string {
  if (!Number.isFinite(n) || n < 0) return DASH;
  if (n < 10_000) return Math.round(n).toLocaleString("en-US");
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtMs(v: number | null, dp: number): string {
  return v === null || !Number.isFinite(v) ? DASH : v.toFixed(dp);
}

function fmtPct(fraction: number): string {
  return Number.isFinite(fraction) ? `${Math.round(fraction * 100)} %` : DASH;
}

/** 1 / 2 / 2.5 / 5 × 10^k ceiling for a chart's y-range. */
function niceCeil(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

function fmtScale(v: number): string {
  return String(Number(v.toPrecision(3)));
}

/** Runtime guard for the Session 6 budget block (never trust a JSON body). */
function parseBudget(v: unknown): SpaceTrackBudget | null {
  if (!v || typeof v !== "object") return null;
  const {
    requestsLastHour,
    requestsLastMinute,
    hourlyLimit,
    perMinuteLimit,
    sharedCacheEntries,
    sharedCacheHits,
    sharedCacheMisses,
    lastLoginAt,
    sessionCookieAgeSeconds,
  } = v as Record<string, unknown>;
  if (
    !isFiniteNonNeg(requestsLastHour) ||
    !isFiniteNonNeg(requestsLastMinute) ||
    !isFiniteNonNeg(hourlyLimit) ||
    !isFiniteNonNeg(perMinuteLimit) ||
    !isFiniteNonNeg(sharedCacheEntries) ||
    !isFiniteNonNeg(sharedCacheHits) ||
    !isFiniteNonNeg(sharedCacheMisses)
  ) {
    return null;
  }
  return {
    requestsLastHour,
    requestsLastMinute,
    hourlyLimit,
    perMinuteLimit,
    sharedCacheEntries,
    sharedCacheHits,
    sharedCacheMisses,
    lastLoginAt:
      typeof lastLoginAt === "string" && lastLoginAt.trim().length > 0
        ? lastLoginAt.trim()
        : null,
    sessionCookieAgeSeconds: isFiniteNonNeg(sessionCookieAgeSeconds)
      ? sessionCookieAgeSeconds
      : null,
  };
}

interface HealthView {
  region: string | null;
  /** Instance uptime at receipt (reported uptime + time since the cached probe). */
  uptimeSeconds: number | null;
  /** Live counters; null when the server predates Session 6 (or sent garbage). */
  budget: SpaceTrackBudget | null;
  receivedAt: Date;
}

/**
 * @param serverNowMs the response's HTTP Date header (server clock at
 *   response time, 1 s resolution), or null when absent / unparseable.
 */
function parseHealth(
  body: unknown,
  receivedAt: Date,
  serverNowMs: number | null
): HealthView | null {
  if (!body || typeof body !== "object") return null;
  const { region, checkedAt, uptimeSeconds, spaceTrackBudget } =
    body as Record<string, unknown>;
  if (typeof region !== "string" || typeof checkedAt !== "string") return null;

  let uptime: number | null = isFiniteNonNeg(uptimeSeconds) ? uptimeSeconds : null;
  if (uptime !== null) {
    // A cached health response keeps the uptime measured at the probe;
    // add the probe's age. Server clock to server clock (Date header −
    // checkedAt) when the header is there; otherwise this browser's
    // clock, where skew shifts the result. The clamp to the 5-min probe
    // cache is a backstop: it bounds any skew error to <= 5 min.
    const checkedMs = Date.parse(checkedAt);
    const nowMs = serverNowMs ?? receivedAt.getTime();
    if (Number.isFinite(checkedMs)) {
      const elapsedS = (nowMs - checkedMs) / 1000;
      uptime += Math.min(HEALTH_PROBE_CACHE_S, Math.max(0, elapsedS));
    }
  }

  const trimmed = region.trim().slice(0, 40);
  return {
    region: trimmed.length > 0 ? trimmed : null,
    uptimeSeconds: uptime,
    budget: parseBudget(spaceTrackBudget),
    receivedAt,
  };
}

type HealthFetchResult =
  | { ok: true; view: HealthView }
  | { ok: false; error: string };

/* ---- First-poll gate: wait for the header's /api/health (Resource Timing) ---- */

function isHealthEntry(entry: PerformanceEntry): boolean {
  try {
    return new URL(entry.name, "http://localhost").pathname === HEALTH_PATH;
  } catch {
    return false;
  }
}

/** True once any /api/health response has finished in this page (best-effort). */
function healthResponseSeen(): boolean {
  try {
    return (
      typeof performance !== "undefined" &&
      typeof performance.getEntriesByType === "function" &&
      performance.getEntriesByType("resource").some(isHealthEntry)
    );
  } catch {
    return false;
  }
}

/**
 * Calls onSeen when the next /api/health response finishes. Returns null
 * where resource observers are unsupported (the caller's timeout then
 * covers it).
 */
function observeHealthResponse(onSeen: () => void): PerformanceObserver | null {
  if (typeof PerformanceObserver === "undefined") return null;
  try {
    const observer = new PerformanceObserver((list) => {
      if (list.getEntries().some(isHealthEntry)) onSeen();
    });
    observer.observe({ type: "resource" });
    return observer;
  } catch {
    return null;
  }
}

/* ---- Benchmark environment probes (best-effort, never throw) ---- */

/** navigator.deviceMemory is Chromium-only and not in lib.dom. */
interface NavigatorWithDeviceMemory {
  readonly deviceMemory?: unknown;
}

function readDeviceInfo(): { cores: number | null; memoryGb: number | null } {
  if (typeof navigator === "undefined") return { cores: null, memoryGb: null };
  const hc: unknown = navigator.hardwareConcurrency;
  const dm: unknown = (navigator as Navigator & NavigatorWithDeviceMemory)
    .deviceMemory;
  return {
    cores: typeof hc === "number" && Number.isFinite(hc) && hc > 0 ? hc : null,
    memoryGb: typeof dm === "number" && Number.isFinite(dm) && dm > 0 ? dm : null,
  };
}

/** The GPU never changes within a session: probe once, so re-runs open no extra contexts. */
let cachedRenderer: string | null = null;

/**
 * Best-effort GPU string from a throwaway WebGL context (released at
 * once, so it never competes with the 3D map's context). gl.RENDERER
 * first — Firefox / Safari already return a (sanitised) GPU name there
 * and Firefox warns on the debug extension; the extension is only asked
 * when RENDERER is Chromium's masked "WebKit WebGL".
 */
function readWebGlRenderer(): string {
  if (cachedRenderer !== null) return cachedRenderer;
  try {
    if (typeof document === "undefined") return "unavailable";
    const canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl") ??
      (canvas.getContext("experimental-webgl") as WebGLRenderingContext | null);
    if (!gl) return "unavailable";
    let renderer: unknown = gl.getParameter(gl.RENDERER);
    const masked =
      typeof renderer !== "string" ||
      renderer.trim().length === 0 ||
      /^webkit webgl$/i.test(renderer.trim());
    if (masked) {
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      if (info) {
        const unmasked: unknown = gl.getParameter(info.UNMASKED_RENDERER_WEBGL);
        if (typeof unmasked === "string" && unmasked.trim().length > 0) renderer = unmasked;
      }
    }
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    if (typeof renderer !== "string" || renderer.trim().length === 0) return "unavailable";
    cachedRenderer = renderer.trim().slice(0, 160);
    return cachedRenderer;
  } catch {
    return "unavailable";
  }
}

function yieldToUi(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * The benchmark's unit of work: satrecs[from, to) at base[i] + k × 4 min,
 * k = 0 … 24. Module-level so the untimed warm-up pass and the timed pass
 * run the SAME function (its JIT feedback carries over). Returns failures.
 */
function propagateRange(
  satrecs: readonly SatRec[],
  base: Float64Array,
  from: number,
  to: number
): number {
  let failures = 0;
  for (let i = from; i < to; i++) {
    const satrec = satrecs[i];
    const b = base[i];
    for (let k = 0; k < BENCH_STEPS; k++) {
      if (propagateMinutes(satrec, b + k * BENCH_STEP_MINUTES) === null) failures++;
    }
  }
  return failures;
}

/** Overall progress (0–100) across the three equal-weight stages: parse, warm-up, timed. */
function benchProgressPct(stage: 0 | 1 | 2, fraction: number): number {
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  return Math.round(((stage + f) / 3) * 100);
}

/* ------------------------------------------------------------
   Types
   ------------------------------------------------------------ */

interface BusView {
  snap: TelemetrySnapshot;
  /** Last <= 60 distinct map tick durations (ms), oldest first. */
  spark: number[];
}

type BenchPhase =
  | "idle"
  | "loading"
  | "parsing"
  | "warmup"
  | "running"
  | "done"
  | "error";

const BENCH_STAGE_LABEL: Partial<Record<BenchPhase, string>> = {
  parsing: "parsing TLEs",
  warmup: "warm-up pass",
  running: "propagating",
};

interface BenchResult {
  objects: number;
  skipped: number;
  deepSpace: number;
  propagations: number;
  failures: number;
  computeMs: number;
  wallMs: number;
  parseMs: number;
  propsPerSec: number | null;
  usPerProp: number | null;
  cores: number | null;
  memoryGb: number | null;
  renderer: string;
  finishedAt: Date;
}

/* ------------------------------------------------------------
   Small presentational pieces
   ------------------------------------------------------------ */

function SectionTitle({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
      <h3 className="font-mono text-[0.6rem] tracking-widest text-text-muted">{title}</h3>
      {meta && (
        <span className="font-mono text-[0.6rem] text-text-muted">{meta}</span>
      )}
    </div>
  );
}

function DataCell({
  label,
  value,
  color,
  testId,
  title,
}: {
  label: string;
  value: string;
  color?: string;
  testId?: string;
  title?: string;
}) {
  return (
    <div className="min-w-0" title={title}>
      <div className="font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
        {label}
      </div>
      <div
        className="mt-0.5 break-words font-mono text-xs text-text-primary"
        style={color ? { color } : undefined}
        data-testid={testId}
      >
        {value}
      </div>
    </div>
  );
}

function BigStat({
  label,
  value,
  sub,
  color,
  testId,
  title,
}: {
  label: string;
  value: string;
  sub: string;
  color?: string;
  testId?: string;
  title?: string;
}) {
  return (
    <div className="min-w-0 rounded-md border border-glass bg-white/5 p-2.5" title={title}>
      <div className="font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
        {label}
      </div>
      <div
        className="mt-1 truncate font-display text-2xl font-bold leading-tight text-text-primary"
        style={color ? { color } : undefined}
        data-testid={testId}
      >
        {value}
      </div>
      <div className="font-mono text-[0.6rem] text-text-muted">{sub}</div>
    </div>
  );
}

function BudgetBar({
  label,
  used,
  limit,
  testId,
}: {
  label: string;
  used: number;
  limit: number;
  testId: string;
}) {
  const fraction = limit > 0 ? used / limit : Number.NaN;
  const color = levelColor(fraction);
  const width = Number.isFinite(fraction)
    ? Math.max(0, Math.min(100, fraction * 100))
    : 0;
  return (
    <div data-testid={testId}>
      <div className="mb-1 flex items-baseline justify-between gap-2 font-mono">
        <span className="text-[0.6rem] uppercase tracking-widest text-text-muted">
          {label}
        </span>
        <span className="text-xs text-text-primary">
          <span data-testid={`${testId}-value`}>
            {fmtInt(used)} / {limit > 0 ? fmtInt(limit) : DASH}
          </span>
          <span className="text-text-muted"> · {fmtPct(fraction)}</span>
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-white/5">
        <div
          data-testid={`${testId}-fill`}
          className="h-full rounded-full transition-[width] duration-700 ease-out"
          style={{ width: `${width}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

/* ---- Sparkline: last <= 60 map ticks, baseline-anchored at 0 ms ---- */

const SPARK_W = 240;
const SPARK_H = 48;
const SPARK_PAD_Y = 3;

function Sparkline({ values }: { values: readonly number[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Touch pointers ignore pointerleave (see wrapper), so a pinned tooltip
  // needs an outside tap to clear it. Listener only lives while pinned.
  useEffect(() => {
    if (hover === null) return;
    const onDocPointerDown = (e: PointerEvent): void => {
      const el = wrapRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      setHover(null);
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, [hover]);

  const n = values.length;
  let max = 0;
  for (const v of values) if (v > max) max = v;
  const yMax = niceCeil(max);
  const offset = SPARK_LEN - n; // newest sample sits at the right edge
  const xOf = (i: number): number => ((offset + i) / (SPARK_LEN - 1)) * SPARK_W;
  const yOf = (v: number): number =>
    SPARK_H -
    SPARK_PAD_Y -
    (Math.min(yMax, Math.max(0, v)) / yMax) * (SPARK_H - 2 * SPARK_PAD_Y);
  const baselineY = yOf(0);
  const budgetY = FRAME_BUDGET_MS <= yMax ? yOf(FRAME_BUDGET_MS) : null;
  const points = values
    .map((v, i) => `${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`)
    .join(" ");

  const pick = (clientX: number): void => {
    const svg = svgRef.current;
    if (!svg || n === 0) return;
    const rect = svg.getBoundingClientRect();
    if (!(rect.width > 0)) return;
    const slot = Math.round(((clientX - rect.left) / rect.width) * (SPARK_LEN - 1));
    setHover(Math.min(n - 1, Math.max(0, slot - offset)));
  };

  const hovered = hover !== null && hover >= 0 && hover < n ? hover : null;
  let tooltipStyle: CSSProperties | null = null;
  if (hovered !== null) {
    const x = xOf(hovered);
    const tx = x < SPARK_W * 0.2 ? "0%" : x > SPARK_W * 0.8 ? "-100%" : "-50%";
    tooltipStyle = {
      left: `${(x / SPARK_W) * 100}%`,
      top: `${(yOf(values[hovered]) / SPARK_H) * 100}%`,
      transform: `translate(${tx}, calc(-100% - 6px))`,
    };
  }

  const latestX = n > 0 ? xOf(n - 1) : null;
  const latestY = n > 0 ? yOf(values[n - 1]) : null;

  return (
    <div
      ref={wrapRef}
      className="relative"
      onPointerMove={(e) => pick(e.clientX)}
      onPointerDown={(e) => pick(e.clientX)}
      onPointerLeave={(e) => {
        if (e.pointerType !== "touch") setHover(null);
      }}
      onPointerCancel={() => setHover(null)}
      data-testid="telemetry-sparkline"
      data-points={n}
    >
      {/* Inner box holds only the SVG, so the % offsets below map 1:1 to viewBox units. */}
      <div className="relative">
        <svg
          ref={svgRef}
          className="block w-full"
          viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Map tick duration, last ${n} ticks, scale 0 to ${fmtScale(yMax)} ms`}
        >
          <line
            x1={0}
            x2={SPARK_W}
            y1={baselineY}
            y2={baselineY}
            stroke="rgba(255,255,255,0.12)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          {budgetY !== null && (
            <line
              x1={0}
              x2={SPARK_W}
              y1={budgetY}
              y2={budgetY}
              stroke="rgba(255,255,255,0.22)"
              strokeWidth={1}
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {n > 1 && (
            <polyline
              points={points}
              fill="none"
              stroke={DATA_HUE}
              strokeWidth={1.25}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {hovered !== null && (
            <line
              x1={xOf(hovered)}
              x2={xOf(hovered)}
              y1={SPARK_PAD_Y}
              y2={baselineY}
              stroke="rgba(255,255,255,0.25)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {/* Point markers as HTML so they stay round under preserveAspectRatio="none". */}
        {latestX !== null && latestY !== null && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{
              left: `${(latestX / SPARK_W) * 100}%`,
              top: `${(latestY / SPARK_H) * 100}%`,
              backgroundColor: DATA_HUE,
            }}
          />
        )}
        {hovered !== null && tooltipStyle && (
          <div
            data-testid="telemetry-sparkline-tooltip"
            className="pointer-events-none absolute z-10 whitespace-nowrap rounded border border-glass bg-space/95 px-2 py-1 font-mono text-[0.6rem] leading-snug text-text-primary shadow-lg"
            style={tooltipStyle}
          >
            {values[hovered].toFixed(1)} ms
            <span className="text-text-muted">
              {" · "}
              {n - 1 - hovered === 0 ? "latest tick" : `${n - 1 - hovered} ticks ago`}
            </span>
          </div>
        )}
      </div>
      <div className="mt-1 flex flex-wrap justify-between gap-x-2 font-mono text-[0.6rem] text-text-muted">
        <span>
          last {n} tick{n === 1 ? "" : "s"} · scale 0–{fmtScale(yMax)} ms
        </span>
        {budgetY !== null && <span>dashed = 16.7 ms frame</span>}
      </div>
    </div>
  );
}

function ApiRow({ r }: { r: RouteTelemetry }) {
  const label = r.route.length > 40 ? `${r.route.slice(0, 39)}…` : r.route;
  return (
    <tr
      className="border-b border-glass last:border-b-0"
      data-testid="telemetry-api-row"
      data-route={r.route}
    >
      {/* w-full + max-w-0 lets the route column absorb the remaining width
          and ellipsize, so the table never scrolls inside a narrow column. */}
      <td className="w-full max-w-0 truncate py-1.5 pr-3 text-text-primary" title={r.route}>
        {label}
      </td>
      <td className="whitespace-nowrap py-1.5 pr-3 text-right tabular-nums text-text-secondary">
        {fmtInt(r.count)}
      </td>
      <td
        className="whitespace-nowrap py-1.5 pr-3 text-right tabular-nums"
        style={{ color: r.errors > 0 ? DANGER : undefined }}
      >
        <span className={r.errors > 0 ? "" : "text-text-secondary"}>
          {fmtInt(r.errors)}
        </span>
      </td>
      <td className="whitespace-nowrap py-1.5 pr-3 text-right tabular-nums text-text-primary">
        {fmtMs(r.lastMs, 0)}
      </td>
      <td className="whitespace-nowrap py-1.5 pr-3 text-right tabular-nums text-text-secondary">
        {fmtMs(r.p50Ms, 0)}
      </td>
      <td className="whitespace-nowrap py-1.5 text-right tabular-nums text-text-secondary">
        {fmtMs(r.p95Ms, 0)}
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------
   Component
   ------------------------------------------------------------ */

export default function SystemTelemetry() {
  /* ---- Health / budget ---- */
  const [health, setHealth] = useState<HealthView | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  /* ---- Bus snapshot (<= 1 Hz) ---- */
  const [bus, setBus] = useState<BusView | null>(null);
  const sparkRef = useRef<number[]>([]);
  const lastSeenTickAtRef = useRef<number | null>(null);
  const lastPublishRef = useRef<number>(Number.NEGATIVE_INFINITY);

  /* ---- Benchmark ---- */
  const [benchPhase, setBenchPhase] = useState<BenchPhase>("idle");
  const [benchProgress, setBenchProgress] = useState(0);
  const [benchResult, setBenchResult] = useState<BenchResult | null>(null);
  const [benchError, setBenchError] = useState<string | null>(null);
  const benchRunningRef = useRef(false);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /* ---- Health poll (never throws) ---- */
  const fetchHealth = useCallback(async (): Promise<HealthFetchResult> => {
    try {
      const res = await timedFetch(HEALTH_PATH, { cache: "no-store" });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (!res.ok) {
        const err =
          body && typeof body === "object"
            ? (body as Record<string, unknown>).error
            : undefined;
        return {
          ok: false,
          error:
            typeof err === "string" && err.length > 0
              ? err.slice(0, 200)
              : `Health check failed (HTTP ${res.status}).`,
        };
      }
      const dateHeader = res.headers.get("date");
      const serverMs = dateHeader ? Date.parse(dateHeader) : Number.NaN;
      const view = parseHealth(
        body,
        new Date(),
        Number.isFinite(serverMs) ? serverMs : null
      );
      if (!view) {
        return { ok: false, error: "Health check returned an unexpected payload." };
      }
      return { ok: true, view };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Health check failed.",
      };
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let lastPollAt = 0;
    let started = false;
    let firstPollTimer: ReturnType<typeof setTimeout> | null = null;
    let headerObserver: PerformanceObserver | null = null;

    const poll = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      lastPollAt = Date.now();
      const result = await fetchHealth();
      inFlight = false;
      if (cancelled) return;
      if (result.ok) {
        setHealth(result.view);
        setHealthError(null);
      } else {
        // Keep the last good counters on screen, flagged as stale.
        setHealthError(result.error);
      }
    };

    const onInterval = (): void => {
      if (document.visibilityState === "hidden") return; // no polling in a background tab
      void poll();
    };
    const onVisibility = (): void => {
      if (!started) return; // the first poll is still gated (see below)
      if (
        document.visibilityState === "visible" &&
        Date.now() - lastPollAt >= HEALTH_POLL_MS
      ) {
        void poll();
      }
    };

    // First poll: /api/health has no in-flight dedupe, so wait for the
    // header's mount poll to finish (it fills the 5-min probe cache), or
    // HEALTH_FIRST_POLL_MAX_WAIT_MS at most, instead of racing it into a
    // second concurrent Space-Track probe on a cold instance.
    const startPolling = (): void => {
      if (started || cancelled) return;
      started = true;
      if (firstPollTimer !== null) {
        clearTimeout(firstPollTimer);
        firstPollTimer = null;
      }
      headerObserver?.disconnect();
      headerObserver = null;
      void poll();
    };
    if (healthResponseSeen()) {
      startPolling();
    } else {
      headerObserver = observeHealthResponse(startPolling);
      firstPollTimer = setTimeout(startPolling, HEALTH_FIRST_POLL_MAX_WAIT_MS);
    }

    const id = setInterval(onInterval, HEALTH_POLL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearInterval(id);
      if (firstPollTimer !== null) clearTimeout(firstPollTimer);
      headerObserver?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [fetchHealth]);

  /* ---- Telemetry bus: ring every tick, publish <= 1 Hz ---- */
  useEffect(() => {
    let cancelled = false;
    let trailing: ReturnType<typeof setTimeout> | null = null;

    const record = (snap: TelemetrySnapshot): void => {
      const { lastTickAt, lastTickMs } = snap.map;
      if (lastTickAt === null || lastTickMs === null) return;
      if (lastTickAt === lastSeenTickAtRef.current) return; // API-only notify
      lastSeenTickAtRef.current = lastTickAt;
      const ring = sparkRef.current;
      ring.push(lastTickMs);
      if (ring.length > SPARK_LEN) ring.shift();
    };

    const publish = (snap: TelemetrySnapshot): void => {
      if (cancelled) return;
      lastPublishRef.current = performance.now();
      setBus({ snap, spark: sparkRef.current.slice() });
    };

    const initial = getTelemetrySnapshot();
    record(initial);
    publish(initial);

    const unsubscribe = subscribeTelemetry((snap) => {
      if (cancelled) return;
      record(snap);
      const since = performance.now() - lastPublishRef.current;
      if (since >= SNAPSHOT_MIN_INTERVAL_MS) {
        if (trailing !== null) {
          clearTimeout(trailing);
          trailing = null;
        }
        publish(snap);
      } else if (trailing === null) {
        // Trailing edge: the last update inside a window is never lost.
        trailing = setTimeout(() => {
          trailing = null;
          publish(getTelemetrySnapshot());
        }, Math.max(0, SNAPSHOT_MIN_INTERVAL_MS - since));
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
      if (trailing !== null) clearTimeout(trailing);
    };
  }, []);

  /* ---- Client SGP4 benchmark (on demand only) ---- */
  const runBenchmark = useCallback(async (): Promise<void> => {
    if (benchRunningRef.current) return;
    benchRunningRef.current = true;
    setBenchPhase("loading");
    setBenchProgress(0);
    setBenchError(null);
    setBenchResult(null);
    try {
      const sample = await getDebrisSample();
      if (!mountedRef.current) return;

      // Stage 1 — parse, in the same 200-object batches: sgp4init (dsinit
      // for deep-space sets) over 2,000 TLEs is tens of ms, too long for
      // one main-thread task. parseMs sums batch time only (no yields).
      setBenchPhase("parsing");
      const rows = sample.objects;
      const satrecs: SatRec[] = [];
      let skipped = 0;
      let parseMs = 0;
      for (let start = 0; start < rows.length; start += BENCH_BATCH) {
        const end = Math.min(rows.length, start + BENCH_BATCH);
        const t0 = performance.now();
        for (let i = start; i < end; i++) {
          const row = rows[i];
          const l1 = row && typeof row.TLE_LINE1 === "string" ? row.TLE_LINE1 : "";
          const l2 = row && typeof row.TLE_LINE2 === "string" ? row.TLE_LINE2 : "";
          const satrec = parseTle(l1, l2);
          if (satrec) satrecs.push(satrec);
          else skipped++;
        }
        parseMs += performance.now() - t0;
        setBenchProgress(benchProgressPct(0, end / rows.length));
        await yieldToUi();
        if (!mountedRef.current) return;
      }
      const n = satrecs.length;
      if (n === 0) {
        throw new Error("The debris sample contained no parseable element sets.");
      }

      // Epoch offsets are precomputed so the timed loop is SGP4 only.
      const startDate = new Date();
      const base = new Float64Array(n);
      let deepSpace = 0;
      for (let i = 0; i < n; i++) {
        base[i] = minutesSinceEpoch(satrecs[i], startDate);
        if ((2 * Math.PI) / satrecs[i].no >= DEEP_SPACE_PERIOD_MIN) deepSpace++;
      }

      // Stage 2 — one untimed pass of the exact timed workload through the
      // same function: JIT tier-up of the loop, propagateMinutes and both
      // the SGP4 and SDP4 paths happens here, so the FIRST click already
      // measures steady state (a partial warm-up left it ~2x slow).
      setBenchPhase("warmup");
      for (let start = 0; start < n; start += BENCH_BATCH) {
        const end = Math.min(n, start + BENCH_BATCH);
        propagateRange(satrecs, base, start, end);
        setBenchProgress(benchProgressPct(1, end / n));
        await yieldToUi();
        if (!mountedRef.current) return;
      }

      // Stage 3 — the timed pass.
      setBenchPhase("running");
      let computeMs = 0;
      let failures = 0;
      let propagations = 0;
      const wallStart = performance.now();
      for (let start = 0; start < n; start += BENCH_BATCH) {
        const end = Math.min(n, start + BENCH_BATCH);
        const t0 = performance.now();
        failures += propagateRange(satrecs, base, start, end);
        computeMs += performance.now() - t0;
        propagations += (end - start) * BENCH_STEPS;
        setBenchProgress(benchProgressPct(2, end / n));
        await yieldToUi();
        if (!mountedRef.current) return;
      }
      const wallMs = performance.now() - wallStart;

      const device = readDeviceInfo();
      const renderer = readWebGlRenderer();
      setBenchResult({
        objects: n,
        skipped,
        deepSpace,
        propagations,
        failures,
        computeMs,
        wallMs,
        parseMs,
        propsPerSec: computeMs > 0 ? (propagations / computeMs) * 1000 : null,
        usPerProp: propagations > 0 ? (computeMs * 1000) / propagations : null,
        cores: device.cores,
        memoryGb: device.memoryGb,
        renderer,
        finishedAt: new Date(),
      });
      setBenchPhase("done");
    } catch (err) {
      if (!mountedRef.current) return;
      setBenchError(err instanceof Error ? err.message : "Benchmark failed.");
      setBenchPhase("error");
    } finally {
      benchRunningRef.current = false;
    }
  }, []);

  /* ---- Derived: header ---- */
  const regionText = health?.region ?? DASH;
  const uptimeText =
    health && health.uptimeSeconds !== null ? formatAge(health.uptimeSeconds) : DASH;

  /* ---- Derived: budget ---- */
  const budget = health?.budget ?? null;
  const cacheTotal = budget ? budget.sharedCacheHits + budget.sharedCacheMisses : 0;
  const hitRate =
    budget && cacheTotal > 0 ? budget.sharedCacheHits / cacheTotal : Number.NaN;
  let lastLoginText = DASH;
  if (budget) {
    if (budget.lastLoginAt === null) {
      lastLoginText = "none since instance start";
    } else {
      const d = new Date(budget.lastLoginAt);
      lastLoginText = Number.isFinite(d.getTime()) ? `${formatUtc(d)} UTC` : DASH;
    }
  }

  /* ---- Derived: map ---- */
  const map = bus ? bus.snap.map : null;
  const lastTickMs = map ? map.lastTickMs : null;
  const hasTicks = map !== null && map.samples > 0 && lastTickMs !== null;
  // Headline numbers come from the ring's p50, not the last sample: with a
  // 1 ms performance.now() (Safari, Firefox without COOP/COEP) a ~1.5 ms
  // tick reads 1 or 2 ms and a last-sample headline would flip 2× a second.
  const p50TickMs = map ? map.p50TickMs : null;
  const throughput =
    map !== null && p50TickMs !== null && p50TickMs > 0 && map.objects > 0
      ? (map.objects / p50TickMs) * 1000
      : null;
  const frameFraction =
    p50TickMs !== null && Number.isFinite(p50TickMs)
      ? p50TickMs / FRAME_BUDGET_MS
      : Number.NaN;
  const lastTickAtText =
    map && map.lastTickAt !== null && Number.isFinite(map.lastTickAt)
      ? `${formatUtcTime(new Date(map.lastTickAt))} UTC`
      : DASH;

  const routes = bus ? bus.snap.routes : [];
  const benchBusy =
    benchPhase === "loading" ||
    benchPhase === "parsing" ||
    benchPhase === "warmup" ||
    benchPhase === "running";

  return (
    <section className="glass-card overflow-hidden" data-testid="system-telemetry">
      {/* ---------- Header bar ---------- */}
      <div className="flex h-9 items-center justify-between gap-3 border-b border-glass px-3">
        <h2 className="shrink-0 font-mono text-[0.7rem] font-semibold uppercase tracking-widest text-text-secondary">
          SYSTEM TELEMETRY
        </h2>
        <span
          className="min-w-0 truncate font-mono text-[0.6rem] text-text-muted"
          data-testid="telemetry-instance"
          title="Serverless instance that answered the last /api/health poll"
        >
          instance {regionText} · up {uptimeText}
        </span>
      </div>

      <div className="p-4">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* ---------- 1. Space-Track request budget ---------- */}
          <div
            className="min-w-0 rounded-md border border-glass bg-white/5 p-3"
            data-testid="telemetry-budget"
          >
            <SectionTitle title="SPACE-TRACK REQUEST BUDGET" meta="per serving instance" />

            {!health && !healthError && (
              <div className="font-mono text-xs text-text-secondary blink-cursor">
                Polling /api/health
              </div>
            )}

            {!health && healthError && (
              <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
                {healthError}
              </div>
            )}

            {health && (
              <>
                {budget ? (
                  <div className="flex flex-col gap-3">
                    <BudgetBar
                      label="Last hour"
                      used={budget.requestsLastHour}
                      limit={budget.hourlyLimit}
                      testId="telemetry-budget-hour"
                    />
                    <BudgetBar
                      label="Last minute"
                      used={budget.requestsLastMinute}
                      limit={budget.perMinuteLimit}
                      testId="telemetry-budget-minute"
                    />
                    <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
                      <DataCell
                        label="Cache hits / misses"
                        value={`${fmtInt(budget.sharedCacheHits)} / ${fmtInt(budget.sharedCacheMisses)}`}
                        testId="telemetry-cache"
                        title="Shared dataset cache in lib/spacetrack.ts (a hit includes joining an in-flight request), cumulative since this instance started"
                      />
                      <DataCell
                        label="Hit rate"
                        value={fmtPct(hitRate)}
                        testId="telemetry-hit-rate"
                      />
                      <DataCell
                        label="Cached datasets"
                        value={fmtInt(budget.sharedCacheEntries)}
                        testId="telemetry-cache-entries"
                      />
                      <DataCell
                        label="Session cookie age"
                        value={
                          budget.sessionCookieAgeSeconds === null
                            ? "no session"
                            : formatAge(budget.sessionCookieAgeSeconds)
                        }
                        testId="telemetry-cookie-age"
                      />
                      <div className="col-span-2">
                        <DataCell
                          label="Last login (UTC)"
                          value={lastLoginText}
                          testId="telemetry-last-login"
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2" data-testid="telemetry-budget-absent">
                    <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
                      <DataCell label="Last hour" value={DASH} />
                      <DataCell label="Last minute" value={DASH} />
                      <DataCell label="Hit rate" value={DASH} />
                      <DataCell label="Cookie age" value={DASH} />
                    </div>
                    <p className="font-mono text-[0.6rem] leading-relaxed text-text-muted">
                      This deployment&apos;s /api/health does not report spaceTrackBudget.
                    </p>
                  </div>
                )}

                <p className="mt-3 font-mono text-[0.6rem] leading-relaxed text-text-muted">
                  As of {formatUtcTime(health.receivedAt)} UTC · Space-Track published
                  limits 30 / min and 300 / hr per account · counts every login + query
                  this instance made in the rolling window, so with several instances
                  the bars are a lower bound on account usage.
                </p>
                {healthError && (
                  <p
                    className="mt-1 font-mono text-[0.6rem] leading-relaxed"
                    style={{ color: CAUTION }}
                    data-testid="telemetry-budget-stale"
                  >
                    Last poll failed ({healthError}) — showing the previous counters.
                  </p>
                )}
              </>
            )}
          </div>

          {/* ---------- 2. Orbit propagation (map tick telemetry) ---------- */}
          <div
            className="min-w-0 rounded-md border border-glass bg-white/5 p-3"
            data-testid="telemetry-map"
          >
            <SectionTitle
              title="ORBIT PROPAGATION"
              meta={hasTicks && map ? `${map.samples} ticks in ring` : undefined}
            />

            {!hasTicks || !map ? (
              <div
                className="font-mono text-xs text-text-secondary blink-cursor"
                data-testid="telemetry-map-waiting"
              >
                waiting for the 3D map
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-2">
                  <BigStat
                    label="Throughput"
                    value={throughput !== null ? fmtCompact(throughput) : DASH}
                    sub="propagations / s (end-to-end)"
                    testId="telemetry-map-throughput"
                    title={throughput !== null ? `${fmtInt(throughput)} propagations / s` : undefined}
                  />
                  <BigStat
                    label="Frame budget"
                    value={fmtPct(frameFraction)}
                    sub="p50 tick ÷ 16.7 ms"
                    color={Number.isFinite(frameFraction) ? levelColor(frameFraction) : undefined}
                    testId="telemetry-map-frame-budget"
                  />
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">
                  <DataCell
                    label="Last tick"
                    value={`${fmtMs(map.lastTickMs, 1)} ms`}
                    testId="telemetry-map-last"
                  />
                  <DataCell
                    label="p50"
                    value={`${fmtMs(map.p50TickMs, 1)} ms`}
                    testId="telemetry-map-p50"
                  />
                  <DataCell
                    label="p95"
                    value={`${fmtMs(map.p95TickMs, 1)} ms`}
                    testId="telemetry-map-p95"
                  />
                  <DataCell
                    label="Max"
                    value={`${fmtMs(map.maxTickMs, 1)} ms`}
                    testId="telemetry-map-max"
                  />
                  <DataCell
                    label="Objects / tick"
                    value={fmtInt(map.objects)}
                    testId="telemetry-map-objects"
                  />
                  <DataCell
                    label="FPS"
                    value={map.fps !== null && Number.isFinite(map.fps) ? fmtInt(map.fps) : DASH}
                    testId="telemetry-map-fps"
                  />
                </div>
                <Sparkline values={bus ? bus.spark : []} />
                <p className="font-mono text-[0.6rem] leading-relaxed text-text-muted">
                  Last tick {lastTickAtText} · the map re-propagates every visible
                  (zone-filtered) object at 1 Hz live, 4 Hz when time-warped.
                </p>
              </div>
            )}
          </div>

          {/* ---------- 3. API latency ---------- */}
          <div
            className="min-w-0 rounded-md border border-glass bg-white/5 p-3"
            data-testid="telemetry-api"
          >
            <SectionTitle title="API LATENCY" meta="this browser · ms" />
            {routes.length === 0 ? (
              <div className="font-mono text-xs text-text-muted" data-testid="telemetry-api-empty">
                no API calls measured yet — latency is recorded for routes called through timedFetch
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse font-mono text-[0.65rem]">
                    <thead>
                      <tr className="border-b border-glass text-left text-[0.6rem] tracking-widest text-text-muted">
                        <th scope="col" className="py-1.5 pr-3 font-normal">
                          ROUTE
                        </th>
                        <th scope="col" className="py-1.5 pr-3 text-right font-normal">
                          CALLS
                        </th>
                        <th scope="col" className="py-1.5 pr-3 text-right font-normal">
                          ERRORS
                        </th>
                        <th scope="col" className="whitespace-nowrap py-1.5 pr-3 text-right font-normal">
                          LAST ms
                        </th>
                        <th scope="col" className="py-1.5 pr-3 text-right font-normal">
                          p50
                        </th>
                        <th scope="col" className="py-1.5 text-right font-normal">
                          p95
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {routes.map((r) => (
                        <ApiRow key={r.route} r={r} />
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-3 font-mono text-[0.6rem] leading-relaxed text-text-muted">
                  Round trip measured in this browser (network + server + cache).
                  Errors = non-2xx, network failure or cancelled request (panels
                  abort superseded or unmounted calls, e.g. React StrictMode&apos;s
                  dev-only remount). p50 / p95 over each route&apos;s most recent
                  calls (the bus&apos;s bounded ring).
                </p>
              </>
            )}
          </div>

          {/* ---------- 4. Client SGP4 benchmark ---------- */}
          <div
            className="min-w-0 rounded-md border border-glass bg-white/5 p-3 lg:col-span-3"
            data-testid="telemetry-bench"
          >
            <SectionTitle title="CLIENT SGP4 BENCHMARK" meta="on demand · main thread" />
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                data-testid="telemetry-bench-run"
                onClick={() => {
                  void runBenchmark();
                }}
                disabled={benchBusy}
                className="rounded border border-safe/60 bg-safe/15 px-3 py-1 font-mono text-[0.65rem] font-semibold tracking-wide text-safe transition-colors hover:bg-safe/25 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {benchBusy ? "RUNNING…" : "RUN BENCHMARK"}
              </button>
              {benchBusy && (
                <div
                  className="flex min-w-[10rem] flex-1 items-center gap-2"
                  data-testid="telemetry-bench-progress"
                  data-progress={benchProgress}
                >
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/5">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${benchProgress}%`, backgroundColor: DATA_HUE }}
                    />
                  </div>
                  <span className="whitespace-nowrap font-mono text-xs text-text-secondary">
                    {benchPhase === "loading"
                      ? "loading sample…"
                      : `${BENCH_STAGE_LABEL[benchPhase] ?? "working"}… ${benchProgress} %`}
                  </span>
                </div>
              )}
            </div>

            {benchPhase === "idle" && !benchResult && (
              <p className="mt-3 font-mono text-xs text-text-muted">
                Propagates every object in the shared 2,000-object Space-Track sample{" "}
                {BENCH_STEPS}× (t = now … now + {(BENCH_STEPS - 1) * BENCH_STEP_MINUTES} min)
                with satellite.js SGP4 / SDP4 in this browser: one untimed warm-up pass,
                then the timed pass. TLE parsing and both passes run in batches of{" "}
                {BENCH_BATCH} objects so the page stays responsive. Never runs automatically.
              </p>
            )}

            {benchError && (
              <div className="mt-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
                {benchError}
              </div>
            )}

            {benchResult && (
              <div className="mt-3" data-testid="telemetry-bench-result">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                  <BigStat
                    label="Propagations / s"
                    value={benchResult.propsPerSec !== null ? fmtCompact(benchResult.propsPerSec) : DASH}
                    sub="single thread"
                    testId="telemetry-bench-rate"
                    title={
                      benchResult.propsPerSec !== null
                        ? `${fmtInt(benchResult.propsPerSec)} propagations / s`
                        : undefined
                    }
                  />
                  <BigStat
                    label="µs / propagation"
                    value={
                      benchResult.usPerProp !== null ? benchResult.usPerProp.toFixed(2) : DASH
                    }
                    sub="mean, compute only"
                    testId="telemetry-bench-us"
                  />
                  <BigStat
                    label="Propagations"
                    value={fmtInt(benchResult.propagations)}
                    sub={`${fmtInt(benchResult.objects)} objects × ${BENCH_STEPS}`}
                    testId="telemetry-bench-count"
                  />
                  <BigStat
                    label="CPU threads"
                    value={benchResult.cores !== null ? fmtInt(benchResult.cores) : DASH}
                    sub="logical · benchmark uses 1"
                    testId="telemetry-bench-cores"
                  />
                  <BigStat
                    label="Device memory"
                    value={benchResult.memoryGb !== null ? `${fmtScale(benchResult.memoryGb)} GB` : DASH}
                    sub="browser-rounded, if exposed"
                    testId="telemetry-bench-memory"
                  />
                </div>
                <div className="mt-3">
                  <DataCell
                    label="WebGL renderer"
                    value={benchResult.renderer}
                    testId="telemetry-bench-renderer"
                  />
                </div>
                <p className="mt-3 font-mono text-[0.6rem] leading-relaxed text-text-muted">
                  Compute {benchResult.computeMs.toFixed(1)} ms (timed pass; warm-up pass
                  and UI yields excluded) · wall{" "}
                  {benchResult.wallMs.toFixed(1)} ms · TLE parse{" "}
                  {benchResult.parseMs.toFixed(1)} ms for {fmtInt(benchResult.objects)} sets
                  {benchResult.skipped > 0 ? ` (${fmtInt(benchResult.skipped)} unparseable skipped)` : ""}{" "}
                  · {fmtInt(benchResult.deepSpace)} deep-space (SDP4) objects ·{" "}
                  {fmtInt(benchResult.failures)} propagation errors · finished{" "}
                  {formatUtcTime(benchResult.finishedAt)} UTC
                </p>
              </div>
            )}
          </div>
        </div>

        {/* ---------- Footnote: assumptions ---------- */}
        <p
          className="mt-4 font-mono text-[0.6rem] leading-relaxed text-text-muted"
          data-testid="telemetry-footnote"
        >
          Client metrics are for this browser session; server counters are per
          serverless instance (Vercel may run several). Nothing here is sampled from
          other users. Space-Track limits are per account, so with several instances
          the true usage can be higher than one instance&apos;s bars (a lower bound);
          server counters include every visitor&apos;s traffic on that instance but
          carry no per-user data. A map tick is one OrbitalMap pass over every visible
          (zone-filtered) object: SGP4 + ECI→ECF + scene mapping + position-attribute
          write + bounding-sphere refresh. The GPU upload happens at render and is not
          timed, so throughput is end-to-end on the CPU side, not SGP4-only; frame
          budget compares the last tick with one 60 Hz frame (16.7 ms). p50 / p95 are
          nearest-rank over the bus&apos;s bounded rolling window (RING in
          lib/telemetry.ts), and performance.now() resolution is browser-limited, so
          sub-millisecond timings are quantised. Instance uptime = uptime at the
          cached (≤ 5 min) health probe plus the probe&apos;s age on the server clock
          (HTTP Date header; this browser&apos;s clock if absent, error capped at 5 min).
          Cache hits / misses are cumulative since the instance
          started. The benchmark runs single-threaded on the main thread after one
          untimed warm-up pass over the same objects; its results never leave this
          browser.
        </p>
      </div>
    </section>
  );
}
