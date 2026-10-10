"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { SpaceTrackTLE } from "@/lib/spacetrack";
import { DEBRIS_SAMPLE_LIMIT, getDebrisSample } from "@/lib/debrisClient";
import {
  buildAltitudeHistogram,
  buildInclinationHistogram,
  DENSITY_ALT_BIN_KM,
  DENSITY_ALT_MAX_KM,
  DENSITY_ALT_MIN_KM,
  DENSITY_INC_BIN_DEG,
  DENSITY_INC_MAX_DEG,
  DENSITY_INC_MIN_DEG,
  KESSLER_BAND_KM,
  type HistogramBin,
} from "@/lib/density";

/* ============================================================
   Session 5 — Feature 5: Orbital Density Profile

   ORDEM-style altitude + inclination histograms of the LIVE
   Space-Track sample (the same 2,000 most-recently-updated gp
   rows the 3D map draws), split by coarse object class.

   Data flow
   - getDebrisSample() (lib/debrisClient.ts) → one shared
     /api/debris?limit=2000 round trip per page load, cached
     client-side for 10 min (mirrors the route's server cache).
   - buildAltitudeHistogram / buildInclinationHistogram
     (lib/density.ts, pure) run in useMemo on the sample.
   - No Anthropic call, no polling of its own: a ~10-minute
     setInterval (client-cache TTL + a short grace) re-reads the
     shared sample so this panel stays aligned with the client
     cache; the density picture itself only changes on the order
     of days.

   Chart rules (project data-viz standard)
   - One y-axis per chart; a single sequential hue (#5FB3FF at
     0.85 opacity, hovered bar at 1.0) carries magnitude.
   - Status colours (#00FF41 / #FFB800 / #FF3131) are reserved
     for annotations (ISS, Kessler shell, sun-synchronous band).
   - All text in text tokens — SVG axis / tick text in #888888
     (secondary), HTML text via the Tailwind text-* tokens —
     never in the bar colour; recessive solid hairline grid.
   - Thin bars anchored to the baseline with a 2 px surface
     gap and a rounded data-end (square at the baseline via a
     clipPath). Every bin has an invisible full-height hit rect
     so the hover target is far bigger than the bar.
   - Single series → no legend; the chart title names it.
   - Tooltip is an HTML div positioned over the SVG (relative
     wrapper), showing bin range, total and class split. Mouse /
     pen: follows hover. Touch: a tap pins it (same bar toggles
     off, another bar switches, a tap outside or a scroll clears)
     because browsers fire pointerleave the instant a finger lifts.

   Assumptions shown on screen (never overclaim to JSC)
   - Altitude = (APOAPSIS + PERIAPSIS) / 2 from gp strings.
   - Object class is a NAME heuristic (" DEB", "R/B") — estimate.
   - This is a SAMPLE of ~2,000 element sets, not the ~46,000-
     object catalog and not a spatial-density (objects/km³) model.
   ============================================================ */

/* ------------------------------------------------------------
   Constants
   ------------------------------------------------------------ */

/**
 * Re-read the shared sample a little AFTER lib/debrisClient's 10-min
 * TTL. If this equalled the TTL, each tick would land fractionally
 * before the cache expired (fetchedAt is stamped when the request
 * RESOLVES, not when it starts), be served the same array, and the
 * real refetch would slip to the following tick (~20 min). The 30 s
 * grace comfortably covers a slow cold /api/debris round trip.
 */
const REFRESH_MS = 10 * 60 * 1000 + 30 * 1000;

/* Palette — tokens from tailwind.config.js / globals.css.
   SVG text uses the secondary token only; HTML text uses the
   Tailwind text-text-* classes. */
const TEXT_SECONDARY = "#888888";
const SAFE = "#00FF41";
const CAUTION = "#FFB800";
const DANGER = "#FF3131";

/* Chart — single sequential hue for magnitude */
const BAR_COLOR = "#5FB3FF";
const BAR_OPACITY = 0.85;
const GRID_COLOR = "rgba(255,255,255,0.06)";
const AXIS_COLOR = "rgba(255,255,255,0.14)";

