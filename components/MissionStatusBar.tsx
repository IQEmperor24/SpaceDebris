"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  AnthropicHealthStatus,
  HealthStatus,
  SpaceTrackHealthStatus,
} from "@/app/api/health/route";
import {
  dateToJulian,
  dayOfYear,
  formatDuration,
  formatHoursHms,
  formatUtc,
  formatUtcTime,
  gmstHours,
} from "@/lib/orbital";

/* ============================================================
   Session 5 — Feature 7: Mission Ops Status Bar

   A slim, single-line strip mounted in the page HEADER (not a
   glass-card panel). Mission-control style clocks + subsystem
   health, in the order a TOPO / flight-dynamics console shows them:

     14:03:22 UTC · 2026-10-10 · DOY 283   GMST 03:14:15   JD 2461324.09
     | ● SPACE-TRACK ONLINE · TLE 12m old   ● CLAUDE READY | REGION iad1

   Layout. Below lg the header stacks (flex-col), the strip has the
   full width and simply wraps (flex-wrap). From lg the header is a
   row shared with the title block (h1 + 82-char subtitle, ~630 px at
   md:text-sm). Both are flex items with flex-shrink 1, so they shrink
   in PROPORTION to their content width: the strip would get ~55 % of
   the row and break onto two lines on every lg viewport below
   ~1490 px (1280 × 800 laptops, 1366 × 768 projectors). The spec wants
   ONE dense line from 1024 px up, so from lg the strip is `shrink-0`
   (it keeps its natural width; the subtitle wraps instead) and the
   lower-priority segments are revealed per breakpoint so the row can
   never overflow horizontally:
     lg  (≥ 1024)  UTC time · GMST · JD · | · SPACE-TRACK · CLAUDE  ≈ 510 px
     xl  (≥ 1280)  + calendar date / DOY, + TLE age                 ≈ 740 px
     2xl (≥ 1536)  + | REGION (everything)                         ≈ 845 px
   Widths are worst-case strings (DEGRADED, "TLE 2d 14h old") at Syne
   Mono's 0.55 em advance and 0.65 rem; "NOT CONFIGURED" adds ~50 px.
   The title block keeps ≥ ~460 px at every breakpoint edge, so the
   subtitle wraps to at most two lines, and at 2xl it stays on one.

   Clocks (all from lib/orbital — nothing re-derived here):
   - UTC wall clock + calendar date + day of year
   - GMST (Greenwich Mean Sidereal Time, satellite.js gstime)
   - Julian Date (UTC-based, as SGP4 / satellite.js use it)
   Tick at 1 Hz, aligned to the second boundary, via a
   self-rescheduling setTimeout inside useEffect. Initial state is
   null and renders "--:--:--" placeholders so the first client
   render never depends on Date (no SSR/CSR mismatch even though
   the page mounts this with ssr:false).

   Health (GET /api/health, polled on mount + every 60 s, matching
   the route's 60 s cache):
   - SPACE-TRACK LED  ONLINE / DEGRADED / OFFLINE
       + "TLE <age> old": age of the newest element-set EPOCH in
       the gp catalog, a proxy for catalog freshness. Space-Track
       EPOCH strings carry no zone designator and are UTC, so we
       append "Z" before parsing. Unparseable => status only.
       The probe is `orderby EPOCH desc limit 1` over the WHOLE gp
       class, and gp does carry element sets whose EPOCH is ahead of
       wall clock (predictive / analyst sets). Such a lead is not a
       freshness measure, so it is shown as "TLE epoch ahead" with no
       number — the exact lead goes in the tooltip — and up to 60 s
       ahead is treated as clock skew ("<1m old").
   - CLAUDE LED       READY / NOT CONFIGURED — reflects ONLY whether
       an API key is configured; the route never spends tokens.
   - REGION           Vercel region (or "local").
   A failed poll turns BOTH LEDs grey with "UNKNOWN" (never throws,
   never shows stale green). Before the first poll completes the
   LEDs are grey "UNKNOWN" as well — the status is literally unknown.

   Assumptions shown to the operator (via title tooltips):
   - Space-Track latency is a probe round-trip that may include a
     session login on a cold instance.
   - "TLE age" is the newest epoch in the WHOLE catalog, not any
     specific object's element set.
   ============================================================ */

