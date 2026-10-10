"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SatRec } from "satellite.js";
import type { SpaceTrackTLE } from "@/lib/spacetrack";
import type { TleElements } from "@/lib/orbital";
import {
  ISS_KEEP_OUT_BOX_KM,
  ISS_NORAD_ID,
  ISS_PC_RED_THRESHOLD,
  ISS_PC_YELLOW_THRESHOLD,
  JSC_SITE,
  formatDuration,
  formatUtc,
  formatUtcTime,
  geodeticFromEci,
  parseTle,
  propagateAt,
  speedKmS,
  tleElements,
} from "@/lib/orbital";
import type {
  GroundTrackPoint,
  IssCaLevel,
  IssCdmAssessment,
  IssStatus,
  PassPrediction,
} from "@/lib/iss";
import {
  ISS_CDM_SCAN_LIMIT,
  ISS_DISPLAY_NAME,
  PASS_MIN_ELEVATION_DEG,
  PASS_WINDOW_HOURS,
  assessIssCdm,
  compassPoint,
  formatLatitude,
  formatLongitude,
  formatPc,
  formatPcThreshold,
  groundTrack,
  parseUtcTimestamp,
  predictPasses,
  sortCdmsByTca,
  splitTrackAtSeam,
  tleAgeHours,
  worstIssCaLevel,
} from "@/lib/iss";

/* ============================================================
   Session 5 — Feature 3: ISS TOPO Console

   A Trajectory Operations Officer (TOPO) style status panel for
   the International Space Station (NORAD 25544).

   Data flow
   - GET /api/iss every 300 s (matches the route's 5-min cache) →
     { tle, cdms, fetchedAt, errors }. Two-timer pattern as in
     FleetDashboard: one fetch interval + one 1 Hz countdown.
   - The TLE is parsed ONCE into a satellite.js SatRec (lib/orbital
     parseTle) and every derived quantity is computed client-side:
       · 1 Hz   : propagateAt(now) → geodetic lat/lon/alt + speed
                  (LAT / LON / ALT / VEL cells + the map marker), and
                  groundTrack(±46 min) centred on the SAME instant so
                  the past/future split always sits under the marker
                  (94 SGP4 propagations ≈ 1 ms).
       · 60 s   : predictPasses(JSC, 24 h) — ≈ 4,300 SGP4
                  propagations, ~30-80 ms.
       · once   : tleElements → PERIOD / INCL / epoch.
   - CDM rows are classified by assessIssCdm against the NASA ISS
     CA thresholds held in lib/orbital (RED ≥ 1e-4, YELLOW ≥ 1e-5).

   Assumptions shown on screen (nothing is overclaimed)
   - Passes are GEOMETRIC (elevation ≥ 10° mask over JSC);
     visibility (sunlit ISS over a dark site) is NOT evaluated.
   - SGP4 on the public element set: ~1 km positional error that
     grows with epoch age — the epoch age is displayed.
   - The public cdm_public feed may carry no ISS messages at all;
     an empty list is shown as NOMINAL for the PUBLIC feed only,
     never as a statement about NASA's internal CA picture. Only the
     ISS_CDM_SCAN_LIMIT soonest-TCA public messages are screened
     (see lib/iss.ts) and the card says so beneath the badge.

   Mounted by app/page.tsx via next/dynamic (ssr: false). Clocks
   are initialised inside effects, never during render.
   ============================================================ */

const REFRESH_SECONDS = 300; // = /api/iss cache TTL
const PASS_RECOMPUTE_MS = 60_000;
const LIVE_TICK_MS = 1_000;
const FOLLOWING_PASS_COUNT = 2;
/** Element sets older than this are flagged amber (SGP4 error growth). */
const TLE_AGE_CAUTION_HOURS = 24;

const CA_COLORS: Record<IssCaLevel, string> = {
  RED: "#FF3131",
  YELLOW: "#FFB800",
  GREEN: "#00FF41",
};

/* ---- Map geometry: equirectangular, viewBox 0 0 360 180 ---- */
const MAP_W = 360;
const MAP_H = 180;
const GRATICULE_LON = [-180, -150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150, 180];
const GRATICULE_LAT = [-90, -60, -30, 0, 30, 60, 90];
const LON_LABELS = [-180, -90, 0, 90, 180];
const LAT_LABELS = [60, 30, 0, -30, -60];

