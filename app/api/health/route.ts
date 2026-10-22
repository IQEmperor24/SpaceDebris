import { NextResponse } from "next/server";
import { probeGp, getSpaceTrackStats } from "@/lib/spacetrack";
import type {
  HealthStatus,
  SpaceTrackHealth,
  SpaceTrackHealthStatus,
} from "@/lib/health";

/* ============================================================
   GET /api/health

   Session 5 — Feature 7: Mission Ops Status Bar (subsystem
   health half). Powers the SPACE-TRACK / CLAUDE LEDs and the
   REGION readout in the page header (components/MissionStatusBar).

   Checks performed per (uncached) request:
   1. spaceTrack — times ONE real catalog query, probeGp() (an
      UNCACHED limit-1 gp query — the shared dataset cache in
      lib/spacetrack.ts is bypassed on purpose so this measures
      live round-trip time),
      i.e. the single newest-epoch element set in the gp class.
        ONLINE    query succeeded in < 4000 ms
        DEGRADED  query succeeded but took >= 4000 ms
        OFFLINE   query threw, or did not answer within the probe
                  timeout (reported as detail, credentials scrubbed)
      newestEpoch = that row's EPOCH string (Space-Track emits
      "YYYY-MM-DD HH:MM:SS" or ISO without a zone designator; the
      client parses it as UTC and shows "TLE 12m old").
      NOTE: the measured latency includes a Space-Track session
      login when the lib's 50-minute cookie is cold, so the very
      first probe on a fresh serverless instance can read DEGRADED
      even when Space-Track itself is fast. Labelled as a probe
      latency on the client for that reason.
   2. anthropic — READY iff ANTHROPIC_API_KEY is a non-empty
      string. NO API call is made: a health check must never spend
      tokens, and it must never prove more than "a key is set".
   3. spaceTrackCredentials — both SPACETRACK_USERNAME and
      SPACETRACK_PASSWORD are present (values never echoed).

   Response shape: HealthStatus (exported below as a TYPE so the
   client component can `import type` it without pulling any
   server code into the browser bundle).

   Cache: 5 min, single key, per serverless instance, plus ONE
   in-flight probe shared by concurrent cold callers — keeps the
   probe at <= 1 Space-Track query per minute per instance
   (rate limit is 30/min, 300/hr) and matches the client's 5-min
   poll. OFFLINE results are cached too so a Space-Track outage
   is not amplified by the dashboard.

   Contract: this route NEVER returns 500. A failed probe is
   reported as spaceTrack.status = "OFFLINE" inside a 200.
   ============================================================ */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const HEALTH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — one Space-Track probe per instance per 5 min (rate budget)
const CACHE_KEY = "health";
/** Probe succeeded slower than this => DEGRADED. */
const DEGRADED_LATENCY_MS = 4000;
/** Probe not answered by this => OFFLINE (well inside maxDuration). */
const PROBE_TIMEOUT_MS = 12_000;

/* ------------------------------------------------------------
   Types — the API contract shared with MissionStatusBar.tsx
   ------------------------------------------------------------ */

/* Health contract types live in lib/health.ts (pure, importable by the
   client). Re-exported here as TYPES ONLY for backwards compatibility. */
export type {
  SpaceTrackHealthStatus,
  AnthropicHealthStatus,
  SpaceTrackHealth,
  AnthropicHealth,
  HealthStatus,
} from "@/lib/health";

interface CacheEntry {
  data: HealthStatus;
  expires: number;
}

const cache = new Map<string, CacheEntry>();

function getCached(): HealthStatus | null {
  const entry = cache.get(CACHE_KEY);
  if (entry && entry.expires > Date.now()) return entry.data;
  if (entry) cache.delete(CACHE_KEY);
  return null;
}

function setCached(data: HealthStatus): void {
  cache.set(CACHE_KEY, { data, expires: Date.now() + HEALTH_CACHE_TTL_MS });
}

/* ------------------------------------------------------------
   Helpers
   ------------------------------------------------------------ */

/** True when the env var exists and is not blank. */
function hasEnv(name: string): boolean {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Remove any secret values from a message before it leaves the
 * server. The lib's own errors only mention env var NAMES, but a
 * network-layer error could in theory echo a request body, so we
 * scrub defensively.
 */
function scrubSecrets(text: string): string {
  let out = text;
  const secretKeys = [
    "SPACETRACK_PASSWORD",
    "SPACETRACK_USERNAME",
    "ANTHROPIC_API_KEY",
  ] as const;
  for (const key of secretKeys) {
    const value = process.env[key];
    if (value && value.length >= 4) {
      out = out.split(value).join("[redacted]");
    }
  }
  return out;
}

function errorMessage(err: unknown): string {
  return scrubSecrets(err instanceof Error ? err.message : "Unknown error");
}

/**
 * Race a promise against a timeout. The losing promise gets a
 * no-op catch so a late rejection can never become an unhandled
 * rejection after we have already answered.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Space-Track probe timed out after ${Math.round(ms / 1000)} s`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
    promise.catch(() => {
      /* swallowed — surfaced via reject() above or already timed out */
    });
  });
}