const HEALTH_POLL_MS = 60_000;
/** A newest EPOCH at most this far ahead of the client clock is skew, not a predictive set. */
const EPOCH_SKEW_TOLERANCE_MS = 60_000;

const COLOR_SAFE = "#00FF41";
const COLOR_CAUTION = "#FFB800";
const COLOR_DANGER = "#FF3131";
const COLOR_UNKNOWN = "#444444";

const SPACETRACK_LED_COLOR: Record<SpaceTrackHealthStatus, string> = {
  ONLINE: COLOR_SAFE,
  DEGRADED: COLOR_CAUTION,
  OFFLINE: COLOR_DANGER,
};

const ANTHROPIC_LED_COLOR: Record<AnthropicHealthStatus, string> = {
  READY: COLOR_SAFE,
  "NOT CONFIGURED": COLOR_CAUTION,
};

const SPACETRACK_STATUSES: ReadonlySet<string> = new Set<SpaceTrackHealthStatus>([
  "ONLINE",
  "DEGRADED",
  "OFFLINE",
]);
const ANTHROPIC_STATUSES: ReadonlySet<string> = new Set<AnthropicHealthStatus>([
  "READY",
  "NOT CONFIGURED",
]);

const PLACEHOLDER_TIME = "--:--:--";
const PLACEHOLDER_DATE = "----------";
const PLACEHOLDER_DOY = "---";
const PLACEHOLDER_JD = "-------.--";

/* ------------------------------------------------------------
   Pure helpers
   ------------------------------------------------------------ */

/**
 * Parse a Space-Track EPOCH string as UTC.
 *   "2026-10-10 14:03:22"        -> 2026-10-10T14:03:22Z
 *   "2026-10-10T14:03:22.123456" -> 2026-10-10T14:03:22.123Z
 *   "2026-10-10T14:03:22Z"       -> unchanged (zone already present)
 * Returns null for anything that does not parse to a finite Date.
 */
function parseSpaceTrackEpoch(raw: string | null | undefined): Date | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  s = s.replace(" ", "T");
  if (!s.includes("T")) s += "T00:00:00";
  // JS Date accepts at most millisecond precision reliably.
  s = s.replace(/(\.\d{3})\d+/, "$1");
  // Append "Z" only when there is no zone designator (Z, +hh:mm, -hhmm).
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) s += "Z";
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Minute-granularity age so the header does not flicker every second.
 *   "<1m", "12m", "3h 05m", "2d 4h"
 */