/* SVG geometry (viewBox units) */
const VB_W = 400;
const VB_H = 180;
const MARGIN = { left: 34, right: 8, top: 14, bottom: 26 } as const;
const PLOT_W = VB_W - MARGIN.left - MARGIN.right; // 358
const PLOT_H = VB_H - MARGIN.top - MARGIN.bottom; // 140
const PLOT_RIGHT = MARGIN.left + PLOT_W; // 392
const BASELINE_Y = MARGIN.top + PLOT_H; // 154
const BAR_GAP = 2;
const BAR_RADIUS = 2;
const Y_GRIDLINES = 4;
const FONT_AXIS = 8;
const FONT_ANNOTATION = 7;
/** Approximate glyph advance at font-size 7 — only used to keep labels inside the plot. */
const ANNOTATION_CHAR_W = 4.4;

/* Annotations */
interface BandAnnotation {
  kind: "band";
  from: number;
  to: number;
  label: string;
  fill: string;
  edge: string;
  labelColor: string;
}
interface MarkerAnnotation {
  kind: "marker";
  at: number;
  label: string;
  color: string;
}
type Annotation = BandAnnotation | MarkerAnnotation;

const ALT_ANNOTATIONS: readonly Annotation[] = [
  {
    kind: "band",
    from: KESSLER_BAND_KM.from,
    to: KESSLER_BAND_KM.to,
    label: "KESSLER-CRITICAL SHELL",
    fill: "rgba(255,49,49,0.08)",
    edge: DANGER,
    labelColor: DANGER,
  },
  { kind: "marker", at: 420, label: "ISS", color: SAFE },
  { kind: "marker", at: 550, label: "STARLINK", color: TEXT_SECONDARY },
];

const INC_ANNOTATIONS: readonly Annotation[] = [
  {
    kind: "band",
    from: 96,
    to: 100,
    label: "SUN-SYNC",
    fill: "rgba(255,184,0,0.10)",
    edge: CAUTION,
    labelColor: CAUTION,
  },
  { kind: "marker", at: 51.6, label: "ISS", color: SAFE },
  { kind: "marker", at: 63.4, label: "MOLNIYA", color: TEXT_SECONDARY },
];

const ALT_X_TICKS: readonly number[] = [500, 1000, 1500, 2000];
const INC_X_TICKS: readonly number[] = [0, 45, 90, 135, 180];

const CAPTION = `Density of the ${DEBRIS_SAMPLE_LIMIT.toLocaleString(
  "en-US"
)} most-recently-updated element sets in Space-Track's gp class — a live sample, not the full ~46,000-object catalog. Bars count all object classes; hover for the debris / payload / rocket-body split.`;

const ASSUMPTIONS = `Altitude = (APOAPSIS + PERIAPSIS) / 2 from the gp fields (equatorial-radius convention). Object class is inferred from OBJECT_NAME (" DEB" → debris, "R/B" → rocket body) and is an estimate, not a catalog attribute. Counts are objects per bin in this sample — no spatial-density (objects / km³) model is applied.`;

/* ------------------------------------------------------------
   Formatting helpers — never render NaN / undefined
   ------------------------------------------------------------ */

function fmtInt(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—";
}

function fmtPct(share: number): string {
  return Number.isFinite(share) ? `${(share * 100).toFixed(1)}%` : "—";
}

