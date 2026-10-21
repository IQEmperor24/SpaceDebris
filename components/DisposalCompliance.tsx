"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SpaceTrackTLE } from "@/lib/spacetrack";
import { timedFetch } from "@/lib/telemetry";
import {
  REENTRY_ALTITUDE_KM,
  decayEstimate,
  meanAltitudeKm,
  tleElements,
} from "@/lib/orbital";
import {
  ACTIVITY_FACTOR,
  BALLISTIC_PRESETS,
  BC_MAX_M2_PER_KG,
  BC_MIN_M2_PER_KG,
  FCC_DISPOSAL_YEARS,
  LEGACY_DISPOSAL_YEARS,
  LIFETIME_CAP_YEARS,
  SOLAR_ACTIVITY_LEVELS,
  STARLINK_SHELL_BAND_KM,
  activityFromF107,
  circularDecayRateKmPerDay,
  estimateLifetime,
  fccFiveYearCheck,
  formatLifetime,
  formatReentryMonth,
  impliedBallisticCoefficient,
  inStarlinkShellBand,
  legacy25YearCheck,
  lifetimeLadder,
} from "@/lib/lifetime";
import type { LadderRow, LifetimeResult, SolarActivity } from "@/lib/lifetime";

/* ============================================================
   Session 6 — Feature 4: Orbital Lifetime & FCC 5-Year Disposal
   Compliance

   Why: Starlink's ~550 km design altitude exists because natural
   drag clears a dead satellite in a few years, and the FCC's
   2022 rule requires LEO post-mission disposal within 5 years
   (the legacy IADC / NASA guideline was 25). This panel
   integrates a first-principles drag-decay model (lib/lifetime.ts)
   and grades the result against both rules.

   Data flow
   - Start state defaults to a REFERENCE altitude of 550 km (no
     network cost). "ESTIMATE" → timedFetch("/api/debris?search=")
     → { object: SpaceTrackTLE | null } → start altitude =
     meanAltitudeKm (gp APOAPSIS/PERIAPSIS), inclination shown.
     The request runs in a useEffect keyed by a request nonce, with
     a cancelled flag, so a slow response can never overwrite a
     newer one. /api/debris caches searches for 10 min server-side.
   - Default solar activity: one timedFetch("/api/spaceweather") on
     mount → F10.7 → activityFromF107 (unless the user already
     picked a level); MEAN when the feed is unavailable.
   - estimateLifetime + lifetimeLadder run client-side in useMemo
     (≈ 1-15 ms total; the cost is shown on screen).
   - Cross-check (object mode): TLE ṅ → observed decay rate
     (lib/orbital decayEstimate) vs the model rate, and the B that
     would reproduce the observation (impliedBallisticCoefficient).
   Cadence: no polling. Zero Claude cost; one Space-Track request
   per ESTIMATE (cached), one NOAA-backed request per page load.

   ASSUMPTIONS (printed in the footnote)
   - Static exponential atmosphere (Vallado Table 8-4, mean
     activity) × a crude constant solar-activity factor
     (LOW 0.5 / MEAN 1 / HIGH 2.5); no solar-cycle variation.
   - Circular orbit at the MEAN altitude; eccentric orbits decay
     faster (perigee drag). Constant B = Cd·A/m (no attitude
     changes). Ballistic presets are public / order-of-magnitude
     estimates.
   - Natural decay only — the object is assumed passive from now
     on (no station-keeping, no deorbit burn). Julian years.
   - Order-of-magnitude tool — not a reentry prediction.
   ============================================================ */

const DEFAULT_QUERY = "ISS";
const MAX_QUERY_LENGTH = 64;
/** Starlink Gen1 shell-1 design altitude (public FCC filing). */
const REFERENCE_ALT_KM = 550;
/** SpaceX's public natural-decay figure for a failed satellite at 550 km. */
const PUBLIC_550KM_DECAY_YEARS = 5;
const DEFAULT_PRESET_ID = "starlink";
/** Apogee − perigee above this → flag the circular-orbit assumption. */
const ECCENTRIC_FLAG_KM = 50;
const DAYS_PER_JULIAN_YEAR = 365.25;
const MS_PER_JULIAN_YEAR = DAYS_PER_JULIAN_YEAR * 86_400_000;

/* Palette */
const SAFE = "#00FF41";
const CAUTION = "#FFB800";
const DANGER = "#FF3131";
const DATA_HUE = "#5FB3FF";
const TEXT_SECONDARY = "#888888";
const GRID_COLOR = "rgba(255,255,255,0.06)";
const AXIS_COLOR = "rgba(255,255,255,0.14)";
const MUTED_MARKER = "rgba(255,255,255,0.35)";

/* Chart geometry (viewBox units) */
/* Chart geometry. The viewBox width tracks the rendered width (ResizeObserver),
   so 1 viewBox unit = 1 CSS px and axis text stays 10 px on a 390 px phone
   and on a 1440 px desktop alike. */
const CHART_DEFAULT_W = 600;
const CHART_MIN_W = 260;
const CHART_MAX_W = 1400;
const CHART_H_NARROW = 210;
const CHART_H_WIDE = 340;
const CHART_NARROW_BELOW = 520;
const MARGIN = { left: 42, right: 12, top: 18, bottom: 30 } as const;
const Y_FLOOR_KM = 100;
const FONT_AXIS = 10;
const FONT_ANNOTATION = 9;
/** Below this many years the x-axis switches to days. */
const DAYS_AXIS_BELOW_YEARS = 0.25;

const BUTTON_ACTIVE = "border-safe/60 bg-safe/15 text-safe";
const BUTTON_INACTIVE =
  "border-glass bg-white/5 text-text-secondary hover:text-text-primary";

/* ------------------------------------------------------------
   Types + guards
   ------------------------------------------------------------ */

type StartState =
  | { kind: "reference"; altKm: number }
  | {
      kind: "object";
      altKm: number;
      name: string;
      noradId: string;
      inclinationDeg: number | null;
      apogeeKm: number | null;
      perigeeKm: number | null;
      epochDate: string | null;
      /** km/day, positive = shrinking; null when the TLE lines do not parse. */
      observedDecayKmPerDay: number | null;
    };

