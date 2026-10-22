"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SpaceTrackTLE } from "@/lib/spacetrack";
import { DEBRIS_SAMPLE_LIMIT, getDebrisSample } from "@/lib/debrisClient";
import { STARLINK_PC_MANEUVER_THRESHOLD, formatUtcTime } from "@/lib/orbital";
import {
  DEORBIT_ALTITUDE_KM,
  GEN2_AUTHORIZED_TOTAL,
  SHELL_MATCH_ALT_KM,
  SHELL_MATCH_INC_DEG,
  STARLINK_PHASES,
  STARLINK_SHELLS,
  buildStarlinkReport,
  shellById,
  shellShortLabel,
  type CrossingCounts,
  type ShellReport,
  type StarlinkObject,
  type StarlinkPhase,
  type StarlinkReport,
  type StarlinkShell,
} from "@/lib/starlink";

/* ============================================================
   Session 6 — Feature 1: Starlink Constellation Monitor

   Shell architecture, lifecycle phase and crossing-debris exposure
   of the Starlink objects in the live Space-Track sample.

   Data flow
   - getDebrisSample() (lib/debrisClient) → the SAME shared
     /api/debris?limit=2000 sample the 3D map and the Session-5
     panels use: one round trip per page load, cached client-side
     for 10 min (the route keeps its own 10-min server cache).
     This panel makes no /api call of its own.
   - buildStarlinkReport() (lib/starlink, pure) runs in useMemo:
     shell + phase per STARLINK-* object, per-shell occupancy and
     altitude statistics, and the NON-Starlink objects whose
     perigee–apogee range crosses each shell (± 15 km).
   - Zero Claude cost. Deterministic.

   Cadence
   - Re-reads the shared sample every 10.5 min (client-cache TTL +
     30 s grace, same reasoning as DensityProfile) and on the ↻
     button (getDebrisSample(true)). Every fetch runs in a useEffect
     keyed on a request nonce with a cancelled flag; the interval is
     cleared on unmount.

   ASSUMPTIONS (printed on screen in the footnote)
   - Shell altitudes / inclinations / counts: public FCC
     authorizations (Gen1 2021 modification, Gen2 Dec-2022 partial
     grant — 7,500 combined, no per-shell split).
   - Phase is inferred from ONE element set: raising vs lowering is
     not distinguishable; a fresh batch below 300 km before orbit
     raising reads DEORBITING; satellites flown under later FCC
     modifications at other altitudes read RAISING / LOWERING.
   - RAISING / LOWERING objects are credited to the inclination-
     matched shell NEAREST in altitude (one element set cannot show
     the target shell): at 53° everything 300-455 km lands in the
     480 km row (the 2026 operating altitude), and the four 53° rows'
     ±25 km windows overlap (455-575 km). ATTRIBUTION_NOTE says so on
     screen.
   - Altitude = (APOAPSIS + PERIAPSIS) / 2 from the gp strings.
   - Crossing = altitude overlap only (no inclination / phasing
     filter) — potential conjunction partners, not predictions.
     Object class from the OBJECT_NAME heuristic.
   - The Pc 3e-7 autonomous-avoidance trigger and ~36 maneuvers /
     satellite / year are SpaceX's PUBLISHED figures (semiannual FCC
     report, July 2026), not internal data.
   - Sample = 2,000 most-recently-updated element sets, not the
     whole constellation.
   ============================================================ */

/* ------------------------------------------------------------
   Constants
   ------------------------------------------------------------ */

/** Client-cache TTL (10 min) + 30 s grace — see DensityProfile.tsx. */
const REFRESH_MS = 10 * 60 * 1000 + 30 * 1000;

/** "3e-7" — toExponential(0) gives exactly the house notation. */
const THRESHOLD_STR = STARLINK_PC_MANEUVER_THRESHOLD.toExponential(0);

const TEXT_PRIMARY = "#E0E0E0";
const TEXT_SECONDARY = "#888888";
const SPACE_BG = "#000008";
const DATA_HUE = "#5FB3FF";

