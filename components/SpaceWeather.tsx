"use client";

import { useCallback, useEffect, useState } from "react";
import {
  F107_ELEVATED_MAX,
  F107_LOW_MAX,
  F107_MODERATE_MAX,
  G_SCALE_DESCRIPTION,
  KP_STORM_THRESHOLD,
  REGIME_EXPLANATION,
  f107BaseRegime,
  formatTimeTagUtc,
  type DragRegime,
  type GeomagneticScale,
  type SpaceWeatherStatus,
} from "@/lib/spaceweather";
import { decayEstimate, tleElements } from "@/lib/orbital";
import { getDebrisSample } from "@/lib/debrisClient";

/* ============================================================
   Session 5 — Feature 6: Space Weather & Reentry Watch

   Two independent halves in one glass panel:

   TOP — NOAA SWPC space weather (GET /api/spaceweather, polled
   every 15 min to match the route's cache, with a live MM:SS
   countdown in the header):
     (1) Planetary Kp — value, 9-segment bar, NOAA G-scale badge
     (2) F10.7 solar radio flux — value in sfu + regime word
     (3) Atmospheric drag regime — heuristic badge + one-sentence
         operational meaning, with the thresholds printed on screen
     Per-feed failures appear as small amber notes; the rest of the
     block still renders. A total failure (503) shows the standard
     error box.

   BOTTOM — Reentry Watch: from the shared 2,000-object Space-Track
   sample (lib/debrisClient, one request shared with the other
   Session-5 panels) compute tleElements + decayEstimate for every
   object, keep 0 < perigee < 300 km with a positive decay rate
   (a non-positive perigee is a corrupt element set — SGP4 only
   rejects a TLE whose EPOCH position is below the surface), sort
   by estimated lifetime, show the 8 soonest. The lifetime is a
   FIRST-ORDER figure from the TLE mean-motion derivative at the
   current rate — real decay accelerates, so actual lifetimes are
   SHORTER; the footnote says so. An object whose mean altitude is
   already ≤ 120 km gets lifetime 0 from decayEstimate and is shown
   as "< 0.1 d" rather than a misleading "0.0 d". Context only, not
   a reentry prediction product.

   Spec label strings ("PLANETARY Kp", "REENTRY WATCH — …", …) are
   written LITERALLY in uppercase so textContent matches them
   case-sensitively; the Label's CSS `uppercase` is kept for style
   parity with FleetDashboard but no longer does the work.

   Assumptions shown on screen: Kp/F10.7 thresholds, that the drag
   regime is heuristic (no NRLMSISE-00 / JB2008 evaluation), and
   the first-order nature of the decay estimate.
   ============================================================ */

const REFRESH_SECONDS = 15 * 60; // 15 minutes — matches /api/spaceweather cache
const PERIGEE_WATCH_KM = 300;
const REENTRY_ROWS = 8;
const LIFETIME_IMMINENT_DAYS = 30;
const LIFETIME_WATCH_DAYS = 180;

const REGIME_COLORS: Record<DragRegime, string> = {
  LOW: "#00FF41",
  MODERATE: "#FFB800",
  ELEVATED: "#FF8A2B",
  HIGH: "#FF3131",
  UNKNOWN: "#888888",
};

const G_SCALE_COLORS: Record<GeomagneticScale, string> = {
  G0: "#888888",
  G1: "#FFB800",
  G2: "#FFB800",
  G3: "#FF3131",
  G4: "#FF3131",
  G5: "#FF3131",
};

const VALID_G_SCALES: ReadonlySet<string> = new Set<GeomagneticScale>([
  "G0",
  "G1",
  "G2",
  "G3",
  "G4",
  "G5",
]);
const VALID_REGIMES: ReadonlySet<string> = new Set<DragRegime>([
  "LOW",
  "MODERATE",
  "ELEVATED",
  "HIGH",
  "UNKNOWN",
]);