type SpaceWeatherState = "loading" | "live" | "unavailable";

function isTleLike(v: unknown): v is SpaceTrackTLE {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.APOAPSIS === "string" &&
    typeof o.PERIAPSIS === "string" &&
    typeof o.NORAD_CAT_ID === "string"
  );
}

function finiteOrNull(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** Build the object start state, or an error string. */
function startFromTle(tle: SpaceTrackTLE): StartState | string {
  const alt = meanAltitudeKm(tle);
  if (!Number.isFinite(alt)) {
    return "Element set has no valid APOAPSIS / PERIAPSIS — cannot derive an altitude.";
  }
  const name =
    typeof tle.OBJECT_NAME === "string" && tle.OBJECT_NAME.trim().length > 0
      ? tle.OBJECT_NAME.trim()
      : `NORAD ${tle.NORAD_CAT_ID}`;
  const epochDate =
    typeof tle.EPOCH === "string" && /^\d{4}-\d{2}-\d{2}/.test(tle.EPOCH)
      ? tle.EPOCH.slice(0, 10)
      : null;

  let observedDecayKmPerDay: number | null = null;
  if (typeof tle.TLE_LINE1 === "string" && typeof tle.TLE_LINE2 === "string") {
    const el = tleElements(tle);
    if (el) {
      const d = decayEstimate(el).decayKmPerDay;
      observedDecayKmPerDay = Number.isFinite(d) ? d : null;
    }
  }

  return {
    kind: "object",
    altKm: alt,
    name,
    noradId: tle.NORAD_CAT_ID,
    inclinationDeg: finiteOrNull(tle.INCLINATION),
    apogeeKm: finiteOrNull(tle.APOAPSIS),
    perigeeKm: finiteOrNull(tle.PERIAPSIS),
    epochDate,
    observedDecayKmPerDay,
  };
}

/** F10.7 value from a /api/spaceweather body, or null. */
function readF107(data: unknown): number | null {
  if (!data || typeof data !== "object") return null;
  const f = (data as { f107?: unknown }).f107;
  if (!f || typeof f !== "object") return null;
  const v = (f as { value?: unknown }).value;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/* ------------------------------------------------------------
   Formatting
   ------------------------------------------------------------ */

/**
 * Custom-B text → number (NaN when empty / invalid). Accepts a decimal
 * comma ("0,04"): inputMode="decimal" keypads on comma locales emit one.
 */
function parseDecimal(text: string): number {
  const t = text.trim().replace(",", ".");
  return t.length > 0 ? Number(t) : Number.NaN;
}

function fmtKm(km: number, dp = 1): string {
  return Number.isFinite(km) ? `${km.toFixed(dp)} km` : "—";
}

/** Decay rate: m/day below 1 km/day, else km/day. */
function fmtDecay(kmPerDay: number): string {
  if (!Number.isFinite(kmPerDay)) return "—";
  if (Math.abs(kmPerDay) < 1) return `${(kmPerDay * 1000).toFixed(1)} m/day`;
  return `${kmPerDay.toFixed(2)} km/day`;
}

function fmtB(b: number): string {
  if (!Number.isFinite(b)) return "—";
  if (b >= 0.01) return b.toFixed(3);
  return b.toPrecision(2);
}

/** Calendar month (UTC) `years` after nowMs, or "—". */
function monthAfter(nowMs: number, years: number): string {
  const ms = nowMs + years * MS_PER_JULIAN_YEAR;
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return "—";
  return formatReentryMonth(new Date(ms).toISOString());
}

/** 1-2-5 nice step for `span` split into ~`count` intervals. */
function niceStep(span: number, count: number): number {
  if (!(span > 0) || !Number.isFinite(span)) return 1;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

function decimalsFor(step: number): number {
  if (!(step > 0) || step >= 1) return 0;
  return Math.min(6, Math.ceil(-Math.log10(step) - 1e-9));
}

function px(v: number): number {
  return Math.round(v * 100) / 100;
}

/* ------------------------------------------------------------
   Small presentational pieces
   ------------------------------------------------------------ */

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
      {children}
    </div>
  );
}

function RuleBadge({
  pass,
  large,
  testId,
}: {
  pass: boolean;
  large?: boolean;
  testId?: string;
}) {
  const color = pass ? SAFE : DANGER;
  return (
    <span
      data-testid={testId}
      data-pass={pass ? "true" : "false"}
      className={`inline-block rounded font-display font-bold ${
        large ? "px-2 py-0.5 text-lg leading-tight" : "px-1.5 py-0.5 text-[0.6rem]"
      }`}
      style={{ color, border: `1px solid ${color}` }}
    >
      {pass ? "PASS" : "FAIL"}
    </span>
  );
}

function StatCard({
  label,
  sub,
  children,
}: {
  label: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-glass bg-white/5 p-3">
      <Label>{label}</Label>
      <div className="mt-1">{children}</div>
      {sub && (
        <div className="mt-1 font-mono text-[0.6rem] leading-snug text-text-secondary">
          {sub}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------
   Decay curve (SVG + HTML tooltip)
   ------------------------------------------------------------ */

function DecayCurve({ result, nowMs }: { result: LifetimeResult; nowMs: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [boxW, setBoxW] = useState(CHART_DEFAULT_W);

  // Track the rendered width so the viewBox maps 1:1 to CSS pixels.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = (): void => {
      const w = el.clientWidth;
      if (w > 0) setBoxW(Math.round(w));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const VB_W = Math.max(CHART_MIN_W, Math.min(CHART_MAX_W, boxW));
  const VB_H = VB_W < CHART_NARROW_BELOW ? CHART_H_NARROW : CHART_H_WIDE;
  const PLOT_W = VB_W - MARGIN.left - MARGIN.right;
  const PLOT_H = VB_H - MARGIN.top - MARGIN.bottom;
  const PLOT_RIGHT = MARGIN.left + PLOT_W;
  const BASELINE_Y = MARGIN.top + PLOT_H;

  const curve = result.curve;
  const last = curve.length > 0 ? curve[curve.length - 1] : null;
  const endYears =
    result.lifetimeYears !== null ? result.lifetimeYears : last ? last.years : 0;

  // Unit: days for very short lifetimes, years otherwise.
  const useDays = endYears > 0 && endYears < DAYS_AXIS_BELOW_YEARS;
  const unitScale = useDays ? DAYS_PER_JULIAN_YEAR : 1;
  const unitLabel = useDays ? "d" : "y";
  const endUnits = endYears * unitScale;
  // Stretch the time axis to show a disposal-rule marker when the
  // lifetime is within 5× of it (e.g. 2.9 y → axis to 6 y so the FCC
  // 5-year line is visible), without squashing much shorter curves.
  let domainEnd = endUnits;
  if (!useDays && !result.capped) {
    for (const m of [FCC_DISPOSAL_YEARS, LEGACY_DISPOSAL_YEARS]) {
      if (endYears >= m / 5 && endYears < m) domainEnd = Math.max(domainEnd, m * 1.08);
    }
  }
  const xStep = niceStep(domainEnd, 5);
  const xMax = domainEnd > 0 ? Math.max(xStep, Math.ceil(domainEnd / xStep - 1e-9) * xStep) : 1;
  const xDecimals = decimalsFor(xStep);

  const startAlt = result.startAltitudeKm;
  const ySpanRaw = Math.max(50, startAlt - Y_FLOOR_KM);
  const yStep = niceStep(ySpanRaw, 4);
  const yMax = Math.max(Y_FLOOR_KM + yStep, Math.ceil(startAlt / yStep - 1e-9) * yStep);
  const yMin = Y_FLOOR_KM;

  const xOf = useCallback(
    (units: number): number => {
      if (!Number.isFinite(units)) return MARGIN.left;
      const x = MARGIN.left + (units / xMax) * PLOT_W;
      return Math.max(MARGIN.left, Math.min(PLOT_RIGHT, x));
    },
    [xMax, PLOT_W, PLOT_RIGHT]
  );
  const yOf = (altKm: number): number => {
    if (!Number.isFinite(altKm)) return BASELINE_Y;
    const y = BASELINE_Y - ((altKm - yMin) / (yMax - yMin)) * PLOT_H;
    return Math.max(MARGIN.top, Math.min(BASELINE_Y, y));
  };

  // Pinned (touch) tooltip clears on an outside tap.
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

  // Reset the hover index whenever the curve changes.
  useEffect(() => {
    setHover(null);
  }, [result]);

  const pickIndex = useCallback(
    (clientX: number): number | null => {
      const svg = svgRef.current;
      if (!svg || curve.length === 0) return null;
      const rect = svg.getBoundingClientRect();
      if (!(rect.width > 0)) return null;
      const vbX = ((clientX - rect.left) / rect.width) * VB_W;
      const units = ((vbX - MARGIN.left) / PLOT_W) * xMax;
      // Binary search on the (strictly increasing) curve time.
      let lo = 0;
      let hi = curve.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (curve[mid].years * unitScale < units) lo = mid;
        else hi = mid;
      }
      const dLo = Math.abs(curve[lo].years * unitScale - units);
      const dHi = Math.abs(curve[hi].years * unitScale - units);
      return dHi < dLo ? hi : lo;
    },
    [curve, unitScale, xMax, VB_W, PLOT_W]
  );

  const points = curve
    .map((p) => `${px(xOf(p.years * unitScale))},${px(yOf(p.altKm))}`)
    .join(" ");

  const xTicks: number[] = [];
  for (let k = 0; k * xStep <= xMax + 1e-9 && k < 20; k++) xTicks.push(k * xStep);
  const yTicks: number[] = [];
  for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax + 1e-9 && yTicks.length < 12; v += yStep) {
    if (v > yMin) yTicks.push(v);
  }

  const markers: Array<{ years: number; label: string; color: string; textColor: string; row: number }> = [];
  if (!useDays) {
    if (FCC_DISPOSAL_YEARS <= xMax) {
      markers.push({ years: FCC_DISPOSAL_YEARS, label: "FCC 5 y", color: CAUTION, textColor: CAUTION, row: 0 });
    }
    if (LEGACY_DISPOSAL_YEARS <= xMax) {
      markers.push({ years: LEGACY_DISPOSAL_YEARS, label: "25 y", color: MUTED_MARKER, textColor: TEXT_SECONDARY, row: 1 });
    }
  }
  const markersOffScale = markers.length < 2;

  const hovered = hover !== null && hover >= 0 && hover < curve.length ? curve[hover] : null;
  let tooltipStyle: React.CSSProperties | null = null;
  let hx = 0;
  let hy = 0;
  if (hovered) {
    hx = xOf(hovered.years * unitScale);
    hy = yOf(hovered.altKm);
    const nearLeft = hx < MARGIN.left + 60;
    const nearRight = hx > PLOT_RIGHT - 60;
    const tx = nearLeft ? "0%" : nearRight ? "-100%" : "-50%";
    const above = hy >= MARGIN.top + PLOT_H * 0.45;
    tooltipStyle = {
      left: `${(hx / VB_W) * 100}%`,
      top: `${(hy / VB_H) * 100}%`,
      transform: `translate(${tx}, ${above ? "calc(-100% - 8px)" : "8px"})`,
    };
  }

  const reentryY = yOf(REENTRY_ALTITUDE_KM);
  const ariaLabel = result.capped
    ? `Altitude stays above ${Math.round(REENTRY_ALTITUDE_KM)} km for the full ${LIFETIME_CAP_YEARS}-year integration from ${Math.round(startAlt)} km.`
    : `Altitude decays from ${Math.round(startAlt)} km to the ${Math.round(REENTRY_ALTITUDE_KM)} km reentry interface in ${formatLifetime(result.lifetimeYears)}.`;

  return (
    <div>
      <div
        ref={wrapRef}
        className="relative"
        onPointerLeave={(e) => {
          if (e.pointerType !== "touch") setHover(null);
        }}
        onPointerCancel={() => setHover(null)}
      >
        <svg
          ref={svgRef}
          data-testid="lifetime-curve"
          className="block h-auto w-full font-mono"
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          role="img"
          aria-label={ariaLabel}
          onPointerMove={(e) => {
            const i = pickIndex(e.clientX);
            if (i !== null) setHover(i);
          }}
          onPointerDown={(e) => {
            const i = pickIndex(e.clientX);
            if (i !== null) setHover(i);
          }}
        >
          <title>{ariaLabel}</title>

          {/* Gridlines + y tick labels */}
          {yTicks.map((v) => {
            const y = px(yOf(v));
            return (
              <g key={`y-${v}`}>
                <line
                  x1={MARGIN.left}
                  x2={PLOT_RIGHT}
                  y1={y}
                  y2={y}
                  stroke={GRID_COLOR}
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
                <text
                  x={MARGIN.left - 4}
                  y={y}
                  fontSize={FONT_AXIS}
                  fill={TEXT_SECONDARY}
                  textAnchor="end"
                  dominantBaseline="middle"
                >
                  {Math.round(v).toLocaleString()}
                </text>
              </g>
            );
          })}
          {/* Baseline (100 km floor) + unit */}
          <line
            x1={MARGIN.left}
            x2={PLOT_RIGHT}
            y1={BASELINE_Y}
            y2={BASELINE_Y}
            stroke={AXIS_COLOR}
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
          <text
            x={MARGIN.left - 4}
            y={BASELINE_Y}
            fontSize={FONT_AXIS}
            fill={TEXT_SECONDARY}
            textAnchor="end"
            dominantBaseline="middle"
          >
            {Y_FLOOR_KM}
          </text>
          <text x={4} y={MARGIN.top - 6} fontSize={FONT_ANNOTATION} fill={TEXT_SECONDARY}>
            km
          </text>

          {/* x ticks */}
          {xTicks.map((v, k) => {
            const x = px(xOf(v));
            const atEnd = k === xTicks.length - 1 && k > 0;
            return (
              <g key={`x-${k}`}>
                <line
                  x1={x}
                  x2={x}
                  y1={BASELINE_Y}
                  y2={BASELINE_Y + 3}
                  stroke={AXIS_COLOR}
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
                <text
                  x={x}
                  y={BASELINE_Y + 16}
                  fontSize={FONT_AXIS}
                  fill={TEXT_SECONDARY}
                  textAnchor={atEnd ? "end" : k === 0 ? "start" : "middle"}
                >
                  {v.toFixed(xDecimals)}
                  {atEnd ? ` ${unitLabel}` : ""}
                </text>
              </g>
            );
          })}

          {/* 120 km reentry interface */}
          <line
            x1={MARGIN.left}
            x2={PLOT_RIGHT}
            y1={px(reentryY)}
            y2={px(reentryY)}
            stroke={DANGER}
            strokeWidth={1}
            strokeDasharray="4 3"
            opacity={0.7}
          />
          <text
            x={MARGIN.left + 4}
            y={px(reentryY) - 3}
            fontSize={FONT_ANNOTATION}
            fill={DANGER}
            textAnchor="start"
            letterSpacing="0.6"
          >
            REENTRY {Math.round(REENTRY_ALTITUDE_KM)} km
          </text>

          {/* 5-year / 25-year disposal markers */}
          {markers.map((m) => {
            const x = px(xOf(m.years));
            const flip = x > PLOT_RIGHT - 56;
            return (
              <g key={m.label}>
                <line
                  x1={x}
                  x2={x}
                  y1={MARGIN.top}
                  y2={BASELINE_Y}
                  stroke={m.color}
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  opacity={0.9}
                />
                <text
                  x={flip ? x - 3 : x + 3}
                  y={MARGIN.top + 10 + m.row * 13}
                  fontSize={FONT_ANNOTATION}
                  fill={m.textColor}
                  textAnchor={flip ? "end" : "start"}
                  letterSpacing="0.6"
                >
                  {m.label}
                </text>
              </g>
            );
          })}

          {/* The decay curve — single data hue */}
          {curve.length > 1 && (
            <polyline
              points={points}
              fill="none"
              stroke={DATA_HUE}
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}

          {/* Hover crosshair */}
          {hovered && (
            <g pointerEvents="none">
              <line
                x1={px(hx)}
                x2={px(hx)}
                y1={MARGIN.top}
                y2={BASELINE_Y}
                stroke="rgba(255,255,255,0.25)"
                strokeWidth={1}
              />
              <circle cx={px(hx)} cy={px(hy)} r={3} fill={DATA_HUE} />
            </g>
          )}
        </svg>

        {hovered && tooltipStyle && (
          <div
            data-testid="lifetime-curve-tooltip"
            className="pointer-events-none absolute z-10 whitespace-nowrap rounded border border-glass bg-space/95 px-2 py-1.5 font-mono text-[0.6rem] leading-snug shadow-lg"
            style={tooltipStyle}
          >
            <div className="text-xs font-bold text-text-primary">
              {fmtKm(hovered.altKm)}
            </div>
            <div className="text-text-secondary">
              T+
              {useDays
                ? `${(hovered.years * DAYS_PER_JULIAN_YEAR).toFixed(1)} d`
                : `${hovered.years.toFixed(2)} y`}
              {" · "}
              <span className="text-text-primary">{monthAfter(nowMs, hovered.years)}</span>
            </div>
          </div>
        )}
      </div>
      <div className="mt-1 flex flex-wrap justify-between gap-x-3 font-mono text-[0.6rem] text-text-muted">
        <span>
          Altitude vs time since now ({useDays ? "days" : "years"}) · circular-orbit decay
        </span>
        {markersOffScale && (
          <span>
            {useDays || FCC_DISPOSAL_YEARS > xMax
              ? "5-year and 25-year markers lie beyond the plotted span"
              : "25-year marker lies beyond the plotted span"}
          </span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------
   Lifetime ladder table
   ------------------------------------------------------------ */

function LadderTable({
  ladder,
  selectedAltKm,
  onPick,
  bc,
  activity,
}: {
  ladder: LadderRow[];
  selectedAltKm: number | null;
  onPick: (altKm: number) => void;
  bc: number;
  activity: SolarActivity;
}) {
  return (
    <div className="rounded-md border border-glass bg-white/5 p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-2">
        <Label>Lifetime ladder</Label>
        <span className="font-mono text-[0.6rem] text-text-muted">
          B {fmtB(bc)} m²/kg · {activity}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full font-mono text-[0.65rem]" data-testid="lifetime-ladder">
          <thead>
            <tr className="text-left text-text-muted">
              <th className="pb-1 pr-2 font-normal uppercase tracking-widest">Alt</th>
              <th className="pb-1 pr-2 font-normal uppercase tracking-widest">Lifetime</th>
              <th className="pb-1 pr-2 font-normal uppercase tracking-widest">FCC 5-y</th>
              <th className="pb-1 font-normal uppercase tracking-widest">25-y</th>
            </tr>
          </thead>
          <tbody>
            {ladder.map((row) => {
              const starlink = inStarlinkShellBand(row.altKm);
              const selected = selectedAltKm !== null && selectedAltKm === row.altKm;
              return (
                <tr
                  key={row.altKm}
                  data-testid={`lifetime-ladder-row-${row.altKm}`}
                  data-starlink={starlink ? "true" : "false"}
                  className={`border-t border-glass ${starlink ? "bg-white/[0.06]" : ""}`}
                >
                  <td className="py-1 pr-2">
                    <button
                      type="button"
                      onClick={() => onPick(row.altKm)}
                      title={`Plot the decay curve from ${row.altKm} km`}
                      className={`whitespace-nowrap rounded px-1 transition-colors ${
                        selected ? "text-safe" : "text-text-primary hover:text-safe"
                      }`}
                    >
                      {row.altKm} km
                    </button>
                    {starlink && (
                      <span className="ml-1 whitespace-nowrap rounded border border-glass px-1 text-[0.55rem] tracking-widest text-text-secondary">
                        STARLINK
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap py-1 pr-2 text-text-primary">
                    {formatLifetime(row.lifetimeYears)}
                  </td>
                  <td className="py-1 pr-2">
                    <RuleBadge pass={fccFiveYearCheck(row.lifetimeYears).pass} />
                  </td>
                  <td className="py-1">
                    <RuleBadge pass={legacy25YearCheck(row.lifetimeYears).pass} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 font-mono text-[0.6rem] leading-relaxed text-text-muted">
        Shaded rows fall inside the public Starlink shell band ({STARLINK_SHELL_BAND_KM.min}–
        {STARLINK_SHELL_BAND_KM.max} km). Click an altitude to plot it.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------
   Main component
   ------------------------------------------------------------ */

export default function DisposalCompliance() {
  /* ---- Start state ---- */
  const [start, setStart] = useState<StartState>({ kind: "reference", altKm: REFERENCE_ALT_KM });
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [searchReq, setSearchReq] = useState<{ q: string; n: number } | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  /* ---- Ballistic coefficient ---- */
  const [presetId, setPresetId] = useState<string | null>(DEFAULT_PRESET_ID);
  const [bcText, setBcText] = useState(() => {
    const p = BALLISTIC_PRESETS.find((x) => x.id === DEFAULT_PRESET_ID);
    return p ? String(p.bcM2PerKg) : "";
  });

  /* ---- Solar activity ---- */
  const [activity, setActivity] = useState<SolarActivity>("MEAN");
  const [f107, setF107] = useState<number | null>(null);
  const [swState, setSwState] = useState<SpaceWeatherState>("loading");
  /** State drives the render; the ref lets the one-shot fetch callback see it. */
  const [activityPicked, setActivityPicked] = useState(false);
  const userPickedActivity = useRef(false);

  /* ---- Clock (reentry dates anchor to "now"), set in an effect ---- */
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    setNowMs(Date.now());
  }, []);

  /* ---- Object lookup: /api/debris?search= ---- */
  const fetchObject = useCallback(async (q: string, isCancelled: () => boolean) => {
    setSearching(true);
    setSearchError(null);
    try {
      const res = await timedFetch(`/api/debris?search=${encodeURIComponent(q)}`);
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        // non-JSON body — handled below
      }
      if (isCancelled()) return;
      if (!res.ok) {
        const d = (data && typeof data === "object" ? data : {}) as {
          error?: unknown;
          detail?: unknown;
        };
        const msg = typeof d.error === "string" ? d.error : `Request failed (HTTP ${res.status}).`;
        const detail = typeof d.detail === "string" ? ` ${d.detail}` : "";
        throw new Error(`${msg}${detail}`);
      }
      const obj =
        data && typeof data === "object" ? (data as { object?: unknown }).object : undefined;
      if (obj === null) {
        throw new Error(`No Space-Track object matches "${q}".`);
      }
      if (!isTleLike(obj)) {
        throw new Error("Unexpected /api/debris response shape.");
      }
      const next = startFromTle(obj);
      if (typeof next === "string") throw new Error(next);
      setStart(next);
    } catch (err) {
      if (isCancelled()) return;
      setSearchError(err instanceof Error ? err.message : "Object lookup failed.");
    } finally {
      if (!isCancelled()) setSearching(false);
    }
  }, []);

  useEffect(() => {
    if (!searchReq) return;
    let cancelled = false;
    fetchObject(searchReq.q, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [searchReq, fetchObject]);

  /* ---- Live F10.7 → default activity (once) ---- */
  const fetchSpaceWeather = useCallback(async (isCancelled: () => boolean) => {
    try {
      const res = await timedFetch("/api/spaceweather");
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        // handled below
      }
      if (isCancelled()) return;
      const v = res.ok ? readF107(data) : null;
      if (v === null) {
        setSwState("unavailable");
        return;
      }
      setF107(v);
      setSwState("live");
      if (!userPickedActivity.current) setActivity(activityFromF107(v));
    } catch {
      if (!isCancelled()) setSwState("unavailable");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchSpaceWeather(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [fetchSpaceWeather]);

  /* ---- Validated B ---- */
  const bcNumber = parseDecimal(bcText);
  const bc =
    Number.isFinite(bcNumber) && bcNumber >= BC_MIN_M2_PER_KG && bcNumber <= BC_MAX_M2_PER_KG
      ? bcNumber
      : null;

  /* ---- Model ---- */
  const computed = useMemo(() => {
    if (bc === null || nowMs === null || !Number.isFinite(start.altKm)) return null;
    try {
      const t0 = performance.now();
      const result = estimateLifetime(start.altKm, bc, activity, new Date(nowMs));
      const ladder = lifetimeLadder(bc, activity);
      const ms = performance.now() - t0;
      return { result, ladder, ms };
    } catch {
      return null;
    }
  }, [bc, activity, nowMs, start.altKm]);

  /** Live sanity anchor: the Starlink-class preset at 550 km, all three activity levels. */
  const anchor = useMemo(() => {
    const preset = BALLISTIC_PRESETS.find((p) => p.id === DEFAULT_PRESET_ID);
    if (!preset) return [];
    const epoch = new Date(0);
    return SOLAR_ACTIVITY_LEVELS.map((lvl) => ({
      level: lvl,
      years: estimateLifetime(REFERENCE_ALT_KM, preset.bcM2PerKg, lvl, epoch).lifetimeYears,
    }));
  }, []);
  const anchorBracketsPublic = (() => {
    const finite = anchor.map((a) => a.years).filter((y): y is number => y !== null);
    if (finite.length === 0 || finite.length !== anchor.length) return false;
    return (
      Math.min(...finite) <= PUBLIC_550KM_DECAY_YEARS &&
      Math.max(...finite) >= PUBLIC_550KM_DECAY_YEARS
    );
  })();

  /* ---- Handlers ---- */
  const submitSearch = (): void => {
    const q = query.trim().slice(0, MAX_QUERY_LENGTH);
    if (!q) {
      setSearchError("Enter an object name or NORAD ID.");
      return;
    }
    setSearchReq((prev) => ({ q, n: (prev?.n ?? 0) + 1 }));
  };

  const pickPreset = (id: string): void => {
    const p = BALLISTIC_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setPresetId(id);
    setBcText(String(p.bcM2PerKg));
  };

  const onBcInput = (text: string): void => {
    setBcText(text);
    const n = parseDecimal(text); // NaN for empty text → no preset match
    const match = BALLISTIC_PRESETS.find((p) => p.bcM2PerKg === n);
    setPresetId(match ? match.id : null);
  };

  const pickActivity = (lvl: SolarActivity): void => {
    userPickedActivity.current = true;
    setActivityPicked(true);
    setActivity(lvl);
  };

  const pickLadderAltitude = (altKm: number): void => {
    // Cancel any in-flight lookup (its effect cleanup flips the cancelled
    // flag) so a slow response cannot overwrite this newer choice.
    setSearchReq(null);
    setSearching(false);
    setSearchError(null);
    setStart({ kind: "reference", altKm });
  };

  /* ---- Derived display ---- */
  const result = computed ? computed.result : null;
  const fcc = result ? fccFiveYearCheck(result.lifetimeYears) : null;
  const legacy = result ? legacy25YearCheck(result.lifetimeYears) : null;
  const activePreset = presetId ? BALLISTIC_PRESETS.find((p) => p.id === presetId) ?? null : null;

  const capYearLabel =
    nowMs !== null ? `after ${new Date(nowMs).getUTCFullYear() + LIFETIME_CAP_YEARS}` : "—";

  let swNote: string;
  if (swState === "loading") {
    swNote = "reading live F10.7…";
  } else if (swState === "live" && f107 !== null) {
    const suggested = activityFromF107(f107);
    swNote =
      activityPicked && suggested !== activity
        ? `live F10.7 = ${Math.round(f107)} suggests ${suggested} · manual override`
        : `from live F10.7 = ${Math.round(f107)}`;
  } else {
    swNote = "live F10.7 unavailable — default MEAN";
  }

  const modelDecayAtStart =
    bc !== null ? circularDecayRateKmPerDay(start.altKm, bc, ACTIVITY_FACTOR[activity]) : null;
  const observed = start.kind === "object" ? start.observedDecayKmPerDay : null;
  const impliedB =
    start.kind === "object" && observed !== null
      ? impliedBallisticCoefficient(start.altKm, observed, ACTIVITY_FACTOR[activity])
      : null;
  const impliedUsable =
    impliedB !== null && impliedB >= BC_MIN_M2_PER_KG && impliedB <= BC_MAX_M2_PER_KG;

  const eccentricSpread =
    start.kind === "object" && start.apogeeKm !== null && start.perigeeKm !== null
      ? start.apogeeKm - start.perigeeKm
      : null;

  return (
    <section className="glass-card overflow-hidden" data-testid="disposal-compliance">
      {/* Header — h-9 on normal widths; wraps on narrow phones. */}
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-0.5 border-b border-glass px-3 py-1">
        <h2 className="font-mono text-[0.7rem] font-semibold uppercase tracking-widest text-text-secondary">
          ORBITAL LIFETIME &amp; DISPOSAL COMPLIANCE
        </h2>
        <span className="ml-auto whitespace-nowrap font-mono text-[0.65rem] text-text-muted">
          FCC 5-year rule · IADC 25-year guideline
        </span>
      </div>

      <div className="flex flex-col gap-4 p-4">
        {/* ---- Controls ---- */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Object search */}
          <div>
            <Label>Object (name or NORAD ID)</Label>
            <form
              className="mt-1 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                submitSearch();
              }}
            >
              <input
                type="text"
                value={query}
                maxLength={MAX_QUERY_LENGTH}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Satellite name or NORAD ID…"
                aria-label="Object name or NORAD ID"
                data-testid="lifetime-target"
                className="min-w-0 flex-1 rounded-md border border-glass bg-white/5 px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-muted focus:border-safe focus:outline-none"
              />
              <button
                type="submit"
                disabled={searching}
                data-testid="lifetime-run"
                className="rounded-md border border-safe/40 bg-safe/10 px-4 py-2 font-mono text-sm font-semibold text-safe transition-colors hover:bg-safe/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {searching ? "…" : "ESTIMATE"}
              </button>
            </form>
            <div className="mt-1 font-mono text-[0.6rem] text-text-muted">
              Uses the object&apos;s live gp mean altitude (Space-Track).
            </div>
          </div>

          {/* Ballistic coefficient */}
          <div>
            <Label>Ballistic coefficient B = Cd·A/m</Label>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {BALLISTIC_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  data-testid={`lifetime-bc-${p.id}`}
                  aria-pressed={presetId === p.id}
                  title={p.note}
                  onClick={() => pickPreset(p.id)}
                  className={`rounded border px-2 py-1 font-mono text-[0.65rem] tracking-wide transition-colors ${
                    presetId === p.id ? BUTTON_ACTIVE : BUTTON_INACTIVE
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[0.65rem] text-text-secondary">
              <label htmlFor="lifetime-bc-input" className="text-text-muted">
                custom B
              </label>
              <input
                id="lifetime-bc-input"
                type="text"
                inputMode="decimal"
                value={bcText}
                onChange={(e) => onBcInput(e.target.value)}
                data-testid="lifetime-bc-input"
                className={`w-20 rounded border bg-white/5 px-2 py-1 font-mono text-[0.7rem] text-text-primary focus:outline-none ${
                  bc === null ? "border-danger/60" : "border-glass focus:border-safe"
                }`}
              />
              <span>m²/kg</span>
              {activePreset && <span className="text-text-muted">{activePreset.note}</span>}
            </div>
          </div>

          {/* Solar activity */}
          <div>
            <Label>Solar activity (density ×)</Label>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {SOLAR_ACTIVITY_LEVELS.map((lvl) => (
                <button
                  key={lvl}
                  type="button"
                  data-testid={`lifetime-activity-${lvl}`}
                  aria-pressed={activity === lvl}
                  onClick={() => pickActivity(lvl)}
                  className={`rounded border px-2 py-1 font-mono text-[0.65rem] tracking-wide transition-colors ${
                    activity === lvl ? BUTTON_ACTIVE : BUTTON_INACTIVE
                  }`}
                >
                  {lvl} ×{ACTIVITY_FACTOR[lvl]}
                </button>
              ))}
            </div>
            <div
              className="mt-1.5 font-mono text-[0.6rem] text-text-muted"
              data-testid="lifetime-activity-source"
            >
              {swNote}
            </div>
          </div>
        </div>

        {/* ---- Start state ---- */}
        <div
          className="rounded-md border border-glass bg-white/5 px-3 py-2 font-mono text-[0.65rem] leading-relaxed text-text-secondary"
          data-testid="lifetime-object"
          data-source={start.kind}
        >
          {start.kind === "reference" ? (
            <span>
              <span className="text-text-muted">START · </span>
              <span className="text-text-primary">REFERENCE {fmtKm(start.altKm, 0)}</span>
              {start.altKm === REFERENCE_ALT_KM ? " (Starlink Gen1 design altitude)" : ""} · no
              object loaded — ESTIMATE an object to use its live mean altitude.
            </span>
          ) : (
            <span>
              <span className="text-text-muted">START · </span>
              <span className="text-text-primary">{start.name}</span> · NORAD {start.noradId} ·
              mean alt <span className="text-text-primary">{fmtKm(start.altKm)}</span>
              {start.inclinationDeg !== null && <> · incl {start.inclinationDeg.toFixed(2)}°</>}
              {start.apogeeKm !== null && start.perigeeKm !== null && (
                <>
                  {" "}
                  · apo / peri {Math.round(start.apogeeKm).toLocaleString()} /{" "}
                  {Math.round(start.perigeeKm).toLocaleString()} km
                </>
              )}
              {start.epochDate && <> · epoch {start.epochDate}</>}
            </span>
          )}
          {eccentricSpread !== null && eccentricSpread > ECCENTRIC_FLAG_KM && (
            <div className="mt-1" style={{ color: CAUTION }}>
              Eccentric orbit (apo − peri ≈ {Math.round(eccentricSpread).toLocaleString()} km): the
              circular model uses the mean altitude — perigee drag makes the real lifetime shorter.
            </div>
          )}
          {start.altKm > 2000 && (
            <div className="mt-1 text-text-muted">
              Above LEO: drag is negligible at this altitude, so the integration runs to the{" "}
              {LIFETIME_CAP_YEARS}-year cap.
            </div>
          )}
          {start.altKm <= REENTRY_ALTITUDE_KM && (
            <div className="mt-1" style={{ color: DANGER }}>
              Mean altitude is at or below the {REENTRY_ALTITUDE_KM} km reentry interface.
            </div>
          )}
        </div>

        {/* ---- States ---- */}
        {searching && (
          <div className="font-mono text-xs text-text-secondary blink-cursor">
            Querying Space-Track element set
          </div>
        )}
        {searchError && (
          <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
            {searchError}
          </div>
        )}
        {bc === null && (
          <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
            B must be a number between {BC_MIN_M2_PER_KG} and {BC_MAX_M2_PER_KG} m²/kg.
          </div>
        )}
        {bc !== null && !computed && nowMs !== null && (
          <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
            Lifetime model could not run for this start state.
          </div>
        )}

        {/* ---- Results ---- */}
        {computed && result && fcc && legacy && nowMs !== null && (
          <>
            <div
              className="grid grid-cols-2 gap-3 md:grid-cols-4"
              data-testid="lifetime-result"
              data-capped={result.capped ? "true" : "false"}
            >
              <StatCard
                label="Lifetime"
                sub={`natural decay to ${REENTRY_ALTITUDE_KM} km`}
              >
                <div
                  className="font-display text-2xl font-bold leading-tight text-text-primary"
                  data-testid="lifetime-years"
                >
                  {formatLifetime(result.lifetimeYears)}
                </div>
              </StatCard>
              <StatCard label="Predicted reentry" sub="UTC year-month · order of magnitude">
                <div
                  className="font-display text-2xl font-bold leading-tight text-text-primary"
                  data-testid="lifetime-reentry"
                >
                  {result.capped ? capYearLabel : formatReentryMonth(result.reentryDate)}
                </div>
              </StatCard>
              <StatCard label="FCC 5-year" sub={fcc.rule}>
                <RuleBadge pass={fcc.pass} large testId="lifetime-fcc" />
              </StatCard>
              <StatCard label="25-year" sub={legacy.rule}>
                <RuleBadge pass={legacy.pass} large testId="lifetime-legacy" />
              </StatCard>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="rounded-md border border-glass bg-white/5 p-3 lg:col-span-2">
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
                  <Label>Decay curve</Label>
                  <span className="font-mono text-[0.6rem] text-text-muted">
                    from {fmtKm(result.startAltitudeKm)} · B {fmtB(result.bcM2PerKg)} m²/kg ·{" "}
                    {result.activity}
                  </span>
                </div>
                {result.curve.length > 1 ? (
                  <DecayCurve result={result} nowMs={nowMs} />
                ) : (
                  <div className="font-mono text-xs text-text-secondary">
                    No decay curve — the start altitude is already at the reentry interface.
                  </div>
                )}
              </div>

              <LadderTable
                ladder={computed.ladder}
                selectedAltKm={start.kind === "reference" ? start.altKm : null}
                onPick={pickLadderAltitude}
                bc={result.bcM2PerKg}
                activity={result.activity}
              />
            </div>

            {/* Cross-check against the observed TLE decay (object mode) */}
            {start.kind === "object" && (
              <div
                className="rounded-md border border-glass bg-white/5 p-3"
                data-testid="lifetime-crosscheck"
              >
                <Label>Cross-check — model vs observed decay</Label>
                <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div>
                    <div className="font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
                      Observed (TLE ṅ)
                    </div>
                    <div className="mt-0.5 font-mono text-sm text-text-primary">
                      {observed === null
                        ? "—"
                        : observed > 0
                          ? fmtDecay(observed)
                          : "not decaying"}
                    </div>
                    <div className="font-mono text-[0.6rem] text-text-muted">
                      {observed === null
                        ? "TLE lines did not parse"
                        : observed > 0
                          ? "first-order, from the mean-motion derivative"
                          : "ṅ ≤ 0 — thrusting, reboost or fit noise"}
                    </div>
                  </div>
                  <div>
                    <div className="font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
                      Model at start
                    </div>
                    <div className="mt-0.5 font-mono text-sm text-text-primary">
                      {modelDecayAtStart !== null ? fmtDecay(modelDecayAtStart) : "—"}
                    </div>
                    <div className="font-mono text-[0.6rem] text-text-muted">
                      B {fmtB(result.bcM2PerKg)} · {result.activity} atmosphere
                    </div>
                  </div>
                  <div>
                    <div className="font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
                      Implied B
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-sm text-text-primary">
                      <span data-testid="lifetime-implied-b">
                        {impliedB !== null ? `${fmtB(impliedB)} m²/kg` : "—"}
                      </span>
                      {impliedB !== null && impliedUsable && (
                        <button
                          type="button"
                          data-testid="lifetime-use-implied"
                          onClick={() => onBcInput(fmtB(impliedB))}
                          className={`rounded border px-2 py-1 font-mono text-[0.65rem] tracking-wide transition-colors ${BUTTON_INACTIVE}`}
                        >
                          USE
                        </button>
                      )}
                    </div>
                    <div className="font-mono text-[0.6rem] text-text-muted">
                      {impliedB === null
                        ? "needs a positive observed decay"
                        : impliedUsable
                          ? "B that reproduces the observed rate"
                          : `outside ${BC_MIN_M2_PER_KG}–${BC_MAX_M2_PER_KG} m²/kg — not usable`}
                    </div>
                  </div>
                </div>
                <p className="mt-2 font-mono text-[0.6rem] leading-relaxed text-text-muted">
                  The TLE ṅ term is a fit parameter: noisy, and meaningless for station-kept or
                  recently maneuvered satellites (Starlink&apos;s continuous station-keeping; ISS
                  element sets fitted across or just after a reboost). Implied B is only as good as
                  the assumed atmosphere.
                </p>
              </div>
            )}

            <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 font-mono text-[0.6rem] text-text-muted">
              <span data-testid="lifetime-anchor">
                Model check · Starlink-class B at {REFERENCE_ALT_KM} km:{" "}
                {anchor.map((a, i) => (
                  <span key={a.level}>
                    {i > 0 ? " · " : ""}
                    {a.level} {formatLifetime(a.years)}
                  </span>
                ))}
                {anchorBracketsPublic && (
                  <> — brackets SpaceX&apos;s public ~{PUBLIC_550KM_DECAY_YEARS}-year figure</>
                )}
              </span>
              <span>
                RK4 · {result.steps.toLocaleString()} adaptive steps · curve + 12-altitude ladder in{" "}
                {computed.ms.toFixed(1)} ms
              </span>
            </div>
          </>
        )}

        {/* ---- Footnote (assumptions) ---- */}
        <p className="font-mono text-[0.6rem] leading-relaxed text-text-muted">
          Static exponential atmosphere (Vallado Table 8-4, mean activity) scaled by a crude
          solar-activity factor; circular-orbit decay; no solar-cycle variation, no attitude
          changes. Order-of-magnitude tool consistent with the ~5-year natural decay at 550 km —
          not a reentry prediction.
        </p>
        <p className="font-mono text-[0.6rem] leading-relaxed text-text-muted">
          da/dt = −√(μa)·ρ·B with B = Cd·A/m, integrated with RK4 (≤ 0.2 % altitude change per
          step) to {REENTRY_ALTITUDE_KM} km or a {LIFETIME_CAP_YEARS}-year cap. Activity factors
          LOW ×{ACTIVITY_FACTOR.LOW} / MEAN ×{ACTIVITY_FACTOR.MEAN} / HIGH ×{ACTIVITY_FACTOR.HIGH}{" "}
          on density are a crude envelope: real density varies by an order of magnitude or more
          over a solar cycle, increasingly so with altitude. Natural decay only — the object is
          assumed passive from now on (no station-keeping or deorbit burn); eccentric orbits are
          treated at their mean altitude. Ballistic presets are public / order-of-magnitude
          estimates. PASS means natural decay alone meets the rule.
        </p>
      </div>
    </section>
  );
}