function formatAgeCompact(ms: number): string {
  const totalMinutes = Math.floor(Math.abs(ms) / 60_000);
  if (totalMinutes < 1) return "<1m";
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** Runtime guard: never trust a JSON body to match the TS contract. */
function isHealthStatus(v: unknown): v is HealthStatus {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const st = o.spaceTrack;
  const an = o.anthropic;
  if (!st || typeof st !== "object" || !an || typeof an !== "object") {
    return false;
  }
  const stStatus = (st as Record<string, unknown>).status;
  const anStatus = (an as Record<string, unknown>).status;
  return (
    typeof o.checkedAt === "string" &&
    typeof o.region === "string" &&
    typeof stStatus === "string" &&
    SPACETRACK_STATUSES.has(stStatus) &&
    typeof anStatus === "string" &&
    ANTHROPIC_STATUSES.has(anStatus)
  );
}

type HealthFetchResult =
  | { ok: true; data: HealthStatus }
  | { ok: false; error: string };

/* ------------------------------------------------------------
   Small presentational pieces
   ------------------------------------------------------------ */

function Separator({ className = "" }: { className?: string }) {
  return (
    <span className={`text-text-muted ${className}`.trim()} aria-hidden="true">
      |
    </span>
  );
}

/** 6 px LED dot. Glows in its colour; pulses red when OFFLINE. */
function Led({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
        pulse ? "animate-pulse-alert" : ""
      }`}
      style={{
        backgroundColor: color,
        boxShadow: color === COLOR_UNKNOWN ? "none" : `0 0 6px ${color}`,
      }}
    />
  );
}

/* ------------------------------------------------------------
   Component
   ------------------------------------------------------------ */

export default function MissionStatusBar() {
  // null until the first tick so the initial render is Date-free.
  const [now, setNow] = useState<Date | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  /* ---- 1 Hz clock, aligned to the UTC second boundary ---- */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      const d = new Date();
      setNow(d);
      timer = setTimeout(tick, 1000 - (d.getTime() % 1000));
    };
    tick();
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, []);

  /* ---- Health poll: never throws ---- */
  const fetchHealth = useCallback(async (): Promise<HealthFetchResult> => {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (!res.ok) {
        const msg =
          body && typeof body === "object" &&
          typeof (body as Record<string, unknown>).error === "string"
            ? ((body as Record<string, unknown>).error as string)
            : `Health check failed (HTTP ${res.status}).`;
        return { ok: false, error: msg };
      }
      if (!isHealthStatus(body)) {
        return { ok: false, error: "Health check returned an unexpected payload." };
      }
      return { ok: true, data: body };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Health check failed.",
      };
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      const result = await fetchHealth();
      if (cancelled) return;
      if (result.ok) {
        setHealth(result.data);
        setHealthError(null);
      } else {
        setHealth(null);
        setHealthError(result.error);
      }
    };

    void poll();
    const id = setInterval(() => {
      void poll();
    }, HEALTH_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [fetchHealth]);

  /* ---- Derived clock strings (all guarded by `now`) ---- */
  const utcTime = now ? formatUtcTime(now) : PLACEHOLDER_TIME;
  const utcDate = now ? formatUtc(now).slice(0, 10) : PLACEHOLDER_DATE;
  const doy = now ? String(dayOfYear(now)).padStart(3, "0") : PLACEHOLDER_DOY;
  const gmst = now ? formatHoursHms(gmstHours(now)) : PLACEHOLDER_TIME;
  const jd = now ? dateToJulian(now).toFixed(2) : PLACEHOLDER_JD;

  /* ---- Derived health strings ---- */
  const spaceTrack = health ? health.spaceTrack : null;
  const spaceTrackStatus = spaceTrack ? spaceTrack.status : null;
  const spaceTrackColor = spaceTrackStatus
    ? SPACETRACK_LED_COLOR[spaceTrackStatus]
    : COLOR_UNKNOWN;

  const newestEpochDate = spaceTrack
    ? parseSpaceTrackEpoch(spaceTrack.newestEpoch)
    : null;
  let tleAgeText: string | null = null;
  let tleAgeNote: string | null = null;
  if (newestEpochDate && now) {
    const ageMs = now.getTime() - newestEpochDate.getTime();
    if (ageMs >= -EPOCH_SKEW_TOLERANCE_MS) {
      tleAgeText = `TLE ${formatAgeCompact(Math.max(0, ageMs))} old`;
    } else {
      // The newest EPOCH in the catalog is ahead of wall clock (a
      // predictive / analyst element set). Its lead says nothing about
      // catalog freshness, so show the condition without a number and
      // put the exact lead in the tooltip.
      tleAgeText = "TLE epoch ahead";
      tleAgeNote = `Newest EPOCH is ${formatAgeCompact(ageMs)} ahead of wall clock (predictive or analyst element set) — not a catalog-freshness indicator`;
    }
  }

  const spaceTrackTitleParts: string[] = [];
  if (spaceTrack) {
    if (spaceTrack.latencyMs !== null && Number.isFinite(spaceTrack.latencyMs)) {
      spaceTrackTitleParts.push(
        `Probe round-trip ${spaceTrack.latencyMs} ms (fetchTLEs(1); may include session login on a cold instance)`
      );
    }
    if (newestEpochDate) {
      spaceTrackTitleParts.push(
        `Newest gp element-set epoch ${formatUtc(newestEpochDate)} UTC (whole catalog)`
      );
    }
    if (tleAgeNote) spaceTrackTitleParts.push(tleAgeNote);
    if (spaceTrack.detail) spaceTrackTitleParts.push(spaceTrack.detail);
    if (health && !health.spaceTrackCredentials) {
      spaceTrackTitleParts.push("Space-Track credentials not configured");
    }
  } else {
    spaceTrackTitleParts.push(
      healthError ? `Health poll failed: ${healthError}` : "Polling /api/health…"
    );
  }
  if (health) {
    const checked = new Date(health.checkedAt);
    if (Number.isFinite(checked.getTime())) {
      spaceTrackTitleParts.push(`Checked ${formatUtcTime(checked)} UTC`);
    }
  }

  const anthropicStatus = health ? health.anthropic.status : null;
  const anthropicColor = anthropicStatus
    ? ANTHROPIC_LED_COLOR[anthropicStatus]
    : COLOR_UNKNOWN;
  const anthropicTitle = anthropicStatus
    ? anthropicStatus === "READY"
      ? "ANTHROPIC_API_KEY is configured. No API call is made by the health check."
      : "ANTHROPIC_API_KEY is not set — AI features will fail until it is."
    : healthError
      ? `Health poll failed: ${healthError}`
      : "Polling /api/health…";

  const region = health ? health.region : null;
  const regionTitle =
    health && Number.isFinite(health.uptimeSeconds)
      ? `Serverless instance uptime ${formatDuration(health.uptimeSeconds * 1000)}`
      : "Deployment region";

  return (
    <div
      data-testid="mission-status-bar"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[0.65rem] text-text-secondary lg:shrink-0"
    >
      {/* ---- Clocks ---- */}
      <span
        data-testid="utc-clock"
        className="whitespace-nowrap"
        title="Coordinated Universal Time · calendar date · day of year"
      >
        <span className="text-text-primary">{utcTime}</span>{" "}
        <span className="text-text-muted">UTC</span>
        {/* Density tier: calendar date / DOY from xl (see Layout above). */}
        <span className="lg:hidden xl:inline">
          <span className="text-text-muted"> · </span>
          <span className="text-text-secondary">
            {utcDate} · DOY {doy}
          </span>
        </span>
      </span>

      <span
        data-testid="gmst-clock"
        className="whitespace-nowrap"
        title="Greenwich Mean Sidereal Time (satellite.js gstime)"
      >
        <span className="text-text-muted">GMST</span>{" "}
        <span className="text-text-primary">{gmst}</span>
      </span>

      <span
        data-testid="julian-date"
        className="whitespace-nowrap"
        title="Julian Date, UTC-based (as used by SGP4 / satellite.js)"
      >
        <span className="text-text-muted">JD</span>{" "}
        <span className="text-text-primary">{jd}</span>
      </span>

      <Separator />

      {/* ---- Subsystem health ---- */}
      <span
        data-testid="health-spacetrack"
        data-status={spaceTrackStatus ?? "UNKNOWN"}
        className="inline-flex items-center gap-1.5 whitespace-nowrap"
        title={spaceTrackTitleParts.join(" · ")}
      >
        <Led
          color={spaceTrackColor}
          pulse={spaceTrackStatus === "OFFLINE"}
        />
        <span className="text-text-muted">SPACE-TRACK</span>{" "}
        {/* aria-live on the status word only — the TLE age below changes
            every minute and must not be announced each time. */}
        <span
          aria-live="polite"
          className="font-semibold"
          style={{ color: spaceTrackColor }}
        >
          {spaceTrackStatus ?? "UNKNOWN"}
        </span>
        {tleAgeText && (
          /* Density tier: TLE age from xl; the tooltip always has it. */
          <span className="text-text-secondary lg:hidden xl:inline">
            {" "}
            · {tleAgeText}
          </span>
        )}
      </span>

      <span
        data-testid="health-anthropic"
        data-status={anthropicStatus ?? "UNKNOWN"}
        className="inline-flex items-center gap-1.5 whitespace-nowrap"
        title={anthropicTitle}
      >
        <Led color={anthropicColor} />
        <span className="text-text-muted">CLAUDE</span>{" "}
        <span
          aria-live="polite"
          className="font-semibold"
          style={{ color: anthropicColor }}
        >
          {anthropicStatus ?? "UNKNOWN"}
        </span>
      </span>

      <Separator className="lg:hidden 2xl:inline" />

      {/* ---- Region (density tier: 2xl — lowest priority) ---- */}
      <span
        data-testid="health-region"
        className="whitespace-nowrap text-text-muted lg:hidden 2xl:inline"
        title={regionTitle}
      >
        REGION {region ?? "--"}
      </span>
    </div>
  );
}