function safeGScale(v: unknown): GeomagneticScale | null {
  return typeof v === "string" && VALID_G_SCALES.has(v)
    ? (v as GeomagneticScale)
    : null;
}

function safeRegime(v: unknown): DragRegime {
  return typeof v === "string" && VALID_REGIMES.has(v)
    ? (v as DragRegime)
    : "UNKNOWN";
}

function safeReading(v: unknown): { value: number; timeTag: string } | null {
  if (!v || typeof v !== "object") return null;
  const o = v as { value?: unknown; timeTag?: unknown };
  if (typeof o.value !== "number" || !Number.isFinite(o.value)) return null;
  return { value: o.value, timeTag: typeof o.timeTag === "string" ? o.timeTag : "" };
}

function safeErrors(v: unknown): { kp?: string; f107?: string } {
  if (!v || typeof v !== "object") return {};
  const o = v as { kp?: unknown; f107?: unknown };
  const out: { kp?: string; f107?: string } = {};
  if (typeof o.kp === "string" && o.kp.length > 0) out.kp = o.kp;
  if (typeof o.f107 === "string" && o.f107.length > 0) out.f107 = o.f107;
  return out;
}

/** Kp bar segment colour by segment index (1-based). */
function kpSegmentColor(segment: number): string {
  if (segment <= 4) return "#00FF41";
  if (segment <= 6) return "#FFB800";
  return "#FF3131";
}

/* ------------------------------------------------------------
   Formatting guards — never render NaN / undefined / "null"
   ------------------------------------------------------------ */

function fmtFixed(v: number | null | undefined, dp: number, suffix = ""): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return `${v.toFixed(dp)}${suffix}`;
}

function fmtInt(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return Math.round(v).toLocaleString();
}

function fmtExp(v: number | null | undefined, dp: number): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return v.toExponential(dp);
}

function fmtLifetimeDays(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  // decayEstimate returns 0 when the mean altitude is already at or
  // below the 120 km reentry altitude; anything that would print as
  // "0.0 d" at 1 dp is shown as a bound instead.
  if (v < 0.05) return "< 0.1 d";
  if (v < 1000) return `${v.toFixed(1)} d`;
  return `${Math.round(v).toLocaleString()} d`;
}

function fmtCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? `0${r}` : r}`;
}

function fmtIsoUtc(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return formatTimeTagUtc(d.toISOString());
}

/* ------------------------------------------------------------
   Reentry watch computation (pure; runs once per sample)
   ------------------------------------------------------------ */

interface ReentryRow {
  noradId: string;
  name: string;
  perigeeKm: number;
  apogeeKm: number;
  decayKmPerDay: number;
  lifetimeDays: number | null;
  bstar: number;
}

function computeReentryRows(
  objects: ReadonlyArray<{
    TLE_LINE1: string;
    TLE_LINE2: string;
    NORAD_CAT_ID?: string;
    OBJECT_NAME?: string;
    PERIAPSIS?: string;
  }>
): ReentryRow[] {
  const rows: ReentryRow[] = [];
  for (const obj of objects) {
    // Cheap prefilter on the gp PERIAPSIS string (same quantity to
    // within a few km of model difference) so SGP4 initialisation
    // runs only for objects near the watch band, not all 2,000.
    const periStr = parseFloat(obj.PERIAPSIS ?? "");
    if (Number.isFinite(periStr) && periStr >= PERIGEE_WATCH_KM + 25) continue;
    const el = tleElements(obj);
    if (!el) continue;
    // perigee ≤ 0 km is a corrupt element set (sub-surface perigee with
    // an above-surface epoch position still parses) — never list it.
    if (
      !Number.isFinite(el.perigeeKm) ||
      el.perigeeKm <= 0 ||
      el.perigeeKm >= PERIGEE_WATCH_KM
    ) {
      continue;
    }
    const decay = decayEstimate(el);
    if (!Number.isFinite(decay.decayKmPerDay) || decay.decayKmPerDay <= 0) {
      continue;
    }
    rows.push({
      noradId: el.noradId,
      name: el.name,
      perigeeKm: el.perigeeKm,
      apogeeKm: el.apogeeKm,
      decayKmPerDay: decay.decayKmPerDay,
      lifetimeDays:
        decay.estimatedLifetimeDays !== null &&
        Number.isFinite(decay.estimatedLifetimeDays)
          ? decay.estimatedLifetimeDays
          : null,
      bstar: el.bstar,
    });
  }

  rows.sort((a, b) => {
    if (a.lifetimeDays === null && b.lifetimeDays === null) {
      return a.perigeeKm - b.perigeeKm;
    }
    if (a.lifetimeDays === null) return 1;
    if (b.lifetimeDays === null) return -1;
    if (a.lifetimeDays !== b.lifetimeDays) return a.lifetimeDays - b.lifetimeDays;
    return a.perigeeKm - b.perigeeKm;
  });

  return rows.slice(0, REENTRY_ROWS);
}

/* ------------------------------------------------------------
   Sub-components
   ------------------------------------------------------------ */

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
      {children}
    </div>
  );
}

function Badge({
  color,
  pulse,
  testId,
  children,
}: {
  color: string;
  pulse?: boolean;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      data-testid={testId}
      className={`inline-block shrink-0 rounded px-2 py-0.5 font-display text-[0.6rem] font-bold ${
        pulse ? "animate-pulse-alert" : ""
      }`}
      style={{ color, border: `1px solid ${color}` }}
    >
      {children}
    </span>
  );
}

function FeedNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2 rounded border border-caution/40 bg-caution/10 px-2 py-1 font-mono text-[0.6rem] leading-snug text-caution">
      {children}
    </div>
  );
}

function KpBar({ kp }: { kp: number | null }) {
  const filled =
    kp !== null && Number.isFinite(kp)
      ? Math.max(0, Math.min(9, Math.round(kp)))
      : 0;
  const segments = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  return (
    <div
      className="mt-2 flex gap-0.5"
      data-testid="kp-bar"
      aria-label={`Kp bar, ${filled} of 9 segments`}
    >
      {segments.map((seg) => {
        const on = seg <= filled;
        return (
          <div
            key={seg}
            className="h-2 flex-1 rounded-sm"
            style={{
              backgroundColor: on ? kpSegmentColor(seg) : "rgba(255,255,255,0.05)",
            }}
          />
        );
      })}
    </div>
  );
}

function KpCard({ status }: { status: SpaceWeatherStatus }) {
  const kp = status.kp;
  const kpValue = kp ? kp.value : null;
  const gScale = status.gScale;
  // Big number: muted when missing, neutral when quiet (G0), storm colour otherwise.
  const valueColor =
    kpValue === null
      ? "#888888"
      : gScale && gScale !== "G0"
        ? G_SCALE_COLORS[gScale]
        : "#E0E0E0";
  return (
    <div className="rounded-md border border-glass bg-white/5 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <Label>
            PLANETARY <span className="normal-case">Kp</span>
          </Label>
          <div className="font-mono text-[0.6rem] text-text-muted">
            NOAA estimated · 3-hour index
          </div>
        </div>
        {gScale && (
          <Badge color={G_SCALE_COLORS[gScale]} testId="g-scale">
            {gScale} · {G_SCALE_DESCRIPTION[gScale]}
          </Badge>
        )}
      </div>
      <div
        className="mt-1 font-display text-2xl font-bold leading-tight"
        style={{ color: valueColor }}
        data-testid="kp-value"
      >
        {fmtFixed(kpValue, 2)}
      </div>
      <KpBar kp={kpValue} />
      <div className="mt-1 flex justify-between font-mono text-[0.6rem] text-text-muted">
        <span>0</span>
        <span>quiet ≤ 4 · storm ≥ {KP_STORM_THRESHOLD}</span>
        <span>9</span>
      </div>
      <div className="mt-2 font-mono text-[0.6rem] text-text-secondary">
        {kp ? formatTimeTagUtc(kp.timeTag) : "No Kp reading"}
      </div>
      {status.errors.kp && <FeedNote>Kp feed: {status.errors.kp}</FeedNote>}
    </div>
  );
}

function F107Card({ status }: { status: SpaceWeatherStatus }) {
  const f107 = status.f107;
  const value = f107 ? f107.value : null;
  const regime = value !== null ? f107BaseRegime(value) : null;
  const color = regime ? REGIME_COLORS[regime] : "#888888";
  return (
    <div className="rounded-md border border-glass bg-white/5 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <Label>F10.7 SOLAR FLUX</Label>
          <div className="font-mono text-[0.6rem] text-text-muted">
            10.7 cm radio flux · EUV proxy
          </div>
        </div>
        {regime && (
          <Badge color={color} testId="f107-regime">
            {regime}
          </Badge>
        )}
      </div>
      <div
        className="mt-1 font-display text-2xl font-bold leading-tight"
        style={{ color: value === null ? "#888888" : "#E0E0E0" }}
        data-testid="f107-value"
      >
        {fmtFixed(value, 1, " sfu")}
      </div>
      <div className="mt-2 font-mono text-[0.6rem] leading-snug text-text-muted">
        &lt;{F107_LOW_MAX} LOW · &lt;{F107_MODERATE_MAX} MODERATE · &lt;
        {F107_ELEVATED_MAX} ELEVATED · ≥{F107_ELEVATED_MAX} HIGH
      </div>
      <div className="mt-2 font-mono text-[0.6rem] text-text-secondary">
        {f107 ? formatTimeTagUtc(f107.timeTag) : "No F10.7 reading"}
      </div>
      {status.errors.f107 && (
        <FeedNote>F10.7 feed: {status.errors.f107}</FeedNote>
      )}
    </div>
  );
}

function DragRegimeCard({ status }: { status: SpaceWeatherStatus }) {
  const regime = status.dragRegime;
  const color = REGIME_COLORS[regime];
  const kpStorm =
    status.kp !== null &&
    Number.isFinite(status.kp.value) &&
    status.kp.value >= KP_STORM_THRESHOLD;
  return (
    <div
      className={`rounded-md border bg-white/5 p-3 ${
        regime === "HIGH" ? "animate-pulse-alert" : ""
      }`}
      style={{
        borderColor: regime === "HIGH" ? "#FF3131" : "rgba(255,255,255,0.08)",
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <Label>ATMOSPHERIC DRAG REGIME</Label>
          <div className="font-mono text-[0.6rem] text-text-muted">
            LEO thermospheric density · heuristic
          </div>
        </div>
        <Badge color={color} testId="drag-regime">
          {regime}
        </Badge>
      </div>
      <p className="mt-2 font-mono text-[0.65rem] leading-relaxed text-text-secondary">
        {REGIME_EXPLANATION[regime]}
      </p>
      <div className="mt-2 font-mono text-[0.6rem] leading-snug text-text-muted">
        {regime === "UNKNOWN" ? (
          // Both indices missing: no base regime was applied, so do not
          // claim one (the route normally 503s here; this guards a
          // malformed 200 payload).
          "No base regime — both indices unavailable"
        ) : (
          <>
            Base from F10.7 thresholds
            {status.f107 === null ? " (F10.7 missing → MODERATE base)" : ""}
            {kpStorm ? ` · bumped one level: Kp ≥ ${KP_STORM_THRESHOLD}` : ""}
          </>
        )}
        . Indicator only — no NRLMSISE-00 / JB2008 density evaluation.
      </div>
    </div>
  );
}

function LifetimeCell({ days }: { days: number | null }) {
  if (days === null || !Number.isFinite(days)) {
    return <span className="text-text-muted">—</span>;
  }
  if (days < LIFETIME_IMMINENT_DAYS) {
    return (
      <span className="inline-flex items-center gap-2">
        <Badge color="#FF3131" pulse>
          IMMINENT
        </Badge>
        <span style={{ color: "#FF3131" }}>{fmtLifetimeDays(days)}</span>
      </span>
    );
  }
  if (days < LIFETIME_WATCH_DAYS) {
    return <span style={{ color: "#FFB800" }}>{fmtLifetimeDays(days)}</span>;
  }
  return <span className="text-text-secondary">{fmtLifetimeDays(days)}</span>;
}

/* ------------------------------------------------------------
   Panel
   ------------------------------------------------------------ */

type FetchOutcome =
  | { ok: true; data: SpaceWeatherStatus }
  | { ok: false; error: string };

export default function SpaceWeather() {
  // --- Space weather half ---
  const [status, setStatus] = useState<SpaceWeatherStatus | null>(null);
  const [swLoading, setSwLoading] = useState(true);
  const [swError, setSwError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(REFRESH_SECONDS);

  // --- Reentry watch half ---
  const [reentryRows, setReentryRows] = useState<ReentryRow[] | null>(null);
  const [sampleSize, setSampleSize] = useState<number | null>(null);
  const [reLoading, setReLoading] = useState(true);
  const [reError, setReError] = useState<string | null>(null);

  /** Pure fetcher — returns an outcome instead of touching state, so the
   *  effect can drop results that arrive after unmount. */
  const fetchStatus = useCallback(async (): Promise<FetchOutcome> => {
    try {
      const res = await fetch("/api/spaceweather", { cache: "no-store" });
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        // handled below via !res.ok / shape check
      }
      if (!res.ok) {
        const msg =
          data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
            ? (data as { error: string }).error
            : `Request failed (HTTP ${res.status}).`;
        return { ok: false, error: msg };
      }
      if (!data || typeof data !== "object") {
        return { ok: false, error: "Malformed space-weather response." };
      }
      // Validate every field — never trust wire values to index colour maps
      // or to be renderable React children.
      const s = data as Record<string, unknown>;
      const safe: SpaceWeatherStatus = {
        fetchedAt: typeof s.fetchedAt === "string" ? s.fetchedAt : "",
        kp: safeReading(s.kp),
        f107: safeReading(s.f107),
        gScale: safeGScale(s.gScale),
        dragRegime: safeRegime(s.dragRegime),
        errors: safeErrors(s.errors),
      };
      return { ok: true, data: safe };
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error ? err.message : "Failed to load space weather.",
      };
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      const outcome = await fetchStatus();
      if (cancelled) return;
      if (outcome.ok) {
        setStatus(outcome.data);
        setSwError(null);
      } else {
        setSwError(outcome.error);
      }
      setSwLoading(false);
      setCountdown(REFRESH_SECONDS);
    };

    load();
    const fetchTimer = setInterval(load, REFRESH_SECONDS * 1000);
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

  useEffect(() => {
    let cancelled = false;

    getDebrisSample()
      .then((sample) => {
        if (cancelled) return;
        const rows = computeReentryRows(sample.objects);
        setSampleSize(sample.objects.length);
        setReentryRows(rows);
        setReError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setReError(
          err instanceof Error ? err.message : "Failed to load debris sample."
        );
      })
      .finally(() => {
        if (cancelled) return;
        setReLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="glass-card overflow-hidden" data-testid="space-weather">
      {/* Header */}
      <div className="flex h-9 items-center justify-between border-b border-glass px-3">
        <h2 className="font-mono text-[0.7rem] font-semibold uppercase tracking-widest text-text-secondary">
          SPACE WEATHER &amp; REENTRY WATCH
        </h2>
        <div className="font-mono text-[0.65rem] text-text-muted">
          NOAA SWPC · refresh in{" "}
          <span className="text-safe" data-testid="sw-countdown">
            {fmtCountdown(countdown)}
          </span>
        </div>
      </div>

      <div className="p-4">
        {/* ---------------- Space weather ---------------- */}
        {swLoading && !status && (
          <div className="font-mono text-xs text-text-secondary blink-cursor">
            Querying NOAA SWPC planetary Kp and F10.7
          </div>
        )}

        {swError && (
          <div className="mb-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
            {swError}
          </div>
        )}

        {status && (
          <div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <KpCard status={status} />
              <F107Card status={status} />
              <DragRegimeCard status={status} />
            </div>
            <div className="mt-2 font-mono text-[0.6rem] text-text-muted">
              Source: NOAA Space Weather Prediction Center · fetched{" "}
              {fmtIsoUtc(status.fetchedAt)} · server cache{" "}
              {/* mirrors /api/spaceweather: 15 min when both feeds parsed,
                  2 min while one feed is down so the amber note clears soon */}
              {status.errors.kp || status.errors.f107 ? "2" : "15"} min
            </div>
          </div>
        )}

        {/* ---------------- Reentry watch ---------------- */}
        <div className="mt-5" data-testid="reentry-watch">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <Label>REENTRY WATCH — LOWEST-PERIGEE OBJECTS IN SAMPLE</Label>
            {sampleSize !== null && (
              <span className="font-mono text-[0.6rem] text-text-muted">
                perigee &lt; {PERIGEE_WATCH_KM} km · {sampleSize.toLocaleString()}{" "}
                objects screened
              </span>
            )}
          </div>

          {reLoading && reentryRows === null && !reError && (
            <div className="font-mono text-xs text-text-secondary blink-cursor">
              Computing drag-based decay for the tracked sample
            </div>
          )}

          {reError && (
            <div className="mb-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
              {reError}
            </div>
          )}

          {reentryRows !== null && reentryRows.length === 0 && (
            <div className="font-mono text-xs text-text-muted">
              No objects with perigee below {PERIGEE_WATCH_KM} km in the current
              sample.
            </div>
          )}

          {reentryRows !== null && reentryRows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse font-mono text-xs">
                <thead>
                  <tr className="border-b border-glass text-left">
                    <th className="pb-1.5 pr-3 font-normal">
                      <Label>OBJECT</Label>
                    </th>
                    <th className="pb-1.5 pr-3 font-normal">
                      <Label>PERIGEE × APOGEE</Label>
                    </th>
                    <th className="pb-1.5 pr-3 font-normal">
                      <Label>DECAY</Label>
                    </th>
                    <th className="pb-1.5 pr-3 font-normal">
                      <Label>EST. LIFETIME</Label>
                    </th>
                    <th className="pb-1.5 font-normal">
                      <Label>B*</Label>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {reentryRows.map((row, i) => (
                    <tr
                      key={`${row.noradId}-${i}`}
                      data-testid="reentry-row"
                      className="border-b border-glass last:border-b-0"
                    >
                      <td className="py-1.5 pr-3 align-top">
                        <span className="text-text-primary">{row.name}</span>{" "}
                        <span className="text-text-muted">
                          {row.noradId ? `· ${row.noradId}` : ""}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3 align-top text-text-secondary">
                        {fmtInt(row.perigeeKm)} × {fmtInt(row.apogeeKm)} km
                      </td>
                      <td className="py-1.5 pr-3 align-top text-text-secondary">
                        {fmtInt(row.decayKmPerDay * 1000)} m/day
                      </td>
                      <td className="py-1.5 pr-3 align-top">
                        <LifetimeCell days={row.lifetimeDays} />
                      </td>
                      <td className="py-1.5 align-top text-text-secondary">
                        {fmtExp(row.bstar, 2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="mt-3 font-mono text-[0.6rem] leading-relaxed text-text-muted">
            First-order estimate from the TLE mean-motion derivative at the
            current drag rate; real decay accelerates, so actual lifetimes are
            shorter. Context only — not a reentry prediction product.
          </p>
        </div>
      </div>
    </section>
  );
}