/** Short bin-edge number: integers stay integers, 51.6-style floats keep 1 dp. */
function fmtEdge(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function fmtAltRange(bin: HistogramBin): string {
  return `${fmtEdge(bin.from)}–${fmtEdge(bin.to)} km`;
}

function fmtIncRange(bin: HistogramBin): string {
  return `${fmtEdge(bin.from)}–${fmtEdge(bin.to)}°`;
}

/** Round to 2 dp for SVG attributes (keeps the DOM readable). */
function px(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Smallest "nice" INTEGER gridline step so that `segments` steps
 * cover maxCount. Candidates are 1 / 1.2 / 1.5 / 2 / 2.5 / 3 / 4 /
 * 5 / 6 / 8 / 10 × a power of ten, which keeps the tallest bar at
 * ≥ ~80 % of the plot height while every tick label stays integer.
 */
function niceStep(maxCount: number, segments: number): number {
  const raw = Math.max(1, Math.ceil(maxCount / segments));
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const mults = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  for (const m of mults) {
    const step = Math.round(m * mag);
    if (step >= raw) return step;
  }
  return raw;
}

/* ------------------------------------------------------------
   <Histogram> — one SVG bar chart + HTML tooltip
   ------------------------------------------------------------ */

interface HistogramProps {
  title: string;
  bins: HistogramBin[];
  /** x-domain [min, max] in data units (km or degrees). */
  domain: readonly [number, number];
  xTicks: readonly number[];
  formatTick: (value: number) => string;
  formatRange: (bin: HistogramBin) => string;
  annotations: readonly Annotation[];
  testId: string;
}

function Histogram({
  title,
  bins,
  domain,
  xTicks,
  formatTick,
  formatRange,
  annotations,
  testId,
}: HistogramProps) {
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // useId() yields ":r1:" — strip the colons so url(#…) is a clean fragment.
  const rawId = useId();
  const clipId = `density-clip-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  // Touch pointers ignore pointerleave (see wrapper), so a pinned tooltip
  // needs an "outside tap" to clear it. Listener only lives while pinned.
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

  const [d0, d1] = domain;
  const span = d1 - d0;
  const xOf = (v: number): number => {
    if (!(span > 0) || !Number.isFinite(v)) return MARGIN.left;
    const x = MARGIN.left + ((v - d0) / span) * PLOT_W;
    return Math.max(MARGIN.left, Math.min(PLOT_RIGHT, x));
  };

  let maxCount = 0;
  for (const b of bins) if (b.count > maxCount) maxCount = b.count;
  const step = niceStep(maxCount, Y_GRIDLINES);
  const yMax = step * Y_GRIDLINES;
  const yOf = (count: number): number =>
    BASELINE_Y - (Math.max(0, count) / yMax) * PLOT_H;

  const hovered =
    hover !== null && hover >= 0 && hover < bins.length ? bins[hover] : null;

  // Tooltip anchor (percent of the SVG box so it tracks responsive scaling).
  let tooltipStyle: React.CSSProperties | null = null;
  if (hovered) {
    const x0 = xOf(hovered.from);
    const x1 = xOf(hovered.to);
    const cx = (x0 + x1) / 2;
    const top = yOf(hovered.count);
    const nearLeft = cx < MARGIN.left + 60;
    const nearRight = cx > PLOT_RIGHT - 60;
    const anchorX = nearLeft ? x0 : nearRight ? x1 : cx;
    const tx = nearLeft ? "0%" : nearRight ? "-100%" : "-50%";
    // Bar top in the lower ~55 % of the plot → tooltip above it; otherwise below the bar top.
    const above = top >= MARGIN.top + PLOT_H * 0.45;
    const ty = above ? "calc(-100% - 8px)" : "8px";
    tooltipStyle = {
      left: `${(anchorX / VB_W) * 100}%`,
      top: `${(top / VB_H) * 100}%`,
      transform: `translate(${tx}, ${ty})`,
    };
  }

  const yTicks: number[] = [];
  for (let k = 0; k <= Y_GRIDLINES; k++) yTicks.push(k * step);

  return (
    <div
      ref={wrapRef}
      className="relative"
      // Touch fires pointerout/pointerleave the instant the finger lifts;
      // ignoring it here is what lets a tap pin the tooltip.
      onPointerLeave={(e) => {
        if (e.pointerType !== "touch") setHover(null);
      }}
      // A touch that turns into a page scroll is cancelled — never leave
      // a tooltip stranded on the bar the finger happened to land on.
      onPointerCancel={() => setHover(null)}
    >
      <svg
        className="block w-full font-mono"
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        role="img"
        aria-label={title}
        data-chart="histogram"
      >
        <title>{title}</title>
        <defs>
          {/* Bars extend BAR_RADIUS below the baseline and are clipped here,
              giving a rounded data-end with a square foot at the baseline. */}
          <clipPath id={clipId}>
            <rect
              x={MARGIN.left}
              y={MARGIN.top}
              width={PLOT_W}
              height={PLOT_H}
            />
          </clipPath>
        </defs>

        {/* Band shading sits BEHIND the data */}
        {annotations.map((a, i) =>
          a.kind === "band" ? (
            <rect
              key={`band-fill-${i}`}
              x={px(xOf(a.from))}
              y={MARGIN.top}
              width={px(Math.max(0, xOf(a.to) - xOf(a.from)))}
              height={PLOT_H}
              fill={a.fill}
            />
          ) : null
        )}

        {/* Gridlines + y tick labels (integers) */}
        {yTicks.map((t, k) => {
          const y = px(yOf(t));
          const isBaseline = k === 0;
          return (
            <g key={`y-${k}`}>
              <line
                x1={MARGIN.left}
                x2={PLOT_RIGHT}
                y1={y}
                y2={y}
                stroke={isBaseline ? AXIS_COLOR : GRID_COLOR}
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
                {fmtInt(t)}
              </text>
            </g>
          );
        })}

        {/* x ticks */}
        {xTicks.map((v) => {
          if (!Number.isFinite(v) || v < d0 || v > d1) return null;
          const x = px(xOf(v));
          const atEnd = v >= d1;
          return (
            <g key={`x-${v}`}>
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
                x={atEnd ? x + 2 : x}
                y={BASELINE_Y + 13}
                fontSize={FONT_AXIS}
                fill={TEXT_SECONDARY}
                textAnchor={atEnd ? "end" : "middle"}
              >
                {formatTick(v)}
              </text>
            </g>
          );
        })}

        {/* Bars — one per bin, anchored to the baseline, 2 px surface gap */}
        {bins.map((bin, i) => {
          const x0 = xOf(bin.from);
          const x1 = xOf(bin.to);
          const slot = x1 - x0;
          const w = Math.max(1, slot - BAR_GAP);
          const x = x0 + (slot - w) / 2;
          const top = yOf(bin.count);
          const h = BASELINE_Y - top;
          const r = Math.min(BAR_RADIUS, w / 2);
          return (
            <rect
              key={`bar-${i}`}
              data-bar="1"
              x={px(x)}
              y={px(top)}
              width={px(w)}
              height={px(h + r)}
              rx={r}
              ry={r}
              fill={BAR_COLOR}
              opacity={hover === i ? 1 : BAR_OPACITY}
              clipPath={`url(#${clipId})`}
            />
          );
        })}

        {/* Annotation layer ON TOP of the data: band edges + labels, markers */}
        {annotations.map((a, i) => {
          if (a.kind === "band") {
            const x0 = px(xOf(a.from));
            const x1 = px(xOf(a.to));
            const halfW = (a.label.length * ANNOTATION_CHAR_W) / 2;
            const cx = Math.max(
              MARGIN.left + halfW,
              Math.min(PLOT_RIGHT - halfW, (x0 + x1) / 2)
            );
            return (
              <g key={`band-${i}`}>
                <line
                  x1={x0}
                  x2={x0}
                  y1={MARGIN.top}
                  y2={BASELINE_Y}
                  stroke={a.edge}
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  opacity={0.6}
                />
                <line
                  x1={x1}
                  x2={x1}
                  y1={MARGIN.top}
                  y2={BASELINE_Y}
                  stroke={a.edge}
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  opacity={0.6}
                />
                <text
                  x={px(cx)}
                  y={MARGIN.top + 8}
                  fontSize={FONT_ANNOTATION}
                  fill={a.labelColor}
                  textAnchor="middle"
                  letterSpacing="0.6"
                >
                  {a.label}
                </text>
              </g>
            );
          }
          const x = px(xOf(a.at));
          const flip = x > PLOT_RIGHT - a.label.length * ANNOTATION_CHAR_W - 4;
          return (
            <g key={`marker-${i}`}>
              <line
                x1={x}
                x2={x}
                y1={MARGIN.top}
                y2={BASELINE_Y}
                stroke={a.color}
                strokeWidth={1}
                strokeDasharray="3 3"
                opacity={0.9}
              />
              <text
                x={flip ? x - 3 : x + 3}
                y={MARGIN.top + 18}
                fontSize={FONT_ANNOTATION}
                fill={a.color}
                textAnchor={flip ? "end" : "start"}
                letterSpacing="0.6"
              >
                {a.label}
              </text>
            </g>
          );
        })}

        {/* Invisible full-height hit targets — the hover area is the whole bin slot */}
        {bins.map((bin, i) => {
          const x0 = xOf(bin.from);
          const x1 = xOf(bin.to);
          return (
            <rect
              key={`hit-${i}`}
              data-hit="1"
              x={px(x0)}
              y={MARGIN.top}
              width={px(Math.max(1, x1 - x0))}
              height={PLOT_H}
              fill="transparent"
              // Mouse / pen hover. Touch skips this: pointerenter fires
              // BEFORE pointerdown on a tap, and would otherwise pre-set
              // the bar so the toggle below cleared it again immediately.
              onPointerEnter={(e) => {
                if (e.pointerType !== "touch") setHover(i);
              }}
              // Mouse / pen: select. Touch: tap pins, same bar toggles off.
              onPointerDown={(e) => {
                const touch = e.pointerType === "touch";
                setHover((h) => (touch && h === i ? null : i));
              }}
            />
          );
        })}
      </svg>

      {/* Tooltip — HTML, outside the SVG, values lead and labels follow */}
      {hovered && tooltipStyle && (
        <div
          data-testid={`${testId}-tooltip`}
          className="pointer-events-none absolute z-10 whitespace-nowrap rounded border border-glass bg-space/95 px-2 py-1.5 font-mono text-[0.6rem] leading-snug shadow-lg"
          style={tooltipStyle}
        >
          <div className="text-text-secondary">{formatRange(hovered)}</div>
          <div className="text-xs font-bold text-text-primary">
            {fmtInt(hovered.count)}{" "}
            <span className="font-normal text-text-secondary">obj</span>
          </div>
          <div className="mt-0.5 text-text-secondary">
            debris <span className="text-text-primary">{fmtInt(hovered.debris)}</span>
            {" · "}payload <span className="text-text-primary">{fmtInt(hovered.payload)}</span>
            {" · "}R/B <span className="text-text-primary">{fmtInt(hovered.rocketBody)}</span>
            {" · "}unknown <span className="text-text-primary">{fmtInt(hovered.unknown)}</span>
          </div>
        </div>
      )}

      {/* Screen-reader table: every tooltip value is reachable without hovering */}
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th>Range</th>
            <th>Total</th>
            <th>Debris</th>
            <th>Payload</th>
            <th>Rocket body</th>
            <th>Unknown</th>
          </tr>
        </thead>
        <tbody>
          {bins.map((bin, i) => (
            <tr key={`row-${i}`}>
              <td>{formatRange(bin)}</td>
              <td>{fmtInt(bin.count)}</td>
              <td>{fmtInt(bin.debris)}</td>
              <td>{fmtInt(bin.payload)}</td>
              <td>{fmtInt(bin.rocketBody)}</td>
              <td>{fmtInt(bin.unknown)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------
   Small presentational pieces
   ------------------------------------------------------------ */

function StatCell({
  label,
  value,
  sub,
  testId,
}: {
  label: string;
  value: string;
  sub: string;
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      className="rounded-md border border-glass bg-white/5 p-3"
    >
      {/* Casing lives in the literal (spec: "700–1000 km SHARE" keeps a
          lowercase unit), so no CSS `uppercase` here. */}
      <div className="font-mono text-[0.6rem] tracking-widest text-text-muted">
        {label}
      </div>
      <div className="mt-1 font-display text-xl font-bold leading-tight text-text-primary">
        {value}
      </div>
      <div className="mt-0.5 font-mono text-[0.65rem] text-text-secondary">
        {sub}
      </div>
    </div>
  );
}

function ChartCard({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className="rounded-md border border-glass bg-white/5 p-3"
    >
      {/* Titles are literal uppercase with lowercase units ("50 km bins"),
          so no CSS `uppercase` — it would render "KM BINS". */}
      <div className="mb-2 font-mono text-[0.6rem] tracking-widest text-text-muted">
        {title}
      </div>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------
   Panel
   ------------------------------------------------------------ */

export default function DensityProfile() {
  const [objects, setObjects] = useState<SpaceTrackTLE[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadSample = useCallback(async (isCancelled: () => boolean) => {
    try {
      const sample = await getDebrisSample();
      if (isCancelled()) return;
      setObjects(Array.isArray(sample.objects) ? sample.objects : []);
      setError(null);
    } catch (err) {
      if (isCancelled()) return;
      setError(
        err instanceof Error
          ? err.message
          : "Failed to load the Space-Track debris sample."
      );
    } finally {
      if (!isCancelled()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const isCancelled = (): boolean => cancelled;

    void loadSample(isCancelled);
    const timer = setInterval(() => {
      void loadSample(isCancelled);
    }, REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [loadSample]);

  const alt = useMemo(
    () => (objects ? buildAltitudeHistogram(objects) : null),
    [objects]
  );
  const inc = useMemo(
    () => (objects ? buildInclinationHistogram(objects) : null),
    [objects]
  );

  const sampleSize = objects ? objects.length : 0;
  const leoCount = alt ? alt.total : 0;

  const altTitle = `OBJECTS BY ALTITUDE · ${DENSITY_ALT_MIN_KM}–${DENSITY_ALT_MAX_KM} km (${DENSITY_ALT_BIN_KM} km bins)`;
  const incTitle = `OBJECTS BY INCLINATION · ${DENSITY_INC_MIN_DEG}–${DENSITY_INC_MAX_DEG}° (${DENSITY_INC_BIN_DEG}° bins)`;

  return (
    <section
      data-testid="density-profile"
      className="glass-card overflow-hidden"
    >
      {/* Header */}
      <div className="flex h-9 items-center justify-between border-b border-glass px-3">
        <h2 className="font-mono text-[0.7rem] font-semibold uppercase tracking-widest text-text-secondary">
          ORBITAL DENSITY PROFILE
        </h2>
        {objects && alt && (
          <span
            data-testid="density-sample-meta"
            className="font-mono text-[0.65rem] text-text-muted"
          >
            sample{" "}
            <span className="text-text-secondary">{fmtInt(sampleSize)}</span>{" "}
            obj · LEO{" "}
            <span className="text-text-secondary">{fmtInt(leoCount)}</span>
          </span>
        )}
      </div>

      <div className="p-4">
        {/* ---- States ---- */}
        {loading && !objects && (
          <div className="font-mono text-xs text-text-secondary blink-cursor">
            Binning the Space-Track sample
          </div>
        )}

        {error && (
          <div className="mb-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
            {error}
          </div>
        )}

        {objects && alt && inc && sampleSize === 0 && !error && (
          <div className="font-mono text-xs text-text-muted">
            The debris sample is empty — nothing to bin yet.
          </div>
        )}

        {/* ---- Profile ---- */}
        {objects && alt && inc && sampleSize > 0 && (
          <div className="flex flex-col gap-4">
            {/* Stat cells */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <StatCell
                testId="density-stat-total"
                label="LEO SAMPLE"
                value={fmtInt(alt.total)}
                sub={`objects ${DENSITY_ALT_MIN_KM}–${DENSITY_ALT_MAX_KM} km · ${fmtInt(
                  alt.above
                )} above${alt.below > 0 ? ` · ${fmtInt(alt.below)} below` : ""}`}
              />
              <StatCell
                testId="density-stat-peak"
                label="PEAK SHELL"
                value={
                  alt.peak
                    ? `${fmtAltRange(alt.peak)} · ${fmtInt(alt.peak.count)} obj`
                    : "—"
                }
                sub={
                  alt.peak
                    ? `densest ${DENSITY_ALT_BIN_KM} km bin`
                    : "no objects in range"
                }
              />
              <StatCell
                testId="density-stat-share"
                label={`${KESSLER_BAND_KM.from}–${KESSLER_BAND_KM.to} km SHARE`}
                value={fmtPct(alt.bandShare)}
                sub={`of LEO sample · ${fmtInt(alt.bandCount)} obj in the Kessler-critical shell`}
              />
            </div>

            {/* Charts */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <ChartCard title={altTitle} testId="density-alt-chart">
                <Histogram
                  title={altTitle}
                  bins={alt.bins}
                  domain={[DENSITY_ALT_MIN_KM, DENSITY_ALT_MAX_KM]}
                  xTicks={ALT_X_TICKS}
                  formatTick={(v) => fmtEdge(v)}
                  formatRange={fmtAltRange}
                  annotations={ALT_ANNOTATIONS}
                  testId="density-alt-chart"
                />
              </ChartCard>

              <ChartCard title={incTitle} testId="density-inc-chart">
                <Histogram
                  title={incTitle}
                  bins={inc.bins}
                  domain={[DENSITY_INC_MIN_DEG, DENSITY_INC_MAX_DEG]}
                  xTicks={INC_X_TICKS}
                  formatTick={(v) => `${fmtEdge(v)}°`}
                  formatRange={fmtIncRange}
                  annotations={INC_ANNOTATIONS}
                  testId="density-inc-chart"
                />
              </ChartCard>
            </div>

            {/* Caption + assumptions */}
            <div className="flex flex-col gap-1">
              <p className="font-mono text-[0.65rem] leading-relaxed text-text-muted">
                {CAPTION}
              </p>
              <p className="font-mono text-[0.6rem] leading-relaxed text-text-muted">
                <span className="uppercase tracking-widest">Assumptions</span>{" "}
                — {ASSUMPTIONS}
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