const PHASE_COLORS: Record<StarlinkPhase, string> = {
  OPERATIONAL: "#00FF41",
  "ORBIT RAISING / LOWERING": "#FFB800",
  DEORBITING: "#FF3131",
  UNASSIGNED: "#888888",
};

const PHASE_LEGEND: Record<StarlinkPhase, string> = {
  OPERATIONAL: "operational",
  "ORBIT RAISING / LOWERING": "raising / lowering",
  DEORBITING: "deorbiting",
  UNASSIGNED: "unassigned",
};

/** Draw order: the common phase first so rarer phases sit on top. */
const PHASE_RANK: Record<StarlinkPhase, number> = {
  OPERATIONAL: 0,
  "ORBIT RAISING / LOWERING": 1,
  DEORBITING: 2,
  UNASSIGNED: 3,
};

interface CrossingSegmentSpec {
  key: keyof Omit<CrossingCounts, "total">;
  label: string;
  color: string;
}

const CROSSING_SEGMENTS: readonly CrossingSegmentSpec[] = [
  { key: "debris", label: "debris", color: "#FF8A2B" },
  { key: "rocketBody", label: "rocket body", color: "#FFB800" },
  { key: "payload", label: "payload", color: "#5FB3FF" },
  { key: "unknown", label: "unknown", color: "#888888" },
];

const GEN_BADGE_COLORS: Record<StarlinkShell["generation"], string> = {
  Gen1: TEXT_SECONDARY,
  Gen2: DATA_HUE,
};

/* ---- Shell ladder geometry (viewBox units) ---- */
const VB_W = 400;
const VB_H = 160;
const MARGIN = { left: 30, right: 6, top: 6, bottom: 16 } as const;
const PLOT_W = VB_W - MARGIN.left - MARGIN.right; // 364
const PLOT_H = VB_H - MARGIN.top - MARGIN.bottom; // 138
const PLOT_RIGHT = MARGIN.left + PLOT_W; // 394
const PLOT_BOTTOM = MARGIN.top + PLOT_H; // 144
const ALT_MIN_KM = 250;
const ALT_MAX_KM = 650;
const ALT_TICKS: readonly number[] = [300, 400, 500, 600];
const DOT_R = 1;
const COL_GAP = 1; // half of the 2-unit gap between neighbouring column bands
const COL_PAD = 3; // keep jittered dots off the column edges
const FONT_AXIS = 8;
const FONT_LABEL = 6.5;
const GRID_COLOR = "rgba(255,255,255,0.06)";
const AXIS_COLOR = "rgba(255,255,255,0.14)";
const BAND_FILL = "rgba(95,179,255,0.12)";
const BAND_LINE = "rgba(95,179,255,0.6)";

/* ------------------------------------------------------------
   Formatting guards — never render NaN / undefined / "null"
   ------------------------------------------------------------ */

function fmtInt(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n)
    ? Math.round(n).toLocaleString("en-US")
    : "—";
}

function fmtPct(num: number, den: number, digits = 1): string {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return "—";
  return `${((num / den) * 100).toFixed(digits)}%`;
}

function fmtKm0(n: number | null): string {
  return typeof n === "number" && Number.isFinite(n) ? `${Math.round(n)} km` : "—";
}

function fmtSpread(n: number | null): string {
  return typeof n === "number" && Number.isFinite(n) ? `±${n.toFixed(1)} km` : "—";
}