function lonToX(lonDeg: number): number {
  return lonDeg + 180;
}
function latToY(latDeg: number): number {
  return 90 - latDeg;
}
function polylinePoints(points: readonly GroundTrackPoint[]): string {
  return points
    .map((p) => `${lonToX(p.longitudeDeg).toFixed(2)},${latToY(p.latitudeDeg).toFixed(2)}`)
    .join(" ");
}

/* ---- Response shape guard (never trust a JSON body blindly) ---- */
function isIssStatus(v: unknown): v is IssStatus {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    "tle" in o &&
    Array.isArray(o.cdms) &&
    typeof o.fetchedAt === "string" &&
    typeof o.errors === "object" &&
    o.errors !== null
  );
}

/* ------------------------------------------------------------
   Small presentational pieces
   ------------------------------------------------------------ */

function DataCell({
  label,
  value,
  testId,
  className,
}: {
  label: string;
  value: string;
  testId?: string;
  /** Extra classes for the cell wrapper (e.g. a grid span). */
  className?: string;
}) {
  return (
    <div
      className={`rounded-md border border-glass bg-white/5 px-2 py-2${
        className ? ` ${className}` : ""
      }`}
    >
      <div className="font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
        {label}
      </div>
      <div
        className="mt-0.5 truncate font-mono text-xs text-text-primary sm:text-sm"
        data-testid={testId}
      >
        {value}
      </div>
    </div>
  );
}

function LevelBadge({ level, label }: { level: IssCaLevel; label?: string }) {
  const color = CA_COLORS[level];
  return (
    <span
      className={`shrink-0 rounded px-2 py-0.5 font-display text-[0.6rem] font-bold ${
        level === "RED" ? "animate-pulse-alert" : ""
      }`}
      style={{ color, border: `1px solid ${color}` }}
    >
      {label ?? level}
    </span>
  );
}

/**
 * Card headings are written in their literal on-screen case (no CSS
 * `uppercase`), so textContent matches the spec strings exactly —
 * e.g. "PUBLIC CDMs" keeps its lower-case s.
 */
function CardTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[0.6rem] tracking-widest text-text-muted">
      {children}
    </div>
  );
}

/* ------------------------------------------------------------
   Ground-track map (inline SVG)
   ------------------------------------------------------------ */