function regionName(): string {
  const r = process.env.VERCEL_REGION;
  return typeof r === "string" && r.trim().length > 0 ? r.trim() : "local";
}

function uptimeSeconds(): number {
  const up = process.uptime();
  return Number.isFinite(up) ? Math.round(up) : 0;
}

/* ------------------------------------------------------------
   Space-Track probe — NEVER throws
   ------------------------------------------------------------ */

async function probeSpaceTrack(): Promise<SpaceTrackHealth> {
  if (!hasEnv("SPACETRACK_USERNAME") || !hasEnv("SPACETRACK_PASSWORD")) {
    return {
      status: "OFFLINE",
      latencyMs: null,
      newestEpoch: null,
      detail:
        "SPACETRACK_USERNAME / SPACETRACK_PASSWORD not set — add them to .env.local and the Vercel dashboard.",
    };
  }

  const started = performance.now();
  try {
    const rows = await withTimeout(probeGp(), PROBE_TIMEOUT_MS);
    const latencyMs = Math.round(performance.now() - started);

    const first = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    const epochRaw = first ? first.EPOCH : null;
    const newestEpoch =
      typeof epochRaw === "string" && epochRaw.trim().length > 0
        ? epochRaw.trim()
        : null;

    const status: SpaceTrackHealthStatus =
      latencyMs < DEGRADED_LATENCY_MS ? "ONLINE" : "DEGRADED";

    const result: SpaceTrackHealth = { status, latencyMs, newestEpoch };
    if (status === "DEGRADED") {
      result.detail = `Probe answered in ${latencyMs} ms (threshold ${DEGRADED_LATENCY_MS} ms).`;
    } else if (!newestEpoch) {
      result.detail = "Query succeeded but returned no element set.";
    }
    return result;
  } catch (err) {
    const detail = errorMessage(err);
    if (err instanceof Error && err.name === "SpaceTrackBudgetError") {
      // The lib refused to spend a request (per-instance soft budget), so
      // Space-Track itself was not measured: report DEGRADED, not OFFLINE.
      return { status: "DEGRADED", latencyMs: null, newestEpoch: null, detail: `Probe skipped — ${detail}` };
    }
    console.error("[/api/health] Space-Track probe failed:", detail);
    return { status: "OFFLINE", latencyMs: null, newestEpoch: null, detail };
  }
}

/* ------------------------------------------------------------
   Handler
   ------------------------------------------------------------ */

/**
 * One in-flight probe per instance. The header's MissionStatusBar and the
 * System Telemetry panel poll this route at the same moments, and two
 * viewers can cold-start together: they share ONE Space-Track probe
 * instead of each spending a request from the 30/min budget.
 */
let inFlight: Promise<HealthStatus> | null = null;

async function buildHealth(): Promise<HealthStatus> {
  const spaceTrack = await probeSpaceTrack();

  const result: HealthStatus = {
    checkedAt: new Date().toISOString(),
    region: regionName(),
    uptimeSeconds: uptimeSeconds(),
    spaceTrack,
    anthropic: {
      status: hasEnv("ANTHROPIC_API_KEY") ? "READY" : "NOT CONFIGURED",
    },
    spaceTrackCredentials:
      hasEnv("SPACETRACK_USERNAME") && hasEnv("SPACETRACK_PASSWORD"),
  };

  setCached(result);
  return result;
}

export async function GET(): Promise<NextResponse> {
  const cached = getCached();
  if (cached) {
    // Budget counters are live even when the probe is served from cache.
    return NextResponse.json({ ...cached, spaceTrackBudget: getSpaceTrackStats() });
  }

  try {
    if (!inFlight) {
      inFlight = buildHealth().finally(() => {
        inFlight = null;
      });
    }
    const result = await inFlight;
    return NextResponse.json({ ...result, spaceTrackBudget: getSpaceTrackStats() });
  } catch (err) {
    // probeSpaceTrack() never throws, so this only guards the
    // bookkeeping above — but a health endpoint must never 500.
    const detail = errorMessage(err);
    console.error("[/api/health] error:", detail);

    const fallback: HealthStatus = {
      checkedAt: new Date().toISOString(),
      region: regionName(),
      uptimeSeconds: uptimeSeconds(),
      spaceTrack: { status: "OFFLINE", latencyMs: null, newestEpoch: null, detail },
      anthropic: {
        status: hasEnv("ANTHROPIC_API_KEY") ? "READY" : "NOT CONFIGURED",
      },
      spaceTrackCredentials:
        hasEnv("SPACETRACK_USERNAME") && hasEnv("SPACETRACK_PASSWORD"),
    };
    return NextResponse.json({ ...fallback, spaceTrackBudget: getSpaceTrackStats() });
  }
}