function fmtIncShort(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function px(n: number): number {
  return Math.round(n * 100) / 100;
}

function clampAlt(alt: number): number {
  return Math.max(ALT_MIN_KM, Math.min(ALT_MAX_KM, alt));
}

function yOf(alt: number): number {
  return MARGIN.top + ((ALT_MAX_KM - clampAlt(alt)) / (ALT_MAX_KM - ALT_MIN_KM)) * PLOT_H;
}

/**
 * FNV-1a 32-bit + murmur3 fmix32 finaliser → [0, 1). Deterministic per
 * NORAD id so dots never jump on refresh. The finaliser matters: plain
 * FNV-1a maps consecutive NORAD ids (one launch batch) to 2-3 tight
 * x-clumps; with fmix32 they spread uniformly across the column.
 */
function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/* ------------------------------------------------------------
   Ladder columns — one per shell inclination group + OTHER
   ------------------------------------------------------------ */

interface LadderColumn {
  key: string;
  label: string;
  /** Sorted by altitude ascending. */
  shells: StarlinkShell[];
  x0: number;
  x1: number;
}

function buildColumns(): LadderColumn[] {
  const groups: { inc: number; shells: StarlinkShell[] }[] = [];
  const sorted = [...STARLINK_SHELLS].sort((a, b) => a.inclinationDeg - b.inclinationDeg);
  for (const s of sorted) {
    const g = groups.find((x) => Math.abs(x.inc - s.inclinationDeg) <= SHELL_MATCH_INC_DEG);
    if (g) g.shells.push(s);
    else groups.push({ inc: s.inclinationDeg, shells: [s] });
  }
  const specs = groups.map((g) => ({
    key: `inc-${g.inc}`,
    label: `${fmtIncShort(g.inc)}°`,
    shells: [...g.shells].sort((a, b) => a.altitudeKm - b.altitudeKm),
    // Shared-inclination groups (53° carries three shells) get double width.
    weight: g.shells.length > 1 ? 2 : 1,
  }));
  specs.push({ key: "other", label: "OTHER", shells: [], weight: 1 });

  const totalWeight = specs.reduce((sum, s) => sum + s.weight, 0);
  let x = MARGIN.left;
  return specs.map((s) => {
    const w = (PLOT_W * s.weight) / totalWeight;
    const col: LadderColumn = { key: s.key, label: s.label, shells: s.shells, x0: x, x1: x + w };
    x += w;
    return col;
  });
}

const LADDER_COLUMNS: LadderColumn[] = buildColumns();
const OTHER_COLUMN: LadderColumn = LADDER_COLUMNS[LADDER_COLUMNS.length - 1];
const COLUMN_BY_SHELL = new Map<string, LadderColumn>();
for (const col of LADDER_COLUMNS) {
  for (const s of col.shells) COLUMN_BY_SHELL.set(s.id, col);
}

/**
 * On-screen disclosure of how off-station objects are credited to a shell
 * row. lib/starlink gives a RAISING / LOWERING object the inclination-
 * matched shell NEAREST in altitude (the spec rule); one element set cannot
 * show the shell it is bound for. Derived from the shell table so the
 * numbers cannot drift: for the shared 53° group everything between
 * DEORBIT_ALTITUDE_KM and the lowest window edge lands in the lowest
 * shell's row, and the overlapping ±25 km windows make the split between
 * those rows approximate.
 */
function buildAttributionNote(): string {
  const base =
    "RAISING / LOWERING objects are counted in the IN SAMPLE column of the shell " +
    "nearest in altitude at their inclination; one element set cannot show the " +
    "shell a satellite is bound for.";
  const shared = LADDER_COLUMNS.find((c) => c.shells.length > 1);
  if (!shared) return base;
  const lowest = shared.shells[0];
  const highest = shared.shells[shared.shells.length - 1];
  const winLo = lowest.altitudeKm - SHELL_MATCH_ALT_KM;
  const winHi = highest.altitudeKm + SHELL_MATCH_ALT_KM;
  return (
    `${base} In the ${shared.label} group every RAISING / LOWERING object between ` +
    `${DEORBIT_ALTITUDE_KM} and ${winLo} km is credited to the ${lowest.label} ` +
    `${lowest.generation} row (above ${winHi} km: the ${highest.label} ` +
    `${highest.generation} row), whichever shell it is heading for. The ` +
    `±${SHELL_MATCH_ALT_KM} km windows of the ${shared.label} shells overlap ` +
    `(together ${winLo}–${winHi} km), so the split between those rows is approximate.`
  );
}

const ATTRIBUTION_NOTE = buildAttributionNote();

interface LadderDot {
  key: string;
  cx: number;
  cy: number;
  color: string;
  rank: number;
  title: string;
}

function dotTitle(o: StarlinkObject): string {
  const shell = shellById(o.shellId);
  const parts = [
    o.name,
    o.noradId ? `NORAD ${o.noradId}` : null,
    `${Math.round(o.altitudeKm)} km`,
    `${o.inclinationDeg.toFixed(1)}°`,
    `${PHASE_LEGEND[o.phase]}${
      shell
        ? o.phase === "OPERATIONAL"
          ? ` (${shell.label})`
          : ` (nearest shell ${shell.label})`
        : ""
    }`,
    o.ndotHalfRevPerDay2 !== null && Number.isFinite(o.ndotHalfRevPerDay2)
      ? `ṅ/2 ${o.ndotHalfRevPerDay2.toExponential(2)} rev/day²`
      : null,
  ];
  return parts.filter((p): p is string => p !== null).join(" · ");
}

function buildDots(objects: StarlinkObject[]): { dots: LadderDot[]; below: number; above: number } {
  let below = 0;
  let above = 0;
  const dots: LadderDot[] = objects.map((o, i) => {
    if (o.altitudeKm < ALT_MIN_KM) below++;
    else if (o.altitudeKm > ALT_MAX_KM) above++;
    const col = (o.shellId ? COLUMN_BY_SHELL.get(o.shellId) : undefined) ?? OTHER_COLUMN;
    const f = hash01(o.noradId || o.name || String(i));
    const span = Math.max(0, col.x1 - col.x0 - 2 * COL_PAD);
    return {
      // Stable identity: NORAD IDs are unique in a gp sample, so a refresh
      // (EPOCH-desc order shifts every index) patches dots instead of remounting.
      key: o.noradId ? `n${o.noradId}` : `x${o.name}-${i}`,
      cx: px(col.x0 + COL_PAD + f * span),
      cy: px(yOf(o.altitudeKm)),
      color: PHASE_COLORS[o.phase],
      rank: PHASE_RANK[o.phase],
      title: dotTitle(o),
    };
  });
  dots.sort((a, b) => a.rank - b.rank);
  return { dots, below, above };
}

/* ------------------------------------------------------------
   Sub-components
   ------------------------------------------------------------ */

function StatCell({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub: string;
  accent: string;
}) {
  return (
    <div className="rounded-md border border-glass bg-white/5 p-3">
      <div className="font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
        {label}
      </div>
      <div
        className="mt-1 font-display text-2xl font-bold leading-tight"
        style={{ color: accent }}
      >
        {value}
      </div>
      <div className="mt-0.5 font-mono text-[0.65rem] text-text-secondary">{sub}</div>
    </div>
  );
}

function GenBadge({ generation }: { generation: StarlinkShell["generation"] }) {
  const color = GEN_BADGE_COLORS[generation];
  return (
    <span
      className="inline-block rounded px-1.5 py-0.5 font-display text-[0.6rem] font-bold leading-none"
      style={{ color, border: `1px solid ${color}` }}
    >
      {generation}
    </span>
  );
}

function crossingSplit(c: CrossingCounts): string {
  return CROSSING_SEGMENTS.map((s) => `${s.label} ${fmtInt(c[s.key])}`).join(" · ");
}

function CrossingCell({ crossing, maxTotal }: { crossing: CrossingCounts; maxTotal: number }) {
  const pct =
    maxTotal > 0 ? Math.max(0, Math.min(100, (crossing.total / maxTotal) * 100)) : 0;
  const split = crossingSplit(crossing);
  return (
    <td className="py-2 pr-3" title={split}>
      <div className="flex items-baseline gap-2 whitespace-nowrap">
        <span className="text-text-primary">{fmtInt(crossing.total)}</span>
        <span className="text-text-muted">{fmtInt(crossing.debris)} deb</span>
      </div>
      <div
        className="mt-1 h-[6px] w-full min-w-[80px] overflow-hidden rounded-sm bg-white/5"
        title={split}
        aria-label={`Crossing objects: ${split}`}
      >
        <div className="flex h-full gap-px" style={{ width: `${pct}%` }}>
          {CROSSING_SEGMENTS.map((s) =>
            crossing[s.key] > 0 ? (
              <div
                key={s.key}
                className="h-full first:rounded-l-sm last:rounded-r-sm"
                style={{ flexGrow: crossing[s.key], flexBasis: 0, backgroundColor: s.color }}
              />
            ) : null
          )}
        </div>
      </div>
    </td>
  );
}

function ShellRow({ row, maxCrossing }: { row: ShellReport; maxCrossing: number }) {
  const { shell } = row;
  const inSample = row.operational + row.transit;
  return (
    <tr
      data-testid="starlink-shell-row"
      className="border-b border-glass align-top last:border-b-0 hover:bg-white/5"
    >
      <td className="py-2 pr-3">
        <div className="flex items-center gap-2 whitespace-nowrap">
          <span className="text-text-primary">{shell.label}</span>
          <GenBadge generation={shell.generation} />
        </div>
        <div className="mt-0.5 text-text-muted">{shell.note}</div>
      </td>

      <td
        className="whitespace-nowrap py-2 pr-3 text-right text-text-secondary"
        title={
          shell.authorized === null
            ? `${GEN2_AUTHORIZED_TOTAL.toLocaleString("en-US")} authorized combined across the Gen2 shells`
            : "FCC-authorized (public filings)"
        }
      >
        {shell.authorized !== null ? (
          shell.authorized.toLocaleString("en-US")
        ) : (
          <span>
            —<span className="text-text-muted">†</span>
          </span>
        )}
      </td>

      <td className="whitespace-nowrap py-2 pr-3 text-right">
        <div className="text-text-primary">{fmtInt(inSample)}</div>
        <div className="text-text-muted">
          {fmtInt(row.operational)} op · {fmtInt(row.transit)} transit
        </div>
      </td>

      <td className="whitespace-nowrap py-2 pr-3 text-right text-text-secondary">
        {fmtKm0(row.meanAltitudeKm)}
      </td>

      <td className="whitespace-nowrap py-2 pr-3 text-right text-text-secondary">
        {fmtSpread(row.altitudeSpreadKm)}
      </td>

      <CrossingCell crossing={row.crossing} maxTotal={maxCrossing} />
    </tr>
  );
}

function ShellLadder({ report }: { report: StarlinkReport }) {
  const { dots, below, above } = useMemo(() => buildDots(report.objects), [report.objects]);

  const phaseCounts: Record<StarlinkPhase, number> = {
    OPERATIONAL: report.operational,
    "ORBIT RAISING / LOWERING": report.transit,
    DEORBITING: report.deorbiting,
    UNASSIGNED: report.unassigned,
  };

  return (
    <div className="mx-auto w-full max-w-3xl xl:max-w-none">
      <div className="mb-2 font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
        Shell ladder · altitude by inclination group
      </div>
      <svg
        className="block w-full font-mono"
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        role="img"
        aria-label={`Starlink shell ladder: ${report.starlinkTotal} sample objects plotted by altitude (${ALT_MIN_KM}–${ALT_MAX_KM} km) within their shell's inclination group`}
        data-testid="starlink-ladder"
      >
        <title>Starlink shell ladder</title>

        {/* Altitude gridlines + labels (one axis) */}
        {ALT_TICKS.map((alt) => {
          const y = px(yOf(alt));
          return (
            <g key={`grid-${alt}`}>
              <line
                x1={MARGIN.left}
                x2={PLOT_RIGHT}
                y1={y}
                y2={y}
                stroke={GRID_COLOR}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
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
                {alt}
              </text>
            </g>
          );
        })}
        <text
          x={MARGIN.left - 4}
          y={MARGIN.top + 3}
          fontSize={FONT_LABEL}
          fill={TEXT_SECONDARY}
          textAnchor="end"
        >
          km
        </text>
        <line
          x1={MARGIN.left}
          x2={PLOT_RIGHT}
          y1={PLOT_BOTTOM}
          y2={PLOT_BOTTOM}
          stroke={AXIS_COLOR}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          shapeRendering="crispEdges"
        />

        {/* Column separators */}
        {LADDER_COLUMNS.slice(1).map((col) => (
          <line
            key={`sep-${col.key}`}
            x1={px(col.x0)}
            x2={px(col.x0)}
            y1={MARGIN.top}
            y2={PLOT_BOTTOM}
            stroke={GRID_COLOR}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
            shapeRendering="crispEdges"
          />
        ))}

        {/* Shell bands (±25 km = OPERATIONAL window) + nominal lines */}
        {LADDER_COLUMNS.map((col) =>
          col.shells.map((s) => {
            const yTop = yOf(s.altitudeKm + SHELL_MATCH_ALT_KM);
            const yBot = yOf(s.altitudeKm - SHELL_MATCH_ALT_KM);
            const yNom = px(yOf(s.altitudeKm));
            return (
              <g key={`band-${s.id}`}>
                <rect
                  x={px(col.x0 + COL_GAP)}
                  y={px(yTop)}
                  width={px(Math.max(0, col.x1 - col.x0 - 2 * COL_GAP))}
                  height={px(Math.max(0, yBot - yTop))}
                  fill={BAND_FILL}
                />
                <line
                  x1={px(col.x0 + COL_GAP)}
                  x2={px(col.x1 - COL_GAP)}
                  y1={yNom}
                  y2={yNom}
                  stroke={BAND_LINE}
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })
        )}

        {/* Sample objects */}
        <g>
          {dots.map((d) => (
            <circle key={d.key} cx={d.cx} cy={d.cy} r={DOT_R} fill={d.color} fillOpacity={0.85}>
              <title>{d.title}</title>
            </circle>
          ))}
        </g>

        {/* Shell labels on top of the dots (dark halo keeps them legible).
            Labels alternate right / left inside a column so the three
            53° shells, 10-15 km apart, never collide. */}
        {LADDER_COLUMNS.map((col) =>
          col.shells.map((s, k) => {
            const right = k % 2 === 0;
            return (
              <text
                key={`label-${s.id}`}
                x={px(right ? col.x1 - COL_GAP - 1 : col.x0 + COL_GAP + 1)}
                y={px(yOf(s.altitudeKm) - 1.5)}
                fontSize={FONT_LABEL}
                fill={TEXT_PRIMARY}
                textAnchor={right ? "end" : "start"}
                stroke={SPACE_BG}
                strokeWidth={2}
                strokeLinejoin="round"
                paintOrder="stroke"
              >
                {shellShortLabel(s)}
              </text>
            );
          })
        )}

        {/* Inclination-group labels */}
        {LADDER_COLUMNS.map((col) => (
          <text
            key={`x-${col.key}`}
            x={px((col.x0 + col.x1) / 2)}
            y={PLOT_BOTTOM + 10}
            fontSize={FONT_AXIS}
            fill={TEXT_SECONDARY}
            textAnchor="middle"
          >
            {col.label}
          </text>
        ))}
      </svg>

      {/* Legend */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[0.6rem] text-text-secondary">
        {STARLINK_PHASES.map((p) => (
          <span key={p} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: PHASE_COLORS[p] }}
            />
            {PHASE_LEGEND[p]} {fmtInt(phaseCounts[p])}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-4 rounded-sm"
            style={{ backgroundColor: BAND_FILL, borderTop: `1px solid ${BAND_LINE}` }}
          />
          FCC shell altitude · ±{SHELL_MATCH_ALT_KM} km match window
        </span>
        {(below > 0 || above > 0) && (
          <span className="text-text-muted">
            {below > 0 ? `${fmtInt(below)} below ${ALT_MIN_KM} km` : ""}
            {below > 0 && above > 0 ? " · " : ""}
            {above > 0 ? `${fmtInt(above)} above ${ALT_MAX_KM} km` : ""} pinned to the axis
            edge
          </span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------
   Panel
   ------------------------------------------------------------ */

interface SampleRequest {
  nonce: number;
  force: boolean;
}

export default function StarlinkMonitor() {
  const [objects, setObjects] = useState<SpaceTrackTLE[] | null>(null);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<SampleRequest>({ nonce: 0, force: false });

  // All I/O happens here, keyed on the request record, with a cancelled flag.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    getDebrisSample(request.force)
      .then((sample) => {
        if (cancelled) return;
        setObjects(sample.objects);
        setFetchedAt(sample.fetchedAt);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "Failed to load the Space-Track sample."
        );
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [request]);

  // Stay aligned with the shared client cache (non-forced re-read).
  useEffect(() => {
    const id = setInterval(() => {
      setRequest((r) => ({ nonce: r.nonce + 1, force: false }));
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const handleRefresh = useCallback(() => {
    setRequest((r) => ({ nonce: r.nonce + 1, force: true }));
  }, []);

  const report: StarlinkReport | null = useMemo(
    () => (objects ? buildStarlinkReport(objects) : null),
    [objects]
  );

  const maxCrossing = useMemo(
    () => (report ? report.shells.reduce((m, s) => Math.max(m, s.crossing.total), 0) : 0),
    [report]
  );

  const sampleLimitStr = DEBRIS_SAMPLE_LIMIT.toLocaleString("en-US");

  return (
    <section className="glass-card overflow-hidden" data-testid="starlink-monitor">
      {/* Header */}
      <div className="flex h-9 items-center justify-between gap-2 border-b border-glass px-3">
        <h2 className="min-w-0 truncate font-mono text-[0.7rem] font-semibold uppercase tracking-widest text-text-secondary">
          STARLINK CONSTELLATION MONITOR
        </h2>
        <div className="flex shrink-0 items-center gap-3 font-mono text-[0.65rem] text-text-muted">
          <span>
            <span className="hidden sm:inline">
              sample{" "}
              <span className="text-text-secondary">
                {report ? fmtInt(report.sampleSize) : "—"}
              </span>{" "}
              obj ·{" "}
            </span>
            <span className="hidden md:inline">autonomous CA threshold </span>
            Pc ≥ <span className="text-text-secondary">{THRESHOLD_STR}</span>
          </span>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={loading}
            aria-label="Refresh sample"
            title="Re-request the sample (server refreshes from Space-Track every 10 min)"
            data-testid="starlink-refresh"
            className="rounded border border-glass bg-white/5 px-2 py-1 font-mono text-[0.65rem] tracking-wide text-text-secondary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            ↻
          </button>
        </div>
      </div>

      <div className="p-4">
        {loading && !report && (
          <div className="font-mono text-xs text-text-secondary blink-cursor">
            Loading Space-Track sample
          </div>
        )}

        {error && (
          <div className="mb-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
            {error}
          </div>
        )}

        {report && (
          <div className="flex flex-col gap-4">
            {/* ---- Stat cells ---- */}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="starlink-stats">
              <StatCell
                label="STARLINK IN SAMPLE"
                value={fmtInt(report.starlinkTotal)}
                sub={`${fmtPct(report.starlinkTotal, report.sampleSize)} of ${fmtInt(
                  report.sampleSize
                )} obj · ${fmtInt(report.unassigned)} unassigned`}
                accent={TEXT_PRIMARY}
              />
              <StatCell
                label="OPERATIONAL"
                value={fmtInt(report.operational)}
                sub={`${fmtPct(report.operational, report.starlinkTotal)} · on a shell ±${SHELL_MATCH_ALT_KM} km`}
                accent={PHASE_COLORS.OPERATIONAL}
              />
              <StatCell
                label="IN TRANSIT"
                value={fmtInt(report.transit)}
                sub={`${fmtPct(report.transit, report.starlinkTotal)} · raising / lowering`}
                accent={PHASE_COLORS["ORBIT RAISING / LOWERING"]}
              />
              <StatCell
                label="DEORBITING"
                value={fmtInt(report.deorbiting)}
                sub={`${fmtPct(report.deorbiting, report.starlinkTotal)} · below ${DEORBIT_ALTITUDE_KM} km`}
                accent={PHASE_COLORS.DEORBITING}
              />
            </div>

            {report.starlinkTotal === 0 && (
              <div className="font-mono text-xs text-text-muted">
                No STARLINK-* element sets in the current sample — shell table shows the
                crossing population only.
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
              {/* ---- Shell table ---- */}
              <div className="min-w-0 xl:col-span-3">
                <div className="mb-2 font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
                  FCC shells · sample occupancy · crossing population ±
                  {report.crossingBandKm} km
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[620px] border-collapse font-mono text-[0.65rem]">
                    <thead>
                      <tr className="border-b border-glass text-left font-mono text-[0.6rem] uppercase tracking-widest text-text-muted">
                        <th scope="col" className="py-1.5 pr-3 font-normal">
                          SHELL
                        </th>
                        <th scope="col" className="py-1.5 pr-3 text-right font-normal">
                          AUTHORIZED
                        </th>
                        <th
                          scope="col"
                          className="py-1.5 pr-3 text-right font-normal"
                          title={`Operational + raising / lowering objects credited to this shell. ${ATTRIBUTION_NOTE}`}
                        >
                          IN SAMPLE
                        </th>
                        <th scope="col" className="py-1.5 pr-3 text-right font-normal">
                          MEAN ALT
                        </th>
                        <th scope="col" className="py-1.5 pr-3 text-right font-normal">
                          SPREAD 1σ
                        </th>
                        <th scope="col" className="py-1.5 pr-3 font-normal">
                          CROSSING OBJECTS
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.shells.map((row) => (
                        <ShellRow key={row.shell.id} row={row} maxCrossing={maxCrossing} />
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Crossing legend */}
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[0.6rem] text-text-secondary">
                  {CROSSING_SEGMENTS.map((s) => (
                    <span key={s.key} className="inline-flex items-center gap-1.5">
                      <span
                        className="inline-block h-2 w-2 rounded-sm"
                        style={{ backgroundColor: s.color }}
                      />
                      {s.label}
                    </span>
                  ))}
                  <span className="text-text-muted">bar length relative to the busiest shell</span>
                </div>
              </div>

              {/* ---- Shell ladder ---- */}
              <div className="min-w-0 xl:col-span-2">
                <ShellLadder report={report} />
              </div>
            </div>

            {/* ---- Footnote / assumptions ---- */}
            <div className="flex flex-col gap-1.5 font-mono text-[0.6rem] leading-relaxed text-text-muted">
              <p>
                Shell table from public FCC authorizations; phase inferred from one element
                set (orbit raising vs lowering is not distinguishable from a single TLE).
                Starlink&apos;s published autonomous-avoidance trigger is Pc {THRESHOLD_STR}
                (SpaceX semiannual FCC report, July 2026; earlier filings said 1e-5), more than
                300× below the 1e-4 industry norm; ~36 avoidance maneuvers per Gen1 satellite per
                year. The 480 km row is the operating altitude SpaceX announced in Jan 2026 for
                the 550 km shell, not an FCC grant of its own. Sample ={" "}
                {sampleLimitStr} most-recently-updated element sets, not the whole
                constellation.
              </p>
              <p>
                Phase rule: OPERATIONAL = within ±{SHELL_MATCH_INC_DEG}° inclination and ±
                {SHELL_MATCH_ALT_KM} km of a shell&apos;s nominal altitude (nearest shell
                wins); more than {SHELL_MATCH_ALT_KM} km off an inclination-matched shell =
                RAISING / LOWERING, or DEORBITING when below {DEORBIT_ALTITUDE_KM} km — a
                freshly deployed batch below {DEORBIT_ALTITUDE_KM} km reads the same as a
                deorbiting satellite, and satellites flown at altitudes from later FCC
                modifications read RAISING / LOWERING. {ATTRIBUTION_NOTE} Altitude =
                (APOAPSIS + PERIAPSIS) / 2
                from the gp fields. Crossing objects = non-Starlink objects whose
                perigee–apogee range overlaps the shell ±
                {report.crossingBandKm} km — altitude only, no
                inclination or phasing filter, so they are potential conjunction partners,
                not predicted conjunctions; class from OBJECT_NAME. Spread = 1σ of
                operational altitudes. † Gen2: {GEN2_AUTHORIZED_TOTAL.toLocaleString("en-US")}{" "}
                authorized combined across the 525 / 530 / 535 km shells (FCC partial grant,
                Dec 2022), no per-shell split.
                {report.skippedInvalid > 0
                  ? ` ${fmtInt(report.skippedInvalid)} Starlink rows skipped (unparseable altitude / inclination).`
                  : ""}
                {fetchedAt ? ` Sample fetched ${formatUtcTime(fetchedAt)}Z.` : ""}
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