function GroundTrackMap({
  track,
  issLatDeg,
  issLonDeg,
}: {
  track: readonly GroundTrackPoint[];
  issLatDeg: number | null;
  issLonDeg: number | null;
}) {
  // Past = minutesFromCenter < 0, future = ≥ 0. The centre point is
  // shared so the two polylines meet at the ISS marker.
  const { pastSegments, futureSegments } = useMemo(() => {
    const past = track.filter((p) => p.minutesFromCenter <= 0);
    const future = track.filter((p) => p.minutesFromCenter >= 0);
    return {
      pastSegments: splitTrackAtSeam(past),
      futureSegments: splitTrackAtSeam(future),
    };
  }, [track]);

  const jscX = lonToX(JSC_SITE.longitudeDeg);
  const jscY = latToY(JSC_SITE.latitudeDeg);
  const showIss =
    issLatDeg !== null &&
    issLonDeg !== null &&
    Number.isFinite(issLatDeg) &&
    Number.isFinite(issLonDeg);

  return (
    <svg
      viewBox={`0 0 ${MAP_W} ${MAP_H}`}
      className="h-auto w-full"
      role="img"
      aria-label="ISS ground track, equirectangular projection"
    >
      {/* Graticule — every 30°; equator + prime meridian brighter */}
      {GRATICULE_LON.map((lon) => (
        <line
          key={`lon-${lon}`}
          x1={lonToX(lon)}
          y1={0}
          x2={lonToX(lon)}
          y2={MAP_H}
          stroke={lon === 0 ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.08)"}
          strokeWidth={0.5}
        />
      ))}
      {GRATICULE_LAT.map((lat) => (
        <line
          key={`lat-${lat}`}
          x1={0}
          y1={latToY(lat)}
          x2={MAP_W}
          y2={latToY(lat)}
          stroke={lat === 0 ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.08)"}
          strokeWidth={0.5}
        />
      ))}

      {/* Past track */}
      {pastSegments.map((seg, i) =>
        seg.length > 1 ? (
          <polyline
            key={`past-${i}`}
            points={polylinePoints(seg)}
            fill="none"
            stroke="rgba(255,255,255,0.25)"
            strokeWidth={1}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null
      )}
      {/* Future track */}
      {futureSegments.map((seg, i) =>
        seg.length > 1 ? (
          <polyline
            key={`future-${i}`}
            points={polylinePoints(seg)}
            fill="none"
            stroke="#00FF41"
            strokeWidth={1.25}
            strokeDasharray="2 2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null
      )}

      {/* JSC Houston */}
      <rect x={jscX - 1.5} y={jscY - 1.5} width={3} height={3} fill="#FFB800" />
      <text
        x={jscX + 4}
        y={jscY + 2}
        fontSize={6}
        fill="#FFB800"
        fontFamily="'Syne Mono', monospace"
      >
        JSC
      </text>

      {/* ISS marker — static ring + dot */}
      {showIss && (
        <g>
          <circle
            cx={lonToX(issLonDeg)}
            cy={latToY(issLatDeg)}
            r={5}
            fill="none"
            stroke="#00FF41"
            strokeOpacity={0.5}
            strokeWidth={0.75}
          />
          <circle
            cx={lonToX(issLonDeg)}
            cy={latToY(issLatDeg)}
            r={2.5}
            fill="#00FF41"
          />
        </g>
      )}

      {/* Edge labels */}
      {LON_LABELS.map((lon) => (
        <text
          key={`lon-label-${lon}`}
          x={lon === -180 ? 1 : lon === 180 ? MAP_W - 1 : lonToX(lon)}
          y={MAP_H - 2}
          fontSize={5}
          fill="#444444"
          textAnchor={lon === -180 ? "start" : lon === 180 ? "end" : "middle"}
          fontFamily="'Syne Mono', monospace"
        >
          {lon}
        </text>
      ))}
      {LAT_LABELS.map((lat) => (
        <text
          key={`lat-label-${lat}`}
          x={1.5}
          y={latToY(lat) - 1}
          fontSize={5}
          fill="#444444"
          textAnchor="start"
          fontFamily="'Syne Mono', monospace"
        >
          {lat}
        </text>
      ))}
    </svg>
  );
}

/* ------------------------------------------------------------
   Next pass over JSC
   ------------------------------------------------------------ */

function azimuthLabel(deg: number): string {
  if (!Number.isFinite(deg)) return "—";
  return `${compassPoint(deg)} ${Math.round(deg)}°`;
}

function NextPassCard({
  passes,
  nowMs,
  elementSetReady,
}: {
  passes: PassPrediction[] | null;
  nowMs: number | null;
  /** False when no SatRec exists — prediction is impossible, not pending. */
  elementSetReady: boolean;
}) {
  const upcoming = useMemo(() => {
    if (!passes || nowMs === null) return [];
    return passes.filter((p) => {
      const los = Date.parse(p.los);
      return Number.isFinite(los) && los > nowMs;
    });
  }, [passes, nowMs]);

  const next = upcoming.length > 0 ? upcoming[0] : null;
  const following = upcoming.slice(1, 1 + FOLLOWING_PASS_COUNT);

  let body: React.ReactNode;
  if (!elementSetReady) {
    body = (
      <div className="font-mono text-xs text-text-secondary">
        Pass prediction unavailable — no ISS element set.
      </div>
    );
  } else if (passes === null || nowMs === null) {
    body = (
      <div className="font-mono text-xs text-text-secondary blink-cursor">
        Computing pass geometry
      </div>
    );
  } else if (!next) {
    body = (
      <div className="font-mono text-xs text-text-secondary">
        No pass ≥ {PASS_MIN_ELEVATION_DEG}° over JSC in the next {PASS_WINDOW_HOURS} h.
      </div>
    );
  } else {
    const aosMs = Date.parse(next.aos);
    const losMs = Date.parse(next.los);
    const inProgress = Number.isFinite(aosMs) && aosMs <= nowMs;
    const headline = inProgress
      ? `IN PROGRESS · ${formatDuration(losMs - nowMs)} remaining`
      : `in ${formatDuration(aosMs - nowMs)}`;

    body = (
      <div className="flex flex-col gap-3">
        <div>
          <div
            className="font-display text-xl font-bold leading-tight"
            style={{ color: inProgress ? "#FFB800" : "#00FF41" }}
          >
            {headline}
          </div>
          <div className="mt-0.5 font-mono text-[0.65rem] text-text-secondary">
            AOS {formatUtcTime(new Date(aosMs))} UTC · LOS {formatUtcTime(new Date(losMs))} UTC
          </div>
        </div>

        {/* 2 + 1 layout: the AOS → LOS value ("S 200° → NE 59°", 15 mono
            chars) gets a full-width row so it is never ellipsised in the
            1/3-width right column on laptop widths. */}
        <div className="grid grid-cols-2 gap-2">
          <DataCell
            label="Max el"
            value={`${Math.round(next.maxElevationDeg)}°`}
            testId="iss-pass-max-el"
          />
          <DataCell label="Duration" value={formatDuration(next.durationSeconds * 1000)} />
          <DataCell
            className="col-span-2"
            label="AOS → LOS"
            value={`${azimuthLabel(next.aosAzimuthDeg)} → ${azimuthLabel(next.losAzimuthDeg)}`}
          />
        </div>

        {following.length > 0 && (
          <div>
            <CardTitle>FOLLOWING PASSES</CardTitle>
            <ul className="mt-1 flex flex-col gap-1">
              {following.map((p) => {
                const a = Date.parse(p.aos);
                return (
                  <li
                    key={p.aos}
                    className="flex flex-wrap items-baseline justify-between gap-x-3 font-mono text-[0.65rem] text-text-secondary"
                  >
                    <span className="text-text-primary">
                      {formatUtcTime(new Date(a))} UTC
                    </span>
                    <span>
                      max {Math.round(p.maxElevationDeg)}° · {formatDuration(p.durationSeconds * 1000)} ·{" "}
                      {compassPoint(p.aosAzimuthDeg)}→{compassPoint(p.losAzimuthDeg)} · in{" "}
                      {formatDuration(a - nowMs)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="rounded-md border border-glass bg-white/5 p-3"
      data-testid="iss-next-pass"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <CardTitle>NEXT PASS — {JSC_SITE.shortName}</CardTitle>
        <span className="font-mono text-[0.6rem] text-text-muted">
          {formatLatitude(JSC_SITE.latitudeDeg)} {formatLongitude(JSC_SITE.longitudeDeg)}
        </span>
      </div>
      {body}
      <p className="mt-3 font-mono text-[0.6rem] leading-relaxed text-text-muted">
        Geometric pass ≥ {PASS_MIN_ELEVATION_DEG}° elevation. Visibility (sunlit ISS over a
        dark site) not evaluated.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------
   Conjunction status (public CDMs)
   ------------------------------------------------------------ */

function tcaCountdown(tcaMs: number | null, nowMs: number | null): string {
  if (tcaMs === null || nowMs === null) return "TCA n/a";
  const diff = tcaMs - nowMs;
  if (diff <= 0) return "TCA passed";
  return `TCA in ${formatDuration(diff)}`;
}

function CdmRow({
  assessment,
  nowMs,
}: {
  assessment: IssCdmAssessment;
  nowMs: number | null;
}) {
  const { cdm, level, pc, missKm, otherName, otherId } = assessment;
  const tcaMs = parseUtcTimestamp(cdm.TCA);
  return (
    <li className="rounded-md border border-glass bg-white/5 p-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-mono text-xs text-text-primary">{otherName}</div>
          <div className="font-mono text-[0.6rem] text-text-muted">NORAD {otherId}</div>
        </div>
        <LevelBadge level={level} />
      </div>
      <div className="mt-1.5 grid grid-cols-3 gap-2 font-mono text-[0.65rem]">
        <div>
          <div className="uppercase tracking-widest text-text-muted">TCA</div>
          <div className="text-text-primary">{tcaCountdown(tcaMs, nowMs)}</div>
          <div className="text-text-secondary">
            {tcaMs !== null ? `${formatUtc(new Date(tcaMs))} UTC` : "—"}
          </div>
        </div>
        <div>
          <div className="uppercase tracking-widest text-text-muted">Miss</div>
          <div className="text-text-primary">
            {missKm !== null ? `${missKm.toFixed(3)} km` : "n/a"}
          </div>
        </div>
        <div>
          <div className="uppercase tracking-widest text-text-muted">Pc</div>
          <div className="text-text-primary">{formatPc(pc)}</div>
        </div>
      </div>
    </li>
  );
}

function CaStatusCard({
  status,
  nowMs,
}: {
  status: IssStatus;
  nowMs: number | null;
}) {
  const assessments = useMemo<IssCdmAssessment[]>(
    () => sortCdmsByTca(status.cdms).map(assessIssCdm),
    [status]
  );

  const cdmError = status.errors.cdms;
  const overall = worstIssCaLevel(assessments.map((a) => a.level));

  let body: React.ReactNode;
  if (typeof cdmError === "string") {
    body = (
      <div className="rounded-md border border-caution/40 bg-caution/10 px-3 py-2 font-mono text-xs text-caution">
        CDM feed unavailable: {cdmError}
      </div>
    );
  } else if (assessments.length === 0) {
    body = (
      <div className="flex items-center gap-3">
        <LevelBadge level="GREEN" label="NOMINAL" />
        <span className="font-mono text-xs text-text-secondary">
          No ISS conjunction data messages in the public feed.
        </span>
      </div>
    );
  } else {
    body = (
      <ul className="flex flex-col gap-2">
        {assessments.map((a) => (
          <CdmRow
            key={`${a.cdm.CDM_ID}|${a.otherId}|${a.cdm.TCA}|${a.cdm.MIN_RNG}|${a.cdm.PC}`}
            assessment={a}
            nowMs={nowMs}
          />
        ))}
      </ul>
    );
  }

  return (
    <div
      className="rounded-md border border-glass bg-white/5 p-3"
      data-testid="iss-ca-status"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <CardTitle>CONJUNCTION STATUS — PUBLIC CDMs</CardTitle>
        {!cdmError && assessments.length > 0 && <LevelBadge level={overall} />}
      </div>
      {body}
      <p className="mt-3 font-mono text-[0.6rem] leading-relaxed text-text-muted">
        NASA ISS CA thresholds · RED Pc ≥ {formatPcThreshold(ISS_PC_RED_THRESHOLD)} (DAM/PDAM
        planning) · YELLOW Pc ≥ {formatPcThreshold(ISS_PC_YELLOW_THRESHOLD)} · screening box ±
        {ISS_KEEP_OUT_BOX_KM.radial} km R × ±{ISS_KEEP_OUT_BOX_KM.inTrack} km I × ±
        {ISS_KEEP_OUT_BOX_KM.crossTrack} km C
      </p>
      <p className="mt-1 font-mono text-[0.6rem] leading-relaxed text-text-muted">
        Source: Space-Track cdm_public · the {ISS_CDM_SCAN_LIMIT} soonest-TCA public messages
        are screened for NORAD {ISS_NORAD_ID} each refresh — an ISS CDM with a later TCA can
        lie outside that window.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------
   Main component
   ------------------------------------------------------------ */

interface LiveState {
  latitudeDeg: number;
  longitudeDeg: number;
  altitudeKm: number;
  speedKmS: number;
}

export default function IssConsole() {
  const [status, setStatus] = useState<IssStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(REFRESH_SECONDS);
  /** Wall clock, initialised in an effect (never during render). */
  const [nowMs, setNowMs] = useState<number | null>(null);
  const [passes, setPasses] = useState<PassPrediction[] | null>(null);

  /* ---- Fetch /api/iss (two-timer pattern, with cancellation) ---- */
  const fetchStatus = useCallback(async (isCancelled: () => boolean) => {
    try {
      const res = await fetch("/api/iss");
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        // non-JSON body — handled by the !res.ok / shape checks below
      }
      if (isCancelled()) return;
      if (!res.ok) {
        const d = (data && typeof data === "object" ? data : {}) as {
          error?: unknown;
          detail?: unknown;
        };
        const msg =
          typeof d.error === "string" ? d.error : `Request failed (HTTP ${res.status}).`;
        const detail = typeof d.detail === "string" ? ` ${d.detail}` : "";
        throw new Error(`${msg}${detail}`);
      }
      if (!isIssStatus(data)) {
        throw new Error("Unexpected /api/iss response shape.");
      }
      setStatus(data);
      setError(null);
    } catch (err) {
      if (isCancelled()) return;
      setError(err instanceof Error ? err.message : "Failed to load ISS status.");
    } finally {
      if (!isCancelled()) {
        setLoading(false);
        setCountdown(REFRESH_SECONDS);
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const isCancelled = (): boolean => cancelled;

    fetchStatus(isCancelled);
    const fetchTimer = setInterval(
      () => fetchStatus(isCancelled),
      REFRESH_SECONDS * 1000
    );
    const tickTimer = setInterval(
      () => setCountdown((c) => (c <= 1 ? REFRESH_SECONDS : c - 1)),
      1000
    );

    return () => {
      cancelled = true;
      clearInterval(fetchTimer);
      clearInterval(tickTimer);
    };
  }, [fetchStatus]);

  /* ---- 1 Hz wall clock ---- */
  useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), LIVE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  /* ---- Element set → SatRec (once per TLE) ---- */
  const tle: SpaceTrackTLE | null = status?.tle ?? null;
  const satrec = useMemo<SatRec | null>(
    () => (tle ? parseTle(tle.TLE_LINE1, tle.TLE_LINE2) : null),
    [tle]
  );
  const elements = useMemo<TleElements | null>(
    () => (tle && satrec ? tleElements(tle, satrec) : null),
    [tle, satrec]
  );

  /* ---- 1 Hz state vector ---- */
  const live = useMemo<LiveState | null>(() => {
    if (!satrec || nowMs === null) return null;
    const date = new Date(nowMs);
    const sv = propagateAt(satrec, date);
    if (!sv) return null;
    const gd = geodeticFromEci(sv.position, date);
    const v = speedKmS(sv.velocity);
    if (
      !Number.isFinite(gd.latitudeDeg) ||
      !Number.isFinite(gd.longitudeDeg) ||
      !Number.isFinite(gd.altitudeKm) ||
      !Number.isFinite(v)
    ) {
      return null;
    }
    return {
      latitudeDeg: gd.latitudeDeg,
      longitudeDeg: gd.longitudeDeg,
      altitudeKm: gd.altitudeKm,
      speedKmS: v,
    };
  }, [satrec, nowMs]);

  /* ---- Ground track: centred on the live clock so the past/future
          split (and the dashed-green start) always sits under the 1 Hz
          marker. 93 SGP4 steps per tick ≈ 1 ms. ---- */
  const track = useMemo<GroundTrackPoint[]>(
    () => (satrec && nowMs !== null ? groundTrack(satrec, new Date(nowMs)) : []),
    [satrec, nowMs]
  );

  /* ---- JSC passes: on load, then every 60 s ---- */
  useEffect(() => {
    if (!satrec) {
      setPasses(null);
      return;
    }
    let cancelled = false;
    const compute = (): void => {
      const nextPasses = predictPasses(satrec, JSC_SITE, new Date(), PASS_WINDOW_HOURS);
      if (cancelled) return;
      setPasses(nextPasses);
    };
    compute();
    const id = setInterval(compute, PASS_RECOMPUTE_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [satrec]);

  /* ---- Derived display strings (all NaN-guarded) ---- */
  const objectName =
    tle && typeof tle.OBJECT_NAME === "string" && tle.OBJECT_NAME.trim().length > 0
      ? tle.OBJECT_NAME.trim()
      : ISS_DISPLAY_NAME;

  const ageHours =
    elements && nowMs !== null ? tleAgeHours(elements.epoch, nowMs) : null;
  const ageLabel =
    ageHours === null
      ? "—"
      : Math.abs(ageHours) >= 48
        ? formatDuration(ageHours * 3_600_000)
        : `${ageHours.toFixed(1)} h`;
  const ageStale = ageHours !== null && ageHours > TLE_AGE_CAUTION_HOURS;

  const tleUnavailable = status !== null && tle === null;
  const tleUnparseable = tle !== null && satrec === null;

  return (
    <section className="glass-card overflow-hidden" data-testid="iss-console">
      {/* Header — the same 36 px row as the other consoles on normal
          widths; on narrow phones the right-hand group wraps under the
          title (min-h + flex-wrap) instead of hiding the NORAD label. */}
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-0.5 border-b border-glass px-3 py-1">
        <h2 className="font-mono text-[0.7rem] font-semibold uppercase tracking-widest text-text-secondary">
          ISS TOPO CONSOLE
        </h2>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-4 gap-y-0.5 font-mono text-[0.65rem] text-text-muted">
          <span className="whitespace-nowrap">
            NORAD {ISS_NORAD_ID} · {objectName}
          </span>
          <span className="whitespace-nowrap">
            refresh in <span className="text-safe">{countdown}s</span>
          </span>
        </div>
      </div>

      <div className="p-4">
        {/* ---- States ---- */}
        {loading && !status && (
          <div className="font-mono text-xs text-text-secondary blink-cursor">
            Acquiring ISS state vector
          </div>
        )}

        {error && (
          <div className="mb-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
            {error}
          </div>
        )}

        {status && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {/* ---- LEFT: ground track + state vector ---- */}
            <div className="flex flex-col gap-3 lg:col-span-2">
              {tleUnavailable && (
                <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
                  ISS element set unavailable from Space-Track
                  {status.errors.tle ? ` — ${status.errors.tle}` : ""}
                </div>
              )}
              {tleUnparseable && (
                <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
                  ISS element set could not be initialised for SGP4 (malformed TLE lines).
                </div>
              )}

              {satrec && (
                <>
                  <div className="overflow-hidden rounded-md border border-glass bg-white/5 p-2">
                    <GroundTrackMap
                      track={track}
                      issLatDeg={live ? live.latitudeDeg : null}
                      issLonDeg={live ? live.longitudeDeg : null}
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                    <DataCell
                      label="Lat"
                      value={live ? formatLatitude(live.latitudeDeg) : "—"}
                      testId="iss-lat"
                    />
                    <DataCell
                      label="Lon"
                      value={live ? formatLongitude(live.longitudeDeg) : "—"}
                      testId="iss-lon"
                    />
                    <DataCell
                      label="Alt"
                      value={live ? `${live.altitudeKm.toFixed(1)} km` : "—"}
                      testId="iss-alt"
                    />
                    <DataCell
                      label="Vel"
                      value={live ? `${live.speedKmS.toFixed(3)} km/s` : "—"}
                    />
                    <DataCell
                      label="Period"
                      value={
                        elements && Number.isFinite(elements.periodMinutes)
                          ? `${elements.periodMinutes.toFixed(2)} min`
                          : "—"
                      }
                    />
                    <DataCell
                      label="Incl"
                      value={
                        elements && Number.isFinite(elements.inclinationDeg)
                          ? `${elements.inclinationDeg.toFixed(2)}°`
                          : "—"
                      }
                    />
                  </div>

                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 font-mono text-[0.6rem] text-text-muted">
                    <span style={ageStale ? { color: "#FFB800" } : undefined}>
                      TLE epoch age: {ageLabel}
                      {elements ? ` · epoch ${formatUtc(elements.epoch)} UTC` : ""}
                    </span>
                    <span>
                      SGP4 on the public Space-Track element set · TEME → geodetic (WGS-72) ·
                      positional error ~1 km, growing with epoch age
                    </span>
                  </div>
                </>
              )}
            </div>

            {/* ---- RIGHT: next pass + conjunction status ---- */}
            <div className="flex flex-col gap-4">
              <NextPassCard
                passes={passes}
                nowMs={nowMs}
                elementSetReady={satrec !== null}
              />
              <CaStatusCard status={status} nowMs={nowMs} />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
