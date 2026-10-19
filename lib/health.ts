/* ============================================================
   SpaceDebris — subsystem health contract (Session 5, Feature 7)

   PURE TYPES ONLY, no imports: shared by app/api/health/route.ts
   (server) and components/MissionStatusBar.tsx (client). Keeping
   the contract here means the client never has to import from a
   route module, so a future value import can never drag
   lib/spacetrack.ts / process.env into the browser bundle.
   ============================================================ */

export type SpaceTrackHealthStatus = "ONLINE" | "DEGRADED" | "OFFLINE";
export type AnthropicHealthStatus = "READY" | "NOT CONFIGURED";

export interface SpaceTrackHealth {
  status: SpaceTrackHealthStatus;
  /** Round-trip time of the uncached probeGp() query; null when it failed. */
  latencyMs: number | null;
  /** EPOCH string of the newest element set in the gp class; null when unavailable. */
  newestEpoch: string | null;
  /** Human-readable reason for DEGRADED / OFFLINE. Never contains credentials. */
  detail?: string;
}

export interface AnthropicHealth {
  status: AnthropicHealthStatus;
}

/** Live Space-Track request budget for the serving instance (Session 6). */
export interface SpaceTrackBudget {
  requestsLastHour: number;
  requestsLastMinute: number;
  hourlyLimit: number;
  perMinuteLimit: number;
  lastLoginAt: string | null;
  sessionCookieAgeSeconds: number | null;
  sharedCacheEntries: number;
  sharedCacheHits: number;
  sharedCacheMisses: number;
}

export interface HealthStatus {
  /** ISO timestamp of when the checks actually ran (cached responses keep it). */
  checkedAt: string;
  /** Vercel deployment region, or "local" outside Vercel. */
  region: string;
  /** Uptime of this serverless instance / dev server process. */
  uptimeSeconds: number;
  spaceTrack: SpaceTrackHealth;
  anthropic: AnthropicHealth;
  /** True when both SPACETRACK_USERNAME and SPACETRACK_PASSWORD are set. */
  spaceTrackCredentials: boolean;
  /**
   * Live request-budget counters, refreshed on EVERY response (never
   * cached with the probe). Optional so older clients keep working.
   */
  spaceTrackBudget?: SpaceTrackBudget;
}

/* ------------------------------------------------------------
   Cache (module-scoped, single key)
   ------------------------------------------------------------ */
